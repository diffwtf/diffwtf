#!/usr/bin/env node
// scripts/bench-browser.mjs: headless-Chrome confirmation of the Node
// benchmark (scripts/bench-vs-js.mjs), plus the DOM render phase that Node
// cannot measure. Runs the SAME pipelines on a core subset of the same
// input matrix (scripts/bench-cases.mjs), inside the real product page
// (web/index.html) with the real stylesheet, so layout costs are the
// production ones.
//
// What is measured per case, medians over the iteration counts below:
//
//   js total     reference compute(): line diff, refinement, views, one pass
//   wasm total   shipped pipeline: web/pkg compute() + assemble.js
//   DOM render   renderSplit() over the assembled rows, replaceChildren into
//                the page's #diff-body, then a forced layout read. The rows
//                are structurally identical whichever pipeline produced
//                them, so render is one shared phase, measured once and
//                added to both sides for the "including render" ratio.
//
// The identical-input fast path disclosure from bench-vs-js.mjs applies here
// unchanged. Render iteration counts are lower on huge inputs because a
// forced full-page layout of tens of thousands of rows is slow; DOM
// virtualization is a tracked non-goal for now. Chrome quantizes
// performance.now() to 0.1 ms, so sub-millisecond browser numbers are
// coarser than the Node ones; treat them as confirmation, not precision.
//
// Requires web/pkg (./scripts/build-wasm.sh) and Playwright with Chromium.
// If `import('playwright')` cannot resolve it, set PLAYWRIGHT_BASE to a
// node_modules directory that contains playwright (the script falls back to
// requiring it from there).
//
// Usage: node scripts/bench-browser.mjs
// Committed record of a real run: scripts/bench-browser.results.txt

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// name -> { iterations, renderIterations }; must exist in bench-cases.mjs.
const BROWSER_CASES = new Map([
  ['tiny-snippet', { iterations: 30, renderIterations: 30 }],
  ['large-150kb-sparse', { iterations: 30, renderIterations: 10 }],
  ['large-150kb-identical', { iterations: 30, renderIterations: 10 }],
  ['lines-10k', { iterations: 20, renderIterations: 5 }],
  ['large-1mb-sparse', { iterations: 10, renderIterations: 2 }],
]);

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

// Minimal static server over the repo root: the page needs web/, web/pkg/,
// reference/, scripts/, and fixtures/ under one origin.
const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.includes('..')) throw new Error('traversal');
    const file = join(ROOT, path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${origin}/web/index.html`);
await page.waitForFunction(
  () => document.getElementById('perf-text')?.textContent === 'ready · engine loaded',
);

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch {
  /* fine outside a git checkout */
}

const results = await page.evaluate(async (config) => {
  const { compute } = await import('/web/pkg/diffwtf_wasm.js');
  const { assembleDiffResult } = await import('/web/js/assemble.js');
  const { renderSplit } = await import('/web/js/render.js');
  const { compute: jsCompute } = await import('/reference/refdiff.mjs');
  const { CASES } = await import('/scripts/bench-cases.mjs');

  const median = (times) => {
    const sorted = [...times].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const fetchText = async (path) => {
    const res = await fetch(`/${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.text();
  };

  const WARMUP = 5;
  const diffBody = document.getElementById('diff-body');
  diffBody.hidden = false;
  let sink = 0;
  const out = [];

  for (const c of CASES) {
    const cfg = config[c.name];
    if (!cfg) continue;
    const { left, right } = c.fixture
      ? { left: await fetchText(c.fixture.left), right: await fetchText(c.fixture.right) }
      : c.build();

    const jsRun = () => {
      sink += jsCompute(left, right, 'word').rows.length;
    };
    const wasmRun = () => assembleDiffResult(left, right, compute(left, right, 'word'));

    for (let i = 0; i < WARMUP; i++) {
      jsRun();
      wasmRun();
    }
    const times = { js: [], wasm: [], render: [] };
    for (let i = 0; i < cfg.iterations; i++) {
      let t0 = performance.now();
      jsRun();
      times.js.push(performance.now() - t0);
      t0 = performance.now();
      sink += wasmRun().rows.length;
      times.wasm.push(performance.now() - t0);
    }
    const assembled = wasmRun();
    for (let i = 0; i < cfg.renderIterations; i++) {
      const t0 = performance.now();
      diffBody.replaceChildren(renderSplit(assembled.rows));
      sink += diffBody.offsetHeight; // force layout inside the timed region
      times.render.push(performance.now() - t0);
    }
    diffBody.replaceChildren();
    out.push({
      name: c.name,
      note: c.note,
      leftChars: left.length,
      rightChars: right.length,
      added: assembled.added,
      removed: assembled.removed,
      iterations: cfg.iterations,
      renderIterations: cfg.renderIterations,
      js: median(times.js),
      wasm: median(times.wasm),
      render: median(times.render),
    });
  }
  return { cases: out, sink: sink & 0xffff };
}, Object.fromEntries(BROWSER_CASES));

await browser.close();
server.close();

const fmt = (ms) => (ms < 1 ? `${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`);
console.log('# diff.wtf browser benchmark: headless Chromium, real page (web/index.html), sparse v2 boundary');
console.log(`# node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · commit ${commit}`);
console.log('# medians; phases and methodology: header comment of scripts/bench-browser.mjs');
console.log('');
for (const r of results.cases) {
  console.log(`${r.name}: ${r.note}`);
  console.log(
    `  input: ${r.leftChars.toLocaleString('en-US')} + ${r.rightChars.toLocaleString('en-US')} chars, +${r.added}/-${r.removed} lines, ` +
      `median of ${r.iterations} (render: ${r.renderIterations})`,
  );
  console.log(`  js total (compute incl. views)   ${fmt(r.js)}`);
  console.log(`  wasm total (call + assembly)     ${fmt(r.wasm)}`);
  console.log(`  DOM render (split view, shared)  ${fmt(r.render)}`);
  console.log(`  ratio without render             ${(r.js / r.wasm).toFixed(2)}x`);
  console.log(`  ratio including render           ${((r.js + r.render) / (r.wasm + r.render)).toFixed(2)}x`);
  console.log('');
}
console.log('# summary');
for (const r of results.cases) {
  const flag = r.name === 'large-150kb-identical' ? '  [identical fast path, not an engine-speed number]' : '';
  console.log(
    `# ${r.name}: js ${fmt(r.js)} vs wasm ${fmt(r.wasm)} -> ${(r.js / r.wasm).toFixed(2)}x; ` +
      `incl. render ${fmt(r.render)}: ${((r.js + r.render) / (r.wasm + r.render)).toFixed(2)}x${flag}`,
  );
}
console.log(`# (sink ${results.sink}, printed so no timed call can be optimized away)`);
