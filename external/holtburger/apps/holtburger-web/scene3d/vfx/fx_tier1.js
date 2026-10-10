// scene3d/vfx/fx_tier1.js — the tier-1 particle upgrade switches (2026-10-10).
//
// Tier 1 turns the per-emitter particle profiles (particle_fx.js) into effects
// the WORLD reacts to. Six independent switches, each a quality-preset boolean
// (scene3d/quality.js PRESETS + BOOL_FLAGS, so `?flag=on|off`, the saved
// Graphics settings and the preset all work the usual way):
//
//   fxLights       effects light the world: an FX light source per lit emitter
//                  (flames, portals, spell swirls) and a flash per PlayEffect
//                  cue, all through the fixed light pool (lighting.js) — the
//                  pool's slot COUNT never changes (no shader relink)
//   terrainLights  the terrain shader takes the pool's point lights (retail
//                  drew the landscape with fixed-function lighting OFF —
//                  ACRender::landPolyDraw — so this is a beyond-retail upgrade)
//   fxKids         GPU child particles: embers, glitter, sparks, drips, motes,
//                  crackle — one instanced draw per particle manager
//   fxSmoke        smoke / dust / mist shading: sun-lit pseudo-normals, noise
//                  erosion, curl flow, sun-shadow receive, back-lit rim
//   fxDistort      screen-space distortion: heat over fires, swirl over
//                  portals, shockwave rings on bursts and impacts
//   fxGlow         a glow buffer: each emitter's own share of light, blurred
//                  into a halo independent of the scene bloom threshold
//
// Tiers: low = none; mid = everything but the glow; high / ultra = all six.
// A module that has to decide before the quality object exists (a shader
// string built at import) reads the URL first and falls back to the defaults
// here; everything else reads `liveScene3d.quality.flags` (or `__quality`).
//
// No imports: safe for every chunk (terrain, particles, composer, play-effect).

export const FX_TIER1_FLAGS = Object.freeze(["fxLights", "terrainLights", "fxKids", "fxSmoke", "fxDistort", "fxGlow"]);

/** Preset defaults (mirrored into scene3d/quality.js PRESETS). */
export const FX_TIER1_PRESETS = Object.freeze({
  low: Object.freeze({ fxLights: false, terrainLights: false, fxKids: false, fxSmoke: false, fxDistort: false, fxGlow: false }),
  mid: Object.freeze({ fxLights: true, terrainLights: true, fxKids: true, fxSmoke: true, fxDistort: true, fxGlow: false }),
  high: Object.freeze({ fxLights: true, terrainLights: true, fxKids: true, fxSmoke: true, fxDistort: true, fxGlow: true }),
  ultra: Object.freeze({ fxLights: true, terrainLights: true, fxKids: true, fxSmoke: true, fxDistort: true, fxGlow: true }),
});

const ON = new Set(["on", "1", "true", "yes"]);
const OFF = new Set(["off", "0", "false", "no"]);

/** Exact URL reading of one switch: true / false, or null when absent or garbage. */
export function fxTier1UrlValue(name, search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get(name);
    if (v == null) return null;
    const t = String(v).trim().toLowerCase();
    if (ON.has(t)) return true;
    if (OFF.has(t)) return false;
  } catch (_) { /* fall through */ }
  return null;
}

const _forced = new Map();
/** Test / A-B seam: force a switch (`null` restores the normal resolution). */
export function setFxTier1Flag(name, on) {
  if (on == null) _forced.delete(name);
  else _forced.set(name, !!on);
}

function _qualityFlags() {
  try {
    const w = globalThis.window;
    return w?.liveScene3d?.quality?.flags ?? w?.__quality?.flags ?? null;
  } catch (_) { return null; }
}

/**
 * Is one tier-1 switch on? Order: test/A-B force → resolved quality flags
 * (preset < saved setting < URL, already merged by getQuality) → the URL →
 * the `mid` preset default (the tier the client boots at without a GPU probe).
 * @param {string} name one of FX_TIER1_FLAGS
 * @param {string} [search] test seam for the URL step
 */
export function fxTier1Enabled(name, search) {
  if (_forced.has(name)) return _forced.get(name);
  if (typeof search !== "string") {
    const q = _qualityFlags();
    if (q && typeof q[name] === "boolean") return q[name];
  }
  const u = fxTier1UrlValue(name, search);
  if (u !== null) return u;
  return FX_TIER1_PRESETS.mid[name] === true;
}

/** Snapshot of every switch (diagnostics). */
export function fxTier1State() {
  const out = {};
  for (const n of FX_TIER1_FLAGS) out[n] = fxTier1Enabled(n);
  return out;
}
