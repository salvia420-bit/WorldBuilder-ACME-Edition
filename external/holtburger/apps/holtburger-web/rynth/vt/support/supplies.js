// rynth/vt/support/supplies.js — the "Supplies" kernel slot (PLAN W1-9 SUP,
// §3.11; §2.3 V3, §2.1 O13-O14, §2.6 C3/C5).
//
// Rank afterVitals, keepsCombatLoop: the kernel offers it the tick right after
// the Vitals block, so it acts only when rynth/vitals.js did NOT take the tick
// (no recovery spell known / castable, the axis parked, no caster …) and it
// keeps ACE's attack loop alive while it borrows a tick mid-fight, exactly like
// a Vitals heal. Three steps, in order:
//
//   1. Health consumables (kit → potion → food) below the vitals thresholds:
//      in combat HealAt, else TopOffHP (the SAME options vitals.js reads, as
//      VtOptions cells); strict `<`, 0 disables the axis.
//   2. Dispel (G:26-27): a harmful (not beneficial) self enchantment of level
//      ≥ 7 in data/harmful_families.json → UseObject(a dispel item: the
//      Consumables "Dispel" entries, else data/dispel_items.json wcids, else
//      its nameRegex — critic G4) when UseDispelItems; else, when
//      CastDispelSelf and the row is Life magic of level ≤ 7, cast Eradicate
//      Life Magic Self (3194, DAT SelfTargeted) TARGETED at ourselves via
//      host.CastSelf (C6), after a Magic-mode entry like vitals.js (caster
//      wielded, ChangeCombatMode(8) ≤ 1 per 3 s, give-up valve). Confirmed by
//      the enchantment disappearing; 2 tries per enchantment instance.
//   3. Mana then stamina consumables (kit → potion / kit → potion → food).
//   4. Alchemical grenades (C5): while combat holds a lock and ≥
//      GrenadeMinMonsters scanned monsters are within RingRange →
//      UseItemOnTarget(grenade, lock). GrenadeMinMonsters 0 = off (default:
//      UNVERIFIED on ACE until live check L-C2).
//
// Kits are applied to self (UseItemOnTarget(kit, self)); food and potions are
// UseObject. Every item action claims the item token "vtsupplies" (C8); the
// dispel cast claims the cast token "vtsupplies". A shared-cooldown item
// (SharedCooldown 280 with its cooldown row in the registry) is skipped.
// MinimumHealKitSuccessChance is honoured as an ESTIMATE (ACE Healer
// DoSkillCheck: (Healing + kit boost) × trainedMod vs missing × 2 × combatMod,
// SkillCheck.GetSkillChance) — unknown skill or vital ⇒ allowed.
//
// Give-up valve (the heal_reflex.js / vitals.js pattern, re-implemented — the
// dark rynth/ai/heal_reflex.js is NOT imported, I-24/I-30): 6 uses in a row on
// one axis without the vital improving by 0.5 % park that axis for 60 s.
//
// Holds in portal space (V-12); never throws (C9); no timers (C4).

import { casterWielded, castRefusalClass } from "../../buff_loop.js";
import {
  OWNERS,
  VITAL,
  SKILL,
  PROP,
  IT,
  makeLogger,
  errText,
  opt,
  optBool,
  optNum,
  call,
  playerGuid,
  inPortal,
  busyCount,
  combatMode,
  inventoryOf,
  objInt,
  playerStats,
  vitalPercents,
  vitalRow,
  skillOf,
  selfEnchantments,
  sharedCooldownActive,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  itemTokenMine,
  hasItemToken,
  castTokenBusy,
  loopOf,
  scanTargets,
  consumableEntries,
  resolveOwned,
  isContainerRow,
  supportData,
} from "./consumables.js";

const OWNER = OWNERS.supplies;

export const SUPPLIES_TUNING = Object.freeze({
  USE_INTERVAL_MS: 1000, // min gap between two supplies actions
  PIN_MAX_MS: 4000, // an unresolved item use pins the slot at most this long
  CAST_PIN_MAX_MS: 6000,
  NO_PROGRESS_LIMIT: 6,
  MIN_PROGRESS_PCT: 0.5,
  GIVE_UP_PARK_MS: 60_000,
  ITEM_FAIL_PARK_MS: 30_000,
  ENCH_CACHE_MS: 1000,
  DISPEL_RETRY_MS: 5000,
  DISPEL_MAX_TRIES: 2,
  MAGIC_MODE_INTERVAL_MS: 3000,
  MAGIC_MODE_ATTEMPT_LIMIT: 5,
  MAGIC_MODE_PARK_MS: 15_000,
  CAST_INTERVAL_MS: 400,
  COMPONENTS_PARK_MS: 60_000,
  UNKNOWN_SPELL_PARK_MS: 600_000,
  MANA_PARK_MS: 10_000,
  KNOWN_REFRESH_MS: 30_000,
  KNOWN_EMPTY_REFRESH_MS: 2000,
  GRENADE_INTERVAL_MS: 3000,
});
const T = SUPPLIES_TUNING;

// Axis order: health, then (dispel), then mana, then stamina (vitals.js / C#
// CheckVitals order HP → Mana → Stamina).
const AXES = Object.freeze([
  Object.freeze({ axis: "hp", vital: VITAL.HEALTH, combatKey: "HealAt", combatDflt: 60, idleKey: "TopOffHP", idleDflt: 95,
    types: Object.freeze(["HealthKit", "HealthPotion", "HealthFood"]) }),
  Object.freeze({ axis: "mana", vital: VITAL.MANA, combatKey: "GetManaAt", combatDflt: 40, idleKey: "TopOffMana", idleDflt: 95,
    types: Object.freeze(["ManaKit", "ManaPotion"]) }),
  Object.freeze({ axis: "stam", vital: VITAL.STAMINA, combatKey: "RestamAt", combatDflt: 30, idleKey: "TopOffStam", idleDflt: 95,
    types: Object.freeze(["StaminaKit", "StaminaPotion", "StaminaFood"]) }),
]);
export const VITAL_CONSUMABLE_TYPES = Object.freeze(AXES.flatMap((a) => a.types));
const VITAL_TYPE_SET = new Set(VITAL_CONSUMABLE_TYPES);

/** ACE SkillCheck.GetSkillChance (factor 0.03). */
export function skillChance(skill, difficulty) {
  const c = 1 - 1 / (1 + Math.exp(0.03 * (skill - difficulty)));
  return Math.min(1, Math.max(0, c));
}

/**
 * Estimated success chance (0..1) of a healing/stamina/mana kit on self, or
 * null when unknown (ACE Healer.DoSkillCheck): effective = round((Healing +
 * BoostValue) × (specialized 1.5 | 1.1)); difficulty = round(missing × 2 ×
 * (peace 1.0 | combat 1.1)).
 */
export function estimateKitChance(host, stats, kitGuid, vitalId) {
  const sk = skillOf(stats, SKILL.HEALING);
  const v = vitalRow(stats, vitalId);
  if (!sk || !v) return null;
  const missing = Math.max(0, v.max - v.current);
  const boost = objInt(host, kitGuid, PROP.BOOST_VALUE) ?? 0;
  const trainedMod = sk.training >= 3 ? 1.5 : 1.1;
  const mode = combatMode(host);
  const combatMod = mode != null && mode !== 1 ? 1.1 : 1.0;
  const eff = Math.round((sk.current + boost) * trainedMod);
  const diff = Math.round(missing * 2 * combatMod);
  return skillChance(eff, diff);
}

export function createSupplies(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null, consumables = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "supplies", now);

  const st = {
    inFlight: null, // { kind, guid?, axis?, type?, at, seq, instKey? }
    lastActionAt: -Infinity,
    lastAction: null,
    uses: 0,
    casts: 0,
    noProgress: { hp: 0, stam: 0, mana: 0 },
    lastPct: { hp: -1, stam: -1, mana: -1 },
    parkedUntil: { hp: 0, stam: 0, mana: 0 },
    itemParkUntil: new Map(), // guid -> ts
    dispelTries: new Map(), // instKey -> { tries, lastAt }
    dispelled: 0,
    castBlock: null, // { reason, until }
    magicParkUntil: 0,
    magicAttempts: 0,
    modeAt: -Infinity,
    lastCastAt: -Infinity,
    lastGrenadeAt: -Infinity,
    known: null,
    knownAt: -Infinity,
    ench: null,
    enchAt: -Infinity,
    sigSeq: 0,
    lastUseDoneSeq: 0,
    lastFail: null, // { seq, code, text }
    plan: null, // { at, plan }
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(subscribe("useDone", () => { st.lastUseDoneSeq = ++st.sigSeq; }));
      unsubs.push(subscribe("useFailed", (sig) => {
        st.lastFail = { seq: ++st.sigSeq, code: Number(sig && sig.code) >>> 0, text: String((sig && sig.text) || "") };
        onRefusal(st.lastFail);
      }));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function combat() {
    return loopOf(bot, "combat");
  }
  function entries() {
    return consumableEntries(consumables);
  }

  function useDispelItems() {
    return optBool(options, "UseDispelItems", false);
  }
  function castDispelSelf() {
    return optBool(options, "CastDispelSelf", false);
  }
  function grenadeMin() {
    return Math.max(0, Math.round(optNum(options, "GrenadeMinMonsters", 0)));
  }

  function enabled() {
    if (st.disposed) return false;
    if (useDispelItems() || castDispelSelf()) return true;
    const list = entries();
    if (list.some((e) => VITAL_TYPE_SET.has(e.type))) return true;
    return grenadeMin() > 0 && list.some((e) => e.type === "Grenade");
  }

  function enchantments(t) {
    if (!st.ench || t - st.enchAt >= T.ENCH_CACHE_MS || t < st.enchAt) {
      st.ench = selfEnchantments(host);
      st.enchAt = t;
    }
    return st.ench;
  }

  function known(id, t) {
    const age = st.known && st.known.size > 0 ? T.KNOWN_REFRESH_MS : T.KNOWN_EMPTY_REFRESH_MS;
    if (!st.known || t - st.knownAt > age || t < st.knownAt) {
      const v = call(host, "TryGetKnownSpells");
      st.known = new Set((Array.isArray(v) ? v : []).map((x) => Number(x) >>> 0));
      st.knownAt = t;
    }
    return st.known.has(id >>> 0);
  }

  function itemParked(guid, t) {
    const u = st.itemParkUntil.get(guid >>> 0);
    return u != null && t < u;
  }

  // A kind-13 refusal while our action is unresolved. Cast-refusal codes belong
  // to a cast (ours, or vitals' — vitals still runs before this slot), every
  // other code to an item use; each is attributed only to the matching kind.
  function onRefusal(fail) {
    const f = st.inFlight;
    if (!f) return;
    const t = now();
    const cls = castRefusalClass(fail.code);
    if (f.kind === "cast") {
      if (cls === "components") st.castBlock = { reason: "components", until: t + T.COMPONENTS_PARK_MS };
      else if (cls === "unknown-spell") st.castBlock = { reason: "unknown-spell", until: t + T.UNKNOWN_SPELL_PARK_MS };
      else if (cls === "mana") st.castBlock = { reason: "mana", until: t + T.MANA_PARK_MS };
      if (cls && cls !== "fizzle") log(`dispel cast refused (${cls})`);
    } else if (f.guid && !cls) {
      st.itemParkUntil.set(f.guid, t + T.ITEM_FAIL_PARK_MS);
      log(`use of ${f.guid} refused (code ${fail.code}); parked ${T.ITEM_FAIL_PARK_MS / 1000}s`);
    }
  }

  // ── in-flight resolution ────────────────────────────────────────────────
  function resolve(t) {
    const f = st.inFlight;
    if (!f) return;
    let done = false;
    if (st.lastFail && st.lastFail.seq > f.seq) done = true;
    else if (st.lastUseDoneSeq > f.seq) done = true;
    else if (f.kind === "cast") {
      if (t - f.at > T.CAST_PIN_MAX_MS) done = true;
      else if (host && typeof host.tryClaimCast === "function" && !castTokenBusy(host, t)) done = true;
    } else {
      if (t - f.at > T.PIN_MAX_MS) done = true;
      else if (hasItemToken(host) && !itemTokenMine(host, OWNER)) done = true;
    }
    if (done) {
      if (f.kind !== "cast") releaseItem(host, OWNER);
      st.inFlight = null;
    }
  }

  function pinned() {
    if (!st.inFlight) return false;
    resolve(now());
    return !!st.inFlight;
  }

  // ── decisions ───────────────────────────────────────────────────────────
  function inCombatOf(ctx) {
    if (ctx && typeof ctx.inCombat === "boolean") return ctx.inCombat;
    const c = combat();
    if (!c) return false;
    return (Number(c.locked) >>> 0) !== 0 || scanTargets(c).length > 0;
  }

  function axisThreshold(ax, inCombat) {
    return inCombat ? optNum(options, ax.combatKey, ax.combatDflt) : optNum(options, ax.idleKey, ax.idleDflt);
  }

  // Pick a vital consumable for one axis, or null. Resets the axis valve when
  // the vital is no longer below its threshold (a new incident starts fresh).
  function decideAxis(ax, ctx, t, stats, pcts, list, inv, rows) {
    const pct = pcts[ax.axis];
    if (pct === undefined) return null;
    const thr = axisThreshold(ax, inCombatOf(ctx));
    if (!(thr > 0) || !(pct < thr)) {
      st.noProgress[ax.axis] = 0;
      st.lastPct[ax.axis] = -1;
      return null;
    }
    if (st.parkedUntil[ax.axis] > t) return null;
    const minKit = optNum(options, "MinimumHealKitSuccessChance", 0);
    for (const type of ax.types) {
      for (const e of list) {
        if (e.type !== type) continue;
        const g = resolveOwned(host, e, inv);
        if (!g || itemParked(g, t)) continue;
        if (sharedCooldownActive(host, g, rows)) continue;
        const isKit = type.endsWith("Kit");
        if (isKit && minKit > 0) {
          const ch = estimateKitChance(host, stats, g, ax.vital);
          if (ch != null && ch * 100 < minKit) continue;
        }
        return { kind: "use", guid: g, axis: ax.axis, type, onSelf: isKit, pct, name: e.name };
      }
    }
    return null;
  }

  function harmfulTable() {
    const d = supportData("harmful_families");
    if (!d || !Array.isArray(d.categories)) return null;
    return d;
  }

  function rowLevelOk(r, minLevel) {
    const lv = Number(r.level) || 0;
    if (lv > 0) return lv >= minLevel;
    // No DAT record: the scarab power of level 7 is 325 (level 6: 275).
    return (Number(r.powerLevel) || 0) >= 300;
  }

  function instKey(r) {
    return `${Number(r.spellId) >>> 0}:${Number(r.layer) | 0}:${Number(r.casterGuid) >>> 0}`;
  }

  function findDispelItem(list, inv, rows, t) {
    for (const e of list) {
      if (e.type !== "Dispel") continue;
      const g = resolveOwned(host, e, inv);
      if (g && !itemParked(g, t) && !sharedCooldownActive(host, g, rows)) return g;
    }
    const data = supportData("dispel_items");
    if (!data) return 0;
    const usable = (r) =>
      r && !(Number(r.equipMask) >>> 0) && !((Number(r.itemType) >>> 0) & IT.WRITABLE) && !isContainerRow(r) &&
      !itemParked(Number(r.guid) >>> 0, t) && !sharedCooldownActive(host, Number(r.guid) >>> 0, rows);
    const wcids = new Set(Array.isArray(data.wcids) ? data.wcids.map((x) => Number(x) >>> 0) : []);
    for (const r of inv) if (usable(r) && wcids.has(Number(r.wcid) >>> 0)) return Number(r.guid) >>> 0;
    let re = null;
    try {
      re = typeof data.nameRegex === "string" && data.nameRegex ? new RegExp(data.nameRegex, "i") : null;
    } catch (_) {
      re = null;
    }
    if (re) for (const r of inv) if (usable(r) && re.test(String(r.name ?? ""))) return Number(r.guid) >>> 0;
    return 0;
  }

  function decideDispel(t, list, inv) {
    const items = useDispelItems();
    const cast = castDispelSelf();
    if (!items && !cast) return null;
    const table = harmfulTable();
    if (!table) return null; // data not loaded yet — feature not ready
    const rows = enchantments(t);
    if (!rows) return null;
    const cats = new Set(table.categories.map((x) => Number(x) >>> 0));
    const life = new Set((Array.isArray(table.lifeCategories) ? table.lifeCategories : []).map((x) => Number(x) >>> 0));
    const minLevel = Number(table.minLevel) || 7;
    const maxPower = Number(table.castDispelMaxPower) || 350;
    const spellId = Number(table.castDispelSpellId) >>> 0 || 3194;
    const harmful = rows.filter(
      (r) => r && !r.isBeneficial && !r.isCooldown && !r.permanent && cats.has(Number(r.family) >>> 0) && rowLevelOk(r, minLevel)
    );
    // Confirmation: an instance we tried that is gone was dispelled.
    const present = new Set(harmful.map(instKey));
    for (const [k, v] of st.dispelTries) {
      if (!present.has(k)) {
        if (v.tries > 0) {
          st.dispelled++;
          log(`dispelled ${k.split(":")[0]} after ${v.tries} attempt(s)`);
        }
        st.dispelTries.delete(k);
      }
    }
    if (!harmful.length) return null;
    const open = harmful.filter((r) => {
      const b = st.dispelTries.get(instKey(r));
      return !b || (b.tries < T.DISPEL_MAX_TRIES && t - b.lastAt >= T.DISPEL_RETRY_MS);
    });
    if (!open.length) return null;
    if (items) {
      const g = findDispelItem(list, inv, rows, t);
      if (g) return { kind: "dispelItem", guid: g, keys: open.map(instKey) };
    }
    if (cast) {
      const r = open.find((x) => life.has(Number(x.family) >>> 0) && !((Number(x.powerLevel) || 0) > maxPower));
      if (!r) return null;
      if (st.castBlock && st.castBlock.until > t) return null;
      if (!known(spellId, t)) return null;
      const mode = combatMode(host);
      if (mode !== 8) {
        if (t < st.magicParkUntil) return null;
        if (casterWielded(host) === false) {
          st.castBlock = { reason: "no-caster", until: t + T.MAGIC_MODE_PARK_MS };
          log("no caster (wand/orb/staff) wielded — Cast dispel self needs Magic mode; holding");
          return null;
        }
        return t - st.modeAt >= T.MAGIC_MODE_INTERVAL_MS ? { kind: "magic" } : { kind: "wait" };
      }
      st.magicAttempts = 0;
      if (t - st.lastCastAt < T.CAST_INTERVAL_MS) return null;
      if (castTokenBusy(host, t)) return null;
      return { kind: "cast", spellId, keys: [instKey(r)] };
    }
    return null;
  }

  function decideGrenade(t, list, inv) {
    const min = grenadeMin();
    if (!(min > 0)) return null;
    const c = combat();
    const target = c ? Number(c.locked) >>> 0 : 0;
    if (!target) return null;
    if (t - st.lastGrenadeAt < T.GRENADE_INTERVAL_MS) return null;
    const ring = optNum(options, "RingRange", 5);
    const n = scanTargets(c).filter((s) => s && Number(s.dist) <= ring).length;
    if (n < min) return null;
    for (const e of list) {
      if (e.type !== "Grenade") continue;
      const g = resolveOwned(host, e, inv);
      if (g && !itemParked(g, t)) return { kind: "grenade", guid: g, target, name: e.name };
    }
    return null;
  }

  function decide(ctx, t) {
    if (inPortal(host)) return null;
    resolve(t);
    if (st.inFlight) return null;
    if (!playerGuid(host)) return null;
    const list = entries();
    const inv = inventoryOf(host);
    const itemsFree = !itemTokenHeldByOther(host, OWNER) && busyCount(host) === 0 && !castTokenBusy(host, t);
    const paced = t - st.lastActionAt >= T.USE_INTERVAL_MS;
    const needVitals = list.some((e) => VITAL_TYPE_SET.has(e.type));
    let stats = null;
    let pcts = {};
    let rows = null;
    if (needVitals) {
      stats = playerStats(host);
      pcts = vitalPercents(stats);
      rows = enchantments(t);
    }
    const tryAxis = (ax) => (needVitals && itemsFree && paced ? decideAxis(ax, ctx, t, stats, pcts, list, inv, rows) : null);

    let p = tryAxis(AXES[0]);
    if (p) return p;
    const d = decideDispel(t, list, inv);
    if (d) {
      if (d.kind === "dispelItem") {
        if (itemsFree && paced) return d;
      } else if (d.kind === "cast") {
        if (busyCount(host) === 0) return d;
      } else return d; // magic / wait
    }
    p = tryAxis(AXES[1]) || tryAxis(AXES[2]);
    if (p) return p;
    if (itemsFree && paced) return decideGrenade(t, list, inv);
    return null;
  }

  function cachedPlan(ctx, t) {
    if (st.plan && t >= st.plan.at && t - st.plan.at <= 50) return st.plan.plan; // same kernel tick
    const plan = decide(ctx, t);
    st.plan = { at: t, plan };
    return plan;
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function trackProgress(axis, pct, t) {
    const last = st.lastPct[axis];
    if (last >= 0 && pct <= last + T.MIN_PROGRESS_PCT) {
      st.noProgress[axis] += 1;
      if (st.noProgress[axis] >= T.NO_PROGRESS_LIMIT) {
        st.parkedUntil[axis] = t + T.GIVE_UP_PARK_MS;
        st.noProgress[axis] = 0;
        log(`give up ${axis} consumables — no progress after ${T.NO_PROGRESS_LIMIT} uses; parked ${T.GIVE_UP_PARK_MS / 1000}s`);
      }
    } else {
      st.noProgress[axis] = 0;
    }
    st.lastPct[axis] = pct;
  }

  function useItem(plan, t) {
    if (!claimItem(host, OWNER)) return false;
    let sent = false;
    if (plan.kind === "grenade") sent = call(host, "UseItemOnTarget", plan.guid, plan.target) === true;
    else if (plan.onSelf) sent = call(host, "UseItemOnTarget", plan.guid, playerGuid(host)) === true;
    else sent = call(host, "UseObject", plan.guid) === true;
    if (!sent) {
      releaseItem(host, OWNER);
      return false;
    }
    st.inFlight = { kind: plan.kind, guid: plan.guid, axis: plan.axis || null, type: plan.type || null, at: t, seq: st.sigSeq };
    st.lastActionAt = t;
    st.uses++;
    return true;
  }

  function act(plan, t) {
    switch (plan.kind) {
      case "use": {
        if (!useItem(plan, t)) return;
        trackProgress(plan.axis, plan.pct, t);
        st.lastAction = { kind: "use", type: plan.type, guid: plan.guid, at: t };
        log(`${plan.type} ${plan.name || plan.guid} (${plan.axis} ${Math.round(plan.pct)}%)`);
        return;
      }
      case "dispelItem": {
        if (!useItem(plan, t)) return;
        for (const k of plan.keys) {
          const b = st.dispelTries.get(k) || { tries: 0, lastAt: -Infinity };
          b.tries++;
          b.lastAt = t;
          st.dispelTries.set(k, b);
        }
        st.lastAction = { kind: "dispelItem", guid: plan.guid, at: t };
        log(`dispel item ${plan.guid} for ${plan.keys.length} harmful enchantment(s)`);
        return;
      }
      case "grenade": {
        if (!useItem(plan, t)) return;
        st.lastGrenadeAt = t;
        st.lastAction = { kind: "grenade", guid: plan.guid, target: plan.target, at: t };
        return;
      }
      case "magic": {
        call(host, "ChangeCombatMode", 8);
        st.modeAt = t;
        st.magicAttempts++;
        if (st.magicAttempts > T.MAGIC_MODE_ATTEMPT_LIMIT) {
          st.magicParkUntil = t + T.MAGIC_MODE_PARK_MS;
          st.magicAttempts = 0;
          log(`give up entering Magic mode after ${T.MAGIC_MODE_ATTEMPT_LIMIT} attempts — parked ${T.MAGIC_MODE_PARK_MS / 1000}s`);
        }
        return;
      }
      case "cast": {
        if (typeof host?.tryClaimCast === "function" && host.tryClaimCast(OWNER) !== true) return;
        const sent = call(host, "CastSelf", plan.spellId) === true;
        if (!sent) {
          call(host, "releaseCast", OWNER);
          return;
        }
        st.inFlight = { kind: "cast", at: t, seq: st.sigSeq, spellId: plan.spellId };
        st.lastCastAt = t;
        st.lastActionAt = t;
        st.casts++;
        for (const k of plan.keys) {
          const b = st.dispelTries.get(k) || { tries: 0, lastAt: -Infinity };
          b.tries++;
          b.lastAt = t;
          st.dispelTries.set(k, b);
        }
        st.lastAction = { kind: "cast", spellId: plan.spellId, at: t };
        log(`cast dispel self ${plan.spellId}`);
        return;
      }
      default:
        return; // "wait": hold the tick while the mode change lands
    }
  }

  const slot = {
    name: "Supplies",
    rank: "afterVitals",
    keepsCombatLoop: true,
    enabled: () => {
      try {
        return enabled();
      } catch (_) {
        return false;
      }
    },
    pinned: () => {
      try {
        return pinned();
      } catch (_) {
        return false;
      }
    },
    wants: (ctx) => {
      try {
        if (!enabled()) return false;
        const t = now();
        if (pinned()) return true;
        return !!cachedPlan(ctx, t);
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: (ctx) => {
      try {
        const t = now();
        resolve(t);
        if (st.inFlight) return; // waiting for the server's answer
        const plan = cachedPlan(ctx, t);
        st.plan = null;
        if (plan) act(plan, t);
      } catch (e) {
        log(`tick threw: ${errText(e)}`);
      }
    },
    onLeave: () => {},
    get status() {
      return status();
    },
  };

  function status() {
    const t = now();
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      inFlight: st.inFlight ? { kind: st.inFlight.kind, guid: st.inFlight.guid || 0, at: st.inFlight.at } : null,
      lastAction: st.lastAction,
      uses: st.uses,
      casts: st.casts,
      dispelled: st.dispelled,
      parkedAxes: Object.keys(st.parkedUntil).filter((a) => st.parkedUntil[a] > t),
      castBlocked: st.castBlock && st.castBlock.until > t ? st.castBlock.reason : null,
      dispelPending: st.dispelTries.size,
    };
  }

  function dispose() {
    st.disposed = true;
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  return { slot, status, dispose, _state: st };
}

export default createSupplies;
