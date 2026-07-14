#!/usr/bin/env node
// Browser conformance for the M12 transport layer. Every committed fixture
// runs through createEngine().diff() twice, forcing the direct and worker
// routes behind the same public promise API. Both assembled outputs must
// equal the committed reference output and each other. The final check mixes
// routes to prove an older worker result cannot outlive a newer sync result.
//
// Usage: node scripts/conformance-dispatch.mjs [--serve web]

import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
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
};

const args = process.argv.slice(2);
let serveDir = 'web';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--serve') serveDir = args[++i];
}

const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.includes('..')) throw new Error('traversal');
    if (path === '/' || path === '') path = '/index.html';
    const body = await readFile(join(serveDir, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const names = readdirSync('fixtures/cases')
  .filter((file) => file.endsWith('.left.txt'))
  .map((file) => file.slice(0, -'.left.txt'.length))
  .sort();
const fixtures = [];
for (const name of names) {
  for (const granularity of ['word', 'char']) {
    fixtures.push({
      name,
      granularity,
      left: readFileSync(`fixtures/cases/${name}.left.txt`, 'utf8'),
      right: readFileSync(`fixtures/cases/${name}.right.txt`, 'utf8'),
      expected: JSON.parse(readFileSync(`fixtures/expected/${name}.${granularity}.json`, 'utf8')),
    });
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/`);
const result = await page.evaluate(async (cases) => {
  const { createEngine } = await import('/js/engine.js');
  const { assembleDiffResult } = await import('/js/assemble.js');
  const sync = createEngine({ forceRoute: 'sync' });
  const worker = createEngine({ forceRoute: 'worker' });
  if (!(await sync.ready) || !(await worker.ready)) throw new Error('engine failed to initialize');

  const failures = [];
  for (const c of cases) {
    const directResult = await sync.diff(c.left, c.right, c.granularity);
    const workerResult = await worker.diff(c.left, c.right, c.granularity);
    const direct = assembleDiffResult(c.left, c.right, directResult.sparse);
    const offThread = assembleDiffResult(c.left, c.right, workerResult.sparse);
    const expected = JSON.stringify(c.expected);
    if (directResult.timingLabel !== 'engine') failures.push(`${c.name} (${c.granularity}): direct label`);
    if (workerResult.timingLabel !== 'incl worker') failures.push(`${c.name} (${c.granularity}): worker label`);
    if (JSON.stringify(direct) !== expected) failures.push(`${c.name} (${c.granularity}): direct output`);
    if (JSON.stringify(offThread) !== expected) failures.push(`${c.name} (${c.granularity}): worker output`);
    if (JSON.stringify(direct) !== JSON.stringify(offThread)) failures.push(`${c.name} (${c.granularity}): route mismatch`);
  }

  let progressResolve = null;
  const hybrid = createEngine({
    onWorkerProgress: () => {
      if (progressResolve) progressResolve();
    },
  });
  await hybrid.ready;
  const atThreshold = await hybrid.diff('a'.repeat(56_100), '', 'word');
  const aboveThreshold = await hybrid.diff('a'.repeat(56_101), '', 'word');
  const multibyteAbove = await hybrid.diff('é'.repeat(28_051), '', 'word');
  if (atThreshold?.timingLabel !== 'engine') failures.push('routing: threshold equality was not sync');
  if (aboveThreshold?.timingLabel !== 'incl worker') failures.push('routing: threshold + 1 was not worker');
  if (multibyteAbove?.timingLabel !== 'incl worker') failures.push('routing: UTF-8 multibyte size was not worker');

  const build = (count, tag) => Array.from(
    { length: count },
    (_, i) => `${tag}${i} alpha bravo charlie delta`,
  ).join('\n');
  const progress = new Promise((resolve) => {
    progressResolve = resolve;
  });
  const oldWorker = hybrid.diff(build(3000, 'a'), build(3000, 'b'), 'word');
  await progress;
  const newSync = await hybrid.diff('old', 'new', 'word');
  const stale = await oldWorker;
  if (newSync?.timingLabel !== 'engine') failures.push('mixed ordering: newer request did not use sync');
  if (stale !== null) failures.push('mixed ordering: older worker result was not suppressed');
  return failures;
}, fixtures);

await browser.close();
server.close();

if (result.length) {
  console.error(`${result.length} dispatch conformance failure(s):`);
  for (const failure of result) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`all ${names.length} cases conform at both granularities through direct and worker routes`);
console.log('mixed-route ordering suppresses an older worker result after a newer sync result');
