//! Regression-guard benchmarks for the `diff()` entry point (this is NOT the
//! marketing benchmark; that ships separately per the pre-launch checklist).
//! Run with `cargo bench -p diffwtf-core`. Three shapes:
//!
//! - sample: the bundled "Load example" pair, the hot path every visitor hits.
//! - large-perf: the committed 5 000-line fixture (real edit zone, long
//!   common prefix/suffix), the realistic big-input path.
//! - worst-case: 2 000 vs 2 000 lines with nothing in common, forcing the
//!   full O((n + m) * D) pass with D = n + m plus the O(D^2)-word trace
//!   (see src/myers.rs for the memory bound).

use criterion::{criterion_group, criterion_main, Criterion};
use diffwtf_core::{diff, Granularity};
use std::hint::black_box;

const SAMPLE_LEFT: &str = include_str!("../../../fixtures/cases/sample-rust.left.txt");
const SAMPLE_RIGHT: &str = include_str!("../../../fixtures/cases/sample-rust.right.txt");
const LARGE_LEFT: &str = include_str!("../../../fixtures/cases/large-perf.left.txt");
const LARGE_RIGHT: &str = include_str!("../../../fixtures/cases/large-perf.right.txt");

/// Two inputs of `lines` lines each sharing no line at all: every left line
/// is deleted and every right line inserted, the Myers worst case.
fn worst_case(lines: usize) -> (String, String) {
    let left: Vec<String> = (0..lines).map(|i| format!("left {i} alpha beta")).collect();
    let right: Vec<String> = (0..lines)
        .map(|i| format!("right {i} gamma delta"))
        .collect();
    (left.join("\n"), right.join("\n"))
}

fn bench_diff(c: &mut Criterion) {
    c.bench_function("sample_word", |b| {
        b.iter(|| {
            diff(
                black_box(SAMPLE_LEFT),
                black_box(SAMPLE_RIGHT),
                Granularity::Word,
            )
        })
    });
    c.bench_function("sample_char", |b| {
        b.iter(|| {
            diff(
                black_box(SAMPLE_LEFT),
                black_box(SAMPLE_RIGHT),
                Granularity::Char,
            )
        })
    });

    let mut large = c.benchmark_group("large");
    large.sample_size(20);
    large.bench_function("large_perf_5k_word", |b| {
        b.iter(|| {
            diff(
                black_box(LARGE_LEFT),
                black_box(LARGE_RIGHT),
                Granularity::Word,
            )
        })
    });
    let (wc_left, wc_right) = worst_case(2000);
    large.bench_function("worst_case_2k_all_different_word", |b| {
        b.iter(|| diff(black_box(&wc_left), black_box(&wc_right), Granularity::Word))
    });
    large.finish();
}

criterion_group!(benches, bench_diff);
criterion_main!(benches);
