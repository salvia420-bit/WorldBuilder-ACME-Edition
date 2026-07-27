// scene3d/net_worker.js
//
// Transport-in-worker port (2026-07-07) — the dedicated Web Worker that owns
// the WebSocket + the entire `holtburger_session::Session` state machine on
// its OWN wasm instance, off the browser main thread. See net_worker.rs for
// the full architecture rationale; in short: this worker runs
// `session.recv_message()` in a loop (which auto-ACKs every inbound packet)
// and pings ACE on its own wall-clock timer, so the session survives even a
// fully frozen / 100%-saturated main thread — the case the shipped
// main-thread `keepalive_worker` heartbeat could NOT cover.
//
// This file is a THIN bridge. All the real work (connect, login, sequencing,
// crypto, keepalive, ACK) lives in the worker's wasm (`net_worker_run`). Here
// we: init the wasm EAGERLY on worker load and post `{t:'ready'}` (so the
// main-thread client can fall back to the direct path if init fails), wire the
// wasm's worker→main post sink to `self.postMessage`, and forward main→worker
// `{t:'tx'}` outbound into `net_worker_submit_outbound`.
//
// Precedent: `scene3d/bake_worker.js` (a module worker that init()s its own
// wasm instance). We mirror its shape.
//
// Protocol (postMessage):
//   in : {t:'connect', bridgeUrl, host, port, user, pass}   start the session
//        {t:'tx', kind, bytes}                              one outbound wire msg
//   out: {t:'ready'}                wasm instantiated OK (init handshake)
//        {t:'rx', bytes}            one inbound game-message payload (transferable)
//        {t:'timesync', time}       server clock sample (seconds, ACE PortalYearTicks)
//        {t:'disconnect', reason}   socket/session ended (or connect failed)
//        {t:'error', reason}        worker-level failure (init/import)

import init, {
  net_worker_run,
  net_worker_submit_outbound,
  net_worker_set_sink,
} from "../pkg/holtburger_web.js?v=netrev-20260709";

// Must match the RX_KIND_* tags in net_worker.rs.
const RX_KIND_MESSAGE = 0;
const RX_KIND_DISCONNECT = 1;
const RX_KIND_TIMESYNC = 2;

let ready = false; // wasm init done
let started = false; // net_worker_run kicked off (once per worker lifetime)

// The sink the worker's wasm calls to hand a message to the main thread.
// `kind` selects the postMessage tag; message payloads transfer zero-copy.
function postToMain(kind, bytes) {
  if (kind === RX_KIND_MESSAGE) {
    // `bytes` is a fresh Uint8Array minted by the wasm side — transfer its
    // buffer so the hop is zero-copy.
    self.postMessage({ t: "rx", bytes }, [bytes.buffer]);
  } else if (kind === RX_KIND_TIMESYNC) {
    // 8-byte LE f64: server clock seconds (ACE PortalYearTicks domain).
    // Decoded here so the main thread receives a plain number.
    let time = NaN;
    try {
      time = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
    } catch (_) {}
    if (Number.isFinite(time)) self.postMessage({ t: "timesync", time });
  } else if (kind === RX_KIND_DISCONNECT) {
    let reason = "";
    try {
      reason = new TextDecoder().decode(bytes);
    } catch (_) {}
    self.postMessage({ t: "disconnect", reason });
  }
}

// Init EAGERLY (not lazily on `connect`) so the client gets a `ready`/`error`
// verdict up front and can fall back to the direct main-thread path if the
// worker's wasm can't instantiate (Finding 2: no silent forever-hang).
(async () => {
  try {
    await init();
    net_worker_set_sink(postToMain);
    ready = true;
    self.postMessage({ t: "ready" });
  } catch (e) {
    self.postMessage({ t: "error", reason: "init: " + ((e && e.message) || e) });
  }
})();

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.t === "connect") {
      if (started) return; // one session per worker; ignore a second connect
      if (!ready) {
        // Shouldn't happen — the client waits for `ready` before connecting.
        self.postMessage({ t: "error", reason: "connect before wasm ready" });
        return;
      }
      started = true;
      // Fire-and-forget: the returned Promise IS the long-running wire loop.
      // It only resolves on disconnect (after posting {t:'disconnect'}).
      net_worker_run(
        String(msg.bridgeUrl),
        String(msg.host),
        Number(msg.port),
        String(msg.user),
        String(msg.pass),
      );
    } else if (msg.t === "tx") {
      // Outbound wire message from the main-thread RemoteSessionProxy.
      // Dropped only pre-init (session isn't live yet); once `started`, the
      // worker's outbound queue is installed by net_worker_run.
      if (!ready) return;
      net_worker_submit_outbound(msg.kind & 0xff, msg.bytes);
    }
  } catch (e) {
    self.postMessage({ t: "error", reason: String((e && e.message) || e) });
  }
};
