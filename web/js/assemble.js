// diff.wtf view assembly: rebuilds the full renderable DiffResult shape
// (rows, unified, counts) from the sparse wasm boundary result plus the two
// original input strings. Since M10 this is a thin materializing loop over
// the lazy row model in rowmodel.js, which is also what the virtualized
// renderers read window by window; keeping one row-construction code path
// means the conformance suite (scripts/conformance-web.mjs against the
// committed fixtures) pins the exact rows the virtualized views show.
//
// The output must equal, field for field, what the engine's materialized
// diff() would have returned; the Rust suite asserts the same equivalence
// for its own mirror of this assembly (tests/common/mod.rs).

import { createRowModel } from './rowmodel.js';

export function assembleDiffResult(left, right, sparse) {
  const model = createRowModel(left, right, sparse);
  const rows = new Array(model.splitCount);
  for (let i = 0; i < model.splitCount; i++) rows[i] = model.splitRow(i);
  const unified = new Array(model.unifiedCount);
  for (let i = 0; i < model.unifiedCount; i++) unified[i] = model.unifiedRow(i);
  return {
    rows,
    unified,
    added: model.added,
    removed: model.removed,
    line_count: model.line_count,
  };
}
