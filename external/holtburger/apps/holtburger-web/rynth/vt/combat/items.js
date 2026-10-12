// rynth/vt/combat/items.js — the VTank Items tab model (PLAN W1-7 CMB, §2.5
// I1-I3, G:152-166) and the D38 item-buff defaults.
//
// Items are combat gear the macro may wield: wand/staff/orb (caster), melee
// weapon, missile weapon, shield, pet essence. Entries live in the profile
// list "items" (VtOptions getList/setList — this module stores nothing
// itself). Identity on another character: resolve by guid, then by
// (name, wcid) in the current inventory (§3.2).
//
// "Add" vs "Add (No Buffs)" (G:156-157): noBuffs:true items are skipped by the
// item-buff projection; a plain-Add SHIELD gets ITEM_BUFF_DEFAULTS.shield
// (Impenetrability + the 7 banes, D38/Q23), every other kind gets none
// (weapon auras are self buffs in the dynamic buff list).

import { ELEMENTS as ELEMENT_LIST } from "./spell_tables.js";

/** @typedef {import("./spell_tables.js").Element} Element */
/** @typedef {"caster"|"melee"|"missile"|"shield"|"pet"} ItemKind */
/** @typedef {{ guid: number, name: string, wcid: number, kind: ItemKind, element: Element|null, noBuffs: boolean }} ItemEntry */

export const ITEM_KINDS = Object.freeze(["caster", "melee", "missile", "shield", "pet"]);

export const ITEM_BUFF_FAMILIES = Object.freeze([
  "impen",
  "bane:slash",
  "bane:pierce",
  "bane:bludgeon",
  "bane:fire",
  "bane:cold",
  "bane:lightning",
  "bane:acid",
]);

export const ITEM_BUFF_DEFAULTS = Object.freeze({
  shield: Object.freeze(["impen", "bane:slash", "bane:pierce", "bane:bludgeon", "bane:fire", "bane:cold", "bane:lightning", "bane:acid"]),
  melee: Object.freeze([]),
  missile: Object.freeze([]),
  caster: Object.freeze([]),
  pet: Object.freeze([]),
});

/**
 * The item-enchant families to keep on an Items entry: [] when noBuffs; the
 * per-item override buffsList.itemSpells[guid] when present (unknown family
 * names dropped); else ITEM_BUFF_DEFAULTS[kind].
 */
export function itemBuffFamilies(entry, buffsList) {
  if (!entry || entry.noBuffs) return [];
  const g = Number(entry.guid) >>> 0;
  const over = buffsList && buffsList.itemSpells && typeof buffsList.itemSpells === "object" ? buffsList.itemSpells : null;
  if (over && Object.prototype.hasOwnProperty.call(over, String(g)) && Array.isArray(over[String(g)])) {
    return over[String(g)].filter((f) => ITEM_BUFF_FAMILIES.includes(f));
  }
  const d = ITEM_BUFF_DEFAULTS[entry.kind];
  return d ? d.slice() : [];
}

// ACE ItemType (ACE.Entity/Enum/ItemType.cs) and EquipMask (EquipMask.cs:32-37).
const IT_MELEE = 0x1;
const IT_ARMOR = 0x2;
const IT_MISSILE = 0x100;
const IT_CASTER = 0x8000;
const EM_MELEE = 0x00100000;
const EM_SHIELD = 0x00200000;
const EM_MISSILE = 0x00400000;
const EM_TWO_HANDED = 0x02000000;
// PropertyInt.DamageType (45) flags (ACE DamageType): the element shown for a
// weapon, highest-priority flag first (RynthAi LegacyWeaponsUi.cs:272-289).
const PINT_DAMAGE_TYPE = 45;
const DAMAGE_FLAG_ORDER = Object.freeze([
  [0x400, "Nether"],
  [0x10, "Fire"],
  [0x8, "Cold"],
  [0x40, "Lightning"],
  [0x20, "Acid"],
  [0x1, "Slash"],
  [0x2, "Pierce"],
  [0x4, "Bludgeon"],
]);
const PET_NAME_RE = /essence/i; // RynthAi LegacyWeaponsUi.cs:317-319 (essence ⇒ pet device)

const ELEMENTS = new Set(ELEMENT_LIST);

/** DamageType flags → Element (null for 0 / unknown). */
export function elementFromDamageType(flags) {
  const f = Number(flags) >>> 0;
  if (!f) return null;
  for (const [bit, el] of DAMAGE_FLAG_ORDER) if (f & bit) return el;
  return null;
}

/** Classify an inventory row (TryGetPlayerInventory shape) → ItemKind | null. */
export function classifyItem(invItem, { isPetDevice = null } = {}) {
  if (!invItem || typeof invItem !== "object") return null;
  const it = Number(invItem.itemType) >>> 0;
  const vl = Number(invItem.validLocations) >>> 0;
  const name = String(invItem.name ?? "");
  if (typeof isPetDevice === "function") {
    try {
      if (isPetDevice(invItem)) return "pet";
    } catch (_) {
      /* fall through */
    }
  }
  if (it & IT_CASTER) return "caster";
  if (it & IT_MISSILE || vl & EM_MISSILE) return "missile";
  if (it & IT_MELEE || vl & (EM_MELEE | EM_TWO_HANDED)) return "melee";
  if (it & IT_ARMOR && vl & EM_SHIELD) return "shield";
  if (PET_NAME_RE.test(name)) return "pet";
  return null;
}

function normalizeItem(e) {
  const src = e && typeof e === "object" ? e : {};
  const kind = ITEM_KINDS.includes(src.kind) ? src.kind : null;
  return {
    guid: Number(src.guid) >>> 0,
    name: String(src.name ?? ""),
    wcid: Number(src.wcid) >>> 0,
    kind,
    element: ELEMENTS.has(src.element) ? src.element : null,
    noBuffs: src.noBuffs === true,
  };
}

const KIND_LABEL = "a wand/staff/orb, melee weapon, missile weapon, shield or pet essence";

export class ItemsModel {
  constructor({ options = null, host = null, log, isPetDevice = null } = {}) {
    this.options = options;
    this.host = host;
    this.log = typeof log === "function" ? log : (m) => console.log(`[vt:items] ${m}`);
    this.isPetDevice = typeof isPetDevice === "function" ? isPetDevice : null;
    this._mem = []; // used only without options
  }

  _read() {
    try {
      if (this.options && typeof this.options.getList === "function") {
        const v = this.options.getList("items");
        return Array.isArray(v) ? v.map(normalizeItem).filter((e) => e.kind) : [];
      }
    } catch (_) {
      /* fall through */
    }
    return this._mem.map((e) => ({ ...e }));
  }

  _write(list, source = "ui") {
    const rows = list.map((e) => ({ ...e }));
    try {
      if (this.options && typeof this.options.setList === "function") {
        const r = this.options.setList("items", rows, { source });
        return r && r.ok === false ? { ok: false, error: r.error || "could not save the Items list" } : { ok: true };
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    this._mem = rows;
    return { ok: true };
  }

  _inventory() {
    const h = this.host;
    if (!h) return [];
    try {
      if (typeof h.TryGetPlayerInventoryCached === "function") return h.TryGetPlayerInventoryCached() || [];
      if (typeof h.TryGetPlayerInventory === "function") return h.TryGetPlayerInventory() || [];
    } catch (_) {
      /* unreadable */
    }
    return [];
  }

  list() {
    return this._read();
  }

  find(guid) {
    const g = Number(guid) >>> 0;
    if (!g) return null;
    return this._read().find((e) => e.guid === g) || null;
  }

  ofKind(kind) {
    return this._read().filter((e) => e.kind === kind);
  }

  classify(invItem) {
    return classifyItem(invItem, { isPetDevice: this.isPetDevice });
  }

  /**
   * Add an item. `entry` may be partial: { guid } (or { name }) plus
   * { noBuffs }; missing name/wcid/kind/element are read from the inventory.
   * Refused (with a message) when the item is not one of the allowed kinds.
   */
  add(entry) {
    try {
      const src = entry && typeof entry === "object" ? entry : {};
      let guid = Number(src.guid) >>> 0;
      const inv = this._inventory();
      let row = guid ? inv.find((i) => (i.guid >>> 0) === guid) : null;
      if (!guid && src.name) {
        const want = String(src.name).trim().toLowerCase();
        row = inv.find((i) => String(i.name ?? "").trim().toLowerCase() === want) || null;
        if (row) guid = row.guid >>> 0;
      }
      if (!guid) return { ok: false, error: src.name ? `no item named "${src.name}" in your inventory` : "no item selected" };
      const name = String(src.name ?? (row && row.name) ?? "");
      const kind = ITEM_KINDS.includes(src.kind) ? src.kind : row ? this.classify(row) : null;
      if (!kind) return { ok: false, error: `${name || "that item"} is not ${KIND_LABEL}` };
      let element = ELEMENTS.has(src.element) ? src.element : null;
      if (!element && (kind === "melee" || kind === "missile" || kind === "caster")) element = this._elementOf(guid);
      const e = normalizeItem({
        guid,
        name: name || (row && row.name) || "",
        wcid: src.wcid ?? (row && row.wcid) ?? 0,
        kind,
        element,
        noBuffs: src.noBuffs === true,
      });
      const list = this._read();
      if (list.some((x) => x.guid === e.guid)) return { ok: false, error: `${e.name || "that item"} is already on the Items list` };
      list.push(e);
      const w = this._write(list);
      return w.ok ? { ok: true, entry: { ...e } } : w;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  _elementOf(guid) {
    const h = this.host;
    if (!h || typeof h.TryGetObjectIntProperty !== "function") return null;
    try {
      const v = h.TryGetObjectIntProperty(guid, PINT_DAMAGE_TYPE);
      return typeof v === "number" ? elementFromDamageType(v) : null;
    } catch (_) {
      return null;
    }
  }

  /** Patch fields of one entry (guid is the identity and is never changed). */
  update(guid, patch) {
    try {
      const g = Number(guid) >>> 0;
      const list = this._read();
      const i = list.findIndex((e) => e.guid === g);
      if (i < 0) return { ok: false, error: "not on the Items list" };
      const p = patch && typeof patch === "object" ? patch : {};
      const next = normalizeItem({ ...list[i], ...p, guid: g });
      if (!next.kind) return { ok: false, error: `kind must be one of ${ITEM_KINDS.join(", ")}` };
      if ("element" in p && p.element != null && !next.element) return { ok: false, error: `unknown element ${p.element}` };
      list[i] = next;
      return this._write(list);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  remove(guid) {
    try {
      const g = Number(guid) >>> 0;
      const list = this._read();
      const next = list.filter((e) => e.guid !== g);
      if (next.length === list.length) return { ok: false, error: "not on the Items list" };
      return this._write(next);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * The live guid of an entry: its own guid when this character owns it, else
   * the (name, wcid) match in the current inventory, else 0.
   */
  resolveGuid(entry) {
    try {
      if (!entry) return 0;
      const g = Number(entry.guid) >>> 0;
      const inv = this._inventory();
      if (g && inv.some((i) => (i.guid >>> 0) === g)) return g;
      const name = String(entry.name ?? "").trim().toLowerCase();
      const wcid = Number(entry.wcid) >>> 0;
      if (!name) return 0;
      const hit = inv.find((i) => String(i.name ?? "").trim().toLowerCase() === name && (!wcid || (Number(i.wcid) >>> 0) === wcid));
      return hit ? hit.guid >>> 0 : 0;
    } catch (_) {
      return 0;
    }
  }
}
