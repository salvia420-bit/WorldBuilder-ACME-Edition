// rynth/vt/support/inventory_mgr.js — Enable Autostack / Enable Autocram
// (G:24-25) and pea splitting (G:178, VTank SplitPeas) as a background reflex
// (PLAN W1-9 SUP, §3.11, §2.1 O11-O12, §2.6 C6). Port of CS/Loot/
// InventoryManager.cs (U7a §5.7).
//
// One action at a time, confirmed by the inventory snapshot; AutoCram runs
// before AutoStack (IM:96-109), then peas. Cadence: 500 ms after an action,
// 2 s when there is nothing to do.
//
//   AutoCram: an item DIRECTLY in the main pack (containerId 0, not equipped),
//     not a container/foci, not on the Items tab, moves to the side pack with
//     the MOST free slots, provided that pack has ≥ 2 free
//     (MoveItemToContainer(item, pack, 0)). Success = it left the main pack;
//     still there after 10 s = failure.
//   AutoStack: partial stacks (0 < size < max) grouped by wcid (else name);
//     the largest partial is the target, the smallest the source; amount =
//     min(src.stack, max − dst.stack) — ACE refuses a merge that overfills the
//     target (Player_Inventory.cs:3088) or exceeds the source (:2950).
//     MergeStacks(src, dst, amount). Success = the source shrank or vanished.
//   Peas (SplitPeas, PARTIALLY verifiable — peas are largely custom content):
//     a Consumables "PeaComponent" entry whose stack-aware count is below
//     keepAtLeast, with a matching pea in the pack (an item named "… pea"
//     that contains the component's name) → UseItemOnTarget(tool, pea) with
//     the entry's toolGuid, else UseObject(pea). Success = the count rose or
//     the pea was consumed.
// Failures back off per entry: 5 s × 2ⁿ, capped at 5 min, parked at the cap
// after 6 attempts; entries idle for 10 min are pruned.
//
// Runs only when not operator-held, while the kernel is Idle/Navigate, loot is
// in SCAN (or absent), nothing is busy, no container is open, the item token is
// free (critic B4: a merge/move of a fresh stack mid-loot breaks loot CONFIRM)
// and not in portal space. Item token owner "vtinv" (C8). Everything is OFF at
// the schema defaults (EnableAutostack/EnableAutocram/SplitPeas false — D3).

import {
  OWNERS,
  makeLogger,
  errText,
  optBool,
  call,
  playerGuid,
  inPortal,
  busyCount,
  inventoryOf,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  loopOf,
  consumableEntries,
  resolveOwned,
  isContainerRow,
  lc,
} from "./consumables.js";

const OWNER = OWNERS.inventory;

export const INVENTORY_TUNING = Object.freeze({
  AFTER_ACTION_MS: 500,
  IDLE_SCAN_MS: 2000,
  CONFIRM_MS: 10_000,
  BACKOFF_BASE_MS: 5000,
  BACKOFF_CAP_MS: 5 * 60_000,
  BACKOFF_PARK_ATTEMPTS: 6,
  PRUNE_EVERY_MS: 60_000,
  PRUNE_IDLE_MS: 10 * 60_000,
  CRAM_MIN_FREE: 2,
});
const T = INVENTORY_TUNING;

/** Max stack size: the property, else C#'s name fallbacks (IM:389-414); 0 = never stacks. */
export function maxStackOf(row) {
  const m = Number(row && row.maxStackSize);
  if (m > 1) return m;
  const name = String((row && row.name) ?? "");
  if (/salvage/i.test(name)) return 0;
  if (/^pyreals?$/i.test(name.trim())) return 25000;
  if (/trade note/i.test(name)) return 100;
  if (/\b(taper|scarab|prismatic)\b/i.test(name)) return 100;
  if (/\b(arrows?|bolts?|darts?|quarrels?|atlatl)\b/i.test(name)) return 250;
  if (/\b(pea|grain)s?\b/i.test(name)) return 100;
  return 0;
}

/**
 * The next AutoStack merge for an inventory, or null:
 * { src, dst, amount, key } with amount = min(src.stack, max − dst.stack).
 * `blocked(guid)` skips entries in backoff.
 */
export function planStack(inv, { blocked = () => false } = {}) {
  const groups = new Map();
  for (const r of inv || []) {
    if (!r || Number(r.equipMask) >>> 0) continue;
    const max = maxStackOf(r);
    if (!(max > 1)) continue;
    const size = Number(r.stackSize) > 0 ? Number(r.stackSize) : 1; // unreadable counts as 1 (IM:257-271)
    if (!(size > 0 && size < max)) continue;
    const key = (Number(r.wcid) >>> 0) ? `w${Number(r.wcid) >>> 0}` : `n${lc(r.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ guid: Number(r.guid) >>> 0, size, max, name: String(r.name ?? "") });
  }
  for (const [key, parts] of groups) {
    const usable = parts.filter((p) => p.guid && !blocked(p.guid));
    if (usable.length < 2) continue;
    usable.sort((a, b) => b.size - a.size || a.guid - b.guid);
    const dst = usable[0];
    const src = usable[usable.length - 1];
    const amount = Math.min(src.size, dst.max - dst.size);
    if (amount > 0) return { src: src.guid, dst: dst.guid, amount, key, name: dst.name, srcSize: src.size, dstSize: dst.size };
  }
  return null;
}

/**
 * The next AutoCram move, or null: { item, pack }. Candidates sit directly in
 * the main pack; the target is the side pack with the most free slots, ≥ 2.
 * `room` = TryGetPackRoom shape; `exclude` = Items-tab guids.
 */
export function planCram(inv, room, { exclude = new Set(), blocked = () => false, minFree = T.CRAM_MIN_FREE } = {}) {
  const packs = room && Array.isArray(room.packs) ? room.packs : [];
  let best = null;
  for (const p of packs) {
    const free = Number(p.free);
    if (!(free >= minFree)) continue;
    if (!best || free > best.free) best = { guid: Number(p.guid) >>> 0, free, name: p.name };
  }
  for (const r of inv || []) {
    const g = Number(r && r.guid) >>> 0;
    if (!g || Number(r.equipMask) >>> 0 || (Number(r.containerId) >>> 0) !== 0) continue;
    if (isContainerRow(r)) continue;
    if (/\bfoci\b/i.test(String(r.name ?? ""))) continue; // IM:155-157
    if (exclude.has(g) || blocked(g)) continue;
    if (!best) return { item: g, pack: 0, reason: "no side pack with 2+ free slots" };
    return { item: g, pack: best.guid, name: String(r.name ?? ""), packName: best.name };
  }
  return null;
}

export function createInventoryMgr(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null, consumables = null, items = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "inventory", now);

  const st = {
    pending: null, // { kind, ... , at }
    nextAt: -Infinity,
    backoff: new Map(), // key -> { n, until, lastAt }
    lastPruneAt: -Infinity,
    stacks: 0,
    crams: 0,
    peas: 0,
    failures: 0,
    lastAction: null,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      // Kind 48 (any inventory-action failure) answers our pending action at once.
      unsubs.push(
        subscribe("equip", (sig) => {
          const p = st.pending;
          if (!p || !sig || !sig.failed) return;
          const g = Number(sig.item) >>> 0;
          if (g && g !== p.src && g !== p.item && g !== p.pea && g !== p.tool) return;
          fail(p.key, now());
          st.pending = null;
          releaseItem(host, OWNER);
        })
      );
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function stackOn() {
    return optBool(options, "EnableAutostack", false);
  }
  function cramOn() {
    return optBool(options, "EnableAutocram", false);
  }
  function peaEntries() {
    return optBool(options, "SplitPeas", false) ? consumableEntries(consumables).filter((e) => e.type === "PeaComponent") : [];
  }
  function enabled() {
    return !st.disposed && (stackOn() || cramOn() || peaEntries().length > 0);
  }

  function blockedKey(key, t) {
    const b = st.backoff.get(key);
    return !!(b && t < b.until);
  }
  function fail(key, t) {
    const b = st.backoff.get(key) || { n: 0, until: 0, lastAt: t };
    b.n += 1;
    const delay = b.n >= T.BACKOFF_PARK_ATTEMPTS ? T.BACKOFF_CAP_MS : Math.min(T.BACKOFF_CAP_MS, T.BACKOFF_BASE_MS * 2 ** (b.n - 1));
    b.until = t + delay;
    b.lastAt = t;
    st.backoff.set(key, b);
    st.failures++;
    log(`${key}: no effect — retry in ${Math.round(delay / 1000)}s (attempt ${b.n})`);
  }
  function succeed(key) {
    st.backoff.delete(key);
  }
  function prune(t) {
    if (t - st.lastPruneAt < T.PRUNE_EVERY_MS && t >= st.lastPruneAt) return;
    st.lastPruneAt = t;
    for (const [k, b] of st.backoff) if (t - b.lastAt > T.PRUNE_IDLE_MS && t >= b.until) st.backoff.delete(k);
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

  function countOf(entry, inv) {
    const name = lc(entry.name);
    const wcid = Number(entry.wcid) >>> 0;
    let n = 0;
    for (const r of inv) {
      if (Number(r.equipMask) >>> 0) continue;
      const hit = wcid ? (Number(r.wcid) >>> 0) === wcid : name && lc(r.name) === name;
      if (hit) n += Number(r.stackSize) > 0 ? Number(r.stackSize) : 1;
    }
    return n;
  }

  function peaFor(entry, inv) {
    const comp = lc(entry.name).replace(/s$/, "");
    if (!comp) return 0;
    for (const r of inv) {
      if (Number(r.equipMask) >>> 0) continue;
      const nm = lc(r.name);
      if (/\bpeas?\b/.test(nm) && nm.includes(comp)) return Number(r.guid) >>> 0;
    }
    return 0;
  }

  // Confirm (or time out) the pending action from the snapshot.
  function confirm(inv, t) {
    const p = st.pending;
    if (!p) return;
    const row = (g) => inv.find((r) => (Number(r.guid) >>> 0) === g) || null;
    let ok = false;
    if (p.kind === "stack") {
      const s = row(p.src);
      ok = !s || Number(s.stackSize) < p.srcSize;
    } else if (p.kind === "cram") {
      const r = row(p.item);
      ok = !r || (Number(r.containerId) >>> 0) !== 0;
    } else if (p.kind === "pea") {
      ok = !row(p.pea) || countOf(p.entry, inv) > p.count0;
    }
    if (ok) {
      succeed(p.key);
      if (p.kind === "stack") st.stacks++;
      else if (p.kind === "cram") st.crams++;
      else st.peas++;
      st.pending = null;
      releaseItem(host, OWNER);
      st.nextAt = t + T.AFTER_ACTION_MS;
      return;
    }
    if (t - p.at > T.CONFIRM_MS) {
      fail(p.key, t);
      st.pending = null;
      releaseItem(host, OWNER);
      st.nextAt = t + T.AFTER_ACTION_MS;
    }
  }

  function start(kind, fields, sendFn, t) {
    if (!claimItem(host, OWNER)) return false;
    const sent = sendFn() === true;
    if (!sent) {
      releaseItem(host, OWNER);
      return false;
    }
    st.pending = { kind, ...fields, at: t };
    st.lastAction = { kind, ...fields, at: t };
    st.nextAt = t + T.AFTER_ACTION_MS;
    return true;
  }

  function stepCram(inv, t) {
    if (!cramOn()) return false;
    const room = call(host, "TryGetPackRoomCached") ?? call(host, "TryGetPackRoom");
    const plan = planCram(inv, room, { exclude: itemsTabGuids(), blocked: (g) => blockedKey(`cram:${g}`, t) });
    if (!plan) return false;
    if (!plan.pack) {
      log(`autocram: ${plan.reason}`);
      return false;
    }
    const key = `cram:${plan.item}`;
    if (start("cram", { item: plan.item, pack: plan.pack, key }, () => call(host, "MoveItemToContainer", plan.item, plan.pack, 0), t)) {
      log(`autocram ${plan.name || plan.item} -> ${plan.packName || plan.pack}`);
      return true;
    }
    return false;
  }

  function stepStack(inv, t) {
    if (!stackOn()) return false;
    const plan = planStack(inv, { blocked: (g) => blockedKey(`stack:${g}`, t) });
    if (!plan) return false;
    const key = `stack:${plan.src}`;
    const fields = { src: plan.src, dst: plan.dst, amount: plan.amount, srcSize: plan.srcSize, key };
    if (start("stack", fields, () => call(host, "MergeStacks", plan.src, plan.dst, plan.amount), t)) {
      log(`autostack ${plan.name}: ${plan.amount} from ${plan.src} onto ${plan.dst}`);
      return true;
    }
    return false;
  }

  function stepPeas(inv, t) {
    for (const e of peaEntries()) {
      const keep = Number(e.keepAtLeast) || 0;
      if (!(keep > 0)) continue;
      const key = `pea:${e.guid || lc(e.name)}`;
      if (blockedKey(key, t)) continue;
      const count0 = countOf(e, inv);
      if (count0 >= keep) continue;
      const pea = peaFor(e, inv);
      if (!pea) continue;
      const tool = e.toolGuid ? resolveOwned(host, { guid: e.toolGuid }, inv) : 0;
      const send = tool ? () => call(host, "UseItemOnTarget", tool, pea) : () => call(host, "UseObject", pea);
      if (start("pea", { entry: e, pea, tool, count0, key }, send, t)) {
        log(`split pea ${pea} for ${e.name} (${count0} < ${keep})`);
        return true;
      }
    }
    return false;
  }

  function tick(nowMs, info = {}) {
    try {
      if (st.disposed) return;
      const t = Number.isFinite(nowMs) ? nowMs : now();
      if (!enabled()) {
        if (st.pending) releaseItem(host, OWNER);
        st.pending = null;
        return;
      }
      if (info && info.held) return; // V-7: nothing but mana-charge refills acts while held
      const inv = inventoryOf(host);
      confirm(inv, t);
      prune(t);
      if (st.pending) return;
      if (t < st.nextAt) return;
      const action = info && info.kernelAction;
      if (action != null && action !== "Idle" && action !== "Navigate") return;
      const loot = loopOf(bot, "loot");
      if (loot && loot.enabled !== false && loot.state != null && loot.state !== "SCAN") return;
      if ((Number(call(host, "GetGroundContainerId")) >>> 0) !== 0) return;
      if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER) || inPortal(host)) return;
      if (!playerGuid(host)) return;
      if (stepCram(inv, t) || stepStack(inv, t) || stepPeas(inv, t)) return;
      st.nextAt = t + T.IDLE_SCAN_MS;
    } catch (e) {
      log(`tick threw: ${errText(e)}`);
    }
  }

  function status() {
    return {
      enabled: enabled(),
      pending: st.pending ? { kind: st.pending.kind, key: st.pending.key, at: st.pending.at } : null,
      stacks: st.stacks,
      crams: st.crams,
      peas: st.peas,
      failures: st.failures,
      backoff: st.backoff.size,
      lastAction: st.lastAction ? { kind: st.lastAction.kind, key: st.lastAction.key, at: st.lastAction.at } : null,
    };
  }

  function dispose() {
    st.disposed = true;
    if (st.pending) releaseItem(host, OWNER);
    st.pending = null;
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  const reflex = { name: "Inventory", tick, enabled };
  return { reflex, status, dispose, enabled, _state: st };
}

export default createInventoryMgr;
