// rynth/vt/support/buff_items.js — Consumables-tab buff items (beers, food
// that cast a buff — G:173-181) as the "BuffItems" kernel slot (PLAN W1-9 SUP,
// §3.11, §2.6 C1-C2).
//
// Rank beforeIdle: when nothing else (combat, loot, buffing, nav) wants the
// tick, a configured "BuffItem" entry is used (UseObject) when one of its
// spells' families has ≤ RebuffSecondsRemaining left (or is missing) on the
// player AND no castable self spell covers that family — i.e. the buff loop
// is not maintaining a known spell of that family (or the buff loop is held:
// no caster, no components …). Honours the item's shared cooldown (VTank
// food/potion timers). Confirmation is the enchantment registry: after a use,
// every low family must read above the threshold within 10 s; two failed
// confirmations park the item for 5 min.
//
// Items that last less than max(300, RebuffSecondsRemaining) seconds are
// rejected when added (ConsumablesModel.validateBuffItem, G:181) and skipped
// here (they would be reused at once).
//
// enabled() = a BuffItem entry exists && EnableBuffing (bot.buff?.enabled !==
// false, critic G12). Item token owner "vtbuffitems" (C8). Holds in portal
// space. Never throws.

import {
  OWNERS,
  makeLogger,
  errText,
  optNum,
  call,
  playerGuid,
  inPortal,
  busyCount,
  inventoryOf,
  selfEnchantments,
  sharedCooldownActive,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  castTokenBusy,
  loopOf,
  consumableEntries,
  resolveOwned,
} from "./consumables.js";

const OWNER = OWNERS.buffItems;

export const BUFF_ITEM_TUNING = Object.freeze({
  CONFIRM_MS: 10_000,
  USE_INTERVAL_MS: 2000,
  FAILS_TO_PARK: 2,
  PARK_MS: 5 * 60_000,
  ENCH_CACHE_MS: 1000,
});
const T = BUFF_ITEM_TUNING;

export function createBuffItems(deps = {}) {
  const { host = null, bot = null, options = null, consumables = null } = deps;
  // Without an injected getter, read bot.buff (as idle.js does and as
  // createSupport documents) — never "no buff loop", which would skip the
  // EnableBuffing gate (critic G12) for a caller that only passed `bot`.
  const buffLoop = typeof deps.buff === "function" ? deps.buff : () => loopOf(bot, "buff");
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "buffitems", now);

  const st = {
    pending: null, // { guid, families: number[], at, name }
    lastUseAt: -Infinity,
    fails: new Map(), // guid -> count
    parkedUntil: new Map(), // guid -> ts
    ench: null,
    enchAt: -Infinity,
    famCache: new Map(), // spellId -> category
    uses: 0,
    confirmed: 0,
    lastAction: null,
    plan: null,
    disposed: false,
  };

  function buff() {
    try {
      return buffLoop();
    } catch (_) {
      return null;
    }
  }

  function entries() {
    return consumableEntries(consumables).filter((e) => e.type === "BuffItem");
  }

  function enabled() {
    if (st.disposed) return false;
    const b = buff();
    if (b && b.enabled === false) return false;
    return entries().length > 0;
  }

  function threshold() {
    return Math.max(30, optNum(options, "RebuffSecondsRemaining", 300));
  }

  function familyOf(id) {
    const k = Number(id) >>> 0;
    if (st.famCache.has(k)) return st.famCache.get(k);
    const rec = call(host, "TryGetSpellRecord", k);
    const fam = rec && Number(rec.category) > 0 ? Number(rec.category) >>> 0 : null;
    if (rec) st.famCache.set(k, fam); // a miss may become a hit once the DAT table loads
    return fam;
  }
  function durationOf(entry) {
    if (entry.durationS != null) return Number(entry.durationS);
    let best = null;
    for (const id of entry.spellIds || []) {
      const rec = call(host, "TryGetSpellRecord", id);
      const d = rec ? Number(rec.duration) : NaN;
      if (Number.isFinite(d) && d > 0) best = best == null ? d : Math.max(best, d);
    }
    return best;
  }

  function enchantments(t) {
    if (!st.ench || t - st.enchAt >= T.ENCH_CACHE_MS || t < st.enchAt) {
      st.ench = selfEnchantments(host);
      st.enchAt = t;
    }
    return st.ench;
  }

  /** Remaining seconds of a beneficial family on self (0 = absent). */
  function remaining(rows, fam) {
    let best = 0;
    for (const r of rows || []) {
      if (!r || r.isCooldown || !r.isBeneficial || (Number(r.family) >>> 0) !== fam) continue;
      const left = r.permanent ? Infinity : Number(r.remainingS) || 0;
      if (left > best) best = left;
    }
    return best;
  }

  /** Does the buff loop maintain a castable spell of this family? */
  function coveredByBuffLoop(fam, t) {
    const b = buff();
    if (!b || b.enabled === false) return false;
    let blocked = null;
    try {
      blocked = b.status ? b.status.blocked : null;
    } catch (_) {
      blocked = null;
    }
    if (blocked) return false; // a held buff loop (no caster, components …) covers nothing
    const desired = Array.isArray(b.desired) ? b.desired : [];
    for (const id of desired) {
      if (familyOf(id) !== fam) continue;
      let parked = false;
      try {
        parked = typeof b._isParked === "function" ? b._isParked(id, t) === true : false;
      } catch (_) {
        parked = false;
      }
      if (!parked) return true;
    }
    return false;
  }

  function confirm(t) {
    const p = st.pending;
    if (!p) return;
    const rows = enchantments(t);
    const thr = threshold();
    if (rows && p.families.every((f) => remaining(rows, f) > thr)) {
      st.confirmed++;
      st.fails.delete(p.guid);
      st.pending = null;
      releaseItem(host, OWNER);
      log(`${p.name || p.guid} confirmed`);
      return;
    }
    if (t - p.at > T.CONFIRM_MS) {
      const n = (st.fails.get(p.guid) || 0) + 1;
      st.fails.set(p.guid, n);
      if (n >= T.FAILS_TO_PARK) {
        st.parkedUntil.set(p.guid, t + T.PARK_MS);
        st.fails.delete(p.guid);
        log(`${p.name || p.guid}: buff never showed — parked ${T.PARK_MS / 60_000} min`);
      }
      st.pending = null;
      releaseItem(host, OWNER);
    }
  }

  function decide(t) {
    if (inPortal(host)) return null;
    confirm(t);
    if (st.pending) return null;
    if (t - st.lastUseAt < T.USE_INTERVAL_MS && t >= st.lastUseAt) return null;
    if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER) || castTokenBusy(host, t)) return null;
    if (!playerGuid(host)) return null;
    const rows = enchantments(t);
    if (!rows) return null;
    const inv = inventoryOf(host);
    const thr = threshold();
    const floor = Math.max(300, thr);
    for (const e of entries()) {
      const g = resolveOwned(host, e, inv);
      if (!g) continue;
      const pu = st.parkedUntil.get(g);
      if (pu != null && t < pu) continue;
      const d = durationOf(e);
      if (d != null && d < floor) continue; // under the rebuff floor: would be reused at once (G:181)
      if (sharedCooldownActive(host, g, rows)) continue;
      const fams = [...new Set((e.spellIds || []).map(familyOf).filter((f) => f != null))];
      if (!fams.length) continue;
      const low = fams.filter((f) => remaining(rows, f) <= thr && !coveredByBuffLoop(f, t));
      if (low.length) return { guid: g, families: low, name: e.name };
    }
    return null;
  }

  function cachedPlan(t) {
    if (st.plan && t >= st.plan.at && t - st.plan.at <= 50) return st.plan.plan; // same kernel tick
    const plan = decide(t);
    st.plan = { at: t, plan };
    return plan;
  }

  const slot = {
    name: "BuffItems",
    rank: "beforeIdle",
    keepsCombatLoop: false,
    enabled: () => {
      try {
        return enabled();
      } catch (_) {
        return false;
      }
    },
    wants: () => {
      try {
        if (!enabled()) return false;
        return !!cachedPlan(now());
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: () => {
      try {
        const t = now();
        const plan = cachedPlan(t);
        st.plan = null;
        if (!plan) return;
        if (!claimItem(host, OWNER)) return;
        if (call(host, "UseObject", plan.guid) !== true) {
          releaseItem(host, OWNER);
          return;
        }
        st.pending = { guid: plan.guid, families: plan.families, at: t, name: plan.name };
        st.lastUseAt = t;
        st.uses++;
        st.lastAction = { kind: "use", guid: plan.guid, at: t };
        log(`using ${plan.name || plan.guid} (families ${plan.families.join(",")})`);
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
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      pending: st.pending ? { guid: st.pending.guid, at: st.pending.at } : null,
      uses: st.uses,
      confirmed: st.confirmed,
      parked: [...st.parkedUntil.entries()].filter(([, u]) => u > now()).map(([g]) => g),
      lastAction: st.lastAction,
    };
  }

  function dispose() {
    st.disposed = true;
    if (st.pending) releaseItem(host, OWNER);
    st.pending = null;
  }

  return { slot, status, dispose, _state: st };
}

export default createBuffItems;
