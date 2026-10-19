// rynth/vt/support/scrolls.js — VTank Read Unknown Scrolls and the .utl Read
// action: the reading (2026-10-19). The loot loop decides what to take
// (rynth/loot_loop.js: a scroll of a spell we don't know that ACE would let us
// learn — canReadScroll, ACE Player_Skills.CanReadScroll; a Read rule's
// scroll under the same test) and hands each confirmed pickup over through
// loot.takeWork("read"). This "ReadScrolls" kernel slot reads them once the
// corpse is done, as VTank does (between corpses, not mid-pickup).
//
// Rank beforeIdle, registered ahead of Navigate: a read is a stance change to
// peace, the Reading motion, a second and the Ready motion (ACE
// Scroll.ActOnUse), and the slot keeps the tick until it is answered, so a
// route does not walk off mid-read. No read starts while the loot loop is at a
// corpse or about to be (loot.corpseWorkPending(): a corpse in hand, back in
// SCAN less than 1.5 s — ACE keeps us busy through the last pickup's return
// animation — or a corpse being described), so none overlaps a corpse Use.
// One scroll at a time: UseObject(scroll) under the item token "vtscrolls"
// (C8), re-judged first by canReadScroll on the current (buffed) skill.
// ACE answers with a line — "You already know that spell!", "You are not
// trained in X!" / "You are not skilled enough in X to learn this spell."
// (kept unread), or "The scroll is destroyed." (learned) — and then its
// UseDone. A busy player gets "You're too busy" as a WeenieError, which the
// client shows only as chat (kind 13 carries spell-cast codes only), and a
// plain UseDone: a UseDone with no answer line within USE_DONE_GRACE_MS means
// the read did not happen, and it is tried again after RETRY_MS. UseDones are
// counted only while this slot holds the tick (a cast's is not ours). Done when
// the spell is known, the scroll is gone or a line arrives; no answer in
// CONFIRM_MS is tried again, MAX_TRIES in all. A scroll whose spell became
// known meanwhile (another copy read), that left the pack, that we can no
// longer learn, or that waits while ReadUnknownScrolls is off is kept unread.
//
// enabled() only while scrolls wait (Z2: inert with nothing to read). Holds in
// portal space; never throws; no timers.

import { canReadScroll } from "../../loot_loop.js";
import { SCHOOL_SKILL } from "../../skill_cap.js";
import {
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
  castTokenBusy,
  loopOf,
  playerStats,
} from "./consumables.js";

const OWNER = "vtscrolls";
const NAME = "ReadScrolls";

export const SCROLL_TUNING = Object.freeze({
  CONFIRM_MS: 10_000, // stance + Reading + 1 s + Ready, with room for the server's answer
  RETRY_MS: 1500, // after a read that did not happen, a send that failed, or between two reads
  USE_DONE_GRACE_MS: 500, // a UseDone with no answer line this long after it: not read
  MAX_TRIES: 3,
  KNOWN_CACHE_MS: 1000,
});
const T = SCROLL_TUNING;
const CAT_SYSTEM = 0;

// ACE Scroll.ActOnUse's answers (Broadcast text, the System chat category).
const READ_LINES = [
  ["known", /^You already know that spell!$/],
  ["refused", /^You are not trained in .+!$/],
  ["refused", /^You are not skilled enough in .+ to learn this spell\.$/],
  ["learned", /^The scroll is destroyed\.$/],
];

/** ACE's answer to a scroll read — "known" | "refused" | "learned" — or null. */
export function parseReadLine(text) {
  if (typeof text !== "string" || !text) return null;
  const line = text.trimEnd();
  for (const [kind, re] of READ_LINES) if (re.test(line)) return kind;
  return null;
}

export function createScrolls(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "scrolls", now);

  const st = {
    queue: [], // { guid, spellId, tries }
    pending: null, // { guid, spellId, tries, at, answer, doneAt }
    nextAt: -Infinity,
    known: { at: -Infinity, set: new Set() },
    read: 0,
    kept: 0,
    failures: 0,
    lastAction: null,
    disposed: false,
  };

  // A use finished (UseDone; a UseDone with an error arrives as useFailed)
  // while our read is pending and unanswered — counted only while this slot
  // holds the tick: a cast's or a corpse's UseDone is not ours.
  function onUseFinished() {
    const p = st.pending;
    if (!p || p.answer || p.doneAt !== undefined) return;
    const k = bot && bot.kernel;
    if (k && typeof k.action === "string" && k.action !== NAME) return;
    p.doneAt = now();
  }

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(
        subscribe("chat", (sig) => {
          const p = st.pending;
          if (!p || !sig || (sig.cat != null && Number(sig.cat) >>> 0 !== CAT_SYSTEM)) return;
          const a = parseReadLine(sig.text);
          if (a) p.answer = a;
        }),
      );
      unsubs.push(subscribe("useDone", onUseFinished));
      unsubs.push(subscribe("useFailed", onUseFinished));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  // The loot loop's confirmed "read" pickups (rynth/loot_loop.js takeWork).
  function pull() {
    const loot = loopOf(bot, "loot");
    if (!loot || typeof loot.takeWork !== "function") return;
    let work = [];
    try {
      work = loot.takeWork("read") || [];
    } catch (_) {
      work = [];
    }
    for (const w of work) {
      const g = Number(w && w.guid) >>> 0;
      if (!g || (st.pending && st.pending.guid === g) || st.queue.some((q) => q.guid === g)) continue;
      st.queue.push({ guid: g, spellId: Number(w.spellId) >>> 0, tries: 0 });
    }
  }

  function enabled() {
    if (st.disposed) return false;
    pull();
    return !!st.pending || st.queue.length > 0;
  }

  function knownSet(t) {
    const c = st.known;
    if (t - c.at < T.KNOWN_CACHE_MS && t >= c.at) return c.set;
    const ids = call(host, "TryGetKnownSpells");
    st.known = { at: t, set: new Set(Array.isArray(ids) ? ids.map((x) => Number(x) >>> 0) : []) };
    return st.known.set;
  }

  function rowOf(inv, g) {
    return inv.find((r) => (Number(r.guid) >>> 0) === g && !(Number(r.equipMask) >>> 0)) || null;
  }

  function keep(q, why, name) {
    st.kept++;
    log(`kept ${name || `scroll ${q.guid}`} unread: ${why}`);
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

  // Can we still learn it (ACE's rule, on the current buffed skill)?
  function learnable(spellId) {
    const rec = call(host, "TryGetSpellRecord", spellId);
    const skillId = rec ? SCHOOL_SKILL[rec.school] : undefined;
    if (!skillId) return false;
    const skills = playerStats(host)?.skills;
    return canReadScroll(rec.power, skills ? skills[skillId] ?? skills[String(skillId)] ?? null : null);
  }

  // The next scroll to read now, or null (the gate is shut / nothing left).
  // Scrolls that are no longer worth a read are kept, and dropped here.
  function next(t) {
    if (!st.queue.length || t < st.nextAt) return null;
    if (inPortal(host) || busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER) || castTokenBusy(host, t)) return null;
    if (lootBusy() || !playerGuid(host)) return null;
    const on = optBool(options, "ReadUnknownScrolls", false);
    const inv = inventoryOf(host);
    const known = knownSet(t);
    while (st.queue.length) {
      const q = st.queue[0];
      const row = rowOf(inv, q.guid);
      const why = !on
        ? "Read Unknown Scrolls is off"
        : !row
          ? "no longer in the pack"
          : q.spellId && known.has(q.spellId)
            ? "the spell is known"
            : !q.spellId || !learnable(q.spellId)
              ? "not learnable with the skill we have now"
              : null;
      if (!why) return { q, name: String(row.name ?? "") };
      st.queue.shift();
      keep(q, why, row && row.name);
    }
    return null;
  }

  // Settle the read in flight from the answer lines and the inventory.
  function settle(t) {
    const p = st.pending;
    const row = rowOf(inventoryOf(host), p.guid);
    const learned = !!p.spellId && knownSet(t).has(p.spellId);
    let done = null;
    if (p.answer === "learned" || learned) done = "learned";
    else if (p.answer === "known") done = "known already";
    else if (p.answer === "refused") done = "refused";
    else if (!row) done = "gone";
    if (done) {
      finish(t);
      if (done === "learned" || done === "gone") {
        st.read++;
        log(`read scroll ${p.guid}${p.spellId ? ` (spell ${p.spellId})` : ""}`);
      } else keep(p, done === "refused" ? "the server refused it (skill)" : "the spell was known", row && row.name);
      return;
    }
    // Its UseDone came with no answer line: the server never read it (too busy).
    const notRead = p.doneAt !== undefined && t - p.doneAt >= T.USE_DONE_GRACE_MS;
    if (!notRead && t - p.at <= T.CONFIRM_MS) return;
    finish(t);
    if (p.tries >= T.MAX_TRIES) {
      st.failures++;
      keep(p, notRead ? "the server stayed too busy" : "no answer", row && row.name);
      return;
    }
    st.queue.unshift({ guid: p.guid, spellId: p.spellId, tries: p.tries }); // again, after RETRY_MS
  }

  function finish(t) {
    st.pending = null;
    st.nextAt = t + T.RETRY_MS;
    releaseItem(host, OWNER);
  }

  function tick() {
    try {
      if (st.disposed) return;
      const t = now();
      if (st.pending) {
        settle(t);
        return;
      }
      const n = next(t);
      if (!n) return;
      if (!claimItem(host, OWNER)) return;
      const q = n.q;
      q.tries++;
      if (call(host, "UseObject", q.guid) !== true) {
        releaseItem(host, OWNER);
        st.nextAt = t + T.RETRY_MS;
        if (q.tries >= T.MAX_TRIES) {
          st.queue.shift();
          st.failures++;
          keep(q, "the use could not be sent", n.name);
        }
        return;
      }
      st.queue.shift();
      st.pending = { guid: q.guid, spellId: q.spellId, tries: q.tries, at: t, answer: null, doneAt: undefined };
      st.lastAction = { kind: "read", guid: q.guid, at: t };
      log(`reading ${n.name || q.guid}${q.spellId ? ` (spell ${q.spellId})` : ""}`);
    } catch (e) {
      log(`tick threw: ${errText(e)}`);
    }
  }

  const slot = {
    name: NAME,
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
        if (st.pending) return true; // keep the tick until the read is answered
        return !!next(now());
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
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      queued: st.queue.length,
      pending: st.pending ? { guid: st.pending.guid, spellId: st.pending.spellId, at: st.pending.at } : null,
      read: st.read,
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

export default createScrolls;
