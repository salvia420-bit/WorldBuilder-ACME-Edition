# HANDOFF — Terrain boundary-blending tech survey + evaluation workflow (2026-06-22)

Status: **OPEN — research collected, no candidate yet shipped beyond the
already-tried bilinear / texMerge / paintMode=winner.** This doc is a
*workflow* — pick a candidate, follow the steps for that section, ship,
A/B on the 1070, decide.

## 0. Problem statement (read this first)

We render Asheron's Call terrain — 255×255 landblocks × 9×9 vertices/LB =
**5,267,025 vertices** total, each carrying **one terrain-type byte** (out of
33: grass, sand, rock, water, etc.). The data ceiling is exactly that: 1
byte per vertex, period (see `WorldBuilder.Shared/Documents/TerrainDocument.cs:86`
TerrainEntry + the AC `client_cell.dat` 16-bit terrain word — Road=bits0-1,
Type=bits2-6, Scenery=bits11-15, Height in a separate byte array).

Three blend methods are already in source and were eye-tested on a real
GTX 1070 at quality=high:

1. **Pure bilinear** (current default, `?paintMode=off`, `?texMerge=off`).
   Each fragment samples 4 cell-corner textures and linearly averages them
   by `(1-fu)(1-fv)` etc. Result: distinct textures (grass + sand + gravel)
   are MUDDIED into one wash; user verdict was "ain't it." See
   `/mnt/wbterminal1/tmp/claude-scratch/terrain-roads-coast/AB-bilinear-vs-texmerge.png`.
2. **Per-cell texMerge composite** (`?texMerge=on`).
   Picks ONE base terrain layer per 24 m cell + alpha-masked overlays for
   differing corners (retail-faithful selection, bit-exact vs `acclient.c`
   per `external/holtburger/crates/holtburger-dat/src/terrain_merge.rs`).
   Result: distinct textures preserved, but per-cell flat tiles read as
   "big blocks" at the macro scale; road overlays paint two adjacent cell
   columns ⇒ wide road; `rotateCellUv` 90°/270° sign unverified. User
   verdict: distinct textures correct, blockiness wrong. URL-toggleable
   `?texMergeRot=flip` for the rotation A/B is wired but not yet
   eye-confirmed.
3. **Stochastic winner-take-all** (`?paintMode=winner`, latest at
   `bf563c5a`). Each fragment samples 4 corner textures, perturbs the
   bilinear weights with world-space hash21 noise, picks the SINGLE
   max-perturbed-weight corner. Uniform-type cells (all 4 corners same
   terrain) fall back to bilinear so animated water/lava don't grainy out.
   Result: distinct textures, noise-shaped organic boundaries, no per-cell
   blocks, but the per-fragment hash still reads as "noise-jaggy" at
   boundaries. User wants smoother organic edges.

So the open problem is **a sharp-distinct-textures-AND-smooth-organic-
boundary blend**, working with our 1-byte-per-vertex data, our existing
33-layer sampler2DArray atlas, our 8-layer A8 alpha-mask DataArrayTexture,
and our three.js GLSL3 ShaderMaterial pipeline. No TAA/TSR available; one
forward pass; targeting WebGL2 on a GTX 1070 (ANGLE D3D11).

## 1. Architecture you must respect

Before proposing anything, read these:

- **Fragment shader entry**: `external/holtburger/apps/holtburger-web/scene3d/terrain.js`
  TERRAIN_FRAGMENT_GLSL (~line 910..1700). The 4-corner sample + blend lives
  at ~line 1326..1395.
- **Vertex shader entry**: TERRAIN_VERTEX_GLSL (~line 718..902). `hash21` is
  defined here; fragment + vertex compile SEPARATELY — any helper used in
  both stages must be declared in both (see the `fragHash21` precedent at
  ~line 1002; the 2026-06-22 commit `00f72e27` documents why).
- **Already wired uniforms you can use**:
  - `uAtlas` — `sampler2DArray` 33-layer per-code RGBA8 atlas, ClampToEdge,
    anisotropy 16 at quality=high (see `setAdapterMaxAnisotropy` in
    `index.js:628` + the quality preset's `anisotropy` field).
  - `uAlphaMasks` — `sampler2DArray` 8-layer A8 masks `[corner0..3, side0,
    road0..2]`, retail GIDs already decoded (`apps/holtburger-web/src/lib.rs:1372-1398`).
  - `uMergeData` — per-LB 48×8 RGBA8 NearestFilter packed `[layer,
    alpha_mask_idx, rotation, valid]` per slot (slots 0=base, 1..3=overlay,
    4..5=road).
  - `uVertexTypes` — per-LB 9×9 RGBA8: R = terrain code, G = road code × 64.
  - `vGridUv` — LB-LOCAL coord [0..8] (RESETS at LB seam → don't sample
    noise here or you get 192 m repeat pattern).
  - `vWorldPos.xy` — WORLD-SPACE position in metres (continuous, no LB
    seam). Use this for any noise/SDF sample.
  - `vAcNormal` — geometry normal (AC z-up). Triplanar/slope-shading reads it.
  - `vTerrainCode` (flat) — provoking-vertex terrain code (don't gate
    cell-wide decisions on this; it's the flat-shaded one corner — that's
    what made the per-cell water-flow block we just fixed).
- **Per-vertex data already in scope**: t00/t10/t01/t11 (the 4 corner
  terrain codes for the current cell) are sampled via `vertexTypeAt(iu,iv)`
  at line ~1283. Use these as your "material weights" / "biome ids."
- **Per-LB material**: each landblock owns its own ShaderMaterial with
  cloned uniforms (`bakeTerrainForLandblock` ~line 2693+). Any new uniform
  you add has to be wired at the material-construction site AND threaded
  through `resolveTerrainRingOpts` from a URL flag (see `uPaintMode` /
  `paintMode` precedent at `bf563c5a`).
- **Shader compile failures are SILENT**: three.js falls back to a black
  material on link error with NOTHING in `__bootState`, `__consoleHistory`,
  or `page.on('console')`. See `feedback_check_console_after_shader_edits.md`.
  Always validate via the live 1070 actually rendering, OR via the
  laptop's chrome-devtools MCP at `http://127.0.0.1:8765/apps/holtburger-web/
  index.html?nosw=1&paintMode=<test>` + an `import('./scene3d/terrain.js')`
  smoke (the import will fail loudly if the GLSL is mistyped in JS, but a
  real GLSL link error needs an in-world bake — use chrome-devtools to
  drive that on the laptop's swiftshader for a first pass).

## 2. Candidate technologies (researched 2026-06-22)

For each candidate: **what it is, fit to our architecture, expected look,
implementation cost, risks, eval steps.** Ordered roughly best-fit-first.

### Candidate A — Histogram-preserving blending (Heitz & Deliot 2019)

**What.** Linear `mix(a, b, w)` desaturates textures because it pulls each
fragment toward the mean colour, collapsing variance. Histogram-preserving
blending Gaussianizes each texture (via a precomputed lookup), blends in
that domain (mean and variance preserved analytically), then
de-Gaussianizes via the inverse lookup. Net result: distinct contrast on
both sides of the boundary, no mud, smooth transition. SIGGRAPH /
HPG 2018 + GPU Zen 2 (2019).

**Fit.** Direct drop-in for the 4-corner average at terrain.js:1395 (the
`result = c00*w00 + ...` line we already replaced once). Each of our 33
atlas layers gets a per-layer LUT (precomputed once at boot from the
33-layer atlas bytes; ~256×1 RGBA per layer → trivial). Per-fragment cost:
~33 lookups extra (negligible vs the 4 atlas texture taps we already do).

**Expected look.** Pure bilinear shape (smooth transitions, no jaggy
noise) but with distinct contrast in each region — i.e. exactly the
"smoother organic edges" the user asked for, without the muddying we
already proved was wrong. Same path as triplanar mapping in many AAA
engines.

**Cost.** Medium. Need a one-time LUT-precompute on the 33-layer atlas
(JS-side, ~2 KB total). Shader change is ~30 LOC. No new data, no new
uniforms beyond the 33-layer LUT texture.

**Risks.**
- The Gaussianization precompute needs the *pre-tiling* atlas bytes
  (before sRGB upload). Atlas bytes are already in
  `buildTerrainAtlasArrayBytes` (`adapter.js:367`), so OK.
- LUTs are per-LAYER (per terrain code), not per-pair: the technique
  preserves variance per-layer; cross-layer blending of grass+rock won't
  invent organic edges. To get organic edges, combine with noise-perturbed
  weights (the winner-take-all trick) BEFORE the histogram-preserve
  averaging — that gets you both.
- Doesn't help texMerge's per-cell blockiness; this is a fix for the
  bilinear path only.

**Eval steps.**
1. Read Eric Heitz's reference page + the Unity Grenoble GitHub demo.
2. Implement the LUT precompute in
   `apps/holtburger-web/scene3d/adapter.js::buildTerrainAtlasArrayBytes`
   (add `buildHistogramLuts(atlasBytes, depth=33)` → 33×256 RGBA8
   DataTexture). Stash on scene3d, bind as `uHistLuts`.
3. New fragment-shader helper: `vec3 gaussianize(vec3 c, int code)` /
   `vec3 deGaussianize(vec3 c, int code)` doing per-channel CDF lookups
   in uHistLuts.
4. In the 4-corner blend block, replace the linear average with: blend in
   Gaussian space, deGaussianize the result. Gate behind a new
   `?blendMode=histogram` URL flag.
5. Eye-test 1070 at LB 0xcf9e (grass/sand/water mix, known boundary lines):
   bilinear vs histogram-preserved. Expected: same overall shape, sharper
   per-region contrast.
6. Compose with `?paintMode=winner` to test "organic-edge winner +
   histogram-preserved smooth blend" hybrid.

### Candidate B — Voronoise-modulated bilinear (Inigo Quilez)

**What.** Iñigo Quilez's "voronoise" interpolates smoothly between regular
noise and Voronoi cells via two parameters (u, v). At one extreme it's
smooth value noise; at the other it's hard Voronoi cells. Sampling the 4-
corner weights through a voronoise field at world-space coords gives
organic, irregular boundary shapes that don't look like noise grain (they
look like authored alpha-mask blotches). This is what Red Blob Games does
to make hex-grid boundaries look organic
(`redblobgames.com/x/1730-terrain-shader-experiments/noisy-hex-rendering.html`).

**Fit.** Direct drop-in. Already have `hash21`/`fragHash21`. Adds a small
voronoise function (~25 GLSL lines). Used as a per-fragment **weight
perturbation** for the existing 4-corner blend, not a new sampling path.

**Expected look.** Boundary lines that LOOK hand-painted — large
soft-edged blotches, not pixel-grain or grid lines. Quilez's paper image
is the canonical "organic biome boundary" look. Better than our current
`hash21`-based winner because voronoise is structured (cell-based) and
reads as features at multiple scales.

**Cost.** Low. ~50 GLSL LOC, two URL params for u/v sliders to A/B the
look.

**Risks.**
- More expensive than hash21 (voronoise samples ~9 hashes per fragment for
  a 3×3 cell neighbourhood). Acceptable at 60 fps on a 1070 but watch
  perf.
- Like all per-fragment hash noise, will still grain when used winner-take-
  all in uniform cells (already mitigated by the same `allSameType` early-
  out we shipped at bf563c5a).

**Eval steps.**
1. Port `iquilezles.org/articles/voronoise/` into terrain.js (declare in
   the fragment shader; gate behind `uBoundaryFn` = voronoise).
2. Use voronoise output to perturb the 4 corner weights (replace the
   `n00 = fragHash21(...)` lines with `voronoise(vWorldPos.xy * freq, u, v)`).
3. Add `?vorU=0.7&vorV=1.0` URL flags so the (u, v) blend params are tunable
   live without recompile.
4. Eye-test 1070: compare hash21 jaggy vs voronoise organic on the same LB.
   Tune (u, v) to the cleanest look. Bake the values, remove the flags.

### Candidate C — Per-vertex barycentric corner-tile painting (Red Blob hex idea adapted)

**What.** Red Blob Games' "noisy hex rendering" draws the DUAL of the tile
grid — for each triangle, render based on the THREE corner ids using
barycentric coords + noise distortion. We have triangles already (each
24 m cell is split SW→NE or NW→SE by retail's per-cell hashed diagonal,
`USE_RETAIL_SPLIT_DIR=true` in `apps/holtburger-web/src/lib.rs:869`). For
each fragment, the triangle it lives in has 3 vertex types; pick winner by
(barycentric weight × noise). Cells with two same-type vertices in the
triangle blend smoothly; cells with three distinct types get organic
3-way splits.

**Fit.** Native fit for our triangle-mesh-per-LB topology. Triangle's
3 vertex types are already available — `terrainCodes` per vertex,
sampled in the vertex shader and passed flat or as a `vec3` varying.
Per-fragment cost: ~3 texture samples (one per triangle vertex) — LESS
than the 4-corner sample we do now.

**Expected look.** Boundaries follow the triangle edges, not the cell
grid → no more 24 m straight diagonals. With noise distortion of
barycentrics, edges look organic at the ~2-3 m scale. Sharpest possible
distinct-type rendering with no muddying.

**Cost.** High. Need to plumb 3 vertex types per triangle as a flat or
provoking-vertex varying (currently only one provoking-vertex code is
flat-varying'd: `vTerrainCode`). Means a small vertex-shader rework + a
per-LB mesh attribute change. Also need to expose the triangle's 3
barycentric weights to the fragment shader (`gl_BaryCoord` is WebGL2
optional — use the standard "trick" of adding 3 per-vertex attributes
[1,0,0]/[0,1,0]/[0,0,1] and reading the linearly-interpolated varying).

**Risks.**
- Vertex format change → wasm-side `landblockMeshToGeometry` changes →
  wasm rebuild required. The repo's wasm rebuild cadence is non-trivial
  (see [[reference_oom_protection_stack_2026-06-01]] for the 8 GB laptop
  cap; build on the buildbox).
- We'd lose the bilinear "soft falloff" the current 4-corner gives in
  same-type cells; that has to be added back via histogram-preserved blend
  (Candidate A composes well here).

**Eval steps.**
1. Read `redblobgames.com/x/1730-terrain-shader-experiments/noisy-hex-rendering.html`
   (the technique generalises straight to triangles).
2. Decide: keep 4-corner sample as the primary path with triangle-aware
   winner as a separate composable mode, OR fully replace 4-corner with
   3-corner-triangle? Recommend KEEP and A/B.
3. Prototype WITHOUT a wasm change first: derive the triangle vertex ids
   in the fragment shader from cellUv (`if (fu + fv > 1.0) NE triangle
   else SW triangle`) and `cell_swto_ne_cut(gx, gy)` flag. That gives 3
   of the 4 t00/t10/t01/t11 codes per triangle. Use those as candidates
   for winner-take-all.
4. Add `?paintMode=triangleWinner` flag, A/B vs `?paintMode=winner`.
5. If triangle-winner reads "more retail" on the 1070, then do the wasm
   plumb for true per-vertex flat varying.

### Candidate D — Procedural SDF biome boundary

**What.** Treat each terrain-type region as a fuzzy 2D field whose boundary
is the level set of an SDF. For each fragment: sample 4 corner types, then
compute a per-type SDF value `sdf_t = distance_to_boundary_where_type_t_dominates`
(approximated by noise-perturbed bilinear). Smoothstep across each SDF to
get a per-type weight; blend textures by those weights. Razor-clean OR
soft-edge transitions tunable via the smoothstep width.

**Fit.** Compatible with our 4-corner sample. No new uniforms beyond
parameters. ~80 GLSL LOC. Best per-pair smoothness control.

**Expected look.** Crisp, hand-painted-look edges with a tunable softness.
This is what high-end terrain shaders (UE5 Layer Blends, Unity
HDRP Terrain) use. Closest to "looks designed not procedural."

**Cost.** Medium. The "SDF" here is approximated — we don't precompute a
real distance field, we use noise+weights as a proxy. Real SDF would
require per-LB precompute of an organic boundary field, probably
overkill.

**Risks.**
- The approximation tends to "wobble" between candidates near triple-junctions
  (3-way type meet). Mitigation: use max-of-pairwise SDFs.
- Tuning the smoothstep width has artistic load. Add URL flag for live
  tuning.

**Eval steps.**
1. Read Flax SDF docs (`docs.flaxengine.com/manual/graphics/models/sdf.html`)
   for the general "smooth boundary radius" idiom.
2. Implement: per-fragment, for each of the up-to-4 distinct types in the
   cell, compute `sdf_t = (perturbed weight of type t) - max(perturbed weights
   of all other types)`. Type with sdf_t > 0 is "inside." Smoothstep across
   ±width to get blend weights.
3. Gate behind `?blendMode=sdf&sdfWidth=0.05`. Eye-test 1070, tune width.
4. Compose with histogram-preserve (A) for distinct-contrast SDF edges.

### Candidate E — Laplacian pyramid blending (Sharma & Heitz 2025, GPU-Friendly Laplacian Texture Blending)

**What.** State-of-the-art. Blend different *frequency bands* of each
texture with different mask sharpness — low-freq smooth crossfade, high-
freq stochastic. Result: smooth perceptual transitions AND preserved
high-freq contrast/detail in both regions. `arxiv.org/abs/2502.13945`.

**Fit.** Requires per-layer Laplacian pyramids precomputed for the 33-layer
atlas (4-5 mip levels × 33 layers = ~165 texture lookups potential, or
storage in a 3D array). Heavier than A but qualitatively better.

**Expected look.** Industry SOTA. What you'd see in current AAA terrain.

**Cost.** High. Needs the Laplacian pyramid precompute path + shader
change + new uniforms. ~150 GLSL LOC + ~100 JS LOC for the precompute.

**Risks.**
- Atlas memory ~doubles (Laplacian pyramid storage).
- Diminishing returns vs A for our 256×256 atlas tiles. May not be visible
  vs A on a 1080p screen at AC distances.

**Eval steps.**
1. Read `arxiv.org/pdf/2502.13945` for the algorithm. (Free PDF.)
2. Implement A first; only escalate to E if A's results are visibly
   inadequate at 1070 quality=ultra. Likely overkill for AC.

### Candidate F — Fix the texMerge composite (already in progress)

**What.** The texMerge SELECTION half is already bit-exact vs `acclient.c`
(`terrain_merge.rs`). The COMPOSITE (`terrain.js:1338-1402`) has known
issues: rotation sign unverified (`uMaskRotFlip` flag wired bf563c5a),
road overlay slots applied across BOTH adjacent cell-columns (already
fixed at bf563c5a). What remains: an eye-test pass to lock the rotation
sign, then default texMerge back ON.

**Fit.** This is the *retail-faithful* path. If we want AC's authentic
texture-painting look (per-cell base + alpha-masked overlays from hand-
authored A8 masks), this is THE answer — the alternatives above are all
non-retail approximations.

**Expected look.** Retail AC. Period. Including the per-cell "big block"
character at the macro scale, which IS retail (acclient.c does not
bilinear-blend; see acclient.c:305909 FillTempTexBuffer). The user's "ain't
it" reaction to texMerge needs revisiting after the rotation fix — if the
mask rotation was wrong, overlays were landing on wrong corners, making
the cell look like one flat tile + a misplaced blotch = read as a block.

**Cost.** Low. The infrastructure is already in source. Eye-test +
constant-bake.

**Risks.** If user still finds it blocky after correct rotation,
texMerge is not the answer for them and we ship a non-retail blend.

**Eval steps.**
1. Reload 1070 with `?texMerge=on` AND `?texMergeRot=flip`. Eye-test LB
   0xcf9e: do overlay alpha-mask shapes land on the correct corners now?
2. If yes, bake `rotation = !current` in `rotateCellUv`, remove
   `uMaskRotFlip` uniform + URL flag, flip `readTexMergeFlag()` default
   to true.
3. If no, that means the current rotation sign was already correct, AND
   the "block" character is the genuine retail per-cell composite. Decide:
   ship retail (block-character is authentic), or layer Candidate B
   (voronoise) on top of texMerge to add organic noise distortion to the
   cell boundaries without changing the composite math.

### Candidate G — Geometry-shader / 4-material-weight voxel blend

**What.** Smooth voxel terrain technique (`bonsairobo.medium.com`).
Material weights interpolated by triangle vertices; 4 material slots per
vertex; per-fragment weighted blend. Equivalent to giving each vertex 4
material weights (instead of 1 type byte) and letting GPU interpolate.

**Fit.** Doesn't fit. Our data ceiling is 1 byte/vertex, not 4 weights.
We'd be inventing the weights from neighbour data, which is what
Candidates A/B/C/D already do without the geometry-shader overhead.

**Expected look.** Same as the simpler candidates.

**Cost.** High (geometry shader path; WebGL2 supports it via separate
program but it's rarely fast).

**Risks.** Performance penalty for no quality win over A/C.

**Eval steps.** Skip.

## 3. Decision matrix

Order of recommendation given user feedback ("smooth distinct organic
boundaries, no graininess, no blocks, retail-authentic if possible"):

| # | Candidate | Smoothness | Distinct textures | Retail-faithful | Cost | Compose with |
|---|---|---|---|---|---|---|
| F | Fix texMerge composite | medium (per-cell) | yes | YES | low | B (organic edges on cell boundaries) |
| A | Histogram-preserving blend | high | yes | no | medium | B, C, D |
| B | Voronoise-modulated weights | high | yes | no | low | A, C, D, F |
| C | Triangle-aware winner | high (with noise) | yes | no | high (wasm change) | A, B |
| D | Procedural SDF boundary | razor or soft, tunable | yes | no | medium | A, B |
| E | Laplacian pyramid blend | SOTA high | yes | no | high | — |
| G | Geometry-shader voxel weights | — | — | no | very high | — |

**Recommended sequence:**
1. **Spend 1 hour on F** (rotation eye-test). If retail-authentic with the
   correct rotation is acceptable to the user, ship that — bit-exact-to-AC
   wins over everything else.
2. If F is acceptable but cell boundaries still read too hard, layer **B**
   (voronoise) onto the per-cell boundary as a post-composite noise
   distortion. Cheap, retail look + organic edge softening.
3. If F is NOT acceptable (the "block character" is genuinely unwanted),
   implement **A** (histogram-preserving) on the bilinear path, composed
   with **B** (voronoise weight perturbation). That gives the
   smooth-distinct-organic combo without giving up on the bilinear
   topology.
4. **C** (triangle winner) only if A+B still shows visible grid character
   — worth it but requires a wasm rebuild.
5. **D** (SDF) only if pixel-precise edge control becomes a requirement
   (e.g. shoreline edges for water effects).
6. **E** / **G** parked unless A+B+C aren't enough.

## 4. Evaluation workflow (apply this to each chosen candidate)

For each candidate you decide to prototype:

1. **Branch.** `git checkout -b terrain-blend-<candidate>-<yyyymmdd>` off
   origin/master. Do not modify other terrain code paths.
2. **Implement behind a URL flag.** `?blendMode=<name>` or `?paintMode=<name>`.
   Default OFF. Required so it doesn't break the live shipped path.
3. **Local syntax + import check.**
   - `node --check external/holtburger/apps/holtburger-web/scene3d/terrain.js`
   - chrome-devtools MCP: navigate to
     `http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&blendMode=<name>`
     + `await import('./scene3d/terrain.js?v=…')` returns ok.
   - `list_console_messages` for any errors/warnings.
4. **Real-GPU validation.** Reverse-tunnel + Playwright connectOverCDP to
   the user's 1070 at `127.0.0.1:9333` (see
   [[reference_local_inworld_hud_verify]]). Scripts at `C:\Temp\cdp-*.cjs`.
   - Reload with `?blendMode=<name>` (60s ghost-drop wait first to avoid
     the `tailnet1` "Account In Use" recycle).
   - Probe terrain meshes: confirm uniforms wired, confirm shader compiled
     (terrain not black — silent compile failures are why
     `feedback_check_console_after_shader_edits.md` exists).
   - Screenshot the canonical LB 0xcf9e (4 terrain types: grass + sand +
     water + LushGrass). Pull to
     `/mnt/wbterminal1/tmp/claude-scratch/terrain-roads-coast/<candidate>-cf9e.png`.
5. **A/B against current shipped default.** Side-by-side crop at the same
   camera. Score on:
   - **Distinctness**: do grass/sand/gravel look like separate textures?
     (vs muddy unified wash). Yes / Partial / No.
   - **Boundary character**: organic blotches / straight grid / pixel jaggy.
   - **Repetition**: 24 m or 192 m grid lines visible? (zoom in on cells
     adjacent to LB seams, e.g. 0xcf9e/0xcf9d border).
   - **Animation interaction**: water cells (codes 16-20) still smooth on
     scroll? (the 2026-06-21 vIsWater fix needs to remain healthy).
   - **Cost**: rough frame-time check via `?diag=1` overlay (or chrome
     devtools perf, but on the 1070 directly, not laptop swiftshader).
6. **Compose**. Often two candidates layer: A under B, F + B, etc. Test
   composed paths after each individual lands.
7. **Decide**. Either:
   - Ship: bake the URL flag as default-on, remove the URL flag if there's
     no opt-out value, commit, push origin/master.
   - Park: leave the URL flag opt-in (so a future eye can re-evaluate
     against later work).
   - Drop: revert the branch.

## 5. Anti-patterns (do not do)

- **Don't pure-bilinear-default**. Confirmed muddy by 2026-06-21 user A/B.
- **Don't re-enable texMerge default-on without the rotation eye-test**.
  Two-lane road + mislaid mask blotches were the original "big blocks"
  symptom; the road is already fixed (single-lane via the legacy
  smoothstep painter), but rotation is still unconfirmed.
- **Don't sample hash noise at `vGridUv`**. LB-local → 192 m repeat → visible
  lines. Use `vWorldPos.xy` (in metres; for noise frequencies divide by
  whatever cell-relative rate you want).
- **Don't put backticks (or `${}`) inside GLSL comments** — they close the
  JS template literal and break the module
  ([[feedback_check_console_after_shader_edits]]).
- **Don't trust `node --check`** for shader-string edits. Use the live-bake
  test in §4 step 3.
- **Don't define a helper in only one of vertex/fragment shader** —
  separate compile units, silent black-terrain fallback (the `hash21` →
  `fragHash21` 2026-06-22 incident).
- **Don't add a "winner-take-all" branch that runs on uniform-type cells**.
  Skip via `(t00==t10) && (t00==t01) && (t00==t11)` early-out — that's
  what kept animated water smooth at bf563c5a.

## 6. Sources (researched 2026-06-22)

Histogram-preserving / variance-preserving blending:
- Eric Heitz's research page — https://eheitzresearch.wordpress.com/722-2/
- "High-Performance By-Example Noise using a Histogram-Preserving Blending
  Operator" (Heitz & Neyret, HPG 2018) —
  https://www.researchgate.net/publication/326744649
- "Procedural Stochastic Textures by Tiling and Blending" (Deliot & Heitz,
  GPU Zen 2, 2019) — covered in the same author page.
- "On Histogram-preserving Blending for Randomized Texture Tiling" (Olano,
  Semantic Scholar) — https://www.semanticscholar.org/paper/53539ea4a249c675a52434c767fc902ad39f8bbe
- Unity demo + GitHub —
  https://unity-grenoble.github.io/website/demo/2020/10/16/demo-histogram-preserving-blend-make-tileable.html
- Jason Booth's accessible writeup — https://medium.com/@jasonbooth_86226/stochastic-texturing-3c2e58d76a14
- Modified ShaderGraph package — https://github.com/UnityLabs/procedural-stochastic-texturing

State-of-the-art (Laplacian):
- "GPU-Friendly Laplacian Texture Blending" (arxiv 2502.13945, 2025) —
  https://arxiv.org/pdf/2502.13945

Voronoise / noisy boundaries:
- Iñigo Quilez — https://iquilezles.org/articles/voronoise/
- Red Blob Games "Noisy hex rendering" —
  https://www.redblobgames.com/x/1730-terrain-shader-experiments/noisy-hex-rendering.html
- Cellular noise variants — https://sangillee.com/2025-04-18-cellular-noises/

Splatmaps / advanced splatting:
- Gamedeveloper.com "Advanced Terrain Texture Splatting" —
  https://www.gamedeveloper.com/programming/advanced-terrain-texture-splatting
- Khronos Forum "Splat map edge blending issues" —
  https://community.khronos.org/t/splat-map-edge-blending-issues/105450
- MicroSplat Texture Clusters (Unity) —
  https://assetstore.unity.com/packages/tools/terrain/microsplat-texture-clusters-104223

Voxel terrain texture blending (informative even though G is not a fit):
- Smooth Voxel Mapping deep dive —
  https://bonsairobo.medium.com/smooth-voxel-mapping-a-technical-deep-dive-on-real-time-surface-nets-and-texturing-ef06d0f8ca14
- Voxel Plugin docs (smooth alpha blends) —
  https://docs.voxelplugin.com/knowledgebase/materials/working-with-materials/smooth-alpha-blends

SDF boundaries:
- Flax Engine SDF docs —
  https://docs.flaxengine.com/manual/graphics/models/sdf.html
- Iñigo Quilez raymarching DFs —
  https://iquilezles.org/articles/raymarchingdf/
- Distance Fields overview —
  https://prideout.net/blog/distance_fields/

Asheron's Call reference:
- Chorizite — https://github.com/Chorizite/Chorizite
- Our own bit-exact port —
  `external/holtburger/crates/holtburger-dat/src/terrain_merge.rs`
- Decomp — `~/ac-headers/acclient.c` (`TexMerge::FillTempTexBuffer`:305909,
  `GetTerrain`:305246, `FindTerrainAlpha`:304756, `FindRoadAlpha`:304716,
  `MergeTexture`:365632, `_road_width`:467318)

## 7. Related project memory

- [[project_terrain_smear_anisotropy_tiling_2026-06-21]] — the smear /
  blocks / two-lane / static-water fixes that preceded this work.
- [[feedback_check_console_after_shader_edits]] — silent-fail trap.
- [[reference_local_inworld_hud_verify]] — live CDP-on-:9333 method.
- [[reference_ac_terrain_textures]] — DAT-side terrain texture table.
- [[project_terrain_reconciliation_2026-06-20]] — data-side faithfulness;
  every blending technique above respects that work.
