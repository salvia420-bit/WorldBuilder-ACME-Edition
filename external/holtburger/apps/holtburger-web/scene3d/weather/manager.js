// scene3d/weather/manager.js — ties rain + lightning to weather_state.
//
// One tick per frame: reads `getWeatherState().is_storm`, applies intensities,
// then delegates to the two systems. URL knobs (`?rain=on`, `?lightning=on`,
// `?rain=off`, `?lightning=off`, `?thunderDid=0x...`) parse once at construct
// time and override the state-driven defaults.

import { RainSystem } from "./rain.js";
import { LightningSystem } from "./lightning.js";
import { getWeatherState } from "../weather_state.js";

const STORM_RAIN_INTENSITY = 1.0;
const STORM_LIGHTNING_RATE = 0.05; // flashes/sec ≈ 1 per 20 s

function parseUrlOverrides() {
  const out = {
    rainForce: null,        // null | true | false
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
    this.lightning = new LightningSystem({
      scene,
      audioManager,
      getCameraWorldPos,
      thunderDid: this._overrides.thunderDid,
    });
  }

  tick(dt) {
    let storm = false;
    try {
      const s = getWeatherState();
      storm = !!s?.is_storm;
    } catch (_) {}

    const rainOn = this._overrides.rainForce ?? storm;
    const lightningOn = this._overrides.lightningForce ?? storm;

    this.rain.setIntensity(rainOn ? STORM_RAIN_INTENSITY : 0);
    this.lightning.setRate(lightningOn ? STORM_LIGHTNING_RATE : 0);

    this.rain.tick(dt);
    this.lightning.tick(dt);
  }

  /** Dev-only: force one flash now (bypasses Poisson timer). */
  flashNow() {
    this.lightning.flashNow();
  }

  dispose() {
    this.rain?.dispose();
    this.lightning?.dispose();
    this.rain = null;
    this.lightning = null;
  }
}
