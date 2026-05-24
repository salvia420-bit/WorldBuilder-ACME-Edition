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
const DEFAULT_MAX_DYE_APPLICATIONS = 50;

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
    // Wave 7.7 — dye observability. Fires from
    // `EntityManager._spawnImpl` AND `_applyAppearanceHotSwap` when
    // `fetchEntitySurfacesPixels` is invoked with non-trivial
    // overlays (paletteId != 0 || sub_palettes.length > 0). Captures
    // (guid, surfaceDids, paletteId, subPaletteTripleCount, source)
    // so the harness can audit which entities are actually paying
    // the dye compositor cost. Counter + ring; no diff against any
    // oracle (matches the rest of __diag.clothing's observation-
    // only discipline).
    dyeApplications: 0,
    recentDyes: [],
    dyesBySource: { spawn: 0, "hot-swap": 0 },
    maxFailures: DEFAULT_MAX_FAILURES,
    maxRecentChanges: DEFAULT_MAX_APPEARANCE_CHANGES,
    maxRecentDyes: DEFAULT_MAX_DYE_APPLICATIONS,

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

    /**
     * Wave 7.7 — fired when fetchEntitySurfacesPixels runs with
     * non-trivial overlays. Meta:
     *   {guid, source: "spawn"|"hot-swap", surfaceDidCount,
     *    paletteId, subPaletteTripleCount}
     */
    onDyeApplication(meta) {
      try {
        const m = meta || {};
        clothing.dyeApplications += 1;
        const source = m.source || "unknown";
        if (source in clothing.dyesBySource) clothing.dyesBySource[source] += 1;
        else clothing.dyesBySource[source] = 1;
        pushCapped(clothing.recentDyes, {
          guid: hexId(m.guid ?? 0),
          source,
          surfaceDidCount: (m.surfaceDidCount ?? 0) | 0,
          paletteId: hexId(m.paletteId ?? 0),
          subPaletteTripleCount: (m.subPaletteTripleCount ?? 0) | 0,
          ts: performance.now(),
        }, clothing.maxRecentDyes);
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
        dyeApplications: clothing.dyeApplications,
        dyesBySource: { ...clothing.dyesBySource },
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
        dyeApplications: clothing.dyeApplications,
        recentDyes: [...clothing.recentDyes],
        dyesBySource: { ...clothing.dyesBySource },
      };
    },

    reset() {
      clothing.failures.length = 0;
      clothing.appearanceChanges = 0;
      clothing.recentChanges.length = 0;
      clothing.dyeApplications = 0;
      clothing.recentDyes.length = 0;
      clothing.dyesBySource = { spawn: 0, "hot-swap": 0 };
    },
  };

  diag.clothing = clothing;
}
