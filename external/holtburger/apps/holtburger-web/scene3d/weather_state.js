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
export function latLonFromWorld(worldX, worldZ) {
  // world Z is negated relative to AC Y (north is -Z in three.js space).
  const acY_m = -worldZ;
  const acX_m = worldX;
  const lb_y = acY_m / LANDBLOCK_M;
  const lb_x = acX_m / LANDBLOCK_M;
  return {
    lat: lb_y * LAT_PER_LANDBLOCK_Y,
    lon: lb_x * LON_PER_LANDBLOCK_X,
  };
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

function recompute() {
  state.lcl_m = lclMeters(state.temperature_C, state.dewpoint_C);
  state.etage_m = etageRanges(state.latitude_deg);
  // etageRanges is banded (25°/60°), so etage_m.high.max only shifts at a
  // latitude-band boundary — signing on it (not raw latitude) means walking
  // within a band doesn't bump the revision every frame.
  const storm = state.is_storm ? 1 : 0;
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
export function updateFromPosition(worldX, worldZ) {
  const { lat, lon } = latLonFromWorld(worldX, worldZ);
  state.latitude_deg = lat;
  state.longitude_deg = lon;
  recompute();
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
  if (!overrides.temperature_C       && Number.isFinite(profile.temperature_C))       state.temperature_C       = profile.temperature_C;
  if (!overrides.dewpoint_C          && Number.isFinite(profile.dewpoint_C))          state.dewpoint_C          = profile.dewpoint_C;
  if (!overrides.surface_pressure_hPa && Number.isFinite(profile.surface_pressure_hPa)) state.surface_pressure_hPa = profile.surface_pressure_hPa;
  if (!overrides.is_storm            && typeof profile.is_storm === 'boolean')        state.is_storm            = profile.is_storm;
  if (!overrides.season              && Number.isFinite(profile.season))              state.season              = profile.season;
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

/** Read-only snapshot of the current weather state. */
export function getWeatherState() {
  return {
    latitude_deg: state.latitude_deg,
    longitude_deg: state.longitude_deg,
    temperature_C: state.temperature_C,
    dewpoint_C: state.dewpoint_C,
    surface_pressure_hPa: state.surface_pressure_hPa,
    is_storm: state.is_storm,
    season: state.season,
    lcl_m: state.lcl_m,
    etage_m: { ...state.etage_m },
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
  dst.is_storm = state.is_storm;
  dst.temperature_C = state.temperature_C;
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
  dst.is_storm = state.is_storm;
  dst.temperature_C = state.temperature_C;
  dst.season = state.season;
  return dst;
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
  window.__clearWeatherOverride = clearWeatherOverride;
}
