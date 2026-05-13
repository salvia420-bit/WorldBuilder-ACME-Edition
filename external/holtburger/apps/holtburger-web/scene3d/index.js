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
import { SkyLightingController } from "./sky_lighting.js";
import { SkyDome } from "./sky_dome.js";
import { resolveSkyAssets } from "./sky_assets.js";
import { acToThree } from "./adapter.js";
import { createNameplateOverlay } from "./hud.js";
import { AudioManager } from "./audio/audio_manager.js";
import { SoundTableCache } from "./audio/sound_table_cache.js";
import { AmbientRuntime } from "./audio/ambient_runtime.js";
import { getQuality, installQualityOnWindow } from "./quality.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

export async function init3D(canvas, sessionHandle, wasmExports) {
  // Phase X.1 — resolve the visual-fidelity quality preset from URL +
  // UA before any subsystem inits. Stored on `liveScene3d.quality` so
  // each later phase (POM, SSAO, CSM, terrain subdiv, hero assets)
  // can gate off the same single source of truth. This phase does
  // not gate any feature itself — every gate lives in its own phase.
  // Devtools: `window.__quality` mirrors the resolved object.
  const quality = installQualityOnWindow(getQuality());
  // eslint-disable-next-line no-console
  console.log(
    `[phase-x.1] quality preset=${quality.preset} source=${quality.source}`
  );

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
    // Phase X.1 — resolved quality preset (`{ preset, flags, source }`)
    // mirrored onto every builder's scene3d arg so per-phase gates can
    // read `scene3d.quality.flags.<feature>` without re-parsing the URL.
    quality,
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
    // H3 (2026-05-12): per-tick audio listener sync. PannerNode HRTF
    // panning uses the listener's world-space position + forward/up
    // to pan each in-flight source. We anchor the listener at the
    // active camera so audio swings naturally when the player turns.
    if (liveScene3dRef?.audioManager) {
      const cam = liveScene3dRef.cameraSwitcher?.activeCamera ?? camera;
      try {
        liveScene3dRef.audioManager.setListener(
          { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          {
            w: cam.quaternion.w,
            x: cam.quaternion.x,
            y: cam.quaternion.y,
            z: cam.quaternion.z,
          }
        );
      } catch (_) {
        // Don't let a listener-sync failure kill the frame.
      }
    }
    // Task D (ambient-sounds-chain, 2026-05-12): per-tick ambient
    // roller. Drives the Region.SoundDesc-keyed ambient chain
    // (terrain code → SceneType → AmbientSTB → SoundTable → Wave).
    // Wrapped in try/catch + one-shot warn so a thrown tick never
    // kills the frame. Indoor short-circuit + region-pending no-op
    // are handled inside the runtime; we just drive the timer.
    if (liveScene3dRef?.ambientRuntime) {
      try {
        liveScene3dRef.ambientRuntime.tick(dt);
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!liveScene3dRef._ambientTickWarned) {
          liveScene3dRef._ambientTickWarned = true;
          console.warn("[task-d/ambient] ambientRuntime.tick threw:", e);
        }
      }
    }
    // Phase 7.5 — render with the camera switcher's active camera so
    // toggling C between follow/orbit/topDown flips the render target.
    // Pre-7.5 (or if the switcher hasn't constructed yet) we fall back
    // to the original perspective camera so the Phase 7.0 hello-cube
    // capture path keeps working.
    const activeCam = liveScene3dRef?.cameraSwitcher?.activeCamera ?? camera;
    // Workstream Sky-I-C (2026-05-11) — render the sky pass FIRST,
    // then the world OVER it. The sky pass clears the framebuffer
    // (color+depth) and paints the dome + celestials. We then clear
    // ONLY depth (preserving sky color) and render the world with
    // `autoClear=false` so its color paint is additive on top of the
    // sky. World geometry naturally overpaints the sky wherever
    // depth-test wins.
    //
    // Sky-I-B's original "world first, then sky" attempt had a
    // load-bearing bug: after the world render, the depth buffer
    // held world depths; the sky pass cleared depth and rendered
    // the dome with `depthTest=false`, which OVERPAINTED every
    // world pixel because the dome is drawn at every fragment.
    // Reversing the call order is the cleanest minimal fix — no
    // shader depth gymnastics, no per-material depthTest mutations,
    // and the celestial bodies sit naturally "behind" the world
    // like the rest of the sky.
    let skyRendered = false;
    if (liveScene3dRef?.skyDome) {
      try {
        liveScene3dRef.skyDome.renderSkyPass(renderer, activeCam);
        skyRendered = liveScene3dRef.skyDome.wasSkyRenderedLastFrame();
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!liveScene3dRef._skyPassRenderWarned) {
          liveScene3dRef._skyPassRenderWarned = true;
          console.warn("[sky-i-b] skyDome.renderSkyPass threw:", e);
        }
      }
    }
    if (skyRendered) {
      // Preserve sky color paint across the world render. Clear ONLY
      // the depth buffer so the world's depth-test starts fresh; the
      // sky's color stays in the color buffer where the world doesn't
      // overpaint it.
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, activeCam);
      renderer.autoClear = prevAutoClear;
    } else {
      // No sky pass this frame (indoor or pre-construction). Normal
      // autoClear-true render clears color+depth as usual.
      renderer.render(scene, activeCam);
    }
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
    // Phase X.1 — resolved quality preset. `{ preset, flags, source }`.
    // Each visual-fidelity phase reads its gate from `quality.flags.<flag>`.
    quality,
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
    // Workstream Sky-C — dynamic sky lighting / fog controller, wired
    // below after liveScene3d is constructed so its `liveScene3dRef`
    // points at the final object (the controller publishes
    // `skyBackgroundColor` onto it for Sky-D's sky-dome to consume).
    // Null when THREE.DirectionalLight + THREE.AmbientLight aren't
    // available (i.e. when setupSceneLighting was skipped).
    skyLightingController: null,
    // Workstream Sky-C — `skyBackgroundColor` sink for Sky-D's dome.
    // ARGB u32 (0xAARRGGBB). Initialised to the Sky-C fallback fog
    // colour and updated each tick once the wasm SkyState lands.
    skyBackgroundColor: 0xff9cb3d9,
    // Workstream Sky-D — sky-dome + celestial body renderer. Null
    // when THREE / scene aren't available; instantiated below after
    // liveScene3d is constructed so the lazy `liveScene3dRef`
    // captures the final object (Sky-D reads `skyBackgroundColor`
    // and `skyLightingController._lastState.ambColorArgb` through
    // this ref).
    skyDome: null,
    // Workstream Sky-E — resolved SkyObject bakes (Map<id, bake>).
    // Populated by `resolveSkyAssets` kicked off below once Sky-B's
    // populateSkyDescFromRegion lands. Sky-D reads through this when
    // populating celestial bodies.
    skyAssets: null,
    // Task D (ambient-sounds-chain, 2026-05-12) — per-tick ambient
    // roller. Constructed below; `null` here so capture scripts can
    // sanity-check `liveScene3d.ambientRuntime` exists as a field
    // before the construction block runs.
    ambientRuntime: null,
    // Stop hook — future phases use this for renderer hot-swap.
    stop() { running = false; },
    loadEnvCellsForLandblock(landblockId) {
      return buildEnvCellsForLandblock(this, landblockId, this.wasmExports);
    },
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

  // Workstream Sky-C — instantiate the dynamic sky-lighting controller.
  // Takes over the existing Phase 7.6 sun + ambient handles + assigns
  // `scene.fog`. The per-tick path in `loop.js` calls
  // `skyLightingController.tick(dt)` AFTER `tickLightingForCellState`
  // so Phase 7.6's indoor-toggle (sun.visible flip) lands before
  // Sky-C's color / position override — composes cleanly because
  // Sky-C writes only color/intensity/position, never .visible.
  //
  // Session-handle accessor: lazy via `() => window.__sessionHandle ??
  // sessionHandle`. The login form sets `window.__sessionHandle` after
  // SelectCharacter completes; the init3D-time `sessionHandle`
  // argument is typically null when init3D fires (same pattern as
  // CameraSwitcher). The lazy accessor means the controller starts
  // returning real SkyState the moment populateSkyDescFromRegion
  // resolves (post-EnteredWorld), without the controller needing a
  // post-hoc update path.
  if (lighting && lighting.sun && lighting.ambient) {
    try {
      const skyLightingController = new SkyLightingController({
        scene,
        sun: lighting.sun,
        ambient: lighting.ambient,
        sessionHandleAccessor: () =>
          // eslint-disable-next-line no-undef
          (typeof window !== "undefined" ? window.__sessionHandle : null) ??
          sessionHandle ??
          null,
        liveScene3dRef: liveScene3d,
      });
      liveScene3d.skyLightingController = skyLightingController;
      // eslint-disable-next-line no-console
      console.log(
        "[sky-c] SkyLightingController attached; skyBackgroundColor sink " +
          "= window.liveScene3d.skyBackgroundColor"
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[sky-c] SkyLightingController init failed:", e);
    }
  }

  // Workstream Sky-D — sky dome geometry + celestial body rendering.
  // Instantiated synchronously here; celestial bodies are populated
  // lazily by an async resolveSkyAssets call below once Sky-B's
  // populateSkyDescFromRegion lands. Pre-population the dome reads as
  // a fallback-color gradient; bullet 11 (sky_dome group present)
  // passes immediately, bullet 12 (celestial children present)
  // passes after the async populate completes.
  //
  // Session-handle accessor: lazy via `() => window.__sessionHandle
  // ?? sessionHandle`. Same lazy pattern as SkyLightingController —
  // the init3D `sessionHandle` arg is null at construction; the real
  // handle lands on window post-SelectCharacter.
  try {
    const skyDome = new SkyDome({
      scene,
      sessionHandleAccessor: () =>
        // eslint-disable-next-line no-undef
        (typeof window !== "undefined" ? window.__sessionHandle : null) ??
        sessionHandle ??
        null,
      liveScene3dRef: liveScene3d,
      // Sky-J P5: hand wasmExports to SkyDome for the PhysicsScript
      // chain walker (fetchPhysicsScript / fetchParticleEmitter /
      // fetchBuildingPlacement). When null/missing, the chain walker
      // no-ops and 0x02 SetupModel skyobjects render as nothing (same
      // as pre-P5 behavior).
      wasmExports: wasmExports || null,
    });
    liveScene3d.skyDome = skyDome;
    // eslint-disable-next-line no-console
    console.log(
      "[sky-d] SkyDome attached; horizon←skyBackgroundColor, " +
        "zenith←skyLightingController._lastState.ambColorArgb"
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[sky-d] SkyDome init failed:", e);
  }

  // H3 (2026-05-12): AudioManager. AudioContext creation is deferred
  // to the first user gesture (browser autoplay policy); we hook
  // window-level pointerdown/keydown to call notifyUserGesture once.
  // play() is a no-op until then. Per-tick listener sync happens in
  // the rAF tick below.
  let audioManager = null;
  if (wasmExports && typeof wasmExports.fetchWave === "function") {
    try {
      audioManager = new AudioManager({
        fetchWave: (did) => wasmExports.fetchWave(did),
        masterGain: 1.0,
      });
      liveScene3d.audioManager = audioManager;
      // Also stash on scene3dForBuilders so subsystems constructed
      // earlier (e.g. EntityManager) can read it lazily via
      // `this.scene3d.audioManager` once it lands.
      scene3dForBuilders.audioManager = audioManager;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined") {
        const gestureHandler = () => {
          audioManager.notifyUserGesture();
          window.removeEventListener("pointerdown", gestureHandler);
          window.removeEventListener("keydown", gestureHandler);
        };
        window.addEventListener("pointerdown", gestureHandler);
        window.addEventListener("keydown", gestureHandler);
        // Console test hook — `window.__playWave(0x0A000002)` plays a
        // sound at the camera's current position. Useful for verifying
        // the audio path lit up before any hook integration lands.
        window.__playWave = (did, x, y, z) => {
          const pos = { x: x ?? 0, y: y ?? 0, z: z ?? 0 };
          return audioManager.play(did >>> 0, pos);
        };
        // Task B (ambient-sounds-chain): console test hook for
        // SoundTable resolution. `await window.__fetchSoundTable(0x20000081)`
        // returns a SoundTableJs whose `entriesForSound(0x46)` resolves
        // Sound.Ambient1 → Wave-DID rows. Useful for ear-checking the
        // Region-attached ambient STB chain before Task C's cache /
        // Task D's roller / Task E's entity hooks land.
        if (typeof wasmExports.fetchSoundTable === "function") {
          window.__fetchSoundTable = (did) =>
            wasmExports.fetchSoundTable(did >>> 0);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        "[H3/audio] AudioManager attached; waiting for first user " +
          "gesture to unlock the AudioContext"
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[H3/audio] AudioManager init failed:", e);
    }
  }

  // Task C (ambient-sounds-chain, 2026-05-12) — SoundTableCache.
  // Sits alongside AudioManager and shares the same wasm-exports gate.
  // Tasks D/E/F will read this via liveScene3d.soundTableCache (or
  // scene3dForBuilders.soundTableCache for subsystems built earlier).
  let soundTableCache = null;
  if (wasmExports && typeof wasmExports.fetchSoundTable === "function") {
    try {
      soundTableCache = new SoundTableCache({
        fetchSoundTable: (did) => wasmExports.fetchSoundTable(did),
      });
      liveScene3d.soundTableCache = soundTableCache;
      scene3dForBuilders.soundTableCache = soundTableCache;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined") {
        // Capture-script hook — mirrors `window.__playWave` /
        // `window.__fetchSoundTable`. Playwright captures inspect
        // cache state via `await window.__soundTableCache.get(did)`,
        // `window.__soundTableCache.stats()`, etc.
        window.__soundTableCache = soundTableCache;
      }
      // eslint-disable-next-line no-console
      console.log(
        "[H3/sound-cache] SoundTableCache attached; ready for Task D " +
          "ambient roller + Task E animation hooks"
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[H3/sound-cache] SoundTableCache init failed:", e);
    }
  }

  // Task D (ambient-sounds-chain, 2026-05-12) — AmbientRuntime.
  // Drives per-tick Region-attached ambient sound playback. Needs:
  //
  //   - SoundTableCache (Task C) for resolving (stb_id, sType) → Wave.
  //   - AudioManager (H3-D) for playing the resolved Wave.
  //   - fetchRegion wasm export for the Region 0x13000000 → terrain
  //     → STB chain.
  //
  // The Region is fetched lazily on the first AmbientRuntime tick
  // (`getRegion` returns a Promise the runtime awaits once). Until
  // it resolves, ticks no-op via `skippedNoRegion`. Same fail-soft
  // pattern as SoundTableCache: if any of the prerequisites are
  // missing, the runtime simply isn't constructed and `tick(dt)` is
  // never called.
  let ambientRuntime = null;
  let _regionFetchPromise = null;
  if (
    audioManager &&
    soundTableCache &&
    wasmExports &&
    typeof wasmExports.fetchRegion === "function"
  ) {
    try {
      ambientRuntime = new AmbientRuntime({
        soundTableCache,
        audioManager,
        getPlayerPos: () => {
          // Mirror the cameraSwitcher's resolver — prefer the
          // EntityManager local-player rig (kind=1 spawn lands it),
          // fall back to null pre-spawn.
          const p = entityManager.getLocalPlayerWorldPos?.();
          return p || null;
        },
        getRegion: () => {
          // Lazy fetch of Region 0x13000000. Cache the in-flight
          // Promise so subsequent ticks don't refire the fetch while
          // the first attempt is still pending.
          if (!_regionFetchPromise) {
            _regionFetchPromise = wasmExports
              .fetchRegion(0x13000000)
              .catch((e) => {
                // eslint-disable-next-line no-console
                console.warn(
                  "[task-d/ambient] fetchRegion(0x13000000) failed:",
                  e
                );
                // Reset so the runtime can retry on a future tick.
                _regionFetchPromise = null;
                return null;
              });
          }
          return _regionFetchPromise;
        },
        isCurrentCellIndoor: () => {
          // eslint-disable-next-line no-undef
          const handle =
            (typeof window !== "undefined" ? window.__sessionHandle : null) ??
            sessionHandle ??
            null;
          if (!handle || typeof handle.isCurrentCellIndoor !== "function") {
            return false;
          }
          try {
            return !!handle.isCurrentCellIndoor();
          } catch (_) {
            return false;
          }
        },
        // Terrain-mesh source: walk the scene3d terrainGroup. Each
        // child Mesh has `userData.terrainCodes` (Uint8Array, 81
        // entries, column-major) — see terrain.js for the stash and
        // adapter.js::buildVertexTypesDataTexture for the layout.
        getTerrainMeshes: () => terrainGroup.children,
      });
      liveScene3d.ambientRuntime = ambientRuntime;
      scene3dForBuilders.ambientRuntime = ambientRuntime;
      // eslint-disable-next-line no-undef
      if (typeof window !== "undefined") {
        window.__ambientRuntime = ambientRuntime;
      }
      // eslint-disable-next-line no-console
      console.log(
        "[task-d/ambient] AmbientRuntime attached; first tick fetches " +
          "Region 0x13000000 lazily"
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[task-d/ambient] AmbientRuntime init failed:", e);
    }
  } else if (audioManager && soundTableCache && wasmExports) {
    // eslint-disable-next-line no-console
    console.log(
      "[task-d/ambient] fetchRegion wasm export missing — " +
        "skipping AmbientRuntime construction"
    );
  }

  // Workstream Sky-E + Sky-D bridge — poll for `hasSkyDesc() === true`
  // (which fires when Sky-B's populateSkyDescFromRegion lands on
  // kind=7 EnteredWorld), then call `resolveSkyAssets` with the 7
  // SkyObject IDs from `getSkyObjectStates()` and pass the result to
  // `skyDome.populateCelestialBodies`. Idempotent: once skyAssets is
  // populated the poll exits. Bullet 12 (celestial bodies present
  // at dawn) auto-flips PASS the frame after this resolves.
  if (
    wasmExports &&
    typeof wasmExports.fetchBuildingPlacement === "function" &&
    typeof wasmExports.fetch_surfaces_pixels === "function"
  ) {
    let resolveAttempted = false;
    const skyAssetPollHandle = setInterval(async () => {
      if (resolveAttempted) {
        clearInterval(skyAssetPollHandle);
        return;
      }
      // eslint-disable-next-line no-undef
      const handle =
        (typeof window !== "undefined" ? window.__sessionHandle : null) ??
        sessionHandle ??
        null;
      if (!handle || typeof handle.hasSkyDesc !== "function") {
        return;
      }
      let ready = false;
      try {
        ready = !!handle.hasSkyDesc();
      } catch (_) {
        return;
      }
      if (!ready) return;
      resolveAttempted = true;
      clearInterval(skyAssetPollHandle);
      try {
        const states = handle.getSkyObjectStates();
        const ids = [];
        for (let i = 0; i < states.length; i += 1) {
          ids.push(states[i].gfxObjectId >>> 0);
        }
        // Workstream Sky-G: also pre-resolve every gfx_obj_id
        // referenced by SkyObjectReplace entries across ALL DayGroups
        // (not just the active one) so mesh swaps at keyframe
        // boundaries are zero-network. In retail Dereth every
        // replace.gfx_obj_id is 0x00000000 — `getSkyOverrideObjectIds`
        // returns the union of SkyObject.default_gfx_object_id and any
        // non-zero replace.gfx_obj_id, which collapses to just the
        // defaults; for custom regions with real overrides the resolver
        // bakes those too.
        if (typeof handle.getSkyOverrideObjectIds === "function") {
          try {
            const overrideIds = handle.getSkyOverrideObjectIds();
            if (overrideIds && typeof overrideIds.length === "number") {
              for (let i = 0; i < overrideIds.length; i += 1) {
                const id = overrideIds[i] >>> 0;
                if (id !== 0 && !ids.includes(id)) ids.push(id);
              }
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[sky-g] getSkyOverrideObjectIds threw:", e);
          }
        }
        const summary = await resolveSkyAssets(
          scene3dForBuilders,
          ids,
          wasmExports
        );
        liveScene3d.skyAssets = scene3dForBuilders.skyAssets;
        // eslint-disable-next-line no-console
        console.log(
          `[sky-d] resolveSkyAssets summary: resolved=${summary.resolved} ` +
            `failed=${summary.failed} surfaces=${summary.uniqueSurfaceCount} ` +
            `setupModels=${summary.setupModelCount} tris=${summary.totalTriangles}`
        );
        if (liveScene3d.skyDome && scene3dForBuilders.skyAssets) {
          const added = liveScene3d.skyDome.populateCelestialBodies(
            scene3dForBuilders.skyAssets,
            scene3dForBuilders.materialCache
          );
          // eslint-disable-next-line no-console
          console.log(
            `[sky-d] populateCelestialBodies → ${added} bodies on scene root`
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[sky-d] resolveSkyAssets / populateCelestialBodies failed:", e);
      }
    }, 250);
  }

  // Phase 7.4b — install the shared-drain hook last so the
  // window-level hook references the final EntityManager instance.
  // The 2D drainEvents at index.html:5723 can call
  // window.__scene3dEntityHook(upd) for each EntityUpdate to forward
  // it into the 3D path.
  installSharedDrainHook(liveScene3d);
  return liveScene3d;
}
