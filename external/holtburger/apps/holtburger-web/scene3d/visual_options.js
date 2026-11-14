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
export const CHARACTER_OPTION_DISABLE_WEATHER = DISABLE_WEATHER_OPTION;
/** `holtburger_common::CharacterOption::DisableDistanceFog`. */
export const DISABLE_DISTANCE_FOG_OPTION = 0x30;
/** SkyObject properties bit retail skips with weather off (`GameSky::MakeObject`). */
export const SKY_OBJ_WEATHER = 0x04;
/** Option re-read cadence (the same as always_daylight.js). */
export const VISUAL_OPTIONS_POLL_MS = 250;
/** The fog band while the fog is disabled: far beyond any drawn world. */
export const FOG_DISABLED_NEAR_M = 1e7;
export const FOG_DISABLED_FAR_M = 2e7;
/** Standalone localStorage persistence key for HUD / Graphics / offline weather toggle. */
export const LS_WEATHER_ENABLED_KEY = "holtburger_weather_enabled_v1";
const LS_CHAR_OPTS_KEY = "holtburger_character_options_v1";

function _query() {
  try {
    if (typeof window !== "undefined" && window.location) return new URLSearchParams(window.location.search);
  } catch (_) { /* no URL: defaults */ }
  return null;
}
const _notOff = (v) => !/^(off|0|false|no)$/i.test(String(v ?? "").trim());

const WEATHER_OPTION_ON = _notOff(_query()?.get("weatherOption"));
const FOG_OPTION_ON = _notOff(_query()?.get("distanceFogOption"));

function _readStoredWeatherPref() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    const raw = localStorage.getItem(LS_WEATHER_ENABLED_KEY);
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "off" || s === "no") return false;
  } catch (_) { /* storage unavailable */ }
  return null;
}

function _writeStoredWeatherPref(enabled) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(LS_WEATHER_ENABLED_KEY, enabled ? "true" : "false");
    const rawMap = localStorage.getItem(LS_CHAR_OPTS_KEY);
    const map = rawMap ? JSON.parse(rawMap) : {};
    if (map && typeof map === "object") {
      map[String(DISABLE_WEATHER_OPTION)] = !enabled;
      localStorage.setItem(LS_CHAR_OPTS_KEY, JSON.stringify(map));
    }
  } catch (_) { /* storage unavailable */ }
}

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
let _userPrefEnabled = null;       // null = unset locally, boolean = explicit user/persisted pref
let _userPrefLoaded = false;
let _lastServerDisableBit = null;  // tracks server-side 0x04 transitions
const _weatherListeners = new Set();

function _ensureUserPrefLoaded() {
  if (_userPrefLoaded) return;
  _userPrefLoaded = true;
  _userPrefEnabled = _readStoredWeatherPref();
}

function _notifyWeatherListeners(enabled) {
  for (const fn of _weatherListeners) {
    try { fn(enabled); } catch (_) { /* listener fault-isolated */ }
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("hb-weather-enabled-changed", { detail: { enabled } }));
    }
  } catch (_) { /* headless / non-DOM safe */ }
}

/**
 * Subscribe to weather enabled/disabled state changes (HUD bar, Graphics Settings, Options Panel).
 * Returns an unsubscribe function.
 */
export function onWeatherEnabledChange(listener) {
  if (typeof listener !== "function") return () => {};
  _weatherListeners.add(listener);
  return () => { _weatherListeners.delete(listener); };
}

/**
 * Whether weather effects are currently enabled (true by default).
 * Works standalone offline via localStorage AND syncs with CharacterOption 0x04 when online.
 */
export function isWeatherEnabled(handle) {
  if (!WEATHER_OPTION_ON) return true;
  _ensureUserPrefLoaded();
  const h = handle ?? (typeof window !== "undefined" ? window.__sessionHandle : null);
  const hasServer = !!(h && typeof h.isCharacterOptionEnabled === "function");
  if (hasServer) {
    const serverDisable = readCharacterOption(h, DISABLE_WEATHER_OPTION);
    if (_userPrefEnabled !== null && _lastServerDisableBit === serverDisable) {
      return _userPrefEnabled;
    }
    return !serverDisable;
  }
  if (_userPrefEnabled !== null) return _userPrefEnabled;
  return true;
}

/**
 * Enable or disable weather effects live from HUD, Graphics Settings, or Options Panel.
 * Persists to `holtburger_weather_enabled_v1` in localStorage AND syncs bidirectionally
 * with `handle.setCharacterOption(0x04, !enabled)` when connected.
 */
export function setWeatherEnabled(enabled, opts = {}) {
  const next = !!enabled;
  const persist = opts?.persist !== false;
  const syncServer = opts?.syncServer !== false;
  _ensureUserPrefLoaded();
  const prev = isWeatherEnabled(opts?.handle);
  _userPrefEnabled = next;
  if (persist) _writeStoredWeatherPref(next);

  const h = opts?.handle ?? (typeof window !== "undefined" ? window.__sessionHandle : null);
  if (syncServer && h && typeof h.setCharacterOption === "function") {
    try {
      h.setCharacterOption(DISABLE_WEATHER_OPTION, !next);
      _lastServerDisableBit = !next;
    } catch (_) { /* fail-soft */ }
  } else if (h && typeof h.isCharacterOptionEnabled === "function") {
    _lastServerDisableBit = !next;
  }

  _state.weatherOff = WEATHER_OPTION_ON ? !next : false;
  _state.nextPollMs = -Infinity;
  if (prev !== next || opts?.forceNotify) {
    _notifyWeatherListeners(next);
  }
  return next;
}

/** Toggle weather effects enabled state and return the new boolean value. */
export function toggleWeatherEnabled(opts = {}) {
  return setWeatherEnabled(!isWeatherEnabled(opts?.handle), opts);
}

/**
 * The two options, re-read from the session at most every
 * `VISUAL_OPTIONS_POLL_MS` (`handle` defaults to `window.__sessionHandle`).
 * Returns the shared state object; do not keep or mutate it.
 */
export function readVisualOptions(handle, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!(now < _state.nextPollMs)) {
    _ensureUserPrefLoaded();
    const h = handle ?? (typeof window !== "undefined" ? window.__sessionHandle : null);
    const hasServer = !!(h && typeof h.isCharacterOptionEnabled === "function");
    let disableWeather = false;
    if (hasServer) {
      let serverDisable = readCharacterOption(h, DISABLE_WEATHER_OPTION);
      if (_lastServerDisableBit === null && _userPrefEnabled !== null && typeof h.setCharacterOption === "function") {
        // Carry an explicit offline/HUD preference into a newly connected session.
        if (serverDisable !== !_userPrefEnabled) {
          try { h.setCharacterOption(DISABLE_WEATHER_OPTION, !_userPrefEnabled); } catch (_) { /* fail-soft */ }
          serverDisable = !_userPrefEnabled;
        }
      } else if (_lastServerDisableBit !== null && serverDisable !== _lastServerDisableBit) {
        // Server option changed externally (e.g., server login packet or /option command).
        const nextEnabled = !serverDisable;
        if (_userPrefEnabled !== nextEnabled) {
          _userPrefEnabled = nextEnabled;
          _writeStoredWeatherPref(nextEnabled);
          _notifyWeatherListeners(nextEnabled);
        }
      }
      _lastServerDisableBit = serverDisable;
      disableWeather = (_userPrefEnabled !== null && typeof h.setCharacterOption !== "function")
        ? !_userPrefEnabled
        : serverDisable;
    } else {
      _lastServerDisableBit = null;
      disableWeather = _userPrefEnabled !== null ? !_userPrefEnabled : false;
    }
    _state.weatherOff = WEATHER_OPTION_ON && disableWeather;
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

/** Test seam: forget the cached poll and transient local override. */
export function _resetVisualOptionsForTest() {
  _state.weatherOff = false;
  _state.fogOff = false;
  _state.nextPollMs = -Infinity;
  _userPrefEnabled = null;
  _userPrefLoaded = false;
  _lastServerDisableBit = null;
}

if (typeof window !== "undefined") {
  window.__visualOptions = {
    read: () => ({ ..._state }),
    isWeatherEnabled: () => isWeatherEnabled(),
    setWeatherEnabled: (v) => setWeatherEnabled(v),
    toggleWeatherEnabled: () => toggleWeatherEnabled(),
  };
}
