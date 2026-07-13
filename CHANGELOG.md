# Changelog

All notable changes to `diffwtf-core` are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the crate
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-13

First real release (replaces the 0.0.1 crates.io name reservation).

### Added

- `diff(left, right, granularity) -> DiffResult`: Myers O(ND) line-level diff
  with hunk pairing, token-level intra-line refinement (`Word` or `Char`
  granularity), and precomputed split and unified views with added/removed
  counts.
- `diff_lines(left, right) -> Vec<LineOp>`: the raw line-level ops without
  intra-line refinement or view assembly.
- `serde` feature: `Serialize` derives on all output types (off by default).
- Conformance test suite against the diff.wtf JS reference implementation,
  plus property tests (reconstructability, minimality, determinism).
