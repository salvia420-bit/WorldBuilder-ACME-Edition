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
const _doubleTagWarned = new Set();

// =====================================================================
// RP6 (2026-06-08) — off-screen emitter culling.
// =====================================================================
// ParticleManager.tick() updated EVERY emitter EVERY frame with no
// frustum/distance gate (the biggest particle-runtime cost in dense
// combat / multi-PhysicsScript scenes). RP6 adds a per-emitter cull
// check, re-evaluated every N frames, that SKIPS the expensive
// updateParticles() walk for emitters whose whole sortingSphere is
// outside the camera frustum OR beyond a hard distance cap.
//
// Camera is read from the SAME global the E6 quality cap already uses
// (`window.liveScene3d`) — NO camera argument is threaded through
// tick() (that would force an edit to the entities.js:7530 call site,
// which is NOT this track's file). Resolution order mirrors the
// entity tick-gate (entities.js:7062) and lighting.js: prefer the
// camera switcher's active camera, fall back to `.camera`.
//
// HARD GUARDRAILS (see RP6 task):
//   - Only cull when the WHOLE sortingSphere is out — projectile-class
//     emitters whose particles spawn off-screen but travel on-screen
//     stay live (the sortingSphere radius bounds the particle travel,
//     so a sphere-vs-frustum test on it is conservative-correct).
//   - A culled emitter is NOT dropped and never stops aging: while
//     culled we still run a lightweight stop/drain check so a
//     time/count-bounded emitter eventually returns false and is
//     removed by the normal auto-finish path. It is re-enabled (full
//     updateParticles()) the moment it re-enters the frustum/range.
//   - Bail OPEN (cull nothing) whenever the camera can't be resolved
//     (pre-init frames) — never silently freeze every emitter.
const _RP6 = {
  // Re-evaluate the cull set every N ticks. Between re-checks an
  // emitter keeps its prior cull decision, so a fast pan doesn't pay
  // the frustum build every frame. 6 ticks ≈ 100ms at 60fps — small
  // enough that re-entry latency is imperceptible, large enough to
  // amortize the matrix/frustum rebuild over many emitters.
  recheckInterval: 6,
  // Hard distance cap (THREE world units). Beyond this an emitter is
  // culled regardless of frustum — covers the case of a wide FOV /
  // ortho camera where the frustum is huge but distant particles are
  // sub-pixel. 220m comfortably exceeds the entity tick radius so we
  // never cull an emitter on an entity that is still animating.
  maxDistance: 220,
};
const _RP6_MAX_DIST_SQ = _RP6.maxDistance * _RP6.maxDistance;
// Module scratches — never escape _rp6ShouldCull(). Mirrors the
// `_scratch*` allocation-avoidance convention used across scene3d.
const _rp6Mvp = new THREE.Matrix4();
const _rp6Frustum = new THREE.Frustum();
const _rp6Sphere = new THREE.Sphere();
const _rp6WorldPos = new THREE.Vector3();

/** Resolve the active camera off the existing liveScene3d global. */
function _rp6ResolveCamera() {
  if (typeof window === "undefined") return null;
  const ls = window.liveScene3d;
  if (!ls) return null;
  return ls.cameraSwitcher?.activeCamera ?? ls.camera ?? null;
}

/**
 * Build the frustum from the active camera into the module scratch.
 * Returns the camera (for the distance test) or null when no camera /
 * the camera lacks the matrices we need (bail-open → cull nothing).
 */
function _rp6PrepareFrustum() {
  const camera = _rp6ResolveCamera();
  if (
    !camera ||
    !camera.projectionMatrix ||
    !camera.matrixWorldInverse ||
    !camera.position
  ) {
    return null;
  }
  // RP6 (2026-06-08): refresh the camera's world matrices BEFORE reading
  // matrixWorldInverse. The particle tick runs in entityManager.tick(),
  // which fires AFTER cameraSwitcher.tick() (which only sets
  // camera.position + lookAt → local matrix/quaternion) but BEFORE
  // renderer.render() (which is what normally recomputes matrixWorld /
  // matrixWorldInverse). Without this refresh the frustum ORIENTATION
  // would reflect LAST frame's render pose, so a fast camera rotation
  // could transiently cull an emitter that is actually on-screen for up
  // to ~recheckInterval frames. (The distance gate is unaffected — it
  // reads camera.position directly, which is already current.) This is
  // the same convention csm.js:294 uses when reading camera matrices
  // outside the render phase. Camera.updateMatrixWorld() refreshes both
  // matrixWorld and matrixWorldInverse from the now-current local matrix.
  if (typeof camera.updateMatrixWorld === "function") {
    camera.updateMatrixWorld();
  }
  // MVP = projection · viewInverse. Same composition cells.js:759 uses.
  _rp6Mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _rp6Frustum.setFromProjectionMatrix(_rp6Mvp);
  return camera;
}

/**
 * Should this emitter be culled (skip the expensive updateParticles())
 * for the current camera? Conservative: only true when the WHOLE
 * sortingSphere is outside the frustum AND/OR beyond the distance cap.
 *
 * @param {import("./particle_emitter.js").ParticleEmitter} emitter
 * @param {THREE.Object3D|{position:THREE.Vector3}} camera prepared via _rp6PrepareFrustum
 * @returns {boolean}
 */
function _rp6ShouldCull(emitter, camera) {
  const parent = emitter.parent;
  if (!parent) return false; // no anchor → don't cull (bail open)

  // World-space emitter origin. Entity rigs live under worldRoot
  // (rotated -π/2 about X), so the LOCAL parent.position is NOT in the
  // camera's space; compose up via getWorldPosition when available
  // (matches the entity tick-gate at entities.js:7073). Plain-POJO
  // parents (tests) fall back to their raw position.
  if (typeof parent.getWorldPosition === "function") {
    parent.getWorldPosition(_rp6WorldPos);
  } else if (parent.position) {
    _rp6WorldPos.set(
      parent.position.x ?? 0,
      parent.position.y ?? 0,
      parent.position.z ?? 0,
    );
  } else {
    return false; // no position → bail open
  }

  // sortingSphere.radius bounds how far this emitter's particles travel
  // from the anchor (InitEnd: max(maxOffset, maxA·lifespan)). Adding it
  // to the frustum-test radius is what keeps projectile-trajectory
  // emitters live: a burst that spawns at the anchor and flies outward
  // stays "in" until its WHOLE reachable sphere clears the frustum.
  let radius = emitter.info?.sortingSphere?.radius ?? 0;

  // RP6 (2026-06-08): the sphere is centered at the RIG ORIGIN
  // (parent.getWorldPosition), but a part-anchored emitter (isParentLocal
  // / partIndex >= 0) and any emitter with a non-zero parentOffset emits
  // at a point OFFSET from that origin — e.g. a weapon tip or a far
  // attachment on a large rig. sortingSphere.radius alone does NOT
  // account for that static offset, so on a large rig the true particle
  // region can lie outside the origin-centered sphere → we'd over-cull a
  // part-anchored effect that is in fact on-screen. Inflate the test
  // radius by the static offset magnitude so the sphere conservatively
  // covers the real anchor. This only ever makes the cull MORE
  // conservative (keeps more emitters live), aligning with the guardrail
  // "only cull when the WHOLE reachable region is out". The dynamic
  // per-part frame offset (partFrames) is not composed here to keep the
  // test cheap; the static parentOffset is the dominant contributor and
  // covers the common case.
  const off = emitter.parentOffset?.position;
  if (off && typeof off.length === "function") {
    radius += off.length();
  }

  // Distance cap — measured anchor-to-camera, slackened by the sphere
  // radius so a large-radius emitter near the cap edge isn't culled
  // while part of its reach is still in range.
  const dx = _rp6WorldPos.x - camera.position.x;
  const dy = _rp6WorldPos.y - camera.position.y;
  const dz = _rp6WorldPos.z - camera.position.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const slack = _RP6.maxDistance + radius;
  if (distSq > slack * slack) return true;

  // Frustum test on the bounding sphere. intersectsSphere is true when
  // ANY part of the sphere is inside → we cull only when it is FALSE
  // (the whole sphere is outside every plane).
  _rp6Sphere.center.copy(_rp6WorldPos);
  _rp6Sphere.radius = radius;
  return !_rp6Frustum.intersectsSphere(_rp6Sphere);
}

function _disposeMaterialIfOwned(mat) {
  if (!mat) return;
  const ud = mat.userData;
  if (!ud) return;
  if (ud.__cacheOwned === true && ud.__disposable === true) {
    // Programmer error: a cache material was tagged disposable at some
    // clone site that should have stayed cache-owned. Disposing would
    // free the shared GPU resource other emitters still reference.
    // Rate-limit to one log per material name — emitters cycle many
    // times per second and the spam swamps the console otherwise.
    const key = mat.name || "<unnamed>";
    if (!_doubleTagWarned.has(key)) {
      _doubleTagWarned.add(key);
      // eslint-disable-next-line no-console
      console.error(
        "[particle_manager/E3] _disposeMaterialIfOwned: material is BOTH __cacheOwned and __disposable —" +
          " refusing to dispose. Audit the clone site that produced it. (further occurrences for this name silenced)",
        { name: mat.name, userData: ud }
      );
    }
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
    // RP6 (2026-06-08) — off-screen emitter culling. `_rp6Frame`
    // counts ticks so the frustum/distance set is only re-evaluated
    // every `_RP6.recheckInterval` ticks; between re-checks each
    // emitter keeps its cached `_rp6Culled` decision.
    this._rp6Frame = 0;
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

    // C5 (async liveness): snapshot the offset frame BY VALUE at entry,
    // BEFORE any await below. `parentOffset` is often a shared/scratch
    // frame the caller may mutate (e.g. overlapping CreateParticle
    // chains reusing one entity frame) while geometryFactory /
    // materialFactory / setInfo are still pending; a late read would
    // parent this emitter to whatever the offset became by resolve time.
    // Accept THREE instances (clone) AND plain {x,y,z}/{w,x,y,z} POJOs.
    const offsetFrame = {
      position: parentOffset
        ? (parentOffset.position?.clone?.()
            ?? new THREE.Vector3(
              parentOffset.position?.x ?? 0,
              parentOffset.position?.y ?? 0,
              parentOffset.position?.z ?? 0,
            ))
        : new THREE.Vector3(0, 0, 0),
      quaternion: parentOffset
        ? (parentOffset.quaternion?.clone?.()
            ?? new THREE.Quaternion(
              parentOffset.quaternion?.x ?? 0,
              parentOffset.quaternion?.y ?? 0,
              parentOffset.quaternion?.z ?? 0,
              parentOffset.quaternion?.w ?? 1,
            ))
        : new THREE.Quaternion(),
    };

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
          // THREE.Material.clone() deep-copies userData, so the clone inherits
          // a `__cacheOwned: true` tag when the base was a cache material;
          // clear it here so the clone is unambiguously disposable. Without
          // this, _disposeMaterialIfOwned() sees BOTH flags, trips the E3
          // guard, and refuses to free the clone → per-slot material leak on
          // landblock eviction while moving.
          mat.userData.__cacheOwned = false;
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

    // RP6 (2026-06-08) — re-evaluate the off-screen cull set every
    // `_RP6.recheckInterval` ticks. `recheck === false` means "reuse
    // each emitter's cached `_rp6Culled` flag this tick". On a recheck
    // tick we build the frustum once (amortized over all emitters);
    // `camera === null` means we couldn't resolve a camera → bail open
    // (treat every emitter as visible this tick).
    this._rp6Frame = (this._rp6Frame + 1) >>> 0;
    const recheck = (this._rp6Frame % _RP6.recheckInterval) === 0;
    const camera = recheck ? _rp6PrepareFrustum() : null;

    for (const [id, emitter] of this.particleTable) {
      if (recheck) {
        // Bail open when no camera (camera===null) — never cull on a
        // frame where we can't see the camera.
        const wasCulled = emitter._rp6Culled === true;
        const nowCulled = camera ? _rp6ShouldCull(emitter, camera) : false;
        emitter._rp6Culled = nowCulled;
        if (nowCulled !== wasCulled) {
          // Transition: toggle visibility of the currently-ACTIVE part
          // meshes so frozen off-screen particles aren't still submitted
          // to the GPU (the per-slot meshes are `frustumCulled = false`,
          // so three.js won't cull them for us). Only touch occupied
          // slots (`emitter.parts[i]` non-null) — free slots are already
          // invisible and must stay so. On re-entry we restore visible;
          // the normal emit/kill path keeps it consistent afterward.
          // This is a pure visibility flip — no reparent, no geometry/
          // material churn, fully reversible.
          const parts = emitter.parts;
          if (parts && parts.length) {
            const vis = !nowCulled;
            for (let i = 0; i < parts.length; i++) {
              const m = parts[i];
              if (m) m.visible = vis;
            }
          }
        }
      }

      if (emitter._rp6Culled === true) {
        // Off-screen: SKIP the expensive per-particle work ONLY while the
        // emitter is still actively emitting. Advance its stop bound so a
        // time/count-limited emitter flips `stopped`.
        //
        // CRITICAL (RP6 fix, 2026-06-08): once an emitter is `stopped` we
        // must NOT keep skipping updateParticles(), because killParticle()
        // — the SOLE place `numParticles` decrements — only ever runs
        // inside updateParticles(). If we `continue`d here for a stopped
        // emitter, a time-bounded emitter that was culled while it still
        // held live particles would flip `stopped=true` (wall-clock) but
        // its `numParticles` would stay pinned > 0 forever (its particle
        // lifetimes are also frozen because Particle.update only runs in
        // updateParticles()), so the `stopped && numParticles===0` removal
        // predicate would NEVER be satisfied while off-screen → the
        // emitter (plus its per-slot meshes + cloned materials) leaks in
        // particleTable until the player happens to look back at it.
        //
        // updateParticles() is CHEAP for a stopped emitter: the `if
        // (!this.stopped)` emit branch is skipped, so it does only the
        // kill-walk (particle.update + killParticle over the active
        // slots), which is exactly what we need to age the frozen
        // particles out and drain numParticles to 0. When it returns
        // false (no particles left AND stopped) we remove it — the normal
        // auto-finish path, now actually reachable while culled.
        //
        // Persistent (totalParticles==0 && totalSeconds==0) emitters never
        // stop here — they're MEANT to run forever and simply resume on
        // re-entry (the intended perf win), so we keep skipping their
        // walk entirely. One-shot PlayEffect emitters additionally carry a
        // hard destroy timer on the spawning side (play_effect_vfx
        // ONE_SHOT_LIFETIME_MS) as a belt-and-braces reaper.
        try {
          if (typeof emitter.stopEmitter === "function") emitter.stopEmitter();
        } catch (_) {}
        if (emitter.stopped === true) {
          // Drain the stopped emitter's remaining particles instead of
          // waiting for numParticles to reach 0 organically (it can't,
          // while the full walk is skipped). updateParticles() does no
          // emission when stopped — just the kill-walk.
          const drained = !emitter.updateParticles();
          if (drained) {
            removeIds.push(id);
          } else {
            // The kill-walk's particle.update() can flip a still-living
            // slot mesh back to visible (particle.js setTranslucency:95).
            // This emitter is off-screen, so re-hide any occupied slots
            // to keep the cull's GPU-submission savings during the
            // (few-frame) drain window. Free slots are already invisible.
            const parts = emitter.parts;
            if (parts && parts.length) {
              for (let i = 0; i < parts.length; i++) {
                const m = parts[i];
                if (m) m.visible = false;
              }
            }
          }
        }
        continue;
      }

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
