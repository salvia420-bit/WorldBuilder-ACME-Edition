I have everything I need — the onBeforeCompile chaining infra, the r184 STANDARD vertex chunk order, the BatchedMesh/InstancedMesh per-instance matrix exposure, the adapter attribute seam, and the loop.js per-frame uniform pattern. Here is my section.

---

## Assignment (Task 05 — Crytek two-band procedural wind MATERIAL for the bulk forest)

Design `MaterialCache.getTreeWind(surfaceDid)`: a cloned lit `MeshStandardMaterial` with an `onBeforeCompile` vertex-displacement patch that does whole-tree bend (weighted by height/`windWeight` along the wind dir) + high-freq canopy flutter, injected so shadows/fog/lighting survive. Specify shared `windUniforms`, per-instance phase read from the BatchedMesh/InstancedMesh per-instance matrix, and the loop.js per-frame write. This is the **no-bake, scales-to-forest** route (Phase-1 shader path), parallel to the player route (task 01) and feeding off the `windWeight` attribute (task 04). **JS-only — no wasm rebuild.**

## Findings (file:line)

**Runtime three.js is r184** (`index.html:931` pins `three@0.184.0`). The STANDARD vertex shader main-body chunk order (vendored copy, `three.module.js:561`, `vertex$5`) is:
```
<batching_vertex> → <beginnormal_vertex> → <defaultnormal_vertex> → <begin_vertex>
→ <project_vertex> → vViewPosition=… → <worldpos_vertex> → <shadowmap_vertex> → <fog_vertex>
```
Key consequences:
- `<batching_vertex>` defines `mat4 batchingMatrix = getBatchingMatrix(...)` under `#ifdef USE_BATCHING` **before** `<begin_vertex>`, so it is in scope at my injection point. For InstancedMesh, `instanceMatrix` is a global attribute (applied in `<project_vertex>` under `#ifdef USE_INSTANCING`).
- `<begin_vertex>` declares `vec3 transformed = vec3(position);`. Everything that needs to move with the sway — `<project_vertex>` (raster pos), `<worldpos_vertex>` (the `worldPosition` used by **shadow receive + fog**), `<shadowmap_vertex>` — consumes `transformed` **after** begin_vertex. So I inject **immediately after** `#include <begin_vertex>` (mutating `transformed`), and lighting/shadow/fog automatically track it. This is exactly the seam `applyWireVertexAOPatch` uses (`materials.js:324-327`).

**onBeforeCompile chaining infra (reuse verbatim):**
- `_chainBeforeCompile(material, newHook)` — `materials.js:292-304` — preserves any pre-existing hook (CSM/detail/POM) and installs the patch-set cache key.
- `_patchSetCacheKey` — `materials.js:262-274` — builds `customProgramCacheKey` from `userData` flags. **Must add a `|w` term** so a wind variant never collapses onto a frozen program.
- Example begin_vertex injection that reads world position: CSM patch `materials.js:584-600` (`modelMatrix * vec4(transformed,1.0)`), and `applyWireVertexAOPatch` `materials.js:314-344` (string-replace `#include <common>` for pars, `#include <begin_vertex>` for body).

**Clone recipe (proven, mirror it):** `getCachedFloorBias` (`materials.js:1794-1806`) clones `_getCachedDouble(surfaceDid)` then calls `applyFloorDepthBias` → `_chainBeforeCompile`. Because that path renders correctly with shadows today, `Material.clone()` preserves the base's existing onBeforeCompile chain (CSM/detail). I follow the identical clone+chain pattern. `_getCachedDouble` is `materials.js:1808-1824`; base is built `new THREE.MeshStandardMaterial(opts)` at `materials.js:2320`.

**Where the wind material gets applied (BatchedMesh):** `consolidateStaticSingletons` (`statics.js:1442-1492`) groups singleton meshes by `surfaceDid`, takes `mat = group[0].material` (`:1457`), builds `new THREE.BatchedMesh(...)` (`:1464`), and `bm.setMatrixAt(iid, m.matrix)` per instance (`:1472`). The per-instance placement therefore lives in the BatchedMesh batching texture → readable in-shader as `batchingMatrix`. The InstancedMesh path (`statics.js:1220-1250`) uses `setMatrixAt` → `instanceMatrix`. Task 02's wind peel builds a **separate** wind batch whose material is `getTreeWind(surfaceDid)` instead of `getCached(surfaceDid)`.

**Per-vertex height weight source:** adapter's `meshToGeometryGroups` builds non-indexed `groupPositions` (object-local, AC Z-up) and `setAttribute("position"/"uv"/"normal")` at `adapter.js:801-813`. Task 04 adds `aWindWeight` (Float32, count = triCount·3) here, normalized over the **whole-model** Z range (not per-surface-group). My shader consumes it; until task 04 lands it falls back to `position.z / uTreeRefHeight`.

**Per-frame uniform-write seam:** `tickTerrainUTime(scene3d)` (`loop.js:817-831`) reads `scene3d.frameTime.tsSec` and pushes it to terrain `uTime`; called inside the tick at `loop.js:1604-1612` (try/catch one-shot-warn). `tickWindUniforms` slots in right beside it.

## Concrete coding steps

### Step 1 — Shared uniforms + GLSL constants in materials.js *(JS-only)*
Add module-level shared uniform objects (one set, shared by reference across every wind material so loop.js updates ONE object). `uDir` is a **three-world-space** horizontal unit vector (y≈0; remember the scene parents geometry under `worldRoot.rotation.x=-π/2`, so AC-Z height = three-Y up — the displacement is computed in object-local space where `position.z` is still AC height).

```js
import * as THREE from "three";
// Shared wind uniforms — assigned BY REFERENCE into each patched shader so a
// single per-frame write in loop.js updates every compiled wind program.
export const windUniforms = {
  uTime:          { value: 0 },
  uDir:           { value: new THREE.Vector3(1, 0, 0) }, // three-world horizontal
  uStrength:      { value: 0 },     // 0 => frozen; ramped by wind-state (task 12)
  uMainFreq:      { value: 0.35 },  // Hz, whole-tree sway
  uDetailFreq:    { value: 2.2 },   // Hz, canopy flutter
  uMainAmp:       { value: 0.55 },  // metres of canopy travel per unit strength
  uDetailAmp:     { value: 0.08 },  // metres flutter
  uBendExp:       { value: 2.0 },   // cantilever exponent (base stiff, tip loose)
  uTreeRefHeight: { value: 12.0 },  // fallback height normaliser (pre task-04)
};
```

### Step 2 — The two GLSL fragments *(JS-only; NO backticks inside GLSL comments)*

```js
// Pars: declared right after <common> in the vertex shader.
const WIND_PARS_GLSL = [
  "#include <common>",
  "uniform float uTime;",
  "uniform vec3  uDir;",
  "uniform float uStrength;",
  "uniform float uMainFreq;",
  "uniform float uDetailFreq;",
  "uniform float uMainAmp;",
  "uniform float uDetailAmp;",
  "uniform float uBendExp;",
  "uniform float uTreeRefHeight;",
  "#ifdef HB_WIND_WEIGHT_ATTR",
  "  attribute float aWindWeight;",
  "#endif",
  "#define HB_TWO_PI 6.2831853",
  // Hoskins hash (Shadertoy XlGcRh) - deterministic, no Math.random needed.
  "float hb_hash12(vec2 p){",
  "  vec3 p3 = fract(vec3(p.xyx) * 0.1031);",
  "  p3 += dot(p3, p3.yzx + 33.33);",
  "  return fract((p3.x + p3.y) * p3.z);",
  "}",
].join("\n");

// Body: injected immediately AFTER <begin_vertex>, mutating transformed so the
// sway flows into project_vertex (raster), worldpos_vertex (shadow receive +
// fog) and shadowmap_vertex. AC Z-up: object-local position.z is height.
const WIND_BEGIN_GLSL = [
  "#include <begin_vertex>",
  "{",
  // Per-instance world matrix. modelMatrix folds the batch node; the instance
  // placement is the BatchedMesh batchingMatrix or the InstancedMesh
  // instanceMatrix. Mirrors how project_vertex composes them.
  "  mat4 hbInst = mat4(1.0);",
  "  #ifdef USE_BATCHING",
  "    hbInst = batchingMatrix;",
  "  #endif",
  "  #ifdef USE_INSTANCING",
  "    hbInst = instanceMatrix;",
  "  #endif",
  "  mat4 hbWorld = modelMatrix * hbInst;",
  // Height weight in 0..1. Primary: baked per-vertex aWindWeight (task 04,
  // normalized over the whole model bbox). Fallback: local z over a ref height.
  "  #ifdef HB_WIND_WEIGHT_ATTR",
  "    float hbW = clamp(aWindWeight, 0.0, 1.0);",
  "  #else",
  "    float hbW = clamp(position.z / max(uTreeRefHeight, 0.001), 0.0, 1.0);",
  "  #endif",
  // Independent phase per tree from its world XY, so the forest is not in
  // lockstep. No time term => stable per instance.
  "  float hbInstPhase = hb_hash12(hbWorld[3].xy) * HB_TWO_PI;",
  // World wind dir expressed in object space. transpose(mat3) inverts the
  // rotation (incl. worldRoot tilt); normalize drops the uniform scale; zero
  // the local up-component so the bend stays horizontal.
  "  vec3 hbDirLocal = transpose(mat3(hbWorld)) * uDir;",
  "  hbDirLocal.z = 0.0;",
  "  hbDirLocal = normalize(hbDirLocal + vec3(0.0, 0.0, 1e-5));",
  "  vec3 hbPerpLocal = vec3(-hbDirLocal.y, hbDirLocal.x, 0.0);",
  // Band 1: whole-tree bend - low freq, large amp, cantilever-weighted by
  // height^bendExp (base barely moves, canopy moves most). The 0.30 harmonic
  // gives a non-pure-sine gust feel (Crytek main bending).
  "  float hbMainW  = pow(hbW, uBendExp);",
  "  float hbMainPh = uTime * uMainFreq * HB_TWO_PI + hbInstPhase;",
  "  float hbBend   = sin(hbMainPh) + 0.30 * sin(hbMainPh * 1.7 + 1.3);",
  "  vec3  hbDisp   = hbDirLocal * (uStrength * uMainAmp * hbMainW * hbBend);",
  // Band 2: canopy flutter - high freq, small amp, per-vertex phase, mixed
  // along-wind + cross-wind (Crytek detail bending). Limited to the canopy.
  "  float hbDetailW   = smoothstep(0.25, 1.0, hbW);",
  "  float hbVtxPhase  = dot(position.xyz, vec3(12.9898, 78.233, 37.719));",
  "  float hbFlutter   = sin(uTime * uDetailFreq * HB_TWO_PI + hbVtxPhase + hbInstPhase);",
  "  hbDisp += (hbDirLocal * 0.5 + hbPerpLocal) * (uStrength * uDetailAmp * hbDetailW * hbFlutter);",
  "  transformed += hbDisp;",
  "}",
].join("\n");
```

### Step 3 — `applyTreeWindPatch(material)` installer in materials.js *(JS-only)*
Mirror `applyFloorDepthBias` (`materials.js:383-396`):

```js
export function applyTreeWindPatch(material) {
  if (!material || material.userData?.__windPatched) return;
  // Flip ON once task 04 ships aWindWeight on every tree geometry; until then
  // the position.z fallback keeps Phase-1 shader bring-up working.
  // if (HB_HAS_WIND_ATTR) material.defines = { ...(material.defines||{}), HB_WIND_WEIGHT_ATTR: "" };
  _chainBeforeCompile(material, (shader) => {
    // Assign the SHARED uniform objects by reference (not clones).
    shader.uniforms.uTime          = windUniforms.uTime;
    shader.uniforms.uDir           = windUniforms.uDir;
    shader.uniforms.uStrength      = windUniforms.uStrength;
    shader.uniforms.uMainFreq      = windUniforms.uMainFreq;
    shader.uniforms.uDetailFreq    = windUniforms.uDetailFreq;
    shader.uniforms.uMainAmp       = windUniforms.uMainAmp;
    shader.uniforms.uDetailAmp     = windUniforms.uDetailAmp;
    shader.uniforms.uBendExp       = windUniforms.uBendExp;
    shader.uniforms.uTreeRefHeight = windUniforms.uTreeRefHeight;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", WIND_PARS_GLSL)
      .replace("#include <begin_vertex>", WIND_BEGIN_GLSL);
  });
  material.userData = material.userData ?? {};
  material.userData.__windPatched = true;
  material.needsUpdate = true;
}
```

### Step 4 — Extend the program-cache key *(JS-only)*
`materials.js:262-274`, add one line so wind never shares a program with the frozen variant:
```js
    "|f" + (u.__floorBiased ? 1 : 0) +
    "|w" + (u.__windPatched ? 1 : 0)   // <-- add
```

### Step 5 — `MaterialCache.getTreeWind(surfaceDid)` + cache map *(JS-only)*
In the ctor (near `frontSideMaterials`/`floorBiasMaterials`, `materials.js:1577-1611`): `this.windMaterials = new Map();`. Add the method after `getCachedFloorBias` (`materials.js:1806`):
```js
getTreeWind(surfaceDid) {
  const base = this._getCachedDouble(surfaceDid);
  if (this.wireframeMode) return base;       // wind path off in wire mode
  const key = surfaceDid >>> 0;
  let v = this.windMaterials.get(key);
  if (!v) {
    v = base.clone();                         // preserves base CSM/detail chain
    v.userData = { ...(base.userData || {}), __cacheOwned: true };
    applyTreeWindPatch(v);
    this.windMaterials.set(key, v);
  }
  return v;
}
```
Add `windMaterials` to whatever dispose/clear loop frees `frontSideMaterials`/`floorBiasMaterials`.

### Step 6 — loop.js per-frame uniform write *(JS-only)*
Add beside `tickTerrainUTime` (`loop.js:817-831`):
```js
import { windUniforms } from "./materials.js";
// import { sampleWind } from "./wind_state.js"; // task 12

function tickWindUniforms(scene3d) {
  const tSec = scene3d.frameTime?.tsSec ??
    ((typeof performance !== "undefined" && performance.now)
      ? performance.now() * 0.001 : Date.now() * 0.001);
  windUniforms.uTime.value = tSec;
  // Task 12 fills dir/strength + gusts; until then read once from
  // ?treeWindStrength / ?treeWindDir, or leave uStrength=0 (frozen).
  // const w = sampleWind?.(scene3d, tSec);
  // if (w) { windUniforms.uDir.value.copy(w.dir); windUniforms.uStrength.value = w.strength; }
}
```
Call it next to the existing terrain tick at `loop.js:1604-1612`, wrapped in the same try/catch + one-shot-warn idiom. **Single write per frame, zero per-instance CPU** — the bulk forest stays GPU-bound (critical for the 1070 budget, task 13).

### Step 7 (optional, fidelity) — swaying shadow casters *(JS-only)*
A wind BatchedMesh that casts shadows will cast from the **rest pose** (the depth material is separate and un-patched) → canopy shadow detaches. Two options, both at the task-02 wind-attach site:
- **Cheap (Phase 1 default):** `windBatch.castShadow = false` (canopy still **receives** shadows correctly; it just doesn't cast a swaying one).
- **Faithful:** `windBatch.customDepthMaterial = makeWindDepthMaterial()` — a `THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking})` patched with the **same** `applyTreeWindPatch` (the depth vertex shader `vertex$e`/`vertex$d` also has `<batching_vertex>`+`<begin_vertex>`, so the identical string-replace works).

## Risks & open questions

- **Per-instance matrix availability:** `batchingMatrix` only exists under `#ifdef USE_BATCHING`; `instanceMatrix` only under `#ifdef USE_INSTANCING`. The `hbInst` ifdef ladder handles both and a plain `Mesh` (identity → still bends, phase from `modelMatrix` translation). Verified the chunk presence in r184 `vertex$5` (`three.module.js:561`). **Mitigation:** ladder above; **rollback:** flag-off → frozen.
- **Wind dir frame:** displacement is computed in object-local space; `uDir` must be supplied in **three-world** space (horizontal, y≈0). `transpose(mat3(hbWorld))*uDir` then `.z=0` keeps it horizontal in object space **only for yaw + uniform-scale upright placements** — true for AC scenery, but a tilted/non-uniform-scaled placement would shear. **Mitigation:** clamp `.z`, renormalize; **open Q:** audit whether any tree DID is placed with non-yaw rotation (task 02 classification can exclude them).
- **Height-weight normalization across a mixed batch:** `consolidateStaticSingletons` batches by `surfaceDid`, so one wind batch can hold geometries from several tree DIDs of different heights. The `position.z/uTreeRefHeight` fallback is wrong for that mix (tall trees clamp, short trees under-bend). **Mitigation:** ship the `aWindWeight` attribute (task 04, normalized per-model) and flip `HB_WIND_WEIGHT_ATTR` on; the fallback is bring-up-only. **Fail-safe:** a missing attribute reads as a disabled-attrib constant 0 → that tree freezes, never crashes.
- **Normals not recomputed:** displacing position without rotating the normal gives slight lighting drift on a strong bend and faint flutter shimmer. Acceptable for a gentle, default-off effect. **Open Q:** if eye-test flags it, rotate `objectNormal` by the bend's small-angle approximation (extra ~6 ALU/vertex) — defer.
- **Shadow caster mismatch:** see Step 7. Default `castShadow=false` on the wind batch.
- **Program-cache collision:** without the `|w` key term (Step 4) a wind material could share a compiled program with a frozen one and render the wrong shader (the exact failure `_patchSetCacheKey`'s comment at `materials.js:253-261` documents). Covered.
- **Perf:** one shared uniform write/frame; per-vertex cost ≈ 2 `sin` + 1 `mat3` transpose + 1 hash. On the 317k-placement DID this is GPU vertex work on an already-batched draw — no new draw calls, no CPU re-upload. Keep `uStrength=0` default (flag-off) so the program isn't even compiled until `?treeWind=on`.
- **Interaction with task 01 (player route):** the shader route and the per-part-node player must read the **same** wind state so near-field (player) and mid/far (shader) trees agree — both consume task 12's wind vector. Shared `windUniforms` is the single source for the shader side.
