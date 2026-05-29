// Workstream Sky-J P4 (2026-05-12) — JS port of ACE's
// `external/ACE/Source/ACE.Server/Physics/Particles/ParticleEmitterInfo.cs`.
//
// Wraps the wasm-exposed `ParticleEmitterJs` (P3 commit a44794f, see
// `apps/holtburger-web/src/lib.rs:13794`) with ACE's runtime helper
// methods: GetRandomA/B/C/Offset/Lifespan/StartScale/FinalScale/
// StartTrans/FinalTrans, ShouldEmitParticle, and InitEnd (which sets
// SortingSphere.Radius from MaxA * LifeSpan).
//
// **DAT path.** Callers do:
//   const wasmInfo = await fetchParticleEmitter(0x32000456); // wasm-bindgen
//   const info = new ParticleEmitterInfo(wasmInfo);
//
// The wrapper snapshots the wasm scalars into local fields so we don't
// re-cross the JS↔wasm boundary on every per-particle helper call.

import * as THREE from "three";

import { currentTime, rng } from "./time_rng.js";
import { normalizeCheckSmall } from "./particle.js";

// E2 (2026-05-18): module-private scratches for `getRandomOffset()`'s
// internal math (random unit vector, OffsetDir projection). Both are
// consumed in-place inside getRandomOffset() and never leak — the result
// is written to the caller-supplied `out` Vector3. Matches the `_scratch*`
// convention from E1 (particle.js) and E4 (particle_emitter.js). DO NOT
// export or retain references outside getRandomOffset().
const _offsetR = new THREE.Vector3();
const _offsetProj = new THREE.Vector3();

/** EmitterType enum mirror — see external/ACE/Source/ACE.Entity/Enum/EmitterType.cs */
export const EmitterType = Object.freeze({
  Unknown: 0,
  BirthratePerSec: 1,
  BirthratePerMeter: 2,
});

/** ACE `float.Clamp(lo, hi)` extension. */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * ParticleEmitterInfo wrapper. Reads the wasm-exposed `ParticleEmitterJs`
 * camelCase getters once at construction and stores the data in flat
 * JS fields. All field names mirror the C# `ParticleEmitterInfo`
 * properties (PascalCase → camelCase).
 *
 * Either pass an object with the camelCase getters (`emitterType`,
 * `particleType`, `aX`, `aY`, `aZ`, etc.) OR pass a plain POJO with
 * those same field names. Both work — tests use the POJO form.
 */
export class ParticleEmitterInfo {
  constructor(wasmInfo) {
    // ParticleEmitterJs exposes camelCase getters via wasm-bindgen.
    // Snapshot them all into local Vector3s + scalars.
    this.id = wasmInfo.id ?? 0;
    this.emitterType = wasmInfo.emitterType ?? 0;
    this.particleType = wasmInfo.particleType ?? 0;
    this.gfxObjId = wasmInfo.gfxObjId ?? 0;
    this.hwGfxObjId = wasmInfo.hwGfxObjId ?? 0;
    this.birthrate = wasmInfo.birthrate ?? 0;
    this.maxParticles = wasmInfo.maxParticles ?? 0;
    this.initialParticles = wasmInfo.initialParticles ?? 0;
    this.totalParticles = wasmInfo.totalParticles ?? 0;
    this.totalSeconds = wasmInfo.totalSeconds ?? 0;
    this.lifespan = wasmInfo.lifespan ?? 0;
    this.lifespanRand = wasmInfo.lifespanRand ?? 0;
    this.offsetDir = new THREE.Vector3(
      wasmInfo.offsetDirX ?? 0,
      wasmInfo.offsetDirY ?? 0,
      wasmInfo.offsetDirZ ?? 0,
    );
    this.minOffset = wasmInfo.minOffset ?? 0;
    this.maxOffset = wasmInfo.maxOffset ?? 0;
    this.a = new THREE.Vector3(
      wasmInfo.aX ?? 0,
      wasmInfo.aY ?? 0,
      wasmInfo.aZ ?? 0,
    );
    this.minA = wasmInfo.minA ?? 1;
    this.maxA = wasmInfo.maxA ?? 1;
    this.b = new THREE.Vector3(
      wasmInfo.bX ?? 0,
      wasmInfo.bY ?? 0,
      wasmInfo.bZ ?? 0,
    );
    this.minB = wasmInfo.minB ?? 1;
    this.maxB = wasmInfo.maxB ?? 1;
    this.c = new THREE.Vector3(
      wasmInfo.cX ?? 0,
      wasmInfo.cY ?? 0,
      wasmInfo.cZ ?? 0,
    );
    this.minC = wasmInfo.minC ?? 1;
    this.maxC = wasmInfo.maxC ?? 1;
    this.scaleRand = wasmInfo.scaleRand ?? 0;
    this.startScale = wasmInfo.startScale ?? 1;
    this.finalScale = wasmInfo.finalScale ?? 1;
    this.transRand = wasmInfo.transRand ?? 0;
    this.startTrans = wasmInfo.startTrans ?? 0;
    this.finalTrans = wasmInfo.finalTrans ?? 0;
    this.isParentLocal = !!wasmInfo.isParentLocal;

    // SortingSphere: bounded by max(maxOffset, maxA * lifespan). Used by
    // the renderer for frustum-culling the emitter as a whole.
    this.sortingSphere = { center: new THREE.Vector3(0, 0, 0), radius: 0 };
    this.initEnd();
  }

  /** Port of ACE `InitEnd()` (ParticleEmitterInfo.cs:144-153). */
  initEnd() {
    let maxOff = this.maxOffset;
    const velocityRadius = this.maxA * this.lifespan;
    if (maxOff <= velocityRadius) {
      maxOff = velocityRadius;
    }
    this.sortingSphere.center.set(0, 0, 0);
    this.sortingSphere.radius = maxOff;
  }

  // P1 fidelity fix (2026-05-29) — these 5 helpers target RETAIL, not ACE.
  // Retail `ParticleEmitter::EmitParticle` (acclient.c:331054) calls all 5
  // per spawned particle; the arithmetic at acclient.c:324328-324403 is
  // ADDITIVE for ALL five fields: `RollDice(-1,1) * <rand> + <value>`.
  // ACE's C# diverges (it uses `r * rand * value` for FinalScale/StartTrans/
  // FinalTrans — only StartScale + Lifespan match retail). The 3 multiplicative
  // helpers below were flipped to additive to match retail. The random draw
  // `rng() * 2 - 1` is in [-1, 1), matching retail's `Random::RollDice(-1, 1)`.
  // Fail-soft: when the corresponding *Rand field is 0, `r * 0 + value`
  // collapses to exactly the authored value (zero jitter), so the default
  // render is unchanged.

  /** Port of `GetRandomStartScale` (retail acclient.c:324328). */
  getRandomStartScale() {
    // retail: result = RollDice(-1,1) * scale_rand + start_scale; Clamp(0.1, 10);
    const r = rng() * 2.0 - 1.0;
    return clamp(r * this.scaleRand + this.startScale, 0.1, 10.0);
  }

  /** Port of `GetRandomFinalScale` (retail acclient.c:324343). */
  getRandomFinalScale() {
    // retail: result = RollDice(-1,1) * scale_rand + final_scale; Clamp(0.1, 10);
    // (Additive — corrected from ACE's multiplicative `r * rand * value` to
    // match retail; this is a RETAIL-fidelity client.)
    const r = rng() * 2.0 - 1.0;
    return clamp(r * this.scaleRand + this.finalScale, 0.1, 10.0);
  }

  /** Port of `GetRandomStartTrans` (retail acclient.c:324373). */
  getRandomStartTrans() {
    // retail: result = RollDice(-1,1) * trans_rand + start_trans; Clamp(0, 1);
    // (Additive — corrected from ACE's multiplicative form.)
    const r = rng() * 2.0 - 1.0;
    return clamp(r * this.transRand + this.startTrans, 0.0, 1.0);
  }

  /** Port of `GetRandomFinalTrans` (retail acclient.c:324388). */
  getRandomFinalTrans() {
    // retail: result = RollDice(-1,1) * trans_rand + final_trans; Clamp(0, 1);
    // (Additive — corrected from ACE's multiplicative form.)
    const r = rng() * 2.0 - 1.0;
    return clamp(r * this.transRand + this.finalTrans, 0.0, 1.0);
  }

  /** Port of `GetRandomLifespan` (retail acclient.c:324403). */
  getRandomLifespan() {
    // retail: result = RollDice(-1,1) * lifespan_rand + lifespan; floor at 0.
    const r = rng() * 2.0 - 1.0;
    return Math.max(0.0, r * this.lifespanRand + this.lifespan);
  }

  /**
   * Port of `GetRandomOffset` (ParticleEmitterInfo.cs:173-187).
   *
   * E2 (2026-05-18): writes into caller-supplied `out` Vector3 instead of
   * allocating. If `out` is omitted, allocates a fresh Vector3 (for
   * back-compat with non-hot-path callers like test_particles.mjs).
   *
   * @param {THREE.Vector3} [out] Destination vector. If provided, the
   *        result is written here and returned. RNG calls + math semantics
   *        are unchanged from the allocating form.
   * @returns {THREE.Vector3} `out` (or a fresh Vector3 if `out` was omitted).
   */
  getRandomOffset(out) {
    const result = out || new THREE.Vector3();
    // Build the random unit-cube point in a module-scratch — never escapes.
    _offsetR.set(
      rng() * 2.0 - 1.0,
      rng() * 2.0 - 1.0,
      rng() * 2.0 - 1.0,
    );
    // randomAngle = r - OffsetDir * dot(OffsetDir, r);
    const dot = this.offsetDir.dot(_offsetR);
    // Build OffsetDir*dot in a second scratch, then write the difference
    // into `result` directly via subVectors.
    _offsetProj.copy(this.offsetDir).multiplyScalar(dot);
    result.subVectors(_offsetR, _offsetProj);
    if (normalizeCheckSmall(result)) {
      return result.set(0, 0, 0);
    }
    // ACE: scaled = randomAngle * ((MaxOffset - MinOffset) + MinOffset)
    //               * ThreadSafeRandom.Next(0, 1);
    // The `(MaxOffset - MinOffset) + MinOffset` collapses to just `MaxOffset`
    // mathematically; this is an ACE bug-or-quirk (likely meant
    // `(MaxOffset - MinOffset) * t + MinOffset` for lerp) but we port
    // faithfully. Flagged for the report; do NOT fix here.
    const range = (this.maxOffset - this.minOffset) + this.minOffset;
    const t = rng();
    return result.multiplyScalar(range * t);
  }

  /**
   * Port of `GetRandomA` (ParticleEmitterInfo.cs:189-195).
   *
   * E2 (2026-05-18): writes into caller-supplied `out` Vector3 instead of
   * allocating. `out` is optional for back-compat.
   */
  getRandomA(out) {
    const result = out || new THREE.Vector3();
    const t = rng();
    const magnitude = (this.maxA - this.minA) * t + this.minA;
    return result.copy(this.a).multiplyScalar(magnitude);
  }

  /**
   * Port of `GetRandomB` (ParticleEmitterInfo.cs:197-203).
   *
   * E2 (2026-05-18): writes into caller-supplied `out` Vector3 instead of
   * allocating. `out` is optional for back-compat.
   */
  getRandomB(out) {
    const result = out || new THREE.Vector3();
    const t = rng();
    const magnitude = (this.maxB - this.minB) * t + this.minB;
    return result.copy(this.b).multiplyScalar(magnitude);
  }

  /**
   * Port of `GetRandomC` (ParticleEmitterInfo.cs:205-211).
   *
   * E2 (2026-05-18): writes into caller-supplied `out` Vector3 instead of
   * allocating. `out` is optional for back-compat.
   */
  getRandomC(out) {
    const result = out || new THREE.Vector3();
    const t = rng();
    const magnitude = (this.maxC - this.minC) * t + this.minC;
    return result.copy(this.c).multiplyScalar(magnitude);
  }

  /**
   * Port of `ShouldEmitParticle` (ParticleEmitterInfo.cs:155-171).
   *
   * @param {number} numParticles Currently-alive particles.
   * @param {number} totalEmitted Total emitted over emitter's lifetime.
   * @param {THREE.Vector3} emitterOffset For BirthratePerMeter (parent
   *                                       displacement since last emit).
   * @param {number} lastEmitTime CurrentTime when the last particle spawned.
   */
  shouldEmitParticle(numParticles, totalEmitted, emitterOffset, lastEmitTime) {
    if ((this.totalParticles <= 0 || totalEmitted < this.totalParticles)
        && numParticles < this.maxParticles) {
      if (this.emitterType === EmitterType.BirthratePerSec) {
        if (currentTime() - lastEmitTime > this.birthrate) {
          return true;
        }
      } else if (this.emitterType === EmitterType.BirthratePerMeter) {
        // ACE: lastEmitTime < emitterOffset.LengthSquared() — note the
        // variable name confusion; "lastEmitTime" is actually being
        // re-used as a per-meter accumulator here per ACE.cs. Faithful port.
        if (lastEmitTime < emitterOffset.lengthSq()) {
          return true;
        }
      }
    }
    return false;
  }
}
