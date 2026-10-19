// tests/rynth_vt_support_loot.test.mjs — rynth/vt/support/scrolls.js (the
// "ReadScrolls" slot: Read Unknown Scrolls / the .utl Read action) and
// rynth/vt/support/salvage.js (the "Salvage" slot: the .utl Salvage action and
// Combine Salvage), 2026-10-19.
//
//   Z1     both slots inert with nothing handed over (Z2)
//   SC1-8  reading: one scroll at a time under the item token, settled by the
//          answer line / the spellbook / the inventory; a refusal keeps it; a
//          UseDone with no answer line (ACE's "too busy") and no answer at all
//          are tried again (3 tries), UseDones counted only while the slot
//          holds the tick; known meanwhile, gone, no longer learnable (ACE's
//          rule on the current skill) or ReadUnknownScrolls off = kept unread;
//          the gate, and nothing starts while loot.corpseWorkPending()
//   SB1-4  bands: parse, GetRangeIndex, bag workmanship, the profile's block
//          vs VTClassic's defaults (the RynDQL corpus fixture)
//   SP1-3  planCombine: one band of one material, smallest first, ≤ 100
//          units, ≤ 75,000 value, ≥ 2 bags
//   SV1-6  salvaging with the Ust (what is sent, what is kept), the combine
//          after it, after a corpse, never without a profile or with
//          CombineSalvage off, a send that fails, nothing while
//          loot.corpseWorkPending(), a combine that does nothing
//
// Everything outside rynth/vt/support/ is a fake (rynth/testdata/vt/support/
// fakes.mjs, plus CreateTinkeringTool and a loot loop with takeWork).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_loot.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const SC = await import("../rynth/vt/support/scrolls.js");
const SV = await import("../rynth/vt/support/salvage.js");
const { parseUtl } = await import("../rynth/vt/formats/utl.js");

const run = F.makeRunner();
const ME = 0x50000001;
const UST = 0x80006001;
const ctx = F.ctx();

// A loot loop fake with the hand-over the real one has (rynth/loot_loop.js).
function makeLoot() {
  const loot = { enabled: true, state: "SCAN", lootedCount: 0, work: [] };
  loot.takeWork = (purpose) => {
    const out = loot.work.filter((w) => w.purpose === purpose);
    loot.work = loot.work.filter((w) => w.purpose !== purpose);
    return out.map((w) => ({ guid: w.guid, spellId: w.spellId || 0, at: 0 }));
  };
  return loot;
}

function base({ values = {}, inv = [], profile = null } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME });
  host.inv = inv.map((r) => ({ ...r }));
  host.CreateTinkeringTool = (tool, items) => {
    host.calls.push(["CreateTinkeringTool", tool >>> 0, Array.from(items, (g) => g >>> 0)]);
    return host.sendOk;
  };
  const options = F.makeOptions({ ReadUnknownScrolls: true, CombineSalvage: true, ...values });
  const bus = F.makeBus();
  const loot = makeLoot();
  const bot = { loot, combat: F.makeCombat(), buff: null };
  const prof = { p: profile };
  const deps = { host, bot, options, subscribe: bus.on, now: clock.now, log: () => {}, lootProfile: () => prof.p };
  return { clock, host, options, bus, loot, bot, deps, prof };
}
// One kernel tick offered to `slot` (it runs only when it wants the tick).
function drive(w, slot, ms = 100) {
  w.clock.advance(ms);
  if (slot.enabled() && slot.wants(ctx)) {
    slot.tick(ctx);
    return true;
  }
  return false;
}

// ── Z ──────────────────────────────────────────────────────────────────────
await run.check("Z1 both slots are inert with nothing handed over: disabled, no host action", () => {
  const w = base({ inv: [F.row(UST, "Ust", { wcid: SV.UST_WCID })] });
  const sc = SC.createScrolls(w.deps);
  const sv = SV.createSalvage(w.deps);
  for (let i = 0; i < 30; i++) {
    drive(w, sc.slot);
    drive(w, sv.slot);
  }
  assert.equal(sc.slot.enabled(), false);
  assert.equal(sv.slot.enabled(), false);
  assert.equal(w.host.calls.length, 0);
  assert.equal(sc.slot.name, "ReadScrolls");
  assert.equal(sv.slot.name, "Salvage");
  assert.equal(sc.slot.rank, "beforeIdle");
  assert.equal(sv.slot.rank, "beforeIdle");
  w.loot.lootedCount = 3; // a corpse, but no profile bound: nothing to combine
  assert.equal(sv.slot.enabled(), false);
});

// ── scrolls ───────────────────────────────────────────────────────────────
const SCROLL = 0x80007001;
const SCROLL2 = 0x80007002;
function scrollWorld(opts = {}) {
  const w = base({ inv: [F.row(SCROLL, "Scroll of Heal Self VI", { itemType: 0x2000 }), F.row(SCROLL2, "Scroll of Heal Self VI", { itemType: 0x2000 })], ...opts });
  w.host.spells.set(1001, { id: 1001, name: "Heal Self VI", school: 2, power: 250 }); // Life → skill 33
  w.host.stats.skills = { 33: { current: 220, training: 2 } }; // ACE: trained and ≥ 250 − 50
  w.sc = SC.createScrolls(w.deps);
  w.hand = (guid, spellId) => w.loot.work.push({ guid, purpose: "read", spellId });
  w.say = (text, cat = 0) => w.bus.emit({ type: "chat", text, chatType: 0, cat });
  w.useDone = () => w.bus.emit({ type: "useDone" });
  return w;
}
await run.check("SC1 a handed-over scroll is read (UseObject under the item token) and settled by 'The scroll is destroyed.'", () => {
  const w = scrollWorld();
  w.hand(SCROLL, 1001);
  assert.equal(w.sc.slot.enabled(), true);
  assert.equal(drive(w, w.sc.slot), true);
  assert.deepEqual(w.host.actions("UseObject"), [["UseObject", SCROLL]]);
  assert.equal(w.host.itemActionToken?.owner, "vtscrolls");
  assert.equal(w.sc.slot.wants(ctx), true, "keeps the tick while the read is in flight");
  drive(w, w.sc.slot);
  assert.equal(w.host.actions("UseObject").length, 1, "one at a time");
  w.say("The scroll is destroyed.");
  w.host.inv = w.host.inv.filter((r) => r.guid !== SCROLL);
  drive(w, w.sc.slot);
  assert.equal(w.sc.status().read, 1);
  assert.equal(w.host.itemActionToken, null, "token released");
  assert.equal(w.sc.slot.enabled(), false);
});
await run.check("SC2 settled by the spellbook too; a second copy of a known spell is kept unread", () => {
  const w = scrollWorld();
  w.hand(SCROLL, 1001);
  w.hand(SCROLL2, 1001);
  drive(w, w.sc.slot);
  w.host.known = [1001]; // learned (the line got lost)
  drive(w, w.sc.slot, SC.SCROLL_TUNING.KNOWN_CACHE_MS + 100); // the spellbook is re-read at most once a second
  assert.equal(w.sc.status().read, 1);
  w.clock.advance(2000);
  for (let i = 0; i < 5; i++) drive(w, w.sc.slot);
  assert.equal(w.host.actions("UseObject").length, 1, "the copy is not read");
  assert.equal(w.sc.status().kept, 1);
  assert.equal(w.sc.slot.enabled(), false);
});
await run.check("SC3 a refusal line keeps the scroll unread; 'You already know that spell!' too", () => {
  for (const line of ["You are not skilled enough in Life Magic to learn this spell.", "You are not trained in Life Magic!", "You already know that spell!"]) {
    const w = scrollWorld();
    w.hand(SCROLL, 1001);
    drive(w, w.sc.slot);
    w.say(line);
    drive(w, w.sc.slot);
    assert.equal(w.sc.status().kept, 1, line);
    assert.equal(w.sc.status().read, 0, line);
    w.clock.advance(5000);
    for (let i = 0; i < 5; i++) drive(w, w.sc.slot);
    assert.equal(w.host.actions("UseObject").length, 1, `${line}: not tried again`);
  }
  assert.equal(SC.parseReadLine("Bob says, \"You already know that spell!\""), null);
});
await run.check("SC4 a UseDone with no answer line (ACE's 'too busy' WeenieError is only chat): not read — tried again after the grace + 1.5 s; no answer in 10 s too; 3 tries in all", () => {
  const w = scrollWorld();
  w.hand(SCROLL, 1001);
  drive(w, w.sc.slot);
  w.say("You're too busy!"); // what the client makes of the WeenieError: not an answer
  w.useDone(); // ACE's plain UseDone right after
  drive(w, w.sc.slot, 400);
  assert.equal(w.sc.status().pending?.guid, SCROLL, "within the 0.5 s grace: still pending");
  drive(w, w.sc.slot, 200); // past the grace: not read, back in the queue
  assert.equal(w.sc.status().pending, null);
  assert.equal(w.sc.status().queued, 1);
  assert.equal(w.host.itemActionToken, null, "token released");
  drive(w, w.sc.slot, 1000);
  assert.equal(w.host.actions("UseObject").length, 1, "waits out RETRY_MS");
  drive(w, w.sc.slot, 600);
  assert.equal(w.host.actions("UseObject").length, 2, "tried again");
  drive(w, w.sc.slot, 10_100); // no answer at all
  drive(w, w.sc.slot, 1600);
  assert.equal(w.host.actions("UseObject").length, 3, "third try");
  drive(w, w.sc.slot, 10_100);
  for (let i = 0; i < 5; i++) drive(w, w.sc.slot, 2000);
  assert.equal(w.host.actions("UseObject").length, 3, "no fourth");
  assert.equal(w.sc.status().failures, 1);
  assert.equal(w.sc.slot.enabled(), false);
});
await run.check("SC4b a real read: the answer line comes before its UseDone — read, no retry; a UseDone while another loop holds the tick is not ours", () => {
  const w = scrollWorld();
  w.hand(SCROLL, 1001);
  drive(w, w.sc.slot);
  w.say("The scroll is destroyed.");
  w.useDone();
  w.host.inv = w.host.inv.filter((r) => r.guid !== SCROLL);
  drive(w, w.sc.slot, 600);
  assert.equal(w.sc.status().read, 1);
  for (let i = 0; i < 10; i++) drive(w, w.sc.slot, 600);
  assert.equal(w.host.actions("UseObject").length, 1);
  const k = scrollWorld();
  k.bot.kernel = { action: "ReadScrolls" };
  k.hand(SCROLL, 1001);
  drive(k, k.sc.slot);
  k.bot.kernel.action = "Buffing"; // a cast's UseDone
  k.useDone();
  drive(k, k.sc.slot, 1000);
  assert.equal(k.sc.status().pending?.guid, SCROLL, "not counted: still pending");
  k.bot.kernel.action = "ReadScrolls";
  k.useDone();
  drive(k, k.sc.slot, 600);
  assert.equal(k.sc.status().pending, null, "ours: not read, back in the queue");
  assert.equal(k.sc.status().queued, 1);
});
await run.check("SC7 no read starts while the loot loop is at a corpse or about to be (corpseWorkPending)", () => {
  const w = scrollWorld();
  let busy = true;
  w.loot.corpseWorkPending = () => busy;
  w.hand(SCROLL, 1001);
  for (let i = 0; i < 10; i++) assert.equal(drive(w, w.sc.slot), false);
  assert.equal(w.host.actions("UseObject").length, 0);
  assert.equal(w.sc.slot.enabled(), true, "still waiting to read");
  busy = false;
  assert.equal(drive(w, w.sc.slot), true);
  assert.equal(w.host.actions("UseObject").length, 1);
  w.loot.enabled = false; // looting off: never "at a corpse"
  busy = true;
  w.hand(SCROLL2, 1002);
  w.host.spells.set(1002, { id: 1002, school: 2, power: 1 });
  w.say("The scroll is destroyed.");
  drive(w, w.sc.slot); // settles the first
  drive(w, w.sc.slot, 1600);
  assert.equal(w.host.actions("UseObject").length, 2);
});
await run.check("SC8 ACE's rule is judged again at read time: a skill that dropped since the pickup keeps the scroll unread", () => {
  const w = scrollWorld();
  w.host.stats.skills = { 33: { current: 199, training: 2 } }; // 199 < 250 − 50
  w.hand(SCROLL, 1001);
  drive(w, w.sc.slot);
  assert.equal(w.host.actions("UseObject").length, 0);
  assert.equal(w.sc.status().kept, 1);
  const lvl7 = scrollWorld();
  lvl7.host.spells.set(1007, { id: 1007, school: 2, power: 300 });
  lvl7.host.stats.skills = {}; // nothing known of the school: level 7 is free (ACE)
  lvl7.hand(SCROLL, 1007);
  drive(lvl7, lvl7.sc.slot);
  assert.equal(lvl7.host.actions("UseObject").length, 1);
});
await run.check("SC5 kept unread: a scroll gone from the pack, or while ReadUnknownScrolls is off", () => {
  const w = scrollWorld({ values: { ReadUnknownScrolls: false } });
  w.hand(SCROLL, 1001);
  drive(w, w.sc.slot);
  assert.equal(w.host.actions("UseObject").length, 0);
  assert.equal(w.sc.status().kept, 1);
  const w2 = scrollWorld();
  w2.host.inv = [];
  w2.hand(SCROLL, 1001);
  drive(w2, w2.sc.slot);
  assert.equal(w2.host.actions("UseObject").length, 0);
  assert.equal(w2.sc.status().kept, 1);
});
await run.check("SC6 the gate: not mid-corpse, busy, in portal space, another item action or a cast in flight", () => {
  const w = scrollWorld();
  w.hand(SCROLL, 1001);
  const shut = [
    () => (w.loot.state = "LOOT"),
    () => (w.host.busy = 1),
    () => (w.host.portal = true),
    () => w.host.tryClaimItemAction("vtsupplies"),
    () => w.host.tryClaimCast("buff"),
  ];
  for (const close of shut) {
    close();
    assert.equal(drive(w, w.sc.slot), false);
    w.loot.state = "SCAN";
    w.host.busy = 0;
    w.host.portal = false;
    w.host.releaseItemAction("vtsupplies");
    w.host.releaseCast("buff");
  }
  assert.equal(w.host.actions("UseObject").length, 0);
  assert.equal(drive(w, w.sc.slot), true, "open again: reads");
});

// ── bands ─────────────────────────────────────────────────────────────────
await run.check("SB1 parseSalvageBands / salvageBandIndex: ranges, a gap counts below, past the last is its own band", () => {
  const r = SV.parseSalvageBands("1-6, 7-8, 9, 10");
  assert.deepEqual(r, [[1, 6], [7, 8], [9, 9], [10, 10]]);
  assert.deepEqual(SV.parseSalvageBands("1-5;8-10, junk, 3-"), [[1, 5], [8, 10]]);
  assert.deepEqual(SV.parseSalvageBands(""), []);
  const idx = (w) => SV.salvageBandIndex(r, w);
  assert.deepEqual([1, 6, 6.9, 7, 8.5, 9, 10, 11].map(idx), [0, 0, 0, 1, 1, 2, 3, 4]);
  const gap = SV.parseSalvageBands("1-5, 8-10");
  assert.equal(SV.salvageBandIndex(gap, 6), 0, "a gap goes with the range below");
  assert.equal(SV.salvageBandIndex(gap, 0.5), -1, "below the first range");
  assert.equal(SV.salvageBandIndex([], 7), 0, "an empty string is one band");
});
await run.check("SB2 bagWorkmanship: the truncated average before an appraisal, sum / count after", () => {
  assert.equal(SV.bagWorkmanship(7, undefined), 7);
  assert.equal(SV.bagWorkmanship(75, 10), 7.5);
  assert.equal(SV.bagWorkmanship(7, 10), 7, "an average re-sent after the appraisal");
  assert.ok(Number.isNaN(SV.bagWorkmanship(undefined, 3)));
  assert.ok(Number.isNaN(SV.bagWorkmanship(0, 3)));
});
await run.check("SB3 the RynDQL corpus profile's block: default '1-6, 7-8, 9, 10', its 25 materials '1-10'; `enabled` is the format version", () => {
  const text = readFileSync(new URL("../rynth/testdata/vt/loot/RynDQLLootProfile-b0afe37e9d557746.utl", import.meta.url), "utf8");
  const r = parseUtl(text);
  assert.ok(r.ok);
  const b = SV.combineBandsOf(r.profile);
  assert.equal(b.defaultBands, "1-6, 7-8, 9, 10");
  assert.equal(b.materials.size, 25);
  assert.equal(b.materials.get(10), "1-10");
  assert.deepEqual([...b.materials.keys()].sort((x, y) => x - y), [...SV.COMBINE_ANY_MATERIALS].sort((x, y) => x - y), "VTClassic's defaults are these 25");
  assert.equal(r.profile.salvageCombine.version, "277", "line 1 is the block's char length");
});
await run.check("SB4 a profile without the block gets VTClassic's defaults", () => {
  const b = SV.combineBandsOf({ version: 1, rules: [] });
  assert.equal(b.defaultBands, SV.COMBINE_DEFAULT_BANDS);
  assert.equal(b.materials.get(14), "1-10");
  assert.equal(b.materials.has(20), false);
});

// ── planCombine ───────────────────────────────────────────────────────────
const BANDS = SV.combineBandsOf(null); // VTClassic defaults
const bag = (guid, material, units, workmanship, value) => ({ guid, material, units, workmanship, value });
await run.check("SP1 one band of one material, smallest first, ≥ 2 bags (6.5 joins '1-6': a gap counts below)", () => {
  // material 20 (default bands): 40u w5, 20u w3, 10u w6.5 → band "1-6"; 30u w7 → "7-8" alone
  const plan = SV.planCombine([bag(1, 20, 40, 5), bag(2, 20, 30, 7), bag(3, 20, 20, 3), bag(4, 20, 10, 6.5)], BANDS);
  assert.deepEqual(plan, { material: 20, band: 0, guids: [4, 3, 1], units: 70, value: 0 });
  assert.equal(SV.planCombine([bag(1, 20, 40, 5), bag(2, 20, 30, 7)], BANDS), null, "two bands: nothing");
  assert.equal(SV.planCombine([bag(1, 20, 40, 5), bag(2, 21, 30, 5)], BANDS), null, "two materials: nothing");
  // material 14 is "1-10" by default: any workmanship combines
  assert.deepEqual(SV.planCombine([bag(5, 14, 40, 2), bag(6, 14, 30, 10)], BANDS).guids, [6, 5]);
});
await run.check("SP2 never past 100 units (ACE loses the rest) nor 75,000 value; full bags are left out", () => {
  const plan = SV.planCombine([bag(1, 20, 60, 5), bag(2, 20, 55, 5), bag(3, 20, 46, 4), bag(4, 20, 100, 5)], BANDS);
  assert.equal(plan, null, "46 + 55 > 100; the full bag is not a candidate");
  const two = SV.planCombine([bag(1, 20, 60, 5), bag(2, 20, 30, 5), bag(3, 20, 10, 4)], BANDS);
  assert.deepEqual(two.guids, [3, 2, 1], "10 + 30 + 60 = 100 exactly");
  const rich = SV.planCombine([bag(1, 20, 10, 5, 50_000), bag(2, 20, 20, 5, 30_000), bag(3, 20, 30, 5, 20_000)], BANDS);
  assert.deepEqual(rich.guids, [1, 3], "50,000 + 30,000 > 75,000: the next one that fits");
  assert.equal(rich.value, 70_000);
  assert.equal(SV.planCombine([bag(1, 20, 10, NaN), bag(2, 20, 20, NaN)], BANDS), null, "workmanship unknown: not combined");
});
await run.check("SP3 the profile's own bands decide; materials in order", () => {
  const own = SV.combineBandsOf({ salvageCombine: { version: "20", enabled: true, defaultBands: "1-10", materials: [{ material: 21, bands: "1-5, 6-10" }] } });
  assert.deepEqual(SV.planCombine([bag(1, 20, 40, 2), bag(2, 20, 30, 9)], own).guids, [2, 1], "default 1-10");
  assert.equal(SV.planCombine([bag(3, 21, 40, 2), bag(4, 21, 30, 9)], own), null, "material 21: 1-5 | 6-10");
  const both = SV.planCombine([bag(5, 22, 10, 5), bag(6, 22, 10, 5), bag(7, 20, 10, 5), bag(8, 20, 10, 5)], own);
  assert.equal(both.material, 20, "the lower material first");
});

// ── salvaging and combining ───────────────────────────────────────────────
const ROBE = 0x80008001;
const GEM = 0x80008002;
const OLDBAG = 0x80008003;
const KEPT = 0x80008004;
const BAG_IT = 0x40000000;
function salvageWorld(opts = {}) {
  const w = base({
    inv: [
      F.row(UST, "Ust", { wcid: SV.UST_WCID, itemType: 0x20000000 }),
      F.row(ROBE, "Robe", { itemType: 0x4 }),
      F.row(GEM, "Gem", { itemType: 0x800 }),
      F.row(OLDBAG, "Salvage (50)", { itemType: BAG_IT }),
      F.row(KEPT, "Shield", { itemType: 0x2 }),
    ],
    profile: { version: 1, rules: [] },
    ...opts,
  });
  const set = (g, p, v) => w.host.setInt(g, p, v);
  set(ROBE, 131, 20); // Linen
  set(ROBE, 105, 6);
  set(GEM, 131, 21);
  set(GEM, 105, 8);
  set(KEPT, 131, 22);
  set(KEPT, 105, 5);
  w.host.setBool(KEPT, 91, true); // Retained
  set(OLDBAG, 131, 20);
  set(OLDBAG, 92, 50);
  set(OLDBAG, 105, 5);
  w.sv = SV.createSalvage(w.deps);
  w.hand = (...gs) => {
    for (const g of gs) w.loot.work.push({ guid: g, purpose: "salvage" });
  };
  // The server: salvage → the items go, one new bag per material appears.
  w.serve = (bags) => {
    const sent = w.host.actions("CreateTinkeringTool").at(-1)[2];
    w.host.inv = w.host.inv.filter((r) => !sent.includes(r.guid));
    for (const b of bags) {
      w.host.inv.push(F.row(b.guid, `Salvage (${b.units})`, { itemType: BAG_IT }));
      set(b.guid, 131, b.material);
      set(b.guid, 92, b.units);
      set(b.guid, 105, b.w);
    }
    w.host.answer();
  };
  return w;
}
await run.check("SV1 the Salvage rule's items go to the Ust in one CreateTinkeringTool; retained / bags / no material are kept", () => {
  const w = salvageWorld();
  const NOMAT = 0x80008005;
  w.host.inv.push(F.row(NOMAT, "Pyreal Mote", {}));
  w.hand(ROBE, GEM, OLDBAG, KEPT, NOMAT, 0x80008fff);
  assert.equal(drive(w, w.sv.slot), true);
  assert.deepEqual(w.host.actions("CreateTinkeringTool"), [["CreateTinkeringTool", UST, [ROBE, GEM]]]);
  assert.equal(w.host.itemActionToken?.owner, "vtsalvage");
  assert.equal(w.sv.status().kept, 4, "the bag, the retained shield, the mote, the missing guid");
  assert.equal(w.sv.slot.wants(ctx), true, "keeps the tick until the inventory answers");
});
await run.check("SV2 after the salvage the new bag is combined with the old one in its band (CombineSalvage)", () => {
  const w = salvageWorld();
  w.hand(ROBE, GEM);
  drive(w, w.sv.slot);
  w.serve([{ guid: 0x80008101, material: 20, units: 12, w: 6 }, { guid: 0x80008102, material: 21, units: 9, w: 8 }]);
  drive(w, w.sv.slot); // settled
  assert.equal(w.sv.status().salvaged, 2);
  assert.equal(w.host.itemActionToken, null);
  drive(w, w.sv.slot, 600);
  assert.deepEqual(w.host.actions("CreateTinkeringTool").at(-1), ["CreateTinkeringTool", UST, [0x80008101, OLDBAG]], "linen 12 (w6) + 50 (w5): band 1-6, 62 units");
  w.serve([{ guid: 0x80008103, material: 20, units: 62, w: 5 }]);
  drive(w, w.sv.slot);
  assert.equal(w.sv.status().combined, 1);
  for (let i = 0; i < 10; i++) drive(w, w.sv.slot, 600);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 2, "nothing left to combine");
  assert.equal(w.sv.slot.enabled(), false);
});
await run.check("SV3 after a corpse (loot.lootedCount moved) a combine pass runs; not mid-corpse", () => {
  const w = salvageWorld();
  w.host.inv.push(F.row(0x80008201, "Salvage (20)", { itemType: BAG_IT }));
  w.host.setInt(0x80008201, 131, 20);
  w.host.setInt(0x80008201, 92, 20);
  w.host.setInt(0x80008201, 105, 3);
  assert.equal(w.sv.slot.enabled(), false, "nothing due yet (the bags were there before)");
  w.loot.lootedCount = 2;
  w.loot.state = "LOOT";
  assert.equal(w.sv.slot.enabled(), false, "mid-corpse: not yet");
  w.loot.state = "SCAN";
  assert.equal(w.sv.slot.enabled(), true);
  drive(w, w.sv.slot);
  assert.deepEqual(w.host.actions("CreateTinkeringTool"), [["CreateTinkeringTool", UST, [0x80008201, OLDBAG]]]);
});
await run.check("SV4 no combining without a loot profile, or with CombineSalvage off; salvaging still happens", () => {
  for (const opts of [{ profile: null }, { values: { CombineSalvage: false } }]) {
    const w = salvageWorld(opts);
    w.hand(ROBE);
    drive(w, w.sv.slot);
    w.serve([{ guid: 0x80008301, material: 20, units: 12, w: 6 }]);
    for (let i = 0; i < 10; i++) drive(w, w.sv.slot, 600);
    assert.equal(w.host.actions("CreateTinkeringTool").length, 1, JSON.stringify(opts));
    assert.equal(w.sv.slot.enabled(), false);
  }
});
await run.check("SV5 no Ust: nothing is sent, the items are kept", () => {
  const w = salvageWorld();
  w.host.inv = w.host.inv.filter((r) => r.guid !== UST);
  w.hand(ROBE, GEM);
  drive(w, w.sv.slot);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 0);
  assert.equal(w.sv.status().kept, 2);
  assert.equal(w.sv.slot.enabled(), false);
});
await run.check("SV5b a host that cannot send CreateTinkeringTool (stale pkg): the items are kept, never retried in a loop", () => {
  const w = salvageWorld();
  w.host.sendOk = false; // the fake's action members answer false, like _act without the capability
  w.hand(ROBE, GEM);
  drive(w, w.sv.slot);
  for (let i = 0; i < 20; i++) drive(w, w.sv.slot, 600);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 1, "one attempt");
  assert.equal(w.sv.status().kept, 2);
  assert.equal(w.host.itemActionToken, null, "token released");
  w.loot.lootedCount = 5; // a corpse: a combine is due — and cannot be sent either
  w.host.inv.push(F.row(0x80008501, "Salvage (20)", { itemType: BAG_IT }));
  w.host.setInt(0x80008501, 131, 20);
  w.host.setInt(0x80008501, 92, 20);
  w.host.setInt(0x80008501, 105, 5);
  for (let i = 0; i < 20; i++) drive(w, w.sv.slot, 600);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 2, "one combine attempt");
  assert.equal(w.sv.slot.enabled(), false);
});
await run.check("SV5c nothing is sent while the loot loop is at a corpse or about to be (corpseWorkPending)", () => {
  const w = salvageWorld();
  let busy = true;
  w.loot.corpseWorkPending = () => busy;
  w.hand(ROBE);
  for (let i = 0; i < 10; i++) assert.equal(drive(w, w.sv.slot), false);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 0);
  busy = false;
  assert.equal(drive(w, w.sv.slot), true);
  assert.equal(w.host.actions("CreateTinkeringTool").length, 1);
});
await run.check("SV6 items the server did not salvage are kept after CONFIRM_MS; a combine that did nothing leaves those bags alone", () => {
  const w = salvageWorld();
  w.hand(ROBE);
  drive(w, w.sv.slot);
  drive(w, w.sv.slot, SV.SALVAGE_TUNING.CONFIRM_MS + 100);
  assert.equal(w.sv.status().kept, 1);
  assert.equal(w.sv.status().failures, 1);
  assert.equal(w.host.itemActionToken, null);
  const w2 = salvageWorld();
  w2.host.inv.push(F.row(0x80008401, "Salvage (20)", { itemType: BAG_IT }));
  w2.host.setInt(0x80008401, 131, 20);
  w2.host.setInt(0x80008401, 92, 20);
  w2.host.setInt(0x80008401, 105, 3);
  w2.loot.lootedCount = 0;
  w2.sv.slot.enabled(); // first look
  w2.loot.lootedCount = 1;
  drive(w2, w2.sv.slot);
  assert.equal(w2.host.actions("CreateTinkeringTool").length, 1);
  drive(w2, w2.sv.slot, SV.SALVAGE_TUNING.CONFIRM_MS + 100); // the bags stay
  for (let i = 0; i < 10; i++) drive(w2, w2.sv.slot, 600);
  assert.equal(w2.host.actions("CreateTinkeringTool").length, 1, "not sent again");
  assert.equal(w2.sv.slot.enabled(), false);
});

console.log(run.fail === 0 ? `rynth_vt_support_loot: all ${run.pass} checks passed` : `rynth_vt_support_loot: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
