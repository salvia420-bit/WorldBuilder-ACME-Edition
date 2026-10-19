// rynth/vt/support/salvage.js — the .utl Salvage action and VTank Combine
// Salvage (2026-10-19; owner decision "Salvage + combine").
//
// The loot loop picks up what a Salvage rule takes and hands each confirmed
// pickup over through loot.takeWork("salvage") (rynth/loot_loop.js). This
// "Salvage" kernel slot, once the corpse is done (rank beforeIdle, registered
// ahead of Navigate), salvages them with the player's Ust — GameAction 0x027D
// CreateTinkeringTool (host.CreateTinkeringTool, retail's Salvage button) —
// and then, with CombineSalvage, combines partial bags of one material within
// the bound loot profile's workmanship bands.
//
// ACE Player_Crafting.HandleSalvaging (vanilla): the tool must be the Ust (wcid
// 20646) and ours; an item without MaterialType (int 131) or Workmanship (int
// 105), or Retained (bool 91), is skipped silently; every bag in the list is
// merged per material into NEW bags — value carried (capped at 75,000),
// MaxStructure 100 — and with salvage_handle_overages off (the default) the
// units above 100 are LOST. So a combine sends ≥ 2 partial bags (Structure,
// int 92, < 100) of ONE band of ONE material, at most 100 units and 75,000
// value in all; a salvage never sends a bag (the combine handles bags). ACE has
// no bag-on-bag combining (UseWithTarget refuses it): the Ust is the only
// path. The verdict is read off the inventory (the result, kind 52
// SalvageOperationsResult, is no VT signal): the items gone = done; still there
// after CONFIRM_MS = not salvageable, kept (bags: left alone BLOCK_MS).
//
// Bands come from the profile's SalvageCombine block (formats/utl.js:
// `defaultBands`, `materials: [{ material, bands }]`). Its parsed `enabled` is
// the block's FORMAT VERSION (line 2 of the block; line 1, parsed as
// `version`, is the block's length in chars — 277 and 11 in the two corpus
// fixtures, docs/webac-comparison-2026-10-13 rynth-formats-expr-3): it is not
// an on/off switch, CombineSalvage is. A profile without the block gets
// VTClassic's defaults: "1-6, 7-8, 9, 10", and "1-10" for the 25 materials
// every corpus block lists so (RynDQLLootProfile's). A band string is ranges
// "a-b" or "a", ',' or ';' separated; a bag joins the range holding its
// workmanship — a gap counts with the range below, past the last range is a
// band of its own, an empty string is one band (VTClassic GetRangeIndex). A
// bag's workmanship: the CreateObject's truncated average (int 105) until it
// is appraised, ItemWorkmanship / NumItemsInMaterial (105 / 170) after. No
// loot profile bound = nothing is combined.
//
// When: queued items are salvaged as soon as the slot gets the tick; a combine
// pass is due after a salvage or a combine, and after a corpse the loop took
// something from (loot.lootedCount moved). Nothing starts while the loot loop
// is at a corpse or about to be (loot.corpseWorkPending()), so no salvage
// overlaps a corpse Use. The loop never hands over what it took back from our
// own corpse. enabled() only with items queued, an action in flight, or a
// combine plan in hand (Z2: inert otherwise). Item token owner "vtsalvage"
// (C8). Holds in portal space; never throws; no timers.

import {
  makeLogger,
  errText,
  optBool,
  call,
  playerGuid,
  inPortal,
  busyCount,
  inventoryOf,
  objInt,
  objBool,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  loopOf,
} from "./consumables.js";

const OWNER = "vtsalvage";

export const SALVAGE_TUNING = Object.freeze({
  CONFIRM_MS: 8000,
  AFTER_ACTION_MS: 500,
  BLOCK_MS: 5 * 60_000, // bags a combine left untouched
  PLAN_TTL_MS: 2000, // a combine plan waiting for the tick is re-read this often
  MAX_UNITS: 100, // MaxStructure of a bag; more is lost
  MAX_VALUE: 75_000, // a bag's value cap
});
const T = SALVAGE_TUNING;

export const UST_WCID = 20646; // W_TINKERINGTOOL_CLASS
const IT_TINKERING_MATERIAL = 0x40000000;
const P_VALUE = 19;
const P_STRUCTURE = 92; // a bag's units
const P_WORKMANSHIP = 105; // ItemWorkmanship
const P_MATERIAL = 131; // MaterialType
const P_NUM_ITEMS = 170; // NumItemsInMaterial
const P_RETAINED = 91; // PropertyBool Retained

/** VTClassic's SalvageCombine defaults (a profile with no block). */
export const COMBINE_DEFAULT_BANDS = "1-6, 7-8, 9, 10";
export const COMBINE_ANY_BANDS = "1-10";
export const COMBINE_ANY_MATERIALS = Object.freeze([10, 14, 16, 17, 18, 19, 22, 25, 29, 30, 36, 37, 41, 47, 35, 27, 26, 21, 15, 13, 50, 49, 34, 52, 51]);

/** Retail TinkeringSystem::IsValidMaterialType (acclient.c:500471; the same
 *  rule as plugins/salvage-panel.js isValidSalvageMaterial). */
export function isSalvageMaterial(material) {
  const m = Number(material) >>> 0;
  return m === 1 || m === 2 || (m >= 4 && m <= 8) || (m >= 10 && m <= 55) || (m >= 57 && m <= 64) || (m >= 66 && m <= 71) || (m >= 73 && m <= 77);
}

/** A band string's ranges, in order ("1-6, 7-8, 9, 10" → [1,6] [7,8] [9,9] [10,10]); unreadable pieces are skipped. */
export function parseSalvageBands(text) {
  const out = [];
  for (const piece of String(text ?? "").split(/[,;]/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)\s*)?$/.exec(piece);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    out.push([a, Math.max(a, b)]);
  }
  return out;
}

/** The band of a workmanship: the range holding it; a gap counts with the
 *  range below (-1 below the first); past the last range is ranges.length. */
export function salvageBandIndex(ranges, workmanship) {
  const w = Number(workmanship);
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i][0] > w) return i - 1;
    if (w <= ranges[i][1]) return i;
  }
  return ranges.length;
}

/** The combine bands of a loot profile: { defaultBands, materials: Map(material → bands) }. */
export function combineBandsOf(profile) {
  const sc = profile && typeof profile === "object" ? profile.salvageCombine : null;
  if (sc && typeof sc === "object") {
    const materials = new Map();
    for (const m of Array.isArray(sc.materials) ? sc.materials : []) if (m) materials.set(Number(m.material) >>> 0, String(m.bands ?? ""));
    return { defaultBands: String(sc.defaultBands ?? ""), materials };
  }
  return { defaultBands: COMBINE_DEFAULT_BANDS, materials: new Map(COMBINE_ANY_MATERIALS.map((m) => [m, COMBINE_ANY_BANDS])) };
}

/** A salvage bag's average workmanship: the CreateObject's truncated average
 *  (int 105) until appraised, ItemWorkmanship / NumItemsInMaterial (105 / 170)
 *  after; NaN when unknown. An average below 1 means 105 is the CreateObject's
 *  average again (a re-sent object keeps the appraisal's 170): 105 itself. */
export function bagWorkmanship(itemWorkmanship, numItems) {
  const w = Number(itemWorkmanship);
  if (!Number.isFinite(w) || w <= 0) return NaN;
  const n = Number(numItems);
  if (!Number.isFinite(n) || n <= 0) return w;
  const avg = w / n;
  return avg >= 1 ? avg : w;
}

/**
 * The next combine, or null: { material, band, guids, units, value } — the
 * smallest bags of one material and one band, ≥ 2 of them, ≤ maxUnits units and
 * ≤ maxValue value in all. `bags` = [{ guid, material, units, workmanship, value? }].
 */
export function planCombine(bags, bands, { maxUnits = T.MAX_UNITS, maxValue = T.MAX_VALUE } = {}) {
  const groups = new Map();
  const rangesOf = new Map();
  for (const b of bags || []) {
    const units = Number(b && b.units);
    if (!b || !(units > 0 && units < maxUnits) || !Number.isFinite(Number(b.workmanship))) continue;
    const material = Number(b.material) >>> 0;
    if (!rangesOf.has(material)) rangesOf.set(material, parseSalvageBands(bands.materials.has(material) ? bands.materials.get(material) : bands.defaultBands));
    const band = salvageBandIndex(rangesOf.get(material), b.workmanship);
    const key = `${material}:${band}`;
    if (!groups.has(key)) groups.set(key, { material, band, bags: [] });
    groups.get(key).bags.push({ ...b, units });
  }
  const order = [...groups.values()].sort((a, b) => a.material - b.material || a.band - b.band);
  for (const g of order) {
    if (g.bags.length < 2) continue;
    g.bags.sort((a, b) => a.units - b.units || a.guid - b.guid);
    const pick = [];
    let units = 0;
    let value = 0;
    for (const b of g.bags) {
      if (units + b.units > maxUnits) break; // smallest first: no larger one fits either
      const v = Number(b.value);
      if (Number.isFinite(v) && value + v > maxValue) continue;
      pick.push(b.guid >>> 0);
      units += b.units;
      value += Number.isFinite(v) ? v : 0;
    }
    if (pick.length >= 2) return { material: g.material, band: g.band, guids: pick, units, value };
  }
  return null;
}

export function createSalvage(deps = {}) {
  const { host = null, bot = null, options = null } = deps;
  const lootProfile = typeof deps.lootProfile === "function" ? deps.lootProfile : () => null;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "salvage", now);

  const st = {
    queue: [], // item guids a Salvage rule took
    pending: null, // { kind: "salvage" | "combine", items, at }
    nextAt: -Infinity,
    combineDue: false,
    plan: null, // { at, plan }
    lootSeen: null, // loot.lootedCount last seen
    blocked: new Map(), // bag guid -> until (a combine left it untouched)
    salvaged: 0,
    combined: 0,
    kept: 0,
    failures: 0,
    lastAction: null,
    disposed: false,
  };

  // The loot loop's confirmed "salvage" pickups (rynth/loot_loop.js takeWork),
  // and its pickup count: after a corpse it took something from, a combine pass
  // is due.
  function pull() {
    const loot = loopOf(bot, "loot");
    if (!loot) return;
    if (typeof loot.takeWork === "function") {
      let work = [];
      try {
        work = loot.takeWork("salvage") || [];
      } catch (_) {
        work = [];
      }
      for (const w of work) {
        const g = Number(w && w.guid) >>> 0;
        if (g && !st.queue.includes(g)) st.queue.push(g);
      }
    }
    const n = Number(loot.lootedCount);
    if (!Number.isFinite(n)) return;
    if (st.lootSeen === null) st.lootSeen = n; // what was looted before us is not "after a corpse"
    else if (n !== st.lootSeen && (loot.state == null || loot.state === "SCAN")) {
      st.lootSeen = n;
      st.combineDue = true;
    }
  }

  function enabled() {
    if (st.disposed) return false;
    pull();
    if (st.pending || st.queue.length) return true;
    return !!combinePlan(now());
  }

  function rowOf(inv, g) {
    return inv.find((r) => (Number(r.guid) >>> 0) === g && !(Number(r.equipMask) >>> 0)) || null;
  }
  function ustOf(inv) {
    const r = inv.find((x) => (Number(x.wcid) >>> 0) === UST_WCID && !(Number(x.equipMask) >>> 0));
    return r ? Number(r.guid) >>> 0 : 0;
  }
  const isBag = (r) => ((Number(r && r.itemType) >>> 0) & IT_TINKERING_MATERIAL) !== 0;

  // Partial bags of a salvage material in the pack, with what a plan needs.
  function bagsOf(inv, t) {
    const out = [];
    for (const r of inv) {
      const g = Number(r.guid) >>> 0;
      if (!g || Number(r.equipMask) >>> 0 || !isBag(r)) continue;
      const until = st.blocked.get(g);
      if (until !== undefined) {
        if (t < until) continue;
        st.blocked.delete(g);
      }
      const material = objInt(host, g, P_MATERIAL);
      if (!isSalvageMaterial(material) || objBool(host, g, P_RETAINED) === true) continue;
      out.push({
        guid: g,
        material: material >>> 0,
        units: objInt(host, g, P_STRUCTURE) ?? NaN,
        workmanship: bagWorkmanship(objInt(host, g, P_WORKMANSHIP), objInt(host, g, P_NUM_ITEMS)),
        value: objInt(host, g, P_VALUE) ?? (Number(r.value) > 0 ? Number(r.value) : undefined),
      });
    }
    return out;
  }

  // The combine to do next, when one is due (cached PLAN_TTL_MS while it waits
  // for the tick); clears the due flag when there is none.
  function combinePlan(t) {
    if (!st.combineDue) return null;
    const profile = lootProfile();
    if (!profile || !optBool(options, "CombineSalvage", false)) {
      st.combineDue = false;
      st.plan = null;
      return null;
    }
    if (st.plan && t - st.plan.at < T.PLAN_TTL_MS && t >= st.plan.at) return st.plan.plan;
    const plan = planCombine(bagsOf(inventoryOf(host), t), combineBandsOf(profile));
    if (!plan) {
      st.combineDue = false;
      st.plan = null;
      return null;
    }
    st.plan = { at: t, plan };
    return plan;
  }

  // The loot loop is at a corpse or about to be (loot.corpseWorkPending; a
  // loop without it: not in SCAN). Looting off = never.
  function lootBusy() {
    const loot = loopOf(bot, "loot");
    if (!loot || loot.enabled === false) return false;
    if (typeof loot.corpseWorkPending === "function") {
      try {
        return loot.corpseWorkPending() === true;
      } catch (_) {
        return false;
      }
    }
    return loot.state != null && loot.state !== "SCAN";
  }

  function gateOpen(t) {
    if (t < st.nextAt) return false;
    if (inPortal(host) || busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER)) return false;
    if (lootBusy()) return false; // never overlapping a corpse Use
    return !!playerGuid(host);
  }

  // → "sent", "busy" (the item token is taken: next tick) or "failed" (the
  // host could not send it — a stale pkg without createTinkeringTool: not
  // retried).
  function send(kind, ust, items, t) {
    if (!claimItem(host, OWNER)) return "busy";
    if (call(host, "CreateTinkeringTool", ust, items) !== true) {
      releaseItem(host, OWNER);
      st.failures++;
      return "failed";
    }
    st.pending = { kind, items: items.slice(), at: t };
    st.lastAction = { kind, items: items.length, at: t };
    return "sent";
  }

  // The queued items still worth salvaging, sent with the Ust in one go.
  function salvageQueued(t, inv) {
    const ust = ustOf(inv);
    const queued = st.queue;
    st.queue = [];
    if (!ust) {
      st.kept += queued.length;
      log(`no Ust in the pack — ${queued.length} salvage item(s) kept`);
      return;
    }
    const items = [];
    for (const g of queued) {
      const r = rowOf(inv, g);
      const material = r ? objInt(host, g, P_MATERIAL) : undefined;
      const why = !r
        ? "no longer in the pack"
        : isBag(r)
          ? "a salvage bag (combined, not salvaged)"
          : !isSalvageMaterial(material)
            ? "no salvage material"
            : objBool(host, g, P_RETAINED) === true
              ? "retained"
              : !(objInt(host, g, P_WORKMANSHIP) > 0)
                ? "no workmanship"
                : null;
      if (!why) items.push(g);
      else {
        st.kept++;
        log(`kept ${(r && r.name) || g}: ${why}`);
      }
    }
    if (!items.length) return;
    const r = send("salvage", ust, items, t);
    if (r === "sent") log(`salvaging ${items.length} item(s) with the Ust`);
    else if (r === "busy") {
      st.queue = items; // tried again after a moment
      st.nextAt = t + T.AFTER_ACTION_MS;
    } else {
      st.kept += items.length;
      log(`the salvage could not be sent — ${items.length} item(s) kept`);
    }
  }

  function combine(t, inv) {
    const plan = st.plan ? st.plan.plan : null;
    st.plan = null;
    if (!plan) return;
    const ust = ustOf(inv);
    if (!ust) {
      st.combineDue = false;
      log("no Ust in the pack — salvage bags not combined");
      return;
    }
    if (!plan.guids.every((g) => rowOf(inv, g))) return; // the bags moved: planned again
    const r = send("combine", ust, plan.guids, t);
    if (r === "sent") log(`combining ${plan.guids.length} bags of material ${plan.material} (${plan.units} units)`);
    else if (r === "busy") st.nextAt = t + T.AFTER_ACTION_MS;
    else {
      st.combineDue = false;
      log("the combine could not be sent — salvage bags left as they are");
    }
  }

  // Settle the action in flight from the inventory: its items gone = done.
  function settle(t, inv) {
    const p = st.pending;
    const left = p.items.filter((g) => rowOf(inv, g));
    if (left.length && t - p.at <= T.CONFIRM_MS) return;
    st.pending = null;
    st.nextAt = t + T.AFTER_ACTION_MS;
    releaseItem(host, OWNER);
    const done = p.items.length - left.length;
    if (p.kind === "salvage") {
      st.salvaged += done;
      if (left.length) {
        st.kept += left.length;
        st.failures++;
        log(`${left.length} item(s) not salvaged — kept`);
      }
    } else if (!left.length) st.combined++;
    else {
      st.failures++;
      for (const g of left) st.blocked.set(g, t + T.BLOCK_MS);
      log(`the combine left ${left.length} bag(s) untouched — left alone ${T.BLOCK_MS / 60_000} min`);
    }
    if (done) st.combineDue = true; // new bags: another pass
  }

  function tick() {
    try {
      if (st.disposed) return;
      const t = now();
      const inv = inventoryOf(host);
      if (st.pending) {
        settle(t, inv);
        return;
      }
      if (!gateOpen(t)) return;
      if (st.queue.length) {
        salvageQueued(t, inv);
        return;
      }
      if (combinePlan(t)) combine(t, inv);
    } catch (e) {
      log(`tick threw: ${errText(e)}`);
    }
  }

  const slot = {
    name: "Salvage",
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
        if (st.pending) return true; // keep the tick until the inventory answers
        return gateOpen(now());
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick,
    onLeave: () => {},
    get status() {
      return status();
    },
  };

  function status() {
    const plan = st.plan ? st.plan.plan : null;
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      queued: st.queue.length,
      pending: st.pending ? { kind: st.pending.kind, items: st.pending.items.length, at: st.pending.at } : null,
      combineDue: st.combineDue,
      plan: plan ? { material: plan.material, band: plan.band, bags: plan.guids.length, units: plan.units } : null,
      salvaged: st.salvaged,
      combined: st.combined,
      kept: st.kept,
      failures: st.failures,
      lastAction: st.lastAction,
    };
  }

  function dispose() {
    st.disposed = true;
    if (st.pending) releaseItem(host, OWNER);
    st.pending = null;
    st.queue = [];
    st.plan = null;
  }

  return { slot, status, dispose, _state: st };
}

export default createSalvage;
