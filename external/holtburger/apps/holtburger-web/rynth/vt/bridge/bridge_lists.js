// rynth/vt/bridge/bridge_lists.js — the VT bridge's list tabs (PLAN W1-10,
// §3.16; G:68-183): Monsters, Items (combat items AND consumables — one tab
// since 2026-10-19, one "Add" that routes by kind), Buffs and the loot
// library.
//
// The lists live in the active profile (VtOptions getList/setList: "monsters",
// "items", "consumables", "buffs"); the CMB/SUP models (bot.vt.items /
// bot.vt.consumables) validate and classify, the composition (INT-2) reacts to
// the list changes (MonsterList.setEntries, the item-buff projection). Loot
// profiles go through bot.vt.library ONLY (critic C2: UI never parses files).
//
// C2: no import of another vt package. The few shapes the UI must know are
// re-implemented here from the §3.2 contracts and kept in step with
// rynth/vt/combat/monster_list.js (normalizeEntry / fromRynthAiRule /
// fromLegacyPriorities), rynth/vt/combat/items.js (ITEM_BUFF_DEFAULTS) and
// rynth/vt/support/consumables.js (CONSUMABLE_TYPES); the models re-normalise
// whatever the panel writes, so a drift here can never corrupt a list.

import { safe, ok, fail, command, asResult, clone, isFn, num } from "./bridge_options.js";

// ── §3.2 shapes (re-implemented, see header) ───────────────────────────────

export const MONSTER_COLUMNS = Object.freeze(["F", "B", "G", "I", "Y", "V", "A", "R", "S", "WC", "FC", "Cp", "DC", "Cs"]);
export const MONSTER_COLUMN_TITLES = Object.freeze({
  F: "Fester",
  B: "Broadside of a Barn",
  G: "Gravity Well",
  I: "Imperil",
  Y: "Yield",
  V: "Vuln (the entry's damage type)",
  A: "Primary attack (war / melee / missile); off = debuff only unless R",
  R: "Ring (WR: ring at Min Ring Targets in Ring Range; R alone: ring while an R monster is in Ring Range)",
  S: "Streak",
  WC: "Weakening Curse",
  FC: "Festering Curse",
  Cp: "Corruption",
  DC: "Destructive Curse",
  Cs: "Corrosion",
});
export const ELEMENTS = Object.freeze(["Slash", "Pierce", "Bludgeon", "Fire", "Cold", "Lightning", "Acid", "Nether"]);
export const PRIORITIES = Object.freeze([-1, 0, 1, 2, 3, 4]);
export const DEFAULT_TEXT = "DEFAULT";
export const DEFAULT_MONSTER = Object.freeze({
  text: DEFAULT_TEXT,
  enabled: true,
  priority: 1,
  F: false, B: false, G: false, I: false, Y: false, V: false,
  A: true, R: false, S: false,
  WC: false, FC: false, Cp: false, DC: false, Cs: false,
  damageType: "Auto",
  exVuln: "None",
  weapon: 0,
  offhand: 0,
  petDmg: "PAuto",
  arc: false,
});

export const ITEM_KINDS = Object.freeze(["caster", "melee", "missile", "shield", "pet"]);
export const ITEM_KIND_LABELS = Object.freeze({
  caster: "Wand/Staff/Orb",
  melee: "Melee weapon",
  missile: "Missile weapon",
  shield: "Shield",
  pet: "Pet",
});
export const ITEM_BUFF_FAMILIES = Object.freeze([
  "impen", "bane:slash", "bane:pierce", "bane:bludgeon", "bane:fire", "bane:cold", "bane:lightning", "bane:acid",
]);
export const ITEM_BUFF_LABELS = Object.freeze({
  impen: "Impenetrability",
  "bane:slash": "Blade Bane",
  "bane:pierce": "Piercing Bane",
  "bane:bludgeon": "Bludgeon Bane",
  "bane:fire": "Flame Bane",
  "bane:cold": "Frost Bane",
  "bane:lightning": "Lightning Bane",
  "bane:acid": "Acid Bane",
});
export const ITEM_BUFF_DEFAULTS = Object.freeze({
  shield: Object.freeze(ITEM_BUFF_FAMILIES.slice()),
  melee: Object.freeze([]),
  missile: Object.freeze([]),
  caster: Object.freeze([]),
  pet: Object.freeze([]),
});

export const CONSUMABLE_TYPES = Object.freeze([
  "HealthKit", "StaminaKit", "ManaKit", "HealthFood", "StaminaFood", "HealthPotion", "StaminaPotion", "ManaPotion",
  "BuffItem", "ManaStone", "ManaCharge", "Dispel", "Grenade", "PeaComponent", "Lockpick", "Pet", "General",
]);

const SCHOOL_NAMES = Object.freeze({ 1: "War", 2: "Life", 3: "Item", 4: "Creature", 5: "Void" });
const BUFF_FLOOR_S = 300; // G:181 "below 5 minutes"
const DID_SPELL = 28;
const ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"]);

// Buffs tab groups when buff_loop.js has no buffFamilyInfo(): derived from
// the four RynthAi family tables it exports (BuildDynamicBuffList steps).
const DEFENSE_CATS = new Set([37, 39, 41]); // Invulnerability, Impregnability, Magic Resistance
const REGEN_CATS = new Set([93, 95, 97]); // Regeneration, Rejuvenation, Mana Renewal
const familyLabel = (base) => String(base ?? "").replace(/^Aura of /, "").replace(/ Self$/, "").trim() || null;
export function fallbackFamilyInfo(lib, cat) {
  const find = (arr, at) => (Array.isArray(arr) ? arr.find((r) => Array.isArray(r) && r[at] === cat) : null);
  let r = find(lib && lib.BASE_CREATURE_BUFFS, 1);
  if (r) return DEFENSE_CATS.has(cat) ? { label: familyLabel(r[0]), group: "Defenses", groupOrder: 1 } : { label: familyLabel(r[0]), group: "Attributes", groupOrder: 0 };
  r = find(lib && lib.SKILL_BUFFS, 2);
  if (r) return { label: familyLabel(r[1]), group: "Masteries", groupOrder: 2 };
  r = find(lib && lib.LIFE_BUFFS, 1);
  if (r) return REGEN_CATS.has(cat) ? { label: familyLabel(r[0]), group: "Regeneration", groupOrder: 3 } : { label: familyLabel(r[0]), group: "Protections", groupOrder: 4 };
  r = find(lib && lib.AURA_BUFFS, 1);
  if (r) return { label: familyLabel(r[0]), group: "Weapon auras", groupOrder: 5 };
  return { label: null, group: "Other", groupOrder: 9 };
}

const ELEMENT_ALIASES = new Map([
  ["slash", "Slash"], ["slashing", "Slash"], ["blade", "Slash"],
  ["pierce", "Pierce"], ["piercing", "Pierce"],
  ["bludgeon", "Bludgeon"], ["bludgeoning", "Bludgeon"], ["blunt", "Bludgeon"],
  ["fire", "Fire"], ["flame", "Fire"],
  ["cold", "Cold"], ["frost", "Cold"],
  ["lightning", "Lightning"], ["electric", "Lightning"], ["electrical", "Lightning"],
  ["acid", "Acid"],
  ["nether", "Nether"], ["void", "Nether"],
]);
export function normalizeElement(s) {
  if (s == null) return null;
  return ELEMENT_ALIASES.get(String(s).trim().toLowerCase()) ?? null;
}

const bool = (v, d) =>
  v === undefined || v === null ? d : v === true || v === 1 || v === "1" || (typeof v === "string" && v.trim().toLowerCase() === "true");
const u32 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n >>> 0 : 0;
};
const isDefaultText = (t) => String(t ?? "").trim().toUpperCase() === DEFAULT_TEXT;
const lc = (s) => String(s ?? "").trim().toLowerCase();

function clampPriority(p, dflt) {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(-1, Math.min(4, n));
}

/** = combat/monster_list.js normalizeEntry (kept in step; the model re-normalises). */
export function normalizeMonster(e) {
  const src = e && typeof e === "object" ? e : {};
  const out = {
    text: typeof src.text === "string" ? src.text : src.text == null ? "" : String(src.text),
    enabled: bool(src.enabled, true),
    priority: clampPriority(src.priority, 1),
  };
  for (const c of MONSTER_COLUMNS) out[c] = bool(src[c], c === "A");
  out.damageType = src.damageType == null || lc(src.damageType) === "auto" ? "Auto" : normalizeElement(src.damageType) ?? "Auto";
  out.exVuln = src.exVuln == null || lc(src.exVuln) === "none" ? "None" : normalizeElement(src.exVuln) ?? "None";
  out.weapon = u32(src.weapon);
  out.offhand = u32(src.offhand);
  out.petDmg = src.petDmg == null || lc(src.petDmg) === "pauto" ? "PAuto" : normalizeElement(src.petDmg) ?? "PAuto";
  out.arc = bool(src.arc, false);
  if (isDefaultText(out.text)) {
    out.text = DEFAULT_TEXT;
    out.enabled = true; // DEFAULT cannot be disabled
  }
  return out;
}

function sameMonster(a, b) {
  for (const k of Object.keys(DEFAULT_MONSTER)) if (a[k] !== b[k]) return false;
  return true;
}

function prop(o, name) {
  if (!o || typeof o !== "object") return undefined;
  if (name in o) return o[name];
  const want = name.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === want) return o[k];
  return undefined;
}

/** = combat/monster_list.js fromRynthAiRule (U6 §1.5 import map). */
export function fromRynthAiRule(rule) {
  const r = rule && typeof rule === "object" ? rule : {};
  const name = String(prop(r, "Name") ?? "").trim();
  const expr = String(prop(r, "MatchExpression") ?? "").trim();
  let text;
  if (isDefaultText(name)) text = DEFAULT_TEXT;
  else if (expr && name) text = `(${expr}) && name==\`${name.replace(/`/g, "\\`")}\``;
  else text = expr || name;
  const useArc = bool(prop(r, "UseArc"), false);
  const useBolt = bool(prop(r, "UseBolt"), true);
  return normalizeMonster({
    text,
    enabled: true,
    priority: prop(r, "Priority") ?? 1,
    F: prop(r, "Fester"),
    B: prop(r, "Broadside"),
    G: prop(r, "GravityWell"),
    I: prop(r, "Imperil"),
    Y: prop(r, "Yield"),
    V: prop(r, "Vuln"),
    A: useArc || useBolt,
    R: prop(r, "UseRing"),
    S: prop(r, "UseStreak"),
    damageType: prop(r, "DamageType"),
    exVuln: prop(r, "ExVuln"),
    weapon: prop(r, "WeaponId"),
    offhand: prop(r, "OffhandId"),
    petDmg: prop(r, "PetDamage"),
    arc: useArc,
  });
}

/** = combat/monster_list.js fromLegacyPriorities ({name: p} → entries, P 0..4). */
export function fromLegacyPriorities(map) {
  const out = [];
  if (!map || typeof map !== "object") return out;
  for (const [name, p] of Object.entries(map)) {
    const text = String(name).trim();
    if (!text || isDefaultText(text)) continue;
    const n = Number(p);
    out.push(normalizeMonster({ text, priority: Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : 1 }));
  }
  return out;
}

/** RynthAi settings / rule JSON → MonsterRule[] (array, {MonsterRules}, {Monsters}, or one rule). */
export function rynthAiRules(text) {
  let j;
  try {
    j = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { ok: false, error: `not JSON: ${e && e.message ? e.message : e}` };
  }
  let rules = null;
  if (Array.isArray(j)) rules = j;
  else if (j && typeof j === "object") {
    rules = prop(j, "MonsterRules") ?? prop(j, "Monsters") ?? prop(j, "Rules") ?? null;
    if (!Array.isArray(rules) && (prop(j, "Name") !== undefined || prop(j, "MatchExpression") !== undefined)) rules = [j];
  }
  if (!Array.isArray(rules)) return { ok: false, error: "no MonsterRules array in that JSON" };
  return { ok: true, rules: rules.filter((r) => r && typeof r === "object") };
}

// ── monster list storage (profile list "monsters") ─────────────────────────

/** DEFAULT first (the first DEFAULT row keeps its columns; none ⇒ the stock one). */
export function readMonsters(options) {
  const raw = safe(() => options?.getList?.("monsters"), null);
  const list = Array.isArray(raw) ? raw.map(normalizeMonster) : [];
  let def = null;
  const rest = [];
  for (const e of list) {
    if (isDefaultText(e.text)) {
      if (!def) def = e;
      continue;
    }
    rest.push(e);
  }
  return [def || { ...DEFAULT_MONSTER }, ...rest];
}

function writeMonsters(options, entries) {
  if (!options || !isFn(options.setList)) return fail("no VTank settings yet");
  const list = entries.map(normalizeMonster);
  // [stock DEFAULT] only ⇒ the empty list (the model's own DEFAULT-only list).
  const value = list.length === 1 && sameMonster(list[0], DEFAULT_MONSTER) ? [] : list;
  return asResult(options.setList("monsters", value, { source: "ui" }));
}

// ── selection helpers ──────────────────────────────────────────────────────

/** The inventory selection (GetSelectedItemId), then the world selection; 0 = none. */
export function selectedItemGuid(host, win) {
  const g1 = u32(safe(() => (isFn(host?.GetSelectedItemId) ? host.GetSelectedItemId() : 0), 0));
  if (g1) return g1;
  return worldSelection(host, win);
}

/** The world (3D) selection; 0 = none. */
export function worldSelection(host, win) {
  const g = u32(safe(() => (isFn(host?.GetSelectedId) ? host.GetSelectedId() : 0), 0));
  if (g) return g;
  return u32(safe(() => win?.liveScene3d?.entityManager?.getSelectedTarget?.(), 0));
}

export function objectName(host, win, guid) {
  const g = u32(guid);
  if (!g) return "";
  const n = safe(() => host?.TryGetObjectName?.(g), null) ?? safe(() => win?.__sessionHandle?.objectName?.(g), null);
  return typeof n === "string" ? n : "";
}

// ── BuffItem pre-check (G:181) ─────────────────────────────────────────────

/** Spell ids an item casts: appraisal spellBook ∪ DID Spell (28). */
function itemSpellIds(host, guid, appraisal) {
  const out = new Set();
  if (appraisal && Array.isArray(appraisal.spellBook)) for (const s of appraisal.spellBook) if (Number(s) > 0) out.add(Number(s) >>> 0);
  const props = appraisal && typeof appraisal === "object" ? appraisal.properties || appraisal : null;
  const didSec = props && typeof props.dids === "object" ? props.dids : null;
  let did = didSec ? Number(didSec.Spell ?? didSec[String(DID_SPELL)]) : NaN;
  if (!(did > 0)) did = Number(safe(() => host?.TryGetObjectDataIdProperty?.(guid, DID_SPELL), 0));
  if (did > 0) out.add(did >>> 0);
  return [...out];
}

/**
 * Consumables "Add selected" for a BuffItem: appraise first when the item has
 * no appraisal (RequestId, then ask the player to press Add again), then
 * refuse a buff shorter than max(300 s, RebuffSecondsRemaining) — buff items
 * under the rebuff threshold would be reused at once (G:181). The SUP model
 * re-validates on add; this is the panel's early, explained refusal.
 * → { ok:true, spellIds, durationS } | { ok:false, error, pending? }
 */
export function buffItemPrecheck(host, options, guid, name) {
  const label = name || "that item";
  const appraisal = safe(() => host?.TryGetObjectAppraisal?.(guid), null);
  const has = safe(() => (isFn(host?.HasAppraisalData) ? host.HasAppraisalData(guid) === true : false), false);
  if (!appraisal && !has) {
    safe(() => host?.RequestId?.(guid));
    return { ok: false, pending: true, error: `appraising ${label} — press Add again in a moment` };
  }
  const spellIds = itemSpellIds(host, guid, appraisal);
  if (!spellIds.length) return { ok: false, error: `${label}: no buff spell found on it` };
  let durationS = null;
  for (const id of spellIds) {
    const d = Number(safe(() => host?.TryGetSpellRecord?.(id)?.duration, NaN));
    if (Number.isFinite(d) && d > 0) durationS = durationS == null ? d : Math.max(durationS, d);
  }
  const rebuff = Number(safe(() => options?.getValue?.("RebuffSecondsRemaining"), BUFF_FLOOR_S));
  const floor = Math.max(BUFF_FLOOR_S, Number.isFinite(rebuff) ? rebuff : BUFF_FLOOR_S);
  if (durationS != null && durationS < floor) {
    return {
      ok: false,
      error: `${label} lasts ${Math.round(durationS)} s; buff items under ${Math.round(floor)} s are not allowed (every buff is recast below the rebuff threshold)`,
    };
  }
  return { ok: true, spellIds, durationS };
}

// ── Buffs tab (G:183, D21, D38) ────────────────────────────────────────────

function buffsList(options) {
  const v = safe(() => options?.getList?.("buffs"), null);
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    ...clone(o),
    spec: o.spec === "auto" || Array.isArray(o.spec) ? clone(o.spec) : null,
    disabled: Array.isArray(o.disabled) ? o.disabled.map(Number).filter((x) => x > 0) : [],
    itemSpells: o.itemSpells && typeof o.itemSpells === "object" && !Array.isArray(o.itemSpells) ? clone(o.itemSpells) : {},
  };
}

/** = combat/items.js itemBuffFamilies. */
export function itemFamiliesOf(entry, list) {
  if (!entry || entry.noBuffs) return [];
  const g = String(Number(entry.guid) >>> 0);
  const over = list && list.itemSpells;
  if (over && Object.prototype.hasOwnProperty.call(over, g) && Array.isArray(over[g])) {
    return over[g].filter((f) => ITEM_BUFF_FAMILIES.includes(f));
  }
  const d = ITEM_BUFF_DEFAULTS[entry.kind];
  return d ? d.slice() : [];
}

function knownSpellIds(host, win) {
  const fromHost = safe(() => host?.TryGetKnownSpells?.(), null);
  if (Array.isArray(fromHost) && fromHost.length) return fromHost.map((x) => Number(x) >>> 0);
  const fromHandle = safe(() => Array.from(win?.__sessionHandle?.playerKnownSpells?.() || []), []);
  return (fromHandle || []).map((x) => Number(x) >>> 0);
}

function spellRecord(host, id) {
  return safe(() => host?.TryGetSpellRecord?.(id), null);
}

export function spellName(host, win, id) {
  const r = spellRecord(host, id);
  if (r && r.name) return String(r.name);
  const rec = safe(() => win?.__sessionHandle?.getSpellRecord?.(id), null);
  const n = rec ? safe(() => (isFn(rec.get) ? rec.get("name") : rec.name), null) : null;
  return typeof n === "string" && n ? n : `spell ${id}`;
}

// ── factory ────────────────────────────────────────────────────────────────

/**
 * ctx = { win, importer, buffLoopUrl, getBot, layerOf(bot), optionsOf(vt), hostOf(bot), hud() }
 * → { monsters, items, consumables, buffs, loot, views: { monsters(vt, bot), … } }
 */
export function createListsBridge(ctx) {
  const parseCache = new Map(); // text → { ok, error?, dynamic? }
  const PARSE_CACHE_MAX = 256;
  let buffLib = null; // { buildDynamicBuffList, loadSpellLadders, readSkillTraining }
  let ladder = null;
  let buffLibPromise = null;
  let buffLibError = null;
  // The dynamic list re-reads the spellbook and the skill table (wasm): the
  // view (2 Hz while the Buffs tab is open) reuses it for a few seconds.
  const DYN_CACHE_MS = 5000;
  let dynCache = { at: -Infinity, key: null, ids: [] };

  const cur = () => {
    const bot = ctx.getBot();
    const vt = ctx.layerOf(bot);
    return { bot, vt, options: ctx.optionsOf(vt), host: ctx.hostOf(bot) };
  };

  function parseCheck(vt, text) {
    const t = String(text ?? "");
    if (!t.trim()) return null;
    if (parseCache.has(t)) return parseCache.get(t);
    const parser = vt && isFn(vt.parseExpr) ? vt.parseExpr : null;
    if (!parser) return null; // INT-2 exposes layer.parseExpr; until then no syntax check
    const p = safe(() => parser(t, { mode: "monster" }), null);
    const res = p && typeof p === "object"
      ? { ok: p.ok === true, error: p.ok ? null : String(p.error ?? "does not parse"), pos: num(p.pos), dynamic: !!p.dynamic }
      : null;
    if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
    parseCache.set(t, res);
    return res;
  }

  function ensureBuffLib() {
    if (buffLib && ladder) return Promise.resolve(buffLib);
    if (!buffLibPromise) {
      buffLibPromise = Promise.resolve()
        .then(() => ctx.importer(ctx.buffLoopUrl))
        .then(async (m) => {
          if (!m || !isFn(m.buildDynamicBuffList)) throw new Error("buff_loop.js has no buildDynamicBuffList");
          const t = isFn(m.loadSpellLadders) ? await m.loadSpellLadders() : null;
          buffLib = m;
          ladder = t && typeof t === "object" ? t : {};
          buffLibError = null;
          return m;
        })
        .catch((e) => {
          buffLibError = e && e.message ? e.message : String(e);
          buffLibPromise = null; // retry on the next open
          return null;
        });
    }
    return buffLibPromise;
  }

  // ── view-models ──────────────────────────────────────────────────────────
  function monstersView(vt, bot) {
    const options = ctx.optionsOf(vt);
    const host = ctx.hostOf(bot);
    const entries = readMonsters(options).map((e, i) => ({
      index: i,
      ...e,
      isDefault: i === 0,
      parse: i === 0 ? null : parseCheck(vt, e.text),
    }));
    const items = vt ? safe(() => vt.items?.list?.(), []) || [] : [];
    const weapons = items.filter((x) => x.kind === "caster" || x.kind === "melee" || x.kind === "missile");
    const offhands = items.filter((x) => x.kind === "shield" || x.kind === "melee");
    const sel = worldSelection(host, ctx.win);
    const locked = u32(safe(() => bot?.combat?.locked, 0));
    const tGuid = sel || locked;
    // The row that governs that monster right now (MonsterList.resolve: the
    // first entry, after DEFAULT, that matches by name or expression, G:103).
    // Shown only when the live list and the stored list agree on that row.
    let targetIndex = null;
    // only for a monster: a selected NPC, door or player falls through to DEFAULT too
    const attackable = tGuid ? safe(() => (isFn(host?.ObjectIsAttackable) ? host.ObjectIsAttackable(tGuid) : null), null) : null;
    if (tGuid && vt && attackable !== false) {
      const hit = safe(() => vt.monsters?.resolve?.(tGuid), null);
      const i = hit ? Math.trunc(Number(hit.index)) : -1;
      if (i >= 0 && i < entries.length && (i === 0 || lc(hit.entry?.text) === lc(entries[i].text))) targetIndex = i;
    }
    return {
      entries,
      targetIndex,
      targetSource: tGuid ? (sel ? "selection" : "locked") : null,
      columns: MONSTER_COLUMNS.slice(),
      columnTitles: { ...MONSTER_COLUMN_TITLES },
      priorities: PRIORITIES.slice(),
      elements: ELEMENTS.slice(),
      weapons: weapons.map((x) => ({ guid: x.guid >>> 0, name: String(x.name ?? "") })),
      offhands: offhands.map((x) => ({ guid: x.guid >>> 0, name: String(x.name ?? "") })),
      selectedName: tGuid ? objectName(host, ctx.win, tGuid) || null : null,
      syntaxCheck: !!(vt && isFn(vt.parseExpr)),
      editable: !!options,
    };
  }

  function itemsView(vt) {
    const model = vt ? safe(() => vt.items ?? null) : null;
    const list = model ? safe(() => model.list(), []) || [] : [];
    return {
      available: !!model,
      entries: list.map((e) => ({
        guid: Number(e.guid) >>> 0,
        name: String(e.name ?? ""),
        wcid: Number(e.wcid) >>> 0,
        kind: e.kind,
        kindLabel: ITEM_KIND_LABELS[e.kind] ?? String(e.kind),
        element: e.element ?? null,
        noBuffs: e.noBuffs === true,
        owned: isFn(model.resolveGuid) ? !!safe(() => model.resolveGuid(e), 0) : true,
      })),
      kinds: ITEM_KINDS.slice(),
      elements: ELEMENTS.slice(),
    };
  }

  function consumablesModel(vt) {
    return vt ? safe(() => vt.consumables ?? vt.support?.consumables ?? null) : null;
  }

  function consumablesView(vt, bot) {
    const model = consumablesModel(vt);
    const host = ctx.hostOf(bot);
    const list = model ? safe(() => model.list(), []) || [] : [];
    return {
      available: !!model,
      entries: list.map((e) => ({
        guid: Number(e.guid) >>> 0,
        name: String(e.name ?? ""),
        wcid: Number(e.wcid) >>> 0,
        type: e.type,
        keepAtLeast: num(e.keepAtLeast),
        toolGuid: e.toolGuid ? Number(e.toolGuid) >>> 0 : 0,
        toolName: e.toolGuid ? objectName(host, ctx.win, e.toolGuid) || `0x${(Number(e.toolGuid) >>> 0).toString(16)}` : "",
        spellIds: Array.isArray(e.spellIds) ? e.spellIds.slice() : [],
        durationS: num(e.durationS),
      })),
      types: CONSUMABLE_TYPES.slice(),
      buffFloorS: Math.max(BUFF_FLOOR_S, Number(safe(() => ctx.optionsOf(vt)?.getValue?.("RebuffSecondsRemaining"), BUFF_FLOOR_S)) || BUFF_FLOOR_S),
    };
  }

  /** The inventory row of `guid` (TryGetPlayerInventory shape), or null. */
  function inventoryRow(host, guid) {
    const g = u32(guid);
    if (!g) return null;
    const inv = safe(() => (isFn(host?.TryGetPlayerInventoryCached) ? host.TryGetPlayerInventoryCached() : host?.TryGetPlayerInventory?.()), null);
    return Array.isArray(inv) ? inv.find((i) => u32(i && i.guid) === g) || null : null;
  }

  /**
   * Items tab (G:152-181, one tab since 2026-10-19): the combat items (Items
   * model) and the consumables (SUP model) as two groups, plus the add bar's
   * preview of the selected inventory item and what "Auto" would add it as.
   */
  function itemsTabView(vt, bot) {
    const combat = itemsView(vt);
    const cons = consumablesView(vt, bot);
    const host = ctx.hostOf(bot);
    const g = vt ? selectedItemGuid(host, ctx.win) : 0;
    let selection = null;
    if (g) {
      const row = inventoryRow(host, g);
      const kind = row && vt ? safe(() => vt.items?.classify?.(row), null) : null;
      selection = {
        guid: g,
        name: objectName(host, ctx.win, g) || (row && row.name ? String(row.name) : null),
        owned: !!row,
        kind: ITEM_KINDS.includes(kind) ? kind : null,
      };
    }
    return {
      available: combat.available || cons.available,
      combatAvailable: combat.available,
      consumablesAvailable: cons.available,
      combat: combat.entries,
      consumables: cons.entries,
      kinds: combat.kinds,
      kindLabels: { ...ITEM_KIND_LABELS },
      types: cons.types,
      elements: combat.elements,
      buffFloorS: cons.buffFloorS,
      selection,
    };
  }

  function computeDynamic(host) {
    const known = knownSpellIds(host, ctx.win);
    const skills = isFn(buffLib.readSkillTraining) ? safe(() => buffLib.readSkillTraining(ctx.win?.__sessionHandle), null) : null;
    const ids = safe(() => buffLib.buildDynamicBuffList({ knownIds: known, skills, ladder }), []) || [];
    dynCache = { at: ctx.now(), key: known.join(","), ids: ids.slice() };
    return ids;
  }

  function cachedDynamic(host) {
    const fresh = ctx.now() - dynCache.at < DYN_CACHE_MS;
    if (fresh && dynCache.key !== null) {
      const known = knownSpellIds(host, ctx.win);
      if (known.join(",") === dynCache.key) return dynCache.ids.slice();
    }
    return computeDynamic(host);
  }

  function familyInfo(cat) {
    const f = buffLib && isFn(buffLib.buffFamilyInfo) ? safe(() => buffLib.buffFamilyInfo(cat), null) : null;
    if (f && f.label) return { label: String(f.label), group: String(f.group || "Other"), groupOrder: num(Number(f.groupOrder)) ?? 9 };
    return fallbackFamilyInfo(buffLib, cat);
  }

  function buffRows(bot, options) {
    const host = ctx.hostOf(bot);
    const list = buffsList(options);
    const ids = cachedDynamic(host);
    const ench = safe(() => host?.TryGetSelfEnchantments?.(), null);
    const rowsEnch = Array.isArray(ench) ? ench : [];
    const disabled = new Set(list.disabled);
    const spec = list.spec;
    const specSet = Array.isArray(spec) ? new Set(spec.map((x) => Number(x) >>> 0)) : null;
    const specCats = new Set();
    if (specSet) for (const s of specSet) if (ladder[String(s)]) specCats.add(ladder[String(s)][0]);
    const rebuffAt = num(Number(safe(() => options?.getValue?.("RebuffSecondsRemaining"), BUFF_FLOOR_S))) ?? BUFF_FLOOR_S;
    return ids.map((id, order) => {
      const lrow = ladder[String(id)] || [];
      const cat = lrow[0];
      const rec = spellRecord(host, id);
      let remainingS = null;
      let permanent = false;
      for (const r of rowsEnch) {
        if (!r || r.isCooldown) continue;
        if ((Number(r.spellId) >>> 0) === id || (cat != null && r.family === cat)) {
          if (r.permanent) permanent = true;
          const rem = Number(r.remainingS);
          if (Number.isFinite(rem)) remainingS = remainingS == null ? rem : Math.max(remainingS, rem);
        }
      }
      const enabled = specSet ? specSet.has(id) || (cat != null && specCats.has(cat)) : !disabled.has(id);
      const tier = num(lrow[1]);
      const fam = familyInfo(cat);
      const name = rec && rec.name ? String(rec.name) : spellName(host, ctx.win, id);
      // off: not maintained · missing: maintained but not on you · low: under
      // the rebuff threshold (recast now) · soon: under twice that · ok.
      let state = "ok";
      if (!enabled) state = "off";
      else if (!permanent && remainingS == null) state = "missing";
      else if (!permanent && remainingS < rebuffAt) state = "low";
      else if (!permanent && remainingS < rebuffAt * 2) state = "soon";
      return {
        spellId: id,
        order,
        family: cat ?? null,
        familyLabel: fam.label || name,
        group: fam.group,
        groupOrder: fam.groupOrder,
        name,
        tier,
        tierText: tier != null && ROMAN[tier] ? ROMAN[tier] : "",
        school: rec ? num(rec.school) : null,
        schoolName: rec && SCHOOL_NAMES[rec.school] ? SCHOOL_NAMES[rec.school] : "",
        remainingS: permanent ? null : remainingS,
        permanent,
        enabled,
        state,
      };
    });
  }

  /** Buff rows → [{ group, rows }] in group order (rows keep the bot's own order). */
  function groupBuffRows(rows) {
    const at = new Map();
    for (const r of rows) {
      if (!at.has(r.group)) at.set(r.group, { group: r.group, groupOrder: r.groupOrder, rows: [] });
      at.get(r.group).rows.push(r);
    }
    return [...at.values()].sort((a, b) => a.groupOrder - b.groupOrder || a.rows[0].order - b.rows[0].order);
  }

  function buffsView(vt, bot) {
    const options = ctx.optionsOf(vt);
    const list = buffsList(options);
    const items = vt ? safe(() => vt.items?.list?.(), []) || [] : [];
    const itemRows = items.map((e) => {
      const g = String(Number(e.guid) >>> 0);
      const fams = new Set(itemFamiliesOf(e, list));
      const dflt = new Set(ITEM_BUFF_DEFAULTS[e.kind] || []);
      return {
        guid: Number(e.guid) >>> 0,
        name: String(e.name ?? ""),
        kind: e.kind,
        noBuffs: e.noBuffs === true,
        overridden: Object.prototype.hasOwnProperty.call(list.itemSpells, g),
        families: ITEM_BUFF_FAMILIES.map((f) => ({ family: f, label: ITEM_BUFF_LABELS[f], on: !e.noBuffs && fams.has(f), dflt: dflt.has(f) })),
      };
    });
    if (!buffLib || !ladder) ensureBuffLib();
    const ready = !!(buffLib && ladder);
    const rows = ready ? buffRows(bot, options) : [];
    const count = (s) => rows.filter((r) => r.state === s).length;
    return {
      loading: !ready && !buffLibError,
      error: ready ? null : buffLibError,
      auto: list.spec === "auto" || (list.spec == null && list.disabled.length === 0),
      spec: list.spec,
      present: !!bot,
      buffs: rows,
      groups: groupBuffRows(rows),
      summary: {
        total: rows.length,
        enabled: rows.filter((r) => r.enabled).length,
        active: rows.filter((r) => r.enabled && (r.permanent || r.remainingS != null)).length,
        low: count("low"),
        soon: count("soon"),
        missing: count("missing"),
      },
      items: itemRows,
      families: ITEM_BUFF_FAMILIES.slice(),
      familyLabels: { ...ITEM_BUFF_LABELS },
    };
  }

  function lootView(vt) {
    const options = ctx.optionsOf(vt);
    const lib = vt ? safe(() => vt.library ?? null) : null;
    const profiles = lib && isFn(lib.listLoot) ? safe(() => lib.listLoot(), []) || [] : [];
    const nodeTypes = lib && isFn(lib.lootNodeTypes) ? safe(() => lib.lootNodeTypes(), []) || [] : [];
    return {
      available: !!(lib && isFn(lib.listLoot)),
      profiles: profiles.map((p) => ({ name: String(p.name ?? ""), savedAt: num(p.savedAt), bytes: num(p.bytes) })),
      current: safe(() => options?.getRef?.("lootProfile"), null),
      nodeTypes: Array.from(nodeTypes || []).map((t) => ({
        id: Number(t.id),
        name: String(t.name ?? t.id),
        arity: Number(t.arity) || 0,
        // FMT UTL_NODE_TYPES also carry a label and the data-line names (editor hints)
        label: String(t.label ?? t.name ?? t.id),
        fields: Array.isArray(t.fields) ? t.fields.map(String) : [],
      })),
      actions: ["Keep", "Salvage", "Sell", "Read", "KeepUpTo"],
    };
  }

  // ── commands ─────────────────────────────────────────────────────────────
  const needOptions = () => {
    const c = cur();
    if (!c.options) throw new Error("no VTank settings yet — log in first");
    return c;
  };
  const needVt = (what) => {
    const c = cur();
    if (!c.vt) throw new Error(`start the bot to edit ${what}`);
    return c;
  };

  const monsters = {
    list: command(() => ok({ entries: readMonsters(needOptions().options) })),
    check: command((text) => {
      const c = cur();
      const r = parseCheck(c.vt, text);
      if (r) return ok({ parse: r });
      if (!String(text ?? "").trim()) return ok({ parse: null });
      return ok({ parse: null, unavailable: true, reason: c.vt ? "this VT layer has no expression parser" : "start the bot" });
    }),
    add: command((entry) => {
      const { options } = needOptions();
      const src = typeof entry === "string" ? { text: entry } : entry && typeof entry === "object" ? entry : {};
      const text = String(src.text ?? "").trim();
      if (!text) return fail("type a monster name or expression first");
      if (isDefaultText(text)) return fail("DEFAULT is always the first row");
      const list = readMonsters(options);
      // a second copy could never match: the first entry that matches wins (G:103)
      if (list.some((e, i) => i > 0 && lc(e.text) === lc(text))) return fail(`"${text}" is already on the list`);
      list.push(normalizeMonster({ ...src, text }));
      const r = writeMonsters(options, list);
      return r.ok ? ok({ index: list.length - 1 }) : r;
    }),
    update: command((index, patch) => {
      const { options } = needOptions();
      const list = readMonsters(options);
      const i = Math.trunc(Number(index));
      if (!Number.isInteger(i) || i < 0 || i >= list.length) return fail(`no monster row ${index}`);
      const p = patch && typeof patch === "object" ? { ...patch } : {};
      if (i === 0) {
        delete p.text; // DEFAULT keeps its name and is always enabled
        delete p.enabled;
      } else if ("text" in p) {
        const t = String(p.text ?? "").trim();
        if (!t) return fail("a monster row needs a name or an expression");
        if (isDefaultText(t)) return fail("only the first row is DEFAULT");
        p.text = t;
      }
      list[i] = normalizeMonster({ ...list[i], ...p });
      return writeMonsters(options, list);
    }),
    remove: command((index) => {
      const { options } = needOptions();
      const list = readMonsters(options);
      const i = Math.trunc(Number(index));
      if (i === 0) return fail("DEFAULT cannot be deleted");
      if (!Number.isInteger(i) || i < 0 || i >= list.length) return fail(`no monster row ${index}`);
      list.splice(i, 1);
      return writeMonsters(options, list);
    }),
    move: command((index, delta) => {
      const { options } = needOptions();
      const list = readMonsters(options);
      const i = Math.trunc(Number(index));
      if (i === 0) return fail("DEFAULT stays on top");
      if (!Number.isInteger(i) || i < 1 || i >= list.length) return fail(`no monster row ${index}`);
      const j = Math.max(1, Math.min(list.length - 1, i + Math.trunc(Number(delta) || 0)));
      if (j === i) return ok({ index: i });
      const [e] = list.splice(i, 1);
      list.splice(j, 0, e);
      const r = writeMonsters(options, list);
      return r.ok ? ok({ index: j }) : r;
    }),
    addSelectedTarget: command(() => {
      const { options, host, bot } = needOptions();
      const g = worldSelection(host, ctx.win) || u32(safe(() => bot?.combat?.locked, 0));
      const name = g ? objectName(host, ctx.win, g) : "";
      if (!name) return fail("select a monster first");
      const list = readMonsters(options);
      if (list.some((e, i) => i > 0 && lc(e.text) === lc(name))) return fail(`"${name}" is already on the list`);
      list.push(normalizeMonster({ text: name }));
      const r = writeMonsters(options, list);
      return r.ok ? ok({ index: list.length - 1, name }) : r;
    }),
    importHudPriorities: command(() => {
      const { options } = needOptions();
      let map = safe(() => options.getList("legacyPriorities"), null);
      if (!map || typeof map !== "object" || !Object.keys(map).length) map = safe(() => ctx.hud()?.getSettings?.().priorities, null);
      const add = fromLegacyPriorities(map);
      if (!add.length) return fail("no HUD monster priorities to import");
      const list = readMonsters(options);
      const have = new Set(list.map((e) => lc(e.text)));
      let added = 0;
      for (const e of add) {
        if (have.has(lc(e.text))) continue;
        have.add(lc(e.text));
        list.push(e);
        added++;
      }
      if (!added) return ok({ added: 0 });
      const r = writeMonsters(options, list);
      return r.ok ? ok({ added }) : r;
    }),
    importRynthAiJson: command((text) => {
      const { options } = needOptions();
      const p = rynthAiRules(text);
      if (!p.ok) return fail(p.error);
      const list = readMonsters(options);
      const have = new Set(list.map((e) => lc(e.text)));
      let added = 0;
      let defaultSet = false;
      for (const rule of p.rules) {
        const e = fromRynthAiRule(rule);
        if (!e.text) continue;
        if (e.text === DEFAULT_TEXT) {
          list[0] = e;
          defaultSet = true;
          continue;
        }
        if (have.has(lc(e.text))) continue;
        have.add(lc(e.text));
        list.push(e);
        added++;
      }
      if (!added && !defaultSet) return fail("no new monster rules in that JSON");
      const r = writeMonsters(options, list);
      return r.ok ? ok({ added, defaultSet }) : r;
    }),
  };

  const itemsModel = (vt) => {
    const m = vt ? safe(() => vt.items ?? null) : null;
    if (!m) throw new Error("start the bot to edit the Items list");
    return m;
  };

  const items = {
    list: command(() => ok({ entries: itemsView(needVt("the Items list").vt).entries })),
    addSelected: command(({ noBuffs = false } = {}) => {
      const { vt, host } = needVt("the Items list");
      const model = itemsModel(vt);
      const g = selectedItemGuid(host, ctx.win);
      if (!g) return fail("select an item in your inventory first");
      return asResult(model.add({ guid: g, noBuffs: !!noBuffs }));
    }),
    addByName: command((name, { noBuffs = false } = {}) => {
      const { vt } = needVt("the Items list");
      const n = String(name ?? "").trim();
      if (!n) return fail("type the item's name");
      return asResult(itemsModel(vt).add({ name: n, noBuffs: !!noBuffs }));
    }),
    update: command((guid, patch) => {
      const { vt } = needVt("the Items list");
      return asResult(itemsModel(vt).update(Number(guid) >>> 0, patch && typeof patch === "object" ? patch : {}));
    }),
    remove: command((guid) => {
      const { vt, options } = needVt("the Items list");
      const g = Number(guid) >>> 0;
      const r = asResult(itemsModel(vt).remove(g));
      if (r.ok && options) {
        // Drop the item's Buffs-tab override with it.
        const list = buffsList(options);
        if (Object.prototype.hasOwnProperty.call(list.itemSpells, String(g))) {
          delete list.itemSpells[String(g)];
          safe(() => options.setList("buffs", list, { source: "ui" }));
        }
      }
      return r;
    }),
  };

  const consModel = (vt) => {
    const m = consumablesModel(vt);
    if (!m) throw new Error("start the bot to edit the Consumables list");
    return m;
  };

  /**
   * Additive (Items tab add bar): add the selected — or the named — inventory
   * item as `as`: a combat kind (→ the Items list, honouring No Buffs), a
   * consumable type (→ the Consumables list, BuffItem pre-checked), or "auto"
   * (a combat item when the Items model classifies it as one, else a
   * consumable of the type the SUP model detects).
   */
  items.addAs = command(({ as = "auto", noBuffs = false, name = null } = {}) => {
    const { vt, host } = needVt("the Items list");
    const want = String(as || "auto");
    if (name != null && !String(name).trim()) return fail("type the item's name");
    const n = name == null ? "" : String(name).trim();
    if (want !== "auto" && !ITEM_KINDS.includes(want) && !CONSUMABLE_TYPES.includes(want)) return fail(`unknown item kind ${want}`);
    let kind = null;
    if (want === "auto" || ITEM_KINDS.includes(want)) {
      let row = null;
      if (n) {
        const inv = safe(() => (isFn(host?.TryGetPlayerInventoryCached) ? host.TryGetPlayerInventoryCached() : host?.TryGetPlayerInventory?.()), null);
        row = Array.isArray(inv) ? inv.find((i) => lc(i && i.name) === lc(n)) || null : null;
      } else row = inventoryRow(host, selectedItemGuid(host, ctx.win));
      const k = row ? safe(() => vt.items?.classify?.(row), null) : null;
      if (want === "auto") kind = ITEM_KINDS.includes(k) ? k : null;
      else {
        // an explicit kind overrides the classifier's kind, never its verdict:
        // a healing kit "added as Shield" would get Impenetrability + the banes
        if (!row) return fail(n ? `no item named "${n}" in your inventory` : "select an item in your inventory first");
        if (!ITEM_KINDS.includes(k)) {
          return fail(`${row.name || "that item"} is not a weapon, shield, wand/staff/orb or pet essence`);
        }
        kind = want;
      }
    }
    if (kind) {
      const model = itemsModel(vt);
      if (n) return asResult(model.add({ name: n, kind, noBuffs: !!noBuffs }));
      const g = selectedItemGuid(host, ctx.win);
      if (!g) return fail("select an item in your inventory first");
      return asResult(model.add({ guid: g, kind, noBuffs: !!noBuffs }));
    }
    const type = want === "auto" ? null : want;
    return n ? consumables.addByName(n, type) : consumables.addSelected(type);
  });

  const consumables = {
    list: command(() => ok({ entries: consumablesView(needVt("the Consumables list").vt, null).entries })),
    addSelected: command((type) => {
      const { vt, host, options } = needVt("the Consumables list");
      const model = consModel(vt);
      const t = type == null || type === "" || type === "auto" ? null : String(type);
      if (t && !CONSUMABLE_TYPES.includes(t)) return fail(`unknown consumable type ${t}`);
      const g = selectedItemGuid(host, ctx.win);
      if (!g) return fail("select an item in your inventory first");
      const entry = { guid: g };
      if (t) entry.type = t;
      if (t === "BuffItem") {
        const pre = buffItemPrecheck(host, options, g, objectName(host, ctx.win, g));
        if (!pre.ok) return pre;
        entry.spellIds = pre.spellIds;
        if (pre.durationS != null) entry.durationS = pre.durationS;
      }
      return asResult(model.add(entry));
    }),
    addByName: command((name, type) => {
      const { vt } = needVt("the Consumables list");
      const n = String(name ?? "").trim();
      if (!n) return fail("type the item's name");
      const t = type == null || type === "" || type === "auto" ? null : String(type);
      if (t && !CONSUMABLE_TYPES.includes(t)) return fail(`unknown consumable type ${t}`);
      return asResult(consModel(vt).add(t ? { name: n, type: t } : { name: n }));
    }),
    update: command((guid, patch) => {
      const { vt } = needVt("the Consumables list");
      return asResult(consModel(vt).update(Number(guid) >>> 0, patch && typeof patch === "object" ? patch : {}));
    }),
    remove: command((guid) => {
      const { vt } = needVt("the Consumables list");
      return asResult(consModel(vt).remove(Number(guid) >>> 0));
    }),
    /** Additive: the selected inventory item becomes a PeaComponent row's tool. */
    setToolFromSelection: command((guid) => {
      const { vt, host } = needVt("the Consumables list");
      const tool = selectedItemGuid(host, ctx.win);
      if (!tool) return fail("select the tool (e.g. a pea-splitting tool) in your inventory first");
      return asResult(consModel(vt).update(Number(guid) >>> 0, { toolGuid: tool }));
    }),
  };

  async function dynamicIds(bot) {
    await ensureBuffLib();
    if (!buffLib || !ladder) throw new Error(buffLibError || "the buff list is not loaded yet");
    const ids = computeDynamic(ctx.hostOf(bot)); // commands always use a fresh list
    // An empty projection would store spec [] = "buff nothing" (not logged
    // in yet, or the spellbook is unreadable): refuse instead.
    if (!ids.length) throw new Error("no known self buffs to choose from yet — log in first");
    return ids;
  }
  const sameFamily = (a, b) => {
    const ra = ladder && ladder[String(a)];
    const rb = ladder && ladder[String(b)];
    return a === b || (ra && rb && ra[0] === rb[0]);
  };

  function writeBuffs(options, list) {
    if (!options || !isFn(options.setList)) return fail("no VTank settings yet");
    // A VT spec names families, never a deliberate pick: keep it on the
    // scroll ladder (buff_loop.js toLadderSpec — an off-ladder id such as
    // Zongo's Fist becomes its family's tier-I ladder spell, which the loop
    // upgrades as usual; an id carried over from an older list would
    // otherwise be cast exactly as named).
    let out = list;
    if (Array.isArray(list.spec) && buffLib && isFn(buffLib.toLadderSpec)) {
      const spec = safe(() => buffLib.toLadderSpec(list.spec, ladder), null);
      if (Array.isArray(spec)) out = { ...list, spec: [...new Set(spec.map((x) => Number(x) >>> 0))] };
    }
    return asResult(options.setList("buffs", out, { source: "ui" }));
  }

  /** One spell's Enabled box applied to a buffs list (pure): → the new list. */
  function applyEnabled(list, dyn, id, on) {
    const disabled = new Set(list.disabled.filter((x) => !sameFamily(x, id)));
    if (!on) disabled.add(id);
    let spec;
    if (Array.isArray(list.spec)) {
      const keep = list.spec.map((x) => Number(x) >>> 0).filter((x) => !sameFamily(x, id));
      if (on) keep.push(id);
      spec = dyn.filter((x) => keep.some((k) => sameFamily(k, x)));
      for (const k of keep) if (!spec.some((s) => sameFamily(s, k))) spec.push(k); // ids outside today's dynamic list stay
    } else if (disabled.size === 0) {
      spec = "auto";
    } else {
      spec = dyn.filter((x) => ![...disabled].some((d) => sameFamily(d, x)));
    }
    return { ...list, spec, disabled: [...disabled] };
  }

  const buffs = {
    list: command(async () => {
      const { vt, bot } = cur();
      await ensureBuffLib();
      return ok(buffsView(vt, bot));
    }),
    setEnabled: command(async (spellId, on) => {
      const { options, bot } = needOptions();
      const id = Number(spellId) >>> 0;
      if (!id) return fail("no spell");
      const dyn = await dynamicIds(bot);
      return writeBuffs(options, applyEnabled(buffsList(options), dyn, id, on));
    }),
    /** Additive (the Buffs tab's per-group box): several spells' Enabled boxes in ONE write. */
    setEnabledMany: command(async (spellIds, on) => {
      const { options, bot } = needOptions();
      const ids = (Array.isArray(spellIds) ? spellIds : []).map((x) => Number(x) >>> 0).filter(Boolean);
      if (!ids.length) return fail("no spells");
      const dyn = await dynamicIds(bot);
      let list = buffsList(options);
      for (const id of ids) list = applyEnabled(list, dyn, id, on);
      return writeBuffs(options, list);
    }),
    setAuto: command(async (on) => {
      const { options, bot } = needOptions();
      const list = buffsList(options);
      if (on) return writeBuffs(options, { ...list, spec: "auto", disabled: [] });
      const dyn = await dynamicIds(bot);
      return writeBuffs(options, { ...list, spec: dyn.slice(), disabled: [] });
    }),
    setItemSpell: command((itemGuid, family, on) => {
      const { options, vt } = needOptions();
      const g = String(Number(itemGuid) >>> 0);
      if (!ITEM_BUFF_FAMILIES.includes(family)) return fail(`unknown item buff ${family}`);
      const entry = vt ? safe(() => vt.items?.find?.(Number(g)) ?? vt.items?.list?.().find((e) => String(Number(e.guid) >>> 0) === g), null) : null;
      if (entry && entry.noBuffs) return fail(`${entry.name || "that item"} was added with No Buffs`);
      const list = buffsList(options);
      const base = Object.prototype.hasOwnProperty.call(list.itemSpells, g)
        ? list.itemSpells[g].filter((f) => ITEM_BUFF_FAMILIES.includes(f))
        : (entry && ITEM_BUFF_DEFAULTS[entry.kind]) ? ITEM_BUFF_DEFAULTS[entry.kind].slice() : [];
      const set = new Set(base);
      if (on) set.add(family);
      else set.delete(family);
      list.itemSpells[g] = ITEM_BUFF_FAMILIES.filter((f) => set.has(f));
      return writeBuffs(options, list);
    }),
    resetItemSpells: command((itemGuid) => {
      const { options } = needOptions();
      const g = String(Number(itemGuid) >>> 0);
      const list = buffsList(options);
      if (!Object.prototype.hasOwnProperty.call(list.itemSpells, g)) return ok({ unchanged: true });
      delete list.itemSpells[g];
      return writeBuffs(options, list);
    }),
  };

  const lib = () => {
    const { vt } = cur();
    const l = vt ? safe(() => vt.library ?? null) : null;
    if (!l) throw new Error("the loot library needs the bot (start it first)");
    return l;
  };
  const call = (name, ...args) => {
    const l = lib();
    if (!isFn(l[name])) return fail(`the library has no ${name}`);
    return asResult(l[name](...args));
  };

  const loot = {
    list: command(() => ok({ profiles: lootView(cur().vt).profiles })),
    load: command((name) => call("loadLoot", String(name ?? "").trim())),
    clear: command(() => call("clearLoot")),
    importText: command((name, text) => call("importLoot", String(name ?? "").trim(), String(text ?? ""))),
    exportText: command((name) => call("exportLoot", String(name ?? "").trim())),
    get: command((name) => {
      const l = lib();
      if (!isFn(l.getLoot)) return fail("the library has no getLoot");
      const p = l.getLoot(String(name ?? "").trim());
      return p ? ok({ profile: clone(p) }) : fail(`no loot profile named "${name}"`);
    }),
    put: command((name, profile) => {
      const r = call("putLoot", String(name ?? "").trim(), clone(profile));
      // library validation (validateUtl) reports { ok:false, errors[] } without an `error`
      if (!r.ok && Array.isArray(r.errors) && r.errors.length && r.error === "refused") r.error = "the loot profile is not valid";
      return r;
    }),
    remove: command((name) => call("removeLoot", String(name ?? "").trim())),
    newProfile: command(() => {
      const l = lib();
      if (!isFn(l.newLoot)) return fail("the library has no newLoot");
      return ok({ profile: clone(l.newLoot()) });
    }),
  };

  return {
    monsters,
    items,
    consumables,
    buffs,
    loot,
    views: {
      monsters: monstersView,
      items: itemsTabView,
      combatItems: itemsView,
      consumables: consumablesView,
      buffs: buffsView,
      loot: lootView,
    },
  };
}
