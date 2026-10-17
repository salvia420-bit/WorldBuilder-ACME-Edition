// scene3d/vfx/portal_registry.js — the static portal decorations the portal set
// piece (vfx/fx_showcase.js, `?portalSetPiece`) draws besides the portal
// entities: statics.js registers each static default-script anchor whose
// placement is a portal Setup (vfx/portal_setups.js). A dependency-free module
// so the statics bake does not pull the FX stack in.
//
// anchor (THREE.Object3D in staticsGroup) → Setup id. A detached anchor
// (evicted, or parked by the warm-park pool — the unpark seam registers it
// again) is dropped by the set piece's next scan.

import { PORTAL_SETUPS } from "./portal_setups.js";

const _staticPortals = new Map();

/** Register a static portal anchor; false when the Setup is not a portal. */
export function registerStaticPortalAnchor(anchor, setupId) {
  const sid = setupId >>> 0;
  if (!anchor || !PORTAL_SETUPS.has(sid)) return false;
  _staticPortals.set(anchor, sid);
  return true;
}

export function unregisterStaticPortalAnchor(anchor) {
  return _staticPortals.delete(anchor);
}

/** The live map (the set piece iterates it and prunes detached anchors). */
export function staticPortalAnchors() {
  return _staticPortals;
}

/** Test seam. */
export function _resetStaticPortalsForTest() {
  _staticPortals.clear();
}
