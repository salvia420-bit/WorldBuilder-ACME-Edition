// tests/unified_handback.test.mjs — a finished one-shot restarts the cycle
// behind it (`?cycleRestartAfterAction`, csequence-4, 2026-10-08).
//
// Retail CMotionTable::GetObjectSequence re-appends the base cycle behind every
// action (acclient.c:337854-337855); when the action's node runs out,
// advance_to_next_animation enters the NEW cycle node at get_starting_frame
// (:340567) and update_internal spends the leftover quantum on it (:340776).
// Ours froze the cycle mid-stride under the one-shot and popped back there.
//
//   R1  oneShotSpill: the unused part of the finishing step, in wall seconds
//   R2  handBackToCycle: reset, then advance the spill at the gait scale
//   R3  real EntityManager: the walk restarts at frame 0 + leftover after a
//       one-shot; `_cycleRestartOn = false` resumes the frozen phase
//   R4  a queued second one-shot keeps the cycle frozen until the last ends
//
// Run: node tests/unified_handback.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { oneShotSpill, handBackToCycle } from "../scene3d/motion/handback.js";
import { EntityManager } from "../scene3d/entities.js";
import { installFakeMotionSequence } from "../harness/lib/fake_motion_sequence.mjs";

installFakeMotionSequence();

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("R1 oneShotSpill is the leftover of the finishing step, in wall seconds", () => {
  assert.ok(near(oneShotSpill(0.35, 0.1, 0.4, 1), 0.05));
  assert.ok(near(oneShotSpill(0.35, 0.2, 0.4, 2), 0.075), "speed 2: 0.15 clip s = 0.075 wall s");
  assert.equal(oneShotSpill(0.1, 0.1, 0.4, 1), 0, "not finished → nothing spills");
  assert.equal(oneShotSpill(0.35, 0.1, 0.4, 0), 0, "no speed → nothing");
  assert.equal(oneShotSpill(0.35, 0.1, 0, 1), 0, "no duration → nothing");
});

test("R2 handBackToCycle resets, then spends the spill at the gait scale", () => {
  const calls = [];
  const seq = { reset() { calls.push("reset"); }, advance(dt) { calls.push(["advance", dt]); } };
  const lo = { seq, lastHookTime: 0.2 };
  assert.equal(handBackToCycle(lo, 0.05, 1.5), true);
  assert.equal(calls[0], "reset");
  assert.equal(calls[1][0], "advance");
  assert.ok(near(calls[1][1], 0.075));
  assert.equal(lo.lastHookTime, -1, "hook clock restarts with the cycle");

  calls.length = 0;
  assert.equal(handBackToCycle({ seq, hold: true }, 0.05, 1), false, "held state untouched");
  assert.equal(calls.length, 0);
  assert.equal(handBackToCycle({ seq }, 0.05, -1), true, "backward gait: reset only");
  assert.deepEqual(calls, ["reset"]);
  assert.equal(handBackToCycle(null, 0.05, 1), false);
});

// ---- real EntityManager -----------------------------------------------------
const PART_COUNT = 3;
const FPS = 30;
const N = 8; // 0.2667 s clips
const READY = 0x41000003;
const WALK = 0x45000005;
const ONESHOT = 0x10000058;
const CLIP_ID = { [READY]: 10, [WALK]: 50, [ONESHOT]: 200 };

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
const wasmExports = {
  async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
    const id = fromMotion >>> 0 ? null : CLIP_ID[cmd >>> 0];
    const n = id == null ? 0 : N;
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    return {
      partCount: PART_COUNT, numFrames: n, framerate: n ? FPS : 0, duration: n / FPS,
      resolvedStance: stance || 0x3d,
      partFrames: new Float32Array(n * PART_COUNT * 7).fill(0.5),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};
let nextGuid = 0x50000201;
async function walkingRig({ restart = true } = {}) {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  em._cycleRestartOn = restart;
  const inst = await em.spawn({
    guid: nextGuid++, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
  await em.setMotion(inst.guid, WALK, 0x3d);
  for (let i = 0; i < 8; i += 1) em.tick(0.02); // walk at t = 0.16 (frame 4)
  return { em, inst };
}
const oneShotEntry = (em) => em.animationCache.get(0x02000001, 0x09000001, ONESHOT, 0x3d,
  wasmExports.fetchEntityAnimationKeyframes, {});

test("R3 the cycle restarts at frame 0 with the leftover after a one-shot", async () => {
  const { em, inst } = await walkingRig();
  const lo = inst._unifiedLoco;
  assert.ok(near(lo.seq.t, 0.16));
  assert.ok(await em._tryUnifiedCycleOneShot(inst.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  for (let i = 0; i < 3; i += 1) em.tick(0.07); // one-shot at 0.21 of 0.2667
  assert.ok(near(lo.seq.t, 0.16), "cycle frozen under the one-shot");
  em.tick(0.07); // 0.28: done, 0.01333 s left over
  assert.equal(inst._unifiedSeq ?? null, null, "handed back");
  assert.ok(near(lo.seq.t, 0.28 - N / FPS), `cycle at the leftover, t=${lo.seq.t}`);
  assert.equal(lo.seq.globalFrameIndex, 0, "on the cycle's first frame");
  em.dispose();

  const legacy = await walkingRig({ restart: false });
  assert.ok(await legacy.em._tryUnifiedCycleOneShot(legacy.inst.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  for (let i = 0; i < 4; i += 1) legacy.em.tick(0.07);
  assert.ok(near(legacy.inst._unifiedLoco.seq.t, 0.16), "`=off`: resumes where it froze");
  legacy.em.dispose();
});

test("R4 a queued second one-shot keeps the cycle frozen until the last one ends", async () => {
  const { em, inst } = await walkingRig();
  const lo = inst._unifiedLoco;
  const entry = await oneShotEntry(em);
  assert.ok(em._playLinkEntry(inst, entry, READY, ONESHOT, 0x3d));
  assert.ok(em._playLinkEntry(inst, entry, READY, ONESHOT, 0x3d));
  for (let i = 0; i < 4; i += 1) em.tick(0.07); // first done, second promoted
  assert.ok(inst._unifiedSeq, "the second one-shot owns the playhead");
  assert.ok(near(lo.seq.t, 0.16), "cycle still frozen");
  for (let i = 0; i < 4; i += 1) em.tick(0.07);
  assert.equal(inst._unifiedSeq ?? null, null);
  assert.ok(lo.seq.t < 0.05, `restarted behind the last one-shot, t=${lo.seq.t}`);
  em.dispose();
});
