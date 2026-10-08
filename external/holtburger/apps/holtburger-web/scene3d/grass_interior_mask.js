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

/** Metres the box grows sideways — the interior faces sit inside the walls. */
export const INDOOR_CULL_WALL_MARGIN_M = 0.25;
/** The ground may lie this far below a cell's floor and still count as under it. */
export const INDOOR_CULL_BELOW_FLOOR_M = 1.0;
/** ...and must lie at least this far under the cell's ceiling (cellars). */
export const INDOOR_CULL_UNDER_CEILING_M = 0.5;
/** Frames between checks of the loaded cell set. */
export const INDOOR_CULL_CHECK_FRAMES = 30;
const BUCKET_M = 24;

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
 * One cell's box: {inv, min, max, x0, y0, x1, y1} or null (no structure mesh
 * yet / degenerate). `rootInv` maps world -> worldRoot-local.
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
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
  for (let c = 0; c < 8; c += 1) {
    apply(toRoot, c & 1 ? x1 + m : x0 - m, c & 2 ? y1 + m : y0 - m, c & 4 ? z1 : z0, p);
    if (p[0] < wx0) wx0 = p[0]; if (p[0] > wx1) wx1 = p[0];
    if (p[1] < wy0) wy0 = p[1]; if (p[1] > wy1) wy1 = p[1];
  }
  return { inv, min: [x0, y0, z0], max: [x1, y1, z1], x0: wx0, y0: wy0, x1: wx1, y1: wy1 };
}

const bucketKey = (bx, by) => ((bx & 0xffff) << 16 | (by & 0xffff)) >>> 0;

/**
 * The mask. `sync(scene3d)` once per frame (cheap: a signature walk every
 * INDOOR_CULL_CHECK_FRAMES frames) returns true when the index changed — the
 * caller then re-examines its blades. `contains(x, y, z)` is the placement test
 * in worldRoot-local metres.
 */
export function createInteriorMask(opts = {}) {
  const checkFrames = Math.max(1, opts.checkFrames ?? INDOOR_CULL_CHECK_FRAMES);
  let frame = 0;
  let signature = "";
  let entries = [];
  let buckets = new Map();
  const st = { rebuilds: 0, cells: 0, boxes: 0, pending: 0, tests: 0, hits: 0 };
  const p = [0, 0, 0];

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
    let pending = 0;
    for (const c of map.values()) {
      const box = cellBoxFor(c, rootInv);
      if (!box) { pending += 1; continue; }
      nextEntries.push(box);
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
    entries = nextEntries;
    buckets = nextBuckets;
    st.rebuilds += 1;
    st.cells = map.size;
    st.boxes = nextEntries.length;
    st.pending = pending;
  }

  function sync(scene3d) {
    frame += 1;
    if ((frame - 1) % checkFrames !== 0) return false;
    const map = scene3d && scene3d.cellContainers3d;
    if (!(map instanceof Map) || map.size === 0) {
      if (entries.length === 0 && signature === "") return false;
      entries = []; buckets = new Map(); signature = ""; st.cells = 0; st.boxes = 0;
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

  return {
    sync,
    contains,
    stats: () => ({ ...st, enabled: true }),
  };
}
