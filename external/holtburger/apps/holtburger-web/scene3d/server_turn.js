// ============================================================================
// FU-2 (2026-08-02) — server turn authority + the control handoff latch
// ============================================================================
//
// The residual cast/shoot rotation glitch has ONE root cause: we throw away
// the server's turn directive for the local player and substitute a local
// face loop, then let the two fight. Retail does the opposite — the server
// turn is authoritative and the client hands over the drive until the player
// asks for it back.
//
// ## Retail chain (all line numbers = $DECOMP/acclient.c unless noted)
//
// 1. The wire. `ACSmartBox::DispatchSmartBoxEvent` (:392691) handles the
//    `0xF74C` MovementEvent (:392823) and a movement payload piggybacked on a
//    `0xF748`/`0xF619` position event (:392779). Both call
//    `CPhysics::SetObjectMovement` and, when it returns nonzero, call
//    `CommandInterpreter::LoseControlToServer` (call sites :392781, :392828).
//
// 2. The gate. `CPhysics::SetObjectMovement` (:311149) returns 1 iff ALL of:
//      - the object is the LOCAL player (`weenie_obj->IsPlayer()`),
//      - `movement_timestamp` is strictly newer than `update_times[1]`,
//      - `server_control_timestamp` is not older than `update_times[5]`,
//      - the blob's `autonomous` byte is 0.
//    i.e. retail only ignores a movement addressed to the local player when it
//    is the client's OWN echo. A non-autonomous server turn — which is exactly
//    what ACE's `TurnToObject` broadcast is (`Creature_Navigation.cs:127` →
//    `EnqueueBroadcastMotion` → `EnqueueBroadcast(sendSelf: true)`,
//    `WorldObject_Networking.cs:1413`) — is unpacked and APPLIED.
//
// 3. Lose control. `CommandInterpreter::LoseControlToServer` (:716832):
//      if (autonomy_level) {
//        controlled_by_server = 1;
//        SetAutoRun(0, /*apply_movement=*/0);   // vfptr[17], :718254
//        ClearAllCommands();                    // vfptr[6],  :716848
//      }
//    Nothing else — no physics touch, no packet. A pure local latch + input
//    queue flush. (`controlled_by_server` is `acclient.h:35344`, and the
//    constructor at :717757 starts it at **1**.)
//
// 4. Reclaim. Three triggers, all funnelling into
//    `CommandInterpreter::TakeControlFromServer` (:716934), which requires
//    `controlled_by_server && autonomy_level && !PlayerIsDead()` (:717695)
//    and then clears the latch, `StopCompletely` + `StopInterpolating`s the
//    player and re-applies the current movement:
//      (a) `CommandInterpreter::UseTime` (:717595, the per-frame poll):
//            player && enabled && controlled_by_server
//            && !motions_pending() && !IsMovingTo()
//            && (SubstateList.head || TurnList.head || SidestepList.head
//                || auto_run)
//          **There is NO timeout anywhere in this path** — it is purely
//          "the server motion has drained AND a movement input is still held".
//      (b) `CommandInterpreter::MovePlayer` (:717800) calls it unconditionally
//          at `LABEL_38` (:717938) — i.e. a movement key PRESS reclaims
//          immediately, without waiting for the drain.
//      (c) `SetAutoRun(true)` (:718269).
//    And `HandleKeyboardCommand` (:717284) swallows a key RELEASE while
//    server-controlled (`NukeCommand`, :717458) instead of reclaiming, so only
//    a press reclaims.
//
// ## What this module is
//
// The flag, the latch, and the counters — a leaf module (imports nothing) so
// `loop.js` (which receives KIND_TURN) and `picking.js` (which owns the local
// face loops) can share it without an import cycle.
//
// ## Divergences, deliberate
//
// * Reclaim condition (a) needs `motions_pending()` / `IsMovingTo()`, which we
//   have no safe probe for — `SessionHandle::pursuitStatus` is READ-CLEAR for
//   completion states, so polling it would consume another consumer's latch.
//   Substituted: the turn is "drained" once the local heading has converged to
//   within `TURN_SETTLE_RAD` of the latched target heading. A
//   `TURN_SETTLE_CAP_MS` hard cap is added on top so a turn that never
//   converges (target despawned mid-turn, integrator stall) can never lock the
//   player's input out — retail has no such cap because it has a real
//   motion queue to observe.
// * We apply the turn through `SessionHandle::turnToHeading` (the wasm
//   `PlayerDriveIntent::TurnToHeading`, retail `TurnToHeading` :346141) rather
//   than writing the rig quaternion, because the local rig heading is rendered
//   from the integrator every frame (`loop.js
//   applyLocalPlayerPoseFromIntegrator` → `pose.heading`). Writing the rig
//   directly would be overwritten on the very next frame.
//
// ## Flag
//
// `?serverTurn=on` — STRICT `=== "on"`, DEFAULT OFF. Flag-off every export
// here is inert and the client behaves byte-identically to before.
// ============================================================================

/** DEFAULT OFF. Strict `=== "on"` (the `!== "off"` footgun is not used here). */
export const SERVER_TURN_ON = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URLSearchParams(window.location.search)
      .get("serverTurn")?.toLowerCase() === "on";
  } catch (_) { return false; }
})();

/**
 * Heading-convergence band standing in for retail's `motions_pending()`.
 * 0.05 rad ≈ 2.9°, the same band `picking.js`'s legacy face-loop dead-zone
 * used before `?castFacing20`.
 */
const TURN_SETTLE_RAD = 0.05;

/**
 * Hard cap on how long the latch may hold the drive waiting for convergence.
 * OURS, not retail's (see the divergence note above) — a safety valve so a
 * never-converging turn cannot permanently swallow movement input.
 */
const TURN_SETTLE_CAP_MS = 1500;

/**
 * The latch. `controlled` is retail's `CommandInterpreter::controlled_by_server`
 * (acclient.h:35344). Unlike retail we start FALSE: retail's constructor value
 * of 1 is paired with `SmartBox::init_player` (:144986) immediately calling
 * `NewPlayer(autonomous)`, and our client is autonomous by construction.
 */
export const serverTurn = {
  controlled: false,
  /** Target heading (radians) of the latched server turn; null when none. */
  targetHeading: null,
  /** performance.now() at lose-control. */
  sinceMs: 0,
  /** Movement intent was already non-idle when control was lost (UseTime arm). */
  intentHeldAtLoss: false,
  /** Previous frame's "movement intent non-idle" sample, for press edges. */
  _prevIntent: false,
};

/**
 * Counters, surfaced at `window.__diag.picking` alongside the ROT-1 set.
 *   serverTurnApplied  — KIND_TURN directives for the local guid we APPLIED
 *   serverTurnDropped  — ... we could not apply (no handle / bad quaternion)
 *   controlLost        — LoseControlToServer latches
 *   controlReclaimed   — TakeControlFromServer releases
 *   reclaimOnPress     — reclaims via the MovePlayer press arm (:717938)
 *   reclaimOnSettle    — reclaims via the UseTime poll arm (:717595)
 *   reclaimOnCap       — reclaims via OUR settle cap (not retail)
 *   faceLoopSuppressed — local face loops skipped because the server owns turn
 */
export const serverTurnDiag = {
  serverTurnApplied: 0,
  serverTurnDropped: 0,
  controlLost: 0,
  controlReclaimed: 0,
  reclaimOnPress: 0,
  reclaimOnSettle: 0,
  reclaimOnCap: 0,
  faceLoopSuppressed: 0,
};

try {
  if (typeof window !== "undefined") {
    window.__diag = window.__diag || {};
    window.__diag.picking = Object.assign(window.__diag.picking || {}, serverTurnDiag);
    window.__diag.serverTurn = {
      on: SERVER_TURN_ON,
      state: serverTurn,
      counters: serverTurnDiag,
    };
  }
} catch (_) { /* diag is never load-bearing */ }

/** Bump a counter on BOTH the module object and the shared `__diag.picking`. */
function bump(key) {
  serverTurnDiag[key] = (serverTurnDiag[key] || 0) + 1;
  try {
    const d = window.__diag?.picking;
    if (d) d[key] = (d[key] || 0) + 1;
  } catch (_) {}
}

const _now = () => (
  (typeof performance !== "undefined" && performance.now)
    ? performance.now()
    : Date.now()
);

/** Wrap to (-PI, PI]. */
function normPi(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * True when the local turn drivers (`CAST_FACE_TARGET` / `CAST_REFACE` /
 * `MISSILE_FACE_TARGET`) must stand down. Under `?serverTurn=on` the server is
 * the SOLE turn authority — retail has no client-side auto-face at all; the
 * only local turn primitive is `TurnToHeading` off the camera/API
 * (acclient.c:718082), which has no `controlled_by_server` guard because it is
 * never used as an auto-face.
 */
export function serverTurnOwnsFacing() {
  if (!SERVER_TURN_ON) return false;
  bump("faceLoopSuppressed");
  return true;
}

/**
 * Retail `CommandInterpreter::LoseControlToServer` (acclient.c:716832).
 * `clearDrive` is the caller's `SetAutoRun(0,0)` + `ClearAllCommands()` pair.
 *
 * @param {number|null} targetHeading — radians; the heading the server turn is
 *   driving to (used by the settle probe). null = unknown (cap-only).
 * @param {boolean} intentHeld — is a movement input non-idle right now?
 * @param {Function} [clearDrive] — invoked once to flush the local drive.
 */
export function loseControlToServer(targetHeading, intentHeld, clearDrive) {
  if (!SERVER_TURN_ON) return;
  serverTurn.targetHeading =
    (typeof targetHeading === "number" && Number.isFinite(targetHeading))
      ? targetHeading : null;
  serverTurn.sinceMs = _now();
  serverTurn.intentHeldAtLoss = !!intentHeld;
  serverTurn._prevIntent = !!intentHeld;
  if (serverTurn.controlled) return; // already latched; retail re-runs the
                                     // clear, but our clear is idempotent and
                                     // re-stomping a live drive is the P16-H1
                                     // ManualSet hazard.
  serverTurn.controlled = true;
  bump("controlLost");
  try { clearDrive?.(); } catch (_) {}
}

/**
 * Retail `CommandInterpreter::TakeControlFromServer` (acclient.c:716934).
 * @param {string} why — "press" | "settle" | "cap" (diag only).
 * @param {Function} [applyCurrentMovement] — retail's `ApplyCurrentMovement`
 *   re-issue (:717027) so a held key resumes driving immediately.
 */
export function takeControlFromServer(why, applyCurrentMovement) {
  if (!SERVER_TURN_ON || !serverTurn.controlled) return;
  serverTurn.controlled = false;
  serverTurn.targetHeading = null;
  serverTurn.intentHeldAtLoss = false;
  bump("controlReclaimed");
  if (why === "press") bump("reclaimOnPress");
  else if (why === "settle") bump("reclaimOnSettle");
  else if (why === "cap") bump("reclaimOnCap");
  try { applyCurrentMovement?.(); } catch (_) {}
}

/**
 * Retail `CommandInterpreter::UseTime`'s reclaim arm (acclient.c:717600-717612)
 * plus the `MovePlayer` press arm (:717938). Call once per frame.
 *
 * @param {{intentHeld: boolean, heading: number|null,
 *          applyCurrentMovement?: Function}} ctx
 */
export function tickServerTurnControl(ctx) {
  if (!SERVER_TURN_ON) return;
  const intentHeld = !!ctx?.intentHeld;
  const prev = serverTurn._prevIntent;
  serverTurn._prevIntent = intentHeld;
  if (!serverTurn.controlled) return;

  // (b) MovePlayer press arm — an idle→active input EDGE reclaims immediately,
  // no drain wait (:717938 calls TakeControlFromServer unconditionally).
  if (intentHeld && !prev) {
    takeControlFromServer("press", ctx?.applyCurrentMovement);
    return;
  }
  // (a) UseTime poll arm — a still-held input reclaims once the server motion
  // has drained. Our drain probe is heading convergence.
  const elapsed = _now() - serverTurn.sinceMs;
  const tgt = serverTurn.targetHeading;
  const cur = ctx?.heading;
  const converged =
    tgt === null ||
    (typeof cur === "number" && Number.isFinite(cur) &&
      Math.abs(normPi(cur - tgt)) <= TURN_SETTLE_RAD);
  if (intentHeld && converged) {
    takeControlFromServer("settle", ctx?.applyCurrentMovement);
    return;
  }
  // OURS: the safety cap. Retail has no timeout here.
  if (elapsed >= TURN_SETTLE_CAP_MS) {
    takeControlFromServer("cap", ctx?.applyCurrentMovement);
  }
}

/** Diag-only: note an applied / dropped local turn directive. */
export function noteServerTurnApplied() { bump("serverTurnApplied"); }
export function noteServerTurnDropped() { bump("serverTurnDropped"); }

/**
 * Heading (radians, AC yaw) from a wire turn quaternion. The directive carries
 * an absolute orientation; only the Z component matters for a stand-up biped
 * (`applyTurnDirective` treats it the same way for remotes).
 */
export function headingFromTurnQuat(qw, qz) {
  const w = +qw, z = +qz;
  if (!Number.isFinite(w) || !Number.isFinite(z)) return null;
  const h = 2.0 * Math.atan2(z, w);
  return Number.isFinite(h) ? normPi(h) : null;
}
