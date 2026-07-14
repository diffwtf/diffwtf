#!/usr/bin/env node
// scripts/smoke-live.mjs: headless smoke test of the diff.wtf shell, run by
// the deploy pipeline three times: against the exact stamped artifact that
// will ship (--serve <dir>), against the Pages preview deployment, and
// against production after promotion. It exists because two deploys in a
// row broke the live site in ways nothing tested:
//
//   2026-07-13 (M9): CI validated one locally built site, the deploy
//   workflow rebuilt and shipped different bytes, and returning visitors'
//   cached JS glue failed to link against the new wasm (DECISIONS.md D7).
//
//   2026-07-14 (M10): the artifact was complete and correct, but for a
//   window after "Deployment complete" the Pages edge served the SPA
//   fallback (index.html, text/html) for newly uploaded module scripts,
//   so the compute worker and the main-thread fallback both failed strict
//   MIME checking and the engine never initialized for visitors in that
//   window. The one-shot post-deploy smoke caught it 8 seconds after the
//   deploy and correctly went red; nothing before production had loaded
//   the worker chain over real hosting.
//
// Asserts, per attempt:
//   1. module graph integrity: starting from index.html, every same-origin
//      script, wasm, and stylesheet the page or its worker loads (imports,
//      dynamic imports, new URL / new Worker references, followed
//      transitively) answers 200 with a sane MIME type for its extension.
//      A missing file disguised as HTML by a hosting fallback dies here,
//      by URL, instead of as a cryptic MIME console error. The scan must
//      reach the worker, the wasm glue, and the wasm binary, so a refactor
//      that hides them from the scan fails loudly too.
//   2. the engine initializes: the perf badge reaches "ready · engine
//      loaded" (a glue/wasm version mismatch dies here as a LinkError);
//   3. the compute worker is actually running: the engine falls back to
//      main-thread compute if the worker cannot start, which keeps old
//      browsers working but must never mask a broken worker URL in this
//      Chromium run (the M10 incident would have passed a smoke that only
//      checked the badge, had the fallback import not also been hit);
//   4. a diff actually renders: typed input produces rows and real counts;
//   5. zero page errors and zero console errors during all of the above;
//   6. the HTML entry point serves Cache-Control: no-cache (remote targets
//      only). The HTML is the single freshness root: every JS module URL is
//      stamped per deploy (scripts/stamp-site.mjs) and the wasm URL carries
//      its content hash (build-wasm.sh), so cached JS and wasm files are
//      version-keyed and harmless, but the HTML must always revalidate.
//      Only the HTML is asserted because the diff.wtf zone's Browser Cache
//      TTL setting rewrites browser-facing headers on edge-cacheable types
//      (.js) regardless of the origin's _headers policy; HTML passes
//      through untouched (verified 2026-07-14, CI run 12 postmortem);
//   7. with --expect-stamp <stamp>: the served HTML references
//      js/app.js?v=<stamp>, proving the deploy that just ran is what the
//      target actually serves;
//   8. the static pages (/privacy.html, /benchmarks.html) answer 200 as
//      text/html and load in the browser with zero page or console errors;
//   9. with --compare-origin <url> (the post-promote run passes the
//      pages.dev production deployment): each static page's body through
//      the zone is byte-identical to the same path on that origin — the
//      tested-bytes-equals-served-bytes invariant. Any zone mutation of
//      the body fails here, naming the first differing byte offset.
//
// Remote targets get a bounded retry of the WHOLE attempt (fetch, graph,
// and browser checks) so edge propagation right after a deploy is absorbed
// instead of failing a healthy deploy, while a target that never converges
// inside the window still fails. Local (--serve) targets run once.
//
// Usage:
//   node scripts/smoke-live.mjs https://diff.wtf [--expect-stamp abc12345] [--compare-origin https://diffwtf.pages.dev]
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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
let compareOrigin = null;
let url = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--serve') serveDir = args[++i];
  else if (args[i] === '--expect-stamp') expectStamp = args[++i];
  else if (args[i] === '--compare-origin') compareOrigin = args[++i].replace(/\/$/, '');
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

// ---------------------------------------------------------------------------
// Module graph scan
// ---------------------------------------------------------------------------

// import ... from '...', import('...'), new URL('...'), new Worker('...').
// The optional whitespace matters because the deployed artifact's modules
// are minified (for example, `from"./engine.js"`), while the committed
// sources are not; the scan must handle both.
const REF_RE = /(?:from\s*|import\s*\(\s*|new\s+(?:URL|Worker)\s*\(\s*)['"]([^'"]+)['"]/g;
const HTML_REF_RE = /(?:src|href)="([^"]+)"/g;
const CSS_REF_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
const SCAN_EXT = /\.(?:m?js|wasm|css|svg|ico|png|woff2)$/;
const EXPECT_MIME = [
  [/\.m?js$/, /javascript/],
  [/\.wasm$/, /wasm/],
  [/\.css$/, /css/],
  [/\.svg$/, /image\/svg\+xml/],
  [/\.ico$/, /image\/(?:x-icon|vnd\.microsoft\.icon)/],
  [/\.png$/, /image\/png/],
  [/\.woff2$/, /font\/woff2/],
];
// The scan is only trustworthy if it still reaches the engine's moving
// parts; if a refactor renames or hides these, fail the scan itself. The
// self-hosted font files are load-bearing the same way: a deploy that
// loses them degrades silently to system fonts.
const MUST_REACH = [
  '/js/app.js', '/js/worker.js', '/pkg/diffwtf_wasm.js', '/pkg/diffwtf_wasm_bg.wasm',
  '/favicon.svg', '/favicon.ico', '/apple-touch-icon.png',
  '/css/fonts.css', '/fonts/space-grotesk-v22-latin.woff2', '/fonts/jetbrains-mono-v24-latin.woff2',
];

async function moduleGraphProblems() {
  const origin = new URL(`${base}/`).origin;
  const seen = new Set(); // pathnames already checked
  const problems = [];
  const queue = [{ href: `${base}/`, kind: 'html' }];
  while (queue.length) {
    const { href, kind } = queue.shift();
    const pathname = new URL(href).pathname;
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    let res;
    try {
      res = await fetch(href, { redirect: 'follow' });
    } catch (err) {
      problems.push(`${pathname}: fetch failed (${err})`);
      continue;
    }
    const type = res.headers.get('content-type') ?? '(none)';
    if (!res.ok) {
      problems.push(`${pathname}: HTTP ${res.status}`);
      continue;
    }
    const expect = kind === 'html' ? [/./, /html/] : EXPECT_MIME.find(([ext]) => ext.test(pathname));
    if (expect && !expect[1].test(type)) {
      problems.push(`${pathname}: served as ${type} (a hosting fallback is likely masking a missing file)`);
      continue;
    }
    if (kind === 'wasm' || kind === 'image' || kind === 'font') continue;
    const text = await res.text();
    const re = kind === 'html' ? HTML_REF_RE : kind === 'css' ? CSS_REF_RE : REF_RE;
    for (const match of text.matchAll(re)) {
      let ref;
      try {
        ref = new URL(match[1], href);
      } catch {
        continue;
      }
      if (ref.origin !== origin || !SCAN_EXT.test(ref.pathname)) continue;
      const ext = ref.pathname.match(SCAN_EXT)[0];
      queue.push({
        href: ref.href,
        kind: ext === '.css' ? 'css' : ext === '.wasm' ? 'wasm' : ext === '.woff2' ? 'font' : /\.(?:svg|ico|png)$/.test(ext) ? 'image' : 'js',
      });
    }
  }
  for (const path of MUST_REACH) {
    if (!seen.has(path)) {
      problems.push(`scan never reached ${path}; the module graph or this scan needs updating`);
    }
  }
  return { problems, scanned: seen.size };
}

// ---------------------------------------------------------------------------
// One full attempt: fetch checks, module graph, browser checks
// ---------------------------------------------------------------------------

const STATIC_PAGES = ['/privacy.html', '/benchmarks.html'];

async function runAttempt(browser) {
  const lines = []; // [ok, label, detail]
  const push = (ok, label, detail = '') => lines.push([ok, label, detail]);

  // 6 + 7. Plain HTTP checks on the entry point.
  try {
    const res = await fetch(`${base}/`, { redirect: 'follow' });
    const html = await res.text();
    if (remote) {
      const cc = res.headers.get('cache-control') ?? '(none)';
      push(res.ok && cc.includes('no-cache'), 'HTML always revalidates', `HTTP ${res.status}, cache-control: ${cc}`);
    }
    if (expectStamp) {
      const needle = `js/app.js?v=${expectStamp}`;
      push(res.ok && html.includes(needle), 'deployed stamp is live', `HTML ${html.includes(needle) ? 'references' : 'does not reference'} ${needle}`);
    }
  } catch (err) {
    push(false, 'entry point fetch', String(err));
  }

  // 1. Module graph integrity.
  const graph = await moduleGraphProblems();
  push(
    graph.problems.length === 0,
    'asset graph: every script, wasm, stylesheet, font, and icon serves with a sane MIME type',
    graph.problems.length ? graph.problems.slice(0, 4).join(' | ') : `${graph.scanned} files scanned from index.html`,
  );

  // 8 + 9. Static pages serve as HTML, load without errors, and (with
  // --compare-origin) arrive through the zone byte-identical to the same
  // path on the origin deployment: tested bytes are served bytes.
  for (const path of STATIC_PAGES) {
    let body = null;
    try {
      const res = await fetch(`${base}${path}`, { redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '(none)';
      body = new Uint8Array(await res.arrayBuffer());
      push(
        res.status === 200 && /html/.test(type),
        `${path} answers 200 as HTML`,
        `HTTP ${res.status}, content-type: ${type}`,
      );
    } catch (err) {
      push(false, `${path} answers 200 as HTML`, String(err));
    }
    if (compareOrigin && body) {
      try {
        const res = await fetch(`${compareOrigin}${path}`, { redirect: 'follow' });
        const other = new Uint8Array(await res.arrayBuffer());
        const n = Math.min(body.length, other.length);
        let diff = -1;
        for (let i = 0; i < n; i++) {
          if (body[i] !== other[i]) { diff = i; break; }
        }
        if (diff === -1 && body.length !== other.length) diff = n;
        push(
          res.ok && diff === -1,
          `${path} is byte-identical to ${compareOrigin}${path}`,
          diff === -1
            ? `${body.length} bytes match`
            : `bodies FIRST DIFFER AT BYTE OFFSET ${diff} (zone ${body.length} B, origin ${other.length} B): the zone is mutating served bytes`,
        );
      } catch (err) {
        push(false, `${path} is byte-identical to ${compareOrigin}${path}`, String(err));
      }
    }
    const staticPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const staticErrors = [];
    staticPage.on('pageerror', (err) => staticErrors.push(`pageerror: ${err}`));
    staticPage.on('console', (msg) => {
      if (msg.type() === 'error') staticErrors.push(`console: ${msg.text()}`);
    });
    try {
      await staticPage.goto(`${base}${path}`, { waitUntil: 'load', timeout: 30000 });
      push(staticErrors.length === 0, `${path} loads with no page or console errors`, staticErrors.join(' | ').slice(0, 500));
    } catch (err) {
      push(false, `${path} loads with no page or console errors`, String(err).slice(0, 300));
    } finally {
      await staticPage.close();
    }
  }

  // 2 to 5. Browser checks on a fresh page.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  try {
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Engine initializes. A stale-glue LinkError leaves the badge stuck
    // on "loading engine…" and surfaces in `errors` below.
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
    push(
      engineReady,
      'engine initializes',
      `badge reads ${JSON.stringify(await page.textContent('#perf-text'))}`,
    );

    // 3. The worker must actually be running: the engine's main-thread
    // fallback exists for browsers without module workers, and this run is
    // Chromium, so reaching ready without a worker means the worker chain
    // is broken and was silently papered over.
    const workerUrls = page.workers().map((w) => w.url());
    push(
      engineReady && workerUrls.some((u) => /\/js\/worker\.js/.test(u)),
      'compute worker is running (not the silent main-thread fallback)',
      workerUrls.length ? `workers: ${workerUrls.join(', ')}` : 'no workers on the page',
    );

    // 4. A diff renders end to end. Since M10 the compute runs in the
    // worker, so the badge updates asynchronously after the input events;
    // wait for it to leave the ready/computing states before asserting.
    if (engineReady) {
      await page.fill('#left-text', 'a\nb\nc');
      await page.fill('#right-text', 'a\nX\nc');
      try {
        await page.waitForFunction(
          () => /^\d/.test(document.getElementById('perf-text')?.textContent ?? ''),
          undefined,
          { timeout: 10000 },
        );
      } catch {
        /* the badge assertion below reports the actual state */
      }
      const badge = await page.textContent('#perf-text');
      const added = await page.textContent('#stat-added');
      const rows = await page.evaluate(
        () => document.querySelectorAll('#diff-body .row-split, #diff-body .row-unified').length,
      );
      push(
        /^3 lines · [\d.,<]+ ms · engine$/.test(badge) && added === '+1' && rows === 3,
        'diff renders',
        `badge ${JSON.stringify(badge)}, added ${JSON.stringify(added)}, rows ${rows}`,
      );
    }

    // 5. No errors anywhere in the attempt.
    push(errors.length === 0, 'no page or console errors', errors.join(' | ').slice(0, 500));
  } catch (err) {
    push(false, 'browser checks', String(err).slice(0, 300));
  } finally {
    await page.close();
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Attempt loop: absorb edge propagation on remote targets, bounded
// ---------------------------------------------------------------------------

const ATTEMPTS = remote ? 5 : 1;
const RETRY_DELAY_MS = 15000;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

let lines = [];
try {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`attempt ${attempt - 1} failed; retrying in ${RETRY_DELAY_MS / 1000} s (attempt ${attempt} of ${ATTEMPTS}, absorbing edge propagation)`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    lines = await runAttempt(browser);
    if (lines.every(([ok]) => ok)) break;
  }
} finally {
  await browser.close();
  server?.close();
}

const failures = [];
for (const [ok, label, detail] of lines) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

if (failures.length) {
  console.error(`\nsmoke FAILED against ${base}: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`\nsmoke passed against ${base}`);
