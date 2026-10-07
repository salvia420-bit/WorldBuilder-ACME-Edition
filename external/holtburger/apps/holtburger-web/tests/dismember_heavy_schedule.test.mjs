// tests/dismember_heavy_schedule.test.mjs — bug 16 (2026-10-07): a kill's
// carnage finisher used to run every slice/fracture in ONE task (they all
// resumed from the same cached pinata import in one microtask flush). The
// heavy ops are now serialized, one per animation frame.
//
// Run from apps/holtburger-web/:  node tests/dismember_heavy_schedule.test.mjs

import assert from "node:assert/strict";

globalThis.window = { location: { search: "" } };
// A controllable frame clock: requestAnimationFrame callbacks run only when
// the test advances a frame.
const frameQueue = [];
globalThis.requestAnimationFrame = (cb) => { frameQueue.push(cb); return frameQueue.length; };
const advanceFrame = async () => {
  const cbs = frameQueue.splice(0);
  for (const cb of cbs) cb(0);
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const dm = await import("../scene3d/dismember.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

// A rig whose part has no meshes: each op resolves null quickly, but goes
// through the scheduler like a real one.
const fakeInst = () => ({ parts: [{ children: [] }], root: { parent: {} } });

await check("three death ops queued in one tick run on three different frames", async () => {
  const inst = fakeInst();
  const done = [];
  dm.fracturePart(inst, 0, {}).then(() => done.push("a"));
  dm.slicePart(inst, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, {}).then(() => done.push("b"));
  dm.fracturePart(inst, 0, {}).then(() => done.push("c"));
  await settle();
  assert.deepEqual(done, ["a"], "only the first op runs before a frame passes");
  await advanceFrame();
  assert.deepEqual(done, ["a", "b"]);
  await advanceFrame();
  assert.deepEqual(done, ["a", "b", "c"]);
  await advanceFrame();
});

await check("a failing op does not stall the queue", async () => {
  const done = [];
  dm.fracturePart(null, 0, {}).then(() => done.push("x")); // resolves null (no part)
  dm.fracturePart(fakeInst(), 0, {}).then(() => done.push("y"));
  await settle();
  await advanceFrame();
  await advanceFrame();
  assert.deepEqual(done, ["x", "y"]);
});

await check("death gibs cap the fragment count", async () => {
  assert.equal(dm.fragmentCountFor(400, { critical: true, scale: 1.2 }), 14);
  assert.equal(dm.fragmentCountFor(400, { critical: true, scale: 1.2, maxFragments: 8 }), 8);
  assert.equal(dm.fragmentCountFor(10, { maxFragments: 8 }), 4);
});

console.log(`\ndismember_heavy_schedule: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
