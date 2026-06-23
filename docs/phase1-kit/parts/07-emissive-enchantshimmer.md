Both tests pass (21/21 and 17/17), and the gauge cost row for `emissive.enchantShimmer` already exists in `cost_model.jsonl` — my implementation matches it exactly. Here is the ready-to-integrate deliverable.

---

# emissive.enchantShimmer — Phase 1 implementation

## Goal
A cheap fragment-family emissive component (archetype #16, "enchant-shimmer/pulse") that makes enchanted/luminous gear *breathe*: it scales the emissive accumulator by a slow per-instance-phased sine at the canonical emissive seam.

```
totalEmissiveRadiance *= (1.0 + amp * sin(uTime * freq + vVfxHash * 2π))
```

`uTime` is the shared `VFX_GLOBALS.uTime` clock driven once/frame by the oscillator registry (slice 01); `vVfxHash` is the per-instance hash varying (slice 03) so a rack of identical items never blinks in lockstep. Default-OFF behind `?visual` + `?enchantShimmer`; byte-identical render when off (the catalog selects nothing → `getCachedVariant` is never called).

## Files

### NEW — `external/holtburger/apps/holtburger-web/scene3d/vfx/components/enchantShimmer.js`
Full contents (created + tested):

```js
// emissive.enchantShimmer — pulsing emissive shimmer on enchanted gear
// (Visual-Behavior Suite, Phase 1 / emissive bundle, 2026-06-23).
//
// Archetype #16 (enchant-shimmer/pulse). A CHEAP fragment-family component: it
// scales the emissive accumulator by a slow sine, so enchanted/luminous gear
// "breathes". The pulse is per-instance-phased so a rack of identical items does
// not blink in lockstep.
//
//   totalEmissiveRadiance *= (1.0 + amp * sin(uTime * freq + phase))
//   phase = vVfxHash * 2*PI          // per-instance, from slice 03's varying
//
// This is a MULTIPLY on the emissive accumulator, applied AFTER
// `#include <emissivemap_fragment>` (the canonical emissive seam, spec §2.3) — so
// it modulates whatever emissive base the material already has: the luminosity
// emissiveMap (materials.js applyFloatLumDiffuse) and/or an additive glow from
// emissive.magicGlow. On a material with NO emissive (totalEmissiveRadiance==0)
// it is a visible no-op — safe by construction; the classifier pairs this
// archetype with a glow base.
//
// THE RULE (legacy-safe): reads only the client clock (uTime, shared VFX global
// driven once/frame by the oscillator registry, slice 01) and a per-instance
// hash (vVfxHash varying, slice 03) — never the wire, physics, or a server-
// replicated field. Writes only CLONED-material uniforms (getCachedVariant
// clone). Deterministic (phase from a hash, never Math.random). No light-count
// change. Config scalars (amp/freq) flow through UNIFORMS, never the program-
// cache key — linkVariant() is "" so program count stays O(component-sets).
//
// Composition note (spec §2.3 / §14): every emissive seam edit inserts itself
// IMMEDIATELY after `#include <emissivemap_fragment>`. Because _chainBeforeCompile
// runs hooks in (FAMILY_ORDER, id) order and each prepends after the include, an
// id that sorts EARLIER ends up OUTERMOST in execution. "emissive.enchantShimmer"
// sorts before "emissive.magicGlow", so the shimmer multiply runs AFTER the glow
// add — the whole emissive output pulses, which is the intent.

import { registerComponent } from "../registry.js";

// 2*PI as a GLSL literal (per-instance phase spreads vVfxHash in [0,1) over a
// full cycle). Kept as a string constant so the GLSL below stays a pure literal.
const TAU = "6.2831853";

// Declare a fragment-shader line once (guards against a sibling emissive
// component, e.g. glint/magicGlow, having already declared the same uniform —
// a duplicate `uniform float uTime;` is a GLSL compile error). Idempotent.
function _declareFragOnce(shader, token, decl) {
  if (!shader.fragmentShader.includes(token)) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      "#include <common>\n" + decl,
    );
  }
}

export const enchantShimmer = {
  id: "emissive.enchantShimmer",
  family: "emissive",
  mech: "frag",
  channel: "emissive", // §14 conflict unit — stacks with other emissive writers
  // Config (amp/freq) is link-IRRELEVANT — it flows through uniforms, never the
  // program-cache key. So the SET key is unaffected by config → one program per
  // distinct component SET, never per-DID. (spec §2.4 firewall)
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads the client clock (uTime) + the
  // per-instance hash (vVfxHash); writes only cloned-material uniforms.
  reads: ["clock", "instanceHash"],
  writes: ["materialUniform"],
  // Classifier/config metadata. amp clamped to [0,0.95] at bind time so the
  // factor (1 + amp*sin) stays strictly positive (never a negative emissive).
  defaults: { amp: 0.35, freq: 2.2 },

  /**
   * Bind this component's uniforms onto a shader (called inside onBeforeCompile
   * by frag_install, slice 02). uTime is SHARED BY REFERENCE from VFX_GLOBALS so
   * the single per-frame oscillator tick drives every shimmering material at
   * once (O(1) — no per-instance work). amp/freq are per-SET config scalars.
   * @param {{uniforms:object}} shader  the three.js shader (onBeforeCompile arg)
   * @param {object} config             per-DID config from the descriptor
   * @param {{uTime:{value:number}}} globals  VFX_GLOBALS (shared {value} objects)
   */
  declareUniforms(shader, config, globals) {
    const cfg = config || {};
    // Accept the classifier's generic "strength"/"speed" aliases too.
    const amp = Number(cfg.amp ?? cfg.strength ?? this.defaults.amp);
    const freq = Number(cfg.freq ?? cfg.speed ?? this.defaults.freq);
    shader.uniforms = shader.uniforms || {};
    // SHARED clock — assigned by reference (NOT a copy) so the oscillator tick
    // mutating VFX_GLOBALS.uTime.value reaches this material with zero per-frame
    // work here. Falls back to a private {value} only if globals is absent.
    shader.uniforms.uTime = (globals && globals.uTime) || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uEnchantAmp = { value: Math.max(0, Math.min(0.95, isFinite(amp) ? amp : this.defaults.amp)) };
    shader.uniforms.uEnchantFreq = { value: isFinite(freq) ? freq : this.defaults.freq };
  },

  /**
   * Inject the emissive-pulse GLSL. Declares its uniforms (guarded) and the
   * multiply at the canonical emissive seam. If the shader carries no emissive
   * seam (e.g. a depth/shadow material — which slice 04 keeps unpatched anyway),
   * the seam replace is a no-op and nothing is emitted.
   * @param {{fragmentShader:string,vertexShader:string}} shader
   */
  inject(shader) {
    // uTime may already be declared by a sibling emissive component (glint /
    // magicGlow) on the same SET — declare each uniform at most once.
    _declareFragOnce(shader, "uniform float uTime;", "uniform float uTime;");
    _declareFragOnce(shader, "uniform float uEnchantAmp;", "uniform float uEnchantAmp;\nuniform float uEnchantFreq;");

    // Per-instance phase source: the shared varying from slice 03 (per-instance
    // -age) — declared by frag_install once for the whole SET. If it is absent
    // (component used standalone / in a unit test), fall back to a constant 0.0
    // so the patch still compiles (degrades to a synchronized global pulse).
    const phaseSrc = shader.fragmentShader.includes("vVfxHash")
      ? ""
      : "    float vVfxHash = 0.0;\n";

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n" +
        phaseSrc +
        "    totalEmissiveRadiance *= (1.0 + uEnchantAmp * sin(uTime * uEnchantFreq + vVfxHash * " + TAU + "));",
    );
  },
};

registerComponent(enchantShimmer);
export default enchantShimmer;
```

### EDIT — `external/holtburger/apps/holtburger-web/scene3d/vfx_catalog.js` (router)
Add the component → mechanism mapping so `descriptorMechs()` routes enchantShimmer DIDs to the frag-install path (slice 02). Anchor at **`vfx_catalog.js:43`** (inside `COMPONENT_MECH`):

```js
  "deformation.windBend": "A",
  "deformation.tipFlex": "B",
  "emissive.glint": "frag",
  "emissive.enchantShimmer": "frag",   // <-- INSERT this line (after :43)
  "weathering.tarnish": "frag",
```

### EDIT (coordinate w/ slice 16) — `external/holtburger/apps/holtburger-web/test_vfx_legacy_safety.mjs:12`
Layer B already auto-scans my file (it `readdirSync`s the components dir — confirmed passing). To also bring it under Layer A (registered-manifest conformance) in that harness, add the import beside the windBend one:

```js
import { windBend } from "./scene3d/vfx/components/windBend.js"; // registers it
import { enchantShimmer } from "./scene3d/vfx/components/enchantShimmer.js"; // registers it
```
(Left to slice 16's TIER1 registration block to avoid a merge race; not required for my own test.)

## GLSL
Two insertions into the **color-pass** MeshStandard fragment shader (composed via `_chainBeforeCompile`, FAMILY_ORDER=emissive(3)). Backtick-safe.

Guarded uniform declarations after `#include <common>` (added once per SET):
```glsl
uniform float uTime;        // shared VFX_GLOBALS clock, one tick/frame (oscillator, slice 01)
uniform float uEnchantAmp;  // per-SET config, clamped [0,0.95]
uniform float uEnchantFreq; // per-SET config (rad/s)
```

The pulse at the canonical emissive seam (after `#include <emissivemap_fragment>`):
```glsl
#include <emissivemap_fragment>
//  vVfxHash supplied by the shared per-instance varying (slice 03); fallback 0.0
totalEmissiveRadiance *= (1.0 + uEnchantAmp * sin(uTime * uEnchantFreq + vVfxHash * 6.2831853));
```

Because three.js folds `emissiveIntensity` into the `emissive` uniform (`uniforms.emissive = material.emissive × emissiveIntensity`) and `totalEmissiveRadiance` starts as `emissive`, scaling `totalEmissiveRadiance` is exactly `emissiveIntensity *= factor` — matching the spec formula without a per-material write.

## Manifest
Passes `validateComponent` + `lintManifest` + `lintSource` (verified):

| field | value | firewall rationale |
|---|---|---|
| `id` | `emissive.enchantShimmer` | |
| `family` / `mech` / `channel` | `emissive` / `frag` / `emissive` | emissive accumulator (FAMILY_ORDER 3) |
| `reads` | `["clock","instanceHash"]` | ⊆ ALLOWED_READS — clock→uTime, instanceHash→vVfxHash |
| `writes` | `["materialUniform"]` | ⊆ ALLOWED_WRITES — cloned-material uniform only |
| `deterministic` | `true` | phase from hash, no `Math.random` |
| `lightCountDelta` | `0` | no light touched → no relink/freeze |
| `cacheKeyScope` | `"set"` | contributes the id to the SET key; never per-instance |
| `linkVariant()` | `""` (for any config) | amp/freq ride uniforms → **0 extra programs**; program count ≈ distinct SETs |

## Test
`external/holtburger/apps/holtburger-web/test_vfx_enchantshimmer.mjs` — `check()`/`process.exit(1)` style, **21/21 passing**. Locks: registration, manifest (Layer A) + source (Layer B) clean, the firewall (`cacheKeyScope:"set"`, `linkVariant():""`), `uTime` bound **by reference** (oscillator tick reaches the material with zero per-frame work), amp clamp + classifier `strength`/`speed` aliases, the multiply at the canonical emissive seam, the **uniform-decl guard** (no duplicate `uniform float uTime;` when chained with a sibling emissive component), the standalone `vVfxHash` fallback, **no multiply on a depth/shadow shader** (color-pass only), and `1+amp*sin` staying strictly positive over a full sweep. (Full file written to disk; see test run output above.)

## Integration notes
- **Chain composition.** frag_install (slice 02) calls `declareUniforms(shader, config, VFX_GLOBALS)` then `inject(shader)` inside one `_chainBeforeCompile` hook, ordered by `FAMILY_ORDER` then id. Each emissive component prepends after `#include <emissivemap_fragment>`, so the earlier-sorting `emissive.enchantShimmer` lands **outermost** → its multiply runs *after* `emissive.magicGlow`'s add: the whole emissive output (base luminosity + glow) pulses. Verified-by-construction in the seam comment.
- **Oscillator dependency (slice 01).** `uTime` = `VFX_GLOBALS.uTime`, mutated once/frame by the oscillator registry's tick. The component does zero per-frame work — the shared `{value}` reference is the entire wiring. Per-instance phase is in-shader (`vVfxHash`), so it cannot be precomputed into a global uniform — `uTime` is the correct input, not a pre-mixed oscillator channel.
- **Per-instance hash (slice 03).** Reads the `vVfxHash` varying; if absent, degrades to a synchronized pulse (`float vVfxHash = 0.0`) rather than failing to compile. No `customProgramCacheKey` ever touched (firewall).
- **Shadow/depth (slice 04).** The patch only edits the color material clone from `getCachedVariant`; the depth/`customDepthMaterial` is separate + unpatched, and even if reached, it has no `<emissivemap_fragment>` seam → the multiply is omitted (tested).
- **Gauge cost row — already present**, matches this impl exactly: `WorldBuilder.Terminal/VfxData/cost_model.jsonl` → `{"id":"emissive.enchantShimmer","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dLightsPerDriver":0,"dAluClass":"low","mech":"frag"}`. **No change needed** (cite it in slice 15's structural-pass).
- **`?flag` (slice 14).** `?enchantShimmer` — default-OFF, gated under `?visual`. Defer the memoized reader + `docs/url-flags.md` row (NON-RETAIL, Pending-1070) to slice 14's flag module.
- **Queued-for-1070 (slice 15 eye-test).** PASS criteria: on an enchanted/luminous item, a gentle ~3 s breathing glow; identical items out of phase; `?enchantShimmer=off` byte-identical; no perf regression; gauge structural-pass.

## Risks
- **No-op on zero-emissive materials.** Multiplicative by design (spec-pure), so it only shows where emissive already exists (luminosity emissiveMap or `emissive.magicGlow`). The classifier must pair archetype #16 with a glow base; standalone it's a safe but invisible no-op. Documented in the header.
- **Fragment `sin()` precision drift.** Over a multi-hour session `uTime` (seconds) grows large; `sin()` of a big argument loses precision on mediump. Mitigation belongs to the oscillator tick (slice 01) wrapping `uTime` (e.g. `mod 3600`). Flagged for slice 01 — not fixable from the component.
- **Intra-family ordering coupling.** The "shimmer multiplies the glow" behavior relies on the insert-after-include + (FAMILY_ORDER, id) chaining convention. If a future emissive component uses a different anchor, ordering changes. Mitigation: the convention is documented in the header; if strict control is needed, frag_install can pin order explicitly.
- **Varying redeclaration.** Multiple emissive components reading `vVfxHash`/`uTime` rely on the `_declareFragOnce` guard (and slice 03 owning the varying decl). If a sibling declares with different whitespace than my `includes()` token, a duplicate could slip through — a shared `glsl_seams.js` `declareOnce()` helper (recommend slice 02 factor it out) would make this robust across all frag components.
