// tests/unified_hook_drain.test.mjs — the playhead's animation-hook drain
// (`?hookFrameExit`, 2026-10-08) on the REAL EntityManager.
//
// Retail CSequence::update_internal (acclient.c:340659-340776): a frame's
// hooks fire when the playhead LEAVES it, a segment's last frame never fires
// going forward, frame 0 fires on every loop, repositioning the playhead
// fires nothing, and a cycle played backward fires the Both/Backward hooks of
// each frame it leaves (never a segment's first frame).
//
//   H1  a cycle's frame-0 hook fires every loop; its last frame never fires
//   H2  a hook fires when its frame is LEFT, not when it is entered
//   H3  a phase-carried walk→run swap fires nothing on the swap tick
//   H4  a backstep fires Both/Backward hooks per frame left, and the resume
//       forward does not burst
//   H5  a one-shot fires frames 0..n-2 once each; payloads keep frame times
//   H6  the end-of-tick queue: hooks fire after the pose, a throwing hook
//       does not drop the rest (the contract the retired
//       test_hook_fire_queue.mjs pinned on a replica)
//   H7  `_hookFrameExitOn = false` restores the legacy frame-entry drain
//
// `window.location` is stubbed BEFORE entities.js loads, so its module flags
// read their browser defaults (the queued `?hookDrain` path included).
//
// Run: node tests/unified_hook_drain.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { search: "" } };
const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

const PART_COUNT = 3;
const FPS = 30;
const N = 8; // frames per clip: 0.2667 s a loop
const READY = 0x41000003;
const WALK = 0x45000005;
const RUN = 0x44000007;
const ONESHOT = 0x10000058;
const CLIP_ID = { [READY]: 10, [WALK]: 50, [RUN]: 100, [ONESHOT]: 200 };
// cmd → [{ frame, direction }] — read at bake time; `setup` installs them.
const HOOKS = new Map();

function partFrames(id) {
  const flat = new Float32Array(N * PART_COUNT * 7);
  for (let f = 0; f < N; f += 1) {
    for (let p = 0; p < PART_COUNT; p += 1) {
      const b = (f * PART_COUNT + p) * 7;
      flat[b] = p;
      flat[b + 3] = 1; flat[b + 4] = f / 100; flat[b + 5] = id / 1000;
    }
  }
  return flat;
}
const posedFrame = (inst) => Math.round(inst.parts[0].quaternion.x * 100);

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

// The real bake's shape: per-frame START times, one segment, and each hook
// stamped with its frame's start time (lib.rs `time_in_clip_s: frame_time`).
// No links exist, so every cycle swap carries phase.
const wasmExports = {
  async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
    cmd >>>= 0;
    const id = fromMotion >>> 0 ? null : CLIP_ID[cmd];
    const n = id == null ? 0 : N;
    const ft = Float32Array.from({ length: n }, (_, f) => f / FPS);
    const hooks = n ? (HOOKS.get(cmd) || []).map(({ frame, direction = 0 }) => ({
      timeInClipS: ft[frame], hookType: 3 /* Attack: emits combatStrikeFrame */, direction,
    })) : [];
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    return {
      partCount: PART_COUNT,
      numFrames: n,
      framerate: n ? FPS : 0,
      duration: n / FPS,
      frameTimes: ft,
      segmentStarts: n ? Uint32Array.of(0) : new Uint32Array(0),
      segmentCounts: n ? Uint32Array.of(n) : new Uint32Array(0),
      resolvedStance: stance || 0x3d,
      partFrames: n ? partFrames(id) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
      takeHooks() { return hooks; },
    };
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
};

// Every hook that actually fired (past `_fireHook`'s direction gate): the
// Attack arm emits `combatStrikeFrame` with the hook's time-in-clip.
let strikes = [];
window.__pluginClient = {
  events: { emit(name, p) { if (name === "combatStrikeFrame") strikes.push(p); } },
};

let nextGuid = 0x50000101;
async function setup(hooks, { legacy = false } = {}) {
  HOOKS.clear();
  for (const [cmd, list] of hooks) HOOKS.set(cmd, list);
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  if (legacy) em._hookFrameExitOn = false;
  // Log each fired hook with its frame, playback direction and the frame posed
  // when it fired.
  const log = [];
  const fire = em._fireHook;
  em._fireHook = function (inst, hook, a, c, dir) {
    const before = strikes.length;
    const r = fire.call(this, inst, hook, a, c, dir);
    if (strikes.length > before) {
      log.push({ frame: Math.round(strikes[strikes.length - 1].hookTimeInClipS * FPS), dir: dir ?? 1, posed: posedFrame(inst) });
    }
    return r;
  };
  const inst = await em.spawn({
    guid: nextGuid++, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
  strikes = [];
  return { em, inst, log };
}
const frames = (log) => log.map((e) => e.frame);
const ticks = (em, n, dt = 0.02) => { for (let i = 0; i < n; i += 1) em.tick(dt); };

test("H1 a cycle's frame-0 hook fires every loop; its last frame never fires", async () => {
  const { em, log } = await setup([[READY, [{ frame: 0 }, { frame: N - 1 }]]]);
  ticks(em, 37); // 0.74 s: frame 1 is entered in loops 1, 2 and 3
  assert.deepEqual(frames(log), [0, 0, 0], `fired ${frames(log)}`);
  em.dispose();
});

test("H2 a hook fires when its frame is LEFT, not when it is entered", async () => {
  const { em, log } = await setup([[READY, [{ frame: 2 }]]]);
  ticks(em, 4); // t = 0.08 → on frame 2
  assert.equal(log.length, 0, "entering frame 2 fires nothing");
  ticks(em, 1); // t = 0.10 → frame 3
  assert.deepEqual(frames(log), [2], "leaving frame 2 fires it");
  em.dispose();
});

test("H3 a phase-carried walk → run swap fires nothing on the swap tick", async () => {
  const every = Array.from({ length: N }, (_, f) => ({ frame: f }));
  const { em, inst, log } = await setup([[WALK, every], [RUN, every]]);
  await em.setMotion(inst.guid, WALK, 0x3d);
  ticks(em, 5); // t = 0.10 → walk frame 3
  log.length = 0;
  await em.setMotion(inst.guid, RUN, 0x3d); // no link → phase carried
  assert.equal(inst._unifiedLoco.seq.globalFrameIndex, 3, "run landed on the carried frame");
  ticks(em, 1); // t = 0.12, still frame 3
  assert.equal(log.length, 0, `no burst of frames 0..3 (fired ${frames(log)})`);
  ticks(em, 1); // t = 0.14 → frame 4
  assert.deepEqual(frames(log), [3], "the carried frame fires when it is left");
  em.dispose();
});

test("H4 a backstep fires Both/Backward hooks per frame left; the resume forward does not burst", async () => {
  const { em, inst, log } = await setup([[WALK, [
    { frame: 2, direction: 1 }, { frame: 3, direction: 0 }, { frame: 5, direction: -1 },
  ]]]);
  await em.setMotion(inst.guid, WALK, 0x3d);
  ticks(em, 7); // t = 0.14 → frame 4 (frames 2 and 3 fired going forward)
  assert.deepEqual(log.map((e) => [e.frame, e.dir]), [[2, 1], [3, 1]]);
  log.length = 0;
  inst._motionSpeedSign = -1; // backstep: the cycle runs backward
  ticks(em, 5); // t = 0.04 → frame 1: left 4, 3, 2
  assert.deepEqual(log.map((e) => [e.frame, e.dir]), [[3, -1]],
    "Both hook fires backward; the Forward-only hook does not");
  ticks(em, 5); // t = 0.2267 → frame 6 via the wrap: left 1, (0 never), 7
  assert.deepEqual(log.map((e) => e.frame), [3], "frame 0 (low) and 7 carry no hooks");
  ticks(em, 2); // → frame 5
  ticks(em, 2); // → frame 4: left 5
  assert.deepEqual(log.map((e) => [e.frame, e.dir]), [[3, -1], [5, -1]], "Backward hook fires backward");
  log.length = 0;
  inst._motionSpeedSign = 1;
  em.tick(0.005); // forward again, same frame
  assert.equal(log.length, 0, "turning forward replays nothing");
  em.dispose();
});

test("H5 a one-shot fires frames 0..n-2 once each; payloads keep frame times", async () => {
  const { em, inst, log } = await setup([[ONESHOT, Array.from({ length: N }, (_, f) => ({ frame: f }))]]);
  assert.ok(await em._tryUnifiedCycleOneShot(inst.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  ticks(em, 20); // 0.4 s > 0.2667 s: done, handed back
  assert.equal(inst._unifiedSeq ?? null, null, "one-shot finished");
  assert.deepEqual(frames(log), [0, 1, 2, 3, 4, 5, 6], `fired ${frames(log)}`);
  assert.ok(strikes.every((p) => Math.abs(p.hookTimeInClipS * FPS - Math.round(p.hookTimeInClipS * FPS)) < 1e-4),
    "hookTimeInClipS is the hook's own frame start");
  em.dispose();
});

test("H6 queued hooks fire after the pose; a throwing hook does not drop the rest", async () => {
  const hooks = [[READY, [{ frame: 0 }, { frame: 1 }]]];
  const { em, log } = await setup(hooks);
  em.tick(0.07); // 0 → frame 2 in one tick: frames 0 and 1 cross together
  assert.deepEqual(log.map((e) => [e.frame, e.posed]), [[0, 2], [1, 2]],
    "both fire at the end of the tick, with the rig already on frame 2");
  const { em: em2, log: log2 } = await setup(hooks);
  const fire = em2._fireHook;
  let threw = 0;
  em2._fireHook = function (inst, hook, a, c, dir) {
    if (Math.round((hook.frameTime ?? hook.time) * FPS) === 0) { threw += 1; throw new Error("hook threw"); }
    return fire.call(this, inst, hook, a, c, dir);
  };
  em2.tick(0.07);
  assert.equal(threw, 1);
  assert.deepEqual(frames(log2), [1], "the record after the throw still fired");
  em.dispose();
  em2.dispose();
});

test("H7 `_hookFrameExitOn = false` restores the legacy frame-entry drain", async () => {
  const { em, log } = await setup([[READY, [{ frame: 0 }, { frame: N - 1 }]]], { legacy: true });
  ticks(em, 37);
  // Legacy: frame 0 fires on entry once (never again after the wrap), and the
  // last frame fires on entry every loop.
  assert.deepEqual(frames(log), [0, N - 1, N - 1], `fired ${frames(log)}`);
  em.dispose();
});
