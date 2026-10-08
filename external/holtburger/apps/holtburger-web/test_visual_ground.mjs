// 2026-10-07 — terrain rounding step 3 (scene3d/visual_ground.js) test:
// objects standing on the ground are DRAWN on the drawn (rounded) ground.
//
// Run with:
//   cd apps/holtburger-web && node test_visual_ground.mjs
//
// Locks:
//  1. FLAGS + LOD mirror — default-ON, `?terrainRoundObjects=off` escape, inert
//     whenever the fillet is off; the statics factor rule mirrors terrain.js
//     `pickSubdivLevelForLb` at Chebyshev <= 1 (source-pinned).
//  2. REAL DAT (~/ac_base_dats/client_cell_1.dat, 3x3 at the owner's screenshot
//     spot 0x3B4C, Holtburg 0xA9B4, mountains 0xBBC7):
//       - the f32 faceted positions == terrain_subdiv.rs (retail vertices exact);
//       - visualGroundDeltaAt == the bake's per-vertex aRoundZ BIT-FOR-BIT at
//         every subdivided vertex, EXACTLY 0 at every retail vertex;
//       - between vertices == (drawn visual Z - physics Z) recomputed
//         independently from the positions, and within the cap;
//       - continuous across landblock seams;
//       - the statics (object-level) path recomputes the identical field;
//       - 0 with `?terrainRound=off` / the module off; stress cap 0.5 m @ x4.
//  3. GATING — render-only matrix offset (root.position never written);
//     indoor / attached / missile / no-GRAVITY / elevated / no-fillet = 0;
//     the contact taper; local player; memo (one PhysicsState read per window).
//  4. STATICS — placements baked at the near-player factor, elevated kept,
//     wireframe / off untouched, heights fetched + freed when terrain is late,
//     the quality-preset fallback when the ring opts are not resolved yet.
//  5. WIRING — terrain.js / entities.js / statics.js hooks; ragdoll + picking
//     stay on the physics root; url-flags row; shader weight mirror.

import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import * as R from "./scene3d/terrain_round.js";
import * as V from "./scene3d/visual_ground.js";
import { cellSwToNeCut, triangleHeightInCell } from "./scene3d/terrain_oracle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const CFG = R.readTerrainRoundConfig("");
const STRESS = R.readTerrainRoundConfig("?terrainRoundMax=0.5&terrainRoundLevel=4");
const src = (p) => readFileSync(resolvePath(__dirname, p), "utf8");

console.log("terrain rounding step 3 — objects on the drawn ground (scene3d/visual_ground.js)");
console.log("=================================================================================");

// ---------------------------------------------------------------------------
console.log("\n-- 1. flags + LOD mirror --");
{
  check("default ON (node: fillet on, no URL)", V.readVisualGroundConfig("").enabled && V.visualGroundEnabled());
  for (const v of ["off", "0", "false", "OFF"]) {
    check(`?terrainRoundObjects=${v} -> off`, !V.readVisualGroundConfig(`?terrainRoundObjects=${v}`).enabled);
  }
  check("inert with ?terrainRound=off", !V.readVisualGroundConfig("", R.readTerrainRoundConfig("?terrainRound=off")).enabled);
  check("inert with ?terrainRoundMax=0 (no fillet)", !V.readVisualGroundConfig("", R.readTerrainRoundConfig("?terrainRoundMax=0")).enabled);
  const L = V.visualGroundObjectLevel;
  check("object level = max(roundMinLevel, max(1, floor(q/2))) (ultra 4, high 2, mid 1, low 1)",
    L({ canSubdivide: true, subdivLevel: 8, roundMinLevel: 1 }) === 4 && L({ canSubdivide: true, subdivLevel: 4, roundMinLevel: 1 }) === 2
    && L({ canSubdivide: true, subdivLevel: 2, roundMinLevel: 1 }) === 1 && L({ canSubdivide: true, subdivLevel: 1, roundMinLevel: 1 }) === 1);
  check("terrainRoundLevel floor wins (?terrainRoundLevel=4 at mid -> 4; =8 at ultra -> 8)",
    L({ canSubdivide: true, subdivLevel: 2, roundMinLevel: 4 }) === 4 && L({ canSubdivide: true, subdivLevel: 8, roundMinLevel: 8 }) === 8);
  check("no subdivision -> 1", L({ canSubdivide: false, subdivLevel: 8, roundMinLevel: 4 }) === 1 && L(null) === 1);
  const t = src("scene3d/terrain.js");
  check("mirror pinned to terrain.js pickSubdivLevelForLb (half level, Chebyshev <= 1, round floor)",
    t.includes("const halfLevel = Math.max(1, Math.floor(opts.subdivLevel / 2));")
    && t.includes("const level = distLb <= 1 ? halfLevel : 1;")
    && t.includes("return opts.roundMinLevel > level ? opts.roundMinLevel : level;"));
  check("quality fallback pinned to terrain.js pickSubdivLevel snap + canSubdivide",
    t.includes("const raw = scene3d?.quality?.flags?.subdivLevel;") && t.includes("if (raw >= 8) return 8;")
    && t.includes('typeof wasmExports.fetch_subdivided_landblocks === "function";')
    && t.includes("const roundMinLevel = canSubdivide ? terrainRoundMinLevel() : 1;"));
  check("live fillet weight = 1 by default (no fade at any distance)",
    R.terrainRoundFilletWeight() === 1 && R.terrainRoundFilletWeight(1) === 1 && R.terrainRoundFilletWeight(NaN) === 1);
  const rs = src("scene3d/terrain_round.js");
  check("weight mirrors the vertex shader (uRoundScale * smoothstep(uRoundFade, camera distance))",
    rs.includes("float roundW = uRoundScale * smoothstep(uRoundFade.x, uRoundFade.y, length(mvPos.xyz));")
    && rs.includes("return s * _smoothstep(_live.fadeStartM, _live.fadeFullM, camDistM);"));
  check("contact taper: full <= 0.25 m, none >= 1 m, smooth between, full below ground",
    V.contactWeight(0) === 1 && V.contactWeight(-3) === 1 && V.contactWeight(0.25) === 1 && V.contactWeight(1) === 0
    && V.contactWeight(2) === 0 && V.contactWeight(0.625) > 0.49 && V.contactWeight(0.625) < 0.51
    && V.contactWeight(0.4) > V.contactWeight(0.6));
}

// ---------------------------------------------------------------------------
// Real DAT reader (same B-tree walk as test_terrain_round.mjs).
// ---------------------------------------------------------------------------
const DAT = process.env.HB_CELL_DAT || "/home/wbterminal/ac_base_dats/client_cell_1.dat";
function openCellDat(path) {
  const fd = openSync(path, "r");
  const hdr = Buffer.alloc(36);
  readSync(fd, hdr, 0, 36, 0x140);
  const blockSize = hdr.readUInt32LE(4);
  const root = hdr.readUInt32LE(32);
  const readAt = (len, off) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const readData = (offset, size) => {
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
  const find = (id) => {
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

// Independent "what the GPU draws minus physics" at LB-local (lx, ly): the
// drawn triangle through the three (faceted Z + offset) vertices, minus the
// retail plane. Uses the positions array, not the module's interpolator.
function drawnMinusPhysics(pos, off, f, lbX, lbY, h, lx, ly) {
  const n = 8 * f + 1;
  const gi = Math.min(n - 1, Math.max(0, (lx * f) / 24)), gj = Math.min(n - 1, Math.max(0, (ly * f) / 24));
  const i0 = Math.min(Math.floor(gi), n - 2), j0 = Math.min(Math.floor(gj), n - 2);
  const a = gi - i0, b = gj - j0;
  const vz = (i, j) => pos[(i * n + j) * 3 + 2] + off[i * n + j];
  const cut = cellSwToNeCut(lbX * 8 + Math.floor(i0 / f), lbY * 8 + Math.floor(j0 / f));
  const vis = triangleHeightInCell(vz(i0, j0), vz(i0 + 1, j0), vz(i0, j0 + 1), vz(i0 + 1, j0 + 1), a, b, cut);
  return vis - V.retailGroundZ(h, lbX, lbY, lx, ly);
}

// f64 faceted reference (test_terrain_round.mjs facetPositions).
function facetZ64(h, lbX, lbY, f, i, j) {
  const u = i / f, v = j / f;
  const cu = Math.min(Math.floor(u), 7), cv = Math.min(Math.floor(v), 7);
  const z = (x, y) => h[x * 9 + y];
  return triangleHeightInCell(z(cu, cv), z(cu + 1, cv), z(cu, cv + 1), z(cu + 1, cv + 1), u - cu, v - cv, cellSwToNeCut(lbX * 8 + cu, lbY * 8 + cv));
}

// Deterministic PRNG for sample points.
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

console.log("\n-- 2. real DAT --");
const table = [];
if (!existsSync(DAT)) {
  console.log(`  real-DAT section not run: ${DAT} missing (set HB_CELL_DAT)`);
} else {
  const dat = openCellDat(DAT);
  const REGIONS = [
    ["screenshot 41.1S 54.6W (0x3B4C)", 0x3b, 0x4c],
    ["Holtburg (0xA9B4)", 0xa9, 0xb4],
    ["mountains (0xBBC7)", 0xbb, 0xc7],
  ];
  for (const [name, cx, cy] of REGIONS) {
    const lbs = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      const lb = dat.landblock(cx + dx, cy + dy); if (lb) lbs.push(lb);
    }
    check(`${name}: 3x3 read`, lbs.length === 9);
    // Like a session: every LB's heights are seen before the bakes, so the
    // bake and the statics path see the same neighbours.
    R._resetTerrainRoundHeightsForTest();
    for (const lb of lbs) R.noteTerrainRoundHeights(lb.lbX, lb.lbY, lb.heights);

    for (const [tag, f, cfg] of [["x4", 4, CFG], ["x8", 8, CFG], ["stress 0.5m x4", 4, STRESS]]) {
      V._resetVisualGroundForTest();
      const baked = new Map();
      let posBad = 0, posMax = 0;
      for (const lb of lbs) {
        const pos = V.facetPositionsF32(lb.heights, lb.lbX, lb.lbY, f);
        const n = 8 * f + 1;
        for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
          const z = pos[(i * n + j) * 3 + 2];
          posMax = Math.max(posMax, Math.abs(z - facetZ64(lb.heights, lb.lbX, lb.lbY, f, i, j)));
          if (i % f === 0 && j % f === 0 && z !== lb.heights[(i / f) * 9 + j / f]) posBad += 1;
        }
        // "The bake": terrain.js runs exactly this on the wasm positions.
        const off = R.computeTerrainRoundOffsets(pos, n, f, lb.lbX, lb.lbY, cfg, R.terrainRoundNeighbours(lb.lbX, lb.lbY));
        baked.set(`${lb.lbX},${lb.lbY}`, { lb, pos, off, n });
        V.noteVisualGroundBake(lb.lbX, lb.lbY, lb.heights, f, off, { canSubdivide: true, subdivLevel: 2 * f, roundMinLevel: 1 });
      }
      if (tag === "x4") {
        check(`${name}: f32 faceted positions — retail vertices exact, <= 1e-4 m from the f64 facet`, posBad === 0 && posMax < 1e-4, `bad ${posBad} max ${posMax}`);
      }
      let vtxN = 0, vtxBad = 0, retailN = 0, retailBad = 0, ptsN = 0, capBad = 0, indepMax = 0, triBad = 0, maxAbs = 0, sumAbs = 0;
      for (const { lb, pos, off, n } of baked.values()) {
        const X0 = lb.lbX * 192, Y0 = lb.lbY * 192;
        // Explicit lbKey: an east/north edge vertex otherwise resolves to the
        // neighbour LB (outside this 3x3 for the outer ring).
        const kLb = (((lb.lbX & 0xff) << 24) | ((lb.lbY & 0xff) << 16)) >>> 0;
        for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
          const d = V.visualGroundDeltaAt(X0 + (i * 24) / f, Y0 + (j * 24) / f, kLb);
          if (i % f === 0 && j % f === 0) { retailN += 1; if (d !== 0) retailBad += 1; }
          vtxN += 1; if (d !== off[i * n + j]) vtxBad += 1;
        }
        for (let k = 0; k < 4000; k += 1) {
          const lx = rnd() * 192, ly = rnd() * 192;
          const d = V.visualGroundDeltaAt(X0 + lx, Y0 + ly);
          ptsN += 1;
          maxAbs = Math.max(maxAbs, Math.abs(d)); sumAbs += Math.abs(d);
          if (Math.abs(d) > cfg.maxDevM + 1e-9) capBad += 1;
          indepMax = Math.max(indepMax, Math.abs(d - drawnMinusPhysics(pos, off, f, lb.lbX, lb.lbY, lb.heights, lx, ly)));
          // within the three drawn vertices' offsets
          const gi = Math.min(Math.floor((lx * f) / 24), n - 2), gj = Math.min(Math.floor((ly * f) / 24), n - 2);
          const q = [off[gi * n + gj], off[(gi + 1) * n + gj], off[gi * n + gj + 1], off[(gi + 1) * n + gj + 1]];
          if (d > Math.max(...q) + 1e-12 || d < Math.min(...q) - 1e-12) triBad += 1;
        }
      }
      check(`${name} ${tag}: delta == the bake's aRoundZ bit-for-bit at all ${vtxN} subdivided vertices`, vtxBad === 0, `${vtxBad} differ`);
      check(`${name} ${tag}: delta EXACTLY 0 at all ${retailN} retail vertices`, retailBad === 0, `${retailBad} nonzero`);
      check(`${name} ${tag}: |delta| <= cap ${cfg.maxDevM} m (${ptsN} random points)`, capBad === 0, `${capBad} over`);
      check(`${name} ${tag}: delta == drawn visual Z - physics Z (independent, f32 facets) <= 1e-4 m`, indepMax < 1e-4, `max ${indepMax}`);
      check(`${name} ${tag}: delta inside its drawn sub-quad's offsets`, triBad === 0, `${triBad} outside`);
      // Seams: approach every shared LB edge from both sides (each LB's own record).
      let seamMax = 0, seamN = 0;
      for (const { lb } of baked.values()) {
        for (const [ex, ey] of [[1, 0], [0, 1]]) {
          if (!baked.has(`${lb.lbX + ex},${lb.lbY + ey}`)) continue;
          for (let t = 0.37; t < 192; t += 1.91) {
            const xE = ex ? (lb.lbX + 1) * 192 : lb.lbX * 192 + t;
            const yE = ey ? (lb.lbY + 1) * 192 : lb.lbY * 192 + t;
            const kA = (((lb.lbX & 0xff) << 24) | ((lb.lbY & 0xff) << 16)) >>> 0;
            const kB = ((((lb.lbX + ex) & 0xff) << 24) | (((lb.lbY + ey) & 0xff) << 16)) >>> 0;
            seamN += 1;
            seamMax = Math.max(seamMax, Math.abs(V.visualGroundDeltaAt(xE, yE, kA) - V.visualGroundDeltaAt(xE, yE, kB)));
          }
        }
      }
      check(`${name} ${tag}: continuous across landblock seams (${seamN} pts, max ${seamMax.toExponential(1)})`, seamMax < 1e-6);
      if (cfg === CFG) {
        // Statics path: same factor -> the drawn record itself; drawn coarser
        // (factor 1 now) -> the SAME function recomputed from the heights.
        const c = baked.get(`${cx},${cy}`);
        const X0 = cx * 192, Y0 = cy * 192;
        let same = 0, recomputedBad = 0, k = 0;
        const probe = [];
        for (let s = 0; s < 3000; s += 1) probe.push([X0 + rnd() * 192, Y0 + rnd() * 192]);
        for (const [x, y] of probe) if (V.visualGroundDeltaAt(x, y, undefined, Infinity, f) === V.visualGroundDeltaAt(x, y)) same += 1;
        const drawnVals = probe.map(([x, y]) => V.visualGroundDeltaAt(x, y));
        V.noteVisualGroundBake(cx, cy, c.lb.heights, 1, null, null); // LOD drop: drawn at factor 1
        const nowFlat = probe.every(([x, y]) => V.visualGroundDeltaAt(x, y) === 0);
        for (const [x, y] of probe) { if (V.visualGroundDeltaAt(x, y, undefined, Infinity, f) !== drawnVals[k]) recomputedBad += 1; k += 1; }
        check(`${name} ${tag}: statics level path == drawn record (same factor, ${probe.length} pts)`, same === probe.length);
        check(`${name} ${tag}: factor-1 LB draws no fillet -> delta 0`, nowFlat);
        check(`${name} ${tag}: statics recompute from heights == the bake bit-for-bit`, recomputedBad === 0, `${recomputedBad} differ`);
      }
      if (tag !== "x8") table.push({ name, tag, maxAbs, mean: sumAbs / ptsN });
    }
    // Off: no offsets baked -> 0; module switch -> 0 even with offsets.
    V._resetVisualGroundForTest();
    const OFF = R.readTerrainRoundConfig("?terrainRound=off");
    const lb = lbs[4];
    const pos = V.facetPositionsF32(lb.heights, lb.lbX, lb.lbY, 4);
    const offOff = R.computeTerrainRoundOffsets(pos, 33, 4, lb.lbX, lb.lbY, OFF, null);
    V.noteVisualGroundBake(lb.lbX, lb.lbY, lb.heights, 4, offOff, null);
    let anyOff = false;
    for (let s = 0; s < 500; s += 1) if (V.visualGroundDeltaAt(lb.lbX * 192 + rnd() * 192, lb.lbY * 192 + rnd() * 192) !== 0) anyOff = true;
    check(`${name}: ?terrainRound=off -> no offsets baked -> delta 0`, offOff === null && !anyOff);
    const offOn = R.computeTerrainRoundOffsets(pos, 33, 4, lb.lbX, lb.lbY, STRESS, null);
    V.noteVisualGroundBake(lb.lbX, lb.lbY, lb.heights, 4, offOn, null);
    let nz = 0; const pts = [];
    for (let s = 0; s < 500; s += 1) { const p = [lb.lbX * 192 + rnd() * 192, lb.lbY * 192 + rnd() * 192]; pts.push(p); if (V.visualGroundDeltaAt(p[0], p[1]) !== 0) nz += 1; }
    V._setVisualGroundEnabledForTest(false);
    const killed = pts.every(([x, y]) => V.visualGroundDeltaAt(x, y) === 0);
    V._setVisualGroundEnabledForTest(true);
    check(`${name}: ?terrainRoundObjects=off -> delta 0 even with a baked fillet (${nz} nonzero when on)`, nz > 0 && killed);
  }
  dat.close();
  console.log("\n  |visual - physics| under objects (the feet gap each would show WITHOUT step 3), metres:");
  console.log("  region                               fillet           max      mean");
  for (const r of table) console.log(`  ${r.name.padEnd(36)} ${r.tag.padEnd(15)}  ${r.maxAbs.toFixed(3)}    ${r.mean.toFixed(4)}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. gating (render-only root offset) --");
// Synthetic N-S ridge LB (crest x = 4), x8, stress cap — a clearly nonzero delta.
const LBX = 0x50, LBY = 0x50;
const ridge = new Float32Array(81);
for (let x = 0; x < 9; x += 1) for (let y = 0; y < 9; y += 1) ridge[x * 9 + y] = 30 - 2 * Math.abs(x - 4);
function bakeRidge(f = 8, cfg = STRESS) {
  V._resetVisualGroundForTest();
  R._resetTerrainRoundHeightsForTest(); // no neighbours: bake == statics recompute
  const pos = V.facetPositionsF32(ridge, LBX, LBY, f);
  const n = 8 * f + 1;
  const off = R.computeTerrainRoundOffsets(pos, n, f, LBX, LBY, cfg, null);
  V.noteVisualGroundBake(LBX, LBY, ridge, f, off, { canSubdivide: true, subdivLevel: 2 * f, roundMinLevel: 1 });
  // Probe = the subdivided vertex with the largest fillet, nudged 0.3 m
  // north into its sub-quad (a point BETWEEN vertices, still large).
  let best = 0;
  for (let v = 0; v < off.length; v += 1) if (Math.abs(off[v]) > Math.abs(off[best])) best = v;
  const i = Math.floor(best / n), j = best % n;
  const lx = (i * 24) / f, ly = Math.min(191, (j * 24) / f + 0.3);
  return { off, lx, ly, X: LBX * 192 + lx, Y: LBY * 192 + ly };
}
class FakeObject3D {
  constructor() { this.position = { x: 0, y: 0, z: 0 }; this.matrix = { elements: new Float64Array(16) }; this.userData = {}; this.parent = null; }
  updateMatrix() { const e = this.matrix.elements; e.fill(0); e[0] = e[5] = e[10] = e[15] = 1; e[12] = this.position.x; e[13] = this.position.y; e[14] = this.position.z; }
}
class FakeGroup extends FakeObject3D {}
function makeInst(guid, x, y, z, extra = {}) {
  const root = new FakeGroup();
  root.position.x = x; root.position.y = y; root.position.z = z;
  const inst = { guid, root, meta: { name: "test" }, _vg: null, _outdoorCellIdx: 0x0021, ...extra };
  V.installVisualGroundRoot(inst);
  return inst;
}
const drawnZ = (inst) => { inst.root.updateMatrix(); return inst.root.matrix.elements[14]; };
{
  const { X, Y } = bakeRidge();
  const delta = V.visualGroundDeltaAt(X, Y);
  const ground = V.physicsGroundZAt(X, Y);
  check(`ridge probe has a visible delta (${delta.toFixed(3)} m) and a retail ground`, Math.abs(delta) > 0.05 && Number.isFinite(ground));
  const handle = { calls: 0, state: 0x408, objectPhysicsState(g) { this.calls += 1; return this.state; } };
  V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0x50000001 });

  const a = makeInst(0x80000001, X, Y, ground);
  const z0 = a.root.position.z;
  const dz = drawnZ(a) - z0;
  check("standing creature: drawn root Z = physics Z + delta (feet on the drawn ground)", Math.abs(dz - delta) < 1e-12, `${dz} vs ${delta}`);
  check("root.position is never written (physics/picking/targeting read it)", a.root.position.z === z0 && a.root.position.x === X);
  check("why = APPLIED", a._vg.why === V.VG_WHY.APPLIED);
  check("feet gap without step 3 would be -delta", Math.abs((z0 - (ground + delta)) + delta) < 1e-12);

  const before = handle.calls;
  drawnZ(a); drawnZ(a); drawnZ(a);
  check("memo: several matrix walks in one frame -> no recompute, no extra PhysicsState read", handle.calls === before);
  a.root.position.x += 0.5;
  drawnZ(a);
  check("moving recomputes the delta at the new point", Math.abs(a._vg.dz - V.visualGroundDeltaAt(X + 0.5, Y)) < 1e-12);

  const indoor = makeInst(0x80000002, X, Y, ground, { _wireCellIdx: 0x0105 });
  check("indoor (EnvCell 0x0105 from the last KIND_POSITION) -> 0", drawnZ(indoor) === ground && indoor._vg.why === V.VG_WHY.INDOOR);
  const spawnIndoor = makeInst(0x80000003, X, Y, ground, { _outdoorCellIdx: 0x0110 });
  check("indoor by spawn cell -> 0", drawnZ(spawnIndoor) === ground);
  const walkedOut = makeInst(0x80000004, X, Y, ground, { _outdoorCellIdx: 0x0110, _wireCellIdx: 0x0021 });
  check("wire cell wins over a stale spawn cell (walked out of a cottage) -> applied", Math.abs(drawnZ(walkedOut) - ground - delta) < 1e-12);

  const held = makeInst(0x80000005, X, Y, ground, { _attachedParentGuid: 0x50000001 });
  check("attached (held weapon) -> 0 (it follows the wielder's drawn hand)", drawnZ(held) === ground && held._vg.why === V.VG_WHY.ATTACHED);
  const mounted = makeInst(0x80000006, X, Y, ground);
  mounted.root.userData.__attachedChildOf = 0x50000001;
  check("attached by mount brand -> 0", drawnZ(mounted) === ground);

  const bolt = makeInst(0x80000007, X, Y, ground, { _ballistic: true });
  check("missile in flight -> 0", drawnZ(bolt) === ground && bolt._vg.why === V.VG_WHY.MISSILE);

  handle.state = 0x18; // a door: ReportCollisions|IgnoreCollisions, no GRAVITY
  const door = makeInst(0x80000008, X, Y, ground);
  check("no PhysicsState GRAVITY (door / fixed weenie) -> 0", drawnZ(door) === ground && door._vg.why === V.VG_WHY.NO_GRAVITY);
  handle.state = 0;
  const unknown = makeInst(0x80000009, X, Y, ground);
  check("PhysicsState 0 = GUID unknown to wasm -> treated as grounded", Math.abs(drawnZ(unknown) - ground - delta) < 1e-12);
  handle.state = 0x408;

  const apex = makeInst(0x8000000a, X, Y, ground + 2.0);
  check("2 m above the retail ground (jump apex / bridge) -> 0", drawnZ(apex) === ground + 2.0 && apex._vg.why === V.VG_WHY.ELEVATED);
  const mid = makeInst(0x8000000b, X, Y, ground + 0.625);
  const mdz = drawnZ(mid) - (ground + 0.625);
  check("0.625 m up -> half the delta (smooth taper: no pop at take-off / landing)", Math.abs(mdz - 0.5 * delta) < 1e-9, `${mdz}`);
  const low = makeInst(0x8000000c, X, Y, ground + 0.1);
  check("0.1 m up (sphere rest / low step) -> full delta", Math.abs(drawnZ(low) - (ground + 0.1) - delta) < 1e-12);
  const sunk = makeInst(0x8000000d, X, Y, ground - 0.4);
  check("sunk below the ground -> full delta (follows the terrain)", Math.abs(drawnZ(sunk) - (ground - 0.4) - delta) < 1e-12);

  handle.state = 0x18;
  const me = makeInst(0x50000001, X, Y, ground);
  const meCalls = handle.calls;
  check("local player: applied, PhysicsState never queried", Math.abs(drawnZ(me) - ground - delta) < 1e-12 && handle.calls === meCalls);
  V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0x50000001, localIndoor: true });
  me.root.position.y += 0.01;
  check("local player indoors (live pose cell) -> 0", drawnZ(me) === ground && me._vg.why === V.VG_WHY.INDOOR);
  handle.state = 0x408;
  V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0x50000001 });

  const far = makeInst(0x8000000e, (LBX + 3) * 192 + 10, LBY * 192 + 10, 30);
  check("LB with no drawn fillet record -> 0", drawnZ(far) === 30 && far._vg.why === V.VG_WHY.NO_FILLET);
  V.noteVisualGroundBake(LBX, LBY, ridge, 1, null, null);
  a.root.position.x -= 0.5;
  check("LB re-baked at factor 1 (LOD drop) -> 0 next frame", drawnZ(a) === a.root.position.z && a._vg.why === V.VG_WHY.NO_FILLET);

  // PhysicsState refresh window: a re-read happens only after the window.
  bakeRidge();
  handle.calls = 0;
  V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0 });
  const r = makeInst(0x80000010, X, Y, ground);
  drawnZ(r);
  const first = handle.calls;
  for (let fr = 0; fr < 10; fr += 1) { V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0 }); drawnZ(r); }
  check("standing still: one PhysicsState read per 30-frame window (not per frame)", first === 1 && handle.calls === 1, `${first}/${handle.calls}`);
  for (let fr = 0; fr < 30; fr += 1) { V._setFrameInputsForTest({ sessionHandle: handle, localGuid: 0 }); drawnZ(r); }
  check("...and re-read after the window (a SetState that drops GRAVITY is honoured)", handle.calls === 2, `${handle.calls}`);

  V._setVisualGroundEnabledForTest(false);
  const offInst = makeInst(0x80000011, X, Y, ground);
  check("module off -> no override installed, root untouched", offInst._vg === null && !Object.prototype.hasOwnProperty.call(offInst.root, "updateMatrix") && drawnZ(offInst) === ground);
  V._setVisualGroundEnabledForTest(true);
  const stub = { guid: 1, root: { position: { x: 0, y: 0, z: 0 } }, _vg: null };
  check("three stub root (no updateMatrix/matrix) -> install is a no-op", V.installVisualGroundRoot(stub) === false && stub._vg === null);
  check("double install is a no-op", V.installVisualGroundRoot(a) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. statics (baked into the placement z) --");
{
  const { off: off8, lx, ly } = bakeRidge(4, CFG); // drawn now at x4 with the session (default) config
  const level8 = { terrainOpts: { canSubdivide: true, subdivLevel: 8, roundMinLevel: 1 } }; // object level 4
  const lbId = ((LBX << 24) | (LBY << 16)) >>> 0;
  const ground = V.physicsGroundZAt(LBX * 192 + lx, LBY * 192 + ly);
  const expect = V.visualGroundDeltaAt(LBX * 192 + lx, LBY * 192 + ly);
  check("default-cap ridge delta is nonzero at the probe (gentle ridge, 8 cm cap, x4)", off8 && Math.abs(expect) > 1e-3, `${expect}`);
  const mk = () => [
    { landblockId: lbId, x: lx, y: ly, z: ground, modelId: 0x02000001, source: "scenery" },
    { landblockId: lbId | 0xfffe, x: lx, y: ly, z: ground + 3, modelId: 0x02000002, source: "landblockinfo" }, // on a wall
    { landblockId: lbId, x: 0, y: 0, z: ridge[0], modelId: 0x02000003, source: "scenery" },                 // retail vertex
  ];
  let ps = mk();
  const moved = await V.applyVisualGroundToPlacements(ps, level8, {});
  check("ground-standing placement: z += delta at the near-player factor", moved === 1 && Math.abs(ps[0].z - (ground + expect)) < 1e-12);
  check("elevated placement (3 m up, e.g. a wall lamp) keeps its z", ps[1].z === ground + 3);
  check("placement on a retail vertex keeps its exact z", ps[2].z === ridge[0]);
  // LB currently drawn coarse (factor 1): statics still bake the x4 field.
  V.noteVisualGroundBake(LBX, LBY, ridge, 1, null, null);
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, level8, {});
  check("LB drawn at factor 1 right now -> statics still get the near-player x4 field", Math.abs(ps[0].z - (ground + expect)) < 1e-12);
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, { ...level8, wireframeMode: true }, {});
  check("wireframe -> untouched", ps[0].z === ground);
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, { terrainOpts: { canSubdivide: true, subdivLevel: 2, roundMinLevel: 1 } }, {});
  check("quality mid (near factor 1 draws no fillet) -> untouched", ps[0].z === ground);
  V._setVisualGroundEnabledForTest(false);
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, level8, {});
  V._setVisualGroundEnabledForTest(true);
  check("?terrainRoundObjects=off -> untouched", ps[0].z === ground);
  // Terrain not baked yet: heights fetched through the wasm export, freed.
  // Neighbours are ocean here (the export rejects them) -> none, like the bake.
  V._resetVisualGroundForTest();
  let freed = 0, asked = [];
  const centre = (lbId | 0xffff) >>> 0;
  const wasm = {
    fetch_subdivided_landblocks() {},
    async fetch_landblock_heightmaps(ids, urgent) {
      asked.push([ids[0] >>> 0, urgent]);
      if ((ids[0] >>> 0) !== centre) throw new Error("CellLandblock missing");
      return [{ heights: Float32Array.from(ridge), free() { freed += 1; } }];
    },
  };
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, level8, wasm, true);
  check("terrain not baked yet: own heights fetched (cell 0xXXYYFFFF, urgent lane) and freed; 4 edge neighbours tried",
    asked.length === 5 && asked[0][0] === centre && asked.every((a) => a[1] === true) && freed === 1, JSON.stringify(asked));
  check("...and the placement still lands on the drawn x4 ground", Math.abs(ps[0].z - (ground + expect)) < 1e-12, `${ps[0].z - ground} vs ${expect}`);
  // Neighbours that DO exist are fetched and shape the edge slopes exactly
  // as a bake that has seen them (the steady state near the player).
  V._resetVisualGroundForTest();
  const nbH = Float32Array.from(ridge, (z) => z + 4);
  const wasmNb = {
    fetch_subdivided_landblocks() {},
    async fetch_landblock_heightmaps(ids) { return [{ heights: (ids[0] >>> 0) === centre ? Float32Array.from(ridge) : nbH, free() {} }]; },
  };
  const edge = [{ landblockId: lbId, x: 5.0, y: 101.0, z: 0, modelId: 1, source: "scenery" }];
  const edgeGround = V.retailGroundZ(ridge, LBX, LBY, 5.0, 101.0);
  edge[0].z = edgeGround;
  await V.applyVisualGroundToPlacements(edge, level8, wasmNb);
  const offNb = R.computeTerrainRoundOffsets(V.facetPositionsF32(ridge, LBX, LBY, 4), 33, 4, LBX, LBY, CFG,
    { east: nbH, west: nbH, north: nbH, south: nbH });
  const offNo = R.computeTerrainRoundOffsets(V.facetPositionsF32(ridge, LBX, LBY, 4), 33, 4, LBX, LBY, CFG, null);
  const wantNb = V.filletOffsetAt(offNb, 4, 33, LBX, LBY, 5.0, 101.0);
  const wantNo = V.filletOffsetAt(offNo, 4, 33, LBX, LBY, 5.0, 101.0);
  check(`statics field uses the fetched edge neighbours (edge cell: ${wantNb.toFixed(4)} m with, ${wantNo.toFixed(4)} m without)`,
    Math.abs(edge[0].z - (edgeGround + wantNb)) < 1e-12 && wantNb !== wantNo, `${edge[0].z - edgeGround}`);
  // Ring opts not resolved yet (login race): the quality preset decides.
  V._resetVisualGroundForTest();
  ps = mk();
  await V.applyVisualGroundToPlacements(ps, { quality: { flags: { subdivLevel: 8 } } }, wasm);
  check("no terrain opts yet: quality ultra + subdivision export -> x4 field", Math.abs(ps[0].z - (ground + expect)) < 1e-12);
  ps = mk();
  const none = await V.applyVisualGroundToPlacements(ps, {}, {});
  check("no opts, no quality -> untouched (counted, never throws)", none === 0 && ps[0].z === ground);
  const bad = await V.applyVisualGroundToPlacements([{ landblockId: lbId, x: NaN, y: 1, z: 1 }, null], level8, {});
  check("junk placements tolerated", bad === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. wiring --");
{
  const t = src("scene3d/terrain.js");
  const e = src("scene3d/entities.js");
  const s = src("scene3d/statics.js");
  check("terrain.js publishes the uploaded aRoundZ right after attaching the LB",
    t.includes('import { noteVisualGroundBake } from "./visual_ground.js";')
    && /scene3d\.terrainGroup\.add\(lbMesh\);\n(?:\s*\/\/.*\n)+\s*noteVisualGroundBake\(lbX, lbY, lbMesh\.userData\.heights, effectiveSubdiv,\n\s*geom\.getAttribute\("aRoundZ"\)\?\.array \?\? null, opts\);/.test(t));
  check("terrain.js aRoundZ is the computeTerrainRoundOffsets array (same object)",
    t.includes('geom.setAttribute("aRoundZ", new THREE.BufferAttribute(roundOff, 1, false));'));
  check("entities.js: one import line, install in the EntityInstance constructor, begin-frame at the top of tick",
    e.includes('import { installVisualGroundRoot, visualGroundBeginFrame } from "./visual_ground.js";')
    && /this\._vg = null;\n\s*installVisualGroundRoot\(this\);\n\s*\}/.test(e)
    && /\n  tick\(dt\) \{\n(?:\s*\/\/.*\n)+\s*visualGroundBeginFrame\(this\.scene3d\);/.test(e));
  check("entities.js never writes the offset into root.position", !/position\.z\s*\+=\s*.*(dz|groundDz|visualGround)/i.test(e));
  check("statics.js bakes the placement z BEFORE the anim/wind peels, both bake paths",
    (s.match(/if \(visualGroundEnabled\(\)\) await applyVisualGroundToPlacements\(statics, scene3d, wasmExports, (urgent|false)\);\n(?:\s*\/\/.*\n)*\s*let animatedStatics = null;/g) || []).length === 2);
  check("statics.js import is single-line (import-stripping suites)", /^import \{ applyVisualGroundToPlacements, visualGroundEnabled \} from "\.\/visual_ground\.js";$/m.test(s));
  check("ragdoll sim stays in the PHYSICS frame (root.position, not the matrix)",
    src("scene3d/ragdoll.js").includes("setSimRoot(sim, root.position, root.quaternion, root.scale);"));
  check("picking distances stay on the physics root", /function entityAcPosition\(entityManager, guid\) \{[\s\S]{0,200}const p = inst\.root\.position;/.test(src("scene3d/picking.js")));
  check("no applyMatrix4/attach on entity roots (would decompose dz into position)",
    !/root\.applyMatrix4\(|\.attach\(\s*(?:inst|c|p)\.root\)/.test(e));
  const flags = src("docs/url-flags.md");
  check("url-flags.md row for terrainRoundObjects", flags.includes("| `terrainRoundObjects` |"));
  const vg = src("scene3d/visual_ground.js");
  check("reader uses .get(\"terrainRoundObjects\") (lint-url-flags)", vg.includes('.get("terrainRoundObjects")'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
