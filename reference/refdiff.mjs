// reference/refdiff.mjs — the JS reference implementation for diffwtf conformance.
//
// A dependency-free port of the design prototype's diff logic — `lcs`,
// `mergeSegs`, `intraDiff`, `compute` in `docs/design-handoff/Diff Checker.dc.html`
// (~lines 230–321) — with the presentation layer stripped: instead of style
// objects it emits the semantic `DiffResult` shape that diffwtf-core's serde
// Serialize impls produce (see docs/scaffold-spec.md). Keys and casing match
// the Rust output exactly, including the `rename_all = "lowercase"` row kinds
// ("equal" | "delete" | "insert" | "modify").
//
// The algorithm is otherwise faithful to the prototype, including two quirks
// of its JS-string world:
//
//   1. An empty line is emitted as the single-space placeholder segment
//      `[{ text: " ", highlighted: false }]` (the prototype substitutes " "
//      for empty content so the row has height).
//   2. Tokenization is per UTF-16 code unit: `char` granularity uses
//      String#split(""), and the `word` regex /\w+|\s+|[^\w\s]/g without the
//      /u flag also matches [^\w\s] one code unit at a time — both cut
//      astral-plane characters (emoji) into surrogate halves.
//
// The Rust contract intentionally deviates on both points; the fixture
// generator (scripts/gen-fixtures.mjs) documents and applies the
// normalizations. `compute`'s `unicodeScalars` option switches both
// tokenizers to per-Unicode-scalar boundaries (quirk 2) without touching the
// algorithm; quirk 1 is normalized on the output side by the generator.

/** LCS diff over two arrays of strings: common prefix/suffix trimming, an LCS
 * DP table over the middle, and a >600 000-cell bailout to naive
 * del-all/ins-all. Returns ops as ["eq"|"del"|"ins", item] pairs.
 * On DP ties the traceback prefers "del", so within a hunk all deletions
 * precede all insertions. */
export function lcs(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const am = a.slice(s, a.length - e), bm = b.slice(s, b.length - e);
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['eq', a[i]]);
  if (am.length * bm.length > 600000) {
    am.forEach(x => ops.push(['del', x]));
    bm.forEach(x => ops.push(['ins', x]));
  } else if (am.length || bm.length) {
    const n = am.length, m = bm.length;
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push(['eq', am[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', am[i]]); i++; }
      else { ops.push(['ins', bm[j]]); j++; }
    }
    while (i < n) ops.push(['del', am[i++]]);
    while (j < m) ops.push(['ins', bm[j++]]);
  }
  for (let k = 0; k < e; k++) ops.push(['eq', a[a.length - e + k]]);
  return ops;
}

/** Split a line into intra-line tokens. Prototype behavior by default;
 * `unicodeScalars` keeps the same token classes but takes whole Unicode
 * scalars (no split surrogate pairs). */
export function tokenize(text, granularity, unicodeScalars = false) {
  if (granularity === 'char') {
    return unicodeScalars ? Array.from(text) : text.split('');
  }
  const re = unicodeScalars ? /\w+|\s+|[^\w\s]/gu : /\w+|\s+|[^\w\s]/g;
  return text.match(re) || [];
}

/** Merge adjacent tokens with the same highlight state into segments. An
 * empty list becomes the prototype's single-space placeholder. */
export function mergeSegs(list) {
  const out = [];
  for (const t of list) {
    if (out.length && out[out.length - 1].highlighted === t.h) out[out.length - 1].text += t.text;
    else out.push({ text: t.text, highlighted: t.h });
  }
  return out.length ? out : [{ text: ' ', highlighted: false }];
}

/** Token-level refinement of one paired (Modify) line: returns
 * [leftSegments, rightSegments] with del/ins tokens highlighted. */
export function intraDiff(a, b, granularity, unicodeScalars = false) {
  const ops = lcs(tokenize(a, granularity, unicodeScalars), tokenize(b, granularity, unicodeScalars));
  const L = [], R = [];
  for (const [t, x] of ops) {
    if (t === 'eq') { L.push({ text: x, h: false }); R.push({ text: x, h: false }); }
    else if (t === 'del') L.push({ text: x, h: true });
    else R.push({ text: x, h: true });
  }
  return [mergeSegs(L), mergeSegs(R)];
}

/** The reference entry point: semantic `DiffResult` for two inputs at
 * granularity "word" | "char". Timing is deliberately not part of the result
 * (the product measures around the wasm call instead). */
export function compute(left, right, granularity, { unicodeScalars = false } = {}) {
  const plain = x => [{ text: x || ' ', highlighted: false }];
  const rows = [], unified = [];
  let added = 0, removed = 0;
  if (left.trim() === '' && right.trim() === '') {
    return { rows, unified, added, removed, line_count: 0 };
  }
  const ops = lcs(left.split('\n'), right.split('\n'));
  let i = 0, ln = 1, rn = 1;
  while (i < ops.length) {
    if (ops[i][0] === 'eq') {
      const segments = plain(ops[i][1]);
      rows.push({ kind: 'equal', left: { number: ln, segments }, right: { number: rn, segments } });
      unified.push({ kind: 'equal', old_number: ln, new_number: rn, segments });
      ln++; rn++; i++;
    } else {
      const dels = [], inss = [];
      while (i < ops.length && ops[i][0] === 'del') { dels.push(ops[i][1]); i++; }
      while (i < ops.length && ops[i][0] === 'ins') { inss.push(ops[i][1]); i++; }
      removed += dels.length; added += inss.length;
      const uDel = [], uIns = [];
      for (let k = 0; k < Math.max(dels.length, inss.length); k++) {
        const hasD = k < dels.length, hasI = k < inss.length;
        let lSegs = hasD ? plain(dels[k]) : [];
        let rSegs = hasI ? plain(inss[k]) : [];
        let kind = 'modify';
        if (hasD && hasI) [lSegs, rSegs] = intraDiff(dels[k], inss[k], granularity, unicodeScalars);
        else kind = hasD ? 'delete' : 'insert';
        rows.push({
          kind,
          left: hasD ? { number: ln, segments: lSegs } : null,
          right: hasI ? { number: rn, segments: rSegs } : null,
        });
        if (hasD) { uDel.push({ kind: 'delete', old_number: ln, new_number: null, segments: lSegs }); ln++; }
        if (hasI) { uIns.push({ kind: 'insert', old_number: null, new_number: rn, segments: rSegs }); rn++; }
      }
      // Within a hunk, all deleted lines precede all inserted lines.
      unified.push(...uDel, ...uIns);
    }
  }
  return {
    rows,
    unified,
    added,
    removed,
    line_count: Math.max(left.split('\n').length, right.split('\n').length),
  };
}
