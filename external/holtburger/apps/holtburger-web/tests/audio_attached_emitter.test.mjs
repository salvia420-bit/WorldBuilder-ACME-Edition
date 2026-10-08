// audio_attached_emitter.test.mjs — audio-2 (2026-10-08 round 2): a sound on
// a WIELDED item plays at the item's world position (the wielder's hand).
//
// Retail: CPhysicsObj::set_parent → UpdateChild (acclient.c:323003-323027,
// 320039-320056) makes a child's m_position a WORLD frame
// (Frame::combine(holding part frame, child frame)), and every sound hook /
// server sound plays at `&physobj->m_position` (342188-342221, 383481,
// 383697). holtburger re-parents a wielded rig's root under the wielder's
// part node, so `root.position` is HAND-LOCAL; the old sites read it as a
// world position, put the emitter near the map origin, and GetAttenuation
// (383079-383118) culled it.
//
// Fails on the old code: every play() below received acToThree(0.05, 0, 0.1)
// (tens of km from the listener — getAttenuation play:false), and the
// follow-mode panner refresh in scene3d/index.js did the same.
//
// Drives the shipped pure helper (scene3d/audio/emitter_position.js) and the
// REAL EntityManager: attachChildToParent mounts the child, then `_fireHook`
// Sound(1) / SoundTable(2) / SoundTweaked(21) and `_firePlayEffectSoundHook`
// play into a recording AudioManager.
//
// Run: node tests/audio_attached_emitter.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { emitterPosThree, readAttachedSoundPosFlag, threeToAc } = await import("../scene3d/audio/emitter_position.js");
const { acToThree } = await import("../scene3d/adapter.js");
const { getAttenuation } = await import("../scene3d/audio/retail_mixer.js");

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const near = (a, b, eps, msg) => {
  for (const k of ["x", "y", "z"]) assert.ok(Math.abs(a[k] - b[k]) < eps, `${msg ?? ""} ${k}: ${a[k]} vs ${b[k]}`);
};
const v3 = (arr) => ({ x: arr[0], y: arr[1], z: arr[2] });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// index.js init3D's graph: scene → worldRoot (rotation.x = −π/2) → entities.
const scene = new THREE.Scene();
const worldRoot = new THREE.Group();
worldRoot.rotation.x = -Math.PI / 2;
scene.add(worldRoot);
const entitiesGroup = new THREE.Group();
worldRoot.add(entitiesGroup);

const P = 0x50000001; // wielder
const C = 0x80000030; // wielded item
const wasm = {
  async fetchSetupHoldingLocations() {
    // RightHand(1) on part 1, 5 cm out and 10 cm up from the part origin.
    return { takeLocations: () => [{ locationKey: 1, partId: 1, ox: 0.05, oy: 0, oz: 0.1, qw: 1, qx: 0, qy: 0, qz: 0 }] };
  },
};
const plays = [];
const audioManager = { play: async (wave, pos, opts) => { plays.push({ wave, pos, opts }); return {}; } };
const em = new EntityManager({ entitiesGroup, materialCache: null, audioManager }, wasm);

function rig(guid, n) {
  const root = new THREE.Group();
  const parts = Array.from({ length: n }, () => { const g = new THREE.Group(); root.add(g); return g; });
  entitiesGroup.add(root);
  const inst = { guid, root, parts, meta: { setupId: 0x02000001 }, soundTableDid: 0x20000014 };
  em.entityMap.set(guid, inst);
  return inst;
}
// The wielder stands at AC (32450, 28010, 60); its hand part sits 1.2 m up.
const wielder = rig(P, 3);
wielder.root.position.set(32450, 28010, 60);
wielder.parts[1].position.set(0, 0, 1.2);
const child = rig(C, 1);
await em.attachChildToParent(C, P, 1, 1);

const HAND_AC = { x: 32450.05, y: 28010, z: 61.3 };
const HAND_THREE = v3(acToThree(HAND_AC.x, HAND_AC.y, HAND_AC.z));
// The listener (camera) a metre behind the wielder's head.
const LISTENER = v3(acToThree(32450, 28009, 61.5));

await check("setup: the child is mounted under the wielder's hand part (hand-local root)", () => {
  assert.equal(child._attachedParentGuid, P);
  assert.equal(child.root.parent, wielder.parts[1]);
  assert.deepEqual([child.root.position.x, child.root.position.y, child.root.position.z], [0.05, 0, 0.1]);
});

// ── the pure helper ──
await check("attached rig: emitter = the hand's world position in the three.js frame", () => {
  near(emitterPosThree(child, em.entityMap), HAND_THREE, 1e-6);
});
await check("top-level rig: emitter = acToThree(root.position) exactly (unchanged)", () => {
  assert.deepEqual(emitterPosThree(wielder, em.entityMap), v3(acToThree(32450, 28010, 60)));
  const plain = { root: { position: { x: 1, y: 2, z: 3 } } }; // no scene graph at all
  assert.deepEqual(emitterPosThree(plain, null), { x: 1, y: 3, z: -2 });
});
await check("the mount brand alone (no _attachedParentGuid) is enough — the walker passes a bare rig", () => {
  assert.equal(child.root.userData.__attachedChildOf, P);
  near(emitterPosThree({ root: child.root }, em.entityMap), HAND_THREE, 1e-6);
});
await check("retail attenuation: the hand emitter plays; the old raw-local read was culled", () => {
  const fixed = emitterPosThree(child, em.entityMap);
  assert.equal(getAttenuation(dist(fixed, LISTENER), 1, 1).play, true);
  const raw = emitterPosThree(child, em.entityMap, false); // `?attachedSoundPos=off`
  near(raw, v3(acToThree(0.05, 0, 0.1)), 1e-9, "escape = old hand-local read");
  assert.equal(getAttenuation(dist(raw, LISTENER), 1, 1).play, false);
});
await check("root out of the scene (mid re-park): the wielder's position stands in; no wielder → null", () => {
  const loose = { root: new THREE.Group(), _attachedParentGuid: P };
  loose.root.position.set(0.05, 0, 0.1);
  assert.deepEqual(emitterPosThree(loose, em.entityMap), v3(acToThree(32450, 28010, 60)));
  assert.equal(emitterPosThree({ ...loose, _attachedParentGuid: 0x5000dead }, em.entityMap), null);
  assert.equal(emitterPosThree(null, em.entityMap), null);
});
await check("threeToAc gives the event log the AC-frame hand position", () => {
  near(threeToAc(emitterPosThree(child, em.entityMap)), HAND_AC, 1e-6);
});
await check("?attachedSoundPos: default on; off / 0 / false escape", () => {
  assert.equal(readAttachedSoundPosFlag(""), true);
  assert.equal(readAttachedSoundPosFlag("?attachedSoundPos=on"), true);
  for (const v of ["off", "0", "false", "OFF"]) assert.equal(readAttachedSoundPosFlag(`?attachedSoundPos=${v}`), false, v);
});

// ── the shipped sound sites on the real EntityManager ──
await check("_fireHook Sound(1) on the wielded item plays at the hand", async () => {
  plays.length = 0;
  em._fireHook(child, { hookType: 1, soundWaveId: 0x0a000101, direction: 0 }, audioManager, null);
  await tick();
  assert.equal(plays.length, 1);
  near(plays[0].pos, HAND_THREE, 1e-6);
  assert.equal(plays[0].opts.sliderTwice, true);
});
await check("_fireHook SoundTweaked(21) plays at the hand and follows the item", async () => {
  plays.length = 0;
  em._fireHook(child, { hookType: 21, soundWaveId: 0x0a000102, soundProbability: 1, soundVolume: 0.5, direction: 0 }, audioManager, null);
  await tick();
  assert.equal(plays.length, 1);
  near(plays[0].pos, HAND_THREE, 1e-6);
  assert.equal(plays[0].opts.followGuid, C);
});
await check("_fireHook SoundTable(2) resolves, then plays at the hand", async () => {
  plays.length = 0;
  const cache = { resolveSound: async () => ({ waveDid: 0x0a000103, probability: 1, volume: 1 }) };
  em._fireHook(child, { hookType: 2, soundEnum: 0x8c, direction: 0 }, audioManager, cache);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(plays.length, 1);
  assert.equal(plays[0].wave, 0x0a000103);
  near(plays[0].pos, HAND_THREE, 1e-6);
});
await check("_firePlayEffectSoundHook (wire item-enchant TargetEffect) plays at the hand", async () => {
  plays.length = 0;
  em._firePlayEffectSoundHook(C, { hookType: 1, startTime: 0, soundWaveId: 0x0a000104, soundProbability: 1 });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(plays.length, 1);
  near(plays[0].pos, HAND_THREE, 1e-6);
  assert.equal(plays[0].opts.followGuid, C);
});
await check("a top-level emitter still plays at acToThree(root.position)", async () => {
  plays.length = 0;
  em._fireHook(wielder, { hookType: 1, soundWaveId: 0x0a000105, direction: 0 }, audioManager, null);
  await tick();
  assert.deepEqual(plays[0].pos, v3(acToThree(32450, 28010, 60)));
});
await check("index.js follow-mode panner refresh resolves the same emitter", () => {
  const src = readFileSync(new URL("../scene3d/index.js", import.meta.url), "utf8");
  const at = src.indexOf("audioManager.updateFollowingPositions((guid) => {");
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 2000), /return emitterPosThree\(emap\.get\(guid >>> 0\), emap\);/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
