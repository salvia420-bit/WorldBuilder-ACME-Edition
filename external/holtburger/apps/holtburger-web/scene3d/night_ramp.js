// night_ramp.js — below-horizon sun ramp (?nightRamp, DEFAULT ON).
//
// THE PROBLEM (pass-1 report, Issue 4). Dereth's Region DAT authors a sun that
// NEVER SETS. In `skyInfo.dayGroups[*].skyTime`, `dirPitch` is 90 deg at
// 14:40h, 20 deg at 20:10h, 10 deg at 21:35h and then bottoms out at
// **0.9 deg** for the entire 23:02h -> 03:50h block; `dirBright` only falls
// 0.80 -> 0.25. Retail could hide that behind a flat fixed-function pipeline.
// A physical Bruneton atmosphere cannot: fed a sun 0.9 deg ABOVE the horizon it
// can only ever render "sun grazing the horizon", i.e. permanent late sunset.
//
// It also silently half-breaks the night code that already exists. Both
// `AtmosphereSky.nightFractionFromSunAltitude` and
// `ACMoons.moonBrightnessFactorFromSunAltitude` map sin(altitude) through the
// band [SUN_NIGHT -0.10, SUN_DAY +0.10]. At 0.9 deg, sin = 0.0157, which lands
// at nightFrac ~= 0.42 — so at the DARKEST MOMENT OF THE AC DAY the star field
// runs at 42% and the moons at 62% of their intended brightness. They are
// structurally incapable of reaching night.
//
// THE TREATMENT. Remap the authored elevation for the SKY ONLY, on the
// authored schedule:
//
//     pitch >= KNEE (20 deg)  -> unchanged (all of daytime is untouched)
//     pitch in [0.9, 20]      -> linearly rescaled onto [-14, 20]
//
// So 20:10h still reads 20 deg, 21:35h's 10 deg becomes ~2.2 deg (a real
// sunset), and the whole 23:02h->03:50h night block becomes -14 deg: below the
// horizon, into civil/nautical twilight, which is what the Bruneton raymarch
// needs to produce a deep blue sky with stars. The schedule, the day-group
// selection and every keyframe stay retail — only the elevation the SKY sees is
// art-directed.
//
// WHAT IT DELIBERATELY DOES *NOT* TOUCH. The remapped elevation is injected at
// exactly one call site (`atmosphere_sky.js`, `AtmosphereSky.tick`). It does
// NOT reach `SunDirectionalLight`, `SkyLightProbe`, the CSM cascade direction,
// the terrain `uSunDir` / `uAcSunVec`, or the cloud volume — each of those
// derives its own vector from `skyLightingController._lastState` independently.
// That is verifiable: `__nightRampState()` reports both pitches, and the sun
// light's own direction is unchanged frame-for-frame with the flag on or off.
//
// WARM EMITTERS. Torches, braziers, hearths and luminous window surfaces are
// absolute HDR values with no time-of-day term at all (placed PointLights from
// DAT SetupLight; `emissiveIntensity = min(2, sfLuminosity)`). Implementing the
// night as a sun-elevation remap plus an INDIRECT-ONLY dim leaves every one of
// them numerically untouched, so they gain contrast against the darker frame
// and start clearing the bloom threshold — which is exactly the reference
// image's read. An exposure-level or post-tone-map darkening would have
// crushed them uniformly, which is why this is not done that way.

const DEG_TO_RAD = Math.PI / 180;

/** Retail's authored night floor for `dirPitch`, in degrees. */
export const RETAIL_PITCH_FLOOR_DEG = 0.9;
/** Above this authored pitch nothing is remapped at all. */
export const NIGHT_RAMP_KNEE_DEG = 20.0;
/** Where the retail floor is remapped to. -14 deg is past civil twilight and
 *  into nautical: the Bruneton sky goes deep blue and the star field clears its
 *  own fade band, without the pitch-black of astronomical night (AC nights are
 *  meant to be playable). */
export const NIGHT_RAMP_FLOOR_DEG = -14.0;

/** Indirect (IBL / environmentIntensity / terrain uEnvIntensity) multiplier at
 *  full night. Ground and characters lose ambient fill; emitters do not. */
export const NIGHT_ENV_SCALE_DEFAULT = 0.30;
/** Retail-Gouraud terrain light multiplier at full night, applied on top of
 *  `terrainLightScale`. Terrain is not lit by three.js lights, so the env scale
 *  above cannot reach it — this is its counterpart. */
export const NIGHT_GROUND_SCALE_DEFAULT = 0.45;

// The band both existing consumers already use, in sin(altitude).
const SUN_DAY = 0.10;
const SUN_NIGHT = -0.10;

function _search(search) {
  if (typeof search === "string") return search;
  try {
    if (typeof window !== "undefined" && window.location) return window.location.search;
  } catch (_) { /* fall through */ }
  return "";
}

/** `?nightRamp` — DEFAULT ON; only the literal escapes turn it off. */
export function nightRampEnabled(search) {
  try {
    const v = new URLSearchParams(_search(search)).get("nightRamp");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/** `?<name>=<float>` clamped override, else `dflt`. */
export function nightNumFlag(name, dflt, lo, hi, search) {
  try {
    const raw = new URLSearchParams(_search(search)).get(name);
    if (raw == null || raw === "") return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  } catch (_) {
    return dflt;
  }
}

/** `?nightRampFloor=<deg>` — how far below the horizon the night bottoms out. */
export function nightFloorDeg(search) {
  return nightNumFlag("nightRampFloor", NIGHT_RAMP_FLOOR_DEG, -60, 20, search);
}
/** `?nightRampKnee=<deg>` — authored pitch above which nothing is remapped. */
export function nightKneeDeg(search) {
  return nightNumFlag("nightRampKnee", NIGHT_RAMP_KNEE_DEG, 1, 90, search);
}
/** `?nightEnv=<0..1>` — indirect multiplier at full night (1 = no dim). */
export function nightEnvScale(search) {
  return nightNumFlag("nightEnv", NIGHT_ENV_SCALE_DEFAULT, 0, 1, search);
}
/** `?nightGround=<0..1>` — retail-Gouraud terrain multiplier at full night. */
export function nightGroundScale(search) {
  return nightNumFlag("nightGround", NIGHT_GROUND_SCALE_DEFAULT, 0, 1, search);
}

/**
 * Remap an authored `dirPitch` (degrees above horizon) to the ART elevation the
 * SKY should be raymarched with. Identity above the knee, identity everywhere
 * when the flag is off, and continuous at the knee by construction.
 *
 * @param {number} dirPitchDeg authored DayGroup pitch
 * @param {boolean} [enabled] pass `false` to force the identity mapping
 */
export function artSunPitchDeg(dirPitchDeg, enabled) {
  const p = Number.isFinite(dirPitchDeg) ? dirPitchDeg : 0;
  const on = enabled == null ? nightRampEnabled() : !!enabled;
  if (!on) return p;
  const knee = nightKneeDeg();
  if (p >= knee) return p;
  const floor = nightFloorDeg();
  const span = Math.max(knee - RETAIL_PITCH_FLOOR_DEG, 1e-3);
  const t = Math.min(1, Math.max(0, (p - RETAIL_PITCH_FLOOR_DEG) / span));
  return floor + t * (knee - floor);
}

/**
 * Night fraction in [0, 1] from an ALREADY-REMAPPED pitch, using the same
 * sin(altitude) band `atmosphere_sky.js` and `ac_moons.js` use, so the star
 * fade, the moon fade and the ground dim all agree on when night is.
 */
export function nightFactorFromArtPitch(artPitchDeg) {
  const alt = Math.sin((Number.isFinite(artPitchDeg) ? artPitchDeg : 0) * DEG_TO_RAD);
  const t = (alt - SUN_NIGHT) / (SUN_DAY - SUN_NIGHT);
  return 1 - Math.min(1, Math.max(0, t));
}

/** Convenience: authored pitch -> night fraction through the art remap. */
export function nightFactorFromAuthoredPitch(dirPitchDeg, enabled) {
  return nightFactorFromArtPitch(artSunPitchDeg(dirPitchDeg, enabled));
}

/**
 * Install `window.__nightRampState()` — the sky-only proof. Reports the
 * authored pitch, the art pitch, the night fraction, and the sun light's OWN
 * direction so a reader can confirm the remap never reached it.
 */
export function installNightRampDiag(scene3dGetter) {
  if (typeof window === "undefined") return;
  const getter = scene3dGetter ?? (() => window.liveScene3d);
  window.__nightRampState = () => {
    try {
      const s = typeof getter === "function" ? getter() : getter;
      const st = s?.skyLightingController?._lastState ?? null;
      const authored = st ? st.dirPitch : null;
      const art = authored == null ? null : artSunPitchDeg(authored);
      const sunDir = s?.atmosphereLights?.sun?.sunDirection ?? null;
      // `liveScene3d.atmosphereSky` (index.js stamps it there; `__atmosphereSky`
      // is the same object). This is the vector the raymarch actually consumes,
      // and it MUST diverge from `sunLightDir` at night — that divergence IS
      // the proof that the ramp is sky-only.
      const sky = s?.atmosphereSky ?? (typeof window !== "undefined" ? window.__atmosphereSky : null);
      const skyDir = sky?.skyMaterial?.sunDirection ?? null;
      return {
        enabled: nightRampEnabled(),
        knee: nightKneeDeg(),
        floor: nightFloorDeg(),
        authoredPitchDeg: authored,
        artPitchDeg: art,
        nightFactor: authored == null ? null : nightFactorFromArtPitch(art),
        envScaleAtFullNight: nightEnvScale(),
        groundScaleAtFullNight: nightGroundScale(),
        // These two MUST diverge at night (sky remapped, surface light not).
        sunLightDir: sunDir ? [+sunDir.x.toFixed(4), +sunDir.y.toFixed(4), +sunDir.z.toFixed(4)] : null,
        skyMaterialSunDir: skyDir ? [+skyDir.x.toFixed(4), +skyDir.y.toFixed(4), +skyDir.z.toFixed(4)] : null,
        environmentIntensity: s?.scene?.environmentIntensity ?? null,
      };
    } catch (e) {
      return { error: String(e) };
    }
  };
}

// Self-install the diag at module load. `window.liveScene3d` is a one-time init
// snapshot, but `skyLightingController` / `atmosphereLights` / `scene` are all
// stamped onto it during init3D and never re-pointed, so a lazy read is safe
// here (unlike a late-stamped subsystem, which would read null forever).
installNightRampDiag();
