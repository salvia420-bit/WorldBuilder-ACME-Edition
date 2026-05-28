// scene3d/diag/events.js — sound/particle event-log diagnostic slice
//
// Read-only tap over the host runtime's Phase F.C ring buffer (cap 50,000)
// installed in scene3d/index.js when `?eventLog=on` is set. We never push
// records ourselves — the runtime's `_pushEventRecord` is the single writer
// (AmbientRuntime, AnimationHook, GameMessageSound, PhysicsScriptHook,
// SkyChain). All entry points snapshot via `liveScene3d.snapshotEventLog()`
// and slice in-memory. The expected-events oracle is a Wave-2.B2 extension
// to `diag.expected` not yet emitted by WB.Terminal — `diff()` returns a
// structured "no oracle" error in that case. probe(durationMs) does NOT
// mock time or inject events; it snapshots before/after and slices by
// `t_wall_ms`. Entity-spawn diff lives on `__diag.diff(lbId)` proper.

const NO_TAP = { error: "events tap disabled; URL needs ?eventLog=on" };
const POS_TOL_M_SQ = 25;   // 5m tolerance (5² = 25)
const TIME_TOL_MS  = 2000; // ±2s

function normalizeLb(lbId) {
  const raw = typeof lbId === "string" ? parseInt(lbId, 16) : lbId;
  return ((raw & 0xffff0000) >>> 0);
}

/** True iff the host runtime wired up the F.C push helper. */
function tapLive() {
  if (typeof window === "undefined") return false;
  const ls = window.liveScene3d;
  return !!(ls && typeof ls._pushEventRecord === "function" && typeof ls.snapshotEventLog === "function");
}

/** Defensive snapshot wrapper. Returns empty shape when tap is off. */
function snap() {
  if (!tapLive()) return { records: [], overflow: 0, capped_at: 0 };
  try { return window.liveScene3d.snapshotEventLog(); }
  catch (_) { return { records: [], overflow: 0, capped_at: 0 }; }
}

function buildSummary(records) {
  const byKind = {}, bySource = {};
  for (const r of records) {
    const k = r.type ?? "<unknown>";
    byKind[k] = (byKind[k] ?? 0) + 1;
    const s = r.source ?? "<unknown>";
    bySource[s] = (bySource[s] ?? 0) + 1;
  }
  return { byKind, bySource };
}

/** Match-key for diff: sound→wave_did, particle→emitter_did, plus source. */
function eventKey(r) {
  if (r.type === "sound") return `sound|${(r.wave_did >>> 0).toString(16)}|${r.source ?? ""}`;
  if (r.type === "particle") return `particle|${(r.emitter_did >>> 0).toString(16)}|${r.source ?? ""}`;
  return `${r.type ?? "?"}|?|${r.source ?? ""}`;
}

function distSq(a, b) {
  const dx = (a?.[0] ?? 0) - (b?.[0] ?? 0);
  const dy = (a?.[1] ?? 0) - (b?.[1] ?? 0);
  const dz = (a?.[2] ?? 0) - (b?.[2] ?? 0);
  return dx*dx + dy*dy + dz*dz;
}

export function attachEvents(diag) {
  // One-time inactive-tap warning. Fires only when an oracle is loaded but
  // the tap is missing — that's a real misconfig (the oracle has nothing
  // to diff against). `?diag=1` paths used to warn here too, but
  // `scene3d/index.js` already auto-enables eventLog under `?diag=1` and
  // `attachEvents` runs before `liveScene3d` is built, so tapLive() is
  // always false at this point on the diag path → the warning was a
  // false positive. Keep the oracle check; drop the URL check.
  try {
    const hasOracle = (diag?.expected !== null && diag?.expected !== undefined);
    if (hasOracle && !tapLive()) {
      // eslint-disable-next-line no-console
      console.warn(
        "[diag.events] tap is inactive — eventLog ring buffer is off. " +
          "Add ?eventLog=on to the URL for event diagnostics."
      );
    }
  } catch (_) { /* never let attach-time logging throw */ }

  diag.events = {
    isEnabled() { return tapLive(); },

    tail(n = 100) {
      if (!tapLive()) return { ...NO_TAP };
      const s = snap();
      const k = Math.max(0, Math.min(n | 0, s.records.length));
      return s.records.slice(s.records.length - k);
    },

    byKind(kind) {
      if (!tapLive()) return { ...NO_TAP };
      return snap().records.filter((r) => r.type === kind);
    },

    bySource(source) {
      if (!tapLive()) return { ...NO_TAP };
      return snap().records.filter((r) => r.source === source);
    },

    summary() {
      if (!tapLive()) return { ...NO_TAP };
      const s = snap();
      return {
        total: s.records.length,
        overflow: s.overflow,
        capped_at: s.capped_at,
        ...buildSummary(s.records),
      };
    },

    async probe(durationMs) {
      if (!tapLive()) return { ...NO_TAP };
      const dur = Math.max(0, +durationMs || 0);
      const startTs = performance.now();
      const startSnap = snap();
      const startRecordCount = startSnap.records.length;
      await new Promise((resolve) => setTimeout(resolve, dur));
      const endTs = performance.now();
      const endSnap = snap();
      const endRecordCount = endSnap.records.length;
      // Slice by wall-clock so ring-buffer wraparound during the window
      // still produces a coherent set. Records lacking t_wall_ms (e.g.
      // pre-runtime stragglers) are excluded from the window.
      const records = endSnap.records.filter(
        (r) => typeof r.t_wall_ms === "number" && r.t_wall_ms >= startTs && r.t_wall_ms <= endTs
      );
      return {
        startTs,
        endTs,
        durationMs: dur,
        startRecordCount,
        endRecordCount,
        records,
        summary: buildSummary(records),
      };
    },

    diff(lbId, opts) {
      if (!tapLive()) return { ...NO_TAP, classification: "channel-disabled" };
      const expectedEvents = diag?.expected?.events;
      if (!Array.isArray(expectedEvents)) {
        return { error: "no event oracle loaded; WB.T dump-lb-expectations doesn't include events yet (Wave 2.B2)" };
      }
      const lb = normalizeLb(lbId);
      const t0 = (opts && typeof opts.t0 === "number") ? opts.t0 : -Infinity;
      const t1 = (opts && typeof opts.t1 === "number") ? opts.t1 :  Infinity;
      const window_ = { t0, t1 };

      const expectedForLb = expectedEvents.filter((e) => normalizeLb(e.landblockId) === lb);
      const obs = snap().records.filter((r) => {
        const t = typeof r.t_wall_ms === "number" ? r.t_wall_ms : 0;
        return t >= t0 && t <= t1;
      });

      const paired = new Set();   // observed indices already matched
      const missing = [];
      let matched = 0;

      for (const exp of expectedForLb) {
        const expKey = eventKey({
          type: exp.type,
          wave_did: exp.wave_did,
          emitter_did: exp.emitter_did,
          source: exp.source,
        });

        // Prefer the closest in-position observed record sharing the key.
        let best = -1;
        let bestDistSq = Infinity;
        for (let i = 0; i < obs.length; i++) {
          if (paired.has(i)) continue;
          if (eventKey(obs[i]) !== expKey) continue;
          const d = distSq(obs[i].world_pos, exp.world_pos);
          if (d < bestDistSq) { bestDistSq = d; best = i; }
        }
        if (best < 0) {
          missing.push({ expected: exp, classification: "never-fired", detail: null });
          continue;
        }
        if (bestDistSq > POS_TOL_M_SQ) {
          missing.push({
            expected: exp,
            classification: "wrong-position",
            detail: { observedPos: obs[best].world_pos, distance: Math.sqrt(bestDistSq) },
          });
          paired.add(best);
          continue;
        }
        // Time-window check (only when the oracle entry specifies one).
        if (exp.trigger_window && typeof exp.trigger_window.t === "number") {
          const dt = (obs[best].t_wall_ms ?? 0) - exp.trigger_window.t;
          if (Math.abs(dt) > TIME_TOL_MS) {
            missing.push({
              expected: exp,
              classification: "wrong-time",
              detail: { observedT: obs[best].t_wall_ms, expectedT: exp.trigger_window.t, deltaMs: dt },
            });
            paired.add(best);
            continue;
          }
        }
        paired.add(best);
        matched += 1;
      }

      const extra = [];
      for (let i = 0; i < obs.length; i++) {
        if (paired.has(i)) continue;
        extra.push(obs[i]);
      }

      return {
        landblockId: "0x" + lb.toString(16).padStart(8, "0"),
        window: window_,
        expectedCount: expectedForLb.length,
        observedCount: obs.length,
        matched,
        missing,
        extra,
        ok: missing.length === 0,
        summary: missing.reduce((acc, m) => {
          acc[m.classification] = (acc[m.classification] ?? 0) + 1;
          return acc;
        }, {}),
      };
    },
  };
}
