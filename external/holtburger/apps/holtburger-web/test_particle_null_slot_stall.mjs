// ParticleEmitter — the NULL-MESH SLOT STALL (2026-08-03, review finding #4).
//
// `_createSlots` stores whatever `_meshFactory(i)` resolved to, including null (a
// missing GfxObj, a decode-starved bake, a model that triangulates to zero
// polys), and still advances `_createdSlots`. `getNextParticleIdx` used to return
// the first index whose `parts[i]` was null; `emitParticle` bails on `!mesh`
// BEFORE assigning `parts[idx]`. So that index came back on every tick forever:
// the emitter never emitted, and `_growSlots()` was unreachable because a "free"
// slot had been found. One failed mesh permanently bricked the emitter while it
// kept paying the full per-frame tick cost.
//
// These are BEHAVIOUR checks against the real class — no THREE needed beyond what
// the module already imports.

import * as THREE from "three";
import { ParticleEmitter } from "./scene3d/particles/particle_emitter.js";
// setInfo() expects a ParticleEmitterInfo, exactly as ParticleManager.addEmitter
// constructs one from the synthesized POJO — using the real class here keeps this
// on the runtime's own path rather than a stub that could drift from it.
import { ParticleEmitterInfo } from "./scene3d/particles/particle_emitter_info.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  [OK] ${l}`); }
  else { fail++; console.log(`  [FAIL] ${l} ${x}`); }
};

function makeParent() {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
}
function makeMesh() {
  const m = new THREE.Mesh();
  m.visible = false;
  return m;
}
/** A persistent ambient emitterInfo, the synthesized-family shape, wrapped in the
 *  real ParticleEmitterInfo exactly as ParticleManager.addEmitter does. */
function info(overrides = {}) {
  return new ParticleEmitterInfo({
    id: 0xF0E0BEEF, emitterType: 1, particleType: 0, hwGfxObjId: 0x01001062,
    birthrate: 0.0001, maxParticles: 8, initialParticles: 2,
    totalParticles: 0, totalSeconds: 0,
    lifespan: 100, lifespanRand: 0,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0, minOffset: 0, maxOffset: 0.1,
    aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1,
    cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1,
    scaleRand: 0, startScale: 1, finalScale: 1,
    transRand: 0, startTrans: 0, finalTrans: 1,
    isParentLocal: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. THE STALL: slot 0's mesh fails to build, every other slot is fine.
// ---------------------------------------------------------------------------
{
  const built = [];
  const em = new ParticleEmitter({
    parent: makeParent(),
    scene: new THREE.Group(),
    // Slot 0 fails (the decode-starved case); 1..n succeed.
    meshFactory: (i) => { built.push(i); return i === 0 ? null : makeMesh(); },
  });
  await em.setInfo(info());

  ok("setup: slot 0 really did resolve to null", em.partStorage[0] === null);
  ok("setup: slot 1 built fine", !!em.partStorage[1]);

  const idx = em.getNextParticleIdx();
  ok("★ getNextParticleIdx SKIPS the unrenderable slot 0", idx !== 0, `idx=${idx}`);
  ok("★ ...and hands back a slot that can actually draw", idx > 0 && !!em.partStorage[idx]);

  em.emitParticle();
  ok("★ BEHAVIOUR: the emitter actually emits (pre-fix: numParticles stuck at 0)",
    em.numParticles === 1, `numParticles=${em.numParticles}`);
  ok("★ ...and the emitted slot is marked busy so it is not re-handed out",
    em.parts[idx] !== null && em.getNextParticleIdx() !== idx);

  // Drive it like the frame loop does. Pre-fix this loop emitted exactly nothing.
  for (let f = 0; f < 30; f++) em.updateParticles();
  ok("★ BEHAVIOUR: 30 ticks fill the emitter instead of spinning on the dead slot",
    em.numParticles > 1, `numParticles=${em.numParticles}`);
  ok("the dead slot is never claimed", em.parts[0] === null);
}

// ---------------------------------------------------------------------------
// 2. initEnd's opening burst must survive a dead slot too.
// ---------------------------------------------------------------------------
{
  const em = new ParticleEmitter({
    parent: makeParent(), scene: new THREE.Group(),
    meshFactory: (i) => (i === 0 ? null : makeMesh()),
  });
  await em.setInfo(info({ initialParticles: 3 }));
  em.initEnd();
  ok("★ initEnd's burst spawns despite a dead slot (pre-fix: 0 of 3)",
    em.numParticles === 3, `numParticles=${em.numParticles}`);
}

// ---------------------------------------------------------------------------
// 3. EVERY slot dead ⇒ -1 (nothing can draw), and no infinite loop. This is the
//    case that must NOT be "fixed" into a busy spin.
// ---------------------------------------------------------------------------
{
  const em = new ParticleEmitter({
    parent: makeParent(), scene: new THREE.Group(),
    meshFactory: () => null,
  });
  await em.setInfo(info({ maxParticles: 4, initialParticles: 1 }));
  ok("★ all-dead emitter reports -1 (correct: nothing here can ever render)",
    em.getNextParticleIdx() === -1);
  em.emitParticle();
  ok("all-dead emitter emits nothing and does not throw", em.numParticles === 0);
  for (let f = 0; f < 10; f++) em.updateParticles();
  ok("all-dead emitter survives 10 ticks without throwing", em.numParticles === 0);
}

// ---------------------------------------------------------------------------
// 4. NEGATIVE CONTROL — the healthy path is unchanged (no behaviour drift).
// ---------------------------------------------------------------------------
{
  const em = new ParticleEmitter({
    parent: makeParent(), scene: new THREE.Group(),
    meshFactory: () => makeMesh(),
  });
  await em.setInfo(info());
  ok("healthy emitter still hands out slot 0 first (unchanged ordering)",
    em.getNextParticleIdx() === 0);
  em.emitParticle();
  em.emitParticle();
  ok("healthy emitter fills slots in order", em.parts[0] !== null && em.parts[1] !== null);
  ok("healthy emitter counts both", em.numParticles === 2);
}

console.log(`\nParticleEmitter null-slot stall: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
