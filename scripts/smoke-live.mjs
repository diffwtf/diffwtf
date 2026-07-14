#!/usr/bin/env node
// scripts/smoke-live.mjs: headless smoke test of the diff.wtf shell, run by
// the deploy pipeline twice: before deploying, against the exact artifact
// that will ship (--serve <dir>), and after deploying, against the live URL.
// It exists because the 2026-07-13 M9 deploy broke the live site in a way
// nothing tested: CI validated one locally built site, the deploy workflow
// rebuilt and shipped different bytes, and no check ever loaded the deployed
// page, where returning visitors' four-hour-fresh cached JS glue failed to
// link against the always-revalidated new wasm (DECISIONS.md D7).
//
// Asserts:
//   1. the engine initializes: the perf badge reaches "ready · engine
//      loaded" (a glue/wasm version mismatch dies here as a LinkError);
//   2. a diff actually renders: typed input produces rows and real counts;
//   3. zero page errors and zero console errors during all of the above;
//   4. remote targets only: the cache policy from web/_headers is live
//      (Cache-Control includes no-cache on the HTML, the app JS, and the
//      wasm glue), so the policy that makes mixed-version caches impossible
//      cannot silently regress.
//
// Usage:
//   node scripts/smoke-live.mjs https://diff.wtf
//   node scripts/smoke-live.mjs --serve web
//
// Requires Playwright with Chromium. If `import('playwright')` cannot
// resolve it, set PLAYWRIGHT_BASE to a node_modules directory containing it.

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
let server = null;
let base;
let remote;
if (args[0] === '--serve') {
  if (!args[1]) {
    console.error('usage: smoke-live.mjs --serve <dir> | smoke-live.mjs <url>');
    process.exit(2);
  }
  server = await serve(args[1]);
  base = `http://127.0.0.1:${server.address().port}`;
  remote = false;
} else {
  base = (args[0] ?? 'https://diff.wtf').replace(/\/$/, '');
  remote = true;
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(label);
};

// 4. Cache policy, checked over plain HTTP before the browser run so a
// policy regression fails even if the page itself happens to work.
if (remote) {
  for (const path of ['/', '/js/app.js', '/pkg/diffwtf_wasm.js']) {
    let detail = '';
    let ok = false;
    try {
      const res = await fetch(base + path, { method: 'GET', redirect: 'follow' });
      const cc = res.headers.get('cache-control') ?? '(none)';
      ok = res.ok && cc.includes('no-cache');
      detail = `HTTP ${res.status}, cache-control: ${cc}`;
    } catch (err) {
      detail = String(err);
    }
    check(ok, `cache policy on ${path}`, detail);
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 1. Engine initializes. A stale-glue LinkError leaves the badge stuck on
  // "loading engine…" and surfaces in `errors` below.
  let engineReady = true;
  try {
    await page.waitForFunction(
      () => document.getElementById('perf-text')?.textContent === 'ready · engine loaded',
      undefined,
      { timeout: 20000 },
    );
  } catch {
    engineReady = false;
  }
  check(
    engineReady,
    'engine initializes',
    `badge reads ${JSON.stringify(await page.textContent('#perf-text'))}`,
  );

  // 2. A diff renders end to end.
  if (engineReady) {
    await page.fill('#left-text', 'a\nb\nc');
    await page.fill('#right-text', 'a\nX\nc');
    const badge = await page.textContent('#perf-text');
    const added = await page.textContent('#stat-added');
    const rows = await page.evaluate(
      () => document.querySelectorAll('#diff-body .row-split, #diff-body .row-unified').length,
    );
    check(
      /^3 lines · [\d.,<]+ ms$/.test(badge) && added === '+1' && rows === 3,
      'diff renders',
      `badge ${JSON.stringify(badge)}, added ${JSON.stringify(added)}, rows ${rows}`,
    );
  }

  // 3. No errors anywhere in the run.
  check(errors.length === 0, 'no page or console errors', errors.join(' | ').slice(0, 500));
} finally {
  await browser.close();
  server?.close();
}

if (failures.length) {
  console.error(`\nsmoke FAILED against ${base}: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\nsmoke passed against ${base}`);
