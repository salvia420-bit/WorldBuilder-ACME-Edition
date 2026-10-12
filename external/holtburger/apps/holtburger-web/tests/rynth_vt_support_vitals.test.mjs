// tests/rynth_vt_support_vitals.test.mjs — rynth/vt/support/supplies.js and
// consumables.js (PLAN W1-9 SUP, §3.11; V3, O13-O14, C3, C5).
//
// The "Supplies" kernel slot (afterVitals, keepsCombatLoop): kit / potion /
// food selection per vital and threshold, in-combat vs idle thresholds, the
// give-up valve, shared cooldowns, MinimumHealKitSuccessChance, dispel
// detection (harmful, level ≥ 7, family set) → dispel item or a TARGETED
// Eradicate Life Magic Self, grenades gated off at GrenadeMinMonsters 0, plus
// the consumable classifier and the Consumables model.
//
// Everything outside rynth/vt/support/ is a fake (C2): the host, the signals
// bus, VtOptions, the combat loop (rynth/testdata/vt/support/fakes.mjs). The
// data JSON is the real rynth/vt/data/*.json.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_vitals.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const C = await import("../rynth/vt/support/consumables.js");
const S = await import("../rynth/vt/support/supplies.js");
await C.loadSupportData();

const run = F.makeRunner();

const ME = 0x50000001;
const KIT = 0x80001001;
const POT = 0x80001002;
const FOOD = 0x80001003;
const MKIT = 0x80001004;
const SPOT = 0x80001005;
const GEM = 0x80001006;
const GREN = 0x80001007;
const MOB = 0x80002001;

function world({ values = {}, consumables = [], inv = [], combat = null } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME });
  host.inv = inv;
  const options = F.makeOptions(values, { consumables });
  const bus = F.makeBus();
  const bot = { combat: combat || F.makeCombat() };
  const model = new C.ConsumablesModel({ options, host, now: clock.now, log: () => {} });
  const sup = S.createSupplies({ host, bot, options, subscribe: bus.on, consumables: model, now: clock.now, log: () => {} });
  const slot = sup.slot;
  // One kernel tick through the afterVitals rank (pinned first, then wants).
  const tick = (c = F.ctx()) => {
    clock.advance(100);
    if (!slot.enabled()) return false;
    if (slot.pinned() || slot.wants({ ...c, now: clock.t })) {
      slot.tick({ ...c, now: clock.t });
      return true;
    }
    return false;
  };
  return { clock, host, options, bus, bot, model, sup, slot, tick };
}

const kitRow = (g = KIT, name = "Healing Kit") => F.row(g, name);
const potRow = (g = POT, name = "Health Elixir") => F.row(g, name);
const foodRow = (g = FOOD, name = "Apple") => F.row(g, name, { itemType: 0x20 });
const E = (guid, name, type, extra = {}) => ({ guid, name, wcid: 0, type, ...extra });

await run.check("enabled() is false at the schema defaults with empty lists (Z2); slot shape", () => {
  const w = world();
  assert.equal(w.slot.enabled(), false);
  assert.equal(w.slot.name, "Supplies");
  assert.equal(w.slot.rank, "afterVitals");
  assert.equal(w.slot.keepsCombatLoop, true);
  w.host.setVital(1, 10);
  for (let i = 0; i < 5; i++) w.tick();
  assert.equal(w.host.calls.length, 0, "no host action at defaults");
  for (const k of ["enabled", "inFlight", "uses", "casts", "parkedAxes", "dispelled"]) assert.ok(k in w.sup.status(), k);
});

await run.check("classifyConsumable: kits, potions, food, stones/charges, dispel, lockpick, essence, grenade; Mana Potion is NOT a stone (U7a H12)", () => {
  const cl = (name, extra = {}, ap = null) => C.classifyConsumable(F.row(1, name, extra), ap);
  assert.equal(cl("Healing Kit"), "HealthKit");
  assert.equal(cl("Greater Stamina Kit"), "StaminaKit");
  assert.equal(cl("Lesser Mana Kit"), "ManaKit");
  assert.equal(cl("Health Elixir"), "HealthPotion");
  assert.equal(cl("Stamina Elixir"), "StaminaPotion");
  assert.equal(cl("Mana Potion"), "ManaPotion");
  assert.equal(cl("Black Market Mana Elixir"), "ManaPotion");
  assert.equal(cl("Apple", { itemType: 0x20 }, { properties: { ints: { BoosterEnum: 2 } } }), "HealthFood");
  assert.equal(cl("Bread", { itemType: 0x20 }, { properties: { ints: { BoosterEnum: 4 } } }), "StaminaFood");
  assert.equal(cl("Aromatic Amber Ale", { itemType: 0x20 }, { spellBook: [2] }), "BuffItem");
  assert.equal(cl("Mana Stone", { itemType: 0x80000 }), "ManaStone");
  assert.equal(cl("Small Mana Charge", { itemType: 0x80000 }), "ManaCharge");
  assert.equal(cl("Gem of Stillness", { wcid: 9193, itemType: 0x800 }), "Dispel");
  assert.equal(cl("Condensed Dispel Potion"), "Dispel");
  assert.equal(cl("Scroll of Dispel Life", { itemType: 0x2000 }), "General", "scrolls never dispel items");
  assert.equal(cl("Lockpick"), "Lockpick");
  assert.equal(cl("Lockpick Gem of Forgetfulness"), "General");
  assert.equal(cl("Gold Golem Essence"), "Pet");
  assert.equal(cl("Encapsulated Spirit"), "General");
  assert.equal(cl("Gold Phial of Acid Vulnerability", { itemType: 0x100 }), "Grenade");
  assert.equal(cl("Hyssop", { itemType: 0x1000 }), "PeaComponent");
  assert.equal(cl("Pyreal"), "General");
  assert.equal(C.classifyConsumable(null), "General");
  assert.equal(C.CONSUMABLE_TYPES.length, 17);
});

await run.check("ConsumablesModel: add (classify + dup refusal), update, remove, ofType, resolveGuid by guid then (name, wcid)", () => {
  const w = world({ inv: [kitRow(), potRow()] });
  const r = w.model.add({ guid: KIT });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.entry.type, "HealthKit");
  assert.equal(w.model.add({ guid: KIT }).ok, false, "duplicate refused");
  assert.equal(w.model.add({ name: "health elixir" }).entry.type, "HealthPotion");
  assert.equal(w.model.add({ guid: 0xdead }).ok, false);
  assert.equal(w.model.update(KIT, { type: "StaminaKit" }).ok, true);
  assert.equal(w.model.ofType("StaminaKit").length, 1);
  assert.equal(w.model.update(KIT, { type: "Bogus" }).ok, false);
  assert.equal(w.options.getList("consumables").length, 2, "stored in the profile list");
  // Another character: same name + wcid, new guid.
  w.host.inv = [F.row(0x80009999, "Healing Kit")];
  assert.equal(w.model.resolveGuid({ guid: KIT, name: "Healing Kit", wcid: 0 }), 0x80009999);
  assert.equal(w.model.resolveGuid({ guid: KIT, name: "Other", wcid: 0 }), 0);
  assert.equal(w.model.remove(KIT).ok, true);
  assert.equal(w.model.remove(KIT).ok, false);
});

await run.check("idle HP below TopOffHP: HealthKit applied to SELF (UseItemOnTarget(kit, me)) under the item token vtsupplies", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit"), E(POT, "Health Elixir", "HealthPotion")], inv: [kitRow(), potRow()] });
  assert.equal(w.slot.enabled(), true);
  w.host.setVital(1, 90); // < 95 idle
  assert.equal(w.tick(), true);
  assert.deepEqual(w.host.actions("UseItemOnTarget"), [["UseItemOnTarget", KIT, ME]]);
  assert.equal(w.host.itemActionToken.owner, "vtsupplies");
  assert.equal(w.host.actions("UseObject").length, 0);
});

await run.check("no kit → potion (UseObject); no potion → food; kit before potion before food", () => {
  const w = world({ consumables: [E(FOOD, "Apple", "HealthFood"), E(POT, "Health Elixir", "HealthPotion")], inv: [potRow(), foodRow()] });
  w.host.setVital(1, 50);
  w.tick();
  assert.deepEqual(w.host.actions("UseObject"), [["UseObject", POT]], "potion before food regardless of list order");
  w.host.answer();
  w.host.inv = [foodRow()];
  w.clock.advance(1500);
  w.tick();
  assert.deepEqual(w.host.actions("UseObject").at(-1), ["UseObject", FOOD]);
});

await run.check("in-combat thresholds (HealAt 60) vs idle (TopOffHP 95)", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()] });
  w.host.setVital(1, 70);
  assert.equal(w.tick(F.ctx({ inCombat: true })), false, "70 % is fine in combat");
  assert.equal(w.host.calls.length, 0);
  assert.equal(w.tick(F.ctx({ inCombat: false })), true, "70 % < 95 when idle");
  w.host.answer();
  w.clock.advance(1500);
  w.host.clearCalls();
  w.host.setVital(1, 50);
  assert.equal(w.tick(F.ctx({ inCombat: true })), true, "50 % < 60 in combat");
  assert.equal(w.host.actions("UseItemOnTarget").length, 1);
  // Without a ctx flag the combat loop decides (a locked target = in combat).
  const w2 = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()], combat: F.makeCombat({ locked: MOB }) });
  w2.host.setVital(1, 70);
  w2.clock.advance(100);
  assert.equal(w2.slot.wants({ now: w2.clock.t }), false, "partial ctx0 without inCombat: combat lock ⇒ combat thresholds");
});

await run.check("vital order HP → mana → stamina; mana kit, stamina potion; a threshold of 0 disables its axis", () => {
  const list = [E(MKIT, "Lesser Mana Kit", "ManaKit"), E(SPOT, "Stamina Elixir", "StaminaPotion"), E(KIT, "Healing Kit", "HealthKit")];
  const inv = [F.row(MKIT, "Lesser Mana Kit"), F.row(SPOT, "Stamina Elixir"), kitRow()];
  const w = world({ consumables: list, inv });
  w.host.setVital(1, 50);
  w.host.setVital(5, 50);
  w.host.setVital(3, 50);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseItemOnTarget", KIT, ME], "health first");
  w.host.answer();
  w.host.setVital(1, 100);
  w.clock.advance(1500);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseItemOnTarget", MKIT, ME], "mana kit on self");
  w.host.answer();
  w.host.setVital(5, 100);
  w.clock.advance(1500);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", SPOT], "stamina potion");
  w.host.answer();
  w.host.clearCalls();
  const w0 = world({ values: { TopOffStam: 0 }, consumables: list, inv });
  w0.host.setVital(3, 1);
  w0.tick();
  assert.equal(w0.host.calls.length, 0, "TopOffStam 0 disables the stamina axis");
});

await run.check("one action at a time: pinned while unresolved; the server answer resolves; 1 s pacing", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()] });
  w.host.setVital(1, 50);
  w.tick();
  assert.equal(w.slot.pinned(), true, "unresolved use pins the slot");
  w.tick();
  w.tick();
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "no second use while in flight");
  w.host.answer(); // kind 14 UseDone clears the token
  assert.equal(w.slot.pinned(), false);
  w.clock.advance(400);
  w.tick();
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "USE_INTERVAL_MS (1 s) not yet over");
  w.clock.advance(200);
  w.tick();
  assert.equal(w.host.actions("UseItemOnTarget").length, 2, "next use after the answer + 1 s pacing");
  // A useDone signal also resolves (hosts without the token seam).
  w.bus.emit({ type: "useDone" });
  assert.equal(w.slot.pinned(), false);
  // The pin is bounded (4 s) even with no answer at all.
  w.clock.advance(1500);
  w.tick();
  assert.equal(w.slot.pinned(), true);
  w.clock.advance(4100);
  assert.equal(w.slot.pinned(), false, "PIN_MAX_MS bound");
});

await run.check("give-up valve: 6 uses without progress park the axis 60 s; progress resets; resumes after the park", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()] });
  w.host.setVital(1, 40);
  const useOnce = () => {
    w.clock.advance(1500);
    w.tick();
    w.host.answer();
  };
  for (let i = 0; i < 7; i++) useOnce(); // first use sets the baseline, then 6 without progress
  const n = w.host.actions("UseItemOnTarget").length;
  assert.equal(n, 7);
  useOnce();
  useOnce();
  assert.equal(w.host.actions("UseItemOnTarget").length, 7, "axis parked");
  assert.deepEqual(w.sup.status().parkedAxes, ["hp"]);
  w.clock.advance(61_000);
  useOnce();
  assert.equal(w.host.actions("UseItemOnTarget").length, 8, "resumes after 60 s");
  // Progress resets the counter: climbing HP never parks.
  const w2 = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()] });
  for (let i = 0; i < 10; i++) {
    w2.host.setVital(1, 40 + i * 5);
    w2.clock.advance(1500);
    w2.tick();
    w2.host.answer();
  }
  assert.equal(w2.host.actions("UseItemOnTarget").length, 10);
  assert.deepEqual(w2.sup.status().parkedAxes, []);
});

await run.check("shared cooldown: an item whose SharedCooldown row is live is skipped (next type used)", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit"), E(POT, "Health Elixir", "HealthPotion")], inv: [kitRow(), potRow()] });
  w.host.setInt(KIT, 280, 21); // SharedCooldown 21
  w.host.ench = [{ spellId: 0x8000 + 21, family: 0, layer: 1, isCooldown: true, isBeneficial: true, remainingS: 30, permanent: false }];
  w.host.setVital(1, 50);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", POT], "kit on cooldown → potion");
  w.host.answer();
  w.host.ench = [];
  w.clock.advance(1500);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseItemOnTarget", KIT, ME], "cooldown gone → kit again");
});

await run.check("MinimumHealKitSuccessChance is read from options and honoured as an estimate (ACE Healer skill check)", () => {
  assert.ok(Math.abs(S.skillChance(100, 100) - 0.5) < 1e-9);
  const mk = (min) => {
    const w = world({ values: { MinimumHealKitSuccessChance: min }, consumables: [E(KIT, "Healing Kit", "HealthKit"), E(POT, "Health Elixir", "HealthPotion")], inv: [kitRow(), potRow()] });
    w.host.stats.skills = { 21: { current: 10, training: 2 } }; // weak healer
    w.host.setVital(1, 10, 1000); // 990 missing → difficulty 1980
    return w;
  };
  const w = mk(90);
  const est = S.estimateKitChance(w.host, w.host.TryGetPlayerStats(), KIT, 1);
  assert.ok(est !== null && est < 0.01, `estimate ${est}`);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", POT], "kit below the minimum chance → potion");
  const w0 = mk(0);
  w0.tick();
  assert.deepEqual(w0.host.calls.at(-1), ["UseItemOnTarget", KIT, ME], "0 = no minimum");
  const wu = mk(90);
  wu.host.stats.skills = {}; // unknown skill ⇒ no estimate ⇒ allowed
  wu.tick();
  assert.deepEqual(wu.host.calls.at(-1), ["UseItemOnTarget", KIT, ME]);
});

// ── dispel ────────────────────────────────────────────────────────────────
const VULN7 = { spellId: 2170, family: 110, layer: 1, level: 7, powerLevel: 325, isBeneficial: false, isCooldown: false, permanent: false, remainingS: 200, casterGuid: MOB };

await run.check("dispel detection: harmful level-7 vuln in the family set → Consumables Dispel gem UseObject; beneficial / level 6 / other family → nothing", () => {
  const mk = (rows) => {
    const w = world({ values: { UseDispelItems: true }, consumables: [E(GEM, "Gem of Stillness", "Dispel")], inv: [F.row(GEM, "Gem of Stillness", { wcid: 9193, itemType: 0x800 })] });
    w.host.ench = rows;
    return w;
  };
  const w = mk([VULN7]);
  assert.equal(w.slot.enabled(), true);
  w.tick();
  assert.deepEqual(w.host.calls, [["UseObject", GEM]]);
  assert.equal(w.host.itemActionToken.owner, "vtsupplies");
  for (const rows of [
    [{ ...VULN7, isBeneficial: true }],
    [{ ...VULN7, level: 6, powerLevel: 275 }],
    [{ ...VULN7, family: 94 }], // fester — not a vulnerability
    [{ ...VULN7, level: 0, powerLevel: 275 }], // no record: power of a level-6
  ]) {
    const x = mk(rows);
    x.tick();
    x.tick();
    assert.equal(x.host.calls.length, 0, JSON.stringify(rows));
  }
  const y = mk([{ ...VULN7, level: 0, powerLevel: 325 }]);
  y.tick();
  assert.equal(y.host.calls.length, 1, "no record: level-7 power 325 counts");
});

await run.check("dispel item fallbacks: the wcid list without a Consumables entry; nameRegex when no wcid matches (critic G4); never a scroll", () => {
  const w = world({ values: { UseDispelItems: true }, inv: [F.row(0x80003001, "Society Gem of Dispelling", { wcid: 38727, itemType: 0x800 })] });
  w.host.ench = [VULN7];
  w.tick();
  assert.deepEqual(w.host.calls, [["UseObject", 0x80003001]], "wcid 38727");
  const w2 = world({ values: { UseDispelItems: true }, inv: [F.row(0x80003002, "Scroll of Dispel Life", { itemType: 0x2000 }), F.row(0x80003003, "Condensed Dispel Potion", { wcid: 77777 })] });
  w2.host.ench = [VULN7];
  w2.tick();
  assert.deepEqual(w2.host.calls, [["UseObject", 0x80003003]], "name match, scroll skipped");
  const w3 = world({ values: { UseDispelItems: true }, inv: [F.row(0x80003004, "Black Potion", { wcid: 1 })] });
  w3.host.ench = [VULN7];
  w3.tick();
  assert.deepEqual(w3.host.calls, [["UseObject", 0x80003004]], "G:26 Black Potions");
});

await run.check("dispel confirmation by disappearance; at most 2 tries per enchantment instance", () => {
  const w = world({ values: { UseDispelItems: true }, consumables: [E(GEM, "Gem of Stillness", "Dispel")], inv: [F.row(GEM, "Gem of Stillness")] });
  w.host.ench = [VULN7];
  w.tick();
  w.host.answer();
  assert.equal(w.host.actions("UseObject").length, 1);
  w.clock.advance(2000);
  w.tick();
  assert.equal(w.host.actions("UseObject").length, 1, "retry waits DISPEL_RETRY_MS");
  w.clock.advance(4000);
  w.tick();
  w.host.answer();
  assert.equal(w.host.actions("UseObject").length, 2, "second try");
  for (let i = 0; i < 5; i++) {
    w.clock.advance(6000);
    w.tick();
    w.host.answer();
  }
  assert.equal(w.host.actions("UseObject").length, 2, "no third try for the same instance");
  // A NEW instance (recast by the mob) gets its own two tries.
  w.host.ench = [{ ...VULN7, casterGuid: MOB + 1 }];
  w.clock.advance(1100);
  w.tick();
  assert.equal(w.host.actions("UseObject").length, 3);
  w.host.answer();
  w.host.ench = [];
  w.clock.advance(1100);
  w.tick();
  assert.equal(w.sup.status().dispelled >= 1, true, "gone ⇒ dispelled");
  assert.equal(w.sup.status().dispelPending, 0);
});

await run.check("Cast dispel self: Magic-mode entry then CastSelf(3194) TARGETED via the cast token vtsupplies; Life level ≤ 7 only; known spell only", () => {
  const caster = F.row(0x80004001, "Wand", { itemType: 0x8000, equipMask: 0x01000000 });
  const w = world({ values: { CastDispelSelf: true }, inv: [caster] });
  w.host.known = [3194];
  w.host.ench = [VULN7];
  w.host.mode = 1;
  w.tick();
  assert.deepEqual(w.host.calls, [["ChangeCombatMode", 8]], "enter Magic first");
  w.tick();
  assert.equal(w.host.actions("ChangeCombatMode").length, 1, "≤ 1 mode request per 3 s (slot holds meanwhile)");
  w.host.mode = 8;
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["CastSelf", 3194]);
  assert.equal(w.host.castToken.owner, "vtsupplies");
  assert.equal(w.host.actions("UseObject").length + w.host.actions("UseItemOnTarget").length, 0);
  // Level-8 incantation (power 400) is beyond Eradicate's reach; Creature-school rows too.
  for (const r of [{ ...VULN7, spellId: 4481, level: 8, powerLevel: 400 }, { ...VULN7, spellId: 2318, family: 38 }]) {
    const x = world({ values: { CastDispelSelf: true }, inv: [caster] });
    x.host.known = [3194];
    x.host.mode = 8;
    x.host.ench = [r];
    x.tick();
    x.tick();
    assert.equal(x.host.calls.length, 0, JSON.stringify(r));
  }
  const u = world({ values: { CastDispelSelf: true }, inv: [caster] });
  u.host.mode = 8;
  u.host.ench = [VULN7];
  u.tick();
  assert.equal(u.host.calls.length, 0, "3194 not in the spellbook");
  const nc = world({ values: { CastDispelSelf: true }, inv: [F.row(0x80004002, "Sword", { itemType: 0x1, equipMask: 0x00100000 })] });
  nc.host.known = [3194];
  nc.host.ench = [VULN7];
  for (let i = 0; i < 10; i++) nc.tick();
  assert.equal(nc.host.actions("ChangeCombatMode").length, 0, "no caster wielded: no mode thrash");
  assert.equal(nc.sup.status().castBlocked, "no-caster");
});

await run.check("cast refusal classes: missing components holds the dispel cast 60 s", () => {
  const w = world({ values: { CastDispelSelf: true }, inv: [F.row(0x80004001, "Wand", { itemType: 0x8000, equipMask: 0x01000000 })] });
  w.host.known = [3194];
  w.host.ench = [VULN7];
  w.host.mode = 8;
  w.tick();
  assert.equal(w.host.actions("CastSelf").length, 1);
  w.bus.emit({ type: "useFailed", code: 0x0400, text: "You don't have all the components" });
  w.host.useDone();
  assert.equal(w.sup.status().castBlocked, "components");
  w.clock.advance(6000);
  w.tick();
  assert.equal(w.host.actions("CastSelf").length, 1, "held");
});

await run.check("UseDispelItems wins over the cast when both are on and a gem is owned", () => {
  const w = world({ values: { CastDispelSelf: true, UseDispelItems: true }, consumables: [E(GEM, "Gem of Stillness", "Dispel")], inv: [F.row(GEM, "Gem of Stillness")] });
  w.host.known = [3194];
  w.host.mode = 8;
  w.host.ench = [VULN7];
  w.tick();
  assert.deepEqual(w.host.calls, [["UseObject", GEM]]);
});

await run.check("dispel waits for its data (harmful_families not loaded ⇒ feature not ready)", async () => {
  C.setSupportData("harmful_families", null);
  const w = world({ values: { UseDispelItems: true }, consumables: [E(GEM, "Gem of Stillness", "Dispel")], inv: [F.row(GEM, "Gem of Stillness")] });
  w.host.ench = [VULN7];
  w.tick();
  assert.equal(w.host.calls.length, 0);
  await C.loadSupportJson("harmful_families");
  w.tick();
  assert.equal(w.host.calls.length, 1);
});

// ── grenades ──────────────────────────────────────────────────────────────
await run.check("grenades: gated off at GrenadeMinMonsters 0; on: ≥ N monsters within RingRange → UseItemOnTarget(grenade, lock)", () => {
  const combat = F.makeCombat({ locked: MOB, targets: [{ guid: MOB, dist: 3 }, { guid: MOB + 1, dist: 4 }, { guid: MOB + 2, dist: 9 }] });
  const list = [E(GREN, "Gold Phial of Fire Vulnerability", "Grenade")];
  const inv = [F.row(GREN, "Gold Phial of Fire Vulnerability", { itemType: 0x100 })];
  const off = world({ consumables: list, inv, combat });
  assert.equal(off.slot.enabled(), false, "GrenadeMinMonsters 0 = off (default, UNVERIFIED on ACE)");
  off.tick();
  assert.equal(off.host.calls.length, 0);
  const on = world({ values: { GrenadeMinMonsters: 2 }, consumables: list, inv, combat });
  on.tick(F.ctx({ inCombat: true }));
  assert.deepEqual(on.host.calls, [["UseItemOnTarget", GREN, MOB]]);
  const few = world({ values: { GrenadeMinMonsters: 3 }, consumables: list, inv, combat });
  few.tick(F.ctx({ inCombat: true }));
  assert.equal(few.host.calls.length, 0, "only 2 within RingRange 5");
  const nolock = world({ values: { GrenadeMinMonsters: 1 }, consumables: list, inv, combat: F.makeCombat({ targets: combat.targets }) });
  nolock.tick();
  assert.equal(nolock.host.calls.length, 0, "no lock, no grenade");
});

await run.check("holds: portal space, busy, another owner's item token, a live cast claim (V-12, C8)", () => {
  const mk = () => {
    const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit")], inv: [kitRow()] });
    w.host.setVital(1, 40);
    return w;
  };
  const p = mk();
  p.host.portal = true;
  p.tick();
  assert.equal(p.host.calls.length, 0, "portal space");
  const b = mk();
  b.host.busy = 1;
  b.tick();
  assert.equal(b.host.calls.length, 0, "busy");
  const o = mk();
  o.host.tryClaimItemAction("vtmana");
  o.tick();
  assert.equal(o.host.calls.length, 0, "item token held by vtmana");
  const c = mk();
  c.host.tryClaimCast("combat");
  c.tick();
  assert.equal(c.host.calls.length, 0, "a combat cast is still open");
  c.host.useDone();
  c.clock.advance(100);
  c.tick();
  assert.equal(c.host.calls.length, 1, "resolved cast claim no longer holds");
});

await run.check("a refused use (kind 13) parks that item 30 s; never throws on a hostile host", () => {
  const w = world({ consumables: [E(KIT, "Healing Kit", "HealthKit"), E(POT, "Health Elixir", "HealthPotion")], inv: [kitRow(), potRow()] });
  w.host.setVital(1, 40);
  w.tick();
  w.bus.emit({ type: "useFailed", code: 0x0036, text: "You can't do that" });
  w.host.answer();
  w.clock.advance(1500);
  w.tick();
  assert.deepEqual(w.host.calls.at(-1), ["UseObject", POT], "kit parked → potion");
  const hostile = new Proxy({}, { get: () => () => { throw new Error("boom"); } });
  const sup = S.createSupplies({ host: hostile, options: F.makeOptions({ UseDispelItems: true }), consumables: null, log: () => {} });
  assert.doesNotThrow(() => {
    sup.slot.enabled();
    sup.slot.wants(F.ctx());
    sup.slot.tick(F.ctx());
    sup.slot.pinned();
    sup.status();
  });
  sup.dispose();
});

console.log(run.fail === 0 ? `rynth_vt_support_vitals: all ${run.pass} checks passed` : `rynth_vt_support_vitals: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
