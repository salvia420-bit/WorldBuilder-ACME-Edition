// harness/glsl_smoke/grass_gpu_smoke.mjs — the browser smoke for
// `?terrainGrassGpu` (2026-10-23; design contract
// docs/2026-10-23-grass-gpu-placement.md, Validation) in a real WebGL2 stack:
// local headless Chromium (ANGLE / SwiftShader), three r184 from node_modules,
// the REAL scene3d modules, and REAL data read here from client_cell_1.dat and
// client_portal.dat for two REGIONS, each 5x5 landblocks of terrain + the
// EnvCells of the 3x3 around its centre (as cells.js loads them): Holtburg
// (0xA9B4) and the dense housing block 0x4993 (the world's fullest 12 m bucket
// of building cells, 43). Both go into ONE oracle and ONE cell map, the app's
// situation of far cells staying loaded, served to the page as JSON at
// http://smoke.test/data/lbs.json. NOT part of the node gate (it launches a
// browser — one heavy job at a time, run it under `capped-build`):
//
//   capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs
//   capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs --png /tmp/claude-1000/grass_gpu_frames
//       (also writes cpu.png / gpu.png / diff.png of the frame compare there)
//   capped-build node harness/glsl_smoke/grass_gpu_smoke.mjs --data-only <file.json>
//       (no browser: reads the DATs, writes the page's data JSON, prints the
//       GLSL fingerprint; capped-build because a hook matches this filename)
//   HB_CELL_DAT / HB_PORTAL_DAT override ~/ac_base_dats/client_{cell_1,portal}.dat
//
// The page (grass_gpu_page.html) builds a real terrain oracle and, per spot, a
// real GPU interior mask CENTRED on the spot (setGpuCenter before sync, like
// the provider) and runs three checks in ONE page (one WebGL context at a time,
// each disposed before the next):
//
//  1. READBACK — the module GLSL (GRASS_GPU_HASH_GLSL + TERRAIN_FIELD_GLSL +
//     INTERIOR_MASK_GLSL + buildGrassPlaceGlsl()) compiled into a GLSL3
//     ShaderMaterial that calls hbGrassPlace(id) per pixel of a W x H RGBA32F
//     4-target MRT (id from gl_FragCoord), read back with
//     readRenderTargetPixels(..., textureIndex) and compared, per ring with all
//     64 tiles, against the CPU provider's pools built in the same page from the
//     same oracle, matched by world cell (the spec's tolerances, positions plus
//     the f32 quantum of the stored value — see the page header). The SAME GLSL
//     is also run in the VERTEX stage (hbGrassPlace(gl_InstanceID) on instanced
//     points, flat varyings into the same MRT): that is where it runs in
//     production. Two configs (20000 blades / 24 m / reach 5 = 4 rings, and a
//     10000-blade single field) at three spots (Holtburg centre, with its real
//     building interiors; the owner's road screenshot spot; the 0x4993 housing,
//     where buckets hold more than 16 ids, so the loop's texels 5..12 run).
//     The f32 JS mirror (grassGpuPlaceMirror) is compared too, for diagnosis.
//  2. INTERIOR ARM (the two town spots) — the same readback once more with
//     uHbIndoorOn forced to 0; the per-cell set of blades the mask flips from
//     live to dead on the GPU must equal the f32 mirror's flip set
//     (gpuContainsMirror on vs no mask) within the interior budget, and be
//     non-empty; flips the other way and any other field change are errors.
//     At 0x4993 some flips must come from a bucket id past the first 16.
//  3. FRAME COMPARE — the real provider with gpu:false and with gpu:true (the
//     GPU arm draws through the view early-out and the dead-blade branch), a
//     fresh renderer + scene each, same camera above the player looking
//     down-forward, time frozen at 0, wind and bow zeroed through the shared
//     uniforms (they read vVfxHash, which hashes the f32 origin — see the page
//     header), into a 256x256 target; px count, max channel diff, fraction
//     differing. An info-only pair with the default bow quantifies that hash
//     sensitivity.
//
// PASS = every program links, zero console errors / page errors / 404s / GL
// errors, every readback within tolerance — per ring, mismatches + field
// outliers <= max(5, 0.5 % of the ring's CPU live blades); summed over the
// rings <= max(8, 0.2 % of the CPU live blades); every window cell mapped
// exactly once, every pixel written (the page's RING_* / AGG_* constants and
// their justification) — every interior arm within max(3, 1 % of the mirror's
// kills), the 4 ring config killing blades at both town spots and some kills
// needing ids past 16 at 0x4993, every spot's mask
// centred with nothing dropped (no fold, no cap) and 0x4993's fullest bucket
// over 16, the GPU arm really in "gpu" mode with one shared grass program, both
// frames show grass, fewer than 1 % of the pixels differ by more than 8 levels
// and fewer than 0.2 % once 1-px edge jitter is forgiven. Prints a JSON
// summary, the GLSL fingerprint, then PASS / FAIL; the exit code follows.
//
// THE STAMP (2026-10-23, review tests-1). On PASS the run writes
// grass_gpu_smoke.stamp.json next to this file: { fingerprint (sha256 of the
// shipped GLSL, grass_gpu_fingerprint.mjs), parts, passedAt, renderer, rates }.
// test_terrain_grass_gpu.mjs (node gate) fails while the current GLSL's
// fingerprint differs from the stamp's, so a GLSL edit cannot ship without
// this smoke passing on it. A FAIL never touches the stamp.
//
// The frame check's 1 % has to absorb real f32 edge jitter: ~60-70 % of GPU
// origins differ from the CPU's stored f32 by one ULP (3.9 mm at 35 km), which
// moves blade edges by ~0.1-0.2 px at 5-10 m; the estimate for this camera is
// ~0.5 % of pixels. `fracOver8Tolerant` (a differing pixel is forgiven when each
// frame holds a match within 1 px) separates that jitter from missing or extra
// blades — read it before blaming the shader for a strict-metric miss.
//
// RESULTS. 2026-10-23, SwiftShader (Subzero), BEFORE the review fixes (two
// spots, uncentred mask, no interior arm): PASS. Readback live-set mismatch +
// outliers 0.024 % / 0.046 % of the CPU live blades (4 rings, Holtburg / road;
// worst ring 2 of 3093) and 0.027 % / 0.045 % (single field, worst 3 of 6730),
// identical in both stages; frame 0.18 % of pixels over 8 levels, 0.05 %
// with the 1-px tolerance. The gates above were set from that run (aggregate
// 0.2 % = 4x its worst 0.046 %; the floors from its worst ring counts plus the
// f32 mirror's estimate at 0x4993, where 3175 live blades meet many walls: 3
// mirror flips, at most 2 more wall ties). The fixed tree (centred mask, split
// placement with the view early-out, dead blades skip the look, 0x4993,
// interior arm, per-ring gates) was dry-run in node against an emulated
// renderer whose readback is the f32 mirror: all 12 readbacks and 8 interior
// arms pass (0x4993: 2517 / 1829 mask kills, 181 / 156 of them past id 16);
// a 1.5-2 % flip confined to any one ring, a mask reading only the first 16 /
// 12 / 8 / 4 ids of a bucket, and the old all-ring 2 % flip each FAIL. It has
// NOT yet run in a browser — the stamp records the first real PASS.
import { createRequire } from "node:module";
import { existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// The GLSL fingerprint lock (see THE STAMP above); node-only, no browser.
import { grassGpuGlslFingerprint, GRASS_GPU_STAMP_PATH } from "./grass_gpu_fingerprint.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

const CELL = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
const PORTAL = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
// Each region: 5x5 landblocks of terrain + the 3x3 of interiors around `center`.
const REGIONS = [
  { name: "Holtburg", center: [0xa9, 0xb4] },
  // 2026-10-23 (review tests-2): dense housing, fullest 12 m bucket 43 ids.
  { name: "dense housing 0x4993", center: [0x49, 0x93] },
];
const LB_RADIUS = 2;             // 5x5 landblocks of terrain
const CELL_RADIUS = 1;           // cells.js ENVCELL_RING_RADIUS: the 3x3 of interiors
const pngIdx = process.argv.indexOf("--png");
const PNG_DIR = pngIdx > 0 ? process.argv[pngIdx + 1] : null;

// ---------------------------------------------------------------------------
// DAT reader — the directory B-tree walk of test_terrain_grass_offroad.mjs.
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
  const codes = [], roads = [], heights = [];
  for (let v = 0; v < 81; v += 1) {
    const w = b.readUInt16LE(8 + 2 * v);
    roads.push(w & 0x3);              // the wasm `roadCodes` (raw 2-bit field)
    codes.push((w >> 2) & 0x1f);      // the wasm `terrainCodes`
    heights.push(b[8 + 162 + v] * 2); // retail LandHeightTable == byte*2
  }
  return { lbX, lbY, codes, roads, heights };
}

// ---------------------------------------------------------------------------
// EnvCells — test_grass_interior_mask_gpu.mjs's reader (ACE EnvCell.Unpack up to
// the frame; Environment CellStruct polygons with a retail BSPNODE::UnPack skip).
// Only the structure's extent box is shipped: cellBoxFor() reads nothing but the
// structure meshes' bounding boxes, so a two-point geometry at the extent's
// corners gives the mask the very boxes the full polygon soup would.
// ---------------------------------------------------------------------------
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

function readEnvCell(b) {
  const r = cursor(b);
  const id = r.u32(); r.u32(); r.skip(4);
  const nSurf = r.u8(); r.u8(); r.u16();
  r.skip(2 * nSurf);
  const env = (0x0d000000 | r.u16()) >>> 0;
  const cellStruct = r.u16();
  const origin = [r.f32(), r.f32(), r.f32()];
  const qw = r.f32(), qx = r.f32(), qy = r.f32(), qz = r.f32();
  return { id, env, cellStruct, origin, quat: [qw, qx, qy, qz] };
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
/** Environment (0x0D): CellStruct key -> extent [x0, y0, z0, x1, y1, z1] of its drawing polygons' vertices. */
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
    const ext = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let pts = 0;
    for (const v of used) {
      const p = verts.get(v);
      if (!p) continue;
      pts += 1;
      for (let a = 0; a < 3; a += 1) { ext[a] = Math.min(ext[a], p[a]); ext[3 + a] = Math.max(ext[3 + a], p[a]); }
    }
    if (pts >= 3) out.set(key, ext);
  }
  return { cells: out, consumed: r.pos === b.length };
}

function buildData() {
  if (!existsSync(CELL)) return { error: `missing ${CELL} (set HB_CELL_DAT)` };
  const cellDat = openDat(CELL);
  const portalDat = existsSync(PORTAL) ? openDat(PORTAL) : null;
  const envCache = new Map();
  const lbs = [];
  const cells = [];
  const regions = [];
  let cellsParsed = !!portalDat;
  for (const region of REGIONS) {
    const [cx, cy] = region.center;
    const sum = { name: region.name, center: region.center, lbs: 0, cells: 0 };
    for (let dx = -LB_RADIUS; dx <= LB_RADIUS; dx += 1) {
      for (let dy = -LB_RADIUS; dy <= LB_RADIUS; dy += 1) {
        const lb = readLandblock(cellDat, cx + dx, cy + dy);
        if (lb) { lbs.push(lb); sum.lbs += 1; }
      }
    }
    if (portalDat) {
      for (let dx = -CELL_RADIUS; dx <= CELL_RADIUS; dx += 1) {
        for (let dy = -CELL_RADIUS; dy <= CELL_RADIUS; dy += 1) {
          const lx = cx + dx, ly = cy + dy;
          const info = cellDat.get(((lx << 24) | (ly << 16) | 0xfffe) >>> 0); // LandBlockInfo: u32 id, u32 numCells
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
              cellsParsed = cellsParsed && env.consumed;
              envCache.set(ec.env, env);
            }
            const ext = envCache.get(ec.env).cells.get(ec.cellStruct);
            if (!ext) continue;
            cells.push({ id, lbX: lx, lbY: ly, origin: ec.origin, quat: ec.quat, ext });
            sum.cells += 1;
          }
        }
      }
    }
    regions.push(sum);
  }
  if (portalDat) portalDat.close();
  cellDat.close();
  return { regions, lbs, cells, cellsParsed, cellDat: CELL, portalDat: portalDat ? PORTAL : null };
}

const data = buildData();
if (data.error) {
  console.log(JSON.stringify({ error: data.error }));
  console.log("FAIL");
  process.exit(1);
}
const dataJson = Buffer.from(JSON.stringify(data));
// The fingerprint of the GLSL this run checks (computed before the browser
// starts; the page loads the same module files from disk).
const fp = grassGpuGlslFingerprint();
// `--data-only <file>`: write the page's data JSON and stop (no browser).
const dataOnlyIdx = process.argv.indexOf("--data-only");
if (dataOnlyIdx > 0) {
  writeFileSync(process.argv[dataOnlyIdx + 1], dataJson);
  console.log(JSON.stringify({
    regions: data.regions, lbs: data.lbs.length, cells: data.cells.length, cellsParsed: data.cellsParsed,
    bytes: dataJson.length, fingerprint: fp.fingerprint,
  }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The browser run: one page, everything inside it.
// ---------------------------------------------------------------------------
async function run(search) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const glWarnings = [];
    const missing = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 600)));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 1200));
      // Chromium reports GL errors as console WARNINGS ("[.WebGL-...]GL_INVALID_...").
      else if (/GL_INVALID|WebGL: INVALID/.test(m.text())) glWarnings.push(m.text().slice(0, 400));
    });
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "grass_gpu_page.html"); type = "text/html"; }
      else if (u.pathname === "/data/lbs.json") return route.fulfill({ status: 200, contentType: "application/json", body: dataJson });
      // An empty icon: a 404 here is a console error, and console errors fail the run.
      else if (u.pathname === "/favicon.ico") return route.fulfill({ status: 200, contentType: "image/x-icon", body: "" });
      else if (u.pathname.startsWith("/three-addons/")) file = join(APP, "node_modules/three/examples/jsm", u.pathname.slice(14));
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (!file) { missing.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { missing.push(u.pathname); return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 300000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    r.consoleErrors = consoleErrors;
    r.glWarnings = glWarnings;
    r.missing = missing;
    return r;
  } finally { await browser.close(); }
}

const r = await run(PNG_DIR ? "?png=1" : "");

if (PNG_DIR && r.png) {
  mkdirSync(PNG_DIR, { recursive: true });
  for (const [name, url] of Object.entries(r.png)) {
    if (typeof url === "string" && url.startsWith("data:image/png;base64,")) {
      writeFileSync(join(PNG_DIR, `${name}.png`), Buffer.from(url.slice(22), "base64"));
    }
  }
  r.pngDir = PNG_DIR;
}
delete r.png;

// ---------------------------------------------------------------------------
// Verdict.
// ---------------------------------------------------------------------------
const programs = r.programs || [];
const readback = r.readback || [];
const interior = r.interior || [];
const indoor = r.indoor || [];
const frame = r.frame || {};
const arm = (a) => a || {};
const cpu = arm(frame.cpu), gpu = arm(frame.gpu), diff = frame.diff || {};
const gpuPlacePrograms = (gpu.programs || []).filter((p) => p.gpuPlace);
// The page's grid: 3 spots x 2 configs x 2 stages of readback; the interior arm
// at the 2 town spots x 2 configs x 2 stages. Counted here, not by the page, so
// a page that silently skips a spot fails.
const READBACK_RUNS = 12;
const INTERIOR_RUNS = 8;
const FIRST_CONFIG = (x) => /4 rings/.test(x.config);
const townSpots = indoor.filter((m) => m.town).map((m) => m.spot);
const denseSpots = indoor.filter((m) => m.dense).map((m) => m.spot);
const checks = {
  pageRan: r.done === true && !r.fatal,
  dataLoaded: data.regions.length === REGIONS.length
    && data.regions.every((g) => g.lbs === (2 * LB_RADIUS + 1) ** 2 && g.cells > 0) && data.cellsParsed === true,
  floatTargets: r.floatRT === true,
  programsLinked: programs.length >= 4 && programs.every((p) => p.linked === true),
  noConsoleErrors: (r.errors || []).length === 0 && r.consoleErrors.length === 0,
  noPageErrors: r.pageErrors.length === 0,
  noGlErrors: r.glWarnings.length === 0 && r.readbackGlError === 0 && cpu.glError === 0 && gpu.glError === 0,
  noMissingFiles: r.missing.length === 0,
  // Every spot x config x stage, each within the per ring AND the summed gate.
  readbackRuns: readback.length === READBACK_RUNS,
  readbackAllOk: readback.length > 0 && readback.every((x) => x.ok === true),
  // Every spot's mask centred (setGpuCenter, review lifecycle-1) and holding
  // all of its candidates: rows, buckets, no fold.
  interiorsOnGpu: indoor.length === 3 && indoor.every((m) => m.gpu === true && m.gpuCentered === true && m.gpuBoxes > 0
    && m.gpuBoxes === m.gpuCandidates && m.gpuOverflow === 0 && m.gpuCollisions === 0 && m.gpuBoxOverflow === 0),
  // 0x4993: a bucket of more than 16 ids (bucket texels 5..12 hold ids).
  denseBucket: denseSpots.length === 1 && indoor.some((m) => m.dense && m.gpuMaxPerBucket > 16),
  // 2. INTERIOR ARM: GPU kills = mirror kills within budget, every entry; at
  // both town spots the 4 ring config kills something, and at 0x4993 some of
  // the GPU's kills need a bucket id past the first 16.
  interiorRuns: interior.length === INTERIOR_RUNS,
  interiorAllOk: interior.length > 0 && interior.every((x) => x.ok === true),
  interiorKills: townSpots.length === 2 && townSpots.every((s) => {
    const e = interior.filter((x) => x.spot === s && FIRST_CONFIG(x));
    return e.length === 2 && e.every((x) => x.totals.gpuKills > 0 && x.totals.mirKills > 0);
  }),
  interiorDeepIds: denseSpots.length === 1 && (() => {
    const e = interior.filter((x) => x.spot === denseSpots[0] && FIRST_CONFIG(x));
    return e.length === 2 && e.every((x) => x.totals.deep > 0);
  })(),
  cpuArmCpu: cpu.mode !== "gpu" && cpu.meshes > 0,
  gpuArmGpu: gpu.mode === "gpu" && gpu.meshes > 0 && !gpu.buildError,
  gpuOneProgram: gpuPlacePrograms.length === 1,
  framesShowGrass: cpu.litFrac >= 0.02 && gpu.litFrac >= 0.02,
  framesAgree: Number.isFinite(diff.fracOver8) && diff.fracOver8 < 0.01,
  // 2026-10-23: missing or extra blades (the early-out, the dead branch) once
  // 1-px edge jitter is forgiven; 0.2 % = 4x the first run's 0.05 %.
  framesAgreeTolerant: Number.isFinite(diff.fracOver8Tolerant) && diff.fracOver8Tolerant < 0.002,
};
const ok = Object.values(checks).every(Boolean);

const worstRing = (x) => (x.rings || []).reduce((a, g) => Math.max(a, g.rate || 0), 0);
// THE STAMP: written on PASS only (test_terrain_grass_gpu.mjs reads it).
let stamp = null;
if (ok) {
  stamp = {
    fingerprint: fp.fingerprint,
    fingerprintVersion: fp.version,
    parts: fp.parts,
    passedAt: new Date().toISOString(),
    renderer: r.renderer,
    summary: {
      readback: readback.map((x) => ({
        spot: x.spot, config: x.config, stage: x.stage,
        cpuLive: x.totals.cpuLive, rate: x.totals.rate, worstRingRate: Number(worstRing(x).toFixed(5)),
      })),
      interior: interior.map((x) => ({
        spot: x.spot, config: x.config, stage: x.stage,
        gpuKills: x.totals.gpuKills, mirKills: x.totals.mirKills, killMism: x.totals.killMism, deep: x.totals.deep,
      })),
      indoor: indoor.map((m) => ({ spot: m.spot, gpuBoxes: m.gpuBoxes, gpuMaxPerBucket: m.gpuMaxPerBucket })),
      frame: { fracOver8: diff.fracOver8, fracOver8Tolerant: diff.fracOver8Tolerant, maxDiff: diff.maxDiff },
    },
  };
  writeFileSync(GRASS_GPU_STAMP_PATH, JSON.stringify(stamp, null, 1) + "\n");
}

const brief = {
  renderer: r.renderer,
  floatRT: r.floatRT,
  fingerprint: fp.fingerprint,
  data: { regions: data.regions, lbs: data.lbs.length, cells: data.cells.length, cellsParsed: data.cellsParsed },
  fields: r.fields,
  indoor,
  readback: readback.map((x) => ({
    config: x.config, spot: x.spot, stage: x.stage, ok: x.ok, ms: x.ms,
    totals: x.totals, rings: x.rings,
  })),
  interior: interior.map((x) => ({
    config: x.config, spot: x.spot, stage: x.stage, ok: x.ok, ms: x.ms,
    totals: x.totals, rings: x.rings,
  })),
  frame: {
    camera: frame.camera,
    cpu: cpu.summary, gpu: gpu.summary, diff,
    look: frame.look,
  },
  programs: programs.map((p) => `${p.where}:${p.name}:${p.linked ? "linked" : "NOT LINKED"}`),
  errors: r.errors, consoleErrors: r.consoleErrors, glWarnings: r.glWarnings, readbackGlError: r.readbackGlError,
  warns: (r.warns || []).slice(0, 12), warnCount: (r.warns || []).length,
  pageErrors: r.pageErrors, missing: r.missing, fatal: r.fatal || null, pngDir: r.pngDir || null,
  stamp: stamp ? GRASS_GPU_STAMP_PATH : "not written (FAIL)",
};
// One JSON document, one top-level key (or array element) per line.
const lines = Object.entries(brief).map(([k, v]) => (Array.isArray(v) && v.length
  ? ` ${JSON.stringify(k)}: [\n${v.map((e) => `  ${JSON.stringify(e)}`).join(",\n")}\n ]`
  : ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`));
console.log(`{\n${lines.join(",\n")}\n}`);
console.log("checks:", JSON.stringify(checks));
console.log("fingerprint:", fp.fingerprint);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
