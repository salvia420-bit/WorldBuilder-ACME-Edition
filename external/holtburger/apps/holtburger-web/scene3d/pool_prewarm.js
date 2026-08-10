// scene3d/pool_prewarm.js — the CLOSED-CLASS boot prewarm (ST9 / T22;
// SPEC §1.6, pass-08 D-08.6 + S5, pass-07 D-07.9).
//
// WHY THIS EXISTS
// ---------------
// The p99 tail's #1 stall class is synchronous shader LINKS: 43 programs
// force-linking mid-walk at 172–849 ms each [M, p99 doc #1]. Today those
// links are manufactured by streaming — a new landblock brings first-sight
// materials, and each new material is a new program.
//
// Under pools the class set is CLOSED at boot (D-07.9): a class exists per
// (domain, render state, patch set, array page, shadow pair), and that set is
// fixed by content statics, not by which tile streamed in. **Streaming a new
// tile creates ZERO new materials and ZERO new programs.** That turns the
// tail's #1 term from "unbounded, arrives while you walk" into "enumerable at
// boot, warm it once" — and the class census IS the prewarm work list.
//
// THE TWO WARM SCENES (pass-08 S5; both anchors read-verified)
// -----------------------------------------------------------
// 1. **COLOR** — one 3-vertex instance per class in a warm scene, compiled
//    through `withWarmTarget` so the compiled key carries the composer's
//    non-null-target variant (the 2131 → 369 ms mechanism, default-ON since
//    2026-08-06), driven by `guardedCompileAsync`'s ready-poll.
//
// 2. **DEPTH — the population `renderer.compile` CANNOT REACH.** r184's
//    `compile` walks scene MATERIALS only; the CSM depth variants are minted
//    by `WebGLShadowMap.getDepthMaterial` per (object, material, light-type)
//    during a shadow pass. So the depth warm is **a RENDER, not a compile**:
//    a scene of the castShadow classes plus N cascade DirectionalLights with
//    tiny shadow maps, `shadowMap.needsUpdate = true`, one
//    `renderer.render(sceneB, cam)` to the warm target.
//
//    And the proxies MUST be real `BatchedMesh`es: `batching` is a
//    program-parameter axis derived from the OBJECT, so a plain-Mesh proxy
//    warms the WRONG depth variant and the walk still links. This is the
//    single most common way a prewarm silently does nothing, so
//    `_makeProxy` builds BatchedMesh and the battery asserts it.
//
// LIFETIME — both warm scenes are PARKED for the session and NEVER disposed
// (three refcounts programs; disposing the warm scene releases the very
// programs it linked — the bake_prewarm.js:166-170 rule). Re-warm triggers:
// context restore, and a quality-preset flip that changes the CSM cascade
// count (a new depth population). It is NOT re-run on streaming — that is the
// entire point, and a post-boot class mint is a bug the registry counts
// (`classesCreatedPostBoot`).

import * as THREE from "three";
import { withWarmTarget } from "./shader_prewarm.js";
import { guardedCompileAsync } from "./bake_prewarm.js";

/** Cascade count to warm when the live CSM config is unknown (high/ultra). */
export const DEFAULT_CASCADES = 3;
/** Shadow-map edge for the warm lights — small on purpose: the link is the
 *  product, the pixels are not. */
export const WARM_SHADOW_MAP_SIZE = 64;

/**
 * The prewarm WORK LIST: one entry per class, with the castShadow bit that
 * decides whether it also needs a depth variant. Derived from the pool
 * registry's live class table — the census IS the work list (D-07.9), so
 * there is no second source that can drift.
 *
 * @param {import("./pool_registry.js").PoolRegistry} registry
 * @returns {Array<{classKey:string, material:object, castShadow:boolean, passClass:string}>}
 */
export function prewarmWorkList(registry) {
  const out = [];
  if (!registry || !registry.classes) return out;
  for (const [classKey, cls] of registry.classes) {
    // The shadow token is the key's last field: `c{0|1}r{0|1}`.
    const shadow = classKey.slice(classKey.lastIndexOf("|") + 1);
    out.push({
      classKey,
      material: cls.material,
      castShadow: shadow.startsWith("c1"),
      passClass: cls.passClass,
    });
  }
  return out;
}

function _makeProxy(material) {
  // ONE 3-vertex instance in a REAL BatchedMesh — `batching` is a program
  // parameter derived from the object, so a plain Mesh would warm the wrong
  // variant (read-verified; the whole reason this is not a Mesh).
  const bm = new THREE.BatchedMesh(1, 3, 3, material);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  g.setIndex([0, 1, 2]);
  const gid = bm.addGeometry(g);
  const id = bm.addInstance(gid);
  bm.setMatrixAt(id, new THREE.Matrix4());
  bm.frustumCulled = false;
  return bm;
}

export class PoolPrewarm {
  /**
   * @param {object} deps
   * @param {object} deps.renderer
   * @param {object} deps.camera
   * @param {object} [deps.targetScene]  the live scene (compile's 3rd arg)
   * @param {()=>number} [deps.cascades] live CSM split count
   * @param {()=>number} [deps.now]
   * @param {(m:string,d?:any)=>void} [deps.warn]
   */
  constructor({ renderer, camera, targetScene = null, cascades, now, warn } = {}) {
    this.renderer = renderer;
    this.camera = camera || new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.targetScene = targetScene;
    this.cascades = typeof cascades === "function" ? cascades : () => DEFAULT_CASCADES;
    this.now = typeof now === "function" ? now : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };

    /** PARKED for the session — never disposed (program refcount). */
    this.colorScene = null;
    this.depthScene = null;
    this._warmedClasses = new Set();
    this._cascadesWarmed = 0;

    this.stats = {
      classes: 0, colorPrograms: 0, depthPrograms: 0,
      msColor: 0, msDepth: 0, runs: 0, rewarms: 0,
      cascades: 0, skipped: 0, lastError: null, complete: false,
    };
  }

  /**
   * Run the boot prewarm over a work list. Idempotent per class: a re-run
   * warms only classes not already warmed (so a context-restore re-warm is
   * cheap and a post-boot mint costs exactly one class).
   *
   * @param {Array} workList  from `prewarmWorkList(registry)`
   * @param {{force?: boolean}} [opts]
   */
  async run(workList, opts = {}) {
    const list = (workList || []).filter((c) => opts.force || !this._warmedClasses.has(c.classKey));
    this.stats.runs += 1;
    if (list.length === 0) { this.stats.complete = true; return this.stats; }
    if (!this.renderer) {
      // No renderer surface (bot arm / node) — the work list is still the
      // deliverable; record the skip rather than pretending to warm.
      this.stats.skipped += list.length;
      return this.stats;
    }

    // ── scene A: colour variants ────────────────────────────────────────
    if (!this.colorScene) this.colorScene = new THREE.Scene();
    const addedColor = [];
    for (const c of list) {
      const proxy = _makeProxy(c.material);
      proxy.name = `prewarm-color-${c.classKey.slice(0, 24)}`;
      this.colorScene.add(proxy);
      addedColor.push(proxy);
    }
    const t0 = this.now();
    try {
      await guardedCompileAsync(this.renderer, this.colorScene, this.camera, this.targetScene);
      this.stats.colorPrograms += addedColor.length;
    } catch (e) {
      this.stats.lastError = String(e && e.message || e);
      this.warn("[poolPrewarm] colour warm failed (non-fatal)", e);
    }
    this.stats.msColor += this.now() - t0;

    // ── scene B: CSM depth variants (a RENDER, not a compile) ───────────
    const casters = list.filter((c) => c.castShadow);
    const cascades = Math.max(1, this.cascades() | 0);
    if (casters.length > 0) {
      if (!this.depthScene || this._cascadesWarmed !== cascades) {
        this.depthScene = new THREE.Scene();
        this._cascadesWarmed = cascades;
        for (let i = 0; i < cascades; i++) {
          const light = new THREE.DirectionalLight(0xffffff, 1);
          light.castShadow = true;
          light.shadow.mapSize.set(WARM_SHADOW_MAP_SIZE, WARM_SHADOW_MAP_SIZE);
          light.position.set(1 + i, 2 + i, 3 + i);
          this.depthScene.add(light);
          this.depthScene.add(light.target);
        }
      }
      for (const c of casters) {
        const proxy = _makeProxy(c.material);
        proxy.name = `prewarm-depth-${c.classKey.slice(0, 24)}`;
        proxy.castShadow = true;
        this.depthScene.add(proxy);
      }
      const t1 = this.now();
      try {
        // ONE render forces WebGLShadowMap through getDepthMaterial per
        // (object, material, light-type) and links every depth program off
        // the critical path. withWarmTarget keeps the composer variant key.
        withWarmTarget(this.renderer, () => {
          if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
          this.renderer.render(this.depthScene, this.camera);
        });
        this.stats.depthPrograms += casters.length;
      } catch (e) {
        this.stats.lastError = String(e && e.message || e);
        this.warn("[poolPrewarm] depth warm failed (non-fatal)", e);
      }
      this.stats.msDepth += this.now() - t1;
    }

    for (const c of list) this._warmedClasses.add(c.classKey);
    this.stats.classes = this._warmedClasses.size;
    this.stats.cascades = cascades;
    this.stats.complete = true;
    return this.stats;
  }

  /** Context restore / CSM preset flip — re-warm everything from scratch. */
  async rewarm(workList) {
    this.stats.rewarms += 1;
    this._warmedClasses.clear();
    // The warm scenes are NOT disposed (program refcount); the depth scene is
    // rebuilt only when the cascade count changed, which `run` handles.
    return this.run(workList, { force: true });
  }

  /** `__prewarmStats` (pass-08 S5.4). */
  statsSnapshot() {
    return { ...this.stats };
  }
}

// ---------------------------------------------------------------------------
// singleton + surface
// ---------------------------------------------------------------------------

let _prewarm = null;

export function getPoolPrewarm() {
  return _prewarm;
}

/**
 * Build the prewarm and install `__prewarmStats`. Call once at boot, AFTER
 * the class census settles (the ring feed is complete) and BEFORE the
 * `preview-complete` milestone is declared — a declared `preview-complete`
 * implies warm-complete (pass-08 S1's milestone gating).
 */
export function initPoolPrewarm(deps = {}) {
  _prewarm = new PoolPrewarm(deps);
  if (typeof window !== "undefined") {
    try {
      window.__prewarmStats = () => (_prewarm ? _prewarm.statsSnapshot() : { complete: false });
    } catch (_) { /* fail-soft */ }
  }
  return _prewarm;
}

/** Test hook. */
export function _resetPoolPrewarmForTest() {
  _prewarm = null;
}
