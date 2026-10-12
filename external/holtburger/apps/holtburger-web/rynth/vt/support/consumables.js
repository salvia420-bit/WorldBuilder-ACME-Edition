// rynth/vt/support/consumables.js — the VTank Consumables tab model (PLAN
// W1-9 SUP, §3.11, §2.6 C1-C7, G:168-181) plus the small helpers every
// support module shares (one copy, package-internal; C2 keeps them inside
// rynth/vt/support/).
//
// Consumables are items the macro USES during play: buff items (beers and
// food that cast a buff), healing/stamina/mana kits, healing and stamina
// foods, potions, mana charges and stones, dispel items, alchemical grenades,
// spell components for which peas should be split, lockpicks, pet essences
// and "General" entries. Entries live in the profile list "consumables"
// (VtOptions getList/setList) — this module stores nothing itself, exactly
// like the CMB ItemsModel. Identity on another character: resolve by guid,
// then by (name, wcid) in the current inventory (§3.2).
//
// classifyConsumable fixes the C# "Mana" hazard (U7a H12, LegacyWeaponsUi.cs
// :304-306): a "Mana Potion"/"Mana Elixir" is a potion, never a stone.
//
// Data JSON (pet essences, dispel items, harmful families) is loaded lazily
// and cached per module (C11, the buff_loop.js loader pattern): node reads
// file: URLs with node:fs/promises, the browser fetches. Until a table is
// loaded, supportData(name) answers null and the consumer treats the feature
// as not ready (no use, no cast) — createVtLayer never awaits it (§3.15 B5).
//
// Nothing here throws to a caller (C9); nothing here calls the network except
// the lazy data fetch.

// ── shared constants ──────────────────────────────────────────────────────

export const CONSUMABLE_TYPES = Object.freeze([
  "HealthKit",
  "StaminaKit",
  "ManaKit",
  "HealthFood",
  "StaminaFood",
  "HealthPotion",
  "StaminaPotion",
  "ManaPotion",
  "BuffItem",
  "ManaStone",
  "ManaCharge",
  "Dispel",
  "Grenade",
  "PeaComponent",
  "Lockpick",
  "Pet",
  "General",
]);
const TYPE_SET = new Set(CONSUMABLE_TYPES);

/** Item-token owners (§3.11) — one per support module. */
export const OWNERS = Object.freeze({
  supplies: "vtsupplies",
  mana: "vtmana",
  inventory: "vtinv",
  pets: "vtpets",
  doors: "vtdoors",
  buffItems: "vtbuffitems",
});

// ACE ItemType (ACE.Entity/Enum/ItemType.cs).
export const IT = Object.freeze({
  MELEE: 0x1,
  ARMOR: 0x2,
  CLOTHING: 0x4,
  JEWELRY: 0x8,
  CREATURE: 0x10,
  FOOD: 0x20,
  MISC: 0x80,
  MISSILE: 0x100,
  CONTAINER: 0x200,
  GEM: 0x800,
  SPELL_COMPONENTS: 0x1000,
  WRITABLE: 0x2000,
  CASTER: 0x8000,
  MANA_STONE: 0x80000,
});
// ACE PropertyInt / PropertyDataId / PropertyBool / PropertyInstanceId ids.
export const PROP = Object.freeze({
  BOOSTER_ENUM: 89, // PropertyAttribute2nd: 2 Health, 4 Stamina, 6 Mana
  BOOST_VALUE: 90,
  STRUCTURE: 92, // pet-device charges
  SHARED_COOLDOWN: 280,
  DID_SPELL: 28,
  BOOL_RETAINED: 91,
  IID_PET_OWNER: 44,
});
// holtburger VitalType (playerStats vitals stride ids, rynth/vitals.js).
export const VITAL = Object.freeze({ HEALTH: 1, STAMINA: 3, MANA: 5 });
// ACE Skill ids.
export const SKILL = Object.freeze({ HEALING: 21, SUMMONING: 54 });

// The default dispel-item name rule when dispel_items.json is not loaded yet
// (same text as the JSON; classification only — the dispel step itself waits
// for the data).
const DEFAULT_DISPEL_NAME_RE = /gem of stillness|dispel|black potion/i;
const DEFAULT_DISPEL_WCIDS = new Set([9193, 38726, 38727, 51216]);

// ── logging (C3) ──────────────────────────────────────────────────────────

/**
 * `[vt:<tag>]`-prefixed logger; identical messages are rate-limited to one
 * per 10 s. `log` is the injected sink (default console.log).
 */
export function makeLogger(log, tag, now = Date.now) {
  const sink = typeof log === "function" ? log : (m) => console.log(m);
  const seen = new Map();
  return (msg) => {
    try {
      const text = `[vt:${tag}] ${msg}`;
      const t = Number(now()) || 0;
      const last = seen.get(text);
      if (last != null && t - last < 10_000) return;
      if (seen.size > 256) seen.clear();
      seen.set(text, t);
      sink(text);
    } catch (_) {
      /* logging never breaks a caller */
    }
  };
}

export function errText(e) {
  return String((e && e.message) || e);
}

// ── option reads ──────────────────────────────────────────────────────────

/** VtOptions.getValue(key) with a fallback for an unbound/absent options object. */
export function opt(options, key, dflt) {
  try {
    if (options && typeof options.getValue === "function") {
      const v = options.getValue(key);
      if (v !== undefined && v !== null) return v;
    }
  } catch (_) {
    /* fall through */
  }
  return dflt;
}
export function optBool(options, key, dflt = false) {
  const v = opt(options, key, dflt);
  return v === true || v === 1 || v === "true";
}
export function optNum(options, key, dflt = 0) {
  const n = Number(opt(options, key, dflt));
  return Number.isFinite(n) ? n : dflt;
}
export function optList(options, name) {
  try {
    if (options && typeof options.getList === "function") {
      const v = options.getList(name);
      return Array.isArray(v) ? v : [];
    }
  } catch (_) {
    /* fall through */
  }
  return [];
}

// ── host reads (all guarded: fakes and old hosts lack the VT members) ─────

export function call(host, name, ...args) {
  try {
    if (host && typeof host[name] === "function") return host[name](...args);
  } catch (_) {
    /* a hostile read degrades to "unknown" */
  }
  return undefined;
}

export function playerGuid(host) {
  const v = call(host, "GetPlayerId");
  return typeof v === "number" ? v >>> 0 : 0;
}

export function inPortal(host) {
  return call(host, "IsPortalSpaceActive") === true;
}

export function busyCount(host) {
  const v = call(host, "GetBusyState");
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function combatMode(host) {
  const v = call(host, "GetCurrentCombatMode");
  return typeof v === "number" ? v : null;
}

/** The player's inventory rows (per-seq memo when the seam has it). */
export function inventoryOf(host) {
  let v = call(host, "TryGetPlayerInventoryCached");
  if (!Array.isArray(v)) v = call(host, "TryGetPlayerInventory");
  return Array.isArray(v) ? v : [];
}

export function objName(host, guid) {
  const v = call(host, "TryGetObjectName", guid >>> 0);
  return typeof v === "string" ? v : "";
}
export function objInt(host, guid, prop) {
  const v = call(host, "TryGetObjectIntProperty", guid >>> 0, prop);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function objBool(host, guid, prop) {
  const v = call(host, "TryGetObjectBoolProperty", guid >>> 0, prop);
  return typeof v === "boolean" ? v : undefined;
}
export function objDid(host, guid, prop) {
  const v = call(host, "TryGetObjectDataIdProperty", guid >>> 0, prop);
  return typeof v === "number" && Number.isFinite(v) ? v >>> 0 : undefined;
}

/** Metres from the player (A15 when present, else the same-landblock rule). */
export function distanceTo(host, guid) {
  const g = guid >>> 0;
  if (!g) return null;
  if (host && typeof host.TryGetObjectDistance === "function") {
    const d = call(host, "TryGetObjectDistance", g);
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  }
  const me = call(host, "TryGetPlayerPose");
  const p = call(host, "TryGetObjectPosition", g);
  if (!me || !p) return null;
  if (p.objCellId >>> 16 !== me.objCellId >>> 16) return null;
  const d = Math.hypot((p.x || 0) - (me.x || 0), (p.y || 0) - (me.y || 0), (p.z || 0) - (me.z || 0));
  return Number.isFinite(d) ? d : null;
}

/** Plain stats {skills, vitals} (TryGetPlayerStats) or null. */
export function playerStats(host) {
  const s = call(host, "TryGetPlayerStats");
  return s && typeof s === "object" ? s : null;
}

/** {hp, stam, mana} percents (missing axes absent) from TryGetPlayerStats. */
export function vitalPercents(stats) {
  const out = {};
  const v = stats && stats.vitals;
  if (!v) return out;
  const pct = (row) => {
    if (!row) return undefined;
    const cur = Number(row.current);
    const max = Number(row.max);
    return max > 0 && Number.isFinite(cur) ? (cur / max) * 100 : undefined;
  };
  const hp = pct(v[VITAL.HEALTH]);
  const st = pct(v[VITAL.STAMINA]);
  const mn = pct(v[VITAL.MANA]);
  if (hp !== undefined) out.hp = hp;
  if (st !== undefined) out.stam = st;
  if (mn !== undefined) out.mana = mn;
  return out;
}

/** {current, max} of one vital, or null. */
export function vitalRow(stats, id) {
  const r = stats && stats.vitals ? stats.vitals[id] : null;
  if (!r) return null;
  const cur = Number(r.current);
  const max = Number(r.max);
  return Number.isFinite(cur) && max > 0 ? { current: cur, max } : null;
}

/** {current, training} of a skill, or null. */
export function skillOf(stats, id) {
  const r = stats && stats.skills ? stats.skills[id] : null;
  if (!r) return null;
  const cur = Number(r.current);
  return Number.isFinite(cur) ? { current: cur, training: Number(r.training) || 0 } : null;
}

/** TryGetSelfEnchantments rows (A5) or null when unreadable. */
export function selfEnchantments(host) {
  const v = call(host, "TryGetSelfEnchantments");
  return Array.isArray(v) ? v : null;
}

/**
 * Is the item's shared cooldown running? SharedCooldown (PropertyInt 280) N
 * shows as a cooldown enchantment row whose (spellId & 0xFFFF) is 0x8000 + N
 * (U4 row 28). Unknown cooldown / unreadable registry ⇒ false.
 */
export function sharedCooldownActive(host, guid, rows) {
  const sc = objInt(host, guid, PROP.SHARED_COOLDOWN);
  if (!(sc > 0) || !Array.isArray(rows)) return false;
  const want = (0x8000 + sc) & 0xffff;
  return rows.some((r) => r && r.isCooldown && ((Number(r.spellId) >>> 0) & 0xffff) === want);
}

// ── tokens (C8) ───────────────────────────────────────────────────────────

/** Claim the item-action token; hosts without the seam degrade open. */
export function claimItem(host, owner, opts) {
  if (!host || typeof host.tryClaimItemAction !== "function") return true;
  try {
    return host.tryClaimItemAction(owner, opts || {}) === true;
  } catch (_) {
    return false;
  }
}
export function releaseItem(host, owner) {
  call(host, "releaseItemAction", owner);
}
function itemTokenRaw(host) {
  try {
    const t = host ? host.itemActionToken : null;
    return t && typeof t === "object" ? t : null;
  } catch (_) {
    return null;
  }
}
/** A live item claim by a DIFFERENT owner. */
export function itemTokenHeldByOther(host, owner) {
  const t = itemTokenRaw(host);
  return !!(t && t.owner !== owner);
}
/** Our own claim still live (the action is unresolved). */
export function itemTokenMine(host, owner) {
  const t = itemTokenRaw(host);
  return !!(t && t.owner === owner);
}
/** Does the host have the item-token seam at all? */
export function hasItemToken(host) {
  return !!host && typeof host.tryClaimItemAction === "function";
}

const CAST_TOKEN_TIMEOUT_MS = 12_000;
/**
 * A live cast claim by anyone. `host.castToken` is a raw read (a stale claim
 * lingers until the next tryClaimCast), so the seam's own liveness rule is
 * re-applied: UseDoneSeq advanced ⇒ resolved; older than 12 s ⇒ expired.
 */
export function castTokenBusy(host, nowMs) {
  let t = null;
  try {
    t = host ? host.castToken : null;
  } catch (_) {
    t = null;
  }
  if (!t || typeof t !== "object") return false;
  const seq = call(host, "GetUseDoneSeq");
  if (typeof seq === "number" && t.useDoneAtIssue != null && seq !== t.useDoneAtIssue) return false;
  if (typeof t.issuedAt === "number" && Number.isFinite(nowMs) && nowMs - t.issuedAt > CAST_TOKEN_TIMEOUT_MS) return false;
  return true;
}

/** A bot loop by name, as SUBSYSTEM_LOOKUP resolves it (bot.x ?? bot.kernel.x). */
export function loopOf(bot, name) {
  try {
    if (!bot) return null;
    return bot[name] ?? bot.kernel?.[name] ?? null;
  } catch (_) {
    return null;
  }
}

/** Combat loop scan (memoized per snapshot inside combat_loop) or []. */
export function scanTargets(combat) {
  try {
    if (combat && typeof combat._scanTargets === "function") {
      const v = combat._scanTargets();
      return Array.isArray(v) ? v : [];
    }
  } catch (_) {
    /* fall through */
  }
  return [];
}

export function lc(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

export function isWandLike(row) {
  if (!row) return false;
  if ((Number(row.itemType) >>> 0) & IT.CASTER) return true;
  return /\b(orb|staff|wand|scepter|sceptre|baton|crozier)\b/i.test(String(row.name ?? ""));
}

export function isContainerRow(row) {
  return !!row && (row.requiresBackpackSlot === true || Number(row.itemsCapacity) > 0 || Number(row.containersCapacity) > 0);
}

// ── data JSON (C11) ───────────────────────────────────────────────────────

const DATA_FILES = Object.freeze({
  pet_essences: "../data/pet_essences.json",
  dispel_items: "../data/dispel_items.json",
  harmful_families: "../data/harmful_families.json",
});
const DATA = new Map();
const LOADING = new Map();

async function readJson(url) {
  // node (tests, tools) has no fetch for file: URLs.
  if (url.startsWith("file:")) {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(new URL(url), "utf8"));
  }
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

/** Load one support table; idempotent; never rejects (a failure leaves it unloaded). */
export function loadSupportJson(name) {
  if (DATA.has(name)) return Promise.resolve(DATA.get(name));
  const rel = DATA_FILES[name];
  if (!rel) return Promise.resolve(null);
  if (!LOADING.has(name)) {
    let url;
    try {
      url = new URL(rel, import.meta.url).href;
    } catch (_) {
      return Promise.resolve(null);
    }
    const p = readJson(url)
      .then((j) => {
        if (j && typeof j === "object" && j.v === 1) DATA.set(name, Object.freeze(j));
        else LOADING.delete(name);
        return DATA.get(name) ?? null;
      })
      .catch(() => {
        LOADING.delete(name); // allow a later retry
        return null;
      });
    LOADING.set(name, p);
  }
  return LOADING.get(name);
}

/** Load every support table (tests, INT-2 warm-up). Never rejects. */
export function loadSupportData() {
  return Promise.all(Object.keys(DATA_FILES).map((n) => loadSupportJson(n))).then(() => undefined);
}

/** The cached table, or null (kicks off the lazy load on first ask). */
export function supportData(name) {
  if (DATA.has(name)) return DATA.get(name);
  loadSupportJson(name);
  return null;
}

/** Test hook: install a table directly (fixtures), or drop one (null). */
export function setSupportData(name, value) {
  if (value == null) {
    DATA.delete(name);
    LOADING.delete(name);
  } else DATA.set(name, value);
}

// ── classification ────────────────────────────────────────────────────────

function apField(appraisal, section, name, id) {
  if (!appraisal || typeof appraisal !== "object") return undefined;
  const props = appraisal.properties && typeof appraisal.properties === "object" ? appraisal.properties : appraisal;
  const sec = props[section];
  if (!sec || typeof sec !== "object") return undefined;
  const v = sec[name] ?? sec[String(id)];
  return typeof v === "number" ? v : undefined;
}

/** Spell ids an item casts (appraisal spellBook ∪ DID Spell). */
export function itemSpellIds(host, guid, appraisal = undefined) {
  const out = new Set();
  const ap = appraisal === undefined ? call(host, "TryGetObjectAppraisal", guid >>> 0) : appraisal;
  if (ap && Array.isArray(ap.spellBook)) for (const s of ap.spellBook) if (Number(s) > 0) out.add(Number(s) >>> 0);
  const did = apField(ap, "dids", "Spell", PROP.DID_SPELL) ?? objDid(host, guid, PROP.DID_SPELL);
  if (did > 0) out.add(did >>> 0);
  return [...out];
}

function vitalOfName(name) {
  if (/\bmana\b/i.test(name)) return "mana";
  if (/\bstamina\b/i.test(name)) return "stam";
  if (/\bheal(th|ing)?\b/i.test(name)) return "hp";
  return null;
}
function vitalOfBooster(v) {
  if (v === 2 || v === 1) return "hp";
  if (v === 4 || v === 3) return "stam";
  if (v === 6 || v === 5) return "mana";
  return null;
}

/**
 * Consumable type of an inventory row (TryGetPlayerInventory shape) plus an
 * optional appraisal (TryGetObjectAppraisal JSON: properties.ints.BoosterEnum,
 * properties.dids.Spell, spellBook). Names are the fallback; "Mana Potion" is a
 * potion, never a stone (U7a H12).
 */
export function classifyConsumable(invItem, appraisal = null) {
  try {
    if (!invItem || typeof invItem !== "object") return "General";
    const name = String(invItem.name ?? "");
    const it = Number(invItem.itemType) >>> 0;
    const wcid = Number(invItem.wcid) >>> 0;
    const booster = vitalOfBooster(apField(appraisal, "ints", "BoosterEnum", PROP.BOOSTER_ENUM));
    const hasSpell =
      (appraisal && Array.isArray(appraisal.spellBook) && appraisal.spellBook.length > 0) ||
      apField(appraisal, "dids", "Spell", PROP.DID_SPELL) > 0;
    const dispel = supportData("dispel_items");
    const dispelWcids = dispel && Array.isArray(dispel.wcids) ? new Set(dispel.wcids) : DEFAULT_DISPEL_WCIDS;
    let dispelRe = DEFAULT_DISPEL_NAME_RE;
    if (dispel && typeof dispel.nameRegex === "string") {
      try {
        dispelRe = new RegExp(dispel.nameRegex, "i");
      } catch (_) {
        /* keep the default */
      }
    }

    if (/encapsulated spirit/i.test(name)) return "General"; // the pet-refill item (pets.js finds it by name)
    if (/\bmana charge\b/i.test(name)) return "ManaCharge";
    const isPotionName = /\b(potion|elixir|draught|tonic|philter|philtre|tincture|brew)\b/i.test(name);
    if (!isPotionName && (it & IT.MANA_STONE || /\bmana stone\b/i.test(name))) return "ManaStone";
    if (/\block ?pick/i.test(name) && !/\b(gem|inscription|scroll|forge|golem)\b/i.test(name)) return "Lockpick";
    if (!(it & IT.WRITABLE) && (dispelWcids.has(wcid) || dispelRe.test(name))) return "Dispel";
    if (/\bessence\b/i.test(name)) return "Pet";
    if (/\bgrenade\b/i.test(name) || (it & IT.MISSILE && /\bphial of\b/i.test(name))) return "Grenade";
    if (/\bkit\b/i.test(name)) {
      const v = booster ?? vitalOfName(name) ?? "hp";
      return v === "mana" ? "ManaKit" : v === "stam" ? "StaminaKit" : "HealthKit";
    }
    if (isPotionName) {
      const v = booster ?? vitalOfName(name);
      if (v === "mana") return "ManaPotion";
      if (v === "stam") return "StaminaPotion";
      if (v === "hp") return "HealthPotion";
      return hasSpell ? "BuffItem" : "General";
    }
    if (it & IT.FOOD) {
      const v = booster ?? vitalOfName(name);
      if (v === "mana") return "ManaPotion";
      if (v === "stam") return "StaminaFood";
      if (v === "hp") return "HealthFood";
      return hasSpell ? "BuffItem" : "General";
    }
    if (it & IT.SPELL_COMPONENTS) return "PeaComponent";
    if (hasSpell && !(it & (IT.MELEE | IT.ARMOR | IT.CLOTHING | IT.JEWELRY | IT.MISSILE | IT.CASTER))) return "BuffItem";
    return "General";
  } catch (_) {
    return "General";
  }
}

// ── the model ─────────────────────────────────────────────────────────────

function normalizeIds(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const n = Number(x) >>> 0;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** A clean ConsumableEntry (§3.2); type null when invalid. */
export function normalizeConsumable(e) {
  const src = e && typeof e === "object" ? e : {};
  const out = {
    guid: Number(src.guid) >>> 0,
    name: String(src.name ?? ""),
    wcid: Number(src.wcid) >>> 0,
    type: TYPE_SET.has(src.type) ? src.type : null,
  };
  if (src.keepAtLeast != null && Number.isFinite(Number(src.keepAtLeast))) {
    out.keepAtLeast = Math.max(0, Math.round(Number(src.keepAtLeast)));
  }
  if (src.toolGuid != null && Number(src.toolGuid) >>> 0) out.toolGuid = Number(src.toolGuid) >>> 0;
  if (src.spellIds != null) out.spellIds = normalizeIds(src.spellIds);
  if (src.durationS != null && Number.isFinite(Number(src.durationS))) out.durationS = Number(src.durationS);
  return out;
}

export class ConsumablesModel {
  constructor({ options = null, host = null, log, now = Date.now } = {}) {
    this.options = options;
    this.host = host;
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLogger(log, "consumables", this.now);
    this._mem = []; // used only without options
  }

  _read() {
    try {
      if (this.options && typeof this.options.getList === "function") {
        const v = this.options.getList("consumables");
        return Array.isArray(v) ? v.map(normalizeConsumable).filter((e) => e.type) : [];
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
        const r = this.options.setList("consumables", rows, { source });
        return r && r.ok === false ? { ok: false, error: r.error || "could not save the Consumables list" } : { ok: true };
      }
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
    this._mem = rows;
    return { ok: true };
  }

  list() {
    return this._read();
  }

  find(guid) {
    const g = Number(guid) >>> 0;
    if (!g) return null;
    return this._read().find((e) => e.guid === g) || null;
  }

  ofType(t) {
    return this._read().filter((e) => e.type === t);
  }

  /**
   * Add an inventory item. `entry` may be partial: { guid } or { name } plus
   * an optional { type } (else classifyConsumable) and the type extras
   * (keepAtLeast/toolGuid for PeaComponent, spellIds/durationS for BuffItem).
   * A BuffItem is validated (G:181) — its spells are read from the appraisal /
   * DID Spell and its duration from the DAT records when not given.
   */
  add(entry) {
    try {
      const src = entry && typeof entry === "object" ? entry : {};
      let guid = Number(src.guid) >>> 0;
      const inv = inventoryOf(this.host);
      let row = guid ? inv.find((i) => (Number(i.guid) >>> 0) === guid) || null : null;
      if (!guid && src.name) {
        const want = lc(src.name);
        row = inv.find((i) => lc(i.name) === want) || null;
        if (row) guid = Number(row.guid) >>> 0;
      }
      if (!guid) return { ok: false, error: src.name ? `no item named "${src.name}" in your inventory` : "no item selected" };
      if (!row) return { ok: false, error: "that item is not in your inventory" };
      const name = String(row.name || src.name || objName(this.host, guid) || "");
      let type = TYPE_SET.has(src.type) ? src.type : null;
      if (!type) {
        const ap = call(this.host, "TryGetObjectAppraisal", guid);
        type = classifyConsumable(row, ap || null);
      }
      const e = normalizeConsumable({ ...src, guid, name, wcid: src.wcid ?? row.wcid ?? 0, type });
      if (e.type === "BuffItem") {
        if (!e.spellIds || !e.spellIds.length) e.spellIds = itemSpellIds(this.host, guid);
        if (e.durationS == null) {
          const d = this._durationOf(e.spellIds);
          if (d != null) e.durationS = d;
        }
        const v = this.validateBuffItem(e);
        if (!v.ok) return v;
      }
      const list = this._read();
      if (list.some((x) => x.guid === e.guid)) return { ok: false, error: `${e.name || "that item"} is already on the Consumables list` };
      list.push(e);
      const w = this._write(list);
      return w.ok ? { ok: true, entry: { ...e } } : w;
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  _durationOf(spellIds) {
    let best = null;
    for (const id of spellIds || []) {
      const rec = call(this.host, "TryGetSpellRecord", id);
      const d = rec ? Number(rec.duration) : NaN;
      if (Number.isFinite(d) && d > 0) best = best == null ? d : Math.max(best, d);
    }
    return best;
  }

  /**
   * G:181: "buff items that last less than 5 minutes are not allowed" — every
   * buff spell is recast below the rebuff threshold, which is configurable, so
   * the floor is max(300, RebuffSecondsRemaining) seconds. An unknown duration
   * is refused too (appraise the item first).
   */
  validateBuffItem(entry) {
    try {
      const e = normalizeConsumable(entry);
      const floor = Math.max(300, optNum(this.options, "RebuffSecondsRemaining", 300));
      const d = e.durationS != null ? e.durationS : this._durationOf(e.spellIds);
      if (!e.spellIds || !e.spellIds.length) {
        return { ok: false, error: `${e.name || "that item"}: no buff spell known — appraise it first` };
      }
      if (d == null) return { ok: false, error: `${e.name || "that item"}: buff duration unknown — appraise it first` };
      if (d < floor) {
        return {
          ok: false,
          error: `${e.name || "that item"} lasts ${Math.round(d)} s; buff items under ${Math.round(floor)} s are not allowed (they would be reused at once)`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  /** Patch fields of one entry (guid is the identity and never changes). */
  update(guid, patch) {
    try {
      const g = Number(guid) >>> 0;
      const list = this._read();
      const i = list.findIndex((e) => e.guid === g);
      if (i < 0) return { ok: false, error: "not on the Consumables list" };
      const p = patch && typeof patch === "object" ? patch : {};
      const next = normalizeConsumable({ ...list[i], ...p, guid: g });
      if (!next.type) return { ok: false, error: `type must be one of ${CONSUMABLE_TYPES.join(", ")}` };
      if (next.type === "BuffItem" && (p.type === "BuffItem" || "durationS" in p || "spellIds" in p)) {
        const v = this.validateBuffItem(next);
        if (!v.ok) return v;
      }
      list[i] = next;
      return this._write(list);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  remove(guid) {
    try {
      const g = Number(guid) >>> 0;
      const list = this._read();
      const next = list.filter((e) => e.guid !== g);
      if (next.length === list.length) return { ok: false, error: "not on the Consumables list" };
      return this._write(next);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** The live guid of an entry: its own guid when owned, else a (name, wcid) match, else 0. */
  resolveGuid(entry, inv = null) {
    return resolveOwned(this.host, entry, inv);
  }

  /** Every owned inventory row matching an entry (by guid, else by name + wcid). */
  matchingRows(entry, inv = null) {
    try {
      const rows = Array.isArray(inv) ? inv : inventoryOf(this.host);
      const g = Number(entry && entry.guid) >>> 0;
      const name = lc(entry && entry.name);
      const wcid = Number(entry && entry.wcid) >>> 0;
      return rows.filter(
        (r) => (g && (Number(r.guid) >>> 0) === g) || (name && lc(r.name) === name && (!wcid || (Number(r.wcid) >>> 0) === wcid))
      );
    } catch (_) {
      return [];
    }
  }
}

/** guid if owned, else (name, wcid) match, else 0 — shared with every module. */
export function resolveOwned(host, entry, inv = null) {
  try {
    if (!entry) return 0;
    const rows = Array.isArray(inv) ? inv : inventoryOf(host);
    const g = Number(entry.guid) >>> 0;
    if (g && rows.some((i) => (Number(i.guid) >>> 0) === g)) return g;
    const name = lc(entry.name);
    const wcid = Number(entry.wcid) >>> 0;
    if (!name) return 0;
    const hit = rows.find((i) => lc(i.name) === name && (!wcid || (Number(i.wcid) >>> 0) === wcid));
    return hit ? Number(hit.guid) >>> 0 : 0;
  } catch (_) {
    return 0;
  }
}

/** Resolve a consumables model or a raw list to entries (fakes pass either). */
export function consumableEntries(consumables) {
  try {
    if (consumables && typeof consumables.list === "function") {
      const v = consumables.list();
      return Array.isArray(v) ? v.map(normalizeConsumable).filter((e) => e.type) : [];
    }
  } catch (_) {
    /* fall through */
  }
  return [];
}
