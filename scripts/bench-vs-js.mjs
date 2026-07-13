#!/usr/bin/env node
// scripts/bench-vs-js.mjs — the reproducible marketing benchmark behind the
// "Why it's fast" numbers on the site (CLAUDE.md: honest numbers only).
//
// Compares, on the same committed fixture inputs:
//
//   js:   reference/refdiff.mjs compute(), the repo's dependency-free port of
//         the design prototype's diff (a faithful stand-in for a pure-JS diff
//         tool of this feature set), and
//   wasm: the shipped engine, web/pkg/diffwtf_wasm.js compute(), timed
//         end-to-end around the call exactly like the site's perf badge, so
//         the number includes serializing the DiffResult across the JS/wasm
//         boundary.
//
// Both run in the same Node process (V8, the engine Chrome uses). Caveat,
// flagged openly: this is Node's WebAssembly runtime, not a browser page, but
// the wasm module and JS glue are byte-identical to what the site loads, and
// V8 executes both sides, so relative numbers carry over.
//
// Methodology: per case and side, WARMUP unmeasured runs to let the JIT
// settle, then ITERATIONS measured runs; the reported number is the median.
// Sides are interleaved per case (js, wasm, js, wasm, ...) so neither gets a
// systematic thermal or GC advantage. Requires web/pkg (./scripts/build-wasm.sh).
//
// Usage: node scripts/bench-vs-js.mjs
// The committed record of a real run lives at scripts/bench-vs-js.results.txt;
// regenerate it by piping stdout there and committing the diff.

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { compute as jsCompute } from '../reference/refdiff.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WARMUP = 10;
const ITERATIONS = 50;

// Committed inputs only, so any checkout reproduces the run.
const CASES = [
  {
    name: 'sample-rust',
    note: 'the "Load example" pair every visitor sees',
    left: 'fixtures/cases/sample-rust.left.txt',
    right: 'fixtures/cases/sample-rust.right.txt',
  },
  {
    name: 'large-perf',
    note: '5,000-line / 150 KB file, 44 edited lines (the marketing chart case)',
    left: 'fixtures/cases/large-perf.left.txt',
    right: 'fixtures/cases/large-perf.right.txt',
  },
  {
    name: 'large-identical',
    note: 'the same 5,000-line file on both sides: isolates result-transfer cost',
    left: 'fixtures/cases/large-perf.left.txt',
    right: 'fixtures/cases/large-perf.left.txt',
  },
];

function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(ms) {
  return ms < 1 ? `${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`;
}

const initWasm = (await import(join(ROOT, 'web/pkg/diffwtf_wasm.js'))).default;
const { compute: wasmCompute } = await import(join(ROOT, 'web/pkg/diffwtf_wasm.js'));
await initWasm({ module_or_path: readFileSync(join(ROOT, 'web/pkg/diffwtf_wasm_bg.wasm')) });

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch {
  /* fine outside a git checkout */
}
console.log(`# diff.wtf benchmark: JS reference vs shipped wasm engine`);
console.log(`# node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · commit ${commit}`);
console.log(`# median of ${ITERATIONS} runs after ${WARMUP} warmup runs, word granularity, interleaved`);
console.log('');

const summary = [];
for (const c of CASES) {
  const left = readFileSync(join(ROOT, c.left), 'utf8');
  const right = readFileSync(join(ROOT, c.right), 'utf8');

  const sides = [
    { key: 'js', run: () => jsCompute(left, right, 'word') },
    { key: 'wasm', run: () => wasmCompute(left, right, 'word') },
  ];

  // Sanity: both engines must agree on the headline counts before we time them.
  const jsResult = jsCompute(left, right, 'word');
  const wasmResult = wasmCompute(left, right, 'word');
  if (jsResult.added !== wasmResult.added || jsResult.removed !== wasmResult.removed) {
    throw new Error(
      `${c.name}: engines disagree ` +
        `(js +${jsResult.added}/-${jsResult.removed}, wasm +${wasmResult.added}/-${wasmResult.removed})`,
    );
  }

  for (const side of sides) {
    for (let i = 0; i < WARMUP; i++) side.run();
    side.times = [];
  }
  for (let i = 0; i < ITERATIONS; i++) {
    for (const side of sides) {
      const t0 = performance.now();
      side.run();
      side.times.push(performance.now() - t0);
    }
  }

  const [js, wasm] = sides.map((s) => median(s.times));
  summary.push({ name: c.name, js, wasm });
  console.log(`${c.name}: ${c.note}`);
  console.log(`  input: ${left.length.toLocaleString('en-US')} + ${right.length.toLocaleString('en-US')} chars, +${jsResult.added}/-${jsResult.removed} lines`);
  console.log(`  js reference    ${fmt(js)}`);
  console.log(`  wasm end-to-end ${fmt(wasm)}`);
  console.log(`  ratio (js/wasm) ${(js / wasm).toFixed(2)}x`);
  console.log('');
}

console.log('# summary (medians)');
for (const s of summary) {
  console.log(`# ${s.name}: js ${fmt(s.js)} vs wasm ${fmt(s.wasm)} -> ${(s.js / s.wasm).toFixed(2)}x`);
}
