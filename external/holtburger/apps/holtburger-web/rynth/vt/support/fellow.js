// rynth/vt/support/fellow.js — "Auto Fellow Mgmt." (G:30: "Automatically
// Recruits when /t XP") as a background reflex (PLAN W1-9 SUP, §3.11, §2.1 O15,
// §2.10 K8). New behaviour — C# has the setting but no consumer (U6 §4,
// U7a §5.10).
//
// A `tell` signal whose body is "xp" (case-insensitive, trailing ! or .
// allowed), from someone else, queues a recruit request; the reflex tick
// handles it when:
//   * AutoFellowMgmt is on and the macro is running (not operator-held);
//   * we are in a fellowship (one is NEVER created — Q14) and we lead it or it
//     is open, it is not locked, it has < 9 members (ACE MaxFellows), and the
//     sender is not already a member (ACE Fellowship.cs:26, :76-110;
//     Player_Fellowship.cs:103-109);
//   * the sender has not been handled in the last 30 s.
// The tell's sender guid is dropped by the wasm (U4 row 14, MISSING-RUST C1),
// so the sender is resolved by exact name among VISIBLE players
// (host.FindNearbyByName(name, {player:true})) → host.FellowshipRecruit(guid).
// X-partial: an out-of-sight sender gets one "come closer" tell
// (host.SendTell) instead. Requests older than 15 s are dropped.

import { makeLogger, errText, optBool, call, playerGuid, lc } from "./consumables.js";

export const FELLOW_TUNING = Object.freeze({
  PER_SENDER_MS: 30_000,
  REQUEST_TTL_MS: 15_000,
  MAX_MEMBERS: 9,
});
const T = FELLOW_TUNING;
export const XP_TELL_RE = /^\s*xp[!.]*\s*$/i;
export const COME_CLOSER_TEXT = "I can't see you to recruit you into the fellowship - come closer and tell me xp again.";

export function createFellow(deps = {}) {
  const { host = null, options = null, subscribe = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "fellow", now);

  const st = {
    queue: [], // { name, at }
    lastBySender: new Map(), // lowercased name -> ts
    recruited: 0,
    closerTells: 0,
    lastAction: null,
    lastSkip: null,
    disposed: false,
  };

  function enabled() {
    return !st.disposed && optBool(options, "AutoFellowMgmt", false);
  }

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(
        subscribe("tell", (sig) => {
          try {
            if (!enabled() || !sig || sig.isSelf) return;
            const name = String(sig.name || "").trim();
            if (!name || !XP_TELL_RE.test(String(sig.text || ""))) return;
            if (st.queue.length >= 32) st.queue.shift();
            st.queue.push({ name, at: now() });
          } catch (_) {
            /* a bad signal never breaks the bus */
          }
        })
      );
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function skip(name, why) {
    st.lastSkip = { name, why, at: now() };
    log(`not recruiting ${name}: ${why}`);
  }

  function handle(req, t) {
    const key = lc(req.name);
    const last = st.lastBySender.get(key);
    if (last != null && t - last < T.PER_SENDER_MS && t >= last) return; // rate limit (30 s per sender)
    const info = call(host, "TryGetFellowshipInfo");
    if (!info || typeof info !== "object") return skip(req.name, "not in a fellowship");
    const me = playerGuid(host);
    const members = Array.isArray(info.members) ? info.members : [];
    const leader = (Number(info.leaderGuid) >>> 0) === me && me !== 0;
    if (!leader && !info.open) return skip(req.name, "not the leader and the fellowship is closed");
    if (info.isLocked) return skip(req.name, "the fellowship is locked");
    if (members.length >= T.MAX_MEMBERS) return skip(req.name, "the fellowship is full");
    if (members.some((m) => lc(m && m.name) === key)) return skip(req.name, "already a member");
    st.lastBySender.set(key, t);
    if (st.lastBySender.size > 256) {
      for (const [k, at] of st.lastBySender) if (t - at >= T.PER_SENDER_MS) st.lastBySender.delete(k);
    }
    const hits = call(host, "FindNearbyByName", req.name, { player: true, exact: true });
    const target = Array.isArray(hits) && hits.length ? Number(hits[0].guid) >>> 0 : 0;
    if (target) {
      if (call(host, "FellowshipRecruit", target) === true) {
        st.recruited++;
        st.lastAction = { kind: "recruit", name: req.name, guid: target, at: t };
        log(`recruited ${req.name}`);
      }
      return;
    }
    if (call(host, "SendTell", req.name, COME_CLOSER_TEXT) === true) {
      st.closerTells++;
      st.lastAction = { kind: "comeCloser", name: req.name, at: t };
    }
  }

  function tick(nowMs, info = {}) {
    try {
      if (st.disposed) return;
      const t = Number.isFinite(nowMs) ? nowMs : now();
      if (!enabled() || (info && info.held)) {
        st.queue.length = 0; // only while running
        return;
      }
      const reqs = st.queue.splice(0);
      for (const r of reqs) {
        if (t - r.at > T.REQUEST_TTL_MS) continue;
        handle(r, t);
      }
    } catch (e) {
      log(`tick threw: ${errText(e)}`);
    }
  }

  function status() {
    return {
      enabled: enabled(),
      queued: st.queue.length,
      recruited: st.recruited,
      closerTells: st.closerTells,
      lastAction: st.lastAction,
      lastSkip: st.lastSkip,
    };
  }

  function dispose() {
    st.disposed = true;
    st.queue.length = 0;
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  const reflex = { name: "Fellow", tick, enabled };
  return { reflex, status, dispose, enabled, _state: st };
}

export default createFellow;
