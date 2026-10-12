// rynth/vt/support/mana_stones.js — mana stones / mana charges as a background
// reflex (PLAN W1-9 SUP, §3.11, §2.6 C4, §2.1 O16 "M. Charges when off").
// Port of CS/ManaStoneManager.cs (U7a §5.6) with the web hard guard (U4 H5).
//
// Two actions, one in flight at a time, think every 600 ms:
//   1. DRAIN (EnableManaTapping; never while operator-held): an EMPTY stone
//      on an unequipped, non-caster inventory item holding ≥
//      ManaTankMinimumMana mana. ACE destroys the drained item and charges the
//      stone (ManaStone.cs HandleActionUseOnTarget).
//   2. REFILL (RefillWornMana or EnableManaTapping): when a worn item's mana
//      is below RefillWornManaItemManaPercent % of its max, the most-charged
//      stone (a "mana charge" is a pre-charged stone) on the PLAYER — ACE
//      pours it into every equipped item that needs mana.
// C# gives the drain priority (it wins over refilling, MSM:TryBeginAction);
// kept.
//
// HARD GUARD (U4 H5, V-13) — checkStoneUse() gates EVERY use: a stone is used
// on the player only when it is known CHARGED (appraised, or charged by our
// own drain); a stone is used on an item only when it is known EMPTY and the
// item is in the inventory, NOT equipped and NOT a caster — so an empty stone
// can never destroy worn gear, and a charged stone is never wasted on loot.
// An unappraised stone is never used (it is appraised first).
//
// Item mana is not pushed by ACE (U4 §7.2): the reflex re-appraises (RequestId)
// at most 3 items per 30 s — worn items whose mana is stale first, then
// unappraised stones, then unappraised drain candidates — and extrapolates a
// worn item's mana with its ManaRate between appraisals.
//
// Gate (U7a port): (running || ManaChargesWhenOff) && (EnableManaTapping ||
// RefillWornMana). While operator-held (`info.held`) and ManaChargesWhenOff
// only the REFILL runs (no draining, no movement, no casting — V-7). Otherwise
// it acts only while the kernel is Idle/Navigate, loot is in SCAN, nothing is
// busy, no container is open and the item token is free (§3.3 postTick gate,
// re-checked here; critic B4). Item token owner "vtmana" (C8).

import { castRefusalClass } from "../../buff_loop.js";
import {
  OWNERS,
  IT,
  PROP,
  makeLogger,
  errText,
  optBool,
  optNum,
  call,
  playerGuid,
  inPortal,
  busyCount,
  inventoryOf,
  objBool,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  loopOf,
  consumableEntries,
  isWandLike,
  isContainerRow,
  lc,
} from "./consumables.js";

const OWNER = OWNERS.mana;

export const MANA_TUNING = Object.freeze({
  THINK_INTERVAL_MS: 600,
  ACTION_TIMEOUT_MS: 8000,
  STONE_USE_ON_PLAYER_COOLDOWN_MS: 5 * 60_000,
  TAP_TARGET_COOLDOWN_MS: 5 * 60_000,
  STONE_TAP_COOLDOWN_MS: 30_000,
  REFILL_HOLD_MS: 60_000, // after "You have no items equipped that need mana."
  APPRAISE_BUDGET: 3,
  APPRAISE_WINDOW_MS: 30_000,
  APPRAISE_SAME_GUID_MS: 60_000,
});
const T = MANA_TUNING;
const MAGIC_ITEM_TYPES = IT.MELEE | IT.ARMOR | IT.CLOTHING | IT.JEWELRY | IT.MISSILE;

/**
 * The hard guard (U4 H5). stoneState ∈ "charged" | "empty" | "unknown".
 * → { ok: true } | { ok: false, reason }.
 */
export function checkStoneUse({ stoneState, targetGuid, playerGuid: me, targetRow }) {
  const tg = Number(targetGuid) >>> 0;
  if (!tg) return { ok: false, reason: "no target" };
  if (me && tg === me >>> 0) {
    return stoneState === "charged" ? { ok: true } : { ok: false, reason: "stone not known charged" };
  }
  if (!targetRow) return { ok: false, reason: "target not in the inventory" };
  if (Number(targetRow.equipMask) >>> 0) return { ok: false, reason: "target is equipped" };
  if (isWandLike(targetRow)) return { ok: false, reason: "target is a caster" };
  if (stoneState !== "empty") return { ok: false, reason: "stone not known empty" };
  return { ok: true };
}

export function createManaStones(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null, consumables = null, items = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "mana", now);

  const st = {
    state: "idle", // idle | tapping | usingOnPlayer
    stone: 0,
    item: 0,
    issuedAt: 0,
    lastThinkAt: -Infinity,
    useOnPlayerCooldown: new Map(),
    tapTargetCooldown: new Map(),
    stoneTapCooldown: new Map(),
    book: new Map(), // stone guid -> { state, at } (our own drains/refills; superseded by a newer appraisal)
    refillHoldUntil: 0,
    appraiseAt: [], // request timestamps (budget window)
    appraisedGuid: new Map(), // guid -> last request ts
    drains: 0,
    refills: 0,
    lastAction: null,
    lastRefusal: null,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(subscribe("chat", (sig) => onChat(String((sig && sig.text) || ""))));
      unsubs.push(subscribe("useFailed", (sig) => onFailed(sig)));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function tapping() {
    return optBool(options, "EnableManaTapping", false);
  }
  function refilling() {
    return optBool(options, "RefillWornMana", false) || tapping();
  }
  function enabled() {
    return !st.disposed && (tapping() || optBool(options, "RefillWornMana", false));
  }

  function goIdle() {
    st.state = "idle";
    st.issuedAt = 0;
    releaseItem(host, OWNER);
  }
  function reset() {
    if (st.state !== "idle") releaseItem(host, OWNER);
    st.state = "idle";
    st.stone = 0;
    st.item = 0;
    st.issuedAt = 0;
  }

  function onChat(text) {
    if (!text || st.state === "idle") return;
    const t = now();
    if (st.state === "tapping") {
      if (text.includes("The Mana Stone drains") || text.includes("is destroyed") || text.includes("has been destroyed")) {
        if (st.stone) st.book.set(st.stone, { state: "charged", at: t });
        st.drains++;
        goIdle();
        return;
      }
      if (text.includes("is already full of mana") && st.stone) {
        // The "empty" stone is really charged (stale appraisal).
        st.book.set(st.stone, { state: "charged", at: t });
        st.stoneTapCooldown.delete(st.stone);
        log(`stone ${st.stone} is actually charged (server: already full)`);
        goIdle();
      }
      return;
    }
    if (st.state === "usingOnPlayer") {
      if (text.includes("The Mana Stone gives") || text.includes("The Mana Stone is destroyed")) {
        // ACE empties the stone after the pour (ItemCurMana = null) or destroys it.
        if (st.stone) st.book.set(st.stone, { state: "empty", at: t });
        st.refills++;
        reset();
        return;
      }
      if (text.includes("no items equipped that need mana")) {
        st.refillHoldUntil = t + T.REFILL_HOLD_MS; // our mana estimate is off — re-appraise first
        for (const g of wornGuids()) st.appraisedGuid.delete(g);
        reset();
      }
    }
  }

  // A kind-13 refusal answers our stone use — unless it is a cast-refusal code
  // (a spell someone else cast; item uses never produce those).
  function onFailed(sig) {
    if (st.state === "idle") return;
    const code = Number(sig && sig.code) >>> 0;
    if (castRefusalClass(code)) return;
    const t = now();
    st.lastRefusal = { code, at: t };
    if (st.state === "tapping") {
      if (st.stone) st.stoneTapCooldown.set(st.stone, t + T.STONE_TAP_COOLDOWN_MS);
      if (st.item) st.tapTargetCooldown.set(st.item, t + T.TAP_TARGET_COOLDOWN_MS);
    } else if (st.stone) {
      st.useOnPlayerCooldown.set(st.stone, t + T.STONE_USE_ON_PLAYER_COOLDOWN_MS);
    }
    reset();
  }

  // ── reads ───────────────────────────────────────────────────────────────
  function mana(g) {
    const m = call(host, "TryGetItemMana", g >>> 0);
    return m && typeof m === "object" ? m : null;
  }
  function appraised(g, m) {
    return m != null || call(host, "HasAppraisalData", g >>> 0) === true;
  }
  function lastIdOf(g, m) {
    const v = m && Number(m.lastIdMs) > 0 ? Number(m.lastIdMs) : Number(call(host, "GetLastIdTime", g >>> 0)) || 0;
    return v;
  }

  /** "charged" | "empty" | "unknown" for a stone. */
  function stoneState(g) {
    const m = mana(g);
    const b = st.book.get(g);
    if (b && !(lastIdOf(g, m) > b.at)) return b.state;
    if (!appraised(g, m)) return "unknown";
    return m && Number(m.cur) > 0 ? "charged" : "empty";
  }

  function itemsTabGuids() {
    const out = new Set();
    try {
      if (items && typeof items.list === "function") {
        for (const e of items.list() || []) {
          const g = Number(e && e.guid) >>> 0;
          if (g) out.add(g);
          if (typeof items.resolveGuid === "function") {
            const r = Number(items.resolveGuid(e)) >>> 0;
            if (r) out.add(r);
          }
        }
      }
    } catch (_) {
      /* no Items tab */
    }
    return out;
  }

  function stoneRows(inv) {
    const explicit = consumableEntries(consumables).filter((e) => e.type === "ManaStone" || e.type === "ManaCharge");
    const unequipped = inv.filter((r) => !(Number(r.equipMask) >>> 0));
    if (explicit.length) {
      return unequipped.filter((r) =>
        explicit.some((e) => {
          const g = Number(e.guid) >>> 0;
          if (g && (Number(r.guid) >>> 0) === g) return true;
          const w = Number(e.wcid) >>> 0;
          return lc(e.name) && lc(e.name) === lc(r.name) && (!w || w === (Number(r.wcid) >>> 0));
        })
      );
    }
    return unequipped.filter((r) => {
      const it = Number(r.itemType) >>> 0;
      if (it) return (it & IT.MANA_STONE) !== 0;
      return /\bmana (stone|charge)\b/i.test(String(r.name ?? ""));
    });
  }

  function wornGuids() {
    return inventoryOf(host)
      .filter((r) => Number(r.equipMask) >>> 0)
      .map((r) => Number(r.guid) >>> 0);
  }

  function wornNeedsMana(inv, t) {
    const pct = Math.min(100, Math.max(1, optNum(options, "RefillWornManaItemManaPercent", 25)));
    for (const r of inv) {
      if (!(Number(r.equipMask) >>> 0)) continue;
      const m = mana(r.guid);
      if (!m || !(Number(m.max) > 0) || m.cur == null) continue;
      let est = Number(m.cur);
      const rate = Number(m.ratePerSec) || 0;
      const lastId = Number(m.lastIdMs) || 0;
      if (rate > 0 && lastId > 0 && t > lastId) est -= (rate * (t - lastId)) / 1000;
      if (est < (Number(m.max) * pct) / 100) return true;
    }
    return false;
  }

  function cooled(map, g, t) {
    const u = map.get(g);
    return u != null && t < u;
  }

  function findEmptyStone(stones, t) {
    for (const r of stones) {
      const g = Number(r.guid) >>> 0;
      if (cooled(st.stoneTapCooldown, g, t)) continue;
      if (stoneState(g) === "empty") return g;
    }
    return 0;
  }

  function findChargedStone(stones, t) {
    let best = 0;
    let bestMana = -1;
    for (const r of stones) {
      const g = Number(r.guid) >>> 0;
      if (cooled(st.useOnPlayerCooldown, g, t)) continue;
      if (stoneState(g) !== "charged") continue;
      const m = mana(g);
      const cur = m && Number(m.cur) > 0 ? Number(m.cur) : 1;
      if (cur > bestMana) {
        bestMana = cur;
        best = g;
      }
    }
    return best;
  }

  function findTapTarget(inv, stones, t) {
    const min = Math.max(1, optNum(options, "ManaTankMinimumMana", 2500));
    const stoneSet = new Set(stones.map((r) => Number(r.guid) >>> 0));
    const tab = itemsTabGuids();
    const listed = new Set(consumableEntries(consumables).map((e) => e.guid));
    let best = 0;
    let bestMana = -1;
    for (const r of inv) {
      const g = Number(r.guid) >>> 0;
      if (!g || stoneSet.has(g) || tab.has(g) || listed.has(g)) continue;
      if (Number(r.equipMask) >>> 0) continue;
      if ((Number(r.itemType) >>> 0) & IT.MANA_STONE) continue;
      if (isContainerRow(r) || isWandLike(r)) continue;
      if ((Number(r.attuned) || 0) !== 0 || (Number(r.bonded) || 0) > 0) continue; // quest / bonded gear is never destroyed
      if (cooled(st.tapTargetCooldown, g, t)) continue;
      if (objBool(host, g, PROP.BOOL_RETAINED) === true) continue; // ACE refuses Retained items
      const m = mana(g);
      if (!m || !(Number(m.cur) >= min)) continue;
      if (Number(m.cur) > bestMana) {
        bestMana = Number(m.cur);
        best = g;
      }
    }
    return best;
  }

  // ── re-appraisal budget ─────────────────────────────────────────────────
  function appraiseStep(inv, stones, t, { held }) {
    st.appraiseAt = st.appraiseAt.filter((x) => t - x < T.APPRAISE_WINDOW_MS && x <= t);
    if (st.appraiseAt.length >= T.APPRAISE_BUDGET) return;
    if (typeof host?.RequestId !== "function") return;
    const recent = (g) => {
      const a = st.appraisedGuid.get(g);
      return a != null && t - a < T.APPRAISE_SAME_GUID_MS && a <= t;
    };
    const want = [];
    if (refilling()) {
      const worn = inv
        .filter((r) => Number(r.equipMask) >>> 0)
        .map((r) => ({ g: Number(r.guid) >>> 0, m: mana(r.guid) }))
        .filter(({ g, m }) => (!appraised(g, m) ? true : !!(m && Number(m.max) > 0 && m.stale)))
        .sort((a, b) => lastIdOf(a.g, a.m) - lastIdOf(b.g, b.m));
      for (const w of worn) want.push(w.g);
    }
    for (const r of stones) if (stoneState(Number(r.guid) >>> 0) === "unknown") want.push(Number(r.guid) >>> 0);
    if (tapping() && !held) {
      const stoneSet = new Set(stones.map((r) => Number(r.guid) >>> 0));
      for (const r of inv) {
        const g = Number(r.guid) >>> 0;
        if (!g || stoneSet.has(g) || Number(r.equipMask) >>> 0) continue;
        if (!((Number(r.itemType) >>> 0) & MAGIC_ITEM_TYPES) || isWandLike(r)) continue;
        if (!appraised(g, mana(g))) want.push(g);
      }
    }
    for (const g of want) {
      if (st.appraiseAt.length >= T.APPRAISE_BUDGET) break;
      if (!g || recent(g)) continue;
      if (call(host, "RequestId", g) === false) continue;
      st.appraisedGuid.set(g, t);
      st.appraiseAt.push(t);
      if (st.appraisedGuid.size > 512) {
        for (const [k, a] of st.appraisedGuid) if (t - a >= T.APPRAISE_SAME_GUID_MS) st.appraisedGuid.delete(k);
      }
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function issue(stone, target, kind, inv, t) {
    const me = playerGuid(host);
    const row = inv.find((r) => (Number(r.guid) >>> 0) === target) || null;
    const verdict = checkStoneUse({ stoneState: stoneState(stone), targetGuid: target, playerGuid: me, targetRow: row });
    if (!verdict.ok) {
      log(`refused stone ${stone} -> ${target}: ${verdict.reason}`);
      return false;
    }
    if (!claimItem(host, OWNER)) return false;
    const sent = call(host, "UseItemOnTarget", stone, target) === true;
    if (!sent) {
      releaseItem(host, OWNER);
      return false;
    }
    st.state = kind;
    st.stone = stone;
    st.item = kind === "tapping" ? target : 0;
    st.issuedAt = t;
    st.lastAction = { kind, stone, target, at: t };
    log(kind === "tapping" ? `draining ${target} with stone ${stone}` : `using charged stone ${stone} on the player`);
    return true;
  }

  function completion(inv, t) {
    if (st.state === "idle") return;
    const has = (g) => !!g && inv.some((r) => (Number(r.guid) >>> 0) === g);
    if (st.state === "tapping" && (!has(st.item) || !has(st.stone))) {
      if (has(st.stone)) st.book.set(st.stone, { state: "charged", at: t });
      st.drains++;
      goIdle();
      return;
    }
    if (st.state === "usingOnPlayer" && !has(st.stone)) {
      st.refills++;
      reset();
      return;
    }
    if (t - st.issuedAt > T.ACTION_TIMEOUT_MS) {
      log(`action timeout in ${st.state} (stone ${st.stone}, item ${st.item})`);
      if (st.state === "usingOnPlayer" && st.stone) st.useOnPlayerCooldown.set(st.stone, t + T.STONE_USE_ON_PLAYER_COOLDOWN_MS);
      if (st.state === "tapping") {
        if (st.stone) st.stoneTapCooldown.set(st.stone, t + T.STONE_TAP_COOLDOWN_MS);
        if (st.item) st.tapTargetCooldown.set(st.item, t + T.TAP_TARGET_COOLDOWN_MS);
      }
      reset();
    }
  }

  function tick(nowMs, info = {}) {
    try {
      if (st.disposed) return;
      const t = Number.isFinite(nowMs) ? nowMs : now();
      if (!enabled()) {
        reset();
        return;
      }
      const held = !!(info && info.held);
      if (held && !optBool(options, "ManaChargesWhenOff", false)) {
        reset();
        return;
      }
      const inv = inventoryOf(host);
      completion(inv, t);
      if (st.state !== "idle") return;
      if (inPortal(host)) return;
      if (!held) {
        const action = info && info.kernelAction;
        if (action != null && action !== "Idle" && action !== "Navigate") return;
        const loot = loopOf(bot, "loot");
        if (loot && loot.enabled !== false && loot.state != null && loot.state !== "SCAN") return;
      }
      if ((Number(call(host, "GetGroundContainerId")) >>> 0) !== 0) return;
      if (busyCount(host) !== 0) return;
      if (itemTokenHeldByOther(host, OWNER)) return;
      if (t - st.lastThinkAt < T.THINK_INTERVAL_MS && t >= st.lastThinkAt) return;
      st.lastThinkAt = t;
      if (!playerGuid(host)) return;

      const stones = stoneRows(inv);
      appraiseStep(inv, stones, t, { held });

      // Priority 1: drain (never while held).
      if (!held && tapping()) {
        const stone = findEmptyStone(stones, t);
        const target = stone ? findTapTarget(inv, stones, t) : 0;
        if (stone && target && issue(stone, target, "tapping", inv, t)) return;
      }
      // Priority 2: refill worn gear.
      if (refilling() && t >= st.refillHoldUntil && wornNeedsMana(inv, t)) {
        const stone = findChargedStone(stones, t);
        if (stone) issue(stone, playerGuid(host), "usingOnPlayer", inv, t);
      }
    } catch (e) {
      log(`tick threw: ${errText(e)}`);
    }
  }

  function status() {
    return {
      enabled: enabled(),
      state: st.state,
      stone: st.stone,
      item: st.item,
      drains: st.drains,
      refills: st.refills,
      lastAction: st.lastAction,
      lastRefusal: st.lastRefusal,
    };
  }

  function dispose() {
    st.disposed = true;
    reset();
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  const reflex = { name: "ManaStones", tick, enabled };
  return { reflex, status, dispose, enabled, stoneState, _state: st };
}

export default createManaStones;
