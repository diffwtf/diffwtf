//! Shared contract-invariant checker used by the conformance suite and the
//! property tests. These invariants must hold for ANY input, exact-match
//! fixture or not: row shape per kind, 1-based consecutive numbering,
//! byte-exact input reconstruction, honest counts, hunk ordering, and merged
//! segments.

use diffwtf_core::{
    DiffResult, LineCell, LineOpKind, RowKind, Segment, Span, SparseDiff, SplitRow, UnifiedKind,
    UnifiedRow,
};

pub fn cell_text(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect()
}

fn plain(text: &str) -> Vec<Segment> {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![Segment {
            text: text.to_string(),
            highlighted: false,
        }]
    }
}

/// Cut one line into contract segments from its highlighted spans (UTF-16
/// code unit offsets, half-open). Panics loudly if a span boundary does not
/// land on a char boundary of the line, which the engine guarantees.
fn segments_from_spans(text: &str, spans: &[Span]) -> Vec<Segment> {
    if spans.is_empty() {
        return plain(text);
    }
    // Map each span boundary from UTF-16 offset to byte offset in one pass.
    let boundaries: Vec<u32> = spans.iter().flat_map(|s| [s.start, s.end]).collect();
    let mut byte_of = Vec::with_capacity(boundaries.len());
    let mut next = 0usize;
    let mut utf16_pos = 0u32;
    for (byte_idx, c) in text.char_indices() {
        while next < boundaries.len() && boundaries[next] == utf16_pos {
            byte_of.push(byte_idx);
            next += 1;
        }
        utf16_pos += c.len_utf16() as u32;
    }
    while next < boundaries.len() {
        assert_eq!(
            boundaries[next], utf16_pos,
            "span boundary {} is not on a char boundary of {text:?}",
            boundaries[next]
        );
        byte_of.push(text.len());
        next += 1;
    }

    let mut segments = Vec::new();
    let mut cursor = 0usize;
    for (i, _span) in spans.iter().enumerate() {
        let (start, end) = (byte_of[2 * i], byte_of[2 * i + 1]);
        if start > cursor {
            segments.push(Segment {
                text: text[cursor..start].to_string(),
                highlighted: false,
            });
        }
        segments.push(Segment {
            text: text[start..end].to_string(),
            highlighted: true,
        });
        cursor = end;
    }
    if cursor < text.len() {
        segments.push(Segment {
            text: text[cursor..].to_string(),
            highlighted: false,
        });
    }
    segments
}

/// Rebuild a full `DiffResult` from a `SparseDiff` plus the two original
/// inputs, mirroring what the web renderer's assemble.js does. The suites
/// assert this equals `diff()` exactly, which is the proof that the sparse
/// shape carries all the information of the materialized one.
pub fn assemble(left: &str, right: &str, sparse: &SparseDiff) -> DiffResult {
    let left_lines: Vec<&str> = left.split('\n').collect();
    let right_lines: Vec<&str> = right.split('\n').collect();
    let mut rows = Vec::new();
    let mut unified = Vec::new();
    let mut highlights = sparse.highlights.iter();

    let ops = &sparse.ops;
    let mut i = 0;
    while i < ops.len() {
        let op = &ops[i];
        if op.kind == LineOpKind::Equal {
            for k in 0..op.old_lines {
                let old_number = op.old_start + k + 1;
                let new_number = op.new_start + k + 1;
                let segments = plain(left_lines[(op.old_start + k) as usize]);
                rows.push(SplitRow {
                    kind: RowKind::Equal,
                    left: Some(LineCell {
                        number: old_number,
                        segments: segments.clone(),
                    }),
                    right: Some(LineCell {
                        number: new_number,
                        segments: segments.clone(),
                    }),
                });
                unified.push(UnifiedRow {
                    kind: UnifiedKind::Equal,
                    old_number: Some(old_number),
                    new_number: Some(new_number),
                    segments,
                });
            }
            i += 1;
            continue;
        }

        // A hunk: a delete run, an insert run, or a delete run directly
        // followed by an insert run. Index-paired lines are Modify rows and
        // consume the next highlights entry each.
        let (del, ins) = if op.kind == LineOpKind::Delete {
            let next = ops.get(i + 1).filter(|n| n.kind == LineOpKind::Insert);
            i += 1 + usize::from(next.is_some());
            (Some(op), next)
        } else {
            i += 1;
            (None, Some(op))
        };
        let dels = del.map_or(0, |o| o.old_lines);
        let inss = ins.map_or(0, |o| o.new_lines);
        let mut u_dels = Vec::new();
        let mut u_inss = Vec::new();
        for k in 0..dels.max(inss) {
            let left_text = (k < dels).then(|| left_lines[(del.unwrap().old_start + k) as usize]);
            let right_text = (k < inss).then(|| right_lines[(ins.unwrap().new_start + k) as usize]);
            let old_number = del.map(|o| o.old_start + k + 1);
            let new_number = ins.map(|o| o.new_start + k + 1);
            match (left_text, right_text) {
                (Some(lt), Some(rt)) => {
                    let h = highlights
                        .next()
                        .expect("one highlights entry per Modify row");
                    let l_segs = segments_from_spans(lt, &h.left);
                    let r_segs = segments_from_spans(rt, &h.right);
                    rows.push(SplitRow {
                        kind: RowKind::Modify,
                        left: Some(LineCell {
                            number: old_number.unwrap(),
                            segments: l_segs.clone(),
                        }),
                        right: Some(LineCell {
                            number: new_number.unwrap(),
                            segments: r_segs.clone(),
                        }),
                    });
                    u_dels.push(UnifiedRow {
                        kind: UnifiedKind::Delete,
                        old_number,
                        new_number: None,
                        segments: l_segs,
                    });
                    u_inss.push(UnifiedRow {
                        kind: UnifiedKind::Insert,
                        old_number: None,
                        new_number,
                        segments: r_segs,
                    });
                }
                (Some(lt), None) => {
                    let segments = plain(lt);
                    rows.push(SplitRow {
                        kind: RowKind::Delete,
                        left: Some(LineCell {
                            number: old_number.unwrap(),
                            segments: segments.clone(),
                        }),
                        right: None,
                    });
                    u_dels.push(UnifiedRow {
                        kind: UnifiedKind::Delete,
                        old_number,
                        new_number: None,
                        segments,
                    });
                }
                (None, Some(rt)) => {
                    let segments = plain(rt);
                    rows.push(SplitRow {
                        kind: RowKind::Insert,
                        left: None,
                        right: Some(LineCell {
                            number: new_number.unwrap(),
                            segments: segments.clone(),
                        }),
                    });
                    u_inss.push(UnifiedRow {
                        kind: UnifiedKind::Insert,
                        old_number: None,
                        new_number,
                        segments,
                    });
                }
                (None, None) => unreachable!("k < dels.max(inss)"),
            }
        }
        unified.append(&mut u_dels);
        unified.append(&mut u_inss);
    }

    DiffResult {
        rows,
        unified,
        added: sparse.added,
        removed: sparse.removed,
        line_count: sparse.line_count,
    }
}

/// Structural invariants of the sparse shape itself, for ANY input: runs
/// tile both inputs with monotonic cursors, per-kind length shape, run
/// maximality, del-before-ins hunk ordering, honest counts, and a sane,
/// in-bounds highlight side channel.
pub fn check_sparse_invariants(label: &str, left: &str, right: &str, sparse: &SparseDiff) {
    let left_lines: Vec<&str> = left.split('\n').collect();
    let right_lines: Vec<&str> = right.split('\n').collect();
    let utf16_len = |s: &str| -> u32 { s.chars().map(|c| c.len_utf16() as u32).sum() };

    if sparse.ops.is_empty() {
        assert_eq!(sparse, &SparseDiff::default(), "{label}: empty ops");
        return;
    }

    let (mut old_pos, mut new_pos) = (0u32, 0u32);
    let (mut added, mut removed, mut modifies) = (0u32, 0u32, 0u32);
    for (i, op) in sparse.ops.iter().enumerate() {
        assert_eq!(
            (op.old_start, op.new_start),
            (old_pos, new_pos),
            "{label}: op {i} starts vs cursors"
        );
        match op.kind {
            LineOpKind::Equal => {
                assert!(op.old_lines > 0, "{label}: op {i} empty Equal run");
                assert_eq!(op.old_lines, op.new_lines, "{label}: op {i} Equal lengths");
                for k in 0..op.old_lines {
                    assert_eq!(
                        left_lines[(op.old_start + k) as usize],
                        right_lines[(op.new_start + k) as usize],
                        "{label}: op {i} Equal run covers differing lines at offset {k}"
                    );
                }
            }
            LineOpKind::Delete => {
                assert!(op.old_lines > 0, "{label}: op {i} empty Delete run");
                assert_eq!(op.new_lines, 0, "{label}: op {i} Delete new_lines");
                removed += op.old_lines;
            }
            LineOpKind::Insert => {
                assert!(op.new_lines > 0, "{label}: op {i} empty Insert run");
                assert_eq!(op.old_lines, 0, "{label}: op {i} Insert old_lines");
                added += op.new_lines;
            }
        }
        if let Some(prev) = i.checked_sub(1).map(|p| &sparse.ops[p]) {
            assert_ne!(prev.kind, op.kind, "{label}: op {i} not a maximal run");
            assert!(
                !(prev.kind == LineOpKind::Insert && op.kind == LineOpKind::Delete),
                "{label}: op {i} Delete after Insert breaks hunk ordering"
            );
        }
        if op.kind == LineOpKind::Delete {
            if let Some(next) = sparse.ops.get(i + 1) {
                if next.kind == LineOpKind::Insert {
                    modifies += op.old_lines.min(next.new_lines);
                }
            }
        }
        old_pos += op.old_lines;
        new_pos += op.new_lines;
    }
    assert_eq!(
        old_pos as usize,
        left_lines.len(),
        "{label}: ops do not tile the left input"
    );
    assert_eq!(
        new_pos as usize,
        right_lines.len(),
        "{label}: ops do not tile the right input"
    );
    assert_eq!(sparse.removed, removed, "{label}: removed count");
    assert_eq!(sparse.added, added, "{label}: added count");
    assert_eq!(
        sparse.line_count as usize,
        left_lines.len().max(right_lines.len()),
        "{label}: line_count"
    );

    assert_eq!(
        sparse.highlights.len() as u32,
        modifies,
        "{label}: one highlights entry per Modify row"
    );
    // Walk the modify rows again to bound each side's spans by its line.
    let mut hl = sparse.highlights.iter();
    for (i, op) in sparse.ops.iter().enumerate() {
        let Some(next) = sparse.ops.get(i + 1) else {
            break;
        };
        if op.kind != LineOpKind::Delete || next.kind != LineOpKind::Insert {
            continue;
        }
        for k in 0..op.old_lines.min(next.new_lines) {
            let h = hl.next().unwrap();
            for (side, spans, line) in [
                ("left", &h.left, left_lines[(op.old_start + k) as usize]),
                (
                    "right",
                    &h.right,
                    right_lines[(next.new_start + k) as usize],
                ),
            ] {
                let mut prev_end = None;
                for span in spans {
                    assert!(
                        span.start < span.end,
                        "{label}: modify row {side} span is empty or reversed"
                    );
                    if let Some(prev) = prev_end {
                        assert!(
                            span.start > prev,
                            "{label}: modify row {side} spans not sorted/merged"
                        );
                    }
                    prev_end = Some(span.end);
                }
                if let Some(last) = prev_end {
                    assert!(
                        last <= utf16_len(line),
                        "{label}: modify row {side} span past end of line"
                    );
                }
            }
        }
    }
}

pub fn check_invariants(label: &str, left: &str, right: &str, result: &DiffResult) {
    let left_lines = left.split('\n').count() as u32;
    let right_lines = right.split('\n').count() as u32;
    assert_eq!(
        result.line_count,
        left_lines.max(right_lines),
        "{label}: line_count"
    );

    // Split rows: shape per kind, and consecutive 1-based numbering per side.
    let (mut next_left, mut next_right) = (1u32, 1u32);
    let (mut modifies, mut deletes, mut inserts) = (0u32, 0u32, 0u32);
    for (i, row) in result.rows.iter().enumerate() {
        match row.kind {
            RowKind::Equal | RowKind::Modify => assert!(
                row.left.is_some() && row.right.is_some(),
                "{label}: row {i} ({:?}) must have both sides",
                row.kind
            ),
            RowKind::Delete => assert!(
                row.left.is_some() && row.right.is_none(),
                "{label}: row {i} (Delete) must be left-only"
            ),
            RowKind::Insert => assert!(
                row.left.is_none() && row.right.is_some(),
                "{label}: row {i} (Insert) must be right-only"
            ),
        }
        match row.kind {
            RowKind::Modify => modifies += 1,
            RowKind::Delete => deletes += 1,
            RowKind::Insert => inserts += 1,
            RowKind::Equal => {
                let (l, r) = (row.left.as_ref().unwrap(), row.right.as_ref().unwrap());
                assert_eq!(
                    l.segments, r.segments,
                    "{label}: row {i} Equal sides differ"
                );
                assert!(
                    l.segments.iter().all(|s| !s.highlighted),
                    "{label}: row {i} Equal row has highlights"
                );
            }
        }
        if let Some(cell) = &row.left {
            assert_eq!(cell.number, next_left, "{label}: row {i} left numbering");
            next_left += 1;
        }
        if let Some(cell) = &row.right {
            assert_eq!(cell.number, next_right, "{label}: row {i} right numbering");
            next_right += 1;
        }
        for cell in [&row.left, &row.right].into_iter().flatten() {
            for (s, pair) in cell.segments.windows(2).enumerate() {
                assert!(
                    pair[0].highlighted != pair[1].highlighted,
                    "{label}: row {i} segments {s},{} not merged",
                    s + 1
                );
            }
            assert!(
                cell.segments.iter().all(|s| !s.text.is_empty()),
                "{label}: row {i} has an empty-text segment"
            );
        }
    }
    assert_eq!(next_left - 1, left_lines, "{label}: left side line total");
    assert_eq!(
        next_right - 1,
        right_lines,
        "{label}: right side line total"
    );
    assert_eq!(result.removed, modifies + deletes, "{label}: removed count");
    assert_eq!(result.added, modifies + inserts, "{label}: added count");

    // Reconstructability: concatenating each side's segment text restores the
    // inputs byte-for-byte, through both views.
    let join = |texts: Vec<String>| texts.join("\n");
    let rows_left = join(
        result
            .rows
            .iter()
            .filter_map(|r| r.left.as_ref())
            .map(|c| cell_text(&c.segments))
            .collect(),
    );
    let rows_right = join(
        result
            .rows
            .iter()
            .filter_map(|r| r.right.as_ref())
            .map(|c| cell_text(&c.segments))
            .collect(),
    );
    assert_eq!(
        rows_left, left,
        "{label}: left does not reconstruct from rows"
    );
    assert_eq!(
        rows_right, right,
        "{label}: right does not reconstruct from rows"
    );

    // Unified rows: shape per kind, numbering, hunk ordering, reconstruction.
    let (mut next_old, mut next_new) = (1u32, 1u32);
    for (i, row) in result.unified.iter().enumerate() {
        match row.kind {
            UnifiedKind::Equal => assert!(
                row.old_number.is_some() && row.new_number.is_some(),
                "{label}: unified {i} Equal numbering shape"
            ),
            UnifiedKind::Delete => assert!(
                row.old_number.is_some() && row.new_number.is_none(),
                "{label}: unified {i} Delete numbering shape"
            ),
            UnifiedKind::Insert => assert!(
                row.old_number.is_none() && row.new_number.is_some(),
                "{label}: unified {i} Insert numbering shape"
            ),
        }
        if let Some(n) = row.old_number {
            assert_eq!(n, next_old, "{label}: unified {i} old numbering");
            next_old += 1;
        }
        if let Some(n) = row.new_number {
            assert_eq!(n, next_new, "{label}: unified {i} new numbering");
            next_new += 1;
        }
    }
    assert_eq!(next_old - 1, left_lines, "{label}: unified old line total");
    assert_eq!(next_new - 1, right_lines, "{label}: unified new line total");
    // Within a hunk all deletions precede all insertions, so Insert directly
    // followed by Delete can never occur anywhere in the stream.
    for (i, pair) in result.unified.windows(2).enumerate() {
        assert!(
            !(pair[0].kind == UnifiedKind::Insert && pair[1].kind == UnifiedKind::Delete),
            "{label}: unified {i}: Delete after Insert breaks hunk ordering"
        );
    }
    let unified_old = join(
        result
            .unified
            .iter()
            .filter(|u| u.old_number.is_some())
            .map(|u| cell_text(&u.segments))
            .collect(),
    );
    let unified_new = join(
        result
            .unified
            .iter()
            .filter(|u| u.new_number.is_some())
            .map(|u| cell_text(&u.segments))
            .collect(),
    );
    assert_eq!(
        unified_old, left,
        "{label}: left does not reconstruct from unified"
    );
    assert_eq!(
        unified_new, right,
        "{label}: right does not reconstruct from unified"
    );
}
