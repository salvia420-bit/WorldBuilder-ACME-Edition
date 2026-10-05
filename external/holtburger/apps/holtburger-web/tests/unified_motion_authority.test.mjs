// tests/unified_motion_authority.test.mjs — the ONE animation authority.
//
// entities.js drives every entity rig from the Rust MotionSequence playhead
// (`inst._unifiedSeq` one-shots over the `inst._unifiedLoco` cycle). This test
// imports the REAL EntityManager, mocks the wasm keyframe fetch, and installs a
// pure-JS MotionSequence stand-in (harness/lib/fake_motion_sequence.mjs) so the
// spawn → setMotion → tick plumbing runs headless.
//
// Run: node tests/unified_motion_authority.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

const MS = installFakeMotionSequence();

const PART_COUNT = 3;
const NUM_FRAMES = 8;
const FRAMERATE = 30;
const NONCOMBAT = 0x8000003d;
const READY = 0x41000003;
const WALK = 0x45000005;
const RUN = 0x44000007;
const DOOR_ON = 0x4000000b;
const DOOR_OFF = 0x4000000c;
const SIDESTEP_R = 0x6500000f;

// Each baked frame is tagged in the (raw, un-normalized) part quaternion:
// qy = clip id / 1000, qx = frame / 100 — the poser writes quaternions
// verbatim and its in-place locomotion fix only touches positions, so
// `partY(inst)` = clip id + frame index of what is posed right now.
function frames(yOffset, n = NUM_FRAMES) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let f = 0; f < n; f += 1) {
    for (let p = 0; p < PART_COUNT; p += 1) {
      const b = (f * PART_COUNT + p) * 7;
      flat[b] = p; flat[b + 2] = 0;
      // Door links (700 = Off→On, 800 = On→Off) swing part 1 like a hinged
      // leaf: its origin moves, parts 0/2 (the frame) stay put. The mean part
      // translation therefore moves too, which in-place posing would subtract.
      flat[b + 1] = (yOffset === 700 || yOffset === 800) && p === 1 ? -0.25 * f : 0;
      flat[b + 3] = 1; flat[b + 4] = f / 100; flat[b + 5] = yOffset / 1000;
    }
  }
  return flat;
}

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

// (motion, fromMotion) → y offset of the baked clip; 0 frames = no clip.
const SWORD = 0x8000003e;
const MAGIC_BLAST = 0x4000002b;
const POWERUP1 = 0x1000006f;
let linkDelayMs = 0; // delay for style-link bakes (stance-switch race test)
let gestureDelayMs = 0; // delay for MagicBlast bakes (cold-cache cast race)
function yFor(cmd, from, stance = 0) {
  const low = cmd & 0xffff;
  if (from) {
    // Stance (draw/sheathe) link: links[(oldStyle, Ready)][newStyle].
    if ((from & 0xffff) === 0x03 && (cmd >>> 24) === 0x80) return 400;
    // Cast gesture substate: Ready→MagicBlast (raise) / MagicBlast→Ready (recoil).
    if ((from & 0xffff) === 0x03 && low === 0x2b) return 200;
    // Real MT 0x09000001: links[(Magic, MagicBlast)] holds ONLY the full
    // Ready 0x41000003 (the link inner key is never masked, C3).
    if ((from & 0xffff) === 0x2b && cmd === READY) return 250;
    if ((from & 0xffff) === 0x03 && low === 0x6f) return 950; // windup action
    // MotionTable links: door Off→On / On→Off, and Ready→gesture.
    if ((from & 0xffff) === 0x0c && low === 0x0b) return 700;
    if ((from & 0xffff) === 0x0b && low === 0x0c) return 800;
    if (low === 0x87) return 900; // a gesture link (e.g. an emote/swing)
    return null; // no link
  }
  if (low === 0x03) return (stance & 0xffff) === (SWORD & 0xffff) ? 20 : 10;
  if (low === 0x2b) return 150; // the gesture's held (framerate-0) cycle
  if (low === 0x05) return 50;
  if (low === 0x07) return 100;
  if (low === 0x0b) return 500;
  if (low === 0x0c) return 600;
  if (low === 0x0f) return 300;
  return null;
}

const fetches = [];
const wasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    fetches.push({ cmd: cmd >>> 0, from: fromMotion >>> 0 });
    const y = yFor(cmd >>> 0, fromMotion >>> 0, stance >>> 0);
    if (y === 400 && linkDelayMs) await new Promise((r) => setTimeout(r, linkDelayMs));
    if ((cmd & 0xffff) === 0x2b && gestureDelayMs) await new Promise((r) => setTimeout(r, gestureDelayMs));
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    const n = y == null ? 0 : (fromMotion ? 4 : (y === 150 ? 1 : NUM_FRAMES));
    return {
      partCount: PART_COUNT,
      numFrames: n,
      framerate: n ? FRAMERATE : 0,
      resolvedStance: stance || 0x3d,
      partFrames: n ? frames(y, n) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};

let nextGuid = 0x50000001;
function makeManager() {
  return new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
}
async function spawn(em, motionCommand, extra = {}) {
  const guid = nextGuid++;
  return em.spawn({
    guid, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    ...extra,
  });
}
const partY = (inst) => {
  const q = inst.parts[0].quaternion;
  return Math.round(q.y * 1000) + Math.round(q.x * 100);
};

test("spawn puts the initial cycle on the Rust playhead", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  assert.ok(inst._unifiedLoco, "_unifiedLoco installed at spawn");
  assert.equal(inst._unifiedLoco.hold, false);
  assert.equal(inst.mixer, undefined, "no AnimationMixer on the rig");
  assert.equal(inst.currentActionKey, inst._unifiedLoco.cacheKey,
    "currentActionKey is the playhead's key");
  em.tick(0.1);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "rig posed from the Ready cycle");
  // Re-issuing the spawn cycle is a no-op (dedup against the playhead key).
  const before = em.motionSwitchCount;
  await em.setMotion(inst.guid, READY, NONCOMBAT & 0xffff);
  // stance differs from the spawn-resolved one only if the key differs.
  assert.ok(em.motionSwitchCount - before <= 1);
  em.dispose();
});

test("a walk → run swap stays on the playhead and carries phase", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, WALK, 0x3d);
  const walkKey = inst._unifiedLoco.cacheKey;
  assert.equal(inst.currentActionKey, walkKey);
  em.tick(0.1);
  assert.ok(partY(inst) >= 50 && partY(inst) < 50 + NUM_FRAMES, "walk cycle posed");
  await em.setMotion(inst.guid, RUN, 0x3d);
  assert.notEqual(inst._unifiedLoco.cacheKey, walkKey);
  em.tick(0.05);
  assert.ok(partY(inst) >= 100, "run cycle posed");
  em.dispose();
});

test("doors: spawn holds the state, links play as HELD one-shots, re-broadcasts are no-ops", async () => {
  const em = makeManager();
  const door = await spawn(em, DOOR_OFF);
  assert.ok(door._unifiedLoco?.hold, "closed state installed as a held cycle");
  assert.equal(door.lastMotionCommand, DOOR_OFF, "spawn state seeds the link memory");
  em.tick(0.016);
  assert.equal(partY(door), 600 + NUM_FRAMES - 1, "held on the Off cycle's final frame");

  // Open: the Off→On LINK plays once and holds its final (open) frame.
  await em.playDoorMotion(door.guid, true);
  const open = door._unifiedSeq;
  assert.ok(open?.stateHold && open.clearOnDone === false, "open link is a held one-shot");
  em.tick(0.05);
  assert.ok(partY(door) >= 700 && partY(door) < 704, "open swing playing");
  for (let i = 0; i < 20; i += 1) em.tick(0.05);
  assert.equal(door._unifiedSeq, open, "hold survives completion");
  assert.equal(partY(door), 703, "held on the link's final (open) frame");
  // 2026-10-05 door regression: a state link is posed from its RAW frames.
  // In place would subtract the leaf's mean sweep (-0.25 m here) from every
  // part and drag the static frame along with it.
  assert.equal(door.parts[0].position.y, 0, "static door frame part is not dragged");
  assert.ok(Math.abs(door.parts[1].position.y - -0.75) < 1e-6, "leaf at its authored open position");

  // Both triggers of one change (server Motion + SetState kind=15) → one play.
  await em.setMotion(door.guid, DOOR_ON, 0, 1.0);
  await em.playDoorMotion(door.guid, true);
  assert.equal(door._unifiedSeq, open, "re-broadcast of the held state is a no-op");
  em.tick(0.05);
  assert.equal(partY(door), 703, "no snap back to the spawn (closed) state");

  // Close: the On→Off link replaces the open hold.
  await em.setMotion(door.guid, DOOR_OFF, 0, 1.0);
  assert.notEqual(door._unifiedSeq, open);
  assert.equal(open.seq.__wbg_ptr, 0, "previous hold freed");
  for (let i = 0; i < 20; i += 1) em.tick(0.05);
  assert.equal(partY(door), 803, "held closed");
  assert.equal(door.parts[0].position.y, 0, "closed hold not offset either");
  assert.equal(door.mixer, undefined, "no mixer anywhere");
  em.dispose();
});

test("doors: no prior state → no link → the commanded state's cycle hold shows", async () => {
  const em = makeManager();
  const chest = await spawn(em, READY);
  await em.setMotion(chest.guid, DOOR_ON, 0, 1.0);
  assert.equal(chest._unifiedSeq ?? null, null);
  assert.ok(chest._unifiedLoco.hold, "On cycle installed held, not looping");
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.equal(partY(chest), 500 + NUM_FRAMES - 1);
  em.dispose();
});

test("A5-P3 root motion on the playhead: applied once, only on natural completion", async () => {
  const em = makeManager();
  em._rootMotionObjectOn = true; // node has no location → the reader defaults off
  const inst = await spawn(em, READY);
  const x0 = inst.root.position.x;
  const rec = { seq: MS.fromDescriptor(4, 30, 4 / 30, null, null, null, false) };
  em._armUnifiedRootMotion(inst, rec, [1, 0, 0, 1, 0, 0, 0]);
  em._applyUnifiedRootMotionIfDone(inst, rec);
  assert.equal(inst.root.position.x, x0, "not applied before completion");
  rec.seq.advance(1);
  em._applyUnifiedRootMotionIfDone(inst, rec);
  em._applyUnifiedRootMotionIfDone(inst, rec);
  assert.ok(Math.abs(inst.root.position.x - (x0 + 1)) < 1e-6, "applied exactly once");
  em.dispose();
});

test("setSidestepLayer is a scalar setter (no layer, no playhead change)", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, WALK, 0x3d);
  const loco = inst._unifiedLoco;
  const ret = em.setSidestepLayer(inst.guid, 0x65000010 /* Left */, 0x3d, -0.5);
  assert.equal(ret, undefined, "synchronous");
  assert.equal(inst._sidestepCommand, SIDESTEP_R, "Left folded to SideStepRight");
  assert.equal(inst._sidestepSpeed, 0.5, "speed magnitude");
  assert.equal(inst._unifiedLoco, loco, "the forward cycle keeps the playhead");
  assert.equal(inst._unifiedSeq ?? null, null);
  em.setSidestepLayer(inst.guid, SIDESTEP_R, 0x3d);
  assert.equal(inst._sidestepSpeed, 1.0, "omitted speed defaults to 1.0");
  em.setSidestepLayer(inst.guid, 0, 0x3d);
  assert.equal(inst._sidestepCommand, 0);
  assert.equal(inst._sidestepSpeed, 0);
  em.dispose();
});

test("setSwingMotion always plays a full-body one-shot on the playhead (never-moved entity too)", async () => {
  const em = makeManager();
  const GESTURE = 0x10000087;
  window.__sessionHandle = {
    lookupMotionLinkForSwing: () => ({
      kind: "swing", animId: 1, durationSec: 4 / FRAMERATE, resolvedCommand: GESTURE,
    }),
  };
  try {
    const inst = await spawn(em, READY); // spawned, never moved
    const loco = inst._unifiedLoco;
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d });
    const a = inst._unifiedSeq;
    assert.ok(a && a.clearOnDone === true, "gesture is a clearOnDone one-shot");
    em.tick(0.01);
    assert.ok(partY(inst) >= 900 && partY(inst) < 904, "gesture owns the rig");
    // A second gesture queues behind the first (J5), not a cut.
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d, speed: 2 });
    assert.equal(inst._unifiedSeq, a, "in-flight gesture keeps the playhead");
    assert.equal(inst._unifiedQueue.list.length, 2);
    for (let i = 0; i < 10; i += 1) em.tick(0.05);
    assert.notEqual(inst._unifiedSeq, a);
    for (let i = 0; i < 10; i += 1) em.tick(0.05);
    assert.equal(inst._unifiedSeq, null, "queue drained");
    assert.equal(inst._unifiedLoco, loco, "cycle resumes");
    em.tick(0.01);
    assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "back on the Ready cycle");
    assert.equal(inst.mixer, undefined);
  } finally {
    delete window.__sessionHandle;
    em.dispose();
  }
});

test("stale pkg (no MotionSequence) → ONE loud console.error, rest pose, no throw", async () => {
  const em = makeManager();
  const saved = window.__hbWasm.MotionSequence;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    delete window.__hbWasm.MotionSequence;
    const a = await spawn(em, READY);
    const b = await spawn(em, WALK);
    em.tick(0.05);
    assert.equal(a._unifiedLoco ?? null, null);
    assert.equal(b._unifiedLoco ?? null, null);
    const hits = errs.filter((m) => m.includes("MotionSequence is missing"));
    assert.equal(hits.length, 1, "reported exactly once");
  } finally {
    console.error = origErr;
    window.__hbWasm.MotionSequence = saved;
    em.dispose();
  }
});

test("stance switch: the draw link and the new stance cycle commit together", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, READY, NONCOMBAT); // seed lastStance
  em.tick(0.05);
  const oldLoco = inst._unifiedLoco;
  linkDelayMs = 30; // the link bake is slower than the cycle bake
  try {
    const p = em.setMotion(inst.guid, READY, SWORD);
    // While the link is still baking, the OLD stance's cycle keeps animating:
    // no early pop into the sword stance and no frozen frame.
    await new Promise((r) => setTimeout(r, 5));
    em.tick(0.05);
    assert.equal(inst._unifiedLoco, oldLoco, "old cycle still installed during the link fetch");
    assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "old stance still posed");
    await p;
  } finally {
    linkDelayMs = 0;
  }
  assert.ok(inst._unifiedSeq && inst._unifiedSeq.clearOnDone, "draw link on the playhead");
  assert.notEqual(inst._unifiedLoco, oldLoco, "new stance cycle installed in the same step");
  assert.equal(inst._unifiedLoco.seq.phase, 0, "cycle starts at its first frame after a link");
  em.tick(0.01);
  assert.ok(partY(inst) >= 400 && partY(inst) < 404, "draw link owns the rig");
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.equal(inst._unifiedSeq, null);
  assert.ok(partY(inst) >= 20 && partY(inst) < 20 + NUM_FRAMES, "lands on the sword Ready cycle");
  em.dispose();
});

test("cast gesture is a substate: raise link, held arms-out cycle, recoil link on Ready", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY); // never moved: lastMotionCommand unset
  await em.setMotion(inst.guid, MAGIC_BLAST & 0xffff, 0x49, 2.0); // bare low16, CastSpeed 2
  assert.equal(inst.lastMotionCommand, MAGIC_BLAST, "gesture expanded + remembered as the substate");
  const raise = inst._unifiedSeq;
  assert.ok(raise && raise.clearOnDone, "Ready→gesture link playing");
  assert.equal(raise.speed, 2.0, "raise plays at the gesture's speed");
  em.tick(0.01);
  assert.ok(partY(inst) >= 200 && partY(inst) < 204);
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.equal(inst._unifiedSeq, null);
  assert.equal(partY(inst), 150, "HOLDS the gesture cycle (arms out), not Ready");
  await em.setMotion(inst.guid, READY, 0x49, 1.0);
  assert.ok(inst._unifiedSeq, "gesture→Ready recoil link playing");
  assert.equal(inst._unifiedSeq.speed, 1.0);
  em.tick(0.01);
  assert.ok(partY(inst) >= 250 && partY(inst) < 254);
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "back on Ready");
  em.dispose();
});

test("an action's speed scales its link only, not the following cycle", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, READY, NONCOMBAT, 1.0);
  await em.setMotion(inst.guid, POWERUP1, 0x49, 2.0);
  // setMotion's action branch does not await the link; let it land.
  for (let i = 0; i < 5 && !inst._unifiedSeq; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.equal(inst._unifiedSeq?.speed, 2.0, "windup link at CastSpeed");
  assert.equal(inst._motionSpeed, 1.0, "cycle speed untouched");
  em.dispose();
});

// 2026-10-05 regression (fb58331a "cast gestures are held substates"): drive
// the EXACT command stream ACE sends a remote observer for a non-PK war spell
// (Player_Magic.cs DoWindupGestures / DoCastGesture / FinishCast; wasm
// session/messages/position.rs): each windup is KIND_MOTION(0) (the action
// forward command is filtered to 0) + KIND_MOTION_ACTION(full windup) at
// CastSpeed 2.0; the final gesture is KIND_MOTION(bare 0x2B) at 2.0; then
// KIND_MOTION(bare Ready 0x0003) at 1.0 ~0.35 s later. The gesture's bake is
// cold, so the Ready lands while it is still in flight.
test("war-spell cast from the wire: a Ready during a cold gesture bake keeps raise + recoil", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, READY, 0x49, 1.0); // in Magic stance, idle
  // Windup: KIND_MOTION(0) then KIND_MOTION_ACTION(MagicPowerUp01).
  em.setMotion(inst.guid, 0, 0x49, 2.0);
  em.setMotion(inst.guid, POWERUP1, 0x49, 2.0);
  for (let i = 0; i < 5 && !inst._unifiedSeq; i += 1) await new Promise((r) => setTimeout(r, 1));
  em.tick(0.01);
  assert.ok(partY(inst) >= 950 && partY(inst) < 954, "windup plays");
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  gestureDelayMs = 30;
  try {
    const g = em.setMotion(inst.guid, MAGIC_BLAST & 0xffff, 0x49, 2.0);
    await new Promise((r) => setTimeout(r, 5));
    const r = em.setMotion(inst.guid, 0x0003, 0x49, 1.0); // FinishCast Ready (bare)
    await Promise.all([g, r]);
  } finally {
    gestureDelayMs = 0;
  }
  em.tick(0.01);
  assert.ok(partY(inst) >= 200 && partY(inst) < 204, "Ready->MagicBlast raise plays (not lost to the Ready)");
  let sawRecoil = false;
  for (let i = 0; i < 20; i += 1) {
    em.tick(0.02);
    const y = partY(inst);
    if (y >= 250 && y < 254) sawRecoil = true;
  }
  assert.ok(sawRecoil, "MagicBlast->Ready recoil link plays (full-key lookup)");
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "back on the Magic Ready cycle");
  assert.equal(inst.lastMotionCommand, 0x0003, "substate memory is Ready again");
  em.dispose();
});

test("local caster: setLocalStance's bare Ready after a held gesture plays the recoil", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  await em.setMotion(inst.guid, READY, 0x49, 1.0);
  await em.setMotion(inst.guid, MAGIC_BLAST & 0xffff, 0x49, 2.0);
  for (let i = 0; i < 10; i += 1) em.tick(0.05);
  assert.equal(partY(inst), 150, "holding the gesture");
  em.setLocalStance(inst.guid, 0x49); // loop.js skip-branch for the local Ready echo
  for (let i = 0; i < 5 && !inst._unifiedSeq; i += 1) await new Promise((r) => setTimeout(r, 1));
  em.tick(0.01);
  assert.ok(partY(inst) >= 250 && partY(inst) < 254, "recoil link from the bare local Ready");
  em.dispose();
});
