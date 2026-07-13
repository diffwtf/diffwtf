#!/usr/bin/env node
// scripts/gen-fixtures.mjs — regenerates fixtures/expected/{name}.{word,char}.json
// by running the JS reference (reference/refdiff.mjs) over every input pair in
// fixtures/cases/. Usage: node scripts/gen-fixtures.mjs
//
// The reference is a faithful port of the design prototype; the Rust contract
// intentionally deviates from it in two documented ways (docs/scaffold-spec.md),
// and this generator normalizes the reference output so the committed expected
// fixtures match the contract:
//
// (a) Empty-line segments are `[]`, not the reference's " " placeholder.
//     The prototype substitutes a single space for empty line content, emitting
//     [{ "text": " ", "highlighted": false }]; the contract emits the true
//     empty segment list and lets the renderer's min-height give the row
//     height. A placeholder can only arise from a genuinely empty line (every
//     non-empty line tokenizes to at least one token), so this generator maps
//     the placeholder back to [] exactly where the underlying input line is
//     empty — and throws if that assumption is ever violated. This keeps
//     reconstructing the inputs from segment text byte-exact.
//
// (b) Char granularity tokenizes per Unicode scalar, not per UTF-16 code unit
//     (no split surrogate pairs). The prototype's split("") cuts astral
//     characters (emoji) into surrogate halves — and so does the word regex's
//     [^\w\s] class without the /u flag, so the same normalization applies at
//     word granularity. The generator runs the reference with
//     `unicodeScalars: true` (Array.from / the same regex with /u), which only
//     changes token boundaries, never the algorithm. Without it, expected
//     output could contain lone surrogates — not valid Unicode, and
//     unrepresentable in Rust strings (observable whenever both sides share a
//     surrogate half, e.g. 🎉 U+1F389 vs 🎊 U+1F38A share high surrogate
//     U+D83C). Every emitted segment is asserted well-formed.
//
// Output is pretty-printed for reviewable diffs, except results over 1000
// rows (the large perf-smoke case), which are written compact to keep the
// repo small.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compute } from '../reference/refdiff.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesDir = join(root, 'fixtures', 'cases');
const expectedDir = join(root, 'fixtures', 'expected');

const isPlaceholder = segments =>
  segments.length === 1 && segments[0].text === ' ' && segments[0].highlighted === false;

// Normalization (a): true-empty lines get the empty segment list.
function normalizeEmptyLines(result, leftLines, rightLines, label) {
  const fix = (cell, lines, side) => {
    if (!cell || lines[cell.number - 1] !== '') return cell;
    if (!isPlaceholder(cell.segments)) {
      throw new Error(`${label}: ${side} line ${cell.number} is empty but not the ' ' placeholder`);
    }
    return { ...cell, segments: [] };
  };
  for (const row of result.rows) {
    row.left = fix(row.left, leftLines, 'left');
    row.right = fix(row.right, rightLines, 'right');
  }
  for (const row of result.unified) {
    const line = row.old_number !== null
      ? leftLines[row.old_number - 1]
      : rightLines[row.new_number - 1];
    if (line !== '') continue;
    if (!isPlaceholder(row.segments)) {
      throw new Error(`${label}: unified row for an empty line is not the ' ' placeholder`);
    }
    row.segments = [];
  }
}

// Sanity: concatenated segment text must reconstruct both inputs exactly, and
// every segment must be well-formed Unicode (see normalization (b)).
function selfCheck(result, left, right, label) {
  const text = segments => segments.map(s => s.text).join('');
  for (const segments of [
    ...result.rows.flatMap(r => [r.left?.segments ?? [], r.right?.segments ?? []]),
    ...result.unified.map(u => u.segments),
  ]) {
    for (const s of segments) {
      if (!s.text.isWellFormed()) throw new Error(`${label}: segment contains a lone surrogate`);
      if (s.text === '') throw new Error(`${label}: empty segment text`);
    }
  }
  if (left.trim() === '' && right.trim() === '') return; // empty-state result carries no lines
  const rebuilt = {
    left: result.rows.filter(r => r.left).map(r => text(r.left.segments)).join('\n'),
    right: result.rows.filter(r => r.right).map(r => text(r.right.segments)).join('\n'),
    unifiedOld: result.unified.filter(u => u.old_number !== null).map(u => text(u.segments)).join('\n'),
    unifiedNew: result.unified.filter(u => u.new_number !== null).map(u => text(u.segments)).join('\n'),
  };
  if (rebuilt.left !== left || rebuilt.unifiedOld !== left) {
    throw new Error(`${label}: left input does not reconstruct from the output`);
  }
  if (rebuilt.right !== right || rebuilt.unifiedNew !== right) {
    throw new Error(`${label}: right input does not reconstruct from the output`);
  }
}

const names = readdirSync(casesDir)
  .filter(f => f.endsWith('.left.txt'))
  .map(f => f.slice(0, -'.left.txt'.length))
  .sort();
if (names.length === 0) throw new Error(`no cases found in ${casesDir}`);

mkdirSync(expectedDir, { recursive: true });
const wanted = new Set(names.flatMap(n => [`${n}.word.json`, `${n}.char.json`]));
for (const stale of readdirSync(expectedDir).filter(f => f.endsWith('.json') && !wanted.has(f))) {
  unlinkSync(join(expectedDir, stale));
  console.log(`✗ removed stale ${stale}`);
}

for (const name of names) {
  const left = readFileSync(join(casesDir, `${name}.left.txt`), 'utf8');
  const right = readFileSync(join(casesDir, `${name}.right.txt`), 'utf8');
  for (const granularity of ['word', 'char']) {
    const label = `${name}.${granularity}`;
    const result = compute(left, right, granularity, { unicodeScalars: true });
    normalizeEmptyLines(result, left.split('\n'), right.split('\n'), label);
    selfCheck(result, left, right, label);
    const json = result.rows.length > 1000 ? JSON.stringify(result) : JSON.stringify(result, null, 2);
    writeFileSync(join(expectedDir, `${label}.json`), json + '\n');
  }
  console.log(`✓ ${name}`);
}
