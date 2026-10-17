// tests/clouds_boot_order.test.mjs
//
// `?cloudsBootOrder` (2026-10-17, DEFAULT "legacy", `=off|0|false|no` escape;
// scene3d/cloud_overlay.js cloudsBootOrder / primeLegacyMarch, called first
// thing in atmosphere_pipeline.js createAtmospherePipeline).
//
// The 1070 A/B found the open sky bimodal per session (log and reversed-Z
// alike): BRIGHT exactly when the CloudsEffect's first raymarch ran on the
// overlay's legacy private composer before the main pass adopted it (8/9),
// DARK when the pipeline was built first (1/9). This suite runs the REAL
// CloudOverlay, takram CloudsEffect, pmndrs composer, atmosphere pipeline and
// three r184 renderer over tests/helpers/fake_webgl2.mjs:
//
//   B1  flag reader: default legacy, prime / main, the off-forms, garbage.
//   B2  default, pipeline built before any sky frame (the would-be DARK boot):
//       the pipeline primes ONE legacy march before its composer exists, then
//       adoption retires the private composer — legacy-first, like 8/9.
//   B3  default, sky drew first (legacy-first already): no prime, as today.
//   B4  `main`: legacy marches suppressed, no prime — always main-first.
//       `prime`: legacy suppressed, the prime always runs. `off`: today's race.
//       `?cloudsMainPass=off`: nothing suppressed.
//   B5  every order feeds the cloud draws the same GL inputs (uniform values,
//       sampler bindings, texture parameters / storage, render targets, draw
//       buffers) — the replica result: what makes the bright/dark difference
//       is not in this JS/GL state, hence a deterministic order.
//
// Run: node tests/clouds_boot_order.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
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
// takram's setArrayRenderTargetLayers asserts a real WebGL2 context.
globalThis.WebGL2RenderingContext = class { static [Symbol.hasInstance](x) { return !!(x && x.__isFakeGL); } };

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { CloudOverlay, cloudsBootOrder } = await import("../scene3d/cloud_overlay.js");
const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- B1 ?cloudsBootOrder reader ---------------------------------------");
check("absent / empty / garbage -> legacy",
  cloudsBootOrder("") === "legacy" && cloudsBootOrder("?cloudsBootOrder=") === "legacy" &&
  cloudsBootOrder("?cloudsBootOrder=banana") === "legacy" && cloudsBootOrder("?cloudsBootOrder=legacy") === "legacy");
check("prime / main (case-insensitive)",
  cloudsBootOrder("?cloudsBootOrder=prime") === "prime" && cloudsBootOrder("?cloudsBootOrder=MAIN") === "main");
check("off / 0 / false / no -> race (today's behaviour)",
  ["off", "0", "false", "no", "OFF", "No"].every((x) => cloudsBootOrder(`?cloudsBootOrder=${x}`) === "race"));

// ---------------------------------------------------------------------------
// A session over the fake GL. Noise: synthetic prebaked textures, assigned on
// demand (the real loader fetches assets).
function synthNoise(effect) {
  const d3 = (n) => { const t = new THREE.Data3DTexture(new Uint8Array(n * n * n).fill(128), n, n, n); t.format = THREE.RedFormat; t.needsUpdate = true; return t; };
  const d2 = (n) => { const t = new THREE.DataTexture(new Uint8Array(n * n * 4).fill(100), n, n); t.needsUpdate = true; return t; };
  effect.localWeatherTexture = d2(8);
  effect.turbulenceTexture = d2(8);
  effect.shapeTexture = d3(4);
  effect.shapeDetailTexture = d3(4);
  effect.stbnTexture = d3(4);
}
CloudOverlay.prototype._loadPrebakedNoise = function () {
  synthNoise(this.volume.effect);
  this._prebakedLoaded = true;
  return Promise.resolve();
};

// The eye-test URL's frozen drift: with drift on, the weather / shape offsets
// advance per march and differ by the number of marches, not by the order.
const BASE = "?cloudDrift=0&cloudShadow=off";
function session(search, { skyFirst = 0, frames = 20 } = {}) {
  window.location.search = BASE + (search ? "&" + search.replace(/^\?/, "") : "");
  const raw = createFakeWebGL2({ maxTextures: 16, maxCombined: 32, width: 800, height: 600 });
  // Outputs per draw (FBO colour attachments x draw buffers) — the fake does not track them.
  const fbos = new Map(); let drawFbo = null; const outLog = [];
  const fb = (f) => { if (!fbos.has(f)) fbos.set(f, { att: {}, db: null }); return fbos.get(f); };
  const outs = () => {
    if (!drawFbo) return "screen";
    const s = fb(drawFbo); const db = s.db ?? [raw.COLOR_ATTACHMENT0];
    return db.map((b) => (b === 0 ? "NONE" : s.att[b] ?? "?")).join(",");
  };
  const over = {
    __isFakeGL: true,
    bindFramebuffer(t, f) { if (t !== raw.READ_FRAMEBUFFER) drawFbo = f || null; return raw.bindFramebuffer(t, f); },
    framebufferTexture2D(t, a, tt, tex, l) { if (drawFbo) fb(drawFbo).att[a] = tex ? `tex#${tex.__id}` : null; return raw.framebufferTexture2D(t, a, tt, tex, l); },
    framebufferTextureLayer(t, a, tex, l, layer) { if (drawFbo) fb(drawFbo).att[a] = tex ? `tex#${tex.__id}@${layer}` : null; return raw.framebufferTextureLayer(t, a, tex, l, layer); },
    drawBuffers(list) { if (drawFbo) fb(drawFbo).db = Array.from(list); return raw.drawBuffers(list); },
    drawArrays(...a) { outLog.push(outs()); return raw.drawArrays(...a); },
    drawElements(...a) { outLog.push(outs()); return raw.drawElements(...a); },
  };
  const gl = new Proxy(raw, { get(t, p) { return p in over ? over[p] : t[p]; } });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, 800, 600), context: gl });
  renderer.setSize(800, 600, false);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 5000);
  camera.position.set(100, 60, -200);
  camera.lookAt(150, 400, -900);
  camera.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial()));
  const skyScene = new THREE.Scene();
  const skyCamera = new THREE.PerspectiveCamera(60, 800 / 600, 1, 1e6);
  const overlay = new CloudOverlay({ camera });
  overlay.attachToSkyScene(skyScene);
  // The pre-pipeline frames: what SkyDome.renderSkyPass does (legacy path).
  const legacyComposers = [];
  for (let i = 0; i < skyFirst; i++) {
    overlay.preRender(renderer, 1 / 60, camera);
    legacyComposers.push(overlay.composer);
    renderer.setRenderTarget(null);
    renderer.render(skyScene, skyCamera);
    overlay.renderOverlay(renderer);
  }
  const marchedBeforePipeline = overlay._diagStamps.firstMarch !== null;
  const composerBeforePipeline = overlay.composer;
  const pipe = createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera, width: 800, height: 600,
  });
  const frame = () => {
    pipe.preFrameSkySync({ _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} }, camera);
    overlay.preRender(renderer, 1 / 60, camera);
    pipe.render(camera, 1 / 60);
    overlay.renderOverlay(renderer);
  };
  for (let i = 0; i < frames; i++) frame();
  // One recorded frame: the cloud draws' inputs and outputs, textures named.
  const effect = overlay.volume.effect;
  const cp = effect.cloudsPass, sp = effect.shadowPass;
  const names = new Map();
  const nameTex = (t, n) => { const p = t && renderer.properties.get(t); if (p && p.__webglTexture) names.set(`tex#${p.__webglTexture.__id}`, n); };
  for (const [k, rt] of Object.entries({ cCur: cp.currentRenderTarget, cRes: cp.resolveRenderTarget, cHist: cp.historyRenderTarget, sCur: sp.currentRenderTarget, sRes: sp.resolveRenderTarget, sHist: sp.historyRenderTarget })) {
    if (rt) rt.textures.forEach((t, i) => nameTex(t, `${k}[${i}]`));
  }
  for (const [k, u] of Object.entries(cp.currentMaterial.uniforms)) if (u.value && u.value.isTexture) nameTex(u.value, k);
  const progs = new Map();
  for (const [n, m] of Object.entries({ clouds: cp.currentMaterial, cloudsResolve: cp.resolveMaterial, shadow: sp.currentMaterial, shadowResolve: sp.resolveMaterial })) {
    const p = renderer.properties.get(m).currentProgram;
    if (p) progs.set(p.program.__id, n);
  }
  const rename = (x) => (typeof x === "string" ? x.replace(/tex#\d+/g, (t) => names.get(t) ?? "anon") : Array.isArray(x) ? x.map(rename) : x);
  raw.__fake.startSnapshots();
  outLog.length = 0;
  frame();
  const snaps = raw.__fake.takeSnapshots();
  const FRAME_DEPENDENT = /frame|jitter|Jitter|eprojection|inverseProjectionMatrix/;
  const draws = snaps.map((s, i) => ({ s, out: outLog[i] }))
    .filter(({ s }) => progs.has(s.program))
    .map(({ s, out }) => ({
      prog: progs.get(s.program),
      out: rename(out),
      uniforms: JSON.stringify(Object.entries(s.uniforms).filter(([k]) => !FRAME_DEPENDENT.test(k)).map(([k, x]) => [k, rename(x)])),
    }));
  return { overlay, pipe, draws, marchedBeforePipeline, composerBeforePipeline, legacyComposers, effect };
}

// ---------------------------------------------------------------------------
console.log("\n-- B2 default, pipeline first (the would-be DARK boot) ----------------");
const primed = session("");
{
  const t = primed.overlay._diagStamps;
  check("no legacy march before the pipeline (the race's DARK precondition)", primed.marchedBeforePipeline === false);
  check("the pipeline primed one legacy march, then adopted (legacy-first)",
    t.primed !== null && t.firstMarch !== null && t.adopted !== null && t.firstMarch <= t.adopted && t.primed <= t.adopted,
    JSON.stringify(t));
  check("adoption retired the prime's private composer; the main pass owns the clouds",
    primed.overlay.composer === null && primed.overlay.mainPassActive === true && primed.pipe.cloudsMainPass === true);
  check("the clouds march every main frame after it (frame = 1 prime + 21 main)", primed.effect.frame === 22, `frame ${primed.effect.frame}`);
  check("a second prime is a no-op", primed.overlay.primeLegacyMarch(null, null) === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- B3 default, sky drew first (legacy-first already) ----------------");
const legacy = session("", { skyFirst: 3 });
{
  const t = legacy.overlay._diagStamps;
  check("legacy frames marched before the pipeline existed",
    legacy.marchedBeforePipeline === true && legacy.composerBeforePipeline !== null);
  check("no prime (it already had its legacy first march)", t.primed === null && t.firstMarch <= t.adopted, JSON.stringify(t));
  check("the same private composer for every legacy frame, retired at adoption",
    legacy.legacyComposers.every((c) => c === legacy.legacyComposers[0]) && legacy.overlay.composer === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- B4 main / prime / off / no main pass ----------------------------");
const mainOrder = session("?cloudsBootOrder=main", { skyFirst: 3 });
{
  const t = mainOrder.overlay._diagStamps;
  check("main: legacy frames suppressed (no private composer, no march before the pipeline)",
    mainOrder.marchedBeforePipeline === false && mainOrder.composerBeforePipeline == null);
  check("main: no prime, the first march is in the main pass", t.primed === null && t.firstMarch >= t.adopted, JSON.stringify(t));
}
const primeOrder = session("?cloudsBootOrder=prime", { skyFirst: 3 });
{
  const t = primeOrder.overlay._diagStamps;
  check("prime: legacy frames suppressed, the prime always runs before adoption",
    primeOrder.marchedBeforePipeline === false && t.primed !== null && t.firstMarch <= t.adopted, JSON.stringify(t));
}
const race = session("?cloudsBootOrder=off");
{
  const t = race.overlay._diagStamps;
  check("off: today's race — pipeline first means main-first, no prime",
    t.primed === null && t.firstMarch >= t.adopted, JSON.stringify(t));
}
{
  window.location.search = "?cloudsBootOrder=main&cloudsMainPass=off";
  const camera = new THREE.PerspectiveCamera();
  const o = new CloudOverlay({ camera, proceduralTextures: true });
  check("?cloudsMainPass=off: nothing suppressed (the legacy path is the only path)", o._suppressLegacy === false);
  window.location.search = "";
}

// ---------------------------------------------------------------------------
console.log("\n-- B5 the cloud draws see the same GL inputs in every order ----------");
{
  const same = (a, b) => a.draws.length === b.draws.length && a.draws.every((d, i) =>
    d.prog === b.draws[i].prog && d.out === b.draws[i].out && d.uniforms === b.draws[i].uniforms);
  check("four cloud draws per frame (shadow, shadow resolve, march, resolve)",
    primed.draws.map((d) => d.prog).join(" ") === "shadow shadowResolve clouds cloudsResolve",
    primed.draws.map((d) => d.prog).join(" "));
  check("primed == natural legacy-first (inputs, bindings, outputs)", same(primed, legacy));
  check("legacy-first == main-first at the GL-input level (the difference is not in this state)",
    same(legacy, mainOrder) && same(legacy, race));
}

// ---------------------------------------------------------------------------
console.log("\n-- B6 wiring ---------------------------------------------------------");
{
  const ap = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  const primeAt = ap.indexOf("bootOverlay.primeLegacyMarch(renderer, camera)");
  const composerAt = ap.indexOf("const composer = new ComposerClass(renderer, {");
  check("createAtmospherePipeline primes before it builds its composer", primeAt > 0 && composerAt > primeAt);
  const doc = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  check("docs/url-flags.md: cloudsBootOrder row", /^\| `cloudsBootOrder` \|/m.test(doc));
  const h = readFileSync(path.join(APP, "harness", "run-js-headless.mjs"), "utf8");
  check("harness registers this suite as tier 5",
    /\{ tier: 5, flag: "cloudsBootOrder", file: "tests\/clouds_boot_order\.test\.mjs" \}/.test(h));
}

console.log(`\nclouds boot order: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
