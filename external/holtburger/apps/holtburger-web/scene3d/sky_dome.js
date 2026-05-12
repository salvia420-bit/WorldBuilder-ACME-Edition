// Workstream Sky-D + Sky-I-B (2026-05-11) — sky-cell render path.
//
// **Sky-I-B refactor (2026-05-11).** This file used to render the sky
// dome + celestial bodies as direct children of the main `THREE.Scene`,
// with each celestial body positioned via a `celestialPosition(h, p, r)
// = (sin(h)*cos(p), sin(p), -cos(h)*cos(p)) * 900` spherical projection
// AROUND the camera, plus a global `CELESTIAL_BODY_SCALE = 30` applied
// to each mesh. The Sky-I-A empirical probe (see
// `external/holtburger/docs/sky-i-probe-2026-05-11.md`) surfaced three
// stacked bugs that conspired to put the sun's world position at
// (59124, 54269, -87511) — 80,284 units from camera, 16× past
// camera.far=5000:
//
//   1. **Double-transform.** AC's sun mesh's vertices already sit at
//      x∈[1844, 1974] (center ~1909) in the DAT — the asset pipeline
//      ships the celestials at their final cell-local placement.
//      Sky-D added a SECOND placement on top via `celestialPosition`.
//   2. **CELESTIAL_BODY_SCALE = 30.** Multiplied the already-placed
//      1909-unit vertex center by 30, sending the worldCenter to ~57k.
//   3. **`evaluate_sky_object` treated `begin_angle`/`end_angle` as
//      RADIANS** when the DAT ships DEGREES. Same calibration finding
//      Sky-C already documented for `dir_heading`/`dir_pitch` — but
//      not propagated to per-SkyObject angles. At t=0.05 (foredawn),
//      `lerp(-20, 190, 0.0588) ≈ -7.65` was treated as 7.65 radians of
//      heading (≈ -438° wraparound) instead of -7.65 degrees.
//
// **Sky-I-B fix.** Architectural pattern: Garry's Mod 3D-skybox — render
// the sky into its own scene+camera, in a separate render pass, with
// its own far-clip (50000) and no fog. The sky cell is anchored at the
// main camera position per frame (so celestials never recede as the
// player walks), but its **rotation stays world-axis-locked** (so the
// sun stays at its compass bearing as the player turns). Concretely:
//
//   - `this.skyScene` — separate `THREE.Scene`.
//   - `this.skyCamera` — separate `THREE.PerspectiveCamera`, near=0.1,
//     far=50000 (comfortably contains the ~20km cloud-band cylinder
//     + the ~2700-unit sun/moon vertex AABBs).
//   - `this.skyCell` — `THREE.Group` named `sky_cell`, child of
//     `skyScene`. Rotation `x = -π/2` (mirrors `worldRoot` so AC-Z up
//     lands in three.js Y up — same convention the world scene uses).
//   - The gradient dome (`this.dome`) and each celestial body's
//     rotator-Group are children of `skyCell`. Celestial body meshes
//     keep their NATIVE vertex coords (no `position.set`, no `scale`
//     — `position=(0,0,0), scale=(1,1,1)`); rotation around the cell's
//     AC-Z axis (= the rotator's three-Y axis, since the parent
//     `skyCell` already rotated to land AC-Z = three-Y) is applied at
//     the rotator level.
//
//   - **Render pass.** `init3D`'s tick calls `skyDome.tick(dt,
//     activeCam)` first (for per-frame updates), then calls
//     `skyDome.renderSkyPass(renderer, activeCam)` AFTER the main
//     `renderer.render(scene, activeCam)`. The sky pass does:
//
//         renderer.autoClear = false;
//         renderer.clearDepth();                       // clean depth
//         skyCamera.position.copy(activeCam.position); // anchor
//         skyCamera.quaternion.copy(activeCam.quaternion);
//         skyCamera.fov = activeCam.fov;
//         skyCamera.aspect = activeCam.aspect;
//         skyCamera.updateProjectionMatrix();
//         renderer.render(skyScene, skyCamera);
//         renderer.autoClear = true;
//
//     The world scene renders first WITH its own depth buffer; we then
//     clear depth and render the sky cell INTO the framebuffer
//     wherever the world didn't already write. Sky-cell pixels appear
//     ONLY where the world geometry wasn't visible — i.e. always
//     "behind" the world by construction. Sky is exempt from world fog
//     by construction (separate scene).
//
//   - **Indoor flip.** When `isCurrentCellIndoor()` returns true,
//     `renderSkyPass` short-circuits (skipping clearDepth + the second
//     render call). EnvCells already render their own
//     ceiling/floor/walls; no sky-cell overlay needed inside.
//
// **What this preserves:**
//   - Sky-A/B's wasm-side SkyEval + per-keyframe lerp.
//   - Sky-C's directional/ambient lighting + scene.fog (main scene only).
//   - Sky-E's resolved `skyAssets` Map.
//   - Sky-G's SkyObjectReplace mesh-swap + UV scroll (`tex_offset_x/y`
//     still wires through to `material.map.offset`).
//   - The gradient-dome shader (now rendered in skyScene).
//   - The capture-script bullets (11/12) — bullet detection updated
//     to walk both `scene.children` AND `liveScene3d.skyDome.skyScene
//     .children`.
//
// **Coordinate-system note.** The native AC vertex layout has the sun's
// AABB center at ~(1909, 1875, 0) in AC coords (X-right, Y-north,
// Z-up). After the skyCell's `rotation.x = -π/2`, that maps to three.js
// (1909, 0, -1875) — sitting on the horizon (Z=0 in three-space-Y) to
// the player's east-and-slightly-north (positive X is east, negative Z
// is north after the rotation). The per-tick `rotation.z` on the
// rotator group is applied IN AC-coord space (before the skyCell's
// X-rotation), so a rotation around AC's Z-up axis is exactly what we
// want — it swings the sun from east toward south toward west across
// the visible day.
//
// **Open questions surfaced by Sky-I-A** (and our judgment calls):
//   - **Compass-bearing yaw**: world-axis-locked (skyCell rotates only
//     by its own `-π/2` X to match worldRoot; the skyCamera follows
//     the main camera's quaternion to render from the player's POV).
//   - **Pitch synthesis**: KEPT in the wasm-side `pitch` field but
//     NOT consumed by this renderer. Celestials trace a horizontal arc
//     at native vertex altitude (vertex Z spans -130..130 for the sun,
//     so the apparent "rising" comes from the angular sweep of the
//     vertex AABB across the visible arc; no pitch axis applied). If
//     the eye-test shows the sun never rises, re-add `rotator.rotation
//     .x = pitchSyntheticRad` and revisit.
//   - **`SkyObject.properties` bitfield**: bit 0x02 (cloud band) still
//     drives Sky-G's UV scroll; bits 0x01/0x04/0x08 untouched (defer).
//   - **`0x02xxxxxx` SetupModel proxies**: SKIPPED — the only
//     0x02xxxxxx in retail Dereth's Sunny DayGroup is `0x02000714`
//     (6 cm physics-script anchor for the moon, not a visible
//     celestial). Skipped in `populateCelestialBodies`.

import * as THREE from "three";

import { buildSkyObjectGroup } from "./sky_assets.js";
import { ParticleManager } from "./particles/index.js";

// ---- Constants -----------------------------------------------------
//
// `DOME_RADIUS` — large enough to feel "infinite" relative to the 9-LB
// Holtburg view. Drawn with `depthWrite=false` so it never occludes
// world geometry; rendered in the separate sky pass where depth is
// cleared before, so no depth ordering against world content.
const DOME_RADIUS = 1000.0;
// `SKY_CAMERA_FAR` — the sky cell's clipping volume. Must comfortably
// contain (a) sun + moon vertex AABBs (center ~1909 + half-extent ~225
// = ~2200 from cell origin), (b) the cloud-band's ~10,000-unit
// horizontal-cylinder geometry, (c) the always-visible base shells at
// ~1500 native distance, and (d) any future region that might place
// celestials further out. 50000 is the Sky-I-A memo's recommendation;
// the depth buffer stays well-conditioned because depth-test inside
// the skyScene is between sky-internal elements only (the world's
// depth has been cleared before the pass).
const SKY_CAMERA_FAR = 50000.0;
// `SKY_CAMERA_NEAR` matches the main camera so coplanar sky geometry
// isn't clipped. Sky-dome at radius 1000 + celestials at vertex
// distance ~1900 are both well beyond 0.1.
const SKY_CAMERA_NEAR = 0.1;

// ---- Gradient shader -----------------------------------------------
//
// GLSL3 (matches `scene3d/terrain.js`). `vWorldNormal` carries the
// inward-pointing normal of the back-side dome — since we render the
// inside, the normal is the same as the position direction (a sphere
// centred at the camera projects each fragment along its position).
// The `.y` component is "world up" after the dome's own (identity)
// rotation. `smoothstep(0, 0.5, y)` keeps the gradient compressed in
// the lower half so the dome reads as "horizon → sky" rather than
// "ground → space".
const DOME_VERTEX_GLSL = /* glsl */ `
out vec3 vWorldNormal;

void main() {
  // Inside-facing sphere: the world-space position vector AT the
  // fragment is the up-direction we want to sample. Normalize to keep
  // it unit-length for the smoothstep math.
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldNormal = normalize(worldPos.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const DOME_FRAGMENT_GLSL = /* glsl */ `
precision highp float;

in vec3 vWorldNormal;
out vec4 outColor;

uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;

void main() {
  // World-up component of the inside-facing normal. y=0 → horizon,
  // y=1 → zenith. smoothstep(0, 0.5, y) compresses the gradient into
  // the lower half — most of the dome reads as the zenith tint.
  float h = clamp(vWorldNormal.y, 0.0, 1.0);
  float t = smoothstep(0.0, 0.5, h);
  vec3 c = mix(uHorizonColor, uZenithColor, t);
  outColor = vec4(c, 1.0);
}
`;

/**
 * Decode an ARGB u32 (0xAARRGGBB) into a `THREE.Color`.
 *
 * Sky-C publishes `liveScene3d.skyBackgroundColor` as a u32 in this
 * exact form (with the alpha channel ignored at the renderer level —
 * the dome is opaque, the alpha-blend lives on per-SkyObject
 * materials).
 */
function argbToColor(u32, target) {
  const r = ((u32 >>> 16) & 0xff) / 255.0;
  const g = ((u32 >>> 8) & 0xff) / 255.0;
  const b = (u32 & 0xff) / 255.0;
  return target ? target.setRGB(r, g, b) : new THREE.Color(r, g, b);
}

/**
 * Sky-I-B: degrees lerp. Linear — sky headings progress monotonically
 * (sun goes E→W the long way through south; not shortest-arc), so
 * `lerp(beginDeg, endDeg, p)` is the right shape for the per-object
 * rotation. Matches `lerp_angle_radians` in `crates/holtburger-world/
 * src/sky.rs`'s comment — same parametric, different unit.
 */
function lerpDeg(a, b, p) {
  return a + (b - a) * p;
}

/**
 * Build a sky cell — separate render pass + camera-anchored Group
 * containing the gradient dome and per-SkyObject rotator subgroups.
 *
 * Inputs:
 *   - `scene` — root `THREE.Scene` (the WORLD scene). Used only for
 *     the indoor-flip query path and for capture-script discovery: the
 *     dome itself + celestial bodies live in `this.skyScene`, NOT
 *     under `scene`. Capture scripts that walk `scene.children` for
 *     `sky_dome` or `sky_object_id` should be updated to walk both
 *     `scene.children` AND `skyDome.skyScene.children`.
 *   - `skyAssets` — `Map<sky_object_id, bake>` from
 *     `resolveSkyAssets`. May be null/empty at construction time;
 *     the celestial bodies are populated lazily by
 *     `populateCelestialBodies` once Sky-E completes.
 *   - `materialCache` — shared `MaterialCache` for surface textures.
 *   - `sessionHandleAccessor` — `() => SessionHandle | null`. Read on
 *     every `tick(dt, camera)` to fetch the latest
 *     `getSkyObjectStates()` + `isCurrentCellIndoor()`.
 *   - `liveScene3dRef` — reference back to the `liveScene3d` object;
 *     used to read Sky-C's `skyBackgroundColor` (horizon-gradient
 *     sink) and `skyLightingController._lastState.ambColorArgb`
 *     (zenith).
 *
 * **Public state.**
 *   - `controller.dome` — `THREE.Mesh` for the gradient sphere
 *     (resident in `skyScene`).
 *   - `controller.skyScene` — `THREE.Scene` containing the sky cell.
 *   - `controller.skyCamera` — `THREE.PerspectiveCamera` for the sky
 *     pass.
 *   - `controller.skyCell` — `THREE.Group` holding the dome +
 *     rotators (camera-anchored each tick).
 *   - `controller.skyObjectMeshes` — `Map<sky_object_id, THREE.Group>`
 *     of per-object rotator Groups. The keys are `sky_object_id`
 *     (post-Sky-G mesh-swap-aware via `s.gfxObjectId`); the values are
 *     rotator Groups whose `rotation.z` is updated per tick.
 */
export class SkyDome {
  constructor(opts) {
    const {
      scene,
      sessionHandleAccessor,
      liveScene3dRef = null,
      skyAssets = null,
      materialCache = null,
      domeRadius = DOME_RADIUS,
      wasmExports = null,
    } = opts || {};
    if (!scene) {
      throw new Error("SkyDome: opts.scene required");
    }
    this.scene = scene;
    this.sessionHandleAccessor =
      typeof sessionHandleAccessor === "function"
        ? sessionHandleAccessor
        : () => null;
    this.liveScene3dRef = liveScene3dRef;
    this.domeRadius = domeRadius;
    // Sky-J P5: wasm exports used by the chain walker
    // (`fetchPhysicsScript`, `fetchParticleEmitter`, `fetchBuildingPlacement`).
    // May be null at construction (e.g. test fixtures) — the chain
    // walker no-ops when missing.
    this.wasmExports = wasmExports;
    // Sky-J P5: lazily created in `populateCelestialBodies` once we
    // have both wasmExports + a materialCache. `null` until then.
    this.particleManager = null;
    // Sky-J P5: track which 0x02 SkyObjects have had their PhysicsScript
    // chain walked. Keyed by sky_object_id (the DID, e.g. 0x02000714).
    this._particleChainsAttached = new Set();
    // Sky-J P5: per-attach in-flight tracker so we don't double-fire
    // the async chain walk when a SkyObject is repeatedly visible in
    // back-to-back ticks before the first walk completes.
    this._particleChainsPending = new Set();
    // Sky-J P5: map from sky_object_id → emitter ID list (per the
    // ParticleManager's addEmitter return). Lets us drive visibility
    // and stop/destroy at the per-SkyObject grain.
    this._particleEmittersForSkyObject = new Map();

    // === Sky scene + camera (separate render pass) ====================
    //
    // The sky pass runs AFTER the main render in `index.js`'s rAF tick.
    // It clears depth so the sky always lands behind world geometry,
    // then renders this scene with this camera (which mirrors the main
    // camera's orientation each tick but with its own far=50000 +
    // no-fog).
    this.skyScene = new THREE.Scene();
    this.skyScene.name = "sky_scene";
    // Stash the scene's reference fog policy explicitly so it's
    // obvious to readers: `null` means three.js will NOT apply fog
    // when rendering this scene. The sky is exempt from world fog by
    // construction.
    this.skyScene.fog = null;
    this.skyCamera = new THREE.PerspectiveCamera(
      60,        // fov - re-synced from main camera each tick
      1,         // aspect - re-synced from main camera each tick
      SKY_CAMERA_NEAR,
      SKY_CAMERA_FAR
    );
    this.skyCamera.name = "sky_camera";

    // === Sky cell (camera-anchored Group) =============================
    //
    // The cell is the anchor for all sky-internal geometry. Per tick
    // we copy the main camera's position into `skyCell.position` — the
    // cell follows the player. Rotation stays at `x = -π/2` (mirroring
    // `worldRoot`'s AC-Z-up → three-Y-up correction) so AC-coord
    // vertex data lands the right way up; the cell is NOT yawed with
    // the camera, which means celestial bodies stay compass-locked
    // (sun's compass bearing doesn't change as the player turns).
    this.skyCell = new THREE.Group();
    this.skyCell.name = "sky_cell";
    this.skyCell.rotation.x = -Math.PI / 2;
    this.skyScene.add(this.skyCell);

    // === Gradient sky dome ============================================
    //
    // BackSide so we render the inside of the sphere (we're inside
    // looking out). 32×16 segments is enough to keep the gradient
    // smooth without spending vertex bandwidth on something the
    // fragment shader does anyway.
    const domeGeom = new THREE.SphereGeometry(domeRadius, 32, 16);
    // Phase 7.7 invariant: every BufferGeometry must have a non-zero
    // boundingSphere so three.js's frustum culling can decide whether
    // to draw it. Three's primitive constructors don't pre-compute
    // boundingSphere by default (verified in r184); call it explicitly.
    domeGeom.computeBoundingSphere();
    // Default fallback colors before Sky-C populates the sink.
    // 0x9CB3D9 is `SkyLightingController`'s `DEFAULT_FOG_COLOR_ARGB`
    // RGB triple — keeps the dome from going black on the first
    // frame before the lighting tick lands.
    const horizonColor = new THREE.Color(0x9c / 255, 0xb3 / 255, 0xd9 / 255);
    // Zenith fallback — a slightly darker / cooler tone derived from
    // the same fallback ambient (`DEFAULT_AMB_COLOR_ARGB = 0xFF808080`,
    // mid gray). Pre-Sky-C, the dome reads as a soft blue-gray
    // gradient rather than a flat colour.
    const zenithColor = new THREE.Color(0x60 / 255, 0x70 / 255, 0x80 / 255);
    this._horizonColor = horizonColor;
    this._zenithColor = zenithColor;
    const domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizonColor: { value: horizonColor.clone() },
        uZenithColor: { value: zenithColor.clone() },
      },
      vertexShader: DOME_VERTEX_GLSL,
      fragmentShader: DOME_FRAGMENT_GLSL,
      glslVersion: THREE.GLSL3,
      // Inside of sphere — render back faces.
      side: THREE.BackSide,
      // Sky-I-C (2026-05-11): `depthTest=true + depthWrite=true`.
      // The original Sky-D used `depthTest=false + depthWrite=false`,
      // but with Sky-I-B's separate skyScene render some drivers
      // (chromium/swiftshader, observed 2026-05-11) discard upper-
      // hemisphere fragments on a back-side sphere when depthTest is
      // off — empirically only the lower hemisphere rendered.
      //
      // Celestials at vertex distance ~2700 (sun) are CLOSER to camera
      // than the dome's farthest point would be at radius 1000 in
      // post-projection terms, BUT the dome is "in front" because
      // the sphere CAMERA-RELATIVE depth is the radius to surface
      // crossings (all 1000). Celestials at 2700 in their bake-local
      // vertex coords end up at scattered depths because the bake
      // sits inside the rotator inside the skyCell — when the camera
      // is at skyCell origin, celestial vertices project to depths
      // that depend on their AABB layout. Empirically the celestials
      // render in front of the dome with `depthWrite=true` on both
      // — likely because three.js's renderOrder=-1 on the dome pushes
      // it BEHIND the celestials' renderOrder=0 in the sort, and the
      // depthWrite from dome is overwritten by celestials' subsequent
      // (renderOrder=0, default-depthWrite=true via MaterialCache)
      // depth writes. Verified working at skyic47672 capture.
      depthWrite: true,
      depthTest: true,
      fog: false, // exempt from fog (and skyScene.fog is null anyway)
    });
    domeMat.name = "sky-dome-gradient";
    this.dome = new THREE.Mesh(domeGeom, domeMat);
    this.dome.name = "sky_dome";
    this.dome.renderOrder = -1;
    this.dome.userData = { sky_dome: true };
    // The dome lives in skyCell — but since skyCell carries the
    // `-π/2` rotation around X (matching worldRoot's AC-Z-up
    // correction), the dome rotates with it. That's fine — the dome
    // is rotationally symmetric. Setting `frustumCulled = false`
    // because the dome is always the surrounding ball — the frustum
    // check after the cell anchor moves is sometimes wrong with
    // floating origin.
    this.dome.frustumCulled = false;
    this.skyCell.add(this.dome);

    // === Celestial body bookkeeping ===================================
    //
    // Each entry is a per-object rotator Group; each rotator's child
    // is the actual SkyObject mesh (with identity transform — native
    // vertex coords). Per tick, the rotator's `.rotation.z` is set
    // from `lerp(beginAngleDeg, endAngleDeg, currentProgress) * π/180`.
    //
    // The `_lastActiveIdPerObjectIndex` Map tracks which gfx_obj_id was
    // active for each SkyObject index across consecutive ticks, so
    // Sky-G's SkyObjectReplace mesh-swap can hide the previously-
    // active mesh when the swap fires.
    this.skyObjectMeshes = new Map();

    // If skyAssets are already populated, build celestial bodies now.
    // Otherwise wait for `populateCelestialBodies` to be called.
    if (skyAssets instanceof Map && skyAssets.size > 0 && materialCache) {
      this.populateCelestialBodies(skyAssets, materialCache);
    }

    // Track tick state for capture-script introspection.
    this._tickCount = 0;
    this._indoorTickCount = 0;
    this._noStateTickCount = 0;
    this._lastSkyObjectCount = 0;
    this._lastIsIndoor = false;
    // Workstream Sky-G: per-SkyObject-index → last-active gfx_obj_id.
    this._lastActiveIdPerObjectIndex = new Map();
    this._meshSwapCount = 0;
    // Workstream Sky-I-A: `?skydebug=1` URL flag.
    this._skyDebug = false;
    try {
      if (typeof window !== "undefined" && window.location?.search) {
        const params = new URLSearchParams(window.location.search);
        this._skyDebug = params.get("skydebug") === "1";
      }
    } catch (_) { /* no-window in worker context */ }
    if (this._skyDebug && typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(
        "[sky-i-a] ?skydebug=1 — installing per-tick state dump on " +
        "window.__skyDebugLastDump"
      );
      window.__skyDebugLastDump = null;
    }
  }

  /**
   * Lazy-populate celestial bodies from `skyAssets`. Called either at
   * construction (if assets are already resolved) or later (when
   * Sky-E completes). Idempotent: a second call with the same assets
   * is a no-op; with a different skyAssets, replaces the existing
   * meshes.
   *
   * **Sky-I-B**: each SkyObject bake is wrapped in a per-object
   * **rotator Group** (child of `skyCell`) so the per-tick rotation
   * can be applied at the Group level WITHOUT touching the mesh's
   * own transform (which stays identity — native vertex coords).
   *
   * **Sky-I-B**: `0x02xxxxxx` SetupModel proxies are SKIPPED. In
   * retail Dereth's Sunny DayGroup the only `0x02xxxxxx` is
   * `0x02000714` — a 6.5cm physics-script anchor for the moon's
   * particle emitter, not a visible celestial. See Sky-I-A probe
   * memo for the AABB measurement (sub-centimeter dimensions).
   */
  populateCelestialBodies(skyAssets, materialCache) {
    if (!(skyAssets instanceof Map) || skyAssets.size === 0) {
      return 0;
    }
    if (!materialCache) {
      // eslint-disable-next-line no-console
      console.warn("[sky-d] populateCelestialBodies: materialCache missing");
      return 0;
    }

    // Sky-J P5: stash materialCache for the per-tick chain walker
    // (`_attachParticleChainFromState`). Without this, the lazy
    // ParticleManager instantiation would have to re-discover the
    // material cache through other paths.
    this._materialCache = materialCache;

    // Sky-J P5: lazily instantiate ParticleManager once we have both
    // a materialCache AND wasmExports. Without wasmExports the chain
    // walker can't fetch PhysicsScripts / ParticleEmitters, so the
    // manager has nothing to drive — skip construction entirely. Test
    // fixtures that don't pass wasmExports get the pre-P5 behavior
    // (0x02 SetupModels silently skipped) for free.
    if (
      !this.particleManager &&
      this.wasmExports &&
      typeof this.wasmExports.fetchPhysicsScript === "function" &&
      typeof this.wasmExports.fetchParticleEmitter === "function" &&
      typeof this.wasmExports.fetchBuildingPlacement === "function"
    ) {
      this.particleManager = new ParticleManager({
        scene: this.skyCell,
        geometryFactory: async (hwGfxObjId) => {
          if (!this.wasmExports || typeof this.wasmExports.fetchBuildingPlacement !== "function") {
            // eslint-disable-next-line no-console
            console.warn("[sky-d/p5] geometryFactory: fetchBuildingPlacement missing");
            return null;
          }
          let bundle;
          try {
            bundle = await this.wasmExports.fetchBuildingPlacement(hwGfxObjId);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `[sky-d/p5] fetchBuildingPlacement(0x${hwGfxObjId.toString(16)}) failed:`,
              e
            );
            return null;
          }
          const partCount = bundle.partCount | 0;
          if (partCount === 0) {
            if (typeof bundle.free === "function") bundle.free();
            return null;
          }
          const meshes = bundle.takePartMeshes();
          if (typeof bundle.free === "function") bundle.free();
          // Particle billboards are typically single-part single-group
          // GfxObjs (e.g. 0x01001A62 is 1 part / 1 poly / 4 verts). Pick
          // the first part's first group geometry. (If a particle ever
          // references a multi-surface mesh, P5 punts — we'll see in
          // logs.)
          const firstMesh = meshes[0];
          if (!firstMesh || !Array.isArray(firstMesh.groups) || firstMesh.groups.length === 0) {
            return null;
          }
          return firstMesh.groups[0].geometry || null;
        },
        materialFactory: async (hwGfxObjId) => {
          // Re-walk the GfxObj's surfaces to discover the surface DID.
          // The bake is cached by wasmExports.fetchBuildingPlacement on
          // the resource side, so calling it twice is cheap.
          if (!this.wasmExports || typeof this.wasmExports.fetchBuildingPlacement !== "function") {
            return null;
          }
          let bundle;
          try {
            bundle = await this.wasmExports.fetchBuildingPlacement(hwGfxObjId);
          } catch (_) {
            return null;
          }
          const partCount = bundle.partCount | 0;
          if (partCount === 0) {
            if (typeof bundle.free === "function") bundle.free();
            return null;
          }
          const meshes = bundle.takePartMeshes();
          if (typeof bundle.free === "function") bundle.free();
          const surfaceDid = meshes[0]?.groups?.[0]?.surfaceDid;
          if (!surfaceDid) return null;
          // MaterialCache.get() may need to preload; the cache's
          // preload-on-resolveSkyAssets path covers the moon's surface
          // 0x08000040 already (it's referenced by GfxObj 0x01001A62
          // which is reachable via the PhysicsScript chain).
          try {
            return materialCache.get(surfaceDid);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `[sky-d/p5] materialCache.get(0x${surfaceDid.toString(16)}) failed:`,
              e
            );
            return null;
          }
        },
      });
    }

    // Tear down any existing rotators (idempotent re-bake path).
    for (const rotator of this.skyObjectMeshes.values()) {
      this.skyCell.remove(rotator);
    }
    this.skyObjectMeshes.clear();

    let added = 0;
    let skippedSetupModel = 0;
    for (const [skyObjectId, bake] of skyAssets) {
      if (!bake || !Array.isArray(bake.parts) || bake.parts.length === 0) {
        continue;
      }
      // Sky-J P5 (2026-05-12): 0x02xxxxxx SetupModels are physics-
      // script anchors (sub-cm meshes). The "visible" content is the
      // particles their PhysicsScript spawns via CreateParticleHook.
      // Defer the chain walk to `tick()` — the per-SkyObject state
      // (with `pesObjectId`) isn't available here; we just skip the
      // rotator-Group creation since these anchor meshes aren't drawn
      // directly.
      if ((skyObjectId >>> 24) === 0x02) {
        skippedSetupModel += 1;
        continue;
      }
      let bakeGroup;
      try {
        bakeGroup = buildSkyObjectGroup(bake, materialCache);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sky-d] buildSkyObjectGroup failed for 0x${skyObjectId.toString(16)}:`,
          e
        );
        continue;
      }
      // Sky-I-B: wrap the bake in a per-object rotator Group. The
      // rotator is the child of `skyCell` (so it inherits the cell's
      // camera-anchored position + AC-Z-up rotation); the bake (with
      // native AC vertex coords) is the child of the rotator. The
      // per-tick `rotator.rotation.z = headingDeg * π/180` swings the
      // bake around AC's Z axis (the world's up axis) — exactly the
      // east-to-west arc retail behaviour wants.
      const rotator = new THREE.Group();
      rotator.name = `sky_object_${skyObjectId.toString(16).padStart(8, "0")}`;
      // Tag so capture scripts walking skyScene.children (or the
      // descendants of skyCell) can identify per-object groups. The
      // rotator IS the addressable handle for the SkyObject — the
      // wrapped bake's children are private rendering detail.
      rotator.userData = {
        sky_object_id: skyObjectId,
        sky_object_rotator: true,
      };
      // Each surface mesh inside the bake has its material baked from
      // `MaterialCache`. Patch each material in-place for sky-specific
      // rendering policy:
      //   - depthWrite=false: never occlude foreground content.
      //   - fog=false: skyScene.fog is null anyway, but be explicit.
      // The shared MaterialCache mutation is safe because sky-specific
      // surface DIDs aren't used by buildings/EnvCells per Sky-E's
      // diagnostic.
      bakeGroup.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.depthWrite = false;
          child.material.fog = false;
        }
      });
      // Sky-G: every mesh starts hidden — the tick() pass un-hides
      // whichever is the active one for each SkyObject's window.
      bakeGroup.visible = false;
      // Bake's own transform stays identity — native AC vertex coords.
      bakeGroup.position.set(0, 0, 0);
      bakeGroup.scale.set(1, 1, 1);
      bakeGroup.rotation.set(0, 0, 0);
      rotator.add(bakeGroup);
      // Add rotator to the skyCell.
      this.skyCell.add(rotator);
      // Track the rotator (NOT the bake) — the per-tick visibility
      // flag goes on the bake, but the rotation goes on the rotator.
      // Stash both on the rotator's userData so the tick can find the
      // bake without traversing.
      rotator.userData.bake = bakeGroup;
      this.skyObjectMeshes.set(skyObjectId, rotator);
      added += 1;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[sky-d] populated ${added}/${skyAssets.size} celestial bodies in ` +
      `skyCell (skipped ${skippedSetupModel} SetupModel proxies)`
    );
    return added;
  }

  /**
   * Per-rAF tick. Order in `loop.js::tickPerFrame`:
   *   1. cells.js::tickCellVisibility3D
   *   2. lighting.js::tickLightingForCellState
   *   3. sky_lighting.js::SkyLightingController.tick(dt)
   *   4. <THIS>::SkyDome.tick(dt, camera)
   *
   * After all tick functions complete, `init3D`'s render loop:
   *   a. `renderer.render(scene, activeCam)` — main world pass.
   *   b. `skyDome.renderSkyPass(renderer, activeCam)` — sky pass.
   *
   * This method handles per-frame updates (skyCell anchoring, per-
   * object rotation, material updates); `renderSkyPass` handles the
   * actual draw call.
   */
  tick(_dt, camera) {
    this._tickCount += 1;

    // === A. Anchor skyCell at camera =================================
    //
    // Cell follows player position but NOT player rotation. The
    // skyCamera will copy the main camera's quaternion in
    // renderSkyPass — that's where the "render from the player's
    // POV" effect comes from. By only copying translation here, the
    // cell's contents stay compass-locked (sun's compass bearing is
    // independent of where the player faces).
    if (camera && camera.position) {
      this.skyCell.position.copy(camera.position);
    }

    // === B. Indoor flip ==============================================
    //
    // Read indoor flag once per tick. `renderSkyPass` checks
    // `_lastIsIndoor` to decide whether to issue the second render
    // call — when indoor we skip the sky pass entirely (saves
    // clearDepth + render).
    const session = this.sessionHandleAccessor();
    let isIndoor = false;
    if (session && typeof session.isCurrentCellIndoor === "function") {
      try {
        isIndoor = !!session.isCurrentCellIndoor();
      } catch (_) {
        isIndoor = this._lastIsIndoor;
      }
    }
    this._lastIsIndoor = isIndoor;
    if (isIndoor) {
      this._indoorTickCount += 1;
      // Even when we'll skip rendering, walking the rotators is cheap
      // and lets the next outdoor frame see fresh visibility. Most of
      // the work below is wasted in that case; we short-circuit
      // anyway because the wasm round-trip is the expensive part.
      return;
    }

    // === C. Update dome gradient uniforms from Sky-C's sink ==========
    //
    // `skyBackgroundColor` is the ARGB u32 Sky-C writes per tick. The
    // zenith comes from `skyLightingController._lastState.ambColorArgb`
    // — the ambient light tint, which Sky-B lerps from Dereth's per-
    // keyframe `amb_color`. When Sky-C hasn't ticked yet (pre-spawn),
    // both fall back to construction-time defaults.
    if (this.liveScene3dRef && this.dome.material?.uniforms) {
      const horizonArgb =
        this.liveScene3dRef.skyBackgroundColor >>> 0 || 0xff9cb3d9;
      argbToColor(horizonArgb, this.dome.material.uniforms.uHorizonColor.value);

      const lastState = this.liveScene3dRef.skyLightingController?._lastState;
      if (lastState && typeof lastState.ambColorArgb === "number") {
        argbToColor(
          lastState.ambColorArgb >>> 0,
          this.dome.material.uniforms.uZenithColor.value
        );
      }
    }

    // === D. Per-SkyObject pose + visibility + material updates =======
    //
    // Skip if we have no meshes yet (Sky-E hasn't completed).
    if (this.skyObjectMeshes.size === 0) {
      return;
    }
    if (!session || typeof session.getSkyObjectStates !== "function") {
      this._noStateTickCount += 1;
      return;
    }
    let states;
    try {
      states = session.getSkyObjectStates();
    } catch (_) {
      this._noStateTickCount += 1;
      return;
    }
    if (!states || states.length === 0) {
      this._noStateTickCount += 1;
      return;
    }
    this._lastSkyObjectCount = states.length;
    for (let i = 0; i < states.length; i += 1) {
      const s = states[i];
      const skyObjectId = (s.gfxObjectId >>> 0);

      // Sky-J P5 (2026-05-12): 0x02xxxxxx SetupModels have no rotator
      // (they're sub-cm physics-script anchors, not visible meshes).
      // Instead, walk their PhysicsScript chain via `pesObjectId` to
      // attach a particle emitter the first time we see this object,
      // then keep its visibility in sync with the state. The
      // particleManager.tick() call at the end of the D loop advances
      // every active particle each frame.
      if ((skyObjectId >>> 24) === 0x02) {
        const pesId = (s.pesObjectId >>> 0);
        if (
          pesId !== 0 &&
          this.particleManager &&
          this.wasmExports &&
          typeof this.wasmExports.fetchPhysicsScript === "function" &&
          !this._particleChainsAttached.has(skyObjectId) &&
          !this._particleChainsPending.has(skyObjectId)
        ) {
          this._particleChainsPending.add(skyObjectId);
          // Fire-and-forget the async chain walk. The first frame after
          // it lands, the emitter is in `this.particleManager` and its
          // visibility follows the `s.visible` flag we update below.
          this._attachParticleChainFromState(skyObjectId, s).catch((e) => {
            this._particleChainsPending.delete(skyObjectId);
            // eslint-disable-next-line no-console
            console.warn(
              `[sky-d/p5] particle chain walk for 0x${skyObjectId.toString(16)} (pes=0x${pesId.toString(16)}) threw:`,
              e
            );
          });
        }
        // Visibility forwarding deferred: retail moon emitters have
        // 900s+ lifespan + always-visible spawn windows (since the
        // SetupModel anchor's begin==end==0 = always-visible sentinel).
        // If a future region uses arc-bounded weather emitters,
        // ParticleEmitter would need a `setVisible(bool)` API that
        // gates spawning + drawing per slot.
        continue;
      }

      const rotator = this.skyObjectMeshes.get(skyObjectId);
      if (!rotator) continue;
      const bake = rotator.userData?.bake;
      if (!bake) continue;

      // Workstream Sky-G: SkyObjectReplace mesh-swap handling. If the
      // SkyObject at index `i` was previously rendering with a
      // different gfx_obj_id, we need to hide the previously-active
      // bake + increment the mesh-swap counter (bullet 18).
      const lastActive = this._lastActiveIdPerObjectIndex.get(i);
      if (lastActive !== undefined && lastActive !== skyObjectId) {
        const lastRotator = this.skyObjectMeshes.get(lastActive);
        const lastBake = lastRotator?.userData?.bake;
        if (lastBake && lastBake.visible) {
          lastBake.visible = false;
        }
        this._meshSwapCount += 1;
      }
      this._lastActiveIdPerObjectIndex.set(i, skyObjectId);

      // Per-state visibility. Toggle the BAKE's visible (not the
      // rotator's) so capture scripts that walk for rotators still
      // see all of them even when only some are visible.
      if (bake.visible !== s.visible) {
        bake.visible = !!s.visible;
      }
      if (!s.visible) continue;

      // === Sky-I-B: per-object rotation =============================
      //
      // The DAT ships `begin_angle` / `end_angle` in degrees (raw f32,
      // no conversion in the parser). The wasm-side `SkyObjectState`
      // surfaces them verbatim as `beginAngleDeg` / `endAngleDeg`.
      // `currentProgress` is the lerp parameter `[0, 1]` across the
      // visible window. We compute:
      //
      //     headingDeg = lerp(beginAngleDeg, endAngleDeg, progress);
      //     headingRad = headingDeg * (π / 180);
      //     rotator.rotation.z = headingRad;
      //
      // The rotator sits inside `skyCell` which has `rotation.x =
      // -π/2`, so rotating the rotator around its three-Z axis is
      // equivalent to rotating around AC's Y axis (since the cell's
      // rotation maps AC-Z→three-Y and AC-Y→three-Z; AC-X stays
      // three-X). Wait — let me re-derive: the cell rotates AC-coord
      // children by -π/2 around three-X, which maps AC-vec
      // (ax,ay,az) → three-vec (ax,az,-ay). The rotator's own local
      // rotation is applied in its parent's local frame. The parent is
      // skyCell. skyCell's local frame is post-rotation; so a rotation
      // around the rotator's three-Z axis is around the (0,0,1)
      // direction in skyCell's pre-rotation frame, which maps to
      // (0,-1,0) in three-space — i.e. around the -three-Y axis after
      // skyCell's rotation. That's "around world-down" — which IS
      // "around world-up but reversed sign." So a positive
      // rotation.z spins the bake clockwise (looking down from
      // world-up = +three-Y after skyCell rotation). Retail AC: sun
      // sweeps east→south→west, i.e. CCW when viewed from world-up;
      // so we negate the rotation. Actually — wait. Let me re-examine:
      // AC convention is "heading measured from +Y north, clockwise"
      // (per scene3d/sky_lighting.js:31 + GameSky.cpp). heading=0 → +Y
      // north; heading=90° → +X east; heading=180° → -Y south. That's
      // CW when looking DOWN from +Z. After the world-axis remap
      // (AC→three via `acToThree = (ax,az,-ay)`), the +Z up becomes
      // +three-Y up. CW-from-above (AC) is CCW-from-above (three,
      // since +Y is the same direction). So the heading angle is
      // simply applied AS-IS: rotate around the rotator's local Z by
      // headingRad. Wait — the rotator is INSIDE skyCell whose
      // rotation.x = -π/2 was already applied. The rotator's local Z
      // axis (pre-skyCell-rotation) IS AC's Z, which is what we want
      // to rotate around. The rotator's local Z (in its own
      // pre-skyCell frame) is the AC Z axis. So set rotation.z =
      // headingRad and we're done. The angle sign convention (CW from
      // +Y north) — applying rotation.z = +heading rotates the bake's
      // local X axis FROM toward whichever direction three.js's
      // right-hand rule says. With AC convention being "rotate from +Y
      // toward +X going CW" = three.js's negative-Z direction (after
      // mapping), but we're rotating in the LOCAL pre-mapped frame so
      // CW from +Y is the +X direction. three.js rotation.z is CCW
      // from +X around +Z. Hmm — this could go either way; the
      // eye-test will tell. If the sun moves backward (W→E instead of
      // E→W), flip the sign. For now: apply heading directly.
      const headingDeg = lerpDeg(
        s.beginAngleDeg,
        s.endAngleDeg,
        s.currentProgress
      );
      const headingRad = headingDeg * (Math.PI / 180.0);
      rotator.rotation.set(0, 0, headingRad);

      // Per-material overrides: transparent / luminosity / max_bright.
      //
      // `transparent` semantics (from `crates/holtburger-world/src/sky.rs`
      // SkyObjectSnapshot doc): a value of `-1.0` means "no override,
      // use material default". A value in `[0, 1]` is the AC
      // transparency level — but AC's convention is 0=opaque, 1=fully-
      // transparent, INVERTED from three.js's `material.opacity`
      // (0=transparent, 1=opaque). We invert here: opacity = 1 - t.
      //
      // `luminosity` * `max_bright` drives an emissive boost so the
      // sun + moon "glow" rather than just sitting flat against the
      // dome.
      const t = s.transparent;
      const lum = s.luminosity;
      const mb = s.maxBright;
      const tx = s.texOffsetX;
      const ty = s.texOffsetY;
      bake.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        if (t >= 0.0 && t <= 1.0) {
          const opacity = 1.0 - t;
          if (mat.transparent !== true) mat.transparent = true;
          if (Math.abs(mat.opacity - opacity) > 1e-3) {
            mat.opacity = opacity;
          }
        }
        if (lum >= 0.0 && mb >= 0.0 && mat.emissive) {
          const intensity = lum * mb;
          if (Math.abs((mat.emissiveIntensity ?? 0) - intensity) > 1e-3) {
            mat.emissiveIntensity = intensity;
          }
        }
        // Sky-G UV scroll. Applied to material.map.offset; texture's
        // wrapS/wrapT are RepeatWrapping via `surfacePixelsToTexture`.
        if (mat.map) {
          mat.map.offset.set(tx, ty);
        }
      });
    }

    // === E. Sky-I-A debug dump =======================================
    if (this._skyDebug && typeof window !== "undefined" && camera) {
      try {
        window.__skyDebugLastDump = this._buildSkyDebugDump(states, camera);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[sky-i-a] debug-dump build failed:", e?.message);
      }
    }

    // === F. Sky-J P5 — particle runtime tick =========================
    //
    // After per-SkyObject pose updates have moved any parent anchors
    // (none for sky-cell-anchored emitters, but we run this AFTER D
    // anyway so future changes to the order don't desync). Advances
    // every active particle by one frame: spawn-rate gating, A/B/C
    // velocity composition, scale/trans lerp, kill expired.
    if (this.particleManager) {
      this.particleManager.tick();
    }
  }

  /**
   * Sky-J P5: walk the PhysicsScript chain for a 0x02 SetupModel
   * SkyObject and attach a ParticleEmitter for each CreateParticleHook
   * (hookType 13 or 26). Fire-and-forget — `tick()` invokes this once
   * per skyObjectId, dedup'd by `_particleChainsAttached`.
   *
   * Chain: SkyObject (0x02..) -> default_pes_object_id (0x33..)
   *        -> CreateParticleHook[].EmitterInfoId (0x32..)
   *        -> ParticleEmitterInfo.HwGfxObjId (0x01..)
   *
   * Retail Dereth example (moon, verified 2026-05-12):
   *   skyObjectId = 0x02000714
   *   pesId       = 0x330007DB (3 entries)
   *     [0] -> emitter 0x32000455 -> hwGfx 0x01001A61 (crimson star A)
   *     [1] -> emitter 0x32000456 -> hwGfx 0x01001A62 (crimson star B, world-space)
   *     [2] -> emitter 0x32000457 -> hwGfx 0x01001A63 (crimson star C)
   *
   * `parent` for the emitter is the sky-cell origin (the SetupModel
   * proxy mesh is sub-cm and sits at origin in cell-local space per
   * Sky-I-A probe). `parentOffset` is the per-hook Offset Frame.
   *
   * @param {number} skyObjectId  - The SetupModel DID (0x02xxxxxx).
   * @param {object} state        - The current SkyObjectState from
   *                                 getSkyObjectStates(). Must carry
   *                                 `pesObjectId` (added Sky-J P5a).
   */
  async _attachParticleChainFromState(skyObjectId, state) {
    const pesId = (state.pesObjectId >>> 0);
    if (pesId === 0) {
      this._particleChainsPending.delete(skyObjectId);
      return;
    }
    if (
      !this.wasmExports ||
      typeof this.wasmExports.fetchPhysicsScript !== "function" ||
      typeof this.wasmExports.fetchParticleEmitter !== "function"
    ) {
      this._particleChainsPending.delete(skyObjectId);
      return;
    }
    if (!this.particleManager) {
      this._particleChainsPending.delete(skyObjectId);
      return;
    }
    let ps;
    try {
      ps = await this.wasmExports.fetchPhysicsScript(pesId);
    } catch (e) {
      this._particleChainsPending.delete(skyObjectId);
      // eslint-disable-next-line no-console
      console.warn(
        `[sky-d/p5] fetchPhysicsScript(0x${pesId.toString(16)}) failed:`,
        e
      );
      return;
    }
    const entries = ps.takeEntries();
    const emitterIds = [];
    // The emitter "parent" is the sky-cell origin (Vector3 zero +
    // identity quaternion). All offsets land within sky-cell-local
    // space, which the camera-anchored skyCell rotates/translates as
    // a single Group per tick.
    const parent = {
      position: new THREE.Vector3(0, 0, 0),
      quaternion: new THREE.Quaternion(),
    };
    for (const e of entries) {
      // Only CreateParticle (13) + CreateBlockingParticle (26) hooks
      // spawn emitters. Other hook types (SoundTweaked, CallPES,
      // SetOmega, etc.) are not handled in P5 — defer to P6 if needed.
      if (e.hookType !== 13 && e.hookType !== 26) continue;
      const emitterId = (e.createParticleEmitterId >>> 0);
      if (emitterId === 0) continue;

      let emitterInfo;
      try {
        emitterInfo = await this.wasmExports.fetchParticleEmitter(emitterId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sky-d/p5] fetchParticleEmitter(0x${emitterId.toString(16)}) failed:`,
          err
        );
        continue;
      }

      const offset = {
        position: new THREE.Vector3(
          e.createParticleOffsetX,
          e.createParticleOffsetY,
          e.createParticleOffsetZ
        ),
        quaternion: new THREE.Quaternion(
          e.createParticleOffsetQX,
          e.createParticleOffsetQY,
          e.createParticleOffsetQZ,
          e.createParticleOffsetQW
        ),
      };

      // PartIndex 0xFFFFFFFF means "whole object" — ACE uses -1 for
      // this in the JS-side ParticleManager API.
      const partIndex = (e.createParticlePartIndex === 0xffffffff)
        ? -1
        : (e.createParticlePartIndex | 0);

      try {
        const id = await this.particleManager.addEmitter({
          emitterInfo,
          parent,
          partIndex,
          parentOffset: offset,
        });
        if (id !== 0) emitterIds.push(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sky-d/p5] addEmitter(0x${emitterId.toString(16)}) failed:`,
          err
        );
      }
    }
    this._particleEmittersForSkyObject.set(skyObjectId, emitterIds);
    this._particleChainsAttached.add(skyObjectId);
    this._particleChainsPending.delete(skyObjectId);
    // eslint-disable-next-line no-console
    console.log(
      `[sky-d/p5] attached ${emitterIds.length} particle emitters for ` +
        `SkyObject 0x${skyObjectId.toString(16)} (PES 0x${pesId.toString(16)})`
    );
  }

  /**
   * Sky-I-B + Sky-I-C: render the sky pass.
   *
   * **Sky-I-C call-order fix (2026-05-11).** Originally Sky-I-B
   * called this AFTER the main world render with `clearDepth()`
   * preceding it. That had a load-bearing bug: the dome's
   * `depthTest=false + depthWrite=false` material paints every
   * fragment in the framebuffer, and with depth cleared the dome
   * happily overpainted every world pixel — empty (dark fog-colored)
   * frames with only HTML-overlay nameplates visible. The probe in
   * `/tmp/skyic-logs/probe2.json` showed the celestials at correct
   * world coords (sun at distance 2676 from camera, well inside
   * skyCamera.far=50000) and the dome rendering, but the world
   * geometry was being overdrawn frame after frame.
   *
   * Fix: render sky FIRST (in `init3D`'s tick), then the world
   * scene SECOND. The world render is `renderer.render(scene,
   * activeCam)` with `renderer.autoClear = true` (the default),
   * which resets the depth buffer cleanly, so the world paints with
   * fresh depth. World geometry naturally overpaints the sky pixels
   * wherever it draws. Where the world doesn't paint (sky pixels
   * remain visible in the color buffer), the sky stays visible from
   * THIS pass. The sky camera mirrors the main camera each tick so
   * the projection aligns.
   *
   * Pipeline:
   *   - Skip entirely when indoor (saves one render call).
   *   - Otherwise: sync skyCamera with mainCamera (position +
   *     quaternion + fov + aspect) → render skyScene with autoClear
   *     so the framebuffer starts cleared each frame.
   *
   * The main render (downstream of this call) then disables
   * autoClear-color (preserves sky paint) but does its own depth
   * clear via `renderer.autoClear = true` for the actual call.
   * Actually — three.js's default render with `autoClear = true`
   * clears BOTH color AND depth. To preserve the sky color paint
   * across the boundary we set `autoClear = false` on the main
   * render and manually clear depth between the two passes.
   *
   * Concretely:
   *   1. This method does `renderer.clear()` (color+depth) then
   *      `renderer.autoClear = false` + `renderer.render(skyScene,
   *      skyCamera)`. After this the color buffer has the sky and
   *      the depth buffer has the dome/celestial depth values.
   *   2. The caller in `index.js` then calls `renderer.clearDepth()`
   *      to reset depth (sky paint preserved in color buffer; depth
   *      reset to far) before `renderer.render(scene, mainCamera)`.
   *      That render does NOT clear color (autoClear stays false)
   *      but writes new depth values for world geometry. World
   *      paints over sky.
   *
   * Indoor flip: when `_lastIsIndoor === true`, we skip this entirely
   * AND the caller must use the normal `renderer.render` with
   * `autoClear = true` so the framebuffer gets cleared cleanly (the
   * EnvCell renders its own walls; no sky needed). We expose
   * `wasSkyRenderedLastFrame()` so the caller can decide.
   */
  renderSkyPass(renderer, mainCamera) {
    if (!renderer || !mainCamera) {
      this._lastSkyRendered = false;
      return;
    }
    if (this._lastIsIndoor) {
      this._lastSkyRendered = false;
      return;
    }

    // Sync the sky camera with the main camera. Position is critical
    // for proper rendering of any sky-internal vertex data that's not
    // exactly at the cell origin (the celestials are at ~1900 units
    // from cell origin — but the skyCell ALSO sits at camera.position,
    // so the sky-camera-relative position of the sun is `~1900 +
    // (skyCell - skyCamera)` ≈ ~1900 since both are at the main
    // camera). Quaternion + fov + aspect mirror the main camera so
    // the projection matrices align.
    this.skyCamera.position.copy(mainCamera.position);
    this.skyCamera.quaternion.copy(mainCamera.quaternion);
    if (typeof mainCamera.fov === "number") {
      this.skyCamera.fov = mainCamera.fov;
    }
    if (typeof mainCamera.aspect === "number") {
      this.skyCamera.aspect = mainCamera.aspect;
    }
    this.skyCamera.updateProjectionMatrix();

    // Clear color + depth, then render the sky. After this call the
    // framebuffer has sky pixels and the depth buffer has sky depths.
    // The caller will then clear depth (preserving sky color paint)
    // and render the world OVER the sky — world depth-test naturally
    // beats sky depth at world pixels; sky stays visible elsewhere.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true; // clears color+depth at render start
    renderer.render(this.skyScene, this.skyCamera);
    renderer.autoClear = prevAutoClear;
    this._lastSkyRendered = true;
  }

  /**
   * Sky-I-C: did the most recent renderSkyPass actually issue a draw?
   * (false when indoor, true when outdoor). Used by the caller in
   * `index.js` to decide whether to preserve color via
   * `autoClear=false` on the subsequent world render (sky pass was
   * the framebuffer-clear) or use the normal `autoClear=true` flow
   * (no sky pass; world render does the buffer clear).
   */
  wasSkyRenderedLastFrame() {
    return !!this._lastSkyRendered;
  }

  /**
   * Sky-I-A: build a JSON-friendly debug dump describing each
   * SkyObject's geometry in world space + the camera + fog bounds.
   * Updated for Sky-I-B: now reads the rotator + bake hierarchy.
   * Pure read-only — no mutation of scene-graph state.
   */
  _buildSkyDebugDump(states, camera) {
    // World-matrix needs to reflect the position writes done in tick().
    for (const rotator of this.skyObjectMeshes.values()) {
      rotator.updateMatrixWorld(true);
    }

    const camPos = camera.position;
    const cameraInfo = {
      position: { x: camPos.x, y: camPos.y, z: camPos.z },
      fovDeg: typeof camera.fov === "number" ? camera.fov : null,
      near: typeof camera.near === "number" ? camera.near : null,
      far: typeof camera.far === "number" ? camera.far : null,
    };
    const skyCameraInfo = {
      position: { x: this.skyCamera.position.x, y: this.skyCamera.position.y, z: this.skyCamera.position.z },
      fovDeg: this.skyCamera.fov,
      near: this.skyCamera.near,
      far: this.skyCamera.far,
    };
    const fogInfo = (() => {
      const f = this.scene?.fog;
      if (!f) return null;
      return {
        near: typeof f.near === "number" ? f.near : null,
        far: typeof f.far === "number" ? f.far : null,
        density: typeof f.density === "number" ? f.density : null,
        color: f.color ? `0x${f.color.getHex().toString(16).padStart(6, "0")}` : null,
      };
    })();

    const objects = [];
    const stateById = new Map();
    if (Array.isArray(states)) {
      for (const s of states) {
        stateById.set(s.gfxObjectId >>> 0, s);
      }
    }
    for (const [skyObjectId, rotator] of this.skyObjectMeshes.entries()) {
      const state = stateById.get(skyObjectId);
      const bake = rotator.userData?.bake;
      // Aggregate per-mesh boundingBox under the bake's LOCAL transform
      // (which is identity, so this is the native vertex AABB).
      let lmin = null;
      let lmax = null;
      let totalVerts = 0;
      if (bake) {
        bake.traverse((child) => {
          if (!child.isMesh || !child.geometry) return;
          if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
          const bb = child.geometry.boundingBox;
          if (!bb) return;
          totalVerts += (child.geometry.attributes?.position?.count || 0);
          if (lmin === null) {
            lmin = bb.min.clone();
            lmax = bb.max.clone();
          } else {
            lmin.min(bb.min);
            lmax.max(bb.max);
          }
        });
      }
      const nativeAabb = lmin && lmax ? {
        min: { x: lmin.x, y: lmin.y, z: lmin.z },
        max: { x: lmax.x, y: lmax.y, z: lmax.z },
        center: { x: (lmin.x + lmax.x) / 2, y: (lmin.y + lmax.y) / 2, z: (lmin.z + lmax.z) / 2 },
        verts: totalVerts,
      } : null;

      // World center: transform the local-aabb center by the rotator's
      // worldMatrix. Bake transform is identity, so rotator's matrix
      // IS the effective transform on the vertex AABB.
      let worldCenter = null;
      let distanceFromCamera = null;
      if (nativeAabb) {
        const v = new THREE.Vector3(
          nativeAabb.center.x,
          nativeAabb.center.y,
          nativeAabb.center.z
        );
        v.applyMatrix4(rotator.matrixWorld);
        worldCenter = { x: v.x, y: v.y, z: v.z };
        distanceFromCamera = v.distanceTo(camPos);
      }

      objects.push({
        id: `0x${skyObjectId.toString(16).padStart(8, "0").toUpperCase()}`,
        state: state ? {
          heading: state.heading,
          headingDeg: state.heading * (180 / Math.PI),
          pitch: state.pitch,
          pitchDeg: state.pitch * (180 / Math.PI),
          beginAngleDeg: state.beginAngleDeg,
          endAngleDeg: state.endAngleDeg,
          beginTime: state.beginTime,
          endTime: state.endTime,
          currentProgress: state.currentProgress,
          visible: !!state.visible,
          transparent: state.transparent,
          luminosity: state.luminosity,
          maxBright: state.maxBright,
          properties: state.properties >>> 0,
          texOffsetX: state.texOffsetX,
          texOffsetY: state.texOffsetY,
        } : null,
        mesh: {
          visible: bake?.visible ?? false,
          nativeAabb,
          rotationApplied: { x: rotator.rotation.x, y: rotator.rotation.y, z: rotator.rotation.z },
          rotatorWorldMatrix: Array.from(rotator.matrixWorld.elements),
          worldCenter,
          distanceFromCamera,
        },
      });
    }

    return {
      tickCount: this._tickCount,
      timeUnixMs: Date.now(),
      isIndoor: this._lastIsIndoor,
      domeRadius: this.domeRadius,
      skyCameraFar: SKY_CAMERA_FAR,
      objectCount: objects.length,
      camera: cameraInfo,
      skyCamera: skyCameraInfo,
      skyCellPosition: {
        x: this.skyCell.position.x,
        y: this.skyCell.position.y,
        z: this.skyCell.position.z,
      },
      fog: fogInfo,
      objects,
    };
  }

  /**
   * Dispose all GPU resources owned by the dome + celestial bodies.
   * The shared MaterialCache materials are NOT disposed here — they're
   * owned by the cache.
   */
  dispose() {
    if (this.dome) {
      this.dome.geometry?.dispose();
      this.dome.material?.dispose();
      this.skyCell.remove(this.dome);
    }
    for (const rotator of this.skyObjectMeshes.values()) {
      this.skyCell.remove(rotator);
    }
    this.skyObjectMeshes.clear();
    if (this.skyCell) {
      this.skyScene.remove(this.skyCell);
    }
  }
}

// Internal helpers re-exported for the Node ESM test (so the test can
// assert the geometry math directly without standing up a full
// SkyDome). NOT part of the public API.
export const __internals = Object.freeze({
  argbToColor,
  lerpDeg,
  DOME_RADIUS,
  SKY_CAMERA_FAR,
  SKY_CAMERA_NEAR,
});
