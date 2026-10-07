// ui/ac_icon_compose.js — retail icon composition (bug 12, 2026-10-07). Pure.
//
// HB drew every item / spell icon as its raw DAT RenderSurface, so each icon
// showed the DAT's WHITE key colour (a 1-px outline, exactly 255,255,255,255)
// on a flat slot — the "white boxes" — and none of retail's coloured item-type
// backgrounds. Retail never shows the raw surface:
//
// ITEM — `IconData::RenderIcons` (acclient.c:437901), ported 1:1 by OpenAC
// `App/UI/IconComposer.GetIcon` / `GetOrCreateDragIcon`:
//   drag icon = icon, then the custom overlay (Blit_4Alpha), then every pixel
//               that is EXACTLY white replaced by the same pixel of the
//               UI-effect tile (`SurfaceWindow::ReplaceColor(white, tile)`,
//               :125691). Effect tile = EnumIDMap 0x10000005 (0x25000009)
//               [LowestSetBit(uiEffects)+1], falling back to [33] (solid black
//               0x060011C5) — so a plain item's outline is BLACK.
//   icon      = item-type background, EnumIDMap 0x10000004 (0x25000008)
//               [LowestSetBit(itemType)+1, or 33 when 0], then the custom
//               underlay (Blit_3Alpha), then the drag icon (Blit_3Alpha).
// SPELL — `ClientMagicSystem::CompositeSpellIcon` (acclient.c:404112), OpenAC
//   `IconComposer.GetSpellIcon`: power-component backing (0x10000006 →
//   0x2500000A [DeterminePowerLevelOfComponent(comps[0])]), the spell icon,
//   white → 0x10000007 (0x2500000B) [Reversed ? 1 : 2], then the fellowship
//   [4] or self-targeted [3] overlay.
// SPELL COMPONENT — `CompositeSpellComponentIcon` (:404190): white → black.
//
// The tables below are the DAT's EnumIDMaps (client_portal.dat, dumped with
// WorldBuilder.Terminal); the index rule is retail's.

/** EnumIDMap 0x25000008 (master 0x10000004 "UIIconBackgrounds"). */
export const ITEM_BACKGROUND_DIDS = Object.freeze({
  1: 0x060011CB, // MeleeWeapon
  2: 0x060011CF, // Armor
  3: 0x060011F3, // Clothing
  4: 0x060011D5, // Jewelry
  5: 0x060011D1, // Creature
  6: 0x060011CC, // Food
  7: 0x060011F4, // Money
  8: 0x060011D4, // Misc
  9: 0x060011D2, // MissileWeapon
  10: 0x060011CE, // Container
  11: 0x060011D0, // Useless
  12: 0x060011D3, // Gem
  13: 0x060011CD, // SpellComponents
  21: 0x06005E23, // Service
  33: 0x060011D4, // Default (every other index maps here too)
});
const ITEM_BACKGROUND_DEFAULT = 0x060011D4;

/** EnumIDMap 0x25000009 (master 0x10000005 "UIEffectIcons"). */
export const UI_EFFECT_TILE_DIDS = Object.freeze({
  1: 0x060011CA, // MAGICAL
  2: 0x060011C6, // POISONED
  3: 0x06001B05, // BOOST_HEALTH
  4: 0x060011CA, // BOOST_MANA
  5: 0x06001B06, // BOOST_STAMINA
  6: 0x06001B2E, // FIRE
  7: 0x06001B2D, // LIGHTNING
  8: 0x06001B2F, // FROST
  9: 0x06001B2C, // ACID
  10: 0x060033C3, // BLUDGEONING
  11: 0x060033C2, // SLASHING
  12: 0x060033C4, // PIERCING
  33: 0x060011C5, // Default (solid black)
});

/** EnumIDMap 0x2500000A (master 0x10000006): spell power-component backing. */
export const SPELL_POWER_BACKING_DIDS = Object.freeze({
  1: 0x060013F4, // LeadScarab
  2: 0x060013F5, // IronScarab
  3: 0x060013F6, // CopperScarab
  4: 0x060013F7, // SilverScarab
  5: 0x060013F8, // GoldScarab
  6: 0x060013F9, // PyrealScarab
  7: 0x060013F6, // DiamondScarab
  8: 0x06001F63, // PlatinumScarab
  9: 0x060013F6, // DarkScarab
  10: 0x060067A6, // ManaScarab
  33: 0x060011C5, // Default
});

/** EnumIDMap 0x2500000B (master 0x10000007): spell tint / overlays. */
export const SPELL_TILE_DIDS = Object.freeze({
  1: 0x06004C3E, // Reversed
  2: 0x06004C3F, // NonReversed
  3: 0x060013F3, // TargetSelf
  4: 0x060030D7, // TargetFellowship
  33: 0x060011C5, // Default
});

/** The player's own main pack (OpenAC InventoryController.PlayerPackBaseIcon),
 *  composed as ItemType.Container. */
export const PLAYER_PACK_ICON = 0x0600127E;
export const ITEM_TYPE_CONTAINER = 0x200;

const SPELL_REVERSED = 0x10;
const SPELL_SELF_TARGETED = 0x8;
const SPELL_FELLOWSHIP = 0x2000;

/** Retail `LowestSetBit`: bit index of the lowest set bit, -1 for 0. */
export function lowestSetBit(v) {
  const x = v >>> 0;
  if (x === 0) return -1;
  return 31 - Math.clz32(x & -x);
}

/** Item-type background tile (retail: index LowestSetBit+1, 33 when 0). */
export function itemBackgroundDid(itemType) {
  const lsb = lowestSetBit(itemType);
  const idx = lsb < 0 ? 33 : lsb + 1;
  return ITEM_BACKGROUND_DIDS[idx] ?? ITEM_BACKGROUND_DEFAULT;
}

/** UI-effect tile that replaces the icon's white key (falls back to [33]). */
export function itemEffectTileDid(uiEffects) {
  const idx = lowestSetBit(uiEffects) + 1;
  return UI_EFFECT_TILE_DIDS[idx] || UI_EFFECT_TILE_DIDS[33];
}

/** Retail `MagicSystem::DeterminePowerLevelOfComponent` (acclient.c). */
export function spellPowerLevel(componentId) {
  switch (componentId >>> 0) {
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    case 4: return 4;
    case 5: return 5;
    case 6: return 6;
    case 0x6e: return 7;
    case 0x70: return 8;
    case 0xc0: return 9;
    case 0xc1: return 10;
    default: return 0;
  }
}

/** The four layer DIDs of a retail spell icon. */
export function spellIconLayers({ iconId, bitfield, firstComponent }) {
  const power = spellPowerLevel(firstComponent);
  const bf = bitfield >>> 0;
  return {
    backing: SPELL_POWER_BACKING_DIDS[power] || 0,
    icon: iconId >>> 0,
    tint: SPELL_TILE_DIDS[(bf & SPELL_REVERSED) !== 0 ? 1 : 2],
    overlay: (bf & SPELL_FELLOWSHIP) !== 0 ? SPELL_TILE_DIDS[4]
      : (bf & SPELL_SELF_TARGETED) !== 0 ? SPELL_TILE_DIDS[3] : 0,
  };
}

/**
 * OpenAC `IconComposer.Compose`: the first layer sets the size, later layers
 * are alpha-blended over it (clipped to the base).
 * @param {Array<{width:number,height:number,pixels:Uint8Array|Uint8ClampedArray}|null>} layers
 * @returns {{width:number,height:number,pixels:Uint8ClampedArray}|null}
 */
export function composeLayers(layers) {
  const list = layers.filter((l) => l && l.width > 0 && l.height > 0 && l.pixels?.length);
  if (list.length === 0) return null;
  const base = list[0];
  const w = base.width, h = base.height;
  const out = new Uint8ClampedArray(base.pixels.length);
  out.set(base.pixels);
  for (let li = 1; li < list.length; li++) {
    const src = list[li];
    const cw = Math.min(w, src.width), ch = Math.min(h, src.height);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const di = (y * w + x) * 4, si = (y * src.width + x) * 4;
        const sa = src.pixels[si + 3] / 255;
        if (sa <= 0) continue;
        const da = 1 - sa;
        out[di] = src.pixels[si] * sa + out[di] * da;
        out[di + 1] = src.pixels[si + 1] * sa + out[di + 1] * da;
        out[di + 2] = src.pixels[si + 2] * sa + out[di + 2] * da;
        out[di + 3] = Math.min(255, src.pixels[si + 3] + out[di + 3] * da);
      }
    }
  }
  return { width: w, height: h, pixels: out };
}

/** `SurfaceWindow::ReplaceColor(white, tile)`: exact-white pixels take the
 *  tile's pixel at the same coordinates. In place. */
export function replaceWhiteFromTile(img, tile) {
  if (!img || !tile) return img;
  const { width: w, height: h, pixels: d } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      if (d[di] === 255 && d[di + 1] === 255 && d[di + 2] === 255 && d[di + 3] === 255
          && x < tile.width && y < tile.height) {
        const si = (y * tile.width + x) * 4;
        d[di] = tile.pixels[si];
        d[di + 1] = tile.pixels[si + 1];
        d[di + 2] = tile.pixels[si + 2];
        d[di + 3] = tile.pixels[si + 3];
      }
    }
  }
  return img;
}

/** Spell-component variant: white → opaque black. In place. */
export function replaceWhiteWithBlack(img) {
  if (!img) return img;
  const d = img.pixels;
  for (let i = 0; i + 3 < d.length; i += 4) {
    if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255 && d[i + 3] === 255) {
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
    }
  }
  return img;
}

/**
 * Retail item icon from decoded layers (any may be null).
 * @returns {{icon:object|null, drag:object|null}}
 */
export function composeItemIcon({ background, underlay, icon, overlay, effectTile }) {
  const drag = composeLayers([icon, overlay]);
  if (drag && effectTile) replaceWhiteFromTile(drag, effectTile);
  const full = composeLayers([background, underlay, drag]);
  return { icon: full, drag };
}

/** Retail spell icon from decoded layers (any may be null). */
export function composeSpellIcon({ backing, icon, tint, overlay }) {
  const img = composeLayers([backing, icon]);
  if (img && tint) replaceWhiteFromTile(img, tint);
  return overlay ? composeLayers([img, overlay]) : img;
}

/* ── canvas-free PNG encoder ────────────────────────────────────────────
 * Icons used to round-trip through `canvas.toDataURL`, i.e. a canvas
 * readback, which privacy-hardened browsers return as a blank/white image.
 * Encoding the RGBA directly (stored deflate blocks — icons are 32×32, 4 KB)
 * needs no canvas at all. */
let _crcTable = null;
function _crc32(bytes, start, end) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** RGBA → PNG bytes (colour type 6, 8-bit, no interlace, stored deflate). */
export function encodePngRgba(width, height, pixels) {
  const rowLen = width * 4 + 1;
  const raw = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * rowLen + 1);
  }
  // zlib: header, stored blocks (≤65535 each), Adler-32.
  const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlen = 2 + raw.length + nBlocks * 5 + 4;
  const z = new Uint8Array(zlen);
  let o = 0;
  z[o++] = 0x78; z[o++] = 0x01;
  for (let b = 0; b < nBlocks; b++) {
    const s = b * 65535;
    const len = Math.min(65535, raw.length - s);
    z[o++] = b === nBlocks - 1 ? 1 : 0;
    z[o++] = len & 0xFF; z[o++] = (len >>> 8) & 0xFF;
    z[o++] = ~len & 0xFF; z[o++] = (~len >>> 8) & 0xFF;
    z.set(raw.subarray(s, s + len), o); o += len;
  }
  let a = 1, bsum = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; bsum = (bsum + a) % 65521; }
  const adler = ((bsum << 16) | a) >>> 0;
  z[o++] = adler >>> 24; z[o++] = (adler >>> 16) & 0xFF; z[o++] = (adler >>> 8) & 0xFF; z[o++] = adler & 0xFF;

  const chunks = [];
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, _crc32(c, 4, 8 + data.length));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", z);
  chunk("IEND", new Uint8Array(0));
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  let total = sig.length;
  for (const c of chunks) total += c.length;
  const png = new Uint8Array(total);
  png.set(sig, 0);
  let p = sig.length;
  for (const c of chunks) { png.set(c, p); p += c.length; }
  return png;
}

/** RGBA → `data:image/png;base64,...` without a canvas. */
export function rgbaToPngDataUrl(width, height, pixels) {
  const png = encodePngRgba(width, height, pixels);
  let b64;
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < png.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
    }
    b64 = btoa(s);
  } else {
    b64 = Buffer.from(png).toString("base64");
  }
  return "data:image/png;base64," + b64;
}
