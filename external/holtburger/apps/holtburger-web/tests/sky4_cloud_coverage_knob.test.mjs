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
//   K4  (SKY-4 remainder, 2026-10-18 follow-up) a knob set to EXACTLY the
//       look's current value (0.5 fair, 0.55 storm) is kept across the next
//       storm edge. The fix pass told a knob from the look by comparing values,
//       so this case was taken back; the knobs now mark the effect
//       (setCloudCoverageKnob) and the look never writes a marked coverage.
//   K5  the setter: clamps, ignores a non-number (no mark), per effect.
//   K6  wiring: index.js writes both knobs through setCloudCoverageKnob, and
//       imports it with the specifier the overlay / volume use (one module
//       instance, so one set of marks).
//
// Knobs are written as index.js writes them: through setCloudCoverageKnob
// (falling back to the raw `effect.coverage =` write index.js did before, so
// the suite also runs against the previous modules).
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
// index.js's knob write (`?cloudCoverage`, `__setCloudCoverage`).
const knob = typeof LOOK.setCloudCoverageKnob === "function"
  ? LOOK.setCloudCoverageKnob
  : (e, val) => { e.coverage = Math.max(0, Math.min(1, +val)); return e.coverage; };

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
  // index.js: `setCloudCoverageKnob(effect, coverageParam);`
  knob(effect, 0.8);
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
  knob(e, 0.25);                            // index.js __setCloudCoverage
  LOOK.applyCloudLook(e, false);
  LOOK.applyCloudLook(e, true);
  check("after the knob: coverage kept across both edges", e.coverage === 0.25, `coverage=${e.coverage}`);
  check("haze density still follows the look", e.clouds.hazeDensityScale === LOOK.STORM_HAZE_DENSITY);
  const f = { cloudLayers: [{}, {}, {}, {}], coverage: 0.3, haze: false, clouds: { hazeDensityScale: 0 } };
  LOOK.applyCloudLook(f, true);
  check("the look's memory is per effect (a fresh effect gets the look)", f.coverage === LOOK.STORM_COVERAGE);
}

// ---------------------------------------------------------------------------
console.log("\n-- K4 a knob equal to the look's current value is still the knob's ------");
{
  // ?cloudCoverage=0.5 on a real overlay: the construct-time fair look is 0.5.
  const overlay = new CloudOverlay({ camera: new THREE.PerspectiveCamera(), proceduralTextures: true });
  const vol = overlay.volume;
  const effect = vol.effect;
  knob(effect, LOOK.FAIR_COVERAGE);
  vol._applyLook(false, "boot");            // first tick, fair DayGroup
  check("?cloudCoverage=0.5, fair boot: 0.5", effect.coverage === LOOK.FAIR_COVERAGE);
  vol._applyLook(true, "edge");             // fair -> storm
  check("fair -> storm edge: the knob's 0.5 stays (not the storm 0.55)",
    effect.coverage === LOOK.FAIR_COVERAGE && LOOK.cloudLayersMatchLook(effect, true), `coverage=${effect.coverage}`);
  vol.invalidateCloudLook("adopted");
  vol._applyLook(true, "adopted");
  vol._applyLook(false, "edge");
  check("adoption + storm -> fair: still 0.5, the layers fair", effect.coverage === LOOK.FAIR_COVERAGE &&
    LOOK.cloudLayersMatchLook(effect, false));
  overlay.dispose?.();

  // __setCloudCoverage(0.55) mid-storm: exactly the storm look's value.
  const e = { cloudLayers: [{}, {}, {}, {}], coverage: 0.3, haze: false, clouds: { hazeDensityScale: 0 } };
  LOOK.applyCloudLook(e, true);
  check("storm look: 0.55", e.coverage === LOOK.STORM_COVERAGE);
  knob(e, LOOK.STORM_COVERAGE);
  LOOK.applyCloudLook(e, false);
  check("__setCloudCoverage(0.55), then storm -> fair: the knob's 0.55 stays (not the fair 0.5)",
    e.coverage === LOOK.STORM_COVERAGE, `coverage=${e.coverage}`);
  LOOK.applyCloudLook(e, true);
  LOOK.applyCloudLook(e, false);
  check("... across every later edge; haze density still follows the look",
    e.coverage === LOOK.STORM_COVERAGE && e.clouds.hazeDensityScale === LOOK.FAIR_HAZE_DENSITY);
  // A non-knob write the look did not make (devtools __resetCloudLayers'
  // 0.3) is not a knob: the next look apply owns coverage again.
  const g = { cloudLayers: [{}, {}, {}, {}], coverage: 0.3, haze: false, clouds: { hazeDensityScale: 0 } };
  LOOK.applyCloudLook(g, false);
  g.coverage = 0.3;
  LOOK.applyCloudLook(g, true);
  check("a raw (non-knob) write is not a knob: the next apply writes the look", g.coverage === LOOK.STORM_COVERAGE,
    `coverage=${g.coverage}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- K5 setCloudCoverageKnob ---------------------------------------------");
{
  const set = LOOK.setCloudCoverageKnob;
  const owned = LOOK.cloudCoverageOwnedByKnob;
  check("exported (setter + query)", typeof set === "function" && typeof owned === "function");
  if (typeof set === "function" && typeof owned === "function") {
    const mk = () => ({ cloudLayers: [{}, {}, {}, {}], coverage: 0.5, haze: false, clouds: { hazeDensityScale: 0 } });
    const a = mk();
    check("returns the coverage in force, clamped to [0, 1]", set(a, 3) === 1 && a.coverage === 1 && set(a, -2) === 0 && a.coverage === 0);
    check("a string number is accepted (+v, as __setCloudCoverage did)", set(a, "0.7") === 0.7 && owned(a) === true);
    const b = mk();
    check("a non-number changes nothing and marks nothing", set(b, "abc") === 0.5 && b.coverage === 0.5 && owned(b) === false);
    LOOK.applyCloudLook(b, true);
    check("... so the look still owns that effect's coverage", b.coverage === LOOK.STORM_COVERAGE);
    check("no effect: null, no throw", set(null, 0.4) === null && owned(null) === false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n-- K6 wiring --------------------------------------------------------------");
{
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(path.join(APP, f), "utf8");
  const idx = src("scene3d/index.js");
  check("index.js imports setCloudCoverageKnob from \"./cloud_storm_look.js\" (no ?v=: one module instance)",
    /import \{ setCloudCoverageKnob \} from "\.\/cloud_storm_look\.js";/.test(idx));
  check("?cloudCoverage goes through it", /setCloudCoverageKnob\(effect, coverageParam\);/.test(idx));
  check("__setCloudCoverage goes through it", /window\.__setCloudCoverage = \(v\) =>[\s\S]{0,240}?setCloudCoverageKnob\(effect, v\);/.test(idx));
  check("no raw coverage write left in index.js", !/\beffect\.coverage\s*=[^=]/.test(idx));
  check("the overlay and the volume import the same specifier",
    /from '\.\/cloud_storm_look\.js';/.test(src("scene3d/cloud_overlay.js")) &&
    /from '\.\/cloud_storm_look\.js';/.test(src("scene3d/cloud_volume.js")));
}

console.log(`\nsky4 cloud coverage knob: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
