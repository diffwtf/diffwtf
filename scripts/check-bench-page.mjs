#!/usr/bin/env node
// scripts/check-bench-page.mjs: headless Playwright render check for the
// benchmarks page (M11, issue #11). Complements scripts/gen-bench-page.mjs
// --check, which pins the page's NUMBERS to the committed benchmark
// artifacts byte for byte; this script asserts the page actually RENDERS:
//
//   1. web/benchmarks.html loads with no page or console errors;
//   2. every chart is an inline SVG with an accessible name (role img,
//      aria-labelledby resolving to a real title and desc), and each chart
//      has a data table fallback with rows;
//   3. the home page links to the benchmarks page (nav and chart caption)
//      and the link navigates;
//   4. the benchmarks page makes no request beyond its own origin (fonts
//      are self-hosted; same privacy bar as the tool page);
//   5. the home "Why it's fast" chart card renders its generated bars and
//      caption links.
//
// Usage: node scripts/check-bench-page.mjs [--serve web]
// Requires Playwright with Chromium (PLAYWRIGHT_BASE fallback as in the
// other checks). Does not require web/pkg: the benchmarks page is static.

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
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
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
  const u = new URL(req.url());
  if (u.origin !== base) offOrigin.push(req.url());
});

try {
  // ---- benchmarks page ----------------------------------------------------
  await page.goto(`${base}/benchmarks.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check(
    (await page.title()).includes('Benchmarks'),
    'benchmarks page loads with its title',
    `title ${JSON.stringify(await page.title())}`,
  );

  const svgs = await page.evaluate(() => {
    return [...document.querySelectorAll('main svg')].map((svg) => {
      const ids = (svg.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      const resolved = ids.map((id) => document.getElementById(id));
      return {
        role: svg.getAttribute('role'),
        labelled: ids.length >= 2 && resolved.every((el) => el && el.textContent.trim().length > 0),
        title: resolved[0]?.textContent.trim() ?? '',
        width: svg.getBoundingClientRect().width,
      };
    });
  });
  check(svgs.length >= 4, 'all charts present as inline SVG', `${svgs.length} SVGs found`);
  for (const svg of svgs) {
    check(
      svg.role === 'img' && svg.labelled && svg.width > 200,
      `chart has an accessible name and renders: ${svg.title.slice(0, 60) || '(untitled)'}`,
      `role ${svg.role}, labelled ${svg.labelled}, width ${Math.round(svg.width)}px`,
    );
  }

  const tables = await page.evaluate(() =>
    [...document.querySelectorAll('main table.bench-table')].map((t) => ({
      id: t.id,
      caption: t.querySelector('caption')?.textContent.trim() ?? '',
      rows: t.querySelectorAll('tbody tr').length,
    })),
  );
  check(tables.length >= 4, 'data table fallbacks present', `${tables.length} tables`);
  for (const t of tables) {
    check(t.rows > 0 && t.caption.length > 0, `table ${t.id} has a caption and rows`, `${t.rows} rows`);
  }

  const backLink = await page.getAttribute('a.back-link', 'href');
  check(backLink === './', 'back link points home', `href ${JSON.stringify(backLink)}`);

  // ---- home page links and generated card ---------------------------------
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const navHref = await page.getAttribute('nav.site-nav a[href="benchmarks.html"]', 'href');
  check(navHref === 'benchmarks.html', 'home nav links to the benchmarks page');
  const captionHref = await page.getAttribute('.chart-caption a[href="benchmarks.html"]', 'href');
  check(captionHref === 'benchmarks.html', 'home chart caption links to the benchmarks page');

  const bars = await page.evaluate(() =>
    [...document.querySelectorAll('.chart-fill')].map((el) => ({
      width: el.getBoundingClientRect().width,
      // The value is the last label span; it carries .accent on the engine bar
      // but not on the jsdiff comparison bar (a different series color), so read
      // it by position rather than by color class.
      value: el.closest('.chart-bar')?.querySelector('.chart-labels span:last-child')?.textContent ?? '',
    })),
  );
  check(
    bars.length === 2 && bars.every((b) => b.width > 0 && / ms$/.test(b.value)),
    'home chart bars render with ms values',
    JSON.stringify(bars),
  );

  await page.click('nav.site-nav a[href="benchmarks.html"]');
  await page.waitForLoadState('domcontentloaded');
  check(
    page.url().endsWith('/benchmarks.html'),
    'nav link navigates to the benchmarks page',
    page.url(),
  );

  // ---- privacy and page health --------------------------------------------
  check(offOrigin.length === 0, 'no request left the origin', offOrigin.slice(0, 3).join(' | '));
  // The home page load starts the engine; ignore nothing, a broken pkg is a
  // real failure the other checks also catch.
  check(pageErrors.length === 0, 'no page or console errors', pageErrors.join(' | ').slice(0, 500));
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\ncheck-bench-page FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall benchmarks page render checks passed');
