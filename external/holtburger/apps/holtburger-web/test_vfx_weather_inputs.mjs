// test_vfx_weather_inputs.mjs — slice 12 (VFX weather/wind input driver).
//
// Asserts:
//   1. Pure mappings: frostTarget (cold→1, warm→0, winter floor), wetnessTarget
//      (storm→1, wet/frost mutual exclusion), writeWindVector (unit-ish calm,
//      gust grows with stormness, slow direction wander, determinism).
//   2. tickWeatherInputs writes VFX_GLOBALS.uWetness/uFrost/uWindDir by ref,
//      snaps on first frame, lowpasses thereafter, and never reassigns the
//      shared {value} objects (firewall: bound by reference).
//   3. The new zero-alloc readWeatherVfxInputs accessor returns 3 keys and does
//      NOT regress readWeatherFlags's 2-key contract.
//   4. Off-path: with no storm + temperate temp the uniforms are byte-0
//      (byte-identical render when off).
//
// Run from apps/holtburger-web:  node test_vfx_weather_inputs.mjs

import { VFX_GLOBALS } from "./scene3d/materials.js";
import {
  frostTarget, wetnessTarget, writeWindVector,
  tickWeatherInputs, getWeatherInputs, resetWeatherInputs,
} from "./scene3d/vfx/weather_inputs.js";
import {
  readWeatherVfxInputs, readWeatherFlags,
  setWeatherOverride, clearWeatherOverride,
} from "./scene3d/weather_state.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const approx = (a, b, e = 1e-6) => Math.abs(a - b) < e;

console.log("== slice 12: weather inputs ==");

// 1a. frostTarget ----------------------------------------------------------
check("frostTarget: warm (20°C) → 0", frostTarget(20, 1) === 0);
check("frostTarget: deep cold (-20°C) → 1", frostTarget(-20, 2) === 1);
check("frostTarget: at FROST_T_HI boundary (2°C) → 0", approx(frostTarget(2, 1), 0));
check("frostTarget: midpoint (-3°C) → 0.5", approx(frostTarget(-3, 1), 0.5));
check("frostTarget: winter season floor applies even when warm",
  frostTarget(20, 0) >= 0.35, `got ${frostTarget(20, 0)}`);
check("frostTarget: cold wins over the winter floor (monotone)",
  frostTarget(-20, 0) === 1);

// 1b. wetnessTarget (mutual exclusion) ------------------------------------
check("wetnessTarget: no storm → 0", wetnessTarget(false, 0) === 0);
check("wetnessTarget: warm storm → 1", wetnessTarget(true, 0) === 1);
check("wetnessTarget: cold storm (frost=1) → 0 (snow, not rain)",
  wetnessTarget(true, 1) === 0);
check("wetnessTarget: half-frost storm → 0.5 (mutual exclusion)",
  approx(wetnessTarget(true, 0.5), 0.5));

// 1c. writeWindVector ------------------------------------------------------
{
  const v = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
  writeWindVector(0, 0, v);
  const calmLen = Math.hypot(v.x, v.y);
  check("windVector calm magnitude ≈ 1 (baseline gust)",
    calmLen > 0.9 && calmLen < 1.1, `len=${calmLen.toFixed(3)}`);
  writeWindVector(0, 1, v);
  const stormLen = Math.hypot(v.x, v.y);
  check("windVector storm magnitude > calm (gust couples to is_storm)",
    stormLen > calmLen, `storm=${stormLen.toFixed(3)} calm=${calmLen.toFixed(3)}`);

  // Determinism: same (t, stormness) → identical vector.
  const a = writeWindVector(12.5, 0.6, { set(x, y) { this.x = x; this.y = y; } });
  const b = writeWindVector(12.5, 0.6, { set(x, y) { this.x = x; this.y = y; } });
  check("windVector is deterministic in (t, stormness)",
    a.x === b.x && a.y === b.y);

  // Slow direction wander: angle moves over a long horizon but not per-frame.
  const ang = (t) => Math.atan2(
    writeWindVector(t, 0, { set(x, y) { this.x = x; this.y = y; } }).y,
    writeWindVector(t, 0, { set(x, y) { this.x = x; this.y = y; } }).x);
  const dFrame = Math.abs(ang(100.0) - ang(100.016)); // ~1 frame @60fps
  const dLong = Math.abs(ang(100.0) - ang(111.25));   // ~quarter wander cycle
  check("windVector direction wanders slowly (per-frame << per-10s)",
    dFrame < 1e-3 && dLong > dFrame, `dFrame=${dFrame.toExponential(2)} dLong=${dLong.toFixed(4)}`);
}

// 2. tickWeatherInputs drives the shared uniforms --------------------------
{
  resetWeatherInputs();
  const wetRef = VFX_GLOBALS.uWetness;   // capture the {value} object identity
  const frostRef = VFX_GLOBALS.uFrost;
  const windRef = VFX_GLOBALS.uWindDir;
  const windValRef = VFX_GLOBALS.uWindDir.value;

  // First tick: warm storm → snaps wetness toward 1 (snap-on-first-frame).
  tickWeatherInputs(0, { is_storm: true, temperature_C: 20, season: 2 });
  check("first tick snaps uWetness to storm target (~1)",
    VFX_GLOBALS.uWetness.value > 0.99, `wet=${VFX_GLOBALS.uWetness.value}`);
  check("first tick uFrost ~0 in a warm storm",
    VFX_GLOBALS.uFrost.value < 0.01, `frost=${VFX_GLOBALS.uFrost.value}`);

  // Subsequent ticks lowpass toward a NEW (calm) target, not snap.
  tickWeatherInputs(0.016, { is_storm: false, temperature_C: 20, season: 2 });
  const wetAfter1 = VFX_GLOBALS.uWetness.value;
  check("storm→calm lowpasses (wetness eases down, not instant)",
    wetAfter1 > 0.5 && wetAfter1 < 1.0, `wet=${wetAfter1}`);
  // Run many frames → converges to ~0.
  for (let i = 2; i < 1200; i++) tickWeatherInputs(i * 0.016, { is_storm: false, temperature_C: 20, season: 2 });
  check("wetness converges to ~0 after sustained calm",
    VFX_GLOBALS.uWetness.value < 0.02, `wet=${VFX_GLOBALS.uWetness.value}`);

  // Firewall: the {value} OBJECTS were never reassigned (bound by reference).
  check("uWetness {value} object identity preserved (bound by ref)", VFX_GLOBALS.uWetness === wetRef);
  check("uFrost {value} object identity preserved", VFX_GLOBALS.uFrost === frostRef);
  check("uWindDir {value} object identity preserved", VFX_GLOBALS.uWindDir === windRef);
  check("uWindDir.value (Vector2) identity preserved (set() in place)",
    VFX_GLOBALS.uWindDir.value === windValRef);
}

// 2b. Frost path -----------------------------------------------------------
{
  resetWeatherInputs();
  tickWeatherInputs(0, { is_storm: true, temperature_C: -10, season: 0 });
  check("cold winter storm: uFrost snaps high", VFX_GLOBALS.uFrost.value > 0.99);
  check("cold winter storm: uWetness ~0 (frost suppresses wet)",
    VFX_GLOBALS.uWetness.value < 0.02, `wet=${VFX_GLOBALS.uWetness.value}`);
}

// 3. zero-alloc accessor + no regression ----------------------------------
{
  setWeatherOverride({ is_storm: true, temperature_C: -4, season: 0 });
  const scratch = {};
  const ret = readWeatherVfxInputs(scratch);
  check("readWeatherVfxInputs returns the same scratch (zero-alloc)", ret === scratch);
  const keys = Object.keys(scratch).sort();
  check("scratch has exactly 3 keys: is_storm, season, temperature_C",
    keys.length === 3 && keys.join(",") === "is_storm,season,temperature_C", `keys=[${keys}]`);
  check("readWeatherVfxInputs reflects the override",
    ret.is_storm === true && ret.temperature_C === -4 && ret.season === 0);
  // No regression of the 2-key flags accessor.
  const f = readWeatherFlags({});
  check("readWeatherFlags still returns exactly 2 keys (unchanged)",
    Object.keys(f).sort().join(",") === "is_storm,temperature_C");
  clearWeatherOverride();
}

// 4. off-path is byte-0 ----------------------------------------------------
{
  resetWeatherInputs();
  tickWeatherInputs(0, { is_storm: false, temperature_C: 15, season: 1 });
  check("temperate calm: uWetness === 0", VFX_GLOBALS.uWetness.value === 0);
  check("temperate calm: uFrost === 0", VFX_GLOBALS.uFrost.value === 0);
}

resetWeatherInputs();
console.log(`\nVFX weather inputs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
