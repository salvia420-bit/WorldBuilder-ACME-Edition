// tests/turn_left_reverse.test.mjs — retail `CMotionInterp::adjust_motion`
// (acclient.c:343746): TurnLeft is played as TurnRight at NEGATED speed, so a
// left turn steps the right-turn cycle in reverse. Before 2026-10-07 the
// setMotion boundary folded the command but kept the speed positive, so a
// left turn stepped the right-turn footwork.
//
// entities.js reads `?signedMotionSpeed` (default ON) at module load, so this
// file gives it a browser-like `window.location` BEFORE importing it.
//
// Run: node tests/turn_left_reverse.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
// With a `window`, two scene3d modules poll for the plugin bus for 30 s;
// mark them bound so the run exits promptly.
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

const PART_COUNT = 2;
const READY = 0x41000003;
const TURN_RIGHT = 0x6500000d;
const TURN_LEFT = 0x6500000e;

function clip(n) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let i = 0; i < n * PART_COUNT; i += 1) flat[i * 7 + 3] = 1;
  return flat;
}
const wasmExports = {
  async fetchEntityAnimationKeyframes(setupId, mc, tc, pal, subs, mtableId, cmd, stance, fromMotion) {
    const low = cmd & 0xffff;
    const has = !fromMotion && (low === 0x03 || low === 0x0d);
    const n = has ? 8 : 0;
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
};

async function spawnReady(em) {
  return em.spawn({
    guid: 0x50000001, modelId: 0x02000001, mtableId: 0x09000001,
    landblockId: 0xa9b40001, x: 10, y: 10, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
  });
}

test("TurnLeft plays the TurnRight cycle in reverse; TurnRight forward", async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, wasmExports);
  const inst = await spawnReady(em);
  await em.setMotion(inst.guid, TURN_LEFT, 0x3d, 1.5);
  assert.equal(inst.lastMotionCommand >>> 0, TURN_RIGHT, "TurnLeft folds to the TurnRight cycle");
  assert.equal(inst._motionSpeed, 1.5, "run-turn magnitude kept");
  assert.equal(inst._motionSpeedSign, -1, "played in reverse");
  assert.ok(em._unifiedLocoGaitScale(inst, 0) < 0, "the playhead advances backwards");

  await em.setMotion(inst.guid, TURN_RIGHT, 0x3d, 1.5);
  assert.equal(inst._motionSpeedSign, 1, "a right turn plays forward");
  assert.ok(em._unifiedLocoGaitScale(inst, 0) > 0);
  em.dispose();
});
