// HUD scale — one number that sizes the whole retail HUD to the window.
//
// Retail laid its gm*UI panels out in fixed 800×600 pixels and never
// scaled them, so on a 1080p/1440p browser window the HUD shrank to a
// postage stamp (a 300×362 main panel on a 2560×1440 screen). Every
// holtburger HUD plugin keeps the retail pixel geometry; instead of
// re-deriving all of it, the HUD roots are magnified with CSS `zoom`:
//
//   scale = autoScale(viewport height) × user multiplier (Options → HUD),
//           capped so the HUD keeps ≥ 1024×640 logical px (no overlaps)
//   autoScale(h) = clamp(h / 720, 1, 3)       720p → 1.0, 1080p → 1.5,
//                                              1440p → 2.0, 2160p → 3.0
//
// `zoom` (not `transform`) because it scales layout, not just paint:
// an element anchored `right: 8px` stays 8 HUD-px from the edge,
// `left: 50%; transform: translateX(-50%)` stays centred, and the
// subtree sees a viewport of (innerWidth / s) × (innerHeight / s).
// Measured in Chrome 147 (2026-10-05): offsets, percentages and
// getBoundingClientRect all behave; the two traps are
//
//   1. pointer coordinates and getBoundingClientRect() are SCREEN px,
//      while style.left/top are HUD px — divide by the scale
//      (`toHudPx`, `hudPoint`, `hudRect` below) before writing styles;
//   2. `vw`/`vh` units are NOT divided by the zoom — a zoomed element
//      sized `92vw` overflows. Use `var(--hb-hud-vw)` / `--hb-hud-vh`
//      (one HUD-space viewport-percent each) instead.
//
// Which elements are zoomed: every direct <body> child whose id starts
// `hb-` or that carries `.hb-panel` / `.hb-bar` / `.hb-pill` — i.e.
// the HUD — minus the opt-outs in ZOOM_EXEMPT (full-viewport
// overlays that position themselves in screen space). A plugin that
// mounts a new HUD root gets scaled for free by following the
// `#hb-*` id convention.

const LS_KEY = "hb.hudScale.v1";
const BASE_HEIGHT = 720;
const MIN_AUTO = 1;
const MAX_AUTO = 3;
export const HUD_SCALE_MULT_MIN = 0.6;
export const HUD_SCALE_MULT_MAX = 2.0;
export const HUD_SCALE_EVENT = "hb-hud-scale-changed";

// Screen-space overlays that must stay unzoomed (they size themselves to
// the real viewport or track 3D/screen positions every frame).
const ZOOM_EXEMPT = [
  "#hb-thought-overlay",
  "#hb-vitals-orbs-defs",
];

let _mult = readMult();
let _scale = 1;
let _installed = false;
const _listeners = new Set();

function readMult() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return 1;
    const v = Number(JSON.parse(raw)?.mult);
    return Number.isFinite(v) ? clampMult(v) : 1;
  } catch (_) { return 1; }
}

function clampMult(v) {
  return Math.max(HUD_SCALE_MULT_MIN, Math.min(HUD_SCALE_MULT_MAX, v));
}

function urlScaleOverride() {
  try {
    const v = new URLSearchParams(window.location.search).get("hudScale");
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0.25 && n <= 6 ? n : null;
  } catch (_) { return null; }
}

/** Auto scale for a viewport height (CSS px), quantised to 0.05 so a
 *  1-px resize doesn't re-raster every HUD glyph. */
export function computeAutoScale(viewportHeight) {
  const h = Number(viewportHeight) || BASE_HEIGHT;
  const raw = Math.max(MIN_AUTO, Math.min(MAX_AUTO, h / BASE_HEIGHT));
  return Math.round(raw * 20) / 20;
}

// The HUD needs at least this much logical space (HUD px) for the default
// layout — chat bottom-left, toolbar bottom-centre, the 300×362 side panel
// under the radar — to sit side by side without overlapping. A large user
// multiplier on a small window is clamped to it (and a window smaller than
// this shrinks the HUD below retail size, down to MIN_SCALE).
const MIN_HUD_W = 1024;
const MIN_HUD_H = 640;
const MIN_SCALE = 0.6;

/** Effective scale for a viewport + user multiplier (pure, exported for tests). */
export function computeEffectiveScale(viewportWidth, viewportHeight, mult = 1) {
  const w = Number(viewportWidth) || 1280;
  const h = Number(viewportHeight) || BASE_HEIGHT;
  const want = computeAutoScale(h) * (Number(mult) || 1);
  const fit = Math.min(w / MIN_HUD_W, h / MIN_HUD_H);
  return Math.round(Math.max(MIN_SCALE, Math.min(want, fit)) * 100) / 100;
}

function computeScale() {
  const forced = urlScaleOverride();
  if (forced != null) return forced;
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : BASE_HEIGHT;
  return computeEffectiveScale(w, h, _mult);
}

/** Current HUD zoom factor (1 = retail pixel size). */
export function getHudScale() { return _scale; }
/** The user multiplier on top of the auto scale (Options → HUD scale). */
export function getHudScaleMultiplier() { return _mult; }

export function setHudScaleMultiplier(mult) {
  _mult = clampMult(Number(mult) || 1);
  try { localStorage.setItem(LS_KEY, JSON.stringify({ mult: _mult })); } catch (_) {}
  apply();
}

/** Screen px (pointer / getBoundingClientRect) → HUD px (style values). */
export function toHudPx(screenPx) { return screenPx / _scale; }
/** HUD px → screen px. */
export function toScreenPx(hudPx) { return hudPx * _scale; }
/** Pointer event → HUD-space point. */
export function hudPoint(ev) {
  return { x: (ev?.clientX ?? 0) / _scale, y: (ev?.clientY ?? 0) / _scale };
}
/** getBoundingClientRect() in HUD px. Only meaningful for an element
 *  that lives inside a zoomed HUD root. */
export function hudRect(el) {
  const r = el.getBoundingClientRect();
  const s = _scale;
  return {
    left: r.left / s, top: r.top / s, right: r.right / s, bottom: r.bottom / s,
    width: r.width / s, height: r.height / s, x: r.left / s, y: r.top / s,
  };
}
/** The viewport as a zoomed HUD root sees it. */
export function hudViewport() {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : BASE_HEIGHT;
  return { width: w / _scale, height: h / _scale };
}

/** Subscribe to scale changes. Returns an unsubscribe fn. */
export function onHudScaleChange(cb) {
  if (typeof cb !== "function") return () => {};
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function apply() {
  const next = computeScale();
  const changed = next !== _scale;
  _scale = next;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--hb-ui-scale", String(_scale));
  // One HUD-space viewport percent — `calc(92 * var(--hb-hud-vw))`
  // replaces `92vw` inside a zoomed root.
  root.style.setProperty("--hb-hud-vw", `${window.innerWidth / _scale / 100}px`);
  root.style.setProperty("--hb-hud-vh", `${window.innerHeight / _scale / 100}px`);
  if (!changed) return;
  for (const cb of _listeners) {
    try { cb(_scale); } catch (e) { console.error("[hud_scale] listener", e); }
  }
  try { document.dispatchEvent(new CustomEvent(HUD_SCALE_EVENT, { detail: { scale: _scale } })); } catch (_) {}
}

/** Idempotent boot hook — call once before the HUD plugins mount. */
export function installHudScale() {
  if (_installed || typeof document === "undefined") return;
  _installed = true;
  const exempt = ZOOM_EXEMPT.map((s) => `:not(${s})`).join("");
  const style = document.createElement("style");
  style.id = "hb-hud-scale-style";
  style.textContent = `
    body > [id^="hb-"]${exempt},
    body > .hb-panel${exempt},
    body > .hb-bar${exempt},
    body > .hb-pill${exempt} { zoom: var(--hb-ui-scale, 1); }
  `;
  document.head.appendChild(style);
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  });
  apply();
  window.__hudScale = {
    get: getHudScale, getMultiplier: getHudScaleMultiplier,
    setMultiplier: setHudScaleMultiplier, viewport: hudViewport,
  };
}
