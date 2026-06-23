Everything is verified and adjudicated. Here is the authoritative kit.

---

# Visual-Behavior Suite — Phase 1 Implementation Kit (emissive/material frag bundle)

*Lead-synthesizer integration kit, 2026-06-23 · branch `visual-suite-brainstorm` · built on the shipped Phase-0 substrate (commits `0b4bc9f2`…`ce0d991b`). Synthesized from `phase1-out/parts/01..16`, cross-checked against the live tree. Cite format: `slice NN` + `file:line`.*

---

## 0. INTEGRATION STATE — read this first

The 16 slices wrote **all 8 component files + 7 infra files to disk (untracked)** and applied *most* shared edits, but the **activation wiring is deliberately not applied** (slices 02/13/16 left shared-file edits as diffs to avoid a 16-way clobber). This kit's job is to close that gap effect-by-effect. Verified against the tree:

| Piece | State on disk | Action |
|---|---|---|
| 8 components `scene3d/vfx/components/*.js` | ✅ present (untracked) | commit per §11 |
| infra `oscillators / per_instance / shadow_guard / frag_install / frag_attach / weather_inputs` | ✅ present (untracked) | commit |
| `vfx_flags.js` | ✅ present (untracked) | commit |
| `loop.js` — osc + weather + flame ticks | ✅ **applied** (`:41,:95,:100,:101,:863,:887,:1683,:1695,:1749`) | commit |
| `materials.js` — slice-04 `__vfxColorPassOnly` stamp | ✅ **applied** (`:1858`) | commit |
| `materials.js` — `installVfxComponentPatch` export | ❌ **MISSING** | **§2b add it** |
| `registry.js` / `lint_caps.js` — `lightIntensity` write cap | ✅ **applied** (`:33`) | commit |
| `weather_state.js` — `readWeatherVfxInputs` | ✅ **applied** (`:261`) | commit |
| `cost_model.jsonl` + 3 `.cs` — gauge G4 + 5 rows | ✅ **applied** | commit |
| `harness/run-js-headless.mjs` TIER1 | ⚠️ partial (5 of ~17 rows) | **§10 add rows** |
| `frag_install.js` — `buildFragVariant` bridge | ❌ **MISSING** (frag_attach calls it) | **§2b add it** |
| `statics.js` — ALL frag wiring | ❌ **MISSING** | **§7 add it (the activation)** |
| `scene3d/vfx/components/index.js` barrel | ❌ **MISSING** | **§10 add it** |
| `vfx_catalog.js` `COMPONENT_MECH` rows for magicGlow/enchantShimmer/wetness/frost | ❌ **MISSING** | **§7 add them** |
| `docs/url-flags.md` rows | ❌ **MISSING** | **§8 add them** |

**Adjudications made here** (where slices disagreed — full rationale inline):

1. **frag selection seam (slice 02 ⟷ 13).** `frag_attach.fragPlanForDid(did)` is the *selection* authority (config precedence `defaults < shared < byId`, plus the per-effect `comp.enabled()` flag gate). `frag_install` owns the *firewall* (setKey/configKey/`getCachedVariant`). They are bridged by a **new `buildFragVariant(mc, surfaceDid, entries, deps)`** added to `frag_install.js` — exactly the symbol `frag_attach.js:16` and `statics.js` call but which **does not yet exist**. `resolveFragMaterial` is kept as the slice-02 standalone path/test.
2. **`vVfxHash`** is installed as the chain's `sharedPrelude` (runs *first*, before any component `inject`) via `ensureVfxHashVarying` (slice 03), threaded through `buildFragVariant` deps.
3. **world-normal varying** is owned solely by `wetness.js` (`ensureWorldNormalVarying` / `VFX_WORLD_NORMAL_VARYING = "vVfxWorldNormal"`). `tarnish`'s up-facing patina and `frost`'s up-bias are **queued-for-1070** (inert `#ifdef`, no declaration) → zero double-declaration risk in Phase 1.
4. **channel names:** emissive `glint`/`glow`/`emissive` are correctly **distinct** (so they stack) — keep. Weathering `wetness`=`"wetness"` vs `frost`=`"surfaceWeather"` must share a channel for §14 mutual exclusion → **unify to `"precip"`** (one-token edit each). Forward-looking: the §14 resolver is not wired in Phase 1; correctness is held by the in-shader `(1.0 - uWetness)` gate (`frost.js`) + weather_inputs driving only one of the two.
5. **`lightIntensity` write cap:** both slice 11 and slice 16 proposed it — **already applied**; no double-apply.

---

## 1. Overview + binding constraints

**Goal.** Add the cheap-fragment emissive/material family to the auto-classified Visual-Behavior Suite: three emissive effects (`glint`, `magicGlow`, `enchantShimmer`), three weathering effects (`tarnish`, `wetness`, `frost`), one light effect (`flameFlicker`), all driven by a single per-frame oscillator/weather tick, all default-OFF, all byte-identical when off.

**The binding constraints (recap), enforced mechanically:**

- **THE RULE** (`lint_caps.js`, `registry.validateComponent`): a component READS only static/derived inputs + the client clock (`ALLOWED_READS` = geometry, surface, setup, weenieProps, serverPose, instanceHash, clock, drawCastSubstate, weather); WRITES only render-time transforms / cloned-material uniforms / emitters / **lightIntensity** (`ALLOWED_WRITES`) — never the wire, physics/collision, or a server-replicated field. `deterministic:true`, `lightCountDelta:0`, `cacheKeyScope ∈ {set,none}` (never `"instance"`). Source is scanned (Layer B) for `Math.random`, argless `Date.now`, `.visible=`, wire/collision calls, and per-instance `customProgramCacheKey`.
- **THE FIREWALL — one compiled program per component-SET, never per-DID.** The program-cache key is `_patchSetCacheKey = "...|v" + __vfxSetKey` (`materials.js:277`), and `__vfxSetKey` carries only `(ordered component ids + each linkVariant() token)` — **never** config scalars, `vVfxHash`, guid, or instanceHash. Config rides uniforms; per-instance variation rides the `vVfxHash` varying. `getCachedVariant(surfaceDid, setKey, configKey, builder)` (`materials.js:1845`) keys the *material clone* by `(surfaceDid|setKey|configKey)` but the *program* by `__vfxSetKey` only → 10k DIDs in one SET → 10k cache-shared clones → **one** program.
- **`?visual` + per-effect flags default-OFF.** `visualEnabled()` (`vfx_catalog.js:26`) is the master gate; each effect adds its own default-OFF flag (`vfx_flags.js`). Both must be on for an effect to attach.
- **Gauge STRUCTURAL-PASS / byte-identical when off.** With `?visual` off the catalog is never consulted, no frag variant is resolved, and the shared uniforms (`uTime/uWetness/uFrost/uWindDir`) are dormant `{value:0}` objects no material binds → identical render. `vfx gauge --ref holtburg` reports `STRUCTURAL-PASS` (programsΔ 0, drawcallsΔ 0, vram 0, lightsΔ 0) because the new cost rows only sum when a DID resolves to a Phase-1 archetype (none on the Holtburg ref).

---

## 2. SHARED INFRA — assembled in dependency order

Dependency order: **(a) oscillators → (b) frag_install + componentSetKey + material seam → (c) per-instance vVfxHash → (d) shadow-pass exclusion.**

### 2(a) Oscillators + the loop.js tick seam — slice 01

`scene3d/vfx/oscillators.js` (✅ on disk, THREE-free leaf) is the single per-frame VFX tick: it writes `VFX_GLOBALS.uTime` (the master clock, sole writer) + each registered `{value}` channel, O(1)/frame, deterministic in `t`. API: `WAVES`, `sampleWave`, `setMasterClock`, `registerOscillator`, `tickOscillators(tSec,dt)`, `OSCILLATOR_INFRA_MANIFEST`. The registry stays empty until an effect registers a channel → byte-identical when off.

**`loop.js` seam — ✅ APPLIED, verified live:**
```js
// loop.js:94-95,100-101 (imports + master-clock bind)
import { VFX_GLOBALS } from "./materials.js";
import { tickOscillators, setMasterClock } from "./vfx/oscillators.js";
import { tickWeatherInputs } from "./vfx/weather_inputs.js";   // slice 12 (ticks alongside)
setMasterClock(VFX_GLOBALS.uTime);
```
```js
// loop.js:863 tickVfxOscillators(scene3d) wrapper → tickOscillators(tSec,dt) at :870
// loop.js:1683 the per-frame call (in tickPerFrame), wrapped in one-shot-warn try/catch.
```
Clock resolution mirrors `tickTerrainUTime` (`scene3d.frameTime.tsSec` with `performance.now`/`Date.now` fallback) so the VFX clock and terrain water clock share one snapshot. **Never budget-gated** (it is the clock).

### 2(b) frag_install + componentSetKey + the material-swap seam — slice 02 (+ adjudicated bridge)

`scene3d/vfx/frag_install.js` (✅ on disk) is THREE-free; it composes a DID's frag components into one cloned variant under one `__vfxSetKey`. Exports: `fragComponentsForDescriptor`, `componentSetKey`, `fragConfigKey`, `configForComponent`, `resolveFragMaterial({...})`, `resolveFragMaterialForDid`, `PATCH_MECHS`, `_resetFragInstall`. The firewall core (`frag_install.js:146-176`):
```js
const setKey = componentSetKey(comps, cfg);   // program-cache bits (ids + linkVariant only)
const configKey = fragConfigKey(comps, cfg);  // heap-dedup only (NOT in program key)
return materialCache.getCachedVariant(surfaceDid, setKey, configKey, (material) => {
  if (sharedPrelude) installComponentPatch(material, sharedPrelude, undefined, globals); // vVfxHash first
  for (const comp of comps) installComponentPatch(material, comp, configForComponent(comp, cfg), globals);
});
```

**EDIT 1 (MISSING) — `scene3d/materials.js`: add `installVfxComponentPatch`.** Anchor: immediately after the `VFX_GLOBALS` block closes at **`materials.js:322`** (`_chainBeforeCompile` is in scope at `:297`):
```js
// (after line 322: `};` — end of `export const VFX_GLOBALS = { ... };`)
// Install ONE frag VFX component's patch onto a getCachedVariant clone (slice 02).
// frag_install calls this per component in (FAMILY_ORDER, id) order; the chain
// composition + the __vfxSetKey-driven program-cache key live entirely here so
// frag_install stays THREE-free. declareUniforms binds VFX_GLOBALS by REFERENCE;
// inject splices the GLSL seam. Both run at compile time (inside onBeforeCompile).
export function installVfxComponentPatch(material, component, config, globals) {
  if (!material || !component) return;
  _chainBeforeCompile(material, function vfxComponentHook(shader) {
    try { component.declareUniforms && component.declareUniforms(shader, config, globals); }
    catch (e) { console.warn(`[vfx] declareUniforms ${component.id} failed:`, e); }
    try { component.inject && component.inject(shader, { material: this, config, globals }); }
    catch (e) { console.warn(`[vfx] inject ${component.id} failed:`, e); }
  });
}
```

**EDIT 2 (MISSING, ADJUDICATED) — `scene3d/vfx/frag_install.js`: add the `buildFragVariant` bridge** that `frag_attach.js:16` + `statics.js` call. It consumes `frag_attach`'s pre-merged, FAMILY_ORDER-sorted `entries: [{comp, config}]` and reuses the same setKey/configKey/getCachedVariant firewall. Append to `frag_install.js`:
```js
let _warnedNoInstaller2 = false;
/**
 * Build (or cache-hit) the per-SET frag variant for a surfaceDid from a
 * FAMILY_ORDER-sorted plan (frag_attach entries: [{comp, config}]). The deps
 * (globals/installComponentPatch/sharedPrelude) are INJECTED so this stays
 * THREE-free + node-testable; statics.js supplies VFX_GLOBALS,
 * installVfxComponentPatch, and the slice-03 vVfxHash prelude.
 * Returns the cloned variant, or null (caller keeps base → byte-identical).
 * @param {object} materialCache  has getCachedVariant
 * @param {number} surfaceDid
 * @param {Array<{comp:object,config:object}>} entries  pre-merged, pre-sorted
 * @param {{globals:object, installComponentPatch:Function, sharedPrelude?:object}} deps
 */
export function buildFragVariant(materialCache, surfaceDid, entries, deps = {}) {
  if (!materialCache || typeof materialCache.getCachedVariant !== "function") return null;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const { globals, installComponentPatch, sharedPrelude } = deps;
  if (typeof installComponentPatch !== "function") {
    if (!_warnedNoInstaller2) { _warnedNoInstaller2 = true;
      console.warn("[vfx] buildFragVariant: no installComponentPatch; frag path inert (base kept)"); }
    return null;
  }
  // setKey: ids + linkVariant bits ONLY (firewall). configKey: per-entry config hash (heap dedup).
  const setKey = entries.map((e) => {
    let v = ""; try { v = e.comp.linkVariant ? (e.comp.linkVariant(e.config) || "") : ""; } catch (_) { v = ""; }
    return v ? `${e.comp.id}:${v}` : e.comp.id;
  }).join("+");
  const configKey = entries.map((e) => e.comp.id + "=" + _stableStr(e.config)).join("&") || "default";
  return materialCache.getCachedVariant(surfaceDid, setKey, configKey, (material) => {
    if (sharedPrelude) installComponentPatch(material, sharedPrelude, undefined, globals); // vVfxHash first
    for (const e of entries) installComponentPatch(material, e.comp, e.config, globals);
  });
}
```
(`_stableStr` already exists in `frag_install.js:49`.) The material-swap *call sites* in `statics.js` are §7.

### 2(c) Per-instance age/hash (`vVfxHash`) — slice 03

`scene3d/vfx/per_instance.js` (✅ on disk) exports `ensureVfxHashVarying(shader)` (idempotent), `VFX_HASH_VARYING="vVfxHash"`, GLSL constants, and `vfxHash01Ref`. **Decision: procedural, not an attribute** — `THREE.BatchedMesh` (the `?staticBatch` path) has no first-class per-instance custom float attribute, so the value is derived in-shader from the per-instance transform three already uploads. Vertex (after `<begin_vertex>`):
```glsl
#ifdef USE_BATCHING
  vVfxHash = vfxHash01(batchingMatrix[3].xy);
#elif defined( USE_INSTANCING )
  vVfxHash = vfxHash01(instanceMatrix[3].xy);
#else
  vVfxHash = vfxHash01(modelMatrix[3].xy);
#endif
```
Firewall-safe by construction: variation rides per-instance matrix *data*, never the program; `USE_INSTANCING`/`USE_BATCHING` are already distinct three program layers, so the `#ifdef` ladder adds **zero** new programs. **Consumer obligation:** any component reading `vVfxHash` declares `"instanceHash"` in `reads[]` (glint, enchantShimmer, tarnish all do). Installed once per SET as the chain `sharedPrelude` (§2b).

### 2(d) Shadow-pass exclusion — slice 04

`scene3d/vfx/shadow_guard.js` (✅ on disk). **Core finding (verified, three r184):** the shadow pass is *already* isolated — `WebGLShadowMap.getDepthMaterial` renders casters with three's internal `_depthMaterial`/`_distanceMaterial` and copies only a fixed property allowlist (`DEPTH_PASS_COPY_KEYS`), never `onBeforeCompile`/`customProgramCacheKey`/`userData`/`emissive*`/`roughness`. The only real risk is an integrator assigning a VFX color variant as `object.customDepthMaterial` — `assertNoVfxDepthLeak(object)` guards that. **`materials.js` seam — ✅ APPLIED** (`:1858`): the clone is stamped `__vfxColorPassOnly:true` (inert to rendering; the variant only exists when `?visual` triggers a frag attach). No GLSL `#ifdef` needed — the separation is structural.

---

## 3. EMISSIVE COMPONENTS — glint, magicGlow, enchantShimmer (slices 05–07)

All three: `family:"emissive"` (FAMILY_ORDER 3, runs after weathering), `mech:"frag"`, `cacheKeyScope:"set"`, `linkVariant():""`, `deterministic:true`, `lightCountDelta:0`, `writes:["materialUniform"]`. Channels are **distinct** (`glint`/`glow`/`emissive`) so they compose additively. Seam = after `#include <emissivemap_fragment>` (first point where `metalnessFactor`, `normal`, and `totalEmissiveRadiance` are all live). On-disk files are the source of truth; the substantive code:

### 3.1 `emissive.glint` (slice 05) — `scene3d/vfx/components/glint.js`
Manifest: `id:"emissive.glint"`, `channel:"glint"`, `reads:["clock","instanceHash","surface"]`, `defaults:{strength:0.4, metalBias:0.9}`. View+time specular sparkle on metal, folded into `totalEmissiveRadiance`. GLSL (array-joined, backtick-free) injected after the emissive seam:
```glsl
#include <emissivemap_fragment>
  // ---- VFX_GLINT_BEGIN (emissive.glint) ----
  {
    float _gMetal = clamp(mix(metalnessFactor, 1.0, uGlintMetalBias), 0.0, 1.0);
    if (_gMetal > 0.001 && uGlintStrength > 0.0) {
      vec3 _Vg = normalize(vViewPosition);
      vec3 _Ng = normalize(normal);
      float _ndv = clamp(dot(_Ng, _Vg), 0.0, 1.0);
      float _ph = uTime * 0.6 + (vVfxHash) * 6.2831853;
      vec3 _Lg = normalize(vec3(sin(_ph) * 0.75, 0.6, cos(_ph) * 0.75));
      float _ndh = clamp(dot(_Ng, normalize(_Lg + _Vg)), 0.0, 1.0);
      float _lobe = pow(_ndh, 48.0);
      float _spark = 0.5 + 0.5 * sin(_ph * 3.7 + _ndv * 12.0 + (vVfxHash) * 17.0);
      totalEmissiveRadiance += vec3(_gMetal * uGlintStrength * _lobe * _spark);
    }
  }
  // ---- VFX_GLINT_END ----
```
`uTime`/`uGlintStrength`/`uGlintMetalBias` declared once (guarded) before `void main()`; `vVfxHash` probed at inject, `0.0` fallback if absent. `declareUniforms` binds `uTime` **by reference** from `globals.uTime`. `metalBias` is the classifier's treat-as-metal confidence (AC weapons decode to `metalness≈0`). Test: `test_vfx_glint.mjs` 27/27.

### 3.2 `emissive.magicGlow` (slice 06) — `scene3d/vfx/components/magicGlow.js`
Manifest: `id:"emissive.magicGlow"`, `channel:"glow"`, `reads:["surface"]` (no clock — constant ambient), `defaults:{glow:0.6}`, clamp `(0, 2.0]`. Pushes palette-decoded albedo into emissive:
```glsl
#include <common>
uniform float uGlow;
// ...
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uGlow;
```
Reuses the `applyFloatLumDiffuse` accumulator → 0 VRAM, palette-correct (lands after `<map_fragment>`). Feeds bloom for free (≤2.0 clears the 0.85 HDR threshold). Test: `test_vfx_magicglow.mjs` 22/22.

### 3.3 `emissive.enchantShimmer` (slice 07) — `scene3d/vfx/components/enchantShimmer.js`
Manifest: `id:"emissive.enchantShimmer"`, `channel:"emissive"`, `reads:["clock","instanceHash"]`, `defaults:{amp:0.35, freq:2.2}` (amp clamped `[0,0.95]` so `1+amp·sin>0`). Pulses the whole emissive output:
```glsl
#include <emissivemap_fragment>
totalEmissiveRadiance *= (1.0 + uEnchantAmp * sin(uTime * uEnchantFreq + vVfxHash * 6.2831853));
```
Sorts before `magicGlow` → its multiply runs *after* glow's add (the whole emissive breathes). `uTime` by reference; `vVfxHash` fallback `0.0`. Accepts `strength`/`speed` aliases. Test: `test_vfx_enchantshimmer.mjs` 21/21.

> **Per-component node tests + manifests** are all on disk and green; legacy-safety Layer-B (`test_vfx_legacy_safety.mjs`, dir-scan of `components/*`) already covers all three. Layer-A registration is wired via the barrel (§10).

---

## 4. WEATHERING COMPONENTS — tarnish, wetness, frost (slices 08–10)

All: `family:"weathering"` (FAMILY_ORDER 2, runs **after** deformation/texture, **before** emissive), `mech:"frag"`, `cacheKeyScope:"set"`, `deterministic:true`, `lightCountDelta:0`. **POST-palette ordering is the binding rule:** diffuse edits land after `#include <map_fragment>` (post SubPalette decode) so they modify resolved `diffuseColor.rgb`; roughness edits land after `#include <roughnessmap_fragment>` (where `roughnessFactor` first exists).

### 4.1 `weathering.tarnish` (slice 08) — `scene3d/vfx/components/tarnish.js`
Manifest: `id:"weathering.tarnish"`, `channel:"tarnish"`, `reads:["setup","instanceHash"]`, `writes:["materialUniform"]`, `linkVariant(config){ return config&&config.blotchMap ? "blotch" : ""; }` (one optional low-cardinality structural bit). Two seams: diffuse tint after `<map_fragment>` (with a function-scoped `_vfxTarnishT` accumulator, crevice term = luminance-weighted), roughness bump after `<roughnessmap_fragment>`. Per-object age from `hash01(setupDid^instanceHash)` × global `uTarnishAge`; **shine-restore = tween `uTarnishAge → 0`** (pure uniform animation, `mix(...,0)==identity`). `_tTop` up-facing patina is **queued-for-1070** (inert `#ifdef VFX_WORLD_NORMAL`; uses wetness's varying when wired). Test: `test_vfx_tarnish.mjs` 31/31.

### 4.2 `weathering.wetness` (slice 09) — `scene3d/vfx/components/wetness.js`
Manifest: `id:"weathering.wetness"`, `channel:"wetness"` → **rename to `"precip"`** (adjudication 4), `reads:["weather","geometry"]`, `defaults:{strength:1.0, darken:0.62, roughDrop:0.25}`. **OWNS the shared world-normal varying** (`ensureWorldNormalVarying`, `VFX_WORLD_NORMAL_VARYING="vVfxWorldNormal"`, exported `wetness.js:42-70`) — derived from view-space `transformedNormal` via stock `inverseTransformDirection(dir, viewMatrix)`, per-instance correct, idempotent (tarnish/frost import it later, never duplicate). GLSL:
```glsl
#include <map_fragment>
float _vfxWetUp = smoothstep( 0.05, 0.6, vVfxWorldNormal.y );          // up-faces wet, walls dry
float _vfxWetAmt = clamp( uWetness * uWetStrength, 0.0, 1.0 ) * _vfxWetUp;
diffuseColor.rgb *= mix( 1.0, uWetDarken, _vfxWetAmt );
// ...
#include <roughnessmap_fragment>
roughnessFactor *= mix( 1.0, uWetRoughDrop, _vfxWetAmt );
```
`uWetness=0` ⇒ both `mix(...,0)=1.0` ⇒ byte-identical when off. `uWetness` bound by reference from `VFX_GLOBALS`. Test: `test_vfx_wetness.mjs` 25/25.

### 4.3 `weathering.frost` (slice 10) — `scene3d/vfx/components/frost.js`
Manifest: `id:"weathering.frost"`, `channel:"surfaceWeather"` → **rename to `"precip"`** (adjudication 4), `reads:["clock","weather","geometry"]`, `defaults:{lighten:0.6, desat:0.5, sparkle:0.25, sparkleScale:48.0, sparkleSpeed:2.5}`. Lighten+desaturate toward icy white-blue + UV micro-sparkle, after `<map_fragment>`:
```glsl
{
  float _frost = clamp(uFrost, 0.0, 1.0) * (1.0 - clamp(uWetness, 0.0, 1.0));   // belt-and-suspenders mutual-excl
  if (_frost > 0.0001) {
    vec3 _base = diffuseColor.rgb;
    float _lum = dot(_base, vec3(0.2126, 0.7152, 0.0722));
    vec3 _icy = vec3(0.82, 0.90, 1.0);
    vec3 _f = mix(_base, vec3(_lum), uFrostDesat);
    _f = mix(_f, _icy, uFrostLighten);
    #ifdef USE_UV
      vec2 _cell = floor(vMapUv * uFrostSparkleScale);
      float _h = fract(sin(dot(_cell, vec2(127.1, 311.7))) * 43758.5453123);
      float _tw = 0.5 + 0.5 * sin(uTime * uFrostSparkleSpeed + _h * 6.2831853);
      _f += smoothstep(0.90, 1.0, _h) * _tw * uFrostSparkle;
    #endif
    diffuseColor.rgb = mix(_base, _f, _frost);
  }
}
```
`uFrost`/`uWetness`/`uTime` bound by reference; `uFrost=0` (summer) ⇒ branch skipped. Mutual exclusion with wetness is enforced both in-shader (the `(1.0-uWetness)` factor) and upstream (weather_inputs drives only one above zero). Test: `test_vfx_frost.mjs` 22/22.

---

## 5. LIGHT / BLOOM (slice 11)

**Bloom decision: keep the existing GLOBAL screen-space bloom; add nothing.** The live pipeline already runs a pmndrs `BloomEffect` (`atmosphere_pipeline.js:292-300`, `luminanceThreshold 0.85`, `mipmapBlur:true`, toggle `?bloom`). The Phase-1 emissive effects write `totalEmissiveRadiance` in the HalfFloat HDR composer, so any pixel clearing 0.85 feeds bloom **for free** — no per-effect cost. The mip cost is fixed (~0.5 ms @ 1440p/1070), independent of emissive-object count: *"how many >threshold objects before mip cost bites" → it never does.* A selective/layer bloom would *add* a bright-pass RT + composite — strictly more expensive. magicGlow → soft halo; enchantShimmer → breathing halo; glint (strength 0.4) → sub-threshold sparkle.

**`light.flameFlicker`** — `scene3d/vfx/components/flameFlicker.js` (✅ on disk). `mech:"light"` (NO shader patch, NO program), `family:"emissive"` (valid bucket), `channel:"light"`, `cacheKeyScope:"none"`, `reads:["clock","instanceHash"]`, `writes:["lightIntensity"]`, `lightCountDelta:0`. The **intensity-only no-relink rule:** it multiplies the pooled point-slot `.intensity` by `flameFlickerMul(phase, t)` (deterministic flame waveform, bounded `[floor, 1+amp·1.28]`, strictly >0) and **never** touches `.visible`, the light array, or the per-type count — a count change would relink every `MeshStandardMaterial` (the spell-freeze the light pool exists to prevent). Driven by the post-pass `tickFlameFlicker(scene3d)` — **✅ wired at `loop.js:1749`**, after `tickLightingForCellState` (so pool slots are re-fed first). No-op (byte-identical) unless `?visual && ?flameFlicker && ?lightPool=on`. Per-light phase seeded once from `setupLightOrigin` (cached on userData). Warm-point classifier (`isFlameLight`) excludes white/cool/spot. Test: `test_vfx_flameflicker.mjs` 34/34. The `lightIntensity` write cap (`registry.js:33`, `lint_caps.js:33`) is **✅ applied**.

---

## 6. STATE — weather_inputs.js (slice 12)

`scene3d/vfx/weather_inputs.js` (✅ on disk) is the single owner of `uWetness`/`uFrost`/`uWindDir` (the oscillator owns `uTime`). Pure mappings + first-order lowpass smoothing, zero per-frame alloc:

- **`frostTarget(tempC, season)`** — full frost ≤ −8 °C, none ≥ 2 °C; winter season clamps a 0.35 floor.
- **`wetnessTarget(isStorm, frostT)`** — `isStorm ? (1 - frostT) : 0` → the **mutual exclusion** (cold storm = snow, handled by frost).
- **`writeWindVector(t, stormness, out)`** — ground-plane `(x,z)`; **`length()` encodes gust** (≈0.94–1.77), direction wanders ±12° about 135° (SE, matching `treeWindDir`). *Convention (binding): `VFX_GLOBALS.uWindDir` is a velocity vector, NOT a unit vector — distinct from `terrain.js`'s local unit `uWindDir`; consumers needing direction must `normalize()`.*
- **`tickWeatherInputs(nowSec, flagsOverride?)`** — snaps on first frame (`dt=Infinity`), lowpasses thereafter (`WET_TAU 3s / FROST_TAU 6s / STORM_TAU 4s`), clamps tab-resume spikes (`MAX_DT 0.25`). Writes the shared `{value}` objects **by reference** (never reassigns).

GLSL binding contract (consumers add in their own `declareUniforms`/`inject`):
```glsl
uniform float uWetness;   // [0,1] rain sheen
uniform float uFrost;     // [0,1] frost (mutually-excl with wet)
uniform vec2  uWindDir;   // ground-plane (x,z); length() = gust
```
**`weather_state.js` seam — ✅ APPLIED** (`readWeatherVfxInputs(out)` at `:261`, a 3-field zero-alloc accessor kept separate from `readWeatherFlags`'s 2-key contract). **`loop.js` tick — ✅ APPLIED** (`tickVfxWeatherInputs` wrapper `:887`, call `:1695`, right after the oscillator so they share `frameTime.tsSec`). Optional `configureWeatherInputs({windDirDeg})` hook for a future `?windDir` flag. Test: `test_vfx_weather_inputs.mjs` 30/30 (needs `three` resolvable, like `test_vfx_material_substrate.mjs`). VFX_GLOBALS already carries all four uniforms (`materials.js:316-322`).

---

## 7. INTEGRATION — descriptor config threading + the statics activation (slice 13, adjudicated)

This is **the activation** — the only change that makes any effect render. **None of it is on disk yet.** Adjudicated seam (per §0.1): `frag_attach.fragPlanForDid` selects + merges config (`defaults < shared < byId`, plus the per-effect `comp.enabled()` gate), `frag_install.buildFragVariant` (§2b EDIT 2) builds the firewall'd variant.

**EDIT A — `scene3d/vfx_catalog.js:40-45` router rows** (currently only windBend/tipFlex/glint/tarnish):
```js
export const COMPONENT_MECH = {
  "deformation.windBend": "A",
  "deformation.tipFlex": "B",
  "emissive.glint": "frag",
  "emissive.magicGlow": "frag",          // + slice 06
  "emissive.enchantShimmer": "frag",     // + slice 07
  "weathering.tarnish": "frag",
  "weathering.wetness": "frag",          // + slice 09
  "weathering.frost": "frag",            // + slice 10
};
```
(`frag_attach` selects by the live **registry** mech — authoritative — but keep this router table consistent for `descriptorMechs()`/diagnostics.)

**EDIT B — `scene3d/statics.js` imports** (extend `:77`, add after `:96`):
```js
// :77
import { MaterialCache, materialCanCastShadow, VFX_GLOBALS, installVfxComponentPatch } from "./materials.js";
// after :96 (next to the existing vfx_catalog import)
import { fragPlanForDid } from "./vfx/frag_attach.js";
import { buildFragVariant } from "./vfx/frag_install.js";
import { ensureVfxHashVarying } from "./vfx/per_instance.js";
```

**EDIT C — `scene3d/statics.js` module-level helper** (near the imports / `getOrCreateMaterialCache`):
```js
// VFX frag variant (?visual). frag_attach selects + merges per the descriptor;
// frag_install builds the per-SET cloned variant (one program per SET, firewall).
// Off / no frag plan ⇒ base material ⇒ byte-identical. The vVfxHash prelude (slice
// 03) runs FIRST in the chain so component injects that read it see it declared.
const VFX_HASH_PRELUDE = { id: "infra.vfxHash", inject: (s) => ensureVfxHashVarying(s) };
const VFX_FRAG_DEPS = { globals: VFX_GLOBALS, installComponentPatch: installVfxComponentPatch, sharedPrelude: VFX_HASH_PRELUDE };
function _fragMat(base, materialCache, surfaceDid, fragPlan) {
  if (!fragPlan) return base;
  return buildFragVariant(materialCache, surfaceDid, fragPlan.entries, VFX_FRAG_DEPS) || base;
}
```

**EDIT D — Seam 1, per-LB singleton baker (`statics.js:1729-1730`).** Compute the plan once per placement (`placement.modelId` in scope at `:1724`); `const`→`let`:
```js
    const fragPlan = visualEnabled() ? fragPlanForDid(placement.modelId) : null;
    for (const g of groups) {
      let mat = _fragMat(materialCache.getCached(g.surfaceDid), materialCache, g.surfaceDid, fragPlan);
```

**EDIT E — Seam 2, ring instanced/singleton baker (`statics.js:2324-2325`).** One swap covers both `isInstanced` and singleton (`modelId` in scope); `const`→`let`:
```js
    const fragPlan = visualEnabled() ? fragPlanForDid(modelId) : null;
    for (const sg of surfaceGroups) {
      let mat = _fragMat(materialCache.getCached(sg.surfaceDid), materialCache, sg.surfaceDid, fragPlan);
      const staticsMatCastsShadow = materialCanCastShadow(mat);
```

**EDIT F — `?staticBatch` fusion re-key (`consolidateStaticSingletons`, `statics.js:1449-1490`).** Today it groups by `surfaceDid` (`:1454`) and takes `group[0].material` (`:1464`). With `?visual`, two DIDs sharing a surfaceDid but different frag SETs would fuse and inherit one SET's material. Re-key by **material identity** (same `(surfaceDid|setKey|configKey)` ⇒ same object via getCachedVariant dedup; off ⇒ same shared base per surfaceDid ⇒ identical grouping ⇒ byte-identical):
```js
// :1454  — key by the material object, not the surfaceDid
      const key = n.material;
// :1462  — iterate values (key is now an object)
  for (const group of bySurf.values()) {
// :1488-1490 — read surf from the group
    const surf = (group[0].userData.surfaceDid >>> 0);
    const lbId = group[0].userData.landblockId;
    bm.userData = { landblockId: lbId, surfaceDid: surf, __staticBatch: true };
```

**Coexistence with the windBend MECH-A peel:** the peel (`statics.js` ~`:1598`/`:2122`) removes `hasWindBend` DIDs into the wind player *before* these loops, so seams D/E only see non-windBend (rigid-glint) frag DIDs. A DID carrying **both** MECH-A and frag is **queued-for-1070** (the wind-player build path, `animated_scenery.js:459`, would call `fragPlanForDid`/`buildFragVariant` the same way) — intentionally out of the hot frozen loop for Phase 1. Test: `test_vfx_frag_attach.mjs` 18/18, `test_vfx_frag_install.mjs` 27/27.

---

## 8. FLAGS + DOCS (slice 14)

`scene3d/vfx_flags.js` (✅ on disk) — the single import point for the 7 effect gates. Imports only `visualEnabled` (no cycle). `vfxEffectEnabled(componentId)` = `visualEnabled() && <per-effect reader>` (master off ⇒ always false — the firewall). Readers: `glintEnabled / magicGlowEnabled / enchantShimmerEnabled / tarnishEnabled / wetnessEnabled / frostEnabled / flameFlickerEnabled`, all default-OFF; `visualAllEffects()` (`?visual=all`/`?visualAll=on`); `visualBudget()` (governor STUB, default ∞); `VFX_EFFECT_FLAGS`, `vfxActiveEffectIds()`. Test: `test_vfx_flags.mjs` 39/39. *(To wire the per-effect gate into selection, give each frag component an `enabled = () => vfxEffectEnabled(id)` — `frag_attach.js:88` already honors `comp.enabled()`. Queued: import `vfx_flags` into each component or attach `enabled` at registration.)*

**`docs/url-flags.md` — two insertions (MISSING).** (A) Append the family rows after the last §2 render-flags row (anchor on the `rigModule` row, not the line number — it drifts):
```markdown
| `visual` | `on`/`all`/`off` | **off** | **NON-RETAIL** Visual-Behavior Suite master gate. `on` enables the descriptor-catalog VFX path; per-effect flags below pick WHICH effects run (each ALSO default-off, gated on BOTH). `=all` lights everything (opt out per effect). OFF ⇒ byte-identical. Pending 1070 eye-test. | scene3d/vfx_catalog.js + scene3d/statics.js |
| `glint` | `on` | off | **NON-RETAIL** emissive.glint — view+time specular sparkle on metal. Requires `?visual`. Pending 1070. | scene3d/vfx_flags.js + scene3d/vfx/components/glint.js |
| `magicGlow` | `on` | off | **NON-RETAIL** emissive.magicGlow — ambient self-glow on magic items (bloom halo free if `?bloom`). Requires `?visual`. Pending 1070. | …/components/magicGlow.js |
| `enchantShimmer` | `on` | off | **NON-RETAIL** emissive.enchantShimmer — per-instance pulsing emissive on enchanted gear. Requires `?visual`. Pending 1070. | …/components/enchantShimmer.js |
| `tarnish` | `on` | off | **NON-RETAIL** weathering.tarnish — patina + crevice darkening, per-instance age (hash; NEVER server wear; post-palette). Requires `?visual`. Pending 1070. | …/components/tarnish.js |
| `wetness` | `on` | off | **NON-RETAIL** weathering.wetness — global rain sheen (up-faces darker+glossier; `uWetness`). Requires `?visual`. Mutually exclusive with `?frost`. Pending 1070. | …/components/wetness.js |
| `frost` | `on` | off | **NON-RETAIL** weathering.frost — winter lighten/desaturate + micro-sparkle (`uFrost`). Requires `?visual`. Mutually exclusive with `?wetness`. Pending 1070. | …/components/frost.js |
| `flameFlicker` | `on` | off | **NON-RETAIL** light.flameFlicker — torch/brazier `.intensity` jitter (NEVER `.visible`/count — no-relink, lightCountDelta 0). Requires `?visual` + `?lightPool=on`. Pending 1070. | …/components/flameFlicker.js |
| `visualAll` | `on` | off | **NON-RETAIL** alias of `?visual=all`: default every per-effect flag ON (still gated by `?visual`; opt out per effect). Pending 1070. | scene3d/vfx_flags.js |
| `visualBudget` | int 0–4096 | ∞ | **NON-RETAIL** governor STUB (Phase 1): parsed+memoized, nothing consumes it yet (queued-for-1070). | scene3d/vfx_flags.js |
```
(B) Append to the **"Still opt-in (default-off) on purpose"** paragraph: one sentence naming the suite (master `visual`, the Phase-1 effects, `visualAll`, `visualBudget`) as NON-RETAIL / Pending-1070 / byte-identical until opted in. **default-off-on-purpose** because the visual eye-test runs only on the 1070.

---

## 9. GAUGE + COST MODEL + 1070 EYE-TEST (slice 15) — ✅ APPLIED

`cost_model.jsonl` (5 new rows, all placement-independent/cheap) + `CommandEngine.Vfx.cs` (G4 gate + `dLightsPerDriver` axis) + `TerminalRepl.cs:3019` + `JsonCommandProcessor.cs:1154` — **already applied & built (0 errors), gauge `STRUCTURAL-PASS`, headroom 100%, G4 green.** The rows (glint + tarnish shipped in Phase 0):
```jsonl
{"id":"emissive.magicGlow","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag", …}
{"id":"emissive.enchantShimmer","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag", …}
{"id":"weathering.wetness","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag", …}
{"id":"weathering.frost","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag", …}
{"id":"light.flameFlicker","costClass":"cheap","dProgramsPerDriver":0,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"none","mech":"light", …}
```
G4 = `lightsDelta == 0` (mirrors the JS `lightCountDelta==0`). Test: `test_vfx_cost_model.mjs` 62/62. Holtburg ref unperturbed (resolves only to `trunk-canopy`×6 + `rigid`×21; no Phase-1 archetype). **Cost ids MUST match registered component ids** — the gauge faults `"missing cost rows"` loudly on a mismatch.

**Batched 1070 eye-test checklist** — one sitting; prereq `?visual=on` + per-effect flag. **PASS = effect visible · `=off` byte-identical · no perf regression vs `?visual=off` · `vfx gauge` STRUCTURAL-PASS.** Capture A/B per row.

| # | Effect (flag) | Where | Expect |
|---|---|---|---|
| 1 | glint (`&glint=on`) | sword/axe/mace, sweep camera | view+time sparkle on metal only |
| 2 | tarnish (`&tarnish=on`) | metal weapons/fittings | patina + per-object age variation; post-palette (no double-decode) |
| 3 | magicGlow (`&magicGlow=on`, +`?bloom`) | magic item | ambient self-glow; free bloom halo |
| 4 | enchantShimmer (`&enchantShimmer=on`) | enchanted gear, ~3 s | breathing pulse, **de-phased** across copies |
| 5 | wetness (`&wetness=on`, `?rain=on`) | storm: roofs/ground/crates | up-faces darker+glossier, walls dry |
| 6 | frost (`&frost=on`) | winter/cold zone | lighten+desaturate+sparkle; **never co-wet** |
| 7 | flameFlicker (`&flameFlicker=on`, `?lightPool=on`) | torch/brazier, ~5 s | intensity jitter, **zero toggle freeze** (proves no relink) |

**All 7 + Holtburg steady-state:** GPU < 75% (design §5.2), fps unregressed, 0 console errors, `vfx gauge --ref holtburg` STRUCTURAL-PASS (program count O(component-SETs), `lightsDelta==0`). The **Timing Meter (G5–G7) is 1070-only** — this sitting *is* that meter (CI = SwiftShader = STRUCTURAL-PASS only).

---

## 10. LEGACY-SAFETY AUDIT (slice 16)

Every Phase-1 component vs `lint_caps.js` (`reads ⊆ ALLOWED_READS`, `writes ⊆ ALLOWED_WRITES`, `deterministic:true`, `lightCountDelta:0`, `cacheKeyScope ∈ {set,none}`, source clean against `FORBIDDEN_SOURCE`):

| Component | family/mech | channel | reads | writes | cacheKeyScope | linkVariant | verdict |
|---|---|---|---|---|---|---|---|
| `deformation.windBend` | deformation/A | transform | geometry,instanceHash,clock,weather | partTransform | none | `""` | ✅ shipped |
| `emissive.glint` | emissive/frag | glint | clock,instanceHash,surface | materialUniform | set | `""` | ✅ |
| `emissive.magicGlow` | emissive/frag | glow | surface | materialUniform | set | `""` | ✅ |
| `emissive.enchantShimmer` | emissive/frag | emissive | clock,instanceHash | materialUniform | set | `""` | ✅ |
| `weathering.tarnish` | weathering/frag | tarnish | setup,instanceHash | materialUniform | set | `""`/`"blotch"` | ✅ |
| `weathering.wetness` | weathering/frag | **precip** | weather,geometry | materialUniform | set | `""` | ✅ |
| `weathering.frost` | weathering/frag | **precip** | clock,weather,geometry | materialUniform | set | `""` | ✅ |
| `light.flameFlicker` | emissive/light | light | clock,instanceHash | **lightIntensity** | none | `""` | ✅ (cap applied) |

All manifests legal; all sources lint-clean (verified by each component's node test + `test_vfx_legacy_safety.mjs` Layer-B dir-scan, which already globs `components/*` → 17/17). Findings: **F1 `lightIntensity` cap — already applied** (registry/lint_caps `:33`). **F2 wetness/frost share channel — apply the `precip` rename** (adjudication 4). **F3 firewall — `linkVariant` returns `""` for all continuous scalars** (only tarnish's optional `blotchMap` returns a structural bit) ✅. **F4 — no `Math.random`/argless `Date.now`/wire/collision; per-instance via `vVfxHash`/`hash01`** ✅.

**Barrel (MISSING) — `scene3d/vfx/components/index.js`:**
```js
export { windBend } from "./windBend.js";              // deformation (Phase 0)
export { tarnish } from "./tarnish.js";                // weathering
export { wetness } from "./wetness.js";                // weathering
export { frost } from "./frost.js";                    // weathering
export { glint } from "./glint.js";                    // emissive
export { magicGlow } from "./magicGlow.js";            // emissive
export { enchantShimmer } from "./enchantShimmer.js";  // emissive
export { flameFlicker } from "./flameFlicker.js";      // emissive / mech light
export const TIER1_COMPONENT_IDS = Object.freeze([
  "deformation.windBend","weathering.tarnish","weathering.wetness","weathering.frost",
  "emissive.glint","emissive.magicGlow","emissive.enchantShimmer","light.flameFlicker",
]);
```
**`test_vfx_legacy_safety.mjs` (MISSING edit)** — replace the windBend-only import with `import { TIER1_COMPONENT_IDS } from "./scene3d/vfx/components/index.js"; import { allComponents, getComponent } from "./scene3d/vfx/registry.js";` and assert the registry equals the TIER1 set (no missing, no stray) + the F1 negatives (`lightIntensity` allowed AND `lightCountDelta!=0` still rejected AND `.visible=` still flagged).

**`harness/run-js-headless.mjs` TIER1 (MISSING rows)** — currently `:95-99` (windbend, material_substrate, catalog, legacy_safety, shadow_pass). Add (one commit, slice 16):
```js
  { flag: "vfxOscillators(JS)", file: "test_vfx_oscillators.mjs" },
  { flag: "vfxPerInstanceHash(JS)", file: "test_vfx_per_instance_hash.mjs" },
  { flag: "vfxFragInstall(JS)", file: "test_vfx_frag_install.mjs" },
  { flag: "vfxFragAttach(JS)", file: "test_vfx_frag_attach.mjs" },
  { flag: "vfxGlint(JS)", file: "test_vfx_glint.mjs" },
  { flag: "vfxMagicGlow(JS)", file: "test_vfx_magicglow.mjs" },
  { flag: "vfxEnchantShimmer(JS)", file: "test_vfx_enchantshimmer.mjs" },
  { flag: "vfxTarnish(JS)", file: "test_vfx_tarnish.mjs" },
  { flag: "vfxWetness(JS)", file: "test_vfx_wetness.mjs" },
  { flag: "vfxFrost(JS)", file: "test_vfx_frost.mjs" },
  { flag: "vfxFlameFlicker(JS)", file: "test_vfx_flameflicker.mjs" },
  { flag: "vfxWeatherInputs(JS)", file: "test_vfx_weather_inputs.mjs" },
  { flag: "vfxFlags(JS)", file: "test_vfx_flags.mjs" },
  { flag: "vfxCostModel(JS)", file: "test_vfx_cost_model.mjs" },
  { flag: "vfxFirewall(JS)", file: "test_vfx_firewall.mjs" },     // slice-16 new
```
*(`test_vfx_weather_inputs.mjs` needs `three` resolvable — same bucket as `test_vfx_material_substrate.mjs`.)*

---

## 11. THE ORDERED COMMIT LIST (the loop's work-list)

Continues Phase-0 `commit 5` (`ce0d991b`). Each step: files · test · verification. **Off-state proof at every step is the dormancy invariant** (shared uniforms rest at 0; no statics swap until step 14). Steps marked ✅ are already on disk — just `git add` + commit; steps with **(apply)** need the edits in this kit.

| # | Commit | Files | Test | Verify |
|---|---|---|---|---|
| P1.1 | `feat(vfx): oscillator registry + per-frame tick` | `oscillators.js` ✅, `loop.js` seam ✅ | `test_vfx_oscillators.mjs` 31/31 | tick writes only `{value}`; no consumer → identical · gauge STRUCTURAL-PASS |
| P1.2 | `feat(vfx): frag-install path + componentSetKey + buildFragVariant + installVfxComponentPatch` | `frag_install.js` ✅ **+buildFragVariant (apply §2b)**, `materials.js` **+installVfxComponentPatch (apply §2b)** | `test_vfx_frag_install.mjs` 27/27 | no call site yet → identical · `node --check` clean |
| P1.3 | `feat(vfx): per-instance vVfxHash varying` | `per_instance.js` ✅ | `test_vfx_per_instance_hash.mjs` 24/24 | unused until an inject runs → identical |
| P1.4 | `feat(vfx): shadow/depth-pass exclusion guard` | `shadow_guard.js` ✅, `materials.js` stamp ✅ | `test_vfx_shadow_pass.mjs` 20/20 | no patch installed → identical |
| P1.5 | `feat(vfx): per-effect flag readers + ?visualBudget stub` | `vfx_flags.js` ✅ | `test_vfx_flags.mjs` 39/39 | readers false → identical |
| P1.6 | `feat(vfx): emissive.glint` | `components/glint.js` ✅ | `test_vfx_glint.mjs` 27/27 | registered, unattached → identical |
| P1.7 | `feat(vfx): emissive.magicGlow` | `components/magicGlow.js` ✅ | `test_vfx_magicglow.mjs` 22/22 | " |
| P1.8 | `feat(vfx): emissive.enchantShimmer` | `components/enchantShimmer.js` ✅ | `test_vfx_enchantshimmer.mjs` 21/21 | " |
| P1.9 | `feat(vfx): weathering.tarnish` | `components/tarnish.js` ✅ | `test_vfx_tarnish.mjs` 31/31 | " |
| P1.10 | `feat(vfx): weathering.wetness (+ shared world-normal varying)` | `components/wetness.js` ✅ **(rename channel→precip)** | `test_vfx_wetness.mjs` 25/25 | reads `uWetness=0` → identical |
| P1.11 | `feat(vfx): weathering.frost` | `components/frost.js` ✅ **(rename channel→precip)** | `test_vfx_frost.mjs` 22/22 | reads `uFrost=0` → identical |
| P1.12 | `feat(vfx): weather inputs → uWetness/uFrost/uWindDir` | `weather_inputs.js` ✅, `weather_state.js` ✅, `loop.js` seam ✅ | `test_vfx_weather_inputs.mjs` 30/30 | drives uniforms, effects unattached → identical |
| P1.13 | `feat(vfx): light.flameFlicker + bloom strategy` | `components/flameFlicker.js` ✅, `registry.js`/`lint_caps.js` cap ✅, `loop.js` tick ✅ | `test_vfx_flameflicker.mjs` 34/34 | no-op unless `?flameFlicker` → identical |
| P1.14 | `feat(vfx): config-threading — statics frag attach (ACTIVATION)` | `frag_attach.js` ✅, `statics.js` **(apply §7 D/E/F)**, `vfx_catalog.js` **(apply §7 A)** | `test_vfx_frag_attach.mjs` 18/18 | gated `?visual && fragPlan && perEffectFlag`; off → byte-identical |
| P1.15 | `feat(vfx): cost-model rows + gauge G4` | `cost_model.jsonl` ✅, 3 `.cs` ✅ | `test_vfx_cost_model.mjs` 62/62 | offline tool · `dotnet build` 0 errors · gauge STRUCTURAL-PASS |
| P1.16 | `feat(vfx): component barrel + firewall test + TIER1 harness + legacy-safety + url-flags docs` | `components/index.js` **(apply §10)**, `test_vfx_firewall.mjs` **(new)**, `run-js-headless.mjs` **(apply §10)**, `test_vfx_legacy_safety.mjs` **(apply §10)**, `docs/url-flags.md` **(apply §8)** | `test_vfx_firewall.mjs` + full TIER1 suite green | tests + docs only |

**Per-commit gate (every step):** the new test green · `test_vfx_legacy_safety.mjs` green · Phase-0 regression (`windbend`/`catalog`/`material_substrate`) green · `vfx gauge --ref holtburg` STRUCTURAL-PASS · default-off byte-identical.

**Audited reorders (2, both justified):** (1) `vfx_flags.js` lands at **P1.5** (config-threading P1.14 gates on it), not last; only the url-flags.md *docs* stay in P1.16. (2) `frag_install` lands the **function** (P1.2); the live `statics.js` swap is owned solely by **config-threading (P1.14)** — so no two slices touch `statics.js:1730/:2325`.

**`test_vfx_firewall.mjs` (new, P1.16)** — proves `setKey`/`buildFragVariant` is config-invariant, instance-invariant, order-stable (program count = O(SETs)):
```js
import { componentSetKey } from "./scene3d/vfx/frag_install.js";
import "./scene3d/vfx/components/index.js";
import { getComponent } from "./scene3d/vfx/registry.js";
const glint = getComponent("emissive.glint"), tarnish = getComponent("weathering.tarnish");
check("config-INVARIANT", componentSetKey([glint],{strength:0.2}) === componentSetKey([glint],{strength:0.9}));
check("order-STABLE", componentSetKey([tarnish,glint],{}) === componentSetKey([glint,tarnish],{}));
check("distinct SET → distinct key", componentSetKey([glint],{}) !== componentSetKey([glint,tarnish],{}));
const k = componentSetKey([glint,tarnish],{aVfxHash:0.7,guid:0xdeadbeef,instanceHash:0x1234});
check("NO per-instance token in key", !/dead|beef|0\.7|aVfxHash|instanceHash|0x1234/i.test(k), k);
```

---

## 12. RISKS + queued-for-1070 + open questions

**Risks / integration cautions:**
- **R1 — `statics.js` is the single highest-risk edit (P1.14).** Five hunks (B–F) on a hot, concurrently-evolving file. The byte-identical guarantee rests on `fragPlan` being `null` whenever `?visual` is off; review the off-path explicitly. The `const`→`let` at two sites is trivial but real.
- **R2 — EDIT F (`?staticBatch` re-key) must land with the swap.** Without it, `?visual + ?staticBatch` (staticBatch is ALWAYS-ON by default) fuses different SETs and applies one DID's frag set to same-surfaceDid neighbors. Byte-identical when `?visual` off (shared base per surfaceDid).
- **R3 — `buildFragVariant` is the adjudicated bridge, not in any slice as shipped.** It's the one symbol `frag_attach`/`statics` reference that didn't exist; verify P1.2 adds it before P1.14.
- **R4 — gauge is static (Half-A).** It reads `cost_model.jsonl`, not live programs — a mis-authored `linkVariant` returning a scalar would pass the gauge but explode live. `test_vfx_firewall.mjs` + the 1070 `?renderDiag` flat-program-count walk are the real backstops.
- **R5 — `vVfxHash` from `batchingMatrix` vs `instanceMatrix`.** The `#ifdef USE_BATCHING/USE_INSTANCING` ladder is in `per_instance.js` ✅; singletons get a constant-per-node hash (acceptable, 1-of-1).
- **R6 — `sin()` precision drift over long sessions** (enchantShimmer/glint/frost) as `uTime` grows. Mitigation belongs to the oscillator tick wrapping `uTime` (e.g. `mod 3600`) — flagged for slice 01, not fixable per-component.

**Queued-for-1070 (the visual eye-test + the gauge Timing Meter):**
- The entire **batched eye-test (§9)** is 1070-only (CI = SwiftShader = STRUCTURAL-PASS only). The Timing Meter (G5–G7) requires the 1070.
- tarnish up-facing patina (`_tTop`) + frost up-bias — wire the shared world-normal varying (import from `wetness.js`), inert until then.
- A DID carrying **both MECH-A windBend + frag** → `fragPlanForDid`/`buildFragVariant` on the wind-player path (`animated_scenery.js:459`).
- MECH-B `tipFlex` joining `PATCH_MECHS` so vertex + frag compose under one program.
- Default-ON flip per effect after the eye-test; `?visualBudget` governor enforcement.
- Gauge refinement: sum by distinct component-SET (collapse `componentSetKey`) instead of per-driver (current is a conservative upper bound).

**Open questions for the laptop dev:**
1. **Channel rename to `precip`** (wetness+frost): apply now (forward-looking, zero runtime effect since the §14 resolver isn't wired), or defer until the resolver lands? Recommend **apply now** — it's a one-token edit and prevents a latent double-darken if the resolver lands without re-checking.
2. **Per-effect flag wiring into selection:** `frag_attach` honors `comp.enabled()` but no component sets it yet. Add `enabled: () => vfxEffectEnabled(id)` to each frag component (pulls `vfx_flags` into the component graph), or gate inside `_fragMat`? Recommend the per-component `enabled` hook — it keeps the gate co-located and `frag_attach` already supports it.
3. **Which DIDs get which archetype** — the descriptor catalog (`visual_descriptors.jsonl`) content is the classifier's job and orthogonal to this bundle; Phase 1 is integration-ready with an empty/partial catalog (byte-identical), and the eye-test needs at least the rigid-glint + magic-item + weatherable + torch archetypes populated.

---

**Bottom line:** the 15 effect/infra slices are on disk and green; the kit's load-bearing additions are the **`installVfxComponentPatch` export, the `buildFragVariant` bridge, and the `statics.js` activation (§2b + §7)** — without those, nothing renders; with them gated behind `?visual` + per-effect flags, every step is byte-identical when off and the gauge stays STRUCTURAL-PASS. Integrate effect-by-effect down §11; the only edits needing real review are P1.2 (materials/frag_install) and P1.14 (statics).
