// tests/clouds_boot_order.test.mjs
//
// The clouds' boot and the storm/fair look (2026-10-17).
//
// The 1070 A/B (Holtburg pinned) split the open sky per session. The live
// follow-up found the switch: under a storm DayGroup, a session whose first
// raymarch ran on the overlay's legacy private composer before the main pass
// adopted the effect rendered the FAIR sky although cloud_volume's
// `_stormLookApplied` said storm, while a storm toggled after boot rendered
// correctly — an edge applied before adoption did not survive it and never
// fired again. Fix (scene3d/cloud_volume.js tick): adoption / release
// invalidate the edge so the next tick re-applies the look, and a tick whose
// layers no longer carry the applied look writes it again. `?cloudsBootOrder`
// stays as an off-by-default debug knob (cloud_overlay.js cloudsBootOrder /
// primeLegacyMarch).
//
// Runs the REAL CloudOverlay, takram CloudsEffect, pmndrs composer, atmosphere
// pipeline and three r184 renderer over tests/helpers/fake_webgl2.mjs:
//
//   B1  `?cloudsBootOrder` reader: default off; legacy / prime / main.
//   B2  default boots: nothing pinned — pipeline-first stays main-first, sky-
//       first stays legacy-first (no prime).
//   B3  the debug values: legacy primes a would-be main-first boot, prime
//       always primes, main suppresses legacy frames; inert without the main
//       pass.
//   B4  is_storm at boot, both boot orders: the clouds material's layer
//       uniforms AND what the clouds program holds at its draw are the storm
//       look's values; the look is re-applied after adoption.
//   B5  storm edge at runtime (fair -> storm -> fair) still drives the GPU.
//   B6  layers reset behind the look's back (same flag) -> re-applied
//       (driftReapplies); coverage / haze knobs are not fought.
//   B7  every boot order feeds the cloud draws the same GL inputs.
//   B8  wiring (pipeline call site, docs row, harness registration).
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
const LOOK = await import("../scene3d/cloud_storm_look.js");
const WX = await import("../scene3d/weather_state.js");
const { CloudLayers } = await import("@takram/three-clouds");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- B1 ?cloudsBootOrder reader (debug knob) ---------------------------");
check("absent / empty / garbage / off-forms -> off",
  ["", "?cloudsBootOrder=", "?cloudsBootOrder=banana", "?cloudsBootOrder=off", "?cloudsBootOrder=0",
    "?cloudsBootOrder=false", "?cloudsBootOrder=no"].every((s) => cloudsBootOrder(s) === "off"));
check("legacy / prime / main (case-insensitive)",
  cloudsBootOrder("?cloudsBootOrder=legacy") === "legacy" && cloudsBootOrder("?cloudsBootOrder=Prime") === "prime" &&
  cloudsBootOrder("?cloudsBootOrder=MAIN") === "main");

// ---------------------------------------------------------------------------
// A session over the fake GL. Noise: synthetic prebaked textures (the real
// loader fetches assets). Weather: weather_state's override (= __setWeather).
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
// A noon SkyState (what SkyDome.tick hands CloudOverlay.tick).
const SKY = { dirHeading: 180, dirPitch: 60, dirBright: 1, dirColorArgb: 0xffffffff, ambColorArgb: 0xff8090c0, fogMax: 3000 };

// The eye-test URL's frozen drift: with drift on, the weather / shape offsets
// advance per march and differ by the number of marches, not by the order.
const BASE = "?cloudDrift=0&cloudShadow=off";
function session(search, { skyFirst = 0, frames = 20, storm = false } = {}) {
  window.location.search = BASE + (search ? "&" + search.replace(/^\?/, "") : "");
  WX.setWeatherOverride({ is_storm: storm });
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
  // The pre-pipeline frames: SkyDome.tick + SkyDome.renderSkyPass (legacy path).
  const legacyComposers = [];
  for (let i = 0; i < skyFirst; i++) {
    overlay.tick(SKY);
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
    overlay.tick(SKY);
    pipe.preFrameSkySync({ _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} }, camera);
    overlay.preRender(renderer, 1 / 60, camera);
    pipe.render(camera, 1 / 60);
    overlay.renderOverlay(renderer);
  };
  for (let i = 0; i < frames; i++) frame();
  const effect = overlay.volume.effect;
  const cp = effect.cloudsPass, sp = effect.shadowPass;
  // One recorded frame: the cloud draws' inputs and outputs, textures named.
  const record = () => {
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
    return snaps.map((s, i) => ({ s, out: outLog[i] }))
      .filter(({ s }) => progs.has(s.program))
      .map(({ s, out }) => ({
        prog: progs.get(s.program),
        out: rename(out),
        raw: s.uniforms,
        uniforms: JSON.stringify(Object.entries(s.uniforms).filter(([k]) => !FRAME_DEPENDENT.test(k)).map(([k, x]) => [k, rename(x)])),
      }));
  };
  const draws = record();
  return { overlay, pipe, draws, record, frame, marchedBeforePipeline, composerBeforePipeline, legacyComposers, effect };
}

// The look's expected uniform values (cloud_storm_look.js tables).
function expectLook(isStorm) {
  const L = isStorm ? LOOK.STORM_LAYERS : LOOK.FAIR_LAYERS;
  return {
    minLayerHeights: L.map((l) => l.altitude),
    maxLayerHeights: L.map((l) => l.altitude + l.height),
    densityScales: L.map((l) => l.densityScale),
    coverageFilterWidths: L.map((l) => l.coverageFilterWidth),
    linearTerms: L.map((l) => (l.densityProfile ? l.densityProfile.linearTerm : 0.75)),
    coverage: isStorm ? LOOK.STORM_COVERAGE : LOOK.FAIR_COVERAGE,
    haze: isStorm ? LOOK.STORM_HAZE_DENSITY : LOOK.FAIR_HAZE_DENSITY,
  };
}
const close = (a, b) => Array.isArray(a)
  ? Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-6 * Math.max(1, Math.abs(x)))
  : Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
/** JS: the clouds material's uniform values carry the look. */
function materialHasLook(effect, isStorm) {
  const u = effect.cloudsPass.currentMaterial.uniforms;
  const e = expectLook(isStorm);
  return close(u.minLayerHeights.value.toArray(), e.minLayerHeights) &&
    close(u.maxLayerHeights.value.toArray(), e.maxLayerHeights) &&
    close(u.densityScales.value.toArray(), e.densityScales) &&
    close(u.coverageFilterWidths.value.toArray(), e.coverageFilterWidths) &&
    close(u.densityProfile.value.linearTerms.toArray(), e.linearTerms) &&
    close(u.coverage.value, e.coverage) && close(u.hazeDensityScale.value, e.haze);
}
/** GL: what the clouds program holds at its draw carries the look. */
function programHasLook(draws, isStorm) {
  const d = draws.find((x) => x.prog === "clouds");
  if (!d) return false;
  const u = d.raw;
  const e = expectLook(isStorm);
  return close(u.minLayerHeights, e.minLayerHeights) && close(u.maxLayerHeights, e.maxLayerHeights) &&
    close(u.densityScales, e.densityScales) && close(u.coverageFilterWidths, e.coverageFilterWidths) &&
    close(u["densityProfile.linearTerms"], e.linearTerms) && close(u.coverage, e.coverage) &&
    close(u.hazeDensityScale, e.haze);
}

// ---------------------------------------------------------------------------
console.log("\n-- B2 default boots: nothing pinned -----------------------------------");
const mainFirst = session("");
const legacyFirst = session("", { skyFirst: 3 });
{
  const t = mainFirst.overlay._diagStamps;
  check("pipeline first: no prime, the first march is in the main pass (main-first, as before)",
    mainFirst.marchedBeforePipeline === false && t.primed === null && t.firstMarch >= t.adopted, JSON.stringify(t));
  const u = legacyFirst.overlay._diagStamps;
  check("sky first: legacy marches before the pipeline, no prime, retired at adoption",
    legacyFirst.marchedBeforePipeline === true && legacyFirst.composerBeforePipeline !== null && u.primed === null &&
    u.firstMarch <= u.adopted && legacyFirst.overlay.composer === null &&
    legacyFirst.legacyComposers.every((c) => c === legacyFirst.legacyComposers[0]), JSON.stringify(u));
  check("the main pass owns the clouds in both", mainFirst.pipe.cloudsMainPass === true && legacyFirst.pipe.cloudsMainPass === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- B3 ?cloudsBootOrder debug values -----------------------------------");
const primedLegacy = session("?cloudsBootOrder=legacy");
{
  const t = primedLegacy.overlay._diagStamps;
  check("legacy: a would-be main-first boot gets one legacy march before adoption",
    primedLegacy.marchedBeforePipeline === false && t.primed !== null && t.firstMarch <= t.adopted &&
    primedLegacy.overlay.composer === null, JSON.stringify(t));
  check("a second prime is a no-op", primedLegacy.overlay.primeLegacyMarch(null, null) === false);
}
const mainOrder = session("?cloudsBootOrder=main", { skyFirst: 3 });
{
  const t = mainOrder.overlay._diagStamps;
  check("main: legacy frames suppressed, no prime, main-first",
    mainOrder.marchedBeforePipeline === false && mainOrder.composerBeforePipeline == null && t.primed === null &&
    t.firstMarch >= t.adopted, JSON.stringify(t));
}
const primeOrder = session("?cloudsBootOrder=prime", { skyFirst: 3 });
{
  const t = primeOrder.overlay._diagStamps;
  check("prime: legacy frames suppressed, the prime always runs before adoption",
    primeOrder.marchedBeforePipeline === false && t.primed !== null && t.firstMarch <= t.adopted, JSON.stringify(t));
}
{
  window.location.search = "?cloudsBootOrder=main&cloudsMainPass=off";
  const o = new CloudOverlay({ camera: new THREE.PerspectiveCamera(), proceduralTextures: true });
  check("?cloudsMainPass=off: nothing suppressed (the legacy path is the only path)", o._suppressLegacy === false);
  window.location.search = "";
}

// ---------------------------------------------------------------------------
console.log("\n-- B4 is_storm at boot, both boot orders --------------------------------");
const stormMain = session("", { storm: true });
const stormLegacy = session("", { skyFirst: 3, storm: true });
for (const [name, s] of [["main-first", stormMain], ["legacy-first", stormLegacy]]) {
  check(`${name}: _stormLookApplied true and the layers carry the storm look`,
    s.overlay.volume._stormLookApplied === true && LOOK.cloudLayersMatchLook(s.effect, true));
  check(`${name}: the clouds material's layer / coverage / haze uniforms are the storm look's`,
    materialHasLook(s.effect, true));
  check(`${name}: the clouds PROGRAM holds the storm values at its draw`, programHasLook(s.draws, true),
    JSON.stringify(s.draws.find((d) => d.prog === "clouds")?.raw?.minLayerHeights));
  const log = s.overlay.volume._lookLog;
  check(`${name}: the look was re-applied after adoption`,
    log.some((e) => e.why === "adopted" && e.storm === true && e.t >= s.overlay._diagStamps.adopted), JSON.stringify(log));
}
{
  const d = stormLegacy.overlay.diagSnapshot(null, {});
  check("__cloudStateDiag().look: layersMatch / applies / log",
    d.look.layersMatch === true && d.look.applies >= 2 && Array.isArray(d.look.log) && d.look.driftReapplies === 0,
    JSON.stringify(d.look));
}

// ---------------------------------------------------------------------------
console.log("\n-- B5 storm edge at runtime still drives the GPU -------------------------");
{
  const s = legacyFirst; // fair at boot, legacy-first
  check("fair at boot: fair look on the GPU", programHasLook(s.draws, false) && materialHasLook(s.effect, false));
  WX.setWeatherOverride({ is_storm: true });
  const toStorm = s.record();
  check("fair -> storm at runtime: the program holds the storm look", programHasLook(toStorm, true));
  WX.setWeatherOverride({ is_storm: false });
  const toFair = s.record();
  check("storm -> fair at runtime: back to the fair look", programHasLook(toFair, false));
  check("both were edges, not drift", s.overlay.volume._lookLog.slice(-2).every((e) => e.why === "edge"),
    JSON.stringify(s.overlay.volume._lookLog));
}

// ---------------------------------------------------------------------------
console.log("\n-- B6 layers reset behind the look's back -------------------------------");
{
  const s = stormMain;
  WX.setWeatherOverride({ is_storm: true });
  s.effect.cloudLayers.copy(CloudLayers.DEFAULT); // a reset the flag never sees
  check("the reset is visible to the matcher", LOOK.cloudLayersMatchLook(s.effect, true) === false);
  const before = s.overlay.volume._lookDriftReapplies;
  const after = s.record();
  check("next tick re-applies the storm look (driftReapplies +1) and the program holds it",
    s.overlay.volume._lookDriftReapplies === before + 1 && programHasLook(after, true));
  s.effect.coverage = 0.3; // ?cloudCoverage / __setCloudCoverage
  s.frame(); s.frame();
  check("a coverage knob is not fought (no drift re-apply, value kept)",
    s.effect.coverage === 0.3 && s.overlay.volume._lookDriftReapplies === before + 1);
  check("cloudLayersMatchLook: fair vs storm tables differ, no-layers effect is a match",
    LOOK.cloudLayersMatchLook(s.effect, false) === false && LOOK.cloudLayersMatchLook({}, true) === true);
}
WX.clearWeatherOverride("is_storm");

// ---------------------------------------------------------------------------
console.log("\n-- B7 the cloud draws see the same GL inputs in every boot order -------");
{
  const same = (a, b) => a.draws.length === b.draws.length && a.draws.every((d, i) =>
    d.prog === b.draws[i].prog && d.out === b.draws[i].out && d.uniforms === b.draws[i].uniforms);
  check("four cloud draws per frame (shadow, shadow resolve, march, resolve)",
    mainFirst.draws.map((d) => d.prog).join(" ") === "shadow shadowResolve clouds cloudsResolve",
    mainFirst.draws.map((d) => d.prog).join(" "));
  check("fair: main-first == legacy-first == primed == main == prime",
    same(mainFirst, legacyFirst) && same(mainFirst, primedLegacy) && same(mainFirst, mainOrder) && same(mainFirst, primeOrder));
  check("storm at boot: main-first == legacy-first", same(stormMain, stormLegacy));
}

// ---------------------------------------------------------------------------
console.log("\n-- B8 wiring ---------------------------------------------------------");
{
  const ap = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  const primeAt = ap.indexOf("bootOverlay.primeLegacyMarch(renderer, camera)");
  const composerAt = ap.indexOf("const composer = new ComposerClass(renderer, {");
  check("createAtmospherePipeline offers the prime before it builds its composer", primeAt > 0 && composerAt > primeAt);
  const co = readFileSync(path.join(APP, "scene3d", "cloud_overlay.js"), "utf8");
  check("adoption and release invalidate the look edge",
    /this\.volume\.invalidateCloudLook\?\.\('adopted'\)/.test(co) && /invalidateCloudLook\?\.\('released'\)/.test(co));
  const doc = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  check("docs/url-flags.md: cloudsBootOrder row (off by default)", /^\| `cloudsBootOrder` \| [^|]*\| \*\*off\*\*/m.test(doc));
  const h = readFileSync(path.join(APP, "harness", "run-js-headless.mjs"), "utf8");
  check("harness registers this suite as tier 5",
    /\{ tier: 5, flag: "cloudsBootOrder", file: "tests\/clouds_boot_order\.test\.mjs" \}/.test(h));
}

console.log(`\nclouds boot order: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
