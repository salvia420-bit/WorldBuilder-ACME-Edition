// tests/held_ledger_wire_spawn.test.mjs — held-2 (2026-10-08,
// `?wieldLedgerAuthority`): a WIRE spawn decides its own parent.
//
// Retail parents an object only from its CreateObject PhysicsDesc or a
// ParentEvent (acclient.c:391950-391961), never from memory. With
// `_wieldedSpawn` on, a parented CreateObject parks its kind=7 attach before
// the spawn commits, so a wire spawn that commits UNPARKED was created without
// a parent (ACE: unequip = DeleteObject, a later drop = a fresh world
// CreateObject) and the `_lastAttach` ledger must not put it back in the old
// wielder's hand. Internal rebuilds (`meta._internalRespawn`) still replay.
// Also: `_tickDynamicLod` never LOD-respawns a held (or left-world) child.
//
// Run from apps/holtburger-web/:  node tests/held_ledger_wire_spawn.test.mjs

import assert from "node:assert/strict";

const { EntityManager } = await import("../scene3d/entities.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};

const C = 0x80001234, W = 0x50000001;
const replay = EntityManager.prototype._replayLastAttach;

/** A minimal `this` for `_replayLastAttach`: ledger C→W, both rigs live. */
function fakeManager({ childMeta = {}, wieldedSpawn = true, child = {} } = {}) {
  const calls = [];
  return {
    calls,
    _wieldedSpawn: wieldedSpawn,
    _lastAttach: new Map([[C, { parentGuid: W, location: 1, placement: 1 }]]),
    entityMap: new Map([
      [C, { meta: childMeta, _attachedParentGuid: null, ...child }],
      [W, { root: {} }],
    ]),
    attachChildToParent: (...a) => calls.push(a),
  };
}

await check("A: a wire spawn with no parked attach is not re-mounted and forgets the ledger", () => {
  const f = fakeManager();
  replay.call(f, C, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f._lastAttach.has(C), false);
});

await check("B: an internal respawn (appearance / LOD) still replays the ledger", () => {
  const f = fakeManager({ childMeta: { _internalRespawn: true } });
  replay.call(f, C, false);
  assert.deepEqual(f.calls, [[C, W, 1, 1]]);
  assert.equal(f._lastAttach.has(C), true);
});

await check("C: a parked server attach supersedes the ledger — no replay, entry kept", () => {
  const f = fakeManager();
  replay.call(f, C, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f._lastAttach.has(C), true);
});

await check("D: `?wieldedSpawn=off` keeps the legacy ledger replay (the only re-mount there)", () => {
  const f = fakeManager({ wieldedSpawn: false });
  replay.call(f, C, false);
  assert.deepEqual(f.calls, [[C, W, 1, 1]]);
});

await check("E: wielder comes back — a wire-spawned unparented child's entry is dropped", () => {
  const f = fakeManager();
  replay.call(f, W, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f._lastAttach.has(C), false);
});

await check("F: wielder comes back — an internally rebuilt child is re-mounted", () => {
  const f = fakeManager({ childMeta: { _internalRespawn: true } });
  replay.call(f, W, false);
  assert.deepEqual(f.calls, [[C, W, 1, 1]]);
});

await check("G: a left-world child (held-4) is never re-mounted by the ledger", () => {
  const f = fakeManager({ childMeta: { _internalRespawn: true }, child: { _leftWorld: true } });
  replay.call(f, C, false);
  replay.call(f, W, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f._lastAttach.has(C), true);
});

await check("H: the two internal respawn sites tag `_internalRespawn` before spawn()", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");
  const tagged = src.match(/newMeta\._internalRespawn = true;[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*this\.remove\(g\);\s*\n\s*await this\.spawn\(newMeta\);/g) || [];
  assert.equal(tagged.length, 2);
});

await check("I: _tickDynamicLod skips attached and left-world children (no band query)", async () => {
  const lodCalls = [];
  const em = new EntityManager({ entitiesGroup: null, materialCache: null }, {
    fetch_entity_degrade_for_distance: (setup, dist) => { lodCalls.push(setup); return 0; },
  });
  globalThis.window = { liveScene3d: { camera: { position: { x: 100, y: 2, z: -100 } } } };
  try {
    const mk = (guid, extra) => ({ guid, _lodOriginalSetup: guid, root: { position: { x: 0.03, y: 0.01, z: 0.02 } }, ...extra });
    em.entityMap.set(1, mk(1, { _attachedParentGuid: W }));
    em.entityMap.set(2, mk(2, { _leftWorld: true }));
    em.entityMap.set(3, mk(3, {}));
    em._tickDynamicLod();
    await Promise.resolve();
    assert.deepEqual(lodCalls, [3]);
  } finally {
    delete globalThis.window;
  }
});

console.log(`\nheld_ledger_wire_spawn: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
