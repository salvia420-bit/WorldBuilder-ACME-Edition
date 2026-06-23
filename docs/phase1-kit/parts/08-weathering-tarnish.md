All green. Here is my ready-to-integrate Phase-1 deliverable.

---

# weathering.tarnish — Phase 1 Implementation

## Goal
Metal tarnish/patina + crevice darkening on exposed metal with a **shine-restore inverse**, as a cheap fragment weathering component (`weathering.tarnish`, archetype `rigid-glint`). Tints the resolved diffuse toward a desaturated patina and pushes roughness up, weighted by a per-fragment crevice term, with the per-object amount derived deterministically from `hash01(setupDid ^ instanceHash)` × a global age. **Critically: the GLSL runs after `#include <map_fragment>` (POST-palette decode)** and bumps `roughnessFactor` at the later `#include <roughnessmap_fragment>` seam. Default-OFF behind `?visual`; byte-identical when off; one program per component-SET.

## Files

**NEW — `external/holtburger/apps/holtburger-web/scene3d/vfx/components/tarnish.js`** (full contents shipped above; key shape):
- Self-registering `VisualComponent` (`registerComponent(tarnish)`), THREE-free (node-testable — vec3 uniform is a plain `[r,g,b]` array, which three accepts for `vec3`).
- `declareUniforms(shader, config, _globals)` — binds the cloned-material uniforms.
- `inject(shader, _ctx)` — two-seam fragment surgery, idempotent.
- Mirrors `visual_archetype_rules.jsonl` `rigid-glint` defaults (`amount:"hash01"`, `roughTarget:1.0`, `topWeight:0.6`).

**NEW — `external/holtburger/apps/holtburger-web/test_vfx_tarnish.mjs`** (31 checks, `check()`/`process.exit` style — passes).

**No edits to shared files are required from this slice.** The attach path (`getCachedVariant` builder), per-DID selection, the `?tarnish` flag, and the gauge row are owned by slices 02/13/14/15 — my component plugs into them via the established contract. The precise seams they consume:
- `materials.js:1845` `getCachedVariant(surfaceDid, setKey, configKey, builder)` — the builder runs `tarnish.declareUniforms` + `tarnish.inject` inside `_chainBeforeCompile` (`materials.js:297`); `__vfxSetKey` (`materials.js:262` `_patchSetCacheKey`, the `"|v"` firewall line at `:277`) collapses same-SET materials onto one program.
- `registry.js:25` `FAMILY_ORDER` — `weathering:2` (runs after `deformation:0`/`texture:1`, before `emissive:3`).
- `vfx_catalog.js:44` already maps `"weathering.tarnish": "frag"`.

## GLSL
Injected via three replaces on `shader.fragmentShader` (backtick-safe — no backticks in any comment):

**(1) Uniform block + function-scoped accumulator** — prepended at `void main() {`:
```glsl
uniform vec3 uTarnishTint;
uniform float uTarnishAmount;     // <0 => per-instance hash; >=0 => constant amount
uniform float uTarnishAge;        // [0,1] global age; the shine-restore knob (->0 polishes)
uniform float uTarnishVarLo;
uniform float uTarnishVarHi;
uniform float uTarnishRoughTarget;
uniform float uTarnishCrevFloor;
uniform float uTarnishTopWeight;
uniform float uTarnishHashFallback;
void main() {
  float _vfxTarnishT = 0.0;
```

**(2) Diffuse tint — after `#include <map_fragment>` (POST-palette decode):**
```glsl
#include <map_fragment>
{
  #ifdef VFX_INSTANCE_HASH
    float _tInst = vVfxHash;
  #else
    float _tInst = uTarnishHashFallback;
  #endif
  float _tAmt = (uTarnishAmount < 0.0)
      ? mix(uTarnishVarLo, uTarnishVarHi, _tInst)
      : uTarnishAmount;
  float _tLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  float _tCrev = mix(1.0, uTarnishCrevFloor, _tLum);   // recesses (dark texels) tarnish most
  float _tTop = 1.0;
  #ifdef VFX_WORLD_NORMAL
    _tTop = mix(1.0 - uTarnishTopWeight, 1.0, clamp(vVfxWorldNormal.y * 0.5 + 0.5, 0.0, 1.0));
  #endif
  _vfxTarnishT = clamp(uTarnishAge * _tAmt, 0.0, 1.0) * _tCrev * _tTop;
  diffuseColor.rgb = mix(diffuseColor.rgb, uTarnishTint, _vfxTarnishT);
}
// VFX_DIFFUSE_TAIL
```

**(3) Roughness bump — at `#include <roughnessmap_fragment>` (where `roughnessFactor` first exists):**
```glsl
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, uTarnishRoughTarget, _vfxTarnishT);
// VFX_ROUGH_TAIL
```

Why two seams: I verified three's chunk order in `node_modules/three/.../meshphysical.glsl.js` — `map_fragment`(171) → `roughnessmap_fragment`(176) → `emissivemap_fragment`(182). `roughnessFactor` doesn't exist at the map seam, so the amount is computed once at the map seam into a function-scoped `_vfxTarnishT` and re-read at the roughness seam.

**Shine-restore inverse:** there is no separate "restore" path — it's `uTarnishAge`. Tween the uniform `uTarnishAge → 0` on the cloned variant (a `materialUniform` write) and tarnish lerps to identity (`mix(diffuseColor, tint, 0) == diffuseColor`, `mix(roughnessFactor, target, 0) == roughnessFactor`). Pure uniform animation, no relink, THE-RULE compliant.

## Manifest (passes `lint_caps` Layer A + B)
```js
id: "weathering.tarnish", family: "weathering", mech: "frag", channel: "tarnish",
linkVariant(config) { return config && config.blotchMap ? "blotch" : ""; },
cacheKeyScope: "set", deterministic: true, lightCountDelta: 0,
reads:  ["setup", "instanceHash"],   // the two inputs to hash01(setupDid ^ instanceHash)
writes: ["materialUniform"],         // tint + roughness on the getCachedVariant CLONE only
```
- **No `clock`/`weather`/server-wear read** — static patina; age is client/config-derived, never the server wear field.
- `cacheKeyScope:"set"` + `linkVariant()==""` for the default look ⇒ all tarnish-carrying SETs share one program. The optional textured-blotch variant returns a stable per-SET bit `"blotch"`, **never** a per-instance one.
- Per-instance variation rides the `vVfxHash` varying / `uTarnishHashFallback` uniform — never `customProgramCacheKey`.

## Test
`test_vfx_tarnish.mjs` — 31 checks, all green. Locks: registration; `validateComponent`/`lintManifest` clean; reads⊆ALLOWED_READS, writes⊆ALLOWED_WRITES; `linkVariant` per-SET not per-instance; `declareUniforms` (hash01→sentinel −1, constant-amount path, **shine-restore age 0**); **★ diffuse tint lands AFTER `#include <map_fragment>` (post-palette)**; roughness bump after `roughnessmap_fragment`; accumulator declared before its read; `#ifdef VFX_INSTANCE_HASH` + uniform fallback; inject idempotency; composition after a prior same-seam (detail) patch; never assigns `customProgramCacheKey`; **★ Layer B source lint clean**. The shipped `test_vfx_legacy_safety.mjs` (which auto-scans `scene3d/vfx/components/*`) stays green with `tarnish.js` present.

## Integration notes
- **Chain composition.** Each seam uses a tail-sentinel helper (`// VFX_DIFFUSE_TAIL`, `// VFX_ROUGH_TAIL`): the first component at a seam emits `chunk + code + sentinel`; later same-seam components insert *before* the sentinel — so injected blocks preserve call order (== FAMILY_ORDER, the order `frag_install` runs injects) instead of the order-reversal naive `.replace("#include <map_fragment>", …)` produces under `_chainBeforeCompile` chaining. **Recommend slice 02/16 lift this into a shared `frag_install` seam helper** so wetness/frost/glint compose deterministically. Tarnish also composes correctly after the legacy Phase-0.2 detail patch (test-verified).
- **Shadow/depth pass.** My patch only touches the `getCachedVariant` *color* clone via `_chainBeforeCompile`. three's shadow `customDepthMaterial` (`MeshDepthMaterial`) is separate and unpatched ⇒ tarnish is color-pass only; objects still *receive* shadows. Slice 04 owns the formal assertion; nothing here touches the depth material.
- **Gauge cost row (already shipped, accurate — no change needed):** `VfxData/cost_model.jsonl` carries `weathering.tarnish` = `{costClass:"cheap", dProgramsPerDriver:1, dCallsPerInstance:0, dVramMB:0.05, dParticleEmitters:0, dAluClass:"low", mech:"frag"}`. The **shipped default (uniform-only) is 0 VRAM**; the 0.05 MB applies only to the optional `uBlotchMap` link variant. Placement-independent (0-calls) ⇒ `vfx gauge` structural-pass.
- **Flag.** Default-OFF behind `?visual` (master) + the `rigid-glint` archetype flag `?rigidGlint`; slice 14 adds the per-effect `?tarnish` governor. Mark **NON-RETAIL + Pending-1070** in `url-flags.md`.
- **Queued-for-1070:** (a) per-instance `vVfxHash` requires slice 03's `VFX_INSTANCE_HASH` define — until then it falls back to the uniform `uTarnishHashFallback` (uniform-only, no per-object variation, still renders); (b) `topWeight` up-facing patina needs the world-normal varying (slice 09's `VFX_WORLD_NORMAL` + `vVfxWorldNormal`) — inert (`_tTop==1.0`) until then; (c) optional textured blotch variant (`uBlotchMap`, +0.05 MB, `linkVariant→"blotch"`); (d) optional slow age-drift via an oscillator channel (slice 01) — would add a `"clock"` read to the manifest; (e) eye-test row (slice 15): metal weapons/armor visibly aged, `?tarnish=off` byte-identical, shine-restore tween visible.

## Risks
- **Crevice proxy is luminance-based**, not true AO/curvature — patina follows the artwork's painted dark recesses, which reads well on AC's hand-painted metal but isn't geometric. Acceptable for "cheap"; true crevice would need an AO map (not in budget).
- **Same-seam ordering with future weathering components (wetness/frost)** depends on every component adopting the tail-sentinel convention; if slice 02's `frag_install` uses a different composition mechanism, ordering among weathering effects could differ (visually minor — they're near-commutative diffuse/roughness mixes, but worth aligning). Flagged for slice 16's audit.
- **`uTarnishAge` excluded from `configKey`** so the shine-restore tween mutates the uniform in place without thrashing the variant cache — relies on slice 02/13 not folding live age into `configKey` (documented; the static-look knobs *are* keyed).
- Non-`MeshStandardMaterial` surfaces (e.g. wireframe `MeshBasic`) lack `<roughnessmap_fragment>`; the roughness `.replace` is then a no-op (diffuse tint still applies) — graceful, but `getCachedVariant` already returns the unpatched base in `wireframeMode`, so this is only a theoretical edge.
