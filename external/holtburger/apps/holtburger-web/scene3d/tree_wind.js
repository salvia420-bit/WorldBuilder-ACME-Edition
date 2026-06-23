// Tree wind-sway — flag gate + tree-DID allowlist (Phase 1, 2026-06-23).
//
// Makes AC scenery trees/foliage sway in wind. This is a NON-RETAIL
// enhancement (retail AC trees are frozen), so it ships DEFAULT-OFF behind
// `?treeWind=on`. When off, the statics.js divert never runs and the frozen
// instanced path is byte-identical to today.
//
// Import-cycle-safe: this module imports NOTHING from the scene3d graph.
//   statics.js          imports { treeWindEnabled, isTreeDid }  from here
//                       + { attachWindTrees }                   from animated_scenery.js
//   animated_scenery.js imports { treeWindEnabled, treeWindStrength, treeWindDir } from here
//   wind_rig.js         imports nothing (pure math)
// No back-edges → no static import cycle.

function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}

function _numFlag(name, def, min, max) {
  const v = _strFlag(name);
  const n = v == null ? NaN : parseFloat(v);
  if (Number.isFinite(n) && (min == null || n >= min) && (max == null || n <= max)) return n;
  return def;
}

let _flag;
/** `?treeWind=on` enables wind sway. DEFAULT-OFF (non-retail enhancement). */
export function treeWindEnabled() {
  if (_flag !== undefined) return _flag;
  let on = false;
  const v = _strFlag("treeWind");
  if (v != null) {
    const s = v.toLowerCase();
    on = s === "on" || s === "1" || s === "true" || s === "yes";
  }
  return (_flag = on);
}

let _strength;
/** `?treeWindStrength` — global amplitude multiplier (default 1.0, clamp 0..4). */
export function treeWindStrength() {
  if (_strength === undefined) _strength = _numFlag("treeWindStrength", 1.0, 0, 4);
  return _strength;
}

let _dirDeg;
/** `?treeWindDir` — wind azimuth in degrees (default 135 = SE). */
export function treeWindDir() {
  if (_dirDeg === undefined) _dirDeg = _numFlag("treeWindDir", 135, -360, 360);
  return _dirDeg;
}

// Phase-1 allowlist of scenery SetupModel DIDs to animate. Seeded from the
// verified top-placement foliage/trees (client_portal.dat survey 2026-06-23).
// The bbox base-pivot rig (wind_rig.js) pivots each part about its own vertex
// Zmin (NEVER the model origin), so both short foliage and tall trees are safe
// — and they only animate when ?treeWind=on, a deliberate opt-in test. This is
// an auditable git-diff seed; an offline classifier can regenerate it later.
const TREE_WIND_DIDS = new Set([
  0x02001063, // fern ~1.25m, 3-part billboard cluster, 317k placements (#1)
  0x02001064, // fern cluster, 6-part, 105k
  0x020007a2, // shrub ~0.7m, 6-part, 236k
  0x02000246, // small tree, 5-part, 232k
  0x02000258, // tall tree ~22m (trunk + branch + canopy parts)
  0x0200035f, // tree, 11-part
]);

/** True if this SetupModel DID is on the wind allowlist. */
export function isTreeDid(id) {
  return TREE_WIND_DIDS.has((id >>> 0));
}

/** The raw allowlist Set (diag / tests). */
export function treeWindDids() {
  return TREE_WIND_DIDS;
}

/** Reset memoized flag readers (tests only). */
export function _resetTreeWindFlags() {
  _flag = undefined; _strength = undefined; _dirDeg = undefined;
}
