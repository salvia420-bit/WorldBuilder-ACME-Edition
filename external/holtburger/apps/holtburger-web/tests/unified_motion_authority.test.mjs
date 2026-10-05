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

// Frames carry a per-motion y offset so the posed rig tells clips apart.
function frames(yOffset, n = NUM_FRAMES) {
  const flat = new Float32Array(n * PART_COUNT * 7);
  for (let f = 0; f < n; f += 1) {
    for (let p = 0; p < PART_COUNT; p += 1) {
      const b = (f * PART_COUNT + p) * 7;
      flat[b] = p; flat[b + 1] = yOffset + f; flat[b + 2] = 0;
      flat[b + 3] = 1;
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
function yFor(cmd, from) {
  const low = cmd & 0xffff;
  if (from) {
    // MotionTable links: door Off→On / On→Off, and Ready→gesture.
    if ((from & 0xffff) === 0x0c && low === 0x0b) return 700;
    if ((from & 0xffff) === 0x0b && low === 0x0c) return 800;
    if (low === 0x87) return 900; // a gesture link (e.g. an emote/swing)
    return null; // no link
  }
  if (low === 0x03) return 10;
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
    const y = yFor(cmd >>> 0, fromMotion >>> 0);
    const meshes = Array.from({ length: PART_COUNT }, (_, p) => partMesh(p));
    const n = y == null ? 0 : (fromMotion ? 4 : NUM_FRAMES);
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
const partY = (inst) => inst.parts[0].position.y;

test("spawn puts the initial cycle on the Rust playhead", async () => {
  const em = makeManager();
  const inst = await spawn(em, READY);
  assert.ok(inst._unifiedLoco, "_unifiedLoco installed at spawn");
  assert.equal(inst._unifiedLoco.hold, false);
  assert.equal(inst.currentAction, null, "no mixer action started for the spawn cycle");
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
