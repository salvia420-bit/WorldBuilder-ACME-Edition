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

let _windGpu;
/** `?treeWindGpu=off` — GPU INSTANCED tree/foliage wind sway. DEFAULT-ON
 *  (2026-06-29). This is the cheap replacement for the MECH-A `windGeo` peel:
 *  instead of de-instancing ~4096 trees into ~17k CPU-driven meshes (1 fps on a
 *  GTX 1070), it keeps them frozen+instanced and bends each in the VERTEX shader
 *  (deformation.windSwayGpu, MECH-B) on the SHARED material clone — one draw call,
 *  one program, ~free. frag_attach injects it for every windResponds() DID (the
 *  exact set the old default-on peel animated), so the same ~4100 trees sway.
 *
 *  MUTUAL EXCLUSION: when the user opts into a CPU peel path (?treeWind or
 *  ?windGeo), THAT path owns the sway and the GPU path stands down (no double
 *  bend). `?treeWindGpu=off` disables the GPU path entirely (trees freeze, the
 *  retail-faithful look); `?visual=off` (the suite master) also disables it since
 *  the frag seam is gated on visualEnabled(). */
export function windSwayGpuEnabled() {
  if (_windGpu !== undefined) return _windGpu;
  // CPU peel paths own the sway when explicitly requested → GPU path stands down.
  if (treeWindEnabled() || windGeoEnabled()) return (_windGpu = false);
  let on = true; // default-on; `?treeWindGpu=off` is the escape to frozen trees
  const v = _strFlag("treeWindGpu");
  if (v != null) { const s = v.toLowerCase(); on = s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== ""; }
  return (_windGpu = on);
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
  _windGeo = undefined; _windGpu = undefined;
}
