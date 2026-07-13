#!/usr/bin/env node
// scripts/conformance-web.mjs: the JS side of the conformance suite. The
// Rust suite (crates/diffwtf-core/tests/conformance.rs) pins the engine to
// the committed fixtures; this script pins the two JS pieces that sit between
// the engine and the user's screen:
//
//   1. the shipped wasm boundary: web/pkg compute() refolded to the ops
//      fixture shape must deep-equal {name}.{gran}.ops.json exactly;
//   2. the shipped view assembly: web/js/assemble.js over the wasm result
//      must deep-equal the materialized reference output {name}.{gran}.json;
//   3. assembly independence: assemble.js fed the committed ops fixture
//      (rather than the wasm output) must reproduce {name}.{gran}.json too,
//      so the assembler is verified against reference-defined data even if
//      the engine and fixtures ever drift together.
//
// Policy mirror: INVARIANT_CASES below must stay in sync with the list in
// conformance.rs (cases where Myers legitimately picks a different but
// equally minimal diff). For demoted cases, checks 1 and 2 fall back to the
// added/removed/line_count counts and check 3 still runs exactly.
//
// Requires web/pkg (./scripts/build-wasm.sh). Usage:
//   node scripts/conformance-web.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleDiffResult } from '../web/js/assemble.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = join(ROOT, 'fixtures', 'cases');
const EXPECTED_DIR = join(ROOT, 'fixtures', 'expected');

// Keep in sync with INVARIANT_CASES in conformance.rs (currently empty).
const INVARIANT_CASES = [];

let initWasm, wasmCompute;
try {
  const pkg = await import(join(ROOT, 'web/pkg/diffwtf_wasm.js'));
  initWasm = pkg.default;
  wasmCompute = pkg.compute;
} catch (err) {
  console.error('cannot load web/pkg; run ./scripts/build-wasm.sh first');
  console.error(String(err));
  process.exit(1);
}
await initWasm({ module_or_path: readFileSync(join(ROOT, 'web/pkg/diffwtf_wasm_bg.wasm')) });

// Strict structural equality: null !== undefined, missing key !== null.
// Returns the path of the first mismatch, or null when equal.
function firstMismatch(actual, expected, path) {
  if (Object.is(actual, expected)) return null;
  if (
    typeof actual !== 'object' || actual === null ||
    typeof expected !== 'object' || expected === null
  ) {
    return `${path}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return `${path}: array vs non-array`;
  if (Array.isArray(actual) && actual.length !== expected.length) {
    return `${path}: length ${actual.length}, expected ${expected.length}`;
  }
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    const err = firstMismatch(actual[key], expected[key], `${path}.${key}`);
    if (err) return err;
  }
  return null;
}

const KIND_NAMES = ['equal', 'delete', 'insert'];

// Boundary struct-of-arrays to the fixtures' array-of-structs shape.
function foldSparse(sparse) {
  const ops = Array.from(sparse.kind, (k, i) => ({
    kind: KIND_NAMES[k],
    old_start: sparse.old_start[i],
    new_start: sparse.new_start[i],
    old_lines: sparse.old_lines[i],
    new_lines: sparse.new_lines[i],
  }));
  const highlights = [];
  let off = 0;
  const takeSpans = (count) => {
    const spans = [];
    for (let s = 0; s < count; s++) {
      spans.push({ start: sparse.hl_ranges[off], end: sparse.hl_ranges[off + 1] });
      off += 2;
    }
    return spans;
  };
  for (let row = 0; 2 * row < sparse.hl_counts.length; row++) {
    highlights.push({
      left: takeSpans(sparse.hl_counts[2 * row]),
      right: takeSpans(sparse.hl_counts[2 * row + 1]),
    });
  }
  return {
    ops,
    highlights,
    added: sparse.added,
    removed: sparse.removed,
    line_count: sparse.line_count,
  };
}

// Fixtures' array-of-structs shape to the boundary struct-of-arrays shape,
// for feeding assemble.js reference-defined data directly.
function unfoldSparse(fixture) {
  const n = fixture.ops.length;
  const soa = {
    kind: new Uint8Array(n),
    old_start: new Uint32Array(n),
    new_start: new Uint32Array(n),
    old_lines: new Uint32Array(n),
    new_lines: new Uint32Array(n),
    added: fixture.added,
    removed: fixture.removed,
    line_count: fixture.line_count,
  };
  fixture.ops.forEach((op, i) => {
    soa.kind[i] = KIND_NAMES.indexOf(op.kind);
    soa.old_start[i] = op.old_start;
    soa.new_start[i] = op.new_start;
    soa.old_lines[i] = op.old_lines;
    soa.new_lines[i] = op.new_lines;
  });
  const counts = [];
  const ranges = [];
  for (const row of fixture.highlights) {
    counts.push(row.left.length, row.right.length);
    for (const span of [...row.left, ...row.right]) ranges.push(span.start, span.end);
  }
  soa.hl_counts = Uint32Array.from(counts);
  soa.hl_ranges = Uint32Array.from(ranges);
  return soa;
}

const names = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.left.txt'))
  .map((f) => f.slice(0, -'.left.txt'.length))
  .sort();
if (names.length === 0) throw new Error(`no cases found in ${CASES_DIR}`);

const failures = [];
for (const name of names) {
  const left = readFileSync(join(CASES_DIR, `${name}.left.txt`), 'utf8');
  const right = readFileSync(join(CASES_DIR, `${name}.right.txt`), 'utf8');
  const demoted = INVARIANT_CASES.includes(name);
  for (const granularity of ['word', 'char']) {
    const label = `${name} (${granularity})`;
    const expectedOps = JSON.parse(
      readFileSync(join(EXPECTED_DIR, `${name}.${granularity}.ops.json`), 'utf8'),
    );
    const expectedResult = JSON.parse(
      readFileSync(join(EXPECTED_DIR, `${name}.${granularity}.json`), 'utf8'),
    );

    const sparse = wasmCompute(left, right, granularity);
    const folded = JSON.parse(JSON.stringify(foldSparse(sparse)));

    if (demoted) {
      for (const key of ['added', 'removed', 'line_count']) {
        if (folded[key] !== expectedOps[key]) {
          failures.push(`${label}: demoted case, but ${key} ${folded[key]} != reference ${expectedOps[key]}`);
        }
      }
    } else {
      const opsErr = firstMismatch(folded, expectedOps, '$');
      if (opsErr) failures.push(`${label}: wasm boundary vs ops fixture: ${opsErr}`);

      const assembled = JSON.parse(JSON.stringify(assembleDiffResult(left, right, sparse)));
      const viewErr = firstMismatch(assembled, expectedResult, '$');
      if (viewErr) failures.push(`${label}: assembled views vs reference: ${viewErr}`);
    }

    const fromFixture = JSON.parse(
      JSON.stringify(assembleDiffResult(left, right, unfoldSparse(expectedOps))),
    );
    const indepErr = firstMismatch(fromFixture, expectedResult, '$');
    if (indepErr) failures.push(`${label}: assemble.js over the ops fixture: ${indepErr}`);
  }
  console.log(`${failures.length ? '…' : '✓'} ${name}`);
}

if (failures.length) {
  console.error(`\n${failures.length} conformance failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\nall ${names.length} cases conform at both granularities (wasm boundary, assembled views, assembler independence)`);
