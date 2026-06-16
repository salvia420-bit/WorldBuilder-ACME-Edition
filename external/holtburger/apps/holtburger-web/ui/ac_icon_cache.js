// Wave 15 — shared icon cache + opt-in bulk preload.
//
// Pre-Wave 15 each plugin (vendor-ui, container-panel, trade-panel,
// buffs-hud, spell-research-panel, inventory) carried its own
// `iconCache: Map<iconId, dataUrlOrPromise>` + an identical
// `fetchIconDataUrl(iconId)` helper. Wave 15 consolidates the cache so
// the same icon fetched first by, say, the inventory panel is
// instantly available the next time the vendor-ui re-asks for it.
// The plugin wrappers stay (each carries its own label for the
// `console.warn` message) but delegate to `fetchIconDataUrl` here.
//
// The shared module also enables the opt-in `?preloadIcons=1` flag
// (apps/holtburger-web/scene3d/index.js + plugins/loop.js). When the
// flag is set, `preloadAllIcons()` walks every iconId in
// `data/icon-manifest.json` and fetches them in batches; results
// populate this same cache so subsequent lazy fetches return
// synchronously. Default OFF — load time is the concern; bulk preload
// costs ~3-8 s + ~30 MB RAM (4 KB to ~6 KB per icon, 4,224 icons in
// the v1 manifest). See `docs/wave-15-icon-preload-2026-05-26.md`.
//
// Cache semantics (matches the pre-Wave 15 per-plugin helper exactly
// so dropping each plugin's local copy is a 1:1 swap):
//   - Value === undefined      → not seen yet
//   - Value instanceof Promise → in flight; await it
//   - Value === string         → data URL (success)
//   - Value === false          → fetch failed / wasm missing / 0 px
//   - Value === null           → iconId 0 (no-op short-circuit)

const iconCache = new Map();

/** Lazy fetch — drops into a plugin's `fetchIconDataUrl(iconId)` slot
 *  exactly. `label` only changes the `console.warn` prefix on failure.
 */
export async function fetchIconDataUrl(iconId, label = "ac-icon-cache") {
  if (!iconId) return null;
  const cached = iconCache.get(iconId);
  if (cached !== undefined) {
    if (cached instanceof Promise) return cached;
    return cached;
  }
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  // Icons are RenderSurface (0x06xxxxxx) records — they need the icon
  // entry point, NOT `fetch_surface_pixels` (which expects Surface
  // 0x08xxxxxx + walks Surface→SurfaceTexture→RenderSurface for 3D
  // materials). Feeding a 0x06 DID into the Surface walker mis-parses
  // it as a Surface record and returns garbage / empty — the original
  // symptom that left every inventory slot blank.
  const fetchIcon = wasm?.fetch_icon_pixels ?? wasm?.fetch_surface_pixels;
  if (!fetchIcon) {
    iconCache.set(iconId, false);
    return false;
  }
  const promise = (async () => {
    try {
      const r = await fetchIcon(iconId >>> 0);
      if (!r || !r.width || !r.height || !r.pixels?.length) return false;
      const canvas = document.createElement("canvas");
      canvas.width = r.width; canvas.height = r.height;
      const cx = canvas.getContext("2d");
      const img = cx.createImageData(r.width, r.height);
      img.data.set(r.pixels);
      cx.putImageData(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      console.warn(`[${label}] icon ${iconId} fetch failed:`, e);
      // HUD rec #204 — surface to diag so missing-icon telemetry can
      // identify DIDs that never resolved (palette/surface mis-routes,
      // missing baked records, decode crashes). Caller's label and
      // iconId both captured for trace.
      try {
        window.__diag?.clothing?.onIconFetchFailure?.({
          iconId: iconId >>> 0,
          label,
          message: String(e?.message ?? e),
        });
      } catch (_) {}
      return false;
    }
  })();
  iconCache.set(iconId, promise);
  const url = await promise;
  iconCache.set(iconId, url);
  return url;
}

/** Synchronous lookup — returns the cached data URL if it's
 *  already-resolved (post-preload or post-lazy-fetch), otherwise null.
 *  Lets a plugin skip the await entirely in the preloaded path. */
export function getIconImmediate(iconId) {
  if (!iconId) return null;
  const v = iconCache.get(iconId);
  if (typeof v === "string") return v;
  return null;
}

/** Opt-in bulk preload — fetches every icon in
 *  `data/icon-manifest.json` and populates the cache. Default-OFF; the
 *  scene3d boot path only invokes this when `?preloadIcons=1` is set
 *  (apps/holtburger-web/scene3d/index.js). Returns
 *  `{ total, loaded, failed, durationMs }`.
 *
 *  `batchSize` is the count of in-flight fetches before awaiting
 *  Promise.all and starting the next batch — bounds concurrency so
 *  the wasm thread isn't swamped. 32 keeps CPU/IO interleaved without
 *  starving rAF.
 */
export async function preloadAllIcons(options = {}) {
  const { batchSize = 32, onProgress = null } = options;
  const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
  let manifest;
  try {
    const res = await fetch("./data/icon-manifest.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    console.warn("[ac-icon-cache] manifest fetch failed:", e);
    return { total: 0, loaded: 0, failed: 0, durationMs: 0, error: String(e) };
  }
  const ids = Array.isArray(manifest?.iconIds) ? manifest.iconIds : [];
  let loaded = 0;
  let failed = 0;
  // Batch in groups of `batchSize` so the wasm thread isn't swamped
  // and onProgress fires at a usable cadence.
  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize);
    const results = await Promise.all(
      slice.map((iconId) =>
        fetchIconDataUrl(iconId, "ac-icon-cache:preload").then(
          (v) => (typeof v === "string"),
          () => false,
        )
      )
    );
    for (const ok of results) {
      if (ok) loaded += 1;
      else failed += 1;
    }
    if (typeof onProgress === "function") {
      try { onProgress({ loaded, failed, total: ids.length }); }
      catch (_) { /* progress callback isn't load-bearing */ }
    }
  }
  const t1 = (typeof performance !== "undefined") ? performance.now() : Date.now();
  return {
    total: ids.length,
    loaded,
    failed,
    durationMs: Math.round(t1 - t0),
  };
}

/** Diagnostic — current cache size (resolved + in-flight + failed). */
export function iconCacheSize() {
  return iconCache.size;
}
