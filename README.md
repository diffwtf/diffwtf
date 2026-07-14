# diff.wtf

[![CI](https://github.com/diffwtf/diffwtf/actions/workflows/ci.yml/badge.svg)](https://github.com/diffwtf/diffwtf/actions/workflows/ci.yml)

**Fast, private diffs in your browser.** A client-side text/file diff checker powered by
Rust → WebAssembly. Your comparison text is never uploaded.

## What's in this repo

| Path | What it is |
|---|---|
| `crates/diffwtf-core` | The diff engine: Myers line diff + intra-line refinement. Pure Rust, no wasm deps, published to [crates.io](https://crates.io/crates/diffwtf-core). MIT. |
| `crates/diffwtf-wasm` | Thin wasm-bindgen wrapper around the core. Never published; built into `web/pkg`. |
| `web/` | The static site (diff.wtf): vanilla HTML/CSS/JS, no framework, no bundler. |
| `reference/` | JS reference implementation of the diff algorithm — defines expected engine behavior. |
| `fixtures/` | Conformance cases + expected outputs shared by the reference and the Rust test suite. |
| `docs/` | The design handoff (UI source of truth) and the engineering scaffold spec. |

## Using the engine in your own project

```bash
cargo add diffwtf-core
```

```rust
use diffwtf_core::{diff, Granularity};

let old_text = "fn greet() {\n    println!(\"hello\");\n}";
let new_text = "fn greet() {\n    println!(\"hello, world\");\n}";

let result = diff(old_text, new_text, Granularity::Word);
assert_eq!((result.added, result.removed), (1, 1));
println!("+{} -{}", result.added, result.removed);
```

This example is compiled and run on every `cargo test`: it is the crate README's doctest
(the crate README is the crate's rustdoc front page). See the crate docs for the full
`DiffResult` structure (split and unified views, per-line segments with intra-line highlight
flags) and for `diff_lines`, the raw line-op API.

## Building the site locally

```bash
cargo test --workspace          # engine + conformance suite
./scripts/build-wasm.sh         # wasm-pack → web/pkg
python3 -m http.server -d web   # wasm won't load from file:// — serve it
```

## Why it's fast

The diff engine is Rust compiled to WebAssembly, and the site around it is a few KB of
static files. The numbers on the site come from a committed, reproducible benchmark
(`scripts/bench-vs-js.mjs`); the output of a real run is committed alongside it at
`scripts/bench-vs-js.results.txt`. No illustrative numbers.

## Privacy

Your comparison text is processed locally in your tab and never uploaded. See
[diff.wtf/privacy](https://diff.wtf/privacy.html).

## Contributing

Read `CLAUDE.md` (repo operating rules — they apply to humans too) and `docs/scaffold-spec.md`
before opening a PR. One issue, one branch, one PR.

## License

[MIT](LICENSE) — the engine, the wrapper, and the site.
