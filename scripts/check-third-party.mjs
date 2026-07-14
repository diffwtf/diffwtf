#!/usr/bin/env node
// scripts/check-third-party.mjs: headless Playwright privacy gate. Locks in
// the 2026-07 audit result that the site contacts no third party: fonts are
// self-hosted (web/fonts/, web/css/fonts.css), so every request a page makes
// must go to the serving host and nowhere else. Asserts, for / and
// /privacy.html:
//
//   1. the set of hostnames requested during load and font settling is
//      EXACTLY the serving host — not a subset check: an unexpected host
//      fails, and a page that somehow made no requests at all fails too;
//   2. the design's fonts actually apply and load from those same-origin
//      files: computed font-family on the headline is Space Grotesk and on
//      the design's mono elements is JetBrains Mono, and document.fonts
//      reports loaded faces for both families (a missing/misnamed woff2
//      would silently fall back to system fonts and pass a style-only
//      check);
//   3. zero page or console errors while doing all of the above.
//
// Usage: node scripts/check-third-party.mjs [--serve web]
// Requires Playwright with Chromium (PLAYWRIGHT_BASE fallback as in the
// other checks). Runs pre-deploy against the built site; the post-promote
// smoke (scripts/smoke-live.mjs) covers the live zone.

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
const servingHost = new URL(base).hostname;

// Per page: the selectors whose computed font-family pins each design font.
const PAGES = [
  { path: '/', head: '.hero h1', mono: '.wordmark' },
  { path: '/privacy.html', head: '.privacy-main h1', mono: '.privacy-main p.privacy-updated' },
];

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();

try {
  for (const { path, head, mono } of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
    });
    const hosts = new Set();
    page.on('request', (req) => hosts.add(new URL(req.url()).hostname));

    await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 30000 });
    // Fonts load lazily once rendered text needs them; settle before
    // tallying hostnames so a late off-origin font fetch cannot slip past.
    await page.evaluate(() => document.fonts.ready);

    const hostList = [...hosts].sort();
    check(
      hostList.length === 1 && hostList[0] === servingHost,
      `${path}: request hostnames are exactly the serving host`,
      `saw [${hostList.join(', ')}], expected [${servingHost}]`,
    );

    const styles = await page.evaluate(
      ([h, m]) => ({
        head: getComputedStyle(document.querySelector(h)).fontFamily,
        mono: getComputedStyle(document.querySelector(m)).fontFamily,
        loaded: [...document.fonts]
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family.replace(/^["']|["']$/g, '')),
      }),
      [head, mono],
    );
    check(
      styles.head.includes('Space Grotesk'),
      `${path}: headline (${head}) uses Space Grotesk`,
      `computed font-family: ${styles.head}`,
    );
    check(
      styles.mono.includes('JetBrains Mono'),
      `${path}: mono element (${mono}) uses JetBrains Mono`,
      `computed font-family: ${styles.mono}`,
    );
    check(
      styles.loaded.includes('Space Grotesk') && styles.loaded.includes('JetBrains Mono'),
      `${path}: both font families loaded from the self-hosted files`,
      `loaded faces: [${[...new Set(styles.loaded)].join(', ')}]`,
    );

    check(pageErrors.length === 0, `${path}: no page or console errors`, pageErrors.join(' | ').slice(0, 500));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\ncheck-third-party FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nall third-party and font checks passed');
