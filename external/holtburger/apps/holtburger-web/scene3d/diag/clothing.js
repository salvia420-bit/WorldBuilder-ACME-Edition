// scene3d/diag/clothing.js — ClothingTable load observability
//
// Observes the ClothingTable pipeline (`ui/ac_clothing.js`) — load
// lifecycle + cached read-through. Per-equip-event coverage (which
// items got rendered with which substitutions on which entity) is
// the deferred follow-on once the UpdateObject handler lands — see
// `docs/handoff-clothing-table-2026-05-24.md`.

import { getClothingDiagSnapshot } from "../../ui/ac_clothing.js";
import { getDyePreviewDiagSnapshot } from "../../ui/ac_dye_preview.js";

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
    // Wave 7.9 — Phase D plugin tooltip-shown counter. Fires from
    // `plugins/dye-preview.js::showTooltipFor` when a dye-pot is
    // dragged over a dyeable armor + the tooltip is rendered.
    // Includes a "reason" string when preview is unavailable
    // (e.g. armor metadata missing from wire packet).
    dyePreviewsShown: 0,
    dyePreviewsShownByReason: {},
    recentDyePreviewsShown: [],
    maxRecentDyePreviewsShown: 30,
    // Wave 7.9.B — D.4 whole-mesh local preview counters. Fire when
    // Shift+drag-over routes the dye through applyAppearance on the
    // local player rig (apply) + when the preview reverts at hide
    // time (revert). Net should always be zero — every apply
    // matched by a revert.
    dyePreviewWholeMeshApplied: 0,
    dyePreviewWholeMeshReverted: 0,
    // Wave 7.8 — Phase C dye-preview compositor counters. Fired from
    // ui/ac_dye_preview.js::composeDyePreview. previewsRendered =
    // unique (clothing, setup, template, shadeBucket) combos
    // actually rendered via wasm; previewCacheHits = subsequent
    // requests for the same cache key. Failure breakdown bucketed
    // by reason ("no target surface" / "no sub-pal effect" / etc).
    dyePreviewsRendered: 0,
    dyePreviewCacheHits: 0,
    dyePreviewFailures: 0,
    dyePreviewFailuresByReason: {},
    recentDyePreviews: [],
    maxFailures: DEFAULT_MAX_FAILURES,
    maxRecentChanges: DEFAULT_MAX_APPEARANCE_CHANGES,
    maxRecentDyes: DEFAULT_MAX_DYE_APPLICATIONS,
    maxRecentPreviews: 30,

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

    /**
     * Wave 7.9.B — D.4 whole-mesh preview hooks. Fire when the
     * plugin Shift+drag-over routes the dye through
     * applyAppearance on the local player's actual rig in the
     * main scene + when the preview reverts at hide/drag-end.
     * Apply + Revert should be net-zero — every apply matched by
     * a revert. Drift in the counters indicates a leak.
     */
    onDyePreviewWholeMeshApplied(_meta) {
      try { clothing.dyePreviewWholeMeshApplied += 1; } catch (_) {}
    },
    onDyePreviewWholeMeshReverted(_meta) {
      try { clothing.dyePreviewWholeMeshReverted += 1; } catch (_) {}
    },

    /**
     * Wave 7.9 — plugin tooltip-shown hook. Meta:
     *   {source: "drag-over", dyePotWcid, clothingId, setupDid,
     *    paletteTemplate, shade, composed, reason?}
     * `composed` is false when the underlying composeDyePreview
     * couldn't produce a canvas; `reason` is set when the tooltip
     * shows a fallback message (e.g. armor metadata missing).
     */
    onDyePreviewShown(meta) {
      try {
        const m = meta || {};
        clothing.dyePreviewsShown += 1;
        const reason = m.reason || "ok";
        clothing.dyePreviewsShownByReason[reason] =
          (clothing.dyePreviewsShownByReason[reason] || 0) + 1;
        pushCapped(clothing.recentDyePreviewsShown, {
          source: m.source || "unknown",
          dyePotWcid: m.dyePotWcid ? hexId(m.dyePotWcid) : "0x0",
          clothingId: m.clothingId ? hexId(m.clothingId) : null,
          setupDid: m.setupDid ? hexId(m.setupDid) : null,
          paletteTemplate: (m.paletteTemplate ?? 0) | 0,
          shade: Number(m.shade ?? 0),
          composed: !!m.composed,
          // Wave 7.9.A — distinguishes 3D viewport vs flat-canvas
          // fallback (set by dye-preview plugin when DyeViewport
          // succeeds vs falls through to composeDyePreview).
          mode: m.mode || null,
          reason,
          ts: performance.now(),
        }, clothing.maxRecentDyePreviewsShown);
      } catch (_) {}
    },

    /**
     * Wave 7.8 — dye-preview compositor hooks. Fired from
     * `ui/ac_dye_preview.js::composeDyePreview`.
     */
    onDyePreviewRendered(meta) {
      try {
        const m = meta || {};
        clothing.dyePreviewsRendered += 1;
        pushCapped(clothing.recentDyePreviews, {
          clothingId: hexId(m.clothingId ?? 0),
          setupDid: hexId(m.setupDid ?? 0),
          paletteTemplate: (m.paletteTemplate ?? 0) | 0,
          shade: Number(m.shade ?? 0),
          targetSurfaceDid: hexId(m.targetSurfaceDid ?? 0),
          tripleCount: (m.tripleCount ?? 0) | 0,
          width: (m.width ?? 0) | 0,
          height: (m.height ?? 0) | 0,
          ts: performance.now(),
        }, clothing.maxRecentPreviews);
      } catch (_) {}
    },
    onDyePreviewCacheHit(_meta) {
      try { clothing.dyePreviewCacheHits += 1; } catch (_) {}
    },
    onDyePreviewFailed(meta) {
      try {
        const m = meta || {};
        clothing.dyePreviewFailures += 1;
        const reason = m.reason || "unknown";
        clothing.dyePreviewFailuresByReason[reason] =
          (clothing.dyePreviewFailuresByReason[reason] || 0) + 1;
      } catch (_) {}
    },

    /** Read-through to BOTH ClothingTable + dye-preview-compositor caches. */
    cached() {
      const tables = (() => {
        try { return getClothingDiagSnapshot(); }
        catch (_) { return { tables: [] }; }
      })();
      const preview = (() => {
        try { return getDyePreviewDiagSnapshot(); }
        catch (_) { return null; }
      })();
      return { tables: tables.tables, preview };
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
        dyePreviewsRendered: clothing.dyePreviewsRendered,
        dyePreviewCacheHits: clothing.dyePreviewCacheHits,
        dyePreviewFailures: clothing.dyePreviewFailures,
        dyePreviewCacheSize: cached.preview?.previewCacheSize ?? 0,
        dyePreviewsShown: clothing.dyePreviewsShown,
        dyePreviewsShownByReason: { ...clothing.dyePreviewsShownByReason },
        dyePreviewWholeMeshApplied: clothing.dyePreviewWholeMeshApplied,
        dyePreviewWholeMeshReverted: clothing.dyePreviewWholeMeshReverted,
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
        dyePreviewsRendered: clothing.dyePreviewsRendered,
        dyePreviewCacheHits: clothing.dyePreviewCacheHits,
        dyePreviewFailures: clothing.dyePreviewFailures,
        dyePreviewFailuresByReason: { ...clothing.dyePreviewFailuresByReason },
        recentDyePreviews: [...clothing.recentDyePreviews],
        dyePreviewsShown: clothing.dyePreviewsShown,
        dyePreviewsShownByReason: { ...clothing.dyePreviewsShownByReason },
        recentDyePreviewsShown: [...clothing.recentDyePreviewsShown],
      };
    },

    reset() {
      clothing.failures.length = 0;
      clothing.appearanceChanges = 0;
      clothing.recentChanges.length = 0;
      clothing.dyeApplications = 0;
      clothing.recentDyes.length = 0;
      clothing.dyesBySource = { spawn: 0, "hot-swap": 0 };
      clothing.dyePreviewsRendered = 0;
      clothing.dyePreviewCacheHits = 0;
      clothing.dyePreviewFailures = 0;
      clothing.dyePreviewFailuresByReason = {};
      clothing.recentDyePreviews.length = 0;
      clothing.dyePreviewsShown = 0;
      clothing.dyePreviewsShownByReason = {};
      clothing.recentDyePreviewsShown.length = 0;
      clothing.dyePreviewWholeMeshApplied = 0;
      clothing.dyePreviewWholeMeshReverted = 0;
    },
  };

  diag.clothing = clothing;
}
