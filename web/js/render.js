// diff.wtf DOM builders for the split and unified views, moved verbatim from
// app.js in M9 so the render path can be exercised (and benchmarked) without
// importing the page module and its side effects. Output is defined by
// docs/design-handoff/README.md; the input is the assembled DiffResult shape
// from assemble.js.
//
// Rendering safety rule (CLAUDE.md): user and diff text enters the DOM only
// through textContent or text nodes, never through markup parsing.

// Appends a LineCell's segments to a content cell. Highlighted segments get a
// span with the intra-line highlight class; plain runs become bare text nodes.
function appendSegments(parent, segments, hlClass) {
  for (const seg of segments) {
    if (seg.highlighted) {
      const span = document.createElement('span');
      span.className = hlClass;
      span.textContent = seg.text;
      parent.append(span);
    } else {
      parent.append(document.createTextNode(seg.text));
    }
  }
}

// tone: 'eq' | 'del' | 'ins' | 'missing', mapped to the design's cell styles.
function numCell(number, tone) {
  const span = document.createElement('span');
  span.className = tone === 'eq' ? 'num' : `num ${tone}`;
  span.textContent = number == null ? '' : String(number);
  return span;
}

function contentCell(cell, tone, hlClass) {
  const span = document.createElement('span');
  span.className = tone === 'eq' ? 'cell' : `cell ${tone}`;
  if (cell) appendSegments(span, cell.segments, hlClass);
  return span;
}

export function renderSplit(rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row-split';
    const leftTone = row.left ? (row.kind === 'equal' ? 'eq' : 'del') : 'missing';
    const rightTone = row.right ? (row.kind === 'equal' ? 'eq' : 'ins') : 'missing';
    div.append(
      numCell(row.left && row.left.number, leftTone),
      contentCell(row.left, leftTone, 'hl-del'),
      numCell(row.right && row.right.number, rightTone),
      contentCell(row.right, rightTone, 'hl-ins'),
    );
    frag.append(div);
  }
  return frag;
}

export function renderUnified(rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row-unified';
    const tone = row.kind === 'equal' ? 'eq' : row.kind === 'delete' ? 'del' : 'ins';
    const content = document.createElement('span');
    content.className = tone === 'eq' ? 'cell' : `cell ${tone}`;
    appendSegments(content, row.segments, tone === 'ins' ? 'hl-ins' : 'hl-del');
    div.append(numCell(row.old_number, tone), numCell(row.new_number, tone), content);
    frag.append(div);
  }
  return frag;
}
