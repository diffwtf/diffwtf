#!/usr/bin/env node
// scripts/bench-vs-js.mjs: the reproducible benchmark any speed number shown
// on the site must be reconciled against (CLAUDE.md: honest numbers only).
// The "Why it's fast" chart in web/index.html still displays M8-era values
// that this rewrite supersedes; reconciling the chart from this script's
// committed results is tracked as issue #11.
//
// Compares, per input case, the two ways this repo can produce the exact
// same end state (renderable Split and Unified rows) from two strings:
//
//   js:   reference/refdiff.mjs compute(), the repo's dependency-free port
//         of the design prototype's diff (a faithful stand-in for a pure-JS
//         diff tool of this feature set). It is single-pass: line diff,
//         intra-line refinement, and view materialization happen in one
//         call, so only its total is reportable; it has no boundary and no
//         separate assembly phase.
//   wasm: the shipped engine modules run in-process: web/pkg compute()
//         returning the sparse v2 result (run-length ops plus highlight
//         ranges), then the two ways the repo turns ops into renderable
//         rows: the full materialization (web/js/assemble.js, the pre-M10
//         page path and the fair comparison against js, which also
//         materializes everything) and the M10 page path (web/js/
//         rowmodel.js lazy model plus a 60-row window, which is all the
//         virtualized renderer ever asks for per frame).
//
// Phases reported for the wasm side:
//
//   engine (probe)     compute_probe(): input string copy-in plus the full
//                      diff inside wasm, returning only a u32 checksum that
//                      folds in every op and span, so no result marshalling
//                      and no skippable work.
//   compute call       compute(): the same work plus building the typed
//                      arrays and the result object across the boundary.
//   result marshal     DERIVED as median(compute call) - median(engine).
//                      The probe's checksum walk is the only work the two
//                      calls do not share and it is negligible; a small
//                      negative derived value on near-zero cases is noise
//                      and is printed as measured, not clamped.
//   view assembly      assembleDiffResult() over the compute() result:
//                      every row of both views materialized (pre-M10 path).
//   row model (M10)    createRowModel() over the same result: the O(edits)
//                      index the virtualized page builds per diff; what the
//                      site's perf badge times since M10 is compute call
//                      plus this.
//   60-row window      materializing one viewport's worth of split rows
//                      from the model, the per-frame unit of render work.
//   total (full)       compute call + full view assembly, end to end (the
//                      pre-M10 badge number and the js-comparable total).
//   total (M10 page)   compute call + row model + 60-row window: what the
//                      M10 page actually does before first paint.
//
// Nothing is moved outside the timed regions: input copy-in is inside both
// wasm timings, and the js number includes its own view materialization
// because that is inseparable from its compute. One asterisk, disclosed:
// this is a Node process, so the M10 page's worker postMessage hop is not
// in any number here; the sparse buffers cross it as transferables
// (zero-copy), and scripts/check-virtual.mjs covers that path in a real
// browser.
//
// Product optimization, disclosed: since M9 the engine short-circuits
// byte-identical inputs (left == right) to a single Equal run without
// diffing. The large-150kb-identical case therefore measures that fast path
// plus the boundary floor and MUST NOT be read as engine speed; engine-speed
// claims rest on the non-identical cases, where the diff actually runs.
//
// Methodology: per case and pipeline, WARMUP unmeasured runs to let the JIT
// settle, then the case's iteration count of measured runs, interleaved
// (js, wasm, probe, js, wasm, probe, ...) so no pipeline gets a systematic
// thermal or GC advantage; the reported number is the median. Sanity checks
// run before timing: both pipelines must agree on added/removed (except the
// disclosed spread case, whose divergence is the point), and the assembled
// output must reconstruct both inputs byte for byte.
//
// Both pipelines run in the same Node process (V8, the engine Chrome uses).
// Caveat, flagged openly: this is Node's WebAssembly runtime, not a browser
// page, but the wasm module and JS glue are byte-identical to what the site
// loads, and V8 executes both sides. scripts/bench-browser.mjs repeats the
// core cases in headless Chrome, DOM render included, to confirm the
// relative numbers carry over.
//
// Inputs come from scripts/bench-cases.mjs: committed fixtures plus
// deterministic seeded generators, reproducible from any checkout.
// Requires web/pkg (./scripts/build-wasm.sh).
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
import { assembleDiffResult } from '../web/js/assemble.js';
import { createRowModel } from '../web/js/rowmodel.js';
import { CASES } from './bench-cases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WARMUP = 10;

function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(ms) {
  return ms < 1 ? `${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`;
}

function loadCase(c) {
  if (c.fixture) {
    return {
      left: readFileSync(join(ROOT, c.fixture.left), 'utf8'),
      right: readFileSync(join(ROOT, c.fixture.right), 'utf8'),
    };
  }
  return c.build();
}

// Concatenated per-side text of an assembled result must equal the inputs.
function assertReconstructs(assembled, left, right, label) {
  const text = (segments) => segments.map((s) => s.text).join('');
  const gotLeft = assembled.rows.filter((r) => r.left).map((r) => text(r.left.segments)).join('\n');
  const gotRight = assembled.rows.filter((r) => r.right).map((r) => text(r.right.segments)).join('\n');
  if (gotLeft !== left) throw new Error(`${label}: left does not reconstruct from the wasm pipeline`);
  if (gotRight !== right) throw new Error(`${label}: right does not reconstruct from the wasm pipeline`);
}

const initWasm = (await import(join(ROOT, 'web/pkg/diffwtf_wasm.js'))).default;
const { compute: wasmCompute, compute_probe: wasmProbe } = await import(
  join(ROOT, 'web/pkg/diffwtf_wasm.js')
);
await initWasm({ module_or_path: readFileSync(join(ROOT, 'web/pkg/diffwtf_wasm_bg.wasm')) });

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch {
  /* fine outside a git checkout */
}
console.log('# diff.wtf benchmark: JS reference vs shipped wasm pipeline (sparse v2 boundary)');
console.log(`# node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · commit ${commit}`);
console.log(`# medians, ${WARMUP} warmup runs per pipeline (huge cases override per bench-cases.mjs), word granularity, interleaved`);
console.log('# phases and methodology: header comment of scripts/bench-vs-js.mjs');
console.log('');

let sink = 0; // consumes every result so no timed call is optimizable away
const summary = [];
for (const c of CASES) {
  const { left, right } = loadCase(c);
  const iterations = c.iterations;
  const warmup = c.warmup ?? WARMUP;

  // Sanity before timing.
  const jsResult = jsCompute(left, right, 'word');
  const wasmAssembled = assembleDiffResult(left, right, wasmCompute(left, right, 'word'));
  assertReconstructs(wasmAssembled, left, right, c.name);
  const countsLine = c.countsMayDiffer
    ? `js +${jsResult.added}/-${jsResult.removed} vs wasm +${wasmAssembled.added}/-${wasmAssembled.removed} (documented divergence: reference degrades past its bailout)`
    : `+${wasmAssembled.added}/-${wasmAssembled.removed} lines`;
  if (!c.countsMayDiffer &&
      (jsResult.added !== wasmAssembled.added || jsResult.removed !== wasmAssembled.removed)) {
    throw new Error(
      `${c.name}: pipelines disagree ` +
        `(js +${jsResult.added}/-${jsResult.removed}, wasm +${wasmAssembled.added}/-${wasmAssembled.removed})`,
    );
  }

  const pipelines = {
    js: () => {
      sink += jsCompute(left, right, 'word').rows.length;
    },
    wasm: () => {
      const t0 = performance.now();
      const sparse = wasmCompute(left, right, 'word');
      const t1 = performance.now();
      const assembled = assembleDiffResult(left, right, sparse);
      const t2 = performance.now();
      const model = createRowModel(left, right, sparse);
      const t3 = performance.now();
      // One viewport of split rows from the middle of the diff, the unit
      // of work the virtualized renderer asks for per frame.
      const mid = Math.max(0, (model.splitCount >> 1) - 30);
      let windowRows = 0;
      for (let i = 0; i < 60 && mid + i < model.splitCount; i++) {
        windowRows += model.splitRow(mid + i).kind.length;
      }
      const t4 = performance.now();
      sink += assembled.rows.length + windowRows;
      return {
        call: t1 - t0,
        assemble: t2 - t1,
        model: t3 - t2,
        window: t4 - t3,
        total: t2 - t0,
        m10: (t1 - t0) + (t3 - t2) + (t4 - t3),
      };
    },
    probe: () => {
      sink += wasmProbe(left, right, 'word') & 1;
    },
  };

  for (let i = 0; i < warmup; i++) {
    pipelines.js();
    pipelines.wasm();
    pipelines.probe();
  }
  const times = { js: [], call: [], assemble: [], model: [], window: [], total: [], m10: [], probe: [] };
  for (let i = 0; i < iterations; i++) {
    let t0 = performance.now();
    pipelines.js();
    times.js.push(performance.now() - t0);

    const wasm = pipelines.wasm();
    times.call.push(wasm.call);
    times.assemble.push(wasm.assemble);
    times.model.push(wasm.model);
    times.window.push(wasm.window);
    times.total.push(wasm.total);
    times.m10.push(wasm.m10);

    t0 = performance.now();
    pipelines.probe();
    times.probe.push(performance.now() - t0);
  }

  const m = {
    js: median(times.js),
    call: median(times.call),
    assemble: median(times.assemble),
    model: median(times.model),
    window: median(times.window),
    total: median(times.total),
    m10: median(times.m10),
    probe: median(times.probe),
  };
  const marshal = m.call - m.probe;
  summary.push({
    name: c.name,
    size: Math.max(left.length, right.length),
    js: m.js,
    total: m.total,
    m10: m.m10,
    identical: c.name === 'large-150kb-identical',
    sizeScaling: Boolean(c.sizeScaling),
  });

  console.log(`${c.name}: ${c.note}`);
  console.log(
    `  input: ${left.length.toLocaleString('en-US')} + ${right.length.toLocaleString('en-US')} chars, ${countsLine}, median of ${iterations}`,
  );
  console.log(`  js total (compute incl. views)   ${fmt(m.js)}`);
  console.log(`  wasm engine (probe)              ${fmt(m.probe)}`);
  console.log(`  wasm compute call                ${fmt(m.call)}`);
  console.log(`  wasm result marshal (derived)    ${fmt(marshal)}`);
  console.log(`  wasm view assembly (full, js)    ${fmt(m.assemble)}`);
  console.log(`  wasm row model build (M10)       ${fmt(m.model)}`);
  console.log(`  wasm 60-row window (M10)         ${fmt(m.window)}`);
  console.log(`  wasm total (call + assembly)     ${fmt(m.total)}`);
  console.log(`  wasm total (M10 page path)       ${fmt(m.m10)}`);
  console.log(`  ratio (js total / wasm total)    ${(m.js / m.total).toFixed(2)}x`);
  console.log('');
}

console.log('# summary (medians; ratio = js total / wasm full total, both materialize');
console.log('# every row; the M10 column is the virtualized page path, call + model +');
console.log('# one 60-row window, which no js-side equivalent exists for)');
for (const s of summary) {
  const flag = s.identical ? '  [identical fast path, not an engine-speed number]' : '';
  console.log(
    `# ${s.name}: js ${fmt(s.js)} vs wasm ${fmt(s.total)} -> ${(s.js / s.total).toFixed(2)}x · M10 page ${fmt(s.m10)}${flag}`,
  );
}

// Crossover, computed ONLY over the size-scaling sparse-edit family (same
// content shape, growing size). The js/wasm ratio is content-dependent, not
// size-monotonic: complete-rewrite sits above any size crossover and still
// loses, and the identical fast-path row is excluded as not an engine
// measurement. Do not quote this line without that scope.
const ordered = summary.filter((s) => s.sizeScaling).sort((a, b) => a.size - b.size);
let crossover = null;
for (let i = 0; i < ordered.length; i++) {
  if (ordered[i].js / ordered[i].total >= 1) {
    crossover = i;
    break;
  }
}
const scope = 'sparse-edit size-scaling cases only; ratios are content-dependent, see complete-rewrite';
if (crossover === null) {
  console.log(`# crossover (${scope}): wasm never overtakes the js reference in this run`);
} else if (crossover === 0) {
  console.log(`# crossover (${scope}): wasm already ahead at the smallest case (${ordered[0].name})`);
} else {
  const below = ordered[crossover - 1];
  const above = ordered[crossover];
  console.log(
    `# crossover (${scope}): wasm overtakes between ${below.name} (${below.size.toLocaleString('en-US')} chars, ${(below.js / below.total).toFixed(2)}x) ` +
      `and ${above.name} (${above.size.toLocaleString('en-US')} chars, ${(above.js / above.total).toFixed(2)}x)`,
  );
}
console.log(`# (sink ${sink & 0xffff}, printed so no timed call can be optimized away)`);
