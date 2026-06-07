// test_weather_flags.mjs — gate for #29 (weather flags zero-alloc accessor).
//
// readWeatherFlags(out) is the per-frame, zero-alloc accessor the weather
// Manager.tick() reads (is_storm + temperature_C). getWeatherState() stays
// the full read-only snapshot for cloud_volume + devtools. This test
// asserts:
//   1. readWeatherFlags() agrees with getWeatherState() on its two fields.
//   2. An override (setWeatherOverride) is reflected by readWeatherFlags().
//   3. readWeatherFlags(scratch) returns the SAME scratch object (zero-alloc)
//      and writes exactly two keys.
//   4. getWeatherState() still returns its full 9-field shape (do-not-regress).
//
// weather_state.js has no external deps, so we import it directly.
//
// Run from apps/holtburger-web:
//   node test_weather_flags.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsUrl = pathToFileURL(
  resolvePath(__dirname, "scene3d", "weather_state.js")
).href;

const {
  readWeatherFlags,
  getWeatherState,
  setWeatherOverride,
  clearWeatherOverride,
} = await import(wsUrl);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

console.log("== #29 readWeatherFlags accessor ==");

// 1. readWeatherFlags() matches getWeatherState()'s two fields.
{
  const full = getWeatherState();
  const flags = readWeatherFlags();
  check(
    "readWeatherFlags() is_storm matches getWeatherState()",
    flags.is_storm === full.is_storm,
    `flags=${flags.is_storm}, full=${full.is_storm}`
  );
  check(
    "readWeatherFlags() temperature_C matches getWeatherState()",
    Object.is(flags.temperature_C, full.temperature_C),
    `flags=${flags.temperature_C}, full=${full.temperature_C}`
  );
}

// 2. An override is reflected by readWeatherFlags().
{
  setWeatherOverride({ is_storm: true, temperature_C: -5 });
  const flags = readWeatherFlags();
  check(
    "override is_storm=true reflected",
    flags.is_storm === true,
    `flags.is_storm=${flags.is_storm}`
  );
  check(
    "override temperature_C=-5 reflected",
    flags.temperature_C === -5,
    `flags.temperature_C=${flags.temperature_C}`
  );
  // getWeatherState must agree too (single source of truth).
  const full = getWeatherState();
  check(
    "getWeatherState() agrees with the override",
    full.is_storm === true && full.temperature_C === -5,
    `is_storm=${full.is_storm}, temperature_C=${full.temperature_C}`
  );
}

// 3. Zero-alloc: readWeatherFlags(scratch) returns the SAME object and
//    writes exactly two keys.
{
  const scratch = {};
  const ret = readWeatherFlags(scratch);
  check(
    "readWeatherFlags(scratch) returns the same scratch (zero-alloc)",
    ret === scratch,
    `ret===scratch is ${ret === scratch}`
  );
  const keys = Object.keys(scratch).sort();
  check(
    "scratch has exactly two keys: is_storm, temperature_C",
    keys.length === 2 && keys[0] === "is_storm" && keys[1] === "temperature_C",
    `keys=[${keys.join(", ")}]`
  );
  // Reusing the scratch must not allocate a new object.
  const ret2 = readWeatherFlags(scratch);
  check(
    "scratch is reusable across calls (same object)",
    ret2 === scratch,
    `ret2===scratch is ${ret2 === scratch}`
  );
}

// 4. Do-not-regress: getWeatherState() still returns its full 9-field shape.
{
  const full = getWeatherState();
  const expected = [
    "latitude_deg", "longitude_deg", "temperature_C", "dewpoint_C",
    "surface_pressure_hPa", "is_storm", "season", "lcl_m", "etage_m",
  ].sort();
  const keys = Object.keys(full).sort();
  check(
    "getWeatherState() returns the full 9-field shape (unchanged)",
    keys.length === expected.length && expected.every((k, i) => keys[i] === k),
    `keys=[${keys.join(", ")}]`
  );
}

// Cleanup overrides so re-runs / other importers start clean.
clearWeatherOverride();

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
  console.log(`PASS: ${passed}/${passed} weather-flags accessor checks green.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${failed} check(s) failed (${passed} passed).`);
  process.exit(1);
}
