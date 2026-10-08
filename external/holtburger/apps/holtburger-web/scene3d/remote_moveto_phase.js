// R3 moveto-4 (2026-10-08 follow-ups) — remote MoveTo animation phase from the
// Rust MoveToManager node (`?remoteMoveToPhase`, DEFAULT ON; `off`/`0`/`false`
// escape).
//
// Retail plays a MoveTo on the mover's own CMotionInterp: every node is a
// `MoveToManager::_DoMotion` (acclient.c:344753 → adjust_motion +
// CMotionInterp::DoInterpretedMotion), so the clip follows the node by
// construction —
//   * TurnToHeading node: `BeginTurnToHeading` _DoMotion(TurnRight 0x6500000D /
//     TurnLeft 0x6500000E) — turn in place (acclient.c:345456-345518);
//   * MoveToPosition node: `BeginMoveForward` _DoMotion(get_command → Walk /
//     WalkBackwards, the Run hold key making it RunForward) (:345371-345425);
//     the 20-degree aux turn while moving (:345620-345651) is a MODIFIER on
//     that cycle, never a turn-in-place phase;
//   * arrival / cancel: `BeginNextNode` → CleanUp + StopCompletely → Ready
//     (:345521-345545).
// holtburger-core runs that node machine for remotes (drive_remote_movetos);
// the wasm emits a ClientEvent (kind REMOTE_MOVETO_PHASE) on every change of
// the node motion. Before this, JS guessed the phase from the heading error
// (the COL-20 gate, scene3d/entities.js), which the D5 remote heading rows
// zero every frame — so the run clip played while the node was still turning.
//
// Pure + dependency-free (no THREE, no DOM) so node tests import it directly.
// The wiring lives in scene3d/entities.js (`applyRemoteMoveToPhase`,
// `noteRemoteMoveToHint`, `reapplyRemoteMoveToPhase`), app/client_events.js
// (the ClientEvent arm) and scene3d/loop.js `_armMotion`.

export const MOTION_TURN_RIGHT = 0x6500000d;
export const MOTION_TURN_LEFT = 0x6500000e;
export const MOTION_WALK_FORWARD = 0x45000005;
export const MOTION_WALK_BACKWARDS = 0x45000006;
export const MOTION_RUN_FORWARD = 0x44000007;
export const MOTION_READY = 0x41000003;

const PHASE_MOTIONS = new Set([
  MOTION_TURN_RIGHT,
  MOTION_TURN_LEFT,
  MOTION_WALK_FORWARD,
  MOTION_WALK_BACKWARDS,
  MOTION_RUN_FORWARD,
]);

/**
 * `?remoteMoveToPhase` reader — DEFAULT ON; `off` / `0` / `false` (any case)
 * disable. `search` defaults to the page's query string; outside a browser
 * (no location) it reads ON.
 */
export function remoteMoveToPhaseEnabled(search) {
  let s = search;
  if (typeof s !== "string") {
    try {
      s = globalThis.location?.search ?? "";
    } catch (_) {
      s = "";
    }
  }
  try {
    const v = new URLSearchParams(s).get("remoteMoveToPhase");
    if (v == null) return true;
    return !["off", "0", "false"].includes(String(v).toLowerCase());
  } catch (_) {
    return true;
  }
}

/**
 * The full MotionCommand a phase motion plays, or 0 for "no node motion"
 * (Ready on an edge out of a live phase). Unknown non-zero values return -1
 * (ignored: a newer wasm emitting a value this table does not know must not
 * be mistaken for a stop).
 */
export function remoteMoveToPhaseCommand(motion) {
  const m = motion >>> 0;
  if (m === 0) return 0;
  return PHASE_MOTIONS.has(m) ? m : -1;
}

/**
 * Decide what one phase edge does to the rig.
 *
 * @param {{phase: number, seq: number}} prev — the rig's current phase motion
 *   (0 = none) and the KIND_MOTION counter value when it was applied.
 * @param {number} motion — the edge's motion (u32Payload2).
 * @param {number} motionSeq — the rig's KIND_MOTION counter now.
 * @returns {null | {play: number, phase: number, seq: number}} — `null` =
 *   ignore the event; otherwise the command to play (0 = play nothing) and the
 *   new phase state.
 *
 * Staleness rule: a node that starts always plays (the node IS the clip). A
 * stop plays Ready only when the rig still shows the phase this channel put
 * there — no KIND_MOTION arrived since. A newer server motion (an attack, a
 * fresh interpreted state, another MoveTo) owns the clip: its unpack already
 * cancelled the node (retail `unpack_movement` preamble, acclient.c:339518),
 * and that cancel is what this stop edge reports.
 */
export function planRemoteMoveToPhase(prev, motion, motionSeq) {
  const cmd = remoteMoveToPhaseCommand(motion);
  if (cmd < 0) return null;
  const seq = motionSeq | 0;
  if (cmd !== 0) return { play: cmd, phase: cmd, seq };
  const wasLive = ((prev?.phase ?? 0) >>> 0) !== 0;
  const superseded = ((prev?.seq ?? 0) | 0) !== seq;
  return { play: wasLive && !superseded ? MOTION_READY : 0, phase: 0, seq };
}

/**
 * After a MoveTo-envelope KIND_MOTION (its walk/run hint has just been
 * applied): the phase command to put back, or 0 to leave the hint. A re-sent
 * MoveTo re-arms the Rust node, but when the node motion comes out the same
 * there is no new edge, so a hint run must not replace a turn the node still
 * holds. `hintCmd` is the KIND_MOTION command (bare low 16 bits or full).
 */
export function remoteMoveToHintReapply(phase, hintCmd) {
  const p = phase >>> 0;
  if (p === 0 || !PHASE_MOTIONS.has(p)) return 0;
  return ((hintCmd >>> 0) & 0xffff) === (p & 0xffff) ? 0 : p;
}
