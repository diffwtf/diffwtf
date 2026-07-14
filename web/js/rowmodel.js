// diff.wtf lazy row model: random access to the renderable Split and Unified
// rows implied by a sparse v2 wasm result plus the two original inputs,
// without materializing every row. The boundary shape is the v2 contract in
// docs/scaffold-spec.md: parallel typed arrays of run-length line ops
// (kind 0 equal, 1 delete, 2 insert; 0-based old_start/new_start line
// indices; old_lines/new_lines run lengths) and a highlight side channel
// carrying [start, end) UTF-16 ranges for Modify rows only.
//
// Why lazy (M10): the virtualized renderers only ever look at a window of
// rows, so building the model must cost O(ops), not O(lines). The index
// built here scales with the number of edit runs and modify rows; the line
// arrays are the '\n' split of the inputs the page already holds. Row
// lookup is a binary search over block start indices plus O(1) assembly of
// that one row.
//
// Correctness contract: splitRow(i) and unifiedRow(i) must equal, field for
// field, rows[i] and unified[i] of the materialized reference output.
// web/js/assemble.js is now a thin loop over this model, and
// scripts/conformance-web.mjs pins that assembly to the committed fixtures,
// so this model is conformance-tested on every CI run.
//
// A delete run directly followed by an insert run is one hunk; its first
// min(old_lines, new_lines) line pairs are Modify rows, which consume the
// highlight channel in stream order.

export function createRowModel(left, right, sparse) {
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

  // Blocks: an Equal run, or a hunk (a delete run, an insert run, or a
  // delete run directly followed by an insert run). Parallel arrays, one
  // entry per block:
  //   splitStarts / unifiedStarts  first row index of the block in each view
  //   blockDel                     op index of the delete run, or -1
  //   blockIns                     op index of the insert run, or -1
  //                                (equal blocks store the equal op in
  //                                blockDel and -1 in blockIns, and are
  //                                distinguished by kind[blockDel] === 0)
  //   blockHlRow                   first Modify-row index of the block
  const splitStarts = [];
  const unifiedStarts = [];
  const blockDel = [];
  const blockIns = [];
  const blockHlRow = [];

  let splitCount = 0;
  let unifiedCount = 0;
  let modifyRows = 0;

  let i = 0;
  while (i < opCount) {
    if (kind[i] === 0) {
      splitStarts.push(splitCount);
      unifiedStarts.push(unifiedCount);
      blockDel.push(i);
      blockIns.push(-1);
      blockHlRow.push(modifyRows);
      splitCount += old_lines[i];
      unifiedCount += old_lines[i];
      i++;
      continue;
    }
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
    splitStarts.push(splitCount);
    unifiedStarts.push(unifiedCount);
    blockDel.push(del);
    blockIns.push(ins);
    blockHlRow.push(modifyRows);
    splitCount += Math.max(dels, inss);
    unifiedCount += dels + inss;
    modifyRows += Math.min(dels, inss);
  }
  const blockCount = splitStarts.length;

  // Per Modify row, the offset into hl_ranges where its left spans start;
  // its right spans start at rangeOff[r] + 2 * hl_counts[2 * r]. Built in
  // O(modify rows), which scales with edits, not with document size.
  const rangeOff = new Array(modifyRows + 1);
  rangeOff[0] = 0;
  for (let r = 0; r < modifyRows; r++) {
    rangeOff[r + 1] = rangeOff[r] + 2 * (hl_counts[2 * r] + hl_counts[2 * r + 1]);
  }
  if (2 * modifyRows !== hl_counts.length || rangeOff[modifyRows] !== hl_ranges.length) {
    throw new Error('diffwtf: sparse highlight channel does not match the ops');
  }

  const plain = (text) => (text === '' ? [] : [{ text, highlighted: false }]);

  // Cut one line into segments from `count` highlight ranges starting at
  // hl_ranges[base]. Ranges are sorted, disjoint, and non-adjacent, so
  // segments alternate.
  function segmentsFromSpans(text, base, count) {
    if (count === 0) return plain(text);
    const segments = [];
    let cursor = 0;
    let off = base;
    for (let s = 0; s < count; s++) {
      const start = hl_ranges[off];
      const end = hl_ranges[off + 1];
      off += 2;
      if (start > cursor) segments.push({ text: text.slice(cursor, start), highlighted: false });
      segments.push({ text: text.slice(start, end), highlighted: true });
      cursor = end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
    return segments;
  }

  // Greatest block whose start row is <= row, for either view's starts.
  function blockAt(starts, row) {
    let lo = 0;
    let hi = blockCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function modifySegments(b, k) {
    const r = blockHlRow[b] + k;
    const del = blockDel[b];
    const ins = blockIns[b];
    const leftCount = hl_counts[2 * r];
    return {
      lSegs: segmentsFromSpans(leftLines[old_start[del] + k], rangeOff[r], leftCount),
      rSegs: segmentsFromSpans(
        rightLines[new_start[ins] + k],
        rangeOff[r] + 2 * leftCount,
        hl_counts[2 * r + 1],
      ),
    };
  }

  function splitRow(i) {
    const b = blockAt(splitStarts, i);
    const k = i - splitStarts[b];
    const del = blockDel[b];
    const ins = blockIns[b];
    if (ins === -1 && kind[del] === 0) {
      const oldNumber = old_start[del] + k + 1;
      const newNumber = new_start[del] + k + 1;
      const segments = plain(leftLines[old_start[del] + k]);
      return {
        kind: 'equal',
        left: { number: oldNumber, segments },
        right: { number: newNumber, segments },
      };
    }
    const dels = del === -1 ? 0 : old_lines[del];
    const inss = ins === -1 ? 0 : new_lines[ins];
    const hasD = k < dels;
    const hasI = k < inss;
    let lSegs = null;
    let rSegs = null;
    if (hasD && hasI) {
      ({ lSegs, rSegs } = modifySegments(b, k));
    } else if (hasD) {
      lSegs = plain(leftLines[old_start[del] + k]);
    } else {
      rSegs = plain(rightLines[new_start[ins] + k]);
    }
    return {
      kind: hasD && hasI ? 'modify' : hasD ? 'delete' : 'insert',
      left: hasD ? { number: old_start[del] + k + 1, segments: lSegs } : null,
      right: hasI ? { number: new_start[ins] + k + 1, segments: rSegs } : null,
    };
  }

  function unifiedRow(i) {
    const b = blockAt(unifiedStarts, i);
    const k = i - unifiedStarts[b];
    const del = blockDel[b];
    const ins = blockIns[b];
    if (ins === -1 && kind[del] === 0) {
      return {
        kind: 'equal',
        old_number: old_start[del] + k + 1,
        new_number: new_start[del] + k + 1,
        segments: plain(leftLines[old_start[del] + k]),
      };
    }
    const dels = del === -1 ? 0 : old_lines[del];
    const inss = ins === -1 ? 0 : new_lines[ins];
    const modifies = Math.min(dels, inss);
    if (k < dels) {
      const segments = k < modifies ? modifySegments(b, k).lSegs : plain(leftLines[old_start[del] + k]);
      return { kind: 'delete', old_number: old_start[del] + k + 1, new_number: null, segments };
    }
    const j = k - dels;
    const segments = j < modifies ? modifySegments(b, j).rSegs : plain(rightLines[new_start[ins] + j]);
    return { kind: 'insert', old_number: null, new_number: new_start[ins] + j + 1, segments };
  }

  return {
    splitCount,
    unifiedCount,
    splitRow,
    unifiedRow,
    added: sparse.added,
    removed: sparse.removed,
    line_count: sparse.line_count,
  };
}
