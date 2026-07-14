#!/usr/bin/env node
// scripts/gen-bench-page.mjs: the single source of truth wiring for every
// performance number the site displays (issue #11).
//
// The committed benchmark artifacts are the only place speed numbers may
// come from:
//
//   scripts/bench-vs-js.results.txt       (Node run, scripts/bench-vs-js.mjs)
//   scripts/bench-browser.results.txt     (Chromium run, scripts/bench-browser.mjs)
//
// This script parses both artifacts and renders every data-bearing region
// of web/index.html (the "Why it's fast" chart card) and web/benchmarks.html
// (charts, tables, and number-carrying prose) between marker comments:
//
//   <!-- bench:gen NAME --> ... <!-- bench:endgen NAME -->
//
// Modes:
//   node scripts/gen-bench-page.mjs           rewrite the regions in place
//   node scripts/gen-bench-page.mjs --check   verify the committed pages match
//                                             what the artifacts generate;
//                                             exit 1 on any divergence
//
// CI runs --check on every push, so a page number that drifts from the
// committed benchmark output fails the build instead of shipping. This is
// deliberately not a build step for the site (the pages stay static,
// committed files, per the no-bundler rule); it is a generator plus a gate,
// like scripts/gen-fixtures.mjs and its conformance suite.
//
// One region is checked semantically instead of byte for byte: the wasm
// binary size on web/benchmarks.html. The binary is a build product
// (web/pkg is gitignored) and its exact byte count varies slightly across
// toolchain releases, so gen mode bakes the locally built size and check
// mode asserts the baked size is within TOLERANCE of the currently built
// binary. Growth past that bound fails the check, echoing the CLAUDE.md
// rule that wasm size regressions must be surfaced.
//
// The parsers are strict on purpose: if the benchmark output format or the
// crossover statement changes shape, this script fails loudly so the pages
// get re-authored consciously rather than silently mis-parsed.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES } from './bench-cases.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VS_JS_TXT = join(ROOT, 'scripts/bench-vs-js.results.txt');
const BROWSER_TXT = join(ROOT, 'scripts/bench-browser.results.txt');
const WASM_BIN = join(ROOT, 'web/pkg/diffwtf_wasm_bg.wasm');
const INDEX_HTML = join(ROOT, 'web/index.html');
const BENCH_HTML = join(ROOT, 'web/benchmarks.html');
const SIZE_TOLERANCE = 0.10;

const GH = 'https://github.com/diffwtf/diffwtf/blob/main';

// Design tokens (docs/design-handoff/README.md); presentation only.
const ACCENT = '#3fd68f';
const RED = '#f85149';
const TEXT2 = '#8b98a9';
const FAINT = '#46515f';
const GRID = '#161c24';
const BORDER = '#1a212b';
const NEUTRAL = '#3a4657';
const MONO = "JetBrains Mono, monospace";

function fail(msg) {
  console.error(`gen-bench-page: ${msg}`);
  process.exit(1);
}

function esc(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function num(s) {
  return Number(s.replaceAll(',', ''));
}

// ---------------------------------------------------------------------------
// Artifact parsers
// ---------------------------------------------------------------------------

const VS_JS_PHASES = {
  'js total (compute incl. views)': 'js',
  'wasm engine (probe)': 'probe',
  'wasm compute call': 'call',
  'wasm result marshal (derived)': 'marshal',
  'wasm view assembly (full, js)': 'assemble',
  'wasm row model build (M10)': 'model',
  'wasm 60-row window (M10)': 'window',
  'wasm total (call + assembly)': 'total',
  'wasm total (M10 page path)': 'm10',
};

const BROWSER_PHASES = {
  'js total (compute incl. views)': 'js',
  'wasm total (call + assembly)': 'total',
  'DOM render (split view, shared)': 'render',
};

function parseHeader(lines, file) {
  const env = lines[1]?.match(/^# (node \S+) · (.+) · commit (\S+)$/);
  if (!env) fail(`${file}: unrecognized environment header line: ${lines[1]}`);
  return { node: env[1], cpu: env[2], commit: env[3], method: lines[2]?.replace(/^# /, '') ?? '' };
}

function parseCases(lines, phaseMap, ratioLabels, file) {
  const cases = [];
  let cur = null;
  for (const line of lines) {
    const start = line.match(/^([a-z0-9-]+): (.+)$/);
    if (start) {
      cur = { name: start[1], note: start[2], phases: {}, ratios: {} };
      cases.push(cur);
      continue;
    }
    if (!cur || !line.startsWith('  ')) continue;
    const input = line.match(/^ {2}input: ([\d,]+) \+ ([\d,]+) chars, (.+), median of (\d+)(?: \(render: (\d+)\))?$/);
    if (input) {
      cur.leftChars = num(input[1]);
      cur.rightChars = num(input[2]);
      cur.charsStr = `${input[1]} + ${input[2]}`;
      cur.counts = input[3];
      cur.iterations = num(input[4]);
      if (input[5] !== undefined) cur.renderIterations = num(input[5]);
      continue;
    }
    const ratio = line.match(/^ {2}(ratio [^ ].*?) {2,}([\d.]+)x$/);
    if (ratio && ratioLabels[ratio[1]]) {
      cur.ratios[ratioLabels[ratio[1]]] = ratio[2];
      continue;
    }
    const phase = line.match(/^ {2}(.+?) {2,}(-?[\d.]+) ms$/);
    if (phase && phaseMap[phase[1]]) {
      cur.phases[phaseMap[phase[1]]] = { raw: phase[2], val: Number(phase[2]) };
      continue;
    }
    fail(`${file}: unrecognized case line under ${cur.name}: ${JSON.stringify(line)}`);
  }
  for (const c of cases) {
    if (c.iterations === undefined) fail(`${file}: case ${c.name} has no input line`);
    for (const key of Object.values(phaseMap)) {
      if (!c.phases[key]) fail(`${file}: case ${c.name} is missing the ${key} phase`);
    }
    for (const key of Object.values(ratioLabels)) {
      if (!c.ratios[key]) fail(`${file}: case ${c.name} is missing the ${key} ratio`);
    }
  }
  return cases;
}

function parseVsJs() {
  const text = readFileSync(VS_JS_TXT, 'utf8');
  const lines = text.split('\n');
  const meta = parseHeader(lines, 'bench-vs-js.results.txt');
  const cases = parseCases(
    lines.filter((l) => !l.startsWith('#')),
    VS_JS_PHASES,
    { 'ratio (js total / wasm total)': 'total' },
    'bench-vs-js.results.txt',
  );
  const crossLine = lines.find((l) => l.startsWith('# crossover'));
  if (!crossLine) fail('bench-vs-js.results.txt: no crossover line');
  const cross = crossLine.match(
    /^# crossover \((.+)\): wasm overtakes between (\S+) \(([\d,]+) chars, ([\d.]+)x\) and (\S+) \(([\d,]+) chars, ([\d.]+)x\)$/,
  );
  if (!cross) {
    fail(`crossover statement changed shape; re-author the pages consciously: ${crossLine}`);
  }
  const crossover = {
    scope: cross[1],
    below: { name: cross[2], chars: num(cross[3]), charsStr: cross[3], ratio: cross[4] },
    above: { name: cross[5], chars: num(cross[6]), charsStr: cross[6], ratio: cross[7] },
  };
  // Cross-check against the shared case matrix so names, flags, and notes
  // cannot drift apart between bench-cases.mjs and the committed artifact.
  const byName = new Map(CASES.map((c) => [c.name, c]));
  for (const c of cases) {
    const src = byName.get(c.name);
    if (!src) fail(`artifact case ${c.name} is not in scripts/bench-cases.mjs`);
    if (src.note !== c.note) fail(`case ${c.name}: note differs between artifact and bench-cases.mjs`);
    c.sizeScaling = Boolean(src.sizeScaling);
    c.size = Math.max(c.leftChars, c.rightChars);
  }
  return { meta, cases, crossover };
}

function parseBrowser() {
  const text = readFileSync(BROWSER_TXT, 'utf8');
  const lines = text.split('\n');
  const meta = parseHeader(lines, 'bench-browser.results.txt');
  const cases = parseCases(
    lines.filter((l) => !l.startsWith('#')),
    BROWSER_PHASES,
    { 'ratio without render': 'noRender', 'ratio including render': 'withRender' },
    'bench-browser.results.txt',
  );
  return { meta, cases };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function ms(phase) {
  return `${phase.raw} ms`;
}

function svgText(x, y, content, { anchor = 'start', fill = TEXT2, size = 11, weight, rotate } = {}) {
  const attrs = [
    `x="${x}"`, `y="${y}"`,
    `font-family="${MONO}"`, `font-size="${size}"`, `fill="${fill}"`,
    `text-anchor="${anchor}"`,
  ];
  if (weight) attrs.push(`font-weight="${weight}"`);
  if (rotate) attrs.push(`transform="rotate(${rotate} ${x} ${y})"`);
  return `<text ${attrs.join(' ')}>${esc(content)}</text>`;
}

function table(id, caption, headers, rows, rightAlignFrom) {
  const head = headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('');
  const body = rows
    .map((cells) => {
      const tds = cells
        .map((c, i) => `<td${i >= rightAlignFrom ? ' class="r"' : ''}>${esc(c)}</td>`)
        .join('');
      return `      <tr>${tds}</tr>`;
    })
    .join('\n');
  return `<div class="bench-scroll">
    <table class="bench-table" id="${id}">
      <caption>${esc(caption)}</caption>
      <thead><tr>${head}</tr></thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------
// Charts (hand-rolled inline SVG, numbers baked at generation time)
// ---------------------------------------------------------------------------

// Log-log scaling chart over the size-scaling family: js vs wasm totals.
function svgScaling(family, crossover) {
  const W = 720; const H = 380;
  const PL = 84; const PR = 36; const PT = 30; const PB = 74;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const xs = family.map((c) => c.size);
  const ys = family.flatMap((c) => [c.phases.js.val, c.phases.total.val]);
  const xDom = [Math.min(...xs) / 1.4, Math.max(...xs) * 1.4];
  const yDom = [Math.min(...ys) / 1.7, Math.max(...ys) * 1.7];
  const lx = (v) =>
    (PL + ((Math.log10(v) - Math.log10(xDom[0])) / (Math.log10(xDom[1]) - Math.log10(xDom[0]))) * plotW).toFixed(1);
  const ly = (v) =>
    (PT + plotH - ((Math.log10(v) - Math.log10(yDom[0])) / (Math.log10(yDom[1]) - Math.log10(yDom[0]))) * plotH).toFixed(1);

  const parts = [];
  // Decade gridlines and tick labels inside the domain.
  for (let k = -3; k <= 8; k++) {
    const v = 10 ** k;
    if (v >= xDom[0] && v <= xDom[1]) {
      const x = lx(v);
      parts.push(`<line x1="${x}" y1="${PT}" x2="${x}" y2="${PT + plotH}" stroke="${GRID}"/>`);
      const label = k >= 6 ? `${10 ** (k - 6)}M` : k >= 3 ? `${10 ** (k - 3)}k` : String(v);
      parts.push(svgText(x, PT + plotH + 18, label, { anchor: 'middle', fill: FAINT }));
    }
    if (v >= yDom[0] && v <= yDom[1]) {
      const y = ly(v);
      parts.push(`<line x1="${PL}" y1="${y}" x2="${PL + plotW}" y2="${y}" stroke="${GRID}"/>`);
      parts.push(svgText(PL - 8, Number(y) + 4, String(v), { anchor: 'end', fill: FAINT }));
    }
  }
  // Crossover band between the two flanking cases, labeled at its foot
  // where no data points sit.
  const cbX0 = lx(crossover.below.chars);
  const cbX1 = lx(crossover.above.chars);
  parts.push(`<rect x="${cbX0}" y="${PT}" width="${(cbX1 - cbX0).toFixed(1)}" height="${plotH}" fill="${ACCENT}" fill-opacity="0.07"/>`);
  parts.push(svgText((Number(cbX0) + Number(cbX1)) / 2, PT + plotH - 12, 'crossover', { anchor: 'middle', fill: ACCENT }));

  // Axes.
  parts.push(`<line x1="${PL}" y1="${PT + plotH}" x2="${PL + plotW}" y2="${PT + plotH}" stroke="${BORDER}"/>`);
  parts.push(`<line x1="${PL}" y1="${PT}" x2="${PL}" y2="${PT + plotH}" stroke="${BORDER}"/>`);
  parts.push(svgText(PL + plotW / 2, H - 30, 'input size, characters per side (log scale)', { anchor: 'middle' }));
  parts.push(svgText(24, PT + plotH / 2, 'median time, ms (log scale)', { anchor: 'middle', rotate: -90 }));

  // Series: js dashed circles, wasm solid squares (shape and dash carry the
  // distinction, not color alone).
  const jsPts = family.map((c) => [lx(c.size), ly(c.phases.js.val), c]);
  const wasmPts = family.map((c) => [lx(c.size), ly(c.phases.total.val), c]);
  parts.push(
    `<polyline points="${jsPts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${TEXT2}" stroke-width="1.5" stroke-dasharray="5 4"/>`,
  );
  parts.push(
    `<polyline points="${wasmPts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`,
  );
  for (const [x, y, c] of jsPts) {
    parts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${TEXT2}"><title>${esc(`${c.name}: JS reference ${ms(c.phases.js)}`)}</title></circle>`);
  }
  for (const [x, y, c] of wasmPts) {
    parts.push(
      `<rect x="${(x - 3.5).toFixed(1)}" y="${(y - 3.5).toFixed(1)}" width="7" height="7" fill="${ACCENT}"><title>${esc(`${c.name}: wasm pipeline ${ms(c.phases.total)}`)}</title></rect>`,
    );
  }
  // Legend in the top-left region, which the data never enters (both
  // curves rise left to right); marker shape and line style carry the
  // series distinction alongside color.
  const lgX = PL + 14;
  const lg1 = PT + 14;
  const lg2 = PT + 34;
  parts.push(`<line x1="${lgX}" y1="${lg1 - 4}" x2="${lgX + 26}" y2="${lg1 - 4}" stroke="${ACCENT}" stroke-width="2"/>`);
  parts.push(`<rect x="${lgX + 9.5}" y="${lg1 - 7.5}" width="7" height="7" fill="${ACCENT}"/>`);
  parts.push(svgText(lgX + 34, lg1, 'wasm pipeline (compute + view assembly)', { fill: ACCENT, weight: 700 }));
  parts.push(`<line x1="${lgX}" y1="${lg2 - 4}" x2="${lgX + 26}" y2="${lg2 - 4}" stroke="${TEXT2}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  parts.push(`<circle cx="${lgX + 13}" cy="${lg2 - 4}" r="3.5" fill="${TEXT2}"/>`);
  parts.push(svgText(lgX + 34, lg2, 'JS reference (refdiff.mjs)', { weight: 700 }));

  const first = family[0];
  const last = family[family.length - 1];
  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="scaling-title scaling-desc">
    <title id="scaling-title">Median diff time by input size: JS reference vs wasm pipeline</title>
    <desc id="scaling-desc">Line chart with logarithmic axes over the ${family.length} size-scaling cases, from ${first.name} (${first.size.toLocaleString('en-US')} characters) to ${last.name} (${last.size.toLocaleString('en-US')} characters). The wasm pipeline overtakes the JS reference between ${crossover.below.charsStr} and ${crossover.above.charsStr} characters. Exact values are in the table below the chart.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// Horizontal ratio bars for every case, zero baseline, parity line at 1x.
function svgRatios(cases) {
  const ROW = 27; const PT = 34; const PBOT = 52; const LABELW = 236;
  const W = 720; const H = PT + cases.length * ROW + PBOT;
  const plotX = LABELW; const plotW = W - LABELW - 130;
  const maxRatio = Math.ceil(Math.max(...cases.map((c) => Number(c.ratios.total))));
  const rx = (v) => (plotX + (v / maxRatio) * plotW).toFixed(1);

  const parts = [];
  for (let v = 0; v <= maxRatio; v++) {
    const x = rx(v);
    parts.push(`<line x1="${x}" y1="${PT - 8}" x2="${x}" y2="${PT + cases.length * ROW}" stroke="${GRID}"/>`);
    parts.push(svgText(x, PT + cases.length * ROW + 16, `${v}x`, { anchor: 'middle', fill: FAINT }));
  }
  // Parity line under the bars and labels so text stays readable where it
  // crosses; the line shows through in the row gaps.
  parts.push(`<line x1="${rx(1)}" y1="${PT - 8}" x2="${rx(1)}" y2="${PT + cases.length * ROW}" stroke="${TEXT2}" stroke-dasharray="3 3"/>`);
  parts.push(svgText(Number(rx(1)), PT - 14, '1x = same speed as the JS reference', { anchor: 'middle' }));
  cases.forEach((c, i) => {
    const y = PT + i * ROW;
    const ratio = Number(c.ratios.total);
    const win = ratio >= 1;
    const suffix = c.name === 'large-150kb-identical'
      ? ' (fast path, not engine speed)'
      : win ? '' : ' (slower)';
    parts.push(svgText(plotX - 10, y + 12, c.name, { anchor: 'end' }));
    parts.push(
      `<rect x="${plotX}" y="${y + 3}" width="${((ratio / maxRatio) * plotW).toFixed(1)}" height="12" rx="3" fill="${win ? ACCENT : RED}"/>`,
    );
    parts.push(svgText(Number(rx(ratio)) + 8, y + 13, `${c.ratios.total}x${suffix}`, { fill: win ? ACCENT : RED }));
  });
  parts.push(
    svgText(plotX + plotW / 2, H - 14, 'JS reference time / wasm time (linear, zero baseline; above 1x, wasm is faster)', { anchor: 'middle' }),
  );

  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ratios-title ratios-desc">
    <title id="ratios-title">Speed ratio per benchmark case, JS reference time divided by wasm time</title>
    <desc id="ratios-desc">Bar chart of all ${cases.length} cases on a linear scale from a zero baseline with the 1x parity line marked. Bars left of 1x are cases where the wasm pipeline is slower. Exact values are in the table below the chart.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// Phase breakdown of the 150 KB marketing fixture, linear, zero baseline.
function svgPhases(c) {
  const rows = [
    ['JS reference total, for context', c.phases.js, TEXT2],
    ['wasm engine compute (probe)', c.phases.probe, ACCENT],
    ['result marshal across the boundary', c.phases.marshal, ACCENT],
    ['full view assembly (pre-M10 page path)', c.phases.assemble, ACCENT],
    ['row model build (M10 page path)', c.phases.model, ACCENT],
    ['one 60-row render window (M10)', c.phases.window, ACCENT],
  ];
  const ROW = 27; const PT = 16; const PBOT = 52; const LABELW = 280;
  const W = 720; const H = PT + rows.length * ROW + PBOT;
  const plotX = LABELW; const plotW = W - LABELW - 110;
  const maxV = Math.max(...rows.map(([, p]) => p.val)) * 1.04;
  const rx = (v) => plotX + (v / maxV) * plotW;

  const parts = [];
  const ticks = [0, 1, 2, 3, 4, 5];
  for (const v of ticks) {
    if (v > maxV) continue;
    const x = rx(v).toFixed(1);
    parts.push(`<line x1="${x}" y1="${PT}" x2="${x}" y2="${PT + rows.length * ROW}" stroke="${GRID}"/>`);
    parts.push(svgText(x, PT + rows.length * ROW + 16, String(v), { anchor: 'middle', fill: FAINT }));
  }
  rows.forEach(([label, phase, color], i) => {
    const y = PT + i * ROW;
    const w = Math.max(1, rx(phase.val) - plotX).toFixed(1);
    parts.push(svgText(plotX - 10, y + 12, label, { anchor: 'end' }));
    parts.push(`<rect x="${plotX}" y="${y + 3}" width="${w}" height="12" rx="3" fill="${color}"/>`);
    parts.push(svgText(plotX + Number(w) + 8, y + 13, ms(phase), { fill: color }));
  });
  parts.push(svgText(plotX + plotW / 2, H - 14, 'median time, ms (linear, zero baseline)', { anchor: 'middle' }));

  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="phases-title phases-desc">
    <title id="phases-title">Where the time goes on the 150 KB fixture</title>
    <desc id="phases-desc">Bar chart of the wasm pipeline phases for the ${c.name} case on a linear scale from a zero baseline, with the JS reference total as context. The boundary marshal is ${ms(c.phases.marshal)}. Exact values are in the table below the chart.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// Compute vs DOM render, stacked, for the browser 150 KB case.
function svgBrowser(c) {
  const jsTotal = c.phases.js.val + c.phases.render.val;
  const wasmTotal = c.phases.total.val + c.phases.render.val;
  const rows = [
    ['JS reference', c.phases.js, jsTotal, TEXT2],
    ['wasm pipeline', c.phases.total, wasmTotal, ACCENT],
  ];
  const PT = 14; const ROWH = 58; const PBOT = 50; const LABELW = 20;
  const W = 720; const H = PT + rows.length * ROWH + PBOT;
  const plotX = LABELW; const plotW = W - LABELW - 40;
  const maxV = Math.max(jsTotal, wasmTotal) * 1.02;
  const rx = (v) => (v / maxV) * plotW;

  const parts = [];
  rows.forEach(([label, compute, total, color], i) => {
    const y = PT + i * ROWH;
    const cw = Math.max(1.5, rx(compute.val)).toFixed(1);
    const rw = rx(c.phases.render.val).toFixed(1);
    parts.push(
      svgText(plotX, y + 12, `${label}: compute ${ms(compute)} + DOM render ${ms(c.phases.render)} = ${total.toFixed(2)} ms`, { fill: color }),
    );
    parts.push(`<rect x="${plotX}" y="${y + 20}" width="${cw}" height="14" fill="${color}"/>`);
    parts.push(`<rect x="${(plotX + Number(cw)).toFixed(1)}" y="${y + 20}" width="${rw}" height="14" fill="${NEUTRAL}"/>`);
  });
  parts.push(svgText(plotX, H - 16, 'ms, linear, zero baseline; the gray span is the shared DOM render of the split view', { fill: FAINT }));

  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="browser-title browser-desc">
    <title id="browser-title">Compute plus DOM render on the 150 KB fixture in Chromium</title>
    <desc id="browser-desc">Two stacked bars on a linear scale from a zero baseline. Rendering the split view into the DOM takes ${ms(c.phases.render)} for both pipelines, so end to end the two finish within about ${c.ratios.withRender}x of each other despite the ${c.ratios.noRender}x compute gap. Exact values are in the table below.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

function buildRegions() {
  const vsJs = parseVsJs();
  const browser = parseBrowser();
  const byName = new Map(vsJs.cases.map((c) => [c.name, c]));
  const need = (name) => {
    const c = byName.get(name);
    if (!c) fail(`expected case ${name} in bench-vs-js.results.txt`);
    return c;
  };
  const tiny = need('tiny-snippet');
  const big = need('large-150kb-sparse');
  const identical = need('large-150kb-identical');
  const rewrite = need('complete-rewrite');
  const spread = need('large-1mb-spread');
  const family = vsJs.cases.filter((c) => c.sizeScaling).sort((a, b) => a.size - b.size);
  const browser150 = browser.cases.find((c) => c.name === 'large-150kb-sparse');
  if (!browser150) fail('expected case large-150kb-sparse in bench-browser.results.txt');
  const browserRatios = browser.cases
    .filter((c) => c.name !== 'large-150kb-identical')
    .map((c) => Number(c.ratios.withRender));
  const renderParity = { lo: Math.min(...browserRatios).toFixed(2), hi: Math.max(...browserRatios).toFixed(2) };

  if (tiny.iterations !== big.iterations) {
    fail('tiny-snippet and large-150kb-sparse iteration counts differ; reword the home caption consciously');
  }

  const regions = new Map();

  // ---- home page: the "Why it's fast" card ------------------------------
  const bigApprox = (Math.round(big.phases.total.val * 10) / 10).toString();
  const barPct = (v, max) => `${Math.max(1, Math.round((v / max) * 100))}%`;
  regions.set('home-chart', `      <p class="chart-intro">Myers diff implemented in Rust, compiled to WebAssembly. In the committed Node benchmark, the engine call plus full view assembly for a 5,000-line file takes about ${bigApprox} ms.</p>
      <div class="chart">
        <div class="chart-bar">
          <div class="chart-labels"><span>code snippet (the example)</span><span class="accent">${ms(tiny.phases.total)}</span></div>
          <div class="chart-track"><div class="chart-fill" style="width: ${barPct(tiny.phases.total.val, big.phases.total.val)}"></div></div>
        </div>
        <div class="chart-bar">
          <div class="chart-labels"><span>5,000-line file (150 KB)</span><span class="accent">${ms(big.phases.total)}</span></div>
          <div class="chart-track"><div class="chart-fill" style="width: ${barPct(big.phases.total.val, big.phases.total.val)}"></div></div>
        </div>
        <span class="chart-caption">medians of ${big.iterations} runs on committed fixtures: <a href="${GH}/scripts/bench-vs-js.mjs">scripts/bench-vs-js.mjs</a> · <a href="benchmarks.html">all benchmarks</a></span>
      </div>`);

  // ---- benchmarks page ---------------------------------------------------
  regions.set('bench-meta', `  <p class="bench-updated">committed run: ${esc(vsJs.meta.node)} · ${esc(vsJs.meta.cpu)} · commit ${esc(vsJs.meta.commit)} · <a href="${GH}/scripts/bench-vs-js.results.txt">scripts/bench-vs-js.results.txt</a></p>`);

  const familyRows = family.map((c) => [
    c.name, c.note, c.charsStr, String(c.iterations),
    ms(c.phases.js), ms(c.phases.total), ms(c.phases.m10), `${c.ratios.total}x`,
  ]);
  const aboveCrossover = family.filter((c) => Number(c.ratios.total) >= 1);
  const minCase = aboveCrossover.reduce((a, b) => (Number(a.ratios.total) <= Number(b.ratios.total) ? a : b));
  const maxCase = aboveCrossover.reduce((a, b) => (Number(a.ratios.total) >= Number(b.ratios.total) ? a : b));
  regions.set('bench-scaling', `  <p>The size-scaling family uses the same line-based content shape at growing sizes, with edits concentrated in a bounded zone. Per case, the chart shows the median of the JS reference total against the wasm pipeline total (compute call plus full view assembly, the JS-comparable number). For this family, the measured crossover is bracketed between ${vsJs.crossover.below.name} (${crossoverStr(vsJs.crossover.below)}) and ${vsJs.crossover.above.name} (${crossoverStr(vsJs.crossover.above)}). Above that measured bracket, the wasm total stays at or ahead of the reference on every case in the family, from ${minCase.ratios.total}x (${minCase.name}, near parity) to ${maxCase.ratios.total}x (${maxCase.name}). The ratio is content-dependent, not size-monotonic; the full matrix below has the exceptions.</p>
  <div class="bench-card">
    ${svgScaling(family, vsJs.crossover)}
  </div>
  ${table('scaling-table', 'Size-scaling cases: medians per pipeline (data for the chart above)', ['case', 'what it is', 'input, chars', 'runs', 'JS reference', 'wasm (call + assembly)', 'wasm (M10 page path)', 'ratio'], familyRows, 2)}
  <p class="bench-note">The M10 page-path column models compute plus lazy row-model construction and one 60-row render window. It excludes the worker round trip used by the current site for larger inputs, so it is a pipeline breakdown rather than a live per-keystroke measurement. The comparison ratio uses the full-assembly total, where both sides do the same work.</p>`);

  regions.set('bench-losses', `  <p>The same benchmark run includes these cases where the wasm pipeline is slower or not directly comparable, measured with the same methodology as the wins:</p>
  <ul>
    <li><strong>Tiny inputs.</strong> On ${esc(tiny.note)}, the JS reference wins: ${ms(tiny.phases.js)} against ${ms(tiny.phases.total)} for the wasm pipeline (${tiny.ratios.total}x). Below the crossover the wasm boundary floor costs more than the diff itself.</li>
    <li><strong>Complete rewrites.</strong> The ${rewrite.name} case is ${esc(rewrite.note)}. The wasm side is slower: ${ms(rewrite.phases.total)} against ${ms(rewrite.phases.js)} (${rewrite.ratios.total}x, about a third of the JS speed). Tracked openly as <a href="https://github.com/diffwtf/diffwtf/issues/12">issue #12</a>.</li>
    <li><strong>Identical inputs.</strong> The ${identical.name} case (${identical.ratios.total}x) measures a disclosed product shortcut, not engine speed: since M9 the engine short-circuits byte-identical inputs to a single Equal run. It is in the matrix because hiding a below-1x number would be spin; it must not be read as an engine measurement in either direction.</li>
    <li><strong>Once the DOM dominates.</strong> In a real Chromium tab, rendering every row of a large diff into the DOM costs far more than computing it, so end to end the two pipelines finish within ${renderParity.lo}x to ${renderParity.hi}x of each other on the browser-measured cases (identical fast path aside). The browser section below shows this in full; since M10 the site renders a virtualized window instead of every row, which is what keeps large diffs responsive.</li>
  </ul>`);

  const ratioRows = vsJs.cases.map((c) => [
    c.name, c.note, c.charsStr, String(c.iterations),
    ms(c.phases.js), ms(c.phases.total), ms(c.phases.m10), `${c.ratios.total}x`,
  ]);
  regions.set('bench-ratios', `  <div class="bench-card">
    ${svgRatios(vsJs.cases)}
  </div>
  ${table('ratios-table', 'All cases: medians per pipeline (data for the chart above)', ['case', 'what it is', 'input, chars', 'runs', 'JS reference', 'wasm (call + assembly)', 'wasm (M10 page path)', 'ratio'], ratioRows, 2)}
  <p class="bench-note">Counts note: on ${spread.name} the two pipelines legitimately disagree on output, ${esc(spread.counts)}. Its ratio compares different amounts of useful work and favors the engine, which stays minimal where the reference degrades. The ${identical.name} bar measures the disclosed identical-input fast path plus the boundary floor, not engine speed.</p>`);

  regions.set('bench-phases', `  <p>Phases of the wasm pipeline on ${big.name}: ${esc(big.note)}. The result marshal is the cost of crossing the wasm boundary, the part M9 rewrote: with the sparse contract it is ${ms(big.phases.marshal)} here, measured as the difference between the compute call and a probe call that does the same work but returns only a checksum.</p>
  <div class="bench-card">
    ${svgPhases(big)}
  </div>
  ${table('phases-table', 'Phase medians on large-150kb-sparse (data for the chart above)', ['phase', 'median'], [
    ['JS reference total (compute incl. views), for context', ms(big.phases.js)],
    ['wasm engine compute (probe)', ms(big.phases.probe)],
    ['wasm compute call (engine + boundary)', ms(big.phases.call)],
    ['result marshal across the boundary (derived)', ms(big.phases.marshal)],
    ['full view assembly in JS (pre-M10 page path)', ms(big.phases.assemble)],
    ['row model build (M10 page path)', ms(big.phases.model)],
    ['one 60-row render window (M10)', ms(big.phases.window)],
    ['wasm total (call + full assembly)', ms(big.phases.total)],
    ['wasm total (M10 page path)', ms(big.phases.m10)],
  ], 1)}`);

  const browserRows = browser.cases.map((c) => [
    c.name, c.charsStr, `${c.iterations} (render: ${c.renderIterations})`,
    ms(c.phases.js), ms(c.phases.total), ms(c.phases.render),
    `${c.ratios.noRender}x`, `${c.ratios.withRender}x`,
  ]);
  regions.set('bench-browser', `  <p>The Node numbers above compare compute. A browser tab also has to render the result, and painting every row of a large diff into the DOM dwarfs either compute path. Measured in headless Chromium on the real page (${esc(browser.meta.node)} · ${esc(browser.meta.cpu)} · commit ${esc(browser.meta.commit)}, <a href="${GH}/scripts/bench-browser.results.txt">scripts/bench-browser.results.txt</a>): on the 150 KB fixture the shared split-view DOM render is ${ms(browser150.phases.render)}, so despite a ${browser150.ratios.noRender}x compute win the end-to-end ratio including render is ${browser150.ratios.withRender}x. Stated plainly: once the full DOM render dominates, the engines tie. That is why M10 made the site render a virtualized window instead of every row.</p>
  <div class="bench-card">
    ${svgBrowser(browser150)}
  </div>
  ${table('browser-table', 'Headless Chromium, real page: medians per case', ['case', 'input, chars', 'runs', 'JS reference', 'wasm (call + assembly)', 'DOM render (shared)', 'ratio w/o render', 'ratio incl. render'], browserRows, 1)}
  <p class="bench-note">The large-150kb-identical row measures the disclosed identical-input fast path plus the boundary floor, not engine speed.</p>`);

  // Baked from the locally built binary; --check verifies the baked value
  // against the current build within tolerance instead of byte-comparing.
  // KB as bytes/1000, the convention DECISIONS.md D6 already uses for this
  // binary (45.7 KB).
  const wasmBytes = statSync(WASM_BIN).size;
  regions.set('bench-size', `  <p>The engine ships as a <span id="wasm-size" data-bytes="${wasmBytes}">${(wasmBytes / 1000).toFixed(1)} KB</span> WebAssembly binary (measured from the built <code>web/pkg/diffwtf_wasm_bg.wasm</code>) plus generated JS glue. The site uses static HTML, CSS, and vanilla-JS modules; diff computation requires no server round trip.</p>`);

  regions.set('bench-methodology', `  <p>Every displayed benchmark value is parsed out of the committed artifacts by <a href="${GH}/scripts/gen-bench-page.mjs">scripts/gen-bench-page.mjs</a>, which regenerates this page and the home page chart; CI fails if the pages and artifacts diverge.</p>
  <p>Main run (<a href="${GH}/scripts/bench-vs-js.results.txt">scripts/bench-vs-js.results.txt</a>): ${esc(vsJs.meta.node)} · ${esc(vsJs.meta.cpu)} · commit ${esc(vsJs.meta.commit)}. Reported values are ${esc(vsJs.meta.method)}. The baseline is this repository's JS reference implementation: useful for comparing equivalent project pipelines, but not a benchmark of competing diff products. Both pipelines run in the same Node process (V8, the engine Chrome uses) with the same wasm engine module the site ships; the surrounding production dispatch and rendering path is described separately. Inputs are committed fixtures or deterministic seeded generators (<a href="${GH}/scripts/bench-cases.mjs">scripts/bench-cases.mjs</a>), reproducible from any checkout; the per-case descriptions in the tables above are the generators' own notes. Sanity checks run before timing: both pipelines must agree on added and removed counts (except the disclosed ${spread.name} divergence), and assembled output must reconstruct both inputs byte for byte.</p>
  <p>Fairness notes, disclosed: the sparse-edit generators keep edits inside a bounded zone so both engines produce the identical minimal diff (same work, same output); the spread and rewrite cases deliberately step outside that and are labeled with what changes. The identical-input fast path is a product shortcut and never backs an engine-speed claim. The Node runner is not a browser page; the browser run exists to check that the story holds there.</p>
  <p>Reproduce it: <code>./scripts/build-wasm.sh</code> then <code>node scripts/bench-vs-js.mjs</code> (and <code>node scripts/bench-browser.mjs</code> for the Chromium run), from <a href="https://github.com/diffwtf/diffwtf">the repo</a>. The committed results files are regenerated by piping stdout there and committing the diff, so the artifact history is reviewable like any other code.</p>`);

  return regions;
}

function crossoverStr(side) {
  return `${side.charsStr} chars, ${side.ratio}x`;
}

// ---------------------------------------------------------------------------
// Injection and checking
// ---------------------------------------------------------------------------

const FILES = [
  { path: INDEX_HTML, regions: ['home-chart'] },
  {
    path: BENCH_HTML,
    regions: [
      'bench-meta', 'bench-scaling', 'bench-losses', 'bench-ratios',
      'bench-phases', 'bench-browser', 'bench-size', 'bench-methodology',
    ],
  },
];

function findRegion(html, name, path) {
  const open = `<!-- bench:gen ${name} -->`;
  const close = `<!-- bench:endgen ${name} -->`;
  const i = html.indexOf(open);
  const j = html.indexOf(close);
  if (i === -1 || j === -1 || j < i) fail(`${path}: marker pair for region ${name} not found`);
  if (html.indexOf(open, i + 1) !== -1) fail(`${path}: duplicate marker for region ${name}`);
  return { start: i + open.length, end: j };
}

function checkWasmSize(current) {
  const m = current.match(/data-bytes="(\d+)">([\d.]+) KB</);
  if (!m) fail('bench-size region: baked wasm size not found');
  const baked = Number(m[1]);
  if ((baked / 1000).toFixed(1) !== m[2]) {
    fail(`bench-size region: displayed ${m[2]} KB does not derive from data-bytes=${baked}`);
  }
  const actual = statSync(WASM_BIN).size;
  const drift = Math.abs(actual - baked) / actual;
  if (drift > SIZE_TOLERANCE) {
    fail(
      `bench-size region: baked wasm size ${baked} bytes is ${(drift * 100).toFixed(1)}% off the built binary (${actual} bytes); rerun the generator and review the size change`,
    );
  }
  console.log(`ok: wasm size ${baked} bytes baked, ${actual} bytes built (${(drift * 100).toFixed(1)}% drift, tolerance ${SIZE_TOLERANCE * 100}%)`);
}

const checkMode = process.argv.includes('--check');
const regions = buildRegions();
let failures = 0;

for (const { path, regions: names } of FILES) {
  let html = readFileSync(path, 'utf8');
  for (const name of names) {
    const expected = `\n${regions.get(name)}\n`;
    const { start, end } = findRegion(html, name, path);
    const current = html.slice(start, end);
    if (checkMode) {
      if (name === 'bench-size') {
        checkWasmSize(current);
        continue;
      }
      if (current !== expected) {
        failures++;
        const c = current.split('\n');
        const e = expected.split('\n');
        let line = 0;
        while (line < Math.max(c.length, e.length) && c[line] === e[line]) line++;
        console.error(`DRIFT in ${path} region ${name} (first differing line ${line + 1}):`);
        console.error(`  page:     ${JSON.stringify(c[line] ?? '(missing)')}`);
        console.error(`  artifact: ${JSON.stringify(e[line] ?? '(missing)')}`);
      } else {
        console.log(`ok: ${path.slice(ROOT.length + 1)} region ${name} matches the committed artifacts`);
      }
    } else {
      html = html.slice(0, start) + expected + html.slice(end);
    }
  }
  if (!checkMode) {
    writeFileSync(path, html);
    console.log(`wrote ${names.length} generated region${names.length === 1 ? '' : 's'} into ${path.slice(ROOT.length + 1)}`);
  }
}

if (checkMode && failures) {
  console.error(
    `\ngen-bench-page --check FAILED: ${failures} region(s) diverge from the committed benchmark artifacts.` +
      '\nIf the artifacts changed legitimately, run `node scripts/gen-bench-page.mjs` and commit the page diff.',
  );
  process.exit(1);
}
if (checkMode) console.log('\nall page numbers match the committed benchmark artifacts');
