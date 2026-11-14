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
/** Expanded exterior footprint padding (+0.65 m) around solid foundations, bridges, and plazas. */
export const EXTERIOR_CULL_WALL_MARGIN_M = 0.65;
/** Tight exterior wall-arm padding (+0.30 m) on decomposed courtyard / perimeter walls. */
export const EXTERIOR_ARM_WALL_MARGIN_M = 0.30;
/** Tight ground-footprint padding (+0.15 m) around ground-level statics / portal pads. */
export const STATIC_CULL_WALL_MARGIN_M = 0.15;
/** Ground-near local Z slice (m) inspected for building footprints (ignores roofs/overhangs). */
export const BUILDING_FOOTPRINT_MAX_Z = 3.0;
/** Ground-level local Z slice (m) inspected for static props / LOD portal pads (ignores arches/canopies). */
export const STATIC_FOOTPRINT_MAX_Z = 0.8;
/** 8x8 occupancy threshold below which a large (> 4 m) mesh is decomposed into wall-arm sub-boxes. */
export const HOLLOW_FOOTPRINT_FILL_MAX = 0.55;
/** Minimum XY span (m) before hollow / L-wall footprint decomposition applies. */
export const HOLLOW_FOOTPRINT_MIN_SPAN_M = 4.0;
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
  if (o.isLOD && Array.isArray(o.levels) && o.levels.length > 0 && o.levels[0]?.object) {
    walkMeshes(o.levels[0].object, fn);
    return;
  }
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
  return { inv, min: [x0, y0, z0], max: [x1, y1, z1], x0: wx0, y0: wy0, x1: wx1, y1: wy1, z0: wz0, z1: wz1, indoor: true };
}

function meshHasCutoutOrAlpha(mesh) {
  const mat = mesh && mesh.material;
  if (!mat) return false;
  if (Array.isArray(mat)) {
    for (let i = 0; i < mat.length; i += 1) {
      const m = mat[i];
      if (m && (m.alphaTest > 0 || m.transparent === true)) return true;
    }
    return false;
  }
  return mat.alphaTest > 0 || mat.transparent === true;
}

function uprightYawFrame(toRoot) {
  let ux = toRoot[0], uy = toRoot[1];
  const len = Math.hypot(ux, uy);
  if (len > 1e-4) { ux /= len; uy /= len; } else { ux = 1; uy = 0; }
  const tx = toRoot[12], ty = toRoot[13], tz = toRoot[14];
  const frame = [
    ux, uy, 0, 0,
    -uy, ux, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ];
  const inv = mat4AffineInverse(frame);
  return inv ? { frame, inv } : null;
}

const _FOOTPRINT_GRID = 8;
const _FOOTPRINT_CELLS = _FOOTPRINT_GRID * _FOOTPRINT_GRID;
const _zInX = new Float64Array(4);
const _zInY = new Float64Array(4);
const _zInZ = new Float64Array(4);
const _zOutX = new Float64Array(6);
const _zOutY = new Float64Array(6);
const _zOutZ = new Float64Array(6);
const _c2aX = new Float64Array(12);
const _c2aY = new Float64Array(12);
const _c2bX = new Float64Array(12);
const _c2bY = new Float64Array(12);
const _occ = new Uint8Array(_FOOTPRINT_CELLS);
const _cov = new Uint8Array(_FOOTPRINT_CELLS);
const _cMinX = new Float64Array(_FOOTPRINT_CELLS);
const _cMaxX = new Float64Array(_FOOTPRINT_CELLS);
const _cMinY = new Float64Array(_FOOTPRINT_CELLS);
const _cMaxY = new Float64Array(_FOOTPRINT_CELLS);

function _clipTriZMax(ax, ay, az, bx, by, bz, cx, cy, cz, zMax) {
  if (az > zMax && bz > zMax && cz > zMax) return 0;
  _zInX[0] = ax; _zInY[0] = ay; _zInZ[0] = az;
  _zInX[1] = bx; _zInY[1] = by; _zInZ[1] = bz;
  _zInX[2] = cx; _zInY[2] = cy; _zInZ[2] = cz;
  if (az <= zMax && bz <= zMax && cz <= zMax) {
    _zOutX[0] = ax; _zOutY[0] = ay; _zOutZ[0] = az;
    _zOutX[1] = bx; _zOutY[1] = by; _zOutZ[1] = bz;
    _zOutX[2] = cx; _zOutY[2] = cy; _zOutZ[2] = cz;
    return 3;
  }
  let outN = 0;
  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    const x1 = _zInX[i], y1 = _zInY[i], z1 = _zInZ[i];
    const x2 = _zInX[j], y2 = _zInY[j], z2 = _zInZ[j];
    const in1 = z1 <= zMax;
    const in2 = z2 <= zMax;
    if (in1) {
      _zOutX[outN] = x1; _zOutY[outN] = y1; _zOutZ[outN] = z1;
      outN += 1;
    }
    if (in1 !== in2) {
      const dz = z2 - z1;
      const t = Math.abs(dz) > 1e-12 ? (zMax - z1) / dz : 0;
      _zOutX[outN] = x1 + (x2 - x1) * t;
      _zOutY[outN] = y1 + (y2 - y1) * t;
      _zOutZ[outN] = zMax;
      outN += 1;
    }
  }
  return outN;
}

function _clip2DBox(x0, y0, x1, y1, x2, y2, bx0, by0, bx1, by1) {
  _c2aX[0] = x0; _c2aY[0] = y0;
  _c2aX[1] = x1; _c2aY[1] = y1;
  _c2aX[2] = x2; _c2aY[2] = y2;
  let n = 3;
  // x >= bx0
  let m = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const px = _c2aX[i], py = _c2aY[i], qx = _c2aX[j], qy = _c2aY[j];
    const pIn = px >= bx0 - 1e-9, qIn = qx >= bx0 - 1e-9;
    if (pIn) { _c2bX[m] = px; _c2bY[m] = py; m += 1; }
    if (pIn !== qIn) {
      const t = (bx0 - px) / (qx - px);
      _c2bX[m] = bx0; _c2bY[m] = py + (qy - py) * t; m += 1;
    }
  }
  if (m === 0) return 0;
  // x <= bx1
  n = 0;
  for (let i = 0; i < m; i += 1) {
    const j = (i + 1) % m;
    const px = _c2bX[i], py = _c2bY[i], qx = _c2bX[j], qy = _c2bY[j];
    const pIn = px <= bx1 + 1e-9, qIn = qx <= bx1 + 1e-9;
    if (pIn) { _c2aX[n] = px; _c2aY[n] = py; n += 1; }
    if (pIn !== qIn) {
      const t = (bx1 - px) / (qx - px);
      _c2aX[n] = bx1; _c2aY[n] = py + (qy - py) * t; n += 1;
    }
  }
  if (n === 0) return 0;
  // y >= by0
  m = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const px = _c2aX[i], py = _c2aY[i], qx = _c2aX[j], qy = _c2aY[j];
    const pIn = py >= by0 - 1e-9, qIn = qy >= by0 - 1e-9;
    if (pIn) { _c2bX[m] = px; _c2bY[m] = py; m += 1; }
    if (pIn !== qIn) {
      const t = (by0 - py) / (qy - py);
      _c2bX[m] = px + (qx - px) * t; _c2bY[m] = by0; m += 1;
    }
  }
  if (m === 0) return 0;
  // y <= by1
  n = 0;
  for (let i = 0; i < m; i += 1) {
    const j = (i + 1) % m;
    const px = _c2bX[i], py = _c2bY[i], qx = _c2bX[j], qy = _c2bY[j];
    const pIn = py <= by1 + 1e-9, qIn = qy <= by1 + 1e-9;
    if (pIn) { _c2aX[n] = px; _c2aY[n] = py; n += 1; }
    if (pIn !== qIn) {
      const t = (by1 - py) / (qy - py);
      _c2aX[n] = px + (qx - px) * t; _c2aY[n] = by1; n += 1;
    }
  }
  return n;
}

function _attachFootprintMeta(boxes, fillFraction, occupiedCells, dx, dy, fullDz, maxLocalZ) {
  boxes.fillFraction = fillFraction;
  boxes.occupiedCells = occupiedCells;
  boxes.gridN = _FOOTPRINT_GRID;
  boxes.dx = dx;
  boxes.dy = dy;
  boxes.fullDz = fullDz;
  boxes._maxLocalZ = maxLocalZ;
  return boxes;
}

/**
 * Inspect ground-near geometry (`localZ <= maxLocalZ`) on an 8x8 local 2D grid,
 * memoized once per BufferGeometry in `geometry.userData.__grassFootprintBoxes`.
 * Hollow / L-shaped / perimeter courtyard walls (`fillFraction < 0.55` and
 * `max(dx, dy) > 4.0 m`, such as Shoushi's `0x01000E62` and `0x01000E77`) are
 * decomposed into 1-4 tight wall-arm sub-boxes instead of one giant yard-killing AABB.
 */
export function analyzeGeometryFootprint(geometry, maxLocalZ = BUILDING_FOOTPRINT_MAX_Z) {
  if (!geometry || typeof geometry !== "object") {
    return _attachFootprintMeta([], 0, 0, 0, 0, 0, maxLocalZ);
  }
  const ud = geometry.userData || (geometry.userData = {});
  const cachedMain = ud.__grassFootprintBoxes;
  if (Array.isArray(cachedMain) && cachedMain._maxLocalZ === maxLocalZ) return cachedMain;
  if (maxLocalZ !== BUILDING_FOOTPRINT_MAX_Z && Array.isArray(ud.__grassStaticFootprint)
    && ud.__grassStaticFootprint._maxLocalZ === maxLocalZ) {
    return ud.__grassStaticFootprint;
  }

  const pos = geometry.attributes && geometry.attributes.position;
  const vCount = pos && typeof pos.count === "number" ? pos.count : 0;
  if (vCount <= 0) {
    if (!geometry.boundingBox && typeof geometry.computeBoundingBox === "function") {
      try { geometry.computeBoundingBox(); } catch (_) { /* ignore */ }
    }
    const bb = geometry.boundingBox;
    if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x) || bb.min.z > maxLocalZ) {
      const empty = _attachFootprintMeta([], 0, 0, 0, 0, 0, maxLocalZ);
      if (!Array.isArray(ud.__grassFootprintBoxes) || maxLocalZ === BUILDING_FOOTPRINT_MAX_Z) ud.__grassFootprintBoxes = empty;
      if (maxLocalZ !== BUILDING_FOOTPRINT_MAX_Z) ud.__grassStaticFootprint = empty;
      return empty;
    }
    const dx = Math.max(0, bb.max.x - bb.min.x);
    const dy = Math.max(0, bb.max.y - bb.min.y);
    const fullDz = Math.max(0, bb.max.z - bb.min.z);
    const single = _attachFootprintMeta([
      { x0: bb.min.x, y0: bb.min.y, x1: bb.max.x, y1: bb.max.y, z0: bb.min.z, z1: Math.min(bb.max.z, maxLocalZ), hollowArm: false },
    ], 1, _FOOTPRINT_CELLS, dx, dy, fullDz, maxLocalZ);
    if (!Array.isArray(ud.__grassFootprintBoxes) || maxLocalZ === BUILDING_FOOTPRINT_MAX_Z) ud.__grassFootprintBoxes = single;
    if (maxLocalZ !== BUILDING_FOOTPRINT_MAX_Z) ud.__grassStaticFootprint = single;
    return single;
  }

  const getX = typeof pos.getX === "function" ? (k) => pos.getX(k) : (k) => pos.array[k * (pos.itemSize || 3)];
  const getY = typeof pos.getY === "function" ? (k) => pos.getY(k) : (k) => pos.array[k * (pos.itemSize || 3) + 1];
  const getZ = typeof pos.getZ === "function" ? (k) => pos.getZ(k) : (k) => pos.array[k * (pos.itemSize || 3) + 2];

  const idxAttr = geometry.index;
  const idxCount = idxAttr && typeof idxAttr.count === "number" ? idxAttr.count : 0;
  const getIdx = idxCount > 0
    ? (typeof idxAttr.getX === "function" ? (k) => idxAttr.getX(k) : (k) => idxAttr.array[k])
    : null;
  const triCount = idxCount >= 3 ? Math.floor(idxCount / 3) : Math.floor(vCount / 3);

  let fullMinZ = Infinity, fullMaxZ = -Infinity;
  let gx0 = Infinity, gy0 = Infinity, gz0 = Infinity;
  let gx1 = -Infinity, gy1 = -Infinity, gz1 = -Infinity;

  for (let v = 0; v < vCount; v += 1) {
    const vx = getX(v), vy = getY(v), vz = getZ(v);
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) continue;
    if (vz < fullMinZ) fullMinZ = vz;
    if (vz > fullMaxZ) fullMaxZ = vz;
    if (vz <= maxLocalZ) {
      if (vx < gx0) gx0 = vx; if (vx > gx1) gx1 = vx;
      if (vy < gy0) gy0 = vy; if (vy > gy1) gy1 = vy;
      if (vz < gz0) gz0 = vz; if (vz > gz1) gz1 = vz;
    }
  }
  for (let t = 0; t < triCount; t += 1) {
    const i0 = getIdx ? getIdx(t * 3) : t * 3;
    const i1 = getIdx ? getIdx(t * 3 + 1) : t * 3 + 1;
    const i2 = getIdx ? getIdx(t * 3 + 2) : t * 3 + 2;
    if (i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;
    const cn = _clipTriZMax(
      getX(i0), getY(i0), getZ(i0),
      getX(i1), getY(i1), getZ(i1),
      getX(i2), getY(i2), getZ(i2),
      maxLocalZ,
    );
    for (let k = 0; k < cn; k += 1) {
      const px = _zOutX[k], py = _zOutY[k], pz = _zOutZ[k];
      if (px < gx0) gx0 = px; if (px > gx1) gx1 = px;
      if (py < gy0) gy0 = py; if (py > gy1) gy1 = py;
      if (pz < gz0) gz0 = pz; if (pz > gz1) gz1 = pz;
    }
  }

  const fullDz = fullMaxZ >= fullMinZ ? fullMaxZ - fullMinZ : 0;
  if (!(gx1 > gx0) && !(gy1 > gy0)) {
    const empty = _attachFootprintMeta([], 0, 0, 0, 0, fullDz, maxLocalZ);
    if (!Array.isArray(ud.__grassFootprintBoxes) || maxLocalZ === BUILDING_FOOTPRINT_MAX_Z) ud.__grassFootprintBoxes = empty;
    if (maxLocalZ !== BUILDING_FOOTPRINT_MAX_Z) ud.__grassStaticFootprint = empty;
    return empty;
  }

  const dx = Math.max(0, gx1 - gx0);
  const dy = Math.max(0, gy1 - gy0);
  const cw = Math.max(dx, 1e-3) / _FOOTPRINT_GRID;
  const ch = Math.max(dy, 1e-3) / _FOOTPRINT_GRID;
  _occ.fill(0);
  _cMinX.fill(Infinity); _cMaxX.fill(-Infinity);
  _cMinY.fill(Infinity); _cMaxY.fill(-Infinity);

  for (let v = 0; v < vCount; v += 1) {
    const vz = getZ(v);
    if (!(vz <= maxLocalZ)) continue;
    const vx = getX(v), vy = getY(v);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
    const ix = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((vx - gx0) / cw)));
    const iy = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((vy - gy0) / ch)));
    const ci = iy * _FOOTPRINT_GRID + ix;
    _occ[ci] = 1;
    if (vx < _cMinX[ci]) _cMinX[ci] = vx;
    if (vx > _cMaxX[ci]) _cMaxX[ci] = vx;
    if (vy < _cMinY[ci]) _cMinY[ci] = vy;
    if (vy > _cMaxY[ci]) _cMaxY[ci] = vy;
  }

  for (let t = 0; t < triCount; t += 1) {
    const i0 = getIdx ? getIdx(t * 3) : t * 3;
    const i1 = getIdx ? getIdx(t * 3 + 1) : t * 3 + 1;
    const i2 = getIdx ? getIdx(t * 3 + 2) : t * 3 + 2;
    if (i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;
    const cn = _clipTriZMax(
      getX(i0), getY(i0), getZ(i0),
      getX(i1), getY(i1), getZ(i1),
      getX(i2), getY(i2), getZ(i2),
      maxLocalZ,
    );
    if (cn < 3) continue;
    for (let sub = 0; sub < cn - 2; sub += 1) {
      const x0 = _zOutX[0], y0 = _zOutY[0];
      const x1 = _zOutX[sub + 1], y1 = _zOutY[sub + 1];
      const x2 = _zOutX[sub + 2], y2 = _zOutY[sub + 2];
      const tx0 = Math.min(x0, x1, x2), tx1 = Math.max(x0, x1, x2);
      const ty0 = Math.min(y0, y1, y2), ty1 = Math.max(y0, y1, y2);
      const ix0 = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((tx0 - gx0) / cw)));
      const ix1 = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((tx1 - gx0) / cw)));
      const iy0 = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((ty0 - gy0) / ch)));
      const iy1 = Math.max(0, Math.min(_FOOTPRINT_GRID - 1, Math.floor((ty1 - gy0) / ch)));
      for (let iy = iy0; iy <= iy1; iy += 1) {
        const by0 = gy0 + iy * ch;
        const by1 = iy === _FOOTPRINT_GRID - 1 ? gy1 : by0 + ch;
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const bx0 = gx0 + ix * cw;
          const bx1 = ix === _FOOTPRINT_GRID - 1 ? gx1 : bx0 + cw;
          const pn = _clip2DBox(x0, y0, x1, y1, x2, y2, bx0, by0, bx1, by1);
          if (pn > 0) {
            const ci = iy * _FOOTPRINT_GRID + ix;
            _occ[ci] = 1;
            for (let k = 0; k < pn; k += 1) {
              const cxp = _c2aX[k], cyp = _c2aY[k];
              if (cxp < _cMinX[ci]) _cMinX[ci] = cxp;
              if (cxp > _cMaxX[ci]) _cMaxX[ci] = cxp;
              if (cyp < _cMinY[ci]) _cMinY[ci] = cyp;
              if (cyp > _cMaxY[ci]) _cMaxY[ci] = cyp;
            }
          }
        }
      }
    }
  }

  let occupiedCells = 0;
  for (let ci = 0; ci < _FOOTPRINT_CELLS; ci += 1) occupiedCells += _occ[ci];
  const fillFraction = occupiedCells / _FOOTPRINT_CELLS;
  const boxes = [];

  if (occupiedCells > 0 && fillFraction < HOLLOW_FOOTPRINT_FILL_MAX && Math.max(dx, dy) > HOLLOW_FOOTPRINT_MIN_SPAN_M) {
    _cov.fill(0);
    for (let arm = 0; arm < 4; arm += 1) {
      let bestScore = -1;
      let bIx0 = -1, bIx1 = -1, bIy0 = -1, bIy1 = -1;
      for (let iy0 = 0; iy0 < _FOOTPRINT_GRID; iy0 += 1) {
        for (let iy1 = iy0; iy1 < _FOOTPRINT_GRID; iy1 += 1) {
          const hCells = iy1 - iy0 + 1;
          for (let ix0 = 0; ix0 < _FOOTPRINT_GRID; ix0 += 1) {
            for (let ix1 = ix0; ix1 < _FOOTPRINT_GRID; ix1 += 1) {
              const wCells = ix1 - ix0 + 1;
              const area = wCells * hCells;
              let occIn = 0, newCov = 0;
              for (let y = iy0; y <= iy1; y += 1) {
                const row = y * _FOOTPRINT_GRID;
                for (let x = ix0; x <= ix1; x += 1) {
                  const o = _occ[row + x];
                  occIn += o;
                  if (o && !_cov[row + x]) newCov += 1;
                }
              }
              if (newCov === 0) continue;
              const valid = occIn === area
                || (Math.min(wCells, hCells) <= 2 && occIn * 4 >= area * 3)
                || (occIn * 10 >= area * 9);
              if (!valid) continue;
              const score = newCov * 64 + occIn;
              if (score > bestScore) {
                bestScore = score;
                bIx0 = ix0; bIx1 = ix1; bIy0 = iy0; bIy1 = iy1;
              }
            }
          }
        }
      }
      if (bestScore < 0) break;
      let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      for (let y = bIy0; y <= bIy1; y += 1) {
        const row = y * _FOOTPRINT_GRID;
        for (let x = bIx0; x <= bIx1; x += 1) {
          const ci = row + x;
          if (!_occ[ci]) continue;
          _cov[ci] = 1;
          if (_cMinX[ci] < sx0) sx0 = _cMinX[ci];
          if (_cMaxX[ci] > sx1) sx1 = _cMaxX[ci];
          if (_cMinY[ci] < sy0) sy0 = _cMinY[ci];
          if (_cMaxY[ci] > sy1) sy1 = _cMaxY[ci];
        }
      }
      if (sx1 >= sx0 && sy1 >= sy0) {
        boxes.push({ x0: sx0, y0: sy0, x1: sx1, y1: sy1, z0: gz0, z1: gz1, hollowArm: true });
      }
    }
    // Fold any leftover occupied cell into the nearest arm only when the expanded arm stays compact.
    const yardAreaCap = 0.28 * Math.max(dx * dy, 1e-3);
    for (let ci = 0; ci < _FOOTPRINT_CELLS; ci += 1) {
      if (!_occ[ci] || _cov[ci] || boxes.length === 0) continue;
      let bestK = -1, bestGrow = Infinity;
      for (let k = 0; k < boxes.length; k += 1) {
        const b = boxes[k];
        const nx0 = Math.min(b.x0, _cMinX[ci]), nx1 = Math.max(b.x1, _cMaxX[ci]);
        const ny0 = Math.min(b.y0, _cMinY[ci]), ny1 = Math.max(b.y1, _cMaxY[ci]);
        const nArea = (nx1 - nx0) * (ny1 - ny0);
        if (nArea > yardAreaCap) continue;
        const grow = nArea - (b.x1 - b.x0) * (b.y1 - b.y0);
        if (grow < bestGrow) { bestGrow = grow; bestK = k; }
      }
      if (bestK >= 0) {
        const b = boxes[bestK];
        b.x0 = Math.min(b.x0, _cMinX[ci]); b.x1 = Math.max(b.x1, _cMaxX[ci]);
        b.y0 = Math.min(b.y0, _cMinY[ci]); b.y1 = Math.max(b.y1, _cMaxY[ci]);
      }
    }
  } else if (occupiedCells > 0) {
    boxes.push({ x0: gx0, y0: gy0, x1: gx1, y1: gy1, z0: gz0, z1: gz1, hollowArm: false });
  }

  _attachFootprintMeta(boxes, fillFraction, occupiedCells, dx, dy, fullDz, maxLocalZ);
  if (!Array.isArray(ud.__grassFootprintBoxes) || maxLocalZ === BUILDING_FOOTPRINT_MAX_Z) ud.__grassFootprintBoxes = boxes;
  if (maxLocalZ !== BUILDING_FOOTPRINT_MAX_Z) ud.__grassStaticFootprint = boxes;
  return boxes;
}

function buildUprightBoxFromLocalSubBoxes(subBoxes, frameInfo, rootInv, indoorFlag, bldgFlag, wallMarginM = EXTERIOR_CULL_WALL_MARGIN_M) {
  const { frame, inv } = frameInfo;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const rw = [0, 0, 0];
  const lp = [0, 0, 0];
  for (let bi = 0; bi < subBoxes.length; bi += 1) {
    const { mw, sub } = subBoxes[bi];
    if (!mw || !sub) continue;
    const toRoot = rootInv ? mat4Mul(rootInv, mw) : mw;
    for (let c = 0; c < 8; c += 1) {
      apply(toRoot, c & 1 ? sub.x1 : sub.x0, c & 2 ? sub.y1 : sub.y0, c & 4 ? sub.z1 : sub.z0, rw);
      apply(inv, rw[0], rw[1], rw[2], lp);
      if (lp[0] < x0) x0 = lp[0]; if (lp[0] > x1) x1 = lp[0];
      if (lp[1] < y0) y0 = lp[1]; if (lp[1] > y1) y1 = lp[1];
      if (lp[2] < z0) z0 = lp[2]; if (lp[2] > z1) z1 = lp[2];
    }
  }
  if (!(x1 >= x0) || !(y1 >= y0) || !(z1 >= z0) || (!(x1 > x0) && !(y1 > y0))) return null;
  const m = INDOOR_CULL_WALL_MARGIN_M;
  const extra = wallMarginM - m;
  let ex0 = x0 - extra, ex1 = x1 + extra;
  let ey0 = y0 - extra, ey1 = y1 + extra;
  if (ex1 < ex0) { const mid = 0.5 * (x0 + x1); ex0 = mid; ex1 = mid; }
  if (ey1 < ey0) { const mid = 0.5 * (y0 + y1); ey0 = mid; ey1 = mid; }
  // Pad exterior floor/deck interval so thin bridge/plaza slabs and raised porches reject grass cleanly.
  const minZ = z0 - 1.2;
  const maxZ = z1 + INDOOR_CULL_UNDER_CEILING_M + 0.35;
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, wz0 = Infinity, wz1 = -Infinity;
  for (let c = 0; c < 8; c += 1) {
    apply(frame, c & 1 ? ex1 + m : ex0 - m, c & 2 ? ey1 + m : ey0 - m, c & 4 ? maxZ : minZ, rw);
    if (rw[0] < wx0) wx0 = rw[0]; if (rw[0] > wx1) wx1 = rw[0];
    if (rw[1] < wy0) wy0 = rw[1]; if (rw[1] > wy1) wy1 = rw[1];
    if (rw[2] < wz0) wz0 = rw[2]; if (rw[2] > wz1) wz1 = rw[2];
  }
  return {
    inv,
    min: [ex0, ey0, minZ],
    max: [ex1, ey1, maxZ],
    x0: wx0, y0: wy0, x1: wx1, y1: wy1, z0: wz0, z1: wz1,
    rawDx: x1 - x0,
    rawDy: y1 - y0,
    rawDz: z1 - z0,
    indoor: indoorFlag,
    bldg: bldgFlag,
  };
}

const _FENCE_FOLIAGE_NAME_RE = /(tree|palm|bush|shrub|flora|plant|fern|reed|grass|flower|hedge|fence|rail|post|sign|banner|lamp|torch)/i;

function isFoliageOrFenceObject(obj) {
  const n = obj && typeof obj.name === "string" ? obj.name : "";
  if (n && _FENCE_FOLIAGE_NAME_RE.test(n)) return true;
  const ud = obj && obj.userData;
  if (ud && (ud.isFoliage || ud.isTree || ud.isFence)) return true;
  return false;
}

function collectExteriorBoxes(scene3d, rootInv, outBoxes, extCache, rootKey) {
  const bKids = scene3d?.buildingsGroup?.children;
  if (Array.isArray(bKids) && bKids.length > 0) {
    for (let i = 0; i < bKids.length; i += 1) {
      const obj = bKids[i];
      if (!obj || obj.isBatchedMesh || obj.isInstancedMesh) continue;
      const childCount = Array.isArray(obj.children) ? obj.children.length : 0;
      const hit = extCache ? extCache.get(obj) : null;
      if (hit && hit.rootKey === rootKey && hit.childCount === childCount) {
        for (let hi = 0; hi < hit.items.length; hi += 1) outBoxes.push(hit.items[hi]);
        continue;
      }
      if (typeof obj.updateWorldMatrix === "function") {
        try { obj.updateWorldMatrix(true, true); } catch (_) {}
      }
      const ow = elementsOf(obj);
      if (!ow) continue;
      const fInfo = uprightYawFrame(rootInv ? mat4Mul(rootInv, ow) : ow);
      if (!fInfo) continue;
      const opaqueMeshes = [];
      walkMeshes(obj, (m) => {
        if (m.isBatchedMesh || m.isInstancedMesh) return;
        if (m.material && !Array.isArray(m.material) && m.material.transparent && m.material.opacity < 0.85) return;
        opaqueMeshes.push(m);
      });
      const items = [];
      if (opaqueMeshes.length > 0) {
        const solidParts = [];
        let solidAreaSum = 0;
        for (let mi = 0; mi < opaqueMeshes.length; mi += 1) {
          const m = opaqueMeshes[mi];
          const mw = elementsOf(m);
          if (!mw) continue;
          const fp = analyzeGeometryFootprint(m.geometry, BUILDING_FOOTPRINT_MAX_Z);
          if (fp.length === 0) continue;
          const mf = uprightYawFrame(rootInv ? mat4Mul(rootInv, mw) : mw) || fInfo;
          if (fp[0].hollowArm) {
            for (let ai = 0; ai < fp.length; ai += 1) {
              const sb = buildUprightBoxFromLocalSubBoxes(
                [{ mw, sub: fp[ai] }],
                mf,
                rootInv,
                false,
                true,
                EXTERIOR_ARM_WALL_MARGIN_M,
              );
              if (!sb) continue;
              if (sb.rawDx > 48 && sb.rawDy > 48) continue;
              items.push({ key: `bm:${obj.id ?? i}:${m.id ?? mi}:${ai}`, box: sb });
            }
          } else {
            const sub = fp[0];
            solidParts.push({ m, mi, mw, mf, sub });
            solidAreaSum += Math.max(0, sub.x1 - sub.x0) * Math.max(0, sub.y1 - sub.y0);
          }
        }
        if (solidParts.length > 0) {
          const whole = buildUprightBoxFromLocalSubBoxes(
            solidParts,
            fInfo,
            rootInv,
            false,
            true,
            EXTERIOR_CULL_WALL_MARGIN_M,
          );
          const unionArea = whole ? Math.max(1e-4, whole.rawDx * whole.rawDy) : Infinity;
          if (whole && whole.rawDx <= 14 && whole.rawDy <= 14
            && (solidParts.length === 1 || solidAreaSum >= 0.45 * unionArea)) {
            items.push({ key: `b:${obj.id ?? i}`, box: whole });
          } else {
            for (let pi = 0; pi < solidParts.length; pi += 1) {
              const sp = solidParts[pi];
              const sb = buildUprightBoxFromLocalSubBoxes(
                [sp],
                sp.mf,
                rootInv,
                false,
                true,
                EXTERIOR_CULL_WALL_MARGIN_M,
              );
              if (!sb) continue;
              if (sb.rawDx > 48 && sb.rawDy > 48) continue;
              items.push({ key: `bm:${obj.id ?? i}:${sp.m.id ?? sp.mi}`, box: sb });
            }
          }
        }
      }
      if (extCache) extCache.set(obj, { rootKey, childCount, items });
      for (let hi = 0; hi < items.length; hi += 1) outBoxes.push(items[hi]);
    }
  }
  const sKids = scene3d?.staticsGroup?.children;
  if (Array.isArray(sKids) && sKids.length > 0) {
    for (let i = 0; i < sKids.length; i += 1) {
      const obj = sKids[i];
      if (!obj || obj.isBatchedMesh || obj.isInstancedMesh) continue;
      const childCount = Array.isArray(obj.children) ? obj.children.length : 0;
      const hit = extCache ? extCache.get(obj) : null;
      if (hit && hit.rootKey === rootKey && hit.childCount === childCount) {
        for (let hi = 0; hi < hit.items.length; hi += 1) outBoxes.push(hit.items[hi]);
        continue;
      }
      if (isFoliageOrFenceObject(obj)) {
        if (extCache) extCache.set(obj, { rootKey, childCount, items: [] });
        continue;
      }
      let hasFoliage = false;
      const solidMeshes = [];
      walkMeshes(obj, (m) => {
        if (m.isBatchedMesh || m.isInstancedMesh) return;
        if (meshHasCutoutOrAlpha(m) || isFoliageOrFenceObject(m)) { hasFoliage = true; return; }
        solidMeshes.push(m);
      });
      // Skip trees, bushes, shrubs, flowers, banners, fences (any cutout/alpha or flora submesh).
      const items = [];
      if (!hasFoliage && solidMeshes.length > 0) {
        if (typeof obj.updateWorldMatrix === "function") {
          try { obj.updateWorldMatrix(true, true); } catch (_) {}
        }
        const ow = elementsOf(obj);
        const fInfo = ow ? uprightYawFrame(rootInv ? mat4Mul(rootInv, ow) : ow) : null;
        if (fInfo) {
          const groundSubs = [];
          let maxFullDz = 0;
          let subAreaSum = 0;
          for (let mi = 0; mi < solidMeshes.length; mi += 1) {
            const m = solidMeshes[mi];
            const mw = elementsOf(m);
            if (!mw) continue;
            const fp = analyzeGeometryFootprint(m.geometry, STATIC_FOOTPRINT_MAX_Z);
            if (fp.fullDz > maxFullDz) maxFullDz = fp.fullDz;
            if (fp.length === 0) continue;
            // Skip hollow static fences/arches/gates whose ground occupancy is sparse.
            if (fp[0].hollowArm && fp.fillFraction < 0.40) continue;
            for (let ai = 0; ai < fp.length; ai += 1) {
              const sub = fp[ai];
              const sdx = sub.x1 - sub.x0, sdy = sub.y1 - sub.y0;
              // Skip narrow linear fence rails / thin posts (< 0.45 m wide).
              if (sdx < 0.45 || sdy < 0.45) continue;
              groundSubs.push({ mw, sub });
              subAreaSum += sdx * sdy;
            }
          }
          if (groundSubs.length > 0 && maxFullDz >= 0.20) {
            const unionBox = buildUprightBoxFromLocalSubBoxes(
              groundSubs,
              fInfo,
              rootInv,
              false,
              false,
              STATIC_CULL_WALL_MARGIN_M,
            );
            const unionArea = unionBox ? Math.max(1e-4, unionBox.rawDx * unionBox.rawDy) : Infinity;
            if (unionBox && unionBox.rawDx >= 0.45 && unionBox.rawDy >= 0.45
              && unionBox.rawDx <= 18 && unionBox.rawDy <= 18
              && (groundSubs.length === 1 || subAreaSum >= 0.45 * unionArea)) {
              items.push({ key: `s:${obj.id ?? i}`, box: unionBox });
            } else {
              for (let gi = 0; gi < groundSubs.length; gi += 1) {
                const sb = buildUprightBoxFromLocalSubBoxes(
                  [groundSubs[gi]],
                  fInfo,
                  rootInv,
                  false,
                  false,
                  STATIC_CULL_WALL_MARGIN_M,
                );
                if (sb && sb.rawDx >= 0.45 && sb.rawDy >= 0.45 && sb.rawDx <= 18 && sb.rawDy <= 18) {
                  items.push({ key: `s:${obj.id ?? i}:${gi}`, box: sb });
                }
              }
            }
          }
        }
      }
      if (extCache) extCache.set(obj, { rootKey, childCount, items });
      for (let hi = 0; hi < items.length; hi += 1) outBoxes.push(items[hi]);
    }
  }
}

const bucketKey = (bx, by) => ((bx & 0xffff) << 16 | (by & 0xffff)) >>> 0;

/**
 * 2026-10-23 — can box `e` ever hold a ground point? contains() is only asked
 * at the terrain height, so a cell whose z range misses every terrain height
 * under its AABB (a dungeon inside a hill, an upper-storey room, or a deep
 * basement) never culls a blade. Terrain from `oracle.lookup(lbKey).heights`
 * (column-major 9 x 9, 24 m apart): the terrain over the AABB lies between
 * the min and max of the vertices of the terrain cells it overlaps. Returns 0
 * (never), or 1 (it may, or unknown: a landblock not resident, no lookup,
 * off-world).
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
  const upright = e.inv && Math.abs(e.inv[2]) < 1e-4 && Math.abs(e.inv[6]) < 1e-4 && Math.abs(e.inv[10] - 1) < 1e-3;
  const maxGroundZ = upright ? (e.z1 - INDOOR_CULL_UNDER_CEILING_M + 0.4) : (e.z1 + 0.4);
  return hi >= e.z0 - INDOOR_CULL_BELOW_FLOOR_M - 0.4 && lo <= maxGroundZ ? 1 : 0;
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

  function exteriorSigPart(scene3d) {
    const bKids = scene3d?.buildingsGroup?.children;
    const sKids = scene3d?.staticsGroup?.children;
    const bn = Array.isArray(bKids) ? bKids.length : 0;
    const sn = Array.isArray(sKids) ? sKids.length : 0;
    if (bn === 0 && sn === 0) return "";
    let bSum = 0, sSum = 0;
    if (bn > 0) {
      for (let i = 0; i < bn; i += 1) {
        const o = bKids[i];
        const kc = o && Array.isArray(o.children) ? o.children.length : 0;
        bSum = (bSum + ((o && o.id) ? (o.id >>> 0) : (i + 1)) + ((kc * 2654435761) >>> 0)) >>> 0;
      }
    }
    if (sn > 0) {
      for (let i = 0; i < sn; i += 1) {
        const o = sKids[i];
        const kc = o && Array.isArray(o.children) ? o.children.length : 0;
        sSum = (sSum + ((o && o.id) ? (o.id >>> 0) : (i + 1)) + ((kc * 2654435761) >>> 0)) >>> 0;
      }
    }
    return `|b:${bn}:${bSum}|s:${sn}:${sSum}`;
  }

  const cellBoxCache = new WeakMap();
  const extBoxCache = new WeakMap();
  let lastCellOnlySig = "";
  let cachedExtSig = "";
  let lastExtSigFrame = -1000;

  function rootInvKeyOf(rootInv) {
    if (!rootInv) return "null";
    return `${rootInv[0].toFixed(4)},${rootInv[5].toFixed(4)},${rootInv[10].toFixed(4)},${rootInv[12].toFixed(2)},${rootInv[13].toFixed(2)},${rootInv[14].toFixed(2)}`;
  }

  function countCellMeshesCached(c) {
    const sg = structureGroupOf(c);
    const childLen = sg && Array.isArray(sg.children) ? sg.children.length : -1;
    const hit = c && typeof c === "object" ? cellBoxCache.get(c) : null;
    if (hit && hit.box && hit.childLen === childLen && childLen >= 0) {
      return hit.meshes;
    }
    let m = 0;
    walkMeshes(sg, () => { m += 1; });
    return m;
  }

  function signatureOf(map, scene3d) {
    let sum = 0, meshes = 0;
    if (map instanceof Map) {
      for (const [id, c] of map) {
        sum = (sum + (id >>> 0)) >>> 0;
        meshes += countCellMeshesCached(c);
      }
    }
    const sz = map instanceof Map ? map.size : 0;
    const cellOnly = `${sz}:${sum}:${meshes}`;
    // During world streaming (sz > 32 resident EnvCells), coalesce background
    // statics/buildings signature checks to ~0.8s (48 frames) unless EnvCells changed.
    if (sz <= 32 || cellOnly !== lastCellOnlySig || frame - lastExtSigFrame >= 48) {
      lastCellOnlySig = cellOnly;
      cachedExtSig = exteriorSigPart(scene3d);
      lastExtSigFrame = frame;
    }
    return `${cellOnly}${cachedExtSig}`;
  }

  function addBoxBuckets(box, nextBuckets) {
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

  function rebuild(map, root, scene3d) {
    if (root && typeof root.updateWorldMatrix === "function") {
      try { root.updateWorldMatrix(true, false); } catch (_) { /* read what is there */ }
    }
    const rootW = elementsOf(root);
    const rootInv = rootW ? mat4AffineInverse(rootW) : null;
    const rKey = rootInvKeyOf(rootInv);
    const nextEntries = [];
    const nextBuckets = new Map();
    const nextById = new Map();
    let pending = 0;
    if (map instanceof Map) {
      for (const [id, c] of map) {
        const sg = structureGroupOf(c);
        const childLen = sg && Array.isArray(sg.children) ? sg.children.length : -1;
        const hit = c && typeof c === "object" ? cellBoxCache.get(c) : null;
        let box = null;
        if (hit && hit.box && hit.rootKey === rKey && hit.childLen === childLen && childLen >= 0) {
          box = hit.box;
        } else {
          box = cellBoxFor(c, rootInv);
          if (box && c && typeof c === "object" && childLen >= 0) {
            let m = 0;
            walkMeshes(sg, () => { m += 1; });
            cellBoxCache.set(c, { rootKey: rKey, childLen, meshes: m, box });
          }
        }
        if (!box) { pending += 1; continue; }
        nextEntries.push(box);
        nextById.set(id, box);
        addBoxBuckets(box, nextBuckets);
      }
    }
    const extBoxes = [];
    if (scene3d) collectExteriorBoxes(scene3d, rootInv, extBoxes, extBoxCache, rKey);
    for (let i = 0; i < extBoxes.length; i += 1) {
      const { key, box } = extBoxes[i];
      nextEntries.push(box);
      nextById.set(key, box);
      addBoxBuckets(box, nextBuckets);
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
    st.cells = map instanceof Map ? map.size : 0;
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
    const hasMap = map instanceof Map && map.size > 0;
    const hasExt = !!(
      (Array.isArray(scene3d?.buildingsGroup?.children) && scene3d.buildingsGroup.children.length > 0)
      || (Array.isArray(scene3d?.staticsGroup?.children) && scene3d.staticsGroup.children.length > 0)
    );
    if (!hasMap && !hasExt) {
      if (entries.length === 0 && signature === "") return false;
      changed = [...boxById.values()].map((b) => [b.x0, b.y0, b.x1, b.y1]);
      entries = []; buckets = new Map(); signature = ""; st.cells = 0; st.boxes = 0;
      boxById = new Map();
      writeGpu(entries);
      return true;
    }
    const sig = signatureOf(map, scene3d);
    if (sig === signature) return false;
    signature = sig;
    rebuild(map, scene3d ? (scene3d.worldRoot || null) : null, scene3d);
    return true;
  }

  /**
   * 2026-10-23 — how many interior boxes (EnvCells) have a footprint within
   * `r` metres of (x, y): a cheap "am I in a town" reading (the desert mirage
   * and the volcano shimmer stand down in towns). Linear over the loaded boxes,
   * so callers sample it a few times a second, not per pixel or per blade.
   */
  function boxesNear(x, y, r) {
    if (entries.length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const r2 = r * r;
    let n = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (!e.indoor && !e.bldg) continue;
      const dx = x < e.x0 ? e.x0 - x : x > e.x1 ? x - e.x1 : 0;
      const dy = y < e.y0 ? e.y0 - y : y > e.y1 ? y - e.y1 : 0;
      if (dx * dx + dy * dy <= r2) n += 1;
    }
    return n;
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
    boxesNear,
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
