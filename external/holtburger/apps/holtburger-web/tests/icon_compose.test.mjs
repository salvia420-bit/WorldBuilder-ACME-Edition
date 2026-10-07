// tests/icon_compose.test.mjs — bug 12 (2026-10-07): retail icon composition.
//
// Retail `IconData::RenderIcons` (acclient.c:437901) / OpenAC
// `App/UI/IconComposer`: type background + underlay + (icon + overlay with the
// DAT's white key colour replaced by the UI-effect tile). Before this, HB drew
// the raw icon: white outlines on a flat slot ("white boxes"). Enum tables are
// the client_portal.dat EnumIDMaps 0x25000008/09/0A/0B.
//
// Run from apps/holtburger-web/:  node tests/icon_compose.test.mjs

import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import * as C from "../ui/ac_icon_compose.js";

let passed = 0, failed = 0;
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
};
const solid = (w, h, rgba) => {
  const p = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) p.set(rgba, i * 4);
  return { width: w, height: h, pixels: p };
};
const px = (img, x, y) => Array.from(img.pixels.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

check("item-type background = EnumIDMap 0x25000008[LowestSetBit+1]", () => {
  assert.equal(C.itemBackgroundDid(0x1), 0x060011CB);      // MeleeWeapon
  assert.equal(C.itemBackgroundDid(0x2), 0x060011CF);      // Armor
  assert.equal(C.itemBackgroundDid(0x4), 0x060011F3);      // Clothing
  assert.equal(C.itemBackgroundDid(0x40), 0x060011F4);     // Money
  assert.equal(C.itemBackgroundDid(0x200), 0x060011CE);    // Container
  assert.equal(C.itemBackgroundDid(0x800), 0x060011D3);    // Gem
  assert.equal(C.itemBackgroundDid(0x100000), 0x06005E23); // Service
  assert.equal(C.itemBackgroundDid(0x2000), 0x060011D4);   // Writable → default tile
  assert.equal(C.itemBackgroundDid(0), 0x060011D4);        // none → [33]
  assert.equal(C.itemBackgroundDid(0x6), 0x060011CF);      // lowest bit wins (Armor)
});

check("UI-effect tile = 0x25000009[LowestSetBit+1], else [33] (solid black)", () => {
  assert.equal(C.itemEffectTileDid(0), 0x060011C5);
  assert.equal(C.itemEffectTileDid(0x1), 0x060011CA);    // Magical
  assert.equal(C.itemEffectTileDid(0x20), 0x06001B2E);   // Fire
  assert.equal(C.itemEffectTileDid(0x21), 0x060011CA);   // Magical|Fire → lowest bit
  assert.equal(C.itemEffectTileDid(0x1000), 0x060011C5); // Nether: no [13] entry → [33]
});

check("composite: transparent pixels show the type background", () => {
  const bg = solid(2, 2, [10, 20, 30, 255]);
  const icon = solid(2, 2, [0, 0, 0, 0]);
  icon.pixels.set([200, 100, 50, 255], 0);
  const { icon: out } = C.composeItemIcon({ background: bg, icon, effectTile: solid(2, 2, [0, 0, 0, 255]) });
  assert.deepEqual(px(out, 0, 0), [200, 100, 50, 255]);
  assert.deepEqual(px(out, 1, 1), [10, 20, 30, 255]);
});

check("composite: the white key becomes the effect tile's pixel (black for a plain item)", () => {
  const icon = solid(2, 1, [255, 255, 255, 255]);
  icon.pixels.set([254, 255, 255, 255], 4); // near-white is NOT the key
  const tile = solid(2, 1, [0, 0, 0, 255]);
  tile.pixels.set([40, 60, 220, 255], 0);  // a blue magical gradient pixel
  const { icon: out, drag } = C.composeItemIcon({ background: solid(2, 1, [9, 9, 9, 255]), icon, effectTile: tile });
  assert.deepEqual(px(drag, 0, 0), [40, 60, 220, 255]);
  assert.deepEqual(px(drag, 1, 0), [254, 255, 255, 255]);
  assert.deepEqual(px(out, 0, 0), [40, 60, 220, 255]);
  for (let i = 0; i < out.pixels.length; i += 4) {
    const w = out.pixels[i] === 255 && out.pixels[i + 1] === 255 && out.pixels[i + 2] === 255;
    assert.equal(w, false, "no pure-white pixel survives");
  }
});

check("composite: the overlay is blended BEFORE the white replace (retail order)", () => {
  const icon = solid(1, 1, [0, 0, 0, 0]);
  const overlay = solid(1, 1, [255, 255, 255, 255]); // an overlay drawn in key white
  const tile = solid(1, 1, [7, 8, 9, 255]);
  const { drag } = C.composeItemIcon({ icon, overlay, effectTile: tile });
  assert.deepEqual(px(drag, 0, 0), [7, 8, 9, 255]);
});

check("drag icon keeps the icon's transparency (no background)", () => {
  const icon = solid(1, 2, [0, 0, 0, 0]);
  icon.pixels.set([100, 100, 100, 255], 0);
  const { drag } = C.composeItemIcon({ background: solid(1, 2, [1, 2, 3, 255]), icon, effectTile: null });
  assert.equal(px(drag, 0, 1)[3], 0);
});

check("spell layers: power backing / Reversed tint / self & fellowship overlay", () => {
  const a = C.spellIconLayers({ iconId: 0x06001234, bitfield: 0x0, firstComponent: 3 });
  assert.equal(a.backing, 0x060013F6); // CopperScarab
  assert.equal(a.tint, 0x06004C3F);    // NonReversed
  assert.equal(a.overlay, 0);
  const b = C.spellIconLayers({ iconId: 1, bitfield: 0x10 | 0x8, firstComponent: 0x70 });
  assert.equal(b.backing, 0x06001F63); // PlatinumScarab (power level 8)
  assert.equal(b.tint, 0x06004C3E);    // Reversed
  assert.equal(b.overlay, 0x060013F3); // TargetSelf
  const c = C.spellIconLayers({ iconId: 1, bitfield: 0x2000 | 0x8, firstComponent: 1 });
  assert.equal(c.overlay, 0x060030D7); // fellowship wins over self
  assert.equal(C.spellPowerLevel(0xC1), 10);
  assert.equal(C.spellPowerLevel(999), 0);
});

check("canvas-free PNG round-trips (signature, IHDR, CRC, zlib, pixels)", () => {
  const img = solid(3, 2, [0, 0, 0, 0]);
  img.pixels.set([1, 2, 3, 4, 250, 251, 252, 253], 0);
  const png = C.encodePngRgba(img.width, img.height, img.pixels);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset);
  assert.equal(dv.getUint32(16), 3);
  assert.equal(dv.getUint32(20), 2);
  assert.equal(png[24], 8); assert.equal(png[25], 6);
  // walk chunks, find IDAT
  let o = 8, idat = null;
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === "IDAT") idat = png.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.from(idat));
  assert.equal(raw.length, 2 * (1 + 3 * 4));
  assert.deepEqual(Array.from(raw.subarray(1, 9)), [1, 2, 3, 4, 250, 251, 252, 253]);
  const url = C.rgbaToPngDataUrl(img.width, img.height, img.pixels);
  assert.match(url, /^data:image\/png;base64,/);
});

check("player main pack is 0x0600127E composed as a Container", () => {
  assert.equal(C.PLAYER_PACK_ICON, 0x0600127E);
  assert.equal(C.itemBackgroundDid(C.ITEM_TYPE_CONTAINER), 0x060011CE);
});

console.log(`\nicon_compose: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
