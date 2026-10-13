// tests/particle_init_frame.test.mjs
//
// particles-scripts-5 (2026-10-13). Retail `Particle::Init` ends with
// `Particle::Update(..., part, &this->start_frame)` (acclient.c:330830). ACE
// Particle.cs:118 passes `pFrame` (the emitter's parentOffset) instead, and
// particle.js followed it. `ParticleEmitter.updateParticles` runs the per-slot
// update loop BEFORE `emitParticle`, and ParticleManager appends the instance
// matrices right after, so every new particle was drawn for one frame at
// parentOffset + Offset in `_scene` space (absolute AC world coordinates, i.e.
// near the SW map corner) — a frame late, and a per-metre trail lost its head.
//
//   P1  Particle.init alone: Still particle sits at startFrame + l2g(offset)
//       (2350, not the ACE 900), also with a rotated start frame.
//   P2  GR types take their t=0 orientation from the start frame.
//   P3  `?particleInitFrameAce=on` (a second module instance) restores 900.
//   E1  ParticleEmitter, root anchor far from the origin: the slot emitted by
//       updateParticles() is at anchor + l2g(offset) before any second update
//       (parent-local and start-frame emitters both).
//   E2  initEnd's t=0 burst is at the anchor too.
//   E3  BirthratePerMeter trail (the cast-hand 0x32000109 shape): every tick's
//       new head particle is at the CURRENT anchor.
//   M1  ParticleManager.tick(): every instance written for the frame that
//       emitted is at the anchor (no near-origin instance).
//
// Fails on the pre-change code (P1/P2/E1/E2/E3/M1).
//
// Run: node tests/particle_init_frame.test.mjs   (from apps/holtburger-web/)

import * as THREE from "three";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const near = (v, x, y, z, eps = 1e-4) =>
  Math.abs(v.x - x) <= eps && Math.abs(v.y - y) <= eps && Math.abs(v.z - z) <= eps;
const fmt = (v) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
let t = 100;
setCurrentTime(() => t);
setRng(() => 0.5); // centred: getRandomOffset → 0 with min/maxOffset 0, A/B/C magnitude = min

// Default module instance (no `window` → every particle.js escape reads off).
const { Particle, ParticleType } = await import("../scene3d/particles/particle.js");
const { ParticleEmitter } = await import("../scene3d/particles/particle_emitter.js");
const { ParticleEmitterInfo, EmitterType } = await import("../scene3d/particles/particle_emitter_info.js");

// Legacy module instance: the escape is read once at module load, so a fresh
// instance (query-suffixed URL) sees `?particleInitFrameAce=on`.
globalThis.window = { location: { search: "?particleInitFrameAce=on" } };
const legacyMod = await import(
  new URL("../scene3d/particles/particle.js?particleInitFrameAce=on", import.meta.url).href);
delete globalThis.window;

function makeMesh() {
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 });
  return new THREE.Mesh(new THREE.BufferGeometry(), mat);
}
function infoPojo(overrides = {}) {
  return Object.assign({
    id: 0x32000999, emitterType: EmitterType.BirthratePerSec, particleType: ParticleType.Still,
    gfxObjId: 0, hwGfxObjId: 0x010010f9,
    birthrate: 0.05, maxParticles: 8, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 2.0, lifespanRand: 0,
    offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0, minOffset: 0, maxOffset: 0,
    aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0, bX: 0, bY: 0, bZ: 0, minB: 0, maxB: 0,
    cX: 0, cY: 0, cZ: 0, minC: 0, maxC: 0,
    scaleRand: 0, startScale: 1, finalScale: 1, transRand: 0, startTrans: 0, finalTrans: 0,
    isParentLocal: true, billboard: false,
  }, overrides);
}
const qZ90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const qX30 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 6);

/** The test_plan fixture: parent (1900,0,0), parentOffset (450,0,0), no random offset. */
function initStill(ParticleCls, parentQ = new THREE.Quaternion()) {
  t = 100;
  const info = new ParticleEmitterInfo(infoPojo({ particleType: ParticleType.Still }));
  const mesh = makeMesh();
  const parent = { position: new THREE.Vector3(1900, 0, 0), quaternion: parentQ.clone() };
  const parentOffset = { position: new THREE.Vector3(450, 0, 0), quaternion: new THREE.Quaternion() };
  const p = new ParticleCls();
  p.init(info, parent, -1, parentOffset, mesh, new THREE.Vector3(0, 0, 0), false,
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
  return mesh;
}

// ===========================================================================
console.log("P1 — Particle.init's first update uses the start frame (acclient.c:330830)");
// ===========================================================================
{
  const mesh = initStill(Particle);
  check("P1 Still: position right after init = startFrame + l2g(offset) = (2350, 0, 0)",
    near(mesh.position, 2350, 0, 0), fmt(mesh.position));
  check("P1 Still: the particle is visible on its first frame", mesh.visible === true);

  const rot = initStill(Particle, qZ90);
  // l2g(startFrame(+90° about Z), (450,0,0)) = (0, 450, 0).
  check("P1 Still, rotated start frame: (1900, 450, 0)",
    near(rot.position, 1900, 450, 0), fmt(rot.position));
}

// ===========================================================================
console.log("P2 — GR particle t=0 orientation comes from the start frame");
// ===========================================================================
{
  const grun = (ParticleCls) => {
    t = 100;
    const info = new ParticleEmitterInfo(infoPojo({ particleType: ParticleType.ParabolicLVGAGR }));
    const mesh = makeMesh();
    const parent = { position: new THREE.Vector3(10, 20, 30), quaternion: qZ90.clone() };
    const parentOffset = { position: new THREE.Vector3(0, 0, 0), quaternion: qX30.clone() };
    const p = new ParticleCls();
    p.init(info, parent, -1, parentOffset, mesh, new THREE.Vector3(0, 0, 0), false,
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(0, 0, 0));
    return mesh;
  };
  const m = grun(Particle);
  check("P2 LVGAGR: position = start frame origin (10, 20, 30)", near(m.position, 10, 20, 30), fmt(m.position));
  check("P2 LVGAGR: orientation = start frame orientation (not parentOffset's)",
    Math.abs(Math.abs(m.quaternion.dot(qZ90)) - 1) < 1e-6, `dot=${m.quaternion.dot(qZ90)}`);
  const lm = grun(legacyMod.Particle);
  check("P2 legacy arm: orientation = parentOffset orientation (ACE pFrame)",
    Math.abs(Math.abs(lm.quaternion.dot(qX30)) - 1) < 1e-6, `dot=${lm.quaternion.dot(qX30)}`);
}

// ===========================================================================
console.log("P3 — ?particleInitFrameAce=on restores the ACE pFrame first update");
// ===========================================================================
{
  check("P3 the legacy instance is a distinct module", legacyMod.Particle !== Particle);
  const mesh = initStill(legacyMod.Particle);
  check("P3 legacy Still: position right after init = parentOffset + offset = (900, 0, 0)",
    near(mesh.position, 900, 0, 0), fmt(mesh.position));
}

// ===========================================================================
console.log("E1 — ParticleEmitter: the slot emitted this tick is at the anchor before any second update");
// ===========================================================================
const ANCHOR = new THREE.Vector3(40123.5, 31007.25, 61.5); // far from the AC world origin
const OFFSET = new THREE.Vector3(0.4, 0, 1.1);             // emitter parentOffset (hook offset)
// l2g(qZ90, OFFSET) = (0, 0.4, 1.1)
const EXPECT = ANCHOR.clone().add(OFFSET.clone().applyQuaternion(qZ90));

async function makeEmitter(overrides, parentQ = qZ90) {
  t = 100;
  const scene = new THREE.Group();
  const parent = { position: ANCHOR.clone(), quaternion: parentQ.clone() };
  const em = new ParticleEmitter({ parent, scene, meshFactory: () => makeMesh() });
  const ok = await em.setInfo(new ParticleEmitterInfo(infoPojo(overrides)));
  em.setParenting(-1, { position: OFFSET.clone(), quaternion: new THREE.Quaternion() });
  em.initEnd();
  return { em, parent, ok };
}
const occupied = (em) => {
  const s = new Set();
  for (let i = 0; i < em.parts.length; i++) if (em.parts[i]) s.add(i);
  return s;
};

for (const isParentLocal of [true, false]) {
  const { em, ok } = await makeEmitter({ isParentLocal });
  check(`E1 setup (isParentLocal=${isParentLocal}): setInfo ok, nothing live yet`, ok && em.numParticles === 0);
  t += 0.1;
  em.updateParticles();
  const live = [...occupied(em)];
  check(`E1 (isParentLocal=${isParentLocal}): updateParticles emitted exactly one`, live.length === 1, `live=${live}`);
  const mesh = em.parts[live[0]];
  check(`E1 (isParentLocal=${isParentLocal}): new slot at anchor + l2g(offset) ${fmt(EXPECT)}`,
    !!mesh && near(mesh.position, EXPECT.x, EXPECT.y, EXPECT.z), mesh ? fmt(mesh.position) : "no mesh");
  check(`E1 (isParentLocal=${isParentLocal}): ...and it is visible this frame`, !!mesh && mesh.visible === true);
}

// ===========================================================================
console.log("E2 — initEnd's t=0 burst is at the anchor");
// ===========================================================================
{
  const { em } = await makeEmitter({ initialParticles: 3, isParentLocal: true });
  const live = [...occupied(em)];
  check("E2 initEnd burst: 3 particles live", live.length === 3, `live=${live.length}`);
  const allAtAnchor = live.every((i) => near(em.parts[i].position, EXPECT.x, EXPECT.y, EXPECT.z));
  check("E2 initEnd burst: every burst particle at anchor + l2g(offset) before any update", allAtAnchor,
    live.map((i) => fmt(em.parts[i].position)).join(" "));
}

// ===========================================================================
console.log("E3 — BirthratePerMeter trail: each tick's head particle is at the current anchor");
// ===========================================================================
{
  const { em, parent } = await makeEmitter({
    emitterType: EmitterType.BirthratePerMeter, birthrate: 0.05,
    maxParticles: 16, totalParticles: 0, isParentLocal: false, lifespan: 5,
  }, new THREE.Quaternion());
  let heads = 0;
  let headsAtAnchor = 0;
  let worst = "";
  for (let k = 0; k < 6; k++) {
    t += 1 / 30;
    parent.position.x += 0.2; // the hand moves 0.2 m per frame (> 0.05 m birthrate)
    const before = occupied(em);
    em.updateParticles();
    for (const i of occupied(em)) {
      if (before.has(i)) continue;
      heads += 1;
      const want = parent.position.clone().add(OFFSET);
      if (near(em.parts[i].position, want.x, want.y, want.z)) headsAtAnchor += 1;
      else worst = `tick ${k}: ${fmt(em.parts[i].position)} want ${fmt(want)}`;
    }
  }
  check("E3 a head particle is emitted every tick", heads === 6, `heads=${heads}`);
  check("E3 every head particle sits at the CURRENT anchor + offset on its first frame",
    headsAtAnchor === heads && heads > 0, worst || `${headsAtAnchor}/${heads}`);
}

// ===========================================================================
console.log("M1 — ParticleManager.tick(): the emit frame's instances are all at the anchor");
// ===========================================================================
{
  const { ParticleManager } = await import("../scene3d/particles/particle_manager.js");
  t = 100;
  const mgr = new ParticleManager({
    scene: new THREE.Group(),
    geometryFactory: () => new THREE.BufferGeometry(),
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending }),
  });
  const id = await mgr.addEmitter({
    emitterInfo: infoPojo({ birthrate: 0.05, maxParticles: 8, isParentLocal: true }),
    parent: { position: ANCHOR.clone(), quaternion: new THREE.Quaternion() },
    partIndex: -1,
  });
  const e = mgr.particleTable.get(id);
  check("M1 setup: emitter registered", !!e);
  const want = ANCHOR; // no parentOffset on this request, identity orientation
  const positions = [];
  if (e) {
    t += 0.1;
    mgr.tick();
    if (e._instKey !== null && e._instKey !== undefined) {
      const m4 = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      for (const b of mgr._instBuckets.values()) {
        for (let n = 0; n < b.n; n++) {
          b.im.getMatrixAt(n, m4);
          positions.push(pos.setFromMatrixPosition(m4).clone());
        }
      }
    } else {
      for (const m of e.parts) if (m && m.visible !== false) positions.push(m.position.clone());
    }
  }
  check("M1 the emit tick drew the new particle", positions.length === 1, `n=${positions.length}`);
  check("M1 every instance drawn this tick is at the anchor (no near-origin instance)",
    positions.length > 0 && positions.every((p) => near(p, want.x, want.y, want.z)),
    positions.map(fmt).join(" "));
}

console.log(`\n[particle_init_frame] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
