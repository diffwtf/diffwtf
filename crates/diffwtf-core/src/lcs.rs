//! Line/token-level LCS diff — a 1:1 port of the reference `lcs()` in
//! `docs/design-handoff/Diff Checker.dc.html`: common prefix/suffix trimming,
//! an LCS DP table over the middle, and a >600 000-cell bailout to naive
//! del-all/ins-all. Replaced by Myers O(ND) in a later milestone.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Op {
    Eq,
    Del,
    Ins,
}

pub(crate) fn lcs<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(Op, &'a str)> {
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

    if (am.len() as u64) * (bm.len() as u64) > 600_000 {
        for &item in am {
            ops.push((Op::Del, item));
        }
        for &item in bm {
            ops.push((Op::Ins, item));
        }
    } else if !am.is_empty() || !bm.is_empty() {
        let (n, m) = (am.len(), bm.len());
        // dp[i][j] = LCS length of am[i..], bm[j..], stored row-major with width m+1.
        let w = m + 1;
        let mut dp = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                dp[i * w + j] = if am[i] == bm[j] {
                    dp[(i + 1) * w + j + 1] + 1
                } else {
                    dp[(i + 1) * w + j].max(dp[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if am[i] == bm[j] {
                ops.push((Op::Eq, am[i]));
                i += 1;
                j += 1;
            } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
                ops.push((Op::Del, am[i]));
                i += 1;
            } else {
                ops.push((Op::Ins, bm[j]));
                j += 1;
            }
        }
        while i < n {
            ops.push((Op::Del, am[i]));
            i += 1;
        }
        while j < m {
            ops.push((Op::Ins, bm[j]));
            j += 1;
        }
    }

    for &item in &a[a.len() - e..] {
        ops.push((Op::Eq, item));
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_prefix_and_suffix_and_prefers_del_on_ties() {
        let ops = lcs(&["a", "b", "c"], &["a", "x", "c"]);
        assert_eq!(
            ops,
            vec![(Op::Eq, "a"), (Op::Del, "b"), (Op::Ins, "x"), (Op::Eq, "c")]
        );
    }

    #[test]
    fn empty_inputs() {
        assert!(lcs(&[], &[]).is_empty());
        assert_eq!(lcs(&[], &["a"]), vec![(Op::Ins, "a")]);
        assert_eq!(lcs(&["a"], &[]), vec![(Op::Del, "a")]);
    }

    #[test]
    fn bailout_over_600k_cells_emits_del_all_then_ins_all() {
        // 800 × 800 = 640 000 cells > 600 000. b contains a[400], so the DP path
        // would find an Eq; the bailout must not.
        let a_owned: Vec<String> = (0..800).map(|i| format!("a{i}")).collect();
        let mut b_owned: Vec<String> = (0..800).map(|i| format!("b{i}")).collect();
        b_owned[399] = "a400".to_string();
        let a: Vec<&str> = a_owned.iter().map(String::as_str).collect();
        let b: Vec<&str> = b_owned.iter().map(String::as_str).collect();
        let ops = lcs(&a, &b);
        assert_eq!(ops.len(), 1600);
        assert!(ops.iter().all(|(op, _)| *op != Op::Eq));
        assert!(ops[..800].iter().all(|(op, _)| *op == Op::Del));
        assert!(ops[800..].iter().all(|(op, _)| *op == Op::Ins));
    }
}
