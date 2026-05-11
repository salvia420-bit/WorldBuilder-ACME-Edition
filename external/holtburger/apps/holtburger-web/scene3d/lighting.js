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
// not directional.
const AMBIENT_COLOR = 0xfff0e0;

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

  if (castShadow) {
    sun.castShadow = true;
    // Shadow camera spans the scene's outer radius. The frustum is
    // an orthographic box centred on the sun's target (origin by
    // default); halfSize == sceneSize covers the 9-LB neighbourhood
    // without clipping at the edges.
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

  function dispose() {
    if (sun.shadow && sun.shadow.map && typeof sun.shadow.map.dispose === "function") {
      sun.shadow.map.dispose();
    }
    scene.remove(lightsGroup);
  }

  return { sun, ambient, hemisphere, lightsGroup, dispose };
}

// Maximum number of per-SetupModel lights allowed to render in any
// one frame. Lights beyond this are kept in the graph but their
// `.visible` flag is flipped off; sorting by distance ensures the
// closest ones always win. 32 is a defensive cap — WebGL2's uniform
// array headroom is well above this on every modern GPU, but
// MeshStandardMaterial recompiles its shader when light counts
// change, so a fixed cap keeps shader-variance low.
const MAX_ACTIVE_LIGHTS = 32;

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
        // ambient intensity. Compare against the canonical thresholds so
        // a third-party override (e.g. capture script poking
        // ambient.intensity = 0.42 for a screenshot) doesn't trigger
        // ping-ponging in the next tick if the cell state hasn't changed.
        const wantIntensity = isIndoor
          ? AMBIENT_INTENSITY_INDOOR
          : AMBIENT_INTENSITY_OUTDOOR;
        if (Math.abs(ambient.intensity - wantIntensity) > 1e-4) {
          ambient.intensity = wantIntensity;
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

  recordBuildingTree(scene3d.buildingsGroup);
  recordStatics(scene3d.staticsGroup);
  recordEntities(scene3d.entityManager);

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
      for (const { partIndex, object3D } of partEntries) {
        if (partIndex !== targetPartIndex) continue;
        // Clone per instance — three.js Light.clone() preserves
        // intensity / distance / decay / color.
        const inst = (attachedAny ? lightObj.clone() : lightObj);
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

/**
 * Build a single `THREE.PointLight` or `THREE.SpotLight` from a wasm
 * `SetupLight` getter struct (or a plain JS object with the same
 * field shape). Position is set from `(x, y, z)` in the source's
 * native AC coords; caller parents the result under a part `Object3D`
 * which is itself under `worldRoot` (which carries the AC→three
 * rotation).
 *
 * Returns `null` if the input doesn't have the minimum field shape.
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
  const safeFalloff =
    Number.isFinite(falloff) && falloff > 0 ? falloff : 0;
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

// Expose canonical intensities + the per-light cap so capture
// scripts can assert the exact values without re-deriving them.
export const LIGHTING_CONSTANTS = Object.freeze({
  AMBIENT_INTENSITY_OUTDOOR,
  AMBIENT_INTENSITY_INDOOR,
  MAX_ACTIVE_LIGHTS,
  LIGHT_INTENSITY_CLAMP,
  SPOTLIGHT_PENUMBRA,
  LIGHT_DECAY,
});
