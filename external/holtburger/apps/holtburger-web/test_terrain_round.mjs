// 2026-10-07 — terrain edge rounding (scene3d/terrain_round.js) test:
// the SHADING BEVEL (fragment shader, mirrored in JS) and the CENTIMETRE
// FILLET (bake-time aRoundZ).
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_round.mjs
//
// Locks:
//  1. FLAGS — default-ON; `?terrainRound=off` kills everything, `?terrainBevel=off`
//     only the bevel; clamps; texture width 18 only with the bevel; no LOD
//     floor by default.
//  2. FILLET (synthetic) — planes untouched; retail vertices exactly 0; never
//     outside the retail triangle's [min, max]; bounded by terrainRoundMax.
//  3. REAL DAT (project rule: real data) — landblocks read straight out of
//     ~/ac_base_dats/client_cell_1.dat (B-tree lookup below), subdivided
//     EXACTLY like terrain_subdiv.rs, at the owner's screenshot spot
//     41.1S 54.6W (LB 0x3B4C), Holtburg (0xA9B4) and a mountain block
//     (0xBBC7), each as a 3x3:
//       - retail vertex heights bit-identical (offset exactly 0);
//       - |visual - physics| <= cap; inside the local retail min/max;
//       - seams bit-identical (equal factors) / collinear (x4|x8 LOD);
//       - BEVEL: exact outside the band; continuous across every edge; the
//         Gouraud gradient jump across creases removed inside the band;
//         planes untouched; landblock seams left retail.
//  4. WIRING — terrain.js / terrain_batch.js injection points and anchors.

import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import * as R from "./scene3d/terrain_round.js";
import { cellSwToNeCut, triangleHeightInCell, triangleGradInCell } from "./scene3d/terrain_oracle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const CFG = R.readTerrainRoundConfig("");

// ---------------------------------------------------------------------------
// Helpers. heights/codes are 81-long, `x*9 + y` (CellLandblock order).
// ---------------------------------------------------------------------------
function facetPositions(heights, lbX, lbY, f) {
  const n = 8 * f + 1;
  const pos = new Float32Array(n * n * 3);
  const step = 1 / f;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const u = i * step, v = j * step;
      const cu = Math.min(Math.floor(u), 7), cv = Math.min(Math.floor(v), 7);
      const h = (x, y) => heights[x * 9 + y];
      const idx = (i * n + j) * 3;
      pos[idx] = i * 24 * step; pos[idx + 1] = j * 24 * step;
      pos[idx + 2] = triangleHeightInCell(h(cu, cv), h(cu + 1, cv), h(cu, cv + 1), h(cu + 1, cv + 1),
        u - cu, v - cv, cellSwToNeCut(lbX * 8 + cu, lbY * 8 + cv));
    }
  }
  return pos;
}
function filletLb(lb, f, cfg, neighbours = null) {
  const n = 8 * f + 1;
  const pos = facetPositions(lb.heights, lb.lbX, lb.lbY, f);
  const off = R.computeTerrainRoundOffsets(pos, n, f, lb.lbX, lb.lbY, cfg, neighbours);
  return { n, f, pos, off, zAt: (i, j) => pos[(i * n + j) * 3 + 2], vis: (i, j) => pos[(i * n + j) * 3 + 2] + (off ? off[i * n + j] : 0) };
}
// Port of terrain_subdiv.rs::retail_land_normals (block-local summed UNIT face
// normals, calc_lighting) — the field the Gouraud term interpolates.
function retailNormals(heights, lbX, lbY) {
  const acc = []; for (let i = 0; i < 81; i += 1) acc.push([0, 0, 0]);
  const add = (g, cs) => {
    const nx = -g[0] / 24, ny = -g[1] / 24, m = Math.hypot(nx, ny, 1);
    for (const [x, y] of cs) { const a = acc[x * 9 + y]; a[0] += nx / m; a[1] += ny / m; a[2] += 1 / m; }
  };
  const h = (x, y) => heights[x * 9 + y];
  for (let cu = 0; cu < 8; cu += 1) for (let cv = 0; cv < 8; cv += 1) {
    const z00 = h(cu, cv), z10 = h(cu + 1, cv), z01 = h(cu, cv + 1), z11 = h(cu + 1, cv + 1);
    if (cellSwToNeCut(lbX * 8 + cu, lbY * 8 + cv)) {
      add(triangleGradInCell(z00, z10, z01, z11, 0.75, 0.25, true), [[cu, cv], [cu + 1, cv], [cu + 1, cv + 1]]);
      add(triangleGradInCell(z00, z10, z01, z11, 0.25, 0.75, true), [[cu, cv], [cu + 1, cv + 1], [cu, cv + 1]]);
    } else {
      add(triangleGradInCell(z00, z10, z01, z11, 0.25, 0.25, false), [[cu, cv], [cu + 1, cv], [cu, cv + 1]]);
      add(triangleGradInCell(z00, z10, z01, z11, 0.75, 0.75, false), [[cu + 1, cv + 1], [cu, cv + 1], [cu + 1, cv]]);
    }
  }
  return acc.map((a) => { const m = Math.hypot(...a); return m < 2e-4 ? [0, 0, 1] : a.map((c) => c / m); });
}
// The bevel exactly as the GPU sees it: retail normals through the RGBA8
// round trip (writeTerrainRoundNormals -> decode), the per-pixel input being
// the float vAcLightNormal (the linear retail field).
function bevelRig(lb) {
  const N = retailNormals(lb.heights, lb.lbX, lb.lbY);
  const f = 1, n = 9; // acLightNormal at factor 1 = the retail normals themselves
  const acLight = new Float32Array(81 * 3);
  for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) for (let k = 0; k < 3; k += 1) acLight[(x * n + y) * 3 + k] = N[x * 9 + y][k];
  const bytes = new Uint8Array(18 * 9 * 4);
  R.writeTerrainRoundNormals(bytes, 18, acLight, n, f);
  const Nq = [];
  for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) {
    const o = (y * 18 + 9 + x) * 4; Nq[x * 9 + y] = R.decodeNormalBytes(bytes[o], bytes[o + 1]);
  }
  const cutAt = (cx, cy) => cellSwToNeCut(lb.lbX * 8 + cx, lb.lbY * 8 + cy);
  const field = (gx, gy) => {
    const cu = Math.min(7, Math.floor(gx)), cv = Math.min(7, Math.floor(gy));
    const c = (x, y) => N[x * 9 + y];
    return [0, 1, 2].map((k) => triangleHeightInCell(c(cu, cv)[k], c(cu + 1, cv)[k], c(cu, cv + 1)[k], c(cu + 1, cv + 1)[k], gx - cu, gy - cv, cutAt(cu, cv)));
  };
  const bevel = (gx, gy, band = CFG.bevelWidthM, k = CFG.bevelStrength) =>
    R.terrainRoundBevelNormal(gx, gy, (x, y) => Nq[x * 9 + y], cutAt, band, k, field(gx, gy));
  return { N, field, bevel, cutAt };
}
const SUN = (() => { const v = [0.4, -0.5, 0.75]; const m = Math.hypot(...v); return v.map((x) => x / m); })();
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------------------
console.log("terrain edge rounding (scene3d/terrain_round.js)");
console.log("================================================");
console.log("\n-- 1. flags --");
{
  const d = R.readTerrainRoundConfig("");
  check("default ON: bevel 2 m x1, fillet 8 cm, no LOD floor, no fade",
    d.enabled && d.bevel && d.bevelWidthM === 2 && d.bevelStrength === 1 && d.fillet && d.maxDevM === 0.08
    && d.minLevel === 1 && d.fadeStartM === 0 && d.fadeFullM > 0 && d.fadeFullM < 0.01);
  for (const v of ["off", "0", "false", "OFF"]) {
    const c = R.readTerrainRoundConfig(`?terrainRound=${v}`);
    check(`?terrainRound=${v} -> everything off`, !c.enabled && !c.bevel && !c.fillet);
  }
  const nb = R.readTerrainRoundConfig("?terrainBevel=off");
  check("?terrainBevel=off -> bevel off, fillet kept", nb.enabled && !nb.bevel && nb.fillet);
  check("texture width 18 with the bevel, 9 without",
    R.terrainRoundTypesCols(d) === 18 && R.terrainRoundTypesCols(nb) === 9 && R.terrainRoundTypesCols(R.readTerrainRoundConfig("?terrainRound=off")) === 9);
  check("terrainBevelWidth clamped to [0, 10]", R.readTerrainRoundConfig("?terrainBevelWidth=40").bevelWidthM === 10 && R.readTerrainRoundConfig("?terrainBevelWidth=-1").bevelWidthM === 0);
  check("terrainBevelStrength clamped to [0, 1]", R.readTerrainRoundConfig("?terrainBevelStrength=3").bevelStrength === 1);
  check("terrainRoundMax clamped to 0.5 m", R.readTerrainRoundConfig("?terrainRoundMax=9").maxDevM === 0.5);
  check("terrainRoundMax=0 -> no fillet, bevel kept", (() => { const c = R.readTerrainRoundConfig("?terrainRoundMax=0"); return !c.fillet && c.bevel; })());
  check("fillet strength clamped to 1 (monotone range)", R.readTerrainRoundConfig("?terrainRound=2").strength === 1);
  check("terrainRoundLevel snaps 1/2/4/8", [["1", 1], ["3", 2], ["5", 4], ["16", 8]].every(([q, e]) => R.readTerrainRoundConfig(`?terrainRoundLevel=${q}`).minLevel === e));
  check("LOD floor 1 by default, the level when asked", R.terrainRoundMinLevel(d) === 1 && R.terrainRoundMinLevel(R.readTerrainRoundConfig("?terrainRoundLevel=4")) === 4);
  check("no LOD floor when off", R.terrainRoundMinLevel(R.readTerrainRoundConfig("?terrainRound=off&terrainRoundLevel=4")) === 1);
  const V = function V(a, b) { this.x = a; this.y = b; };
  check("uniforms {} when off", Object.keys(R.terrainRoundUniforms(V, R.readTerrainRoundConfig("?terrainRound=off"))).length === 0);
  const u = R.terrainRoundUniforms(V, d);
  check("uniforms when on (scale, fade, bevel)", u.uRoundScale?.value === 1 && u.uRoundBevel?.value?.x === 2 && u.uRoundBevel?.value?.y === 1 && u.uRoundFade);
  check("node default (no window) resolves ON", R.TERRAIN_ROUND.enabled && R.TERRAIN_ROUND.bevel);
  check("normal byte round trip within 1/127", [[0.3, -0.2, 0], [0, 0, 1], [-0.7, 0.1, 0]].every(([x, y]) => {
    const dn = R.decodeNormalBytes(R.encodeNormalByte(x), R.encodeNormalByte(y)); return Math.abs(dn[0] - x) < 0.0079 && Math.abs(dn[1] - y) < 0.0079;
  }));
  // GLSL split threshold (v8 >= 2147483652u) == the retail f64 test.
  let agree = 0, tot = 0;
  for (let gx = 0; gx < 2040; gx += 7) for (let gy = 0; gy < 2040; gy += 11) {
    const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;
    const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
    tot += 1; if ((v8 >= 2147483652) === cellSwToNeCut(gx, gy)) agree += 1;
  }
  check(`GLSL split threshold matches cellSwToNeCut (${tot} cells)`, agree === tot);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. fillet (synthetic) --");
const BIG = R.readTerrainRoundConfig("?terrainRoundMax=0.5"); // exercise the math at a visible cap
{
  const LB = { lbX: 0x50, lbY: 0x50 };
  const plane = { ...LB, heights: new Float32Array(81) };
  for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) plane.heights[x * 9 + y] = 40 + 2 * x - 4 * y;
  for (const f of [2, 4, 8]) check(`plane untouched (f=${f})`, filletLb(plane, f, BIG).off.every((o) => o === 0));
  // N-S ridge along x = 4, gentle (2 m per 24 m) so x4 samples the fillet.
  const ridge = { ...LB, heights: new Float32Array(81) };
  for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) ridge.heights[x * 9 + y] = 30 - 2 * Math.abs(x - 4);
  for (const f of [4, 8]) {
    const r = filletLb(ridge, f, BIG); const n = r.n;
    let ctrl0 = true; for (let x = 0; x <= 8; x += 1) for (let y = 0; y <= 8; y += 1) if (r.off[(x * f) * n + y * f] !== 0) ctrl0 = false;
    check(`retail vertices exactly 0 (f=${f})`, ctrl0);
    const next = r.off[(4 * f + 1) * n + 4 * f];
    check(`crest kept, flank next to it raised into a crown (f=${f})`, r.off[(4 * f) * n + 4 * f] === 0 && next > 0.01, `next ${next}`);
    check(`crown never above the crest (f=${f})`, r.vis(4 * f + 1, 4 * f) <= 30 + 1e-9);
    let maxAbs = 0; for (const o of r.off) maxAbs = Math.max(maxAbs, Math.abs(o));
    check(`|off| <= cap (f=${f})`, maxAbs <= 0.5 + 1e-6, `${maxAbs}`);
  }
  check("factor 1 -> null", R.computeTerrainRoundOffsets(facetPositions(ridge.heights, 0x50, 0x50, 1), 9, 1, 0x50, 0x50, BIG) === null);
  check("off config -> null", R.computeTerrainRoundOffsets(facetPositions(ridge.heights, 0x50, 0x50, 4), 33, 4, 0x50, 0x50, R.readTerrainRoundConfig("?terrainRound=off")) === null);
  check("shape mismatch -> null", R.computeTerrainRoundOffsets(facetPositions(ridge.heights, 0x50, 0x50, 4), 17, 4, 0x50, 0x50, BIG) === null);
  // Bevel on a plane: identical fields on every side -> untouched.
  const rig = bevelRig({ ...plane, heights: plane.heights });
  let pmax = 0; for (let gx = 0.01; gx < 8; gx += 0.037) for (let gy = 0.02; gy < 8; gy += 0.041) pmax = Math.max(pmax, dist3(rig.bevel(gx, gy), rig.field(gx, gy)));
  check("bevel leaves a plane untouched", pmax < 0.008, `max ${pmax}`); // 8-bit normal quantisation only
}

// ---------------------------------------------------------------------------
// 3. Real DAT
// ---------------------------------------------------------------------------
const DAT = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
function openCellDat(path) {
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
  const find = (id) => { // directory B-tree: 62 branches, count, 24-byte entries ascending by id
    let node = root;
    for (let depth = 0; node && depth < 32; depth += 1) {
      const d = readData(node, 1716);
      const count = d.readUInt32LE(248);
      const leaf = d.readUInt32LE(0) === 0;
      let i = 0;
      for (; i < count; i += 1) {
        const eid = d.readUInt32LE(252 + 24 * i + 4);
        if (eid === id) { const e = 252 + 24 * i; return { flags: d.readUInt32LE(e), offset: d.readUInt32LE(e + 8), size: d.readUInt32LE(e + 12) }; }
        if (eid > id) break;
      }
      if (leaf) return null;
      node = d.readUInt32LE(4 * i);
    }
    return null;
  };
  const landblock = (lbX, lbY) => {
    const e = find((((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | 0xffff) >>> 0);
    if (!e || (e.flags & 1)) return null;
    const b = readData(e.offset, e.size);
    const heights = new Float32Array(81);
    for (let v = 0; v < 81; v += 1) heights[v] = b[8 + 162 + v] * 2.0; // retail LandHeightTable == byte*2
    return { lbX, lbY, heights };
  };
  return { landblock, close: () => closeSync(fd) };
}

console.log("\n-- 3. real DAT --");
if (!existsSync(DAT)) {
  // Not a silent pass: parts 1, 2 and 4 still assert; this part needs the DAT.
  console.log(`  real-DAT section not run: ${DAT} missing (set HB_CELL_DAT)`);
} else {
  const dat = openCellDat(DAT);
  const REGIONS = [
    ["screenshot 41.1S 54.6W (0x3B4C)", 0x3b, 0x4c],
    ["Holtburg (0xA9B4)", 0xa9, 0xb4],
    ["mountains (0xBBC7)", 0xbb, 0xc7],
  ];
  const L4 = R.readTerrainRoundConfig("?terrainRoundLevel=4");
  const table = [];
  for (const [name, cx, cy] of REGIONS) {
    const lbs = new Map();
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      const lb = dat.landblock(cx + dx, cy + dy); if (lb) lbs.set(`${dx},${dy}`, lb);
    }
    check(`${name}: 3x3 read`, lbs.size === 9);
    const nbOf = (dx, dy) => ({
      east: lbs.get(`${dx + 1},${dy}`)?.heights ?? null, west: lbs.get(`${dx - 1},${dy}`)?.heights ?? null,
      north: lbs.get(`${dx},${dy + 1}`)?.heights ?? null, south: lbs.get(`${dx},${dy - 1}`)?.heights ?? null,
    });
    // --- fillet at the defaults (x4 and x8) and with a x4 LOD floor ---
    const baked = {};
    for (const [tag, f, cfg] of [["x4", 4, CFG], ["x8", 8, CFG], ["L4x4", 4, L4], ["L4x8", 8, L4]]) {
      baked[tag] = new Map();
      R._resetTerrainRoundStatsForTest();
      let ctrlBad = 0, rangeBad = 0, maxAbs = 0;
      for (const [key, lb] of lbs) {
        const [dx, dy] = key.split(",").map(Number);
        const r = filletLb(lb, f, cfg, nbOf(dx, dy)); baked[tag].set(key, r);
        R.noteTerrainRoundOffsets(r.off);
        const n = r.n;
        for (let x = 0; x <= 8; x += 1) for (let y = 0; y <= 8; y += 1) {
          const v = (x * f) * n + y * f;
          if (r.off[v] !== 0 || r.vis(x * f, y * f) !== lb.heights[x * 9 + y]) ctrlBad += 1;
        }
        for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
          maxAbs = Math.max(maxAbs, Math.abs(r.off[i * n + j]));
          const cu = Math.min(7, Math.floor(i / f)), cv = Math.min(7, Math.floor(j / f));
          const hs = [lb.heights[cu * 9 + cv], lb.heights[(cu + 1) * 9 + cv], lb.heights[cu * 9 + cv + 1], lb.heights[(cu + 1) * 9 + cv + 1]];
          const z = r.vis(i, j);
          if (z > Math.max(...hs) + 1e-4 || z < Math.min(...hs) - 1e-4) rangeBad += 1;
        }
      }
      if (tag === "x4" || tag === "x8") {
        check(`${name} ${tag}: retail vertex heights bit-identical (offset exactly 0)`, ctrlBad === 0, `${ctrlBad} differ`);
        check(`${name} ${tag}: |visual - physics| <= ${CFG.maxDevM} m`, maxAbs <= CFG.maxDevM + 1e-6, `max ${maxAbs}`);
        check(`${name} ${tag}: never above/below the cell's retail max/min`, rangeBad === 0, `${rangeBad} out of range`);
        table.push({ name, tag, ...R.terrainRoundStats() });
      }
    }
    // Seams: equal factors bit-identical; x4|x8 under a x4 floor collinear.
    let exact = 0, exactBad = 0, tj = 0, tjBad = 0;
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const [ex, ey, axis] of [[1, 0, "x"], [0, 1, "y"]]) {
        const ka = `${dx},${dy}`, kb = `${dx + ex},${dy + ey}`;
        if (!lbs.has(kb)) continue;
        const edgeV = (Rr, isA, s) => { const n = Rr.n; return axis === "x" ? (isA ? Rr.vis(n - 1, s) : Rr.vis(0, s)) : (isA ? Rr.vis(s, n - 1) : Rr.vis(s, 0)); };
        for (const tag of ["x4", "x8", "L4x4", "L4x8"]) {
          const A = baked[tag].get(ka), B = baked[tag].get(kb);
          for (let s = 0; s < A.n; s += 1) { exact += 1; if (edgeV(A, true, s) !== edgeV(B, false, s)) exactBad += 1; }
        }
        for (const [fine, coarse, fineIsA] of [[baked.L4x8.get(ka), baked.L4x4.get(kb), true], [baked.L4x8.get(kb), baked.L4x4.get(ka), false]]) {
          for (let s = 0; s < fine.n; s += 1) {
            const c0 = Math.floor(s / 2), c1 = Math.min(c0 + 1, coarse.n - 1), fr = s / 2 - c0;
            const vc = edgeV(coarse, !fineIsA, c0) * (1 - fr) + edgeV(coarse, !fineIsA, c1) * fr;
            tj += 1; if (Math.abs(edgeV(fine, fineIsA, s) - vc) > 1e-4) tjBad += 1;
          }
        }
      }
    }
    check(`${name}: same-factor seams bit-identical (${exact} shared vertices)`, exactBad === 0, `${exactBad} differ`);
    check(`${name}: x8|x4 LOD seams collinear under a x4 floor (${tj} edge vertices)`, tjBad === 0, `${tjBad} > 1e-4 m`);

    // --- shading bevel on the centre landblock ---
    const lb = lbs.get("0,0");
    const rig = bevelRig(lb);
    const w = CFG.bevelWidthM / 24;
    let outsideBad = 0, outsideN = 0, seamBad = 0, c0Max = 0, jb = [], ja = [], dLmax = 0;
    const e = 1e-5;
    for (let gx = 0.003; gx < 8; gx += 0.0213) for (let gy = 0.007; gy < 8; gy += 0.0197) {
      const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
      const cut = rig.cutAt(Math.floor(gx), Math.floor(gy));
      const dDiag = (cut ? Math.abs(fx - fy) : Math.abs(fx + fy - 1)) * Math.SQRT1_2;
      const dEdge = Math.min(fx, 1 - fx, fy, 1 - fy, dDiag);
      const nb = rig.bevel(gx, gy), nIn = rig.field(gx, gy);
      dLmax = Math.max(dLmax, Math.abs(dot3(nb, SUN) - dot3(nIn, SUN)));
      if (dEdge >= w + 1e-9) { outsideN += 1; if (dist3(nb, nIn) !== 0) outsideBad += 1; }
    }
    check(`${name}: bevel is EXACTLY the retail normal outside the ${CFG.bevelWidthM} m band (${outsideN} pts)`, outsideBad === 0, `${outsideBad} differ`);
    // Across interior cell edges (x = 1..7) and every split diagonal: C0 and
    // the Gouraud lighting gradient jump removed.
    const sampleAcross = (p0, dir) => { // p0 on a crease, dir = unit normal of the crease in grid units
      const at = (t) => [p0[0] + dir[0] * t, p0[1] + dir[1] * t];
      const L = (t, bev) => { const [x, y] = at(t); return dot3(bev ? rig.bevel(x, y) : rig.field(x, y), SUN); };
      const jump = (bev) => Math.abs(((L(2 * e, bev) - L(e, bev)) - (L(-e, bev) - L(-2 * e, bev))) / e);
      const [xa, ya] = at(-e), [xb, yb] = at(e);
      c0Max = Math.max(c0Max, dist3(rig.bevel(xa, ya), rig.bevel(xb, yb)));
      jb.push(jump(false)); ja.push(jump(true));
    };
    for (let X = 1; X <= 7; X += 1) for (let t = 0.2; t < 8; t += 0.37) sampleAcross([X, t], [1, 0]);
    for (let Y = 1; Y <= 7; Y += 1) for (let t = 0.2; t < 8; t += 0.37) sampleAcross([t, Y], [0, 1]);
    for (let cx = 0; cx < 8; cx += 1) for (let cy = 0; cy < 8; cy += 1) {
      const c = rig.cutAt(cx, cy);
      for (const t of [0.3, 0.5, 0.7]) sampleAcross(c ? [cx + t, cy + t] : [cx + t, cy + 1 - t], c ? [Math.SQRT1_2, -Math.SQRT1_2] : [Math.SQRT1_2, Math.SQRT1_2]);
    }
    const sum = (a) => a.reduce((p, q) => p + q, 0);
    const big = jb.map((v, i) => [v, ja[i]]).filter(([v]) => v > 0.05);
    const keep = big.length ? sum(big.map(([, a]) => a)) / sum(big.map(([v]) => v)) : 0;
    check(`${name}: bevel continuous across every crease (max |dn| ${c0Max.toExponential(1)})`, c0Max < 1e-3);
    check(`${name}: Gouraud gradient jump across creases removed (${big.length} creases > 0.05, ${(100 - keep * 100).toFixed(0)}% gone)`, big.length > 20 && keep < 0.15);
    // Landblock seams are a hard border (the other landblock's block-local
    // normals are not in this texture): on the 192 m lines the bevel equals
    // the retail field except within the band of an interior crease that
    // ENDS on the line (a cell edge or diagonal meeting a seam vertex).
    let seamN = 0;
    for (let t = 0.05; t < 8; t += 0.1) {
      const ft = t - Math.floor(t);
      if (ft < 2 * w || ft > 1 - 2 * w) continue; // near a seam vertex
      for (const [x, y] of [[0, t], [8, t], [t, 0], [t, 8]]) {
        seamN += 1; if (dist3(rig.bevel(x, y), rig.field(x, y)) > 0.008) seamBad += 1;
      }
    }
    check(`${name}: landblock seams not bevelled across (${seamN} seam pts == retail)`, seamBad === 0, `${seamBad} differ`);
    table.find((r) => r.name === name && r.tag === "x4").dLmax = dLmax;
  }
  dat.close();
  console.log("\n  Centimetre fillet at the defaults (cap 8 cm). |visual - physics|, metres; retail vertices are 0:");
  console.log("  region                               f    max     p99     mean     moved>1mm");
  for (const r of table) console.log(`  ${r.name.padEnd(36)} ${r.tag}   ${r.maxAbsM.toFixed(3)}   ${r.p99AbsM.toFixed(3)}   ${r.meanAbsM.toFixed(4)}   ${(r.movedFrac * 100).toFixed(1)}%`);
  console.log("  Shading bevel (2 m band): max change of the Gouraud dot(N, sun) per region:");
  for (const r of table.filter((q) => q.dLmax != null)) console.log(`  ${r.name.padEnd(36)} ${r.dLmax.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. wiring --");
{
  const tsrc = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
  const bsrc = readFileSync(resolvePath(__dirname, "scene3d/terrain_batch.js"), "utf8");
  check("vertex decl block injected only when enabled", tsrc.includes("in vec3 acLightNormal;${TERRAIN_ROUND.enabled ? TERRAIN_ROUND_VERTEX_DECL_GLSL"));
  check("vertex apply block right after the mvPos line", tsrc.includes("  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);${TERRAIN_ROUND.enabled ? TERRAIN_ROUND_VERTEX_APPLY_GLSL"));
  check("batch placement anchor intact (exactly once)", tsrc.split("  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;\n  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);").length === 2);
  check("fragment bevel helpers injected after vertexRoadAt (after vGridUv + vLbSlot decls)",
    tsrc.includes("  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;\n}${TERRAIN_ROUND_BEVEL_ON ? TERRAIN_ROUND_FRAG_GLSL"));
  // 2026-10-07 (terrain step 4) — the shading normal is hoisted into acShadeN
  // so the micro-relief (scene3d/terrain_micro.js) can perturb the bevel's
  // OUTPUT; the bevel itself is still the only thing that reads vAcLightNormal.
  check("Gouraud term reads the bevelled normal only when on",
    tsrc.includes('vec3 acShadeN = ${TERRAIN_ROUND_BEVEL_ON ? "terrainRoundBevel(vAcLightNormal)" : "vAcLightNormal"};')
    && tsrc.includes("modulated = terrainAcGouraud(modulated, acShadeN, uAcSunVec,"));
  check("vertexRoadAt batch anchor intact (exactly once)", tsrc.split("  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;").length === 2);
  check("wide vertex-types texture + normals writer wired", tsrc.includes("function acquireWideVertexTypesTex(") && tsrc.includes("writeTerrainRoundNormals(bytes, cols,"));
  check("material spreads terrainRoundUniforms", tsrc.includes("...terrainRoundUniforms(THREE.Vector2),"));
  check("LOD picker floor + ring opts", tsrc.includes("return opts.roundMinLevel > level ? opts.roundMinLevel : level;") && tsrc.includes("    roundMinLevel,\n"));
  check("bake sets aRoundZ with neighbour heights", tsrc.includes('geom.setAttribute("aRoundZ"') && tsrc.includes("terrainRoundNeighbours(lbX, lbY)"));
  const anchorB = bsrc.match(/const ROUND_FETCH_ANCHOR =\s*\n\s*"(.*)";/);
  const batchedB = bsrc.match(/const ROUND_FETCH_BATCHED =\s*\n\s*"(.*)";/);
  check("terrain_batch anchor strings == terrain_round exports",
    anchorB && batchedB && anchorB[1] === R.TERRAIN_ROUND_FETCH_ANCHOR && batchedB[1] === R.TERRAIN_ROUND_FETCH_BATCHED);
  check("bevel fetch anchor occurs exactly once in the fragment GLSL", R.TERRAIN_ROUND_FRAG_GLSL.split(R.TERRAIN_ROUND_FETCH_ANCHOR).length === 2);
  check("terrain_batch: conditional bevel rewrite + layer width from the texture",
    bsrc.includes("if (f.includes(ROUND_FETCH_ANCHOR)) {") && bsrc.includes("vtArray: _makeDataArray(vtW, VT_H, TB_SLOT_CAPACITY),") && bsrc.includes('name === "aRoundZ"'));
  check("GLSL declares the bevel uniform + flat cell origin in both stages",
    R.TERRAIN_ROUND_FRAG_GLSL.includes("uniform vec2 uRoundBevel;") && R.TERRAIN_ROUND_FRAG_GLSL.includes("flat in vec2 vRoundLbCell;")
    && R.TERRAIN_ROUND_VERTEX_DECL_GLSL.includes("flat out vec2 vRoundLbCell;") && R.TERRAIN_ROUND_VERTEX_APPLY_GLSL.includes("vRoundLbCell = floor("));
  check("GLSL mirrors the JS bevel (smoothstep band, 2x2 gather, early-out, own delta)",
    R.TERRAIN_ROUND_FRAG_GLSL.includes("smoothstep(-w, w, sd1)") && R.TERRAIN_ROUND_FRAG_GLSL.includes("if (dIn >= w) return nIn;")
    && R.TERRAIN_ROUND_FRAG_GLSL.includes("return nIn + k * (acc / ws - own);") && R.TERRAIN_ROUND_FRAG_GLSL.includes("return v8 >= 2147483652u;"));
  check("no backticks inside any GLSL", ![R.TERRAIN_ROUND_VERTEX_DECL_GLSL, R.TERRAIN_ROUND_VERTEX_APPLY_GLSL, R.TERRAIN_ROUND_FRAG_GLSL].some((g) => g.includes("`")));
  check("defaults frozen", Object.isFrozen(R.TERRAIN_ROUND_DEFAULTS));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
