// scene3d/motion/retail_rig_speed.js — the speed a LOCALLY driven rig command
// plays at: retail CMotionInterp::adjust_motion (acclient.c:343746) followed by
// apply_run_to_command (:343439), the speed_mod that GetObjectSequence's
// add_motion multiplies into the cycle framerate AND the body's travel
// (:337431-337474). One speed_mod for both is what keeps the feet planted.
//
// THE BUG (2026-10-24, live on the 1070): all three local-rig dispatchers —
// camera.js `_dispatchLocalRigMotion`, app/client_events.js kind-61
// DriveApplied and app/local_auto_motion.js — handed setMotion the RAW key
// speed, so RunForward played at 1.0 while the body ran at 4.0 x run rate
// (18 m/s at the ACE cap of 4.5): the planted foot slid at 82 % of body speed.
// Backpedal (-0.65 instead of -0.65 x R) and strafe (1.0 instead of the
// clamped 3.0) skated the same way.
//
// setMotion still performs adjust_motion's command rewrites (WalkBackwards ->
// WalkForward x -0.65|s|, SideStepLeft / TurnLeft -> Right with -|s|), so this
// returns the MAGNITUDE those rewrites start from; callers keep the sign.
//
// `?retailRigSpeed=off` restores the raw speeds. No imports: unit-testable
// under plain node (tests/retail_rig_speed.test.mjs).

const READY = 0x41000003;
const WALK_FORWARD = 0x45000005;
const WALK_BACKWARDS = 0x45000006;
const RUN_FORWARD = 0x44000007;
const TURN_RIGHT = 0x6500000d;
const TURN_LEFT = 0x6500000e;
const SIDESTEP_RIGHT = 0x6500000f;
const SIDESTEP_LEFT = 0x65000010;

// adjust_motion: SideStep speed *= 3.1199999 / 1.25 * 0.5 (= 1.248).
export const SIDESTEP_FACTOR = (3.1199999 / 1.25) * 0.5;
// apply_run_to_command: |SideStepRight speed| clamps to 3.0 under hold-run.
export const MAX_SIDESTEP_ANIM_RATE = 3.0;
// apply_run_to_command: TurnRight speed *= 1.5 under hold-run.
export const RUN_TURN_FACTOR = 1.5;

/**
 * Magnitude of the interpreted speed_mod for a local rig command.
 * @param {number} cmd      full 32-bit motion command the dispatcher picked
 * @param {boolean} holdRun the Run hold key is active (run by default, Shift walks)
 * @param {number} runRate  the player's run rate (InqRunRate), > 0
 * @returns {number} >= 0
 */
export function localRigSpeedMagnitude(cmd, holdRun, runRate) {
  const r = Number.isFinite(runRate) && runRate > 0 ? runRate : 1.0;
  switch (cmd >>> 0) {
    case RUN_FORWARD:
      // apply_run_to_command promotes WalkForward(speed > 0) under hold-run
      // and multiplies the speed by the run rate.
      return r;
    case WALK_FORWARD:
      return holdRun ? r : 1.0;
    case WALK_BACKWARDS:
      // adjust_motion's x -0.65 is applied by setMotion; the run scaling
      // (WalkForward with a negative speed still takes `*speed = r * *speed`)
      // is applied here.
      return holdRun ? r : 1.0;
    case SIDESTEP_RIGHT:
    case SIDESTEP_LEFT:
      return holdRun ? Math.min(SIDESTEP_FACTOR * r, MAX_SIDESTEP_ANIM_RATE) : SIDESTEP_FACTOR;
    case TURN_RIGHT:
    case TURN_LEFT:
      return holdRun ? RUN_TURN_FACTOR : 1.0;
    case READY:
    default:
      return 1.0;
  }
}

/** The local player's run rate from the wasm (`playerRunRate`), 1.0 when absent. */
export function localRunRate(wasmExports) {
  try {
    const fn = wasmExports?.playerRunRate;
    if (typeof fn !== "function") return 1.0;
    const r = +fn();
    return Number.isFinite(r) && r > 0 ? r : 1.0;
  } catch (_) {
    return 1.0;
  }
}

/** Read `?retailRigSpeed` (DEFAULT ON — `off`/`0`/`false` disable). Never throws. */
export function readRetailRigSpeedFlag(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search ?? "");
    const v = new URLSearchParams(s).get("retailRigSpeed");
    if (v == null) return true;
    const lc = v.toLowerCase();
    return !(lc === "off" || lc === "0" || lc === "false");
  } catch (_) {
    return true;
  }
}

let _on = null;
/** Cached flag accessor (parse once per page load). */
export function retailRigSpeedOn() {
  if (_on === null) _on = readRetailRigSpeedFlag();
  return _on;
}
/** Test seam. */
export function _resetRetailRigSpeedForTest() {
  _on = null;
}

/**
 * The speed a local dispatcher passes to setMotion: the raw `rawSpeed` when
 * the flag is off, else its sign times the retail magnitude.
 */
export function localRigSpeed(cmd, rawSpeed, holdRun, runRate) {
  const raw = Number.isFinite(rawSpeed) && rawSpeed !== 0 ? rawSpeed : 1.0;
  if (!retailRigSpeedOn()) return raw;
  return Math.sign(raw) * localRigSpeedMagnitude(cmd, holdRun, runRate);
}
