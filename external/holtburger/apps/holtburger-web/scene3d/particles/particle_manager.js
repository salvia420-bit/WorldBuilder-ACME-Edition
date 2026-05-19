// Workstream Sky-J P4 (2026-05-12) — JS port of ACE's
// `external/ACE/Source/ACE.Server/Physics/Particles/ParticleManager.cs`.
//
// Top-level coordinator: owns a Map<id, ParticleEmitter>, dispatches
// per-tick updates, and provides the public `addEmitter()` API that
// P5 (sky_dome integration) will call when walking the PhysicsScript's
// CreateParticleHook entries.
//
// **Mesh construction.** P4 doesn't fetch any DAT data itself. Callers
// pass two factory callbacks at construction:
//   geometryFactory(hwGfxObjId): Promise<THREE.BufferGeometry>
//   materialFactory(hwGfxObjId): Promise<THREE.Material>
// Per emitter, the manager calls each factory ONCE (the geometry +
// material are shared across all max-particle slots — though each slot
// gets its OWN material clone so per-particle opacity lerps don't
// stomp each other).

import * as THREE from "three";

import { ParticleEmitter } from "./particle_emitter.js";
import { ParticleEmitterInfo } from "./particle_emitter_info.js";

// Perf E5 (2026-05-18) — URL escape hatch `?particleSortObjects=off`.
// Read once at module-load; stash on `window.__particleSortObjects` so the
// scene-construction site (scene3d/index.js:301, `new THREE.Scene()`) can
// pick it up and set `scene.sortObjects = false`. Default ON (existing
// behaviour). This is intentionally a window-globals handoff: this file
// has no reference to the THREE.Scene root (we only see `opts.scene` per
// emitter, which is typically a child Group like worldRoot, not the root).
//
// TODO(E5): scene3d/index.js (where `new THREE.Scene()` lives) should
// honour `window.__particleSortObjects === false` immediately after
// constructing the Scene. One-line wiring:
//   if (window.__particleSortObjects === false) scene.sortObjects = false;
{
  let sortObjects = true;
  try {
    if (typeof window !== "undefined" && window.location) {
      const params = new URLSearchParams(window.location.search);
      const v = params.get("particleSortObjects");
      if (v != null && v.toLowerCase() === "off") {
        sortObjects = false;
      }
    }
  } catch (_) {
    // SSR / non-browser context (tests): leave default ON.
  }
  if (typeof window !== "undefined") {
    window.__particleSortObjects = sortObjects;
  }
}

// Perf E3 (2026-05-18) — dispose helper for `destroyParticleEmitter` to
// free per-slot cloned materials. Mirrors the `__disposable` /
// `__cacheOwned` tag convention introduced by B3 in entities.js (commit
// 5f4b8a6); duplicated locally to keep particle_manager self-contained.
// Only materials carrying `userData.__disposable === true` are freed —
// cache-owned references (e.g. anything returned by the shared
// MaterialCache) are skipped to avoid crashing other renderers that
// still hold the same GPU resource.
function _disposeMaterialIfOwned(mat) {
  if (!mat) return;
  const ud = mat.userData;
  if (!ud) return;
  if (ud.__cacheOwned === true && ud.__disposable === true) {
    // Programmer error: a cache material was tagged disposable at some
    // clone site that should have stayed cache-owned. Disposing would
    // free the shared GPU resource other emitters still reference.
    // eslint-disable-next-line no-console
    console.error(
      "[particle_manager/E3] _disposeMaterialIfOwned: material is BOTH __cacheOwned and __disposable —" +
        " refusing to dispose. Audit the clone site that produced it.",
      { name: mat.name, userData: ud }
    );
    return;
  }
  if (ud.__disposable !== true) return;
  try {
    mat.dispose();
  } catch (_) {}
}

export class ParticleManager {
  /**
   * @param {object} opts
   * @param {THREE.Object3D} opts.scene Where active particle meshes are added.
   * @param {(hwGfxObjId:number) => Promise<THREE.BufferGeometry>|THREE.BufferGeometry} opts.geometryFactory
   * @param {(hwGfxObjId:number) => Promise<THREE.Material>|THREE.Material} opts.materialFactory
   */
  constructor(opts) {
    this.nextEmitterId = 1;
    /** @type {Map<number, ParticleEmitter>} */
    this.particleTable = new Map();
    this._scene = opts.scene;
    this._geometryFactory = opts.geometryFactory;
    this._materialFactory = opts.materialFactory;
  }

  /** ACE `GetNumEmitters()` (ParticleManager.cs:47-50). */
  getNumEmitters() {
    return this.particleTable.size;
  }

  /**
   * Public API: install an emitter from a parsed ParticleEmitterJs.
   *
   * @param {object} req
   * @param {object} req.emitterInfo Wasm ParticleEmitterJs OR a POJO with
   *        the same camelCase fields (tests use the POJO form).
   * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion, partFrames?: object[]}} req.parent
   *        PhysicsObj-like anchor (e.g. the sky-cell's moon SetupModel).
   * @param {number} [req.partIndex] -1 (default) for whole-object, else
   *        index into parent.partFrames.
   * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion}} [req.parentOffset]
   *        Optional offset frame (default origin + identity rotation).
   * @param {number} [req.emitterId] Caller-supplied ID. If 0/undefined,
   *        the manager assigns one from `nextEmitterId`.
   * @returns {Promise<number>} The emitter ID. 0 on failure (hwGfxObjId==0).
   */
  async addEmitter(req) {
    const {
      emitterInfo,
      parent,
      partIndex = -1,
      parentOffset = null,
      emitterId = 0,
    } = req;

    // ACE: if emitterID is non-zero and already in table, REMOVE old
    // entry first (CreateParticleEmitter, line 28-29).
    if (emitterId !== 0 && this.particleTable.has(emitterId)) {
      this.particleTable.delete(emitterId);
    }

    const info = (emitterInfo instanceof ParticleEmitterInfo)
      ? emitterInfo
      : new ParticleEmitterInfo(emitterInfo);

    // Build the shared geometry + per-slot material clones.
    const geometry = await this._geometryFactory(info.hwGfxObjId);
    const baseMaterial = await this._materialFactory(info.hwGfxObjId);

    const emitter = new ParticleEmitter({
      parent,
      scene: this._scene,
      meshFactory: async (_slotIdx) => {
        // Per-slot mesh: shared geometry, cloned material so per-particle
        // opacity lerps don't stomp neighbors.
        const mat = baseMaterial ? baseMaterial.clone() : null;
        if (mat) {
          // Perf E5 (2026-05-18) — material-flag classification by AC
          // BlendMode. Neither `holtburger_dat::ParticleEmitter` (the DAT
          // struct) nor the wasm `ParticleEmitterJs` getter surface (see
          // src/lib.rs:18315) carry a blend-mode field — AC determines
          // particle blending from the referenced GfxObj's material, not
          // from the emitter record. Per the E5 briefing, that means the
          // JS particle layer has no per-emitter classification to branch
          // on, so we ship the agreed conservative middle ground for ALL
          // particles: `transparent=true` + `alphaTest=0.1` + `depthWrite
          // =true`. The alphaTest catches near-zero alpha and enables
          // depth-write for those pixels, which is most of the depth-write
          // win even on soft-edged sprites. Default blending remains
          // `THREE.NormalBlending` (cloned from baseMaterial).
          //
          // TODO(E5): per-emitter BlendMode classification (Additive vs
          // Alpha) requires `particle_emitter_info.js` (and upstream
          // `ParticleEmitterJs` in src/lib.rs + the `holtburger_dat`
          // `ParticleEmitter` struct) to expose a blend-mode field. The
          // intended branch when that lands:
          //   - Additive (BlendMode::Add): transparent=true,
          //     blending=THREE.AdditiveBlending, depthWrite=false, no
          //     alphaTest.
          //   - Alpha (BlendMode::Alpha): the current conservative path.
          mat.transparent = true;
          mat.alphaTest = 0.1;
          mat.depthWrite = true;
          // Perf E3 (2026-05-18): tag the clone so destroyParticleEmitter()
          // can dispose it. The base material from materialFactory may be
          // cache-owned — only the per-slot CLONE is owned by this emitter.
          mat.userData.__disposable = true;
        }
        // NOTE: `geometry` is shared across all slots and originates from
        // the caller-supplied `geometryFactory` (typically a DAT-backed
        // cache, e.g. the sky-cell hwGfxObjId lookup). Per the B3
        // convention, cache-owned geometries are NOT disposed by us; we
        // leave them alone and let the cache outlive the emitter.
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.frustumCulled = false; // sky-cell particles always render
        mesh.visible = false;
        return mesh;
      },
    });

    const ok = await emitter.setInfo(info);
    if (!ok) {
      return 0;
    }
    const offsetFrame = parentOffset ?? {
      position: new THREE.Vector3(0, 0, 0),
      quaternion: new THREE.Quaternion(),
    };
    if (!emitter.setParenting(partIndex, offsetFrame)) {
      return 0;
    }
    emitter.initEnd();

    const id = (emitterId !== 0) ? emitterId : this.nextEmitterId++;
    emitter.id = id;
    this.particleTable.set(id, emitter);
    return id;
  }

  /** ACE `UpdateParticles()` (ParticleManager.cs:52-64). Per-frame. */
  tick() {
    const removeIds = [];
    for (const [id, emitter] of this.particleTable) {
      if (!emitter.updateParticles()) {
        removeIds.push(id);
      }
    }
    for (const id of removeIds) {
      const e = this.particleTable.get(id);
      // Free remaining meshes from the scene (the slot loop in
      // updateParticles already removed the active ones; PartStorage may
      // still hold mesh refs that were never claimed).
      if (e && e.parts) {
        for (let i = 0; i < e.parts.length; i++) {
          const m = e.parts[i];
          if (m && m.parent) m.parent.remove(m);
        }
      }
      this.particleTable.delete(id);
    }
  }

  /** ACE `StopParticleEmitter()` (ParticleManager.cs:66-73). */
  stopParticleEmitter(emitterId) {
    if (emitterId === 0) return false;
    const e = this.particleTable.get(emitterId);
    if (!e) return false;
    e.stopped = true;
    return true;
  }

  /** ACE `DestroyParticleEmitter()` (ParticleManager.cs:75-81). */
  destroyParticleEmitter(emitterId) {
    if (emitterId === 0) return false;
    const e = this.particleTable.get(emitterId);
    if (!e) return false;
    if (e.parts) {
      for (let i = 0; i < e.parts.length; i++) {
        const m = e.parts[i];
        if (m && m.parent) m.parent.remove(m);
      }
    }
    // Perf E3 (2026-05-18): dispose per-slot cloned materials before
    // dropping the emitter from tracking. We walk `partStorage` (every
    // allocated mesh) rather than `parts` (only currently-claimed slots,
    // which may have been nulled by killParticle()) so that materials
    // from never-emitted slots are also released. Geometry is shared
    // across slots and cache-owned by the geometryFactory — we do NOT
    // dispose it here.
    //
    // TODO(E3): the `tick()` auto-removal path (~line 121) drops dead
    // emitters from the table without this disposal walk. Same leak
    // pattern; scoped out of this PR. Follow-on welcome.
    if (e.partStorage) {
      for (let i = 0; i < e.partStorage.length; i++) {
        const slotMesh = e.partStorage[i];
        if (!slotMesh) continue;
        _disposeMaterialIfOwned(slotMesh.material);
      }
    }
    return this.particleTable.delete(emitterId);
  }
}
