// app/local_auto_motion.js — the local rig's animation for movement the CLIENT
// runs on the server's orders (2026-10-07).
//
// ACE turns the player before a missile shot or a cast (`Rotate`,
// `TurnTo_Magic`) and moves it for a use / melee charge (MoveToObject). Our
// MoveTo driver (crates/holtburger-core movement/move_to.rs) runs those on the
// local player, and retail plays them on the player's own CMotionInterp:
// `MoveToManager::_DoMotion` (acclient.c:344753) issues TurnRight/TurnLeft from
// `BeginTurnToHeading` (:345507) and the run/walk from `BeginMoveForward`
// (:345415), so the rig steps through the turn. Our local rig only followed
// keyboard input, so the avatar slid round in its idle pose.
//
// The wasm publishes the drive's motion every tick
// (`SessionHandle.localAutonomousMotion()`: 0 = none, else
// `1 << 31 | (fwd + 1) | (turn + 1) << 16 | run << 24`). This mirrors it:
//  - turn in place → the turn cycle at the hold-run speed (×1.5, the rate the
//    body turns; setMotion plays TurnLeft as TurnRight reversed) — only over an
//    idle / locomotion base: a cast gesture holding the substate keeps playing;
//  - forward → RunForward / WalkForward;
//  - drive over → back to Ready, but only if nothing else has set the rig
//    since: the server's next motion (a cast gesture) is what ends a pre-cast
//    turn, and it must not be stomped.
//
// `?localAutoMotion=off` disables it.

export const LOCAL_AUTO_MOTION_ACTIVE = 0x80000000;

const READY = 0x41000003;
const WALK_FORWARD = 0x45000005;
const RUN_FORWARD = 0x44000007;
const TURN_RIGHT = 0x6500000d;
const TURN_LEFT = 0x6500000e;
const NONCOMBAT_STANCE = 0x8000003d;
// Rig bases a turn cycle may replace: none yet, Ready, walk, run, and the
// turn cycles themselves (low 16 bits).
const TURNABLE_BASE_LOWS = new Set([0x0000, 0x0003, 0x0005, 0x0007, 0x000d, 0x000e]);

/** @returns {{forward:number, turn:number, run:boolean}|null} */
export function decodeLocalAutoMotion(packed) {
  const p = packed >>> 0;
  if ((p & LOCAL_AUTO_MOTION_ACTIVE) === 0) return null;
  return {
    forward: (p & 0xff) - 1,
    turn: ((p >>> 16) & 0xff) - 1,
    run: ((p >>> 24) & 1) === 1,
  };
}

/** The rig motion for a decoded drive, or null for none. */
export function localAutoMotionCommand(m) {
  if (!m) return null;
  if (m.forward > 0) return { cmd: m.run ? RUN_FORWARD : WALK_FORWARD, speed: 1.0, turn: false };
  if (m.turn !== 0) {
    return { cmd: m.turn > 0 ? TURN_RIGHT : TURN_LEFT, speed: m.run ? 1.5 : 1.0, turn: true };
  }
  return null;
}

/**
 * @param {object} rig
 * @param {() => number} rig.baseLow     low 16 bits of the rig's current base command
 * @param {() => number} rig.issueSeq    bumps on every base command the rig is given
 * @param {(cmd:number, speed:number) => void} rig.play
 */
export function createLocalAutoMotion(rig) {
  let last = 0;
  let ownedSeq = null; // the rig's issue seq right after OUR last base command
  return {
    update(packed) {
      const p = packed >>> 0;
      if (p === last) return;
      last = p;
      const want = localAutoMotionCommand(decodeLocalAutoMotion(p));
      if (want) {
        if (want.turn && ownedSeq === null && !TURNABLE_BASE_LOWS.has(rig.baseLow() & 0xffff)) return;
        rig.play(want.cmd, want.speed);
        ownedSeq = rig.issueSeq();
        return;
      }
      if (ownedSeq !== null && rig.issueSeq() === ownedSeq) rig.play(READY, 1.0);
      ownedSeq = null;
    },
    get active() { return ownedSeq !== null; },
  };
}

let _shared;

/** The page's controller, bound to the local player's rig (null when off). */
export function getLocalAutoMotion() {
  if (_shared !== undefined) return _shared;
  let off = false;
  try {
    off = new URLSearchParams(globalThis.location?.search ?? "").get("localAutoMotion") === "off";
  } catch (_) { /* default on */ }
  if (off) return (_shared = null);
  const local = () => {
    const em = globalThis.window?.liveScene3d?.entityManager;
    const g = globalThis.window?.getLocalPlayerGuid?.();
    if (!em || g == null) return null;
    return { em, guid: g >>> 0, inst: em.entityMap?.get?.(g >>> 0) };
  };
  _shared = createLocalAutoMotion({
    baseLow: () => (local()?.inst?.lastMotionCommand ?? 0) & 0xffff,
    issueSeq: () => local()?.inst?._motionIssueSeq | 0,
    play: (cmd, speed) => {
      const l = local();
      if (!l || typeof l.em.setMotion !== "function") return;
      const stance = (typeof l.em.getStance === "function" ? l.em.getStance(l.guid) >>> 0 : 0) || NONCOMBAT_STANCE;
      l.em.setMotion(l.guid, cmd >>> 0, stance, speed);
    },
  });
  return _shared;
}
