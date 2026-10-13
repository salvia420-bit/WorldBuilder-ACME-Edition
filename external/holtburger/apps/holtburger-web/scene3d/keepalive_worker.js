// scene3d/keepalive_worker.js
//
// keepaliveFix (2026-07-07) — a dedicated Web Worker whose ONLY job is to
// tick a wall-clock heartbeat. See keepalive_worker_client.js for the why.
//
// This worker holds NO wasm and NO socket — it owns only setIntervals.
// The point: a dedicated worker's timers keep firing at their real cadence
// even when the owning tab is hidden / occluded / frozen, whereas a
// main-thread setInterval is throttled to >=1s (and ~1/min after ~5 min
// hidden, and paused outright on some occluded/frozen tabs). ACE drops a
// session after 60s with no inbound client packet, so a throttled/paused
// main-thread keepalive is exactly what times players out. Each tick this
// worker posts {type:'tick'} to the main thread, which forwards it to
// SessionHandle.sendKeepalive() (a message task, NOT a throttled timer, so
// it wakes the main-thread event loop and gets serviced).
//
// app-loop-4 (2026-10-13): an optional second, faster pulse — {type:'beat'}
// every `beatMs` — lets the main thread re-drive its net/movement pump while
// rAF is stopped (scene3d/net_pump_gate.js says why). It is a separate timer
// so the 2s keepalive cadence is untouched: pumping on the 2s tick would give
// the movement tick a dt of ~2.0s, straddling HUGE_QUANTUM (retail
// CPhysicsObj::update_object drops any quantum over 2.0s).
//
// Protocol (postMessage):
//   in : {type:'start', intervalMs, beatMs?}  start/replace the heartbeat
//                                             (+ the beat when beatMs > 0)
//        {type:'stop'}                        stop both
//   out: {type:'tick'}                        one heartbeat pulse
//        {type:'beat'}                        one pump beat

let timer = null;
let beatTimer = null;

self.onmessage = (ev) => {
  const msg = (ev && ev.data) || {};
  if (msg.type === "start") {
    // Floor the cadence so a bad param can't spin the worker; default 2s
    // (well under ACE's 60s timeout even if a few pulses are lost).
    const ms = Math.max(250, Number(msg.intervalMs) || 2000);
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => {
      self.postMessage({ type: "tick" });
    }, ms);
    // Beat: only when asked for (absent / 0 / junk = none), floored at 100ms.
    if (beatTimer !== null) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
    const beatMs = Number(msg.beatMs);
    if (Number.isFinite(beatMs) && beatMs > 0) {
      beatTimer = setInterval(() => {
        self.postMessage({ type: "beat" });
      }, Math.max(100, beatMs));
    }
  } else if (msg.type === "stop") {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (beatTimer !== null) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  }
};
