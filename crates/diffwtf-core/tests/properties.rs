//! Property tests for the Myers line-level engine. Hand-rolled xorshift
//! generator instead of a proptest dependency: fully deterministic (fixed
//! seed, so failures reproduce by rerunning), zero dev-dependency weight, and
//! the input space here is simple enough that generator combinators buy
//! nothing. Flagged in the M4 PR as an interpretation call.
//!
//! For each generated input pair, at both granularities:
//!
//! - every contract invariant holds (tests/common/mod.rs), which includes
//!   byte-exact reconstructability of both inputs from both views;
//! - added/removed match a naive count: an independent LCS DP over the line
//!   arrays gives removed = left_lines - lcs, added = right_lines - lcs.
//!   Myers claims minimality, so this is an equality, not a bound;
//! - the result is deterministic across runs.

mod common;

use common::{assemble, check_invariants, check_sparse_invariants};
use diffwtf_core::{
    diff, diff_lines, diff_sparse, DiffResult, Granularity, LineOpKind, RowKind, SparseDiff,
};

/// xorshift64: deterministic, seedable, good enough for test-input shuffling.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// Uniform-enough pick in 0..n (n must be nonzero).
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Small, repetition-heavy pool: repeated and empty lines maximize ambiguous
/// diffs (the interesting case for Myers), and the non-ASCII entries keep
/// UTF-8 boundary handling under test.
const POOL: &[&str] = &[
    "",
    "",
    "a",
    "b",
    "a b",
    "fn main() {",
    "}",
    "    let x = 1;",
    "    let x = 2;",
    "🎉 party 🎉",
    "汉字テスト",
    "e\u{301}f",
    "\ttab\tstops",
    "  ",
];

fn random_lines(rng: &mut Rng, max_lines: usize) -> Vec<&'static str> {
    let count = rng.below(max_lines + 1);
    (0..count).map(|_| POOL[rng.below(POOL.len())]).collect()
}

/// Mutate `base` line-wise (keep/drop/replace/insert) so pairs share real
/// common runs, exercising prefix/suffix trimming and mid-diff snakes.
fn mutate(rng: &mut Rng, base: &[&'static str]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for &line in base {
        match rng.below(10) {
            0 => {}                                     // drop
            1 => out.push(POOL[rng.below(POOL.len())]), // replace
            2 => {
                out.push(line);
                out.push(POOL[rng.below(POOL.len())]); // insert after
            }
            _ => out.push(line), // keep
        }
    }
    out
}

/// Naive LCS length over the line arrays, the independent oracle for the
/// added/removed counts. O(n*m) DP, fine at test sizes.
fn lcs_len(a: &[&str], b: &[&str]) -> u32 {
    let w = b.len() + 1;
    let mut dp = vec![0u32; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            dp[i * w + j] = if a[i] == b[j] {
                dp[(i + 1) * w + j + 1] + 1
            } else {
                dp[(i + 1) * w + j].max(dp[i * w + j + 1])
            };
        }
    }
    dp[0]
}

/// diff_lines contract: byte-exact reconstructability of both inputs, strictly
/// sequential 1-based numbering per side, dels-before-inss hunk ordering, and
/// (outside the whitespace-only empty state, where diff() zeroes its counts by
/// design) op counts equal to diff()'s added/removed.
fn check_diff_lines(label: &str, left: &str, right: &str) {
    let ops = diff_lines(left, right);

    let mut old_texts = Vec::new();
    let mut new_texts = Vec::new();
    let (mut ln, mut rn) = (1u32, 1u32);
    let mut prev_was_insert = false;
    for op in &ops {
        match op.kind {
            LineOpKind::Equal => {
                assert_eq!(
                    (op.old_number, op.new_number),
                    (Some(ln), Some(rn)),
                    "{label}: equal op numbering"
                );
                old_texts.push(op.text.as_str());
                new_texts.push(op.text.as_str());
                ln += 1;
                rn += 1;
                prev_was_insert = false;
            }
            LineOpKind::Delete => {
                assert_eq!(
                    (op.old_number, op.new_number),
                    (Some(ln), None),
                    "{label}: delete op numbering"
                );
                assert!(
                    !prev_was_insert,
                    "{label}: delete after insert within a hunk"
                );
                old_texts.push(op.text.as_str());
                ln += 1;
            }
            LineOpKind::Insert => {
                assert_eq!(
                    (op.old_number, op.new_number),
                    (None, Some(rn)),
                    "{label}: insert op numbering"
                );
                new_texts.push(op.text.as_str());
                rn += 1;
                prev_was_insert = true;
            }
        }
    }
    assert_eq!(old_texts.join("\n"), left, "{label}: left reconstruction");
    assert_eq!(new_texts.join("\n"), right, "{label}: right reconstruction");

    if !(left.trim().is_empty() && right.trim().is_empty()) {
        let result = diff(left, right, Granularity::Word);
        let dels = ops.iter().filter(|o| o.kind == LineOpKind::Delete).count() as u32;
        let inss = ops.iter().filter(|o| o.kind == LineOpKind::Insert).count() as u32;
        assert_eq!(dels, result.removed, "{label}: delete count vs diff()");
        assert_eq!(inss, result.added, "{label}: insert count vs diff()");
    }
}

fn check_case(case: usize, left_lines: &[&str], right_lines: &[&str]) {
    let left = left_lines.join("\n");
    let right = right_lines.join("\n");
    check_diff_lines(&format!("case {case} (diff_lines)"), &left, &right);
    for (granularity, gran_name) in [(Granularity::Word, "word"), (Granularity::Char, "char")] {
        let label = format!("case {case} ({gran_name}) left={left:?} right={right:?}");
        let result = diff(&left, &right, granularity);

        assert_eq!(
            result,
            diff(&left, &right, granularity),
            "{label}: nondeterministic"
        );

        let sparse = diff_sparse(&left, &right, granularity);

        if left.trim().is_empty() && right.trim().is_empty() {
            assert_eq!(result, DiffResult::default(), "{label}: empty state");
            assert_eq!(sparse, SparseDiff::default(), "{label}: empty sparse state");
            continue;
        }
        check_invariants(&label, &left, &right, &result);
        check_sparse_invariants(&label, &left, &right, &sparse);
        assert_eq!(
            assemble(&left, &right, &sparse),
            result,
            "{label}: sparse reassembly differs from diff()"
        );

        // Note: joining zero lines and joining one empty line both make "",
        // so split('\n') is the honest recount of what diff() saw.
        let n: Vec<&str> = left.split('\n').collect();
        let m: Vec<&str> = right.split('\n').collect();
        let lcs = lcs_len(&n, &m);
        assert_eq!(
            result.removed,
            n.len() as u32 - lcs,
            "{label}: removed is not minimal"
        );
        assert_eq!(
            result.added,
            m.len() as u32 - lcs,
            "{label}: added is not minimal"
        );
    }
}

#[test]
fn random_pairs_hold_all_invariants_and_stay_minimal() {
    let mut rng = Rng(0x5eed_d1ff_0000_0001);
    for case in 0..300 {
        let left = random_lines(&mut rng, 30);
        let right = if case % 2 == 0 {
            // Related pair: common runs, realistic hunks.
            mutate(&mut rng, &left)
        } else {
            // Unrelated pair: ambiguity and worst-case-shaped paths.
            random_lines(&mut rng, 30)
        };
        check_case(case, &left, &right);
    }
}

#[test]
fn depth_cap_degrades_but_stays_honest_and_reconstructable() {
    // Exceeds the MAX_D = 2048 search depth cap in src/myers.rs through the
    // public API: 1200 unrelated lines per side plus one shared line buried
    // at different offsets makes the minimal diff D = 2 * 1201 - 2 = 2400.
    // Past the cap the trimmed middle degrades to del-all then ins-all, so
    // the shared middle line is NOT matched, while the shared prefix and
    // suffix lines still trim to Equal rows.
    let build = |side: &str, shared_at: usize| -> String {
        let mut lines = vec!["shared prefix".to_string()];
        lines.extend((0..1200).map(|i| format!("{side} only {i}")));
        lines.insert(shared_at, "shared middle".to_string());
        lines.push("shared suffix".to_string());
        lines.join("\n")
    };
    let left = build("left", 601);
    let right = build("right", 350);

    let result = diff(&left, &right, Granularity::Word);
    // Reconstructability and every other contract invariant.
    check_invariants("depth-cap", &left, &right, &result);

    // Degraded counts: all 1201 middle lines on each side, not the minimal
    // 1200 (a minimal diff would match "shared middle" and produce a third
    // Equal row; the count difference is what proves the cap triggered).
    assert_eq!(result.removed, 1201);
    assert_eq!(result.added, 1201);

    // Degraded shape: Equal prefix row, one Modify run (the equal-length
    // del and ins runs pair index-wise), Equal suffix row.
    assert_eq!(result.rows.len(), 1203);
    assert_eq!(result.rows.first().unwrap().kind, RowKind::Equal);
    assert_eq!(result.rows.last().unwrap().kind, RowKind::Equal);
    assert!(result.rows[1..1202]
        .iter()
        .all(|r| r.kind == RowKind::Modify));
}

#[test]
fn adversarial_shapes_hold_all_invariants_and_stay_minimal() {
    // Deliberate corner shapes that random sampling can miss.
    let ab: Vec<&str> = ["a", "b"].into_iter().cycle().take(40).collect();
    let ba: Vec<&str> = ["b", "a"].into_iter().cycle().take(40).collect();
    let cases: Vec<(Vec<&str>, Vec<&str>)> = vec![
        (vec![], vec!["x"]),
        (vec!["x"], vec![]),
        (vec![""], vec!["x"]),
        (ab, ba),                                   // maximal ambiguity
        (vec![""; 25], vec!["x"]),                  // trim-empty left vs content
        (vec!["x"; 30], vec!["y"; 30]),             // nothing in common
        (vec!["p", "q"], vec!["p", "p", "q", "q"]), // repeated boundaries
    ];
    for (case, (left, right)) in cases.into_iter().enumerate() {
        check_case(1000 + case, &left, &right);
    }
}
