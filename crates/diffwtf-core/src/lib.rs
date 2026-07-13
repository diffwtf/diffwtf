//! Pure diff engine for diff.wtf. The public types below are the product contract
//! (see `docs/scaffold-spec.md`); changing them is a spec change.
//!
// The README doubles as the docs.rs front page, and including it here compiles
// its usage examples as doctests, so the published snippets can't rot.
#![doc = include_str!("../README.md")]

mod intraline;
mod lcs;
mod myers;

use lcs::Op;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Granularity {
    Word,
    Char,
}

/// A run of characters within a line. `highlighted` marks intra-line del/ins tokens
/// (rendered with the .42/.38-alpha backgrounds per the design).
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Segment {
    pub text: String,
    pub highlighted: bool,
}

/// One side of a split-view row. `None` on a row = missing side (striped cell in the UI).
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct LineCell {
    pub number: u32, // 1-based line number on that side
    pub segments: Vec<Segment>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum RowKind {
    Equal,
    Delete,
    Insert,
    Modify,
}

/// Split-view row. Invariants: Equal/Modify → both sides Some; Delete → right is None;
/// Insert → left is None.
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct SplitRow {
    pub kind: RowKind,
    pub left: Option<LineCell>,
    pub right: Option<LineCell>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum UnifiedKind {
    Equal,
    Delete,
    Insert,
}

/// Unified-view row. Within a changed hunk, ALL deleted lines precede ALL inserted lines
/// (matches the prototype and standard unified-diff convention).
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct UnifiedRow {
    pub kind: UnifiedKind,
    pub old_number: Option<u32>, // None on inserted lines
    pub new_number: Option<u32>, // None on deleted lines
    pub segments: Vec<Segment>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum LineOpKind {
    Equal,
    Delete,
    Insert,
}

/// One raw line-level operation from [`diff_lines`]: the line's text plus
/// 1-based line numbers on each side. `old_number` is `None` on inserted
/// lines, `new_number` is `None` on deleted lines, and both are `Some` on
/// equal lines.
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct LineOp {
    pub kind: LineOpKind,
    pub text: String,
    pub old_number: Option<u32>,
    pub new_number: Option<u32>,
}

/// One run-length operation in a [`SparseDiff`]: a maximal run of equal,
/// deleted, or inserted lines, encoded by position and length instead of by
/// materialized text. One Equal run covers any number of unchanged lines, so
/// the whole result scales with the number of edits, not with document size.
///
/// `old_start` and `new_start` are 0-based line indices into the left and
/// right inputs (split on `'\n'`). Both cursors advance monotonically through
/// the op stream, and every run records both cursors at its position: a
/// Delete run has `new_lines == 0` with `new_start` at the right-side line
/// where the deletion happens, and an Insert run mirrors that on the left.
///
/// Within a hunk all deletions precede all insertions, so a Delete run
/// directly followed by an Insert run forms one hunk; view assembly pairs the
/// first `min(old_lines, new_lines)` lines of such a pair index-wise as
/// Modify rows (see [`SparseDiff::highlights`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct OpRun {
    pub kind: LineOpKind,
    pub old_start: u32,
    pub new_start: u32,
    pub old_lines: u32,
    pub new_lines: u32,
}

/// A half-open highlighted range `[start, end)` within one line, measured in
/// UTF-16 code units, the unit of JavaScript string indexing. This type
/// exists to cross the wasm boundary cheaply; Rust consumers who want the
/// segment text itself should use [`diff`], whose [`Segment`]s carry it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

/// Intra-line refinement for one Modify row: the highlighted ranges on the
/// deleted (left) and inserted (right) line. Ranges are sorted, disjoint,
/// and non-adjacent (same-state runs are merged); everything outside them is
/// unhighlighted. An empty list means the whole line is unhighlighted, which
/// happens whenever no token of that side is deleted or inserted: the line
/// is empty, or all of its tokens survive into the other side (for example
/// the only change is a deleted trailing `\r`, or the other side purely
/// gains tokens), or the pair is two identical lines paired index-wise in
/// the depth-cap degradation mode (see `src/myers.rs`).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct RowHighlights {
    pub left: Vec<Span>,
    pub right: Vec<Span>,
}

/// The sparse, transfer-oriented result of [`diff_sparse`]: run-length ops
/// plus intra-line highlights for changed lines only. Together with the two
/// original input strings this carries exactly the information of a
/// [`DiffResult`]; the conformance suite asserts that reassembling one from
/// the other reproduces [`diff`] byte for byte.
///
/// `highlights` holds one entry per Modify row in stream order: walking the
/// ops, every Delete run immediately followed by an Insert run contributes
/// `min(old_lines, new_lines)` Modify rows, in order.
#[derive(Clone, PartialEq, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct SparseDiff {
    pub ops: Vec<OpRun>,
    pub highlights: Vec<RowHighlights>,
    pub added: u32,      // inserted line count
    pub removed: u32,    // deleted line count
    pub line_count: u32, // max(left lines, right lines)
}

#[derive(Clone, PartialEq, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct DiffResult {
    pub rows: Vec<SplitRow>,
    pub unified: Vec<UnifiedRow>,
    pub added: u32,      // inserted line count
    pub removed: u32,    // deleted line count
    pub line_count: u32, // max(left lines, right lines) — feeds the "{lines} lines" badge
}

// A whole unchanged/deleted/inserted line as segments: one unhighlighted run,
// or nothing for an empty line (the reference substitutes ' '; we emit the true
// empty list per the spec's documented deviation — reconstructability stays exact).
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

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Raw line-level diff: the Myers ops with no intra-line refinement and no
/// view assembly, for library consumers who just want the ops.
///
/// Guarantees:
///
/// - Reconstructability, for every input: concatenating the `text` of Equal
///   and Delete ops (joined with `"\n"`) equals `left`, and Equal plus Insert
///   equals `right`.
/// - Within a changed hunk, all Delete ops precede all Insert ops.
/// - Op counts match [`diff`]: Delete ops = `removed`, Insert ops = `added`,
///   with one documented exception. [`diff`] treats two inputs that are both
///   empty after trimming as the UI empty state and reports zero counts;
///   `diff_lines` has no UI and stays raw, so whitespace-only inputs produce
///   real ops (e.g. `" "` vs `"\t"` is one Delete plus one Insert).
///
/// Inputs are split on `'\n'`; `'\r'` is line content (the engine-wide v1
/// policy). Like [`diff`], a depth-capped pathological case degrades to a
/// non-minimal but still reconstructable diff (see `src/myers.rs`).
pub fn diff_lines(left: &str, right: &str) -> Vec<LineOp> {
    let left_lines: Vec<&str> = left.split('\n').collect();
    let right_lines: Vec<&str> = right.split('\n').collect();
    let (mut ln, mut rn) = (1u32, 1u32);
    myers::diff_slices(&left_lines, &right_lines)
        .into_iter()
        .map(|(op, text)| {
            let (kind, old_number, new_number) = match op {
                Op::Eq => (LineOpKind::Equal, Some(ln), Some(rn)),
                Op::Del => (LineOpKind::Delete, Some(ln), None),
                Op::Ins => (LineOpKind::Insert, None, Some(rn)),
            };
            if old_number.is_some() {
                ln = ln.saturating_add(1);
            }
            if new_number.is_some() {
                rn = rn.saturating_add(1);
            }
            LineOp {
                kind,
                text: text.to_string(),
                old_number,
                new_number,
            }
        })
        .collect()
}

// Highlighted ranges of a segment list, in UTF-16 code units. merge_segs
// guarantees alternation, so the ranges come out sorted, disjoint, and
// non-adjacent, and segment text is never empty, so no range is empty.
fn highlight_spans(segments: &[Segment]) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut cursor = 0u32;
    for seg in segments {
        let len = to_u32(seg.text.chars().map(char::len_utf16).sum::<usize>());
        if seg.highlighted {
            spans.push(Span {
                start: cursor,
                end: cursor.saturating_add(len),
            });
        }
        cursor = cursor.saturating_add(len);
    }
    spans
}

/// Sparse counterpart of [`diff`]: the same Myers line diff and intra-line
/// refinement, returned as run-length [`OpRun`]s plus [`RowHighlights`] for
/// changed lines only, instead of materialized rows. The result size scales
/// with the number of edits, not with document size, which is what makes it
/// cheap to move across the wasm boundary; a renderer reassembles the views
/// from these ops plus the two original inputs.
///
/// Semantics match [`diff`] exactly:
///
/// - Two inputs that are both empty after trimming return
///   `SparseDiff::default()` (the UI empty state).
/// - `added`, `removed`, and `line_count` equal [`diff`]'s.
/// - Reassembling rows from the ops, the highlights, and the original inputs
///   reproduces [`diff`]'s output byte for byte (asserted by the conformance
///   suite).
///
/// Identical inputs take a fast path: when `left == right`, the result is a
/// single Equal run covering every line, without running the diff. The fast
/// path returns exactly what the full path would (every line is equal either
/// way); it exists because the equality check is a single memory compare.
///
/// [`Span`] offsets are UTF-16 code units (see [`Span`] for why).
pub fn diff_sparse(left: &str, right: &str, granularity: Granularity) -> SparseDiff {
    if left.trim().is_empty() && right.trim().is_empty() {
        return SparseDiff::default();
    }
    if left == right {
        let lines = to_u32(left.split('\n').count());
        return SparseDiff {
            ops: vec![OpRun {
                kind: LineOpKind::Equal,
                old_start: 0,
                new_start: 0,
                old_lines: lines,
                new_lines: lines,
            }],
            highlights: Vec::new(),
            added: 0,
            removed: 0,
            line_count: lines,
        };
    }

    let left_lines: Vec<&str> = left.split('\n').collect();
    let right_lines: Vec<&str> = right.split('\n').collect();
    let raw = myers::diff_slices(&left_lines, &right_lines);

    let mut ops: Vec<OpRun> = Vec::new();
    let mut highlights: Vec<RowHighlights> = Vec::new();
    let (mut added, mut removed) = (0u32, 0u32);
    let (mut old_pos, mut new_pos) = (0u32, 0u32);

    let mut i = 0;
    while i < raw.len() {
        if raw[i].0 == Op::Eq {
            let start = i;
            while i < raw.len() && raw[i].0 == Op::Eq {
                i += 1;
            }
            let len = to_u32(i - start);
            ops.push(OpRun {
                kind: LineOpKind::Equal,
                old_start: old_pos,
                new_start: new_pos,
                old_lines: len,
                new_lines: len,
            });
            old_pos = old_pos.saturating_add(len);
            new_pos = new_pos.saturating_add(len);
        } else {
            // A hunk: a run of deletes then a run of inserts (canonicalized
            // by the line diff). The index-paired lines are the Modify rows;
            // their refinement goes to `highlights` in stream order.
            let del_start = i;
            while i < raw.len() && raw[i].0 == Op::Del {
                i += 1;
            }
            let dels = &raw[del_start..i];
            let ins_start = i;
            while i < raw.len() && raw[i].0 == Op::Ins {
                i += 1;
            }
            let inss = &raw[ins_start..i];

            for (&(_, del), &(_, ins)) in dels.iter().zip(inss.iter()) {
                let (l_segs, r_segs) = intraline::intra_diff(del, ins, granularity);
                highlights.push(RowHighlights {
                    left: highlight_spans(&l_segs),
                    right: highlight_spans(&r_segs),
                });
            }
            if !dels.is_empty() {
                let len = to_u32(dels.len());
                ops.push(OpRun {
                    kind: LineOpKind::Delete,
                    old_start: old_pos,
                    new_start: new_pos,
                    old_lines: len,
                    new_lines: 0,
                });
                old_pos = old_pos.saturating_add(len);
                removed = removed.saturating_add(len);
            }
            if !inss.is_empty() {
                let len = to_u32(inss.len());
                ops.push(OpRun {
                    kind: LineOpKind::Insert,
                    old_start: old_pos,
                    new_start: new_pos,
                    old_lines: 0,
                    new_lines: len,
                });
                new_pos = new_pos.saturating_add(len);
                added = added.saturating_add(len);
            }
        }
    }

    SparseDiff {
        ops,
        highlights,
        added,
        removed,
        line_count: to_u32(left_lines.len().max(right_lines.len())),
    }
}

/// The main entry point: the full result with hunk pairing, intra-line
/// refinement, and both assembled views. For raw line ops only, see
/// [`diff_lines`].
pub fn diff(left: &str, right: &str, granularity: Granularity) -> DiffResult {
    if left.trim().is_empty() && right.trim().is_empty() {
        return DiffResult::default();
    }

    let left_lines: Vec<&str> = left.split('\n').collect();
    let right_lines: Vec<&str> = right.split('\n').collect();
    let ops = myers::diff_slices(&left_lines, &right_lines);

    let mut rows = Vec::new();
    let mut unified = Vec::new();
    let (mut added, mut removed) = (0u32, 0u32);
    let (mut ln, mut rn) = (1u32, 1u32);

    let mut i = 0;
    while i < ops.len() {
        if ops[i].0 == Op::Eq {
            let segments = plain(ops[i].1);
            rows.push(SplitRow {
                kind: RowKind::Equal,
                left: Some(LineCell {
                    number: ln,
                    segments: segments.clone(),
                }),
                right: Some(LineCell {
                    number: rn,
                    segments: segments.clone(),
                }),
            });
            unified.push(UnifiedRow {
                kind: UnifiedKind::Equal,
                old_number: Some(ln),
                new_number: Some(rn),
                segments,
            });
            ln = ln.saturating_add(1);
            rn = rn.saturating_add(1);
            i += 1;
        } else {
            // A hunk: a run of deletes followed by a run of inserts; pair them
            // index-wise as Modify rows, leftovers become pure Delete/Insert.
            let mut dels = Vec::new();
            let mut inss = Vec::new();
            while i < ops.len() && ops[i].0 == Op::Del {
                dels.push(ops[i].1);
                i += 1;
            }
            while i < ops.len() && ops[i].0 == Op::Ins {
                inss.push(ops[i].1);
                i += 1;
            }
            removed = removed.saturating_add(to_u32(dels.len()));
            added = added.saturating_add(to_u32(inss.len()));

            let mut u_dels = Vec::new();
            let mut u_inss = Vec::new();
            for k in 0..dels.len().max(inss.len()) {
                match (dels.get(k), inss.get(k)) {
                    (Some(&del), Some(&ins)) => {
                        let (l_segs, r_segs) = intraline::intra_diff(del, ins, granularity);
                        rows.push(SplitRow {
                            kind: RowKind::Modify,
                            left: Some(LineCell {
                                number: ln,
                                segments: l_segs.clone(),
                            }),
                            right: Some(LineCell {
                                number: rn,
                                segments: r_segs.clone(),
                            }),
                        });
                        u_dels.push(UnifiedRow {
                            kind: UnifiedKind::Delete,
                            old_number: Some(ln),
                            new_number: None,
                            segments: l_segs,
                        });
                        u_inss.push(UnifiedRow {
                            kind: UnifiedKind::Insert,
                            old_number: None,
                            new_number: Some(rn),
                            segments: r_segs,
                        });
                        ln = ln.saturating_add(1);
                        rn = rn.saturating_add(1);
                    }
                    (Some(&del), None) => {
                        let segments = plain(del);
                        rows.push(SplitRow {
                            kind: RowKind::Delete,
                            left: Some(LineCell {
                                number: ln,
                                segments: segments.clone(),
                            }),
                            right: None,
                        });
                        u_dels.push(UnifiedRow {
                            kind: UnifiedKind::Delete,
                            old_number: Some(ln),
                            new_number: None,
                            segments,
                        });
                        ln = ln.saturating_add(1);
                    }
                    (None, Some(&ins)) => {
                        let segments = plain(ins);
                        rows.push(SplitRow {
                            kind: RowKind::Insert,
                            left: None,
                            right: Some(LineCell {
                                number: rn,
                                segments: segments.clone(),
                            }),
                        });
                        u_inss.push(UnifiedRow {
                            kind: UnifiedKind::Insert,
                            old_number: None,
                            new_number: Some(rn),
                            segments,
                        });
                        rn = rn.saturating_add(1);
                    }
                    (None, None) => {}
                }
            }
            // All deleted lines precede all inserted lines within the hunk.
            unified.append(&mut u_dels);
            unified.append(&mut u_inss);
        }
    }

    DiffResult {
        rows,
        unified,
        added,
        removed,
        line_count: to_u32(left_lines.len().max(right_lines.len())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_both_sides_is_default() {
        assert_eq!(diff("", "", Granularity::Word), DiffResult::default());
        // The reference checks trimmed emptiness, so whitespace-only counts too.
        assert_eq!(diff("  \n", "\t", Granularity::Word), DiffResult::default());
    }

    #[test]
    fn identical_inputs_are_all_equal() {
        let text = "a\n\nb";
        let result = diff(text, text, Granularity::Word);
        assert_eq!(result.added, 0);
        assert_eq!(result.removed, 0);
        assert_eq!(result.line_count, 3);
        assert!(result.rows.iter().all(|r| r.kind == RowKind::Equal));
        // Empty line renders as the true empty segment list, not a ' ' placeholder.
        assert!(result.rows[1].left.as_ref().unwrap().segments.is_empty());
    }

    #[test]
    fn diff_lines_emits_raw_ops_with_line_numbers() {
        let ops = diff_lines("a\nb\nc", "a\nx\nc");
        let expect = [
            (LineOpKind::Equal, "a", Some(1), Some(1)),
            (LineOpKind::Delete, "b", Some(2), None),
            (LineOpKind::Insert, "x", None, Some(2)),
            (LineOpKind::Equal, "c", Some(3), Some(3)),
        ];
        assert_eq!(ops.len(), expect.len());
        for (op, (kind, text, old, new)) in ops.iter().zip(expect) {
            assert_eq!((op.kind, op.text.as_str()), (kind, text));
            assert_eq!((op.old_number, op.new_number), (old, new));
        }
    }

    #[test]
    fn diff_lines_orders_deletes_before_inserts_within_a_hunk() {
        let ops = diff_lines("a\nb\nc", "x\ny\nz");
        let kinds: Vec<LineOpKind> = ops.iter().map(|o| o.kind).collect();
        assert_eq!(
            kinds,
            [
                LineOpKind::Delete,
                LineOpKind::Delete,
                LineOpKind::Delete,
                LineOpKind::Insert,
                LineOpKind::Insert,
                LineOpKind::Insert,
            ]
        );
    }

    #[test]
    fn diff_lines_stays_raw_on_whitespace_only_inputs() {
        // diff() reports the UI empty state here; diff_lines has no UI and
        // returns the real ops, keeping reconstructability universal.
        assert_eq!(diff(" ", "\t", Granularity::Word), DiffResult::default());
        let ops = diff_lines(" ", "\t");
        let kinds: Vec<LineOpKind> = ops.iter().map(|o| o.kind).collect();
        assert_eq!(kinds, [LineOpKind::Delete, LineOpKind::Insert]);
        assert_eq!(ops[0].text, " ");
        assert_eq!(ops[1].text, "\t");
    }

    #[test]
    fn diff_sparse_encodes_runs_with_both_cursors() {
        let sparse = diff_sparse("a\nb\nc", "a\nx\nc", Granularity::Word);
        let expect = [
            (LineOpKind::Equal, 0, 0, 1, 1),
            (LineOpKind::Delete, 1, 1, 1, 0),
            (LineOpKind::Insert, 2, 1, 0, 1),
            (LineOpKind::Equal, 2, 2, 1, 1),
        ];
        assert_eq!(sparse.ops.len(), expect.len());
        for (op, (kind, old_start, new_start, old_lines, new_lines)) in
            sparse.ops.iter().zip(expect)
        {
            assert_eq!(op.kind, kind);
            assert_eq!(
                (op.old_start, op.new_start, op.old_lines, op.new_lines),
                (old_start, new_start, old_lines, new_lines)
            );
        }
        // "b" to "x" is one Modify row, fully highlighted on both sides.
        assert_eq!(
            sparse.highlights,
            vec![RowHighlights {
                left: vec![Span { start: 0, end: 1 }],
                right: vec![Span { start: 0, end: 1 }],
            }]
        );
        assert_eq!((sparse.added, sparse.removed, sparse.line_count), (1, 1, 3));
    }

    #[test]
    fn diff_sparse_identical_fast_path_is_one_equal_run() {
        let text = "a\n\nb";
        let sparse = diff_sparse(text, text, Granularity::Word);
        assert_eq!(
            sparse.ops,
            vec![OpRun {
                kind: LineOpKind::Equal,
                old_start: 0,
                new_start: 0,
                old_lines: 3,
                new_lines: 3,
            }]
        );
        assert!(sparse.highlights.is_empty());
        assert_eq!((sparse.added, sparse.removed, sparse.line_count), (0, 0, 3));
    }

    #[test]
    fn diff_sparse_empty_state_matches_diff() {
        assert_eq!(
            diff_sparse("", "", Granularity::Word),
            SparseDiff::default()
        );
        // Whitespace-only counts as empty, mirroring diff(), and wins over
        // the identical fast path ("  " == "  " must still be the empty state).
        assert_eq!(
            diff_sparse("  \n", "\t", Granularity::Word),
            SparseDiff::default()
        );
        assert_eq!(
            diff_sparse("  ", "  ", Granularity::Word),
            SparseDiff::default()
        );
    }

    #[test]
    fn diff_sparse_spans_are_utf16_code_units() {
        // The emoji is one char but two UTF-16 code units, so the edited word
        // after "<emoji> " starts at offset 3, not 2.
        let left = "\u{1F389} old";
        let right = "\u{1F389} new";
        let sparse = diff_sparse(left, right, Granularity::Word);
        assert_eq!(
            sparse.highlights,
            vec![RowHighlights {
                left: vec![Span { start: 3, end: 6 }],
                right: vec![Span { start: 3, end: 6 }],
            }]
        );
    }

    #[test]
    fn diff_sparse_modify_with_empty_side_has_no_left_spans() {
        // "" vs "hello": the reference pairs the empty line with the insertion
        // as a Modify row; the empty side has no highlight ranges at all.
        let sparse = diff_sparse("", "hello", Granularity::Word);
        assert_eq!(sparse.ops.len(), 2);
        assert_eq!(
            sparse.highlights,
            vec![RowHighlights {
                left: Vec::new(),
                right: vec![Span { start: 0, end: 5 }],
            }]
        );
    }

    #[test]
    fn one_side_empty_pairs_as_modify_like_the_reference() {
        // Left "" is one (empty) line, so the reference pairs it with the
        // insertion as a Modify row: +1/−1, not a pure insert.
        let result = diff("", "hello", Granularity::Word);
        assert_eq!((result.added, result.removed), (1, 1));
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].kind, RowKind::Modify);
        let right = result.rows[0].right.as_ref().unwrap();
        assert_eq!(right.segments.len(), 1);
        assert_eq!(right.segments[0].text, "hello");
        assert!(right.segments[0].highlighted);
        assert!(result.rows[0].left.as_ref().unwrap().segments.is_empty());
    }
}
