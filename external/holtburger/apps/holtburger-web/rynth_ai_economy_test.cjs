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

const VENDOR = {
  vendorGuid: 0x2001,
  vendorName: "Aun Warrior Vendor",
  buyMultiplier: 1.15,
  sellMultiplier: 0.75,
  items: [
    { itemGuid: 0x3001, name: "Budding Wand", wcid: 200, value: 100, stackSize: 1, itemType: 0x8000 },
    { itemGuid: 0x3002, name: "Spell Components", wcid: 201, value: 5, stackSize: 1, itemType: 0x80 },
    { itemGuid: 0x3003, name: "Golden Plate Armor", wcid: 202, value: 90000, stackSize: 1, itemType: 2 },
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
  check("seven defs", Object.keys(byType).length === 7);

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
    check("open_vendor journals stock+prices", journal.entries[0].text.includes("Budding Wand @115"));
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
    check("buy_items ok", r.ok === true && r.result.estCost === 115 + Math.ceil(5 * 1.15) * 20);
    const buyCall = bot.host.calls.find((c) => c[0] === "buy");
    check("buy_items sends guid rows", buyCall && buyCall[1] === 0x2001 && buyCall[2].length === 2 && buyCall[2][1].amount === 20);
    const broke = await byType.buy_items.apply(bot, { type: "buy_items", items: [{ name: "golden plate" }] }, { journal });
    check("buy_items refuses over-budget", broke.ok === false && /exceeds your 900 pyreals/.test(broke.error));
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
