// UiEffects registry — single source of truth for the item magic-effect
// flag → { 2D icon, tint } mapping. Track A (2D HUD icon/badge overlays) reads
// this; a future Track B could share the `tint`. See
// docs/PLAN-item-magic-effect-visuals-2026-06-24.md.
//
// UiEffects = PropertyInt 18 = a 2D inventory-icon overlay (acclient
// `IconData::RenderIcons`; Chorizite `IconData.cs:29` "border highlight").
// NOT a 3D effect. The retail enum `UI_EFFECT_TYPE` (acclient.h:7550) is 13
// named bits 0x1..0x1000. Retail renders the LOWEST set bit only
// (`imageIndex = LowestSetBit(effects)+1`, fallback Default=33); the
// LSD-Partial census found every item carries exactly ONE bit, so a flat
// lookup with no stacking engine is sufficient.
//
// `img` = the acclient `*_UIEffectImage` ORDINAL (image index), NOT a 0x06
// icon DataID — resolving ordinal→icon DataID is a Track-A A1 task (EnumIDMap
// `0x25000009`, per Chorizite DatReaderWriter.Extensions). `tint` is the
// per-effect color used by the A0 badge (and shareable with any 3D tint).
//
// Pure data + pure helpers; imports nothing from the THREE graph or the wasm
// layer, so this module is import-cycle-safe and lint-clean by construction.

/** @typedef {{flag:number, key:string, name:string, img:number, iconDid:number, tint:[number,number,number]}} UiEffectRow */

// `iconDid` = the real 0x06 RenderSurface icon DataID for each `*_UIEffectImage`
// ordinal, resolved from the retail DataIDMapper `0x25000009` (UI_EFFECT_ICONS,
// `holtburger-dat well_known_ids.rs:42`; Chorizite EnumIDMapExtensions.cs:24).
// Parsed directly from client_portal.dat 2026-06-24 (13 entries, ordinal -> DID,
// all confirmed Texture records). The badge loads this via `fetchIconDataUrl`
// (ac_icon_cache.js → wasm fetch_icon_pixels); `tint` is the fallback while the
// icon fetches / if it fails. Static retail data → baked here (no per-frame DAT read).

/** The 13 UI_EFFECT_TYPE bits (acclient.h:7550), in bit order. */
export const UI_EFFECT_REGISTRY = Object.freeze([
  Object.freeze({ flag: 0x0001, key: "magical",      name: "Magical",       img: 1,  iconDid: 0x060011CA, tint: [0.55, 0.45, 1.00] }),
  Object.freeze({ flag: 0x0002, key: "poisoned",     name: "Poisoned",      img: 2,  iconDid: 0x060011C6, tint: [0.40, 0.90, 0.20] }),
  Object.freeze({ flag: 0x0004, key: "boostHealth",  name: "Boost Health",  img: 3,  iconDid: 0x06001B05, tint: [0.90, 0.20, 0.20] }),
  Object.freeze({ flag: 0x0008, key: "boostMana",    name: "Boost Mana",    img: 4,  iconDid: 0x060011CA, tint: [0.30, 0.40, 1.00] }),
  Object.freeze({ flag: 0x0010, key: "boostStamina", name: "Boost Stamina", img: 5,  iconDid: 0x06001B06, tint: [0.90, 0.80, 0.20] }),
  Object.freeze({ flag: 0x0020, key: "fire",         name: "Fire",          img: 6,  iconDid: 0x06001B2E, tint: [1.00, 0.45, 0.10] }),
  Object.freeze({ flag: 0x0040, key: "lightning",    name: "Lightning",     img: 7,  iconDid: 0x06001B2D, tint: [0.50, 0.70, 1.00] }),
  Object.freeze({ flag: 0x0080, key: "frost",        name: "Frost",         img: 8,  iconDid: 0x06001B2F, tint: [0.60, 0.85, 1.00] }),
  Object.freeze({ flag: 0x0100, key: "acid",         name: "Acid",          img: 9,  iconDid: 0x06001B2C, tint: [0.50, 0.90, 0.30] }),
  Object.freeze({ flag: 0x0200, key: "bludgeon",     name: "Bludgeoning",   img: 10, iconDid: 0x060033C3, tint: [0.80, 0.80, 0.80] }),
  Object.freeze({ flag: 0x0400, key: "slash",        name: "Slashing",      img: 11, iconDid: 0x060033C2, tint: [0.85, 0.85, 0.90] }),
  Object.freeze({ flag: 0x0800, key: "pierce",       name: "Piercing",      img: 12, iconDid: 0x060033C4, tint: [0.85, 0.85, 0.90] }),
  // NETHER (0x1000) has no `*_UIEffectImage` row → falls back to
  // `Default_UIEffectImage = 33` → DID 0x060011C5 (per the 0x25000009 map).
  Object.freeze({ flag: 0x1000, key: "nether",       name: "Nether",        img: 33, iconDid: 0x060011C5, tint: [0.50, 0.10, 0.60] }),
]);

const _BY_FLAG = Object.freeze(
  Object.fromEntries(UI_EFFECT_REGISTRY.map((r) => [r.flag, r]))
);

/** Default fallback image index when a bit has no dedicated icon row. */
export const UI_EFFECT_DEFAULT_IMAGE = 33;

/**
 * Every registry row whose flag bit is set in `mask`, in bit order.
 * @param {number} mask  the PropertyInt.UiEffects bitmask
 * @returns {UiEffectRow[]}
 */
export function uiEffectsList(mask) {
  const m = (mask >>> 0);
  if (!m) return [];
  const out = [];
  for (const row of UI_EFFECT_REGISTRY) {
    if ((m & row.flag) !== 0) out.push(row);
  }
  return out;
}

/**
 * Track-A consumer: the 2D-overlay descriptors for a mask.
 * Retail renders only the lowest set bit; the census says items carry exactly
 * one bit, so this returns at most one entry in practice but handles multi-bit
 * data defensively (no stacking logic — just the list, lowest bit first).
 * @param {number} mask
 * @returns {{img:number, tint:[number,number,number], key:string, name:string}[]}
 */
export function uiEffectIconsFor(mask) {
  return uiEffectsList(mask).map((r) => ({
    img: r.img,
    iconDid: r.iconDid,
    tint: r.tint,
    key: r.key,
    name: r.name,
  }));
}

/** Look up a single row by its flag bit (or null). */
export function uiEffectRowForFlag(flag) {
  return _BY_FLAG[(flag >>> 0)] || null;
}

/**
 * `?uiEffectIcons` URL flag (default OFF). Track A is a DOM/HUD overlay that
 * never touches the WebGL canvas, so it gates independently of `?visual`.
 * Memoized; safe in non-browser contexts (returns false).
 */
let _uiEffectIconsOn;
export function uiEffectIconsEnabled() {
  if (_uiEffectIconsOn === undefined) {
    _uiEffectIconsOn = false; // non-browser/test default
    try {
      if (typeof window !== "undefined" && window.location) {
        const v = new URLSearchParams(window.location.search)
          .get("uiEffectIcons");
        // 2026-06-24: DEFAULT-ON (retail-faithful icons; `=off` to opt out)
        _uiEffectIconsOn = (v == null)
          ? true
          : !(["off", "0", "false", "no"].includes(String(v).toLowerCase()));
      }
    } catch (_) { /* default off in non-browser */ }
  }
  return _uiEffectIconsOn;
}

/** `rgb` triple (0..1) → CSS `rgb(r,g,b)` string. */
export function uiEffectTintCss(tint) {
  const c = (x) => Math.max(0, Math.min(255, Math.round((x || 0) * 255)));
  return `rgb(${c(tint[0])}, ${c(tint[1])}, ${c(tint[2])})`;
}
