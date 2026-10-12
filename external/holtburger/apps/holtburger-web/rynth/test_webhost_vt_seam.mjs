// test_webhost_vt_seam.mjs — the VTank layer seam in rynth/webhost.js
// (W1-8, PLAN §3.10 A1-A21, invariants V-3 / V-13 / V-19 / I-14 / I-15).
//
// Drives the REAL RynthWebHost over a recording fake SessionHandle:
//   S   cast choke point — CastSpellAt / CastSelf / CastUntargetedSafe matrix
//       and the legacy CastSpell(0, id) guard (A3b)
//   R   TryGetSpellRecord normalisation + cache
//   E   TryGetSelfEnchantments (copy + free, receivedAt remaining) + vitae
//   W   TryGetWieldedItems / HasShield
//   T   item-action token (claim / release / minInterval / timeout / events)
//   M   per-snap.seq inventory memo
//   N   FindNearbyByName + TryGetObjectDistance
//   F   fellowship members + TryGetFellowshipInfo box freeing
//   H   the ONE heading conversion constant
//   C   creature info, item mana, the remaining small members, capability rows
//   Z   zero imports: the file's BYTES load standalone (as
//       rynth_host_contract_test.cjs / rynth_combatparity_test.cjs do)
//
// Run: node rynth/test_webhost_vt_seam.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import("./webhost.js");
const { RynthWebHost, CAPABILITY_NAMES, ENV_CAPABILITY_NAMES, HEADING_CONVENTION } = mod;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

const mk = (session) => new RynthWebHost(session, { entityMap: new Map(), noEventTap: true });

// A wasm-bindgen-shaped box: getters throw after free(), free() is counted.
function box(fields) {
  let freed = 0;
  const b = { free() { freed += 1; } };
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(b, k, {
      get() { if (freed) throw new Error("null pointer passed to rust"); return typeof v === "function" ? v() : v; },
      enumerable: true,
    });
  }
  Object.defineProperty(b, "freedCount", { get: () => freed });
  return b;
}

// Capture console.warn for one block (the seam's refusal warnings).
function withWarnings(fn) {
  const real = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    fn(warns);
  } finally {
    console.warn = real;
  }
  return warns;
}

function withClock(start, fn) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  try {
    return fn({ set: (v) => { t = v; }, add: (d) => { t += d; }, get: () => t });
  } finally {
    Date.now = real;
  }
}

const SELF = 0x50000001;
const MOB = 0x80001234;

// DAT spell records (bitfields per PLAN header, data/spell-table-attrs.json):
//   48 Primary Portal Recall 0x8, 1635 Lifestone Recall 0x8 (SelfTargeted)
//   1785 Cassius' Ring of Fire 0x3 (Projectile, untargeted formula, War)
//   2228 debuff 0x93 (Enchantment), 2981 Fellowship Heal I 0x200c (SelfTargeted fellowship)
const REC = {
  48: { id: 48, name: "Primary Portal Recall", school: 4, category: 0, bitfield: 0x8, isSelfTargeted: true, isUntargeted: true, isBeneficial: false, metaSpellType: 6 },
  1635: { id: 1635, name: "Lifestone Recall", school: 4, bitfield: 0x8, flags: { selfTargeted: true }, isUntargeted: true, metaSpellType: 6 },
  1785: { id: 1785, name: "Cassius' Ring of Fire", school: 1, bitfield: 0x3, isSelfTargeted: false, isUntargeted: true, isBeneficial: false, metaSpellType: 2 },
  2228: { id: 2228, name: "Vulnerability Other VI", school: 4, bitfield: 0x93, isSelfTargeted: false, isUntargeted: false, isBeneficial: false, metaSpellType: 1, duration: 60, roughLevel: 6 },
  2: { id: 2, name: "Strength Self I", school: 4, category: 1, bitfield: 0x400c, isSelfTargeted: true, isUntargeted: false, isBeneficial: true, metaSpellType: 1, duration: 1800, roughLevel: 1 },
  6: { id: 6, name: "Heal Other I", school: 2, bitfield: 0x5, isSelfTargeted: false, isUntargeted: false, isBeneficial: true, metaSpellType: 3 },
  7: { id: 7, name: "Dispel Life Magic Other", school: 2, bitfield: 0x1, isSelfTargeted: false, isUntargeted: false, isBeneficial: false, metaSpellType: 9 },
  // a life ring (wrong school), a beneficial ring and a targeted-formula ring
  9001: { id: 9001, name: "Life Ring", school: 2, bitfield: 0x3, isSelfTargeted: false, isUntargeted: true, isBeneficial: false, metaSpellType: 2 },
  9002: { id: 9002, name: "Blessed Ring", school: 1, bitfield: 0x7, isSelfTargeted: false, isUntargeted: true, isBeneficial: true, metaSpellType: 2 },
  9003: { id: 9003, name: "Bolt", school: 1, bitfield: 0x3, isSelfTargeted: false, isUntargeted: false, isBeneficial: false, metaSpellType: 2 },
  9005: { id: 9005, name: "Nether Ring", school: 5, bitfield: 0x3, isSelfTargeted: false, isUntargeted: true, isBeneficial: false, metaSpellType: 2 },
  666: { id: 666, name: "Vitae", school: 4, bitfield: 0x0, isSelfTargeted: false, metaSpellType: 1 },
};
for (const mst of [11, 12, 13, 14]) {
  REC[2980 + mst] = { id: 2980 + mst, name: `Fellowship spell ${mst}`, school: 2, bitfield: 0x200c, isSelfTargeted: true, isUntargeted: true, isBeneficial: true, metaSpellType: mst };
}

// serde_wasm_bindgen hands records back as Maps (nested too).
function asMap(o) {
  const m = new Map();
  for (const [k, v] of Object.entries(o)) m.set(k, v && typeof v === "object" && !Array.isArray(v) ? asMap(v) : v);
  return m;
}

function castHandle({ records = REC, withRecords = true, guid = SELF } = {}) {
  const calls = [];
  const h = {
    calls,
    playerGuid: () => guid,
    castTargetedSpell: (t, id) => calls.push(["castTargetedSpell", t, id]),
    castUntargetedSpell: (id) => calls.push(["castUntargetedSpell", id]),
  };
  if (withRecords) h.getSpellRecord = (id) => (records[id] ? asMap(records[id]) : null);
  return h;
}

// ── S  cast choke point ────────────────────────────────────────────────
await check("S1 CastSpellAt(0|null|undefined) refused, NO castUntargetedSpell / castTargetedSpell call", () => {
  const s = castHandle();
  const h = mk(s);
  const warns = withWarnings(() => {
    assert.equal(h.CastSpellAt(0, 2228), false);
    assert.equal(h.CastSpellAt(null, 2228), false);
    assert.equal(h.CastSpellAt(undefined, 2228), false);
  });
  assert.deepEqual(s.calls, []);
  assert.ok(warns.length >= 1 && /no target guid/.test(warns[0]), JSON.stringify(warns));
});

await check("S2 CastSpellAt(guid, id) is a targeted cast", () => {
  const s = castHandle();
  const h = mk(s);
  assert.equal(h.CastSpellAt(MOB, 2228), true);
  assert.deepEqual(s.calls, [["castTargetedSpell", MOB, 2228]]);
  assert.equal(withWarnings(() => assert.equal(h.CastSpellAt(MOB, 0), false)).length, 1, "spell id 0 refused");
});

await check("S3 CastSelf targets the player guid; no guid -> refused", () => {
  const s = castHandle();
  const h = mk(s);
  assert.equal(h.CastSelf(2), true);
  assert.deepEqual(s.calls, [["castTargetedSpell", SELF, 2]]);
  const s0 = castHandle({ guid: 0 });
  withWarnings(() => assert.equal(mk(s0).CastSelf(2), false));
  assert.deepEqual(s0.calls, []);
});

await check("S4 CastUntargetedSafe: SelfTargeted allowed (record via isSelfTargeted AND via flags.selfTargeted)", () => {
  const s = castHandle();
  const h = mk(s);
  assert.equal(h.CastUntargetedSafe(48), true);
  assert.equal(h.CastUntargetedSafe(1635), true);
  assert.deepEqual(s.calls, [["castUntargetedSpell", 48], ["castUntargetedSpell", 1635]]);
});

await check("S5 CastUntargetedSafe: ring only with allowRing AND Projectile+untargeted+War/Void+not beneficial", () => {
  const s = castHandle();
  const h = mk(s);
  withWarnings((w) => {
    assert.equal(h.CastUntargetedSafe(1785), false, "no allowRing");
    assert.equal(h.CastUntargetedSafe(1785, {}), false);
    assert.equal(h.CastUntargetedSafe(9001, { allowRing: true }), false, "Life school");
    assert.equal(h.CastUntargetedSafe(9002, { allowRing: true }), false, "beneficial");
    assert.equal(h.CastUntargetedSafe(9003, { allowRing: true }), false, "targeted formula");
    assert.ok(w.some((x) => /refused untargeted cast 1785 \(Cassius' Ring of Fire\): not SelfTargeted/.test(x)), JSON.stringify(w));
  });
  assert.deepEqual(s.calls, []);
  assert.equal(h.CastUntargetedSafe(1785, { allowRing: true }), true, "War ring");
  assert.equal(h.CastUntargetedSafe(9005, { allowRing: true }), true, "Void ring");
  assert.deepEqual(s.calls, [["castUntargetedSpell", 1785], ["castUntargetedSpell", 9005]]);
});

await check("S6 CastUntargetedSafe refuses enchantment/debuff, boost, dispel-other and no-record; null opts never throws", () => {
  const s = castHandle();
  const h = mk(s);
  withWarnings(() => {
    for (const id of [2228, 6, 7, 424242]) {
      assert.equal(h.CastUntargetedSafe(id), false, String(id));
      assert.equal(h.CastUntargetedSafe(id, { allowRing: true }), false, `${id} with allowRing`);
    }
    assert.equal(h.CastUntargetedSafe(2228, null), false);
    assert.equal(h.CastUntargetedSafe(0), false);
  });
  assert.deepEqual(s.calls, []);
  const bare = castHandle({ withRecords: false });
  withWarnings(() => assert.equal(mk(bare).CastUntargetedSafe(48), false, "no capability -> no record -> refused"));
  assert.deepEqual(bare.calls, []);
});

await check("S7 CastUntargetedSafe refuses fellowship metaSpellType 11-14 even when SelfTargeted (critic S3)", () => {
  const s = castHandle();
  const h = mk(s);
  const warns = withWarnings(() => {
    for (const mst of [11, 12, 13, 14]) {
      assert.equal(h.CastUntargetedSafe(2980 + mst), false, `mst ${mst}`);
      assert.equal(h.CastUntargetedSafe(2980 + mst, { allowRing: true }), false, `mst ${mst} allowRing`);
    }
  });
  assert.deepEqual(s.calls, []);
  assert.ok(warns.some((w) => /fellowship spell/.test(w)), JSON.stringify(warns));
});

await check("S8 legacy CastSpell(0, id) with getSpellRecord: non-SelfTargeted refused; 48 / 1635 allowed untargeted", () => {
  const s = castHandle();
  const h = mk(s);
  withWarnings((w) => {
    assert.equal(h.CastSpell(0, 2228), false);
    assert.equal(h.CastSpell(undefined, 1785), false);
    assert.equal(h.CastSpell(0, 424242), false, "no record");
    assert.ok(w.some((x) => /not SelfTargeted/.test(x)) && w.some((x) => /no spell record/.test(x)), JSON.stringify(w));
  });
  assert.deepEqual(s.calls, []);
  assert.equal(h.CastSpell(0, 48), true);
  assert.equal(h.CastSpell(0, 1635), true);
  assert.equal(h.CastSpell(MOB, 2228), true, "targeted form unchanged");
  assert.deepEqual(s.calls, [["castUntargetedSpell", 48], ["castUntargetedSpell", 1635], ["castTargetedSpell", MOB, 2228]]);
});

await check("S9 legacy CastSpell(0, id) on a handle WITHOUT getSpellRecord keeps today's pass-through", () => {
  const s = castHandle({ withRecords: false });
  const h = mk(s);
  assert.equal(h.has("GetSpellRecord"), false);
  assert.equal(h.CastSpell(0, 2228), true);
  assert.deepEqual(s.calls, [["castUntargetedSpell", 2228]]);
});

await check("S10 refusal warnings are rate-limited (one per identical text per 10 s)", () => {
  const h = mk(castHandle());
  withClock(1_000_000, (clk) => {
    const w = withWarnings(() => {
      for (let i = 0; i < 5; i++) h.CastSpellAt(0, 2228);
      clk.add(11_000);
      h.CastSpellAt(0, 2228);
    });
    assert.equal(w.length, 2, JSON.stringify(w));
  });
});

// ── R  spell records ───────────────────────────────────────────────────
await check("R1 TryGetSpellRecord normalises isSelfTargeted / flags.selfTargeted / bitfield (in that precedence)", () => {
  const recs = {
    1: { id: 1, name: "A", isSelfTargeted: true, bitfield: 0 },
    3: { id: 3, name: "B", flags: { selfTargeted: true, beneficial: true }, bitfield: 0 },
    4: { id: 4, name: "C", bitfield: 0x8 | 0x4, nonComponentTargetType: 0 },
    5: { id: 5, name: "D", isSelfTargeted: false, flags: { selfTargeted: true }, bitfield: 0x8 },
    8: { id: 8, name: "E", bitfield: 0x3, nonComponentTargetType: 16 },
  };
  const h = mk({ getSpellRecord: (id) => (recs[id] ? asMap(recs[id]) : null) });
  assert.equal(h.TryGetSpellRecord(1).isSelfTargeted, true);
  const b = h.TryGetSpellRecord(3);
  assert.equal(b.isSelfTargeted, true, "flags.selfTargeted (Map-shaped flags)");
  assert.equal(b.isBeneficial, true, "flags.beneficial");
  const c = h.TryGetSpellRecord(4);
  assert.equal(c.isSelfTargeted, true, "bitfield & 0x8");
  assert.equal(c.isBeneficial, true, "bitfield & 0x4");
  assert.equal(c.isUntargeted, true, "nonComponentTargetType 0");
  assert.equal(h.TryGetSpellRecord(5).isSelfTargeted, false, "explicit isSelfTargeted wins");
  const e = h.TryGetSpellRecord(8);
  assert.equal(e.isSelfTargeted, false);
  assert.equal(e.isUntargeted, false);
  assert.deepEqual(Object.keys(c).sort(), ["baseRangeConstant", "baseRangeMod", "bitfield", "category", "duration", "id", "isBeneficial", "isSelfTargeted", "isUntargeted", "metaSpellType", "name", "roughLevel", "school"].sort());
  assert.ok(Object.isFrozen(c));
});

await check("R2 TryGetSpellRecord caches hits per id; a miss (no WorldBootstrap yet) is NOT cached", () => {
  let calls = 0;
  let loaded = false;
  const h = mk({ getSpellRecord: (id) => { calls++; return loaded ? asMap(REC[id] || {}) : null; } });
  assert.equal(h.TryGetSpellRecord(48), null);
  loaded = true;
  const r1 = h.TryGetSpellRecord(48);
  const r2 = h.TryGetSpellRecord(48);
  assert.equal(r1.name, "Primary Portal Recall");
  assert.equal(r1, r2);
  assert.equal(calls, 2, "one miss + one hit read");
  assert.equal(mk({}).TryGetSpellRecord(48), null, "no capability");
  assert.equal(mk({ getSpellRecord: () => { throw new Error("x"); } }).TryGetSpellRecord(48), null, "throwing read");
});

// ── E  self enchantments ───────────────────────────────────────────────
function enchHandle(rowsFn) {
  const boxes = [];
  return {
    boxes,
    getSpellRecord: (id) => (REC[id] ? asMap(REC[id]) : null),
    playerEnchantments: () => rowsFn().map((r) => { const b = box(r); boxes.push(b); return b; }),
  };
}
const ench = (spellId, extra) => ({
  spellId, spellCategory: 1, layer: 1, powerLevel: 10, startTime: 0, duration: 1800, type: 0x2000000 | 0x8000,
  casterGuid: SELF, statKey: 1, statValue: 10, ...extra,
});

await check("E1 TryGetSelfEnchantments copies, frees every box exactly once, rows have the §3.10 shape", () => {
  withClock(5_000_000, () => {
    const s = enchHandle(() => [ench(2, { startTime: -100 }), ench(2228, { type: 0x8000, casterGuid: MOB, statValue: -0.5 })]);
    const h = mk(s);
    const rows = h.TryGetSelfEnchantments();
    assert.equal(rows.length, 2);
    assert.ok(s.boxes.length === 2 && s.boxes.every((b) => b.freedCount === 1), "freed once");
    const r = rows[0];
    assert.deepEqual(Object.keys(r).sort(), ["casterGuid", "durationS", "family", "isBeneficial", "isCooldown", "layer", "level", "permanent", "powerLevel", "remainingS", "spellId", "statKey", "statValue"].sort());
    assert.equal(r.level, 1, "roughLevel from the spell record");
    assert.equal(r.isBeneficial, true);
    assert.equal(r.permanent, false);
    assert.equal(r.durationS, 1800);
    assert.equal(rows[1].isBeneficial, false, "debuff (no Beneficial flag)");
    assert.equal(rows[1].level, 6);
    assert.equal(rows[1].casterGuid, MOB);
  });
});

await check("E2 remaining uses the receivedAt rule: receivedAt + duration + startTime(≤0) − now; recast re-stamps; expired dropped", () => {
  withClock(10_000_000, (clk) => {
    let start = -100;
    const s = enchHandle(() => [ench(2, { startTime: start }), ench(3, { spellId: 3, duration: 10, startTime: -20 })]);
    const h = mk(s);
    let rows = h.TryGetSelfEnchantments();
    assert.equal(rows.length, 1, "the 10 s spell aged 20 s is expired -> dropped");
    assert.equal(rows[0].remainingS, 1700);
    clk.add(50_000);
    rows = h.TryGetSelfEnchantments();
    assert.equal(rows[0].remainingS, 1650, "receivedAt carried while startTime unchanged");
    start = 0; // a recast: the server re-sends with startTime 0
    rows = h.TryGetSelfEnchantments();
    assert.equal(rows[0].remainingS, 1800, "a new startTime re-stamps receivedAt");
    clk.add(1_800_001);
    assert.equal(h.TryGetSelfEnchantments().length, 0, "expires on our clock");
    assert.ok(s.boxes.every((b) => b.freedCount === 1));
  });
});

await check("E3 permanent (duration -1 / 0 / > 1 year) -> remainingS Infinity; cooldown rows flagged; vitae = statValue of 666", () => {
  withClock(20_000_000, () => {
    const s = enchHandle(() => [
      ench(2, { duration: -1 }),
      ench(2228, { duration: 0, type: 0 }),
      ench(0x8000 + 12, { duration: 30, type: 0x1000000 }),
      ench(666, { duration: -1, type: 0x800000, statValue: 0.95 }),
    ]);
    const h = mk(s);
    const rows = h.TryGetSelfEnchantments();
    assert.equal(rows.length, 4);
    assert.ok(rows[0].permanent && rows[0].remainingS === Infinity);
    assert.ok(rows[1].permanent, "duration 0 on a non-cooldown row = permanent (d.ts)");
    assert.equal(rows[1].isBeneficial, false, "type 0 -> the record's isBeneficial");
    assert.ok(rows[2].isCooldown && !rows[2].permanent && rows[2].remainingS === 30 && rows[2].level === 0);
    assert.equal(h.TryGetVitae(), 0.95);
    assert.equal(mk(enchHandle(() => [ench(2)])).TryGetVitae(), null, "no vitae row");
  });
});

await check("E4 enchantments unreadable -> null (no capability / throwing read); empty registry -> []", () => {
  assert.equal(mk({}).TryGetSelfEnchantments(), null);
  assert.equal(mk({ playerEnchantments: () => { throw new Error("x"); } }).TryGetSelfEnchantments(), null);
  assert.deepEqual(mk({ playerEnchantments: () => [] }).TryGetSelfEnchantments(), []);
  assert.equal(mk({}).TryGetVitae(), null);
});

await check("E5 TryGetEnchantments keeps its raw semantics (Z5)", () => {
  const raw = [{ spellId: 2 }];
  assert.equal(mk({ playerEnchantments: () => raw }).TryGetEnchantments(), raw);
});

// ── W  wielded items / shield ──────────────────────────────────────────
await check("W1 TryGetWieldedItems copies + frees; HasShield = any ItemType Armor (0x2) row", () => {
  const boxes = [];
  const items = {
    [MOB]: [{ guid: 0x7000, wcid: 3, itemType: 0x1, equipMask: 0x100000, name: "Axe" }, { guid: 0x7001, wcid: 4, itemType: 0x2, equipMask: 0x200000, name: "Buckler" }],
    0x80000002: [{ guid: 0x7002, wcid: 5, itemType: 0x1, equipMask: 0x100000 }],
  };
  const h = mk({ entityWieldedItems: (g) => (items[g] || []).map((r) => { const b = box(r); boxes.push(b); return b; }) });
  const rows = h.TryGetWieldedItems(MOB);
  assert.deepEqual(rows, [{ guid: 0x7000, wcid: 3, itemType: 1, equipMask: 0x100000 }, { guid: 0x7001, wcid: 4, itemType: 2, equipMask: 0x200000 }]);
  assert.equal(h.HasShield(MOB), true);
  assert.equal(h.HasShield(0x80000002), false);
  assert.equal(h.HasShield(0x80000003), false, "non-wielder -> []");
  assert.ok(boxes.length === 5 && boxes.every((b) => b.freedCount === 1), "every EquippedWeaponJs freed once");
  assert.equal(mk({}).TryGetWieldedItems(MOB), null);
  assert.equal(mk({}).HasShield(MOB), null);
});

// ── T  item-action token ───────────────────────────────────────────────
await check("T1 claim / other owner refused / same owner re-arms / release", () => {
  withClock(30_000_000, (clk) => {
    const h = mk({});
    assert.equal(h.itemActionToken, null);
    assert.equal(h.tryClaimItemAction("vtinv"), true);
    assert.deepEqual(h.itemActionToken, { owner: "vtinv", issuedAt: 30_000_000 });
    assert.equal(h.tryClaimItemAction("vtmana"), false, "another owner holds it");
    clk.add(100);
    assert.equal(h.tryClaimItemAction("vtinv"), true, "same owner re-arms");
    assert.equal(h.itemActionToken.issuedAt, 30_000_100);
    h.releaseItemAction("vtmana");
    assert.equal(h.itemActionToken.owner, "vtinv", "release by a non-holder is a no-op");
    h.releaseItemAction("vtinv");
    assert.equal(h.itemActionToken, null);
    assert.equal(h.tryClaimItemAction("vtmana"), true);
  });
});

await check("T2 minIntervalMs refuses a re-claim by the same owner inside the interval", () => {
  withClock(31_000_000, (clk) => {
    const h = mk({});
    assert.equal(h.tryClaimItemAction("vtloadout", { minIntervalMs: 3000 }), true);
    h.releaseItemAction("vtloadout");
    clk.add(2000);
    assert.equal(h.tryClaimItemAction("vtloadout", { minIntervalMs: 3000 }), false, "2 s < 3 s");
    assert.equal(h.tryClaimItemAction("vtinv", { minIntervalMs: 3000 }), true, "per owner");
    h.releaseItemAction("vtinv");
    clk.add(1001);
    assert.equal(h.tryClaimItemAction("vtloadout", { minIntervalMs: 3000 }), true, "3.001 s later");
    assert.equal(h.tryClaimItemAction("vtinv", null) === false, true, "null opts: other owner still refused, no throw");
  });
});

await check("T3 the token self-clears after 8 s", () => {
  withClock(32_000_000, (clk) => {
    const h = mk({});
    h.tryClaimItemAction("vtpets");
    clk.add(7_999);
    assert.equal(h.tryClaimItemAction("vtinv"), false);
    clk.add(2);
    assert.equal(h.itemActionToken, null);
    assert.equal(h.tryClaimItemAction("vtinv"), true);
  });
});

await check("T4 events clear it: kinds 11, 13 (USE_FAILED), 14, 48; 47/49 only for OUR wield transition", () => {
  const h = mk({ playerGuid: () => SELF });
  for (const kind of [11, 13, 14, 48]) {
    h.tryClaimItemAction("vtsupplies");
    h._dispatchEvent({ kind, u32Payload: 0x1d, u32Payload2: 0 });
    assert.equal(h.itemActionToken, null, `kind ${kind}`);
  }
  for (const kind of [47, 49]) {
    h.tryClaimItemAction("vtloadout");
    h._dispatchEvent({ kind, u32Payload: 0x7000, u32Payload2: 0x50000999 });
    assert.equal(h.itemActionToken?.owner, "vtloadout", `kind ${kind} for another wielder keeps it`);
    h._dispatchEvent({ kind, u32Payload: 0x7000, u32Payload2: SELF });
    assert.equal(h.itemActionToken, null, `kind ${kind} for us clears it`);
  }
  h.tryClaimItemAction("vtinv");
  h._dispatchEvent({ kind: 2, stringPayload: "chat" });
  h._dispatchEvent({ kind: 42, u32Payload: 5 });
  assert.equal(h.itemActionToken?.owner, "vtinv", "unrelated kinds leave it");
});

await check("T5 a subscriber of the clearing event can claim the next action; attach() drops the claim", () => {
  const h = mk({ playerGuid: () => SELF });
  let reclaimed = null;
  h.onEvent((e) => { if (e.kind === 14) reclaimed = h.tryClaimItemAction("vtmana"); });
  h.tryClaimItemAction("vtinv");
  h._dispatchEvent({ kind: 14 });
  assert.equal(reclaimed, true);
  h.attach({ playerGuid: () => SELF });
  assert.equal(h.itemActionToken, null);
});

// ── M  per-seq inventory memo ──────────────────────────────────────────
await check("M1 TryGetPlayerInventoryCached / TryGetPackRoomCached read playerInventory once per snap.seq", () => {
  let reads = 0;
  const rows = [
    { guid: 1, name: "Pack", requiresBackpackSlot: true, itemsCapacity: 24, containerId: 0, equipMask: 0 },
    { guid: 2, name: "Gem", containerId: 0, equipMask: 0 },
    { guid: 3, name: "Kit", containerId: 1, equipMask: 0 },
  ];
  const h = mk({ playerInventory: () => { reads++; return rows.map((r) => box(r)); }, playerItemsCapacity: 102, playerContainersCapacity: 7 });
  assert.equal(h.TryGetPlayerInventoryCached().length, 3, "no snapshot: reads through");
  assert.equal(reads, 1);
  h._tick();
  reads = 0;
  const a = h.TryGetPlayerInventoryCached();
  const b = h.TryGetPlayerInventoryCached();
  const room = h.TryGetPackRoomCached();
  const room2 = h.TryGetPackRoomCached();
  assert.equal(reads, 1, "one read for the whole seq");
  assert.deepEqual(a, b);
  assert.deepEqual(room, room2);
  assert.ok(a !== b && a[0] !== b[0] && room !== room2 && room.packs !== room2.packs, "each caller gets its own copies");
  a.sort((x, y) => y.guid - x.guid);
  a[0].name = "annotated";
  room.packs.push({ guid: 99 });
  room.main.free = -1;
  assert.deepEqual(h.TryGetPlayerInventoryCached().map((r) => r.guid), [1, 2, 3], "a caller's sort/annotation never leaks");
  assert.equal(h.TryGetPlayerInventoryCached()[2].name, "Kit");
  assert.equal(h.TryGetPackRoomCached().packs.length, 1);
  assert.equal(h.TryGetPackRoomCached().main.free, 101, "102 cap − 1 loose item (the Gem)");
  assert.equal(reads, 1, "still one read");
  const live = h.TryGetPackRoom();
  assert.deepEqual(h.TryGetPackRoomCached(), live, "same answer as the uncached read");
  reads = 0;
  h._tick();
  h.TryGetPlayerInventoryCached();
  assert.equal(reads, 1, "a new seq re-reads");
  h._dispatchEvent({ kind: 11 });
  h.TryGetPlayerInventoryCached();
  h.TryGetPackRoomCached();
  assert.equal(reads, 2, "kind 11 drops the memo mid-seq");
});

// ── N  distance + name search ──────────────────────────────────────────
function worldHandle(objs, { pose = { landblockId: 0xa9b40021, x: 100, y: 100, z: 10, heading: 0 }, range } = {}) {
  const calls = [];
  const h = {
    calls,
    playerGuid: () => SELF,
    getLocalPlayerPose: () => ({ ...pose }),
    nearbyEntityGuids: (r) => {
      calls.push(["nearbyEntityGuids", r]);
      return Uint32Array.from(Object.keys(objs).map(Number));
    },
    objectName: (g) => objs[g]?.name,
    objectPosition: (g) => (objs[g] ? [objs[g].cell >>> 0, objs[g].x, objs[g].y, objs[g].z ?? 10] : undefined),
    objectDescFlags: (g) => objs[g]?.flags ?? 0,
    objectIntProperty: (g, k) => (k === 1 ? objs[g]?.itemType : undefined),
    turnToHeading: (r) => calls.push(["turnToHeading", r]),
  };
  const host = mk(h);
  if (range !== undefined) host.nearbyRangeM = range;
  host._tick();
  return { host, calls };
}

await check("N1 TryGetObjectDistance: same landblock 3-D, outdoor seam in the global frame, indoor other-landblock null", () => {
  const { host } = worldHandle({
    0x80000010: { name: "A", cell: 0xa9b40021, x: 103, y: 104, z: 10 },
    0x80000011: { name: "B", cell: 0xa9b30039, x: 100, y: 190, z: 10 }, // the landblock south (y-1), 2 m across the seam
    0x80000012: { name: "C", cell: 0xa9b50105, x: 100, y: 100, z: 10 }, // an EnvCell of another landblock
  }, { pose: { landblockId: 0xa9b40021, x: 100, y: 0 + 0, z: 10, heading: 0 } });
  // pose y=0 at the south edge: B (y 190 in the block to the south) is 2 m away.
  assert.ok(Math.abs(host.TryGetObjectDistance(0x80000011) - 2) < 1e-9, String(host.TryGetObjectDistance(0x80000011)));
  assert.ok(Math.abs(host.TryGetObjectDistance(0x80000010) - Math.hypot(3, 104)) < 1e-9);
  assert.equal(host.TryGetObjectDistance(0x80000012), null);
  assert.equal(host.TryGetObjectDistance(0x80009999), null, "untracked");
  assert.equal(host.TryGetObjectDistance(0), null);
});

await check("N2 FindNearbyByName: exact vs substring, case-insensitive, nearest first, self excluded, maxDistM", () => {
  const objs = {
    [SELF]: { name: "Drudge", cell: 0xa9b40021, x: 100, y: 100 },
    0x80000020: { name: "Drudge Skulker", cell: 0xa9b40021, x: 110, y: 100, itemType: 16, flags: 0x10 },
    0x80000021: { name: "drudge", cell: 0xa9b40021, x: 104, y: 100, itemType: 16, flags: 0x10 },
    0x80000022: { name: "Drudge", cell: 0xa9b40021, x: 102, y: 100, itemType: 16, flags: 0x10 },
    0x80000023: { name: "Drudge", cell: 0xa9b40021, x: 190, y: 100, itemType: 16, flags: 0x10 },
  };
  const { host } = worldHandle(objs, { range: 0 });
  assert.deepEqual(host.FindNearbyByName("DRUDGE").map((r) => r.guid), [0x80000022, 0x80000021, 0x80000023]);
  assert.deepEqual(host.FindNearbyByName("drudge", { exact: false }).map((r) => r.guid), [0x80000022, 0x80000021, 0x80000020, 0x80000023]);
  assert.deepEqual(host.FindNearbyByName("drudge", { maxDistM: 20 }).map((r) => r.guid), [0x80000022, 0x80000021]);
  const r = host.FindNearbyByName("drudge")[0];
  assert.deepEqual(Object.keys(r).sort(), ["dist", "guid", "name"]);
  assert.equal(r.dist, 2);
  assert.deepEqual(host.FindNearbyByName(""), []);
  assert.deepEqual(host.FindNearbyByName("nobody"), []);
});

await check("N3 FindNearbyByName player / creature filters; a live query when the snapshot range is smaller", () => {
  const objs = {
    0x50000002: { name: "Torval", cell: 0xa9b40021, x: 105, y: 100, itemType: 16, flags: 0x08 },
    0x80000030: { name: "Torval", cell: 0xa9b40021, x: 101, y: 100, itemType: 16, flags: 0x10 }, // a creature named like him
    0x80000031: { name: "Torval", cell: 0xa9b40021, x: 102, y: 100, itemType: 0x80, flags: 0 }, // an item
  };
  const { host, calls } = worldHandle(objs, { range: 60 });
  assert.deepEqual(host.FindNearbyByName("torval", { player: true }).map((r) => r.guid), [0x50000002]);
  assert.deepEqual(host.FindNearbyByName("torval", { creature: true }).map((r) => r.guid), [0x80000030, 0x50000002]);
  calls.length = 0;
  host.FindNearbyByName("torval"); // default maxDistM 250 > the 60 m snapshot range
  assert.deepEqual(calls.filter((c) => c[0] === "nearbyEntityGuids"), [["nearbyEntityGuids", 250]]);
  calls.length = 0;
  host.FindNearbyByName("torval", { maxDistM: 30 });
  assert.equal(calls.filter((c) => c[0] === "nearbyEntityGuids").length, 0, "the frozen snapshot list covers 30 m");
});

// ── F  fellowship ──────────────────────────────────────────────────────
await check("F1 TryGetFellowshipInfo: plain shape; the snapshot box and every member box freed once", () => {
  const memberBoxes = [];
  let snapBox = null;
  let membersReads = 0;
  const h = mk({
    playerFellowship: () => (snapBox = box({
      name: "Fellows", leaderGuid: SELF, open: true, isLocked: false, evenShare: true, shareXp: true,
      members: () => {
        membersReads++;
        return [[SELF, "Me", 50], [0x50000002, "Torval", 40]].map(([guid, name, level]) => {
          const b = box({ guid, name, level, currentHealth: 1, maxHealth: 2 });
          memberBoxes.push(b);
          return b;
        });
      },
    })),
  });
  const info = h.TryGetFellowshipInfo();
  assert.deepEqual(info, {
    name: "Fellows", leaderGuid: SELF, open: true, isLocked: false, evenShare: true,
    members: [{ guid: SELF, name: "Me", level: 50 }, { guid: 0x50000002, name: "Torval", level: 40 }],
  });
  assert.equal(membersReads, 1, "the cloning `members` getter is read once");
  assert.equal(snapBox.freedCount, 1);
  assert.ok(memberBoxes.length === 2 && memberBoxes.every((b) => b.freedCount === 1));
  assert.equal(mk({ playerFellowship: () => undefined }).TryGetFellowshipInfo(), null, "not in a fellowship");
  assert.equal(mk({}).TryGetFellowshipInfo(), null);
});

await check("F2 fellowship actions map to the wasm methods; zero guids / empty names refused", () => {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const h = mk({
    fellowshipRecruit: rec("recruit"), fellowshipCreate: rec("create"), fellowshipQuit: rec("quit"),
    fellowshipDismiss: rec("dismiss"), fellowshipChangeOpenness: rec("open"), fellowshipAssignNewLeader: rec("leader"),
    fellowshipUpdateRequest: rec("updates"), recallAllegianceHometown: rec("ah"),
  });
  assert.equal(h.FellowshipRecruit(0), false);
  assert.equal(h.FellowshipDismiss(0), false);
  assert.equal(h.FellowshipAssignLeader(0), false);
  assert.equal(h.FellowshipCreate("  ", true), false);
  assert.equal(h.FellowshipRecruit(0x50000002), true);
  assert.equal(h.FellowshipCreate(" Fellows ", 1), true);
  assert.equal(h.FellowshipQuit(0), true);
  assert.equal(h.FellowshipDismiss(0x50000002), true);
  assert.equal(h.FellowshipSetOpen(1), true);
  assert.equal(h.FellowshipAssignLeader(0x50000002), true);
  assert.equal(h.FellowshipRequestUpdates(true), true);
  assert.equal(h.RecallAllegianceHometown(), true);
  assert.deepEqual(calls, [
    ["recruit", 0x50000002], ["create", "Fellows", true], ["quit", false], ["dismiss", 0x50000002],
    ["open", true], ["leader", 0x50000002], ["updates", true], ["ah"],
  ]);
  const bare = mk({});
  assert.equal(bare.FellowshipRecruit(0x50000002), false, "absent capability degrades to false");
  assert.equal(bare.RecallAllegianceHometown(), false);
});

// ── H  heading conversion ──────────────────────────────────────────────
await check("H1 HEADING_CONVENTION is the one frozen constant; default = today's compass-radians convention", () => {
  assert.ok(Object.isFrozen(HEADING_CONVENTION));
  assert.deepEqual({ ...HEADING_CONVENTION }, { turnSign: 1, turnOffsetDeg: 0, poseSign: 1, poseOffsetDeg: 0 });
  const src = fs.readFileSync(path.join(HERE, "webhost.js"), "utf8");
  assert.equal((src.match(/HEADING_CONVENTION\s*=/g) || []).length, 1, "defined once");
  // Every TurnToHeading issued by the VT members goes through compassDegToTurnRad.
  const vt = src.slice(src.indexOf("VTank layer seam (W1-8, 2026-10-12) — PLAN"));
  assert.equal((vt.match(/"TurnToHeading"/g) || []).length, 1, "one TurnToHeading call site in the VT block");
  assert.match(vt, /_act\("TurnToHeading", compassDegToTurnRad\(d\)\)/);
});

await check("H2 TurnToCompassHeading(deg) -> TurnToHeading(compass radians), normalised; non-finite refused", () => {
  const { host, calls } = worldHandle({});
  calls.length = 0;
  assert.equal(host.TurnToCompassHeading(90), true);
  assert.equal(host.TurnToCompassHeading(450), true);
  assert.equal(host.TurnToCompassHeading(-90), true);
  assert.equal(host.TurnToCompassHeading(0), true);
  assert.equal(host.TurnToCompassHeading(NaN), false);
  assert.equal(host.TurnToCompassHeading("north"), false);
  const rads = calls.filter((c) => c[0] === "turnToHeading").map((c) => c[1]);
  assert.equal(rads.length, 4);
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  assert.ok(close(rads[0], Math.PI / 2) && close(rads[1], Math.PI / 2) && close(rads[2], (3 * Math.PI) / 2) && close(rads[3], 0), JSON.stringify(rads));
});

await check("H3 TryGetPlayerCompassHeadingDeg reads the pose heading through the same constant", () => {
  assert.ok(Math.abs(worldHandle({}, { pose: { landblockId: 0xa9b40021, x: 1, y: 1, z: 1, heading: Math.PI } }).host.TryGetPlayerCompassHeadingDeg() - 180) < 1e-9);
  assert.ok(Math.abs(worldHandle({}, { pose: { landblockId: 0xa9b40021, x: 1, y: 1, z: 1, heading: -Math.PI / 2 } }).host.TryGetPlayerCompassHeadingDeg() - 270) < 1e-9);
  assert.equal(worldHandle({}, { pose: { landblockId: 0xa9b40021, x: 1, y: 1, z: 1, heading: null } }).host.TryGetPlayerCompassHeadingDeg(), null);
  assert.equal(mk({}).TryGetPlayerCompassHeadingDeg(), null);
});

await check("H4 TurnToObject: turnToEntity when exported, else the bearing from the pose (east -> 90°)", () => {
  const turned = [];
  const withEntity = mk({ turnToEntity: (g) => turned.push(g) });
  assert.equal(withEntity.TurnToObject(MOB), true);
  assert.deepEqual(turned, [MOB]);
  assert.equal(withEntity.TurnToObject(0), false);
  const { host, calls } = worldHandle({ [MOB]: { name: "Mob", cell: 0xa9b40021, x: 120, y: 100 } });
  calls.length = 0;
  assert.equal(host.TurnToObject(MOB), true);
  const r = calls.find((c) => c[0] === "turnToHeading");
  assert.ok(r && Math.abs(r[1] - Math.PI / 2) < 1e-12, JSON.stringify(calls));
  assert.equal(host.TurnToObject(0x80009999), false, "unknown position");
});

// ── C  the rest ────────────────────────────────────────────────────────
await check("C1 TryGetItemMana: ints 107/108, |ManaRate|, staleness from the last identify; null without data", () => {
  withClock(40_000_000, (clk) => {
    const props = { 0x7100: { 107: 900, 108: 1000, rate: -0.05, idAt: 40_000_000 - 1000 } };
    const h = mk({
      objectIntProperty: (g, k) => props[g]?.[k],
      objectFloatProperty: (g, k) => (k === 5 ? props[g]?.rate : undefined),
      getLastIdTime: (g) => props[g]?.idAt ?? 0,
    });
    assert.deepEqual(h.TryGetItemMana(0x7100), { cur: 900, max: 1000, ratePerSec: 0.05, lastIdMs: 39_999_000, stale: false });
    clk.add(60_000);
    assert.equal(h.TryGetItemMana(0x7100).stale, true, "> 60 s since the identify");
    assert.equal(h.TryGetItemMana(0x7200), null, "never appraised");
    props[0x7300] = { 108: 500 };
    assert.deepEqual(h.TryGetItemMana(0x7300), { cur: null, max: 500, ratePerSec: null, lastIdMs: 0, stale: true });
  });
});

await check("C2 TryGetCreatureInfo: appraisal maxHp (success or failed profile), creature type, ≤ 1 RequestId per guid per 60 s", () => {
  withClock(50_000_000, (clk) => {
    const reqs = [];
    const appr = {
      [MOB]: JSON.stringify({ guid: MOB, creatureProfile: { health: 50, health_max: 120 }, properties: { ints: { CreatureType: 14 } } }),
      0x80000002: JSON.stringify({ guid: 0x80000002, identifySuccess: false, failedCreatureProfile: { health: 4, health_max: 7 }, properties: { ints: {} } }),
    };
    const h = mk({
      playerGuid: () => SELF,
      objectName: (g) => ({ [MOB]: "Drudge", 0x80000002: "Mite", 0x80000003: "Rat" })[g],
      objectWcid: (g) => ({ [MOB]: 35, 0x80000002: 36, 0x80000003: 37 })[g] ?? 0,
      objectIntProperty: () => undefined,
      getObjectAppraisal: (g) => appr[g],
      objectHealthFraction: (g) => (g === MOB ? 0.5 : -1),
      requestAppraisal: (g) => reqs.push(g),
    });
    const a = h.TryGetCreatureInfo(MOB, { requestAppraisal: true });
    assert.deepEqual(a, { guid: MOB, name: "Drudge", wcid: 35, creatureType: 14, maxHp: 120, hpFrac: 0.5, dist: null, hasShield: null });
    assert.deepEqual(reqs, [], "complete data -> no RequestId");
    const b = h.TryGetCreatureInfo(0x80000002, { requestAppraisal: true });
    assert.equal(b.maxHp, 7, "failed assess still carries health_max");
    assert.equal(b.creatureType, null);
    assert.deepEqual(reqs, [0x80000002]);
    h.TryGetCreatureInfo(0x80000002, { requestAppraisal: true });
    h.TryGetCreatureInfo(0x80000003, { requestAppraisal: true });
    h.TryGetCreatureInfo(0x80000003);
    assert.deepEqual(reqs, [0x80000002, 0x80000003], "rate-limited per guid; not asked -> no request");
    clk.add(60_001);
    h.TryGetCreatureInfo(0x80000002, { requestAppraisal: true });
    assert.deepEqual(reqs, [0x80000002, 0x80000003, 0x80000002]);
    assert.equal(h.TryGetCreatureInfo(0x80009999), null, "untracked guid");
  });
});

await check("C3 CanUseObject / CanUseWith / GetLastTellerName / TryGetObjectInstanceIdProperty degrade to null|undefined", () => {
  const h = mk({
    canUseObject: (g) => g === 1,
    canUseWith: (i, t) => i === 1 && t === 2,
    lastTellerName: () => "Torval",
    objectInstanceIdProperty: (g, k) => (g === 9 && k === 44 ? SELF : undefined),
  });
  assert.equal(h.CanUseObject(1), true);
  assert.equal(h.CanUseObject(2), false);
  assert.equal(h.CanUseWith(1, 2), true);
  assert.equal(h.GetLastTellerName(), "Torval");
  assert.equal(h.TryGetObjectInstanceIdProperty(9, 44), SELF);
  assert.equal(h.TryGetObjectInstanceIdProperty(9, 3), undefined);
  const bare = mk({ lastTellerName: () => undefined });
  assert.equal(bare.CanUseObject(1), null);
  assert.equal(bare.CanUseWith(1, 2), null);
  assert.equal(bare.GetLastTellerName(), null);
  assert.equal(bare.TryGetObjectInstanceIdProperty(9, 44), undefined);
});

await check("C4 GetSelectedItemId: the inventory selection first, then the world selection; env capability probed live", () => {
  const h = mk({});
  try {
    assert.equal(h.has("GetSelectedItemId"), false);
    assert.equal(h.GetSelectedItemId(), 0);
    globalThis.liveScene3d = { entityManager: { getSelectedTarget: () => MOB, setSelectedTarget() {} } };
    assert.equal(h.has("GetSelectedItemId"), true);
    assert.equal(h.GetSelectedItemId(), MOB, "world selection");
    globalThis.__inventory = { armedGuid: 0, selectedGuid: 0x7100 };
    assert.equal(h.GetSelectedItemId(), 0x7100, "inventory selection wins");
    globalThis.__inventory.selectedGuid = 0;
    assert.equal(h.GetSelectedItemId(), MOB);
    delete globalThis.liveScene3d;
    assert.equal(h.has("GetSelectedItemId"), true, "__inventory alone is enough");
    assert.equal(h.GetSelectedItemId(), 0);
  } finally {
    delete globalThis.liveScene3d;
    delete globalThis.__inventory;
  }
});

await check("C5 capability table: the new handle capabilities resolve; old ones untouched", () => {
  const added = ["GetSpellRecord", "GetWieldedItems", "CanUseObject", "CanUseWith", "FellowshipDismiss", "FellowshipChangeOpenness",
    "FellowshipAssignNewLeader", "FellowshipUpdateRequest", "RecallAllegianceHometown", "GetLastTellerName", "TurnToObject"];
  for (const c of added) assert.ok(CAPABILITY_NAMES.includes(c), c);
  for (const c of ["CastSpell", "CastUntargetedSpell", "GetEnchantments", "GetFellowship", "FellowshipCreate", "SendTell"]) assert.ok(CAPABILITY_NAMES.includes(c), c);
  assert.ok(ENV_CAPABILITY_NAMES.includes("GetSelectedItemId"));
  const handle = {
    getSpellRecord() {}, entityWieldedItems() {}, canUseObject() {}, canUseWith() {}, fellowshipDismiss() {}, fellowshipChangeOpenness() {},
    fellowshipAssignNewLeader() {}, fellowshipUpdateRequest() {}, recallAllegianceHometown() {}, lastTellerName() {}, turnToEntity() {},
  };
  const h = mk(handle);
  for (const c of added) assert.ok(h.has(c), `has(${c})`);
  // Every new handle candidate is a real SessionHandle method in the shipped d.ts.
  const dts = path.join(HERE, "..", "pkg", "holtburger_web.d.ts");
  if (fs.existsSync(dts)) {
    const src = fs.readFileSync(dts, "utf8");
    for (const m of Object.keys(handle)) assert.match(src, new RegExp(`^\\s+${m}\\(`, "m"), `${m} in d.ts`);
  }
});

await check("C6 new members keep the house rule: absent capabilities never throw", () => {
  const h = mk({});
  const calls = [
    () => h.CastSpellAt(MOB, 2), () => h.CastSelf(2), () => h.CastUntargetedSafe(48), () => h.TryGetSpellRecord(48),
    () => h.TryGetSelfEnchantments(), () => h.TryGetVitae(), () => h.TryGetObjectInstanceIdProperty(1, 2),
    () => h.TryGetWieldedItems(1), () => h.HasShield(1), () => h.CanUseObject(1), () => h.CanUseWith(1, 2),
    () => h.FellowshipRecruit(1), () => h.FellowshipCreate("x", true), () => h.FellowshipQuit(true), () => h.FellowshipDismiss(1),
    () => h.FellowshipSetOpen(true), () => h.FellowshipAssignLeader(1), () => h.FellowshipRequestUpdates(true),
    () => h.TryGetFellowshipInfo(), () => h.RecallAllegianceHometown(), () => h.GetLastTellerName(),
    () => h.TryGetPlayerCompassHeadingDeg(), () => h.TurnToCompassHeading(90), () => h.TurnToObject(1),
    () => h.TryGetObjectDistance(1), () => h.FindNearbyByName("x"), () => h.TryGetItemMana(1),
    () => h.tryClaimItemAction("x"), () => h.releaseItemAction("x"), () => h.itemActionToken,
    () => h.TryGetPlayerInventoryCached(), () => h.TryGetPackRoomCached(), () => h.TryGetCreatureInfo(1, { requestAppraisal: true }),
    () => h.GetSelectedItemId(),
  ];
  withWarnings(() => { for (const f of calls) f(); });
});

// ── Z  zero imports: the file's bytes load standalone ──────────────────
await check("Z1 webhost.js keeps ZERO imports and its bytes load standalone from a temp .mjs (I-15)", async () => {
  const src = fs.readFileSync(path.join(HERE, "webhost.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "no static import line");
  assert.equal(/\bimport\s*\(/.test(src), false, "no dynamic import");
  assert.equal(/\brequire\s*\(/.test(src), false, "no require");
  const tmp = path.join(os.tmpdir(), `webhost_vtseam_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let m;
  try {
    m = await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
  const host = new m.RynthWebHost({ __stub: true }, { noEventTap: true });
  for (const k of ["CastSpellAt", "CastSelf", "CastUntargetedSafe", "TryGetSpellRecord", "TryGetSelfEnchantments", "TryGetVitae",
    "TryGetObjectInstanceIdProperty", "TryGetWieldedItems", "HasShield", "CanUseObject", "CanUseWith", "FellowshipRecruit",
    "FellowshipCreate", "FellowshipQuit", "FellowshipDismiss", "FellowshipSetOpen", "FellowshipAssignLeader", "FellowshipRequestUpdates",
    "TryGetFellowshipInfo", "RecallAllegianceHometown", "GetLastTellerName", "TryGetPlayerCompassHeadingDeg", "TurnToCompassHeading",
    "TurnToObject", "TryGetObjectDistance", "FindNearbyByName", "TryGetItemMana", "tryClaimItemAction", "releaseItemAction",
    "TryGetPlayerInventoryCached", "TryGetPackRoomCached", "TryGetCreatureInfo", "GetSelectedItemId"]) {
    assert.equal(typeof host[k], "function", k);
  }
  assert.ok("itemActionToken" in host);
  assert.equal(typeof m.HEADING_CONVENTION, "object");
});

await check("Z2 existing signatures unchanged (arity pins of the members the contract tests and loops use)", () => {
  const h = mk({});
  const pins = { CastSpell: 2, CastUntargetedSpell: 1, TryGetEnchantments: 0, TryGetFellowship: 0, UseObject: 1, MoveToPosition: 4,
    TryGetPackRoom: 0, TryGetPlayerInventory: 0, NearbyGuids: 0, TryGetObjectPosition: 1, TryGetPlayerPose: 0, tryClaimCast: 1 };
  for (const [k, n] of Object.entries(pins)) assert.equal(h[k].length, n, k);
  const added = { CastSpellAt: 2, CastSelf: 1, CastUntargetedSafe: 1, tryClaimItemAction: 1, FindNearbyByName: 1, TryGetCreatureInfo: 1 };
  for (const [k, n] of Object.entries(added)) assert.equal(h[k].length, n, k);
});

console.log(fail === 0 ? `webhost vt seam: all ${pass} checks passed` : `webhost vt seam: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
