#!/usr/bin/env node
// rynth_ai_economy_test.cjs — unit tests for rynth/ai/tools/economy.js (the
// playtester's economic hands: inventory / open_vendor / buy_items /
// sell_items / equip_item / unequip_item / use_item) + the webhost economy
// plane it drives, via a mock host. No infra.
//
// Run: node rynth_ai_economy_test.cjs   (exits 1 on any FAIL; ~5s — the
// buy/sell paths include their 1.5s settle sleeps)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

function makeJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
}

const INV = [
  { guid: 0x1001, name: "Training Wand", wcid: 100, value: 250, stackSize: 1, equipMask: 0, validLocations: 0x01000000, itemType: 0x8000, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: true },
  { guid: 0x1002, name: "Leather Cap", wcid: 101, value: 40, stackSize: 1, equipMask: 0, validLocations: 0x00004000, itemType: 2, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: true },
  { guid: 0x1003, name: "Dagger", wcid: 102, value: 35, stackSize: 1, equipMask: 0x00100000, validLocations: 0x00100000, itemType: 1, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: false },
  { guid: 0x1004, name: "Apple", wcid: 103, value: 2, stackSize: 5, equipMask: 0, validLocations: 0, itemType: 0x80, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: true },
  { guid: 0x1005, name: "Pyreal", wcid: 273, value: 900, stackSize: 900, equipMask: 0, validLocations: 0, itemType: 0x1000, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: false },
];

// Live-shaped multipliers (2026-10-12): buyMultiplier = what the vendor PAYS
// (~0.9), sellMultiplier = what it CHARGES (~1.5) — plugins/commerce_logic.js
// "THE DIRECTION TRAP". The pre-fix fixture had them the other way round
// (1.15 / 0.75), which is how the inverted economy.js pricing passed.
const VENDOR = {
  vendorGuid: 0x2001,
  vendorName: "Aun Warrior Vendor",
  buyMultiplier: 0.9,
  sellMultiplier: 1.5,
  items: [
    { itemGuid: 0x3001, name: "Budding Wand", wcid: 200, value: 100, stackSize: 1, itemType: 0x8000 },
    { itemGuid: 0x3002, name: "Spell Components", wcid: 201, value: 5, stackSize: 1, itemType: 0x80 },
    { itemGuid: 0x3003, name: "Golden Plate Armor", wcid: 202, value: 90000, stackSize: 1, itemType: 2 },
    { itemGuid: 0x3004, name: "Rare Trinket", wcid: 203, value: 10, stackSize: 1, itemType: 0x8, supply: 2 },
  ],
};

function makeHost({ coins = 900, vendorAnswers = true, inventory = INV } = {}) {
  const calls = [];
  return {
    calls,
    TryGetPlayerInventory: () => inventory.map((i) => ({ ...i })),
    TryGetEquipment: () => inventory.filter((i) => i.equipMask !== 0).map((i) => ({ ...i })),
    TryGetCoins: () => coins,
    TryGetBurden: () => 350,
    TryGetFreeSlots: () => 96,
    TryGetVendorState: (g) => (vendorAnswers && (g >>> 0) === VENDOR.vendorGuid ? JSON.parse(JSON.stringify(VENDOR)) : null),
    NearbyGuids: () => [0x2001, 0x9001],
    ObjectIsPlayer: (g) => g === 0x9001,
    TryGetObjectName: (g) => (g === 0x2001 ? "Aun Warrior Vendor" : g === 0x9001 ? "Somedude" : null),
    UseObject: (g) => { calls.push(["use", g]); return true; },
    BuyFromVendor: (g, rows) => { calls.push(["buy", g, rows]); return true; },
    SellToVendor: (g, rows) => { calls.push(["sell", g, rows]); return true; },
    WieldItem: (g, m) => { calls.push(["wield", g, m]); return true; },
    UnwieldItem: (g) => { calls.push(["unwield", g]); return true; },
  };
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { economyActions, parseGuid } = await import(modUrl("rynth/ai/tools/economy.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));

  // --- parseGuid ----------------------------------------------------------
  check("parseGuid number", parseGuid(0x1001) === 0x1001);
  check("parseGuid hex string", parseGuid("0x2001") === 0x2001);
  check("parseGuid dec string", parseGuid("4097") === 4097);
  check("parseGuid junk", parseGuid("wand") === null && parseGuid(-3) === null && parseGuid(null) === null);

  const defs = economyActions();
  const byType = Object.fromEntries(defs.map((d) => [d.type, d]));
  check("nine defs", Object.keys(byType).length === 9 && byType.split_stack && byType.merge_stacks);

  // --- inventory ----------------------------------------------------------
  {
    const journal = makeJournal();
    const bot = { host: makeHost() };
    const r = await byType.inventory.apply(bot, { type: "inventory" }, { journal });
    check("inventory ok", r.ok === true && r.result.coins === 900 && r.result.worn === 1);
    const note = journal.entries[0].text;
    check("inventory journals coins+gear", note.includes("pyreals=900") && note.includes("Dagger") && note.includes("Training Wand"));
    check("inventory excludes coins from pack list", !note.includes("Pyreal x900 ("));
    const empty = await byType.inventory.apply({ host: makeHost({ inventory: [] }) }, { type: "inventory" }, { journal });
    check("inventory empty degrades", empty.ok === false && /not streamed/.test(empty.error));
    const hostless = await byType.inventory.apply({}, { type: "inventory" }, { journal });
    check("inventory hostless degrades", hostless.ok === false && hostless.error === "unavailable");
  }

  // --- open_vendor --------------------------------------------------------
  {
    const journal = makeJournal();
    const bot = { host: makeHost() };
    const r = await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "aun warrior" }, { journal });
    check("open_vendor resolves by name", r.ok === true && r.result.vendorName === "Aun Warrior Vendor");
    check("open_vendor used the npc", bot.host.calls.some((c) => c[0] === "use" && c[1] === 0x2001));
    // ShopSystem::SellPrice: ceil(1.5 * 100 * 1 - 0.1) = 150 — the price the
    // player PAYS (pre-fix this read @115 off buyMultiplier).
    check("open_vendor journals retail purchase prices", journal.entries[0].text.includes("Budding Wand @150"), journal.entries[0].text);
    check("open_vendor names both price directions", /charges ×1\.5 .*pays ×0\.9/.test(journal.entries[0].text), journal.entries[0].text);
    const miss = await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "nonexistent npc" }, { journal });
    check("open_vendor unknown name fails", miss.ok === false && /no nearby entity/.test(miss.error));
    check("open_vendor skips players", !(await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "somedude" }, { journal })).ok);
  }

  // --- buy_items (shares state with open_vendor via the same defs set) ----
  {
    const journal = makeJournal();
    const bot = { host: makeHost() };
    await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "0x2001" }, { journal });
    const r = await byType.buy_items.apply(bot, { type: "buy_items", items: [{ name: "budding wand" }, { name: "spell components", qty: 20 }] }, { journal });
    // wand: ceil(1.5*100 - 0.1) = 150; components (stackability unknown ->
    // one lump, VendorSellPrice(pwd, 20)): ceil(1.5*5*20 - 0.1) = 150.
    check("buy_items ok at retail prices", r.ok === true && r.result.estCost === 300, JSON.stringify(r));
    const buyCall = bot.host.calls.find((c) => c[0] === "buy");
    check("buy_items sends guid rows", buyCall && buyCall[1] === 0x2001 && buyCall[2].length === 2 && buyCall[2][1].amount === 20);
    check("buy_items sends only {itemGuid, amount}", buyCall && Object.keys(buyCall[2][0]).sort().join(",") === "amount,itemGuid");
    check("buy_items journals an unchanged-coins verdict", journal.entries.some((e) => /did NOT complete the trade/.test(e.text)));
    const broke = await byType.buy_items.apply(bot, { type: "buy_items", items: [{ name: "golden plate" }] }, { journal });
    check("buy_items refuses over-budget", broke.ok === false && /exceeds your 900 pyreals/.test(broke.error) && /enough money/.test(broke.error));
    const stock = await byType.buy_items.apply(bot, { type: "buy_items", items: [{ name: "rare trinket", qty: 3 }] }, { journal });
    check("buy_items respects a finite supply", stock.ok === false && /only 2 in stock/.test(stock.error), JSON.stringify(stock));
    const full = makeHost();
    full.TryGetPackRoom = () => ({ main: { used: 102, cap: 102, free: 0 }, containers: { used: 7, cap: 7, free: 0 }, packs: [], freeItemSlots: 0 });
    const fullBot = { host: full };
    await byType.open_vendor.apply(fullBot, { type: "open_vendor", vendor: "0x2001" }, { journal });
    const noRoom = await byType.buy_items.apply(fullBot, { type: "buy_items", items: [{ name: "budding wand" }] }, { journal });
    check("buy_items refuses with a full main pack (retail order: money, then room)",
      noRoom.ok === false && /empty some slots/.test(noRoom.error) && !full.calls.some((c) => c[0] === "buy"), JSON.stringify(noRoom));
    const badName = await byType.buy_items.apply(bot, { type: "buy_items", items: [{ name: "banana" }] }, { journal });
    check("buy_items unknown item fails", badName.ok === false && /no item matching/.test(badName.error));
    check("buy_items validates qty", byType.buy_items.validate({ type: "buy_items", items: [{ name: "x", qty: 0 }] }).ok === false);
    check("buy_items validates rows cap", byType.buy_items.validate({ type: "buy_items", items: Array(11).fill({ name: "x" }) }).ok === false);
  }
  {
    const defs2 = economyActions(); // fresh state: no vendor opened
    const by2 = Object.fromEntries(defs2.map((d) => [d.type, d]));
    const r = await by2.buy_items.apply({ host: makeHost() }, { type: "buy_items", items: [{ name: "budding wand" }] }, { journal: makeJournal() });
    check("buy_items without open_vendor fails", r.ok === false && /open_vendor first/.test(r.error));
  }

  // --- sell_items ---------------------------------------------------------
  {
    const journal = makeJournal();
    const bot = { host: makeHost() };
    await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "0x2001" }, { journal });
    const r = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "leather cap" }] }, { journal });
    check("sell_items ok", r.ok === true && r.result.sold[0].name === "Leather Cap");
    const worn = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "dagger" }] }, { journal });
    check("sell_items refuses worn items", worn.ok === false);
    const coins = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "pyreal" }] }, { journal });
    check("sell_items refuses coin stacks", coins.ok === false);
    // Whole stacks only (ACE sells every unit whatever amount is sent).
    const part = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "apple", qty: 2 }] }, { journal });
    check("sell_items refuses a partial stack with the split_stack recipe",
      part.ok === false && /WHOLE stack of 5/.test(part.error) && /split_stack/.test(part.error), JSON.stringify(part));
    const whole = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "apple" }] }, { journal });
    const sellCall = bot.host.calls.filter((c) => c[0] === "sell").pop();
    check("sell_items sends the whole stack", whole.ok === true && sellCall && sellCall[2][0].amount === 5, JSON.stringify(sellCall));
    // ShopSystem::BuyPrice(unit 0 (2/5 floors to 0)…) — any credit number is
    // fine here; the expected credit rides the result when the vendor state is known.
    check("sell_items reports an expected credit", typeof whole.result.estCredit === "number");
  }

  // --- sell_items vs the vendor's buy profile (InqAcceptability) ---------
  {
    const journal = makeJournal();
    const host = makeHost();
    // A weapons-only vendor (ItemType 0x101) that buys values 10..1000.
    host.TryGetVendorProfile = () => ({
      vendorGuid: 0x2001, buyAcceptCategories: 0x101, buyAcceptCategoryNames: ["Weapons"],
      minValue: 10, maxValue: 1000, hasNoMin: false, hasNoMax: false,
    });
    const bot = { host };
    await byType.open_vendor.apply(bot, { type: "open_vendor", vendor: "0x2001" }, { journal });
    check("open_vendor journals what the vendor buys", journal.entries.some((e) => /buys Weapons \(value 10\.\.1000\)/.test(e.text)), JSON.stringify(journal.entries));
    const cap = await byType.sell_items.apply(bot, { type: "sell_items", items: [{ name: "leather cap" }] }, { journal });
    check("sell_items refuses an item type the vendor does not buy (retail text)",
      cap.ok === false && /cannot be sold here/.test(cap.error) && !host.calls.some((c) => c[0] === "sell"), JSON.stringify(cap));
  }

  // --- equip / unequip / use ---------------------------------------------
  {
    const journal = makeJournal();
    const bot = { host: makeHost() };
    const r = await byType.equip_item.apply(bot, { type: "equip_item", item: "training wand" }, { journal });
    check("equip_item ok", r.ok === true && bot.host.calls.some((c) => c[0] === "wield" && c[1] === 0x1001));
    const noEquip = await byType.equip_item.apply(bot, { type: "equip_item", item: "apple" }, { journal });
    check("equip_item rejects non-equippable", noEquip.ok === false && /not equippable/.test(noEquip.error));
    const un = await byType.unequip_item.apply(bot, { type: "unequip_item", item: "dagger" }, { journal });
    check("unequip_item ok (worn only)", un.ok === true && bot.host.calls.some((c) => c[0] === "unwield" && c[1] === 0x1003));
    const use = await byType.use_item.apply(bot, { type: "use_item", item: "apple" }, { journal });
    check("use_item ok", use.ok === true && bot.host.calls.some((c) => c[0] === "use" && c[1] === 0x1004));
    check("use_item surviving item reported still-in-inventory", use.result?.consumed === false);
  }

  // --- use_item Useable.No guard (473 silent-consume gems in the world DB) --
  {
    const journal = makeJournal();
    const host = makeHost();
    host.TryGetObjectIntProperty = (g, t) => (t === 16 && g === 0x1004 ? 1 : undefined); // apple: Useable.No
    const r = await byType.use_item.apply({ host }, { type: "use_item", item: "apple" }, { journal });
    check("use_item refuses Useable.No items", r.ok === false && /DESTROY/.test(r.error), JSON.stringify(r));
    check("use_item Useable.No never hits the wire", !host.calls.some((c) => c[0] === "use"));
    host.TryGetObjectIntProperty = (g, t) => (t === 16 ? 8 : undefined); // Contained — normal consumable
    const ok = await byType.use_item.apply({ host }, { type: "use_item", item: "apple" }, { journal });
    check("use_item allows useable items", ok.ok === true);
  }

  // --- use_item consumption verdict (soak v6.4: token eaten, memory stale) --
  {
    const journal = makeJournal();
    const host = makeHost();
    const before = host.TryGetPlayerInventory();
    host.UseObject = (g) => {
      host.calls.push(["use", g]);
      // server consumes the item: subsequent inventory reads lack it
      host.TryGetPlayerInventory = () => before.filter((i) => i.guid !== g);
      return true;
    };
    const r = await byType.use_item.apply({ host }, { type: "use_item", item: "apple" }, { journal });
    check("use_item consumed verdict in result", r.ok === true && r.result?.consumed === true, JSON.stringify(r));
    check(
      "use_item consumed verdict journaled",
      journal.entries.some((e) => /CONSUMED/.test(e.text) && /Apple/i.test(e.text)),
      JSON.stringify(journal.entries)
    );
  }

  // --- split_stack / merge_stacks (2026-07-18 verb-audit gap 5) ----------
  {
    const journal = makeJournal();
    const host = makeHost();
    host.GetPlayerId = () => 0x5001;
    host.SplitStack = (s, c, q) => { host.calls.push(["split", s, c, q]); return true; };
    host.MergeStacks = (s, d, q) => { host.calls.push(["merge", s, d, q]); return true; };
    const bot = { host };
    const r = await byType.split_stack.apply(bot, { type: "split_stack", item: "apple", qty: 2 }, { journal });
    check("split_stack sends split into own pack", r.ok && host.calls.some((c) => c[0] === "split" && c[1] === 0x1004 && c[2] === 0x5001 && c[3] === 2), JSON.stringify(r));
    const over = await byType.split_stack.apply(bot, { type: "split_stack", item: "apple", qty: 5 }, { journal });
    check("split_stack rejects qty >= stack", over.ok === false && /stack size/.test(over.error), JSON.stringify(over));
    const solo = await byType.split_stack.apply(bot, { type: "split_stack", item: "dagger", qty: 1 }, { journal });
    check("split_stack refuses non-stacks", solo.ok === false, JSON.stringify(solo));
    // merge: two apple stacks
    const inv2 = [...INV, { guid: 0x1006, name: "Apple", wcid: 103, value: 2, stackSize: 3, equipMask: 0, validLocations: 0, itemType: 0x80, containerId: 0x5001, itemsCapacity: 0, requiresBackpackSlot: true }];
    const host2 = makeHost({ inventory: inv2 });
    host2.MergeStacks = (s, d, q) => { host2.calls.push(["merge", s, d, q]); return true; };
    const m = await byType.merge_stacks.apply({ host: host2 }, { type: "merge_stacks", from: "0x1006", to: "0x1004" }, { journal });
    check("merge_stacks whole-stack default", m.ok && host2.calls.some((c) => c[0] === "merge" && c[1] === 0x1006 && c[2] === 0x1004 && c[3] === 3), JSON.stringify(m));
    const mm = await byType.merge_stacks.apply({ host: host2 }, { type: "merge_stacks", from: "0x1006", to: "0x1001" }, { journal });
    check("merge_stacks rejects different wcids", mm.ok === false && /different item types/.test(mm.error), JSON.stringify(mm));
    const hostless = await byType.merge_stacks.apply({ host: {} }, { type: "merge_stacks", from: "a", to: "b" }, { journal });
    check("merge_stacks hostless -> ok:false", hostless.ok === false && /unavailable/.test(hostless.error));
  }

  // --- extensions wiring --------------------------------------------------
  {
    const ext = composeAiExtensions({ host: makeHost() }, {
      journal: makeJournal(),
      config: { knowledge: false, dungeonNav: false, wbt: false },
    });
    const types = ["inventory", "open_vendor", "buy_items", "sell_items", "equip_item", "unequip_item", "use_item"];
    check("compose: economy default-on", types.every((t) => !!ext.extActions[t]) && Array.isArray(ext.economy));
    check("compose: prompt advertises economy", ext.directorDeps.systemPrompt.includes("inventory {") && ext.directorDeps.systemPrompt.includes("buy_items {"));
    check("compose: validate routes to economy def", ext.directorDeps.validate({ type: "open_vendor", vendor: "x" }).ok === true
      && ext.directorDeps.validate({ type: "open_vendor" }).ok === false);
    const journal = makeJournal();
    const ext2 = composeAiExtensions({}, { journal, config: { knowledge: false, dungeonNav: false, wbt: false } });
    const results = await ext2.directorDeps.execute({ host: null, }, [{ type: "inventory" }]);
    check("compose: hostless economy degrades to ok:false", results.length === 1 && results[0].ok === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
