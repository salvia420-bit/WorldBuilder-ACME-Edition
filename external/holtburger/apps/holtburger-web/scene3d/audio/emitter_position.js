// audio-2 (2026-10-08 round 2) — where a sound on an entity is played from.
//
// Retail plays every sound hook and server sound at the object's own
// m_position (SoundHook / SoundTableHook / SoundTweakedHook::Execute →
// SoundManager::PlaySoundA(.., physobj) → `&physobj->m_position`, acclient.c:
// 342188-342221 / 383481 / 383697). A wielded object's m_position is a WORLD
// frame at the wielder's hand: CPhysicsObj::set_parent (:323003-323027) →
// UpdateChild (:320039-320056) = Frame::combine(holding part frame, child
// frame) → set_frame. holtburger re-parents a wielded rig's root under the
// wielder's part node (entities.js `attachChildToParent`), so its
// `root.position` is HAND-LOCAL (a few cm). Read as a world position it put
// the emitter near the map origin, kilometres from the listener, and
// GetAttenuation culled it below -50 dB: item-enchant chimes, SoundTable
// hooks and 0xF750 sounds on a weapon / shield / wand were silent.
//
// `emitterPosThree` returns the emitter in the three.js frame the
// AudioContext listener lives in (index.js setListener feeds camera.position):
//   - a top-level rig: acToThree(root.position) = (x, z, -y), as before;
//   - an attached rig: the scene graph's world translation, which already
//     carries the hand part transform and worldRoot's -π/2 X rotation.
// Pure (no THREE import): it only calls Object3D methods on the rig.
// `?attachedSoundPos=off` (or 0/false) restores the raw hand-local read.

// Callers convert back to the AC frame for their event-log `world_pos`.
export { threeToAc } from "./retail_mixer.js";

/** @param {string} search a `location.search` string */
export function readAttachedSoundPosFlag(search) {
  try {
    const v = (new URLSearchParams(search || "").get("attachedSoundPos") ?? "").toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) {
    return true;
  }
}

export const ATTACHED_SOUND_POS_ON = readAttachedSoundPosFlag(
  (typeof window !== "undefined" && window.location) ? window.location.search : "",
);

function sceneRooted(obj) {
  let n = obj;
  for (let i = 0; i < 64 && n.parent; i++) n = n.parent;
  return n.isScene === true;
}

/**
 * The emitter position of `inst` (an EntityManager record, or any
 * `{root, _attachedParentGuid?}`) in the three.js listener frame, or null
 * when it has no root. An attached rig is detected by `_attachedParentGuid`
 * or the root's EQUIP-3 mount brand (`userData.__attachedChildOf`). If its
 * root is not in the scene (mid re-park) the wielder's own position (from
 * `entityMap`) stands in; with neither, null.
 *
 * @param {object|null} inst
 * @param {Map<number, object>|null} [entityMap] guid → record, for the fallback
 * @param {boolean} [on] defaults to `?attachedSoundPos` (on)
 * @returns {{x:number, y:number, z:number}|null}
 */
export function emitterPosThree(inst, entityMap, on = ATTACHED_SOUND_POS_ON) {
  const root = inst?.root;
  const p = root?.position;
  if (!p) return null;
  const parentGuid = inst._attachedParentGuid ?? root.userData?.__attachedChildOf ?? null;
  if (!on || parentGuid == null) return { x: p.x, y: p.z, z: -p.y };
  if (typeof root.updateWorldMatrix === "function" && root.matrixWorld && sceneRooted(root)) {
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    return { x: e[12], y: e[13], z: e[14] };
  }
  const w = entityMap?.get?.(parentGuid >>> 0);
  const wp = w?.root?.position;
  if (wp && w._attachedParentGuid == null) return { x: wp.x, y: wp.z, z: -wp.y };
  return null;
}
