// tests/cloud_night_lighting.test.mjs — ?cloudNight (2026-10-07, DEFAULT ON).
//
// Owner, 1070 playtest: at night the takram clouds glowed deep sunset
// orange-red under a night-dark sky ("yes clouds realistic at night"). Root
// cause: cloud_volume.js lit the cloud raymarch with the RAW DayGroup pitch
// (never below 0.9 deg), while the sky raymarches the night-ramped art pitch
// (-14 deg) from the same Bruneton LUTs. Fix: scene3d/cloud_night.js.
//
//   N1  the mapping at representative Dereth times (noon, golden hour, sunset,
//       dusk, night, dawn, sunrise golden) on the VERBATIM Region 0x13000000
//       DayGroup[0] keyframes (same table as test_retail_sun.mjs):
//       elevation, direct-sun factor, night factor, and the Bruneton horizon
//       term (JS mirror) at the cloud base/top — i.e. "no direct sun on any
//       cloud layer at night", "warm direct light kept at golden hour".
//   N2  whole-day sweep: cloud elevation == the sky's artSunPitchDeg at every
//       sample (no seam), factors bounded + monotone in the authored pitch.
//   N3  REAL CloudVolume (vendored takram build) + REAL AtmosphereSky ticked
//       with the same states: effect.sunDirection === skyMaterial.sunDirection
//       (no seam, end to end); night direction is below the horizon.
//   N4  uniform side on the real effect: maxShadowLengthRayDistance fades to 0
//       and restores; a preset write is re-captured as the new base;
//       skyLightScale lift only at night.
//   N5  terrain cloud-shadow push: strength x directFactor, OFF once set,
//       override respected.
//   N6  flag reader + tunables; source audits (no define flip, raw pitch gone).
//   N7  NIGHT FLOOR (1070 follow-up: night clouds rendered pure black): the
//       real irradiance LUT proves the physical -14 deg cloud light is
//       display-black at exposure 5 + AgX; with the floor a night cloud
//       displays Dereth's night colour 0x171725 (>0, never black), slightly
//       darker than the 1070's night-sky blue; zero floor by day/golden hour;
//       shader patched once; exposure-aware.
//
// Fails on the pre-change code: cloud_night.js does not exist, and the old
// tick() pointed effect.sunDirection 0.9 deg ABOVE the horizon all night.
//
// Run: node tests/cloud_night_lighting.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const VENDOR_CLOUDS = pathToFileURL(
  path.join(APP, "vendor", "takram-three-clouds", "build", "index.js"),
).href;

// index.html's import map sends @takram/three-clouds to the vendored build;
// node has no import map, so mirror that one entry (as clouds_main_pass does).
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
        if (spec === "@takram/three-clouds") return { url: ${JSON.stringify(VENDOR_CLOUDS)}, shortCircuit: true };
        return next(spec, ctx);
      }`,
    ),
);

const THREE = await import("three");
const CN = await import("../scene3d/cloud_night.js");
const { artSunPitchDeg } = await import("../scene3d/night_ramp.js");
const { sunDirFromHeadingPitch } = await import("../scene3d/sun_direction.js");
const { CloudVolume } = await import("../scene3d/cloud_volume.js");
const { AtmosphereSky } = await import("../scene3d/atmosphere_sky.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

// --- Region 0x13000000 skyInfo.dayGroups[0].skyTime[] (verbatim; see
// test_retail_sun.mjs) + acclient.c:301424 DayGroup::GetTimeOfDay lerp. -----
const SKY_TIME = [
  { begin: 0, dirHeading: 90, dirPitch: 0.9 },
  { begin: 0.02, dirHeading: 90, dirPitch: 0.9 },
  { begin: 0.16, dirHeading: 90, dirPitch: 0.9 },
  { begin: 0.21, dirHeading: 90, dirPitch: 10 },
  { begin: 0.27, dirHeading: 90, dirPitch: 20 },
  { begin: 0.61, dirHeading: 90, dirPitch: 90 },
  { begin: 0.611, dirHeading: 270, dirPitch: 90 },
  { begin: 0.84, dirHeading: 270, dirPitch: 20 },
  { begin: 0.9, dirHeading: 270, dirPitch: 10 },
  { begin: 0.96, dirHeading: 270, dirPitch: 0.9 },
  { begin: 0.999, dirHeading: 270, dirPitch: 0.9 },
];
function skyStateAt(t) {
  const n = SKY_TIME.length;
  let i = 0;
  for (let k = 1; k < n && SKY_TIME[k].begin <= t; k += 1) i += 1;
  const a = SKY_TIME[i];
  const b = i === n - 1 ? SKY_TIME[0] : SKY_TIME[i + 1];
  const r = i === n - 1 ? (t - a.begin) / (1 - a.begin) : (t - a.begin) / (b.begin - a.begin);
  // Heading flips at 0.611 (keyframe step); pitch is the retail linear lerp.
  return { dirHeading: a.dirHeading, dirPitch: (b.dirPitch - a.dirPitch) * r + a.dirPitch };
}
const hhmm = (t) => {
  const m = Math.round(t * 24 * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
console.log("-- N1 representative times (default tunables) ----------------------");
const BASE = CN.CLOUD_BASE_ALTITUDE_M;
const TOP = CN.CLOUD_TOP_ALTITUDE_M;
const rows = [
  ["noon", 0.611], ["afternoon", 0.75], ["golden hour", 0.88], ["sunset", 0.908],
  ["dusk", 0.93], ["night", 0.0], ["deep night", 0.08], ["pre-dawn", 0.16],
  ["dawn", 0.205], ["sunrise golden", 0.24],
];
const R = {};
for (const [name, t] of rows) {
  const st = skyStateAt(t);
  const cn = CN.cloudNightLighting(st, {}, true, "");
  const visBase = CN.sunHorizonVisibility(cn.pitchDeg, BASE);
  const visTop = CN.sunHorizonVisibility(cn.pitchDeg, TOP);
  R[name] = { ...cn, visBase, visTop, t };
  console.log(`     ${name.padEnd(15)} t=${t.toFixed(3)} (${hhmm(t)}) authored=${f3(st.dirPitch).padStart(7)}`
    + ` cloud=${f3(cn.pitchDeg).padStart(7)} direct=${f3(cn.directFactor)} night=${f3(cn.nightFactor)}`
    + ` skyLightMul=${f3(cn.skyLightMul)} sunVis@${BASE}m=${f3(visBase)} @${TOP}m=${f3(visTop)}`);
}

check("noon: elevation untouched (90 deg), full direct light + shadows",
  Math.abs(R.noon.pitchDeg - 90) < 1e-9 && R.noon.directFactor === 1 && R.noon.nightFactor === 0 && R.noon.visBase === 1);
check("afternoon (above the 20 deg knee): identity",
  Math.abs(R.afternoon.pitchDeg - R.afternoon.authoredPitchDeg) < 1e-9 && R.afternoon.directFactor === 1);
check("golden hour 21:07: low warm sun KEPT (4..12 deg, direct sun reaches every layer, shadows full)",
  R["golden hour"].pitchDeg > 4 && R["golden hour"].pitchDeg < 12 &&
  R["golden hour"].visBase === 1 && R["golden hour"].visTop === 1 && R["golden hour"].directFactor === 1,
  `pitch=${f3(R["golden hour"].pitchDeg)}`);
check("golden hour: the clouds see the SKY's lower sun, not the raw retail one",
  R["golden hour"].pitchDeg < R["golden hour"].authoredPitchDeg);
check("sunset 21:48: sun on the horizon (|elev| < 1 deg)", Math.abs(R.sunset.pitchDeg) < 1,
  `pitch=${f3(R.sunset.pitchDeg)}`);
check("sunset: high cloud still catches direct light (after-glow) while shadows are ~gone",
  R.sunset.visTop === 1 && R.sunset.directFactor < 0.2, `visTop=${f3(R.sunset.visTop)} direct=${f3(R.sunset.directFactor)}`);
check("dusk 22:19: sun below every cloud layer's horizon — zero direct light",
  R.dusk.pitchDeg < -3 && R.dusk.visBase === 0 && R.dusk.visTop === 0 && R.dusk.directFactor === 0);
for (const k of ["night", "deep night", "pre-dawn"]) {
  check(`${k}: elevation = the sky's -14 deg, zero direct sun at 750 m AND 8 km, no shadows/shafts, full night`,
    Math.abs(R[k].pitchDeg - (-14)) < 1e-9 && R[k].visBase === 0 && R[k].visTop === 0 &&
    R[k].directFactor === 0 && R[k].nightFactor === 1);
}
check("night: default sky-light multiplier is physical (1.0 — same LUT irradiance as the sky)",
  R.night.skyLightMul === 1);
check("dawn 04:55: sun just risen (0..2 deg), direct light on, shadows only starting",
  R.dawn.pitchDeg > 0 && R.dawn.pitchDeg < 2 && R.dawn.visBase === 1 && R.dawn.directFactor > 0 && R.dawn.directFactor < 0.25,
  `pitch=${f3(R.dawn.pitchDeg)} direct=${f3(R.dawn.directFactor)}`);
check("sunrise golden 05:46: warm low sun, shadows full",
  R["sunrise golden"].pitchDeg > 6 && R["sunrise golden"].pitchDeg < 15 && R["sunrise golden"].directFactor === 1);

// The bug, documented: on the raw retail pitch the direct term is ON all night.
check("pre-fix control: raw 0.9 deg pitch leaves the sun fully visible to the cloud base all night",
  CN.sunHorizonVisibility(0.9, BASE) === 1 && CN.cloudNightLighting(skyStateAt(0.0), {}, false).pitchDeg === 0.9);
const off = CN.cloudNightLighting(skyStateAt(0.0), {}, false);
check("?cloudNight=off → legacy identity (raw pitch, factors 1/0/1, enabled false)",
  off.enabled === false && off.pitchDeg === 0.9 && off.directFactor === 1 && off.nightFactor === 0 && off.skyLightMul === 1);

// ---------------------------------------------------------------------------
console.log("\n-- N2 whole-day sweep (96 samples) --------------------------------");
let seamMax = 0;
let bounded = true;
const samples = [];
for (let i = 0; i < 96; i += 1) {
  const st = skyStateAt(i / 96);
  const cn = CN.cloudNightLighting(st, {}, true, "");
  seamMax = Math.max(seamMax, Math.abs(cn.pitchDeg - artSunPitchDeg(st.dirPitch)));
  bounded = bounded && cn.directFactor >= 0 && cn.directFactor <= 1 && cn.nightFactor >= 0 && cn.nightFactor <= 1;
  samples.push({ a: st.dirPitch, ...cn });
}
check("cloud elevation === sky artSunPitchDeg at every sample (no seam)", seamMax === 0, `max=${seamMax}`);
check("factors bounded in [0,1]", bounded);
samples.sort((x, y) => x.a - y.a);
let mono = true;
for (let i = 1; i < samples.length; i += 1) {
  const p = samples[i - 1], c = samples[i];
  if (c.pitchDeg < p.pitchDeg - 1e-12 || c.directFactor < p.directFactor - 1e-12 || c.nightFactor > p.nightFactor + 1e-12) mono = false;
}
check("elevation + direct factor non-decreasing, night factor non-increasing in the authored pitch", mono);

// ---------------------------------------------------------------------------
console.log("\n-- N3 real CloudVolume + real AtmosphereSky, same states ----------");
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4000);
const vol = new CloudVolume({ camera });
const sky = new AtmosphereSky({
  skyScene: new THREE.Scene(),
  atmosphereRuntime: { textures: {} },
  includeStars: false,
});
let dirSeam = 0;
let nightBelow = true;
for (let i = 0; i < 96; i += 1) {
  const st = skyStateAt(i / 96);
  sky.tick(st);
  vol.tick(st);
  dirSeam = Math.max(dirSeam, vol.effect.sunDirection.distanceTo(sky.skyMaterial.sunDirection));
  if (st.dirPitch <= 0.9 + 1e-9 && !(vol.effect.sunDirection.y < 0)) nightBelow = false;
}
check("effect.sunDirection === skyMaterial.sunDirection all day (end-to-end seam 0)", dirSeam < 1e-12, `max=${dirSeam}`);
check("night (authored 0.9 deg): cloud sun is BELOW the horizon (y < 0)", nightBelow);
{
  const st = skyStateAt(0.611);
  vol.tick(st);
  const want = sunDirFromHeadingPitch(st.dirHeading, st.dirPitch, new THREE.Vector3());
  check("noon: cloud sun direction is the plain retail direction",
    vol.effect.sunDirection.distanceTo(want) < 1e-12);
  check("the material's sunDirection uniform mirrors the effect",
    vol.material.uniforms.sunDirection.value.distanceTo(vol.effect.sunDirection) < 1e-12);
}

// ---------------------------------------------------------------------------
console.log("\n-- N4 uniform side on the real effect --------------------------------");
const U = vol.material.uniforms;
vol.tick(skyStateAt(0.611));
const shaftBase = U.maxShadowLengthRayDistance.value;
check("noon: light-shaft distance at takram's base (2e5)", shaftBase === 2e5, `got ${shaftBase}`);
check("noon: skyLightScale untouched (1)", U.skyLightScale.value === 1);
vol.tick(skyStateAt(0.0));
check("night: light-shaft march distance 0 (shafts off, no define flip)", U.maxShadowLengthRayDistance.value === 0);
check("night: skyLightScale x1 (physical default)", U.skyLightScale.value === 1);
check("night: lightShafts define untouched", vol.effect.lightShafts === true);
vol.tick(skyStateAt(0.905));
const midShaft = U.maxShadowLengthRayDistance.value;
check("near sunset: light-shaft distance partially faded (0 < d < base)", midShaft > 0 && midShaft < shaftBase, `got ${midShaft}`);
vol.tick(skyStateAt(0.611));
check("back at noon: base restored exactly", U.maxShadowLengthRayDistance.value === shaftBase);
U.maxShadowLengthRayDistance.value = 1e5; // a quality-preset / devtools write
vol.tick(skyStateAt(0.611));
check("an external write is re-captured as the new base", U.maxShadowLengthRayDistance.value === 1e5);
vol.tick(skyStateAt(0.0));
vol.tick(skyStateAt(0.611));
check("…and survives a night round-trip", U.maxShadowLengthRayDistance.value === 1e5);
U.maxShadowLengthRayDistance.value = 2e5;
vol.tick(skyStateAt(0.611));
const lift = CN.cloudNightLighting(skyStateAt(0.0), {}, true, "?cloudNightSkyLight=3");
const liftNoon = CN.cloudNightLighting(skyStateAt(0.611), {}, true, "?cloudNightSkyLight=3");
check("?cloudNightSkyLight=3 lifts the sky-light fill x3 at night only",
  lift.skyLightMul === 3 && liftNoon.skyLightMul === 1);

// ---------------------------------------------------------------------------
console.log("\n-- N5 terrain cloud-shadow push ------------------------------------");
const mat = {
  uniforms: {
    uCloudShadowEnabled: { value: 0 },
    uCloudShadowMap: { value: null },
    uCloudShadowMatrix0: { value: new THREE.Matrix4() },
    uCloudShadowStrength: { value: 2.0 },
  },
};
globalThis.window = { liveScene3d: { terrainMaterials: [mat] } };
vol.effect.cloudsPass.shadowBuffer = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
vol.tick(skyStateAt(0.611));
vol._pushCloudShadowsToTerrain();
check("noon: cloud shadows ON at the default strength 2.0",
  mat.uniforms.uCloudShadowEnabled.value === 1 && mat.uniforms.uCloudShadowStrength.value === 2.0);
vol.tick(skyStateAt(0.905));
vol._pushCloudShadowsToTerrain();
const sDusk = mat.uniforms.uCloudShadowStrength.value;
check("near sunset: strength faded with the direct sun (0 < s < 2)",
  mat.uniforms.uCloudShadowEnabled.value === 1 && sDusk > 0 && sDusk < 2, `got ${sDusk}`);
vol.tick(skyStateAt(0.0));
vol._pushCloudShadowsToTerrain();
check("night: terrain cloud shadows OFF (sun has set; the map looks up from below)",
  mat.uniforms.uCloudShadowEnabled.value === 0);
globalThis.window.liveScene3d.__cloudShadowStrength = 3;
vol.tick(skyStateAt(0.611));
vol._pushCloudShadowsToTerrain();
check("noon with ?cloudShadowStrength=3: override respected and shadows back on",
  mat.uniforms.uCloudShadowEnabled.value === 1 && mat.uniforms.uCloudShadowStrength.value === 3);
globalThis.window.liveScene3d.__cloudShadowDisabled = true;
vol._pushCloudShadowsToTerrain();
check("?cloudShadow=off still wins by day", mat.uniforms.uCloudShadowEnabled.value === 0);
globalThis.window.liveScene3d.__cloudShadowDisabled = false;
delete globalThis.window.liveScene3d.__cloudShadowStrength;

// The live read the orchestrator uses (window.__cloudNightState).
{
  const ls = globalThis.window.liveScene3d;
  ls.cloudOverlay = { volume: vol };
  ls.atmosphereSky = sky;
  const nightSt = skyStateAt(0.0);
  ls.skyLightingController = { _lastState: nightSt };
  sky.tick(nightSt);
  vol.tick(nightSt);
  vol._pushCloudShadowsToTerrain();
  CN.installCloudNightDiag();
  const d = globalThis.window.__cloudNightState();
  console.log("     __cloudNightState() @night:", JSON.stringify(d));
  check("__cloudNightState: night reads seam 0, sun -14 deg, no direct sun on any layer, shadows/shafts off",
    !d.error && d.seamDeg === 0 && d.cloudPitchDeg === -14 && d.skyArtPitchDeg === -14 &&
    d.sunVisibleCloudBase === 0 && d.sunVisibleCloudTop === 0 && d.directFactor === 0 &&
    d.maxShadowLengthRayDistance === 0 && d.terrainCloudShadow.enabled === 0 && d.cloudSunDir[1] < 0);
  check("__cloudNightState: night floor installed, weight 1, a cloud DISPLAYS the night colour (23,23,37)",
    d.nightAmbientPatched === true && d.ambientWeight === 1 && d.nightColor === "#171725" &&
    d.displayExposure === 5 && JSON.stringify(d.nightCloudDisplay) === "[23,23,37]");
  const noonSt = skyStateAt(0.611);
  ls.skyLightingController._lastState = noonSt;
  sky.tick(noonSt);
  vol.tick(noonSt);
  const n = globalThis.window.__cloudNightState();
  check("__cloudNightState: noon reads seam 0, elevation 90, full direct light, shafts at base",
    n.seamDeg === 0 && Math.abs(n.cloudPitchDeg - 90) < 1e-9 && n.directFactor === 1 &&
    n.sunVisibleCloudBase === 1 && n.maxShadowLengthRayDistance === 2e5);
  check("__cloudNightState: noon floor is exactly zero (day look untouched)",
    n.ambientWeight === 0 && JSON.stringify(n.nightAmbient) === "[0,0,0]");
}
delete globalThis.window;


// ---------------------------------------------------------------------------
console.log("\n-- N7 night floor: night clouds are never black -------------------");
// (a) WHY: the physical night is display-black. Real irradiance LUT
// (scene3d/assets/atmosphere/irradiance.exr, what takram samples) → the
// clouds' sky-light source (GetSunAndSkyScalarIrradiance: E·2π, then ·1/4π ·
// skyGradient) → exposure 5 → AgX. Relative-luminance conversion constants
// are takram's AtmosphereParameters.DEFAULT (skyRadianceToLuminance /
// dot(sunRadianceToLuminance, Rec.709 Y)).
{
  const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
  const L = new EXRLoader();
  L.setDataType(THREE.FloatType);
  const b = readFileSync(path.join(APP, "scene3d", "assets", "atmosphere", "irradiance.exr"));
  const IRR = L.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const t2 = 98242.786222 * 0.2126 + 69954.398112 * 0.7152 + 66475.012354 * 0.0722;
  const SKY2REL = [114974.916437 / t2, 71305.954816 / t2, 65310.548555 / t2];
  const coord = (x, n) => 0.5 / n + x * (1 - 1 / n);
  const irr = (rKm, muS) => { // bilinear, 64x16, Bruneton GetIrradianceTextureUvFromRMuS
    const u = coord(muS * 0.5 + 0.5, 64) * 64 - 0.5, v = coord((rKm - 6360) / 60, 16) * 16 - 0.5;
    const x0 = Math.max(0, Math.min(63, Math.floor(u))), x1 = Math.min(63, x0 + 1), fx = Math.min(1, Math.max(0, u - x0));
    const y0 = Math.max(0, Math.min(15, Math.floor(v))), y1 = Math.min(15, y0 + 1), fy = Math.min(1, Math.max(0, v - y0));
    const at = (x, y, c) => IRR.data[(y * 64 + x) * 4 + c];
    return [0, 1, 2].map((c) => ((at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx) * (1 - fy) +
      (at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx) * fy) * SKY2REL[c]);
  };
  const cloudSkySrc = (pitch) => irr(6361.5, Math.sin(pitch * Math.PI / 180)).map((e) => e * 2 * Math.PI / (4 * Math.PI) * CN.CLOUD_NIGHT_GRADIENT_REF);
  const to8 = (d) => d.map((x) => Math.round(x * 255));
  const dayDisp = to8(CN.agxDisplay(cloudSkySrc(45), 5));
  const nightPhys = cloudSkySrc(-14);
  const nightDisp = to8(CN.agxDisplay(nightPhys, 5));
  console.log(`     physical cloud sky-light: 45 deg → display ${dayDisp}; -14 deg → radiance ${nightPhys.map((x) => x.toExponential(2))} → display ${nightDisp}`);
  check("sanity: the physical daytime sky-light is clearly visible through exposure 5 + AgX", Math.max(...dayDisp) > 60);
  check("WHY: the physical -14 deg cloud light is display-BLACK (the 1070 blotches)", Math.max(...nightDisp) === 0);
  const floor = CN.cloudNightAmbientRadiance(CN.CLOUD_NIGHT_COLOR_DEFAULT, 1, 5);
  const withFloor = to8(CN.agxDisplay([0, 1, 2].map((i) => nightPhys[i] + floor[i] * CN.CLOUD_NIGHT_GRADIENT_REF), 5));
  check("FIX: physical + floor displays the night colour 0x171725 = (23,23,37) (±1)",
    Math.abs(withFloor[0] - 23) <= 1 && Math.abs(withFloor[1] - 23) <= 1 && Math.abs(withFloor[2] - 37) <= 1, `got ${withFloor}`);
}

// (b) the display transform port: forward/inverse round trip.
{
  const cols = [[23, 23, 37], [40, 48, 70], [14, 14, 25], [120, 90, 60], [200, 200, 210]];
  let worst = 0;
  for (const c of cols) {
    for (const ex of [2, 5, 10]) {
      const r = CN.sceneRadianceForDisplay(c.map((x) => x / 255), ex);
      const back = CN.agxDisplay(r, ex).map((x) => x * 255);
      worst = Math.max(worst, ...back.map((v, i) => Math.abs(v - c[i])));
    }
  }
  check("agxDisplay ∘ sceneRadianceForDisplay round-trips within 0.5/255 (exposure 2/5/10)", worst < 0.5, `worst ${worst}`);
}

// (c) weight: zero while the sun is up, full by -6 deg.
check("floor weight 0 at noon / golden hour / sunset (day + golden look untouched)",
  [0.611, 0.75, 0.88, 0.908].every((t) => CN.cloudNightLighting(skyStateAt(t), {}, true, "").ambientWeight === 0));
const wDusk = CN.cloudNightLighting({ dirPitch: 0.9 + (11 / 34) * 19.1 }, {}, true, "").ambientWeight; // art -3 deg
check("floor weight ramps in through civil twilight (art -3 deg ≈ 0.5)", wDusk > 0.3 && wDusk < 0.7, `w=${wDusk}`);
check("floor weight 1 for the whole night block and at -6 deg",
  [0.0, 0.08, 0.16].every((t) => CN.cloudNightLighting(skyStateAt(t), {}, true, "").ambientWeight === 1) &&
  CN.cloudNightAmbientWeight(-6) === 1);
check("flag off → floor weight 0", CN.cloudNightLighting(skyStateAt(0.0), {}, false).ambientWeight === 0);

// (d) the real CloudVolume: shader patched once, uniform driven by the weight.
{
  const fs = vol.material.fragmentShader;
  const count = (str, sub) => str.split(sub).length - 1;
  check("shader patched: one uniform decl + one in-scatter line, right after takram's sky-light term",
    vol._nightAmbientPatched === true &&
    count(fs, "uniform vec3 cloudNightAmbient;") === 1 &&
    count(fs, "radiance += skyIrradiance * RECIPROCAL_PI4 * skyGradient * skyLightScale;\n      radiance += cloudNightAmbient * skyGradient;") === 1 &&
    !/`/.test(fs.slice(fs.indexOf("cloudNightAmbient") - 200, fs.indexOf("cloudNightAmbient") + 200)));
  const U = vol.material.uniforms;
  check("uniform registered on the clouds material", U.cloudNightAmbient?.value?.isVector3 === true);
  vol.tick(skyStateAt(0.611));
  const noon = U.cloudNightAmbient.value.toArray();
  vol.tick(skyStateAt(0.88));
  const golden = U.cloudNightAmbient.value.toArray();
  vol.tick(skyStateAt(0.0));
  const night = U.cloudNightAmbient.value.toArray();
  console.log(`     cloudNightAmbient: noon ${noon} golden ${golden} night ${night.map((x) => x.toExponential(3))}`);
  check("noon + golden hour: floor uniform exactly (0,0,0)", noon.every((x) => x === 0) && golden.every((x) => x === 0));
  check("night: floor > 0 in every channel, blue-dominant (grey-blue)", night.every((x) => x > 0) && night[2] > night[0] && night[2] > night[1]);
  const to8 = (d) => d.map((x) => Math.round(x * 255));
  const base = to8(CN.agxDisplay(night.map((x) => x * 0.5), 5));
  const ref = to8(CN.agxDisplay(night.map((x) => x * CN.CLOUD_NIGHT_GRADIENT_REF), 5));
  const top = to8(CN.agxDisplay(night, 5));
  console.log(`     night cloud on screen: base ${base}  mid ${ref}  top ${top}  (night colour 23,23,37)`);
  check("night cloud at the calibration gradient displays the night colour (23,23,37)", JSON.stringify(ref) === "[23,23,37]");
  check("night cloud bases (skyGradient 0.5) are darker but NEVER black (every channel >= 10)",
    base.every((c) => c >= 10) && base[2] < ref[2]);
  // The darkest night-sky sample on the 1070 capture (night-preview-2.png,
  // (650,150)) was (0,29,85): the calibrated cloud must sit a touch darker.
  const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  check("thick night cloud reads slightly darker than the 1070's night-sky blue (0,29,85)",
    Y(ref) < Y([0, 29, 85]) && Y(ref) > 0.5 * Y([0, 29, 85]), `Y ${Y(ref).toFixed(1)} vs ${Y([0, 29, 85]).toFixed(1)}`);
  vol.setDisplayExposure(2);
  vol.tick(skyStateAt(0.0));
  const at2 = U.cloudNightAmbient.value.toArray();
  check("exposure change re-solves the floor so the on-screen colour holds",
    at2[2] > night[2] * 2 && JSON.stringify(to8(CN.agxDisplay(at2.map((x) => x * CN.CLOUD_NIGHT_GRADIENT_REF), 2))) === "[23,23,37]");
  vol.setDisplayExposure(5);
  vol.tick(skyStateAt(0.0));
}

// (e) tunables.
check("?cloudNightColor parses RRGGBB / #RRGGBB / 0xRRGGBB, junk → 171725",
  CN.cloudNightColor("?cloudNightColor=203040") === 0x203040 &&
  CN.cloudNightColor("?cloudNightColor=%23203040") === 0x203040 &&
  CN.cloudNightColor("?cloudNightColor=0x203040") === 0x203040 &&
  CN.cloudNightColor("?cloudNightColor=zz") === 0x171725 && CN.cloudNightColor("") === 0x171725);
check("?cloudNightLevel default 1, clamp [0,8]; 0 = pure physical (black) night",
  CN.cloudNightLevel("") === 1 && CN.cloudNightLevel("?cloudNightLevel=99") === 8 &&
  CN.cloudNightAmbientRadiance(0x171725, 0, 5).every((x) => x === 0));
check("cloud_overlay.preRender hands the live exposure to the volume",
  /preRender\(renderer, dt = 0, activeCam = null\) \{\s*if \(!renderer\) return;[\s\S]{0,400}this\.volume\?\.setDisplayExposure\?\.\(renderer\.toneMappingExposure\);/
    .test(readFileSync(path.join(APP, "scene3d", "cloud_overlay.js"), "utf8")));

// ---------------------------------------------------------------------------
console.log("\n-- N6 flag reader, tunables, source audits --------------------------");
check("default ON (absent / empty)", CN.cloudNightEnabled("") === true && CN.cloudNightEnabled("?x=1") === true);
check("=off / =0 / =false escape", ["off", "0", "false", "OFF"].every((v) => CN.cloudNightEnabled(`?cloudNight=${v}`) === false));
check("=on stays on", CN.cloudNightEnabled("?cloudNight=on") === true);
check("cloudShadowFadeDeg default 6, clamped [0.5,45]",
  CN.cloudShadowFadeDeg("") === 6 && CN.cloudShadowFadeDeg("?cloudShadowFadeDeg=100") === 45 &&
  CN.cloudShadowFadeDeg("?cloudShadowFadeDeg=0") === 0.5 && CN.cloudShadowFadeDeg("?cloudShadowFadeDeg=10") === 10);
check("cloudNightSkyLight default 1, clamped [0,20]",
  CN.cloudNightSkyLight("") === 1 && CN.cloudNightSkyLight("?cloudNightSkyLight=50") === 20);
check("?cloudShadowFadeDeg=12 widens the fade band",
  CN.cloudNightLighting({ dirPitch: 13.3 }, {}, true, "?cloudShadowFadeDeg=12").directFactor < 1 &&
  CN.cloudNightLighting({ dirPitch: 13.3 }, {}, true, "").directFactor === 1);
check("sunHorizonVisibility is a smooth 0→1 across the disc at the horizon",
  CN.sunHorizonVisibility(0, 0) > 0.4 && CN.sunHorizonVisibility(0, 0) < 0.6 &&
  CN.sunHorizonVisibility(-1, 0) === 0 && CN.sunHorizonVisibility(1, 0) === 1);

const VOL_SRC = readFileSync(path.join(APP, "scene3d", "cloud_volume.js"), "utf8");
const NIGHT_SRC = readFileSync(path.join(APP, "scene3d", "cloud_night.js"), "utf8");
// Code only (the rationale comments legitimately NAME the forbidden write).
const codeOnly = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
check("cloud_volume tick lights the clouds with cn.pitchDeg, not the raw state.dirPitch",
  /sunDirFromHeadingPitch\(\s*state\.dirHeading,\s*cn\.pitchDeg,/.test(VOL_SRC) &&
  !/sunDirFromHeadingPitch\(\s*state\.dirHeading,\s*state\.dirPitch/.test(VOL_SRC));
check("uniform scaling is gated on cn.enabled (flag off = untouched)",
  /if \(cn\.enabled\) \{\s*this\._scaleCloudUniform\(u, 'skyLightScale'/.test(VOL_SRC));
check("no runtime lightShafts toggle (SHADOW_LENGTH define flip = relink freeze)",
  !/\.lightShafts\s*=[^=]/.test(codeOnly(VOL_SRC)) && !/\.lightShafts\s*=[^=]/.test(codeOnly(NIGHT_SRC)));
check("reader uses the off|0|false idiom", /on = !\(t === "off" \|\| t === "0" \|\| t === "false"\)/.test(NIGHT_SRC));

console.log(`\ncloud night lighting: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
