// tests/sky7_dirt_footfall_sweep.test.mjs — 2026-10-18 systematic review SKY-7.
//
// `?terrainDirt=on` (flag-only; the dirt family ships off on every tier) rate-
// limits footfall puffs per entity with a guid -> last-step-time map. Nothing
// ever deleted from it, and monsters respawn under fresh guids, so a long hunt
// grew it without bound. Entries only matter for puffMinIntervalSec after the
// step; past a size the map is swept of the stale ones.
//
//   F1  2,000 distinct guids stepping over ~12 s of frames: the map stays
//       bounded (rateLimitEntries in __terrainDirt.stats()).
//   F2  the limiter still works across a sweep: a guid that just stepped is
//       still rejected right after a sweep, and accepted once the interval
//       has passed.
//
// Drives the REAL terrain_dirt.js through the real terrain_vfx spine (as
// test_terrain_dirt.mjs D13).
//
// Run: node tests/sky7_dirt_footfall_sweep.test.mjs

import { familyForCode } from "../scene3d/terrain_families.js";
import { initTerrainDirt, _resetTerrainDirt, DIRT_TUNING } from "../scene3d/terrain_dirt.js";
import { initTerrainVfx, terrainVfxTick, _resetTerrainVfx } from "../scene3d/terrain_vfx.js";
import { _resetVfxFlags } from "../scene3d/vfx_flags.js";
import { _resetVfxCatalog } from "../scene3d/vfx_catalog.js";
import { PRESETS } from "../scene3d/quality.js";

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

globalThis.window = { location: { search: "?terrainDirt=on&terrainFootfall=on" } };
_resetVfxCatalog();
_resetVfxFlags();
_resetTerrainVfx();
_resetTerrainDirt();

const facade = {
  terrainMaterials: [], terrainGroup: { parent: null },
  frameTime: { tsSec: 50, dt: 0.02 },
  cameraSwitcher: { _safePlayerPos: () => ({ x: 0, y: 0, z: 10 }) },
  quality: { flags: PRESETS.high },
};
// PackedDirt (code 7) everywhere, flat ground at z = 10: every step puffs.
const oracle = {
  sample(x, y, out) {
    return Object.assign(out || {}, { code: 7, family: familyForCode(7), height: 10, hasHeight: true, nx: 0, ny: 0, nz: 1 });
  },
};
initTerrainVfx({ scene3d: facade });
const surface = initTerrainDirt({
  scene3d: facade, getOracle: () => oracle, readEnv: () => ({ wetness: 0, temperatureC: 25 }),
});
check("fixture: the dirt family + footfall hook are live", !!surface && typeof facade.onTerrainFootfall === "function");

let t = 50;
const tick = () => { t += 0.02; terrainVfxTick(0.02, facade, t); };

// ---------------------------------------------------------------------------
console.log("\n-- F1 many guids, a bounded map -----------------------------------------");
{
  tick();
  let accepted = 0;
  let maxEntries = 0;
  // 3 new guids a frame (inside the 4-puff frame budget), 50 fps.
  for (let g = 0; g < 2000; g++) {
    if (g % 3 === 0) tick();
    if (facade.onTerrainFootfall(0x80000000 + g, 1 + (g % 7) * 0.1, 1, 10)) accepted++;
    maxEntries = Math.max(maxEntries, surface.stats().rateLimitEntries);
  }
  const st = surface.stats();
  check("every step on dry dirt puffed (the fixture really exercises the limiter)",
    st.counters.footfalls === 2000 && st.counters.footfallsRejected === 0, JSON.stringify(st.counters));
  check("the rate-limit map stays bounded (2,000 guids seen)",
    Number.isFinite(maxEntries) && maxEntries > 0 && maxEntries <= 256, `max=${maxEntries} now=${st.rateLimitEntries}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- F2 the limiter still holds across a sweep -----------------------------");
{
  tick();
  const hero = 0x50000001;
  const t0 = t;
  check("a fresh guid steps", facade.onTerrainFootfall(hero, 1, 1, 10) === true);
  // Other guids at 1 ms frames: the map crosses the sweep size well inside the
  // hero's interval, so a sweep runs while the hero's entry is fresh.
  let swept = false;
  let prev = surface.stats().rateLimitEntries;
  for (let g = 0; g < 400 && t - t0 < DIRT_TUNING.puffMinIntervalSec * 0.9; g++) {
    if (g % 3 === 0) { t += 0.001; terrainVfxTick(0.001, facade, t); }
    facade.onTerrainFootfall(0x90000000 + g, 1, 1, 10);
    const n = surface.stats().rateLimitEntries;
    if (n < prev) swept = true;
    prev = n;
  }
  check("fixture: a sweep ran inside the hero's interval",
    swept && t - t0 < DIRT_TUNING.puffMinIntervalSec, `swept=${swept} dt=${(t - t0).toFixed(3)}`);
  check("the same guid within puffMinIntervalSec is still rejected after the sweep",
    facade.onTerrainFootfall(hero, 1.2, 1, 10) === false);
  t += DIRT_TUNING.puffMinIntervalSec + 0.01;
  terrainVfxTick(0.02, facade, t);
  check("and steps again once the interval has passed", facade.onTerrainFootfall(hero, 1.2, 1, 10) === true);
}

_resetTerrainDirt();
_resetTerrainVfx();
delete globalThis.window;
_resetVfxCatalog();
_resetVfxFlags();
console.log(`\nsky7 dirt footfall sweep: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
