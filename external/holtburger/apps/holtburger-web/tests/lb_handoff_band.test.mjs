// 2026-11-02 — the terrain HAND-OFF band (`?lbBand`, scene3d/lb_presence.js LB_HANDOFF_GLSL): where the far ring
// (far_terrain.js, HB_FAR_PRESENCE) and the world tier (world_terrain.js, HB_WORLD_PRESENCE) may draw under a
// near-drawn landblock. The owner saw "green lines in square shape on terrain" on the 1070 (on foot at Holtburg,
// and at 100 m AGL in flight): the 10 m band both tiers kept under EVERY edge of a near-drawn landblock won the
// depth test against the near ring (drawn 1 cm below grade), a 19 m strip centred on every landblock edge.
// The fix keeps the band only where the near ring ENDS. Checks: the flag grammar, the rule against a brute-force
// spec on random landblock sets, the crack-free property at the near ring's boundary, the GLSL (both consumers,
// every mode, preprocessed), the material defines, and the depth numbers that make the band visible.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/lb_handoff_band.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lbBandMode, lbBandOn, __setLbBandForTest, lbBandDefines, nearCoversAt, LB_HANDOFF_GLSL, LB_BAND_FRAC,
  LB_BAND_NONE, LB_BAND_OPEN, LB_BAND_ALL, WIN,
} from "../scene3d/lb_presence.js";
import { FAR_FRAGMENT_GLSL } from "../scene3d/far_terrain.js";
import { WORLD_FRAGMENT_GLSL, WORLD_VERTEX_GLSL } from "../scene3d/world_terrain.js";
import { REVERSED_BIAS_NOMINAL_FAR } from "../scene3d/shader_logdepth.js";
import { farDepthBias } from "../scene3d/far_terrain_flags.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (f) => readFileSync(path.join(HERE, "..", f), "utf8");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- B1 ?lbBand grammar --------------------------------------------------");
check("absent / open / junk -> open (the fix, default)", [ "", "?x=1", "?lbBand=open", "?lbBand=OPEN", "?lbBand=maybe" ].every((s) => lbBandMode(s) === LB_BAND_OPEN));
check("all / off / 0 / false / no -> all (the 2026-11-01 rule: a band on every edge)",
  ["all", "off", "0", "false", "no", " ALL "].every((v) => lbBandMode(`?lbBand=${encodeURIComponent(v)}`) === LB_BAND_ALL));
check("none -> none (no band: the crack A/B)", lbBandMode("?lbBand=none") === LB_BAND_NONE);
__setLbBandForTest(LB_BAND_ALL);
check("the material define follows the cached mode", lbBandOn() === LB_BAND_ALL && lbBandDefines().HB_LB_BAND === LB_BAND_ALL);
__setLbBandForTest(undefined);
check("node (no location) reads the default", lbBandOn() === LB_BAND_OPEN && lbBandDefines().HB_LB_BAND === LB_BAND_OPEN);
__setLbBandForTest(undefined);

console.log("-- B2 the rule ---------------------------------------------------------");
const setOf = (pairs) => {
  const s = new Set(pairs.map(([x, y]) => `${x},${y}`));
  return (x, y) => s.has(`${x},${y}`);
};
{
  // a fully drawn 3x3 around (10, 10): nothing of a lower tier anywhere in the centre landblock
  const all9 = [];
  for (let x = 9; x <= 11; x += 1) for (let y = 9; y <= 11; y += 1) all9.push([x, y]);
  const d = setOf(all9);
  const samples = [0, 0.01, 0.05, 0.2, 0.5, 0.8, 0.95, 0.99, 0.999];
  let open = 0, allMode = 0, n = 0;
  for (const fx of samples) for (const fy of samples) {
    n += 1;
    if (nearCoversAt(d, 10, 10, fx, fy, LB_BAND_OPEN)) open += 1;
    if (nearCoversAt(d, 10, 10, fx, fy, LB_BAND_ALL)) allMode += 1;
  }
  check("open: between near-drawn landblocks the near ring covers every point (no lower tier, no green line)", open === n, `${open}/${n}`);
  check("all: the old rule leaves the 10 m band on every edge (the green grid)", allMode < n && !nearCoversAt(d, 10, 10, 0.02, 0.5, LB_BAND_ALL));
  // the east neighbour is not drawn (a leading-edge hole, the ring's outer edge)
  const e = setOf(all9.filter(([x, y]) => !(x === 11 && y === 10)));
  check("open: the band stays along the edge whose neighbour is not drawn", !nearCoversAt(e, 10, 10, 0.97, 0.5));
  check("...and only there (west, north, south bands are covered)",
    nearCoversAt(e, 10, 10, 0.02, 0.5) && nearCoversAt(e, 10, 10, 0.5, 0.97) && nearCoversAt(e, 10, 10, 0.5, 0.02));
  check("...the open edge's corners keep the band (the 10 m square overlaps the hole's corner)",
    !nearCoversAt(e, 10, 10, 0.97, 0.97) && !nearCoversAt(e, 10, 10, 0.97, 0.02));
  check("...the interior is covered", nearCoversAt(e, 10, 10, 0.5, 0.5) && nearCoversAt(e, 10, 10, 0.94, 0.5));
  // only the diagonal is missing: the corner square stays, the edges away from it do not
  const g = setOf(all9.filter(([x, y]) => !(x === 11 && y === 11)));
  check("open: a missing DIAGONAL keeps just the corner square", !nearCoversAt(g, 10, 10, 0.97, 0.97)
    && nearCoversAt(g, 10, 10, 0.97, 0.5) && nearCoversAt(g, 10, 10, 0.5, 0.97) && nearCoversAt(g, 10, 10, 0.97, 0.02));
  // none: the whole drawn landblock goes to the near ring, open edge or not
  check("none: no band even at an open edge", nearCoversAt(e, 10, 10, 0.97, 0.5, LB_BAND_NONE) && nearCoversAt(e, 10, 10, 0.99, 0.99, LB_BAND_NONE));
  // an undrawn landblock is never covered, in any mode
  check("an undrawn landblock is the lower tiers' in every mode",
    [LB_BAND_NONE, LB_BAND_OPEN, LB_BAND_ALL].every((m) => !nearCoversAt(e, 11, 10, 0.5, 0.5, m) && !nearCoversAt(e, 11, 10, 0.01, 0.5, m)));
}

console.log("-- B3 the rule vs a brute-force spec (random landblock sets) ------------");
{
  // SPEC: the near ring covers p for sure iff every landblock touching the closed square of half-size
  // LB_BAND_FRAC around p is near-drawn (the 10 m around p is all near ring, so no seam is within 10 m).
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  let mismatches = 0, total = 0, coveredPts = 0, bandPts = 0;
  for (let trial = 0; trial < 40; trial += 1) {
    const drawnSet = new Set();
    const dens = 0.5 + 0.45 * rnd();
    for (let x = 0; x < 12; x += 1) for (let y = 0; y < 12; y += 1) if (rnd() < dens) drawnSet.add(`${x},${y}`);
    const drawn = (x, y) => drawnSet.has(`${x},${y}`);
    for (let k = 0; k < 400; k += 1) {
      const px = 1 + rnd() * 10, py = 1 + rnd() * 10;
      // bias toward the band so the edge cases get exercised
      const snap = (v) => (rnd() < 0.5 ? Math.floor(v) + (rnd() < 0.5 ? rnd() * 0.06 : 1 - rnd() * 0.06) : v);
      const qx = snap(px), qy = snap(py);
      const lbx = Math.floor(qx), lby = Math.floor(qy), fx = qx - lbx, fy = qy - lby;
      const d = LB_BAND_FRAC;
      // landblocks touching [q - d, q + d] (closed): the rule's `<=` / `>=` boundaries
      const xs = [lbx], ys = [lby];
      if (fx <= d) xs.push(lbx - 1); if (fx >= 1 - d) xs.push(lbx + 1);
      if (fy <= d) ys.push(lby - 1); if (fy >= 1 - d) ys.push(lby + 1);
      let spec = true;
      for (const x of xs) for (const y of ys) if (!drawn(x, y)) spec = false;
      const got = nearCoversAt(drawn, lbx, lby, fx, fy, LB_BAND_OPEN);
      total += 1;
      if (got !== spec) mismatches += 1;
      if (got) coveredPts += 1;
      if (xs.length > 1 || ys.length > 1) bandPts += 1;
    }
  }
  check(`the open rule == the spec on ${total} random points over 40 random landblock sets`, mismatches === 0, `${mismatches} mismatches`);
  check("...with both outcomes and the band well exercised", coveredPts > total * 0.2 && coveredPts < total * 0.9 && bandPts > total * 0.3,
    `${coveredPts} covered, ${bandPts} in a band`);
}

console.log("-- B4 crack-free at the near ring's boundary ----------------------------");
{
  // wherever a near-drawn landblock meets one the near ring does NOT draw, the lower tier draws a strip on BOTH
  // sides of the shared edge (all of the undrawn one, the 10 m band of the drawn one): the two meshes overlap
  const drawnSet = new Set(["5,5", "6,5", "5,6"]);
  const drawn = (x, y) => drawnSet.has(`${x},${y}`);
  const lowerDraws = (x, y, fx, fy) => !nearCoversAt(drawn, x, y, fx, fy, LB_BAND_OPEN);
  let ok = true;
  for (let t = 0.01; t < 1; t += 0.07) {
    // (6,5) | (7,5): drawn | undrawn, edge x = 7
    ok = ok && lowerDraws(6, 5, 0.99, t) && lowerDraws(7, 5, 0.01, t);
    // (5,6) / (5,7): drawn / undrawn, edge y = 7
    ok = ok && lowerDraws(5, 6, t, 0.99) && lowerDraws(5, 7, t, 0.01);
    // (5,5) | (6,5): both drawn, edge x = 6 — no lower tier on either side (away from the open corners)
    if (t > 0.06 && t < 0.94) ok = ok && !lowerDraws(5, 5, 0.99, t) && !lowerDraws(6, 5, 0.01, t);
  }
  check("open edges overlap on both sides; a shared near-near edge has no lower tier", ok);
  // the re-entrant corner (6,6) is undrawn: (5,5)'s NE corner square, (6,5)'s NW and (5,6)'s SE keep the band
  check("the re-entrant corner keeps the band in all three drawn neighbours",
    lowerDraws(5, 5, 0.99, 0.99) && lowerDraws(6, 5, 0.01, 0.99) && lowerDraws(5, 6, 0.99, 0.01));
}

console.log("-- B5 GLSL (both consumers, every mode) --------------------------------");
function preprocess(src, defines) {
  const out = [];
  const stack = [];
  const defs = { ...defines };
  const active = () => stack.every((s) => s.active);
  for (const line of src.split("\n")) {
    const t = line.trim();
    let m;
    if ((m = /^#ifdef\s+(\w+)/.exec(t))) { const c = active() && m[1] in defs; stack.push({ active: c, taken: c }); continue; }
    if ((m = /^#ifndef\s+(\w+)/.exec(t))) { const c = active() && !(m[1] in defs); stack.push({ active: c, taken: c }); continue; }
    if ((m = /^#if\s+(\w+)\s*==\s*(\d+)\s*$/.exec(t))) { const c = active() && Number(defs[m[1]]) === Number(m[2]); stack.push({ active: c, taken: c }); continue; }
    if (/^#if\b/.test(t)) { stack.push({ active: false, taken: false, other: true }); continue; }
    if (/^#else\b/.test(t)) {
      const s = stack[stack.length - 1];
      const parent = stack.slice(0, -1).every((p) => p.active);
      s.active = parent && !s.taken && !s.other; s.taken = s.taken || s.active;
      continue;
    }
    if (/^#endif\b/.test(t)) { if (!stack.length) throw new Error("stray #endif"); stack.pop(); continue; }
    if (!active()) continue;
    if ((m = /^#define\s+(\w+)\s*(.*)$/.exec(t))) { defs[m[1]] = m[2]; continue; }
    out.push(line);
  }
  if (stack.length) throw new Error("unbalanced #if");
  return out.join("\n");
}
const balanced = (s) => {
  let b = 0, p = 0;
  for (const ch of s) { if (ch === "{") b += 1; if (ch === "}") b -= 1; if (ch === "(") p += 1; if (ch === ")") p -= 1; if (b < 0 || p < 0) return false; }
  return b === 0 && p === 0;
};
{
  check("helper: plain text (no backticks), balanced", !LB_HANDOFF_GLSL.includes("`") && balanced(LB_HANDOFF_GLSL));
  check("helper: the band threshold is LB_BAND_FRAC", LB_HANDOFF_GLSL.includes(`<= ${LB_BAND_FRAC.toFixed(4)}`) && LB_HANDOFF_GLSL.includes(`>= ${(1 - LB_BAND_FRAC).toFixed(4)}`));
  check("helper: the window size is the field's", LB_HANDOFF_GLSL.includes(`lb.x >= ${WIN} || lb.y >= ${WIN}`));
  const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const N1 = "if (sx != 0 && !hbNearDrawnLb(lb + ivec2(sx, 0))) return false;";
  const N2 = "if (sy != 0 && !hbNearDrawnLb(lb + ivec2(0, sy))) return false;";
  const N3 = "if (sx != 0 && sy != 0 && !hbNearDrawnLb(lb + ivec2(sx, sy))) return false;";
  for (const [mode, name] of [[LB_BAND_NONE, "none"], [LB_BAND_OPEN, "open"], [LB_BAND_ALL, "all"]]) {
    let pp = null, err = null;
    try { pp = preprocess(LB_HANDOFF_GLSL, { HB_LB_BAND: mode }); } catch (e) { err = e; }
    const L = pp ? lines(pp) : [];
    const body = L.slice(L.indexOf("bool hbNearCovers(vec2 lbPos) {"));
    const ok = !!pp && balanced(pp) && !/^#/m.test(pp.replace(/^\s*\/\/.*$/gm, ""))
      && L.includes("return texelFetch(hbLbPresence, lb, 0).g > 0.5;")
      && body[1] === "ivec2 lb = ivec2(floor(lbPos)) - ivec2(hbLbPresenceOrigin);"
      && body[2] === "if (!hbNearDrawnLb(lb)) return false;";
    let shape = false;
    if (mode === LB_BAND_NONE) shape = body[3] === "return true;" && !pp.includes("fract(");
    if (mode === LB_BAND_ALL) shape = body.includes("if (sx == 0 && sy == 0) return true;") && body[body.indexOf("if (sx == 0 && sy == 0) return true;") + 1] === "return false;" && !pp.includes(N1);
    if (mode === LB_BAND_OPEN) {
      const i = body.indexOf("if (sx == 0 && sy == 0) return true;");
      shape = i > 0 && body[i + 1] === N1 && body[i + 2] === N2 && body[i + 3] === N3 && body[i + 4] === "return true;";
    }
    check(`HB_LB_BAND ${mode} (${name}): preprocesses clean and has the ${name} shape`, ok && shape, err ? String(err) : "");
  }
  check("default with no define = open", preprocess(LB_HANDOFF_GLSL, {}).includes(N3));
  // the two consumers
  const farPp = preprocess(FAR_FRAGMENT_GLSL, { HB_FAR_PRESENCE: "", HB_LB_BAND: 1 });
  check("far ring: the helper is compiled in under HB_FAR_PRESENCE and decides the discard",
    FAR_FRAGMENT_GLSL.includes(LB_HANDOFF_GLSL) && farPp.includes("bool hbNearCovers(vec2 lbPos)")
    && /if \(hbNearCovers\(lbPos\)\) discard;/.test(farPp) && balanced(farPp));
  check("far ring: the every-edge inner test is gone", !/hbInner/.test(FAR_FRAGMENT_GLSL));
  check("far ring: outside the window the legacy square still applies", /\} else if \(dLb < uNearFadeLb\) \{\s*discard;/.test(farPp));
  check("far ring without ?lbFade: no helper, the square only",
    (() => { const p = preprocess(FAR_FRAGMENT_GLSL, {}); return !p.includes("hbNearCovers") && /if \(dLb < uNearFadeLb\) discard;/.test(p); })());
  const worldPp = preprocess(WORLD_FRAGMENT_GLSL, { HB_WORLD_PRESENCE: "", HB_LB_BAND: 1 });
  check("world tier: the helper is compiled in under HB_WORLD_PRESENCE and decides the discard",
    WORLD_FRAGMENT_GLSL.includes(LB_HANDOFF_GLSL) && /if \(hbNearCovers\(vWorldXy \/ 192\.0\)\) discard;/.test(worldPp) && balanced(worldPp));
  check("world tier: the helper sits after the presence uniforms it reads",
    worldPp.indexOf("uniform vec2 hbLbPresenceOrigin;") >= 0 && worldPp.indexOf("uniform vec2 hbLbPresenceOrigin;") < worldPp.indexOf("bool hbNearDrawnLb")
    && farPp.indexOf("uniform vec2 hbLbPresenceOrigin;") < farPp.indexOf("bool hbNearDrawnLb"));
  check("no name clash: each helper function is defined once per program",
    (farPp.match(/bool hbNearCovers\(/g) || []).length === 1 && (worldPp.match(/bool hbNearDrawnLb\(/g) || []).length === 1);
  // both material factories set the define next to their presence define
  const farSrc = SRC("scene3d/far_terrain.js"), worldSrc = SRC("scene3d/world_terrain.js");
  check("both material factories set HB_LB_BAND with their presence define",
    /HB_FAR_PRESENCE: "", \.\.\.lbBandDefines\(\)/.test(farSrc) && /HB_WORLD_PRESENCE: "", \.\.\.lbBandDefines\(\)/.test(worldSrc));
}

console.log("-- B6 why the band showed: the depth numbers ----------------------------");
{
  // The near ring is drawn 1 cm below grade (retail zFightTerrainAdjust); the far ring / world tier at grade with
  // a RELATIVE reversed-Z push k (gl_Position.z *= (far + 1)^-bias → ~k of the view distance). From a camera H
  // above flat ground a 1 cm vertical gap is 1 cm × d / H of depth, so the near ring wins only for H > 1 cm / k.
  const terrainSrc = SRC("scene3d/terrain.js");
  const lower = /const DEFAULT = (0\.0099999998);/.exec(terrainSrc);
  check("the near ring still lowers every vertex by retail's 1 cm", !!lower && /displacedPos\.z -= \$\{ZFIGHT_TERRAIN_ADJUST_M\.toFixed\(10\)\};/.test(terrainSrc));
  const h = lower ? Number(lower[1]) : 0.01;
  const L = Math.log(REVERSED_BIAS_NOMINAL_FAR + 1);
  const kFar = 1 - Math.exp(-farDepthBias() * L);
  const worldBias = Number((/uWorldDepthBias: \{ value: ([0-9.e-]+) \}/.exec(SRC("scene3d/world_terrain.js")) || [])[1]);
  const kWorld = 1 - Math.exp(-worldBias * L);
  const hFar = h / kFar, hWorld = h / kWorld;
  console.log(`    far push ${kFar.toExponential(3)} of distance → near wins above ${hFar.toFixed(0)} m; world ${kWorld.toExponential(3)} → ${hWorld.toFixed(0)} m`);
  check("far ring: the band beats the near ring below ~1.2 km of camera height", hFar > 1000 && hFar < 1400);
  check("world tier: below ~470 m (the whole low flight band)", hWorld > 400 && hWorld < 550);
  check("the world vertex stage still pushes by the same twin", /gl_Position\.z \*= exp2\(-uWorldDepthBias \*/.test(WORLD_VERTEX_GLSL));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
