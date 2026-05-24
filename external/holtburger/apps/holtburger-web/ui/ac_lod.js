/**
 * AC GfxObjDegradeInfo (DAT 0x11) LOD-chain lookup runtime.
 *
 * Wraps `fetch_gfx_obj_degrade_info(degradeId)` with a small JS layer
 * for picking the right LOD band for a given camera distance.
 *
 *   - `loadDegradeInfo(degradeId)`     → Promise<DegradeRuntime | null>
 *   - `getDegradeInfo(degradeId)`      → DegradeRuntime | null  (sync)
 *   - `pickDegradeBand(runtime, dist)` → GfxObjInfo | null
 *
 * Retail behavior (acclient.c `GfxObjDegradeInfo::get_degrade(distance)`)
 * is a continuous per-frame lookup; statics in this client already
 * use spawn-time substitution via `resolve_did_degrade` (lib.rs:4475).
 * Entity-side LOD integration is deferred — this runtime is the
 * read-only data layer; see
 * `docs/handoff-degrade-info-entity-lod-2026-05-24.md` for the
 * proposed spawn-time integration shape.
 */

const runtimes = new Map();
const inFlight = new Map();

/**
 * Load + cache a GfxObjDegradeInfo by DataID. Idempotent.
 *
 * @param {number} degradeId — DataID of the GfxObjDegradeInfo (0x11xxxxxx).
 * @returns {Promise<DegradeRuntime | null>}
 */
export async function loadDegradeInfo(degradeId) {
  const cached = runtimes.get(degradeId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(degradeId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_gfx_obj_degrade_info) {
      runtimes.set(degradeId, null);
      return null;
    }
    try {
      const json = await wasm.fetch_gfx_obj_degrade_info(degradeId >>> 0);
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.degrades) || data.degrades.length === 0) {
        try { window.__diag?.lod?.onLoadFailed?.({ degradeId, error: "empty", source: "empty" }); } catch (_) {}
        runtimes.set(degradeId, null);
        return null;
      }
      const runtime = {
        id: data.id >>> 0,
        bands: data.degrades.map((d) => ({
          gfxObjId: d.gfx_obj_id >>> 0,
          degradeMode: d.degrade_mode >>> 0,
          minDist: Number(d.min_dist),
          idealDist: Number(d.ideal_dist),
          maxDist: Number(d.max_dist),
        })),
      };
      runtimes.set(degradeId, runtime);
      try { window.__diag?.lod?.onLoadSucceeded?.({ degradeId, bandCount: runtime.bands.length }); } catch (_) {}
      return runtime;
    } catch (err) {
      console.warn(`[ac-lod] degrade-info 0x${degradeId.toString(16)} load failed:`, err);
      try { window.__diag?.lod?.onLoadFailed?.({ degradeId, error: err, source: "fetch" }); } catch (_) {}
      runtimes.set(degradeId, null);
      return null;
    } finally {
      inFlight.delete(degradeId);
    }
  })();
  inFlight.set(degradeId, promise);
  return promise;
}

/**
 * Sync accessor. Returns the cached DegradeInfo runtime or null.
 */
export function getDegradeInfo(degradeId) {
  const v = runtimes.get(degradeId);
  return v === undefined ? null : v;
}

/**
 * Pick the band whose distance window contains the camera distance.
 * Per `GfxObjInfo` semantics: band[i] is active when
 * `min_dist <= distance < max_dist`. Bands are usually ordered
 * ascending; this returns the FIRST band that matches (some retail
 * chains overlap, see degrade_info.rs::DEGRADE_0X11000001 fixture).
 *
 * Returns `null` when no band matches (use the full-detail mesh).
 *
 * @param {DegradeRuntime | null} runtime
 * @param {number} distance — meters from camera
 * @returns {{gfxObjId: number, degradeMode: number, minDist: number, idealDist: number, maxDist: number} | null}
 */
export function pickDegradeBand(runtime, distance) {
  if (!runtime?.bands?.length) return null;
  const d = Number(distance);
  if (!Number.isFinite(d) || d < 0) return null;
  for (const band of runtime.bands) {
    if (d >= band.minDist && d < band.maxDist) {
      try { window.__diag?.lod?.onBandHit?.({ degradeId: runtime.id, distance: d, gfxObjId: band.gfxObjId }); } catch (_) {}
      return band;
    }
  }
  try { window.__diag?.lod?.onBandMiss?.({ degradeId: runtime.id, distance: d, bandCount: runtime.bands.length }); } catch (_) {}
  return null;
}

/**
 * Diag-layer accessor. Used by `scene3d/diag/lod.js`.
 */
export function getLodDiagSnapshot() {
  return {
    chains: Array.from(runtimes.entries())
      .filter(([, r]) => r !== null)
      .map(([did, r]) => ({
        degradeId: did,
        bandCount: r.bands.length,
        distanceRange: r.bands.length > 0
          ? [r.bands[0].minDist, r.bands[r.bands.length - 1].maxDist]
          : null,
      })),
  };
}
