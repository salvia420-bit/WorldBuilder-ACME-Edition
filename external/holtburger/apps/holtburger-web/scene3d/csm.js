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
// Per-frame: `updateCsm(csmState, camera)` tightly fits each cascade's
// orthographic shadow camera to the player-visible portion of that
// cascade range. Frustum-fitting follows the standard CSM recipe
// (see learnopengl.com Guest-Articles/2021/CSM):
//   1. Compute 8 corner points of the camera's perspective sub-frustum
//      between near=splitN and far=splitN+1 in world space.
//   2. Transform corners into the light's view space.
//   3. Take the AABB of the transformed corners.
//   4. Set the cascade's ortho camera to that AABB.
//   5. Pull the near plane back by `BACK_DIST_M` so casters BEHIND the
//      camera (relative to the light direction) still register.
//
// Texel snapping (anti-shimmer): each cascade's ortho frustum centre
// is snapped to integer texel increments so the shadow map's depth
// values don't drift sub-texel frame-to-frame, which would produce
// per-pixel shimmer on stationary geometry as the player walks.
// Mirrors Phase 0.1's `updateShadowCameraTarget` snap logic.
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
const CAM_DELTA_SQ_EPS = 1e-4; // m²
const SUN_DELTA_SQ_EPS = 1e-6; // unit-vector²

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
    // remain.
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
  // NaN propagates through subtraction, so on first call (cached NaNs)
  // both deltaSq will be NaN, NaN < eps is false → we fall through to
  // the rebuild path. Subsequent frames compare real numbers.
  if (camDeltaSq < CAM_DELTA_SQ_EPS && sunDeltaSq < SUN_DELTA_SQ_EPS) {
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
export function refreshCsmUniforms(csmState) {
  if (!csmState?.patchedMaterials) return;
  const lights = csmState.lights;
  // splits + blendFrac don't change per frame in the common case
  // (splits are a setup-time choice). The uniform values for these
  // are already baked at install; we only refresh per-frame shadow
  // matrices + map textures (those change as cameras / lights move).
  for (const mat of csmState.patchedMaterials) {
    const u = mat.userData?.csmShaderUniforms;
    if (!u) continue;
    for (let i = 0; i < 3; i += 1) {
      const light = lights[i];
      if (!light) continue;
      if (u[`uCsmShadowMap${i}`]) {
        // light.shadow.map is created lazily on first render; until
        // it lands, leave the stale uniform value (the shader will
        // see the previous frame's texture, which is fine for a
        // single-frame discontinuity).
        const tex = light.shadow?.map?.texture ?? null;
        if (tex) u[`uCsmShadowMap${i}`].value = tex;
      }
      if (u[`uCsmMatrix${i}`]) {
        // Three composes shadow.matrix as
        //   biasMatrix * cam.projectionMatrix * cam.matrixWorldInverse
        // so it transforms world → shadow-NDC[0,1]. We can sample
        // `shadow.map.texture` directly at `xy` of the result.
        u[`uCsmMatrix${i}`].value.copy(light.shadow.matrix);
      }
    }
    if (u.uCsmSplits) {
      u.uCsmSplits.value.set(csmState.splits[0], csmState.splits[1]);
    }
    if (u.uCsmFar) {
      u.uCsmFar.value = csmState.splits[2];
    }
    if (u.uCsmBlend) {
      u.uCsmBlend.value = csmState.blendFrac;
    }
  }
}

// ---- Internal: per-cascade frustum fit ------------------------------

const _tmpFrustumCorners = new Array(8);
for (let i = 0; i < 8; i += 1) _tmpFrustumCorners[i] = new THREE.Vector3();
const _tmpAabbMin = new THREE.Vector3();
const _tmpAabbMax = new THREE.Vector3();
const _tmpCenter = new THREE.Vector3();
const _tmpLightView = new THREE.Matrix4();
const _tmpUp = new THREE.Vector3(0, 1, 0);
const _tmpLightPos = new THREE.Vector3();
const _tmpLightTarget = new THREE.Vector3();

function _fitCascade(light, camera, near, far, lx, ly, lz, mapSize) {
  // Step 1 — Compute the 8 corners of the camera's sub-frustum between
  // `near` and `far` in WORLD space.
  _frustumCornersWorld(camera, near, far, _tmpFrustumCorners);

  // Step 2 — Compute the sub-frustum centroid in world space. We
  // anchor the light position relative to this so the shadow camera
  // tracks the player's local view.
  _tmpCenter.set(0, 0, 0);
  for (let i = 0; i < 8; i += 1) {
    _tmpCenter.add(_tmpFrustumCorners[i]);
  }
  _tmpCenter.multiplyScalar(1 / 8);

  // Step 3 — Build the light's view matrix anchored at the centroid
  // looking down the negative light direction (towards the scene).
  // `lightPos` sits BACK_DIST_M behind the centroid along +lightDir
  // (i.e. opposite the direction the light shines).
  _tmpLightPos.set(
    _tmpCenter.x + lx * BACK_DIST_M,
    _tmpCenter.y + ly * BACK_DIST_M,
    _tmpCenter.z + lz * BACK_DIST_M
  );
  _tmpLightTarget.copy(_tmpCenter);
  // makeLookAt is camera-style: it returns a matrix that puts (0,0,-1)
  // looking at target. The shadow camera's matrixWorldInverse is what
  // we actually need to transform world→light-view, so build that.
  _tmpLightView.lookAt(_tmpLightPos, _tmpLightTarget, _tmpUp);
  _tmpLightView.setPosition(_tmpLightPos);
  // Invert to get world → light view.
  _tmpLightView.invert();

  // Step 4 — Transform every corner into light view space, compute AABB.
  _tmpAabbMin.set(Infinity, Infinity, Infinity);
  _tmpAabbMax.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i += 1) {
    const v = _tmpFrustumCorners[i].clone().applyMatrix4(_tmpLightView);
    if (v.x < _tmpAabbMin.x) _tmpAabbMin.x = v.x;
    if (v.y < _tmpAabbMin.y) _tmpAabbMin.y = v.y;
    if (v.z < _tmpAabbMin.z) _tmpAabbMin.z = v.z;
    if (v.x > _tmpAabbMax.x) _tmpAabbMax.x = v.x;
    if (v.y > _tmpAabbMax.y) _tmpAabbMax.y = v.y;
    if (v.z > _tmpAabbMax.z) _tmpAabbMax.z = v.z;
  }

  // Step 5 — Texel snap the AABB centre to the cascade's texel size.
  // Frustum width = aabbMax.x - aabbMin.x. Texel size = width / mapSize.
  // Snap centre to integer texels so depth values don't drift sub-texel
  // frame-to-frame (anti-shimmer).
  const widthX = _tmpAabbMax.x - _tmpAabbMin.x;
  const widthY = _tmpAabbMax.y - _tmpAabbMin.y;
  const texelX = widthX / mapSize;
  const texelY = widthY / mapSize;
  if (texelX > 0 && texelY > 0) {
    const cx = (_tmpAabbMin.x + _tmpAabbMax.x) * 0.5;
    const cy = (_tmpAabbMin.y + _tmpAabbMax.y) * 0.5;
    const snappedCx = Math.round(cx / texelX) * texelX;
    const snappedCy = Math.round(cy / texelY) * texelY;
    const halfW = widthX * 0.5;
    const halfH = widthY * 0.5;
    _tmpAabbMin.x = snappedCx - halfW;
    _tmpAabbMax.x = snappedCx + halfW;
    _tmpAabbMin.y = snappedCy - halfH;
    _tmpAabbMax.y = snappedCy + halfH;
  }

  // Step 6 — Configure the cascade's shadow camera. Position the light
  // BACK_DIST_M behind the centroid along +lightDir. Set ortho frustum
  // to AABB.
  light.position.copy(_tmpLightPos);
  light.target.position.copy(_tmpLightTarget);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();

  const cam = light.shadow.camera;
  cam.left = _tmpAabbMin.x;
  cam.right = _tmpAabbMax.x;
  cam.bottom = _tmpAabbMin.y;
  cam.top = _tmpAabbMax.y;
  // Near/far in light-view space. The light's view origin is at
  // _tmpLightPos which is BACK_DIST_M behind the centroid; the AABB's
  // -Z extent (light view) is the deepest caster. We want
  //   near = aabbMax.z (closest plane to light)
  //   far  = aabbMin.z (deepest plane from light)
  // but light.shadow.camera is positioned at light.position with its
  // -Z axis pointing towards target — so distances are negated.
  //
  // Practical: pull near back by BACK_DIST_M too, so casters that are
  // technically behind the camera (but still in the shadow's path)
  // contribute.
  const nearZ = -_tmpAabbMax.z - BACK_DIST_M;
  const farZ = -_tmpAabbMin.z + BACK_DIST_M;
  cam.near = Math.max(0.1, nearZ);
  cam.far = farZ;
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
  const proj = new THREE.Matrix4().makePerspective(
    left, left + width,
    top, top - height,
    near, far,
    camera.coordinateSystem
  );
  // Invert to go from NDC → camera view space.
  const invProj = new THREE.Matrix4().copy(proj).invert();
  // camera.matrixWorld transforms view-space → world-space.
  const viewToWorld = new THREE.Matrix4().copy(camera.matrixWorld);

  for (let i = 0; i < 8; i += 1) {
    const c = NDC_CORNERS[i];
    const v = out[i];
    v.set(c[0], c[1], c[2]);
    v.applyMatrix4(invProj);
    v.applyMatrix4(viewToWorld);
  }
}
