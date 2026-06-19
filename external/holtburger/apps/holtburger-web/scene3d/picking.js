import * as THREE from "three";
import { getCombatManeuver, loadCombatManeuverTable } from "../ui/ac_combat_maneuver.js";
import {
  ATTACK_TYPE,
  inferAttackTypeForWeapon,
} from "../ui/ac_attack_type_for_weapon.js";
import { getAimLevelForVelocity, getAimLevelForBallisticArc } from "../ui/ac_aim_level_for_velocity.js";
import { isAttackerBehindDefender } from "../ui/ac_sneak_attack_predict.js";
import { classifySpell } from "../ui/ac_spell_shape.js";
import {
  createPursuitMonitor,
  createTurnMonitor,
  readWasmPursuitFlag,
} from "./pursuit_monitor.js";

const ATTACK_HEIGHT_MEDIUM = 2;
const ATTACK_POWER_FULL = 1.0;

// F17-2 — retail GetDoubleClickDelay-like window. In peace mode a
// single click only selects + assesses the object; USE (portal teleport,
// door toggle, vendor open) requires a second click on the same target
// within this window, so a stray click no longer fires an irreversible
// world action. Retail's default double-click delay is ~0.3–0.5s.
const PEACE_USE_DOUBLE_CLICK_MS = 400;

// F7-3 — turn the local player to face a missile target before firing.
// ACE rotates the shooter (TurnToObject) before the launch; without this
// the arrow leaves your character's back when the target is behind/beside
// you. Default-OFF (touches the motion pipeline → setMovementInput turn);
// pending 1070 eye-test. (?missileFaceTarget=on)
// INTEGRATED always-on — 1070 eye-test PASSED 2026-06-11 (player turns to face
// a side/behind target before the missile shot). JS, live on reload. Was the
// default-OFF `?missileFaceTarget=on` gate.
const MISSILE_FACE_TARGET = true;
// Cap the turn-to-face pre-step so a bad bearing can't stall the shot.
const FACE_TURN_TIMEOUT_MS = 800;

// F8-5 — turn the local caster to face the target before a spell cast
// (ACE Rotate() before the windup), so the bolt doesn't launch sideways/
// backwards out of a frozen, wrong-facing caster. Same default-off rule
// as the missile case. (?castFaceTarget=on)
const CAST_FACE_TARGET = (() => {
  try {
    return typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("castFaceTarget") !== "off";
  } catch { return false; }
})();

// F6-5 — 3D / cylinder-aware melee range gate. Default-OFF (touches the
// combat motion pipeline: changes when the client auto-pursue engages vs
// when an immediate in-place swing fires). When ON, the melee reach check
// is a cylinder distance instead of a flat horizontal circle, so a target
// on a ledge / raised platform — a Z offset the flat 2.5m check was blind
// to — reads as out of range and the existing charge engages (run cycle +
// steering) instead of firing a "phantom" swing that ACE then services with
// an invisible force-position walk. (?melee3dRange=on)
const MELEE_3D_RANGE = (() => {
  try {
    return typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("melee3dRange") !== "off";
  } catch { return false; }
})();

// FU-3 (2026-06-11) — server-timed swing. Default-OFF. Retail plays NO
// local swing on attack input: `ClientCombatSystem::ExecuteAttack`
// (acclient.c:408626) only sends Event_TargetedMeleeAttack; the swing
// arrives as a server UpdateMotion that ACE broadcasts (to the attacker
// too, WorldObject_Networking.cs:1306) only AFTER its server-side MoveTo
// reports the attacker within useRadius (Player_Melee.cs:170-213,
// DoSwingMotion :398). When ON, the optimistic click-time swing is
// suppressed so the server's KIND_MOTION_ACTION echo — which already
// fires for the local guid — plays the swing at arrival, not at click.
// (?serverSwing=on)
const SERVER_SWING = (() => {
  try {
    return typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("serverSwing") !== "off";
  } catch { return false; }
})();

// A14-I2 (W3+ S10) — wasm pursuit / turn-to intents. Default-OFF.
// When ON (and the wasm exports exist — typeof-guarded, F18-2 spirit),
// the charge pursuit + turn-to-face steering moves WASM-side
// (`pursueEntity`/`turnToEntity` → the A3-D3 MoveToManager driver):
// JS keeps only a status monitor rAF (scene3d/pursuit_monitor.js) and
// NEVER calls `setMovementInput` on the pursuit path — the (0,0,0)
// charge-end stomp sites are bypassed and a held WASD drive is
// restored wasm-side (the charge-end WASD-stomp fix). Arrival still
// invokes the SAME `charge.fireAttack` closure with the windup release
// first, identical order to the legacy arrival — F6-6 (live lockout
// read inside `fireOnce`) preserved verbatim. Requires a wasm build
// with `USE_MOVETO_DRIVER` flipped (compose rule, docs/url-flags.md);
// on a driver-off build the intent fast-fails (status 3) and the
// monitor cancels without firing. (?wasmPursuit=on)
const WASM_PURSUIT = (() => {
  try {
    return typeof window !== "undefined" &&
      readWasmPursuitFlag(window.location.search);
  } catch { return false; }
})();

// Fallback AttackType for the CombatManeuverTable lookup when the
// per-weapon inference (Wave 1 Phase 3, 2026-05-26) returns
// `ATTACK_TYPE.Undef` — e.g. shield-only, ranged before Phase 6
// audit, caster outside the magic branch. Set to `Slash = 0x04` per
// ACE's `AttackType.cs` because the dominant retail melee row uses
// Slash across all melee stances in CMT 0x30000000.
//
// Wave 1 Phase 2 fix 2026-05-26 — was `0x08 = Kick` previously, which
// the diag histogram audit caught as load-bearing wrong.
const ATTACK_TYPE_SLASH = ATTACK_TYPE.Slash;

// Eagerly kick the CMT load at module-import time so the lookup is
// already cached by the time the first attack fires. Idempotent +
// concurrent-safe (loadCombatManeuverTable dedupes via in-flight
// Promise map).
try { loadCombatManeuverTable(); } catch (_) {}

// Phase I.1 — charge-attack tuning. Retail melee range is ~2.5m, missile
// range varies by weapon (we approximate at 25m). These constants
// drive both the "in range now" gate and the auto-pursue stop condition.
const MELEE_RANGE_M = 2.5;
const MISSILE_RANGE_M = 25.0;
const MAX_CHARGE_DURATION_MS = 10_000; // safety net so we don't pursue forever

// Wave 7 / Phase 19 (2026-05-26) — default projectile speed for the
// gravity-arc aim predictor. Per ACE's
// `~/ace-server/Source/ACE.Server/WorldObjects/Creature_Missile.cs:208
//   public const float DefaultProjectileSpeed = 20.0f;`
// (the fallback when the wielded missile launcher has no
// `PropertyFloat.MaximumVelocity = 26` on the wire, i.e. starter bows).
// Per-weapon projectile speed is surfaced via PropertyFloat 26 —
// Wave 8 / Phase 25 (2026-05-26): `getEquippedWeapon(localGuid)` now
// returns `maximumVelocity` (sourced from `EquippedWeaponJs` /
// `InventoryItem` in `src/lib.rs`). This constant remains as the
// explicit fallback when the wire hasn't surfaced PropertyFloat 26
// yet (most common: starter bows / pre-ObjectCreate property arrival).
// KEEP ALIGNED with the Rust-side `unwrap_or(20.0)` in
// `apply_inventory_object_create` / `publish_player_inventory_snapshot`
// — drift between the two creates per-frame bucket-flip jitter.
// A fast composite bow ranges up to ~35 m/s; crossbows ~45 m/s.
const BOW_DEFAULT_SPEED_MPS = 20.0;

// Entity world position in AC coords. Pre-2026-05-19 this routed
// through a `threeToAc` inverse, but that was load-bearing wrong:
// `EntityInstance.setPose` writes `inst.root.position.set(wx, wy, wz)`
// directly from the AC world coords delivered by loop.js
// (`wx = lbX*192 + upd.x`, etc.) — the visual rendering is correct
// only because `worldRoot.rotation.x = -π/2` swaps z-up at the
// parent. So `inst.root.position` is ALREADY in AC frame; calling
// threeToAc again garbled it. With the bug, picking.js computed
// target bearings against (x, -z, y) — a position the entity isn't
// at — and charge-to-target ran the player consistently north
// regardless of where the monster was. The renderer puts terrain /
// statics / buildings / entities under worldRoot per the world-
// completeness convention, so this also matches how the placement
// validator reads positions (see world-completeness §"World-frame
// convention").
function entityAcPosition(entityManager, guid) {
  const inst = entityManager?.entityMap?.get((guid >>> 0));
  if (!inst?.root?.position) return null;
  const p = inst.root.position;
  return { x: p.x, y: p.y, z: p.z };
}

function horizontalDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// F6-5 — melee reach as a cylinder distance. Within a humanoid-height
// vertical band the horizontal distance governs (normal flat combat is
// unchanged); beyond it the vertical excess folds in Pythagorean-style so a
// raised/sunken target is correctly judged far. Full radius subtraction
// (reach a large monster at its cylinder edge) needs the per-entity physics
// radius from the DAT, which isn't surfaced to JS yet — deferred, same as
// F14-6's per-entity objcell_id. Only consulted under `?melee3dRange=on`.
const MELEE_VERTICAL_REACH_M = 2.0; // ~one humanoid height of vertical slack
function meleeCylinderDistance(a, b) {
  const horiz = horizontalDistance(a, b);
  const vExcess = Math.max(0, Math.abs(a.z - b.z) - MELEE_VERTICAL_REACH_M);
  return vExcess > 0 ? Math.sqrt(horiz * horiz + vExcess * vExcess) : horiz;
}
// The metric the melee gate + charge use: cylinder when the flag is on,
// flat horizontal (byte-identical to pre-F6-5) when off.
function meleeGateDistance(a, b) {
  return MELEE_3D_RANGE ? meleeCylinderDistance(a, b) : horizontalDistance(a, b);
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Convert the wasm-side LocalPlayerPose (which carries landblock-local
// x/y and a separate landblockId) into AC world coords so it can be
// compared against entity world positions (which are world-frame per
// `EntityInstance.setPose` writing `wx = lbX*192 + upd.x` directly).
// `pose.z` is already world altitude and passes through. `heading`
// is left as-is — it's a rotation in radians, not a position.
//
// Pre-fix the chargeTick computed `dx = entity.x - pose.x` against
// landblock-local pose x (range 0..192) and world entity x (range
// ~32000-34000 at Holtburg), so `dx` was dominated by the landblock
// offset (~32000) and bearings always pointed NE-ish regardless of
// where the entity actually was. Player charged in a fixed wrong
// direction and never reached range → attack never fired. See the
// landblockId getter at `lib.rs:12714` for the wire format.
function playerWorldPose(sessionHandle) {
  const pose = sessionHandle.getLocalPlayerPose?.();
  if (!pose) return null;
  const lbId = (pose.landblockId ?? 0) >>> 0;
  const lbX = (lbId >>> 24) & 0xff;
  const lbY = (lbId >>> 16) & 0xff;
  return {
    x: pose.x + lbX * 192,
    y: pose.y + lbY * 192,
    z: pose.z,
    heading: pose.heading,
    landblockId: lbId,
  };
}

// F11-5 — surface a player-visible reason when a combat/cast action is
// dropped client-side for a mode mismatch (wrong stance, no target, armed
// spell in a non-magic stance). Previously these were console-only, so the
// player read silence as "combat is broken" rather than "wrong mode".
// Emits onto the plugin bus; plugins/rejection_feedback.js renders the
// toast (same surface it uses for server-side WeenieError rejections), so
// picking.js stays decoupled from the DOM. Fail-soft pre-login (no bus).
function emitActionRejected(message) {
  try {
    window.__pluginClient?.events?.emit?.("clientActionRejected", { message });
  } catch (_) { /* never block input handling on feedback */ }
}

export function setupClickPicking({
  canvas,
  liveScene3d,
  sessionHandle,
  isInMeleeStance,
  isInRangedStance,
  isInMagicStance,
  getLocalPlayerGuid,
}) {
  if (!canvas || !liveScene3d || !sessionHandle) {
    console.warn(
      "[picking] setupClickPicking early-return — click + __fireAttackOnTarget will be missing.",
      { canvas: !!canvas, liveScene3d: !!liveScene3d, sessionHandle: !!sessionHandle },
    );
    return { destroy() {} };
  }

  const raycaster = new THREE.Raycaster();
  // Phase 5 PView depth-clear (commit 476362fd) put cellsGroup +
  // entitiesGroup on render layer 1 so the world / cells passes can
  // be rendered separately with a depth-clear between them. THREE
  // Raycaster defaults to layer 0 only, which silently skipped every
  // entity / cell static — clicking on doors / NPCs / chests stopped
  // working. Enable layer 1 so picking sees the same scene the camera
  // sees.
  raycaster.layers.enable(1);
  const ndc = new THREE.Vector2();

  // Phase I.1 — charge-attack state machine. One pursuit in flight at
  // a time; clicking a different target replaces the current charge.
  let charge = null; // { guid, range, fireAttack, startMs, rafId }

  // F17-2 — last peace-mode click, for double-click-to-Use detection.
  let lastPeaceClick = { guid: 0, t: 0 };

  // F6-4 — throttle for movement-driven CancelAttack so a held WASD key
  // (keydown auto-repeat) doesn't spam the wire.
  let lastCancelAttackMs = 0;

  // Wave 2 Phase 4 (2026-05-26): track the last-fired melee motion u32
  // so the CMT picker can carry `prevMotion` forward. Module-scoped to
  // this closure (one local player per session); intentionally NOT
  // stamped on `EntityInstance` per dispatch guidance — the alternation
  // heuristic is purely picker-side and shouldn't leak into the entity
  // manager's shared state. The current picker doesn't actually
  // consume `prevMotion` (ACE's port at `Player_Melee.cs:465-468` uses
  // a power-bar threshold, not alternation), but the value is wired
  // through for forward-compat with the commented-out retail
  // alternation path at `CombatManeuverTable.cs:90-102`.
  let prevMeleeMotion = 0;

  // Wave 4 / Phase 4.2 (2026-05-26) — release any in-flight windup
  // hold on the local player. Called from cancelCharge and on
  // successful arrival-then-fire so the held swing clip can play out
  // to its release frames (peak → strike → recovery).
  function _releaseLocalWindupHold() {
    try {
      const em = liveScene3d?.entityManager;
      const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
      if (em && localGuid !== 0 && typeof em.releaseSwingHold === "function") {
        em.releaseSwingHold(localGuid);
      }
    } catch (_) {}
  }

  // A14-I2 — effective-on check for the wasm pursuit path: the URL
  // flag AND every load-bearing export (a stale pkg/ soft-degrades to
  // the legacy chargeTick/turnToFaceThenAct, F18-2 spirit).
  function wasmPursuitReady() {
    return WASM_PURSUIT &&
      typeof sessionHandle.pursueEntity === "function" &&
      typeof sessionHandle.turnToEntity === "function" &&
      typeof sessionHandle.cancelPursuit === "function" &&
      typeof sessionHandle.pursuitStatus === "function";
  }

  function cancelCharge() {
    if (!charge) return;
    if (charge.rafId) cancelAnimationFrame(charge.rafId);
    if (charge.wasmPursuit) {
      // A14-I2 — abort the wasm-side pursuit instead of the legacy
      // (0,0,0) stomp; a held WASD drive is restored wasm-side.
      try { sessionHandle.cancelPursuit?.(); } catch {}
    } else {
      try {
        sessionHandle.setMovementInput?.(0, 0, 0, false);
      } catch {}
    }
    // Wave 4 / Phase 4.2 — release the windup if the charge is being
    // cancelled (target died mid-pursuit, stance flip, key abort).
    // Otherwise the held arm pose lingers until the next swing fires.
    _releaseLocalWindupHold();
    charge = null;
  }

  // A14-I2 — flag-on replacement for the steering chargeTick: the wasm
  // driver steers; JS only polls `pursuitStatus()` through the pure
  // monitor (scene3d/pursuit_monitor.js). NO `setMovementInput` calls
  // anywhere on this path. Arrival handler order is IDENTICAL to the
  // legacy in-range branch: `_releaseLocalWindupHold()` then
  // `charge.fireAttack()` then clear — `fireAttack`/`fireOnce` are
  // untouched, so the F6-6 live lockout read happens inside `fireOnce`
  // at execution time exactly as today.
  function pursuitMonitorTick() {
    if (!charge || !charge.monitor) return;
    let statusRaw = 0;
    try { statusRaw = sessionHandle.pursuitStatus() >>> 0; } catch {}
    const result = charge.monitor({
      statusRaw,
      elapsedMs: performance.now() - charge.startMs,
      inCombatStance: !!(isInMeleeStance?.() || isInRangedStance?.()),
    });
    if (result.action === "arrive") {
      _releaseLocalWindupHold();
      try { charge.fireAttack(); } catch (e) {
        console.warn(`[picking] charge attack fire failed: ${e?.message ?? e}`);
      }
      charge = null;
      return;
    }
    if (result.action === "cancel") {
      if (result.reason === "timeout") {
        console.warn("[picking] wasm pursuit timed out");
      } else if (result.reason === "failed") {
        console.warn(
          `[picking] wasm pursuit failed (werror=0x${(result.werror ?? 0).toString(16)})`,
        );
      }
      // For "failed" the wasm side already ended the pursuit; the
      // cancelPursuit inside cancelCharge is then a harmless no-op
      // (CancelMoveTo acts only while a movement is active).
      cancelCharge();
      return;
    }
    if (result.action === "continue") {
      charge.rafId = requestAnimationFrame(pursuitMonitorTick);
    }
  }

  function chargeTick() {
    if (!charge) return;

    // Safety net — bail after a fixed wall-clock to prevent forever-pursuit.
    if (performance.now() - charge.startMs > MAX_CHARGE_DURATION_MS) {
      console.warn("[picking] charge attack timed out");
      cancelCharge();
      return;
    }

    // Abort if user left a combat stance while we were chasing.
    const inMelee = !!isInMeleeStance?.();
    const inRanged = !!isInRangedStance?.();
    if (!inMelee && !inRanged) {
      cancelCharge();
      return;
    }

    // Read target + player positions — both must be in world coords.
    // `entityAcPosition` returns world coords directly (entities are
    // stored in AC world frame; see entities.js:420 setPose). The
    // player pose needs landblock offset added via `playerWorldPose`.
    const targetAc = entityAcPosition(liveScene3d.entityManager, charge.guid);
    const pose = playerWorldPose(sessionHandle);
    if (!targetAc || !pose) {
      cancelCharge();
      return;
    }

    // F6-5 — stop on the cylinder metric for melee charges (so a ledge
    // target keeps the pursuit running until genuinely in reach), flat
    // horizontal for missile charges and when `?melee3dRange` is off.
    const dist = charge.cylinderReach
      ? meleeCylinderDistance(targetAc, pose)
      : horizontalDistance(targetAc, pose);
    if (dist <= charge.range) {
      // In range — stop, fire attack, clear state.
      try { sessionHandle.setMovementInput(0, 0, 0, false); } catch {}
      // Wave 4 / Phase 4.2 — release the windup hold BEFORE the real
      // swing fires. The fire path will call `setSwingMotion(...)`
      // without `holdAtPeak`, which arms a fresh restore timer; the
      // release flips action.paused=false so the held windup clip's
      // remaining frames complete naturally as the new fire-time
      // swing starts. Net result: smooth wind-up → strike →
      // recovery instead of a snap at the moment of arrival.
      _releaseLocalWindupHold();
      try { charge.fireAttack(); } catch (e) {
        console.warn(`[picking] charge attack fire failed: ${e?.message ?? e}`);
      }
      charge = null;
      return;
    }

    // Compute compass bearing from player to target — `pose.heading`
    // is in COMPASS convention (`yaw=0 → +Y north`, `yaw=π/2 → +X east`
    // per `lib.rs:12706`). For compass bearings, `atan2(dx, dy)` (note
    // the swap from the math-convention `atan2(dy, dx)`) gives
    // `0 = north`, `π/2 = east`. Subtracting `pose.heading` then yields
    // the correct local turn delta.
    const dx = targetAc.x - pose.x;
    const dy = targetAc.y - pose.y;
    const bearing = Math.atan2(dx, dy);
    const turnDelta = normalizeAngle(bearing - pose.heading);
    let turn = 0;
    if (Math.abs(turnDelta) > 0.05) turn = turnDelta > 0 ? 1 : -1;
    // 2026-05-19 — one-shot debug log on the first tick of each
    // charge so we can verify the math after the entityAcPosition
    // coord fix. If `bearing - pose.heading` doesn't produce a
    // turn that actually faces the player toward `targetAc`, there
    // may be a `pose.heading` convention mismatch (compass vs math)
    // that needs a π/2 + sign-flip correction.
    if (!charge._debugLogged) {
      charge._debugLogged = true;
      console.log(
        `[charge/debug] target=0x${charge.guid.toString(16)} ` +
        `playerAc=(${pose.x.toFixed(1)}, ${pose.y.toFixed(1)}, ${pose.z.toFixed(1)}) ` +
        `targetAc=(${targetAc.x.toFixed(1)}, ${targetAc.y.toFixed(1)}, ${targetAc.z.toFixed(1)}) ` +
        `dist=${dist.toFixed(2)}m range=${charge.range}m ` +
        `bearing=${bearing.toFixed(3)} heading=${pose.heading?.toFixed?.(3) ?? "?"} ` +
        `turnDelta=${turnDelta.toFixed(3)} turn=${turn}`
      );
    }
    try {
      sessionHandle.setMovementInput(1 /* forward */, 0 /* strafe */, turn, true /* run */);
    } catch {}

    charge.rafId = requestAnimationFrame(chargeTick);
  }

  // F7-3 / F8-5 — turn the local player to face `targetGuid`, then run
  // `act`. Reuses chargeTick's bearing math but turns IN PLACE (forward=0)
  // until the heading delta is within ~0.05 rad, mirroring ACE's
  // rotateTime/Rotate() delay before a missile launch or a spell cast.
  // No-ops to an immediate `act()` when `enabled` is false, the
  // target/pose is unresolvable, or we're already on-bearing.
  function turnToFaceThenAct(targetGuid, act, enabled) {
    if (!enabled) {
      act();
      return;
    }
    // A14-I2 — wasm-side rate-limited TurnToObject (retail case 8)
    // instead of the JS bang-bang ±1 turn. Monitor-only: status 2/3
    // OR the legacy FACE_TURN_TIMEOUT_MS (timeout also cancels the
    // still-running turn) → act(). An unresolvable target fails
    // wasm-side (status 3 next poll — retail CancelMoveTo on missing
    // object), which maps to the same act-anyway fallback as legacy.
    if (wasmPursuitReady()) {
      try {
        sessionHandle.turnToEntity(targetGuid >>> 0);
      } catch {
        act();
        return;
      }
      const monitor = createTurnMonitor({ timeoutMs: FACE_TURN_TIMEOUT_MS });
      const startMs = performance.now();
      const poll = () => {
        let statusRaw = 0;
        try { statusRaw = sessionHandle.pursuitStatus() >>> 0; } catch {}
        const result = monitor({
          statusRaw,
          elapsedMs: performance.now() - startMs,
        });
        if (result.action === "act") {
          if (result.cancel) {
            try { sessionHandle.cancelPursuit?.(); } catch {}
          }
          act();
          return;
        }
        if (result.action === "continue") requestAnimationFrame(poll);
      };
      poll();
      return;
    }
    if (typeof sessionHandle.setMovementInput !== "function") {
      act();
      return;
    }
    const startMs = performance.now();
    const step = () => {
      const targetAc = entityAcPosition(liveScene3d.entityManager, targetGuid);
      const pose = playerWorldPose(sessionHandle);
      if (!targetAc || !pose) {
        try { sessionHandle.setMovementInput(0, 0, 0, false); } catch {}
        act();
        return;
      }
      const dx = targetAc.x - pose.x;
      const dy = targetAc.y - pose.y;
      const bearing = Math.atan2(dx, dy);
      const turnDelta = normalizeAngle(bearing - pose.heading);
      if (Math.abs(turnDelta) <= 0.05 ||
          (performance.now() - startMs) > FACE_TURN_TIMEOUT_MS) {
        try { sessionHandle.setMovementInput(0, 0, 0, false); } catch {}
        act();
        return;
      }
      const turn = turnDelta > 0 ? 1 : -1;
      try { sessionHandle.setMovementInput(0 /* forward */, 0 /* strafe */, turn, false /* run */); } catch {}
      requestAnimationFrame(step);
    };
    step();
  }

  /**
   * Wave 4 / Phase 4.2 (2026-05-26) — startCharge with optional
   * windup motion. Callers pass `motionForWindup` (the same swing
   * MotionCommand they intend to fire on arrival) to drive a held
   * pose during pursuit. Backwards-compat: omit the param and the
   * pursuit runs without a windup pose (pre-Wave-4 behaviour).
   *
   * Hold-at-peak is the windup feel: from charge-start, the swing
   * clip plays through its first half (~50% of `durationSec`), then
   * pauses at the peak frame until arrival. The arrival path in
   * `chargeTick` releases the hold and fires the real swing — the
   * remaining clip frames (strike + recovery) play out via the
   * release-armed restore timer in `releaseSwingHold`.
   *
   * If `motionForWindup` is 0 / unresolvable, or the local
   * entity manager isn't ready, the hold is silently skipped and
   * the pursuit runs without a windup pose. Telemetry: a
   * `[entities/swingMotion] HOLD ...` log line on the hold-armed
   * path.
   */
  function startCharge(guid, range, fireAttack, motionForWindup, cylinderReach) {
    cancelCharge();
    const useWasmPursuit = wasmPursuitReady();
    charge = {
      guid: guid >>> 0,
      range,
      fireAttack,
      startMs: performance.now(),
      rafId: 0,
      // F6-5 — melee charges pass true under `?melee3dRange=on` so the
      // pursuit stop-condition uses the SAME cylinder metric as the gate
      // that started it (else it would over- or under-shoot the stop).
      // Missile charges leave it false → flat horizontal as before.
      cylinderReach: !!cylinderReach,
      // A14-I2 — wasm-steered pursuit: monitor only, no JS steering.
      wasmPursuit: useWasmPursuit,
      monitor: useWasmPursuit
        ? createPursuitMonitor({ maxDurationMs: MAX_CHARGE_DURATION_MS })
        : null,
    };
    try {
      const em = liveScene3d?.entityManager;
      const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
      const cmd = (motionForWindup >>> 0) || 0;
      if (em && localGuid !== 0 && cmd !== 0 && typeof em.setSwingMotion === "function") {
        em.setSwingMotion(localGuid, cmd, { holdAtPeak: true });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[picking] charge windup setSwingMotion failed:", e);
    }
    if (useWasmPursuit) {
      // A14-I2 — hand the steering to the wasm MoveTo driver: range
      // rides retail's native object_radius arg, the F6-5 vertical
      // reach rides object_height (0 for the flat metric), run=true
      // matches today's charge gait. Arrival authority is the wasm
      // status, not the JS distance math.
      try {
        sessionHandle.pursueEntity(
          charge.guid,
          range,
          charge.cylinderReach ? MELEE_VERTICAL_REACH_M : 0,
          true,
        );
      } catch (e) {
        console.warn("[picking] pursueEntity failed — falling back to legacy charge:", e);
        charge.wasmPursuit = false;
        charge.monitor = null;
        chargeTick();
        return;
      }
      pursuitMonitorTick();
      return;
    }
    chargeTick();
  }

  function pickEntityAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const camera = liveScene3d.cameraSwitcher?.getActive?.() ?? liveScene3d.camera;
    if (!camera) return null;
    raycaster.setFromCamera(ndc, camera);

    // F7 — pick-time filter: raycast ONLY against entity roots, never the
    // full scene tree (which would walk all ~16,700 Holtburg statics on
    // every click). Statics aren't pickable entities — if static-picking
    // ever becomes a requirement it needs its own list, not this one.
    // TODO(F7-followon): static picking via a separate static-roots list.
    const em = liveScene3d.entityManager;
    if (!em || !em.entityMap) {
      // Dev-mode signal — runtime init bug we don't want to crash on.
      console.warn("[picking] entityManager missing at pick time; ignoring click");
      return null;
    }
    const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;

    // Build a fresh flat list of entity roots per click — entities come
    // and go, so caching would just invite the spawn/despawn maintenance
    // bug that F7's full version exists to solve.
    const roots = Array.from(em.entityMap.values()).map(inst => inst?.root).filter(Boolean);
    if (roots.length === 0) return null;
    // Parallel guid lookup so the hit-to-guid resolution below stays O(1).
    // Excludes the local player so you can't pick yourself.
    const guidByRoot = new Map();
    for (const [guid, inst] of em.entityMap) {
      const g = guid >>> 0;
      if (g === localGuid) continue;
      if (!inst || !inst.root) continue;
      guidByRoot.set(inst.root, g);
    }

    // `recursive=true` is fine here: the flat list is small (≤ ~200
    // entities typically in PVS) and each entity root may have child
    // meshes (rig parts) that need to be tested. The key win is that
    // statics are NOT in `roots` at all.
    // `intersectObjects` returns hits already sorted near→far. Walk them
    // in distance order and return the first one that resolves to a
    // non-local entity guid. This skips occluders that aren't pickable
    // targets — most importantly the LOCAL player's own rig, which is in
    // `roots` (so the camera ray hits it) but absent from `guidByRoot`
    // (excluded above). Standing the player between the camera and an NPC
    // previously returned null (#18); now the loop steps past the self-
    // hit to the NPC behind it. "Can't pick yourself" is preserved: a
    // self-hit yields no guidByRoot match, so the loop simply advances.
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let obj = hit.object;
      while (obj && !guidByRoot.has(obj)) obj = obj.parent;
      if (obj) return guidByRoot.get(obj);
    }
    return null;
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    // Phase I.1 follow-on: any left-click ends an in-flight charge.
    // Without this, a click that misses the entity (clicking past
    // it, clicking on terrain) silently leaves the rAF loop running
    // and the player keeps walking toward the original target. Even
    // a click that DOES hit an entity should cancel first, so the
    // new target's charge starts from rest rather than overlapping
    // the previous one.
    cancelCharge();
    const guid = pickEntityAt(ev.clientX, ev.clientY);
    if (guid == null) return;
    ev.stopPropagation();
    ev.preventDefault();
    // Phase D — mark the clicked entity as the current target so
    // subsequent clicks (or the future combat-bar HUD) can read it.
    // Selection persists until another entity is picked.
    // Q1b (2026-05-26): emit `selectionChanged` on the plugin bus
    // so subscribers (combat-bar, radial-menu, examine-target) can
    // react without polling getSelectedTarget. Skip redundant sets.
    const prevGuid =
      (liveScene3d.entityManager?.getSelectedTarget?.() ?? 0) >>> 0;
    const newGuid = (guid >>> 0) || 0;
    liveScene3d.entityManager?.setSelectedTarget?.(guid);
    if (newGuid !== prevGuid && window.__pluginClient?.events) {
      window.__pluginClient.events.emit("selectionChanged", {
        guid: newGuid,
        prevGuid,
      });
    }
    try {
      const cb = window.__combatBarState;

      if (isInMagicStance?.() && typeof sessionHandle.castTargetedSpell === "function") {
        // Magic doesn't auto-charge — caster stands still to cast.
        // Click on entity with an armed spell fires the cast directly
        // (retail's "arm spell, click target" flow).
        const spellId =
          cb && typeof cb.armedSpellId === "number" && cb.armedSpellId > 0
            ? cb.armedSpellId
            : 0;
        if (spellId !== 0) {
          // Wave 6 Phase 16 (2026-05-26) — Sneak Attack prediction for
          // magic casts. acpedia wiki confirms Sneak Attack works for
          // War + Void Magic with the same 90°-rear-hemisphere facing
          // gate as melee/missile (Phase 9 in `ac_sneak_attack_predict.js`).
          // Pure UI signal — observational, not gating. The spell still
          // fires via `castTargetedSpell` regardless of whether the
          // predictor matched. `attackType: null` is intentional: magic
          // has no CMT AttackType bitmask, and event consumers must
          // handle that. `scope: "local-magic"` distinguishes from the
          // melee/missile branches' `local` / `local-missile` scopes.
          try {
            const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
            const em = liveScene3d.entityManager;
            const pose = playerWorldPose(sessionHandle);
            const targetPos = entityAcPosition(em, guid);
            const targetHeadingRad = em?.getHeading?.(guid) ?? null;
            if (
              pose && targetPos && targetHeadingRad != null &&
              isAttackerBehindDefender({
                attackerPose: pose,
                defenderPose: targetPos,
                defenderHeadingRad: targetHeadingRad,
              })
            ) {
              window.__pluginClient?.events?.emit?.("sneakAttackPredicted", {
                attackerGuid: localGuid,
                defenderGuid: (guid >>> 0),
                attackType: null,   // magic has no CMT AttackType bitmask
                spellId,
                scope: "local-magic",
              });
            }
          } catch (_) { /* never block the cast on prediction faults */ }
          // Wave 9 Phase 27 — spellCastInitiated event with shape classification.
          // Future plugins (projectile spawners, sound triggers, telemetry) can
          // subscribe via __pluginClient.events.on("spellCastInitiated", handler).
          // Classifier is lazy-loaded; first call may return a Promise — handle
          // both sync and async cases. Wire payload to castTargetedSpell is
          // unchanged regardless of classifier outcome.
          try {
            const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
            const classification = classifySpell(spellId);
            const fire = (c) => {
              window.__pluginClient?.events?.emit?.("spellCastInitiated", {
                spellId,
                targetGuid: guid,
                attackerGuid: localGuid,
                school: c?.school ?? null,
                shape: c?.shape ?? null,
                level: c?.level ?? null,
              });
            };
            if (classification && typeof classification.then === "function") {
              classification.then(fire).catch(() => fire(null));
            } else {
              fire(classification);
            }
          } catch (_) { /* event emission never blocks the cast */ }
          // F8-5 — turn to face the target before casting (ACE Rotate()),
          // flag-gated, so the bolt doesn't launch out of a wrong-facing
          // caster. The caster stands still otherwise (no auto-charge),
          // so an in-place turn is correct.
          const doCast = () => {
            sessionHandle.castTargetedSpell(guid, spellId);
            // Wave 14 / Phase 45 (2026-05-26) — per-spell scarab-windup
            // chain replaces Phase 42's `setCastPose` vibe-pose. The
            // chain runner lives in
            // `EntityManager.playCastSequence(guid, spellId)` (entities.js
            // ~line 2330) and loads `data/spell-cast-sequence.json` lazily
            // — first call kicks the fetch and falls back to vibe-pose;
            // subsequent calls hit the cached table and chain the real
            // gestures (windup × N → final cast). Cancellation is
            // built-in (rapid-fire clicks → newer cast preempts the
            // prior chain). Defensively-guarded: missing
            // `playCastSequence` (older bundle / partial reload) → fall
            // back to the Phase 42 vibe-pose so the local player still
            // gets *some* cast feedback. setCastPose itself no-ops on
            // non-human rigs and on missing entities.
            try {
              const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
              if (localGuid !== 0) {
                const em = liveScene3d?.entityManager;
                if (em?.playCastSequence) {
                  em.playCastSequence(localGuid, spellId);
                } else {
                  em?.setCastPose?.(localGuid);
                }
              }
            } catch (_) { /* never block the cast on pose-fallback faults */ }
          };
          turnToFaceThenAct(guid, doCast, CAST_FACE_TARGET);
        }
      } else if (isInMeleeStance?.() || isInRangedStance?.()) {
        // Retail UX — click on the monster only TARGETS it. Firing
        // happens via the combat-bar Hi/Med/Lo buttons (which call
        // `window.__fireAttackOnTarget(height)` below). Lets the
        // player swap heights mid-fight (helmet knocked off → Hi for
        // crit) without re-clicking the monster.
        // `setSelectedTarget` already fired above; nothing more to do.
        //
        // F11-5 — but if a spell is ARMED while in a melee/missile stance,
        // the click silently re-targets and the cast never fires (only the
        // magic branch above casts). Tell the player why instead of eating
        // the click.
        if (cb && typeof cb.armedSpellId === "number" && cb.armedSpellId > 0) {
          emitActionRejected("Enter magic mode to cast that spell.");
        }
      } else if (typeof sessionHandle.useObject === "function") {
        // Wave 6.B (2026-05-28) — typed-class click precedence for
        // Lifestone. The Chorizite-port WorldObjectManager
        // (window.__wom) holds typed subclasses (Lifestone extends
        // Static); when the click target is a Lifestone, emit the
        // typed-click event so plugins/lifestone-popup.js can render
        // bind/recall UI INSTEAD of the silent generic
        // useObject → ACE-decides-bind path. The popup eventually
        // dispatches `useObject(guid)` itself on user "Bind here"
        // confirmation (so this branch only blocks the generic
        // fall-through, no wire packet is dropped). Lifestone stays on
        // SINGLE click because it is confirmation-gated — a stray click
        // can't fire an irreversible action.
        let handledByTypedClick = false;
        try {
          const wo = (typeof window !== "undefined")
            ? window.__wom?.get?.(guid >>> 0)
            : null;
          if (wo && wo.constructor && wo.constructor.name === "Lifestone") {
            window.__pluginClient?.events?.emit?.("lifestoneClicked", {
              guid: guid >>> 0,
            });
            handledByTypedClick = true;
          }
        } catch (_) { /* never block click on wom-probe faults */ }
        if (!handledByTypedClick) {
          // F17-2 — single click only selects + assesses (selectionChanged
          // already fired above; examine-target requests appraisal off it).
          // Generic USE (portal teleport, door toggle, vendor open) now
          // requires a double-click within PEACE_USE_DOUBLE_CLICK_MS, so a
          // misclick in town no longer fires an irreversible world action.
          const g = guid >>> 0;
          const nowMs = (typeof performance !== "undefined" && performance.now)
            ? performance.now() : Date.now();
          const isDoubleClick =
            lastPeaceClick.guid === g &&
            (nowMs - lastPeaceClick.t) <= PEACE_USE_DOUBLE_CLICK_MS;
          if (isDoubleClick) {
            cancelCharge();
            sessionHandle.useObject(g);
            lastPeaceClick = { guid: 0, t: 0 }; // consume; next click re-selects
          } else {
            lastPeaceClick = { guid: g, t: nowMs };
          }
        }
      }
    } catch (e) {
      console.warn(`[picking] click(0x${guid.toString(16)}): ${e?.message ?? e}`);
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);

  // PR-LL 2026-05-23: drag-drop give from inventory onto an NPC.
  // The inventory plugin's <slot> elements set dataTransfer with
  // `application/x-hb-inv-guid` on dragstart. When such a drag is
  // released over the 3D canvas we raycast to find the entity under
  // the cursor and fire GameAction::GiveObjectRequest.
  function onCanvasDragOver(ev) {
    if (!ev.dataTransfer) return;
    if (!ev.dataTransfer.types?.includes("application/x-hb-inv-guid")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  }
  function onCanvasDrop(ev) {
    if (!ev.dataTransfer) return;
    const guidStr = ev.dataTransfer.getData("application/x-hb-inv-guid");
    if (!guidStr) return;
    ev.preventDefault();
    const itemGuid = parseInt(guidStr, 10) >>> 0;
    if (!itemGuid) return;
    const targetGuid = pickEntityAt(ev.clientX, ev.clientY);
    if (!targetGuid) {
      console.log("[give] drop missed — no entity under cursor at",
        ev.clientX, ev.clientY);
      return;
    }
    const handle = window.__sessionHandle;
    if (!handle?.giveObject) {
      console.warn("[give] no session handle — drop ignored");
      return;
    }
    try {
      handle.giveObject(targetGuid >>> 0, itemGuid >>> 0, 1);
      // Best-effort visual feedback via existing chat channel:
      // ACE will echo success/failure as a chat line shortly.
      console.log(
        `[give] target=0x${targetGuid.toString(16).padStart(8, "0").toUpperCase()} ` +
        `item=0x${itemGuid.toString(16).padStart(8, "0").toUpperCase()} amount=1`,
      );
    } catch (e) {
      console.warn("[give] giveObject failed", e);
    }
  }
  canvas.addEventListener("dragover", onCanvasDragOver);
  canvas.addEventListener("drop", onCanvasDrop);

  // Retail UX — combat-bar Hi/Med/Lo buttons call this to fire on the
  // currently selected target at the chosen height. Click on a monster
  // selects it (in `onPointerDown` above); subsequent height-button
  // clicks swing/shoot. Lets the player swap attack height mid-fight
  // (e.g. helmet off → Hi for crit) without re-targeting. Magic
  // stance still uses click-on-entity to release armed spells; it
  // does NOT route through this helper.
  //
  // Out-of-range = auto-pursue via the existing `startCharge` rAF
  // loop, then fire on arrival. In-range = fire immediately. The
  // lockout (`cb.attackInProgress`) gates rapid clicks; the
  // `combatCommenceAttack` event seeds the combat-bar power meter.
  function fireAttackOnSelectedTarget(height) {
    const targetGuid = (liveScene3d.entityManager?.getSelectedTarget?.() ?? 0) >>> 0;
    if (targetGuid === 0) {
      console.log("[fire-attack] no target selected — click a monster first");
      emitActionRejected("Select a target first."); // F11-5
      return;
    }
    const cb = window.__combatBarState;
    const rawHeight = Number.isFinite(height) ? height : (cb?.attackHeight ?? ATTACK_HEIGHT_MEDIUM);
    // AC AttackHeight is 1=High/2=Medium/3=Low; the wasm `attack()` throws on
    // anything else. 0 (and other invalid values) must never reach it — fall
    // back to Medium rather than crash the swing. (Number.isFinite(0) is true,
    // so a 0 would otherwise sail past the `??` above.)
    const safeHeight = (rawHeight === 1 || rawHeight === 2 || rawHeight === 3) ? rawHeight : ATTACK_HEIGHT_MEDIUM;
    const slider =
      cb && typeof cb.powerLevel === "number" ? cb.powerLevel : ATTACK_POWER_FULL;
    const fireOnce = (cmd, commenceDetail) => {
      // F6-6 — read the lockout LIVE at execution time, not a click-time
      // capture. For a charge-pursuit `fireOnce` runs seconds later on
      // arrival; sampling `attackInProgress` at click time meant a swing
      // that was merely finishing when you clicked gated the arrival fire,
      // so a full chase ended in a silently swallowed attack ("dead click
      // after a chase"). By arrival the prior swing's attackDone has
      // usually cleared the flag, so the queued attack now actually fires.
      //
      // F11-3 — re-read `window.__combatBarState` HERE rather than the
      // click-time `cb` capture above. Any syncWindowState (stance change,
      // slider/checkbox edit, panel re-render) REPLACES the snapshot object
      // wholesale, so the captured `cb` can be stale by the time a pursuit
      // fires seconds later. The lockout clearers (attackDone / ack-loss
      // safety-timeout, now owned at combat-bar module load) always mutate
      // the *live* object, so gating and setting the flag on that same live
      // object keeps set-vs-clear coherent. syncWindowState carries
      // attackInProgress forward across the swap, so the live object never
      // loses an in-flight lock.
      const liveCb = (typeof window !== "undefined") ? window.__combatBarState : cb;
      if (liveCb?.attackInProgress) {
        console.log("[fire-attack] attack still pending (server hasn't sent attackDone) — gated");
        return false;
      }
      cmd();
      if (liveCb) liveCb.attackInProgress = true;
      try {
        // F10-3 — this client-bus emit already seeds the combat-bar power
        // meter on the FIRST / single swing (the doc's "first attacks never
        // animate" premise was stale — the meter listens to THIS event, not
        // the server's CombatCommenceAttack). `commenceDetail` optionally
        // carries the resolved swing-clip duration so the meter can track
        // the real cadence under `?powerMeterSwingDuration=on`.
        window.__pluginClient?.events?.emit?.("combatCommenceAttack", commenceDetail || {});
      } catch (_) {}
      return true;
    };

    // 2026-05-19 — charge re-enabled now that `entityAcPosition` no
    // longer double-transforms the target's position. If still out
    // of range after manual walking, the rAF chargeTick takes over
    // (auto-pursues until in range, then fires). chargeAttack=false
    // in the bar disables the auto-pursue per-click.
    const chargeEnabled = cb?.chargeAttack !== false;
    const inMelee = !!isInMeleeStance?.();
    const inRanged = !!isInRangedStance?.();
    // Both world-coord — see playerWorldPose comment above for the
    // landblock-local → world conversion. Without this, `dist` would
    // be dominated by the landblock offset (~32000m) and every target
    // would look out-of-range.
    const pose = playerWorldPose(sessionHandle);
    const targetAc = entityAcPosition(liveScene3d.entityManager, targetGuid);
    const dist = (pose && targetAc) ? horizontalDistance(pose, targetAc) : -1;
    if (inRanged && typeof sessionHandle.missileAttack === "function") {
      // Wave 2 Phase 6 (2026-05-26) — mirror the melee branch below
      // through the CombatManeuverTable + `setSwingMotion` path so
      // diag observability is identical across melee/missile. The
      // Phase 6 audit at
      // `crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs`
      // confirmed retail CMT 0x30000000 has ZERO rows for ranged
      // stances (BowCombat / CrossbowCombat / SlingCombat /
      // ThrownWeaponCombat / AtlatlCombat) — the missile motion
      // dispatch in ACE / retail uses aim-angle via
      // `Creature_Missile.cs::GetAimLevel` (Player_Missile.cs:207)
      // and skips the CMT entirely. The CMT lookup is kept for diag
      // observability (it always misses for ranged stances; the
      // miss reason is visible in `motionByStance` per Phase 1).
      //
      // Wave 3 Phase 7 (2026-05-26) — aim-level dispatch lands. After
      // the CMT miss we fall through to the aim-level resolver on a
      // target-relative trajectory. Server-authoritative `GetAimVelocity`
      // (Creature_Missile.cs:236-252) factors gravity arc + eye-height;
      // wire's `UpdateMotion` (kind=5) corrects any client/server
      // mismatch. See the helper's docstring "Prediction-quality
      // trade-off".
      //
      // Wave 7 / Phase 19 (2026-05-26) — gravity-arc upgrade. Swap the
      // direct-line `getAimLevelForVelocity(aimVelocity)` for
      // `getAimLevelForBallisticArc({origin, target, projectileSpeed})`
      // which factors projectile speed + gravity, matching the
      // server-side arc that `Trajectory.solve_ballistic_arc` builds
      // in `Creature_Missile.cs:306 GetProjectileVelocity`. Closes the
      // visible bucket-flip jitter on long level shots (direct line
      // picks AimLevel; the server-correct bucket for a 30 m / 20 m/s
      // shot is AimHigh30 — UpdateMotion would re-pose mid-swing).
      // Falls back to direct-line if the target is beyond ballistic
      // range for the given speed (preserves the Wave 3 Phase 7
      // behaviour as a safety net).
      const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
      const stance = (window.__getCurrentStanceLow?.() ?? 0) >>> 0;
      const em = liveScene3d.entityManager;
      const weapon = em?.getEquippedWeapon?.(localGuid) ?? null;
      const inferredType = inferAttackTypeForWeapon(weapon);
      const attackType = (inferredType === ATTACK_TYPE.Undef)
        ? ATTACK_TYPE_SLASH
        : inferredType;
      const motionCmd = getCombatManeuver(stance, safeHeight, attackType, slider);
      // Aim-level fallback: gravity-compensated ballistic arc from
      // `pose` (shooter) to `targetAc` (target), both in AC world
      // coords. `pose` and `targetAc` are computed above for the
      // charge-to-range distance — re-using them avoids a second
      // accessor walk. If either is null the helper's solver returns
      // null → direct-line fallback which guards to AimLevel.
      // Wave 8 / Phase 25 (2026-05-26): `projectileSpeed` is meant to be
      // per-weapon — from PropertyFloat::MaximumVelocity = 26 off the
      // wielded launcher, surfaced via `EquippedWeaponJs.maximumVelocity`
      // / `InventoryItem.maximumVelocity` (lib.rs) through
      // `getEquippedWeapon` in entities.js. `BOW_DEFAULT_SPEED_MPS = 20.0`
      // is the fallback (matches ACE `Creature_Missile.cs:208
      // DefaultProjectileSpeed`).
      // F7-4 (2026-06-10): ACE never transmits PropertyFloat 26 per-instance
      // (it's a weenie property read server-side only), so the wire value is
      // absent and pre-F7-4 `maximumVelocity` was ALWAYS the 20.0 floor. The
      // Rust hydration (`resolve_launcher_max_velocity`) now fills it from a
      // static wcid→MaximumVelocity launcher table behind
      // `?launcherVelocityTable=on` (default OFF = 20.0), so under that flag
      // this reads the real per-launcher speed (15–50 m/s) with NO change
      // here — `maximumVelocity` just carries the resolved value. Still
      // mostly masked by F7-2 (predicted bucket can't play), but the arc /
      // out-of-range math is now correct.
      // Phase 26 (Wave 9, 2026-05-26): treat explicit 0 as unset. ACE
      // non-missile weapons leave the property unset (None → 20.0 via
      // Rust's `unwrap_or`), but the `> 0` guard is defensive against
      // any weapon shipping a literal 0.0 — a 0 m/s projectile would
      // collapse the gravity-arc solver.
      // Wave 10 / Phase 32 (2026-05-26) — UseFastMissiles client-side
      // prediction multiplier. ACE applies `fast_missile_modifier = 1.2`
      // to the launcher's max velocity server-side
      // (`Creature_Missile.cs:223-225`) when the player has
      // `CharacterOption.UseFastMissiles` (0x2B) set in their
      // CharacterOptions2 mask. Without this client mirror, our local
      // gravity-arc predictor would pick an AimLevel for the un-boosted
      // speed and the server's UpdateMotion (kind=5) would re-pose
      // mid-swing once the boosted velocity took effect.
      //
      // This is CLIENT-side prediction only. The wire-side option
      // change (sending `GameAction::SetSingleCharacterOption(
      // UseFastMissiles, true)` via wasm) isn't yet exposed from
      // `holtburger-web/src/lib.rs` — Wave 11+ TODO. Until that lands,
      // toggling the UI checkbox only affects the local arc prediction;
      // the server still uses 1.0× and the kind=5 correction will fire
      // on first swing. Once the wire is wired, the prediction
      // matches and no correction is needed.
      //
      // `cb` is already in scope from the outer fireAttackOnSelectedTarget
      // closure (declared at the top of this function) — re-using it
      // rather than re-reading window.__combatBarState here keeps the
      // boost coherent with the height / power / charge flags read off
      // the same snapshot.
      const fastMissileMultiplier = (cb?.useFastMissiles === true) ? 1.2 : 1.0;
      const projectileSpeed = ((weapon && Number.isFinite(weapon.maximumVelocity) && weapon.maximumVelocity > 0)
        ? weapon.maximumVelocity
        : BOW_DEFAULT_SPEED_MPS) * fastMissileMultiplier;
      const aimMotion = (targetAc && pose)
        ? getAimLevelForBallisticArc({
            origin: pose,
            target: targetAc,
            projectileSpeed,
          })
        : getAimLevelForVelocity(null);
      // CMT first (always misses for ranged today, but the layer is
      // wired so a future retail-data dump that adds ranged rows would
      // light up automatically); aim-level fallback whenever CMT fails.
      // `setSwingPose` only fires for the impossible case where both
      // lookups return 0 — the helper guarantees never (returns one of
      // the 13 AimMotions for any finite input).
      const finalMotion = motionCmd || aimMotion;
      try { window.__diag?.combat?.onAimLevel?.({ scope: "local", motion: aimMotion }); } catch (_) {}
      console.log(`[fire-attack] missile height=${safeHeight} target=0x${targetGuid.toString(16)} slider=${slider.toFixed(2)} dist=${dist.toFixed(2)}m attackType=0x${attackType.toString(16)} motionCmd=${motionCmd ? "0x" + motionCmd.toString(16) : "none"} aimMotion=0x${aimMotion.toString(16)} (range=${MISSILE_RANGE_M}m)`);
      const fire = () => fireOnce(() => {
        // Wave 5 / Phase 9 (2026-05-26) — Sneak Attack prediction. Re-
        // sample target position + defender heading at the actual fire
        // tick (the outer-scope `pose` / `targetAc` are stale after a
        // charge-pursuit). Emit `sneakAttackPredicted` exactly once
        // per swing when the attacker is in the defender's 90° rear
        // hemisphere — matches ACE `Creature_Combat.cs:763`. Pure UI
        // signal; the wire payload to `missileAttack` is unchanged.
        try {
          const firePose = playerWorldPose(sessionHandle);
          const fireTargetPos = entityAcPosition(em, targetGuid);
          const targetHeadingRad = em?.getHeading?.(targetGuid) ?? null;
          if (
            firePose && fireTargetPos && targetHeadingRad != null &&
            isAttackerBehindDefender({
              attackerPose: firePose,
              defenderPose: fireTargetPos,
              defenderHeadingRad: targetHeadingRad,
            })
          ) {
            window.__pluginClient?.events?.emit?.("sneakAttackPredicted", {
              attackerGuid: localGuid,
              defenderGuid: targetGuid,
              attackType,
              scope: "local-missile",
            });
          }
        } catch (_) { /* never block the swing on prediction faults */ }
        sessionHandle.missileAttack(targetGuid, safeHeight, slider);
        if (localGuid !== 0) {
          if (finalMotion && typeof em?.setSwingMotion === "function") {
            em.setSwingMotion(localGuid, finalMotion);
            // F6-2 — suppress the server's matching swing echo.
            em.noteLocalSwingPrediction?.(finalMotion);
          } else {
            em?.setSwingPose?.(localGuid);
          }
        }
      });
      if (chargeEnabled && dist > MISSILE_RANGE_M) {
        // Wave 4 / Phase 4.2 — pass `finalMotion` (the aim-level /
        // CMT-picked missile motion) as the windup so the local
        // player holds at peak windup during the pursuit. Released
        // at arrival just before the real swing fires.
        startCharge(targetGuid, MISSILE_RANGE_M, fire, finalMotion);
      } else {
        // F7-3 — in range: face the target first (flag-gated), then fire.
        // The out-of-range charge path above already turns during pursuit.
        turnToFaceThenAct(targetGuid, fire, MISSILE_FACE_TARGET);
      }
      return;
    }
    if (inMelee && typeof sessionHandle.attack === "function") {
      console.log(`[fire-attack] melee height=${safeHeight} target=0x${targetGuid.toString(16)} slider=${slider.toFixed(2)} dist=${dist.toFixed(2)}m (range=${MELEE_RANGE_M}m)`);
      const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
      // CombatManeuverTable lookup — picks the retail MotionCommand for
      // (stance, height, type, powerLevel). Used for diag observability
      // today; full motion playback (entityManager.setSwingMotion) is
      // deferred. setSwingPose remains the visual fallback so the local
      // player still swings something. If the entity manager later
      // exposes setSwingMotion(guid, motionCmd), gate on it
      // preferentially.
      //
      // Wave 1 Phase 3 (2026-05-26): AttackType comes from the equipped
      // weapon via `ui/ac_attack_type_for_weapon.js`. Unarmed →
      // `Punch`, melee weapon / two-handed → `Slash`, ranged / caster
      // / shield-only / unmapped → `Undef = 0` and we fall back to the
      // `ATTACK_TYPE_SLASH` constant so combat still works while the
      // inference is widened (Wave 2 Phases 4/5/6).
      const stance = (window.__getCurrentStanceLow?.() ?? 0) >>> 0;
      const em = liveScene3d.entityManager;
      const weapon = em?.getEquippedWeapon?.(localGuid) ?? null;
      // CMT Wave 8 / Phase 23 (2026-05-26): pass `powerLevel` + `isDualWield`
      // so `inferAttackTypeForWeapon` can return `Kick = 0x08` for
      // unarmed at high power, matching ACE `Player_Melee.cs:462`:
      //     AttackType = PowerLevel > KickThreshold && !IsDualWieldAttack
      //         ? AttackType.Kick : AttackType.Punch;
      // Phase 21 extended the helper signature; this is the wiring.
      // Missile/magic branches stay one-arg per their phase ownership.
      const inferredType = inferAttackTypeForWeapon(weapon, {
        powerLevel: slider,
        isDualWield: em?.isDualWield?.(localGuid) ?? false,
      });
      const attackType = (inferredType === ATTACK_TYPE.Undef)
        ? ATTACK_TYPE_SLASH
        : inferredType;
      // Wave 2 Phase 4: feed `prevMeleeMotion` to the CMT picker so the
      // signature matches the ACE port in ac_combat_maneuver.js (the
      // arg is forward-compat for the retail alternation path; the
      // active picker uses power-bar threshold per ACE Player_Melee.cs).
      const motionCmd = getCombatManeuver(stance, safeHeight, attackType, slider, prevMeleeMotion);
      if (motionCmd) prevMeleeMotion = (motionCmd >>> 0);
      // F10-3 — resolve the actual swing-clip length so the power meter can
      // track the real swing cadence instead of the pure-power heuristic
      // (which drifts at most power settings). Uses the same typed
      // motion-link lookup the rig drives its pose from; 0 when the MT isn't
      // cached yet → the meter keeps its heuristic. Consumed only under
      // `?powerMeterSwingDuration=on` (the meter reads ev.detail).
      let swingDurationMs = 0;
      try {
        const lp = em?.entityMap?.get?.(localGuid >>> 0);
        const mtableId = (lp?.meta?.mtableId ?? 0) >>> 0;
        const typed = window.__classifyMotionCommandTyped?.(mtableId, stance, motionCmd >>> 0);
        if (typed && typed.durationSec > 0) {
          swingDurationMs = Math.round(typed.durationSec * 1000);
        }
      } catch (_) { /* meter falls back to its heuristic */ }
      const fire = () => fireOnce(() => {
        // Wave 5 / Phase 9 (2026-05-26) — Sneak Attack prediction. Re-
        // sample target position + defender heading at the actual fire
        // tick (the outer-scope `pose` / `targetAc` are stale after a
        // charge-pursuit). Emit `sneakAttackPredicted` exactly once
        // per swing when the attacker is in the defender's 90° rear
        // hemisphere — matches ACE `Creature_Combat.cs:763`. Pure UI
        // signal; the wire payload to `attack` is unchanged.
        try {
          const firePose = playerWorldPose(sessionHandle);
          const fireTargetPos = entityAcPosition(em, targetGuid);
          const targetHeadingRad = em?.getHeading?.(targetGuid) ?? null;
          if (
            firePose && fireTargetPos && targetHeadingRad != null &&
            isAttackerBehindDefender({
              attackerPose: firePose,
              defenderPose: fireTargetPos,
              defenderHeadingRad: targetHeadingRad,
            })
          ) {
            window.__pluginClient?.events?.emit?.("sneakAttackPredicted", {
              attackerGuid: localGuid,
              defenderGuid: targetGuid,
              attackType,
              scope: "local",
            });
          }
        } catch (_) { /* never block the swing on prediction faults */ }
        sessionHandle.attack(targetGuid, safeHeight, slider);
        // FU-3 — under ?serverSwing=on, no optimistic swing: the server's
        // post-MoveTo motion echo animates the local rig at arrival.
        if (localGuid !== 0 && !SERVER_SWING) {
          if (motionCmd && typeof em?.setSwingMotion === "function") {
            em.setSwingMotion(localGuid, motionCmd);
            // F6-2 — suppress the server's matching swing echo so it
            // doesn't double-play / restart this optimistic swing.
            em.noteLocalSwingPrediction?.(motionCmd);
          } else {
            em?.setSwingPose?.(localGuid);
          }
        }
      }, { swingDurationMs });
      // F6-5 — gate on the cylinder distance under `?melee3dRange=on` so a
      // target the flat 2D check thought was in reach (but is on a ledge /
      // raised platform) instead engages the charge: run cycle + steering
      // pursue it rather than firing an in-place swing the server then
      // services with an invisible force-position walk. Flat horizontal
      // (== pre-F6-5) when off.
      const meleeDist = meleeGateDistance(pose, targetAc);
      if (chargeEnabled && meleeDist > MELEE_RANGE_M) {
        // Wave 4 / Phase 4.2 — pass the CMT-picked melee motion as
        // the windup so the local player holds at peak windup during
        // the pursuit. Released at arrival just before the real
        // swing fires.
        startCharge(targetGuid, MELEE_RANGE_M, fire, motionCmd, MELEE_3D_RANGE /* cylinderReach */);
      } else {
        fire();
      }
      return;
    }
    console.log(`[fire-attack] not in melee/missile stance — currentStanceLow=0x${(window.__getCurrentStanceLow?.() ?? 0).toString(16)}`);
    emitActionRejected("You are not in melee or missile combat mode."); // F11-5
  }

  // Expose for combat-bar.js's Hi/Med/Lo height-button click handlers.
  // Namespace prefix matches `window.__combatBarState` / `__pluginClient`.
  if (typeof window !== "undefined") {
    window.__fireAttackOnTarget = fireAttackOnSelectedTarget;
    // PR-LL 2026-05-23: expose pickEntityAt so plugins (e.g. inventory
    // drag-drop onto an NPC for GiveObject) can do hit-testing without
    // re-implementing the raycast against entity roots. Returns the
    // entity GUID (u32) or null if no entity is under the cursor.
    window.__pickEntityAt = pickEntityAt;
  }

  // Phase I.1 follow-on (handoff Tier 1): manual-input override.
  // Any movement key during an active charge aborts the auto-pursue
  // and hands control back to the player. Pre-fix the rAF loop
  // would re-issue `setMovementInput(forward=1, turn=±1)` every
  // frame, racing the keystate-driven movement and producing a
  // "tug of war" — see handoff Tier 1 #4. Now any of WASD, Q/E,
  // or Shift cancels the charge cleanly.
  const ABORT_KEYS = new Set([
    "w", "a", "s", "d", "q", "e", "shift",
    "arrowup", "arrowdown", "arrowleft", "arrowright",
  ]);
  function onKeyDownAbortCharge(ev) {
    const k = (ev.key || "").toLowerCase();
    if (!ABORT_KEYS.has(k)) return;
    // Don't kill the charge / attack if the user is typing in a form
    // (chat input, login fields).
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (charge) cancelCharge();
    // F6-4 — moving stops the server-side attack loop (retail). ACE
    // defaults AutoRepeatAttacks ON, so a single attack otherwise keeps
    // the player swinging — a fleeing player would be sticky-rotated and
    // re-attacked by their own loop. Fire CancelAttack when a real
    // movement key is pressed (not the bare Shift modifier) while an
    // attack is active / we're in a combat stance. Skip the keydown
    // auto-repeat and throttle so a held key sends at most one per 500ms.
    if (k === "shift") return;
    const cb = (typeof window !== "undefined") ? window.__combatBarState : null;
    const inCombatStance = !!(isInMeleeStance?.() || isInRangedStance?.());
    const attackActive = !!(cb && cb.attackInProgress) || inCombatStance;
    if (!attackActive || ev.repeat) return;
    if (typeof sessionHandle.cancelAttack !== "function") return;
    const nowMs = (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
    if (nowMs - lastCancelAttackMs < 500) return;
    lastCancelAttackMs = nowMs;
    try {
      sessionHandle.cancelAttack();
      if (cb) cb.attackInProgress = false;
    } catch (e) {
      console.warn(`[picking] cancelAttack: ${e?.message ?? e}`);
    }
  }
  document.addEventListener("keydown", onKeyDownAbortCharge);

  // F6-4 — also stop the server attack loop when the target is cleared
  // (explicit deselect, or the target despawning mid-fight). ACE already
  // ends the loop on target death, so this is mostly belt-and-suspenders
  // for the explicit-deselect case; throttled + combat-stance-gated so it
  // doesn't send pointless cancels in peace.
  let onSelectionCleared = null;
  const bus = (typeof window !== "undefined") ? window.__pluginClient?.events : null;
  if (bus && typeof bus.on === "function") {
    onSelectionCleared = (ev) => {
      if (((ev?.guid >>> 0) || 0) !== 0) return; // only on clear
      if (!(isInMeleeStance?.() || isInRangedStance?.())) return;
      if (typeof sessionHandle.cancelAttack !== "function") return;
      const nowMs = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      if (nowMs - lastCancelAttackMs < 500) return;
      lastCancelAttackMs = nowMs;
      try { sessionHandle.cancelAttack(); } catch (_) {}
    };
    try { bus.on("selectionChanged", onSelectionCleared); } catch (_) {}
  }

  return {
    destroy() {
      // Stop any in-flight charge: cancels the rAF chargeTick loop,
      // zeroes movement input, and releases a held windup pose. Without
      // this, destroy() left the pursuit rAF running (and the player
      // walking) after the picking subsystem was torn down.
      cancelCharge();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("dragover", onCanvasDragOver);
      canvas.removeEventListener("drop", onCanvasDrop);
      document.removeEventListener("keydown", onKeyDownAbortCharge);
      if (onSelectionCleared && bus && typeof bus.off === "function") {
        try { bus.off("selectionChanged", onSelectionCleared); } catch (_) {}
      }
    },
  };
}
