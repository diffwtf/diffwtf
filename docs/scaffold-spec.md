# diff.wtf — Engineering Scaffold Spec (handoff to Claude Code)

Companion to the design handoff bundle (`design_handoff_diff_wtf/`). The design README defines
**what** to build (pixel-perfect UI, behavior, algorithm contract). This document defines **how
the repo is organized and built**. Where the two conflict, the design README wins on
look/behavior; this spec wins on structure.

## Context / decisions already made

- **Repo:** `github.com/diffwtf/diffwtf` — single monorepo, **private until pre-launch**, then
  flipped public. Commit as if public from day one (no secrets — there are none by design).
- **Crate names reserved on crates.io** (v0.0.1 placeholders already published by the owner):
  - `diffwtf-core` — the real library; next publish is `0.1.0` from this repo.
  - `diffwtf` — brand reservation / future CLI. **Not part of v1.** Leave the placeholder alone.
- **License:** MIT (footer says "MIT-licensed engine"). Add `LICENSE` at repo root.
- **No frameworks, no bundlers.** The site is static HTML/CSS/vanilla-JS ES modules + one
  wasm-pack output. This is a product requirement (the pitch is being lightweight), not a
  preference.

## Repository layout

```
diffwtf/
├── Cargo.toml                  # workspace root (virtual manifest)
├── LICENSE                     # MIT
├── README.md                   # project readme: what it is, links to site/crate, build instructions
├── .gitignore                  # target/, web/pkg/, node_modules/ (if any tooling), .DS_Store
├── crates/
│   ├── diffwtf-core/           # pure Rust engine — published to crates.io
│   │   ├── Cargo.toml
│   │   ├── src/lib.rs          # public API + types
│   │   ├── src/myers.rs        # line-level diff
│   │   ├── src/intraline.rs    # token-level refinement
│   │   └── tests/conformance.rs
│   └── diffwtf-wasm/           # wasm-bindgen wrapper — NEVER published (publish = false)
│       ├── Cargo.toml
│       └── src/lib.rs
├── fixtures/                   # conformance fixtures shared by JS reference and Rust tests
│   ├── cases/                  # input pairs: {name}.left.txt / {name}.right.txt
│   └── expected/               # {name}.{word|char}.json — semantic diff output
├── reference/
│   └── refdiff.mjs             # JS reference implementation (ported from prototype) + fixture generator
├── web/                        # the static site — deployable directory as-is
│   ├── index.html              # tool + landing (from Diff Checker design)
│   ├── privacy.html
│   ├── css/site.css
│   ├── js/app.js               # state, events, timing (vanilla ES module)
│   ├── js/assemble.js          # rebuilds renderable rows from the sparse v2 result (M9)
│   ├── js/render.js            # DOM builders for the split/unified views (M9)
│   ├── og-card.png             # rendered from the design's OG card (1200×630)
│   ├── _headers                # Cloudflare Pages cache policy: no-cache on everything (D7)
│   └── pkg/                    # wasm-pack output — GITIGNORED, built by CI/local script
├── scripts/
│   ├── build-wasm.sh           # wasm-pack build crates/diffwtf-wasm --target web --out-dir ../../web/pkg --release
│   └── gen-fixtures.mjs        # runs reference/refdiff.mjs over fixtures/cases → fixtures/expected
└── .github/workflows/
    ├── ci.yml                  # gates + wasm build on every push/PR; on main pushes the same
    │                           #   tested artifact deploys to Cloudflare Pages with smoke tests (D7)
    └── publish.yml             # cargo publish -p diffwtf-core on version tags (manual approval fine)
```

## Root `Cargo.toml`

```toml
[workspace]
resolver = "2"
members = ["crates/diffwtf-core", "crates/diffwtf-wasm"]

[workspace.package]
edition = "2021"
license = "MIT"
repository = "https://github.com/diffwtf/diffwtf"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
```

## `crates/diffwtf-core`

```toml
[package]
name = "diffwtf-core"
version = "0.1.0"
description = "Fast Myers diff engine with intra-line refinement — powers diff.wtf"
keywords = ["diff", "myers", "text", "wasm"]
categories = ["text-processing", "algorithms"]
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
serde = { version = "1", features = ["derive"], optional = true }

[features]
default = []
serde = ["dep:serde"]
```

Rules:

- **Zero wasm/JS dependencies.** Must build and test on any target with plain `cargo test`.
- `serde` derive is behind a feature flag so plain library users don't pull it in; the wasm
  wrapper enables it.
- No `unsafe`. No panics on any input (fuzz-friendly); empty strings, no-trailing-newline,
  mixed line endings, and multi-byte UTF-8 (emoji, CJK) are all first-class inputs.

### Public API (the contract — types are the product)

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Granularity { Word, Char }

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
    pub number: u32,           // 1-based line number on that side
    pub segments: Vec<Segment>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "lowercase"))]
pub enum RowKind { Equal, Delete, Insert, Modify }

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
pub enum UnifiedKind { Equal, Delete, Insert }

/// Unified-view row. Within a changed hunk, ALL deleted lines precede ALL inserted lines
/// (matches the prototype and standard unified-diff convention).
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct UnifiedRow {
    pub kind: UnifiedKind,
    pub old_number: Option<u32>,   // None on inserted lines
    pub new_number: Option<u32>,   // None on deleted lines
    pub segments: Vec<Segment>,
}

#[derive(Clone, PartialEq, Debug, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct DiffResult {
    pub rows: Vec<SplitRow>,
    pub unified: Vec<UnifiedRow>,
    pub added: u32,        // inserted line count
    pub removed: u32,      // deleted line count
    pub line_count: u32,   // max(left lines, right lines) — feeds the "{lines} lines" badge
}

/// The one entry point.
pub fn diff(left: &str, right: &str, granularity: Granularity) -> DiffResult;
```

Notes on the contract:

- **Timing is NOT in the result.** The prototype measured `ms` inside `compute`; in production
  the perf badge must report real user-perceived cost, so **JS measures** with
  `performance.now()` around the wasm call (includes serialization — honest number).
- Styles/colors are presentation and live only in the web layer. The engine emits semantics
  (`kind`, `highlighted`); `app.js` maps them to the design's classes.
- Both views are returned in one call because the UI's Split/Unified toggle re-renders without
  recompute; duplication cost is trivial and it keeps conformance testing 1:1 with the reference.
- Since M9, `DiffResult` remains the crate contract but is no longer what crosses the wasm
  boundary; the site uses the sparse v2 boundary below and reassembles the same views in JS.
  The crate additionally exposes `diff_sparse` (see "Wasm boundary contract v2").

### Algorithm requirements (behavioral parity with the JS reference)

The prototype's `compute`/`lcs`/`intraDiff` (in `Diff Checker.dc.html`, ~lines 230–330) are the
source of truth for behavior:

1. **Line-level diff:** split both inputs on `\n`; trim common prefix and suffix; diff the middle.
   The reference uses an LCS DP table with a >600 000-cell bailout to naive del-all/ins-all.
   The Rust engine should implement **proper Myers O(ND)** and does not need the bailout for
   correctness — but see "conformance vs. improvement" below.
2. **Hunk pairing:** consecutive `del` run followed by consecutive `ins` run forms a hunk; pair
   `dels[k]` with `inss[k]` index-wise as _Modify_ rows; leftover dels/inss become pure
   Delete/Insert rows.
3. **Intra-line refinement** on Modify pairs only: tokenize by granularity —
   `Char` → per **char** (the reference splits JS-string-wise; Rust should split on
   **grapheme-safe char boundaries**, see UTF-8 note), `Word` → regex classes
   `\w+ | \s+ | [^\w\s]` (one token per punctuation char); LCS the token streams; equal tokens
   → `highlighted: false` on both sides, del tokens → highlighted on left, ins tokens →
   highlighted on right; **merge adjacent segments with the same highlight state**.
4. Empty-vs-empty (both sides trim to "") → `DiffResult::default()` (UI shows the empty state).
5. A line's empty content still renders: reference substitutes a single space for empty text.
   Decision for Rust: emit the true empty segment list and let the renderer handle min-height —
   the renderer already sets `min-height: 20px`. Record this as an intentional, documented
   deviation in the fixtures generator (normalize before compare).

**Conformance vs. improvement:** Myers and the reference's LCS can legitimately produce
different-but-equally-minimal diffs on ambiguous inputs. Handle this explicitly:

- Fixtures assert **exact output** for cases where any minimal diff is unambiguous (the bulk).
- For ambiguous cases, assert **invariants** instead: added/removed counts, reconstructability
  (concatenating left-side content = left input; right-side = right input), hunk ordering rules,
  and segment-merge correctness.
- The bundled example texts (`sampleA`/`sampleB` Rust snippets in the prototype) MUST be a
  fixture — they're the first thing every user sees via "Load example", so their rendering must
  match the design exactly.

### UTF-8 correctness (the classic Rust-vs-JS trap)

The JS reference operates on UTF-16 code units; Rust `&str` is UTF-8. Requirements:

- Never slice at non-char boundaries (no byte indexing into user text).
- `Char` granularity tokenizes on `char` (Unicode scalar) at minimum; graphemes are a
  nice-to-have (would need `unicode-segmentation` — acceptable dependency if chosen).
- Word regex semantics: implement the `\w+|\s+|[^\w\s]` classes over chars without pulling in
  the full `regex` crate if a simple hand-rolled classifier suffices (keeps wasm binary small).
- Fixtures MUST include emoji, CJK, combining characters, and mixed-ending (`\r\n`) cases.
  Decide and document `\r\n` handling: recommend treating `\r` as line content (what the
  reference does implicitly) for v1 — simplest and honest.

## `crates/diffwtf-wasm`

```toml
[package]
name = "diffwtf-wasm"
version = "0.1.0"
publish = false
edition.workspace = true
license.workspace = true

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
diffwtf-core = { path = "../diffwtf-core" }
wasm-bindgen = "0.2"
js-sys = "0.3"
```

The wrapper exposes `compute(left, right, granularity)` returning the sparse v2 boundary
object below, plus `compute_probe` (same computation, returns only a checksum) for the phased
benchmark. See `crates/diffwtf-wasm/src/lib.rs` for the shape documentation.

### Wasm boundary contract v2 (M9)

Motivation (issue #9): v1 marshalled the full `DiffResult`, both views, every Equal row,
through serde-wasm-bindgen, one JS object at a time. Transfer cost scaled with document size
and dominated end-to-end time on large inputs. The v2 boundary scales with the number of
edits instead, and the web layer derives the views from the ops plus the two original input
strings it already holds.

Core-side API (pure Rust, serde-serializable behind the `serde` feature; `diff()` and
`diff_lines()` are unchanged):

```rust
/// A maximal run of equal, deleted, or inserted lines.
/// old_start/new_start are 0-based line indices (inputs split on '\n');
/// both cursors advance monotonically and are recorded on every run.
pub struct OpRun {
    pub kind: LineOpKind,   // Equal | Delete | Insert
    pub old_start: u32,
    pub new_start: u32,
    pub old_lines: u32,     // 0 on Insert runs
    pub new_lines: u32,     // 0 on Delete runs
}

/// Half-open highlighted range within one line, in UTF-16 code units
/// (JS string indexing; this type exists for the boundary).
pub struct Span { pub start: u32, pub end: u32 }

/// Per Modify row: highlighted ranges on the deleted and inserted line.
pub struct RowHighlights { pub left: Vec<Span>, pub right: Vec<Span> }

pub struct SparseDiff {
    pub ops: Vec<OpRun>,
    pub highlights: Vec<RowHighlights>, // one per Modify row, stream order
    pub added: u32,
    pub removed: u32,
    pub line_count: u32,
}

pub fn diff_sparse(left: &str, right: &str, granularity: Granularity) -> SparseDiff;
```

Semantics:

- A Delete run directly followed by an Insert run is one hunk; view assembly pairs the first
  `min(old_lines, new_lines)` lines index-wise as Modify rows, which consume `highlights` in
  stream order. Within a hunk all deletions precede all insertions, as in v1.
- Reassembling rows from a `SparseDiff` plus the two inputs reproduces `diff()` exactly. The
  Rust suite asserts this with its own assembler (tests/common/mod.rs); the JS suite asserts
  it for the shipped assembler (scripts/conformance-web.mjs against web/js/assemble.js).
- Both trim-empty inputs return `SparseDiff::default()` (the UI empty state), like `diff()`.
- Identical-input fast path: when `left == right` (byte equality), the result is a single
  Equal run without running the diff. The output is identical to the full path's; it is a
  product optimization and is disclosed in the benchmark methodology, never used to support
  an engine-speed claim.

Across the boundary, `compute()` returns the struct-of-arrays encoding as a plain JS object
of parallel typed arrays (field names match the serde output of the core types):

```text
{
  kind:       Uint8Array,   // per op: 0 equal, 1 delete, 2 insert
  old_start:  Uint32Array,  new_start: Uint32Array,
  old_lines:  Uint32Array,  new_lines: Uint32Array,
  hl_counts:  Uint32Array,  // per Modify row: left span count, right span count
  hl_ranges:  Uint32Array,  // flattened [start, end) pairs, UTF-16 code units
  added: number, removed: number, line_count: number
}
```

`web/js/assemble.js` rebuilds the v1-shaped result (rows, unified, counts) from this plus the
original strings; `web/js/render.js` renders it. The perf badge times the wasm call PLUS the
assembly, since renderable rows only exist after both (honest user-perceived number).

Conformance: `fixtures/expected/{name}.{word,char}.ops.json` hold the reference-derived
sparse output (refdiff's `sparseFromResult`, a pure re-encoding of the reference result, so
the two fixture tiers cannot disagree). The Rust suite checks `diff_sparse` against them
under the same exact-vs-invariant policy; `scripts/conformance-web.mjs` (run in CI after the
wasm build) checks the built wasm boundary and the shipped JS assembler against both tiers.

Build (also in `scripts/build-wasm.sh`):

```bash
wasm-pack build crates/diffwtf-wasm --target web --release --out-dir ../../web/pkg
```

`--target web` emits a browser-native ES module — no bundler. Keep an eye on `.wasm` size;
`lto = true`, `opt-level` and optionally `wasm-opt` (wasm-pack runs it by default) should land
it comfortably under ~100 KB for an engine this size. Size is marketing here.

## `web/` — the shell

- Recreate `standalone/diff-checker.html` and `privacy.html` per the design README
  (high-fidelity: tokens, copy, and interactions are final). Extract inline styles into
  `css/site.css`; keep HTML semantic.
- `js/app.js` owns: state (`left, right, view, granularity, dragOverL/R, computed`), event
  wiring (input, drag/drop with dragleave, toggles, Load example, Clear), and timing
  measurement. Since M9, view construction lives in `js/assemble.js` (sparse v2 result plus
  originals to renderable rows) and the DOM builders in `js/render.js` (split 4-col grid /
  unified 3-col grid, exactly per design); app.js calls both.
- **Live diff on every input** — no debounce initially; add only if profiling demands.
- The two sample texts from the prototype ship verbatim as the "Load example" content.
- Ad slot: markup present, hidden by default (matches design tweak `showAds=false`).
  PRO buttons: visual teasers, non-functional.
- Rendering safety: all diff text goes into the DOM via `textContent`/text nodes —
  **never innerHTML with user content**.
- Escape hatch while WASM loads: buttons disabled + perf badge "loading engine…", flipping to
  "ready · engine loaded" after `init()` resolves.
- `localStorage` persistence of view/granularity: optional, fine to include (design allows it).

## Conformance pipeline

1. `reference/refdiff.mjs`: port the prototype's `lcs/intraDiff/compute` to a dependency-free
   Node ES module that emits the **semantic** shape (the `DiffResult` JSON schema above —
   strip the style objects, keep structure/numbers/segments/highlight flags).
2. `fixtures/cases/`: start with ~12 cases — the bundled sample pair, identical inputs,
   one-side-empty, pure insert, pure delete, modify-with-word-highlights,
   modify-with-char-highlights, trailing-newline variations, `\r\n` input, emoji/CJK,
   long-common-prefix/suffix, and a large generated file (perf smoke).
3. `scripts/gen-fixtures.mjs` regenerates `fixtures/expected/`. Committed outputs are reviewed
   in PRs like any other code.
4. `crates/diffwtf-core/tests/conformance.rs` loads cases + expected JSON (serde) and asserts
   per the exact-vs-invariant policy above. Since M9 this covers both fixture tiers: the
   materialized `{name}.{gran}.json` against `diff()` and the sparse `{name}.{gran}.ops.json`
   against `diff_sparse()`, plus a reassembly test proving the sparse tier is lossless.
5. `scripts/conformance-web.mjs` (Node, needs `./scripts/build-wasm.sh` first; run by CI) checks
   the built wasm boundary and the shipped `web/js/assemble.js` against both fixture tiers.

## CI (`.github/workflows/`)

- **ci.yml** (push + PR): `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test
--workspace`, then `wasm-pack build` to prove the wasm target compiles, then
  `node scripts/conformance-web.mjs` against the built wasm. Cache cargo.
- **deploy** (a job in ci.yml since the D7 hotfix; the old standalone deploy.yml rebuilt the
  wasm independently of the tested build and is gone): on pushes to main, the ci job uploads
  the built `web/` as an artifact; the deploy job downloads that exact artifact, stamps every
  JS module URL with the deploy's commit SHA (`scripts/stamp-site.mjs`, see D7: the zone
  rewrites .js cache headers, so freshness is URL-keyed instead of header-dependent),
  smoke-tests the stamped artifact headlessly (`scripts/smoke-live.mjs --serve`), deploys it
  to **Cloudflare Pages** (project `diffwtf`), then smoke-tests the live URL, asserting the
  engine links, a diff renders, the HTML revalidates, and the deploy's stamp is live.
  Toolchain versions are pinned in the workflow env block.
- **publish.yml** (tag `core-v*`): `cargo publish -p diffwtf-core`. Requires `CARGO_REGISTRY_TOKEN`
  secret. Manual workflow_dispatch is fine for v1 instead of tag automation.

## Build order (suggested Claude Code milestones)

1. Workspace + core crate skeleton with the contract types and a stub `diff()` → compiles,
   `cargo test` green (empty).
2. Port the reference algorithm 1:1 (LCS version) → make the sample-pair fixture pass.
3. Reference port to Node + fixture generation + full conformance suite green.
4. Upgrade line-level diff to Myers O(ND); keep suite green under the exact/invariant policy.
5. wasm wrapper + build script; smoke-test in a bare HTML page.
6. Build `web/` shell to the design; wire the real engine + timing.
7. CI workflows; OG card render to `web/og-card.png`.
8. Pre-launch pass (below).

## Pre-launch checklist (from the design README + this plan)

- [ ] "Star on GitHub" button + footer GitHub link → `https://github.com/diffwtf/diffwtf`
- [ ] Perf badge wired to real measured ms (JS `performance.now()` around wasm call)
- [ ] Replace the mocked "50–100× faster" bar chart numbers with a **real, reproducible
      benchmark** (commit the benchmark script; link it from the section)
- [ ] Render OG card design → `og-card.png`, add OG/Twitter meta tags to `index.html`
- [ ] Privacy page live (AdSense prerequisite); ad slot still hidden at launch
- [ ] Flip repo public; verify README, LICENSE, CI badge
- [ ] Publish `diffwtf-core 0.1.0` (replaces the 0.0.1 placeholder; same repo URL)
- [ ] Update the `diffwtf` placeholder crate README to point at `diffwtf-core`
- [ ] Deploy site, attach diff.wtf domain, confirm wasm MIME + HTTPS
- [ ] "API" footer link: no API exists at launch — point it at the GitHub repo or drop it for v1
      (decide; don't ship a dead link)
