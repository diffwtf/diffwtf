#!/usr/bin/env node
// scripts/check-virtual.mjs: headless Playwright checks for the M10 worker
// and virtualization work (issue #16). Complements scripts/smoke-live.mjs
// (which stays the tiny deploy gate) with the behaviors that only matter at
// size:
//
//   1. responsiveness: while a multi-second diff computes in the worker,
//      the main thread keeps ticking (rAF frames keep coming, the input
//      handler returns immediately, a toolbar click lands mid-compute);
//   2. scroll correctness: scrolling a 5 MB virtualized diff shows the
//      right rows, with line numbers matching the true row index, while
//      the DOM node count stays bounded;
//   3. parity: for a sample containing every row kind (equal, delete,
//      insert, modify with highlights, unicode, wrapped and empty lines),
//      the virtualized DOM rows equal the full non-virtualized render of
//      the same model, element for element, in both views;
//   4. copy across recycled rows: a selection whose anchor row has been
//      recycled out of the DOM still copies the correct full text,
//      reconstructed from the row model;
//   5. privacy: every network request in the whole run is same-origin or
//      the design's Google Fonts stylesheet; nothing else leaves the page.
//
// Usage: node scripts/check-virtual.mjs [--serve web]
// Requires web/pkg (./scripts/build-wasm.sh) and Playwright with Chromium
// (set PLAYWRIGHT_BASE to a node_modules directory if it is not resolvable).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    const base = process.env.PLAYWRIGHT_BASE;
    if (!base) throw err;
    const { createRequire } = await import('node:module');
    return createRequire(join(base, 'noop.js'))('playwright');
  }
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

function serve(root) {
  const server = createServer(async (req, res) => {
    try {
      let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path.includes('..')) throw new Error('traversal');
      if (path === '/' || path === '') path = '/index.html';
      const body = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const args = process.argv.slice(2);
let serveDir = 'web';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--serve') serveDir = args[++i];
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const server = await serve(serveDir);
const base = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
});
const offOrigin = [];
page.on('request', (req) => {
  const url = new URL(req.url());
  const sameOrigin = url.origin === base;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !fonts) offOrigin.push(req.url());
});

// Waits for the perf badge to show a fresh routed timing.
async function awaitDiffBadge(previous, timeout = 120000) {
  await page.waitForFunction(
    (prev) => {
      const text = document.getElementById('perf-text')?.textContent ?? '';
      return text !== prev && /^\d+ lines · [\d.,<]+ ms · (engine|incl worker)$/.test(text);
    },
    previous,
    { timeout },
  );
  return page.textContent('#perf-text');
}

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById('perf-text')?.textContent === 'ready · engine loaded',
    undefined,
    { timeout: 30000 },
  );

  // ---- 0. hybrid route labels and small-input timing ---------------------
  {
    const before = await page.textContent('#perf-text');
    await page.click('#btn-example');
    const smallBadge = await awaitDiffBadge(before);
    const smallMs = smallBadge.includes('<0.1')
      ? 0.1
      : Number(smallBadge.match(/· ([\d.]+) ms/)[1]);
    check(
      smallBadge.endsWith('· engine') && smallMs < 1,
      'small input uses the direct engine route with sub-millisecond-scale timing',
      JSON.stringify(smallBadge),
    );
    await page.click('#btn-clear');
  }

  {
    const before = await page.textContent('#perf-text');
    const left = await readFile('fixtures/cases/large-perf.left.txt', 'utf8');
    const right = await readFile('fixtures/cases/large-perf.right.txt', 'utf8');
    await page.evaluate(({ left, right }) => {
      const set = (id, value) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('left-text', left);
      set('right-text', right);
    }, { left, right });
    const largeBadge = await awaitDiffBadge(before);
    check(
      largeBadge.endsWith('· incl worker'),
      'committed 150 KB fixture displays the worker timing label',
      JSON.stringify(largeBadge),
    );
    await page.click('#btn-clear');
  }

  // ---- 1. responsiveness during a large worker compute -------------------
  // Every line has its first and last word edited, which defeats the
  // intraline prefix/suffix trim and makes the engine run a near-bailout
  // token DP per row: seconds of compute on modest text (measured ~2.7 s
  // for 3.5 MB per side on the dev machine). The assertion window starts
  // after the browser has laid the textareas out: that one-off layout cost
  // is native to holding text in a <textarea>, predates M10, and is
  // reported separately below so a regression in OUR path cannot hide
  // behind it.
  {
    const r = await page.evaluate(async ({ lines, wordsPerLine }) => {
      const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
      const l = [];
      const rgt = [];
      for (let i = 0; i < lines; i++) {
        const w = [];
        for (let k = 0; k < wordsPerLine; k++) w.push(WORDS[(i * 7 + k) % 6]);
        l.push(w.join(' '));
        const w2 = [...w];
        w2[0] = `first${i}`;
        w2[wordsPerLine - 1] = `last${i}`;
        rgt.push(w2.join(' '));
      }
      const left = l.join('\n');
      const right = rgt.join('\n');

      const perf = document.getElementById('perf-text');
      const before = perf.textContent;
      const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t0 = performance.now();
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('left-text', left);
      const setLeftMs = performance.now() - t0;
      set('right-text', right);

      // Let the textarea layout settle; the diff keeps computing in the
      // worker underneath. Everything after this point is our path.
      await raf2();
      const settleMs = performance.now() - t0;

      let frames = 0;
      let longest = 0;
      let done = false;
      const windowStart = performance.now();
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.startTime >= windowStart) longest = Math.max(longest, e.duration);
        }
      });
      po.observe({ entryTypes: ['longtask'] });
      const tick = () => {
        frames++;
        if (!done) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      // A real interaction mid-compute: the view toggle must land and take
      // effect while the worker is still diffing.
      let toggleLanded = false;
      setTimeout(() => {
        document.getElementById('btn-unified').click();
        toggleLanded = document.getElementById('btn-unified').classList.contains('active');
      }, 200);

      const badge = await new Promise((resolve) => {
        const look = () => {
          const text = perf.textContent;
          if (text !== before && /^\d+ lines · [\d.,<]+ ms · (engine|incl worker)$/.test(text)) resolve(text);
          else setTimeout(look, 25);
        };
        look();
      });
      done = true;
      // Long tasks are only observable once finished; give the observer a
      // beat to flush before disconnecting.
      await raf2();
      po.disconnect();
      const computeWindowMs = performance.now() - windowStart;
      return { badge, settleMs, computeWindowMs, frames, longest, setLeftMs, toggleLanded };
    }, { lines: 1600, wordsPerLine: 340 });

    const fps = (r.frames / r.computeWindowMs) * 1000;
    console.log(
      `INFO textarea layout settle (browser-native, pre-M10 behavior): ${r.settleMs.toFixed(0)} ms; ` +
        `worker compute window after settle: ${r.computeWindowMs.toFixed(0)} ms; badge ${JSON.stringify(r.badge)}`,
    );
    check(
      r.computeWindowMs >= 800,
      'responsiveness precondition: compute outlives the textarea settle by enough to measure',
      `${r.computeWindowMs.toFixed(0)} ms of worker compute after settle; grow the input if engines got faster`,
    );
    check(
      fps >= 20,
      'main thread keeps ticking during worker compute',
      `${r.frames} frames over ${r.computeWindowMs.toFixed(0)} ms (${fps.toFixed(1)} fps)`,
    );
    check(
      r.setLeftMs < 400,
      'input handler returns immediately (no synchronous compute)',
      `input event dispatch took ${r.setLeftMs.toFixed(1)} ms`,
    );
    check(r.toggleLanded, 'toolbar click lands mid-compute');
    check(
      r.longest < 500,
      'no main-thread block during the compute window',
      `longest long task ${r.longest.toFixed(0)} ms`,
    );
    await page.click('#btn-split');
    await page.click('#btn-clear');
  }

  // ---- 2. scroll correctness on a 5 MB diff ------------------------------
  {
    const before = await page.textContent('#perf-text');
    const meta = await page.evaluate(() => {
      const xorshift = (seed) => {
        let s = seed >>> 0;
        return () => {
          s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
          return s;
        };
      };
      const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
      const rand = xorshift(0x5f00d5);
      const lines = [];
      const COUNT = 165000; // ~5.3 MB per side at ~33 chars per line
      for (let i = 0; i < COUNT; i++) {
        lines.push(`l${String(i + 1).padStart(6, '0')} ${WORDS[rand() % 8]} ${WORDS[rand() % 8]} ${WORDS[rand() % 8]}`);
      }
      const left = lines.join('\n');
      // Edit every 40th line inside one 600-line zone: modify rows only, no
      // inserts, so split row i must show line number i + 1 on both sides.
      const right = lines
        .map((l, i) => (i >= 80000 && i < 80600 && i % 40 === 0 ? `${l} edited` : l))
        .join('\n');
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('left-text', left);
      set('right-text', right);
      return { count: COUNT, bytes: left.length };
    });
    const badge = await awaitDiffBadge(before);
    check(
      badge.startsWith(`${meta.count} lines`),
      '5 MB diff computes and reports its size',
      `badge ${JSON.stringify(badge)}, ${meta.bytes.toLocaleString('en-US')} chars per side`,
    );
    check(badge.endsWith('· incl worker'), '5 MB diff uses the worker route', JSON.stringify(badge));

    const targets = [0, 12345, 100000, meta.count - 1];
    const scroll = await page.evaluate(async (targets) => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = [];
      for (const t of targets) {
        window.__diffwtf.scrollToRow(t);
        await raf();
        let found = null;
        for (const el of document.querySelectorAll('#diff-body .row-split')) {
          if (el.__row === t) {
            found = el;
            break;
          }
        }
        const rowCount = document.querySelectorAll('#diff-body .row-split').length;
        if (!found) {
          out.push({ t, ok: false, rowCount, why: 'target row not rendered' });
          continue;
        }
        const nums = [...found.querySelectorAll('.num')].map((n) => n.textContent);
        const rect = found.getBoundingClientRect();
        out.push({
          t,
          ok: nums[0] === String(t + 1) && nums[1] === String(t + 1),
          nums,
          visible: rect.bottom > 0 && rect.top < window.innerHeight,
          rowCount,
        });
      }
      return out;
    }, targets);
    for (const s of scroll) {
      check(
        s.ok && s.visible,
        `scroll to row ${s.t}: correct line numbers, on screen`,
        `nums ${JSON.stringify(s.nums)}, visible ${s.visible}, ${s.rowCount} rows in DOM`,
      );
      check(
        s.rowCount < 250,
        `scroll to row ${s.t}: DOM stays bounded`,
        `${s.rowCount} split rows in DOM`,
      );
    }

    // ---- 4. copy across recycled rows (still on the 5 MB diff) -----------
    const copy = await page.evaluate(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rowEl = (i) => {
        for (const el of document.querySelectorAll('#diff-body .row-split')) {
          if (el.__row === i) return el;
        }
        return null;
      };
      const cellText = (el, which) => el.querySelectorAll('.cell')[which].firstChild;

      window.__diffwtf.scrollToRow(50);
      await raf();
      const startNode = cellText(rowEl(50), 0); // left content cell, text node
      const sel = document.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStart(startNode, 3);
      range.collapse(true);
      sel.addRange(range);
      // Fire selectionchange handlers before the anchor row gets recycled.
      await raf();

      window.__diffwtf.scrollToRow(120000);
      await raf();
      const anchorRow = rowEl(50); // should be pinned, still findable
      const endEl = rowEl(120010);
      if (!endEl) return { why: 'end row not rendered' };
      sel.extend(cellText(endEl, 0), 5);
      await raf();

      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      const got = dt.getData('text/plain');

      const model = window.__diffwtf.model;
      const text = (i) => model.splitRow(i).left.segments.map((s) => s.text).join('');
      const lines = [];
      for (let i = 50; i <= 120010; i++) lines.push(text(i));
      lines[0] = lines[0].slice(3);
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, 5);
      const expected = lines.join('\n');
      return {
        prevented: ev.defaultPrevented,
        matches: got === expected,
        gotLength: got.length,
        expectedLength: expected.length,
        anchorPinned: Boolean(anchorRow) && anchorRow.style.position === 'absolute',
        selectionAlive: !sel.isCollapsed,
      };
    });
    check(
      copy.prevented === true && copy.matches === true,
      'copy across recycled rows reconstructs the full text',
      copy.why ?? `${copy.gotLength} chars copied, expected ${copy.expectedLength}; anchor pinned ${copy.anchorPinned}, selection alive ${copy.selectionAlive}`,
    );
    check(copy.anchorPinned === true, 'selection anchor row was pinned, not recycled');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await page.click('#btn-clear');
  }

  // ---- 3. virtualized output equals the full render (both views) ---------
  {
    const before = await page.textContent('#perf-text');
    await page.evaluate(() => {
      const lines = [];
      for (let i = 0; i < 130; i++) lines.push(`common ${i} start`);
      lines.push('delete me 1', 'delete me 2', 'delete me 3');
      for (let i = 0; i < 40; i++) lines.push(`middle ${i}`);
      lines.push('modify alpha bravo charlie', 'modify delta echo foxtrot');
      lines.push('unicode 你好 🌍 café ａｂｃ');
      lines.push('');
      lines.push(`wrap ${'wide '.repeat(400)}end`);
      for (let i = 0; i < 130; i++) lines.push(`common ${i} end`);
      const left = lines.join('\n');
      const right = lines
        .filter((l) => !l.startsWith('delete me'))
        .map((l) => (l.startsWith('modify') ? l.replace('bravo', 'BRAVO').replace('echo', 'ECHO') : l))
        .map((l) => (l.startsWith('unicode') ? l.replace('🌍', '🌎') : l))
        .join('\n') + '\ninserted tail 1\ninserted tail 2';
      const set = (id, v) => {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('left-text', left);
      set('right-text', right);
      window.__paritySample = { left, right };
    });
    await awaitDiffBadge(before);

    for (const view of ['split', 'unified']) {
      await page.click(view === 'split' ? '#btn-split' : '#btn-unified');
      const r = await page.evaluate(async (view) => {
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const { left, right } = window.__paritySample;
        // Full reference render: same wasm compute (a second, main-thread
        // instance just for the check), same assembler, same row builders.
        const glue = await import('/pkg/diffwtf_wasm.js?v=m10');
        await glue.default();
        const { assembleDiffResult } = await import('/js/assemble.js');
        const { renderSplit, renderUnified } = await import('/js/render.js');
        const full = assembleDiffResult(left, right, glue.compute(left, right, 'word'));
        const refFrag = view === 'split' ? renderSplit(full.rows) : renderUnified(full.unified);
        const ref = [...refFrag.children].map((el) => el.outerHTML);

        const selector = view === 'split' ? '#diff-body .row-split' : '#diff-body .row-unified';
        const seen = new Map();
        const harvest = () => {
          for (const el of document.querySelectorAll(selector)) {
            if (el.__row !== undefined && !seen.has(el.__row)) seen.set(el.__row, el.outerHTML);
          }
        };
        for (let t = 0; t < ref.length; t += 20) {
          window.__diffwtf.scrollToRow(t);
          await raf();
          harvest();
        }
        window.__diffwtf.scrollToRow(ref.length - 1);
        await raf();
        harvest();

        let missing = 0;
        let mismatched = null;
        for (let i = 0; i < ref.length; i++) {
          const got = seen.get(i);
          if (got === undefined) missing++;
          else if (got !== ref[i] && mismatched === null) {
            mismatched = { i, got: got.slice(0, 160), want: ref[i].slice(0, 160) };
          }
        }
        return { rows: ref.length, harvested: seen.size, missing, mismatched };
      }, view);
      check(
        r.missing === 0 && r.mismatched === null && r.harvested >= r.rows,
        `virtualized ${view} view matches the full render on all ${r.rows} rows`,
        r.mismatched
          ? `row ${r.mismatched.i}: got ${JSON.stringify(r.mismatched.got)} want ${JSON.stringify(r.mismatched.want)}`
          : `${r.missing} rows never rendered while scanning`,
      );
    }
    await page.click('#btn-split');
    await page.click('#btn-clear');
  }

  // ---- 5. privacy and page health -----------------------------------------
  check(
    offOrigin.length === 0,
    'no request left the origin (fonts aside) during any check',
    offOrigin.slice(0, 3).join(' | '),
  );
  check(pageErrors.length === 0, 'no page or console errors', pageErrors.join(' | ').slice(0, 500));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\ncheck-virtual FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall virtualization and worker checks passed');
