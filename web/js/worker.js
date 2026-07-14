// diff.wtf compute worker (M10): runs the wasm diff off the main thread so
// a large input can never hang the tab. This is a module worker; it owns
// its OWN wasm instance, initialized here with the same wasm-bindgen glue
// the page uses (the glue module is stateless per context, and the wasm
// URL inside it is content-hashed by build-wasm.sh, so both contexts fetch
// identical bytes from the same cache entry).
//
// PRIVACY INVARIANT: this worker makes no network calls of any kind. The
// only requests from this context are the import of the local wasm glue
// below and the glue's fetch of its own .wasm binary, both same-origin
// static assets. No other fetch, XHR, WebSocket, or beacon may ever be
// added here: "nothing you paste or drop ever leaves this tab" depends on
// it.
//
// Message protocol (every message is {type, id, payload}; ids are the
// main thread's request ids, 0 for messages about the worker itself):
//
//   main -> worker
//     {type: 'diff', id, payload: {left, right, granularity}}
//
//   worker -> main
//     {type: 'ready',    id: 0, payload: null}        engine initialized
//     {type: 'progress', id,    payload: {phase: 'computing'}}
//                        this request started running (it may have queued
//                        behind an earlier one)
//     {type: 'result',   id,    payload: <sparse v2 object>}
//                        typed-array buffers ride the transfer list when
//                        possible (see postSparse)
//     {type: 'error',    id,    payload: {message}}   id 0 when init failed
//
// Requests are answered strictly in order; superseding stale requests is
// the client's job (web/js/engine.js keeps at most one request in flight
// and drops replies whose id is no longer the newest).

import init, { compute } from '../pkg/diffwtf_wasm.js?v=m10';

const ready = init().then(
  () => {
    postMessage({ type: 'ready', id: 0, payload: null });
    return true;
  },
  (err) => {
    postMessage({ type: 'error', id: 0, payload: { message: String(err) } });
    return false;
  },
);

// Zero-copy reply: move each typed array's ArrayBuffer to the main thread
// instead of cloning it. A buffer is only moved when the array owns it
// entirely (zero offset, full length); anything else, for example a view
// into shared wasm linear memory, fails that test and is structured-cloned
// instead, because transferring a shared buffer would neuter memory the
// engine still needs. The glue allocates every result array its own
// buffer, so in practice every buffer transfers. A transferred buffer is
// neutered in this context, which is fine: the worker never reads a result
// after replying. If the transfer-list postMessage throws (transfer not
// supported, or a value refuses to serialize with a transfer list), the
// same message is re-sent as a plain structured clone; per spec a throwing
// postMessage aborts before detaching, so the payload is still intact.
function postSparse(id, sparse) {
  const message = { type: 'result', id, payload: sparse };
  const transfer = [];
  const seen = new Set();
  for (const value of Object.values(sparse)) {
    if (
      ArrayBuffer.isView(value) &&
      value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength &&
      !seen.has(value.buffer)
    ) {
      seen.add(value.buffer);
      transfer.push(value.buffer);
    }
  }
  try {
    postMessage(message, transfer);
  } catch {
    postMessage(message);
  }
}

self.onmessage = async (event) => {
  const { type, id, payload } = event.data;
  if (type !== 'diff') return;
  if (!(await ready)) {
    postMessage({ type: 'error', id, payload: { message: 'diff engine failed to initialize in the worker' } });
    return;
  }
  postMessage({ type: 'progress', id, payload: { phase: 'computing' } });
  try {
    postSparse(id, compute(payload.left, payload.right, payload.granularity));
  } catch (err) {
    postMessage({ type: 'error', id, payload: { message: String(err) } });
  }
};
