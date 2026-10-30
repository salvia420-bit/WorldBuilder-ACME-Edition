// tests/skip_empty_passes.test.mjs — `?skipEmptyPasses` (round 3 R3-2,
// 2026-10-30, DEFAULT OFF, `=on` opt-in).
//
// On an `?indoorLandscapeGate` skip frame the world RenderPass renders the main
// scene with camera layer mask 0: it draws nothing, yet three walks the whole
// graph (updateMatrixWorld + projectObject) and flips the light state. Armed,
// that one render draws a private EMPTY scene with the same camera and target
// instead (scene3d/skip_empty_passes.js).
//
//   E1  flag reader: absent ⇒ OFF; `=on` ⇒ ON; `=off` ⇒ OFF.
//   E2  predicate: only mask 0 is skippable; a background, custom scene
//       hooks, a non-Scene, XR presenting or an ArrayCamera refuse.
//   E3  REAL atmosphere pipeline + three r184 over tests/helpers/fake_webgl2:
//       with no skip frame, the armed client's GL stream is call-for-call the
//       flag-off stream (identical GL stream when nothing is skipped).
//   E4  same, with landscape-skip frames: (a) every flag-off mask-0 world
//       render issued ZERO draw calls (the skipped pass truly had nothing to
//       draw); (b) armed, the main scene is never rendered with mask 0 — the
//       stand-in is, exactly once per skip frame — and the main scene's
//       matrix walk runs once fewer per skip frame; (c) every draw of every
//       frame sees the same program + uniforms + textures + target as off,
//       and the full GL stream is identical.
//   E5  refusals at the pass: a scene background keeps the real render.
//   E6  wiring: the pipeline installs only behind the flag; the module import
//       has no side effects.
//
// Run from apps/holtburger-web/:  node tests/skip_empty_passes.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
// index.html's import map, mirrored for node (atmosphere_pipeline.js).
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
window.location = { search: "" };
window.innerWidth = 800;
window.innerHeight = 600;
globalThis.location = window.location;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
globalThis.WebGL2RenderingContext = class { static [Symbol.hasInstance](x) { return !!(x && x.__isFakeGL); } };

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { __setRustFlagForTest } = await import("../scene3d/rust/scene_core.js");
const SEP = await import("../scene3d/skip_empty_passes.js");
const E6_GLOBAL_AFTER_IMPORT = Object.prototype.hasOwnProperty.call(window, "__skipEmptyPasses");
const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- E1 flag reader ------------------------------------------------------");
{
  const read = (search) => {
    window.location.search = search;
    __setRustFlagForTest("skipEmptyPasses", undefined);
    const on = SEP.skipEmptyPassesEnabled();
    __setRustFlagForTest("skipEmptyPasses", undefined);
    return on;
  };
  check("absent ⇒ off", read("") === false && read("?x=1") === false);
  check("=on / =1 / =true ⇒ on", read("?skipEmptyPasses=on") && read("?skipEmptyPasses=1") && read("?skipEmptyPasses=true"));
  check("=off / garbage ⇒ off", !read("?skipEmptyPasses=off") && !read("?skipEmptyPasses=banana"));
  window.location.search = "";
}

// ---------------------------------------------------------------------------
console.log("-- E2 predicate --------------------------------------------------------");
{
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  const r = { xr: { enabled: false, isPresenting: false } };
  cam.layers.mask = 0;
  check("mask 0, plain scene ⇒ skippable", SEP.emptyRenderRefusal(r, scene, cam) === null);
  for (const m of [1, 2, 3, 0xffffffff]) {
    cam.layers.mask = m;
    check(`mask ${m} ⇒ refused (layers)`, SEP.emptyRenderRefusal(r, scene, cam) === "layers");
  }
  cam.layers.mask = 0;
  scene.background = new THREE.Color(0x102030);
  check("Color background ⇒ refused", SEP.emptyRenderRefusal(r, scene, cam) === "background");
  scene.background = new THREE.Texture();
  check("Texture background ⇒ refused", SEP.emptyRenderRefusal(r, scene, cam) === "background");
  scene.background = null;
  scene.onBeforeRender = () => {};
  check("custom onBeforeRender ⇒ refused", SEP.emptyRenderRefusal(r, scene, cam) === "hooks");
  delete scene.onBeforeRender;
  scene.onAfterRender = () => {};
  check("custom onAfterRender ⇒ refused", SEP.emptyRenderRefusal(r, scene, cam) === "hooks");
  delete scene.onAfterRender;
  check("a Group is not a Scene ⇒ refused", SEP.emptyRenderRefusal(r, new THREE.Group(), cam) === "scene");
  check("XR presenting ⇒ refused",
    SEP.emptyRenderRefusal({ xr: { enabled: true, isPresenting: true } }, scene, cam) === "xr");
  const arr = new THREE.ArrayCamera([]);
  arr.layers.mask = 0;
  check("ArrayCamera ⇒ refused", SEP.emptyRenderRefusal(r, scene, arr) === "camera");
  check("back to skippable", SEP.emptyRenderRefusal(r, scene, cam) === null);
}

// ---------------------------------------------------------------------------
// A real pipeline session over the fake GL. Every GL call at the bottom of the
// context is serialised (objects by id, typed arrays / long strings hashed).
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function ser(x) {
  if (x === null || x === undefined) return String(x);
  const t = typeof x;
  if (t === "number" || t === "boolean") return String(x);
  if (t === "string") return x.length > 64 ? `s${x.length}:${fnv(x)}` : JSON.stringify(x);
  if (ArrayBuffer.isView(x)) {
    const a = Array.from(x.length > 4096 ? x.subarray(0, 4096) : x).join(",");
    return `${x.constructor.name}[${x.length}]:${fnv(a)}`;
  }
  if (Array.isArray(x)) return `[${x.map(ser).join(",")}]`;
  if (x && typeof x.__id === "number") return `#${x.__kind}${x.__id}`;
  if (t === "object") return `{${Object.keys(x).sort().map((k) => `${k}:${ser(x[k])}`).join(",")}}`;
  return t;
}

function deterministic() {
  let seed = 12345;
  Math.random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  let now = 1000;
  Object.defineProperty(globalThis.performance, "now", { value: () => (now += 0.25), configurable: true, writable: true });
}
const DRAWS = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced",
  "drawRangeElements", "multiDrawArraysWEBGL", "multiDrawElementsWEBGL",
  "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"]);

function session(armed, { background = null, msaa = 2 } = {}) {
  deterministic();
  window.location.search = "";
  __setRustFlagForTest("skipEmptyPasses", armed);
  SEP.__resetSkipEmptyPassesStatsForTest();
  const log = [];
  let draws = 0;
  const raw = createFakeWebGL2({
    maxTextures: 16, maxCombined: 32, width: 800, height: 600,
    onCall(name, args) {
      if (DRAWS.has(name)) draws++;
      log.push(name + "(" + Array.prototype.map.call(args, ser).join(",") + ")");
    },
  });
  const gl = new Proxy(raw, { get(t, p) { return p === "__isFakeGL" ? true : t[p]; } });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, 800, 600), context: gl });
  renderer.setSize(800, 600, false);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
  camera.layers.enable(1);
  camera.position.set(0, 2, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  scene.background = background;
  // Layer 0: terrain-like lit mesh. Layer 1: a lit cell wall + an entity part.
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, 4, 4), new THREE.MeshStandardMaterial({ color: 0x55aa55 }));
  terrain.rotation.x = -Math.PI / 2;
  scene.add(terrain);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2), new THREE.MeshStandardMaterial({ color: 0xaa8866 }));
  wall.layers.set(1);
  wall.position.set(0, 1.5, -2);
  scene.add(wall);
  const part = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.5), new THREE.MeshLambertMaterial({ color: 0x8888ff }));
  part.layers.set(1);
  part.position.set(1, 0.9, 0);
  scene.add(part);
  // Lights on layer 0 AND 1, as atmosphere_lights.js does.
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(10, 20, 5);
  sun.layers.enable(1);
  const amb = new THREE.AmbientLight(0x404050, 1);
  amb.layers.enable(1);
  scene.add(sun, amb);
  let worldWalks = 0;
  const umw = scene.updateMatrixWorld;
  scene.updateMatrixWorld = function (force) { worldWalks++; return umw.call(this, force); };
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x223355 })));
  const skyCamera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1e6);
  const pipe = createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, skyScene, skyCamera, width: 800, height: 600,
    // index.js `_msaaSamples` (2 on the default presets) + `?msaaWorldOnly` (default on).
    msaa,
  });
  // Which scene / mask each renderer.render() drew, and the draws inside each.
  const renders = [];
  const render0 = renderer.render;
  renderer.render = function (sc, cam) {
    const d0 = draws;
    const rec = { scene: sc === scene ? "main" : sc === skyScene ? "sky" : sc === SEP.skipEmptyStandInScene() ? "standIn" : "other",
      mask: cam?.layers?.mask, draws: 0 };
    renders.push(rec);
    try { return render0.call(this, sc, cam); } finally { rec.draws = draws - d0; }
  };
  const outdoorDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
  const indoorDome = { _lastIsIndoor: true, _lastSkyBlocked: false, syncSkyCamera() {} };
  const frame = (kind) => {
    if (kind === "outdoor") { pipe.setIndoorSplitArmed(false); pipe.setIndoorLandscapeSkip(false); }
    else if (kind === "split") { pipe.setIndoorSplitArmed(true); pipe.setIndoorLandscapeSkip(false); }
    else if (kind === "skip") { pipe.setIndoorSplitArmed(true); pipe.setIndoorLandscapeSkip(true); }
    const dome = kind === "outdoor" ? outdoorDome : indoorDome;
    log.length = 0;
    renders.length = 0;
    const w0 = worldWalks;
    pipe.preFrameSkySync(dome, camera);
    pipe.render(camera, 1 / 60);
    // The cells pass's lit material: its light-state version (bumped whenever
    // the main scene's light COUNT changes between two renders).
    const lsv = renderer.properties.get(wall.material).lightsStateVersion;
    return { kind, log: log.slice(), renders: renders.map((r) => ({ ...r })), walks: worldWalks - w0, lsv };
  };
  return { pipe, frame, scene, renderer, stats: () => ({ ...SEP.SKIP_EMPTY_PASSES_STATS }) };
}

function runSeq(armed, seq, opts) {
  const s = session(armed, opts);
  const frames = seq.map((k) => s.frame(k));
  const out = { frames, stats: s.stats(), pipe: s.pipe };
  __setRustFlagForTest("skipEmptyPasses", undefined);
  return out;
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `#${i}: off=${a[i]} on=${b[i]}`;
  return null;
}

// ---------------------------------------------------------------------------
console.log("-- E3 nothing skipped ⇒ identical GL stream ----------------------------");
{
  const SEQ = ["outdoor", "outdoor", "split", "split", "outdoor", "split"];
  const off = runSeq(false, SEQ);
  const on = runSeq(true, SEQ);
  check("flag off never installs", off.stats.installed === 0 && off.stats.renders === 0);
  check("armed installs on the world pass once", on.stats.installed === 1);
  check("armed: hooked renders seen, none skipped (no mask-0 frame)",
    on.stats.renders === SEQ.length && on.stats.skipped === 0, JSON.stringify(on.stats));
  let same = true; let why = "";
  for (let i = 0; i < SEQ.length; i++) {
    const d = firstDiff(off.frames[i].log, on.frames[i].log);
    if (d) { same = false; why = `frame ${i} (${SEQ[i]}) ${d}`; break; }
  }
  check("every frame's GL stream is call-for-call identical", same, why);
  check("the frames issue GL work (non-vacuous)", off.frames.every((f) => f.log.length > 50),
    off.frames.map((f) => f.log.length).join(","));
  check("main-scene matrix walks identical", off.frames.every((f, i) => f.walks === on.frames[i].walks));
}

// ---------------------------------------------------------------------------
for (const msaa of [2, 0]) {
console.log(`-- E4 landscape-skip frames (msaa ${msaa}) ---------------------------------`);
  const SEQ = ["outdoor", "split", "skip", "skip", "skip", "outdoor", "skip", "split", "skip", "skip"];
  const nSkip = SEQ.filter((k) => k === "skip").length;
  const off = runSeq(false, SEQ, { msaa });
  const on = runSeq(true, SEQ, { msaa });
  if (msaa > 0) {
    // The empty world render resolves the multisampled world target: the stand-in must too.
    const blits = off.frames.map((f) => f.log.filter((c) => c.startsWith("blitFramebuffer(")).length);
    check("fixture: skip frames run the MSAA resolve blits (world target multisampled)",
      off.frames.every((f, i) => f.kind !== "skip" || blits[i] >= 2), blits.join(","));
  }
  // (a) the flag-off mask-0 world renders drew nothing.
  const offEmpty = off.frames.flatMap((f) => f.renders.filter((r) => r.scene === "main" && r.mask === 0));
  check("off: one mask-0 main-scene render per skip frame", offEmpty.length === nSkip, String(offEmpty.length));
  check("off: every mask-0 main-scene render issued ZERO draw calls", offEmpty.every((r) => r.draws === 0),
    JSON.stringify(offEmpty));
  const offCells = off.frames.flatMap((f) => (f.kind === "skip" ? f.renders.filter((r) => r.scene === "main" && r.mask === 2) : []));
  check("off: the cells pass of a skip frame draws (fixture is non-vacuous)",
    offCells.length === nSkip && offCells.every((r) => r.draws > 0), JSON.stringify(offCells));
  // (b) armed: the main scene is never rendered with mask 0; the stand-in is.
  const onMain0 = on.frames.flatMap((f) => f.renders.filter((r) => r.scene === "main" && r.mask === 0));
  const onStand = on.frames.flatMap((f) => f.renders.filter((r) => r.scene === "standIn"));
  check("on: no mask-0 render of the main scene", onMain0.length === 0, JSON.stringify(onMain0));
  check("on: the empty stand-in renders exactly once per skip frame, with mask 0, drawing nothing",
    onStand.length === nSkip && onStand.every((r) => r.mask === 0 && r.draws === 0), JSON.stringify(onStand));
  check("on: stats count exactly the skip frames", on.stats.skipped === nSkip && on.stats.renders === SEQ.length,
    JSON.stringify(on.stats));
  check("on: non-skip frames render the main scene exactly as off",
    on.frames.every((f, i) => f.kind === "skip" ||
      JSON.stringify(f.renders) === JSON.stringify(off.frames[i].renders)));
  check("on: skip frames keep every other render (sky off, cells mask 2) in order",
    on.frames.every((f, i) => f.kind !== "skip" ||
      JSON.stringify(f.renders.map((r) => (r.scene === "standIn" ? { ...r, scene: "main" } : r))) ===
        JSON.stringify(off.frames[i].renders)));
  const walkDelta = off.frames.map((f, i) => f.walks - on.frames[i].walks);
  check("on: one main-scene matrix walk fewer per skip frame, none elsewhere",
    walkDelta.every((d, i) => d === (SEQ[i] === "skip" ? 1 : 0)), walkDelta.join(","));
  // The second saving: no light-state flip. Off, every skip frame renders the
  // main scene with 0 lights then N, so the lit cells-pass material sees a new
  // light-state version each skip frame (getProgram re-run); armed, the
  // version stays put across consecutive skip frames.
  const runs = (r) => SEQ.map((k, i) => (k === "skip" && SEQ[i - 1] === "skip" ? r.frames[i].lsv !== r.frames[i - 1].lsv : null))
    .filter((x) => x !== null);
  check("off: the lit cells-pass material's light-state version changes every consecutive skip frame",
    runs(off).length > 0 && runs(off).every((x) => x === true), JSON.stringify(off.frames.map((f) => f.lsv)));
  check("on: …and stays put (no light-state flip, no getProgram re-run)",
    runs(on).length > 0 && runs(on).every((x) => x === false), JSON.stringify(on.frames.map((f) => f.lsv)));
  // (c) the GL stream.
  let same = true; let why = "";
  for (let i = 0; i < SEQ.length; i++) {
    const d = firstDiff(off.frames[i].log, on.frames[i].log);
    if (d) { same = false; why = `frame ${i} (${SEQ[i]}) ${d}`; break; }
  }
  check("every frame's GL stream (incl. skip frames) is call-for-call identical", same, why);
  const offDraws = off.frames.map((f) => f.log.filter((c) => DRAWS.has(c.slice(0, c.indexOf("(")))).length);
  check("skip frames still draw (cells + post)", off.frames.every((f, i) => f.kind !== "skip" || offDraws[i] > 0),
    offDraws.join(","));
}

// ---------------------------------------------------------------------------
console.log("-- E5 refusal at the pass ---------------------------------------------");
{
  const SEQ = ["skip", "skip"];
  const on = runSeq(true, SEQ, { background: new THREE.Color(0x000000) });
  const main0 = on.frames.flatMap((f) => f.renders.filter((r) => r.scene === "main" && r.mask === 0));
  check("a scene background keeps the real mask-0 render", main0.length === SEQ.length && on.stats.skipped === 0,
    JSON.stringify(on.stats));
  check("…and is counted as a background refusal", on.stats.refusedBackground === SEQ.length);
}

// ---------------------------------------------------------------------------
console.log("-- E6 wiring ---------------------------------------------------------");
{
  check("importing the module creates no window diag", E6_GLOBAL_AFTER_IMPORT === false);
  const PIPE = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  check("pipeline installs only behind the flag",
    /if \(skipEmptyPassesEnabled\(\)\) installSkipEmptyRenderPass\(worldRenderPass\);/.test(PIPE));
  check("the world RenderPass is never disabled (indoor_landscape_gate L8)", !/worldRenderPass\.enabled\s*=/.test(PIPE));
  const MOD = readFileSync(path.join(APP, "scene3d", "skip_empty_passes.js"), "utf8");
  check("module reads the flag through rustFlag, default off", /rustFlag\("skipEmptyPasses", false\)/.test(MOD));
  check("no top-level THREE construction in the module",
    !/^(const|let|var)\s+\w+\s*=\s*new THREE\./m.test(MOD));
}

console.log(`\nskip_empty_passes: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
