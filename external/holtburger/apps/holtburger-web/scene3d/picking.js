import * as THREE from "three";

const ATTACK_HEIGHT_MEDIUM = 2;
const ATTACK_POWER_FULL = 1.0;

export function setupClickPicking({
  canvas,
  liveScene3d,
  sessionHandle,
  isInMeleeStance,
  getLocalPlayerGuid,
}) {
  if (!canvas || !liveScene3d || !sessionHandle) {
    return { destroy() {} };
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

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
      if (isInMeleeStance?.() && typeof sessionHandle.attack === "function") {
        // Phase D — read attack parameters from the combat-bar plugin
        // when present, fall back to the Phase C defaults otherwise.
        const cb = window.__combatBarState;
        const height =
          cb && typeof cb.attackHeight === "number"
            ? cb.attackHeight
            : ATTACK_HEIGHT_MEDIUM;
        const power =
          cb && typeof cb.powerLevel === "number"
            ? cb.powerLevel
            : ATTACK_POWER_FULL;
        sessionHandle.attack(guid, height, power);
        // Local-player swing pose for immediate visual feedback.
        // ACE owns the actual swing motion + damage; this is just
        // the click → "I did something" affordance.
        const localGuid = (getLocalPlayerGuid?.() ?? 0) >>> 0;
        if (localGuid !== 0) {
          liveScene3d.entityManager?.setSwingPose?.(localGuid);
        }
      } else if (typeof sessionHandle.useObject === "function") {
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
