// tests/sky_late_haze_camera.test.mjs — 2026-10-18 systematic review, sky group
// (docs/2026-10-18-systematic-code-review.md SKY-1, SKY-3, SKY-5).
//
//   SKY-1  Split chain (clouds in the main pass, the high/ultra default): the
//          `?layerHaze` pass draws the cloud/aerial composite into the late
//          target T BEFORE the late particles are drawn into it. Before, it ran
//          after them over T, and because particles write no depth a near spell
//          was hazed by the distance of the hills behind it.
//   SKY-5  `?nanScrub=off`: the post half reads T, so the haze must be IN T.
//          Before, the haze wrote the composer buffer and the post half ignored
//          it (no haze on screen, a full-screen pass for nothing).
//   SKY-3  render(cam) — the C-key camera switch — retargets the AO and haze
//          passes as setCamera() does. Under the ortho top-down camera the AO is
//          skipped AND its composite applies nothing (the AO target still holds
//          the last perspective frame); back in perspective both resume.
//
// Runs the REAL atmosphere pipeline (vendored takram via a resolve hook, the
// real CloudOverlay so the split chain is built, a recording renderer).
//
// Run: node tests/sky_late_haze_camera.test.mjs

import { register } from "node:module";
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
const POC = await import("../scene3d/particles_over_clouds.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera };
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8899aa, 10, 900);
// One additive "spell" 30 m out: what the late pass draws.
const spark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
spark.position.set(0, 0, -30);
scene.add(spark);
const unregister = POC.registerLateFxSource((out) => out.push(spark));

// Recording renderer: enough of WebGLRenderer for EffectComposer + the passes.
const W = 1280, H = 720;
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
  render(sc, cam) {
    // What a full-screen quad reads at the moment it draws.
    const input = sc?.children?.[0]?.material?.uniforms?.inputBuffer?.value ?? null;
    calls.push({ scene: sc, target: this._target, cam, input });
  },
  clear() {}, clearDepth() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
  state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
};

const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
function build(opts = {}, search = "") {
  if (search) globalThis.location = { search };
  try {
    const skyScene = new THREE.Scene(); skyScene.name = "sky";
    const overlay = new CloudOverlay({ camera, proceduralTextures: true });
    overlay.attachToSkyScene(skyScene);
    return createAtmospherePipeline(renderer, scene, camera, {
      atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera: new THREE.PerspectiveCamera(),
      bloom: true, vignette: false, msaa: 2, portalPunch: true, punchRetail: true, ...opts,
    });
  } finally {
    if (search) delete globalThis.location;
  }
}
const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
function frame(p, cam = camera) {
  scene.updateMatrixWorld(true);
  calls.length = 0;
  p.preFrameSkySync(skyDome, cam);
  p.render(cam, 1 / 60);
}
const describe = (pass) => pass.name + (Array.isArray(pass.effects) ? `[${pass.effects.map((e) => e.name).join(",")}]` : "");
const lateScene = (p) => p.particlesOverCloudsPass.scene;

// ---------------------------------------------------------------------------
console.log("-- SKY-1 the haze lands in the late target before the late particles --");
{
  // 2026-10-20: SKY-1 / SKY-5 pin the haze as its own pass — the
  // `?postFuse=off` chain. Fused (the default) the haze is the last effect of
  // the atmosphere pass that writes T: tests/post_fuse.test.mjs F3 / F5.
  // SKY-3 below runs the fused default.
  const p = build({ postFuse: false });
  const T = p.particlesOverCloudsPass?.renderTarget;
  check("fixture: split chain built with the default haze", !!T && !!p.layeredHaze && p.cloudsMainPass === true);
  frame(p);
  const iA = calls.findIndex((c) => c.scene === p.fxPass.scene);
  const iH = calls.findIndex((c) => c.scene === p.layeredHaze.scene);
  const iL = calls.findIndex((c) => c.scene === lateScene(p));
  check("one late particle draw (the spark), into T",
    iL >= 0 && calls.filter((c) => c.scene === lateScene(p)).length === 1 && calls[iL].target === T);
  check("the haze draws into T", iH >= 0 && calls[iH].target === T, `target=${calls[iH]?.target?.texture?.name}`);
  check("the haze runs after the cloud/aerial composite and BEFORE the late particle draw",
    iA >= 0 && iA < iH && iH < iL, `a=${iA} h=${iH} l=${iL}`);
  check("the haze reads the composite (not T, which it writes)",
    calls[iH]?.input === calls[iA]?.target?.texture && calls[iH]?.input !== T.texture);
  const iPostHaze = calls.findIndex((c, i) => i > iL && c.scene === p.layeredHaze.scene);
  check("nothing hazes T after the particles are in it", iPostHaze === -1);
  check("the haze ran at its default strength (not a pass-through)",
    p.layeredHaze.material.uniforms.uHaze.value.x === p.layeredHaze.strength && p.layeredHaze.strength > 0);
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- SKY-5 ?nanScrub=off: the post half reads what the haze wrote -------");
{
  const p = build({ postFuse: false }, "?nanScrub=off");
  const T = p.particlesOverCloudsPass.renderTarget;
  const names = p.composer.passes.map(describe);
  check("fixture: no scrub passes", !names.some((n) => /NanScrub/.test(n)), names.join(" | "));
  frame(p);
  const iH = calls.findIndex((c) => c.scene === p.layeredHaze.scene);
  const iP = calls.findIndex((c) => c.scene === p.fxPostPass.scene);
  check("the post half reads T", iP >= 0 && calls[iP].input === T.texture);
  check("... and T holds the haze (the haze wrote T before the post half drew)",
    iH >= 0 && iH < iP && calls[iH].target === T);
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- SKY-3 render(cam) retargets the AO + haze; ortho skips the AO ------");
{
  const p = build({ ssao: true });
  const composite = p.fxPass.effects.find((e) => e.name === "SsaoCompositeEffect");
  const strength = () => composite.uniforms.get("uSsaoStrength").value;
  const aoDraws = () => calls.filter((c) => c.scene === p.ssaoPass.scene).length;
  check("fixture: AO pass + composite built", !!p.ssaoPass && !!composite);
  frame(p);
  check("perspective: the AO renders (AO + 2 blurs) and the composite applies it",
    aoDraws() === 3 && p.ssaoPass.ran === true && strength() === p.ssaoPass.params.strength, `draws=${aoDraws()} k=${strength()}`);

  const ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 5000);
  ortho.position.set(0, 300, 0);
  ortho.updateMatrixWorld(true);
  frame(p, ortho);
  check("render(ortho) retargets the AO pass", p.ssaoPass.camera === ortho);
  check("render(ortho) retargets the haze pass", p.layeredHaze.camera === ortho);
  check("ortho: no AO drawn this frame", aoDraws() === 0 && p.ssaoPass.ran === false, `draws=${aoDraws()}`);
  check("ortho: the composite applies nothing (the AO target is a stale perspective frame)", strength() === 0, `k=${strength()}`);
  check("ortho: the haze is a pass-through (strength 0)", p.layeredHaze.material.uniforms.uHaze.value.x === 0);

  frame(p, camera);
  check("back to perspective: both passes follow", p.ssaoPass.camera === camera && p.layeredHaze.camera === camera);
  check("back to perspective: AO drawn and applied again",
    aoDraws() === 3 && strength() === p.ssaoPass.params.strength, `draws=${aoDraws()} k=${strength()}`);
  p.ssaoPass.enabled = false;
  frame(p);
  check("`__ssao.off` (pass disabled): nothing applied", strength() === 0);
  p.dispose();
}

unregister();
console.log(`\nsky late haze + camera retarget: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
