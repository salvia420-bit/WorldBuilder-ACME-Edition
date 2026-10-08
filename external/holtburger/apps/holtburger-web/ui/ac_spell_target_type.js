// =============================================================================
// spellcast-2 (2026-10-08) — retail spell-formula target type (pure, no DOM/wasm)
// =============================================================================
//
// Retail decides whether a cast needs a selection from the spell FORMULA, not
// from a per-spell flag (acclient.c):
//   ClientMagicSystem::CastSpell (:404671) — `_bitfield & 8` (SelfTargeted)
//     casts at the player; otherwise `if (!CSpellBase::InqTargetType(...))`
//     sends CM_Magic::Event_CastUntargetedSpell without reading the selection;
//     only a non-zero target type casts at the selected object.
//   CSpellBase::InqTargetType (:449055) = Complete ? GetTargetingType : 0.
//   SpellFormula::Complete (:487706) — the first five components are non-zero.
//   SpellFormula::GetTargetingType (:487766) — the talisman: the last component
//     of the non-zero run that starts at slot 4 (slots 5..7 extend it).
//   SpellComponentTable::GetTargetTypeFromComponentID (:487059) — the ItemType
//     mask that talisman allows; 0 = untargeted.
// Rings, walls and sprays end in a mask-0 talisman (1783 Searing Disc ends in
// Elder Talisman 0x3A), so retail casts them the moment you press cast, with or
// without a selection. The DAT has no SelfTargeted spell whose formula type is
// 0 (tests/spell_target_type.test.mjs), so "self" and "untargeted" never overlap.
//
// The wasm record's `isUntargeted` is a different predicate
// (non_component_target_type == 0) and is not used for routing.
//
// `?formulaUntargeted=off` (default ON) restores the SelfTargeted-only rule.

/** SpellComponentTable::GetTargetTypeFromComponentID (acclient.c:487059). */
export function targetTypeFromComponentId(scid) {
  const id = scid >>> 0;
  if ((id >= 0x31 && id <= 0x38) || (id >= 0x3c && id <= 0x3e) || id === 0xbe) return 0x10;
  if (id === 0x39) return 0x88b8f;
  if (id === 0x3b) return 0x10010000;
  return 0;
}

/** Formula as 8 numeric slots. Accepts numbers (the wasm record's decrypted
 *  formula) or "Comp_N" strings (data/spells-catalog.json); anything else is 0. */
export function normalizeComponents(components) {
  const out = [0, 0, 0, 0, 0, 0, 0, 0];
  if (!Array.isArray(components)) return out;
  for (let i = 0; i < 8 && i < components.length; i++) {
    const c = components[i];
    let n = 0;
    if (typeof c === "number") n = c;
    else if (typeof c === "string") {
      const m = /^(?:Comp_)?(\d+)$/.exec(c);
      if (m) n = Number(m[1]);
    }
    out[i] = Number.isFinite(n) ? (n >>> 0) : 0;
  }
  return out;
}

/** SpellFormula::Complete (acclient.c:487706). */
export function isFormulaComplete(components) {
  const c = normalizeComponents(components);
  for (let i = 0; i < 5; i++) if (c[i] === 0) return false;
  return true;
}

/** SpellFormula::GetTargetingType (acclient.c:487766). */
export function getTargetingType(components) {
  const c = normalizeComponents(components);
  let v = 5;
  while (v < 8 && c[v] !== 0) v++;
  return targetTypeFromComponentId(c[v - 1]);
}

/** CSpellBase::InqTargetType (acclient.c:449055). 0 = untargeted. */
export function inqTargetType(components) {
  return isFormulaComplete(components) ? getTargetingType(components) : 0;
}

/** `?formulaUntargeted` (default ON; `off`/`0`/`false` = SelfTargeted only). */
export function formulaUntargetedEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("formulaUntargeted")?.toLowerCase();
    return !(v === "off" || v === "0" || v === "false");
  } catch (_) { return true; }
}

/**
 * True when the cast goes out without a selection: the SelfTargeted bit, or
 * (flag on) a formula whose target type is 0. An unknown formula (no
 * components) counts as targeted, which is the pre-fix behaviour.
 */
export function castNeedsNoSelection({ selfTargeted, components } = {}, formulaOn = formulaUntargetedEnabled()) {
  if (selfTargeted) return true;
  if (!formulaOn) return false;
  if (!Array.isArray(components) || components.length === 0) return false;
  return inqTargetType(components) === 0;
}

/**
 * Display class for a catalog-shaped spell ({ untargeted, components }):
 * "target" needs a selection, "none" is formula-untargeted, "self" casts on
 * the caster. Valid because no SelfTargeted spell has a type-0 formula.
 */
export function spellTargetClass(meta) {
  if (!meta || meta.untargeted !== true) return "target";
  const comps = meta.components;
  if (Array.isArray(comps) && comps.length > 0 && inqTargetType(comps) === 0) return "none";
  return "self";
}

/**
 * `?formulaUntargeted=off` for the JSON catalog: its `untargeted` is
 * SelfTargeted OR formula type 0 (scripts/build_spells_catalog.py), so
 * dropping the type-0 formulas leaves exactly the SelfTargeted bit.
 */
export function catalogSelfTargetedOnly(spells) {
  const out = {};
  for (const [id, meta] of Object.entries(spells || {})) {
    out[id] = (spellTargetClass(meta) === "none") ? { ...meta, untargeted: false } : meta;
  }
  return out;
}
