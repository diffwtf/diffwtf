//! Line-level diff: Myers greedy O(ND) (Myers 1986, "An O(ND) Difference
//! Algorithm and Its Variations") over line slices, with common prefix/suffix
//! trimming. Replaces the reference's LCS DP at the line level; `lcs.rs`
//! remains in use for token-level intra-line refinement.
//!
//! Differences from the reference `lcs()`:
//!
//! - The reference's 600 000-cell bailout is replaced by a search depth cap:
//!   if a diff would need more than `MAX_D` line edits after trimming, the
//!   trimmed middle degrades to del-all then ins-all (the reference's own
//!   degradation mode). Every input under the cap gets a guaranteed minimal
//!   diff. See `MAX_D` for the memory math and DECISIONS.md D3 for the
//!   decision record.
//! - Within each hunk (a maximal run of non-equal ops) the output is
//!   canonicalized to all deletions before all insertions. The set of deleted
//!   and inserted lines between two matches is the same regardless of how the
//!   edit path interleaves them, so this is pure op ordering, not a change to
//!   the diff. It matches the reference's output shape and the unified-view
//!   contract ("all deleted lines precede all inserted lines").
//!
//! Complexity (n, m: line counts of the trimmed middle; D: edit distance,
//! that is the number of deleted plus inserted lines):
//!
//! - Time: O((n + m) * min(D, MAX_D)). Near-identical inputs are close to
//!   linear.
//! - Memory: this is the plain V-array variant with a per-round trace for
//!   path recovery, not the linear-space refinement. The trace holds
//!   sum(2d + 1 for d in 0..D) = D^2 words and D is capped at MAX_D, so it
//!   tops out around 34 MB (17 MB on wasm32); see `MAX_D`. Linear-space
//!   Myers (middle snake) is the planned post-launch replacement, which
//!   subsumes the cap.

use crate::lcs::Op;

/// Depth cap for the forward search, sized so the backtrack trace stays
/// within a 32 MiB budget. The trace holds
/// sum(2d + 1 for d in 0..D) = D^2 words, so the budget gives
/// D^2 * 8 bytes <= 32 MiB, D <= sqrt(4 194 304) = 2048. At the cap the
/// trace is 2048^2 = 4 194 304 words: 32 MiB (roughly 34 MB) at 8-byte
/// words on 64-bit hosts and 16 MiB (roughly 17 MB) on wasm32 (4-byte
/// words), regardless of input size.
/// Diffs needing at most 2048 line edits after prefix/suffix trimming (any
/// realistic paste) are unaffected and stay minimal; past the cap the
/// trimmed middle degrades to del-all then ins-all (see `middle_capped`).
const MAX_D: usize = 2048;

/// Myers diff over two slices of lines. Returns ops in order, hunks
/// canonicalized to deletions before insertions.
pub(crate) fn diff_slices<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(Op, &'a str)> {
    let mut s = 0;
    while s < a.len() && s < b.len() && a[s] == b[s] {
        s += 1;
    }
    let mut e = 0;
    while e < a.len() - s && e < b.len() - s && a[a.len() - 1 - e] == b[b.len() - 1 - e] {
        e += 1;
    }
    let am = &a[s..a.len() - e];
    let bm = &b[s..b.len() - e];

    let mut ops = Vec::with_capacity(a.len() + b.len() - s - e);
    for &item in &a[..s] {
        ops.push((Op::Eq, item));
    }
    if am.is_empty() {
        for &item in bm {
            ops.push((Op::Ins, item));
        }
    } else if bm.is_empty() {
        for &item in am {
            ops.push((Op::Del, item));
        }
    } else {
        middle(am, bm, &mut ops);
    }
    for &item in &a[a.len() - e..] {
        ops.push((Op::Eq, item));
    }
    ops
}

/// Greedy forward pass plus trace-based backtrack over the trimmed middle
/// (both sides non-empty, first and last elements differ).
fn middle<'a>(a: &[&'a str], b: &[&'a str], out: &mut Vec<(Op, &'a str)>) {
    middle_capped(a, b, out, MAX_D);
}

/// `middle` with the depth cap as a parameter, crate-internal so tests can
/// force the give-up path cheaply: through the public API it takes an input
/// needing more than `MAX_D` edits (thousands of lines), and the theoretical
/// never-found case cannot be forced at all (round n + m always reaches
/// (n, m)); both funnel into the same fallback branch below, so a small
/// cap here exercises exactly the code the theoretical case would run.
///
/// If no path is found within `max_d` rounds, the middle degrades to del-all
/// then ins-all, mirroring the reference LCS bailout's degradation mode:
/// reconstruction stays byte-exact and counts stay honest, the diff is just
/// not minimal.
fn middle_capped<'a>(a: &[&'a str], b: &[&'a str], out: &mut Vec<(Op, &'a str)>, max_d: usize) {
    let n = a.len();
    let m = b.len();
    let max = (n + m).min(max_d);
    let offset = max as isize;

    // v[k + offset] = furthest x on diagonal k. All reads at round d see
    // values written in round d - 1 (k parity alternates per round); the
    // initial zeroed v[k = 1] = 0 seeds round 0.
    let mut v = vec![0usize; 2 * max + 1];
    // trace[d] = v[-d ..= d] as of the end of round d; round D itself is not
    // needed for backtracking. Total D^2 words, the memory bound above.
    let mut trace: Vec<Vec<usize>> = Vec::new();
    let mut found_d = None;

    'rounds: for d in 0..=max {
        let di = d as isize;
        let mut k = -di;
        while k <= di {
            let idx = |k: isize| (k + offset) as usize;
            // Move down (insert) at the lower boundary or when the diagonal
            // below is behind; otherwise move right (delete). Ties prefer
            // delete, like the reference DP traceback.
            let down = k == -di || (k != di && v[idx(k - 1)] < v[idx(k + 1)]);
            let mut x = if down {
                v[idx(k + 1)]
            } else {
                v[idx(k - 1)] + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            v[idx(k)] = x;
            if x >= n && y >= m {
                found_d = Some(d);
                break 'rounds;
            }
            k += 2;
        }
        trace.push(v[(offset - di) as usize..=(offset + di) as usize].to_vec());
    }

    let Some(found_d) = found_d else {
        // Depth cap exceeded (or, theoretically, the search failed to reach
        // (n, m), which round n + m rules out): degrade the trimmed middle
        // to the trivially correct del-all then ins-all diff. Covered by
        // `capped_search_degrades_to_del_all_then_ins_all` below and the
        // public-API cap test in tests/properties.rs.
        for &item in a {
            out.push((Op::Del, item));
        }
        for &item in b {
            out.push((Op::Ins, item));
        }
        return;
    };

    // Backtrack from (n, m), reproducing each round's down-or-right decision
    // from the previous round's trace, then reverse into forward order.
    let mut rev: Vec<(Op, &'a str)> = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=found_d).rev() {
        let di = d as isize;
        let vprev = &trace[d - 1];
        let pidx = |k: isize| (k + di - 1) as usize;
        let k = x as isize - y as isize;
        let down = k == -di || (k != di && vprev[pidx(k - 1)] < vprev[pidx(k + 1)]);
        let prev_k = if down { k + 1 } else { k - 1 };
        let prev_x = vprev[pidx(prev_k)];
        let prev_y = (prev_x as isize - prev_k) as usize;
        // Snake back from (x, y) to where the round-d move landed. Only x is
        // tracked: y stays diagonal with it and is reset from prev_y below.
        let land_x = if down { prev_x } else { prev_x + 1 };
        while x > land_x {
            x -= 1;
            rev.push((Op::Eq, a[x]));
        }
        if down {
            rev.push((Op::Ins, b[prev_y]));
        } else {
            rev.push((Op::Del, a[prev_x]));
        }
        x = prev_x;
        y = prev_y;
    }
    // The backtrack must land on the round-0 origin: the middle is
    // prefix-trimmed (a[0] != b[0]), so round 0's snake is empty and
    // x == y == 0 here. If that invariant ever broke, an Eq drain would
    // silently drop or misalign lines in release builds; draining each side
    // independently (left as deletions, right as insertions) keeps
    // reconstruction byte-exact by construction. In the intact case both
    // loops run zero iterations, and test builds still fail loudly.
    debug_assert_eq!(x, 0);
    debug_assert_eq!(y, 0);
    while x > 0 {
        x -= 1;
        rev.push((Op::Del, a[x]));
    }
    while y > 0 {
        y -= 1;
        rev.push((Op::Ins, b[y]));
    }

    // Canonicalize each hunk to deletions before insertions (see module doc).
    let mut dels = Vec::new();
    let mut inss = Vec::new();
    for &(op, item) in rev.iter().rev() {
        match op {
            Op::Del => dels.push(item),
            Op::Ins => inss.push(item),
            Op::Eq => {
                out.extend(dels.drain(..).map(|t| (Op::Del, t)));
                out.extend(inss.drain(..).map(|t| (Op::Ins, t)));
                out.push((Op::Eq, item));
            }
        }
    }
    out.extend(dels.drain(..).map(|t| (Op::Del, t)));
    out.extend(inss.drain(..).map(|t| (Op::Ins, t)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(ops: &[(Op, &str)]) -> String {
        ops.iter()
            .map(|(op, _)| match op {
                Op::Eq => '=',
                Op::Del => '-',
                Op::Ins => '+',
            })
            .collect()
    }

    /// Concatenating the Eq+Del ops rebuilds a; Eq+Ins rebuilds b.
    fn assert_reconstructs(a: &[&str], b: &[&str], ops: &[(Op, &str)]) {
        let left: Vec<&str> = ops
            .iter()
            .filter(|(op, _)| *op != Op::Ins)
            .map(|&(_, t)| t)
            .collect();
        let right: Vec<&str> = ops
            .iter()
            .filter(|(op, _)| *op != Op::Del)
            .map(|&(_, t)| t)
            .collect();
        assert_eq!(left, a);
        assert_eq!(right, b);
    }

    #[test]
    fn empty_inputs() {
        assert!(diff_slices(&[], &[]).is_empty());
        assert_eq!(diff_slices(&[], &["a"]), vec![(Op::Ins, "a")]);
        assert_eq!(diff_slices(&["a"], &[]), vec![(Op::Del, "a")]);
    }

    #[test]
    fn identical_inputs_are_all_eq() {
        let ops = diff_slices(&["a", "b", "c"], &["a", "b", "c"]);
        assert_eq!(kinds(&ops), "===");
    }

    #[test]
    fn trims_prefix_and_suffix_and_orders_del_before_ins() {
        let ops = diff_slices(&["a", "b", "c"], &["a", "x", "c"]);
        assert_eq!(
            ops,
            vec![(Op::Eq, "a"), (Op::Del, "b"), (Op::Ins, "x"), (Op::Eq, "c")]
        );
    }

    #[test]
    fn all_different_is_del_run_then_ins_run() {
        let ops = diff_slices(&["a", "b"], &["x", "y", "z"]);
        assert_eq!(kinds(&ops), "--+++");
        assert_reconstructs(&["a", "b"], &["x", "y", "z"], &ops);
    }

    #[test]
    fn hunks_are_canonicalized_del_before_ins() {
        // A path that interleaves edits around the "c"/"q" matches must still
        // come out with each hunk's deletions first.
        let a = ["a", "c", "b", "q", "z"];
        let b = ["c", "d", "q", "w"];
        let ops = diff_slices(&a, &b);
        assert_reconstructs(&a, &b, &ops);
        for pair in ops.windows(2) {
            assert!(!(pair[0].0 == Op::Ins && pair[1].0 == Op::Del));
        }
        // Minimal: 3 deletions, 2 insertions.
        let edits = ops.iter().filter(|(op, _)| *op != Op::Eq).count();
        assert_eq!(edits, 5);
    }

    #[test]
    fn finds_a_minimal_diff_on_ambiguous_input() {
        // LCS("abab", "baba") has length 3; a minimal diff is 2 edits.
        let a = ["a", "b", "a", "b"];
        let b = ["b", "a", "b", "a"];
        let ops = diff_slices(&a, &b);
        assert_reconstructs(&a, &b, &ops);
        let edits = ops.iter().filter(|(op, _)| *op != Op::Eq).count();
        assert_eq!(edits, 2);
    }

    #[test]
    fn capped_search_degrades_to_del_all_then_ins_all() {
        // Forces the give-up fallback in `middle_capped` through the
        // crate-internal cap parameter. Through the public API the branch
        // needs an input with more than MAX_D = 2048 edits (covered by the
        // full-size test in tests/properties.rs), and the never-found case
        // it also guards cannot be forced at all: round n + m always
        // reaches (n, m). The tiny cap runs the identical fallback code.
        let a = ["a", "b", "c"];
        let b = ["x", "y"];
        let mut ops = Vec::new();
        middle_capped(&a, &b, &mut ops, 1); // true D is 5
        assert_eq!(kinds(&ops), "---++");
        assert_reconstructs(&a, &b, &ops);
    }

    #[test]
    fn cap_boundary_is_exact() {
        // This pair's minimal diff is D = 2 (delete "a", insert "d").
        let a = ["a", "c"];
        let b = ["c", "d"];

        // At the cap: still the minimal diff.
        let mut minimal = Vec::new();
        middle_capped(&a, &b, &mut minimal, 2);
        assert_eq!(minimal, vec![(Op::Del, "a"), (Op::Eq, "c"), (Op::Ins, "d")]);

        // One below: degraded, counts honest, reconstruction intact.
        let mut degraded = Vec::new();
        middle_capped(&a, &b, &mut degraded, 1);
        assert_eq!(kinds(&degraded), "--++");
        assert_reconstructs(&a, &b, &degraded);
    }

    #[test]
    fn repeated_lines_stay_minimal() {
        // Blank-line-heavy inputs are the classic ambiguity source.
        let a = ["x", "", "y", "", "z"];
        let b = ["x", "", "w", "", "z", "", "q"];
        let ops = diff_slices(&a, &b);
        assert_reconstructs(&a, &b, &ops);
        let edits = ops.iter().filter(|(op, _)| *op != Op::Eq).count();
        assert_eq!(edits, 4);
    }
}
