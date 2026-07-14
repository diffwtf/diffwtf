// diff.wtf shell: state, event wiring, timing, and rendering. Behavior
// follows docs/design-handoff/README.md (Interactions section); the engine
// contract is docs/scaffold-spec.md. Since M9 the engine returns the sparse
// v2 result (run-length ops plus highlight ranges); since M10 the wasm call
// runs in a dedicated Web Worker (engine.js/worker.js), rowmodel.js gives
// lazy access to the renderable rows, and virtual.js windows the DOM so
// only the rows near the viewport exist, whatever the input size. The main
// thread never runs the diff synchronously.
//
// Rendering safety rule (CLAUDE.md): user and diff text enters the DOM only
// through textContent or text nodes, never through markup parsing.

import { createEngine } from './engine.js';
import { createRowModel } from './rowmodel.js';
import { splitRowElement, unifiedRowElement } from './render.js';
import { createVirtualList } from './virtual.js';
import { wireCopy } from './selection.js';
import { sampleA, sampleB } from './samples.js';

const VIEW_KEY = 'diffwtf:view';
const GRAN_KEY = 'diffwtf:granularity';

// Size guardrails (M10). Limits are UTF-16 code units (String.length, the
// unit the page already has) per side, checked before compute; both are
// local-only behavior and nothing is uploaded at any size.
//
// SOFT_WARN_CHARS: past this the diff still runs, in the worker, but the
// user gets a dismissible heads-up that inputs this large can take a
// moment; 8 million units is roughly an 8 MB source file, above the
// largest case the committed benchmark calls interactive.
//
// HARD_CAP_CHARS: past this the diff is refused with a visible notice
// instead of risking an out-of-memory tab. The worker copies both inputs
// into wasm linear memory as UTF-8 (up to 3 bytes per unit for CJK-heavy
// text) next to its line tables and the depth-capped Myers trace
// (DECISIONS.md D3); 64 million units per side keeps that worst case
// comfortably inside wasm32's 4 GB ceiling with margin for the JS side.
// A deliberate product cap, not a measured cliff: raising it needs a real
// memory profile, not a constant edit. See DECISIONS.md D8.
const SOFT_WARN_CHARS = 8_000_000;
const HARD_CAP_CHARS = 64_000_000;

// The perf badge flips to "computing…" only when a diff has been running
// for a noticeable beat, so instant diffs never flicker the badge.
const LOADING_BADGE_DELAY_MS = 150;

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

const engine = createEngine();
let engineReady = false;
let model = null; // lazy row model over the last sparse result (rowmodel.js)
let virtualList = null;
// performance.now() from posting the diff to the worker until the sparse
// reply is received AND the row model over it is built: the honest
// input-to-renderable cost the perf badge promises (renderable rows exist
// exactly when the model does; the windowed DOM render is what the old
// badge also excluded).
let computedMs = 0;
let requestSeq = 0;
let loadingTimer = 0;

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
const sizeNotice = document.getElementById('size-notice');
const sizeNoticeText = document.getElementById('size-notice-text');
const sizeNoticeDismiss = document.getElementById('size-notice-dismiss');

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

// Size guardrail notice. Dismissing hides it until the inputs change size
// class again (dropping back under a threshold re-arms it).
let noticeLevel = null; // 'cap' | 'warn' | null
let noticeDismissed = false;

function sizeLevel() {
  const max = Math.max(state.left.length, state.right.length);
  return max > HARD_CAP_CHARS ? 'cap' : max > SOFT_WARN_CHARS ? 'warn' : null;
}

function syncSizeNotice() {
  const level = sizeLevel();
  if (level !== noticeLevel) {
    noticeLevel = level;
    noticeDismissed = false;
  }
  if (!level || noticeDismissed) {
    sizeNotice.hidden = true;
    return;
  }
  sizeNoticeText.textContent = level === 'cap'
    ? 'Input too large: diffs are capped at 64 million characters per side so the tab stays stable. Nothing you pasted left the browser.'
    : 'Large input: the diff still runs locally in your browser, but files this big can take a moment to compute.';
  sizeNotice.hidden = false;
}

sizeNoticeDismiss.addEventListener('click', () => {
  noticeDismissed = true;
  sizeNotice.hidden = true;
});

function clearLoadingBadge() {
  if (loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = 0;
  }
}

function render() {
  const empty = !model || model.splitCount === 0;
  statAdded.textContent = `+${model ? model.added : 0}`;
  statRemoved.textContent = `−${model ? model.removed : 0}`;
  resultsLabel.textContent = sizeLevel() === 'cap'
    ? 'input too large to diff'
    : empty
      ? 'paste text above to see the diff'
      : model.added + model.removed === 0
        ? 'texts are identical'
        : 'lines changed';
  perfText.textContent = !engineReady
    ? 'loading engine…'
    : empty
      ? 'ready · engine loaded'
      : `${model.line_count} lines · ${formatMs(computedMs)} ms`;
  if (virtualList) {
    virtualList.destroy();
    virtualList = null;
  }
  diffBody.hidden = empty;
  diffBody.replaceChildren();
  if (empty) return;
  virtualList = createVirtualList({
    container: diffBody,
    count: state.view === 'split' ? model.splitCount : model.unifiedCount,
    renderRow: state.view === 'split'
      ? (i) => splitRowElement(model.splitRow(i))
      : (i) => unifiedRowElement(model.unifiedRow(i)),
  });
}

// Live diff on every input, no debounce: the worker computes off the main
// thread and engine.js coalesces bursts, so typing stays smooth at any
// size. The Split/Unified toggle re-renders the last result without
// calling the engine; Word/Character recomputes. Requests carry a
// sequence number so a stale reply can never overwrite a newer render.
function recompute() {
  if (!engineReady) return;
  syncSizeNotice();
  requestSeq += 1;
  const seq = requestSeq;
  if (sizeLevel() === 'cap') {
    clearLoadingBadge();
    model = null;
    render();
    return;
  }
  const t0 = performance.now();
  if (!loadingTimer) {
    loadingTimer = setTimeout(() => {
      perfText.textContent = 'computing…';
    }, LOADING_BADGE_DELAY_MS);
  }
  engine.diff(state.left, state.right, state.gran).then(
    (sparse) => {
      if (seq !== requestSeq || sparse === null) return; // superseded
      model = createRowModel(state.left, state.right, sparse);
      computedMs = performance.now() - t0;
      clearLoadingBadge();
      render();
    },
    (err) => {
      if (seq !== requestSeq) return;
      clearLoadingBadge();
      console.error('diff.wtf: diff failed', err);
      perfText.textContent = 'engine error · details in the console';
    },
  );
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

// Copy across virtualized rows: reconstruct the true text from the model
// instead of trusting the windowed DOM (selection.js has the contract).
wireCopy({
  container: diffBody,
  getView: () => state.view,
  getModel: () => model,
});

syncToggles();
applyInputHints();

engine.ready.then((ok) => {
  if (!ok) {
    // Engine failed to load: badge stays on "loading engine…" and the
    // engine-driven buttons stay disabled (errors were already logged).
    console.error('diff.wtf: wasm engine failed to load');
    return;
  }
  engineReady = true;
  for (const btn of engineButtons) btn.disabled = false;
  // Picks up anything typed or dropped while the engine was loading; on empty
  // panes this renders the "ready · engine loaded" badge.
  recompute();
});

// Test and diagnostics handle, used by scripts/check-virtual.mjs: read
// access to the current model plus the windowing controls. Not a public
// API; may change at any time.
window.__diffwtf = {
  get model() {
    return model;
  },
  get view() {
    return state.view;
  },
  scrollToRow(i) {
    if (virtualList) virtualList.scrollToRow(i);
  },
};
