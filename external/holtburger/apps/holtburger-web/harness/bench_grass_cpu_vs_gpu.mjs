#!/usr/bin/env node
// harness/bench_grass_cpu_vs_gpu.mjs — main-thread cost of grass placement,
// CPU scatter pools vs `?terrainGrassGpu` vertex-shader placement, on a
// simulated run over real Holtburg terrain (2026-10-23; contract
// docs/2026-10-23-grass-gpu-placement.md "Validation: Bench (node)").
//
// WHY. The CPU path re-scatters blades while the player runs (oracle sample +
// dither + verge + interior test + six attribute writes per blade), measured
// at ~2.75 ms a frame on the 1070 (docs/improvement-hunt-2026-10-20/
// findings-round2.json). The GPU path moves placement into the vertex shader,
// so its per-frame CPU cost is the uniform tick in update() PLUS the per-draw
// tile cull each ring's onBeforeRender runs (an object-space frustum and up to
// 64 tiles per ring). This bench puts both on the same clock, in node, with no
// browser and no GL.
//
// WHAT IS SIMULATED
//   - Terrain: real landblocks from client_cell_1.dat (the DAT reader of
//     test_terrain_grass_offroad.mjs), noted into a real terrain oracle. The
//     game's resident ring is 13 x 13 landblocks (terrain_grass.js header), so
//     the ring around the start is noted before the first frame and, each time
//     the player enters a new landblock, the landblocks that enter the ring are
//     noted ONE PER FRAME (a bake queue) outside the timed region. Each note
//     bumps oracle.version(), which is what makes the GPU field re-walk.
//   - Interiors (`--interiors cells`, default with `none` too): the real
//     EnvCells of the player's 3x3 landblocks (cells.js ENVCELL_RING_RADIUS =
//     1; readers of test_terrain_grass_gpu.mjs), as the scene3d facade the
//     interior mask syncs from (`cellContainers3d` + `worldRoot`), re-streamed
//     with fresh geometry on every landblock change. `none` = `scene3d: null`.
//   - The run: 34 fps, 10.6 m/s (the 1070 ultra running numbers), from
//     Holtburg centre (0xA9B4) east through the town (roads, buildings), a 90
//     degree RIGHT turn, then south into solid grass (0xAAB3: 81 of 81
//     vertices are grass codes; north of the town is bare — 0xAAB5 has 6 — and
//     an empty field would flatter the CPU path). It crosses two landblock
//     edges. Frame 0 (build + first scatter) and a warm-up are not in the run
//     statistics. Then the player stops: a settle, then the standing
//     statistics. The run is also split by leg: east (an x-scroll re-assigns a
//     strided slot COLUMN of each pool), the turn, south (a y-scroll re-assigns
//     a contiguous slot ROW).
//   - The frame context is shaped like terrain_vfx.js `_frameCtx` (one reused
//     object: scene3d (facade or null), tSec, dt, playerPos, hasPlayer, camera,
//     quality, a LIVE oracle getter, trail null since stomp is off).
//   - GPU mode: after update(), every ring mesh's onBeforeRender(renderer stub,
//     scene, camera, geometry, material) is timed, with a third-person
//     PerspectiveCamera following the player under worldRoot's AC -> three
//     rotation (scene3d/index.js). That is ONE pass; every extra pass that
//     draws the grass pays it again. The CPU path has no per-render CPU work
//     (its InstancedMesh is frustumCulled = false, no onBeforeRender).
//
// WHAT IS NOT TIMED (no GL in node): buffer and texture UPLOADS. They are
// COUNTED instead: after each frame the bench consumes every changed buffer
// attribute (its updateRanges, or the whole array) and every changed texture,
// the way three's WebGLAttributes / WebGLTextures would, and reports the bytes.
// CPU timings are therefore a lower bound on the CPU path's real frame cost:
// an x-scroll re-scatters a strided slot column (one touched run per row),
// more runs than terrain_scatter.js `maxUpdateRuns` (4), so that flush falls
// back to a WHOLE-BUFFER upload of the ring (all seven attributes) — the east
// leg's KB/frame shows it.
//
// Numbers are this machine's CPU in node (V8, no browser), not the 1070 box:
// read them as CPU vs GPU on the same clock. performance.now is used HERE
// only (the bench's stopwatch); placement itself reads no clock.
//
// Run with (from apps/holtburger-web; ONE node process — the bench aborts if
// MemAvailable < 2.5 GB, see ~/CLAUDE.md):
//   node --expose-gc harness/bench_grass_cpu_vs_gpu.mjs
//     [--frames N]           timed running frames (default 680, min 600)
//     [--warmup N]           running frames before timing (default 120)
//     [--stand N]            timed standing frames (default 300)
//     [--interiors both|cells|none]   (default both)
//     [--config both|ultra|high] [--mode both|cpu|gpu]
//     [--json <path>]        also write the results (+ raw per-frame series) as JSON
//   (HB_CELL_DAT / HB_PORTAL_DAT override ~/ac_base_dats/client_{cell_1,portal}.dat)
// Exit 0 = every run measured something (CPU blades live, GPU instances drawn).

import { existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { performance, PerformanceObserver } from "node:perf_hooks";
import * as THREE from "three";

import { createTerrainGrassProvider } from "../scene3d/terrain_grass.js";
import { createTerrainOracle } from "../scene3d/terrain_oracle.js";
import { lbKeyFromXY } from "../scene3d/landblock_lru.js";

// ---------------------------------------------------------------------------
// Arguments + the memory guard.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}
const RUN_FRAMES = Math.max(600, parseInt(arg("frames", "680"), 10) || 680);
const WARMUP = Math.max(1, parseInt(arg("warmup", "120"), 10) || 120);
const STAND = Math.max(30, parseInt(arg("stand", "300"), 10) || 300);
const SETTLE = 60;
const INTERIORS = arg("interiors", "both");
const ONLY_CONFIG = arg("config", "both");
const ONLY_MODE = arg("mode", "both");
const JSON_OUT = arg("json", null);

const MIN_AVAILABLE_MB = 2560;
function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (_) {
    return null;
  }
}
{
  const avail = memAvailableMb();
  if (avail !== null && avail < MIN_AVAILABLE_MB) {
    console.log(`ABORT: MemAvailable ${avail} MB < ${MIN_AVAILABLE_MB} MB (~/CLAUDE.md: one heavy job at a time).`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
const FPS = 34;
const DT = 1 / FPS;
const SPEED_MPS = 10.6;
const STEP_M = SPEED_MPS / FPS;              // 0.3118 m per frame
const RUN_EAST = 300;                        // timed frames before the turn starts
const TURN_R_M = 12;                         // 90 deg right turn, ~60 frames
const START_X = 0xa9 * 192 + 96;             // Holtburg centre (0xA9B4)
const START_Y = 0xb4 * 192 + 96;
const LEG_A_M = (WARMUP + RUN_EAST) * STEP_M; // straight east, warm-up included
const TURN_M = TURN_R_M * Math.PI / 2;
const RUN_END_S = (WARMUP + RUN_FRAMES) * STEP_M;
const TERRAIN_RING = 6;                      // 13 x 13 resident landblocks
const CELL_RING = 1;                         // cells.js ENVCELL_RING_RADIUS
// Third-person camera: behind and above the player, looking down the path.
const CAM_BACK_M = 4.5, CAM_UP_M = 2.7, CAM_AHEAD_M = 30;

/** Player position + heading at path distance `s` (AC metres, +x east, +y north);
 *  `leg` 0 = east, 1 = the right turn, 2 = south. */
function pathAt(s, out) {
  if (s <= LEG_A_M) {
    out.x = START_X + s; out.y = START_Y; out.hx = 1; out.hy = 0; out.turn = false; out.leg = 0;
    return out;
  }
  let t = s - LEG_A_M;
  if (t <= TURN_M) {
    const a = t / TURN_R_M;
    out.x = START_X + LEG_A_M + TURN_R_M * Math.sin(a);
    out.y = START_Y - TURN_R_M * (1 - Math.cos(a));
    out.hx = Math.cos(a); out.hy = -Math.sin(a); out.turn = true; out.leg = 1;
    return out;
  }
  t -= TURN_M;
  out.x = START_X + LEG_A_M + TURN_R_M; out.y = START_Y - TURN_R_M - t; out.hx = 0; out.hy = -1; out.turn = false; out.leg = 2;
  return out;
}
const LEG_NAMES = ["east", "turn", "south"];

const CONFIGS = [
  { name: "ultra", label: "ultra 119716 / 40 m / reach 5", config: { blades: 119716, radiusM: 40, reach: 5 } },
  { name: "high", label: "high 60025 / 32 m / reach 5", config: { blades: 60025, radiusM: 32, reach: 5 } },
];

// ---------------------------------------------------------------------------
// DAT readers — the directory B-tree walk + CellLandblock of
// test_terrain_grass_offroad.mjs, and the EnvCell / Environment readers of
// test_terrain_grass_gpu.mjs (copied, not shared: tests own their readers).
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
    roads[v] = w & 0x3;              // the wasm `roadCodes` (raw 2-bit field)
    codes[v] = (w >> 2) & 0x1f;      // the wasm `terrainCodes`
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
/** Environment (0x0D): CellStruct key -> the positions its drawing polygons use. */
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

// ---------------------------------------------------------------------------
// Load everything the run can touch, once (none of this is timed).
// ---------------------------------------------------------------------------
const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const PORTAL = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
if (!existsSync(CELL)) {
  console.log(`ABORT: ${CELL} missing (set HB_CELL_DAT). This bench runs on real landblocks only.`);
  process.exit(2);
}
const wantCells = INTERIORS === "both" || INTERIORS === "cells";
if (wantCells && !existsSync(PORTAL)) {
  console.log(`ABORT: ${PORTAL} missing (set HB_PORTAL_DAT, or --interiors none).`);
  process.exit(2);
}

const lbKey = (lx, ly) => ((lx & 0xff) << 8) | (ly & 0xff);
const hex8 = (id) => (id >>> 0).toString(16).padStart(8, "0");

// Every landblock the player stands in (path sampled every metre, the stand included).
const PATH_LBS = new Set();
{
  const q = {};
  for (let s = 0; s <= RUN_END_S + 1; s += 1) {
    pathAt(s, q);
    PATH_LBS.add(lbKey(Math.floor(q.x / 192), Math.floor(q.y / 192)));
  }
}
function ringKeys(lx, ly, r, out = []) {
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const x = lx + dx, y = ly + dy;
      if (x >= 0 && x <= 255 && y >= 0 && y <= 255) out.push(lbKey(x, y));
    }
  }
  return out;
}
const TERRAIN_KEYS = new Set();
const CELL_KEYS = new Set();
for (const k of PATH_LBS) {
  for (const t of ringKeys(k >> 8, k & 0xff, TERRAIN_RING)) TERRAIN_KEYS.add(t);
  for (const t of ringKeys(k >> 8, k & 0xff, CELL_RING)) CELL_KEYS.add(t);
}

const tLoad0 = performance.now();
const LBDATA = new Map();
const CELLDATA = new Map();
let cellRecords = 0, envParsed = true;
{
  const cellDat = openDat(CELL);
  for (const k of TERRAIN_KEYS) {
    const lb = readLandblock(cellDat, k >> 8, k & 0xff);
    if (lb) LBDATA.set(k, lb);
  }
  if (wantCells) {
    const portalDat = openDat(PORTAL);
    const envCache = new Map();
    for (const k of CELL_KEYS) {
      const lx = k >> 8, ly = k & 0xff;
      const info = cellDat.get(((lx << 24) | (ly << 16) | 0xfffe) >>> 0); // LandBlockInfo: u32 id, u32 numCells
      const list = [];
      CELLDATA.set(k, list);
      if (!info) continue;
      const n = info.readUInt32LE(4);
      for (let c = 0; c < n; c += 1) {
        const id = ((lx << 24) | (ly << 16) | (0x100 + c)) >>> 0;
        const buf = cellDat.get(id);
        if (!buf) continue;
        const ec = readEnvCell(buf);
        if (!envCache.has(ec.env)) {
          const eb = portalDat.get(ec.env);
          const env = eb ? readEnvironment(eb) : { cells: new Map(), consumed: false };
          envParsed = envParsed && env.consumed;
          envCache.set(ec.env, env);
        }
        const pos = envCache.get(ec.env).cells.get(ec.cellStruct);
        if (!pos || pos.length < 9) continue;
        list.push({ id, lx, ly, origin: ec.origin, quat: ec.quat, pos });
        cellRecords += 1;
      }
    }
    portalDat.close();
  }
  cellDat.close();
}
const loadMs = performance.now() - tLoad0;

// ---------------------------------------------------------------------------
// The streamed world of one run: a fresh oracle, terrain ring + bake queue,
// and the 3x3 EnvCell ring as the live scene3d facade.
// ---------------------------------------------------------------------------
const T_LB = 1, T_CELLS = 2, T_BAKE = 4, T_MASK = 8, T_WALK = 16, T_GC = 32, T_TURN = 64;
const TAG_NAMES = [[T_LB, "lb-edge"], [T_CELLS, "cells-swap"], [T_BAKE, "lb-note"], [T_MASK, "mask-rebuild"],
  [T_WALK, "field-walk"], [T_GC, "gc"], [T_TURN, "turn"]];
const tagStr = (t) => TAG_NAMES.filter(([b]) => t & b).map(([, n]) => n).join(",") || "-";

/** cells.js's shape: container `envcell-<id>` -> `mesh-<id>` (cell frame) -> structure mesh. */
function makeContainer(rec) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(rec.pos, 3));
  const container = new THREE.Group();
  container.name = `envcell-${hex8(rec.id)}`;
  const mg = new THREE.Group();
  mg.name = `mesh-${hex8(rec.id)}`;
  mg.position.set(rec.lx * 192 + rec.origin[0], rec.ly * 192 + rec.origin[1], rec.origin[2]);
  const [qw, qx, qy, qz] = rec.quat;
  mg.quaternion.set(qx, qy, qz, qw); // cells.js acQuatToThree
  container.add(mg);
  const mesh = new THREE.Mesh(geometry);
  mesh.name = "surfaces-fused-opaque";
  mg.add(mesh);
  return container;
}

function createWorld(oracle, cellsGroup, cellMap, interiors) {
  const noted = new Set();
  const queued = new Set();
  const queue = [];
  let curLb = -1;
  let cellLbs = new Set();
  const st = { notes: 0, lbEdges: 0, cellSwaps: 0 };
  function note(k) {
    noted.add(k);
    const lb = LBDATA.get(k);
    if (!lb) return false;
    oracle.noteLandblock(lbKeyFromXY(lb.lbX, lb.lbY), { codes: lb.codes, heights: lb.heights, roads: lb.roads, lbX: lb.lbX, lbY: lb.lbY });
    st.notes += 1;
    return true;
  }
  function swapCells(lx, ly) {
    const want = new Set(ringKeys(lx, ly, CELL_RING));
    for (const [id, c] of cellMap) {
      if (want.has(lbKey(id >>> 24, (id >>> 16) & 0xff))) continue;
      cellMap.delete(id);
      cellsGroup.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
    for (const k of want) {
      if (cellLbs.has(k)) continue;
      for (const rec of CELLDATA.get(k) || []) {
        const c = makeContainer(rec);
        cellsGroup.add(c);
        cellMap.set(rec.id, c);
      }
    }
    cellLbs = want;
    st.cellSwaps += 1;
  }
  return {
    st,
    /** The resident ring + cells around the start, before frame 0. */
    init(x, y) {
      const lx = Math.floor(x / 192), ly = Math.floor(y / 192);
      for (const k of ringKeys(lx, ly, TERRAIN_RING)) note(k);
      curLb = lbKey(lx, ly);
      if (interiors) swapCells(lx, ly);
    },
    /** Per frame, before the provider tick (untimed). Returns the T_* tags. */
    step(x, y) {
      let tags = 0;
      const lx = Math.floor(x / 192), ly = Math.floor(y / 192);
      const k = lbKey(lx, ly);
      if (k !== curLb) {
        curLb = k;
        tags |= T_LB;
        st.lbEdges += 1;
        for (const q of ringKeys(lx, ly, TERRAIN_RING)) {
          if (!noted.has(q) && !queued.has(q)) { queued.add(q); queue.push(q); }
        }
        if (interiors) { swapCells(lx, ly); tags |= T_CELLS; }
      }
      if (queue.length) {
        const q = queue.shift();
        queued.delete(q);
        if (note(q)) tags |= T_BAKE;
      }
      return tags;
    },
    dispose() {
      for (const c of cellMap.values()) c.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      cellMap.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Upload accounting (what three would send on the next render).
// ---------------------------------------------------------------------------
function createUploadMeter() {
  const items = [];          // { obj, tex, last }
  const seen = new Set();
  return {
    add(obj, tex) {
      if (!obj || seen.has(obj)) return;
      seen.add(obj);
      items.push({ obj, tex, last: 0 });
    },
    /** Bytes three would upload now; marks them uploaded (clears the ranges). */
    consume() {
      let bytes = 0;
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        const o = it.obj;
        if (o.version === it.last) continue;
        it.last = o.version;
        if (it.tex) {
          const d = o.image && o.image.data;
          bytes += d ? d.byteLength : 0;
          continue;
        }
        const r = o.updateRanges;
        if (r && r.length) {
          let n = 0;
          for (let k = 0; k < r.length; k += 1) n += r[k].count;
          bytes += n * o.array.BYTES_PER_ELEMENT;
          if (typeof o.clearUpdateRanges === "function") o.clearUpdateRanges();
        } else {
          bytes += o.array ? o.array.byteLength : 0;
        }
      }
      return bytes;
    },
  };
}
function meterGeometry(meter, geometry) {
  if (!geometry) return;
  for (const a of Object.values(geometry.attributes)) meter.add(a, false);
  if (geometry.index) meter.add(geometry.index, false);
}

// ---------------------------------------------------------------------------
// Statistics.
// ---------------------------------------------------------------------------
function summarize(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (!n) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i];
  const rank = (p) => a[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { n, mean: s / n, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: a[n - 1] };
}
const f3 = (v) => v.toFixed(3);
const fmt = (s) => `mean ${f3(s.mean)}  p50 ${f3(s.p50)}  p95 ${f3(s.p95)}  max ${f3(s.max)}`;
const kb = (b) => (b / 1024).toFixed(1);
/** The `k` largest frames of `ms`, with their tags. */
function topFrames(ms, tags, k = 3) {
  const idx = ms.map((v, i) => i).sort((a, b) => ms[b] - ms[a]).slice(0, k);
  return idx.map((i) => `${f3(ms[i])} @${i} [${tagStr(tags[i])}]`).join("; ");
}

// GC pauses, attributed to timed frames after each run.
const gcEntries = [];
let gcObserver = null;
try {
  gcObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcEntries.push({ t: e.startTime, d: e.duration }); });
  gcObserver.observe({ entryTypes: ["gc"] });
} catch (_) { gcObserver = null; }
const flushObservers = () => new Promise((resolve) => setTimeout(resolve, 30));

// ---------------------------------------------------------------------------
// One run: one config, one mode, one interiors variant.
// ---------------------------------------------------------------------------
const RENDERER_STUB = Object.freeze({ isBenchRendererStub: true });

async function runOne(cfgDef, gpu, interiors) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  await flushObservers();
  const gcFrom = gcEntries.length;

  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;      // AC Z-up -> three Y-up (scene3d/index.js)
  scene.add(worldRoot);
  const cellsGroup = new THREE.Group();
  cellsGroup.name = "cells";
  worldRoot.add(cellsGroup);
  const cellMap = new Map();
  const scene3d = interiors ? { cellContainers3d: cellMap, worldRoot } : null;
  scene.updateMatrixWorld(true);

  const oracle = createTerrainOracle();
  const world = createWorld(oracle, cellsGroup, cellMap, interiors);
  world.init(START_X, START_Y);

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 3000);
  const provider = createTerrainGrassProvider({
    THREE, parent: worldRoot,
    config: { ...cfgDef.config, density: 1, stomp: false, offRoad: true, gpu },
  });
  const modeOk = provider.mode === (gpu ? "gpu" : "cpu");

  // terrain_vfx.js `_frameCtx`, one reused object.
  const ctx = {
    scene3d,
    tSec: 0,
    dt: DT,
    playerPos: { x: START_X, y: START_Y, z: 0 },
    hasPlayer: true,
    camera,
    quality: null,
    get oracle() { return oracle; },
    trail: null,
  };

  const pos = { x: 0, y: 0, hx: 1, hy: 0, turn: false };
  const eye = new THREE.Vector3(), aim = new THREE.Vector3();
  const meter = createUploadMeter();
  let meshes = null;
  let ringTs = null;
  let lastZ = 0;
  let maskRebuilds = 0, fieldWalks = 0;

  const total = 1 + WARMUP + RUN_FRAMES + SETTLE + STAND;
  const runStart = 1 + WARMUP, runEnd = runStart + RUN_FRAMES;      // [runStart, runEnd)
  const standStart = runEnd + SETTLE, standEnd = standStart + STAND;
  // t0..tu = the timed update, tc..t1 = the timed cull (tc === t1 on CPU).
  const R = { upd: [], cull: [], tags: [], up: [], t0: [], tu: [], tc: [], t1: [], drawn: [], tiles: null, resc: [], leg: [] };
  const S = { upd: [], cull: [], tags: [], up: [], t0: [], tu: [], tc: [], t1: [], drawn: [], resc: [] };
  let firstMs = 0, firstUpload = 0, firstCull = 0;

  for (let f = 0; f < total; f += 1) {
    const s = Math.min(f, runEnd - 1) * STEP_M;
    pathAt(s, pos);
    let tags = world.step(pos.x, pos.y) | (pos.turn && f < runEnd ? T_TURN : 0);
    const gz = oracle.heightAt(pos.x, pos.y);
    if (Number.isFinite(gz)) lastZ = gz;
    ctx.playerPos.x = pos.x;
    ctx.playerPos.y = pos.y;
    ctx.playerPos.z = lastZ;
    ctx.tSec = f * DT;
    ctx.dt = DT;

    const t0 = performance.now();
    provider.update(DT, ctx);
    const t1 = performance.now();

    // The renderer's half (untimed): world matrices, the camera, then the
    // per-object onBeforeRender — the GPU path's tile cull (timed).
    if (f === 0) {
      meshes = gpu ? provider._meshes.filter(Boolean) : [];
      ringTs = gpu ? provider._ringStates.map((st) => st.ts) : [];
      if (gpu) {
        for (const m of meshes) meterGeometry(meter, m.geometry);
        const fld = provider._field;
        if (fld) { meter.add(fld.uniforms.uHbField.value, true); meter.add(fld.uniforms.uHbFieldKey.value, true); }
        const mk = provider._indoorMask;
        if (mk && mk.uniforms) { meter.add(mk.uniforms.uHbIndoorBoxes.value, true); meter.add(mk.uniforms.uHbIndoorBuckets.value, true); }
      } else {
        for (const pool of provider._pools) {
          if (!pool.mesh) continue;
          meter.add(pool.mesh.instanceMatrix, false);
          meterGeometry(meter, pool.mesh.geometry);
        }
      }
      R.tiles = meshes.map(() => []);
    }
    eye.set(pos.x - CAM_BACK_M * pos.hx, pos.y - CAM_BACK_M * pos.hy, lastZ + CAM_UP_M);
    aim.set(pos.x + CAM_AHEAD_M * pos.hx, pos.y + CAM_AHEAD_M * pos.hy, lastZ);
    worldRoot.localToWorld(eye);
    worldRoot.localToWorld(aim);
    camera.position.copy(eye);
    camera.lookAt(aim);
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();

    let cull = 0;
    let drawn = 0;
    const t2 = performance.now();
    for (let k = 0; k < meshes.length; k += 1) {
      const m = meshes[k];
      m.onBeforeRender(RENDERER_STUB, scene, camera, m.geometry, m.material);
    }
    const t3 = performance.now();
    if (meshes.length) cull = t3 - t2;
    for (let k = 0; k < meshes.length; k += 1) drawn += meshes[k].geometry.instanceCount;

    const upload = meter.consume();
    const mask = provider._indoorMask;
    if (mask) {
      const rb = mask.stats().rebuilds;
      if (rb !== maskRebuilds) { tags |= T_MASK; maskRebuilds = rb; }
    }
    const fld = provider._field;
    if (fld) {
      const w = fld.stats().walks;
      if (w !== fieldWalks) { tags |= T_WALK; fieldWalks = w; }
    }

    if (f === 0) {
      firstMs = t1 - t0;
      firstCull = cull;
      firstUpload = upload;
      continue;
    }
    const bin = f >= runStart && f < runEnd ? R : (f >= standStart && f < standEnd ? S : null);
    if (!bin) continue;
    bin.upd.push(t1 - t0);
    bin.cull.push(cull);
    bin.tags.push(tags);
    bin.up.push(upload);
    bin.t0.push(t0);
    bin.tu.push(t1);
    bin.tc.push(meshes.length ? t2 : t1);
    bin.t1.push(meshes.length ? t3 : t1);
    bin.drawn.push(drawn);
    if (bin === R) R.leg.push(pos.leg);
    if (!gpu) {
      let n = 0;
      for (const pool of provider._pools) n += pool.stats().lastRescattered;
      bin.resc.push(n);
    } else if (bin === R) {
      for (let k = 0; k < meshes.length; k += 1) R.tiles[k].push(meshes[k].geometry.instanceCount / (ringTs[k] * ringTs[k]));
    }
  }

  // Sanity: the run measured real grass (not an empty field).
  const pst = provider.stats();
  const liveCpu = gpu ? null : pst.visibleBlades;
  const sane = modeOk && (gpu ? summarize(R.drawn).mean > 0 && pst.buildError === null : liveCpu > 0 && pst.buildError === null);
  const maskSt = provider._indoorMask ? provider._indoorMask.stats() : null;
  const fieldSt = provider._field ? provider._field.stats() : null;
  provider.dispose();
  world.dispose();

  // GC pauses that began inside a timed region of a frame (the update, or the cull).
  await flushObservers();
  const gcs = gcEntries.slice(gcFrom);
  const gcIn = { run: { n: 0, ms: 0 }, stand: { n: 0, ms: 0 } };
  for (const g of gcs) {
    for (const [bin, key] of [[R, "run"], [S, "stand"]]) {
      // Binary search the frame whose t0 <= g.t.
      let lo = 0, hi = bin.t0.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bin.t0[mid] <= g.t) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at >= 0 && (g.t <= bin.tu[at] || (g.t >= bin.tc[at] && g.t <= bin.t1[at]))) {
        bin.tags[at] |= T_GC;
        gcIn[key].n += 1;
        gcIn[key].ms += g.d;
      }
    }
  }

  const totRun = R.upd.map((v, i) => v + R.cull[i]);
  const totStand = S.upd.map((v, i) => v + S.cull[i]);
  const count = (tags, bit) => tags.reduce((a, t) => a + (t & bit ? 1 : 0), 0);
  const byLeg = LEG_NAMES.map((name, l) => {
    const ix = [];
    for (let i = 0; i < R.leg.length; i += 1) if (R.leg[i] === l) ix.push(i);
    return {
      leg: name, frames: ix.length,
      total: summarize(ix.map((i) => totRun[i])),
      uploadKB: summarize(ix.map((i) => R.up[i] / 1024)),
      rescatteredPerFrame: gpu ? null : summarize(ix.map((i) => R.resc[i])),
    };
  });
  return {
    config: cfgDef.name, label: cfgDef.label, mode: gpu ? "gpu" : "cpu", interiors: interiors ? "cells" : "none",
    sane, firstMs, firstCull, firstUploadKB: firstUpload / 1024,
    run: {
      frames: R.upd.length,
      update: summarize(R.upd), cull: summarize(R.cull), total: summarize(totRun),
      uploadKB: summarize(R.up.map((b) => b / 1024)),
      topUpdate: topFrames(R.upd, R.tags), topTotal: topFrames(totRun, R.tags),
      events: {
        lbEdges: count(R.tags, T_LB), cellSwaps: count(R.tags, T_CELLS), lbNotes: count(R.tags, T_BAKE),
        maskRebuilds: count(R.tags, T_MASK), fieldWalks: count(R.tags, T_WALK), gcFrames: count(R.tags, T_GC),
      },
      gc: gcIn.run,
      rescatteredPerFrame: gpu ? null : summarize(R.resc),
      instancesDrawn: gpu ? summarize(R.drawn) : null,
      tilesPerRing: gpu ? R.tiles.map((t) => +summarize(t).mean.toFixed(1)) : null,
      byLeg,
    },
    stand: {
      frames: S.upd.length,
      update: summarize(S.upd), cull: summarize(S.cull), total: summarize(totStand),
      uploadKB: summarize(S.up.map((b) => b / 1024)),
      topTotal: topFrames(totStand, S.tags),
      gc: gcIn.stand,
      rescatteredPerFrame: gpu ? null : summarize(S.resc),
    },
    liveBladesAtEnd: liveCpu,
    blades: pst.blades,
    mask: maskSt ? { cells: maskSt.cells, boxes: maskSt.boxes, rebuilds: maskSt.rebuilds, gpuOverflow: maskSt.gpuOverflow } : null,
    field: fieldSt ? { walks: fieldSt.walks, writes: fieldSt.writes, slotsValid: fieldSt.slotsValid } : null,
    world: { ...world.st },
    // Raw per-frame series (written only with --json): ms, KB, tag bits, leg.
    series: {
      run: { update: R.upd, cull: R.cull, uploadKB: R.up.map((b) => b / 1024), tags: R.tags, leg: R.leg },
      stand: { update: S.upd, cull: S.cull, uploadKB: S.up.map((b) => b / 1024), tags: S.tags },
      tagBits: Object.fromEntries(TAG_NAMES.map(([b, n]) => [n, b])),
    },
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
console.log("grass placement bench — CPU scatter pools vs ?terrainGrassGpu (node, no browser, no GL)");
console.log("=========================================================================================");
console.log(`  node ${process.version}, three r${THREE.REVISION}, MemAvailable ${memAvailableMb()} MB, gc() ${typeof globalThis.gc === "function" ? "exposed" : "NOT exposed (run with --expose-gc)"}`);
console.log(`  terrain: ${LBDATA.size} real landblocks from ${CELL} (13x13 ring around each landblock on the path; `
  + `noted on entry, one per frame); path landblocks ${[...PATH_LBS].map((k) => (k >> 8).toString(16) + (k & 0xff).toString(16)).join(" -> ")}`);
if (wantCells) {
  console.log(`  interiors: ${cellRecords} real EnvCells over ${CELL_KEYS.size} landblocks (3x3 around the player, streamed); `
    + `every Environment parsed to its last byte: ${envParsed}`);
}
console.log(`  DAT load + parse: ${loadMs.toFixed(0)} ms (not timed below)`);
console.log(`  run: ${FPS} fps, ${SPEED_MPS} m/s (${STEP_M.toFixed(4)} m/frame) from Holtburg centre (0xA9B4 +96,+96): `
  + `warm-up ${WARMUP} frames, then ${RUN_FRAMES} timed frames = east ${RUN_EAST}, a ${TURN_R_M} m right turn `
  + `(${(TURN_M / STEP_M).toFixed(0)} frames), south ${Math.max(0, RUN_FRAMES - RUN_EAST - Math.round(TURN_M / STEP_M))}; `
  + `then stop, settle ${SETTLE}, ${STAND} timed standing frames`);
console.log("  timed: provider.update() [both]; every ring mesh's onBeforeRender (one pass, third-person PerspectiveCamera) [gpu].");
console.log("  NOT timed: uploads (counted as KB/frame instead), DAT reads, landblock notes, cell streaming, matrices.");
console.log("  ms per frame. Tags on the slowest frames: lb-edge, cells-swap, lb-note, mask-rebuild, field-walk, gc, turn.");

const variants = INTERIORS === "both" ? [true, false] : [INTERIORS !== "none"];
const configs = CONFIGS.filter((c) => ONLY_CONFIG === "both" || c.name === ONLY_CONFIG);
const modes = ONLY_MODE === "both" ? [false, true] : [ONLY_MODE === "gpu"];
const results = [];
for (const interiors of variants) {
  console.log(`\n== interiors: ${interiors ? "real EnvCells, 3x3 around the player, streamed (scene3d facade)" : "none (ctx.scene3d = null)"} ==`);
  for (const c of configs) {
    for (const gpu of modes) {
      const r = await runOne(c, gpu, interiors);
      results.push(r);
      console.log(`\n-- ${r.label} — ${r.mode.toUpperCase()}${r.sane ? "" : "   [WARN: measured nothing]"} --`);
      console.log(`  frame 0 (build${gpu ? "" : " + full scatter"}): update ${f3(r.firstMs)} ms${gpu ? `, cull ${f3(r.firstCull)} ms` : ""}, upload ${kb(r.firstUploadKB * 1024)} KB`);
      console.log(`  RUN   update  ${fmt(r.run.update)}`);
      if (gpu) console.log(`  RUN   cull    ${fmt(r.run.cull)}`);
      console.log(`  RUN   total   ${fmt(r.run.total)}   (p99 ${f3(r.run.total.p99)})`);
      console.log(`  RUN   slowest total frames: ${r.run.topTotal}`);
      console.log(`  RUN   by leg: ${r.run.byLeg.map((l) => `${l.leg} (${l.frames} f) total mean ${f3(l.total.mean)} p95 ${f3(l.total.p95)}, `
        + `upload mean ${l.uploadKB.mean.toFixed(1)} KB${l.rescatteredPerFrame ? `, ${l.rescatteredPerFrame.mean.toFixed(0)} re-scattered` : ""}`).join("; ")}`);
      console.log(`  STAND update  ${fmt(r.stand.update)}`);
      if (gpu) console.log(`  STAND cull    ${fmt(r.stand.cull)}`);
      console.log(`  STAND total   ${fmt(r.stand.total)}   slowest: ${r.stand.topTotal}`);
      console.log(`  uploads (counted, not timed): run mean ${r.run.uploadKB.mean.toFixed(1)} KB/frame, p95 ${r.run.uploadKB.p95.toFixed(1)}, `
        + `max ${r.run.uploadKB.max.toFixed(1)}; stand mean ${r.stand.uploadKB.mean.toFixed(1)} KB/frame`);
      const ev = r.run.events;
      console.log(`  run events: lb-edge ${ev.lbEdges}, cells-swap ${ev.cellSwaps}, lb-note ${ev.lbNotes}, mask-rebuild ${ev.maskRebuilds}, `
        + `field-walk ${ev.fieldWalks}; GC pauses inside timed frames: run ${r.run.gc.n} (${r.run.gc.ms.toFixed(2)} ms), stand ${r.stand.gc.n} (${r.stand.gc.ms.toFixed(2)} ms)`);
      if (gpu) {
        console.log(`  drawn: ${r.run.instancesDrawn.mean.toFixed(0)} instances/frame mean of ${r.blades} blades `
          + `(tiles kept per ring, mean of 64: ${r.run.tilesPerRing.join(" / ")}); field ${JSON.stringify(r.field)}`);
      } else {
        console.log(`  work: ${r.run.rescatteredPerFrame.mean.toFixed(0)} blades re-scattered/frame running (p95 ${r.run.rescatteredPerFrame.p95}), `
          + `${r.stand.rescatteredPerFrame.mean.toFixed(0)} standing; live at the end ${r.liveBladesAtEnd} of ${r.blades}`);
      }
      if (r.mask) console.log(`  interior mask: ${r.mask.cells} cells, ${r.mask.boxes} boxes, ${r.mask.rebuilds} rebuilds${gpu ? `, gpuOverflow ${r.mask.gpuOverflow}` : ""}`);
    }
  }
}

console.log("\n== SUMMARY — main-thread ms per frame (RUN: running frames; STAND: standing still) ==");
console.log("  interiors config mode | RUN update mean/p95/max   | RUN cull mean/p95/max     | RUN total mean/p95/max    | STAND total mean/p95/max  | upload KB/f run mean/max");
for (const r of results) {
  const t = (s) => `${f3(s.mean)}/${f3(s.p95)}/${f3(s.max)}`.padEnd(26);
  console.log(`  ${r.interiors.padEnd(9)} ${r.config.padEnd(6)} ${r.mode}  | ${t(r.run.update)}| ${r.mode === "gpu" ? t(r.run.cull) : "-".padEnd(26)}| `
    + `${t(r.run.total)}| ${t(r.stand.total)}| ${r.run.uploadKB.mean.toFixed(1)}/${r.run.uploadKB.max.toFixed(1)}`);
}
for (const interiors of ["cells", "none"]) {
  for (const c of configs) {
    const cpu = results.find((r) => r.interiors === interiors && r.config === c.name && r.mode === "cpu");
    const gpu = results.find((r) => r.interiors === interiors && r.config === c.name && r.mode === "gpu");
    if (!cpu || !gpu) continue;
    console.log(`  ${interiors}/${c.name}: running, GPU total mean ${f3(gpu.run.total.mean)} vs CPU ${f3(cpu.run.total.mean)} ms `
      + `(${(cpu.run.total.mean / Math.max(gpu.run.total.mean, 1e-6)).toFixed(1)}x less), p95 ${f3(gpu.run.total.p95)} vs ${f3(cpu.run.total.p95)}; `
      + `standing ${f3(gpu.stand.total.mean)} vs ${f3(cpu.stand.total.mean)}`);
  }
}

if (gcObserver) gcObserver.disconnect();
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    meta: {
      date: "2026-10-23", node: process.version, three: THREE.REVISION, fps: FPS, speedMps: SPEED_MPS,
      warmup: WARMUP, runFrames: RUN_FRAMES, standFrames: STAND, landblocks: LBDATA.size, envCells: cellRecords,
    },
    results,
  }, null, 1));
  console.log(`\n  results written to ${JSON_OUT}`);
}
const bad = results.filter((r) => !r.sane);
console.log(`\ngrass CPU vs GPU bench: ${results.length} runs, ${bad.length} measured nothing`);
process.exit(bad.length ? 1 : 0);
