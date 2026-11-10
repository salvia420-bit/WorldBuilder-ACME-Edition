// stream_bake_guard.js (2026-06-09)
//
// Per-landblock streaming-bake resilience guard. The `index.html`
// position-update handler fires `loadTerrain/Buildings/StaticsForLandblock`
// for the 3×3 ring around the player on EVERY local-player position update,
// trusting each baker's "idempotent via its *BakedLbs Set" claim. But those
// Sets only record SUCCESSFUL bakes — a bake that THROWS on a shard-fetch
// failure (a flaky cloudflared tunnel, or a ServiceWorker that intercepts
// the request and returns a body-read error) is never recorded. Without a
// guard, every subsequent position update re-launches an OVERLAPPING fetch
// for the same failing LB: unbounded in-flight promises + fetch buffers
// (→ the browser OOMs and crashes) plus a flood of SW-intercept console
// errors. This is the "terrain service worker / promises spam until the
// browser crashes" failure.
//
// `guardedStreamBake` wraps a baker call so that, per (kind, lbKey):
//   - at most ONE bake runs at a time (in-flight dedup), and
//   - after a failure the LB is on a cooldown, so a persistently-dead
//     shard retries at most once per cooldown instead of once per update.
// It resolves to `null` when the call is skipped (in-flight or cooling
// down) and on failure (after recording the cooldown). It NEVER rejects,
// so the fire-and-forget `index.html` callers can't leak unhandled
// rejections either.

// ?residencyLog (flight-experience Phase 0): bake start / done / fail events and
// cap / cooldown / in-flight skip counts. No-ops unless the flag is on.
import { rlogBake, rlogBakeSkip } from "./residency_log.js";
import { isNearPlayerLb } from "./landblock_lru.js";
import { getFlightHint } from "./residency.js";

export const STREAM_BAKE_RETRY_COOLDOWN_MS = 2500;

// Global cap on concurrently-running bakes (across all keys) when a caller
// doesn't pass `opts.maxInFlight`. The PVS-ring expansion fires ~363
// fire-and-forget guarded bakes per LB-crossing; without a global cap they all
// race at once, saturating the bake worker + network and multiplying the
// late-paint stall. The caller re-fires the ring on later ticks, so bakes
// skipped here are retried — not lost.
export const STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT = 6;

// Per-kind concurrency caps (Pass 1 streaming priority): partition capacity by
// baker kind so slow statics bakes cannot starve terrain and buildings bakes.
export const DEFAULT_KIND_CAPS = Object.freeze({
  terrain: 8,
  buildings: 6,
  statics: 6,
});
export const FLIGHT_KIND_CAPS = Object.freeze({
  terrain: 12,
  buildings: 8,
  statics: 8,
});

// Bake-wait instrumentation cap (session 7, 1114 §3): per-(kind,lbKey)
// lifecycle records kept on the state bag. Bounded so a long telepoi
// session can't grow the map unboundedly; oldest records evicted first
// (Map insertion order).
const WAIT_LOG_MAX_KEYS = 1024;

/** Create the mutable state bag a caller threads through `guardedStreamBake`. */
export function createStreamGuardState() {
  return {
    inFlight: new Set(),
    inFlightByKind: {
      terrain: new Set(),
      buildings: new Set(),
      statics: new Set(),
    },
    failUntil: new Map(),
    warnedAt: new Map(),
    // Session 7 (1114 §3, teleport fetch/bake flush groundwork): per
    // guard-key wait/lifecycle records — see _waitRec + summarizeStreamBakeWait.
    waitLog: new Map(),
    maxInFlight: STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT,
    _customMaxInFlight: false,
  };
}

let _defaultGuardState = null;
function _getDefaultGuardState() {
  if (!_defaultGuardState) _defaultGuardState = createStreamGuardState();
  return _defaultGuardState;
}

export function setStreamBakeMaxInFlight(stateOrN, maybeN) {
  if (typeof stateOrN === "object" && stateOrN !== null) {
    stateOrN.maxInFlight = Math.max(1, Number(maybeN) || STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT);
    stateOrN._customMaxInFlight = true;
    return stateOrN.maxInFlight;
  }
  const s = _getDefaultGuardState();
  s.maxInFlight = Math.max(1, Number(stateOrN) || STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT);
  s._customMaxInFlight = true;
  return s.maxInFlight;
}

export function resetStreamBakeGuard(state) {
  const s = state || _getDefaultGuardState();
  s.inFlight?.clear?.();
  if (s.inFlightByKind) {
    for (const set of Object.values(s.inFlightByKind)) {
      if (set instanceof Set) set.clear();
    }
  } else {
    s.inFlightByKind = { terrain: new Set(), buildings: new Set(), statics: new Set() };
  }
  s.failUntil?.clear?.();
  s.warnedAt?.clear?.();
  s.waitLog?.clear?.();
  s.maxInFlight = STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT;
  s._customMaxInFlight = false;
}

// Fetch-or-create the wait record for a guard key. A fresh ask AFTER a
// settled cycle starts a NEW cycle on the same record (classic-evict
// re-bake), preserving the cycle count. Fields:
//   firstAskMs/lastAskMs — request window (asks include every skipped fire)
//   asks/urgentAsks      — total fires; how many carried opts.urgent
//   skipInFlight/skipCooldown/skipCap — why fires were turned away
//   startMs/waitMs       — when a run was finally admitted; waitMs =
//                          startMs − firstAskMs (the §3 "WHERE it waits"
//                          pre-start half: guard cap / re-fire cadence)
//   inFlightAtStart      — queue depth when admitted
//   endMs/durMs/ok       — the in-run half (fetch semaphore + decode + bake)
function _waitRec(state, guardKey, kind, k, nowMs) {
  if (!(state.waitLog instanceof Map)) return null;
  let rec = state.waitLog.get(guardKey);
  if (rec && rec.endMs != null) {
    // Previous cycle settled — a new ask begins a new cycle.
    const cycles = rec.cycles + 1;
    rec = null;
    state.waitLog.delete(guardKey);
    state.waitLog.set(guardKey, (rec = _newWaitRec(kind, k, nowMs, cycles)));
    return rec;
  }
  if (!rec) {
    if (state.waitLog.size >= WAIT_LOG_MAX_KEYS) {
      const oldest = state.waitLog.keys().next().value;
      if (oldest !== undefined) state.waitLog.delete(oldest);
    }
    state.waitLog.set(guardKey, (rec = _newWaitRec(kind, k, nowMs, 1)));
  }
  return rec;
}

function _newWaitRec(kind, k, nowMs, cycles) {
  return {
    kind,
    lbKey: k,
    cycles,
    firstAskMs: nowMs,
    lastAskMs: nowMs,
    asks: 0,
    urgentAsks: 0,
    skipInFlight: 0,
    skipCooldown: 0,
    skipCap: 0,
    startMs: null,
    waitMs: null,
    inFlightAtStart: null,
    endMs: null,
    durMs: null,
    ok: null,
  };
}

/**
 * Summarize the wait log for the teleport-window starvation investigation
 * (1114 §3): which LBs waited longest to be ADMITTED (pre-start — guard cap
 * / re-fire cadence) vs ran longest once admitted (in-run — wasm fetch
 * semaphore + decode + bake), and whether the current-LB urgent lane
 * actually engaged (`urgentAsks` 0 on a post-teleport current LB = the
 * stale-center bug reaching the urgent lane too). Read-only; safe to call
 * from the console / a driver probe at any time.
 */
export function summarizeStreamBakeWait(state, { top = 20 } = {}) {
  const recs = state?.waitLog instanceof Map ? [...state.waitLog.values()] : [];
  const done = recs.filter((r) => r.startMs != null);
  const byWait = [...done].sort((a, b) => (b.waitMs ?? 0) - (a.waitMs ?? 0)).slice(0, top);
  const byDur = recs
    .filter((r) => r.durMs != null)
    .sort((a, b) => b.durMs - a.durMs)
    .slice(0, top);
  const fmt = (r) => ({
    key: `${r.kind}:0x${(r.lbKey >>> 0).toString(16).padStart(8, "0")}`,
    cycles: r.cycles,
    asks: r.asks,
    urgentAsks: r.urgentAsks,
    skips: { inFlight: r.skipInFlight, cooldown: r.skipCooldown, cap: r.skipCap },
    waitMs: r.waitMs == null ? null : Math.round(r.waitMs),
    durMs: r.durMs == null ? null : Math.round(r.durMs),
    inFlightAtStart: r.inFlightAtStart,
    ok: r.ok,
    firstAskMs: Math.round(r.firstAskMs),
  });
  const sum = (f) => recs.reduce((a, r) => a + f(r), 0);
  return {
    keys: recs.length,
    totals: {
      asks: sum((r) => r.asks),
      urgentAsks: sum((r) => r.urgentAsks),
      skipInFlight: sum((r) => r.skipInFlight),
      skipCooldown: sum((r) => r.skipCooldown),
      skipCap: sum((r) => r.skipCap),
      started: done.length,
      settled: recs.filter((r) => r.endMs != null).length,
      failed: recs.filter((r) => r.ok === false).length,
      neverStarted: recs.filter((r) => r.startMs == null).length,
    },
    slowestToStart: byWait.map(fmt),
    slowestInRun: byDur.map(fmt),
  };
}

/**
 * @param {ReturnType<typeof createStreamGuardState>} state mutable guard state (caller-owned)
 * @param {string} kind baker label ("terrain" | "buildings" | "statics")
 * @param {number} lbKey landblock key
 * @param {() => Promise<any>} run the baker thunk (returns the bake promise)
 * @param {{cooldownMs?: number, maxInFlight?: number, urgent?: boolean, now?: () => number, warn?: (msg: string, err: any) => void}} [opts]
 *   `opts.urgent` (streamFix 2026-07-02): a PLAYER-BLOCKING bake (the
 *   current LB / its 3×3 after a teleport) is exempt from the GLOBAL
 *   in-flight cap — it must be able to START even while up to
 *   `maxInFlight` stale speculative bakes from the previous town are
 *   still draining. Per-key in-flight dedup and the failure cooldown
 *   still apply (those protect correctness, the cap protects load).
 * @returns {Promise<any>} the bake result, or null when skipped/failed. Never rejects.
 */
export function guardedStreamBake(state, kind, lbKey, run, opts = {}) {
  const st = state || _getDefaultGuardState();
  if (!st.inFlightByKind) {
    st.inFlightByKind = {
      terrain: new Set(),
      buildings: new Set(),
      statics: new Set(),
    };
  }
  const cooldownMs = opts.cooldownMs ?? STREAM_BAKE_RETRY_COOLDOWN_MS;
  const maxInFlight = opts.maxInFlight ?? st.maxInFlight ?? STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT;
  const customMaxInFlight = opts.maxInFlight != null || st._customMaxInFlight === true;
  const now = opts.now ?? (() => performance.now());
  const warn =
    opts.warn ??
    ((msg, err) => {
      // eslint-disable-next-line no-console
      console.warn(msg, err);
    });

  const k = lbKey >>> 0;
  const guardKey = `${kind}:${k}`;

  // Prioritize near-player bakes: check explicit urgent flag, near-player opts,
  // or isNearPlayerLb against live scene state.
  const scene = opts.scene3d || (typeof globalThis !== "undefined" ? (globalThis.liveScene3d || globalThis.__scene3d) : null);
  const nearPlayer = opts.urgent === true ||
    opts.isNearPlayer === true ||
    (scene ? isNearPlayerLb(scene, k) : false);

  // Session 7 (1114 §3) — record the ask + its outcome on the wait log so
  // the teleport-window investigation can see WHERE a current-LB bake
  // waits (pre-admission vs in-run) and whether the urgent lane engaged.
  // Fail-soft: instrumentation must never affect guard semantics.
  const nowMs = now();
  const rec = _waitRec(st, guardKey, kind, k, nowMs);
  if (rec) {
    rec.asks += 1;
    rec.lastAskMs = nowMs;
    if (nearPlayer) rec.urgentAsks += 1;
  }

  // In-flight dedup: a bake for this LB is already running — skip.
  if (st.inFlight.has(guardKey)) {
    if (rec) rec.skipInFlight += 1;
    rlogBakeSkip("inflight");
    return Promise.resolve(null);
  }

  // Cooldown: this LB failed recently — skip until the window elapses.
  const until = st.failUntil.get(guardKey);
  if (until != null) {
    if (now() < until) {
      if (rec) rec.skipCooldown += 1;
      rlogBakeSkip("cooldown");
      return Promise.resolve(null);
    }
    st.failUntil.delete(guardKey);
  }

  // Concurrency cap: partition capacity by kind in default runtime so slow
  // statics bakes do not starve terrain and buildings bakes during flight.
  // If a caller/test explicitly overrides maxInFlight, respect the global cap.
  // Urgent and near-player (isNearPlayerLb) bakes remain cap-exempt.
  const kindSet = st.inFlightByKind?.[kind];
  if (!nearPlayer) {
    if (customMaxInFlight) {
      if (st.inFlight.size >= maxInFlight) {
        if (rec) rec.skipCap += 1;
        rlogBakeSkip("cap");
        return Promise.resolve(null);
      }
    } else {
      const fh = getFlightHint();
      const flying = !!(fh && fh.active !== false);
      const kindCap = (flying ? FLIGHT_KIND_CAPS[kind] : DEFAULT_KIND_CAPS[kind]) ?? maxInFlight;
      if ((kindSet ? kindSet.size : st.inFlight.size) >= kindCap) {
        if (rec) rec.skipCap += 1;
        rlogBakeSkip("cap");
        return Promise.resolve(null);
      }
    }
  }

  if (rec) {
    rec.startMs = now();
    rec.waitMs = rec.startMs - rec.firstAskMs;
    rec.inFlightAtStart = st.inFlight.size;
  }
  st.inFlight.add(guardKey);
  if (kindSet) kindSet.add(k);
  const startedMs = now();
  rlogBake(kind, "start", k, st.inFlight.size);
  return Promise.resolve()
    .then(run)
    .then((r) => {
      // Success clears any prior failure backoff for this LB.
      st.failUntil.delete(guardKey);
      if (rec) { rec.endMs = now(); rec.durMs = rec.endMs - rec.startMs; rec.ok = true; }
      rlogBake(kind, "done", k, Math.round(now() - startedMs));
      return r;
    })
    .catch((err) => {
      if (rec) { rec.endMs = now(); rec.durMs = rec.endMs - rec.startMs; rec.ok = false; }
      rlogBake(kind, "fail", k, 0);
      st.failUntil.set(guardKey, now() + cooldownMs);
      // The baker already logged the root cause; throttle a single warn
      // per cooldown so the retry can't flood the console.
      const lastWarn = st.warnedAt.get(guardKey) ?? -Infinity;
      if (now() - lastWarn > cooldownMs) {
        st.warnedAt.set(guardKey, now());
        warn(
          `[stream] ${kind} bake for LB 0x${k.toString(16)} failed; backing off ${cooldownMs}ms`,
          err?.message ?? err
        );
      }
      return null;
    })
    .finally(() => {
      st.inFlight.delete(guardKey);
      if (kindSet) kindSet.delete(k);
    });
}

export function guardedLbBake(kind, lbKey, fn, opts = {}) {
  return guardedStreamBake(_getDefaultGuardState(), kind, lbKey, fn, opts);
}
