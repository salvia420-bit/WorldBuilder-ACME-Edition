// scene3d/diag/fonts.js — AC bitmap-font load + render diagnostic slice
//
// Pain point this addresses: the AC font pipeline (Font 0x40 DAT →
// glyph atlas → <ac-text> custom element) silently falls back to the
// browser system font whenever (a) the wasm fetch_font export is
// missing, (b) the DAT data is empty / unparseable, (c) the canvas
// context can't be acquired, or (d) the requested codepoint isn't in
// the loaded atlas (em-dashes, curly quotes, accented chars). From
// outside, the only visible symptom is "this label looks slightly
// off" — there's no inspectable runtime state showing which fonts
// loaded, which failed, or how many <ac-text> elements are live.
//
// This surface exposes:
//
//   __diag.fonts.loaded     — Map<fontId, {fontId, glyphCount,
//                              atlasWidth, atlasHeight, loadedAt}>
//   __diag.fonts.failures   — ring [{fontId, error, ts, source}]
//   __diag.fonts.fallbacks  — Set<codepoint> unique missing chars seen
//   __diag.fonts.summary()  — aggregate counters + atlas mem estimate
//   __diag.fonts.snapshot() — full picture for report.json
//
// Hooks fire from `ui/ac_font.js` at the existing success/fail/
// fallback branches. Read-through state (Map<fontId,runtime>) is
// scanned via the `getAcFont(id)` accessor for the four canonical
// font-IDs the codebase already exports as constants. Custom-element
// registration state is exposed via `getCustomElementState()` so the
// diag harness can detect the documented DCL-hang corner case.

import { getAcFont } from "../../ui/ac_font.js";

const DEFAULT_MAX_FAILURES = 50;
const DEFAULT_MAX_FALLBACKS = 256;

// Canonical font IDs the AC HUD migration uses (per `ui/ac_font.js`
// constants UI_FONT_ID / COMPACT_FONT_ID / HEADING_FONT_ID /
// CHAT_FONT_ID). Surfaced through the snapshot for the harness to
// know which IDs to look up against `getAcFont(id)`.
const CANONICAL_FONT_IDS = [
  0x40000000, // UI_FONT_ID
  0x40000019, // HEADING_FONT_ID
  0x4000001C, // COMPACT_FONT_ID
  0x40000027, // CHAT_FONT_ID
];

function errStr(e) {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try { return String(e); } catch (_) { return "(unstringifiable)"; }
}

function hexId(d) {
  return "0x" + ((d >>> 0).toString(16).padStart(8, "0"));
}

function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.shift();
}

export function attachFonts(diag) {
  const fonts = {
    loaded: new Map(),     // fontId → {fontId, glyphCount, atlasWidth, atlasHeight, loadedAt}
    failures: [],          // [{fontId, error, ts, source}]
    fallbacks: new Set(),  // codepoints rendered via system-font fallback
    maxFailures: DEFAULT_MAX_FAILURES,
    maxFallbacks: DEFAULT_MAX_FALLBACKS,

    /**
     * Fired from `ui/ac_font.js::loadAcFont` after `runtimes.set(fontId,
     * runtime)`. Meta: {fontId, glyphCount, atlasWidth, atlasHeight}.
     */
    onLoadSucceeded(meta) {
      try {
        const m = meta || {};
        const fid = (m.fontId ?? 0) >>> 0;
        fonts.loaded.set(fid, {
          fontId: hexId(fid),
          glyphCount: (m.glyphCount ?? 0) | 0,
          atlasWidth: (m.atlasWidth ?? 0) | 0,
          atlasHeight: (m.atlasHeight ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) { /* never throw out of a hook */ }
    },

    /**
     * Fired from `ui/ac_font.js::loadAcFont` catch site or empty-data
     * branch. Meta: {fontId, error, source: "fetch"|"empty"|"build"}.
     */
    onLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(fonts.failures, {
          fontId: hexId(m.fontId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, fonts.maxFailures);
      } catch (_) {}
    },

    /**
     * Fired from `ui/ac_font.js::_drawGlyphs` and `_measure` when a
     * codepoint isn't in the loaded atlas and falls back to the
     * system-font draw path. Meta: {codepoint}. Deduped via Set so
     * repeated text-renders with the same missing char don't bloat
     * the surface.
     */
    onFallbackGlyph(meta) {
      try {
        const cp = (meta?.codepoint ?? 0) | 0;
        if (!cp) return;
        if (fonts.fallbacks.size >= fonts.maxFallbacks) return;
        fonts.fallbacks.add(cp);
      } catch (_) {}
    },

    /**
     * Live count of `<ac-text>` elements currently in the document.
     * One DOM scan per call; cheap (microseconds for ~hundreds of
     * elements).
     */
    elementCount() {
      try {
        if (typeof document === "undefined") return 0;
        return document.querySelectorAll("ac-text").length;
      } catch (_) { return 0; }
    },

    /**
     * Custom-element registration state. Returns `null` if `ui/ac_font.js`
     * isn't loaded yet. {registered, scheduled} otherwise. Useful for
     * detecting the documented DCL-hang corner case where registration
     * was scheduled but never ran.
     */
    customElementState() {
      try {
        if (typeof customElements === "undefined") return null;
        return {
          definedInRegistry: !!customElements.get("ac-text"),
        };
      } catch (_) { return null; }
    },

    /**
     * Read-through to `ui/ac_font.js::getAcFont(id)` for the four
     * canonical font IDs. Reports cached state regardless of whether
     * the load fired during diag's installed window — closes the gap
     * for pre-diag-install boot loads.
     */
    cached() {
      const out = [];
      try {
        for (const id of CANONICAL_FONT_IDS) {
          const r = getAcFont(id);
          if (r) {
            out.push({
              fontId: hexId(id),
              glyphCount: r.glyphMap?.size ?? 0,
              maxCharHeight: r.maxCharHeight,
              maxCharWidth: r.maxCharWidth,
              hasShadow: !!r.atlasBgCanvas,
            });
          }
        }
      } catch (_) {}
      return out;
    },

    /**
     * Aggregate counters + a rough atlas-memory estimate (4 bytes per
     * RGBA pixel × atlas dims × 1-or-2 atlases per font; ignores the
     * canvas overhead the browser actually pays).
     */
    summary() {
      let atlasBytes = 0;
      for (const r of fonts.loaded.values()) {
        atlasBytes += 4 * r.atlasWidth * r.atlasHeight;
      }
      const cached = fonts.cached();
      return {
        loaded: fonts.loaded.size,
        cached: cached.length,
        failures: fonts.failures.length,
        fallbackCodepoints: fonts.fallbacks.size,
        elements: fonts.elementCount(),
        atlasMemMB: +(atlasBytes / 1024 / 1024).toFixed(2),
        customElement: fonts.customElementState(),
        canonicalIds: CANONICAL_FONT_IDS.map(hexId),
      };
    },

    /** Full snapshot for report.json serialization. */
    snapshot() {
      return {
        ts: new Date().toISOString(),
        loaded: Array.from(fonts.loaded.values()),
        cached: fonts.cached(),
        failures: [...fonts.failures],
        fallbacks: Array.from(fonts.fallbacks).map((cp) => ({
          codepoint: cp,
          char: String.fromCodePoint(cp),
        })),
        elementCount: fonts.elementCount(),
        customElement: fonts.customElementState(),
      };
    },

    /** Clear failure ring + fallback Set. `loaded` is durable. */
    reset() {
      fonts.failures.length = 0;
      fonts.fallbacks.clear();
    },
  };

  diag.fonts = fonts;
}
