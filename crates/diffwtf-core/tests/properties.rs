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

use common::check_invariants;
use diffwtf_core::{diff, DiffResult, Granularity};

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

fn check_case(case: usize, left_lines: &[&str], right_lines: &[&str]) {
    let left = left_lines.join("\n");
    let right = right_lines.join("\n");
    for (granularity, gran_name) in [(Granularity::Word, "word"), (Granularity::Char, "char")] {
        let label = format!("case {case} ({gran_name}) left={left:?} right={right:?}");
        let result = diff(&left, &right, granularity);

        assert_eq!(
            result,
            diff(&left, &right, granularity),
            "{label}: nondeterministic"
        );

        if left.trim().is_empty() && right.trim().is_empty() {
            assert_eq!(result, DiffResult::default(), "{label}: empty state");
            continue;
        }
        check_invariants(&label, &left, &right, &result);

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
