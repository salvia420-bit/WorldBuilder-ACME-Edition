// tests/msaa_world.test.mjs
//
// `?msaaWorldOnly` (2026-10-17, DEFAULT ON, `=off` escape) — MSAA on the world
// pass only; the post-processing chain runs on single-sample buffers
// (scene3d/msaa_world.js). 1070 measurement (ultra, msaa=4): MSAA resolves
// 1.95 ms/frame, ~1.2 ms of it from post passes writing 4x ping-pong buffers.
//
//   W1  flag parsing: absent / on / garbage -> on, off-forms -> off.
//   W2  MsaaWorldComposer against the REAL pmndrs EffectComposer loop and
//       recording passes: buffers single-sample; W multisampled, sized like
//       the buffers, carrying composer.depthTexture; every pass before the
//       first swap gets W; from the first swap on the (input, output) sequence
//       is EXACTLY the stock composer's; depth blits read the buffer the pass
//       drew into; resize, depth-texture identity change (rebuild, never
//       re-point), disabled passes, disposeWorldTarget fallback.
//   W3  REAL pipeline (vendored takram via a resolve hook, recording renderer)
//       at msaa=4: the sky + world passes draw into W, NOTHING else draws into
//       a multisampled target, the first post pass reads W's resolved colour,
//       the late particle target and W share composer.depthTexture, the stable
//       depth is blitted from W; the indoor split's depth wipe + cells pass hit
//       W too; resize; dispose; `__msaaWorld()`.
//   W4  `=off` (URL and opts): the legacy multisampled ping-pong composer.
//   W5  `?msaa=0`: no samples anywhere, no world target (as before).
//   W6  wiring: url-flags.md row, harness registration, the composer's first
//       `stencilBuffer:` option untouched (portal_punch_occlusion_flag anchor).
//
// Fails on the pre-change code: scene3d/msaa_world.js does not exist and the
// composer's ping-pong buffers carry the samples.
//
// Run: node tests/msaa_world.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

// index.html's import map, mirrored for node (as tests/particles_over_clouds).
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
const PP = await import("postprocessing");
const MW = await import("../scene3d/msaa_world.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- W1 ?msaaWorldOnly parsing ------------------------------------------");
check("absent -> on", MW.msaaWorldOnlyEnabled("") === true);
check("on -> on", MW.msaaWorldOnlyEnabled("?msaaWorldOnly=on") === true);
check("garbage -> on", MW.msaaWorldOnlyEnabled("?msaaWorldOnly=banana") === true);
for (const off of ["off", "0", "false", "no", "OFF", "No"]) {
  check(`${off} -> off`, MW.msaaWorldOnlyEnabled(`?msaaWorldOnly=${off}`) === false);
}
check("no location (node) -> on", MW.msaaWorldOnlyEnabled() === true);

// ---------------------------------------------------------------------------
// Recording renderer: enough of WebGLRenderer for EffectComposer + the passes.
let W = 1280, H = 720;
const gl = new Proxy({ getContextAttributes: () => ({ alpha: false }), getExtension: () => null, getParameter: () => 0 }, {
  get(tgt, k) {
    if (k in tgt) return tgt[k];
    return typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => null;
  },
});
const calls = [];
const renderer = {
  autoClear: true, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
  shadowMap: { autoUpdate: true, needsUpdate: false }, capabilities: { isWebGL2: true, maxSamples: 4 },
  info: { render: { frame: 0 }, autoReset: true },
  _target: null,
  getSize: (vv) => vv.set(W, H), getDrawingBufferSize: (vv) => vv.set(W, H), getPixelRatio: () => 1,
  setSize() {}, setOpaqueSort() {}, setTransparentSort() {}, getContext: () => gl,
  getRenderTarget() { return this._target; },
  setRenderTarget(rt) { this._target = rt ?? null; },
  render(sc, cam) { calls.push({ kind: "render", scene: sc, target: this._target, mask: cam?.layers?.mask }); },
  clear(c, d, s) { calls.push({ kind: "clear", target: this._target, color: c, depth: d, stencil: s }); },
  clearDepth() {}, clearStencil() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
  state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
};
const samplesOf = (rt) => (rt ? rt.samples | 0 : 0);

// ---------------------------------------------------------------------------
console.log("\n-- W2 MsaaWorldComposer vs the stock pmndrs loop ----------------------");
{
  // Recording passes. `geo` = scene passes (no swap), one of them asks for the
  // stable depth blit like a RenderPass; `fx` = full-screen swapping passes;
  // `dep` needs the depth texture so the composer creates one.
  const log = [];
  class Rec extends PP.Pass {
    constructor(name, { swap = false, blit = false, depth = false } = {}) {
      super(name);
      this.needsSwap = swap;
      this.needsDepthBlit = blit;
      this.needsDepthTexture = depth;
    }
    render(_r, input, output) { log.push({ name: this.name, input, output, inDepth: input?.depthTexture ?? null }); }
  }
  const mkPasses = () => [
    new Rec("sky"), new Rec("mask"), new Rec("world", { blit: true }), new Rec("clear"),
    new Rec("cells", { blit: true }), new Rec("restore"),
    new Rec("scrub", { swap: true, depth: true }), new Rec("ssao", { depth: true }),
    new Rec("atmos", { depth: true }), new Rec("haze", { swap: true, depth: true }), new Rec("post", { swap: true }),
  ];
  function rig(Klass, extra) {
    const c = new Klass(renderer, { frameBufferType: THREE.HalfFloatType, stencilBuffer: false, ...extra });
    c.setSize(W, H);
    const passes = mkPasses();
    for (const p of passes) c.addPass(p);
    const blits = [];
    c.blitDepthBuffer = (rt) => { blits.push(rt); };
    return { c, passes, blits };
  }
  const stock = rig(PP.EffectComposer, { multisampling: 0 });
  const mw = rig(MW.MsaaWorldComposer, { worldSamples: 4 });
  const c = mw.c;
  check("ping-pong buffers are single-sample", c.multisampling === 0 &&
    samplesOf(c.inputBuffer) === 0 && samplesOf(c.outputBuffer) === 0, `ms=${c.multisampling}`);
  check("no world target before attach (composer.depthTexture comes from addPass)", c.worldTarget === null);
  const rt = c.attachWorldTarget();
  check("attachWorldTarget is idempotent", c.attachWorldTarget() === rt);
  check("world target: requested samples, HalfFloat, buffer-sized, depth + no stencil",
    rt.samples === 4 && rt.texture.type === THREE.HalfFloatType && rt.width === W && rt.height === H &&
    rt.depthBuffer === true && rt.stencilBuffer === false && c.worldMultisampling === 4,
    `samples=${rt.samples} ${rt.width}x${rt.height}`);
  check("world target carries composer.depthTexture (set before its first bind)",
    !!c.depthTexture && rt.depthTexture === c.depthTexture);

  log.length = 0; stock.c.render(0); const stockLog = log.slice();
  log.length = 0; c.render(0); const mwLog = log.slice();
  const A = c.inputBuffer, B = c.outputBuffer;
  const iScrub = mwLog.findIndex((e) => e.name === "scrub");
  check("every pass before the first swap gets the world target as input",
    iScrub === 6 && mwLog.slice(0, iScrub + 1).every((e) => e.input === rt),
    mwLog.map((e) => `${e.name}:${e.input === rt ? "W" : e.input === A ? "A" : e.input === B ? "B" : "?"}`).join(" "));
  check("the first swapping pass reads W and writes the plain output buffer", mwLog[iScrub].output === B);
  check("NO pass after the first swap ever sees W", mwLog.slice(iScrub + 1).every((e) => e.input !== rt && e.output !== rt));
  const role = (log2, comp) => log2.map((e) => `${e.name}:${e.input === comp.inputBuffer ? "A" : e.input === comp.outputBuffer ? "B" : "W"}>${e.output === comp.inputBuffer ? "A" : e.output === comp.outputBuffer ? "B" : "?"}`);
  const sRoles = role(stockLog, stock.c).map((s, i) => (i <= iScrub ? s.replace(/:A>/, ":W>") : s));
  const mRoles = role(mwLog, c);
  check("(input, output) sequence == the stock composer's, with W in A's pre-swap slot (parity unchanged)",
    JSON.stringify(sRoles) === JSON.stringify(mRoles), `\n     stock ${sRoles.join(" ")}\n     mw    ${mRoles.join(" ")}`);
  check("the composer still hands composer.depthTexture to its input buffer every pass (stock behaviour)",
    mwLog.slice(iScrub + 1).every((e) => e.inDepth === c.depthTexture));
  check("scene passes read W's depth texture = composer.depthTexture (seal save/restore)",
    mwLog.slice(0, iScrub).every((e) => e.inDepth === c.depthTexture));
  check("stable-depth blits for the scene passes read W (the buffer they drew into)",
    mw.blits.length === 2 && mw.blits.every((b) => b === rt), `blits=${mw.blits.length}`);
  check("stats: 7 world passes, 2 world depth blits, 1 frame",
    c.msaaWorldStats.worldPasses === 7 && c.msaaWorldStats.worldDepthBlits === 2 && c.msaaWorldStats.frames === 1,
    JSON.stringify(c.msaaWorldStats));

  // A disabled pass is skipped and does not count.
  mw.passes[0].enabled = false;
  log.length = 0; c.render(0);
  check("disabled passes are skipped (stock behaviour)", !log.some((e) => e.name === "sky") && c.msaaWorldStats.worldPasses === 6);
  mw.passes[0].enabled = true;

  // Resize follows the composer.
  W = 1600; H = 900;
  c.setSize(W, H);
  check("composer.setSize resizes the world target with the buffers",
    rt.width === 1600 && rt.height === 900 && A.width === 1600 && rt.depthTexture === c.depthTexture,
    `${rt.width}x${rt.height}`);
  W = 1280; H = 720;
  c.setSize(W, H);

  // Depth texture identity change -> rebuild (dispose), never re-point a set-up target.
  let disposed = 0;
  rt.addEventListener("dispose", () => { disposed++; });
  const oldDepth = c.depthTexture;
  let oldDepthDisposed = 0;
  oldDepth.addEventListener("dispose", () => { oldDepthDisposed++; });
  const newDepth = new THREE.DepthTexture(W, H);
  c.depthTexture = newDepth;
  log.length = 0; c.render(0);
  check("a new composer.depthTexture rebuilds W (disposed, then re-pointed) and is counted",
    disposed === 1 && rt.depthTexture === newDepth && c.msaaWorldStats.depthRebuilds === 1);
  check("the rebuild does not dispose the OLD depth texture (the composer owns it)", oldDepthDisposed === 0);
  c.depthTexture = oldDepth; c.render(0);

  // Snapshot + fallback.
  const snap = MW.msaaWorldSnapshot(c, { flag: true, requested: 4, maxSamples: 8 });
  check("snapshot: active, samples, size, depth link", snap.active && snap.worldSamples === 4 &&
    snap.target === `${W}x${H}` && snap.depthIsComposers === true && snap.composerSamples === 0, JSON.stringify(snap));
  c.disposeWorldTarget();
  log.length = 0; c.render(0);
  check("disposeWorldTarget: no target, never re-attached, the stock loop again (scene passes get A)",
    c.worldTarget === null && log.find((e) => e.name === "world").input === c.inputBuffer && c.attachWorldTarget() === null);
  const z = new MW.MsaaWorldComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  check("worldSamples 0: never builds a target", z.attachWorldTarget() === null && z.worldMultisampling === 0);
}

// ---------------------------------------------------------------------------
// The real pipeline.
const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()));
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera };
function build(opts = {}) {
  const skyScene = new THREE.Scene(); skyScene.name = "sky";
  const skyCamera = new THREE.PerspectiveCamera();
  const overlay = new CloudOverlay({ camera, proceduralTextures: true });
  overlay.attachToSkyScene(skyScene);
  const p = createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera,
    bloom: true, vignette: false, msaa: 4, portalPunch: true, punchRetail: true, ...opts,
  });
  const blits = [];
  const realBlit = p.composer.blitDepthBuffer.bind(p.composer);
  p.composer.blitDepthBuffer = (rt) => { blits.push(rt); realBlit(rt); };
  return { p, skyScene, blits };
}
const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
function frame(p) {
  calls.length = 0;
  p.preFrameSkySync(skyDome, camera);
  p.render(camera, 0);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

console.log("\n-- W3 the real pipeline at msaa=4 -----------------------------------");
{
  const { p, skyScene, blits } = quiet(() => build());
  const comp = p.composer;
  const rt = p.msaaWorldTarget;
  check("composer is an MsaaWorldComposer with single-sample ping-pong buffers",
    comp instanceof MW.MsaaWorldComposer && comp.multisampling === 0, `ms=${comp.multisampling}`);
  check("world target: 4 samples at the drawing-buffer size, on composer.depthTexture",
    !!rt && rt.samples === 4 && rt.width === W && rt.height === H && rt.depthTexture === comp.depthTexture);
  frame(p);
  const renders = calls.filter((x) => x.kind === "render");
  const sky = renders.find((x) => x.scene === skyScene);
  const world = renders.find((x) => x.scene === scene);
  check("the sky pass draws into the world target", sky && sky.target === rt);
  check("the world pass draws into the world target", world && world.target === rt);
  const msDraws = renders.filter((x) => samplesOf(x.target) > 0);
  check("NOTHING else draws into a multisampled target",
    msDraws.length === 2 && msDraws.every((x) => x.target === rt), `ms draws=${msDraws.length}`);
  check("no post draw targets a composer buffer that carries samples",
    renders.every((x) => x.target === null || x.target === rt || samplesOf(x.target) === 0));
  const describe = (pass) => pass.name + (Array.isArray(pass.effects) ? `[${pass.effects.map((e) => e.name).join(",")}]` : "");
  const firstScrub = comp.passes.find((x) => describe(x) === "EffectPass[NanScrub]");
  check("the first post pass (NanScrub) read the world target's resolved colour",
    firstScrub && firstScrub.fullscreenMaterial.uniforms.inputBuffer.value === rt.texture);
  const late = p.particlesOverCloudsPass;
  check("late particle target and world target share composer.depthTexture",
    late && late.renderTarget.depthTexture === comp.depthTexture && rt.depthTexture === comp.depthTexture);
  check("stable depth is blitted from the world target (once: the world pass)",
    blits.length === 1 && blits[0] === rt, `blits=${blits.length}`);
  const snap = window.__msaaWorld();
  check("__msaaWorld(): active, 4 samples, requested 4, maxSamples from caps, depth linked",
    snap.active && snap.flag === true && snap.worldSamples === 4 && snap.requested === 4 &&
    snap.maxSamples === 4 && snap.depthIsComposers === true && snap.worldPasses > 0, JSON.stringify(snap));

  // Indoor split: the depth wipe and the cells pass hit the world target too.
  p.setIndoorSplitArmed(true);
  skyDome._lastIsIndoor = true;
  frame(p);
  const renders2 = calls.filter((x) => x.kind === "render" && x.scene === scene);
  const wipe = calls.find((x) => x.kind === "clear" && x.color === false && x.depth === true);
  check("indoor split: world + cells passes both draw into the world target",
    renders2.length === 2 && renders2.every((x) => x.target === rt), `n=${renders2.length}`);
  check("indoor split: the full depth wipe clears the world target", !!wipe && wipe.target === rt);
  p.setIndoorSplitArmed(false);
  skyDome._lastIsIndoor = false;

  W = 1920; H = 1080;
  p.setSize(W, H);
  frame(p);
  check("pipeline.setSize: world target follows the drawing buffer, still on composer.depthTexture",
    rt.width === 1920 && rt.height === 1080 && rt.depthTexture === comp.depthTexture);
  W = 1280; H = 720;
  p.dispose();
  check("dispose: the world target is freed", p.msaaWorldTarget === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- W4 =off restores the legacy multisampled composer ------------------");
for (const how of ["opts", "url"]) {
  let built;
  if (how === "url") {
    globalThis.location = { search: "?msaaWorldOnly=off" };
    built = quiet(() => build());
    delete globalThis.location;
  } else {
    built = quiet(() => build({ msaaWorldOnly: false }));
  }
  const { p } = built;
  check(`${how}: plain EffectComposer with 4x ping-pong buffers, no world target`,
    !(p.composer instanceof MW.MsaaWorldComposer) && p.composer.multisampling === 4 && p.msaaWorldTarget === null);
  frame(p);
  const world = calls.find((x) => x.kind === "render" && x.scene === scene);
  check(`${how}: the world pass draws into the composer's input buffer (legacy)`, world && world.target === p.composer.inputBuffer);
  check(`${how}: __msaaWorld() reports inactive`, window.__msaaWorld().active === false && window.__msaaWorld().flag === false);
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- W5 ?msaa=0: no samples anywhere ------------------------------------");
{
  const { p } = quiet(() => build({ msaa: 0 }));
  check("plain composer, no samples, no world target",
    !(p.composer instanceof MW.MsaaWorldComposer) && p.composer.multisampling === 0 && p.msaaWorldTarget === null);
  frame(p);
  const world = calls.find((x) => x.kind === "render" && x.scene === scene);
  check("the world pass draws into the composer's input buffer", world && world.target === p.composer.inputBuffer);
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- W6 wiring ---------------------------------------------------------");
{
  const DOC = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  check("url-flags.md row", /^\| `msaaWorldOnly` \|/m.test(DOC));
  const HARNESS = readFileSync(path.join(APP, "harness", "run-js-headless.mjs"), "utf8");
  check("registered in the JS gate", HARNESS.includes("tests/msaa_world.test.mjs"));
  const SRC = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  const m = SRC.match(/stencilBuffer:\s*([^,\n]+),/);
  check("the composer's own stencil option is still the file's first (portal_punch_occlusion_flag anchor)",
    !!m && m[1].trim() === "!!portalStencil || !!punchOcclusion");
  check("the choice is made at construction (no runtime multisampling writes in the pipeline)",
    !/\.multisampling\s*=(?!=)/.test(SRC));
}

console.log(`\nmsaa world: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
