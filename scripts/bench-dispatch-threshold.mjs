#!/usr/bin/env node
// Measures the M12 synchronous-dispatch budget in real Chromium. Inputs are
// deterministic complete rewrites, the engine's known slowest shape. The
// budget covers only compute() (engine plus sparse-result marshal), because
// both dispatch routes build the row model or full views on the main thread
// after the sparse typed arrays arrive. Full assembly is reported separately
// for visibility, but is not part of the routing threshold.
//
// Each candidate gets 10 warmups and 50 measured runs. Usage:
//   node scripts/bench-dispatch-threshold.mjs
// Committed record: scripts/bench-dispatch-threshold.results.txt

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';

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

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.includes('..')) throw new Error('traversal');
    const body = await readFile(join(process.cwd(), path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/web/index.html`);

const candidates = await page.evaluate(async () => {
  const glue = await import('/web/pkg/diffwtf_wasm.js');
  await glue.default();
  const { assembleDiffResult } = await import('/web/js/assemble.js');
  const { createRowModel } = await import('/web/js/rowmodel.js');
  const encoder = new TextEncoder();
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[24] + sorted[25]) / 2;
  };
  const build = (lineCount, tag) => Array.from(
    { length: lineCount },
    (_, i) => `${tag}${String(i).padStart(5, '0')} alpha bravo charlie delta`,
  ).join('\n') + '\n';

  const results = [];
  for (const lines of [750, 800, 850, 875, 900, 925, 950, 1000, 1500, 3000]) {
    const left = build(lines, 'a');
    const right = build(lines, 'b');
    const medians = {};
    for (const granularity of ['word', 'char']) {
      for (let i = 0; i < 10; i++) {
        const sparse = glue.compute(left, right, granularity);
        createRowModel(left, right, sparse);
        assembleDiffResult(left, right, sparse);
      }
      const times = { compute: [], model: [], assembly: [] };
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now();
        const sparse = glue.compute(left, right, granularity);
        const t1 = performance.now();
        createRowModel(left, right, sparse);
        const t2 = performance.now();
        assembleDiffResult(left, right, sparse);
        const t3 = performance.now();
        times.compute.push(t1 - t0);
        times.model.push(t2 - t1);
        times.assembly.push(t3 - t2);
      }
      medians[granularity] = {
        compute: median(times.compute),
        model: median(times.model),
        assembly: median(times.assembly),
      };
    }
    results.push({
      lines,
      bytes: encoder.encode(left).byteLength + encoder.encode(right).byteLength,
      word: medians.word,
      char: medians.char,
    });
  }
  return results;
});

await browser.close();
server.close();

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* fine outside a git checkout */
}
const fmt = (ms) => `${ms.toFixed(2)} ms`;
console.log('# diff.wtf M12 sync-dispatch threshold benchmark');
console.log(`# node ${process.version} · Chromium · ${cpus()[0]?.model ?? 'unknown CPU'} · commit ${commit}`);
console.log('# deterministic complete rewrites; 10 warmups; medians of 50 runs per granularity');
console.log('# budget column is wasm compute() including sparse-result marshal; row model and full assembly run on the main thread in both routes and are informational');
console.log('');
for (const r of candidates) {
  console.log(
    `${r.bytes.toLocaleString('en-US')} combined bytes (${r.lines} lines/side): ` +
      `word ${fmt(r.word.compute)} · char ${fmt(r.char.compute)} · ` +
      `row model ${fmt(Math.max(r.word.model, r.char.model))} · full assembly ${fmt(Math.max(r.word.assembly, r.char.assembly))}`,
  );
}
const eligible = candidates.filter((r) => Math.max(r.word.compute, r.char.compute) < 8);
const threshold = eligible.reduce((best, r) => (r.bytes > best.bytes ? r : best));
console.log('');
console.log(
  `# largest measured candidate under 8 ms in both granularities: ${threshold.bytes.toLocaleString('en-US')} combined bytes ` +
    `(word ${fmt(threshold.word.compute)}, char ${fmt(threshold.char.compute)})`,
);
