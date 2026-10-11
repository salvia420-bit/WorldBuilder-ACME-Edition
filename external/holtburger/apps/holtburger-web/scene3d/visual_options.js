// scene3d/visual_options.js — the "Disable most weather effects" and "Disable
// distance fog" options (Options → Character → Visual; CharacterOption 0x04 =
// CharacterOptions1 DisableMostWeatherEffects, 0x30 = CharacterOptions2
// DisableDistanceFog). Until 2026-10-11 both checkboxes only reached the
// server: nothing in the renderer read either bit (the owner-bugs handoff,
// "Still open").
//
// Retail applies both from the player module at login
// (`CPlayerModule::OnInitialize`, acclient.c:452803) and on every option change
// (`CPlayerModule::OnChanged`, :452957, cases 4 and 0x30):
//   - 0x04 → `SmartBox::EnableWeather(!option)` (:143214) sets
//     `LScape::weather_enabled`. With it off, `GameSky::MakeObject` (:308434)
//     never creates a SkyObject whose properties carry 0x04 (the weather bit:
//     the streak meshes 0x01004C42/44 and the rain/snow SetupModels, props
//     0x04 / 0x05 / 0x0D), `GameSky::CreateDeletePhysicsObjects` (:308687) rebuilds the sky when
//     the option flips, and `LScape::draw` (:307778) skips the after-sky pass.
//   - 0x30 → `LScape::m_fFogEnabled = !option`; `LScape::UseTime` (:307297)
//     then calls `SetFFFogUserDisabled` and never applies `GetWorldFog` (nor the
//     AdminEnvirons override fog inside it).
//
// Here the weather bit maps onto the one place the client reads the sky
// objects (loop.js `tickWeatherState`): the weather objects are dropped before
// the storm scan and the sky-dome hosts, and the storm flag is forced off
// (an empty snapshot would otherwise fall back to the per-DayGroup table in
// daygroup_weather.js). The fog bit pushes the linear distance fog's band out
// of reach instead of removing `scene.fog`, because `scene.fog` is part of
// every material's program key (index.js `acFogLerpEnabled`): removing it
// would recompile the world. The non-retail atmosphere (aerial perspective,
// clouds) is not distance fog and stays.
//
// `?weatherOption=off` / `?distanceFogOption=off` make the checkbox inert
// again (the pre-2026-10-11 behaviour). Pure (no DOM / three imports).

/** `holtburger_common::CharacterOption::DisableMostWeatherEffects`. */
export const DISABLE_WEATHER_OPTION = 0x04;
/** `holtburger_common::CharacterOption::DisableDistanceFog`. */
export const DISABLE_DISTANCE_FOG_OPTION = 0x30;
/** SkyObject properties bit retail skips with weather off (`GameSky::MakeObject`). */
export const SKY_OBJ_WEATHER = 0x04;
/** Option re-read cadence (the same as always_daylight.js). */
export const VISUAL_OPTIONS_POLL_MS = 250;
/** The fog band while the fog is disabled: far beyond any drawn world. */
export const FOG_DISABLED_NEAR_M = 1e7;
export const FOG_DISABLED_FAR_M = 2e7;

function _query() {
  try {
    if (typeof window !== "undefined" && window.location) return new URLSearchParams(window.location.search);
  } catch (_) { /* no URL: defaults */ }
  return null;
}
const _notOff = (v) => !/^(off|0|false|no)$/i.test(String(v ?? "").trim());

const WEATHER_OPTION_ON = _notOff(_query()?.get("weatherOption"));
const FOG_OPTION_ON = _notOff(_query()?.get("distanceFogOption"));

/** One CharacterOption bit from the session, false when it cannot be read. */
export function readCharacterOption(handle, option) {
  try {
    if (handle && typeof handle.isCharacterOptionEnabled === "function") {
      return !!handle.isCharacterOptionEnabled(option);
    }
  } catch (_) {
    /* unknown index / freed handle: the option reads off */
  }
  return false;
}

const _state = { weatherOff: false, fogOff: false, nextPollMs: -Infinity };

/**
 * The two options, re-read from the session at most every
 * `VISUAL_OPTIONS_POLL_MS` (`handle` defaults to `window.__sessionHandle`).
 * Returns the shared state object; do not keep or mutate it.
 */
export function readVisualOptions(handle, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!(now < _state.nextPollMs)) {
    const h = handle ?? (typeof window !== "undefined" ? window.__sessionHandle : null);
    _state.weatherOff = WEATHER_OPTION_ON && readCharacterOption(h, DISABLE_WEATHER_OPTION);
    _state.fogOff = FOG_OPTION_ON && readCharacterOption(h, DISABLE_DISTANCE_FOG_OPTION);
    _state.nextPollMs = now + VISUAL_OPTIONS_POLL_MS;
  }
  return _state;
}

/** The SkyObject snapshots retail would create with weather off (pure). */
export function dropWeatherSkyObjects(skyObjects) {
  if (!Array.isArray(skyObjects)) return skyObjects;
  return skyObjects.filter((o) => {
    try {
      return !(o && ((o.properties >>> 0) & SKY_OBJ_WEATHER));
    } catch (_) {
      return true;   // unreadable entry: leave it to the scan's own guard
    }
  });
}

/**
 * Push a linear THREE.Fog's band out of reach (pure: duck-typed, no three
 * import). Returns true when a band was written. A FogExp2 (wireframe mode)
 * is left alone.
 */
export function disableFogBand(fog) {
  if (!fog || typeof fog.near !== "number" || typeof fog.far !== "number") return false;
  fog.near = FOG_DISABLED_NEAR_M;
  fog.far = FOG_DISABLED_FAR_M;
  return true;
}

/** Test seam: forget the cached poll. */
export function _resetVisualOptionsForTest() {
  _state.weatherOff = false;
  _state.fogOff = false;
  _state.nextPollMs = -Infinity;
}

if (typeof window !== "undefined") {
  window.__visualOptions = { read: () => ({ ..._state }) };
}
