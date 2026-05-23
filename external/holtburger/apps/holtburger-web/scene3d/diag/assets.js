// scene3d/diag/assets.js — asset-load-failure diagnostic slice (Wave 4)
//
// Pain point this addresses: when a material fetch (surface pixels) or an
// animation-keyframes fetch fails, the existing caches either silently
// swallow the error (mesh conversion failures), only `console.warn` (entity
// preload paths, batch fetchers), or re-throw without surfacing the failed
// IDs to any inspectable runtime state. From outside, the only visible
// symptom is "this entity is invisible / never animates" — there's no way
// to ask "what asset fetch failed, when, and for whom?" without scrolling
// the console log.
//
// This surface exposes per-cache ring buffers the diag harness reads:
//
//   __diag.assets.materialErrors   — [{ did|dids, error, ts, source }]
//   __diag.assets.animationErrors  — [{ setupId(s), mtableId, motionCmd,
//                                        stance, error, ts, source }]
//   __diag.assets.meshErrors       — [{ partIndex, setupId, error, ts }]
//
// Hooks fire from the existing `.catch` blocks in MaterialCache (preload +
// preloadBatch + per-entity surface fetch) and AnimationCache (get +
// getBatch + meshToGeometryGroups conversion). Each hook is a single
// optional-chained call in the host file; the hook body here is responsible
// for normalising the meta, pushing the entry, and capping the ring.
//
// Cost per fire: O(1) — one object literal, one push, one optional shift().
// Failure-path only, so steady-state cost is zero.
//
// `stuck(thresholdMs)` is sketched as a v2 entry point: it would correlate
// `pendingFetches.size` / `entries.size` with per-entry start-times to
// surface assets that have been in-flight too long. The current caches
// don't record start-times per entry, so the implementation returns a
// `note` placeholder. Adding start-time instrumentation is a follow-on.

const DEFAULT_MAX_ERRORS = 100;

/** Defensive coercion of arbitrary error → short string. */
function errStr(e) {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try { return String(e); } catch (_) { return "(unstringifiable)"; }
}

/** Hex-render a DID (or undefined). */
function hexDid(d) {
  if (d == null) return undefined;
  return "0x" + ((d >>> 0).toString(16).padStart(8, "0"));
}

/** Push with ring-buffer cap (oldest evicted). */
function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.shift();
}

export function attachAssets(diag) {
  const assets = {
    // Persistent error arrays — push on each failure
    materialErrors: [],
    animationErrors: [],
    meshErrors: [],
    maxErrors: DEFAULT_MAX_ERRORS,

    /**
     * Hook fired from MaterialCache.preload (bulk-catch before re-throw),
     * MaterialCache.preloadBatch (after console.warn), and entities.js
     * (after both surface-pixel console.warns). Meta shape:
     *   { did?, dids?, error, source: "preload"|"batch"|"surface" }
     */
    onMaterialError(meta) {
      try {
        const m = meta || {};
        const entry = {
          ts: performance.now(),
          source: m.source || "unknown",
          error: errStr(m.error),
        };
        if (m.did != null) entry.did = hexDid(m.did);
        if (Array.isArray(m.dids)) entry.dids = m.dids.map(hexDid);
        else if (m.dids && typeof m.dids[Symbol.iterator] === "function") {
          // Uint32Array / Set — coerce via spread
          entry.dids = [...m.dids].map(hexDid);
        }
        if (m.guid != null) entry.guid = hexDid(m.guid);
        pushCapped(assets.materialErrors, entry, assets.maxErrors);
      } catch (_) { /* never throw out of a hook */ }
    },

    /**
     * Hook fired from AnimationCache.get (wraps the wasm fetchKeyframes
     * promise) and AnimationCache.getBatch (before the prewarmedSetupIds
     * rollback). Meta shape:
     *   { setupId?, setupIds?, mtableId?, motionCmd?, stance?, error,
     *     source: "get"|"getBatch" }
     */
    onAnimationError(meta) {
      try {
        const m = meta || {};
        const entry = {
          ts: performance.now(),
          source: m.source || "unknown",
          error: errStr(m.error),
        };
        if (m.setupId != null) entry.setupId = (m.setupId >>> 0);
        if (m.setupIds != null) {
          entry.setupIds = Array.isArray(m.setupIds)
            ? m.setupIds.map((x) => x >>> 0)
            : [...m.setupIds].map((x) => x >>> 0);
        }
        if (m.mtableId != null) entry.mtableId = (m.mtableId >>> 0);
        if (m.motionCmd != null) entry.motionCmd = (m.motionCmd >>> 0);
        if (m.stance != null) entry.stance = (m.stance >>> 0);
        pushCapped(assets.animationErrors, entry, assets.maxErrors);
      } catch (_) { /* never throw out of a hook */ }
    },

    /**
     * Hook fired from AnimationCache.get's per-part
     * `meshToGeometryGroups(partMesh)` silent catch. Meta:
     *   { partIndex, setupId, error }
     * These are the cheapest to lose track of (the existing catch returns
     * an empty groups stub and continues), so we always record them.
     */
    onMeshError(meta) {
      try {
        const m = meta || {};
        const entry = {
          ts: performance.now(),
          partIndex: (m.partIndex != null) ? (m.partIndex | 0) : null,
          setupId: (m.setupId != null) ? (m.setupId >>> 0) : null,
          error: errStr(m.error),
        };
        pushCapped(assets.meshErrors, entry, assets.maxErrors);
      } catch (_) { /* never throw out of a hook */ }
    },

    /**
     * Read-through to live cache state. Returns the count of currently
     * in-flight fetches per cache. Safe to call before liveScene3d is
     * installed — all hops are optional-chained.
     */
    pending() {
      const ls = (typeof window !== "undefined") ? window.liveScene3d : null;
      return {
        materials: ls?.materialCache?.pendingFetches?.size ?? 0,
        animations: ls?.entityManager?.animationCache?.entries?.size ?? 0,
      };
    },

    /** Aggregate counts: errors + pending per cache. */
    summary() {
      const p = assets.pending();
      return {
        material: { errors: assets.materialErrors.length, pending: p.materials },
        animation: { errors: assets.animationErrors.length, pending: p.animations },
        mesh: { errors: assets.meshErrors.length },
      };
    },

    /**
     * v2 stuck-detector: read pendingFetches / entries and find ones older
     * than `thresholdMs`. The current caches don't record per-entry
     * start-times, so the implementation returns a `note` placeholder.
     * Adding start-time instrumentation in `MaterialCache.preload`'s
     * pending-promise install + `AnimationCache.get`'s entries set is the
     * follow-on. Keeping the entry point so harness code can call it
     * unconditionally and check `.note` to decide whether to ignore.
     */
    stuck(_thresholdMs) {
      return { note: "not implemented — caches don't track per-entry startTimes yet" };
    },

    /** Clear all three rings. Idempotent. */
    reset() {
      assets.materialErrors.length = 0;
      assets.animationErrors.length = 0;
      assets.meshErrors.length = 0;
    },
  };

  diag.assets = assets;
}
