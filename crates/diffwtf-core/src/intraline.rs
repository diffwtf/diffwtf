//! Token-level refinement of paired (Modify) lines — a 1:1 port of the reference
//! `intraDiff()`/`mergeSegs()` and its tokenizer `\w+|\s+|[^\w\s]`.
//!
//! All slicing happens on `char` boundaries; user text is never byte-indexed.

use crate::lcs::{lcs, Op};
use crate::{Granularity, Segment};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Word,
    Space,
    Other,
}

// JS `\w` is ASCII-only; matching it exactly keeps parity with the reference.
fn classify(c: char) -> Class {
    if c.is_ascii_alphanumeric() || c == '_' {
        Class::Word
    } else if c.is_whitespace() {
        Class::Space
    } else {
        Class::Other
    }
}

pub(crate) fn tokenize(text: &str, granularity: Granularity) -> Vec<&str> {
    match granularity {
        Granularity::Char => text
            .char_indices()
            .map(|(i, c)| &text[i..i + c.len_utf8()])
            .collect(),
        Granularity::Word => {
            let mut out = Vec::new();
            let mut run_start = 0;
            let mut run_class = None;
            for (i, c) in text.char_indices() {
                let class = classify(c);
                // `\w+` and `\s+` extend runs; `[^\w\s]` is one token per char.
                let extends = run_class == Some(class) && class != Class::Other;
                if !extends {
                    if run_class.is_some() {
                        out.push(&text[run_start..i]);
                    }
                    run_start = i;
                }
                run_class = Some(class);
            }
            if run_class.is_some() {
                out.push(&text[run_start..]);
            }
            out
        }
    }
}

/// Merge adjacent tokens with the same highlight state. Unlike the reference,
/// an empty list stays empty (no `' '` placeholder) — the spec's documented
/// deviation; the renderer handles min-height.
pub(crate) fn merge_segs(tokens: &[(&str, bool)]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for &(text, highlighted) in tokens {
        match out.last_mut() {
            Some(last) if last.highlighted == highlighted => last.text.push_str(text),
            _ => out.push(Segment {
                text: text.to_string(),
                highlighted,
            }),
        }
    }
    out
}

pub(crate) fn intra_diff(
    a: &str,
    b: &str,
    granularity: Granularity,
) -> (Vec<Segment>, Vec<Segment>) {
    let ta = tokenize(a, granularity);
    let tb = tokenize(b, granularity);
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (op, text) in lcs(&ta, &tb) {
        match op {
            Op::Eq => {
                left.push((text, false));
                right.push((text, false));
            }
            Op::Del => left.push((text, true)),
            Op::Ins => right.push((text, true)),
        }
    }
    (merge_segs(&left), merge_segs(&right))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text: &str, highlighted: bool) -> Segment {
        Segment {
            text: text.to_string(),
            highlighted,
        }
    }

    #[test]
    fn word_tokenizer_matches_js_classes() {
        assert_eq!(
            tokenize("foo, bar_1", Granularity::Word),
            vec!["foo", ",", " ", "bar_1"]
        );
        // Punctuation is one token per char.
        assert_eq!(
            tokenize("a++b", Granularity::Word),
            vec!["a", "+", "+", "b"]
        );
        // JS \w is ASCII-only: é falls into [^\w\s] and splits the word.
        assert_eq!(tokenize("héllo", Granularity::Word), vec!["h", "é", "llo"]);
        assert!(tokenize("", Granularity::Word).is_empty());
    }

    #[test]
    fn char_tokenizer_splits_on_scalar_boundaries() {
        assert_eq!(tokenize("a🎉漢", Granularity::Char), vec!["a", "🎉", "漢"]);
        // Combining mark is its own scalar.
        assert_eq!(
            tokenize("e\u{301}", Granularity::Char),
            vec!["e", "\u{301}"]
        );
    }

    #[test]
    fn merge_segs_merges_adjacent_same_state() {
        assert_eq!(
            merge_segs(&[("a", false), ("b", false), ("c", true)]),
            vec![seg("ab", false), seg("c", true)]
        );
        assert!(merge_segs(&[]).is_empty());
    }

    #[test]
    fn intra_diff_char_granularity() {
        let (left, right) = intra_diff("abc", "axc", Granularity::Char);
        assert_eq!(left, vec![seg("a", false), seg("b", true), seg("c", false)]);
        assert_eq!(
            right,
            vec![seg("a", false), seg("x", true), seg("c", false)]
        );
    }
}
