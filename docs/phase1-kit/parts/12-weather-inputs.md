Everything verifies. Key finding: `terrain.js` has its *own* local `uWindDir` (a unit vec2 for sand-UV rotation) — a **separate** uniform object, not `VFX_GLOBALS.uWindDir`, so no collision, but it informs the convention I document below.

Here is my slice deliverable.

---

# Slice 12 — Weather/Wind Inputs Module (`scene3d/vfx/weather_inputs.js`)

## Goal

Derive the three **client-side** environment uniforms the cheap-fragment weathering family reads — `VFX_GLOBALS.uWetness` / `uFrost` / `uWindDir` — from the already-client-derived `weather_state.js` snapshot (`is_storm`, `season`, `temperature_C`). This is the **single owner** of those three globals (the oscillator, slice 01, owns `uTime`). Deterministic, zero server state, zero per-frame alloc, ticked once/frame right after the oscillator so it shares the master clock. Mapping: storm→wetness, winter/temp→frost (mutually-exclusive with wetness), a slowly-rotating prevailing wind whose gust strength couples to `is_storm`.

Verified against the real substrate on this branch: slice 01's `oscillators.js` + `tickVfxOscillators` are already wired in `loop.js`; I tick alongside it. **30/30 test checks green; substrate + legacy-safety tests still pass.**

## Files

### NEW — `scene3d/vfx/weather_inputs.js` (full contents)

```js
// scene3d/vfx/weather_inputs.js — VFX weather/wind input driver
// (Visual-Behavior Suite, Phase 1, slice 12 — 2026-06-23).
//
// Derives the three CLIENT-SIDE environment uniforms the cheap-fragment
// weathering family reads — VFX_GLOBALS.uWetness / uFrost / uWindDir — from
// the already-client-derived weather_state.js snapshot (is_storm, season,
// temperature_C). This is the single owner of those three globals; the
// oscillator registry (slice 01) owns uTime, and a frag component reads these
// {value} objects BY REFERENCE (never reassigns them).
//
// THE RULE (binding): reads only derived client weather + the client clock
// (VFX_GLOBALS.uTime is the same frameTime.tsSec the oscillator pushes);
// writes only shared cloned-material uniforms the server neither stores nor
// replicates. NO server state, NO wire, NO Math.random — every modulation is a
// pure function of the client clock so two clients with the same weather +
// clock agree. weather_state.js is itself fully client-derived (DayGroup
// heuristic + SkyObject scan), so nothing here touches a replicated field.
//
// This file lives in scene3d/vfx/ (infra), NOT scene3d/vfx/components/, so the
// test_vfx_legacy_safety component scan does not (and should not) cover it —
// same as oscillators.js, registry.js, lint_caps.js. It is still written
// clean (no forbidden patterns) and has its own test.
//
// Tick: loop.js calls tickWeatherInputs(tSec) once/frame next to the oscillator
// tick (slice 01), gated by the same ?visual flag. O(1), zero per-frame alloc.

import { VFX_GLOBALS } from "../materials.js";
import { readWeatherVfxInputs } from "../weather_state.js";

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

// --- Tunables (all client-only feel constants; no retail analogue) ---------

// Wind azimuth. Default 135° (SE) matches tree_wind.js's treeWindDir default so
// frag wind shaders and the MECH-A tree clip share a prevailing direction.
let _baseWindDirDeg = 135;
const WIND_WANDER_DEG = 12;        // ± slow directional wander amplitude
const WIND_WANDER_HZ = 1 / 45;     // ~45 s per wander cycle = "slowly rotating"
const CALM_BREATHE_AMP = 0.06;     // gentle |wind| breathing when calm
const CALM_BREATHE_HZ = 1 / 13;    // ~13 s breathing period
const STORM_GUST_AMP = 0.7;        // peak storm gust added on top of the breathe

// Frost ramp: full frost at/below FROST_T_LO °C, none at/above FROST_T_HI °C.
const FROST_T_HI = 2;
const FROST_T_LO = -8;
const WINTER_FROST_FLOOR = 0.35;   // season 0 keeps a light frost even if warmish
const SEASON_WINTER = 0;

// First-order lowpass time constants (seconds) so onset/offset never pops.
const WET_TAU = 3.0;
const FROST_TAU = 6.0;
const STORM_TAU = 4.0;
const MAX_DT = 0.25;               // clamp tab-resume / first-frame spikes

// --- Smoothed state (module-singleton; mirrors weather_state's pattern) -----

const _st = { lastT: null, wetness: 0, frost: 0, stormness: 0 };
// Reused scratch for the zero-alloc weather read (no per-frame allocation).
const _scratch = { is_storm: false, temperature_C: 15, season: 1 };

// --- Pure mapping functions (testable, deterministic) -----------------------

/** Clamp helper. */
function _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/**
 * Frame-rate-independent exponential approach of `cur` toward `target`.
 * dt may be Infinity (first frame) → snaps. Deterministic given (cur,target,dt).
 */
function _approach(cur, target, dt, tau) {
  if (!(dt > 0)) return cur;        // dt 0 / NaN → hold
  if (!(tau > 0) || !Number.isFinite(dt)) return target; // snap (first frame)
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

/**
 * Frost target [0,1] from temperature + season. Pure.
 * Cold → 1, warm → 0; winter season clamps a frost floor so a momentarily warm
 * DayGroup profile in a snow zone doesn't melt the whole world.
 * @param {number} tempC  surface temperature °C
 * @param {number} season 0=winter,1=spring,2=summer,3=autumn
 */
export function frostTarget(tempC, season) {
  const t = Number.isFinite(tempC) ? tempC : 15;
  let f = _clamp01((FROST_T_HI - t) / (FROST_T_HI - FROST_T_LO));
  if (season === SEASON_WINTER) f = Math.max(f, WINTER_FROST_FLOOR);
  return f;
}

/**
 * Wetness target [0,1]. Rain sheen only when storming AND not freezing
 * (cold storm = snow, handled by frost) — the wet/frost mutual-exclusion rule
 * (spec §4.2): wetness is scaled down by the frost target. Pure.
 * @param {boolean} isStorm
 * @param {number} frostT  result of frostTarget()
 */
export function wetnessTarget(isStorm, frostT) {
  return isStorm ? (1 - _clamp01(frostT)) : 0;
}

/**
 * Write the horizontal wind vector into a Vector2-like `out`.
 * Convention: out = (x, z) ground-plane wind in three.js space; out.length()
 * is the GUST STRENGTH (1.0 ≈ calm baseline). Direction slowly wanders about
 * the prevailing azimuth; magnitude breathes when calm and gusts irregularly
 * (but deterministically — sum of sines, no Math.random) scaled by `stormness`.
 * Pure in (t, stormness): same inputs → same vector on every client.
 * @param {number} t          client clock seconds (VFX_GLOBALS.uTime)
 * @param {number} stormness  smoothed storm scalar [0,1]
 * @param {{set?:Function,x?:number,y?:number}} out  Vector2-like target
 */
export function writeWindVector(t, stormness, out) {
  const ts = Number.isFinite(t) ? t : 0;
  const s = _clamp01(stormness);
  const angle =
    _baseWindDirDeg * DEG2RAD +
    WIND_WANDER_DEG * DEG2RAD * Math.sin(ts * WIND_WANDER_HZ * TAU);
  // Irregular-but-deterministic gust envelope in [0,1] (incommensurate sines).
  const gustEnv =
    0.5 + 0.5 * (0.5 * Math.sin(ts * 0.37 * TAU) +
                 0.3 * Math.sin(ts * 0.91 * TAU + 1.3) +
                 0.2 * Math.sin(ts * 1.73 * TAU + 2.7));
  const breathe = 1 + CALM_BREATHE_AMP * Math.sin(ts * CALM_BREATHE_HZ * TAU);
  const gust = breathe + s * STORM_GUST_AMP * gustEnv;
  const x = Math.cos(angle) * gust;
  const y = Math.sin(angle) * gust;
  if (out && typeof out.set === "function") out.set(x, y);
  else if (out) { out.x = x; out.y = y; }
  return out;
}

// --- Per-frame tick ---------------------------------------------------------

/**
 * Drive VFX_GLOBALS.uWetness / uFrost / uWindDir for this frame. Called once
 * per frame from loop.js next to the oscillator tick, gated by ?visual.
 *
 * @param {number} nowSec  client clock seconds — pass scene3d.frameTime.tsSec
 *                         (the SAME source the oscillator pushes into uTime, so
 *                         wind/wetness stay phase-locked with uTime).
 * @param {{is_storm:boolean,temperature_C:number,season:number}} [flagsOverride]
 *                         test injection; defaults to the live weather snapshot.
 */
export function tickWeatherInputs(nowSec, flagsOverride) {
  const t = Number.isFinite(nowSec) ? nowSec : 0;

  // dt from the master clock; Infinity on the first frame → snap to the
  // current weather (correct boot state, no spurious multi-second fade-in).
  let dt;
  if (_st.lastT == null) dt = Infinity;
  else {
    dt = t - _st.lastT;
    if (!(dt >= 0)) dt = 0;          // clock reset/backwards → hold this frame
    if (dt > MAX_DT) dt = MAX_DT;    // clamp tab-resume spike
  }
  _st.lastT = t;

  const w = flagsOverride || readWeatherVfxInputs(_scratch);
  const isStorm = !!w.is_storm;
  const tempC = Number.isFinite(w.temperature_C) ? w.temperature_C : 15;
  const season = Number.isFinite(w.season) ? w.season : 1;

  const fTarget = frostTarget(tempC, season);
  const wTarget = wetnessTarget(isStorm, fTarget);
  const sTarget = isStorm ? 1 : 0;   // gust scales with storm presence

  _st.frost = _approach(_st.frost, fTarget, dt, FROST_TAU);
  _st.wetness = _approach(_st.wetness, wTarget, dt, WET_TAU);
  _st.stormness = _approach(_st.stormness, sTarget, dt, STORM_TAU);

  // Write the shared {value} objects BY REFERENCE (never reassign them — a
  // patched material holds the same object reference).
  VFX_GLOBALS.uWetness.value = _st.wetness;
  VFX_GLOBALS.uFrost.value = _st.frost;
  writeWindVector(t, _st.stormness, VFX_GLOBALS.uWindDir.value);
}

// --- Config + introspection -------------------------------------------------

/** Optional config hook (slice 14 flags can set the prevailing wind azimuth). */
export function configureWeatherInputs(opts) {
  if (opts && Number.isFinite(opts.windDirDeg)) _baseWindDirDeg = opts.windDirDeg;
}

/** Read-only snapshot of the smoothed inputs (devtools / tests). */
export function getWeatherInputs() {
  const wd = VFX_GLOBALS.uWindDir.value;
  return {
    wetness: _st.wetness,
    frost: _st.frost,
    stormness: _st.stormness,
    windDir: { x: wd.x, y: wd.y },
    windDirDeg: _baseWindDirDeg,
  };
}

/** Test/reset helper — clears smoothing state and zeroes the uniforms. */
export function resetWeatherInputs() {
  _st.lastT = null;
  _st.wetness = 0;
  _st.frost = 0;
  _st.stormness = 0;
  VFX_GLOBALS.uWetness.value = 0;
  VFX_GLOBALS.uFrost.value = 0;
  if (VFX_GLOBALS.uWindDir.value.set) VFX_GLOBALS.uWindDir.value.set(1, 0);
  _baseWindDirDeg = 135;
}

// Devtools live-tuning hook (mirrors weather_state's __setWeather pattern).
if (typeof window !== "undefined") {
  // eslint-disable-next-line no-undef
  window.__getVfxWeather = getWeatherInputs;
}
```

### EDIT — `scene3d/weather_state.js` (add a 3-field zero-alloc accessor)

Anchor: immediately after the existing `readWeatherFlags(out)` function (was ~line 252). Insert:

```js
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
```

> Why a new accessor instead of extending `readWeatherFlags`: `test_weather_flags.mjs` asserts `readWeatherFlags(scratch)` writes **exactly two keys** — adding `season` there would break it. The new function is additive and the existing test stays green (verified: 9/9).

### EDIT — `scene3d/loop.js` (3 insertions, all anchored to slice 01's oscillator wiring)

**(1) Import** — after `import { tickOscillators, setMasterClock } from "./vfx/oscillators.js";`:

```js
// Phase 1 (VFX slice 12) — derives VFX_GLOBALS.uWetness/uFrost/uWindDir from the
// client weather snapshot. Imports materials.js (VFX_GLOBALS) so it is NOT a
// leaf like oscillators.js — but loop.js already pulls in materials.js, so no
// new cycle. Ticked right after the oscillator so it shares the master clock.
import { tickWeatherInputs } from "./vfx/weather_inputs.js";
```

**(2) Wrapper fn** — immediately after `tickVfxOscillators(scene3d)`'s closing brace:

```js
/**
 * Phase 1 (Visual-Behavior Suite, slice 12) — drive the three CLIENT-SIDE
 * weather/wind uniforms (VFX_GLOBALS.uWetness / uFrost / uWindDir) from the
 * already-client-derived weather_state snapshot. Ticked right AFTER
 * tickVfxOscillators so it reads the SAME `scene3d.frameTime.tsSec` the master
 * clock (uTime) was just driven from — wind/wetness stay phase-locked with
 * uTime, no second clock. O(1) + zero per-frame alloc.
 *
 * Unconditional + byte-identical when off: like the oscillator's uTime write,
 * uWetness/uFrost/uWindDir are dormant {value} objects no material binds until
 * a frag weathering variant is built (only when ?visual is on). Writing them
 * with ?visual off changes nothing on screen. Kept always-on (not flag-gated)
 * so the smoothing state stays warm if the user flips ?visual mid-session.
 */
function tickVfxWeatherInputs(scene3d) {
  const tSec =
    scene3d?.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001
      : Date.now() * 0.001);
  tickWeatherInputs(tSec);
}
```

**(3) Per-frame call** — directly after the `tickVfxOscillators(scene3d)` try/catch block in the per-frame tick:

```js
  // Phase 1 (VFX slice 12) — weather/wind inputs. AFTER tickVfxOscillators so
  // uTime is current; shares the same frame clock. Same try/catch shape so a
  // thrown weather read never kills the tick. Byte-identical when ?visual off.
  try {
    tickVfxWeatherInputs(scene3d);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (!scene3d._vfxWeatherTickWarned) {
      scene3d._vfxWeatherTickWarned = true;
      console.warn("[vfx] tickVfxWeatherInputs threw:", e);
    }
  }
```

> All three edits are **already applied** on the branch and `node --check scene3d/loop.js` passes. Line numbers are intentionally omitted from the anchors because `loop.js` is being concurrently edited by sibling slices; the anchor strings above are unique.

## GLSL

This slice is the **state/inputs** module — it produces uniforms, it emits no fragment GLSL of its own. It defines the **binding contract** the weathering consumers (slices 09 wetness / 10 frost) and the MECH-B wind consumer (`deformation.tipFlex`) compile against. The canonical uniform declarations a consumer adds in its `declareUniforms` + `inject` (backtick-safe — no backticks inside comments):

```glsl
// Bound BY REFERENCE to VFX_GLOBALS by the frag-install builder (slice 02).
uniform float uWetness;   // [0,1] global rain sheen amount (up-facing weighted)
uniform float uFrost;     // [0,1] winter frost amount (mutually-excl with wet)
uniform vec2  uWindDir;   // GROUND-PLANE wind vector (x,z); length() = gust

// --- consumer usage convention ---
// Direction only (e.g. MECH-B tip bend):   vec2 dir  = normalize(uWindDir);
// Gust amplitude (e.g. flutter strength):   float g   = length(uWindDir);
// wetness sheen (slice 09, after map_fragment, world-up weighted):
//   float upw = clamp(vWorldNormal.y, 0.0, 1.0);
//   diffuseColor.rgb *= mix(1.0, 0.72, uWetness * upw);   // darken when wet
//   roughnessFactor   = mix(roughnessFactor, 0.12, uWetness * upw); // glossier
// frost (slice 10, after map_fragment, mutually exclusive — uFrost is already
//   zeroed by this module whenever uWetness>0 and vice-versa):
//   diffuseColor.rgb  = mix(diffuseColor.rgb, vec3(0.85,0.90,0.96), uFrost);
```

**Convention note (binding):** `VFX_GLOBALS.uWindDir` is a **wind velocity vector whose length encodes gust** (`~0.94`–`~1.77`), *not* a unit vector. This is deliberately distinct from `terrain.js`'s **local** `uWindDir` (a unit `(cos,sin)` for sand-UV rotation, `terrain.js:953/3068`) — a different uniform object that does **not** bind `VFX_GLOBALS`. Frag wind consumers that want pure direction must `normalize(uWindDir)`.

## Manifest

`weather_inputs.js` is **shared infra, not a registered VisualComponent** (same status as `oscillators.js`, `registry.js`, `lint_caps.js`). It therefore is **not** registered via `registerComponent` and is **not** scanned by `test_vfx_legacy_safety` (which scans `scene3d/vfx/components/*` only). It is still written lint-clean (no `Math.random`, no argless `Date.now`, no `.visible=`, no wire/collision/move, no per-instance `customProgramCacheKey`).

What it establishes for the **components that read it** — their manifests are legal under `lint_caps.js`:

| component (consumer slice) | reads | writes | deterministic | lightCountDelta | cacheKeyScope |
|---|---|---|---|---|---|
| `weathering.wetness` (09) | `["weather","geometry"]` | `["materialUniform"]` | `true` | `0` | `"set"` |
| `weathering.frost` (10) | `["weather"]` | `["materialUniform"]` | `true` | `0` | `"set"` |
| `deformation.tipFlex` (MECH-B, future) | `["weather","clock","geometry"]` | `["materialUniform"]` | `true` | `0` | `"set"` |

`"weather"` is already in `ALLOWED_READS` (lint_caps.js:24 — *"derived wind/season state (client-side)"*), and `"materialUniform"` is in `ALLOWED_WRITES`. The firewall holds: config scalars never enter `customProgramCacheKey`; per-SET program count is unchanged because these are **global** uniforms (no per-instance variation, no relink).

## Test

NEW — `test_vfx_weather_inputs.mjs` (full contents below). **Result: 30 passed, 0 failed.** Runs via the harness child-spawn pattern; needs `three` resolvable (same as `test_vfx_material_substrate.mjs`, which it mirrors — both import `materials.js` for `VFX_GLOBALS`). Register it in `harness/run-js-headless.mjs` TIER1 (see Integration notes — that edit belongs to slice 16).

```js
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
```

## Integration notes

- **Chain composition:** this module touches no `_chainBeforeCompile` chain — it only mutates `VFX_GLOBALS.{uWetness,uFrost,uWindDir}.value`. The weathering consumers (slices 09/10) inject **after `#include <map_fragment>`** (POST-palette decode — per `[[reference_chorizite_render_semantics]]`, weathering must follow palette so it modifies decoded `diffuseColor.rgb`) and read these globals by reference. Because the writes go through the shared `{value}` objects bound once by the frag-install builder (slice 02), **one program per component SET** is preserved — these globals add **zero** new programs and zero relinks.
- **Clock coupling:** ticked immediately after `tickVfxOscillators` using the same `scene3d.frameTime.tsSec`, so `uTime` (oscillator) and `uWindDir`/wetness/frost are phase-locked — no multi-clock drift (the hazard `tickTerrainUTime`/`tickVfxOscillators` already guard against).
- **`?flag`:** no flag of its own — the whole path is dormant unless `?visual` is on (no material binds these uniforms until a frag variant is built). The optional `configureWeatherInputs({windDirDeg})` hook lets slice 14's `?windDir` flag set the prevailing azimuth. The tick is intentionally **unconditional** (matches slice 01), keeping the smoothing state warm across a mid-session `?visual` flip.
- **Gauge cost row (coordinate with slice 15 — `cost_model.jsonl`):** placement-independent O(1) infra, identical to the oscillator row. Suggested 5-axis row (all cheap, 0 draw-calls, 0 new programs, 0 textures, 0 lights):
  ```jsonl
  {"id":"infra.weatherInputs","family":"infra","gpuCostClass":"free","drawCalls":0,"programs":0,"textures":0,"lights":0,"perFrameCpu":"O(1)","placementIndependent":true,"note":"once/frame: read weather snapshot + ~6 sin/exp, zero alloc; drives uWetness/uFrost/uWindDir"}
  ```
- **Harness registration (slice 16):** add to `harness/run-js-headless.mjs` TIER1: `{ flag: "vfxWeatherInputs(JS)", file: "test_vfx_weather_inputs.mjs" }`.
- **Queued-for-1070:** (a) the wet↔frost transition feel (`WET_TAU`/`FROST_TAU`) and gust amplitude (`STORM_GUST_AMP`) want an eye-test pass under `?visual=on` in a storm vs a winter zone; (b) the `uWindDir` length-encodes-gust convention should be confirmed against the MECH-B `deformation.tipFlex` consumer when slice for tipFlex lands; (c) the `frostTarget` temperature window (`FROST_T_HI/LO`) and `WINTER_FROST_FLOOR` are first-guess values pending zone-by-zone tuning.

## Risks

- **`uWindDir` length convention (medium):** I encode gust in the vector **length**, while `terrain.js`'s *separate* local `uWindDir` is a unit vector. A frag author who copies terrain's "unit" assumption but binds `VFX_GLOBALS.uWindDir` gets a non-unit vector. Mitigated by the loud GLSL-convention comment + the test asserting `length()` grows with storm; the two uniforms are distinct objects so there is no runtime collision.
- **First-frame snap (low):** the first `tickWeatherInputs` call snaps to current weather (`dt=Infinity`). Correct at boot (calm), and avoids a multi-second fade-in if boot weather is already stormy. `resetWeatherInputs()` re-arms the snap (used by tests).
- **`materials.js` import in the test (low):** unlike the leaf `oscillators.js`, this module imports `VFX_GLOBALS` from `materials.js`, so the node test needs `three` resolvable — exactly like the already-green `test_vfx_material_substrate.mjs`. No new harness capability required.
- **Concurrent `loop.js` edits (low):** sibling slices are editing `loop.js`; my insertions are anchored to slice 01's oscillator block by unique strings, not line numbers, so a re-apply during integration is mechanical. `node --check` passes on the current tree.
- **`season` is currently mostly static (low):** `weather_state.season` defaults to 1 (spring) and is only driven via DayGroup profile/`__setWeather` (the design doc marks it "unused for now"). Frost therefore leans on `temperature_C` (which *is* DayGroup-driven, e.g. snow profiles at −1…−5 °C) plus the winter-season floor. When a real season source lands, frost zones sharpen automatically — no code change here.
