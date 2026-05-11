// Workstream Sky-D (2026-05-11) — sky-dome geometry + celestial body
// rendering.
//
// Two pieces:
//
//   1. **Gradient sky dome.** A camera-parented large sphere (radius
//      `DOME_RADIUS = 1000` world units, BackSide so we render the
//      inside-facing surface, depthWrite=false so it never occludes
//      world geometry). The fragment shader vertically lerps between
//      `uHorizonColor` (Sky-C's `liveScene3d.skyBackgroundColor`, an
//      ARGB u32 derived from `fog_color_argb`) and `uZenithColor`
//      (Sky-C's `_lastState.ambColorArgb`, the ambient light tint,
//      typically darker / cooler at the top of the dome). The
//      world-up direction `vWorldNormal.y` drives a `smoothstep(0, 0.5,
//      y)` blend so the gradient compresses into the lower half of the
//      sky (matching Dereth's atmospheric tint — most of the action
//      is in the bottom 30° of the dome; the upper 60° is dominated
//      by ambient sky color).
//
//   2. **Per-SkyObject celestial bodies.** For each SkyObject in
//      `getSkyObjectStates()`, instantiate its bake (from Sky-E's
//      `liveScene3d.skyAssets`) as a child of `celestialGroup` placed
//      on a virtual sky-sphere at radius `CELESTIAL_SPHERE_RADIUS = 900`
//      (inside the dome shell). Each body's mesh is positioned via
//      `(sin(h)*cos(p), sin(p), -cos(h)*cos(p))` after worldRoot
//      rotation — same formula `sunPositionFromHeadingPitch` in
//      `sky_lighting.js` uses for the directional-light position.
//
// **Coordinate system.** The dome + celestial bodies live as DIRECT
// children of `scene.children` (NOT under `worldRoot`). This is
// load-bearing because:
//   - The capture script's bullet 11 walks `scene.children` looking
//     for `name === "sky_dome"`.
//   - The capture script's bullet 12 walks `scene.children` looking
//     for `userData.sky_object_id !== undefined`.
//   - Avoiding `worldRoot.rotation.x = -π/2` lets us apply the
//     SkyObject heading/pitch math directly in three.js space without
//     a double-rotation that would tilt the dome onto its side.
//
// **Per-frame chain.** `loop.js::tickPerFrame` calls
// `skyLightingController.tick(dt)` FIRST (Sky-C writes
// `liveScene3d.skyBackgroundColor`), then `skyDome.tick(dt, camera)`
// reads the freshly-written sink. Order matters; reversing it would
// give the dome a stale fog color for one frame.
//
// **Indoor flip.** Phase 7.6's `tickLightingForCellState` flips
// `sun.visible = false` when `isCurrentCellIndoor()` returns true.
// We mirror that: when indoor, `skyDome.dome.visible = false` AND
// `skyDome.celestialGroup.visible = false`. The check is local to
// the tick (reads `sessionHandle.isCurrentCellIndoor()` directly) so
// we don't depend on a side-effect-ordering quirk with Phase 7.6.
//
// **RGB-as-ARGB note** (Sky-E's deferred Part 2): the cloud band
// (`0x01004C36`) is alpha-blended via its Translucent surface flag in
// `materials.js::_materialFromFlags`. The DataTexture upload in
// `surfacePixelsToTexture` flips `flipY = false` + uses RGBAFormat +
// `SRGBColorSpace` for albedo. We DON'T set `premultiplyAlpha = true`
// here — the wasm RGBA8 is straight alpha, not pre-multiplied. With
// `THREE.NormalBlending` (the default) the alpha math is correct.
// If the cloud band's edges show a black halo, that's the indicator
// the wasm pixels ARE pre-multiplied and we need to flip the flag.
// Eye-test result is documented in the commit body.

import * as THREE from "three";

import { buildSkyObjectGroup } from "./sky_assets.js";
import { acToThree } from "./adapter.js";

// ---- Constants -----------------------------------------------------
//
// `DOME_RADIUS` — large enough to feel "infinite" relative to the 9-LB
// Holtburg view (576 m square) but small enough that the depth buffer
// stays sensible (we draw the dome BEFORE world geometry with
// depthWrite=false, so the choice is largely cosmetic). 1000 m matches
// `sky_lighting.js::SUN_POSITION_DISTANCE`.
const DOME_RADIUS = 1000.0;
// `CELESTIAL_SPHERE_RADIUS` — celestial bodies sit inside the dome
// shell. 900 m gives ~100 m of headroom so the bodies never z-fight
// the dome surface. (z-fight wouldn't be visible anyway with the
// dome's depthTest=false, but a clean ordering helps eye-test
// debugging.)
const CELESTIAL_SPHERE_RADIUS = 900.0;
// Scale per celestial body. AC's meshes are authored in world-metres;
// at radius 900 m a typical 5-m moon mesh is ~0.3° of arc, too small.
// We scale UP so the sun + moon read as ~5° on the sky dome — about
// what AC's retail client showed (validated against PhatSDK
// `SkyDesc::display_radius`, retained here as a constant the eye-test
// tunes).
const CELESTIAL_BODY_SCALE = 30.0;

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
 * Project (heading, pitch) into three.js world-space at radius `r`.
 * Heading and pitch are in RADIANS (the wasm `SkyObjectState` getters
 * return radians per `crates/holtburger-world/src/sky.rs:117-121`).
 * AC convention: heading on the world XY plane measured from +Y north,
 * CW; pitch above horizon. After AC→three rotation:
 *
 *     x = r * cos(pitch) * sin(heading)        // east
 *     y = r * sin(pitch)                       // up
 *     z = -r * cos(pitch) * cos(heading)       // south (AC north → three -z)
 *
 * Returns `[x, y, z]`. Identical to `sun_lighting.js`'s
 * `sunPositionFromHeadingPitch` but takes radians directly (instead
 * of degrees) because the wasm side already pre-converts.
 */
function celestialPosition(headingRad, pitchRad, r) {
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const x = r * cp * Math.sin(headingRad);
  const y = r * sp;
  const z = -r * cp * Math.cos(headingRad);
  return [x, y, z];
}

/**
 * Build a sky dome — large back-side sphere with a vertical-gradient
 * ShaderMaterial — plus a celestial-body group seeded from Sky-E's
 * resolved `skyAssets`.
 *
 * Inputs:
 *   - `scene` — root THREE.Scene. The dome wrapper + each celestial
 *     body group are added as direct children of this scene (NOT
 *     under `worldRoot`). The capture script's bullet 11 + 12 walks
 *     scene.children, so the top-level placement is load-bearing.
 *   - `skyAssets` — `Map<sky_object_id, bake>` from
 *     `resolveSkyAssets`. May be null/empty at construction time;
 *     the celestial group is populated lazily by `populateCelestialBodies`
 *     once Sky-E completes.
 *   - `materialCache` — shared `MaterialCache` for surface textures.
 *   - `sessionHandleAccessor` — `() => SessionHandle | null`. Read on
 *     every `tick(dt, camera)` to fetch the latest
 *     `getSkyObjectStates()` + `isCurrentCellIndoor()`. Lazy-accessor
 *     style matches `SkyLightingController`.
 *   - `liveScene3dRef` — reference back to the `liveScene3d` object;
 *     the controller reads `skyBackgroundColor` (Sky-C's sink) +
 *     `skyLightingController._lastState.ambColorArgb` (Sky-C's zenith
 *     color source). Falls back to defaults when these aren't
 *     populated.
 *
 * Construction is synchronous — the dome mesh + uniforms come up
 * immediately. The celestial group starts empty if `skyAssets` is
 * null; call `controller.populateCelestialBodies(skyAssets,
 * materialCache)` once Sky-E completes (typically a few frames after
 * `populateSkyDescFromRegion` resolves).
 *
 * **Public state.**
 *   - `controller.dome` — `THREE.Mesh` for the gradient sphere.
 *   - `controller.celestialGroup` — `THREE.Group` parent for celestial
 *     bodies; ALSO each body is added DIRECTLY to scene.children with
 *     `userData.sky_object_id` set, so the capture script's bullet 12
 *     finds them at scene-root.
 *   - `controller.skyObjectMeshes` — Map<sky_object_id, THREE.Group>
 *     for the per-frame `setPositionAndPose` loop.
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
      celestialRadius = CELESTIAL_SPHERE_RADIUS,
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
    this.celestialRadius = celestialRadius;

    // === 1. Gradient sky dome ========================================
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
    // The dome is camera-parented (re-positioned every frame) so the
    // bounding sphere is in local space — three.js applies the dome's
    // world matrix to the sphere center automatically during the
    // frustum check.
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
      // Sky dome doesn't write into depth — it must never occlude
      // world geometry. The dome is drawn first with `renderOrder = -1`
      // and depthTest off so it always lands at the back.
      depthWrite: false,
      depthTest: false,
      fog: false, // exempt from scene.fog so the dome reads cleanly
    });
    domeMat.name = "sky-dome-gradient";
    this.dome = new THREE.Mesh(domeGeom, domeMat);
    this.dome.name = "sky_dome";
    this.dome.renderOrder = -1;
    this.dome.userData = { sky_dome: true };
    // Attach to scene root, NOT under worldRoot. Capture script's
    // bullet 11 walks `scene.children` looking for `name === "sky_dome"`.
    this.scene.add(this.dome);

    // === 2. Celestial body group ====================================
    //
    // The celestialGroup wrapper exists for tick-time bulk operations
    // (e.g. .visible = false for the indoor flip). Each individual
    // body Group is ADDED TWICE: once as a child of celestialGroup
    // for transformation, and once... actually no — three.js does NOT
    // allow a node to live under two parents. So we use a different
    // approach: the celestial body groups live as DIRECT children of
    // scene.children (so bullet 12 sees them), and we keep a
    // `skyObjectMeshes` Map for per-frame iteration.
    //
    // For the indoor visibility flip we iterate that Map and set
    // `.visible = false` on each, plus flip `this.dome.visible`
    // separately. The `celestialGroup` exists purely as a JS-side
    // bookkeeping handle (NOT added to the scene tree).
    this.celestialGroup = new THREE.Group();
    this.celestialGroup.name = "sky_celestial_bodies"; // not in tree
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
    // When a SkyObjectReplace swaps the target mesh, we hide the
    // previously-active one and un-hide the new target.
    this._lastActiveIdPerObjectIndex = new Map();
    // Capture-script bullet 18 introspection: count of mesh-swap
    // events this session (how many times a SkyObject's active
    // gfx_obj_id changed across consecutive ticks).
    this._meshSwapCount = 0;
    // Workstream Sky-I-A: optional `?skydebug=1` URL flag. When set,
    // `tick()` writes a per-frame dump to `window.__skyDebugLastDump`
    // (object, mesh, camera, fog details). The capture script's
    // `?skydebug=1` probe reads this once per second at four
    // time-of-day overrides and writes JSON to disk. Pure measurement
    // — no behaviour change when flag is unset.
    this._skyDebug = false;
    try {
      if (typeof window !== "undefined" && window.location?.search) {
        const params = new URLSearchParams(window.location.search);
        this._skyDebug = params.get("skydebug") === "1";
      }
    } catch (_) { /* no-window in worker context */ }
    if (this._skyDebug && typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.log("[sky-i-a] ?skydebug=1 — installing per-tick state dump on window.__skyDebugLastDump");
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
   * Workstream Sky-G: every bake in `skyAssets` becomes a mesh added
   * to the scene root. The renderer keys lookups by the post-replace
   * `s.gfxObjectId` — so if `skyAssets` includes both a SkyObject's
   * default mesh AND a SkyObjectReplace override mesh, the renderer
   * naturally swaps in the override on keyframe transitions (no
   * runtime bake; zero network).
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

    // Tear down any existing meshes (idempotent re-bake path).
    for (const mesh of this.skyObjectMeshes.values()) {
      this.scene.remove(mesh);
    }
    this.skyObjectMeshes.clear();

    let added = 0;
    for (const [skyObjectId, bake] of skyAssets) {
      if (!bake || !Array.isArray(bake.parts) || bake.parts.length === 0) {
        continue;
      }
      let group;
      try {
        group = buildSkyObjectGroup(bake, materialCache);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sky-d] buildSkyObjectGroup failed for 0x${skyObjectId.toString(16)}:`,
          e
        );
        continue;
      }
      // Tag so capture-script bullet 12 (which walks scene.children
      // for `userData.sky_object_id !== undefined`) counts this body.
      group.userData = {
        ...(group.userData || {}),
        sky_object_id: skyObjectId,
      };
      // Scale up celestial bodies so they read as ~5° of arc on the
      // sky-dome (see `CELESTIAL_BODY_SCALE` constant note).
      group.scale.setScalar(CELESTIAL_BODY_SCALE);
      // Sky-D's celestial bodies render BEFORE world geometry (with
      // depthWrite=false) so they're always behind. renderOrder=-0.5
      // places them between the dome (renderOrder=-1) and the world
      // (default 0).
      group.renderOrder = -0.5;
      // Each surface mesh inside the bake already has its material
      // baked from `MaterialCache` (with the Translucent/Additive/
      // Luminous flags decoded from the surface_type bitfield). For
      // celestial bodies specifically we want depthWrite=false so they
      // don't occlude foreground world content — patch each material
      // mesh's `.material` in-place. Note: this mutates the shared
      // MaterialCache material; safe because the dome is the only
      // consumer for sky-specific surface DIDs (they're not used by
      // buildings or EnvCells per Sky-E's diagnostic dump).
      group.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.depthWrite = false;
          // Sky meshes don't receive shadows or interact with fog.
          child.material.fog = false;
        }
      });
      // Sky-G: start every override mesh hidden — the tick() pass will
      // un-hide whichever ID is currently the active one for any
      // SkyObject. Without this every mesh would render on top of
      // every other one.
      group.visible = false;
      // Add directly to scene root (NOT to celestialGroup which is
      // bookkeeping-only). Bullet 12 walks scene.children.
      this.scene.add(group);
      this.skyObjectMeshes.set(skyObjectId, group);
      added += 1;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[sky-d] populated ${added}/${skyAssets.size} celestial bodies on scene root`
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
   * We read:
   *   - `liveScene3d.skyBackgroundColor` — Sky-C's sink (fog_color tint;
   *     horizon color).
   *   - `liveScene3d.skyLightingController._lastState.ambColorArgb` —
   *     the ambient color (zenith tint).
   *   - `sessionHandle.getSkyObjectStates()` — per-object heading,
   *     pitch, visibility, UV scroll.
   *   - `sessionHandle.isCurrentCellIndoor()` — for the dome/celestial
   *     visibility flip.
   *
   * We write:
   *   - Dome + celestial bodies follow camera position.
   *   - Dome's gradient uniforms.
   *   - Each celestial body's position (sphere projection), visibility,
   *     transparent/luminosity/emissive overrides.
   *   - Per-material UV offset for tex_velocity scrolling.
   */
  tick(_dt, camera) {
    this._tickCount += 1;

    // === A. Translate dome + celestial bodies with the camera =======
    //
    // Camera-parented means: dome position = camera position. This is
    // a translation only — we do NOT copy the camera's rotation
    // (otherwise the celestial bodies would never appear to move).
    if (camera && camera.position) {
      this.dome.position.copy(camera.position);
      for (const mesh of this.skyObjectMeshes.values()) {
        // The mesh itself gets a celestial-sphere position computed
        // below — but the position is RELATIVE to the camera; we
        // express that by computing `camera.position + offset`.
        // (Setting `mesh.position = camera.position + cel_offset` is
        // simpler than introducing an intermediate Group parent.)
        mesh.position.copy(camera.position);
      }
    }

    // === B. Indoor flip ==============================================
    //
    // When the player is inside an EnvCell, hide the dome + every
    // celestial body. Phase 7.6 already flips the sun's `.visible`;
    // we do the same here for the sky-rendering pieces.
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
    }
    const wantSkyVisible = !isIndoor;
    if (this.dome.visible !== wantSkyVisible) {
      this.dome.visible = wantSkyVisible;
    }
    for (const mesh of this.skyObjectMeshes.values()) {
      // Per-body visibility is overridden by the SkyObjectState's
      // own `visible` flag below. The indoor flip applies first as a
      // hard gate; the per-body flag refines it on a per-tick basis.
      if (!wantSkyVisible && mesh.visible) {
        mesh.visible = false;
      }
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
    // Skip if we're indoor (the bodies are hidden; saves the per-frame
    // wasm round-trip + the per-body matrix math) OR if we have no
    // meshes yet (Sky-E hasn't completed).
    if (isIndoor || this.skyObjectMeshes.size === 0) {
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
      const mesh = this.skyObjectMeshes.get(skyObjectId);
      if (!mesh) continue;

      // Workstream Sky-G: SkyObjectReplace mesh-swap handling. If the
      // SkyObject at index `i` was previously rendering with a
      // different gfx_obj_id, we need to:
      //   1. Hide the previously-active mesh for this object index.
      //   2. Increment the mesh-swap counter (bullet 18).
      // The new mesh's visibility is then set by `s.visible` below.
      const lastActive = this._lastActiveIdPerObjectIndex.get(i);
      if (lastActive !== undefined && lastActive !== skyObjectId) {
        const lastMesh = this.skyObjectMeshes.get(lastActive);
        if (lastMesh && lastMesh.visible) {
          lastMesh.visible = false;
        }
        this._meshSwapCount += 1;
      }
      this._lastActiveIdPerObjectIndex.set(i, skyObjectId);

      // Per-state visibility. Indoor flip already gates the parent
      // dome; this is the per-body day-of-arc flag.
      if (mesh.visible !== s.visible) {
        mesh.visible = !!s.visible;
      }
      if (!s.visible) continue;

      // Project (heading, pitch) onto the celestial sphere, offset
      // from the camera position (which we already wrote above).
      const [ox, oy, oz] = celestialPosition(
        s.heading,
        s.pitch,
        this.celestialRadius
      );
      mesh.position.x += ox;
      mesh.position.y += oy;
      mesh.position.z += oz;
      // Billboard-style: orient the body so it faces the camera. Use
      // `lookAt(camera.position)` — for flat-quad skyobjects this is
      // the standard sprite-billboard behaviour; for 3D meshes (the
      // moon SetupModel 0x02000714) it's still sensible because their
      // visually-interesting face is the camera-facing one.
      if (camera) {
        mesh.lookAt(camera.position);
      }

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
      // dome. Pre-multiplied with the directional-light color (per
      // Sky-C's dir_color_argb) so dawn/dusk's red-tinted bodies
      // match the ambient atmosphere.
      const t = s.transparent;
      const lum = s.luminosity;
      const mb = s.maxBright;
      const tx = s.texOffsetX;
      const ty = s.texOffsetY;
      mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        if (t >= 0.0 && t <= 1.0) {
          const opacity = 1.0 - t;
          if (mat.transparent !== true) mat.transparent = true;
          if (Math.abs(mat.opacity - opacity) > 1e-3) {
            mat.opacity = opacity;
          }
        }
        // Emissive boost when the SkyObjectReplace has set luminosity.
        if (lum >= 0.0 && mb >= 0.0 && mat.emissive) {
          // luminosity * max_bright is a flat scalar in [0, ~2]; we
          // map to emissive intensity directly. Don't tint here —
          // material's own emissive color comes from the surface
          // bitfield's Luminous flag (or stays white for sky-default).
          const intensity = lum * mb;
          if (Math.abs((mat.emissiveIntensity ?? 0) - intensity) > 1e-3) {
            mat.emissiveIntensity = intensity;
          }
        }
        // UV scroll for cloud band + stars (tex_velocity from the DAT
        // accumulates into tex_offset_x/y per Sky-B). Applied to
        // material.map.offset; the texture's wrapS/wrapT are already
        // RepeatWrapping via `surfacePixelsToTexture`.
        if (mat.map) {
          mat.map.offset.set(tx, ty);
        }
      });
    }

    // === E. Sky-I-A debug dump =======================================
    //
    // When `?skydebug=1`, capture per-frame state including each
    // celestial body's world-space center (after the position offsets
    // applied above), distance from camera, and the camera/fog frustum
    // bounds — for the Sky-I-A probe. No behaviour change when flag
    // unset. Updates `window.__skyDebugLastDump` once per tick.
    if (this._skyDebug && typeof window !== "undefined" && camera) {
      try {
        window.__skyDebugLastDump = this._buildSkyDebugDump(states, camera);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[sky-i-a] debug-dump build failed:", e?.message);
      }
    }
  }

  /**
   * Sky-I-A: build a JSON-friendly debug dump describing each visible
   * SkyObject's geometry in world space + the camera + fog bounds.
   * Pure read-only — no mutation of scene-graph state. Called once
   * per tick when `?skydebug=1`.
   */
  _buildSkyDebugDump(states, camera) {
    // World-matrix needs to reflect the position writes done above.
    // Force update before reading worldMatrix on each body.
    for (const mesh of this.skyObjectMeshes.values()) {
      mesh.updateMatrixWorld(true);
    }

    const camPos = camera.position;
    const cameraInfo = {
      position: { x: camPos.x, y: camPos.y, z: camPos.z },
      fovDeg: typeof camera.fov === "number" ? camera.fov : null,
      near: typeof camera.near === "number" ? camera.near : null,
      far: typeof camera.far === "number" ? camera.far : null,
    };
    const fogInfo = (() => {
      const f = this.scene?.fog;
      if (!f) return null;
      // Fog has `near`/`far` (linear) OR `density` (exp). Capture both
      // shapes so the consumer can distinguish.
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
    for (const [skyObjectId, mesh] of this.skyObjectMeshes.entries()) {
      const state = stateById.get(skyObjectId);
      // Compute the union AABB across child meshes — that's the
      // "native" vertex-space AABB before the celestial-sphere offset.
      // Aggregate per-mesh boundingBox under the group's LOCAL transform.
      let lmin = null;
      let lmax = null;
      let totalVerts = 0;
      mesh.traverse((child) => {
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
      const nativeAabb = lmin && lmax ? {
        min: { x: lmin.x, y: lmin.y, z: lmin.z },
        max: { x: lmax.x, y: lmax.y, z: lmax.z },
        center: { x: (lmin.x + lmax.x) / 2, y: (lmin.y + lmax.y) / 2, z: (lmin.z + lmax.z) / 2 },
        verts: totalVerts,
      } : null;

      // The world center: transform the local-aabb center by the
      // mesh's worldMatrix. That answers the headline "where does the
      // sun actually end up after all the transforms".
      let worldCenter = null;
      let distanceFromCamera = null;
      if (nativeAabb) {
        const v = new THREE.Vector3(
          nativeAabb.center.x,
          nativeAabb.center.y,
          nativeAabb.center.z
        );
        v.applyMatrix4(mesh.matrixWorld);
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
          visible: !!state.visible,
          transparent: state.transparent,
          luminosity: state.luminosity,
          maxBright: state.maxBright,
          properties: state.properties >>> 0,
          texOffsetX: state.texOffsetX,
          texOffsetY: state.texOffsetY,
        } : null,
        mesh: {
          visible: mesh.visible,
          nativeAabb,
          positionApplied: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
          scaleApplied: { x: mesh.scale.x, y: mesh.scale.y, z: mesh.scale.z },
          worldMatrix: Array.from(mesh.matrixWorld.elements),
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
      celestialRadius: this.celestialRadius,
      objectCount: objects.length,
      camera: cameraInfo,
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
      this.scene.remove(this.dome);
    }
    for (const mesh of this.skyObjectMeshes.values()) {
      this.scene.remove(mesh);
    }
    this.skyObjectMeshes.clear();
  }
}

// Internal helpers re-exported for the Node ESM test (so the test can
// assert the geometry math directly without standing up a full
// SkyDome). NOT part of the public API.
export const __internals = Object.freeze({
  celestialPosition,
  argbToColor,
  DOME_RADIUS,
  CELESTIAL_SPHERE_RADIUS,
  CELESTIAL_BODY_SCALE,
});
