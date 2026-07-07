// scene3d/net_worker_client.js
//
// Transport-in-worker port (2026-07-07) — main-thread client for
// `net_worker.js`. Owns the `Worker` object (mirroring
// `bake_worker_client.js`) and bridges it to the main-thread wasm's
// `RemoteSessionProxy`:
//
//   • outbound: the wasm proxy calls our `outboundSink(kind, bytes)` →
//     we `worker.postMessage({t:'tx', …})` (transferable).
//   • inbound:  the worker posts `{t:'rx'|'disconnect'|'error', …}` →
//     we route into the wasm exports `net_proxy_push_inbound` /
//     `net_proxy_push_disconnect`.
//
// The wasm side is "armed" for worker mode via `net_worker_arm(sink)`
// immediately before `start_session`, so `start_session` builds a proxy
// instead of opening the socket on the main thread. Everything downstream
// (the recv loop, dispatch, TickMovement physics, the SessionHandle API)
// is identical to the direct path.
//
// Default: DISABLED. Enable per-session with `?netWorker=1` (also on/true).
//
// Lifecycle (hardened 2026-07-07 after adversarial review):
//   1. Exactly ONE net worker at a time. A new session TERMINATES the prior
//      worker first (the main-thread inbound routing is a single global slot;
//      a lingering old worker would post into the new session — Findings 1/3).
//   2. We wait for the worker's `{t:'ready'}` (wasm instantiated) before
//      arming + connecting. If the worker errors or times out before ready,
//      we terminate it and fall back to the direct `start_session` — so a
//      broken worker never hangs or regresses a working session (Finding 2).
//   3. `net_worker_arm` is called immediately before `start_session` with
//      nothing that can throw in between, so no stale arm is ever left for a
//      later direct call to pick up (Finding 5).

import init, {
  start_session,
  net_worker_arm,
  net_proxy_push_inbound,
  net_proxy_push_disconnect,
} from "../pkg/holtburger_web.js";

const READY_TIMEOUT_MS = 12000;

// At most one net worker alive at a time (see lifecycle note 1).
let _activeWorker = null;

function terminateActiveWorker() {
  if (!_activeWorker) return;
  try {
    _activeWorker.onmessage = null;
    _activeWorker.onerror = null;
    _activeWorker.terminate();
  } catch (_) {}
  _activeWorker = null;
}

/** `?netWorker=1|on|true` (default OFF — this is the newer, deeper fix and
 * still earning its default-on stripes; the shipped keepalive heartbeat
 * remains the default keepalive). */
export function netWorkerEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("netWorker");
    return v === "1" || v === "on" || v === "true";
  } catch (_) {
    return false;
  }
}

/**
 * Start a session with the socket + `Session` state machine running in a
 * dedicated Web Worker. Returns the same `SessionHandle` the main-thread
 * `start_session` returns. Falls back to the direct path (and logs) if the
 * worker can't be used.
 *
 * @param {string} bridgeUrl
 * @param {string} serverHost
 * @param {number} serverPort
 * @param {string} account
 * @param {string} password
 * @returns {Promise<any>} SessionHandle
 */
export async function startNetWorkerSession(bridgeUrl, serverHost, serverPort, account, password) {
  const direct = () => start_session(bridgeUrl, serverHost, serverPort, account, password);

  if (typeof Worker === "undefined") {
    console.warn("[net_worker_client] no Worker support; direct main-thread session");
    return direct();
  }

  // Kill any prior net worker so it can't post into this new session.
  terminateActiveWorker();

  // Ensure the main-thread wasm is instantiated before we arm/route into it.
  await init();

  let worker;
  try {
    worker = new Worker(new URL("./net_worker.js", import.meta.url), { type: "module" });
  } catch (e) {
    console.warn("[net_worker_client] worker spawn failed; direct session fallback:", e);
    return direct();
  }
  _activeWorker = worker;

  // Wait for the worker to confirm its wasm instantiated (`{t:'ready'}`), or
  // bail to the direct path on error/timeout. Until this resolves the worker
  // is not armed and start_session has not been called, so a failure here is
  // a clean fallback with no half-built proxy.
  const ready = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(to); resolve(v); } };
    const to = setTimeout(() => done(false), READY_TIMEOUT_MS);
    worker.onmessage = (ev) => {
      const t = ev.data && ev.data.t;
      if (t === "ready") done(true);
      else if (t === "error") {
        console.warn("[net_worker_client] worker init error:", ev.data.reason);
        done(false); // fail fast instead of waiting out the timeout
      }
    };
    worker.onerror = (e) => {
      console.warn("[net_worker_client] worker init error:", (e && e.message) || e);
      done(false);
    };
  });

  if (!ready || _activeWorker !== worker) {
    // Init failed/timed out, or a newer session superseded us mid-wait.
    if (_activeWorker === worker) terminateActiveWorker();
    else { try { worker.terminate(); } catch (_) {} }
    console.warn("[net_worker_client] worker not ready; falling back to direct main-thread session");
    return direct();
  }

  // Worker is live. Wire the real inbound router + a disconnect-surfacing
  // error handler, then arm + connect + start.
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.t === "rx") {
      net_proxy_push_inbound(m.bytes); // one game-message payload → proxy inbound
    } else if (m.t === "disconnect") {
      net_proxy_push_disconnect(String(m.reason || "net worker disconnect"));
    } else if (m.t === "error") {
      net_proxy_push_disconnect(String(m.reason || "net worker error"));
    }
  };
  worker.onerror = (e) => {
    // Surface a post-ready worker crash as a disconnect so the live recv loop
    // tears down cleanly (recv_message → Err → Disconnected event → exit).
    console.warn("[net_worker_client] worker error:", (e && e.message) || e);
    if (_activeWorker === worker) {
      try { net_proxy_push_disconnect("net worker error: " + ((e && e.message) || e)); } catch (_) {}
    }
  };

  // Outbound sink the wasm `RemoteSessionProxy` calls: one framed wire
  // message per call. `bytes` is a fresh Uint8Array from wasm — transfer its
  // buffer for a zero-copy hop into the worker.
  const outboundSink = (kind, bytes) => {
    try {
      worker.postMessage({ t: "tx", kind: kind & 0xff, bytes }, [bytes.buffer]);
    } catch (e) {
      console.warn("[net_worker_client] outbound postMessage failed:", e);
    }
  };

  // Tell the worker to connect+login. This is sent BEFORE arming so that if
  // postMessage were to throw, no stale arm is left for a later direct call
  // (Finding 5): arm and start_session are adjacent with nothing between.
  worker.postMessage({
    t: "connect",
    bridgeUrl: String(bridgeUrl),
    host: String(serverHost),
    port: Number(serverPort),
    user: String(account),
    pass: String(password),
  });

  net_worker_arm(outboundSink);
  console.log("[net_worker_client] session transport running in a dedicated worker (?netWorker=1)");
  const handle = await start_session(bridgeUrl, serverHost, serverPort, account, password);
  // Keep the worker referenced off the handle so it isn't GC'd; the module
  // singleton (`_activeWorker`) is what actually gets terminated on the next
  // session start.
  try { handle.__netWorker = worker; } catch (_) {}
  return handle;
}
