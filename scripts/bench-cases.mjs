// scripts/bench-cases.mjs: the shared input matrix for the diff.wtf
// benchmarks (bench-vs-js.mjs in Node, bench-browser.mjs in a real page).
// Pure module, no Node APIs, so the browser can import it over HTTP.
//
// Every input is reproducible from a clean checkout: fixture cases reference
// committed files (loaded by the caller); generated cases build their text
// deterministically from a fixed xorshift32 seed, the same generator family
// as scripts/gen-large-case.mjs. No Date, no Math.random.
//
// Fairness note, disclosed openly: the sparse-edit generators cluster edits
// in a zone of at most 700 lines because the JS reference's line-level LCS
// bails out (degrades to del-all/ins-all) when the trimmed middle exceeds
// 600 000 DP cells. Inside that limit both engines produce the identical
// minimal diff, so the timing comparison is same work, same output. The
// spread-edits and complete-rewrite cases deliberately step outside the
// limit to show what happens there; their notes say what changes.

export function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

const WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
];

function makeLines(count, tag, rand) {
  const pick = () => WORDS[rand() % WORDS.length];
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`${tag}${String(i + 1).padStart(5, '0')} ${pick()} ${pick()} ${pick()} ${pick()}`);
  }
  return lines;
}

// Edit every `editEvery`-th line inside [zoneStart, zoneEnd), always editing
// the first and last zone lines so prefix/suffix trimming stops exactly at
// the zone, plus `inserts` extra right-side lines spaced evenly in the zone.
function zoneEdit(leftLines, zoneStart, zoneEnd, editEvery, inserts) {
  const zoneLen = zoneEnd - zoneStart;
  const insertAfter = new Set();
  for (let j = 1; j <= inserts; j++) {
    insertAfter.add(zoneStart + Math.floor((zoneLen * j) / (inserts + 1)));
  }
  const right = [];
  for (let i = 0; i < leftLines.length; i++) {
    let line = leftLines[i];
    if (
      i >= zoneStart && i < zoneEnd &&
      (i === zoneStart || i === zoneEnd - 1 || (i - zoneStart) % editEvery === 0)
    ) {
      const words = line.split(' ');
      words[2] = `edited${i + 1}`;
      line = words.join(' ');
    }
    right.push(line);
    if (insertAfter.has(i)) {
      right.push(`ins${String(i + 1).padStart(5, '0')} inserted only on the right`);
    }
  }
  return right;
}

function minifiedJson(keys, editedKey) {
  const obj = {};
  const rand = xorshift32(0x00d1ff17);
  for (let i = 0; i < keys; i++) {
    const w = () => WORDS[rand() % WORDS.length];
    obj[`key${String(i).padStart(4, '0')}`] = `${w()} ${w()} ${w()} ${rand() % 100000}`;
  }
  const left = JSON.stringify(obj);
  obj[editedKey] = 'edited value that differs between the two sides';
  const right = JSON.stringify(obj);
  return { left, right };
}

// Each case: { name, note, iterations } plus either
//   fixture: { left, right } committed file paths (repo-relative), or
//   build(): { left, right } strings, deterministic.
// countsMayDiffer marks the one case where the two engines legitimately
// disagree on added/removed (the reference degrades, the engine does not);
// ambiguous marks equally minimal but possibly different diffs. Everything
// else must agree on added/removed exactly, which the benchmarks assert.
// sizeScaling marks the family of sparse-edit cases that differ only by
// scale; the crossover statement is computed over these alone, because the
// js/wasm ratio is content-dependent, not size-monotonic (complete-rewrite
// sits above the size crossover and still loses).
export const CASES = [
  {
    name: 'tiny-snippet',
    sizeScaling: true,
    note: 'the "Load example" pair every visitor sees (343 + 360 chars)',
    fixture: {
      left: 'fixtures/cases/sample-rust.left.txt',
      right: 'fixtures/cases/sample-rust.right.txt',
    },
    iterations: 50,
  },
  {
    name: 'small-10kb',
    sizeScaling: true,
    note: '330 lines / ~10 KB, 12 edited lines in one zone',
    build() {
      const left = makeLines(330, 'l', xorshift32(0x10b10b10));
      const right = zoneEdit(left, 100, 220, 12, 0);
      return { left: left.join('\n') + '\n', right: right.join('\n') + '\n' };
    },
    iterations: 50,
  },
  {
    name: 'mid-40kb',
    sizeScaling: true,
    note: '1,300 lines / ~40 KB, 22 edited lines in one zone',
    build() {
      const left = makeLines(1300, 'l', xorshift32(0x40b40b40));
      const right = zoneEdit(left, 400, 1000, 30, 0);
      return { left: left.join('\n') + '\n', right: right.join('\n') + '\n' };
    },
    iterations: 50,
  },
  {
    name: 'large-150kb-sparse',
    sizeScaling: true,
    note: '5,000 lines / 150 KB, 44 edited lines (the committed marketing fixture)',
    fixture: {
      left: 'fixtures/cases/large-perf.left.txt',
      right: 'fixtures/cases/large-perf.right.txt',
    },
    iterations: 50,
  },
  {
    name: 'large-150kb-identical',
    note: '150 KB, byte-identical sides: measures the identical-input fast path plus boundary floor, NOT engine speed',
    fixture: {
      left: 'fixtures/cases/large-perf.left.txt',
      right: 'fixtures/cases/large-perf.left.txt',
    },
    iterations: 50,
  },
  {
    name: 'lines-10k',
    sizeScaling: true,
    note: '10,000 lines / ~310 KB, 60 edited lines in one zone',
    build() {
      const left = makeLines(10000, 'l', xorshift32(0x10c10c10));
      const right = zoneEdit(left, 4000, 4700, 12, 2);
      return { left: left.join('\n') + '\n', right: right.join('\n') + '\n' };
    },
    iterations: 50,
  },
  {
    name: 'large-1mb-sparse',
    sizeScaling: true,
    note: '33,000 lines / ~1 MB, 72 edited lines in one zone',
    build() {
      const left = makeLines(33000, 'l', xorshift32(0x1abcde01));
      const right = zoneEdit(left, 15000, 15700, 10, 3);
      return { left: left.join('\n') + '\n', right: right.join('\n') + '\n' };
    },
    iterations: 25,
  },
  {
    name: 'large-1mb-spread',
    note: '33,000 lines / ~1 MB, ~110 edits spread across the whole file: past the reference LCS bailout, so the reference degrades to a full rewrite while the engine stays minimal; output quality differs and added/removed counts are reported per side',
    countsMayDiffer: true,
    build() {
      const left = makeLines(33000, 'l', xorshift32(0x1abcde02));
      const right = [];
      for (let i = 0; i < left.length; i++) {
        let line = left[i];
        if (i % 300 === 5) {
          const words = line.split(' ');
          words[2] = `edited${i + 1}`;
          line = words.join(' ');
        }
        right.push(line);
      }
      return { left: left.join('\n') + '\n', right: right.join('\n') + '\n' };
    },
    iterations: 25,
  },
  {
    name: 'complete-rewrite',
    note: '3,000 vs 3,000 lines with nothing in common: both engines take their documented degradation path (reference LCS bailout, engine depth cap) and emit the same del-all/ins-all diff',
    build() {
      return {
        left: makeLines(3000, 'a', xorshift32(0x0e0e0e01)).join('\n') + '\n',
        right: makeLines(3000, 'b', xorshift32(0x0e0e0e02)).join('\n') + '\n',
      };
    },
    iterations: 25,
  },
  {
    name: 'adversarial-repeats',
    note: '700 lines per side drawn from a 12-line pool, independently shuffled: maximal ambiguity; both engines produce minimal diffs that may differ in shape but must agree on counts',
    ambiguous: true,
    build() {
      const pool = makeLines(12, 'p', xorshift32(0x9e3779b9));
      const draw = (seed, count) => {
        const rand = xorshift32(seed);
        const lines = [];
        for (let i = 0; i < count; i++) lines.push(pool[rand() % pool.length]);
        return lines.join('\n') + '\n';
      };
      return { left: draw(0xad0ad001, 700), right: draw(0xad0ad002, 700) };
    },
    iterations: 50,
  },
  {
    name: 'minified-json',
    note: 'single-line minified JSON, ~150 KB per side, one value edited mid-string: exercises intra-line refinement with prefix/suffix trimming on one huge line',
    build() {
      return minifiedJson(4000, 'key2000');
    },
    iterations: 50,
  },
];
