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
