// tests/motion_link_fidelity.test.mjs — bugs 2 / 15 / 18 (2026-10-07).
//
// The REAL EntityManager against a wasm mock that behaves like the real bake
// (src/lib.rs build_entity_animation_data_inner_v2 + holtburger-dat
// MotionTable::get_link):
//   · a link's INNER key is the FULL 32-bit command — a bare low-16 target
//     misses (the C3 invariant);
//   · a missed link FALLS BACK to the target's cycle, flagged `isLink:false`.
//   · `fetchMotionLinkKeyframes` (cmotiontable-3, lib.rs build_link_only_inner)
//     returns only the link's keyframes, and `undefined` on a miss.
// The older unified_motion_authority mock matched links on low-16 and
// returned nothing on a miss, so it could not see either half of the bug.
//
//   L1  a missed link's cycle fallback never plays as a one-shot (S1); the
//       link goes through the geometry-free export and its miss is cached
//   L1b a pkg/ without that export, or `?linkOnlyBake=off`, keeps the old path
//   L2  a remote BARE Ready after Run finds the real Run→Ready link (full key)
//   L3  turn / strafe / run commands never cut a windup on the playhead (S2)
//   L4  a combat toggle while running plays exit → draw → entry → cycle (bug 18)
//   L4b ...the exit and draw links at speed 1.0, the entry at the run speed
//       (`?styleLinkSpeed`, cmotiontable-1)
//   L5  setLocalStance while running plays that chain instead of only stamping
//   L6  motions arriving while the rig is still spawning are replayed (bug 15)
//   L7  a cast burst (more than the old 3-deep queue) keeps every windup
//   L8  jump: Falling take-off/loop, mid-air keys held, landing link (bug 19)
//
// Run: node tests/motion_link_fidelity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

const PART_COUNT = 3;
const NUM_FRAMES = 8;
const LINK_FRAMES = 4;
const FRAMERATE = 30;
const NONCOMBAT = 0x8000003d;
const HANDCOMBAT = 0x8000003c;
const MAGIC = 0x80000049;
const READY = 0x41000003;
const RUN = 0x44000007;
const WALK = 0x45000005;
const TURN_R = 0x6500000d;
const SIDESTEP_R = 0x6500000f;
const POWERUP1 = 0x1000006f;
const FALLING = 0x40000015;

// Clip ids (encoded into the posed quaternion, as in the authority test).
const CYC = { [READY]: 10, [RUN]: 100, [WALK]: 50, [TURN_R]: 60, [SIDESTEP_R]: 300, [FALLING]: 720 };
const COMBAT_OFFSET = 1000; // a HandCombat cycle = its NonCombat id + 1000
// Real links, keyed `${style low16}:${from low16}:${FULL to}` (outer key is
// style << 16 | substate low bits; inner key is the full command).
const LINKS = new Map([
  [`3d:7:${READY}`, 600],             // Run → Ready (stop flourish), NonCombat
  [`3d:3:${HANDCOMBAT}`, 400],        // NonCombat Ready → HandCombat (draw)
  [`3c:3:${RUN}`, 450],               // HandCombat Ready → Run (start)
  [`49:3:${POWERUP1}`, 950],          // Magic Ready → windup
  [`3d:3:${FALLING}`, 700],           // Ready → Falling (take-off)
  [`3d:15:${RUN}`, 750],              // Falling → Run (landing)
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

function cycleId(cmd, stance) {
  const base = CYC[cmd >>> 0] ?? CYC[[READY, RUN, WALK, TURN_R, SIDESTEP_R, FALLING].find((c) => (c & 0xffff) === (cmd & 0xffff))];
  if (base == null) return null;
  return ((stance & 0xffff) === 0x3c ? COMBAT_OFFSET : 0) + base;
}

let spawnDelayMs = 0;
const bakes = [];
// cmotiontable-3: calls into the geometry-free link export.
const linkBakes = [];
// Real get_link: the inner key is the FULL command.
const linkIdFor = (stance, fromMotion, cmd) => {
  const style = (stance || NONCOMBAT) & 0xffff;
  return LINKS.get(`${style.toString(16)}:${(fromMotion & 0xffff).toString(16)}:${cmd}`) ?? null;
};
const wasmExports = {
  async fetchEntityAnimationKeyframes(_setupId, _mc, _tc, _pal, _subs, _mtableId, cmd, stance, fromMotion) {
    cmd >>>= 0; stance >>>= 0; fromMotion >>>= 0;
    bakes.push({ cmd, stance, fromMotion });
    if (spawnDelayMs && !fromMotion) await new Promise((r) => setTimeout(r, spawnDelayMs));
    let id = null;
    let isLink = false;
    let n = 0;
    if (fromMotion) {
      const hit = linkIdFor(stance, fromMotion, cmd);
      if (hit != null) { id = hit; isLink = true; n = LINK_FRAMES; }
    }
    if (id == null) {
      // Real fallback: the target's CYCLE (an action has none → empty).
      id = cycleId(cmd, stance || NONCOMBAT);
      n = id == null ? 0 : NUM_FRAMES;
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
  // cmotiontable-3: like the real lib.rs `fetchMotionLinkKeyframes` — only the
  // link's keyframes (no part meshes), `undefined` on a miss (no cycle bake).
  async fetchMotionLinkKeyframes(_setupId, _mtableId, stance, fromMotion, cmd, _urgent) {
    cmd >>>= 0; stance >>>= 0; fromMotion >>>= 0;
    linkBakes.push({ cmd, stance, fromMotion });
    const id = linkIdFor(stance, fromMotion, cmd);
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

let nextGuid = 0x80002a01;
function makeManager() {
  return new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
}
function spawnMeta(extra = {}) {
  return {
    guid: nextGuid++, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: NONCOMBAT, objScale: 1, name: "t",
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
    const id = Math.floor(partY(inst) / 10) * 10;
    if (seen[seen.length - 1] !== id) seen.push(id);
  }
  return seen;
}
const clipOf = (y) => Math.floor(y / 10) * 10;

test("L1 a missed link's cycle fallback never plays as a one-shot", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  const b0 = bakes.length;
  const l0 = linkBakes.length;
  await em.setMotion(inst.guid, WALK, NONCOMBAT);
  // Ready → Walk has no link: the link-only bake answers "no link".
  assert.equal(inst._unifiedSeq ?? null, null, "no fake link on the playhead");
  em.tick(0.02);
  assert.equal(clipOf(partY(inst)), 50, "the walk cycle plays at once");
  // cmotiontable-3: the link went through the geometry-free export, so no
  // full-rig bake with a `fromMotion` (and no cycle fallback) happened.
  assert.equal(bakes.slice(b0).filter((b) => b.fromMotion).length, 0, "no full-rig link bake");
  const readyToWalk = () =>
    linkBakes.slice(l0).filter((b) => (b.fromMotion & 0xffff) === 0x0003 && b.cmd === WALK).length;
  assert.equal(readyToWalk(), 1, "one link-only lookup for Ready → Walk");
  // Walk → Ready → Walk: the cached miss answers without a second wasm call.
  await em.setMotion(inst.guid, READY, NONCOMBAT);
  await em.setMotion(inst.guid, WALK, NONCOMBAT);
  assert.equal(readyToWalk(), 1, "the authoritative miss is cached");
  let linkOnlyKeys = 0;
  for (const [key, p] of em.animationCache.entries) {
    if (!key.includes(":linkonly:")) continue;
    linkOnlyKeys += 1;
    const e = await p;
    assert.ok(
      e === null || (Array.isArray(e.partGroups) && e.partGroups.length === 0),
      `no part geometry on ${key}`,
    );
  }
  assert.ok(linkOnlyKeys >= 2, `link-only entries cached (${linkOnlyKeys})`);
  em.dispose();
});

test("L1b a pkg/ without fetchMotionLinkKeyframes, or ?linkOnlyBake=off, keeps the full-rig link path", async () => {
  const { fetchMotionLinkKeyframes: _omit, ...stale } = wasmExports;
  const makers = [
    () => new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, stale),
    () => {
      const em = makeManager();
      em._linkOnlyBakeOn = false;
      return em;
    },
  ];
  for (const mk of makers) {
    const em = mk();
    const inst = await em.spawn(spawnMeta());
    const b0 = bakes.length;
    const l0 = linkBakes.length;
    await em.setMotion(inst.guid, RUN & 0xffff, NONCOMBAT & 0xffff);
    await em.setMotion(inst.guid, 0x0003, 0x003d);
    assert.ok(inst._unifiedSeq?.clearOnDone, "a link is playing");
    em.tick(0.01);
    assert.equal(clipOf(partY(inst)), 600, "the Run→Ready link still plays");
    assert.equal(linkBakes.length, l0, "the link-only export is not called");
    assert.ok(bakes.slice(b0).some((b) => b.fromMotion), "the full-rig export baked the link");
    em.dispose();
  }
});

test("L2 a remote bare Ready after Run plays the real Run→Ready link", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, RUN & 0xffff, NONCOMBAT & 0xffff); // wire bare low-16s
  await em.setMotion(inst.guid, 0x0003, 0x003d);
  assert.ok(inst._unifiedSeq?.clearOnDone, "a link is playing");
  em.tick(0.01);
  assert.equal(clipOf(partY(inst)), 600, "the authored stop flourish, not a Ready cycle");
  assert.equal(inst.lastMotionCommand, READY, "remembered as the full command");
  em.dispose();
});

test("L3 turn / strafe / run never cut a windup on the playhead", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta({ motionStance: MAGIC }));
  em.setMotion(inst.guid, POWERUP1, MAGIC, 1.0);
  await settle();
  const windup = inst._unifiedSeq;
  assert.ok(windup, "windup on the playhead");
  em.tick(0.01);
  assert.equal(clipOf(partY(inst)), 950);
  await em.setMotion(inst.guid, TURN_R, MAGIC);
  await em.setMotion(inst.guid, SIDESTEP_R, MAGIC);
  await em.setMotion(inst.guid, RUN, MAGIC);
  assert.equal(inst._unifiedSeq, windup, "still the same windup");
  em.tick(0.01);
  assert.equal(clipOf(partY(inst)), 950, "windup still posed");
  em.dispose();
});

test("L4 a combat toggle while running plays exit → draw → entry → combat run", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, RUN, NONCOMBAT);
  em.tick(0.05);
  assert.equal(clipOf(partY(inst)), 100, "running in NonCombat");
  await em.setMotion(inst.guid, RUN, HANDCOMBAT);
  const order = drain(em, inst);
  const i600 = order.indexOf(600), i400 = order.indexOf(400), i450 = order.indexOf(450);
  assert.ok(i600 >= 0 && i400 > i600 && i450 > i400, `exit → draw → entry, saw ${order}`);
  assert.equal(order[order.length - 1], COMBAT_OFFSET + 100, "lands on the combat run cycle");
  assert.ok(!order.slice(0, i450).includes(COMBAT_OFFSET + 100), "no pop into the combat run first");
  em.dispose();
});

test("L4b the exit and draw links play at 1.0; only the entry link takes the run speed", async () => {
  // Retail appends the style change from a fresh MovementParameters (speed
  // 1.0) before it sets the forward speed (CMotionInterp::
  // apply_interpreted_movement, acclient.c:344147; ctor :339437).
  const speeds = async (styleLinkSpeedOn) => {
    const em = makeManager();
    em._styleLinkSpeedOn = styleLinkSpeedOn;
    const inst = await em.spawn(spawnMeta());
    await em.setMotion(inst.guid, RUN, NONCOMBAT, 2.5);
    em.tick(0.05);
    await em.setMotion(inst.guid, RUN, HANDCOMBAT, 2.5);
    const sp = new Map(inst._unifiedQueue.list.map((n) => [n.motion >>> 0, n.payload?.speed]));
    em.dispose();
    return sp;
  };
  const sp = await speeds(true);
  assert.equal(sp.get(READY), 1, "exit link (Run → Ready) at 1.0");
  assert.equal(sp.get(HANDCOMBAT), 1, "draw link at 1.0");
  assert.equal(sp.get(RUN), 2.5, "entry link (Ready → Run) at the run speed");
  const legacy = await speeds(false);
  assert.equal(legacy.get(HANDCOMBAT), 2.5, "`=off`: the draw link runs at the command speed");
});

test("L5 setLocalStance while running plays the chain instead of only stamping", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  await em.setMotion(inst.guid, RUN, NONCOMBAT);
  em.setLocalStance(inst.guid, HANDCOMBAT);
  await settle();
  const order = drain(em, inst);
  assert.ok(order.includes(400), `draw link played, saw ${order}`);
  assert.equal(order[order.length - 1], COMBAT_OFFSET + 100);
  em.dispose();
});

test("L6 motions that arrive while the rig is still spawning are replayed", async () => {
  const em = makeManager();
  spawnDelayMs = 20;
  try {
    const meta = spawnMeta();
    const p = em.spawn(meta);
    await new Promise((r) => setTimeout(r, 2));
    assert.equal(em.entityMap.has(meta.guid), false, "still spawning");
    em.setMotion(meta.guid, RUN, NONCOMBAT, 1.0);
    const inst = await p;
    await settle();
    await new Promise((r) => setTimeout(r, 60));
    em.tick(0.02);
    assert.equal(clipOf(partY(inst)), 100, "the run that arrived mid-spawn is playing");
  } finally {
    spawnDelayMs = 0;
  }
  em.dispose();
});

test("L7 a cast burst longer than the old 3-deep queue keeps every windup", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta({ motionStance: MAGIC }));
  for (let i = 0; i < 6; i += 1) em.setMotion(inst.guid, POWERUP1, MAGIC, 1.0);
  await settle();
  const q = inst._unifiedQueue;
  assert.ok(q && q.list.length >= 6, `all six windups kept (queue ${q?.list.length})`);
  em.dispose();
});

test("L8 jump: take-off link + Falling loop, mid-air keys held, landing link on touchdown", async () => {
  const em = makeManager();
  const inst = await em.spawn(spawnMeta());
  em.setAirborne(inst.guid, true);
  await settle();
  const air = drain(em, inst, 30);
  assert.ok(air.includes(700), `take-off link played, saw ${air}`);
  assert.equal(air[air.length - 1], 720, "Falling loop while airborne");
  // W pressed mid-air: the state is kept, the clip is not changed.
  await em.setMotion(inst.guid, RUN, NONCOMBAT);
  em.tick(0.05);
  assert.equal(clipOf(partY(inst)), 720, "still Falling");
  em.setAirborne(inst.guid, false);
  await settle();
  const land = drain(em, inst, 30);
  assert.ok(land.includes(750), `Falling→Run landing link played, saw ${land}`);
  assert.equal(land[land.length - 1], 100, "lands into the held run");
  em.dispose();
});
