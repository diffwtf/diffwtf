// diff.wtf view assembly: rebuilds the renderable DiffResult shape (rows,
// unified, counts) from the sparse wasm boundary result plus the two original
// input strings. The boundary shape is the v2 contract in
// docs/scaffold-spec.md: parallel typed arrays of run-length line ops
// (kind 0 equal, 1 delete, 2 insert; 0-based old_start/new_start line
// indices; old_lines/new_lines run lengths) and a highlight side channel
// carrying [start, end) UTF-16 ranges for Modify rows only.
//
// The output must equal, field for field, what the engine's materialized
// diff() would have returned: scripts/conformance-web.mjs asserts exactly
// that against the committed fixtures, and the Rust suite asserts the same
// equivalence for its own mirror of this assembly (tests/common/mod.rs).
// A delete run directly followed by an insert run is one hunk; its first
// min(old_lines, new_lines) line pairs become Modify rows, which consume the
// highlight channel in stream order.

export function assembleDiffResult(left, right, sparse) {
  const { kind, old_start, new_start, old_lines, new_lines, hl_counts, hl_ranges } = sparse;
  const opCount = kind.length;
  if (
    old_start.length !== opCount || new_start.length !== opCount ||
    old_lines.length !== opCount || new_lines.length !== opCount ||
    hl_counts.length % 2 !== 0 || hl_ranges.length % 2 !== 0
  ) {
    throw new Error('diffwtf: sparse result arrays are inconsistent');
  }

  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const rows = [];
  const unified = [];
  let hlRow = 0; // next Modify row's index into hl_counts pairs
  let hlOff = 0; // next unread offset into hl_ranges

  const plain = (text) => (text === '' ? [] : [{ text, highlighted: false }]);

  // Cut one line into segments from the next `count` highlight ranges.
  // Ranges are sorted, disjoint, and non-adjacent, so segments alternate.
  const segmentsFromSpans = (text, count) => {
    if (count === 0) return plain(text);
    const segments = [];
    let cursor = 0;
    for (let s = 0; s < count; s++) {
      const start = hl_ranges[hlOff];
      const end = hl_ranges[hlOff + 1];
      hlOff += 2;
      if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
      segments.push({ text: text.slice(start, end), highlighted: true });
      cursor = end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
    return segments;
  };

  let i = 0;
  while (i < opCount) {
    if (kind[i] === 0) {
      const baseOld = old_start[i];
      const baseNew = new_start[i];
      const lines = old_lines[i];
      for (let k = 0; k < lines; k++) {
        const oldNumber = baseOld + k + 1;
        const newNumber = baseNew + k + 1;
        const segments = plain(leftLines[baseOld + k]);
        rows.push({
          kind: 'equal',
          left: { number: oldNumber, segments },
          right: { number: newNumber, segments },
        });
        unified.push({ kind: 'equal', old_number: oldNumber, new_number: newNumber, segments });
      }
      i++;
      continue;
    }

    // A hunk: a delete run, an insert run, or a delete run directly followed
    // by an insert run.
    let del = -1;
    let ins = -1;
    if (kind[i] === 1) {
      del = i;
      if (i + 1 < opCount && kind[i + 1] === 2) {
        ins = i + 1;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      ins = i;
      i += 1;
    }
    const dels = del === -1 ? 0 : old_lines[del];
    const inss = ins === -1 ? 0 : new_lines[ins];
    const uDel = [];
    const uIns = [];
    for (let k = 0; k < Math.max(dels, inss); k++) {
      const hasD = k < dels;
      const hasI = k < inss;
      const oldNumber = hasD ? old_start[del] + k + 1 : null;
      const newNumber = hasI ? new_start[ins] + k + 1 : null;
      let lSegs = null;
      let rSegs = null;
      if (hasD && hasI) {
        // Modify pair: left ranges precede right ranges in hl_ranges.
        lSegs = segmentsFromSpans(leftLines[old_start[del] + k], hl_counts[2 * hlRow]);
        rSegs = segmentsFromSpans(rightLines[new_start[ins] + k], hl_counts[2 * hlRow + 1]);
        hlRow++;
      } else if (hasD) {
        lSegs = plain(leftLines[old_start[del] + k]);
      } else {
        rSegs = plain(rightLines[new_start[ins] + k]);
      }
      rows.push({
        kind: hasD && hasI ? 'modify' : hasD ? 'delete' : 'insert',
        left: hasD ? { number: oldNumber, segments: lSegs } : null,
        right: hasI ? { number: newNumber, segments: rSegs } : null,
      });
      if (hasD) uDel.push({ kind: 'delete', old_number: oldNumber, new_number: null, segments: lSegs });
      if (hasI) uIns.push({ kind: 'insert', old_number: null, new_number: newNumber, segments: rSegs });
    }
    // Within a hunk, all deleted lines precede all inserted lines. Plain
    // loops rather than spread: a complete-rewrite hunk can hold more rows
    // than the engine's argument limit for spread calls.
    for (const row of uDel) unified.push(row);
    for (const row of uIns) unified.push(row);
  }

  if (2 * hlRow !== hl_counts.length || hlOff !== hl_ranges.length) {
    throw new Error('diffwtf: sparse highlight channel does not match the ops');
  }

  return {
    rows,
    unified,
    added: sparse.added,
    removed: sparse.removed,
    line_count: sparse.line_count,
  };
}
