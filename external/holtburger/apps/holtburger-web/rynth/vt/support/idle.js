// rynth/vt/support/idle.js — "Rebuff When Idle" (G:37) and "Peace Mode When
// Idle" (G:36) (PLAN W1-9 SUP, §3.11, §2.1 O19-O20, D29).
//
// IdleRebuff — AuxSlot "IdleRebuff", rank beforeIdle. Wants the tick when
// RebuffWhenIdle is on, EnableBuffing is on (the buff loop exists and its
// `enabled !== false`, critic G12) and `buff.needsBuff({ extraWindowS:
// IdleRebuffWindowSec })` — a desired buff has less than
// RebuffSecondsRemaining + the window left. Its tick sets
// `buff.idleRebuffWindowS` to the window for exactly ONE `buff.tick()` and then
// restores the previous value, so the B-rules (B11 batch, the 300 s threshold)
// are untouched outside that call (D29). beforeIdle means it only runs when the
// kernel would otherwise go Idle: buffs that run low are recast early "when it
// is not doing anything else" instead of mid-fight.
//
// PeaceMode — IdleHook "PeaceMode" (ticked by the kernel on every Idle tick).
// Switches to NonCombat (ChangeCombatMode(1)) when PeaceModeWhenIdle is on and
// every anti-thrash gate holds (U2 §5.8, CombatManager.cs:1741-1760):
//   mode ≠ 1; busy 0; no live cast claim; no scanned monster (not in combat);
//   ≥ 3 s continuously on Idle; ≥ 3 s since the last Magic-mode entry seen;
//   the buff loop needs nothing (`!buff.needsBuff()` — otherwise buffing would
//   flip back to Magic at once); not in portal space.
// At most one request per 500 ms and 3 per idle period, so a refused stance
// change can never loop; once in peace nothing more is sent until the next
// idle period (≤ 1 stance change per idle period, L-O4).

import { makeLogger, errText, optBool, optNum, call, busyCount, combatMode, inPortal, castTokenBusy, loopOf, scanTargets } from "./consumables.js";

export const IDLE_TUNING = Object.freeze({
  IDLE_CONTINUITY_MS: 1500, // a gap longer than this between idle ticks starts a new idle period
  MIN_IDLE_MS: 3000,
  MIN_SINCE_MAGIC_MS: 3000,
  REQUEST_INTERVAL_MS: 500,
  MAX_REQUESTS_PER_PERIOD: 3,
});
const T = IDLE_TUNING;
const MODE_PEACE = 1;
const MODE_MAGIC = 8;

/** The kernel's _buffNeeded() predicate, for buff loops without needsBuff(). */
function legacyBuffNeeded(b) {
  if (!b || b.enabled === false) return false;
  let s = null;
  try {
    s = b.status;
  } catch (_) {
    return false;
  }
  if (!s) return false;
  if (s.blocked && s.pending === 0) return false;
  return !s.ready || s.active < s.desired || s.pending !== 0;
}

export function createIdle(deps = {}) {
  const { host = null, bot = null, options = null } = deps;
  const buffLoop = typeof deps.buff === "function" ? deps.buff : () => loopOf(bot, "buff");
  const combatLoop = typeof deps.combat === "function" ? deps.combat : () => loopOf(bot, "combat");
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "idle", now);

  const st = {
    rebuffTicks: 0,
    lastRebuffAt: null,
    idleSince: null,
    lastIdleTickAt: -Infinity,
    lastMode: null,
    lastMagicAt: -Infinity,
    lastRequestAt: -Infinity,
    requestsThisPeriod: 0,
    peaceRequests: 0,
    lastPeaceAt: null,
    lastBlock: null,
    disposed: false,
  };

  function buff() {
    try {
      return buffLoop();
    } catch (_) {
      return null;
    }
  }
  function combat() {
    try {
      return combatLoop();
    } catch (_) {
      return null;
    }
  }

  function windowS() {
    return Math.max(0, optNum(options, "IdleRebuffWindowSec", 600));
  }

  // ── IdleRebuff slot ─────────────────────────────────────────────────────
  function rebuffEnabled() {
    if (st.disposed || !optBool(options, "RebuffWhenIdle", false)) return false;
    const b = buff();
    return !!b && b.enabled !== false;
  }
  function rebuffWants() {
    if (!rebuffEnabled() || inPortal(host)) return false;
    const w = windowS();
    if (!(w > 0)) return false;
    const b = buff();
    if (!b || typeof b.needsBuff !== "function") return false;
    try {
      return b.needsBuff({ extraWindowS: w }) === true;
    } catch (_) {
      return false;
    }
  }
  function rebuffTick() {
    const b = buff();
    if (!b || typeof b.tick !== "function") return;
    const prev = b.idleRebuffWindowS;
    b.idleRebuffWindowS = windowS();
    try {
      b.tick();
    } catch (e) {
      log(`buff tick threw: ${errText(e)}`);
    } finally {
      b.idleRebuffWindowS = typeof prev === "number" && Number.isFinite(prev) ? prev : 0;
    }
    st.rebuffTicks++;
    st.lastRebuffAt = now();
  }

  const rebuffSlot = {
    name: "IdleRebuff",
    rank: "beforeIdle",
    keepsCombatLoop: false,
    enabled: () => {
      try {
        return rebuffEnabled();
      } catch (_) {
        return false;
      }
    },
    wants: () => {
      try {
        return rebuffWants();
      } catch (_) {
        return false;
      }
    },
    tick: () => {
      try {
        rebuffTick();
      } catch (e) {
        log(`tick threw: ${errText(e)}`);
      }
    },
    onLeave: () => {},
    get status() {
      return { ticks: st.rebuffTicks, lastAt: st.lastRebuffAt, windowS: windowS() };
    },
  };

  // ── PeaceMode idle hook ─────────────────────────────────────────────────
  function peaceEnabled() {
    return !st.disposed && optBool(options, "PeaceModeWhenIdle", false);
  }

  function buffNeeded() {
    const b = buff();
    if (!b || b.enabled === false) return false;
    if (typeof b.needsBuff === "function") {
      try {
        return b.needsBuff() === true;
      } catch (_) {
        return true; // can't tell ⇒ don't fight the buff loop
      }
    }
    return legacyBuffNeeded(b);
  }

  function block(why) {
    st.lastBlock = why;
    return false;
  }

  function peaceTick(ctx) {
    const t = now();
    // Idle-period continuity: the kernel ticks idle hooks only while Idle.
    if (st.idleSince == null || t - st.lastIdleTickAt > T.IDLE_CONTINUITY_MS || t < st.lastIdleTickAt) {
      st.idleSince = t;
      st.requestsThisPeriod = 0;
      st.lastMode = null; // Magic seen at the start of a period counts as an entry
    }
    st.lastIdleTickAt = t;
    const mode = combatMode(host);
    if (mode === MODE_MAGIC && st.lastMode !== MODE_MAGIC) st.lastMagicAt = t;
    st.lastMode = mode;
    if (mode == null || mode === MODE_PEACE) return block(mode == null ? "mode unknown" : "already peace");
    if (t - st.idleSince < T.MIN_IDLE_MS) return block("idle < 3 s");
    if (t - st.lastMagicAt < T.MIN_SINCE_MAGIC_MS) return block("magic entry < 3 s ago");
    if (inPortal(host)) return block("portal space");
    if (busyCount(host) !== 0) return block("busy");
    if (castTokenBusy(host, t)) return block("cast in flight");
    if (ctx && ctx.inCombat === true) return block("in combat");
    if (scanTargets(combat()).length > 0) return block("monsters in range");
    if (buffNeeded()) return block("buffs pending");
    if (t - st.lastRequestAt < T.REQUEST_INTERVAL_MS && t >= st.lastRequestAt) return block("request cooldown");
    if (st.requestsThisPeriod >= T.MAX_REQUESTS_PER_PERIOD) return block("request cap this idle period");
    st.lastRequestAt = t;
    st.requestsThisPeriod++;
    if (call(host, "ChangeCombatMode", MODE_PEACE) === true) {
      st.peaceRequests++;
      st.lastPeaceAt = t;
      st.lastBlock = null;
      log("idle — switching to peace mode");
      return true;
    }
    return block("send failed");
  }

  const peaceHook = {
    name: "PeaceMode",
    enabled: () => {
      try {
        return peaceEnabled();
      } catch (_) {
        return false;
      }
    },
    tick: (ctx) => {
      try {
        if (!peaceEnabled()) return;
        peaceTick(ctx);
      } catch (e) {
        log(`peace tick threw: ${errText(e)}`);
      }
    },
  };

  function status() {
    return {
      rebuff: { enabled: rebuffSlot.enabled(), ticks: st.rebuffTicks, lastAt: st.lastRebuffAt, windowS: windowS() },
      peace: { enabled: peaceHook.enabled(), requests: st.peaceRequests, lastAt: st.lastPeaceAt, lastBlock: st.lastBlock },
    };
  }

  function dispose() {
    st.disposed = true;
  }

  return { rebuffSlot, peaceHook, status, dispose, _state: st };
}

export default createIdle;
