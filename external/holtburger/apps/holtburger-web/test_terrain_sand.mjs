// test_terrain_sand.mjs — SAND / DESERT terrain VFX (Wave 1B,
// `scene3d/terrain_sand.js` + `scene3d/vfx/components/terrainDustDevil.js`).
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.2 "Tests", plus the invariants
// §5.1-§5.9 every terrain-VFX module signs up to):
//   L1  ADVECTION IS A PURE FUNCTION of (wind, clock, hash). No player state,
//       no frame history, no `Math.random`: same inputs ⇒ same offset, forever,
//       on every client. It is bounded by the recycle span and it REVERSES with
//       the wind. (That is the closed form `streamerAdvect`. Since 2026-10-24
//       the LIVE field integrates its travel from the frame dt, so what is
//       drawn depends on dt history; L16 locks that path.)
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
//   L12 (2026-10-23) the streamer RIBBON rework: NORMAL-blended, lit by the
//       terrain's own retail light, tinted from the code it blows over, a
//       life envelope over the recycle span, a downwind gust drift, and NO
//       frozen scatter-time fade in the per-instance opacity (the bug that
//       emptied the near field after a few metres of walking).
//   L13 (2026-10-23) the devil LIFECYCLE + DISTANCE GATE: lives are pure in
//       (seed, clock, gate, wind); ready alone spawns nothing; the per-frame
//       update spawns the N nearest live devils, walks them, stops them at
//       end of life / off the sand, and DESTROYS any the player has left
//       behind (LRU residency is capacity-driven, not distance-driven).
//   L14 (2026-10-23) the sparkle live knobs reach every terrain material once
//       per override version and never touch a non-terrain material.
//   L15 (2026-10-24) reviewer minors: (a) THE DISSOLVE WINDOW — an in-view
//       stop (or a park) keeps `hasEmitter` only for lifespan + |lifespanRand|
//       + 1 s, then the slot is released (a scoped-only destroy: a no-op when
//       the manager already reaped it, a real destroy when the registry still
//       holds it), so `devilsHoldingEmitter` stops over-counting and a later
//       range-destroy is not counted for an emitter that no longer exists;
//       (b) `terrain_oracle.js::triangleGradInCell(..., out)` writes into a
//       reused 2-slot array, bit-identical to the allocating form, and
//       `sample()` (the per-frame devil walk) uses it — no array per call.
//   L16 (2026-10-24) NO RACING STREAMERS (the rock R14 port; fails on the
//       pre-fix module): a 3600 s session at 60 fps under the REAL breathing +
//       wandering calm wind (`weather_inputs.js::writeWindVector`), evaluating
//       the streamer GLSL's OWN `travelled` and gust-sheet `pq` lines on the
//       field's live uniforms: every ribbon's per-frame step stays <=
//       dt x speed x max multiplier x max |wind|, the gust pattern moves <=
//       dt x pulseSpeed per frame and always DOWNWIND, and `uTravel` stays
//       bounded by its seamless wrap. At a CONSTANT wind the integrated field
//       reproduces the old closed forms exactly (same speeds, same span, same
//       downwind sheet drift), across a travel wrap.
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
// (a GPU is not available here) — the two must not drift silently. Since
// 2026-10-24 the twin is streamerAdvectTravel over the CPU-integrated uTravel,
// never the absolute clock times the live wind (the racing product, L16).
const VGLSL = sand.SAND_STREAMER_VERTEX_GLSL;
check("the streamer vertex GLSL advects with streamerAdvectTravel's expression over uTravel",
  /float travelled = uTravel \* uSpeed \* aStreak\.y \+ aStreak\.x \* uSpanM;/.test(VGLSL)
  && /mod\(travelled, uSpanM\) - uSpanM \* 0\.5/.test(VGLSL)
  && /uniform float uTravel;/.test(VGLSL));
check("...and the uTime x |wind| product form is gone from the advection",
  !/uTime \* uSpeed \* aStreak/.test(VGLSL));
check("the travel API is exported (streamerAdvectTravel / streamerSpeedMul / streamerTravelWrap)",
  typeof sand.streamerAdvectTravel === "function" && typeof sand.streamerSpeedMul === "function"
  && typeof sand.streamerTravelWrap === "function" && sand.STREAMER_SPEED_QUANTUM === 64
  && sand.STREAMER_MAX_DT > 0 && sand.STREAMER_MAX_DT <= 0.25);
if (typeof sand.streamerAdvectTravel === "function") {
  // For a CONSTANT wind the integral IS t x |wind|: the closed form holds.
  let worst = 0;
  for (const [wx, wy] of [[1, 0], [0.6, -0.8], [-1.3, 0.4], [0.05, 0.02]]) {
    const wl = Math.hypot(wx, wy);
    for (const t of [0, 0.37, 12.5, 333.3, 3599]) {
      for (const ph of [0, 0.3, 0.99]) {
        const a = sand.streamerAdvect(wx, wy, t, ph, SPAN, SPEED * 1.25);
        const b = sand.streamerAdvectTravel(wx, wy, t * wl, ph, SPAN, SPEED * 1.25);
        worst = Math.max(worst, Math.abs(a.s - b.s), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
    }
  }
  check("constant wind: streamerAdvectTravel(w, t x |w|) === streamerAdvect(w, t)", worst < 1e-9, String(worst));
  check("streamerAdvectTravel uses the SAND span default (18 m), not rock's, on a bad span",
    Math.abs(sand.streamerAdvectTravel(1, 0, 0, 0.25, NaN, 1).s
      - (0.25 * sand.SAND_TUNING.advectSpanM - sand.SAND_TUNING.advectSpanM / 2)) < 1e-12);
  // Speed quantisation: the same 0.75..1.35 spread, within half a quantum.
  let qWorst = 0, qInt = true, qSum = 0, rawSum = 0;
  for (let i = 0; i <= 1000; i += 1) {
    const r = i / 1000;
    const q = sand.streamerSpeedMul(r);
    qWorst = Math.max(qWorst, Math.abs(q - (0.75 + r * 0.6)));
    if (!Number.isInteger(q * 64)) qInt = false;
    qSum += q; rawSum += 0.75 + r * 0.6;
  }
  check("streamerSpeedMul: an exact k/64 within 1/128 of the old 0.75 + 0.6 r draw (mean unchanged)",
    qInt && qWorst <= 1 / 128 + 1e-12 && Math.abs(qSum - rawSum) / 1001 < 1e-3
    && sand.streamerSpeedMul(0) === 0.75 && sand.streamerSpeedMul(1) === 86 / 64,
    `worst=${qWorst}`);
  check("streamerTravelWrap: every k/64 ribbon crosses a WHOLE number of spans per wrap",
    (() => {
      const W = sand.streamerTravelWrap(18, 3.6);
      for (let k = 48; k <= 86; k += 1) {
        const spans = (W * 3.6 * (k / 64)) / 18;
        if (Math.abs(spans - Math.round(spans)) > 1e-9) return false;
      }
      return Number.isFinite(W) && W > 0 && sand.streamerTravelWrap(18, 0) === Infinity;
    })());
}
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
check("NORMAL blend, depth-write OFF (airborne sand scatters, it does not emit; 2026-10-23)",
  gpuField.material.blending === THREE.NormalBlending && gpuField.material.depthWrite === false);
check("the ribbon geometry is a bendable strip (RIBBON_SEGMENTS + 1 columns x 2 rows)",
  gpuField.geometry.attributes.position.count === (sand.RIBBON_SEGMENTS + 1) * 2
  && gpuField.geometry.index.count === sand.RIBBON_SEGMENTS * 6);
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

// A REAL env, the shape `particle_env.readParticleEnv` produces and the shape
// `terrain_sand.js` passes. 2026-08-03: this used to be `env: null` and leaned on
// dustDevilGate's null-env => 1.0 to produce a spec at all. A null env is a WIRING
// FAULT (the producer never returns null), so it now gates OUT like every sibling
// gate — and a test that only ever exercised the fault path was never exercising
// the real one. Calm, dry, daylit desert: the conditions the old default claimed.
// 2026-10-23: calm (stormness 0) — the gate now treats CALM, CLEAR air as the
// dust-devil baseline (storminess suppresses them; it used to feed them).
const DEVIL_ENV = Object.freeze({
  isStorm: false, stormness: 0, wetness: 0, nightFactor: 0,
  season: 2, temperatureC: 30, frost: 0, windStrength: 1,
});
const devilCtx = {
  anchor: { partIndex: -1, center: { x: 0, y: 0, z: 0 }, radius: 1.7 },
  env: DEVIL_ENV, seed: 0x1234, clock: 0,
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
check("gate: a stormy sky SUPPRESSES it (clouds cut the heating, gusts shear the column)",
  dustDevilGate({ stormness: 0.9 }) < dustDevilGate({ stormness: 0 }));
check("gate: night fades it", dustDevilGate({ nightFactor: 1 }) < dustDevilGate({ nightFactor: 0 }));
check("gate: FULL night ⇒ 0 (no solar heating, and an additive column would glow)",
  dustDevilGate({ nightFactor: 1 }) === 0);
check("★ gate: a null env gates OUT (0) — a missing env is a wiring fault, not weather;\n"
  + "        matches pollenGate/firefliesGate/leavesGate/breathFogGate (2026-08-03)",
  dustDevilGate(null) === 0);
check("gate: a REAL calm dry daylit env is the 1.0 baseline the null case used to fake",
  dustDevilGate(DEVIL_ENV) === 1);
// 2026-10-23 — the column is sized to READ at the chase camera.
const di = spec.emitterInfo;
check("devil shape: the column is tall (updraft x max-rise x life ≥ 20 m)",
  di.aZ * di.maxA * di.lifespan >= 20, `${di.aZ * di.maxA * di.lifespan}`);
check("devil shape: puffs GROW as they climb to ≥ 2 m (softGlowDot is a 0.294 m quad)",
  di.finalScale > di.startScale && di.finalScale * 0.294 >= 2.0);
check("devil shape: the foot is a horizontal RING (offsetDir +Z, min < max offset)",
  di.offsetDirX === 0 && di.offsetDirY === 0 && di.offsetDirZ === 1
  && di.minOffset > 0 && di.maxOffset > di.minOffset);
check("devil shape: it FORMS from the ground up (no initial burst)", di.initialParticles === 0);
check("devil shape: the particle cap sustains the column (≥ lifespan / birthrate)",
  di.maxParticles >= Math.floor(di.lifespan / di.birthrate) - 1,
  `${di.maxParticles} vs ${di.lifespan / di.birthrate}`);
check("devil shape: the draw radius ≤ the host's engage radius (a distance-destroy is never visible)",
  di.degradeDistanceMeters <= sand.SAND_TUNING.devilEngageM);
check("a gated-OUT env synthesizes NO emitter at all (as cheap as flag-off)",
  terrainDustDevil.emit({ ...devilCtx, env: { isStorm: true } }).length === 0);

// ===========================================================================
console.log("\n-- L13a devil lives are pure in (seed, clock, gate, wind) -------");
// ===========================================================================
{
  const T = sand.SAND_TUNING;
  const l1 = sand.devilLifeAt(0x1234abcd, 731.25, 1);
  const l2 = sand.devilLifeAt(0x1234abcd, 731.25, 1);
  check("devilLifeAt is deterministic", JSON.stringify(l1) === JSON.stringify(l2));
  check("period and duty sit inside the tuning bounds",
    l1.period >= T.devilPeriodMinSec && l1.period <= T.devilPeriodMaxSec
    && l1.duty >= T.devilDutyMin && l1.duty <= T.devilDutyMax);
  check("gate 0 ⇒ never alive", [0, 50, 100, 400, 999].every((t) => !sand.devilLifeAt(77, t, 0).active));
  // Over many seeds, a lower gate runs strictly fewer lives (the per-life coin
  // thins them), and a life's PROGRESS never depends on the gate.
  let hi = 0, lo = 0, progressStable = true;
  for (let sd = 1; sd < 400; sd += 1) {
    const a1 = sand.devilLifeAt(sd * 2654435761, 1000, 1);
    const a2 = sand.devilLifeAt(sd * 2654435761, 1000, 0.4);
    if (a1.active) hi += 1;
    if (a2.active) { lo += 1; if (Math.abs(a2.progress - a1.progress) > 1e-12) progressStable = false; }
  }
  check("a weaker gate THINS lives (coin < gate)", lo < hi && lo > 0, `hi=${hi} lo=${lo}`);
  check("a life's clock never moves with the weather (no jump when the gate changes)", progressStable);
  // Duty ≈ share of time alive, at gate 1.
  let alive = 0;
  for (let t = 0; t < 20000; t += 7) if (sand.devilLifeAt(0xdeadbeef, t, 1).active) alive += 1;
  const share = alive / Math.ceil(20000 / 7);
  const d = sand.devilLifeAt(0xdeadbeef, 0, 1).duty;
  check("the alive share matches the life's duty", Math.abs(share - d) < 0.05, `${share} vs ${d}`);

  const w0 = sand.devilWanderOffset(99, 3, 0, 1, 0);
  const w1 = sand.devilWanderOffset(99, 3, 1, 1, 0);
  const wm = sand.devilWanderOffset(99, 3, 0.5, 1, 0);
  check("a devil crosses its home travelling DOWNWIND (east wind ⇒ x grows)",
    w0.x < 0 && w1.x > 0 && Math.abs(w0.x + w1.x) < 1e-9);
  check("the travel lies inside [travelMin, travelMax]",
    w1.x - w0.x >= T.devilTravelMinM - 1e-9 && w1.x - w0.x <= T.devilTravelMaxM + 1e-9);
  check("mid-life it stands near its home (only the wobble off-axis)",
    Math.abs(wm.x) < 1e-9 && Math.abs(wm.y) <= T.devilWobbleMaxM + 1e-9);
  const wN = sand.devilWanderOffset(99, 3, 1, 0, 1);
  check("a north wind steers it north", wN.y > 0 && Math.abs(wN.y - w1.x) < 1e-9);
  const wOther = sand.devilWanderOffset(99, 4, 1, 1, 0);
  check("each life walks its own line (travel/wobble re-drawn per life)",
    wOther.x !== w1.x || wOther.y !== w1.y);
}

// ===========================================================================
console.log("\n-- L4/L5/L13b park, evict, lifecycle, distance gate -----------");
// ===========================================================================
// A spy owner registry with the real API surface.
function makeSpyRegistry() {
  const owners = new Map();
  const calls = { add: 0, stop: [], destroyAll: [], destroyOne: [], destroySome: 0 };
  let nextId = 1000;
  return {
    calls,
    async addEmitter(ownerKey, manager, req) {
      calls.add += 1;
      if (!manager || typeof manager.addEmitter !== "function") return 0;
      const id = nextId++;
      if (!owners.has(ownerKey)) owners.set(ownerKey, new Map());
      const m = owners.get(ownerKey);
      // Scoped-handle REPLACE semantics, like the real registry.
      const h = req.emitterId >>> 0;
      if (h) m.set(h, id); else m.set(id, id);
      await manager.addEmitter(req);
      return id;
    },
    stopEmitter(ownerKey, handle) { calls.stop.push([ownerKey, handle]); return true; },
    destroyEmitter(ownerKey, handle) {
      calls.destroyOne.push([ownerKey, handle]);
      const m = owners.get(ownerKey);
      if (!m || !m.has(handle >>> 0)) return false;
      m.delete(handle >>> 0);
      if (m.size === 0) owners.delete(ownerKey);
      return true;
    },
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
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

const fakeManager = { added: 0, lastReq: null, async addEmitter(req) { this.added += 1; this.lastReq = req; return 1; } };
const spy = makeSpyRegistry();
const allSand = makeOracle(() => 10);
const LB_SEED = 0x5a4d1e55;
const home = sand.devilSlotsForLandblock({ ...LB, ...g1, count: 1, seed: LB_SEED })[0];
// A time well inside one of this home's lives, and the first moment after it
// that the life is over.
let tAct = -1;
for (let t = 0; t < 5000; t += 0.5) {
  const l = sand.devilLifeAt(home.seed, t, 1);
  if (l.active && l.progress > 0.3 && l.progress < 0.6) { tAct = t; break; }
}
let tEnd = -1;
const lifeAct = sand.devilLifeAt(home.seed, tAct, 1);
for (let t = tAct; t < tAct + 1000; t += 0.25) {
  const l = sand.devilLifeAt(home.seed, t, 1);
  if (!l.active || l.lifeIdx !== lifeAct.lifeIdx) { tEnd = t; break; }
}
check("test setup: found a live window for the home slot", tAct >= 0 && tEnd > tAct, `${tAct} ${tEnd}`);
const player = { x: home.x, y: home.y, z: 20 };
const scene3d = {
  terrainGroup: { children: [], parent: null },
  frameTime: { tsSec: 0 },
  cameraSwitcher: { _safePlayerPos: () => ({ ...player }) },
};

setUrl("?terrainSand=on&terrainSandStreamers=off"); _resetVfxFlags();
vfx._resetTerrainVfx();
sand._resetTerrainSand();
vfx.initTerrainVfx({ scene3d });
const surface = sand.initTerrainSand({
  scene3d,
  ownerRegistry: spy,
  getParticleManager: () => fakeManager,
  getOracle: () => allSand,
  // 2026-08-03: was `() => null`, which made this integration test exercise the
  // gate's WIRING-FAULT path (null env) instead of the real one. The live host
  // passes `vfx/particle_env.js::readParticleEnv`, which ALWAYS returns a filled
  // snapshot and never null. Supply the same baseline the unit assertions use.
  readEnv: () => DEVIL_ENV,
});
check("?terrainSand=on ⇒ initTerrainSand registers the devil provider",
  !!surface && vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.sandDevils"));
check("?terrainSandStreamers=off ⇒ the streamer provider is NOT registered",
  !vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.sandStreamers"));

const lbMesh = {
  userData: { lbX: 0xab, lbY: 0x12, terrainCodes: g1.codes, heights: g1.heights },
};
vfx.terrainVfxNoteLandblockMesh(scene3d, lbMesh);
await flush();
const ownerKey = sand.sandOwnerKeyForLb(vfx.lbKeyFromXY(0xab, 0x12));
check("L13: ready ALONE spawns nothing (emission is the update's decision, not residency's)",
  spy.calls.add === 0 && sand.terrainSandStats().devilLandblocks === 1);

vfx.terrainVfxTick(0.016, scene3d, tAct);
await flush();
check("L13: a tick inside the devil's life, with the player nearby, spawns it under the sand key",
  spy.emitterCountForOwner(ownerKey) === 1, `count=${spy.emitterCountForOwner(ownerKey)}`);
check("the emitter really reached the ParticleManager", fakeManager.added === 1);
check("the request carries the slot's scoped handle (so park/stop can find it)",
  fakeManager.lastReq && fakeManager.lastReq.emitterId === sand.devilEmitterHandle(0));
const wantOff = sand.devilWanderOffset(home.seed, lifeAct.lifeIdx, lifeAct.progress,
  Math.cos((135 * Math.PI) / 180), Math.sin((135 * Math.PI) / 180));
const parentPos = fakeManager.lastReq.parent.position;
check("L13: the devil stands on its WANDER path, not frozen on its home",
  Math.abs(parentPos.x - (home.x + wantOff.x)) < 1e-6 && Math.abs(parentPos.y - (home.y + wantOff.y)) < 1e-6,
  `${parentPos.x},${parentPos.y} vs ${home.x + wantOff.x},${home.y + wantOff.y}`);
check("L13: … grounded through the oracle at that point",
  Math.abs(parentPos.z - (20 + 0.01 * parentPos.x)) < 1e-6);
vfx.terrainVfxTick(0.016, scene3d, tAct + 5);
const movedX = parentPos.x;
check("L13: the per-frame update WALKS it (same parent object, new position)",
  Math.abs(movedX - (home.x + wantOff.x)) > 1e-3 && spy.calls.add === 1);
check("activeDevils() lists it with a compass bearing + distance",
  surface.activeDevils().length === 1 && Number.isFinite(surface.activeDevils()[0].bearingDeg)
  && surface.activeDevils()[0].distM >= 0);

const beforePark = spy.emitterCountForOwner(ownerKey);
vfx.terrainVfxLandblockPark(vfx.lbKeyFromXY(0xab, 0x12));
await flush();
check("L4: park leaves emitterCountForOwner UNCHANGED (nothing destroyed)",
  spy.emitterCountForOwner(ownerKey) === beforePark && beforePark === 1);
check("L4: park STOPS emission through the registry (never .visible=, §5.3)",
  spy.calls.stop.length === 1 && spy.calls.stop[0][0] === ownerKey);
check("L4: park does NOT call destroyAllForOwner", spy.calls.destroyAll.length === 0);
vfx.terrainVfxTick(0.016, scene3d, tAct + 6);
await flush();
check("a PARKED landblock's devil is not re-spawned by the update", spy.calls.add === 1);

vfx.terrainVfxLandblockUnpark(vfx.lbKeyFromXY(0xab, 0x12));
vfx.terrainVfxTick(0.016, scene3d, tAct + 7);
await flush();
check("unpark re-arms emission on the next tick (hash-stable home, same life, no re-scatter)",
  spy.emitterCountForOwner(ownerKey) >= 1 && spy.calls.add === 2);

// End of life: a graceful STOP (the column dissolves), not a destroy.
const stopsBefore = spy.calls.stop.length;
vfx.terrainVfxTick(0.016, scene3d, tEnd + 0.01);
await flush();
check("L13: end of life STOPS the devil in view (it dissolves as its puffs age out)",
  spy.calls.stop.length === stopsBefore + 1 && sand.terrainSandStats().counters.devilStopsLife >= 1
  && surface.activeDevils().length === 0);
vfx.terrainVfxTick(0.016, scene3d, tEnd + 0.6);
await flush();
check("… and the spent life is never re-spawned", spy.calls.add === 2);

// The DISTANCE GATE: re-arm a live devil, then teleport far away.
sand._resetTerrainSand();
vfx._resetTerrainVfx();
const spy2 = makeSpyRegistry();
vfx.initTerrainVfx({ scene3d });
const surface2 = sand.initTerrainSand({
  scene3d, ownerRegistry: spy2, getParticleManager: () => fakeManager,
  getOracle: () => allSand, readEnv: () => DEVIL_ENV,
});
vfx.terrainVfxNoteLandblockMesh(scene3d, lbMesh);
player.x = home.x; player.y = home.y;
vfx.terrainVfxTick(0.016, scene3d, tAct);
await flush();
check("distance gate setup: one live devil", spy2.emitterCountForOwner(ownerKey) === 1);
player.x = home.x + 5000; player.y = home.y + 5000;   // a teleport, 7 km
vfx.terrainVfxTick(0.016, scene3d, tAct + 1);
await flush();
check("L13: a devil the player LEFT is DESTROYED (not held, not merely stopped)",
  spy2.calls.destroyOne.length === 1 && spy2.calls.destroyOne[0][0] === ownerKey
  && spy2.emitterCountForOwner(ownerKey) === 0 && surface2.activeDevils().length === 0);
check("… while the landblock record (LRU residency) is untouched",
  sand.terrainSandStats().devilLandblocks === 1 && spy2.calls.destroyAll.length === 0);
vfx.terrainVfxTick(0.016, scene3d, tAct + 2);
await flush();
check("… and a far-away resident landblock never spawns one", spy2.calls.add === 1);
player.x = home.x; player.y = home.y;
vfx.terrainVfxTick(0.016, scene3d, tAct + 3);
await flush();
check("walk back while the life still runs ⇒ the devil re-forms", spy2.calls.add === 2);

const destroyBefore = spy2.calls.destroyAll.length;
vfx.terrainVfxLandblockGone(vfx.lbKeyFromXY(0xab, 0x12), "evict");
check("L5: evict calls destroyAllForOwner EXACTLY ONCE",
  spy2.calls.destroyAll.length === destroyBefore + 1);
check("L5: … on the SAND-scoped key, never the bare statics key",
  spy2.calls.destroyAll[spy2.calls.destroyAll.length - 1] === ownerKey
  && !spy2.calls.destroyAll.includes("static:2870083584"));
check("L5: the owner is empty afterwards", spy2.emitterCountForOwner(ownerKey) === 0);
check("L5: no live devil survives the evict", surface2.activeDevils().length === 0);

// A landblock with no sand must never even be offered to the provider.
const grassMesh = {
  userData: {
    lbX: 0x11, lbY: 0x22, terrainCodes: new Uint8Array(81).fill(1),
    heights: new Float32Array(81),
  },
};
const addsBefore = spy2.calls.add;
vfx.terrainVfxNoteLandblockMesh(scene3d, grassMesh);
await flush();
check("a landblock with no FAM_SAND vertex spawns nothing", spy2.calls.add === addsBefore
  && sand.terrainSandStats().devilLandblocks === 0);

// THE CAP: 25 all-sand landblocks around the player, every life forced on
// (duty 1). Only the tier's cap (6 × devilCount 1) may run — the NEAREST six.
sand._resetTerrainSand();
vfx._resetTerrainVfx();
const spy3 = makeSpyRegistry();
vfx.initTerrainVfx({ scene3d });
const surface3 = sand.initTerrainSand({
  scene3d, ownerRegistry: spy3, getParticleManager: () => fakeManager,
  getOracle: () => allSand, readEnv: () => DEVIL_ENV,
});
surface3.tune({ devilDutyMin: 1, devilDutyMax: 1 });
const allSandGrid = { codes: new Uint8Array(81).fill(10), heights: new Float32Array(81).fill(20) };
for (let dx = -2; dx <= 2; dx += 1) {
  for (let dy = -2; dy <= 2; dy += 1) {
    vfx.terrainVfxNoteLandblockMesh(scene3d, {
      userData: { lbX: 0x80 + dx, lbY: 0x40 + dy, terrainCodes: allSandGrid.codes, heights: allSandGrid.heights },
    });
  }
}
player.x = 0x80 * 192 + 96; player.y = 0x40 * 192 + 96;
vfx.terrainVfxTick(0.016, scene3d, 500);
await flush();
const live3 = surface3.activeDevils();
check("L13: the live-devil CAP holds (6 × the tier's devilCount 1)",
  live3.length === 6 && spy3.calls.add === 6, `${live3.length} / ${spy3.calls.add}`);
{
  // Independently: the six homes nearest the player, by landblock key.
  const homes = [];
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      const lbX = 0x80 + dx, lbY = 0x40 + dy;
      const lbKey = vfx.lbKeyFromXY(lbX, lbY);
      const h = sand.devilSlotsForLandblock({ lbKey, lbX, lbY, ...allSandGrid, count: 1, seed: LB_SEED })[0];
      homes.push({ key: `0x${(lbKey >>> 0).toString(16).padStart(8, "0")}`, d: Math.hypot(h.x - player.x, h.y - player.y) });
    }
  }
  homes.sort((a, b) => a.d - b.d);
  const want = new Set(homes.slice(0, 6).map((h) => h.key));
  check("L13: … and they are the NEAREST six homes",
    live3.every((d) => want.has(d.lbKey)), JSON.stringify(live3.map((d) => d.lbKey)) + " vs " + JSON.stringify([...want]));
}
check("the stats separate LRU residency from the distance-bounded cost",
  sand.terrainSandStats().devilLandblocks === 25 && sand.terrainSandStats().devilsActive === 6);
check("respawnDevils() tears the live set down for a re-form with new tuning",
  surface3.respawnDevils() === 6 && surface3.activeDevils().length === 0);

// HYSTERESIS (verifier regression, 2026-10-23). The candidate test is on the
// HOME (≤ devilEngageM) and the range-destroy on the devil's CURRENT position
// (> 1.15 × devilEngageM). A home just inside the engage radius whose devil had
// wandered past the drop radius used to be destroyed, re-spawned on the next
// evaluation and destroyed again — 7 creates + 6 destroys in 10 s.
sand._resetTerrainSand();
vfx._resetTerrainVfx();
{
  const spy4 = makeSpyRegistry();
  vfx.initTerrainVfx({ scene3d });
  const s4 = sand.initTerrainSand({
    scene3d, ownerRegistry: spy4, getParticleManager: () => fakeManager,
    getOracle: () => allSand, readEnv: () => DEVIL_ENV,
  });
  s4.tune({ devilDutyMin: 1, devilDutyMax: 1, devilTravelMinM: 200, devilTravelMaxM: 200,
    devilWobbleMinM: 0, devilWobbleMaxM: 0 });
  const hLbX = 0x80, hLbY = 0x40;
  vfx.terrainVfxNoteLandblockMesh(scene3d, {
    userData: { lbX: hLbX, lbY: hLbY, terrainCodes: allSandGrid.codes, heights: allSandGrid.heights },
  });
  await flush();
  const hKey = vfx.lbKeyFromXY(hLbX, hLbY);
  const hHome = sand.devilSlotsForLandblock({ lbKey: hKey, lbX: hLbX, lbY: hLbY, ...allSandGrid,
    count: 1, seed: LB_SEED })[0];
  let tFar = -1;
  for (let t = 0; t < 5000; t += 0.25) {
    const l = sand.devilLifeAt(hHome.seed, t, 1, s4.tuning());
    if (l.active && l.progress > 0.9 && l.progress < 0.92) { tFar = t; break; }
  }
  // No VFX globals ⇒ the 135° fallback wind; the devil walks along +dir.
  const wd = { x: Math.cos((135 * Math.PI) / 180), y: Math.sin((135 * Math.PI) / 180) };
  const engage = sand.SAND_TUNING.devilEngageM;
  player.x = hHome.x - wd.x * (engage - 5); player.y = hHome.y - wd.y * (engage - 5);
  for (let k = 0; k < 20; k += 1) {
    vfx.terrainVfxTick(0.5, scene3d, tFar + k * 0.5);
    await flush();
  }
  const c4 = sand.terrainSandStats().counters;
  check("hysteresis: a home inside the engage radius whose devil stands past the drop radius\n"
    + "        is NOT spawned/destroyed every second",
    tFar >= 0 && spy4.calls.add === 0 && spy4.calls.destroyOne.length === 0
    && c4.devilRangeDestroys === 0 && c4.devilSpawnOutOfRange > 0,
    `tFar=${tFar} adds=${spy4.calls.add} destroys=${spy4.calls.destroyOne.length} rd=${c4.devilRangeDestroys}`);
  // Walk in: once the devil itself is inside the engage radius it forms.
  player.x = hHome.x; player.y = hHome.y;
  vfx.terrainVfxTick(0.5, scene3d, tFar + 10.5);
  await flush();
  check("… and it still forms once the player closes in (the life was not spent)",
    spy4.calls.add === 1 && s4.activeDevils().length === 1);
}

// A TUNED draw radius (verifier regression, 2026-10-23): with
// tune({devilConfig: {drawRadiusM: 700}, devilEngageM: 700}) a devil ending its
// life 550 m away is IN VIEW, so it must STOP (dissolve), not be destroyed by a
// "far" test still reading the descriptor's default 480 m.
sand._resetTerrainSand();
vfx._resetTerrainVfx();
{
  const spy5 = makeSpyRegistry();
  vfx.initTerrainVfx({ scene3d });
  const s5 = sand.initTerrainSand({
    scene3d, ownerRegistry: spy5, getParticleManager: () => fakeManager,
    getOracle: () => allSand, readEnv: () => DEVIL_ENV,
  });
  s5.tune({ devilDutyMin: 0.5, devilDutyMax: 0.5, devilTravelMinM: 200, devilTravelMaxM: 200,
    devilWobbleMinM: 0, devilWobbleMaxM: 0, devilEngageM: 700, devilConfig: { drawRadiusM: 700 } });
  const dLbX = 0x80, dLbY = 0x40;
  vfx.terrainVfxNoteLandblockMesh(scene3d, {
    userData: { lbX: dLbX, lbY: dLbY, terrainCodes: allSandGrid.codes, heights: allSandGrid.heights },
  });
  await flush();
  const dKey = vfx.lbKeyFromXY(dLbX, dLbY);
  const dHome = sand.devilSlotsForLandblock({ lbKey: dKey, lbX: dLbX, lbY: dLbY, ...allSandGrid,
    count: 1, seed: LB_SEED })[0];
  let tLive = -1;
  for (let t = 0; t < 5000; t += 0.25) {
    const l = sand.devilLifeAt(dHome.seed, t, 1, s5.tuning());
    if (l.active && l.progress > 0.5 && l.progress < 0.52) { tLive = t; break; }
  }
  let tDone = -1;
  const lLive = sand.devilLifeAt(dHome.seed, tLive, 1, s5.tuning());
  for (let t = tLive; t < tLive + 1000; t += 0.25) {
    const l = sand.devilLifeAt(dHome.seed, t, 1, s5.tuning());
    if (!l.active || l.lifeIdx !== lLive.lifeIdx) { tDone = t; break; }
  }
  const wd = { x: Math.cos((135 * Math.PI) / 180), y: Math.sin((135 * Math.PI) / 180) };
  // 450 m upwind of home: the devil ends its life ~550 m away.
  player.x = dHome.x - wd.x * 450; player.y = dHome.y - wd.y * 450;
  vfx.terrainVfxTick(0.5, scene3d, tLive);
  await flush();
  const spawned = spy5.calls.add === 1;
  // Walk it to the end of its path first (the far test reads where it stands).
  vfx.terrainVfxTick(0.5, scene3d, tDone - 0.25);
  await flush();
  const endDist = surface5Dist(s5);
  const stopsBefore = spy5.calls.stop.length;
  vfx.terrainVfxTick(0.5, scene3d, tDone + 0.01);
  await flush();
  check("a tuned devilConfig.drawRadiusM: an in-view (550 m < 700 m) end of life STOPS, never destroys",
    tLive >= 0 && tDone > tLive && spawned && endDist > 500 && endDist < 700
    && spy5.calls.stop.length === stopsBefore + 1 && spy5.calls.destroyOne.length === 0,
    `tLive=${tLive} tDone=${tDone} endDist=${endDist} add=${spy5.calls.add} stop=${spy5.calls.stop.length} destroy=${spy5.calls.destroyOne.length}`);
}
function surface5Dist(s) {
  const a = s.activeDevils();
  return a.length === 1 ? a[0].distM : -1;
}

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

// ===========================================================================
console.log("\n-- L12 the streamer ribbon rework (2026-10-23) ------------------");
// ===========================================================================
{
  const T = sand.SAND_TUNING;
  // Life envelope: 0 at both ends of the span (the recycle jump is invisible),
  // 1 in the middle — and the GLSL computes the same expression.
  const span = T.advectSpanM;
  check("life envelope is 0 at both ends of the recycle span",
    sand.streamerLifeFade(-span / 2, span) < 1e-9 && sand.streamerLifeFade(span / 2 - 1e-9, span) < 1e-6);
  check("life envelope is 1 mid-span", Math.abs(sand.streamerLifeFade(0, span) - 1) < 1e-9);
  check("the GLSL carries the same life envelope",
    /float life = s \/ uSpanM \+ 0\.5;/.test(VGLSL)
    && /smoothstep\(0\.0, max\(uLifeIn, 0\.001\), life\)/.test(VGLSL)
    && /smoothstep\(1\.0 - max\(uLifeOut, 0\.001\), 1\.0, life\)/.test(VGLSL));
  // 2026-10-24: the drift is the CPU-integrated uPulseOffset (+dir x speed x
  // dt), SUBTRACTED, so the pattern still moves downwind; L16 drives it under
  // the real wind and checks every frame's step points downwind.
  check("the gust sheets drift DOWNWIND (the v1 sign scrolled them upwind)",
    /\(centreXy - uPulseOffset\) \* uPulseFreq/.test(VGLSL)
    && /uniform vec2\s+uPulseOffset;/.test(VGLSL)
    && !/uTime \* uPulseSpeed/.test(VGLSL));
  check("the ribbon follows the ground PLANE at its anchor (aNormal), not a flat z",
    /-\(aNormal\.x \* g2\.x \+ aNormal\.y \* g2\.y\) \/ nz/.test(VGLSL));
  check("the ribbon faces the camera about its own axis (cross of tangent and eye)",
    /cross\(tanV, normalize\(-mvPos\.xyz\)\)/.test(VGLSL));
  check("lit by the terrain's retail light uniforms (dark at night by construction)",
    /uLightSun \* max\(dot\(nn, uLightDir\), 0\.0\) \+ uLightAmb/.test(VGLSL));
  check("a fully transparent ribbon is pushed out of the clip volume (no fill)",
    /if \(a < 0\.002\) gl_Position = vec4\(0\.0, 0\.0, 2\.0, 1\.0\);/.test(VGLSL));
  // Verifier regression (2026-10-23): under MSAA an edge pixel shades at its
  // centre outside the strip, so vQuadUv extrapolates past [0,1]; pow() of a
  // negative base is NaN (ANGLE D3D11, SwiftShader), a NaN alpha passes the
  // discard test and bloom spreads it. Every pow() base must be clamped >= 0.
  {
    const FG = sand.SAND_STREAMER_FRAGMENT_GLSL.replace(/\/\/.*$/gm, "");
    const pows = FG.match(/pow\(([^,]+),/g) || [];
    check("fragment: every pow() base is clamped non-negative (no NaN from an extrapolated uv)",
      pows.length > 0 && pows.every((p) => /^pow\((max|clamp)\(/.test(p)), JSON.stringify(pows));
  }
  check("the vertex main has no early return (the log-depth append-at-end contract)",
    !/\breturn\b/.test(VGLSL.slice(VGLSL.indexOf("void main()"))));

  // Weather gate.
  check("streamer gate: a null env degrades to the calm baseline (still moving)",
    sand.streamerGate(null) === T.gateCalm);
  check("streamer gate: rain kills it", sand.streamerGate({ wetness: 1 }) === 0
    && sand.streamerGate({ wetness: 0.5 }) < sand.streamerGate({ wetness: 0 }));
  check("streamer gate: wind feeds it; a dry storm is a sand storm (1.0)",
    sand.streamerGate({ stormness: 0.8 }) > sand.streamerGate({ stormness: 0 })
    && sand.streamerGate({ isStorm: true, wetness: 0 }) === 1);

  // Tint: paler and less saturated than the code it blows over.
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const sat = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
  let tintOk = true;
  for (const code of [10, 11, 12]) {
    const t = sand.streamerTintForCode(code);
    const g = sand.SAND_CODE_SRGB[code].map(lin);
    if (!(lum(t) > lum(g) * 1.2 && sat(t) < sat(g))) tintOk = false;
  }
  check("tint: the airborne sand is PALER and LESS SATURATED than its ground code", tintOk);
  check("tint: yellow and grey sand blow different colours",
    JSON.stringify(sand.streamerTintForCode(10)) !== JSON.stringify(sand.streamerTintForCode(11)));

  // The frozen scatter-time fade (the near-field-empties-as-you-walk bug).
  const walkField = sand.createSandStreamerField({
    oracle: makeOracle(() => 10), count: 900, radiusM: 32, seed: 21,
  });
  walkField.pool.rescatterAll(1000, 1000, 20);
  // Walk 40 m east in 1 m steps; the leading edge is re-scattered AT THE RIM.
  for (let i = 1; i <= 40; i += 1) walkField.update(0.016, i * 0.1, 1000 + i, 1000, 20);
  let minOp = Infinity, nearLive = 0;
  const arrS = walkField.pool.arrays.aStreak;
  const arrO = walkField.pool.arrays.aOffset;
  for (let i = 0; i < walkField.pool.count; i += 1) {
    if (!walkField.pool.isLive(i)) continue;
    const dx = arrO[i * 3] - 1040, dy = arrO[i * 3 + 1] - 1000;
    if (Math.hypot(dx, dy) > 12) continue;
    nearLive += 1;
    minOp = Math.min(minOp, arrS[i * 4 + 3]);
  }
  check("★ after walking 40 m, the ribbons around the player keep their FULL per-instance\n"
    + "        opacity (no frozen scatter-time fade baked in at the rim)",
    nearLive > 0 && minOp >= 0.55 - 1e-6, `near=${nearLive} min=${minOp}`);

  // Per-instance ground normal + tint are written.
  const slopeOracle = {
    sample(x, y, out) {
      const r = out || {};
      r.code = 11; r.family = familyForCode(11); r.hasHeight = true;
      r.height = 10 + 0.2 * x;
      if (!r.normal) r.normal = { x: 0, y: 0, z: 1 };
      const inv = 1 / Math.hypot(0.2, 1);
      r.normal.x = -0.2 * inv; r.normal.y = 0; r.normal.z = inv;
      return r;
    },
    heightAt(x) { return 10 + 0.2 * x; },
  };
  const slopeField = sand.createSandStreamerField({ oracle: slopeOracle, count: 100, radiusM: 16, seed: 3 });
  slopeField.pool.rescatterAll(500, 500, 100);
  let nOk = true, tOk = true, anyLive = false;
  const greyTint = sand.streamerTintForCode(11);
  for (let i = 0; i < slopeField.pool.count; i += 1) {
    if (!slopeField.pool.isLive(i)) continue;
    anyLive = true;
    const n = slopeField.pool.arrays.aNormal;
    if (Math.abs(n[i * 3] + 0.2 / Math.hypot(0.2, 1)) > 1e-6) nOk = false;
    const t = slopeField.pool.arrays.aTint;
    if (Math.abs(t[i * 3] - greyTint[0]) > 1e-6 || Math.abs(t[i * 3 + 2] - greyTint[2]) > 1e-6) tOk = false;
  }
  check("aNormal carries the ground normal at each anchor (the slope the ribbon follows)", anyLive && nOk);
  check("aTint carries the airborne colour of the code under each anchor", anyLive && tOk);

  // Light + weather plumbing (THREE build, fake terrain material).
  const litField = sand.createSandStreamerField({
    THREE, oracle: makeOracle(() => 10), count: 64, radiusM: 16, seed: 9,
  });
  const fakeTerrainMat = {
    uniforms: {
      uAcSunVec: { value: new THREE.Vector3(0.1, 0.2, 0.97) },
      uAcSunColor: { value: new THREE.Color(0.5, 0.45, 0.4) },
      uAcAmbColor: { value: new THREE.Color(0.6, 0.6, 0.7) },
      uAcAmbLevel: { value: 0.5 },
    },
  };
  check("setTerrainLight copies the terrain's retail light (sun dir, sun, ambient x level)",
    litField.setTerrainLight([{ uniforms: {} }, fakeTerrainMat]) === true
    && Math.abs(litField.uniforms.uLightDir.value.z - 0.97) < 1e-6
    && Math.abs(litField.uniforms.uLightSun.value.x - 0.5) < 1e-6
    && Math.abs(litField.uniforms.uLightAmb.value.z - 0.35) < 1e-6);
  check("setTerrainLight is a no-op with no terrain material yet",
    litField.setTerrainLight([]) === false);
  litField.setEnvironment({ wetness: 1 });
  check("setEnvironment: rain drives the gate uniform to 0", litField.uniforms.uGate.value === 0);
  litField.setEnvironment({ stormness: 1 });
  check("setEnvironment: a storm lowers the gust threshold (more sheets)",
    litField.uniforms.uPulseThreshold.value < T.pulseThreshold);
  litField.dispose();
}

// ===========================================================================
console.log("\n-- L14 sparkle live knobs ---------------------------------------");
// ===========================================================================
{
  setUrl("?terrainSand=on&terrainSandStreamers=off"); _resetVfxFlags();
  vfx._resetTerrainVfx();
  sand._resetTerrainSand();
  const terrainMats = [
    { uniforms: { uSandSparkleEnabled: { value: 1 }, uSandSparkleStrength: { value: 3.2 },
      uSandSparkleSharpness: { value: 240 } }, userData: {} },
    { uniforms: { uSandSparkleEnabled: { value: 1 }, uSandSparkleStrength: { value: 3.2 },
      uSandSparkleSharpness: { value: 240 } }, userData: {} },
    { uniforms: { uSomethingElse: { value: 7 } }, userData: {} },   // not terrain
  ];
  const kScene = { terrainGroup: { children: [], parent: null }, frameTime: { tsSec: 0 },
    terrainMaterials: terrainMats };
  vfx.initTerrainVfx({ scene3d: kScene });
  const ks = sand.initTerrainSand({ scene3d: kScene, ownerRegistry: makeSpyRegistry(),
    getParticleManager: () => null, readEnv: () => DEVIL_ENV });
  check("no knob turned ⇒ the push is a no-op", sand.pushSandSparkleOverrides(terrainMats) === 0);
  const r = ks.sparkle({ strength: 6, sharpness: 400, bogus: 9 });
  check("sparkle({...}) writes every terrain material at once",
    terrainMats[0].uniforms.uSandSparkleStrength.value === 6
    && terrainMats[1].uniforms.uSandSparkleSharpness.value === 400 && r.strength === 6);
  check("… never a non-terrain material, and unknown knobs are ignored",
    !("uSandSparkleStrength" in terrainMats[2].uniforms) && !("bogus" in r));
  check("… once per override version (a second push writes nothing)",
    sand.pushSandSparkleOverrides(terrainMats) === 0);
  terrainMats.push({ uniforms: { uSandSparkleEnabled: { value: 1 }, uSandSparkleStrength: { value: 3.2 } },
    userData: {} });
  check("… and a newly baked landblock's material is caught on its first push",
    sand.pushSandSparkleOverrides(terrainMats) === 1 && terrainMats[3].uniforms.uSandSparkleStrength.value === 6);
  ks.sparkle({ enabled: false });
  check("sparkle({enabled:false}) is a live A/B of the whole term",
    terrainMats.slice(0, 2).every((m) => m.uniforms.uSandSparkleEnabled.value === 0));
  // Verifier regression (2026-10-23): sparkle(null) reset the version to 0, so
  // the next override reused version 1 and skipped every material the FIRST
  // override had stamped — the A/B left the sparkle off.
  ks.sparkle(null);
  ks.sparkle({ enabled: true });
  check("sparkle(null) then sparkle({enabled:true}) re-enables materials an earlier override stamped",
    terrainMats.slice(0, 2).every((m) => m.uniforms.uSandSparkleEnabled.value === 1));
  check("tune() round-trips a streamer knob and ignores unknown keys",
    ks.tune({ opacity: 0.5, nonsense: 3 }).opacity === 0.5 && !("nonsense" in ks.tuning()));
  sand._resetTerrainSand();
  vfx._resetTerrainVfx();
  clearUrl(); _resetVfxFlags();
}

// ===========================================================================
console.log("\n-- L15 the dissolve window + the zero-alloc oracle gradient -----");
// ===========================================================================
{
  const oracleMod = await import("./scene3d/terrain_oracle.js");
  const DD = terrainDustDevil.defaults;
  // lifespan + |lifespanRand| (the longest puff life) + the 1 s release margin.
  const WINDOW = DD.lifespan + Math.abs(DD.lifespanRand) + 1.0;
  const LB_KEY = vfx.lbKeyFromXY(0xab, 0x12);

  // The spy registry plus the MANAGER's natural retirement: a stopped emitter
  // is reaped (its scoped handle unbound) when `retireStopped()` runs. It also
  // records the option bag every destroyEmitter call carries.
  function makeRetiringRegistry() {
    const base = makeSpyRegistry();
    const baseDestroy = base.destroyEmitter;
    const stopped = [];
    base.calls.destroyOpts = [];
    base.destroyEmitter = (ownerKey, handle, opts) => {
      base.calls.destroyOpts.push(opts || null);
      return baseDestroy(ownerKey, handle);
    };
    base.stopEmitter = (ownerKey, handle) => {
      base.calls.stop.push([ownerKey, handle]);
      stopped.push([ownerKey, handle >>> 0]);
      return true;
    };
    base.retireStopped = () => {
      let n = 0;
      for (const [k, h] of stopped.splice(0)) {
        if (baseDestroy(k, h)) n += 1;
        base.calls.destroyOne.pop();   // a reap is the manager's, not a destroy CALL
      }
      return n;
    };
    return base;
  }
  async function freshDevils(reg, getOracle = () => allSand, mesh = lbMesh) {
    sand._resetTerrainSand();
    vfx._resetTerrainVfx();
    vfx.initTerrainVfx({ scene3d });
    const s = sand.initTerrainSand({
      scene3d, ownerRegistry: reg, getParticleManager: () => fakeManager,
      getOracle, readEnv: () => DEVIL_ENV,
    });
    vfx.terrainVfxNoteLandblockMesh(scene3d, mesh);
    await flush();
    return s;
  }

  setUrl("?terrainSand=on&terrainSandStreamers=off"); _resetVfxFlags();

  // (1) The reviewer's case: an in-view end of life, the manager reaps the
  // drained emitter, the player then leaves.
  {
    const reg = makeRetiringRegistry();
    await freshDevils(reg);
    player.x = home.x; player.y = home.y;
    vfx.terrainVfxTick(0.016, scene3d, tAct);
    await flush();
    const spawned = reg.calls.add === 1 && sand.terrainSandStats().devilsHoldingEmitter === 1;
    const tS = tEnd + 0.01;
    vfx.terrainVfxTick(0.016, scene3d, tS);
    await flush();
    const st0 = sand.terrainSandStats();
    check("L15 setup: the devil spawned, then its life ended IN VIEW (a stop, not a destroy)",
      spawned && reg.calls.stop.length === 1 && reg.calls.destroyOne.length === 0 && st0.devilsActive === 0,
      `add=${reg.calls.add} stop=${reg.calls.stop.length} destroy=${reg.calls.destroyOne.length}`);
    check("L15: a stopped devil still HOLDS its emitter while the column dissolves",
      st0.devilsHoldingEmitter === 1);
    vfx.terrainVfxTick(0.016, scene3d, tS + WINDOW - 0.3);
    await flush();
    check("L15: … for the whole dissolve window (lifespan + |lifespanRand| + 1 s), never early",
      sand.terrainSandStats().devilsHoldingEmitter === 1 && reg.calls.destroyOne.length === 0);
    const reaped = reg.retireStopped();
    vfx.terrainVfxTick(0.016, scene3d, tS + WINDOW + 0.3);
    await flush();
    const st1 = sand.terrainSandStats();
    check("★ L15: once the window has passed the slot is RELEASED (devilsHoldingEmitter 0, a retire)",
      reaped === 1 && st1.devilsHoldingEmitter === 0 && st1.counters.devilDrainRetires === 1
      && st1.counters.devilDrainForced === 0,
      `reaped=${reaped} holding=${st1.devilsHoldingEmitter} c=${JSON.stringify(st1.counters)}`);
    check("L15: the release probe is a SCOPED-ONLY destroy (never the raw-id fallback), a no-op here",
      reg.calls.destroyOpts.length === 1 && reg.calls.destroyOpts[0] !== null
      && reg.calls.destroyOpts[0].scopedOnly === true && reg.emitterCountForOwner(ownerKey) === 0);
    player.x = home.x + 5000; player.y = home.y + 5000;   // teleport away
    vfx.terrainVfxTick(0.016, scene3d, tS + WINDOW + 1.0);
    await flush();
    check("★ L15: a later range-destroy is NOT counted for an emitter the manager already retired",
      sand.terrainSandStats().counters.devilRangeDestroys === 0 && reg.calls.destroyOne.length === 1,
      `rd=${sand.terrainSandStats().counters.devilRangeDestroys} destroys=${reg.calls.destroyOne.length}`);
    player.x = home.x; player.y = home.y;
  }

  // (2) The registry still holds the drained emitter (no natural-retire unbind):
  // the release destroys it, so nothing leaks.
  {
    const reg = makeRetiringRegistry();
    await freshDevils(reg);
    vfx.terrainVfxTick(0.016, scene3d, tAct);
    await flush();
    const tS = tEnd + 0.01;
    vfx.terrainVfxTick(0.016, scene3d, tS);
    await flush();
    vfx.terrainVfxTick(0.016, scene3d, tS + WINDOW + 0.3);
    await flush();
    const st = sand.terrainSandStats();
    check("L15: a registry still holding the drained emitter gets it DESTROYED at release (no leak)",
      st.counters.devilDrainForced === 1 && st.counters.devilDrainRetires === 0
      && reg.emitterCountForOwner(ownerKey) === 0 && st.devilsHoldingEmitter === 0);
  }

  // (3) A park is a stop: the same window, then unpark still re-forms the devil.
  {
    const reg = makeRetiringRegistry();
    const s = await freshDevils(reg);
    vfx.terrainVfxTick(0.016, scene3d, tAct);
    await flush();
    vfx.terrainVfxLandblockPark(LB_KEY);
    const held = sand.terrainSandStats().devilsHoldingEmitter === 1 && reg.emitterCountForOwner(ownerKey) === 1;
    vfx.terrainVfxTick(0.016, scene3d, tAct + WINDOW - 0.3);
    await flush();
    const stillHeld = sand.terrainSandStats().devilsHoldingEmitter === 1;
    reg.retireStopped();
    vfx.terrainVfxTick(0.016, scene3d, tAct + WINDOW + 0.3);
    await flush();
    const st = sand.terrainSandStats();
    check("L15: a PARK stop gets the same dissolve window (held through it, released after)",
      held && stillHeld && st.devilsHoldingEmitter === 0 && st.counters.devilDrainRetires === 1,
      `held=${held} still=${stillHeld} holding=${st.devilsHoldingEmitter}`);
    vfx.terrainVfxLandblockUnpark(LB_KEY);
    vfx.terrainVfxTick(0.016, scene3d, tAct + WINDOW + 0.9);
    await flush();
    check("L15: … and unpark still re-forms the devil (its life is still running)",
      reg.calls.add === 2 && s.activeDevils().length === 1);
  }

  // (4) triangleGradInCell's out-param: identical numbers, no fresh array.
  {
    const { triangleGradInCell, createTerrainOracle, cellSwToNeCut } = oracleMod;
    let seed = 0x2545f491;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let ident = true, same = true, f64 = true;
    const out = [NaN, NaN];
    const outF = new Float64Array(2);
    for (let i = 0; i < 20000; i += 1) {
      const z0 = Math.fround(-50 + 250 * rnd()), z1 = Math.fround(-50 + 250 * rnd());
      const z2 = Math.fround(-50 + 250 * rnd()), z3 = Math.fround(-50 + 250 * rnd());
      const fx = rnd();
      let fy = rnd();
      if (i % 7 === 0) fy = fx;          // exactly on the SW-NE diagonal
      if (i % 11 === 0) fy = 1 - fx;     // exactly on the NW-SE diagonal
      const cut = (i & 1) === 0;
      const ref = triangleGradInCell(z0, z1, z2, z3, fx, fy, cut);
      if (triangleGradInCell(z0, z1, z2, z3, fx, fy, cut, out) !== out) ident = false;
      if (!Object.is(out[0], ref[0]) || !Object.is(out[1], ref[1])) same = false;
      triangleGradInCell(z0, z1, z2, z3, fx, fy, cut, outF);
      if (!Object.is(outF[0], ref[0]) || !Object.is(outF[1], ref[1])) f64 = false;
    }
    check("L15: triangleGradInCell(..., out) writes INTO out and returns it", ident);
    check("L15: … bit-identical to the allocating form (20 000 cells, both cuts, both diagonals)", same);
    check("L15: … a Float64Array out is exact too", f64);
    const a = triangleGradInCell(1, 2, 3, 4, 0.2, 0.1, true);
    const b = triangleGradInCell(1, 2, 3, 4, 0.2, 0.1, true);
    check("L15: without out it still returns a fresh [dx, dy] (far_terrain / film callers unchanged)",
      Array.isArray(a) && a !== b && a.length === 2 && a[0] === 1 && a[1] === 2);

    // oracle.sample()'s normal, recomputed here with the ALLOCATING gradient.
    const or = createTerrainOracle();
    const oLbX = 0x80, oLbY = 0x40;
    const oHeights = new Float32Array(81);
    for (let i = 0; i < 81; i += 1) oHeights[i] = 20 + 30 * rnd();
    const oCodes = new Uint8Array(81).fill(10);
    or.noteLandblock(vfx.lbKeyFromXY(oLbX, oLbY), { codes: oCodes, heights: oHeights, lbX: oLbX, lbY: oLbY });
    const scratch = {};
    let nSame = true, objSame = true, firstNormal = null;
    for (let i = 0; i < 5000; i += 1) {
      const x = oLbX * 192 + 192 * rnd(), y = oLbY * 192 + 192 * rnd();
      const smp = or.sample(x, y, scratch);
      if (smp !== scratch) objSame = false;
      if (firstNormal === null) firstNormal = smp.normal;
      else if (smp.normal !== firstNormal) objSame = false;
      const cxf = Math.min(Math.max((x - oLbX * 192) / 24, 0), 8);
      const cyf = Math.min(Math.max((y - oLbY * 192) / 24, 0), 8);
      const cx0 = Math.floor(cxf), cy0 = Math.floor(cyf);
      const cx1 = Math.min(cx0 + 1, 8), cy1 = Math.min(cy0 + 1, 8);
      const g = triangleGradInCell(oHeights[cx0 * 9 + cy0], oHeights[cx1 * 9 + cy0],
        oHeights[cx0 * 9 + cy1], oHeights[cx1 * 9 + cy1], cxf - cx0, cyf - cy0,
        cellSwToNeCut(oLbX * 8 + cx0, oLbY * 8 + cy0));
      let nx = -(g[0] / 24), ny = -(g[1] / 24), nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      if (!Object.is(smp.normal.x, nx) || !Object.is(smp.normal.y, ny) || !Object.is(smp.normal.z, nz)) nSame = false;
    }
    check("L15: oracle.sample()'s normal is bit-identical to the allocating gradient (5 000 points)", nSame);
    check("L15: … and a reused out keeps returning the SAME result + normal objects", objSame);
    const oSrc = readFileSync("./scene3d/terrain_oracle.js", "utf8");
    check("L15: sample() hands its 2-slot scratch to triangleGradInCell (no per-call [dx, dy])",
      /triangleGradInCell\(z00, z10, z01, z11, fx, fy, swNeCut, _gradScratch\)/.test(oSrc)
      && /const _gradScratch = \[0, 0\];/.test(oSrc));

    // (5) The per-frame devil walk through a REAL oracle: every frame samples
    // into the module scratch (one result object, one normal object) and stands
    // the devil exactly on the oracle's ground.
    let walkCalls = 0, walkObj = null, walkSameObj = true;
    const walkOracle = {
      sample(x, y, o) {
        walkCalls += 1;
        const r = or.sample(x, y, o);
        if (r) { if (walkObj === null) walkObj = r; else if (r !== walkObj) walkSameObj = false; }
        return r;
      },
      heightAt: (x, y) => or.heightAt(x, y),
    };
    const reg = makeRetiringRegistry();
    const s = await freshDevils(reg, () => walkOracle,
      { userData: { lbX: oLbX, lbY: oLbY, terrainCodes: oCodes, heights: oHeights } });
    s.tune({ devilDutyMin: 1, devilDutyMax: 1 });
    player.x = oLbX * 192 + 96; player.y = oLbY * 192 + 96;
    vfx.terrainVfxTick(0.016, scene3d, 500);
    await flush();
    let onGround = true;
    const before = walkCalls;
    for (let k = 1; k <= 30; k += 1) {
      vfx.terrainVfxTick(0.016, scene3d, 500 + k * 0.016);
      const pp = fakeManager.lastReq.parent.position;
      if (!Object.is(pp.z, or.heightAt(pp.x, pp.y))) onGround = false;
    }
    check("L15: the devil walk through a real oracle samples every frame into ONE reused result",
      s.activeDevils().length === 1 && walkCalls - before >= 30 && walkSameObj,
      `live=${s.activeDevils().length} calls=${walkCalls - before} same=${walkSameObj}`);
    check("L15: … and stands the devil exactly on the oracle's ground (bit-identical z)", onGround);
    player.x = home.x; player.y = home.y;
  }

  sand._resetTerrainSand();
  vfx._resetTerrainVfx();
  clearUrl(); _resetVfxFlags();
}

// ===========================================================================
console.log("\n-- L16 2026-10-24: no racing streamers (the rock R14 port) ------");
// ===========================================================================
{
  const { writeWindVector } = await import("./scene3d/vfx/weather_inputs.js");
  const winAc = { x: 0, y: 0 };
  /** |wind| as the GLSL forms it (max(length, 1e-4)); leaves the AC wind in winAc. */
  const wlOf = (g) => { sand.windAcFromGlobals(g, winAc); return Math.max(Math.hypot(winAc.x, winAc.y), 1e-4); };

  // The GLSL's OWN advection and gust-sheet lines, evaluated on the field's
  // live uniforms (so the check follows the shader, not a JS restatement).
  const mT = /float travelled = ([^;]+);/.exec(VGLSL);
  const mP = /vec2 pq = ([^;]+);/.exec(VGLSL);
  check("L16: the streamer GLSL carries exactly one advection line and one gust-sheet line",
    !!mT && !!mP && VGLSL.split("float travelled =").length === 2
    && VGLSL.split("vec2 pq =").length === 2);
  // eslint-disable-next-line no-new-func
  const glslTravelled = new Function("uTime", "uTravel", "uSpeed", "uSpanM", "aStreak", "wl",
    `return (${mT ? mT[1] : "NaN"});`);
  // The pq line is vec2-linear (elementwise), so it evaluates one component at
  // a time with every vec2 symbol bound to that component.
  // eslint-disable-next-line no-new-func
  const glslPq = new Function("centreXy", "dir", "uPulseOffset", "uTime", "uPulseSpeed", "uPulseFreq",
    `return (${mP ? mP[1] : "NaN"});`);
  // The OLD forms through the same machinery: the suite's own proof that the
  // session discriminates (they must race where the fix does not).
  const oldTravelled = (uTime, uSpeed, uSpanM, a, wl) => uTime * uSpeed * a.y * wl + a.x * uSpanM;
  const oldPq = (c, d, uTime, uPulseSpeed, uPulseFreq) => (c - d * (uTime * uPulseSpeed)) * uPulseFreq;
  const liveStreaks = (field) => {
    const ag = field.pool.arrays.aStreak;
    const out = [];
    for (let i = 0; i < field.pool.count; i += 1) {
      if (field.pool.isLive(i)) out.push({ x: ag[i * 4], y: ag[i * 4 + 1], z: ag[i * 4 + 2], w: ag[i * 4 + 3] });
    }
    return out;
  };
  // A fixed world point for the gust pattern: how fast the sheets sweep past it.
  const CX = 500.5, CY = 499.5;

  {
    // (1) NO RACING. A 3600 s session at 60 fps under the REAL calm wind —
    // |wind| breathes +-6 % over 13 s, the direction wanders +-12 deg over
    // 45 s. Every ribbon's per-frame step along the wind must stay within
    // dt x speed x max multiplier x max |wind|; the old uTime x |wind| product
    // moved t x d|wind|/dt and aliased across the span. The gust pattern must
    // move at most dt x pulseSpeed per frame, always downwind; the old
    // dir x uTime swept sideways at uTime x the wander rate.
    const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 0, y: 0 } } };
    const field = sand.createSandStreamerField({
      oracle: makeOracle(() => 10), globals, count: 16, radiusM: 16, seed: 9,
    });
    const U = field.uniforms;
    const uTravelNow = () => (U.uTravel ? U.uTravel.value : NaN);
    const NAN2 = { x: NaN, y: NaN };
    const poNow = () => (U.uPulseOffset && U.uPulseOffset.value ? U.uPulseOffset.value : NAN2);
    const DT = 1 / 60;
    const FRAMES = 3600 * 60;
    writeWindVector(0, 0, globals.uWindDir.value);
    field.update(DT, 0, 500, 500, 20);
    const live = liveStreaks(field);
    check("L16: the racing session has live ribbons to watch", live.length > 0, String(live.length));
    const span = U.uSpanM.value;
    const speed = U.uSpeed.value;
    const freq = U.uPulseFreq.value;
    const pv = U.uPulseSpeed.value;
    const sOf = (tr) => tr - span * Math.floor(tr / span) - span * 0.5;
    const circ = (d) => Math.abs(d - span * Math.round(d / span));   // the recycle is a wrap, not a step
    let wl = wlOf(globals);
    let dx = winAc.x / wl, dy = winAc.y / wl;
    const t0 = globals.uTime.value;
    const prevNew = live.map((a) => sOf(glslTravelled(t0, uTravelNow(), speed, span, a, wl)));
    const prevOld = live.map((a) => sOf(oldTravelled(t0, speed, span, a, wl)));
    let po = poNow();
    let pqX = glslPq(CX, dx, po.x, t0, pv, freq), pqY = glslPq(CY, dy, po.y, t0, pv, freq);
    let oqX = oldPq(CX, dx, t0, pv, freq), oqY = oldPq(CY, dy, t0, pv, freq);
    let maxStep = 0, maxStepOld = 0, maxGust = wl, travelLo = Infinity, travelHi = -Infinity;
    let maxPq = 0, maxPqOld = 0, minCos = 1, downFrames = 0;
    let maxMul = 0;
    for (const a of live) maxMul = Math.max(maxMul, a.y);
    for (let f = 1; f <= FRAMES; f += 1) {
      const t = f * DT;
      globals.uTime.value = t;                               // loop.js drives the shared clock
      writeWindVector(t, 0, globals.uWindDir.value);         // the real calm wind
      field.update(DT, t, 500, 500, 20);
      wl = wlOf(globals);
      dx = winAc.x / wl; dy = winAc.y / wl;
      if (wl > maxGust) maxGust = wl;
      const tr = uTravelNow();
      if (tr < travelLo) travelLo = tr;
      if (tr > travelHi) travelHi = tr;
      for (let j = 0; j < live.length; j += 1) {
        const sN = sOf(glslTravelled(t, tr, speed, span, live[j], wl));
        const dN = circ(sN - prevNew[j]);
        if (!(dN <= maxStep)) maxStep = Number.isNaN(dN) ? Infinity : dN;
        prevNew[j] = sN;
        const sO = sOf(oldTravelled(t, speed, span, live[j], wl));
        const dO = circ(sO - prevOld[j]);
        if (dO > maxStepOld) maxStepOld = dO;
        prevOld[j] = sO;
      }
      po = poNow();
      const qX = glslPq(CX, dx, po.x, t, pv, freq), qY = glslPq(CY, dy, po.y, t, pv, freq);
      const ddx = qX - pqX, ddy = qY - pqY;
      const len = Math.hypot(ddx, ddy);
      const stepM = len / freq;
      if (!(stepM <= maxPq)) maxPq = Number.isNaN(stepM) ? Infinity : stepM;
      // pq = (centre - offset) x freq: the PATTERN moves by -dpq / freq.
      if (len > 0) {
        const c = -(ddx * dx + ddy * dy) / len;
        if (c >= 0.9999) downFrames += 1;
        if (!(c >= minCos)) minCos = Number.isNaN(c) ? -Infinity : c;
      }
      pqX = qX; pqY = qY;
      const oX = oldPq(CX, dx, t, pv, freq), oY = oldPq(CY, dy, t, pv, freq);
      const oStep = Math.hypot(oX - oqX, oY - oqY) / freq;
      if (oStep > maxPqOld) maxPqOld = oStep;
      oqX = oX; oqY = oY;
    }
    const bound = DT * speed * Math.max(maxMul, 1.35) * maxGust;
    const pBound = DT * pv;
    check("L16: self-check — the OLD uTime x |wind| form races in this very session "
      + "(so the next check has teeth)", maxStepOld > 10 * bound,
      `old max step ${maxStepOld.toFixed(3)} m/frame vs bound ${bound.toFixed(4)}`);
    check("L16: ★ no racing: over a 3600 s breathing-wind session every ribbon's per-frame step "
      + "stays <= dt x speed x max multiplier x max |wind| (the GLSL line, evaluated)",
      maxStep <= bound + 1e-9, `max step ${maxStep} m/frame vs bound ${bound}`);
    check("L16: self-check — the OLD dir x (uTime x uPulseSpeed) sheet scroll races in this session",
      maxPqOld > 10 * pBound, `old max ${maxPqOld.toFixed(3)} m/frame vs bound ${pBound.toFixed(4)}`);
    check("L16: ★ the gust sheets never race either: the pattern moves <= dt x pulseSpeed per frame "
      + "(the GLSL pq line, evaluated)",
      maxPq <= pBound + 1e-9, `max ${maxPq} m/frame vs bound ${pBound}`);
    check("L16: ★ ...and every frame it moves DOWNWIND (the 2026-10-23 sign fix holds under a live wind)",
      downFrames === FRAMES && minCos >= 0.9999, `down=${downFrames}/${FRAMES} minCos=${minCos}`);
    const wrap = typeof sand.streamerTravelWrap === "function" ? sand.streamerTravelWrap(span, speed) : NaN;
    const st = field.stats();
    check("L16: ★ travel stays BOUNDED all session: uTravel in [0, wrap), and it wrapped "
      + "(seamlessly: the step bound above held across every wrap frame)",
      travelLo >= 0 && travelHi < wrap && st.travelWraps >= 2 && st.travelWrap === wrap,
      `range ${travelLo}..${travelHi} wrap=${wrap} wraps=${st.travelWraps}`);
    check("L16: every live ribbon's speed multiplier is an exact k/64 in the 0.75..1.35 spread "
      + "(what makes the wrap seamless)",
      live.every((a) => Number.isInteger(a.y * 64) && a.y >= 0.75 && a.y <= 1.35));
    // A resumed background tab: a 30 s frame advances at most STREAMER_MAX_DT.
    const maxDt = sand.STREAMER_MAX_DT;
    const before = uTravelNow();
    const pB = { x: poNow().x, y: poNow().y };
    field.update(30, 3630, 500, 500, 20);
    const adv = (uTravelNow() - before + wrap) % wrap;
    check("L16: a long (backgrounded-tab) frame is clamped to STREAMER_MAX_DT of travel and sheet drift",
      adv <= maxDt * maxGust + 1e-9
      && Math.hypot(poNow().x - pB.x, poNow().y - pB.y) <= maxDt * pv + 1e-9,
      `adv=${adv}`);
    check("L16: the clock still reaches the shader (meander + grain run at tuning-constant rates)",
      U.uTime.value === 3630 && /uTime \* uWaveW/.test(VGLSL) && /uTime \* uSpeed \* 0\.9/.test(VGLSL));
    field.dispose();
  }

  {
    // (2) THE LOOK AT CONSTANT WIND IS UNCHANGED. Under a constant wind the
    // integrated travel IS t x |wind| and the integrated sheet offset IS
    // dir x pulseSpeed x t, so the GLSL lines must reproduce the old closed
    // forms (same speeds, same span, same downwind drift) — across a travel
    // wrap, which must therefore be seamless.
    const globals = { uWindDir: { value: { x: 0.9, y: -0.3 } } };   // three (x, z) -> AC (0.9, 0.3)
    const field = sand.createSandStreamerField({
      oracle: makeOracle(() => 10), globals, count: 16, radiusM: 16, seed: 9,
    });
    const U = field.uniforms;
    const DT = 1 / 60;
    const FRAMES = 1500 * 60;   // |w| ~0.95 -> ~1420 s of travel, past one ~1280 s wrap
    let tAcc = 0;
    field.update(DT, tAcc + DT, 500, 500, 20);
    tAcc += DT;
    const live = liveStreaks(field);
    const span = U.uSpanM.value;
    const speed = U.uSpeed.value;
    const freq = U.uPulseFreq.value;
    const pv = U.uPulseSpeed.value;
    const circ = (d) => Math.abs(d - span * Math.round(d / span));
    const wl = wlOf(globals);
    const dx = winAc.x / wl, dy = winAc.y / wl;
    let worstS = 0, worstPq = 0, worstTwin = 0, samples = 0;
    for (let f = 2; f <= FRAMES; f += 1) {
      tAcc += DT;
      field.update(DT, tAcc, 500, 500, 20);
      if (f % 997 !== 0 && f !== FRAMES) continue;
      samples += 1;
      const tr = U.uTravel ? U.uTravel.value : NaN;
      for (const a of live) {
        const sNew = glslTravelled(tAcc, tr, speed, span, a, wl);
        const sOld = oldTravelled(tAcc, speed, span, a, wl);
        const e = circ(sNew - sOld);
        worstS = Math.max(worstS, Number.isNaN(e) ? Infinity : e);
        // The field's CPU twin reports what the GLSL draws.
        const tw = field.advectionOf(a.x, a.y);
        const sG = sNew - span * Math.floor(sNew / span) - span * 0.5;
        const et = circ(tw.s - sG);
        worstTwin = Math.max(worstTwin, Number.isNaN(et) ? Infinity : et);
      }
      const po = U.uPulseOffset && U.uPulseOffset.value ? U.uPulseOffset.value : { x: NaN, y: NaN };
      const ex = Math.abs(glslPq(CX, dx, po.x, tAcc, pv, freq) - oldPq(CX, dx, tAcc, pv, freq));
      const ey = Math.abs(glslPq(CY, dy, po.y, tAcc, pv, freq) - oldPq(CY, dy, tAcc, pv, freq));
      worstPq = Math.max(worstPq, Number.isNaN(ex + ey) ? Infinity : Math.max(ex, ey));
    }
    const st = field.stats();
    check("L16: constant wind — the session crossed a travel wrap (so the next checks span it)",
      samples > 50 && st.travelWraps >= 1, `wraps=${st.travelWraps} samples=${samples}`);
    check("L16: ★ constant wind — every ribbon sits EXACTLY where the old uTime x |wind| form put it "
      + "(same speeds, same 18 m span, seamless across the wrap)",
      live.length > 0 && worstS < 1e-5, `worst ${worstS} m`);
    check("L16: ★ constant wind — the gust sheets sit exactly where the old downwind scroll put them",
      worstPq < 1e-6, `worst ${worstPq} noise units`);
    check("L16: advectionOf() reports the live as-drawn advection (the GLSL twin)",
      worstTwin < 1e-6, `worst ${worstTwin} m`);
    field.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log(`\nterrain sand: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
