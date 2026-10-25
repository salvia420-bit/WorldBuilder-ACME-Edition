// tests/drone_entities_seam.test.mjs
//
// WHY: Drone Deploy's three gestures play as JS-built clips on THE motion
// playhead through the additive entities.js seam `playLocalClip` /
// `stopLocalClip` (SPEC §6.1). The playhead is shared with every server gesture,
// door, death hold and the J5 pending queue, so a mistake here is a wedged or
// NaN-posed rig, a double-freed wasm MotionSequence, a corpse that stands up, a
// server emote freed by the drone, or a clip that never hands back to the
// locomotion cycle. This suite runs the REAL EntityManager (same mocks and
// import order as tests/unified_motion_authority.test.mjs: import entities.js,
// THEN installFakeMotionSequence()) and pins:
//   S1 the installed record is exactly {seq, desc, clearOnDone: true, hooks: [],
//      lastHookTime: -1, speed: 1, localClip: true}: no `inPlace`, a non-cyclic
//      seq, no bake fetch;
//   S2 the previous one-shot and the pending queue are freed exactly once, queue null;
//   S3 the tick poses the RAW frames (a common drift is kept, not removed in place),
//      then hands back to the unchanged `_unifiedLoco`;
//   S4 setMotion never cuts a clearOnDone clip (the new cycle commits behind it);
//   S5 `holdFinal` latches the last frame until the next setMotion (even a deduped
//      Ready) cuts it;
//   S6 `speed` scales the playhead (invalid → 1);
//   S7 refusals (unknown guid, part-count / frames mismatch, death hold, disposed)
//      and `stopLocalClip` (false for a non-local record, idempotent, drops the tail);
//   S8 FakeMotionSequence.doubleFrees === 0 over the whole suite;
//   S9 the real scene3d/drone/gestures.js driver end to end on a 34-part rig: the
//      fixture Cry clip poses the retail frames, its event and end are reported
//      once each, a despawn / respawn reports rigChanged.
//
// Flag: ?drone (DEFAULT ON since 2026-10-25, ?drone=off disables it) — only scene3d/drone/ calls the seam.
// Run from apps/holtburger-web/: node tests/drone_entities_seam.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { EntityManager } from "../scene3d/entities.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";
import { buildClip, createGestureDriver, GESTURE_CLIPS } from "../scene3d/drone/gestures.js";

const MS = installFakeMotionSequence();

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

// ---------------------------------------------------------------------------
// mocks (tests/unified_motion_authority.test.mjs's, with a 34-part human setup)
// ---------------------------------------------------------------------------

const SMALL_SETUP = 0x02000777; // a 3-part test rig
const HUMAN_SETUP = 0x02000001; // the 34-part humanoid rig (fixtures/drone/rig-table.json)
const partsOf = (setupId) => ((setupId >>> 0) === HUMAN_SETUP ? 34 : 3);
const NUM_FRAMES = 8;
const FRAMERATE = 30;
const READY = 0x41000003;
const WALK = 0x45000005;
const GESTURE = 0x10000087;

// Baked cycle frames tagged in the raw part quaternion (qy = clip id / 1000,
// qx = frame / 100), so `partY(inst)` = clip id + frame of what is posed now.
function frames(yOffset, n, partCount) {
  const flat = new Float32Array(n * partCount * 7);
  for (let f = 0; f < n; f += 1) {
    for (let p = 0; p < partCount; p += 1) {
      const b = (f * partCount + p) * 7;
      flat[b] = p;
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
function yFor(cmd, from) {
  const low = cmd & 0xffff;
  if (from) return low === 0x87 ? 900 : null; // Ready→gesture link only
  if (low === 0x03) return 10;
  if (low === 0x05) return 50;
  return null;
}

const ANIMS = JSON.parse(readFileSync(new URL("../fixtures/drone/anims.json", import.meta.url), "utf8"));
const hex8 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

const fetches = [];
const wasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    fetches.push({ cmd: cmd >>> 0, from: fromMotion >>> 0 });
    const pc = partsOf(setupId);
    const y = yFor(cmd >>> 0, fromMotion >>> 0);
    const meshes = Array.from({ length: pc }, (_, p) => partMesh(p));
    const n = y == null ? 0 : (fromMotion ? 4 : NUM_FRAMES);
    return {
      partCount: pc, numFrames: n, framerate: n ? FRAMERATE : 0, resolvedStance: stance || 0x3d,
      partFrames: n ? frames(y, n, pc) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetch_surfaces_pixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  // the human Setup's holding table (RightHand on part 15, LeftHand on part 12)
  async fetchSetupHoldingLocations(setupId) {
    if ((setupId >>> 0) !== HUMAN_SETUP) return null;
    const e = (locationKey, partId) => ({ locationKey, partId, ox: 0.025, oy: 0, oz: -0.076, qw: 0.707107, qx: 0.707107, qy: 0, qz: 0, free() {} });
    return { takeLocations: () => [e(1, 15), e(2, 12)], free() {} };
  },
  // retail Animation frames from the DAT fixture (AnimationJs shape)
  animFetches: 0,
  async fetchAnimation(did) {
    wasmExports.animFetches += 1;
    const a = ANIMS.anims[hex8(did)];
    if (!a) throw new Error("DAT miss");
    return { numFrames: a.numFrames, numParts: a.numParts, flags: 0, frames: Float32Array.from(a.frames), free() {} };
  },
};

let nextGuid = 0x50000101;
function makeManager() {
  return new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
}
async function spawn(em, motionCommand, extra = {}) {
  const guid = extra.guid ?? nextGuid++;
  return em.spawn({
    guid, modelId: SMALL_SETUP, mtableId: 0x09000001,
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

/**
 * A JS clip for a `partCount`-part rig, built by the REAL gestures.js buildClip
 * from a synthetic Animation: source frame f carries a COMMON drift (every part
 * at y = 0.1·f + p) and the tag qy = 0.777, qx = f/100 (partY = 777 + f).
 */
function syntheticClip(partCount = 3, numFrames = 10, plan = [{ from: 0, to: numFrames - 1 }]) {
  const src = new Float32Array(numFrames * partCount * 7);
  for (let f = 0; f < numFrames; f += 1) {
    for (let p = 0; p < partCount; p += 1) {
      const b = (f * partCount + p) * 7;
      src[b] = 0.25 * p; src[b + 1] = 0.1 * f + p; src[b + 2] = 0.5;
      src[b + 3] = 1; src[b + 4] = f / 100; src[b + 5] = 0.777;
    }
  }
  return buildClip({ did: 0x03007777, numFrames, numParts: partCount, frames: src }, plan);
}
const swingHandle = () => {
  window.__sessionHandle = {
    lookupMotionLinkForSwing: () => ({ kind: "swing", animId: 1, durationSec: 4 / FRAMERATE, resolvedCommand: GESTURE }),
  };
};

// ---------------------------------------------------------------------------
// S1–S7
// ---------------------------------------------------------------------------

check("S1 playLocalClip installs exactly {seq, desc, clearOnDone: true, hooks: [], lastHookTime: -1, speed: 1, localClip: true}", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  const desc = syntheticClip();
  assert.equal(desc.posFrames, null);
  const f0 = fetches.length;
  const built0 = MS.built;
  assert.equal(em.playLocalClip(inst.guid, desc), true);
  const rec = inst._unifiedSeq;
  assert.deepEqual(Object.keys(rec).sort(), ["clearOnDone", "desc", "hooks", "lastHookTime", "localClip", "seq", "speed"]);
  assert.equal(rec.desc, desc);
  assert.equal(rec.clearOnDone, true);
  assert.deepEqual(rec.hooks, []);
  assert.equal(rec.lastHookTime, -1);
  assert.equal(rec.speed, 1);
  assert.equal(rec.localClip, true);
  assert.equal("inPlace" in rec, false, "no inPlace: poseRigAt writes the raw part frames");
  assert.ok(rec.seq instanceof MS);
  assert.equal(rec.seq.cyclic, false, "one-shot sequence");
  assert.equal(rec.seq.numFrames, 10);
  assert.equal(rec.seq.framerate, 30);
  assert.equal(rec.seq.duration, 10 / 30);
  assert.equal(MS.built, built0 + 1);
  assert.equal(fetches.length, f0, "no bake, no MotionTable lookup");
  assert.equal(inst._unifiedQueue ?? null, null);
  em.dispose();
});

check("S2 the previous one-shot and the pending queue are freed exactly once; the queue is null", async () => {
  const em = makeManager();
  swingHandle();
  try {
    const inst = await spawn(em, READY);
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d });
    const a = inst._unifiedSeq;
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d, speed: 2 });
    assert.equal(inst._unifiedSeq, a, "a server gesture on the playhead");
    assert.equal(inst._unifiedQueue.list.length, 2, "and one queued behind it");
    const b = inst._unifiedQueue.list[1].payload;
    const freed0 = MS.freed;
    const dbl0 = MS.doubleFrees;
    assert.equal(em.playLocalClip(inst.guid, syntheticClip()), true);
    assert.equal(a.seq.__wbg_ptr, 0, "the previous one-shot freed");
    assert.equal(b.seq.__wbg_ptr, 0, "the queued tail freed");
    assert.equal(MS.freed - freed0, 2, "exactly once each");
    assert.equal(MS.doubleFrees, dbl0);
    assert.equal(inst._unifiedQueue, null);
    assert.equal(inst._unifiedSeq.localClip, true);
    for (let i = 0; i < 20; i += 1) em.tick(0.05);
    assert.equal(MS.doubleFrees, dbl0, "nothing freed twice later either");
  } finally {
    delete window.__sessionHandle;
    em.dispose();
  }
});

check("S3 the tick poses the RAW frames (common drift kept), then hands back to the unchanged _unifiedLoco", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  const loco = inst._unifiedLoco;
  const desc = syntheticClip();
  em.playLocalClip(inst.guid, desc);
  em.tick(0.11); // t = 0.11 s → clip frame 3
  assert.equal(partY(inst), 777 + 3, "clip frame 3 is posed");
  for (let p = 0; p < 3; p += 1) {
    const b = (3 * 3 + p) * 7;
    assert.deepEqual(inst.parts[p].position.toArray(), [desc.partFrames[b], desc.partFrames[b + 1], desc.partFrames[b + 2]],
      `part ${p} at the raw frame (the common 0.3 m drift is not removed in place)`);
  }
  for (let i = 0; i < 10 && inst._unifiedSeq; i += 1) em.tick(0.05);
  assert.equal(inst._unifiedSeq, null, "a clearOnDone clip clears itself at the end");
  assert.equal(inst._unifiedLoco, loco, "the locomotion cycle record is untouched");
  assert.notEqual(loco.seq.__wbg_ptr, 0);
  em.tick(0.01);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, `back on the Ready cycle (${partY(inst)})`);
  em.dispose();
});

check("S4 setMotion never cuts a clearOnDone clip; the new cycle commits behind it", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  em.playLocalClip(inst.guid, syntheticClip());
  const rec = inst._unifiedSeq;
  await em.setMotion(inst.guid, WALK, 0x3d);
  await em.setMotion(inst.guid, READY, 0x3d);
  await em.setMotion(inst.guid, WALK, 0x3d);
  assert.equal(inst._unifiedSeq, rec, "the clip keeps the playhead");
  assert.notEqual(rec.seq.__wbg_ptr, 0);
  em.tick(0.11);
  assert.equal(partY(inst), 777 + 3, "the clip still owns the rig");
  for (let i = 0; i < 10 && inst._unifiedSeq; i += 1) em.tick(0.05);
  em.tick(0.01);
  assert.ok(partY(inst) >= 50 && partY(inst) < 50 + NUM_FRAMES, `the walk cycle plays after the clip (${partY(inst)})`);
  em.dispose();
});

check("S5 holdFinal latches the last frame until the next setMotion — even a deduped Ready — cuts it", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  assert.equal(em.playLocalClip(inst.guid, syntheticClip(), { holdFinal: true }), true);
  const rec = inst._unifiedSeq;
  assert.equal(rec.clearOnDone, false);
  for (let i = 0; i < 20; i += 1) em.tick(0.05);
  assert.equal(inst._unifiedSeq, rec, "held past the end");
  assert.equal(partY(inst), 777 + 9, "on the final frame");
  await em.setMotion(inst.guid, READY, 0x3d); // already on Ready: deduped as a cycle, still a setMotion
  assert.equal(inst._unifiedSeq, null, "cut");
  assert.equal(rec.seq.__wbg_ptr, 0, "and freed");
  em.tick(0.01);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES);
  em.dispose();
});

check("S6 speed scales the playhead; invalid speeds fall back to 1", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  em.playLocalClip(inst.guid, syntheticClip(), { speed: 2 });
  assert.equal(inst._unifiedSeq.speed, 2);
  em.tick(0.05);
  assert.ok(Math.abs(inst._unifiedSeq.seq.t - 0.1) < 1e-12, "2× the tick");
  assert.equal(partY(inst), 777 + 3);
  em.playLocalClip(inst.guid, syntheticClip(), { speed: 1.5 });
  em.tick(0.1);
  assert.ok(Math.abs(inst._unifiedSeq.seq.t - 0.15) < 1e-12, "the quick-deploy 1.5×");
  for (const bad of [0, -1, NaN, Infinity, "x", null]) {
    em.playLocalClip(inst.guid, syntheticClip(), { speed: bad });
    assert.equal(inst._unifiedSeq.speed, bad === null ? 1 : 1, `speed ${bad} → 1`);
  }
  em.dispose();
});

check("S7 refusals: unknown guid, part-count / frames mismatch, empty clip, no desc, death hold, disposed instance", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  const built0 = MS.built;
  assert.equal(em.playLocalClip(0x5fffffff, syntheticClip()), false, "unknown guid");
  assert.equal(em.playLocalClip(inst.guid, syntheticClip(34)), false, "34-part clip on a 3-part rig");
  const short = syntheticClip();
  assert.equal(em.playLocalClip(inst.guid, { ...short, partFrames: short.partFrames.subarray(1) }), false, "frames length");
  assert.equal(em.playLocalClip(inst.guid, { ...short, numFrames: 0 }), false, "no frames");
  assert.equal(em.playLocalClip(inst.guid, { ...short, partFrames: null }), false);
  assert.equal(em.playLocalClip(inst.guid, null), false, "no desc");
  assert.equal(MS.built, built0, "no sequence built for a refusal");
  // a death hold is sticky (CQ-06)
  const hold = { seq: MS.fromDescriptor(4, 30, 4 / 30, null, null, null, false), desc: short, clearOnDone: false, deathHold: true, hooks: [], lastHookTime: -1 };
  inst._unifiedSeq = hold;
  assert.equal(em.playLocalClip(inst.guid, syntheticClip()), false, "death hold");
  assert.equal(inst._unifiedSeq, hold);
  assert.notEqual(hold.seq.__wbg_ptr, 0, "the death hold is untouched");
  assert.equal(em.stopLocalClip(inst.guid), false, "never frees a death hold");
  assert.equal(inst._unifiedSeq, hold);
  inst._unifiedSeq = null;
  hold.seq.free();
  inst._disposed = true;
  assert.equal(em.playLocalClip(inst.guid, syntheticClip()), false, "disposed instance");
  inst._disposed = false;
  em.dispose();
});

check("S7 stopLocalClip: frees our clip and drops the pending tail; false for a server gesture; idempotent", async () => {
  const em = makeManager();
  swingHandle();
  try {
    const inst = await spawn(em, READY);
    const loco = inst._unifiedLoco;
    em.playLocalClip(inst.guid, syntheticClip());
    const rec = inst._unifiedSeq;
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d }); // queues behind the clearOnDone clip
    assert.equal(inst._unifiedSeq, rec);
    const queued = inst._unifiedQueue?.list?.[0]?.payload;
    assert.ok(queued && queued !== rec, "a server gesture waits behind the clip");
    const dbl0 = MS.doubleFrees;
    assert.equal(em.stopLocalClip(inst.guid), true);
    assert.equal(rec.seq.__wbg_ptr, 0);
    assert.equal(queued.seq.__wbg_ptr, 0, "the pending tail is dropped");
    assert.equal(inst._unifiedSeq, null);
    assert.equal(inst._unifiedQueue, null);
    assert.equal(MS.doubleFrees, dbl0);
    assert.equal(em.stopLocalClip(inst.guid), false, "idempotent");
    em.tick(0.01);
    assert.equal(inst._unifiedLoco, loco);
    assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "the tick poses the loco cycle");
    // a server gesture on the playhead is never ours to free
    await em.setSwingMotion(inst.guid, GESTURE, { stance: 0x3d });
    const server = inst._unifiedSeq;
    assert.ok(server && server.localClip !== true);
    assert.equal(em.stopLocalClip(inst.guid), false);
    assert.equal(inst._unifiedSeq, server);
    assert.notEqual(server.seq.__wbg_ptr, 0);
    assert.equal(em.stopLocalClip(0x5fffffff), false, "unknown guid");
    // Let the server gesture finish before em.dispose(): EntityInstance.dispose()
    // frees a J5 one-shot twice when it is both the playhead and the queue head
    // (pre-existing, no drone code involved), which S8 would count.
    for (let i = 0; i < 20 && inst._unifiedSeq; i += 1) em.tick(0.05);
    assert.equal(inst._unifiedSeq, null);
  } finally {
    delete window.__sessionHandle;
    em.dispose();
  }
});

// ---------------------------------------------------------------------------
// S9 the real gestures driver end to end
// ---------------------------------------------------------------------------

check("S9 gestures.js on a 34-part rig: the fixture Cry clip poses the retail frames; event at clip frame 14 and end reported once", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY, { modelId: HUMAN_SETUP });
  assert.equal(inst.parts.length, 34);
  const g = createGestureDriver({ entityManager: em, wasm: wasmExports, guid: inst.guid });
  const r = await g.ready();
  assert.equal(r.profile.kind, "humanoid", "holding table → humanoid");
  assert.deepEqual(r.clips, { pack: true, place: true, goggles: true });
  assert.deepEqual(g.clip("goggles", 1), { ok: true, mode: "clip", name: "goggles" });
  const rec = inst._unifiedSeq;
  assert.equal(rec.localClip, true);
  const src = Float32Array.from(ANIMS.anims[hex8(GESTURE_CLIPS.goggles.anim)].frames);
  const dt = 1 / 30;
  let eventPolls = 0;
  let donePolls = 0;
  let eventAt = -1;
  let checkedPose = false;
  for (let i = 0; i < 80; i += 1) {
    em.tick(dt + 1e-6);
    const p = g.poll(dt);
    if (p.event) {
      eventPolls += 1;
      eventAt = i;
      // the rig shows the retail Cry frame (source = clip frame for the first half)
      const f = rec.seq.globalFrameIndex;
      assert.ok(f >= 14, `event at the event frame (${f})`);
      const sf = rec.desc.sourceFrames[f];
      for (const part of [12, 15, 16]) {
        const b = (sf * 34 + part) * 7;
        assert.deepEqual(inst.parts[part].position.toArray(), [src[b], src[b + 1], src[b + 2]], `part ${part} at retail frame ${sf}`);
        const q = inst.parts[part].quaternion;
        assert.deepEqual([q.w, q.x, q.y, q.z], [src[b + 3], src[b + 4], src[b + 5], src[b + 6]]);
      }
      checkedPose = true;
    }
    if (p.done) { donePolls += 1; break; }
  }
  assert.equal(eventPolls, 1);
  assert.equal(donePolls, 1);
  assert.equal(eventAt, 13, "reported on the poll right after the 14th tick reached clip frame 14");
  assert.ok(checkedPose);
  assert.equal(inst._unifiedSeq, null, "handed back");
  em.tick(0.01);
  assert.ok(partY(inst) >= 10 && partY(inst) < 10 + NUM_FRAMES, "on the Ready cycle again");
  g.dispose();
  em.dispose();
});

check("S9 a despawn / respawn under a running clip reports done + rigChanged; nothing is double-freed", async () => {
  const em = makeManager();
  const guid = 0x50000999;
  const inst = await spawn(em, READY, { modelId: HUMAN_SETUP, guid });
  const g = createGestureDriver({ entityManager: em, wasm: wasmExports, guid });
  await g.ready();
  g.clip("pack", 1.5);
  const rec = inst._unifiedSeq;
  em.tick(0.1);
  assert.equal(g.poll(0.1).done, false);
  const dbl0 = MS.doubleFrees;
  em.remove(guid);
  assert.equal(rec.seq.__wbg_ptr, 0, "the despawn freed the clip");
  const fresh = await spawn(em, READY, { modelId: HUMAN_SETUP, guid });
  assert.notEqual(fresh, inst);
  const p = g.poll(0.016);
  assert.equal(p.done, true);
  assert.equal(p.rigChanged, true);
  g.rebind(fresh);
  assert.equal(g.poll(0.016).done, false, "already reported");
  assert.equal(g.stop(), false, "nothing of ours on the new rig");
  assert.equal(MS.doubleFrees, dbl0);
  // the rebound driver plays on the new instance
  assert.equal(g.clip("place").mode, "clip");
  assert.equal(fresh._unifiedSeq.localClip, true);
  g.dispose();
  assert.equal(fresh._unifiedSeq, null, "dispose stops it");
  em.dispose();
});

check("S8 FakeMotionSequence.doubleFrees === 0 over the whole suite", () => {
  assert.equal(MS.doubleFrees, 0);
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`drone_entities_seam: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
