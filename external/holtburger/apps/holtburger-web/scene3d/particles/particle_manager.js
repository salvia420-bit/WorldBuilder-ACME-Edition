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

    // Perf FU4 (2026-05-18) — classify additive-vs-alpha BEFORE the
    // per-slot clone loop so all slots of one emitter take the same
    // branch. The signal lives on the upstream baseMaterial produced by
    // MaterialCache._materialFromFlags (scene3d/materials.js:960), which
    // decodes AC's `Surface.surface_type` bitfield:
    //   - Bit 0x10000 (Additive) → `material.blending = AdditiveBlending`
    //     + `transparent=true` + `depthWrite=false` (materials.js:998-1003)
    //   - All other paths leave `material.blending` at the default
    //     (`THREE.NormalBlending`).
    // `.clone()` preserves `material.blending`, so the primary probe is
    // simply `baseMaterial.blending === THREE.AdditiveBlending`. We also
    // accept the fallback path of reading `userData.surfaceTypeFlags`
    // (tagged on every cache material at materials.js:1191-1201 and
    // :1550 and :1610) and AND-ing the Additive bit — this catches the
    // hypothetical case where a clone upstream of us reset `blending`
    // but preserved userData. Either signal flips the branch.
    let baseIsAdditive = false;
    if (baseMaterial) {
      if (baseMaterial.blending === THREE.AdditiveBlending) {
        baseIsAdditive = true;
      } else {
        const flags = (baseMaterial.userData?.surfaceTypeFlags ?? 0) >>> 0;
        // SURFACE_TYPE.Additive = 0x10000 (scene3d/materials.js:65).
        if ((flags & 0x10000) !== 0) {
          baseIsAdditive = true;
        }
      }
    }

    const emitter = new ParticleEmitter({
      parent,
      scene: this._scene,
      meshFactory: async (_slotIdx) => {
        // Per-slot mesh: shared geometry, cloned material so per-particle
        // opacity lerps don't stomp neighbors.
        const mat = baseMaterial ? baseMaterial.clone() : null;
        if (mat) {
          // Perf FU4 (2026-05-18) — per-emitter Additive vs Alpha branch.
          // E5 (e1339af) shipped a single conservative middle ground for
          // ALL particles because the wasm `ParticleEmitterJs` getter
          // (src/lib.rs:18315) and `holtburger_dat::ParticleEmitter` (the
          // DAT struct) don't expose a blend-mode field. FU4 lifts that
          // limit by reading the signal off the GfxObj's surface
          // material, which IS available here via `baseMaterial`. See
          // the `baseIsAdditive` probe above for the decision path.
          if (baseIsAdditive) {
            // Additive blend (flames, sparks, the moon's crimson-star
            // particle). depthWrite=false so additive sprites don't
            // occlude later-drawn additive sprites — that's the visual
            // bug E5's "alpha for everything" path produced. No
            // alphaTest: additive sprites legitimately have low-alpha
            // halo pixels that contribute energy and must not be culled.
            mat.transparent = true;
            mat.blending = THREE.AdditiveBlending;
            mat.depthWrite = false;
          } else {
            // Alpha path — keep E5's conservative middle ground. The
            // alphaTest catches near-zero alpha and enables depth-write
            // for those pixels, which is most of the depth-write win
            // even on soft-edged sprites. Default `mat.blending` stays
            // at `THREE.NormalBlending` from the clone.
            mat.transparent = true;
            mat.alphaTest = 0.1;
            mat.depthWrite = true;
          }
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
      // Wave 3 / L1 fix (2026-05-28) — closes the TODO(E3) below in
      // destroyParticleEmitter. Walk partStorage to free per-slot cloned
      // materials on auto-finish; same disposal pattern destroyParticleEmitter
      // applies on explicit teardown, but reachable here when an emitter
      // ages out naturally via updateParticles() returning false.
      if (e && e.partStorage) {
        for (let i = 0; i < e.partStorage.length; i++) {
          const slotMesh = e.partStorage[i];
          if (!slotMesh) continue;
          _disposeMaterialIfOwned(slotMesh.material);
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
    // Wave 3 / L1 fix (2026-05-28) — `tick()`'s auto-removal branch now
    // mirrors this disposal walk, so naturally-finishing emitters no
    // longer leak per-slot materials.
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
