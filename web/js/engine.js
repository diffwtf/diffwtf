// diff.wtf engine client (M10): the main thread's only way to run a diff.
// It spawns the dedicated compute worker (web/js/worker.js) and talks its
// {type, id, payload} protocol, so the diff path never makes a synchronous
// wasm call on the main thread.
//
// Request discipline:
//
//   Correlation   every diff() call gets an increasing id; a reply is only
//                 delivered while its id is still the newest request, so a
//                 newer diff supersedes a stale one (superseded calls
//                 resolve null and their results are dropped, never
//                 rendered).
//   Coalescing    at most one request is in flight in the worker; while
//                 one runs, only the latest waiting request is kept.
//                 Typing into a large file therefore queues at most one
//                 follow-up diff instead of a keystroke-deep backlog.
//
// Fallback: if module workers are unavailable or the worker dies before
// signalling ready, the client loads the same wasm module on the main
// thread and computes there (the pre-M10 path). That keeps old browsers
// working at the cost of blocking during compute; the request discipline
// and every caller-visible behavior stay identical.

export function createEngine() {
  let mode = 'starting'; // 'starting' | 'worker' | 'inline' | 'failed'
  let worker = null;
  let inlineCompute = null;

  let nextId = 1;
  let inFlight = null; // {id, resolve, reject}
  let waiting = null; // {id, left, right, granularity, resolve, reject}

  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  function pump() {
    if (!waiting || inFlight) return;
    if (mode === 'inline' && !inlineCompute) return; // fallback still loading; ready resolution pumps again
    const req = waiting;
    waiting = null;
    if (mode === 'worker') {
      inFlight = { id: req.id, resolve: req.resolve, reject: req.reject };
      worker.postMessage({
        type: 'diff',
        id: req.id,
        payload: { left: req.left, right: req.right, granularity: req.granularity },
      });
    } else if (mode === 'inline') {
      try {
        req.resolve(inlineCompute(req.left, req.right, req.granularity));
      } catch (err) {
        req.reject(err);
      }
    }
  }

  function settleInFlight(deliver) {
    const req = inFlight;
    inFlight = null;
    deliver(req);
    pump();
  }

  async function fallbackToInline(reason) {
    if (mode !== 'starting') return;
    mode = 'inline';
    console.warn('diff.wtf: compute worker unavailable, falling back to main-thread compute:', reason);
    try {
      const glue = await import('../pkg/diffwtf_wasm.js?v=m10');
      await glue.default();
      inlineCompute = glue.compute;
      readyResolve(true);
      pump();
    } catch (err) {
      mode = 'failed';
      readyResolve(false);
      for (const req of [inFlight, waiting]) {
        if (req) req.reject(err instanceof Error ? err : new Error(String(err)));
      }
      inFlight = null;
      waiting = null;
    }
  }

  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
      name: 'diffwtf-engine',
    });
  } catch (err) {
    worker = null;
    fallbackToInline(String(err));
  }

  if (worker) {
    worker.onmessage = (event) => {
      const { type, id, payload } = event.data;
      if (type === 'ready') {
        mode = 'worker';
        readyResolve(true);
        pump();
        return;
      }
      if (type === 'error' && id === 0) {
        // Init failed inside the worker (for example the wasm fetch): the
        // inline path would fail the same way, so report failure instead
        // of falling back into a second doomed load.
        if (mode === 'starting') {
          mode = 'failed';
          readyResolve(false);
        }
        if (inFlight) settleInFlight((req) => req.reject(new Error(payload.message)));
        return;
      }
      if (type === 'progress') return; // the page keeps its own loading state
      if (type !== 'result' && type !== 'error') return;
      if (!inFlight || id !== inFlight.id) return; // stale reply, already superseded
      if (waiting) {
        // A newer request is queued: this result is stale by definition.
        settleInFlight((req) => req.resolve(null));
      } else if (type === 'result') {
        settleInFlight((req) => req.resolve(payload));
      } else {
        settleInFlight((req) => req.reject(new Error(payload.message)));
      }
    };
    worker.onerror = (event) => {
      // Before ready this fires when the browser cannot run the module
      // worker at all (for example no module-worker support): fall back.
      // After ready it is an uncaught worker exception: fail the request.
      if (mode === 'starting') {
        event.preventDefault();
        worker.terminate();
        worker = null;
        fallbackToInline(event.message || 'worker error');
      } else if (inFlight) {
        settleInFlight((req) => req.reject(new Error(event.message || 'worker error')));
      }
    };
  }

  function diff(left, right, granularity) {
    return new Promise((resolve, reject) => {
      if (mode === 'failed') {
        reject(new Error('diff engine failed to load'));
        return;
      }
      if (waiting) waiting.resolve(null); // superseded before it ever ran
      waiting = { id: nextId++, left, right, granularity, resolve, reject };
      pump();
    });
  }

  return { ready, diff };
}
