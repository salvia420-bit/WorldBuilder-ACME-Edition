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

// Sky-K post-RIC-shim (2026-05-16) — MUST be the first import. Installs
// a microtask-driven shim for `window.requestIdleCallback` before any
// downstream module evaluates @takram/three-atmosphere's shared bundle,
// which snapshots `window.requestIdleCallback` into a private const at
// module-load time. Without the shim, takram's PrecomputedTextures
// generator hangs in-game (the busy render loop never goes idle, so
// the snapshot's rIC never fires, so the bake never resolves).
// See scene3d/_ric_shim.js header for the full rationale.
import "./_ric_shim.js";
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
} from "./terrain.js?v=phase-d-batch";
import {
  bakeBuildingsForLandblock,
  bakeBuildingsRing,
} from "./buildings.js?v=phase-d-batch";
import {
  bakeStaticsForLandblock,
  bakeStaticsRing,
  getOrCreateMaterialCache,
} from "./statics.js?v=phase7-par";
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
import {
  acToThree,
  loadDetailTileCache,
  loadTerrainDetailNormalArray,
  setAdapterMaxAnisotropy,
  setAdapterTextureDownscale,
  setAtlasTilePx,
} from "./adapter.js";
import { createNameplateOverlay } from "./hud.js";
import { AudioManager } from "./audio/audio_manager.js";
import { SoundTableCache } from "./audio/sound_table_cache.js";
import { AmbientRuntime } from "./audio/ambient_runtime.js";
import { getQuality, installQualityOnWindow } from "./quality.js";
import { ACMoons } from "./ac_moons.js";

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
// 2026-05-21 — low-agentic-mode override. `?ringRadius=N` or
// `?agentic=low` (which sets ringRadius=1) shrinks the initial ring
// to drastically reduce phase7 wasm fetch time at boot. PVS-driven
// `tickPvsLoadExpansion` still pulls additional LBs as the player
// walks toward them, so functionality is preserved — just slower
// horizon-fill the first time the user moves.
const HOLTBURG_RING_RADIUS = (() => {
  try {
    if (typeof window === "undefined") return 6;
    const ps = new URLSearchParams(window.location.search);
    const raw = ps.get("ringRadius");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fallthrough */ }
  return 6;
})();
// Statics/scenery and buildings are the two heaviest per-LB content
// streams (placements + per-model setup/meshes/surface-pixels via
// F.41 batch). Decoupling their rings from the terrain ring lets us
// load a small neighborhood up-front, then PVS-driven expansion
// (in loop.js's `tickPvsLoadExpansion`) pulls additional LBs as they
// enter the renderer's visible cell set. Net: ~85 % fewer initial
// setup/surface fetches at boot for each (25/169 LBs) without
// leaving the visible scene empty.
// Bumped 2→6 on 2026-05-16 (post-B.5 + RIC-shim) so the visible
// horizon shows the full 13×13 ring of scenery placements (16,700
// trees / rocks / props across 169 LBs) and buildings up-front,
// instead of a sparse 5×5 with empty wilderness past ~480m. PVS
// expansion via loop.js::tickPvsLoadExpansion still pulls anything
// the player walks toward, but with radius=6 the initial bake covers
// the full visible horizon at Holtburg spawn — matching the world-
// completeness method's 13×13 oracle counts.
// 2026-05-21 — low-agentic-mode override. Mirrors HOLTBURG_RING_RADIUS
// above so all three streams (terrain + buildings + statics) shrink
// together. `?agentic=low` defaults to radius=1 (3×3 = 9 LBs) for the
// fastest possible cold boot; PVS expansion (`tickPvsLoadExpansion`)
// still pulls more as the player walks. Per-stream `?buildingsRadius=N`
// / `?staticsRadius=N` overrides win over agentic-mode default.
const STATICS_RING_RADIUS = (() => {
  try {
    if (typeof window === "undefined") return 6;
    const ps = new URLSearchParams(window.location.search);
    const raw = ps.get("staticsRadius");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fallthrough */ }
  return 6;
})();
const BUILDINGS_RING_RADIUS = (() => {
  try {
    if (typeof window === "undefined") return 6;
    const ps = new URLSearchParams(window.location.search);
    const raw = ps.get("buildingsRadius");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 6) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fallthrough */ }
  return 6;
})();

// 2026-05-21 cold-boot Phase G (eager-init) — session-independent
// scene3d bootstrap. Runs during page-init while the user is still
// reading the login form, so the renderer + atmosphere LUTs + detail
// tiles are warm by the time the post-Connect `init3D` opens.
//
// Cuts ~10s off the cold-boot gap between the 2nd Connect and phase7.2
// buildings by overlapping renderer + quality + detail-tile +
// atmosphere-LUT-load with the handshake + character-select round-trip.
//
// What lives here (session-independent):
//   - canvas sizing + WebGLRenderer (incl. pixelRatio + anisotropy)
//   - quality preset + URL flag parsing (shadows / forceDetail / etc.)
//   - shadow / CSM setup
//   - scene + worldRoot + group placeholders + hello-cube
//   - sceneLighting (sun + ambient + lightsGroup)
//   - PerspectiveCamera + resize listener + render-scale setter
//   - atmosphereRuntimePromise (LUT load — runs concurrent with the
//     post-Connect phase7 streaming once `init3D` resumes)
//   - detailTileCache + terrainDetailNormalArray (async asset loads
//     gated on quality flags)
//
// What stays in init3D (session/wasm-dependent):
//   - terrain/buildings/statics/envCells bake (needs wasmExports)
//   - entity manager + camera switcher (needs sessionHandle accessor)
//   - audio manager / sound table cache / ambient runtime (needs wasm)
//   - sky dome / cloud overlay / atmosphere lights+sky (touches the
//     init3D-scoped `liveScene3d`)
//
// The returned handle plugs back into `init3D(canvas, sessionHandle,
// wasmExports, preInitHandle)`. When preInitHandle is null/undefined
// `init3D` calls `preInit3D(canvas)` itself so the existing single-
// argument call sites (Phase 7.0 hello-cube capture, etc.) keep
// working unchanged.
export async function preInit3D(canvas) {
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
  // 2026-05-21 — agent mode (`?agent=1` / `?autoLogin=1`) strips all
  // page chrome, so the canvas fills the full viewport. The CSS rule
  // `html.agent-mode #canvas { width: 100% !important }` drives the
  // displayed size; we still set the backing store to the matching
  // pixel count so WebGL renders sharp.
  const _isAgentMode =
    typeof document !== "undefined" &&
    document.documentElement?.classList?.contains("agent-mode");
  const layoutChromeH = _isAgentMode ? 0 : 320;
  const layoutMarginW = _isAgentMode ? 0 : 32;
  const cssW = Math.min(window.innerWidth - layoutMarginW, _isAgentMode ? 4096 : 1920);
  const cssH = Math.min(window.innerHeight - layoutChromeH, _isAgentMode ? 2160 : 1080);
  if (!_isAgentMode) {
    // Normal mode: pin the canvas's CSS size explicitly so the layout
    // doesn't shift as content loads. In agent mode the CSS-rule
    // !important wins over inline style anyway, so skip it to keep
    // intent clear.
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  canvas.width = cssW;
  canvas.height = cssH;

  // Phase X.1 — resolve the visual-fidelity quality preset from URL +
  // UA before any subsystem inits. Stored on `liveScene3d.quality` so
  // each later phase (POM, CSM, terrain subdiv, hero assets)
  // can gate off the same single source of truth. This phase does
  // not gate any feature itself — every gate lives in its own phase.
  // Devtools: `window.__quality` mirrors the resolved object.
  const quality = installQualityOnWindow(getQuality());
  // eslint-disable-next-line no-console
  console.log(
    `[phase-x.1] quality preset=${quality.preset} source=${quality.source}`
  );

  // 2026-05-21 — wire-agent mode (?wireframe=1). Orthogonal to the
  // quality preset; when set, replaces all surface materials with
  // shared per-hash MeshBasicMaterial({wireframe:true}) and skips the
  // atmosphere/composer/clouds/skydome/CSM pipelines entirely. Designed
  // so software-WebGL (SwiftShader) can render the scene at usable
  // fps for cloud-scaled bot fleets while preserving wasm + protocol +
  // plugin + scene-graph code paths intact. Does NOT mutate the
  // quality preset — `?quality=ultra&wireframe=1` is valid and yields
  // wireframe-everything regardless of preset.
  const wireframeMode = (() => {
    try {
      if (typeof window === "undefined") return false;
      return new URLSearchParams(window.location.search).get("wireframe") === "1";
    } catch (_) { return false; }
  })();
  if (wireframeMode) {
    // eslint-disable-next-line no-console
    console.log("[wire-agent] ?wireframe=1 — skipping atmosphere/clouds/skydome/CSM, wireframe materials");
  }

  // A1 (perf plan 2026-05-18) — antialias is read from the quality
  // preset (with optional Graphics-tab override). MSAA costs ~25% of
  // frametime on weaker GPUs; off at `low`, on otherwise.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !!quality.flags.antialias,
  });
  // 2026-05-21 Phase F — explicitly enable EXT_float_blend so the GPU
  // stops emitting "Using format enabled by implicitly enabled extension"
  // warnings every frame the atmosphere LUTs are sampled.
  renderer.getContext().getExtension("EXT_float_blend");
  // 2026-05-21 Phase A/D follow-on — kick off the atmosphere LUT load
  // CONCURRENTLY with everything else. The post-Connect `init3D` arm
  // awaits the result of this promise; bake/load runs in parallel with
  // page-init + handshake + login + character-select instead of
  // sequentially after them.
  // Wire-agent: skip atmosphere entirely. Render falls back to direct
  // renderer.render at L1218 when atmospherePipeline stays null, which
  // is the path we want for the wireframe scene.
  const atmosphereRuntimePromise = wireframeMode
    ? Promise.resolve(null)
    : import("./atmosphere_runtime.js?v=lutbake").then(
        ({ AtmosphereRuntime }) => new AtmosphereRuntime({ renderer })
      );
  // Cap DPR at 2 — beyond that the cost outpaces the visual gain on
  // a textured-mesh scene of this complexity.
  let _renderScale = 1;
  try {
    const _params = new URLSearchParams(window.location.search);
    const _raw = parseFloat(_params.get("renderScale") ?? "");
    if (Number.isFinite(_raw) && _raw > 0 && _raw <= 2) _renderScale = _raw;
  } catch (_) { /* default 1 */ }
  const _basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(_basePixelRatio * _renderScale);
  // Expose a live setter so the user can sweep render scale from
  // devtools without reloading. Re-applies pixel ratio and re-fires
  // setSize on the renderer + atmosphere pipeline + cloud overlay so
  // every RT in the chain rebuilds at the new resolution.
  if (typeof window !== "undefined") {
    window.__setRenderScale = (scale) => {
      const n = Number(scale);
      if (!Number.isFinite(n) || n <= 0 || n > 2) {
        // eslint-disable-next-line no-console
        console.warn(`[render-scale] invalid value ${scale}; expected (0, 2]`);
        return;
      }
      _renderScale = n;
      const pr = Math.min(window.devicePixelRatio || 1, 2) * n;
      renderer.setPixelRatio(pr);
      const ccW = canvas.clientWidth || canvas.width;
      const ccH = canvas.clientHeight || canvas.height;
      renderer.setSize(ccW, ccH, false);
      const lp = (typeof window !== "undefined") ? window.liveScene3d : null;
      try { lp?.atmospherePipeline?.setSize?.(ccW, ccH); } catch (_) {}
      try { lp?.cloudOverlay?.setSize?.(ccW, ccH); } catch (_) {}
      // eslint-disable-next-line no-console
      console.log(`[render-scale] applied scale=${n} → pixelRatio=${pr}`);
    };
  }
  renderer.setSize(cssW, cssH, false);
  renderer.setClearColor(0x101418, 1);

  // Texture quality 2026-05-20 — anisotropy cap. 1 ≡ OFF.
  setAdapterMaxAnisotropy(1);

  // 2026-05-21 — texture knobs (URL flags, default off).
  //   `?textureScale=N` divides every surface + normal texture by N
  //     before GPU upload (1 = native 512×512; 2 = 256; 4 = 128; 8 = 64).
  //   `?atlasTilePx=N` shrinks the 33-layer terrain atlas's per-layer
  //     size (default 512; min 16). 16-256 all valid powers of two.
  // Neither is part of `?agentic=low` by default — empirical test
  // showed only ~0.7s save in agentic-low boot from downscaling both
  // (16.3s vs 17.0s), well inside run-to-run variance, and the visual
  // quality loss (blurry stride-decimated textures) isn't worth it
  // for boots a human might glance at. Available as explicit URL
  // overrides if you really want the smallest possible scene.
  try {
    const _ps = new URLSearchParams(window.location.search);
    const _rawScale = _ps.get("textureScale");
    if (_rawScale) {
      const n = Number.parseInt(_rawScale, 10);
      if (Number.isFinite(n) && n >= 1 && n > 1) {
        setAdapterTextureDownscale(n);
        // eslint-disable-next-line no-console
        console.log(`[adapter] textureDownscale div=${n}`);
      }
    }
    const _rawAtlas = _ps.get("atlasTilePx");
    if (_rawAtlas) {
      const n = Number.parseInt(_rawAtlas, 10);
      if (Number.isFinite(n) && n >= 16) {
        setAtlasTilePx(n);
        // eslint-disable-next-line no-console
        console.log(`[adapter] atlasTilePx=${n}`);
      }
    }
  } catch (_) { /* default off */ }

  // Visual-fidelity Phase 0.1 — opt-in shadow maps via `?shadows=on`.
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
  // Wire-agent skips ALL shadow paths (CSM + single). No fragment-side
  // lighting at all in MeshBasicMaterial; shadow maps would just be
  // wasted GPU work.
  const shadowsEnabled = !wireframeMode && shadowsParam === "on";
  const csmEnabled = !wireframeMode && !!quality?.flags?.csm && shadowsParam !== "off";
  if (shadowsEnabled || csmEnabled) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // eslint-disable-next-line no-console
    console.log(
      `[visfid] shadow path: ${csmEnabled ? "CSM (Phase 3.3)" : "single-shadow (Phase 0.1)"}`
    );
  }

  const scene = new THREE.Scene();
  if (typeof window !== "undefined" && window.__particleSortObjects === false) {
    scene.sortObjects = false;
  }
  if (wireframeMode) {
    // Background + distance fog give human evaluators a depth cue when
    // wire-edges of distant geometry would otherwise look identical to
    // near geometry. FogExp2 + MeshBasicMaterial.fog=true (set in the
    // MaterialCache wireframe path) makes color lerp toward bg with
    // exponential falloff — zero per-frame cost, no shader setup.
    const bg = new THREE.Color(0x1a1f26);
    scene.background = bg;
    scene.fog = new THREE.FogExp2(bg.getHex(), 0.004);
  }

  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);

  const terrainGroup = new THREE.Group(); terrainGroup.name = "terrain";
  const buildingsGroup = new THREE.Group(); buildingsGroup.name = "buildings";
  const staticsGroup = new THREE.Group(); staticsGroup.name = "statics";
  const cellsGroup = new THREE.Group(); cellsGroup.name = "cells";
  const entitiesGroup = new THREE.Group(); entitiesGroup.name = "entities";
  worldRoot.add(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup);

  // Hello-world cube — kept for the Phase 7.0 capture path's assertion.
  // Wire-agent uses MeshBasicMaterial wire so the cube doesn't stand out
  // as the lone textured mesh in an otherwise all-wire scene.
  const cubeGeom = new THREE.BoxGeometry(2, 2, 2);
  cubeGeom.computeBoundingSphere();
  const cubeMat = wireframeMode
    ? new THREE.MeshBasicMaterial({ color: 0xff8844, wireframe: true })
    : new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.6, metalness: 0.1 });
  const cube = new THREE.Mesh(cubeGeom, cubeMat);
  cube.name = "hello-cube";
  cube.position.set(0, 0, 5);
  worldRoot.add(cube);

  // Phase 7.6 — scene lighting (sun + ambient + optional hemisphere).
  // Wire-agent: MeshBasicMaterial ignores ALL lights, so directional
  // sun + ambient + hemisphere + CSM cascades are pure overhead. Return
  // a null-stub that satisfies the downstream `lighting.*` reads
  // (which all use optional chaining: `lighting.sun?.castShadow`,
  // `lighting.csmState && ...`). Skips ~50-200ms of cold-start light-
  // construction + the per-frame matrix updates the THREE renderer does
  // for any DirectionalLight in the scene graph.
  const lighting = wireframeMode
    ? { sun: null, ambient: null, hemisphere: null, lightsGroup: null, csmState: null, dispose: () => {} }
    : setupSceneLighting(scene, {
        sceneSize: 600,
        castShadow: shadowsEnabled,
        csm: csmEnabled,
      });
  const csmState = lighting.csmState ?? null;

  const camera = new THREE.PerspectiveCamera(60, cssW / cssH, 0.1, 5000);
  camera.position.set(15, 15, 15);
  camera.lookAt(0, 0, 5);

  // Phase 0.2 — detail tile cache (gated on `quality.flags.detailFlag`).
  const forceDetail = (() => {
    try {
      if (typeof window === "undefined" || !window.location?.search) return false;
      const params = new URLSearchParams(window.location.search);
      return params.get("forceDetail") === "on";
    } catch (_) {
      return false;
    }
  })();
  // 2026-05-21 cold-boot win: the two detail-asset loaders below
  // (Phase 0.2 detail tile cache + Phase 1.2 terrain detail-normal
  // DataArrayTexture) are independent PNG fetches that decode through
  // the DOM Image+canvas path. Run them concurrently instead of
  // sequentially — the atmosphereRuntimePromise above is already
  // concurrent with these via the same fire-and-forget shape.
  const detailEnabled = !!quality?.flags?.detailFlag || forceDetail;
  const terrainDetailNormalEnabled = !!quality?.flags?.terrainDetailNormal;
  const detailTileCachePromise = detailEnabled
    ? loadDetailTileCache().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[phase-0.2] detail tile load failed:", e);
        return null;
      })
    : Promise.resolve(null);
  const terrainDetailNormalPromise = terrainDetailNormalEnabled
    ? loadTerrainDetailNormalArray().catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[phase-1.2] terrain detail normal load failed:", e);
        return null;
      })
    : Promise.resolve(null);
  const [detailTileCache, terrainDetailNormalResult] = await Promise.all([
    detailTileCachePromise,
    terrainDetailNormalPromise,
  ]);
  if (detailEnabled && detailTileCache) {
    // eslint-disable-next-line no-console
    console.log(
      `[phase-0.2] detail tiles loaded: ${detailTileCache.size}/5 (forceDetail=${forceDetail})`
    );
  }
  let terrainDetailNormalArray = null;
  if (terrainDetailNormalEnabled) {
    if (terrainDetailNormalResult) {
      terrainDetailNormalArray = terrainDetailNormalResult.texture;
      // eslint-disable-next-line no-console
      console.log(
        `[phase-1.2] terrain detail normal array loaded: ${terrainDetailNormalResult.keys.length} slices`
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[phase-1.2] terrain detail normal array unavailable; shader will run baseline"
      );
    }
  }

  return {
    canvas,
    cssW,
    cssH,
    layoutChromeH,
    renderer,
    scene,
    worldRoot,
    terrainGroup,
    buildingsGroup,
    staticsGroup,
    cellsGroup,
    entitiesGroup,
    cube,
    lighting,
    csmState,
    camera,
    quality,
    shadowsEnabled,
    csmEnabled,
    detailTileCache,
    terrainDetailNormalArray,
    forceDetail,
    atmosphereRuntimePromise,
    wireframeMode,
  };
}

export async function init3D(canvas, sessionHandle, wasmExports, preInitHandle) {
  // 2026-05-21 cold-boot Phase G — reuse the eager-init handle from
  // page-init when it was built ahead of time, otherwise build it
  // inline now (preserves the Phase 7.0 hello-cube capture path that
  // calls init3D(canvas, null, {}) directly).
  const pre = preInitHandle ?? (await preInit3D(canvas));
  const {
    cssW,
    cssH,
    layoutChromeH,
    renderer,
    scene,
    worldRoot,
    terrainGroup,
    buildingsGroup,
    staticsGroup,
    cellsGroup,
    entitiesGroup,
    cube,
    lighting,
    csmState,
    camera,
    quality,
    shadowsEnabled,
    csmEnabled,
    detailTileCache,
    terrainDetailNormalArray,
    forceDetail,
    atmosphereRuntimePromise,
    wireframeMode,
  } = pre;
  const { sun, ambient, lightsGroup } = lighting;

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

  // Sky-K.2 — atmosphere pipeline (constructed below after AtmosphereRuntime's
  // texture bake completes). Forward-declared so the
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
      const newW = Math.min(window.innerWidth - layoutMarginW, _isAgentMode ? 4096 : 1920);
      const newH = Math.min(window.innerHeight - layoutChromeH, _isAgentMode ? 2160 : 1080);
      if (!_isAgentMode) {
        canvas.style.width = `${newW}px`;
        canvas.style.height = `${newH}px`;
      }
      renderer.setSize(newW, newH, false);
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      if (atmospherePipeline) {
        atmospherePipeline.setSize(newW, newH);
        // Re-wire the cloud overlay's depth-sampling uniform — the
        // pipeline disposed the old depth texture on resize and built
        // a fresh one of the new dimensions.
        if (
          liveScene3d?.cloudOverlay &&
          typeof liveScene3d.cloudOverlay.setSceneDepthTexture === "function" &&
          typeof atmospherePipeline.getSceneDepthTexture === "function"
        ) {
          liveScene3d.cloudOverlay.setSceneDepthTexture(
            atmospherePipeline.getSceneDepthTexture()
          );
        }
      }
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
    // Wire-agent flag — propagates into getOrCreateMaterialCache so
    // the MaterialCache returns wireframe MeshBasicMaterial bundles
    // instead of standard textured materials.
    wireframeMode,
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
    // Phase 2.2 — terrain ShaderMaterial registry (one entry per LB),
    // populated by bakeTerrainForLandblock. Eagerly initialised here so
    // the same array reference threads through scene3dForBuilders →
    // liveScene3d → window.liveScene3d before any LB bakes run. Without
    // this, terrain.js's lazy `scene3d.terrainMaterials = []` creates
    // an array that liveScene3d never sees (the `?? []` below would
    // have already minted a separate empty array), silently breaking
    // cloud_volume.js's _pushCloudShadowsToTerrain → cloud shadows
    // never reached terrain in-game.
    terrainMaterials: [],
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

  // `envCellsLoaded` is the load-result bundle for the eager Phase
  // 7.3 dungeons (Mite Maze + Holtburg Dungeon), populated by the
  // parallel envCells runner below. Hoisted out of the `if` block so
  // the liveScene3d build at the bottom of init3D can reference it
  // regardless of which gate branch ran.
  let envCellsLoaded = null;

  // Phase 7.2 + 7.3 — buildings, statics, and known dungeon EnvCells
  // baked in parallel. Cold-boot Phase C (2026-05-21) flipped this
  // from a sequential await chain (buildings → statics → mite maze →
  // holt dungeon, each blocking the next) into a single `Promise.all`
  // over three independent runners.
  //
  // Why this is safe:
  //   - Each baker owns its own THREE.Group (`buildingsGroup`,
  //     `staticsGroup`, `cellsGroup`) so there's no scene-graph race.
  //   - The shared `MaterialCache` already implements per-DID
  //     `pendingFetches` dedup in `materials.js:1227` so concurrent
  //     `preload(...)` callers across bakers latch on a single
  //     in-flight wasm fetch per surface DID.
  //   - The wasm side caches its own DAT shard reads, so cross-baker
  //     fetches for the same shard hit the wasm cache after the first.
  //
  // The one ordering constraint the previous serial chain hid:
  // `cells.js:90` throws if `scene3d.materialCache` is undefined.
  // `bakeBuildingsRing` used to be the first await and its inner
  // `resolveBuildingsOpts` stamped the cache before its `Promise.all`
  // resolved. With parallel runners we install the cache synchronously
  // BEFORE any await fires, so the cells runner can launch from frame
  // zero without losing the race.
  //
  // Capture-script contract: the three `[phase7.2 buildings]`,
  // `[phase7.2 statics]`, `[phase7.3 envCells]` log strings are
  // preserved verbatim — they're emitted by each runner the moment
  // ITS internal Promise.all resolves, not after the outer
  // `Promise.all` does. Capture scripts that grep for these strings
  // see the same ordering they always did (any of the three may
  // arrive first; previously buildings was always first because it
  // blocked the others).
  if (
    wasmExports &&
    typeof wasmExports.fetch_landblock_objects === "function" &&
    typeof wasmExports.fetchBuildingPlacement === "function" &&
    typeof wasmExports.fetch_surfaces_pixels === "function"
  ) {
    // Pre-install the MaterialCache BEFORE any await. Both the statics
    // runner (`getOrCreateMaterialCache` at statics.js:1178) and the
    // cells runner (cells.js:90 guard) read this off scene3d
    // synchronously at entry. Idempotent — subsequent
    // `getOrCreateMaterialCache` / `resolveBuildingsOpts` calls
    // observe the existing instance and return it as-is.
    getOrCreateMaterialCache(scene3dForBuilders);

    const runBuildings = async () => {
      try {
        // 2026-05-16 bandwidth optimisation — buildings ring decoupled
        // from the terrain ring (radius=6) and shrunk to radius=2
        // (5×5=25 LBs). PVS-driven expansion in loop.js's
        // tickPvsLoadExpansion fires `loadBuildingsForLandblock`
        // (idempotent) for any LB whose cell becomes visible.
        const s = await bakeBuildingsRing(
          scene3dForBuilders,
          HOLTBURG_X,
          HOLTBURG_Y,
          BUILDINGS_RING_RADIUS,
          wasmExports
        );
        // eslint-disable-next-line no-console
        console.log("[phase7.2] buildings:", s);
        return s;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[scene3d] bakeBuildingsRing failed:", e);
        return null;
      }
    };

    const runStatics = async () => {
      if (typeof wasmExports.fetch_model_meshes !== "function") return null;
      try {
        // 2026-05-16 bandwidth optimisation — statics ring decoupled
        // from the terrain/buildings ring. Initial radius=2 (5×5=25
        // LBs). PVS expansion + the per-LB hook
        // `loadStaticsForLandblock` are idempotent so concurrent
        // expansion paths converge cleanly.
        const s = await bakeStaticsRing(
          scene3dForBuilders,
          HOLTBURG_X,
          HOLTBURG_Y,
          STATICS_RING_RADIUS,
          wasmExports
        );
        // eslint-disable-next-line no-console
        console.log("[phase7.2] statics:", s);
        return s;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[scene3d] bakeStaticsRing failed:", e);
        return null;
      }
    };

    const runEnvCells = async () => {
      // Mite Maze (0x01F80000) + Holtburg Dungeon (0x01F60000) — known
      // dungeon EnvCells eager-loaded for capture-script verification.
      // Real-world flow loads on landblock-change events; for now
      // these two are the only ones the boot-time pipeline pulls.
      if (
        typeof wasmExports.fetchEnvCellsInLandblock !== "function" ||
        typeof wasmExports.fetch_surfaces_pixels !== "function"
      ) {
        return null;
      }
      // 2026-05-21 — default skip for the two known dungeon EnvCells
      // (Mite Maze 0x01F80000 + Holt Dungeon 0x01F60000). These were
      // eager-loaded historically for capture-script verification, but
      // ~10s of phase7 wall-clock for content the player only ever
      // sees inside the specific dungeon LB is a poor default trade.
      // index.html:4784 already wires `handlePositionUpdate` to call
      // `liveScene3d.loadEnvCellsForLandblock(lbId)` on every LB the
      // player enters — so walking into a dungeon still triggers the
      // load on demand, with no observable latency penalty (the player
      // can't see inside the dungeon until they're at the portal).
      // Opt-in via `?eagerDungeons=on` for capture-script paths that
      // assert the meshes exist immediately at boot. Holtburg's local
      // cottage/shop envcells (the visible-from-spawn interior cells)
      // load via the same handlePositionUpdate hook on the spawn LB
      // — those are NOT in this block and are unaffected.
      try {
        if (typeof window !== "undefined") {
          const ps = new URLSearchParams(window.location.search);
          const eagerOptIn = ps.get("eagerDungeons") === "on";
          if (!eagerOptIn) {
            // eslint-disable-next-line no-console
            console.log(
              "[phase7.3] envCells: dungeon eager-load deferred to handlePositionUpdate " +
              "(opt in via ?eagerDungeons=on for capture scripts)"
            );
            return { miteMaze: null, holtDungeon: null, deferred: true };
          }
        }
      } catch (_) { /* fallthrough to normal load */ }
      try {
        // Inner parallelism: the two LB loads are independent (different
        // `envCellLoadedLbs` keys, separate `cellContainers3d` entries)
        // so they can race too.
        const [miteMaze, holtDungeon] = await Promise.all([
          buildEnvCellsForLandblock(scene3dForBuilders, 0x01f80000, wasmExports),
          buildEnvCellsForLandblock(scene3dForBuilders, 0x01f60000, wasmExports),
        ]);
        const result = { miteMaze, holtDungeon };
        // eslint-disable-next-line no-console
        console.log("[phase7.3] envCells:", result);
        return result;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[phase7.3] EnvCell load failed:", e);
        return null;
      }
    };

    const [bResult, sResult, eResult] = await Promise.all([
      runBuildings(),
      runStatics(),
      runEnvCells(),
    ]);
    buildingsSummary = bResult;
    staticsSummary = sResult;
    envCellsLoaded = eResult;

    // 2026-05-22 — wire-agent: walk the just-baked buildings + statics +
    // cells groups and attach solid-fill companion meshes for every
    // wire-bucket-materialed Mesh/InstancedMesh. The companions share
    // geometry with their wire source so the only GPU cost is one extra
    // draw call per source mesh. Result: trees, doors, signs, building
    // walls, EnvCell interiors all render with the per-bucket HSL fill
    // colour visible BETWEEN the wire lines, instead of empty
    // transparency. The lazy LB-entry hooks
    // (`liveScene3d.loadBuildingsForLandblock` etc.) also call this on
    // their respective groups so newly-loaded LBs pick up companions.
    if (wireframeMode && scene3dForBuilders.materialCache) {
      const mc = scene3dForBuilders.materialCache;
      let total = 0;
      if (scene3dForBuilders.buildingsGroup) {
        total += mc.addFillCompanions(scene3dForBuilders.buildingsGroup);
      }
      if (scene3dForBuilders.staticsGroup) {
        total += mc.addFillCompanions(scene3dForBuilders.staticsGroup);
      }
      if (scene3dForBuilders.cellsGroup) {
        total += mc.addFillCompanions(scene3dForBuilders.cellsGroup);
      }
      // eslint-disable-next-line no-console
      console.log(`[wire-fill] attached ${total} solid-fill companion meshes`);
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
    !wireframeMode &&
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
    if (atmospherePipeline) {
      atmospherePipeline.setSize(cw, ch);
      // Re-wire cloud overlay's depth uniform to the rebuilt depth
      // texture (atmospherePipeline.setSize disposes the old).
      if (
        liveScene3d?.cloudOverlay &&
        typeof liveScene3d.cloudOverlay.setSceneDepthTexture === "function" &&
        typeof atmospherePipeline.getSceneDepthTexture === "function"
      ) {
        liveScene3d.cloudOverlay.setSceneDepthTexture(
          atmospherePipeline.getSceneDepthTexture()
        );
      }
    }
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
  // A3 (2026-05-18) — dt-recovery after tab unfocus. Raw dt after a
  // 5 s alt-tab is ~5000 ms; the Math.min(..., 0.1) cap below clamps
  // it to 100 ms, but feeding a 100 ms step into physics/animation
  // still snaps the world forward visibly. When we detect a large
  // raw dt, we enter a recovery window and force `dt = 0` for the
  // next N frames so simulation stays frozen while the camera and
  // render path keep ticking normally. Option (a) — skip simulation
  // — was chosen over the ramp variant because it's simpler and
  // strictly conservative: nothing advances during recovery, so we
  // can't introduce stutter from a partially-correct dt ramp.
  const DT_RECOVERY_RAW_THRESHOLD_S = 0.5; // ~5+ frames of lost time
  const DT_RECOVERY_FRAMES = 10;
  let dtRecoveryFramesRemaining = 0;
  // `liveScene3d` is referenced inside tick before it's constructed
  // below, so we forward-declare and patch the reference after
  // construction. The session handle attached to `liveScene3d` is the
  // one passed into `init3D`; capture scripts can stub it post-init
  // by setting `window.liveScene3d.sessionHandle = mock`.
  let liveScene3dRef = null;
  function tick(nowTs) {
    if (!running) return;
    const ts = typeof nowTs === "number" ? nowTs : performance.now();
    // Raw dt (no cap) so we can detect post-unfocus recovery; the
    // Math.min(..., 0.1) cap below is the per-frame safety net and
    // stays in place. See A3 comment above the tick fn.
    const rawDt = lastFrameTs === null ? 0.016 : (ts - lastFrameTs) / 1000;
    let dt;
    if (lastFrameTs === null) {
      dt = 0.016;
    } else if (rawDt > DT_RECOVERY_RAW_THRESHOLD_S) {
      // First frame after a long gap — arm recovery and freeze sim.
      dtRecoveryFramesRemaining = DT_RECOVERY_FRAMES;
      dt = 0;
    } else if (dtRecoveryFramesRemaining > 0) {
      // Mid-recovery — keep sim frozen for the remaining frames.
      dtRecoveryFramesRemaining -= 1;
      dt = 0;
    } else {
      dt = Math.min(rawDt, 0.1);
    }
    lastFrameTs = ts;
    if (liveScene3dRef) {
      // Single per-frame wall-clock snapshot. Consumers that need
      // tsSec / dt read from here instead of calling performance.now()
      // themselves — see scene3d/loop.js tickTerrainUTime and the
      // "three time sources" hazard in INTERACTING_LAYERS_ANALYSIS.md.
      // AC game time (Date.now() + 11.34× compression) stays in
      // atmosphere_sky.js — that's the world clock, separate axis.
      liveScene3dRef.frameTime = {
        tsMs: ts,
        tsSec: ts * 0.001,
        dt,
      };
      try {
        tickPerFrame(liveScene3dRef, liveScene3dRef.sessionHandle, dt);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[scene3d.loop] tickPerFrame threw:", e);
      }
      // AC moons — advance orbital positions for this frame. The
      // tick() guards itself if textures haven't finished loading.
      try { liveScene3dRef.acMoons?.tick(ts); } catch (_) {}
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
    // Sky-K.2 path: atmosphere composer owns sky + world + AerialPerspective
    // + Dithering. Cloud overlay's pre/render hooks run AROUND composer.render
    // (depth-unaware-cloud limitation — addressed in a follow-on cleanup).
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
          cloudOverlay.preRender(renderer, dt, activeCam);
        }
        atmospherePipeline.render(activeCam, dt);
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

    // Direct render path. Reachable in three cases:
    //   1. Pre-bake window — atmosphereRuntime.whenReady() takes
    //      ~8 s on a real-GPU GTX 1070, ~43 s on the R9 290 per the
    //      2026-05-18 cloudflare-tunnel session. atmospherePipeline
    //      is null during that window so this branch renders.
    //   2. `?atmosphere=off` — explicit opt-out for parametric-sky
    //      capture flows.
    //   3. Atmosphere init failure — defensive fallback.
    // Cloud occlusion is depth-correct here too: the cloud overlay
    // quad is attached to skyDome.skyScene by setCloudOverlay() (see
    // sky_dome.js), so renderSkyPass paints sky+cloud color into
    // the framebuffer; then renderer.clearDepth() + renderer.render
    // overpaints world geometry at world pixels (same render-order
    // logic as the atmosphere composer's clear=false/clearDepth=true).
    let skyRendered = false;
    if (liveScene3dRef?.skyDome) {
      try {
        liveScene3dRef.skyDome.renderSkyPass(renderer, activeCam, dt);
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
    // uniform state without walking `terrainGroup.children`. Initialized
    // eagerly on scene3dForBuilders above so this reference is the same
    // array that terrain.js pushes into — see the eager init comment.
    terrainMaterials: scene3dForBuilders.terrainMaterials,
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
    // Wire-agent — without this alias, loadTerrainForLandblock /
    // loadBuildingsForLandblock / loadStaticsForLandblock (called from
    // handlePositionUpdate when player crosses an LB) pass `this =
    // liveScene3d` to the bakers, where `scene3d.wireframeMode` is
    // undefined → falsy → bakeTerrainForLandblock takes the
    // ShaderMaterial branch even in wire mode. Surfaced 2026-05-21 by
    // the docs/wiretree tour: outer-ring LBs reached via @teleloc were
    // textured while the initial-ring LBs (baked via scene3dForBuilders)
    // were wire. Mirrors the terrainOpts/etc aliasing precedent above.
    wireframeMode: !!scene3dForBuilders.wireframeMode,
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
  // Sky-K.6 cleanup (2026-05-18): SkyLightingController used to drive
  // DirectionalLight/AmbientLight/Fog from per-frame SkyState. With
  // atmosphere mode the sole runtime path, the controller is now
  // just a SkyState cache — atmosphere_lights.tick + atmosphere_sky.tick
  // read its _lastState as the canonical SkyState snapshot for the
  // frame. Constructor no longer needs sun/ambient/scene args.
  // Wire-agent: SkyLightingController is a SkyState cache consumed by
  // atmosphereLights / atmosphereSky / aurora / skyDome — all stripped
  // in wire. tick() never writes to scene.fog, lights, or anything
  // visual (per its source: only updates `this._lastState` via wasm
  // session.getSkyState). Skipping construction has zero visual effect
  // and saves the per-rAF wasm round-trip + decode. loop.js already
  // null-guards `scene3d.skyLightingController?.tick(dt)`.
  if (!wireframeMode) try {
    const skyLightingController = new SkyLightingController({
      sessionHandleAccessor: () =>
        // eslint-disable-next-line no-undef
        (typeof window !== "undefined" ? window.__sessionHandle : null) ??
        sessionHandle ??
        null,
    });
    liveScene3d.skyLightingController = skyLightingController;
    // eslint-disable-next-line no-console
    console.log("[sky-c] SkyLightingController attached as SkyState cache.");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[sky-c] SkyLightingController init failed:", e);
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
  // Forward-declared at outer scope so downstream references (aurora,
  // atmospherePipeline construction, cloud-overlay wiring) can read
  // `skyDome?.skyScene` without ReferenceError when the construct
  // block below is skipped (wireframe mode).
  let skyDome = null;
  if (wireframeMode) {
    // Wire-agent: skip the SkyDome construction entirely. Downstream
    // `skyDome?.skyScene` reads return undefined cleanly via optional
    // chaining, and the direct-render fallback at L1218 paints
    // scene.background instead.
    // eslint-disable-next-line no-console
    console.log("[wire-agent] skipping SkyDome construction");
  } else try {
    skyDome = new SkyDome({
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

    // 2026-05-18 — Asheron's Call canon: two moons in the night sky.
    // Alb'arel (light) + Rez'arel (red). Attached to the MAIN scene
    // (not skyDome.skyScene): the moon positions are updated each
    // frame to `camera.position + sky-direction * SKY_RADIUS` so the
    // moons appear at fixed angular positions regardless of the
    // player's world position. Putting them in skyScene with absolute
    // world coords doesn't work because the sky pass renders with
    // skyCamera positioned at the player's world location — and for a
    // player far from origin (Holtburg ~32k units east), a moon at
    // sky-shell coord (~2000) is 45 km away and past the 5000-unit
    // far plane.
    try {
      const acMoons = new ACMoons();
      liveScene3d.acMoons = acMoons;
      acMoons.load().then(() => {
        acMoons.attachToSkyScene(skyDome.skyScene);
        // eslint-disable-next-line no-console
        console.log(
          `[ac-moons] Alb'arel + Rez'arel attached to sky scene ` +
            `(speedMul=${acMoons._speedMul}). Tweak motion via ` +
            `?moonSpeed=N URL param.`
        );
      }).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn("[ac-moons] texture load failed:", e);
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[ac-moons] init failed:", e);
    }

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
      if (cloudsFlag === "on" && !wireframeMode) {
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
        // takram's native crepuscular rays — physically driven by the
        // existing cascaded cloud-shadow maps, routed through
        // AerialPerspective. Cheaper and more correct than a separate
        // pmndrs GodRaysEffect because it reuses passes the cloud volume
        // already runs; the only cost is the extra shadowLength buffer.
        effect.lightShafts = !!quality.flags.lightShafts;

        skyDome.setCloudOverlay(cloudOverlay);
        liveScene3d.cloudOverlay = cloudOverlay;

        // Sky-K.6 cleanup (2026-05-18): the parametric SkyObjects
        // (cloud bands, moon mesh, weather streaks) and the
        // `?retroSky=on` opt-in were removed alongside sky_assets.js.

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
          // eslint-disable-next-line no-undef
          window.__setLightShafts = (on) => {
            effect.lightShafts = !!on;
            return effect.lightShafts;
          };
        }

        // eslint-disable-next-line no-console
        console.log(
          "[clouds-d] CloudOverlay wired into SkyDome (?clouds=on). " +
            `coverage=${effect.clouds.coverage} qualityPreset=${effect.qualityPreset ?? "default"}. ` +
            "Visible clouds require a real GPU — swiftshader output is uniform. " +
            "Live tweak: __setCloudCoverage(0..1), __setCloudQuality('low'|'medium'|'high'|'ultra')."
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[clouds-d] CloudOverlay init failed:", e);
    }

    // Aurora borealis — opt-in via `?aurora=on` or `?aurora=N` (intensity).
    // Final unshipped item from OPTICAL_EFFECTS_HANDOFF.md. Camera-following
    // sphere shell with a nimitz-inspired curtain shader, additive
    // blended onto the sky scene at renderOrder=900 (between AC moons
    // at 800 and the cloud overlay at 999). Default off — AC has no
    // aurora canon — but a satisfying "weather fan" sidequest.
    try {
      // eslint-disable-next-line no-undef
      const auroraParams = new URLSearchParams(window.location.search);
      const auroraFlag = auroraParams.get("aurora");
      if (auroraFlag && auroraFlag !== "off" && auroraFlag !== "false" && auroraFlag !== "0") {
        const auroraIntensity = (() => {
          const n = parseFloat(auroraFlag);
          return Number.isFinite(n) && n > 0 ? n : 1.0;
        })();
        const { createAurora } = await import("./aurora.js");
        const aurora = createAurora({
          camera,
          intensity: auroraIntensity,
          // Polar axis = world +Y; matches the project's ECEF setup
          // (cloud_volume.js / atmosphere_pipeline.js shift the world
          // origin by bottomRadius so ECEF Z aligns with world Y).
          polarAxis: { x: 0, y: 1, z: 0 },
        });
        if (skyDome?.skyScene) {
          skyDome.skyScene.add(aurora.mesh);
          liveScene3d.aurora = aurora;
          // eslint-disable-next-line no-undef
          if (typeof window !== "undefined") {
            // eslint-disable-next-line no-undef
            window.__aurora = aurora;
            // eslint-disable-next-line no-undef
            window.__setAuroraIntensity = (v) => aurora.setIntensity(v);
          }
          // eslint-disable-next-line no-console
          console.log(
            `[aurora] Aurora overlay wired into skyScene (?aurora=${auroraFlag}). ` +
              `intensity=${auroraIntensity}. ` +
              "Live tweak: __setAuroraIntensity(0..4)."
          );
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[aurora] init failed:", e);
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
      // Sky-K.6 cleanup (2026-05-18): atmosphere is unconditional now.
      // The `?atmosphere=off` opt-out was removed alongside the legacy
      // parametric sky path (sky_assets.js + parametric celestials in
      // sky_dome.js). Bare scope kept so the brace pair below balances
      // without a costly re-indent.
      {
        // 2026-05-21 Phase A/D follow-on — the LUT load was kicked off
        // at the renderer-construction site (~L212) so it ran
        // concurrently with phase7 streaming. We just await the
        // pre-warmed instance here; `whenReady()` below resolves
        // immediately on the EXR-load fast path, since the bake/load
        // completed during the ~36s phase7 window.
        const atmosphereRuntime = await atmosphereRuntimePromise;
        liveScene3d.atmosphereRuntime = atmosphereRuntime;
        // eslint-disable-next-line no-undef
        if (typeof window !== "undefined") {
          // eslint-disable-next-line no-undef
          window.__atmosphereRuntime = atmosphereRuntime;
        }
        if (!atmosphereRuntime) {
          // Wire-agent path — atmosphereRuntimePromise resolved to null
          // because ?wireframe=1 set wireframeMode in preInit3D.
          // Composer/pipeline construction is skipped; the render loop
          // falls back to direct renderer.render at L1218.
          // eslint-disable-next-line no-console
          console.log("[wire-agent] atmosphereRuntime null — skipping composer construction");
          // Terminal boot signal for agent harnesses — the autoLogin
          // state machine in index.html waits for `ready` (would
          // otherwise time out at 90s with the atmosphere never
          // signalling). Fire it ourselves; the scene is already
          // visually settled (terrain + buildings + entities present)
          // by the time atmosphereRuntimePromise resolves.
          try {
            // eslint-disable-next-line no-undef
            window.__setBootState?.(
              "ready",
              "scene fully loaded (wire-agent; atmosphere skipped)"
            );
          } catch {}
        } else atmosphereRuntime.whenReady().then(async () => {
          try {
            // 2026-05-21 cold-boot Phase G follow-on — parallel imports
            // for the three atmosphere modules. Index.html's Phase E
            // eager-import block (around line ~924) already warmed
            // these on page-init via `Promise.all([... 5 imports ...])`,
            // so the dynamic import calls below hit the ES-module cache
            // and resolve synchronously. The Promise.all here saves the
            // 3 sequential awaits that were stretching the post-bake
            // chain even when warm (microtask scheduling) and reads as
            // a single "load + construct" beat.
            //
            // 2026-05-21 hoist attempt: moving these to preInit3D
            // (atmosphereModulesPromise on the handle) saved 14s on
            // chain wall-clock BUT broke `renderer.compile(scene, camera)`
            // pre-warm (programs=14 instead of programs=36+) because the
            // chain then fired before entity replay populated the scene
            // — reintroducing the first-frame texture/shader stutter the
            // 2026-05-21 stutter-fix shipped. Reverted; the implicit 14s
            // here is load-bearing for "scene fully populated" timing.
            // See project_holtburger_stutter_fixes_2026-05-21 for the
            // pre-warm contract that needs to be preserved.
            const [
              { createAtmospherePipeline },
              { AtmosphereLights },
              { AtmosphereSky },
            // 2026-05-21 cold-boot win: prefer the eager-imported
            // modules stashed on window.__eagerAtmosphere by index.html's
            // Phase E block. Empirically the dynamic-import here misses
            // the ES module cache and re-fetches the full takram CDN
            // graph (~14s wall-clock) even though the same modules were
            // eagerly imported at T+1.6s; reusing the cached namespace
            // objects directly skips that. Falls back to dynamic import
            // if the eager block didn't run (e.g. Phase 7.0 capture path
            // with no `?renderer=3d`).
            ] = window.__eagerAtmosphere ?? await Promise.all([
              import("./atmosphere_pipeline.js"),
              import("./atmosphere_lights.js"),
              import("./atmosphere_sky.js"),
            ]);
            // Pipeline first — it owns the EffectComposer + cloud
            // depth-texture coupling that the overlay wiring below
            // reads. AtmosphereLights and AtmosphereSky are
            // construction-only operations on independent scenes
            // (Lights writes to `scene`; Sky writes to
            // `skyDome.skyScene`) and so are safe to construct in
            // parallel afterwards.
            atmospherePipeline = createAtmospherePipeline(renderer, scene, camera, {
              skyScene: skyDome?.skyScene,
              skyCamera: skyDome?.skyCamera,
              atmosphereRuntime,
              bloom: !!quality.flags.bloom,
              vignette: !!quality.flags.vignette,
              // 2026-05-21 stutter fix — lensFlare default OFF (see
              // atmosphere_pipeline.js). Opt in via `?lensFlare=on`.
              lensFlare: !!quality.flags.lensFlare,
            });
            liveScene3d.atmospherePipeline = atmospherePipeline;
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__atmospherePipeline = atmospherePipeline;
            }

            // 2026-05-16 cloud z-order fix -- plumb the composer's
            // depth texture into the cloud overlay so its fragment
            // shader can discard cloud pixels behind world geometry.
            // Without this, clouds paint over buildings/NPCs in front
            // of the sky (documented "follow-on cleanup" in the
            // atmosphere_pipeline.js header). The setSize hook in the
            // pipeline rebuilds the depth texture on resize -- we
            // re-wire it in the resize handler below as well so the
            // overlay never holds a stale (disposed) reference.
            try {
              if (
                liveScene3d?.cloudOverlay &&
                typeof liveScene3d.cloudOverlay.setSceneDepthTexture === "function" &&
                typeof atmospherePipeline.getSceneDepthTexture === "function"
              ) {
                liveScene3d.cloudOverlay.setSceneDepthTexture(
                  atmospherePipeline.getSceneDepthTexture()
                );
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn("[sky-k.2/clouds] depth-texture wire failed:", e);
            }

            // Sky-K.3 + K.4 — construct Lights and Sky in parallel.
            // AtmosphereLights writes to `scene` (adds DirectionalLight
            // + LightProbe). AtmosphereSky writes to `skyDome.skyScene`
            // (adds SkyMaterial mesh + stars Points). Both read the
            // SAME `atmosphereRuntime.textures` bundle but only sample
            // it (no GPU state contention). The stars.bin fetch inside
            // AtmosphereSky is async and resolves whenever it lands —
            // independent of Lights init.
            let atmosphereLights;
            let atmosphereSky = null;
            const lightsPromise = (async () => new AtmosphereLights({
              scene,
              atmosphereRuntime,
            }))();
            const skyPromise = skyDome?.skyScene
              ? (async () => new AtmosphereSky({
                  skyScene: skyDome.skyScene,
                  skyDome,
                  atmosphereRuntime,
                }))()
              : Promise.resolve(null);
            [atmosphereLights, atmosphereSky] = await Promise.all([
              lightsPromise,
              skyPromise,
            ]);
            liveScene3d.atmosphereLights = atmosphereLights;
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__atmosphereLights = atmosphereLights;
            }
            if (atmosphereSky) {
              liveScene3d.atmosphereSky = atmosphereSky;
              // eslint-disable-next-line no-undef
              if (typeof window !== "undefined") {
                // eslint-disable-next-line no-undef
                window.__atmosphereSky = atmosphereSky;
                // eslint-disable-next-line no-undef
                window.__setSunSize = (radians) => {
                  atmosphereSky.setSunAngularRadius(radians);
                };
                // eslint-disable-next-line no-undef
                window.__setMoonSize = (radians) => {
                  atmosphereSky.setMoonAngularRadius(radians);
                };
              }
            }

            // Sky-K.6 cleanup (2026-05-18): SkyLightingController no
            // longer writes to parametric lights — the setAtmosphereMode
            // handshake is gone. Phase 7.6's sun/ambient handles still
            // exist on the scene from setupSceneLighting; zero their
            // intensity so any leftover construction-time values don't
            // double-up with atmosphere_lights' physical sun + sky probe.
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

            // 2026-05-21 stutter fix — pre-warm shaders + texture
            // uploads. Walks the scene graph, compiles every program
            // variant, uploads every texture synchronously HERE so the
            // first user-visible frames don't HITCH compiling on demand
            // (the WebGL "Tex image TEXTURE_2D level 0 is incurring
            // lazy initialization" warnings). Cost paid once up front
            // (~200-500 ms typically).
            //
            // 2026-05-21 cold-boot win — split into two compile passes:
            //   • Pass 1 (immediate): catches phase7 world materials
            //     that are in scene by chain-end (terrain + buildings
            //     + statics + envcells + atmosphere). ~14 programs.
            //   • Pass 2 (deferred): catches entity materials that
            //     stream in over the next several seconds via
            //     workstream-E replay. ~25-30 more programs.
            // Ready fires after pass 1 so the user gets a usable scene
            // ~14s sooner; pass 2 runs in background per the
            // stutter-fix memo's contract ("Entity meshes added later
            // still compile on demand, but per-mesh cost is small —
            // one variant at a time, not the whole world"). The
            // up-front world pre-warm still kills the bulk-hitch
            // pattern; entity-only lazy compiles are bounded + cheap.
            const doCompile = (label) => {
              try {
                const t = performance.now();
                renderer.compile(scene, camera);
                // eslint-disable-next-line no-console
                console.log(
                  `[sky-k.3] renderer.compile ${label} ` +
                    `${(performance.now() - t).toFixed(1)}ms ` +
                    `(programs=${renderer.info.programs?.length ?? "?"}, ` +
                    `textures=${renderer.info.memory.textures}, ` +
                    `geometries=${renderer.info.memory.geometries})`
                );
              } catch (eCompile) {
                // eslint-disable-next-line no-console
                console.warn(`[sky-k.3] renderer.compile ${label} failed:`, eCompile);
              }
            };
            doCompile("(pass 1: world)");

            // eslint-disable-next-line no-console
            {
              const src = atmosphereRuntime.source;
              const ms = src === 'load'
                ? atmosphereRuntime.loadMs?.toFixed?.(1)
                : atmosphereRuntime.bakeMs?.toFixed?.(1);
              const tag = src === 'load' ? 'load' : 'bake';
              console.log(
                `[sky-k.3] AtmosphereRuntime ready (${tag} ${ms}ms). ` +
                  "AerialPerspective + ToneMapping(AGX) + Dithering composer wired. " +
                  "SunDirectionalLight + SkyLightProbe added; parametric lights silenced. " +
                  "toneMappingExposure=5 — tune via __setExposure(v)."
              );
              // 2026-05-21 — terminal boot signal for agents. Pass 1
              // pre-warmed world + atmosphere; entity-only lazy
              // compiles are bounded by `pass 2` below.
              try {
                window.__setBootState?.(
                  "ready",
                  `scene fully loaded (atmosphere ${tag} ${ms}ms)`,
                );
              } catch {}
              // Background pass 2: defer until entity replay has had
              // time to load most models. 4s after ready gives a typical
              // 200-400 entity backlog plenty of time without gating the
              // user. Uses raf-driven poll so a stalled main thread
              // doesn't lose the deferral; falls back to setTimeout for
              // headless / `?renderer=3d` capture contexts where rAF
              // throttles.
              const PASS2_DELAY_MS = 4000;
              const scheduledFrom = performance.now();
              const tryPass2 = () => {
                if (performance.now() - scheduledFrom >= PASS2_DELAY_MS) {
                  doCompile("(pass 2: entities + lazy)");
                  return;
                }
                if (typeof requestAnimationFrame === "function") {
                  requestAnimationFrame(tryPass2);
                } else {
                  setTimeout(tryPass2, 100);
                }
              };
              if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(tryPass2);
              } else {
                setTimeout(tryPass2, PASS2_DELAY_MS);
              }
            }
            // eslint-disable-next-line no-undef
            if (typeof window !== "undefined") {
              // eslint-disable-next-line no-undef
              window.__setExposure = (v) => {
                renderer.toneMappingExposure = +v;
                return renderer.toneMappingExposure;
              };
              // Bloom / Vignette live tweaks. Each effect is null when its
              // preset flag is off; setters return null in that case so the
              // caller knows the pipeline was built without them and a page
              // reload with `?bloom=on` or `?vignette=on` is required.
              // eslint-disable-next-line no-undef
              window.__setBloomIntensity = (v) => {
                if (!atmospherePipeline?.bloom) return null;
                atmospherePipeline.bloom.intensity = +v;
                return atmospherePipeline.bloom.intensity;
              };
              // eslint-disable-next-line no-undef
              window.__setBloomThreshold = (v) => {
                const b = atmospherePipeline?.bloom;
                if (!b?.luminanceMaterial) return null;
                b.luminanceMaterial.threshold = +v;
                return b.luminanceMaterial.threshold;
              };
              // eslint-disable-next-line no-undef
              window.__setVignetteDarkness = (v) => {
                if (!atmospherePipeline?.vignette) return null;
                atmospherePipeline.vignette.darkness = +v;
                return atmospherePipeline.vignette.darkness;
              };
              // eslint-disable-next-line no-undef
              window.__setVignetteOffset = (v) => {
                if (!atmospherePipeline?.vignette) return null;
                atmospherePipeline.vignette.offset = +v;
                return atmospherePipeline.vignette.offset;
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
  if (!wireframeMode && wasmExports && typeof wasmExports.fetchWave === "function") {
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
  if (!wireframeMode && wasmExports && typeof wasmExports.fetchSoundTable === "function") {
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
        // F.D-fu1 (2026-05-20) — synthetic GameMessageSound (0xF750)
        // injection helper for validator probes. Mirrors the SAME
        // resolution chain as the live recv-loop arm in
        // index.html:6968-7137 (KIND_SOUND_TRIGGERED handler):
        //
        //   1. Look up `entityManager.entityMap.get(guid)`.
        //   2. Read `inst.soundTableDid`; bail soft if zero.
        //   3. `soundTableCache.resolveSound(stbDid, soundEnum)` →
        //      probability-weighted SoundEntry pick.
        //   4. Push event-log record with source="GameMessageSound"
        //      + source_meta `{server_object_guid, sound_enum,
        //      stb_did, scale, gain, synthetic_probe: true}`.
        //   5. `audioManager.play(waveDid, pos, { gain })`.
        //
        // Returns a Promise that resolves with one of:
        //   { ok: true, waveDid, gain }   — full chain landed
        //   { ok: false, reason: "..." }  — soft-skip case
        //
        // The `synthetic_probe: true` flag in source_meta lets the
        // F.D validator distinguish synth fires from real ACE
        // pushes during cross-source diffing.
        //
        // Usage from a validator:
        //   await window.__synthGameMessageSound(guid, 0x46, 1.0);
        //   await window.__synthGameMessageSound(guid, 0x51);  // scale=1
        window.__synthGameMessageSound = async (guid, soundEnum, scale) => {
          const safeScale = (typeof scale === "number" && scale > 0) ? +scale : 1.0;
          const result = {
            ok: false,
            reason: null,
            guid: (guid >>> 0),
            soundEnum: (soundEnum >>> 0),
            scale: safeScale,
          };
          const live = window.liveScene3d;
          if (!live) {
            result.reason = "no_liveScene3d";
            return result;
          }
          const emgr = live.entityManager;
          const cache = live.soundTableCache;
          const audioMgr = live.audioManager;
          const pushRec = live._pushEventRecord;
          if (!emgr || !cache || !audioMgr) {
            result.reason = "subsystems_not_ready";
            return result;
          }
          const inst = emgr.entityMap?.get(guid >>> 0);
          if (!inst) {
            result.reason = "entity_not_in_registry";
            return result;
          }
          const stbDid = (inst.soundTableDid >>> 0);
          if (!stbDid) {
            result.reason = "entity_no_sound_table";
            return result;
          }
          let entry;
          try {
            entry = await cache.resolveSound(stbDid, soundEnum >>> 0);
          } catch (e) {
            result.reason = `resolveSound_threw:${String(e?.message ?? e)}`;
            return result;
          }
          if (!entry) {
            result.reason = "enum_not_in_sound_table";
            return result;
          }
          const pos = inst.root?.position;
          if (!pos) {
            result.reason = "entity_no_position";
            return result;
          }
          const baseVol = entry.volume > 0 ? entry.volume : 1.0;
          const gain = baseVol * safeScale;
          if (typeof pushRec === "function") {
            pushRec({
              type: "sound",
              wave_did: (entry.waveDid >>> 0),
              parent_entity_guid: (guid >>> 0),
              world_pos: [+pos.x, +pos.y, +pos.z],
              t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
              source: "GameMessageSound",
              source_meta: {
                server_object_guid: (guid >>> 0),
                sound_enum: (soundEnum >>> 0),
                stb_did: stbDid,
                scale: safeScale,
                gain,
                synthetic_probe: true,
              },
            });
          }
          try {
            await audioMgr.play(
              entry.waveDid >>> 0,
              { x: pos.x, y: pos.y, z: pos.z },
              { gain }
            );
          } catch (e) {
            // Play failure is non-fatal — the record is in the log,
            // which is what the validator asserts on. AudioContext
            // gating can fail under headless without a user gesture
            // even with `--autoplay-policy=no-user-gesture-required`.
            result.playError = String(e?.message ?? e);
          }
          result.ok = true;
          result.waveDid = (entry.waveDid >>> 0);
          result.gain = gain;
          return result;
        };
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

  // Sky-K.6 cleanup (2026-05-18): the Sky-E/Sky-D resolveSkyAssets +
  // populateCelestialBodies bridge that fetched the 7 retail SkyObject
  // GfxObj/SetupModel meshes (sun, moon, cloud bands, stars, etc.) and
  // populated them under skyDome.skyCell is gone — the atmosphere stack
  // (takram SkyMaterial + stars + ac_moons + volumetric clouds) renders
  // those celestial elements physically, so the parametric DAT-driven
  // meshes are no longer instantiated. liveScene3d.skyAssets stays as
  // a stub on the live object for any external consumer that probes
  // for its presence.

  // Phase 7.4b — install the shared-drain hook last so the
  // window-level hook references the final EntityManager instance.
  // The 2D drainEvents at index.html:5723 can call
  // window.__scene3dEntityHook(upd) for each EntityUpdate to forward
  // it into the 3D path.
  installSharedDrainHook(liveScene3d);

  // 2026-05-21 wire-agent — camera alignment helper. Driver scripts
  // touring landblocks via @teleloc need the camera to point in the
  // player's facing direction so the screenshot shows what's IN FRONT
  // of the character, not the side. cameraSwitcher's `followYaw`
  // doesn't auto-track player heading (the mouse drag does normally);
  // this helper snaps yaw to current heading + resets pitch/distance
  // to defaults. One-shot — call before each screenshot.
  // eslint-disable-next-line no-undef
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-undef
    window.__wireCameraAlignBehindPlayer = function () {
      const cs = liveScene3d?.cameraSwitcher;
      // eslint-disable-next-line no-undef
      const handle = window.__sessionHandle;
      if (!cs || !handle || typeof handle.getLocalPlayerPose !== "function") {
        return { ok: false, reason: "no-camera-or-session" };
      }
      const p = handle.getLocalPlayerPose();
      if (!p || typeof p.heading !== "number") {
        return { ok: false, reason: "no-heading-yet" };
      }
      cs.followYaw = p.heading;
      cs.followPitch = 0.3;
      cs.followDistance = 6.0;
      return { ok: true, heading: +p.heading.toFixed(3), pose: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } };
    };
  }

  // 2026-05-21 wire-agent — fire the terminal `ready` boot-state
  // signal. The normal path fires it inside the atmosphereRuntime
  // .whenReady() callback (~L2111), but that whole atmosphere/sky/
  // composer block sits inside an `else try { ... }` that wireframe
  // mode skips. We've now completed every wireframe-relevant init
  // (terrain + buildings + statics + entities) and the render loop
  // is rAF-driven; signal ready so the autoLogin state machine in
  // index.html doesn't time out at 90s.
  if (wireframeMode) {
    try {
      // eslint-disable-next-line no-undef
      window.__setBootState?.(
        "ready",
        "wire-agent scene ready (atmosphere/composer/clouds/skydome/CSM skipped)"
      );
    } catch {}
  }

  return liveScene3d;
}
