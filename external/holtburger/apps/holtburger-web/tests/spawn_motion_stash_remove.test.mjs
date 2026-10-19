// tests/spawn_motion_stash_remove.test.mjs — 2026-10-18 review §7 follow-up
// (entities, 2026-10-07 review §4).
//
// Bug 15 (2026-10-07) stashes the motions that reach a rig still being built
// (`EntityManager._stashSpawnMotion`) and replays them when the rig commits.
// Only the commit deleted the stash entry, so a spawn that never committed (the
// object deleted while its bakes ran) kept it for the session — and the next
// spawn of that guid, minutes later, replayed its stale BASE motion (the base
// has no age limit; only the actions do). remove() invalidates the in-flight
// spawn (spawn-generation bump), so it now drops the stash with it.
//
//   M1 a motion for a rig in flight is stashed (the Bug 15 behaviour)
//   M2 remove() before the rig commits drops the stash entry
//   M3 another guid's stash is untouched
//
// Run from apps/holtburger-web/:  node tests/spawn_motion_stash_remove.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.__playEffectVfxBound = true;
globalThis.window.__spellShapePreviewBound = true;

const THREE = await import("three");
const { EntityManager } = await import("../scene3d/entities.js");

const WALK = 0x45000005;
const NONCOMBAT = 0x8000003d;

test("a removed in-flight spawn takes its stashed motions with it", async () => {
  const em = new EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
  const A = 0x80006001;
  const B = 0x80006002;
  em.spawnInFlight.set(A, new Promise(() => {}));
  em.spawnInFlight.set(B, new Promise(() => {}));
  await em.setMotion(A, WALK, NONCOMBAT, 1);
  await em.setMotion(B, WALK, NONCOMBAT, 1);
  assert.ok(em._spawnMotionStash?.has(A), "M1 the motion for the rig in flight is stashed");
  em.spawnInFlight.delete(A);
  em.remove(A);
  assert.equal(em._spawnMotionStash.has(A), false, "M2 remove() dropped it");
  assert.ok(em._spawnMotionStash.has(B), "M3 another guid's stash stays");
});
