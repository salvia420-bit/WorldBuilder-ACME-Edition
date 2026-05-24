// scene3d/diag/combat.js — CombatManeuverTable lookup observability
//
// Observes the CMT lookup pipeline (`ui/ac_combat_maneuver.js`) — load
// lifecycle, hit/miss rates per (stance, attackHeight, attackType)
// tuple, and which motion u32s the dispatch resolves to. Useful for
// confirming the placeholder `setSwingPose` vibe-pose path is no
// longer firing and that real motions come back from the table.
//
// Hooks fire from `ui/ac_combat_maneuver.js` at success/fail of
// loadCombatManeuverTable + hit/miss inside getCombatManeuver.

import { getCombatDiagSnapshot } from "../../ui/ac_combat_maneuver.js";

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_MISSES = 100;
const DEFAULT_MAX_HITS_SAMPLE = 50;

function errStr(e) {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try { return String(e); } catch (_) { return "(unstringifiable)"; }
}

function hexId(d) { return "0x" + ((d >>> 0).toString(16).padStart(8, "0")); }

function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.shift();
}

export function attachCombat(diag) {
  const combat = {
    loaded: new Map(),        // tableId → {maneuverCount, stanceCount, loadedAt}
    failures: [],
    hits: 0,
    hitsSample: [],           // ring; recent hit tuples for spot inspection
    misses: [],               // ring; recent miss tuples (with reason)
    missCountByReason: { stance: 0, height: 0, type: 0 },
    maxFailures: DEFAULT_MAX_FAILURES,
    maxMisses: DEFAULT_MAX_MISSES,
    maxHitsSample: DEFAULT_MAX_HITS_SAMPLE,

    onLoadSucceeded(meta) {
      try {
        const m = meta || {};
        const tid = (m.tableId ?? 0) >>> 0;
        combat.loaded.set(tid, {
          tableId: hexId(tid),
          maneuverCount: (m.maneuverCount ?? 0) | 0,
          stanceCount: (m.stanceCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    onLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(combat.failures, {
          tableId: hexId(m.tableId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, combat.maxFailures);
      } catch (_) {}
    },

    onLookupHit(meta) {
      try {
        const m = meta || {};
        combat.hits += 1;
        pushCapped(combat.hitsSample, {
          stance: (m.stance ?? 0) >>> 0,
          attackHeight: (m.attackHeight ?? 0) | 0,
          attackType: (m.attackType ?? 0) | 0,
          motion: (m.motion ?? 0) >>> 0,
          powerLevel: Number(m.powerLevel ?? 0),
          candidates: (m.candidates ?? 1) | 0,
          ts: performance.now(),
        }, combat.maxHitsSample);
      } catch (_) {}
    },

    onLookupMiss(meta) {
      try {
        const m = meta || {};
        const reason = m.reason || "unknown";
        if (reason in combat.missCountByReason) {
          combat.missCountByReason[reason] += 1;
        }
        pushCapped(combat.misses, {
          stance: (m.stance ?? 0) >>> 0,
          attackHeight: (m.attackHeight ?? 0) | 0,
          attackType: (m.attackType ?? 0) | 0,
          reason,
          ts: performance.now(),
        }, combat.maxMisses);
      } catch (_) {}
    },

    /** Read-through to the runtime's cache. */
    cached() {
      try { return getCombatDiagSnapshot(); }
      catch (_) { return { tables: [] }; }
    },

    summary() {
      const cached = combat.cached();
      return {
        tablesLoaded: combat.loaded.size,
        tablesCached: cached.tables.length,
        failures: combat.failures.length,
        hits: combat.hits,
        misses: combat.misses.length,
        missByReason: { ...combat.missCountByReason },
      };
    },

    snapshot() {
      return {
        ts: new Date().toISOString(),
        loaded: Array.from(combat.loaded.values()),
        cached: combat.cached(),
        failures: [...combat.failures],
        hits: combat.hits,
        hitsSample: [...combat.hitsSample],
        misses: [...combat.misses],
        missByReason: { ...combat.missCountByReason },
      };
    },

    reset() {
      combat.failures.length = 0;
      combat.hits = 0;
      combat.hitsSample.length = 0;
      combat.misses.length = 0;
      combat.missCountByReason = { stance: 0, height: 0, type: 0 };
    },
  };

  diag.combat = combat;
}
