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

// ── 9. Post-commit audit fixes (items 1–7) ──────────────────────────────────
await check("blocksUseOfShield suppresses off-hand EQUIP.Shield widening in helpers, drop rules, and radial-menu", async () => {
  const rm = await import(pathToFileURL(path.join(APP, "plugins", "radial-menu.js")).href);
  const twoHandOnMelee = { guid: 0x9301, name: "Two-Handed Spear", validLocations: EQUIP.MeleeWeapon, equipMask: 0, combatUse: 5 };
  const casterOnMelee = { guid: 0x9302, name: "Staff Caster", validLocations: EQUIP.MeleeWeapon, equipMask: 0, itemType: 0x8000, combatUse: 4 };
  const launcherOnMelee = { guid: 0x9303, name: "Atlatl", validLocations: EQUIP.MeleeWeapon, equipMask: 0, combatUse: 2, ammoType: 1 };
  const oneHandMelee = { guid: 0x9304, name: "Hand Axe", validLocations: EQUIP.MeleeWeapon, equipMask: 0, combatUse: 1 };

  for (const blocked of [twoHandOnMelee, casterOnMelee, launcherOnMelee]) {
    assert.equal(effectiveValidLocationsForSlot(EQUIP.MeleeWeapon, EQUIP.Shield, blocked), EQUIP.MeleeWeapon);
    const state = { rows: [blocked], retailWieldLegal: true, inCombatMode: false };
    assert.deepEqual(canEquipInSlot(blocked, EQUIP.Shield, state), { ok: false, silent: true, reason: "" });
    const drop = decideItemDrop(
      { guid: blocked.guid, item: blocked, owned: true },
      { kind: DROP_TARGET.DOLL_SLOT, slotMask: EQUIP.Shield },
      { playerGuid: ME, canEquip: (it, m) => canEquipInSlot(it, m, state) },
    );
    assert.equal(drop.op, "noop");
    assert.equal(drop.refused, true);
    assert.deepEqual(rm.enumerateEquipSlots(EQUIP.MeleeWeapon, blocked, 0x7), [{ mask: EQUIP.MeleeWeapon, name: "Melee" }]);
  }
  assert.equal(effectiveValidLocationsForSlot(EQUIP.MeleeWeapon, EQUIP.Shield, oneHandMelee), EQUIP.MeleeWeapon | EQUIP.Shield);
  assert.equal(canEquipInSlot(oneHandMelee, EQUIP.Shield, { rows: [oneHandMelee], retailWieldLegal: true, inCombatMode: false }).ok, true);
  // Legacy strict branch (retailWieldLegal falsy) remains strict.
  assert.equal(canEquipInSlot({ equipMask: EQUIP.MeleeWeapon, validLocations: EQUIP.MeleeWeapon }, EQUIP.Shield, {}).ok, false);
});

await check("Hotbar shortcut badge covers Row 1 slots 0..8 (1..9) and excludes Row 2 slot 9 (Alt+1)", async () => {
  const prevHb = window.__hotbar;
  try {
    window.__hotbar = {
      getSlot: (i) => {
        if (i === 8) return { itemGuid: POTION };
        if (i === 9) return { itemGuid: GEM };
        return null;
      },
    };
    window.dispatchEvent(new FakeEvent("hb-hotbar-changed"));
    await settle();
    const potCell = document.querySelector(`.hb-inv-slot[data-guid="${POTION}"]`);
    const gemCell = document.querySelector(`.hb-inv-slot[data-guid="${GEM}"]`);
    assert.equal(potCell?.dataset?.shortcut, "9", "slot 8 (key 9) gets badge 9");
    assert.ok(potCell?.querySelector(".hb-uiitem-sc"), "slot 8 renders .hb-uiitem-sc");
    assert.equal(gemCell?.dataset?.shortcut, undefined, "slot 9 (Alt+1) must NOT get badge 0");
    assert.equal(gemCell?.querySelector(".hb-uiitem-sc"), null, "slot 9 renders no .hb-uiitem-sc");
  } finally {
    window.__hotbar = prevHb;
    window.dispatchEvent(new FakeEvent("hb-hotbar-changed"));
    await settle();
  }
});

await check("Item Structure Bar (0x10000348) and copyInventoryRow preserve structure, maxStructure, and itemUseable", async () => {
  const rowFull = copyInventoryRow({ guid: 0x9401, structure: 50, maxStructure: 50, itemUseable: 0x0004 });
  assert.equal(rowFull.structure, 50);
  assert.equal(rowFull.maxStructure, 50);
  assert.equal(rowFull.itemUseable, 0x0004);
  assert.equal(helpers.structureBarFraction({ structure: 0, maxStructure: 0 }), -1);
  assert.equal(helpers.structureBarFraction({ structure: 50, maxStructure: 50 }), -1);
  assert.equal(helpers.structureBarFraction({ structure: 25, maxStructure: 50 }), 0.5);
  assert.equal(helpers.structureBarFraction({ structure: 0, maxStructure: 50 }), 0);
  assert.equal(helpers.isWieldedUsable({ itemUseable: 0x0001 }), false);
  assert.equal(helpers.isWieldedUsable({ itemUseable: 0x0008 }), false);
  assert.equal(helpers.isWieldedUsable({ itemUseable: 0x0004 }), true);
  assert.equal(helpers.isWieldedUsable({ itemUseable: 0x00080004 }), true);

  const KIT_HALF = 0x9411;
  const KIT_EMPTY = 0x9412;
  const KIT_FULL = 0x9413;
  const WORN_ORB = 0x9414;
  inv.push(
    { guid: KIT_HALF, wcid: 201, name: "Healer's Kit", iconId: 0x06001011, itemType: 0x80, stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0, requiresBackpackSlot: false, itemsCapacity: 0, structure: 25, maxStructure: 50 },
    { guid: KIT_EMPTY, wcid: 202, name: "Spent Kit", iconId: 0x06001012, itemType: 0x80, stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0, requiresBackpackSlot: false, itemsCapacity: 0, structure: 0, maxStructure: 50 },
    { guid: KIT_FULL, wcid: 203, name: "Fresh Kit", iconId: 0x06001013, itemType: 0x80, stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0, requiresBackpackSlot: false, itemsCapacity: 0, structure: 50, maxStructure: 50 },
    { guid: WORN_ORB, wcid: 204, name: "Shield", iconId: 0x06001014, itemType: 0x2, stackSize: 1, equipMask: EQUIP.Shield, containerId: 0, validLocations: EQUIP.Shield, requiresBackpackSlot: false, itemsCapacity: 0, structure: 10, maxStructure: 40 },
  );
  bus.emit("playerInventoryChanged", { detail: {} });
  await settle();

  const halfCell = document.querySelector(`.hb-inv-slot[data-guid="${KIT_HALF}"]`);
  const emptyCell = document.querySelector(`.hb-inv-slot[data-guid="${KIT_EMPTY}"]`);
  const fullCell = document.querySelector(`.hb-inv-slot[data-guid="${KIT_FULL}"]`);
  const potCell = document.querySelector(`.hb-inv-slot[data-guid="${POTION}"]`);
  const shieldSlot = document.querySelector(`.hb-inv-doll-slot[data-equip-mask="${EQUIP.Shield}"]`);

  assert.equal(halfCell?.dataset?.structure, "25/50");
  assert.equal(halfCell?.querySelector(".hb-uiitem-struct > i")?.style.getPropertyValue("--struct"), "50.0%");
  assert.equal(emptyCell?.dataset?.structure, "0/50");
  assert.equal(emptyCell?.querySelector(".hb-uiitem-struct > i")?.style.getPropertyValue("--struct"), "0.0%");
  assert.equal(fullCell?.querySelector(".hb-uiitem-struct"), null, "full structure hides bar");
  assert.equal(potCell?.querySelector(".hb-uiitem-struct"), null, "maxStructure=0 hides bar");
  assert.equal(shieldSlot?.dataset?.structure, "10/40");
  assert.equal(shieldSlot?.querySelector(".hb-uiitem-struct > i")?.style.getPropertyValue("--struct"), "25.0%");

  // Removing WORN_ORB clears structure bar on the emptied paperdoll slot.
  inv = inv.filter((r) => ![KIT_HALF, KIT_EMPTY, KIT_FULL, WORN_ORB].includes(r.guid));
  bus.emit("playerInventoryChanged", { detail: {} });
  await settle();
  assert.equal(shieldSlot?.querySelector(".hb-uiitem-struct"), null);
});

await check("Owned non-side-pack (main-grid) & nested containers open in inventory.js instead of corpse-loot-bar", async () => {
  const groundMod = await import(pathToFileURL(path.join(APP, "plugins", "ground_container_rules.js")).href);
  const dropFlagsMod = await import(pathToFileURL(path.join(APP, "plugins", "drop_item_flags.js")).href);
  globalThis.__CP = { ...helpers, ...groundMod, ...dropFlagsMod };
  loadSpliced("plugins/container-panel.js", [], {
    resolveContainedItemMeta: "() => ({ name: 'Item', iconId: 0, itemType: 0, stackSize: 1 })",
    setAcText: "(el, t) => { if (el) el.textContent = String(t ?? ''); }",
    fetchIconDataUrlShared: "() => Promise.resolve(null)",
    fetchItemIconDataUrl: "() => Promise.resolve(null)",
    clearPlaceholderGlyph: "() => {}",
    uiEffectBadgesEnabled: "() => false",
    uiEffectIconsFor: "() => []",
    uiEffectTintCss: "() => null",
    takeInventorySnapshot: "globalThis.__CP.takeInventorySnapshot",
    DropItemFlags: "globalThis.__CP.DropItemFlags",
    isDropAccepted: "globalThis.__CP.isDropAccepted",
    groundObjectGateEnabled: "globalThis.__CP.groundObjectGateEnabled",
    groundObjectFacts: "globalThis.__CP.groundObjectFacts",
    isLandscapeGroundObject: "globalThis.__CP.isLandscapeGroundObject",
    replacedGroundObject: "globalThis.__CP.replacedGroundObject",
  });

  const MAIN_CHEST = 0x71000001;
  const NESTED_POUCH = 0x71000002;
  const NESTED_RING = 0x71000003;
  let lastTitle = "";
  let corpseLootOpens = 0;
  const prevTitleFn = window.__mainPanel.setTitle;
  const prevLootBar = window.__corpseLootBar;
  try {
    window.__mainPanel.setTitle = (t) => { lastTitle = String(t ?? ""); return true; };
    window.__corpseLootBar = { openFor: () => { corpseLootOpens++; }, isOpen: () => false };
    inv.push(
      {
        guid: MAIN_CHEST, wcid: 301, name: "Small Chest", iconId: 0x06001021, itemType: 0x200,
        stackSize: 1, equipMask: 0, containerId: 0, validLocations: 0,
        requiresBackpackSlot: false, itemsCapacity: 20,
      },
      {
        guid: NESTED_POUCH, wcid: 302, name: "Nested Pouch", iconId: 0x06001022, itemType: 0x200,
        stackSize: 1, equipMask: 0, containerId: PACK, validLocations: 0,
        requiresBackpackSlot: true, itemsCapacity: 10,
      },
      {
        guid: NESTED_RING, wcid: 303, name: "Silver Ring", iconId: 0x06001023, itemType: 0x8,
        stackSize: 1, equipMask: 0, containerId: NESTED_POUCH, validLocations: 0x000C0000,
        requiresBackpackSlot: false, itemsCapacity: 0,
      },
    );
    bus.emit("playerInventoryChanged", { detail: {} });
    await settle();

    // 1. Main-grid container (requiresBackpackSlot=false) opens via activateItem, sends Use once when unviewed.
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(window.__inventory.activateItem(MAIN_CHEST), true);
    await settle();
    assert.equal(window.__inventory.selectedPack(), MAIN_CHEST);
    assert.equal(lastTitle, "Contents of Small Chest");
    assert.equal(corpseLootOpens, 0, "owned main-grid chest must NOT open corpse-loot-bar");
    assert.equal(calls.filter((c) => c[0] === "useObject" && c[1] === MAIN_CHEST).length, 1, "unviewed container sends useObject once");
    window.__inventory.openPack(MAIN_CHEST);
    assert.equal(calls.filter((c) => c[0] === "useObject" && c[1] === MAIN_CHEST).length, 1, "re-selecting viewed container does not resend useObject");

    // 2. Nested container inside PACK opens via window.__openContainerFor & radial Open inside inventory.js.
    window.__openContainerFor(NESTED_POUCH, "Nested Pouch");
    await settle();
    assert.equal(window.__inventory.selectedPack(), NESTED_POUCH);
    assert.equal(lastTitle, "Contents of Nested Pouch");
    assert.equal(corpseLootOpens, 0, "owned nested pouch must NOT open corpse-loot-bar");
    assert.ok(document.querySelector(`.hb-inv-slot[data-guid="${NESTED_RING}"]`), "nested pouch item renders in inventory grid");

    // Even a containerOpened bus event for an owned container must NOT open corpse-loot-bar.
    bus.emit("containerOpened", { detail: { u32Payload: NESTED_POUCH, stringPayload: "Nested Pouch" } });
    await settle();
    assert.equal(corpseLootOpens, 0);

    // Non-container Foci and unowned GUIDs are rejected by openPack.
    window.__inventory.openPack(0);
    await settle();
    assert.equal(window.__inventory.openPack(FOCI), false);
    assert.equal(window.__inventory.openPack(0xdeadbeef), false);
    assert.equal(window.__inventory.selectedPack(), 0);
  } finally {
    inv = inv.filter((r) => ![MAIN_CHEST, NESTED_POUCH, NESTED_RING].includes(r.guid));
    window.__inventory.openPack(0);
    window.__mainPanel.setTitle = prevTitleFn;
    window.__corpseLootBar = prevLootBar;
    bus.emit("playerInventoryChanged", { detail: {} });
    await settle();
  }
});

await check("Paperdoll dollHit caches getBoundingClientRect across mousemove, anchors tooltip near cursor, and respects SourceWielded on dblclick", async () => {
  const hitEl = document.querySelector(".hb-inv-doll-hit");
  let rectReads = 0;
  hitEl.getBoundingClientRect = () => {
    rectReads++;
    return { left: 0, top: 0, width: 100, height: 214 };
  };
  const prevW = window.innerWidth;
  const prevH = window.innerHeight;
  window.innerWidth = 800;
  window.innerHeight = 600;
  try {
    hitEl.dispatchEvent(new FakeEvent("mouseenter", { bubbles: false }));
    for (let i = 0; i < 5; i++) {
      hitEl.dispatchEvent(new FakeEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30 }));
    }
    assert.equal(rectReads, 1, "5 mousemoves in one hover should call dollHit.getBoundingClientRect once");
    const tip = document.getElementById("hb-item-tooltip");
    assert.equal(tip?.dataset?.show, "1");
    const topAt30 = parseFloat(tip.style.top);

    // Paint another chest pixel at y=160 so cursor movement down the silhouette moves the tooltip too.
    const pLow = (160 * 100 + 15) * 4;
    hitRgba[pLow + 1] = 255;
    hitRgba[pLow + 3] = 255;

    // Force fresh hit-map NOT needed because hitTestMap copied pixels; test cursor anchor directly on head pixel at y=10 vs chest at y=30:
    hitEl.dispatchEvent(new FakeEvent("mousemove", { bubbles: true, clientX: 80, clientY: 10 }));
    const topAt10 = parseFloat(tip.style.top);
    assert.notEqual(topAt30, topAt10, "tooltip vertical position tracks cursor point rather than static 214px box top");
    assert.equal(rectReads, 1, "moving across hit regions still reuses cached dollHit rect");
    hitEl.dispatchEvent(new FakeEvent("mouseleave", { bubbles: false }));

    // SourceWielded double-click on paperdoll slot:
    const FOCUS_ORB = 0x9501;
    const TARGET_ORB = 0x9502;
    let targetBegun = null;
    const prevUseTgt = window.__useTargeting;
    window.__useTargeting = { begin: (g, nm) => { targetBegun = [g >>> 0, nm]; } };
    try {
      inv.push({
        guid: FOCUS_ORB, wcid: 401, name: "Amulet of Focusing", iconId: 0x06001031, itemType: 0x8,
        stackSize: 1, equipMask: 0x00008000, containerId: 0, validLocations: 0x00008000,
        requiresBackpackSlot: false, itemsCapacity: 0, itemUseable: 0x0004,
      });
      bus.emit("playerInventoryChanged", { detail: {} });
      await settle();

      const neckSlot = document.querySelector(`.hb-inv-doll-slot[data-equip-mask="${0x00008000}"]`);
      calls.length = 0;
      await new Promise((r) => setTimeout(r, 220));
      neckSlot.dispatchEvent(new FakeEvent("dblclick", { bubbles: true, button: 0 }));
      await settle();
      assert.ok(calls.some((c) => c[0] === "useObject" && c[1] === FOCUS_ORB), "SourceWielded untargeted item sends useObject on paperdoll dblclick");
      assert.ok(!calls.some((c) => c[0] === "moveItem" || c[0] === "unwield"), "SourceWielded item must NOT unwield on dblclick");

      // Targeted SourceWielded item enters target mode on paperdoll dblclick.
      inv = inv.filter((r) => r.guid !== FOCUS_ORB);
      inv.push({
        guid: TARGET_ORB, wcid: 402, name: "Casting Ring", iconId: 0x06001032, itemType: 0x8,
        stackSize: 1, equipMask: 0x00080000, containerId: 0, validLocations: 0x000C0000,
        requiresBackpackSlot: false, itemsCapacity: 0, itemUseable: 0x00080004,
      });
      bus.emit("playerInventoryChanged", { detail: {} });
      await settle();
      const ringSlot = document.querySelector(`.hb-inv-doll-slot[data-equip-mask="${0x00080000}"]`);
      calls.length = 0;
      await new Promise((r) => setTimeout(r, 220));
      ringSlot.dispatchEvent(new FakeEvent("dblclick", { bubbles: true, button: 0 }));
      await settle();
      assert.deepEqual(targetBegun, [TARGET_ORB, "Casting Ring"]);
      assert.equal(calls.length, 0);
    } finally {
      inv = inv.filter((r) => r.guid !== FOCUS_ORB && r.guid !== TARGET_ORB);
      window.__useTargeting = prevUseTgt;
      bus.emit("playerInventoryChanged", { detail: {} });
      await settle();
    }
  } finally {
    window.innerWidth = prevW;
    window.innerHeight = prevH;
  }
});

await check("radial-menu Split/Drop/Give/Equip/Unequip and paperdoll unwield enforce trade, busy, mid-air, bonded, whole-stack & side-pack overflow guards", async () => {
  const rm = await import(pathToFileURL(path.join(APP, "plugins", "radial-menu.js")).href);
  const STACK_COINS = 0x9601;
  const ATTUNED_COINS = 0x9602;
  const BONDED_COINS = 0x9603;
  const TRADED_COINS = 0x9604;
  const SHIELD_ITEM = 0x9605;
  const TWO_HANDER = 0x9606;
  const LOOSE_ARROW = 0x9607;
  const WORN_HELM = 0x9608;
  const NPC_TARGET = 0x80001234;

  const prevHandle = window.__sessionHandle;
  const prevBusy = window.__isBusy;
  const prevScene = window.liveScene3d;
  const clearPending = () => { for (const e of drag.pendingOps.all()) drag.pendingOps.fail(e.guid); };
  let selectedTarget = 0;
  let airborne = false;
  let busy = false;
  const actionCalls = [];
  const recA = (n) => (...a) => { actionCalls.push([n, ...a]); };
  let testInv = [
    { guid: STACK_COINS, wcid: 273, name: "Pyreal", itemType: 0x80, stackSize: 25, maxStackSize: 10000, equipMask: 0, containerId: 0, validLocations: 0, attuned: 0, bonded: 0 },
    { guid: ATTUNED_COINS, wcid: 273, name: "Attuned Token", itemType: 0x80, stackSize: 5, maxStackSize: 100, equipMask: 0, containerId: 0, validLocations: 0, attuned: 1, bonded: 0 },
    { guid: BONDED_COINS, wcid: 273, name: "Bonded Note", itemType: 0x80, stackSize: 5, maxStackSize: 100, equipMask: 0, containerId: 0, validLocations: 0, attuned: 0, bonded: 1 },
    { guid: TRADED_COINS, wcid: 273, name: "Traded Gem", itemType: 0x800, stackSize: 4, maxStackSize: 50, equipMask: 0, containerId: 0, validLocations: 0, attuned: 0, bonded: 0 },
    { guid: TWO_HANDER, wcid: 500, name: "Greataxe", itemType: 1, stackSize: 1, equipMask: EQUIP.TwoHanded, containerId: 0, validLocations: EQUIP.TwoHanded, combatUse: 5 },
    { guid: SHIELD_ITEM, wcid: 501, name: "Buckler", itemType: 2, stackSize: 1, equipMask: 0, containerId: 0, validLocations: EQUIP.Shield, combatUse: 3 },
    { guid: AMMO, wcid: 102, name: "Greater Arrow", itemType: 1, stackSize: 200, maxStackSize: 250, equipMask: EQUIP.MissileAmmo, containerId: 0, validLocations: EQUIP.MissileAmmo },
    { guid: LOOSE_ARROW, wcid: 102, name: "Greater Arrow", itemType: 1, stackSize: 30, maxStackSize: 250, equipMask: 0, containerId: 0, validLocations: EQUIP.MissileAmmo },
    { guid: WORN_HELM, wcid: 502, name: "Helm", itemType: 2, stackSize: 1, equipMask: 0x00000001, containerId: 0, validLocations: 0x00000001 },
    { guid: PACK, wcid: 105, name: "Overflow Pack", itemType: 0x200, stackSize: 1, equipMask: 0, containerId: 0, requiresBackpackSlot: true, itemsCapacity: 24 },
  ];

  try {
    drag.pendingOps.clear?.();
    window.__isBusy = () => busy;
    window.liveScene3d = { entityManager: { getSelectedTarget: () => selectedTarget } };
    window.__sessionHandle = {
      playerInventory: () => testInv.map((r) => ({ ...r, free() {} })),
      playerItemsCapacity: 102,
      playerContainersCapacity: 7,
      playerAetheriaBits: 0x7,
      combatMode: () => 1,
      getLocalPlayerPose: () => ({ isOnGround: !airborne, free() {} }),
      playerTrade: () => ({ myItems: [{ guid: TRADED_COINS, free() {} }], free() {} }),
      splitStackTo3D: recA("splitStackTo3D"),
      dropItem: recA("dropItem"),
      giveObject: recA("giveObject"),
      setWielded: recA("setWielded"),
      mergeStacks: recA("mergeStacks"),
      unwieldToPack: recA("unwieldToPack"),
      moveItem: recA("moveItem"),
    };

    // 1. Split Stack… disabled on attuned, blocked on trade & mid-air, prompts bonded confirm.
    const attunedMenu = rm.buildItems({ source: "inv-grid", guid: ATTUNED_COINS, name: "Attuned Token" }).items;
    const attunedSplit = attunedMenu.find((i) => i.label.startsWith("Split Stack"));
    assert.equal(attunedSplit?.disabled, true, "attuned stack disables Split Stack…");

    const tradedMenu = rm.buildItems({ source: "inv-grid", guid: TRADED_COINS, name: "Traded Gem" }).items;
    tradedMenu.find((i) => i.label === "Split Stack…").action(2);
    assert.equal(actionCalls.length, 0, "traded stack cannot Split Stack…");
    tradedMenu.find((i) => i.label === "Drop").action();
    assert.equal(actionCalls.length, 0, "traded stack cannot Drop");

    airborne = true;
    const coinMenuAir = rm.buildItems({ source: "inv-grid", guid: STACK_COINS, name: "Pyreal" }).items;
    coinMenuAir.find((i) => i.label === "Split Stack…").action(5);
    coinMenuAir.find((i) => i.label === "Drop").action();
    assert.equal(actionCalls.length, 0, "mid-air blocks both Split Stack… and Drop");
    assert.equal(document.getElementById("hb-item-toast")?.textContent, helpers.PLACE_IN_3D_TEXT.midAir);
    airborne = false;

    // Bonded Split Stack… opens bonded confirmation modal: cancel aborts, confirm sends splitStackTo3D.
    const bondedMenu = rm.buildItems({ source: "inv-grid", guid: BONDED_COINS, name: "Bonded Note" }).items;
    bondedMenu.find((i) => i.label === "Split Stack…").action(2);
    let modal = document.querySelector(".hb-dlg");
    assert.equal(modal?.getAttribute("data-open"), "1", "bonded split opens confirmation modal");
    const cancelBtn = modal.querySelector("button[data-action='cancel']");
    cancelBtn.onclick();
    assert.equal(actionCalls.length, 0, "cancelling bonded confirmation aborts splitStackTo3D");

    bondedMenu.find((i) => i.label === "Split Stack…").action(2);
    modal = document.querySelector(".hb-dlg");
    const okBtn = modal.querySelector("button[data-action='confirm']");
    okBtn.onclick();
    assert.deepEqual(actionCalls.pop(), ["splitStackTo3D", BONDED_COINS, 2]);
    drag.pendingOps.clear?.();

    // 2. Give passes full stackSize (25), blocks self-target and traded items.
    selectedTarget = ME;
    const selfGive = rm.buildItems({ source: "inv-grid", guid: STACK_COINS, name: "Pyreal" }).items.find((i) => i.label.startsWith("Give"));
    assert.equal(selfGive?.disabled, true, "self target disables Give");

    selectedTarget = NPC_TARGET;
    const tradedGive = rm.buildItems({ source: "inv-grid", guid: TRADED_COINS, name: "Traded Gem" }).items.find((i) => i.label === "Give");
    tradedGive.action();
    assert.equal(actionCalls.length, 0, "traded item cannot Give");

    const coinGive = rm.buildItems({ source: "inv-grid", guid: STACK_COINS, name: "Pyreal" }).items.find((i) => i.label === "Give");
    coinGive.action();
    assert.deepEqual(actionCalls.pop(), ["giveObject", NPC_TARGET, STACK_COINS, 25], "Give passes full stackSize");
    drag.pendingOps.clear?.();

    // 3. Equip checks busy, canEquipInSlot (Shield vs Two-Hander), and planAmmoWield merge.
    busy = true;
    const shieldEquipBusy = rm.buildItems({ source: "inv-grid", guid: SHIELD_ITEM, name: "Buckler" }).items.find((i) => i.label === "Equip");
    shieldEquipBusy.action();
    assert.equal(actionCalls.length, 0, "busy blocks Equip");
    busy = false;

    const prevInvHook = window.__inventory;
    window.__inventory = null; // test radial-menu's own runValidatedEquip path directly!
    try {
      const shieldEquip = rm.buildItems({ source: "inv-grid", guid: SHIELD_ITEM, name: "Buckler" }).items.find((i) => i.label === "Equip");
      shieldEquip.action();
      assert.equal(actionCalls.length, 0, "Shield Equip refused while Greataxe is wielded");
      assert.match(document.getElementById("hb-item-toast")?.textContent || "", /shield may not be worn/i);

      const arrowEquip = rm.buildItems({ source: "inv-grid", guid: LOOSE_ARROW, name: "Greater Arrow" }).items.find((i) => i.label === "Equip");
      arrowEquip.action();
      assert.deepEqual(actionCalls.pop(), ["mergeStacks", LOOSE_ARROW, AMMO, 30], "Equip on matching ammo merges into wielded stack");
      drag.pendingOps.clear?.();
    } finally {
      window.__inventory = prevInvHook;
    }

    // 4. Unequip & unwield overflow to openable side pack when 102/102 main pack is full.
    const filler = Array.from({ length: 102 }, (_, i) => ({
      guid: 0xa0000 + i, wcid: 900, name: `Rock ${i}`, itemType: 0x80,
      stackSize: 1, equipMask: 0, containerId: 0, requiresBackpackSlot: false, itemsCapacity: 0,
    }));
    testInv = [...filler, ...testInv.filter((r) => r.guid === WORN_HELM || r.guid === PACK)];
    const helmUnequip = rm.buildItems({ source: "inv-paperdoll", guid: WORN_HELM, name: "Helm" }).items.find((i) => i.label === "Unequip");
    helmUnequip.action();
    assert.deepEqual(actionCalls.pop(), ["moveItem", WORN_HELM, PACK, 0], "Unequip overflows to side pack when 102/102 main pack is full");
    // While WORN_HELM is in pendingOps, duplicate Unequip is suppressed:
    helmUnequip.action();
    assert.equal(actionCalls.length, 0, "pendingOps suppresses duplicate Unequip");
    clearPending();

    // Paperdoll dblclick (unwieldGuidToPack) also overflows to PACK when 102/102 main pack is full:
    const prevLiveInv = inv;
    inv = testInv;
    bus.emit("playerInventoryChanged", { detail: {} });
    await settle();
    const headSlot = document.querySelector(`.hb-inv-doll-slot[data-equip-mask="${0x00000001}"]`);
    headSlot.dispatchEvent(new FakeEvent("dblclick", { bubbles: true, button: 0 }));
    await settle();
    assert.deepEqual(actionCalls.pop(), ["moveItem", WORN_HELM, PACK, 0], "Paperdoll dblclick unwield overflows to side pack when 102/102 main pack is full");
    clearPending();
    inv = prevLiveInv;
    bus.emit("playerInventoryChanged", { detail: {} });
    await settle();
  } finally {
    clearPending();
    window.__sessionHandle = prevHandle;
    window.__isBusy = prevBusy;
    window.liveScene3d = prevScene;
  }
});

unmount?.();

await check("loadPaperdollHitMap lazily hydrates when window.__hbWasm.fetch_icon_pixels arrives AFTER mount()", async () => {
  const prevWasm = globalThis.__hbWasm;
  try {
    globalThis.__hbWasm = null;
    const lazyInvMod = loadSpliced("plugins/inventory.js", ["view"], {
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
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const unmount2 = lazyInvMod.view.mount(host2, {});
    await settle();
    const hitEl2 = host2.querySelector(".hb-inv-doll-hit");
    hitEl2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 214 });

    // Before WASM hydrates, cursor stays default.
    hitEl2.dispatchEvent(new FakeEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30 }));
    assert.equal(hitEl2.style.cursor, "default");

    // Hydrate async fetch_icon_pixels AFTER mount:
    globalThis.__hbWasm = {
      fetch_icon_pixels: async (did) => ((did >>> 0) === 0x06004d8b
        ? { width: 100, height: 214, pixels: hitRgba, free() {} }
        : null),
    };
    hitEl2.dispatchEvent(new FakeEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30 }));
    await settle();
    hitEl2.dispatchEvent(new FakeEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30 }));
    assert.equal(hitEl2.style.cursor, "pointer", "lazy hit-map hydration enables silhouette hit-testing without remount");
    unmount2();
    host2.remove();
  } finally {
    globalThis.__hbWasm = prevWasm;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
