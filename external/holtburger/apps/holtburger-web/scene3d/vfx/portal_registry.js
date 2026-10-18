// scene3d/vfx/portal_registry.js — the static portal decorations the portal set
// piece (vfx/fx_showcase.js, `?portalSetPiece`) draws besides the portal
// entities: statics.js registers each static default-script anchor whose
// placement is a portal Setup (vfx/portal_setups.js). A dependency-free module
// so the statics bake does not pull the FX stack in.
//
// anchor (THREE.Object3D in staticsGroup) → Setup id. A detached anchor
// (evicted, or parked by the warm-park pool — the unpark seam registers it
// again) is dropped by the set piece's next scan, and by the registration sweep
// below.

import { PORTAL_SETUPS } from "./portal_setups.js";

const _staticPortals = new Map();

// The set piece's scan only runs with fxShowcase on and `?portalSetPiece` on.
// Without it (the low preset, either `=off`) every LRU re-bake added fresh
// anchors and pinned the evicted ones for the session, so registration also
// drops detached anchors, whenever the map has doubled since the last sweep.
const SWEEP_MIN = 64;
let _sweepAt = SWEEP_MIN;

/** Register a static portal anchor; false when the Setup is not a portal. */
export function registerStaticPortalAnchor(anchor, setupId) {
  const sid = setupId >>> 0;
  if (!anchor || !PORTAL_SETUPS.has(sid)) return false;
  _staticPortals.set(anchor, sid);
  if (_staticPortals.size >= _sweepAt) {
    for (const a of _staticPortals.keys()) if (!a.parent) _staticPortals.delete(a);
    _sweepAt = Math.max(SWEEP_MIN, _staticPortals.size * 2);
  }
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
  _sweepAt = SWEEP_MIN;
}
