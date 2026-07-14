// diff.wtf copy reconstruction (M10): with virtualized rendering, most rows
// of a large diff are not in the DOM, so the browser's default copy of a
// selection spanning recycled rows would silently drop everything between
// the rendered windows. This handler intercepts copy when both selection
// endpoints sit inside diff rows, maps the endpoints to row indices (row
// elements carry their true index as a JS property) and in-line character
// offsets, and rebuilds the full text from the row model, which can produce
// any row whether or not it is in the DOM.
//
// What lands on the clipboard, by view:
//
//   unified   each selected row's line text, one line per row, with the
//             first and last lines trimmed to the exact selection offsets.
//   split     when both endpoints are inside the same side's content cells,
//             that side's text only (the common select-one-pane case), with
//             exact boundary offsets; rows where that side is missing are
//             skipped. When the endpoints are on different sides, or an
//             endpoint is not in a content cell, the fallback is whole rows
//             with the left line then the right line.
//
// Accepted limitations, deliberate: a selection that starts or ends outside
// the diff body (including select-all) keeps the browser's default copy,
// which only carries the rendered window; and the split-view mixed-side
// fallback copies whole boundary rows rather than partial lines. Both are
// documented in DECISIONS.md D8.

const segText = (segments) => segments.map((s) => s.text).join('');

export function wireCopy({ container, getView, getModel }) {
  function rowElementOf(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== container) {
      if (el.__row !== undefined && !el.__placeholder) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Character offset (UTF-16 units) of a DOM boundary within a content
  // cell's concatenated text.
  function charOffsetIn(cell, node, offset) {
    if (node === cell) {
      let chars = 0;
      const limit = Math.min(offset, cell.childNodes.length);
      for (let k = 0; k < limit; k++) chars += cell.childNodes[k].textContent.length;
      return chars;
    }
    let chars = 0;
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text === node) return chars + offset;
      chars += text.data.length;
    }
    return null;
  }

  // Which content cell of the row the boundary sits in, plus the offset
  // inside it. side: 'left' | 'right' for split rows, 'content' for
  // unified rows, null when the boundary is not inside a content cell
  // (for example on the row element itself).
  function locate(rowEl, node, offset) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    let cell = null;
    while (el && el !== rowEl) {
      if (el.classList && el.classList.contains('cell')) cell = el;
      el = el.parentElement;
    }
    if (!el || !cell) return { side: null, chars: null };
    const cells = rowEl.querySelectorAll('.cell');
    const side = cells.length === 2 ? (cell === cells[0] ? 'left' : 'right') : 'content';
    return { side, chars: charOffsetIn(cell, node, offset) };
  }

  // Model text of one row for the chosen column. null = nothing to emit
  // (that side is missing on this row).
  function rowText(model, view, i, side) {
    if (view === 'unified') return segText(model.unifiedRow(i).segments);
    const row = model.splitRow(i);
    if (side === 'left') return row.left ? segText(row.left.segments) : null;
    if (side === 'right') return row.right ? segText(row.right.segments) : null;
    const parts = [];
    if (row.left) parts.push(segText(row.left.segments));
    if (row.right) parts.push(segText(row.right.segments));
    return parts.join('\n');
  }

  function onCopy(event) {
    const model = getModel();
    if (!model || !event.clipboardData) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const startRow = rowElementOf(range.startContainer);
    const endRow = rowElementOf(range.endContainer);
    if (!startRow || !endRow) return; // not fully inside the diff: default copy
    const view = getView();
    let a = { index: startRow.__row, ...locate(startRow, range.startContainer, range.startOffset) };
    let b = { index: endRow.__row, ...locate(endRow, range.endContainer, range.endOffset) };
    // DOM order can disagree with row order when an endpoint row is pinned
    // out of flow (virtual.js); order by the true row index instead.
    if (a.index > b.index || (a.index === b.index && (a.chars ?? 0) > (b.chars ?? Infinity))) {
      [a, b] = [b, a];
    }

    const side = view === 'split' ? (a.side && a.side === b.side ? a.side : 'both') : 'content';
    const lines = [];
    for (let i = a.index; i <= b.index; i++) {
      const text = rowText(model, view, i, side);
      if (text !== null) lines.push(text);
    }
    if (lines.length === 0) return;
    const exact = side !== 'both';
    if (exact && b.chars !== null && b.side === (view === 'split' ? side : 'content')) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, b.chars);
    }
    if (exact && a.chars !== null && a.side === (view === 'split' ? side : 'content')) {
      lines[0] = lines[0].slice(a.chars);
    }

    event.clipboardData.setData('text/plain', lines.join('\n'));
    event.preventDefault();
  }

  document.addEventListener('copy', onCopy);
  return () => document.removeEventListener('copy', onCopy);
}
