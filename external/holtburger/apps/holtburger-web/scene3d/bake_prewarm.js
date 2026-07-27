// bake_prewarm.js (Item 4, 2026-06-22) — GPU shader/texture pre-warm for streamed bakes.
//
// The 1070 headless probe (docs/PLAN-goal1-drawdistance-streaming-throttle-2026-06-22.md)
// showed the `pvsRingRadius=10` fill stall is CPU-compute-bound: shader-program LINK
// (`(program)` ≈20–32 %) + texture upload, alongside wasm decode. The terrain/statics/
// buildings lazy bakers attach their meshes straight to the live scene graph, so the
// program link + DataTexture upload happen SYNCHRONOUSLY on the first render frame after
// attach — a per-frame hitch that scales with how many bakes land together.
//
// `prewarmSubtree` runs `renderer.compileAsync(subtree, camera, scene)` BEFORE the subtree
// joins the scene, so on real GPUs (KHR_parallel_shader_compile) the compile + upload happen
// in the driver background while JS continues, and the await also yields to the event loop —
// spreading multiple bakes' attaches across frames. Mirrors the EnvCell prewarm (cells.js).
//
// SAFETY w.r.t. the A1–A4 / envcell-guard invariants: the per-LB bakers are NOT
// LRU-tracked until they RESOLVE (index.js `loadXForLandblock` calls `landblockLru.track`
// AFTER `await bake…`), and the stream guard holds the `(kind,lbKey)` in-flight key for the
// baker's whole duration, so an LB cannot be evicted mid-bake — adding a compileAsync await
// before the attach needs no residency re-check for the synchronous-tail bakers (terrain,
// buildings). statics time-slices its build loop and keeps its own eviction guard, so it
// re-checks residency after the prewarm await (see statics.js).
//
// `?bakePrewarm=off` restores the legacy attach-then-lazy-compile behaviour.

export const BAKE_PREWARM = (() => {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.search) {
      return new URLSearchParams(globalThis.location.search).get("bakePrewarm") !== "off";
    }
  } catch (_) {}
  return true;
})();

/**
 * P6 hardening (2026-07-10, ci-smoke S2) — guarded re-implementation of
 * three's `WebGLRenderer.compileAsync` ready-poll. The stock helper's
 * `checkMaterialsReady` runs in a setTimeout chain and reads
 * `properties.get(material).currentProgram.isReady()` unguarded — a material
 * disposed while its program is still linking (spawn-burst churn: appearance
 * re-decode / despawn / sealed purge) leaves `currentProgram` undefined and
 * the poll throws an UNCAUGHT TypeError ("reading 'isReady'") that no caller
 * try/catch can reach (it fires inside three's own timer callback). Same
 * semantics + same 10 ms poll, but a vanished/never-assigned program counts
 * as done. Sync-compile backends (SwiftShader) resolve on the first check.
 *
 * @returns {Promise<void>} rejects only if the synchronous compile() throws
 */
export function guardedCompileAsync(renderer, object, camera, targetScene) {
  let materials;
  try {
    materials = renderer.compile(object, camera, targetScene);
  } catch (e) {
    return Promise.reject(e);
  }
  if (!materials || typeof materials.forEach !== "function" || materials.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = () => {
      try {
        materials.forEach((material) => {
          let program = null;
          try {
            program = renderer.properties.get(material).currentProgram;
          } catch (_) { /* disposed → treat as done */ }
          if (!program || typeof program.isReady !== "function" || program.isReady()) {
            materials.delete(material);
          }
        });
      } catch (_) {
        return resolve(); // never leak an uncaught throw out of the poll
      }
      if (materials.size === 0) return resolve();
      setTimeout(check, 10);
    };
    check();
  });
}

/**
 * Pre-warm one Object3D subtree's shader programs + texture uploads.
 * Fail-soft: never throws — on a missing renderer/camera/compile or any compile error
 * the subtree simply lazy-compiles on first render (legacy behaviour). The caller awaits
 * this BEFORE attaching the subtree to the live scene graph.
 *
 * @param {{renderer?: any, camera?: any, scene?: any}} scene3d
 * @param {import("three").Object3D} object subtree to compile (a Mesh, Group, or temp parent)
 * @returns {Promise<void>}
 */
export async function prewarmSubtree(scene3d, object) {
  if (!BAKE_PREWARM || !object) return;
  const host = _renderHost(scene3d);
  const renderer = host && host.renderer;
  const camera = host && host.camera;
  if (!renderer || !camera || typeof renderer.compile !== "function") return;
  try {
    await guardedCompileAsync(renderer, object, camera, host.scene);
  } catch (_) {
    /* fail-soft: the subtree lazy-compiles on first render */
  }
}

// P6 fixup (2026-07-10): several callers hold the BUILDERS scene3d bag
// (`scene3dForBuilders` — wasmExports + groups + caches), which carries NO
// renderer/camera; only the `liveScene3d` facade does. A warm handed the
// builders bag would silently no-op (exactly what the entity-warm probe
// caught: archetypeParked=0). Resolve the render host with a fallback to
// `window.liveScene3d` — set at init3D's end, i.e. before any entity spawn
// can dispatch (the shared drain hook installs after it). Non-browser
// contexts (workers/tests) keep the old no-op behavior.
function _renderHost(scene3d) {
  if (scene3d && scene3d.renderer && scene3d.camera) return scene3d;
  try {
    const ls = typeof window !== "undefined" ? window.liveScene3d : null;
    if (ls && ls.renderer && ls.camera) return ls;
  } catch (_) {}
  return scene3d;
}

// ============================================================================
// P6/R-6 (net-fixwave 2026-07-10) — ENTITY program warm
// ============================================================================
// World bakes (terrain/buildings/statics/envcells) were compileAsync'd before
// attach, but ENTITY materials never were: every player arrival in a hub
// could link a not-yet-seen variant synchronously at first draw (~1–2 s per
// link at the 16/2 light pool on the 1070 — A10-F1, A08-1, the recurring
// never-fixed S2 slice). Two layers land here:
//   1. per-spawn rig warm (entities.js Step E) — reuses `prewarmSubtree` on
//      the fully-built rig, `?entityWarm=off`;
//   2. the one-shot login-idle archetype matrix below, `?archetypeWarm=off`.

import * as THREE from "three";

function _defaultOnFlag(name) {
  try {
    if (typeof globalThis !== "undefined" && globalThis.location?.search) {
      const v = new URLSearchParams(globalThis.location.search).get(name)?.toLowerCase();
      return !(v === "off" || v === "0" || v === "false");
    }
  } catch (_) {}
  return true;
}
export const ENTITY_WARM_ON = _defaultOnFlag("entityWarm");
export const ARCHETYPE_WARM_ON = _defaultOnFlag("archetypeWarm");

// A10-O1 — login-idle archetype-matrix warm. Once per session, shortly after
// the LOCAL player's rig commits (the in-world signal; the delay lets the
// boot flood + async AtmosphereLights attach settle first — A10-F3),
// compileAsync ONE offscreen proxy mesh per distinct ENTITY-family program
// variant so later per-spawn warms and first draws become program-cache
// hits. Axes derive from the entities.js mint sites (raw UN-patched
// MeshStandardMaterial — a SEPARATE program population from the "hb|"-keyed
// world materials, which the world bakes already warm): {map, mapless} ×
// {alphaTest 0/0.5 — the clipmap USE_ALPHATEST fork; the nonzero value is
// REPRESENTATIVE only, since three carries the ref as a uniform and RND-08/33
// made the live clipmap ref per-format 0.392/0.784} × {transparent on/off},
// plus the two particle-unlit MeshBasic blends (additive/alpha). Skinning is
// NOT an axis (rigid part rigs — zero SkinnedMesh), and the paletted
// luminous path sets only the emissive COLOR (a uniform, not a define) on
// default flags, so no emissiveMap variant is needed; novel cache-path
// ("hb|") variants stay covered by the per-spawn rig warm. NOTE: the proxies
// are PARKED on `scene3d._archetypeWarmGroup`, never disposed — three's
// program cache refcounts by material, so disposing them would release the
// very programs this warmed. Cost: ~9 tiny materials + one 3-vert geometry +
// a 1×1 DataTexture, held for the session.
let _archetypeWarmState = "idle"; // "idle" | "scheduled" | "done"

export function scheduleArchetypeWarm(scene3d, delayMs = 4000) {
  if (!ARCHETYPE_WARM_ON || _archetypeWarmState !== "idle") return;
  if (typeof setTimeout !== "function") return;
  _archetypeWarmState = "scheduled";
  setTimeout(() => {
    _runArchetypeWarm(scene3d).catch(() => {
      /* fail-soft: variants lazy-compile on first draw (legacy) */
    });
  }, delayMs);
}

async function _runArchetypeWarm(scene3d) {
  _archetypeWarmState = "done";
  const host = _renderHost(scene3d);
  const renderer = host && host.renderer;
  const camera = host && host.camera;
  if (!renderer || !camera || typeof renderer.compileAsync !== "function") {
    // eslint-disable-next-line no-console
    console.info("[bake_prewarm] archetype warm skipped: no renderer/camera on any host");
    return;
  }
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = "archetype-warm-proxies";
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3)
  );
  geom.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
  );
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  let count = 0;
  const push = (mat) => {
    group.add(new THREE.Mesh(geom, mat));
    count += 1;
  };
  // Entity-lit family — the exact entities.js mint shape.
  for (const alphaTest of [0, 0.5]) {
    for (const transparent of [false, true]) {
      const m = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.9,
        metalness: 0.0,
        side: THREE.DoubleSide,
        transparent,
      });
      if (alphaTest) m.alphaTest = alphaTest;
      push(m);
    }
  }
  // Mapless (the shared grey-fallback / no-texture class).
  push(
    new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.DoubleSide,
    })
  );
  // Particle-unlit family (entity VFX billboards — never previously warmed).
  push(
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  push(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  try {
    await guardedCompileAsync(renderer, group, camera, host.scene);
  } catch (_) {
    /* fail-soft */
  }
  // Park (never dispose) — see the refcount note above. Parked on the HOST
  // (the facade probes read) as well as the caller's bag.
  host._archetypeWarmGroup = group;
  if (scene3d && scene3d !== host) scene3d._archetypeWarmGroup = group;
  // eslint-disable-next-line no-console
  console.info(
    `[bake_prewarm] archetype warm: ${count} proxy materials compiled in ` +
      `${Math.round(performance.now() - t0)} ms`
  );
}
