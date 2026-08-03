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
 * @returns {{
 *   lights: THREE.DirectionalLight[3],
 *   splits: number[],
 *   blendFrac: number,
 *   sunDir: {x:number,y:number,z:number},
 *   csmGroup: THREE.Group,
 *   patchedMaterials: Set<THREE.Material>,
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
    // Receivers' materials register here once patched, so we can refresh
    // uniforms after each `updateCsm` without re-walking the scene.
    patchedMaterials: new Set(),
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
      // RP5 — a forced rebuild WILL refit on the next updateCsm, so the
      // static-shadow gate must re-raster that frame. Mark it now so even
      // if the gate is read before updateCsm runs, it errs toward drawing.
      this.didRefitThisTick = true;
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
  if (!camera.isPerspectiveCamera) {
    // Top-down ortho path — cascades can't sensibly fit an ortho view
    // frustum's depth slices. Skip; the cached defaults from setupCsm
    // remain. RP5 — no refit happened, so the static-shadow gate must
    // NOT treat this frame as a re-raster trigger on its own.
    csmState.didRefitThisTick = false;
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
  const projChanged =
    camera.fov !== csmState._lastCamFov ||
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
      csmState.mapSizes[i]
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
  csmState._lastCamFov = camera.fov;
  csmState._lastCamAspect = camera.aspect;
  csmState._lastCamNear = camera.near;
  csmState._lastCamZoom = camera.zoom;
  // RP5 — cascades were refit this tick (camera and/or sun moved). The
  // static-scene shadow-raster gate treats this as "shadows changed →
  // re-raster this frame".
  csmState.didRefitThisTick = true;
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
function _csmUniformRefs(mat) {
  const u = mat.userData?.csmShaderUniforms;
  if (!u) return null;
  const cached = mat.userData.__csmUniformRefs;
  if (cached && cached.src === u) return cached;
  const refs = {
    src: u,
    maps: [u.uCsmShadowMap0 || null, u.uCsmShadowMap1 || null, u.uCsmShadowMap2 || null],
    mats: [u.uCsmMatrix0 || null, u.uCsmMatrix1 || null, u.uCsmMatrix2 || null],
    splits: u.uCsmSplits || null,
    far: u.uCsmFar || null,
    blend: u.uCsmBlend || null,
  };
  Object.defineProperty(mat.userData, "__csmUniformRefs", {
    value: refs,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return refs;
}

export function refreshCsmUniforms(csmState) {
  if (!csmState?.patchedMaterials) return;
  const lights = csmState.lights;
  // splits + blendFrac don't change per frame in the common case
  // (splits are a setup-time choice). The uniform values for these
  // are already baked at install; we only refresh per-frame shadow
  // matrices + map textures (those change as cameras / lights move).
  for (const mat of csmState.patchedMaterials) {
    const refs = _csmUniformRefs(mat);
    if (!refs) continue;
    for (let i = 0; i < 3; i += 1) {
      const light = lights[i];
      if (!light) continue;
      const mapU = refs.maps[i];
      if (mapU) {
        // light.shadow.map is created lazily on first render; until
        // it lands, leave the stale uniform value (the shader will
        // see the previous frame's texture, which is fine for a
        // single-frame discontinuity).
        const tex = light.shadow?.map?.texture ?? null;
        if (tex) mapU.value = tex;
      }
      const matU = refs.mats[i];
      if (matU) {
        // Three composes shadow.matrix as
        //   biasMatrix * cam.projectionMatrix * cam.matrixWorldInverse
        // so it transforms world → shadow-NDC[0,1]. We can sample
        // `shadow.map.texture` directly at `xy` of the result.
        matU.value.copy(light.shadow.matrix);
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

function _fitCascade(light, camera, near, far, lx, ly, lz, mapSize) {
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
  _tmpSnap.copy(_tmpCenter).applyMatrix4(_tmpLightRotInv);
  _tmpSnap.x = Math.round(_tmpSnap.x / texel) * texel;
  _tmpSnap.y = Math.round(_tmpSnap.y / texel) * texel;
  _tmpSnap.applyMatrix4(_tmpLightRot);

  // Step 5 — Position the light BACK_DIST_M behind the snapped centre along
  // +lightDir (i.e. opposite the direction the light shines).
  _tmpLightPos.set(
    _tmpSnap.x + lx * BACK_DIST_M,
    _tmpSnap.y + ly * BACK_DIST_M,
    _tmpSnap.z + lz * BACK_DIST_M
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
  cam.near = 0.1;
  cam.far = BACK_DIST_M * 2 + radius;
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
  const top = near * Math.tan((camera.fov * 0.5 * Math.PI) / 180) / camera.zoom;
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
