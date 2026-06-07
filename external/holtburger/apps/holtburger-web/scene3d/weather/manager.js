// scene3d/weather/manager.js — ties rain + snow + lightning to weather_state.
//
// One tick per frame: reads `readWeatherFlags()` (is_storm + temperature),
// applies intensities, then delegates to the systems. URL knobs (`?rain=on`,
// `?lightning=on`, `?rain=off`, `?lightning=off`, `?snow=on`, `?snow=off`,
// `?thunderDid=0x...`) parse once at construct time and override the
// state-driven defaults.
//
// W2 (2026-05-29) — adds a SnowSystem alongside RainSystem; precip type is
//   selected per-tick from the weather profile temperature (cold → snow) or
//   from the streak-mesh GfxObj id once W1's SkyObject scan is wired (see
//   `setEnvironment`).
// W5 (2026-05-29) — indoor gate: when the player is inside a dungeon/building
//   all precip + lightning are forced off so rain/snow doesn't fall through
//   ceilings; wind drift scales with storm intensity instead of a constant.
//   The indoor flag + sky-object scan arrive via `setEnvironment()`, driven
//   from the clouds-independent weather tick in loop.js (W3).

import { RainSystem } from "./rain.js";
import { SnowSystem } from "./snow.js";
import { LightningSystem } from "./lightning.js";
import { readWeatherFlags } from "../weather_state.js";

const STORM_RAIN_INTENSITY = 1.0;
const STORM_SNOW_INTENSITY = 1.0;
const STORM_LIGHTNING_RATE = 0.05; // flashes/sec ≈ 1 per 20 s
// At/below this profile temperature we render snow instead of rain.
const SNOW_TEMPERATURE_C = 1.0;

function parseUrlOverrides() {
  const out = {
    rainForce: null,        // null | true | false
    snowForce: null,        // null | true | false
    lightningForce: null,   // null | true | false
    thunderDid: null,       // null | number
  };
  if (typeof window === "undefined" || !window.location?.search) return out;
  let ps;
  try {
    ps = new URLSearchParams(window.location.search);
  } catch (_) {
    return out;
  }
  const rain = ps.get("rain");
  if (rain === "on") out.rainForce = true;
  else if (rain === "off") out.rainForce = false;
  const snow = ps.get("snow");
  if (snow === "on") out.snowForce = true;
  else if (snow === "off") out.snowForce = false;
  const lit = ps.get("lightning");
  if (lit === "on") out.lightningForce = true;
  else if (lit === "off") out.lightningForce = false;
  const tdid = ps.get("thunderDid");
  if (tdid) {
    const n = tdid.startsWith("0x") || tdid.startsWith("0X")
      ? parseInt(tdid.slice(2), 16)
      : parseInt(tdid, 10);
    if (Number.isFinite(n) && n > 0) out.thunderDid = n >>> 0;
  }
  return out;
}

export class WeatherEffectsManager {
  constructor({ scene, camera, audioManager, getCameraWorldPos }) {
    if (!scene || !camera) {
      throw new Error("WeatherEffectsManager: scene + camera required");
    }
    this._overrides = parseUrlOverrides();
    this.rain = new RainSystem({ scene, camera });
    this.snow = new SnowSystem({ scene, camera });
    this.lightning = new LightningSystem({
      scene,
      audioManager,
      getCameraWorldPos,
      thunderDid: this._overrides.thunderDid,
    });

    // Environment cache, refreshed each frame by the clouds-independent
    // weather tick in loop.js (W3). Defaults keep the pre-W3 behavior
    // (outdoor, no SkyObject signal) so an unwired loop fails soft.
    this._env = {
      indoor: false,
      streakGfxId: 0,   // W1/W2: precip-mesh DID for type selection
      hasDroplets: false,
    };

    // Reusable scratch for the per-frame weather-flags read (zero-alloc).
    this._wxFlags = { is_storm: false, temperature_C: NaN };
  }

  /**
   * W3/W5 (2026-05-29) — push the per-frame environment from loop.js (the
   * clouds-independent driver). `indoor` gates all precip; the SkyObject
   * scan fields refine precip-type selection.
   *
   * @param {{indoor?:boolean, streakGfxId?:number, hasDroplets?:boolean}} env
   */
  setEnvironment(env) {
    if (!env) return;
    if (typeof env.indoor === "boolean") this._env.indoor = env.indoor;
    if (Number.isFinite(env.streakGfxId)) this._env.streakGfxId = env.streakGfxId >>> 0;
    if (typeof env.hasDroplets === "boolean") this._env.hasDroplets = env.hasDroplets;
  }

  /**
   * Decide rain vs snow for this frame. Manual `?snow=on`/`?rain=on`
   * wins; otherwise cold profile temperature → snow. (Future: key off
   * `_env.streakGfxId` once W1 maps the streak-mesh DID to precip type.)
   * @returns {"rain"|"snow"}
   */
  _selectPrecip(temperatureC) {
    if (this._overrides.snowForce === true) return "snow";
    if (this._overrides.rainForce === true) return "rain";
    if (Number.isFinite(temperatureC) && temperatureC <= SNOW_TEMPERATURE_C) {
      return "snow";
    }
    return "rain";
  }

  tick(dt) {
    let storm = false;
    let temperatureC = NaN;
    try {
      const s = readWeatherFlags(this._wxFlags);
      storm = !!s?.is_storm;
      temperatureC = Number.isFinite(s?.temperature_C) ? s.temperature_C : NaN;
    } catch (_) {}

    const indoor = this._env.indoor === true;

    // Precip on/off — URL force wins, else storm flag; ALWAYS off indoors.
    // `?rain=on`/`?snow=on` → on; `?rain=off`/`?snow=off` → off; else storm.
    const forceOn =
      this._overrides.rainForce === true || this._overrides.snowForce === true;
    const forceOff =
      this._overrides.rainForce === false || this._overrides.snowForce === false;
    let precipOn = forceOn ? true : (forceOff ? false : storm);
    if (indoor) precipOn = false;

    const lightningOn = indoor
      ? false
      : (this._overrides.lightningForce ?? storm);

    const precipType = this._selectPrecip(temperatureC);
    const rainIntensity =
      precipOn && precipType === "rain" ? STORM_RAIN_INTENSITY : 0;
    const snowIntensity =
      precipOn && precipType === "snow" ? STORM_SNOW_INTENSITY : 0;

    // W5 — wind drift scales with the active precip intensity (calm when
    // there's no precip; full at storm intensity).
    const windScale = Math.max(rainIntensity, snowIntensity);
    this.rain.setWindScale?.(windScale);
    this.snow.setWindScale?.(windScale);

    this.rain.setIntensity(rainIntensity);
    this.snow.setIntensity(snowIntensity);
    this.lightning.setRate(lightningOn ? STORM_LIGHTNING_RATE : 0);

    this.rain.tick(dt);
    this.snow.tick(dt);
    this.lightning.tick(dt);
  }

  /** Dev-only: force one flash now (bypasses Poisson timer). */
  flashNow() {
    this.lightning.flashNow();
  }

  dispose() {
    this.rain?.dispose();
    this.snow?.dispose();
    this.lightning?.dispose();
    this.rain = null;
    this.snow = null;
    this.lightning = null;
  }
}
