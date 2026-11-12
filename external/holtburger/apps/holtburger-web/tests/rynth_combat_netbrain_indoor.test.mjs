// tests/rynth_combat_netbrain_indoor.test.mjs — Unit suite for netBrain indoor cross-landblock targeting clamp
// and rynth-vt panel disposeVtDisplay cleanup.
//
// Run from apps/holtburger-web/:  node tests/rynth_combat_netbrain_indoor.test.mjs

import assert from "node:assert/strict";

const { RynthCombatLoop } = await import("../rynth/combat_loop.js");
const { openVtPanel, disposeVtPanel, isVtPanelOpen } = await import("../plugins/rynth-vt/panel.js");

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed++;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const DUNGEON_LB = 0x12340000;
const DUNGEON_ME_CELL = (DUNGEON_LB | 0x0105) >>> 0; // indoor cell (envcell >= 0x100)
const DUNGEON_SAME_CELL = (DUNGEON_LB | 0x0106) >>> 0; // same landblock indoor
const OTHER_LB_CELL = 0x56780105 >>> 0; // different landblock

const OUTDOOR_LB1 = 0xa9b40000;
const OUTDOOR_LB2 = 0xaab40000;
const OUTDOOR_ME_CELL = (OUTDOOR_LB1 | 0x0015) >>> 0; // outdoor cell (cell & 0xffff < 0x100)
const OUTDOOR_OTHER_LB_CELL = (OUTDOOR_LB2 | 0x0015) >>> 0; // outdoor adjacent landblock

function makeHostForNetBrain({ playerPose, entities = new Map() }) {
  let mePose = { ...playerPose };

  const host = {
    get snap() { return { seq: 1 }; },
    IsPlayerReady: () => true,
    IsPortalSpaceActive: () => false,
    TryGetPlayerPose: () => ({ ...mePose }),
    GetPlayerId: () => 0x50000001,
    GetCurrentCombatMode: () => 8,
    NearbyGuids: () => Array.from(entities.keys()),
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (g, prop) => (prop === 1 ? 16 : 0),
    TryGetObjectPosition: (guid) => {
      const e = entities.get(guid >>> 0);
      return e ? { objCellId: e.objCellId, x: e.x, y: e.y, z: e.z } : null;
    },
    TryGetObjectName: (guid) => {
      const e = entities.get(guid >>> 0);
      return e ? e.name : "";
    },
    TryGetTargetHealthFraction: () => 1.0,
    GetKnownSpells: () => [27],
    onEvent: () => {},
    onTick: () => {},
  };
  return { host, setPose: (p) => { mePose = { ...p }; } };
}

// ---------------------------------------------------------------------------
// 1. NetBrain indoor cross-landblock clamp
// ---------------------------------------------------------------------------

test("netBrain clamps cross-landblock targeting when player is indoors", () => {
  const indoorPlayer = {
    objCellId: DUNGEON_ME_CELL,
    x: 100,
    y: 100,
    z: 0,
    heading: 0,
  };

  const monsterSameLb = {
    guid: 0x80000101,
    name: "Dungeon Creeper",
    objCellId: DUNGEON_SAME_CELL,
    x: 110, // 10m away
    y: 100,
    z: 0,
    flags: 0x10,
  };

  const monsterOtherLb = {
    guid: 0x80000102,
    name: "Far Phantom",
    objCellId: OTHER_LB_CELL, // Cross-landblock in dungeon
    x: 105,
    y: 100,
    z: 0,
    flags: 0x10,
  };

  const entities = new Map([
    [monsterSameLb.guid, monsterSameLb],
    [monsterOtherLb.guid, monsterOtherLb],
  ]);

  const { host } = makeHostForNetBrain({ playerPose: indoorPlayer, entities });
  const loop = new RynthCombatLoop(host, { log: () => {} });

  const input = loop._nbBuildInput(0, Date.now());
  assert.ok(input, "netBrain input must be generated");
  assert.ok(Array.isArray(input.Entities), "input.Entities must be an array");

  const entityGuids = input.Entities.map((e) => (e.Id >>> 0));

  // Monster in same landblock should be included
  assert.ok(entityGuids.includes(monsterSameLb.guid), "Monster in same indoor landblock must be included");

  // Monster in different landblock must be clamped/excluded
  assert.ok(!entityGuids.includes(monsterOtherLb.guid), "Monster in different landblock must be clamped when indoors");
});

// ---------------------------------------------------------------------------
// 2. NetBrain outdoor cross-landblock targeting is permitted
// ---------------------------------------------------------------------------

test("netBrain allows outdoor cross-landblock targeting using global coordinates", () => {
  const outdoorPlayer = {
    objCellId: OUTDOOR_ME_CELL,
    x: 190,
    y: 100,
    z: 0,
    heading: 0,
  };

  // Adjacent landblock creature close to landblock boundary
  const monsterCrossLb = {
    guid: 0x80000201,
    name: "Plains Drudge",
    objCellId: OUTDOOR_OTHER_LB_CELL,
    x: 10, // ~12m away across 192m landblock boundary
    y: 100,
    z: 0,
    flags: 0x10,
  };

  const entities = new Map([
    [monsterCrossLb.guid, monsterCrossLb],
  ]);

  const { host } = makeHostForNetBrain({ playerPose: outdoorPlayer, entities });
  const loop = new RynthCombatLoop(host, { log: () => {} });

  const input = loop._nbBuildInput(0, Date.now());
  assert.ok(input, "netBrain input must be generated");
  assert.ok(Array.isArray(input.Entities), "input.Entities must be an array");

  const entityGuids = input.Entities.map((e) => (e.Id >>> 0));
  assert.ok(entityGuids.includes(monsterCrossLb.guid), "Monster across outdoor landblock boundary should be included");
});

// ---------------------------------------------------------------------------
// 3. rynth-vt panel disposeVtPanel cleans up vtDisplay
// ---------------------------------------------------------------------------

test("disposeVtPanel cleans up and disposes installVtDisplay instance", () => {
  let displayDisposed = false;
  const mockWin = {
    __rynthVtDisplay: {
      dispose() {
        displayDisposed = true;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    document: {
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };

  // Set up mock window on global or test harness if available
  const origWindow = globalThis.window;
  globalThis.window = mockWin;

  try {
    disposeVtPanel();
    assert.equal(displayDisposed, true, "disposeVtPanel must call __rynthVtDisplay.dispose()");
  } finally {
    globalThis.window = origWindow;
  }
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

for (const t of tests) {
  await t();
}

console.log(`\nRynth Combat NetBrain Indoor Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
