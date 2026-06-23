I have everything I need. The load-bearing facts are confirmed:
- Palette/SubPalette shift is baked into RGBA8 pixels at `lib.rs:7381` (`tex.to_rgba8(|pal_id| …)`), so the GPU `map` already carries the dyed albedo.
- The detail patch (`materials.js:427-436`) is the proven "after `<map_fragment>`" seam.
- `applyFloatLumDiffuse` (`materials.js:1238-1248`) attaches the **same** diffuse texture as `emissiveMap` — the wash-to-white root.
- `getCachedFloorBias` (`materials.js:1794-1806`) is the exact clone-variant + `_chainBeforeCompile` + cache-key precedent.
- Shadow pass uses a separate depth material; `materialCanCastShadow` (`materials.js:123`) is geometry/flags-only.

Here is the buildable spec for my slice.

---

# Slice 08 — Weathering Compose-Order + Correctness — BUILD SPEC

## Goal

Make tarnish / fade / dust / rust / wetness / frost / moss / splatter apply as a **fragment-shader layer over the already-decoded, palette/SubPalette-shifted, sRGB→linear diffuse albedo** — never before it, never on the wire, never on the depth pass. Deliverables: (1) the exact GLSL insertion points and compose order that reproduce retail combiner semantics and **cannot** re-trigger the dyed-luminous wash-to-white bug; (2) the per-instance "age" mechanism for `InstancedMesh`/`BatchedMesh` with zero per-instance CPU; (3) a hard rule that the shadow/depth pass does **not** receive the weathering patch.

This slice owns the **compose-order + correctness + per-instance-age + depth-exclusion** rules. It does *not* own the classifier (slice 03), the descriptor fetch/wiring (slice 12), the time-varying oscillator (slice 07), or the component-interface cache-key umbrella (slice 01) — it plugs into those.

---

## Design

### A. Why "after `<map_fragment>`" is the only correct seam (compose-order)

The retail fixed-function order (`reference_chorizite_render_semantics`: *luminosity = FLAT emissive, opacity = 1−translucency, palette = SubPalette shift*) is:

```
1. SubPalette shift recolours palette-indexed texels      → BAKED INTO PIXELS
2. textured diffuse sampled (the recoloured texels)
3. luminosity adds FLAT grayscale emissive, MODULATED by the texture (TEXOP_MODULATE)
4. opacity = 1 - translucency on alpha
```

Step 1 happens **offline/at-ingest**: `lib.rs:7381` `tex.to_rgba8(|pal_id| Palette::unpack(...))` resolves the palette (and SubPalette substitutions) into the RGBA8 buffer that becomes the GPU `DataTexture`. So inside the three.js MeshStandard fragment shader, the dyed/shifted albedo **only exists after `#include <map_fragment>`** (which samples `map` and sRGB-decodes it into `diffuseColor.rgb`, linear space). The paletted-material cache (`materials.js:1627` `palettedMaterials` / `1629` `palettedTextures`) holds one recoloured `DataTexture` per `(surfaceDid|paletteId|subPaletteTuple)` — confirming the dye lives in pixels, not in a shader uniform.

**Therefore weathering MUST:**
- read/write **`diffuseColor.rgb`** (the resolved dyed albedo), injected **immediately after `#include <map_fragment>`** — the identical seam the shipped detail patch uses (`materials.js:427-436`);
- **never** read the `map` sampler or inject before `<map_fragment>` (a no-op for the dye since it's pre-baked, but on a luminous surface it would corrupt the shared sampler — see below);
- **never** add a flat-white emissive (the *original* wash-to-white root cause, documented at `materials.js:2293-2300` and `1093-1095`).

**The dyed-luminous trap, and why this design is immune.** On a luminous surface `applyFloatLumDiffuse` (`materials.js:1238-1248`) sets `emissive = white * luminosity` **and attaches the diffuse texture as `emissiveMap`** so the glow is texture-modulated. In three.js `<map_fragment>` and `<emissivemap_fragment>` sample that texture **independently**. The wash-to-white failure mode is *"flat-white emissive ADD with no texture modulation."* Weathering avoids it structurally:
- it modifies the **resolved `diffuseColor`** (reflectance), not the shared texture sampler — the emissive accumulator is computed from `emissiveMap` independently and is untouched;
- it **does not write `totalEmissiveRadiance`** by default, so a tarnished/dusty *luminous* item still glows in its own (dyed) colour — exactly retail's "luminosity is independent of diffuse reflectance" semantics;
- it adds **no new emissive term**, so there is no white add to wash anything.

### Full chunk-by-chunk compose order (r184 MeshStandard fragment `main()`)

| three.js chunk (in order) | Weathering action injected **after** it |
|---|---|
| `#include <map_fragment>` | **albedo block** — tarnish tint·darken, fade desaturate, dust/moss/splatter overlay on `diffuseColor.rgb` |
| `#include <roughnessmap_fragment>` | `roughnessFactor` += tarnish/dust, −= wetness |
| `#include <metalnessmap_fragment>` | `metalnessFactor` −= rust |
| `#include <emissivemap_fragment>` | **(default: SKIP)** — only `uFadeEmissive>0` dims `totalEmissiveRadiance` |

`opacity` / `diffuseColor.a` is **never written** (transparency sort + shadow alpha-cutout stay owned by the surface decoder `applySurfaceRenderState`, `materials.js:1109`).

**Coexistence ordering with detail/POM/CSM:** all three append after `<map_fragment>` via the `_chainBeforeCompile` chain (`materials.js:292-304`). Install weathering **last** among after-map patches so it sees the detail-composited albedo (weathering acts on the final artwork, not the pre-detail base). The minter (below) enforces install order.

### GLSL — the patch body

```glsl
// ---- injected uniform/varying decls (both stages) ----
// vertex + fragment:
varying float vWeatherAge;   // [0,1) per-instance, procedural
varying float vWeatherUp;    // world-up dot normal, [-1,1] (1 = top face)
// fragment uniforms (uniform tier |wu):
uniform float uTarnish, uRust, uWetness, uFrost, uDust, uFade, uMoss, uSplatter;
uniform vec3  uTarnishTint, uDustColor;       // LINEAR space (see edge cases)
uniform uint  uAgeSeedU;                       // = hash01u(surfaceDid)
// textured tier |wt only:
uniform sampler2D uBlotchMap;                  // shared tiling atlas; 1x1 white when unused
uniform float uBlotchScale;

// ---- VERTEX: after #include <begin_vertex> (transformed + objectNormal exist) ----
#ifdef USE_BATCHING
  float _wInst = getIndirectIndex( gl_DrawID );          // three r184 <batching_vertex> helper
  mat3  _wRot  = mat3(modelMatrix) * mat3(batchingMatrix);
#elif defined( USE_INSTANCING )
  float _wInst = float(gl_InstanceID);                   // WebGL2/GLSL3 builtin
  mat3  _wRot  = mat3(modelMatrix) * mat3(instanceMatrix);
#else
  float _wInst = 0.0;
  mat3  _wRot  = mat3(modelMatrix);
#endif
// hash01(setupDid ^ instanceHash), realized in-shader (integer FNV-ish; mirrors wind_rig.js:199)
uint _wh = uint(_wInst) ^ uAgeSeedU;
_wh ^= _wh >> 16; _wh *= 0x7feb352du; _wh ^= _wh >> 15; _wh *= 0x846ca68bu; _wh ^= _wh >> 16;
vWeatherAge = float(_wh) / 4294967296.0;
vWeatherUp  = normalize(_wRot * objectNormal).y;          // scene is Y-up

// ---- FRAGMENT: after #include <map_fragment> ----
{
  float age = vWeatherAge;
  float up  = clamp(vWeatherUp, 0.0, 1.0);                // 1 = upward face (dust/wet settle)
  float crev= 1.0 - up;                                    // recessed/downward (tarnish/rust)
  // optional spatial mask (|wt). 1x1 white => 1.0 when no blotch atlas bound.
  float blotch = texture2D(uBlotchMap, vMapUv * uBlotchScale).r;
  // tarnish: dull + crevice tint, per-instance + crevice weighted
  float tw = uTarnish * mix(0.6,1.0,age) * mix(0.5,1.0,crev);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uTarnishTint, tw);
  // rust blotch overlay (textured): crevice + age + mask
  diffuseColor.rgb = mix(diffuseColor.rgb, uTarnishTint*0.5, uRust*crev*blotch*mix(0.5,1.0,age));
  // fade/bleach: desaturate toward Rec.709 luminance
  float lum = dot(diffuseColor.rgb, vec3(0.2126,0.7152,0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum), uFade*mix(0.7,1.0,age));
  // dust film + moss: top-weighted lighten / green; moss also low-height (omitted: needs vWorldY)
  diffuseColor.rgb = mix(diffuseColor.rgb, uDustColor, uDust*up*mix(0.5,1.0,age)*blotch);
}
// ---- after #include <roughnessmap_fragment> ----
roughnessFactor = clamp(roughnessFactor
  + uTarnish*0.5*(1.0-clamp(vWeatherUp,0.0,1.0))
  + uDust*0.3*clamp(vWeatherUp,0.0,1.0)
  - uWetness*0.6*clamp(vWeatherUp,0.0,1.0), 0.04, 1.0);
// ---- after #include <metalnessmap_fragment> ----
metalnessFactor = clamp(metalnessFactor - uRust*0.8*(1.0-clamp(vWeatherUp,0.0,1.0)), 0.0, 1.0);
```

`uWetness`/`uFrost` are **global** uniforms set by the weather manager (read-only, client-derived from season/weather) — they are mutually-exclusive (frost zeroes wet). Static effects (tarnish/dust/fade) set their uniforms **once at mint** → zero per-frame cost.

### B. Per-instance AGE mechanism — three options compared

The weathering material is **one cloned material shared across all instances** of an `InstancedMesh`/`BatchedMesh` (statics never use `setColorAt` today — confirmed, no `instanceColor` in the static build at `statics.js:1223/1467`). A uniform is per-material, so per-instance variation **must** come from a per-instance shader input.

| Option | CPU/upload | Stability | BatchedMesh | InstancedMesh | Verdict |
|---|---|---|---|---|---|
| **(A) procedural `hash01(surfaceDid ^ instanceIndex)` in-shader** | **ZERO** | slot-stable per bake (re-bake reshuffles) | ✓ `getIndirectIndex(gl_DrawID)` | ✓ `gl_InstanceID` | **DEFAULT** |
| (B) `InstancedBufferAttribute` 1 float/instance | 4 B/inst + bake-loop write | placement-stable (seed from guid) | ✗ no clean custom per-instance attr on BatchedMesh | ✓ | upgrade only if placement-stable age required |
| (C) age `DataTexture` indexed by instance id | tex mem + bind + vtx fetch | placement-stable | ✓ sample by indirect idx | ✓ sample by `gl_InstanceID` | last resort |

**Recommend (A).** It *is* the listed `hash01(setupDid ^ instanceHash)` option, realized procedurally: the `setupDid` half is the per-material uniform `uAgeSeedU = hash01u(surfaceDid)` (computed once at mint via a uint port of `wind_rig.js:199` `hash01`), the `instanceHash` half is the render-time instance index, XOR-mixed in GLSL. It costs nothing, touches neither the InstancedMesh build loop (`statics.js:1249-1252`) nor BatchedMesh per-instance data, composes on the shared material, and is deterministic (no `Math.random`, matching the project rule). The only downside — slot index reshuffles on LRU re-bake so a given barrel's tarnish *phase* can change after you walk away and back — is visually invisible for weathering. If a future audit-driven feature needs **placement-stable** age (a named landmark that must always read "heavily weathered"), layer (B) as a per-DID override that supplies the attribute or overrides `uAgeSeedU`; default stays (A).

### C. Shadow/depth-pass exclusion (the hard rule)

three.js renders shadow casters with its **own `MeshDepthMaterial`** (RGBA-packed depth), a *separate* material that does **not** carry our `onBeforeCompile` chain. So a **fragment** weathering patch is **auto-excluded** from the shadow pass — *provided we never set `material.customDepthMaterial`/`customDistanceMaterial`*. 

**Rule for this family:** the weathered clone leaves `customDepthMaterial` **unset**. Shadow shape = unweathered geometry silhouette = correct (weathering is colour/roughness, contributes nothing to occlusion). three.js auto-copies `alphaTest`/`alphaMap` to its depth material, and **weathering never changes alpha/alphaTest**, so clipmap-foliage shadow cutouts stay correct. `materialCanCastShadow` (`materials.js:123-134`) gates on `surfaceTypeFlags`, which weathering does not modify — so the cast/no-cast decision is unaffected.

> Contrast (out of scope, flag for slice 04/05): **MECH-B vertex displacement** (cloth/tree sway) *does* need the depth material patched or shadows detach from swaying geometry. Weathering is the opposite case — it must stay fragment-only and out of the depth pass.

### D. Cache-key strategy (no link explosion)

Weathering contributes **at most 2 set-level bits** to `_patchSetCacheKey` (`materials.js:262`), never per-instance:
- `|wu` — uniform-only weathering present (tarnish/fade/wet/frost/dust/edge-wear): all sub-effects are **uniform-gated** (strength 0 ⇒ dead multiply), so every uniform-weathered surface shares **one** program regardless of which sub-effects are active.
- `|wt` — textured weathering present (rust/moss/splatter): adds the shared `uBlotchMap` sampler ⇒ one extra permutation. Different blotch atlases share the program (sampler *value* differs, not the program).

So weathering multiplies existing permutations by ≤4, and only combos actually present compile. Per-instance variation lives in `vWeatherAge`/`vWeatherUp` (uniforms + builtins), **never** in the cache key — respecting the "#1 cold-load cost" constraint (`materials.js:254-260`).

---

## Integration seams (file:line)

- **Pixel decode (palette baked here):** `external/holtburger/apps/holtburger-web/src/lib.rs:7381` `tex.to_rgba8(|pal_id| …)`.
- **The "after `<map_fragment>`" precedent:** `scene3d/materials.js:427-436` (detail patch).
- **Chain + idempotent install:** `scene3d/materials.js:292-304` `_chainBeforeCompile`; `:281-285` `_installPatchSetCacheKey`.
- **Cache-key bits (extend here):** `scene3d/materials.js:262-274` `_patchSetCacheKey`.
- **Clone-variant minter precedent (mirror this):** `scene3d/materials.js:1794-1806` `getCachedFloorBias`; constructor map decls `:1597-1604`.
- **The dyed-luminous root + fix narrative:** `scene3d/materials.js:1078-1096`, `1238-1248` (`applyFloatLumDiffuse`), `2286-2307`.
- **Surface decoder (weathering layers AFTER this, never inside it):** `scene3d/materials.js:1109` `applySurfaceRenderState`.
- **Shadow gate (flags-only; weathering doesn't touch it):** `scene3d/materials.js:123-134` `materialCanCastShadow`.
- **Per-instance hash precedent:** `scene3d/wind_rig.js:199-207` `hash01`.
- **Static material swap seam (where to inject the weathered variant):** `scene3d/statics.js:1223` (`InstancedMesh`), `:1467` (`BatchedMesh` `?staticBatch=on`); per-instance loop `:1249-1252` (unchanged — age is procedural).
- **Per-frame material tick (only for global wet/frost):** `scene3d/loop.js:1812` `materialCache.tickAnimatedSurfaces(dt)`; clock `scene3d.frameTime.tsSec` (`loop.js:822`).
- **Flag-parse precedent:** `scene3d/tree_wind.js:33` `treeWindEnabled()`.

---

## Edge cases & legacy-safety check (per THE RULE)

**THE RULE compliance:**
- **READS** only: `surfaceDid` (DAT-static), `gl_InstanceID`/`getIndirectIndex` (render-time slot — derived, not server state), `objectNormal` + `modelMatrix`/`instanceMatrix`/`batchingMatrix` (DAT geometry + render transforms), global `uWetness`/`uFrost` (client weather-manager derived), client wall-clock for the rare time-varying case. **No server-replicated field is read.** ✓
- **WRITES** only: fragment locals (`diffuseColor.rgb`, `roughnessFactor`, `metalnessFactor`, optionally `totalEmissiveRadiance`) and per-material uniforms on a **`__cacheOwned` clone** (`materials.js:1801` pattern). Never the base material, never geometry/vertex positions (⇒ zero collision/physics impact), never an entity transform, never a wire/replicated field. ✓
- **Light count:** untouched ⇒ no relink-freeze (the spell-freeze light-pool history). ✓
- **Cache key:** set-level `|wu`/`|wt`, never per-instance ⇒ no shader-link explosion. ✓
- **Shadow:** patch absent from depth material ⇒ no desync, shadow = geometry silhouette. ✓

**Edge cases:**
1. **Dyed + luminous (the headline bug):** operate post-`<map_fragment>` on `diffuseColor`, never on `map`/`emissiveMap`, add no white emissive ⇒ a tarnished dyed lifestone dulls reflectance but keeps its coloured glow. ✓
2. **Blended surfaces:** at mint, **skip weathering** when `surfaceTypeFlags` has Additive/Alpha/InvAlpha/Translucent (`SURFACE_TYPE`, `materials.js` import) — flames/glass don't tarnish, and we must never touch their alpha.
3. **Fallback / mapless (`surfaceDid===0`, `FALLBACK_SURFACE_DID`):** skip — no real albedo.
4. **Animated surfaces (water/lava, `_animatedMaterials` `materials.js:1586`):** skip — their `.map` is swapped each frame; they aren't weatherable anyway.
5. **Wireframe mode:** return base (mirror `getCachedFloorBias` `:1796`).
6. **Color space:** `<map_fragment>` outputs **linear** `diffuseColor`; author `uTarnishTint`/`uDustColor` in linear (`new THREE.Color(hex).convertSRGBToLinear()` at mint) or the mix tints wrong.
7. **Detail/POM coexistence:** install weathering **after** detail in the chain so it sees the composited albedo.
8. **BatchedMesh fallback:** if `getIndirectIndex`/`batchingMatrix` can't be resolved on a given build, fall back to `uAgeSeedU`-only (whole-batch uniform age, no per-instance variation) rather than breaking compile.
9. **Recompile:** one `needsUpdate` recompile per `(surfaceDid, effectSet)` at first render; steady state free.

---

## GPU cost

- **Vertex:** +1 integer hash (~5 ops) + 1 `normalize` + 2 varyings. Negligible on low-poly statics.
- **Fragment, uniform tier (`|wu`):** ~12–15 ALU ops (mixes/dots/clamps), **0 texture fetches** ⇒ **cheap**; cost scales with on-screen weathered *pixels*, not instance count. At the Holtburg ref (222 placements / 66 materials, `statics.js:37-44`) this is comfortably inside the 30–50 % idle GPU slice.
- **Fragment, textured tier (`|wt`):** +1 fetch from a shared (~256², mip-resident) blotch atlas ⇒ **medium**; count visible textured-weathered instances, cap concurrent per the §5.3 medium rule.
- **Program permutations:** ≤2 added cache-key bits ⇒ ≤×4, only present-combos compile. **Never per-instance.**
- **VRAM:** uniform tier 0 new textures; textured tier 1 shared atlas reused across all surfaces.
- **Per-frame CPU:** **0** for static weathering (uniforms set once at mint); only global wet/frost touch a handful of shared uniforms when weather changes.

Register with slice 11's `vfx gauge`: `weathering.uniform = cheap`, `weathering.textured = medium`.

---

## Build checklist (ordered, each step a concrete change)

1. **`materials.js`** — add `WEATHERING_UNIFORM_DEFAULTS` (frozen: `tarnish/rust/wetness/frost/dust/fade/moss/splatter = 0`, `tarnishTint`/`dustColor` linear, `blotchScale = 4`) and a `WeatheringConfig` JSDoc shape, beside `DETAIL_UNIFORM_DEFAULTS` (`:248`).
2. **`materials.js`** — add `hash01u(surfaceDid) → uint` helper (uint port of `wind_rig.js:199`).
3. **`materials.js`** — implement `_installWeatheringShaderPatch(material, cfg)`: set `userData.weatheringEnabled = true`, `userData.weatheringTextured = !!cfg.blotchMap` **before** `_chainBeforeCompile`; inject the vertex block after `#include <begin_vertex>`, the fragment blocks after `<map_fragment>` / `<roughnessmap_fragment>` / `<metalnessmap_fragment>` (and `<emissivemap_fragment>` only if `cfg.fadeEmissive`); set `shader.uniforms.*`; bind a 1×1 white fallback for `uBlotchMap`; `material.needsUpdate = true`. Mirror `_installDetailShaderPatch` (`:398`).
4. **`materials.js`** — extend `_patchSetCacheKey` (`:262`) with `+"|wu"+(u.weatheringEnabled?1:0)+"|wt"+(u.weatheringTextured?1:0)`.
5. **`materials.js`** — add `this.weatheredMaterials = new Map()` in the constructor (near `:1604`) + clear it in the scene-rebuild path that clears `floorBiasMaterials`/`palettedMaterials`.
6. **`materials.js`** — add `getCachedWeathered(surfaceDid, effectSetKey, cfg)` mirroring `getCachedFloorBias` (`:1794`): guard (fallback / blended-flags / animated-DID / wireframe → return base unweathered); `clone = base.clone()`; `clone.userData = {...base.userData, __cacheOwned:true}`; convert tints to linear; `cfg.ageSeed = hash01u(surfaceDid)`; `_installWeatheringShaderPatch(clone, cfg)`; **do not set `customDepthMaterial`** (add an asserting comment); store keyed `${surfaceDid>>>0}|${effectSetKey}`.
7. **`statics.js`** — at `:1223` (and `:1467` for `?staticBatch=on`), swap `mat → materialCache.getCachedWeathered(surfaceDid, key, cfg)` when a weathering descriptor exists for the group; leave the per-instance loop (`:1249-1252`) untouched (age is procedural). Descriptor lookup itself is slice 12 — here, just the swap point + a `null`-cfg passthrough to base.
8. **Flag parse** — add `?tarnish ?rust ?wetness ?frost ?dust ?clothFade ?moss` under the `?visual=` family, memoized like `treeWindEnabled` (`tree_wind.js:33`); default **OFF** → 1070 eye-test → default-ON with `=off` escape.
9. **Tests (Node material smoke, mirror existing)** — assert: (a) weathering block appears **after** `<map_fragment>` in the compiled fragment string; (b) cache key gains `|wu`/`|wt`; (c) **no** `emissive`/`opacity`/`diffuseColor.a` write; (d) `clone.customDepthMaterial` is `undefined`; (e) two surfaceDids ⇒ distinct `uAgeSeedU`; (f) base material is byte-identical (clone isolation); (g) blended/additive/fallback/animated DIDs return the **base** unweathered.
10. **Gauge hook** — export the cost classes (`uniform=cheap`, `textured=medium`) for slice 11's `vfx gauge --ref holtburg` table.
