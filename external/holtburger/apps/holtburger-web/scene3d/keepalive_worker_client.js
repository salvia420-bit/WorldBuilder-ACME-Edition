// scene3d/keepalive_worker_client.js
//
// keepaliveFix (2026-07-07) — main-thread client for `keepalive_worker.js`.
//
// PROBLEM: sessions drop with ACE "Network Timeout". ACE reaps a session
// after 60s with no inbound client packet, reset by ANY inbound packet
// (ace-server .../Network/NetworkSession.cs). Every client keepalive path
// (the 2.5s `setInterval` in index.html, and the wasm recv-loop's own
// gloo-timers ping) runs on the BROWSER MAIN THREAD, so it is throttled to
// >=1s — and ~1/min after ~5 min hidden, and paused outright on some
// occluded/frozen tabs — when the tab is backgrounded, and it starves under
// main-thread bake/decode jank. Then no packet leaves for 60s → drop. This
// hits real backgrounded players and headless bots alike.
//
// FIX: a dedicated Web Worker owns the heartbeat timer. A dedicated worker's
// timers are NOT subject to the main-thread hidden-tab throttling and the
// worker is not blocked by main-thread bake/decode. Each tick it posts a
// message to the main thread; `onTick` forwards to
// `SessionHandle.sendKeepalive()` (→ wasm `ForceKeepalive` → PingRequest).
// A posted message is an event-loop task, not a throttled timer, so it wakes
// the main thread even when its own timers are being throttled.
//
// This is the "keep a fixed-cadence keepalive firing regardless of tab
// visibility" mitigation. A full transport-in-worker port (the WebSocket +
// the entire Session state machine that sequences/CRCs outbound packets both
// live in the main-thread wasm) is the deeper fix and remains a follow-up;
// this lands the robustness win without moving the socket.
//
// The pre-existing 2.5s main-thread `setInterval` in index.html stays as a
// belt-and-suspenders fallback. `sendKeepalive` is idempotent and
// server-side-gated (a no-op unless InWorld/EnteringWorld), so both firing
// is harmless. Default-ON; opt out with `?keepaliveWorker=0` (or off/false).

function urlFlagEnabled() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get(
      "keepaliveWorker",
    );
    return v !== "0" && v !== "off" && v !== "false";
  } catch (_) {
    return true;
  }
}

let _worker = null;
let _started = false;

/**
 * Start the heartbeat worker exactly once per page. `onTick` is invoked on
 * the main thread on each worker pulse — it should emit one keepalive (it is
 * wrapped in try/catch by the worker's onmessage handler here). Returns true
 * if the worker was started, false if disabled/unsupported/already-started
 * (in which case the caller's own main-thread setInterval fallback carries
 * the session).
 *
 * @param {() => void} onTick
 * @param {number} [intervalMs=2000]
 * @returns {boolean}
 */
export function startKeepaliveWorker(onTick, intervalMs = 2000) {
  if (_started) return false; // already running for this page lifetime
  if (!urlFlagEnabled()) return false;
  if (typeof Worker === "undefined") return false; // no worker support → fallback
  try {
    // Resolve against THIS module's URL (scene3d/), matching bake_worker.
    _worker = new Worker(new URL("./keepalive_worker.js", import.meta.url));
    _worker.onmessage = (ev) => {
      if (ev && ev.data && ev.data.type === "tick") {
        try {
          onTick();
        } catch (_) {
          /* a dead/replaced handle must never break the heartbeat */
        }
      }
    };
    _worker.onerror = (e) => {
      // Non-fatal: the main-thread setInterval keepalive remains active, so
      // a working (foreground) session is never regressed by a worker crash.
      console.warn(
        "[keepalive_worker] crashed; main-thread setInterval keepalive remains as fallback:",
        (e && e.message) || e,
      );
    };
    _worker.postMessage({ type: "start", intervalMs });
    _started = true;
    console.log(
      `[keepalive_worker] heartbeat worker started (${intervalMs}ms) — survives hidden-tab timer throttling`,
    );
    return true;
  } catch (e) {
    console.warn(
      "[keepalive_worker] spawn failed; main-thread setInterval keepalive only:",
      e,
    );
    _worker = null;
    return false;
  }
}

/** Stop + release the worker (test/teardown aid). */
export function stopKeepaliveWorker() {
  try {
    if (_worker) {
      _worker.postMessage({ type: "stop" });
      _worker.terminate();
    }
  } catch (_) {}
  _worker = null;
  _started = false;
}
