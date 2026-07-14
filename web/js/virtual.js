// diff.wtf windowed list renderer (M10): keeps only the rows near the
// viewport in the DOM, whatever the diff size, so a multi-hundred-thousand
// row diff renders and scrolls like a small one. The page (window) stays
// the scroll source, exactly as in the non-virtualized design: the
// container gets a top spacer, a host holding the rendered window, and a
// bottom spacer, so the document height and the scrollbar reflect the full
// row count while the DOM node count stays bounded by viewport + overscan.
//
// Row heights: estimated uniform with correction. The estimate is
// calibrated once from the first rendered row (the design row is a fixed
// 12.5px/1.6 grid line); rows that wrap to a different height are measured
// when they are rendered and their deviation from the estimate is recorded
// (sparse per-row extras plus per-chunk sums, so offset and index lookups
// stay O(chunk) with O(edited rows) memory). Nothing in the scroll loop
// reads layout per row: each update does one batched read phase, one write
// phase, one batched measure phase, and one correction write, in that
// order, never interleaved.
//
// Split-view scroll sync is structural: a split row is ONE grid element
// carrying both sides, so the two panes cannot drift; there is no second
// scroll source to synchronize. There are no sticky headers inside the
// scroll area (the results header sits above the container in normal
// flow), so no frozen-row handling is needed.
//
// Selection across recycled rows: recycling a row that holds a selection
// endpoint would collapse the user's selection, so such rows are pinned
// instead of removed: same element, switched to absolute positioning at
// its virtual offset (a style change does not disturb the selection), with
// a same-height placeholder keeping the flow honest if the row's index is
// inside the window. Pinned rows are released when the selection ends. At
// most the two endpoint rows are ever pinned, so memory stays bounded.
// The painted selection across the gap covers spacer pixels rather than
// real rows; the copy handler (selection.js) reconstructs the true text
// from the row model, so what lands on the clipboard is complete anyway.

export function createVirtualList({ container, count, renderRow, overscan = 12 }) {
  const CHUNK = 2048;
  const DEFAULT_EST = 22; // the design row: 12.5px JetBrains Mono at 1.6 plus 1px padding each side

  const topSpacer = document.createElement('div');
  const host = document.createElement('div');
  const bottomSpacer = document.createElement('div');
  container.append(topSpacer, host, bottomSpacer);

  let est = DEFAULT_EST;
  let calibrated = false;

  // Height corrections: extra[i] = measured height - est, kept sparsely.
  const numChunks = Math.max(1, Math.ceil(count / CHUNK));
  const chunkExtra = new Float64Array(numChunks);
  const chunkPrefix = new Float64Array(numChunks + 1);
  const chunkRows = new Map(); // chunk index -> Map(row index -> extra px)
  let totalExtra = 0;
  let prefixDirty = false;

  function ensurePrefix() {
    if (!prefixDirty) return;
    let p = 0;
    for (let c = 0; c < numChunks; c++) {
      chunkPrefix[c] = p;
      p += chunkExtra[c];
    }
    chunkPrefix[numChunks] = p;
    prefixDirty = false;
  }

  function extraOf(i) {
    const rows = chunkRows.get((i / CHUNK) | 0);
    return rows ? (rows.get(i) ?? 0) : 0;
  }

  function setExtra(i, extra) {
    const c = (i / CHUNK) | 0;
    let rows = chunkRows.get(c);
    const prev = rows ? (rows.get(i) ?? 0) : 0;
    const delta = extra - prev;
    if (delta === 0) return 0;
    if (!rows) {
      rows = new Map();
      chunkRows.set(c, rows);
    }
    if (extra === 0) rows.delete(i);
    else rows.set(i, extra);
    chunkExtra[c] += delta;
    totalExtra += delta;
    prefixDirty = true;
    return delta;
  }

  function totalHeight() {
    return count * est + totalExtra;
  }

  // Top offset of row i in content coordinates (row 0 starts at 0).
  function offsetOf(i) {
    if (i >= count) return totalHeight();
    ensurePrefix();
    const c = (i / CHUNK) | 0;
    let y = i * est + chunkPrefix[c];
    const rows = chunkRows.get(c);
    if (rows) {
      for (const [idx, extra] of rows) {
        if (idx < i) y += extra;
      }
    }
    return y;
  }

  // Row whose extent contains content coordinate y.
  function indexAt(y) {
    if (y <= 0 || count === 0) return 0;
    ensurePrefix();
    let lo = 0;
    let hi = numChunks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mid * CHUNK * est + chunkPrefix[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    let i = lo * CHUNK;
    let off = i * est + chunkPrefix[lo];
    const rows = chunkRows.get(lo);
    const end = Math.min(count, (lo + 1) * CHUNK);
    while (i < end) {
      const h = est + (rows ? (rows.get(i) ?? 0) : 0);
      if (off + h > y) return i;
      off += h;
      i++;
    }
    return Math.min(i, count - 1);
  }

  const rendered = new Map(); // flow row index -> element (rows and pinned placeholders)
  const pinned = new Map(); // row index -> {el, height}
  let selectionEls = new Set(); // row elements currently holding a selection endpoint
  let originTop = null; // content origin inside the container (its top padding)

  function rowElementOf(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== container) {
      if (el.__row !== undefined && !el.__placeholder) return el;
      el = el.parentElement;
    }
    return null;
  }

  function placeholderFor(i) {
    const div = document.createElement('div');
    div.__row = i;
    div.__placeholder = true;
    div.style.height = `${pinned.get(i).height}px`;
    return div;
  }

  function pinRow(i, el) {
    const height = est + extraOf(i);
    el.__pinned = true;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.top = `${originTop + offsetOf(i)}px`;
    pinned.set(i, { el, height });
  }

  function releasePinned() {
    if (pinned.size === 0) return;
    for (const [i, p] of pinned) {
      p.el.remove();
      const flow = rendered.get(i);
      if (flow && flow.__placeholder) {
        flow.remove();
        rendered.delete(i);
      }
    }
    pinned.clear();
    schedule();
  }

  function update() {
    if (count === 0) return;

    // READ: where is the viewport within the content?
    if (originTop === null) originTop = topSpacer.offsetTop;
    const contentTop = topSpacer.getBoundingClientRect().top;
    const viewHeight = window.innerHeight || document.documentElement.clientHeight;
    const y0 = -contentTop;
    const firstVisible = indexAt(y0);
    const newFirst = Math.max(0, firstVisible - overscan);
    const newLast = Math.min(count - 1, indexAt(y0 + viewHeight) + overscan);

    // WRITE: recycle rows that left the window; pin instead of removing
    // when the row holds a selection endpoint.
    for (const [i, el] of rendered) {
      if (i >= newFirst && i <= newLast) continue;
      rendered.delete(i);
      if (!el.__placeholder && selectionEls.has(el)) pinRow(i, el);
      else el.remove();
    }

    // WRITE: fill the window in order, reusing rows already in place.
    // Pinned rows are absolutely positioned elements that keep their old
    // sibling slot; the cursor walk skips them, and their index gets a
    // same-height placeholder in the flow instead.
    const added = [];
    let cursor = host.firstChild;
    for (let i = newFirst; i <= newLast; i++) {
      while (cursor && cursor.__pinned) cursor = cursor.nextSibling;
      if (cursor && cursor.__row === i) {
        cursor = cursor.nextSibling;
        continue;
      }
      let el;
      if (pinned.has(i)) {
        el = placeholderFor(i);
      } else {
        el = renderRow(i);
        el.__row = i;
        added.push(el);
      }
      host.insertBefore(el, cursor);
      rendered.set(i, el);
    }
    topSpacer.style.height = `${offsetOf(newFirst)}px`;
    bottomSpacer.style.height = `${Math.max(0, totalHeight() - offsetOf(newLast + 1))}px`;

    // READ (batched): measure what was just rendered and record height
    // corrections. Estimate calibration happens once, off the first real
    // row, before any corrections exist.
    let deltaAbove = 0;
    if (added.length > 0) {
      const heights = added.map((el) => el.getBoundingClientRect().height);
      if (!calibrated) {
        est = heights[0] || DEFAULT_EST;
        calibrated = true;
        // The estimate changed under offsets computed with the default, so
        // the spacers must be rewritten below even with no extras recorded.
        prefixDirty = true;
      }
      for (let k = 0; k < added.length; k++) {
        const i = added[k].__row;
        const delta = setExtra(i, heights[k] - est);
        if (delta !== 0 && i < firstVisible) deltaAbove += delta;
      }
    }

    // WRITE: apply corrections. If rows above the viewport turned out
    // taller or shorter than estimated, the content below them shifted;
    // compensating the scroll position in the same frame keeps the visible
    // rows visually still.
    if (prefixDirty) {
      topSpacer.style.height = `${offsetOf(newFirst)}px`;
      bottomSpacer.style.height = `${Math.max(0, totalHeight() - offsetOf(newLast + 1))}px`;
      for (const [i, p] of pinned) p.el.style.top = `${originTop + offsetOf(i)}px`;
      if (deltaAbove !== 0) window.scrollBy(0, deltaAbove);
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }

  function onSelectionChange() {
    // A collapsed caret counts too: it is the anchor of the shift+click
    // selection the user may be about to make, so its row must survive
    // recycling like any other endpoint row.
    const sel = document.getSelection();
    const next = new Set();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      for (const node of [range.startContainer, range.endContainer]) {
        const el = rowElementOf(node);
        if (el) next.add(el);
      }
    }
    selectionEls = next;
    if (next.size === 0) releasePinned();
  }

  function scrollToRow(i) {
    const target = Math.max(0, Math.min(count - 1, i));
    const pageTop = window.scrollY + container.getBoundingClientRect().top + originTopSafe();
    window.scrollTo({ top: pageTop + offsetOf(target) });
    schedule();
  }

  function originTopSafe() {
    if (originTop === null) originTop = topSpacer.offsetTop;
    return originTop;
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('selectionchange', onSelectionChange);
  // Catches layout shifts that move the container without a scroll event,
  // for example the user dragging a textarea's resize handle.
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resizeObserver?.observe(container);
  resizeObserver?.observe(document.body);

  update();

  function destroy() {
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('selectionchange', onSelectionChange);
    resizeObserver?.disconnect();
    rendered.clear();
    pinned.clear();
    topSpacer.remove();
    host.remove();
    bottomSpacer.remove();
  }

  return { count, update: schedule, scrollToRow, destroy };
}
