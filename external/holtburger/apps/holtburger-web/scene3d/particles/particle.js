// Workstream Sky-J P4 (2026-05-12) — JS port of ACE's
// `external/ACE/Source/ACE.Server/Physics/Particles/Particle.cs`.
//
// Per-particle render state + the two driver functions `init()` and
// `update()`. The `mesh` parameter is a THREE.Mesh (the per-particle
// PIXI of the C# `PhysicsPart`); the `parent` parameter is a POJO
// `{ position: THREE.Vector3, quaternion: THREE.Quaternion }`
// representing ACE's `AFrame`-as-parent.
//
// **ACE→JS type mapping**
//   System.Numerics.Vector3        → THREE.Vector3
//   AFrame (origin + orientation)  → POJO `{ position, quaternion }`
//   AFrame.LocalToGlobalVec(v)     → v.clone().applyQuaternion(frame.quaternion)
//                                    (PURE rotation — NOT localToWorld which
//                                    would also add translation. Verified
//                                    against ACE AFrame.cs:106-109 where
//                                    LocalToGlobalVec is `Vector3.Transform(
//                                    v, Orientation)`.)
//   PhysicsPart.GfxObjScale         → mesh.scale.setScalar(...)
//   PhysicsPart.SetTranslucency(t)  → mesh.material.opacity = 1 - t
//                                    (ACE uses translucency 0=opaque,
//                                    1=invisible; three.js uses opacity
//                                    1=opaque, 0=invisible. Material is
//                                    set transparent=true at construction.)
//
// All 12 ParticleType cases from Particle.cs:47-108 (init) and
// Particle.cs:138-171 (update) are ported faithfully. Even though
// retail Dereth's sky only emits ParticleType.Swarm, custom servers
// may use the rest.

import * as THREE from "three";

import { currentTime, rng } from "./time_rng.js";

// Module-private scratches for the rotation-type branch in `Particle.update()`
// (ParabolicLVGAGR / ParabolicLVLALR / ParabolicGVGAGR). The Euler is
// consumed in-place by `Quaternion.setFromEuler()` and the Quaternion is
// consumed in-place by `mesh.quaternion.copy(parent.quaternion).multiply(q)`
// — neither escapes the rotation branch, so pooling is safe. DO NOT export
// these or retain references to them outside `update()`.
const _scratchEuler = new THREE.Euler(0, 0, 0, "YXZ");
const _scratchQuat = new THREE.Quaternion();

// Swarm-trajectory fidelity escape (2026-06-23). Default = retail-correct
// (`cos(b·t)*C` amplitude, acclient.c:330502-330510). `?swarmAce=on` reverts
// to ACE.Server Particle.cs:160's `cos(b·t)+C` port (amplitude pinned to 1.0,
// C demoted to a static offset) for a side-by-side 1070 eye-test. Read once at
// module load — the per-particle `update()` hot path must not parse the URL.
const SWARM_ACE_LEGACY = (() => {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URLSearchParams(window.location.search)
      .get("swarmAce")?.toLowerCase() === "on";
  } catch (_) {
    return false;
  }
})();

/**
 * `ACE.Entity.Enum.ParticleType` — frozen enum mirror.
 * Source: external/ACE/Source/ACE.Entity/Enum/ParticleType.cs
 */
export const ParticleType = Object.freeze({
  Unknown: 0,
  Still: 1,
  LocalVelocity: 2,
  ParabolicLVGA: 3,
  ParabolicLVGAGR: 4,
  Swarm: 5,
  Explode: 6,
  Implode: 7,
  ParabolicLVLA: 8,
  ParabolicLVLALR: 9,
  ParabolicGVGA: 10,
  ParabolicGVGAGR: 11,
  GlobalVelocity: 12,
});

const _PI = Math.PI;
const _2PI = Math.PI * 2.0;

/** Helper: ACE `Vec.NormalizeCheckSmall` — returns true if too small to
 * normalize (caller treats v as zero), else normalizes v in-place and
 * returns false. */
export function normalizeCheckSmall(v) {
  if (v.lengthSq() < 1e-6) return true;
  v.normalize();
  return false;
}

/** Apply ACE's `LocalToGlobalVec(v)` semantic: pure rotation by the
 * frame's orientation quaternion, NO translation. Returns a new vector;
 * does not modify `v`. */
export function localToGlobalVec(frame, v) {
  return v.clone().applyQuaternion(frame.quaternion);
}

/** Set per-particle alpha given ACE translucency. ACE convention:
 * translucency 0 = fully opaque, translucency 1 = fully invisible.
 * Mirrors PhysicsPart.SetTranslucency (PhysicsPart.cs:137-156). */
export function setTranslucency(mesh, translucency) {
  if (!mesh || !mesh.material) return;
  // ACE: if translucency == 1.0 → NoDraw=true. We mirror by setting
  // mesh.visible = false. Otherwise visible + opacity = 1 - translucency.
  if (translucency >= 1.0) {
    mesh.visible = false;
    mesh.material.opacity = 0.0;
    return;
  }
  mesh.visible = true;
  mesh.material.opacity = Math.max(0.0, Math.min(1.0, 1.0 - translucency));
}

/**
 * Per-particle state (port of `Particle.cs` fields + Init/Update).
 *
 * Lifecycle (from ParticleEmitter.UpdateParticles):
 *   1. `emitter.EmitParticle()` → `particle.init(info, ...)` once.
 *   2. Per-tick, while `lifetime < lifespan`:
 *        `particle.update(particleType, persistent, mesh, parentFrame)`.
 *   3. When `lifetime >= lifespan`, `emitter.killParticle(i)` removes it.
 *
 * `init()` returns `false` to mirror ACE's signature (the C# is `bool`
 * but always returns false in practice — see Particle.cs:120).
 */
export class Particle {
  constructor() {
    this.lastUpdateTime = 0;
    this.birthtime = 0;
    this.lifespan = 0;
    this.lifetime = 0;
    /** Snapshot of parent frame at spawn time (`StartFrame`). */
    this.startFrame = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this.offset = new THREE.Vector3();
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
    this.c = new THREE.Vector3();
    this.startScale = 1.0;
    this.finalScale = 1.0;
    this.startTrans = 0.0;
    this.finalTrans = 0.0;
  }

  /**
   * Port of `Particle.Init` (Particle.cs:30-121).
   *
   * @param {object} info  ParticleEmitterInfo wrapper (P4's particle_emitter_info.js).
   * @param {object} parent PhysicsObj-like `{ position, quaternion, partFrames? }`.
   * @param {number} partIdx -1 for whole-object, else index into parent.partFrames.
   * @param {object} parentOffset AFrame-like `{ position: Vector3, quaternion: Quaternion }`
   *                              — emitter.ParentOffset; its `position` is the per-emitter
   *                              spawn anchor offset.
   * @param {THREE.Mesh} mesh The per-particle render mesh.
   * @param {THREE.Vector3} randomOffset From info.getRandomOffset().
   * @param {boolean} persistent True only for the "first particle" path
   *                             (TotalParticles==0 && TotalSeconds==0).
   * @param {THREE.Vector3} a From info.getRandomA().
   * @param {THREE.Vector3} b From info.getRandomB().
   * @param {THREE.Vector3} c From info.getRandomC().
   * @param {number} [startScale] Per-particle jittered start scale from
   *        info.getRandomStartScale() (P1, 2026-05-29). When omitted (e.g.
   *        unit tests), falls back to the authored info.startScale so the
   *        2-point scale/translucency lerp degrades to the un-jittered form.
   * @param {number} [finalScale] Jittered final scale (info.getRandomFinalScale()).
   * @param {number} [startTrans] Jittered start translucency (info.getRandomStartTrans()).
   * @param {number} [finalTrans] Jittered final translucency (info.getRandomFinalTrans()).
   * @returns {boolean} Always false (mirrors ACE return value).
   */
  init(info, parent, partIdx, parentOffset, mesh, randomOffset, persistent, a, b, c,
       startScale, finalScale, startTrans, finalTrans, anchorFrame) {
    const now = currentTime();

    this.lastUpdateTime = now;
    this.birthtime = now;
    this.lifetime = 0;

    // Wave 3 / L4 fix (2026-05-28) — guard against non-finite lifespan
    // values from corrupted PhysicsScript / 0x33 records. A lifespan of
    // Infinity makes `lifetime < lifespan` always true in killParticle
    // (particle_emitter.js:191), so the particle never dies and the
    // emitter never auto-removes. NaN propagates the same way (NaN
    // comparisons return false in one direction). Clamp non-finite to
    // 1.0s — matches the existing update() handling at line 404 which
    // already special-cases `lifespan > 0`.
    const rawLifespan = info.getRandomLifespan();
    this.lifespan = Number.isFinite(rawLifespan) ? rawLifespan : 1.0;

    // Snapshot the parent frame. ACE: if partIdx==-1, copy parent.Position.Frame,
    // else copy parent.PartArray.Parts[partIdx].Pos.Frame.
    //
    // 2026-06-20: the emitter pre-resolves this into `_scene`-LOCAL space and
    // passes it as `anchorFrame` (partFrames[i] is WORLD space; snapshotting it
    // raw double-applies the worldRoot −π/2 X rotation → particle flung
    // ~28k units off-world; see ParticleEmitter._resolveAnchorFrame). Use the
    // pre-resolved frame when supplied; fall back to the legacy in-place read
    // (root anchor / direct callers) otherwise.
    const startSrc = anchorFrame
      || (partIdx === -1
        ? parent
        : (parent.partFrames && parent.partFrames[partIdx]) || parent);
    this.startFrame.position.copy(startSrc.position);
    this.startFrame.quaternion.copy(startSrc.quaternion);

    // ACE: Offset = StartFrame.LocalToGlobalVec(parentOffset.Origin + _offset).
    // LocalToGlobalVec is PURE rotation by orientation — NO translation —
    // (AFrame.cs:106-109). So Offset is the rotated emitter-local spawn point
    // expressed as a vector in world axes, NOT including the start-frame's
    // own position.
    const localPt = parentOffset.position.clone().add(randomOffset);
    this.offset.copy(localToGlobalVec(this.startFrame, localPt));

    // Port of Particle.cs:47-108 — 12-case ParticleType branch.
    switch (info.particleType) {
      case ParticleType.Still:
        // No A/B/C used.
        break;
      case ParticleType.LocalVelocity:
        this.a.copy(localToGlobalVec(this.startFrame, a));
        break;
      case ParticleType.ParabolicLVGA:
        // ACE Particle.cs:55: B = StartFrame.LocalToGlobalVec(b);
        // (the C# has `case ParabolicLVGA: B = ...;` but it does NOT set
        // A — A passes through as the random A in update; flagging this
        // as an apparent ACE oversight but porting faithfully.)
        this.b.copy(localToGlobalVec(this.startFrame, b));
        break;
      case ParticleType.ParabolicLVGAGR:
        // ACE Particle.cs:58: C = StartFrame.LocalToGlobalVec(c);
        this.c.copy(localToGlobalVec(this.startFrame, c));
        break;
      case ParticleType.Swarm:
        this.a.copy(localToGlobalVec(this.startFrame, a));
        this.b.copy(b);
        this.c.copy(c);
        break;
      case ParticleType.Explode: {
        this.a.copy(a);
        this.b.copy(b);

        const ra = rng() * _2PI - _PI; // [-π, π)
        const po = rng() * _2PI - _PI;
        const rb = Math.cos(po);

        this.c.x = Math.cos(ra) * c.x * rb;
        this.c.y = Math.sin(ra) * c.y * rb;
        this.c.z = Math.sin(po) * c.z * rb;

        if (normalizeCheckSmall(this.c)) {
          this.c.set(0, 0, 0);
        }
        break;
      }
      case ParticleType.Implode:
        this.a.copy(a);
        this.b.copy(b);
        // ACE: Offset *= c; C = Offset;
        this.offset.multiply(c);
        this.c.copy(this.offset);
        break;
      case ParticleType.ParabolicLVLA:
        this.a.copy(localToGlobalVec(this.startFrame, a));
        this.b.copy(localToGlobalVec(this.startFrame, b));
        break;
      case ParticleType.ParabolicLVLALR:
        // ACE Particle.cs:92: C = StartFrame.LocalToGlobalVec(c);
        // (No A/B set; mirrors C# oversight — `case ParabolicLVLALR: C = ...;`)
        this.c.copy(localToGlobalVec(this.startFrame, c));
        break;
      case ParticleType.ParabolicGVGA:
        this.b.copy(b);
        break;
      case ParticleType.ParabolicGVGAGR:
        this.c.copy(c);
        break;
      case ParticleType.GlobalVelocity:
        this.a.copy(a);
        break;
      default:
        // ACE default branch — global A/B/C with no rotation.
        this.a.copy(a);
        this.b.copy(b);
        this.c.copy(c);
        break;
    }

    // P1 fidelity fix (2026-05-29) — use the per-particle jittered scale +
    // translucency drawn by ParticleEmitter.emitParticle (retail
    // acclient.c:331054 draws all four per spawned particle). The emitter
    // passes them in via the optional startScale/finalScale/startTrans/
    // finalTrans args. Fail-soft: if a caller (unit test) omits them, fall
    // back to the authored info.* values so the lerp is un-jittered exactly
    // as before — a 0 *Rand field also degrades the jitter to the authored
    // value at the helper level, so the default render is unchanged.
    this.startScale = startScale !== undefined ? startScale : info.startScale;
    this.finalScale = finalScale !== undefined ? finalScale : info.finalScale;
    this.startTrans = startTrans !== undefined ? startTrans : info.startTrans;
    this.finalTrans = finalTrans !== undefined ? finalTrans : info.finalTrans;

    mesh.scale.setScalar(this.startScale);
    setTranslucency(mesh, this.startTrans);

    // Immediately invoke first update so the mesh has its t=0 position +
    // scale/opacity values before this frame's render. Mirrors
    // Particle.cs:118 — `Update(info.ParticleType, persistent, part, pFrame);`
    // — note ACE passes `pFrame` (parentOffset) as the `parent` arg here,
    // NOT the parent.Position.Frame. This subtle distinction matters for
    // Still/Velocity types whose math is `parent.Origin + Offset`.
    this.update(info.particleType, persistent, mesh, parentOffset);

    return false;
  }

  /**
   * Port of `Particle.Update` (Particle.cs:123-180).
   *
   * @param {number} particleType ParticleType enum value.
   * @param {boolean} persistent Same as init().
   * @param {THREE.Mesh} mesh Per-particle mesh; position/scale/material
   *                          mutated here.
   * @param {object} parent Frame-like `{ position, quaternion }` — see
   *                        ParticleEmitter.cs:217-232 for which frame is
   *                        passed in (info.IsParentLocal selects between
   *                        the current parent frame and the snapshot
   *                        startFrame).
   */
  update(particleType, persistent, mesh, parent) {
    const now = currentTime();
    const elapsed = now - this.lastUpdateTime;

    if (persistent) {
      this.lifetime += elapsed;
      this.lastUpdateTime = now;
    } else {
      // ACE: Lifetime = elapsedTime;  // elapsedTime since last update.
      // This is the non-persistent path used for normal sky emitters
      // (TotalParticles > 0 || TotalSeconds > 0).
      this.lifetime = elapsed;
    }

    const lt = this.lifetime;
    const ox = this.offset.x, oy = this.offset.y, oz = this.offset.z;
    const px = parent.position.x, py = parent.position.y, pz = parent.position.z;

    switch (particleType) {
      case ParticleType.Still:
        // ACE: part.Pos.Frame.Origin = parent.Origin + Offset;
        mesh.position.set(px + ox, py + oy, pz + oz);
        break;
      case ParticleType.LocalVelocity:
      case ParticleType.GlobalVelocity:
        // ACE: (lifetime * A) + parent.Origin + Offset;
        mesh.position.set(
          lt * this.a.x + px + ox,
          lt * this.a.y + py + oy,
          lt * this.a.z + pz + oz,
        );
        break;
      case ParticleType.ParabolicLVGA:
      case ParticleType.ParabolicLVLA:
      case ParticleType.ParabolicGVGA: {
        // acclient CParticle::Update (acclient.c:330453-330465) ASSIGNS the full
        // parabola anchored at the parent frame:
        //   position = parent.Origin + Offset + (t·A) + (½·t²·B)
        // — it is NOT `+=`. ParticleViewer/ACE use `+=`, which is a decomp-port
        // bug: in three.js the mesh starts at (0,0,0), so accumulating drops the
        // parent origin entirely and the particle flies to WORLD-ORIGIN
        // (CDP-verified on LB 0xAB94 doll auras, 2026-06-20). Assign the clean
        // parabola including (px,py,pz), consistent with the *GR variants below.
        const halfT2 = lt * lt * 0.5;
        mesh.position.set(
          px + ox + lt * this.a.x + halfT2 * this.b.x,
          py + oy + lt * this.a.y + halfT2 * this.b.y,
          pz + oz + lt * this.a.z + halfT2 * this.b.z,
        );
        break;
      }
      case ParticleType.ParabolicLVGAGR:
      case ParticleType.ParabolicLVLALR:
      case ParticleType.ParabolicGVGAGR: {
        // ACE: part.Pos.Frame = new AFrame(parent);   // copy parent
        //      part.Pos.Frame.Origin += (lt²B/2) + ltA + Offset;
        //      part.Pos.Frame.Rotate(lt * C);
        const halfT2 = lt * lt * 0.5;
        mesh.position.set(
          px + halfT2 * this.b.x + lt * this.a.x + ox,
          py + halfT2 * this.b.y + lt * this.a.y + oy,
          pz + halfT2 * this.b.z + lt * this.a.z + oz,
        );
        // ACE Rotate(rotation): orientation *= CreateFromYawPitchRoll(
        //   rotation.X, rotation.Y, rotation.Z); then normalize.
        // YawPitchRoll in System.Numerics is (yaw=Y, pitch=X, roll=Z) per
        // .NET docs. three.js Euler default order is "XYZ".
        _scratchEuler.set(lt * this.c.x, lt * this.c.y, lt * this.c.z, "YXZ");
        _scratchQuat.setFromEuler(_scratchEuler);
        // Start from parent's orientation each tick (ACE: `new AFrame(parent)`
        // copies the orientation, then Rotate multiplies into it).
        mesh.quaternion.copy(parent.quaternion).multiply(_scratchQuat).normalize();
        break;
      }
      case ParticleType.Swarm: {
        // Retail acclient CParticle::Update Swarm (acclient.c:330502-330510):
        //   x = cos(b.x*t) * c.x + t*a.x + offset.x + parent.x
        //   y = sin(b.y*t) * c.y + t*a.y + offset.y + parent.y
        //   z = cos(b.z*t) * c.z + t*a.z + offset.z + parent.z
        // C is the oscillation AMPLITUDE (it MULTIPLIES cos/sin), which is what
        // produces the fluttering orbit. ACE.Server Particle.cs:160-163 ports
        // this as `cos(b*t) + (t*a + C + parent + offset)` — i.e. amplitude
        // hard-coded to 1.0 with C demoted to a static offset. That is a
        // decomp-port bug (ACE's own Implode case, Particle.cs:169, correctly
        // does `cos(A.X*t) * C`); cross-checked against the retail decomp
        // above. Restored to retail here so swarms (butterflies/insects) orbit
        // with their real amplitude instead of barely jittering ±1 unit.
        // ACE stays vanilla — this is the client-side fidelity fix.
        // (Note Y uses sin where X and Z use cos — a retail quirk, preserved.)
        const base_x = lt * this.a.x + px + ox;
        const base_y = lt * this.a.y + py + oy;
        const base_z = lt * this.a.z + pz + oz;
        if (SWARM_ACE_LEGACY) {
          // Legacy ACE port (kept only as a `?swarmAce=on` A/B reference).
          mesh.position.set(
            Math.cos(lt * this.b.x) + (this.c.x + base_x),
            Math.sin(lt * this.b.y) + (this.c.y + base_y),
            Math.cos(lt * this.b.z) + (this.c.z + base_z),
          );
        } else {
          mesh.position.set(
            Math.cos(lt * this.b.x) * this.c.x + base_x,
            Math.sin(lt * this.b.y) * this.c.y + base_y,
            Math.cos(lt * this.b.z) * this.c.z + base_z,
          );
        }
        break;
      }
      case ParticleType.Explode: {
        // ACE: (lifetime * B + C * A.X) * lifetime + Offset + parent.Origin;
        // Note: ALL three components share scalar A.X (only X). Faithful.
        const ax = this.a.x;
        mesh.position.set(
          (lt * this.b.x + this.c.x * ax) * lt + ox + px,
          (lt * this.b.y + this.c.y * ax) * lt + oy + py,
          (lt * this.b.z + this.c.z * ax) * lt + oz + pz,
        );
        break;
      }
      case ParticleType.Implode: {
        // ACE: cos(A.X * lifetime) * C + lifetime² * B + parent.Origin + Offset;
        const cosScale = Math.cos(this.a.x * lt);
        const lt2 = lt * lt;
        mesh.position.set(
          cosScale * this.c.x + lt2 * this.b.x + px + ox,
          cosScale * this.c.y + lt2 * this.b.y + py + oy,
          cosScale * this.c.z + lt2 * this.b.z + pz + oz,
        );
        break;
      }
      default:
        // Unknown: leave mesh position unchanged.
        break;
    }

    // Scale + opacity lerp over [0, lifespan]. ACE clamps interval to 1.0.
    // If lifespan is 0 or negative, treat the particle as fully aged
    // (interval = 1) to mirror ACE's killParticle path (lifetime >= lifespan
    // ALWAYS fires KillParticle next tick).
    let interval;
    if (this.lifespan > 0) {
      interval = Math.min(this.lifetime / this.lifespan, 1.0);
    } else {
      interval = 1.0;
    }

    const currentScale = this.startScale + (this.finalScale - this.startScale) * interval;
    const currentTrans = this.startTrans + (this.finalTrans - this.startTrans) * interval;

    mesh.scale.setScalar(currentScale);
    setTranslucency(mesh, currentTrans);
  }
}
