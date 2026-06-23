Both green from the correct cwd: **frost 22/22, legacy-safety 17/17** (the harness globs `components/*` and now scans `frost.js` clean). The earlier failure was just a dropped `cd` between shell calls.

Here is the ready-to-integrate deliverable for my slice.

---

## Goal

`weathering.frost` — a **cheap fragment** weathering component that rimes the world in a winter zone: lighten + desaturate the decoded diffuse toward an icy white-blue plus a sparse, clock-twinkled **micro-sparkle**, driven by the single shared global `VFX_GLOBALS.uFrost` (season/temp, produced by `weather_inputs.js`, slice 12). Injected after `#include <map_fragment>` (post palette decode). **Mutually exclusive with rain wetness.** Default-OFF behind `?visual`+`?frost`; byte-identical render when not attached; **+1 program per component-SET, 0 draw calls, 0 VRAM.**

Substrate anchors verified: seam = the shipped detail patch (`scene3d/materials.js:445-453`); globals = `materials.js:316-322`; clone+firewall = `getCachedVariant` `materials.js:1845-1860` feeding `__vfxSetKey` into `_patchSetCacheKey` `materials.js:262-278`; contract+`FAMILY_ORDER` = `scene3d/vfx/registry.js:9-25`; caps = `scene3d/vfx/lint_caps.js:15-33`; router = `scene3d/vfx_catalog.js:40-45`. Design intent: `docs/visual-behavior-suite-design-2026-06-23.md:157` (frost) + `:313` (post-palette compose-order).

## Files

**NEW — `external/holtburger/apps/holtburger-web/scene3d/vfx/components/frost.js`** (full contents, on disk, tested):

```js
// weathering.frost — winter-zone frost/ice wash (Phase 1, 2026-06-23).
//
// A CHEAP fragment weathering component (family "weathering", mech "frag"). It
// lightens + desaturates the decoded diffuse toward an icy white-blue and adds a
// sparse, time-twinkled micro-sparkle, driven entirely by the shared global
// VFX_GLOBALS.uFrost (a season/temperature drive produced by weather_inputs.js,
// slice 12) — so the whole world rimes up in a winter zone with ONE uniform.
//
// THE RULE: reads only the client clock + derived weather state + a geometry UV;
// writes ONLY the cloned material's diffuseColor (a render-time material uniform
// path). No wire, no physics/collision, no replicated field; deterministic (a
// GLSL hash, never Math.random); no light-count change; the program key varies by
// component-SET, never per-instance (the firewall).
//
// COMPOSITION (spec §2.3): injected after `#include <map_fragment>` — i.e. POST
// palette/diffuse decode (see [[reference_chorizite_render_semantics]]: palette =
// SubPalette shift folded into the diffuse sample, so a weathering tint MUST land
// after it or it would wash the pre-decode texels). Same seam the shipped detail
// patch uses (materials.js:445). Family order weathering(2) runs after
// deformation/texture and before emissive on the single _chainBeforeCompile chain.
//
// MUTUAL EXCLUSION with rain wetness (design doc line 157): a surface is never
// both rained-on AND rimed. Primary enforcement is weather_inputs (slice 12),
// which only ever drives ONE of uFrost / uWetness above zero. This component adds
// a belt-and-suspenders in-shader gate `uFrost * (1.0 - uWetness)`, so even a
// transitional frame where both are momentarily nonzero degrades gracefully
// (wetness wins) rather than double-applying.

import { registerComponent } from "../registry.js";

// The fragment block appended right after `#include <map_fragment>`. Operates on
// `diffuseColor.rgb` (already palette-decoded). The whole effect is scaled by
// `_frost` at the end, so at uFrost==0 it is an exact no-op -> byte-identical to
// the unfrosted variant (and ?frost OFF never builds this variant at all). No
// backticks anywhere in here (they would close the JS template literal).
const FROST_FS = `
{
  // uFrost: global winter drive (weather_inputs, slice 12). Mutually exclusive
  // with rain wetness -> any active uWetness suppresses frost.
  float _frost = clamp(uFrost, 0.0, 1.0) * (1.0 - clamp(uWetness, 0.0, 1.0));
  if (_frost > 0.0001) {
    vec3 _base = diffuseColor.rgb;
    float _lum = dot(_base, vec3(0.2126, 0.7152, 0.0722));
    vec3 _icy = vec3(0.82, 0.90, 1.0);            // cold white-blue rime tint
    vec3 _f = mix(_base, vec3(_lum), uFrostDesat); // desaturate toward luma
    _f = mix(_f, _icy, uFrostLighten);             // lighten/tint toward ice
    #ifdef USE_UV
      // micro-sparkle: a sparse high-frequency hash over the surface UV,
      // twinkled by the shared clock so a few specks glint each frame
      // (deterministic value hash; no Math.random).
      vec2 _cell = floor(vMapUv * uFrostSparkleScale);
      float _h = fract(sin(dot(_cell, vec2(127.1, 311.7))) * 43758.5453123);
      float _tw = 0.5 + 0.5 * sin(uTime * uFrostSparkleSpeed + _h * 6.2831853);
      float _spark = smoothstep(0.90, 1.0, _h) * _tw;
      _f += _spark * uFrostSparkle;
    #endif
    diffuseColor.rgb = mix(_base, _f, _frost);
  }
}`;

export const frost = {
  id: "weathering.frost",
  family: "weathering",
  mech: "frag",
  // §14 conflict unit. SHARED with weathering.wetness so the resolver lets at
  // most ONE of {wetness, frost} into a component-SET (the "single diffuse-wash
  // owner" the cost-model row asserts). Distinct from tarnish's channel, so a
  // tarnished blade can still frost over. Belt-and-suspenders: the shader also
  // gates frost by (1 - uWetness) (see FROST_FS) — correctness holds even before
  // the resolver is wired. weathering.wetness MUST declare this same channel
  // (reconcile in slice 16 if it differs).
  channel: "surfaceWeather",
  // The GLSL is identical for every config (all knobs flow as uniforms), so this
  // component contributes the SAME link bits regardless of placement/config ->
  // the program count stays O(component-sets), never per-DID (the firewall).
  linkVariant() { return ""; },
  cacheKeyScope: "set", // a frag patch changes the program; keyed by the SET, never per-instance
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads the client clock + derived weather
  // (season/temp) + a geometry UV for the sparkle; writes ONLY the cloned
  // material's diffuse uniform path. Never the wire/physics/collision/replicated.
  reads: ["clock", "weather", "geometry"],
  writes: ["materialUniform"],
  defaults: {
    lighten: 0.6,        // mix toward icy white-blue at uFrost=1
    desat: 0.5,          // desaturate strength
    sparkle: 0.25,       // micro-sparkle brightness add
    sparkleScale: 48.0,  // UV multiplier -> speck density
    sparkleSpeed: 2.5,   // twinkle rate (× uTime)
  },

  /**
   * Bind uniforms onto a compiling shader. Shared globals (uTime/uFrost/uWetness)
   * are assigned BY REFERENCE from VFX_GLOBALS so the single per-frame VFX tick
   * (oscillator + weather_inputs) drives every frosted material at once. Per-config
   * scalars become their own {value} objects — config flows through uniforms,
   * NEVER the program cache key.
   * @param {{uniforms:object}} shader  the three.js onBeforeCompile shader
   * @param {object} config             per-DID config (merged over defaults)
   * @param {object} globals            VFX_GLOBALS (shared {value} objects)
   */
  declareUniforms(shader, config, globals) {
    const c = { ...frost.defaults, ...(config || {}) };
    const g = globals || {};
    // shared globals — bound by reference (one {value} per global, driven once/frame)
    if (g.uTime) shader.uniforms.uTime = g.uTime;
    if (g.uFrost) shader.uniforms.uFrost = g.uFrost;
    if (g.uWetness) shader.uniforms.uWetness = g.uWetness;
    // per-config scalars — uniforms only (never cache-key)
    shader.uniforms.uFrostLighten = { value: c.lighten };
    shader.uniforms.uFrostDesat = { value: c.desat };
    shader.uniforms.uFrostSparkle = { value: c.sparkle };
    shader.uniforms.uFrostSparkleScale = { value: c.sparkleScale };
    shader.uniforms.uFrostSparkleSpeed = { value: c.sparkleSpeed };
  },

  /**
   * Inject the frost GLSL into the fragment shader. Declares the uniforms (shared
   * globals guarded against a sibling weathering component having already declared
   * them) and appends FROST_FS right after `#include <map_fragment>`. Idempotent
   * within one shader compile. Only ever runs on the COLOR material clone — the
   * shadow/depth material is separate and unpatched (slice 04).
   * @param {{fragmentShader:string, __frostInjected?:boolean}} shader
   */
  inject(shader) {
    if (shader.__frostInjected) return;
    shader.__frostInjected = true;
    const fs = shader.fragmentShader;
    const decls =
      (fs.includes("uniform float uTime;") ? "" : "uniform float uTime;\n") +
      (fs.includes("uniform float uFrost;") ? "" : "uniform float uFrost;\n") +
      (fs.includes("uniform float uWetness;") ? "" : "uniform float uWetness;\n") +
      "uniform float uFrostLighten;\n" +
      "uniform float uFrostDesat;\n" +
      "uniform float uFrostSparkle;\n" +
      "uniform float uFrostSparkleScale;\n" +
      "uniform float uFrostSparkleSpeed;\n";
    shader.fragmentShader = fs
      .replace("void main() {", decls + "void main() {")
      .replace("#include <map_fragment>", "#include <map_fragment>" + FROST_FS);
  },
};

registerComponent(frost);
export default frost;
```

**EDIT (shared router) — `external/holtburger/apps/holtburger-web/scene3d/vfx_catalog.js:44`** — add the frost row to `COMPONENT_MECH` (this is slice 13/14's table; the one-line seam my component needs so the descriptor router resolves frost to the frag path):

```js
// at vfx_catalog.js:44, inside COMPONENT_MECH, after the "weathering.tarnish" line:
  "weathering.tarnish": "frag",
  "weathering.wetness": "frag",   // (slice 09)
  "weathering.frost": "frag",     // (this slice — winter-zone frost wash)
```

**EDIT (test harness registration) — `test_vfx_legacy_safety.mjs:12`** — import frost so its manifest is in `allComponents()` for Layer A and its source is in the `components/*` Layer-B scan (the dir-glob already picks up `frost.js`; the import makes the manifest assertion cover it too):

```js
// after the windBend import at line 12:
import { frost } from "./scene3d/vfx/components/frost.js"; // registers weathering.frost
```

## GLSL

Injected verbatim after `#include <map_fragment>` (post-palette; same seam as `materials.js:447`). Backtick-free; `USE_UV`-guarded so it is compile-safe on UV-less materials; the entire effect is gated `if (_frost > 0.0001)` and lerped by `_frost`, so `uFrost==0` ⇒ exact no-op:

```glsl
{
  float _frost = clamp(uFrost, 0.0, 1.0) * (1.0 - clamp(uWetness, 0.0, 1.0));
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
      float _spark = smoothstep(0.90, 1.0, _h) * _tw;
      _f += _spark * uFrostSparkle;
    #endif
    diffuseColor.rgb = mix(_base, _f, _frost);
  }
}
```

Uniform declarations (inserted before `void main()`, shared globals guarded against sibling re-declaration): `uTime, uFrost, uWetness` (shared, bound by reference) + `uFrostLighten, uFrostDesat, uFrostSparkle, uFrostSparkleScale, uFrostSparkleSpeed` (per-config).

## Manifest

Passes `registerComponent` (registry.js:62) and `lintManifest` (lint_caps.js:64):

| field | value | why legal |
|---|---|---|
| `reads` | `["clock","weather","geometry"]` | all ∈ `ALLOWED_READS`; `uTime`=clock, `uFrost/uWetness`=derived weather, `vMapUv`=geometry UV |
| `writes` | `["materialUniform"]` | ∈ `ALLOWED_WRITES`; only the **cloned** material's `diffuseColor` via uniforms |
| `deterministic` | `true` | GLSL value hash (`fract(sin(...))`), no `Math.random`/`Date.now` |
| `lightCountDelta` | `0` | touches no lights |
| `cacheKeyScope` | `"set"` | frag patch → program varies by SET, never per-instance |
| `linkVariant()` | `""` | identical GLSL for all configs → 1 program per SET (firewall) |
| `channel` | `"surfaceWeather"` | shared with wetness → §14 single-owner exclusion |

Source passes `lintSource` (no `wasmExports.*`, `*Collision*`, move APIs, `Math.random`, argless `Date.now`, `.visible=`, or per-instance `customProgramCacheKey`).

## Test

**NEW — `external/holtburger/apps/holtburger-web/test_vfx_frost.mjs`** (THREE-free, `check()`/`process.exit` style; **22/22 passing**). Asserts: registration; family/mech/channel; `validateComponent`/`lintManifest`/`lintSource` clean; reads⊆ALLOWED / writes⊆ALLOWED; `cacheKeyScope:"set"` + `lightCountDelta:0` + `deterministic`; **linkVariant `""` across configs** + **no `customProgramCacheKey` in source** (firewall); inject lands **after `<map_fragment>`** and **before `<roughnessmap_fragment>`**; uniforms declared before `void main()`; **mutual-exclusion `(1.0 - clamp(uWetness...)` gate present**; **off==identical** structure (`if (_frost > 0.0001)` + final `mix(_base,_f,_frost)`); USE_UV sparkle guard; vertex shader untouched; **inject idempotent**; **globals bound BY REFERENCE** + a `globals.uFrost.value` mutation drives the bound uniform; config flows through uniforms.

```
VFX weathering.frost component: 22 passed, 0 failed
VFX legacy-safety lint: 17 passed, 0 failed   (now also globs frost.js — clean)
```

Run: `cd external/holtburger/apps/holtburger-web && node test_vfx_frost.mjs && node test_vfx_legacy_safety.mjs`

## Integration notes

- **Chain composition** — `frag_install.js` (slice 02) builds the variant via `getCachedVariant(surfaceDid, setKey, configKey, builder)` (materials.js:1845). Inside the builder, each component composes one `_chainBeforeCompile` hook in `FAMILY_ORDER` (registry.js:25): `(shader) => { comp.declareUniforms(shader, config, VFX_GLOBALS); comp.inject(shader); }`. Frost (weathering=2) runs after deformation/texture, before emissive — so it sees the palette-decoded `diffuseColor` and its tint is itself visible to any later emissive read. `__vfxSetKey` (set BEFORE the builder, materials.js:1854) carries `weathering.frost|""` into `_patchSetCacheKey` (materials.js:277) → **one program per distinct SET**, never per-DID.
- **Firewall** — all per-config knobs are uniforms; `linkVariant()==""`; nothing per-instance touches the cache key. Frost on 10k winter trees that share a surfaceDid+set = **1 program, 1 material clone**.
- **Shadow/depth pass** — frost only ever patches the **color** clone from `getCachedVariant`; the `customDepthMaterial`/`MeshDepthMaterial` is separate and unpatched (slice 04). Frost still *receives* shadows; it just never writes the depth pass. No action needed here beyond not patching the depth material.
- **`?frost` flag** — frost is attached only when `visualEnabled()` (vfx_catalog.js:26) **and** the per-effect `?frost` reader (slice 14, `vfx_flags.js`, memoized like `tree_wind.js:45`) is on **and** the DID's descriptor carries `weathering.frost`. Default-OFF ⇒ no variant built ⇒ literal same program as today (byte-identical). Even when ON, `uFrost==0` (summer) ⇒ branch-skipped no-op.
- **Gauge cost row** — `WorldBuilder.Terminal/VfxData/cost_model.jsonl` **already has** a `weathering.frost` row: `costClass cheap, dProgramsPerDriver 1, dCallsPerInstance 0, dVramMB 0, dLightsPerDriver 0, dAluClass low` — placement-independent, matches this impl exactly. Only the prose ("weighted by world-normal.up") is forward-looking → see queued item. `vfx gauge` will structural-PASS unchanged.
- **Queued-for-1070** — (1) the **up-facing accumulation bias** (`_frost *= mix(1.0, upWeight, uFrostUpBias)`) once slice 09/16 lands a shared world-normal-up varying; cost axes are unchanged (still 1 prog/SET, 0 VRAM, low ALU), so the existing cost row stays valid. (2) `?frost` url-flags.md entry under the *default-off-on-purpose* section, marked **NON-RETAIL + Pending-1070** (slice 14). (3) per-DID frost config in the descriptor catalog (slice 13).
- **Eye-test (slice 15)** — `?visual=on&frost=on` in a winter zone (or force `VFX_GLOBALS.uFrost.value=1`): surfaces lighten/desaturate toward icy blue with subtle moving specks; `=off` byte-identical; rain zone shows **no** frost (wetness wins); no perf regression; gauge structural-pass.

## Risks

- **`<map_fragment>` anchor-sharing (LIFO order).** Frost, wetness (excluded with it anyway), and the legacy detail patch all `.replace("#include <map_fragment>", "...")` keeping the anchor, so the last hook to run inserts *closest* to the include — order among same-seam weathering writers is reverse-of-chain. Frost's write is a commutative `mix`, so this is visually harmless, but slice 02/16 should consider a single shared `injectAfterMapFragment(shader, block)` sentinel helper for strict ordering. Flagged for the integration audit.
- **`vMapUv`/`USE_UV` dependency.** Sparkle needs the diffuse UV varying. Guarded by `#ifdef USE_UV` so UV-less materials still compile (they just get lighten+desaturate, no sparkle). `frag_install` should prefer attaching frost to textured surfaces; the guard makes it safe regardless.
- **Channel-name reconciliation.** `surfaceWeather` must equal `weathering.wetness`'s channel for the §14 resolver to enforce single-ownership. Until the resolver exists, the in-shader `(1-uWetness)` gate guarantees correctness; slice 16 reconciles the literal name.
- **Transitional both-nonzero frame.** If weather_inputs ever crossfades uFrost↔uWetness with both briefly >0, the `(1-uWetness)` gate makes wetness dominate — graceful, never double-darkening.
- **Cost-row prose drift.** The committed row says "world-normal.up"; this Phase-1 impl is a uniform wash. Numerics are correct; recommend softening the row's note to "optionally weighted by world-normal.up (queued)" when the up-bias lands.
