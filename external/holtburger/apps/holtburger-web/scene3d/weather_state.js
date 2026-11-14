// scene3d/weather_state.js — Clouds-E.1 WMO-anchored weather state.
//
// Sole source of meteorologically-grounded variables that drive cloud-layer
// altitudes, densities, and storm flags. Long-term this is replaced by a
// pressure-system simulation; for Clouds-E it's a static-ish state driven by
// (a) world position → latitude, (b) active DayGroup → (T, Td, pressure)
// triplet, (c) user-set overrides via `window.__setWeather`.
//
// All altitudes are in METERS in this module's output (matches takram's
// minLayerHeights/maxLayerHeights units). Inputs may be in feet or other
// units — converted at the boundary. Espy's LCL formula is in feet by
// tradition; we convert.

// --- Constants ---------------------------------------------------------

const M_PER_FT = 0.3048;

// Espy's equation: LCL_ft = 400 × (T_C - Td_C). The 400 ft/°C constant is
// an empirical fit for convective LCL — 122 m/°C in metric. Used by US
// National Weather Service. Real LCL formula (Bolton 1980) is more
// accurate but Espy's matches retail-game weather feel.
const LCL_FT_PER_DEGC = 400.0;

// AC landblock coords → world meters: each landblock is 192 × 192 m.
// Holtburg at LB (0xA9, 0xB4) = (169, 180) — anchored at 45°N, 32°E per
// user's spec. Latitude grows linearly with Y landblock index — Dereth
// covers ~64° of "latitude" from southern edge (Y=0 → 0°N) to northern
// edge (Y=255 → 63.75°N). Equator on the southern map edge.
//
// Longitude similarly grows with X — 32°E at X=169 → 0.189°/landblock,
// span 0° (X=0) to ~48°E (X=255). These are fantasy-world degrees, not
// geographic — the WMO formulas only care about latitude magnitude for
// the polar/tropical étage adjustments.
const LANDBLOCK_M = 192;
const LAT_PER_LANDBLOCK_Y = 45.0 / 180.0;  // = 0.25°/landblock
const LON_PER_LANDBLOCK_X = 32.0 / 169.0;  // ≈ 0.189°/landblock

// WMO étage altitude limits (mid-latitude, in feet — converted to meters
// at use). Source: WMO International Cloud Atlas (2017 edition) Vol. I §1.4.
// Cirrus floor at high latitudes can drop to ~3 km (≈10,000 ft).
const ETAGE_MID_LAT_FT = {
  low: { min: 0, max: 6500 },
  middle: { min: 6500, max: 23000 },
  high: { min: 16500, max: 45000 },
};
const ETAGE_TROPICAL_FT = {
  low: { min: 0, max: 6500 },
  middle: { min: 6500, max: 25000 },
  high: { min: 20000, max: 60000 },  // tropical cirrus extends very high
};
const ETAGE_POLAR_FT = {
  low: { min: 0, max: 6500 },
  middle: { min: 6500, max: 13000 },
  high: { min: 10000, max: 26000 },  // polar cirrus much lower
};

// --- State -------------------------------------------------------------

/**
 * The shared mutable weather state. Initialised with a temperate-Holtburg
 * baseline; updated by:
 *  - `updateFromPosition(worldX, worldZ)` per-frame  → latitude
 *  - `updateFromDayGroup(profile)` on DayGroup change → (T, Td, P, is_storm)
 *  - `window.__setWeather(partial)` for live tuning → any field
 */
const state = {
  // Position-derived
  latitude_deg: 45.0,
  longitude_deg: 32.0,

  // DayGroup-derived (or override)
  temperature_C: 15.0,
  dewpoint_C: 10.0,
  surface_pressure_hPa: 1013.25,
  is_storm: false,

  // Convenience
  season: 1,  // 0=winter, 1=spring, 2=summer, 3=autumn (unused for now)

  // Computed (cached for cheap reads from cloud_volume.js)
  lcl_m: 0,
  etage_m: { low: { min: 0, max: 0 }, middle: { min: 0, max: 0 }, high: { min: 0, max: 0 } },
};

// --- Extended cloud-associated weather & biome state --------------------

const _derived = {
  rh_pct: 72.0,
  precip_mm_hr: 0.0,
  weather_kind: 'clear',      // 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'blizzard' | 'off'
  precip_intensity: 0.0,      // 0..1 modulated by overhead cloud factor
  biome_temp_offset_C: 0.0,
  lightning_flash: 0.0,       // 0..1 scene illumination flash
  cloud_sheet_flash: 0.0,     // 0..1 internal volumetric cloud-sheet radiance
  strike_x: 0.0,
  strike_y: 800.0,
  strike_z: 0.0,
  overhead_cloud_factor: 1.0, // 0..1 from cloud_volume (1.0 fallback when clouds off)
  dense_cloud_azimuth: 0.0,   // radians toward thickest nearby storm cloud cell
  coverage_boost: 0.0,
  base_drop_m: 0.0,
  darkening: 0.0,
  suppressed: false,          // true when HUD/options disable weather effects
};

const _biome = {
  active: false,
  snowIceFrac: 0.0,
  elevationM: 0.0,
  waterFrac: 0.0,
};

let _rawDayGroupProfile = {
  name: 'partly-cloudy',
  temperature_C: 15.0,
  dewpoint_C: 10.0,
  surface_pressure_hPa: 1013.25,
  is_storm: false,
};

function _readLocationSearch() {
  try {
    return typeof window !== 'undefined' && window.location ? String(window.location.search || '') : '';
  } catch (_) {
    return '';
  }
}

/**
 * Parse `?weather=auto|clear|cloudy|rain|storm|snow|blizzard|off` from a query string.
 */
export function parseWeatherUrlMode(search) {
  let raw = null;
  try {
    const s = search !== undefined ? String(search || '') : _readLocationSearch();
    raw = new URLSearchParams(s).get('weather');
  } catch (_) {
    raw = null;
  }
  if (raw == null) return 'auto';
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === 'auto' || v === 'on' || v === '1' || v === 'true' || v === 'yes') return 'auto';
  if (v === 'off' || v === '0' || v === 'false' || v === 'no' || v === 'none') return 'off';
  if (v === 'clear' || v === 'sunny' || v === 'fair') return 'clear';
  if (v === 'cloudy' || v === 'overcast') return 'cloudy';
  if (v === 'rain' || v === 'light-rain' || v === 'heavy-rain' || v === 'drizzle') return 'rain';
  if (v === 'storm' || v === 'thunderstorm' || v === 'lightning' || v === 'squall') return 'storm';
  if (v === 'snow' || v === 'light-snow' || v === 'heavy-snow') return 'snow';
  if (v === 'blizzard') return 'blizzard';
  return 'auto';
}

let _weatherMode = parseWeatherUrlMode();

/** Active weather mode (`'auto'` unless overridden via `?weather=...` or `setWeatherMode`). */
export function getWeatherMode() {
  return _weatherMode;
}

/** Override weather mode (`'auto'|'clear'|'cloudy'|'rain'|'storm'|'snow'|'blizzard'|'off'`). */
export function setWeatherMode(mode) {
  _weatherMode = parseWeatherUrlMode(mode == null ? '' : `?weather=${mode}`);
  recompute();
  return _weatherMode;
}

/**
 * Magnus-Tetens relative humidity [0..100%] from temperature and dewpoint (°C).
 */
export function relativeHumidityPct(T_C, Td_C) {
  const T = Number.isFinite(T_C) ? T_C : 15;
  const Td = Number.isFinite(Td_C) ? Math.min(T, Td_C) : 10;
  const esT = 6.112 * Math.exp((17.67 * T) / (T + 243.5));
  const esTd = 6.112 * Math.exp((17.67 * Td) / (Td + 243.5));
  if (!(esT > 0)) return 0;
  return Math.max(0, Math.min(100, (100 * esTd) / esT));
}

/**
 * Environmental temperature offset (°C) from local terrain snow/ice coverage,
 * elevation above sea level, and Dereth latitude.
 */
export function biomeTempOffsetC(snowIceFrac, elevationM, latitudeDeg) {
  const snowIce = Math.min(1, Math.max(0, Number(snowIceFrac) || 0));
  const elev = Number.isFinite(elevationM) ? elevationM : 0;
  const lat = Number.isFinite(latitudeDeg) ? Math.abs(latitudeDeg) : 45;
  let offset = 0;
  if (elev > 120) offset -= (elev - 120) * 0.0085;
  if (lat > 52) offset -= (lat - 52) * 1.15;
  if (snowIce >= 0.12) offset -= 10 + 18 * snowIce;
  return offset;
}

// --- Pure-fn calculators (testable + idempotent) -----------------------

/**
 * Lifted Condensation Level (cloud base altitude) per Espy's equation.
 * @param {number} T_C  surface temperature in Celsius
 * @param {number} Td_C surface dewpoint in Celsius
 * @returns {number} LCL in METERS above the surface (clamped ≥ 0)
 */
export function lclMeters(T_C, Td_C) {
  const spread = Math.max(0, T_C - Td_C);
  return spread * LCL_FT_PER_DEGC * M_PER_FT;
}

/**
 * WMO étage altitude ranges for a given latitude (degrees, signed).
 * Polar (|lat| > 60°) → compressed/lower ranges. Tropical (|lat| < 25°)
 * → expanded/higher. Mid-latitude default.
 * @param {number} lat_deg
 * @returns {{low:{min:number,max:number}, middle:{min:number,max:number}, high:{min:number,max:number}}} all in METERS
 */
export function etageRanges(lat_deg) {
  const abs = Math.abs(lat_deg);
  let table;
  if (abs >= 60) {
    table = ETAGE_POLAR_FT;
  } else if (abs <= 25) {
    table = ETAGE_TROPICAL_FT;
  } else {
    table = ETAGE_MID_LAT_FT;
  }
  const f2m = (ft) => ft * M_PER_FT;
  return {
    low:    { min: f2m(table.low.min),    max: f2m(table.low.max) },
    middle: { min: f2m(table.middle.min), max: f2m(table.middle.max) },
    high:   { min: f2m(table.high.min),   max: f2m(table.high.max) },
  };
}

/**
 * World position (three.js coords) → (latitude, longitude) using the
 * Holtburg-anchored mapping documented above. Z is negative-north in
 * three.js post-acToThree.
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {{lat: number, lon: number}}
 */
export function latLonFromWorld(worldX, worldZ, out) {
  // world Z is negated relative to AC Y (north is -Z in three.js space).
  const acY_m = -worldZ;
  const acX_m = worldX;
  const lb_y = acY_m / LANDBLOCK_M;
  const lb_x = acX_m / LANDBLOCK_M;
  // `out` is the zero-alloc seam (same shape as readWeatherFlags): pass a
  // reusable scratch on the per-frame path. Omitting it keeps the original
  // fresh-object return for callers/tests that read it directly.
  const dst = out || {};
  dst.lat = lb_y * LAT_PER_LANDBLOCK_Y;
  dst.lon = lb_x * LON_PER_LANDBLOCK_X;
  return dst;
}

// --- State mutators ----------------------------------------------------

/**
 * Recompute derived fields (LCL, étage ranges) from current temperature,
 * dewpoint, and latitude. Called automatically after any mutator.
 */
// Cloud-config change revision — bumped by recompute() ONLY when a field that
// `_applyWeatherToCloudLayers` reads actually changes, so cloud_volume can
// re-apply the layer config on change rather than every frame. Zero-alloc
// scalar compares (recompute runs per-frame via updateFromPosition/DayGroup).
let _cloudConfigRevision = 0;
let _sigT = NaN, _sigTd = NaN, _sigStorm = -1, _sigEtageHigh = NaN;

// Étage band memo (2026-08-03). Only the REVISION compare below was ever
// zero-alloc: `etageRanges()` built 4 nested objects + a closure and
// `latLonFromWorld()` one more, EVERY frame, because recompute() runs per-rAF
// via cloud_overlay.tick -> updateFromPosition -- ~6 short-lived objects/frame
// plus the discarded previous etage_m graph. etageRanges is BANDED (|lat| <= 25
// tropical / >= 60 polar / else mid), so the result can only change at a band
// crossing; memoise on the band and reuse the object. Nothing mutates
// `state.etage_m` in place (getWeatherState shallow-copies it; readWeatherFlags
// and readWeatherVfxInputs never touch it), so sharing the object is safe.
let _etageBand = -1;
function _latBand(lat_deg) {
  const abs = Math.abs(lat_deg);
  return abs >= 60 ? 2 : (abs <= 25 ? 0 : 1);
}

function _applyBiomeTemperatureIfActive() {
  if (!_biome.active || overrides.temperature_C) {
    _derived.biome_temp_offset_C = 0;
    return;
  }
  const offset = biomeTempOffsetC(_biome.snowIceFrac, _biome.elevationM, state.latitude_deg);
  _derived.biome_temp_offset_C = offset;
  const baseT = _rawDayGroupProfile.temperature_C;
  const spread = Math.max(0.5, baseT - _rawDayGroupProfile.dewpoint_C);
  let nextT = baseT + offset;
  if (_biome.snowIceFrac >= 0.15) {
    nextT = Math.min(nextT, -2.5 - 6.0 * _biome.snowIceFrac);
  }
  state.temperature_C = nextT;
  if (!overrides.dewpoint_C) {
    state.dewpoint_C = nextT - (_biome.snowIceFrac >= 0.15 ? Math.min(spread, 2.0) : spread);
  }
}

function _recomputeDerivedWeather() {
  const mode = _weatherMode;
  const cloudFactor = Math.min(1, Math.max(0, _derived.overhead_cloud_factor));
  // Cloud-modulated local precipitation intensity: 0.35 + 0.65 * overheadCloudFactor
  const cloudMod = 0.35 + 0.65 * cloudFactor;

  let effT = state.temperature_C;
  let effTd = state.dewpoint_C;
  if (mode === 'storm' && !overrides.temperature_C && effT < 4 && _biome.snowIceFrac < 0.15) {
    effT = 18; effTd = 16.5;
  } else if ((mode === 'snow' || mode === 'blizzard') && !overrides.temperature_C && effT > -2) {
    effT = mode === 'blizzard' ? -8 : -3;
    effTd = effT - 1.2;
  } else if (mode === 'rain' && !overrides.temperature_C && effT <= 1) {
    effT = 12; effTd = 11;
  } else if (mode === 'cloudy' && !overrides.dewpoint_C) {
    effTd = Math.max(effTd, effT - 2.2);
  } else if (mode === 'clear' && !overrides.dewpoint_C) {
    effTd = Math.min(effTd, effT - 12);
  }

  let rh = relativeHumidityPct(effT, effTd);
  const effectiveStorm = _derived.suppressed
    ? false
    : mode === 'storm' || mode === 'blizzard'
      ? true
      : mode === 'clear' || mode === 'cloudy' || mode === 'rain' || mode === 'snow' || mode === 'off'
        ? false
        : state.is_storm;

  if (effectiveStorm && rh < 86) rh = 88;

  let kind = 'clear';
  let intensity = 0;
  let precipMmHr = 0;
  const isCold = effT <= 0.5 || (_biome.active && _biome.snowIceFrac >= 0.2);

  if (_derived.suppressed || mode === 'off') {
    kind = 'off';
    intensity = 0;
    precipMmHr = 0;
  } else if (mode === 'clear') {
    kind = 'clear';
    rh = Math.min(rh, 48);
  } else if (mode === 'cloudy') {
    kind = 'cloudy';
    rh = Math.max(rh, 82);
  } else if (mode === 'rain') {
    kind = 'rain';
    intensity = 0.68 * cloudMod;
    precipMmHr = 7.5 * cloudMod;
    rh = Math.max(rh, 88);
  } else if (mode === 'storm') {
    kind = 'storm';
    intensity = 0.94 * cloudMod;
    precipMmHr = 18.0 * cloudMod;
    rh = Math.max(rh, 92);
  } else if (mode === 'snow') {
    kind = 'snow';
    intensity = 0.72 * cloudMod;
    precipMmHr = 4.2 * cloudMod;
    rh = Math.max(rh, 85);
  } else if (mode === 'blizzard') {
    kind = 'blizzard';
    intensity = 1.0 * cloudMod;
    precipMmHr = 11.5 * cloudMod;
    rh = Math.max(rh, 92);
  } else {
    // Auto mode: driven by DayGroup + real SkyObject storm scan + biome climate + cloud density
    const profName = _rawDayGroupProfile.name || '';
    if (effectiveStorm) {
      if (isCold) {
        const heavy = effT <= -5 || _biome.snowIceFrac >= 0.5;
        kind = heavy ? 'blizzard' : 'snow';
        intensity = (heavy ? 0.96 : 0.80) * cloudMod;
        precipMmHr = (heavy ? 10.5 : 5.5) * cloudMod;
      } else {
        kind = 'storm';
        intensity = 0.90 * cloudMod;
        precipMmHr = 16.0 * cloudMod;
      }
    } else if (profName === 'heavy-rain' || profName === 'light-rain' || profName === 'drizzle') {
      const base = profName === 'heavy-rain' ? 0.75 : profName === 'light-rain' ? 0.48 : 0.30;
      kind = isCold ? 'snow' : 'rain';
      intensity = base * cloudMod;
      precipMmHr = (isCold ? 3.8 : 7.0) * intensity;
    } else if (profName === 'heavy-snow' || profName === 'light-snow') {
      const base = profName === 'heavy-snow' ? 0.82 : 0.50;
      kind = isCold || !overrides.temperature_C ? 'snow' : 'rain';
      intensity = base * cloudMod;
      precipMmHr = 4.5 * intensity;
    } else if (_biome.active && _biome.snowIceFrac >= 0.32 && rh >= 58 && cloudFactor >= 0.30) {
      // Natural alpine/glacial snowfall under cloud cover (replaces basic 520-dot fx_fields snow)
      kind = 'snow';
      intensity = (0.24 + 0.34 * _biome.snowIceFrac) * cloudMod;
      precipMmHr = 1.8 * intensity;
    } else if (rh >= 76 || state.surface_pressure_hPa <= 1009) {
      kind = 'cloudy';
    } else {
      kind = 'clear';
    }
  }

  _derived.rh_pct = rh;
  _derived.weather_kind = kind;
  _derived.precip_intensity = Math.min(1, Math.max(0, intensity));
  _derived.precip_mm_hr = Math.max(0, precipMmHr);

  // Bidirectional cloud thickening, base lowering, and storm-base darkening
  if (kind === 'storm' || kind === 'blizzard') {
    _derived.coverage_boost = 0.14 + 0.10 * _derived.precip_intensity;
    _derived.base_drop_m = 220 * _derived.precip_intensity;
    _derived.darkening = 0.35 + 0.30 * _derived.precip_intensity;
  } else if (kind === 'rain' || kind === 'snow') {
    _derived.coverage_boost = 0.08 + 0.08 * _derived.precip_intensity;
    _derived.base_drop_m = 130 * _derived.precip_intensity;
    _derived.darkening = 0.18 + 0.20 * _derived.precip_intensity;
  } else if (kind === 'cloudy') {
    _derived.coverage_boost = 0.05;
    _derived.base_drop_m = 45;
    _derived.darkening = 0.08;
  } else {
    _derived.coverage_boost = 0;
    _derived.base_drop_m = 0;
    _derived.darkening = 0;
  }
}

function recompute() {
  state.lcl_m = lclMeters(state.temperature_C, state.dewpoint_C);
  const band = _latBand(state.latitude_deg);
  if (band !== _etageBand) {
    _etageBand = band;
    state.etage_m = etageRanges(state.latitude_deg);
  }
  _recomputeDerivedWeather();
  // etageRanges is banded (25°/60°), so etage_m.high.max only shifts at a
  // latitude-band boundary — signing on it (not raw latitude) means walking
  // within a band doesn't bump the revision every frame.
  const storm = (state.is_storm || _weatherMode === 'storm' || _weatherMode === 'blizzard') ? 1 : 0;
  if (state.temperature_C !== _sigT || state.dewpoint_C !== _sigTd ||
      storm !== _sigStorm || state.etage_m.high.max !== _sigEtageHigh) {
    _sigT = state.temperature_C;
    _sigTd = state.dewpoint_C;
    _sigStorm = storm;
    _sigEtageHigh = state.etage_m.high.max;
    _cloudConfigRevision++;
  }
}

/**
 * Monotonic revision that increments whenever a cloud-layer-config-relevant
 * weather field (T, Td, is_storm, or the latitude étage band) changes. Lets
 * cloud_volume re-apply `_applyWeatherToCloudLayers` only on change (DayGroup
 * transitions, storm onset, __setWeather). Zero-alloc.
 */
export function getWeatherRevision() {
  return _cloudConfigRevision;
}

/**
 * Update latitude/longitude from the camera's world position.
 * Per-frame; cheap.
 */
const _latLonScratch = { lat: 0, lon: 0 };

export function updateFromPosition(worldX, worldZ) {
  // Per-frame path (cloud_overlay.tick) — scratch, not a fresh object.
  const ll = latLonFromWorld(worldX, worldZ, _latLonScratch);
  state.latitude_deg = ll.lat;
  state.longitude_deg = ll.lon;
  if (_biome.active && !overrides.temperature_C) {
    _applyBiomeTemperatureIfActive();
  }
  recompute();
}

/**
 * Update biome/terrain climate context around the camera (`FAM_SNOWICE` fraction,
 * ground elevation in meters, water fraction). Zero-alloc per call.
 */
export function updateBiomeClimate(biome) {
  if (!biome) return;
  _biome.active = true;
  if (Number.isFinite(biome.snowIceFrac)) _biome.snowIceFrac = Math.min(1, Math.max(0, biome.snowIceFrac));
  if (Number.isFinite(biome.elevationM)) _biome.elevationM = biome.elevationM;
  if (Number.isFinite(biome.waterFrac)) _biome.waterFrac = Math.min(1, Math.max(0, biome.waterFrac));
  _applyBiomeTemperatureIfActive();
  recompute();
}

/**
 * Feed overhead cloud density / shadow factor [0..1] from `cloud_volume.js`
 * (defaults to 1.0 when volumetric clouds are disabled) and optional azimuth
 * toward the densest nearby storm cloud cell.
 */
export function setCloudOverheadFactor(factor, denseAzimuthRad) {
  const f = Number.isFinite(factor) ? Math.min(1, Math.max(0, factor)) : 1.0;
  const changed = Math.abs(f - _derived.overhead_cloud_factor) > 1e-4;
  _derived.overhead_cloud_factor = f;
  if (Number.isFinite(denseAzimuthRad)) _derived.dense_cloud_azimuth = denseAzimuthRad;
  if (changed) _recomputeDerivedWeather();
}

/**
 * Publish live lightning illumination state (scene directional flash + internal
 * volumetric cloud-sheet glow + 3D strike position) from `lightning_effect.js`.
 */
export function setLightningFlashState(sceneFlash, cloudSheetFlash, strikeX = 0, strikeY = 800, strikeZ = 0) {
  _derived.lightning_flash = Number.isFinite(sceneFlash) ? Math.max(0, sceneFlash) : 0;
  _derived.cloud_sheet_flash = Number.isFinite(cloudSheetFlash) ? Math.min(1, Math.max(0, cloudSheetFlash)) : 0;
  if (Number.isFinite(strikeX)) _derived.strike_x = strikeX;
  if (Number.isFinite(strikeY)) _derived.strike_y = strikeY;
  if (Number.isFinite(strikeZ)) _derived.strike_z = strikeZ;
}

/** Set whether weather effects are globally suppressed by HUD / character option 0x04. */
export function setWeatherSuppressed(suppressed) {
  const s = !!suppressed;
  if (_derived.suppressed !== s) {
    _derived.suppressed = s;
    if (s) {
      _derived.lightning_flash = 0;
      _derived.cloud_sheet_flash = 0;
    }
    _recomputeDerivedWeather();
  }
}

// Per-field user override flags. When a field is overridden via
// __setWeather, subsequent DayGroup updates SKIP that field. Cleared
// via __clearWeatherOverride() (no arg → all; arg → specific field).
const overrides = {
  temperature_C: false,
  dewpoint_C: false,
  surface_pressure_hPa: false,
  is_storm: false,
  season: false,
};

/**
 * Apply a DayGroup-derived weather profile (from `daygroup_weather.js` in
 * Clouds-E.2). Profile has (T, Td, pressure, is_storm). Fields with
 * active user overrides are skipped so live tuning sticks.
 */
export function updateFromDayGroup(profile) {
  if (!profile) return;
  if (typeof profile.name === 'string') _rawDayGroupProfile.name = profile.name;
  if (Number.isFinite(profile.temperature_C)) _rawDayGroupProfile.temperature_C = profile.temperature_C;
  if (Number.isFinite(profile.dewpoint_C)) _rawDayGroupProfile.dewpoint_C = profile.dewpoint_C;
  if (Number.isFinite(profile.surface_pressure_hPa)) _rawDayGroupProfile.surface_pressure_hPa = profile.surface_pressure_hPa;
  if (typeof profile.is_storm === 'boolean') _rawDayGroupProfile.is_storm = profile.is_storm;

  if (!overrides.temperature_C       && Number.isFinite(profile.temperature_C))       state.temperature_C       = profile.temperature_C;
  if (!overrides.dewpoint_C          && Number.isFinite(profile.dewpoint_C))          state.dewpoint_C          = profile.dewpoint_C;
  if (!overrides.surface_pressure_hPa && Number.isFinite(profile.surface_pressure_hPa)) state.surface_pressure_hPa = profile.surface_pressure_hPa;
  if (!overrides.is_storm            && typeof profile.is_storm === 'boolean')        state.is_storm            = profile.is_storm;
  if (!overrides.season              && Number.isFinite(profile.season))              state.season              = profile.season;
  if (_biome.active && !overrides.temperature_C) {
    _applyBiomeTemperatureIfActive();
  }
  recompute();
}

/**
 * Live-tuning entrypoint. Mounted on `window.__setWeather` at runtime.
 * Accepts a partial state object — only specified fields are updated.
 * Sets per-field override flags so DayGroup updates don't clobber.
 */
export function setWeatherOverride(partial) {
  if (!partial) return;
  for (const k of ['latitude_deg', 'longitude_deg', 'temperature_C',
                   'dewpoint_C', 'surface_pressure_hPa', 'season']) {
    if (Number.isFinite(partial[k])) {
      state[k] = partial[k];
      if (k in overrides) overrides[k] = true;
    }
  }
  if (typeof partial.is_storm === 'boolean') {
    state.is_storm = partial.is_storm;
    overrides.is_storm = true;
  }
  recompute();
}

/**
 * Clear a specific override (e.g. "let DayGroup drive temperature again")
 * or all overrides if called with no arg.
 */
export function clearWeatherOverride(field) {
  if (field == null) {
    for (const k of Object.keys(overrides)) overrides[k] = false;
  } else if (field in overrides) {
    overrides[field] = false;
  }
}

function _effectiveIsStorm() {
  if (_derived.suppressed || _weatherMode === 'off' || _weatherMode === 'clear' || _weatherMode === 'cloudy') return false;
  if (_weatherMode === 'storm' || _weatherMode === 'blizzard') return true;
  return state.is_storm;
}

function _effectiveTemperatureC() {
  if (_weatherMode === 'snow' && !overrides.temperature_C && state.temperature_C > -2) return -3;
  if (_weatherMode === 'blizzard' && !overrides.temperature_C && state.temperature_C > -6) return -8;
  if ((_weatherMode === 'rain' || _weatherMode === 'storm') && !overrides.temperature_C && state.temperature_C <= 1) return 14;
  return state.temperature_C;
}

function _buildCloudCouplingSnapshot() {
  return {
    overheadCloudFactor: _derived.overhead_cloud_factor,
    denseCloudAzimuth: _derived.dense_cloud_azimuth,
    coverageBoost: _derived.coverage_boost,
    baseDropM: _derived.base_drop_m,
    darkening: _derived.darkening,
    cloudSheetFlash: _derived.cloud_sheet_flash,
    strikeWorldPos: { x: _derived.strike_x, y: _derived.strike_y, z: _derived.strike_z },
  };
}

/**
 * Read-only snapshot of the current weather state.
 * Preserves the exact 9 enumerable keys required by `test_weather_flags.mjs`,
 * while exposing live extended fields (`rh_pct`, `precip_mm_hr`, `weather_kind`,
 * `precip_intensity`, `cloud_coupling`, `lightning_flash`) as non-enumerable
 * properties so `cloud_storm_look.js` and weather consumers read them directly!
 */
export function getWeatherState() {
  const snap = {
    latitude_deg: state.latitude_deg,
    longitude_deg: state.longitude_deg,
    temperature_C: _effectiveTemperatureC(),
    dewpoint_C: state.dewpoint_C,
    surface_pressure_hPa: state.surface_pressure_hPa,
    is_storm: _effectiveIsStorm(),
    season: state.season,
    lcl_m: state.lcl_m,
    etage_m: { ...state.etage_m },
  };
  Object.defineProperties(snap, {
    rh_pct: { value: _derived.rh_pct, enumerable: false, configurable: true },
    precip_mm_hr: { value: _derived.precip_mm_hr, enumerable: false, configurable: true },
    weather_kind: { value: _derived.weather_kind, enumerable: false, configurable: true },
    precip_intensity: { value: _derived.precip_intensity, enumerable: false, configurable: true },
    cloud_coupling: { value: _buildCloudCouplingSnapshot(), enumerable: false, configurable: true },
    lightning_flash: { value: _derived.lightning_flash, enumerable: false, configurable: true },
    cloud_sheet_flash: { value: _derived.cloud_sheet_flash, enumerable: false, configurable: true },
    weather_mode: { value: _weatherMode, enumerable: false, configurable: true },
    biome_temp_offset_C: { value: _derived.biome_temp_offset_C, enumerable: false, configurable: true },
  });
  return snap;
}

/** Full enumerable snapshot including cloud-coupling, precipitation, and lightning fields. */
export function getExtendedWeatherState() {
  return {
    latitude_deg: state.latitude_deg,
    longitude_deg: state.longitude_deg,
    temperature_C: _effectiveTemperatureC(),
    dewpoint_C: state.dewpoint_C,
    surface_pressure_hPa: state.surface_pressure_hPa,
    is_storm: _effectiveIsStorm(),
    season: state.season,
    lcl_m: state.lcl_m,
    etage_m: { ...state.etage_m },
    rh_pct: _derived.rh_pct,
    precip_mm_hr: _derived.precip_mm_hr,
    weather_kind: _derived.weather_kind,
    precip_intensity: _derived.precip_intensity,
    cloud_coupling: _buildCloudCouplingSnapshot(),
    lightning_flash: _derived.lightning_flash,
    cloud_sheet_flash: _derived.cloud_sheet_flash,
    weather_mode: _weatherMode,
    biome_temp_offset_C: _derived.biome_temp_offset_C,
  };
}

/**
 * Zero-alloc per-frame accessor for the two fields the weather Manager
 * tick reads (`is_storm` + `temperature_C`). Pass a reusable scratch
 * object as `out`; it is filled and returned (one is allocated if
 * omitted). Unlike getWeatherState() this never allocates per call,
 * which matters in the per-frame tick path. getWeatherState() stays the
 * full read-only snapshot for cloud_volume and devtools.
 */
export function readWeatherFlags(out) {
  const dst = out || {};
  dst.is_storm = _effectiveIsStorm();
  dst.temperature_C = _effectiveTemperatureC();
  return dst;
}

/**
 * Zero-alloc per-frame accessor for the three fields the VFX weather-input
 * driver reads (`is_storm` + `temperature_C` + `season`). Separate from
 * readWeatherFlags() so that accessor's two-key contract (test_weather_flags)
 * is untouched. Pass a reusable scratch object as `out`; it is filled and
 * returned. See scene3d/vfx/weather_inputs.js.
 */
export function readWeatherVfxInputs(out) {
  const dst = out || {};
  dst.is_storm = _effectiveIsStorm();
  dst.temperature_C = _effectiveTemperatureC();
  dst.season = state.season;
  return dst;
}

/**
 * Zero-alloc per-frame accessor for cloud-associated weather & lightning state.
 */
export function readWeatherCloudCoupling(out) {
  const dst = out || {};
  dst.weather_kind = _derived.weather_kind;
  dst.precip_intensity = _derived.precip_intensity;
  dst.rh_pct = _derived.rh_pct;
  dst.precip_mm_hr = _derived.precip_mm_hr;
  dst.overhead_cloud_factor = _derived.overhead_cloud_factor;
  dst.dense_cloud_azimuth = _derived.dense_cloud_azimuth;
  dst.coverage_boost = _derived.coverage_boost;
  dst.base_drop_m = _derived.base_drop_m;
  dst.darkening = _derived.darkening;
  dst.lightning_flash = _derived.lightning_flash;
  dst.cloud_sheet_flash = _derived.cloud_sheet_flash;
  dst.strike_x = _derived.strike_x;
  dst.strike_y = _derived.strike_y;
  dst.strike_z = _derived.strike_z;
  return dst;
}

/** Test seam: reset weather state, biome climate, URL mode, and overrides. */
export function _resetWeatherStateForTest() {
  clearWeatherOverride();
  _biome.active = false;
  _biome.snowIceFrac = 0;
  _biome.elevationM = 0;
  _biome.waterFrac = 0;
  _derived.overhead_cloud_factor = 1.0;
  _derived.dense_cloud_azimuth = 0;
  _derived.lightning_flash = 0;
  _derived.cloud_sheet_flash = 0;
  _derived.suppressed = false;
  _rawDayGroupProfile = {
    name: 'partly-cloudy',
    temperature_C: 15.0,
    dewpoint_C: 10.0,
    surface_pressure_hPa: 1013.25,
    is_storm: false,
  };
  state.latitude_deg = 45.0;
  state.longitude_deg = 32.0;
  state.temperature_C = 15.0;
  state.dewpoint_C = 10.0;
  state.surface_pressure_hPa = 1013.25;
  state.is_storm = false;
  state.season = 1;
  _weatherMode = parseWeatherUrlMode();
  recompute();
}

// Initialise derived fields on module load.
recompute();

// Mount the live-tuning hook so devtools can poke values.
if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-undef
  window.__setWeather = setWeatherOverride;
  // eslint-disable-next-line no-undef
  window.__getWeather = getWeatherState;
  // eslint-disable-next-line no-undef
  window.__getExtendedWeather = getExtendedWeatherState;
  // eslint-disable-next-line no-undef
  window.__setWeatherMode = setWeatherMode;
  // eslint-disable-next-line no-undef
  window.__clearWeatherOverride = clearWeatherOverride;
}
