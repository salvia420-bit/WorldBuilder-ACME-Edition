// test_terrain_sand.mjs — SAND / DESERT terrain VFX (Wave 1B,
// `scene3d/terrain_sand.js` + `scene3d/vfx/components/terrainDustDevil.js`).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.2 "Tests", plus the invariants
// §5.1-§5.9 every terrain-VFX module signs up to):
//   L1  ADVECTION IS A PURE FUNCTION of (wind, clock, hash). No player state,
//       no frame history, no `Math.random`: same inputs ⇒ same offset, forever,
//       on every client. It is bounded by the recycle span and it REVERSES with
//       the wind.
//   L2  A streamer over a NON-SAND code is CULLED (written degenerate by the
//       pool's family gate) — nothing is ever placed on grass, rock or water
//       (plan §3.8.1: "every scatter/emitter path filters family !== FAM_WATER").
//   L3  DEVIL SPAWN IS HASH-STABLE per lbKey: two calls, and a call with the
//       landblock's grids re-created, produce byte-identical placements, and
//       every devil stands on a FAM_SAND vertex.
//   L4  PARK STOPS EMISSION AND DESTROYS NOTHING: `emitterCountForOwner(key)`
//       is unchanged across a park, and `destroyAllForOwner` is not called.
//   L5  EVICT calls `destroyAllForOwner` EXACTLY ONCE, on the sand-scoped owner
//       key — never on the bare `static:<lb>` key, which would reap the
//       landblock's brazier/foliage emitters on a mere terrain LOD rebake.
//   L6  SHIP-OFF: with no URL flags every sand flag reads false and
//       `initTerrainSand` registers NOTHING and allocates NOTHING.
//   L7  The quality ladder matches plan §3.2 (`low: null`), and the sand code
//       set is DERIVED from `terrain_families.js`, never hardcoded.
//   L8  The dust-devil DESCRIPTOR passes the VFX firewall: the manifest lint
//       (layer A) and the source denylist (layer B — a per-component test
//       responsibility, plan §5.1), `lightCountDelta 0`, `cacheKeyScope "none"`,
//       `linkVariant() === ""`, and a gated-out env synthesizes NO emitter.
//   L9  The devil's rotation is a REAL circle: `ParticleType.Swarm` with
//       `b.x == |b.y|` and `c.x == c.y` (x uses cos, y uses sin in the retail
//       integrator, so unequal pairs would draw a Lissajous figure, not a
//       vortex).
//   L10 `castShadow === false` on the streamer mesh (§5.7 — added geometry is
//       paid a second time by the shadow depth pass), and the field runs
//       headless with no THREE at all (the `?nullRender=1` path).
//
// Run from apps/holtburger-web/:  node test_terrain_sand.mjs
// (`three` resolves as a bare import via node_modules — the plan §6 tier for
// anything touching InstancedMesh.)

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FAM_SAND, FAM_GRASS, familyForCode } from "./scene3d/terrain_families.js";
import { lintManifest, lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// URL + quality harness. Every flag reader memoizes, so the window has to be in
// place BEFORE the first read and `_resetVfxFlags()` after every change.
// ---------------------------------------------------------------------------
const HIGH_FLAGS = {
  terrainSand: false,
  terrainSandStreamerCount: 2000,
  terrainSandDevilCount: 1,
  terrainSandSparkle: true,
  terrainSandRadius: 64,
};
function setUrl(search, qualityFlags = HIGH_FLAGS) {
  globalThis.window = {
    location: { search },
    liveScene3d: { quality: { flags: { ...qualityFlags } } },
  };
}
function clearUrl() { delete globalThis.window; }

const { _resetVfxFlags, terrainSandEnabled, terrainSandStreamersEnabled,
  terrainSandDevilsEnabled, terrainSandSparkleEnabled, vfxEffectEnabled,
  VFX_EFFECT_FLAGS } = await import("./scene3d/vfx_flags.js");

const sand = await import("./scene3d/terrain_sand.js");
const { terrainDustDevil, dustDevilGate, devilHash01 } =
  await import("./scene3d/vfx/components/terrainDustDevil.js");
const vfx = await import("./scene3d/terrain_vfx.js");

// ===========================================================================
console.log("\n-- L7 family + quality ----------------------------------------");
// ===========================================================================
check("sand codes are DERIVED from terrain_families (10, 11, 12)",
  JSON.stringify(sand.sandTerrainCodes()) === JSON.stringify([10, 11, 12]),
  JSON.stringify(sand.sandTerrainCodes()));
check("every derived sand code really is FAM_SAND",
  sand.sandTerrainCodes().every((c) => familyForCode(c) === FAM_SAND));
check("sandCodeBitmask() sets exactly bits 10..12",
  sand.sandCodeBitmask() === ((1 << 10) | (1 << 11) | (1 << 12)),
  sand.sandCodeBitmask().toString(2));
check("no sand code is water/grass (the family sets are disjoint)",
  sand.sandTerrainCodes().every((c) => familyForCode(c) !== FAM_GRASS));

check("quality low ⇒ null (plan §3.2 'low: null', §5.8)",
  sand.resolveSandQuality({
    terrainSand: false, terrainSandStreamerCount: 0, terrainSandDevilCount: 0,
    terrainSandSparkle: false, terrainSandRadius: 32,
  }) === null);
const qMid = sand.resolveSandQuality({
  terrainSandStreamerCount: 800, terrainSandDevilCount: 0,
  terrainSandSparkle: true, terrainSandRadius: 48,
});
check("quality mid ⇒ {streamers:800, devils:0, sparkle:true}",
  qMid && qMid.streamerCount === 800 && qMid.devilCount === 0 && qMid.sparkle === true,
  JSON.stringify(qMid));
const qHigh = sand.resolveSandQuality(HIGH_FLAGS);
const qUltra = sand.resolveSandQuality({
  terrainSandStreamerCount: 3000, terrainSandDevilCount: 2,
  terrainSandSparkle: true, terrainSandRadius: 80,
});
check("quality high ⇒ {2000, 1, true}",
  qHigh.streamerCount === 2000 && qHigh.devilCount === 1 && qHigh.sparkle === true);
check("quality ultra ⇒ {3000, 2, true}",
  qUltra.streamerCount === 3000 && qUltra.devilCount === 2 && qUltra.sparkle === true);
check("a missing flag bag ⇒ null (never a silent default-on)",
  sand.resolveSandQuality(null) === null && sand.resolveSandQuality({}) === null);

// ===========================================================================
console.log("\n-- L6 ship-OFF -------------------------------------------------");
// ===========================================================================
clearUrl(); _resetVfxFlags();
check("no window: every sand flag reads false",
  terrainSandEnabled() === false && terrainSandStreamersEnabled() === false
  && terrainSandDevilsEnabled() === false && terrainSandSparkleEnabled() === false);
setUrl(""); _resetVfxFlags();
check("no flags + a high-tier preset: the MASTER is still off (ship-OFF, §5.9)",
  terrainSandEnabled() === false);
check("no flags: initTerrainSand registers NOTHING",
  sand.initTerrainSand({ scene3d: {} }) === null
  && sand.terrainSandStats().inited === false);
setUrl("?terrainSand=1"); _resetVfxFlags();
check("?terrainSand=1 does NOT enable (strict exact-match opt-in, plan §2.4)",
  terrainSandEnabled() === false);
setUrl("?terrainSand=on"); _resetVfxFlags();
check("?terrainSand=on enables the master", terrainSandEnabled() === true);
check("?terrainSand=on + high tier ⇒ streamers/devils/sparkle all on via the preset",
  terrainSandStreamersEnabled() === true && terrainSandDevilsEnabled() === true
  && terrainSandSparkleEnabled() === true);
setUrl("?terrainSand=on&terrainSandDevils=off"); _resetVfxFlags();
check("?terrainSandDevils=off opts one effect out",
  terrainSandEnabled() === true && terrainSandDevilsEnabled() === false
  && terrainSandStreamersEnabled() === true);
setUrl("?terrainSand=on", {
  terrainSand: false, terrainSandStreamerCount: 0, terrainSandDevilCount: 0,
  terrainSandSparkle: false, terrainSandRadius: 32,
});
_resetVfxFlags();
check("?terrainSand=on at the LOW tier lights nothing (low is null)",
  terrainSandStreamersEnabled() === false && terrainSandDevilsEnabled() === false
  && terrainSandSparkleEnabled() === false);
setUrl("?terrainSand=on"); _resetVfxFlags();
check("all four sand rows are registered in VFX_EFFECT_FLAGS (so ?visual=off kills them)",
  ["terrain.sand", "terrain.sandStreamers", "terrain.sandDevils", "terrain.sandSparkle"]
    .every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"));
setUrl("?visual=off&terrainSand=on"); _resetVfxFlags();
check("?visual=off kills the family through the router",
  ["terrain.sand", "terrain.sandStreamers", "terrain.sandDevils", "terrain.sandSparkle"]
    .every((id) => vfxEffectEnabled(id) === false));

// ===========================================================================
console.log("\n-- L1 advection is pure in (wind, clock, hash) ------------------");
// ===========================================================================
const SPAN = 26, SPEED = 3.2;
const a1 = sand.streamerAdvect(1, 0, 12.5, 0.3, SPAN, SPEED);
const a2 = sand.streamerAdvect(1, 0, 12.5, 0.3, SPAN, SPEED);
check("same (wind, t, hash) ⇒ same offset",
  near(a1.x, a2.x) && near(a1.y, a2.y));
const a3 = sand.streamerAdvect(1, 0, 12.5, 0.31, SPAN, SPEED);
check("a different hash ⇒ a different offset (streaks do not move in lockstep)",
  !near(a1.s, a3.s, 1e-6));
const a4 = sand.streamerAdvect(1, 0, 13.5, 0.3, SPAN, SPEED);
check("a different clock ⇒ a different offset (it MOVES)", !near(a1.s, a4.s, 1e-6));
let bounded = true;
for (let i = 0; i < 400; i += 1) {
  const r = sand.streamerAdvect(0.6, -0.8, i * 0.37, (i * 0.017) % 1, SPAN, SPEED);
  if (Math.abs(r.s) > SPAN * 0.5 + 1e-9) bounded = false;
  if (Math.abs(Math.hypot(r.x, r.y) - Math.abs(r.s)) > 1e-9) bounded = false;
}
check("the offset stays inside the recycle span and lies ALONG the wind", bounded);
const east = sand.streamerAdvect(1, 0, 3.0, 0.0, SPAN, SPEED);
const west = sand.streamerAdvect(-1, 0, 3.0, 0.0, SPAN, SPEED);
check("reversing the wind mirrors the offset", near(east.x, -west.x, 1e-9));
const calm = sand.streamerAdvect(0.25, 0, 3.0, 0.0, SPAN, SPEED);
const gust = sand.streamerAdvect(1.0, 0, 3.0, 0.0, SPAN, SPEED);
check("wind MAGNITUDE scales the travel (a gust blows harder)",
  Math.abs(gust.s) !== Math.abs(calm.s));
check("no Math.random anywhere in terrain_sand.js (§5.5)",
  !/Math\.random\s*\(/.test(readFileSync("./scene3d/terrain_sand.js", "utf8")));

// The GLSL twin must compute the same expression. Assert the shape textually
// (a GPU is not available here) — the two must not drift silently.
const VGLSL = sand.SAND_STREAMER_VERTEX_GLSL;
check("the streamer vertex GLSL advects with the SAME expression as streamerAdvect",
  /float travelled = uTime \* uSpeed \* aStreak\.y \* wl \+ aStreak\.x \* uSpanM;/.test(VGLSL)
  && /mod\(travelled, uSpanM\) - uSpanM \* 0\.5/.test(VGLSL));
check("the streamer GLSL reads instanceMatrix (degenerate instances are zero-area)",
  /instanceMatrix \* vec4\(local, 1\.0\)/.test(VGLSL));
check("the streamer GLSL uses the SHARED scatter fade helper (one fade law)",
  /hbScatterFade\(/.test(VGLSL) && /uniform vec3 uScatterCenter;/.test(VGLSL));
check("the streamer GLSL declares uTime exactly once", (VGLSL.match(/uniform float uTime;/g) || []).length === 1);
check("no backticks in the streamer GLSL (they would close the JS literal)",
  !VGLSL.includes("`") && !sand.SAND_STREAMER_FRAGMENT_GLSL.includes("`"));

// ===========================================================================
console.log("\n-- L2 a streamer over a non-sand code is culled -----------------");
// ===========================================================================
function makeOracle(codeAt) {
  const st = { samples: 0 };
  return {
    _stats: st,
    sample(x, y, out) {
      st.samples += 1;
      const code = codeAt(x, y);
      if (code === null) return null;
      const r = out || {};
      r.code = code;
      r.family = familyForCode(code);
      r.hasHeight = true;
      r.height = 20 + 0.01 * x;
      let n = r.normal;
      if (!n) { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = 0; n.y = 0; n.z = 1;
      return r;
    },
    heightAt(x) { return 20 + 0.01 * x; },
  };
}

const grassField = sand.createSandStreamerField({
  oracle: makeOracle(() => 1), count: 400, radiusM: 32, seed: 7,
});
grassField.pool.rescatterAll(1000, 1000, 20);
check("all-grass ground ⇒ ZERO live streamers", grassField.pool.stats().live === 0);
check("all-grass ground ⇒ the rejects are FAMILY rejects, not silent drops",
  grassField.pool.stats().familyRejects > 0);

const sandFieldAll = sand.createSandStreamerField({
  oracle: makeOracle(() => 10), count: 400, radiusM: 32, seed: 7,
});
sandFieldAll.pool.rescatterAll(1000, 1000, 20);
check("all-sand ground ⇒ live streamers", sandFieldAll.pool.stats().live > 0);

// Half sand / half grass: every LIVE instance must be on the sand half.
const splitField = sand.createSandStreamerField({
  oracle: makeOracle((x) => (x >= 1000 ? 11 : 1)), count: 900, radiusM: 32, seed: 11,
});
splitField.pool.rescatterAll(1000, 1000, 20);
let allLiveOnSand = true;
let liveCount = 0;
const off = splitField.pool.arrays.aOffset;
for (let i = 0; i < splitField.pool.count; i += 1) {
  if (!splitField.pool.isLive(i)) continue;
  liveCount += 1;
  if (off[i * 3] < 1000) allLiveOnSand = false;
}
check("mixed ground: EVERY live streamer sits on a sand sample", allLiveOnSand && liveCount > 0,
  `live=${liveCount}`);
check("mixed ground: the grass half is degenerate, not absent",
  splitField.pool.stats().degenerate > 0);

// Water is a family like any other — it is simply not FAM_SAND, so it is culled
// by the same gate (plan §3.8.1).
const waterField = sand.createSandStreamerField({
  oracle: makeOracle(() => 18), count: 256, radiusM: 32, seed: 3,
});
waterField.pool.rescatterAll(0, 0, 0);
check("water ground ⇒ ZERO live streamers (plan §3.8.1)", waterField.pool.stats().live === 0);

// ===========================================================================
console.log("\n-- L10 lift, headless mode, castShadow -------------------------");
// ===========================================================================
let liftOk = true;
const liveIdx = [];
for (let i = 0; i < sandFieldAll.pool.count; i += 1) if (sandFieldAll.pool.isLive(i)) liveIdx.push(i);
for (const i of liveIdx) {
  const x = sandFieldAll.pool.arrays.aOffset[i * 3];
  const z = sandFieldAll.pool.arrays.aOffset[i * 3 + 2];
  const lift = z - (20 + 0.01 * x);
  if (lift < 0.05 - 1e-6 || lift > 0.4 + 1e-6) liftOk = false;
}
check("every streamer sits 0.05..0.4 m above the ground (plan §3.2)", liftOk);
check("headless (no THREE): no mesh, no material, full CPU bookkeeping",
  sandFieldAll.mesh === null && sandFieldAll.material === null
  && sandFieldAll.pool.stats().rescatters > 0);

const gpuField = sand.createSandStreamerField({
  THREE, oracle: makeOracle(() => 12), count: 100, radiusM: 24, seed: 5,
});
check("with THREE: an InstancedMesh is built", !!gpuField.mesh && gpuField.mesh.isInstancedMesh === true);
check("castShadow === false on the streamer mesh (§5.7)", gpuField.mesh.castShadow === false);
check("frustumCulled === false (the window follows the player)", gpuField.mesh.frustumCulled === false);
check("additive, depth-write OFF (an additive ground pass must not occlude)",
  gpuField.material.blending === THREE.AdditiveBlending && gpuField.material.depthWrite === false);
check("the material binds the pool's scatter uniforms BY REFERENCE (§5.6)",
  gpuField.material.uniforms.uScatterCenter === gpuField.pool.uniforms.uScatterCenter
  && gpuField.material.uniforms.uScatterRadius === gpuField.pool.uniforms.uScatterRadius);
// three's ShaderMaterial.customProgramCacheKey returns the onBeforeCompile
// SOURCE (empty function here); what §5.4 forbids is a key that varies per
// instance — one program per material, not one per streak.
check("no per-instance program cache key (§5.4 — one program for the field)",
  !Object.prototype.hasOwnProperty.call(gpuField.material, "customProgramCacheKey")
  && !/guid|instanceHash|aVfxHash/.test(String(gpuField.material.customProgramCacheKey())));
gpuField.update(0.016, 4.0, 100, 100, 20);
check("update() drives the shared clock uniform", gpuField.uniforms.uTime.value === 4.0);
check("update() drives the live wind uniform (AC frame)",
  Number.isFinite(gpuField.uniforms.uWindAc.value.x));
gpuField.dispose();
check("dispose() drops the mesh", gpuField.mesh === null || gpuField.pool.stats().hasMesh === false);

// Wind conversion: VFX_GLOBALS.uWindDir is three-space (x, z) and AC y is -z.
const w = sand.windAcFromGlobals({ uWindDir: { value: { x: 0.5, y: -0.25 } } }, { x: 0, y: 0 });
check("windAcFromGlobals converts three (x, z) → AC (x, -z)", w.x === 0.5 && w.y === 0.25);
const wFallback = sand.windAcFromGlobals(null, { x: 0, y: 0 });
check("windAcFromGlobals falls back to the prevailing 135° (never zero)",
  Math.abs(Math.hypot(wFallback.x, wFallback.y) - 1) < 1e-9);

// ===========================================================================
console.log("\n-- L3 devil placement is hash-stable ---------------------------");
// ===========================================================================
function lbGrids(sandCells) {
  const codes = new Uint8Array(81).fill(1);      // grass
  const heights = new Float32Array(81);
  for (let i = 0; i < 81; i += 1) heights[i] = 10 + (i % 7) * 0.5;
  for (const i of sandCells) codes[i] = 10 + (i % 3);
  return { codes, heights };
}
const SAND_CELLS = [3 * 9 + 5, 7 * 9 + 2, 0 * 9 + 0, 5 * 9 + 8];
const g1 = lbGrids(SAND_CELLS);
const g2 = lbGrids(SAND_CELLS);            // fresh arrays, same content
const LB = { lbKey: 0xab120000, lbX: 0xab, lbY: 0x12 };
const s1 = sand.devilSlotsForLandblock({ ...LB, ...g1, count: 2 });
const s2 = sand.devilSlotsForLandblock({ ...LB, ...g2, count: 2 });
check("two calls ⇒ byte-identical devil placements (hash-stable, §5.5)",
  JSON.stringify(s1) === JSON.stringify(s2));
check("the requested number of devils is placed", s1.length === 2);
check("every devil stands on a FAM_SAND vertex",
  s1.every((s) => familyForCode(s.code) === FAM_SAND));
check("devils take DISTINCT vertices", s1[0].vx !== s1[1].vx || s1[0].vy !== s1[1].vy);
check("devil world coords land inside the landblock",
  s1.every((s) => s.x >= LB.lbX * 192 && s.x <= LB.lbX * 192 + 192
    && s.y >= LB.lbY * 192 && s.y <= LB.lbY * 192 + 192));
check("devil z comes from the LB height grid", s1.every((s) => s.z >= 10 && s.z <= 14));
check("each devil carries its own deterministic seed",
  s1[0].seed !== s1[1].seed && s1.every((s) => Number.isInteger(s.seed)));
const sOther = sand.devilSlotsForLandblock({
  lbKey: 0xab130000, lbX: 0xab, lbY: 0x13, ...g1, count: 2,
});
check("a DIFFERENT landblock picks a different arrangement",
  JSON.stringify(sOther.map((s) => [s.vx, s.vy])) !== JSON.stringify(s1.map((s) => [s.vx, s.vy]))
  || sOther[0].x !== s1[0].x);
check("a landblock with NO sand gets no devils",
  sand.devilSlotsForLandblock({ ...LB, codes: new Uint8Array(81).fill(1), count: 2 }).length === 0);
check("fewer sand vertices than devils ⇒ fewer devils, never a duplicate",
  sand.devilSlotsForLandblock({ ...LB, ...lbGrids([40]), count: 3 }).length === 1);
check("count 0 ⇒ no work", sand.devilSlotsForLandblock({ ...LB, ...g1, count: 0 }).length === 0);

check("the sand owner key is DERIVED from staticOwnerKeyForLb and scoped",
  sand.sandOwnerKeyForLb(0xab12ffff) === "static:2870083584:sand"
  && sand.sandOwnerKeyForLb(0xab12ffff) === sand.sandOwnerKeyForLb(0xab120000),
  sand.sandOwnerKeyForLb(0xab12ffff));
check("the sand owner key is NOT the bare statics key (a rebake must not reap statics)",
  sand.sandOwnerKeyForLb(0xab120000) !== "static:2870083584");
check("devil emitter handles are non-zero and distinct per slot (park can find them)",
  sand.devilEmitterHandle(0) !== 0 && sand.devilEmitterHandle(0) !== sand.devilEmitterHandle(1));

// ===========================================================================
console.log("\n-- L8/L9 the dust-devil descriptor ------------------------------");
// ===========================================================================
check("Layer A: the manifest conforms to the capability vocabulary",
  lintManifest(terrainDustDevil).length === 0, lintManifest(terrainDustDevil).join("; "));
const devilSrc = readFileSync("./scene3d/vfx/components/terrainDustDevil.js", "utf8");
check("Layer B: no forbidden source pattern in the descriptor",
  lintSource(devilSrc).length === 0, lintSource(devilSrc).map((h) => h.label).join("; "));
check("lightCountDelta 0 (§5.2 — never change the light count)", terrainDustDevil.lightCountDelta === 0);
check('cacheKeyScope "none" + linkVariant "" (particles add no program, §5.4)',
  terrainDustDevil.cacheKeyScope === "none" && terrainDustDevil.linkVariant() === "");
check("deterministic: true", terrainDustDevil.deterministic === true);
check("reads/writes are the ambient-particle set",
  JSON.stringify(terrainDustDevil.reads) === JSON.stringify(["geometry", "weather", "clock"])
  && JSON.stringify(terrainDustDevil.writes) === JSON.stringify(["emitter"]));
check("the id is the terrain.* router row (so it is not treated as a default-ON effect)",
  terrainDustDevil.id === "terrain.sandDevils");

const devilCtx = {
  anchor: { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 1.7 },
  env: null, seed: 0x1234, clock: 0,
};
const spec = terrainDustDevil.emit(devilCtx)[0];
check("emit() synthesizes one emitter spec", !!spec && !!spec.emitterInfo);
check("L9: ParticleType.Swarm (5) — the retail rotational integrator",
  spec.emitterInfo.particleType === 5);
check("L9: b.x == |b.y| and c.x == c.y ⇒ a CIRCLE, not a Lissajous figure",
  near(spec.emitterInfo.bX, Math.abs(spec.emitterInfo.bY), 1e-12)
  && near(spec.emitterInfo.cX, spec.emitterInfo.cY, 1e-12));
check("L9: a positive updraft lifts the circle into a helix", spec.emitterInfo.aZ > 0);
check("L9: no lateral drift term (the column does not walk off its anchor)",
  spec.emitterInfo.aX === 0 && spec.emitterInfo.aY === 0);
check("persistent ambient (infinite particles + seconds)",
  spec.emitterInfo.totalParticles === 0 && spec.emitterInfo.totalSeconds === 0);
check("a real sprite is named (hwGfxObjId 0 would create nothing)",
  (spec.emitterInfo.hwGfxObjId >>> 0) !== 0);
check("a draw-cull radius is stamped (the RP6 degrade chain)",
  spec.emitterInfo.degradeDistanceMeters > 0);
const specSame = terrainDustDevil.emit(devilCtx)[0];
check("emit() is deterministic for a fixed seed",
  JSON.stringify(specSame.emitterInfo) === JSON.stringify(spec.emitterInfo));
const specOther = terrainDustDevil.emit({ ...devilCtx, seed: 0x9999 })[0];
check("a different seed varies the devil (period/radius/spin)",
  specOther.emitterInfo.birthrate !== spec.emitterInfo.birthrate
  || specOther.emitterInfo.cX !== spec.emitterInfo.cX);
check("devilHash01 is in [0,1) and deterministic",
  devilHash01(42) === devilHash01(42) && devilHash01(42) >= 0 && devilHash01(42) < 1);

check("gate: a storm kills devils outright", dustDevilGate({ isStorm: true }) === 0);
check("gate: rain (wetness) scales it down",
  dustDevilGate({ wetness: 0.9 }) < dustDevilGate({ wetness: 0 }));
check("gate: wind feeds it", dustDevilGate({ stormness: 0.9 }) > dustDevilGate({ stormness: 0 }));
check("gate: night fades it", dustDevilGate({ nightFactor: 1 }) < dustDevilGate({ nightFactor: 0 }));
check("gate: a null env is calm daylight (never a black hole)", dustDevilGate(null) === 1);
check("a gated-OUT env synthesizes NO emitter at all (as cheap as flag-off)",
  terrainDustDevil.emit({ ...devilCtx, env: { isStorm: true } }).length === 0);

// ===========================================================================
console.log("\n-- L4/L5 park stops, evict destroys -----------------------------");
// ===========================================================================
// A spy owner registry with the real API surface.
function makeSpyRegistry() {
  const owners = new Map();
  const calls = { add: 0, stop: [], destroyAll: [], destroySome: 0 };
  let nextId = 1000;
  return {
    calls,
    async addEmitter(ownerKey, manager, req) {
      calls.add += 1;
      if (!manager || typeof manager.addEmitter !== "function") return 0;
      const id = nextId++;
      if (!owners.has(ownerKey)) owners.set(ownerKey, new Set());
      owners.get(ownerKey).add(id);
      await manager.addEmitter(req);
      return id;
    },
    stopEmitter(ownerKey, handle) { calls.stop.push([ownerKey, handle]); return true; },
    destroySome() { calls.destroySome += 1; return 0; },
    destroyAllForOwner(ownerKey) {
      calls.destroyAll.push(ownerKey);
      const n = owners.get(ownerKey)?.size ?? 0;
      owners.delete(ownerKey);
      return n;
    },
    emitterCountForOwner(ownerKey) { return owners.get(ownerKey)?.size ?? 0; },
  };
}

const fakeManager = { added: 0, async addEmitter() { this.added += 1; return 1; } };
const spy = makeSpyRegistry();
const scene3d = { terrainGroup: { children: [], parent: null }, frameTime: { tsSec: 0 } };

setUrl("?terrainSand=on&terrainSandStreamers=off"); _resetVfxFlags();
vfx._resetTerrainVfx();
sand._resetTerrainSand();
vfx.initTerrainVfx({ scene3d });
const surface = sand.initTerrainSand({
  scene3d,
  ownerRegistry: spy,
  getParticleManager: () => fakeManager,
  readEnv: () => null,
});
check("?terrainSand=on ⇒ initTerrainSand registers the devil provider",
  !!surface && vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.sandDevils"));
check("?terrainSandStreamers=off ⇒ the streamer provider is NOT registered",
  !vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.sandStreamers"));

const lbMesh = {
  userData: { lbX: 0xab, lbY: 0x12, terrainCodes: g1.codes, heights: g1.heights },
};
vfx.terrainVfxNoteLandblockMesh(scene3d, lbMesh);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const ownerKey = sand.sandOwnerKeyForLb(vfx.lbKeyFromXY(0xab, 0x12));
check("a sand landblock spawns its devil under the sand owner key",
  spy.emitterCountForOwner(ownerKey) === 1, `count=${spy.emitterCountForOwner(ownerKey)}`);
check("the emitter really reached the ParticleManager", fakeManager.added === 1);

const beforePark = spy.emitterCountForOwner(ownerKey);
vfx.terrainVfxLandblockPark(vfx.lbKeyFromXY(0xab, 0x12));
await Promise.resolve();
check("L4: park leaves emitterCountForOwner UNCHANGED (nothing destroyed)",
  spy.emitterCountForOwner(ownerKey) === beforePark && beforePark === 1);
check("L4: park STOPS emission through the registry (never .visible=, §5.3)",
  spy.calls.stop.length === 1 && spy.calls.stop[0][0] === ownerKey);
check("L4: park does NOT call destroyAllForOwner", spy.calls.destroyAll.length === 0);

vfx.terrainVfxLandblockUnpark(vfx.lbKeyFromXY(0xab, 0x12));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
check("unpark re-arms emission (hash-stable placement, no re-scatter)",
  spy.emitterCountForOwner(ownerKey) >= 1 && spy.calls.add === 2);

const destroyBefore = spy.calls.destroyAll.length;
vfx.terrainVfxLandblockGone(vfx.lbKeyFromXY(0xab, 0x12), "evict");
check("L5: evict calls destroyAllForOwner EXACTLY ONCE",
  spy.calls.destroyAll.length === destroyBefore + 1);
check("L5: … on the SAND-scoped key, never the bare statics key",
  spy.calls.destroyAll[spy.calls.destroyAll.length - 1] === ownerKey
  && !spy.calls.destroyAll.includes("static:2870083584"));
check("L5: the owner is empty afterwards", spy.emitterCountForOwner(ownerKey) === 0);

// A landblock with no sand must never even be offered to the provider.
const grassMesh = {
  userData: {
    lbX: 0x11, lbY: 0x22, terrainCodes: new Uint8Array(81).fill(1),
    heights: new Float32Array(81),
  },
};
const addsBefore = spy.calls.add;
vfx.terrainVfxNoteLandblockMesh(scene3d, grassMesh);
await Promise.resolve(); await Promise.resolve();
check("a landblock with no FAM_SAND vertex spawns nothing", spy.calls.add === addsBefore);

sand._resetTerrainSand();
vfx._resetTerrainVfx();

// ===========================================================================
console.log("\n-- L11 the camera-scoped streamer provider through the spine ----");
// ===========================================================================
setUrl("?terrainSand=on&terrainSandDevils=off", {
  terrainSandStreamerCount: 400, terrainSandDevilCount: 0,
  terrainSandSparkle: true, terrainSandRadius: 32,
});
_resetVfxFlags();
const camOracle = makeOracle(() => 10);
const camScene = {
  terrainGroup: { children: [], parent: null },
  frameTime: { tsSec: 1 },
  cameraSwitcher: { _safePlayerPos: () => ({ x: 500, y: 700, z: 15 }) },
};
vfx.initTerrainVfx({ scene3d: camScene });
sand.initTerrainSand({ scene3d: camScene, getOracle: () => camOracle });
check("only the streamer provider is registered (devils opted out)",
  vfx.terrainVfxStats().providers.length === 1
  && vfx.terrainVfxStats().providers[0].id === "terrain.sandStreamers");
check("the field is NOT built until the first tick (no work before a player pos)",
  sand.terrainSandStats().field === null);
vfx.terrainVfxTick(0.016, camScene);
vfx.terrainVfxTick(0.016, camScene);
const camStats = sand.terrainSandStats();
check("the tick builds the pool ONCE and centres it on the player",
  !!camStats.field && camStats.counters.streamerBuilds === 1
  && camStats.field.pool.centerX === 500 && camStats.field.pool.centerY === 700);
check("the pool honours the tier's instance count",
  camStats.field.pool.count === 400);
check("sand ground under the whole window ⇒ live streamers", camStats.field.pool.live > 0);
check("a camera-scoped provider holds NO landblocks (immune to park/evict)",
  vfx.terrainVfxStats().providers[0].liveLandblocks === 0);
check("no provider errors", vfx.terrainVfxStats().counters.providerErrors === 0);

sand._resetTerrainSand();
vfx._resetTerrainVfx();
clearUrl(); _resetVfxFlags();

// ---------------------------------------------------------------------------
console.log(`\nterrain sand: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
