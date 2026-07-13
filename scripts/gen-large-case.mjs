#!/usr/bin/env node
// scripts/gen-large-case.mjs — deterministic generator for the `large-perf`
// conformance case (~5000 lines, perf smoke). The generated
// fixtures/cases/large-perf.{left,right}.txt are committed; rerunning this
// script must reproduce them byte-for-byte (fixed xorshift32 seed, no
// Date/Math.random).
//
// Shape: a 2100-line common prefix, a 770-line edit zone (every 19th line
// modified, first and last zone lines always modified so prefix/suffix
// trimming stops exactly at the zone, plus two inserted lines on the right),
// and a 2130-line common suffix. After trimming, the reference's LCS DP is
// 770 × 772 = 594 440 cells — deliberately just under its 600 000-cell
// bailout, so the case exercises a real full-size DP pass instead of the
// degenerate del-all/ins-all path.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOTAL = 5000;
const ZONE_START = 2100;
const ZONE_END = 2870; // exclusive

let state = 0x9e3779b9;
function rand() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state;
}

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
];
const pick = () => WORDS[rand() % WORDS.length];

const leftLines = [];
for (let i = 0; i < TOTAL; i++) {
  leftLines.push(`l${String(i + 1).padStart(4, '0')} ${pick()} ${pick()} ${pick()} ${pick()}`);
}

const inZone = i => i >= ZONE_START && i < ZONE_END;
const isEdited = i =>
  inZone(i) && (i === ZONE_START || i === ZONE_END - 1 || (i - ZONE_START) % 19 === 0);

const rightLines = [];
for (let i = 0; i < TOTAL; i++) {
  let line = leftLines[i];
  if (isEdited(i)) {
    const words = line.split(' ');
    words[2] = `edited${i + 1}`; // one word swapped → an intra-line highlight per pair
    line = words.join(' ');
  }
  rightLines.push(line);
  if (i === 2300 || i === 2600) rightLines.push(`i${String(i + 1).padStart(4, '0')} inserted only on the right`);
}

const casesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cases');
writeFileSync(join(casesDir, 'large-perf.left.txt'), leftLines.join('\n') + '\n');
writeFileSync(join(casesDir, 'large-perf.right.txt'), rightLines.join('\n') + '\n');
console.log(`✓ large-perf: ${leftLines.length} left / ${rightLines.length} right lines`);
