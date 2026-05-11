// Phase 7.0+ — three.js public entry point. Mirrors `renderNeighbourhood`'s
// role on the 2D PIXI path. Only loaded when `?renderer=3d` is present.
//
// Phase 7.0 shipped scaffolding (Scene + PerspectiveCamera +
// WebGLRenderer + worldRoot rotation + hello-cube). Phase 7.1 adds
// the Holtburg 9-LB heightfield terrain + bilinear-blend shader +
// road overlays via `buildHoltburgTerrain` from `./terrain.js`.
// Phase 7.2 adds buildings (per-part Object3D trees) and statics
// (fused per-model meshes) via `./buildings.js` + `./statics.js`.
//
// Coordinate system: AC is Z-up; three.js is Y-up. We rotate `worldRoot`
// by -π/2 about X so AC world coordinates (x east, y north, z up) map to
// three.js world coordinates (x east, z south, y up) without inverting
// any winding orders. See migration plan §"Strategic decisions" item 4.

import * as THREE from "three";
import { buildHoltburgTerrain } from "./terrain.js";
import { buildHoltburgBuildings } from "./buildings.js";
import { buildHoltburgStatics } from "./statics.js";
import { buildEnvCellsForLandblock } from "./cells.js";
import { tickPerFrame, installSharedDrainHook } from "./loop.js";
import { EntityManager } from "./entities.js";
import { CameraSwitcher, createOrthoCamera } from "./camera.js";
import { setupSceneLighting, attachSetupModelLights } from "./lighting.js";
import { acToThree } from "./adapter.js";
import { createNameplateOverlay } from "./hud.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

export async function init3D(canvas, sessionHandle, wasmExports) {
  // Canvas sizing — index.html's <canvas> has width="512" height="512"
  // as an attribute fallback for the 2D path's pixel-art look. For
  // the 3D path we override to a viewport-relative size so the world
  // actually fills the screen instead of rendering into a 512px square
  // that gets lost on a 4K display.
  //
  // Pick min(viewport - chrome, sensible cap) so:
  //   - The canvas grows to fill the visible area on big screens.
  //   - We cap at 1920×1080 in CSS pixels so the GPU isn't asked to
  //     fill 4K natively (the wasm bundle + three.js already strain
  //     mid-range GPUs at higher res).
  //   - devicePixelRatio caps at 2 so HiDPI screens don't quadruple
  //     the draw cost.
  // Both `canvas.width/height` (drawing buffer) and `canvas.style.*`
  // (CSS rendered size) are set explicitly so the browser doesn't
  // fall back to the 512 attribute defaults.
  const layoutChromeH = 320; // reserve space for HUD panels above + status
  const cssW = Math.min(window.innerWidth - 32, 1920);
  const cssH = Math.min(window.innerHeight - layoutChromeH, 1080);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = cssW;
  canvas.height = cssH;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Cap DPR at 2 — beyond that the cost outpaces the visual gain on
  // a textured-mesh scene of this complexity.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(cssW, cssH, false);
  renderer.setClearColor(0x101418, 1);

  const scene = new THREE.Scene();

  // worldRoot carries the AC-Z-up→three-Y-up correction. Every
  // subsequent group attaches under it so child positions can be set
  // in raw AC coordinates and three.js handles the rotation once at
  // the root.
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);

  // Group placeholders for phases 7.1–7.4. Empty in 7.0; future phases
  // populate them with terrain meshes / building rigs / static meshes /
  // env-cell groups / entity rigs.
  const terrainGroup = new THREE.Group(); terrainGroup.name = "terrain";
  const buildingsGroup = new THREE.Group(); buildingsGroup.name = "buildings";
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  const cellsGroup = new THREE.Group(); cellsGroup.name = "cells";
  const entitiesGroup = new THREE.Group(); entitiesGroup.name = "entities";
  worldRoot.add(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup);

  // Hello-world cube — Phase 7.0 contract still in place so the 7.0
  // capture stays green (it asserts position (0, 0, 5) when init3D is
  // called with empty wasmExports). When real terrain is available
  // (Phase 7.1+ path), we shift the cube 100 m off-axis below to keep
  // it from polluting the Holtburg view.
  const cubeGeom = new THREE.BoxGeometry(2, 2, 2);
  // Phase 7.7 — three.js BoxGeometry's primitive constructor does NOT
  // pre-compute boundingSphere (verified in r184). Without this call,
  // the hello-cube's `Mesh.frustumCulled = true` would silently fail
  // (three.js falls back to "always visible" when boundingSphere is
  // null), polluting the frustum-culling measurement in
  // capture_phase7_7_frustum.cjs. Explicit call keeps it honest.
  cubeGeom.computeBoundingSphere();
  const cubeMat = new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.6, metalness: 0.1 });
  const cube = new THREE.Mesh(cubeGeom, cubeMat);
  cube.name = "hello-cube";
  cube.position.set(0, 0, 5);
  worldRoot.add(cube);

  // Phase 7.6 — scene lighting moved to `./lighting.js`. The module
  // attaches a DirectionalLight (sun) + AmbientLight (+ optional
  // HemisphereLight) under a `lights` group at the scene root, then
  // `tickLightingForCellState` (driven by `loop.js`) flips
  // `sun.visible` + boosts `ambient.intensity` when the wasm cell
  // BFS reports indoor. `sceneSize: 600` covers Holtburg's 9-LB
  // neighbourhood for shadow camera framing (shadows opt-in,
  // disabled by default in Phase 7.6).
  const lighting = setupSceneLighting(scene, { sceneSize: 600 });
  const { sun, ambient, lightsGroup } = lighting;

  // Camera — perspective. Default framing for the Phase 7.0 hello-
  // world is back-and-up from the cube; Phase 7.1+ retargets it onto
  // the Holtburg LB centre after terrain is built.
  const camera = new THREE.PerspectiveCamera(60, cssW / cssH, 0.1, 5000);
  camera.position.set(15, 15, 15);
  camera.lookAt(0, 0, 5);

  // Keep the canvas + renderer in sync with viewport resizes (the
  // 2D path lives with the static 512×512 attribute size, but the 3D
  // path is set up to be a real game viewport). Debounce so resize-
  // drag doesn't thrash the WebGL framebuffer reallocation. Attached
  // AFTER `camera` is constructed so the closure access doesn't TDZ
  // when DevTools-open / window-resize fires during the long init3D
  // await chain below.
  let resizeDebounce = null;
  window.addEventListener("resize", () => {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      const newW = Math.min(window.innerWidth - 32, 1920);
      const newH = Math.min(window.innerHeight - layoutChromeH, 1080);
      canvas.style.width = `${newW}px`;
      canvas.style.height = `${newH}px`;
      renderer.setSize(newW, newH, false);
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
    }, 150);
  });

  // Phase 7.1 — build Holtburg 9-LB terrain when real wasmExports
  // are available. The Phase 7.0 capture still calls init3D with an
  // empty `{}` to exercise the renderer-only path; we gate on
  // `fetch_landblock_heightmaps` so that 7.0 path keeps working.
  // Phase 7.2 layers buildings + statics on top, gated on the
  // building-specific exports (`fetchBuildingPlacement` etc).
  let terrainSummary = null;
  let buildingsSummary = null;
  let staticsSummary = null;
  // Construct a stub scene3d shape early so the per-phase builders
  // can share state (`materialCache`, `buildingMap3d`).
  const scene3dForBuilders = {
    terrainGroup,
    buildingsGroup,
    staticsGroup,
    cellsGroup,
    entitiesGroup,
    // Phase 7.3 — populated by `buildEnvCellsForLandblock`. Initialise
    // here so capture scripts and the loop tick can reference it from
    // the moment init3D resolves (even if no EnvCells loaded).
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    // Phase 7.6.1 (follow-on #1) — per-SetupModel point/spot lights.
    // Populated by `attachSetupModelLights` after the per-phase
    // builders finish. The per-rAF `tickLightingForCellState` caps
    // `.visible = true` on the closest MAX_ACTIVE_LIGHTS (32) and
    // flips the rest off.
    activeLights: [],
  };
  if (
    wasmExports &&
    typeof wasmExports.fetch_landblock_heightmaps === "function" &&
    typeof wasmExports.fetch_terrain_textures === "function"
  ) {
    try {
      terrainSummary = await buildHoltburgTerrain(
        scene3dForBuilders,
        wasmExports
      );
      // Move the hello-cube 100 m off-axis so it doesn't sit in the
      // middle of Holtburg's terrain. The Phase 7.0 capture's
      // assertion path doesn't fire here (it calls init3D with empty
      // wasmExports, so this branch is skipped).
      cube.position.set(-100, -100, 5);

      // Retarget the camera onto the Holtburg LB centre. lbX*192 +
      // 96 is the centre of the LB in AC metres; +200 m up gives a
      // bird's-eye view that takes in all 9 LBs (roughly 576 m
      // square). Looking down at +80 m (just above Holtburg's typical
      // terrain elevation) keeps the framed point on the heightfield
      // surface, not in the air.
      const cx = HOLTBURG_X * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2;
      const cy = HOLTBURG_Y * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2;
      // Camera position + lookAt are in three.js world coords. Geometry
      // inside worldRoot is in AC coords and gets `rotation.x = -π/2`
      // applied automatically. Apply the same transform here so the
      // camera looks at where the geometry actually renders. Without
      // this, the camera ends up 30+km off-axis from the world (Phase
      // 7.7 audit, frustum capture: 0 vs 153 draw calls).
      camera.position.set(...acToThree(cx, cy, 200));
      camera.lookAt(...acToThree(cx, cy, 80));
    } catch (e) {
      // Don't kill the page on a terrain build error — log + continue
      // so the rest of init3D's contract (window.liveScene3d, render
      // loop) still ships. The Phase 7.1 capture will catch it via
      // the per-LB assertions.
      // eslint-disable-next-line no-console
      console.error("[scene3d] buildHoltburgTerrain failed:", e);
    }
  }

  // Phase 7.2 — buildings + statics. Gated on the building wasm
  // exports so the 7.0/7.1 capture paths (empty wasmExports / terrain-
  // only exports) keep their existing contracts.
  if (
    wasmExports &&
    typeof wasmExports.fetch_landblock_objects === "function" &&
    typeof wasmExports.fetchBuildingPlacement === "function" &&
    typeof wasmExports.fetch_surfaces_pixels === "function"
  ) {
    try {
      buildingsSummary = await buildHoltburgBuildings(
        scene3dForBuilders,
        wasmExports
      );
      // eslint-disable-next-line no-console
      console.log("[phase7.2] buildings:", buildingsSummary);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[scene3d] buildHoltburgBuildings failed:", e);
    }
    if (typeof wasmExports.fetch_model_meshes === "function") {
      try {
        staticsSummary = await buildHoltburgStatics(
          scene3dForBuilders,
          wasmExports
        );
        // eslint-disable-next-line no-console
        console.log("[phase7.2] statics:", staticsSummary);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[scene3d] buildHoltburgStatics failed:", e);
      }
    }

    // (Per-SetupModel lights are attached AFTER EnvCells load — see
    // below — so the walker can pick up cells too once we extend the
    // recorder. For now buildings + statics + entities are covered.)
  }

  // Phase 7.3 — load known dungeon EnvCells for capture-script
  // verification. Real-world flow loads on landblock-change events
  // (Phase 7.5 will wire that). For now, eager-load Mite Maze
  // (0x01F80000) + Holtburg Dungeon (0x01F60000) so the capture can
  // confirm the EnvCell pipeline ships real data end-to-end.
  let envCellsLoaded = null;
  if (
    wasmExports &&
    typeof wasmExports.fetchEnvCellsInLandblock === "function" &&
    typeof wasmExports.fetch_surfaces_pixels === "function" &&
    scene3dForBuilders.materialCache
  ) {
    try {
      const miteMaze = await buildEnvCellsForLandblock(
        scene3dForBuilders,
        0x01f80000,
        wasmExports
      );
      const holtDungeon = await buildEnvCellsForLandblock(
        scene3dForBuilders,
        0x01f60000,
        wasmExports
      );
      envCellsLoaded = { miteMaze, holtDungeon };
      // eslint-disable-next-line no-console
      console.log("[phase7.3] envCells:", envCellsLoaded);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase7.3] EnvCell load failed:", e);
      envCellsLoaded = null;
    }
  }

  // Phase 7.6.1 (3D port follow-on #1) — per-SetupModel point/spot
  // lights. Walks the post-build scene graph (buildings + statics +
  // entity rigs) to collect every unique setup_id in use, then calls
  // `wasmExports.fetchSetupModelLights(setupId)` for each and attaches
  // a PointLight (cone_angle == 0) or SpotLight (cone_angle > 0) per
  // returned `SetupLight` under the matching part Object3D. The per-
  // rAF tick (`tickLightingForCellState`) caps active lights at 32 via
  // distance-sort + .visible toggle.
  //
  // Most Holtburg buildings have no light descriptors (they're raw
  // 0x01 GfxObjs with no Setup), so a typical Holtburg load returns
  // `lightCount == 0` and `noLightModels == modelsScanned`. That's
  // grounded reality — capture script asserts "≥ 0" without expecting
  // a specific positive count. The cap-enforcement logic is exercised
  // unconditionally; even with 0 real lights a synthetic 100-light
  // stress test verifies the cap works.
  let setupLightsSummary = null;
  if (
    wasmExports &&
    typeof wasmExports.fetchSetupModelLights === "function"
  ) {
    try {
      setupLightsSummary = await attachSetupModelLights(
        scene3dForBuilders,
        wasmExports
      );
      // eslint-disable-next-line no-console
      console.log("[phase7.6.1] setupModelLights:", setupLightsSummary);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase7.6.1] attachSetupModelLights failed:", e);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[phase7.6.1] fetchSetupModelLights wasm export not in wasmExports — skipping per-SetupModel lights"
    );
  }
  scene3dForBuilders.setupLightsSummary = setupLightsSummary;

  // Phase 7.5 — top-down OrthographicCamera, built alongside the
  // PerspectiveCamera so the CameraSwitcher (constructed below) can
  // hot-swap between them on `C` keypress. The ortho's frustum +
  // initial framing are set by `createOrthoCamera`; per-tick framing
  // (recentering on the player) is the switcher's job.
  const orthoCamera = createOrthoCamera(canvas);

  // Resize handler — keep the renderer tracking the canvas's CSS size.
  // Both the perspective AND ortho camera projections need updating so
  // a `C`-toggle to top-down after a resize still framing correctly.
  const onResize = () => {
    const cw = canvas.clientWidth || canvas.width || 1;
    const ch = canvas.clientHeight || canvas.height || 1;
    renderer.setSize(cw, ch, false);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    // Re-derive the ortho frustum width from the new aspect ratio.
    // Frustum height is fixed at construction (TOPDOWN_FRUSTUM_HEIGHT_M
    // in camera.js); width scales with aspect.
    const halfH = (orthoCamera.top - orthoCamera.bottom) / 2;
    const halfW = halfH * (cw / ch);
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  // Render loop. Phase 7.0 was a thin rAF wrapper; Phase 7.3 wires
  // `tickPerFrame` from `./loop.js` so cell-visibility flips happen
  // every frame. Later phases append entity mixers / camera ticks /
  // lighting updates inside the same `tickPerFrame`.
  let running = true;
  let lastFrameTs = null;
  // `liveScene3d` is referenced inside tick before it's constructed
  // below, so we forward-declare and patch the reference after
  // construction. The session handle attached to `liveScene3d` is the
  // one passed into `init3D`; capture scripts can stub it post-init
  // by setting `window.liveScene3d.sessionHandle = mock`.
  let liveScene3dRef = null;
  function tick(nowTs) {
    if (!running) return;
    const ts = typeof nowTs === "number" ? nowTs : performance.now();
    const dt =
      lastFrameTs === null
        ? 0.016
        : Math.min((ts - lastFrameTs) / 1000, 0.1);
    lastFrameTs = ts;
    if (liveScene3dRef) {
      try {
        tickPerFrame(liveScene3dRef, liveScene3dRef.sessionHandle, dt);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[scene3d.loop] tickPerFrame threw:", e);
      }
    }
    // Phase 7.5 — render with the camera switcher's active camera so
    // toggling C between follow/orbit/topDown flips the render target.
    // Pre-7.5 (or if the switcher hasn't constructed yet) we fall back
    // to the original perspective camera so the Phase 7.0 hello-cube
    // capture path keeps working.
    const activeCam = liveScene3dRef?.cameraSwitcher?.activeCamera ?? camera;
    renderer.render(scene, activeCam);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Follow-on #10 (3D port state doc) — DOM-projected nameplate overlay.
  // PIXI v8 stays in the page for any 2D filtering needs DOM/CSS can't
  // handle (chat is DOM and unaffected), but the nameplate layer is a
  // pure DOM div tree: one `<div>` per entity, positioned per frame
  // via `Vector3.project(camera)`. Stashed on scene3dForBuilders
  // BEFORE EntityManager so spawn-time `setNameplate` calls can find
  // it via `scene3d.nameplateLayer?.setNameplate(guid, name, root)`.
  //
  // Capture-script standalone path (no canvas.parentElement) returns
  // null from createNameplateOverlay; downstream `?.setNameplate` /
  // `?.tick` calls degrade to no-ops via optional chaining. The mode-1
  // capture verifies this explicitly via window.liveScene3d.nameplateLayer.
  let nameplateLayer = null;
  try {
    const overlay = createNameplateOverlay(canvas);
    if (overlay) {
      nameplateLayer = overlay.layer;
      // eslint-disable-next-line no-console
      console.log("[scene3d] nameplate overlay attached:", overlay.domRoot.id);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[scene3d] createNameplateOverlay failed:", e);
  }
  scene3dForBuilders.nameplateLayer = nameplateLayer;

  // Phase 7.4b — entity manager wires up here so the rAF tick can call
  // tickPerFrame → mixer.update(dt). Constructed BEFORE the liveScene3d
  // object so the wired-into-scene3d field can include it. The
  // shared-drain hook is then installed (window.__scene3dEntityHook)
  // so the 2D drainEvents loop can forward entity events into this
  // manager when ?renderer=3d is active. Phase 7.5 will fully gate
  // the 2D drainEvents off the 3D path; for now we coexist via the
  // hook.
  const entityManager = new EntityManager(scene3dForBuilders, wasmExports);
  scene3dForBuilders.entityManager = entityManager;

  // Phase 7.5 — camera switcher. Owns the WASD + mouse-look listeners,
  // the three controllers (PointerLockControls for follow,
  // OrbitControls for orbit, ortho framing for topDown), and the
  // per-frame call into `sessionHandle.setMovementInput(forward,
  // strafe, turn, run)` with camera-relative directions. Constructed
  // AFTER the EntityManager so `getPlayerWorldPos` can resolve the
  // local-player rig once the wire stream lands a Spawn event for the
  // local player. Pre-spawn, the resolver returns null and the
  // switcher falls back to the Holtburg LB centre so the camera has
  // sensible initial framing.
  const cameraSwitcher = new CameraSwitcher({
    scene3d: scene3dForBuilders,
    perspectiveCamera: camera,
    orthoCamera,
    domElement: canvas,
    // Lazy resolver — init3D fires BEFORE the login form completes so
    // the `sessionHandle` argument here is typically `undefined`. Read
    // window.__sessionHandle on each tick instead. The 2D bootstrap
    // sets it from the login handler.
    sessionHandle: () => sessionHandle ?? window.__sessionHandle,
    getPlayerWorldPos: () => {
      // EntityManager exposes the local player's world pos once a
      // Spawn lands for the GUID setLocalPlayerGuid recorded (see the
      // 2D drainEvents loop at index.html:5733).
      const p = entityManager.getLocalPlayerWorldPos?.();
      if (p) return p;
      // Fallback: Holtburg LB centre. AC: (0xA9*192 + 96, 0xB4*192 + 96, ~80).
      return {
        x: HOLTBURG_X * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
        y: HOLTBURG_Y * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
        z: 80,
      };
    },
    // Follow-on #2 (2026-05-10) — local player heading in the
    // followYaw convention (CW from +Y north). Used by the
    // turn-to-align math in `computeMovementFromKeys`. Falls back to
    // 0 (north-facing) before the first spawn lands; that matches the
    // default followYaw=0 so the heading error is 0 pre-spawn and the
    // auto-turn doesn't fire prematurely.
    getPlayerHeading: () => entityManager.getLocalPlayerHeading?.() ?? 0,
  });
  scene3dForBuilders.cameraSwitcher = cameraSwitcher;

  const liveScene3d = {
    renderer,
    scene,
    worldRoot,
    camera,
    orthoCamera,
    cameraSwitcher,
    lightsGroup,
    // Phase 7.6 — `lighting` is the canonical handle bundle from
    // `setupSceneLighting`: `{ sun, ambient, hemisphere, lightsGroup,
    // dispose }`. `tickLightingForCellState` reads through this.
    lighting,
    terrainGroup,
    buildingsGroup,
    staticsGroup,
    cellsGroup,
    entitiesGroup,
    entityManager,
    // Phase 7.0 hello-cube — kept addressable so capture scripts can
    // sanity-check `liveScene3d.scene.children.length > 0` without
    // racing the tick loop.
    helloCube: cube,
    // Phase 7.1 terrain summary — null when init3D is called without
    // real wasm exports (e.g. the 7.0 hello-cube capture path). When
    // populated, carries the shared atlas/road textures + lb count
    // for the 7.1 capture's assertions.
    terrain: terrainSummary,
    // Phase 7.2 — buildings + statics summaries (null when the Phase
    // 7.2 wasm exports aren't supplied).
    buildings: buildingsSummary,
    statics: staticsSummary,
    // Shared MaterialCache (built lazily by buildings + statics).
    materialCache: scene3dForBuilders.materialCache ?? null,
    buildingMap3d: scene3dForBuilders.buildingMap3d ?? null,
    buildingBakeCache: scene3dForBuilders.buildingBakeCache ?? null,
    // Phase 7.3 — EnvCell registry + per-LB load summaries. The Map
    // shape (cellId → Group) mirrors the 2D path's `cellContainers`.
    // `envCellsLoaded` is the load-result bundle for the eager Phase
    // 7.3 dungeons (Mite Maze + Holtburg Dungeon). Null when the
    // EnvCell exports / materialCache weren't available.
    cellContainers3d: scene3dForBuilders.cellContainers3d,
    envCellLoadedLbs: scene3dForBuilders.envCellLoadedLbs,
    envCellsLoaded,
    // Phase 7.6.1 (follow-on #1) — per-SetupModel light registry +
    // summary. `activeLights` is the Array<THREE.PointLight |
    // THREE.SpotLight> that `tickLightingForCellState` sorts by
    // distance and caps at MAX_ACTIVE_LIGHTS (32). Empty when the
    // wasm export is missing or every Setup returned 0 lights.
    activeLights: scene3dForBuilders.activeLights,
    setupLightsSummary,
    // Follow-on #10 — DOM-projected nameplate overlay layer. Null when
    // canvas has no parentElement (some capture standalone paths).
    // Capture scripts read .lastTickVisibleCount + .nodes.size to
    // verify per-frame projection produced live pixel coords.
    nameplateLayer,
    // Stop hook — future phases use this for renderer hot-swap.
    stop() { running = false; },
    // Reference back to the wasm exports the caller passed in. Phases
    // 7.1+ pull from this rather than re-importing.
    wasmExports,
    sessionHandle,
  };
  window.liveScene3d = liveScene3d;
  // Patch the forward-declared ref now that liveScene3d exists. The
  // tick loop reads through this so the per-frame call always sees
  // the latest fields (sessionHandle, cellContainers3d) — capture
  // scripts can replace these post-init without restarting init3D.
  liveScene3dRef = liveScene3d;
  // Phase 7.4b — install the shared-drain hook last so the
  // window-level hook references the final EntityManager instance.
  // The 2D drainEvents at index.html:5723 can call
  // window.__scene3dEntityHook(upd) for each EntityUpdate to forward
  // it into the 3D path.
  installSharedDrainHook(liveScene3d);
  return liveScene3d;
}
