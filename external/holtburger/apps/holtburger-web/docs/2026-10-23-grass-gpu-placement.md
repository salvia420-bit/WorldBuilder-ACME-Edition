# Grass placement on the GPU — design contract (2026-10-23)

Flag: `?terrainGrassGpu=on|off` (EXACT-match, ships **OFF**; 2026-10-23: still
OFF pending the owner's 1070 session, and before any flip the browser readback
smoke must PASS on the current GLSL — the stamp rule in Validation — and a
bare-default boot must be clean). With the flag off the CPU scatter path
(`terrain_scatter.js` + `terrain_grass.js`) must stay byte-identical.

## Why

Grass is a camera-scoped field (`terrain_grass.js`, nested GRASS LOD rings, 120k
blades at ultra). Each blade is placed on the CPU: `oracle.sample()` + the corner
dither + the road verge + the interior-box test + six attribute writes, then a
buffer upload. While running this costs ~2.75 ms/frame on the main thread
(`docs/improvement-hunt-2026-10-20/findings-round2.json`: "no exact cheap lever
short of moving placement to the GPU"), and the fleet notes put ultra at ~26 fps
running, partly from this re-scatter. Placement is a pure function of
(world cell, seed, terrain data), so the vertex shader can compute it from
`gl_InstanceID` with zero per-frame CPU placement, zero per-instance buffers, and
no "grass fills in late in front of a runner" (the edge-first drain disappears).

Per-landblock DATA (small textures written when a landblock bakes), camera-scoped
DRAWING (the existing rings), plus tile culling the single InstancedMesh could
never do (`frustumCulled = false` today: blades behind the camera pay the vertex
shader in full, and grass is vertex-bound).

## Parity contract (what "correct" means)

The GPU path must place THE SAME BLADES as the CPU path for the same ring layout,
seed and terrain: same live set per world cell, same origin (x, y, z), normal,
(height, width), yaw, tint, mat and rank. The only tolerated differences are f32
rounding: positions within **1e-3 m + 2 f32 steps of the stored coordinate**
(xy; z: 1e-3 m + 1 f32 step + slope × 3 xy steps), normal and per-blade scalars
within 1e-4, and a live-set mismatch rate ≤ 0.5 % **per ring** (decisions that sit
within f32 rounding of a threshold, e.g. a 2 m bare-clump boundary at 40 km world
coords). The f32 steps are not slack: the CPU pool itself stores origins as f32,
and at Holtburg (y ≈ 34.6 km) one f32 step is 3.9 mm, so a flat 1e-3 m cannot
hold even for the reference. Every test and the smoke use this rule.

The CPU path is the reference. Read these before writing anything:
- `scene3d/terrain_scatter.js` — `scatterHashU32`, `wrapSlotToCell`,
  `windowMinCell`, `scatterInstance` (THE placement), `SCATTER_FADE_GLSL`, the
  `randSeed` expression in `createScatterPool`.
- `scene3d/terrain_grass.js` — `ditherCornerCode`, `makeGrassFill`,
  `GRASS_VARIANTS`, `grassLodLayout` / `applyGrassLodLook`, the vertex snippet,
  `injectTerrainGrassShader`, `createTerrainGrassProvider`.
- `scene3d/terrain_oracle.js` — `sample()`, `cellSwToNeCut`,
  `triangleHeightInCell`, `triangleGradInCell`, `roadEdgeDistanceInCell`.
- `scene3d/grass_interior_mask.js` — `cellBoxFor`, `contains()`.

### The placement, step by step (CPU semantics the GPU must reproduce)

Per ring (from `grassLodLayout`): `g = sqrt(count)` (counts are perfect squares),
`W = radiusM`, `cell = 2W/g`, ring `seed`, `randSeed` (computed EXACTLY as
`createScatterPool` does from `seed` and `randSalt`), base `seed` of the config
(bare clumps), `jitter = 1`, `heightOffsetM = -0.02`, placement shape SQUARE (no
distance rejection), fade shape DISC.

Window: `winMin = floor((center - W) / cell)` per axis, `center` = player (x, y).
The GPU maps instance → window cell DIRECTLY (no torus — there is no per-instance
state to preserve; a blade at world cell (gx, gy) is identical whichever instance
draws it).

For world cell (gx, gy):
1. `jx = (hash01(gx, gy, 1, seed) - 0.5) * jitter`, `jy` with slot 2;
   `x = (gx + 0.5 + jx) * cell`, `y = (gy + 0.5 + jy) * cell`.
2. Terrain sample at (x, y). Unresident / off-world LB, or no heights → dead.
3. Off-road (when on): `edge = roadEdgeM`; if `edge < verge (1.5)`:
   `p = edge <= 0 ? 1 : 1 - edge / verge`; dead if `p >= 1 ||
   hash01(gx, gy, 3, randSeed) < p`.
4. Interior (when the mask has boxes): dead if `contains(x, y, height)`.
5. `z = height + heightOffsetM`. `rand(ch) = hash01(gx, gy, ch + 16, randSeed)`.
6. `code` = corner dither: `fx = x/24 - floor(x/24)`, `fy` likewise; weights
   SW=(1-fx)(1-fy), SE=fx(1-fy), NW=(1-fx)fy; walk `r = rand(5)` through
   SW, SE, NW, else NE (exactly `ditherCornerCode`).
7. Variant: dead unless `familyForCode(code) === FAM_GRASS` AND
   `GRASS_VARIANTS[code]` exists.
8. Bare clumps: if `v.bare > 0` and
   `hash01(floor(x/2), floor(y/2), 9, baseSeed) < v.bare` → dead.
9. If `v.keep < 1` and `rand(4) > v.keep` → dead.
10. `h = v.h*(0.7+0.6*rand(1))`, `w = v.w*(0.85+0.3*rand(2))`,
    `shade = 0.82+0.36*rand(3)`, `warm = 0.94+0.12*rand(6)`,
    scale = (h, w), rot = rand(0)*2π,
    tint = (t.r*shade*warm, t.g*shade, t.b*shade*(2-warm)), mat = v.mat,
    rank = rand(7), normal = terrain normal.

**GPU order (2026-10-23, review gpu-cost-1).** The GPU runs step 4 (interior)
LAST, after steps 7–9: every rejection returns the same dead blade (nothing is
written before step 10), every test is a side-effect-free predicate of values
computed before it, and the interior test reads only (x, y, height), known after
step 2. So the live set is the AND of the same predicates in either order and
step 10 sees the same inputs (locked by `test_grass_gpu_place.mjs` P10 against a
port of the original order, bit for bit). The interior bucket walk, the costliest
test in a town, then runs on about half of the instances it used to.

**View early-out (2026-10-23, review integ-1 / gpu-cost-1).** The grass vertex
snippet scales every blade by its distance blend (`hbScatterFade`) and its
dissolve; both need only the jittered point and the rank (`rand(7)`). The GPU
main block evaluates them first, with the snippet's own expressions, and skips
steps 2–10 when either is zero (about 51 % of mapped cells at ultra / high).
Same image: the look adds every offset before those two scales, so a zero-size
blade is one point on its origin and a dead blade is one point on its own; both
rasterise nothing. The readback (Validation) reads `hbGrassPlace(id)`, which has
no early-out; the frame compare is what holds the early-out.

### Hash (exact)

```
uint hbHashU32(uint a, uint b, uint c, uint seed) {
  uint h = seed ^ 2166136261u;
  h = (h ^ a) * 16777619u; h = (h ^ b) * 16777619u; h = (h ^ c) * 16777619u;
  h ^= h >> 16u; h *= 2246822507u; h ^= h >> 13u; h *= 3266489909u; h ^= h >> 16u;
  return h;
}
float hbHash01(...) = float(hbHashU32(...) >> 8u) * (1.0 / 16777216.0);
```
Bit-identical to `scatterHashU32` (uint multiply wraps mod 2^32 in GLSL ES 3.00).
`hbHash01` keeps 24 bits so it is always < 1.0 in f32 (the JS reference divides
the full u32 by 2^32 — a ≤ 2^-24 difference, inside the tolerance). Seeds are
passed as `uint` uniforms (`seed >>> 0`; three r184 uploads GL `UNSIGNED_INT`
uniforms via `setValueV1ui`).

### Split diagonal (exact)

`cellSwToNeCut` in uint: `inner = 214614067u*gx + 1813693831u;
v8 = gy*inner - 1109124029u*gx - 1369149221u; return v8 >= 2147483682u;`
(2147483682 is the smallest u32 with `v * 2.3283064e-10 >= 0.5` in f64 — the JS
port's exact cutoff, computed 2026-10-23.)

## Module A — `scene3d/terrain_field_gpu.js` (new) + oracle accessors

Terrain data for the shader, per landblock, written when a landblock bakes.

Oracle additions (`terrain_oracle.js`, ADDITIVE ONLY — no behaviour change):
- `version()` — integer, bumped whenever the cache changes (a successful
  `noteLandblock`, an `invalidate` that deleted, `clear`).
- `lookup(lbKeyOrId)` — the cache entry `{codes, heights, roads, lbX, lbY, …}`
  via the existing `entryFor` (WITH the backfill adoption — in GPU mode nothing
  else calls `sample()`, so this is what adopts LBs baked before the oracle
  existed). Returns null when absent. Read-only by convention.

Textures (THREE injected; with no THREE the module keeps the same Float32Arrays
and builds no GPU objects — node tests and `?nullRender=1`):
- `uHbField`: `DataTexture` RGBA32F (`FloatType`, `RGBAFormat`, `NearestFilter`,
  no mips, `flipY=false`), 144×144 = 16×16 landblock SLOTS of 9×9 vertices.
  Slot of LB (lbX, lbY) = `(lbX & 15, lbY & 15)`. Vertex (col, row) of that LB
  (oracle index `col*9 + row`) lives at texel `(slotX*9 + col, slotY*9 + row)`,
  data index `((slotY*9 + row) * 144 + slotX*9 + col) * 4`.
  r = height (oracle Float32 value; 0 when the LB has no heights),
  g = terrain code (`& 0x1f`), b = road flag (0/1), a = 1.
- `uHbFieldKey`: `DataTexture` RGBA32F 16×16: texel (slotX, slotY) =
  (lbX, lbY, hasHeights 0/1, valid 0/1).

Window: LBs within `windowRadiusLb` (default 7, clamped to ≤ 7 so the
(2r+1)² window never puts two LBs in one slot) of the player's LB. `update(px, py)`
is a no-op unless the player's LB or `oracle.version()` changed; then it walks the
window and, per slot, writes the in-window LB's tile + key if it is cached and
the slot does not already hold that exact cache entry (identity — a rebake makes a
new entry object), else marks the key invalid. Slots no window LB maps to are
invalid. Any write sets `needsUpdate = true` on the touched texture(s) (a full
re-upload is fine: 331 KB, only when LBs change). Track per-LB min/max height at
write time.

API:
```js
export const FIELD_SLOTS = 16, FIELD_TILE = 9, FIELD_TEX_SIZE = 144;
export const HB_ROAD_NONE = 1e9;           // GLSL stand-in for "Infinity"
export const TERRAIN_FIELD_GLSL;           // declarations + functions below
export function createTerrainFieldGpu({ THREE, oracle /* object or getter */, windowRadiusLb = 7 }) => {
  uniforms: { uHbField: {value}, uHbFieldKey: {value} },   // bind BY REFERENCE
  update(px, py) -> number,                 // slots (re)written this call
  heightRange(x0, y0, x1, y1) -> {min, max} | null,  // over resident LBs overlapping the rect; null = none
  sampleMirror(x, y, out?) -> null | {height, normal:{x,y,z}, cornerCodes:[4], roadEdgeM},
                                            // JS port of hbFieldSample reading the SAME arrays
  stats() -> { slotsValid, writes, uploads, centerLb, oracleVersion },
  dispose(),
  _fieldData, _keyData,                     // test seams
}
```

GLSL (`TERRAIN_FIELD_GLSL`, valid in BOTH vertex and fragment stages, GLSL ES 3.00,
NO BACKTICKS anywhere in the string):
```glsl
uniform highp sampler2D uHbField;
uniform highp sampler2D uHbFieldKey;
bool  hbCellSwToNeCut(int gcx, int gcy);
float hbRoadEdgeDistanceInCell(ivec4 roads /* SW,SE,NW,NE 0/1 */, vec2 f);  // HB_ROAD_NONE when no road corner, -24.0 when all four
bool  hbFieldSample(vec2 p, out float height, out vec3 normal, out ivec4 cornerCodes /* SW,SE,NW,NE */, out float roadEdgeM);
```
`hbFieldSample` mirrors `oracle.sample()`: `lb = floor(p/192)`; false when lb is
outside 0..255, the key at `(lb & 15)` does not hold (lb, valid), or the LB has no
heights. Then `cf = clamp(local/24, 0, 8)`, `c0 = floor(cf)`, `c1 = min(c0+1, 8)`,
`f = cf - c0`; four corners via `texelFetch`; height on the split triangle; normal
from `triangleGradInCell` (`n = normalize(-dzdx, -dzdy, 1)`, gradient ÷ 24);
`roadEdgeM = HB_ROAD_NONE` when no corner is road.

## Module B — GPU interior mask (`scene3d/grass_interior_mask.js`, additive)

`createInteriorMask(opts)` gains optional `opts.gpu` (default `!!opts.THREE`),
`opts.THREE` and `opts.oracle`. GPU MODE (`gpu` true) keeps the CPU arrays below
(so the mirror is testable without THREE: the provider passes `{ THREE, gpu: true }`
and node tests `gpu: true` alone) and, with THREE, two `DataTexture`s over them,
refreshed (`needsUpdate = true`) in `rebuild()`, in the `sync()` clear path and on
a re-centre (never to rewrite all-zero arrays with zeros). CPU MODE (`gpu` false:
what the shipping CPU grass path creates, `createInteriorMask()` with no args)
allocates no arrays and no textures; the uniforms hold null / 0,
`setGpuCenter()` returns false and `gpuContainsMirror()` false. In both modes
`contains()`, `sync()`'s return and `lastChanged()` are exactly as before.
- `uHbIndoorBoxes`: RGBA32F, width 8, height `INDOOR_GPU_MAX_BOXES` (**2048**,
  WebGL2's guaranteed MAX_TEXTURE_SIZE; the GLSL never names it). Row i:
  texel 0..2 = the rows of the box's affine `inv` (worldRoot-local →
  cell-local), i.e. `(inv[0], inv[4], inv[8], inv[12])`, `(inv[1], inv[5],
  inv[9], inv[13])`, `(inv[2], inv[6], inv[10], inv[14])`; texel 3 =
  `(min.x - WALL, min.y - WALL, min.z - BELOW_FLOOR, 0)`; texel 4 =
  `(max.x + WALL, max.y + WALL, max.z - UNDER_CEILING, 0)` — the margins of
  `contains()` pre-applied; **texel 5 = the box's world AABB `(x0, y0, x1, y1)`,
  tested FIRST** (it is `contains()`'s first test too, so a box that is not
  upright still matches exactly); texels 6..7 unused. So the shader test is an
  AABB reject, then interval checks on the cell-local point.
- `uHbIndoorBuckets`: RGBA32F, width `64*13`, height 64. Bucket (bx, by) =
  `floor(p / 12)` (`INDOOR_GPU_BUCKET_M = 12`), slot `(bx & 63, by & 63)` (the
  slots repeat every 768 m = 4 landblocks per axis); texel `slotX*13 + 0` =
  `(bx, by, count, 1)`; texels `+1..+12` = up to **48** box indices (4 per texel,
  `-1` = empty). 48, not the first draft's 16: a world scan found buckets of up to
  43 building cells (0x4993 housing), and 16 lost 17% of indoor ground there. A
  bucket holds EVERY EnvCell, dungeon cells too, so real buckets can pass 48 (52
  next to 0xF930). A box goes in every bucket its world AABB `[x0,x1]×[y0,y1]`
  touches (clipped to the span when centred, below).
- `uHbIndoorOn`: float, 1 when at least one box was written, else 0.
- `mask.uniforms` = `{ uHbIndoorBoxes, uHbIndoorBuckets, uHbIndoorOn }` (by reference).
- `INTERIOR_MASK_GLSL` (exported string, both stages, no backticks):
  declares the three uniforms and `bool hbIndoorAt(vec3 p)` — the same test as
  `contains(x, y, z)` (worldRoot-local AC metres). Cost in an occupied bucket:
  1 head + ceil(n/4) id texels + n AABB texels + 5 more for every box whose
  world AABB holds the point (stacked multi-floor cells overlap); an empty or
  foreign slot costs the head only.
- `mask.gpuContainsMirror(x, y, z)` — JS port of `hbIndoorAt` over the CPU arrays.
  The node tests hold it to `contains()`; only the browser readback smoke holds
  the GLSL to it.

**Player-centred writes (2026-10-23, review parity-1 / lifecycle-1 / parity-2).**
Cells stay in `cellContainers3d` until their landblock is parked or evicted, and
an unpark (the PVS resweep) re-appends its cells at the END of the Map, so Map
order is neither age nor distance. Mirroring the whole map in Map order, first
come first served, lost the interiors around the player after a 4-landblock walk
(29 % of 0x42D0's indoor ground to 0x3ED0's: two buckets on one slot), after a
dungeon → town trip (all of Holtburg's after the Training Academy: the row cap)
and next to one huge-cell landblock (0xF930). So:
- `mask.setGpuCenter(x, y, z, reachM)` — the caller's centre every frame (the
  provider: the player, `reachM` = the outermost ring's half extent), BEFORE
  `sync()`. It only records the centre and flags a rewrite when one is due (no
  write has used a centre yet; the centre moved more than
  `D = indoorGpuRecentreM(reachM) = clamp(384 − reachM − 24, 16, 160)` on x or
  on y since the last WRITE — 160 m at reach 200, 40 m at reach 320; or `reachM`
  changed by more than 1 cm); `sync()` does the write, so there is at most ONE
  write per `sync()`. A re-centre never changes `sync()`'s return or
  `lastChanged()`. Non-finite x / y are ignored.
- The write: candidates = boxes whose finite world AABB meets the 64-bucket span
  centred on the centre's bucket (`[cb − 32, cb + 31]` per axis, ±384 m); every
  box's bucket loop is clipped to that span, so no two kept buckets share a slot
  (no fold, by construction). Candidates sort nearest-first by the 3D distance
  from the centre to the box's world AABB (2D when z is not finite), ties in Map
  order; the first 2048 get rows and each bucket keeps its first 48 ids in that
  order, so a cap drops the farthest.
- GROUND FIRST (`opts.oracle`: a terrain oracle with `lookup(lbKey).heights` and
  `version()`, or a getter of one): a box whose z range misses every terrain
  height under its AABB can never cull a blade, so it sorts after every box that
  can (unknown terrain counts as "can"). A priority, never a filter; a capped
  write is re-ranked when `oracle.version()` moves, at the cell-check cadence.
  The provider passes it the same oracle getter as the field (fix-verify
  2026-10-23: without it, the 0xF830 valley loses 80 of 250 indoor ground
  points of the hilltop bucket (3989, 757) at the DEFAULT reach 200, and the
  0x0101 world corner loses 33 % at reach 320; with it, 0).
- The reach square stays inside the span up to an outer ring of 344 m. URL
  flags can exceed that (`?terrainGrassRadius=48&terrainGrassReach=8` = 384 m):
  the far band past the span is then not interior-culled, and D sits at its
  16 m floor.
- Before the first `setGpuCenter()` the old write stays: every box in Map order,
  unclipped, a contested slot to the first bucket (`stats().gpuCentered` false).
- `stats()` (never thrown, always counted): `gpuBoxes` rows written,
  `gpuCandidates`, `gpuBoxOverflow` candidates past 2048, `gpuOverflow` ids of
  boxes WITH a row that a full bucket dropped, `gpuCollisions` (uncentred only;
  0 when centred), `gpuMaxPerBucket` (every candidate, before either cap),
  `gpuCentered`, `gpuCenter`, `gpuReach`, `gpuRecentres`, `gpuOffGround`,
  `gpuGroundRewrites`, `gpuRefreshes`, `gpu`. On the GPU, dropped boxes' blades
  live.

## Module C — `scene3d/grass_gpu_place.js` (new)

Placement GLSL + JS mirror + tile culling, THREE-free (pure strings and math).

- `GRASS_GPU_HASH_GLSL` — `hbHashU32` / `hbHash01` above.
- `buildGrassPlaceGlsl()` → string: the variant table GENERATED from
  `GRASS_VARIANTS` ∩ `familyForCode(code) === FAM_GRASS` as GLSL constants/branches
  (no uniform arrays — keeps the vertex uniform count low and every ring on ONE
  program), the per-ring uniforms below, two structs and the functions, split in
  two halves (2026-10-23, review integ-1 / gpu-cost-1) so the provider's shader
  can skip the expensive one:
  ```glsl
  struct HbBlade { bool live; vec3 origin; vec3 normal; vec2 scale; float rot; vec3 tint; float mat; float rank; };
  struct HbCell { bool mapped; ivec2 g; vec2 xy; };
  HbCell  hbGrassCell(int id);         // instance -> world cell -> step 1 (integer maths + 2 hashes)
  float   hbGrassRank(HbCell hc);      // rand(7): the blade rank AND the early-out's dissolve rank
  HbBlade hbGrassDead(HbCell hc);      // the dead blade: origin (xy, 0), every field defined
  HbBlade hbGrassPlaceCell(HbCell hc); // steps 2..10 (interior last, see GPU order)
  HbBlade hbGrassPlace(int id);        // = hbGrassPlaceCell(hbGrassCell(id)), bit-identical to before
  ```
  It REQUIRES `TERRAIN_FIELD_GLSL` and `INTERIOR_MASK_GLSL` to precede it (the
  injector concatenates: hash, field, indoor, place) and nothing else (no
  distance-blend or dissolve uniform), so a standalone readback program compiles
  it as is.
- Per-ring uniforms (`GRASS_GPU_RING_UNIFORMS`, 12):
  `uGpWindowMin` vec2 (integer-valued cell indices), `uGpGrid` float (g),
  `uGpCellSize` float, `uGpJitter` float, `uGpTileSide` float (ts),
  `uGpTiles` vec4[16] (tile ids, -1 = unused),
  `uGpSeed` uint, `uGpRandSeed` uint, `uGpBaseSeed` uint, `uGpHeightOffset` float,
  `uGpOffRoad` float (0/1), `uGpVergeM` float. There is NO tiles-per-row uniform
  (2026-10-23): T = `GRASS_GPU_TILES_PER_ROW` = 8 is a GLSL literal, so the tile
  divide and remainder are a shift and a mask.
- Instance → cell: `n = ts*ts; slot = id / n; local = id % n;
  tile = int(uGpTiles[slot >> 2][slot & 3])` (unmapped if < 0);
  `ox = (tile % 8)*ts + local % ts; oy = (tile / 8)*ts + local / ts`
  (unmapped if ≥ g); `gx = winMin.x + ox`, `gy = winMin.y + oy`.
  `ts = ceil(g / 8)`, so 8·ts ≥ g.
- Mirrors, split the same way: `grassGpuCellMirror(id, ring)`,
  `grassGpuRankMirror(cell, ring)`, `grassGpuPlaceCellMirror(cell, ring, terrain,
  indoor)` and `grassGpuPlaceMirror(id, ring, terrain, indoor)` (= the two in a
  row, same output as before) — JS ports returning the same fields, f32 by
  default (`{ f64: true }` for the CPU's own arithmetic). `terrain` is anything
  with `sampleMirror(x, y)` (Module A) — or an adapter over `oracle.sample()`;
  `indoor` anything with `gpuContainsMirror(x, y, z)` or null.
- `grassGpuRingState(ring, cfg)` → `{ g, cell, ts, T, seed, randSeed, baseSeed,
  jitter, heightOffsetM, winMin, tileIds, ... }` — the uniform values for one
  ring, computed from the layout exactly as the CPU pool would. No dissolve
  `band` (2026-10-23, review lifecycle-3): `setLodLook` REPLACES `ring.band`, so a
  copy goes stale; readers take the live `ring.band`.
- `cullGrassTiles(p, out)` — pure: `p = { winMin:[x,y], g, ts, T, cell,
  center:[x,y], outerR, holeR, planes /* array of [nx,ny,nz,d] in OBJECT space,
  or null = no frustum */, zRange(x0,y0,x1,y1) -> {min,max}|null, camPos:[x,y,z]|null,
  xyMarginM, zAboveM }`.
  A tile is culled when: `zRange` is null (no resident terrain → every blade is
  dead), its rect is entirely outside the disc `outerR`, entirely inside the hole
  `holeR` (the ring's dissolve band start `band[0]`; ≤ 0 = no hole), or its
  FRUSTUM box is outside any plane. The frustum box is the tile rect grown by
  `xyMarginM` sideways and its terrain z range grown by 0.5 m below and
  `zAboveM` above (both default 2 m, `GRASS_GPU_CULL_XY_MARGIN_M` /
  `GRASS_GPU_CULL_ABOVE_M`): a blade's geometry reaches past its origin (lean,
  bow, wind, stomp splay, an outer ring's widened blades), so a tile whose
  ORIGINS sit just outside a side plane can still draw a sliver on the screen
  edge. The disc and hole tests need no margin (a blade at the rim already has
  zero scale). LIVE MARGINS (2026-10-23, review integ-2): the provider passes
  `max(2 m, grassGpuBladeReach(look))` per draw from the ring's live uniforms
  (height gain, bow, wind amplitude / direction, flutter, lean, stomp splay /
  bend when the trail can reach a sized blade of the ring), so `setLod()` and
  `?treeWindStrength` cannot cull visible blades; the 2 m values are FLOORS (the
  default look reaches ≤ 1.55 m sideways, ≤ 1.44 m up).
  Writes surviving tile ids into `out` (Float32Array(64), rest −1), sorted
  NEAREST-FIRST by distance from `camPos` (or `center`), returns the count.

## Integration — `scene3d/terrain_grass.js`

- `resolveGrassConfig` carries `gpu` (override > `terrainGrassGpuEnabled()`).
- `vfx_flags.js`: `terrainGrassGpuEnabled()`. DEFAULT ON since 2026-10-23
  (owner, after the 1070 session; queue batch-GG). The escape is `off` / `0` /
  `false` / `no` (any case); `on` is accepted, and anything else warns once and
  keeps ON. Memoised, reset by `_resetVfxFlags`.
- GPU build (THREE present): one shared `createTerrainFieldGpu`, the interior
  mask created with `{ THREE, gpu: true, oracle }` (GROUND FIRST; `gpu: true` keeps the mirror's
  arrays without THREE too: node, `?nullRender=1`; the CPU path still calls
  `createInteriorMask()` with no args = CPU mode); per ring an `InstancedBufferGeometry` copy of the
  blade geometry with NO instanced attributes, a `THREE.Mesh` (not InstancedMesh —
  no 7.7 MB identity instanceMatrix), `frustumCulled = false`, `castShadow =
  false`, and an `onBeforeRender(renderer, scene, camera)` that builds the
  object-space frustum (`proj × camera.matrixWorldInverse × mesh.matrixWorld`,
  `Frustum.setFromProjectionMatrix(m, WebGLCoordinateSystem, camera.reversedDepth)`
  exactly like three r184's renderer), runs `cullGrassTiles` with the live
  margins (Module C), writes `uGpTiles` and sets
  `geometry.instanceCount = count * ts * ts` (0 is safe — three's
  `renderInstances` returns on primcount 0). An override pass
  (`scene.overrideMaterial`) cannot place a blade, so it draws nothing (accepted
  residue: the only such pass today, `portal_stencil.js`, renders a layer grass
  is not on, so the CPU path draws no grass there either).
- Material: the SAME `MeshLambertMaterial` setup; `onBeforeCompile` binds the
  ring bag (shared objects by reference + ring-owned ones) and injects the GPU
  variant of the grass shader: the six `attribute` declarations become plain
  globals assigned at the very top of `main()` (before `beginnormal_vertex` reads
  `aNormal`) by the placement block: `HbCell c = hbGrassCell(gl_InstanceID)`;
  the distance blend and the dissolve of `c.xy` / `hbGrassRank(c)`, generated
  from the same helpers as the vertex snippet's (`_grassFadeFactor`,
  `_grassDissolveGlsl`, `_grassDissolveFactor`); then
  `c.mapped && fade > 0 && dissolve > 0 ? hbGrassPlaceCell(c) : hbGrassDead(c)`
  (the VIEW EARLY-OUT, see GPU order; each factor is tested on its own, so f32
  underflow of their product cannot matter). `hbWorld = origin.xy`;
  `vVfxHash = vfxHash01(origin.xy)` re-assigned right after
  `VFX_HASH_ASSIGN_VERTEX` (the CPU path hashes `instanceMatrix[3].xy`, i.e. the
  same point); a live blade runs the look and ends `transformed = origin + hbP`,
  a dead blade SKIPS the look and collapses all five vertices onto its origin
  (both branches write `transformed` and `vGrassTint`). Rings share ONE program.
- THE vVfxHash RESIDUE (accepted). The GPU computes the origin in f32 from the
  cell (two f32 roundings), the CPU stores its f64 origin as f32 (one), so about
  60–70 % of GPU origins sit one f32 step (3.9 mm at Holtburg) from the CPU's.
  `vfxHash01` is chaotic at that scale, so per-blade bow / wind phases differ
  between the paths: statistically the same field, not the same pixels. The
  smoke's frame compare zeroes bow and wind for that reason and reports a
  default-bow pair as info only.
- Per frame `update()`: uTime / stomp as today,
  `indoorMask.setGpuCenter(p.x, p.y, p.z, outermost ring radius)` (finite p
  only) THEN `indoorMask.sync()` (no invalidation needed — the textures
  refresh; Module B), `field.update(p.x, p.y)`, and per
  ring `uGpWindowMin`, `uScatterCenter` (player), `uScatterRadius = W`,
  `uScatterFadeStart = W*(1 - fadeFraction)`, `uScatterShape = 0` (disc).
- `setOffRoad` writes `uGpOffRoad` on every ring; `setLodLook` as today (culling
  reads the live `ring.band`).
- `stats()`: `mode: "gpu"|"cpu"`, per-ring `tilesDrawn`, `instancesDrawn`,
  `cullXyMarginM`, `cullAboveM` (the margins the last cull used),
  `field.stats()`, indoor stats (`indoorCull`, Module B); `visibleBlades` = instances drawn on the last
  render (an upper bound — documented). `_pool`/`pool` are null in GPU mode:
  every reader must stay null-safe (grep `__terrainGrass`, `_pool`).
- Flag off ⇒ the CPU path, byte-identical.

## Validation

- Node: `test_terrain_field_gpu.mjs` (A: `sampleMirror` vs `oracle.sample()` on
  real Holtburg landblocks from `~/ac_base_dats/client_cell_1.dat` — reuse the DAT
  reader in `test_terrain_grass_offroad.mjs`), `test_grass_interior_mask_gpu.mjs`
  (B: mirror vs `contains()`, centring policy, real walks / dungeon trips / huge
  cells), `test_grass_gpu_place.mjs` (C: hash bit-identity, split cutoff, the
  split + reorder vs the original order, culling and live margins, GLSL string
  hygiene), `test_terrain_grass_gpu.mjs` (integration: GPU mirror vs the CPU
  provider's pools, per ring, by world cell, on real landblocks; the early-out vs
  the CPU's zero-size decision; provider GPU build with real three; flag; stats;
  the fingerprint lock). These hold the JS MIRRORS to the CPU; only the hash
  GLSL is interpreted in node. No node test runs the field, mask or placement
  GLSL.
- Browser (orchestrator only, `capped-build`, one browser):
  `harness/glsl_smoke/grass_gpu_smoke.mjs` + `grass_gpu_page.html`, real three,
  real modules, real DAT data for two regions (Holtburg 0xA9B4 and the 0x4993
  housing, 5×5 landblocks + the 3×3 of EnvCells each) in one oracle and one cell
  map, the mask centred per spot like the provider's:
  1. READBACK: the real GLSL (`hbGrassPlace`, fragment AND vertex stage) read
     back from an RGBA32F MRT, every ring with all 64 tiles, vs the CPU pool by
     world cell. Two configs (20000 / 24 m / 4 rings, 10000 / 24 m single
     field) × three spots (Holtburg centre; the owner's road screenshot; the
     centre of 0x4993's fullest 12 m bucket, 43 ids, so ids 17–48 run through
     the real loop). GATES (2026-10-23, review tests-2): per ring, mismatches +
     field outliers ≤ max(5, 0.5 % of the ring's CPU live); summed over the
     rings ≤ max(8, 0.2 %); every cell mapped once; every pixel written. A
     1.5–2 % flip confined to one ring fails (dry-run below).
  2. INTERIOR ARM (Holtburg, 0x4993): the same readback with `uHbIndoorOn`
     forced to 0; the per-cell set of blades the mask flips live → dead on the
     GPU must equal the f32 mirror's (`gpuContainsMirror` vs no mask) within
     max(3, 1 % of the mirror's), with no dead → live flip and no other change;
     non-empty for the 4-ring config at both spots; at 0x4993 some GPU kills
     must come from a bucket id at slot ≥ 16. (The CPU's `indoorRejects` is
     not the reference: it counts exclusions before the variant / bare / keep
     steps, cumulatively.) Every spot's mask must be centred with nothing
     dropped, and 0x4993's fullest bucket must hold > 16 ids.
  3. FRAME COMPARE: the real provider, gpu off vs on (the GPU arm through the
     view early-out and the dead branch), wind and bow zeroed (the vVfxHash
     residue), < 1 % of pixels over 8 levels and < 0.2 % once 1-px edge
     jitter is forgiven.
  RESULTS: 2026-10-23, SwiftShader, BEFORE the review fixes (two spots,
  uncentred mask, no interior arm, aggregate gate only): PASS, readback
  0.024–0.046 % (worst ring 2 of 3093; single field worst 3 of 6730), frame
  0.18 % of pixels (0.05 % tolerant). The fixed harness was dry-run in node
  against an emulated renderer whose readback is the f32 mirror (all 12
  readbacks and 8 interior arms pass; a 1.5–2 % flip in any one ring, a mask
  that reads only the first 16 / 12 / 8 / 4 ids of a bucket, and the old
  all-ring 2 % flip each fail); it has NOT run in a browser yet.
- THE STAMP RULE (2026-10-23, review tests-1): on PASS the smoke writes
  `harness/glsl_smoke/grass_gpu_smoke.stamp.json` = { the sha256 fingerprint of
  the shipped GLSL (`harness/glsl_smoke/grass_gpu_fingerprint.mjs`: the hash,
  field, mask and placement GLSL plus the injected GPU vertex and fragment
  shader over a fixed stub, with the generated variant-table lines normalised
  out), its part hashes, `passedAt`, the renderer, the rates }. The node gate
  (`test_terrain_grass_gpu.mjs` G7) fails while the current fingerprint differs
  from the stamp's or no stamp exists: any GLSL edit — including the SHARED CPU
  grass snippets inside the injected shader — needs
  `capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs` re-run (it
  rewrites the stamp on PASS; a FAIL never touches it). A look-table tweak
  (heights, tints, keep, bare, a new grass code) does not trip it.
- Bench (node): CPU vs GPU main-thread update cost on a simulated run.
