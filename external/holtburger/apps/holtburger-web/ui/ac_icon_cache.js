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
// ---------------------------------------------------------------------
// P0.4 / LEAK-03 (2026-07-27) — bounded, and failures no longer latch.
//
// Wave-3 finding `docs/acclient-deep-dive-mining/wave3-G-leaks-indextooling.md`
// §LEAK-03, live-corroborated by RQ-32 ("icons fail to load and then stay
// broken for the whole session"). Before this change the module held ONE
// `Map` mixing three value kinds with no cap, no eviction, no `clear()`,
// no `delete` — and it stored `false` on failure permanently, so a
// transient wasm-not-yet-ready or a single decode error silenced that icon
// until reload.
//
// Retail is the parity target and it got this right: the icon resource pool
// (type 12 `DB_TYPE_RENDERSURFACE`) is registered with `m_nIdealSize = 100` /
// `m_nMaxSize = 400` (`acclient.c:92388-92391`) and that cap is enforced AT
// INSERTION — `DBOCache::FreelistAdd` appends, then evicts the oldest while
// `m_nFree > m_nMaxSize` (`acclient.c:83193-83201`). So retail's steady-state
// icon ceiling is 400 entries. Ours is the same number, LRU-evicted at
// insertion.
//
// This is also the third occurrence in this codebase of
// latch-a-transient-failure-as-truth. `src/lib.rs:8901-8925` already learned
// it (a shard blip latched a surface grey for the whole session) and the fix
// was to memoise absence ONLY on an authoritative proof. We have no
// authoritative "this icon does not exist" proof here, so failures go into a
// SEPARATE, TTL'd negative map — never into the success cache.
//
// Storage layout (three disjoint maps, so no value is ever ambiguous):
//   `iconCache`   Map<iconId, dataUrl:string>   — LRU, capped at ICON_CACHE_MAX
//   `inflight`    Map<iconId, Promise>          — self-retiring, uncapped by
//                                                 construction (bounded by
//                                                 concurrent callers)
//   `negative`    Map<iconId, expiryMs:number>  — TTL'd, capped
//
// The PUBLIC contract is unchanged, so every plugin wrapper is untouched:
//   - returns null            → iconId 0 (no-op short-circuit)
//   - returns string          → data URL (success)
//   - returns false           → fetch failed / wasm missing / 0 px
//   - `await`ing is always safe (in-flight requests are deduped internally)
// ---------------------------------------------------------------------

import {
  itemBackgroundDid,
  itemEffectTileDid,
  spellIconLayers,
  composeItemIcon,
  composeSpellIcon,
  replaceWhiteWithBlack,
  rgbaToPngDataUrl,
} from "./ac_icon_compose.js";

/** Resolved data URLs. Insertion-ordered → the first key is the LRU victim. */
const iconCache = new Map();
/** In-flight fetches, deduped per iconId. Retired in `finally` on both arms. */
const inflight = new Map();
/** Failed iconIds → `performance.now()` past which a retry is allowed. */
const negative = new Map();

/** Running sum of `dataUrl.length` over `iconCache` (base64 is ASCII, so
 *  length == bytes). Maintained incrementally so `iconCacheStats()` is O(1)
 *  and can be polled per-frame by a harness without walking the map. */
let cachedBytes = 0;
/** LRU victims dropped at insertion (retail `FreelistAdd` parity counter). */
let iconEvictions = 0;
/** Negative-cache entries that expired and were re-attempted (the RQ-32 fix
 *  firing — under the old code this could only ever be 0). */
let iconRetries = 0;

/** Retail parity: `m_nMaxSize = 400` for `DB_TYPE_RENDERSURFACE`
 *  (`acclient.c:92388-92391`). Overridable via `?iconCacheMax=N` — the only
 *  reason to raise it is `?preloadIcons=1`, which walks 4,224 ids and would
 *  otherwise leave only the last 400 resident. `?iconCacheMax=0` disables the
 *  cap (the pre-P0.4 behaviour, kept purely as an A/B escape). */
export const ICON_CACHE_MAX_DEFAULT = 400;

/** How long a failure is remembered before a retry is allowed. Short enough
 *  that a boot-time "wasm not ready yet" resolves within a couple of UI
 *  repaints, long enough that a genuinely-missing DID is not re-fetched on
 *  every hover. Overridable via `?iconNegTtlMs=N`. */
export const ICON_NEG_TTL_MS_DEFAULT = 10_000;

function readNumericFlag(name, fallback) {
  try {
    if (typeof window === "undefined" || !window.location) return fallback;
    const raw = new URLSearchParams(window.location.search).get(name);
    if (raw == null) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return fallback;
    return v;
  } catch (_) {
    return fallback;
  }
}

const ICON_CACHE_MAX = readNumericFlag("iconCacheMax", ICON_CACHE_MAX_DEFAULT);
const ICON_NEG_TTL_MS = readNumericFlag("iconNegTtlMs", ICON_NEG_TTL_MS_DEFAULT);

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** LRU touch — re-inserting moves the key to the end of the Map's insertion
 *  order, so the *first* key is always the least-recently-used. */
function touch(iconId) {
  const v = iconCache.get(iconId);
  if (v === undefined) return undefined;
  iconCache.delete(iconId);
  iconCache.set(iconId, v);
  return v;
}

/** Insert a resolved data URL, evicting LRU victims until at/under the cap.
 *  Capped AT INSERTION, exactly as retail's `FreelistAdd` does — allocation
 *  can never outpace eviction. */
function storeSuccess(iconId, dataUrl) {
  const prev = iconCache.get(iconId);
  if (prev !== undefined) {
    cachedBytes -= prev.length;
    iconCache.delete(iconId);
  }
  iconCache.set(iconId, dataUrl);
  cachedBytes += dataUrl.length;
  if (ICON_CACHE_MAX > 0) {
    while (iconCache.size > ICON_CACHE_MAX) {
      const victim = iconCache.keys().next();
      if (victim.done) break;
      const vv = iconCache.get(victim.value);
      if (typeof vv === "string") cachedBytes -= vv.length;
      iconCache.delete(victim.value);
      iconEvictions += 1;
    }
  }
}

/** Record a failure with a TTL instead of latching it forever. Bounded by the
 *  same cap so a pathological id storm cannot grow it without limit. */
function storeFailure(iconId) {
  negative.set(iconId, nowMs() + ICON_NEG_TTL_MS);
  if (ICON_CACHE_MAX > 0) {
    while (negative.size > ICON_CACHE_MAX) {
      const victim = negative.keys().next();
      if (victim.done) break;
      negative.delete(victim.value);
    }
  }
}

/** True when `iconId` failed recently enough that a retry is still suppressed.
 *  Expired entries are deleted on read, so a later request genuinely retries. */
function failureSuppressed(iconId) {
  const until = negative.get(iconId);
  if (until === undefined) return false;
  if (nowMs() >= until) {
    negative.delete(iconId);
    iconRetries += 1;
    return false;
  }
  return true;
}

/** Lazy fetch — drops into a plugin's `fetchIconDataUrl(iconId)` slot
 *  exactly. `label` only changes the `console.warn` prefix on failure.
 */
export async function fetchIconDataUrl(iconId, label = "ac-icon-cache") {
  if (!iconId) return null;
  const hit = touch(iconId);
  if (hit !== undefined) return hit;
  const pending = inflight.get(iconId);
  if (pending !== undefined) return pending;
  // P0.4: a past failure suppresses the retry only until its TTL expires.
  if (failureSuppressed(iconId)) return false;
  const wasm = window.__hbWasm ?? window.__wasm ?? null;
  // Icons are RenderSurface (0x06xxxxxx) records — they need the icon
  // entry point, NOT `fetch_surface_pixels` (which expects Surface
  // 0x08xxxxxx + walks Surface→SurfaceTexture→RenderSurface for 3D
  // materials). Feeding a 0x06 DID into the Surface walker mis-parses
  // it as a Surface record and returns garbage / empty — the original
  // symptom that left every inventory slot blank.
  const fetchIcon = wasm?.fetch_icon_pixels ?? wasm?.fetch_surface_pixels;
  if (!fetchIcon) {
    // P0.4 / RQ-32: this is the single most transient failure in the module —
    // a panel that paints before wasm boots used to blank its icons for the
    // whole session. TTL'd, so the next repaint past the TTL succeeds.
    storeFailure(iconId);
    return false;
  }
  const promise = (async () => {
    try {
      const r = await fetchIcon(iconId >>> 0);
      if (!r || !r.width || !r.height || !r.pixels?.length) return false;
      // Bug 12 (2026-10-07): encode the PNG directly — no canvas readback
      // (privacy-hardened browsers return canvas readbacks as blank/white).
      return rgbaToPngDataUrl(r.width, r.height, new Uint8Array(r.pixels));
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
  inflight.set(iconId, promise);
  let url;
  try {
    url = await promise;
  } finally {
    // Retire on BOTH arms — an in-flight registry that survives its terminal
    // outcome is the LEAK-08 shape, and this one would also wedge the icon.
    inflight.delete(iconId);
  }
  if (typeof url === "string") storeSuccess(iconId, url);
  else storeFailure(iconId);
  return url;
}

/* ── retail icon composition (bug 12, 2026-10-07) ─────────────────────
 * See ./ac_icon_compose.js for the retail/OpenAC rules. Decoded layers
 * (icons and the shared background / effect tiles) are cached as RGBA; the
 * finished composites live in the same LRU as raw icons, under string keys.
 */
const RGBA_CACHE_MAX = 512;
const rgbaCache = new Map();
const rgbaInflight = new Map();
const _composeLogged = new Set();

/** Decoded RGBA of one RenderSurface (`0x06xxxxxx`), or null. */
export async function fetchIconRgba(did, label = "ac-icon-cache:rgba") {
  const id = did >>> 0;
  if (!id) return null;
  const hit = rgbaCache.get(id);
  if (hit) {
    rgbaCache.delete(id);
    rgbaCache.set(id, hit);
    return hit;
  }
  const pending = rgbaInflight.get(id);
  if (pending) return pending;
  const negKey = `rgba:${id}`;
  if (failureSuppressed(negKey)) return null;
  const wasm = (typeof window !== "undefined") ? (window.__hbWasm ?? window.__wasm ?? null) : null;
  const fetchIcon = wasm?.fetch_icon_pixels;
  if (!fetchIcon) {
    storeFailure(negKey);
    return null;
  }
  const p = (async () => {
    try {
      const r = await fetchIcon(id);
      if (!r || !r.width || !r.height) return null;
      const px = r.pixels;
      if (!px?.length) return null;
      const out = { width: r.width >>> 0, height: r.height >>> 0, pixels: new Uint8ClampedArray(px) };
      try { r.free?.(); } catch (_) {}
      return out;
    } catch (e) {
      console.warn(`[${label}] icon layer 0x${id.toString(16)} fetch failed:`, e);
      return null;
    }
  })();
  rgbaInflight.set(id, p);
  let v;
  try { v = await p; } finally { rgbaInflight.delete(id); }
  if (v) {
    rgbaCache.set(id, v);
    while (rgbaCache.size > RGBA_CACHE_MAX) rgbaCache.delete(rgbaCache.keys().next().value);
  } else {
    storeFailure(negKey);
  }
  return v;
}

async function _composedOnce(key, build) {
  const hit = touch(key);
  if (hit !== undefined) return hit;
  const pending = inflight.get(key);
  if (pending !== undefined) return pending;
  if (failureSuppressed(key)) return false;
  const promise = (async () => {
    try { return await build(); } catch (e) {
      console.warn(`[icon-compose] ${key} failed:`, e);
      return false;
    }
  })();
  inflight.set(key, promise);
  let url;
  try { url = await promise; } finally { inflight.delete(key); }
  if (typeof url === "string") storeSuccess(key, url);
  else storeFailure(key);
  return url;
}

/** Cache key of a retail item composite (shared by the immediate lookup). */
export function itemIconKey(meta, drag = false) {
  const iconId = (meta?.iconId >>> 0) || 0;
  const bg = drag ? 0 : itemBackgroundDid(meta?.itemType >>> 0);
  const und = drag ? 0 : ((meta?.iconUnderlay >>> 0) || 0);
  const ovl = (meta?.iconOverlay >>> 0) || 0;
  const fx = itemEffectTileDid(meta?.uiEffects >>> 0);
  return `item:${bg}:${und}:${iconId}:${ovl}:${fx}:${drag ? 1 : 0}`;
}

/**
 * Retail item icon (`IconData::RenderIcons`): type background + custom
 * underlay + (icon + overlay, white → UI-effect tile). `drag: true` returns the
 * drag icon (no background). Resolves to a data URL, `false` on failure, or
 * null for iconId 0.
 * @param {{iconId:number,itemType?:number,uiEffects?:number,iconUnderlay?:number,iconOverlay?:number}} meta
 */
export function fetchItemIconDataUrl(meta, label = "item-icon", opts = {}) {
  const iconId = (meta?.iconId >>> 0) || 0;
  if (!iconId) return Promise.resolve(null);
  const drag = !!opts.drag;
  const key = itemIconKey(meta, drag);
  return _composedOnce(key, async () => {
    const bg = drag ? 0 : itemBackgroundDid(meta.itemType >>> 0);
    const und = drag ? 0 : ((meta.iconUnderlay >>> 0) || 0);
    const ovl = (meta.iconOverlay >>> 0) || 0;
    const fx = itemEffectTileDid(meta.uiEffects >>> 0);
    const [bgI, undI, icI, ovI, fxI] = await Promise.all([
      bg ? fetchIconRgba(bg, label) : null,
      und ? fetchIconRgba(und, label) : null,
      fetchIconRgba(iconId, label),
      ovl ? fetchIconRgba(ovl, label) : null,
      fetchIconRgba(fx, label),
    ]);
    if (!icI) return false;
    const { icon, drag: dragImg } = composeItemIcon({
      background: bgI, underlay: undI, icon: icI, overlay: ovI, effectTile: fxI,
    });
    const img = drag ? dragImg : icon;
    if (!img) return false;
    if (!_composeLogged.has(key) && _composeLogged.size < 64) {
      _composeLogged.add(key);
      console.info(
        `[icon-compose] icon=0x${iconId.toString(16)} type=0x${((meta.itemType >>> 0) || 0).toString(16)} ` +
        `bg=0x${bg.toString(16)} fx=0x${fx.toString(16)} ovl=0x${ovl.toString(16)} und=0x${und.toString(16)}${drag ? " (drag)" : ""}`,
      );
    }
    return rgbaToPngDataUrl(img.width, img.height, img.pixels);
  });
}

/** Synchronous composite lookup (null until composed once). */
export function getItemIconImmediate(meta, drag = false) {
  if (!(meta?.iconId >>> 0)) return null;
  const v = touch(itemIconKey(meta, drag));
  return typeof v === "string" ? v : null;
}

function _spellRecord(spellId) {
  try {
    const rec = window.__sessionHandle?.getSpellRecord?.(spellId >>> 0);
    if (!rec) return null;
    const get = (k) => (rec instanceof Map ? rec.get(k) : rec[k]);
    const comps = get("components");
    return {
      iconId: (get("iconId") >>> 0) || 0,
      bitfield: (get("bitfield") >>> 0) || 0,
      firstComponent: Array.isArray(comps) && comps.length ? (comps[0] >>> 0) : 0,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Retail spell icon (`ClientMagicSystem::CompositeSpellIcon`): power-component
 * backing + icon, white → Reversed/NonReversed tile, self/fellowship overlay.
 */
export function fetchSpellIconDataUrl(spellId, label = "spell-icon") {
  const sid = (spellId >>> 0) & 0x7fffffff;
  if (!sid) return Promise.resolve(null);
  const rec = _spellRecord(sid);
  if (!rec || !rec.iconId) return Promise.resolve(null);
  const layers = spellIconLayers(rec);
  const key = `spell:${sid}:${layers.backing}:${layers.icon}:${layers.tint}:${layers.overlay}`;
  return _composedOnce(key, async () => {
    const [b, i, t, o] = await Promise.all([
      layers.backing ? fetchIconRgba(layers.backing, label) : null,
      fetchIconRgba(layers.icon, label),
      layers.tint ? fetchIconRgba(layers.tint, label) : null,
      layers.overlay ? fetchIconRgba(layers.overlay, label) : null,
    ]);
    if (!i) return false;
    const img = composeSpellIcon({ backing: b, icon: i, tint: t, overlay: o });
    if (!img) return false;
    return rgbaToPngDataUrl(img.width, img.height, img.pixels);
  });
}

/** Retail spell-component icon (`CompositeSpellComponentIcon`): white → black. */
export function fetchSpellComponentIconDataUrl(iconId, label = "component-icon") {
  const id = iconId >>> 0;
  if (!id) return Promise.resolve(null);
  return _composedOnce(`comp:${id}`, async () => {
    const i = await fetchIconRgba(id, label);
    if (!i) return false;
    const img = { width: i.width, height: i.height, pixels: new Uint8ClampedArray(i.pixels) };
    replaceWhiteWithBlack(img);
    return rgbaToPngDataUrl(img.width, img.height, img.pixels);
  });
}

/** Synchronous lookup — returns the cached data URL if it's
 *  already-resolved (post-preload or post-lazy-fetch), otherwise null.
 *  Lets a plugin skip the await entirely in the preloaded path. */
export function getIconImmediate(iconId) {
  if (!iconId) return null;
  const v = touch(iconId);
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
 *
 *  P0.4 note: the cache is now capped at `ICON_CACHE_MAX` (400, retail
 *  parity), so a 4,224-id preload leaves only the last 400 RESIDENT — the
 *  `loaded` count still reports every successful decode. If you actually want
 *  the whole manifest in memory, raise the cap explicitly with
 *  `?iconCacheMax=4224` (≈30 MB) or `?iconCacheMax=0` (uncapped).
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
  return iconCache.size + inflight.size + negative.size;
}

/** P0.4 / LEAK-03 instrument — surfaced as `window.__diag.iconCache()`
 *  (`scene3d/index.js`). `iconMB` is the fourth byte-sum tally alongside
 *  `matMB` / `palMB` / `entMB`.
 *
 *  Reading it:
 *   - `resident` pinned at `cap` with `evictions` climbing → the cap is doing
 *     its job; this is the healthy bounded steady state.
 *   - `negative` > 0 and `retries` climbing → transient failures are expiring
 *     and being re-attempted, i.e. RQ-32's permanent-blank class is gone.
 *   - `negative` large and `retries` flat → the failures are real (bad DIDs),
 *     not transient.
 *   - `resident` well under `cap` after a long session answers wave3-G open
 *     question 3: the lazy path never approaches the 30 MB ceiling. */
export function iconCacheStats() {
  return {
    resident: iconCache.size,
    inflight: inflight.size,
    negative: negative.size,
    cap: ICON_CACHE_MAX,
    negTtlMs: ICON_NEG_TTL_MS,
    evictions: iconEvictions,
    retries: iconRetries,
    bytes: cachedBytes,
    iconMB: +(cachedBytes / (1024 * 1024)).toFixed(3),
  };
}

/** Test/teardown hook — drop everything. Not called on the hot path; exists
 *  so a headless test can assert eviction/TTL behaviour from a clean slate,
 *  and so a future world-teardown can reclaim the pool (retail frees its icon
 *  shells' payloads on eviction; we free the whole entry). */
export function resetIconCache() {
  iconCache.clear();
  inflight.clear();
  negative.clear();
  rgbaCache.clear();
  rgbaInflight.clear();
  _composeLogged.clear();
  cachedBytes = 0;
  iconEvictions = 0;
  iconRetries = 0;
}
