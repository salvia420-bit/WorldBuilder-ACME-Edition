// scene3d/diag/palettes.js — PaletteSet load observability
//
// Observes the PaletteSet pipeline (`ui/ac_palette_set.js`) — load
// lifecycle + cached read-through. PaletteSet is a standalone reader
// today (no built-in consumer); diag exists so plugin authors can
// inspect what's cached from their own dye/character-customization
// experiments.

import { getPaletteSetDiagSnapshot } from "../../ui/ac_palette_set.js";
import { getPaletteDiagSnapshot } from "../../ui/ac_palette.js";

const DEFAULT_MAX_FAILURES = 20;

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

export function attachPalettes(diag) {
  const palettes = {
    loaded: new Map(),    // setId → {paletteCount, loadedAt}
    failures: [],
    // Wave 7.7 — individual Palette (DAT 0x04) tracking, parallel to
    // PaletteSet (DAT 0x0F). Reader runtime is `ui/ac_palette.js`;
    // observation here lets the harness audit which raw colour
    // tables a dye-picker or character-creator actually pulled.
    palettesLoaded: new Map(),    // paletteId → {colorCount, loadedAt}
    paletteFailures: [],
    maxFailures: DEFAULT_MAX_FAILURES,

    onLoadSucceeded(meta) {
      try {
        const m = meta || {};
        const sid = (m.setId ?? 0) >>> 0;
        palettes.loaded.set(sid, {
          setId: hexId(sid),
          paletteCount: (m.paletteCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    onLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(palettes.failures, {
          setId: hexId(m.setId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, palettes.maxFailures);
      } catch (_) {}
    },

    /**
     * Wave 7.7 — individual-Palette load hooks. Mirror onLoad* /
     * onLoadFailed pattern but keyed by paletteId (DAT 0x04) instead
     * of setId (DAT 0x0F).
     */
    onPaletteLoaded(meta) {
      try {
        const m = meta || {};
        const pid = (m.paletteId ?? 0) >>> 0;
        palettes.palettesLoaded.set(pid, {
          paletteId: hexId(pid),
          colorCount: (m.colorCount ?? 0) | 0,
          loadedAt: performance.now(),
        });
      } catch (_) {}
    },

    onPaletteLoadFailed(meta) {
      try {
        const m = meta || {};
        pushCapped(palettes.paletteFailures, {
          paletteId: hexId(m.paletteId ?? 0),
          error: errStr(m.error),
          source: m.source || "unknown",
          ts: performance.now(),
        }, palettes.maxFailures);
      } catch (_) {}
    },

    /** Read-through to BOTH runtime caches (PaletteSet + Palette). */
    cached() {
      const setSnap = (() => {
        try { return getPaletteSetDiagSnapshot(); }
        catch (_) { return { sets: [] }; }
      })();
      const palSnap = (() => {
        try { return getPaletteDiagSnapshot(); }
        catch (_) { return { palettes: [] }; }
      })();
      return { sets: setSnap.sets, palettes: palSnap.palettes };
    },

    summary() {
      const cached = palettes.cached();
      return {
        loaded: palettes.loaded.size,
        cached: cached.sets.length,
        failures: palettes.failures.length,
        palettesLoaded: palettes.palettesLoaded.size,
        palettesCached: cached.palettes.length,
        paletteFailures: palettes.paletteFailures.length,
      };
    },

    snapshot() {
      return {
        ts: new Date().toISOString(),
        loaded: Array.from(palettes.loaded.values()),
        palettesLoaded: Array.from(palettes.palettesLoaded.values()),
        cached: palettes.cached(),
        failures: [...palettes.failures],
        paletteFailures: [...palettes.paletteFailures],
      };
    },

    reset() {
      palettes.failures.length = 0;
      palettes.paletteFailures.length = 0;
    },
  };

  diag.palettes = palettes;
}
