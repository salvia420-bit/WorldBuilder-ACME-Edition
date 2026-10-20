// tests/frozen_part_fast.test.mjs — ?frozenPartFast + ?rp6Stagger (2026-10-20,
// improvement hunt entities-fx-1 / entities-fx-2).
//
// rp6TrueSphere's part-frame branch runs before bf474c67's frozen-anchor read in
// rp6CullSphere, and every Setup static anchor carries part frames, so the
// frozen shortcut never fired for part-anchored statics (all of Linvak's drizzle
// rides part 0; bf474c67's own test, static_anchor_radius F7, only covered
// partIndex -1). Each read went through the partFrames proxy — three
// updateWorldMatrix walks up to the Scene — and a parent-local emitter re-read
// it once per LIVE particle per tick. Every shortcut here must be BIT-identical:
//   P1  proxy on a FROZEN static anchor (real attachStaticPartFrames + the real
//       freeze, under staticsGroup / worldRoot / Scene): partIndex 0 AND 1 frames
//       are bit-identical to the three-walk path; zero updateWorldMatrix calls
//   P2  proxy on an animated entity rig: bit-identical over 60 animated frames;
//       one top-level walk per read where the old path made three
//   P3  rp6CullSphere on frozen anchors (partIndex 0, 1, -1): centre + radius
//       bit-identical to the flag-off path; cached (no partFrames read) after
//       the first call; a `__scriptEpoch` bump recomputes; an unfrozen anchor is
//       never cached
//   P4  parent-local part-anchored emitters (per-second AND per-metre) on an
//       animated rig: 200 ticks of every slot's position / quaternion / scale /
//       opacity are bit-identical; the anchor resolves once per tick (old path:
//       once per live slot plus the emit's two or three)
//   P5  a drizzle-like emitter on a frozen static anchor's part 0: identical
//       particles, zero part walks, one anchor resolve per emitting tick
//   P6  ?rp6Stagger: one manager's re-checks spread over the interval (off: all
//       on one tick); every emitter still re-checks once per interval; a cull
//       flip still lands within the interval
//   P7  the flag parsers
//
// Run from apps/holtburger-web/:  node tests/frozen_part_fast.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 0;
globalThis.window.cancelAnimationFrame ??= () => {};

const S = await import("../scene3d/statics.js");
const { attachStaticPartFrames, __setStaticPartAnchorForTest, __freezeStaticScriptAnchorForTest } = S;
const RIG = await import("../scene3d/setup_rig.js");
const { createPartFramesProxy, frozenPartFastEnabled, setFrozenPartFastFlag } = RIG;
const PM = await import("../scene3d/particles/particle_manager.js");
const { rp6CullSphere, setRp6TrueSphereFlag, rp6StaggerEnabled, setRp6StaggerFlag } = PM;
const PE = await import("../scene3d/particles/particle_emitter.js");
const { ParticleEmitter, particleFrozenPartFastEnabled, setParticleFrozenPartFastFlag } = PE;
const { ParticleEmitterInfo, EmitterType } = await import("../scene3d/particles/particle_emitter_info.js");
const { ParticleType } = await import("../scene3d/particles/particle.js");
const { setCurrentTime, setRng } = await import("../scene3d/particles/time_rng.js");

function setFast(on) {
  setFrozenPartFastFlag(on);
  setParticleFrozenPartFastFlag(on);
}

// Bit-level equality of two number lists; reports the first differing index.
function sameBits(a, b) {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return `index ${i}: ${a[i]} vs ${b[i]}`;
  }
  return null;
}
const frameNums = (f) => [f.position.x, f.position.y, f.position.z,
  f.quaternion.x, f.quaternion.y, f.quaternion.z, f.quaternion.w];

// Count EVERY Object3D.updateWorldMatrix call (the chain recursion included).
const _uwm = THREE.Object3D.prototype.updateWorldMatrix;
let walkCount = 0;
THREE.Object3D.prototype.updateWorldMatrix = function (...args) {
  walkCount += 1;
  return _uwm.apply(this, args);
};
function countWalks(fn) {
  const before = walkCount;
  const r = fn();
  return { walks: walkCount - before, r };
}

// The client graph: Scene → worldRoot (−π/2 about X, acToThree) → group.
function makeWorld() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const group = new THREE.Group();
  worldRoot.add(group);
  return { scene, worldRoot, group };
}

// A two-part Setup pose (x,y,z, qw,qx,qy,qz per part): part 0 is the drizzle
// shape (17 m up, identity), part 1 is off-axis and rotated.
const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.31, -0.72, 1.13)).normalize();
const POSE = Float32Array.from([0, 0, 17, 1, 0, 0, 0, 0.35, -1.2, 2.5, q1.w, q1.x, q1.y, q1.z]);
const SETUP = 0x02000407;
const wasm = { async fetchSetupPartPose(sid) { return (sid >>> 0) === SETUP ? POSE : new Float32Array(0); } };

// A frozen static script anchor exactly as statics.js builds one: part nodes
// from the Setup pose, then the freeze. `freeze: false` leaves it live.
async function makeStaticAnchor({ freeze = true } = {}) {
  const w = makeWorld();
  const anchor = new THREE.Group();
  anchor.position.set(1234.5, 678.25, 42.125);
  anchor.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  anchor.scale.setScalar(1.3);
  anchor.userData = { isStaticScriptAnchor: true, defaultScriptId: 0x33000113, landblockId: 0xa21e0000 };
  w.group.add(anchor);
  __setStaticPartAnchorForTest(true);
  const n = await attachStaticPartFrames(anchor, SETUP, wasm);
  assert.equal(n, 2, "setup: two part nodes");
  if (freeze) __freezeStaticScriptAnchorForTest(anchor);
  return { ...w, anchor };
}

test("P1: frozen static anchor parts read bit-identically with no walk", async () => {
  const A = await makeStaticAnchor(); // read through the old three-walk path
  const B = await makeStaticAnchor(); // read through the frozen fast path
  for (const pi of [0, 1]) {
    setFast(false);
    const old = countWalks(() => frameNums(A.anchor.partFrames[pi]));
    setFast(true);
    const neu = countWalks(() => frameNums(B.anchor.partFrames[pi]));
    assert.equal(sameBits(neu.r, old.r), null, `partIndex ${pi} frame bits`);
    assert.equal(neu.walks, 0, `partIndex ${pi}: no updateWorldMatrix on a frozen part`);
    // part → anchor → group → worldRoot → Scene, walked three times
    assert.equal(old.walks, 15, `partIndex ${pi}: the old path walked the chain three times`);
  }
  // The frozen read is the part's world frame (17 m up the anchor's own axis,
  // ×1.3 scale, through worldRoot): the claim is "same bits", not "a value".
  setFast(true);
  const want = new THREE.Vector3(0, 0, 17).applyMatrix4(B.anchor.matrixWorld);
  assert.ok(B.anchor.partFrames[0].position.distanceTo(want) < 1e-6);
  setFast(null);
});

test("P2: animated rig — one walk per read, bit-identical over 60 frames", () => {
  const build = () => {
    const w = makeWorld();
    const root = new THREE.Group();
    root.position.set(52.5, -17.25, 3.5);
    w.group.add(root);
    const parts = [];
    for (let i = 0; i < 8; i += 1) {
      const p = new THREE.Group();
      p.position.set(0.1 * i, -0.05 * i, 0.2 * i);
      root.add(p);
      parts.push(p);
    }
    root.partFrames = createPartFramesProxy(THREE, parts);
    return { ...w, root, parts };
  };
  const A = build();
  const B = build();
  const animate = (R, f) => {
    R.root.position.x += 0.0371;
    R.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), f * 0.013);
    for (let i = 0; i < R.parts.length; i += 1) {
      R.parts[i].quaternion.setFromEuler(new THREE.Euler(f * 0.07 * (i + 1), f * 0.031, -f * 0.019 * i));
      R.parts[i].position.z = 0.2 * i + Math.sin(f * 0.1 + i) * 0.3;
    }
  };
  let partWalksOld = 0, partWalksNew = 0;
  const spy = (R, bump) => {
    for (const p of R.parts) {
      p.updateWorldMatrix = function (...a) { bump(); return _uwm.apply(this, a); };
    }
  };
  spy(A, () => { partWalksOld += 1; });
  spy(B, () => { partWalksNew += 1; });
  for (let f = 0; f < 60; f += 1) {
    animate(A, f);
    animate(B, f);
    for (let i = 0; i < 8; i += 1) {
      setFast(false);
      const a = frameNums(A.root.partFrames[i]);
      setFast(true);
      const b = frameNums(B.root.partFrames[i]);
      assert.equal(sameBits(b, a), null, `frame ${f} part ${i}`);
    }
  }
  assert.equal(partWalksNew, 60 * 8, "one top-level walk per read");
  assert.equal(partWalksOld, 3 * 60 * 8, "the old path walked three times per read");
  // A part with only ONE of the auto-update flags cleared still walks (only
  // both-off is frozen).
  B.parts[3].matrixWorldAutoUpdate = false;
  const before = partWalksNew;
  setFast(true);
  void B.root.partFrames[3];
  assert.equal(partWalksNew - before, 1);
  setFast(null);
});

test("P3: rp6CullSphere — frozen centres bit-identical, cached, epoch-invalidated", async () => {
  setRp6TrueSphereFlag(true);
  const emitterOn = (anchor, pi) => ({
    parent: anchor,
    partIndex: pi,
    info: { sortingSphere: { radius: 3.25 }, cullReach: 31.5, cullOffsetGain: 1, scaleRand: 0.1, startScale: 1.4, finalScale: 2 },
    parentOffset: { position: new THREE.Vector3(0, 0.5, 17) },
    _gfxRadius: 0.75,
    _gfxOriginRadius: 1.1,
  });
  for (const pi of [0, 1, -1]) {
    const A = await makeStaticAnchor();
    const B = await makeStaticAnchor();
    const eA = emitterOn(A.anchor, pi);
    const eB = emitterOn(B.anchor, pi);
    const outA = new THREE.Vector3();
    const outB = new THREE.Vector3();
    setFast(false);
    const old = countWalks(() => rp6CullSphere(eA, outA));
    assert.equal(eA._rp6FrozenCentre, undefined, "flag off: no cache");
    setFast(true);
    const neu = countWalks(() => rp6CullSphere(eB, outB));
    assert.equal(sameBits([neu.r, outB.x, outB.y, outB.z], [old.r, outA.x, outA.y, outA.z]), null,
      `partIndex ${pi}: radius + centre bits`);
    assert.equal(neu.walks, 0, `partIndex ${pi}: no walk filling the cache`);
    if (pi !== -1) assert.equal(old.walks, 15, `partIndex ${pi}: the old path walked the proxy's three chains`);
    assert.ok(eB._rp6FrozenCentre, "cached");
    // Second call: no partFrames read at all.
    const realPF = B.anchor.partFrames;
    let reads = 0;
    B.anchor.partFrames = new Proxy(realPF, { get(t, p) { if (p !== "length") reads += 1; return t[p]; } });
    const out2 = new THREE.Vector3(9, 9, 9);
    const r2 = rp6CullSphere(eB, out2);
    assert.equal(reads, 0, "cache hit reads no part frame");
    assert.equal(sameBits([r2, out2.x, out2.y, out2.z], [old.r, outA.x, outA.y, outA.z]), null, "cache hit bits");
    // A park / teardown / rebuild claim bumps the epoch → recomputed once.
    B.anchor.userData.__scriptEpoch = (B.anchor.userData.__scriptEpoch | 0) + 1;
    const out3 = new THREE.Vector3();
    rp6CullSphere(eB, out3);
    assert.equal(reads, pi === -1 ? 0 : 1, "epoch bump re-reads the part frame");
    assert.equal(sameBits([out3.x, out3.y, out3.z], [outA.x, outA.y, outA.z]), null, "recomputed bits");
    rp6CullSphere(eB, out3);
    assert.equal(reads, pi === -1 ? 0 : 1, "and is cached again");
  }
  // An unfrozen anchor is never cached (it can move).
  const L = await makeStaticAnchor({ freeze: false });
  const eL = emitterOn(L.anchor, 0);
  setFast(true);
  rp6CullSphere(eL, new THREE.Vector3());
  assert.equal(eL._rp6FrozenCentre, undefined);
  setFast(null);
  setRp6TrueSphereFlag(null);
});

// ── P4 / P5 — the emitter runtime ─────────────────────────────────────────
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
const flush = () => new Promise((r) => setImmediate(r));
function infoPojo(over) {
  return Object.assign({
    id: 0x32000999, emitterType: EmitterType.BirthratePerSec, particleType: ParticleType.ParabolicLVGAGR,
    gfxObjId: 0, hwGfxObjId: 0x010010f9, birthrate: 0.05, maxParticles: 24, initialParticles: 4,
    totalParticles: 0, totalSeconds: 0, lifespan: 1.0, lifespanRand: 0.25,
    offsetDirX: 0.3, offsetDirY: 0.1, offsetDirZ: 1, minOffset: 0.05, maxOffset: 0.4,
    aX: 0.2, aY: -0.4, aZ: 1.5, minA: 0.5, maxA: 1.5, bX: 0, bY: 0, bZ: -2.5, minB: 1, maxB: 1,
    cX: 0.5, cY: 1.2, cZ: 0.3, minC: 0.5, maxC: 2,
    scaleRand: 0.2, startScale: 0.6, finalScale: 1.4, transRand: 0.1, startTrans: 0.1, finalTrans: 0.9,
    isParentLocal: true,
  }, over);
}
const geom = new THREE.BufferGeometry();
const meshFactory = () => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 }));
function slotNums(em, out) {
  for (let i = 0; i < em.partStorage.length; i += 1) {
    const m = em.parts[i];
    if (!m) { out.push(-1); continue; }
    out.push(i, m.position.x, m.position.y, m.position.z, m.quaternion.x, m.quaternion.y, m.quaternion.z,
      m.quaternion.w, m.scale.x, m.scale.y, m.scale.z, m.material.opacity, m.visible ? 1 : 0);
  }
}
function spyResolves(em) {
  const orig = em._resolveAnchorFrame;
  em._resolves = 0;
  em._resolveAnchorFrame = function () { em._resolves += 1; return orig.call(this); };
}

async function runRig(fast) {
  setFast(fast);
  let t = 500;
  setCurrentTime(() => t);
  setRng(mulberry32(0xc0ffee));
  const w = makeWorld(); // w.group is the entities group = the emitters' scene
  const root = new THREE.Group();
  root.position.set(88.5, 41.25, 12);
  w.group.add(root);
  const parts = [];
  for (let i = 0; i < 8; i += 1) {
    const p = new THREE.Group();
    p.position.set(0.1 * i, 0.05 * i, 0.25 * i);
    root.add(p);
    parts.push(p);
  }
  root.partFrames = createPartFramesProxy(THREE, parts);
  let part5Walks = 0;
  parts[5].updateWorldMatrix = function (...a) { part5Walks += 1; return _uwm.apply(this, a); };
  const make = async (over, partIndex) => {
    const em = new ParticleEmitter({ parent: root, scene: w.group, meshFactory });
    assert.equal(await em.setInfo(new ParticleEmitterInfo(infoPojo(over))), true);
    em.setParenting(partIndex, { position: new THREE.Vector3(0.1, -0.2, 0.3), quaternion: new THREE.Quaternion() });
    em.initEnd();
    spyResolves(em);
    return em;
  };
  const perSec = await make({}, 5);
  // A per-metre hand trail (0x32000109-like): shouldEmitParticle measures the
  // part's travel, so the emit path resolves THREE times on an emitting tick.
  const perMetre = await make({ emitterType: EmitterType.BirthratePerMeter, birthrate: 0.02, particleType: ParticleType.Swarm,
    initialParticles: 0, maxParticles: 32, lifespan: 0.6 }, 5);
  const series = [];
  const resolvesPerTick = [];
  let maxLive = 0;
  part5Walks = 0; // setParenting + initEnd's burst resolve outside a tick
  for (let f = 0; f < 200; f += 1) {
    root.position.x += 0.021;
    root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), f * 0.011);
    parts[5].quaternion.setFromEuler(new THREE.Euler(f * 0.09, f * 0.04, -f * 0.02));
    parts[5].position.set(0.5 + Math.sin(f * 0.15) * 0.4, Math.cos(f * 0.15) * 0.4, 1.25);
    t += 1 / 60;
    const r0 = [perSec._resolves, perMetre._resolves];
    perSec.updateParticles();
    perMetre.updateParticles();
    resolvesPerTick.push([perSec._resolves - r0[0], perMetre._resolves - r0[1]]);
    maxLive = Math.max(maxLive, perSec.numParticles);
    await flush(); // lazy slot growth lands identically in both runs
    slotNums(perSec, series);
    slotNums(perMetre, series);
  }
  return { series, resolvesPerTick, part5Walks, maxLive, perSec, perMetre };
}

test("P4: parent-local emitters — 200 ticks bit-identical, one anchor resolve per tick", async () => {
  const old = await runRig(false);
  const neu = await runRig(true);
  assert.ok(old.maxLive >= 12, `setup: a real live population (${old.maxLive})`);
  assert.ok(old.perMetre.totalEmitted > 20, `setup: the per-metre trail emitted (${old.perMetre.totalEmitted})`);
  assert.equal(sameBits(neu.series, old.series), null, "every slot, every tick");
  for (const [a, b] of neu.resolvesPerTick) {
    assert.ok(a <= 1 && b <= 1, `hoisted: at most one resolve per tick (${a}, ${b})`);
  }
  const sum = (rows) => rows.reduce((s, [a, b]) => s + a + b, 0);
  assert.ok(sum(old.resolvesPerTick) > 8 * sum(neu.resolvesPerTick),
    `old ${sum(old.resolvesPerTick)} resolves vs hoisted ${sum(neu.resolvesPerTick)}`);
  // part-5 walks in the ticks: hoisted = one per resolve (the single-walk
  // proxy); old = three per resolve.
  assert.equal(neu.part5Walks, sum(neu.resolvesPerTick), "one walk per resolve");
  assert.equal(old.part5Walks, 3 * sum(old.resolvesPerTick), "old: three walks per resolve");
  // The memo never outlives a tick: outside updateParticles reads resolve fresh.
  assert.equal(neu.perSec._tickAnchor, undefined);
  setFast(null);
});

async function runDrizzle(fast) {
  setFast(fast);
  let t = 900;
  setCurrentTime(() => t);
  setRng(mulberry32(0x5eed));
  const A = await makeStaticAnchor();
  let partWalks = 0;
  // The real proxy's node for part 0 (the anchor's first child).
  const node0 = A.anchor.children[0];
  node0.updateWorldMatrix = function (...a) { partWalks += 1; return _uwm.apply(this, a); };
  const em = new ParticleEmitter({ parent: A.anchor, scene: A.group, meshFactory });
  // 0x32000142-like: world-space (not parent-local), per-second, part 0.
  assert.equal(await em.setInfo(new ParticleEmitterInfo(infoPojo({ isParentLocal: false, particleType: ParticleType.LocalVelocity,
    birthrate: 0.1, maxParticles: 8, initialParticles: 2, lifespan: 0.7 }))), true);
  em.setParenting(0, { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() });
  em.initEnd();
  spyResolves(em);
  const series = [];
  const perTick = [];
  for (let f = 0; f < 120; f += 1) {
    t += 1 / 60;
    const r0 = em._resolves;
    em.updateParticles();
    perTick.push(em._resolves - r0);
    await flush();
    slotNums(em, series);
  }
  return { series, perTick, partWalks, em };
}

test("P5: drizzle-like emitter on a frozen anchor's part 0 — identical, no part walk", async () => {
  const old = await runDrizzle(false);
  const neu = await runDrizzle(true);
  assert.ok(old.em.totalEmitted > 10, "setup: it emitted");
  assert.equal(sameBits(neu.series, old.series), null, "every slot, every tick");
  assert.equal(neu.partWalks, 0, "frozen part: no updateWorldMatrix");
  assert.ok(old.partWalks > 0, "old path walked");
  for (const n of neu.perTick) assert.ok(n <= 1, "one resolve per emitting tick (init + record share it)");
  assert.ok(old.perTick.some((n) => n === 2), "old path resolved twice per spawn");
  setFast(null);
});

// ── P6 — ?rp6Stagger ──────────────────────────────────────────────────────
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
function look(z) {
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, z);
  cam.updateMatrixWorld(true);
}
function quad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.1, 0, -0.1, 0.1, 0, -0.1, 0.1, 0, 0.1]), 3));
  return g;
}
async function staggerManager(n) {
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  PM.setParticleTickOnceFlag(null);
  const g = quad();
  const mgr = new PM.ParticleManager({
    scene: new THREE.Group(),
    geometryFactory: () => g,
    materialFactory: () => new THREE.MeshBasicMaterial({ transparent: true }),
  });
  const counter = { n: 0 };
  for (let i = 0; i < n; i += 1) {
    await mgr.addEmitter({
      emitterInfo: { ...infoPojo({ isParentLocal: true, particleType: ParticleType.Still, maxParticles: 2, initialParticles: 1,
        birthrate: 0.1, lifespan: 1000, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0, minOffset: 0, maxOffset: 0,
        aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0, bZ: 0, cX: 0, cY: 0, cZ: 0 }) },
      // rp6CullSphere is the manager's only caller of parent.getWorldPosition
      // (no part frames, not frozen), so this counts re-checks exactly.
      parent: {
        position: new THREE.Vector3(i - n / 2, 0, -50),
        quaternion: new THREE.Quaternion(),
        getWorldPosition(out) { counter.n += 1; return out.copy(this.position); },
      },
      partIndex: -1,
    });
  }
  return { mgr, counter };
}

for (const stagger of [true, false]) {
  test(`P6: rp6Stagger=${stagger ? "on" : "off"} — re-check spread and latency`, async () => {
    setRp6StaggerFlag(stagger);
    let t = 2000;
    setCurrentTime(() => t);
    const N = 12;
    const { mgr, counter } = await staggerManager(N);
    look(-1);
    for (let i = 0; i < 12; i += 1) { t += 1 / 60; mgr.tick(); }
    // Per-tick re-check counts over two whole intervals.
    const perTick = [];
    for (let i = 0; i < 12; i += 1) {
      const c0 = counter.n;
      t += 1 / 60;
      mgr.tick();
      perTick.push(counter.n - c0);
    }
    const total = perTick.reduce((s, x) => s + x, 0);
    assert.equal(total, 2 * N, `each emitter re-checks once per interval (${perTick})`);
    if (stagger) {
      assert.ok(Math.max(...perTick) <= Math.ceil(N / 6), `spread: no tick carries more than N/interval (${perTick})`);
    } else {
      assert.equal(Math.max(...perTick), N, `legacy: all on one tick (${perTick})`);
    }
    // Cull flip latency: turn away, every emitter culls within one interval;
    // turn back, every one un-culls within one interval.
    look(1);
    const ems = [...mgr.particleTable.values()];
    const flipAt = new Map();
    for (let i = 1; i <= 6; i += 1) {
      t += 1 / 60; mgr.tick();
      for (const e of ems) if (e._rp6Culled === true && !flipAt.has(e)) flipAt.set(e, i);
    }
    assert.equal(flipAt.size, N, "every emitter culled within the interval");
    if (stagger) assert.ok(new Set(flipAt.values()).size > 1, "the flips land on different ticks");
    else assert.equal(new Set(flipAt.values()).size, 1, "legacy: all on one tick");
    look(-1);
    let back = 0;
    for (let i = 1; i <= 6; i += 1) {
      t += 1 / 60; mgr.tick();
      back = ems.filter((e) => e._rp6Culled !== true).length;
    }
    assert.equal(back, N, "every emitter back within the interval");
    setRp6StaggerFlag(null);
  });
}

test("P7: flag parsers — default on; off/0/false/no escape", () => {
  const saved = globalThis.location;
  try {
    for (const [search, want] of [["", true], ["?frozenPartFast=off", false], ["?frozenPartFast=0", false],
      ["?frozenPartFast=FALSE", false], ["?frozenPartFast=no", false], ["?frozenPartFast=on", true], ["?frozenPartFast=x", true]]) {
      globalThis.location = { search };
      setFast(null);
      assert.equal(frozenPartFastEnabled(), want, `setup_rig ${search}`);
      assert.equal(particleFrozenPartFastEnabled(), want, `particle_emitter ${search}`);
    }
    for (const [search, want] of [["", true], ["?rp6Stagger=off", false], ["?rp6Stagger=0", false], ["?rp6Stagger=on", true]]) {
      globalThis.location = { search };
      setRp6StaggerFlag(null);
      assert.equal(rp6StaggerEnabled(), want, `rp6Stagger ${search}`);
    }
  } finally {
    globalThis.location = saved;
    setFast(null);
    setRp6StaggerFlag(null);
  }
});
