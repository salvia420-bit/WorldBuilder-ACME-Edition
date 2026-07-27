// harness/lib/movement_gate.mjs — P5.5 movement/heading sanity gate.
//
// THE STANDING RULE (PHY-07-LIVE-RUN-2026-07-26, "Harness lesson — the rig
// produced its own false positive"):
//
//   Any collision / blocked / plateau verdict must FIRST prove the player
//   actually moved and, where turning is involved, that the heading actually
//   changed. Otherwise a wedged client reads as a blocked one.
//
// That log's `collide.cjs` reported `verdict: "BLOCKED (plateau)"` when the
// distance-to-target series was flat because the player had never moved at
// all. Its turn loop had failed the same way — `turnErrSeq` was the identical
// value (-123.9) for all 24 iterations, because heading was read off the
// degenerate follow-camera basis of LIVE-03 (now guarded in
// scene3d/camera_math.js `guardLookHorizontal`). Both faults were invisible to
// every other instrument in the run: `__diag.physics.summary()` reported 600
// samples, zero drift and zero hitches while the player could not move.
//
// Pure and import-free so it loads under plain node and is unit-testable
// (test_p5_5_movement_gate.mjs). Harnesses feed it their own pose samples.

/** Metres of PATH travelled below which a run is not a walk. Matches the
 *  floor the live run's `sweep.cjs` adopted (`valid: moved > 2`). */
export const MOVED_MIN_M = 2.0;

/** Radians of cumulative heading change below which a turn loop is not a
 *  turn (~3°). A harness that never presses a turn key should pass
 *  `requireHeading: false` rather than lowering this. */
export const HEADING_MIN_RAD = 0.05;

/** Landblock edge length in metres — pose x/y are landblock-LOCAL, so they
 *  must be lifted to global coordinates before differencing or a boundary
 *  crossing reads as a 192 m teleport. `WorldBuilder.Shared` calls this
 *  `LandblockLength = 192`. */
export const LANDBLOCK_M = 192;

/**
 * Lift a landblock-local pose to global AC XY.
 *
 *   global x = ((lb >>> 24) & 0xff) * 192 + pose.x
 *   global y = ((lb >>> 16) & 0xff) * 192 + pose.y
 *
 * Derived and confirmed against two independent poses in
 * PHY-07-LIVE-RUN-2026-07-26 ("Coordinate mapping"). Returns null when the
 * sample lacks a usable landblock id or position.
 */
export function poseToGlobalXY(sample) {
  if (!sample) return null;
  const lb = sample.landblockId ?? sample.lb;
  const x = sample.x ?? sample.px;
  const y = sample.y ?? sample.py;
  if (lb == null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const l = lb >>> 0;
  return {
    gx: ((l >>> 24) & 0xff) * LANDBLOCK_M + x,
    gy: ((l >>> 16) & 0xff) * LANDBLOCK_M + y,
    heading: Number.isFinite(sample.heading) ? sample.heading : null,
  };
}

/** Wrap a radian delta into [-π, π] so a heading crossing ±π is not counted
 *  as a 2π turn. */
export function wrapPi(r) {
  return Math.atan2(Math.sin(r), Math.cos(r));
}

/**
 * Reduce a series of pose samples to a movement verdict.
 *
 * `samples` — array of `{ landblockId|lb, x|px, y|py, heading? }` in time
 * order; entries that cannot be lifted to global XY are dropped.
 *
 * Options:
 *   `movedMinM`      — path-length floor (default MOVED_MIN_M)
 *   `headingMinRad`  — cumulative-turn floor (default HEADING_MIN_RAD)
 *   `requireHeading` — whether a frozen heading invalidates the run
 *                      (default true; set false for straight-line harnesses)
 *   `inWorld`        — pass false to short-circuit to NOT-IN-WORLD
 *
 * Returns `{ verdict, valid, poseSamples, pathM, netDisplacementM,
 *            headingTurnedRad, displacementOk, headingOk }`.
 *
 * `verdict` is one of:
 *   "MOVED"                                     — the gate passes
 *   "NOT-IN-WORLD"                              — never entered the world
 *   "INVALID — no pose samples"                 — the instrument is dead
 *   "INVALID — player never moved"              — the collide.cjs false positive
 *   "INVALID — heading never changed"           — the LIVE-03 turn-loop freeze
 *
 * Callers must not emit a BLOCKED/collision conclusion when `valid` is false.
 */
export function movementGate(samples, options = {}) {
  const {
    movedMinM = MOVED_MIN_M,
    headingMinRad = HEADING_MIN_RAD,
    requireHeading = true,
    inWorld = true,
  } = options;

  const poses = (Array.isArray(samples) ? samples : [])
    .map(poseToGlobalXY)
    .filter((p) => p != null);

  let pathM = 0;
  let headingTurnedRad = 0;
  for (let i = 1; i < poses.length; i += 1) {
    pathM += Math.hypot(poses[i].gx - poses[i - 1].gx, poses[i].gy - poses[i - 1].gy);
    if (poses[i].heading != null && poses[i - 1].heading != null) {
      headingTurnedRad += Math.abs(wrapPi(poses[i].heading - poses[i - 1].heading));
    }
  }
  const netDisplacementM = poses.length >= 2
    ? Math.hypot(
        poses[poses.length - 1].gx - poses[0].gx,
        poses[poses.length - 1].gy - poses[0].gy,
      )
    : 0;

  const displacementOk = pathM > movedMinM;
  const headingOk = !requireHeading || headingTurnedRad > headingMinRad;

  let verdict;
  if (!inWorld) verdict = "NOT-IN-WORLD";
  else if (poses.length < 2) verdict = "INVALID — no pose samples";
  else if (!displacementOk) verdict = "INVALID — player never moved";
  else if (!headingOk) verdict = "INVALID — heading never changed";
  else verdict = "MOVED";

  return {
    verdict,
    valid: verdict === "MOVED",
    poseSamples: poses.length,
    pathM: +pathM.toFixed(2),
    netDisplacementM: +netDisplacementM.toFixed(2),
    headingTurnedRad: +headingTurnedRad.toFixed(3),
    displacementOk,
    headingOk,
  };
}
