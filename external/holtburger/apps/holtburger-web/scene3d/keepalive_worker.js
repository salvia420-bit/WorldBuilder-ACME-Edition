// scene3d/keepalive_worker.js
//
// keepaliveFix (2026-07-07) — a dedicated Web Worker whose ONLY job is to
// tick a wall-clock heartbeat. See keepalive_worker_client.js for the why.
//
// This worker holds NO wasm and NO socket — it owns a single setInterval.
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
// Protocol (postMessage):
//   in : {type:'start', intervalMs}   start/replace the heartbeat
//        {type:'stop'}                stop it
//   out: {type:'tick'}                one heartbeat pulse

let timer = null;

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
  } else if (msg.type === "stop") {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
};
