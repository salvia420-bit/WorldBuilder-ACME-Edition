// 2026-10-19 — terrain water FLOW + BANKED SWELL test (scene3d/terrain_water_flow.js).
//
// Run with:
//   cd apps/holtburger-web && node test_terrain_water_flow.mjs
// (needs the three stub that test_terrain_palette.mjs generates.)
//
// Locks:
//  1. FLAGS — ?waterFlow / ?waterBank default ON with off|0|false|no escapes;
//     the numeric knobs clamp; the vertex-types texture is 36 wide when either
//     is on and keeps its old width when both are off.
//  2. BANKED SWELL (JS mirrors of the GLSL, on REAL Marae Lassel terrain,
//     fixtures/terrain/marae_dams.json from the base DATs):
//     - weights: 0 on land and beside a drop, 255 in open water; an edge
//       vertex reads along its edge only, so both landblocks agree;
//     - the dam decks: the drawn terrain under East Fork's north end and West
//       Fork's south end never rises above the 82.000 m walkway at any time
//       or subdivision factor (the old per-vertex gate measurably did);
//     - crack-free: at factor 2 / 4 every fine vertex on every cell edge lands
//       on the coarse chord, shorelines included (the old nearest-code gate
//       opened ~0.125 m there).
//  3. DATA — the column writer (layout, full rewrite of a pooled texture), the
//     table parser (round trip, every structural rejection), and the shipped
//     data/water_flow.bin itself (structure, seams, checkpoint directions).
//  4. ASSEMBLED GLSL (terrain.js resolved for the default session): every
//     splice present and ordered, helpers defined before use, delimiters
//     balanced, no new fragment sampler, the vertex stage's one sampler; the
//     REAL batched derivation (terrain_batch.js _buildBatchedGlsl) succeeds
//     and leaves no per-LB fetch behind; terrain_batch's inlined anchors ==
//     the module's exports; the far-terrain bake rig switches both off.
//  5. FLAG VARIANTS — a child process per URL re-assembles terrain.js: each
//     escape compiles its own well-formed program, and both off compiles none
//     of this module's code.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const VI = process.argv.indexOf("--variant");
const VARIANT = VI >= 0 ? (process.argv[VI + 1] ?? "") : null;
if (VARIANT !== null) {
  globalThis.window = { location: { search: VARIANT }, addEventListener() {}, removeEventListener() {} };
}
const W = await import("./scene3d/terrain_water_flow.js");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const stripC = (g) => g.replace(/\/\/[^\n]*/g, "");
const balanced = (code) => [["{", "}"], ["(", ")"], ["[", "]"]].every(([o, c]) => {
  let d = 0;
  for (const ch of code) { if (ch === o) d += 1; else if (ch === c) { d -= 1; if (d < 0) return false; } }
  return d === 0;
});
const samplerNames = (code) => [...code.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?sampler\w+\s+(\w+)\s*;/g)].map((m) => m[1]);
// Hand-labelled downstream directions at named places (tools/water-flow/README.md).
// d = { e, n } biased-byte offsets (east / north, +-127 = full scale), foam 0..255;
// null = the landblock is absent from the table. Arcs in degrees (0 = east,
// 90 = north); two sit on a sector boundary, so they take two sectors.
const ang = (d) => (Math.atan2(d.n, d.e) * 180) / Math.PI;
const arc = (lo, hi) => (d) => d !== null && (d.e !== 0 || d.n !== 0) && ang(d) >= lo - 1e-9 && ang(d) <= hi + 1e-9;
const foamAtLeast = (f, test) => (d) => test(d) && d.foam >= f;
const WATER_FLOW_CHECKPOINTS = [
  { name: "north river mid-stretch", lb: 0xa9b6, x: 4, y: 4, want: "E or SE", ok: arc(-67.5, 22.5) },
  { name: "north river 100 m above Cragstone Falls", lb: 0xb5a4, x: 3, y: 2, want: "E or SE", ok: arc(-67.5, 22.5) },
  { name: "Cragstone west face lip", lb: 0xb6a3, x: 0, y: 3, want: "E, foam >= 200", ok: foamAtLeast(200, arc(-22.5, 22.5)) },
  { name: "Cragstone north face lip", lb: 0xb6a3, x: 4, y: 8, want: "S, foam >= 200", ok: foamAtLeast(200, arc(-112.5, -67.5)) },
  { name: "Cragstone plunge pool", lb: 0xb6a3, x: 3, y: 2, want: "away from the foot, foam >= 100",
    ok: (d) => d !== null && 2 * d.e - d.n > 0 && d.foam >= 100 },
  { name: "Cragstone lake", lb: 0xbf9c, x: 2, y: 2, want: "slow, toward the south outlet",
    ok: (d) => d !== null && 79 * d.e - 119 * d.n > 0 && Math.hypot(d.e, d.n) <= 16 },
  { name: "south river below the lake (flows AWAY from it)", lb: 0xca89, x: 4, y: 4, want: "S or SE", ok: arc(-112.5, -22.5) },
  { name: "south river lower reach", lb: 0xce7a, x: 1, y: 4, want: "W or SW",
    ok: (d) => d !== null && (arc(-180, -112.5)(d) || arc(157.5, 180)(d)) },
  { name: "Marae Lassel main fall lip (0x1DB4)", lb: 0x1db4, x: 1, y: 2, want: "S, foam >= 200", ok: foamAtLeast(200, arc(-112.5, -67.5)) },
  { name: "Marae Lassel plunge pool", lb: 0x1db4, x: 1, y: 0, want: "away from the foot (south), foam >= 100",
    ok: (d) => d !== null && d.n < 0 && d.foam >= 100 },
  { name: "Blue Ghost Falls upper pool", lb: 0xe43d, x: 1, y: 6, want: "toward the lower pool",
    ok: (d) => d !== null && 2 * d.e - 5 * d.n > 0 },
  { name: "Blue Ghost Falls lower pool", lb: 0xe43d, x: 5, y: 0, want: "away from the foot, foam >= 60",
    ok: (d) => d !== null && 2 * d.e - 2 * d.n > 0 && d.foam >= 60 },
  { name: "still side pond, north river upper reach", lb: 0x9cc2, x: 1, y: 5, want: "still (128, 128)",
    ok: (d) => d !== null && d.e === 0 && d.n === 0 },
  { name: "south-east river mouth", lb: 0xe650, x: 5, y: 2, want: "E, NE or SE", ok: arc(-67.5, 67.5) },
  { name: "open ocean", lb: 0xfa40, x: 4, y: 4, want: "landblock absent (still)", ok: (d) => d === null },
];

const STUB_LOADER = resolvePath(__dirname, "_three_stub_palette_loader.mjs");
if (!existsSync(STUB_LOADER)) {
  console.error(`[setup] missing ${STUB_LOADER}; run test_terrain_palette.mjs once first.`);
  process.exit(2);
}

if (VARIANT !== null) {
  // ---- child: one flag variant ----
  register(pathToFileURL(STUB_LOADER).href, import.meta.url);
  const T = await import(pathToFileURL(resolvePath(__dirname, "scene3d/terrain.js")).href);
  const { vertex, fragment } = T._terrainGlslForTest();
  const v = stripC(vertex), f = stripC(fragment);
  const C = W.WATER_FLOW;
  const tag = `[${VARIANT || "default"}]`;
  check(`${tag} both stages balanced`, balanced(v) && balanced(f));
  check(`${tag} 16 fragment sampler declarations (no new unit)`, samplerNames(f).length === 16);
  check(`${tag} bank=${C.bank}: vertex sampler + banked swell iff on`,
    C.bank === v.includes("uniform highp sampler2D uVertexTypes;")
    && C.bank === v.includes("appliedSwell = waterSwellBanked(position.xy, worldXy);")
    && C.bank !== v.includes("appliedSwell = waterSwellLattice(worldXy);"));
  check(`${tag} vertex samplers: ${C.bank ? "uVertexTypes only" : "none"}`,
    JSON.stringify(samplerNames(v)) === JSON.stringify(C.bank ? ["uVertexTypes"] : []));
  check(`${tag} flow=${C.flow}: flow uniforms, helpers, main block, taps, foam iff on`,
    C.flow === f.includes("uniform vec4 uWaterFlow;") && C.flow === f.includes("vec2 waterFlowAt(int x, int y)")
    && C.flow === f.includes("waterPhaseW = 1.0 - abs(2.0 * ph0 - 1.0);")
    && C.flow === f.includes("merged = mix(terrainAtlasTex(clamp(baseLayer, 0, 32), waterCellUvB).rgb, merged, waterPhaseW);")
    && C.flow === f.includes("float foamAmt = clamp(")
    && C.flow === f.includes("mix(waterRippleSlope(gp - waterOffB), waterRippleSlope(gp - waterOffA), waterPhaseW)"));
  check(`${tag} the ripple helper is always compiled and always called`,
    f.includes("vec2 waterRippleSlope(vec2 gp) {") && /vec2 slope = [^;]*waterRippleSlope\(/.test(f));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
console.log("-- 1. flags --");
{
  const d = W.readWaterFlowConfig("");
  check("defaults: flow + bank ON, documented numbers",
    d.flow && d.bank && d.speed === 1.2 && d.period === 1.6 && d.still === 0.35 && d.foam === 1);
  check("defaults frozen", Object.isFrozen(W.WATER_FLOW_DEFAULTS));
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    const c = W.readWaterFlowConfig(`?waterFlow=${v}&waterBank=${v}`);
    check(`escape '${v}' disables both`, !c.flow && !c.bank);
  }
  check("anything else keeps them on", W.readWaterFlowConfig("?waterFlow=on&waterBank=1").flow
    && W.readWaterFlowConfig("?waterFlow=on&waterBank=1").bank);
  const k = W.readWaterFlowConfig("?waterFlowSpeed=9&waterFlowPeriod=0.1&waterStill=off&waterFoam=x");
  check("knobs clamp / off = floor / junk = default", k.speed === 4 && k.period === 0.5 && k.still === 0 && k.foam === 1);
  const on = { flow: true, bank: false }, off = { flow: false, bank: false };
  check("texture width: 36 when either is on, unchanged when both off",
    W.waterTypesCols(9, on) === 36 && W.waterTypesCols(18, { flow: false, bank: true }) === 36
    && W.waterTypesCols(9, off) === 9 && W.waterTypesCols(18, off) === 18);
}

// ---------------------------------------------------------------------------
console.log("\n-- 2. banked swell --");
const FX = JSON.parse(readFileSync(resolvePath(__dirname, "fixtures/terrain/marae_dams.json"), "utf8"));
const SWELL_MASK = (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20); // terrain.js TERRAIN_WATER_CODES
const ZF = 0.0099999998; // terrain.js ZFIGHT_TERRAIN_ADJUST_M as compiled
// fixtures carry [gridX][gridY]; the wasm arrays are flat x*9+y
function flat(lb) {
  const codes = new Uint8Array(81), heights = new Float32Array(81);
  for (let x = 0; x < 9; x++) for (let y = 0; y < 9; y++) {
    codes[x * 9 + y] = lb.codes[x][y];
    heights[x * 9 + y] = lb.heights[x][y];
  }
  return { codes, heights, lbX: lb.lbX, lbY: lb.lbY };
}
const LB = Object.fromEntries(["0x1FBB", "0x1FBC", "0x1BBB", "0x1BBC"].map((k) => [k, flat(FX[k])]));
const weights = Object.fromEntries(Object.entries(LB).map(([k, l]) => [k, W.computeWaterBankWeights(l.codes, l.heights, SWELL_MASK)]));
{
  const wa = weights["0x1FBC"], wb = weights["0x1BBB"];
  check("East Fork N end: the reservoir corner beside the dam (0x1FBC v5,2) = 0", wa[5 * 9 + 2] === 0);
  check("West Fork S end: the reservoir corner on the north edge (0x1BBB v5,8) = 0", wb[5 * 9 + 8] === 0);
  check("open reservoir water keeps the swell (0x1FBC v6,1 = 255)", wa[6 * 9 + 1] === 255);
  check("land is 0 (0x1FBC v5,3 code 14)", wa[5 * 9 + 3] === 0);
  check("SeaSlime 23 is not swell water (0x1FBC v4,2)", wa[4 * 9 + 2] === 0);
  // Shared edge: 0x1FBB's north row (y = 8) is 0x1FBC's south row (y = 0).
  let seamOk = true;
  for (let x = 0; x < 9; x++) {
    if (weights["0x1FBB"][x * 9 + 8] !== weights["0x1FBC"][x * 9 + 0]) seamOk = false;
    if (weights["0x1BBB"][x * 9 + 8] !== weights["0x1BBC"][x * 9 + 0]) seamOk = false;
  }
  check("both landblocks compute the same weight on their shared edge", seamOk);
  // Synthetic: an edge vertex never looks across the edge; a corner only at itself.
  const codes = new Uint8Array(81).fill(17), heights = new Float32Array(81).fill(50);
  heights[1 * 9 + 0] = 10; // (1,0): lower, on the south edge
  heights[0 * 9 + 4] = 10; // (0,4): lower, on the west edge
  const w = W.computeWaterBankWeights(codes, heights, SWELL_MASK);
  check("drop along the edge zeroes the edge neighbours ((0,0) corner stays 255)",
    w[0 * 9 + 0] === 255 && w[2 * 9 + 0] === 0 && w[0 * 9 + 3] === 0 && w[0 * 9 + 5] === 0);
  check("an interior vertex beside a lower edge vertex is 0, one further in is 255",
    w[1 * 9 + 1] === 0 && w[2 * 9 + 2] === 255);
  check("an edge vertex ignores an inward drop", (() => {
    const h = new Float32Array(81).fill(50); h[4 * 9 + 1] = 10;
    return W.computeWaterBankWeights(codes, h, SWELL_MASK)[4 * 9 + 0] === 255;
  })());
  check("no heights = plain water weight", W.computeWaterBankWeights(codes, null, SWELL_MASK)[40] === 255);
}

// JS mirrors of TERRAIN_VERTEX_GLSL waterSwellAt / waterSwellLattice and the
// module's waterSwellBanked; Rust subdivide_landblock's nearest-code rule.
const swellAt = (t, x, y) => Math.sin(t * 0.5 + x * 0.045) * 0.15 + Math.sin(t * 0.7 + y * 0.062) * 0.1;
function swellLattice(t, wx, wy) {
  const cx = Math.floor(wx / 24) * 24, cy = Math.floor(wy / 24) * 24, fx = (wx - cx) / 24, fy = (wy - cy) / 24;
  return (swellAt(t, cx, cy) * (1 - fx) + swellAt(t, cx + 24, cy) * fx) * (1 - fy)
    + (swellAt(t, cx, cy + 24) * (1 - fx) + swellAt(t, cx + 24, cy + 24) * fx) * fy;
}
function swellBanked(t, lx, ly, lb, w) {
  const gx = lx / 24, gy = ly / 24;
  const ix = Math.max(0, Math.min(7, Math.floor(gx))), iy = Math.max(0, Math.min(7, Math.floor(gy)));
  const fx = Math.max(0, Math.min(1, gx - ix)), fy = Math.max(0, Math.min(1, gy - iy));
  const k = (x, y) => w[x * 9 + y] / 255;
  const cx = lb.lbX * 192 + lx - fx * 24, cy = lb.lbY * 192 + ly - fy * 24;
  const s00 = swellAt(t, cx, cy) * k(ix, iy), s10 = swellAt(t, cx + 24, cy) * k(ix + 1, iy);
  const s01 = swellAt(t, cx, cy + 24) * k(ix, iy + 1), s11 = swellAt(t, cx + 24, cy + 24) * k(ix + 1, iy + 1);
  return (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy;
}
function swellLegacy(t, ii, jj, f, lb) { // per-vertex code gate, nearest control-grid code
  const code = lb.codes[Math.min(Math.round(ii / f), 8) * 9 + Math.min(Math.round(jj / f), 8)];
  return ((SWELL_MASK >>> code) & 1) ? swellLattice(t, lb.lbX * 192 + (ii * 24) / f, lb.lbY * 192 + (jj * 24) / f) : 0;
}
function cut(gx, gy) { // retail CLandBlockStruct split, u32 wrap (terrain_subdiv.rs cell_swto_ne_cut)
  const inner = (Math.imul(214614067, gx) + 1813693831) >>> 0;
  const v8 = (Math.imul(gy, inner) - Math.imul(1109124029, gx) - 1369149221) >>> 0;
  return v8 * 2.3283064e-10 >= 0.5;
}
function triInterp(z00, z10, z01, z11, fx, fy, c) {
  if (c) return fx >= fy ? z00 + (z10 - z00) * fx + (z11 - z10) * fy : z00 + (z11 - z01) * fx + (z01 - z00) * fy;
  return fx + fy <= 1 ? z00 + (z10 - z00) * fx + (z01 - z00) * fy : z11 + (z01 - z11) * (1 - fx) + (z10 - z11) * (1 - fy);
}
// The drawn surface of one LB at (lx, ly) for subdivision factor f: retail base
// height + the vertex displacement interpolated over the fine cell's triangle.
function drawn(lbKey, lx, ly, f, t, banked) {
  const lb = LB[lbKey], w = weights[lbKey], H = (x, y) => lb.heights[x * 9 + y];
  const st = 24 / f;
  const i = Math.min(Math.floor(lx / st), 8 * f - 1), j = Math.min(Math.floor(ly / st), 8 * f - 1);
  const fx = lx / st - i, fy = ly / st - j, cu = Math.floor(i / f), cv = Math.floor(j / f);
  const c = cut(lb.lbX * 8 + cu, lb.lbY * 8 + cv);
  const base = triInterp(H(cu, cv), H(cu + 1, cv), H(cu, cv + 1), H(cu + 1, cv + 1), lx / 24 - cu, ly / 24 - cv, c);
  const d = (ii, jj) => (banked ? swellBanked(t, ii * st, jj * st, lb, w) : swellLegacy(t, ii, jj, f, lb));
  return base + triInterp(d(i, j), d(i + 1, j), d(i, j + 1), d(i + 1, j + 1), fx, fy, c) - ZF;
}
{
  const decks = [
    { lb: "0x1FBC", cell: [4, 2], inside: (a, b) => a + b > 1.02, name: "East Fork N end (0x1FBC cell 4,2)" },
    { lb: "0x1BBB", cell: [5, 7], inside: (a, b) => a + b < 0.98, name: "West Fork S end (0x1BBB cell 5,7)" },
  ];
  for (const dk of decks) {
    let worstNew = -1e9, worstOld = -1e9;
    for (const f of [1, 2, 4]) for (let t = 0; t < 120; t += 0.37)
      for (let a = 0.02; a < 1; a += 0.06) for (let b = 0.02; b < 1; b += 0.06) {
        if (!dk.inside(a, b)) continue;
        const lx = (dk.cell[0] + a) * 24, ly = (dk.cell[1] + b) * 24;
        worstNew = Math.max(worstNew, drawn(dk.lb, lx, ly, f, t, true) - 82.0);
        worstOld = Math.max(worstOld, drawn(dk.lb, lx, ly, f, t, false) - 82.0);
      }
    check(`${dk.name}: banked swell keeps the terrain under the 82.000 m deck`, worstNew <= 1e-6, `max ${worstNew.toFixed(4)} m`);
    check(`${dk.name}: the old per-vertex gate poked through (regression premise)`, worstOld > 0.1, `max ${worstOld.toFixed(3)} m`);
  }
  // Crack test over every cell edge of both dam landblocks, shorelines included.
  let newCrack = 0, oldCrack = 0;
  for (const key of ["0x1FBC", "0x1BBB"]) {
    const lb = LB[key], w = weights[key];
    for (const t of [0, 1.7, 13.25, 60, 601.5]) {
      for (const f of [2, 4]) {
        for (let a = 0; a <= 8; a++) for (let b = 0; b < 8; b++) {
          for (const horiz of [true, false]) {
            // edge from lattice (x0,y0) to (x1,y1)
            const x0 = horiz ? b : a, y0 = horiz ? a : b, x1 = horiz ? b + 1 : a, y1 = horiz ? a : b + 1;
            const e0n = swellBanked(t, x0 * 24, y0 * 24, lb, w), e1n = swellBanked(t, x1 * 24, y1 * 24, lb, w);
            const e0o = swellLegacy(t, x0, y0, 1, lb), e1o = swellLegacy(t, x1, y1, 1, lb);
            for (let k = 1; k < f; k++) {
              const s = k / f;
              const lx = (x0 + (x1 - x0) * s) * 24, ly = (y0 + (y1 - y0) * s) * 24;
              newCrack = Math.max(newCrack, Math.abs(swellBanked(t, lx, ly, lb, w) - (e0n * (1 - s) + e1n * s)));
              const ii = Math.round((x0 + (x1 - x0) * s) * f), jj = Math.round((y0 + (y1 - y0) * s) * f);
              oldCrack = Math.max(oldCrack, Math.abs(swellLegacy(t, ii, jj, f, lb) - (e0o * (1 - s) + e1o * s)));
            }
          }
        }
      }
    }
  }
  check("banked swell: every fine vertex lands on the coarse chord (crack ~ 0), shores included",
    newCrack < 1e-9, `maxGap=${newCrack.toExponential(2)} m`);
  check("the old nearest-code gate cracked at water/land edges (regression premise)",
    oldCrack > 0.05, `maxGap=${oldCrack.toFixed(3)} m`);
  // Seam: both landblocks evaluate the same swell on their shared edge.
  let seamGap = 0;
  for (const t of [0.5, 9.25, 77]) for (let x = 0; x <= 192; x += 6) {
    seamGap = Math.max(seamGap, Math.abs(swellBanked(t, x, 192, LB["0x1FBB"], weights["0x1FBB"])
      - swellBanked(t, x, 0, LB["0x1FBC"], weights["0x1FBC"])));
  }
  check("landblock seam: identical swell on both sides", seamGap < 1e-9, `maxGap=${seamGap.toExponential(2)} m`);
}

// ---------------------------------------------------------------------------
console.log("\n-- 3. data --");
{
  // Column writer: layout + full rewrite.
  const cols = 36;
  const bytes = new Uint8Array(cols * 9 * 4).fill(0xaa);
  const entry = new Uint8Array(243);
  for (let i = 0; i < 81; i++) { entry[i * 3] = 128 + (i % 50); entry[i * 3 + 1] = 100; entry[i * 3 + 2] = i; }
  const bank = new Uint8Array(81).map((_, i) => (i % 2 ? 255 : 0));
  check("writer refuses a narrow texture", W.writeWaterColumns(new Uint8Array(18 * 9 * 4), 18, entry, bank) === false);
  W.writeWaterColumns(bytes, cols, entry, bank);
  let ok = true;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const i = x * 9 + y, f = (y * cols + 18 + x) * 4, a = (y * cols + 27 + x) * 4;
    if (bytes[f] !== entry[i * 3] || bytes[f + 1] !== entry[i * 3 + 1] || bytes[f + 2] !== 0 || bytes[f + 3] !== 255) ok = false;
    if (bytes[a] !== bank[i] || bytes[a + 1] !== entry[i * 3 + 2] || bytes[a + 2] !== 0 || bytes[a + 3] !== 255) ok = false;
    for (let c = 0; c < 18; c++) if (bytes[(y * cols + c) * 4] !== 0xaa) ok = false;
  }
  check("texel (18 + x, y) = flow of vertex (x, y); (27 + x, y) = (weight, foam); columns 0..17 untouched", ok);
  W.writeWaterColumns(bytes, cols, null, null);
  let still = true;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    const f = (y * cols + 18 + x) * 4, a = (y * cols + 27 + x) * 4;
    if (bytes[f] !== 128 || bytes[f + 1] !== 128 || bytes[a] !== 0 || bytes[a + 1] !== 0) still = false;
  }
  check("a null entry rewrites every byte to still / no foam / no swell (pooled reuse)", still);
  const [e, n] = W.decodeFlowBytes(128 + 127, 128 - 127, 4.0);
  check("decode: +-127 = +-full scale, 128 = still", e === 4 && n === -4 && W.decodeFlowBytes(128, 128, 4)[0] === 0);

  // Parser.
  function table(keys, fs = 4.0, mutate) {
    const dataOff = (16 + keys.length * 2 + 3) & ~3;
    const buf = new ArrayBuffer(dataOff + keys.length * 243);
    const dv = new DataView(buf);
    [0x48, 0x42, 0x57, 0x46].forEach((b, i) => dv.setUint8(i, b));
    dv.setUint16(4, 1, true); dv.setUint16(6, keys.length, true); dv.setFloat32(8, fs, true);
    keys.forEach((k, i) => dv.setUint16(16 + i * 2, k, true));
    keys.forEach((_, i) => new Uint8Array(buf, dataOff + i * 243, 243).fill(i + 1));
    if (mutate) mutate(dv);
    return buf;
  }
  const t = W.parseWaterFlowTable(table([0x1db4, 0x1dbb, 0xb6a3]));
  check("parser: round trip (count, scale, entry bytes by landblock)",
    t && t.count === 3 && t.fullScaleUnits === 4 && W.waterFlowEntry(t, 0x1dbb)[0] === 2
    && W.waterFlowEntry(t, 0xb6a3).length === 243 && W.waterFlowEntry(t, 0x1234) === null);
  check("parser: odd key count pads the index to 4 bytes", W.parseWaterFlowTable(table([1, 2])) !== null);
  check("parser rejects bad magic / version / unsorted keys / wrong length / zero scale",
    W.parseWaterFlowTable(table([1], 4, (dv) => dv.setUint8(0, 0))) === null
    && W.parseWaterFlowTable(table([1], 4, (dv) => dv.setUint16(4, 2, true))) === null
    && W.parseWaterFlowTable(table([2, 1])) === null
    && W.parseWaterFlowTable(table([1, 1])) === null
    && W.parseWaterFlowTable(table([1]).slice(0, 100)) === null
    && W.parseWaterFlowTable(table([1], 0)) === null);

  // The shipped table.
  const BIN = resolvePath(__dirname, "data/water_flow.bin");
  check("data/water_flow.bin is shipped", existsSync(BIN));
  if (existsSync(BIN)) {
    const raw = readFileSync(BIN);
    const real = W.parseWaterFlowTable(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    check("data/water_flow.bin parses", !!real, `${raw.length} bytes`);
    if (real) {
      check("it covers the moving water of the world (> 300 landblocks) at 4 units full scale",
        real.count > 300 && real.fullScaleUnits === 4, `count=${real.count}`);
      // Shared edges must be byte-identical in both landblocks (global-grid bake).
      let pairs = 0, bad = 0;
      for (const key of real.offsets.keys()) {
        const a = W.waterFlowEntry(real, key), x = key >> 8, y = key & 0xff;
        const east = W.waterFlowEntry(real, ((x + 1) << 8) | y), north = W.waterFlowEntry(real, (x << 8) | (y + 1));
        if (east) { pairs++; for (let j = 0; j < 9; j++) for (let c = 0; c < 3; c++) if (a[(8 * 9 + j) * 3 + c] !== east[(0 * 9 + j) * 3 + c]) bad++; }
        if (north) { pairs++; for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) if (a[(i * 9 + 8) * 3 + c] !== north[(i * 9 + 0) * 3 + c]) bad++; }
      }
      check(`shared landblock edges agree byte for byte (${pairs} neighbour pairs)`, pairs > 0 && bad === 0, `${bad} mismatched bytes`);
      // Checkpoints (tools/water-flow/README.md): downstream directions at named places.
      const dir = (key, x, y) => {
        const en = W.waterFlowEntry(real, key);
        if (!en) return null;
        const i = x * 9 + y;
        return { e: en[i * 3] - 128, n: en[i * 3 + 1] - 128, foam: en[i * 3 + 2] };
      };
      for (const cp of WATER_FLOW_CHECKPOINTS) {
        const d = dir(cp.lb, cp.x, cp.y);
        check(`checkpoint ${cp.name}: ${cp.want}`, cp.ok(d), JSON.stringify(d));
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 4. assembled GLSL --");
register(pathToFileURL(STUB_LOADER).href, import.meta.url);
const T = await import(pathToFileURL(resolvePath(__dirname, "scene3d/terrain.js")).href);
const { vertex: VERT, fragment: FRAG } = T._terrainGlslForTest();
const SRC = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
const BSRC = readFileSync(resolvePath(__dirname, "scene3d/terrain_batch.js"), "utf8");
const FAR = readFileSync(resolvePath(__dirname, "scene3d/far_terrain.js"), "utf8");
{
  const v = stripC(VERT), f = stripC(FRAG);
  const MODULE_GLSL = [W.WATER_BANK_VERTEX_DECL_GLSL, W.WATER_BANK_VERTEX_FN_GLSL, W.WATER_BANK_VERTEX_APPLY_GLSL,
    W.WATER_FLOW_FRAG_DECL_GLSL, W.WATER_FLOW_FRAG_GLSL, W.WATER_FLOW_MAIN_GLSL, W.WATER_FLOW_MERGE_BASE_GLSL,
    W.WATER_FLOW_MERGE_SLOT_GLSL, W.WATER_FLOW_BILINEAR_TAPS_GLSL, W.WATER_FOAM_APPLY_GLSL, W.WATER_FLOW_RIPPLE_SLOPE_GLSL];
  check("no backticks in any module GLSL", !MODULE_GLSL.some((g) => g.includes("`")));
  check("no module GLSL declares a FRAGMENT sampler",
    ![W.WATER_FLOW_FRAG_DECL_GLSL, W.WATER_FLOW_FRAG_GLSL, W.WATER_FLOW_MAIN_GLSL].some((g) => /\bsampler\w*\s+\w+\s*;/.test(stripC(g))));
  check("both stages balanced", balanced(v) && balanced(f));
  check("fragment keeps exactly 16 sampler declarations", samplerNames(f).length === 16, samplerNames(f).join(","));
  check("the vertex stage gains exactly one sampler (uVertexTypes, highp — matches the fragment's three.js default)",
    JSON.stringify(samplerNames(v)) === '["uVertexTypes"]' && v.includes("uniform highp sampler2D uVertexTypes;"));
  // Vertex order: decl before use; banked helper after waterSwellAt; apply after the gate, before the varyings.
  const iDecl = v.indexOf("uniform highp sampler2D uVertexTypes;");
  const iSwellAt = v.indexOf("float waterSwellAt(vec2 wxy)");
  const iBanked = v.indexOf("float waterSwellBanked(vec2 lxy, vec2 wxy)");
  const iMain = v.indexOf("void main()");
  const iGateZero = v.indexOf("appliedSwell = 0.0;");
  const iApply = v.indexOf("appliedSwell = waterSwellBanked(position.xy, worldXy);");
  const iVary = v.indexOf("vWaveModulation = vec2(waveModX, appliedSwell);");
  check("vertex: sampler < waterSwellAt < waterSwellBanked < main", iDecl > 0 && iDecl < iSwellAt && iSwellAt < iBanked && iBanked < iMain);
  check("vertex: the code gate adds 0 to water, then the banked swell on every vertex, before the varyings",
    iMain < iGateZero && iGateZero < iApply && iApply < iVary && v.includes("if (uDisplacementEnabled > 0.5) {\n    appliedSwell = waterSwellBanked("));
  // Fragment order.
  const at = (s) => f.indexOf(s);
  const iNoise = at("float fragValueNoise2D(vec2 p)");
  const iRipple = at("vec2 waterRippleSlope(vec2 gp) {");
  const iFlowAt = at("vec2 waterFlowAt(int x, int y) {");
  const iFMain = at("void main()");
  const iScroll = at("waterCellUv = fract(cellUv + vec2(uTime * 0.05, uTime * 0.02));");
  const iFlow = at("waterCellUv = fract(cellUv - waterOffA * (1.0 / 24.0));");
  const iUv00 = at("vec2 uv00 = wc00 ? waterCellUv : cellUv;");
  const iBase = at("merged = mix(terrainAtlasTex(clamp(baseLayer, 0, 32), waterCellUvB).rgb, merged, waterPhaseW);");
  const iSlot = at("overlayCol = mix(terrainAtlasTex(clamp(layer, 0, 32), waterCellUvB).rgb, overlayCol, waterPhaseW);");
  const iTint = at("result *= mix(vec3(1.0), tint, waterW);");
  const iFoam = at("float foamAmt = clamp(");
  const iSheen = at("vec2 slope = mix(waterRippleSlope(gp - waterOffB), waterRippleSlope(gp - waterOffA), waterPhaseW);");
  check("fragment helpers: fragValueNoise2D < waterRippleSlope < waterFlowAt < main",
    iNoise > 0 && iNoise < iRipple && iRipple < iFlowAt && iFlowAt < iFMain);
  check("flow block: after the old scroll, before the per-corner UVs", iScroll > iFMain && iScroll < iFlow && iFlow < iUv00);
  check("both TexMerge slots take the second phase; foam after the tint; ripples ride the phases",
    iBase > iFlow && iSlot > iBase && iTint > 0 && iFoam > iTint && iSheen > iFoam);
  check("the bilinear corner taps take the second phase (per water corner)",
    f.includes("if (wc00) c00 = mix(terrainAtlasTex(clamp(t00, 0, 32), waterCellUvB).rgb, c00, waterPhaseW);"));
  check("the flow state is declared at main() scope (before the gate), so later splices see it",
    /\n  vec2 waterCellUvB = waterCellUv;\n  vec2 waterOffA = vec2\(0\.0\);/.test(f));
  check("the flow-map restarts are hidden: weight 0 at each tap's restart",
    f.includes("float ph1 = fract(ph0 + 0.5);") && f.includes("waterPhaseW = 1.0 - abs(2.0 * ph0 - 1.0);"));
  check("still water gets a mean-zero eddy, no heading",
    f.includes("vec2 eddy = vec2(fragValueNoise2D(eddyP), fragValueNoise2D(eddyP + vec2(31.7, -12.3)))"));
  check("the old scroll line and every pinned water line survive (test_terrain_water.mjs)",
    /vec2 waterCellUv = cellUv;\s*\n\s*if \(uWaterScrollEnabled > 0\.5\) \{/.test(FRAG)
    && /vec2 wuv = gp \* 0\.9 \+ vec2\(uTime \* 0\.35, uTime \* 0\.22\);/.test(FRAG)
    && /wN = normalize\(vec3\(slope \* sheenFade, 1\.0\)\);/.test(FRAG));

  // Batch anchors: inlined copies == module exports; each anchor once in its stage.
  const inl = (name) => { const m = BSRC.match(new RegExp(`const ${name} = "(.*)";`)); return m ? m[1] : null; };
  for (const n of ["WATER_BANK_VDECL_ANCHOR", "WATER_BANK_VDECL_BATCHED", "WATER_BANK_FETCH_ANCHOR", "WATER_BANK_FETCH_BATCHED",
    "WATER_FLOW_FETCH_ANCHOR", "WATER_FLOW_FETCH_BATCHED", "WATER_FOAM_FETCH_ANCHOR", "WATER_FOAM_FETCH_BATCHED"]) {
    check(`terrain_batch.js ${n} == module export`, inl(n) === W[n]);
  }
  check("vertex anchors occur exactly once in the assembled vertex stage",
    VERT.split(W.WATER_BANK_VDECL_ANCHOR).length === 2 && VERT.split(W.WATER_BANK_FETCH_ANCHOR).length === 2);
  check("fragment anchors occur exactly once in the assembled fragment stage",
    FRAG.split(W.WATER_FLOW_FETCH_ANCHOR).length === 2 && FRAG.split(W.WATER_FOAM_FETCH_ANCHOR).length === 2);
  check("the fragment's batch anchor 'uniform sampler2D uVertexTypes;' is still unique in terrain.js",
    SRC.split("uniform sampler2D uVertexTypes;").length === 2);

  // The REAL batched derivation, on the REAL assembled program.
  let src = BSRC.replace(/^\s*import\s+.*$/gm, "")
    .replace(/^\s*export\s+function\s+/gm, "function ").replace(/^\s*export\s+const\s+/gm, "const ");
  const build = new Function("THREE", "window", "TERRAIN_FX_LIGHT_UNIFORMS", src + "\n; return _buildBatchedGlsl;")({}, undefined, undefined);
  const bat = build(VERT, FRAG);
  check("the batched derivation succeeds on the real program", !!bat);
  if (bat) {
    check("batched vertex: sampler2DArray + slot fetch, no per-LB fetch left",
      bat.vertexShader.includes("uniform highp sampler2DArray uVertexTypes;") && !bat.vertexShader.includes("sampler2D uVertexTypes;")
      && bat.vertexShader.includes(W.WATER_BANK_FETCH_BATCHED) && !/ivec2\(27 \+ x/.test(bat.vertexShader));
    check("batched fragment: flow + foam fetches read the slot layer, no per-LB fetch left",
      bat.fragmentShader.includes(W.WATER_FLOW_FETCH_BATCHED) && bat.fragmentShader.includes(W.WATER_FOAM_FETCH_BATCHED)
      && !/texelFetch\(uVertexTypes, ivec2\(/.test(bat.fragmentShader));
    check("batched vertex: aLbSlot is declared before the swell-weight fetch reads it",
      bat.vertexShader.indexOf("in float aLbSlot;") > 0
      && bat.vertexShader.indexOf("in float aLbSlot;") < bat.vertexShader.indexOf(W.WATER_BANK_FETCH_BATCHED));
  }
  check("terrain_batch accepts the 36-wide layer", BSRC.includes("vtImgW === VT_W * 2 || vtImgW === VT_W * 4 ? vtImgW : VT_W"));

  // Wiring.
  check("wide writer writes the water columns", SRC.includes("writeWaterColumns(bytes, cols, water ? water.entry : null, water ? water.bank : null);"));
  check("the bake passes this LB's table entry (16-bit key) and its bank weights",
    SRC.includes("waterFlowEntry(waterFlowTable(), (lbX << 8) | lbY)")
    && SRC.includes("computeWaterBankWeights(terrainCodesCopy, wasmMesh.heights, opts.waterCodeMask)"));
  check("the ring resolve awaits the table before any LB bakes", /if \(WATER_FLOW_ON\) \{\s*\n\s*try \{\s*\n\s*await loadWaterFlowTable\(\);/.test(SRC));
  check("material spreads the water-flow uniforms", SRC.includes("...waterFlowUniforms(THREE.Vector4),"));
  check("far-terrain bake rig: flow, whitewater and swell off (its scratch texture is 9 wide)",
    FAR.includes("mat.uniforms.uWaterFlow.value.x = 0.0;") && FAR.includes("mat.uniforms.uWaterFoam.value.x = 0.0;")
    && FAR.includes("mat.uniforms.uDisplacementEnabled.value = 0.0;"));
  const flags = readFileSync(resolvePath(__dirname, "docs/url-flags.md"), "utf8");
  for (const fl of ["waterFlow", "waterBank", "waterFlowSpeed", "waterFlowPeriod", "waterStill", "waterFoam"]) {
    check(`url-flags.md row: ${fl}`, flags.includes(`| \`${fl}\` |`));
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- 5. flag variants (each escape compiles its own program) --");
for (const v of ["", "?waterFlow=off", "?waterBank=off", "?waterFlow=off&waterBank=off", "?terrainRound=off", "?terrainFarSimplify=off&texMerge=off"]) {
  const r = spawnSync(process.execPath, [__filename, "--variant", v], { cwd: __dirname, encoding: "utf8", timeout: 120000 });
  const tail = (r.stdout || "").trim().split("\n").pop();
  check(`variant ${JSON.stringify(v || "default")}: ${tail}`, r.status === 0,
    (r.stdout || "").split("\n").filter((l) => l.includes("[FAIL]")).join(" | ") + (r.status !== 0 ? (r.stderr || "").slice(-400) : ""));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
