// tests/sky4_cloud_coverage_knob.test.mjs — 2026-10-18 systematic review SKY-4.
//
// `?cloudCoverage=<n>` (index.js, right after the CloudOverlay is built) and
// `__setCloudCoverage(n)` write `effect.coverage`. The storm/fair look
// (cloud_storm_look.js applyCloudLook) is re-applied on the first CloudVolume
// tick ('boot'), after the main pass adopts the effect ('adopted') and on every
// storm edge, and each apply wrote the look's 0.5 / 0.55 over the knob: the
// flag was dead unless `?cloudWeather=off` (film `--weather=live --coverage=X`
// got the default coverage). The look must not fight a knob
// (cloudLayersMatchLook's own rule); the layers and haze still follow the look.
//
//   K1  the production order on a REAL CloudOverlay / takram CloudsEffect:
//       construct (fair look) -> ?cloudCoverage -> boot / adopted / edge
//       re-applies keep the knob, the layers still switch looks.
//   K2  without a knob the look still owns coverage (fair 0.5 <-> storm 0.55).
//   K3  a knob set mid-session (__setCloudCoverage) is kept across edges.
//
// Run: node tests/sky4_cloud_coverage_knob.test.mjs

import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
// index.html's import map, mirrored for node (as tests/clouds_main_pass).
const MAP = {
  "@takram/three-clouds": v("vendor/takram-three-clouds/build/index.js"),
  "@takram/three-atmosphere": v("vendor/takram/three-atmosphere.js"),
  "@takram/three-atmosphere/shaders/bruneton": v("vendor/takram/three-atmosphere-shaders-bruneton.js"),
  "@takram/three-geospatial": v("vendor/takram/three-geospatial.js"),
  "@takram/three-geospatial/shaders": v("vendor/takram/three-geospatial-shaders.js"),
  "@takram/three-geospatial-effects": v("vendor/takram/three-geospatial-effects.js"),
};
register(
  "data:text/javascript," +
    encodeURIComponent(
      `const M = ${JSON.stringify(MAP)};
      export async function resolve(spec, ctx, next) {
        if (M[spec]) return { url: M[spec], shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

globalThis.window = globalThis.window || {};
const THREE = await import("three");
const LOOK = await import("../scene3d/cloud_storm_look.js");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- K1 ?cloudCoverage survives the look's re-applies (real overlay) ----");
{
  const overlay = new CloudOverlay({ camera: new THREE.PerspectiveCamera(), proceduralTextures: true });
  const vol = overlay.volume;
  const effect = vol.effect;
  check("construct: the fair look, coverage 0.5", effect.coverage === LOOK.FAIR_COVERAGE && LOOK.cloudLayersMatchLook(effect, false));
  // index.js: `effect.coverage = Math.max(0, Math.min(1, coverageParam));`
  effect.coverage = 0.8;
  vol._applyLook(true, "boot");             // first tick, storm DayGroup
  check("boot re-apply (storm): coverage stays at the knob", effect.coverage === 0.8, `coverage=${effect.coverage}`);
  check("... and the layers carry the storm look", LOOK.cloudLayersMatchLook(effect, true));
  vol.invalidateCloudLook("adopted");       // CloudOverlay.adoptMainPass
  vol._applyLook(true, "adopted");
  check("re-apply after adoption: coverage stays at the knob", effect.coverage === 0.8, `coverage=${effect.coverage}`);
  vol._applyLook(false, "edge");            // storm -> fair
  check("storm -> fair edge: coverage stays, the layers go fair",
    effect.coverage === 0.8 && LOOK.cloudLayersMatchLook(effect, false), `coverage=${effect.coverage}`);
  overlay.dispose?.();
}

// ---------------------------------------------------------------------------
console.log("\n-- K2 no knob: the look owns coverage ---------------------------------");
{
  const overlay = new CloudOverlay({ camera: new THREE.PerspectiveCamera(), proceduralTextures: true });
  const vol = overlay.volume;
  const effect = vol.effect;
  vol._applyLook(true, "boot");
  check("boot (storm): storm coverage", effect.coverage === LOOK.STORM_COVERAGE, `coverage=${effect.coverage}`);
  vol._applyLook(false, "edge");
  check("storm -> fair: fair coverage", effect.coverage === LOOK.FAIR_COVERAGE, `coverage=${effect.coverage}`);
  vol._applyLook(true, "edge");
  check("fair -> storm: storm coverage again", effect.coverage === LOOK.STORM_COVERAGE, `coverage=${effect.coverage}`);
  overlay.dispose?.();
}

// ---------------------------------------------------------------------------
console.log("\n-- K3 a knob set mid-session (__setCloudCoverage) ---------------------");
{
  const e = { cloudLayers: [{}, {}, {}, {}], coverage: 0.3, haze: false, clouds: { hazeDensityScale: 0 } };
  LOOK.applyCloudLook(e, false);
  check("the first apply writes the look (0.5)", e.coverage === LOOK.FAIR_COVERAGE);
  LOOK.applyCloudLook(e, true);
  check("storm edge, no knob yet: 0.55", e.coverage === LOOK.STORM_COVERAGE);
  e.coverage = 0.25;                        // index.js __setCloudCoverage
  LOOK.applyCloudLook(e, false);
  LOOK.applyCloudLook(e, true);
  check("after the knob: coverage kept across both edges", e.coverage === 0.25, `coverage=${e.coverage}`);
  check("haze density still follows the look", e.clouds.hazeDensityScale === LOOK.STORM_HAZE_DENSITY);
  const f = { cloudLayers: [{}, {}, {}, {}], coverage: 0.3, haze: false, clouds: { hazeDensityScale: 0 } };
  LOOK.applyCloudLook(f, true);
  check("the look's memory is per effect (a fresh effect gets the look)", f.coverage === LOOK.STORM_COVERAGE);
}

console.log(`\nsky4 cloud coverage knob: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
