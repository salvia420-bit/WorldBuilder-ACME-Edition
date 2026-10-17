// tests/missile_substate_motion.test.mjs — missile-anim (2026-10-17,
// `?missileSubstate`, default ON).
//
// The REAL EntityManager against a wasm mock shaped like player MotionTable
// 0x09000001 (DAT dump 2026-10-17, docs/missile-anim-comparison-2026-10-17):
//   BowCombat     Ready→AimHigh30 raise · AimHigh30 hold · AimHigh30→Ready
//                 snap · Ready→Reload reach · Reload hold · Reload→Ready nock.
//                 NO Aim*→Reload link (retail two-hops through Ready).
//   ThrownWeapon  Ready→AimLevel wind-up · AimLevel→Reload THE THROW (direct)
//                 · Ready→Reload un-draw (must NOT play) · Reload→Ready draw.
//   "lugian"      a creature-style table with an aim but no Reload at all:
//                 retail refuses the Reload and the closing Ready's
//                 AimLevel→Ready link is the throw.
// ACE's shot is aim → Reload (at GetAnimSpeed) → Ready, all in the forward
// slot (Player_Missile.cs LaunchMissile); retail GetObjectSequence's substate
// branch is acclient.c:337763-337840.
//
//   M1  bow shot: raise, hold, snap + reach (two-hop, hop speeds), hold, nock
//   M2  ...the same with the bridge's synthesized Ready in front of the Reload
//   M3  thrown: wind-up, hold, THROW (direct Aim→Reload), hold, draw — no un-draw
//   M3b ...also when a cold aim bake never committed before the Reload
//   M4  local rig: the skipped closing Ready (forced) plays the nock; an
//       autonomous echo does not end the hold
//   M5  local rig out of ammo (NonCombat style change) leaves the aim
//   M6  a table without Reload keeps the aim; the closing Ready plays the throw
//   M7  `?missileSubstate=off` restores the old action overlay (no nock)
//   M8  combat-entry reload (from Ready): reach, hold, nock
//   M9  a cold Reload bake: the closing Ready waits for it
//   M10 the flag reader
//
// Run: node tests/missile_substate_motion.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager, missileSubstateEnabled } from "../scene3d/entities.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

const PART_COUNT = 3;
const NUM_FRAMES = 8;
const LINK_FRAMES = 4;
const FRAMERATE = 30;
const NONCOMBAT = 0x8000003d;
const BOW = 0x8000003f;
const THROWN = 0x80000047;
const LUGIAN = 0x8000003c; // stands in for a creature table without Reload
const READY = 0x41000003;
const AIM_LEVEL = 0x4000001e;
const AIM_HIGH30 = 0x40000020;
const RELOAD = 0x40000016;

// Cycles keyed `${style low16}:${cmd low16}`; `hold` = a framerate-0 hold
// (the real bake is a single frame).
const CYCLES = new Map([
  ["3d:3", { id: 1000 }],
  ["3f:3", { id: 10 }],
  ["3f:1e", { id: 20, hold: true }],
  ["3f:20", { id: 30, hold: true }],
  ["3f:16", { id: 40, hold: true }],
  ["47:3", { id: 510 }],
  ["47:1e", { id: 520, hold: true }],
  ["47:16", { id: 540, hold: true }],
  ["3c:3", { id: 810 }],
  ["3c:1e", { id: 820, hold: true }],
]);
// Links keyed `${style low16}:${from low16}:${FULL to}` (outer key masks the
// substate; inner key is the full command, as holtburger-dat get_link).
const LINKS = new Map([
  [`3f:3:${AIM_LEVEL}`, 110],   // bow: Ready → AimLevel
  [`3f:3:${AIM_HIGH30}`, 130],  // bow: Ready → AimHigh30 (raise)
  [`3f:1e:${READY}`, 210],      // bow: AimLevel → Ready
  [`3f:20:${READY}`, 230],      // bow: AimHigh30 → Ready (snap level)
  [`3f:3:${RELOAD}`, 140],      // bow: Ready → Reload (reach for the quiver)
  [`3f:16:${READY}`, 240],      // bow: Reload → Ready (draw + nock)
  [`3d:3:${BOW}`, 300],         // NonCombat → BowCombat (draw the bow)
  [`3f:3:${NONCOMBAT}`, 310],   // BowCombat → NonCombat (sheathe)
  [`47:3:${AIM_LEVEL}`, 610],   // thrown: Ready → AimLevel (wind-up)
  [`47:1e:${RELOAD}`, 620],     // thrown: AimLevel → Reload (THE THROW)
  [`47:1e:${READY}`, 630],      // thrown: AimLevel → Ready (throw + recover)
  [`47:3:${RELOAD}`, 640],      // thrown: Ready → Reload (reversed draw)
  [`47:16:${READY}`, 650],      // thrown: Reload → Ready (draw the next one)
  [`3c:3:${AIM_LEVEL}`, 910],   // lugian: Ready → AimLevel (wind-up)
  [`3c:1e:${READY}`, 930],      // lugian: AimLevel → Ready (the throw)
]);

function frames(id, n) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let f = 0; f < n; f += 1) {
    for (let p = 0; p < PART_COUNT; p += 1) {
      const b = (f * PART_COUNT + p) * 7;
      flat[b] = p;
      flat[b + 3] = 1; flat[b + 4] = f / 100; flat[b + 5] = id / 10000;
    }
  }
  return flat;
}
const partY = (inst) => {
  const q = inst.parts[0].quaternion;
  return Math.round(q.y * 10000) + Math.round(q.x * 100);
};
const clipOf = (y) => Math.floor(y / 10) * 10;

function partMesh(p) {
  return {
    triCount: 1,
    positions: new Float32Array([p, 0, 0, p + 0.5, 0, 0, p + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  };
}

const lowHex = (v) => ((v >>> 0) & 0xffff).toString(16);
const cycleFor = (cmd, stance) => CYCLES.get(`${lowHex(stance || NONCOMBAT)}:${lowHex(cmd)}`) ?? null;
const linkIdFor = (stance, fromMotion, cmd) =>
  LINKS.get(`${lowHex(stance || NONCOMBAT)}:${lowHex(fromMotion)}:${cmd >>> 0}`) ?? null;

// Optional per-command cycle-bake delay (M9: a cold Reload bake).
let slowCycle = null;
const wasmExports = {
  async fetchEntityAnimationKeyframes(_setupId, _mc, _tc, _pal, _subs, _mtableId, cmd, stance, fromMotion) {
    cmd >>>= 0; stance >>>= 0; fromMotion >>>= 0;
    if (!fromMotion && slowCycle && (cmd & 0xffff) === (slowCycle.cmd & 0xffff)) {
      await new Promise((r) => setTimeout(r, slowCycle.ms));
    }
    let id = null;
    let isLink = false;
    let n = 0;
    if (fromMotion) {
      const hit = linkIdFor(stance, fromMotion, cmd);
      if (hit != null) { id = hit; isLink = true; n = LINK_FRAMES; }
    }
    if (id == null) {
      // Real fallback: the target's CYCLE (none → empty).
      const c = cycleFor(cmd, stance);
      id = c ? c.id : null;
      n = c ? (c.hold ? 1 : NUM_FRAMES) : 0;
    }
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    return {
      partCount: PART_COUNT,
      numFrames: n,
      framerate: n ? FRAMERATE : 0,
      resolvedStance: stance || NONCOMBAT,
      isLink,
      partFrames: n ? frames(id, n) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetchMotionLinkKeyframes(_setupId, _mtableId, stance, fromMotion, cmd, _urgent) {
    const id = linkIdFor(stance >>> 0, fromMotion >>> 0, cmd >>> 0);
    if (id == null) return undefined;
    return {
      partCount: PART_COUNT,
      numFrames: LINK_FRAMES,
      framerate: FRAMERATE,
      resolvedStance: stance || NONCOMBAT,
      isLink: true,
      partFrames: frames(id, LINK_FRAMES),
      takePartMeshes() { return []; },
    };
  },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};

let nextGuid = 0x80003a01;
function makeManager(missileSubstateOn = true) {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  em._missileSubstateOn = missileSubstateOn;
  return em;
}
function spawnMeta(extra = {}) {
  return {
    guid: nextGuid++, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: BOW, objScale: 1, name: "archer",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    ...extra,
  };
}
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 1));
}
// Tick until the playhead is free, collecting every distinct clip id posed.
function drain(em, inst, steps = 60) {
  const seen = [];
  for (let i = 0; i < steps; i += 1) {
    em.tick(0.02);
    const id = clipOf(partY(inst));
    if (seen[seen.length - 1] !== id) seen.push(id);
  }
  return seen;
}
const before = (order, a, b) => order.indexOf(a) >= 0 && order.indexOf(b) > order.indexOf(a);
const queued = (inst) => (inst._unifiedQueue?.list ?? []).map((n) => [n.motion >>> 0, n.payload?.speed]);

test("M1 bow shot: raise, hold, snap level + reach (retail two-hop), hold, then the nock", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  // Wire order of a stock ACE server: KIND_MOTION bare low-16s.
  await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
  const aim = drain(em, inst);
  assert.ok(before(aim, 130, 30), `raise then hold, saw ${aim}`);
  assert.equal(aim[aim.length - 1], 30, "holds the aim");

  await em.setMotion(inst.guid, RELOAD & 0xffff, BOW & 0xffff, 1.5);
  assert.deepEqual(
    queued(inst),
    [[RELOAD, 1], [RELOAD, 1.5]],
    "one Reload node: hop 1 (Aim→Ready) at the aim's speed, hop 2 (Ready→Reload) at the Reload speed",
  );
  const reload = drain(em, inst);
  assert.ok(before(reload, 230, 140), `snap level, then reach, saw ${reload}`);
  assert.equal(reload[reload.length - 1], 40, "holds the Reload frame (no pop back to the aim)");
  assert.ok(!reload.includes(30), "never returns to the aim hold");

  await em.setMotion(inst.guid, 0, BOW & 0xffff);
  const ready = drain(em, inst);
  assert.ok(before(ready, 240, 10), `draw + nock, then Ready, saw ${ready}`);
  assert.equal(ready[ready.length - 1], 10);
  em.dispose();
});

test("M2 the bridge's synthesized Ready in front of the Reload does not cut the shot", async () => {
  // Today's wasm turns the forward-slot Reload into KIND_MOTION(0) +
  // KIND_MOTION_ACTION(full Reload) in one drain.
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
  drain(em, inst);
  em.setMotion(inst.guid, 0, BOW & 0xffff); // KIND_MOTION(0)
  await em.setMotion(inst.guid, RELOAD, BOW, 1.5); // KIND_MOTION_ACTION
  await settle();
  const reload = drain(em, inst);
  assert.ok(before(reload, 230, 140), `snap + reach from the aim, saw ${reload}`);
  assert.ok(!reload.includes(10), `no pop into the Ready cycle, saw ${reload}`);
  assert.equal(reload[reload.length - 1], 40);
  await em.setMotion(inst.guid, 0, BOW & 0xffff);
  const ready = drain(em, inst);
  assert.ok(before(ready, 240, 10), `nock then Ready, saw ${ready}`);
  em.dispose();
});

test("M3 thrown: wind-up, hold, THE THROW (direct Aim→Reload), hold, draw the next — no un-draw", async () => {
  for (const oldWire of [false, true]) {
    const em = makeManager();
    const inst = await em.spawn(spawnMeta({ motionStance: THROWN }));
    await em.setMotion(inst.guid, AIM_LEVEL & 0xffff, THROWN & 0xffff);
    const aim = drain(em, inst);
    assert.ok(before(aim, 610, 520), `wind-up then hold, saw ${aim}`);
    if (oldWire) em.setMotion(inst.guid, 0, THROWN & 0xffff);
    await em.setMotion(inst.guid, oldWire ? RELOAD : RELOAD & 0xffff, THROWN & 0xffff, 1.25);
    await settle();
    const thr = drain(em, inst);
    assert.ok(thr.includes(620), `the throw plays (oldWire=${oldWire}), saw ${thr}`);
    assert.ok(!thr.includes(640), `no reversed draw (oldWire=${oldWire}), saw ${thr}`);
    assert.ok(!thr.includes(630), `no early Aim→Ready (oldWire=${oldWire}), saw ${thr}`);
    assert.equal(thr[thr.length - 1], 540);
    await em.setMotion(inst.guid, 0, THROWN & 0xffff);
    const ready = drain(em, inst);
    assert.ok(before(ready, 650, 510), `draw the next one, then Ready, saw ${ready}`);
    em.dispose();
  }
});

test("M3b thrown, cold aim bake + today's wire: the Reload still plays the throw, not the un-draw", async () => {
  // ACE launches ~0.38 s after the aim; a cold first bake can still be in
  // flight when the synthesized Ready + Reload arrive (the aim never commits).
  const em = makeManager();
  const inst = await em.spawn(spawnMeta({ motionStance: THROWN }));
  slowCycle = { cmd: AIM_LEVEL, ms: 40 };
  try {
    em.setMotion(inst.guid, AIM_LEVEL & 0xffff, THROWN & 0xffff);
    await new Promise((r) => setTimeout(r, 2));
    em.setMotion(inst.guid, 0, THROWN & 0xffff);
    await em.setMotion(inst.guid, RELOAD, THROWN & 0xffff, 1.25);
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    slowCycle = null;
  }
  const thr = drain(em, inst);
  assert.ok(thr.includes(620), `the throw plays, saw ${thr}`);
  assert.ok(!thr.includes(640), `no reversed draw, saw ${thr}`);
  assert.equal(thr[thr.length - 1], 540);
  em.dispose();
});

test("M4 local rig: the skipped server Ready plays the nock; an autonomous echo keeps the hold", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
  await em.setMotion(inst.guid, RELOAD & 0xffff, BOW & 0xffff, 1.5);
  drain(em, inst);
  // loop.js skip branch for an AUTONOMOUS echo (our own movement): stance only.
  em.setLocalStance(inst.guid, BOW & 0xffff, { forced: false });
  await settle();
  assert.equal(clipOf(partY((em.tick(0.02), inst))), 40, "still holding the Reload frame");
  // ACE's closing Ready (server-forced) — skipped as predictor-owned.
  em.setLocalStance(inst.guid, BOW & 0xffff, { forced: true });
  await settle();
  const ready = drain(em, inst);
  assert.ok(before(ready, 240, 10), `nock then Ready, saw ${ready}`);
  assert.equal(inst.lastMotionCommand, READY);
  em.dispose();
});

test("M5 local rig out of ammo: the NonCombat style change exits the aim and sheathes", async () => {
  const run = async (on) => {
    const em = makeManager(on);
    const inst = await em.spawn(spawnMeta());
    await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
    drain(em, inst);
    em.setLocalStance(inst.guid, NONCOMBAT & 0xffff, { forced: true });
    await settle();
    const order = drain(em, inst);
    em.dispose();
    return order;
  };
  const on = await run(true);
  assert.ok(before(on, 230, 310), `exit link then sheathe, saw ${on}`);
  assert.equal(on[on.length - 1], 1000, "NonCombat Ready");
  const off = await run(false);
  assert.equal(off[off.length - 1], 30, `\`=off\`: the old stuck aim pose, saw ${off}`);
});

test("M6 a table without Reload keeps the aim; the closing Ready plays its throw", async () => {
  for (const oldWire of [false, true]) {
    const em = makeManager();
    const inst = await em.spawn(spawnMeta({ motionStance: LUGIAN }));
    await em.setMotion(inst.guid, AIM_LEVEL & 0xffff, LUGIAN & 0xffff);
    drain(em, inst);
    if (oldWire) em.setMotion(inst.guid, 0, LUGIAN & 0xffff);
    em.setMotion(inst.guid, oldWire ? RELOAD : RELOAD & 0xffff, LUGIAN & 0xffff, 1.0);
    // ACE Monster_Missile: reloadTime is 0 without a Reload, so Ready follows at once.
    await em.setMotion(inst.guid, 0, LUGIAN & 0xffff);
    await settle();
    const order = drain(em, inst);
    assert.ok(before(order, 930, 810), `the throw, then Ready (oldWire=${oldWire}), saw ${order}`);
    em.dispose();
  }
});

test("M7 `?missileSubstate=off` restores the one-shot Reload overlay (no nock)", async () => {
  const em = makeManager(false);
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
  drain(em, inst);
  await em.setMotion(inst.guid, RELOAD, BOW, 1.5);
  await settle();
  const reload = drain(em, inst);
  assert.ok(reload.includes(140), `the Ready→Reload overlay, saw ${reload}`);
  assert.equal(reload[reload.length - 1], 30, "back to the aim hold (the old pop)");
  await em.setMotion(inst.guid, 0, BOW & 0xffff);
  const ready = drain(em, inst);
  assert.ok(!ready.includes(240), `no nock with the flag off, saw ${ready}`);
  em.dispose();
});

test("M8 combat-entry reload from Ready: reach, hold, nock", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta({ motionStance: NONCOMBAT }));
  await em.setMotion(inst.guid, 0, BOW & 0xffff); // HandleSwitchToMissileCombatMode
  const draw = drain(em, inst);
  assert.ok(before(draw, 300, 10), `draw the bow, saw ${draw}`);
  await em.setMotion(inst.guid, RELOAD & 0xffff, BOW & 0xffff, 1.2); // ReloadMissileAmmo
  assert.deepEqual(queued(inst), [[RELOAD, 1.2]], "Ready→Reload at the Reload speed");
  const reload = drain(em, inst);
  assert.ok(before(reload, 140, 40), `reach then hold, saw ${reload}`);
  await em.setMotion(inst.guid, 0, BOW & 0xffff);
  const ready = drain(em, inst);
  assert.ok(before(ready, 240, 10), `nock then Ready, saw ${ready}`);
  em.dispose();
});

test("M9 a cold Reload bake: the closing Ready waits for it", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, AIM_HIGH30 & 0xffff, BOW & 0xffff);
  drain(em, inst);
  slowCycle = { cmd: RELOAD, ms: 40 };
  try {
    em.setMotion(inst.guid, RELOAD & 0xffff, BOW & 0xffff, 1.5);
    await em.setMotion(inst.guid, 0, BOW & 0xffff); // arrives before the Reload commits
    await settle();
  } finally {
    slowCycle = null;
  }
  const order = drain(em, inst);
  assert.ok(before(order, 140, 240), `reach, then nock, saw ${order}`);
  assert.equal(order[order.length - 1], 10);
  em.dispose();
});

test("M10 missileSubstateEnabled: absent = ON; off / 0 / false / no = OFF", () => {
  assert.equal(missileSubstateEnabled(""), true);
  assert.equal(missileSubstateEnabled("?foo=1"), true);
  assert.equal(missileSubstateEnabled("?missileSubstate=on"), true);
  for (const v of ["off", "OFF", "0", "false", "no"]) {
    assert.equal(missileSubstateEnabled(`?missileSubstate=${v}`), false, v);
  }
});
