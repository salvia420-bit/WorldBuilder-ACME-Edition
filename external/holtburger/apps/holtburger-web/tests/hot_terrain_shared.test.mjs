// tests/hot_terrain_shared.test.mjs — lane F2 (2026-10-26): `?hotTerrainShared`,
// one shared `{value}` per frame-constant terrain uniform
// (scene3d/terrain_shared_uniforms.js; loop.js tickTerrainUTime / tickTerrainSunDir;
// cloud_volume.js _pushCloudShadowsToTerrain; the IBL pusher sharedPushIbl).
//
// CLAIM: with the flag on, EVERY terrain material that ever existed holds, at
// every point of the frame, exactly the uniform values (Object.is per number,
// component by component, identity for textures) and the userData light epoch
// the per-material loops leave — through registry churn the field produces
// (bakes before / between / after the pushes, LRU evict = array reassignment,
// park / unpark, LOD dispose = splice, batch-material clones, duplicates, holes,
// an empty or missing registry), every push branch (crack-glow breath on/off,
// sky state missing, epoch changes, cloud shadows off / sunset / strength
// override, NaN, -0, none, texture swaps, a source matrix without elements, the
// devtools strength setter), materials that cannot be shared (three Uniform
// objects, extra keys, an aliased source matrix, a -0 a push would keep) and
// materials a shipped loop throws on (frozen uniform, custom matrix, a missing
// uniform its loop assumes): those must throw at the same push with the same
// partial writes. Readers (the far ring's copies, three's clone of a member,
// the snow light copy) see the same values. And three r184's real
// WebGLRenderer, drawing a subset of the materials over a fake WebGL2, issues
// the same GL call stream (every uniform* value) frame by frame.
//
// HOW: two instances of loop.js and cloud_volume.js (distinct import URLs):
// REF with the flag off, GEN with it on, both lane F flags forced the same way
// (both on, then both off), driven by one scripted RNG on two identically built
// worlds; after every step every material pair is compared.
//
// Run:   cd apps/holtburger-web && node tests/hot_terrain_shared.test.mjs
// Bench: node tests/hot_terrain_shared.test.mjs --bench=off   (then --bench=on; one arm per process)

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
const LOOP_P = new URL("../scene3d/loop.js", import.meta.url).href;
const CV_P = new URL("../scene3d/cloud_volume.js", import.meta.url).href;
const REF = { loop: await import(LOOP_P + "?ref"), cv: await import(CV_P + "?ref") };
REF.setStrength = window.__setCloudShadowStrength;
const GEN = { loop: await import(LOOP_P + "?gen"), cv: await import(CV_P + "?gen") };
GEN.setStrength = window.__setCloudShadowStrength;
const SH = await import("../scene3d/terrain_shared_uniforms.js");
const OSC = await import("../scene3d/vfx/oscillators.js");
const { CRACK_GLOW_OSC_NAME } = await import("../scene3d/terrain_volcano.js");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
REF.name = "REF"; GEN.name = "GEN";
REF.shared = false; GEN.shared = true;
REF.loop.__setHotTerrainSharedForTest(false); REF.cv.__setHotTerrainSharedForTest(false);
GEN.loop.__setHotTerrainSharedForTest(true); GEN.cv.__setHotTerrainSharedForTest(true);

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ── materials (terrain.js-shaped literal; terrain_batch-shaped clones) ───────
const FILL = Array.from({ length: 120 }, (_, i) => "uFill" + i);
const LITERAL = new Function("THREE", "return function (t, pl, ox, oy) { return {" +
  FILL.map((n) => `${n}: { value: 0 }`).join(",") + "," +
  " uTime: { value: t }, uCrackGlowBreath: { value: 1 }," +
  " uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() }, uSunGlint: { value: 1.0 }," +
  " uPaintLight: { value: new THREE.Vector4(pl, 60, 300, 0) }, uAcGouraudEnabled: { value: 1.0 }," +
  " uAcSunVec: { value: new THREE.Vector3(0, 0, 0) }, uAcSunColor: { value: new THREE.Color(1, 1, 1) }," +
  " uAcAmbColor: { value: new THREE.Color(1, 1, 1) }, uAcAmbLevel: { value: 0.2 }," +
  " uCloudShadowEnabled: { value: 0.0 }, uCloudShadowMap: { value: null }," +
  " uCloudShadowMatrix0: { value: new THREE.Matrix4() }, uCloudShadowStrength: { value: 2.0 }," +
  " uIblEnabled: { value: 0.0 }, uEnvCube: { value: null }, uEnvIntensity: { value: 1.0 }," +
  " uLbOriginXy: { value: new THREE.Vector2(ox, oy) } }; };")(THREE);
const CANDIDATES = ["uTime", "uCrackGlowBreath", "uSunDir", "uSunGlint", "uPaintLight", "uAcSunVec", "uAcSunColor",
  "uAcAmbColor", "uAcAmbLevel", "uCloudShadowEnabled", "uCloudShadowMap", "uCloudShadowMatrix0",
  "uCloudShadowStrength", "uIblEnabled", "uEnvCube", "uEnvIntensity", "uLbOriginXy", "uFill7"];

function cloneUniformValue(x) { // terrain_batch.js `_cloneUniformValue`
  if (x == null) return x;
  if (x.isTexture) return x;
  if (typeof x.clone === "function") return x.clone();
  if (Array.isArray(x)) return x.slice();
  if (ArrayBuffer.isView(x)) return x.slice();
  return x;
}
class OddMatrix { // a non-Matrix4 destination with its own copy (shipped loops call it)
  constructor(log) { this.log = log; this.elements = new Array(16).fill(0); }
  copy(m) { this.log.n += 1; for (let i = 0; i < 16; i++) this.elements[i] = m.elements[i] * 1; return this; }
}
const TEX = [new THREE.DataArrayTexture(new Uint8Array(4 * 2), 1, 1, 2), new THREE.DataArrayTexture(new Uint8Array(4 * 2), 1, 1, 2)];
for (const t of TEX) t.needsUpdate = true;
const CUBE = [null, new THREE.Texture()];

// One world per arm, built by the same decisions.
function makeWorld(arm) {
  return {
    arm,
    scene: { terrainMaterials: [], frameTime: { tsSec: 0 }, skyLightingController: { _lastState: null, _tickCount: 0 } },
    all: [],          // every material ever made, in creation order
    parked: [],
    src: new THREE.Matrix4(),
    oddLog: { n: 0 },
    cloud: null,
    far: new THREE.ShaderMaterial({ uniforms: { uSunDir: { value: new THREE.Vector3() }, uAcGouraudEnabled: { value: 0 },
      uAcSunVec: { value: new THREE.Vector3() }, uAcSunColor: { value: new THREE.Color() }, uPaintLight: { value: new THREE.Vector4() },
      uAcAmbColor: { value: new THREE.Color() }, uAcAmbLevel: { value: 0 } } }),
    snow: { uSunVec: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Vector3() }, uAmbCol: { value: new THREE.Vector3() },
      uAmbLevel: { value: 0 }, uSunDir: { value: new THREE.Vector3() } },
    clones: [],
    throws: [],
  };
}
// kinds: lb | batch | partial-* | priv-* | haz-* | nouserdata
function makeMaterial(W, kind, p) {
  let u;
  if (kind === "batch" && p.from !== null && W.all[p.from] && !isHaz(W.all[p.from])) {
    const srcU = W.all[p.from].uniforms;
    u = {};
    for (const k of Object.keys(srcU)) u[k] = { value: cloneUniformValue(srcU[k].value) };
  } else if (kind === "partial-time") {
    u = { uTime: { value: W.scene.frameTime.tsSec } };
  } else if (kind === "partial-none") {
    u = {};
  } else if (kind === "partial-nocloud") {
    u = LITERAL(W.scene.frameTime.tsSec, p.pl, p.ox, p.oy);
    delete u.uCloudShadowEnabled; delete u.uCloudShadowMap; delete u.uCloudShadowMatrix0; delete u.uCloudShadowStrength;
  } else {
    u = LITERAL(W.scene.frameTime.tsSec, p.pl, p.ox, p.oy);
  }
  if (kind === "priv-uniform") u.uTime = new THREE.Uniform(u.uTime ? u.uTime.value : 0);
  if (kind === "priv-extra") { u.uSunDir = { value: u.uSunDir.value, needsUpdate: true }; u.uCloudShadowEnabled = { value: 0.0, needsUpdate: true }; }
  if (kind === "priv-alias") u.uCloudShadowMatrix0 = { value: W.src };
  if (kind === "priv-negzero") { u.uCloudShadowEnabled.value = -0; u.uCloudShadowStrength.value = -0; }
  if (kind === "haz-frozen") u.uTime = Object.freeze({ value: 0 });
  if (kind === "haz-odd") u.uCloudShadowMatrix0 = { value: new OddMatrix(W.oddLog) };
  if (kind === "haz-nomap") delete u.uCloudShadowMap;
  if (kind === "haz-gouraud") delete u.uAcSunColor;
  if (kind === "haz-ibl") delete u.uEnvIntensity;
  const m = new THREE.ShaderMaterial({ uniforms: u });
  if (kind === "nouserdata") m.userData = null;
  W.all.push(m);
  return m;
}

// ── comparison ──────────────────────────────────────────────────────────────
function valDiff(a, b) {
  // numbers first: `===` would call -0 and +0 equal
  if (typeof a === "number" || typeof b === "number") return Object.is(a, b) ? null : `${Object.is(a, -0) ? "-0" : String(a)} vs ${Object.is(b, -0) ? "-0" : String(b)}`;
  if (a === b) return null;
  if (a == null || b == null) return `${a} vs ${b}`;
  // three's material.clone() clones textures (Texture.copy shares the Source): a
  // clone made in each world holds its own Texture object over the same Source.
  if (a.isTexture || b.isTexture) return a.isTexture && b.isTexture && a.source === b.source ? null : "different texture";
  if (a.elements && b.elements) {
    for (let i = 0; i < 16; i++) if (!Object.is(a.elements[i], b.elements[i])) return `elements[${i}] ${a.elements[i]} vs ${b.elements[i]}`;
    if ((a instanceof OddMatrix) !== (b instanceof OddMatrix)) return "matrix class differs";
    return null;
  }
  for (const k of ["x", "y", "z", "w", "r", "g", "b"]) {
    if (k in a || k in b) if (!Object.is(a[k], b[k])) return `.${k} ${a[k]} vs ${b[k]}`;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return "value class differs";
  return null;
}
function matDiff(ma, mb) {
  const ua = ma.uniforms, ub = mb.uniforms;
  for (const k of CANDIDATES) {
    const ia = k in ua, ib = k in ub;
    if (ia !== ib) return `${k}: presence`;
    if (!ia) continue;
    const d = valDiff(ua[k] && ua[k].value, ub[k] && ub[k].value);
    if (d) return `${k}: ${d}`;
    const ka = ua[k] ? Object.keys(ua[k]).join() : "", kb = ub[k] ? Object.keys(ub[k]).join() : "";
    if (ka !== kb) return `${k}: uniform keys ${ka} vs ${kb}`;
    if (ua[k] && ub[k] && ua[k].needsUpdate !== ub[k].needsUpdate) return `${k}: needsUpdate`;
  }
  const ea = ma.userData ? ma.userData.__acLightEpoch : "none", eb = mb.userData ? mb.userData.__acLightEpoch : "none";
  if (!Object.is(ea, eb)) return `epoch ${ea} vs ${eb}`;
  return null;
}
let firstDiff = null;
let probes = 0;
function compare(A, B, where) {
  probes += 1;
  if (firstDiff) return;
  if (A.all.length !== B.all.length) { firstDiff = `${where}: material count`; return; }
  for (let i = 0; i < A.all.length; i++) {
    const d = matDiff(A.all[i], B.all[i]);
    if (d) { firstDiff = `${where}: material #${i}: ${d}`; return; }
  }
  for (const [x, y, n] of [[A.far, B.far, "far"]]) { const d = matDiff(x, y); if (d) { firstDiff = `${where}: ${n}: ${d}`; return; } }
  for (const k of Object.keys(A.snow)) { const d = valDiff(A.snow[k].value, B.snow[k].value); if (d) { firstDiff = `${where}: snow ${k}: ${d}`; return; } }
  if (A.clones.length !== B.clones.length) { firstDiff = `${where}: clone count`; return; }
  for (let i = 0; i < A.clones.length; i++) { const d = matDiff(A.clones[i], B.clones[i]); if (d) { firstDiff = `${where}: clone #${i}: ${d}`; return; } }
  if (A.throws.join() !== B.throws.join()) { firstDiff = `${where}: throws ${A.throws.slice(-3)} vs ${B.throws.slice(-3)}`; return; }
  if (A.oddLog.n !== B.oddLog.n) { firstDiff = `${where}: odd copy() calls ${A.oddLog.n} vs ${B.oddLog.n}`; }
}

// ── the pushes, as production calls them ────────────────────────────────────
function lightTickFor(W) { return { sync: () => W.epoch }; }
const ENV = { sync() { return null; }, lightTick() { return null; } };
function shippedIbl(mats, envCube, envI) { // ibl_environment.js IblEnvironment.tick's terrain loop, verbatim
  for (const mat of mats) {
    const u = mat?.uniforms;
    if (!u || !u.uIblEnabled) continue;
    u.uIblEnabled.value = 1.0;
    u.uEnvCube.value = envCube;
    u.uEnvIntensity.value = envI;
  }
}
function attempt(W, tag, fn) {
  try { fn(); W.throws.push(tag + ":ok"); } catch (e) { W.throws.push(tag + ":" + (e && e.constructor && e.constructor.name)); }
}
function pushTime(W, A) { attempt(W, "time", () => A.loop.__tickTerrainUTimeForTest(W.scene)); }
function pushSun(W, A) { attempt(W, "sun", () => A.loop.tickTerrainSunDir(W.scene, lightTickFor(W), ENV)); }
function pushIbl(W, A, envCube, envI) {
  attempt(W, "ibl", () => {
    const mats = W.scene.terrainMaterials;
    if (!Array.isArray(mats)) return;
    if (A.shared && SH.sharedPushIbl(mats, envCube, envI)) return;
    shippedIbl(mats, envCube, envI);
  });
}
function pushCloud(W, A) {
  window.liveScene3d = W.scene;
  attempt(W, "cloud", () => A.cv.CloudVolume.prototype._pushCloudShadowsToTerrain.call(W.cloud));
}
function setStrength(W, A, s) { window.liveScene3d = W.scene; attempt(W, "setStrength", () => A.setStrength(s)); }
function farPublish(W) { // far_terrain.js publishFarUniforms' copy from the first member with uSunDir
  const src = Array.isArray(W.scene.terrainMaterials) ? W.scene.terrainMaterials.find((m) => m && m.uniforms && m.uniforms.uSunDir) : null;
  if (!src) return;
  const s = src.uniforms, u = W.far.uniforms;
  if (s.uSunDir) u.uSunDir.value.copy(s.uSunDir.value);
  if (s.uAcGouraudEnabled) u.uAcGouraudEnabled.value = s.uAcGouraudEnabled.value;
  if (s.uAcSunVec) u.uAcSunVec.value.copy(s.uAcSunVec.value);
  if (s.uAcSunColor) u.uAcSunColor.value.copy(s.uAcSunColor.value);
  if (s.uPaintLight && u.uPaintLight) u.uPaintLight.value.copy(s.uPaintLight.value);
  if (s.uAcAmbColor) u.uAcAmbColor.value.copy(s.uAcAmbColor.value);
  if (s.uAcAmbLevel) u.uAcAmbLevel.value = s.uAcAmbLevel.value;
}
function snowCopy(W) { // terrain_snow.js copyTerrainLighting
  const mats = W.scene.terrainMaterials;
  if (!Array.isArray(mats)) return;
  let src = null;
  for (let i = 0; i < mats.length; i++) {
    const u = mats[i] && mats[i].uniforms;
    if (u && u.uAcSunVec && u.uAcSunColor && u.uAcAmbColor && u.uAcAmbLevel) { src = u; break; }
  }
  if (!src) return;
  const c = (d, s) => { if ("x" in s) { d.x = s.x; d.y = s.y; d.z = s.z; } else { d.x = s.r; d.y = s.g; d.z = s.b; } };
  c(W.snow.uSunVec.value, src.uAcSunVec.value);
  c(W.snow.uSunCol.value, src.uAcSunColor.value);
  c(W.snow.uAmbCol.value, src.uAcAmbColor.value);
  W.snow.uAmbLevel.value = Number.isFinite(src.uAcAmbLevel.value) ? src.uAcAmbLevel.value : 0.2;
  if (src.uSunDir && src.uSunDir.value) c(W.snow.uSunDir.value, src.uSunDir.value);
}
function farClone(W) { // far_terrain.js ensureBakeRig: src.clone() of the first member with uBakeAlbedo (here: uAcGouraudEnabled)
  const mats = W.scene.terrainMaterials;
  const src = Array.isArray(mats) ? mats.find((m) => m && m.uniforms && m.uniforms.uAcGouraudEnabled) : null;
  if (src) W.clones.push(src.clone());
}

// ── the scripted world ──────────────────────────────────────────────────────
const KINDS_NORMAL = ["lb", "lb", "lb", "lb", "lb", "lb", "lb", "batch", "partial-time", "partial-none", "partial-nocloud",
  "priv-uniform", "priv-extra", "priv-alias", "priv-negzero", "nouserdata"];
function isHaz(m) {
  return !!(m && m.uniforms && (Object.isFrozen(m.uniforms.uTime) ||
    (m.uniforms.uCloudShadowMatrix0 && m.uniforms.uCloudShadowMatrix0.value instanceof OddMatrix) ||
    (m.uniforms.uCloudShadowEnabled && !m.uniforms.uCloudShadowMap) || (m.uniforms.uAcSunVec && !m.uniforms.uAcSunColor) ||
    (m.uniforms.uIblEnabled && !m.uniforms.uEnvIntensity)));
}
const KINDS_HAZ = ["haz-frozen", "haz-odd", "haz-nomap", "haz-gouraud", "haz-ibl"];

function runScenario(FRAMES, laneF, seed) {
  for (const A of [REF, GEN]) {
    A.loop.__setHotTerrainTimeForTest(laneF);
    A.cv.__setHotCloudPushForTest(laneF);
  }
  const WA = makeWorld(REF), WB = makeWorld(GEN);
  const worlds = [[WA, REF], [WB, GEN]];
  for (const [W] of worlds) {
    W.cloud = { _cloudNight: { enabled: true, directFactor: 1 }, effect: { cloudsPass: { shadowBuffer: TEX[0] } },
      material: { uniforms: { shadowMatrices: { value: [W.src] } } } };
    W.epoch = 1;
  }
  const r = rng(seed);
  const both = (fn) => { for (const [W, A] of worlds) fn(W, A); };
  const bake = (n, hazOk) => {
    for (let k = 0; k < n; k++) {
      const pool = hazOk && r() < 0.25 ? KINDS_HAZ : KINDS_NORMAL;
      const kind = pool[(r() * pool.length) | 0];
      const p = { pl: (r() * 3) | 0, ox: (r() * 10) | 0, oy: (r() * 10) | 0, from: WA.all.length ? (r() * WA.all.length) | 0 : null };
      both((W) => { if (Array.isArray(W.scene.terrainMaterials)) W.scene.terrainMaterials.push(makeMaterial(W, kind, p)); });
    }
  };
  let shareFrames = 0;
  for (let f = 0; f < FRAMES && !firstDiff; f++) {
    const hazPhase = (f % 400) >= 330;            // hazards baked only in this window, evicted after
    const tsSec = (f % 97 === 0) ? -0 : 1000 + f * 0.016;
    if (f % 173 === 60) OSC.registerOscillator(CRACK_GLOW_OSC_NAME, { kind: "sine", config: {} });
    if (f % 173 === 140) OSC.unregisterOscillator(CRACK_GLOW_OSC_NAME);
    const osc = OSC.getOscillator(CRACK_GLOW_OSC_NAME);
    if (osc) osc.value = (f % 9 === 0) ? -0 : 0.44 + (f % 13) / 20;
    const skyState = (f % 211 < 6) ? null : {
      dirHeading: (f % 61 === 0) ? NaN : 30 + f * 0.3, dirPitch: 40 - (f % 120) * 0.5, dirBright: 0.8 - (f % 50) / 100,
      dirColorArgb: 0xfff0e0d0, ambBright: 0.3 + (f % 7) / 30, ambColorArgb: 0xff6480c0,
    };
    const epochBump = (f % 37 === 0);
    const cloudMode = f % 53;
    const strengthMode = f % 23;
    const srcElems = Array.from({ length: 16 }, (_, i) => (f % 11 === 0 && i < 8) ? 0 : (r() * 200 - 100));
    if (f % 29 === 0) srcElems[4] = -0;
    // registry churn decided once, applied to both worlds
    const ops = [];
    if (f % 400 === 399) ops.push(["evictHaz"]);
    if (f % 250 === 120) ops.push(["empty"]);
    if (f % 250 === 123) ops.push(["undefinedRegistry"]);
    if (f % 250 === 124) ops.push(["restoreRegistry"]);
    if (r() < 0.12) ops.push(["evict", (r() * 3) | 0, r()]);
    if (r() < 0.08) ops.push(["park", r()]);
    if (r() < 0.10) ops.push(["unpark"]);
    if (r() < 0.06) ops.push(["splice", r()]);
    if (r() < 0.03) ops.push(["dup", r()]);
    if (r() < 0.02) ops.push(["hole"]);
    if (r() < 0.05) ops.push(["copyArray"]);
    if (r() < 0.05) ops.push(["swap", r(), r()]);           // reorder: the diff walk misreads survivors
    if (r() < 0.04) ops.push(["undup"]);                     // drop one occurrence of a duplicated entry
    const insertMid = r() < 0.08 ? r() : -1;                 // a bake spliced mid-array
    const nBake = r() < 0.35 ? 1 + ((r() * 3) | 0) : 0;
    const midBake1 = r() < 0.15, midBake2 = r() < 0.15, lateBake = r() < 0.1;
    const doSun = r() < 0.9;                       // the RP3 SKY group sometimes defers it
    const doFar = r() < 0.5, doClone = r() < 0.02, doSnow = r() < 0.5;
    const setter = (f % 131 === 77) ? (f % 2 ? 2.5 : 0) : null;
    const envI = (f % 17 === 0) ? -0 : 0.3 + (f % 5) / 10;
    const envCube = CUBE[(f >> 4) & 1];

    for (const [W] of worlds) {
      W.scene.frameTime.tsSec = tsSec;
      W.scene.skyLightingController._lastState = skyState;
      W.scene.skyLightingController._tickCount = f;
      if (epochBump) W.epoch += 1;
      for (let i = 0; i < 16; i++) W.src.elements[i] = srcElems[i];
      W.cloud._cloudNight = (cloudMode < 3) ? null : { enabled: cloudMode % 19 !== 0, directFactor: (cloudMode === 23) ? 0 : (cloudMode % 7) / 6 };
      W.scene.__cloudShadowDisabled = cloudMode >= 47;
      W.scene.__cloudShadowStrength = strengthMode === 0 ? undefined : strengthMode === 1 ? NaN : strengthMode === 2 ? -0 : 0.5 + (strengthMode % 4);
      W.cloud.effect.cloudsPass.shadowBuffer = (f % 67 === 5) ? null : TEX[(f >> 3) & 1];
      W.cloud.material.uniforms.shadowMatrices.value = (f % 89 === 7) ? [{ notAMatrix: true }] : [W.src];
      let R = W.scene.terrainMaterials;
      for (const op of ops) {
        if (!Array.isArray(R) && op[0] !== "restoreRegistry") continue;
        if (op[0] === "evict") {
          const drop = new Set();
          for (let k = 0; k < op[1] && R.length; k++) drop.add(R[Math.floor(op[2] * R.length) % R.length]);
          R = W.scene.terrainMaterials = R.filter((m) => !drop.has(m));
        } else if (op[0] === "evictHaz") {
          R = W.scene.terrainMaterials = R.filter((m) => !isHaz(m));
          W.parked = W.parked.filter((m) => !isHaz(m));
        } else if (op[0] === "park") {
          if (!R.length) continue;
          const mine = new Set([R[Math.floor(op[1] * R.length) % R.length]]);
          W.parked.push(...R.filter((m) => mine.has(m)));
          R = W.scene.terrainMaterials = R.filter((m) => !mine.has(m));
        } else if (op[0] === "unpark") {
          for (const m of W.parked) if (!R.includes(m)) R.push(m);
          W.parked.length = 0;
        } else if (op[0] === "splice") {
          if (!R.length) continue;
          const i = Math.floor(op[1] * R.length) % R.length;
          R.splice(i, 1);
        } else if (op[0] === "dup") {
          if (R.length) R.push(R[Math.floor(op[1] * R.length) % R.length]);
        } else if (op[0] === "hole") {
          R.push(null);
        } else if (op[0] === "copyArray") {
          R = W.scene.terrainMaterials = R.slice();
        } else if (op[0] === "swap") {
          if (R.length < 2) continue;
          const i = Math.floor(op[1] * R.length) % R.length, j = Math.floor(op[2] * R.length) % R.length;
          const t = R[i]; R[i] = R[j]; R[j] = t;
        } else if (op[0] === "undup") {
          for (let i = R.length - 1; i > 0; i--) if (R.indexOf(R[i]) < i) { R.splice(i, 1); break; }
        } else if (op[0] === "empty") {
          W.parked.push(...R.filter(Boolean));
          R = W.scene.terrainMaterials = [];
        } else if (op[0] === "undefinedRegistry") {
          W._savedR = R; R = W.scene.terrainMaterials = undefined;
        } else if (op[0] === "restoreRegistry") {
          if (W._savedR) { R = W.scene.terrainMaterials = W._savedR; W._savedR = null; }
        }
      }
    }
    bake(nBake, hazPhase);
    if (insertMid >= 0) {
      const kind = KINDS_NORMAL[(r() * KINDS_NORMAL.length) | 0];
      const p = { pl: 1, ox: 3, oy: 4, from: WA.all.length ? (r() * WA.all.length) | 0 : null };
      both((W) => { const R = W.scene.terrainMaterials; if (Array.isArray(R)) R.splice(Math.floor(insertMid * R.length), 0, makeMaterial(W, kind, p)); });
    }
    compare(WA, WB, `f${f} after churn`);
    both((W, A) => pushTime(W, A));
    compare(WA, WB, `f${f} after time push`);
    if (midBake1) { bake(1, hazPhase); compare(WA, WB, `f${f} after mid bake 1`); }
    if (doSun) { both((W, A) => pushSun(W, A)); compare(WA, WB, `f${f} after sun push`); }
    both((W, A) => pushIbl(W, A, envCube, envI));
    compare(WA, WB, `f${f} after ibl push`);
    if (midBake2) { bake(1, hazPhase); compare(WA, WB, `f${f} after mid bake 2`); }
    if ((f % 300) < 250) {                         // indoors (f%300 >= 250): CloudOverlay.preRender is not called
      both((W, A) => pushCloud(W, A));
      compare(WA, WB, `f${f} after cloud push`);
    }
    if (setter !== null) { both((W, A) => setStrength(W, A, setter)); compare(WA, WB, `f${f} after strength setter`); }
    if (doFar) both((W) => farPublish(W));
    if (doSnow) both((W) => snowCopy(W));
    if (doClone) both((W) => farClone(W));
    if (lateBake) bake(1, hazPhase);
    compare(WA, WB, `f${f} end`);
    const problems = SH.verifySharedTerrain();
    if (problems.length && !firstDiff) firstDiff = `f${f}: verify: ${problems[0]}`;
    const st = SH.terrainSharedStats();
    if (st.time.groups[0].bound > 0 && st.cloud.groups[0].bound > 0) shareFrames += 1;
  }
  return { WA, WB, shareFrames };
}

// ── [1]–[3] value identity, lane F flags on, then off ───────────────────────
const BENCH_ARM = (process.argv.find((a) => a.startsWith("--bench=")) || "").slice(8);
const IDENTITY = BENCH_ARM === "";
let run1 = null, run2 = null;
if (IDENTITY) {
  const statsBefore = SH.terrainSharedStats();
  run1 = runScenario(1200, true, 20261026);
  const d1 = firstDiff;
  check(`[1] lane F flags on: every material identical at every step (${probes} probes, ${run1.WA.all.length} materials, ${run1.shareFrames} frames shared)`,
    () => assert(!d1, d1));
  firstDiff = null; const p0 = probes;
  run2 = runScenario(900, false, 7);
  const d2 = firstDiff;
  check(`[2] lane F flags off: every material identical at every step (${probes - p0} probes, ${run2.WA.all.length} materials)`,
    () => assert(!d2, d2));
  firstDiff = null;
  const st = SH.terrainSharedStats();
  check("[3] the shared path carried the pushes and fell back exactly where hazards were registered", () => {
    assert(run1.shareFrames > 600 && run2.shareFrames > 400, `shared frames ${run1.shareFrames} / ${run2.shareFrames}`);
    for (const k of ["time", "sun", "cloud", "ibl"]) {
      assert(st[k].pushes > statsBefore[k].pushes + 500, `${k} pushes ${st[k].pushes}`);
      assert(st[k].fallbacks > 0, `${k}: no fallback exercised`);
      assert(st[k].fallbacks < st[k].pushes / 3, `${k}: ${st[k].fallbacks} fallbacks of ${st[k].pushes}`);
    }
    const throwsA = run1.WA.throws.filter((t) => !t.endsWith(":ok")).length;
    assert(throwsA > 0, "the hazard phases made no shipped loop throw");
    let incr = 0, full = 0;
    for (const k of ["time", "sun", "cloud", "ibl"]) for (const g of st[k].groups) { incr += g.increments; full += g.resyncs; }
    assert(incr > 1000 && full > 50, `incremental ${incr} / full ${full} resyncs`);
    console.log(`      (groups: ${incr} incremental and ${full} full resyncs; fallbacks time ${st.time.fallbacks}, sun ${st.sun.fallbacks}, cloud ${st.cloud.fallbacks}, ibl ${st.ibl.fallbacks})`);
  });
}

// ── [4] retention: leavers drop the slots ───────────────────────────────────
if (IDENTITY) {
  check("[4] after the registry empties, no material points at a slot and no slot holds a material", () => {
    const W = run1.WB;
    const slotObjs = new Set();
    // every slot object currently bound somewhere, from the live registry
    for (const m of W.all) for (const k of CANDIDATES) if (m.uniforms[k]) slotObjs.add(m.uniforms[k]);
    W.scene.terrainMaterials = [];
    pushTime(W, GEN); pushSun(W, GEN); pushIbl(W, GEN, null, 1); pushCloud(W, GEN);
    SH.sharedReleaseIbl();
    const st = SH.terrainSharedStats();
    for (const k of ["time", "sun", "cloud", "ibl"]) for (const g of st[k].groups) assert(g.bound === 0, `${k} ${g.names}: ${g.bound} still bound`);
    // a uniform object shared by two materials (other than the fx-light kind, absent here) would be a leftover slot
    const seen = new Map();
    for (const m of W.all) for (const k of ["uTime", "uSunDir", "uCloudShadowEnabled", "uCloudShadowMap", "uCloudShadowMatrix0", "uCloudShadowStrength", "uIblEnabled"]) {
      const o = m.uniforms[k];
      if (!o) continue;
      if (seen.has(o) && seen.get(o) !== m) throw new Error(`${k} object still shared after release`);
      seen.set(o, m);
    }
  });
}

// ── [5] three r184 over a fake WebGL2: the same GL call stream ──────────────
const VS = `uniform float uTime; uniform float uCrackGlowBreath; uniform vec3 uSunDir; uniform vec3 uAcSunVec;
uniform vec3 uAcSunColor; uniform vec3 uAcAmbColor; uniform float uAcAmbLevel; uniform float uSunGlint; uniform vec4 uPaintLight;
uniform float uCloudShadowEnabled; uniform mat4 uCloudShadowMatrix0; uniform float uCloudShadowStrength;
uniform float uIblEnabled; uniform float uEnvIntensity; uniform vec2 uLbOriginXy;
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS = `precision highp sampler2DArray; uniform sampler2DArray uCloudShadowMap;
out vec4 hbOut; void main() { hbOut = vec4(1.0); }`;
function ser(x) {
  if (x === null || x === undefined) return String(x);
  if (typeof x === "number") return Object.is(x, -0) ? "-0" : String(x);
  if (typeof x === "string") return x.length > 200 ? "src#" + x.length + ":" + x.slice(0, 40) : x;
  if (typeof x === "boolean") return String(x);
  if (ArrayBuffer.isView(x) || Array.isArray(x)) return "[" + Array.from(x, ser).join(",") + "]";
  if (x.__kind) return x.__kind + "#" + x.__id;
  if (typeof x.name === "string") return "loc:" + x.name;
  return typeof x;
}
if (IDENTITY) {
  check("[5] three r184 + fake WebGL2: identical GL call streams, frame by frame (uploads of every terrain uniform)", () => {
    for (const A of [REF, GEN]) { A.loop.__setHotTerrainTimeForTest(true); A.cv.__setHotCloudPushForTest(true); }
    const arms = [REF, GEN].map((A) => {
      const log = [];
      const gl = createFakeWebGL2({ maxTextures: 16, onCall: (name, args) => { log.push(name + "(" + Array.from(args, ser).join(",") + ")"); } });
      const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      camera.position.set(0, 0, 10);
      const W = makeWorld(A);
      W.cloud = { _cloudNight: { enabled: true, directFactor: 1 }, effect: { cloudsPass: { shadowBuffer: TEX[0] } },
        material: { uniforms: { shadowMatrices: { value: [W.src] } } } };
      W.epoch = 1;
      return { A, W, log, gl, renderer, scene, camera };
    });
    const r = rng(99);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    for (let f = 0; f < 90; f++) {
      const nNew = f === 0 ? 8 : (r() < 0.3 ? 1 : 0);
      const drawIdx = [];
      const kinds = [];
      for (let k = 0; k < nNew; k++) kinds.push(KINDS_NORMAL[(r() * KINDS_NORMAL.length) | 0]);
      const evict = r() < 0.15 ? r() : -1;
      const draws = 3 + ((r() * 4) | 0);
      for (let k = 0; k < draws; k++) drawIdx.push(r());
      const srcElems = Array.from({ length: 16 }, () => r() * 10 - 5);
      for (const X of arms) {
        const { W } = X;
        W.scene.frameTime.tsSec = 50 + f * 0.016;
        W.scene.skyLightingController._lastState = { dirHeading: 10 + f, dirPitch: 30 - f * 0.4, dirBright: 0.7, dirColorArgb: 0xffeeddcc,
          ambBright: 0.25, ambColorArgb: 0xff5070a0 };
        W.scene.skyLightingController._tickCount = f;
        if (f % 20 === 0) W.epoch += 1;
        for (let i = 0; i < 16; i++) W.src.elements[i] = srcElems[i];
        W.cloud.effect.cloudsPass.shadowBuffer = TEX[(f >> 4) & 1];
        W.scene.__cloudShadowStrength = f % 10 === 0 ? undefined : 1 + (f % 3);
        for (const kind of kinds) {
          const mat = makeMaterial(W, kind === "partial-none" || kind === "partial-time" ? "lb" : kind, { pl: 1, ox: f, oy: 2, from: W.all.length ? 0 : null });
          W.scene.terrainMaterials.push(mat);
        }
        if (evict >= 0 && W.scene.terrainMaterials.length > 4) {
          const drop = W.scene.terrainMaterials[Math.floor(evict * W.scene.terrainMaterials.length)];
          W.scene.terrainMaterials = W.scene.terrainMaterials.filter((m) => m !== drop);
        }
        pushTime(W, X.A); pushSun(W, X.A); pushCloud(W, X.A);
        // draw a subset (the batch material is always one of them in the field; here: any members, incl. evicted ones)
        X.scene.clear();
        for (const t of drawIdx) {
          const m = W.all[Math.floor(t * W.all.length)];
          if (!m.vertexShader.includes("uTime")) { m.vertexShader = VS; m.fragmentShader = FS; m.glslVersion = THREE.GLSL3; m.needsUpdate = true; }
          const mesh = new THREE.Mesh(geo, m);
          mesh.frustumCulled = false;
          X.scene.add(mesh);
        }
        X.log.length = 0;
        X.renderer.render(X.scene, X.camera);
      }
      const a = arms[0].log.join("\n"), b = arms[1].log.join("\n");
      if (a !== b) {
        const la = arms[0].log, lb = arms[1].log;
        let i = 0; while (i < la.length && la[i] === lb[i]) i++;
        throw new Error(`frame ${f}: GL call ${i} differs: ${la[i]} vs ${lb[i]}`);
      }
      if (f === 0 && arms[0].log.filter((s) => s.startsWith("uniform")).length < 10) throw new Error("no uniform uploads recorded");
    }
  });
}

// ── [7] the Gouraud walk over joiners only covers exactly one diff step ──────
if (IDENTITY) {
  check("[7] sun: materials that joined while the push wrote nothing (no sky state) are lit when it resumes", () => {
    for (const A of [REF, GEN]) A.loop.__setHotTerrainTimeForTest(true);
    const worlds = [[makeWorld(REF), REF], [makeWorld(GEN), GEN]];
    const st = { dirHeading: 20, dirPitch: 30, dirBright: 0.9, dirColorArgb: 0xffe0d0c0, ambBright: 0.3, ambColorArgb: 0xff405060 };
    const p = { pl: 1, ox: 0, oy: 0, from: null };
    const step = (fn) => { for (const [W, A] of worlds) fn(W, A); compare(worlds[0][0], worlds[1][0], "[7]"); };
    step((W) => { W.epoch = 5; W.scene.skyLightingController._lastState = st; for (let i = 0; i < 3; i++) W.scene.terrainMaterials.push(makeMaterial(W, "lb", p)); });
    step((W, A) => pushSun(W, A));                                  // full walk, all three lit
    step((W) => { W.scene.skyLightingController._lastState = null; W.scene.terrainMaterials.push(makeMaterial(W, "lb", p)); });
    step((W, A) => pushSun(W, A));                                  // no sky state: nothing written (GEN only observes)
    step((W) => { W.scene.skyLightingController._lastState = st; W.scene.terrainMaterials.push(makeMaterial(W, "lb", p)); });
    step((W, A) => pushSun(W, A));                                  // two diff steps since the walk: must walk everything
    const lit = worlds[1][0].all.map((m) => m.userData.__acLightEpoch);
    assert(!firstDiff, firstDiff);
    assert(lit.every((e) => e === 5), `epochs ${lit}`);
  });
}

// ── [8] a paused pusher holds no leaver for long ────────────────────────────
if (IDENTITY) {
  check("[8] indoors (no cloud push): evicted materials leave the cloud slots within 31 frames, values exact", () => {
    for (const A of [REF, GEN]) { A.loop.__setHotTerrainTimeForTest(true); A.cv.__setHotCloudPushForTest(true); }
    const worlds = [[makeWorld(REF), REF], [makeWorld(GEN), GEN]];
    for (const [W] of worlds) {
      W.cloud = { _cloudNight: { enabled: true, directFactor: 1 }, effect: { cloudsPass: { shadowBuffer: TEX[0] } },
        material: { uniforms: { shadowMatrices: { value: [W.src] } } } };
      W.epoch = 1;
      for (let i = 0; i < 40; i++) W.scene.terrainMaterials.push(makeMaterial(W, "lb", { pl: 1, ox: i, oy: 0, from: null }));
    }
    const sweeps0 = SH.terrainSharedStats().cloud.idleSweeps;
    for (let f = 0; f < 80; f++) {
      for (const [W, A] of worlds) {
        W.scene.frameTime.tsSec = 2000 + f * 0.016;
        if (f >= 5 && f % 3 === 0) W.scene.terrainMaterials = W.scene.terrainMaterials.slice(1);   // the LRU evicts
        pushTime(W, A);
        if (f < 5) pushCloud(W, A);                                       // then the player goes indoors
      }
      compare(worlds[0][0], worlds[1][0], `[8] f${f}`);
    }
    assert(!firstDiff, firstDiff);
    const st = SH.terrainSharedStats().cloud;
    const R = new Set(worlds[1][0].scene.terrainMaterials);
    assert(st.idleSweeps > sweeps0, "no idle sweep ran");
    for (const g of st.groups) assert(g.bound <= R.size, `${g.names}: ${g.bound} bound > ${R.size} resident`);
    assert(SH.verifySharedTerrain().length === 0, SH.verifySharedTerrain()[0]);
  });
}

// ── [6] default off ─────────────────────────────────────────────────────────
if (IDENTITY) {
  const { __setRustFlagForTest, rustFlag } = await import("../scene3d/rust/scene_core.js");
  __setRustFlagForTest("hotTerrainShared", undefined);
  check("[6] ?hotTerrainShared defaults OFF (rustFlag reader, no query)", () => assert(rustFlag("hotTerrainShared", false) === false, "default must be off"));
}

// ── bench: one arm per process (min of 5 rounds) ────────────────────────────
if (!IDENTITY) {
  const A = BENCH_ARM === "on" ? GEN : REF;
  A.loop.__setHotTerrainTimeForTest(true);   // lane F's flags are DEFAULT ON now: the baseline includes them
  A.cv.__setHotCloudPushForTest(true);
  const W = makeWorld(A);
  W.cloud = { _cloudNight: { enabled: true, directFactor: 1 }, effect: { cloudsPass: { shadowBuffer: TEX[0] } },
    material: { uniforms: { shadowMatrices: { value: [W.src] } } } };
  W.epoch = 1;
  // ~541 materials: 3/4 per-LB literals, a quarter batch-style clones (dictionary-mode maps)
  for (let i = 0; i < 541; i++) W.scene.terrainMaterials.push(makeMaterial(W, i % 4 === 3 ? "batch" : "lb", { pl: 1, ox: i % 23, oy: i % 29, from: i ? i - 1 : null }));
  W.scene.skyLightingController._lastState = { dirHeading: 40, dirPitch: 35, dirBright: 0.8, dirColorArgb: 0xfff0e0d0, ambBright: 0.3, ambColorArgb: 0xff6480c0 };
  const frame = (i) => {
    W.scene.frameTime.tsSec = 1000 + i * 0.016;
    W.scene.skyLightingController._tickCount = i;
    W.src.elements[3] = i;
    A.loop.__tickTerrainUTimeForTest(W.scene);
    A.loop.tickTerrainSunDir(W.scene, lightTickFor(W), ENV);
    window.liveScene3d = W.scene;
    A.cv.CloudVolume.prototype._pushCloudShadowsToTerrain.call(W.cloud);
  };
  for (let i = 0; i < 3000; i++) frame(i);
  const best = { all: Infinity };
  for (let round = 0; round < 5; round++) {
    const N = 4000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) frame(i);
    best.all = Math.min(best.all, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  // registry churn: one bake + one evict every 10 frames (the field's change rate is lower)
  let churn = Infinity;
  for (let round = 0; round < 5; round++) {
    const N = 2000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      if (i % 10 === 0) {
        const R = W.scene.terrainMaterials;
        R.push(makeMaterial(W, "lb", { pl: 1, ox: 1, oy: 1, from: null }));
        W.scene.terrainMaterials = R.filter((m, j) => j !== 3);
      }
      frame(i);
    }
    churn = Math.min(churn, Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  console.log(`  bench ${BENCH_ARM === "on" ? "?hotTerrainShared=on " : "shipped (lane F on)"}: time+sun+cloud pushes ${best.all.toFixed(2)} us/frame, ` +
    `with a bake+evict every 10th frame ${churn.toFixed(2)} us/frame (${W.scene.terrainMaterials.length} materials)`);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
