// diff.wtf shell: state, event wiring, timing, and rendering. Behavior
// follows docs/design-handoff/README.md (Interactions section); the engine
// contract is docs/scaffold-spec.md. Since M9 the wasm engine returns the
// sparse v2 result (run-length ops plus highlight ranges); assemble.js
// rebuilds the renderable rows from it plus the original inputs, and
// render.js holds the DOM builders.
//
// Rendering safety rule (CLAUDE.md): user and diff text enters the DOM only
// through textContent or text nodes, never through markup parsing.

import init, { compute } from '../pkg/diffwtf_wasm.js';
import { assembleDiffResult } from './assemble.js';
import { renderSplit, renderUnified } from './render.js';
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

// A stored view preference always wins; with none stored, narrow viewports
// default to Unified and wider ones to the design's Split (DECISIONS.md D5).
const storedView = storage.get(VIEW_KEY);

const state = {
  left: '',
  right: '',
  view: storedView === 'unified' || storedView === 'split'
    ? storedView
    : window.matchMedia('(max-width: 767.98px)').matches
      ? 'unified'
      : 'split',
  gran: storage.get(GRAN_KEY) === 'char' ? 'char' : 'word',
};

let engineReady = false;
let computed = null; // last assembled result (rows, unified, counts)
// performance.now() around the wasm call PLUS the JS view assembly: with the
// sparse contract the renderable rows only exist after assembly, so this is
// the honest input-to-renderable cost the perf badge promises.
let computedMs = 0;

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

// Touch devices (hover: none) do not advertise drag and drop (DECISIONS.md
// D5): the counter suffix and the placeholders drop "or drop a file". The
// overlay is hidden by CSS; the drag listeners stay wired and are harmless.
const touchInput = window.matchMedia('(hover: none)');

function updateCounts() {
  const suffix = touchInput.matches ? ' chars' : ' chars · or drop a file';
  leftCount.textContent = `${state.left.length.toLocaleString()}${suffix}`;
  rightCount.textContent = `${state.right.length.toLocaleString()}${suffix}`;
}

function applyInputHints() {
  leftText.placeholder = touchInput.matches
    ? 'Paste original text…'
    : 'Paste original text… or drop a file';
  rightText.placeholder = touchInput.matches
    ? 'Paste changed text…'
    : 'Paste changed text… or drop a file';
  updateCounts();
}

function syncToggles() {
  btnSplit.classList.toggle('active', state.view === 'split');
  btnUnified.classList.toggle('active', state.view === 'unified');
  btnWord.classList.toggle('active', state.gran === 'word');
  btnChar.classList.toggle('active', state.gran === 'char');
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
  const sparse = compute(state.left, state.right, state.gran);
  computed = assembleDiffResult(state.left, state.right, sparse);
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

touchInput.addEventListener('change', applyInputHints);

syncToggles();
applyInputHints();

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
