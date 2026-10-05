// tests/frame_pose.test.mjs — scene3d/frame_pose.js: one getLocalPlayerPose()
// wasm crossing per tickPerFrame window, box freed immediately, fresh reads
// outside the window.
//
// Run: node tests/frame_pose.test.mjs
import assert from "node:assert/strict";
import {
  beginPoseFrame,
  endPoseFrame,
  readLocalPlayerPose,
} from "../scene3d/frame_pose.js";

function mockHandle(ptr) {
  const h = { reads: 0, frees: 0, z: 10, __wbg_ptr: ptr };
  h.getLocalPlayerPose = () => {
    h.reads += 1;
    return {
      x: 1, y: 2, z: h.z, heading: 0.5, landblockId: 0xa9b40021, isOnGround: true,
      free() { h.frees += 1; },
    };
  };
  return h;
}

// Outside a frame: every call reads + frees.
{
  const h = mockHandle(8);
  const a = readLocalPlayerPose(h);
  const b = readLocalPlayerPose(h);
  assert.equal(h.reads, 2);
  assert.equal(h.frees, 2, "box freed on every read");
  assert.deepEqual({ ...a }, { x: 1, y: 2, z: 10, heading: 0.5, landblockId: 0xa9b40021, isOnGround: true });
  assert.ok(Object.isFrozen(a) && a !== b);
}

// Inside a frame: one read shared; a Proxy of the same wasm object shares it too.
{
  const h = mockHandle(16);
  const proxy = new Proxy(h, {});
  beginPoseFrame();
  const a = readLocalPlayerPose(h);
  h.z = 99; // would only change via the async recv loop in reality
  const b = readLocalPlayerPose(proxy);
  endPoseFrame();
  assert.equal(h.reads, 1, "one wasm crossing per frame");
  assert.equal(h.frees, 1);
  assert.equal(a, b, "shared snapshot");
  // Next frame re-reads.
  beginPoseFrame();
  assert.equal(readLocalPlayerPose(h).z, 99);
  endPoseFrame();
  assert.equal(h.reads, 2);
}

// Nested windows keep the cache until the outermost closes; null poses are cached too.
{
  let reads = 0;
  const h = { getLocalPlayerPose: () => { reads += 1; return undefined; } };
  beginPoseFrame();
  beginPoseFrame();
  assert.equal(readLocalPlayerPose(h), null);
  endPoseFrame();
  assert.equal(readLocalPlayerPose(h), null);
  endPoseFrame();
  assert.equal(reads, 1);
}

// Throwing reads / missing export → null, never throws.
{
  assert.equal(readLocalPlayerPose(null), null);
  assert.equal(readLocalPlayerPose({}), null);
  assert.equal(readLocalPlayerPose({ getLocalPlayerPose() { throw new Error("x"); } }), null);
}

console.log("frame_pose: PASS");
