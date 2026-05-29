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
    csmState = setupCsm(scene, {
      sunDir: { x: sunPos.x, y: sunPos.y, z: sunPos.z },
    });
  }

  function dispose() {
    if (sun.shadow && sun.shadow.map && typeof sun.shadow.map.dispose === "function") {
      sun.shadow.map.dispose();
    }
    if (csmState && typeof csmState.dispose === "function") {
      csmState.dispose();
    }
    scene.remove(lightsGroup);
  }

  return { sun, ambient, hemisphere, lightsGroup, csmState, dispose };
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
 */
export function updateShadowCameraTarget(lighting, targetThreePos) {
  if (!lighting || !targetThreePos) return;
  const sun = lighting.sun;
  if (!sun || !sun.castShadow) return;
  const target = sun.target;
  if (!target) return;
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
  }
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

// Clamp on per-light intensity. AC's `LightInfo.intensity` field has
// no documented upper bound; capping at 8 keeps headroom for
// gamma-corrected tone mapping without one rogue 9999.0 entry blowing
// out the scene.
const LIGHT_INTENSITY_CLAMP = 8.0;

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
        // sun.visible flip — single comparison gate so we don't repeatedly
        // dirty the GL state every frame for an already-correct value.
        const wantSunVisible = !isIndoor;
        if (sun.visible !== wantSunVisible) {
          sun.visible = wantSunVisible;
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
            if (
              Math.abs(ambient.color.r - c.r) > 1e-4 ||
              Math.abs(ambient.color.g - c.g) > 1e-4 ||
              Math.abs(ambient.color.b - c.b) > 1e-4
            ) {
              ambient.color.setRGB(c.r, c.g, c.b);
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
      updateShadowCameraTarget(lighting, playerThreePos);
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
      } catch (e) {
        if (!scene3d._csmTickWarned) {
          scene3d._csmTickWarned = true;
          // eslint-disable-next-line no-console
          console.warn("[visfid-p33] CSM tick failed:", e);
        }
      }
    }
  }

  // === Per-SetupModel light cap (top-32 by squared distance) ==========
  // We cap regardless of whether the indoor toggle ran (capture scripts
  // can validate the cap with a sessionHandle that has no
  // isCurrentCellIndoor — the cap exists on its own merits).
  capActiveLightsByDistance(scene3d);
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
  if (!Array.isArray(lights) || lights.length === 0) return;

  // Resolve camera (Phase 7.5 switcher; fall back to .camera).
  const camera =
    scene3d?.cameraSwitcher?.activeCamera ?? scene3d?.camera ?? null;
  if (!camera || !camera.position) {
    // No camera to sort against. Leave .visible flags as-is.
    return;
  }

  // Perf C6 — throttle: increment per-scene3d frame counter, then
  // decide whether to skip the sort + .visible toggle this tick. We
  // skip when both (a) we sorted recently (< LIGHT_SORT_INTERVAL
  // frames ago) AND (b) the active light count is unchanged since the
  // last sort. Any count delta (a spawn / despawn from
  // `attachSetupModelLights` or cell unload) forces a fresh sort so a
  // newly-attached light doesn't sit invisible behind the cap. The
  // previous-frame .visible flags survive untouched, which IS the win
  // — the toggle loop also gets skipped, not just the sort.
  const frameCounter = (scene3d._lightSortFrameCounter ?? 0) + 1;
  scene3d._lightSortFrameCounter = frameCounter;
  const lastSortFrame = scene3d._lightSortLastFrame ?? 0;
  const lastSortCount = scene3d._lightSortLastCount ?? -1;
  if (
    lastSortCount === lights.length &&
    frameCounter - lastSortFrame < LIGHT_SORT_INTERVAL
  ) {
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
  // The top MAX_ACTIVE_LIGHTS slots get .visible = true; the rest
  // .visible = false. Single-comparison gate so we don't dirty
  // already-correct flags.
  for (let i = 0; i < scratch.length; i += 1) {
    const want = i < MAX_ACTIVE_LIGHTS;
    const light = scratch[i].light;
    if (light.visible !== want) {
      light.visible = want;
    }
  }

  // Perf C6 — record this sort so the next LIGHT_SORT_INTERVAL-1
  // frames can early-out at the gate above.
  scene3d._lightSortLastFrame = frameCounter;
  scene3d._lightSortLastCount = lights.length;
}

function sortByDistSq(a, b) { return a.distSq - b.distSq; }

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
  /** @type {Map<number, Array<{ partIndex: number, object3D: any }>>} */
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
        entry.push({ partIndex: pi, object3D: partGroup });
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
      // Fused mesh — treat as part 0. Capture-script side asserts
      // `light.parent === mesh` for statics with lights.
      let entry = partsBySetupId.get(modelId);
      if (!entry) {
        entry = [];
        partsBySetupId.set(modelId, entry);
      }
      entry.push({ partIndex: 0, object3D: mesh });
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
      for (let pi = 0; pi < parts.length; pi += 1) {
        const p = parts[pi];
        if (p) entry.push({ partIndex: pi, object3D: p });
      }
      // If no per-part groups were tracked, fall back to attaching at
      // the rig root as part 0.
      if (parts.length === 0) {
        entry.push({ partIndex: 0, object3D: root });
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
        let entry = partsBySetupId.get(modelId);
        if (!entry) {
          entry = [];
          partsBySetupId.set(modelId, entry);
        }
        entry.push({ partIndex: 0, object3D: mesh });
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
      for (const { partIndex, object3D } of partEntries) {
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
        scene3d.activeLights.push(inst);
        summary.lightCount += 1;
        if (inst.isPointLight) summary.pointLightCount += 1;
        else if (inst.isSpotLight) summary.spotLightCount += 1;
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
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  // Clamp intensity for sanity. Negative intensities are ignored —
  // AC's LightInfo.intensity is documented unsigned-physical, so a
  // negative is malformed data.
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
  const color = new THREE.Color(
    Number.isFinite(r) ? r : 1,
    Number.isFinite(g) ? g : 1,
    Number.isFinite(b) ? b : 1
  );
  let lightObj;
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
