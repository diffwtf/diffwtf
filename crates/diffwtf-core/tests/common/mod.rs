//! Shared contract-invariant checker used by the conformance suite and the
//! property tests. These invariants must hold for ANY input, exact-match
//! fixture or not: row shape per kind, 1-based consecutive numbering,
//! byte-exact input reconstruction, honest counts, hunk ordering, and merged
//! segments.

use diffwtf_core::{DiffResult, RowKind, Segment, UnifiedKind};

pub fn cell_text(segments: &[Segment]) -> String {
    segments.iter().map(|s| s.text.as_str()).collect()
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
