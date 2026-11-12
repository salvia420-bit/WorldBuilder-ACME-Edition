// tests/rynth_vt_missing_item_buff.test.mjs — Unit suite for VTank / Rynth missing-item buff loop suppression.
// On 0x042c (TargetNotAcquired) for a missing or dropped item, the loop must park the item and stop spamming CastSpell.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_missing_item_buff.test.mjs

import assert from "node:assert/strict";

const { RynthBuffLoop, PLACE_PARK_MS } = await import("../rynth/buff_loop.js");

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

const ME = 0x50000001;
const ITEM_GUID = 0x70000001;
const SPELL_ID = 2001;

function makeMockHost(opts = {}) {
  const events = [];
  const casts = [];
  let useDone = 1;
  let inventory = opts.inventory || [{ guid: ITEM_GUID, equipMask: 0 }];

  const host = {
    IsPlayerReady: () => true,
    IsPortalSpaceActive: () => false,
    GetCurrentCombatMode: () => 8,
    ChangeCombatMode: () => true,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => ME,
    CastSpell(target, spell) {
      casts.push({ target: target >>> 0, spell: spell >>> 0 });
      return true;
    },
    tryClaimCast: () => true,
    releaseCast: () => {},
    has: (c) => c === "GetUseDoneSeq",
    GetUseDoneSeq: () => useDone,
    TryGetPlayerInventory: () => inventory,
    setInventory: (inv) => { inventory = inv; },
    onEvent(fn) { events.push(fn); },
    emit(e) {
      for (const fn of events) fn({ u32: 0, u32b: 0, text: "", ...e });
    },
    onTick() {},
    s: {
      playerEnchantments: () => [],
      playerKnownSpells: () => [SPELL_ID],
      getSpellRecord: () => ({ category: 200, roughLevel: 1 }),
    },
  };
  return { host, casts };
}

// ---------------------------------------------------------------------------
// 1. TargetNotAcquired (0x042c) parks missing item for PLACE_PARK_MS
// ---------------------------------------------------------------------------

test("missing item receiving 0x042c TargetNotAcquired parks item and stops CastSpell spam", () => {
  let simulatedNow = 1_800_000_000_000;
  const originalNow = Date.now;
  Date.now = () => simulatedNow;

  try {
    const { host, casts } = makeMockHost();
    const logs = [];
    const loop = new RynthBuffLoop(host, [], { log: (m) => logs.push(m), itemRecastMs: 1000 });
    loop.registryReady = true;

    // Configure item buffs: item is present initially
    loop.setItemBuffs([{ spellId: SPELL_ID, itemGuid: ITEM_GUID, worn: false }]);

    // First tick: loop casts the item buff
    loop.tick();
    assert.equal(casts.length, 1, "Expected 1 initial cast for item");
    assert.equal(casts[0].target, ITEM_GUID);
    assert.equal(casts[0].spell, SPELL_ID);

    // ACE server responds with 0x042c (TargetNotAcquired: item dropped or not found)
    host.emit({ kind: 13, u32: 0x042c });

    // Advance clock past SPELL_CAST_INTERVAL_MS so tick processes the refusal
    simulatedNow += 500;
    loop.tick();

    // Verify item is placed in held state for PLACE_PARK_MS
    const key = `${SPELL_ID}:${ITEM_GUID}`;
    const heldUntil = loop._itemHeldUntil.get(key);
    assert.ok(heldUntil !== undefined, "Item must be parked in _itemHeldUntil");
    assert.equal(heldUntil, simulatedNow + PLACE_PARK_MS);

    // Advance clock by 1 second (1000 ms), simulate 1 Hz loop ticks
    simulatedNow += 1000;
    loop.tick();
    simulatedNow += 1000;
    loop.tick();
    simulatedNow += 1000;
    loop.tick();

    // Verify NO new casts were initiated during the parked period
    assert.equal(casts.length, 1, "Must NOT spam CastSpell while item is parked on 0x042c");
    assert.equal(loop._itemDue({ spellId: SPELL_ID, itemGuid: ITEM_GUID }, simulatedNow), false, "Item must not be due while held");

    // Verify logs recorded the suppression
    const logMatch = logs.some((l) => l.includes("0x042c") && l.includes("not acquired"));
    assert.ok(logMatch, "Log should note target not acquired (0x042c)");
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 2. _itemPass filters out items missing from player inventory
// ---------------------------------------------------------------------------

test("_itemPass excludes items not found in current inventory rows", () => {
  const presentGuid = 0x60000010;
  const missingGuid = 0x70000099;
  const { host } = makeMockHost({
    inventory: [{ guid: presentGuid, equipMask: 0 }],
  });

  const loop = new RynthBuffLoop(host, [], { log: () => {} });
  loop.setItemBuffs([
    { spellId: 2001, itemGuid: presentGuid, worn: false },
    { spellId: 2002, itemGuid: missingGuid, worn: false },
  ]);

  const passItems = loop._itemPass(Date.now());
  const passGuids = passItems.map((ib) => ib.itemGuid);

  assert.ok(passGuids.includes(presentGuid), "Present inventory item should be included in pass");
  assert.ok(!passGuids.includes(missingGuid), "Missing inventory item must be filtered out of pass");
});

// ---------------------------------------------------------------------------
// 3. _itemDue honours _itemHeldUntil even when optFn is not present
// ---------------------------------------------------------------------------

test("_itemDue respects _itemHeldUntil even when optFn is null/absent", () => {
  const { host } = makeMockHost();
  const loop = new RynthBuffLoop(host, [], { log: () => {} });
  const ib = { spellId: SPELL_ID, itemGuid: ITEM_GUID };
  const key = `${SPELL_ID}:${ITEM_GUID}`;
  const now = 5_000_000;

  // Not held -> due if recast elapsed
  assert.equal(loop._itemDue(ib, now), true);

  // Held in future
  loop._itemHeldUntil.set(key, now + 60_000);
  assert.equal(loop._itemDue(ib, now), false, "_itemDue must return false when item is held");

  // Held in past
  loop._itemHeldUntil.set(key, now - 1000);
  assert.equal(loop._itemDue(ib, now), true, "_itemDue should return true after hold expires");
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

for (const t of tests) {
  await t();
}

console.log(`\nRynth VT Missing Item Buff Suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
