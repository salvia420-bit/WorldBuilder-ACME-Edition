GLSL is well-formed and compiles into the right seam. Everything passes. Here is my ready-to-integrate deliverable.

---

## Goal

`emissive.glint` — a view + time-varying specular **sparkle on metal** (rigid-glint archetype: swords/daggers/axes/maces, design doc §2.3 "Sword" row). A cheap fragment patch that folds a metal-gated, view-swept, per-instance-phased highlight into `totalEmissiveRadiance`. Default-OFF behind `?visual`+`?glint`; byte-identical when off; **0 new programs beyond the component-SET**, 0 draw calls, 0 VRAM, no light slot.

Seam decision (verified against the bundled three `ShaderLib.physical.fragmentShader`): I inject **after `#include <emissivemap_fragment>`** rather than `<roughnessmap_fragment>`, because that is the *first* point where `metalnessFactor` (metalnessmap_fragment @2639), the shading `normal` (normal_fragment_begin @2673) **and** `totalEmissiveRadiance` are all live in `main()` scope (emissivemap @2827, before lights @2897). This keeps glint in the emissive family (`FAMILY_ORDER.emissive=3`, runs after weathering's diffuse edit), matches the canonical emissive seam, matches the existing `cost_model.jsonl` row ("drives `totalEmissiveRadiance` from the existing surface… Spends the FRAGMENT budget, not a light slot"), and lets bloom pick it up for free — though at default `strength 0.4` it stays sub-bloom-threshold (sparkle, not glow; magicGlow is the bloom feeder).

## Files

**NEW — `external/holtburger/apps/holtburger-web/scene3d/vfx/components/glint.js`** (full contents, written & passing):

```js
// emissive.glint — view + time-varying specular sparkle on metal (Visual-
// Behavior Suite, Phase 1, 2026-06-23). The rigid-glint archetype's signature
// effect (swords / daggers / axes / maces, design doc §2.3 row "Sword").
//
// MECH-frag: a fragment patch on a CLONED, cache-owned material (materials.js
// getCachedVariant), composed onto the single _chainBeforeCompile chain in
// FAMILY_ORDER (emissive = 3, so glint runs AFTER any weathering diffuse edit).
// The snippet lands right after `#include <emissivemap_fragment>` — the first
// seam where metalnessFactor (metalnessmap_fragment), the shading `normal`
// (normal_fragment_begin) AND totalEmissiveRadiance are all resolved — and folds
// a metal-gated, view-swept, per-instance-phased sparkle into
// totalEmissiveRadiance. No new sampler, no light slot, no draw call.
//
// THE FIREWALL: strength / metalBias flow ONLY through uniforms; per-instance
// phase rides the `vVfxHash` varying (per-instance-age infra) — NEVER a per-
// instance customProgramCacheKey. One program per component-SET (linkVariant
// "" — glint's GLSL string is config-independent), never one per DID.
//
// THE RULE: reads the client clock (uTime), a derived per-instance hash, and the
// surface's metalness; writes ONLY a cloned-material shader output. Touches no
// wire value, no physics/collision, no replicated field; deterministic (uTime +
// hash, no Math.random); no light-count change.

import { registerComponent } from "../registry.js";

const GLINT_SEAM = "#include <emissivemap_fragment>";
const GLINT_MARKER = "VFX_GLINT_BEGIN";

function _glintSnippet(hashExpr) {
  return [
    GLINT_SEAM,
    "  // ---- " + GLINT_MARKER + " (emissive.glint) ----",
    "  // Metal-gated, view + time specular sparkle -> totalEmissiveRadiance.",
    "  {",
    "    float _gMetal = clamp(mix(metalnessFactor, 1.0, uGlintMetalBias), 0.0, 1.0);",
    "    if (_gMetal > 0.001 && uGlintStrength > 0.0) {",
    "      vec3 _Vg = normalize(vViewPosition);",
    "      vec3 _Ng = normalize(normal);",
    "      float _ndv = clamp(dot(_Ng, _Vg), 0.0, 1.0);",
    "      float _ph = uTime * 0.6 + (" + hashExpr + ") * 6.2831853;",
    "      vec3 _Lg = normalize(vec3(sin(_ph) * 0.75, 0.6, cos(_ph) * 0.75));",
    "      float _ndh = clamp(dot(_Ng, normalize(_Lg + _Vg)), 0.0, 1.0);",
    "      float _lobe = pow(_ndh, 48.0);",
    "      float _spark = 0.5 + 0.5 * sin(_ph * 3.7 + _ndv * 12.0 + (" + hashExpr + ") * 17.0);",
    "      totalEmissiveRadiance += vec3(_gMetal * uGlintStrength * _lobe * _spark);",
    "    }",
    "  }",
    "  // ---- VFX_GLINT_END ----",
  ].join("\n");
}

function _ensureUniformDecl(fragmentShader, decl) {
  return fragmentShader.indexOf(decl) === -1
    ? fragmentShader.replace("void main() {", decl + "\nvoid main() {")
    : fragmentShader;
}

export const glint = {
  id: "emissive.glint",
  family: "emissive",
  mech: "frag",
  channel: "glint",
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  reads: ["clock", "instanceHash", "surface"],
  writes: ["materialUniform"],
  defaults: { strength: 0.4, metalBias: 0.9 },

  declareUniforms(shader, config, globals) {
    const cfg = { ...glint.defaults, ...(config || {}) };
    const g = globals || {};
    shader.uniforms = shader.uniforms || {};
    shader.uniforms.uTime = g.uTime || shader.uniforms.uTime || { value: 0 };
    shader.uniforms.uGlintStrength = { value: cfg.strength };
    shader.uniforms.uGlintMetalBias = { value: cfg.metalBias };
  },

  inject(shader) {
    let fs = shader.fragmentShader || "";
    if (fs.indexOf(GLINT_MARKER) !== -1) return;   // already patched (recompile)
    if (fs.indexOf(GLINT_SEAM) === -1) return;     // non-standard material — inert
    fs = _ensureUniformDecl(fs, "uniform float uTime;");
    fs = _ensureUniformDecl(fs, "uniform float uGlintStrength;");
    fs = _ensureUniformDecl(fs, "uniform float uGlintMetalBias;");
    const hashExpr = /\bvVfxHash\b/.test(fs) ? "vVfxHash" : "0.0";
    shader.fragmentShader = fs.replace(GLINT_SEAM, _glintSnippet(hashExpr));
  },
};

registerComponent(glint);
export default glint;
```

*(Full JSDoc on `declareUniforms`/`inject` is in the on-disk file; trimmed here for brevity.)*

**NEW — `external/holtburger/apps/holtburger-web/test_vfx_glint.mjs`** — see `## Test` below.

**No edits to shared files are required from this slice.** The component is self-contained and consumed by sibling infra slices. The two non-owned touchpoints (already present in the substrate, listed here so the integrator can confirm wiring):

- `scene3d/vfx_catalog.js:43` already maps `"emissive.glint": "frag"` in `COMPONENT_MECH` — no change.
- `WorldBuilder.Terminal/VfxData/cost_model.jsonl` already carries the `emissive.glint` cheap/frag row (Phase 0) — matches this implementation; no change. (Slice 15 owns confirming the five axes.)

## GLSL

Snippet as it lands after `#include <emissivemap_fragment>` (with `vVfxHash` present; `(0.0)` substitutes when the per-instance-age varying is absent). Backtick-free — built via a `[...].join("\n")` array, not a template literal, precisely to avoid the "backtick-in-GLSL-comment closes the JS literal" trap:

```glsl
#include <emissivemap_fragment>
  // ---- VFX_GLINT_BEGIN (emissive.glint) ----
  // Metal-gated, view + time specular sparkle -> totalEmissiveRadiance.
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

Plus three guarded `uniform float …;` declarations spliced before `void main() {` (uTime is guarded so it's declared **once** when several emissive/weathering components share a SET — otherwise a GLSL redeclaration error).

**Why it sparkles:** `_Lg` is a synthetic key-light that sweeps in view-space (the `sin/cos(_ph)` orbit) so the half-vector highlight slides across the blade as time and per-instance phase advance — no real scene light needed (robust on any lit/unlit material). `pow(_ndh, 48.0)` makes a tight glint lobe; `_spark` adds a fine animated twinkle. **Metal gate:** `mix(metalnessFactor, 1.0, uGlintMetalBias)` — `metalBias` is the classifier's "treat-as-metal" confidence (0.9 for swords), so glint shows on AC weapons even though their decoded materials carry `metalness≈0`; lower `metalBias` falls back to honoring genuine PBR `metalnessFactor`.

## Manifest (passes `lint_caps`)

| field | value |
|---|---|
| `id` | `emissive.glint` |
| `family` | `emissive` (FAMILY_ORDER 3 — after weathering) |
| `mech` | `frag` |
| `channel` | `glint` (§14 conflict unit; additive into `totalEmissiveRadiance`, coexists with magicGlow/enchantShimmer) |
| `linkVariant(config)` | `""` — GLSL is config-independent → no extra link bits → **one program per SET** |
| `cacheKeyScope` | `"set"` |
| `deterministic` | `true` (uTime + hash; **no Math.random / Date.now**) |
| `lightCountDelta` | `0` |
| `reads` | `["clock","instanceHash","surface"]` ⊆ ALLOWED_READS |
| `writes` | `["materialUniform"]` ⊆ ALLOWED_WRITES |
| `defaults` | `{ strength: 0.4, metalBias: 0.9 }` (matches descriptor example design doc §2.1) |

`validateComponent`, `lintManifest`, and `lintSource(glint.js)` are all clean (verified by the test + the existing `test_vfx_legacy_safety.mjs`, which already scans `scene3d/vfx/components/*` and stays green with glint.js present).

## Test

**`test_vfx_glint.mjs`** (node `check()`/`process.exit` style, mirroring `test_vfx_windbend.mjs`) — **27/27 passing**. Covers: registration + `validateComponent`; manifest fields; `lintManifest` + `lintSource` clean; `declareUniforms` binds **uTime by reference** (a later `sharedTime.value=42` is seen through the binding — proves the single-clock contract) and routes strength/metalBias through uniforms; `inject` shape (folds into `totalEmissiveRadiance`, lands after `<emissivemap_fragment>` and before `<lights_fragment_begin>`, metal gate present); `vVfxHash` phase source with the `0.0` fallback when absent; uniform decls present + **uTime declared once** even if a prior SET component declared it; **fragment-only** edit (vertex untouched → depth/shadow pass unaffected); recompile-safe (no double-patch); inert/byte-identical on a non-standard material with no seam; and a **no-backtick** assertion. Run: `node test_vfx_glint.mjs`.

## Integration notes

- **Composition on the chain:** glint is installed by the frag-install builder (slice 02) inside one `_chainBeforeCompile` closure per `getCachedVariant(surfaceDid, setKey, configKey, builder)` clone. Builder order = `FAMILY_ORDER`, so weathering (diffuse, after `<map_fragment>`) runs first, then glint (emissive, after `<emissivemap_fragment>`) — disjoint seams, no interaction. `__vfxSetKey` is set on `userData` *before* the builder runs, and `_patchSetCacheKey` appends `"|v"+__vfxSetKey` → **all same-SET sword materials collapse onto one compiled program**.
- **Per-instance phase:** rides `vVfxHash` (the varying from slice 03 per-instance-age). glint detects it at inject-time via a string probe and substitutes `vVfxHash`, else `0.0` (in-sync fallback) — so glint compiles standalone *and* gets free per-sword phase offset once slice 03 lands. No attribute or program is added by glint itself.
- **Shared clock:** `uTime` is bound by reference from `VFX_GLOBALS.uTime`, driven once/frame by the oscillator tick (slice 01). glint has **no `tick`** — it's purely a shader read. O(1), placement-independent.
- **Shadow/depth pass:** glint only edits `shader.fragmentShader` of the standard color material; the depth/`customDepthMaterial` is separate and unpatched (slice 04's mechanism). Glint surfaces still *receive* shadows; they just don't write the color patch into the depth pass.
- **Bloom (slice 11):** at `strength 0.4` glint peaks sub-threshold → a sparkle, not a bloom source (cost-model `bloomTier sub`). If bloom is on it contributes a faint halo for free; raising `strength` past the bloom threshold via descriptor config would make blades bloom — left to the eye-test.
- **Gauge cost row** (already in `cost_model.jsonl`, matches this impl): `{"id":"emissive.glint","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dAluClass":"low","mech":"frag"}` — +1 program **per component-SET driver** (not per DID), 0 calls, 0 VRAM, low frag ALU (a handful of sin/cos/pow). Placement-independent → `vfx gauge` structural-pass.
- **`?flag`:** glint is reached only when `?visual` (vfx_catalog `visualEnabled()`, default-OFF) **and** the per-effect `?glint` flag (slice 14, default-OFF). Glint never auto-attaches; the descriptor's `componentIds` must carry `emissive.glint` (rigid-glint archetype) — slice 13 threads `config.{strength,metalBias}` into `declareUniforms`.
- **Queued-for-1070:** descriptor coverage (which DIDs get rigid-glint) and default-ON flip after the batched eye-test; both NON-RETAIL / Pending-1070 (slices 14/15). The component itself is integration-ready now.
- **TIER1 registration (slice 16):** add `import "./scene3d/vfx/components/glint.js";` to `test_vfx_legacy_safety.mjs`'s import block so Layer A (manifest conformance) covers glint's *registered* manifest, not just its source (Layer B already scans the file). The audit harness should also add `test_vfx_glint.mjs` to its TIER1 list.

## Risks

- **`metalBias` semantics are a design choice, not retail metalness.** `mix(metalnessFactor, 1.0, uGlintMetalBias)` means a high `metalBias` overrides genuine PBR metalness — intended (AC materials lack authored metalness), but a non-metal DID mis-classified into rigid-glint will still sparkle. Mitigation: the gate *also* respects real `metalnessFactor` when `metalBias` is low; classifier confidence (design doc) should set `metalBias` accordingly. Eye-test catches mis-classifications.
- **`normal`/`vViewPosition`/`metalnessFactor` names are three-internal.** A three.js upgrade that renames a chunk variable would break the snippet — but the same dependency already underpins every shipped `materials.js` patch (detail/CSM/lightClamp), and `inject` no-ops cleanly if the `<emissivemap_fragment>` seam is absent, so the failure mode is "no glint", never a crash or a broken non-glint material.
- **SET-key correctness depends on slice 02/03 not leaking per-instance data into `setKey`.** glint upholds its half (linkVariant `""`, hash via varying), but if a sibling slice baked a per-instance scalar into the program string the firewall would break SET-wide. Slice 16's gauge program-count check after enabling glint is the backstop (expect program count ≈ #distinct SETs, not #DIDs).
- **Fallback phase (`0.0`) syncs all swords** until slice 03 lands — every blade glints in lockstep. Cosmetic only; resolves automatically once `vVfxHash` is declared.
