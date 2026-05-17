import * as THREE from "three";

const ATTACK_HEIGHT_MEDIUM = 2;
const ATTACK_POWER_FULL = 1.0;

// Phase I.1 — charge-attack tuning. Retail melee range is ~2.5m, missile
// range varies by weapon (we approximate at 25m). These constants
// drive both the "in range now" gate and the auto-pursue stop condition.
const MELEE_RANGE_M = 2.5;
const MISSILE_RANGE_M = 25.0;
const MAX_CHARGE_DURATION_MS = 10_000; // safety net so we don't pursue forever

// Convert a Three.js entity position back to AC coords so we can compare
// to the local player's pose (which is in AC coords from the wasm side).
// Inverse of scene3d/adapter.js::acToThree(ax,ay,az) = [ax, az, -ay].
function threeToAc(tx, ty, tz) {
  return { x: tx, y: -tz, z: ty };
}

function entityAcPosition(entityManager, guid) {
  const inst = entityManager?.entityMap?.get((guid >>> 0));
  if (!inst?.root?.position) return null;
  const p = inst.root.position;
  return threeToAc(p.x, p.y, p.z);
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
  const ndc = new THREE.Vector2();

  // Phase I.1 — charge-attack state machine. One pursuit in flight at
  // a time; clicking a different target replaces the current charge.
  let charge = null; // { guid, range, fireAttack, startMs, rafId }

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

    // Read target + player positions in AC coords.
    const targetAc = entityAcPosition(liveScene3d.entityManager, charge.guid);
    const pose = sessionHandle.getLocalPlayerPose?.();
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

    // Compute bearing from player to target; turn proportionally.
    const dx = targetAc.x - pose.x;
    const dy = targetAc.y - pose.y;
    const bearing = Math.atan2(dy, dx);
    const turnDelta = normalizeAngle(bearing - pose.heading);
    let turn = 0;
    if (Math.abs(turnDelta) > 0.05) turn = turnDelta > 0 ? 1 : -1;
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

    const em = liveScene3d.entityManager;
    if (!em || !em.entityMap) return null;
    const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;

    const roots = [];
    const guidByRoot = new Map();
    for (const [guid, inst] of em.entityMap) {
      const g = guid >>> 0;
      if (g === localGuid) continue;
      if (!inst || !inst.root) continue;
      roots.push(inst.root);
      guidByRoot.set(inst.root, g);
    }
    if (roots.length === 0) return null;

    const hits = raycaster.intersectObjects(roots, true);
    if (hits.length === 0) return null;
    let obj = hits[0].object;
    while (obj && !guidByRoot.has(obj)) obj = obj.parent;
    return obj ? guidByRoot.get(obj) : null;
  }

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const guid = pickEntityAt(ev.clientX, ev.clientY);
    if (guid == null) return;
    ev.stopPropagation();
    ev.preventDefault();
    // Phase D — mark the clicked entity as the current target so
    // subsequent clicks (or the future combat-bar HUD) can read it.
    // Selection persists until another entity is picked.
    liveScene3d.entityManager?.setSelectedTarget?.(guid);
    try {
      // Phase D — read attack parameters from the combat-bar plugin
      // when present, fall back to the Phase C defaults otherwise.
      // (The melee `powerLevel` doubles as the missile `accuracyLevel`
      // since the retail combat-bar slider serves both roles — its
      // label flips Power ↔ Accuracy based on stance.)
      const cb = window.__combatBarState;
      const height =
        cb && typeof cb.attackHeight === "number"
          ? cb.attackHeight
          : ATTACK_HEIGHT_MEDIUM;
      const slider =
        cb && typeof cb.powerLevel === "number"
          ? cb.powerLevel
          : ATTACK_POWER_FULL;
      // Phase I.1 — chargeAttack option toggle (default on).
      const chargeEnabled = cb?.chargeAttack !== false;

      if (isInMagicStance?.() && typeof sessionHandle.castTargetedSpell === "function") {
        // Magic doesn't auto-charge — caster stands still to cast.
        const spellId =
          cb && typeof cb.armedSpellId === "number" && cb.armedSpellId > 0
            ? cb.armedSpellId
            : 0;
        if (spellId !== 0) {
          sessionHandle.castTargetedSpell(guid, spellId);
        }
      } else if (isInRangedStance?.() && typeof sessionHandle.missileAttack === "function") {
        // Phase I.1 — charge to missile range (~25m) then fire.
        const fire = () => sessionHandle.missileAttack(guid, height, slider);
        const pose = sessionHandle.getLocalPlayerPose?.();
        const targetAc = entityAcPosition(liveScene3d.entityManager, guid);
        if (chargeEnabled && pose && targetAc && horizontalDistance(pose, targetAc) > MISSILE_RANGE_M) {
          startCharge(guid, MISSILE_RANGE_M, fire);
        } else {
          fire();
        }
      } else if (isInMeleeStance?.() && typeof sessionHandle.attack === "function") {
        // Phase I.1 — charge to melee range (~2.5m) then swing.
        const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
        const fire = () => {
          sessionHandle.attack(guid, height, slider);
          if (localGuid !== 0) {
            liveScene3d.entityManager?.setSwingPose?.(localGuid);
          }
        };
        const pose = sessionHandle.getLocalPlayerPose?.();
        const targetAc = entityAcPosition(liveScene3d.entityManager, guid);
        if (chargeEnabled && pose && targetAc && horizontalDistance(pose, targetAc) > MELEE_RANGE_M) {
          startCharge(guid, MELEE_RANGE_M, fire);
        } else {
          fire();
        }
      } else if (typeof sessionHandle.useObject === "function") {
        cancelCharge();
        sessionHandle.useObject(guid);
      }
    } catch (e) {
      console.warn(`[picking] click(0x${guid.toString(16)}): ${e?.message ?? e}`);
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown);

  return {
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
