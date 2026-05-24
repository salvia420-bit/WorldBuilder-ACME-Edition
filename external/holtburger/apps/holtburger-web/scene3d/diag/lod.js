// scene3d/diag/lod.js — GfxObjDegradeInfo LOD-chain observability
//
// Observes the LOD-chain lookup pipeline (`ui/ac_lod.js`) — load
// lifecycle + per-distance band hit/miss counters. Statics already
// have a parallel LOD path via `resolve_did_degrade` (lib.rs:4475);
// this surface specifically observes the new explicit-band reader
// (preparing for entity-side LOD integration — see
// `docs/handoff-degrade-info-entity-lod-2026-05-24.md`).

import { getLodDiagSnapshot } from "../../ui/ac_lod.js";

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_BAND_SAMPLES = 50;

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

export function attachLod(diag) {
  const lod = {
    loaded: new Map(),    // degradeId → {bandCount, loadedAt}
    failures: [],
    bandHits: 0,
    bandMisses: 0,
    recentHits: [],
    recentMisses: [],
    maxFailures: DEFAULT_MAX_FAILURES,
    maxBandSamples: DEFAULT_MAX_BAND_SAMPLES,

    onLoadSucceeded(meta) {
      try {
        const m = meta || {};
        const did = (m.degradeId ?? 0) >>> 0;
        lod.loaded.set(did, {
          degradeId: hexId(did),
          bandCount: (m.bandCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    onLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(lod.failures, {
          degradeId: hexId(m.degradeId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, lod.maxFailures);
      } catch (_) {}
    },

    onBandHit(meta) {
      try {
        const m = meta || {};
        lod.bandHits += 1;
        pushCapped(lod.recentHits, {
          degradeId: hexId(m.degradeId ?? 0),
          distance: Number(m.distance ?? 0),
          gfxObjId: hexId(m.gfxObjId ?? 0),
          ts: performance.now(),
        }, lod.maxBandSamples);
      } catch (_) {}
    },

    onBandMiss(meta) {
      try {
        const m = meta || {};
        lod.bandMisses += 1;
        pushCapped(lod.recentMisses, {
          degradeId: hexId(m.degradeId ?? 0),
          distance: Number(m.distance ?? 0),
          bandCount: (m.bandCount ?? 0) | 0,
          ts: performance.now(),
        }, lod.maxBandSamples);
      } catch (_) {}
    },

    /** Read-through to the runtime cache. */
    cached() {
      try { return getLodDiagSnapshot(); }
      catch (_) { return { chains: [] }; }
    },

    summary() {
      const cached = lod.cached();
      return {
        loaded: lod.loaded.size,
        cached: cached.chains.length,
        failures: lod.failures.length,
        bandHits: lod.bandHits,
        bandMisses: lod.bandMisses,
      };
    },

    snapshot() {
      return {
        ts: new Date().toISOString(),
        loaded: Array.from(lod.loaded.values()),
        cached: lod.cached(),
        failures: [...lod.failures],
        bandHits: lod.bandHits,
        bandMisses: lod.bandMisses,
        recentHits: [...lod.recentHits],
        recentMisses: [...lod.recentMisses],
      };
    },

    reset() {
      lod.failures.length = 0;
      lod.bandHits = 0;
      lod.bandMisses = 0;
      lod.recentHits.length = 0;
      lod.recentMisses.length = 0;
    },
  };

  diag.lod = lod;
}
