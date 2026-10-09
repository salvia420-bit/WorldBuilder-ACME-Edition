// scene3d/bandwidth_tier.js — the download-weight tier (`?bandwidth`).
//
// WHY THIS EXISTS (2026-10-06, measured on the 1070 through a shaped 666 kbps
// link): a cold boot of the default client pulls ~285 MB / ~9,550 requests to
// converge the spawn ring, and ~90% of it is OPTIONAL detail — the upscaled
// full-tier statics textures (xu7/BC7, ~109 MB), the 1024² terrain array
// (65 MB), the texchan roughness/AO sidecars (24 MB), the terrain detail-normal
// and far-macro PNG sets (18 MB) and the atmosphere LUT EXRs (7.4 MB). The
// world itself (geometry, cells, setups, animations, palettes) is ~3 MB. On a
// fast link none of that matters (the ring converges in ~150 s); at 666 kbps it
// is an hour of downloading, with the 3D scene blocked for ~8 min behind the
// detail-normal PNGs and no terrain for 30+ min.
//
// So the client picks ONE tier per session:
//   "high" — today's full-detail client, unchanged (the default on a fast link)
//   "low"  — skip the optional detail downloads listed above; statics keep the
//            retail-resolution textures they already decode from the DAT
//            records, terrain stops at the retail-native t512 tier, the sky is
//            generated on the GPU instead of downloaded.
//
// RESOLUTION ORDER (first hit wins):
//   1. `?bandwidth=low|high` (also `slow`/`fast`); `auto` falls through.
//   2. the saved user setting (Options → Graphics → Downloads), localStorage
//      `holtburger_bandwidth_v1` = "low" | "high" | "auto".
//   3. `navigator.connection.saveData` ⇒ low.
//   4. MEASURED throughput of this page's own boot downloads (resource timing:
//      the module graph + the wasm, several MB, all fetched before this is
//      first asked). Aggregate rate = bytes / busy-time over the UNION of the
//      transfer intervals, so concurrent downloads are not mistaken for a slow
//      link. Saved for the next visit (a warm boot reads from cache and has
//      nothing to measure).
//   5. the previous visit's measurement (≤ 30 days old).
//   6. `navigator.connection.downlink` (Chrome's Mbps estimate).
//   7. "high".
//
// A per-feature URL flag ALWAYS beats the tier (e.g. `?texXu7=on` keeps the
// upscaled tier even on a low session): every consumer checks its own
// parameter first and only consults the tier when that parameter is absent.
//
// Worker-safe: in a worker (no `window`/`localStorage`) everything resolves
// to "high" from the defaults — consumers that matter run on the main thread,
// and the bake worker's gfxRelief/quality values are forwarded from it.

/** ~3 Mbps. Below this, the optional ~250 MB detail set costs > 11 min. */
export const LOW_BANDWIDTH_BYTES_PER_SEC = 375_000;

/** A measurement needs at least this much evidence to be trusted. */
export const MIN_MEASURE_BYTES = 768 * 1024;
export const MIN_MEASURE_BUSY_MS = 150;

/** User setting (Options → Graphics → Downloads). */
export const BANDWIDTH_SETTING_KEY = "holtburger_bandwidth_v1";
/** Last measured aggregate throughput: `{ bps, at }`. */
export const BANDWIDTH_MEASURED_KEY = "holtburger_bw_measured_v1";
const MEASURED_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

let _resolved = null;

function _search(search) {
  if (search !== undefined) return search;
  try {
    return typeof window !== "undefined" && window.location ? window.location.search : "";
  } catch (_) {
    return "";
  }
}

function _ls() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (_) {
    return null; // storage blocked (private window, sandboxed iframe)
  }
}

/** Normalise a tier spelling. Returns "low" | "high" | "auto" | null. */
export function normalizeBandwidthValue(v) {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase();
  if (t === "low" || t === "slow" || t === "small") return "low";
  if (t === "high" || t === "fast" || t === "full") return "high";
  if (t === "auto" || t === "") return "auto";
  return null;
}

/** The explicit preference, before any detection: URL, then the saved setting. */
export function bandwidthPreference(search) {
  let fromUrl = null;
  try {
    fromUrl = normalizeBandwidthValue(new URLSearchParams(_search(search)).get("bandwidth"));
  } catch (_) {
    fromUrl = null;
  }
  if (fromUrl && fromUrl !== "auto") return { pref: fromUrl, source: "url" };
  const ls = _ls();
  let saved = null;
  try {
    saved = ls ? normalizeBandwidthValue(ls.getItem(BANDWIDTH_SETTING_KEY)) : null;
  } catch (_) {
    saved = null;
  }
  if (saved && saved !== "auto") return { pref: saved, source: "setting" };
  return { pref: "auto", source: fromUrl === "auto" ? "url" : saved === "auto" ? "setting" : "default" };
}

/** Save the user setting ("auto" | "low" | "high"). Takes effect next load. */
export function setBandwidthSetting(value) {
  const v = normalizeBandwidthValue(value) ?? "auto";
  const ls = _ls();
  try {
    if (ls) ls.setItem(BANDWIDTH_SETTING_KEY, v);
  } catch (_) { /* storage blocked: the setting simply does not persist */ }
  return v;
}

/** The saved setting as the UI shows it ("auto" when unset/garbage). */
export function bandwidthSetting() {
  const ls = _ls();
  try {
    const v = ls ? normalizeBandwidthValue(ls.getItem(BANDWIDTH_SETTING_KEY)) : null;
    return v ?? "auto";
  } catch (_) {
    return "auto";
  }
}

/**
 * Aggregate network throughput (bytes/s) of a set of resource-timing entries,
 * or null when there is not enough evidence.
 *
 * Only entries that actually crossed the network count: a cache or service-
 * worker hit has `transferSize` 0, and a 304 revalidation has a header-sized
 * `transferSize` far below `encodedBodySize`. The rate is total bytes over the
 * measure of the UNION of `[responseStart, responseEnd]` intervals — six
 * parallel downloads at 1/6 of the link each read as the link, not as 1/6 of
 * it.
 *
 * @param {Array<PerformanceResourceTiming|Object>} entries
 * @returns {{bps:number, bytes:number, busyMs:number, n:number}|null}
 */
export function aggregateThroughput(entries) {
  const spans = [];
  let bytes = 0;
  for (const e of entries || []) {
    if (!e) continue;
    const xfer = Number(e.transferSize) || 0;
    const body = Number(e.encodedBodySize) || 0;
    if (xfer <= 0) continue; // cache / SW / opaque cross-origin
    if (body > 0 && xfer < body) continue; // revalidated from cache
    const s = Number(e.responseStart) || Number(e.startTime) || 0;
    const t = Number(e.responseEnd) || 0;
    if (!(t > s)) continue;
    spans.push([s, t]);
    bytes += xfer;
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let [cs, ce] = spans[0];
  for (let i = 1; i < spans.length; i += 1) {
    const [s, t] = spans[i];
    if (s <= ce) {
      if (t > ce) ce = t;
    } else {
      busy += ce - cs;
      cs = s;
      ce = t;
    }
  }
  busy += ce - cs;
  if (bytes < MIN_MEASURE_BYTES || busy < MIN_MEASURE_BUSY_MS) return null;
  return { bps: (bytes * 1000) / busy, bytes, busyMs: busy, n: spans.length };
}

function _measureFromPage() {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
    // SAME-ORIGIN only: the importmap's CDN modules (jsdelivr) arrive over a
    // different, usually much faster, path than the game's own origin, and it
    // is the origin's link that every optional download below would use.
    let origin = null;
    try { origin = window.location.origin; } catch (_) { origin = null; }
    const all = performance.getEntriesByType("resource");
    return aggregateThroughput(origin ? all.filter((e) => String(e.name).startsWith(origin)) : all);
  } catch (_) {
    return null;
  }
}

function _savedMeasurement(now) {
  const ls = _ls();
  try {
    const raw = ls ? ls.getItem(BANDWIDTH_MEASURED_KEY) : null;
    if (!raw) return null;
    const m = JSON.parse(raw);
    if (!m || !Number.isFinite(m.bps) || m.bps <= 0 || !Number.isFinite(m.at)) return null;
    if (now - m.at > MEASURED_MAX_AGE_MS) return null;
    return m;
  } catch (_) {
    return null;
  }
}

function _saveMeasurement(bps, now) {
  const ls = _ls();
  try {
    if (ls) ls.setItem(BANDWIDTH_MEASURED_KEY, JSON.stringify({ bps: Math.round(bps), at: now }));
  } catch (_) { /* best effort */ }
}

function _netInfo() {
  try {
    return typeof navigator !== "undefined" && navigator.connection ? navigator.connection : null;
  } catch (_) {
    return null;
  }
}

/**
 * Pure resolver (the tests drive this directly; `bandwidthTier()` is the
 * memoised production entry). Every input is injectable.
 *
 * @param {Object} [o]
 * @param {string} [o.search]
 * @param {{pref:string, source:string}} [o.preference]
 * @param {Object|null} [o.connection] `navigator.connection`-shaped
 * @param {{bps:number}|null} [o.measured] this page's aggregate throughput
 * @param {{bps:number}|null} [o.saved] the previous visit's measurement
 * @returns {{tier:"low"|"high", source:string, bps:number|null}}
 */
export function decideBandwidthTier(o = {}) {
  const pref = o.preference ?? bandwidthPreference(o.search);
  if (pref.pref === "low" || pref.pref === "high") {
    return { tier: pref.pref, source: pref.source, bps: null };
  }
  const conn = o.connection ?? null;
  if (conn && conn.saveData === true) return { tier: "low", source: "save-data", bps: null };
  const m = o.measured ?? null;
  if (m && Number.isFinite(m.bps)) {
    return { tier: m.bps < LOW_BANDWIDTH_BYTES_PER_SEC ? "low" : "high", source: "measured", bps: m.bps };
  }
  const s = o.saved ?? null;
  if (s && Number.isFinite(s.bps)) {
    return { tier: s.bps < LOW_BANDWIDTH_BYTES_PER_SEC ? "low" : "high", source: "measured-earlier", bps: s.bps };
  }
  if (conn && Number.isFinite(conn.downlink) && conn.downlink > 0) {
    const bps = (conn.downlink * 1e6) / 8;
    return { tier: bps < LOW_BANDWIDTH_BYTES_PER_SEC ? "low" : "high", source: "netinfo", bps };
  }
  return { tier: "high", source: "default", bps: null };
}

/**
 * Resolve (once) and return `{ tier, source, bps }`. index.html calls this
 * right after the wasm has downloaded, so the measurement sees the module
 * graph + wasm; any earlier caller gets the same memoised answer.
 */
export function bandwidthTier() {
  if (_resolved) return _resolved;
  const now = Date.now();
  const measured = _measureFromPage();
  const r = decideBandwidthTier({
    connection: _netInfo(),
    measured,
    saved: measured ? null : _savedMeasurement(now),
  });
  if (measured) _saveMeasurement(measured.bps, now);
  _resolved = Object.freeze({ ...r, measuredBytes: measured ? measured.bytes : null });
  try {
    if (typeof window !== "undefined") {
      window.__bandwidthTier = () => _resolved;
      const rate = r.bps ? `${(r.bps / 1024).toFixed(0)} KB/s` : "n/a";
      // eslint-disable-next-line no-console
      console.log(
        `[bandwidth] tier=${r.tier} (source=${r.source}, rate=${rate}) — ` +
          `override with ?bandwidth=${r.tier === "low" ? "high" : "low"} or Options → Graphics → Downloads`
      );
    }
  } catch (_) { /* logging only */ }
  return _resolved;
}

/** True on a "low" session. */
export function lowBandwidth() {
  return bandwidthTier().tier === "low";
}

/** `holdForGround` ceiling: a sealed dungeon never draws terrain. */
export const GROUND_HOLD_MAX_MS = 300000;

/** True once the first terrain mesh is on screen (terrain.js latches it). */
export function groundDrawn() {
  try {
    return typeof window !== "undefined" && window.__groundDrawnAt != null;
  } catch (_) {
    return false;
  }
}

/** `holdForInterior` ceiling: a failed or wedged interior build must not
 *  strand the held downloads (they only wait, they are never dropped). */
export const INTERIOR_HOLD_MAX_MS = 180000;

/** `?interiorHold` — default ON; `off`/`0`/`false`/`no` disables the hold. */
export function interiorHoldEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("interiorHold");
    return !(v === "off" || v === "0" || v === "false" || v === "no");
  } catch (_) {
    return true;
  }
}

/**
 * True while the local player stands in an EnvCell and a landblock it can see
 * still has its interior to build (`tickPvsLoadExpansion` in cells.js
 * publishes `window.__interiorBuildPending`).
 *
 * 2026-10-09 (`?interiorHold`): a new character spawns inside a Training
 * Academy. On the 1070 (fresh profile, raw link, HTTP/1.1 = 6 connections)
 * the t1024 terrain promotion (68 MB) and the macro maps (9 MB) started
 * ~10 s after in-world and shared those connections with the academy's 2,037
 * one-record requests (1.4 s each on average, 8.9 s worst), none of it
 * visible from a sealed dungeon. Those downloads now wait for the interior.
 */
export function interiorBuildPending(search) {
  if (!interiorHoldEnabled(search)) return false;
  try {
    return typeof window !== "undefined" && window.__interiorBuildPending === true;
  } catch (_) {
    return false;
  }
}

/**
 * Resolves once no interior is pending (`interiorBuildPending`) or after
 * `maxMs`: "not-pending" (nothing to wait for at the call) | "built" |
 * "timeout".
 */
export function holdForInterior({ maxMs = INTERIOR_HOLD_MAX_MS, pollMs = 500, now = Date.now } = {}) {
  if (!interiorBuildPending()) return Promise.resolve("not-pending");
  return new Promise((resolve) => {
    const t0 = now();
    const poll = () => {
      if (!interiorBuildPending()) { resolve("built"); return; }
      if (now() - t0 >= maxMs) { resolve("timeout"); return; }
      setTimeout(poll, pollMs);
    };
    setTimeout(poll, pollMs);
  });
}

/**
 * "Ground first" (2026-10-09). On a LOW session, resolves once the first
 * terrain mesh is on screen (or after `maxMs`); on any other session at once.
 * Optional downloads (the moon textures) wait on it, so at 666 kbps they no
 * longer share the line with the ground's own records — a cold boot's first
 * terrain had slipped from ~3.4 to 7.6 min behind them. Resolves with
 * "not-low" | "ground" | "timeout".
 */
export function holdForGround({ maxMs = GROUND_HOLD_MAX_MS, pollMs = 500, now = Date.now } = {}) {
  if (!lowBandwidth()) return Promise.resolve("not-low");
  return new Promise((resolve) => {
    const t0 = now();
    const poll = () => {
      if (groundDrawn()) { resolve("ground"); return; }
      if (now() - t0 >= maxMs) { resolve("timeout"); return; }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

/**
 * Should an optional detail download run? `flagValue` is the raw URL value of
 * the feature's OWN flag (null when absent): an explicit value always wins
 * (the caller interprets it); absent ⇒ skip on a low session.
 */
export function bandwidthAllows(flagValue) {
  if (flagValue != null) return true;
  return !lowBandwidth();
}

/** Test hook. */
export function _resetBandwidthTierForTest(forced) {
  _resolved = forced ? Object.freeze({ source: "test", bps: null, measuredBytes: null, ...forced }) : null;
}
