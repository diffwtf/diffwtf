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
const JSDIFF = '#e3b341'; // amber: the jsdiff (competitor) series, distinct from the green engine and gray refdiff
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
  'jsdiff total (incl. views)': 'jsdiff',
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
  // jsdiff is present on the vs-js header, absent on the browser header.
  const env = lines[1]?.match(/^# (node \S+) · (.+?) · commit (\S+)(?: · jsdiff (\S+))?$/);
  if (!env) fail(`${file}: unrecognized environment header line: ${lines[1]}`);
  return {
    node: env[1], cpu: env[2], commit: env[3], jsdiff: env[4] ?? null,
    method: lines[2]?.replace(/^# /, '') ?? '',
  };
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
    {
      'ratio (js total / wasm total)': 'total',
      'ratio (jsdiff total / wasm total)': 'jsdiff',
    },
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
    c.jsdiffMode = src.jsdiffMode ?? 'lines';
    c.ambiguous = Boolean(src.ambiguous);
    c.countsMayDiffer = Boolean(src.countsMayDiffer);
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

// Log-log scaling chart over the size-scaling family: refdiff, jsdiff, and
// wasm totals. The visual point is that jsdiff (amber) and wasm (green) track
// together — both are Myers — while refdiff (gray) runs higher and crosses.
function svgScaling(family, crossover) {
  const W = 720; const H = 380;
  const PL = 84; const PR = 36; const PT = 30; const PB = 74;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const xs = family.map((c) => c.size);
  const ys = family.flatMap((c) => [c.phases.js.val, c.phases.jsdiff.val, c.phases.total.val]);
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

  // Three series; shape and dash carry the distinction, not color alone:
  // refdiff dashed circles, jsdiff dotted diamonds, wasm solid squares.
  const jsPts = family.map((c) => [lx(c.size), ly(c.phases.js.val), c]);
  const jsdiffPts = family.map((c) => [lx(c.size), ly(c.phases.jsdiff.val), c]);
  const wasmPts = family.map((c) => [lx(c.size), ly(c.phases.total.val), c]);
  parts.push(
    `<polyline points="${jsPts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${TEXT2}" stroke-width="1.5" stroke-dasharray="5 4"/>`,
  );
  parts.push(
    `<polyline points="${jsdiffPts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${JSDIFF}" stroke-width="1.75" stroke-dasharray="2 3"/>`,
  );
  parts.push(
    `<polyline points="${wasmPts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`,
  );
  for (const [x, y, c] of jsPts) {
    parts.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${TEXT2}"><title>${esc(`${c.name}: refdiff ${ms(c.phases.js)}`)}</title></circle>`);
  }
  for (const [x, y, c] of jsdiffPts) {
    parts.push(`<path d="M ${x} ${(Number(y) - 4).toFixed(1)} L ${(Number(x) + 4).toFixed(1)} ${y} L ${x} ${(Number(y) + 4).toFixed(1)} L ${(Number(x) - 4).toFixed(1)} ${y} Z" fill="${JSDIFF}"><title>${esc(`${c.name}: jsdiff ${ms(c.phases.jsdiff)}`)}</title></path>`);
  }
  for (const [x, y, c] of wasmPts) {
    parts.push(
      `<rect x="${(x - 3.5).toFixed(1)}" y="${(y - 3.5).toFixed(1)}" width="7" height="7" fill="${ACCENT}"><title>${esc(`${c.name}: wasm pipeline ${ms(c.phases.total)}`)}</title></rect>`,
    );
  }
  // Legend in the top-left region, which the data never enters (all curves
  // rise left to right); marker shape and line style carry the series
  // distinction alongside color.
  const lgX = PL + 14;
  const lg1 = PT + 14;
  const lg2 = PT + 32;
  const lg3 = PT + 50;
  parts.push(`<line x1="${lgX}" y1="${lg1 - 4}" x2="${lgX + 26}" y2="${lg1 - 4}" stroke="${ACCENT}" stroke-width="2"/>`);
  parts.push(`<rect x="${lgX + 9.5}" y="${lg1 - 7.5}" width="7" height="7" fill="${ACCENT}"/>`);
  parts.push(svgText(lgX + 34, lg1, 'wasm pipeline (compute + view assembly)', { fill: ACCENT, weight: 700 }));
  parts.push(`<line x1="${lgX}" y1="${lg2 - 4}" x2="${lgX + 26}" y2="${lg2 - 4}" stroke="${JSDIFF}" stroke-width="1.75" stroke-dasharray="2 3"/>`);
  parts.push(`<path d="M ${lgX + 13} ${lg2 - 8} L ${lgX + 17} ${lg2 - 4} L ${lgX + 13} ${lg2} L ${lgX + 9} ${lg2 - 4} Z" fill="${JSDIFF}"/>`);
  parts.push(svgText(lgX + 34, lg2, 'jsdiff (npm diff, Myers)', { fill: JSDIFF, weight: 700 }));
  parts.push(`<line x1="${lgX}" y1="${lg3 - 4}" x2="${lgX + 26}" y2="${lg3 - 4}" stroke="${TEXT2}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  parts.push(`<circle cx="${lgX + 13}" cy="${lg3 - 4}" r="3.5" fill="${TEXT2}"/>`);
  parts.push(svgText(lgX + 34, lg3, 'refdiff.mjs (in-repo reference)', { weight: 700 }));

  const first = family[0];
  const last = family[family.length - 1];
  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="scaling-title scaling-desc">
    <title id="scaling-title">Median diff time by input size: refdiff, jsdiff, and the wasm pipeline</title>
    <desc id="scaling-desc">Line chart with logarithmic axes over the ${family.length} size-scaling cases, from ${first.name} (${first.size.toLocaleString('en-US')} characters) to ${last.name} (${last.size.toLocaleString('en-US')} characters). The jsdiff and wasm pipeline curves track close together across the whole range because both are Myers; the in-repo refdiff reference runs higher over the mid range and the wasm pipeline overtakes it between ${crossover.below.charsStr} and ${crossover.above.charsStr} characters. Exact values are in the table below the chart.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// Horizontal ratio bars for every case, jsdiff time over wasm time, on a LOG
// axis: the ratios span from about 0.6x to over 50x, so a linear axis would
// crush the parity cluster to nothing. Parity line at 1x. Bars start at the
// domain floor and run to the ratio; above 1x the engine is faster.
function svgRatios(cases) {
  const ROW = 27; const PT = 34; const PBOT = 52; const LABELW = 176;
  const W = 720; const H = PT + cases.length * ROW + PBOT;
  const plotX = LABELW; const plotW = W - LABELW - 96;
  const ratios = cases.map((c) => Number(c.ratios.jsdiff));
  const xDom = [Math.min(...ratios, 1) / 1.3, Math.max(...ratios) * 1.3];
  const lx = (v) =>
    (plotX + ((Math.log10(v) - Math.log10(xDom[0])) / (Math.log10(xDom[1]) - Math.log10(xDom[0]))) * plotW);
  const bottom = PT + cases.length * ROW;

  const parts = [];
  for (const v of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
    if (v < xDom[0] || v > xDom[1]) continue;
    const x = lx(v).toFixed(1);
    parts.push(`<line x1="${x}" y1="${PT - 8}" x2="${x}" y2="${bottom}" stroke="${GRID}"/>`);
    parts.push(svgText(Number(x), bottom + 16, `${v}x`, { anchor: 'middle', fill: FAINT }));
  }
  // Parity line, drawn under the bars; it shows through in the row gaps.
  parts.push(`<line x1="${lx(1).toFixed(1)}" y1="${PT - 8}" x2="${lx(1).toFixed(1)}" y2="${bottom}" stroke="${TEXT2}" stroke-dasharray="3 3"/>`);
  parts.push(svgText(lx(1), PT - 14, '1x = same speed as jsdiff', { anchor: 'middle' }));
  const x0 = lx(xDom[0]);
  cases.forEach((c, i) => {
    const y = PT + i * ROW;
    const ratio = Number(c.ratios.jsdiff);
    const win = ratio >= 1;
    const suffix = c.name === 'large-150kb-identical'
      ? ' (fast path, not engine speed)'
      : win ? '' : ' (slower than jsdiff)';
    parts.push(svgText(plotX - 10, y + 12, c.name, { anchor: 'end' }));
    parts.push(
      `<rect x="${x0.toFixed(1)}" y="${y + 3}" width="${Math.max(1, lx(ratio) - x0).toFixed(1)}" height="12" rx="3" fill="${win ? ACCENT : RED}"/>`,
    );
    parts.push(svgText(lx(ratio) + 8, y + 13, `${c.ratios.jsdiff}x${suffix}`, { fill: win ? ACCENT : RED }));
  });
  parts.push(
    svgText(plotX + plotW / 2, H - 14, 'jsdiff time / wasm time (log scale; right of 1x, the engine is faster)', { anchor: 'middle' }),
  );

  return `<svg class="bench-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ratios-title ratios-desc">
    <title id="ratios-title">Speed ratio per benchmark case, jsdiff time divided by wasm time</title>
    <desc id="ratios-desc">Bar chart of all ${cases.length} cases on a logarithmic scale with the 1x parity line marked. Most cases cluster near 1x (parity with jsdiff); two pathological cases extend far to the right where the engine is many times faster. Bars left of 1x are cases where the wasm pipeline is slower than jsdiff. Exact values are in the table below the chart.</desc>
    ${parts.join('\n    ')}
  </svg>`;
}

// Phase breakdown of the 150 KB marketing fixture, linear, zero baseline.
function svgPhases(c) {
  const rows = [
    ['refdiff total, for context', c.phases.js, TEXT2],
    ['jsdiff total, for context', c.phases.jsdiff, JSDIFF],
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
  const adversarial = need('adversarial-repeats');
  const spread = need('large-1mb-spread');
  const minified = need('minified-json');
  const family = vsJs.cases.filter((c) => c.sizeScaling).sort((a, b) => a.size - b.size);
  const browser150 = browser.cases.find((c) => c.name === 'large-150kb-sparse');
  if (!browser150) fail('expected case large-150kb-sparse in bench-browser.results.txt');
  const browserRatios = browser.cases
    .filter((c) => c.name !== 'large-150kb-identical')
    .map((c) => Number(c.ratios.withRender));
  const renderParity = { lo: Math.min(...browserRatios).toFixed(2), hi: Math.max(...browserRatios).toFixed(2) };

  const regions = new Map();

  // ---- home page: the "Milliseconds, not seconds" card ------------------
  // Honest framing: near parity with jsdiff on a typical diff (the two bars),
  // with the payoff being the bounded worst case (the caption). No inflated
  // multiplier is marketed; the worst-case numbers are the ones that justify
  // the engine, and they are stated plainly.
  const barPct = (v, max) => `${Math.max(1, Math.round((v / max) * 100))}%`;
  const homeMax = Math.max(big.phases.total.val, big.phases.jsdiff.val);
  const rewriteMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`);
  regions.set('home-chart', `      <p class="chart-intro">Myers diff implemented in Rust, compiled to WebAssembly. On an everyday diff it runs about even with <a href="https://github.com/kpdecker/jsdiff">jsdiff</a>, the standard JavaScript library — both finish a 5,000-line file in under two milliseconds. The payoff is the worst case: jsdiff's time climbs with the number of edits, while this engine's is capped.</p>
      <div class="chart">
        <div class="chart-bar">
          <div class="chart-labels"><span>5,000-line file · this engine</span><span class="accent">${ms(big.phases.total)}</span></div>
          <div class="chart-track"><div class="chart-fill" style="width: ${barPct(big.phases.total.val, homeMax)}"></div></div>
        </div>
        <div class="chart-bar">
          <div class="chart-labels"><span>5,000-line file · jsdiff</span><span>${ms(big.phases.jsdiff)}</span></div>
          <div class="chart-track"><div class="chart-fill" style="width: ${barPct(big.phases.jsdiff.val, homeMax)}; background: ${JSDIFF}"></div></div>
        </div>
        <span class="chart-caption">near parity on a typical diff; on a 3,000-line rewrite jsdiff takes ${rewriteMs(rewrite.phases.jsdiff.val)} and this engine ${rewriteMs(rewrite.phases.total.val)}. medians on committed fixtures: <a href="${GH}/scripts/bench-vs-js.mjs">scripts/bench-vs-js.mjs</a> · <a href="benchmarks.html">all benchmarks</a></span>
      </div>`);

  // ---- benchmarks page ---------------------------------------------------
  regions.set('bench-meta', `  <p class="bench-updated">committed run: ${esc(vsJs.meta.node)} · ${esc(vsJs.meta.cpu)} · commit ${esc(vsJs.meta.commit)} · jsdiff ${esc(vsJs.meta.jsdiff ?? '?')} · <a href="${GH}/scripts/bench-vs-js.results.txt">scripts/bench-vs-js.results.txt</a></p>`);

  const familyRows = family.map((c) => [
    c.name, c.note, c.charsStr, String(c.iterations),
    ms(c.phases.js), ms(c.phases.jsdiff), ms(c.phases.total), ms(c.phases.m10), `${c.ratios.jsdiff}x`,
  ]);
  // jsdiff parity band across the family, excluding the sub-crossover tiny case
  // where the wasm boundary floor (not the diff) dominates.
  const nonTiny = family.filter((c) => c.name !== 'tiny-snippet');
  const jFamRatios = nonTiny.map((c) => Number(c.ratios.jsdiff));
  const jLo = Math.min(...jFamRatios).toFixed(2);
  const jHi = Math.max(...jFamRatios).toFixed(2);
  const tinyCase = family.find((c) => c.name === 'tiny-snippet');
  regions.set('bench-scaling', `  <p>The size-scaling family uses the same line-based content shape at growing sizes, with edits concentrated in a bounded zone. The chart plots three pipelines per case: the wasm engine, jsdiff, and the in-repo refdiff reference. The story is the two Myers implementations — jsdiff and the engine — tracking together: setting aside ${tinyCase.name} (${tinyCase.ratios.jsdiff}x, where the wasm boundary floor costs more than the diff itself), the wasm pipeline stays within ${jLo}x to ${jHi}x of jsdiff across four orders of magnitude of input size. This is parity, and it is expected: both are Myers, so both scale the same way, and the engine's edge is the constant factor of running in wasm behind a compact boundary rather than a better asymptotic curve.</p>
  <p>refdiff, a naive LCS, is the slower line over the mid range; the wasm pipeline overtakes it between ${vsJs.crossover.below.name} (${crossoverStr(vsJs.crossover.below)}) and ${vsJs.crossover.above.name} (${crossoverStr(vsJs.crossover.above)}). That crossover is a refdiff artifact, not the headline — the headline is parity with a real competitor, and the pathological cases where that parity breaks in the engine's favor are in the next section.</p>
  <div class="bench-card">
    ${svgScaling(family, vsJs.crossover)}
  </div>
  ${table('scaling-table', 'Size-scaling cases: medians per pipeline (data for the chart above)', ['case', 'what it is', 'input, chars', 'runs', 'refdiff', 'jsdiff', 'wasm (call + assembly)', 'wasm (M10 page path)', 'ratio vs jsdiff'], familyRows, 2)}
  <p class="bench-note">The M10 page-path column models compute plus lazy row-model construction and one 60-row render window. It excludes the worker round trip used by the current site for larger inputs, so it is a pipeline breakdown rather than a live per-keystroke measurement. The comparison ratio is jsdiff total over the wasm full-assembly total, where both materialize every row.</p>`);

  // ---- the bounded-worst-case thesis ------------------------------------
  const tailRows = [
    [rewrite.name, rewrite.charsStr, ms(rewrite.phases.jsdiff), ms(rewrite.phases.total), `${rewrite.ratios.jsdiff}x`,
      'identical diff (delete-all then insert-all)'],
    [adversarial.name, adversarial.charsStr, ms(adversarial.phases.jsdiff), ms(adversarial.phases.total), `${adversarial.ratios.jsdiff}x`,
      'equally minimal, different shape'],
  ];
  regions.set('bench-tail', `  <p>Parity holds until the diff gets hard. jsdiff, like every textbook Myers implementation, runs in O(ND) time, where D is the number of edits between the two sides: cheap when the files are close, but the cost climbs with the edit distance and runs away when the files are far apart. This engine caps its search depth at a fixed bound (<code>MAX_D = 2048</code> line edits after trimming, <a href="${GH}/crates/diffwtf-core/src/myers.rs">crates/diffwtf-core/src/myers.rs</a>); past the bound it degrades deterministically to a delete-all/insert-all diff instead of searching further. That cap was added as a safety valve against pathological memory use, and it turns out to be the entire performance story: the engine's worst case is bounded, and jsdiff's is not.</p>
  <p>Two cases in the run cross that line. On <strong>${rewrite.name}</strong> — ${esc(rewrite.note)} — jsdiff spends ${ms(rewrite.phases.jsdiff)} where the engine spends ${ms(rewrite.phases.total)}, a ${rewrite.ratios.jsdiff}x difference, and the two produce the <em>identical</em> output: both delete every left line then insert every right line. Same answer, ${rewrite.ratios.jsdiff}x less time. On <strong>${adversarial.name}</strong> — ${esc(adversarial.note)} — the gap is ${adversarial.ratios.jsdiff}x (${ms(adversarial.phases.jsdiff)} against ${ms(adversarial.phases.total)}); here the two diffs are both minimal (they agree on the ${esc(adversarial.counts.replace(' lines', ''))} line counts) but pick a different equally-minimal shape, which is expected on maximally ambiguous input and is disclosed rather than papered over.</p>
  ${table('tail-table', 'The pathological tail: where jsdiff runs away and the engine does not', ['case', 'input, chars', 'jsdiff', 'wasm (call + assembly)', 'ratio vs jsdiff', 'output vs jsdiff'], tailRows, 1)}
  <p class="bench-note">These are the diffs that make a browser tab hang: ${ms(rewrite.phases.jsdiff)} for a 3,000-line rewrite is well past the threshold where a keystroke feels broken. Nobody notices a 3 ms diff; everybody notices a one-second one. A bounded worst case is worth more here than a faster typical case, and it is why the two rows above — not the parity band above them — are the reason to compile the engine to wasm.</p>`);

  regions.set('bench-losses', `  <p>The same run includes the cases where the wasm pipeline is slower than jsdiff or not directly comparable, measured with the same methodology as everything else:</p>
  <ul>
    <li><strong>Tiny inputs.</strong> On ${esc(tiny.note)}, jsdiff wins: ${ms(tiny.phases.jsdiff)} against ${ms(tiny.phases.total)} for the wasm pipeline (${tiny.ratios.jsdiff}x). Both are a fraction of a millisecond and both are far below the threshold anyone can perceive; below this size the fixed cost of crossing the wasm boundary is larger than the diff itself, and it does not matter.</li>
    <li><strong>Identical inputs.</strong> The ${identical.name} case (${identical.ratios.jsdiff}x vs jsdiff) measures a disclosed product shortcut, not engine speed: since M9 the engine short-circuits byte-identical inputs to a single Equal run. It is in the matrix because hiding a below-1x number would be spin; it must not be read as an engine measurement in either direction.</li>
    <li><strong>Complete rewrites, against refdiff specifically.</strong> The ${rewrite.name} case is the engine's biggest win against jsdiff (${rewrite.ratios.jsdiff}x, in the section above), but against the in-repo refdiff it is a loss: ${ms(rewrite.phases.total)} against refdiff's ${ms(rewrite.phases.js)} (${rewrite.ratios.total}x). refdiff's naive LCS bails out to delete-all/insert-all even more cheaply than the engine's capped Myers reaches the same answer; all three pipelines emit the identical diff here. So the honest reading depends on the baseline, and both are shown: a win against a real competitor, a loss against a reference that degrades faster. The engine's absolute cost on this case is tracked as <a href="https://github.com/diffwtf/diffwtf/issues/12">issue #12</a>.</li>
    <li><strong>Once the DOM dominates.</strong> In a real Chromium tab, rendering every row of a large diff into the DOM costs far more than computing it, so end to end the pipelines finish within ${renderParity.lo}x to ${renderParity.hi}x of each other on the browser-measured cases (identical fast path aside) — and against jsdiff, where compute is already near parity, that tie is immediate. The browser section below shows this in full; since M10 the site renders a virtualized window instead of every row, which is what keeps large diffs responsive.</li>
  </ul>`);

  const ratioRows = vsJs.cases.map((c) => [
    c.name, c.note, c.charsStr, String(c.iterations),
    ms(c.phases.js), ms(c.phases.jsdiff), ms(c.phases.total), `${c.ratios.jsdiff}x`, `${c.ratios.total}x`,
  ]);
  regions.set('bench-ratios', `  <p>Every case in the run, ranked by the jsdiff bar. The cluster around 1x is the parity band; the two bars that run off to the right are the bounded-worst-case wins. The <code>vs refdiff</code> column is the in-repo comparison for context — where it and <code>vs jsdiff</code> disagree, both are shown rather than the flattering one alone.</p>
  <div class="bench-card">
    ${svgRatios(vsJs.cases)}
  </div>
  ${table('ratios-table', 'All cases: medians per pipeline (data for the chart above)', ['case', 'what it is', 'input, chars', 'runs', 'refdiff', 'jsdiff', 'wasm (call + assembly)', 'vs jsdiff', 'vs refdiff'], ratioRows, 2)}
  <p class="bench-note">Counts note: jsdiff (real Myers) agrees with the engine on added/removed line counts on every case, which the benchmark asserts before timing. refdiff does not: on ${spread.name} it degrades past its LCS bailout (${esc(spread.counts)}), so its ratio there compares different amounts of useful work and its <code>vs refdiff</code> number favors the engine. The ${identical.name} bar measures the disclosed identical-input fast path plus the boundary floor, not engine speed. ${esc(minified.name)} compares against jsdiff diffWords, not diffLines: its single line makes the line-level diff a non-comparison against the engine's intra-line refinement.</p>`);

  regions.set('bench-phases', `  <p>Phases of the wasm pipeline on ${big.name}: ${esc(big.note)}. The result marshal is the cost of crossing the wasm boundary, the part M9 rewrote: with the sparse contract it is ${ms(big.phases.marshal)} here, measured as the difference between the compute call and a probe call that does the same work but returns only a checksum.</p>
  <div class="bench-card">
    ${svgPhases(big)}
  </div>
  ${table('phases-table', 'Phase medians on large-150kb-sparse (data for the chart above)', ['phase', 'median'], [
    ['refdiff total (compute incl. views), for context', ms(big.phases.js)],
    ['jsdiff total (incl. views), for context', ms(big.phases.jsdiff)],
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
  <p class="bench-note">The browser run predates the jsdiff baseline and still compares against refdiff, so its compute ratios are the refdiff numbers, not the jsdiff ones; the point it exists to make — that a full DOM render swamps any compute difference — is independent of which baseline the compute is measured against. Against jsdiff, where compute is already near parity on these sparse cases, the end-to-end tie is only more immediate. Adding jsdiff to the browser harness is follow-up work; the Node run above is where the engine-versus-jsdiff comparison lives.</p>
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

  regions.set('bench-methodology', `  <p>Every displayed benchmark value is parsed out of the committed artifacts by <a href="${GH}/scripts/gen-bench-page.mjs">scripts/gen-bench-page.mjs</a>, which regenerates this page and the home page chart; CI fails if the pages and artifacts diverge. CI never runs the benchmark itself — it only checks the committed numbers against the committed pages — so no benchmark dependency is installed in CI.</p>
  <p>Main run (<a href="${GH}/scripts/bench-vs-js.results.txt">scripts/bench-vs-js.results.txt</a>): ${esc(vsJs.meta.node)} · ${esc(vsJs.meta.cpu)} · commit ${esc(vsJs.meta.commit)} · jsdiff ${esc(vsJs.meta.jsdiff ?? '?')}. Reported values are ${esc(vsJs.meta.method)}. Three pipelines run in the same Node process (V8, the engine Chrome uses), interleaved so none gets a systematic cache or GC advantage: the wasm engine module the site ships, jsdiff (npm <code>diff</code>, pinned; a dev-only dependency of the benchmark harness that is never bundled into the site), and the in-repo refdiff reference. jsdiff runs diffLines for line structure, except <a href="${GH}/scripts/bench-cases.mjs">${esc(minified.name)}</a>, whose single line makes diffLines a non-comparison, where it runs diffWords to match the engine's intra-line refinement. Inputs are committed fixtures or deterministic seeded generators (<a href="${GH}/scripts/bench-cases.mjs">scripts/bench-cases.mjs</a>), reproducible from any checkout.</p>
  <p>Sanity checks run before timing: jsdiff and the engine must agree on added and removed line counts on every case (jsdiff is real Myers, so it agrees even where refdiff degrades past its LCS bailout on ${spread.name}), and every pipeline's output must reconstruct both inputs. All three totals include materializing every row into a renderable view, so the comparison charges each pipeline for the same view work and none is credited for skipping it. On ${rewrite.name} the engine and jsdiff verifiably emit the identical diff; on the ambiguous ${adversarial.name} they emit different but equally minimal diffs — both are checked, not assumed.</p>
  <p>Fairness notes, disclosed: the engine additionally refines within changed lines (word-level highlights) on the line cases, which jsdiff diffLines does not, so on the sparse cases the engine reaches parity while doing more, not less. The identical-input fast path is a product shortcut and never backs an engine-speed claim. The Node runner is not a browser page; the browser run exists to check that the story holds there.</p>
  <p>Reproduce it: <code>npm install</code> (to fetch the pinned jsdiff), <code>./scripts/build-wasm.sh</code>, then <code>node scripts/bench-vs-js.mjs</code> (and <code>node scripts/bench-browser.mjs</code> for the Chromium run), from <a href="https://github.com/diffwtf/diffwtf">the repo</a>. The committed results files are regenerated by piping stdout there and committing the diff, so the artifact history is reviewable like any other code.</p>`);

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
      'bench-meta', 'bench-scaling', 'bench-tail', 'bench-losses', 'bench-ratios',
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
