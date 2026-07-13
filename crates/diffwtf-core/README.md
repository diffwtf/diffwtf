# diffwtf-core

Fast, pure-Rust text diff engine: Myers O(ND) line diff with token-level
intra-line refinement. This is the engine behind [diff.wtf](https://diff.wtf),
where it runs as WebAssembly, but the crate itself has no wasm or JS
dependencies: it builds and tests on any target, has no `unsafe`, and does not
panic on any input (empty strings, missing trailing newlines, `\r\n`, emoji,
CJK, and combining characters are all first-class).

```bash
cargo add diffwtf-core
```

## Usage

```rust
use diffwtf_core::{diff, Granularity};

let old_text = "fn greet() {\n    println!(\"hello\");\n}";
let new_text = "fn greet() {\n    println!(\"hello, world\");\n}";

let result = diff(old_text, new_text, Granularity::Word);
assert_eq!((result.added, result.removed), (1, 1));
println!("+{} -{}", result.added, result.removed);
```

`diff` returns a `DiffResult` with everything a renderer needs, precomputed
for both a split (side-by-side) view and a unified view:

```text
DiffResult {
    rows: Vec<SplitRow>,        // split view: Equal | Delete | Insert | Modify,
                                //   each side an Option<LineCell> (None = missing side)
    unified: Vec<UnifiedRow>,   // unified view: within a hunk, deletes precede inserts
    added: u32,                 // inserted line count
    removed: u32,               // deleted line count
    line_count: u32,            // max(left lines, right lines)
}
```

Line content arrives as `Vec<Segment>`, where each segment is a run of text
with a `highlighted` flag: on paired (Modify) lines, deleted and inserted
tokens are highlighted per the chosen `Granularity` (`Word` or `Char`), and
adjacent same-state runs are merged.

If you just want the raw line-level operations without intra-line refinement
or view assembly, use `diff_lines`:

```rust
use diffwtf_core::{diff_lines, LineOpKind};

let ops = diff_lines("a\nb\nc", "a\nx\nc");
assert_eq!(ops[1].kind, LineOpKind::Delete);
assert_eq!(ops[1].text, "b");
assert_eq!((ops[1].old_number, ops[1].new_number), (Some(2), None));
```

Each `LineOp` carries its kind (`Equal`, `Delete`, `Insert`), the line's text,
and 1-based line numbers on both sides (`None` on the missing side).
Concatenating the Equal and Delete ops reconstructs the left input exactly;
Equal and Insert reconstruct the right.

## Features

- `serde`: derives `Serialize` on all output types (off by default).

## More

- Live tool: [diff.wtf](https://diff.wtf), the engine compiled to WebAssembly
  in a static page, where your text never leaves the browser.
- Source, conformance fixtures, and issue tracker:
  [github.com/diffwtf/diffwtf](https://github.com/diffwtf/diffwtf)

MIT licensed.
