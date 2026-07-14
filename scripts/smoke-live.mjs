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
//   4. the HTML entry point serves Cache-Control: no-cache (remote targets
//      only). The HTML is the single freshness root: every JS module URL is
//      stamped per deploy (scripts/stamp-site.mjs) and the wasm URL carries
//      its content hash (build-wasm.sh), so cached JS and wasm files are
//      version-keyed and harmless, but the HTML must always revalidate.
//      Only the HTML is asserted because the diff.wtf zone's Browser Cache
//      TTL setting rewrites browser-facing headers on edge-cacheable types
//      (.js) regardless of the origin's _headers policy; HTML passes
//      through untouched (verified 2026-07-14, CI run 12 postmortem);
//   5. with --expect-stamp <stamp>: the served HTML references
//      js/app.js?v=<stamp>, proving the deploy that just ran is what the
//      target actually serves.
//
// Remote fetch checks retry for up to a minute to absorb edge propagation
// right after a deploy; the browser checks run once after they settle.
//
// Usage:
//   node scripts/smoke-live.mjs https://diff.wtf [--expect-stamp abc12345]
//   node scripts/smoke-live.mjs --serve web [--expect-stamp abc12345]
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
let serveDir = null;
let expectStamp = null;
let url = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--serve') serveDir = args[++i];
  else if (args[i] === '--expect-stamp') expectStamp = args[++i];
  else url = args[i];
}
let server = null;
let base;
let remote;
if (serveDir) {
  server = await serve(serveDir);
  base = `http://127.0.0.1:${server.address().port}`;
  remote = false;
} else if (url) {
  base = url.replace(/\/$/, '');
  remote = true;
} else {
  console.error('usage: smoke-live.mjs <url> [--expect-stamp s] | smoke-live.mjs --serve <dir> [--expect-stamp s]');
  process.exit(2);
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures.push(label);
};

// 4 + 5. Plain HTTP checks before the browser run, retried on remote
// targets so a deploy that is still propagating through the edge gets up to
// a minute to settle instead of failing the gate spuriously.
{
  const attempt = async () => {
    const out = { ok: true, lines: [] };
    const res = await fetch(`${base}/`, { redirect: 'follow' });
    const cc = res.headers.get('cache-control') ?? '(none)';
    if (remote) {
      const ccOk = res.ok && cc.includes('no-cache');
      out.ok &&= ccOk;
      out.lines.push([ccOk, 'HTML always revalidates', `HTTP ${res.status}, cache-control: ${cc}`]);
    }
    if (expectStamp) {
      const html = await res.text();
      const needle = `js/app.js?v=${expectStamp}`;
      const stampOk = res.ok && html.includes(needle);
      out.ok &&= stampOk;
      out.lines.push([stampOk, 'deployed stamp is live', `HTML ${stampOk ? 'references' : 'does not reference'} ${needle}`]);
    }
    return out;
  };
  let last = null;
  const attempts = remote ? 12 : 1;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5000));
    try {
      last = await attempt();
    } catch (err) {
      last = { ok: false, lines: [[false, 'fetch checks', String(err)]] };
    }
    if (last.ok) break;
  }
  for (const [ok, label, detail] of last?.lines ?? []) check(ok, label, detail);
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
