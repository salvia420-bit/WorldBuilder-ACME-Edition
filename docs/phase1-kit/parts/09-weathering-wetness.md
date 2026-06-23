Everything verifies. Both test files are written to disk and green. Here is my ready-to-integrate deliverable for the slice.

---

# Slice 09 — `weathering.wetness` (global rain sheen)

## Goal
A cheap, **global** fragment weathering effect: up-facing surfaces darken + go glossier as the world gets wetter, driven by the single shared uniform `VFX_GLOBALS.uWetness` (set once/frame by the weather-inputs tick, slice 12). Zero per-instance work, zero extra texture fetch, applies **broadly** (buildings, props, scenery — anything carrying a frag variant), default-OFF behind `?visual`+`?wetness`, byte-identical when off. Composes on the single `_chainBeforeCompile` chain at `FAMILY_ORDER.weathering = 2`, after deformation/texture and before emissive, under ONE `__vfxSetKey` program.

Built on the Phase-0 substrate (`registry.js` contract, `lint_caps.js`, `materials.js` `getCachedVariant`/`_chainBeforeCompile`/`VFX_GLOBALS`, the `windBend.js` reference). Verified: **`test_vfx_wetness.mjs` 25/25**, **`test_vfx_legacy_safety.mjs` 17/17** (its `components/*` scan now includes `wetness.js`).

## Files

### NEW — `scene3d/vfx/components/wetness.js` (written to disk, full contents)
Imports **only** `../registry.js` — deliberately THREE-free (importing `materials.js` would pull in `three`, which does not resolve in node and would break the test harness + any importer). `VFX_GLOBALS` is passed in via `declareUniforms(shader, config, globals)`, exactly as the contract specifies and as slice 02's frag-install binds it.

Key design points baked into the file:
- **`linkVariant() → ""`** (no config-driven link branch; the GLSL is identical for every wetness material — config only varies uniform *values*). Set identity comes from the component **id** in the frag-install set key, so a wetness-only set never collapses onto a tarnish-only program.
- **`declareUniforms`** binds `shader.uniforms.uWetness = globals.uWetness` **by reference** (one mutation/frame reaches all materials, zero per-material work) with a dormant `{value:0}` fallback (inert/byte-identical if globals ever absent). `strength`/`darken`/`roughDrop` travel as per-config uniforms — **never** the program key.
- **`ensureWorldNormalVarying(shader)`** — exported, **idempotent** (`.includes` guard), shared name `vVfxWorldNormal`, so wetness + `weathering.tarnish` + `weathering.frost` declare it exactly once in the merged shader. The world normal is derived from view-space `transformedNormal` (which `<defaultnormal_vertex>` already folds `batchingMatrix`+`instanceMatrix` into, r184) via the stock `inverseTransformDirection(dir, viewMatrix)` — **per-instance correct with no new geometry attribute**.

### SHARED-FILE SEAMS (precise anchors; owned by slices 02/13/14/15 — listed so they can drop my piece in)

**1. `scene3d/vfx_catalog.js:44` — register the mech route.** Anchor (current `COMPONENT_MECH`, lines 40–45):
```js
export const COMPONENT_MECH = {
  "deformation.windBend": "A",
  "deformation.tipFlex": "B",
  "emissive.glint": "frag",
  "weathering.tarnish": "frag",
+ "weathering.wetness": "frag",
};
```

**2. `scene3d/statics.js:1730` and `scene3d/statics.js:2325` — the material-assignment sites** (`const mat = materialCache.getCached(<surfaceDid>);`). Owned by slice 02/13; when `?visual && descriptor carries frag components`, this becomes `materialCache.getCachedVariant(surfaceDid, setKey, configKey, builder)`. Wetness needs **no special handling** here — it's a normal frag component; it flows through whatever set the DID's descriptor declares (it is global, so a typical descriptor lists it on most weatherable archetypes, or slice 13 may inject it world-wide under `?wetness`).

**3. `scene3d/vfx/components/wetness.js` import in the frag-install builder (slice 02)** — composed in `FAMILY_ORDER` inside one hook:
```js
_chainBeforeCompile(variant, (shader) => {
  comp.declareUniforms?.(shader, cfg, VFX_GLOBALS); // binds uWetness by reference
  comp.inject?.(shader);                            // GLSL surgery at the seams
});
```

## GLSL
World-normal varying (idempotent; vertex + fragment), backtick-safe (no backticks in any comment):

```glsl
/* --- vertex (after #include <common>): declare; after <defaultnormal_vertex>: compute --- */
varying vec3 vVfxWorldNormal;
// ... <defaultnormal_vertex> leaves transformedNormal in VIEW space (batching+instancing folded):
vVfxWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );

/* --- fragment: uniforms after #include <common> --- */
varying vec3 vVfxWorldNormal;
uniform float uWetness;      // shared VFX_GLOBALS global, once/frame
uniform float uWetStrength;  // per-config
uniform float uWetDarken;    // per-config (target albedo mult, e.g. 0.62)
uniform float uWetRoughDrop; // per-config (target roughness mult, e.g. 0.25)

/* --- fragment: diffuse darken AFTER #include <map_fragment> (POST-palette decode) --- */
float _vfxWetUp  = smoothstep( 0.05, 0.6, vVfxWorldNormal.y );          // floors/tops wet, walls ~dry
float _vfxWetAmt = clamp( uWetness * uWetStrength, 0.0, 1.0 ) * _vfxWetUp;
diffuseColor.rgb *= mix( 1.0, uWetDarken, _vfxWetAmt );

/* --- fragment: roughness drop AFTER #include <roughnessmap_fragment> (_vfxWetAmt still in scope) --- */
roughnessFactor *= mix( 1.0, uWetRoughDrop, _vfxWetAmt );
```
`uWetness = 0` ⇒ `_vfxWetAmt = 0` ⇒ both `mix(...,0.0)` resolve to `1.0` ⇒ **byte-identical render when off**. `vVfxWorldNormal.y` is up because this renderer is Y-up world (the shipped `applyWireVertexAOPatch`, `materials.js:356`, uses `vWorldNormalAO.y` the same way). The `0.05/0.6` up-facing thresholds are SET-level GLSL constants (identical across all wetness materials → safe as literals; not config-forked).

## Manifest
Passes `lintManifest` + `validateComponent` (verified):
```
id:             "weathering.wetness"
family:         "weathering"          (FAMILY_ORDER 2 — after deformation/texture, before emissive)
mech:           "frag"
channel:        "wetness"
reads:          ["weather", "geometry"]     ⊆ ALLOWED_READS  (uWetness; world-normal up)
writes:         ["materialUniform"]         ⊆ ALLOWED_WRITES (cloned diffuseColor/roughnessFactor)
deterministic:  true                        (a global uniform — no hash, no Math.random)
lightCountDelta: 0                          (modulates material, touches no light)
cacheKeyScope:  "set"                       (never "instance" — registry rejects it)
linkVariant():  ""                          (no per-config link branch; id carries set identity)
defaults:       { strength: 1.0, darken: 0.62, roughDrop: 0.25 }
```

## Test
**NEW — `test_vfx_wetness.mjs`** (written to disk, `check()/process.exit` style, **25/25 green** in node — no THREE needed). Covers: registration + manifest legality; `reads/writes` subset; firewall (`cacheKeyScope=set`, `lightCountDelta 0`, `deterministic`); **`uWetness` bound by reference** (mutate-the-global → material sees it); config override-over-defaults via uniforms; inert no-globals fallback; **seam ordering** (darken after `<map_fragment>`, rough-drop after `<roughnessmap_fragment>`, single `_vfxWetAmt` reused); world-normal varying in both stages via `inverseTransformDirection`; **idempotent varying** (double-inject ⇒ exactly one decl/stage — proves tarnish/frost compose); off==identity smoke; **Layer-B source lint clean**; registry rejects a `cacheKeyScope:"instance"` variant.

Harness wiring (for slice 16's TIER1 list): add `node test_vfx_wetness.mjs` to the VFX test runner; `test_vfx_legacy_safety.mjs` needs **no change** — its `fs.readdirSync("scene3d/vfx/components")` scan already picks up `wetness.js` (re-ran: 17/17). If slice 16 wants the legacy harness to also *import* every component for a Layer-A registration sweep, add `import "./scene3d/vfx/components/wetness.js";` there.

## Integration notes
- **Chain composition:** weathering=2, so wetness's diffuse modify runs after deformation(0)/texture(1) and before emissive(3). It darkens the resolved (post-palette, post-detail) `diffuseColor` — correct per the weathering compose-order rule (design doc:313: weathering AFTER palette decode, else paletted-luminous surfaces wash). Glint/magicGlow (emissive) add `totalEmissiveRadiance` afterward — independent, no conflict on the `wetness` channel.
- **Shared world-normal varying** is the one cross-slice contract: tarnish (08) and frost (10) must import `ensureWorldNormalVarying`/`VFX_WORLD_NORMAL_VARYING` from here (or slice 16 promotes them to a `frag_seams.js`). All three using the identical name+compute keeps it one declaration. **Queued-for-1070:** promotion to `frag_seams.js` is cosmetic, not blocking.
- **Firewall:** one program per component-SET. Wetness contributes its id to the set key and `""` link variant; all config (storm intensity, per-surface susceptibility) rides uniforms ⇒ program count stays O(#sets), not O(#DIDs). `inject` never names `customProgramCacheKey` (asserted).
- **Shadow/depth pass (slice 04):** `getCachedVariant` clones only the **color** material; the depth/`customDepthMaterial` is separate and unpatched — wetness's vertex varying + fragment writes never reach the depth pass, so shadows are uncorrupted (frag effects still *receive* shadows).
- **Wet/frost mutual exclusion (slice 10):** a DID should carry wetness **or** frost, not both (frost is winter-zone). Enforced by the catalog/weather-inputs (`uWetness` and `uFrost` are driven mutually exclusive by season), not in-shader — if both ever co-apply they'd both modify diffuse, which is why descriptors must pick one.
- **`?wetness` flag (slice 14):** memoized reader in the `tree_wind.js:45` `_numFlag`/`treeWindEnabled` style, living in `vfx_flags.js`:
  ```js
  let _wet; export function wetnessEnabled() { if (_wet === undefined) _wet = _boolFlag("wetness"); return _wet; }
  ```
  Gated under `visualEnabled()`. Default-OFF.
- **`url-flags.md` row (slice 14)**, in the "Still opt-in (default-off) on purpose" section, NON-RETAIL + Pending-1070:
  > `wetness` | `on` | off | VFX rain sheen (`?visual`): up-facing surfaces darken+gloss with `VFX_GLOBALS.uWetness` (weather-inputs, storm-driven). Global uniform, frag patch after `<map_fragment>` (post-palette), per-instance-correct world normal via `inverseTransformDirection`. Default OFF → no frag variant resolved → byte-identical. NON-RETAIL, default-off pending 1070 eye-test. | `scene3d/vfx/components/wetness.js`
- **Gauge cost row (slice 15)** — append to `WorldBuilder.Terminal/VfxData/cost_model.jsonl` (placement-independent, format-matched to the `weathering.tarnish` row):
  ```json
  {"id":"weathering.wetness","costClass":"cheap","dProgramsPerDriver":1,"dCallsPerInstance":0,"dVramMB":0,"dParticleEmitters":0,"dAluClass":"low","mech":"frag","note":"Fragment after <map_fragment> (POST-palette, build-spec §8.2): darkens resolved diffuseColor.rgb + drops roughnessFactor, weighted by world-normal.up * the SHARED uWetness global. ≤1 program per material-SET, 0 draw calls, 0 VRAM (no sampler — pure uniform + geometry normal). Driven by ONE once/frame uniform (placement-independent, O(1)); per-instance-correct up-facing rides the in-shader world normal, NEVER a per-instance program. GLOBAL — cost is bounded by unique component-SET count, not placements."}
  ```
  `vfx gauge` reads dProgramsPerDriver/dCalls/dVram/dParticleEmitters/dAlu — all placement-independent → STRUCTURAL-PASS.
- **1070 eye-test (slice 15):** `?visual=on&wetness=on` during a storm — up-facing floors/roofs/ledges read darker + glossier, vertical walls stay dry; `&wetness=off` is pixel-identical; gauge structural-pass; no perf regression (one extra varying + ~5 ALU ops/fragment on weatherable sets).

## Risks
- **Shared-varying name collision** — the single real composition coupling. Mitigated by the exported constant + idempotent guard; if a sibling slice hardcodes a different name or a different compute line, the merged shader double-declares and fails to compile. *Mitigation:* slice 16 audits that tarnish/frost import `VFX_WORLD_NORMAL_VARYING`/`ensureWorldNormalVarying` rather than rolling their own.
- **Flat-shaded / normal-mapped surfaces** — `vVfxWorldNormal` is the interpolated geometric vertex normal, so the up-facing weight ignores normal-map detail (fine for a broad sheen; intentional, keeps it cheap). For `flatShading` materials the vertex normal is still correct enough for the smoothstep.
- **Non-MeshStandard materials** — the effect assumes the surface base is `MeshStandardMaterial` (confirmed for statics, `materials.js:1749`; `roughnessFactor`/`<roughnessmap_fragment>` exist). If frag-install ever targets a `MeshBasicMaterial` (wireframe/fill path), `<roughnessmap_fragment>` is absent and the `.replace` is a silent no-op for roughness (diffuse darken still works). *Mitigation:* `getCachedVariant` already returns the base unmodified in `wireframeMode` (`materials.js:1847`), so wireframe never gets the patch.
- **Up-axis assumption** — uses world `.y` as up (matches the shipped AO patch). If a sub-scene used Z-up this would mis-weight; not the case in this renderer.
