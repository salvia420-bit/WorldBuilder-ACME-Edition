// tests/commerce_slot_icon.test.mjs — hud-ui-3 (2026-10-13).
//
// Retail draws every UIItem list — vendor stock, trade wells, salvage list,
// house payment wells — through `IconData::RenderIcons`
// (UIElement_UIItem::UIItem_SetIcon, acclient.c:272213), and the effects list
// through `ClientMagicSystem::GetSpellIcon` (EffectInfoRegion,
// acclient.c:286409). Bug 12 composed inventory / container / corpse / hotbar
// / drag icons only; plugins/commerce_window.js `fillSlotIcon` still drew the
// raw DAT icon (white key outline, no type background). This pins:
//   - an object meta → the composite (`item:<bg>:…` key, background + effect
//     tile fetched); a bare number → the raw icon, unchanged;
//   - `slotIconMeta` fills a guid from the wasm entity store, then the
//     inventory rows; an unknown guid with no item type → raw;
//   - a refill supersedes a fetch still in flight; a cached composite paints
//     synchronously (vendor cells are built detached);
//   - vendor stock composes from the VendorItemJs fields (uiEffects /
//     iconOverlay / iconUnderlay when the pkg/ has them, else iconId+itemType);
//   - `fetchSpellIconWithFallback`: the spell composite with a wasm record,
//     the raw icon without one.
//
// Run from apps/holtburger-web/:  node tests/commerce_slot_icon.test.mjs

import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/fake_dom_items.mjs";

globalThis.window = globalThis;
const { document } = installFakeDom(globalThis);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}
const flush = () => new Promise((r) => setTimeout(r, 5));

/* ── stub wasm: every RenderSurface decodes to one opaque-ish pixel ────── */
const requested = [];
globalThis.__hbWasm = {
  fetch_icon_pixels: async (did) => {
    requested.push(did >>> 0);
    const v = did & 0xff;
    return { width: 1, height: 1, pixels: new Uint8Array([v, 255 - v, 7, 255]) };
  },
};
const asked = (did) => requested.includes(did >>> 0);

/* ── stub session: entity store + inventory ──────────────────────────── */
const PLAYER = 0x50000001;
const SWORD = 0x80000101; // in the entity store
const RING = 0x80000102;  // inventory row only
const store = new Map([
  [SWORD, { name: "Flaming Sword", icon: 0x06000A01, ints: { 1: 0x1, 18: 0x20 }, dids: { 50: 0x06000A02, 52: 0x06000A03 } }],
]);
const inv = [
  { guid: RING, wcid: 9, name: "Ring", value: 1, stackSize: 1, itemType: 0x8, iconId: 0x06000B01, equipMask: 0, containerId: PLAYER },
];
let spellRecords = new Map();
globalThis.__sessionHandle = {
  objectName: (g) => store.get(g >>> 0)?.name,
  objectIntProperty: (g, k) => store.get(g >>> 0)?.ints?.[k],
  objectDataIdProperty: (g, k) => store.get(g >>> 0)?.dids?.[k],
  getObjectIconId: (g) => store.get(g >>> 0)?.icon ?? 0,
  objectWcid: () => 0,
  playerInventory: () => inv.map((i) => ({ ...i })),
  getSpellRecord: (id) => spellRecords.get(id >>> 0),
  getVendorState: () => null,
};
globalThis.getLocalPlayerGuid = () => PLAYER;

const cache = await import("../ui/ac_icon_cache.js");
const C = await import("../ui/ac_icon_compose.js");
const cw = await import("../plugins/commerce_window.js");

function slotIn(parent = document.body) {
  const s = document.createElement("div");
  s.className = "hbk-slot";
  parent.appendChild(s);
  return s;
}
const imgOf = (slot) => slot.childNodes.filter((c) => c.tagName === "IMG");

console.log("[commerce slot icons]");

await check("an object meta paints the retail composite (type background + effect tile)", async () => {
  cache.resetIconCache(); requested.length = 0;
  const meta = { iconId: 0x06000C01, itemType: 0x1 };
  const slot = slotIn();
  cw.fillSlotIcon(slot, meta, "Dagger");
  await flush();
  const full = { iconId: 0x06000C01, itemType: 0x1, uiEffects: 0, iconOverlay: 0, iconUnderlay: 0 };
  assert.match(cache.itemIconKey(full), new RegExp(`^item:${0x060011CB}:`)); // MeleeWeapon tile
  assert.ok(asked(0x060011CB), "background requested");
  assert.ok(asked(0x060011C5), "default (black) effect tile requested");
  const imgs = imgOf(slot);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].src, cache.getItemIconImmediate(full));
  assert.equal(cache.getIconImmediate(0x06000C01), null, "the raw path was not taken");
  assert.equal(slot.querySelectorAll(".hb-cw-glyph").length, 0);
});

await check("a bare icon id keeps the raw path (no background, no tile)", async () => {
  cache.resetIconCache(); requested.length = 0;
  const slot = slotIn();
  cw.fillSlotIcon(slot, 0x06000C02, "Raw");
  await flush();
  assert.deepEqual(requested, [0x06000C02]);
  assert.equal(imgOf(slot)[0]?.src, cache.getIconImmediate(0x06000C02));
});

await check("icon id 0 leaves the initial glyph only", async () => {
  const slot = slotIn();
  cw.fillSlotIcon(slot, { iconId: 0, itemType: 1 }, "nothing");
  cw.fillSlotIcon(slotIn(), 0, "x");
  await flush();
  assert.equal(imgOf(slot).length, 0);
  assert.equal(slot.querySelectorAll(".hb-cw-glyph")[0].textContent, "N");
});

await check("slotIconMeta: a guid resolves from the entity store (type, effects, overlay, underlay)", () => {
  assert.deepEqual(cw.slotIconMeta({ guid: SWORD }), {
    iconId: 0x06000A01, itemType: 0x1, uiEffects: 0x20, iconOverlay: 0x06000A02, iconUnderlay: 0x06000A03,
  });
});

await check("slotIconMeta: inventory rows are the fallback; caller fields win", () => {
  assert.deepEqual(cw.slotIconMeta({ guid: RING }), {
    iconId: 0x06000B01, itemType: 0x8, uiEffects: 0, iconOverlay: 0, iconUnderlay: 0,
  });
  assert.equal(cw.slotIconMeta({ guid: SWORD, iconId: 0x06000F0F }).iconId, 0x06000F0F);
  assert.equal(cw.slotIconMeta({ guid: SWORD, iconId: 0 }).iconId, 0x06000A01);
});

await check("slotIconMeta: an unknown guid with no item type → null (raw icon)", async () => {
  assert.equal(cw.slotIconMeta({ guid: 0x8000DEAD, iconId: 0x06000D01 }), null);
  assert.equal(cw.slotIconMeta({ guid: 0x8000DEAD, iconId: 0x06000D01, itemType: 0x2 }).itemType, 0x2);
  cache.resetIconCache(); requested.length = 0;
  const slot = slotIn();
  cw.fillSlotIcon(slot, { guid: 0x8000DEAD, iconId: 0x06000D01 }, "Unknown");
  await flush();
  assert.deepEqual(requested, [0x06000D01]);
  assert.equal(imgOf(slot).length, 1);
});

await check("a guid slot (trade / salvage / tinker / house) composes with the stored layers", async () => {
  cache.resetIconCache(); requested.length = 0;
  const slot = slotIn();
  cw.fillSlotIcon(slot, { guid: SWORD, iconId: 0x06000A01 }, "Flaming Sword");
  await flush();
  for (const did of [0x060011CB, 0x06000A03, 0x06000A01, 0x06000A02, 0x06001B2E]) {
    assert.ok(asked(did), `0x${did.toString(16)} requested`); // bg, underlay, icon, overlay, Fire tile
  }
  assert.equal(imgOf(slot)[0]?.src, cache.getItemIconImmediate(cw.slotIconMeta({ guid: SWORD })));
});

await check("a refill supersedes a fetch still in flight (one image, the latest)", async () => {
  cache.resetIconCache();
  const slot = slotIn();
  cw.fillSlotIcon(slot, { iconId: 0x06000E01, itemType: 0x2 }, "A");
  cw.fillSlotIcon(slot, 0x06000E02, "B");
  await flush();
  const imgs = imgOf(slot);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].src, cache.getIconImmediate(0x06000E02));
});

await check("a cached composite paints synchronously, even into a detached slot", async () => {
  const meta = { iconId: 0x06000C01, itemType: 0x1 };
  cache.resetIconCache();
  await cache.fetchItemIconDataUrl(meta, "test");
  const detached = document.createElement("div");
  cw.fillSlotIcon(detached, meta, "Dagger");
  assert.equal(imgOf(detached).length, 1);
  assert.equal(imgOf(detached)[0].src, cache.getItemIconImmediate(meta));
});

await check("the drawn composite is the retail blit (half-alpha overlay not darkened)", () => {
  const bg = { width: 1, height: 1, pixels: new Uint8ClampedArray([10, 20, 30, 255]) };
  const icon = { width: 1, height: 1, pixels: new Uint8ClampedArray([0, 0, 0, 0]) };
  const overlay = { width: 1, height: 1, pixels: new Uint8ClampedArray([200, 100, 50, 128]) };
  const { icon: out } = C.composeItemIcon({ background: bg, icon, overlay, effectTile: null });
  assert.deepEqual(Array.from(out.pixels), [105, 60, 40, 255]);
});

console.log("[vendor stock]");
const vendor = await import("../plugins/vendor-ui.js");
void vendor;

await check("vendor stock composes from VendorItemJs (effects / overlay / underlay; stale pkg/ = type only)", async () => {
  cache.resetIconCache(); requested.length = 0;
  window.__vendorPluginDebug.open({
    vendorGuid: 0x70000009, vendorName: "Armorer", buyMultiplier: 0.9, sellMultiplier: 1.5,
    alternateCurrencyWcid: 0, alternateCurrencyAmount: 0, alternateCurrencyName: "",
    items: [
      { itemGuid: 0x90000001, wcid: 1, name: "Fire Axe", value: 10, stackSize: 1, itemType: 0x1, iconId: 0x06000F01,
        uiEffects: 0x20, iconOverlay: 0x06000F02, iconUnderlay: 0x06000F03 },
      { itemGuid: 0x90000002, wcid: 2, name: "Plain Cap", value: 10, stackSize: 1, itemType: 0x2, iconId: 0x06000F04 },
    ],
  });
  await flush();
  const root = document.getElementById("hb-vendor-bar");
  const cellImg = (g) => {
    const cell = root.querySelectorAll(".hvb-cell").find((c) => c.dataset.itemGuid === String(g));
    return cell?.querySelectorAll("img")[0] ?? null;
  };
  const axe = { iconId: 0x06000F01, itemType: 0x1, uiEffects: 0x20, iconOverlay: 0x06000F02, iconUnderlay: 0x06000F03 };
  const cap = { iconId: 0x06000F04, itemType: 0x2, uiEffects: 0, iconOverlay: 0, iconUnderlay: 0 };
  assert.ok(cellImg(0x90000001), "axe icon painted");
  assert.equal(cellImg(0x90000001).src, cache.getItemIconImmediate(axe));
  assert.equal(cellImg(0x90000002).src, cache.getItemIconImmediate(cap));
  assert.ok(asked(0x06001B2E) && asked(0x06000F02) && asked(0x06000F03), "Fire tile + overlay + underlay requested");
  assert.ok(asked(0x060011CF), "Armor background requested for the stale-pkg line");
  window.__vendorPluginDebug.close();
});

console.log("[spell icons]");

await check("fetchSpellIconWithFallback: the composite with a wasm spell record", async () => {
  cache.resetIconCache(); requested.length = 0;
  spellRecords = new Map([[2, new Map([["iconId", 0x06000910], ["bitfield", 0x8], ["components", [3]]])]]);
  const url = await cache.fetchSpellIconWithFallback(2, 0x06000910, "test");
  assert.equal(typeof url, "string");
  assert.ok(asked(0x060013F6), "CopperScarab backing requested");
  assert.ok(asked(0x06004C3F), "NonReversed tile requested");
  assert.ok(asked(0x060013F3), "self-targeted overlay requested");
  assert.equal(cache.getIconImmediate(0x06000910), null, "the raw path was not taken");
});

await check("fetchSpellIconWithFallback: the raw icon without a record (pre-login catalog row)", async () => {
  cache.resetIconCache(); requested.length = 0;
  spellRecords = new Map();
  const url = await cache.fetchSpellIconWithFallback(1234, 0x06000920, "test");
  assert.equal(url, cache.getIconImmediate(0x06000920));
  assert.deepEqual(requested, [0x06000920]);
  assert.equal(await cache.fetchSpellIconWithFallback(1234, 0, "test"), null);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
