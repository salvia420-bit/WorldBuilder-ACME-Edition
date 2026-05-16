// scene3d/daygroup_weather.js — Clouds-E.2 DayGroup → weather profile.
//
// Maps active AC DayGroup state (via SkyState + dayGroupIndex) to a
// meteorological profile (T, Td, pressure, is_storm) for weather_state.js
// to consume. Two paths:
//   (a) Per-index hardcoded table — fast, deterministic, but assumes
//       retail Dereth's 20 DayGroups have a stable index order. Index 0
//       defaults to "Sunny" baseline.
//   (b) Heuristic classifier from SkyState lighting (fogMax, dirBright,
//       ambColor) — fuzzy but resilient to DayGroup reordering or to
//       non-retail SkyDesc.
//
// The exported `weatherForState(state, dayGroupIndex)` tries (a) first,
// falls back to (b) when index is out of bounds.

// 20 retail Dereth DayGroup weather profiles. Indexed 0-19 to match the
// SkyDesc.day_groups array. Order is INFERRED — retail order isn't
// formally documented, so these are educated defaults. Live-tune via
// `__setWeatherProfile(idx, partial)` to refine.
//
// Convention: temperate mid-latitude defaults — adjust the temperature
// for season/latitude downstream in weather_state. (T - Td) controls
// LCL: a 10°C spread → 4000 ft cumulus base; 2°C spread → 800 ft (low
// stratus); 20°C spread → 8000 ft (dry summer).
const PROFILES = [
  // 0 — Sunny / clear-default
  { name: 'sunny',         temperature_C: 20, dewpoint_C: 8,  surface_pressure_hPa: 1020, is_storm: false },
  // 1 — Light haze
  { name: 'hazy',          temperature_C: 22, dewpoint_C: 16, surface_pressure_hPa: 1015, is_storm: false },
  // 2 — Partly cloudy
  { name: 'partly-cloudy', temperature_C: 18, dewpoint_C: 11, surface_pressure_hPa: 1014, is_storm: false },
  // 3 — Cloudy
  { name: 'cloudy',        temperature_C: 15, dewpoint_C: 12, surface_pressure_hPa: 1010, is_storm: false },
  // 4 — Overcast
  { name: 'overcast',      temperature_C: 13, dewpoint_C: 11, surface_pressure_hPa: 1008, is_storm: false },
  // 5 — Light rain
  { name: 'light-rain',    temperature_C: 12, dewpoint_C: 11, surface_pressure_hPa: 1005, is_storm: false },
  // 6 — Thunderstorm
  { name: 'thunderstorm',  temperature_C: 22, dewpoint_C: 20, surface_pressure_hPa: 998,  is_storm: true  },
  // 7 — Heavy rain
  { name: 'heavy-rain',    temperature_C: 11, dewpoint_C: 10, surface_pressure_hPa: 1002, is_storm: false },
  // 8 — Light snow
  { name: 'light-snow',    temperature_C: -1, dewpoint_C: -3, surface_pressure_hPa: 1010, is_storm: false },
  // 9 — Heavy snow
  { name: 'heavy-snow',    temperature_C: -5, dewpoint_C: -6, surface_pressure_hPa: 1000, is_storm: false },
  // 10 — Foggy
  { name: 'foggy',         temperature_C: 8,  dewpoint_C: 8,  surface_pressure_hPa: 1018, is_storm: false },
  // 11 — Windy/clear
  { name: 'windy-clear',   temperature_C: 16, dewpoint_C: 4,  surface_pressure_hPa: 1022, is_storm: false },
  // 12 — Hot/dry
  { name: 'hot-dry',       temperature_C: 32, dewpoint_C: 8,  surface_pressure_hPa: 1015, is_storm: false },
  // 13 — Cold/clear
  { name: 'cold-clear',    temperature_C: 2,  dewpoint_C: -8, surface_pressure_hPa: 1025, is_storm: false },
  // 14 — Mist
  { name: 'mist',          temperature_C: 10, dewpoint_C: 10, surface_pressure_hPa: 1015, is_storm: false },
  // 15 — High overcast (cirrostratus)
  { name: 'high-overcast', temperature_C: 17, dewpoint_C: 6,  surface_pressure_hPa: 1014, is_storm: false },
  // 16 — Squall line
  { name: 'squall',        temperature_C: 19, dewpoint_C: 16, surface_pressure_hPa: 1002, is_storm: true  },
  // 17 — Drizzle
  { name: 'drizzle',       temperature_C: 11, dewpoint_C: 10, surface_pressure_hPa: 1009, is_storm: false },
  // 18 — Cold front passage
  { name: 'cold-front',    temperature_C: 14, dewpoint_C: 8,  surface_pressure_hPa: 1011, is_storm: false },
  // 19 — Hail (rare)
  { name: 'hail',          temperature_C: 20, dewpoint_C: 18, surface_pressure_hPa: 999,  is_storm: true  },
];

/**
 * Heuristic classifier — used when dayGroupIndex is unknown/invalid. Reads
 * the SkyState's fog and brightness to estimate weather class.
 *
 * SkyState fields used:
 *   fogMax        — fog far distance; LOW = thick weather, HIGH = clear
 *   dirBright     — sun brightness scalar; LOW = stormy, HIGH = sunny
 *   ambColorArgb  — ambient color; bluish = cold/winter, warm = warm
 */
function classifyHeuristic(state) {
  if (!state) return PROFILES[0];
  const fogMax = Number.isFinite(state.fogMax) ? state.fogMax : 2500;
  const dirBright = Number.isFinite(state.dirBright) ? state.dirBright : 0.7;
  const ambArgb = state.ambColorArgb || 0xff8090c0;
  const ambB = ambArgb & 0xff;
  const ambR = (ambArgb >>> 16) & 0xff;
  const isCold = ambB > ambR + 16;  // bluish ambient → cold

  if (dirBright < 0.3 && fogMax < 800) {
    return isCold ? PROFILES[9] : PROFILES[6];   // heavy-snow OR thunderstorm
  }
  if (fogMax < 500) return PROFILES[10];          // foggy
  if (fogMax < 1200 && dirBright < 0.5) return PROFILES[7];  // heavy-rain
  if (fogMax < 1800 && dirBright < 0.6) return isCold ? PROFILES[8] : PROFILES[5];
  if (fogMax < 2500) return PROFILES[3];          // cloudy
  if (dirBright > 0.85) return isCold ? PROFILES[13] : PROFILES[0];  // cold-clear OR sunny
  return PROFILES[2];                              // partly-cloudy default
}

/**
 * Get a weather profile for the active DayGroup. Tries indexed table
 * first; falls back to heuristic on out-of-range index.
 *
 * @param {Object|null} state  AC SkyState (from `__sessionHandle.getSkyState()`)
 * @param {number|null} dayGroupIndex  retail DayGroup index 0-19 or null
 * @returns {{name:string, temperature_C:number, dewpoint_C:number,
 *           surface_pressure_hPa:number, is_storm:boolean}}
 */
export function weatherForState(state, dayGroupIndex) {
  if (Number.isFinite(dayGroupIndex) &&
      dayGroupIndex >= 0 &&
      dayGroupIndex < PROFILES.length) {
    return PROFILES[dayGroupIndex];
  }
  return classifyHeuristic(state);
}

/** Live-tuning hook for per-DayGroup tweaking via devtools. */
export function setProfile(idx, partial) {
  if (!Number.isFinite(idx) || idx < 0 || idx >= PROFILES.length) return false;
  if (!partial) return false;
  Object.assign(PROFILES[idx], partial);
  return true;
}

/** Read-only snapshot of all profiles (for inspection / capture suite). */
export function getProfiles() {
  return PROFILES.map(p => ({ ...p }));
}

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-undef
  window.__setWeatherProfile = setProfile;
  // eslint-disable-next-line no-undef
  window.__getWeatherProfiles = getProfiles;
}
