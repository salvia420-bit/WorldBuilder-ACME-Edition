// scene3d/net_pump_gate.js
//
// app-loop-4 (2026-10-13) — the ONE staleness gate shared by every heartbeat
// that re-drives the page net pump (`window.__netFramePump` = pumpNetFrame:
// net drain, entity updates and, through app/frame_pump.js's stale-claim
// fallback, `handle.tickMovement`) once rAF stops.
//
// WHY: a hidden tab's only pump was the scene3d net watchdog, a main-thread
// setInterval(500). Chrome caps hidden-page timers at ~1 wake-up/s and, after
// ~5 min hidden and 30 s silent (the audio manager mutes the master bus when
// hidden), at ~1 wake-up/MINUTE. The movement tick's dt then reaches ~60 s,
// which the Rust spine drops outright — dt > HUGE_QUANTUM 2.0, as retail
// CPhysicsObj::update_object skips any quantum over 2.0 s (acclient.c
// `if ( v6 <= 2.0 )`) — so autorun / MoveTo / in-flight motion froze and
// casts or attacks (sent after the next movement tick) slowed to one step a
// minute. scene3d/keepalive_worker.js now also posts a 250 ms 'beat' from a
// dedicated worker (not throttled); scene3d/index.js pumps on that beat
// through this gate, alongside the 500 ms watchdog interval.
//
// The thresholds equal rynth/webhost.js PUMP_STALE_MS / PUMP_STALE_VISIBLE_MS
// (a bot's own worker heartbeat), so in a hidden bot tab whichever heartbeat
// fires first pumps and re-stamps `window.__lastPumpMs` and the other skips —
// never a double pump. While rAF pumps every frame the gate is a no-op.
// tests/net_pump_beat.test.mjs pins the parity.
//
// After WebAC packages/renderer/src/scene/BackgroundTicker.ts (worker beat,
// STARVED_MS gate), AGPL-3.0 — re-derived for holtburger's pump heartbeat.

/** Hidden page (rAF stopped): pump once the frame pump is this stale. */
export const PUMP_STALE_HIDDEN_MS = 200;
/** Visible page: pump only after the rAF pump has stalled a full second. */
export const PUMP_STALE_VISIBLE_MS = 1000;

/**
 * Pure staleness decision. `last` is `window.__lastPumpMs` (performance.now()
 * domain, stamped by pumpNetFrame); a page that never pumped (`last` not a
 * finite number) is stale.
 *
 * @param {{now:number, last?:number, hidden?:boolean,
 *          staleHiddenMs?:number, staleVisibleMs?:number}} o
 * @returns {boolean} true = pump now
 */
export function pumpStaleDecision({
  now,
  last,
  hidden = false,
  staleHiddenMs = PUMP_STALE_HIDDEN_MS,
  staleVisibleMs = PUMP_STALE_VISIBLE_MS,
} = {}) {
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  const staleAfter = hidden ? staleHiddenMs : staleVisibleMs;
  return now - last > staleAfter;
}

/**
 * Run `win.__netFramePump()` when the gate says the pump is stale. No-op
 * before the pump exists (pre-login). Throws whatever the pump throws — the
 * caller owns logging.
 *
 * @param {object} win  the page window (or a test stand-in)
 * @param {{now:number, hidden?:boolean,
 *          staleHiddenMs?:number, staleVisibleMs?:number}} o
 * @returns {boolean} true when it pumped
 */
export function pumpIfStale(win, { now, hidden = false, staleHiddenMs, staleVisibleMs } = {}) {
  if (!win || typeof win.__netFramePump !== "function") return false;
  if (!pumpStaleDecision({ now, last: win.__lastPumpMs, hidden, staleHiddenMs, staleVisibleMs })) {
    return false;
  }
  win.__netFramePump();
  return true;
}
