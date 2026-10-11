// scene3d/diag/slow_run.js — SLOW-RUN (2026-10-11) devtools surface for the
// wasm slow-run detector (`holtburger_core::slow_run_diag`).
//
// Owner report: "sometimes when moving in a certain direction it seems theres
// a server induced lag or something that happens sporadically and makes the
// character a little bit slower until i stop the movement and restart the
// movement again."
//
// The detector lives in Rust, on the local manual-drive slice. It compares the
// realized planar speed against the speed the HELD keys should produce. When
// the run stays more than 10 % under it for more than 0.5 s of grounded
// running, it records an incident with every cause candidate: the leash budget
// and echo/AP ages, server control and the autonomy latch, MoveTo,
// interpolation, sticky, the cast lock, the run-rate sources, and the held keys
// against the drive. It also prints one rate-limited `[slow-run] …` console
// line. This module only reads that ring, on demand, through the
// `window.__hbWasm.slowRunDiag*` riders (index.html). It does no per-frame work.
//
// Devtools:
//   __diag.slowRun.summary()   — { count, kept, byCause, last }
//   __diag.slowRun.tail(n=5)   — the last n incidents (full records)
//   __diag.slowRun.explain()   — what the last incident's cause means
//   __diag.slowRun.clear()     — forget the ring

/** What each cause means and where to look next. */
export const SLOW_RUN_CAUSES = Object.freeze({
  leash:
    "Retail ConstraintManager slowdown: the travel since the last self " +
    "UpdatePosition echo (leashBudgetM) passed 10 m outdoors / 5 m indoors, so " +
    "the run is scaled until ACE's next echo re-arms ConstrainTo. Check echoAgeS " +
    "(time since that echo), apAgeS (our last AutonomousPosition) and " +
    "positionEventReady. A stop + restart sends MoveToStates whose echoes re-arm " +
    "the leash, which is why it 'fixes' it.",
  runRate:
    "The run rate in use (the server-published my_run_rate, ?serverRunRate) is " +
    "below the local skill+burden composition. It only refreshes when ACE echoes " +
    "a W-held MoveToState (a fresh press) or re-sends the run (HandleRunRateUpdate).",
  serverControl:
    "ACE's interpreted state drives the body (autonomy latch low or " +
    "controlled_by_server up) instead of the held keys. Check serverMotionAgeS / " +
    "serverMotionRate, pendingMotions, moveToActive, projectionActive.",
  castForwardLock:
    "The ?castHoldReclaim lock left a held W/S dead after a cast. " +
    "?castLockRevive (default on) re-applies it when the cast window closes.",
  driveMismatch:
    "The installed drive differs from the held keys (gait or axes) without " +
    "server control. Compare `held` and `drive` ([fwd, side, turn, run]).",
  interpolation:
    "InterpolationManager replaced the run offset (a server position pull).",
  sticky: "StickyManager replaced the run offset (melee stick).",
  collision:
    "The transition clamped the move (wall, object, slope): transitionRatio < 0.9.",
  unknown: "No single stage lost more than 10 %; compare the four ratios.",
});

function _hb() {
  const w = (typeof window !== "undefined") ? window : null;
  return (w && w.__hbWasm) ? w.__hbWasm : null;
}

/** Parse the wasm JSON; `null` on a missing export or bad payload. */
export function readSlowRunRing(hb = _hb()) {
  if (!hb || typeof hb.slowRunDiag !== "function") return null;
  try {
    const parsed = JSON.parse(hb.slowRunDiag());
    if (!parsed || !Array.isArray(parsed.incidents)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/** Compact one incident for summaries (the full record stays in tail()). */
export function compactIncident(i) {
  if (!i) return null;
  return {
    seq: i.seq,
    cause: i.cause,
    realized: i.realizedMps,
    reference: i.referenceMps,
    slowSecs: i.slowSecs,
    ratios: {
      rate: i.rateRatio,
      drive: i.driveRatio,
      leash: i.leashRatio,
      transition: i.transitionRatio,
    },
    leashBudgetM: i.leashBudgetM,
    echoAgeS: i.echoAgeS,
    apAgeS: i.apAgeS,
    serverControlled: i.serverControlled,
    latchAutonomous: i.latchAutonomous,
    held: i.held,
    drive: i.drive,
  };
}

export function attachSlowRun(diag) {
  diag.slowRun = {
    /** The wasm exports are present (a stale pkg/ has none). */
    available() {
      const hb = _hb();
      return !!(hb && typeof hb.slowRunDiag === "function");
    },

    /** Incidents recorded since load (or the last clear); null if absent. */
    count() {
      const hb = _hb();
      if (!hb || typeof hb.slowRunDiagCount !== "function") return null;
      try {
        return hb.slowRunDiagCount() >>> 0;
      } catch (_) {
        return null;
      }
    },

    /** The last n incidents, oldest first (full records). */
    tail(n = 5) {
      const ring = readSlowRunRing();
      if (!ring) return [];
      const k = Math.max(0, n | 0);
      return k === 0 ? [] : ring.incidents.slice(-k);
    },

    /** The most recent incident, or null. */
    last() {
      const ring = readSlowRunRing();
      if (!ring || ring.incidents.length === 0) return null;
      return ring.incidents[ring.incidents.length - 1];
    },

    summary() {
      const ring = readSlowRunRing();
      if (!ring) {
        return {
          available: false,
          error: "slowRunDiag export missing (stale pkg/ or pre-boot)",
        };
      }
      const byCause = {};
      for (const i of ring.incidents) {
        byCause[i.cause] = (byCause[i.cause] || 0) + 1;
      }
      const last = ring.incidents[ring.incidents.length - 1] ?? null;
      return {
        available: true,
        count: ring.count,
        kept: ring.incidents.length,
        byCause,
        last: compactIncident(last),
      };
    },

    /** What an incident's cause means (default: the most recent). */
    explain(incident) {
      const i = incident ?? this.last();
      if (!i) return "no slow-run incident recorded";
      return `#${i.seq} ${i.cause}: ${SLOW_RUN_CAUSES[i.cause] ?? SLOW_RUN_CAUSES.unknown}`;
    },

    clear() {
      const hb = _hb();
      if (!hb || typeof hb.slowRunDiagClear !== "function") return false;
      try {
        hb.slowRunDiagClear();
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}
