// tests/inventory_hud_review_fixes.test.mjs — Inventory HUD retail parity & review fixes.
//
// Covers:
//  - Off-hand dual-wield (effectiveValidLocationsForSlot, decideItemDrop, canEquipInSlot)
//  - planAutoSortJewelry (R->L wrist/ring order, retail refusal lines, locked Aetheria)
//  - Foci vs Container guards (isOpenableContainer, decideItemDrop, planPlaceInBackpack, primaryUseAction)
//  - Self-drop, container self-drop, trade-lock, and same-container split capacity guards
//  - PaperdollHitTest (paperdollHitColorMask, paperdollUpperWornObject, paperdollItemAt, DOM silhouette)
//  - UIElement_UIItem state overlays (Trade, Sell, Cooldown 1..10, ShortcutNum, equipped stack, selection)
//  - item_drag.js split pre-flight trial & promptStackAmount >= 1 validation
//  - manastone-confirm.js drain wording & world-objects/container.js capacity keys (6/7)
//
// Run from apps/holtburger-web/:  node tests/inventory_hud_review_fixes.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFakeDom, FakeEvent } from "./helpers/fake_dom_items.mjs";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 4; i++) await tick(); }

const helpers = await import(pathToFileURL(path.join(APP, "plugins", "inventory_helpers.js")).href);
const drag = await import(pathToFileURL(path.join(APP, "plugins", "item_drag.js")).href);
const wpos = await import(pathToFileURL(path.join(APP, "ui", "ac_window_position.js")).href);
const kit = await import(pathToFileURL(path.join(APP, "ui", "hud_kit.js")).href);
const tcycle = await import(pathToFileURL(path.join(APP, "scene3d", "target_cycle.js")).href);
const { Container } = await import(pathToFileURL(path.join(APP, "plugins", "world-objects", "container.js")).href);

const {
  EQUIP, DROP_TARGET, MAIN_PACK_KEY, effectiveValidLocationsForSlot, decideItemDrop, canEquipInSlot,
  isOpenableContainer, planPlaceInBackpack, primaryUseAction, planWear, planAutoSortJewelry,
  PAPERDOLL_HIT_DID, PAPERDOLL_HIT_RECT, paperdollHitColorMask, paperdollUpperWornObject, paperdollItemAt,
  copyInventoryRow, evaluateManaStoneDrain,
} = helpers;

function loadSpliced(rel, expose, stubs) {
  const src = readFileSync(path.join(APP, rel), "utf8");
  const body = spliceModule(src, { label: rel, provided: [], stubs });
  return new Function(body + `\nreturn { ${expose.join(", ")} };`)();
}

console.log("=== inventory_hud_review_fixes ===");

// ── 1. Off-hand dual-wield widening ──────────────────────────────────────────
await check("effectiveValidLocationsForSlot widens MELEE_WEAPON to SHIELD only on off-hand slot", () => {
  assert.equal(effectiveValidLocationsForSlot(EQUIP.MeleeWeapon, EQUIP.Shield), 0x00300000);
  assert.equal(effectiveValidLocationsForSlot(EQUIP.MeleeWeapon, EQUIP.MeleeWeapon), EQUIP.MeleeWeapon);
  assert.equal(effectiveValidLocationsForSlot(EQUIP.TwoHanded, EQUIP.Shield), EQUIP.TwoHanded);
});

await check("decideItemDrop & canEquipInSlot(retailWieldLegal) allow 1H melee into off-hand", () => {
  const mainSword = { guid: 0x10, name: "Sword", validLocations: EQUIP.MeleeWeapon, equipMask: EQUIP.MeleeWeapon, combatUse: 1 };
  const offDagger = { guid: 0x11, name: "Dagger", validLocations: EQUIP.MeleeWeapon, equipMask: 0, combatUse: 1 };
  const state = { rows: [mainSword, offDagger], retailWieldLegal: true, inCombatMode: false };
  const verdict = canEquipInSlot(offDagger, EQUIP.Shield, state);
  assert.equal(verdict.ok, true);

  const okDrop = decideItemDrop(
    { guid: 0x11, item: offDagger, owned: true },
    { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.Shield },
    { playerGuid: 0x50000001, canEquip: (it, m) => canEquipInSlot(it, m, state) },
  );
  assert.equal(okDrop.op, "wield");
  assert.equal(okDrop.slotMask, EQUIP.Shield);

  // Legacy strict branch (retailWieldLegal falsy) stays strict on Shield:
  assert.equal(canEquipInSlot(offDagger, EQUIP.Shield, { rows: [mainSword, offDagger] }).ok, false);

  // Two-handed weapon dropped on Shield is quietly refused ({ op: "noop", refused: true }):
  const twoHanded = { guid: 0x12, name: "Greatsword", validLocations: EQUIP.TwoHanded, equipMask: 0, combatUse: 5 };
  const bad2h = decideItemDrop(
    { guid: 0x12, item: twoHanded, owned: true },
    { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.Shield },
    { playerGuid: 0x50000001, canEquip: (it, m) => canEquipInSlot(it, m, state) },
  );
  assert.equal(bad2h.op, "noop");
  assert.equal(bad2h.refused, true);
});

// ── 2. Jewelry AutoSort (R -> L precedence & retail refusal strings) ─────────
await check("planAutoSortJewelry equips bracelets & rings Right -> Left and emits retail refusal lines", () => {
  const WRIST_L = 0x00010000, WRIST_R = 0x00020000;
  const RING_L = 0x00040000, RING_R = 0x00080000;
  const NECK = 0x00008000;

  const ring = { guid: 0x20, name: "Gold Ring", validLocations: RING_L | RING_R };
  assert.deepEqual(planAutoSortJewelry(ring, []), { op: "wear", guid: 0x20, slotMask: RING_R });
  assert.deepEqual(
    planAutoSortJewelry(ring, [{ guid: 0x21, equipMask: RING_R }]),
    { op: "wear", guid: 0x20, slotMask: RING_L },
  );
  assert.deepEqual(
    planAutoSortJewelry(ring, [{ guid: 0x21, equipMask: RING_R }, { guid: 0x22, equipMask: RING_L }]),
    { op: "reject", message: "You're already wearing jewelry on both hands." },
  );

  const brac = { guid: 0x23, name: "Bracelet", validLocations: WRIST_L | WRIST_R };
  assert.deepEqual(planAutoSortJewelry(brac, []), { op: "wear", guid: 0x23, slotMask: WRIST_R });
  assert.deepEqual(
    planAutoSortJewelry(brac, [{ guid: 0x24, equipMask: WRIST_R }, { guid: 0x25, equipMask: WRIST_L }]),
    { op: "reject", message: "You're already wearing jewelry on both wrists." },
  );

  const neck = { guid: 0x26, name: "Amulet", validLocations: NECK };
  assert.deepEqual(
    planAutoSortJewelry(neck, [{ guid: 0x27, equipMask: NECK }]),
    { op: "reject", message: "You're already wearing jewelry on your neck." },
  );

  const lockedSigil = { guid: 0x28, name: "Blue Aetheria", validLocations: EQUIP.SigilBlue };
  assert.deepEqual(planAutoSortJewelry(lockedSigil, [], { aetheriaBits: 0 }), {
    op: "reject",
    message: "That aetheria slot has not been unlocked.",
  });
  assert.deepEqual(planAutoSortJewelry(lockedSigil, [], { aetheriaBits: 1 }), {
    op: "wear",
    guid: 0x28,
    slotMask: EQUIP.SigilBlue,
  });
});

// ── 3. Foci vs Container guards ──────────────────────────────────────────────
await check("Foci (requiresBackpackSlot=true, itemsCapacity=0, non-Container) cannot open or accept items", () => {
  const foci = {
    guid: 0x30,
    name: "Foci of Verdant Life",
    itemType: 0x08000000,
    requiresBackpackSlot: true,
    itemsCapacity: 0,
  };
  const pack = {
    guid: 0x31,
    name: "Side Pack",
    itemType: 0x200,
    requiresBackpackSlot: true,
    itemsCapacity: 24,
  };
  assert.equal(isOpenableContainer(foci), false);
  assert.equal(isOpenableContainer(pack), true);

  const act = primaryUseAction(foci, { hasUseTarget: false, retailWieldLegal: true });
  assert.notEqual(act.op, "open");

  const dropOnFoci = decideItemDrop(
    { guid: 0x32, item: { guid: 0x32, name: "Gem", stackSize: 1 }, owned: true },
    { kind: DROP_TARGET.PACK_SLOT, packGuid: 0x30, packName: foci.name, canHoldItems: false },
    { playerGuid: 0x50000001 },
  );
  assert.equal(dropOnFoci.op, "reject");
  assert.equal(dropOnFoci.message, "The Foci of Verdant Life cannot accept items");

  // planPlaceInBackpack skips Foci even though requiresBackpackSlot is true, landing in real side pack when main is full.
  const mainFill = Array.from({ length: 102 }, (_, i) => ({
    guid: 0x4000 + i,
    containerId: 0,
    equipMask: 0,
    requiresBackpackSlot: false,
  }));
  const plan = planPlaceInBackpack(
    [foci, pack, ...mainFill],
    { guid: 0x9999, name: "Scroll", stackSize: 1, maxStackSize: 1 },
    { playerGuid: 0x50000001, mainCap: 102, packsCap: 7 },
  );
  assert.equal(plan.op, "move");
  assert.equal(plan.container, pack.guid);
});

// ── 4. Self-drop, container self-drop, trade-lock, split capacity ────────────
await check("decideItemDrop enforces self-drop, container self-drop, trade lock, and split capacity", () => {
  const ME = 0x50000001;
  const selfDrop = decideItemDrop(
    { guid: ME, item: { guid: ME, name: "Hero" }, owned: false },
    { kind: DROP_TARGET.MAIN_PACK },
    { playerGuid: ME },
  );
  assert.equal(selfDrop.op, "reject");
  assert.equal(selfDrop.message, "You cannot place yourself in your inventory!");

  const bagSelf = decideItemDrop(
    { guid: 0x40, item: { guid: 0x40, name: "Sack", requiresBackpackSlot: true, itemsCapacity: 24, itemType: 0x200 }, owned: true },
    { kind: DROP_TARGET.PACK_SLOT, packGuid: 0x40, canHoldItems: true },
    { playerGuid: ME },
  );
  assert.equal(bagSelf.op, "reject");
  assert.equal(bagSelf.message, "You cannot place an object within itself!");

  const traded = decideItemDrop(
    { guid: 0x41, item: { guid: 0x41, name: "Gem", stackSize: 1 }, owned: true },
    { kind: DROP_TARGET.WORLD },
    { playerGuid: ME, isBeingTraded: (g) => g === 0x41 },
  );
  assert.equal(traded.op, "reject");

  // Same-container stack split into a full pack must reject on capacity, while non-split reorder succeeds.
  const fullCtx = {
    playerGuid: ME,
    capacity: (key) => (key === MAIN_PACK_KEY ? { used: 102, cap: 102 } : { used: 0, cap: 24 }),
  };
  const splitFull = decideItemDrop(
    { guid: 0x42, item: { guid: 0x42, name: "Pyreal", wcid: 273, stackSize: 100 }, owned: true, sourceList: { key: MAIN_PACK_KEY }, sourceIndex: 3, split: 25 },
    { kind: DROP_TARGET.EMPTY_CELL, listKey: MAIN_PACK_KEY, index: 0, count: 102 },
    fullCtx,
  );
  assert.equal(splitFull.op, "reject");

  const reorderFull = decideItemDrop(
    { guid: 0x42, item: { guid: 0x42, name: "Pyreal", wcid: 273, stackSize: 100 }, owned: true, sourceList: { key: MAIN_PACK_KEY }, sourceIndex: 3 },
    { kind: DROP_TARGET.EMPTY_CELL, listKey: MAIN_PACK_KEY, index: 0, count: 102 },
    fullCtx,
  );
  assert.equal(reorderFull.op, "move");
});

// ── 5. PaperdollHitTest pure helpers ─────────────────────────────────────────
await check("PaperdollHitTest maps hit-map colors and resolves outer worn layer by ClothingPriority", () => {
  assert.equal(PAPERDOLL_HIT_DID, 0x06004d8b);
  assert.deepEqual(PAPERDOLL_HIT_RECT, { x: 51, y: 0, w: 100, h: 214 });
  assert.equal(paperdollHitColorMask(0, 0, 255), 0x0001);
  assert.equal(paperdollHitColorMask(0, 255, 0), 0x0202);
  assert.equal(paperdollHitColorMask(0, 0, 0), 0);

  const shirt = { guid: 0x50, name: "Shirt", equipMask: 0x0002, clothingPriority: 0x0002 };
  const plate = { guid: 0x51, name: "Breastplate", equipMask: 0x0200, clothingPriority: 0x0200 };
  assert.equal(paperdollUpperWornObject([shirt, plate], 0x0202), 0x51);

  const rgba = new Uint8Array(100 * 214 * 4);
  const idx = (20 * 100 + 10) * 4;
  rgba[idx + 1] = 255;
  rgba[idx + 3] = 255;
  const hitMap = { width: 100, height: 214, data: rgba };
  assert.equal(paperdollItemAt(hitMap, 10, 20, [shirt, plate]), 0x51);
  assert.equal(paperdollItemAt(hitMap, 5, 5, [shirt, plate]), 0);
});

// ── 6. copyInventoryRow preserves extended fields ────────────────────────────
await check("copyInventoryRow preserves iconOverlay, iconUnderlay, cooldown, retained, pluralName", () => {
  const copied = copyInventoryRow({
    guid: 0x60, wcid: 10, name: "Scroll", pluralName: "Scrolls", iconId: 0x06001111,
    iconOverlay: 0x06002222, iconUnderlay: 0x06003333, iconOverlaySecondary: 0x06004444,
    sharedCooldown: 12, cooldownDuration: 30, retained: true,
    itemType: 0x2000, stackSize: 2, equipMask: 0, containerId: 0, validLocations: 0,
    requiresBackpackSlot: false, itemsCapacity: 0,
  });
  assert.equal(copied.iconOverlay, 0x06002222);
  assert.equal(copied.iconUnderlay, 0x06003333);
  assert.equal(copied.iconOverlaySecondary, 0x06004444);
  assert.equal(copied.sharedCooldown, 12);
  assert.equal(copied.cooldownDuration, 30);
  assert.equal(copied.retained, true);
  assert.equal(copied.pluralName, "Scrolls");
});

// ── 7. manastone-confirm.js drain message & world-objects/container.js ───────
await check("Container typed world-object reads ItemsCapacity(6) and ContainersCapacity(7)", () => {
  const c = new Container(0x70, 1);
  c.intValues.set(6, 102);
  c.intValues.set(7, 7);
  assert.equal(c.itemsCapacity, 102);
  assert.equal(c.containersCapacity, 7);
});

await check("manastone-confirm buildMessage formats retail drain confirmation text", () => {
  const msMod = loadSpliced("plugins/manastone-confirm.js", ["buildMessage"], {
    modalConfirmCallback: "() => {}",
  });
  assert.equal(
    msMod.buildMessage({ mode: "drain", targetName: "Prismatic Amuli Coat" }),
    "Are you sure you want to attempt to destroy your Prismatic Amuli Coat and drain its mana into this stone?",
  );
  assert.match(msMod.buildMessage({ mode: "all", name: "Major Mana Stone", charge: 50 }), /every magic item/);
});

await check("canEquipInSlot quietly refuses non-equippables under retailWieldLegal and planWear/planAutoSortJewelry guard edge cases", () => {
  const potion = { guid: 0x81, name: "Potion", validLocations: 0, equipMask: 0, itemType: 0x80 };
  assert.deepEqual(
    canEquipInSlot(potion, EQUIP.MeleeWeapon, { rows: [], retailWieldLegal: true, inCombatMode: false }),
    { ok: false, silent: true, reason: "" },
  );
  // Legacy non-retailWieldLegal state keeps speculative-ok on non-weapons.
  assert.deepEqual(
    canEquipInSlot({ equipMask: 0x1, validLocations: 0 }, 0x1, { equippedByMask: {} }),
    { ok: true, speculative: true, reason: "" },
  );

  // Zero-priority cloak over already-worn cloak refuses instead of re-wielding.
  const wornCloak = { guid: 0x82, name: "Blue Cloak", validLocations: EQUIP.Cloak, equipMask: EQUIP.Cloak, clothingPriority: 0 };
  const secondCloak = { guid: 0x83, name: "Red Cloak", validLocations: EQUIP.Cloak, equipMask: 0, clothingPriority: 0 };
  assert.deepEqual(planWear(wornCloak, [wornCloak]), { op: "reject", message: "The Blue Cloak is already being worn" });
  assert.deepEqual(planWear(secondCloak, [wornCloak]), { op: "reject", message: "You must remove your Blue Cloak to wear that" });

  // Multi-sigil item skips locked sigil slot and equips into unlocked slot.
  const multiSigil = { guid: 0x84, name: "Sigil", validLocations: EQUIP.SigilBlue | EQUIP.SigilYellow, equipMask: 0 };
  assert.deepEqual(
    planAutoSortJewelry(multiSigil, [], { aetheriaBits: 0x2 }),
    { op: "wear", guid: 0x84, slotMask: EQUIP.SigilYellow },
  );
});

// ── 8. DOM integration: UIElement_UIItem overlays, paperdoll silhouette & drag ─
const ME = 0x50000001;
const SWORD = 0x60000001;
const AMMO = 0x60000002;
const POTION = 0x60000003;
const GEM = 0x60000004;
const PACK = 0x70000001;
const FOCI = 0x70000002;
const CHEST_PLATE = 0x60000005;

let inv = [
  {
    guid: SWORD, wcid: 101, name: "Broad Sword", iconId: 0x06001001, itemType: 1,
    stackSize: 1, equipMask: EQUIP.MeleeWeapon, containerId: 0, validLocations: EQUIP.MeleeWeapon,
    requiresBackpackSlot: false, itemsCapacity: 0,
  },
  {
    guid: AMMO, wcid: 102, name: "Greater Arrow", iconId: 0x06001002, itemType: 1,
    stackSize: 250, maxStackSize: 250, equipMask: EQUIP.MissileAmmo, containerId: 0,
    validLocations: EQUIP.MissileAmmo, requiresBackpackSlot: false, itemsCapacity: 0,
  },
  {
    guid: POTION, wcid: 103, name: "StaminaElixir", iconId: 0x06001003, itemType: 0x80,
    stackSize: 5, maxStackSize: 100, equipMask: 0, containerId: 0, validLocations: 0,
    requiresBackpackSlot: false, itemsCapacity: 0, sharedCooldown: 9, cooldownDuration: 20,
  },
  {
    guid: GEM, wcid: 104, name: "Ruby", iconId: 0x06001004, itemType: 0x800,
    stackSize: 10, maxStackSize: 50, equipMask: 0, containerId: 0, validLocations: 0,
    requiresBackpackSlot: false, itemsCapacity: 0,
  },
  {
    guid: PACK, wcid: 105, name: "Empty Pack", iconId: 0x06001005, itemType: 0x200,
    stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0,
    requiresBackpackSlot: true, itemsCapacity: 24,
  },
  {
    guid: FOCI, wcid: 106, name: "Foci of Strife", iconId: 0x06001006, itemType: 0x08000000,
    stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0,
    requiresBackpackSlot: true, itemsCapacity: 0,
  },
  {
    guid: CHEST_PLATE, wcid: 107, name: "Breastplate", iconId: 0x06001007, itemType: 2,
    stackSize: 1, equipMask: 0x0200, containerId: 0, validLocations: 0x0200,
    requiresBackpackSlot: false, itemsCapacity: 0, clothingPriority: 0x0200,
  },
];

const calls = [];
const rec = (n) => (...a) => { calls.push([n, ...a]); };
const hitRgba = new Uint8Array(100 * 214 * 4);
{
  const p = (30 * 100 + 15) * 4;
  hitRgba[p + 1] = 255;
  hitRgba[p + 3] = 255;
  const pHead = (10 * 100 + 80) * 4;
  hitRgba[pHead] = 255;
  hitRgba[pHead + 3] = 255;
}
globalThis.__hbWasm = {
  fetch_icon_pixels: (did) => (did >>> 0) === 0x06004d8b
    ? { width: 100, height: 214, pixels: hitRgba, free() {} }
    : null,
};

globalThis.__vendorUi = { sellListGuids: () => new Set([POTION]) };
globalThis.__hotbar = {
  getSlot: (i) => (i === 0 ? { itemGuid: POTION } : null),
};
globalThis.__sessionHandle = {
  playerInventory: () => inv.map((r) => ({ ...r, free() {} })),
  playerItemsCapacity: 102,
  playerContainersCapacity: 7,
  playerBurden: 0.4,
  playerAetheriaBits: 0,
  combatMode: () => 1,
  canUseWith: () => false,
  playerTrade: () => ({ myItems: [{ guid: GEM, free() {} }], free() {} }),
  playerEnchantments: () => [{
    spellId: (9 + 0x8000),
    layer: 1,
    startTime: -5,
    duration: 20,
    free() {},
  }],
  moveItem: rec("moveItem"),
  mergeStacks: rec("mergeStacks"),
  setWielded: rec("setWielded"),
  unwield: rec("unwield"),
  splitStackToContainer: rec("splitStackToContainer"),
  dropItem: rec("dropItem"),
  giveObject: rec("giveObject"),
  useObject: rec("useObject"),
  classifyUse: () => ({ needsTarget: false, free() {} }),
};

const busL = new Map();
const bus = {
  on(n, f) { if (!busL.has(n)) busL.set(n, new Set()); busL.get(n).add(f); },
  off(n, f) { busL.get(n)?.delete(f); },
  emit(n, detail) { for (const f of [...(busL.get(n) || [])]) f(detail); },
};
globalThis.__pluginClient = { events: bus, player: { stats: { name: "Reviewer" } } };
globalThis.getLocalPlayerGuid = () => ME;
globalThis.__mainPanel = { setTitle: () => true, currentViewId: () => "inventory", isOpen: () => true };
for (const id of ["inv-equipped", "inv-pack"]) {
  const ul = document.createElement("ul");
  ul.id = id;
  document.body.appendChild(ul);
}

globalThis.__T = {
  ...helpers, ...drag, ...wpos, ...kit,
  consumeUseThrottle: tcycle.consumeUseThrottle,
};
const real = (names) => Object.fromEntries(names.map((n) => [n, `globalThis.__T.${n}`]));
const inventoryMod = loadSpliced("plugins/inventory.js", ["view"], {
  setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
  fetchIconDataUrlShared: "(did) => Promise.resolve('data:icon/' + (did >>> 0).toString(16))",
  getIconImmediate: "(did) => 'data:icon/' + (did >>> 0).toString(16)",
  fetchItemIconDataUrl: "() => Promise.resolve(null)",
  getItemIconImmediate: "() => null",
  itemIconKey: "(m) => 'item:' + ((m && m.iconId) >>> 0)",
  PLAYER_PACK_ICON: "0x0600127E",
  ITEM_TYPE_CONTAINER: "0x200",
  uiEffectIconsEnabled: "() => false",
  uiEffectBadgesEnabled: "() => false",
  uiEffectIconsFor: "() => []",
  uiEffectTintCss: "() => null",
  PaperdollViewport: "class { static acquire() { return new this(); } constructor() { this.dom = document.createElement('canvas'); } loadPlayer() { return Promise.resolve(false); } start() {} release() {} dispose() {} }",
  ...real([
    "aetheriaSlotIsLocked", "formatBurdenText", "burdenMeterFraction", "computeInventoryTitle",
    "parseSlotsViewChecked", "canEquipInSlot", "buildPlayerEquipState", "formatAppraisalTooltip",
    "takeInventoryRows", "rowUsesPackSlot", "pickWieldSlotMask", "createPackOrder", "packCapacity",
    "mergeAmount", "DROP_TARGET", "MAIN_PACK_KEY", "PACKS_KEY", "decideItemDrop",
    "wieldEventTouchesLocal", "findAutoMergeTarget", "primaryUseAction", "defaultOnUrlFlag",
    "planWear", "planAutoSortJewelry", "planAmmoWield", "readySlotOccupant", "WEARABLE_LOCATIONS",
    "isOpenableContainer", "PAPERDOLL_HIT_DID", "PAPERDOLL_HIT_RECT", "paperdollItemAt",
    "cooldownStep", "matchCooldownEnchantment",
    "DEFAULT_PLAYER_ITEMS_CAPACITY", "DEFAULT_PLAYER_CONTAINERS_CAPACITY",
    "beginItemDrag", "registerDropZone", "resolveDropAction", "executeItemAction", "pendingOps",
    "showItemTooltip", "hideItemTooltip", "localPlayerGuid", "consumeUseThrottle",
  ]),
});

const mountHost = document.createElement("div");
mountHost.className = "hb-mp-body";
document.body.appendChild(mountHost);
const unmount = inventoryMod.view.mount(mountHost, {});
await settle();

await check("DOM renders UIItem overlays (trading, selling, cooldown, shortcut), equipped ammo count, and hides empty bag fill", async () => {
  await settle();
  const gemCell = document.querySelector(`.hb-inv-slot[data-guid="${GEM}"]`);
  const potCell = document.querySelector(`.hb-inv-slot[data-guid="${POTION}"]`);
  assert.equal(gemCell?.dataset?.traded, "1", "GEM in tradeStateJson gets data-traded=1");
  assert.ok(gemCell?.querySelector(".hb-uiitem-trade"), "GEM renders .hb-uiitem-trade overlay");
  assert.equal(potCell?.dataset?.selling, "1", "POTION in vendor sell list gets data-selling=1");
  assert.ok(potCell?.querySelector(".hb-uiitem-sell"), "POTION renders .hb-uiitem-sell overlay");
  const step = Number(potCell?.dataset?.cdStep);
  assert.ok(step >= 1 && step <= 10, `POTION cooldown step expected 1..10, got ${step}`);
  assert.equal(potCell?.dataset?.shortcut, "1", "POTION in hotbar slot 0 shows shortcut=1");

  // Equipped ammo slot shows stack count "250".
  const ammoSlot = document.querySelector(`.hb-inv-doll-slot[data-equip-mask="${EQUIP.MissileAmmo}"]`);
  const ammoStack = ammoSlot?.querySelector(".hb-inv-stack");
  assert.equal(ammoStack?.textContent, "250");

  // Empty side pack hides its capacity bar (`cap > 0 && used > 0` is false).
  const packBag = document.querySelector(`.hb-inv-bag[data-pack-guid="${PACK}"]`);
  const capWrap = packBag?.querySelector(".hb-inv-bag-cap");
  assert.equal(capWrap?.style.display, "none");

  // Clicking Foci in bag column does NOT open Foci as the active pack.
  const fociBag = document.querySelector(`.hb-inv-bag[data-pack-guid="${FOCI}"]`);
  fociBag.dispatchEvent(new FakeEvent("click", { bubbles: true }));
  await settle();
  assert.ok(!fociBag.classList.contains("is-open"), "Foci bag cell must not open as a container");
});

await check("Paperdoll slot click selects item and 3D silhouette dblclick unequips ChestArmor", async () => {
  const meleeSlot = document.querySelector(`.hb-inv-doll-slot[data-item-guid="${SWORD}"]`);
  assert.ok(meleeSlot, "equipped SWORD doll slot exists");
  meleeSlot.dispatchEvent(new FakeEvent("click", { bubbles: true, button: 0 }));
  await settle();
  assert.ok(meleeSlot.classList.contains("is-selected"), "clicked paperdoll slot gets .is-selected");
  assert.equal(window.__inventory?.selectedGuid, SWORD);

  const hitEl = document.querySelector(".hb-inv-doll-hit");
  assert.ok(hitEl, ".hb-inv-doll-hit overlay exists");
  hitEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 214 });
  calls.length = 0;
  hitEl.dispatchEvent(new FakeEvent("dblclick", { bubbles: true, button: 0, clientX: 15, clientY: 30 }));
  await settle();
  // Unwield moves CHEST_PLATE into player's main pack (moveItem or unwield).
  const unequipped = calls.find((c) => (c[0] === "moveItem" || c[0] === "unwield") && c[1] === CHEST_PLATE);
  assert.ok(unequipped, `expected CHEST_PLATE unwield/moveItem call, got ${JSON.stringify(calls)}`);
});

await check("promptStackAmount rejects 0/negative input and resolveDropAction skips prompt on invalid split target", async () => {
  const dt = {
    types: [],
    effectAllowed: "",
    dropEffect: "",
    setData(t) { if (!this.types.includes(t)) this.types.push(t); },
    getData() { return ""; },
    setDragImage() {},
  };
  const potCell = document.querySelector(`.hb-inv-slot[data-guid="${POTION}"]`);
  potCell.dispatchEvent(new FakeEvent("dragstart", { bubbles: true, shiftKey: true, dataTransfer: dt }));
  const session = drag.getDragSession();
  assert.ok(session, "drag session started");
  const state = { rows: inv, retailWieldLegal: true, inCombatMode: false };
  const act = await drag.resolveDropAction(
    { ...session, shift: true },
    { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.MeleeWeapon },
    {
      ctx: { playerGuid: ME, canEquip: (it, m) => canEquipInSlot(it, m, state) },
      anchor: { clientX: 50, clientY: 50 },
    },
  );
  assert.equal(act?.op, "noop");
  assert.equal(act?.refused, true);
  const dlgBefore = document.querySelector("[role='dialog']");
  assert.ok(!dlgBefore || dlgBefore.dataset.open !== "1", "invalid split never opens modal");
  window.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));

  // Directly open promptStackAmount and verify 0 does NOT resolve; valid positive submits cleanly.
  const p = drag.promptStackAmount({ max: 10, initial: 5, name: "Ruby" });
  const dlg = document.querySelector("[role='dialog']");
  assert.equal(dlg?.dataset?.open, "1", "split prompt opened");
  const input = dlg.querySelector("input.hbk-input");
  const okBtn = dlg.querySelector("[data-act='ok']");
  input.value = "0";
  okBtn.dispatchEvent(new FakeEvent("click", { bubbles: true }));
  assert.equal(dlg.dataset.open, "1", "0 is rejected; modal stays open");
  input.value = "4";
  okBtn.dispatchEvent(new FakeEvent("click", { bubbles: true }));
  const chosen = await p;
  assert.equal(chosen, 4);
});

await check("Empty Mana Stone drag-onto-item enforces Retained refusal & drain confirm (never fires raw tradeskill)", async () => {
  assert.equal(evaluateManaStoneDrain({ itemType: 0x00080000, uiEffects: 0, curMana: 0, targetRetained: true }), "refuse-retained");
  assert.equal(evaluateManaStoneDrain({ itemType: 0x00080000, uiEffects: 0, curMana: 0, targetRetained: false }), "confirm-drain");
  assert.equal(evaluateManaStoneDrain({ itemType: 0x00080000, uiEffects: 1, curMana: 0, targetRetained: false }), "none");
  assert.equal(evaluateManaStoneDrain({ itemType: 0x00080000, uiEffects: 0, curMana: 500, targetRetained: false }), "none");
  assert.equal(evaluateManaStoneDrain({ itemType: 0x00080000, uiEffects: 0, curMana: 0, isSelfTarget: true }), "none");

  const STONE = 0x80009001;
  const RETAINED_WAND = 0x80009002;
  const NORMAL_WAND = 0x80009003;
  const prevHandle = window.__sessionHandle;
  const prevConfirm = window.__showManastoneConfirm;
  let confirmArg = null;
  let dropEvents = 0;
  const onDropEvt = () => { dropEvents++; };
  window.addEventListener("hb:inventory-item-on-item-drop", onDropEvt);
  try {
    window.__showManastoneConfirm = (opts) => { confirmArg = opts; };
    window.__sessionHandle = {
      ...prevHandle,
      objectIntProperty: (g, prop) => (g === STONE && prop === 1 ? 0x00080000 : 0),
      objectBoolProperty: (g, prop) => (g === RETAINED_WAND && prop === 91),
      objectName: (g) => (g === NORMAL_WAND ? "Silver Wand" : "Retained Wand"),
    };
    const stoneDrag = { guid: STONE, owned: true, item: { guid: STONE, name: "Mana Stone", itemType: 0x00080000, uiEffects: 0, stackSize: 1 } };
    const r1 = drag.executeItemAction({ op: "usewith", guid: STONE, target: RETAINED_WAND }, stoneDrag);
    assert.equal(r1, false, "Retained target must be refused");
    assert.equal(confirmArg, null);
    assert.equal(dropEvents, 0, "Retained target must not dispatch raw tradeskill drop");

    const r2 = drag.executeItemAction({ op: "usewith", guid: STONE, target: NORMAL_WAND }, stoneDrag);
    assert.equal(r2, true);
    assert.equal(dropEvents, 0, "Empty Mana Stone must open confirm modal instead of firing raw tradeskill drop");
    assert.deepEqual(confirmArg, {
      itemGuid: STONE,
      name: "Mana Stone",
      targetGuid: NORMAL_WAND,
      targetName: "Silver Wand",
      mode: "drain",
    });

    // Charged Mana Stone (uiEffects & 1) dispatches normal use-with without destruction modal.
    confirmArg = null;
    const chargedDrag = { guid: STONE, owned: true, item: { guid: STONE, name: "Mana Stone", itemType: 0x00080000, uiEffects: 1, stackSize: 1 } };
    const r3 = drag.executeItemAction({ op: "usewith", guid: STONE, target: NORMAL_WAND }, chargedDrag);
    assert.equal(r3, true);
    assert.equal(confirmArg, null);
    assert.equal(dropEvents, 1);
  } finally {
    window.removeEventListener("hb:inventory-item-on-item-drop", onDropEvt);
    window.__sessionHandle = prevHandle;
    window.__showManastoneConfirm = prevConfirm;
  }
});

await check("decideItemDrop enforces isContainedBy ancestor cycle guard and target trade-lock on usewith", () => {
  const outerPack = { guid: 0x7001, name: "Outer Pack", isPack: true, stackSize: 1 };
  const cycExt = decideItemDrop(
    { guid: 0x7001, item: outerPack, owned: false },
    { kind: DROP_TARGET.EMPTY_CELL, listKey: 0x7002, listKind: "ext", index: 0, count: 0 },
    { playerGuid: ME, isContainedBy: (target, anc) => target === 0x7002 && anc === 0x7001 },
  );
  assert.deepEqual(cycExt, { op: "reject", message: "You cannot place an object within itself!" });

  const dye = { guid: 0x7010, name: "Dye Pot", isPack: false, stackSize: 1 };
  const tradedCoat = { guid: 0x7011, name: "Coat", equipMask: 0, isPack: false, stackSize: 1 };
  const tradedCombine = decideItemDrop(
    { guid: 0x7010, item: dye, owned: true },
    { kind: DROP_TARGET.ITEM_CELL, listKey: MAIN_PACK_KEY, listKind: "inventory", index: 0, count: 2, item: tradedCoat },
    {
      playerGuid: ME,
      canUseWith: () => true,
      isBeingTraded: (g) => g === 0x7011,
    },
  );
  assert.deepEqual(tradedCombine, { op: "reject", message: "You can't use the Dye Pot on an item you are trading" });
});

await check("dollHit right-click examine fallback passes equipped item name + fromInventory (not player name)", () => {
  const hitEl = document.querySelector(".hb-inv-doll-hit");
  hitEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 214 });
  const prevMenu = window.__openContextMenuFor;
  const prevExam = window.__showExamineFor;
  let examined = null;
  try {
    delete window.__openContextMenuFor;
    window.__showExamineFor = (guid, opts) => { examined = { guid, opts }; };
    // (15, 30) hits CHEST_PLATE; (80, 10) hits bare Head silhouette (ME).
    hitEl.dispatchEvent(new FakeEvent("contextmenu", { bubbles: true, clientX: 15, clientY: 30 }));
    assert.deepEqual(examined, { guid: CHEST_PLATE, opts: { name: "Breastplate", fromInventory: true } });
    hitEl.dispatchEvent(new FakeEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 10 }));
    assert.equal(examined?.guid, ME);
    assert.equal(examined?.opts?.fromInventory, undefined);
  } finally {
    window.__openContextMenuFor = prevMenu;
    window.__showExamineFor = prevExam;
  }
});

await check("RynthWebHost.WieldItem & radial-menu handle multi-slot Aetheria sigils, 1H off-hand, wearables & WASM free()", async () => {
  const { RynthWebHost } = await import(pathToFileURL(path.join(APP, "rynth", "webhost.js")).href);
  const wieldedCalls = [];
  let aetheriaProp = 0x7;
  let invRows = [
    { guid: 0x9101, validLocations: 0x70000000, equipMask: 0x10000000 },
    { guid: 0x9102, validLocations: 0x70000000, equipMask: 0 },
  ];
  const host = new RynthWebHost({
    get playerAetheriaBits() { return aetheriaProp; },
    playerInventory: () => invRows,
    wieldFromPack: (g, m) => { wieldedCalls.push([g >>> 0, m >>> 0]); },
  });
  host.WieldItem(0x9102, 0);
  assert.deepEqual(wieldedCalls.pop(), [0x9102, 0x20000000], "Blue occupied -> picks Yellow sigil");
  invRows = [{ guid: 0x9102, validLocations: 0x70000000, equipMask: 0 }];
  aetheriaProp = 0x4; // only Red unlocked
  host.WieldItem(0x9102, 0);
  assert.deepEqual(wieldedCalls.pop(), [0x9102, 0x40000000], "Only Red unlocked -> picks Red sigil");
  host.dispose();

  const rm = await import(pathToFileURL(path.join(APP, "plugins", "radial-menu.js")).href);
  // 1H melee offers Main Hand + Off-Hand; 2H does not.
  assert.deepEqual(
    rm.enumerateEquipSlots(EQUIP.MeleeWeapon, { combatUse: 1 }, 0x7),
    [{ mask: EQUIP.MeleeWeapon, name: "Main Hand" }, { mask: EQUIP.Shield, name: "Off-Hand" }],
  );
  // Locked Aetheria slots are filtered out.
  assert.deepEqual(
    rm.enumerateEquipSlots(0x70000000, {}, 0x2),
    [{ mask: 0x20000000, name: "Yellow Aetheria" }],
  );

  let freed = 0;
  let setWieldedArgs = null;
  const prevHandle = window.__sessionHandle;
  const prevInv = window.__inventory;
  const prevHb = window.__hotbar;
  try {
    window.__inventory = null; // exercise standalone fallback mask
    window.__hotbar = {
      slotCount: () => 2,
      findFirstEmpty: () => 0,
      getSlot: () => null,
      bindItemToSlot: () => {},
    };
    window.__sessionHandle = {
      playerAetheriaBits: 0,
      setWielded: (g, m) => { setWieldedArgs = [g >>> 0, m >>> 0]; },
      playerInventory: () => [
        { guid: 0x9201, name: "Coat", itemType: 0x4, validLocations: 0x00001A00, equipMask: 0, stackSize: 1, free() { freed++; } },
        { guid: 0x9202, name: "Blue Aetheria", itemType: 0x8, validLocations: 0x70000000, equipMask: 0, stackSize: 1, free() { freed++; } },
        { guid: 0x9203, name: "Side Pack", itemType: 0x200, validLocations: 0, equipMask: 0, stackSize: 1, free() { freed++; } },
      ],
    };
    const { items: coatItems } = rm.buildItems({ source: "inv-grid", guid: 0x9201, name: "Coat" });
    assert.equal(freed, 3, "radial-menu must free() all WASM InventoryItem entries");
    const coatEquip = coatItems.find((i) => i.label === "Equip");
    assert.ok(coatEquip, "Coat has single Equip action");
    coatEquip.action();
    assert.deepEqual(setWieldedArgs, [0x9201, 0x00001A00], "Coat fallback Equip preserves full wearable coverage mask");
    assert.ok(coatItems.some((i) => i.label === "Add To Hotbar ▸"), "Coat can bind to hotbar");

    const { items: sigilItems } = rm.buildItems({ source: "inv-grid", guid: 0x9202, name: "Blue Aetheria" });
    assert.ok(!sigilItems.some((i) => i.label.startsWith("Equip")), "Sigil hides Equip when playerAetheriaBits === 0");
    assert.ok(!sigilItems.some((i) => i.label === "Add To Hotbar ▸"), "Sigil excluded from Add To Hotbar");

    const { items: packItems } = rm.buildItems({ source: "inv-grid", guid: 0x9203, name: "Side Pack" });
    assert.ok(!packItems.some((i) => i.label === "Add To Hotbar ▸"), "Container excluded from Add To Hotbar");
  } finally {
    window.__sessionHandle = prevHandle;
    window.__inventory = prevInv;
    window.__hotbar = prevHb;
  }
});

unmount?.();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
