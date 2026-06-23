Both pass, and the existing `test_vfx_legacy_safety.mjs` (which directory-scans `scene3d/vfx/components/*`) already picks up `magicGlow.js` and stays green. Here's the complete deliverable.

---

## Goal

`emissive.magicGlow` — a **cheap, constant ambient self-glow** for magic items. It pushes the object's own palette-decoded albedo into the emissive accumulator so the item reads as faintly self-lit, and (if the bloom pass is on) throws a free halo. **0 new programs beyond the component-SET, 0 VRAM, 0 added draw calls, no clock read** (constant ambient — pulsing is `emissive.enchantShimmer`'s job, slice 07).

Design anchor: design doc line 178 — *"magic-glow ambient | cheap | emissiveMap=diffuse, intensity floor ≤2.0"*. I reuse the **same emissive accumulator** (`totalEmissiveRadiance`) that `applyFloatLumDiffuse` feeds (`materials.js:1256‑1266`), but source it from the live `diffuseColor` instead of attaching a second sampler — visually identical to `emissiveMap=diffuse`, but 0 VRAM and **palette-correct by construction** (the add lands *after* `#include <map_fragment>`, i.e. after the SubPalette shift — per the chorizite render semantics the prompt cites).

## Files

### NEW — `scene3d/vfx/components/magicGlow.js` (written, full contents)

```js
// emissive.magicGlow — ambient self-glow on magic items (Phase 1, 2026-06-23).
//
// FRAG family. A constant (un-animated) ambient glow that pushes the object's
// own decoded albedo into the emissive accumulator, so a magic item reads as
// faintly self-lit (and, if the bloom pass is on, throws a free halo). This is
// the "magic-glow ambient" row of the design doc (cheap; emissiveMap=diffuse,
// emissiveIntensity floor <=2.0).
//
// Reuse of the applyFloatLumDiffuse path (materials.js:1256): that decoder feeds
// the SAME emissive accumulator (totalEmissiveRadiance) by attaching the diffuse
// texture as emissiveMap. We feed that same accumulator, but source it from the
// live `diffuseColor` (the post-map, POST-palette-decode albedo) instead of
// uploading a second sampler — visually identical to emissiveMap=diffuse, but
// 0 VRAM, 0 new sampler, and palette-correct by construction (our add lands
// AFTER #include <map_fragment>, i.e. after the SubPalette shift). uGlow carries
// the per-descriptor intensity, clamped to (0, 2.0] to match the luminosity
// clamp the float decoder uses (materials.js:1264).
//
// Firewall: uGlow is a per-material CLONED uniform (config scalar -> uniform,
// NEVER into customProgramCacheKey). The GLSL is identical for every instance,
// so this component contributes only its presence to the component-SET key
// (linkVariant() === "") -> at most ONE extra program per material-SET, never
// per-DID. No clock read (ambient = constant); animation is enchantShimmer's job.

import { registerComponent } from "../registry.js";

// Single source of the default + clamp ceiling, referenced by both the manifest
// `defaults` metadata and declareUniforms (avoids a detached-`this` foot-gun).
const MAX_GLOW = 2.0; // emissiveIntensity floor cap (materials.js:1264 parity)
const DEFAULTS = { glow: 0.6 };

function clampGlow(g) {
  const n = Number.isFinite(g) ? g : DEFAULTS.glow;
  return Math.min(MAX_GLOW, Math.max(0, n));
}

export const magicGlow = {
  id: "emissive.magicGlow",
  family: "emissive",
  mech: "frag",
  channel: "glow", // distinct emissive channel (accumulates alongside glint/shimmer)
  // Frag GLSL is config-INVARIANT (uGlow is a uniform, not a #define), so this
  // component forks no program by config -> only its presence is in the SET key.
  linkVariant() { return ""; },
  cacheKeyScope: "set",
  deterministic: true,
  lightCountDelta: 0,
  // Legacy-safety manifest (spec §1.2): reads ONLY the surface diffuse (in-shader
  // diffuseColor); writes ONLY a cloned-material uniform + the render-time
  // emissive accumulator. Never the wire, physics/collision, or a replicated field.
  reads: ["surface"],
  writes: ["materialUniform"],
  defaults: DEFAULTS,

  /**
   * Add the per-material uGlow uniform to the cloned variant's shader.
   * Runs inside the variant's onBeforeCompile (frag_install chains it).
   * @param {{uniforms: object}} shader  the three.js shader being compiled
   * @param {{glow?: number}} [config]   per-descriptor config (intensity)
   */
  declareUniforms(shader, config) {
    shader.uniforms.uGlow = { value: clampGlow(config?.glow) };
  },

  /**
   * Inject the ambient-glow accumulate after the emissive map chunk.
   * Adds `totalEmissiveRadiance += diffuseColor.rgb * uGlow;` so the object's
   * own (palette-decoded) albedo becomes a faint self-illumination term.
   * No-op on a shader without the seam (e.g. a MeshBasic wire material) so the
   * patch can never orphan a uniform on the wrong program.
   * @param {{fragmentShader: string}} shader
   */
  inject(shader) {
    if (!shader || typeof shader.fragmentShader !== "string") return;
    if (!shader.fragmentShader.includes("#include <emissivemap_fragment>")) return;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uGlow;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        // POST-decode: diffuseColor is the resolved albedo (after map_fragment +
        // palette shift); totalEmissiveRadiance is the SAME accumulator the
        // luminous float-decode path feeds. Add, never replace.
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uGlow;",
      );
  },
};

registerComponent(magicGlow);
export default magicGlow;
```

### NEW — `test_vfx_magicglow.mjs` (written; see **Test** section)

### EDIT (shared) — `scene3d/vfx_catalog.js` — register the router mech

Anchor `COMPONENT_MECH` at **`vfx_catalog.js:40‑45`**; insert after the `weathering.tarnish` line (`:44`):

```js
  "emissive.glint": "frag",
  "emissive.magicGlow": "frag",   // <-- ADD (Phase 1, magicGlow)
  "weathering.tarnish": "frag",
```

This is the one line that makes `descriptorMechs()` (`vfx_catalog.js:127`) route a DID carrying `emissive.magicGlow` to the frag-install path (slice 02/13). It's the only shared-file edit my slice needs; coordinate with the other emissive-effect slices (05/07) since they touch the same table — they're additive, non-overlapping lines.

## GLSL

The frag-install builder (slice 02) calls `declareUniforms(shader, config)` then `inject(shader)` inside the cloned variant's chained `onBeforeCompile` (composed in `FAMILY_ORDER` → emissive = 3, after deformation/texture/weathering). The net patch:

**Fragment — after `#include <common>` (uniform decl):**
```glsl
#include <common>
uniform float uGlow;
```

**Fragment — after `#include <emissivemap_fragment>` (the accumulate):**
```glsl
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uGlow;
```

- `diffuseColor` is the resolved albedo (set by `#include <map_fragment>`, which runs earlier in `main()` and applies the palette decode) → glow tints in the item's own colour, post-palette.
- `totalEmissiveRadiance` is the identical accumulator the luminous float path drives; we **add**, so a surface that's *also* luminous still works (its emissive starts non-zero, we layer on top).
- Vertex shader is untouched — frag-only. No backticks anywhere in the GLSL/comments (the JS uses normal `"..."` string literals, not template literals, so the close-the-literal hazard doesn't even apply).

## Manifest

| field | value | why it passes `lint_caps` |
|---|---|---|
| `id` | `emissive.magicGlow` | — |
| `family` / `mech` / `channel` | `emissive` / `frag` / `glow` | family ∈ FAMILIES, mech ∈ MECHS; `glow` is a distinct channel so it **accumulates** alongside `glint`/`shimmer` rather than conflicting (§14 conflict unit) |
| `reads` | `["surface"]` | ⊆ `ALLOWED_READS` (`lint_caps.js:15`); reads only the surface diffuse in-shader. No clock (constant ambient) |
| `writes` | `["materialUniform"]` | ⊆ `ALLOWED_WRITES` (`lint_caps.js:28`); writes a cloned-material uniform + the render-time emissive accumulator only |
| `deterministic` | `true` | no `Math.random`/`Date.now` |
| `lightCountDelta` | `0` | no light added/removed (modulates emissive, not a light) |
| `cacheKeyScope` | `"set"` | frag GLSL forks the program → set-scoped (NOT `"instance"`); `linkVariant()===""` so config never enters the program key |

Verified: `validateComponent` (registry, `:62`) and `lintManifest` (lint_caps, `:64`) both return `[]`; `lintSource` over the file returns `[]`.

## Test

`test_vfx_magicglow.mjs` — `check()/process.exit(1)` style, **no `three` import** (asserts against a faked shader, exactly like `test_vfx_windbend.mjs`). **22 checks, all pass.** Covers: registration; `validateComponent`/`lintManifest` clean; manifest scalars (reads/writes/lightCountDelta/cacheKeyScope/deterministic); the firewall (`linkVariant()===""`); `declareUniforms` clamp to (0, 2.0] incl. NaN/missing→default; the GLSL seam (uniform declared, accumulate present, lands **after** both `<emissivemap_fragment>` and `<map_fragment>`, decl-before-use, vertex untouched); the no-seam no-op (no orphan uniform on a MeshBasic shader); Layer-B source clean + code-only firewall checks.

```
$ node test_vfx_magicglow.mjs
  [OK] registered as emissive.magicGlow
  ... (22 OK)
  ★ uGlow clamped to floor cap 2.0 (emissiveIntensity parity)
  ★ accumulate lands AFTER <emissivemap_fragment> (reads resolved diffuseColor)
  ★ accumulate is POST <map_fragment> (palette-decoded albedo)
VFX emissive.magicGlow component: 23 passed, 0 failed   # exit 0
$ node test_vfx_legacy_safety.mjs   # directory-scans components/* → magicGlow.js included
VFX legacy-safety lint: 17 passed, 0 failed             # exit 0
```

(The full file is written to disk; reproduced here is the structural shape — registration+manifest block, firewall `linkVariant`, `declareUniforms` clamp cases, `inject` GLSL-ordering asserts, no-seam no-op, Layer-B scan.)

## Integration notes

**How it composes on the chain.** Slice 02's `frag_install` resolves the material via `materials.js getCachedVariant(surfaceDid, setKey, configKey, builder)` (`:1845`). The builder iterates the DID's frag components in `FAMILY_ORDER` and, for each, runs `declareUniforms` + chains `inject` through `_chainBeforeCompile` (`materials.js:297`). `magicGlow` (emissive = order 3) chains after any deformation(0)/texture(1)/weathering(2) patches. All of them ride **one** `__vfxSetKey` (set before the builder, `:1854`) → `_patchSetCacheKey` (`:262`) appends `"|v"+setKey` (`:277`) → **one compiled program per distinct component SET**, never per DID. `uGlow` is per-material config; per-instance variation is N/A here (constant ambient).

**Firewall (the binding rule).** `linkVariant()===""` — config (`glow`) flows only through the cloned uniform, never into `customProgramCacheKey`. A magic sword carrying `{emissive.glint, emissive.magicGlow, weathering.tarnish}` compiles **one** program shared by every such sword; varying `glow` per descriptor reuses it.

**Shadow/depth pass (slice 04).** `magicGlow` never sets `customDepthMaterial`; the `onBeforeCompile` patch lands only on the color-pass `MeshStandardMaterial` clone. The depth/shadow material stays unpatched → emissive can't corrupt shadow casting. Objects still **receive** shadows normally.

**Bloom (slice 11).** With `uGlow` up to 2.0, `totalEmissiveRadiance` reaches ~2× albedo — above a typical bloom threshold, so a halo appears **for free** when the bloom pass is on, and there's a graceful no-bloom fallback (still reads as self-lit). magicGlow is one of the effects that **feeds** bloom (note for slice 11's threshold budget: distinct bloom-emitter count = magic-item placements, but cost is the bloom mip pass, not per-object).

**Gauge cost row (for slice 15 to add to `WorldBuilder.Terminal/VfxData/cost_model.jsonl`):**
```json
{"id":"emissive.magicGlow","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dAluClass":"none","mech":"frag","note":"Fragment after <emissivemap_fragment>; constant ambient totalEmissiveRadiance += diffuseColor.rgb * uGlow (single madd). Reuses the existing surface diffuse — NO emissiveMap upload, 0 VRAM, 0 new sampler. Folds into ONE link variant per material-SET (linkVariant()==='' -> config rides a uniform, never the program key); 0 added draw calls. Feeds bloom when on (halo free); no light slot consumed (§10.3). Placement-independent: cost = unique-SET count, not magic-item count."}
```

**`?flag` (for slice 14).** `?magicGlow` (default-OFF, NON-RETAIL, Pending-1070), gated behind `?visual`. The component is inert until the catalog descriptor lists `emissive.magicGlow` for a DID **and** `?visual` is on — byte-identical frozen render otherwise.

**For slice 16 (legacy-safety harness):** add `import { magicGlow } from "./scene3d/vfx/components/magicGlow.js";` to `test_vfx_legacy_safety.mjs` so Layer A (registered-manifest scan) also covers it — Layer B (directory source scan) already does. TIER1 registration alongside windBend.

**Queued for 1070:** the batched eye-test (slice 15) — confirm glow visible on magic items, `?magicGlow` off == identical, bloom-halo sanity, no perf regression, gauge structural-pass.

## Risks

- **Base material must be `MeshStandardMaterial`.** Confirmed for the lit-object path (`materials.js:1`, emissive props at `:1263`). The `inject` guard (`includes("#include <emissivemap_fragment>")`) makes it a **safe no-op** on any non-Standard shader (wireframe/MeshBasic), so a wrong-material attach degrades to "no glow," never a broken shader. (Wireframe mode also bypasses `getCachedVariant` entirely — `materials.js:1847` returns base.)
- **Double-glow on already-luminous surfaces.** A surface with `luminosity>0` already feeds `totalEmissiveRadiance` via `applyFloatLumDiffuse`; magicGlow adds on top. Intended (a luminous magic item glows more), but if a descriptor mistakenly tags a bright luminous surface with a high `uGlow`, it can blow out. Mitigated by the ≤2.0 clamp and the per-descriptor `glow` default of 0.6; the classifier (slice 13/config) should keep `glow` modest for already-luminous DIDs.
- **Chunk-name drift across three.js versions.** The seams (`<common>`, `<map_fragment>`, `<emissivemap_fragment>`) are stable three.js chunk names, but a three upgrade that renames them would silently no-op the inject. The test pins the seam contract; a CI three-bump would surface it via the eye-test, not a crash.
- **Channel-vs-accumulate assumption.** I put magicGlow on its own channel `"glow"` (not the shared `"emissive"`) so it co-exists with `glint`/`shimmer`. If the §14 resolver is later changed to treat *all* emissive components as one mutually-exclusive channel, this needs revisiting — but additive emissive is the whole point, so distinct channels is the correct model.
