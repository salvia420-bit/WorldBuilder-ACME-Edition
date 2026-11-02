// 2026-11-01 — the flight-experience WORLD TIER (scene3d/world_terrain.js) and the FLIGHT VIEW policy
// (scene3d/altitude_policy.js): CDLOD selection (coverage, no overlap, altitude coarsening, frustum hook), the
// CPU height sampler over the baked grid, the GLSL shape (one program, presence discard, depth push, shared
// tail), and the pure altitude terms (fog band, far quantizer, haze scale, radial altitude).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/world_terrain.test.mjs

import {
  worldTierEnabled, levelRange, selectNodes, heightAtGrid, WORLD_VERTS, WORLD_M, CELL_M,
  WORLD_VERTEX_GLSL, WORLD_FRAGMENT_GLSL,
} from "../scene3d/world_terrain.js";
import {
  flightViewEnabled, viewDistanceM, flightFogBand, quantizedFar, hazeScale, radialAltitude, FLY_ENTER_AGL, FLY_EXIT_AGL,
  highSubjectAgl, objRadiusForAgl, flightPrewarmEnabled,
} from "../scene3d/altitude_policy.js";
import { TERRAIN_SHARED_TAIL_GLSL } from "../scene3d/terrain_shared_glsl.js";
import { LB_HANDOFF_GLSL } from "../scene3d/lb_presence.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

console.log("-- W1 flag grammar ---------------------------------------------------");
check("?worldTier: implied by the default-ON ?flightView; =on forces, =off escapes",
  worldTierEnabled("") === true && worldTierEnabled("?worldTier=on") === true && worldTierEnabled("?worldTier=off") === false
  && worldTierEnabled("?flightView=off") === false && worldTierEnabled("?flightView=off&worldTier=on") === true);
check("?flightView implies the world tier (unless ?worldTier=off)", worldTierEnabled("?flightView=on") === true && worldTierEnabled("?flightView=on&worldTier=off") === false);
check("?flightView: DEFAULT ON (2026-11-01), off / 0 / false / no escape",
  flightViewEnabled("") === true && flightViewEnabled("?flightView=1") === true && flightViewEnabled("?flightView=no") === false
  && flightViewEnabled("?flightView=off") === false && flightViewEnabled("?flightView=0") === false);
check("grid constants", WORLD_VERTS === 2041 && CELL_M === 24 && WORLD_M === 48960);

console.log("-- W2 CDLOD selection --------------------------------------------------");
{
  const area = (nodes) => nodes.reduce((a, n) => a + n.size * n.size, 0);
  // coverage: with no frustum the selected nodes tile the root exactly (no gaps, no overlaps)
  const cam = { x: 32000, y: 36000, z: 120 };
  const nodes = selectNodes(cam);
  const root = 768 * 256;
  check("nodes tile the 196 km root exactly", Math.abs(area(nodes) - root * root) < 1, `${area(nodes)} vs ${root * root}`);
  const overlap = (() => {
    const leaf = nodes.filter((n) => n.level === 0);
    const seen = new Set();
    for (const n of leaf) { const k = `${n.x0},${n.y0}`; if (seen.has(k)) return true; seen.add(k); }
    return false;
  })();
  check("no duplicate leaves", !overlap);
  check("leaves under a low camera", nodes.some((n) => n.level === 0 && cam.x >= n.x0 && cam.x < n.x0 + n.size && cam.y >= n.y0 && cam.y < n.y0 + n.size));
  check("node count bounded (< 400 without a frustum)", nodes.length < 400, String(nodes.length));
  // altitude coarsens the ground below: at 4.5 km no leaf is selected (3D distance > range(0))
  const high = selectNodes({ x: 32000, y: 36000, z: 4600 });
  const minLevel = Math.min(...high.map((n) => n.level));
  check("at 4.5 km the finest level below is coarser than a leaf", minLevel >= 2, String(minLevel));
  check("...and the count drops", high.length < nodes.length, `${high.length} vs ${nodes.length}`);
  // the level ranges double
  check("ranges double per level", levelRange(3) === 1536 * 8 && levelRange(0, 2000) === 2000);
  // a neighbour is never more than one level apart along the camera's row (CDLOD property)
  const row = nodes.filter((n) => cam.y >= n.y0 && cam.y < n.y0 + n.size).sort((a, b) => a.x0 - b.x0);
  let maxJump = 0;
  for (let i = 1; i < row.length; i += 1) maxJump = Math.max(maxJump, Math.abs(row[i].level - row[i - 1].level));
  check("adjacent nodes differ by at most one level (morph is crack-free)", maxJump <= 1, String(maxJump));
  // frustum hook: rejecting everything west of the camera removes those nodes
  const east = selectNodes(cam, { visible: (x0, y0, s) => x0 + s > cam.x - 1 });
  check("visible() culls nodes", east.length < nodes.length && east.every((n) => n.x0 + n.size > cam.x - 1));
}

console.log("-- W3 CPU height over the grid ------------------------------------------");
{
  const hIdx = new Uint8Array(WORLD_VERTS * WORLD_VERTS);
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = i * 2;
  hIdx[10 * WORLD_VERTS + 20] = 50; // vertex (20, 10) = 100 m
  hIdx[10 * WORLD_VERTS + 21] = 100; // vertex (21, 10) = 200 m
  check("exact at a vertex", heightAtGrid(hIdx, table, 20 * 24, 10 * 24) === 100);
  check("bilinear between two vertices", Math.abs(heightAtGrid(hIdx, table, 20.5 * 24, 10 * 24) - 150) < 1e-3);
  check("off the map = sea level (table[0])", heightAtGrid(hIdx, table, -5, 100) === 0 && heightAtGrid(hIdx, table, 60000, 100) === 0);
}

console.log("-- W4 GLSL shape --------------------------------------------------------");
check("vertex: instanced node + CDLOD morph + reversed-Z push", /in vec4 aNode/.test(WORLD_VERTEX_GLSL) && /morph/.test(WORLD_VERTEX_GLSL) && /USE_REVERSED_DEPTH_BUFFER/.test(WORLD_VERTEX_GLSL));
check("fragment: per-landblock presence discard through the shared hand-off rule (lb_presence.js ?lbBand)",
  /HB_WORLD_PRESENCE/.test(WORLD_FRAGMENT_GLSL) && WORLD_FRAGMENT_GLSL.includes(LB_HANDOFF_GLSL)
  && /if \(hbNearCovers\(vWorldXy \/ 192\.0\)\) discard;/.test(WORLD_FRAGMENT_GLSL));
check("fragment: no read of a presence B channel (the field is RG: B is always 0)", !/\bpr\.b\b|\.b > 0\.5/.test(WORLD_FRAGMENT_GLSL));
check("fragment: the near ring's atlas + per-code tiling", /uniform sampler2DArray uAtlas/.test(WORLD_FRAGMENT_GLSL) && /uBaseTexTiling\[33\]/.test(WORLD_FRAGMENT_GLSL));
check("fragment: the SHARED lighting + fog tail, verbatim", WORLD_FRAGMENT_GLSL.includes(TERRAIN_SHARED_TAIL_GLSL));
check("no backticks inside the GLSL", !WORLD_VERTEX_GLSL.slice(1).includes("`") && !WORLD_FRAGMENT_GLSL.slice(1).includes("`"));

console.log("-- W5 altitude terms ----------------------------------------------------");
check("view distance: 8 km on the ground, +12 m per m of AGL, capped", viewDistanceM(0) === 8000 && viewDistanceM(80) === 8960 && viewDistanceM(4500) === 62000 && viewDistanceM(1e6) === 240000);
{
  const b = flightFogBand(450);
  check("fog band near = 0.35 D, far = D", Math.abs(b.near - 0.35 * 13400) < 1e-6 && b.far === 13400);
}
check("far quantizer: 5 km floor, ×1.5 steps, ≥ 1.25 D, ≤ 250 km",
  quantizedFar(1000) === 5000 && quantizedFar(8000) === 11250 && quantizedFar(62000) >= 77500 && quantizedFar(1e7) === 250000);
check("haze: 1 on the ground and to 300 m, 0 from 1.5 km", hazeScale(0) === 1 && hazeScale(300) === 1 && hazeScale(1500) === 0 && hazeScale(900) > 0 && hazeScale(900) < 1);
check("radial altitude: AC z + d²/2R (177 m over Holtburg)", Math.abs(radialAltitude(33000, 100, -36000) - (100 + (33000 ** 2 + 36000 ** 2) / (2 * 6360000))) < 1e-6
  && Math.abs(radialAltitude(33000, 0, -36000) - 187.5) < 2);
check("hysteresis band: enter above exit", FLY_ENTER_AGL > FLY_EXIT_AGL);
check("?flightPrewarm: default ON on a page that can fly, never without vehicles, =off escapes",
  flightPrewarmEnabled("", true) === true && flightPrewarmEnabled("", false) === false
  && flightPrewarmEnabled("?flightPrewarm=off", true) === false && flightPrewarmEnabled("?flightPrewarm=0", true) === false);
{
  // the object window narrows with altitude, one band at a time, with hysteresis (no flapping over hills)
  let r = null;
  const seq = [100, 700, 1400, 1600, 2400, 2600, 5000, 2300, 2100, 1400, 1200, 500, 400].map((a) => (r = objRadiusForAgl(a, r)));
  check("object radius by AGL: page default → 3 → 2 → 1 and back, with hysteresis",
    JSON.stringify(seq) === JSON.stringify([null, 3, 3, 2, 2, 1, 1, 1, 2, 2, 3, 3, null]), JSON.stringify(seq));
  let f = null;
  const fly = [0, 30, 50, 100, 30, 20, 0].map((a) => (f = objRadiusForAgl(a, f, true)));
  check("an airborne aircraft in the low band: radius 3 from 40 m, back to the page default below 25 m",
    JSON.stringify(fly) === JSON.stringify([null, null, 3, 3, 3, null, null]), JSON.stringify(fly));
  check("...on foot (not flying) the low band keeps the page default", objRadiusForAgl(100, null, false) === null);
}
{
  const flat = () => 50;
  check("\"high\" = the PLAYER's height, not the chase camera's (a cliff edge on foot stays on-foot, Q7)",
    highSubjectAgl(140, { x: 1, y: 1, z: 51.5 }, false, flat) === 1.5);
  check("...a bail-out fall counts (player 900 m up)", highSubjectAgl(905, { x: 1, y: 1, z: 950 }, false, flat) === 900);
  check("...the parked debug free camera counts its own height", highSubjectAgl(4800, { x: 1, y: 1, z: 51 }, true, flat) === 4800);
  check("...unknown player or ground → null (not high)", highSubjectAgl(300, null, false, flat) === null
    && highSubjectAgl(300, { x: 1, y: 1, z: 99 }, false, () => null) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
