// Workstream Sky-J P4 (2026-05-12) — JS port of ACE's
// `external/ACE/Source/ACE.Server/Physics/Particles/ParticleEmitter.cs`.
//
// Owns the per-emitter state: parent anchor, list of slots, last-emit
// bookkeeping, and the per-tick `updateParticles()` loop that:
//   1. Advances every live particle's position/scale/opacity.
//   2. Kills expired particles (Lifetime >= Lifespan).
//   3. Spawns new particles when ShouldEmitParticle fires.
//   4. Stops the emitter if TotalSeconds/TotalParticles limits are hit.
//
// **Difference from ACE.** The C# walks PhysicsPart slots and reuses
// pre-allocated PhysicsParts via PartStorage. In JS we lazy-build the
// per-slot THREE.Mesh from the manager's `meshFactory(hwGfxObjId)`
// callback (which P5 wires to fetchBuildingPlacement + MaterialCache).
// Each slot holds either a Mesh (active particle) or null (free slot).

import * as THREE from "three";

import { currentTime } from "./time_rng.js";
import { Particle } from "./particle.js";
import { EmitterType } from "./particle_emitter_info.js";

// E4 (2026-05-18): per-tick scratch for the BirthratePerMeter branch of
// shouldEmitParticle(). The Vector3 is filled via subVectors(parent.position,
// lastEmitOffset) and only `.lengthSq()` is read downstream by
// ParticleEmitterInfo.shouldEmitParticle — the reference does not escape,
// so pooling is safe. Matches the `_scratch*` convention from E1 in
// particle.js. DO NOT export or retain references outside shouldEmitParticle().
const _scratchVec3 = new THREE.Vector3();

// E2 (2026-05-18): per-spawn scratches for the four `info.getRandom*(out)`
// helpers. Filled by getRandomOffset/A/B/C and immediately consumed by
// Particle.init(), which `.copy()`'s each into a persistent particle field
// (see particle.js:178-251 — every branch ends in `this.{offset,a,b,c}.copy(...)`).
// References do NOT escape past the init() call, so pooling is safe.
//
// NOTE: these are deliberately distinct from `_scratchVec3` (used in
// shouldEmitParticle) — even though shouldEmitParticle() and emitParticle()
// run sequentially in updateParticles(), keeping the four spawn scratches
// dedicated makes lifetime reasoning local and protects against future
// refactors that might call shouldEmitParticle() mid-emit. DO NOT export
// or retain references outside emitParticle().
const _offsetScratch = new THREE.Vector3();
const _aScratch = new THREE.Vector3();
const _bScratch = new THREE.Vector3();
const _cScratch = new THREE.Vector3();

// E6 (2026-05-18): per-emitter-record one-time warn guard for the runtime
// particle-count cap. The cap comes from
// `liveScene3d.quality.flags.maxParticlesPerEmitter` (preset table in
// scene3d/quality.js) and clamps `info.maxParticles` at setInfo() time.
//
// We warn at most once per emitter DID (info.id) — NOT per frame, per
// slot, or per emitter-instance. Many in-world spawns can share one
// ParticleEmitter DID (e.g. a popular spell effect cast 50× over a
// session); we only want devs to see the cap-hit message once so it
// stays useful for auditing. `_e6` prefix avoids collision with the
// `_scratch*` and `_offsetScratch`/`_aScratch`/`_bScratch`/`_cScratch`
// pool names from E4 and E2.
const _e6WarnedEmitterIds = new Set();
const _E6_FALLBACK_CAP = 1024;

export class ParticleEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.parent PhysicsObj-like POJO `{ position, quaternion, partFrames? }`.
   * @param {(slotIdx: number) => Promise<THREE.Mesh> | THREE.Mesh} opts.meshFactory
   *        Per-slot mesh builder. Called once per slot at SetInfo time;
   *        the same mesh is reused across spawn/kill cycles for that slot.
   *        Returns a THREE.Mesh with shared geometry + per-slot material.
   * @param {THREE.Object3D} [opts.scene] Where to add the active meshes
   *        (passed in by ParticleManager).
   * @param {(mesh: THREE.Mesh) => void} [opts.onMeshActive] Optional
   *        callback fired each time a mesh transitions free→active.
   *        Defaults to `scene.add(mesh)` if scene was passed.
   * @param {(mesh: THREE.Mesh) => void} [opts.onMeshFree] Same, free→active
   *        callback. Defaults to `scene.remove(mesh)` if scene was passed.
   */
  constructor(opts) {
    this.id = 0;
    this.parent = opts.parent;
    this.partIndex = -1;
    this.parentOffset = {
      position: new THREE.Vector3(0, 0, 0),
      quaternion: new THREE.Quaternion(),
    };
    this.info = null;

    // Slot arrays — same length as info.maxParticles after setInfo().
    this.particles = []; // Particle | null per slot
    this.parts = []; // THREE.Mesh | null per slot (the "Parts" list in ACE)
    this.partStorage = []; // THREE.Mesh per slot, always non-null (the "PartStorage" array)

    this.numParticles = 0;
    this.totalEmitted = 0;
    this.creationTime = 0;
    this.lastEmitTime = currentTime();
    this.lastEmitOffset = new THREE.Vector3(0, 0, 0);
    this.stopped = false;
    this.lastUpdateTime = currentTime();
    this.degradedOut = 0;
    this.degradeDistance = Infinity;

    this._meshFactory = opts.meshFactory;
    this._scene = opts.scene ?? null;
    this._onMeshActive = opts.onMeshActive ?? null;
    this._onMeshFree = opts.onMeshFree ?? null;
  }

  /**
   * Port of `SetInfo` (ParticleEmitter.cs:102-123). Allocates per-slot
   * meshes via the factory. Returns false if info.hwGfxObjId is 0 (ACE
   * destroys the emitter in that case — caller should discard).
   *
   * @param {import("./particle_emitter_info.js").ParticleEmitterInfo} info
   */
  async setInfo(info) {
    this.info = info;
    if (info.hwGfxObjId === 0) {
      return false;
    }
    this.lastEmitOffset.copy(this.parent.position);

    // E6 (2026-05-18): runtime particle-count cap from the quality preset.
    // AC ParticleEmitter records can request unbounded counts; a pathological
    // effect with maxParticles=10_000 would allocate that many slots + meshes
    // and silently blow up frametime. Clamp to the preset's
    // `maxParticlesPerEmitter` (low:64 / mid:256 / high:1024 / ultra:2048),
    // falling back to 1024 if liveScene3d.quality isn't on window yet
    // (Node test harness, very-early init). Emit a one-time `console.warn`
    // per emitter DID so devs can audit which effects trip the cap.
    //
    // We mutate `info.maxParticles` in-place because ParticleEmitterInfo
    // is constructed per `ParticleManager.addEmitter()` call (see
    // particle_manager.js:75-77 — `new ParticleEmitterInfo(emitterInfo)`),
    // so the info object is NOT shared across emitter instances. The
    // updateParticles() loop bound (`this.info.maxParticles`) then matches
    // the actual allocated slot count, avoiding out-of-bounds reads.
    const _qFlags =
      typeof window !== "undefined" ? window.liveScene3d?.quality?.flags : null;
    const qualityCap = Number.isFinite(_qFlags?.maxParticlesPerEmitter)
      ? _qFlags.maxParticlesPerEmitter
      : _E6_FALLBACK_CAP;
    const effectiveMax = Math.min(info.maxParticles, qualityCap);
    if (info.maxParticles > qualityCap && !_e6WarnedEmitterIds.has(info.id)) {
      _e6WarnedEmitterIds.add(info.id);
      console.warn(
        `[particle_emitter E6] capping emitter id=0x${(info.id >>> 0).toString(16)}` +
        ` hwGfxObjId=0x${(info.hwGfxObjId >>> 0).toString(16)}` +
        ` requested=${info.maxParticles} cap=${qualityCap}` +
        ` (set ?maxParticlesPerEmitter=N to override)`,
      );
    }
    if (effectiveMax < info.maxParticles) {
      info.maxParticles = effectiveMax;
    }

    const n = effectiveMax;
    this.parts = new Array(n).fill(null);
    this.partStorage = new Array(n).fill(null);
    this.particles = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const mesh = await this._meshFactory(i);
      this.partStorage[i] = mesh;
      this.particles[i] = new Particle();
      // Start invisible — meshes only become visible when a particle
      // claims the slot.
      if (mesh) {
        mesh.visible = false;
      }
    }
    return true;
  }

  /**
   * Port of `SetParenting` (ParticleEmitter.cs:40-48).
   * @param {number} partIdx
   * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion}} frame
   */
  setParenting(partIdx, frame) {
    this.partIndex = partIdx;
    this.parentOffset.position.copy(frame.position);
    this.parentOffset.quaternion.copy(frame.quaternion);
    return true;
  }

  /** Port of `KillParticle` (ParticleEmitter.cs:50-59). */
  killParticle(i) {
    const p = this.particles[i];
    if (!p) return false;
    if (p.lifetime < p.lifespan) return false;
    // Free the slot.
    const mesh = this.parts[i];
    if (mesh) {
      if (this._onMeshFree) {
        this._onMeshFree(mesh);
      } else if (this._scene && mesh.parent === this._scene) {
        this._scene.remove(mesh);
      }
      mesh.visible = false;
    }
    this.parts[i] = null;
    this.numParticles -= 1;
    return true;
  }

  /** Port of `StopEmitter` (ParticleEmitter.cs:61-73). */
  stopEmitter() {
    if (!this.stopped) {
      if (this.info.totalSeconds > 0
          && this.creationTime + this.info.totalSeconds < currentTime()) {
        this.stopped = true;
      }
      if (this.info.totalParticles > 0
          && this.totalEmitted >= this.info.totalParticles) {
        this.stopped = true;
      }
    }
    return this.stopped;
  }

  /** Port of `RecordParticleEmission` (ParticleEmitter.cs:75-82). */
  recordParticleEmission() {
    this.numParticles += 1;
    this.totalEmitted += 1;
    this.lastEmitOffset.copy(this.parent.position);
    this.lastEmitTime = currentTime();
  }

  /** Port of `ShouldEmitParticle` (ParticleEmitter.cs:84-92). */
  shouldEmitParticle() {
    let offset;
    if (this.info.emitterType === EmitterType.BirthratePerMeter) {
      offset = _scratchVec3.subVectors(this.parent.position, this.lastEmitOffset);
    } else {
      offset = _scratchVec3.set(0, 0, 0);
    }
    return this.info.shouldEmitParticle(
      this.numParticles,
      this.totalEmitted,
      offset,
      this.lastEmitTime,
    );
  }

  /** Port of `GetNextParticleIdx` (ParticleEmitter.cs:154-160). */
  getNextParticleIdx() {
    for (let i = 0; i < this.parts.length; i++) {
      if (this.parts[i] === null) return i;
    }
    return -1;
  }

  /** Port of `EmitParticle` (ParticleEmitter.cs:130-152). */
  emitParticle() {
    const idx = this.getNextParticleIdx();
    if (idx === -1) return;

    const mesh = this.partStorage[idx];
    if (!mesh) return;
    this.parts[idx] = mesh;
    if (this._onMeshActive) {
      this._onMeshActive(mesh);
    } else if (this._scene && mesh.parent !== this._scene) {
      this._scene.add(mesh);
    }
    mesh.visible = true;

    // ACE: firstParticle = TotalParticles == 0 && TotalSeconds == 0
    // (this is the "persistent / standing" emitter path — particles
    // never auto-die, instead get reset every tick).
    const firstParticle = this.info.totalParticles === 0
                       && this.info.totalSeconds === 0;

    // E2 (2026-05-18): pass module-scratches so the four helpers write
    // in-place instead of allocating a fresh Vector3 each. Particle.init()
    // immediately `.copy()`'s each into a persistent particle field — the
    // scratch references do not escape the init() call below.
    const randomOffset = this.info.getRandomOffset(_offsetScratch);
    const randomA = this.info.getRandomA(_aScratch);
    const randomB = this.info.getRandomB(_bScratch);
    const randomC = this.info.getRandomC(_cScratch);

    this.particles[idx].init(
      this.info,
      this.parent,
      this.partIndex,
      this.parentOffset,
      mesh,
      randomOffset,
      firstParticle,
      randomA,
      randomB,
      randomC,
    );

    this.recordParticleEmission();
  }

  /**
   * Port of `UpdateParticles` (ParticleEmitter.cs:162-255). Drives every
   * active particle, kills expired ones, emits new ones if not stopped.
   *
   * @returns {boolean} false if the emitter has no particles left AND
   *                    is stopped (ParticleManager removes it then).
   */
  updateParticles() {
    if (this.info === null) return false;
    if (this.info.maxParticles > 0) {
      for (let i = 0; i < this.info.maxParticles; i++) {
        const mesh = this.parts[i];
        if (mesh === null) continue;
        let frame;
        if (this.info.isParentLocal) {
          if (this.partIndex === -1) {
            frame = this.parent;
          } else {
            frame = (this.parent.partFrames && this.parent.partFrames[this.partIndex])
              || this.parent;
          }
        } else {
          frame = this.particles[i].startFrame;
        }
        const firstParticle = this.info.totalParticles === 0
                           && this.info.totalSeconds === 0;
        this.particles[i].update(this.info.particleType, firstParticle, mesh, frame);
        this.killParticle(i);
      }
    }
    let hasParticles = true;
    if (!this.stopped) {
      if (this.shouldEmitParticle()) {
        this.emitParticle();
      }
      this.stopEmitter();
    } else {
      hasParticles = this.numParticles !== 0;
    }
    this.lastUpdateTime = currentTime();
    return hasParticles;
  }

  /**
   * Port of `InitEnd` (ParticleEmitter.cs:257-263). Sets CreationTime
   * and spawns the initial batch (`for i in 0..TotalParticles`).
   *
   * NOTE: ACE uses `TotalParticles` here (NOT `InitialParticles`). The
   * field name suggests "all particles for the emitter's lifetime"; ACE
   * spawns ALL of them at t=0 then sits idle. This is a port faithfulness
   * thing — flag for the report, do not fix.
   */
  initEnd() {
    this.creationTime = currentTime();
    for (let i = 0; i < this.info.totalParticles; i++) {
      this.emitParticle();
    }
  }
}

export function makeParticleEmitter(parent, opts) {
  if (!parent) return null;
  return new ParticleEmitter({ parent, ...opts });
}
