// diff.wtf hybrid engine client (M12): every caller uses the same promise-
// based diff() entry point. Small inputs call the wasm module directly;
// larger inputs use the dedicated worker. The transport is returned only as
// a timing label, never selected by the caller.

// Complete-rewrite benchmark in scripts/bench-dispatch-threshold.results.txt:
// 56,100 combined UTF-8 bytes measured 7.75 ms at the slower Character
// granularity for compute() (engine plus sparse-result marshal), while 57,750
// bytes measured 8.30 ms. Assembly is excluded because both routes build the
// row model/views on the main thread after receiving the same sparse arrays.
// The exact largest measured input under 8 ms is used rather than rounding.
export const SYNC_THRESHOLD_BYTES = 56_100;

const encoder = new TextEncoder();

function combinedBytes(left, right) {
  // UTF-8 is never shorter than UTF-16 code-unit count. Reject large inputs
  // without encoding them, so routing never scans more than the sync budget
  // on the main thread; only threshold candidates pay TextEncoder's exact
  // byte count (needed for non-ASCII input).
  if (left.length + right.length > SYNC_THRESHOLD_BYTES) return SYNC_THRESHOLD_BYTES + 1;
  return encoder.encode(left).byteLength + encoder.encode(right).byteLength;
}

export function createEngine({ forceRoute = null, onWorkerProgress = null } = {}) {
  let inlineCompute = null;
  let failed = false;
  let worker = null;
  let workerReady = false;
  let workerUnavailable = false;
  let workerFailed = false;
  let workerReadyResolve;
  const workerReadyPromise = new Promise((resolve) => {
    workerReadyResolve = resolve;
  });

  let nextId = 1;
  let newestId = 0;
  let inFlight = null;
  let waiting = null;

  const inlineReady = import('../pkg/diffwtf_wasm.js?v=m10').then(async (glue) => {
    await glue.default();
    inlineCompute = glue.compute;
    return true;
  }).catch((err) => {
    failed = true;
    console.error('diff.wtf: wasm engine failed to load', err);
    return false;
  });

  function pumpWorker() {
    if (!waiting || inFlight || !workerReady) return;
    const req = waiting;
    waiting = null;
    inFlight = req;
    worker.postMessage({
      type: 'diff',
      id: req.id,
      payload: { left: req.left, right: req.right, granularity: req.granularity },
    });
  }

  function settleWorker(deliver) {
    const req = inFlight;
    inFlight = null;
    deliver(req);
    pumpWorker();
  }

  function loseWorker(reason, allowFallback = !workerReady) {
    if (workerUnavailable) return;
    workerFailed = !allowFallback;
    workerUnavailable = true;
    workerReady = false;
    if (worker) worker.terminate();
    worker = null;
    workerReadyResolve(true); // direct fallback is ready when inlineReady is
    console.warn('diff.wtf: compute worker unavailable, falling back to main-thread compute:', reason);
    const queued = [inFlight, waiting];
    inFlight = null;
    waiting = null;
    if (!allowFallback) {
      for (const req of queued) {
        if (req) req.reject(new Error(reason));
      }
      return;
    }
    inlineReady.then((ok) => {
      for (const req of queued) {
        if (!req) continue;
        if (!ok) req.reject(new Error('diff engine failed to load'));
        else if (req.id !== newestId) req.resolve(null);
        else {
          try {
            req.resolve({ sparse: inlineCompute(req.left, req.right, req.granularity), timingLabel: 'engine' });
          } catch (err) {
            req.reject(err);
          }
        }
      }
    });
  }

  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
      name: 'diffwtf-engine',
    });
  } catch (err) {
    loseWorker(String(err));
  }

  if (worker) {
    worker.onmessage = (event) => {
      const { type, id, payload } = event.data;
      if (type === 'ready') {
        workerReady = true;
        workerReadyResolve(true);
        pumpWorker();
        return;
      }
      if (type === 'error' && id === 0) {
        // The worker loaded but its wasm init failed. The direct path loads
        // the same bytes and is not a meaningful fallback for this failure.
        loseWorker(payload.message, false);
        return;
      }
      if (type === 'progress') {
        if (onWorkerProgress) onWorkerProgress(id);
        return;
      }
      if (type !== 'result' && type !== 'error') return;
      if (!inFlight || id !== inFlight.id) return;
      if (id !== newestId || waiting) {
        settleWorker((req) => req.resolve(null));
      } else if (type === 'result') {
        settleWorker((req) => req.resolve({ sparse: payload, timingLabel: 'incl worker' }));
      } else {
        settleWorker((req) => req.reject(new Error(payload.message)));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      loseWorker(event.message || 'worker error');
    };
  }

  async function runInline(req) {
    if (!(await inlineReady) || failed) throw new Error('diff engine failed to load');
    if (req.id !== newestId) return null;
    const sparse = inlineCompute(req.left, req.right, req.granularity);
    return req.id === newestId ? { sparse, timingLabel: 'engine' } : null;
  }

  function diff(left, right, granularity) {
    const id = nextId++;
    newestId = id;
    const route = forceRoute ?? (combinedBytes(left, right) <= SYNC_THRESHOLD_BYTES ? 'sync' : 'worker');
    if (route === 'worker' && workerFailed) {
      return Promise.reject(new Error('compute worker failed'));
    }
    if (route === 'sync' || workerUnavailable) {
      if (waiting) {
        waiting.resolve(null);
        waiting = null;
      }
      return runInline({ id, left, right, granularity });
    }
    return new Promise((resolve, reject) => {
      if (waiting) waiting.resolve(null);
      waiting = { id, left, right, granularity, resolve, reject };
      pumpWorker();
    });
  }

  const ready = Promise.all([inlineReady, workerReadyPromise]).then(([inlineOk]) => inlineOk);
  return { ready, diff };
}
