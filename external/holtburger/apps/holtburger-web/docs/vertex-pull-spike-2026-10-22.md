# Vertex-pull spike — handoff P4 / §6 L3 (2026-10-22)

**Harness only.** Nothing under `scene3d/` changed and there is no flag. The GPU smoke ran on the laptop
(SwiftShader) on 2026-10-22 and PASSES; see §8.
Plan: `docs/HANDOFF-gpu-resident-statics-2026-10-22.md` §6 L3 and §7 P4 ("Spike: one GLSL smoke page drawing a
pulled bucket against the same bucket as BatchedMesh runs, pixel-identical; then one 1070 arm").

- **CPU half run:** `node tests/vertex_pull_spike.test.mjs` gives **54 passed / 0 failed** [M, laptop node].
  Coupled suite `tests/batched_runs.test.mjs` gives 65 / 0, both before and after.
- **GPU half run by the orchestrator, 2026-10-22:** `capped-build node harness/glsl_smoke/vertex_pull_smoke.mjs`
  → **PASS**, 14/14 checks, every B arm (packed / pair / attr / index) equal to A at max channel diff 0 [M, laptop
  SwiftShader]. The first run FAILED (lit-only diff up to 52); the cause and the one-line fix are in §8. The
  "[pending]" marks below are resolved by §8.
- Evidence tags follow the handoff: **[M]** measured, **[D]** derived from a code or spec read, **[A]** assumed.
  No fps predictions; each cost names the measured term it moves.

## 1. What was built

| File | Role |
|---|---|
| `harness/glsl_smoke/vertex_pull_lib.mjs` | Pure builders (arena, streams, draw order, layouts), the GLSL patch, the material/geometry factories. Shared by the page and the node test. |
| `harness/glsl_smoke/vertex_pull_page.html` | One renderer and one scene with the same lights. Each arm is drawn alone, twice, then read back. |
| `harness/glsl_smoke/vertex_pull_smoke.mjs` | Headless Chromium (SwiftShader). Diffs every arm against A and prints samplers, bytes and work. Exit 0 = PASS. |
| `tests/vertex_pull_spike.test.mjs` | The CPU half: three r184 premises, the patch, and both draws emulated corner by corner. |

The scene has 4 distinct indexed models (box, sphere, cylinder, torus) and 30 placements. Each placement has a
distinct T·R·S matrix and a per-instance colour. The material is a `MeshStandardMaterial` with a LINEAR-filtered
checker `map`, so any uv drift shows up in the pixels. Lights: ambient + directional + point. Arms:

| Arm | Draw | Pull stream |
|---|---|---|
| A | three `BatchedMesh` + `scene3d/batched_runs.js`, set up exactly as the app does: chunks installed before any compile, renderer wrapped, unsorted bucket marked | — (per-geometry instanced runs) |
| A_stock | Same mesh with the live seam `__batchedRuns.off`, i.e. three's own multidraw | — |
| B_packed | `Mesh`, no geometry attribute, one `drawArrays` | R32UI texture, `(slot << vbits) \| vertex`, 4 B/corner |
| B_pair | Same | RG32UI texture `(vertex, slot)`, 8 B/corner |
| B_attr | Same, plus one integer attribute `hbPullCorner` | packed u32 as a **vertex attribute**, 4 B/corner (beyond spec) |
| B_index | Same shader as B_packed, one `drawElements` | packed entry per (instance, model vertex) + an index buffer of corners (beyond spec) |
| noRange | B_packed's material on a geometry with no attribute, no index, no drawRange | must draw nothing |

**Shared by every B arm:**
- **Geometry arena:** RGBA32F, two texels per vertex: `(pos.xyz, uv.x)` and `(nrm.xyz, uv.y)`, 32 B/vertex.
- **Instance data:** the matrix and colour textures in BatchedMesh's own layouts (`_initMatricesTexture` /
  `_initColorsTexture`). They are checked bit-equal to A's data, in node now and in the page.

**Draw order.** The B stream is laid out in batched_runs' run order. The node test checks it equals `buildRuns` on
three's canonical list. So B emits the same primitive sequence as A's instanced runs (GL ES 3.0.6 §2.9.3) [D], and
depth ties resolve the same way.

## 2. What the three r184 read settled [D, each pinned as a premise in the node test]

- **The early return, and the minimal legal geometry.**
  - What three does: `renderBufferDirect` clamps the draw range by the index, otherwise **only** by
    `attributes.position`. It then returns on `drawCount < 0 || drawCount === Infinity`.
  - The default `drawRange.count` is `Infinity`. So a non-indexed geometry with no position never draws.
  - The fix is `geometry.setDrawRange(0, corners)`. **No dummy attribute is needed.** A dummy `position` would also
    clamp, but it costs a buffer of at least 4 B per corner that the shader never reads.
  - A real non-position attribute (B_attr) does **not** clamp, so it still needs the drawRange.
  - An index alone clamps (B_index has no drawRange set).
  - `setProgram` runs before the return, so the noRange arm still compiles. GPU proof: `noRange` has 0 calls and 0
    lit pixels.
- **Attribute-less draws.** No GLES 3.0 / WebGL2 rule requires an enabled array. B_packed, B_pair and B_index have
  zero active non-built-in attributes, so the smoke is the proof [pending]. The page records built-ins
  (`gl_VertexID` / `gl_InstanceID`) apart from attributes, because WebGL2 may list them as active at location −1,
  which three skips.
- **The redirect.**
  - What the patch does: `onBeforeCompile` edits the body, which three appends after its prefix. The prefix declares
    `in vec3 position; in vec3 normal; in vec2 uv;`. The body `#define`s those names to globals that `hbPull()` fills
    as the first statement of `main()`.
  - Result: the prefix attributes go unused, so they are inactive and three binds nothing for them.
  - Coverage: the node test resolves every include and lists every use the redirect reaches: `begin_vertex`,
    `beginnormal_vertex`, `uv_vertex`, and `MAP_UV` → `uv`. Nothing else.
- **USE_BATCHING is kept, not dropped.**
  - The body defines `USE_BATCHING` (and `USE_BATCHING_COLOR` when colours are used). Only the three pieces that read
    `gl_DrawID` are replaced: `batching_pars_vertex`, `batching_vertex`, and the `getBatchingColor` call in
    `color_vertex`.
  - So three's `project_vertex`, `defaultnormal_vertex` and `worldpos_vertex` run as written.
  - So does every app patch keyed on `batchingMatrix` under `USE_BATCHING`. Outside comments, `rg batchingMatrix
    scene3d` finds two GLSL reads: the CSM receiver's world position (`materials.js`, `_wp = batchingMatrix * _wp`)
    and the VFX per-instance hash (`vfx/per_instance.js`, `vfxHash01(batchingMatrix[3].xy)`).
  - Only `terrain_batch.js` reads `getIndirectIndex(gl_DrawID)` itself, and terrain is a non-goal.
  - The patch gives the same text whether or not batched_runs.js has patched the chunks.
  - The fragment side needs `USE_COLOR_ALPHA`. three's fragment prefix sets it for a BatchedMesh with colours, and a
    plain Mesh does not get it.
- **Program-cache trap.**
  - What breaks: three's default `customProgramCacheKey()` is `onBeforeCompile.toString()`, which is identical for
    every material one factory makes. Two stream encodings would silently share one program.
  - The spike's fix: it overrides the key, varying it by the compile-time switches only (stream, vbits, colours) —
    never per instance or bucket, per the vfx write invariant.
- **Uniforms.** three binds `batchingTexture` / `batchingIdTexture` / `batchingColorTexture` only when
  `object.isBatchedMesh`, so B names its own (`hbMatrices`, `hbColors`, `hbArena`, `hbPullStream`).
  - **A P4 drawable must not set `isBatchedMesh`.** three would then call `renderMultiDraw` on it, and batched_runs /
    skip_empty_multidraw / bmIndirectPerCamera would treat it as a BatchedMesh.
- **Patch order** (for when this joins `materials.js _chainBeforeCompile`): `hbPull()` must precede any statement that
  reads position/normal/uv.
  - Safe today: the vertex patches anchored on `void main() {` (windSwayGpu, tipFlex) insert declarations
    **before** it.
  - The depth shader (`depth.glsl.js`) has no `color_vertex`, so the shadow/depth variant needs that anchor made
    optional. That variant is not built.

## 3. What the spike proves, and what it cannot

**Proves now [M, node]:**
- every B encoding feeds the vertex shader the same (position, normal, uv, slot) as A's run draw, bit for bit, for
  every corner in the same order;
- the instance textures match BatchedMesh's layout;
- the patch is gl_DrawID-free and refuses on drift.

**Proves once the smoke passes [pending]:**
- under ANGLE/SwiftShader, a lit `MeshStandardMaterial` bucket drawn as **one** `drawArrays` (or `drawElements`)
  through three's own, unpatched `renderBufferDirect` gives A's exact pixels (max channel diff 0);
- no GL error, all programs link;
- the sampler counts and bytes in §4–§5.

The pass bar is diff 0, with no epsilon. The vertex arithmetic after the fetch is the same chunk text on bit-equal
inputs. If a ±1 appears, the smoke prints a |d| histogram to tell compiler contraction apart from data.

**Cannot prove (needs real hardware or more build):**
- **Vertex-texture-fetch cost.** SwiftShader is a CPU rasteriser. On the 1070 (D3D11 `Texture2D.Load` in the vertex
  stage, sharing TMUs with fragment texturing) and on weak iGPUs like the laptop's HD520, VTF throughput and latency
  are [A]. The measured term is GPU `02:RenderPass / statics` ms (gpucensus; 4.53 ms/frame on the 1070, 10-17 [M]).
- **The CrGpuMain gain.** ANGLE D3D11 runs per-range work (full draw + `gl_DrawID` + default-uniform re-upload, see
  the batched_runs.js header). One draw per bucket removes it [D]. Its size is CrGpuMain WebGL ms/frame
  (`gpu_thread_split.py`), which only a 1070 trace reads. P0 arm 2 (`batchedRuns=off`) prices the per-range term
  first.
- **The rest of the app.** Not covered:
  - the app's material chain (the spike patches a stock MeshStandardMaterial);
  - shadows (depth/distance materials);
  - residency (stream rebuild on membership change);
  - context loss;
  - the query facade (§6).

## 4. Cost model [D]

**Texel fetches per shaded vertex** (read from the shader text):

| | stream | arena | indirection | matrix | colour | vertex attributes |
|---|---|---|---|---|---|---|
| A (batchedRuns) | — | — | 3: texel-0 marker, runStart, id | 4 | 1 + a second indirection unless CSE'd | position, normal, uv (+ app attributes) |
| B_packed / B_pair / B_index | 1 | 2 | 0 | 4 | 1 | none |
| B_attr | 0 (attribute) | 2 | 0 | 4 | 1 | the stream entry |

- The dependent chain before the matrix: A up to 3 fetches deep, B 1 deep.
- App statics carry no per-instance colour (`rg '\.setColorAt\(' scene3d` finds only particles), so the colour
  column is spike-only.

**Vertex-shader invocations.**
- A non-indexed pull shades every corner. Spike scene: 10,884 corners vs 2,723 (instance, vertex) pairs, a ratio of
  3.997 [M node].
- Against **today's** runtime geometry this costs nothing extra: `adapter.js meshToGeometryGroups` emits non-indexed
  soup (9 floats per triangle), so every corner is already shaded.
- Against **HBG1 indexed** geometry (`?geomBundles`), the post-transform cache is lost. B_index keeps it with one
  `drawElements` per bucket, still no `gl_DrawID`, at +2|4 B per corner of index.
- Its ANGLE index-range validation is a cached scan per index-buffer update [A].
- Measured term: GPU statics ms, ktris.

**Memory: the trade pulling makes.**
- A BatchedMesh instance costs a constant 64 B matrix + 4 B id.
- A pulled instance costs its model's size in the stream: **12 B per triangle** packed (24 B pair).
- Spike scene [M node]:

  | Item | Size |
  |---|---|
  | Arena | 358 vertices = 11,456 B payload (11,648 B texture) |
  | Corners | 10,884 |
  | B_packed stream | 43,536 B |
  | B_pair stream | 87,072 B |
  | B_index | 2,723 entries × 4 B + 10,884 × u16 index = 32,660 B |
  | A's geometry | 11,456 B attributes + 2,856 B index |
  | A's instance textures (64-instance cap) | matrices 4,096 B, ids 256 B, colours 1,024 B |

- Town scale: the 1070 census (10-17) submits **179.2 ktris/frame** in the statics colour pass [M `census1.json`].
  That set alone is ≥ 2.15 MB of packed stream [D from M]. The resident set is larger, because a bucket's stream
  holds every resident member, visible or not.
- Measured terms:
  - renderer-process memory against the tab cap (4,192 MB on the 1070 [M, `mem_census.js` header]); every stream's
    JS copy counts there (§6, context loss);
  - GPU texture bytes.
- The arena itself is small. HBG1 is 30.3 MB raw for the whole world [M pack-report]. At 32 B/vertex the f32 layout
  is ~1.33× HBG1's 24 B/vertex.
- HBG1's exact 24 B fits **two RGB32UI texels** per vertex: f32 position, snorm8 normal word, f32 uv, unpacked with
  `uintBitsToFloat` / `unpackSnorm4x8` [D, not built]. Pixel identity against attribute snorm conversion is then
  [A], since in-shader `c/127` and the fixed-function conversion are not guaranteed bit-equal.
- **Bit budget** of the packed u32: 2^20 arena vertices × 4096 slots is exactly 32 bits; one more slot does not fit
  [M node]. Past that, use B_pair (8 B), or a **bucket-local arena** (per-bucket vertex numbering) to keep 4 B.

**Membership changes.**
- `setVisibleAt` / park / film hide on a pulled bucket is either:
  - a zero-scale matrix: one matrix write. three r184 re-uploads the whole matrices DataTexture on `needsUpdate`
    unless `texture.addUpdateRange` narrows it; `BatchedMesh.setMatrixAt` never does. The vertex work still runs (F5);
  - or a stream rewrite: O(corners) plus an upload. three's ranged path (`WebGLTextures updateTexture`) hard-codes
    `componentStride = 4` ("only RGBA supported"). So an R32UI / RG32UI stream can only be re-uploaded whole; partial
    updates need an RGBA32UI stream (4 packed corners per texel) [D].
- The per-instance JS walk stays gone either way (L0).
- Keep the true matrix CPU-side when hiding by scale, so `getMatrixAt` still answers placement queries (§6).

## 5. Vertex sampler budget

| Program | Vertex samplers | Source |
|---|---|---|
| Static BatchedMesh programs today | 2: `batchingTexture`, `batchingIdTexture` (no colours on statics) | [D] three chunk + `rg setColorAt` |
| terrain-batch on the 1070 | 2 vertex + 15 fragment = 17 units; MAX_COMBINED = 32; 16 per stage | [M] `cells.js` note, 2026-08-12 (`getActiveUniform` over 89 live programs) |
| VFX components (`windSwayGpu`, wetness, frost, glint, …) | 0: they derive from `batchingMatrix` / `vVfxHash` | [D] `vfx/per_instance.js`, `rg sampler vfx/components` |
| Anim scenery (`hbAiPoseTex`) | separate InstancedMesh programs, a non-goal | [D] `anim_scenery_gpu.js` |
| **P4 pulled static program** | **3**: `hbMatrices`, `hbArena`, `hbPullStream`. **2** with the stream as an attribute (B_attr). +1 each with colours. | [D]; the smoke records spike values (A 3, B 4, B_attr 3) against `MAX_VERTEX_TEXTURE_IMAGE_UNITS` |

- **Vertex stage:** far under 16 [D].
- **Combined units:** +1 per static program (0 for B_attr), because the stream and arena replace the id texture.
  - That interacts with `?texUnitPin` (`uniform_bind_patch.js`). It pins a program only when
    `passes × (total units − pinned) ≤ lowest pin`, so one more dynamic unit narrows that margin [D].
  - The fragment-heavy static programs carry map/array + NRA + detail + env-detail + 3 CSM maps. Re-read their counts
    with the same `getActiveUniform` sweep on the 1070 before P4 lands.
- SwiftShader reports its own limits; the smoke prints them. They are not the 1070's.

## 6. The facade a real P4 drawable must keep (handoff F6 / §8)

The drawable must be a `Mesh`, not a `BatchedMesh` (§2). These consumers read BatchedMesh API today:

| Consumer | What it reads / calls | P4 requirement |
|---|---|---|
| `film/scene/world_query.js` `batchInstancesAt` (staticFadeTargets) | duck-types `getMatrixAt` + `setVisibleAt`; `_instanceInfo.length` (or `maxInstanceCount`); `getVisibleAt` | Same methods. `getMatrixAt(id, sink)` must call `sink.fromArray(data, id * 16)`: the sink is a plain object. |
| `film/runtime/take_player.js` hide/restore, `batchState` | `setVisibleAt` / `getVisibleAt`; **own-property wrapper** installed over `setVisibleAt` and removed (`delete`) after the take; `getGeometryIdAt`; `getMatrixAt` into a `fromArray` sink; zero-scale matrix fallback | Methods on the prototype (shadowable), the same semantics, the true matrix kept CPU-side. |
| `blood_decals.js` `_collectTargets` + `intersectObjects` | branches on `isBatchedMesh` for the object `boundingSphere`; then `raycast` | A plain Mesh falls to `geometry.boundingSphere` (manual: fine) and `Mesh.raycast`. With no `position` that returns **zero hits silently** [D]. Needs its own `raycast`, plus a marker the walk accepts. |
| `ragdoll_env.js` target walk + `intersectObjects` | pushes `isBatchedMesh` / `isInstancedMesh` unconditionally, otherwise a geometry-sphere range test | Same as decals: an own `raycast` over CPU geometry by geometry id × `getMatrixAt`. The arena's CPU copy is enough. |
| `static_batch_x.js` park / unpark (`landblock_lru` warm-park) | `setVisibleAt(iid, …)`; reads `_instanceInfo[iid]` | `_instanceInfo` shape (`visible`, `active`, `geometryIndex`) or both call sites taught a new API. |
| `statics.js cullStaticsGroup` | node-level `__deadBatch` / `__filmHidden`; never culls a light owner | Unchanged: a pulled bucket is one node. |
| `lighting.js recordStatics` | `light.parent === mesh` | Unchanged (node level). |

**Shadows:**
- `castShadow` needs `customDepthMaterial` / `customDistanceMaterial` carrying the same patch, with the colour anchor
  optional (§2).
- `sway_shadow.js` depth materials need it too.

**Context loss:** three re-uploads DataTextures from `image.data`, so the arena and stream stay in the JS heap as well
as on the GPU. Count them twice: renderer heap and GPU [D].

## 7. Next step (P4 says "then one 1070 arm")

Only if P0/P3 leave the per-run CrGpuMain term material (handoff §7).

1. The smallest useful arm is this page scaled to town size: N buckets × M placements of real HBG1-sized models.
2. Measure with `EXT_disjoint_timer_query_webgl2` around each arm, plus one `gputrace.mjs` trace.
3. Read GPU ms (the VTF price) and CrGpuMain WebGL ms (the per-range saving) against the same bucket as batchedRuns.
4. Off-screen, muted, owner-run, a fresh profile per arm.

## 8. GPU smoke result (orchestrator, 2026-10-22, laptop SwiftShader)

**PASS** after one fix. Renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero))).

- **First run: FAIL, every B arm differed from A identically** (max channel diff 52, 1,373 of 16,384 px), while
  A == A_stock. Isolation runs on a scratch copy of the page: `MeshBasicMaterial` (with and without the map) and an
  ambient-only light rig were **identical**; Lambert and Standard under the sun / point light differed, with or
  without the map, and only on curved models (spheres, tori, cylinders), never on box faces. So position, uv,
  colour and the map were exact and only the lit NORMAL differed.
- **Cause [M, compiled source diff]:** A's vertex program carried `#define HAS_NORMAL`, B's `#define FLAT_SHADED`.
  three r184 `WebGLPrograms` sets `flatShading` for Lambert / Phong / Standard / Physical whenever
  `geometry.attributes.normal === undefined` (`vertexNormals` uses the same test), so an attribute-less pulled
  geometry lit with derivative (per-face) normals.
- **Fix:** `makePullGeometry` adds a 1-vertex `normal` marker attribute. The program never reads it (`normal` is
  `#define`d to the pulled value), so it stays inactive and unbound, and it does not clamp the draw range (only
  `position` and the index do). **A real P4 drawable needs the same marker** (or an explicit `HAS_NORMAL` /
  not-`FLAT_SHADED` program parameter), for colour AND depth variants.
- **Measured [M]:**
  - limits: MAX_VERTEX_TEXTURE_IMAGE_UNITS 32, MAX_TEXTURE_IMAGE_UNITS 32, MAX_COMBINED 64, MAX_TEXTURE_SIZE 8192,
    MAX_VERTEX_ATTRIBS 16 (SwiftShader; the 1070's are in §5).
  - vertex samplers: A 3 (batchingTexture, batchingIdTexture, batchingColorTexture); B_packed / B_pair / B_index 4
    (hbMatrices, hbColors, hbArena, hbPullStream); B_attr 3. Active attributes: A position / normal / uv; B_attr
    hbPullCorner; the other B arms none (built-in `gl_VertexID` only).
  - bytes: arena 358 vertices × 32 B = 11,456 B; packed stream 10,884 corners × 4 B = 43,536 B (vbits 9, sbits 5);
    pair 8 B/corner = 87,072 B; indexed 2,723 entries × 4 B + 2 B indices; the same bucket as BatchedMesh uses
    14,312 B of geometry (147,456 B reserved) + 5,376 B of instance textures.
  - work: 30 instances in 4 runs; 10,884 corners vs 2,723 (instance, vertex) pairs = 3.997 vertex invocations per
    shaded vertex for the non-indexed arms (B_index keeps the post-transform cache).
- **Still unproven (needs the 1070):** vertex-texture-fetch cost on D3D11 / weak GPUs, and whether the one-draw
  bucket actually removes the per-range CrGpuMain term the handoff targets (§7).
