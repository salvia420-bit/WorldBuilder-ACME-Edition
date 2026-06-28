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

let _windBake;
/** `?windBake=on/off` — consume baked dist/suite windclips instead of synthesizing.
 *  DEFAULT-ON (2026-06-26); `?windBake=off` reverts to live synthesis. Baked frames
 *  are bit-identical to synth (proven), so the steady-state render is unchanged; only
 *  the brief cold-load (frozen until the async fetch warms) and the dir/strength-inert
 *  (baked-authoritative) behavior differ. [C] — owes the batched 1070 eye-test. */
export function windBakeEnabled() {
  if (_windBake !== undefined) return _windBake;
  let on = true; // default-on; `?windBake=off` is the escape to live synthesis
  const v = _strFlag("windBake");
  if (v != null) { const s = v.toLowerCase(); on = s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== ""; }
  return (_windBake = on);
}

let _windGeo;
/** `?windGeo=on` — let the VISUAL suite peel wind-responsive foliage out of the
 *  frozen InstancedMesh path and rebuild it as individual animated wind nodes.
 *  DEFAULT-OFF (2026-06-27). It was previously coupled to `visualEnabled()` (default-ON),
 *  which de-instanced ~4096 trees at Holtburg into ~17k individual meshes — measured on
 *  a real GTX 1070 as 1 fps / 968 ms CPU per frame; re-freezing to instanced restored
 *  12 fps / 47 ms CPU (8x faster, 20x less CPU). Default-OFF keeps trees frozen+instanced
 *  (retail-faithful — retail trees are frozen) and fast; `?treeWind=on` OR `?windGeo=on`
 *  opt back into the animated (slow) peel. The frag-VFX suite (emissive/weathering/
 *  particles) stays ON via `visualEnabled()` regardless. */
export function windGeoEnabled() {
  if (_windGeo !== undefined) return _windGeo;
  let on = false;
  const v = _strFlag("windGeo");
  if (v != null) { const s = v.toLowerCase(); on = s === "on" || s === "1" || s === "true" || s === "yes"; }
  return (_windGeo = on);
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
  _flag = undefined; _strength = undefined; _dirDeg = undefined; _windBake = undefined;
}
