// rynth/vt/support/doors.js — open doors on the way (and pick their locks) as
// the "Doors" kernel slot (PLAN W1-9 SUP, §3.11, §2.6 C7, G:179). Port of
// CS/DoorInteractionController.cs (U7b §10) in METRES (no ×0.9144, H15).
//
// The slot shares the nav slot's rank (`rank()` is injected — the same
// function ActiveNav uses) and is registered before "Navigate", so while it
// wants the tick navigation pauses (C#: "it blocks nav while active",
// RynthAiPlugin.cs:1389-1391); the kernel's onLeave on Navigate cancels our
// router leg. It starts only when navigation itself wants the tick
// (`navWants()`), OpenDoors is on and a CLOSED door is within OpenDoorRange.
//
// State machine: none → opening → checking → unlocking → retry → cooldown.
//   opening   UseObject(door); after the answer (busy 0 / UseDone / kind 13)
//             the door is open (PhysicsState Ethereal 0x4) ⇒ done, else
//             checking. Per-attempt timeout 3 s + 0.3 s/m (ACE walks a far
//             user to the door), max 3 attempts ⇒ cooldown.
//   checking  AutoUnlockDoors and a Consumables "Lockpick" in the pack ⇒
//             UseItemOnTarget(lockpick, door) (unlocking), else cooldown.
//   unlocking after the answer ⇒ retry = UseObject(door) again.
//   cooldown  5 s on the clock, then back to none; it never holds the tick
//             (navigation walks on). A door that ends in cooldown is skipped
//             for 60 s (so a locked door with no pick cannot block the route
//             forever — the C# controller re-targets it every 5 s).
// An in-progress door yields whatever a boosted nav yields to (buffing, a
// loot in flight, a gentle-mode fight-back) and whenever navWants() turns
// false: it is dropped, not failed.
// The FSM only advances while this slot holds the tick: a door the player has
// moved away from meanwhile (beyond OpenDoorRange + 2 m) is dropped, never
// re-used (ACE would walk the bot back to it).
// Opened doors are skipped for 60 s. Doors: static guids (< 0x80000000) with
// the ObjectDescriptionFlag Door bit (0x1000), else a door/gate/hatch/
// portcullis name when the desc flags are unreadable. Item token owner
// "vtdoors" (C8). Holds in portal space. Never throws.

import {
  OWNERS,
  makeLogger,
  errText,
  optBool,
  optNum,
  call,
  inPortal,
  busyCount,
  objName,
  distanceTo,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  consumableEntries,
  resolveOwned,
} from "./consumables.js";

const OWNER = OWNERS.doors;

export const DOOR_TUNING = Object.freeze({
  ATTEMPT_TIMEOUT_MS: 3000,
  ATTEMPT_TIMEOUT_PER_M_MS: 300,
  SETTLE_MS: 500,
  COOLDOWN_MS: 5000,
  OPENED_SKIP_MS: 60_000,
  FAILED_SKIP_MS: 60_000,
  MAX_ATTEMPTS: 3,
  SCAN_INTERVAL_MS: 500,
  // The FSM only advances while the slot holds the tick (C# ticks it every
  // frame). A door left behind meanwhile (a fight moved the player) is dropped
  // instead of re-used — ACE would walk the bot back to it.
  REACH_SLACK_M: 2,
});
const T = DOOR_TUNING;
const ODF_DOOR = 0x1000;
const PHYS_ETHEREAL = 0x4;
const DOOR_NAME_RE = /\b(door|gate|hatch|portcullis)\b/i;

export function createDoors(deps = {}) {
  const { host = null, options = null, subscribe = null, consumables = null } = deps;
  const rankFn = typeof deps.rank === "function" ? deps.rank : () => "beforeIdle";
  const navWants = typeof deps.navWants === "function" ? deps.navWants : () => false;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "doors", now);

  const st = {
    state: "none",
    door: 0,
    doorName: "",
    doorDist: 0,
    attempts: 0,
    actionAt: 0,
    actionSeq: 0,
    opened: new Map(), // guid -> ts
    failed: new Map(), // guid -> ts
    scanAt: -Infinity,
    scanHit: 0,
    sigSeq: 0,
    lastAnswerSeq: 0,
    opens: 0,
    unlocks: 0,
    lastAction: null,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      const answered = () => {
        st.lastAnswerSeq = ++st.sigSeq;
      };
      unsubs.push(subscribe("useDone", answered));
      unsubs.push(subscribe("useFailed", answered));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function enabled() {
    return !st.disposed && optBool(options, "OpenDoors", false);
  }

  function isDoor(g) {
    const flags = call(host, "TryGetObjectDescFlags", g);
    if (typeof flags === "number") return (flags & ODF_DOOR) !== 0;
    return DOOR_NAME_RE.test(objName(host, g));
  }
  function isOpen(g) {
    const s = call(host, "TryGetObjectState", g);
    return typeof s === "number" && (s & PHYS_ETHEREAL) !== 0;
  }
  function recent(map, g, ms, t) {
    const at = map.get(g);
    return at != null && t - at < ms && t >= at;
  }

  function nearestClosedDoor(t) {
    const range = Math.max(0.5, optNum(options, "OpenDoorRange", 5));
    const guids = call(host, "NearbyGuids");
    if (!Array.isArray(guids)) return null;
    let best = null;
    for (const g0 of guids) {
      const g = Number(g0) >>> 0;
      if (!g || g >= 0x80000000) continue; // doors are static objects
      if (recent(st.opened, g, T.OPENED_SKIP_MS, t) || recent(st.failed, g, T.FAILED_SKIP_MS, t)) continue;
      if (!isDoor(g) || isOpen(g)) continue;
      const d = distanceTo(host, g);
      if (d == null || d > range) continue;
      if (!best || d < best.dist) best = { guid: g, dist: d };
    }
    return best;
  }

  function answered() {
    return st.lastAnswerSeq > st.actionSeq;
  }
  function settled(t) {
    return (busyCount(host) === 0 && t - st.actionAt >= T.SETTLE_MS) || answered();
  }
  function attemptTimeout() {
    return T.ATTEMPT_TIMEOUT_MS + T.ATTEMPT_TIMEOUT_PER_M_MS * Math.max(0, st.doorDist || 0);
  }
  /** Is the targeted door still within OpenDoorRange (+ slack)? Unknown = yes
   *  (the attempt limit bounds it). */
  function doorInReach() {
    const d = distanceTo(host, st.door);
    if (d == null) return true;
    return d <= Math.max(0.5, optNum(options, "OpenDoorRange", 5)) + T.REACH_SLACK_M;
  }
  /** Drop an in-progress door the player has moved away from (not marked
   *  failed: it is targeted again if the route brings us back). */
  function dropIfLeftBehind() {
    if (st.state === "none" || st.state === "cooldown" || doorInReach()) return false;
    log(`door ${st.doorName || st.door} left behind — dropped`);
    reset();
    return true;
  }

  function reset() {
    if (st.state !== "none") releaseItem(host, OWNER);
    st.state = "none";
    st.door = 0;
    st.attempts = 0;
  }
  function markOpened(t) {
    st.opened.set(st.door, t);
    st.opens++;
    log(`door ${st.doorName || st.door} open`);
    reset();
  }
  function toCooldown(t, why) {
    log(`door ${st.doorName || st.door}: ${why} — cooldown`);
    st.failed.set(st.door, t);
    releaseItem(host, OWNER);
    st.state = "cooldown";
    st.actionAt = t;
  }

  function use(t) {
    if (!claimItem(host, OWNER)) return false;
    const sent = call(host, "UseObject", st.door) === true;
    if (!sent) {
      releaseItem(host, OWNER);
      return false;
    }
    st.actionAt = t;
    st.actionSeq = st.sigSeq;
    st.lastAction = { kind: "use", door: st.door, at: t };
    return true;
  }

  function lockpick() {
    for (const e of consumableEntries(consumables)) {
      if (e.type !== "Lockpick") continue;
      const g = resolveOwned(host, e);
      if (g) return { guid: g, name: e.name };
    }
    return null;
  }

  function step(t) {
    // Prune the skip books now and then.
    if (st.opened.size > 64) for (const [g, at] of st.opened) if (t - at >= T.OPENED_SKIP_MS) st.opened.delete(g);
    if (st.failed.size > 64) for (const [g, at] of st.failed) if (t - at >= T.FAILED_SKIP_MS) st.failed.delete(g);

    if (st.state === "none") {
      const hit = nearestClosedDoor(t);
      if (!hit) return;
      st.door = hit.guid;
      st.doorDist = hit.dist;
      st.doorName = objName(host, hit.guid) || "door";
      st.attempts = 0;
      st.state = "opening";
      if (!use(t)) reset();
      else log(`opening ${st.doorName} (${hit.dist.toFixed(1)} m)`);
      return;
    }
    if (st.state === "cooldown") {
      if (t - st.actionAt >= T.COOLDOWN_MS) reset();
      return;
    }
    if (dropIfLeftBehind()) return;
    // Timeout guard for the action-waiting states.
    if ((st.state === "opening" || st.state === "unlocking" || st.state === "retry") && t - st.actionAt > attemptTimeout()) {
      if (isOpen(st.door)) return markOpened(t);
      st.attempts++;
      if (st.attempts >= T.MAX_ATTEMPTS) return toCooldown(t, `max attempts (${T.MAX_ATTEMPTS})`);
      st.state = "opening";
      if (!use(t)) toCooldown(t, "use not sent");
      return;
    }
    switch (st.state) {
      case "opening":
        if (!settled(t)) return;
        if (isOpen(st.door)) return markOpened(t);
        st.state = "checking";
        st.actionAt = t;
        return;
      case "checking": {
        if (!optBool(options, "AutoUnlockDoors", false)) return toCooldown(t, "not open and auto-unlock is off");
        const pick = lockpick();
        if (!pick) return toCooldown(t, "locked and no lockpick on the Consumables tab");
        if (!claimItem(host, OWNER)) return;
        if (call(host, "UseItemOnTarget", pick.guid, st.door) !== true) {
          releaseItem(host, OWNER);
          return toCooldown(t, "lockpick use not sent");
        }
        st.state = "unlocking";
        st.actionAt = t;
        st.actionSeq = st.sigSeq;
        st.unlocks++;
        st.lastAction = { kind: "lockpick", door: st.door, pick: pick.guid, at: t };
        log(`using ${pick.name || "lockpick"} on ${st.doorName}`);
        return;
      }
      case "unlocking":
        if (!settled(t)) return;
        st.state = "retry";
        if (!use(t)) toCooldown(t, "use not sent");
        return;
      case "retry":
        if (!settled(t)) return;
        if (isOpen(st.door)) return markOpened(t);
        st.attempts++;
        if (st.attempts >= T.MAX_ATTEMPTS) return toCooldown(t, "max attempts after unlock");
        st.state = "opening";
        if (!use(t)) toCooldown(t, "use not sent");
        return;
      default:
        reset();
    }
  }

  /** Why a boosted nav would decline this tick (ActiveNav._wants' rules,
   *  D39 / D8): buffing, a loot already in flight, or a gentle-mode
   *  fight-back (the after-kill corpse included). null = nav keeps the tick.
   *  Unboosted (beforeIdle) the ladder already ranks all of those first. */
  function boostYield(ctx) {
    let rank = "beforeIdle";
    try {
      rank = rankFn();
    } catch (_) {
      rank = "beforeIdle";
    }
    if (rank === "beforeIdle") return null;
    const c = ctx || {};
    if (c.buffPinned || c.buffNeeded) return "buffing";
    if (c.lootPinned) return "a loot in progress";
    if (rank === "beforeCombat" && c.underAttack && (c.threat || c.corpse)) return "a fight-back";
    return null;
  }

  function wants(ctx) {
    if (!enabled()) return false;
    if (inPortal(host)) return false;
    const t = now();
    // The cooldown runs on the clock and never holds the tick: the failed
    // door is already skipped for 60 s, so navigation walks on (logic-3).
    if (st.state === "cooldown") {
      if (t - st.actionAt < T.COOLDOWN_MS && t >= st.actionAt) return false;
      reset();
    }
    const navOk = () => {
      try {
        return navWants(ctx) === true;
      } catch (_) {
        return false;
      }
    };
    if (st.state !== "none" && !dropIfLeftBehind()) {
      // An in-progress door shares the boosted nav rank, but never holds it
      // past what nav itself yields to: drop it (not marked failed; it is
      // re-targeted when nav wants the tick again) and let the ladder run.
      // navWants() also carries the composition root's own nav declines (a
      // due Consumables BuffItem).
      const why = boostYield(ctx) || (navOk() ? null : "navigation stepping aside");
      if (!why) return true;
      log(`door ${st.doorName || st.door} dropped — yielding to ${why}`);
      reset();
      return false;
    }
    if (!navOk()) return false;
    if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER)) return false;
    if (t - st.scanAt < T.SCAN_INTERVAL_MS && t >= st.scanAt) return st.scanHit !== 0;
    st.scanAt = t;
    const hit = nearestClosedDoor(t);
    st.scanHit = hit ? hit.guid : 0;
    return !!hit;
  }

  const slot = {
    name: "Doors",
    rank: () => {
      try {
        return rankFn();
      } catch (_) {
        return "beforeIdle";
      }
    },
    keepsCombatLoop: false,
    enabled: () => {
      try {
        return enabled();
      } catch (_) {
        return false;
      }
    },
    wants: (ctx) => {
      try {
        return wants(ctx);
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: () => {
      try {
        if (inPortal(host)) return;
        step(now());
        st.scanAt = -Infinity;
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
      state: st.state,
      door: st.door,
      attempts: st.attempts,
      opens: st.opens,
      unlocks: st.unlocks,
      lastAction: st.lastAction,
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

  return { slot, status, dispose, _state: st };
}

export default createDoors;
