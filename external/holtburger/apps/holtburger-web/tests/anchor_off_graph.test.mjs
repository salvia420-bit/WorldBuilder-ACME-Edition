// tests/anchor_off_graph.test.mjs — ?anchorOffGraph (2026-10-26, stage-2 S1b;
// docs/2026-10-26-rust-residency-design.md §4, lane notes docs/2026-10-26-rust-cull.md).
//
// The outdoor static default_script anchors move from staticsGroup to a
// per-landblock off-graph root (never in the scene; its matrixWorld a frozen
// copy of staticsGroup's). The claim is PIXEL IDENTITY for everything the
// anchors feed, so each check runs the SAME scripted scenario twice — flag off
// (anchors in staticsGroup, as shipped) and flag on — through the shipped code
// (attachStaticDefaultScripts → the real ParticleManager → the real
// LandblockLRU park / unpark / evict → rebuildStaticScriptEmittersForAnchors),
// with a scripted RNG and clock, and compares bits:
//   A1  after the attach: every emitter's RP6 cull sphere (centre + radius),
//       anchor frame (_resolveAnchorFrame), emitter origin, the anchor's and
//       each part frame's matrixWorld — bit-equal; 90 ticks of every particle
//       slot (position, quaternion, scale, opacity, visible) — bit-equal
//   A2  flag on: no anchor in staticsGroup or anywhere in the scene graph, each
//       anchor's parent is its landblock root (parent null, never walked by
//       the scene's matrix walk); the registry counts them
//   A3  park → unpark → rebuild: parents null while parked, restored after;
//       the rebuilt emitters and 90 more ticks — bit-equal to flag off
//   A4  evict: anchors detached (parent null) in both arms, the root forgotten
//   A5  ?staticScriptRadius tick: tears down / rebuilds the same emitters in
//       both arms (it reads the root registry instead of scanning)
//   A6  park while an anchor awaits its part frames (the attach's hand-off):
//       no chain, no freeze on the detached anchor; unpark chains it once —
//       in both arms
//   A7  the flag reader (default off, on/1/true/yes, off spellings)
//   A8  film's settle / pop-in signatures (film/runtime/world.js signature(),
//       take_player.js sceneSignature(), their statics term evaluated from the
//       shipped source): staticsGroup children + root children with the flag
//       on == staticsGroup children with it off, after every add of the
//       attach and at every step of park / unpark / rebuild / evict
//
// Run from apps/holtburger-web/:  node tests/anchor_off_graph.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const S = await import("../scene3d/statics.js");
const PM = await import("../scene3d/particles/particle_manager.js");
const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");
const { LandblockLRU } = await import("../scene3d/landblock_lru.js");
const { EmitterType } = await import("../scene3d/particles/particle_emitter_info.js");
const { ParticleType } = await import("../scene3d/particles/particle.js");

S.__setStaticPartAnchorForTest(true);

const realSetTimeout = globalThis.setTimeout;
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => realSetTimeout(r, 0)); };
const lbKey = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sameBits(a, b) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return `index ${i}: ${a[i]} vs ${b[i]}`;
  return null;
}

// ── fixtures: Setups with part poses, scripts, emitters ──────────────────────
const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.31, -0.72, 1.13)).normalize();
const SETUP_A = 0x02000407; // two parts: 17 m up (the drizzle), and an off-axis rotated one
const SETUP_B = 0x02000a01; // one part
// A6 only, one per arm: statics.js caches part poses per Setup for the session,
// and A6 needs the pose fetch to still be pending when the park lands.
const SETUP_C_OFF = 0x02000a02, SETUP_C_ON = 0x02000a03;
const POSE_C = Float32Array.from([0.25, -0.5, 1.75, Math.SQRT1_2, Math.SQRT1_2, 0, 0]);
const POSES = new Map([
  [SETUP_A, Float32Array.from([0, 0, 17, 1, 0, 0, 0, 0.35, -1.2, 2.5, q1.w, q1.x, q1.y, q1.z])],
  [SETUP_B, Float32Array.from([0.75, 0.5, 3.25, Math.SQRT1_2, 0, 0, Math.SQRT1_2])],
  [SETUP_C_OFF, POSE_C],
  [SETUP_C_ON, POSE_C],
]);
const ROOT = 0xffffffff;
function createHook(emitterDid, partIndex, off = [0, 0, 0], q = [0, 0, 0, 1]) {
  return {
    startTime: 0, hookType: 13, createParticleEmitterId: emitterDid, createParticlePartIndex: partIndex,
    createParticleOffsetX: off[0], createParticleOffsetY: off[1], createParticleOffsetZ: off[2],
    createParticleOffsetQX: q[0], createParticleOffsetQY: q[1], createParticleOffsetQZ: q[2], createParticleOffsetQW: q[3],
  };
}
const E_RAIN = 0x32000142, E_SMOKE = 0x32000143, E_SPARK = 0x32000144;
const qo = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.2, 0.93).normalize(), 0.9);
const S_ROOT = 0x33000b01, S_PART0 = 0x33000b02, S_MIXED = 0x33000b03;
const SCRIPTS = new Map([
  [S_ROOT, () => [createHook(E_SMOKE, ROOT, [0.5, -0.25, 1.0], [qo.x, qo.y, qo.z, qo.w])]],
  [S_PART0, () => [createHook(E_RAIN, 0)]],
  [S_MIXED, () => [createHook(E_SPARK, 1, [0.1, 0.2, -0.3]), createHook(E_SMOKE, ROOT)]],
]);
function infoPojo(id, over) {
  return Object.assign({
    id, emitterType: EmitterType.BirthratePerSec, particleType: ParticleType.ParabolicLVGAGR,
    gfxObjId: 0, hwGfxObjId: 0x010010f9, birthrate: 0.05, maxParticles: 12, initialParticles: 3,
    totalParticles: 0, totalSeconds: 0, lifespan: 1.0, lifespanRand: 0.25,
    offsetDirX: 0.3, offsetDirY: 0.1, offsetDirZ: 1, minOffset: 0.05, maxOffset: 0.4,
    aX: 0.2, aY: -0.4, aZ: 1.5, minA: 0.5, maxA: 1.5, bX: 0, bY: 0, bZ: -2.5, minB: 1, maxB: 1,
    cX: 0.5, cY: 1.2, cZ: 0.3, minC: 0.5, maxC: 2,
    scaleRand: 0.2, startScale: 0.6, finalScale: 1.4, transRand: 0.1, startTrans: 0.1, finalTrans: 0.9,
    isParentLocal: false,
  }, over);
}
const EMITTERS = new Map([
  [E_RAIN, () => infoPojo(E_RAIN, { particleType: ParticleType.LocalVelocity, birthrate: 0.1, maxParticles: 8, initialParticles: 2, lifespan: 0.7 })],
  [E_SMOKE, () => infoPojo(E_SMOKE, { isParentLocal: true, particleType: ParticleType.Still, birthrate: 0.2, lifespan: 2 })],
  [E_SPARK, () => infoPojo(E_SPARK, {})],
]);
const poseGates = new Map(); // setup id → promise fetchSetupPartPose waits on
const wasm = {
  fetchPhysicsScript: async (did) => ({ takeEntries: SCRIPTS.get(did >>> 0), free() {} }),
  fetchParticleEmitter: async (did) => EMITTERS.get(did >>> 0)(),
  fetchSetupPartPose: async (sid) => {
    const g = poseGates.get(sid >>> 0);
    if (g) await g;
    return POSES.get(sid >>> 0) ?? new Float32Array(0);
  },
};

// Placements: yaw-only and full-quaternion, scaled and not, three scripts,
// Setups with two / one / no part poses.
function placements(L) {
  const out = [];
  const scripts = [S_ROOT, S_PART0, S_MIXED];
  const models = [SETUP_A, SETUP_B, 0x01000001];
  for (let i = 0; i < 12; i += 1) {
    const p = {
      landblockId: (L | (0x0001 + i)) >>> 0, x: 10.25 + i * 13.5, y: 20.5 + (i % 4) * 31.75, z: 3.125 + i * 0.4,
      // every script on every kind of Setup
      defaultScriptId: scripts[i % 3], modelId: models[Math.floor(i / 3) % 3], scale: i % 4 === 1 ? 1.35 : 1, rotationZ: i * 0.57,
    };
    if (i % 2 === 1) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05 * i, -0.03 * i, 0.4 * i)).normalize();
      p.qw = q.w; p.qx = q.x; p.qy = q.y; p.qz = q.z;
    }
    out.push(p);
  }
  return out;
}

const quad = new THREE.BufferGeometry();
quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 0, 0.1]), 3));

function makeHost(bakedKeys) {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2; // AC Z-up → three Y-up, as index.js
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  staticsGroup.name = "statics";
  worldRoot.add(staticsGroup);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  scene.add(cam);
  const mgr = new PM.ParticleManager({
    scene: staticsGroup,
    instancing: false,
    geometryFactory: () => quad,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const host = {
    scene, worldRoot, staticsGroup, camera: cam, _staticParticleManager: mgr,
    staticsBakedLbs: new Set(bakedKeys), envCellLoadedLbs: new Set(), activeLights: [], terrainMaterials: [],
  };
  host._evictStaticParticlesForLb = S._evictStaticParticlesForLb;
  host._rebuildStaticParticlesForAnchors = (anchors) => S.rebuildStaticScriptEmittersForAnchors(host, anchors, wasm);
  window.liveScene3d = { camera: cam, cameraSwitcher: { activeCamera: cam } };
  return { host, mgr, scene, staticsGroup, cam };
}

// Camera near the landblock, in three world space (x, z_ac, -y_ac).
function aimAt(cam, L) {
  const ax = ((L >>> 24) & 0xff) * 192, ay = ((L >>> 16) & 0xff) * 192;
  cam.position.set(ax + 60, 40, -(ay + 30));
  cam.lookAt(ax + 90, 5, -(ay + 70));
  cam.updateMatrixWorld(true);
}

// Everything the anchors feed, for every emitter, in table order.
function emitterSnapshot(mgr) {
  const nums = [];
  const v = new THREE.Vector3();
  for (const em of mgr.particleTable.values()) {
    const a = em.parent;
    const r = PM.rp6CullSphere(em, v);
    nums.push(em.info.id >>> 0, em.partIndex | 0, r, v.x, v.y, v.z);
    const f = em._resolveAnchorFrame();
    nums.push(f.position.x, f.position.y, f.position.z, f.quaternion.x, f.quaternion.y, f.quaternion.z, f.quaternion.w);
    const o = em._emitterOrigin(new THREE.Vector3());
    nums.push(o.x, o.y, o.z);
    nums.push(...a.matrixWorld.elements);
    for (const part of a.children) nums.push(...part.matrixWorld.elements);
    nums.push(a.position.x, a.position.y, a.position.z, a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w);
  }
  return nums;
}
function slotNums(mgr, out) {
  for (const em of mgr.particleTable.values()) {
    for (let i = 0; i < em.partStorage.length; i += 1) {
      const m = em.parts[i];
      if (!m) { out.push(-1); continue; }
      out.push(i, m.position.x, m.position.y, m.position.z, m.quaternion.x, m.quaternion.y, m.quaternion.z,
        m.quaternion.w, m.scale.x, m.scale.y, m.scale.z, m.material.opacity, m.visible ? 1 : 0);
    }
  }
}
async function ticks(w, clock, n, out) {
  for (let f = 0; f < n; f += 1) {
    clock.t += 1 / 60;
    w.scene.updateMatrixWorld();
    w.mgr.tick();
    await new Promise((r) => setImmediate(r)); // lazy slot growth lands identically in both arms
    slotNums(w.mgr, out);
  }
}
const anchorsOf = (mgr) => [...new Set([...mgr.particleTable.values()].map((e) => e.parent))];

// Count scene-walk visits of anchor nodes.
const _umw = THREE.Object3D.prototype.updateMatrixWorld;
let anchorVisits = 0;
THREE.Object3D.prototype.updateMatrixWorld = function (force) {
  if (this.userData && this.userData.isStaticScriptAnchor === true) anchorVisits += 1;
  return _umw.call(this, force);
};

// The statics term of film's scene signatures, taken from the shipped readers
// (film/runtime/world.js signature(), take_player.js sceneSignature()) and
// evaluated as is (A8). null when a reader no longer has that shape.
const FILM_READERS = ["../scene3d/film/runtime/world.js", "../scene3d/film/runtime/take_player.js"];
const filmTerms = FILM_READERS.map((rel) => {
  const m = readFileSync(new URL(rel, import.meta.url), "utf8")
    .match(/const sg = live\.staticsGroup;\r?\n[\s\S]*?if \(s >= 0 && roots instanceof Map\)[^\n]*\n/);
  return m ? m[0] : null;
});
const filmStaticsTerm = filmTerms[0] ? new Function("live", `${filmTerms[0]}return s;`) : () => NaN;
const oldStaticsTerm = (live) => (live.staticsGroup && Array.isArray(live.staticsGroup.children) ? live.staticsGroup.children.length : -1);
// Record the term after every add to staticsGroup or to an anchor root (A8).
const _add = THREE.Object3D.prototype.add;
let addProbe = null;
THREE.Object3D.prototype.add = function (...objs) {
  const r = _add.apply(this, objs);
  if (addProbe) addProbe(this);
  return r;
};

const L = lbKey(0xa2, 0x1e);

async function runPipeline(offGraph) {
  S.__setAnchorOffGraphForTest(offGraph);
  S.__setStaticScriptRadiusForTest(null); // every landblock keeps its emitters (A5 covers the tick)
  const clock = { t: 1000 };
  setCurrentTime(() => clock.t);
  setRng(mulberry32(0xa1c0));
  const w = makeHost([L]);
  aimAt(w.cam, L);
  w.scene.updateMatrixWorld();
  const filmAttach = [];
  addProbe = (parent) => {
    if (parent === w.staticsGroup || parent.userData?.isStaticAnchorRoot === true) filmAttach.push(filmStaticsTerm(w.host));
  };
  let res;
  try { res = await S.attachStaticDefaultScripts(w.host, placements(L), wasm); } finally { addProbe = null; }
  const out = { w, res, filmAttach, film: {}, filmOld: {} };
  const film = (stage) => { out.film[stage] = filmStaticsTerm(w.host); out.filmOld[stage] = oldStaticsTerm(w.host); };
  film("attach");
  out.attach = emitterSnapshot(w.mgr);
  out.anchors = anchorsOf(w.mgr);
  anchorVisits = 0;
  w.scene.updateMatrixWorld();
  out.anchorVisits = anchorVisits;
  out.inGroup = w.staticsGroup.children.filter((c) => c.userData?.isStaticScriptAnchor).length;
  let inScene = 0;
  w.scene.traverse((o) => { if (o.userData?.isStaticScriptAnchor) inScene += 1; });
  out.inScene = inScene;
  const root0 = out.anchors[0].parent;
  out.attachParents = {
    root: !!root0 && root0.userData?.isStaticAnchorRoot === true && root0.parent === null,
    oneRoot: out.anchors.every((a) => a.parent === root0),
    rootAutoUpdate: root0 ? [root0.matrixAutoUpdate, root0.matrixWorldAutoUpdate] : null,
    rootMatrixIsGroups: !!root0 && root0.matrixWorld.equals(w.staticsGroup.matrixWorld),
    inGroup: out.anchors.every((a) => a.parent === w.staticsGroup),
  };
  out.series1 = [];
  await ticks(w, clock, 90, out.series1);
  film("ticks1");
  // park → unpark → rebuild, through the real LRU.
  const lru = new LandblockLRU({ scene3d: w.host, maxResident: 50 });
  lru.track(L);
  out.parked = lru.park(L);
  film("parked");
  out.parkedParents = out.anchors.map((a) => a.parent);
  out.tableWhileParked = w.mgr.particleTable.size;
  out.unparked = lru.unpark(L);
  film("unparked");
  await settle();
  film("rebuilt");
  out.unparkedParents = out.anchors.map((a) => a.parent);
  out.rebuild = emitterSnapshot(w.mgr);
  out.series2 = [];
  await ticks(w, clock, 90, out.series2);
  film("ticks2");
  out.rootsAfterUnpark = S.staticAnchorRootStats(w.host);
  // evict
  out.evicted = lru.evict(L);
  film("evicted");
  out.evictedParents = out.anchors.map((a) => a.parent);
  out.tableAfterEvict = w.mgr.particleTable.size;
  out.rootsAfterEvict = S.staticAnchorRootStats(w.host);
  return out;
}

const OFF = await runPipeline(false);
const ON = await runPipeline(true);
S.__setAnchorOffGraphForTest(undefined);

test("A1: after the attach every emitter frame, cull sphere and particle is bit-equal", () => {
  assert.ok(OFF.res.anchorCount === 12 && OFF.res.emitterCount === 16, `setup: ${JSON.stringify(OFF.res)}`);
  assert.deepEqual(ON.res, OFF.res, "same anchors and emitters attached");
  assert.equal(OFF.anchors.length, 12);
  assert.ok(OFF.anchors.every((a) => a.userData.__anchorFrozen === true) && ON.anchors.every((a) => a.userData.__anchorFrozen === true),
    "every anchor frozen in both arms");
  assert.ok(OFF.attach.length > 500, `setup: snapshot size ${OFF.attach.length}`);
  assert.equal(sameBits(ON.attach, OFF.attach), null, "centre / radius / anchor frame / origin / matrixWorld bits");
  assert.ok(OFF.series1.filter((x) => x !== -1).length > 1000, "setup: particles were alive");
  assert.equal(sameBits(ON.series1, OFF.series1), null, "90 ticks of every slot");
});

test("A2: flag on — the anchors are off the scene graph, parented to their landblock root", () => {
  assert.equal(OFF.inGroup, 12, "control: flag off keeps them in staticsGroup");
  assert.ok(OFF.anchorVisits >= 12, `control: the scene walk visits them (${OFF.anchorVisits})`);
  assert.equal(ON.inGroup, 0, "none in staticsGroup");
  assert.equal(ON.inScene, 0, "none anywhere under the scene");
  assert.equal(ON.anchorVisits, 0, "the scene's matrix walk never visits one");
  assert.equal(OFF.attachParents.inGroup, true, "control: parent = staticsGroup");
  assert.equal(ON.attachParents.root, true, "parent = the off-graph root (itself parentless)");
  assert.equal(ON.attachParents.oneRoot, true, "one root per landblock");
  assert.deepEqual(ON.attachParents.rootAutoUpdate, [false, false], "the root never recomposes");
  assert.equal(ON.attachParents.rootMatrixIsGroups, true, "its matrixWorld is staticsGroup's");
  assert.deepEqual(ON.rootsAfterUnpark, { enabled: true, landblocks: 1, anchors: 12 });
  assert.equal(OFF.rootsAfterUnpark.landblocks, 0, "control: no registry with the flag off");
});

test("A3: park → unpark → rebuild is bit-equal, and parents follow the park", () => {
  for (const arm of [OFF, ON]) {
    assert.equal(arm.parked, true);
    assert.ok(arm.parkedParents.every((p) => p === null), "parked anchors are detached (CallPES loops end)");
    assert.equal(arm.tableWhileParked, 0, "their emitters are torn down");
    assert.equal(arm.unparked, true);
  }
  assert.ok(OFF.unparkedParents.every((p) => p === OFF.w.staticsGroup), "flag off: back in staticsGroup");
  assert.ok(ON.unparkedParents.every((p) => p && p.userData.isStaticAnchorRoot === true), "flag on: back in the root");
  assert.ok(OFF.rebuild.length > 500, "setup: emitters rebuilt");
  assert.equal(sameBits(ON.rebuild, OFF.rebuild), null, "rebuilt emitters: every frame bit-equal");
  assert.equal(sameBits(ON.series2, OFF.series2), null, "90 more ticks of every slot");
});

test("A4: evict detaches every anchor and forgets the root", () => {
  for (const arm of [OFF, ON]) {
    assert.equal(arm.evicted, true);
    assert.ok(arm.evictedParents.every((p) => p === null), "detached");
    assert.equal(arm.tableAfterEvict, 0, "emitters reaped");
  }
  assert.deepEqual(ON.rootsAfterEvict, { enabled: true, landblocks: 0, anchors: 0 });
});

test("A5: the ?staticScriptRadius tick tears down and rebuilds the same emitters in both arms", async () => {
  const C = lbKey(0xa2, 0x2e);
  const FAR = lbKey(0xa6, 0x2e); // d4
  const run = async (offGraph) => {
    S.__setAnchorOffGraphForTest(offGraph);
    S.__setStaticScriptRadiusForTest(2);
    const clock = { t: 2000 };
    setCurrentTime(() => clock.t);
    setRng(mulberry32(0xbeef));
    const w = makeHost([C, FAR]);
    // The player is near both while they attach (every anchor chains).
    S.tickStaticScriptRadius(w.host, new Set([lbKey(0xa4, 0x2e)]));
    await S.attachStaticDefaultScripts(w.host, placements(C), wasm);
    await S.attachStaticDefaultScripts(w.host, placements(FAR), wasm);
    const counts = [w.mgr.particleTable.size];
    S.tickStaticScriptRadius(w.host, new Set([C])); // FAR is now d4 > 3: torn down
    counts.push(w.mgr.particleTable.size);
    const farAnchors = [...w.host.staticsGroup.children, ...(w.host.staticsGroup.userData.__anchorRoots?.get(FAR)?.children ?? [])]
      .filter((a) => a.userData?.isStaticScriptAnchor && ((a.userData.landblockId & 0xffff0000) >>> 0) === FAR);
    const deferred = farAnchors.map((a) => a.userData.__scriptDeferred === true);
    S.tickStaticScriptRadius(w.host, new Set([lbKey(0xa4, 0x2e)])); // d2: rebuilt
    await settle();
    counts.push(w.mgr.particleTable.size);
    return { counts, deferred, snap: emitterSnapshot(w.mgr) };
  };
  const off = await run(false);
  const on = await run(true);
  S.__setAnchorOffGraphForTest(undefined);
  S.__setStaticScriptRadiusForTest(null);
  assert.deepEqual(off.counts, [32, 16, 32], `setup: teardown + rebuild (${off.counts})`);
  assert.deepEqual(on.counts, off.counts, "same emitter counts at every step");
  assert.ok(off.deferred.length === 12 && off.deferred.every(Boolean), "the far landblock's anchors were deferred");
  assert.deepEqual(on.deferred, off.deferred);
  assert.equal(sameBits(on.snap, off.snap), null, "the rebuilt emitters are bit-equal");
});

test("A6: a park while an anchor awaits its part frames — no chain, no freeze; unpark chains it once", async () => {
  const P = lbKey(0x64, 0x5e);
  const run = async (offGraph) => {
    S.__setAnchorOffGraphForTest(offGraph);
    S.__setStaticScriptRadiusForTest(null);
    setCurrentTime(() => 3000);
    setRng(mulberry32(7));
    const w = makeHost([P]);
    let release;
    const SETUP_C = offGraph ? SETUP_C_ON : SETUP_C_OFF;
    poseGates.set(SETUP_C, new Promise((r) => { release = r; }));
    const one = [{ landblockId: (P | 1) >>> 0, x: 50, y: 60, z: 2, defaultScriptId: S_PART0, modelId: SETUP_C, scale: 1, rotationZ: 0.3 }];
    const attach = S.attachStaticDefaultScripts(w.host, one, wasm);
    await settle(); // the anchor exists and awaits its pose
    const lru = new LandblockLRU({ scene3d: w.host, maxResident: 50 });
    lru.track(P);
    lru.park(P);
    release();
    await attach;
    await settle();
    poseGates.delete(SETUP_C);
    const parkedAnchor = lru.parkPool.get(P);
    const a = (parkedAnchor.anchors ?? parkedAnchor.statics).find((c) => c.userData?.isStaticScriptAnchor);
    const before = { parent: a.parent, frozen: a.userData.__anchorFrozen === true, emitters: w.mgr.particleTable.size };
    lru.unpark(P);
    await settle();
    return { before, emittersAfter: w.mgr.particleTable.size, parentKind: a.parent?.userData?.isStaticAnchorRoot === true ? "root" : a.parent === w.staticsGroup ? "group" : String(a.parent), snap: emitterSnapshot(w.mgr) };
  };
  const off = await run(false);
  const on = await run(true);
  S.__setAnchorOffGraphForTest(undefined);
  for (const r of [off, on]) {
    assert.equal(r.before.parent, null, "detached while parked");
    assert.equal(r.before.frozen, false, "a detached anchor is not frozen");
    assert.equal(r.before.emitters, 0, "nothing chained on the parked anchor");
    assert.equal(r.emittersAfter, 1, "unpark chains it once");
  }
  assert.equal(off.parentKind, "group");
  assert.equal(on.parentKind, "root");
  assert.equal(sameBits(on.snap, off.snap), null, "the unfrozen (handed-off) anchor's emitter reads identically");
});

test("A8: film's scene signatures count the off-graph anchors — flag on totals == flag off at every step", () => {
  assert.ok(filmTerms.every((t) => typeof t === "string"), "both film readers carry the statics term (world.js signature, take_player.js sceneSignature)");
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  assert.equal(norm(filmTerms[1]), norm(filmTerms[0]), "the two readers count the same way");
  assert.ok(/__anchorRoots/.test(filmTerms[0]), "the term adds the anchor roots' children");
  const stages = ["attach", "ticks1", "parked", "unparked", "rebuilt", "ticks2", "evicted"];
  assert.deepEqual(Object.keys(OFF.film), stages);
  assert.deepEqual(ON.film, OFF.film, `flag on == flag off at every step (${JSON.stringify(ON.film)} vs ${JSON.stringify(OFF.film)})`);
  assert.deepEqual(OFF.filmOld, OFF.film, "flag off: the term is staticsGroup.children.length, as before");
  assert.equal(ON.filmOld.attach, OFF.film.attach - 12, "setup: without the roots, flag on would miss the 12 anchors");
  assert.ok(OFF.film.attach >= 12 && OFF.film.parked < OFF.film.attach, `setup: the anchors (and their particles) leave at the park (${JSON.stringify(OFF.film)})`);
  assert.ok(OFF.filmAttach.length >= 12, `setup: every anchor add was sampled (${OFF.filmAttach.length})`);
  assert.deepEqual(ON.filmAttach, OFF.filmAttach, "after every add of the time-sliced attach");
});

test("A7: the flag reader", () => {
  const saved = globalThis.location;
  try {
    const read = (search) => { globalThis.location = { search }; S.__setAnchorOffGraphForTest(undefined); return S.anchorOffGraphEnabled(); };
    assert.equal(read(""), true, "default ON since 2026-10-26");
    for (const v of ["on", "1", "true", "YES", "maybe"]) assert.equal(read(`?anchorOffGraph=${v}`), true, v);
    for (const v of ["off", "0", "false", "NO"]) assert.equal(read(`?anchorOffGraph=${v}`), false, v);
  } finally {
    globalThis.location = saved;
    S.__setAnchorOffGraphForTest(undefined);
  }
});
