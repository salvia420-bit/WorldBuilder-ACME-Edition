import * as THREE from "three";
import { getCombatManeuver, loadCombatManeuverTable } from "../ui/ac_combat_maneuver.js";
import {
  ATTACK_TYPE,
  inferAttackTypeForWeapon,
} from "../ui/ac_attack_type_for_weapon.js";
import { getAimLevelForVelocity, getAimLevelForBallisticArc } from "../ui/ac_aim_level_for_velocity.js";
import { isAttackerBehindDefender } from "../ui/ac_sneak_attack_predict.js";

const ATTACK_HEIGHT_MEDIUM = 2;
const ATTACK_POWER_FULL = 1.0;

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

  function cancelCharge() {
    if (!charge) return;
    if (charge.rafId) cancelAnimationFrame(charge.rafId);
    try {
      sessionHandle.setMovementInput?.(0, 0, 0, false);
    } catch {}
    charge = null;
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

    const dist = horizontalDistance(targetAc, pose);
    if (dist <= charge.range) {
      // In range — stop, fire attack, clear state.
      try { sessionHandle.setMovementInput(0, 0, 0, false); } catch {}
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

  function startCharge(guid, range, fireAttack) {
    cancelCharge();
    charge = {
      guid: guid >>> 0,
      range,
      fireAttack,
      startMs: performance.now(),
      rafId: 0,
    };
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
    const hits = raycaster.intersectObjects(roots, true);
    if (hits.length === 0) return null;
    let obj = hits[0].object;
    while (obj && !guidByRoot.has(obj)) obj = obj.parent;
    return obj ? guidByRoot.get(obj) : null;
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
          sessionHandle.castTargetedSpell(guid, spellId);
        }
      } else if (isInMeleeStance?.() || isInRangedStance?.()) {
        // Retail UX — click on the monster only TARGETS it. Firing
        // happens via the combat-bar Hi/Med/Lo buttons (which call
        // `window.__fireAttackOnTarget(height)` below). Lets the
        // player swap heights mid-fight (helmet knocked off → Hi for
        // crit) without re-clicking the monster.
        // `setSelectedTarget` already fired above; nothing more to do.
      } else if (typeof sessionHandle.useObject === "function") {
        cancelCharge();
        sessionHandle.useObject(guid);
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
      return;
    }
    const cb = window.__combatBarState;
    const safeHeight = Number.isFinite(height) ? height : (cb?.attackHeight ?? ATTACK_HEIGHT_MEDIUM);
    const slider =
      cb && typeof cb.powerLevel === "number" ? cb.powerLevel : ATTACK_POWER_FULL;
    const attackPending = !!cb?.attackInProgress;
    const fireOnce = (cmd) => {
      if (attackPending) {
        console.log("[fire-attack] attack still pending (server hasn't sent attackDone) — gated");
        return false;
      }
      cmd();
      if (cb) cb.attackInProgress = true;
      try {
        window.__pluginClient?.events?.emit?.("combatCommenceAttack", {});
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
      // Wave 8 / Phase 25 (2026-05-26): `projectileSpeed` is now
      // per-weapon — sourced from PropertyFloat::MaximumVelocity = 26
      // off the wielded missile launcher. Surfaces via
      // `EquippedWeaponJs.maximumVelocity` / `InventoryItem
      // .maximumVelocity` (lib.rs), threaded through
      // `getEquippedWeapon` in entities.js. `BOW_DEFAULT_SPEED_MPS =
      // 20.0` remains the explicit fallback for pre-property arrivals
      // (matches ACE `Creature_Missile.cs:208 DefaultProjectileSpeed`).
      const projectileSpeed = (weapon && Number.isFinite(weapon.maximumVelocity))
        ? weapon.maximumVelocity
        : BOW_DEFAULT_SPEED_MPS;
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
          } else {
            em?.setSwingPose?.(localGuid);
          }
        }
      });
      if (chargeEnabled && dist > MISSILE_RANGE_M) {
        startCharge(targetGuid, MISSILE_RANGE_M, fire);
      } else {
        fire();
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
        if (localGuid !== 0) {
          if (motionCmd && typeof em?.setSwingMotion === "function") {
            em.setSwingMotion(localGuid, motionCmd);
          } else {
            em?.setSwingPose?.(localGuid);
          }
        }
      });
      if (chargeEnabled && dist > MELEE_RANGE_M) {
        startCharge(targetGuid, MELEE_RANGE_M, fire);
      } else {
        fire();
      }
      return;
    }
    console.log(`[fire-attack] not in melee/missile stance — currentStanceLow=0x${(window.__getCurrentStanceLow?.() ?? 0).toString(16)}`);
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
    if (!charge) return;
    const k = (ev.key || "").toLowerCase();
    if (!ABORT_KEYS.has(k)) return;
    // Don't kill the charge if the user is typing in a form
    // (chat input, login fields).
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    cancelCharge();
  }
  document.addEventListener("keydown", onKeyDownAbortCharge);

  return {
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("dragover", onCanvasDragOver);
      canvas.removeEventListener("drop", onCanvasDrop);
      document.removeEventListener("keydown", onKeyDownAbortCharge);
    },
  };
}
