I now have everything needed. Here is my structured deliverable.

---

## Assignment

Design the **wind-state module** — the single source of truth for a time-varying wind vector + gust scalar that drives BOTH the shader route (`windUniforms` on the bulk-forest material, task 05/06) and the player route (the per-part procedural clip, task 01/03), keeping them phase-locked. Confirm no wind exists in `weather_state.js`/`daygroup_weather.js` today; define the schema (direction, base strength, gust envelope, region/season); couple it to `is_storm` and the named DayGroup profiles; specify the `loop.js` feed into both routes; give the API, defaults, and `?treeWindStrength`/`?treeWindDir` flags.

## Findings (file:line)

**No wind today — confirmed:**
- `scene3d/weather_state.js:66-83` — the shared `state` object holds `latitude_deg, longitude_deg, temperature_C, dewpoint_C, surface_pressure_hPa, is_storm` (line 75), `season` (78), `lcl_m`, `etage_m`. **No wind field.** Mutators `updateFromPosition` (158-163), `updateFromDayGroup` (181-189), `setWeatherOverride` (196-210); reads `getWeatherState()` (225-237) and zero-alloc `readWeatherFlags(out)` (247-252). `window.__setWeather/__getWeather` live-tuning hooks (258-265).
- `scene3d/daygroup_weather.js:25-66` — 20-entry `PROFILES` table, **(T, Td, pressure, is_storm) only, no wind**. `windy-clear` = index **11** (line 49). Storm profiles: `thunderstorm` (6), `squall` (16), `hail` (19). `weatherForState()` (179-197) returns the profile; `is_storm` is overridden by the real DAT signal from `scanWeatherSkyObjects()` (130-158).

**Existing wind concepts to reconcile with (two of them, both partial):**
- `scene3d/terrain.js:953` — `uniform vec2 uWindDir` (sand UV rotation), default `new THREE.Vector2(1.0, 0.0)` at `terrain.js:3068`, consumed at 1703-1723. **Never driven dynamically** — a static constant. Reconciliation opportunity (optional feed), not a conflict.
- `scene3d/weather/manager.js:152-154` — precip drift: `windScale = max(rainIntensity, snowIntensity)`, pushed via `rain.setWindScale()` / `snow.setWindScale()` (`weather/rain.js:104-105`, `weather/snow.js:110-111`, applied 124-139). This is a **magnitude scalar with no direction** — unrelated clock and semantics. My module can later donate a real direction; out of scope for treeWind v1.

**The clock + uniform-writer precedent (the model to copy):**
- `scene3d/loop.js:817-831` `tickTerrainUTime(scene3d)` — pushes `scene3d.frameTime?.tsSec` (`loop.js:822`) onto every terrain material's `uTime`. The docstring (798-810) states the rule explicitly: **"Single time source means matched ... motion ... so we don't grow a multi-clock zoo."** Called FIRST in the tick at `loop.js:1604-1612` (Phase 2.2). This is exactly where/how `tickWindUniforms` slots in.
- `scene3d/loop.js:890-950` `tickWeatherState()` — per-frame weather driver, called at `1770-1780` gated on `_rp3RunSky`. Calls `wxUpdateFromDayGroup(profile)` (914) and has `profile.name` + the `_weather` scan in hand. **This is where I hook `updateFromWeather`.**

**The player route's independent clock (the sync subtlety):**
- `scene3d/animated_scenery.js:368-374` — the player runs a **self-managed rAF** off `performance.now()` (`_rafNow`), loop at 383-427, `dt = Math.min(0.1, ...)` (389), `g.mixer.update(dt)` (395). loop.js comment at `1881-1883` confirms: *"animated-scenery mixers are driven by a self-managed rAF ... because this function's dt arrives as 0 on the net-drain path. No tick here."* So the player route does **not** see `scene3d.frameTime` — but `_rafNow` is `performance.now()` and `frameTime.tsSec` is `performance.now()*0.001` (loop.js:823-824), so both routes share the same wall clock to within one frame.

**Flag-parse conventions to reuse verbatim:**
- `scene3d/animated_scenery.js:45-54` `_numFlag(name, def, min)` — the numeric-URL-flag helper (used for `animSceneryMax/Radius/Fps`). Reuse for `?treeWindStrength`/`?treeWindDir`.
- `scene3d/animated_scenery.js:69-81` `animSceneryEnabled()` — boolean default-ON pattern (`?animScenery=off` escape). The **inverse** (default-OFF, `?treeWind=on`) mirrors `loop.js:961-974 readFogLerpFlag()` (`=== "on"`).
- url-flags.md table format (`docs/url-flags.md:172`): `| flag | type | default | description | location |`.

## Concrete coding steps

All steps below are **JS-ONLY (no wasm rebuild)** — critical given the 8 GB OOM constraint. New file + two small hook edits.

### Step 1 — New module `scene3d/wind_state.js` (JS-only, ~140 LOC)

Self-contained singleton. AC ground plane = X/Z in THREE world coords (Y up). Direction stored as a unit `(dirX, dirZ)` derived from an azimuth.

```js
// scene3d/wind_state.js — treeWind wind-state (non-retail, ?treeWind default-OFF).
// Single source of truth for the time-varying wind vector + gust scalar consumed by
// BOTH the shader route (windUniforms, materials.js) and the player route
// (procedural clip, animated_scenery.js). Phase-locked because both sample THIS module
// against the same performance.now()-based wall clock (cf. loop.js:798-810 "single time source").

const DEG = Math.PI / 180;

// ---- URL flags (mirror animated_scenery.js:45-54 / loop.js:961-974) -------------
function _numFlag(name, def, min, max) {            // copy of animated_scenery.js:45-54
  try {
    if (typeof window !== "undefined" && window.location) {
      const v = new URLSearchParams(window.location.search).get(name);
      const n = v == null ? NaN : parseFloat(v);
      if (Number.isFinite(n)) return Math.max(min, Math.min(max ?? Infinity, n));
    }
  } catch (_) {}
  return def;
}
let _enabled;
export function windEnabled() {                      // ?treeWind=on (default OFF, non-retail)
  if (_enabled !== undefined) return _enabled;
  let on = false;
  try {
    if (typeof window !== "undefined" && window.location)
      on = new URLSearchParams(window.location.search).get("treeWind")?.toLowerCase() === "on";
  } catch (_) { on = false; }
  return (_enabled = on);
}

// ---- Defaults + per-profile wind table -----------------------------------------
const DEFAULTS = {
  azimuth_deg: 135,     // wind blows toward SE in world space; ?treeWindDir overrides
  baseStrength: 0.5,    // normalized [0..1] steady-state sway amount
  gust: { freq_hz: 0.18, amp: 0.45, choppiness: 2.0 }, // amp = fraction of strength added at gust peak
};
// Keyed by daygroup_weather.js PROFILES[i].name. Keeps that module meteorology-only
// (no edit there) and stays auditable in one place. Unknown name -> _PROFILE_DEFAULT.
const WIND_BY_PROFILE = {
  "windy-clear":  { baseStrength: 0.85, gust: { freq_hz: 0.22, amp: 0.55, choppiness: 2.0 } },
  "squall":       { baseStrength: 0.95, gust: { freq_hz: 0.30, amp: 0.85, choppiness: 3.0 } },
  "thunderstorm": { baseStrength: 0.80, gust: { freq_hz: 0.28, amp: 0.80, choppiness: 3.0 } },
  "hail":         { baseStrength: 0.75, gust: { freq_hz: 0.30, amp: 0.75, choppiness: 3.0 } },
  "cold-front":   { baseStrength: 0.65, gust: { freq_hz: 0.20, amp: 0.50, choppiness: 2.0 } },
  "foggy":        { baseStrength: 0.10, gust: { freq_hz: 0.10, amp: 0.15, choppiness: 1.0 } },
  "mist":         { baseStrength: 0.10, gust: { freq_hz: 0.10, amp: 0.15, choppiness: 1.0 } },
};
const _PROFILE_DEFAULT = { baseStrength: 0.45, gust: { freq_hz: 0.16, amp: 0.40, choppiness: 1.5 } };
// Season multiplier (weather_state.season: 0=winter,1=spring,2=summer,3=autumn)
const SEASON_MULT = [1.10, 0.95, 0.80, 1.15];

// ---- Resolved config (recomputed on weather/flag change, NOT per-frame) ---------
const cfg = {
  azimuth_deg: DEFAULTS.azimuth_deg, dirX: 0, dirZ: 0,
  baseStrength: DEFAULTS.baseStrength, gust: { ...DEFAULTS.gust },
  is_storm: false, season: 1, profileName: "",
};
const override = { azimuth: false, strength: false };  // set by ?flags / __setWind

function _recompute() {
  const a = cfg.azimuth_deg * DEG;
  cfg.dirX = Math.cos(a); cfg.dirZ = Math.sin(a);
}
_recompute();
```

The wind sampler (pure given `tSec`, zero-alloc via scratch `out`). Gust = sum of incommensurate sines (deterministic, **no `Math.random`**) so it's reproducible across reload/headless and seamless; storm raises amplitude+frequency via the per-profile entry already folded into `cfg.gust`:

```js
// Deterministic gust in [-1..1], shaped by superposed sines (no RNG, no Date).
function _gust01(tSec) {
  const f = cfg.gust.freq_hz, c = cfg.gust.choppiness;
  // 3 incommensurate components -> long, non-repeating-feeling envelope; bounded.
  const g = 0.55 * Math.sin(2*Math.PI*f*tSec)
          + 0.30 * Math.sin(2*Math.PI*f*1.7*tSec + 1.3)
          + 0.15 * Math.sin(2*Math.PI*f*c*tSec + 2.6);
  return Math.max(-1, Math.min(1, g));               // [-1..1]
}

const _scratch = { dirX:0, dirZ:0, strength:0, gust:0, windX:0, windZ:0 };
/**
 * @param {number} tSec wall-clock seconds (frameTime.tsSec or performance.now()*0.001)
 * @returns {{dirX,dirZ,strength,gust,windX,windZ}}  strength already includes the gust;
 *   `gust` is the raw [-1..1] envelope (for the player's amplitude modulation).
 */
export function sampleWind(tSec, out) {
  const dst = out || _scratch;
  const userMul = _numFlag("treeWindStrength", 1.0, 0, 4);   // ?treeWindStrength
  const base = cfg.baseStrength * userMul;
  const g = _gust01(tSec);
  const strength = Math.max(0, base * (1 + cfg.gust.amp * g));  // gust rides on base
  dst.dirX = cfg.dirX; dst.dirZ = cfg.dirZ;
  dst.strength = strength; dst.gust = g;
  dst.windX = cfg.dirX * strength; dst.windZ = cfg.dirZ * strength;
  return dst;
}
export function sampleWindNow(out) {
  const t = (typeof performance !== "undefined" && performance.now)
    ? performance.now() * 0.001 : 0;
  return sampleWind(t, out);
}
```

Weather/season coupling + tuning hooks:

```js
/** Called from loop.js tickWeatherState after the profile is derived. */
export function updateFromWeather(profileName, isStorm, season) {
  cfg.profileName = profileName || "";
  cfg.is_storm = !!isStorm;
  if (Number.isFinite(season)) cfg.season = season;
  const p = WIND_BY_PROFILE[cfg.profileName] || _PROFILE_DEFAULT;
  const seasonMul = SEASON_MULT[cfg.season] ?? 1.0;
  // is_storm forces the gusty floor even if the profile name didn't classify as storm.
  const stormMul = cfg.is_storm ? 1.5 : 1.0;
  if (!override.strength) cfg.baseStrength = Math.min(1, p.baseStrength * seasonMul * stormMul);
  cfg.gust.freq_hz   = p.gust.freq_hz * (cfg.is_storm ? 1.4 : 1.0);
  cfg.gust.amp       = Math.min(1, p.gust.amp * (cfg.is_storm ? 1.3 : 1.0));
  cfg.gust.choppiness= p.gust.choppiness;
  if (!override.azimuth) {
    const f = _numFlag("treeWindDir", NaN, -360, 360);       // ?treeWindDir degrees
    cfg.azimuth_deg = Number.isFinite(f) ? f : DEFAULTS.azimuth_deg;
  }
  _recompute();
}
export function setWindOverride(partial) {                     // window.__setWind
  if (!partial) return;
  if (Number.isFinite(partial.azimuth_deg)) { cfg.azimuth_deg = partial.azimuth_deg; override.azimuth = true; }
  if (Number.isFinite(partial.baseStrength)) { cfg.baseStrength = partial.baseStrength; override.strength = true; }
  if (partial.gust) Object.assign(cfg.gust, partial.gust);
  _recompute();
}
export function getWindState() { return { ...cfg, gust: { ...cfg.gust } }; }

if (typeof window !== "undefined") {
  window.__setWind = setWindOverride;
  window.__getWind = getWindState;
}
```

Resolve `?treeWindDir` once at load (so it applies before the first weather tick): call `updateFromWeather("", false, 1)` is implicit via the `_recompute()` at module load plus the flag read inside `updateFromWeather`; to honor `?treeWindDir` pre-weather, also read it in `_recompute()`’s caller — simplest is an `init()` that `updateFromWeather`'s azimuth branch runs at module load. (Add a one-line `updateFromWeather(cfg.profileName, cfg.is_storm, cfg.season)` after the hook mount.)

### Step 2 — Hook weather changes in `loop.js tickWeatherState` (JS-only, +3 LOC)

In `scene3d/loop.js`, add the import beside the existing weather imports (`loop.js:84-85`):
```js
import { updateFromWeather as windUpdateFromWeather, windEnabled } from "./wind_state.js";
```
Inside `tickWeatherState` (`loop.js:890-950`), right after `wxUpdateFromDayGroup(profile);` at line 914, push profile name + storm + season into the wind module (the data is already in hand):
```js
    wxUpdateFromDayGroup(profile);
    if (windEnabled()) windUpdateFromWeather(profile?.name, profile?.is_storm, profile?.season ?? 1); // treeWind
```
This is cheap and only runs when `?treeWind=on`. It's inside the existing try/catch (947-949) so it can never kill the frame.

### Step 3 — Shader-route feed: new `tickWindUniforms` in `loop.js` (JS-only, ~14 LOC)

Mirror `tickTerrainUTime` exactly (`loop.js:817-831`). The `windUniforms` object is the shared uniforms owned by `materials.js getTreeWind` (task 05); loop.js gets a handle via `scene3d.windUniforms` (task 05 publishes it there at material-build time):
```js
function tickWindUniforms(scene3d) {
  const u = scene3d?.windUniforms;
  if (!u) return;                                   // no-op until task-05 material exists
  const tSec = scene3d.frameTime?.tsSec
    ?? ((typeof performance !== "undefined" && performance.now)
        ? performance.now() * 0.001 : Date.now() * 0.001);  // SAME clock as terrain uTime (822-825)
  const w = sampleWind(tSec, scene3d._windScratch ||= {});
  u.uTime.value = tSec;
  u.uDir.value.set(w.dirX, w.dirZ);
  u.uStrength.value = w.strength;                   // strength already folds in the gust
}
```
Import `sampleWind` from `./wind_state.js`. Call it adjacent to `tickTerrainUTime` at `loop.js:1604-1612`, wrapped in the identical one-shot-warn try/catch:
```js
  try { tickTerrainUTime(scene3d); } catch (e) { /* existing */ }
  if (windEnabled()) {
    try { tickWindUniforms(scene3d); }
    catch (e) { if (!scene3d._windUniformWarned) { scene3d._windUniformWarned = true; console.warn("[treeWind] tickWindUniforms threw:", e); } }
  }
```
Because it reads `scene3d.frameTime.tsSec` — the exact value the water/lava and `ac_moons` (`ac_moons.js:546-549`) shaders use — the forest wind is **phase-locked to the rest of the world clock**.

### Step 4 — Player-route feed: sample in `animated_scenery.js`’s rAF (JS-only, design contract for task 01/03)

The player route does **not** receive `scene3d.frameTime`; it runs its own `performance.now()` rAF (`animated_scenery.js:368-427`). Keep it that way and sample the **same module** there. Two distinct uses, matching the player's architecture (one shared template mixer per DID, instances copy):

1. **Direction + base strength → clip BUILD time.** When task 01/03 generates the synthetic per-part wind clip, pass `getWindState()` so the bake axis = `(dirX, dirZ)` and the base sway amplitude = `cfg.baseStrength`. This sets steady-state lean/rustle.
2. **Gust → PLAY time, on the shared template only.** Inside the rAF loop (`animated_scenery.js:383-427`), after `g.mixer.update(dt)` (line 395) and BEFORE instances copy the template's per-part transforms, modulate the template once per group:
   ```js
   const { gust } = sampleWindNow(_windScratch);    // same wall clock as frameTime.tsSec
   const k = 1 + WIND_GUST_GAIN * gust;             // scale this frame's rotation amplitude
   // for each template part: part.quaternion.slerp/identity-blend toward k*angle
   ```
   One slerp per part (numParts ≈ 3–11) on the single template, then all ≤512 instances inherit it for free via the existing copy — **no per-instance CPU cost**. Using `sampleWindNow()` (performance.now-based) keeps the player's gust within one frame of the shader's gust → both routes breathe together.

**Why both stay in sync:** (a) one module = one source of truth for `dir / strength / gust`; (b) both routes sample a `performance.now()`-derived clock (`frameTime.tsSec` ≡ `_rafNow*0.001`). The high-frequency *phase* differs (shader `uTime` vs clip loop position), but that's invisible — the player handles distinct near-field trees and the shader the far forest; what must agree is the **wind direction and the gust envelope**, and those are read from the same `sampleWind`.

## Defaults & flags

| flag | type | default | meaning |
|---|---|---|---|
| `?treeWind` | `on`/absent | **OFF** (non-retail) | master gate; `windEnabled()` returns true only for `=on` (mirrors `readFogLerpFlag`) |
| `?treeWindStrength` | float ≥ 0 (clamp 0–4) | **1.0** | multiplier on resolved `baseStrength`; `0` = becalmed, `2` = exaggerated |
| `?treeWindDir` | float degrees (−360..360) | **135** (toward SE) | azimuth override of wind direction; `dir = (cos, sin)` in world X/Z |

Internal defaults: `baseStrength 0.5`, gust `freq 0.18 Hz / amp 0.45 / choppiness 2.0`; `is_storm` ⇒ `baseStrength ×1.5`, gust `freq ×1.4`, `amp ×1.3`; season multipliers `[winter 1.10, spring 0.95, summer 0.80, autumn 1.15]`. Live tuning: `window.__setWind({azimuth_deg, baseStrength, gust})` / `window.__getWind()` (matches `weather_state.js:258-265` convention).

## Risks & open questions

- **Two clocks, not one.** The shader route uses `scene3d.frameTime.tsSec`; the player rAF uses its own `performance.now()` (`animated_scenery.js:368-374`). They agree to within a frame, so direction/strength/gust stay coherent, but they are NOT bit-identical. **Mitigation:** rely on the module for the *signal* (dir/gust), not on cross-route phase identity; document that the high-freq phase is intentionally independent. If exact lock is ever needed, thread `scene3d.frameTime` into `attachWindTrees`.
- **Gust can't be baked into a fixed clip.** A static AnimationClip has constant amplitude. **Mitigation (above):** bake the base loop, modulate the gust on the shared template once per frame — zero per-instance cost, preserves the 512-cap budget. Residual: gust modulation is a uniform amplitude scale, not a directional gust front; acceptable for v1.
- **Profile-name coupling is brittle.** `WIND_BY_PROFILE` keys off `daygroup_weather.js` profile `name` strings (line 27-65). If those names change, wind silently falls to `_PROFILE_DEFAULT`. **Mitigation:** `_PROFILE_DEFAULT` is a sane fallback (never zero wind on a known-storm); `is_storm` (the real DAT signal, `daygroup_weather.js:130-158`) independently forces the gusty floor, so storms stay windy even on a name miss. Keep the table small and auditable in one file rather than editing the meteorology module.
- **`terrain.js uWindDir` divergence.** Sand drift uses a static `(1,0)` (`terrain.js:3068`) unrelated to this azimuth. Not a bug today (different feature). **Open question:** unify later by having `tickWindUniforms` also write terrain's `uWindDir` — deferred; out of treeWind v1 scope and would alter retail-frozen sand when `?treeWind=on`, so leave decoupled.
- **Determinism.** Gust uses summed sines, **no `Math.random`/`Date`** — reproducible in headless/CI and seamless across reload. Verified by the established constraint that `Math.random` is unavailable in some sandboxes.
- **Flag-off must be inert.** All hooks are gated by `windEnabled()` (Steps 2-4); with `?treeWind` absent, `tickWindUniforms` early-returns on the missing `scene3d.windUniforms`, `updateFromWeather` is never called, and the module imposes zero per-frame cost — preserving retail-faithful frozen rendering.
