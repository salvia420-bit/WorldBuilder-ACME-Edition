// scene3d/surface_planes.js
//
// 2026-08-05 — the atlas-staging seam: "give me the pixels for this surface",
// answered from a source that is NOT the three.js texture's CPU copy.
//
// WHY. The renderer process OOM-crashes at ~2,800 MB of a 4,192 MB cap, and
// 1,332 MB of the heap is CPU-side copies of pixels that are already on the GPU
// (measured 2026-08-05; see the handoff §9). three keeps `image.data` alive for
// the life of a texture and nothing releases it. The reason we cannot simply
// release it is that the statics atlas STAGES FROM IT — the diffuse layer write
// reads `img.data` (`static_atlas.js:1203-1205`) and `packNraLayer` reads the
// normal / roughness / AO / height planes (`static_atlas.js:297-341`) — and
// "uploaded first, atlased later" is routine, because LRU evict → re-enter frees
// the layer while the texture survives (`landblock_lru.js:1730` skips
// `__cacheOwned`).
//
// So this module makes the texture ONE source rather than THE source:
//
//     1. the texture's own `image.data`, when it still has it — byte-identical
//        to today, zero behaviour change while nothing releases anything;
//     2. the wasm decode memo, synchronously, via `surfacePlanesCached(did)`;
//     3. neither — report a MISS, and let the caller defer the node for a round
//        (the mechanism `bc7AtlasShouldDefer` already implements) while
//        `warmPlanes()` re-decodes asynchronously.
//
// Tier 3 is the normal path, not an edge case: `?surfaceBudgetMB` caps the wasm
// store at 24 MB on the main thread, far under a route's working set, so a
// synchronous memo hit for an arbitrary DID is the exception. Any consumer of
// this module must therefore treat "not this tick" as ordinary control flow.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: decode. Nothing here fetches or
// parses on the calling thread. The one async entry point (`warmPlanes`) hands
// the work to the existing wasm export and returns; the synchronous accessors
// only ever read a cache.

/** Plane selector. Matches the five per-surface planes `adapter.js` builds. */
export const PLANE = {
  ALBEDO: "albedo",
  NORMAL: "normal",
  HEIGHT: "height",
  ROUGHNESS: "roughness",
  AO: "ao",
};

const _stats = {
  fromTexture: 0,
  fromWasm: 0,
  miss: 0,
  warmRequests: 0,
  warmCompleted: 0,
  warmFailed: 0,
};

/** Which wasm exports we were handed. Set once by `initSurfacePlanes`. */
let _wasm = null;

/**
 * @param {object} wasmExports the curated init3D exports bag. Read via the
 *   namespace-style `typeof x === "function"` guard so a `pkg/` predating
 *   `surfacePlanesCached` degrades to tier 1 + tier 3 instead of throwing —
 *   the standing staleness trap in this tree.
 */
export function initSurfacePlanes(wasmExports) {
  _wasm = wasmExports || null;
}

/** The five plane readers, each returning the texture's own CPU bytes or null. */
function planeFromTexture(mat, which) {
  const tex =
    which === PLANE.ALBEDO ? mat?.map
    : which === PLANE.NORMAL ? mat?.normalMap
    : which === PLANE.ROUGHNESS ? mat?.roughnessMap
    : which === PLANE.AO ? mat?.aoMap
    : null;
  const data = tex?.image?.data;
  return data && data.byteLength ? { data, width: tex.image.width, height: tex.image.height } : null;
}

/** Pull the same plane out of a wasm `SurfacePixels` handle. */
function planeFromSurfacePixels(sp, which) {
  if (!sp) return null;
  const w = sp.width, h = sp.height;
  let data = null;
  try {
    if (which === PLANE.ALBEDO) data = sp.pixels;
    else if (which === PLANE.NORMAL) data = sp.normalPixels;
    else if (which === PLANE.HEIGHT) data = sp.heightPixels;
    // Roughness and AO are Phase-5 texchan sidecars, not part of the decode
    // memo's three planes. They stay on tier 1 until the sidecar path grows a
    // cached accessor of its own — flagged here rather than silently returning
    // null-shaped garbage, because a caller that got zeros for roughness would
    // render a subtly wrong surface and never know.
    else return null;
  } catch (_) {
    return null;
  }
  return data && data.byteLength ? { data, width: w, height: h } : null;
}

/**
 * The plane for `mat`'s `which` map, from whichever source can supply it now.
 *
 * Returns `{ data, width, height, source }` or `null` for "not this tick".
 * `source` is `"texture"` or `"wasm"` so a consumer can tell a same-tick answer
 * from a cache answer, and so the diag can prove which tier is carrying load.
 *
 * `surfaceDid` is required for the wasm tier — the material does not carry it.
 */
export function planeFor(mat, which, surfaceDid) {
  const own = planeFromTexture(mat, which);
  if (own) {
    _stats.fromTexture += 1;
    return { ...own, source: "texture" };
  }
  if (_wasm && typeof _wasm.surfacePlanesCached === "function" && surfaceDid) {
    let sp = null;
    try {
      sp = _wasm.surfacePlanesCached(surfaceDid >>> 0);
    } catch (_) {
      sp = null;
    }
    const p = planeFromSurfacePixels(sp, which);
    // wasm-bindgen handles are JS-owned; free promptly rather than waiting for
    // the GC to notice, or the seam becomes its own retainer.
    try { sp?.free?.(); } catch (_) { /* already freed / not a handle */ }
    if (p) {
      _stats.fromWasm += 1;
      return { ...p, source: "wasm" };
    }
  }
  _stats.miss += 1;
  return null;
}

/**
 * Can pixels for this DID be supplied at all?
 *
 * This is the predicate that must replace the `img.data`-existence gates which
 * decide whether a static can be BATCHED (`statics.js:2379`,
 * `static_atlas.js:1121`). Those gates ask "does this texture still carry its
 * CPU bytes"; once the copies are released they would answer no for everything
 * and route every node to an unbatched singleton — a frame-rate regression back
 * toward the ~5,400-draw-call wall the atlas exists to remove, invisible to any
 * eye-test for blackness. The honest question is this one.
 */
export function canSupplyPlanes(mat, surfaceDid) {
  if (planeFromTexture(mat, PLANE.ALBEDO)) return true;
  if (_wasm && typeof _wasm.surfacePlanesCachedHas === "function" && surfaceDid) {
    try {
      if (_wasm.surfacePlanesCachedHas(surfaceDid >>> 0)) return true;
    } catch (_) { /* fall through */ }
  }
  return false;
}

/**
 * Warm the wasm memo for these DIDs so a later `planeFor` can answer
 * synchronously. Fire-and-forget; never throws.
 *
 * Batched through `fetch_surfaces_pixels` when available — the batch export is
 * the one the decode-once invariant (`decodeAmp ≈ 1.0`) is measured against, and
 * a per-DID loop would break the walk-dedupe that invariant depends on.
 */
export async function warmPlanes(surfaceDids) {
  const dids = [...new Set((surfaceDids || []).map((d) => d >>> 0).filter(Boolean))];
  if (!dids.length || !_wasm) return 0;
  _stats.warmRequests += dids.length;
  try {
    if (typeof _wasm.fetch_surfaces_pixels === "function") {
      const out = await _wasm.fetch_surfaces_pixels(new Uint32Array(dids));
      // The batch hands back JS-owned handles; the memo is already warm, so free
      // them immediately instead of holding a second reference to every plane.
      if (Array.isArray(out)) for (const sp of out) { try { sp?.free?.(); } catch (_) {} }
      _stats.warmCompleted += dids.length;
      return dids.length;
    }
    if (typeof _wasm.fetch_surface_pixels === "function") {
      for (const d of dids) {
        const sp = await _wasm.fetch_surface_pixels(d);
        try { sp?.free?.(); } catch (_) {}
      }
      _stats.warmCompleted += dids.length;
      return dids.length;
    }
  } catch (_) {
    _stats.warmFailed += dids.length;
  }
  return 0;
}

/** Diag counters — which tier is actually carrying the atlas feed. */
export function surfacePlanesStats() {
  return { ..._stats, wasmReady: !!(_wasm && typeof _wasm.surfacePlanesCached === "function") };
}

/** Test hook. */
export function __resetSurfacePlanesForTests() {
  _wasm = null;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}
