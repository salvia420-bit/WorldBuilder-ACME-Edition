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
// World-expand step 1 Objective 8 — `bakeXRing` are imported here +
// called at radius=6 below; `bakeXForLandblock` are exposed via
// `liveScene3d.loadXForLandblock` (Objective 5) and used by the lazy
// LB-entry hook (Objective 6). The radius=1 back-compat wrappers
// (`buildHoltburgX`) are NOT imported here any longer — they remain
// exported from their source files for the Phase 7.1 + visual-fidelity
// wave 1-6 captures that still call them directly.
import {
  bakeTerrainForLandblock,
  bakeTerrainRing,
} from "./terrain.js";
import {
  bakeBuildingsForLandblock,
  bakeBuildingsRing,
} from "./buildings.js";
import {
  bakeStaticsForLandblock,
  bakeStaticsRing,
} from "./statics.js";
import { buildEnvCellsForLandblock } from "./cells.js";
// Phase D.1 — synthetic ACE entity-spawn injector. The third
// placement stream (after `fetch_landblock_objects` DAT-explicit and
// `fetch_landblock_scenery` DAT-baked). See `scene3d/spawns.js`'s
// header for the dispatch-surface contract.
import { ensureSpawnsForLandblock } from "./spawns.js";
import { tickPerFrame, installSharedDrainHook } from "./loop.js";
import { EntityManager } from "./entities.js";
import { CameraSwitcher, createOrthoCamera } from "./camera.js";
import { setupSceneLighting, attachSetupModelLights } from "./lighting.js";
import { SkyLightingController } from "./sky_lighting.js";
import { SkyDome } from "./sky_dome.js";
import { CloudOverlay } from "./cloud_overlay.js";
import { resolveSkyAssets } from "./sky_assets.js";
import {
  acToThree,
  loadDetailTileCache,
  loadTerrainDetailNormalArray,
} from "./adapter.js";
import { createNameplateOverlay } from "./hud.js";
import { AudioManager } from "./audio/audio_manager.js";
import { SoundTableCache } from "./audio/sound_table_cache.js";
import { AmbientRuntime } from "./audio/ambient_runtime.js";
import { getQuality, installQualityOnWindow } from "./quality.js";
import { createSsaoPipeline } from "./postprocess.js";

const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;
// World-expand step 1 Objective 8 (2026-05-14) — initial ring radius
// around Holtburg flipped from 1 (3×3 = 9 LBs) to 6 (13×13 = 169 LBs).
// Per `docs/world-expand-step-1-handoff.md` §Intent / §Objective 8 the
// new ring covers ~2.5 km × 2.5 km of Aluvian Heartlands (Holtburg in
// the centre plus 168 surrounding LBs — 51 populated, 118 wilderness
// per the WorldBuilder.Terminal oracle at
// `/mnt/wbterminal1/tmp/claude-scratch/world-expand/ring_13x13_inventory.jsonl`).
//
// init-time impact: terrain bake ~6× slower at radius=6 vs radius=1
// (oracle reports 169/9 ≈ 19× more LBs but 118 are empty so buildings/
// statics are sub-linear); cold-fetch through manifest+shards adds
// ~5-15 s of HTTP fetches for non-boot LBs. Total init jumps from ~3 s
// to ~10-30 s (per brief, acceptable). Phase 6's lazy LB-entry pipeline
// + Objective 6's per-LB hooks keep the walk-out path efficient (LBs
// past the initial ring still lazy-load on player movement).
//
// The `buildHoltburgX` exports in terrain.js / buildings.js /
// statics.js remain radius=1 back-compat wrappers for the existing
// Phase 7.1 capture + visual-fidelity wave 1-6 captures. Objective 8
// flips ONLY the init3D call site; per-capture follow-ons are
// out-of-scope (radius=1-hardcoded assertions move forward in their
// own PR via Objective 10's `capture_world_expand_e2e.cjs`).
const HOLTBURG_RING_RADIUS = 6;

export async function init3D(canvas, sessionHandle, wasmExports) {
  // Phase X.1 — resolve the visual-fidelity quality preset from URL +
  // UA before any subsystem inits. Stored on `liveScene3d.quality` so
  // each later phase (POM, SSAO, CSM, terrain subdiv, hero assets)
  // can gate off the same single source of truth. This phase does
  // not gate any feature itself — every gate lives in its own phase.
  // Devtools: `window.__quality` mirrors the resolved object.
  const quality = installQualityOnWindow(getQuality());
  // Force-disable SSAO when `?clouds=on`. The SSAO composer path
  // composites the cloud overlay AFTER its OutputPass → clouds paint
  // over world geometry. Until the cloud effect is plumbed inside
  // the SSAO composer chain (Clouds-G work), the direct render path
  // is the only depth-correct option for clouds. Everything else in
  // the quality preset (shadows, CSM, POM, triplanar, etc.) stays on.
  try {
    // eslint-disable-next-line no-undef
    const params = new URLSearchParams(window.location.search);
    const cloudsFlag = params.get("clouds");
    // Sky-K.6 — atmosphere defaults ON. `?atmosphere=off` opts back to
    // the parametric path (kept around for retail-comparison captures
    // until the legacy files are deleted in a follow-on cleanup).
    const atmosphereFlag = params.get("atmosphere");
    const atmosphereOn = atmosphereFlag !== "off";
    if (cloudsFlag === "on" && quality?.flags?.ssao) {
      quality.flags.ssao = false;
      // eslint-disable-next-line no-console
      console.log("[clouds] SSAO auto-disabled (?clouds=on requires direct render path for depth-correct cloud occlusion)");
    }
    if (atmosphereOn && quality?.flags?.ssao) {
      quality.flags.ssao = false;
      // eslint-disable-next-line no-console
      console.log("[sky-k] SSAO auto-disabled (atmosphere mode uses its own EffectComposer chain)");
    }
  } catch (_) { /* noop */ }
  // eslint-disable-next-line no-console
  console.log(
    `[phase-x.1] quality preset=${quality.preset} source=${quality.source}`
  );

  // Phase F.C — runtime event log probe. Opt-in via `?eventLog=on` so
  // production users don't pay the cost; the F.D validator flips the
  // flag during its capture. When enabled, each audio/particle call
  // site appends an `EventRecord` (see docs/event-completeness-method.md).
  // Ring buffer at EVENT_LOG_CAP records; overflow count tracked
  // separately so the validator can detect a busy session that lost
  // history. `_pushEventRecord` is the shared push helper — wired
  // through `scene3dForBuilders` + `liveScene3d` so subsystems
  // (AmbientRuntime, EntityManager, ParticleManager-callers, SkyDome,
  // GameMessageSound recv arm in index.html) can append uniformly.
  // When disabled, `_pushEventRecord` is a no-op stub so the call-site
  // guard is just an unconditional function call.
  const EVENT_LOG_CAP = 50000;
  const eventLogEnabled = (() => {
    try {
      if (typeof window === "undefined" || !window.location?.search) return false;
      return new URLSearchParams(window.location.search).get("eventLog") === "on";
    } catch (_) {
      return false;
    }
  })();
  /** @type {Array<object>} */
  const eventLog = [];
  let eventLogOverflow = 0;
  // Ring-buffer write index; only used in cap-reached mode.
  let eventLogRingHead = 0;
  const pushEventRecord = eventLogEnabled
    ? (record) => {
        if (!record) return;
        if (eventLog.length < EVENT_LOG_CAP) {
          eventLog.push(record);
          return;
        }
        // Ring-buffer overwrite of oldest.
        eventLog[eventLogRingHead] = record;
        eventLogRingHead = (eventLogRingHead + 1) % EVENT_LOG_CAP;
        eventLogOverflow += 1;
      }
    : (_record) => {};
  if (eventLogEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      `[phase-f.c] eventLog probe ENABLED (cap=${EVENT_LOG_CAP}); ` +
        "validator can read via liveScene3d.snapshotEventLog()"
    );
  }

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

  // Visual-fidelity Phase 0.1 — opt-in shadow maps via `?shadows=on`.
  // Default OFF so existing capture flows and the baseline visual
  // unchanged. Phase X.1 (quality presets) will gate this on
  // `quality>=mid` instead of a one-off URL param.
  // `?shadows=off` is an explicit kill-switch for BOTH the Phase 0.1
  // single-shadow path AND the Phase 3.3 CSM path (the user-facing
  // override beats the preset gating).
  const shadowsParam = (() => {
    try {
      if (typeof window === "undefined" || !window.location?.search) return null;
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("shadows");
      if (raw === "on") return "on";
      if (raw === "off") return "off";
      return null;
    } catch (_) {
      return null;
    }
  })();
  const shadowsEnabled = shadowsParam === "on";
  // Visual-fidelity Phase 3.3 — Cascaded Shadow Maps. When
  // `quality.flags.csm` is true (high+ preset) AND `?shadows=off`
  // hasn't been passed, CSM picks up. CSM and Phase 0.1's single-
  // shadow path are mutually exclusive — `setupSceneLighting` forces
  // the sun's `castShadow` off when CSM is active.
  // - quality=high + no shadows param      → CSM on, Phase 0.1 off
  // - quality=high + ?shadows=on           → CSM on (no conflict —
  //     Phase 0.1's `shadowsEnabled` is ignored when csmEnabled=true)
  // - quality=high + ?shadows=off          → BOTH off
  // - quality=mid  + ?shadows=on           → Phase 0.1 on, CSM off
  // - quality=mid  + no shadows param      → BOTH off (preserves the
  //     pre-Phase-3.3 default)
  const csmEnabled = !!quality?.flags?.csm && shadowsParam !== "off";
  if (shadowsEnabled || csmEnabled) {
    renderer.shadowMap.enabled = true;
    // Plan doc requested `PCFSoftShadowMap`, but three.js r184 (the
    // version pinned in importmap at index.html:509) deprecated it
    // and falls back to `PCFShadowMap` with a one-shot console warn
    // the first frame the renderer renders shadows. Setting
    // `PCFShadowMap` directly silences the warn and keeps the
    // shipped output identical (the runtime falls back regardless).
    // If three.js re-introduces a proper soft-shadow filter (`VSMShadowMap`
    // or `PCFShadowMap.softness > 0`), we can swap here.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // eslint-disable-next-line no-console
    console.log(
      `[visfid] shadow path: ${csmEnabled ? "CSM (Phase 3.3)" : "single-shadow (Phase 0.1)"}`
    );
  }

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
  const lighting = setupSceneLighting(scene, {
    sceneSize: 600,
    // Visual-fidelity Phase 0.1 — opt in to shadow casting on the
    // sun when `?shadows=on`. Caller is responsible for flipping
    // `renderer.shadowMap.enabled` (done above) and tagging meshes
    // with `castShadow` / `receiveShadow` (per buildings.js,
    // statics.js, terrain.js, etc.).
    castShadow: shadowsEnabled,
    // Visual-fidelity Phase 3.3 — when CSM is enabled, the sun's own
    // shadow is OFF and three cascade shadow-only DirectionalLights are
    // constructed inside `setupCsm`. Mutually exclusive with the Phase
    // 0.1 single-shadow path; the resolved gating
    // (csm > Phase-0.1 > off) lives above.
    csm: csmEnabled,
  });
  const { sun, ambient, lightsGroup } = lighting;
  // Visual-fidelity Phase 3.3 — surface the csm bundle for builders +
  // capture scripts. Materials produced by `MaterialCache` will install
  // the shader patch when this is non-null (gated by Phase 0.1's
  // shadowsEnabled vs csmEnabled split).
  const csmState = lighting.csmState ?? null;

  // Camera — perspective. Default framing for the Phase 7.0 hello-
  // world is back-and-up from the cube; Phase 7.1+ retargets it onto
  // the Holtburg LB centre after terrain is built.
  const camera = new THREE.PerspectiveCamera(60, cssW / cssH, 0.1, 5000);
  camera.position.set(15, 15, 15);
  camera.lookAt(0, 0, 5);

  // Visual-fidelity Phase 3.2 — SSAO pipeline (constructed below after
  // SkyDome is initialised so the sky pass can wire into the composer).
  // Forward-declared `let` so the resize handler below can null-check.
  let ssaoPipeline = null;
  const ssaoEnabled = !!quality?.flags?.ssao;
  // Sky-K.2 — atmosphere pipeline (constructed below after AtmosphereRuntime's
  // texture bake completes). Forward-declared like ssaoPipeline so the
  // resize handler + render loop can null-check.
  let atmospherePipeline = null;

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
      if (ssaoPipeline) ssaoPipeline.setSize(newW, newH);
      if (atmospherePipeline) atmospherePipeline.setSize(newW, newH);
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
  // Phase 0.2 — load the detail-tile cache once at scene init, before
  // any builder runs. The MaterialCache constructor reads it from
  // `scene3dForBuilders.detailTileCache` (via buildings.js / statics.js
  // / sky_assets.js / cells.js lazy `new MaterialCache(...)`). Gated on
  // `quality.flags.detailFlag` so the `low` preset doesn't pay the
  // ~150 KB asset cost. `?forceDetail=on` URL override applies the
  // composite to every textured material so the visual smoke can show
  // the effect on real Holtburg surfaces — retail portal.dat ships 0
  // Detail-flagged surfaces per the Phase 0.2 audit.
  const forceDetail = (() => {
    try {
      if (typeof window === "undefined" || !window.location?.search) return false;
      const params = new URLSearchParams(window.location.search);
      return params.get("forceDetail") === "on";
    } catch (_) {
      return false;
    }
  })();
  const detailEnabled = !!quality?.flags?.detailFlag || forceDetail;
  let detailTileCache = null;
  if (detailEnabled) {
    try {
      detailTileCache = await loadDetailTileCache();
      // eslint-disable-next-line no-console
      console.log(
        `[phase-0.2] detail tiles loaded: ${detailTileCache.size}/5 (forceDetail=${forceDetail})`
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase-0.2] detail tile load failed:", e);
    }
  }

  // Phase 1.2 — terrain detail-normal array. Gated on
  // `quality.flags.terrainDetailNormal` (mid/high/ultra by default, low
  // off). Loaded once, shared by every per-LB terrain ShaderMaterial.
  // When the load fails (offline / 404 / mock-canvas captures) the
  // shader sees `null` + uDetailNormalEnabled=0 and branches around
  // the sample — no degradation versus baseline.
  const terrainDetailNormalEnabled = !!quality?.flags?.terrainDetailNormal;
  let terrainDetailNormalArray = null;
  if (terrainDetailNormalEnabled) {
    try {
      const r = await loadTerrainDetailNormalArray();
      if (r) {
        terrainDetailNormalArray = r.texture;
        // eslint-disable-next-line no-console
        console.log(
          `[phase-1.2] terrain detail normal array loaded: ${r.keys.length} slices`
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[phase-1.2] terrain detail normal array unavailable; shader will run baseline"
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[phase-1.2] terrain detail normal load failed:", e);
    }
  }
  // Construct a stub scene3d shape early so the per-phase builders
  // can share state (`materialCache`, `buildingMap3d`).
  const scene3dForBuilders = {
    // Phase X.1 — resolved quality preset (`{ preset, flags, source }`)
    // mirrored onto every builder's scene3d arg so per-phase gates can
    // read `scene3d.quality.flags.<feature>` without re-parsing the URL.
    quality,
    // Phase 0.1 — `?shadows=on` URL toggle. Independent of `quality` for
    // now; follow-on collapses it into `quality.flags.shadows`.
    shadowsEnabled,
    // Phase 3.3 — Cascaded Shadow Maps bundle. Null when CSM is gated
    // off (low/mid quality OR `?shadows=off` explicit). Builders pick
    // this up via `new MaterialCache({ csmState })` so receivers get
    // the cascade-sample shader patch automatically.
    csmEnabled,
    csmState,
    // Phase 0.2 — detail tile cache (Map<key, THREE.Texture>) +
    // forceDetail override. Each MaterialCache instance reads these
    // from scene3d at construction.
    detailTileCache,
    forceDetail,
    // Visual-fidelity Phase 3.1 — POM gate, sourced from
    // `quality.flags.pom` (high/ultra). Each MaterialCache reads this
    // and installs the parallax shader patch on Stone/Brick/Tile
    // surfaces. `?forcePom=on` URL override bypasses the category gate
    // for visual smoke testing on real Holtburg surfaces.
    pomEnabled: !!quality?.flags?.pom,
    forcePom: (() => {
      try {
        if (typeof window === "undefined" || !window.location?.search) return false;
        const params = new URLSearchParams(window.location.search);
        return params.get("forcePom") === "on";
      } catch (_) {
        return false;
      }
    })(),
    // Phase 1.2 — terrain detail-normal array (DataArrayTexture,
    // depth=5). Null when `quality.flags.terrainDetailNormal` is off
    // OR the load failed. The terrain ShaderMaterial reads this off
    // scene3d directly in `buildHoltburgTerrain`.
    terrainDetailNormalArray,
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
    // Phase F.C — runtime event log probe. Shared push helper +
    // gating flag exposed on scene3dForBuilders so subsystems built
    // BEFORE liveScene3d exists (EntityManager) can append uniformly.
    // Aliased onto liveScene3d below; the function identity is shared
    // so both refs point at the same closure over `eventLog`.
    eventLogEnabled,
    _pushEventRecord: pushEventRecord,
  };
  // World-expand step 1 Objective 8 (2026-05-14) — record the ring's
  // centre + spawn LB on scene3d so Objective 7's
  // `pickSubdivLevelForLb` can compute Chebyshev distance correctly at
  // bake time. `initialCentreLbKey` is the ring centre (Holtburg);
  // `playerLbKey` starts equal to it (spawn = centre) and is updated
  // by Objective 6's `handlePositionUpdate` lazy hook as the player
  // walks. Both are packed `((lbX << 24) | (lbY << 16)) >>> 0` per
  // the docs/world-expand-step-1-handoff.md §Sketch — distance-keyed
  // LOD shape.
  scene3dForBuilders.initialCentreLbKey =
    ((HOLTBURG_X << 24) | (HOLTBURG_Y << 16)) >>> 0;
  scene3dForBuilders.playerLbKey = scene3dForBuilders.initialCentreLbKey;
  if (
    wasmExports &&
    typeof wasmExports.fetch_landblock_heightmaps === "function" &&
    typeof wasmExports.fetch_terrain_textures === "function"
  ) {
    try {
      // World-expand step 1 Objective 8 — flip the initial ring from
      // radius=1 (3×3, 9 LBs) to radius=6 (13×13, 169 LBs) by calling
      // `bakeTerrainRing` directly instead of the radius=1 back-compat
      // wrapper `buildHoltburgTerrain`. Same call shape as the wrapper
      // forwards to, but with the explicit `HOLTBURG_RING_RADIUS`
      // constant (defined near `HOLTBURG_X` / `HOLTBURG_Y` above) so a
      // future radius bump is a one-line edit.
      terrainSummary = await bakeTerrainRing(
        scene3dForBuilders,
        HOLTBURG_X,
        HOLTBURG_Y,
        HOLTBURG_RING_RADIUS,
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
      console.error("[scene3d] bakeTerrainRing failed:", e);
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
      // World-expand step 1 Objective 8 — buildings ring flip 1 → 6.
      // Calling `bakeBuildingsRing` directly (skipping the radius=1
      // back-compat wrapper `buildHoltburgBuildings`) so the same
      // `HOLTBURG_RING_RADIUS` constant gates all three layers.
      buildingsSummary = await bakeBuildingsRing(
        scene3dForBuilders,
        HOLTBURG_X,
        HOLTBURG_Y,
        HOLTBURG_RING_RADIUS,
        wasmExports
      );
      // eslint-disable-next-line no-console
      console.log("[phase7.2] buildings:", buildingsSummary);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[scene3d] bakeBuildingsRing failed:", e);
    }
    if (typeof wasmExports.fetch_model_meshes === "function") {
      try {
        // World-expand step 1 Objective 8 — statics ring flip 1 → 6.
        // Calling `bakeStaticsRing` directly (skipping the radius=1
        // back-compat wrapper `buildHoltburgStatics`) so the same
        // `HOLTBURG_RING_RADIUS` constant gates all three layers.
        staticsSummary = await bakeStaticsRing(
          scene3dForBuilders,
          HOLTBURG_X,
          HOLTBURG_Y,
          HOLTBURG_RING_RADIUS,
          wasmExports
        );
        // eslint-disable-next-line no-console
        console.log("[phase7.2] statics:", staticsSummary);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[scene3d] bakeStaticsRing failed:", e);
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
    if (ssaoPipeline) ssaoPipeline.setSize(cw, ch);
    if (atmospherePipeline) atmospherePipeline.setSize(cw, ch);
    // Clouds-D: keep the cloud effect's internal RTs in sync with the
    // canvas. The CloudsEffect resolution-scale machinery handles the
    // ratio internally.
    if (liveScene3d?.cloudOverlay) {
      liveScene3d.cloudOverlay.setSize(cw, ch);
    }
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
    // Phase 3.2: composer path (sky + world + SSAO + output) — taken
    // when `quality.flags.ssao === true` AND the pipeline constructed
    // successfully (constructed AFTER SkyDome init below). The composer
    // bundles sky-then-world in its own pass chain so the depth /
    // color-preserve gymnastics from the direct path live inside the
    // RenderPass `clear` / `clearDepth` flags, not here.
    if (liveScene3dRef?.ssaoPipeline) {
      try {
        liveScene3dRef.ssaoPipeline.preFrameSkySync(
          liveScene3dRef.skyDome,
          activeCam
        );
        // Clouds-D: the SSAO composer bypasses skyDome.renderSkyPass,
        // so the cloudOverlay's preRender/renderOverlay don't fire
        // automatically here. Drive them at the tick level instead.
        // Pre-bake runs BEFORE composer.render (writes to its own RTs,
        // doesn't touch the canvas). renderOverlay runs AFTER (composites
        // onto the final tone-mapped canvas).
        //
        // Depth limitation: in the SSAO path the overlay composites AFTER
        // OutputPass, so clouds appear OVER world geometry regardless of
        // depth. The direct path (no SSAO) does it right by rendering
        // clouds between sky + world passes. For the eye-test, use
        // `?renderer=3d&clouds=on` and turn SSAO off (default off via
        // quality flag) to see depth-correct occlusion.
        const cloudOverlay = liveScene3dRef?.cloudOverlay;
        const cloudActive =
          cloudOverlay &&
          !liveScene3dRef?.skyDome?._lastIsIndoor;
        if (cloudActive) {
          cloudOverlay.preRender(renderer);
        }
        liveScene3dRef.ssaoPipeline.render(activeCam);
        if (cloudActive) {
          cloudOverlay.renderOverlay(renderer);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!liveScene3dRef._ssaoRenderWarned) {
          liveScene3dRef._ssaoRenderWarned = true;
          console.warn("[phase-3.2] ssaoPipeline.render threw:", e);
        }
      }
      requestAnimationFrame(tick);
      return;
    }

    // Sky-K.2 path: atmosphere composer owns sky + world + AerialPerspective
    // + Dithering. Cloud overlay's pre/render hooks run AROUND composer.render
    // (same depth-unaware-cloud limitation as the SSAO path — addressed in
    // a follow-on cleanup).
    if (atmospherePipeline) {
      try {
        atmospherePipeline.preFrameSkySync(
          liveScene3dRef?.skyDome,
          activeCam
        );
        const cloudOverlay = liveScene3dRef?.cloudOverlay;
        const cloudActive =
          cloudOverlay &&
          !liveScene3dRef?.skyDome?._lastIsIndoor;
        if (cloudActive) {
          cloudOverlay.preRender(renderer);
        }
        atmospherePipeline.render(activeCam);
        if (cloudActive) {
          cloudOverlay.renderOverlay(renderer);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        if (!liveScene3dRef._atmRenderWarned) {
          liveScene3dRef._atmRenderWarned = true;
          console.warn("[sky-k.2] atmospherePipeline.render threw:", e);
        }
      }
      requestAnimationFrame(tick);
      return;
    }

    // Direct render path (SSAO off OR pipeline not yet constructed):
    // pre-Phase-3.2 behavior verbatim.
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
    // Phase 0.1 — `?shadows=on` URL toggle. See scene3dForBuilders comment.
    shadowsEnabled,
    // Phase 3.3 — Cascaded Shadow Maps. `csmState` is null when CSM
    // is gated off (low/mid quality OR `?shadows=off`). Capture scripts
    // probe `liveScene3d.csmState?.lights.length === 3` to confirm
    // 3-cascade setup.
    csmEnabled,
    csmState,
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
    // Phase 2.2 — terrain ShaderMaterial registry (one entry per LB).
    // `loop.js::tickPerFrame` iterates this each rAF and pushes the
    // shared `uTime` uniform for the water/lava displacement animation.
    // Surfaced on liveScene3d so capture scripts can probe per-LB
    // uniform state without walking `terrainGroup.children`.
    terrainMaterials: scene3dForBuilders.terrainMaterials ?? [],
    // Phase 7.2 — buildings + statics summaries (null when the Phase
    // 7.2 wasm exports aren't supplied).
    buildings: buildingsSummary,
    statics: staticsSummary,
    // Shared MaterialCache (built lazily by buildings + statics).
    materialCache: scene3dForBuilders.materialCache ?? null,
    // Phase 0.2 — detail tile cache + forceDetail flag, surfaced on
    // liveScene3d so capture scripts can introspect tile-load state.
    detailTileCache: scene3dForBuilders.detailTileCache ?? null,
    forceDetail: !!scene3dForBuilders.forceDetail,
    // Phase 1.2 — terrain detail-normal array (DataArrayTexture, depth=5).
    // Surfaced on liveScene3d so capture scripts can verify load + slice
    // count + the per-LB material has the wired uniform.
    terrainDetailNormalArray:
      scene3dForBuilders.terrainDetailNormalArray ?? null,
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
    // World-expand step 1 follow-on (2026-05-14): alias the per-LB
    // baker idempotency Sets + once-per-ring opts bags from the build
    // stub onto the live object so `liveScene3d.loadTerrainForLandblock`
    // / `loadBuildingsForLandblock` / `loadStaticsForLandblock` can
    // read both (Set membership for short-circuit, opts for the wasm-
    // export wiring). Objective 10's capture (commit 81482de) surfaced
    // that without the aliasing `this.terrainOpts` was undefined inside
    // the load* hooks → bakeTerrainForLandblock threw. Mirrors the
    // existing cellContainers3d/envCellLoadedLbs aliasing pattern above.
    terrainBakedLbs: scene3dForBuilders.terrainBakedLbs,
    buildingsBakedLbs: scene3dForBuilders.buildingsBakedLbs,
    staticsBakedLbs: scene3dForBuilders.staticsBakedLbs,
    terrainOpts: scene3dForBuilders.terrainOpts,
    buildingsOpts: scene3dForBuilders.buildingsOpts,
    staticsOpts: scene3dForBuilders.staticsOpts,
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
    // Clouds-D — volumetric cloud overlay (opt-in via ?clouds=on).
    // Owns the takram CloudsEffect + fullscreen composite quad.
    // null unless the URL flag is set; see CloudOverlay construction
    // block after SkyDome init below.
    cloudOverlay: null,
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
    // Phase F.C — runtime event log probe. The validator in F.D
    // reads via `snapshotEventLog()`. When `?eventLog=on` is absent,
    // `eventLogEnabled` is false and `_pushEventRecord` is a no-op
    // (every wire-in point still calls it; the if-guard is cheap).
    // Cap defends a long session from unbounded memory growth — once
    // EVENT_LOG_CAP records are present, the buffer ring-overwrites
    // and bumps `eventLogOverflow` so the validator knows history was
    // truncated.
    eventLogEnabled,
    eventLog,
    get eventLogOverflow() { return eventLogOverflow; },
    snapshotEventLog() {
      // Defensive copy so the validator can iterate without races
      // against ongoing rAF appends. Records themselves are plain
      // POJOs (no wasm-bindgen handles); JSON-stringifiable.
      return {
        records: eventLog.slice(),
        overflow: eventLogOverflow,
        capped_at: EVENT_LOG_CAP,
      };
    },
    _pushEventRecord: pushEventRecord,
    // Stop hook — future phases use this for renderer hot-swap.
    stop() { running = false; },
    loadEnvCellsForLandblock(landblockId) {
      return buildEnvCellsForLandblock(this, landblockId, this.wasmExports);
    },
    // === World-expand step 1 — Objective 5 — per-LB lazy 3D loaders ===
    // Sibling hooks to `loadEnvCellsForLandblock` for the three other
    // 3D layers (terrain / buildings / statics). The Objective 6 lazy
    // `handlePositionUpdate` hook in `index.html` reads these three
    // symbols off `window.liveScene3d` and fires them when the player
    // crosses an LB boundary. Each delegates to the same per-LB baker
    // the ring driver uses, so the lazy-walk path and the initial-bake
    // path share the same code-path (matching the cells.js pattern).
    //
    // Idempotency lives in the baker (`scene3d.{terrain,buildings,
    // statics}BakedLbs: Set<u32>`); a second call for an already-baked
    // LB short-circuits with `null` (mirrors `loadEnvCellsForLandblock`
    // which returns `idempotent:true` for already-loaded LBs).
    //
    // `this.{terrain,buildings,statics}Opts` is set by the
    // corresponding ring driver (`bakeTerrainRing`, `bakeBuildingsRing`,
    // `bakeStaticsRing`) on first call — see commits 7145f11 / 9ea1601
    // / 11eb8f6 (terrain stashes via `scene3d.terrainOpts = opts`;
    // buildings + statics stash via the small follow-ons in this same
    // commit). The lazy hook is fail-soft when the field is missing
    // (init3D failed early or wasm exports are absent) because the
    // bakers raise an explicit error if `opts` is required but unset.
    loadTerrainForLandblock(lbX, lbY) {
      return bakeTerrainForLandblock(
        this,
        lbX,
        lbY,
        this.terrainOpts,
        this.wasmExports
      );
    },
    loadBuildingsForLandblock(lbX, lbY) {
      return bakeBuildingsForLandblock(
        this,
        lbX,
        lbY,
        this.buildingsOpts,
        this.wasmExports
      );
    },
    loadStaticsForLandblock(lbX, lbY) {
      return bakeStaticsForLandblock(
        this,
        lbX,
        lbY,
        this.staticsOpts,
        this.wasmExports
      );
    },
    // === Phase D.1 — per-LB lazy ACE spawn injector ===
    // Third placement stream (per `docs/hypotheticalmethod.md`'s
    // three-stream merge contract). Fetches pre-staged JSONL from
    // `/dist/spawns/<lb_hex>.spawns.jsonl` via `fetch_landblock_spawns`,
    // resolves each record's wcid to a SetupModel DID via the staged
    // `wcid_to_setup.json` lookup, and replays each through
    // `window.__scene3dEntityHook` (the SAME entry point a live ACE
    // would use). Idempotent — re-firing for an already-injected LB
    // is a no-op. See `scene3d/spawns.js` for the full contract.
    //
    // Called by the lazy LB-entry hook in `index.html`
    // (`handlePositionUpdate`) sitting alongside loadTerrain /
    // loadBuildings / loadStatics. No ring-bake equivalent: ACE
    // spawns are intentionally lazy (the wire's KIND_SPAWN on a live
    // server arrives per-LB-radius, not in bulk at boot).
    loadSpawnsForLandblock(lbX, lbY) {
      return ensureSpawnsForLandblock(lbX, lbY, this, this.wasmExports);
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

    // Clouds-D — opt-in volumetric clouds via `?clouds=on`. Default
    // off so the existing parametric skybox is the baseline. When on,
    // construct a CloudOverlay that wraps `CloudsEffect` + the
    // fullscreen overlay scene, and hand it to SkyDome for per-frame
    // tick + render integration.
    //
    // Visible clouds need a real GPU — headless swiftshader silently
    // zero-bakes the 3D textures the cloud raymarch samples (see
    // project_holtburger_clouds_d_mini_done_2026-05-15). Plumbing is
    // testable in CI; visual output requires hardware.
    try {
      // eslint-disable-next-line no-undef
      const params = new URLSearchParams(window.location.search);
      const cloudsFlag = params.get("clouds");
      if (cloudsFlag === "on") {
        // Optional URL knobs for the eye-test on real GPU. Allow the
        // user to crank coverage / quality without reloading + opening
        // dev console.
        const coverageParam = parseFloat(params.get("cloudCoverage") ?? "");
        const qualityParam = params.get("cloudQuality"); // 'low'|'medium'|'high'|'ultra'

        const cloudOverlay = new CloudOverlay({
          camera,
          sessionHandleAccessor: () =>
            // eslint-disable-next-line no-undef
            (typeof window !== "undefined" ? window.__sessionHandle : null) ??
            sessionHandle ??
            null,
          // sceneAccessor lets the composer's RenderPass render the main
          // world scene each frame for its depth attachment, so the
          // cloud raymarch occludes correctly at terrain/buildings/
          // player. Without this, clouds paint over land + player.
          sceneAccessor: () => scene,
        });

        // Apply URL knobs post-construction so the CloudOverlay's
        // default-defaults are in place first.
        const effect = cloudOverlay.volume.effect;
        if (Number.isFinite(coverageParam)) {
          effect.clouds.coverage = Math.max(0, Math.min(1, coverageParam));
        }
        if (qualityParam && ["low", "medium", "high", "ultra"].includes(qualityParam)) {
          effect.qualityPreset = qualityParam;
        }

        skyDome.setCloudOverlay(cloudOverlay);
        liveScene3d.cloudOverlay = cloudOverlay;

        // Clouds-D follow-up: when volumetric clouds are on, the
        // retail parametric SkyObjects (cloud bands, moon mesh,
        // weather streaks) clash visually. Hide them by default;
        // opt back in with `?retroSky=on` for a "retro look".
        const retroSky = params.get("retroSky") === "on";
        skyDome.setParametricSkyObjectsVisible(retroSky);

        // Runtime ergonomics — let the user tweak from devtools without
        // re-navigating. Mirrors Sky-K's `__setSkyOpacity` pattern.
        // eslint-disable-next-line no-undef
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-undef
          window.__cloudOverlay = cloudOverlay;
          // eslint-disable-next-line no-undef
          window.__setCloudCoverage = (v) => {
            const c = Math.max(0, Math.min(1, +v));
            effect.clouds.coverage = c;
            return effect.clouds.coverage;
          };
          // eslint-disable-next-line no-undef
          window.__setCloudQuality = (p) => {
            if (["low", "medium", "high", "ultra"].includes(p)) {
              effect.qualityPreset = p;
              return p;
            }
            return null;
          };
        }

        // eslint-disable-next-line no-console
        console.log(
          "[clouds-d] CloudOverlay wired into SkyDome (?clouds=on). " +
            `coverage=${effect.clouds.coverage} qualityPreset=${effect.qualityPreset ?? "default"} ` +
            `retroSky=${retroSky}. ` +
            "Visible clouds require a real GPU — swiftshader output is uniform. " +
            "Live tweak: __setCloudCoverage(0..1), __setCloudQuality('low'|'medium'|'high'|'ultra'). " +
            "Parametric sky toggle: liveScene3d.skyDome.setParametricSkyObjectsVisible(true/false)."
        );
        // Heads-up if SSAO is on: in the SSAO composer path, my cloud
        // overlay composites AFTER OutputPass (depth-unaware), so
        // clouds appear OVER world geometry. For depth-correct
        // occlusion, add `?ssao=off` (default for `?quality=mid`).
        if (quality?.flags?.ssao) {
          // eslint-disable-next-line no-console
          console.warn(
            "[clouds-d] SSAO is on (quality=high/ultra). Cloud composite " +
              "is depth-UNAWARE on this path — clouds will appear over world " +
              "geometry regardless of depth. Add `?ssao=off` to the URL for " +
              "depth-correct clouds."
          );
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[clouds-d] CloudOverlay init failed:", e);
    }

    // Sky-K.1 + K.2 — opt-in atmosphere stack via `?atmosphere=on`.
    //
    // K.1: bake the Bruneton precomputed-scattering lookup tables.
    //      ~8s one-shot on a real GPU (per 2026-05-16 GTX 1070 smoke).
    //      `liveScene3d.atmosphereRuntime.ready` flips true when done.
    //      swiftshader silently zero-bakes 3D textures — validation
    //      requires real hardware.
    //
    // K.2: once the bake completes, stand up `atmospherePipeline` — a
    //      pmndrs EffectComposer wrapping sky pass + world pass +
    //      EffectPass(AerialPerspectiveEffect, DitheringEffect). The
    //      per-frame render loop below picks this up automatically
    //      once it's non-null; until then, the direct render path is
    //      used (no atmosphere; same look as `?atmosphere=off`).
    try {
      // Sky-K.6 — atmosphere defaults ON. `?atmosphere=off` opts out
      // (parametric sky path; kept until legacy files deleted in
      // follow-on cleanup).
      // eslint-disable-next-line no-undef
      const atmosphereFlag = new URLSearchParams(window.location.search).get("atmosphere");
      if (atmosphereFlag !== "off") {
        const { AtmosphereRuntime } = await import("./atmosphere_runtime.js");
        const atmosphereRuntime = new AtmosphereRuntime({ renderer });
        liveScene3d.atmosphereRuntime = atmosphereRuntime;
        // eslint-disable-next-line no-undef
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-undef
          window.__atmosphereRuntime = atmosphereRuntime;
        }
        atmosphereRuntime.whenReady().then(async () => {
          try {
            const { createAtmospherePipeline } = await import("./atmosphere_pipeline.js");
            atmospherePipeline = createAtmospherePipeline(renderer, scene, camera, {
              skyScene: skyDome?.skyScene,
              skyCamera: skyDome?.skyCamera,
              atmosphereRuntime,
            });
            liveScene3d.atmospherePipeline = atmospherePipeline;
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__atmospherePipeline = atmospherePipeline;
            }

            // Sky-K.3 — physical sun + sky probe lights driven by the
            // Bruneton lookups. Hands off from sky_lighting.js's
            // parametric writes via setAtmosphereMode(true). Tone
            // mapping (AGX) in the pipeline collapses the resulting
            // HDR back to displayable sRGB.
            const { AtmosphereLights } = await import("./atmosphere_lights.js");
            const atmosphereLights = new AtmosphereLights({
              scene,
              atmosphereRuntime,
            });
            liveScene3d.atmosphereLights = atmosphereLights;
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__atmosphereLights = atmosphereLights;
            }

            // Sky-K.4 — replace SkyDome's parametric dome with takram's
            // SkyMaterial + stars. Hides skyDome.skyCell + parametric
            // celestials; adds SkyMaterial quad + stars Points to the
            // SAME skyDome.skyScene so the existing sky RenderPass
            // wiring still works.
            if (skyDome?.skyScene) {
              const { AtmosphereSky } = await import("./atmosphere_sky.js");
              const atmosphereSky = new AtmosphereSky({
                skyScene: skyDome.skyScene,
                skyDome,
                atmosphereRuntime,
              });
              liveScene3d.atmosphereSky = atmosphereSky;
              // eslint-disable-next-line no-undef
              if (typeof window !== "undefined") {
                // eslint-disable-next-line no-undef
                window.__atmosphereSky = atmosphereSky;
              }
            }

            // Hand off lighting authority: parametric SkyLightingController
            // stops writing to THREE.DirectionalLight / AmbientLight /
            // Fog. We also zero the existing lights here in case they
            // had non-zero state from Phase 7.6 defaults pre-bake.
            const slc = liveScene3d.skyLightingController;
            if (slc && typeof slc.setAtmosphereMode === "function") {
              slc.setAtmosphereMode(true);
            }
            if (liveScene3d.lighting?.sun) {
              liveScene3d.lighting.sun.intensity = 0;
            }
            if (liveScene3d.lighting?.ambient) {
              liveScene3d.lighting.ambient.intensity = 0;
            }
            if (scene.fog) {
              scene.fog = null;
            }

            // Tone mapping: takram lights emit physical radiance in
            // W/m²/sr — orders of magnitude over the [0,1] display
            // range. NoToneMapping on the renderer (the composer's
            // ToneMappingEffect does it) + bumped exposure makes the
            // raw values land in AGX's input range.
            renderer.toneMapping = THREE.NoToneMapping;
            renderer.toneMappingExposure = 5;

            // Sky-K.6 follow-on — bind real Bruneton tables on the
            // cloud material. Replaces the 5 DayGroup uniforms with
            // proper scattering/transmittance/irradiance lookups so
            // clouds and atmosphere see the same physics model.
            if (liveScene3d.cloudOverlay?.volume?.attachAtmosphere) {
              const ok = liveScene3d.cloudOverlay.volume.attachAtmosphere(atmosphereRuntime);
              if (ok) {
                // eslint-disable-next-line no-console
                console.log("[sky-k.6] CloudVolume.attachAtmosphere wired Bruneton tables onto the cloud material.");
              }
            }

            // eslint-disable-next-line no-console
            console.log(
              `[sky-k.3] AtmosphereRuntime ready (bake ${atmosphereRuntime.bakeMs?.toFixed?.(1)}ms). ` +
                "AerialPerspective + ToneMapping(AGX) + Dithering composer wired. " +
                "SunDirectionalLight + SkyLightProbe added; parametric lights silenced. " +
                "toneMappingExposure=5 — tune via __setExposure(v)."
            );
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__setExposure = (v) => {
                renderer.toneMappingExposure = +v;
                return renderer.toneMappingExposure;
              };
            }
          } catch (e2) {
            // eslint-disable-next-line no-console
            console.warn("[sky-k.2/k.3] atmospherePipeline/lights init failed:", e2);
          }
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[sky-k.1] AtmosphereRuntime init failed:", e);
    }

    // Visual-fidelity Phase 3.2 — wire the SSAO composer NOW that
    // skyScene + skyCamera exist. Gated on `quality.flags.ssao`. The
    // pipeline brings the existing sky-then-world render order into
    // an `EffectComposer` (sky RenderPass → world RenderPass with
    // clear=false/clearDepth=true → SSAOPass → OutputPass) and the
    // per-frame `tick` swaps `composer.render()` in for the two
    // direct `renderer.render` call sites. When `ssao=false`, this
    // stays null and the render loop takes the original direct
    // path verbatim.
    if (ssaoEnabled) {
      try {
        ssaoPipeline = createSsaoPipeline(renderer, scene, camera, {
          skyScene: skyDome.skyScene,
          skyCamera: skyDome.skyCamera,
        });
        liveScene3d.ssaoPipeline = ssaoPipeline;
        // eslint-disable-next-line no-console
        console.log(
          `[phase-3.2] SSAO on: kernelRadius=${ssaoPipeline.ssaoPass.kernelRadius} ` +
            `kernelSize=${ssaoPipeline.ssaoPass.kernel?.length ?? "n/a"} ` +
            `minDistance=${ssaoPipeline.ssaoPass.minDistance} ` +
            `maxDistance=${ssaoPipeline.ssaoPass.maxDistance}`
        );
      } catch (ssaoErr) {
        // eslint-disable-next-line no-console
        console.warn("[phase-3.2] SSAO pipeline init failed:", ssaoErr);
        ssaoPipeline = null;
      }
    }
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
          // Phase F.C — log OneOff plays so the F.D capture can drive
          // the validator's synthetic sound injection through the same
          // log path as the genuine sources. No-op when probe is off.
          pushEventRecord({
            type: "sound",
            wave_did: (did >>> 0),
            parent_entity_guid: null,
            world_pos: [+pos.x, +pos.y, +pos.z],
            t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
            source: "OneOff",
            source_meta: { via: "window.__playWave" },
          });
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
        // Phase F.C — runtime event log probe. The runtime appends one
        // record per `audioManager.play` it fires (continuous + prob);
        // the F.D validator diffs against the F.B-baked manifest. The
        // helper is the same `pushEventRecord` closure shared by every
        // source — a no-op when `?eventLog=on` is absent.
        pushEventRecord,
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
