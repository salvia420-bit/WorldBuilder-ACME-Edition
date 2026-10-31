// tests/helpers/gpu_particles_corpus.mjs — the randomized all-types corpus for
// `?gpuParticles` (R3-7a): every ParticleType 1..12 x four anchor variants
// (frozen yawed root, moving parent-local root, frozen part frame, moving
// parent-local part), persistent and finite, random authored vectors / spreads /
// lifespans (seeded), a zero-|C| GR emitter, a zero-C Explode, a zero lifespan,
// stretch rows (?fxMotion), random tick lengths, an orbiting camera. Optional
// large clock: the epoch is taken at the first emitter, then the clock jumps
// (every live particle dies and respawns at the large relative time).
// Shared by tests/gpu_particles.test.mjs and harness/glsl_smoke/gpu_particles_glsl.mjs.

import * as THREE from "three";
import { inputRng } from "../../tools/rust_parity/fixture_util.mjs";

const TRIG = new Set([4, 5, 6, 7, 9, 11]);

/**
 * @param GEN tools/rust_parity/gen_particles.mjs (POJO)
 * @param GP scene3d/particles/gpu_particles.js (setGpRebaseSeconds)
 * @param {{seed?: number, ticks?: number, clock?: number, rebase?: number|null}} opts
 * @returns {(h) => Promise<void>} a Harness scenario
 */
export function makeCorpusScenario(GEN, GP, { seed = 1, ticks = 48, clock = 0, rebase = null } = {}) {
  return async (h) => {
    const R = inputRng(seed);
    const u = (a, b) => a + (b - a) * R();
    if (rebase !== null) GP.setGpRebaseSeconds(rebase);
    h.defGfx(0x0100c701, {});
    h.defGfx(0x0100c702, { alpha: true });
    h.defGfx(0x0100c703, { bbMode: 0 });
    const frozen = [h.frozenAnchor(2, 1, 0.5, { yaw: 0.9 }), h.frozenAnchor(-4, 3, 1, { yaw: -2.2, partFrames: [[0.2, 0, 1.4, 0.5]] })];
    const rig = h.movingAnchor(1, -2, 0, { parts: 2 });
    for (let type = 1; type <= 12; type++) {
      for (let v = 0; v < 4; v++) {
        const pl = v === 1 || v === 3;
        const persistent = v !== 2;
        const anchor = v === 0 ? frozen[0] : v === 1 ? rig : v === 2 ? frozen[1] : rig;
        const partIndex = v === 2 ? 0 : v === 3 ? 1 : -1;
        const big = TRIG.has(type) ? 3 : 1;
        await h.add({
          anchor, partIndex,
          offset: v % 2 ? { position: new THREE.Vector3(u(-0.5, 0.5), u(-0.5, 0.5), u(0, 0.6)), quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(u(-1, 1), u(-1, 1), 1).normalize(), u(-1, 1)) } : null,
          info: GEN.POJO({
            particleType: type, hwGfxObjId: [0x0100c701, 0x0100c702, 0x0100c703][(type + v) % 3],
            id: (type + v) % 4 === 0 ? 0x3200000b : 0x32fff100 + type,
            isParentLocal: pl,
            totalParticles: persistent ? 0 : 6 + v, totalSeconds: 0,
            birthrate: u(0.01, 0.06), maxParticles: 10, initialParticles: 1 + (v % 3),
            lifespan: type === 1 && v === 2 ? 0 : u(0.2, 2.5), lifespanRand: type === 1 && v === 2 ? 0 : u(0, 0.4),
            offsetDirX: u(-1, 1), offsetDirY: u(-1, 1), offsetDirZ: u(-1, 1), minOffset: u(0, 0.2), maxOffset: u(0.2, 1),
            aX: u(-2, 2) * big, aY: u(-2, 2), aZ: u(-1, 3), minA: u(0.5, 1), maxA: u(1, 1.6),
            bX: u(-2, 2), bY: u(-2, 2), bZ: u(-9, 1), minB: u(0.5, 1), maxB: u(1, 1.5),
            cX: type === 6 && v === 3 ? 0 : u(-6, 6) * big, cY: type === 6 && v === 3 ? 0 : u(-6, 6), cZ: (type === 4 || type === 9) && v === 0 ? 0 : u(-12, 12),
            minC: (type === 4 || type === 9) && v === 0 ? 0 : u(0.5, 1), maxC: (type === 4 || type === 9) && v === 0 ? 0 : u(1, 1.5),
            scaleRand: u(0, 0.3), startScale: u(0.3, 2), finalScale: u(0.3, 3), transRand: u(0, 0.15), startTrans: u(0, 0.5), finalTrans: u(0.3, 1),
          }),
        });
      }
    }
    for (let i = 0; i < ticks; i++) {
      // a large clock: the epoch was taken at the first emitter, then the clock
      // jumps (every live particle dies and respawns at the large relative time)
      if (clock && i === 2) h.t += clock;
      rig.position.set(1 + 0.11 * i, -2 + Math.sin(0.3 * i), 0.04 * i);
      rig.quaternion.setFromAxisAngle(new THREE.Vector3(0.2, 0.1, 1).normalize(), 0.07 * i);
      for (const k of rig.userData.partKids) k.rotation.x = 0.13 * i;
      rig.updateMatrixWorld(true);
      h.cam.position.set(25 * Math.cos(0.17 * i), 9 + 0.2 * i, 25 * Math.sin(0.17 * i));
      h.cam.lookAt(0, 0, 0);
      await h.tick(u(1 / 120, 1 / 20));
    }
  };
}
