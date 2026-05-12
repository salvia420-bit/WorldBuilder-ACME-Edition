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
          mat.transparent = true;
        }
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
    return this.particleTable.delete(emitterId);
  }
}
