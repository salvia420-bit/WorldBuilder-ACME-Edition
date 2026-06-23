All citations confirmed. Here is my slice deliverable.

---

# Phase 1 — Slice 11: BLOOM + LIGHT BUDGET (`light.flameFlicker`)

## Goal

Two deliverables for the cheap-fragment emissive family's light side:

1. **Bloom strategy** — decide selective vs. global bloom for the Phase-1 emissive effects (`emissive.glint/magicGlow/enchantShimmer`) and quantify when bloom cost "bites."
2. **`light.flameFlicker`** — a torch/brazier light whose `.intensity` jitters via a deterministic flame waveform, modulating **only** the fixed light-pool slot intensity (mech `"light"`, `lightCountDelta 0`). It NEVER touches `.visible` or the light count — the no-relink rule that the spell-freeze light pool exists to enforce (`lighting.js:535-583`).

**Bloom decision: keep the existing GLOBAL screen-space bloom; add nothing.** The live pipeline already runs a pmndrs `BloomEffect` (`atmosphere_pipeline.js:292-300`: `luminanceThreshold 0.85`, `mipmapBlur:true`, on by default at medium+ presets, `index.js:3360`, toggle `?bloom`). The Phase-1 emissive effects write `totalEmissiveRadiance` in the **HalfFloat HDR** composer (`atmosphere_pipeline.js:132-134`), so any emissive pixel that clears 0.85 HDR luminance feeds that bloom **for free** — no per-effect, per-driver, or per-object bloom cost. Rationale + the "how many objects" answer are in Integration notes.

## Files

### NEW — `scene3d/vfx/components/flameFlicker.js` (full contents, committed & tested)

The component + pure helpers + the `tickFlameFlicker(scene3d)` post-pass. Verified lint-clean and standalone-runnable under plain `node` (no `three` in its import graph). Full file:

```js
// light.flameFlicker — torch / brazier flame flicker (Visual-Behavior Suite,
// Phase 1, 2026-06-23). The BLOOM + LIGHT-BUDGET slice's only behavioural piece.
//
// MECH "light": there is NO shader patch and NO new material program. The effect
// jitters the per-frame .intensity that the fixed light POOL (lighting.js,
// ?lightPool=on — the spell-freeze fix) copies into each slot, multiplying it by
// a deterministic flame waveform.
//
// THE RULE (binding, spec §1.2): we touch .intensity ONLY — never .visible,
// never the light array, never the per-type light COUNT. A count change relinks
// every MeshStandardMaterial (the exact freeze the light pool exists to kill —
// see lighting.js "Problem-A fix"), so lightCountDelta = 0 and we never add /
// remove / toggle a light. The pool slot's intensity is RE-DERIVED from its
// source every frame by feedSelectedIntoPool BEFORE this runs, so multiplying it
// is non-destructive: there is no state to restore and the authored source
// intensity is never mutated. When ?lightPool=off (the legacy .visible-cap path)
// there are no pool slots to drive, so flameFlicker is a documented no-op.
//
// Per-light phase is seeded ONCE from the light's static spawn origin (a
// deterministic integer hash — NEVER Math.random) and cached on userData, so
// co-located torches flicker out of sync and a static torch's phase never jumps.
//
// Clock: scene3d.frameTime.tsSec — the canonical per-frame wall clock. This is
// the SAME source the oscillator tick copies into VFX_GLOBALS.uTime (slice 01)
// and that tickTerrainUTime uses, so flame flicker shares one timebase with the
// frag shader effects. Reading it directly (rather than importing materials.js /
// VFX_GLOBALS) keeps this module free of the `three` graph so it is
// standalone-testable under plain node, like the other VFX component tests.

import { registerComponent } from "../registry.js";
import { visualEnabled } from "../../vfx_catalog.js";

// Default flame parameters. amp = peak fractional intensity swing; floor =
// hard lower clamp so a flame never goes dark (and so a high amp never crosses
// 0 → a near-relink-looking pop). baseHz/subHz are two incommensurate flicker
// rates; noiseHz drives the smooth value-noise envelope that makes it read as
// fire rather than a pure sine. Tuned against AC torch/brazier intensities
// (authored 20–100, see lighting.js LG1 census).
export const FLAME_DEFAULTS = Object.freeze({
  amp: 0.16,
  floor: 0.74,
  baseHz: 7.3,
  subHz: 2.13,
  noiseHz: 2.7,
});

// Deterministic 32-bit integer hash → [0,1). No Math.random / no Date.now.
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth 1D value noise (smoothstep-interpolated hash) → [0,1]. This is the
// same shape the shared oscillator registry's "smoothNoise" provides (slice 01,
// cost_model row notes "smoothNoise/decay"); kept self-contained here so the
// slice is independently testable, and trivially swappable for the shared
// oscillator once oscillators.js lands (queued consolidation — see notes).
function smoothNoise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  const a = hash01(i);
  const b = hash01(i + 1);
  return a + (b - a) * u;
}

/**
 * The flame intensity MULTIPLIER for one light at time t. Bounded to
 * [cfg.floor, 1 + cfg.amp*1.28] and strictly > 0 — never relink-adjacent.
 * Pure + deterministic (same phase01,t → same value).
 * @param {number} phase01  per-light phase in [0,1)
 * @param {number} t        seconds (VFX_GLOBALS.uTime)
 * @param {object} cfg      {amp,floor,baseHz,subHz,noiseHz}
 * @returns {number} intensity multiplier
 */
export function flameFlickerMul(phase01, t, cfg = FLAME_DEFAULTS) {
  const a = phase01 * 6.2831853; // 2π phase offset
  const s1 = Math.sin(t * cfg.baseHz + a);
  const s2 = Math.sin(t * cfg.subHz + a * 1.7 + 1.3);
  const n = smoothNoise1(t * cfg.noiseHz + phase01 * 17.0) * 2 - 1; // [-1,1]
  const w = 0.5 * s1 + 0.28 * s2 + 0.5 * n; // ~[-1.28, 1.28]
  const f = 1 + cfg.amp * w;
  return f < cfg.floor ? cfg.floor : f;
}

/**
 * Is this a flame-class source light (torch / brazier / candle / lantern)?
 * Warm = red-dominant with a blue deficit, in the light's LINEAR color (the
 * makeThreeLightForSetupLight constructor decodes AC's sRGB tint to linear).
 * Point lights only (AC braziers/torches author cone_angle 0 → PointLight;
 * spots are ~absent in shipped data). Excludes white / cool / magic-blue
 * lights so portals, ice spells, etc. never flicker.
 * @param {{isPointLight?:boolean, color?:{r:number,g:number,b:number}}} light
 */
export function isFlameLight(light) {
  if (!light || light.isPointLight !== true) return false;
  const c = light.color;
  if (!c) return false;
  return c.r >= 0.30 && c.r >= c.g * 0.92 && c.r > c.b * 1.25;
}

/**
 * Lazily resolve & cache the per-light flame phase in [0,1), or -1 for a
 * non-flame light. Cached on userData so it is computed ONCE (deterministic,
 * stable — no per-frame jump). Seed = the static spawn origin
 * (userData.setupLightOrigin, set by makeThreeLightForSetupLight); reading a
 * static derived position is legacy-safe (never the wire/pose).
 */
export function flameSourcePhase(light) {
  if (!light) return -1;
  const ud = light.userData || (light.userData = {});
  const cached = ud.__vfxFlamePhase;
  if (cached !== undefined) return cached;
  if (!isFlameLight(light)) {
    ud.__vfxFlamePhase = -1;
    return -1;
  }
  const o = ud.setupLightOrigin;
  // Quantise to a 0.25 m grid then hash with three large primes so even
  // near-identical positions get distinct phases. Computed once, then cached.
  const seed = o
    ? ((Math.round(o.x * 4) * 73856093) ^
       (Math.round(o.y * 4) * 19349663) ^
       (Math.round(o.z * 4) * 83492791))
    : 0;
  const ph = hash01(seed);
  ud.__vfxFlamePhase = ph;
  return ph;
}

// --- URL flags (default OFF behind ?visual). Memoised, mirrors the
// vfx_catalog.js / tree_wind.js flag idiom. -----------------------------------
function _strFlag(name) {
  try {
    if (typeof window !== "undefined" && window.location) {
      return new URLSearchParams(window.location.search).get(name);
    }
  } catch (_) { /* default */ }
  return null;
}
function _numFlag(name, dflt, lo, hi) {
  const v = parseFloat(_strFlag(name));
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
}
function _truthy(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s !== "off" && s !== "0" && s !== "false" && s !== "no" && s !== "";
}

let _enabled;
/** ?flameFlicker — torch/brazier intensity jitter. Requires ?visual too. OFF. */
export function flameFlickerEnabled() {
  if (_enabled !== undefined) return _enabled;
  _enabled = visualEnabled() && _truthy(_strFlag("flameFlicker"));
  return _enabled;
}

let _cfg;
/** Resolved flame params (?flameFlickerAmp overrides amp; rest are defaults). */
export function flameFlickerConfig() {
  if (_cfg !== undefined) return _cfg;
  const amp = _numFlag("flameFlickerAmp", FLAME_DEFAULTS.amp, 0, 0.6);
  _cfg = amp === FLAME_DEFAULTS.amp ? FLAME_DEFAULTS : { ...FLAME_DEFAULTS, amp };
  return _cfg;
}

/** Test-only: clear the memoised flag/config (URL changed between cases). */
export function _resetFlameFlickerFlagsForTest() {
  _enabled = undefined;
  _cfg = undefined;
}

/**
 * Per-frame post-pass. Runs in loop.js AFTER tickLightingForCellState (which
 * has already re-fed the pool slots from their sources). Reads ONLY the
 * exposed pool descriptor (scene3d.lighting.lightPool) — it never imports or
 * edits lighting.js, and never touches a source light. For each occupied point
 * slot whose source is a flame, multiplies the slot's .intensity by the flame
 * waveform. pool.point[i] ←→ pool.selPoint[i] is the stable slot↔source map
 * feedSelectedIntoPool maintains.
 *
 * No-op (byte-identical render) when ?flameFlicker is off OR ?lightPool=off.
 */
export function tickFlameFlicker(scene3d) {
  if (!flameFlickerEnabled()) return;
  const pool = scene3d && scene3d.lighting && scene3d.lighting.lightPool;
  if (!pool || !pool.enabled) return; // legacy .visible-cap path → no slots
  const t = (scene3d.frameTime && scene3d.frameTime.tsSec) || 0;
  const cfg = flameFlickerConfig();
  const slots = pool.point;
  const srcs = pool.selPoint;
  for (let i = 0; i < slots.length; i += 1) {
    const src = i < srcs.length ? srcs[i] : null;
    if (!src) continue;
    const ph = flameSourcePhase(src);
    if (ph >= 0) slots[i].intensity *= flameFlickerMul(ph, t, cfg);
  }
}

export const flameFlicker = {
  id: "light.flameFlicker",
  family: "emissive", // valid family bucket; NOT on the frag chain (mech=light)
  mech: "light",
  channel: "light",
  linkVariant() { return ""; }, // mech=light: no shader link, no program
  cacheKeyScope: "none",
  deterministic: true,
  lightCountDelta: 0, // THE RULE: intensity-only, never a count/visible change
  // Legacy-safety manifest (spec §1.2): reads the client clock + a per-light
  // identity hash; writes ONLY a render-time light intensity (the pooled slot
  // the server neither stores nor replicates). Never the wire, physics, or a
  // replicated field.
  reads: ["clock", "instanceHash"],
  writes: ["lightIntensity"],
  defaults: { ...FLAME_DEFAULTS },
  // mech=light drives intensity from the dedicated `tickFlameFlicker(scene3d)`
  // post-pass (loop.js) — NOT the shared tick(dt,t) uniform contract — so it is
  // intentionally not assigned to `.tick`. No GLSL inject/declareUniforms/buildClip.
};

registerComponent(flameFlicker);
export default flameFlicker;
```

### EDIT — `scene3d/vfx/registry.js:33` (additive: the missing write cap for `mech:"light"`)

The registry already declares `mech:"light"` (`registry.js:35`) but had **no** write cap to support it (`WRITE_CAPS` lacked a light-intensity write), making the light mech un-declarable. This 1-token additive change completes the substrate the light family needs. The firewall is untouched: `lightCountDelta!==0` is still rejected (`registry.js:48`).

```diff
- const WRITE_CAPS = new Set(["renderTransform", "partTransform", "materialUniform", "emitter"]);
+ const WRITE_CAPS = new Set(["renderTransform", "partTransform", "materialUniform", "emitter", "lightIntensity"]);
```

### EDIT — `scene3d/vfx/lint_caps.js:28-36` (additive: mirror the cap into the lint vocab)

`ALLOWED_WRITES` must match `WRITE_CAPS` or `test_vfx_legacy_safety` Layer A fails for any light-mech component. Anchor = the existing `ALLOWED_WRITES` set:

```diff
  export const ALLOWED_WRITES = Object.freeze(new Set([
    "renderTransform",  // render.rootTransform (stomped by setPose)
    "partTransform",    // render.partTransform (animated_scenery template)
    "materialUniform",  // material.clonedUniform
    "emitter",          // synthesized particle emitter
+   "lightIntensity",   // mech:"light" — render-time .intensity of a POOLED/cloned
+                       // light slot ONLY; NEVER .visible or the light COUNT (the
+                       // no-relink rule). lightCountDelta must still be 0.
  ]));
```

> ⚠️ **Shared-substrate edit — coordinate with slices 00/16.** These two additive lines are load-bearing for any `mech:"light"` component. If a sibling slice or the integrator owns the registry/lint vocab, hand them this diff rather than double-applying.

### EDIT — `scene3d/loop.js` (import @ line 41; post-pass call after the lighting tick @ line ~1749)

flameFlicker is a **post-pass** that reads the already-exposed `scene3d.lighting.lightPool` — so **`lighting.js` is not touched at all** (zero risk to the light-pool eval-strip harness `test_light_pool.mjs`). Import anchor = the existing `tickLightingForCellState` import:

```diff
  import { tickLightingForCellState } from "./lighting.js";
+ import { tickFlameFlicker } from "./vfx/components/flameFlicker.js";
  import { getTerrainVisualZ, cullTerrainGroup } from "./terrain.js?v=phase-d-batch";
```

Call anchor = immediately after the `tickLightingForCellState` try/catch block (so the pool slots are already re-fed this frame), before the "Wave 1.E" shadow-receive gate:

```diff
    } catch (e) {
      // eslint-disable-next-line no-console
      if (!scene3d._lightingTickWarned) {
        scene3d._lightingTickWarned = true;
        console.warn("[phase7.6] tickLightingForCellState threw:", e);
      }
    }
+   // VFX Phase 1 (light.flameFlicker) — torch/brazier intensity jitter. Runs
+   // AFTER the lighting tick so the pool slots are already re-fed from their
+   // sources this frame; it multiplies the occupied point-slot intensities by a
+   // deterministic flame waveform. Hard no-op (byte-identical) unless ?visual &&
+   // ?flameFlicker AND ?lightPool=on. Intensity-only — never a light count /
+   // visibility change (THE RULE / the no-relink discipline).
+   try {
+     tickFlameFlicker(scene3d);
+   } catch (e) {
+     // eslint-disable-next-line no-console
+     if (!scene3d._flameFlickerTickWarned) {
+       scene3d._flameFlickerTickWarned = true;
+       console.warn("[vfx] tickFlameFlicker threw:", e);
+     }
+   }
    // Wave 1.E (2026-05-28) — player-tracked shadow-receive gate.
```

## GLSL

**None.** `light.flameFlicker` is `mech:"light"` — it modulates a real `THREE.PointLight`'s `.intensity` from JS; there is no shader patch, no new program, no GLSL seam. The only shader interaction is indirect and free: the flickering point light modulates the lit surfaces it already lights, and the existing global `BloomEffect` (`atmosphere_pipeline.js:292`) picks up any co-located emissive flame mesh (from `emissive.magicGlow`/a future particle flame) on its own. This is precisely why a light effect spends the *light* budget, not the fragment budget.

## Manifest

```js
{
  id: "light.flameFlicker",
  family: "emissive",            // valid bucket; not on the frag FAMILY_ORDER chain
  mech: "light",                 // registry.js:35 MECHS already allows it
  channel: "light",
  reads:  ["clock", "instanceHash"],   // ⊆ ALLOWED_READS  (clock = frameTime.tsSec; per-light identity hash)
  writes: ["lightIntensity"],          // ⊆ ALLOWED_WRITES (the new light-mech cap)
  deterministic: true,                 // hash01 + sin, NO Math.random / Date.now
  lightCountDelta: 0,                  // ★ never add/remove/toggle a light → no relink
  cacheKeyScope: "none",               // touches no material program / customProgramCacheKey
  linkVariant: () => "",               // no shader link
  defaults: { amp:0.16, floor:0.74, baseHz:7.3, subHz:2.13, noiseHz:2.7 },
}
```

Passes `lintManifest` (Layer A) and `lintSource` (Layer B — no `.visible=`, `Math.random`, `Date.now()`, wire, or collision tokens). Verified by both `test_vfx_flameflicker.mjs` and the existing `test_vfx_legacy_safety.mjs` Layer-B directory scan (which already reads `components/flameFlicker.js`).

## Test

**NEW — `test_vfx_flameflicker.mjs`** (check()/process.exit style; runs under plain `node`, no `three` in its graph). **Result: 34 passed, 0 failed.**

Coverage: registration + manifest conformance; the new `lightIntensity` cap; source self-lint; waveform **deterministic + bounded `[floor, 1+amp·1.28]` + strictly > 0 + floor-clamp engages under high amp**; flame classification (warm point → flame; white/cool/spot → not); lazy phase cache (stable, deterministic, `-1` sentinel for non-flame); and the `tickFlameFlicker` post-pass against a mock pool proving: **OFF → byte-identical**, **ON → flame slot modulated while white-source slot unchanged**, **slot stays in band**, **NO count/visibility change**, **`?lightPool=off` → no-op**, **`?visual` is a required outer gate**, **`?flameFlickerAmp` override**.

Key excerpt (the no-relink + byte-identical invariants):

```js
// ON → only flame sources flicker; never a count/visibility change
tickFlameFlicker(sOn);
check("★ ON → flame slot intensity modulated (slot 0, warm source)",
  pool.point[0].intensity !== 100 && pool.point[0].intensity > 0);
check("★ ON → white-source slot UNCHANGED (only flame sources flicker)",
  pool.point[1].intensity === 60);
check("★ NO count change + NO visibility change (the no-relink rule)",
  pool.point.length === countBefore && pool.point.every((p, i) => p.visible === visBefore[i]));
```

Regression check (all green after the additive cap edits):

```
test_vfx_flameflicker.mjs   34 passed, 0 failed
test_vfx_legacy_safety.mjs  17 passed, 0 failed   (Layer B already scans flameFlicker.js)
test_vfx_windbend.mjs       11 passed, 0 failed
test_vfx_catalog.mjs        14 passed, 0 failed
```

> **For slice 16's harness:** add `import "./scene3d/vfx/components/flameFlicker.js";` to `test_vfx_legacy_safety.mjs` (TIER1 registration) so Layer A also checks flameFlicker's *manifest* (currently only its source is scanned). I verified `lintManifest(flameFlicker) === []`, so that addition stays green.

## Integration notes

**Composition / data flow.** flameFlicker is **not** on the `_chainBeforeCompile` FAMILY_ORDER material chain — it's a light-mech effect, decoupled from the frag effects. It runs as one post-pass after `tickLightingForCellState` (`loop.js:1734` → `feedSelectedIntoPool` at `lighting.js:699-739`). It reads only the exposed `scene3d.lighting.lightPool` descriptor (`lighting.js:313` puts `lightPool` on the bundle; `selPoint`/`selSpot` at `lighting.js:656-657` give the stable slot↔source map). Because `feedSelectedIntoPool` re-derives `dst.intensity = src.intensity` from scratch **every frame** before flameFlicker runs, the multiply is inherently non-destructive — there is no state to restore and the authored source intensity is never mutated. This is the cleanest possible firewall story for a light effect.

**The intensity-only rule (binding).** flameFlicker multiplies pool-slot `.intensity` only. It never reads/writes `.visible`, never adds/removes a light, never resizes the pool. The fixed pool's per-type count is the constant the renderer compiles against (`lighting.js:535-583`); flameFlicker preserves it exactly — `lightCountDelta 0`, no MeshStandardMaterial relink, no spell-freeze. When `?lightPool=off` (legacy `.visible`-cap escape hatch) there are no slots → documented no-op.

**Which emissive effects feed bloom.** The existing **global** `BloomEffect` is the single bloom path; the Phase-1 emissive effects feed it via HDR `totalEmissiveRadiance` with zero per-driver cost:
- `emissive.magicGlow` (floor ≤2.0) → clears 0.85 → soft halo. **Free** (cost_model already notes "bloom halos free when bloom on").
- `emissive.enchantShimmer` → pulses across the 0.85 line → breathing bloom.
- `emissive.glint` → brief specular spike → momentary sparkle bloom (cost_model marks it sub-threshold/`bloomTier sub` by default, so it mostly stays under and is a controlled opt-in).
- `light.flameFlicker` itself feeds bloom **only indirectly** — through any co-located emissive flame mesh, never the point light (lights aren't bloom sources).

**Selective vs. global — and when bloom cost bites.** **Global, keep it.** `mipmapBlur` builds a screen-space mip pyramid over the whole HalfFloat buffer (`atmosphere_pipeline.js:286-300`, ~0.5 ms @ 1440p/1070 per its own note). That cost is **fixed and independent of emissive object count** — it's paid once per frame whether 0 or 10 000 objects exceed threshold, so *"how many >threshold objects before mip cost bites" → it never does; the mip cost doesn't scale with object count.* A selective/layer bloom would *add* a dedicated bright-pass render target + a composite pass — strictly more expensive than the thing it would "optimize." The only budget that scales with emissive count is **aesthetic** (too many objects blooming at once washes the frame); that's governed by capping the emissive component population via `?visualBudget` (slice 14), not by touching bloom internals.

**Gauge cost row (already present, `cost_model.jsonl`, slice 15):**
```
light.flameFlicker · cheap · dProgramsPerDriver 0 · dCallsPerInstance 0 · dVramMB 0
                   · dParticleEmitters 0 · dLightsPerDriver 0 · dAluClass none · mech light
```
Placement-independent, 0 programs / 0 draw calls / 0 VRAM. My JS `lightCountDelta:0` mirrors the C# `dLightsPerDriver:0` G4 invariant. CPU cost is O(flickering pool slots) = ≤ `pointCount` (default 8, `lighting.js:566`) sin-evals/frame — negligible.

**`?flag`.** `?visual` (outer gate, default OFF) **AND** `?flameFlicker` (per-effect, default OFF). Optional `?flameFlickerAmp` (0–0.6, default 0.16). All NON-RETAIL / Pending-1070. Flag readers live in `flameFlicker.js` for now (memoized, mirroring the `tree_wind.js`/`vfx_catalog.js` idiom); slice 14 may re-export them from a central `vfx_flags.js` — the readers are pure and relocatable.

**Queued-for-1070:**
- Per-light phase currently seeds from `setupLightOrigin` (static, allocation-free). Co-located identical-setup torches *can* sync; the placement-hash seed (distinguishing co-located placements) is queued.
- Replace the self-contained `smoothNoise1` with `oscillators.js`'s shared `smoothNoise` (slice 01 has landed; the math is interchangeable) — a pure consolidation, no behavior change.
- Descriptor-driven flame classification: today flameFlicker auto-classifies warm point lights; a future catalog descriptor could mark specific brazier/torch DIDs explicitly (coexists with the color heuristic).

## Risks

- **Shared-vocab double-edit.** `registry.js`/`lint_caps.js` `+lightIntensity` is the only shared-substrate change; if slice 00/16 also adds a light write cap, reconcile to one line (additive, idempotent — low risk).
- **Flame classification false-positives.** A warm-but-not-fire point light (e.g. a warm magic glow) would flicker. Mitigation: conservative thresholds (`r ≥ 0.30 && r ≥ g·0.92 && r > b·1.25`) exclude white/cool/blue; default-OFF; descriptor opt-in queued. Worst case is a slightly-jittering warm lamp — never a correctness or perf issue.
- **`?lightPool=off` path.** flameFlicker is a deliberate no-op there (no slots to drive non-destructively). Acceptable: the pool is ALWAYS-ON by default (`lighting.js:560`); `?lightPool=off` is a debug/A-B escape hatch.
- **Timebase coupling.** Reads `scene3d.frameTime.tsSec` directly (identical to what drives `VFX_GLOBALS.uTime`, confirmed `oscillators.js:177-178`). If a future refactor makes `uTime` diverge from `frameTime.tsSec`, flameFlicker would need to switch to importing `VFX_GLOBALS` (and accept the `three` dep / lose standalone testability). Today they're the same snapshot — no drift.
- **`loop.js` import.** Adds `./vfx/components/flameFlicker.js` (→ `vfx_catalog.js` + `registry.js`, no `three`) to loop.js's graph. Tests that `await import("./scene3d/loop.js")` already require `three` to resolve, so the extra non-`three` import is free; text-shape tests (`test_a1_o4`) read loop.js as a string and are unaffected.
