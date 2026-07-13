// diff.wtf shell: state, event wiring, timing, and DOM rendering of the wasm
// engine's DiffResult. Behavior follows docs/design-handoff/README.md
// (Interactions section); the engine contract is docs/scaffold-spec.md.
//
// Rendering safety rule (CLAUDE.md): user and diff text enters the DOM only
// through textContent or text nodes, never through markup parsing.

import init, { compute } from '../pkg/diffwtf_wasm.js';
import { sampleA, sampleB } from './samples.js';

const VIEW_KEY = 'diffwtf:view';
const GRAN_KEY = 'diffwtf:granularity';

// localStorage persistence of view and granularity is allowed by the design
// but optional: degrade silently when storage is unavailable (private mode,
// blocked cookies, quota).
const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* persistence is optional */
    }
  },
};

const state = {
  left: '',
  right: '',
  view: storage.get(VIEW_KEY) === 'unified' ? 'unified' : 'split',
  gran: storage.get(GRAN_KEY) === 'char' ? 'char' : 'word',
};

let engineReady = false;
let computed = null; // last DiffResult from the engine
let computedMs = 0; // performance.now() around the wasm call, serialization included

const leftText = document.getElementById('left-text');
const rightText = document.getElementById('right-text');
const leftCount = document.getElementById('left-count');
const rightCount = document.getElementById('right-count');
const leftPane = document.getElementById('left-pane');
const rightPane = document.getElementById('right-pane');
const btnSplit = document.getElementById('btn-split');
const btnUnified = document.getElementById('btn-unified');
const btnWord = document.getElementById('btn-word');
const btnChar = document.getElementById('btn-char');
const btnExample = document.getElementById('btn-example');
const btnClear = document.getElementById('btn-clear');
const perfText = document.getElementById('perf-text');
const statAdded = document.getElementById('stat-added');
const statRemoved = document.getElementById('stat-removed');
const resultsLabel = document.getElementById('results-label');
const diffBody = document.getElementById('diff-body');

const engineButtons = [btnSplit, btnUnified, btnWord, btnChar, btnExample, btnClear];

function formatMs(ms) {
  return ms < 0.1 ? '<0.1' : ms.toFixed(1);
}

function updateCounts() {
  leftCount.textContent = `${state.left.length.toLocaleString()} chars · or drop a file`;
  rightCount.textContent = `${state.right.length.toLocaleString()} chars · or drop a file`;
}

function syncToggles() {
  btnSplit.classList.toggle('active', state.view === 'split');
  btnUnified.classList.toggle('active', state.view === 'unified');
  btnWord.classList.toggle('active', state.gran === 'word');
  btnChar.classList.toggle('active', state.gran === 'char');
}

// Appends a LineCell's segments to a content cell. Highlighted segments get a
// span with the intra-line highlight class; plain runs become bare text nodes.
function appendSegments(parent, segments, hlClass) {
  for (const seg of segments) {
    if (seg.highlighted) {
      const span = document.createElement('span');
      span.className = hlClass;
      span.textContent = seg.text;
      parent.append(span);
    } else {
      parent.append(document.createTextNode(seg.text));
    }
  }
}

// tone: 'eq' | 'del' | 'ins' | 'missing', mapped to the design's cell styles.
function numCell(number, tone) {
  const span = document.createElement('span');
  span.className = tone === 'eq' ? 'num' : `num ${tone}`;
  span.textContent = number == null ? '' : String(number);
  return span;
}

function contentCell(cell, tone, hlClass) {
  const span = document.createElement('span');
  span.className = tone === 'eq' ? 'cell' : `cell ${tone}`;
  if (cell) appendSegments(span, cell.segments, hlClass);
  return span;
}

function renderSplit(rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row-split';
    const leftTone = row.left ? (row.kind === 'equal' ? 'eq' : 'del') : 'missing';
    const rightTone = row.right ? (row.kind === 'equal' ? 'eq' : 'ins') : 'missing';
    div.append(
      numCell(row.left && row.left.number, leftTone),
      contentCell(row.left, leftTone, 'hl-del'),
      numCell(row.right && row.right.number, rightTone),
      contentCell(row.right, rightTone, 'hl-ins'),
    );
    frag.append(div);
  }
  return frag;
}

function renderUnified(rows) {
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row-unified';
    const tone = row.kind === 'equal' ? 'eq' : row.kind === 'delete' ? 'del' : 'ins';
    const content = document.createElement('span');
    content.className = tone === 'eq' ? 'cell' : `cell ${tone}`;
    appendSegments(content, row.segments, tone === 'ins' ? 'hl-ins' : 'hl-del');
    div.append(numCell(row.old_number, tone), numCell(row.new_number, tone), content);
    frag.append(div);
  }
  return frag;
}

function render() {
  const empty = !computed || computed.rows.length === 0;
  statAdded.textContent = `+${computed ? computed.added : 0}`;
  statRemoved.textContent = `−${computed ? computed.removed : 0}`;
  resultsLabel.textContent = empty
    ? 'paste text above to see the diff'
    : computed.added + computed.removed === 0
      ? 'texts are identical'
      : 'lines changed';
  perfText.textContent = !engineReady
    ? 'loading engine…'
    : empty
      ? 'ready · engine loaded'
      : `${computed.line_count} lines · ${formatMs(computedMs)} ms`;
  diffBody.hidden = empty;
  diffBody.replaceChildren();
  if (empty) return;
  diffBody.append(state.view === 'split' ? renderSplit(computed.rows) : renderUnified(computed.unified));
}

// Live diff on every input, no debounce. The Split/Unified toggle re-renders
// the last result without calling the engine; Word/Character recomputes.
function recompute() {
  if (!engineReady) return;
  const t0 = performance.now();
  computed = compute(state.left, state.right, state.gran);
  computedMs = performance.now() - t0;
  render();
}

function setTexts(left, right) {
  state.left = left;
  state.right = right;
  leftText.value = left;
  rightText.value = right;
  updateCounts();
  recompute();
}

function setView(view) {
  state.view = view;
  storage.set(VIEW_KEY, view);
  syncToggles();
  render();
}

function setGran(gran) {
  state.gran = gran;
  storage.set(GRAN_KEY, gran);
  syncToggles();
  recompute();
}

function wirePane(pane, textarea, apply) {
  textarea.addEventListener('input', () => {
    apply(textarea.value);
  });
  textarea.addEventListener('dragover', (e) => {
    e.preventDefault();
    pane.classList.add('dragover');
  });
  textarea.addEventListener('dragleave', () => {
    pane.classList.remove('dragover');
  });
  textarea.addEventListener('drop', (e) => {
    e.preventDefault();
    pane.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    file.text().then((text) => {
      textarea.value = text;
      apply(text);
    });
  });
}

wirePane(leftPane, leftText, (text) => {
  state.left = text;
  updateCounts();
  recompute();
});
wirePane(rightPane, rightText, (text) => {
  state.right = text;
  updateCounts();
  recompute();
});

btnSplit.addEventListener('click', () => setView('split'));
btnUnified.addEventListener('click', () => setView('unified'));
btnWord.addEventListener('click', () => setGran('word'));
btnChar.addEventListener('click', () => setGran('char'));
btnExample.addEventListener('click', () => setTexts(sampleA, sampleB));
btnClear.addEventListener('click', () => setTexts('', ''));

syncToggles();
updateCounts();

try {
  await init();
  engineReady = true;
  for (const btn of engineButtons) btn.disabled = false;
  // Picks up anything typed or dropped while the engine was loading; on empty
  // panes this renders the "ready · engine loaded" badge.
  recompute();
} catch (err) {
  // Engine failed to load: badge stays on "loading engine…" and the
  // engine-driven buttons stay disabled.
  console.error('diff.wtf: wasm engine failed to load', err);
}
