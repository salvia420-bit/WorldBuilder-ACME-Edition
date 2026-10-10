// scene3d/vfx/fx_tier2.js — the tier-2 particle upgrade switches (2026-10-10).
//
// Tier 1 (fx_tier1.js) made the world react to the effects. Tier 2 changes the
// effects themselves and adds what retail never drew around them. Six
// switches, each a quality-preset boolean (scene3d/quality.js PRESETS +
// BOOL_FLAGS, so `?flag=on|off`, the saved Graphics settings and the preset
// all work the usual way):
//
//   fxMotion    velocity-stretched sparks / droplets / debris (the FX bucket
//               programs, HB_FX_MOTION), ribbon trails behind spell and missile
//               projectiles, elemental swing trails off flaming / frost / acid /
//               lightning weapons (vfx/fx_ribbons.js)
//   fxShapes    analytic star / orb / ring sprites for the magic families
//               (HB_FX_SHAPES): crisp at any size, no texture fetch
//   fxDecals    ground marks — scorch, frost, acid, and the portal / lifestone
//               light rings — projected onto whatever surface lies under them
//               (vfx/fx_decals.js + vfx/fx_decal_effect.js)
//   fxClamp     sub-pixel clamp (HB_FX_CLAMP): a particle smaller than ~1.5 px
//               is drawn at 1.5 px with its opacity cut by the area ratio, so
//               distant glints shimmer steadily instead of popping
//   fxShowcase  composed set pieces: the portal (rim, ground ring, portal-space
//               disc), the lifestone (light shaft, rising glitter, ground ring),
//               the level-up (light column, lens flare) — vfx/fx_showcase.js
//   fxFields    ambient GPU fields round the camera: fireflies, dungeon dust
//               motes, leaves and pollen, snow, volcanic ash and embers
//               (vfx/fx_fields.js). Gated through the TERRAIN-VFX ladder like
//               grass (quality.js TERRAIN_VFX_PROMOTED.fields / TERRAIN_VFX_TIERS),
//               so it is a high / ultra effect.
//
// Tiers: low = none; mid = all but the fields; high / ultra = all six.
// Resolution order (same as tier 1): test/A-B force → resolved quality flags
// (preset < saved setting < URL, merged by getQuality) → the URL → the `mid`
// preset default.
//
// No imports: safe for every chunk (particles, composer, play-effect, terrain).

export const FX_TIER2_FLAGS = Object.freeze(["fxMotion", "fxShapes", "fxDecals", "fxClamp", "fxShowcase", "fxFields"]);

/**
 * Preset defaults for the five plain switches (mirrored into quality.js
 * PRESETS). `fxFields` is NOT here: quality.js derives it per tier from the
 * terrain-VFX ladder (`terrainMaster("fields", tier)`), exactly like grass.
 */
export const FX_TIER2_PRESETS = Object.freeze({
  low: Object.freeze({ fxMotion: false, fxShapes: false, fxDecals: false, fxClamp: false, fxShowcase: false }),
  mid: Object.freeze({ fxMotion: true, fxShapes: true, fxDecals: true, fxClamp: true, fxShowcase: true }),
  high: Object.freeze({ fxMotion: true, fxShapes: true, fxDecals: true, fxClamp: true, fxShowcase: true }),
  ultra: Object.freeze({ fxMotion: true, fxShapes: true, fxDecals: true, fxClamp: true, fxShowcase: true }),
});

/** The fields ladder's shipped value at the `mid` default (quality.js owns the real table). */
const FIELDS_MID_DEFAULT = false;

const ON = new Set(["on", "1", "true", "yes"]);
const OFF = new Set(["off", "0", "false", "no"]);

/** Exact URL reading of one switch: true / false, or null when absent or garbage. */
export function fxTier2UrlValue(name, search) {
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
export function setFxTier2Flag(name, on) {
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
 * Is one tier-2 switch on? See the header for the order.
 * @param {string} name one of FX_TIER2_FLAGS
 * @param {string} [search] test seam for the URL step
 */
export function fxTier2Enabled(name, search) {
  if (_forced.has(name)) return _forced.get(name);
  if (typeof search !== "string") {
    const q = _qualityFlags();
    if (q && typeof q[name] === "boolean") return q[name];
  }
  const u = fxTier2UrlValue(name, search);
  if (u !== null) return u;
  if (name === "fxFields") return FIELDS_MID_DEFAULT;
  return FX_TIER2_PRESETS.mid[name] === true;
}

/** Snapshot of every switch (diagnostics). */
export function fxTier2State() {
  const out = {};
  for (const n of FX_TIER2_FLAGS) out[n] = fxTier2Enabled(n);
  return out;
}
