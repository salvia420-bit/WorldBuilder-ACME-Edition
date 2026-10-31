// R3-2 "HUD diet" (2026-10-31): URL readers for the diet levers and for the
// HUD bisect flags, the bisect stylesheet, and a cached canvas CSS size.
//
// WHY. On the GTX 1070 (M1a-BENCH, Holtburg ultra 1080p) `?hud=none` was worth
// +3.9 / +2.8 / +4.1 fps (still / moving / tour), with the main thread binding.
// `?hud=none` is two things at once (docs/2026-10-29-round3-gpu-driven.md
// R3-2; inventory hud-diet/inventory.md):
//   * CSS: index.html hides every direct <body> child except #stage (all the
//     hb-* HUD panes) plus .floating-panel and the DOM nameplate layer. The
//     plugins still install and tick: their JS keeps running.
//   * JS: the sprite nameplates, the DOM nameplate overlay and the selection-
//     bracket overlay are never built. At the bench defaults both nameplate
//     systems are already off (`?nameplates=on` / `?nameplateDom=on` opt in),
//     so the only live JS part is the bracket overlay, which
//     `?selectionIndicator=none` skips in exactly the same way.
//
// BISECT FLAGS (default: HUD shown, i.e. today's page). Each one removes ONE
// part of what `?hud=none` removes, so an arm prices that part alone:
//   ?hudPanels=off    the CSS half of hud=none, minus the nameplate selectors:
//                     every direct <body> child except #stage, plus
//                     .floating-panel, display:none. CSS only, like hud=none.
//   ?hudOrbs=off      only the three vitals-orb panes and their shared <defs>
//                     svg, display:none. CSS only (the orb driver keeps
//                     ticking, as under hud=none).
//   ?hudCanvases=off  only the HUD's repeatedly redrawn canvas, the radar blip
//                     canvas: not displayed and not drawn (plugins/radar.js).
//   Off-forms: off / 0 / false / no / none (any case, trimmed). Anything else,
//   including absent, keeps today's HUD.
//
// DIET (default OFF): `?hudDiet=on` turns on every lever below; `?hudDiet=` a
// comma list of lever names turns on only those (unknown names are ignored);
// off / 0 / false / no / none, absent or a list with no known name: none.
//   orbSync   plugins/vitals-orbs.js: the orb loops are sampled on the cadence
//             tick from a cached animation list, so a tick no longer calls
//             getAnimations() (a forced style flush) or reads playState; the
//             list is re-collected after a pane show/hide, a low-HP toggle, a
//             loop going idle, and every ORB_SYNC_RECOLLECT_TICKS ticks.
//   orbLayer  plugins/vitals-orbs.js: each 92x92 vessel core gets its own
//             compositor layer (`will-change: opacity`), so a wave tick re-
//             rasters the core alone instead of also replaying the figure
//             sprites' drop-shadow filters and the glow that overlap it.
//   radar     plugins/radar.js: the full update (wasm gather, sort, paint key,
//             canvas repaint) runs at <= 10 Hz while nothing that turns the
//             radar changed; a heading change, a selection change, the
//             BlackFog2 blank, a backing-size change or the mouse over the
//             disk still update at the retail 40 Hz.
//   overlays  scene3d/selection_brackets.js + scene3d/hud.js: the per-frame
//             canvas.clientWidth/Height layout read becomes a cached size
//             (refreshed by ResizeObserver / window resize), and the brackets
//             skip their same-value style.display / transform writes.
//   fontWrf   ui/ac_font.js: the AC-font atlas canvas (a drawImage SOURCE for
//             every <ac-text> render) is created willReadFrequently, i.e.
//             CPU-backed, so a CPU text canvas never reads it back from the GPU.
// Every lever is pixel-neutral by construction; orbLayer changes compositing
// only (owner glance in the HUD arm).
//
// Readers are memoized per page (the URL does not change); tests reset them
// with __setHudDietSearchForTest().

const OFF_FORMS = new Set(["off", "0", "false", "no", "none"]);
const ON_FORMS = new Set(["on", "1", "true", "yes", "all"]);

/** Every diet lever, in canonical order. */
export const HUD_DIET_LEVERS = Object.freeze(["orbSync", "orbLayer", "radar", "overlays", "fontWrf"]);
const LEVER_BY_LOWER = new Map(HUD_DIET_LEVERS.map((n) => [n.toLowerCase(), n]));
const NONE = Object.freeze([]);

/**
 * `?hudDiet` grammar. Returns a frozen array of lever names in canonical order.
 * @param {string|null|undefined} raw
 */
export function parseHudDiet(raw) {
  if (raw == null) return NONE;
  const tokens = String(raw).split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return NONE;
  if (tokens.some((t) => ON_FORMS.has(t))) return HUD_DIET_LEVERS;
  const want = new Set();
  for (const t of tokens) {
    const n = LEVER_BY_LOWER.get(t);
    if (n) want.add(n);
  }
  if (want.size === 0) return NONE;
  return Object.freeze(HUD_DIET_LEVERS.filter((n) => want.has(n)));
}

/**
 * Bisect-flag grammar (`hudPanels` / `hudOrbs` / `hudCanvases`): true = that
 * HUD part is removed.
 * @param {string|null|undefined} raw
 */
export function parseHudOff(raw) {
  if (raw == null) return false;
  return OFF_FORMS.has(String(raw).trim().toLowerCase());
}

let _search; // undefined = read window.location.search
let _memo = null;

function currentSearch() {
  if (_search !== undefined) return _search;
  try {
    return (typeof window !== "undefined" && window.location && window.location.search) || "";
  } catch (_) {
    return "";
  }
}

function state() {
  if (_memo) return _memo;
  let q = null;
  try { q = new URLSearchParams(currentSearch()); } catch (_) { q = null; }
  const get = (k) => (q ? q.get(k) : null);
  _memo = Object.freeze({
    diet: parseHudDiet(get("hudDiet")),
    panels: parseHudOff(get("hudPanels")),
    orbs: parseHudOff(get("hudOrbs")),
    canvases: parseHudOff(get("hudCanvases")),
  });
  return _memo;
}

/** Test seam: a search string forces the URL, undefined re-reads window.location. */
export function __setHudDietSearchForTest(search) {
  _search = search;
  _memo = null;
}

/** The active diet levers (frozen, canonical order; empty when off). */
export function hudDietLevers() { return state().diet; }
/** Is diet lever `name` on? */
export function hudDietOn(name) { return state().diet.includes(name); }
/** `?hudPanels=off`: every hb-* HUD pane hidden (CSS). */
export function hudPanelsOff() { return state().panels; }
/** `?hudOrbs=off`: the three vitals-orb panes hidden (CSS). */
export function hudOrbsOff() { return state().orbs; }
/** `?hudCanvases=off`: the radar blip canvas not displayed and not drawn. */
export function hudCanvasesOff() { return state().canvases; }

// ── the bisect stylesheet ─────────────────────────────────────────────────

export const HUD_BISECT_STYLE_ID = "hb-hud-bisect-style";
export const HUD_BISECT_CLASS = Object.freeze({
  panels: "hb-bisect-panels-off",
  orbs: "hb-bisect-orbs-off",
});
// The orb pane ids are load-bearing in plugins/vitals-orbs.js (PANE_ID, DEFS_ID).
const ORB_IDS = ["hb-vitals-orb-hp", "hb-vitals-orb-stam", "hb-vitals-orb-mana", "hb-vitals-orbs-defs"];

/**
 * The CSS for the active bisect parts ("" when none). `hudPanels` copies
 * index.html's `html.no-hud` rules except the two DOM-nameplate selectors
 * (`#nameplate-layer-3d`, `.nameplate-3d`): those are nameplates, not panels.
 * @param {{panels?: boolean, orbs?: boolean}} s
 */
export function hudBisectCss(s) {
  let css = "";
  if (s && s.panels) {
    const h = `html.${HUD_BISECT_CLASS.panels}`;
    css += `${h} body > *:not(#stage) { display: none !important; }\n`
      + `${h} body .floating-panel { display: none !important; }\n`;
  }
  if (s && s.orbs) {
    const h = `html.${HUD_BISECT_CLASS.orbs}`;
    css += `${ORB_IDS.map((id) => `${h} body > #${id}`).join(",\n")} { display: none !important; }\n`;
  }
  return css;
}

/**
 * Publish `window.__hudBisect` (always) and, when `?hudPanels=off` or
 * `?hudOrbs=off` is set, add the html class(es) and the bisect <style>.
 * With no bisect flag the document is not touched. Idempotent. Called by
 * ui/hud_scale.js installHudScale(), which runs before any plugin mounts.
 * @param {Document|null} [doc]
 */
export function installHudBisect(doc = (typeof document !== "undefined" ? document : null)) {
  const s = state();
  const out = Object.freeze({ panels: s.panels, orbs: s.orbs, canvases: s.canvases, diet: s.diet });
  try {
    if (typeof window !== "undefined") window.__hudBisect = out;
  } catch (_) {}
  if (!doc || !(s.panels || s.orbs)) return out;
  try {
    if (doc.getElementById && doc.getElementById(HUD_BISECT_STYLE_ID)) return out;
    const root = doc.documentElement;
    if (s.panels) root.classList.add(HUD_BISECT_CLASS.panels);
    if (s.orbs) root.classList.add(HUD_BISECT_CLASS.orbs);
    const style = doc.createElement("style");
    style.id = HUD_BISECT_STYLE_ID;
    style.textContent = hudBisectCss(s);
    (doc.head || root).appendChild(style);
  } catch (_) {}
  return out;
}

// ── cached canvas CSS size (hudDiet=overlays) ─────────────────────────────

/**
 * `canvas.clientWidth/Height` without a per-frame layout read. The first read
 * and the first read after a resize read the canvas (one layout, only then);
 * every other read returns the cached value. Invalidated by a ResizeObserver
 * on the canvas and by window `resize`. Without ResizeObserver every read is
 * live (exactly the uncached behaviour).
 * Each value keeps the `|| canvas.width || 1` fallback of the call sites.
 * Allocation-free per read: `size.read().w` / `.h`.
 * @param {{clientWidth?: number, clientHeight?: number, width?: number, height?: number}} canvas
 * @param {object} [env] — test seam: {ResizeObserver, addEventListener, removeEventListener}
 */
export function makeCanvasCssSize(canvas, env) {
  const g = env || (typeof window !== "undefined" ? window : globalThis);
  const RO = g && typeof g.ResizeObserver === "function" ? g.ResizeObserver : null;
  let dirty = true;
  const invalidate = () => { dirty = true; };
  let ro = null;
  if (RO) {
    try {
      ro = new RO(invalidate);
      ro.observe(canvas);
    } catch (_) { ro = null; }
  }
  const listen = !!(ro && g && typeof g.addEventListener === "function");
  if (listen) g.addEventListener("resize", invalidate);
  const out = {
    /** CSS px, valid after read(). */
    w: 1,
    h: 1,
    /** Refresh `w` / `h` if invalidated (always without RO); returns `this`. */
    read() {
      if (!ro || dirty) {
        out.w = canvas.clientWidth || canvas.width || 1;
        out.h = canvas.clientHeight || canvas.height || 1;
        dirty = false;
      }
      return out;
    },
    invalidate,
    get cached() { return !!ro; },
    dispose() {
      try { ro && ro.disconnect && ro.disconnect(); } catch (_) {}
      if (listen) { try { g.removeEventListener("resize", invalidate); } catch (_) {} }
      ro = null;
    },
  };
  return out;
}
