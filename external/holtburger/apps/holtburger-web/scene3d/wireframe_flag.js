// scene3d/wireframe_flag.js — the ONE `?wireframe` reader (wire-agent mode).
//
// Default OFF (absent → false). Accepts `1` / `on` / `true` / `yes`
// (case-insensitive); anything else is off. Before 2026-10-05 index.js and
// entities.js accepted only `=== "1"` while terrain_vfx.js also accepted
// `on`, so `?wireframe=on` half-enabled the mode (terrain VFX killed, the
// rest of the scene still textured). Every consumer now calls this.
//
// Dependency-free so the source-eval headless harnesses can load it.

const ON_TOKENS = new Set(["1", "on", "true", "yes"]);

/**
 * @param {string} [search] query string to parse; defaults to
 *   `window.location.search` (no window → off).
 * @returns {boolean}
 */
export function wireframeFlagOn(search) {
  try {
    const s = typeof search === "string"
      ? search
      : (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(s).get("wireframe");
    return v != null && ON_TOKENS.has(v.trim().toLowerCase());
  } catch (_) {
    return false;
  }
}
