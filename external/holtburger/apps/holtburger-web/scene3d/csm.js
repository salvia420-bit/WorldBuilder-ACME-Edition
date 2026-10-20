// Visual-fidelity Phase 3.3 — hand-rolled Cascaded Shadow Maps (CSM).
//
// Replaces Phase 0.1's single 2048^2 shadow map with three shadow maps
// per directional sun light, each fit to a slice of the camera's view
// frustum. Near cascade (30 m) renders crisp shadows on buildings the
// player is standing next to; mid cascade (100 m) covers the
// neighbourhood; far cascade (300 m) reaches to the horizon for the
// Academy-hilltop-looking-south view.
//
// Architecture: ONE sun light source + THREE shadow-only lights. The
// sun keeps its lighting contribution; its `castShadow` is OFF so three
// doesn't allocate a redundant fourth shadow map. The three cascade
// lights have `intensity = 0` (no diffuse contribution) and
// `castShadow = true` so three's WebGLShadowMap renderer fills their
// shadow maps each frame from the same caster geometry that Phase 0.1
// already wired (`castShadow = true` on building/NPC/static meshes).
// The cascade lights share the sun's direction so the three shadow maps
// project from the same light source.
//
// Shader integration: receiver materials get an `onBeforeCompile` patch
// (see `materials.js#installCsmShaderPatch`) that samples all three
// cascade shadow maps, selects by view-space depth, blends at cascade
// boundaries, and multiplies the sun's diffuse contribution by the
// resulting shadow factor. Ambient + hemisphere remain unshadowed
// (matches Phase 0.1's behaviour — only the directional sun casts).
//
// Per-frame: `updateCsm(csmState, camera)` fits each cascade's orthographic
// shadow camera to the player-visible portion of that cascade range:
//   1. Compute 8 corner points of the camera's perspective sub-frustum
//      between near=splitN and far=splitN+1 in world space.
//   2. Take their centroid and BOUNDING-SPHERE radius.
//   3. Set the cascade's ortho camera to that sphere's bounding square,
//      with near/far bracketing it plus `BACK_DIST_M` of lead-in so casters
//      BEHIND the camera (relative to the light direction) still register.
//
// Texel snapping (anti-shimmer): the sphere radius depends only on
// (fov, aspect, near, far) — never on where the camera looks or stands — so
// each cascade's ortho extents and texel size are CONSTANT. The frustum
// centre is then snapped to whole texels in a light frame anchored at the
// world origin, which stops the texel grid sliding under stationary geometry
// as the player walks or turns.
//
// (Pre-2026-08-03 this fit the AABB of the corners in light space. That AABB
// resized every frame as the camera rotated, so the "texel" it snapped to
// resized with it and the snap stabilised nothing — review finding F3. The
// sphere circumscribes the slice, so extents are ~1.2-1.3× the old tight AABB;
// stability is worth the texels, and it is the standard CSM trade.)
//
// Disabled when `flags.csm` is false — the Phase 0.1 single-shadow
// path stays in effect (low/mid quality presets). The two paths are
// mutually exclusive: when CSM is on, the sun's own shadow is OFF;
// when CSM is off, the sun's shadow is whatever Phase 0.1 set.
//
// STABLE CASCADES (2026-10-20, improvement hunt shadows-restore-1; `setupCsm(…,
// { stable: true })`, which lighting.js passes under `?csmStable`, DEFAULT ON on
// the CSM path, `=off` restores the view-slice fit above). The view-slice fit
// moves with every turn of the camera, so any 1 cm / 1e-3 rad change refit all
// three cascades, which marked every map FRUSTUM and kept shadowStaticCache from
// ever engaging while the player moved or looked around (~12 ms of shadow raster
// on every moving frame, 1070 10-17). Stable mode instead makes cascade i a
// sphere of CONSTANT radius `splits[i] + margins[i]` (5 / 10 / 28 m: today's
// texel size at the default retail fov, 3.4 / 10.7 / 64 cm) about a
// texel-snapped point in the same world-anchored light frame, and refits it only
//   - when the camera has left that cascade's slack zone (the margin, less a
//     2-texel PCF guard) — at a 12 m/s run every ~0.4 / 0.8 / 2.3 s; turning in
//     place or a fov / aspect / zoom change: never;
//   - when the sun has stepped past that cascade's epsilon (?csmSunEps, 1e-3
//     rad; 2e-3 for the far cascade) — staggered, at most one cascade per frame
//     and never on a frame another cascade refits, unless the sun JUMPED (time
//     set, teleport: > 0.02 rad), which refits every stale cascade at once.
// `refitMask` says which cascades moved, so lighting.js re-rasters only those
// (the others overlay their static cache). Receivers must then pick a cascade
// by DISTANCE from the camera, not view depth (a sphere about the camera holds
// every point within splits[i], in any direction, but not the far corners of
// the view slice): the shared `uCsmSelDist` uniform switches materials.js
// _csmShadowFactor and terrain.js csmShadowFactor over (0 = view depth, the
// legacy fit). The cost: the near cascade no longer stretches to 43 m at the
// screen corners — they drop to the mid cascade past 30 m.
//
// SUN FADE + DIRECT-ONLY SHADE (2026-10-20, improvement hunt shadows-restore-5).
// Dereth's sun never sets: the authored pitch bottoms at 0.9 deg for the whole
// 23:02h -> 03:50h block (night_ramp.js header), and the cascades follow that raw
// sun, so all night every caster threw a ~64x-height streak (clipped only by
// BACK_DIST_M) at full strength. Two shared uniforms, written by
// `refreshCsmUniforms` like the rest (no light count, castShadow or program key
// moves at runtime):
//   - `uCsmStrength` = `csmState.strength`, which lighting.js sets each tick to
//     cloud_night.js's directFactor (the sky's art elevation through
//     ?cloudShadowFadeDeg: 1 by day, 0 once the art sun reaches the horizon) under
//     `?csmSunFade` (default on with CSM). Receivers skip the cascade taps while
//     it is 0, and lighting.js's shadow gate stops rastering the cascades then.
//   - `uCsmShade` = `csmState.shade`, how much of the shaded term a FULL shadow
//     removes. The receivers apply `mix(1 - shade * strength, 1, s)`.
// Where that factor lands is `csmState.directOnly` (`setupCsm(…, { directOnly:
// true })`, lighting.js `?csmDirectOnly`, default on with CSM): on the SUN's
// direct term only (materials.js: every directional light's colour in the light
// loop — the cascade lights are colour 0 —, terrain.js: the sun term inside the
// retail Gouraud), so emissive windows, baked cell light, IBL / the sky probe and
// fog keep their authored values in shade. Its shade defaults to 1 (a shadow
// blocks the direct sun; the old 0.45 floor only existed because the multiply
// also hit the ambient). Without `directOnly` (direct callers, `=off`) the legacy
// whole-colour multiply stays at shade 0.55 — at strength 1 that is the old
// `mix(0.45, 1.0, s)` bit for bit.
//
// DEPTH FIT + TEXEL BIAS (2026-10-20, improvement hunt shadows-restore-7;
// `setupCsm(…, { depthFit: true })`, which lighting.js passes under `?csmBias`,
// DEFAULT ON on the CSM path, `=legacy` / `=off` restores the fixed range and
// bias). Both were sized once and applied to all three cascades:
//   - DEPTH RANGE. Each cascade's light sat BACK_DIST_M (200 m) sunward of its
//     centre with far = 2 * BACK_DIST_M + radius, so the last 200 m past the
//     sphere's far side covered nothing, and the far cascade's sphere (radius
//     ~325 m) reached in front of the near plane: no caster in its sun-side cap
//     was rastered and every receiver there read lit. Now
//     back = max(BACK_DIST_M, radius + lead) with lead = CSM_LEAD_H_M / sin(sun
//     elevation) capped at CSM_LEAD_MAX_M (how far sunward of a receiver a 50 m
//     caster can stand and still shade it), and far = back + radius +
//     CSM_FAR_PAD_M. The near cascade keeps its 200 m lead-in above an ~18 deg
//     sun, the mid one above ~34 deg (radius + lead < 200; below that their
//     light moves back too); every cascade drops the dead 200 m behind its
//     sphere, and the far cascade's whole sphere is in range.
//   - BIAS. The receivers subtract a fixed 0.0007 of the [0, 1] depth range
//     (materials.js / terrain.js `float bias = 0.0007;`): 0.30 / 0.36 / 0.51 m
//     along the light over the old 434 / 509 / 725 m ranges, 9 texels of the
//     near cascade. A receiver within that distance of its occluder reads lit:
//     a ~0.26 m lit seam along the base of every wall in its own shadow at a
//     30 deg sun, and feet detached from their shadows. The bias is now a count
//     of each cascade's TEXELS (`?csmBiasTexels`, default 2), in metres along the
//     light, per receiver class:
//       ground (the materials registered on `patchedMaterials` = the terrain:
//         it never casts, so it cannot shadow itself and needs no acne margin):
//         k texels — 6.8 / 21 cm for the near / mid cascades;
//       casters (the shared uniform set: statics, rigs, particles — AC surfaces
//         are DoubleSide, so a lit face compares against its own depth across
//         the 4-tap PCF footprint): 2k texels — 13.7 cm near;
//     each capped at the old metric bias, so no receiver leaks more than before
//     (the far cascade keeps 0.51 m, the mid cascade's casters 0.36 m).
//     No shader or program-key change: the receivers' constant stays and
//     refreshCsmUniforms folds the difference into the z translation of each
//     cascade's `uCsmMatrix` (an ortho shadow matrix is affine with w = 1, so a
//     z shift moves every reference depth by exactly that much). The sign comes
//     from the matrix's own depth row, so it holds for the conventional and the
//     reversed cascade cameras alike. Needs an eye test (acne on DoubleSide
//     walls at the near cascade, ?csmBiasTexels sweeps it).

import * as THREE from "three";

// Cascade split distances in metres, view-space depth from the camera.
// Tuned per the plan-doc starting points: 30 m = "Holtburg town centre"
// from the LB centre, 100 m = "across the LB", 300 m = "to the horizon".
// Tunable via `setupCsm(scene, { splits: [...] })`.
export const DEFAULT_CSM_SPLITS = Object.freeze([30, 100, 300]);

// Resolution per cascade. Near + mid at 2048^2 for crisp close-up edges
// (1.46 cm / texel at 30 m; 4.88 cm / texel at 100 m for a 100 m frustum
// half-width). Far at 1024^2 for budget — at 300 m we want to see
// shadows exist, not pixel-perfect edges (29.3 cm / texel).
export const DEFAULT_CSM_MAP_SIZES = Object.freeze([2048, 2048, 1024]);

// Blend zone width as a fraction of each cascade range. 0.1 = the last
// 10% of cascade N also samples cascade N+1 and lerps. Keeps the seam
// between cascades invisible.
export const DEFAULT_CSM_BLEND_FRAC = 0.1;

// Distance to pull the shadow camera back along the light direction
// from the cascade AABB centre, so casters slightly behind the camera
// (relative to light direction) still register in the shadow pass.
// 200 m comfortably covers the Holtburg LB ring's tallest casters
// (towers + cottage rooflines ~25 m above ground; the sun's pitch
// makes the back-of-frustum requirement larger).
const BACK_DIST_M = 200;

// Camera-frustum corners in NDC. Used by `_frustumCornersWorld` to
// derive the 8 world-space corners of a sub-frustum slice.
const NDC_CORNERS = [
  [-1, -1, -1], [+1, -1, -1], [+1, +1, -1], [-1, +1, -1], // near plane
  [-1, -1, +1], [+1, -1, +1], [+1, +1, +1], [-1, +1, +1], // far plane
];

// Perf C4 — thresholds for skipping the per-cascade refit when neither
// the camera nor the sun have meaningfully moved since last frame. Both
// are SQUARED magnitudes (avoid the sqrt in the hot path).
//
// Camera: 1e-4 m² ≈ 1 cm of player movement. At 60 FPS this is ~0.6 m/s,
//   so a stationary or near-stationary player skips, but any actual
//   walk-input (run speed ~6 m/s = 0.1 m/frame = 0.01 m² delta) rebuilds
//   on every frame. The far cascade's texel size is 29.3 cm/texel, so
//   a 1 cm budget is well below visible texel drift.
//
// Sun: 1e-6 (dimensionless on a unit-ish direction vector). The sun
//   direction unit vector traverses 2π over a full AC day (7620 s of
//   real time = 11.34× compressed), so per-frame change is ~9e-7 rad
//   at 60 FPS — JUST below the threshold for the standing-still case.
//   The texel-snap step in _fitCascade is the load-bearing anti-shimmer
//   guard, so a tiny under-budget drift in sun direction can't manifest
//   as visible swim until the threshold is crossed.
//
// Retune downward if shadow swim becomes visible on slow camera pans or
// at solar zenith/horizon transitions. Retune upward (more aggressive
// skipping) only if perf demands it AND the texel snap is doing its
// job — bump cautiously, validate against the texel size of the LARGEST
// cascade (300 m / 1024 = 0.293 m).
//
// RP5 (lighting/shadow perf, 2026-06-08) — these two thresholds are now
// optionally overridable via `setupCsm(scene, { camDeltaSqEps, sunDeltaSqEps })`
// (wired to URL flags by the lighting layer). The defaults below are the
// validated values; raising them skips more refits at the cost of a little
// shadow swim on slow pans — see the threshold rationale above before
// retuning. The static-scene shadow-raster gate (lighting.js) reuses the
// SAME refit decision (via `csmState.didRefitThisTick`) as its primary
// "camera/sun moved" signal, so a too-aggressive eps here also widens the
// raster-skip window — keep them conservative.
const CAM_DELTA_SQ_EPS = 1e-4; // m²
const SUN_DELTA_SQ_EPS = 1e-6; // unit-vector²

// Camera ORIENTATION threshold (2026-08-03 review F1). The cascade fit is
// derived from `_frustumCornersWorld`, which depends on the camera's rotation
// just as much as its position, so a position-only skip test froze the
// cascades through any pure rotation. The retail in-head camera
// (`?retailCamZoom`, default ON) is the worst case: its pitch does not move
// the camera AT ALL and its yaw moves it only 0.18 m × Δθ, so a normal
// look-around stayed under CAM_DELTA_SQ_EPS indefinitely — cascades frozen to
// a stale view slice, and `didRefitThisTick=false` also parked lighting.js's
// shadow re-raster.
//
// Measured on the two world-space basis columns of `camera.matrixWorld`
// (columns 1 and 2 — two orthonormal axes pin the full orientation, including
// roll). For a small rotation θ each column moves ≈ θ, so the summed squared
// delta is ≈ 2θ². 2e-6 ⇒ θ ≈ 1e-3 rad, which drifts the 300 m far plane by
// ≈ 0.3 m — one texel of the far cascade (0.293 m), matching the budget the
// position threshold above was tuned to.
const CAM_ROT_DELTA_SQ_EPS = 2e-6; // unit-basis², ≈1e-3 rad

// Stable cascades (shadows-restore-1, see the header). Per-cascade translation
// slack in metres: radius = splits[i] + margin. 5 / 10 / 28 m reproduce the
// view-slice fit's sphere at the default retail fov (90° game fov → 53.6°
// vertical at 16:9: radii 34.3 / 108.8 / 324.9 m) to within 2%, so texel
// density per cascade is today's (3.4 / 10.7 / 64 cm at 2048 / 2048 / 1024).
export const DEFAULT_CSM_STABLE_MARGINS = Object.freeze([5, 10, 28]);
// Sun epsilon per cascade, as a multiple of the (squared) ?csmSunEps base:
// the far cascade's 64 cm texels take 2e-3 rad (×4 squared) without a visible
// step.
const STABLE_SUN_EPS_SCALE = Object.freeze([1, 1, 4]);
// A sun step this large (squared unit-vector delta, 0.02 rad) is a jump — the
// sky was set, not drifting — and refits every stale cascade on the same frame
// instead of staggering, so no cascade shows the old direction for a frame.
const STABLE_SUN_JUMP_SQ = 4e-4;
// Texels of PCF footprint kept inside the map edge: the receivers' four taps sit
// ±0.5 texel off the lookup and each is a bilinear 2×2.
const STABLE_GUARD_TEXELS = 2;
// Per-cascade multiple of the ?shadowMaxStale ceiling lighting.js applies to
// stable cascades (12 / 24 / 60 frames at the default 12). Stable cascades keep
// their static cache while the player moves, so the ceiling is what bounds the
// cached statics' lag (sway, streaming, camera-dependent LOD); the mid and far
// cascades' 10.7 / 64 cm texels hide most of it.
export const DEFAULT_CSM_STABLE_STALE_SCALE = Object.freeze([1, 2, 5]);

// shadows-restore-5 (header) — fraction of the shaded term a full shadow
// removes. Legacy whole-colour multiply: 0.55 (the historic 0.45 floor, which
// kept the ambient it also darkened from crushing). Direct-only: 1 (the sun's
// direct light is blocked; ambient, IBL and emissive are not touched).
export const CSM_SHADE_LEGACY = 0.55;
export const CSM_SHADE_DIRECT = 1.0;

// shadows-restore-7 (header) — depth fit + texel bias.
// The receivers' fixed reference shift toward the light, in [0, 1] shadow depth
// (materials.js _csmSampleCascade / terrain.js csmSampleCascade `float bias`;
// tests/csm_depth_fit.test.mjs pins the two equal to this).
export const CSM_RECEIVER_BIAS = 0.0007;
// Ground receivers' bias in texels of the cascade (casters: ×CSM_CASTER_BIAS_SCALE).
export const DEFAULT_CSM_BIAS_TEXELS = 2;
const CSM_CASTER_BIAS_SCALE = 2;
const CSM_BIAS_TEXELS_MIN = 0.25;
const CSM_BIAS_TEXELS_MAX = 16;
// Caster height the lead-in past the sphere must cover, and its cap (a sun
// below ~7 deg would ask for more; csmSunFade fades the cascades out there).
const CSM_LEAD_H_M = 50;
const CSM_LEAD_MAX_M = 400;
// Slack past the sphere's far side (float error, and the folded bias shifting a
// far-edge reference by a fraction of a metre).
const CSM_FAR_PAD_M = 2;
// The cascade cameras' near plane (both fits).
const CSM_NEAR_M = 0.1;

/**
 * shadows-restore-7 — how far sunward of a cascade's centre its light sits:
 * the legacy BACK_DIST_M, or enough for the whole sphere plus a 50 m caster's
 * lead at this sun elevation, whichever is more.
 * @param {number} radius - the cascade sphere's radius (m)
 * @param {number} sinElev - sin of the sun's elevation (the normalised light
 *   direction's y, three Y-up)
 */
export function csmBackDistance(radius, sinElev) {
  const s = Number.isFinite(sinElev) && sinElev > 1e-3 ? sinElev : 1e-3;
  const lead = Math.min(CSM_LEAD_MAX_M, CSM_LEAD_H_M / s);
  return Math.max(BACK_DIST_M, radius + lead);
}

/**
 * Construct the CSM bundle and attach the shadow-only cascade lights
 * to `scene`. The caller is responsible for:
 *   - Setting `renderer.shadowMap.enabled = true`
 *   - Tagging caster meshes with `castShadow = true`
 *   - Tagging receiver meshes with `receiveShadow = true`
 *   - Calling `updateCsm(csmState, camera)` once per frame
 *   - Patching receiver materials via `installCsmShaderPatch`
 *     (centralised in `materials.js`)
 *
 * @param {THREE.Scene} scene - the scene root the cascade lights live under.
 * @param {Object} opts
 * @param {{x:number,y:number,z:number}} opts.sunDir - the sun's
 *   direction vector in three.js world space (Y-up). The 3 cascade
 *   lights share this direction. Mirrors `setupSceneLighting`'s sun
 *   position relative to its target.
 * @param {number[]} [opts.splits=DEFAULT_CSM_SPLITS] - per-cascade
 *   far distances in metres. Length must be 3.
 * @param {number[]} [opts.mapSizes=DEFAULT_CSM_MAP_SIZES] - per-cascade
 *   shadow map resolution. Length must be 3.
 * @param {number} [opts.blendFrac=DEFAULT_CSM_BLEND_FRAC] - blend zone
 *   as fraction of each cascade range.
 * @param {number} [opts.camDeltaSqEps=CAM_DELTA_SQ_EPS] - RP5 tunable
 *   squared-metres camera-move threshold below which `updateCsm` skips
 *   the per-cascade refit. Defaults to the validated CAM_DELTA_SQ_EPS.
 * @param {number} [opts.sunDeltaSqEps=SUN_DELTA_SQ_EPS] - RP5 tunable
 *   squared sun-direction-delta threshold below which `updateCsm` skips
 *   the per-cascade refit. Defaults to the validated SUN_DELTA_SQ_EPS.
 * @param {number} [opts.camRotDeltaSqEps=CAM_ROT_DELTA_SQ_EPS] - R3#1 tunable
 *   squared camera-orientation-delta threshold (matrixWorld basis columns)
 *   below which `updateCsm` may skip the refit. Defaults to the validated
 *   CAM_ROT_DELTA_SQ_EPS.
 * @param {boolean} [opts.stable=false] - shadows-restore-1 stable cascades
 *   (camera-centred, rotation-invariant, per-cascade slack + staggered sun
 *   refits; see the header). Only an explicit `true` enables it: lighting.js
 *   passes `?csmStable` (default on); direct callers keep the view-slice fit.
 * @param {number[]} [opts.stableMargins=DEFAULT_CSM_STABLE_MARGINS] - stable
 *   mode's per-cascade slack in metres (radius = split + margin).
 * @param {boolean} [opts.directOnly=false] - shadows-restore-5: receivers
 *   attenuate the sun's direct term only (see the header). Only an explicit
 *   `true` enables it: lighting.js passes `?csmDirectOnly` (default on); direct
 *   callers keep the legacy whole-colour multiply.
 * @param {number} [opts.shade] - shadows-restore-5: fraction of the shaded term
 *   a full shadow removes, [0, 1]. Default CSM_SHADE_DIRECT with `directOnly`,
 *   else CSM_SHADE_LEGACY.
 * @param {boolean} [opts.depthFit=false] - shadows-restore-7: per-cascade depth
 *   range (back / far from the sphere and the sun) and a texel-scaled receiver
 *   bias (see the header). Only an explicit `true` enables it: lighting.js
 *   passes `?csmBias` (default on); direct callers keep the fixed range + bias.
 * @param {number} [opts.biasTexels=DEFAULT_CSM_BIAS_TEXELS] - shadows-restore-7:
 *   ground receivers' bias in texels of each cascade (casters get twice it),
 *   clamped to [0.25, 16].
 * @returns {{
 *   lights: THREE.DirectionalLight[3],
 *   splits: number[],
 *   blendFrac: number,
 *   sunDir: {x:number,y:number,z:number},
 *   csmGroup: THREE.Group,
 *   patchedMaterials: Set<THREE.Material>,
 *   uniforms: Object<string, {value: *}>,
 *   dispose: () => void
 * }}
 */
export function setupCsm(scene, opts = {}) {
  if (!scene || typeof scene.add !== "function") {
    throw new Error("setupCsm: `scene` must be a THREE.Scene");
  }
  const splits = (opts.splits ?? DEFAULT_CSM_SPLITS).slice();
  if (splits.length !== 3) {
    throw new Error(`setupCsm: splits must have length 3; got ${splits.length}`);
  }
  const mapSizes = (opts.mapSizes ?? DEFAULT_CSM_MAP_SIZES).slice();
  if (mapSizes.length !== 3) {
    throw new Error(`setupCsm: mapSizes must have length 3; got ${mapSizes.length}`);
  }
  const blendFrac = Number.isFinite(opts.blendFrac)
    ? opts.blendFrac
    : DEFAULT_CSM_BLEND_FRAC;
  const sunDir = opts.sunDir
    ? { x: opts.sunDir.x, y: opts.sunDir.y, z: opts.sunDir.z }
    : { x: 60, y: 80, z: 30 };
  // RP5 — per-instance refit thresholds. Fall back to the validated
  // module constants when the caller doesn't pass a finite override.
  const camDeltaSqEps = Number.isFinite(opts.camDeltaSqEps)
    ? opts.camDeltaSqEps
    : CAM_DELTA_SQ_EPS;
  const sunDeltaSqEps = Number.isFinite(opts.sunDeltaSqEps)
    ? opts.sunDeltaSqEps
    : SUN_DELTA_SQ_EPS;
  const camRotDeltaSqEps = Number.isFinite(opts.camRotDeltaSqEps)
    ? opts.camRotDeltaSqEps
    : CAM_ROT_DELTA_SQ_EPS;
  // shadows-restore-1 — stable cascades: explicit opt-in (lighting.js reads the
  // URL flag). A margin must be a positive finite number of metres.
  const stable = opts.stable === true;
  const stableMargins = (opts.stableMargins ?? DEFAULT_CSM_STABLE_MARGINS).slice();
  if (stableMargins.length !== 3 || !stableMargins.every((m) => Number.isFinite(m) && m > 0)) {
    throw new Error("setupCsm: stableMargins must be 3 positive numbers");
  }
  // shadows-restore-5 — where the shadow lands (explicit opt-in, lighting.js
  // reads the URL flag) and how dark a full shadow is.
  const directOnly = opts.directOnly === true;
  const shade = Number.isFinite(opts.shade)
    ? Math.min(1, Math.max(0, opts.shade))
    : (directOnly ? CSM_SHADE_DIRECT : CSM_SHADE_LEGACY);
  // shadows-restore-7 — depth fit + texel bias (explicit opt-in, lighting.js
  // reads the URL flag) and the ground receivers' texel count.
  const depthFit = opts.depthFit === true;
  const biasTexels = Number.isFinite(opts.biasTexels)
    ? Math.min(CSM_BIAS_TEXELS_MAX, Math.max(CSM_BIAS_TEXELS_MIN, opts.biasTexels))
    : DEFAULT_CSM_BIAS_TEXELS;

  const csmGroup = new THREE.Group();
  csmGroup.name = "csm-cascades";

  /** @type {THREE.DirectionalLight[]} */
  const lights = [];
  for (let i = 0; i < 3; i += 1) {
    // intensity=0 — these lights exist only as shadow projectors. They
    // don't add diffuse contribution; the actual sun (constructed in
    // `setupSceneLighting`) is the lighting source.
    const light = new THREE.DirectionalLight(0xffffff, 0);
    light.name = `csm-cascade-${i}`;
    light.castShadow = true;
    light.position.set(sunDir.x, sunDir.y, sunDir.z);
    light.target.position.set(0, 0, 0);
    light.shadow.mapSize.set(mapSizes[i], mapSizes[i]);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.05;
    // The shadow camera frustum is set every frame by updateCsm; place
    // sensible defaults so an un-ticked CSM still renders SOMETHING.
    const halfSize = splits[i];
    light.shadow.camera.left = -halfSize;
    light.shadow.camera.right = halfSize;
    light.shadow.camera.top = halfSize;
    light.shadow.camera.bottom = -halfSize;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = splits[i] * 6 + BACK_DIST_M * 2;
    light.shadow.camera.updateProjectionMatrix();
    // Enable RENDER_LAYER_INDOOR (1) so the CSM cascade sun lights interior
    // EnvCells in the ?portalPunch cells pass too (three drops layer-mismatched
    // lights in projectObject) — interior lighting matches the outdoor view.
    // Layer 0 stays on → terrain/world pass unchanged.
    light.layers.enable(1);
    csmGroup.add(light);
    csmGroup.add(light.target);
    lights.push(light);
  }
  scene.add(csmGroup);

  // 2026-10-20 (improvement hunt shadows-restore-3, `?csmDeadLights`, default on): these
  // intensity-0 casters sort first in every lit program's directional loop and each unrolled
  // copy adds exactly zero (plus three's 5-tap getShadow on receivers). light_loops.js
  // installCsmDeadLights drops their copies from three's lights_fragment_begin, keyed in the GLSL
  // on exactly lights.length directional shadows, so it stays inert for any other caster set.
  // Installed here — CSM owns the casters, and no program with their shadow count exists yet —
  // through a global, not an import (legacy tests eval this file in `new Function`). Same image;
  // no light count or castShadow change. No hook (light_loops.js not loaded): stock loop.
  try {
    const installDeadLights = globalThis.__hbInstallCsmDeadLights;
    if (typeof installDeadLights === "function") installDeadLights(THREE, lights.length);
  } catch (_) { /* fail-soft: the stock directional loop stays */ }

  const state = {
    lights,
    splits,
    mapSizes,
    blendFrac,
    sunDir,
    csmGroup,
    // RP5 — per-instance refit thresholds (default = the validated module
    // constants). `updateCsm` reads these instead of the bare constants
    // so the lighting/URL layer can retune without editing this file.
    camDeltaSqEps,
    sunDeltaSqEps,
    camRotDeltaSqEps,
    // RP5 — set by every `updateCsm` call: true when this tick actually
    // refit the cascades (camera or sun moved past threshold), false when
    // it early-outed because the scene was static. The static-scene
    // shadow-raster gate in lighting.js consumes this as its primary
    // "shadows must re-raster this frame" signal. Initialised true so the
    // very first frame after setup re-rasters (matches the NaN-sentinel
    // first-frame rebuild below).
    didRefitThisTick: true,
    // shadows-restore-1 — WHICH cascades this tick refit (bit i = cascade i).
    // The view-slice fit always refits all three (0b111) or none; stable mode
    // refits each on its own (lighting.js marks only those maps FRUSTUM).
    refitMask: 0b111,
    stable,
    stableMargins,
    // shadows-restore-5 (header). `directOnly` is read by the receiver builders
    // (materials.js hook, terrain.js defines) at compile time; `shade` and
    // `strength` are uniform values (`uCsmShade` / `uCsmStrength`) that
    // refreshCsmUniforms writes every frame. lighting.js owns `strength` (the
    // time-of-day direct factor, 1 until it says otherwise); 0 = no receiver
    // samples the cascades, so its shadow gate skips their rasters.
    directOnly,
    shade,
    strength: 1,
    // shadows-restore-7 (header). `depthFit` is read by the fits (back / far)
    // and by refreshCsmUniforms (the folded bias); `bias` is what the last
    // refresh applied, per cascade, in metres along the light (read live:
    // `liveScene3d.csmState.bias`): ground = terrain receivers, caster = the
    // shared set; folds / unfoldable count cascade refreshes (an unfoldable
    // one — no map yet, or a non-affine matrix — keeps the receivers' fixed
    // bias that frame).
    depthFit,
    biasTexels,
    bias: {
      ground: [0, 0, 0],
      caster: [0, 0, 0],
      folds: 0,
      unfoldable: 0,
    },
    _biasFold: null,
    // Stable mode only: per-cascade ?shadowMaxStale multiple (lighting.js).
    stableStaleScale: stable ? DEFAULT_CSM_STABLE_STALE_SCALE.slice() : null,
    // Stable mode only: per cascade [centreX, centreY, centreZ, sunX, sunY,
    // sunZ] of its current fit (world; the snapped centre and the normalised
    // sun it was fit for). NaN = not fit yet → refit on the next tick.
    _stableFit: new Float64Array(18).fill(NaN),
    _stableFitTick: new Float64Array(3),
    _tick: 0,
    // shadows-restore-1 counters (read live: `liveScene3d.csmState.stats`).
    //   ticks       updateCsm calls        refitTicks  ticks that refit any
    //   refits[i]   cascade i refits (all three per refit tick on the
    //               view-slice fit)
    //   forced[i] / move[i] / sun[i]  stable mode: why cascade i refit (first
    //               fit or invalidate / camera left its slack / sun stepped)
    //   sunDeferred ticks a stale-sun cascade waited (stagger)
    //   sunJumps    ticks the sun jumped (every stale cascade at once)
    stats: {
      ticks: 0,
      refitTicks: 0,
      refits: [0, 0, 0],
      forced: [0, 0, 0],
      move: [0, 0, 0],
      sun: [0, 0, 0],
      sunDeferred: 0,
      sunJumps: 0,
    },
    // Receivers' materials register here once patched, so we can refresh
    // uniforms after each `updateCsm` without re-walking the scene. Since
    // 2026-10-07 only the per-landblock terrain ShaderMaterials (whose own
    // `uniforms` carry the CSM slots, removed again on evict/park) register;
    // MaterialCache receivers bind `uniforms` below instead.
    patchedMaterials: new Set(),
    // 2026-10-07 — ONE set of CSM uniform objects, handed BY REFERENCE to
    // every MaterialCache receiver's program (materials.js
    // `_installCsmShaderPatch`, the same pattern as VFX_GLOBALS), so
    // `refreshCsmUniforms` writes nine values once per frame. The per-material
    // registry it replaces pinned every per-surface material ever built (the
    // `?matBudgetMB` eviction relies on GC) and walked them all each frame;
    // and because a batched variant shares its member's userData, it only
    // ever refreshed the LAST program compiled for a surface — the member's
    // or the variant's — leaving the other's shadow uniforms frozen.
    uniforms: {
      uCsmShadowMap0: { value: null },
      uCsmShadowMap1: { value: null },
      uCsmShadowMap2: { value: null },
      uCsmMatrix0: { value: new THREE.Matrix4() },
      uCsmMatrix1: { value: new THREE.Matrix4() },
      uCsmMatrix2: { value: new THREE.Matrix4() },
      uCsmSplits: { value: new THREE.Vector2(splits[0], splits[1]) },
      uCsmFar: { value: splits[2] },
      uCsmBlend: { value: blendFrac },
      // shadows-restore-1 — receivers pick the cascade by distance from the
      // camera (1, stable cascades) or by view depth (0, the view-slice fit).
      uCsmSelDist: { value: stable ? 1 : 0 },
      // shadows-restore-5 — time-of-day strength (lighting.js) and full-shadow
      // darkness; the receivers shade by mix(1 - shade * strength, 1, s).
      uCsmStrength: { value: 1 },
      uCsmShade: { value: shade },
    },
    _uniformRefs: null,
    // Perf C4 — skip-rebuild cache. `updateCsm` compares the camera
    // position + sun direction against these and bails out of the
    // (3 × _fitCascade) work if both deltas are below threshold. The
    // sentinel `NaN` here forces the FIRST `updateCsm` call after setup
    // to always rebuild (NaN compared to anything is false → delta > eps).
    _lastCamX: NaN,
    _lastCamY: NaN,
    _lastCamZ: NaN,
    _lastSunX: NaN,
    _lastSunY: NaN,
    _lastSunZ: NaN,
    // F1 — camera ORIENTATION (two world basis columns of matrixWorld) and
    // the projection parameters the sub-frustum is derived from. Same NaN
    // sentinel contract as the position/sun fields above.
    _lastCamUX: NaN,
    _lastCamUY: NaN,
    _lastCamUZ: NaN,
    _lastCamFX: NaN,
    _lastCamFY: NaN,
    _lastCamFZ: NaN,
    _lastCamFov: NaN,
    _lastCamAspect: NaN,
    _lastCamNear: NaN,
    _lastCamZoom: NaN,
    /**
     * Force the next `updateCsm` call to rebuild all cascades regardless
     * of how small the camera / sun deltas are. Call this when:
     *   - The quality flag toggles CSM on/off mid-session.
     *   - The splits or mapSizes are mutated externally.
     *   - The camera is teleported (rare; but safest to invalidate).
     *   - Anything else has invalidated the cached cascade fit.
     */
    invalidate() {
      this._lastCamX = NaN;
      this._lastCamY = NaN;
      this._lastCamZ = NaN;
      this._lastSunX = NaN;
      this._lastSunY = NaN;
      this._lastSunZ = NaN;
      this._lastCamUX = NaN;
      this._lastCamUY = NaN;
      this._lastCamUZ = NaN;
      this._lastCamFX = NaN;
      this._lastCamFY = NaN;
      this._lastCamFZ = NaN;
      this._lastCamFov = NaN;
      this._lastCamAspect = NaN;
      this._lastCamNear = NaN;
      this._lastCamZoom = NaN;
      // shadows-restore-1 — stable mode: every cascade refits next tick.
      if (this._stableFit) this._stableFit.fill(NaN);
      // RP5 — a forced rebuild WILL refit on the next updateCsm, so the
      // static-shadow gate must re-raster that frame. Mark it now so even
      // if the gate is read before updateCsm runs, it errs toward drawing.
      this.didRefitThisTick = true;
      this.refitMask = 0b111;
    },
    dispose() {
      // Reset the skip-rebuild cache too, so a future re-setup that
      // happens to reuse the same object reference (defensive — current
      // factory always allocates fresh) starts with a forced rebuild.
      this.invalidate();
      for (const l of lights) {
        if (l.shadow?.map?.dispose) {
          try { l.shadow.map.dispose(); } catch (_) {}
        }
      }
      scene.remove(csmGroup);
    },
  };

  return state;
}

/**
 * Perf C4 — public helper for resetting the skip-rebuild cache without
 * holding a direct reference to the state's private fields. Exported so
 * the lighting / quality layer can invalidate on quality-flag toggle
 * without coupling to the cache field names.
 *
 * @param {Object} csmState - bundle returned by `setupCsm`.
 */
export function invalidateCsm(csmState) {
  if (csmState && typeof csmState.invalidate === "function") {
    csmState.invalidate();
  }
}

/**
 * The vertical fov (degrees) the cascades fit: `camera.fov`, unless the
 * camera carries `userData.csmFitFov`. portal_space.js `?portalFovFade`
 * (cells-portals-3) parks the game fov there while its 1 s WORLD_FADEIN zoom
 * widens `camera.fov` toward 179°, so the cascades keep the game frustum
 * instead of stretching over the zoom. Unset (every other frame): camera.fov.
 */
function _fitFov(camera) {
  const f = camera.userData ? camera.userData.csmFitFov : undefined;
  return typeof f === "number" && f > 0 && f < 180 ? f : camera.fov;
}

/**
 * Per-frame: recompute each cascade's shadow camera frustum to tightly
 * fit the camera's view-frustum sub-slice between consecutive cascade
 * splits. Mirrors the standard CSM recipe from learnopengl.com
 * Guest-Articles/2021/CSM.
 *
 * @param {Object} csmState - bundle returned by `setupCsm`.
 * @param {THREE.PerspectiveCamera} camera - the active render camera.
 *   Only PerspectiveCamera is supported; OrthographicCamera (top-down
 *   mode) falls through to a passive frustum (no update).
 * @param {{x:number,y:number,z:number}} [sunDir] - optional override
 *   of the cascade lights' direction. If absent, uses the cached
 *   direction from setup.
 */
export function updateCsm(csmState, camera, sunDir) {
  if (!csmState || !camera) return;
  const stats = csmState.stats || null;
  if (stats) stats.ticks += 1;
  csmState._tick = (csmState._tick || 0) + 1;
  if (!camera.isPerspectiveCamera) {
    // Top-down ortho path — cascades can't sensibly fit an ortho view
    // frustum's depth slices. Skip; the cached defaults from setupCsm
    // remain. RP5 — no refit happened, so the static-shadow gate must
    // NOT treat this frame as a re-raster trigger on its own.
    csmState.didRefitThisTick = false;
    csmState.refitMask = 0;
    return;
  }
  const dir = sunDir ?? csmState.sunDir;
  if (dir) {
    csmState.sunDir.x = dir.x;
    csmState.sunDir.y = dir.y;
    csmState.sunDir.z = dir.z;
  }

  // Ensure the camera's matrices are current (callers usually call
  // `updateMatrixWorld` themselves via `renderer.render`, but capture
  // scripts may not have hit the next render yet).
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  // The light direction (from light → target). All cascades share it.
  // Normalised so `lightPos = aabbCenter - lightDir * BACK_DIST_M`
  // gives a consistent offset regardless of the sun's input magnitude.
  const lightDirLen = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const lx = dir.x / lightDirLen;
  const ly = dir.y / lightDirLen;
  const lz = dir.z / lightDirLen;

  // shadows-restore-1 — stable cascades decide per cascade (camera slack, sun
  // epsilon); none of the view-slice thresholds below apply to them.
  if (csmState.stable === true) {
    _updateStableCsm(csmState, camera, lx, ly, lz, stats);
    return;
  }

  // Perf C4 — skip the per-cascade refit when neither the camera nor
  // the sun moved meaningfully since last frame. The cascade lights'
  // shadow.matrix / shadow.map references stay valid across the skipped
  // frame, so the caller's subsequent `refreshCsmUniforms` upload still
  // pushes correct (unchanged) values to receivers. NaN sentinels in
  // the cache force the first frame after setup to always rebuild.
  //
  // We cache the NORMALISED light direction (lx,ly,lz), not the raw
  // input `dir` — because that's what _fitCascade actually consumes,
  // and the raw input may have an arbitrary magnitude (e.g. sun
  // position vector before normalisation).
  const camPos = camera.position;
  const dCamX = camPos.x - csmState._lastCamX;
  const dCamY = camPos.y - csmState._lastCamY;
  const dCamZ = camPos.z - csmState._lastCamZ;
  const dSunX = lx - csmState._lastSunX;
  const dSunY = ly - csmState._lastSunY;
  const dSunZ = lz - csmState._lastSunZ;
  const camDeltaSq = dCamX * dCamX + dCamY * dCamY + dCamZ * dCamZ;
  const sunDeltaSq = dSunX * dSunX + dSunY * dSunY + dSunZ * dSunZ;
  // F1 — camera ORIENTATION. `_frustumCornersWorld` reads camera.matrixWorld,
  // so a pure rotation changes the fit exactly as much as a translation does;
  // a position-only test froze the cascades through any look-around (see
  // CAM_ROT_DELTA_SQ_EPS). matrixWorld is fresh — updateMatrixWorld() ran
  // above. Columns 1 (up) + 2 (+Z) pin the orientation including roll.
  const me = camera.matrixWorld.elements;
  const dUpX = me[4] - csmState._lastCamUX;
  const dUpY = me[5] - csmState._lastCamUY;
  const dUpZ = me[6] - csmState._lastCamUZ;
  const dFwX = me[8] - csmState._lastCamFX;
  const dFwY = me[9] - csmState._lastCamFY;
  const dFwZ = me[10] - csmState._lastCamFZ;
  const camRotDeltaSq =
    dUpX * dUpX + dUpY * dUpY + dUpZ * dUpZ + dFwX * dFwX + dFwY * dFwY + dFwZ * dFwZ;
  // Projection parameters feed the sub-frustum shape directly (resize, retail
  // zoom): compare exactly — they only move on discrete events, so there is
  // no threshold to tune and no drift to accumulate.
  const fitFov = _fitFov(camera);
  const projChanged =
    fitFov !== csmState._lastCamFov ||
    camera.aspect !== csmState._lastCamAspect ||
    camera.near !== csmState._lastCamNear ||
    camera.zoom !== csmState._lastCamZoom;
  // NaN propagates through subtraction, so on first call (cached NaNs)
  // both deltaSq will be NaN, NaN < eps is false → we fall through to
  // the rebuild path. Subsequent frames compare real numbers.
  // RP5 — use the per-instance thresholds (default = the module
  // constants) so the lighting/URL layer can retune skip aggressiveness.
  const camEps = Number.isFinite(csmState.camDeltaSqEps)
    ? csmState.camDeltaSqEps
    : CAM_DELTA_SQ_EPS;
  const sunEps = Number.isFinite(csmState.sunDeltaSqEps)
    ? csmState.sunDeltaSqEps
    : SUN_DELTA_SQ_EPS;
  const camRotEps = Number.isFinite(csmState.camRotDeltaSqEps)
    ? csmState.camRotDeltaSqEps
    : CAM_ROT_DELTA_SQ_EPS;
  if (camDeltaSq < camEps && sunDeltaSq < sunEps && camRotDeltaSq < camRotEps && !projChanged) {
    // RP5 — static this tick: no cascade refit. The shadow maps three
    // already rastered last frame stay valid, so the static-scene gate
    // can skip the re-raster (unless something else, e.g. an indoor/
    // outdoor flip or the staleness bound, forces it).
    csmState.didRefitThisTick = false;
    csmState.refitMask = 0;
    return;
  }

  const cameraNear = camera.near;
  // For each cascade, the visible sub-frustum is between previous split
  // and this split (cascade 0: near…split[0]; cascade 1: split[0]…split[1]; etc).
  let prevSplit = cameraNear;
  for (let i = 0; i < 3; i += 1) {
    const splitFar = csmState.splits[i];
    _fitCascade(
      csmState.lights[i],
      camera,
      prevSplit,
      splitFar,
      lx, ly, lz,
      csmState.mapSizes[i],
      csmState.depthFit === true
    );
    prevSplit = splitFar;
  }

  // Cache the inputs we just rebuilt against. Must happen AFTER the
  // rebuild so an exception thrown inside _fitCascade doesn't poison
  // the cache (next frame will retry, not silently skip).
  csmState._lastCamX = camPos.x;
  csmState._lastCamY = camPos.y;
  csmState._lastCamZ = camPos.z;
  csmState._lastSunX = lx;
  csmState._lastSunY = ly;
  csmState._lastSunZ = lz;
  csmState._lastCamUX = me[4];
  csmState._lastCamUY = me[5];
  csmState._lastCamUZ = me[6];
  csmState._lastCamFX = me[8];
  csmState._lastCamFY = me[9];
  csmState._lastCamFZ = me[10];
  csmState._lastCamFov = fitFov;
  csmState._lastCamAspect = camera.aspect;
  csmState._lastCamNear = camera.near;
  csmState._lastCamZoom = camera.zoom;
  // RP5 — cascades were refit this tick (camera and/or sun moved). The
  // static-scene shadow-raster gate treats this as "shadows changed →
  // re-raster this frame".
  csmState.didRefitThisTick = true;
  csmState.refitMask = 0b111;
  if (stats) {
    stats.refitTicks += 1;
    for (let i = 0; i < 3; i += 1) stats.refits[i] += 1;
  }
}

/**
 * shadows-restore-1 — the stable-cascade tick (see the header): cascade i is a
 * sphere of radius `splits[i] + stableMargins[i]` about a texel-snapped point
 * near the camera, refit only when the camera leaves its slack zone, the sun
 * steps past its epsilon (staggered: one cascade per frame, none on a frame
 * another refits, all at once on a jump), or it was never fit / invalidated.
 * Leaves `refitMask` / `didRefitThisTick` for lighting.js.
 */
function _updateStableCsm(csmState, camera, lx, ly, lz, stats) {
  // World position from matrixWorld (fresh — updateCsm ran updateMatrixWorld),
  // so a parented camera still centres where it renders from.
  const me = camera.matrixWorld.elements;
  const px = me[12];
  const py = me[13];
  const pz = me[14];
  const fit = csmState._stableFit;
  const age = csmState._stableFitTick;
  const margins = csmState.stableMargins || DEFAULT_CSM_STABLE_MARGINS;
  const sunBase = Number.isFinite(csmState.sunDeltaSqEps)
    ? csmState.sunDeltaSqEps
    : SUN_DELTA_SQ_EPS;
  let forcedMask = 0;
  let moveMask = 0;
  let sunMask = 0;
  let jump = false;
  let sunPick = -1;
  let sunScore = 0;
  for (let i = 0; i < 3; i += 1) {
    const o = i * 6;
    if (Number.isNaN(fit[o])) {
      forcedMask |= 1 << i;
      continue;
    }
    const radius = csmState.splits[i] + margins[i];
    const guard = STABLE_GUARD_TEXELS * ((radius * 2) / csmState.mapSizes[i]);
    const slack = Math.max(0, margins[i] - guard);
    const dx = px - fit[o];
    const dy = py - fit[o + 1];
    const dz = pz - fit[o + 2];
    // `!(a <= b)` — a NaN camera position refits rather than freezing.
    if (!(dx * dx + dy * dy + dz * dz <= slack * slack)) {
      moveMask |= 1 << i;
      continue;
    }
    const sx = lx - fit[o + 3];
    const sy = ly - fit[o + 4];
    const sz = lz - fit[o + 5];
    const sunSq = sx * sx + sy * sy + sz * sz;
    const eps = sunBase * STABLE_SUN_EPS_SCALE[i];
    if (!(sunSq < eps)) {
      sunMask |= 1 << i;
      if (!(sunSq <= STABLE_SUN_JUMP_SQ)) jump = true;
      // The most-overdue cascade goes first; on a tie the longest-unfit one.
      const score = sunSq / Math.max(eps, 1e-30);
      if (sunPick < 0 || score > sunScore || (score === sunScore && age[i] < age[sunPick])) {
        sunPick = i;
        sunScore = score;
      }
    }
  }
  let mask = forcedMask | moveMask;
  let sunTaken = 0;
  if (sunMask) {
    if (jump) sunTaken = sunMask;
    else if (mask === 0) sunTaken = 1 << sunPick;
    mask |= sunTaken;
  }
  for (let i = 0; i < 3; i += 1) {
    if (!(mask & (1 << i))) continue;
    _tmpCenter.set(px, py, pz);
    _placeCascade(
      csmState.lights[i],
      _tmpCenter,
      csmState.splits[i] + margins[i],
      lx, ly, lz,
      csmState.mapSizes[i],
      csmState.depthFit === true
    );
    // Record AFTER placing, so a throw leaves the cascade due again next tick.
    const o = i * 6;
    fit[o] = _tmpSnap.x;
    fit[o + 1] = _tmpSnap.y;
    fit[o + 2] = _tmpSnap.z;
    fit[o + 3] = lx;
    fit[o + 4] = ly;
    fit[o + 5] = lz;
    age[i] = csmState._tick;
  }
  csmState.refitMask = mask;
  csmState.didRefitThisTick = mask !== 0;
  if (stats) {
    if (mask) stats.refitTicks += 1;
    for (let i = 0; i < 3; i += 1) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      stats.refits[i] += 1;
      if (forcedMask & bit) stats.forced[i] += 1;
      else if (moveMask & bit) stats.move[i] += 1;
      else stats.sun[i] += 1;
    }
    if (sunMask & ~sunTaken) stats.sunDeferred += 1;
    if (jump) stats.sunJumps += 1;
  }
}

/**
 * Refresh per-material CSM uniforms for the next render. Called once
 * per frame after `updateCsm`. Materials that registered via
 * `installCsmShaderPatch` have a `userData.csmShaderUniforms` reference
 * to the shader's uniforms object (assigned in `onBeforeCompile`); we
 * walk the registered set and push fresh `light.shadow.matrix` +
 * `light.shadow.map.texture` references.
 *
 * Necessary because three.js's `onBeforeCompile` only fires ONCE per
 * material; subsequent renders use the cached compiled shader, so we
 * have to update uniforms by reference outside the compile hook.
 *
 * @param {Object} csmState - the bundle from `setupCsm`.
 */
/**
 * F4 (2026-08-03) — resolve a material's CSM uniform objects ONCE instead of
 * rebuilding six template-literal keys per material per frame. `refreshCsmUniforms`
 * runs unconditionally every frame (lighting.js) over every patched terrain
 * material, so the key churn was thousands of throwaway strings a second.
 *
 * Cached under a NON-ENUMERABLE userData slot on purpose: `Material.copy`
 * JSON-serialises userData and these refs reach live Textures — the exact
 * root cause R2#1 fixed for `heightTex` and the `*ShaderUniforms` stashes.
 *
 * Keyed on the uniforms object identity so a re-patch (onBeforeCompile firing
 * again with a fresh uniforms object) rebuilds instead of writing into the
 * dead shader's uniforms.
 */
function _refsOf(u) {
  return {
    src: u,
    maps: [u.uCsmShadowMap0 || null, u.uCsmShadowMap1 || null, u.uCsmShadowMap2 || null],
    mats: [u.uCsmMatrix0 || null, u.uCsmMatrix1 || null, u.uCsmMatrix2 || null],
    splits: u.uCsmSplits || null,
    far: u.uCsmFar || null,
    blend: u.uCsmBlend || null,
    // shadows-restore-1 — absent on a receiver built without it (its GLSL
    // then reads the uniform's default 0 = view-depth selection).
    selDist: u.uCsmSelDist || null,
    // shadows-restore-5 — same: absent ⇒ the receiver keeps its own defaults.
    strength: u.uCsmStrength || null,
    shade: u.uCsmShade || null,
  };
}

function _csmUniformRefs(mat) {
  const u = mat.userData?.csmShaderUniforms;
  if (!u) return null;
  const cached = mat.userData.__csmUniformRefs;
  if (cached && cached.src === u) return cached;
  const refs = _refsOf(u);
  Object.defineProperty(mat.userData, "__csmUniformRefs", {
    value: refs,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return refs;
}

export function refreshCsmUniforms(csmState) {
  if (!csmState) return;
  // shadows-restore-7 (depthFit) — the cascade matrices with each receiver
  // class's bias folded in (null = the fixed bias: plain copies, as before).
  const fold = csmState.depthFit === true ? _prepareBiasFold(csmState) : null;
  if (csmState.uniforms) {
    if (!csmState._uniformRefs) csmState._uniformRefs = _refsOf(csmState.uniforms);
    _writeCsmRefs(csmState._uniformRefs, csmState, fold ? fold.caster : null, null);
  }
  if (!csmState.patchedMaterials) return;
  const shared = fold ? csmState._uniformRefs || null : null;
  for (const mat of csmState.patchedMaterials) {
    const refs = _csmUniformRefs(mat);
    if (!refs) continue;
    // A registered material with materials.js's patch (a legacy bundle's
    // MeshStandard receiver, which also casts) is a caster; the rest are the
    // terrain ShaderMaterials (terrain.js / terrain_batch.js), which never cast.
    const folded = fold ? (mat.userData && mat.userData.csmEnabled === true ? fold.caster : fold.ground) : null;
    _writeCsmRefs(refs, csmState, folded, shared);
  }
}

/**
 * shadows-restore-7 — fill `csmState._biasFold` with each cascade's shadow
 * matrix twice, once per receiver class, its z translation shifted so the
 * receivers' fixed CSM_RECEIVER_BIAS lands as that class's bias in metres
 * (see the header). Records the metres on `csmState.bias`.
 */
function _prepareBiasFold(csmState) {
  let f = csmState._biasFold;
  if (!f) {
    f = csmState._biasFold = {
      caster: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
      ground: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
    };
  }
  const b = csmState.bias || (csmState.bias = { ground: [0, 0, 0], caster: [0, 0, 0], folds: 0, unfoldable: 0 });
  const k = Number.isFinite(csmState.biasTexels) && csmState.biasTexels > 0 ? csmState.biasTexels : DEFAULT_CSM_BIAS_TEXELS;
  // Toward the sun (the cascade lights sit at centre + sunDir * back).
  const sd = csmState.sunDir || { x: 0, y: 1, z: 0 };
  const sl = Math.hypot(sd.x, sd.y, sd.z) || 1;
  const ux = sd.x / sl;
  const uy = sd.y / sl;
  const uz = sd.z / sl;
  const lights = csmState.lights;
  for (let i = 0; i < 3; i += 1) {
    const light = lights[i];
    if (!light || !light.shadow) continue;
    const src = light.shadow.matrix;
    const cam = light.shadow.camera;
    const width = cam.right - cam.left;
    const texel = width / csmState.mapSizes[i];
    // The metres the fixed bias was worth over the legacy range for this
    // radius — the cap: no class leaks more than it did.
    const legacyM = CSM_RECEIVER_BIAS * (BACK_DIST_M * 2 + width * 0.5 - CSM_NEAR_M);
    const groundM = Math.min(k * texel, legacyM);
    const casterM = Math.min(k * CSM_CASTER_BIAS_SCALE * texel, legacyM);
    b.ground[i] = groundM;
    b.caster[i] = casterM;
    // No map yet ⇒ three has not computed this light's matrix: copy it as is.
    const okC = !!light.shadow.map && _foldBias(f.caster[i], src, ux, uy, uz, casterM);
    const okG = !!light.shadow.map && _foldBias(f.ground[i], src, ux, uy, uz, groundM);
    if (!okC) f.caster[i].copy(src);
    if (!okG) f.ground[i].copy(src);
    if (okC && okG) b.folds += 1;
    else b.unfoldable += 1;
  }
  return f;
}

/**
 * `out` = `src` (a cascade's world → [0, 1] shadow matrix) with its z
 * translation moved so that a receiver applying CSM_RECEIVER_BIAS toward the
 * light compares at `biasM` metres toward the light instead. The depth row's
 * length is the [0, 1] depth per metre along the light; its sign against the
 * sun direction tells conventional (depth grows away from the light) from
 * reversed. False (out untouched beyond the copy) when the matrix is not
 * affine or its depth row is not along the light.
 */
function _foldBias(out, src, ux, uy, uz, biasM) {
  out.copy(src);
  const e = out.elements;
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) return false;
  const len = Math.hypot(e[2], e[6], e[10]);
  const dot = e[2] * ux + e[6] * uy + e[10] * uz;
  if (!(len > 0) || !(Math.abs(dot) > 0.5 * len) || !Number.isFinite(biasM)) return false;
  // [0, 1] depth change per metre moved toward the sun: −len conventional, +len reversed.
  const g = dot > 0 ? len : -len;
  e[14] += biasM * g - (g > 0 ? CSM_RECEIVER_BIAS : -CSM_RECEIVER_BIAS);
  return true;
}

/**
 * The texture CSM receivers sample for a cascade light: its shadow DEPTH
 * texture (a `sampler2DShadow` in the receiver GLSL — hardware compare + PCF).
 * Null until three has rendered that light's shadow map once.
 */
export function csmShadowSampleTexture(light) {
  return light?.shadow?.map?.depthTexture ?? null;
}

/**
 * @param {Object|null} folded - shadows-restore-7: per-cascade matrices with
 *   this receiver class's bias folded in (null = copy the shadow matrix).
 * @param {Object|null} sharedRefs - with `folded`: the shared set's refs, whose
 *   matrix objects already hold the caster fold (a receiver that binds them by
 *   reference must not overwrite them with its own class).
 */
function _writeCsmRefs(refs, csmState, folded, sharedRefs) {
  const lights = csmState.lights;
  // splits + blendFrac don't change per frame in the common case
  // (splits are a setup-time choice); the per-frame work is the shadow
  // matrices + map textures (those change as cameras / lights move).
  for (let i = 0; i < 3; i += 1) {
    const light = lights[i];
    if (!light) continue;
    const mapU = refs.maps[i];
    if (mapU) {
      // light.shadow.map is created lazily on first render; until
      // it lands, leave the stale uniform value (the shader will
      // see the previous frame's texture, which is fine for a
      // single-frame discontinuity).
      // 2026-10-07 (1070 look pass): the DEPTH texture, not `.texture`.
      // three r184 renders shadow depth into `shadow.map.depthTexture`
      // (LessEqual compare, linear filter under PCF) and the colour buffer
      // only holds `1 - depth` at 8 bits (ShaderLib depth.glsl BasicDepth
      // packing). Read as plain depth that colour inverted every compare —
      // measured live: zero shadowed receivers anywhere, sun at 28 deg.
      const tex = csmShadowSampleTexture(light);
      if (tex) mapU.value = tex;
    }
    const matU = refs.mats[i];
    if (matU) {
      // Three composes shadow.matrix as
      //   biasMatrix * cam.projectionMatrix * cam.matrixWorldInverse
      // so it transforms world → shadow-NDC[0,1]: `xy` addresses the
      // depth texture and `z` is the reference depth for the compare.
      // shadows-restore-7: with `folded`, z also carries the class's bias.
      if (!folded) matU.value.copy(light.shadow.matrix);
      else if (!(sharedRefs && sharedRefs.mats[i] === matU)) matU.value.copy(folded[i]);
    }
  }
  if (refs.splits) {
    refs.splits.value.set(csmState.splits[0], csmState.splits[1]);
  }
  if (refs.far) {
    refs.far.value = csmState.splits[2];
  }
  if (refs.blend) {
    refs.blend.value = csmState.blendFrac;
  }
  if (refs.selDist) {
    refs.selDist.value = csmState.stable === true ? 1 : 0;
  }
  // shadows-restore-5 — a missing / non-finite strength is the old full
  // strength (1), never a NaN in the shade mix.
  if (refs.strength) {
    const s = csmState.strength;
    refs.strength.value = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 1;
  }
  if (refs.shade) {
    const k = csmState.shade;
    refs.shade.value = Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : CSM_SHADE_LEGACY;
  }
}

// ---- Internal: per-cascade frustum fit ------------------------------

const _tmpFrustumCorners = new Array(8);
for (let i = 0; i < 8; i += 1) _tmpFrustumCorners[i] = new THREE.Vector3();
const _tmpCenter = new THREE.Vector3();
const _tmpUp = new THREE.Vector3(0, 1, 0);
const _tmpLightPos = new THREE.Vector3();
const _tmpLightTarget = new THREE.Vector3();
// F3 — light basis anchored at the WORLD ORIGIN (not at the frustum centre)
// plus its inverse, so the texel snap grid below is a fixed frame.
const _tmpLightRot = new THREE.Matrix4();
const _tmpLightRotInv = new THREE.Matrix4();
const _tmpLightDir = new THREE.Vector3();
const _tmpSnap = new THREE.Vector3();
const _ORIGIN = new THREE.Vector3(0, 0, 0);
const _tmpProj = new THREE.Matrix4();
const _tmpInvProj = new THREE.Matrix4();

function _fitCascade(light, camera, near, far, lx, ly, lz, mapSize, depthFit) {
  // Step 1 — Compute the 8 corners of the camera's sub-frustum between
  // `near` and `far` in WORLD space.
  _frustumCornersWorld(camera, near, far, _tmpFrustumCorners);

  // Step 2 — Sub-frustum centroid + BOUNDING-SPHERE radius (F3, 2026-08-03).
  //
  // The radius is a function of (fov, aspect, near, far) ONLY — it does not
  // depend on where the camera looks or stands. That rotation-invariance is
  // the whole point: the ortho extents and near/far derived from it below are
  // CONSTANT for a given cascade, so the texel grid in step 4 is a fixed grid
  // that world geometry can actually be snapped onto.
  //
  // The previous fit took the AABB of the corners in LIGHT space, whose width
  // changed every frame as the camera turned. Its texel size therefore changed
  // every frame too, so snapping the centre to `round(cx / texelX) * texelX`
  // quantised onto a grid that was itself sliding — the documented anti-shimmer
  // guarantee never held. Cost of the fix: a sphere circumscribes the slice, so
  // extents grow ~1.2-1.3× vs. the tight AABB (measured at the default splits /
  // 60° fov / 16:9: cascade widths 54.2 → 69.2 m, 180.7 → 219.6 m,
  // 542.2 → 655.7 m, i.e. near cascade 3.4 cm/texel rather than 2.6). Stability
  // is worth the texels; that is the standard CSM trade.
  _tmpCenter.set(0, 0, 0);
  for (let i = 0; i < 8; i += 1) {
    _tmpCenter.add(_tmpFrustumCorners[i]);
  }
  _tmpCenter.multiplyScalar(1 / 8);
  let radiusSq = 0;
  for (let i = 0; i < 8; i += 1) {
    const d = _tmpFrustumCorners[i].distanceToSquared(_tmpCenter);
    if (d > radiusSq) radiusSq = d;
  }
  const radius = Math.max(1e-3, Math.sqrt(radiusSq));

  _placeCascade(light, _tmpCenter, radius, lx, ly, lz, mapSize, depthFit);
}

/**
 * Steps 3-6 of the fit, shared by the view-slice fit (`_fitCascade`) and the
 * stable cascades (shadows-restore-1; same operations in the same order, so
 * the view-slice fit is bit-identical to before the split): snap `center` to
 * whole texels of a `radius`-sphere's map in the world-anchored light frame,
 * then place the light, its target and the ortho frustum about it. Leaves the
 * snapped world centre in `_tmpSnap`. `depthFit` (shadows-restore-7): the light
 * sits `csmBackDistance` sunward and far = back + radius + pad, instead of the
 * fixed BACK_DIST_M / 2 * BACK_DIST_M + radius (unchanged, bit for bit, without).
 */
function _placeCascade(light, center, radius, lx, ly, lz, mapSize, depthFit) {
  // Step 3 — Light basis anchored at the WORLD ORIGIN. Anchoring it at the
  // frustum centre (as before) makes the centre trivially (0,0,-BACK_DIST_M)
  // in light space, so there is nothing left to snap; the snap has to happen
  // in a frame that does NOT move with the camera.
  // lookAt(eye, target, up) puts +Z along (eye - target), i.e. along the light
  // direction — same convention the old code got from (lightPos - centre).
  _tmpLightRot.lookAt(_tmpLightDir.set(lx, ly, lz), _ORIGIN, _tmpUp);
  _tmpLightRot.setPosition(_ORIGIN);
  _tmpLightRotInv.copy(_tmpLightRot).invert();

  // Step 4 — Snap the centre to whole texels in that fixed light frame, then
  // bring it back to world. Texel size is constant now, so the shadow map's
  // texels stop sliding under stationary geometry (anti-shimmer, for real).
  const texel = (radius * 2) / mapSize;
  _tmpSnap.copy(center).applyMatrix4(_tmpLightRotInv);
  _tmpSnap.x = Math.round(_tmpSnap.x / texel) * texel;
  _tmpSnap.y = Math.round(_tmpSnap.y / texel) * texel;
  _tmpSnap.applyMatrix4(_tmpLightRot);

  // Step 5 — Position the light BACK_DIST_M behind the snapped centre along
  // +lightDir (i.e. opposite the direction the light shines). shadows-restore-7
  // (depthFit): `back` instead — the whole sphere plus the caster lead.
  const back = depthFit === true ? csmBackDistance(radius, ly) : BACK_DIST_M;
  _tmpLightPos.set(
    _tmpSnap.x + lx * back,
    _tmpSnap.y + ly * back,
    _tmpSnap.z + lz * back
  );
  _tmpLightTarget.copy(_tmpSnap);
  light.position.copy(_tmpLightPos);
  light.target.position.copy(_tmpLightTarget);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();

  // Step 6 — Ortho frustum = the sphere's bounding square about the light
  // axis. near/far bracket the sphere with BACK_DIST_M of lead-in so casters
  // behind the camera still register — the same interval the old AABB form
  // produced (its `near` clamped to 0.1 in every practical configuration,
  // because the -BACK_DIST_M pull-back always drove it negative), only now
  // expressed in per-cascade constants instead of a per-frame measurement.
  const cam = light.shadow.camera;
  cam.left = -radius;
  cam.right = radius;
  cam.bottom = -radius;
  cam.top = radius;
  cam.near = CSM_NEAR_M;
  // shadows-restore-7 (depthFit): nothing past the sphere's far side can shade
  // a receiver inside it, so the range ends there (plus float slack).
  cam.far = depthFit === true ? back + radius + CSM_FAR_PAD_M : BACK_DIST_M * 2 + radius;
  cam.updateProjectionMatrix();
}

/**
 * Compute the 8 corners of a camera's perspective sub-frustum between
 * `near` and `far` (both > 0, near < far), in WORLD space. Writes into
 * the provided `out` array (8 THREE.Vector3 instances, populated in
 * NDC corner order).
 *
 * Approach: substitute custom near/far into the camera's projection
 * matrix to derive a temp projection, then unproject the NDC corners
 * through it + the camera's view matrix.
 */
function _frustumCornersWorld(camera, near, far, out) {
  // Build a temp projection matrix matching the camera's perspective
  // but with our custom near/far. For three.js PerspectiveCamera:
  //   fov vertical = camera.fov (degrees)
  //   aspect = camera.aspect
  //   zoom = camera.zoom (default 1)
  // makePerspective(left, right, top, bottom, near, far) — matches
  // three.js's PerspectiveCamera.updateProjectionMatrix.
  const top = near * Math.tan((_fitFov(camera) * 0.5 * Math.PI) / 180) / camera.zoom;
  const height = 2 * top;
  const width = camera.aspect * height;
  const left = -0.5 * width;
  // Three.js Matrix4.makePerspective's coordinateSystem argument
  // defaults to WebGLCoordinateSystem when undefined; the camera's
  // own `coordinateSystem` is the canonical source if set. Falling
  // through to the default keeps r184-and-later compatible.
  // F4 — module scratch, not fresh Matrix4s: this runs 3× per refit frame.
  _tmpProj.makePerspective(
    left, left + width,
    top, top - height,
    near, far,
    camera.coordinateSystem
  );
  // Invert to go from NDC → camera view space.
  _tmpInvProj.copy(_tmpProj).invert();

  for (let i = 0; i < 8; i += 1) {
    const c = NDC_CORNERS[i];
    const v = out[i];
    v.set(c[0], c[1], c[2]);
    v.applyMatrix4(_tmpInvProj);
    // camera.matrixWorld transforms view-space → world-space.
    v.applyMatrix4(camera.matrixWorld);
  }
}
