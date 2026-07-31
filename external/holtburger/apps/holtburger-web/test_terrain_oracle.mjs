// Terrain-VFX Wave 0A — `scene3d/terrain_oracle.js` unit test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
//   node test_terrain_oracle.mjs
//
// Locks (design plan `docs/2026-07-31-terrain-vfx-plan.md` §2.1, §2.5, §8.1):
//  - COLUMN-MAJOR indexing `codes[col*9 + row]`, matching
//    `ambient_runtime._sampleTerrainVertex` and the baker's `vertex_indices`;
//  - nearest-vertex snap + [0,8] clamping at landblock edges;
//  - `sample()` -> null for an unknown LB, a codeless mesh, and off-world x/y;
//  - PARK SURVIVAL: an LB noted at bake keeps resolving after its mesh leaves
//    the fake `terrainGroup` (which is exactly what `landblock_lru.park()`
//    does, without firing the evict callback). `invalidate()` — and ONLY
//    `invalidate()` — drops it;
//  - `cellSwToNeCut` parity with the Rust vectors at
//    `crates/holtburger-dat/src/terrain_subdiv.rs::cell_split_rule_matches_retail_prng`,
//    plus synthetic coords where a naive double port flips the ANSWER
//    (proves the `Math.imul` / `>>> 0` u32 wrap);
//  - height is exact at the 81 control vertices and CONTINUOUS across a cell
//    boundary (|dz| < 1e-4 either side of x = 24) even where the two cells
//    pick opposite diagonals;
//  - the surface normal is the exact TRIANGLE face normal, not a bilinear
//    smear (matches `WorldState::terrain_normal_at`);
//  - `cornerCodes` gives the four cell corners for boundary feathering;
//  - `terrain.js` still stashes `heights` in the lbMesh userData literal
//    (the Wave 0A one-line edit the whole oracle stands on).
//
// Pure ESM — no three stub needed (`terrain_oracle.js` imports only
// `landblock_lru.js` + `terrain_families.js`, both import-free leaves).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import {
  createTerrainOracle, cellSwToNeCut,
  triangleHeightInCell, triangleGradInCell,
  VERTEX_GRID, VERTEX_SPACING_M, METERS_PER_LANDBLOCK,
} from "./scene3d/terrain_oracle.js";
import {
  FAM_GRASS, FAM_WATER, FAM_ROCK, FAM_SAND, FAM_COUNT,
} from "./scene3d/terrain_families.js";
import { lbKeyFromXY } from "./scene3d/landblock_lru.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// Holtburg: lbX = 0xA9, lbY = 0xB4 -> global cell origin (1352, 1440).
const LBX = 0xa9, LBY = 0xb4;
const LBKEY = lbKeyFromXY(LBX, LBY);
const OX = LBX * METERS_PER_LANDBLOCK;
const OY = LBY * METERS_PER_LANDBLOCK;

// Deterministic pseudo-heights — no Math.random (plan §5.5).
function hash01(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function makeHeights(seed = 0) {
  const h = new Float32Array(81);
  for (let i = 0; i < 81; i += 1) h[i] = Math.fround(hash01(i + seed * 811) * 40 - 5);
  return h;
}
function makeCodes(fill = 1) {
  return new Uint8Array(81).fill(fill);
}
function fakeMesh(lbX, lbY, codes, heights) {
  return {
    name: `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`,
    userData: {
      lbX, lbY,
      lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
      terrainCodes: codes,
      heights,
    },
  };
}

// ---- cellSwToNeCut ---------------------------------------------------
console.log("terrain_oracle — cellSwToNeCut (retail per-cell diagonal PRNG)");
// Verbatim from terrain_subdiv.rs `cell_split_rule_matches_retail_prng`.
const RUST_VECTORS = [
  [1352, 1440, true], [1352, 1441, true], [1352, 1442, true],
  [1353, 1440, false], [1353, 1441, false], [1353, 1442, true],
  [1354, 1440, false], [1354, 1441, false], [1354, 1442, false],
];
let rustOk = true;
for (const [gx, gy, want] of RUST_VECTORS) {
  if (cellSwToNeCut(gx, gy) !== want) { rustOk = false; break; }
}
check("matches all 9 Rust reference vectors (Holtburg SW cells)", rustOk);
check("cell (0,0) of 0xA9B4 stays SW<->NE (legacy fixed-diagonal guard)",
  cellSwToNeCut(0xa9 * 8, 0xb4 * 8) === true);

// A naive f64 port (no Math.imul, no per-step wrap) returns the WRONG BOOLEAN
// on these. Values checked against exact modular arithmetic.
const IMUL_VECTORS = [
  [3262378, 3462562, false], // naive f64 -> true
  [3692099, 3821186, true],  // naive f64 -> false
  [2959406, 3730572, false],
  [1962430, 3711880, false],
];
let imulOk = true;
for (const [gx, gy, want] of IMUL_VECTORS) {
  if (cellSwToNeCut(gx, gy) !== want) { imulOk = false; break; }
}
check("u32 wrap is real — large coords where a naive double port flips", imulOk);
// And prove the naive port really would have differed, so this test can't rot
// into a tautology if someone "simplifies" the implementation.
function naiveCut(gx, gy) {
  const inner = 214614067 * gx + 1813693831;
  const v8 = gy * inner - 1109124029 * gx - 1369149221;
  return (v8 >>> 0) * 2.3283064e-10 >= 0.5;
}
check("the naive double port genuinely disagrees on those coords",
  IMUL_VECTORS.some(([gx, gy, want]) => naiveCut(gx, gy) !== want));
check("source uses Math.imul (not plain `*`) for the PRNG",
  /Math\.imul\(214614067/.test(
    readFileSync(resolvePath(__dirname, "scene3d/terrain_oracle.js"), "utf8"),
  ));

// ---- triangle interpolation primitives ------------------------------
console.log("terrain_oracle — triangleHeightInCell / triangleGradInCell");
{
  const z00 = 1, z10 = 4, z01 = -2, z11 = 7;
  for (const cut of [true, false]) {
    check(`cut=${cut}: exact at SW`, triangleHeightInCell(z00, z10, z01, z11, 0, 0, cut) === z00);
    check(`cut=${cut}: exact at SE`, triangleHeightInCell(z00, z10, z01, z11, 1, 0, cut) === z10);
    check(`cut=${cut}: exact at NW`, triangleHeightInCell(z00, z10, z01, z11, 0, 1, cut) === z01);
    check(`cut=${cut}: exact at NE`, triangleHeightInCell(z00, z10, z01, z11, 1, 1, cut) === z11);
  }
  // Continuous across the chosen diagonal: both triangle planes meet on it.
  const eps = 1e-7;
  let dmax = 0;
  for (let t = 0.05; t < 1; t += 0.05) {
    // SW<->NE diagonal: fx == fy.
    const a = triangleHeightInCell(z00, z10, z01, z11, t + eps, t - eps, true);
    const b = triangleHeightInCell(z00, z10, z01, z11, t - eps, t + eps, true);
    dmax = Math.max(dmax, Math.abs(a - b));
    // NW<->SE diagonal: fx + fy == 1.
    const c = triangleHeightInCell(z00, z10, z01, z11, t + eps, 1 - t + eps, false);
    const d = triangleHeightInCell(z00, z10, z01, z11, t - eps, 1 - t - eps, false);
    dmax = Math.max(dmax, Math.abs(c - d));
  }
  check("both diagonals are C0 across the split", dmax < 1e-5, `max dz ${dmax}`);
  // Gradient is the analytic derivative of the height field it partners.
  let gradOk = true;
  for (const cut of [true, false]) {
    for (const [fx, fy] of [[0.2, 0.1], [0.1, 0.7], [0.8, 0.9], [0.6, 0.2]]) {
      const [gx, gy] = triangleGradInCell(z00, z10, z01, z11, fx, fy, cut);
      const h = 1e-5;
      const dx = (triangleHeightInCell(z00, z10, z01, z11, fx + h, fy, cut)
        - triangleHeightInCell(z00, z10, z01, z11, fx - h, fy, cut)) / (2 * h);
      const dy = (triangleHeightInCell(z00, z10, z01, z11, fx, fy + h, cut)
        - triangleHeightInCell(z00, z10, z01, z11, fx, fy - h, cut)) / (2 * h);
      if (Math.abs(dx - gx) > 1e-3 || Math.abs(dy - gy) > 1e-3) gradOk = false;
    }
  }
  check("triangleGradInCell is the exact partner gradient", gradOk);
}

// ---- column-major code lookup ---------------------------------------
console.log("terrain_oracle — column-major code lookup + nearest-vertex snap");
{
  const codes = makeCodes(1);          // Grassland everywhere
  codes[3 * VERTEX_GRID + 5] = 10;     // sand-yellow at (col 3, row 5)
  codes[8 * VERTEX_GRID + 8] = 15;     // Snow at the NE corner vertex
  codes[0] = 6;                        // ObsidianPlain at the SW corner
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes, heights: makeHeights(1), lbX: LBX, lbY: LBY });

  const s = oracle.sample(OX + 3 * VERTEX_SPACING_M, OY + 5 * VERTEX_SPACING_M);
  check("codes[3*9+5] returns at (lbX*192 + 3*24, lbY*192 + 5*24)",
    s !== null && s.code === 10, s ? `code ${s.code}` : "null");
  check("family follows the code", s && s.family === FAM_SAND);
  check("the transposed point does NOT return it (row-major would)",
    oracle.sampleCode(OX + 5 * VERTEX_SPACING_M, OY + 3 * VERTEX_SPACING_M) === 1);
  check("lbX/lbY/lbKey reported", s.lbX === LBX && s.lbY === LBY && s.lbKey === LBKEY);

  // Nearest-vertex snap: anything within 12 m of the vertex snaps to it.
  check("snap: +11.9 m east still reads the sand vertex",
    oracle.sampleCode(OX + 3 * VERTEX_SPACING_M + 11.9, OY + 5 * VERTEX_SPACING_M) === 10);
  check("snap: +12.1 m east crosses to the next vertex",
    oracle.sampleCode(OX + 3 * VERTEX_SPACING_M + 12.1, OY + 5 * VERTEX_SPACING_M) === 1);

  // Edge clamping. The 9x9 grid covers [0, 192] INCLUSIVE, but world
  // x = lbX*192 + 192 already belongs to the NEXT landblock (both here and in
  // `WorldState::terrain_height_at`), so column 8 is only reachable from
  // inside this LB — the clamp must hold there and never index 9.
  check("edge: the far NE of the LB resolves to vertex (8,8)",
    oracle.sampleCode(OX + 191.999, OY + 191.999) === 15);
  check("edge: the SW origin resolves to vertex (0,0)",
    oracle.sampleCode(OX, OY) === 6);
  check("the LB's east edge belongs to the NEXT landblock, not this one",
    oracle.sampleCode(OX + 192, OY + 96) === -1);
}

// ---- misses ----------------------------------------------------------
console.log("terrain_oracle — misses");
{
  const oracle = createTerrainOracle();
  check("unknown LB -> null", oracle.sample(OX + 10, OY + 10) === null);
  check("unknown LB -> sampleCode -1", oracle.sampleCode(OX + 10, OY + 10) === -1);
  check("NaN -> null", oracle.sample(NaN, 0) === null);
  check("negative world coords -> null (never wraps onto LB 255)",
    oracle.sample(-1, -1) === null);
  check("beyond the 256x256 world -> null",
    oracle.sample(256 * METERS_PER_LANDBLOCK + 1, 0) === null);

  // A mesh present but carrying no terrainCodes must not be adopted.
  const bad = fakeMesh(LBX, LBY, null, makeHeights(2));
  const o2 = createTerrainOracle({ getTerrainMeshes: () => [bad] });
  check("mesh with no terrainCodes -> null", o2.sample(OX + 10, OY + 10) === null);
  check("noteLandblock with short codes is rejected",
    o2.noteLandblock(LBKEY, { codes: new Uint8Array(9) }) === false);
}

// ---- backfill from the mesh scan ------------------------------------
console.log("terrain_oracle — getTerrainMeshes backfill (scan once, then never)");
{
  let scans = 0;
  const mesh = fakeMesh(LBX, LBY, makeCodes(3), makeHeights(3));
  const oracle = createTerrainOracle({
    getTerrainMeshes: () => { scans += 1; return [mesh]; },
  });
  check("first sample adopts the pre-existing mesh", oracle.sampleCode(OX + 50, OY + 50) === 3);
  const afterFirst = scans;
  for (let i = 0; i < 50; i += 1) oracle.sampleCode(OX + i, OY + i);
  check("subsequent samples never rescan", scans === afterFirst, `scans ${scans}`);
  check("stats().backfills === 1", oracle.stats().backfills === 1);

  // A permanently absent LB must not scan once per sample either.
  const before = scans;
  for (let i = 0; i < 100; i += 1) oracle.sampleCode(OX + 5000 + i, OY + 50);
  check("a missing LB is rescanned at most once per note epoch",
    scans - before <= 1, `scans ${scans - before}`);
}

// ---- PARK SURVIVAL ---------------------------------------------------
console.log("terrain_oracle — park survival (the reason this module exists)");
{
  // A fake `terrainGroup.children` the park step can splice out of.
  const children = [fakeMesh(LBX, LBY, makeCodes(9), makeHeights(4))];
  const oracle = createTerrainOracle({ getTerrainMeshes: () => children });
  oracle.noteLandblock(LBKEY, {
    codes: children[0].userData.terrainCodes,
    heights: children[0].userData.heights,
    lbX: LBX, lbY: LBY,
  });
  const before = oracle.sample(OX + 100, OY + 100);
  check("attached: sample resolves", before !== null && before.code === 9);

  // `landblock_lru.park()` REMOVES the mesh from terrainGroup and does NOT
  // fire `_onEvictLandblock`. Simulate exactly that.
  children.length = 0;
  const after = oracle.sample(OX + 100, OY + 100);
  check("PARKED: sample STILL resolves (a scene-graph scanner would return null)",
    after !== null && after.code === 9);
  check("parked height is unchanged",
    after !== null && before !== null && after.height === before.height);
  check("hasLandblock() still true while parked", oracle.hasLandblock(LBKEY) === true);

  // Unpark re-adds the same mesh — nothing to do, and no re-scatter.
  children.push(fakeMesh(LBX, LBY, makeCodes(9), makeHeights(4)));
  check("unpark changes nothing", oracle.sample(OX + 100, OY + 100).code === 9);

  // Only invalidate() drops it. Detach first so the backfill can't re-adopt.
  children.length = 0;
  check("invalidate() returns true for a cached LB", oracle.invalidate(LBKEY) === true);
  check("after invalidate: sample -> null", oracle.sample(OX + 100, OY + 100) === null);
  check("after invalidate: hasLandblock false", oracle.hasLandblock(LBKEY) === false);

  // The `| 0xffff` userData.lbId form must mask to the same residency key.
  const lbId = ((LBX << 24) | (LBY << 16) | 0xffff) >>> 0;
  oracle.noteLandblock(lbId, { codes: makeCodes(9), heights: makeHeights(4) });
  check("noteLandblock accepts the `| 0xffff` lbId form",
    oracle.hasLandblock(LBKEY) === true && oracle.sampleCode(OX + 100, OY + 100) === 9);
  check("lbX/lbY derived from the key when omitted",
    oracle.sample(OX + 100, OY + 100).lbX === LBX);
}

// ---- parkedHits accounting -------------------------------------------
console.log("terrain_oracle — stats()");
{
  const children = [fakeMesh(LBX, LBY, makeCodes(1), makeHeights(5))];
  const oracle = createTerrainOracle({
    getTerrainMeshes: () => children,
    parkRescanEveryHits: 1, // rescan every hit so the test is deterministic
  });
  oracle.noteLandblock(LBKEY, { codes: makeCodes(1), heights: makeHeights(5) });
  oracle.sampleCode(OX + 1, OY + 1);
  check("attached hit is not a parkedHit", oracle.stats().parkedHits === 0);
  children.length = 0;
  oracle.sampleCode(OX + 1, OY + 1);
  oracle.sampleCode(OX + 2, OY + 2);
  const st = oracle.stats();
  check("parked hits are counted", st.parkedHits === 2, JSON.stringify(st));
  check("cached / hits / misses reported",
    st.cached === 1 && st.hits === 3 && st.misses === 0, JSON.stringify(st));
  oracle.sampleCode(OX + 100000, OY);
  check("a miss is counted", oracle.stats().misses === 1);
  oracle.clear();
  check("clear() empties the cache", oracle.stats().cached === 0);
}

// ---- height fidelity --------------------------------------------------
console.log("terrain_oracle — height: exact at vertices, continuous across cells");
{
  const heights = makeHeights(7);
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes: makeCodes(1), heights, lbX: LBX, lbY: LBY });

  // Columns/rows 0..7 are addressable from inside this LB; column/row 8 sits
  // exactly on the LB's far edge, which floor(x/192) assigns to the NEXT
  // landblock (same rule as the wasm `terrain_height_at`), so it is approached
  // from just inside instead.
  let vmax = 0;
  for (let col = 0; col < 8; col += 1) {
    for (let row = 0; row < 8; row += 1) {
      const z = oracle.heightAt(
        OX + col * VERTEX_SPACING_M, OY + row * VERTEX_SPACING_M,
      );
      vmax = Math.max(vmax, Math.abs(z - heights[col * 9 + row]));
    }
  }
  check("exact at the 64 interior-addressable control vertices",
    vmax < 1e-5, `max err ${vmax}`);
  let emax = 0;
  for (let row = 0; row < 8; row += 1) {
    emax = Math.max(emax, Math.abs(
      oracle.heightAt(OX + 192 - 1e-4, OY + row * VERTEX_SPACING_M) - heights[8 * 9 + row],
    ));
    emax = Math.max(emax, Math.abs(
      oracle.heightAt(OX + row * VERTEX_SPACING_M, OY + 192 - 1e-4) - heights[row * 9 + 8],
    ));
  }
  check("converges to the column-8 / row-8 edge vertices from inside",
    emax < 1e-3, `max err ${emax}`);

  // §2.5: |dz| < 1e-4 either side of x = 24, i.e. across a cell boundary
  // whose two cells may pick OPPOSITE diagonals.
  const eps = 1e-6;
  let cmax = 0, sawSplitChange = false;
  for (let cx = 1; cx <= 7; cx += 1) {
    const xb = OX + cx * VERTEX_SPACING_M;
    for (let ty = 0.05; ty < 1; ty += 0.1) {
      const y = OY + (3 + ty) * VERTEX_SPACING_M;
      const a = oracle.heightAt(xb - eps, y);
      const b = oracle.heightAt(xb + eps, y);
      cmax = Math.max(cmax, Math.abs(a - b));
    }
    const cyc = 3;
    if (cellSwToNeCut(LBX * 8 + cx - 1, LBY * 8 + cyc)
      !== cellSwToNeCut(LBX * 8 + cx, LBY * 8 + cyc)) sawSplitChange = true;
  }
  check("C0 across every east-west cell boundary (|dz| < 1e-4)",
    cmax < 1e-4, `max dz ${cmax}`);
  check("the sweep really did cross a diagonal-flip boundary", sawSplitChange);

  let nmax = 0;
  for (let cy = 1; cy <= 7; cy += 1) {
    const yb = OY + cy * VERTEX_SPACING_M;
    for (let tx = 0.05; tx < 1; tx += 0.1) {
      const x = OX + (5 + tx) * VERTEX_SPACING_M;
      nmax = Math.max(nmax, Math.abs(oracle.heightAt(x, yb - eps) - oracle.heightAt(x, yb + eps)));
    }
  }
  check("C0 across every north-south cell boundary", nmax < 1e-4, `max dz ${nmax}`);

  // Height stays inside the corner bracket of its own cell (no overshoot).
  let bracketOk = true;
  for (let i = 0; i < 400; i += 1) {
    const x = OX + hash01(i) * 192, y = OY + hash01(i + 7777) * 192;
    const s = oracle.sample(x, y);
    const cx0 = Math.min(Math.floor((x - OX) / 24), 7);
    const cy0 = Math.min(Math.floor((y - OY) / 24), 7);
    const zs = [
      heights[cx0 * 9 + cy0], heights[(cx0 + 1) * 9 + cy0],
      heights[cx0 * 9 + cy0 + 1], heights[(cx0 + 1) * 9 + cy0 + 1],
    ];
    if (s.height < Math.min(...zs) - 1e-4 || s.height > Math.max(...zs) + 1e-4) bracketOk = false;
  }
  check("interpolated height never leaves its cell's corner bracket", bracketOk);
}

// ---- normals ----------------------------------------------------------
console.log("terrain_oracle — surface normal");
{
  // Constant east-west 45-degree ramp: 24 m rise per 24 m cell.
  const ramp = new Float32Array(81);
  for (let vx = 0; vx < 9; vx += 1) {
    for (let vy = 0; vy < 9; vy += 1) ramp[vx * 9 + vy] = vx * VERTEX_SPACING_M;
  }
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes: makeCodes(1), heights: ramp, lbX: LBX, lbY: LBY });
  const inv = 1 / Math.SQRT2;
  let ok = true;
  for (let i = 0; i < 60; i += 1) {
    const n = oracle.sample(OX + hash01(i) * 190 + 1, OY + hash01(i + 31) * 190 + 1).normal;
    if (Math.abs(n.x + inv) > 1e-4 || Math.abs(n.y) > 1e-4 || Math.abs(n.z - inv) > 1e-4) ok = false;
  }
  check("45-degree east ramp -> normal (-1,0,1)/sqrt(2) everywhere", ok);

  const flat = new Float32Array(81).fill(12.5);
  oracle.invalidate(LBKEY);
  oracle.noteLandblock(LBKEY, { codes: makeCodes(1), heights: flat, lbX: LBX, lbY: LBY });
  const nf = oracle.sample(OX + 77, OY + 33).normal;
  check("flat LB -> +Z normal, unit length",
    Math.abs(nf.x) < 1e-6 && Math.abs(nf.y) < 1e-6 && Math.abs(nf.z - 1) < 1e-6);
  check("flat LB -> exact height", Math.abs(oracle.heightAt(OX + 77, OY + 33) - 12.5) < 1e-6);
}

// ---- missing heights degrade, don't lie -------------------------------
console.log("terrain_oracle — a mesh baked before the Wave 0A heights line");
{
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes: makeCodes(1), lbX: LBX, lbY: LBY });
  const s = oracle.sample(OX + 33, OY + 44);
  check("code still resolves without heights", s !== null && s.code === 1);
  check("hasHeight === false, height === null, normal === null",
    s.hasHeight === false && s.height === null && s.normal === null);
  check("heightAt() -> null rather than a guess", oracle.heightAt(OX + 33, OY + 44) === null);
}

// ---- cornerCodes ------------------------------------------------------
console.log("terrain_oracle — cornerCodes (boundary feathering, §8 risk 2)");
{
  const codes = makeCodes(1);
  // Cell (2,3): SW=(2,3) SE=(3,3) NW=(2,4) NE=(3,4).
  codes[2 * 9 + 3] = 1;   // Grassland
  codes[3 * 9 + 3] = 18;  // WaterShallowSea
  codes[2 * 9 + 4] = 0;   // BarrenRock
  codes[3 * 9 + 4] = 10;  // sand-yellow
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes, heights: makeHeights(9), lbX: LBX, lbY: LBY });
  const s = oracle.sample(OX + 2.5 * 24, OY + 3.5 * 24);
  check("cornerCodes is [sw, se, nw, ne]",
    s.cornerCodes[0] === 1 && s.cornerCodes[1] === 18
    && s.cornerCodes[2] === 0 && s.cornerCodes[3] === 10,
    Array.from(s.cornerCodes).join(","));
  check("a shoreline cell is detectable from cornerCodes alone",
    Array.from(s.cornerCodes).some((c) => c >= 16 && c <= 20));

  // Reusable `out` object keeps the hot path allocation-free.
  const out = {};
  const r1 = oracle.sample(OX + 10, OY + 10, out);
  const cc = r1.cornerCodes;
  const r2 = oracle.sample(OX + 20, OY + 20, out);
  check("sample(x, y, out) reuses the caller's object", r1 === out && r2 === out);
  check("sample(x, y, out) reuses the cornerCodes buffer", r2.cornerCodes === cc);
}

// ---- familyCoverage ---------------------------------------------------
console.log("terrain_oracle — familyCoverage");
{
  const codes = makeCodes(1);          // 81 grass
  for (let i = 0; i < 20; i += 1) codes[i] = 18;  // -> water
  for (let i = 20; i < 25; i += 1) codes[i] = 0;  // -> rock
  const oracle = createTerrainOracle();
  oracle.noteLandblock(LBKEY, { codes, heights: makeHeights(11), lbX: LBX, lbY: LBY });
  const cov = oracle.familyCoverage(LBKEY);
  check("Uint16Array(FAM_COUNT)", cov instanceof Uint16Array && cov.length === FAM_COUNT);
  check("counts sum to 81", cov.reduce((a, b) => a + b, 0) === 81);
  check("water 20 / rock 5 / grass 56",
    cov[FAM_WATER] === 20 && cov[FAM_ROCK] === 5 && cov[FAM_GRASS] === 56,
    Array.from(cov).join(","));
  check("memoised (same object on the second call)",
    oracle.familyCoverage(LBKEY) === cov);
  check("unknown LB -> null", oracle.familyCoverage(lbKeyFromXY(1, 2)) === null);
  oracle.invalidate(LBKEY);
  check("invalidate drops the memo", oracle.familyCoverage(LBKEY) === null);
}

// ---- the terrain.js one-line contract ---------------------------------
console.log("terrain_oracle — terrain.js userData contract");
{
  const src = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
  const lit = src.slice(src.indexOf("lbMesh.userData = {"));
  const body = lit.slice(0, lit.indexOf("\n  };"));
  check("terrain.js stashes `terrainCodes` on lbMesh.userData",
    /terrainCodes:\s*terrainCodesCopy/.test(body));
  check("terrain.js stashes `heights` on lbMesh.userData (the Wave 0A line)",
    /heights:\s*Float32Array\.from\(wasmMesh\.heights\)/.test(body),
    "add `heights: Float32Array.from(wasmMesh.heights),` to the userData literal");
  check("terrain.js still stashes lbX/lbY the oracle keys off",
    /^\s*lbX,\s*$/m.test(body) && /^\s*lbY,\s*$/m.test(body));
}

// ---- constants --------------------------------------------------------
check("VERTEX_GRID/SPACING/LB constants match ambient_runtime",
  VERTEX_GRID === 9 && VERTEX_SPACING_M === 24 && METERS_PER_LANDBLOCK === 192);

console.log(`\nterrain_oracle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
