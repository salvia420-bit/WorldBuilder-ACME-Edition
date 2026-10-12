// tests/rynth_vt_support_inventory.test.mjs — rynth/vt/support/inventory_mgr.js,
// mana_stones.js and buff_items.js (PLAN W1-9 SUP, §3.11; O11-O12, O16, C1-C2,
// C4, C6; V-13, V-22).
//
// Autostack amount rule (ACE Player_Inventory.cs:3088) + backoff; autocram
// target choice (≥ 2 free, most free, Items tab excluded); pea splitting; the
// mana-stone drain/refill priorities, the HARD GUARD (U4 H5) and "M. Charges
// when off" (refill only); buff items (< 300 s rejected, used when the family
// is low and no castable spell covers it); and the critic-B4 gate (nothing
// while the kernel is Looting/Fighting).
//
// Everything outside rynth/vt/support/ is a fake (C2,
// rynth/testdata/vt/support/fakes.mjs).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_support_inventory.test.mjs

import assert from "node:assert/strict";

const F = await import("../rynth/testdata/vt/support/fakes.mjs");
const C = await import("../rynth/vt/support/consumables.js");
const INV = await import("../rynth/vt/support/inventory_mgr.js");
const M = await import("../rynth/vt/support/mana_stones.js");
const B = await import("../rynth/vt/support/buff_items.js");
await C.loadSupportData();

const run = F.makeRunner();
const ME = 0x50000001;
const IDLE = { held: false, kernelAction: "Idle", running: true };

function base({ values = {}, lists = {}, inv = [], items = [] } = {}) {
  const clock = F.makeClock();
  const host = F.makeHost(clock, { me: ME });
  host.inv = inv.map((r) => ({ ...r })); // worlds never share row objects
  const options = F.makeOptions(values, lists);
  const bus = F.makeBus();
  const bot = { loot: { enabled: true, state: "SCAN" }, combat: F.makeCombat(), buff: null };
  const consumables = new C.ConsumablesModel({ options, host, now: clock.now, log: () => {} });
  const itemsModel = F.makeItems(items);
  const deps = { host, bot, options, subscribe: bus.on, consumables, items: itemsModel, now: clock.now, log: () => {} };
  return { clock, host, options, bus, bot, consumables, deps };
}

// ── inventory manager ─────────────────────────────────────────────────────
const PACK_A = 0x80005001;
const PACK_B = 0x80005002;
const pack = (g, cap, name = "Pack") => F.row(g, name, { itemType: 0x200, requiresBackpackSlot: true, itemsCapacity: cap });
const inPack = (g, p, name = "junk") => F.row(g, name, { containerId: p });

function invWorld(opts = {}) {
  const w = base(opts);
  w.mgr = INV.createInventoryMgr(w.deps);
  w.tick = (info = IDLE, ms = 600) => {
    w.clock.advance(ms);
    w.mgr.reflex.tick(w.clock.t, info);
  };
  return w;
}

await run.check("every reflex/slot of this suite is inert at the schema defaults with empty lists (Z2)", () => {
  const w = base({ inv: [F.row(1, "Pyreal", { stackSize: 10, maxStackSize: 25000, wcid: 273 }), F.row(2, "Pyreal", { stackSize: 5, maxStackSize: 25000, wcid: 273 })] });
  const mgr = INV.createInventoryMgr(w.deps);
  const mana = M.createManaStones(w.deps);
  const bi = B.createBuffItems({ ...w.deps, buff: () => F.makeBuff() });
  assert.equal(mgr.enabled(), false);
  assert.equal(mana.enabled(), false);
  assert.equal(bi.slot.enabled(), false);
  for (let i = 0; i < 20; i++) {
    w.clock.advance(600);
    mgr.reflex.tick(w.clock.t, IDLE);
    mana.reflex.tick(w.clock.t, IDLE);
    mana.reflex.tick(w.clock.t, { held: true, kernelAction: "Idle", running: false });
  }
  assert.equal(w.host.calls.length, 0, "no host action at defaults");
  assert.equal(mgr.reflex.name, "Inventory");
  assert.equal(mana.reflex.name, "ManaStones");
});

await run.check("planStack: amount = min(src.stack, max − dst.stack); largest partial is the target, smallest the source; full/equipped/unstackable ignored", () => {
  const rows = [
    F.row(11, "Prismatic Taper", { wcid: 20631, stackSize: 80, maxStackSize: 100 }),
    F.row(12, "Prismatic Taper", { wcid: 20631, stackSize: 30, maxStackSize: 100 }),
    F.row(13, "Prismatic Taper", { wcid: 20631, stackSize: 100, maxStackSize: 100 }), // full
    F.row(14, "Prismatic Taper", { wcid: 20631, stackSize: 40, maxStackSize: 100, equipMask: 0x1 }), // equipped
  ];
  assert.deepEqual(
    (({ src, dst, amount }) => ({ src, dst, amount }))(INV.planStack(rows)),
    { src: 12, dst: 11, amount: 20 },
    "only 20 fit on the 80-stack (ACE refuses an overfill)"
  );
  rows[1].stackSize = 10;
  assert.equal(INV.planStack(rows).amount, 10, "the whole small stack fits");
  assert.equal(INV.planStack([F.row(1, "Sword", { maxStackSize: 1 }), F.row(2, "Sword", { maxStackSize: 1 })]), null);
  assert.equal(INV.maxStackOf(F.row(1, "Pyreal")), 25000, "name fallback");
  assert.equal(INV.maxStackOf(F.row(1, "Salvaged Iron")), 0, "salvage never stacks");
  // Grouped by wcid: same name, different wcid never merge.
  assert.equal(INV.planStack([F.row(1, "Gem", { wcid: 1, stackSize: 2, maxStackSize: 10 }), F.row(2, "Gem", { wcid: 2, stackSize: 3, maxStackSize: 10 })]), null);
  assert.equal(INV.planStack(rows, { blocked: (g) => g === 12 }), null, "a backed-off source is skipped");
});

await run.check("autostack reflex: MergeStacks(src, dst, amount) under the item token vtinv; success when the source shrinks", () => {
  const inv = [F.row(11, "Prismatic Taper", { wcid: 20631, stackSize: 80, maxStackSize: 100 }), F.row(12, "Prismatic Taper", { wcid: 20631, stackSize: 30, maxStackSize: 100 })];
  const w = invWorld({ values: { EnableAutostack: true }, inv });
  w.tick();
  assert.deepEqual(w.host.calls, [["MergeStacks", 12, 11, 20]]);
  assert.equal(w.host.itemActionToken.owner, "vtinv");
  // The server moves 20: the source shrinks to 10, the target is full.
  w.host.inv[0].stackSize = 100;
  w.host.inv[1].stackSize = 10;
  w.host.answer();
  w.tick();
  assert.equal(w.mgr.status().stacks, 1);
  assert.equal(w.host.calls.length, 1, "no partial pair left (one partial)");
});

await run.check("autostack backoff: 5 s × 2ⁿ per source, capped; parked at the cap after 6 attempts", () => {
  const inv = [F.row(11, "Taper", { wcid: 9, stackSize: 50, maxStackSize: 100 }), F.row(12, "Taper", { wcid: 9, stackSize: 5, maxStackSize: 100 })];
  const w = invWorld({ values: { EnableAutostack: true }, inv });
  const attempts = [];
  for (let i = 0; i < 400; i++) {
    const before = w.host.actions("MergeStacks").length;
    w.tick(IDLE, 1000); // the merge never lands
    w.host.answer();
    if (w.host.actions("MergeStacks").length > before) attempts.push(w.clock.t);
  }
  const gaps = attempts.slice(1, 6).map((t, i) => Math.round((t - attempts[i]) / 1000));
  // confirm timeout 10 s + backoff 5/10/20/40/80 s (+ the 0.5 s after-action and tick granularity)
  assert.ok(gaps[0] >= 15 && gaps[0] <= 17, `gap1 ${gaps}`);
  assert.ok(gaps[1] >= 20 && gaps[1] <= 22, `gap2 ${gaps}`);
  assert.ok(gaps[2] >= 30 && gaps[2] <= 32, `gap3 ${gaps}`);
  assert.ok(gaps[3] >= 50 && gaps[3] <= 52, `gap4 ${gaps}`);
  assert.ok(gaps[4] >= 90 && gaps[4] <= 92, `gap5 ${gaps}`);
  const b = w.mgr._state.backoff.get("stack:12");
  assert.ok(b && b.n >= 6 && b.until - b.lastAt === INV.INVENTORY_TUNING.BACKOFF_CAP_MS, "parked at the 5 min cap");
});

await run.check("autocram: main-pack item → the side pack with the MOST free slots (≥ 2); Items-tab guids, containers, foci, equipped and packed items stay", () => {
  const inv = [
    pack(PACK_A, 3, "Small Pack"),
    pack(PACK_B, 24, "Big Pack"),
    inPack(0x80006001, PACK_A),
    inPack(0x80006002, PACK_B),
    F.row(0x80007001, "Wand of Items Tab", { itemType: 0x8000 }),
    F.row(0x80007002, "Foci of Enchantment", { requiresBackpackSlot: true }),
    F.row(0x80007003, "Robe", { equipMask: 0x200 }),
    F.row(0x80007004, "Loot Gem", { itemType: 0x800 }),
  ];
  const w = invWorld({ values: { EnableAutocram: true }, inv, items: [{ guid: 0x80007001, name: "Wand of Items Tab", kind: "caster" }] });
  w.tick();
  assert.deepEqual(w.host.calls, [["MoveItemToContainer", 0x80007004, PACK_B, 0]], "only the loot gem moves, to the emptiest pack");
  w.host.inv.find((r) => r.guid === 0x80007004).containerId = PACK_B;
  w.host.answer();
  w.tick();
  assert.equal(w.mgr.status().crams, 1);
  assert.equal(w.host.calls.length, 1, "nothing else to cram");
  // Packs with < 2 free never take an item.
  const full = [pack(PACK_A, 2), inPack(1, PACK_A), F.row(0x80007005, "Loot")];
  const room = { packs: [{ guid: PACK_A, free: 1 }] };
  assert.equal(INV.planCram(full, room).pack, 0, "no qualifying pack");
  const w2 = invWorld({ values: { EnableAutocram: true }, inv: full });
  w2.tick();
  assert.equal(w2.host.calls.length, 0);
});

await run.check("autocram confirm: still in the main pack after 10 s = failure (backoff), not a re-send every tick", () => {
  const inv = [pack(PACK_B, 24), F.row(0x80007004, "Loot Gem")];
  const w = invWorld({ values: { EnableAutocram: true }, inv });
  for (let i = 0; i < 16; i++) w.tick(IDLE, 1000);
  assert.equal(w.host.actions("MoveItemToContainer").length, 1, "pending 10 s, then 5 s backoff");
  assert.equal(w.mgr.status().failures, 1);
  // A kind-48 failure answers at once.
  const w2 = invWorld({ values: { EnableAutocram: true }, inv: [pack(PACK_B, 24), F.row(0x80007004, "Loot Gem")] });
  w2.tick();
  w2.bus.emit({ type: "equip", item: 0x80007004, wielder: 0, failed: true, code: 0x1f });
  assert.equal(w2.mgr.status().failures, 1);
  assert.equal(w2.mgr.status().pending, null);
});

await run.check("peas (SplitPeas): component under keepAtLeast + a matching pea → UseItemOnTarget(tool, pea); no tool → UseObject(pea); enough → nothing", () => {
  const TOOL = 0x80008001;
  const PEA = 0x80008002;
  const inv = [F.row(0x80008003, "Hyssop", { itemType: 0x1000, stackSize: 3, maxStackSize: 100 }), F.row(PEA, "Hyssop Pea"), F.row(TOOL, "Mortar and Pestle")];
  const list = [{ guid: 0x80008003, name: "Hyssop", wcid: 0, type: "PeaComponent", keepAtLeast: 10, toolGuid: TOOL }];
  const off = invWorld({ lists: { consumables: list }, inv });
  assert.equal(off.mgr.enabled(), false, "SplitPeas off");
  const w = invWorld({ values: { SplitPeas: true }, lists: { consumables: list }, inv });
  w.tick();
  assert.deepEqual(w.host.calls, [["UseItemOnTarget", TOOL, PEA]]);
  w.host.inv[0].stackSize = 23; // the pea split into components
  w.host.inv = w.host.inv.filter((r) => r.guid !== PEA);
  w.host.answer();
  w.tick();
  assert.equal(w.mgr.status().peas, 1);
  const w2 = invWorld({ values: { SplitPeas: true }, lists: { consumables: [{ ...list[0], toolGuid: undefined }] }, inv: inv.slice(0, 2) });
  w2.tick();
  assert.deepEqual(w2.host.calls, [["UseObject", PEA]]);
  const w3 = invWorld({ values: { SplitPeas: true }, lists: { consumables: [{ ...list[0], keepAtLeast: 2 }] }, inv });
  w3.tick();
  assert.equal(w3.host.calls.length, 0, "3 ≥ keepAtLeast 2");
});

await run.check("critic B4 / V-22: the inventory reflex does nothing while the kernel Loots or Fights, loot is mid-transaction, a container is open, busy, token held, held", () => {
  const inv = [F.row(11, "Taper", { wcid: 9, stackSize: 50, maxStackSize: 100 }), F.row(12, "Taper", { wcid: 9, stackSize: 5, maxStackSize: 100 })];
  const mk = () => invWorld({ values: { EnableAutostack: true, EnableAutocram: true }, inv: inv.map((r) => ({ ...r })) });
  for (const action of ["Loot", "Combat", "Buffing", "Vitals", "Supplies"]) {
    const w = mk();
    w.tick({ held: false, kernelAction: action, running: true });
    assert.equal(w.host.calls.length, 0, action);
  }
  const nav = mk();
  nav.tick({ held: false, kernelAction: "Navigate", running: true });
  assert.equal(nav.host.calls.length, 1, "Navigate is allowed");
  const loot = mk();
  loot.bot.loot.state = "CONFIRM";
  loot.tick();
  assert.equal(loot.host.calls.length, 0, "loot mid-transaction");
  const open = mk();
  open.host.groundContainer = 0x7a9b0001;
  open.tick();
  assert.equal(open.host.calls.length, 0, "corpse/chest open");
  const busy = mk();
  busy.host.busy = 1;
  busy.tick();
  assert.equal(busy.host.calls.length, 0, "busy");
  const tok = mk();
  tok.host.tryClaimItemAction("vtloadout");
  tok.tick();
  assert.equal(tok.host.calls.length, 0, "item token held by another owner");
  const held = mk();
  held.tick({ held: true, kernelAction: "Idle", running: false });
  assert.equal(held.host.calls.length, 0, "operator-held (V-7)");
  const portal = mk();
  portal.host.portal = true;
  portal.tick();
  assert.equal(portal.host.calls.length, 0, "portal space (V-12)");
});

// ── mana stones ───────────────────────────────────────────────────────────
const STONE_E = 0x80009001; // empty
const STONE_C = 0x80009002; // charged
const LOOT = 0x80009003; // loose item with mana
const ROBE = 0x80009004; // worn
const WAND = 0x80009005; // caster in the pack
const stone = (g, name = "Mana Stone") => F.row(g, name, { itemType: 0x80000 });

function manaWorld({ values = {}, lists = {}, inv = null, items = [] } = {}) {
  const w = base({
    values,
    lists,
    items,
    inv:
      inv ||
      [stone(STONE_E), stone(STONE_C, "Small Mana Charge"), F.row(LOOT, "Gold Ring", { itemType: 0x8 }), F.row(ROBE, "Robe", { itemType: 0x4, equipMask: 0x200 }), F.row(WAND, "Ivory Wand", { itemType: 0x8000 })],
  });
  const h = w.host;
  h.appraised.add(STONE_E); // appraised, no mana props ⇒ empty
  h.mana.set(STONE_C, { cur: 5000, max: 5000, lastIdMs: w.clock.t, stale: false });
  h.mana.set(LOOT, { cur: 4000, max: 4000, lastIdMs: w.clock.t, stale: false });
  h.mana.set(ROBE, { cur: 900, max: 1000, ratePerSec: 0, lastIdMs: w.clock.t, stale: false });
  h.mana.set(WAND, { cur: 8000, max: 8000, lastIdMs: w.clock.t, stale: false });
  w.mana = M.createManaStones(w.deps);
  w.tick = (info = IDLE, ms = 700) => {
    w.clock.advance(ms);
    w.mana.reflex.tick(w.clock.t, info);
  };
  return w;
}

await run.check("hard guard checkStoneUse (U4 H5): player only with a CHARGED stone; items only with an EMPTY stone, unequipped, non-caster; unknown never", () => {
  const g = (stoneState, targetGuid, targetRow) => M.checkStoneUse({ stoneState, targetGuid, playerGuid: ME, targetRow }).ok;
  const loose = F.row(LOOT, "Gold Ring");
  assert.equal(g("charged", ME, null), true);
  assert.equal(g("empty", ME, null), false);
  assert.equal(g("unknown", ME, null), false);
  assert.equal(g("empty", LOOT, loose), true);
  assert.equal(g("charged", LOOT, loose), false, "a charged stone is never spent on loot");
  assert.equal(g("unknown", LOOT, loose), false);
  assert.equal(g("empty", ROBE, F.row(ROBE, "Robe", { equipMask: 0x200 })), false, "an empty stone NEVER touches worn gear");
  assert.equal(g("empty", WAND, F.row(WAND, "Ivory Wand", { itemType: 0x8000 })), false, "casters never drained");
  assert.equal(g("empty", LOOT, null), false, "not in the inventory");
  assert.equal(g("empty", 0, null), false);
});

await run.check("drain priority: EMPTY stone on the loose item (≥ ManaTankMinimumMana) under vtmana; drain wins over a pending refill (C# order)", () => {
  const w = manaWorld({ values: { EnableManaTapping: true } });
  w.host.mana.set(ROBE, { cur: 100, max: 1000, lastIdMs: w.clock.t, stale: false }); // worn item needs a refill too
  w.tick();
  assert.deepEqual(w.host.actions("UseItemOnTarget"), [["UseItemOnTarget", STONE_E, LOOT]], "drain first; the wand (8000 mana) is never a target");
  assert.equal(w.host.itemActionToken.owner, "vtmana");
  // ACE: "The Mana Stone drains … The Gold Ring is destroyed." → the stone is now charged.
  w.bus.emit({ type: "chat", text: "The Mana Stone drains 3,600 points of mana from the Gold Ring.\nThe Gold Ring is destroyed.", chatType: 0, cat: 0 });
  w.host.inv = w.host.inv.filter((r) => r.guid !== LOOT);
  assert.equal(w.mana.stoneState(STONE_E), "charged", "known charged by our own drain");
  w.tick();
  const uses = w.host.actions("UseItemOnTarget");
  assert.equal(uses.length, 2);
  assert.equal(uses[1][2], ME, "then refill worn gear: a charged stone on the PLAYER");
  assert.ok(uses[1][1] === STONE_C || uses[1][1] === STONE_E, "a charged stone");
});

await run.check("drain candidates: Items-tab, consumable-listed, attuned/bonded, retained, equipped and under-threshold items are never drained", () => {
  const inv = [stone(STONE_E), F.row(LOOT, "Gold Ring", { itemType: 0x8 })];
  const mk = (over, extra = {}) => {
    const w = manaWorld({ values: { EnableManaTapping: true }, inv: [inv[0], { ...inv[1], ...over }], ...extra });
    w.host.mana.set(ROBE, { cur: 1000, max: 1000, lastIdMs: w.clock.t });
    return w;
  };
  const cases = [
    ["Items tab", mk({}, { items: [{ guid: LOOT, name: "Gold Ring", kind: "melee" }] })],
    ["consumables list", mk({}, { lists: { consumables: [{ guid: LOOT, name: "Gold Ring", wcid: 0, type: "General" }] } })],
    ["attuned", mk({ attuned: 1 })],
    ["bonded", mk({ bonded: 1 })],
    ["equipped", mk({ equipMask: 0x8000 })],
  ];
  const retained = mk({});
  retained.host.setBool(LOOT, 91, true);
  cases.push(["retained", retained]);
  const low = mk({});
  low.host.mana.set(LOOT, { cur: 2000, max: 4000, lastIdMs: low.clock.t });
  cases.push(["under ManaTankMinimumMana 2500", low]);
  for (const [name, w] of cases) {
    w.tick();
    assert.equal(w.host.actions("UseItemOnTarget").length, 0, name);
  }
});

await run.check("refill: worn item below RefillWornManaItemManaPercent → the MOST charged stone on the player; above → nothing; ManaRate extrapolated", () => {
  const w = manaWorld({ values: { RefillWornMana: true } });
  w.host.mana.set(STONE_E, { cur: 1200, max: 5000, lastIdMs: w.clock.t }); // now a weaker charged stone
  w.tick();
  assert.equal(w.host.actions("UseItemOnTarget").length, 0, "robe at 90 %");
  w.host.mana.set(ROBE, { cur: 200, max: 1000, lastIdMs: w.clock.t });
  w.tick();
  assert.deepEqual(w.host.actions("UseItemOnTarget"), [["UseItemOnTarget", STONE_C, ME]], "5000 > 1200");
  w.bus.emit({ type: "chat", text: "The Mana Stone gives 800 points of mana to the following items: Robe.\nYour items are fully charged.", chatType: 0, cat: 0 });
  assert.equal(w.mana.stoneState(STONE_C), "empty", "ACE empties the stone after a pour");
  assert.equal(w.mana.status().refills, 1);
  // ManaRate: 300/1000 read 100 s ago at 2 mana/s ⇒ ~100 now (< 250).
  const x = manaWorld({ values: { RefillWornMana: true } });
  x.host.mana.set(ROBE, { cur: 300, max: 1000, ratePerSec: 2, lastIdMs: x.clock.t - 100_000 });
  x.tick();
  assert.equal(x.host.actions("UseItemOnTarget").length, 1, "extrapolated below 25 %");
  // RefillWornMana alone never drains.
  assert.equal(x.host.actions("UseItemOnTarget").filter((c) => c[2] !== ME).length, 0);
});

await run.check("M. Charges when off: while operator-held only the refill runs (never a drain); without the option nothing runs held", () => {
  const w = manaWorld({ values: { EnableManaTapping: true, ManaChargesWhenOff: true } });
  w.host.mana.set(ROBE, { cur: 100, max: 1000, lastIdMs: w.clock.t });
  const HELD = { held: true, kernelAction: "Idle", running: false };
  w.tick(HELD);
  assert.deepEqual(w.host.actions("UseItemOnTarget"), [["UseItemOnTarget", STONE_C, ME]], "refill, not the (higher-priority) drain");
  w.host.answer();
  w.bus.emit({ type: "chat", text: "The Mana Stone gives 900 points of mana to the following items: Robe.", chatType: 0, cat: 0 });
  w.host.mana.set(ROBE, { cur: 1000, max: 1000, lastIdMs: w.clock.t });
  for (let i = 0; i < 5; i++) w.tick(HELD);
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "held: no drain ever");
  const off = manaWorld({ values: { EnableManaTapping: true } });
  off.host.mana.set(ROBE, { cur: 100, max: 1000, lastIdMs: off.clock.t });
  off.tick(HELD);
  assert.equal(off.host.calls.length, 0, "held without ManaChargesWhenOff");
});

await run.check("mana reflex gates: kernel Loot/Combat (B4), loot mid-transaction, busy, token held, portal; unknown (unappraised) stones are appraised, never used", () => {
  for (const action of ["Loot", "Combat"]) {
    const w = manaWorld({ values: { EnableManaTapping: true } });
    w.tick({ held: false, kernelAction: action, running: true });
    assert.equal(w.host.calls.length, 0, action);
  }
  const l = manaWorld({ values: { EnableManaTapping: true } });
  l.bot.loot.state = "LOOT";
  l.tick();
  assert.equal(l.host.calls.length, 0, "loot not in SCAN");
  const t = manaWorld({ values: { EnableManaTapping: true } });
  t.host.tryClaimItemAction("vtinv");
  t.tick();
  assert.equal(t.host.calls.length, 0, "token held");
  const u = manaWorld({ values: { EnableManaTapping: true } });
  u.host.appraised.delete(STONE_E);
  u.tick();
  assert.equal(u.host.actions("UseItemOnTarget").length, 0, "an unappraised stone is never used");
  assert.ok(u.host.actions("RequestId").some((c) => c[1] === STONE_E), "…it is appraised first");
});

await run.check("re-appraisal budget: ≤ 3 RequestId per 30 s, stale worn items first; the same guid at most once per 60 s", () => {
  const worn = [0x8000a001, 0x8000a002, 0x8000a003, 0x8000a004, 0x8000a005].map((g, i) => F.row(g, `Ring ${i}`, { itemType: 0x8, equipMask: 0x40000 << i }));
  const w = manaWorld({ values: { RefillWornMana: true }, inv: [stone(STONE_C), ...worn] });
  w.host.mana.set(STONE_C, { cur: 5000, max: 5000, lastIdMs: w.clock.t });
  for (const r of worn) w.host.mana.set(r.guid, { cur: 900, max: 1000, lastIdMs: w.clock.t - 120_000, stale: true });
  for (let i = 0; i < 20; i++) w.tick(IDLE, 700); // 14 s
  assert.equal(w.host.actions("RequestId").length, 3, "3 per 30 s window");
  for (let i = 0; i < 30; i++) w.tick(IDLE, 700); // +21 s → second window
  const ids = w.host.actions("RequestId").map((c) => c[1]);
  assert.equal(ids.length, 5, "the other two worn items next");
  assert.equal(new Set(ids).size, 5, "no guid twice within 60 s");
});

await run.check("explicit ManaStone/ManaCharge consumables restrict stone identity; a timeout parks the stone (no loop)", () => {
  const OTHER = 0x80009010;
  const inv = [stone(STONE_C, "Small Mana Charge"), stone(OTHER, "Mana Stone"), F.row(ROBE, "Robe", { itemType: 0x4, equipMask: 0x200 })];
  const w = manaWorld({ values: { RefillWornMana: true }, inv, lists: { consumables: [{ guid: 0, name: "Mana Stone", wcid: 0, type: "ManaStone" }] } });
  w.host.mana.set(OTHER, { cur: 3000, max: 5000, lastIdMs: w.clock.t });
  w.host.mana.set(ROBE, { cur: 100, max: 1000, lastIdMs: w.clock.t });
  w.tick();
  assert.deepEqual(w.host.actions("UseItemOnTarget"), [["UseItemOnTarget", OTHER, ME]], "only the listed stone name");
  for (let i = 0; i < 20; i++) {
    w.tick(IDLE, 1000); // never answered
  }
  assert.equal(w.host.actions("UseItemOnTarget").length, 1, "timed out → stone parked 5 min");
  assert.equal(w.mana.status().state, "idle");
});

// ── buff items ────────────────────────────────────────────────────────────
const BEER = 0x8000b001;
const FAM = 300; // a buff family (spell category)

function buffWorld({ values = {}, entry = {}, buff = F.makeBuff(), ench = [] } = {}) {
  const e = { guid: BEER, name: "Aromatic Amber Ale", wcid: 29211, type: "BuffItem", spellIds: [5000], durationS: 1800, ...entry };
  const w = base({ values, lists: { consumables: [e] }, inv: [F.row(BEER, "Aromatic Amber Ale", { wcid: 29211, itemType: 0x20 })] });
  w.host.spells.set(5000, { id: 5000, name: "Ale Buff", category: FAM, duration: 1800, isBeneficial: true });
  w.host.ench = ench;
  w.buff = buff;
  w.bi = B.createBuffItems({ ...w.deps, buff: () => w.buff });
  w.tick = () => {
    w.clock.advance(500);
    if (w.bi.slot.enabled() && w.bi.slot.wants(F.ctx())) {
      w.bi.slot.tick(F.ctx());
      return true;
    }
    return false;
  };
  return w;
}

await run.check("BuffItem validation (G:181): < 300 s rejected; < RebuffSecondsRemaining above 300 rejected; unknown duration rejected; 30 min accepted", () => {
  const w = base({ inv: [F.row(BEER, "Short Beer", { itemType: 0x20 })] });
  w.host.spells.set(7000, { id: 7000, category: FAM, duration: 120 });
  w.host.setDid(BEER, 28, 7000);
  const r = w.consumables.add({ guid: BEER, type: "BuffItem" });
  assert.equal(r.ok, false, "2 min beer refused");
  assert.match(r.error, /300 s/);
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [7000], durationS: 299 }).ok, false);
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [7000], durationS: 300 }).ok, true);
  w.options.set("RebuffSecondsRemaining", 600);
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [7000], durationS: 450 }).ok, false, "below the raised threshold (critic G13)");
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [7000], durationS: 900 }).ok, true);
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [9999] }).ok, false, "unknown duration");
  assert.equal(w.consumables.validateBuffItem({ name: "x", spellIds: [] }).ok, false, "no spell");
  w.host.spells.set(7000, { id: 7000, category: FAM, duration: 1800 });
  const ok = w.consumables.add({ guid: BEER, type: "BuffItem" });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.entry.spellIds, [7000]);
  assert.equal(ok.entry.durationS, 1800);
});

await run.check("buff item used when its family is low/missing and no castable self spell covers it; confirmed by the registry", () => {
  const w = buffWorld();
  assert.equal(w.bi.slot.enabled(), true);
  assert.equal(w.bi.slot.rank, "beforeIdle");
  assert.equal(w.tick(), true);
  assert.deepEqual(w.host.calls, [["UseObject", BEER]]);
  assert.equal(w.host.itemActionToken.owner, "vtbuffitems");
  w.host.answer();
  w.host.ench = [{ spellId: 5000, family: FAM, layer: 1, isBeneficial: true, isCooldown: false, permanent: false, remainingS: 1790 }];
  w.clock.advance(2000);
  assert.equal(w.tick(), false, "family up again");
  assert.equal(w.bi.status().confirmed, 1);
  // Above the threshold: nothing; at/below: used again.
  w.host.ench[0].remainingS = 299;
  w.clock.advance(2000);
  assert.equal(w.tick(), true, "≤ RebuffSecondsRemaining");
});

await run.check("not used when the buff loop maintains a known spell of that family; used when the buff loop is held (no caster)", () => {
  const buff = F.makeBuff({ desired: [5100] });
  const w = buffWorld({ buff });
  w.host.spells.set(5100, { id: 5100, name: "Self spell", category: FAM, duration: 3600 });
  assert.equal(w.tick(), false, "a castable self spell covers the family");
  buff.status = { ...buff.status, blocked: "no-caster" };
  w.bi._state.plan = null;
  assert.equal(w.tick(), true, "held buff loop covers nothing");
  const parked = F.makeBuff({ desired: [5100] });
  parked._isParked = (id) => id === 5100;
  const w2 = buffWorld({ buff: parked });
  w2.host.spells.set(5100, { id: 5100, category: FAM, duration: 3600 });
  assert.equal(w2.tick(), true, "a parked self spell covers nothing");
});

await run.check("buff items: two unconfirmed uses park the item 5 min; shared cooldown skips; a short item already listed is skipped", () => {
  const w = buffWorld();
  w.tick();
  w.host.answer();
  w.clock.advance(11_000);
  w.tick(); // confirm timeout #1 → second use
  w.host.answer();
  assert.equal(w.host.actions("UseObject").length, 2);
  w.clock.advance(11_000);
  for (let i = 0; i < 10; i++) w.tick();
  assert.equal(w.host.actions("UseObject").length, 2, "parked after 2 failures");
  assert.deepEqual(w.bi.status().parked, [BEER]);
  const cd = buffWorld();
  cd.host.setInt(BEER, 280, 7);
  cd.host.ench = [{ spellId: 0x8000 + 7, family: 0, isCooldown: true, isBeneficial: true, remainingS: 60 }];
  assert.equal(cd.tick(), false, "shared cooldown running");
  const short = buffWorld({ entry: { durationS: 200 } });
  assert.equal(short.tick(), false, "< 300 s item never used");
});

await run.check("BuffItems enabled() follows EnableBuffing (buff loop enabled === false ⇒ false, critic G12)", () => {
  const w = buffWorld({ buff: F.makeBuff({ enabled: false }) });
  assert.equal(w.bi.slot.enabled(), false);
  assert.equal(w.tick(), false);
  const none = buffWorld({ buff: null });
  assert.equal(none.bi.slot.enabled(), true, "no buff loop at all: items still keep the buff up");
});

console.log(run.fail === 0 ? `rynth_vt_support_inventory: all ${run.pass} checks passed` : `rynth_vt_support_inventory: ${run.fail} FAILED (${run.pass} passed)`);
process.exit(run.fail === 0 ? 0 : 1);
