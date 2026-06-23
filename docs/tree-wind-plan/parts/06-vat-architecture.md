I have everything needed. Here is my deliverable.

---

# Task 06 — VAT (Vertex Animation Texture) Runtime for holtburger

## Assignment
Design the Phase‑2 forest‑scale wind path: a Vertex Animation Texture runtime. Specify texture layout, encoding, how `vertexId` maps onto `adapter.js` non‑indexed verts, the InstancedMesh/BatchedMesh vertex shader, per‑instance phase, looping, point‑vs‑bilinear filtering, per‑model memory cost, how it coexists with the existing batched forest path, and how a tree DID binds its VAT. Cite a working three.js VAT pattern.

## Findings (file:line)

**Geometry is non‑indexed triangle soup, surface‑split, sometimes winding‑reversed.** `meshToGeometryGroups` (`scene3d/adapter.js:707-830`) buckets triangles by `surfaceIndex` (`adapter.js:756-766`), then for each group allocates `groupPositions = new Float32Array(n*9)` (`adapter.js:779`) and writes 3 verts/tri with a vertex order `[0,1,2]` (double‑sided) or `[0,2,1]` (single‑sided reversed winding) (`adapter.js:777`, `adapter.js:789-798`). Final attrs: `position`/`uv`/`normal`, all non‑indexed, `itemSize` 3/2/3 (`adapter.js:801-813`). **Implication: a given output vertex's position in the buffer (its `gl_VertexID`) is NOT stable across surface‑grouping or winding reversal — so VAT must be indexed by the ORIGINAL soup vertex id `t*3 + sv`, baked into a per‑vertex attribute, not by `gl_VertexID`.** This is the single most important constraint for the VAT route.

**The forest is GPU‑batched two ways, both keyed differently:**
- Ring baker: `placementsByModel` (`scene3d/statics.js:2183-2189`) groups by `modelId`, then `buildInstancedNode` (`statics.js:1167`) builds **one `THREE.InstancedMesh` per (modelId, surfaceDid)** (`statics.js:1220`, called once per surface group per RP1 note `statics.js:1208`). `userData` already carries `{modelId, surfaceDid}` (`statics.js:1222-1226`). **This node = exactly one tree DID → the natural VAT carrier.** Per‑instance world transform is in `instanceMatrix` (`statics.js:1248-1250`).
- Per‑LB lazy baker + `?staticBatch=on`: `consolidateStaticSingletons` (`statics.js:1442-1492`) groups singletons **by `surfaceDid` only** (`statics.js:1447-1450`) and merges DIFFERENT models into one `THREE.BatchedMesh` (`statics.js:1464`, `addGeometry`/`addInstance` `statics.js:1470-1472`). **This mixes DIDs → VAT‑hostile; trees must be excluded from this consolidation.**

**The divert seam already exists** for `defaultAnimationId != 0` peel: per‑LB at `statics.js:1576-1587`, ring at `statics.js:2081-2092`. A parallel `windTrees` filter belongs at the same two seams (task 02 owns this).

**Shader‑patch infrastructure is mature and reusable.** `_chainBeforeCompile` (`materials.js:292-304`) composes onBeforeCompile hooks; `customProgramCacheKey` via `_patchSetCacheKey` (`materials.js:262-285`) disambiguates patch sets so a wind clone doesn't collide programs with a plain material — I extend the key with a wind flag. `applyWireVertexAOPatch` (`materials.js:314-344`) is a working template: it injects a varying after `#include <common>` and writes it after `#include <begin_vertex>`. `getCachedFloorBias` (`materials.js:1794-1806`) is the exact clone+cache+patch template: `base.clone()`, set `userData.__cacheOwned`, apply patch, store in a per‑key Map.

**Per‑frame uniform tick template exists.** `tickTerrainUTime` (`scene3d/loop.js:817-831`) pushes `scene3d.frameTime.tsSec` (shared wall‑clock, `loop.js:821-825`) into every registered material's `uniforms.uTime` (`loop.js:827-828`), registry = `scene3d.terrainMaterials`. WebGL2/three r184 (`index.html:931`, `three@0.184.0`) → `gl_VertexID`, `texelFetch`, RGBA16F all available.

**Fetch wiring + dist.** Scenery sidecars fetch from `<scenery_base_url>/<lb_hex>.scenery.jsonl` (`src/lib.rs:2174`, init at `lib.rs:2131`). `dist/` symlinks to `/mnt/wbterminal2/holtburger-dist`. VAT assets fetch JS‑side via plain `fetch()` (no wasm) under `dist/tree-wind/`.

---

## Concrete coding steps (ordered)

### Step 1 — Bake‑time VAT asset format (OFFLINE‑BAKE; consumes task 07/08, produced by task 10)
For each tree DID, the offline tool (after skeletonize+sim) emits **two files** under `dist/tree-wind/`:

```
0x02001063.vat.bin    # raw Float16 or Uint8 texel data, row-major
0x02001063.vat.json   # meta sidecar  (+ .sha256 like existing bakes, lib.rs:2334)
```

`*.vat.json` meta:
```jsonc
{
  "did": "0x02001063",
  "numVerts": 4500,        // = full-model soup vertex count = sum(triCount)*3 (PRE surface-split)
  "numFrames": 64,         // F displayed frames of one seamless loop
  "texW": 4500,            // = numVerts (or next pow2 if you pad; shader uses numVerts)
  "texH": 65,              // = numFrames + 1   (extra row = duplicate of row 0, for seamless bilinear)
  "fps": 30,               // AC native 30; loopSeconds = numFrames/fps
  "loopSeconds": 2.133,
  "encoding": "delta-half" | "delta-unorm8",
  "bboxMin": [x,y,z], "bboxMax": [x,y,z],   // model-local rest bbox (for unorm8 decode + windWeight, task 04)
  "deltaScale": [dx,dy,dz], "deltaBias": [bx,by,bz]  // only for unorm8: world = rest + (texel*scale + bias)
}
```

**Texture layout: X = vertexId (soup index), Y = frame.**
- Row `f` (Y=f) holds the displacement of every vertex at frame `f`.
- Column `v` (X=v) is one soup vertex `t*3 + sv` (matches the `aVatVid` the adapter writes — see Step 3).
- Texel `(v, f)` stores **delta‑from‑rest**: `world_pos(v,f) - rest_pos(v)` in model‑local space. Delta (not absolute) keeps magnitudes small → far better half‑float precision and lets unorm8 fall back to a tight per‑model `deltaScale`/`deltaBias` range.
- Row `numFrames` (the +1 extra row, `texH = F+1`) is a **byte copy of row 0** so hardware bilinear interpolates seamlessly across the loop wrap; point sampling never reads it.

### Step 2 — Encoding & memory (decision)
**Primary: `RGBA16F` delta** (RGB = delta xyz, A = optional per‑vertex bend scalar for the shader, else 0). 8 bytes/texel.
**Fallback: `RGBA8` unorm delta** normalized into `deltaScale`/`deltaBias` (4 bytes/texel) — halves memory, ~8‑bit precision over the delta range (≈8 mm if max delta ≈2 m; invisible under point‑snap, acceptable under bilinear).

Memory per unique tree = `numVerts × (numFrames+1) × bytesPerTexel`:

| Tree DID | ~verts | F=64, RGBA16F | F=64, RGBA8 |
|---|---|---|---|
| 0x02001063 (fern, 3 parts, low‑poly) | ~600 | ~0.30 MB | ~0.15 MB |
| 0x02000258 (tall, ~22 m, ~1500 verts) | ~1500 | ~0.76 MB | ~0.38 MB |
| 0x0200035F (11 parts, dense) | ~4500 | ~2.3 MB | ~1.1 MB |

With ~8–16 unique tree DIDs (the established top‑placement set): **~5–18 MB VAT total (RGBA16F)**, ~half that for RGBA8. This is shared across ALL placements of each DID (317k ferns share one 0.3 MB texture), so it's flat regardless of forest size. Cite the cost in `windTreesDiag` (task 15). Reduce F (e.g. 48) or width‑pad off for the low‑memory flag tier.

> Optimization note (open question): AC trees are RIGID per part. If the sim (task 08) keeps motion rigid‑per‑part, the per‑part Animation‑0x03 path (task 09) is far cheaper than VAT (12 floats/part/frame vs per‑vertex). **VAT earns its memory only when bending is sub‑part (smooth skinned bend across a branch).** Recommend VAT for the skeleton‑skinned hero/canopy bend; keep the cheap per‑part rig for foliage rustle.

### Step 3 — `aVatVid` per‑vertex attribute (JS‑ONLY; this is task 04's attribute, consumed here)
In `meshToGeometryGroups` (`adapter.js:783-799` loop), alongside `groupPositions` allocate `groupVatVid = new Float32Array(n*3)` and write the **original soup index**:
```js
// inside the d-loop, after the position writes (adapter.js:792)
groupVatVid[i*3 + d] = (t * 3 + sv);   // ORIGINAL soup vertex id — stable across grouping/winding
```
then `geom.setAttribute("aVatVid", new THREE.BufferAttribute(groupVatVid, 1, false));` after `adapter.js:813`. Gate the whole write behind `opts.windAttrs` (default off) so the frozen path stays byte‑identical. **`BatchedMesh.addGeometry` copies all vertex attributes** (`statics.js:1470`), so `aVatVid` survives into a batched buffer too — robust against multi‑draw `gl_VertexID` ambiguity. `gl_VertexID` is the fallback ONLY for a pure single‑geometry InstancedMesh.

### Step 4 — `getTreeWindVAT(surfaceDid, vat)` material clone (JS‑ONLY; in materials.js)
Mirror `getCachedFloorBias` (`materials.js:1794-1806`). Key by `(treeDID, surfaceDid)` because the same surface can appear on different trees with different VATs:
```js
// materials.js — new method on MaterialCache
getTreeWindVAT(surfaceDid, vat) {            // vat = {texture, meta}
  const base = this._getCachedDouble(surfaceDid);
  if (this.wireframeMode) return base;
  const key = `${vat.meta.did}:${(surfaceDid>>>0).toString(16)}`;
  let m = this.treeWindMaterials.get(key);   // new Map in ctor
  if (!m) {
    m = base.clone();
    m.userData = { ...(base.userData||{}), __cacheOwned: true, __treeWindVAT: true };
    applyVatWindPatch(m, vat, this.windUniforms);  // shared windUniforms (task 12)
    this.treeWindMaterials.set(key, m);
  }
  return m;
}
```
Extend `_patchSetCacheKey` (`materials.js:262-273`) with `+ "|w" + (u.__treeWindVAT ? 1 : 0)` so the wind program never collides with a plain one.

### Step 5 — `applyVatWindPatch` shader injection (JS‑ONLY; in materials.js)
Uses `_chainBeforeCompile` (`materials.js:292`), same shape as `applyWireVertexAOPatch` (`materials.js:314`). **No backticks inside GLSL comments** (per project rule).

```js
function applyVatWindPatch(material, vat, windUniforms) {
  if (!material || material.userData?.__treeWindVAT_done) return;
  vat.texture.minFilter = vat.texture.magFilter =
    (typeof globalThis!=="undefined" && globalThis.__treeWindBilinear) ? THREE.LinearFilter : THREE.NearestFilter; // point=AC frame-snap, linear=smooth
  vat.texture.generateMipmaps = false;
  vat.texture.wrapS = vat.texture.wrapT = THREE.ClampToEdgeWrapping;
  const m = vat.meta;
  _chainBeforeCompile(material, (shader) => {
    shader.uniforms.uVatTex     = { value: vat.texture };
    shader.uniforms.uVatTexW    = { value: m.texW };
    shader.uniforms.uVatFrames  = { value: m.numFrames };
    shader.uniforms.uVatLoopSec = { value: m.loopSeconds };
    shader.uniforms.uVatScale   = { value: new THREE.Vector3(...(m.deltaScale||[1,1,1])) };
    shader.uniforms.uVatBias    = { value: new THREE.Vector3(...(m.deltaBias ||[0,0,0])) };
    shader.uniforms.uWindTime   = windUniforms.uTime;     // SHARED ref (task 12 / loop.js tick)
    shader.uniforms.uWindStrength = windUniforms.uStrength;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>",
        "#include <common>\n" + VAT_PARS_VERT)
      // inject AFTER batching matrix is resolved so we can read per-instance translation
      .replace("#include <begin_vertex>",
        "#include <begin_vertex>\n" + VAT_DISPLACE);
    material.userData.__treeWindUniforms = shader.uniforms; // test/introspection (mirrors materials.js:440)
  });
  material.userData.__treeWindVAT_done = true;
}
```

GLSL (GLSL3 under WebGL2; `texelFetch` = exact frame snap, `texture` = bilinear):

```glsl
/* VAT_PARS_VERT */
attribute float aVatVid;          /* original soup vertex id, Step 3 */
uniform sampler2D uVatTex;
uniform float uVatTexW;           /* numVerts */
uniform float uVatFrames;         /* F */
uniform float uVatLoopSec;
uniform vec3  uVatScale;          /* unorm8 decode; (1,1,1) for half-float */
uniform vec3  uVatBias;
uniform float uWindTime;
uniform float uWindStrength;

/* derive an independent phase per instance from its world translation.
   InstancedMesh: instanceMatrix is a built-in attribute.
   BatchedMesh:   batchingMatrix mat4 exists after the batching chunk. */
#if defined( USE_BATCHING )
  #define HB_INST_TRANSLATION ( batchingMatrix[3].xyz )
#elif defined( USE_INSTANCING )
  #define HB_INST_TRANSLATION ( instanceMatrix[3].xyz )
#else
  #define HB_INST_TRANSLATION ( vec3( 0.0 ) )
#endif

vec3 hbVatSample( float vid, float frame ) {
  /* point: texelFetch, integer coords, no filtering -> exact AC keyframe */
  ivec2 uv = ivec2( int(vid), int(frame) );
  vec3 t = texelFetch( uVatTex, uv, 0 ).xyz;
  return t * uVatScale + uVatBias;     /* delta-from-rest, model-local */
}
```

```glsl
/* VAT_DISPLACE  — runs after begin_vertex (transformed = position) */
{
  vec3 ip = HB_INST_TRANSLATION;
  float phase = fract( dot( ip, vec3( 0.013, 0.0, 0.017 ) ) ); /* hash xz -> [0,1), independent per tree */
  float loops = uWindTime / uVatLoopSec + phase;
  float fcont = fract( loops ) * uVatFrames;                   /* [0, F) */
#ifdef HB_VAT_BILINEAR
  /* two-tap manual lerp across the +1 duplicate row keeps the loop seamless */
  float f0 = floor( fcont );
  float a  = fcont - f0;
  vec3 d0 = hbVatSample( aVatVid, f0 );
  vec3 d1 = hbVatSample( aVatVid, f0 + 1.0 );   /* row F == row 0 copy */
  vec3 disp = mix( d0, d1, a );
#else
  vec3 disp = hbVatSample( aVatVid, floor( fcont ) ); /* AC snap */
#endif
  transformed += disp * uWindStrength;
}
```

Notes:
- Inject after `#include <begin_vertex>` (matches `applyWireVertexAOPatch` `materials.js:325`). `transformed` is still model‑local there, exactly the space the VAT delta is baked in. Lighting/shadow/fog chunks run downstream → **preserved for free** (the whole reason this is an onBeforeCompile patch, not a ShaderMaterial — `materials.js:245-247`).
- `batchingMatrix` is the mat4 three's `<batching_vertex>` chunk computes from the batched matrix texture; it's in scope by `begin_vertex`. For a pure InstancedMesh, `instanceMatrix` is the built‑in. **No custom per‑instance attribute needed** — phase is derived from the per‑instance translation, which works identically on InstancedMesh AND BatchedMesh. (A real `InstancedBufferAttribute aWindPhase` is offered as an InstancedMesh‑only refinement, but BatchedMesh cannot carry custom per‑instance attributes in r184, so the matrix‑hash is the unified path.)
- Point vs bilinear toggled by `?treeWindBilinear` → sets `NearestFilter`/`LinearFilter` AND a `#define HB_VAT_BILINEAR` (add to `material.defines` so it lands in `customProgramCacheKey`). Point = AC‑authentic discrete 30 fps snap; bilinear = smooth.
- Shadows: the VAT displacement must ALSO run in the depth/shadow material or trunks cast a frozen shadow. Three's `customDepthMaterial`/`customDistanceMaterial` need the same patch — add a depth clone in `getTreeWindVAT` and assign `instanced.customDepthMaterial` (open item; acceptable to ship v1 with static shadows behind `?treeWindShadow=off`).

### Step 6 — Per‑frame uniform tick (JS‑ONLY; in loop.js)
Add `tickWindUniforms(scene3d)` modeled on `tickTerrainUTime` (`loop.js:817-831`), called from the same Phase‑2.2 block (`loop.js:1604`):
```js
function tickWindUniforms(scene3d) {
  const w = scene3d.windUniforms; if (!w) return;
  w.uTime.value = scene3d.frameTime?.tsSec ?? (performance.now()*0.001);
  // uDir / uStrength written by the wind-state module (task 12)
}
```
`scene3d.windUniforms` is a single shared object (`{uTime, uDir, uStrength}`) created once; every VAT material clone references the SAME uniform objects (Step 5 binds by reference), so this one tick drives the whole forest — **zero per‑instance CPU work**, the key to not regressing the 1070.

### Step 7 — Binding a DID's VAT at the InstancedMesh build site (JS‑ONLY; in statics.js, task 02 wires the peel)
At the ring baker's per‑model loop where `mat` is resolved before `buildInstancedNode` (`statics.js:2253-2302`), and the per‑LB equivalent: if `treeWindEnabled() && treeWindRegistry.has(modelId)`, replace `materialCache.getCached(group.surfaceDid)` with `materialCache.getTreeWindVAT(group.surfaceDid, treeWindRegistry.get(modelId))`. Because that InstancedMesh is **one (modelId, surfaceDid)** (`statics.js:1220`), the VAT uniform is unambiguous. `treeWindRegistry` is a JS Map populated lazily: on first encounter of a tree DID, `fetch('/tree-wind/'+hex+'.vat.json')` + decode `.vat.bin` into a `THREE.DataTexture` (`RGBA16F`/`RGBA8`, `texW × texH`). Multi‑surface trees: all surface‑group nodes of that DID bind the SAME `vat.texture` (the VAT covers the whole model's soup verts, indexed by `aVatVid`).

---

## Coexistence with the existing BatchedMesh forest

1. **Trees stay GPU‑batched — they are NOT peeled into the per‑part node player.** The per‑part player (`animated_scenery.js`) caps at 512 and won't scale to 317k ferns. VAT keeps trees on InstancedMesh/BatchedMesh.
2. **Trees must NOT enter `consolidateStaticSingletons`** (`statics.js:1442`) because it merges across DIDs by surfaceDid (`statics.js:1447`) and would bind one VAT to mixed geometry. The `windTrees` filter (task 02) at the divert seams (`statics.js:1576`, `2081`) peels tree DIDs out of `statics` BEFORE consolidation, exactly like the `defaultAnimationId` peel, then routes them to a per‑(modelId,surfaceDid) instancing path that calls `getTreeWindVAT`. Non‑tree statics consolidate unchanged → **frozen path byte‑identical when `?treeWind` is off** (the filter is a no‑op when the flag is off).
3. **LRU is preserved.** The VAT InstancedMesh nodes carry the same `userData.landblockId` / `coversLbKeys` (`statics.js:1216-1226`) → the existing evict `kill` (landblock_lru.js) disposes them normally. The VAT *texture* is owned by `treeWindRegistry` (cross‑LB, like a material), NOT per‑node — so it is NOT disposed on LB evict; it's released only when the DID leaves the registry (or never, since there are ~16 of them — pin them).
4. **Diag**: add `windTreesDiag` (task 15) counting `{ vatTextures, vatBytes, instancedNodes, instances }`.

---

## Citing a working three.js VAT pattern
The canonical, working three.js VAT reference this design follows:
- **SideFX Houdini Labs "Vertex Animation Textures"** — the standard X=vertexId / Y=frame layout, delta‑from‑rest + bbox‑range remap, and point‑vs‑bilinear semantics (the "RealTimeVFX"/Houdini→engine bake). The three.js side is the community pattern documented at the **three.js forum thread "Vertex Animation Textures (VAT) in three.js"** and the widely‑used **Anderson Mancini / Codrops "Vertex Animation Textures with three.js"** tutorial, both of which: bake a `DataTexture`, sample it in an `onBeforeCompile`‑patched `MeshStandardMaterial` vertex stage with `texture()`/`texelFetch()`, and read frame from `fract(time)`.
- Our deviations, all forced by the codebase: (a) **`aVatVid` baked attribute instead of `gl_VertexID`** — because `adapter.js:756-798` reorders/reverses verts per surface group and BatchedMesh multi‑draw makes `gl_VertexID` non‑local; (b) **phase from `instanceMatrix[3]`/`batchingMatrix[3]`** instead of a UV‑row offset — because BatchedMesh can't carry custom per‑instance attributes in r184; (c) **`onBeforeCompile` patch over `MaterialCache`** instead of a fresh `ShaderMaterial` — to inherit holtburger's CSM/fog/detail chunks (`materials.js:245-247`, `_chainBeforeCompile` `materials.js:292`).

---

## Risks & open questions

1. **VertexId/order mismatch (HIGH).** If the offline bake's vertex ordering ≠ the adapter's soup ordering, every tree displaces garbage. **Mitigation:** index VAT by the ORIGINAL soup id `t*3+sv` (Step 3) and bake from the SAME triangulation the wasm emits (task 10 must use the identical `append_gfx_tris` order). Add a bake‑time assert: `numVerts == triCount*3`. **Rollback:** `?treeWind` off → frozen.
2. **Shadows freeze (MED).** VAT runs only in the main material; the depth pass still uses rest pose → tree sways but its shadow doesn't. **Mitigation:** clone+patch `customDepthMaterial` (Step 5 note). **Interim:** ship `?treeWindShadow=off` (static shadow) — visually minor for swaying foliage.
3. **Memory at scale (LOW–MED).** ~5–18 MB RGBA16F across all DIDs is fine, but a careless `texW` pad to pow2 (e.g. 4500→8192) nearly doubles it. **Mitigation:** sample by exact `numVerts` (no pow2 pad required in WebGL2); offer `?treeWindLod` to drop F and switch to RGBA8.
4. **Half‑float precision on tall trees (LOW).** 22 m canopy at half‑float ≈1 cm step. **Mitigation:** delta‑from‑rest keeps magnitudes small; canopy delta rarely exceeds a few metres.
5. **BatchedMesh `batchingMatrix` availability (MED — verify).** Confirm three r184's `<batching_vertex>` defines `batchingMatrix` in scope before `begin_vertex` (it does in the InstancedMesh case via `instanceMatrix`; verify the batched chunk name — may be `<batching_vertex>` invoked from `<beginnormal_vertex>`). **Mitigation:** if not in scope, fall back to InstancedMesh‑only VAT (the ring baker already produces per‑model InstancedMesh — BatchedMesh is only the `?staticBatch` per‑LB path) and let trees skip `staticBatch` consolidation entirely.
6. **Is VAT even needed vs per‑part Animation 0x03? (DESIGN).** If task‑08 sim stays rigid‑per‑part, the 12‑floats/part AC‑native path is ~100× cheaper than per‑vertex VAT. **Open question for synthesis:** VAT only when sub‑part skinned bending is desired; otherwise prefer task‑09. Recommend VAT for the hero/canopy smooth‑bend tier, per‑part rig for the bulk rustle.
7. **No wasm rebuild needed for the runtime.** Steps 3–7 are JS‑only (adapter attr write, material clone, shader patch, loop tick, statics binding). Only the OFFLINE bake (Step 1, task 10) and the raw‑vertex export it consumes (task 11) touch Rust — neither runs on the 8 GB laptop. **The VAT runtime ships without a wasm rebuild.**

### Classification summary
| Step | Type |
|---|---|
| 1 VAT asset format | OFFLINE‑BAKE |
| 2 encoding/memory | design |
| 3 `aVatVid` attribute | JS‑ONLY (`adapter.js`) |
| 4 `getTreeWindVAT` | JS‑ONLY (`materials.js`) |
| 5 `applyVatWindPatch`/GLSL | JS‑ONLY (`materials.js`) |
| 6 `tickWindUniforms` | JS‑ONLY (`loop.js`) |
| 7 DID→VAT binding | JS‑ONLY (`statics.js`) |
| raw‑vertex export for bake | NEEDS‑WASM‑REBUILD (task 11, off‑laptop) |
