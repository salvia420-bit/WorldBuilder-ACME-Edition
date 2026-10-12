// test_terrain_grass_lod.mjs — GRASS LOD (2026-10-12; `scene3d/terrain_grass.js`
// `grassLodLayout` + the multi-ring provider).
//
// Owner on the 1070: the player stood in dense grass while the hills ahead had
// none — "less dense grass around the player and reassign it to further ahead
// of them, maybe up to 5x further ... same budget on the grass".
//
// Locks:
//   D1  SAME BUDGET: the rings' counts sum to <= the tier count (and use >= 99%
//       of it); every ring is a perfect square (the pool never rounds up).
//   D2  REACH: the last ring reaches `reach x radiusM` (ultra 40 m -> 200 m);
//       each ring doubles the last; ring 0 keeps most of its old density.
//   D3  CROSS-DISSOLVE: where two rings meet, the inner one's density ramp and
//       the outer one's sum to exactly 1 — no gap, no doubled band, no edge.
//   D4  DENSITY FALLS WITH DISTANCE: live blades per m² drop ring to ring on a
//       real field (all-grass stub oracle).
//   D5  `reach: 1` is the old single field exactly (count, radius, fade, no
//       dissolve) — the `?terrainGrassReach=1` escape.
//   D6  ONE PROGRAM: every ring's material has the same onBeforeCompile source
//       (three's default program key) but its own LOD uniforms; the shared
//       uniforms are the SAME objects.
//   D7  LIVE LOOK: setLodLook rewrites the ring uniforms with no rebuild.
//   D8  The shader declares aRank / the LOD uniforms once and scales the blade
//       by the dissolve.
//   D9  Flags: `?terrainGrassReach` default 5, `off` = 1; near share default 0.34.
//
// Run from apps/holtburger-web/:  node test_terrain_grass_lod.mjs

import * as THREE from "three";
import { familyForCode } from "./scene3d/terrain_families.js";
import { _resetVfxFlags } from "./scene3d/vfx_flags.js";
import {
  GRASS_DEFAULTS,
  GRASS_ATTRIBUTES,
  grassLodLayout,
  grassLodKeep,
  resolveGrassConfig,
  createTerrainGrassProvider,
  injectTerrainGrassShader,
  GRASS_MARKER,
  GRASS_END,
} from "./scene3d/terrain_grass.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

function stubOracle() {
  return {
    sample(_x, _y, out) {
      const r = out || {};
      let c = r.cornerCodes;
      if (!c || c.length !== 4) { c = new Uint8Array(4); r.cornerCodes = c; }
      c[0] = c[1] = c[2] = c[3] = 1;
      r.code = 1;
      r.family = familyForCode(1);
      r.hasHeight = true;
      r.height = 20;
      let n = r.normal;
      if (!n) { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = 0; n.y = 0; n.z = 1;
      return r;
    },
  };
}

function makeProvider(config) {
  const parent = new THREE.Group();
  const p = createTerrainGrassProvider({ THREE, parent, config, search: "?grassIndoorCull=off" });
  const oracle = stubOracle();
  p.update(0.016, {
    scene3d: null, tSec: 0, dt: 0.016, hasPlayer: true, camera: null, quality: null,
    playerPos: { x: 5000, y: 5000, z: 20 }, oracle, trail: null,
  });
  return { p, parent };
}

const ULTRA = { blades: 119716, density: 1, radiusM: 40, stomp: false, offRoad: false, reach: 5, nearShare: 0.34, seed: 12345 };

// ---------------------------------------------------------------------------
console.log("\n-- D1/D2: the ring layout --");
{
  const cfg = resolveGrassConfig(ULTRA);
  const rings = grassLodLayout(cfg);
  check("ultra, reach 5 -> four rings", rings.length === 4, String(rings.length));
  const total = rings.reduce((a, r) => a + r.count, 0);
  check("same budget: the rings sum to <= the tier count", total <= 119716, String(total));
  check("...and use at least 99% of it", total >= 0.99 * 119716, String(total));
  check("every ring is a perfect square", rings.every((r) => Number.isInteger(Math.sqrt(r.count))));
  check("the last ring reaches 5 x 40 = 200 m", rings[3].radiusM === 200);
  check("each ring doubles the last (25 / 50 / 100 / 200)",
    rings.map((r) => r.radiusM).join() === "25,50,100,200");
  const oldDensity = 119716 / (80 * 80);
  const ring0Density = rings[0].count / (4 * rings[0].radiusM ** 2);
  check("ring 0 is less dense than the old field, but keeps >= 80% of it",
    ring0Density < oldDensity && ring0Density >= 0.8 * oldDensity,
    `${ring0Density.toFixed(2)} vs ${oldDensity.toFixed(2)}`);
  check("ring widths grow outward (sparser rings draw wider blades)",
    rings.every((r, k) => k === 0 || r.widthMul > rings[k - 1].widthMul));
  check("ring 0 blades are untouched (unit gains)", rings[0].widthMul === 1 && rings[0].heightMul === 1);
  check("the rings' round-robin scans total ~ the single field's 2048 a frame",
    rings.reduce((a, r) => a + r.scanBudget, 0) <= 2560
    && rings.every((r) => r.count / r.scanBudget <= 58), rings.map((r) => r.scanBudget).join());
  check("ring 0 keeps the single field's seed; outer rings are salted",
    rings[0].seed === 12345 && rings[0].randSalt === 0 && rings.slice(1).every((r) => r.seed !== 12345 && r.randSalt > 0));

  const high = grassLodLayout(resolveGrassConfig({ ...ULTRA, blades: 60025, radiusM: 32 }));
  check("high (R 32) reaches 160 m in four rings", high.length === 4 && high[3].radiusM === 160);
  const two = grassLodLayout(resolveGrassConfig({ ...ULTRA, reach: 2 }));
  check("reach 2 -> two rings, 40 / 80 m", two.length === 2 && two[0].radiusM === 40 && two[1].radiusM === 80);
}

// ---------------------------------------------------------------------------
console.log("\n-- D3: the cross-dissolve leaves no edge --");
{
  const rings = grassLodLayout(resolveGrassConfig(ULTRA));
  let worst = 0;
  for (let k = 0; k + 1 < rings.length; k += 1) {
    const inner = rings[k], outer = rings[k + 1];
    check(`ring ${k} fades out over exactly the band ring ${k + 1} fades in over`,
      inner.band[2] === outer.band[0] && inner.band[3] === outer.band[1]);
    for (let d = inner.band[2]; d <= inner.band[3]; d += 0.25) {
      worst = Math.max(worst, Math.abs(grassLodKeep(inner.band, d) + grassLodKeep(outer.band, d) - 1));
    }
  }
  check("inside every band the two rings' keeps sum to 1", worst < 1e-9, String(worst));
  check("ring 0 is full at the player", grassLodKeep(rings[0].band, 0) === 1);
  check("an outer ring is empty inside its hole", grassLodKeep(rings[2].band, 10) === 0);
  check("the last ring is empty at its rim", grassLodKeep(rings[3].band, 200) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- D4/D6: a live four-ring field --");
{
  const { p, parent } = makeProvider(ULTRA);
  const pools = p._pools;
  check("four pools, one mesh each under the grass group",
    pools.length === 4 && p._group.children.length === 4 && pools.every((pl) => !!pl.mesh));
  check("the group hangs off the parent", parent.children[0] === p._group);
  const st = p.stats();
  check("stats: blades = the sum of the rings", st.blades === pools.reduce((a, pl) => a + pl.count, 0));
  check("stats: reachM 200, four levels", st.reachM === 200 && st.levels.length === 4);
  check("an all-grass field is mostly live", st.visibleBlades > 0.6 * st.blades, `${st.visibleBlades}/${st.blades}`);

  // Live blades per m² in each ring's own annulus (ring 0: its disc).
  const density = pools.map((pl, k) => {
    const m = pl.mesh.instanceMatrix.array;
    const r0 = k === 0 ? 0 : pools[k - 1].radiusM, r1 = pl.radiusM;
    let n = 0;
    for (let i = 0; i < pl.count; i += 1) {
      if (!pl.isLive(i)) continue;
      const d = Math.hypot(m[i * 16 + 12] - 5000, m[i * 16 + 13] - 5000);
      if (d >= r0 && d < r1) n += 1;
    }
    return n / (Math.PI * (r1 * r1 - r0 * r0));
  });
  check("density falls ring to ring", density.every((v, k) => k === 0 || v < density[k - 1]),
    density.map((v) => v.toFixed(3)).join(" > "));
  check("the far ring still has blades out past 100 m", density[3] > 0.05, density[3].toFixed(3));

  const mats = p._materials;
  check("one material per ring", new Set(mats).size === 4);
  check("...all with the same onBeforeCompile source (one shared program)",
    new Set(mats.map((m) => m.onBeforeCompile.toString())).size === 1);
  const bags = p._ringUniforms;
  check("each ring owns its LOD uniforms", new Set(bags.map((b) => b.uGrassLodBand)).size === 4
    && new Set(bags.map((b) => b.uGrassLodScale)).size === 4);
  check("...and its scatter centre/radius (published by its own pool)",
    new Set(bags.map((b) => b.uScatterRadius)).size === 4
    && bags.map((b) => b.uScatterRadius.value).join() === "25,50,100,200");
  check("the wind clock and trail uniforms are the SAME objects in every ring",
    bags.every((b) => b.uTime === p._uniforms.uTime && b.uTrailEnabled === p._uniforms.uTrailEnabled));
  check("the rings' bands reached the GPU uniforms",
    bags[1].uGrassLodBand.value.x === 15 && bags[1].uGrassLodBand.value.w === 50);
  check("aRank was written in [0,1)", (() => {
    const a = pools[0].arrays.aRank;
    for (let i = 0; i < pools[0].count; i += 1) if (pools[0].isLive(i) && !(a[i] >= 0 && a[i] < 1)) return false;
    return true;
  })());

  // D7 — live look.
  const before = bags[2].uGrassLodScale.value.y;
  const look = p.setLodLook({ widthExp: 0.5, blend: 0.5 });
  check("setLodLook returns the merged look", look.widthExp === 0.5 && look.blend === 0.5
    && look.soft === GRASS_DEFAULTS.lodSoft);
  check("...and rewrites the ring uniforms in place (no rebuild)",
    bags[2].uGrassLodScale.value.y < before && bags[1].uGrassLodBand.value.x === 12.5
    && p._pools[0] === pools[0]);

  // Off-road reaches every ring.
  check("setOffRoad-style flips reach every pool", pools.every((pl) => pl.setOffRoad(true) === true));
  p.dispose();
  check("dispose empties the group and the pools", p._pools.length === 0 && parent.children.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- D5: reach 1 is the old single field --");
{
  const { p } = makeProvider({ ...ULTRA, reach: 1 });
  check("one pool of the whole budget", p._pools.length === 1 && p._pool.count === 119716);
  check("over the tier radius, with the old shrink fade",
    p._pool.radiusM === 40 && p._pool.stats().fadeFraction === GRASS_DEFAULTS.fadeFraction);
  const b = p._ringUniforms[0];
  check("no dissolve: keep is 1 everywhere inside the field",
    grassLodKeep([b.uGrassLodBand.value.x, b.uGrassLodBand.value.y, b.uGrassLodBand.value.z, b.uGrassLodBand.value.w], 39.9) === 1);
  check("unit blade gains", b.uGrassLodScale.value.x === 1 && b.uGrassLodScale.value.y === 1);
  check("the mesh keeps its old name", p._pool.mesh.name === "terrain-grass");
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- D8: the shader --");
{
  const s = {
    vertexShader: "uniform float uTime;\nvoid main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}",
    fragmentShader: "void main() {\n#include <normal_fragment_begin>\n#include <color_fragment>\n#include <dithering_fragment>\n}",
  };
  injectTerrainGrassShader(s);
  const count = (re) => (s.vertexShader.match(re) || []).length;
  check("aRank is in the attribute schema", GRASS_ATTRIBUTES.some((a) => a.name === "aRank"));
  check("aRank declared once", count(/attribute float aRank;/g) === 1);
  for (const u of ["uniform vec4 uGrassLodBand;", "uniform vec2 uGrassLodScale;", "uniform float uGrassLodSoft;"]) {
    check(`${u} declared once`, s.vertexShader.split(u).length === 2);
  }
  // The LAST marked block is the vertex transform (the ground-normal one is first).
  const snip = s.vertexShader.slice(s.vertexShader.lastIndexOf(GRASS_MARKER), s.vertexShader.lastIndexOf(GRASS_END));
  check("the blade is sized by aScale x the ring gain", /vec2 hbS = aScale \* uGrassLodScale;/.test(snip));
  check("the dissolve scales the blade by its rank against the ring density",
    /hbP \*= clamp\(\(hbKeep \* \(1\.0 \+ hbSoft\) - aRank\) \/ hbSoft, 0\.0, 1\.0\);/.test(snip));
  check("distance is measured from the ring's own scatter centre",
    /length\(hbWorld - uScatterCenter\.xy\)/.test(snip));
}

// ---------------------------------------------------------------------------
console.log("\n-- D9: flags --");
{
  const g = globalThis;
  const prev = g.window;
  try {
    g.window = { location: { search: "" } };
    _resetVfxFlags();
    check("no URL -> reach 5, near share 0.34",
      resolveGrassConfig({ blades: 100 }).reach === 5 && resolveGrassConfig({ blades: 100 }).nearShare === 0.34);
    g.window = { location: { search: "?terrainGrassReach=off" } };
    _resetVfxFlags();
    check("?terrainGrassReach=off -> 1 (the old field)", resolveGrassConfig({ blades: 100 }).reach === 1);
    g.window = { location: { search: "?terrainGrassReach=3&terrainGrassNearShare=0.5" } };
    _resetVfxFlags();
    const c = resolveGrassConfig({ blades: 100 });
    check("?terrainGrassReach=3&terrainGrassNearShare=0.5 reach the config", c.reach === 3 && c.nearShare === 0.5);
    g.window = { location: { search: "?terrainGrassReach=99" } };
    _resetVfxFlags();
    check("an out-of-range reach falls back to 5", resolveGrassConfig({ blades: 100 }).reach === 5);
  } finally {
    if (prev === undefined) delete g.window; else g.window = prev;
    _resetVfxFlags();
  }
}

console.log(`\nterrain grass LOD: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
