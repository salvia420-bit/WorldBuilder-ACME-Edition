// tests/particle_cull_freeze.test.mjs
//
// PLIFECYCLE-2 (2026-10-08) `?particleCullFreeze` (DEFAULT ON). RP6 culls a
// particle emitter by frustum + a 220 m cap and SKIPPED its updateParticles()
// while culled. Retail has no frustum cull; its only cull is the distance
// degrade inside ParticleEmitter::UpdateParticles (acclient.c:331097-331239):
//   - PERSISTENT (total_particles == 0 && total_seconds == 0): every slot's
//     birthtime is reset to curr_time each degraded update, so ages FREEZE with
//     no catch-up;
//   - FINITE: emission keeps running virtually (`ShouldEmitParticle` →
//     `RecordParticleEmission`, then `StopEmitter`), so the emitter stops on
//     its retail schedule while degraded.
// The skip broke both: a persistent emitter's particles kept their pre-cull
// `lastUpdateTime`, so the first update after re-entry added the whole
// off-screen interval and killed every one (chimney smoke / fountain mist came
// back EMPTY and refilled); a count-bounded emitter froze `totalEmitted`.
//
//   C1  persistent: same particles, ages within one frame of their cull-time
//       values after 10 s culled; the `=off` arm reproduces the catch-up kill.
//   C2  persistent STOPPED while culled: thawed once, then drains on the
//       culled drain path; lifetimes never go negative; no double count on a
//       re-entry mid-drain.
//   C3  finite: virtual emission while culled — totalEmitted reaches
//       totalParticles and the emitter stops, with no slot claimed; nothing
//       emits after re-entry. `=off` arm: totalEmitted frozen, never stops.
//   C4  the pure helpers (`_rp6Thaw` double-count guard, `_isPersistentEmitter`)
//       and the flag reader's off-spellings.
//
// Real ParticleManager + real THREE camera (RP6 resolves it off
// window.liveScene3d). Fails on the pre-change code (no freeze, no virtual
// emission: C1/C3 fail, the helpers do not exist).
//
// Run: node tests/particle_cull_freeze.test.mjs

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

globalThis.window = { location: { search: "" } };
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };

const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
let t = 1000;
setCurrentTime(() => t);
setRng(() => 0.5);

const {
  ParticleManager,
  setParticleCullFreezeFlag,
  particleCullFreezeEnabled,
  _rp6Thaw,
  _isPersistentEmitter,
} = await import("../scene3d/particles/particle_manager.js");

const DT = 0.05;
const ANCHOR = new THREE.Vector3(0, 0, 0);

function camNear() {
  cam.position.set(0, 0, 5);
  cam.lookAt(ANCHOR);
  cam.updateMatrixWorld(true);
}
function camFar() {
  cam.position.set(0, 0, 1300); // ≫ the 220 m RP6 cap, anchor dead ahead
  cam.lookAt(ANCHOR);
  cam.updateMatrixWorld(true);
}

function info(overrides) {
  return Object.assign({
    id: 0x32000999, emitterType: 1 /* BirthratePerSec */, particleType: 1 /* Still */,
    gfxObjId: 0, hwGfxObjId: 0x010010f9,
    birthrate: 0.5, maxParticles: 4, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 2.0, lifespanRand: 0,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0, minOffset: 0, maxOffset: 0,
    aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0, bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0,
    scaleRand: 0, startScale: 1, finalScale: 1, transRand: 0, startTrans: 0, finalTrans: 0,
    isParentLocal: true, billboard: false,
  }, overrides);
}

async function makeEmitter(overrides) {
  const mgr = new ParticleManager({
    scene: new THREE.Group(),
    geometryFactory: () => new THREE.BufferGeometry(),
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const id = await mgr.addEmitter({
    emitterInfo: info(overrides),
    parent: { position: ANCHOR.clone(), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  return { mgr, id, e: mgr.particleTable.get(id) };
}

const tickFor = (mgr, seconds) => {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { t += DT; mgr.tick(); }
};
/** Tick until the RP6 recheck lands on `want` (≤ recheckInterval ticks). */
const tickUntilCulled = (mgr, e, want) => {
  for (let i = 0; i < 12 && (e._rp6Culled === true) !== want; i++) { t += DT; mgr.tick(); }
  return (e._rp6Culled === true) === want;
};
/** slot → lifetime for every occupied slot (the same Particle object per slot). */
const liveAges = (e) => {
  const out = new Map();
  for (let i = 0; i < e.parts.length; i++) if (e.parts[i]) out.set(i, e.particles[i].lifetime);
  return out;
};

// ===========================================================================
console.log("C1 — persistent emitter: ages freeze while culled (retail birthtime reset)");
// ===========================================================================
async function persistentRun(freezeOn) {
  setParticleCullFreezeFlag(freezeOn);
  t = 1000;
  camNear();
  const { mgr, e } = await makeEmitter();
  tickFor(mgr, 1.5);
  camFar();
  const culled = tickUntilCulled(mgr, e, true);
  const before = liveAges(e);
  const nBefore = e.numParticles;
  tickFor(mgr, 10); // five lifespans off-screen
  camNear();
  const back = tickUntilCulled(mgr, e, false);
  return { e, culled, back, before, nBefore, after: liveAges(e) };
}
{
  const r = await persistentRun(true);
  check("C1 setup: emitter was culled, then came back", r.culled && r.back);
  check("C1 setup: it held live particles when culled", r.nBefore >= 2, `n=${r.nBefore}`);
  // The re-entry update may also emit one NEW particle (the emit clock is old,
  // exactly as retail's first non-degraded update), so compare per slot.
  let sameSlots = true;
  let maxDrift = 0;
  for (const [slot, age] of r.before) {
    if (!r.after.has(slot)) { sameSlots = false; continue; }
    maxDrift = Math.max(maxDrift, Math.abs(r.after.get(slot) - age));
  }
  check("C1 freeze: every pre-cull particle is still alive after 10 s culled (none killed by catch-up)",
    sameSlots && r.e.numParticles >= r.nBefore, `before=${r.nBefore} after=${r.e.numParticles}`);
  check("C1 freeze: each age is within one frame of its cull-time value",
    maxDrift <= DT + 1e-9, `maxDrift=${maxDrift.toFixed(4)} s`);
  check("C1 freeze: the frozen stamp is cleared on re-entry", r.e._rp6FrozenAt === undefined);
}
{
  const r = await persistentRun(false);
  let survivors = 0;
  for (const [slot, age] of r.before) {
    if (r.after.has(slot) && r.after.get(slot) >= age) survivors += 1;
  }
  check("C1 `=off` REPRO: re-entry adds the whole off-screen interval and kills every pre-cull particle",
    r.nBefore >= 2 && survivors === 0, `before=${r.nBefore} survivors=${survivors} after=${r.e.numParticles}`);
}

// ===========================================================================
console.log("C2 — persistent emitter STOPPED while culled: thaw once, then drain");
// ===========================================================================
{
  setParticleCullFreezeFlag(true);
  t = 1000;
  camNear();
  const { mgr, id, e } = await makeEmitter();
  tickFor(mgr, 1.5);
  camFar();
  tickUntilCulled(mgr, e, true);
  const frozenAges = liveAges(e);
  tickFor(mgr, 5);
  mgr.stopParticleEmitter(id);
  let negative = false;
  let minAge = Infinity;
  t += DT; mgr.tick(); // first culled drain tick after the stop
  for (const age of liveAges(e).values()) { if (age < 0) negative = true; minAge = Math.min(minAge, age); }
  check("C2 the drain thaws the frozen interval once (stamp cleared)", e._rp6FrozenAt === undefined);
  let drift = 0;
  for (const [slot, age] of frozenAges) {
    if (mgr.particleTable.has(id) && e.parts[slot]) drift = Math.max(drift, Math.abs(e.particles[slot].lifetime - age));
  }
  check("C2 the 5 s frozen while running is not charged to the particles",
    drift <= DT + 1e-9, `drift=${drift.toFixed(4)} s`);
  // Re-enter half-way through the drain: no time may be counted twice.
  tickFor(mgr, 0.5);
  const midDrain = liveAges(e);
  camNear();
  tickUntilCulled(mgr, e, false);
  const ticksBack = liveAges(e);
  let jump = 0;
  for (const [slot, age] of midDrain) {
    if (ticksBack.has(slot)) {
      const d = ticksBack.get(slot) - age;
      if (d < 0) negative = true;
      jump = Math.max(jump, d);
    }
  }
  check("C2 lifetimes never go negative", !negative && minAge >= 0, `min=${minAge}`);
  check("C2 re-entry mid-drain adds only the ticks that passed (no double count)",
    jump <= 12 * DT + 1e-9, `jump=${jump.toFixed(3)} s`);
  tickFor(mgr, 3);
  check("C2 the stopped emitter drains and is removed", !mgr.particleTable.has(id));
}

// ===========================================================================
console.log("C3 — finite emitter: virtual emission while culled (retail RecordParticleEmission)");
// ===========================================================================
async function finiteRun(freezeOn) {
  setParticleCullFreezeFlag(freezeOn);
  t = 1000;
  camNear();
  const { mgr, id, e } = await makeEmitter({
    birthrate: 0.1, maxParticles: 10, totalParticles: 10, lifespan: 5.0,
  });
  tickFor(mgr, 0.3);
  camFar();
  const culled = tickUntilCulled(mgr, e, true);
  const emittedAtCull = e.totalEmitted;
  const numAtCull = e.numParticles;
  tickFor(mgr, 2);
  const whileCulled = {
    totalEmitted: e.totalEmitted, stopped: e.stopped, numParticles: e.numParticles,
    stillCulled: e._rp6Culled === true,
  };
  camNear();
  tickUntilCulled(mgr, e, false);
  tickFor(mgr, 1);
  return { mgr, id, e, culled, emittedAtCull, numAtCull, whileCulled };
}
{
  const r = await finiteRun(true);
  check("C3 setup: culled mid-emission", r.culled && r.emittedAtCull > 0 && r.emittedAtCull < 10,
    `emittedAtCull=${r.emittedAtCull}`);
  check("C3 freeze: totalEmitted reaches totalParticles WHILE culled",
    r.whileCulled.stillCulled && r.whileCulled.totalEmitted === 10, `totalEmitted=${r.whileCulled.totalEmitted}`);
  check("C3 freeze: the emitter stops on schedule while culled", r.whileCulled.stopped === true);
  check("C3 freeze: virtual emissions claim no slot (numParticles unchanged)",
    r.whileCulled.numParticles === r.numAtCull, `num=${r.whileCulled.numParticles} atCull=${r.numAtCull}`);
  check("C3 freeze: nothing is emitted after re-entry", r.e.totalEmitted === 10 && r.e.numParticles <= r.numAtCull,
    `totalEmitted=${r.e.totalEmitted} num=${r.e.numParticles}`);
}
{
  const r = await finiteRun(false);
  check("C3 `=off` REPRO: totalEmitted frozen while culled and the emitter never stops",
    r.whileCulled.totalEmitted === r.emittedAtCull && r.whileCulled.stopped === false,
    `totalEmitted=${r.whileCulled.totalEmitted} stopped=${r.whileCulled.stopped}`);
  check("C3 `=off` REPRO: it resumes emitting late after re-entry", r.e.totalEmitted > r.emittedAtCull);
}

// ===========================================================================
console.log("C4 — helpers + flag reader");
// ===========================================================================
{
  const p = { lastUpdateTime: 10 };
  const e = { parts: [{}, null], particles: [p, { lastUpdateTime: 3 }], _rp6FrozenAt: 20 };
  check("C4 _rp6Thaw shifts live slots by the frozen interval", _rp6Thaw(e, 25) === 5 && p.lastUpdateTime === 15);
  check("C4 _rp6Thaw leaves free slots alone", e.particles[1].lastUpdateTime === 3);
  check("C4 _rp6Thaw is one-shot (second call is a no-op)", _rp6Thaw(e, 40) === 0 && p.lastUpdateTime === 15);
  check("C4 _isPersistentEmitter: 0/0 only",
    _isPersistentEmitter({ info: { totalParticles: 0, totalSeconds: 0 } })
    && !_isPersistentEmitter({ info: { totalParticles: 5, totalSeconds: 0 } })
    && !_isPersistentEmitter({ info: { totalParticles: 0, totalSeconds: 2 } })
    && !_isPersistentEmitter({ info: null }));
  const read = (search) => {
    window.location = { search };
    const saved = globalThis.location;
    globalThis.location = { search };
    setParticleCullFreezeFlag(null);
    const v = particleCullFreezeEnabled();
    globalThis.location = saved;
    return v;
  };
  check("C4 flag: bare URL → ON", read("") === true);
  check("C4 flag: =off / =0 / =false → OFF",
    read("?particleCullFreeze=off") === false && read("?particleCullFreeze=0") === false
    && read("?particleCullFreeze=false") === false);
  check("C4 flag: any other value → ON", read("?particleCullFreeze=on") === true);
  setParticleCullFreezeFlag(null);
}

setCurrentTime(null);
setRng(null);
console.log(`\nparticle cull freeze: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
