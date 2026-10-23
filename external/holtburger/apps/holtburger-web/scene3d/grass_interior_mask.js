// scene3d/grass_interior_mask.js — `?grassIndoorCull` (2026-10-08, DEFAULT ON;
// `=off` escape).
//
// Owner on the 1070, Holtburg: "there is grass poking through the building
// interior cells". Grass is a camera-scoped scatter over the TERRAIN
// (terrain_grass.js), and a building's floor sits a few centimetres to a few
// decimetres above the terrain under it, so blades planted on that terrain grew
// straight up through the cottage floors — visible through every window and
// doorway, and all around the player once inside. Retail never had grass, and
// its scenery rule (CLandBlock::get_land_scenes / ACE Landblock.get_land_scenes:
// no scenery in an outdoor cell that has_building) is far too coarse for blades
// — it would empty every 24 m cell of a town.
//
// THE FIX uses the interior cells themselves. Every building interior is a set
// of EnvCells, which cells.js already builds for the player's 3x3 landblocks
// (ENVCELL_RING_RADIUS = 1 — wider than the 40 m grass radius). A cell's
// STRUCTURE meshes (its `mesh-<cellId>` group; the props hang off the
// container instead and are ignored) give an oriented box in the cell's own
// frame. A blade whose ground point falls inside a GROUND-LEVEL cell box, grown
// by a 0.25 m wall margin, is rejected at placement. Ground level means the
// ground point lies between 1 m below the cell's floor and 0.5 m under its
// ceiling, so a cellar (ceiling at the ground) or an upper storey never culls a
// lawn. The index is rebuilt when the set of loaded cells changes (checked every
// 30 frames) and the pool then re-examines its blades over its normal amortised
// laps. CPU only, at placement time: no draw, no uniform, no program change.
//
// Coordinates: the scatter pool works in worldRoot-local space (AC metres,
// Z up); cell boxes are taken into the same space through worldRoot's inverse
// world matrix, so the mask is independent of the AC -> three axis rotation.
//
// 2026-10-23 — THE GPU MIRROR (docs/2026-10-23-grass-gpu-placement.md, Module
// B). `?terrainGrassGpu` places blades in the vertex shader, so the same test
// has to run there. In GPU mode (`opts.gpu`, default `!!opts.THREE`) the mask
// ALSO keeps two flat Float32Arrays (`gpu: true` without THREE keeps them too,
// so the JS mirror is testable in node) and, given `opts.THREE`, two RGBA32F
// DataTextures over them:
//   uHbIndoorBoxes   8 x 2048. Row i = box i: texels 0..2 the rows of its
//                    affine `inv` (worldRoot-local -> cell-local), 3 / 4 the
//                    interval with contains()'s margins pre-applied, 5 its
//                    world AABB (contains()'s first test, so a box that is not
//                    upright still matches exactly), 6..7 unused.
//   uHbIndoorBuckets 832 x 64. 12 m buckets folded onto 64 x 64 slots (the
//                    fold repeats every 768 m = 4 landblocks on each axis):
//                    per slot a head texel (bx, by, count, 1) then 12 texels
//                    of up to 48 box indices (-1 = empty).
// `hbIndoorAt(p)` (INTERIOR_MASK_GLSL) is the shader test and
// gpuContainsMirror() its line-by-line JS port over the same arrays.
//
// PLAYER-CENTRED (2026-10-23, review parity-1 / lifecycle-1 / parity-2). The
// cell map is NOT only the player's 3x3 ring: cells stay in cellContainers3d
// until their landblock is parked or evicted, and an unpark re-appends them at
// the END of the Map, so Map order is neither age nor distance. Mirroring the
// whole map in Map order, first come first served, lost the interiors around
// the player after a 4-LB walk (29 % of 0x42D0's indoor ground coming from
// 0x3ED0: two buckets on one slot), after a dungeon -> town trip (all of
// Holtburg's after the Training Academy: the 1024-row cap then) and next to one
// huge-cell LB (0xF930). So the caller gives the mask a centre every frame,
// `setGpuCenter(x, y, z, reachM)` (reachM = the outermost grass ring's
// half-extent), and the arrays are written around it:
//   - candidates = the boxes whose finite world AABB meets the 64-bucket span
//     centred on the centre's bucket cb, [cb - 32, cb + 31] on each axis, and
//     every box's bucket loop is CLIPPED to that span, so no two kept buckets
//     can share a slot (no fold, by construction);
//   - the candidates sort nearest-first by the 3D distance from the centre to
//     the box's world AABB (2D when z is not finite), ties in Map order; the
//     first 2048 get rows and each bucket keeps its first 48 ids in that order,
//     so a cap drops the farthest (deep dungeon cells under a surface LB lose to
//     the ground-level cells around the player);
//   - GROUND FIRST, given `opts.oracle` (a terrain oracle, or a getter of one,
//     with `lookup(lbKey).heights`): a box whose z range misses every terrain
//     height under its AABB (groundClassOf) can never cull a blade, so it
//     sorts after every box that can (or whose terrain is not resident yet).
//     Distance alone is not enough: 0xF930 holds 1526 cells, most of them
//     inside a hill at the same heights as the ground-level cells 130 m away,
//     and with a 1024-row cap distance-only lost 56 % (reach 200) / 71 % (reach
//     320) of the indoor ground there; around the world-corner dungeon LBs
//     (0x0101: 3402 candidates) even 2048 rows lose 33 % at reach 320 without
//     it, 0 with it. A capped write (something dropped) is re-ranked when the oracle's
//     version() moves, at the cell-check cadence (terrain that streamed in
//     after the cells). Rows went 1024 -> 2048 for the same spots: with them
//     0xF930's 3x3 (1980 boxes) fits whole even before its terrain is known;
//     2048 is WebGL2's minimum MAX_TEXTURE_SIZE, and the GLSL never names it;
//   - a rewrite is requested when no write has used a centre yet, when the
//     centre moved more than D on either axis since the last write (the fold is
//     per axis), or when reachM changed (by more than 1 cm, so a reach the
//     caller recomputes every frame cannot rewrite every frame).
//     D = indoorGpuRecentreM(reachM) = clamp(384 - reachM - 24, 16, 160): the
//     span covers at least [c - 384, c + 372) around the written centre c, so
//     the reach square stays inside it with 12 m to spare (up to reachM 344;
//     the default tiers reach 200 m and ?terrainGrassReach=8 320 m, but URL
//     flags can go past 344, e.g. ?terrainGrassRadius=48&terrainGrassReach=8 =
//     384 m: the far band past the span is then not culled on the GPU (its
//     blades live, sub-pixel at that range) and D sits at its 16 m floor);
//   - setGpuCenter() only records and flags; sync(), which runs every frame,
//     performs the write (or the rebuild of a cell-set change does, with the
//     current centre, and clears the flag). So there is at most ONE write per
//     sync() call, i.e. per frame, however the two interleave.
// Before the first setGpuCenter() the old behaviour stays: every box in Map
// order, buckets unclipped, a contested slot to the first bucket (stats
// gpuCentered false). What does not fit (> 2048 candidates, > 48 ids in one
// bucket, uncentred: two buckets on one slot) is dropped and counted in
// stats(), never thrown: on the GPU those blades live. The textures refresh
// (needsUpdate) in rebuild(), in the sync() clear path and on a re-centre, but
// never to rewrite all-zero arrays with zeros.
//
// CPU MODE (`opts.gpu` false: the default without THREE, what the shipping
// CPU grass path creates): no arrays, no textures, no GPU writes; the
// uniforms hold null textures and uHbIndoorOn 0, setGpuCenter() is a no-op
// returning false and gpuContainsMirror() always returns false. In both modes
// the CPU path (contains(), sync()'s return, lastChanged) is unchanged, and a
// re-centre never touches it.

/** Metres the box grows sideways — the interior faces sit inside the walls. */
export const INDOOR_CULL_WALL_MARGIN_M = 0.25;
/** The ground may lie this far below a cell's floor and still count as under it. */
export const INDOOR_CULL_BELOW_FLOOR_M = 1.0;
/** ...and must lie at least this far under the cell's ceiling (cellars). */
export const INDOOR_CULL_UNDER_CEILING_M = 0.5;
/** Frames between checks of the loaded cell set. */
export const INDOOR_CULL_CHECK_FRAMES = 30;
const BUCKET_M = 24;

// --- 2026-10-23 GPU mirror layout (see the header) --------------------------
/** Box rows in uHbIndoorBoxes (its height). 2026-10-23: 1024 -> 2048 (see the
 *  header, GROUND FIRST): 2048 is WebGL2's guaranteed MAX_TEXTURE_SIZE. */
export const INDOOR_GPU_MAX_BOXES = 2048;
/** Texels per box row (its width): inv rows x3, lo, hi, world AABB, 2 spare. */
export const INDOOR_GPU_BOX_TEXELS = 8;
/** Side of a GPU bucket, metres (the CPU index uses 24 m). */
export const INDOOR_GPU_BUCKET_M = 12;
/** Bucket slots per axis; bucket (bx, by) lives at slot (bx & 63, by & 63). */
export const INDOOR_GPU_BUCKET_SLOTS = 64;
/** Texels per slot: the head + 12 texels of box indices (48 ids). The world's
 *  fullest 12 m bucket of building cells holds 43 (dense housing, e.g. 0x4993;
 *  scan of client_cell_1.dat, 2026-10-23); 16 dropped 17% of indoor ground
 *  there. A bucket holds EVERY EnvCell, dungeon cells too, so real buckets can
 *  pass 48 (52 next to 0xF930); centred, a full bucket keeps its first 48 in
 *  the write's order (ground first with an oracle, then nearest).
 *  The shader loop stops at the bucket's count, so sparse buckets pay nothing
 *  extra. */
export const INDOOR_GPU_BUCKET_TEXELS = 13;
/** Box indices a bucket can hold. */
export const INDOOR_GPU_BUCKET_CAP = (INDOOR_GPU_BUCKET_TEXELS - 1) * 4;
/** Half the side of the written span around the centre's bucket, metres (384). */
export const INDOOR_GPU_SPAN_HALF_M = (INDOOR_GPU_BUCKET_SLOTS / 2) * INDOOR_GPU_BUCKET_M;
/** setGpuCenter()'s reachM when the caller passes none (the default config's outer ring). */
export const INDOOR_GPU_DEFAULT_REACH_M = 200;
/**
 * The re-centre distance D for a reach: a centre that moved more than D on
 * either axis since the last write asks for a rewrite (see the header).
 */
export function indoorGpuRecentreM(reachM) {
  return Math.min(160, Math.max(16, INDOOR_GPU_SPAN_HALF_M - reachM - 2 * INDOOR_GPU_BUCKET_M));
}
const BOX_FLOATS = INDOOR_GPU_BOX_TEXELS * 4;
const HALF_SLOTS = INDOOR_GPU_BUCKET_SLOTS / 2;
const DIRTY_CENTRE = 1, DIRTY_GROUND = 2;
const BUCKET_TEX_W = INDOOR_GPU_BUCKET_SLOTS * INDOOR_GPU_BUCKET_TEXELS;
const SLOT_MASK = INDOOR_GPU_BUCKET_SLOTS - 1;
const glf = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * The shader side of the mask (GLSL ES 3.00, vertex or fragment stage):
 * the three uniforms of `mask.uniforms` and `bool hbIndoorAt(vec3 p)` — the
 * contains(x, y, z) test, p in worldRoot-local AC metres (z = ground height).
 */
export const INTERIOR_MASK_GLSL = `
uniform highp sampler2D uHbIndoorBoxes;
uniform highp sampler2D uHbIndoorBuckets;
uniform highp float uHbIndoorOn;
// One candidate box (fi = its row; -1 = an empty slot): the world AABB, then
// the cell-local interval with the wall / floor / ceiling margins pre-applied.
bool hbIndoorBox(float fi, vec3 p) {
  if (fi < 0.0) return false;
  int i = int(fi);
  vec4 ab = texelFetch(uHbIndoorBoxes, ivec2(5, i), 0);
  if (p.x < ab.x || p.x > ab.z || p.y < ab.y || p.y > ab.w) return false;
  vec4 p4 = vec4(p, 1.0);
  vec3 q = vec3(
    dot(texelFetch(uHbIndoorBoxes, ivec2(0, i), 0), p4),
    dot(texelFetch(uHbIndoorBoxes, ivec2(1, i), 0), p4),
    dot(texelFetch(uHbIndoorBoxes, ivec2(2, i), 0), p4));
  vec3 lo = texelFetch(uHbIndoorBoxes, ivec2(3, i), 0).xyz;
  vec3 hi = texelFetch(uHbIndoorBoxes, ivec2(4, i), 0).xyz;
  return all(greaterThanEqual(q, lo)) && all(lessThanEqual(q, hi));
}
bool hbIndoorAt(vec3 p) {
  if (uHbIndoorOn < 0.5) return false;
  ivec2 b = ivec2(floor(p.xy / ${glf(INDOOR_GPU_BUCKET_M)}));
  int sx = (b.x & ${SLOT_MASK}) * ${INDOOR_GPU_BUCKET_TEXELS};
  int sy = b.y & ${SLOT_MASK};
  vec4 head = texelFetch(uHbIndoorBuckets, ivec2(sx, sy), 0);
  // An empty slot, or one holding another bucket (a fold): nothing indoors.
  if (head.w < 0.5 || int(head.x) != b.x || int(head.y) != b.y) return false;
  int n = int(head.z);
  for (int t = 0; t < ${INDOOR_GPU_BUCKET_TEXELS - 1}; t++) {
    if (t * 4 >= n) break;
    vec4 ids = texelFetch(uHbIndoorBuckets, ivec2(sx + 1 + t, sy), 0);
    if (hbIndoorBox(ids.x, p) || hbIndoorBox(ids.y, p) || hbIndoorBox(ids.z, p) || hbIndoorBox(ids.w, p)) return true;
  }
  return false;
}
`;

function indoorDataTexture(THREE, data, w, h, name) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.name = name;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** `?grassIndoorCull=off` escape; default on. */
export function grassIndoorCullEnabled(search) {
  try {
    const s = search ?? (typeof window !== "undefined" ? window.location?.search : "") ?? "";
    const v = new URLSearchParams(s).get("grassIndoorCull");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// --- column-major 4x4 helpers (three's Matrix4.elements layout) -------------

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** a * b */
export function mat4Mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** Inverse of an affine matrix (any invertible 3x3 + translation); null if singular. */
export function mat4AffineInverse(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  const r00 = A * k, r01 = -(b * i - c * h) * k, r02 = (b * f - c * e) * k;
  const r10 = B * k, r11 = (a * i - c * g) * k, r12 = -(a * f - c * d) * k;
  const r20 = C * k, r21 = -(a * h - b * g) * k, r22 = (a * e - b * d) * k;
  const tx = m[12], ty = m[13], tz = m[14];
  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    -(r00 * tx + r01 * ty + r02 * tz), -(r10 * tx + r11 * ty + r12 * tz), -(r20 * tx + r21 * ty + r22 * tz), 1,
  ];
}

function apply(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

function elementsOf(obj) {
  const e = obj && obj.matrixWorld && obj.matrixWorld.elements;
  return e && e.length === 16 ? e : null;
}

function walkMeshes(o, fn) {
  if (!o) return;
  if (o.isMesh) fn(o);
  const kids = o.children;
  if (kids) for (let i = 0; i < kids.length; i += 1) walkMeshes(kids[i], fn);
}

function structureGroupOf(container) {
  const kids = container && container.children;
  if (!kids) return null;
  for (let i = 0; i < kids.length; i += 1) {
    const k = kids[i];
    if (k && typeof k.name === "string" && k.name.startsWith("mesh-")) return k;
  }
  return null;
}

/**
 * One cell's box: {inv, min, max, x0, y0, x1, y1, z0, z1} or null (no structure
 * mesh yet / degenerate). `rootInv` maps world -> worldRoot-local. 2026-10-23:
 * z0 / z1 = the world z extent of the cell-local box (only the GPU mirror's
 * write order reads it: the 3D distance and GROUND FIRST; contains() does not).
 */
export function cellBoxFor(container, rootInv) {
  const mg = structureGroupOf(container);
  // A container added since the last render still has a default matrixWorld;
  // bring the chain current the way the renderer would (TRS for auto-update
  // nodes, the authored matrix otherwise) before reading it.
  if (mg && typeof mg.updateWorldMatrix === "function") {
    try { mg.updateWorldMatrix(true, true); } catch (_) { /* read what is there */ }
  }
  const mgW = elementsOf(mg);
  if (!mgW) return null;
  const mgInv = mat4AffineInverse(mgW);
  if (!mgInv) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const p = [0, 0, 0];
  walkMeshes(mg, (mesh) => {
    const g = mesh.geometry;
    if (!g) return;
    if (!g.boundingBox && typeof g.computeBoundingBox === "function") {
      try { g.computeBoundingBox(); } catch (_) { return; }
    }
    const bb = g.boundingBox;
    const mw = elementsOf(mesh);
    if (!bb || !mw || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return;
    const rel = mesh === mg ? IDENTITY : mat4Mul(mgInv, mw);
    for (let c = 0; c < 8; c += 1) {
      apply(rel, c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z, p);
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2];
    }
  });
  if (!(x1 > x0) || !(y1 > y0) || !(z1 > z0)) return null;
  // cell-local -> worldRoot-local, and back.
  const toRoot = rootInv ? mat4Mul(rootInv, mgW) : mgW.slice();
  const inv = mat4AffineInverse(toRoot);
  if (!inv) return null;
  const m = INDOOR_CULL_WALL_MARGIN_M;
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
  for (let c = 0; c < 8; c += 1) {
    apply(toRoot, c & 1 ? x1 + m : x0 - m, c & 2 ? y1 + m : y0 - m, c & 4 ? z1 : z0, p);
    if (p[0] < wx0) wx0 = p[0]; if (p[0] > wx1) wx1 = p[0];
    if (p[1] < wy0) wy0 = p[1]; if (p[1] > wy1) wy1 = p[1];
    if (p[2] < wz0) wz0 = p[2]; if (p[2] > wz1) wz1 = p[2];
  }
  return { inv, min: [x0, y0, z0], max: [x1, y1, z1], x0: wx0, y0: wy0, x1: wx1, y1: wy1, z0: wz0, z1: wz1 };
}

const bucketKey = (bx, by) => ((bx & 0xffff) << 16 | (by & 0xffff)) >>> 0;

/**
 * 2026-10-23 — can box `e` ever hold a ground point? contains() is only asked
 * at the terrain height, so a cell whose z range misses every terrain height
 * under its AABB (a dungeon inside a hill) never culls a blade. Terrain from
 * `oracle.lookup(lbKey).heights` (column-major 9 x 9, 24 m apart): the
 * terrain over the AABB lies between the min and max of the vertices of the
 * terrain cells it overlaps. Returns 0 (never), or 1 (it may, or unknown: a
 * landblock not resident, no lookup, off-world). Conservative: the tilt and
 * the under-ceiling margin are not used, plus 0.5 m of slack.
 */
function groundClassOf(oracle, e) {
  if (!oracle || typeof oracle.lookup !== "function" || !Number.isFinite(e.z0) || !Number.isFinite(e.z1)) return 1;
  const V = 24;
  const gx0 = Math.floor(e.x0 / V), gx1 = Math.ceil(e.x1 / V), gy0 = Math.floor(e.y0 / V), gy1 = Math.ceil(e.y1 / V);
  if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 1024) return 1;
  let lo = Infinity, hi = -Infinity, key = -1, hs = null;
  for (let gx = gx0; gx <= gx1; gx += 1) {
    const lbX = Math.min(Math.floor(gx / 8), 255), col = gx - lbX * 8;
    if (lbX < 0 || col > 8) return 1;
    for (let gy = gy0; gy <= gy1; gy += 1) {
      const lbY = Math.min(Math.floor(gy / 8), 255), row = gy - lbY * 8;
      if (lbY < 0 || row > 8) return 1;
      const k = ((lbX << 24) | (lbY << 16)) >>> 0;
      if (k !== key) {
        key = k;
        let ent = null;
        try { ent = oracle.lookup(k); } catch (_) { ent = null; }
        hs = ent && ent.heights && ent.heights.length >= 81 ? ent.heights : null;
      }
      if (!hs) return 1;
      const h = hs[col * 9 + row];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return hi >= e.z0 - INDOOR_CULL_BELOW_FLOOR_M - 0.5 && lo <= e.z1 + 0.5 ? 1 : 0;
}

/**
 * The mask. `sync(scene3d)` once per frame (cheap: a signature walk every
 * INDOOR_CULL_CHECK_FRAMES frames) returns true when the index changed — the
 * caller then re-examines its blades. `contains(x, y, z)` is the placement test
 * in worldRoot-local metres.
 *
 * 2026-10-23 — `opts.gpu` (default `!!opts.THREE`) keeps the GPU mirror's
 * arrays; `opts.THREE` (optional, injected) adds its two DataTextures;
 * `opts.oracle` (optional: a terrain oracle with `lookup()` / `version()`, or
 * a getter returning one or null, e.g. `() => ctx.oracle`) turns on GROUND
 * FIRST. `mask.uniforms` (bind BY REFERENCE), `setGpuCenter()` and
 * `gpuContainsMirror(x, y, z)` exist in both modes (inert in CPU mode).
 */
export function createInteriorMask(opts = {}) {
  const checkFrames = Math.max(1, opts.checkFrames ?? INDOOR_CULL_CHECK_FRAMES);
  let frame = 0;
  let signature = "";
  let entries = [];
  let buckets = new Map();
  // 2026-10-08 — cellId -> box of the last build, to report WHICH boxes a
  // rebuild added or removed (null = "everything": first build / cleared).
  let boxById = new Map();
  let changed = null;
  const st = {
    rebuilds: 0, cells: 0, boxes: 0, pending: 0, tests: 0, hits: 0,
    // 2026-10-23 — the GPU arrays as last written (zero / false / null in CPU
    // mode): rows written (gpuBoxes = min(gpuCandidates, 2048)), bucket slots
    // held, ids of boxes WITH a row that a full bucket dropped (gpuOverflow),
    // buckets dropped on a taken slot (uncentred only; 0 by construction when
    // centred), candidates past INDOOR_GPU_MAX_BOXES (gpuBoxOverflow), the
    // fullest bucket counting EVERY candidate, row or not, before either cap
    // (gpuMaxPerBucket), and how many times the textures were refreshed.
    gpuBoxes: 0, gpuBuckets: 0, gpuOverflow: 0, gpuCollisions: 0, gpuBoxOverflow: 0,
    gpuMaxPerBucket: 0, gpuRefreshes: 0,
    // 2026-10-23 — centring: the boxes the last write considered (those that
    // meet the span when centred, every box when not), whether it used a
    // centre, that centre {x, y} and reach (or null), the writes a
    // setGpuCenter() asked for; GROUND FIRST: the candidates that cannot
    // touch the ground (sorted last; 0 without opts.oracle) and the re-ranks
    // a terrain change asked for.
    gpuCandidates: 0, gpuCentered: false, gpuCenter: null, gpuReach: null, gpuRecentres: 0,
    gpuOffGround: 0, gpuGroundRewrites: 0,
  };
  const p = [0, 0, 0];

  // 2026-10-23 — the GPU mirror's arrays (GPU mode) and textures (+ THREE).
  const gpuOn = opts.gpu != null ? !!opts.gpu : !!opts.THREE;
  const THREE = gpuOn && opts.THREE ? opts.THREE : null;
  const boxData = gpuOn ? new Float32Array(BOX_FLOATS * INDOOR_GPU_MAX_BOXES) : null;
  const bucketData = gpuOn ? new Float32Array(BUCKET_TEX_W * INDOOR_GPU_BUCKET_SLOTS * 4) : null;
  const uniforms = {
    uHbIndoorBoxes: { value: THREE ? indoorDataTexture(THREE, boxData, INDOOR_GPU_BOX_TEXELS, INDOOR_GPU_MAX_BOXES, "hb-indoor-boxes") : null },
    uHbIndoorBuckets: { value: THREE ? indoorDataTexture(THREE, bucketData, BUCKET_TEX_W, INDOOR_GPU_BUCKET_SLOTS, "hb-indoor-buckets") : null },
    uHbIndoorOn: { value: 0 },
  };
  // The centre of the last setGpuCenter() (hasCenter false = never: the
  // uncentred mode) and the one the arrays were last written around.
  let hasCenter = false, cX = 0, cY = 0, cZ = NaN, cReach = INDOOR_GPU_DEFAULT_REACH_M;
  let hasWritten = false, wX = 0, wY = 0, wReach = 0;
  // The rewrites asked for and not done yet (DIRTY_* bits: setGpuCenter(), a
  // terrain change under a capped write); whether both arrays are all zero
  // (fresh, or the last write held no box); whether the last write was
  // centred with an oracle AND dropped something, and the oracle version it
  // ranked with.
  let gpuDirty = 0, gpuZero = true, writtenCapped = false, writtenVer = null;
  const oracleNow = () => {
    let o = null;
    try { o = typeof opts.oracle === "function" ? opts.oracle() : opts.oracle; } catch (_) { o = null; }
    return o && typeof o.lookup === "function" ? o : null;
  };

  /**
   * Rewrite both GPU arrays from `list` (the boxes, in Map order): centred
   * around the last setGpuCenter() once there is one, else the old way.
   */
  function writeGpu(list) {
    if (!gpuOn) return;
    if (gpuDirty & DIRTY_CENTRE) st.gpuRecentres += 1;
    if (gpuDirty & DIRTY_GROUND) st.gpuGroundRewrites += 1;
    gpuDirty = 0;
    const B = INDOOR_GPU_BUCKET_M;
    let cand = list, sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0, orc = null, offGround = 0;
    if (hasCenter) {
      const cbx = Math.floor(cX / B), cby = Math.floor(cY / B);
      sx0 = cbx - HALF_SLOTS; sx1 = cbx + HALF_SLOTS - 1;
      sy0 = cby - HALF_SLOTS; sy1 = cby + HALF_SLOTS - 1;
      const near = [];
      const useZ = Number.isFinite(cZ);
      orc = oracleNow();
      for (let i = 0; i < list.length; i += 1) {
        const e = list[i];
        if (!(Number.isFinite(e.x0) && Number.isFinite(e.y0) && Number.isFinite(e.x1) && Number.isFinite(e.y1))) continue;
        if (Math.floor(e.x1 / B) < sx0 || Math.floor(e.x0 / B) > sx1 || Math.floor(e.y1 / B) < sy0 || Math.floor(e.y0 / B) > sy1) continue;
        const dx = Math.max(e.x0 - cX, 0, cX - e.x1), dy = Math.max(e.y0 - cY, 0, cY - e.y1);
        const dz = useZ && Number.isFinite(e.z0) && Number.isFinite(e.z1) ? Math.max(e.z0 - cZ, 0, cZ - e.z1) : 0;
        const g = orc ? groundClassOf(orc, e) : 1;
        if (!g) offGround += 1;
        near.push({ e, i, d: dx * dx + dy * dy + dz * dz, g });
      }
      near.sort((a, b) => b.g - a.g || a.d - b.d || a.i - b.i);
      cand = near.map((c) => c.e);
      hasWritten = true; wX = cX; wY = cY; wReach = cReach;
    }
    const n = Math.min(cand.length, INDOOR_GPU_MAX_BOXES);
    st.gpuCandidates = cand.length;
    st.gpuCentered = hasCenter;
    st.gpuCenter = hasCenter ? { x: cX, y: cY } : null;
    st.gpuReach = hasCenter ? cReach : null;
    st.gpuOffGround = offGround;
    writtenVer = null;
    if (orc && typeof orc.version === "function") { try { writtenVer = orc.version(); } catch (_) { writtenVer = null; } }
    writtenCapped = false;
    if (n === 0 && gpuZero) {
      // Nothing to hold and nothing held: the arrays are already all zero.
      st.gpuBoxes = 0; st.gpuBuckets = 0; st.gpuOverflow = 0; st.gpuCollisions = 0;
      st.gpuBoxOverflow = 0; st.gpuMaxPerBucket = 0;
      uniforms.uHbIndoorOn.value = 0;
      return;
    }
    boxData.fill(0);
    bucketData.fill(0);
    const W = INDOOR_CULL_WALL_MARGIN_M;
    const lists = new Map();
    let overflow = 0, collisions = 0, maxPer = 0, slots = 0;
    for (let i = 0; i < cand.length; i += 1) {
      const e = cand[i], row = i < n;
      if (row) {
        const inv = e.inv, o = i * BOX_FLOATS;
        boxData[o] = inv[0]; boxData[o + 1] = inv[4]; boxData[o + 2] = inv[8]; boxData[o + 3] = inv[12];
        boxData[o + 4] = inv[1]; boxData[o + 5] = inv[5]; boxData[o + 6] = inv[9]; boxData[o + 7] = inv[13];
        boxData[o + 8] = inv[2]; boxData[o + 9] = inv[6]; boxData[o + 10] = inv[10]; boxData[o + 11] = inv[14];
        boxData[o + 12] = e.min[0] - W; boxData[o + 13] = e.min[1] - W; boxData[o + 14] = e.min[2] - INDOOR_CULL_BELOW_FLOOR_M;
        boxData[o + 16] = e.max[0] + W; boxData[o + 17] = e.max[1] + W; boxData[o + 18] = e.max[2] - INDOOR_CULL_UNDER_CEILING_M;
        boxData[o + 20] = e.x0; boxData[o + 21] = e.y0; boxData[o + 22] = e.x1; boxData[o + 23] = e.y1;
      }
      if (!(Number.isFinite(e.x0) && Number.isFinite(e.y0) && Number.isFinite(e.x1) && Number.isFinite(e.y1))) continue;
      let bx0 = Math.floor(e.x0 / B), by0 = Math.floor(e.y0 / B);
      let bx1 = Math.floor(e.x1 / B), by1 = Math.floor(e.y1 / B);
      if (hasCenter) {
        // Clipped to the span: 64 buckets a side, one slot each.
        if (bx0 < sx0) bx0 = sx0; if (bx1 > sx1) bx1 = sx1;
        if (by0 < sy0) by0 = sy0; if (by1 > sy1) by1 = sy1;
      } else {
        // A box wider than the whole slot grid already covers every slot; the
        // rest of it would only fold onto itself.
        const nx = bx1 - bx0 + 1, ny = by1 - by0 + 1;
        const cx = Math.min(nx, INDOOR_GPU_BUCKET_SLOTS), cy = Math.min(ny, INDOOR_GPU_BUCKET_SLOTS);
        if (row) collisions += nx * ny - cx * cy;
        bx1 = bx0 + cx - 1; by1 = by0 + cy - 1;
      }
      for (let bx = bx0; bx <= bx1; bx += 1) {
        for (let by = by0; by <= by1; by += 1) {
          const k = bx * 65536 + by;
          let b = lists.get(k);
          if (!b) { b = { bx, by, ids: [], total: 0 }; lists.set(k, b); }
          b.total += 1;
          if (row) b.ids.push(i);
        }
      }
    }
    // A bucket keeps its first INDOOR_GPU_BUCKET_CAP rows (row order: nearest
    // first when centred), a slot the first bucket that lands on it (only
    // uncentred can two buckets meet on one slot).
    for (const b of lists.values()) {
      if (b.total > maxPer) maxPer = b.total;
      if (b.ids.length === 0) continue;
      const h = ((b.by & SLOT_MASK) * BUCKET_TEX_W + (b.bx & SLOT_MASK) * INDOOR_GPU_BUCKET_TEXELS) * 4;
      if (bucketData[h + 3] !== 0) { collisions += 1; continue; }
      const count = Math.min(b.ids.length, INDOOR_GPU_BUCKET_CAP);
      overflow += b.ids.length - count;
      bucketData[h] = b.bx; bucketData[h + 1] = b.by; bucketData[h + 2] = count; bucketData[h + 3] = 1;
      for (let k = 0; k < INDOOR_GPU_BUCKET_CAP; k += 1) bucketData[h + 4 + k] = k < count ? b.ids[k] : -1;
      slots += 1;
    }
    st.gpuBoxes = n;
    st.gpuBuckets = slots;
    st.gpuOverflow = overflow;
    st.gpuCollisions = collisions;
    st.gpuBoxOverflow = cand.length - n;
    st.gpuMaxPerBucket = maxPer;
    writtenCapped = writtenVer !== null && (cand.length > n || overflow > 0);
    gpuZero = n === 0;
    uniforms.uHbIndoorOn.value = n > 0 ? 1 : 0;
    if (uniforms.uHbIndoorBoxes.value) uniforms.uHbIndoorBoxes.value.needsUpdate = true;
    if (uniforms.uHbIndoorBuckets.value) uniforms.uHbIndoorBuckets.value.needsUpdate = true;
    st.gpuRefreshes += 1;
  }

  /**
   * 2026-10-23 — the GPU arrays' centre (see the header): x, y, z in the
   * worldRoot-local AC metres of contains(), reachM = the outermost grass
   * ring's half-extent. Only records the centre and, when a rewrite is due,
   * flags it for the next sync(); returns true when this call asked for one.
   * Non-finite x / y are ignored (false); CPU mode: a no-op (false).
   */
  function setGpuCenter(x, y, z, reachM) {
    if (!gpuOn || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    const reach = Number.isFinite(reachM) && reachM >= 0 ? reachM : INDOOR_GPU_DEFAULT_REACH_M;
    hasCenter = true;
    cX = x; cY = y; cZ = Number.isFinite(z) ? z : NaN; cReach = reach;
    const d = indoorGpuRecentreM(reach);
    const due = !hasWritten || Math.abs(reach - wReach) > 0.01 || Math.abs(x - wX) > d || Math.abs(y - wY) > d;
    if (due) gpuDirty |= DIRTY_CENTRE;
    return due;
  }

  function signatureOf(map) {
    let sum = 0, meshes = 0;
    for (const [id, c] of map) {
      sum = (sum + (id >>> 0)) >>> 0;
      walkMeshes(structureGroupOf(c), () => { meshes += 1; });
    }
    return `${map.size}:${sum}:${meshes}`;
  }

  function rebuild(map, root) {
    if (root && typeof root.updateWorldMatrix === "function") {
      try { root.updateWorldMatrix(true, false); } catch (_) { /* read what is there */ }
    }
    const rootW = elementsOf(root);
    const rootInv = rootW ? mat4AffineInverse(rootW) : null;
    const nextEntries = [];
    const nextBuckets = new Map();
    const nextById = new Map();
    let pending = 0;
    for (const [id, c] of map) {
      const box = cellBoxFor(c, rootInv);
      if (!box) { pending += 1; continue; }
      nextEntries.push(box);
      nextById.set(id, box);
      const bx0 = Math.floor(box.x0 / BUCKET_M), bx1 = Math.floor(box.x1 / BUCKET_M);
      const by0 = Math.floor(box.y0 / BUCKET_M), by1 = Math.floor(box.y1 / BUCKET_M);
      for (let bx = bx0; bx <= bx1; bx += 1) {
        for (let by = by0; by <= by1; by += 1) {
          const k = bucketKey(bx, by);
          let list = nextBuckets.get(k);
          if (!list) { list = []; nextBuckets.set(k, list); }
          list.push(box);
        }
      }
    }
    // The boxes that appeared or disappeared since the last build (the first
    // build reports all of its boxes as added).
    changed = [];
    for (const [id, b] of nextById) if (!boxById.has(id)) changed.push([b.x0, b.y0, b.x1, b.y1]);
    for (const [id, b] of boxById) if (!nextById.has(id)) changed.push([b.x0, b.y0, b.x1, b.y1]);
    boxById = nextById;
    entries = nextEntries;
    buckets = nextBuckets;
    st.rebuilds += 1;
    st.cells = map.size;
    st.boxes = nextEntries.length;
    st.pending = pending;
    writeGpu(nextEntries);
  }

  function sync(scene3d) {
    frame += 1;
    const check = (frame - 1) % checkFrames === 0;
    const r = check ? checkCells(scene3d) : false;
    // 2026-10-23 — GROUND FIRST: a capped write ranked with older terrain is
    // re-ranked, at the cell-check cadence (never faster while it streams).
    if (check && writtenCapped && !gpuDirty) {
      const o = oracleNow();
      let v = null;
      if (o && typeof o.version === "function") { try { v = o.version(); } catch (_) { v = null; } }
      if (v !== null && v !== writtenVer) gpuDirty |= DIRTY_GROUND;
    }
    // The rewrite asked for, unless checkCells() just rebuilt or cleared (that
    // write used the current centre and took the flags): one GPU write per
    // sync() at most. Never touches r.
    if (gpuDirty) writeGpu(entries);
    return r;
  }

  /** The cell-set check of every checkFrames-th sync() (the old sync() body). */
  function checkCells(scene3d) {
    const map = scene3d && scene3d.cellContainers3d;
    if (!(map instanceof Map) || map.size === 0) {
      if (entries.length === 0 && signature === "") return false;
      changed = [...boxById.values()].map((b) => [b.x0, b.y0, b.x1, b.y1]);
      entries = []; buckets = new Map(); signature = ""; st.cells = 0; st.boxes = 0;
      boxById = new Map();
      writeGpu(entries);
      return true;
    }
    const sig = signatureOf(map);
    if (sig === signature) return false;
    signature = sig;
    rebuild(map, scene3d.worldRoot || null);
    return true;
  }

  function contains(x, y, z) {
    if (entries.length === 0) return false;
    const list = buckets.get(bucketKey(Math.floor(x / BUCKET_M), Math.floor(y / BUCKET_M)));
    if (!list) return false;
    st.tests += 1;
    const m = INDOOR_CULL_WALL_MARGIN_M;
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      if (x < e.x0 || x > e.x1 || y < e.y0 || y > e.y1) continue;
      apply(e.inv, x, y, z, p);
      if (p[0] < e.min[0] - m || p[0] > e.max[0] + m) continue;
      if (p[1] < e.min[1] - m || p[1] > e.max[1] + m) continue;
      if (p[2] < e.min[2] - INDOOR_CULL_BELOW_FLOOR_M || p[2] > e.max[2] - INDOOR_CULL_UNDER_CEILING_M) continue;
      st.hits += 1;
      return true;
    }
    return false;
  }

  // 2026-10-23 — hbIndoorAt, line for line, over the same arrays (Float32, as
  // uploaded); it touches no counters. The node tests hold this mirror to
  // contains(); only the browser readback smoke (harness/glsl_smoke) holds
  // the GLSL to the mirror, so a GLSL edit needs that smoke re-run.
  function gpuBoxMirror(fi, x, y, z) {
    if (fi < 0) return false;
    const o = Math.trunc(fi) * BOX_FLOATS;
    const B = boxData;
    if (x < B[o + 20] || x > B[o + 22] || y < B[o + 21] || y > B[o + 23]) return false;
    const qx = B[o] * x + B[o + 1] * y + B[o + 2] * z + B[o + 3];
    const qy = B[o + 4] * x + B[o + 5] * y + B[o + 6] * z + B[o + 7];
    const qz = B[o + 8] * x + B[o + 9] * y + B[o + 10] * z + B[o + 11];
    return qx >= B[o + 12] && qy >= B[o + 13] && qz >= B[o + 14]
      && qx <= B[o + 16] && qy <= B[o + 17] && qz <= B[o + 18];
  }

  /** CPU mode (no arrays): always false. */
  function gpuContainsMirror(x, y, z) {
    if (!bucketData || uniforms.uHbIndoorOn.value < 0.5) return false;
    const bx = Math.floor(x / INDOOR_GPU_BUCKET_M), by = Math.floor(y / INDOOR_GPU_BUCKET_M);
    const sx = (bx & SLOT_MASK) * INDOOR_GPU_BUCKET_TEXELS;
    const sy = by & SLOT_MASK;
    const D = bucketData;
    const h = (sy * BUCKET_TEX_W + sx) * 4;
    if (D[h + 3] < 0.5 || Math.trunc(D[h]) !== bx || Math.trunc(D[h + 1]) !== by) return false;
    const n = Math.trunc(D[h + 2]);
    for (let t = 0; t < INDOOR_GPU_BUCKET_TEXELS - 1; t += 1) {
      if (t * 4 >= n) break;
      const o = h + (1 + t) * 4;
      if (gpuBoxMirror(D[o], x, y, z) || gpuBoxMirror(D[o + 1], x, y, z)
        || gpuBoxMirror(D[o + 2], x, y, z) || gpuBoxMirror(D[o + 3], x, y, z)) return true;
    }
    return false;
  }

  return {
    sync,
    contains,
    /**
     * After a sync() that returned true: the world AABBs [x0, y0, x1, y1] of
     * the boxes that rebuild added or removed.
     */
    lastChanged: () => changed,
    stats: () => ({ ...st, gpuCenter: st.gpuCenter && { ...st.gpuCenter }, enabled: true, gpu: gpuOn }),
    /** 2026-10-23 — `{ uHbIndoorBoxes, uHbIndoorBuckets, uHbIndoorOn }`, by reference. */
    uniforms,
    setGpuCenter,
    gpuContainsMirror,
    /** Frees the GPU copies of the textures (the objects stay bound). */
    dispose() {
      if (uniforms.uHbIndoorBoxes.value) uniforms.uHbIndoorBoxes.value.dispose();
      if (uniforms.uHbIndoorBuckets.value) uniforms.uHbIndoorBuckets.value.dispose();
    },
    _boxData: boxData,
    _bucketData: bucketData,
  };
}
