// Phase 7.6 + 7.6.1 (3D port follow-on #1) — scene lighting.
//
// Module exports:
//
//   - `setupSceneLighting(scene, opts)` — attaches sun + ambient
//     (+ optional hemisphere) to the Scene. Returns the handles
//     stashed on `liveScene3d.lighting`.
//   - `tickLightingForCellState(scene3d, sessionHandle)` — per-frame
//     hook that:
//       (a) flips sun.visible + boosts ambient.intensity when the
//           wasm cell BFS reports `isCurrentCellIndoor() === true`.
//       (b) sorts `scene3d.activeLights` by squared distance to the
//           active camera and flips `.visible` so only the closest
//           `MAX_ACTIVE_LIGHTS` (32) render — the rest stay parented
//           but contribute nothing.
//   - `attachSetupModelLights(scene3d, wasmExports)` — Phase 7.6.1
//     (follow-on #1) per-SetupModel point/spot lights. Walks every
//     unique setup id used by Holtburg's buildings/statics/entities/
//     cells, calls `wasmExports.fetchSetupModelLights(setupId)`, and
//     parents one `THREE.PointLight` (when `cone_angle == 0`) or
//     `THREE.SpotLight` (when `cone_angle > 0`) per `SetupLight` under
//     the matching part `Object3D` (so the light moves with the rig).
//
// Direction convention: the sun is positioned in three.js WORLD space
// at +x east, +y up, +z south (three.js is Y-up). The
// `setupSceneLighting` API takes the light at the scene root (NOT under
// `worldRoot` which carries the AC-Z-up→three-Y-up rotation), so the
// caller passes a sun position that already lives in the three.js
// Y-up frame. We pick a 45° down-east vector for a 3 PM-ish AC
// daylight feel.
//
// Per-SetupModel lights ARE children of part `Object3D`s — which are
// children of `worldRoot` — so the AC→three rotation is applied to
// them automatically. Their LightInfo.viewer_space_location.origin is
// part-LOCAL in AC coords, which is exactly what
// `Object3D.position.set(x, y, z)` consumes when the Object3D's parent
// is a per-part group in AC coords. No special transform.
//
// Indoor toggle: `tickLightingForCellState` reads
// `sessionHandle.isCurrentCellIndoor()` once per frame. When true,
// `sun.visible = false` and `ambient.intensity` is raised to 0.7 so
// dungeon corridors stay legible without being daylight-bright. When
// false (outdoors), `sun.visible = true` and ambient drops back to
// the outdoor baseline of 0.5. Hard switch (no lerp) — adequate for
// portal-graph transitions which already have a brief async pause
// while EnvCell groups load.
//
// Per-light cap: `MAX_ACTIVE_LIGHTS = 32`. WebGL2's uniform array
// limit varies by GPU (typically 64-256), but three.js
// MeshStandardMaterial recompiles its shader when light counts
// change, so a deterministic cap keeps shader variance low and
// frame-time stable even on dense dungeon scenes. Sort-by-squared-
// distance is one Vector3.distanceToSquared() per light per tick;
// for the few-hundred light count Holtburg's dungeon decorations
// produce, this is sub-microsecond.

import * as THREE from "three";
import { setupCsm, updateCsm, refreshCsmUniforms } from "./csm.js";
import { lbKeyOf } from "./landblock_lru.js";

// Default sun direction in three.js world space (Y-up). 45° down +
// east-ish so hillshading on the south-facing slopes of Holtburg
// reads as bright while north-facing crannies stay shaded — matches
// the static-site RenderPreviewRenderer baseline.
const DEFAULT_SUN_POS = { x: 60, y: 80, z: 30 };

// Outdoor + indoor ambient intensities. Indoor is higher because the
// sun goes off when isCurrentCellIndoor() flips true; without the
// boost, dungeon corridors would crush to near-black.
const AMBIENT_INTENSITY_OUTDOOR = 0.5;
const AMBIENT_INTENSITY_INDOOR = 0.7;

// Warm tint on the ambient — matches AC's pre-lit terrain textures
// which carry a faintly warm bias. 0xfff0e0 is roughly Kelvin ~5500K
// (afternoon sun) with the chroma pulled back so it reads as ambient,
// not directional. Used only as the fail-soft fallback when no
// SkyState snapshot is available (L1 below drives color from the
// snapshot once one exists).
const AMBIENT_COLOR = 0xfff0e0;

// === L1 (render-completeness waves-2, 2026-05-29) — AC diurnal ambient ===
// Retail per-channel lit is `sun·NdotL + ambColor·ambient_level`, clamped
// [0,1], with `ambient_level` floored at LSCAPE_LIGHT_MINIMUM = 0.2
// (acclient.c:40344 constant; floor applied in LScape::set_landscape_lighting
// acclient.c:307024; per-channel combine acclient.c:353860-353899). Holtburg
// already parses + time-lerps the snapshot to SkyState.ambBright /
// ambColorArgb (lib.rs:9645-9699; snapshot in sky_lighting.js:52), but until
// now NOTHING consumed it — legacy ambient was a flat 0.5/0.7 constant and
// the atmosphere SkyLightProbe had no amb term. This drives the legacy
// AmbientLight intensity + color from the snapshot. (Atmosphere/probe path
// is driven in atmosphere_lights.js's tick().) Default-on, fail-soft: with
// no snapshot we keep the prior constant 0.5/0.7 + AMBIENT_COLOR.
const LSCAPE_LIGHT_MINIMUM = 0.2;

/**
 * Unpack AC's ARGB u32 ambient color (0xAARRGGBB) into a normalized
 * {r,g,b} triple in [0,1]. Alpha is ignored (THREE.AmbientLight.color is
 * RGB only). Mirrors lib.rs collect_setup_model_lights ARGB unpack +
 * sky_lighting.js decodeArgb. Returns null on a non-finite / zero input
 * so the caller can fail-soft to the constant tint.
 */
function ambColorFromArgb(argb) {
  const u = argb >>> 0;
  if (!Number.isFinite(u) || u === 0) return null;
  return {
    r: ((u >>> 16) & 0xff) / 255,
    g: ((u >>> 8) & 0xff) / 255,
    b: (u & 0xff) / 255,
  };
}

/**
 * L1 — resolve the AC-faithful ambient (intensity floored at 0.2, color
 * from the ARGB snapshot) for the OUTDOOR case. Indoor keeps the legacy
 * 0.7 boost (the sun goes off indoors, so the snapshot ambient alone
 * would crush dungeon corridors — the indoor boost is a deliberate
 * legibility lever, not a retail value). Returns null when no usable
 * snapshot exists so the caller leaves the constant behavior intact.
 *
 * @param {Object|null} skyState - the cached SkyState snapshot
 *   (`skyLightingController._lastState`); camelCase ambBright/ambColorArgb.
 * @returns {{intensity:number, color:{r,g,b}|null}|null}
 */
function resolveDiurnalAmbient(skyState) {
  if (!skyState) return null;
  const ambBright = +skyState.ambBright;
  if (!Number.isFinite(ambBright)) return null;
  const intensity = Math.max(LSCAPE_LIGHT_MINIMUM, ambBright);
  const color = ambColorFromArgb(skyState.ambColorArgb);
  return { intensity, color };
}

// Sun colour — slightly cooler than the ambient so the directional
// vs. ambient contrast doesn't read as "two warm lights stacked".
const SUN_COLOR = 0xfff2cc;

// Hemisphere light (optional) — adds a sky/ground tint to props that
// don't catch the direct sun. Outdoor scenes only — turned off when
// `setupSceneLighting`'s caller opts out via `includeHemisphere:
// false` (e.g. dungeon-first capture flows).
const HEMI_SKY = 0xb0c8ff;
const HEMI_GROUND = 0x504030;
const HEMI_INTENSITY = 0.15;

/**
 * Attach a directional sun + ambient (+ optional hemisphere) to the
 * Scene's root. The lights live OUTSIDE `worldRoot` (i.e. directly
 * under `scene`) so the AC-Z-up→three-Y-up rotation doesn't apply to
 * them — sun.position is already specified in three.js world space.
 *
 * @param {THREE.Scene} scene - the root scene from `init3D`.
 * @param {Object} opts
 * @param {boolean} [opts.castShadow=false] - whether the directional
 *   light should cast shadows. False by default; enabling this also
 *   requires the renderer's `shadowMap.enabled = true` flag and
 *   tagging every mesh with `castShadow`/`receiveShadow`.
 *   Phase 7.6 ships without shadows enabled (frame-budget headroom
 *   audit lives in Phase 7.7).
 * @param {number} [opts.sceneSize=600] - approximate scene radius in
 *   metres. Sizes the shadow camera's orthographic frustum (only
 *   used when `castShadow === true`). Holtburg's 9-LB neighbourhood
 *   is roughly 576 m square, so 600 m is the natural default.
 * @param {boolean} [opts.includeHemisphere=true] - whether to add a
 *   HemisphereLight. Defaults true. Set false for dungeon-only test
 *   harnesses.
 * @param {Object} [opts.sunPos] - override the default sun position.
 *   `{ x, y, z }` in three.js world space (Y-up).
 *
 * @returns {{
 *   sun: THREE.DirectionalLight,
 *   ambient: THREE.AmbientLight,
 *   hemisphere: THREE.HemisphereLight | null,
 *   lightsGroup: THREE.Group,
 *   dispose: () => void,
 * }}
 */
export function setupSceneLighting(scene, opts = {}) {
  const {
    castShadow = false,
    sceneSize = 600,
    includeHemisphere = true,
    sunPos = DEFAULT_SUN_POS,
    // Visual-fidelity Phase 3.3 — opt into Cascaded Shadow Maps. When
    // true, the sun light's own `castShadow` is forced OFF and three
    // shadow-only DirectionalLights are constructed via `setupCsm` to
    // render per-cascade shadow maps. The two paths are mutually
    // exclusive: when csm:true is passed, the Phase 0.1 single-shadow
    // wiring (sun.castShadow=true) is bypassed entirely.
    csm = false,
  } = opts;

  if (!scene || typeof scene.add !== "function") {
    throw new Error(
      "setupSceneLighting: `scene` must be a THREE.Scene (or .add-able root)"
    );
  }

  const lightsGroup = new THREE.Group();
  lightsGroup.name = "lights";

  // Directional sun. Position is in three.js world space (Y-up).
  // The default is 45° down + east-ish so south-facing Holtburg
  // slopes read bright.
  const sun = new THREE.DirectionalLight(SUN_COLOR, 1.0);
  sun.position.set(sunPos.x, sunPos.y, sunPos.z);
  sun.target.position.set(0, 0, 0);
  sun.name = "sun";

  // CSM mode: the sun's own shadow is OFF; the 3 cascade lights
  // (constructed below) generate shadow maps. CSM and the Phase 0.1
  // single-shadow path are mutually exclusive — picking CSM here means
  // we do NOT run the Phase 0.1 single-shadow setup, regardless of
  // `castShadow` opt-in.
  const csmEnabled = !!csm;
  if (castShadow && !csmEnabled) {
    sun.castShadow = true;
    // Visual-fidelity Phase 0.1 — shadow camera frustum sized so its
    // half-extent equals `sceneSize`. At the default sceneSize=600,
    // the frustum is a 1200 m square (sceneSize each direction from
    // the centre); per-frame `updateShadowCameraTarget` recentres
    // that box on the player so the 3x3 LB ring (~576 m square)
    // stays well inside. Texel size at 2048^2 / 1200 m ≈ 0.59 m,
    // which renders building-scale shadows cleanly; sub-meter detail
    // (NPC armour creases) blurs but never disappears. Phase 3.3
    // swaps this for CSM if shadow resolution becomes a complaint.
    const halfSize = sceneSize;
    const shadowCam = sun.shadow.camera;
    shadowCam.left = -halfSize;
    shadowCam.right = halfSize;
    shadowCam.top = halfSize;
    shadowCam.bottom = -halfSize;
    shadowCam.near = 0.1;
    shadowCam.far = sceneSize * 4;
    shadowCam.updateProjectionMatrix();
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    // Soft-shadow bleed reduction — PCFSoftShadowMap reads radius=4
    // texels by default; nudging the normalBias keeps the shadow
    // tight against the caster's silhouette so building corners don't
    // float over their own shadow.
    sun.shadow.normalBias = 0.05;
  }

  // Ambient — outdoor baseline. `tickLightingForCellState` raises
  // this to AMBIENT_INTENSITY_INDOOR when indoor.
  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY_OUTDOOR);
  ambient.name = "ambient";

  lightsGroup.add(sun);
  lightsGroup.add(sun.target);
  lightsGroup.add(ambient);

  let hemisphere = null;
  if (includeHemisphere) {
    hemisphere = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
    hemisphere.name = "hemisphere";
    lightsGroup.add(hemisphere);
  }

  // Problem-A fix — allocate the fixed light pool BEFORE the first render so
  // its per-type count is the constant the renderer compiles against from frame
  // 0. No-op (lightPool stays null) unless `?lightPool=on`.
  let lightPool = null;
  const lpCfg = getLightPoolConfig();
  if (lpCfg.enabled) {
    lightPool = allocateLightPool(lightsGroup, lpCfg);
  }

  scene.add(lightsGroup);

  // Visual-fidelity Phase 3.3 — when caller opts into CSM, instantiate
  // the three cascade shadow lights. They share the sun's direction
  // (derived from sunPos.minus(target=origin) = sunPos itself, since
  // the sun targets world origin by default). The bundle's
  // `patchedMaterials` Set tracks every material that subsequently
  // installs the CSM shader patch — `refreshCsmUniforms` walks it each
  // tick to push fresh shadow-map textures + matrices.
  let csmState = null;
  if (csmEnabled) {
    // RP5 — pass through the optional CSM refit-threshold overrides
    // (?csmCamEps / ?csmSunEps). When absent (null), setupCsm falls back
    // to its own validated CAM/SUN_DELTA_SQ_EPS defaults, so this is a
    // no-op on the default URL.
    const rp5 = getRp5Config();
    const csmOpts = { sunDir: { x: sunPos.x, y: sunPos.y, z: sunPos.z } };
    if (rp5.csmCamEps !== null) csmOpts.camDeltaSqEps = rp5.csmCamEps;
    if (rp5.csmSunEps !== null) csmOpts.sunDeltaSqEps = rp5.csmSunEps;
    csmState = setupCsm(scene, csmOpts);
  }

  function dispose() {
    if (sun.shadow && sun.shadow.map && typeof sun.shadow.map.dispose === "function") {
      sun.shadow.map.dispose();
    }
    if (csmState && typeof csmState.dispose === "function") {
      csmState.dispose();
    }
    scene.remove(lightsGroup);
    // RP5 (review fix) — restore three's default per-frame raster cadence
    // on the renderer the static-shadow gate took over. The renderer is
    // owned outside this bundle and can outlive a lighting dispose (soft
    // 3D→2D→3D re-init reusing the same WebGLRenderer); leaving it at
    // autoUpdate=false would freeze a reused renderer's shadows until the
    // next gated session re-warmed them. The gate stashes the renderer it
    // gated on `bundle._rp5GatedRenderer`; restore autoUpdate=true there.
    const gatedRenderer = bundle._rp5GatedRenderer;
    if (gatedRenderer?.shadowMap && gatedRenderer.shadowMap.autoUpdate === false) {
      gatedRenderer.shadowMap.autoUpdate = true;
    }
    bundle._rp5GatedRenderer = null;
  }

  const bundle = { sun, ambient, hemisphere, lightsGroup, csmState, lightPool, dispose };
  return bundle;
}

/**
 * Visual-fidelity Phase 0.1 — recentre the directional light's shadow
 * camera frustum on a follow point each frame. The orthographic
 * shadow frustum is configured with extent `[-sceneSize, +sceneSize]`
 * in each axis, so a fixed target at world origin would lose any
 * caster more than `sceneSize` metres away from origin. Holtburg's
 * LB is at AC world (0xA9 * 192, 0xB4 * 192) ≈ (32,448, 34,560) — vastly
 * outside the default frustum. Recentring the sun's `target` on the
 * player's three.js-world position keeps the frustum tracking
 * wherever the player goes.
 *
 * The sun's `position` is also translated by the same delta so the
 * light direction stays constant (translating both the source and the
 * target by the same vector preserves the direction unit vector). For
 * an orthographic shadow camera, only the direction matters for
 * shadow projection; preserving direction means shadow angles match
 * across the world.
 *
 * @param {{sun: THREE.DirectionalLight}} lighting - the bundle from
 *   setupSceneLighting. Caller is responsible for ensuring `sun
 *   .castShadow === true` before calling.
 * @param {{x: number, y: number, z: number} | null | undefined} targetThreePos -
 *   the recenter point in three.js world space (Y-up). The sun's
 *   target moves to (x, 0, z) ignoring the input y — we keep the
 *   target at ground level so the shadow frustum's near/far slice
 *   is always anchored on the terrain plane.
 * @returns {boolean} RP5 — true when the shadow frustum actually moved
 *   this call (the texel-snapped target changed), false when it was
 *   already at the snapped position. The single-shadow static-scene
 *   raster gate consumes this as its "camera moved → re-raster" signal.
 */
export function updateShadowCameraTarget(lighting, targetThreePos) {
  if (!lighting || !targetThreePos) return false;
  const sun = lighting.sun;
  if (!sun || !sun.castShadow) return false;
  const target = sun.target;
  if (!target) return false;
  // Cache the original light direction (computed lazily once; the
  // sun's initial position vs. its target.position is the direction
  // vector we want to preserve as the target slides under the player).
  if (!lighting._shadowSunDir) {
    const dx = sun.position.x - target.position.x;
    const dy = sun.position.y - target.position.y;
    const dz = sun.position.z - target.position.z;
    lighting._shadowSunDir = { x: dx, y: dy, z: dz };
  }
  const tx = targetThreePos.x;
  const tz = targetThreePos.z;
  // Snap the target to texel-aligned increments to reduce shimmer as
  // the player walks. PCF reads ±2 texels; an integer-texel-rounded
  // target keeps the depth lookup stable frame-to-frame. Texel size
  // is (frustum width) / mapSize.
  const frustumW = sun.shadow.camera.right - sun.shadow.camera.left;
  const mapW = sun.shadow.mapSize.x || 2048;
  const texelM = frustumW / mapW;
  const snapTx = Math.round(tx / texelM) * texelM;
  const snapTz = Math.round(tz / texelM) * texelM;
  if (target.position.x !== snapTx || target.position.z !== snapTz) {
    target.position.set(snapTx, 0, snapTz);
    // Translate the sun source by the same delta so the direction
    // stays fixed. Re-anchor by re-applying the cached dir to the
    // (new) target.
    const dir = lighting._shadowSunDir;
    sun.position.set(snapTx + dir.x, dir.y, snapTz + dir.z);
    // three.js needs `target.updateMatrixWorld` so the shadow camera
    // re-derives its view matrix this frame.
    target.updateMatrixWorld();
    sun.shadow.camera.updateProjectionMatrix();
    return true; // RP5 — frustum moved this frame.
  }
  return false; // RP5 — already texel-snapped; nothing moved.
}

// Maximum number of per-SetupModel lights allowed to render in any
// one frame. Lights beyond this are kept in the graph but their
// `.visible` flag is flipped off; sorting by distance ensures the
// closest ones always win. 32 is a defensive cap — WebGL2's uniform
// array headroom is well above this on every modern GPU, but
// MeshStandardMaterial recompiles its shader when light counts
// change, so a fixed cap keeps shader-variance low.
const MAX_ACTIVE_LIGHTS = 32;

// Perf C6 — throttle the per-frame light distance sort. We only re-
// sort `scene3d.activeLights` every Nth call to `capActiveLightsByDistance`
// (unless the active light count has changed, in which case we sort
// immediately so a fresh light doesn't sit invisible behind the cap).
// N=4 trades up to 3 frames of staleness on the .visible top-32 set
// for ~75% fewer sorts (a 0.5–1 ms win at ~200-light dungeon density).
// The trade-off: a light that crosses the cap boundary by moving (player
// or light translating) may pop in/out one tick late, visible only at
// the very edge of the 32-light radius. The cap-cross handler (light
// count delta) is always honoured so genuine spawn/despawn isn't
// throttled. Bump higher (8) if frametime audits show more headroom
// is wanted at the cost of more boundary pop.
const LIGHT_SORT_INTERVAL = 4;

// === RP5 (lighting/shadow perf, 2026-06-08) — config knobs ===========
// All parsed ONCE at module load (mirrors the ?fogLerp / ?frameBudget /
// ?netDrainHz pattern used across this stack) and fail-soft to the
// defaults in the Node harness (no `window`). Every lever is reversible
// via URL flag; the static-shadow gate is the only one that touches the
// renderer, and it does so as a PURE raster-skip control (see below).
//
//   ?shadowStaticGate=off   disable the static-scene shadow-raster skip
//                           entirely (renderer.shadowMap.autoUpdate stays
//                           true → three rasters all 3 cascade maps every
//                           frame, pre-RP5 behaviour).
//   ?lightSortInterval=<n>  override LIGHT_SORT_INTERVAL (1..240). Default
//                           4 (PARITY-PRESERVING — same as the prior
//                           hard-coded LIGHT_SORT_INTERVAL). The cap-cross
//                           guard re-sorts immediately on any active-light
//                           count change, so a longer interval only delays
//                           the rare same-count move-across-the-32-boundary
//                           pop, not genuine spawn/despawn — operators who
//                           want the extra headroom can opt INTO 8 via
//                           ?lightSortInterval=8 (was briefly the default;
//                           reverted to 4 to keep the default cap-boundary
//                           pop behaviour byte-identical to pre-RP5).
//   ?shadowMaxStale=<n>     RP5 staleness ceiling: a SECONDARY bound (the
//                           per-caster movement scan re-rasters moving rigs
//                           immediately) that forces a re-raster at least
//                           every N frames so the residual cases (in-place
//                           limb animation, geometry streaming in while
//                           stationary, context restore) can't freeze a
//                           shadow. Default 12 (~200 ms @60fps, ~400 ms
//                           @30fps). `0`/`off` does NOT fully drop the
//                           ceiling — it's CLAMPED to a 60-frame (~1 s)
//                           floor so a permanent freeze is impossible (RED
//                           LINE). An explicit small N (e.g. 1 = every
//                           frame) is honoured as-is (only raises raster
//                           frequency, always safe).
//   ?csmCamEps=<m2> ?csmSunEps=<v2>  override the CSM refit thresholds
//                           (squared metres / squared unit-vector). Larger
//                           = fewer refits + (because the static-shadow
//                           gate reuses the refit decision) fewer rasters,
//                           at the cost of shadow swim on slow pans. Omit
//                           to keep csm.js's validated defaults.

const RP5_DEFAULT_SHADOW_MAX_STALE = 12;
// RP5 (review fix) — hard floor for the staleness ceiling. `?shadowMaxStale=off`
// / `=0` is clamped to this instead of fully dropping the ceiling, so even the
// residual cases the per-caster movement scan can't see (WebGL context restore
// on the single-shadow path, geometry streaming in while stationary, in-place
// limb animation) ALWAYS self-heal within ~1 s. The gate must never produce a
// permanently-stale shadow (RED LINE), so a true zero ceiling is not offered.
const SHADOW_MAX_STALE_FLOOR = 60;
// PARITY: default == the prior hard-coded LIGHT_SORT_INTERVAL (4). Bumping
// the default to 8 doubled the worst-case same-count cap-boundary pop on the
// DEFAULT URL (3→7 frames) without an opt-in, so the default is held at 4;
// ?lightSortInterval=8 opts into the longer interval for more headroom.
const RP5_DEFAULT_LIGHT_SORT_INTERVAL = 4;

function _rp5ReadParams() {
  if (typeof window === "undefined" || !window.location) return null;
  try {
    return new URLSearchParams(window.location.search);
  } catch (_) {
    return null;
  }
}

let _rp5Config;
function getRp5Config() {
  if (_rp5Config !== undefined) return _rp5Config;
  const cfg = {
    shadowStaticGate: true,
    lightSortInterval: RP5_DEFAULT_LIGHT_SORT_INTERVAL,
    shadowMaxStaleFrames: RP5_DEFAULT_SHADOW_MAX_STALE,
    csmCamEps: null, // null ⇒ use csm.js's validated default
    csmSunEps: null,
  };
  const ps = _rp5ReadParams();
  if (ps) {
    const gate = ps.get("shadowStaticGate");
    if (typeof gate === "string" && gate.toLowerCase() === "off") {
      cfg.shadowStaticGate = false;
    }
    const lsi = ps.get("lightSortInterval");
    if (lsi !== null) {
      const n = parseInt(lsi, 10);
      // Clamp to a sane band: 1 = sort every frame (pre-throttle), 240 =
      // ~4 s @60fps worst-case boundary-pop lag. The count-delta guard in
      // capActiveLightsByDistance still forces an immediate re-sort on any
      // spawn/despawn regardless of this interval.
      if (Number.isFinite(n) && n >= 1) cfg.lightSortInterval = Math.min(240, n);
    }
    const sms = ps.get("shadowMaxStale");
    if (sms !== null) {
      if (sms.toLowerCase() === "off" || sms === "0") {
        // RP5 (review fix) — `off`/`0` does NOT fully drop the ceiling.
        // The per-caster movement scan (scanDynamicCasterMovement) already
        // re-rasters on any moving rig, but a handful of residual cases
        // (WebGL context restore on the single-shadow path, geometry
        // streaming in while the player is stationary, in-place limb
        // animation) have no explicit signal. Clamp to a 60-frame floor
        // (~1 s @60fps) so those cases ALWAYS self-heal within a second —
        // the gate must never produce a permanently-stale shadow (RED
        // LINE). 60 frames is still ~98% fewer rasters than autoUpdate.
        cfg.shadowMaxStaleFrames = SHADOW_MAX_STALE_FLOOR;
      } else {
        // An explicit numeric N is the operator deliberately choosing the
        // ceiling. Small N (e.g. ?shadowMaxStale=1 = re-raster every frame)
        // only INCREASES raster frequency, so it's safe and left as-is —
        // the floor only guards the "drop the ceiling entirely" (off/0)
        // case above, which is the only way to reach a permanent freeze.
        const n = parseInt(sms, 10);
        if (Number.isFinite(n) && n >= 1) cfg.shadowMaxStaleFrames = Math.min(600, n);
      }
    }
    const camEps = parseFloat(ps.get("csmCamEps"));
    if (Number.isFinite(camEps) && camEps >= 0) cfg.csmCamEps = camEps;
    const sunEps = parseFloat(ps.get("csmSunEps"));
    if (Number.isFinite(sunEps) && sunEps >= 0) cfg.csmSunEps = sunEps;
  }
  _rp5Config = cfg;
  return _rp5Config;
}

// === Problem-A fix (2026-06-15) — fixed light POOL (?lightPool=on) =====
// THE FREEZE: three.js bakes the per-type COUNT of *visible* lights into every
// lit material's shader program cache key (WebGLPrograms numPointLights/
// numSpotLights/…; a `.visible=false` light is skipped in projectObject so it
// is NOT counted — confirmed in three r184 WebGLPrograms.js / WebGLLights.js).
// So ANY change to the visible point/spot count forces three to RELINK the
// program of EVERY lit material in the scene on the next frame. Two sites churn
// that count: `capActiveLightsByDistance` flips a source light's `.visible` to
// enforce the 32-cap whenever the nearest-set shifts, and the entity SetLight
// (hook 25) flips a creature's lights `.visible` on every spell cast. At high
// quality (POM/CSM/normal maps) each program link is multi-ms and AC scenes
// hold hundreds–thousands of unique materials, so one count change = the
// multi-second main-thread seize the user sees when a monster casts.
//
// THE FIX (retail-faithful — D3D had a HARD 8 fixed light slots
// [acclient.h FFLightEnable[8]] and SetLightHook just toggled a STATE BIT, the
// light COUNT never changed [acclient.c set_lights @317037]): keep a
// FIXED-COUNT pool of point + spot lights allocated once at setup, ALWAYS
// `.visible=true`, never added/removed/visibility-toggled → the per-type count
// is constant forever → three compiles each lit program exactly once and never
// relinks. The real per-part "source" lights stay PERMANENTLY `.visible=false`
// (uncounted, constant 0 contribution) and serve only as live world-position +
// colour + intensity carriers; each frame the nearest `pointCount`/`spotCount`
// of them are copied into the pool slots and unused slots driven to intensity 0.
// Zero recompiles, zero visual change (same nearest-N selection + identical
// params). ALWAYS-ON (2026-06-15, live-validated); `?lightPool=off` reverts to
// the byte-identical legacy `.visible`-cap path. The sun's indoor/outdoor flip
// is the same bug class (a DirectionalLight count change on dungeon entry) and
// gets the same intensity-swap treatment.
//
//   ?lightPool=off       revert to the legacy .visible cap (escape hatch)
//   ?lightPoolSize=<n>   point-pool size (default 32 = MAX_ACTIVE_LIGHTS;
//                        ≥32 preserves the legacy cap's selection exactly)
//   ?lightPoolSpot=<n>   spot-pool size (default 8; spots are ~absent in the
//                        shipped base DAT so this is headroom, not real cost)
const LIGHT_POOL_DEFAULT_POINT = MAX_ACTIVE_LIGHTS; // 32 — match legacy cap
const LIGHT_POOL_DEFAULT_SPOT = 8;

let _lightPoolConfig;
function getLightPoolConfig() {
  if (_lightPoolConfig !== undefined) return _lightPoolConfig;
  const cfg = {
    // ALWAYS-ON since 2026-06-15 — LIVE-VALIDATED on the Dell (headless
    // SwiftShader + live ace-server, four @create-12 Red Phyntos Wasps casting):
    // entityLights spell casts went from a 30.8 s main-thread freeze (+14 shader
    // relinks, programs 37→51) to a perfectly FLAT program count with ZERO stalls
    // — same wasps, same spells, pool on. The legacy `.visible`-cap path stays
    // reachable via `?lightPool=off` (debug / A-B escape hatch).
    enabled: true,
    pointCount: LIGHT_POOL_DEFAULT_POINT,
    spotCount: LIGHT_POOL_DEFAULT_SPOT,
  };
  const ps = _rp5ReadParams();
  if (ps) {
    const v = (ps.get("lightPool") || "").toLowerCase();
    // Opt-out only — on/true/1/yes are accepted no-ops (it's the default now).
    if (v === "off" || v === "false" || v === "0" || v === "no") cfg.enabled = false;
    const sz = parseInt(ps.get("lightPoolSize"), 10);
    if (Number.isFinite(sz) && sz >= 1) cfg.pointCount = Math.min(128, sz);
    const sp = parseInt(ps.get("lightPoolSpot"), 10);
    if (Number.isFinite(sp) && sp >= 0) cfg.spotCount = Math.min(32, sp);
  }
  _lightPoolConfig = cfg;
  return _lightPoolConfig;
}

// Test seam — let the headless harness reset the module-cached config so each
// case can exercise a different `?lightPool*` combination (mirrors how the RP5
// tests would reset `_rp5Config` if they needed to).
export function __resetLightPoolConfigForTest(next) {
  _lightPoolConfig = next === undefined ? undefined : next;
}

/**
 * Allocate the fixed light pool under `lightsGroup` (scene-root space — the
 * same three.js world frame the sun/ambient live in, so source world-positions
 * copy straight in). Every pool light starts visible + OFF (intensity 0) +
 * non-shadowing; the per-type COUNT they establish here is the constant the
 * renderer compiles against and never sees change. Returns the pool descriptor
 * stored on the lighting bundle as `lightPool`.
 */
function allocateLightPool(lightsGroup, cfg) {
  const point = [];
  const spot = [];
  for (let i = 0; i < cfg.pointCount; i += 1) {
    const pl = new THREE.PointLight(0xffffff, 0, 0, 2);
    pl.visible = true; // CONSTANT — never toggled (this is the count discipline)
    pl.castShadow = false; // CONSTANT — shadow counts are ALSO in the cache key
    pl.name = `lightpool-point-${i}`;
    lightsGroup.add(pl);
    point.push(pl);
  }
  for (let i = 0; i < cfg.spotCount; i += 1) {
    const sl = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0, 2);
    sl.visible = true;
    sl.castShadow = false;
    sl.name = `lightpool-spot-${i}`;
    lightsGroup.add(sl);
    lightsGroup.add(sl.target);
    spot.push(sl);
  }
  return {
    enabled: true,
    pointCount: cfg.pointCount,
    spotCount: cfg.spotCount,
    point,
    spot,
    selPoint: [], // nearest point sources, re-picked at the sort cadence
    selSpot: [], // nearest spot sources, re-picked at the sort cadence
    _tmp: new THREE.Vector3(),
  };
}

// Drive every pool slot to OFF (intensity 0) and forget the selected sources.
// Used when the scene has zero active source lights so the pool goes dark
// without a count change.
function zeroLightPool(pool) {
  for (let i = 0; i < pool.point.length; i += 1) pool.point[i].intensity = 0;
  for (let i = 0; i < pool.spot.length; i += 1) pool.spot[i].intensity = 0;
  pool.selPoint.length = 0;
  pool.selSpot.length = 0;
}

// Re-pick which source lights occupy the pool slots: walk the distance-sorted
// scratch and take the nearest `pointCount` point sources + nearest `spotCount`
// spot sources. Type-separated budgets (vs the legacy combined 32-cap) are
// identical on shipped data where spots are absent. Throttled (sort cadence).
function pickSelectedSources(pool, scratch) {
  pool.selPoint.length = 0;
  pool.selSpot.length = 0;
  for (let i = 0; i < scratch.length; i += 1) {
    const src = scratch[i].light;
    if (src.isSpotLight) {
      if (pool.selSpot.length < pool.spotCount) pool.selSpot.push(src);
    } else if (pool.selPoint.length < pool.pointCount) {
      pool.selPoint.push(src);
    }
    if (
      pool.selPoint.length >= pool.pointCount &&
      pool.selSpot.length >= pool.spotCount
    ) {
      break;
    }
  }
}

// Copy the currently-selected sources' LIVE world-position + colour + intensity
// into the pool slots, zeroing the unused tail. Runs EVERY frame (not just on a
// re-sort) so a light riding a moving creature never lags — the source light is
// parented under the rig part, so getWorldPosition tracks it exactly.
function feedSelectedIntoPool(pool) {
  const tmp = pool._tmp;
  for (let i = 0; i < pool.point.length; i += 1) {
    const dst = pool.point[i];
    const src = i < pool.selPoint.length ? pool.selPoint[i] : null;
    if (!src) {
      dst.intensity = 0;
      continue;
    }
    if (typeof src.getWorldPosition === "function") src.getWorldPosition(tmp);
    else if (src.position) tmp.set(src.position.x, src.position.y, src.position.z);
    else tmp.set(0, 0, 0);
    dst.position.copy(tmp);
    if (dst.color && src.color) dst.color.copy(src.color);
    dst.intensity = src.intensity || 0;
    dst.distance = src.distance || 0;
    if (src.decay != null) dst.decay = src.decay;
  }
  for (let i = 0; i < pool.spot.length; i += 1) {
    const dst = pool.spot[i];
    const src = i < pool.selSpot.length ? pool.selSpot[i] : null;
    if (!src) {
      dst.intensity = 0;
      continue;
    }
    if (typeof src.getWorldPosition === "function") src.getWorldPosition(tmp);
    else if (src.position) tmp.set(src.position.x, src.position.y, src.position.z);
    else tmp.set(0, 0, 0);
    dst.position.copy(tmp);
    if (dst.color && src.color) dst.color.copy(src.color);
    dst.intensity = src.intensity || 0;
    dst.distance = src.distance || 0;
    if (src.decay != null) dst.decay = src.decay;
    if (src.angle != null) dst.angle = src.angle;
    if (src.penumbra != null) dst.penumbra = src.penumbra;
    if (src.target && typeof src.target.getWorldPosition === "function") {
      src.target.getWorldPosition(tmp);
      dst.target.position.copy(tmp);
    }
  }
}

// === LG1 (render-completeness waves-3, 2026-05-29) — intensity clamp ===
// Upper bound on per-light intensity. The previous cap of 8.0 guarded
// against a feared "rogue 9999.0" entry, but a full census of all 608
// SetupModel (0x02) light tables in client_portal.dat shows that fear
// is unfounded: intensity min=20, p50=100, p90=100, max=100 — 608/608
// (100%) of authored lights EXCEED 8.0. Clamping to 8 crushed every
// lantern/brazier/torch/candelabra to <=8–40% of authored brightness,
// turning retail's "lit-to-warm-color across the radius" into a dim
// inverse-square pool.
//
// Retail (acclient.c:454615-454627, calc_point_light): the contribution
// is `(1 - dist/range) * intensity` with the RAW intensity (20–100),
// then per-channel-clamped at the light's own color via
// `min(v12*color_c, color_c)`. That high intensity is precisely what
// saturates a torch to its color across most of its radius before the
// linear falloff — clamping to 8 made that saturation impossible (and
// also defeated the shipped ?lightClamp=retail (R2.B) per-channel clamp
// in materials.js:1086, which needs high intensity to reach saturation).
//
// Option (a): raise the cap to a safe bound that admits real data with
// headroom (max=100 → 120) while still flooring a pathological value.
// Simpler than passing raw + relying on R2.B, and safe on the legacy
// (non-?lightClamp) path too. Default-on, fail-soft (a non-finite or
// negative intensity still floors at 0 below).
const LIGHT_INTENSITY_CLAMP = 120.0;

// SpotLight penumbra (soft-edge falloff) + decay (physical inverse-
// square falloff) constants. AC's `LightInfo.cone_angle` carries the
// angle directly; penumbra is a three.js artefact (no AC field), so
// we pick a constant 0.3 which gives a soft but legible edge.
const SPOTLIGHT_PENUMBRA = 0.3;
const LIGHT_DECAY = 2.0;

// === L2 (render-completeness waves-2, 2026-05-29) — static_light_factor ===
// Retail `range = falloff * static_light_factor`, static_light_factor = 1.3
// (constant acclient.c:45774; applied in calc_point_light acclient.c:454605).
// Module-level so capture scripts can assert it via LIGHTING_CONSTANTS; the
// SINGLE multiply happens at the `safeFalloff` site in
// makeThreeLightForSetupLight below (no double-multiply: lib.rs surfaces RAW
// falloff and the C7 template path reads back the already-multiplied .distance).
const STATIC_LIGHT_FACTOR = 1.3;

/**
 * Per-frame: read the wasm cell BFS to decide whether the player is
 * indoors, and toggle `sun.visible` + adjust `ambient.intensity`
 * accordingly. Also caps `scene3d.activeLights` to the closest
 * `MAX_ACTIVE_LIGHTS` (32) via distance-sort + `.visible` flip.
 *
 * Indoor: `sun.visible = false` + `ambient.intensity =
 *   AMBIENT_INTENSITY_INDOOR (0.7)`.
 * Outdoor: `sun.visible = true` + `ambient.intensity =
 *   AMBIENT_INTENSITY_OUTDOOR (0.5)`.
 *
 * Hard switch (no lerp). Portal-graph transitions have a brief async
 * pause while EnvCell groups load; the visible flash would not be
 * noticeable inside that pause.
 *
 * Cheap when `sessionHandle` is missing or its methods throw — the
 * per-light cap still runs in that case, so capture scripts without
 * a real session can still verify the cap behaviour.
 *
 * @param {Object} scene3d - the `liveScene3d` shape from `init3D`.
 * @param {Object} sessionHandle - wasm `SessionHandle` (may be null).
 */
export function tickLightingForCellState(scene3d, sessionHandle) {
  if (!scene3d) return;

  // RP5 — accumulate "shadows changed this frame → must re-raster" across
  // the indoor/outdoor flip, the single-shadow frustum recentre, and the
  // CSM refit below. Combined + bounded by the static-shadow gate at the
  // end of this tick (applyStaticShadowGate). Starts false; any of the
  // contributing levers flips it true.
  let shadowDirty = false;

  // === Indoor/outdoor toggle (sun + ambient) ==========================
  const lighting = scene3d.lighting;
  if (lighting) {
    const { sun, ambient } = lighting;
    if (sun && ambient && sessionHandle && typeof sessionHandle.isCurrentCellIndoor === "function") {
      let isIndoor = null;
      try {
        isIndoor = !!sessionHandle.isCurrentCellIndoor();
      } catch (_) {
        // Swallow — keep last-frame state. Don't return yet; the
        // per-light cap still needs to run.
      }
      if (isIndoor !== null) {
        const lightPool = scene3d.lighting?.lightPool;
        if (lightPool && lightPool.enabled) {
          // Pool mode: NEVER flip sun.visible — a DirectionalLight count change
          // relinks every lit material (the same freeze the pool kills, here on
          // dungeon entry). Keep the sun permanently visible and zero its
          // CONTRIBUTION via intensity. Edge-triggered (only on an indoor↔outdoor
          // transition) so we never fight a per-frame sky/diurnal intensity
          // driver: capture the outdoor intensity going in, restore it coming out.
          if (sun.visible !== true) sun.visible = true;
          if (scene3d._poolSunIndoor !== isIndoor) {
            if (isIndoor) {
              if (sun.intensity > 0) {
                if (!sun.userData) sun.userData = {};
                sun.userData.__poolOutdoorIntensity = sun.intensity;
              }
              sun.intensity = 0;
            } else {
              sun.intensity = Number.isFinite(sun.userData?.__poolOutdoorIntensity)
                ? sun.userData.__poolOutdoorIntensity
                : 1.0;
            }
            scene3d._poolSunIndoor = isIndoor;
            shadowDirty = true;
          }
        } else {
          // sun.visible flip — single comparison gate so we don't repeatedly
          // dirty the GL state every frame for an already-correct value. (This
          // flip changes numDirectional → relinks every lit material; the pool
          // branch above avoids it.)
          const wantSunVisible = !isIndoor;
          if (sun.visible !== wantSunVisible) {
            sun.visible = wantSunVisible;
            // RP5 — the sun (and thus its shadow contribution) just turned
            // on/off; force a shadow re-raster this frame so the cached
            // shadow map doesn't lag the indoor/outdoor transition.
            shadowDirty = true;
          }
        }
        // === L1 (waves-2, 2026-05-29) — AC diurnal ambient on the legacy
        // path ==========================================================
        // When the takram/Bruneton atmosphere is active, `atmosphereLights`
        // owns ambient (the SkyLightProbe — driven with the L1 amb term in
        // atmosphere_lights.js's tick) and the legacy AmbientLight is zeroed
        // at boot (index.js:2702). Leave it zeroed here so we don't double-
        // count with the probe. Only drive the legacy AmbientLight on the
        // non-atmosphere path.
        const atmosphereActive = !!scene3d.atmosphereLights;
        if (!atmosphereActive) {
          // Outdoor: drive ambient.intensity (floored at 0.2) + ambient.color
          // from the SkyState snapshot so dawn/dusk tint the scene the way
          // retail's ambColor·ambient_level term does. Indoor: keep the legacy
          // 0.7 legibility boost (sun is off indoors, so the diurnal ambient
          // alone would crush corridors) and leave the warm-tint color alone.
          // Fail-soft: no/garbage snapshot ⇒ resolveDiurnalAmbient() returns
          // null and we fall back to the prior 0.5/0.7 constants + AMBIENT_COLOR.
          // Compare against thresholds so a third-party override (e.g. capture
          // script poking ambient.intensity = 0.42) doesn't ping-pong.
          const skyState = scene3d.skyLightingController?._lastState ?? null;
          const diurnal = isIndoor ? null : resolveDiurnalAmbient(skyState);
          const wantIntensity = diurnal
            ? diurnal.intensity
            : isIndoor
              ? AMBIENT_INTENSITY_INDOOR
              : AMBIENT_INTENSITY_OUTDOOR;
          if (Math.abs(ambient.intensity - wantIntensity) > 1e-4) {
            ambient.intensity = wantIntensity;
          }
          if (diurnal && diurnal.color && ambient.color) {
            const c = diurnal.color;
            // #16 (2026-06-07) — the ARGB ambient snapshot is authored in
            // sRGB; decode to linear so the tint matches retail (parity
            // with the SetupLight color fix below). Decode the target
            // into a reusable scratch Color FIRST so the change gate
            // still compares linear-vs-linear (otherwise the stored
            // linear ambient.color.r would never equal the sRGB c.r and
            // we'd re-set every frame).
            let want = scene3d._ambientColorScratch;
            if (!want || typeof want.setRGB !== "function") {
              want = new THREE.Color();
              scene3d._ambientColorScratch = want;
            }
            want.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace);
            if (
              Math.abs(ambient.color.r - want.r) > 1e-4 ||
              Math.abs(ambient.color.g - want.g) > 1e-4 ||
              Math.abs(ambient.color.b - want.b) > 1e-4
            ) {
              ambient.color.copy(want);
            }
          }
        }
      }
    }
  }

  // Visual-fidelity Phase 0.1 — recentre the sun's shadow frustum on
  // the player each frame so casters near the player are always
  // covered. Reads the local player world pos from the entity manager
  // (post-AC→three transform). No-op when the lighting bundle's sun
  // isn't shadow-casting (the common case pre-Phase-0.1).
  if (lighting && lighting.sun?.castShadow) {
    const playerThreePos = resolvePlayerThreePos(scene3d);
    if (playerThreePos) {
      // RP5 — the recentre returns true when the texel-snapped frustum
      // actually moved (i.e. the player/camera moved enough to shift the
      // shadow camera), which is the single-shadow path's "camera moved →
      // re-raster" signal.
      if (updateShadowCameraTarget(lighting, playerThreePos)) {
        shadowDirty = true;
      }
    }
  }

  // Visual-fidelity Phase 3.3 — when the lighting bundle carries a
  // csmState, fit each cascade's shadow frustum to the camera's view
  // sub-slice for this frame, then push fresh shadow-map textures +
  // matrices into every patched receiver's uniforms. Runs AFTER
  // Phase 0.1's `updateShadowCameraTarget` so the two paths share the
  // same player-position resolver (they're mutually exclusive in
  // practice — `setupSceneLighting` only attaches one or the other).
  if (lighting && lighting.csmState) {
    const cam = scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
    if (cam) {
      try {
        updateCsm(lighting.csmState, cam);
        refreshCsmUniforms(lighting.csmState);
        // RP5 — updateCsm set `didRefitThisTick` true iff it actually
        // refit the cascades (camera/sun moved past threshold). That IS
        // the CSM-path "shadows changed → re-raster" signal. Skipped
        // refits leave the previous frame's shadow maps valid, so we can
        // skip the raster (subject to the staleness bound below).
        if (lighting.csmState.didRefitThisTick) {
          shadowDirty = true;
        }
      } catch (e) {
        if (!scene3d._csmTickWarned) {
          scene3d._csmTickWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[visfid-p33] CSM tick failed:", e);
        }
        // RP5 — a thrown CSM tick leaves the cascade fit ambiguous; err
        // toward correctness and re-raster this frame.
        shadowDirty = true;
      }
    }
  }

  // RP5 — STATIC-SCENE SHADOW GATE (the big win). Drive the three.js
  // shadow-map RASTER off `shadowDirty` so a provably-static scene skips
  // re-rendering all (1 or 3) shadow maps. Runs AFTER both shadow paths
  // have updated their frusta this frame. See applyStaticShadowGate.
  applyStaticShadowGate(scene3d, lighting, shadowDirty);

  // === Per-SetupModel light cap (top-32 by squared distance) ==========
  // We cap regardless of whether the indoor toggle ran (capture scripts
  // can validate the cap with a sessionHandle that has no
  // isCurrentCellIndoor — the cap exists on its own merits).
  capActiveLightsByDistance(scene3d);
}

/**
 * RP5 — STATIC-SCENE SHADOW GATE.
 *
 * Three.js re-rasters every enabled shadow map on EVERY `renderer.render`
 * (because `renderer.shadowMap.autoUpdate` defaults true). For our
 * directional shadows (1 map on the single-shadow path, 3 on the CSM
 * path) the geometry is overwhelmingly STATIC — buildings/statics/terrain
 * never move and the sun/camera are often still. Re-rasterising identical
 * shadow maps every frame is pure waste.
 *
 * This gate flips `renderer.shadowMap.autoUpdate = false` (once) and then
 * sets `renderer.shadowMap.needsUpdate = true` ONLY on frames where
 * something shadow-relevant changed. three.js consumes `needsUpdate` on
 * the next render and clears it itself, so this is a pure one-shot raster
 * trigger — when shadows DO render, the output is byte-identical to today
 * (we never touch frustum/bias/map-size/caster tagging; only WHEN the
 * raster fires).
 *
 * Correctness contract (SAFE-with-RED-LINES): we re-raster whenever
 *   - the camera or sun moved (CSM `didRefitThisTick` / single-shadow
 *     frustum recentre returned true), OR
 *   - the indoor/outdoor sun.visible flipped, OR
 *   - ANY DYNAMIC SHADOW CASTER MOVED — every entity rig (NPC / player /
 *     projectile; all tagged `castShadow` in entities.js and rastered into
 *     the directional/CSM shadow map) is scanned each tick via
 *     `scanDynamicCasterMovement` and a change in any rig's world
 *     position/orientation forces an immediate re-raster. This is the
 *     RED-LINE guarantee: a walking NPC or a flying projectile's shadow
 *     tracks at the render cadence (≤1 frame lag), NOT only at the
 *     staleness ceiling. (The scan compares the entity-rig ROOT transform;
 *     pure in-place limb animation that never moves the root is bounded by
 *     the staleness ceiling below — a far subtler shadow change.) OR
 *   - the staleness ceiling (?shadowMaxStale, default 12 frames) elapsed
 *     since the last raster — a secondary BOUND that catches the residual
 *     cases the explicit signals miss (in-place limb animation, geometry
 *     streaming in while the player stands still, a freed/reattached
 *     caster). With the ceiling at 12 frames an in-place-animating NPC's
 *     shadow refreshes ~5×/s @60fps even if its root never translates; set
 *     `?shadowMaxStale=1` to re-raster every frame (functionally pre-RP5).
 *     `?shadowMaxStale=off`/`=0` is CLAMPED to a 60-frame floor (never a
 *     true zero) so the ceiling can never permanently freeze a shadow even
 *     in the residual cases the per-caster scan doesn't cover.
 *
 * No-op (leaves three's default per-frame raster) when:
 *   - `?shadowStaticGate=off`, OR
 *   - no renderer / no shadowMap reachable, OR
 *   - shadows aren't enabled (`renderer.shadowMap.enabled === false`) —
 *     in which case there's nothing to gate.
 *
 * Reached entirely through `scene3d.renderer` (the renderer is stashed on
 * `liveScene3d` in index.js); no index.js edit required.
 *
 * @param {Object} scene3d - the live `liveScene3d` shape.
 * @param {Object|null} lighting - the lighting bundle (sun + csmState).
 * @param {boolean} shadowDirty - accumulated "shadows changed this frame".
 */
function applyStaticShadowGate(scene3d, lighting, shadowDirty) {
  const cfg = getRp5Config();
  if (!cfg.shadowStaticGate) {
    // RP5 (review fix) — renderer-state-leak heal. The renderer is owned
    // outside the lighting bundle and can outlive a lighting dispose (e.g.
    // a 3D→2D→3D soft re-init reusing the same WebGLRenderer). A PRIOR
    // gated session may have left `shadowMap.autoUpdate = false`; if THIS
    // session has the gate disabled we'd otherwise never restore three's
    // default per-frame raster, leaving the new session's shadows frozen.
    // Restore autoUpdate=true once if we find it left false while the gate
    // is off (idempotent; only touches the renderer when it's stale).
    const r = scene3d?.renderer;
    const sm = r?.shadowMap;
    if (sm && sm.enabled && sm.autoUpdate === false && !scene3d._rp5ShadowGateActive) {
      sm.autoUpdate = true;
    }
    return;
  }

  const renderer = scene3d?.renderer;
  const shadowMap = renderer?.shadowMap;
  // Nothing to gate if there's no renderer, no shadowMap, or shadows are
  // disabled (index.js only sets `enabled = true` on the shadow/CSM path).
  if (!shadowMap || !shadowMap.enabled) return;

  // Is there actually a shadow caster wired this session? Single-shadow
  // path = sun.castShadow; CSM path = a csmState. If neither, there are
  // no shadow maps to raster, so leave three's defaults untouched.
  const hasSingleShadow = !!(lighting && lighting.sun && lighting.sun.castShadow);
  const hasCsm = !!(lighting && lighting.csmState);
  if (!hasSingleShadow && !hasCsm) return;

  // One-time: take manual control of the raster. We flip autoUpdate off
  // exactly once (guarded so a third party flipping it back on mid-session
  // is respected on the NEXT detection — we only force-disable when WE own
  // it). The first frame after taking control force-renders so the maps
  // are warm regardless of camera/sun state.
  if (!scene3d._rp5ShadowGateActive) {
    scene3d._rp5ShadowGateActive = true;
    shadowMap.autoUpdate = false;
    scene3d._rp5ShadowStaleFrames = 0;
    shadowDirty = true; // warm the maps on the first gated frame.
    // RP5 (review fix) — stash the renderer we gated on the lighting
    // bundle so its dispose() can restore autoUpdate=true when this scene3d
    // tears down (the renderer can outlive the lighting bundle on a soft
    // re-init). No-op when there's no lighting bundle (gate still works via
    // the scene3d-keyed state above).
    if (lighting) lighting._rp5GatedRenderer = renderer;
  }

  // RED-LINE — re-raster whenever ANY DYNAMIC CASTER MOVED. Entity rigs
  // (NPCs / local player / projectiles) are tagged castShadow and DO get
  // rastered into the directional/CSM shadow map, so a moving rig whose
  // shadow only refreshed at the staleness ceiling would show a laggy /
  // detached shadow (worst on fast projectiles). Scan the live entity-rig
  // root transforms and force an immediate re-raster on any change. This
  // runs BEFORE the staleness ceiling so a moving caster always wins.
  // Skipped (returns false) when the gate isn't reading dynamic casters —
  // e.g. no entityManager. NOTE on ordering: this lighting tick runs
  // BEFORE entityManager.tick(dt) in loop.js, so we sample each rig's
  // PREVIOUS-frame transform; a change vs. two-frames-ago means the rig is
  // moving, so we arm needsUpdate and the post-entityManager.tick raster
  // captures the freshest pose (≤1 frame lag — the render-cadence bound
  // the RED LINE asks for, not the staleness bound).
  if (!shadowDirty && scanDynamicCasterMovement(scene3d)) {
    shadowDirty = true;
  }

  // Staleness ceiling — a SECONDARY bound that catches the residual cases
  // the explicit signals miss (in-place limb animation that never moves a
  // rig root, geometry streaming in while stationary, a reattached caster).
  // `?shadowMaxStale=off`/`=0` is clamped to a 60-frame floor (see
  // getRp5Config) so the ceiling can never be a true zero — it must never
  // permanently freeze a shadow even when the per-caster scan doesn't cover
  // a case.
  const maxStale = cfg.shadowMaxStaleFrames | 0;
  let stale = scene3d._rp5ShadowStaleFrames | 0;
  if (!shadowDirty && maxStale > 0 && stale + 1 >= maxStale) {
    shadowDirty = true;
  }

  if (shadowDirty) {
    // One-shot raster trigger. three.js renders all enabled shadow maps
    // on the next `renderer.render` and resets needsUpdate to false.
    shadowMap.needsUpdate = true;
    scene3d._rp5ShadowStaleFrames = 0;
  } else {
    scene3d._rp5ShadowStaleFrames = stale + 1;
  }
}

/**
 * RP5 RED-LINE — detect whether any DYNAMIC SHADOW CASTER (entity rig:
 * NPC, local player, projectile) moved since the previous tick, so the
 * static-shadow gate can force an immediate re-raster (rather than waiting
 * for the staleness ceiling). Entity meshes are tagged `castShadow` on the
 * shadow/CSM path (entities.js), so they ARE rastered into the directional/
 * CSM shadow map; a moving rig whose shadow only refreshed at the ceiling
 * would show a laggy/detached shadow.
 *
 * Cheap, zero-allocation, fail-soft:
 *   - Reads `scene3d.entityManager.entityMap` (a Map<guid, EntityInstance>).
 *   - For each rig, hashes its ROOT world position + quaternion into a
 *     single rolling FNV-ish accumulator. The rig root is what translates
 *     when an NPC walks or a projectile flies; comparing it catches the
 *     dominant, most-visible moving-caster cases. (Pure in-place limb
 *     animation that never moves the root is left to the staleness ceiling
 *     — a far subtler shadow change.)
 *   - Compares this frame's accumulated hash against the value stored on
 *     `scene3d._rp5CasterHash`; returns true (and updates the stored hash)
 *     when they differ.
 *
 * Uses the rig root's LOCAL position/quaternion (root is parented directly
 * under worldRoot, so its local transform IS its world transform up to the
 * fixed worldRoot rotation — a change in local transform is a change in
 * world transform, which is all we need to detect "it moved"). This avoids
 * forcing a getWorldPosition matrix recompute per entity per frame.
 *
 * @param {Object} scene3d - the live `liveScene3d` shape.
 * @returns {boolean} true when a caster moved since the last call.
 */
function scanDynamicCasterMovement(scene3d) {
  const em = scene3d?.entityManager;
  const map = em?.entityMap;
  if (!map || typeof map.forEach !== "function") return false;
  // Rolling 32-bit accumulator over every rig root's transform. Mixes guid
  // so a despawn+spawn that lands a new rig at the same transform still
  // changes the hash (the SET of casters changed). Integer math only — no
  // allocation, no sqrt.
  let hash = 0x811c9dc5 | 0; // FNV offset basis
  map.forEach((inst, guid) => {
    const root = inst && inst.root;
    if (!root) return;
    const p = root.position;
    const q = root.quaternion;
    // Quantize floats to ~1mm / ~1e-3 rad so sub-visible jitter (or
    // float noise from the integrator) doesn't churn the raster every
    // frame; a genuine walk/fly easily clears these steps each frame.
    // `| 0` truncates to int32 — wrap is fine, we only compare equality.
    const acc =
      (guid | 0) ^
      ((p.x * 1000) | 0) ^
      (((p.y * 1000) | 0) * 3) ^
      (((p.z * 1000) | 0) * 7) ^
      (((q.x * 1000) | 0) * 11) ^
      (((q.y * 1000) | 0) * 13) ^
      (((q.z * 1000) | 0) * 17) ^
      (((q.w * 1000) | 0) * 19);
    // FNV-style mix so order-independent collisions are unlikely.
    hash = (hash ^ acc) | 0;
    hash = (hash + ((hash << 1) | 0) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) | 0;
  });
  const prev = scene3d._rp5CasterHash;
  scene3d._rp5CasterHash = hash;
  // First call (prev === undefined): treat as "no change" — the gate's
  // own first-frame warm-up already forced a raster, and the entity map
  // is typically empty at gate-activation time anyway. Returning false
  // here avoids a spurious re-raster the frame the hash is first seeded.
  if (prev === undefined) return false;
  return hash !== prev;
}

/**
 * Resolve the local player's three.js-world XYZ for the shadow-frustum
 * tick. Reads through `entityManager.getLocalPlayerWorldPos()` (which
 * returns AC-coords), then applies the same AC→three transform that
 * worldRoot's `rotation.x = -π/2` applies to scene geometry.
 *
 * Falls back to the active camera's world position when no player is
 * spawned. Pre-spawn flows (capture scripts, login screen idle, dev
 * harness with mock session) need a reasonable shadow frustum centre
 * or the shadow map captures empty space at world origin while the
 * camera sits 32 km away over Holtburg. The camera is always a valid
 * three.js-world point and the player will inevitably land near where
 * the camera is looking (init3D frames the camera on the Holtburg LB
 * centre), so this is a safe default.
 *
 * Returns `null` only when neither path resolves (truly headless
 * harness with no camera at all) — caller skips the recentre.
 */
function resolvePlayerThreePos(scene3d) {
  if (!scene3d) return null;
  const em = scene3d.entityManager;
  if (em && typeof em.getLocalPlayerWorldPos === "function") {
    let acPos = null;
    try { acPos = em.getLocalPlayerWorldPos(); } catch (_) { acPos = null; }
    if (acPos) {
      // AC (x, y, z) maps to three.js (x, z, -y) under the worldRoot
      // rotation. Mirrors `adapter.js#acToThree`.
      return { x: acPos.x, y: acPos.z, z: -acPos.y };
    }
  }
  // Fallback: active camera position. Already in three.js world space.
  const cam =
    scene3d.cameraSwitcher?.activeCamera ?? scene3d.camera ?? null;
  if (cam?.position) {
    return { x: cam.position.x, y: cam.position.y, z: cam.position.z };
  }
  return null;
}

/**
 * Cap `scene3d.activeLights` to `MAX_ACTIVE_LIGHTS` by squared
 * distance to the active camera. Lights beyond the cap stay in the
 * scene graph but `.visible = false` so they contribute zero work.
 *
 * Camera position is read from `scene3d.cameraSwitcher?.activeCamera`
 * (Phase 7.5). If the switcher isn't available, falls back to
 * `scene3d.camera`. With neither, no cap is applied (the lights stay
 * at whatever .visible they had).
 *
 * Distance is measured in three.js WORLD space (i.e. AFTER
 * `worldRoot.rotation.x = -π/2`). Lights live as children of the
 * per-part `Object3D` inside `worldRoot`, so their `getWorldPosition`
 * gives the post-rotation world position — the same frame the camera
 * lives in. No coord-transform needed.
 */
function capActiveLightsByDistance(scene3d) {
  const lights = scene3d?.activeLights;
  const lightPool = scene3d?.lighting?.lightPool;
  if (!Array.isArray(lights) || lights.length === 0) {
    // Pool mode: no source lights → drive every pool slot dark (intensity 0),
    // which is NOT a count change (the slots stay visible). Legacy: nothing.
    if (lightPool && lightPool.enabled) zeroLightPool(lightPool);
    return;
  }

  // Resolve camera (Phase 7.5 switcher; fall back to .camera).
  const camera =
    scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
  if (!camera || !camera.position) {
    // No camera to sort against. Leave .visible flags as-is.
    return;
  }

  // Perf C6 — throttle: increment per-scene3d frame counter, then
  // decide whether to skip the sort + .visible toggle this tick. We
  // skip when both (a) we sorted recently (< sortInterval frames ago)
  // AND (b) the active light count is unchanged since the last sort.
  // Any count delta (a spawn / despawn from `attachSetupModelLights` or
  // cell unload) forces a fresh sort so a newly-attached light doesn't
  // sit invisible behind the cap. The previous-frame .visible flags
  // survive untouched, which IS the win — the toggle loop also gets
  // skipped, not just the sort.
  //
  // RP5 — `sortInterval` is the configurable LIGHT_SORT_INTERVAL
  // (?lightSortInterval, default 4 — parity with the prior hard-coded value).
  // The count-unchanged guard (a) above is the REQUIRED cap-boundary
  // anti-pop safeguard: it re-sorts immediately whenever the active light
  // SET changes (spawn/despawn), so a longer interval only delays the
  // rare same-count move-across-the-32-boundary case by a few frames,
  // never a genuine light appearing/disappearing.
  const sortInterval = getRp5Config().lightSortInterval || LIGHT_SORT_INTERVAL;
  const frameCounter = (scene3d._lightSortFrameCounter ?? 0) + 1;
  scene3d._lightSortFrameCounter = frameCounter;
  const lastSortFrame = scene3d._lightSortLastFrame ?? 0;
  const lastSortCount = scene3d._lightSortLastCount ?? -1;
  const throttled =
    lastSortCount === lights.length &&
    frameCounter - lastSortFrame < sortInterval;
  if (throttled) {
    // Sort throttled this tick. Legacy: nothing to do — stale `.visible` flags
    // survive (the perf win). Pool: still re-feed every frame so a light riding
    // a moving creature tracks exactly, then return without re-picking sources.
    if (lightPool && lightPool.enabled) feedSelectedIntoPool(lightPool);
    return;
  }

  const camX = camera.position.x;
  const camY = camera.position.y;
  const camZ = camera.position.z;

  // Build a small scratch array of { light, distSq } for sorting.
  // Reuses an existing scratch buffer when length matches to keep
  // per-frame GC pressure to zero.
  let scratch = scene3d._lightDistScratch;
  if (!scratch || scratch.length !== lights.length) {
    scratch = new Array(lights.length);
    scene3d._lightDistScratch = scratch;
  }
  // Cache a real THREE.Vector3 for getWorldPosition (which requires
  // `.setFromMatrixPosition`). Falls back to a plain xyz triplet when
  // a Light isn't a THREE.Object3D (e.g. test mocks).
  let tmp = scene3d._lightTmpPos;
  if (!tmp || typeof tmp.setFromMatrixPosition !== "function") {
    tmp = new THREE.Vector3();
    scene3d._lightTmpPos = tmp;
  }
  for (let i = 0; i < lights.length; i += 1) {
    const light = lights[i];
    // Reach for getWorldPosition. Light is parented under a part
    // Object3D inside worldRoot, so we need its WORLD position (the
    // local position is part-relative, not world-relative).
    if (typeof light.getWorldPosition === "function") {
      light.getWorldPosition(tmp);
    } else if (light.position) {
      tmp.set(light.position.x, light.position.y, light.position.z);
    } else {
      tmp.set(0, 0, 0);
    }
    const dx = tmp.x - camX;
    const dy = tmp.y - camY;
    const dz = tmp.z - camZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    let slot = scratch[i];
    if (!slot) {
      slot = { light, distSq };
      scratch[i] = slot;
    } else {
      slot.light = light;
      slot.distSq = distSq;
    }
  }
  scratch.sort(sortByDistSq);
  if (lightPool && lightPool.enabled) {
    // Pool mode: pick the nearest sources for the fixed slots, then feed them
    // in. Sources are never made visible (they're permanent `.visible=false`
    // carriers), so the renderer's per-type light count NEVER changes → no
    // shader relink → no freeze. Same nearest-N selection as legacy below.
    pickSelectedSources(lightPool, scratch);
    feedSelectedIntoPool(lightPool);
  } else {
    // Legacy: the top MAX_ACTIVE_LIGHTS slots get .visible = true; the rest
    // .visible = false. Single-comparison gate so we don't dirty already-
    // correct flags. (This `.visible` churn is exactly the per-type COUNT
    // change that relinks every lit material — see the ?lightPool note above.)
    for (let i = 0; i < scratch.length; i += 1) {
      const want = i < MAX_ACTIVE_LIGHTS;
      const light = scratch[i].light;
      if (light.visible !== want) {
        light.visible = want;
      }
    }
  }

  // Perf C6 — record this sort so the next LIGHT_SORT_INTERVAL-1
  // frames can early-out at the gate above.
  scene3d._lightSortLastFrame = frameCounter;
  scene3d._lightSortLastCount = lights.length;
}

function sortByDistSq(a, b) { return a.distSq - b.distSq; }

/**
 * C3 #6 — release a SetupModel light: splice it out of
 * `scene3d.activeLights` (so next frame's `capActiveLightsByDistance`
 * never sorts/sees a stale detached light), detach it from its parent
 * Object3D, and dispose it. Fail-soft + idempotent (releasing a light
 * already absent from activeLights / already detached is a no-op).
 *
 * Exported so `entities.js` (entity-attached SetLight lights) can adopt
 * the same release path on `remove()`. The landblock LRU keeps a
 * zero-import leaf and INLINES the equivalent splice/detach/dispose in
 * its `evict()` (it must not import this module — cycle avoidance).
 *
 * @param {Object} scene3d - the live `liveScene3d` shape (may be null).
 * @param {THREE.Light} light - the light to release (may be null).
 */
export function releaseLight(scene3d, light) {
  if (!light) return;
  try {
    const lights = scene3d?.activeLights;
    if (Array.isArray(lights)) {
      const idx = lights.indexOf(light);
      if (idx !== -1) lights.splice(idx, 1);
    }
  } catch (_) { /* fail-soft */ }
  try {
    if (light.parent && typeof light.parent.remove === "function") {
      light.parent.remove(light);
    } else if (typeof light.removeFromParent === "function") {
      light.removeFromParent();
    }
  } catch (_) { /* fail-soft */ }
  // B10b (likely:spotlight-target): an oriented SpotLight's `.target`
  // was added as a sibling under the same part Object3D, so detach it
  // here too. No-op for PointLights and for SpotLights that never
  // wired a target (the common/shipped case — target.parent is null).
  try {
    const tgt = light.isSpotLight ? light.target : null;
    if (tgt && tgt.parent && typeof tgt.parent.remove === "function") {
      tgt.parent.remove(tgt);
    } else if (tgt && typeof tgt.removeFromParent === "function") {
      tgt.removeFromParent();
    }
  } catch (_) { /* fail-soft */ }
  try {
    if (typeof light.dispose === "function") light.dispose();
  } catch (_) { /* fail-soft */ }
}

/**
 * Phase 7.6.1 (3D port follow-on #1) — per-SetupModel point/spot
 * lights.
 *
 * Walks every loaded building / static / cell / entity model, collects
 * the unique setup_ids, and calls `wasmExports.fetchSetupModelLights`
 * for each. For each `SetupLight` returned, creates a
 * `THREE.PointLight` (when `cone_angle == 0`) or `THREE.SpotLight`
 * (when `cone_angle > 0`), parents it under the matching part
 * `Object3D` (so the light moves with the part rig), and pushes it
 * into `scene3d.activeLights` for the per-tick distance cap.
 *
 * Pre-scan strategy — walks the post-build scene graph rather than
 * adding wiring to each per-phase builder. This keeps the change
 * surface small (lighting.js + index.js only; buildings.js /
 * statics.js / cells.js untouched). The walker maps every Object3D
 * whose `userData.modelId` matches a Setup id back to its part-group
 * children (named `part-${i}` per buildings.js convention).
 *
 * No-light SetupModels return `partCount == 0` from the wasm side —
 * which is the COMMON case for retail Holtburg (most buildings are
 * raw 0x01 GfxObjs with no Setup; the wasm returns empty for those).
 * The summary's `noLightModels` count surfaces this for capture
 * scripts.
 *
 * @param {Object} scene3d - the live `liveScene3d` shape.
 * @param {Object} wasmExports - the wasmExports passed into `init3D`.
 *   Must carry `fetchSetupModelLights`.
 * @returns {Promise<{
 *   lightCount: number,        // total PointLight + SpotLight count
 *   pointLightCount: number,
 *   spotLightCount: number,
 *   modelsScanned: number,      // unique setup_ids walked
 *   modelsWithLights: number,   // setup_ids that returned ≥1 light
 *   noLightModels: number,      // setup_ids that returned 0 lights
 *   wasmExportMissing: boolean, // true if fetchSetupModelLights absent
 * }>}
 */
export async function attachSetupModelLights(scene3d, wasmExports) {
  const summary = {
    lightCount: 0,
    pointLightCount: 0,
    spotLightCount: 0,
    modelsScanned: 0,
    modelsWithLights: 0,
    noLightModels: 0,
    wasmExportMissing: false,
    // C3 #6 — per-lb-key bucket of the light instances attached on this
    // pass, so the caller (index.js `_rescanSetupLights`) can fan them
    // into `landblockLru.track(lbKey, { lights })` for synchronous
    // splice/detach/dispose on eviction. Entity-rig lights get NO lbKey
    // (owned by entities.js remove()) so they never land here.
    /** @type {Map<number, THREE.Light[]>} */
    lightsByLbKey: new Map(),
  };

  if (!scene3d) return summary;
  if (
    !wasmExports ||
    typeof wasmExports.fetchSetupModelLights !== "function"
  ) {
    summary.wasmExportMissing = true;
    return summary;
  }

  // Ensure activeLights array exists on scene3d. The per-tick cap
  // reads from it.
  if (!Array.isArray(scene3d.activeLights)) {
    scene3d.activeLights = [];
  }

  // Pre-scan: collect (setup_id → list of part-rooted Object3D groups
  // keyed by part index). The Holtburg builder's convention (see
  // `buildings.js` `buildOneBuilding`):
  //   placementGroup (carries `userData.modelId`, modelId == setup_id)
  //     ├─ hingeWrapper "part-0"  (the per-part Object3D)
  //     ├─ hingeWrapper "part-1"
  //     └─ ...
  //
  // Statics (`statics.js`) build a single fused Mesh per modelId —
  // no per-part subdivision, so they have a single "part 0" wrapper
  // (the Mesh itself). We treat the Mesh as part-0 for light
  // attachment when it carries `userData.modelId`.
  //
  // EnvCells (`cells.js`) use `meshGroup` parented under the cell
  // container. We don't currently surface per-cell setup ids the same
  // way (cells reference Environment, not Setup); skip them for the
  // first cut. Capture script asserts `lightCount >= 0` which covers
  // the empty case.
  //
  // Entities (`entities.js`) — each entity rig has per-part Group
  // children. Same convention as buildings; we'd reach them via
  // `scene3d.entityManager.entityMap` (Map<guid, { root, parts: [Group, ...] }>).
  // C3 #6 — each entry also carries the resolved `lbKey` (16-bit packed
  // landblock key) of the placement it belongs to, so the attach loop
  // can stamp `inst.userData.__lbKey` and bucket the instance into
  // `summary.lightsByLbKey` for eviction. `lbKey === null` means the
  // owner manages the light's lifecycle itself (entity rigs).
  /** @type {Map<number, Array<{ partIndex: number, object3D: any, lbKey: number|null }>>} */
  const partsBySetupId = new Map();

  function recordBuildingTree(buildingsGroup) {
    if (!buildingsGroup || !Array.isArray(buildingsGroup.children)) return;
    for (const placementGroup of buildingsGroup.children) {
      const ud = placementGroup.userData || {};
      const modelId = (ud.modelId >>> 0);
      if (!modelId) continue;
      // Render-completeness audit (2026-05-29): idempotency tag so this
      // function is safe to re-run as landblocks stream in (GAP 2). A
      // placement already scanned at boot or on a prior LB load keeps its
      // attached lights and is skipped here; only freshly-baked geometry is
      // processed. Without this, each per-LB re-run would re-attach a fresh
      // light to every existing placement and pile up duplicates.
      if (ud.__setupLightScanned) continue;
      ud.__setupLightScanned = true;
      // C3 #6 — resolve the placement's lb-key off its userData
      // landblockId (full 32-bit; mask via lbKeyOf) so eviction can
      // splice this placement's lights.
      const lbKey = ud.landblockId != null ? lbKeyOf(ud.landblockId >>> 0) : null;
      // partGroups is an array of hingeWrappers (Phase 7.2 stash);
      // their `.userData.partIndex` is dense from 0.
      const partGroups =
        ud.partGroups ||
        placementGroup.children.filter((c) =>
          /^part-\d+$/.test(c.name || "")
        );
      if (!partGroups || partGroups.length === 0) continue;
      let entry = partsBySetupId.get(modelId);
      if (!entry) {
        entry = [];
        partsBySetupId.set(modelId, entry);
      }
      for (const partGroup of partGroups) {
        const pi =
          (partGroup.userData?.partIndex ?? -1) >>> 0 >= 0
            ? partGroup.userData?.partIndex ?? 0
            : 0;
        entry.push({ partIndex: pi, object3D: partGroup, lbKey });
      }
    }
  }

  function recordStatics(staticsGroup) {
    if (!staticsGroup || !Array.isArray(staticsGroup.children)) return;
    for (const mesh of staticsGroup.children) {
      const ud = mesh.userData || {};
      const modelId = (ud.modelId >>> 0);
      if (!modelId) continue;
      // Idempotency tag (GAP 2) — see recordBuildingTree.
      if (ud.__setupLightScanned) continue;
      ud.__setupLightScanned = true;
      // C3 #6 — resolve the static's lb-key (walk-up off userData
      // landblockId) so eviction can splice this static's lights.
      const lbKey = ud.landblockId != null ? lbKeyOf(ud.landblockId >>> 0) : null;
      // Fused mesh — treat as part 0. Capture-script side asserts
      // `light.parent === mesh` for statics with lights.
      let entry = partsBySetupId.get(modelId);
      if (!entry) {
        entry = [];
        partsBySetupId.set(modelId, entry);
      }
      entry.push({ partIndex: 0, object3D: mesh, lbKey });
    }
  }

  function recordEntities(entityManager) {
    const map = entityManager?.entityMap;
    if (!map || typeof map.forEach !== "function") return;
    map.forEach((inst) => {
      const root = inst?.root;
      if (!root) return;
      const setupId =
        ((inst?.meta?.modelId ?? inst?.meta?.setupId ?? 0) >>> 0);
      if (!setupId) return;
      // Idempotency tag (GAP 2) — see recordBuildingTree. Entities that
      // spawn after a rescan are caught by the next per-LB rescan.
      if (inst._setupLightScanned) return;
      inst._setupLightScanned = true;
      const parts = inst.parts || [];
      let entry = partsBySetupId.get(setupId);
      if (!entry) {
        entry = [];
        partsBySetupId.set(setupId, entry);
      }
      // C3 #6 — entity-rig lights are owned by entities.js `remove()`
      // (it detaches/disposes per-rig lights), so they get NO __lbKey
      // and are NEVER bucketed into lightsByLbKey. Pass lbKey: null.
      for (let pi = 0; pi < parts.length; pi += 1) {
        const p = parts[pi];
        if (p) entry.push({ partIndex: pi, object3D: p, lbKey: null });
      }
      // If no per-part groups were tracked, fall back to attaching at
      // the rig root as part 0.
      if (parts.length === 0) {
        entry.push({ partIndex: 0, object3D: root, lbKey: null });
      }
    });
  }

  // Render-completeness audit (2026-05-29) — GAP 1: EnvCell interior static
  // props (lanterns / braziers / candelabra) carry SetupModel LightInfo just
  // like outdoor statics, but were never scanned ("skip them for the first
  // cut" — the comment block above). That left every dungeon and building
  // interior lit only by the flat indoor AmbientLight, with no local torch
  // glow. Cell statics are fused meshes added directly to each cellContainer
  // under `cellsGroup`, tagged `userData.isCellStatic` with `modelId = so.did`
  // (cells.js). Walk two levels deep and record each as part 0 (same as
  // outdoor statics). `0x01` raw-GfxObj modelIds yield no lights (the wasm
  // getter early-returns), so only genuine `0x02` Setups with a light table
  // contribute — exactly the lanterns we want.
  function recordCellStatics(cellsGroup) {
    if (!cellsGroup || !Array.isArray(cellsGroup.children)) return;
    for (const cellContainer of cellsGroup.children) {
      if (!cellContainer || !Array.isArray(cellContainer.children)) continue;
      for (const mesh of cellContainer.children) {
        const ud = mesh.userData || {};
        if (!ud.isCellStatic) continue;
        const modelId = (ud.modelId >>> 0);
        if (!modelId) continue;
        if (ud.__setupLightScanned) continue;
        ud.__setupLightScanned = true;
        // C3 #6 — resolve the cell static's lb-key from its cellId
        // (cellId & 0xffff_0000 === lbKey) so eviction can splice this
        // interior prop's lights.
        const lbKey = ud.cellId != null ? lbKeyOf(ud.cellId >>> 0) : null;
        let entry = partsBySetupId.get(modelId);
        if (!entry) {
          entry = [];
          partsBySetupId.set(modelId, entry);
        }
        entry.push({ partIndex: 0, object3D: mesh, lbKey });
      }
    }
  }

  recordBuildingTree(scene3d.buildingsGroup);
  recordStatics(scene3d.staticsGroup);
  recordEntities(scene3d.entityManager);
  recordCellStatics(scene3d.cellsGroup);

  if (partsBySetupId.size === 0) {
    return summary;
  }

  // Fetch lights for every unique setup id, in parallel.
  const setupIds = [...partsBySetupId.keys()];
  summary.modelsScanned = setupIds.length;
  const bundles = await Promise.all(
    setupIds.map(async (sid) => {
      try {
        const b = await wasmExports.fetchSetupModelLights(sid);
        return { setupId: sid, bundle: b };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[phase7.6.1] fetchSetupModelLights(0x${sid.toString(16)}) failed:`,
          e
        );
        return { setupId: sid, bundle: null };
      }
    })
  );

  // For each setup id that has lights, instantiate per-part lights.
  for (const { setupId, bundle } of bundles) {
    if (!bundle) {
      summary.noLightModels += 1;
      continue;
    }
    const lightCount = bundle.partCount | 0;
    if (lightCount === 0) {
      summary.noLightModels += 1;
      if (typeof bundle.free === "function") {
        try { bundle.free(); } catch (_) {}
      }
      continue;
    }
    summary.modelsWithLights += 1;
    const setupLights = bundle.takeLights();
    if (typeof bundle.free === "function") {
      try { bundle.free(); } catch (_) {}
    }
    const partEntries = partsBySetupId.get(setupId) || [];

    for (const sl of setupLights) {
      const lightObj = makeThreeLightForSetupLight(sl);
      if (lightObj === null) {
        if (typeof sl.free === "function") {
          try { sl.free(); } catch (_) {}
        }
        continue;
      }
      // Find every matching part Object3D for this setup id. Each
      // placement of the building/static gets its own light copy so
      // two instances of the same building light independently.
      const targetPartIndex = sl.partIndex >>> 0;
      let attachedAny = false;
      // Perf C7 — template is built lazily on the first 2nd-placement
      // (i.e. when we'd otherwise call `lightObj.clone()`). One-
      // placement setups never pay the template cost.
      /** @type {ReturnType<typeof getOrBuildLightTemplate>|null} */
      let template = null;
      for (const { partIndex, object3D, lbKey } of partEntries) {
        if (partIndex !== targetPartIndex) continue;
        // Per-placement instance. First placement reuses the source
        // light (zero allocation beyond what `makeThreeLightForSetupLight`
        // already paid); subsequent placements construct a fresh
        // Light from the shared template — drops the `Light.clone()`
        // recursive-structured-clone cost without breaking C6's
        // per-light `.visible` (each placement still owns its own
        // Object3D + parent) or three.js's one-parent-per-Object3D
        // rule.
        let inst;
        if (!attachedAny) {
          inst = lightObj;
        } else {
          if (template === null) template = getOrBuildLightTemplate(lightObj);
          inst = createLightFromTemplate(template, null);
        }
        attachedAny = true;
        object3D.add(inst);
        // B10b (likely:spotlight-target): an oriented SpotLight aims at
        // its `.target`; parent the target as a sibling under the SAME
        // part Object3D so it tracks the rig. `releaseLight`/evict
        // detaches it. DORMANT on shipped data (PointLights have no
        // `spotTargetLocal`), so this branch never runs today.
        if (inst.isSpotLight && inst.userData && inst.userData.spotTargetLocal) {
          object3D.add(inst.target);
        }
        // Pool mode: every source light must be a PERMANENT `.visible=false`
        // carrier (the fixed pool, not the source, is what the renderer counts).
        // THREE lights default to visible=true, so force it off here BEFORE the
        // first render — otherwise a freshly-attached source is counted for a
        // frame and triggers the very relink the pool exists to prevent.
        if (getLightPoolConfig().enabled) inst.visible = false;
        scene3d.activeLights.push(inst);
        summary.lightCount += 1;
        if (inst.isPointLight) summary.pointLightCount += 1;
        else if (inst.isSpotLight) summary.spotLightCount += 1;
        // C3 #6 — stamp the per-light-instance lb-key (NEVER the shared
        // template params) and bucket into lightsByLbKey so the caller
        // can hand this LB's lights to `landblockLru.track(lbKey,
        // {lights})` for splice/detach/dispose on eviction. Entity-rig
        // lights carry lbKey === null and are skipped (owned by
        // entities.js remove()).
        if (lbKey != null) {
          if (!inst.userData) inst.userData = {};
          inst.userData.__lbKey = lbKey >>> 0;
          let bucket = summary.lightsByLbKey.get(lbKey >>> 0);
          if (!bucket) {
            bucket = [];
            summary.lightsByLbKey.set(lbKey >>> 0, bucket);
          }
          bucket.push(inst);
        }
      }
      if (!attachedAny) {
        // No matching part for this light's partIndex — possible
        // when a Setup's lights table references a part index that
        // got skipped (0-tri parts are still slotted in the JS
        // building bake, so this is rare). Drop the original light.
        // (It's still in JS heap until GC; nothing else holds it.)
      }
      if (typeof sl.free === "function") {
        try { sl.free(); } catch (_) {}
      }
    }
  }

  return summary;
}

// Perf C7 — per-source light template cache. Keyed off the source
// THREE.Light returned by `makeThreeLightForSetupLight`. Each unique
// source builds its template once; every placement past the first
// reads from the cached template + constructs a fresh Light instance
// via `createLightFromTemplate` (cheap direct property copy) instead
// of `Object.clone()` (recursive structured clone, JSON deep-copies
// `userData`, walks the children array, etc.).
//
// Why a WeakMap on the source light? The source is itself an
// allocation we already pay for (the first placement uses it
// directly); keying templates off it lets us GC both together when
// the attach pass finishes. We never need to look up by setup id —
// the call site already has the source light in scope from the outer
// `for (const sl of setupLights)` loop.
//
// Why one template per source (not one per setupId)? Each `sl` in a
// setup's lights table is its own distinct light (different position,
// possibly different color/intensity/cone). One source → one
// template; multiple placements of the same building → multiple
// instances of that template.
//
// Why is "Option A" safe here? Each `sl` produces a single source
// light via `makeThreeLightForSetupLight`. EVERY placement of that
// setup (matching `partIndex`) uses that exact same `sl` — so color,
// intensity, distance, decay, angle, penumbra, and the part-local
// position are constant across placements. Only the parent (and
// therefore the world-space position) varies. That makes the
// "shared parameters, separate instances" precondition true.
/** @type {WeakMap<any, { type: string, color: any, intensity: number, distance: number, decay: number, angle: number, penumbra: number, posX: number, posY: number, posZ: number, userData: any }>} */
const lightTemplateCache = new WeakMap();

/**
 * Build (or return cached) per-source-light template carrying the
 * constant render parameters + part-local position. Used by
 * `createLightFromTemplate` to allocate fresh Light Object3Ds
 * without paying `Object3D.clone()`'s deep-copy cost.
 *
 * The template's `userData` is the source light's `userData` by
 * reference — every placement shares the same diagnostic bag. Safe
 * because the only consumer (capture scripts) treats it as
 * read-only.
 */
function getOrBuildLightTemplate(sourceLight) {
  let template = lightTemplateCache.get(sourceLight);
  if (template) return template;
  // SpotLight has angle + penumbra; PointLight doesn't. We carry
  // both fields anyway and `createLightFromTemplate` picks based on
  // `type` — keeps the template shape uniform.
  template = {
    type: sourceLight.isSpotLight ? "SpotLight" : "PointLight",
    color: sourceLight.color,
    intensity: sourceLight.intensity,
    distance: sourceLight.distance,
    decay: sourceLight.decay,
    angle: sourceLight.isSpotLight ? sourceLight.angle : 0,
    penumbra: sourceLight.isSpotLight ? sourceLight.penumbra : 0,
    posX: sourceLight.position.x,
    posY: sourceLight.position.y,
    posZ: sourceLight.position.z,
    userData: sourceLight.userData,
  };
  lightTemplateCache.set(sourceLight, template);
  return template;
}

/**
 * Perf C7 — construct a fresh `THREE.PointLight` / `THREE.SpotLight`
 * from a shared `lightInfo` template. Replaces `Object3D.clone()` at
 * the per-placement hot path.
 *
 * Each call yields its OWN Object3D (its own `.parent`, its own
 * `.visible`, its own `getWorldPosition` chain), so:
 *   - C6's distance-sort still toggles `.visible` per-Light.
 *   - Three.js's one-parent-per-Object3D rule is satisfied (every
 *     placement parents its own instance).
 *   - C6's throttle state (`_lightSortFrameCounter`,
 *     `_lightSortLastFrame`, `_lightSortLastCount`) is untouched.
 *
 * @param {Object} template - from `getOrBuildLightTemplate`.
 * @param {{x: number, y: number, z: number}|null} transform - part-
 *   local position. `null` to use the template's cached position
 *   (the common case — all placements of one `sl` share its
 *   part-local origin).
 */
function createLightFromTemplate(template, transform) {
  let light;
  if (template.type === "SpotLight") {
    light = new THREE.SpotLight(
      template.color,
      template.intensity,
      template.distance,
      template.angle,
      template.penumbra,
      template.decay
    );
  } else {
    light = new THREE.PointLight(
      template.color,
      template.intensity,
      template.distance,
      template.decay
    );
  }
  const px = transform ? transform.x : template.posX;
  const py = transform ? transform.y : template.posY;
  const pz = transform ? transform.z : template.posZ;
  light.position.set(px, py, pz);
  // Shallow-copy userData so each placement carries its own bag
  // (mirrors three.js `Object3D.clone()`'s JSON deep-copy semantics
  // without the JSON cost — userData is one nested object deep here).
  const srcUd = template.userData;
  if (srcUd) {
    const ud = {};
    for (const k in srcUd) {
      if (Object.prototype.hasOwnProperty.call(srcUd, k)) {
        ud[k] = srcUd[k];
      }
    }
    light.userData = ud;
  }
  // B10b (likely:spotlight-target): re-aim a templated SpotLight's
  // target from the (part-local) `spotTargetLocal` the source carried.
  // All placements of one `sl` share the same part-local origin +
  // orientation, so the target position is identical per template. The
  // attach loop adds `light.target` under the part Object3D. DORMANT on
  // shipped data (no SpotLights → `spotTargetLocal` absent).
  if (
    light.isSpotLight &&
    light.userData &&
    light.userData.spotTargetLocal
  ) {
    const t = light.userData.spotTargetLocal;
    light.target.position.set(t.x, t.y, t.z);
  }
  return light;
}

/**
 * Build a single `THREE.PointLight` or `THREE.SpotLight` from a wasm
 * `SetupLight` getter struct (or a plain JS object with the same
 * field shape). Position is set from `(x, y, z)` in the source's
 * native AC coords; caller parents the result under a part `Object3D`
 * which is itself under `worldRoot` (which carries the AC→three
 * rotation).
 *
 * Returns `null` if the input doesn't have the minimum field shape.
 *
 * === Wave R2.A divergence (linear vs inverse-square falloff) ===
 * Retail's `calc_point_light` (`~/ac-headers/acclient.c:454579`) uses a
 * LINEAR distance falloff `attenuation = clamp(1 - dist/range, 0, 1)` (with
 * `range = falloff * static_light_factor`) plus a per-RGB clamp
 * `contrib_c = min(intensity·dot·atten·color_c, color_c)`
 * (`acclient.c:454616-454627`). three.js PointLight/SpotLight instead use a
 * PHYSICAL inverse-square falloff (`LIGHT_DECAY = 2.0`), and standard PBR
 * clamps the accumulated contribution to `[0,1]` (not per-channel against the
 * light's own color). Matching retail exactly needs an `onBeforeCompile`
 * shader patch in `materials.js`, which is owned by the SIBLING wave R2.B
 * (`?lightClamp=retail`). For R2.A we accept three.js's decay/penumbra and
 * the standard clamp; the visual delta is a slightly tighter falloff and
 * colored lights that can wash toward white at high intensity until R2.B
 * lands. `falloff` maps to three.js `distance` (max reach), which IS a
 * faithful proxy for AC's `range` cutoff.
 */
function makeThreeLightForSetupLight(sl) {
  if (!sl) return null;
  // Read defensively — wasm-bindgen getters can throw if the handle
  // has been freed, and tests pass plain objects with identical shape.
  let x, y, z, r, g, b, intensity, falloff, coneAngle;
  // B10b (likely:spotlight-target): orientation quaternion (AC wire
  // order w,x,y,z). ABSENT on the currently-shipped wasm pkg (these
  // getters were added in this batch but the committed pkg predates a
  // wasm-pack rebuild) → reading them yields `undefined` → `+undefined`
  // === NaN, so the `Number.isFinite` guard below leaves the SpotLight
  // target wiring DORMANT until a rebuild activates the feature.
  let qx, qy, qz, qw;
  try {
    x = +sl.x;
    y = +sl.y;
    z = +sl.z;
    r = +sl.colorR;
    g = +sl.colorG;
    b = +sl.colorB;
    intensity = +sl.intensity;
    falloff = +sl.falloff;
    coneAngle = +sl.coneAngle;
    qx = +sl.qx;
    qy = +sl.qy;
    qz = +sl.qz;
    qw = +sl.qw;
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  // LG1 (waves-3): floor at 0 (negative/non-finite = malformed; AC's
  // LightInfo.intensity is unsigned-physical) and cap at LIGHT_INTENSITY_CLAMP
  // (=120, admits the real-data max of 100 with headroom — see the constant's
  // census note). Passing the RAW authored intensity (20–100) is what lets a
  // torch saturate to its warm color across most of its radius per retail
  // calc_point_light (acclient.c:454615-454627), before the linear 1-dist/range
  // falloff; the old cap of 8 crushed that to a dim pool.
  //
  // TODO(LG2): the half-Lambert wrap term (acclient.c:454608) is the remaining
  // retail-fidelity refinement; it lives in the ?lightClamp=retail SHADER in
  // materials.js (Agent C's file) — NOT here.
  const safeIntensity = Math.max(
    0,
    Math.min(LIGHT_INTENSITY_CLAMP, Number.isFinite(intensity) ? intensity : 0)
  );
  // Distance attenuation — falloff IS the distance metric in AC.
  // three.js PointLight / SpotLight use `distance` for max reach;
  // 0 means infinite. Negative/NaN → 0 (infinite) for safety.
  //
  // === L2 (render-completeness waves-2, 2026-05-29) — static_light_factor ===
  // Retail `range = falloff * static_light_factor`, where
  // static_light_factor = 1.3 (constant acclient.c:45774; applied in
  // calc_point_light acclient.c:454605). Without it every lantern/brazier/
  // torch reaches ~30% short. Applied here EXACTLY ONCE (the SINGLE site):
  // `safeFalloff` is what we pass to three's PointLight/SpotLight `distance`,
  // and the C7 template path reads back this already-multiplied `.distance`,
  // so all placements inherit it with no double-multiply. lib.rs's
  // `collect_setup_model_lights` deliberately surfaces RAW `falloff` (it does
  // NOT pre-multiply), so this is the only 1.3× in the chain (STATIC_LIGHT_FACTOR
  // is the module-level const). Default-on, fail-soft (0/NaN falloff ⇒ 0 =
  // infinite reach, unchanged).
  const safeFalloff =
    Number.isFinite(falloff) && falloff > 0 ? falloff * STATIC_LIGHT_FACTOR : 0;
  // #16 (2026-06-07) — AC's LightInfo color channels are authored in
  // gamma/sRGB space (the same space the DAT textures live in). With
  // three.js ColorManagement enabled (the renderer's default), a bare
  // `new THREE.Color(r,g,b)` treats the triple as already-linear and
  // skips the sRGB→linear decode, over-brightening + desaturating every
  // lantern/brazier tint. `setRGB(r,g,b, SRGBColorSpace)` does the
  // decode so the linear color the shader sees matches the authored hue.
  const color = new THREE.Color().setRGB(
    Number.isFinite(r) ? r : 1,
    Number.isFinite(g) ? g : 1,
    Number.isFinite(b) ? b : 1,
    THREE.SRGBColorSpace
  );
  let lightObj;
  // B10b (likely:spotlight-target): SpotLight cone aim. Computed ONLY
  // when this is a SpotLight AND the bridged orientation quaternion is
  // present + finite. On the currently-shipped pkg the qx/qy/qz/qw
  // getters are absent (→ NaN) AND all shipped LightInfo descriptors
  // have cone_angle<=0 (→ PointLight), so `spotTargetLocal` stays null
  // and the attach/release path is byte-identical to today. A SpotLight
  // with no orientation falls back to three.js's default downward aim.
  let spotTargetLocal = null;
  if (Number.isFinite(coneAngle) && coneAngle > 0) {
    // SpotLight. `angle` is the cone's half-angle in radians;
    // `penumbra` is the soft-edge fraction; `decay` is physical
    // inverse-square falloff.
    lightObj = new THREE.SpotLight(
      color,
      safeIntensity,
      safeFalloff,
      coneAngle,
      SPOTLIGHT_PENUMBRA,
      LIGHT_DECAY
    );
    if (
      Number.isFinite(qx) &&
      Number.isFinite(qy) &&
      Number.isFinite(qz) &&
      Number.isFinite(qw)
    ) {
      // The light + its target are siblings under the per-part
      // Object3D (which itself carries the AC→three rotation via
      // worldRoot), so both stay in the AC-native part frame — the
      // same frame the rest-pose path applies its raw AC quat in
      // (entities.js `partGroup.quaternion.set(qx,qy,qz,qw)`). AC's
      // canonical forward is +Y; rotate it by the orientation quat to
      // get the cone direction, then place the target one unit ahead
      // of the light's local origin.
      const aim = new THREE.Vector3(0, 1, 0).applyQuaternion(
        new THREE.Quaternion(qx, qy, qz, qw)
      );
      spotTargetLocal = { x: x + aim.x, y: y + aim.y, z: z + aim.z };
      lightObj.target.position.set(
        spotTargetLocal.x,
        spotTargetLocal.y,
        spotTargetLocal.z
      );
    }
  } else {
    // PointLight.
    lightObj = new THREE.PointLight(
      color,
      safeIntensity,
      safeFalloff,
      LIGHT_DECAY
    );
  }
  lightObj.position.set(x, y, z);
  lightObj.userData = {
    fromSetupModelLight: true,
    setupLightOrigin: { x, y, z },
    coneAngle,
    falloff: safeFalloff,
    // B10b: non-null only for an oriented SpotLight; the attach loop
    // reads it to add `light.target` as a sibling under the same part
    // Object3D, and `releaseLight` detaches it on eviction.
    spotTargetLocal,
  };
  return lightObj;
}

// === Wave R2.A (2026-05-28) — public entry point onto the same
// `makeThreeLightForSetupLight` constructor the static-light path uses, so
// `entities.js` builds entity-attached SetLight lights with IDENTICAL color/
// intensity/falloff/cone math (PointLight when `cone_angle == 0`, SpotLight
// when `> 0`; the LIGHT_INTENSITY_CLAMP, SPOTLIGHT_PENUMBRA, and LIGHT_DECAY
// constants apply uniformly). Additive — the private helper is unchanged and
// still drives `attachSetupModelLights`. Returns `null` on malformed input.
export function buildLightForSetupLight(sl) {
  return makeThreeLightForSetupLight(sl);
}

// Expose canonical intensities + the per-light cap so capture
// scripts can assert the exact values without re-deriving them.
export const LIGHTING_CONSTANTS = Object.freeze({
  AMBIENT_INTENSITY_OUTDOOR,
  AMBIENT_INTENSITY_INDOOR,
  MAX_ACTIVE_LIGHTS,
  LIGHT_INTENSITY_CLAMP,
  SPOTLIGHT_PENUMBRA,
  LIGHT_DECAY,
  // waves-2 (2026-05-29): L1 ambient floor + L2 light-range factor.
  LSCAPE_LIGHT_MINIMUM,
  STATIC_LIGHT_FACTOR,
});
