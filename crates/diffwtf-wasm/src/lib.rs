//! Thin wasm-bindgen wrapper around `diffwtf-core`. Never published; all
//! JS-facing code lives here so the core crate stays pure.
//!
//! Since M9 the boundary is sparse (docs/scaffold-spec.md, "Wasm boundary
//! contract v2"): `compute` returns the flat struct-of-arrays encoding of the
//! core `SparseDiff` as a plain JS object of parallel typed arrays, so the
//! amount of data crossing the boundary scales with the number of edits, not
//! with document size. JS reassembles the Split and Unified views from these
//! ops plus the two original input strings (web/js/assemble.js).

use diffwtf_core::{diff_sparse, Granularity, SparseDiff};
use js_sys::{Object, Reflect, Uint32Array, Uint8Array};
use wasm_bindgen::prelude::*;

fn parse_granularity(granularity: &str) -> Granularity {
    match granularity {
        "char" => Granularity::Char,
        _ => Granularity::Word,
    }
}

fn set(target: &Object, key: &str, value: JsValue) {
    Reflect::set(target, &JsValue::from_str(key), &value)
        .expect("setting a data property on a plain object never fails");
}

/// Sparse diff across the boundary: a plain JS object of parallel typed
/// arrays (one entry per run-length op) plus a compact highlight side
/// channel for Modify rows only. Field names match the serde output of the
/// core types, so the ops fixtures in `fixtures/expected/*.ops.json`
/// describe this shape field for field, just array-of-structs there versus
/// struct-of-arrays here.
///
/// ```text
/// {
///   kind:       Uint8Array,   // per op: 0 equal, 1 delete, 2 insert
///   old_start:  Uint32Array,  // per op: 0-based line index into the left input
///   new_start:  Uint32Array,  // per op: 0-based line index into the right input
///   old_lines:  Uint32Array,  // per op: lines covered on the left (0 for insert)
///   new_lines:  Uint32Array,  // per op: lines covered on the right (0 for delete)
///   hl_counts:  Uint32Array,  // per Modify row: left span count, right span count
///   hl_ranges:  Uint32Array,  // flattened [start, end) pairs, UTF-16 code units,
///                             //   in hl_counts order (row 0 left, row 0 right, ...)
///   added: number, removed: number, line_count: number
/// }
/// ```
///
/// Returning a plain object (not a wasm-bindgen class) keeps the result an
/// ordinary garbage-collected value: no `.free()` obligation leaks into the
/// page code.
#[wasm_bindgen]
pub fn compute(left: &str, right: &str, granularity: &str) -> JsValue {
    let sparse = diff_sparse(left, right, parse_granularity(granularity));
    let SparseDiff {
        ops,
        highlights,
        added,
        removed,
        line_count,
    } = &sparse;

    let mut kind = Vec::with_capacity(ops.len());
    let mut old_start = Vec::with_capacity(ops.len());
    let mut new_start = Vec::with_capacity(ops.len());
    let mut old_lines = Vec::with_capacity(ops.len());
    let mut new_lines = Vec::with_capacity(ops.len());
    for op in ops {
        kind.push(match op.kind {
            diffwtf_core::LineOpKind::Equal => 0u8,
            diffwtf_core::LineOpKind::Delete => 1u8,
            diffwtf_core::LineOpKind::Insert => 2u8,
        });
        old_start.push(op.old_start);
        new_start.push(op.new_start);
        old_lines.push(op.old_lines);
        new_lines.push(op.new_lines);
    }

    let mut hl_counts = Vec::with_capacity(highlights.len() * 2);
    let mut hl_ranges = Vec::new();
    for row in highlights {
        hl_counts.push(row.left.len() as u32);
        hl_counts.push(row.right.len() as u32);
        for span in row.left.iter().chain(row.right.iter()) {
            hl_ranges.push(span.start);
            hl_ranges.push(span.end);
        }
    }

    let result = Object::new();
    set(&result, "kind", Uint8Array::from(kind.as_slice()).into());
    set(
        &result,
        "old_start",
        Uint32Array::from(old_start.as_slice()).into(),
    );
    set(
        &result,
        "new_start",
        Uint32Array::from(new_start.as_slice()).into(),
    );
    set(
        &result,
        "old_lines",
        Uint32Array::from(old_lines.as_slice()).into(),
    );
    set(
        &result,
        "new_lines",
        Uint32Array::from(new_lines.as_slice()).into(),
    );
    set(
        &result,
        "hl_counts",
        Uint32Array::from(hl_counts.as_slice()).into(),
    );
    set(
        &result,
        "hl_ranges",
        Uint32Array::from(hl_ranges.as_slice()).into(),
    );
    set(&result, "added", JsValue::from(*added));
    set(&result, "removed", JsValue::from(*removed));
    set(&result, "line_count", JsValue::from(*line_count));
    result.into()
}

/// Benchmark probe: runs exactly the computation behind [`compute`], input
/// string copy-in included, but returns only a u32 checksum instead of
/// marshalling the result, so the phased benchmark (scripts/bench-vs-js.mjs)
/// can separate engine time from result-transfer time by subtraction. The
/// checksum folds in every op and every span so the optimizer cannot skip
/// any of the work. Not used by the site.
#[wasm_bindgen]
pub fn compute_probe(left: &str, right: &str, granularity: &str) -> u32 {
    let sparse = diff_sparse(left, right, parse_granularity(granularity));
    let mut acc = sparse.added ^ sparse.removed.rotate_left(8) ^ sparse.line_count.rotate_left(16);
    for op in &sparse.ops {
        acc = acc
            .wrapping_mul(31)
            .wrapping_add(op.old_start ^ op.new_start ^ op.old_lines ^ op.new_lines);
    }
    for row in &sparse.highlights {
        for span in row.left.iter().chain(row.right.iter()) {
            acc = acc.wrapping_mul(31).wrapping_add(span.start ^ span.end);
        }
    }
    acc
}
