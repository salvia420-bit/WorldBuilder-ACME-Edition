// rynth/vt/cmd/actions_lib.js — shared world / inventory helpers for the /rs
// compat verbs (/ra /mt /ub use|select|give|loot|drop|equip|cast|face|…) and
// the meta host-function library (stdlib_host.js). PLAN W1-5 CMD, §3.7.
//
// House rules kept here:
//   * C6 cast choke point: casts go ONLY through host.CastSpellAt / host.CastSelf.
//     castById never casts untargeted — SelfTargeted spells are cast at the
//     player (CastSelf), anything else needs a non-zero target (CastSpellAt),
//     otherwise the attempt is "impossible" (2). (U4 H1: an untargeted
//     non-SelfTargeted enchantment crashes ACE.)
//   * C8 item actions: UseObject / UseItemOnTarget / GiveObject / WieldItem /
//     UnwieldItem / DropItem / TakeObject claim the host item token (owner
//     "vtcmd") first when the host has one; the token clears on the server's
//     answer (kinds 11/13/14/48) or its 8 s timeout.
//   * V-12: casts and item actions hold in portal space (castById → 1, an
//     item action → {ok:false, retry:true}); a busy item token is also retry.
//   * C9 never throws: every public member wraps its body.
//   * The host may be passed as the object or as a getter (rebinds).
//
// Object classes are the VTank/Decal ObjectClass numbers (RynthAi
// AcObjectClass, Shared/RynthCore.LootSdk/AcGameEnums.cs): resolved from the
// ItemType (int property 1) and the ObjectDescriptionFlags exactly like the
// canonical ACPlugin classifier (plugins/world-objects/canonical_classify.js,
// re-implemented here because vt modules may not import it, PLAN C2).

export const OBJECT_CLASS = Object.freeze({
  Unknown: 0, MeleeWeapon: 1, Armor: 2, Clothing: 3, Jewelry: 4, Monster: 5, Food: 6, Money: 7, Misc: 8,
  MissileWeapon: 9, Container: 10, Gem: 11, SpellComponent: 12, Key: 13, Portal: 14, TradeNote: 15, ManaStone: 16,
  Plant: 17, BaseCooking: 18, BaseAlchemy: 19, BaseFletching: 20, CraftedCooking: 21, CraftedAlchemy: 22,
  CraftedFletching: 23, Player: 24, Vendor: 25, Door: 26, Corpse: 27, Lifestone: 28, HealingKit: 29, Lockpick: 30,
  WandStaffOrb: 31, Bundle: 32, Book: 33, Journal: 34, Sign: 35, Housing: 36, Npc: 37, Foci: 38, Salvage: 39,
  Ust: 40, Services: 41, Scroll: 42, CombatPet: 43,
});

// ItemType bits (ACE.Entity/Enum/ItemType.cs).
const IT = Object.freeze({
  MELEE: 0x1, ARMOR: 0x2, CLOTHING: 0x4, JEWELRY: 0x8, CREATURE: 0x10, FOOD: 0x20, MONEY: 0x40, MISC: 0x80,
  MISSILE: 0x100, CONTAINER: 0x200, USELESS: 0x400, GEM: 0x800, SPELL_COMPONENTS: 0x1000, WRITABLE: 0x2000,
  KEY: 0x4000, CASTER: 0x8000, PORTAL: 0x10000, PROMISSORY_NOTE: 0x40000, MANA_STONE: 0x80000,
  SERVICE: 0x100000, MAGIC_WIELDABLE: 0x200000, CRAFT_COOKING_BASE: 0x400000, CRAFT_ALCHEMY_BASE: 0x800000,
  CRAFT_FLETCHING_BASE: 0x2000000, CRAFT_ALCHEMY_INTERMEDIATE: 0x4000000, CRAFT_FLETCHING_INTERMEDIATE: 0x8000000,
  LIFESTONE: 0x10000000, TINKERING_TOOL: 0x20000000, TINKERING_MATERIAL: 0x40000000,
});
// ObjectDescriptionFlag bits (holtburger-common properties/object.rs).
export const ODF = Object.freeze({
  OPENABLE: 0x1, INSCRIBABLE: 0x2, STUCK: 0x4, PLAYER: 0x8, ATTACKABLE: 0x10, BOOK: 0x100, VENDOR: 0x200,
  DOOR: 0x1000, CORPSE: 0x2000, LIFESTONE: 0x4000, FOOD: 0x8000, HEALER: 0x10000, LOCKPICK: 0x20000,
  PORTAL: 0x40000, REQUIRES_PACK_SLOT: 0x800000, INCLUDES_SECOND_HEADER: 0x4000000, BIND_STONE: 0x8000000,
});
// Wielded-slot masks (EquipMask) used to tell what is in hand.
export const EQUIP = Object.freeze({ MELEE: 0x1, SHIELD: 0x200000, MISSILE: 0x400000, CASTER: 0x1000000 });

const PINT_ITEM_TYPE = 1;
const COMBAT_MODE = Object.freeze({ peace: 1, noncombat: 1, melee: 2, missile: 4, magic: 8 });
const CMD_OWNER = "vtcmd";
const MODE_CHANGE_GAP_MS = 3000;
const WIELD_GAP_MS = 3000;

/**
 * VTank ObjectClass from an ItemType bitfield and ObjectDescriptionFlags
 * (canonical ACPlugin WorldObject.GetObjectClass order).
 */
export function objectClassFrom(itemType, descFlags) {
  const it = Number(itemType) >>> 0;
  const df = Number(descFlags) >>> 0;
  const C = OBJECT_CLASS;
  let cls = C.Unknown;
  if (it & IT.MELEE) cls = C.MeleeWeapon;
  else if (it & IT.ARMOR) cls = C.Armor;
  else if (it & IT.CLOTHING) cls = C.Clothing;
  else if (it & IT.JEWELRY) cls = C.Jewelry;
  else if (it & IT.CREATURE) cls = C.Monster;
  else if (it & IT.FOOD) cls = C.Food;
  else if (it & IT.MONEY) cls = C.Money;
  else if (it & IT.MISC) cls = C.Misc;
  else if (it & IT.MISSILE) cls = C.MissileWeapon;
  else if (it & IT.CONTAINER) cls = C.Container;
  else if (it & IT.USELESS) cls = C.Bundle;
  else if (it & IT.GEM) cls = C.Gem;
  else if (it & IT.SPELL_COMPONENTS) cls = C.SpellComponent;
  else if (it & IT.KEY) cls = C.Key;
  else if (it & IT.CASTER) cls = C.WandStaffOrb;
  else if (it & IT.PORTAL) cls = C.Portal;
  else if (it & IT.PROMISSORY_NOTE) cls = C.TradeNote;
  else if (it & IT.MANA_STONE) cls = C.ManaStone;
  else if (it & IT.SERVICE) cls = C.Services;
  else if (it & IT.MAGIC_WIELDABLE) cls = C.Plant;
  else if (it & IT.CRAFT_COOKING_BASE) cls = C.BaseCooking;
  else if (it & IT.CRAFT_ALCHEMY_BASE) cls = C.BaseAlchemy;
  else if (it & IT.CRAFT_FLETCHING_BASE) cls = C.BaseFletching;
  else if (it & IT.CRAFT_ALCHEMY_INTERMEDIATE) cls = C.CraftedAlchemy;
  else if (it & IT.CRAFT_FLETCHING_INTERMEDIATE) cls = C.CraftedFletching;
  else if (it & IT.LIFESTONE) cls = C.Lifestone;
  else if (it & IT.TINKERING_TOOL) cls = C.Ust;
  else if (it & IT.TINKERING_MATERIAL) cls = C.Salvage;

  if (df & ODF.PLAYER) cls = C.Player;
  else if (df & ODF.VENDOR) cls = C.Vendor;
  else if (df & ODF.DOOR) cls = C.Door;
  else if (df & ODF.CORPSE) cls = C.Corpse;
  else if (df & ODF.LIFESTONE) cls = C.Lifestone;
  else if (df & ODF.FOOD) cls = C.Food;
  else if (df & ODF.HEALER) cls = C.HealingKit;
  else if (df & ODF.LOCKPICK) cls = C.Lockpick;
  else if (df & ODF.PORTAL) cls = C.Portal;
  else if (df & ODF.REQUIRES_PACK_SLOT) cls = C.Foci;
  else if (df & ODF.OPENABLE) cls = C.Container;

  if (cls === C.Unknown && it & IT.WRITABLE && df & ODF.BOOK) {
    cls = df & ODF.INSCRIBABLE ? C.Journal : df & ODF.STUCK ? C.Sign : C.Book;
  }
  // A creature is a Monster only when attackable (RynthAi ResolveEffectiveObjectClass,
  // ExpressionEngine.cs:1676-1700); otherwise it is an NPC.
  if (cls === C.Monster && !(df & ODF.ATTACKABLE)) cls = C.Npc;
  return cls;
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

/** Tiny cached case-insensitive RegExp builder (fallback when no EXPR getRegex is injected). */
function makeRegexCache(getRegex, log) {
  const cache = new Map();
  return (pattern) => {
    const p = String(pattern ?? "");
    if (typeof getRegex === "function") {
      try {
        return getRegex(p, "i") || null;
      } catch (_) {
        return null;
      }
    }
    if (cache.has(p)) return cache.get(p);
    let re = null;
    try {
      re = new RegExp(p, "i");
    } catch (e) {
      log(`bad regex /${p}/: ${errText(e)}`);
    }
    if (cache.size > 512) cache.clear();
    cache.set(p, re);
    return re;
  };
}

/** Name matcher: exact (case-insensitive), partial (substring) or regex. null for an empty/bad spec. */
function makeMatcher(name, { partial = false, regex = false } = {}, rx) {
  const want = String(name ?? "").trim();
  if (!want) return null;
  if (regex) {
    const re = rx(want);
    if (!re) return null;
    return (n) => {
      re.lastIndex = 0;
      return re.test(String(n ?? ""));
    };
  }
  const lw = want.toLowerCase();
  return partial ? (n) => String(n ?? "").toLowerCase().includes(lw) : (n) => String(n ?? "").toLowerCase() === lw;
}

function defaultLog(prefix) {
  const last = new Map();
  return (msg) => {
    const t = Date.now();
    const key = String(msg);
    if (last.has(key) && t - last.get(key) < 10_000) return;
    last.set(key, t);
    if (last.size > 256) last.clear();
    try {
      console.log(`[vt:${prefix}] ${key}`);
    } catch (_) {
      /* no console */
    }
  };
}

/**
 * @param {{host?: object|(() => object), getBot?: () => object|null, print?: (text:string, cat?:number) => void,
 *          log?: (msg:string) => void, now?: () => number, getRegex?: (pattern:string, flags:string) => RegExp|null}} deps
 */
export function createVtActions({ host = null, getBot = () => null, print = null, log, now = Date.now, getRegex = null } = {}) {
  const say = typeof log === "function" ? log : defaultLog("cmd");
  const clock = typeof now === "function" ? now : Date.now;
  const rx = makeRegexCache(getRegex, say);
  let lastModeChangeAt = -Infinity;

  const H = () => {
    try {
      const h = typeof host === "function" ? host() : host;
      if (h) return h;
      const b = typeof getBot === "function" ? getBot() : null;
      return (b && b.host) || null;
    } catch (_) {
      return null;
    }
  };
  const t = () => {
    try {
      const v = Number(clock());
      return Number.isFinite(v) ? v : 0;
    } catch (_) {
      return 0;
    }
  };
  const call = (h, name, ...args) => {
    if (!h || typeof h[name] !== "function") return undefined;
    try {
      return h[name](...args);
    } catch (e) {
      say(`${name} failed: ${errText(e)}`);
      return undefined;
    }
  };

  // ── reads ──────────────────────────────────────────────────────────────
  function playerGuid() {
    return (Number(call(H(), "GetPlayerId")) >>> 0) || 0;
  }
  function objName(guid) {
    const n = call(H(), "TryGetObjectName", guid >>> 0);
    return typeof n === "string" ? n : "";
  }
  function inventory() {
    const h = H();
    let rows = call(h, "TryGetPlayerInventoryCached");
    if (!Array.isArray(rows)) rows = call(h, "TryGetPlayerInventory");
    return Array.isArray(rows) ? rows.filter((r) => r && (Number(r.guid) >>> 0)) : [];
  }
  function distanceTo(guid) {
    const h = H();
    const d = call(h, "TryGetObjectDistance", guid >>> 0);
    if (typeof d === "number" && Number.isFinite(d)) return d;
    // Fallback (hosts without A15): same-landblock / both-outdoor 2-D+z rule.
    const me = call(h, "TryGetPlayerPose");
    const pos = call(h, "TryGetObjectPosition", guid >>> 0);
    if (!me || !pos) return null;
    const a = Number(me.objCellId) >>> 0;
    const b = Number(pos.objCellId) >>> 0;
    const outdoor = (c) => (c & 0xffff) < 0x100;
    let dx;
    let dy;
    if (a >>> 16 === b >>> 16) {
      dx = pos.x - me.x;
      dy = pos.y - me.y;
    } else if (outdoor(a) && outdoor(b)) {
      dx = ((b >>> 24) & 0xff) * 192 + pos.x - (((a >>> 24) & 0xff) * 192 + me.x);
      dy = ((b >>> 16) & 0xff) * 192 + pos.y - (((a >>> 16) & 0xff) * 192 + me.y);
    } else {
      return null;
    }
    const dist = Math.hypot(dx, dy, (pos.z ?? 0) - (me.z ?? 0));
    return Number.isFinite(dist) ? dist : null;
  }
  function itemTypeOf(guid) {
    const g = guid >>> 0;
    // The live property first: the inventory fallback copies every pack row,
    // and class filters call this once per nearby object.
    const v = call(H(), "TryGetObjectIntProperty", g, PINT_ITEM_TYPE);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v >>> 0;
    const row = inventory().find((r) => Number(r.guid) >>> 0 === g);
    return row && Number.isFinite(Number(row.itemType)) ? Number(row.itemType) >>> 0 : 0;
  }
  function descFlagsOf(guid) {
    const v = call(H(), "TryGetObjectDescFlags", guid >>> 0);
    return typeof v === "number" ? v >>> 0 : 0;
  }
  function objectClassOf(guid) {
    const g = guid >>> 0;
    if (!g) return OBJECT_CLASS.Unknown;
    return objectClassFrom(itemTypeOf(g), descFlagsOf(g));
  }
  /** Landscape objects (not self, not carried) from the host's nearby list: [{guid, name, dist|null}]. */
  function landscape() {
    const h = H();
    const me = playerGuid();
    const list = call(h, "NearbyGuids");
    const carried = new Set(inventory().map((r) => Number(r.guid) >>> 0));
    const out = [];
    const seen = new Set();
    for (const g0 of Array.isArray(list) || (list && typeof list.length === "number") ? Array.from(list) : []) {
      const g = Number(g0) >>> 0;
      if (!g || g === me || seen.has(g) || carried.has(g)) continue;
      seen.add(g);
      const name = objName(g);
      if (!name) continue;
      out.push({ guid: g, name, dist: distanceTo(g) });
    }
    return out;
  }
  const byDist = (a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity);

  function findAllByName(name, { partial = false, regex = false, objectClass = null, maxDistM = 250 } = {}) {
    try {
      const match = makeMatcher(name, { partial, regex }, rx);
      if (!match) return [];
      const h = H();
      const cls = objectClass === null || objectClass === undefined || objectClass === "" ? null : Number(objectClass);
      let rows = null;
      // FindNearbyByName (A16) reaches past the snapshot range (≤ 250 m).
      if (!regex && typeof h?.FindNearbyByName === "function") {
        const r = call(h, "FindNearbyByName", String(name).trim(), { exact: !partial, maxDistM });
        if (Array.isArray(r)) rows = r.map((o) => ({ guid: Number(o.guid) >>> 0, name: String(o.name ?? ""), dist: o.dist ?? null }));
      }
      if (!rows) rows = landscape().filter((o) => match(o.name));
      const lim = Number.isFinite(Number(maxDistM)) && Number(maxDistM) > 0 ? Number(maxDistM) : 250;
      return rows
        .filter((o) => o.dist === null || o.dist <= lim)
        .filter((o) => cls === null || objectClassOf(o.guid) === cls)
        .sort(byDist);
    } catch (e) {
      say(`findAllByName failed: ${errText(e)}`);
      return [];
    }
  }
  function findNearestByName(name, opts = {}) {
    const all = findAllByName(name, opts);
    return all.length ? all[0] : null;
  }
  function findInventoryByName(name, { partial = false, regex = false } = {}) {
    try {
      const match = makeMatcher(name, { partial, regex }, rx);
      if (!match) return [];
      return inventory()
        .filter((r) => match(r.name))
        .map((r) => ({
          guid: Number(r.guid) >>> 0,
          name: String(r.name ?? ""),
          stack: Math.max(1, Number(r.stackSize) || 1),
          containerId: Number(r.containerId) >>> 0,
          wcid: Number(r.wcid) >>> 0,
        }));
    } catch (e) {
      say(`findInventoryByName failed: ${errText(e)}`);
      return [];
    }
  }
  function inventoryCount(name, opts = {}) {
    return findInventoryByName(name, opts).reduce((s, r) => s + r.stack, 0);
  }

  // V-12: every VT caster and item action holds in portal space (the server
  // refuses them there anyway, and a refused action would park the item token).
  function inPortalSpace(h) {
    try {
      return h?.IsPortalSpaceActive?.() === true;
    } catch (_) {
      return false;
    }
  }

  // ── item actions (C8) ──────────────────────────────────────────────────
  function claimItem(h, minIntervalMs = 0) {
    if (typeof h?.tryClaimItemAction !== "function") return true;
    try {
      return h.tryClaimItemAction(CMD_OWNER, { minIntervalMs }) === true;
    } catch (_) {
      return false;
    }
  }
  function releaseItem(h) {
    try {
      h?.releaseItemAction?.(CMD_OWNER);
    } catch (_) {
      /* best effort */
    }
  }
  function itemAction(label, member, args, { minIntervalMs = 0 } = {}) {
    const h = H();
    if (!h) return { ok: false, error: "not in the world" };
    if (typeof h[member] !== "function") return { ok: false, error: `${label} is not available on this client` };
    if (inPortalSpace(h)) return { ok: false, error: `${label} waits: in portal space`, retry: true };
    if (!claimItem(h, minIntervalMs)) return { ok: false, error: "another item action is in progress — try again", retry: true };
    let r;
    try {
      r = h[member](...args);
    } catch (e) {
      releaseItem(h);
      return { ok: false, error: `${label} failed: ${errText(e)}` };
    }
    if (r === false) {
      releaseItem(h);
      return { ok: false, error: `${label} was not sent` };
    }
    return { ok: true };
  }
  const g32 = (g) => Number(g) >>> 0;

  function use(guid) {
    if (!g32(guid)) return { ok: false, error: "nothing to use" };
    return itemAction("use", "UseObject", [g32(guid)]);
  }
  function useOn(item, target) {
    if (!g32(item) || !g32(target)) return { ok: false, error: "use-on needs an item and a target" };
    return itemAction("use-on", "UseItemOnTarget", [g32(item), g32(target)]);
  }
  function give(item, target, amount = 1) {
    if (!g32(item) || !g32(target)) return { ok: false, error: "give needs an item and a target" };
    const n = Math.max(1, Math.trunc(Number(amount) || 1));
    // RynthWebHost.GiveObject(targetGuid, itemGuid, amount) — target first.
    return itemAction("give", "GiveObject", [g32(target), g32(item), n]);
  }
  function select(guid) {
    const h = H();
    if (!g32(guid)) return { ok: false, error: "nothing to select" };
    if (typeof h?.SelectObject !== "function") return { ok: false, error: "selection is not available" };
    const r = call(h, "SelectObject", g32(guid));
    return r === false ? { ok: false, error: "no 3D scene to select in" } : { ok: true };
  }
  function equip(guid) {
    if (!g32(guid)) return { ok: false, error: "nothing to equip" };
    const h = H();
    if (typeof h?.WieldItem === "function") return itemAction("equip", "WieldItem", [g32(guid)]);
    return itemAction("equip", "UseObject", [g32(guid)]);
  }
  function unequip(guid) {
    if (!g32(guid)) return { ok: false, error: "nothing to unequip" };
    return itemAction("unequip", "UnwieldItem", [g32(guid)]);
  }
  function drop(guid) {
    if (!g32(guid)) return { ok: false, error: "nothing to drop" };
    return itemAction("drop", "DropItem", [g32(guid)]);
  }
  /** Pick a named item out of the open ground container (exact name preferred, substring fallback). */
  function lootFromOpen(name, { partial = false } = {}) {
    try {
      const want = String(name ?? "").trim();
      if (!want) return { ok: false, error: "nothing to loot" };
      const h = H();
      const container = Number(call(h, "GetGroundContainerId")) >>> 0;
      if (!container) return { ok: false, error: "no container is open", retry: true };
      const ids = call(h, "GetContainerContents", container);
      const items = (Array.isArray(ids) ? ids : []).map((g) => ({ guid: Number(g) >>> 0, name: objName(g) })).filter((o) => o.guid);
      const lw = want.toLowerCase();
      let hit = partial ? null : items.find((o) => o.name.toLowerCase() === lw) || null;
      if (!hit) hit = items.find((o) => o.name.toLowerCase().includes(lw)) || null;
      if (!hit) {
        return { ok: false, error: `'${want}' is not in the open container`, retry: true, contents: items.map((o) => o.name) };
      }
      const member = typeof h?.TakeObject === "function" ? "TakeObject" : "UseObject";
      const r = itemAction("loot", member, [hit.guid]);
      return r.ok ? { ok: true, guid: hit.guid, name: hit.name, container } : r;
    } catch (e) {
      return { ok: false, error: `loot failed: ${errText(e)}` };
    }
  }

  // ── combat stance / facing ──────────────────────────────────────────────
  function setCombatState(state) {
    const h = H();
    const mode = typeof state === "number" ? state : COMBAT_MODE[String(state ?? "").trim().toLowerCase()];
    if (![1, 2, 4, 8].includes(mode)) return { ok: false, error: `unknown combat state "${state}" (peace|melee|missile|magic)` };
    if (typeof h?.ChangeCombatMode !== "function") return { ok: false, error: "combat mode is not available" };
    const r = call(h, "ChangeCombatMode", mode);
    if (r === false) return { ok: false, error: "combat mode change was not sent" };
    if (mode === 8) lastModeChangeAt = t();
    return { ok: true, mode };
  }
  function face(deg) {
    const h = H();
    const d = Number(deg);
    if (!Number.isFinite(d)) return { ok: false, error: `"${deg}" is not a heading in degrees` };
    const norm = ((d % 360) + 360) % 360;
    if (typeof h?.TurnToCompassHeading !== "function") return { ok: false, error: "turning is not available on this client" };
    const r = call(h, "TurnToCompassHeading", norm);
    return r === false ? { ok: false, error: "turn was not sent" } : { ok: true, headingDeg: norm };
  }

  // ── casting (C6) ─────────────────────────────────────────────────────────
  function casterRows() {
    return inventory().filter((r) => (Number(r.itemType) >>> 0) & IT.CASTER);
  }
  function casterWielded() {
    const inv = inventory();
    if (!inv.length) return null;
    return inv.some((r) => (Number(r.equipMask) >>> 0) & EQUIP.CASTER);
  }
  /** One bounded step toward Magic mode. */
  function stepToMagic(h) {
    const wielded = casterWielded();
    if (wielded === false) {
      const wand = casterRows().find((r) => !((Number(r.equipMask) >>> 0) & EQUIP.CASTER));
      if (wand) {
        if (typeof h.WieldItem === "function") itemAction("equip wand", "WieldItem", [Number(wand.guid) >>> 0], { minIntervalMs: WIELD_GAP_MS });
        return;
      }
    }
    if (t() - lastModeChangeAt >= MODE_CHANGE_GAP_MS && typeof h.ChangeCombatMode === "function") {
      lastModeChangeAt = t();
      call(h, "ChangeCombatMode", 8);
    }
  }
  /**
   * Try to cast `spellId` (UB actiontrycastbyid semantics).
   * @returns {0|1|2} 0 = the cast was sent; 1 = a step was taken / busy / in portal space, try again;
   *                  2 = impossible (bad id, unknown spell, no target for a non-self spell, no cast API)
   */
  function castById(spellId, targetGuid = null) {
    try {
      const id = Math.trunc(Number(spellId));
      if (!(id > 0)) return 2;
      const h = H();
      if (!h || (typeof h.CastSpellAt !== "function" && typeof h.CastSelf !== "function")) return 2;
      const known = call(h, "TryGetKnownSpells");
      if (Array.isArray(known) && known.length && !known.map(Number).includes(id)) return 2;
      const rec = call(h, "TryGetSpellRecord", id) || null;
      const tgt = Number(targetGuid) >>> 0;
      let form;
      if (rec && rec.isSelfTargeted) form = "self";
      else if (tgt) form = "target";
      else return 2; // not known to be SelfTargeted and no target: impossible (never untargeted, PLAN §6 W1-5)
      if (inPortalSpace(h)) return 1; // V-12: hold, retry after the portal
      if (Number(call(h, "GetCurrentCombatMode")) !== 8) {
        stepToMagic(h);
        return 1;
      }
      if (Number(call(h, "GetBusyState")) > 0) return 1;
      if (typeof h.tryClaimCast === "function" && h.tryClaimCast(CMD_OWNER) !== true) return 1;
      const sent = form === "self" ? call(h, "CastSelf", id) : call(h, "CastSpellAt", tgt, id);
      if (sent === false || sent === undefined) {
        try {
          h.releaseCast?.(CMD_OWNER);
        } catch (_) {
          /* best effort */
        }
        return 2;
      }
      return 0;
    } catch (e) {
      say(`castById failed: ${errText(e)}`);
      return 2;
    }
  }

  return {
    findNearestByName,
    findAllByName,
    findInventoryByName,
    inventoryCount,
    use,
    useOn,
    give,
    select,
    equip,
    unequip,
    drop,
    lootFromOpen,
    castById,
    setCombatState,
    face,
    // additive helpers (stdlib_host / compat verbs)
    host: H,
    /** The operator hold (Run Macro off) of the bot getBot() returns. */
    operatorHeld: () => {
      try {
        const b = typeof getBot === "function" ? getBot() : null;
        return !!(b && b.kernel && b.kernel.operatorHeld === true);
      } catch (_) {
        return false;
      }
    },
    playerGuid,
    objName,
    inventory,
    landscape,
    distanceTo,
    objectClassOf,
    casterWielded,
    casterRows,
    matcher: (name, opts) => makeMatcher(name, opts, rx),
    regex: (p) => rx(p),
    print: typeof print === "function" ? print : null,
  };
}
