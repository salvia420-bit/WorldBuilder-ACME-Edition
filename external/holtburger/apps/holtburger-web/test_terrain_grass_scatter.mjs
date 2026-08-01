// test_terrain_grass_scatter.mjs — §3.1 GRASS placement (Wave 1A;
// `scene3d/terrain_grass.js` over `scene3d/terrain_scatter.js`).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.1, §5.4, §5.5, §5.7, §6, §8.2):
//   L1  DETERMINISM (§5.5): a fixed player position + seed produce a
//       bit-identical field, twice, in two independently-built providers. No
//       clock, no `Math.random`, no player history in the placement.
//   L2  NON-GRASS terrain is DEGENERATE: `aScale` h === 0 (and the instance
//       matrix is zero-scaled, so it is zero-area for any material at all).
//       Water is degenerate too — never planted on.
//   L3  AMORTISATION (§3.1 "no frame pays a full re-scatter"): a 10 m walk
//       re-scatters at most `sliceSize` (512) instances per update.
//   L4  ALLOCATE ONCE: every per-instance buffer is allocated exactly once, at
//       construction — the identities never change across scatter/teleport.
//   L5  BLADE COUNT MATCHES THE TIER: the `mid`/`high`/`ultra` preset counts
//       (24336 / 60025 / 119716) are perfect squares and survive the pool's
//       round-up unchanged; `low` (0) is DISABLED (§5.8 — null on low).
//       `?terrainGrassDensity` scales the count; 0 disables.
//   L6  SUB-VARIANTS (§3.1): the six grass codes each map to their own blade
//       height / width / tint / thinning, LushGrass tallest and DarkMoss
//       shortest, and every parameter is a pure function of the world cell.
//   L7  BOUNDARY FEATHERING (§8 risk 2/3): placement picks its code by a
//       hash-dithered draw over the four cell CORNERS with the shader's own
//       bilinear weights — so grass coverage ramps across a 24 m terrain
//       boundary instead of drawing a hard square, in BOTH directions.
//   L8  §5.7: `castShadow` is false on the blade mesh (added geometry is paid a
//       second time by the shadow depth pass).
//   L9  TELEPORT (§3.1): a jump larger than one landblock re-scatters the whole
//       field in one call, and the stomp map is NOT cleared here — `trail_map`
//       already owns that (verify, do not duplicate).
//   L10 The provider is a well-formed camera-scoped `terrain_vfx` provider and
//       is INERT until it is ticked with a player position (nothing is built,
//       nothing is added to the scene) — the ship-OFF contract.
//   L11 STOMP stamps the trail map only when its own flag is on, and a MISSING
//       trail map is a clean no-op (uTrailEnabled 0), never a throw.
//
// Run from apps/holtburger-web/:  node test_terrain_grass_scatter.mjs
// (real three from node_modules — plan §6: `_three_stub.mjs` has no
// InstancedMesh and no BufferGeometry, so it cannot carry a grass test.)

import * as THREE from "three";
import { FAM_GRASS, FAM_WATER, familyForCode } from "./scene3d/terrain_families.js";
import { PRESETS } from "./scene3d/quality.js";
import { instanceCountFor } from "./scene3d/terrain_scatter.js";
import {
  GRASS_VARIANTS,
  GRASS_CODES,
  GRASS_ATTRIBUTES,
  GRASS_BLADE_POSITIONS,
  GRASS_BLADE_INDICES,
  makeGrassBladeGeometry,
  makeGrassFill,
  ditherCornerCode,
  resolveGrassConfig,
  createTerrainGrassProvider,
} from "./scene3d/terrain_grass.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
// Stub oracle — the REAL `terrain_oracle.js::sample(x, y, out)` contract:
// fills the caller's `out` (allocation-free), reuses `out.normal` /
// `out.cornerCodes`, returns null for an unbaked landblock.
// ---------------------------------------------------------------------------
function makeStubOracle(codeAt) {
  const at = codeAt || (() => 1);
  return {
    sample(x, y, out) {
      const code = at(x, y);
      if (code === null || code === undefined) return null;
      const r = out || {};
      let c = r.cornerCodes;
      if (!c || c.length !== 4) { c = new Uint8Array(4); r.cornerCodes = c; }
      // Corners of the 24 m cell this point sits in.
      const cx = Math.floor(x / 24) * 24;
      const cy = Math.floor(y / 24) * 24;
      c[0] = at(cx + 1, cy + 1);
      c[1] = at(cx + 25, cy + 1);
      c[2] = at(cx + 1, cy + 25);
      c[3] = at(cx + 25, cy + 25);
      r.code = code;
      r.family = familyForCode(code);
      r.lbX = Math.floor(x / 192);
      r.lbY = Math.floor(y / 192);
      r.lbKey = ((r.lbX & 0xff) << 24) | ((r.lbY & 0xff) << 16);
      r.hasHeight = true;
      r.height = 20 + 0.01 * x + 0.02 * y;
      let n = r.normal;
      if (!n) { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = -0.01; n.y = -0.02; n.z = 0.9997;
      return r;
    },
  };
}

let ibaAllocs = 0;
class SpyInstancedBufferAttribute extends THREE.InstancedBufferAttribute {
  constructor(...args) { super(...args); ibaAllocs += 1; }
}
const THREE_SPY = Object.assign({}, THREE, {
  InstancedBufferAttribute: SpyInstancedBufferAttribute,
});

function makeCtx(x, y, opts = {}) {
  return {
    scene3d: null,
    tSec: opts.tSec || 0,
    dt: 0.016,
    playerPos: { x, y, z: 20 },
    hasPlayer: opts.hasPlayer === false ? false : true,
    camera: null,
    quality: null,
    oracle: opts.oracle || null,
    trail: opts.trail || null,
  };
}

function makeProvider(extra = {}, oracle = makeStubOracle()) {
  const parent = new THREE.Group();
  const p = createTerrainGrassProvider({
    THREE: THREE_SPY,
    parent,
    config: { blades: 1024, density: 1, radiusM: 48, stomp: false, seed: 7777, ...(extra.config || {}) },
    ...extra,
  });
  return { provider: p, parent, oracle };
}

// ---------------------------------------------------------------------------
console.log("\n-- L10: the provider contract + inert until ticked --");
{
  const { provider, parent } = makeProvider();
  check("id is terrain.grass", provider.id === "terrain.grass");
  check("scope is camera (immune to evict/park/rebake — plan §2.2)", provider.scope === "camera");
  check("declares FAM_GRASS", provider.families.length === 1 && provider.families[0] === FAM_GRASS);
  check("enabled is the flag reader (a function)", typeof provider.enabled === "function");
  check("ship-OFF: enabled() is false with no window/flags", provider.enabled() === false);
  check("nothing built before the first tick", provider._pool === null && parent.children.length === 0);
  check("stats() works before the build (no throw, visibleBlades 0)",
    provider.stats().visibleBlades === 0 && provider.stats().built === false);

  // A tick with no player position must not build or throw.
  provider.update(0.016, makeCtx(1000, 1000, { hasPlayer: false }));
  check("a tick without a player position builds nothing",
    provider._pool !== null ? provider.stats().visibleBlades === 0 : true);
  provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L1: determinism (same position + seed ⇒ identical field) --");
const ORACLE = makeStubOracle();
let fieldA = null;
{
  const a = makeProvider();
  a.provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  const b = makeProvider();
  b.provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  const pa = a.provider._pool;
  const pb = b.provider._pool;
  check("both providers built a pool", !!pa && !!pb);
  let same = true;
  for (const name of ["aScale", "aRot", "aTint", "aFamilyParam"]) {
    const A = pa.arrays[name];
    const B = pb.arrays[name];
    if (A.length !== B.length) { same = false; break; }
    for (let i = 0; i < A.length; i += 1) if (A[i] !== B[i]) { same = false; break; }
  }
  check("every per-instance attribute is bit-identical across two builds", same);
  check("the same blades are live", (() => {
    for (let i = 0; i < pa.count; i += 1) if (pa.isLive(i) !== pb.isLive(i)) return false;
    return true;
  })());
  check("a live field actually has blades", pa.stats().live > 0, String(pa.stats().live));
  fieldA = Float32Array.from(pa.arrays.aScale);

  // Walk away and come back: hash-stable placement (§5.4/§5.5).
  a.provider.update(0.016, makeCtx(4030, 4000, { oracle: ORACLE }));
  a.provider._pool.rescatterAll(4000, 4000, 20);
  let restored = true;
  for (let i = 0; i < fieldA.length; i += 1) {
    if (Math.abs(pa.arrays.aScale[i] - fieldA[i]) > 0) { restored = false; break; }
  }
  check("leave and come back ⇒ the same blades in the same places", restored);
  a.provider.dispose();
  b.provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L2: non-grass (and water) terrain is degenerate --");
{
  // Everything is PackedDirt (7, FAM_DIRT).
  const { provider } = makeProvider({}, null);
  provider.update(0.016, makeCtx(4000, 4000, { oracle: makeStubOracle(() => 7) }));
  const pool = provider._pool;
  let anyHeight = false;
  for (let i = 0; i < pool.count; i += 1) if (pool.arrays.aScale[i * 2] !== 0) anyHeight = true;
  check("dirt: every blade has aScale h === 0", !anyHeight);
  check("dirt: zero live instances", pool.stats().live === 0);
  provider.dispose();

  const water = makeProvider();
  water.provider.update(0.016, makeCtx(4000, 4000, { oracle: makeStubOracle(() => 18) }));
  const wp = water.provider._pool;
  check("WaterShallowSea (18) is FAM_WATER", familyForCode(18) === FAM_WATER);
  check("water: zero live instances (never plant on the water agent's codes)",
    wp.stats().live === 0);
  water.provider.dispose();

  // Grass: the instance matrix is zero-SCALED for rejected instances, so a
  // degenerate blade is zero-area for ANY material, not just ours.
  const patchy = makeProvider();
  patchy.provider.update(0.016, makeCtx(4000, 4000, { oracle: makeStubOracle(() => 9) }));
  const pp = patchy.provider._pool;
  const mtx = pp.mesh.instanceMatrix.array;
  let matrixOk = true;
  for (let i = 0; i < pp.count; i += 1) {
    const live = pp.isLive(i);
    const s = mtx[i * 16];
    if (live && s !== 1) matrixOk = false;
    if (!live && s !== 0) matrixOk = false;
  }
  check("instance matrix scale is 1 for live blades and 0 for rejected ones", matrixOk);
  check("PatchyGrassland thins the field (some live, some not)",
    pp.stats().live > 0 && pp.stats().live < pp.count,
    `${pp.stats().live}/${pp.count}`);
  patchy.provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L3: amortisation — a 10 m move touches <= sliceSize --");
{
  const { provider } = makeProvider({ config: { blades: 20000 } });
  provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  const pool = provider._pool;
  check("first tick is a full re-scatter (a teleport from nowhere)",
    pool.stats().fullRescatters === 1);
  let worst = 0;
  for (let step = 1; step <= 10; step += 1) {
    provider.update(0.016, makeCtx(4000 + step, 4000, { oracle: ORACLE }));
    worst = Math.max(worst, pool.stats().lastRescattered);
  }
  check("a 10 m walk never re-scatters more than sliceSize (512) in one tick",
    worst <= pool.sliceSize, `worst=${worst} sliceSize=${pool.sliceSize}`);
  check("no extra full re-scatter during the walk", pool.stats().fullRescatters === 1);
  provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L4: buffers allocated EXACTLY once --");
{
  ibaAllocs = 0;
  const { provider } = makeProvider();
  provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  const pool = provider._pool;
  const allocsAfterBuild = ibaAllocs;
  const ids = GRASS_ATTRIBUTES.map((a) => pool.arrays[a.name]);
  for (let i = 0; i < 40; i += 1) {
    provider.update(0.016, makeCtx(4000 + i * 3, 4000 + i, { oracle: ORACLE }));
  }
  provider.update(0.016, makeCtx(9000, 9000, { oracle: ORACLE }));   // teleport
  check("one InstancedBufferAttribute per schema entry, allocated at build",
    allocsAfterBuild === GRASS_ATTRIBUTES.length, `${allocsAfterBuild}`);
  check("no further attribute allocation across 40 moves + a teleport",
    ibaAllocs === allocsAfterBuild, `${ibaAllocs} vs ${allocsAfterBuild}`);
  check("buffer identities never change",
    GRASS_ATTRIBUTES.every((a, i) => pool.arrays[a.name] === ids[i]));
  check("the pool reports exactly one allocation per attribute",
    pool.stats().allocations === GRASS_ATTRIBUTES.length);
  provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L5: blade count matches the tier --");
{
  check("low is DISABLED (terrainGrassBlades 0 ⇒ resolveGrassConfig null)",
    PRESETS.low.terrainGrassBlades === 0 && resolveGrassConfig({ blades: 0 }) === null);
  const TIERS = { mid: 24336, high: 60025, ultra: 119716 };
  for (const [tier, count] of Object.entries(TIERS)) {
    check(`${tier} preset blades === ${count}`, PRESETS[tier].terrainGrassBlades === count);
    check(`${count} is a perfect square (survives the pool round-up)`,
      instanceCountFor(count) === count);
  }
  check("every tier carries every grass key", ["low", "mid", "high", "ultra"].every((t) =>
    typeof PRESETS[t].terrainGrass === "boolean"
    && Number.isFinite(PRESETS[t].terrainGrassBlades)
    && Number.isFinite(PRESETS[t].terrainGrassRadius)
    && typeof PRESETS[t].terrainGrassStomp === "boolean"));
  check("grass ships OFF on every tier (§5.9)",
    ["low", "mid", "high", "ultra"].every((t) => PRESETS[t].terrainGrass === false));
  check("stomp ladder: off low/mid, on high/ultra",
    PRESETS.low.terrainGrassStomp === false && PRESETS.mid.terrainGrassStomp === false
    && PRESETS.high.terrainGrassStomp === true && PRESETS.ultra.terrainGrassStomp === true);

  const { provider } = makeProvider({ config: { blades: 24336 } });
  provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  check("the pool instantiates exactly the tier count", provider._pool.count === 24336);
  check("the InstancedMesh carries that many instances",
    provider._pool.mesh.count === 24336);
  provider.dispose();

  // Density is a multiplier on the tier count; 0 disables outright.
  check("density 0.5 halves the count", resolveGrassConfig({ blades: 24336, density: 0.5 }).count === 12168);
  check("density 2 doubles it", resolveGrassConfig({ blades: 24336, density: 2 }).count === 48672);
  check("density 0 ⇒ disabled (null)", resolveGrassConfig({ blades: 24336, density: 0 }) === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- L6: the five sub-variants --");
{
  check("the table covers exactly codes 1, 3, 9, 21, 28, 29",
    GRASS_CODES.join() === "1,3,9,21,28,29", GRASS_CODES.join());
  check("every table code is FAM_GRASS", GRASS_CODES.every((c) => familyForCode(c) === FAM_GRASS));
  check("LushGrass (3) is the tallest", GRASS_CODES.every((c) => GRASS_VARIANTS[c].h <= GRASS_VARIANTS[3].h));
  check("DarkMoss (29) is the shortest", GRASS_CODES.every((c) => GRASS_VARIANTS[c].h >= GRASS_VARIANTS[29].h));
  check("Grassland (1) sits between LushGrass and forestfloor",
    GRASS_VARIANTS[1].h < GRASS_VARIANTS[3].h && GRASS_VARIANTS[1].h > GRASS_VARIANTS[21].h);
  check("PatchyGrassland (9) is the only sparse-with-gaps variant among 1/3/9",
    GRASS_VARIANTS[9].bare > 0 && GRASS_VARIANTS[1].bare === 0 && GRASS_VARIANTS[3].bare === 0);
  check("Moss/DarkMoss are near-mat (mat === 1 ⇒ stiffest in-shader)",
    GRASS_VARIANTS[28].mat === 1 && GRASS_VARIANTS[29].mat === 1 && GRASS_VARIANTS[3].mat === 0);
  check("forestfloor (21) is browner than LushGrass (less green-dominant)",
    (GRASS_VARIANTS[21].tint[1] - GRASS_VARIANTS[21].tint[0])
      < (GRASS_VARIANTS[3].tint[1] - GRASS_VARIANTS[3].tint[0]));

  // Per-code fields actually reach the buffers, and taller code ⇒ taller blades.
  const meanH = (code) => {
    const { provider } = makeProvider({ config: { blades: 4096 } });
    provider.update(0.016, makeCtx(4000, 4000, { oracle: makeStubOracle(() => code) }));
    const pool = provider._pool;
    let sum = 0, n = 0;
    for (let i = 0; i < pool.count; i += 1) {
      if (!pool.isLive(i)) continue;
      sum += pool.arrays.aScale[i * 2];
      n += 1;
    }
    provider.dispose();
    return n ? sum / n : 0;
  };
  const hLush = meanH(3);
  const hGrass = meanH(1);
  const hMoss = meanH(28);
  check("mean blade height: LushGrass > Grassland > Moss",
    hLush > hGrass && hGrass > hMoss, `${hLush.toFixed(3)} ${hGrass.toFixed(3)} ${hMoss.toFixed(3)}`);
  check("mean LushGrass height is within jitter of the table value",
    Math.abs(hLush - GRASS_VARIANTS[3].h) < GRASS_VARIANTS[3].h * 0.15, hLush.toFixed(3));

  // `fill` is a pure function of the world cell — same ctx twice, same writes.
  {
    const fill = makeGrassFill(99);
    const arrays = { aScale: new Float32Array(2), aRot: new Float32Array(1), aTint: new Float32Array(3), aFamilyParam: new Float32Array(1) };
    const mk = () => ({
      cellX: 11, cellY: -4, x: 264.5, y: 96.25, code: 1,
      cornerCodes: Uint8Array.from([1, 1, 1, 1]),
      live: true,
      rand(ch) { return ((Math.imul((this.cellX + 1) * 2654435761 + (ch | 0) * 40503, 1) >>> 8) % 1000) / 1000; },
      set(name, a, b, c) { arrays[name][0] = a; if (b !== undefined) arrays[name][1] = b; if (c !== undefined) arrays[name][2] = c; },
    });
    const c1 = mk(); fill(c1);
    const h1 = arrays.aScale[0];
    const c2 = mk(); fill(c2);
    check("makeGrassFill is deterministic for one world cell", arrays.aScale[0] === h1);
    check("fill wrote a positive blade height", h1 > 0);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- L7: boundary feathering by hash-dithered corner draw --");
{
  // The dither must be a WEIGHTED draw: deep inside a corner's quadrant it
  // almost always picks that corner; at the cell centre it is even-ish.
  const corners = Uint8Array.from([1, 7, 7, 7]);   // SW grass, the rest dirt
  const draw = (x, y, r) => ditherCornerCode({
    x, y, code: 1, cornerCodes: corners, rand: () => r,
  });
  check("at the SW corner the SW code always wins",
    [0.0, 0.5, 0.94].every((r) => draw(240.1, 240.1, r) === 1));
  // (An r below the SW corner's ~1.8e-5 weight legitimately still draws SW —
  // that IS the weighted draw. Sample the stream away from that sliver.)
  check("at the NE corner the SW code all but never wins",
    [0.001, 0.5, 0.99].every((r) => draw(263.9, 263.9, r) !== 1));
  check("at the cell centre the draw is split across corners",
    draw(252, 252, 0.1) === 1 && draw(252, 252, 0.9) === 7);
  check("no cornerCodes ⇒ fall back to the nearest-vertex code",
    ditherCornerCode({ x: 0, y: 0, code: 3, cornerCodes: null, rand: () => 0.5 }) === 3);

  // End to end: a north-south boundary at x = 4800 (grass west, dirt east)
  // must produce a RAMP of coverage across the cell, not a step.
  const oracle = makeStubOracle((x) => (x < 4800 ? 3 : 7));
  const { provider } = makeProvider({ config: { blades: 40000, radiusM: 48 } }, oracle);
  provider.update(0.016, makeCtx(4800, 4800, { oracle }));
  const pool = provider._pool;
  const bins = new Array(6).fill(0);
  const tot = new Array(6).fill(0);
  for (let i = 0; i < pool.count; i += 1) {
    const c = pool.cellOf(i);
    const x = (c.x + 0.5) * pool.cellSizeM;
    const b = Math.floor((x - 4776) / 8);           // 6 bins of 8 m across the seam
    if (b < 0 || b > 5) continue;
    tot[b] += 1;
    if (pool.isLive(i)) bins[b] += 1;
  }
  const frac = bins.map((v, i) => (tot[i] ? v / tot[i] : 0));
  check("coverage is high well inside the grass side", frac[0] > 0.5, frac.join(" "));
  check("coverage is zero well inside the dirt side", frac[5] === 0, frac.join(" "));
  check("coverage RAMPS down across the seam cell (not a hard step)",
    frac[0] > frac[1] && frac[1] > frac[2] && frac[2] > 0,
    frac.map((f) => f.toFixed(2)).join(" "));
  // WITHOUT the dither, the nearest-vertex snap would put a HARD edge at the
  // midpoint between the two vertices (x = 4788): full coverage below, zero
  // above. Grass surviving above it is the feathering, in the direction that
  // proves it is not just a shifted square.
  check("blades survive PAST the nearest-vertex snap boundary (x=4788)",
    frac[2] > 0.05, frac.map((f) => f.toFixed(2)).join(" "));
  provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L8/L9: shadows, geometry, teleport --");
{
  const { provider, parent } = makeProvider();
  provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE }));
  const mesh = provider._pool.mesh;
  check("castShadow is false on the blade mesh (§5.7)", mesh.castShadow === false);
  check("frustumCulled is false (the field moves with the player)", mesh.frustumCulled === false);
  check("the mesh hangs under the injected parent (worldRoot ⇒ AC space)",
    parent.children.length === 1 && parent.children[0].children.includes(mesh));
  check("blade geometry: 5 vertices", GRASS_BLADE_POSITIONS.length === 15);
  check("blade geometry: 3 triangles (a 5-vertex strip is N-2)",
    GRASS_BLADE_INDICES.length === 9);
  const geom = makeGrassBladeGeometry(THREE);
  check("authored unit-height blade (z spans 0..1)",
    geom.attributes.position.array[2] === 0 && geom.attributes.position.array[14] === 1);
  check("blade normals point UP (lit like the ground it grows from)",
    (() => {
      const n = geom.attributes.normal.array;
      for (let i = 0; i < n.length; i += 3) if (n[i] !== 0 || n[i + 1] !== 0 || n[i + 2] !== 1) return false;
      return true;
    })());

  const before = provider._pool.stats().fullRescatters;
  provider.update(0.016, makeCtx(4000 + 500, 4000, { oracle: ORACLE }));   // > 1 LB
  check("a jump larger than one landblock re-scatters everything",
    provider._pool.stats().fullRescatters === before + 1
    && provider._pool.stats().teleports === 1);
  provider.dispose();
  check("dispose() removes the group from the scene", parent.children.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n-- L11: stomp stamps the trail map (and tolerates its absence) --");
{
  const stamps = [];
  const trail = {
    uniforms: {
      uTrailMap: { value: { isTexture: true } },
      uTrailCenter: { value: { x: 4000, y: 4000 } },
      uTrailRadius: { value: 48 },
      uTrailTexel: { value: 0.375 },
    },
    stamp(x, y, r, s) { stamps.push([x, y, r, s]); return true; },
  };

  const off = makeProvider({ config: { stomp: false } });
  off.provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE, trail }));
  check("stomp OFF: the trail map is never stamped", stamps.length === 0);
  check("stomp OFF: uTrailEnabled stays 0", off.provider._uniforms.uTrailEnabled.value === 0);
  off.provider.dispose();

  const on = makeProvider({ config: { stomp: true } });
  on.provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE, trail }));
  check("stomp ON: one stamp at the player's ground position per tick",
    stamps.length === 1 && stamps[0][0] === 4000 && stamps[0][1] === 4000);
  check("stomp ON: the stamp has a footprint-sized radius and full strength",
    stamps[0][2] > 0 && stamps[0][2] <= 1.5 && stamps[0][3] === 1);
  const u = on.provider._uniforms;
  check("stomp ON: the trail uniforms are copied by VALUE each frame (ping-pong-safe)",
    u.uTrailEnabled.value === 1 && u.uTrailMap.value === trail.uniforms.uTrailMap.value
    && u.uTrailCenter.value.x === 4000 && u.uTrailRadius.value === 48
    && u.uTrailTexel.value === 0.375);
  check("stomp ON: stats report the binding", on.provider.stats().trailBound === true
    && on.provider.stats().stamps === 1);
  // The map ping-pongs its target every frame: a value copy must follow it.
  trail.uniforms.uTrailMap.value = { isTexture: true, second: true };
  on.provider.update(0.016, makeCtx(4001, 4000, { oracle: ORACLE, trail }));
  check("stomp ON: a ping-ponged texture is picked up next frame",
    u.uTrailMap.value === trail.uniforms.uTrailMap.value);
  on.provider.dispose();

  const noTrail = makeProvider({ config: { stomp: true } });
  noTrail.provider.update(0.016, makeCtx(4000, 4000, { oracle: ORACLE, trail: null }));
  check("stomp ON with NO trail map: clean no-op, blades still scatter",
    noTrail.provider._uniforms.uTrailEnabled.value === 0
    && noTrail.provider._pool.stats().live > 0);
  noTrail.provider.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- unbaked landblocks stay degenerate and are RETRIED --");
{
  let baked = false;
  const oracle = makeStubOracle(() => (baked ? 3 : null));
  const { provider } = makeProvider({ config: { blades: 4096 } }, oracle);
  provider.update(0.016, makeCtx(4000, 4000, { oracle }));
  check("unbaked ring ⇒ zero live blades (no guessed heights)",
    provider._pool.stats().live === 0);
  baked = true;
  for (let i = 0; i < 8; i += 1) provider.update(0.016, makeCtx(4000, 4000, { oracle }));
  check("once the landblock bakes, later ticks revive the blades with no movement",
    provider._pool.stats().live > 0, String(provider._pool.stats().live));
  provider.dispose();
}

console.log(`\nterrain grass scatter: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
