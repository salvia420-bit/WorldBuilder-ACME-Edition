// tests/creature_gait_retail.test.mjs — ?creatureGait (default ON): a
// SERVER-SIMULATED mover's locomotion cycle plays at framerate x speed
// (retail/ACE add_motion, acclient.c:337431), not at the humanoid
// get_state_velocity (3.12 / 4.0 m/s, acclient.c:343539) divided by its own
// clip speed. Clip speeds below are client_portal.dat MotionKinematics values
// (|sum PosFrames| / frames x framerate — the cycleBaseSpeed fallback; these
// MotionData carry no velocity): Black Rabbit mtable 0x09000062 walk 1.461 /
// run 2.922 m/s, human 0x09000001 walk 2.602 m/s.
//
// Run from apps/holtburger-web/:  node tests/creature_gait_retail.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

const PART_COUNT = 2;
const READY = 0x41000003, WALK = 0x45000005, RUN = 0x44000007;
const RABBIT_MT = 0x09000062, HUMAN_MT = 0x09000001;
const BASE = { [RABBIT_MT]: { [WALK]: 1.461, [RUN]: 2.922 }, [HUMAN_MT]: { [WALK]: 2.602, [RUN]: 4.0 } };

function clip(n) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let i = 0; i < n * PART_COUNT; i += 1) flat[i * 7 + 3] = 1;
  return flat;
}
const wasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    const low = cmd & 0xffff;
    const n = !fromMotion && (low === 0x03 || low === 0x05 || low === 0x07) ? 10 : 0;
    const meshes = Array.from({ length: PART_COUNT }, () => ({
      triCount: 1,
      positions: new Float32Array(9), uvs: new Float32Array(6), normals: new Float32Array(9),
      surfaceIndices: new Uint8Array([0]), surfaces: new Uint32Array([0x08001234]),
    }));
    return {
      partCount: PART_COUNT, numFrames: n, framerate: n ? 30 : 0,
      resolvedStance: stance || 0x3d, partFrames: n ? clip(n) : new Float32Array(0),
      takePartMeshes() { return meshes.splice(0); },
    };
  },
  async fetchEntitySurfacesPixels(dids) {
    return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
  },
  // lib.rs state_ground_speed_inner == retail CMotionInterp::get_state_velocity.
  stateGroundSpeed(fc, fs, sc, ss, rr) {
    const x = sc === 0x6500000f ? 1.25 * ss : 0;
    const y = fc === WALK ? 3.12 * fs : fc === RUN ? 4.0 * fs : 0;
    return Math.min(Math.hypot(x, y), rr * 4.0);
  },
  async cycleBaseSpeed(mtableId, stance, cmd) { return BASE[mtableId]?.[cmd] ?? 0; },
};

async function spawn(em, guid, mtableId) {
  return em.spawn({
    guid, modelId: 0x0200047b, mtableId,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 2566, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
}

test("a walking Black Rabbit (server mover) plays its walk at framerate x speed", async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  try {
    const inst = await spawn(em, 0x80001234, RABBIT_MT);
    await em.setMotion(inst.guid, WALK, 0x3d, 1.0);
    const walk = em._unifiedLocoGaitScale(inst, BASE[RABBIT_MT][WALK]);
    assert.ok(Math.abs(walk - 1.0) < 1e-9, `walk gait x${walk.toFixed(3)} (retail x1.000; humanoid velScale gave x${(3.12 / 1.461).toFixed(3)})`);
    await em.setMotion(inst.guid, RUN, 0x3d, 1.5);
    const run = em._unifiedLocoGaitScale(inst, BASE[RABBIT_MT][RUN]);
    assert.ok(Math.abs(run - 1.5) < 1e-9, `run at speed 1.5 -> x${run.toFixed(3)} (retail x1.500)`);
  } finally {
    em.dispose();
  }
});

test("a player rig keeps the velScale path (moved by player physics at 3.12 / 4.0 m/s)", async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  try {
    const inst = await spawn(em, 0x50000002, HUMAN_MT);
    await em.setMotion(inst.guid, WALK, 0x3d, 1.0);
    const g = em._unifiedLocoGaitScale(inst, BASE[HUMAN_MT][WALK]);
    assert.ok(Math.abs(g - 3.12 / 2.602) < 1e-6, `player walk gait x${g.toFixed(3)} unchanged`);
  } finally {
    em.dispose();
  }
});
