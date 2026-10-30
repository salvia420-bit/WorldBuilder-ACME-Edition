// tests/hot_terrain_push.test.mjs — lane F hot spots (2026-10-26): the two
// per-terrain-material uniform pushes, flag off vs on, frame by frame.
//
//   ?hotCloudPush    scene3d/cloud_volume.js  CloudVolume#_pushCloudShadowsToTerrain
//   ?hotTerrainTime  scene3d/loop.js          tickTerrainUTime
//
// CLAIM: with the flag on, every terrain material's uniforms hold exactly the
// values (Object.is per number, element by element for the cloud matrix,
// identity for textures) the shipped loops leave, after every frame, across
// the push's branches (cloud shadows on, off by URL/runtime, off at sunset
// under ?cloudNight, strength override / day-scaled / none, texture swaps,
// the matrix aliased with a destination, a destination that is not a Matrix4)
// and both tickTerrainUTime arms (crack-glow breath registered or not).
//
// HOW: two identical material registries (per-LB ShaderMaterials with the
// ~150-entry literal uniforms terrain.js builds, batch materials whose uniforms
// are CLONED key by key as terrain_batch.js does (dictionary-mode objects),
// entries without cloud uniforms, a null slot) driven by the same frame script;
// registry A runs the shipped loops, B the flagged ones; then every uniform of
// every material is compared. The real CloudVolume method runs on a stub `this`.
//
// Run:   cd apps/holtburger-web && node tests/hot_terrain_push.test.mjs
// Bench: node tests/hot_terrain_push.test.mjs --bench=off   (then --bench=on; repeat, take the min)

import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
const MAP = {
  "@takram/three-clouds": v("vendor/takram-three-clouds/build/index.js"),
  "@takram/three-atmosphere": v("vendor/takram/three-atmosphere.js"),
  "@takram/three-atmosphere/shaders/bruneton": v("vendor/takram/three-atmosphere-shaders-bruneton.js"),
  "@takram/three-geospatial": v("vendor/takram/three-geospatial.js"),
  "@takram/three-geospatial/shaders": v("vendor/takram/three-geospatial-shaders.js"),
  "@takram/three-geospatial-effects": v("vendor/takram/three-geospatial-effects.js"),
};
register("data:text/javascript," + encodeURIComponent(
  `const M = ${JSON.stringify(MAP)};
  export async function resolve(spec, ctx, next) { if (M[spec]) return { url: M[spec], shortCircuit: true }; return next(spec, ctx); }`));

globalThis.window = { location: { search: "" }, innerWidth: 800, innerHeight: 600,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.location = window.location;

const THREE = await import("three");
const CV = await import("../scene3d/cloud_volume.js");
const LOOP = await import("../scene3d/loop.js");
const OSC = await import("../scene3d/vfx/oscillators.js");
const { CRACK_GLOW_OSC_NAME } = await import("../scene3d/terrain_volcano.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── registries ───────────────────────────────────────────────────────────────
const FILL = Array.from({ length: 140 }, (_, i) => "uFill" + i);
const literal = new Function("THREE", "return function () { return {" +
  FILL.map((n) => `${n}: { value: 0 }`).join(",") +
  ", uTime: { value: 0 }, uCrackGlowBreath: { value: 1 }, uCloudShadowEnabled: { value: 0.0 }," +
  " uCloudShadowMap: { value: null }, uCloudShadowMatrix0: { value: new THREE.Matrix4() }, uCloudShadowStrength: { value: 2.0 } }; };")(THREE);
const sharedTex = [new THREE.Texture(), new THREE.Texture()];
const oddCopyLog = [];
class OddMatrix { constructor(tag) { this.tag = tag; this.elements = new Array(16).fill(0); }
  copy(m) { oddCopyLog.push(this.tag); for (let i = 0; i < 16; i++) this.elements[i] = m.elements[i] * 1; return this; } }
function buildRegistry(tag) {
  const r = rng(77);
  const mats = [];
  for (let i = 0; i < 180; i++) {
    const roll = r();
    let u;
    if (roll < 0.72) u = literal();
    else if (roll < 0.92) { const src = literal(); u = {}; for (const k of Object.keys(src)) u[k] = { value: src[k].value && src[k].value.clone ? src[k].value.clone() : src[k].value }; }
    else if (roll < 0.97) { u = { uTime: { value: 0 } }; }        // a registry entry without cloud uniforms
    else u = {};                                                     // no uTime either
    mats.push(new THREE.ShaderMaterial({ uniforms: u }));
  }
  mats.splice(37, 0, null);                                          // a hole in the registry
  mats[5].uniforms.uCloudShadowMatrix0.value = new OddMatrix(tag + "#5");
  return mats;
}
const A = buildRegistry("A"), B = buildRegistry("B");
// The cloud shadow matrix source (takram's shadowMatrices[0]); one per world so
// B can alias it into a destination exactly like A does.
const srcA = new THREE.Matrix4(), srcB = new THREE.Matrix4();
A[9].uniforms.uCloudShadowMatrix0.value = srcA;                     // destination aliased with the source
B[9].uniforms.uCloudShadowMatrix0.value = srcB;

function snapshot(mats) {
  const out = [];
  for (const m of mats) {
    if (!m) { out.push(null); continue; }
    const row = {};
    for (const [k, un] of Object.entries(m.uniforms)) {
      const val = un.value;
      if (val && val.elements) row[k] = ["m", ...Array.from(val.elements, (x) => (Object.is(x, -0) ? "-0" : String(x)))];
      else if (val && val.isTexture) row[k] = ["t", sharedTex.indexOf(val)];
      else row[k] = Object.is(val, -0) ? "-0" : (typeof val === "number" && Number.isNaN(val) ? "NaN" : val);
    }
    out.push(row);
  }
  return JSON.stringify(out);
}

function cloudThis(src) {
  return {
    _cloudNight: { enabled: true, directFactor: 1 },
    effect: { cloudsPass: { shadowBuffer: sharedTex[0] } },
    material: { uniforms: { shadowMatrices: { value: [src] } } },
  };
}
const thisA = cloudThis(srcA), thisB = cloudThis(srcB);
const lsA = { terrainMaterials: A }, lsB = { terrainMaterials: B };
const push = CV.CloudVolume.prototype._pushCloudShadowsToTerrain;

function frameScript(f, r, self, ls, src) {
  // matrix: new values most frames, a -0 and a repeat now and then
  for (let i = 0; i < 16; i++) src.elements[i] = (f % 11 === 0) ? src.elements[i] : (r() * 200 - 100);
  if (f % 13 === 0) src.elements[4] = -0;
  self._cloudNight = (f % 17 < 3) ? null : { enabled: f % 19 !== 0, directFactor: (f % 23 === 0) ? 0 : (f % 7) / 6 };
  ls.__cloudShadowDisabled = (f % 29) < 2;
  ls.__cloudShadowStrength = (f % 5 === 0) ? undefined : (f % 5 === 1 ? NaN : 0.5 + (f % 4));
  self.effect.cloudsPass.shadowBuffer = sharedTex[(f >> 3) & 1];
}

// `--bench=off|on`: bench ONE arm in this process and skip the identity frames
// (they run both arms, and a JIT that saw both measures neither). Run each arm
// a few times and take the minimum: the laptop is shared.
const BENCH_ARM = (process.argv.find((a) => a.startsWith("--bench=")) || "").slice(8);
const IDENTITY = BENCH_ARM === "";
let cloudDiff = null;
const rA = rng(5), rB = rng(5);
for (let f = 0; f < (IDENTITY ? 400 : 0) && !cloudDiff; f++) {
  frameScript(f, rA, thisA, lsA, srcA);
  frameScript(f, rB, thisB, lsB, srcB);
  window.liveScene3d = lsA; CV.__setHotCloudPushForTest(false); push.call(thisA);
  window.liveScene3d = lsB; CV.__setHotCloudPushForTest(true); push.call(thisB);
  const a = snapshot(A), b = snapshot(B);
  if (a !== b) cloudDiff = `frame ${f}`;
}
CV.__setHotCloudPushForTest(undefined);
if (IDENTITY) check("[1] cloud push: identical uniforms after each of 400 frames (all branches)", () => assert(!cloudDiff, cloudDiff));
if (IDENTITY) check("[2] cloud push: the non-Matrix4 destination still went through its own copy()", () => {
  const na = oddCopyLog.filter((t) => t === "A#5").length, nb = oddCopyLog.filter((t) => t === "B#5").length;
  assert(na > 0 && na === nb, `A ${na} vs B ${nb}`);
});

// ── tickTerrainUTime ─────────────────────────────────────────────────────────
let timeDiff = null;
for (let f = 0; f < (IDENTITY ? 200 : 0) && !timeDiff; f++) {
  if (f === 100) OSC.registerOscillator(CRACK_GLOW_OSC_NAME, { kind: "sine", config: {} });
  const osc = OSC.getOscillator(CRACK_GLOW_OSC_NAME);
  if (osc) osc.value = (f % 9 === 0) ? -0 : 0.44 + (f % 13) / 20;
  const tsSec = (f % 31 === 0) ? -0 : 1000 + f * 0.016;
  LOOP.__setHotTerrainTimeForTest(false); LOOP.__tickTerrainUTimeForTest({ terrainMaterials: A, frameTime: { tsSec } });
  LOOP.__setHotTerrainTimeForTest(true); LOOP.__tickTerrainUTimeForTest({ terrainMaterials: B, frameTime: { tsSec } });
  if (snapshot(A) !== snapshot(B)) timeDiff = `frame ${f}`;
}
LOOP.__setHotTerrainTimeForTest(undefined);
OSC.unregisterOscillator(CRACK_GLOW_OSC_NAME);
if (IDENTITY) check("[3] tickTerrainUTime: identical uniforms after each of 200 frames (breath off, then on)", () => assert(!timeDiff, timeDiff));

{
  const { __setRustFlagForTest, rustFlag } = await import("../scene3d/rust/scene_core.js");
  __setRustFlagForTest("hotCloudPush", undefined); __setRustFlagForTest("hotTerrainTime", undefined);
  const on = rustFlag("hotCloudPush", true) === true && rustFlag("hotTerrainTime", true) === true;
  check("[4] both flags default ON since 2026-10-26 (rustFlag readers, no query)", () => assert(on, "default must be on"));
}

if (!IDENTITY) {
  const reg = buildRegistry("bench");
  for (let i = 0; i < 2; i++) reg.push(...buildRegistry("bench" + i).filter(Boolean));
  const s = new THREE.Matrix4();
  const self = cloudThis(s);
  const ls = { terrainMaterials: reg };
  const bench = (label, fn) => {
    for (let i = 0; i < 2000; i++) fn(i);
    const N = 5000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn(i);
    console.log(`  bench ${label}: ${(Number(process.hrtime.bigint() - t0) / N / 1000).toFixed(1)} us/frame (${reg.length} materials)`);
  };
  const arm = BENCH_ARM;
  window.liveScene3d = ls;
  if (arm !== "on") {
    CV.__setHotCloudPushForTest(false);
    bench("cloud push, shipped    ", (i) => { s.elements[3] = i; push.call(self); });
    LOOP.__setHotTerrainTimeForTest(false);
    bench("terrain uTime, shipped  ", (i) => LOOP.__tickTerrainUTimeForTest({ terrainMaterials: reg, frameTime: { tsSec: i } }));
  }
  if (arm !== "off") {
    CV.__setHotCloudPushForTest(true);
    bench("cloud push, ?hotCloudPush", (i) => { s.elements[3] = i; push.call(self); });
    LOOP.__setHotTerrainTimeForTest(true);
    bench("terrain uTime, ?hotTerrainTime", (i) => LOOP.__tickTerrainUTimeForTest({ terrainMaterials: reg, frameTime: { tsSec: i } }));
  }
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
