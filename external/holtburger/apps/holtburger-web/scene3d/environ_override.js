// scene3d/environ_override.js — the AdminEnvirons (0xEA60) fog + ambient
// override, retail `CPlayerSystem::Handle_Admin__Environs` (acclient.c:396298)
// and its consumer `LScape::UseTime` (acclient.c:307222). sky-fog-time-2.
//
// WHAT RETAIL DOES. Options 1-6 each set FIVE values, not two
// (acclient.c:396344-396416, decoded in ENVIRON_FOG below): a fog colour, a
// fog max, a fog min of 0 (LABEL_46 / the option-6 arm), an ambient colour and
// an ambient level. BlackFog/BlackFog2 fog BLACK (0x64000000) and light the
// world with a bright grey ambient (0x64969696 at 0.8); 0x969696 is the
// AMBIENT, not the fog. Every set (Clear included) zeroes
// `m_override_transition`.
//
// `LScape::UseTime` then blends the day values toward the override by that
// transition and steps it `+ 0.039999999` per tick:
//   - light tick (every skyInfo.lightTickSize, Dereth 15 s; :307264-307286):
//     ambient colour per byte, truncated, and level — `day - (day - ovr) * t`;
//   - fog tick (every skyInfo.tickSize, Dereth 0.8 s; :307306-307331): fog
//     colour per byte, min and max, the same formula; only inside
//     `if (m_fFogEnabled)` (the "Disable distance fog" option skips it).
// Once the transition reaches 1 both halves take the override verbatim and the
// stepping stops. 25 fog ticks of 0.8 s (plus a light tick or two) => the fog
// rolls in over ~20 s; Clear (`m_override_enabled = 0`) snaps the fog back on
// the next fog tick (here at once) and the ambient on the next light tick.
// `GameSky::Draw` (:308494) also turns fog ON for the sky pass while the
// override is enabled, so the (non-additive) sky takes the fog colour.
//
// HERE. `app/client_events.js` stores `environFogFor(option)` — a FRESH object
// per message — in `window.__environFogOverride`. `scene3d/loop.js` calls
// `environOverride.sync()` with it every tick: a new object identity is a new
// message, so the transition restarts at 0 exactly as retail's set does.
// loop.js tickDistanceFogColor runs the 0.8 s fog tick, tickTerrainSunDir the
// light tick (the shared `retailLightTick` epoch) and hands the latched ambient
// level to atmosphere_lights. Where the day fog is our sampled sky radiance
// (?terrainFog) its colour blends in the working space; authored bytes (no
// region fog) and the ambient blend per byte as above. The sky veil
// (`updateEnvironSkyVeil`) stands in for the fogged sky pass.
//
// `?environRetail=off` (also 0 / false) restores the pre-2026-10-13 path: the
// fog snaps on with near = 0.1 x far, no ambient, no sky veil. The decomp table
// (BlackFog black) applies either way.
//
// Pure: no DOM, no three imports (THREE is passed in to the veil helper), so
// node tests and app/client_events.js can import it.

import { retailLightNowSec } from "./retail_light_tick.js";

const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?environRetail=off|0|false` disables the fade, ambient and sky veil. */
export function environRetailEnabled(search) {
  try {
    const v = new URLSearchParams(search ?? globalThis.location?.search ?? "").get("environRetail");
    return !isOff(v);
  } catch (_) {
    return true;
  }
}

/**
 * Handle_Admin__Environs options 1-6, decoded from the decomp's literals
 * (ARGB 0x64RRGGBB; the alpha byte 0x64 is dropped). Levels are the float
 * bits verbatim: 1053609165 = 0x3ECCCCCD = fround(0.4), 1050253722 =
 * 0x3E99999A = fround(0.3), 1061997773 = 0x3F4CCCCD = fround(0.8). Fog max:
 * 0x42480000 = 50, 0x41F00000 = 30, 0x42200000 = 40. Fog min is 0 for all.
 */
export const ENVIRON_FOG = Object.freeze({
  0x01: Object.freeze({ name: "RedFog", fogRgb: 0x960000, fogMin: 0, fogMax: 50, ambRgb: 0x960000, ambLevel: Math.fround(0.4) }),
  0x02: Object.freeze({ name: "BlueFog", fogRgb: 0x320096, fogMin: 0, fogMax: 50, ambRgb: 0x320096, ambLevel: Math.fround(0.3) }),
  0x03: Object.freeze({ name: "WhiteFog", fogRgb: 0x646464, fogMin: 0, fogMax: 30, ambRgb: 0x646464, ambLevel: Math.fround(0.4) }),
  0x04: Object.freeze({ name: "GreenFog", fogRgb: 0x1e6400, fogMin: 0, fogMax: 50, ambRgb: 0x1e6400, ambLevel: Math.fround(0.3) }),
  // fog colour 1677721600 = 0x64000000 = BLACK; ambient 0x64969696 at 0.8.
  0x05: Object.freeze({ name: "BlackFog", fogRgb: 0x000000, fogMin: 0, fogMax: 40, ambRgb: 0x969696, ambLevel: Math.fround(0.8) }),
  // == BlackFog, plus the radar blank (radarBlankAfterEnviron, target_cycle.js).
  0x06: Object.freeze({ name: "BlackFog2", fogRgb: 0x000000, fogMin: 0, fogMax: 40, ambRgb: 0x969696, ambLevel: Math.fround(0.8) }),
});

/**
 * A fresh override for `option` (null for Clear / anything without a row).
 * Fresh on every call: loop.js restarts the transition on a new identity.
 */
export function environFogFor(option) {
  const o = option >>> 0;
  const row = ENVIRON_FOG[o];
  return row ? { option: o, ...row } : null;
}

/**
 * `LScape::m_override_transition + 0.039999999` (acclient.c:307286 light,
 * :307329 fog): a double add stored back into the float.
 */
export const ENVIRON_TRANSITION_STEP = 0.039999999;
export function stepTransition(t) {
  return Math.fround(t + ENVIRON_TRANSITION_STEP);
}

/**
 * Dereth's skyInfo.tickSize, seconds — the fog half of LScape::UseTime runs
 * every `tick_size` (`LScape::next_tick`, acclient.c:307247). Region
 * 0x13000000 in client_portal.dat stores the f64 0.800000011920929 (a float
 * 0.8), next to lightTickSize 15.0.
 */
export const RETAIL_FOG_TICK_SEC = Math.fround(0.8);

/**
 * One colour byte, retail's blend: `(unsigned __int64)((double)day -
 * (double)(int)(day - ovr) * t)` — truncated, not rounded.
 */
export function blendByte(day, ovr, t) {
  const d = day & 0xff;
  const o = ovr & 0xff;
  return Math.trunc(d - (d - o) * t) & 0xff;
}

/** All four bytes of an ARGB/RGB value through `blendByte`. */
export function blendArgb(day, ovr, t) {
  return (
    (blendByte(day >>> 24, ovr >>> 24, t) << 24)
    | (blendByte(day >>> 16, ovr >>> 16, t) << 16)
    | (blendByte(day >>> 8, ovr >>> 8, t) << 8)
    | blendByte(day, ovr, t)
  ) >>> 0;
}

/** Fog min/max and ambient level: `day - (day - ovr) * t`. */
export function blendValue(day, ovr, t) {
  return day - (day - ovr) * t;
}

/**
 * The fog the override shows at transition `t` over the day fog
 * `{ rgb, min, max }` (LScape::UseTime :307306-307331). At `t >= 1`, or with
 * no day fog to blend from, the override verbatim.
 */
export function blendFogToward(day, ovr, t) {
  if (!ovr) return day;
  if (!day || !(t < 1)) return { rgb: ovr.fogRgb & 0xffffff, min: ovr.fogMin, max: ovr.fogMax };
  return {
    rgb: blendArgb(day.rgb & 0xffffff, ovr.fogRgb & 0xffffff, t) & 0xffffff,
    min: blendValue(day.min, ovr.fogMin, t),
    max: blendValue(day.max, ovr.fogMax, t),
  };
}

/**
 * The world fog retail itself would draw from a SkyState snapshot
 * (`SkyDesc::GetWorldFog`: colour, min, max), or null when it yields none
 * (world_fog 0, or no sane band).
 */
export function authoredWorldFog(state) {
  if (!state) return null;
  if ((state.worldFog >>> 0) === 0) return null;
  const min = +state.fogMin;
  const max = +state.fogMax;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min) || min < 0) return null;
  return { rgb: (state.fogColorArgb >>> 0) & 0xffffff, min, max };
}

/**
 * The override state machine: `m_override_transition` plus the transition the
 * last fog tick and the last light tick blended with (what is on screen until
 * the next tick of each).
 *
 * @param {object} [opts]
 * @param {Function} [opts.now]        seconds source (default the live clock).
 * @param {number}   [opts.fogTickSec] default RETAIL_FOG_TICK_SEC.
 */
export function createEnvironOverride(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : retailLightNowSec;
  const fogTickSec = Number.isFinite(opts.fogTickSec) && opts.fogTickSec > 0
    ? opts.fogTickSec
    : RETAIL_FOG_TICK_SEC;
  let source = null;
  let ov = null;
  let transition = 0;
  let fogT = 0;
  let nextFogTick = -Infinity;
  // What the last light tick latched: the override ambient and the transition
  // it blended with, or null. Retail re-lights only on a light tick, so this
  // outlives a Clear or a new option until the next one.
  let amb = null;
  let sets = 0;
  let fogTicks = 0;
  let lightTicks = 0;

  function set(o) {
    source = o || null;
    ov = source && Number.isFinite(source.fogRgb) ? source : null;
    // Handle_Admin__Environs: every option (Clear too) zeroes the transition.
    transition = 0;
    fogT = 0;
    nextFogTick = -Infinity;
    sets += 1;
  }

  return {
    /** Adopt `o` (window.__environFogOverride) if it is a new message. */
    sync(o) {
      if ((o || null) !== source) set(o);
      return ov;
    },
    set,
    /** Clear (option 0): no override, transition 0. */
    clear() {
      set(null);
    },
    get active() {
      return ov !== null;
    },
    get override() {
      return ov;
    },
    get transition() {
      return transition;
    },
    /**
     * The fog half: on each `fogTickSec` tick, latch the transition the fog
     * blends with, then step it (while below 1). Returns the latched value;
     * 0 with no override.
     */
    fogTick() {
      if (!ov) return 0;
      const t = +now();
      if (!(t < nextFogTick)) {
        nextFogTick = (Number.isFinite(t) ? t : 0) + fogTickSec;
        fogT = transition;
        if (transition < 1) transition = stepTransition(transition);
        fogTicks += 1;
      }
      return fogT;
    },
    /** The transition the fog shows now (no tick). */
    get fogT() {
      return ov ? fogT : 0;
    },
    /**
     * The light half, called once per landscape light tick: the ambient
     * `{ argb, level }` over the day `dayArgb` / `dayLevel` (already floored
     * at LSCAPE_LIGHT_MINIMUM), then step the transition. Null with no
     * override (the caller keeps the day values).
     */
    lightTick(dayArgb, dayLevel) {
      lightTicks += 1;
      if (!ov) {
        amb = null;
        return null;
      }
      const ovArgb = (0x64000000 | (ov.ambRgb & 0xffffff)) >>> 0;
      amb = { argb: ovArgb, level: ov.ambLevel, t: transition };
      if (!(transition < 1)) return { argb: ovArgb, level: ov.ambLevel };
      const out = {
        argb: blendArgb(dayArgb >>> 0, ovArgb, transition),
        level: blendValue(dayLevel, ov.ambLevel, transition),
      };
      transition = stepTransition(transition);
      return out;
    },
    /**
     * The ambient as of the last light tick over the live day values, for
     * per-frame consumers (atmosphere_lights). Null when that tick latched no
     * override, or blended at 0 (the day values stand).
     */
    ambient(dayArgb, dayLevel) {
      if (!amb || !(amb.t > 0)) return null;
      if (!(amb.t < 1)) return { argb: amb.argb, level: amb.level };
      return {
        argb: blendArgb(dayArgb >>> 0, amb.argb, amb.t),
        level: blendValue(dayLevel, amb.level, amb.t),
      };
    },
    stats() {
      return {
        active: ov !== null,
        option: ov ? ov.option ?? null : null,
        name: ov ? ov.name ?? null : null,
        transition,
        fogT: ov ? fogT : 0,
        // The transition the terrain/object ambient was last lit with.
        lightT: amb ? amb.t : 0,
        // Clear zeroes these in retail too (acclient.c:396334-396342).
        fogMin: ov ? ov.fogMin : 0,
        fogMax: ov ? ov.fogMax : 0,
        nextFogTick,
        fogTickSec,
        sets,
        fogTicks,
        lightTicks,
      };
    },
  };
}

/** The landscape's override: loop.js's fog tick + light tick. */
export const environOverride = createEnvironOverride();

// ── the sky veil ────────────────────────────────────────────────────────────
// GameSky::Draw (acclient.c:308494) draws the sky with fog ON while the
// override is enabled, so every non-additive sky surface takes the fog colour
// (and :308513-308515 drops the props&2 cloud bands). Our sky is the takram
// SkyMaterial (+ stars, art moons, ?skyWeather billboards, the ?clouds overlay
// when it composites in the sky pass), so the analogue is one fog-coloured
// shell drawn LAST in `skyDome.skyScene`, at alpha = the fog's transition. The
// moon's additive glow sheets (sky_glow.js) are world-pass particles at far
// depth and stay on top, unfogged, as retail's additive sky surfaces are. The
// fog probe in loop.js renders only the radiance quad, so it never sees this.

/** After the cloud overlay (999), the last thing in the sky pass. */
export const ENVIRON_SKY_VEIL_RENDER_ORDER = 1000;
const VEIL_RADIUS = 100;

/**
 * Show the veil in `skyScene` with `color` (a THREE.Color in the working
 * space — pass `scene.fog.color` so the sky meets the fogged terrain) at
 * `alpha`; alpha <= 0 hides it. Created on first use; `THREE` is passed in so
 * this module stays import-free. Returns the mesh (or null).
 */
export function updateEnvironSkyVeil(THREE, skyScene, color, alpha) {
  if (!skyScene) return null;
  const ud = skyScene.userData || (skyScene.userData = {});
  let veil = ud.environSkyVeil || null;
  const a = Number.isFinite(alpha) ? Math.min(1, alpha) : 0;
  if (!(a > 0)) {
    if (veil) veil.visible = false;
    return veil;
  }
  if (!veil) {
    if (!THREE || typeof THREE.Mesh !== "function") return null;
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: a,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    veil = new THREE.Mesh(new THREE.SphereGeometry(VEIL_RADIUS, 16, 8), mat);
    veil.name = "environ_sky_veil";
    veil.frustumCulled = false;
    veil.renderOrder = ENVIRON_SKY_VEIL_RENDER_ORDER;
    const camPos = new THREE.Vector3();
    // Centre the shell on whichever camera draws the sky pass (the sky camera,
    // or a cube camera's face); three computes modelViewMatrix after this.
    veil.onBeforeRender = (_r, _s, camera) => {
      camPos.setFromMatrixPosition(camera.matrixWorld);
      veil.position.copy(camPos);
      veil.updateMatrixWorld(true);
    };
    skyScene.add(veil);
    ud.environSkyVeil = veil;
  }
  if (color && typeof veil.material.color.copy === "function") veil.material.color.copy(color);
  veil.material.opacity = a;
  veil.visible = true;
  return veil;
}

/** Hide the veil if one was ever made (no-op otherwise). */
export function hideEnvironSkyVeil(skyScene) {
  const veil = skyScene?.userData?.environSkyVeil;
  if (veil) veil.visible = false;
}
