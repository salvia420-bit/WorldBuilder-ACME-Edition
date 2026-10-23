// 2026-10-23 — the interior mask's GPU mirror (docs/2026-10-23-grass-gpu-placement.md,
// Module B): `?terrainGrassGpu` places blades in the vertex shader, so the
// "no grass inside a building" test (grass_interior_mask.js contains()) has to
// run there too, as `hbIndoorAt(p)` over two RGBA32F DataTextures.
//
// Run with:
//   cd apps/holtburger-web && node test_grass_interior_mask_gpu.mjs
//   (HB_PORTAL_DAT / HB_CELL_DAT override ~/ac_base_dats/client_{portal,cell_1}.dat)
//
// Locks:
//  1. GLSL HYGIENE — INTERIOR_MASK_GLSL has no backticks, declares each of its
//     three uniforms exactly once, defines `bool hbIndoorAt(vec3 p)`, reads the
//     textures only through texelFetch, and bakes the JS layout constants.
//  2. TEXTURES (real three) — 8 x 2048 and 832 x 64, RGBA / Float, Nearest, no
//     mips, flipY off, wrapping the very Float32Arrays the mirror reads; the
//     uniform objects survive rebuilds (bind by reference); `gpu: true` without
//     THREE = null textures over the same arrays.
//  3. MIRROR == contains() — a synthetic town of real three Object3D / Mesh /
//     BoxGeometry cells under a worldRoot with the AC rotation: yawed and
//     translated boxes, overlapping boxes, a cellar and an upper storey (the z
//     rules), a hall over many buckets (two structure meshes, one rotated), a
//     tilted box (the AABB texel), a box on a bucket corner, negative bucket
//     indices; 80k points plus +-2 cm probes on every margin of every box. Every
//     point not within 1 cm of a boundary agrees, and contains() agrees with an
//     independent brute-force reference. A second worldRoot (also translated)
//     gives the same answers.
//  4. OVERFLOW / FOLD (uncentred, the old Map-order write) — CAP + 4 storeys in
//     one bucket (CAP kept, 4 counted), MAX + 6 boxes (MAX kept, 6 counted), two
//     buckets 768 m apart (one slot, counted), a box wider than the slot grid;
//     the mirror misses exactly the dropped.
//  5. CLEAR PATH — an empty cell set zeroes both arrays, flags both textures
//     for upload and sets uHbIndoorOn to 0; an all-pending set does the same.
//  6. CPU UNCHANGED — contains() and the CPU stats are identical in GPU mode
//     and CPU mode; CPU mode (no arguments, or gpu: false) allocates no arrays
//     or textures, writes nothing, and its setGpuCenter() / mirror are inert.
//  7. PLAYER-CENTRED WRITES (2026-10-23, synthetic) — the setGpuCenter() policy
//     (non-finite ignored; a move of more than D on either axis, a reach change
//     or the first centre rewrites; at most one write per sync() however the
//     calls interleave, also against a CPU-mode twin over 600 random frames;
//     sync()'s return and lastChanged() untouched by a re-centre; no upload of
//     zeros over zeros), the clip to the 64-bucket span (the section-4 fold and
//     the 800 m box, centred: no collision), nearest-first under the bucket cap
//     (3D; Map order when z is unknown) and the row cap, and GROUND FIRST with
//     an oracle (a box that cannot touch the terrain sorts last; a capped write
//     re-ranks when the oracle's version moves, at the cell-check cadence).
//  8. REAL DATA (client_cell_1.dat + client_portal.dat) — every EnvCell of
//     Holtburg's 3x3 landblocks (frame from the cell, structure extents from the
//     Environment's CellStruct polygons), at the real terrain height: no fold,
//     no overflow, and the mirror equals contains() everywhere it is not within
//     1 cm of a boundary. The 0x4993 housing block (43 cells in one 12 m bucket):
//     the overflow is counted, the mirror never claims a point contains() does
//     not, and every point it misses is explained by a dropped box.
//     8b. The cell map the app really holds (review parity-1 / lifecycle-1 /
//     parity-2), centred at reach 200 and 320 on the end point: the walk
//     0x3ED0 -> 0x42D0 and 0x55A0 -> 0x55A4 (cells.js order + edge-park /
//     unpark re-append), the Training Academy 0x8602 + 0x8502 then Holtburg's
//     3x3, a fresh 3x3 at 0xF930 (1980 boxes; with and without an oracle) and
//     at the world-corner 0x0101 (3726 boxes: distance alone loses ground
//     there, GROUND FIRST does not): the mirror == contains() on the 1 m
//     ground grid within reach (off the 1 cm band), 0 collisions, every slot
//     in the span. The walks also show the uncentred write losing ground.

import { existsSync, openSync, readSync, closeSync } from "node:fs";
import * as THREE from "three";

import {
  createInteriorMask, INTERIOR_MASK_GLSL,
  INDOOR_CULL_WALL_MARGIN_M, INDOOR_CULL_BELOW_FLOOR_M, INDOOR_CULL_UNDER_CEILING_M,
  INDOOR_GPU_MAX_BOXES, INDOOR_GPU_BOX_TEXELS, INDOOR_GPU_BUCKET_M, INDOOR_GPU_BUCKET_SLOTS,
  INDOOR_GPU_BUCKET_TEXELS, INDOOR_GPU_BUCKET_CAP,
  INDOOR_GPU_SPAN_HALF_M, INDOOR_GPU_DEFAULT_REACH_M, indoorGpuRecentreM,
} from "./scene3d/grass_interior_mask.js";
import { createTerrainOracle } from "./scene3d/terrain_oracle.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const W = INDOOR_CULL_WALL_MARGIN_M, BELOW = INDOOR_CULL_BELOW_FLOOR_M, UNDER = INDOOR_CULL_UNDER_CEILING_M;
const EPS = 0.01;   // "near a boundary": f32 data at 35 km rounds by a few mm
const PROBE = 0.02; // margin probes sit this far inside / outside each face
const BUCKET_TEX_W = INDOOR_GPU_BUCKET_SLOTS * INDOOR_GPU_BUCKET_TEXELS;
const hex8 = (id) => (id >>> 0).toString(16).padStart(8, "0");

/** Deterministic PRNG (tests only; placement itself never uses one). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixtures: the live shape (cells.js) — worldRoot (AC Z-up -> three Y-up) ->
// cellsGroup -> container `envcell-<id>` -> meshGroup `mesh-<id>` (the cell
// frame: AC world position + AC quaternion) -> structure meshes; props hang
// off the container and are not part of the box.
// ---------------------------------------------------------------------------
function makeWorld(translate = null) {
  const root = new THREE.Group();
  root.name = "worldRoot";
  root.rotation.x = -Math.PI / 2;
  if (translate) root.position.set(translate[0], translate[1], translate[2]);
  const cellsGroup = new THREE.Group();
  cellsGroup.name = "cells";
  root.add(cellsGroup);
  return { root, cellsGroup, map: new Map(), boxes: [] };
}

function boxGeometry(e) {
  return new THREE.BoxGeometry(e[3] - e[0], e[4] - e[1], e[5] - e[2])
    .translate((e[0] + e[3]) / 2, (e[1] + e[4]) / 2, (e[2] + e[5]) / 2);
}

/**
 * Adds one cell. `meshes` = [{ geometry, position?, quaternion? }] in the cell
 * frame; `ext` = the union box of those meshes in the cell frame (what the
 * reference tests against, declared independently of the mask's own math).
 */
function addCell(world, id, { pos, quat, meshes, ext, prop = false, pendingOnly = false }) {
  const container = new THREE.Group();
  container.name = `envcell-${hex8(id)}`;
  const mg = new THREE.Group();
  mg.name = `mesh-${hex8(id)}`;
  mg.position.set(pos[0], pos[1], pos[2]);
  mg.quaternion.copy(quat);
  container.add(mg);
  for (const m of meshes) {
    const mesh = new THREE.Mesh(m.geometry);
    mesh.name = "surfaces-fused-opaque";
    if (m.position) mesh.position.set(m.position[0], m.position[1], m.position[2]);
    if (m.quaternion) mesh.quaternion.copy(m.quaternion);
    mg.add(mesh);
  }
  if (prop) {
    const p = new THREE.Mesh(boxGeometry([-30, -30, 0, 30, 30, 2]));
    p.name = "cellstatic";
    container.add(p);
  }
  world.cellsGroup.add(container);
  world.map.set(id >>> 0, container);
  if (!pendingOnly) world.boxes.push(refBox(pos, quat, ext));
  return container;
}

const yawQ = (deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg * Math.PI / 180);
const tiltQ = (yawDeg, tiltDeg) => yawQ(yawDeg).multiply(
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tiltDeg * Math.PI / 180));

// --- the independent reference: contains()'s rule, brute force, in f64 -----
function refBox(pos, quat, ext) {
  const toRoot = new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), quat, new THREE.Vector3(1, 1, 1));
  const inv = toRoot.clone().invert().elements.slice();
  const t = toRoot.elements;
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
  for (let c = 0; c < 8; c += 1) {
    const x = c & 1 ? ext[3] + W : ext[0] - W, y = c & 2 ? ext[4] + W : ext[1] - W, z = c & 4 ? ext[5] : ext[2];
    const wx = t[0] * x + t[4] * y + t[8] * z + t[12], wy = t[1] * x + t[5] * y + t[9] * z + t[13];
    X0 = Math.min(X0, wx); X1 = Math.max(X1, wx); Y0 = Math.min(Y0, wy); Y1 = Math.max(Y1, wy);
  }
  return { toRoot: t.slice(), inv, ext, aabb: [X0, Y0, X1, Y1] };
}

/** The box a point is in, grown by g on every boundary (g < 0 shrinks). */
function refInBox(b, x, y, z, g) {
  const a = b.aabb;
  if (x < a[0] - g || x > a[2] + g || y < a[1] - g || y > a[3] + g) return false;
  const m = b.inv, e = b.ext;
  const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
  if (lx < e[0] - W - g || lx > e[3] + W + g) return false;
  const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
  if (ly < e[1] - W - g || ly > e[4] + W + g) return false;
  const lz = m[2] * x + m[6] * y + m[10] * z + m[14];
  return !(lz < e[2] - BELOW - g || lz > e[5] - UNDER + g);
}
function refInside(boxes, x, y, z, g = 0) {
  for (let i = 0; i < boxes.length; i += 1) if (refInBox(boxes[i], x, y, z, g)) return true;
  return false;
}

/** Root-local AC point of cell-local (lx, ly, lz) in box b. */
function toRootPoint(b, lx, ly, lz) {
  const t = b.toRoot;
  return [t[0] * lx + t[4] * ly + t[8] * lz + t[12], t[1] * lx + t[5] * ly + t[9] * lz + t[13], t[2] * lx + t[6] * ly + t[10] * lz + t[14]];
}

/**
 * Compares the mirror with contains() (and contains() with the reference) on
 * `pts` ([x, y, z] triples). Points within EPS of any boundary are counted as
 * ambiguous and skipped (f32 rounding decides those on the GPU).
 */
function compare(mask, boxes, pts) {
  const r = { n: pts.length, amb: 0, inside: 0, mirrorVsCpu: 0, cpuVsRef: 0, worst: null };
  for (const [x, y, z] of pts) {
    const lo = refInside(boxes, x, y, z, -EPS), hi = refInside(boxes, x, y, z, EPS);
    if (lo !== hi) { r.amb += 1; continue; }
    const c = mask.contains(x, y, z), g = mask.gpuContainsMirror(x, y, z);
    if (c) r.inside += 1;
    if (c !== lo) { r.cpuVsRef += 1; r.worst = r.worst || ["cpu", x, y, z, c, lo]; }
    if (g !== c) { r.mirrorVsCpu += 1; r.worst = r.worst || ["mirror", x, y, z, g, c]; }
  }
  return r;
}

/** Points in and around every box: half near a box's accept region, half anywhere. */
function randomPoints(boxes, n, seed, region) {
  const R = rng(seed), out = [];
  for (let i = 0; i < n; i += 1) {
    if (i & 1) {
      const b = boxes[Math.floor(R() * boxes.length)], e = b.ext;
      const lx = e[0] - W - 1 + R() * (e[3] - e[0] + 2 * W + 2);
      const ly = e[1] - W - 1 + R() * (e[4] - e[1] + 2 * W + 2);
      const lz = e[2] - BELOW - 1 + R() * (e[5] - e[2] + BELOW - UNDER + 2);
      out.push(toRootPoint(b, lx, ly, lz));
    } else {
      out.push([region[0] + R() * (region[3] - region[0]), region[1] + R() * (region[4] - region[1]), region[2] + R() * (region[5] - region[2])]);
    }
  }
  return out;
}

/** +-PROBE around each of the six accept-interval faces of every box, 9 spots per face. */
function marginProbes(boxes) {
  const pts = [];
  for (const b of boxes) {
    const e = b.ext;
    const lo = [e[0] - W, e[1] - W, e[2] - BELOW], hi = [e[3] + W, e[4] + W, e[5] - UNDER];
    for (let ax = 0; ax < 3; ax += 1) {
      const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
      const spots = (k) => [lo[k] + 0.1, (lo[k] + hi[k]) / 2, hi[k] - 0.1];
      for (const face of [lo[ax], hi[ax]]) {
        for (const d of [-PROBE, PROBE]) {
          for (const s1 of spots(o1)) {
            for (const s2 of spots(o2)) {
              const l = [0, 0, 0];
              l[ax] = face + d; l[o1] = s1; l[o2] = s2;
              pts.push(toRootPoint(b, l[0], l[1], l[2]));
            }
          }
        }
      }
    }
  }
  return pts;
}

function syncWorld(mask, world) {
  return mask.sync({ cellContainers3d: world.map, worldRoot: world.root });
}

/** Upload count of the boxes texture (three bumps version on every needsUpdate = true). */
const tbVersion = (mask) => mask.uniforms.uHbIndoorBoxes.value.version;

// ---------------------------------------------------------------------------
console.log("\n-- 1. GLSL hygiene ----------------------------------------------");
{
  const g = INTERIOR_MASK_GLSL;
  check("INTERIOR_MASK_GLSL is a non-empty string", typeof g === "string" && g.length > 200);
  check("no backticks anywhere in it (house rule)", !g.includes("`"));
  for (const [type, name] of [["sampler2D", "uHbIndoorBoxes"], ["sampler2D", "uHbIndoorBuckets"], ["float", "uHbIndoorOn"]]) {
    const n = (g.match(new RegExp(`\\buniform\\s+(?:highp\\s+)?${type}\\s+${name}\\s*;`, "g")) || []).length;
    check(`uniform ${name} (${type}) declared exactly once`, n === 1, `(${n})`);
  }
  check("...and nothing else is a uniform", (g.match(/\buniform\b/g) || []).length === 3);
  check("defines bool hbIndoorAt(vec3 p) once", (g.match(/\bbool\s+hbIndoorAt\s*\(\s*vec3\s+p\s*\)\s*\{/g) || []).length === 1);
  check("reads the textures through texelFetch only (no filtered sampling)",
    g.includes("texelFetch(uHbIndoorBoxes") && g.includes("texelFetch(uHbIndoorBuckets") && !/\btexture2D\b|\btexture\s*\(/.test(g));
  check("bakes the JS layout: 12 m buckets, 64 slots, 13 texels a slot, 12 id texels",
    g.includes(`/ ${INDOOR_GPU_BUCKET_M}.0)`) && g.includes(`& ${INDOOR_GPU_BUCKET_SLOTS - 1})`)
    && g.includes(`* ${INDOOR_GPU_BUCKET_TEXELS};`) && g.includes(`t < ${INDOOR_GPU_BUCKET_TEXELS - 1};`));
  check("no unresolved ${...} and no preprocessor lines", !g.includes("${") && !/^\s*#/m.test(g));
  const bal = (o, c) => g.split(o).length === g.split(c).length;
  check("braces and parentheses balance", bal("{", "}") && bal("(", ")"));
  check("names stay in the hbIndoor / uHbIndoor namespace (no clash with the field / place GLSL)",
    (g.match(/\b(?:bool|float|vec[234]|int)\s+(\w+)\s*\(/g) || []).every((s) => /hbIndoor/.test(s)));
  // The one place the spec's numbers are pinned; every other check derives
  // from the exported constants.
  // 2026-10-23: 2048 rows (was 1024; the review's F930 / world-corner spots).
  check("layout = the spec: 2048 boxes x 8 texels, 12 m buckets on 64 x 64 slots, 13 texels (48 ids) a slot",
    INDOOR_GPU_MAX_BOXES === 2048 && INDOOR_GPU_BOX_TEXELS === 8 && INDOOR_GPU_BUCKET_M === 12
    && INDOOR_GPU_BUCKET_SLOTS === 64 && INDOOR_GPU_BUCKET_TEXELS === 13 && INDOOR_GPU_BUCKET_CAP === 48);
}

// ---------------------------------------------------------------------------
// The synthetic town (Holtburg-scale coordinates, so f32 rounding is real).
// ---------------------------------------------------------------------------
function buildTown(world) {
  // A cottage's ground floor, yawed 37 deg, with a 30 m prop on the container.
  addCell(world, 0xa9b40100, { pos: [32500, 34600, 60], quat: yawQ(37), meshes: [{ geometry: boxGeometry([-3, -5, 0, 3, 5, 3.2]) }], ext: [-3, -5, 0, 3, 5, 3.2], prop: true });
  // Its cellar (ceiling at the ground) and its upper storey.
  addCell(world, 0xa9b40101, { pos: [32500, 34600, 60], quat: yawQ(37), meshes: [{ geometry: boxGeometry([-3, -5, -3, 3, 5, 0.1]) }], ext: [-3, -5, -3, 3, 5, 0.1] });
  addCell(world, 0xa9b40102, { pos: [32500, 34600, 63.2], quat: yawQ(37), meshes: [{ geometry: boxGeometry([-3, -5, 0, 3, 5, 3]) }], ext: [-3, -5, 0, 3, 5, 3] });
  // An overlapping neighbour at another yaw and floor height.
  addCell(world, 0xa9b40103, { pos: [32504, 34603, 60.4], quat: yawQ(-20), meshes: [{ geometry: boxGeometry([-4, -2, 0, 4, 2, 3]) }], ext: [-4, -2, 0, 4, 2, 3] });
  // A 56 x 30 m hall over many buckets: the main box plus a wing mesh with its
  // own (rotated) transform, so the box is the union in the cell frame.
  addCell(world, 0xa9b40104, {
    pos: [32560, 34640, 58], quat: yawQ(15),
    meshes: [
      { geometry: boxGeometry([-25, -15, 0, 25, 15, 8]) },
      { geometry: boxGeometry([-4, -1, 0, 4, 6, 5]), position: [25, 0, 0], quaternion: yawQ(-90) },
    ],
    ext: [-25, -15, 0, 31, 15, 8],
  });
  // A box that is not upright (8 deg tilt): only the AABB texel keeps parity.
  addCell(world, 0xa9b40105, { pos: [32620, 34580, 61], quat: tiltQ(70, 8), meshes: [{ geometry: boxGeometry([-3, -3, 0, 3, 3, 3]) }], ext: [-3, -3, 0, 3, 3, 3] });
  // Axis-aligned on a 12 m bucket corner (x = 12 * 2710, y = 12 * 2885).
  addCell(world, 0xa9b40106, { pos: [32520, 34620, 59.5], quat: yawQ(0), meshes: [{ geometry: boxGeometry([-2, -2, 0, 2, 2, 3]) }], ext: [-2, -2, 0, 2, 2, 3] });
  // Negative bucket indices (off-world, but the slot fold must still hold).
  addCell(world, 0x00000107, { pos: [-30, -40, 5], quat: yawQ(120), meshes: [{ geometry: boxGeometry([-2, -3, 0, 2, 3, 2.5]) }], ext: [-2, -3, 0, 2, 3, 2.5] });
  // A cell whose structure mesh has not attached yet: pending, not a box.
  addCell(world, 0xa9b40199, { pos: [32540, 34590, 60], quat: yawQ(0), meshes: [], ext: null, pendingOnly: true });
}
const TOWN_REGION = [32470, 34560, 52, 32660, 34680, 72];

// ---------------------------------------------------------------------------
console.log("\n-- 2. textures (real three) --------------------------------------");
{
  const world = makeWorld();
  buildTown(world);
  const mask = createInteriorMask({ THREE, checkFrames: 1 });
  const u = mask.uniforms;
  const tb = u.uHbIndoorBoxes.value, tk = u.uHbIndoorBuckets.value;
  check("uniforms = { uHbIndoorBoxes, uHbIndoorBuckets, uHbIndoorOn }",
    Object.keys(u).sort().join() === "uHbIndoorBoxes,uHbIndoorBuckets,uHbIndoorOn");
  check(`boxes: a DataTexture ${INDOOR_GPU_BOX_TEXELS} x ${INDOOR_GPU_MAX_BOXES}`,
    tb && tb.isDataTexture && tb.image.width === INDOOR_GPU_BOX_TEXELS && tb.image.height === INDOOR_GPU_MAX_BOXES);
  check(`buckets: a DataTexture ${BUCKET_TEX_W} x ${INDOOR_GPU_BUCKET_SLOTS}`,
    tk && tk.isDataTexture && tk.image.width === BUCKET_TEX_W && tk.image.height === INDOOR_GPU_BUCKET_SLOTS);
  for (const [name, t] of [["boxes", tb], ["buckets", tk]]) {
    check(`${name}: RGBA32F (RGBAFormat + FloatType), Nearest, no mips, flipY off`,
      t.format === THREE.RGBAFormat && t.type === THREE.FloatType && t.minFilter === THREE.NearestFilter
      && t.magFilter === THREE.NearestFilter && t.generateMipmaps === false && t.flipY === false);
    check(`${name}: flagged for upload at creation (a sampler never binds an empty unit)`, t.version > 0);
  }
  check("the textures wrap the very arrays the mirror reads",
    tb.image.data === mask._boxData && tk.image.data === mask._bucketData
    && mask._boxData instanceof Float32Array && mask._boxData.length === INDOOR_GPU_BOX_TEXELS * INDOOR_GPU_MAX_BOXES * 4
    && mask._bucketData instanceof Float32Array && mask._bucketData.length === BUCKET_TEX_W * INDOOR_GPU_BUCKET_SLOTS * 4);
  check("uHbIndoorOn starts at 0", u.uHbIndoorOn.value === 0);
  const v0 = [tb.version, tk.version];
  const refs = [u.uHbIndoorBoxes, u.uHbIndoorBuckets, u.uHbIndoorOn, tb, tk];
  check("the first sync builds", syncWorld(mask, world) === true);
  check("rebuild flags both textures for upload", tb.version > v0[0] && tk.version > v0[1]);
  check("uHbIndoorOn = 1 with boxes", u.uHbIndoorOn.value === 1);
  // Two more rebuilds: the cottage again under a new id, then without it.
  world.map.set(0xa9b40200, world.map.get(0xa9b40100));
  syncWorld(mask, world);
  world.map.delete(0xa9b40200);
  syncWorld(mask, world);
  check("uniform and texture objects survive rebuilds (bind by reference)",
    mask.uniforms.uHbIndoorBoxes === refs[0] && mask.uniforms.uHbIndoorBuckets === refs[1]
    && mask.uniforms.uHbIndoorOn === refs[2] && refs[0].value === refs[3] && refs[1].value === refs[4]);
  const st = mask.stats();
  check("stats: 8 boxes, 1 pending, all on the GPU, nothing dropped",
    st.boxes === 8 && st.pending === 1 && st.gpuBoxes === 8 && st.gpuOverflow === 0
    && st.gpuCollisions === 0 && st.gpuBoxOverflow === 0, JSON.stringify(st));
  check("stats: buckets written and refreshes counted", st.gpuBuckets > 20 && st.gpuRefreshes === 3 && st.gpuMaxPerBucket >= 3);
  // Row layout spot check: box 0 = the cottage (inv rows, margins, AABB).
  const B = mask._boxData, b0 = world.boxes[0];
  const f = Math.fround;
  check("box row 0: texels 0..2 = the rows of inv (worldRoot-local -> cell-local)",
    [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].every((k, i) => Math.abs(B[i] - b0.inv[k]) <= 1e-6 + 2e-7 * Math.abs(b0.inv[k])));
  check("box row 0: texel 3 / 4 = the margins of contains() pre-applied",
    B[12] === f(-3 - W) && B[13] === f(-5 - W) && B[14] === f(0 - BELOW) && B[15] === 0
    && B[16] === f(3 + W) && B[17] === f(5 + W) && Math.abs(B[18] - (3.2 - UNDER)) < 1e-6 && B[19] === 0);
  check("box row 0: texel 5 = its world AABB",
    Math.abs(B[20] - b0.aabb[0]) < 4e-3 && Math.abs(B[21] - b0.aabb[1]) < 4e-3
    && Math.abs(B[22] - b0.aabb[2]) < 4e-3 && Math.abs(B[23] - b0.aabb[3]) < 4e-3);
  // Bucket layout spot check: the corner box (index 6) sits in 4 buckets.
  const D = mask._bucketData;
  let corner = 0;
  for (const [bx, by] of [[2709, 2884], [2710, 2884], [2709, 2885], [2710, 2885]]) {
    const h = ((by & 63) * BUCKET_TEX_W + (bx & 63) * INDOOR_GPU_BUCKET_TEXELS) * 4;
    const ids = Array.from(D.subarray(h + 4, h + 4 + INDOOR_GPU_BUCKET_CAP));
    if (D[h] === bx && D[h + 1] === by && D[h + 3] === 1 && ids.includes(6) && ids.slice(D[h + 2]).every((v) => v === -1)) corner += 1;
  }
  check("bucket slots: head (bx, by, count, 1), ids then -1 padding; a corner box is in all 4", corner === 4);
  mask.dispose();
  check("dispose() frees the GPU copies and keeps the objects bound", mask.uniforms.uHbIndoorBoxes.value === tb);

  const bare = createInteriorMask({ gpu: true, checkFrames: 1 });
  syncWorld(bare, world);
  check("gpu: true without THREE: null textures, the same live uHbIndoorOn, the same arrays",
    bare.uniforms.uHbIndoorBoxes.value === null && bare.uniforms.uHbIndoorBuckets.value === null
    && bare.uniforms.uHbIndoorOn.value === 1
    && bare._boxData.every((v, i) => v === mask._boxData[i]) && bare._bucketData.every((v, i) => v === mask._bucketData[i]));
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. mirror == contains() on the synthetic town -----------------");
let TOWN_HITS = null;
{
  const world = makeWorld();
  buildTown(world);
  const mask = createInteriorMask({ THREE, checkFrames: 1 });
  syncWorld(mask, world);
  const rnd = randomPoints(world.boxes, 80000, 0x5eed, TOWN_REGION);
  const r = compare(mask, world.boxes, rnd);
  check("80k random points: the mirror agrees with contains() off the 1 cm boundary band",
    r.mirrorVsCpu === 0, JSON.stringify(r));
  check("...and contains() agrees with the brute-force reference", r.cpuVsRef === 0, JSON.stringify(r.worst));
  check("...the set is a real test (many inside, many outside, few ambiguous)",
    r.inside > 10000 && r.n - r.amb - r.inside > 40000 && r.amb < r.n * 0.005, `inside ${r.inside} amb ${r.amb}`);
  const probes = marginProbes(world.boxes);
  const pr = compare(mask, world.boxes, probes);
  // (a probe can sit within 1 cm of ANOTHER box's slanted face: skipped as ambiguous)
  check(`${probes.length} margin probes (+-${PROBE * 100} cm of every face of every box): mirror == contains() == reference`,
    pr.amb < probes.length * 0.01 && pr.mirrorVsCpu === 0 && pr.cpuVsRef === 0, JSON.stringify(pr));
  // The probes really straddle: inside probes of upright boxes hit, outside ones
  // that no other box covers miss.
  let inHit = 0, inN = 0, outMiss = 0, outN = 0;
  world.boxes.forEach((b, bi) => {
    if (bi === 5) return; // the tilted box: its AABB clips the inner probes by design
    for (const p of marginProbes([b])) {
      const inside = refInBox(b, p[0], p[1], p[2], 0);
      if (inside) { inN += 1; if (mask.gpuContainsMirror(p[0], p[1], p[2])) inHit += 1; }
      else if (!refInside(world.boxes, p[0], p[1], p[2], 0)) { outN += 1; if (!mask.gpuContainsMirror(p[0], p[1], p[2])) outMiss += 1; }
    }
  });
  check("inside probes all hit on the GPU mirror, uncovered outside probes all miss",
    inN > 300 && inHit === inN && outN > 200 && outMiss === outN, `in ${inHit}/${inN} out ${outMiss}/${outN}`);
  // The z rules, by name.
  const at = (bi, lx, ly, lz) => { const p = toRootPoint(world.boxes[bi], lx, ly, lz); return mask.gpuContainsMirror(p[0], p[1], p[2]); };
  check("ground 0.5 m under the hall floor still culls, 1.5 m under does not",
    at(4, 0, 0, -0.5) === true && at(4, 0, 0, -1.5) === false);
  check("a cellar never culls the lawn at its ceiling (mirror and CPU)",
    (() => { const m = createInteriorMask({ gpu: true, checkFrames: 1 }); const w = makeWorld(); addCell(w, 1, { pos: [32500, 34600, 60], quat: yawQ(37), meshes: [{ geometry: boxGeometry([-3, -5, -3, 3, 5, 0.1]) }], ext: [-3, -5, -3, 3, 5, 0.1] }); syncWorld(m, w); const p = toRootPoint(w.boxes[0], 1, 2, 0); return !m.gpuContainsMirror(p[0], p[1], p[2]) && !m.contains(p[0], p[1], p[2]); })());
  check("an upper storey never culls the ground under it (mirror and CPU)",
    (() => { const m = createInteriorMask({ gpu: true, checkFrames: 1 }); const w = makeWorld(); addCell(w, 1, { pos: [32500, 34600, 63.2], quat: yawQ(37), meshes: [{ geometry: boxGeometry([-3, -5, 0, 3, 5, 3]) }], ext: [-3, -5, 0, 3, 5, 3] }); syncWorld(m, w); const p = toRootPoint(w.boxes[0], 1, 2, -3.2); return !m.gpuContainsMirror(p[0], p[1], p[2]) && !m.contains(p[0], p[1], p[2]); })());
  check("the 30 m prop on the cottage container culls nothing beyond the cottage",
    mask.gpuContainsMirror(32480, 34625, 60) === false && mask.contains(32480, 34625, 60) === false);
  {
    // Points inside the tilted box's local interval (below its floor, where
    // the tilt carries them sideways) that fall outside its world AABB.
    const b = world.boxes[5];
    let clipped = 0, refused = 0;
    // (integer-indexed grids: float steps would overshoot the +3.24 edge)
    for (let iz = 0; iz < 10; iz += 1) {
      for (let ix = 0; ix <= 64; ix += 1) {
        for (let iy = 0; iy <= 64; iy += 1) {
          const lx = -3.24 + ix * (6.48 / 64), ly = -3.24 + iy * (6.48 / 64), lz = -0.98 + iz * 0.1;
          const p = toRootPoint(b, lx, ly, lz);
          if (refInBox(b, p[0], p[1], p[2], EPS) || refInside(world.boxes, p[0], p[1], p[2], EPS)) continue;
          clipped += 1;
          if (!mask.gpuContainsMirror(p[0], p[1], p[2]) && !mask.contains(p[0], p[1], p[2])) refused += 1;
        }
      }
    }
    check("the tilted box: points in its local interval but outside its AABB are refused by both paths",
      clipped > 10 && refused === clipped, `${refused}/${clipped}`);
  }
  check("negative bucket indices work (the off-world box at -30, -40)",
    mask.gpuContainsMirror(-30, -40, 5.5) === true && mask.contains(-30, -40, 5.5) === true && mask.gpuContainsMirror(-30, -40, 2) === false);
  check("the hall's wing (a second, rotated structure mesh) is part of its box",
    at(4, 29, 0, 1) === true && at(4, 32, 0, 1) === false);

  // A second worldRoot, also translated: same root-local answers.
  const world2 = makeWorld([-32000, 7, 34000]);
  buildTown(world2);
  const mask2 = createInteriorMask({ THREE, checkFrames: 1 });
  syncWorld(mask2, world2);
  let same = 0;
  for (const [x, y, z] of rnd) if (mask2.gpuContainsMirror(x, y, z) === mask.gpuContainsMirror(x, y, z) && mask2.contains(x, y, z) === mask.contains(x, y, z)) same += 1;
  check("a translated worldRoot gives the same root-local answers (>= 99.9 %, the rest f32 jitter)",
    same >= rnd.length * 0.999, `${same}/${rnd.length}`);
  TOWN_HITS = { mask, rnd };
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. overflow and folds: counted, never thrown --------------------");
{
  // CAP + 4 storeys of one 4 x 4 m footprint inside one 12 m bucket.
  const CAP = INDOOR_GPU_BUCKET_CAP, NS = CAP + 4;
  const world = makeWorld();
  const geom = boxGeometry([-2, -2, 0, 2, 2, 3]);
  for (let k = 0; k < NS; k += 1) addCell(world, 0x10000100 + k, { pos: [33606, 34806, 50 + 3 * k], quat: yawQ(0), meshes: [{ geometry: geom }], ext: [-2, -2, 0, 2, 2, 3] });
  const mask = createInteriorMask({ THREE, checkFrames: 1 });
  let threw = false;
  try { syncWorld(mask, world); } catch (_) { threw = true; }
  const st = mask.stats();
  check(`${NS} boxes in one bucket: no throw, ${CAP} kept, 4 counted as gpuOverflow`,
    !threw && st.gpuBoxes === NS && st.gpuBuckets === 1 && st.gpuOverflow === 4 && st.gpuMaxPerBucket === NS, JSON.stringify(st));
  // Storey k alone accepts z in (49.5 + 3k, 52 + 3k).
  const kept = [], lost = [];
  for (let k = 0; k < NS; k += 1) {
    const z = 50.75 + 3 * k;
    (k < CAP ? kept : lost).push([mask.contains(33606, 34806, z), mask.gpuContainsMirror(33606, 34806, z)]);
  }
  check(`storeys 0..${CAP - 1} (the first ${CAP}) cull on both paths`, kept.length === CAP && kept.every(([c, g]) => c && g));
  check(`storeys ${CAP}..${NS - 1} still cull on the CPU, the GPU mirror misses exactly them`, lost.length === 4 && lost.every(([c, g]) => c && !g));

  // MAX + 6 boxes (4 x 4 to a 12 m bucket): MAX rows, 6 counted.
  const NB = INDOOR_GPU_MAX_BOXES + 6;
  const big = makeWorld();
  const tiny = boxGeometry([-0.5, -0.5, 0, 0.5, 0.5, 2]);
  for (let i = 0; i < NB; i += 1) {
    addCell(big, 0x20000000 + i, { pos: [1200 + 1.5 + 3 * (i % 32), 1200 + 1.5 + 3 * Math.floor(i / 32), 10], quat: yawQ(0), meshes: [{ geometry: tiny }], ext: [-0.5, -0.5, 0, 0.5, 0.5, 2] });
  }
  const bm = createInteriorMask({ THREE, checkFrames: 1 });
  threw = false;
  try { syncWorld(bm, big); } catch (_) { threw = true; }
  const bs = bm.stats();
  check(`${NB} boxes: no throw, ${INDOOR_GPU_MAX_BOXES} on the GPU, 6 counted as gpuBoxOverflow, 16 to a bucket`,
    !threw && bs.boxes === NB && bs.gpuBoxes === INDOOR_GPU_MAX_BOXES && bs.gpuBoxOverflow === 6 && bs.gpuOverflow === 0
    && bs.gpuCollisions === 0 && bs.gpuMaxPerBucket === 16, JSON.stringify(bs));
  const centre = (i) => [1200 + 1.5 + 3 * (i % 32), 1200 + 1.5 + 3 * Math.floor(i / 32), 10.5];
  const M = INDOOR_GPU_MAX_BOXES;
  check(`box 0 and box ${M - 1} cull on both paths`,
    [0, M - 1].every((i) => bm.contains(...centre(i)) && bm.gpuContainsMirror(...centre(i))));
  check(`boxes ${M}..${NB - 1} cull on the CPU only`, [M, M + 1, NB - 1].every((i) => bm.contains(...centre(i)) && !bm.gpuContainsMirror(...centre(i))));

  // Two buckets 768 m apart share a slot: the first keeps it.
  const fold = makeWorld();
  const g4 = boxGeometry([-2, -2, 0, 2, 2, 3]);
  addCell(fold, 0x30000100, { pos: [126, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
  addCell(fold, 0x30000101, { pos: [126 + 768, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
  addCell(fold, 0x30000102, { pos: [126 + 384, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
  const fm = createInteriorMask({ THREE, checkFrames: 1 });
  syncWorld(fm, fold);
  const fs = fm.stats();
  check("buckets (10, 10) and (74, 10) fold onto slot (10, 10): 1 gpuCollision, 2 slots held",
    fs.gpuCollisions === 1 && fs.gpuBuckets === 2 && fs.gpuOverflow === 0, JSON.stringify(fs));
  check("the first keeps the slot; the folded one culls on the CPU only; a free slot is unaffected",
    fm.gpuContainsMirror(126, 126, 20.5) && fm.contains(126, 126, 20.5)
    && !fm.gpuContainsMirror(894, 126, 20.5) && fm.contains(894, 126, 20.5)
    && fm.gpuContainsMirror(510, 126, 20.5));

  // A box wider than the whole slot grid (68 buckets): 4 folds onto itself.
  const wide = makeWorld();
  addCell(wide, 0x40000100, { pos: [5000, 5000, 0], quat: yawQ(0), meshes: [{ geometry: boxGeometry([-400, -2, 0, 400, 2, 3]) }], ext: [-400, -2, 0, 400, 2, 3] });
  const wm = createInteriorMask({ THREE, checkFrames: 1 });
  threw = false;
  try { syncWorld(wm, wide); } catch (_) { threw = true; }
  const ws = wm.stats();
  check("an 800 m box: no throw, 64 slots, the 4 extra buckets counted as gpuCollisions",
    !threw && ws.gpuBuckets === 64 && ws.gpuCollisions === 4, JSON.stringify(ws));
  check("...it culls across its first 64 buckets on the GPU, the folded tail on the CPU only",
    wm.gpuContainsMirror(5000, 5000, 0.5) && wm.gpuContainsMirror(4610, 5000, 0.5)
    && !wm.gpuContainsMirror(5390, 5000, 0.5) && wm.contains(5390, 5000, 0.5));
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. the clear path ----------------------------------------------");
{
  const world = makeWorld();
  buildTown(world);
  const mask = createInteriorMask({ THREE, checkFrames: 1 });
  syncWorld(mask, world);
  const tb = mask.uniforms.uHbIndoorBoxes.value, tk = mask.uniforms.uHbIndoorBuckets.value;
  const v = [tb.version, tk.version];
  const inside = toRootPoint(world.boxes[0], 0, 0, 0.2);
  check("before: a point in the cottage culls on both paths", mask.contains(...inside) && mask.gpuContainsMirror(...inside));
  world.map.clear();
  check("an empty cell set reports a change", syncWorld(mask, world) === true);
  check("both arrays are zeroed", mask._boxData.every((x) => x === 0) && mask._bucketData.every((x) => x === 0));
  check("both textures are flagged for upload", tb.version > v[0] && tk.version > v[1]);
  check("uHbIndoorOn = 0", mask.uniforms.uHbIndoorOn.value === 0);
  check("nothing culls on either path", !mask.contains(...inside) && !mask.gpuContainsMirror(...inside));
  const st = mask.stats();
  check("GPU stats read empty", st.gpuBoxes === 0 && st.gpuBuckets === 0 && st.gpuOverflow === 0 && st.gpuCollisions === 0);
  const r0 = st.gpuRefreshes, v2 = [tb.version, tk.version];
  check("a second empty sync is a no-op (no refresh, no upload)",
    syncWorld(mask, world) === false && mask.stats().gpuRefreshes === r0 && tb.version === v2[0] && tk.version === v2[1]);
  // A set where every cell is still pending: no boxes, uHbIndoorOn 0.
  const pend = makeWorld();
  addCell(pend, 0x50000100, { pos: [100, 100, 0], quat: yawQ(0), meshes: [], ext: null, pendingOnly: true });
  const pm = createInteriorMask({ THREE, checkFrames: 1 });
  pm.sync({ cellContainers3d: pend.map, worldRoot: pend.root });
  check("an all-pending cell set: 0 GPU boxes, uHbIndoorOn 0, the mirror refuses",
    pm.stats().pending === 1 && pm.stats().gpuBoxes === 0 && pm.uniforms.uHbIndoorOn.value === 0 && !pm.gpuContainsMirror(100, 100, 0.5));
  // Rebuilt after the clear: the same answers as a fresh mask.
  buildTown(world);
  syncWorld(mask, world);
  const fresh = createInteriorMask({ gpu: true, checkFrames: 1 });
  syncWorld(fresh, world);
  let agree = 0;
  for (const [x, y, z] of TOWN_HITS.rnd.slice(0, 20000)) if (mask.gpuContainsMirror(x, y, z) === fresh.gpuContainsMirror(x, y, z)) agree += 1;
  check("refilled after a clear: identical to a fresh mask", agree === 20000 && mask.uniforms.uHbIndoorOn.value === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- 6. the CPU path is unchanged ------------------------------------");
{
  const world = makeWorld();
  buildTown(world);
  // b = the shipping CPU path: terrain_grass.js creates the mask with no
  // arguments, so no GPU mirror at all (opts.gpu defaults to !!opts.THREE).
  const a = createInteriorMask({ THREE, checkFrames: 1 }), b = createInteriorMask({ checkFrames: 1 });
  const ra = syncWorld(a, world), rb = syncWorld(b, world);
  let diff = 0;
  for (const [x, y, z] of TOWN_HITS.rnd) if (a.contains(x, y, z) !== b.contains(x, y, z)) diff += 1;
  const sa = a.stats(), sb = b.stats();
  const cpuKeys = ["rebuilds", "cells", "boxes", "pending", "tests", "hits", "enabled"];
  check("contains() is identical in GPU mode (THREE) and CPU mode on 80k points", diff === 0 && ra === rb);
  check("CPU stats identical (rebuilds, cells, boxes, pending, tests, hits, enabled)", cpuKeys.every((k) => sa[k] === sb[k]));
  check("the mirror touches no CPU counter",
    (() => { const t = a.stats().tests, h = a.stats().hits; a.gpuContainsMirror(32500, 34600, 60.2); return a.stats().tests === t && a.stats().hits === h; })());
  check("lastChanged still lists the boxes the first build added", Array.isArray(a.lastChanged()) && a.lastChanged().length === 8);
  // 2026-10-23 — CPU mode allocates nothing GPU-side and writes nothing.
  const inside = toRootPoint(world.boxes[0], 0, 0, 0.2);
  for (const [name, m] of [["no arguments (the CPU grass path)", b], ["THREE with gpu: false", createInteriorMask({ THREE, gpu: false, checkFrames: 1 })]]) {
    syncWorld(m, world);
    const asked = m.setGpuCenter(inside[0], inside[1], inside[2], 200);
    syncWorld(m, world);
    const s = m.stats();
    check(`CPU mode, ${name}: no arrays, null textures, uHbIndoorOn 0, no GPU write, setGpuCenter() a no-op (false)`,
      m._boxData === null && m._bucketData === null && m.uniforms.uHbIndoorBoxes.value === null
      && m.uniforms.uHbIndoorBuckets.value === null && m.uniforms.uHbIndoorOn.value === 0 && asked === false
      && s.gpu === false && s.gpuRefreshes === 0 && s.gpuBoxes === 0 && s.gpuCentered === false && s.gpuCenter === null && s.gpuRecentres === 0,
      JSON.stringify(s));
    check(`CPU mode, ${name}: contains() culls, gpuContainsMirror() is always false, dispose() is safe`,
      m.contains(...inside) === true && m.gpuContainsMirror(...inside) === false && (() => { try { m.dispose(); return true; } catch (_) { return false; } })());
  }
  check("GPU mode reports itself (stats.gpu)", sa.gpu === true && createInteriorMask({ gpu: true }).stats().gpu === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- 7. player-centred writes (synthetic): policy, clip, order -------");
{
  const D200 = indoorGpuRecentreM(200), D320 = indoorGpuRecentreM(320);
  check("D = clamp(384 - reach - 24, 16, 160): 160 at reach 200, 40 at 320 (?terrainGrassReach=8), floor 16",
    INDOOR_GPU_SPAN_HALF_M === 384 && D200 === 160 && D320 === 40 && indoorGpuRecentreM(0) === 160
    && indoorGpuRecentreM(400) === 16 && INDOOR_GPU_DEFAULT_REACH_M === 200);
  const world = makeWorld();
  buildTown(world);
  const mask = createInteriorMask({ THREE, checkFrames: 1 });
  const tb = mask.uniforms.uHbIndoorBoxes.value, tk = mask.uniforms.uHbIndoorBuckets.value;
  syncWorld(mask, world);
  let s = mask.stats();
  check("before any setGpuCenter(): the old uncentred write (gpuCentered false, gpuCenter null, every box a candidate)",
    s.gpuCentered === false && s.gpuCenter === null && s.gpuReach === null && s.gpuCandidates === 8 && s.gpuBoxes === 8
    && s.gpuRecentres === 0, JSON.stringify(s));
  const r0 = s.gpuRefreshes;
  check("non-finite x / y are ignored: false, nothing recorded, nothing written",
    mask.setGpuCenter(NaN, 34600, 60) === false && mask.setGpuCenter(32500, Infinity, 60) === false && mask.setGpuCenter() === false
    && syncWorld(mask, world) === false && mask.stats().gpuRefreshes === r0 && mask.stats().gpuCentered === false);
  const C = [32540, 34620, 60];
  check("the first setGpuCenter() asks for a write...", mask.setGpuCenter(C[0], C[1], C[2], 200) === true);
  check("...and writes nothing itself", mask.stats().gpuRefreshes === r0 && mask.stats().gpuCentered === false);
  const v0 = [tb.version, tk.version];
  const ret = syncWorld(mask, world);
  s = mask.stats();
  check("the next sync() does it once: one refresh, each texture flagged once, gpuRecentres 1, centred on {x, y}, reach 200, "
    + "7 candidates (the off-world box at (-30, -40) is outside the span)",
    s.gpuRefreshes === r0 + 1 && tb.version === v0[0] + 1 && tk.version === v0[1] + 1 && s.gpuRecentres === 1
    && s.gpuCentered === true && s.gpuCenter.x === C[0] && s.gpuCenter.y === C[1] && s.gpuReach === 200
    && s.gpuCandidates === 7 && s.gpuBoxes === 7 && s.boxes === 8, JSON.stringify(s));
  check("...and sync() still returns false (no cell-set change: the CPU pool must not re-scatter)", ret === false);
  check("stats() hands out a copy of gpuCenter", (() => { mask.stats().gpuCenter.x = 1; return mask.stats().gpuCenter.x === C[0]; })());
  const at = mask.stats().gpuCenter;
  const go = (x, y, reach) => {
    const asked = mask.setGpuCenter(x, y, 60, reach);
    const r = mask.stats().gpuRefreshes;
    const sr = syncWorld(mask, world);
    return { asked, wrote: mask.stats().gpuRefreshes - r, sr };
  };
  let t = go(at.x + D200 - 1, at.y - (D200 - 1), 200);
  check(`a move of ${D200 - 1} m on both axes (under D): no rewrite`, !t.asked && t.wrote === 0 && !t.sr);
  t = go(at.x + D200, at.y + D200, 200);
  check(`exactly D on both axes: still none (it takes MORE than D)`, !t.asked && t.wrote === 0 && !t.sr);
  t = go(at.x + D200 + 1, at.y, 200);
  check("more than D on x alone: rewrite, centred on the new point", t.asked && t.wrote === 1 && !t.sr && mask.stats().gpuCenter.x === at.x + D200 + 1);
  const at2 = mask.stats().gpuCenter;
  t = go(at2.x, at2.y - D200 - 1, 200);
  check("more than D on y alone (measured from the last write): rewrite", t.asked && t.wrote === 1 && !t.sr);
  const at3 = mask.stats().gpuCenter;
  t = go(at3.x, at3.y, 320);
  check("a reach change alone (200 -> 320): rewrite, gpuReach 320", t.asked && t.wrote === 1 && mask.stats().gpuReach === 320);
  t = go(at3.x + D320 - 1, at3.y, 320);
  const t2 = go(at3.x + D320 + 1, at3.y, 320);
  check(`reach 320: D shrinks to ${D320} m (${D320 - 1} m: none, ${D320 + 1} m: rewrite)`, !t.asked && t.wrote === 0 && t2.asked && t2.wrote === 1);
  const at4 = mask.stats().gpuCenter;
  t = go(at4.x, at4.y, undefined);
  check("reachM omitted = INDOOR_GPU_DEFAULT_REACH_M (a change from 320: rewrite, gpuReach 200)", t.asked && t.wrote === 1 && mask.stats().gpuReach === 200);
  t = go(at4.x, at4.y, 200);
  check("...then the same centre at reach 200 again: none", !t.asked && t.wrote === 0);
  t = go(at4.x, at4.y, 200.004);
  check("a reach that jitters by under 1 cm (recomputed every frame): none", !t.asked && t.wrote === 0);

  // At most one write per frame, however setGpuCenter() and sync() interleave.
  {
    const r = mask.stats().gpuRefreshes, rc = mask.stats().gpuRecentres;
    const a1 = mask.setGpuCenter(at4.x + 500, at4.y, 60, 200), a2 = mask.setGpuCenter(at4.x + 900, at4.y + 900, 60, 200);
    const a3 = mask.setGpuCenter(at4.x + 10, at4.y, 60, 200); // back within D of the last write
    syncWorld(mask, world);
    check("three setGpuCenter() calls before one sync(): one write, around the LAST centre",
      a1 && a2 && !a3 && mask.stats().gpuRefreshes === r + 1 && mask.stats().gpuRecentres === rc + 1
      && mask.stats().gpuCenter.x === at4.x + 10, JSON.stringify(mask.stats()));
    const r2 = mask.stats().gpuRefreshes, rb = mask.stats().rebuilds;
    mask.setGpuCenter(at4.x - 400, at4.y, 60, 200);
    world.map.set(0xa9b40300, world.map.get(0xa9b40103)); // the cell set changes in the same frame
    const sr = syncWorld(mask, world);
    check("a re-centre in the same frame as a cell-set change: ONE write (the rebuild, with the new centre); sync() true as before",
      sr === true && mask.stats().rebuilds === rb + 1 && mask.stats().gpuRefreshes === r2 + 1
      && mask.stats().gpuCenter.x === at4.x - 400 && Array.isArray(mask.lastChanged()) && mask.lastChanged().length === 1);
    world.map.delete(0xa9b40300);
    syncWorld(mask, world);
  }
  {
    // checkFrames 30: the re-centre lands on a frame whose cell check is skipped.
    const m = createInteriorMask({ THREE, checkFrames: 30 });
    syncWorld(m, world); // frame 1 builds
    syncWorld(m, world); syncWorld(m, world);
    const r = m.stats().gpuRefreshes;
    const asked = m.setGpuCenter(C[0], C[1], C[2], 200);
    const sr = syncWorld(m, world);
    check("checkFrames 30: sync() performs the re-centre on a frame that skips the cell check (returns false)",
      asked && sr === false && m.stats().gpuRefreshes === r + 1 && m.stats().gpuCentered === true && m.stats().rebuilds === 1);
  }
  {
    // A random interleaving against a CPU-mode twin fed the same cell set.
    const m = createInteriorMask({ THREE, checkFrames: 3 }), twin = createInteriorMask({ checkFrames: 3 });
    const w2 = makeWorld();
    buildTown(w2);
    const extra = [...w2.map.entries()];
    const R = rng(0xce17e);
    let maxWrites = 0, maxVer = 0, retDiff = 0, lcDiff = 0, both = 0;
    let px = 32540, py = 34620;
    for (let f = 0; f < 600; f += 1) {
      if (R() < 0.15) { const [id, c] = extra[Math.floor(R() * extra.length)]; if (w2.map.has(id)) w2.map.delete(id); else w2.map.set(id, c); }
      const calls = Math.floor(R() * 4);
      for (let k = 0; k < calls; k += 1) {
        if (R() < 0.1) { px = 32000 + R() * 1200; py = 34000 + R() * 1200; } else { px += (R() - 0.5) * 120; py += (R() - 0.5) * 120; }
        m.setGpuCenter(px, py, 60, R() < 0.05 ? 320 : 200);
      }
      const r = m.stats().gpuRefreshes, v = tbVersion(m), rb = m.stats().rebuilds;
      const sm = m.sync({ cellContainers3d: w2.map, worldRoot: w2.root }), st = twin.sync({ cellContainers3d: w2.map, worldRoot: w2.root });
      const wrote = m.stats().gpuRefreshes - r;
      if (wrote && m.stats().rebuilds > rb && calls) both += 1;
      maxWrites = Math.max(maxWrites, wrote);
      maxVer = Math.max(maxVer, tbVersion(m) - v);
      if (sm !== st) retDiff += 1;
      if (JSON.stringify(m.lastChanged()) !== JSON.stringify(twin.lastChanged())) lcDiff += 1;
    }
    const sm = m.stats();
    check("600 random frames (0-3 setGpuCenter() calls each, cell churn): never more than one write / upload per sync()",
      maxWrites <= 1 && maxVer <= 1 && sm.gpuRecentres > 20, `maxWrites ${maxWrites} maxVer ${maxVer} recentres ${sm.gpuRecentres} both ${both}`);
    check("...and sync()'s return and lastChanged() match a CPU-mode twin on every frame",
      retDiff === 0 && lcDiff === 0 && sm.rebuilds === twin.stats().rebuilds, `ret ${retDiff} lastChanged ${lcDiff}`);
  }
  {
    // Nothing to hold, nothing held: an all-zero rewrite uploads nothing.
    const m = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(m, world);
    m.setGpuCenter(5000, 5000, 0, 200); syncWorld(m, world);
    const s1 = m.stats(), v = tbVersion(m);
    m.setGpuCenter(5400, 5000, 0, 200); syncWorld(m, world);
    const s2 = m.stats();
    check("a re-centre far from every box empties the arrays once; the next empty re-centre uploads nothing",
      s1.gpuCandidates === 0 && s1.gpuBoxes === 0 && m.uniforms.uHbIndoorOn.value === 0 && m._bucketData.every((x) => x === 0)
      && s2.gpuRecentres === s1.gpuRecentres + 1 && s2.gpuRefreshes === s1.gpuRefreshes && tbVersion(m) === v
      && s2.gpuCenter.x === 5400, JSON.stringify(s2));
    m.setGpuCenter(C[0], C[1], C[2], 200); syncWorld(m, world);
    check("...and back in town the boxes return", m.stats().gpuBoxes === 7 && m.gpuContainsMirror(...toRootPoint(world.boxes[0], 0, 0, 0.2)));
  }

  // The fold of section 4, centred: no slot is contested inside the span.
  {
    const fold = makeWorld();
    const g4 = boxGeometry([-2, -2, 0, 2, 2, 3]);
    addCell(fold, 0x30000100, { pos: [126, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
    addCell(fold, 0x30000101, { pos: [126 + 768, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
    addCell(fold, 0x30000102, { pos: [126 + 384, 126, 20], quat: yawQ(0), meshes: [{ geometry: g4 }], ext: [-2, -2, 0, 2, 2, 3] });
    const fm = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(fm, fold);
    fm.setGpuCenter(894, 126, 20, 200); syncWorld(fm, fold);
    const fs = fm.stats();
    check("centred on the folded bucket (74, 10): span x buckets [42, 105]; candidates 2, no collision",
      fs.gpuCandidates === 2 && fs.gpuCollisions === 0 && fs.gpuBuckets === 2, JSON.stringify(fs));
    check("...the player's bucket now culls on the GPU; the far one (outside the span) does not",
      fm.gpuContainsMirror(894, 126, 20.5) && fm.gpuContainsMirror(510, 126, 20.5) && !fm.gpuContainsMirror(126, 126, 20.5) && fm.contains(126, 126, 20.5));
    fm.setGpuCenter(126, 126, 20, 200); syncWorld(fm, fold);
    check("...and back at (10, 10): that bucket holds the slot again, 894 is out of the span",
      fm.gpuContainsMirror(126, 126, 20.5) && !fm.gpuContainsMirror(894, 126, 20.5) && fm.stats().gpuCollisions === 0 && fm.stats().gpuCandidates === 1);
  }
  // An 800 m box: its bucket loop is clipped to the span, no self-fold.
  {
    const wide = makeWorld();
    addCell(wide, 0x40000100, { pos: [5000, 5000, 0], quat: yawQ(0), meshes: [{ geometry: boxGeometry([-400, -2, 0, 400, 2, 3]) }], ext: [-400, -2, 0, 400, 2, 3] });
    const wm = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(wm, wide);
    wm.setGpuCenter(5000, 5000, 0, 200); syncWorld(wm, wide);
    const ws = wm.stats();
    // centre bucket 416: span [384, 447] = x in [4608, 5376)
    check("an 800 m box, centred: 64 buckets (the span), 0 collisions",
      ws.gpuBuckets === 64 && ws.gpuCollisions === 0 && ws.gpuCandidates === 1, JSON.stringify(ws));
    check("...it culls across the span on the GPU and nowhere past it (the CPU culls all of it)",
      wm.gpuContainsMirror(4610, 5000, 0.5) && wm.gpuContainsMirror(5370, 5000, 0.5)
      && !wm.gpuContainsMirror(4600, 5000, 0.5) && !wm.gpuContainsMirror(5390, 5000, 0.5) && wm.contains(5390, 5000, 0.5) && wm.contains(4600, 5000, 0.5));
  }
  // A full bucket keeps its NEAREST CAP ids (3D), Map order when z is unknown.
  {
    const CAP = INDOOR_GPU_BUCKET_CAP, NS = CAP + 4;
    const stack = makeWorld();
    const geom = boxGeometry([-2, -2, 0, 2, 2, 3]);
    for (let k = 0; k < NS; k += 1) addCell(stack, 0x10000100 + k, { pos: [33606, 34806, 50 + 3 * k], quat: yawQ(0), meshes: [{ geometry: geom }], ext: [-2, -2, 0, 2, 2, 3] });
    const sm = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(sm, stack);
    sm.setGpuCenter(33606, 34806, 50 + 3 * (NS - 1) + 1, 200); syncWorld(sm, stack);
    const storey = (k) => sm.gpuContainsMirror(33606, 34806, 50.75 + 3 * k);
    const ks = [...Array(NS).keys()];
    check(`${NS} storeys, centred at the top: the top ${CAP} cull on the GPU, the bottom 4 (farthest) are the ones dropped`,
      ks.every((k) => storey(k) === k >= 4) && sm.stats().gpuOverflow === 4 && sm.stats().gpuMaxPerBucket === NS, JSON.stringify(sm.stats()));
    sm.setGpuCenter(33606, 34806, NaN, 300); syncWorld(sm, stack);
    check("...z not finite: 2D distance (all tie), so Map order decides: the first CAP keep their ids",
      ks.every((k) => storey(k) === k < CAP) && sm.stats().gpuCentered);
  }
  // Past the row cap the FARTHEST candidates go.
  {
    const NB = INDOOR_GPU_MAX_BOXES + 6;
    const big = makeWorld();
    const tiny = boxGeometry([-0.5, -0.5, 0, 0.5, 0.5, 2]);
    const centre = (i) => [1200 + 1.5 + 3 * (i % 32), 1200 + 1.5 + 3 * Math.floor(i / 32), 10.5];
    for (let i = 0; i < NB; i += 1) addCell(big, 0x20000000 + i, { pos: [centre(i)[0], centre(i)[1], 10], quat: yawQ(0), meshes: [{ geometry: tiny }], ext: [-0.5, -0.5, 0, 0.5, 0.5, 2] });
    const bm = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(bm, big);
    const P = [1291.3, 1203.7, 10.5];
    bm.setGpuCenter(P[0], P[1], P[2], 200); syncWorld(bm, big);
    const dist = (i) => { const [x, y] = centre(i), h = 0.75; return Math.hypot(Math.max(Math.abs(x - P[0]) - h, 0), Math.max(Math.abs(y - P[1]) - h, 0)); };
    const far = [...Array(NB).keys()].sort((a, b) => dist(b) - dist(a)).slice(0, 6);
    const missed = [...Array(NB).keys()].filter((i) => !bm.gpuContainsMirror(...centre(i)));
    const bs = bm.stats();
    check(`${NB} boxes, centred off a corner: ${INDOOR_GPU_MAX_BOXES} rows, 6 counted, and the 6 the GPU misses are the 6 farthest`,
      bs.gpuCandidates === NB && bs.gpuBoxes === INDOOR_GPU_MAX_BOXES && bs.gpuBoxOverflow === 6 && bs.gpuCollisions === 0
      && missed.length === 6 && far.every((i) => missed.includes(i)) && [...Array(NB).keys()].every((i) => bm.contains(...centre(i))),
      `missed ${missed} far ${far}`);
  }
  // GROUND FIRST: with an oracle, a box that cannot touch the terrain under it
  // sorts after every box that can (or whose terrain is unknown).
  {
    const CAP = INDOOR_GPU_BUCKET_CAP, NS = CAP + 4;
    const stack = makeWorld();
    const geom = boxGeometry([-2, -2, 0, 2, 2, 3]);
    for (let k = 0; k < NS; k += 1) addCell(stack, 0x10000100 + k, { pos: [33606, 34806, 50 + 3 * k], quat: yawQ(0), meshes: [{ geometry: geom }], ext: [-2, -2, 0, 2, 2, 3] });
    // Flat terrain at z = 201: inside storey 50 only (floor 200: accepts 199 .. 202.5).
    const H = 50 + 3 * 50 + 1;
    let terrain = null, ver = 0, lookups = 0;
    const oracle = {
      lookup(k) { lookups += 1; return terrain && k === ((Math.floor(33606 / 192) << 24 | Math.floor(34806 / 192) << 16) >>> 0) ? terrain : null; },
      version: () => ver,
    };
    const om = createInteriorMask({ THREE, checkFrames: 3, oracle: () => oracle });
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 1 (check) builds, uncentred
    om.setGpuCenter(33606, 34806, 50, 200);
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 2 writes
    const storey = (k) => om.gpuContainsMirror(33606, 34806, 50.75 + 3 * k);
    const ks = [...Array(NS).keys()];
    let s1 = om.stats();
    check("an oracle with no terrain resident: every box 'may touch the ground', so the order is the distance order (the bottom CAP kept)",
      ks.every((k) => storey(k) === k < CAP) && s1.gpuOffGround === 0 && s1.gpuOverflow === 4 && lookups > 0, JSON.stringify(s1));
    const g0 = s1.gpuGroundRewrites, r0 = s1.gpuRefreshes;
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 3: no check
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 4: check, version unchanged
    check("...an unchanged oracle version re-ranks nothing", om.stats().gpuRefreshes === r0 && om.stats().gpuGroundRewrites === g0);
    terrain = { heights: new Float32Array(81).fill(H) };
    ver += 1;
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 5: no check
    const early = om.stats().gpuRefreshes === r0;
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 6: no check
    om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); // frame 7: check -> re-rank
    s1 = om.stats();
    check("terrain arrives (version moves) under a capped write: re-ranked once, on the next cell-check frame",
      early && s1.gpuRefreshes === r0 + 1 && s1.gpuGroundRewrites === g0 + 1 && s1.gpuRecentres === 1, JSON.stringify(s1));
    check(`...now the only storey the terrain passes through (50) holds a row and culls the ground at z ${H}, though it is the farthest`,
      storey(50) && om.gpuContainsMirror(33606, 34806, H) && om.contains(33606, 34806, H) && s1.gpuOffGround === NS - 1
      && ks.filter((k) => k !== 50).every((k) => storey(k) === k < CAP - 1));
    const plain = createInteriorMask({ THREE, checkFrames: 3 });
    plain.sync({ cellContainers3d: stack.map, worldRoot: stack.root });
    plain.setGpuCenter(33606, 34806, 50, 200);
    plain.sync({ cellContainers3d: stack.map, worldRoot: stack.root });
    check("...without an oracle the same write drops storey 50 (the GPU would plant grass on that floor)",
      !plain.gpuContainsMirror(33606, 34806, H) && plain.contains(33606, 34806, H) && plain.stats().gpuOffGround === 0);
    for (let f = 0; f < 6; f += 1) { ver += 1; om.sync({ cellContainers3d: stack.map, worldRoot: stack.root }); }
    check("...the version moving every frame re-ranks at most once per cell-check (2 in 6 frames at checkFrames 3)",
      om.stats().gpuGroundRewrites - s1.gpuGroundRewrites <= 2 && om.stats().gpuRefreshes - s1.gpuRefreshes <= 2);
    // An uncapped write never re-ranks (order cannot matter when nothing is dropped).
    const small = makeWorld();
    addCell(small, 0x10000200, { pos: [33606, 34806, 200], quat: yawQ(0), meshes: [{ geometry: geom }], ext: [-2, -2, 0, 2, 2, 3] });
    const um = createInteriorMask({ THREE, checkFrames: 1, oracle });
    um.setGpuCenter(33606, 34806, 200, 200);
    um.sync({ cellContainers3d: small.map, worldRoot: small.root });
    const ur = um.stats().gpuRefreshes;
    ver += 1; um.sync({ cellContainers3d: small.map, worldRoot: small.root });
    check("an uncapped write: an oracle version change re-ranks nothing; a plain oracle object works as well as a getter",
      um.stats().gpuRefreshes === ur && um.stats().gpuGroundRewrites === 0 && um.stats().gpuBoxes === 1);
    const bad = createInteriorMask({ THREE, checkFrames: 1, oracle: () => { throw new Error("no oracle yet"); } });
    bad.setGpuCenter(33606, 34806, 200, 200);
    let threw = false;
    try { bad.sync({ cellContainers3d: small.map, worldRoot: small.root }); } catch (_) { threw = true; }
    check("a throwing oracle getter is ignored (distance order, no throw)", !threw && bad.stats().gpuBoxes === 1);
  }
}

// ---------------------------------------------------------------------------
// 8. Real data. DAT reader: the directory B-tree walk of test_terrain_grass_offroad.mjs.
// ---------------------------------------------------------------------------
function openDat(path) {
  const fd = openSync(path, "r");
  const hdr = Buffer.alloc(36);
  readSync(fd, hdr, 0, 36, 0x140);
  const blockSize = hdr.readUInt32LE(4);
  const root = hdr.readUInt32LE(32);
  const readAt = (len, off) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const readData = (offset, size) => { // block chain: u32 next, then data
    const out = Buffer.alloc(size);
    let cur = offset, done = 0;
    while (done < size) {
      const next = readAt(4, cur).readUInt32LE(0);
      const take = next === 0 ? size - done : Math.min(size - done, blockSize - 4);
      readAt(take, cur + 4).copy(out, done);
      done += take; cur = next;
    }
    return out;
  };
  const find = (id) => { // 62 branches, count, 24-byte entries ascending by id
    let node = root;
    for (let depth = 0; node && depth < 32; depth += 1) {
      const d = readData(node, 1716);
      const count = d.readUInt32LE(248);
      const leaf = d.readUInt32LE(0) === 0;
      let i = 0;
      for (; i < count; i += 1) {
        const eid = d.readUInt32LE(252 + 24 * i + 4);
        if (eid === id) { const e = 252 + 24 * i; return { offset: d.readUInt32LE(e + 8), size: d.readUInt32LE(e + 12) }; }
        if (eid > id) break;
      }
      if (leaf) return null;
      node = d.readUInt32LE(4 * i);
    }
    return null;
  };
  const get = (id) => { const e = find(id >>> 0); return e ? readData(e.offset, e.size) : null; };
  return { get, close: () => closeSync(fd) };
}

/** CellLandblock: u32 id, u32 hasObjects, u16 terrain[81], u8 height[81]. */
function readLandblock(dat, lbX, lbY) {
  const b = dat.get((((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xffff) >>> 0);
  if (!b) return null;
  const codes = new Uint8Array(81), roads = new Uint8Array(81), heights = new Float32Array(81);
  for (let v = 0; v < 81; v += 1) {
    const w = b.readUInt16LE(8 + 2 * v);
    roads[v] = w & 0x3;
    codes[v] = (w >> 2) & 0x1f;
    heights[v] = b[8 + 162 + v] * 2; // retail LandHeightTable == byte*2
  }
  return { lbX, lbY, codes, roads, heights };
}

function cursor(b) {
  let o = 0;
  return {
    get pos() { return o; },
    u8: () => b[o++],
    u16: () => { const v = b.readUInt16LE(o); o += 2; return v; },
    i16: () => { const v = b.readInt16LE(o); o += 2; return v; },
    u32: () => { const v = b.readUInt32LE(o); o += 4; return v; },
    i32: () => { const v = b.readInt32LE(o); o += 4; return v; },
    f32: () => { const v = b.readFloatLE(o); o += 4; return v; },
    skip: (n) => { o += n; },
    align: () => { if (o % 4) o += 4 - (o % 4); },
  };
}

/** ACE EnvCell.Unpack up to the frame: environment, cell structure, origin, quaternion (w x y z). */
function readEnvCell(b) {
  const r = cursor(b);
  const id = r.u32(), flags = r.u32(); r.skip(4);
  const nSurf = r.u8(); r.u8(); r.u16();
  r.skip(2 * nSurf);
  const env = (0x0d000000 | r.u16()) >>> 0;
  const cellStruct = r.u16();
  const origin = [r.f32(), r.f32(), r.f32()];
  const qw = r.f32(), qx = r.f32(), qy = r.f32(), qz = r.f32();
  return { id, flags, env, cellStruct, origin, quat: [qw, qx, qy, qz] };
}

// BSP trees are skipped node by node (ACE BSPNode / BSPLeaf / BSPPortal; retail
// BSPNODE::UnPack: a tag it does not know, e.g. BPFL, has no children).
const TAG_PORT = 0x504f5254, TAG_LEAF = 0x4c454146;
const BSP_CELL = 0, BSP_PHYSICS = 1, BSP_DRAWING = 2;
function skipBsp(r, type) {
  const tag = r.u32();
  if (tag === TAG_LEAF) {
    r.i32();
    if (type === BSP_PHYSICS) { r.i32(); r.skip(16); r.skip(2 * r.u32()); }
    return;
  }
  if (tag === TAG_PORT) {
    r.skip(16);
    skipBsp(r, type); skipBsp(r, type);
    if (type === BSP_DRAWING) { r.skip(16); const np = r.u32(), nq = r.u32(); r.skip(2 * np + 4 * nq); }
    return;
  }
  r.skip(16);
  const s = String.fromCharCode(tag >>> 24, (tag >>> 16) & 255, (tag >>> 8) & 255, tag & 255);
  if (s === "BPnn" || s === "BPIn" || s === "BpIN" || s === "BpnN") skipBsp(r, type);
  else if (s === "BPIN" || s === "BPnN") { skipBsp(r, type); skipBsp(r, type); }
  if (type === BSP_CELL) return;
  r.skip(16);
  if (type === BSP_PHYSICS) return;
  r.skip(2 * r.u32());
}
function readPolygons(r, n, used) {
  for (let i = 0; i < n; i += 1) {
    r.u16();
    const np = r.u8(), stip = r.u8(), sides = r.i32(); r.i16(); r.i16();
    for (let k = 0; k < np; k += 1) { const v = r.i16() & 0xffff; if (used) used.push(v); }
    if (!(stip & 4)) r.skip(np);                   // !NoPos
    if (sides === 2 && !(stip & 8)) r.skip(np);    // Clockwise && !NoNeg
  }
}
/** Environment (0x0D): CellStruct key -> the positions its drawing polygons use (Float32Array). */
function readEnvironment(b) {
  const r = cursor(b);
  r.u32();
  const n = r.u32();
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = r.u32();
    const nPoly = r.u32(), nPhys = r.u32(), nPort = r.u32();
    if (r.i32() !== 1) throw new Error("CellStruct vertex type != 1");
    const nv = r.u32();
    const verts = new Map();
    for (let k = 0; k < nv; k += 1) {
      const vid = r.u16(), nuv = r.u16();
      verts.set(vid, [r.f32(), r.f32(), r.f32()]);
      r.skip(12 + 8 * nuv);
    }
    const used = [];
    readPolygons(r, nPoly, used);
    r.skip(2 * nPort); r.align();
    skipBsp(r, BSP_CELL);
    readPolygons(r, nPhys, null);
    skipBsp(r, BSP_PHYSICS);
    if (r.u32() !== 0) skipBsp(r, BSP_DRAWING);
    r.align();
    const pos = [];
    for (const v of used) { const p = verts.get(v); if (p) pos.push(p[0], p[1], p[2]); }
    out.set(key, new Float32Array(pos));
  }
  return { cells: out, consumed: r.pos === b.length };
}

/**
 * One landblock's EnvCells, parsed once per run (2026-10-23: the walks below
 * revisit landblocks): [{ id, pos, quat, geometry, ext }] in cell-id order.
 * `parsed` = every Environment this call read was consumed to its last byte.
 */
const LB_CELLS = new Map();
function realLbCells(cellDat, portalDat, lx, ly, envCache) {
  const key = lx * 256 + ly;
  if (LB_CELLS.has(key)) return { recs: LB_CELLS.get(key), parsed: true };
  const recs = [];
  let parsed = true;
  const info = cellDat.get(((lx << 24) | (ly << 16) | 0xfffe) >>> 0); // LandBlockInfo: u32 id, u32 numCells
  const n = info ? info.readUInt32LE(4) : 0;
  for (let c = 0; c < n; c += 1) {
    const id = ((lx << 24) | (ly << 16) | (0x100 + c)) >>> 0;
    const buf = cellDat.get(id);
    if (!buf) continue;
    const ec = readEnvCell(buf);
    if (!envCache.has(ec.env)) {
      const eb = portalDat.get(ec.env);
      const env = eb ? readEnvironment(eb) : { cells: new Map(), consumed: false };
      parsed = parsed && env.consumed;
      envCache.set(ec.env, env);
    }
    const pos = envCache.get(ec.env).cells.get(ec.cellStruct);
    if (!pos || pos.length < 9) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const ext = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) {
      for (let a = 0; a < 3; a += 1) { ext[a] = Math.min(ext[a], pos[k + a]); ext[3 + a] = Math.max(ext[3 + a], pos[k + a]); }
    }
    const [qw, qx, qy, qz] = ec.quat;
    recs.push({
      id,
      pos: [lx * 192 + ec.origin[0], ly * 192 + ec.origin[1], ec.origin[2]],
      quat: new THREE.Quaternion(qx, qy, qz, qw), // cells.js acQuatToThree
      geometry, ext,
    });
  }
  LB_CELLS.set(key, recs);
  return { recs, parsed };
}

/** Appends one landblock's cells the world does not hold yet (a cells.js build). */
function addRealLb(cellDat, portalDat, lx, ly, envCache, world) {
  const { recs, parsed } = realLbCells(cellDat, portalDat, lx, ly, envCache);
  let cells = 0;
  for (const c of recs) {
    if (world.map.has(c.id)) continue;
    addCell(world, c.id, { pos: c.pos, quat: c.quat, meshes: [{ geometry: c.geometry }], ext: c.ext });
    cells += 1;
  }
  return { cells, parsed };
}

/** Every EnvCell of the (2r+1)^2 landblocks around (cx, cy) as live-shaped containers. */
function loadRealCells(cellDat, portalDat, cx, cy, r, envCache, world) {
  let cells = 0, parsed = true;
  for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) {
    const a = addRealLb(cellDat, portalDat, cx + dx, cy + dy, envCache, world);
    cells += a.cells;
    parsed = parsed && a.parsed;
  }
  return { cells, parsed };
}

/** Ground points at the real terrain height: a 1 m grid over the window, 0.25 m over every box. */
function groundPoints(oracle, world, x0, y0, x1, y1) {
  const pts = [];
  const s = {};
  const push = (x, y) => { const q = oracle.sample(x, y, s); if (q && q.hasHeight && Number.isFinite(q.height)) pts.push([x, y, q.height]); };
  for (let x = x0 + 0.37; x < x1; x += 1) for (let y = y0 + 0.41; y < y1; y += 1) push(x, y);
  for (const b of world.boxes) {
    const a = b.aabb;
    for (let x = a[0] - 1.03; x < a[2] + 1; x += 0.25) for (let y = a[1] - 1.07; y < a[3] + 1; y += 0.25) push(x, y);
  }
  return pts;
}

/** Why the GPU mirror misses a point contains() holds: a fold, or every holder dropped. */
function explainMiss(mask, world, x, y, z) {
  const D = mask._bucketData, st = mask.stats();
  const bx = Math.floor(x / INDOOR_GPU_BUCKET_M), by = Math.floor(y / INDOOR_GPU_BUCKET_M);
  const h = ((by & 63) * BUCKET_TEX_W + (bx & 63) * INDOOR_GPU_BUCKET_TEXELS) * 4;
  const holders = [];
  world.boxes.forEach((b, i) => { if (refInBox(b, x, y, z, -EPS)) holders.push(i); });
  if (D[h + 3] >= 0.5 && (D[h] !== bx || D[h + 1] !== by)) return "fold";
  if (D[h + 3] < 0.5) return holders.every((i) => i >= st.gpuBoxes) ? "box-overflow" : null;
  const kept = new Set(Array.from(D.subarray(h + 4, h + 4 + INDOOR_GPU_BUCKET_CAP)).filter((v) => v >= 0));
  return D[h + 2] === INDOOR_GPU_BUCKET_CAP && holders.length > 0 && holders.every((i) => !kept.has(i)) ? "overflow" : null;
}

console.log("\n-- 8. real data: Holtburg 3x3 + the 0x4993 housing block ---------");
const PORTAL = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
if (!existsSync(PORTAL) || !existsSync(CELL)) {
  console.log(`  real-DAT section not run: ${existsSync(CELL) ? PORTAL : CELL} missing (set HB_PORTAL_DAT / HB_CELL_DAT)`);
} else {
  const cellDat = openDat(CELL), portalDat = openDat(PORTAL);
  const envCache = new Map();
  const oracleFor = (cx, cy, r) => {
    const o = createTerrainOracle();
    let n = 0;
    for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) {
      const lb = readLandblock(cellDat, cx + dx, cy + dy);
      if (lb && o.noteLandblock((((lb.lbX << 24) | (lb.lbY << 16)) >>> 0), lb)) n += 1;
    }
    return { o, n };
  };

  // Holtburg: the 3x3 ring cells.js keeps (ENVCELL_RING_RADIUS = 1).
  {
    const world = makeWorld();
    const { cells, parsed } = loadRealCells(cellDat, portalDat, 0xa9, 0xb4, 1, envCache, world);
    check("Holtburg 3x3: every Environment parsed to its last byte", parsed && envCache.size > 5, `envs ${envCache.size}`);
    check("Holtburg 3x3: the real EnvCells load (152 cells, all upright: yaw-only quaternions)",
      cells === 152 && world.boxes.every((b) => Math.abs(b.toRoot[2]) < 1e-6 && Math.abs(b.toRoot[6]) < 1e-6), String(cells));
    const mask = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(mask, world);
    const st = mask.stats();
    check("Holtburg 3x3: all boxes on the GPU, no fold, no overflow (fullest 12 m bucket <= the cap)",
      st.boxes === cells && st.gpuBoxes === cells && st.gpuCollisions === 0 && st.gpuOverflow === 0
      && st.gpuBoxOverflow === 0 && st.gpuMaxPerBucket <= INDOOR_GPU_BUCKET_CAP,
      `boxes ${st.boxes} buckets ${st.gpuBuckets} fullest ${st.gpuMaxPerBucket}`);
    const { o, n } = oracleFor(0xa9, 0xb4, 1);
    check("Holtburg 3x3: the terrain oracle holds the 9 real landblocks", n === 9);
    const x0 = 0xa8 * 192, y0 = 0xb3 * 192;
    const pts = groundPoints(o, world, x0, y0, x0 + 576, y0 + 576);
    const r = compare(mask, world.boxes, pts);
    check(`Holtburg 3x3: ${pts.length} ground points at the real terrain height: mirror == contains() == reference off the 1 cm band`,
      r.mirrorVsCpu === 0 && r.cpuVsRef === 0, JSON.stringify(r));
    check("Holtburg 3x3: real interiors do cull real ground (the z rules let ground floors through)",
      r.inside > 5000 && r.amb < pts.length * 0.01, `inside ${r.inside} amb ${r.amb}`);
    const z = randomPoints(world.boxes, 60000, 0xb0b, [x0, y0, 0, x0 + 576, y0 + 576, 120]);
    const rz = compare(mask, world.boxes, z);
    check("Holtburg 3x3: 60k points at any height (cellars, upper storeys): mirror == contains() == reference",
      rz.mirrorVsCpu === 0 && rz.cpuVsRef === 0 && rz.inside > 6000, JSON.stringify(rz));
  }

  // 0x4993: a housing block, 122 cells, up to 43 boxes in one 12 m bucket.
  {
    const world = makeWorld();
    const { cells } = loadRealCells(cellDat, portalDat, 0x49, 0x93, 1, envCache, world);
    const mask = createInteriorMask({ THREE, checkFrames: 1 });
    let threw = false;
    try { syncWorld(mask, world); } catch (_) { threw = true; }
    const st = mask.stats();
    const over = st.gpuMaxPerBucket > INDOOR_GPU_BUCKET_CAP;
    check(`0x4993 housing: no throw; fullest 12 m bucket ${st.gpuMaxPerBucket} vs cap ${INDOOR_GPU_BUCKET_CAP}, overflow counted iff over (${st.gpuOverflow} ids dropped)`,
      !threw && cells > 100 && st.boxes === cells && st.gpuMaxPerBucket >= 40 && (st.gpuOverflow > 0) === over && st.gpuCollisions === 0,
      `cells ${cells} overflow ${st.gpuOverflow} fullest ${st.gpuMaxPerBucket}`);
    const { o } = oracleFor(0x49, 0x93, 1);
    const x0 = 0x48 * 192, y0 = 0x92 * 192;
    const tally = (pts) => {
      const t = { inside: 0, misses: 0, falsePos: 0, unexplained: 0 };
      for (const [x, y, zz] of pts) {
        if (refInside(world.boxes, x, y, zz, -EPS) !== refInside(world.boxes, x, y, zz, EPS)) continue;
        const c = mask.contains(x, y, zz), g = mask.gpuContainsMirror(x, y, zz);
        if (c) t.inside += 1;
        if (g && !c) t.falsePos += 1;
        if (c && !g) { t.misses += 1; if (!explainMiss(mask, world, x, y, zz)) t.unexplained += 1; }
      }
      return t;
    };
    const pct = (t) => (100 * t.misses / Math.max(1, t.inside)).toFixed(1);
    const tg = tally(groundPoints(o, world, x0, y0, x0 + 576, y0 + 576));
    const ta = tally(randomPoints(world.boxes, 40000, 0x4993, [x0, y0, -20, x0 + 576, y0 + 576, 40]));
    check("0x4993 housing: the mirror never culls a point contains() keeps", tg.falsePos === 0 && ta.falsePos === 0, `${tg.falsePos} ${ta.falsePos}`);
    check(`0x4993 housing: every GPU miss is a box its full bucket dropped (ground: ${tg.misses} of ${tg.inside} indoor points = ${pct(tg)} %; any height: ${ta.misses} of ${ta.inside} = ${pct(ta)} %)`,
      tg.unexplained === 0 && ta.unexplained === 0 && tg.inside > 1000 && (over || tg.misses + ta.misses === 0),
      `unexplained ${tg.unexplained} ${ta.unexplained}`);
  }

  // --- 2026-10-23: the cell map the app really holds (review parity-1,
  // lifecycle-1, parity-2). cells.js builds the player's LB, then its skirt
  // (dx outer, dy inner); on every crossing the new leading column / row
  // builds, and the one 2 behind is edge-parked (fixedGrid) and unparked by
  // the Bug-5 resweep within 0.5 s, which re-appends its cells at the END of
  // the Map. Nothing else leaves under the LRU cap, so the old town stays.
  console.log("\n-- 8b. real data: walks, a dungeon -> town trip, a huge-cell LB ----");
  const addLb = (world, lx, ly) => addRealLb(cellDat, portalDat, lx, ly, envCache, world);
  const addRing = (world, cx, cy) => {
    addLb(world, cx, cy);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) if (dx || dy) addLb(world, cx + dx, cy + dy);
  };
  const reappendLb = (world, lx, ly) => {
    const pre = ((lx << 24) | (ly << 16)) >>> 0;
    for (const [id, c] of [...world.map]) if (((id & 0xffff0000) >>> 0) === pre) { world.map.delete(id); world.map.set(id, c); }
  };
  /** A straight walk along x or y, LB by LB, in the app's cell order. */
  const walkWorld = (sx, sy, ex, ey) => {
    const world = makeWorld();
    addRing(world, sx, sy);
    const alongX = ex !== sx, step = Math.sign(alongX ? ex - sx : ey - sy);
    const line = (k, fn) => { for (let d = -1; d <= 1; d += 1) { if (alongX) fn(k, sy + d); else fn(sx + d, k); } };
    for (let k = (alongX ? sx : sy) + step; k !== (alongX ? ex : ey) + step; k += step) {
      line(k + step, (x, y) => addLb(world, x, y));
      line(k - 2 * step, (x, y) => reappendLb(world, x, y));
    }
    return world;
  };
  const inSpan = (mask, x, y) => {
    // Every held slot's bucket lies in [cb - 32, cb + 31] and sits on its own slot.
    const D = mask._bucketData, cbx = Math.floor(x / INDOOR_GPU_BUCKET_M), cby = Math.floor(y / INDOOR_GPU_BUCKET_M);
    const H = INDOOR_GPU_BUCKET_SLOTS / 2;
    let held = 0, bad = 0;
    for (let sy = 0; sy < INDOOR_GPU_BUCKET_SLOTS; sy += 1) {
      for (let sx = 0; sx < INDOOR_GPU_BUCKET_SLOTS; sx += 1) {
        const h = (sy * BUCKET_TEX_W + sx * INDOOR_GPU_BUCKET_TEXELS) * 4;
        if (D[h + 3] < 0.5) continue;
        held += 1;
        const bx = D[h], by = D[h + 1];
        if (bx < cbx - H || bx > cbx + H - 1 || by < cby - H || by > cby + H - 1 || (bx & 63) !== sx || (by & 63) !== sy) bad += 1;
      }
    }
    return { held, bad };
  };
  /**
   * The mirror against contains() on the ground grid (1 m, at the real
   * terrain height) within `reach` of (ex, ey) on both axes. A disagreement
   * within EPS of a box boundary is f32 rounding (excused); `strict` false
   * only counts the points the GPU loses.
   */
  const tallyReach = (mask, world, pts, ex, ey, reach, strict = true) => {
    const t = { inside: 0, misses: 0, falsePos: 0, excused: 0 };
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2];
      if (Math.abs(x - ex) > reach || Math.abs(y - ey) > reach) continue;
      const c = mask.contains(x, y, z), g = mask.gpuContainsMirror(x, y, z);
      if (c) t.inside += 1;
      if (c === g) continue;
      if (strict && refInside(world.boxes, x, y, z, -EPS) !== refInside(world.boxes, x, y, z, EPS)) { t.excused += 1; continue; }
      if (c) t.misses += 1; else t.falsePos += 1;
    }
    return t;
  };
  const pctOf = (a, b) => (100 * a / Math.max(1, b)).toFixed(1);
  /**
   * One end point: the uncentred write (Map order; `bites` = it must lose
   * ground here), then a centred write at reach 200 and 320, without an
   * oracle and, with `ground`, with one (GROUND FIRST). `distanceLoses` =
   * without an oracle the reach-320 write must LOSE ground (the spot shows
   * distance alone is not enough); every other arm must match contains().
   */
  const scenario = (label, world, ex, ey, { bites = false, ground = false, distanceLoses = false } = {}) => {
    const lbX = Math.floor(ex / 192), lbY = Math.floor(ey / 192);
    const { o } = oracleFor(lbX, lbY, 3);
    const q0 = o.sample(ex, ey, {});
    const ez = q0 && q0.hasHeight ? q0.height : NaN;
    const RMAX = 320, pts = [];
    const sq = {};
    for (let x = ex - RMAX + 0.37; x <= ex + RMAX; x += 1) {
      for (let y = ey - RMAX + 0.41; y <= ey + RMAX; y += 1) {
        const q = o.sample(x, y, sq);
        if (q && q.hasHeight && Number.isFinite(q.height)) pts.push(x, y, q.height);
      }
    }
    const legacyMask = createInteriorMask({ THREE, checkFrames: 1 });
    syncWorld(legacyMask, world);
    const s0 = legacyMask.stats();
    const legacy = tallyReach(legacyMask, world, pts, ex, ey, 200, false);
    const legacyLine = `${label}: uncentred (Map order) the GPU loses ${legacy.misses} of ${legacy.inside} indoor ground points within 200 m (${pctOf(legacy.misses, legacy.inside)} %; ${s0.boxes} boxes, ${s0.gpuCollisions} collisions)`;
    if (bites) check(`${legacyLine} — the scenario bites`, legacy.misses > 0 && Number.isFinite(ez));
    else console.log(`  [info] ${legacyLine}`);
    const out = {};
    for (const withOracle of ground ? [false, true] : [false]) {
      const mask = createInteriorMask({ THREE, checkFrames: 1, oracle: withOracle ? () => o : undefined });
      syncWorld(mask, world);
      const arm = withOracle ? "GROUND FIRST (oracle)" : "distance only";
      const res = [];
      for (const reach of [200, RMAX]) {
        mask.setGpuCenter(ex, ey, ez, reach);
        const sr = syncWorld(mask, world);
        const st = mask.stats();
        const t = tallyReach(mask, world, pts, ex, ey, reach);
        const span = inSpan(mask, ex, ey);
        const sound = st.gpuCollisions === 0 && span.bad === 0 && span.held === st.gpuBuckets && sr === false && st.gpuCentered && st.gpuReach === reach;
        const info = JSON.stringify({ t, sr, span, st: { boxes: st.boxes, cand: st.gpuCandidates, rows: st.gpuBoxes, boxOvf: st.gpuBoxOverflow, ovf: st.gpuOverflow, maxPer: st.gpuMaxPerBucket, offGround: st.gpuOffGround, coll: st.gpuCollisions } });
        res.push({ reach, t, st, sound, info });
        if (distanceLoses && !withOracle) continue;
        check(`${label}, centred, ${arm}, reach ${reach}: mirror == contains() on ${t.inside} indoor of the ground grid within reach (excused within 1 cm: ${t.excused}); `
          + `${st.gpuCandidates} candidates of ${st.boxes} boxes, ${st.gpuBoxes} rows${withOracle ? `, ${st.gpuOffGround} off the ground` : ""}, 0 collisions, every slot in the span`,
          t.misses === 0 && t.falsePos === 0 && t.inside > 300 && sound, info);
      }
      if (distanceLoses && !withOracle) {
        const [a, b] = res;
        check(`${label}, centred, distance only: loses ground (reach 200: ${a.t.misses} of ${a.t.inside}, reach 320: ${b.t.misses} of ${b.t.inside}) — what GROUND FIRST is for`,
          b.t.misses > 0 && a.t.falsePos === 0 && b.t.falsePos === 0 && a.sound && b.sound, `${a.info} ${b.info}`);
      }
      out[withOracle ? "ground" : "plain"] = mask;
    }
    return out;
  };
  // (a) two towns 4 LBs apart on x (122 cells each): the fold.
  scenario("walk 0x3ED0 -> 0x42D0", walkWorld(0x3e, 0xd0, 0x42, 0xd0), 0x42 * 192 + 96, 0xd0 * 192 + 96, { bites: true });
  // (b) templated housing 4 LBs apart on y: every cottage folds.
  scenario("walk 0x55A0 -> 0x55A4", walkWorld(0x55, 0xa0, 0x55, 0xa4), 0x55 * 192 + 96, 0xa4 * 192 + 96, { bites: true });
  // (c) the Training Academy dungeons (1200+ cells), then Holtburg's 3x3: the
  // review's 1024-row loss; 2048 rows hold it now, but the academies still
  // fold onto 4 of Holtburg's slots uncentred.
  {
    const w = makeWorld();
    addLb(w, 0x86, 0x02);
    addLb(w, 0x85, 0x02);
    addRing(w, 0xa9, 0xb4);
    scenario("Academy 0x8602 + 0x8502 then Holtburg 0xA9B4", w, 0xa9 * 192 + 96, 0xb4 * 192 + 96, { bites: true });
  }
  // (d) a fresh 3x3 around one huge-cell LB (0xF930: 1526 cells, most of them
  // inside a hill next to grass): 1980 boxes, all rows, oracle or not.
  {
    const w = makeWorld();
    addRing(w, 0xf9, 0x30);
    const { plain, ground } = scenario("fresh 3x3 at 0xF930", w, 0xf9 * 192 + 150, 0x30 * 192 + 100, { ground: true });
    const sp = plain.stats(), sg = ground.stats();
    check(`fresh 3x3 at 0xF930: ${sp.boxes} boxes (past the old 1024 rows), all on the GPU; the oracle finds ${sg.gpuOffGround} of them off the ground`,
      sp.boxes > 1024 && sp.gpuBoxes === sp.boxes && sg.gpuOffGround > sp.boxes / 2);
    // (f) the same 3x3 seen from the valley in 0xF830 (fix-verify, 2026-10-23):
    // the hilltop bucket in 0xF92F holds more than 48 boxes, and distance alone
    // keeps the dungeon cells inside the hill (nearer the player's z) over the
    // ground-level ones, at the DEFAULT reach 200 too. GROUND FIRST keeps them;
    // this is why the provider passes the mask its oracle.
    const vx = 47804, vy = 9230;
    const { plain: vp } = scenario("0xF930 3x3 seen from the 0xF830 valley", w, vx, vy, { ground: true, distanceLoses: true });
    const { o: vo } = oracleFor(Math.floor(vx / 192), Math.floor(vy / 192), 3);
    const vq = vo.sample(vx, vy, {});
    vp.setGpuCenter(vx, vy, vq && vq.hasHeight ? vq.height : NaN, 200);
    syncWorld(vp, w);
    let vIn = 0, vMiss = 0;
    const sq = {};
    for (let x = 3989 * 12 + 0.11; x < 3990 * 12; x += 0.4) {
      for (let y = 757 * 12 + 0.17; y < 758 * 12; y += 0.4) {
        const q = vo.sample(x, y, sq);
        if (!q || !q.hasHeight || !vp.contains(x, y, q.height)) continue;
        vIn += 1;
        if (!vp.gpuContainsMirror(x, y, q.height)) vMiss += 1;
      }
    }
    check(`0xF830 valley, distance only, reach 200: the hilltop bucket (3989, 757) loses ${vMiss} of ${vIn} indoor ground points — the shipped default needs GROUND FIRST`,
      vIn > 100 && vMiss > 0, JSON.stringify(vp.stats()));
  }
  // (e) the world-corner dungeon LBs around 0x0101 (3726 boxes in the 3x3):
  // more candidates than rows, and distance cannot tell ground from dungeon.
  scenario("fresh 3x3 at 0x0101 (world corner)", (() => { const w = makeWorld(); addRing(w, 0x01, 0x01); return w; })(),
    192 + 0.37, 192 + 0.61, { ground: true, distanceLoses: true });
  cellDat.close(); portalDat.close();
}

console.log(`\ninterior mask GPU: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
