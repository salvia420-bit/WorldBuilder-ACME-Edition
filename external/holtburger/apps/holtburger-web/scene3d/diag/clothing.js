// scene3d/diag/clothing.js — ClothingTable load observability
//
// Observes the ClothingTable pipeline (`ui/ac_clothing.js`) — load
// lifecycle + cached read-through. Per-equip-event coverage (which
// items got rendered with which substitutions on which entity) is
// the deferred follow-on once the UpdateObject handler lands — see
// `docs/handoff-clothing-table-2026-05-24.md`.

import { getClothingDiagSnapshot } from "../../ui/ac_clothing.js";

const DEFAULT_MAX_FAILURES = 20;
const DEFAULT_MAX_APPEARANCE_CHANGES = 30;

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

export function attachClothing(diag) {
  const clothing = {
    loaded: new Map(),    // clothingId → {baseEffectCount, subPalEffectCount, loadedAt}
    failures: [],
    // Wave 7.3 — mid-game equip-change observability. Fired from
    // `EntityManager.applyAppearance(guid, opts)` BEFORE the despawn,
    // so we always have observation even if the subsequent respawn
    // errors out.
    appearanceChanges: 0,
    recentChanges: [],
    maxFailures: DEFAULT_MAX_FAILURES,
    maxRecentChanges: DEFAULT_MAX_APPEARANCE_CHANGES,

    onLoadSucceeded(meta) {
      try {
        const m = meta || {};
        const cid = (m.clothingId ?? 0) >>> 0;
        clothing.loaded.set(cid, {
          clothingId: hexId(cid),
          baseEffectCount: (m.baseEffectCount ?? 0) | 0,
          subPalEffectCount: (m.subPalEffectCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    onLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(clothing.failures, {
          clothingId: hexId(m.clothingId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, clothing.maxFailures);
      } catch (_) {}
    },

    /**
     * Hook fired from `EntityManager.applyAppearance(guid, opts)` —
     * meta carries the substitution counts + paletteId so the harness
     * can audit which mid-game equip changes actually propagated.
     */
    onAppearanceChange(meta) {
      try {
        const m = meta || {};
        clothing.appearanceChanges += 1;
        pushCapped(clothing.recentChanges, {
          guid: hexId(m.guid ?? 0),
          source: m.source || "unknown",
          modelChangesCount: (m.modelChangesCount ?? 0) | 0,
          textureChangesCount: (m.textureChangesCount ?? 0) | 0,
          subPalettesCount: (m.subPalettesCount ?? 0) | 0,
          paletteId: hexId(m.paletteId ?? 0),
          ts: performance.now(),
        }, clothing.maxRecentChanges);
      } catch (_) {}
    },

    /** Read-through to the runtime cache. */
    cached() {
      try { return getClothingDiagSnapshot(); }
      catch (_) { return { tables: [] }; }
    },

    summary() {
      const cached = clothing.cached();
      return {
        loaded: clothing.loaded.size,
        cached: cached.tables.length,
        failures: clothing.failures.length,
        appearanceChanges: clothing.appearanceChanges,
      };
    },

    snapshot() {
      return {
        ts: new Date().toISOString(),
        loaded: Array.from(clothing.loaded.values()),
        cached: clothing.cached(),
        failures: [...clothing.failures],
        appearanceChanges: clothing.appearanceChanges,
        recentChanges: [...clothing.recentChanges],
      };
    },

    reset() {
      clothing.failures.length = 0;
      clothing.appearanceChanges = 0;
      clothing.recentChanges.length = 0;
    },
  };

  diag.clothing = clothing;
}
