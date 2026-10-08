// test_fog_band.mjs — HORIZON FOG (2026-10-07, `?horizonFog`, default ON) and
// the clouds-at-full-opacity AerialPerspective blend (`?cloudsFullOpacity`).
//
// Owner, on the 1070: "the fog is a bit much and interferes with the
// visibility of the takram clouds ... i mainly want it on the horizon to hide
// if there is nothing loaded beyond the horizon, and to provide a sense of
// depth at distance."
//
//   F1  computeFogBand (far_terrain_flags.js) — the fog-distance math that
//       loop.js::tickDistanceFogColor applies, driven with the LIVE evidence
//       (authored dusk band 85 -> 796 m, R_eff = 5) and the legacy cases.
//   F2  invariants over a grid: fog-before-edge (far <= drawn edge) in every
//       mode, and the horizon band never fogs MORE than the legacy band at any
//       distance (the change can only remove fog).
//   F3  flag readers: horizonFog default-ON with =off escape (and the
//       farTerrain master), horizonFogNear default + clamp.
//   F4  aerialBlendOpacity: 1.0 with clouds in the main pass, 0.6 otherwise,
//       ?cloudsFullOpacity=off and ?aerialOpacity=N.
//   F5  source wiring: loop.js uses computeFogBand gated on the sky being
//       visible; index.js derives the AP opacity from the adopted main pass;
//       url-flags.md documents the new flags.
//
// Run: node test_fog_band.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// The flag readers read window.location.search; give them one we control.
globalThis.window = { location: { search: "" } };
const flags = await import("./scene3d/far_terrain_flags.js");
const {
  computeFogBand, horizonFogEnabled, horizonFogNearFrac,
  _resetFarTerrainFlagsForTest,
} = flags;
function withSearch(search, fn) {
  globalThis.window.location.search = search;
  _resetFarTerrainFlagsForTest();
  try { return fn(); } finally {
    globalThis.window.location.search = "";
    _resetFarTerrainFlagsForTest();
  }
}

// three's linear fog: smoothstep(near, far, depth) — the terrain tail
// (terrain_shared_glsl.js) and <fog_fragment> both use exactly this.
function fogFactor(band, d) {
  const t = Math.min(1, Math.max(0, (d - band.near) / (band.far - band.near)));
  return t * t * (3 - 2 * t);
}

const DEFAULTS = { frac: 0.95, floorM: 700, floorMinLb: 3, horizonNear: 0.45 };

// ---------------------------------------------------------------------------
console.log("-- F1 computeFogBand ------------------------------------------------");
{
  // Live evidence 2026-10-07 18:55: authored dusk band ~85 -> 796 m, R = 5.
  const live = { ...DEFAULTS, authoredMin: 85, authoredMax: 796, rEffLb: 5 };
  const legacy = computeFogBand({ ...live, horizon: false });
  check("legacy (=off / indoors): the authored dusk band is applied verbatim (796 < edge)",
    legacy.near === 85 && legacy.far === 796 && legacy.mode === "authored",
    JSON.stringify(legacy));
  check("legacy reproduces the reported near-field haze: 200 m ~7 %, 400 m ~41 %",
    fogFactor(legacy, 200) > 0.06 && fogFactor(legacy, 400) > 0.4,
    `${fogFactor(legacy, 200).toFixed(3)} ${fogFactor(legacy, 400).toFixed(3)}`);
  const hz = computeFogBand({ ...live, horizon: true });
  check("horizon: drawn edge (5 + 0.5) * 192 = 1056 m", near(hz.drawnEdgeM, 1056), String(hz.drawnEdgeM));
  check("horizon: far = 0.95 x 1056 = 1003.2 m (the fog-before-edge clamp, now always the far end)",
    near(hz.far, 1003.2), String(hz.far));
  check("horizon: near = 0.45 x 1056 = 475.2 m", near(hz.near, 475.2), String(hz.near));
  check("horizon: mode tag", hz.mode === "horizon");
  check("horizon: near field (<= 450 m) is completely clear",
    fogFactor(hz, 100) === 0 && fogFactor(hz, 300) === 0 && fogFactor(hz, 450) === 0);
  const f600 = fogFactor(hz, 600), f800 = fogFactor(hz, 800), f1000 = fogFactor(hz, 1000);
  check("horizon: depth haze builds over the outer world (600 m < 25 %, 800 m 50-80 %, 1000 m > 99 %)",
    f600 < 0.25 && f800 > 0.5 && f800 < 0.8 && f1000 > 0.99,
    `${f600.toFixed(3)} ${f800.toFixed(3)} ${f1000.toFixed(4)}`);
  check("horizon: fully fogged AT the drawn edge (nothing pops at the ring edge)",
    fogFactor(hz, hz.drawnEdgeM) === 1);
}
{
  // Retail clear day 150 -> 2400 m: legacy clamps far only; horizon moves near out.
  const clear = { ...DEFAULTS, authoredMin: 150, authoredMax: 2400, rEffLb: 5 };
  const legacy = computeFogBand({ ...clear, horizon: false });
  check("legacy clear day: far clamped to 1003.2, near stays authored 150 (mode clamped)",
    legacy.near === 150 && near(legacy.far, 1003.2) && legacy.mode === "clamped", JSON.stringify(legacy));
  const hz = computeFogBand({ ...clear, horizon: true });
  check("horizon clear day: 475.2 -> 1003.2", near(hz.near, 475.2) && near(hz.far, 1003.2), JSON.stringify(hz));
  // An authored near beyond the horizon start is kept (never adds fog).
  const late = computeFogBand({ ...DEFAULTS, authoredMin: 600, authoredMax: 2400, rEffLb: 5, horizon: true });
  check("horizon keeps a later authored near (600 > 475.2)", late.near === 600, JSON.stringify(late));
}
{
  // Night authored 0 -> 400 m with the fogRingCap ring (ceil(400/192)+1 = 4).
  const night = computeFogBand({ ...DEFAULTS, authoredMin: 0, authoredMax: 400, rEffLb: 4, horizon: true });
  check("night (R = 4): band follows the smaller drawn edge 864 m -> 388.8 -> 820.8",
    near(night.near, 388.8) && near(night.far, 820.8), JSON.stringify(night));
}
{
  // Boot fill: R = 1 (288 m edge), floor gated off below 3 LB.
  const boot = { ...DEFAULTS, authoredMin: 150, authoredMax: 2400, rEffLb: 1 };
  const legacy = computeFogBand({ ...boot, horizon: false });
  const hz = computeFogBand({ ...boot, horizon: true });
  check("boot R = 1: far = 0.95 x 288 = 273.6 in both modes",
    near(legacy.far, 273.6) && near(hz.far, 273.6));
  check("boot R = 1: horizon near = max(150, 129.6) = 150", hz.near === 150, JSON.stringify(hz));
  // Degenerate: drawn world smaller than the authored START.
  const tiny = { ...DEFAULTS, authoredMin: 200, authoredMax: 2400, rEffLb: 0.5 };
  const lt = computeFogBand({ ...tiny, horizon: false });
  const ht = computeFogBand({ ...tiny, horizon: true });
  check("degenerate legacy band scales near to far x 0.1 (the HD520 boot fix, unchanged)",
    near(lt.far, 182.4) && near(lt.near, 18.24), JSON.stringify(lt));
  check("degenerate horizon band keeps a real ramp (near < far)", ht.near < ht.far && near(ht.far, 182.4), JSON.stringify(ht));
}
{
  // Floor: R = 3 => edge max(0.95 x 672, min(700, 672)) = 672.
  const f = computeFogBand({ ...DEFAULTS, authoredMin: 85, authoredMax: 2400, rEffLb: 3, horizon: true });
  check("farFogFloor still applies (R = 3 -> far = drawn edge 672)", near(f.far, 672), JSON.stringify(f));
  // Clamp disabled / no radius => authored band verbatim, in BOTH modes.
  for (const horizon of [false, true]) {
    const off = computeFogBand({ ...DEFAULTS, frac: 0, authoredMin: 85, authoredMax: 796, rEffLb: 5, horizon });
    const nan = computeFogBand({ ...DEFAULTS, authoredMin: 85, authoredMax: 796, rEffLb: NaN, horizon });
    check(`farFogFrac=0 / no radius -> authored verbatim (horizon=${horizon})`,
      off.near === 85 && off.far === 796 && off.mode === "authored" &&
      nan.near === 85 && nan.far === 796 && nan.mode === "authored");
  }
  // A silly pin (farFogFrac 0.3 under horizonFogNear 0.9) still yields a ramp.
  const pin = computeFogBand({ ...DEFAULTS, frac: 0.3, horizonNear: 0.9, authoredMin: 85, authoredMax: 796, rEffLb: 5, horizon: true });
  check("pinned frac below the start still gives near < far", pin.near < pin.far, JSON.stringify(pin));
}

// ---------------------------------------------------------------------------
console.log("-- F2 invariants over a grid -----------------------------------------");
{
  let edgeViolations = 0;
  let moreFog = 0;
  let worst = "";
  for (const rEffLb of [3, 3.5, 4, 5, 6, 8]) {
    for (const authoredMin of [0, 50, 85, 150, 300, 600, 900, 1100]) {
      for (const authoredMax of [300, 400, 796, 1200, 2400]) {
        if (!(authoredMax > authoredMin)) continue;
        const base = { ...DEFAULTS, authoredMin, authoredMax, rEffLb };
        const lg = computeFogBand({ ...base, horizon: false });
        const hz = computeFogBand({ ...base, horizon: true });
        if (hz.far > hz.drawnEdgeM + 1e-9 || lg.far > lg.drawnEdgeM + 1e-9) edgeViolations++;
        for (let d = 0; d <= 1600; d += 10) {
          const a = fogFactor(hz, d);
          const b = fogFactor(lg, d);
          if (a > b + 1e-9) { moreFog++; worst = `R${rEffLb} ${authoredMin}->${authoredMax} d${d}: ${a} > ${b}`; }
        }
      }
    }
  }
  check("fog-before-edge: far <= drawn edge in every mode", edgeViolations === 0, String(edgeViolations));
  check("horizon band never fogs more than the legacy band at any distance", moreFog === 0, worst);
}

// ---------------------------------------------------------------------------
console.log("-- F3 flag readers --------------------------------------------------");
check("horizonFog is default ON (param absent)", withSearch("", () => horizonFogEnabled()) === true);
check("?horizonFog=off disables", withSearch("?horizonFog=off", () => horizonFogEnabled()) === false);
check("?farTerrain=off (wave master) disables", withSearch("?farTerrain=off", () => horizonFogEnabled()) === false);
check("?horizonFog=on stays on", withSearch("?horizonFog=on", () => horizonFogEnabled()) === true);
check("horizonFogNear default 0.45", withSearch("", () => horizonFogNearFrac()) === 0.45);
check("?horizonFogNear=0.6 reads 0.6", withSearch("?horizonFogNear=0.6", () => horizonFogNearFrac()) === 0.6);
check("?horizonFogNear=5 clamps to 0.9", withSearch("?horizonFogNear=5", () => horizonFogNearFrac()) === 0.9);

// ---------------------------------------------------------------------------
console.log("-- F4 aerialBlendOpacity --------------------------------------------");
{
  const { aerialBlendOpacity, cloudsFullOpacityEnabled, AERIAL_OPACITY_AC_FOG } =
    await import("./scene3d/atmosphere_pipeline.js");
  check("legacy knock constant is 0.6", AERIAL_OPACITY_AC_FOG === 0.6);
  check("clouds in the main pass -> 1.0 (clouds no longer drawn at 60 %)", aerialBlendOpacity(true, "") === 1);
  check("no main-pass clouds -> 0.6 (terrain double-fog knob unchanged)", aerialBlendOpacity(false, "") === 0.6);
  check("?cloudsFullOpacity=off -> 0.6 with clouds", aerialBlendOpacity(true, "?cloudsFullOpacity=off") === 0.6);
  check("cloudsFullOpacity default ON", cloudsFullOpacityEnabled("") === true);
  check("?aerialOpacity=0.3 pins", aerialBlendOpacity(true, "?aerialOpacity=0.3") === 0.3);
  check("?aerialOpacity=2 clamps to 1", aerialBlendOpacity(false, "?aerialOpacity=2") === 1);
  check("?aerialOpacity=junk ignored", aerialBlendOpacity(true, "?aerialOpacity=abc") === 1);
}

// ---------------------------------------------------------------------------
console.log("-- F5 source wiring -------------------------------------------------");
{
  const LOOP = readFileSync(path.join(HERE, "scene3d", "loop.js"), "utf8");
  const IDX = readFileSync(path.join(HERE, "scene3d", "index.js"), "utf8");
  const DOC = readFileSync(path.join(HERE, "docs", "url-flags.md"), "utf8");
  const GLSL = readFileSync(path.join(HERE, "scene3d", "terrain_shared_glsl.js"), "utf8");
  check("loop.js imports computeFogBand + the horizon readers",
    /horizonFogEnabled, horizonFogNearFrac, computeFogBand,\s*\} from "\.\/far_terrain_flags\.js"/.test(LOOP));
  check("loop.js gates the horizon band on the sky being visible",
    /const horizon = horizonFogEnabled\(\) && !skyBlocked;/.test(LOOP) &&
    /_lastSkyBlocked \?\? skyDome\?\._lastIsIndoor/.test(LOOP));
  check("loop.js applies computeFogBand's near/far before the A/B pins",
    /const band = computeFogBand\(\{[\s\S]{0,400}\}\);\s*near = band\.near;\s*far = band\.far;\s*const nearPin = farFogNearPin\(\);/.test(LOOP));
  check("loop.js still publishes the AUTHORED fogMax for fogRingCap (no feedback loop)",
    /scene3d\._authoredFogMaxM = fogMax;/.test(LOOP));
  check("loop.js no longer carries a second inline copy of the clamp",
    !/let edge = frac \* drawnEdge;/.test(LOOP));
  check("probe surface reports the mode",
    /mode: band\.mode,/.test(LOOP));
  check("terrain fog is still three's smoothstep (the curve F1/F2 model)",
    /smoothstep\( fogNear, fogFar, viewDepth \)/.test(GLSL));
  check("index.js derives the AP opacity from the adopted main pass",
    /aerialBlendOpacity\(!!atmospherePipeline\?\.cloudsMainPass\)/.test(IDX) &&
    /\{ createAtmospherePipeline, aerialBlendOpacity \}/.test(IDX));
  check("url-flags.md documents horizonFog / horizonFogNear / cloudsFullOpacity",
    /^\| `horizonFog` \|/m.test(DOC) && /^\| `horizonFogNear` \|/m.test(DOC) && /^\| `cloudsFullOpacity` \|/m.test(DOC));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
