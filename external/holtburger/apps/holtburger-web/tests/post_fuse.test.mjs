// tests/post_fuse.test.mjs — 2026-10-20 improvement hunt A7 (gpu-shading-5),
// `?postFuse` (DEFAULT ON, `=off` escape; atmosphere_pipeline.js postFuseEnabled).
//
// The split post chain (clouds in the main pass: the high/ultra default) ran
// two full-screen RGBA16F passes that need not be passes: the first NanScrub
// (its own pass only because bloom blurs its raw input — bloom is not in the
// atmosphere pass on this chain) and the LayeredHaze (purely per pixel). Fused,
// the scrub is the FIRST effect of the atmosphere EffectPass and the haze its
// LAST, and that pass writes the late target T itself (the haze-off arm's
// PostChainTargetPass).
//
//   F1  flag parsing: absent / on / garbage -> on, off-forms -> off.
//   F2  pass lists, split x unsplit x postFuse on / off: fused = the `=off` list
//       minus the first scrub pass and the haze pass, the atmosphere pass is
//       [NanScrub, ..., AerialPerspective, AO, LayeredHaze] in that order after
//       pmndrs' attribute sort and never swaps; `=off` (URL and opts) is today's
//       list; the unsplit chain is identical either way, shader for shader.
//   F3  one fused frame: world -> atmosphere pass (reads the world colour,
//       writes T) -> late particles into T -> late scrub -> post half; no haze
//       quad drawn; exactly two full-screen renders fewer than `=off`; the
//       haze ran at its strength with the same uniform values as the `=off`
//       pass; the depth it samples is the pass's stable copy, never T's depth.
//   F4  shaders: the haze effect GLSL is LAYER_HAZE_FRAG line for line (I/O
//       aside), it adds no sampler to the pass, the effect uniforms ARE the
//       pass's uniform objects; the fused scrub keeps the exponent-bit test and
//       SRC blend, and matches scrub-then-write per texel (alpha clamp).
//   F5  the strength 0 rule (sky-blocked cell, ortho camera) through the fused
//       path, `?nanScrub=off` / `?layerHaze=off` combinations, dispose.
//
// Runs the REAL atmosphere pipeline (vendored takram via a resolve hook, the
// real CloudOverlay so the split chain is built, a recording renderer), as
// tests/sky_late_haze_camera.test.mjs does.
//
// Run: node tests/post_fuse.test.mjs

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
const LH = await import("../scene3d/layered_haze.js");
const { BlendFunction, EffectAttribute } = await import("postprocessing");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.position.set(3, 40, 7);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
const skyDomeLive = { _lastIsIndoor: false, _lastSkyBlocked: false };
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera, skyDome: skyDomeLive };
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

const PIPE = await import("../scene3d/atmosphere_pipeline.js");
const { createAtmospherePipeline, postFuseEnabled } = PIPE;
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
// `search` reaches both readers: the pipeline reads globalThis.location
// (?postFuse, ?nanScrub), layered_haze.js reads window.location (?layerHaze).
function build(opts = {}, search = "") {
  if (search) { globalThis.location = { search }; window.location = { search }; }
  try {
    const skyScene = new THREE.Scene(); skyScene.name = "sky";
    const overlay = new CloudOverlay({ camera, proceduralTextures: true });
    overlay.attachToSkyScene(skyScene);
    return createAtmospherePipeline(renderer, scene, camera, {
      atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera: new THREE.PerspectiveCamera(),
      bloom: true, vignette: false, msaa: 2, portalPunch: true, punchRetail: true, ssao: true, ...opts,
    });
  } finally {
    if (search) { delete globalThis.location; delete window.location; }
  }
}
const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
function frame(p, cam = camera) {
  scene.updateMatrixWorld(true);
  calls.length = 0;
  p.preFrameSkySync(skyDome, cam);
  p.render(cam, 1 / 60);
  return calls.slice();
}
const describe = (pass) => pass.name + (Array.isArray(pass.effects) ? `[${pass.effects.map((e) => e.name).join(",")}]` : "");
const names = (p) => p.composer.passes.map(describe);
const effectNames = (pass) => pass.effects.map((e) => e.name);
const SCRUB = "EffectPass[NanScrub]";

// ---------------------------------------------------------------------------
console.log("-- F1 ?postFuse parsing ----------------------------------------------");
check("absent -> on", postFuseEnabled("") === true);
check("on -> on", postFuseEnabled("?postFuse=on") === true);
check("garbage -> on", postFuseEnabled("?postFuse=banana") === true);
for (const off of ["off", "0", "false", "no", "OFF"]) {
  check(`${off} -> off`, postFuseEnabled(`?postFuse=${off}`) === false);
}
check("no location (node) -> on", postFuseEnabled() === true);

// ---------------------------------------------------------------------------
console.log("\n-- F2 pass lists: split / unsplit x postFuse on / off ----------------");
const fused = build();
const offOpts = build({ postFuse: false });
const offUrl = build({}, "?postFuse=off");
{
  const nOn = names(fused);
  const nOff = names(offOpts);
  console.log("     fused: " + nOn.slice(nOn.indexOf("CameraLayerMask(Restore)") + 1).join(" -> "));
  console.log("     =off : " + nOff.slice(nOff.indexOf("CameraLayerMask(Restore)") + 1).join(" -> "));
  check("fixture: split chain, haze + AO + clouds in the main pass on both",
    !!fused.particlesOverCloudsPass && !!offOpts.particlesOverCloudsPass && !!fused.layeredHaze &&
    !!fused.ssaoPass && fused.cloudsMainPass === true && offOpts.cloudsMainPass === true);
  check("returned flags: fused.postFuse, =off not; the haze effect handle only when fused",
    fused.postFuse === true && offOpts.postFuse === false && offUrl.postFuse === false &&
    fused.layeredHazeEffect instanceof LH.LayeredHazeEffect && offOpts.layeredHazeEffect === null);
  check("=off via URL builds exactly the opts list", JSON.stringify(names(offUrl)) === JSON.stringify(nOff));

  // `=off` is today's split chain: Restore -> NanScrub -> SsaoPass -> [atmos]
  // -> LayeredHazePass -> ParticlesOverClouds -> NanScrub -> [post].
  const at = (list, re) => list.findIndex((n) => re.test(n));
  const ATMOS = /^EffectPass\[(FxDistortEffect,)?(FxDecalEffect,)?CloudsEffect,AerialPerspectiveEffect,SsaoCompositeEffect\]$/;
  const iR = nOff.indexOf("CameraLayerMask(Restore)");
  check("=off: today's chain, pass for pass",
    nOff[iR + 1] === SCRUB && nOff[iR + 2] === "SsaoPass" && ATMOS.test(nOff[iR + 3]) &&
    nOff[iR + 4] === "LayeredHazePass" && nOff[iR + 5] === "ParticlesOverClouds" && nOff[iR + 6] === SCRUB &&
    /^EffectPass\[(FxGlowEffect,)?BloomEffect,ToneMappingEffect,ColorGradeEffect,DitheringEffect\]$/.test(nOff[iR + 7]) &&
    nOff.length === iR + 8, nOff.slice(iR + 1).join(" | "));

  // Fused: the same list without the first scrub and the haze pass.
  const expect = nOff.filter((n, i) => !(i === iR + 1 || n === "LayeredHazePass"));
  const iA = at(nOn, /CloudsEffect/);
  expect[expect.findIndex((n) => ATMOS.test(n))] = nOn[iA];
  check("fused: the =off list minus exactly two passes (first scrub, haze)",
    nOn.length === nOff.length - 2 && JSON.stringify(nOn) === JSON.stringify(expect), nOn.join(" | "));
  check("fused: one NanScrub pass left — the late one, after the particles",
    nOn.filter((n) => n === SCRUB).length === 1 && nOn.indexOf(SCRUB) === nOn.indexOf("ParticlesOverClouds") + 1);
  check("fused: no LayeredHazePass anywhere", !nOn.includes("LayeredHazePass"));
  const order = effectNames(fused.fxPass);
  check("fused: atmosphere pass order after the attribute sort = [NanScrub, ..., Aerial, AO, LayeredHaze]",
    order[0] === "NanScrub" && order[order.length - 1] === "LayeredHazeEffect" &&
    order[order.length - 2] === "SsaoCompositeEffect" && order[order.length - 3] === "AerialPerspectiveEffect" &&
    order.indexOf("CloudsEffect") < order.indexOf("AerialPerspectiveEffect"), order.join(","));
  check("fused: the =off atmosphere effects, in the same relative order, between the two",
    JSON.stringify(order.slice(1, -1)) === JSON.stringify(effectNames(offOpts.fxPass)));
  check("fused: the atmosphere pass is the haze-off arm's target pass (late = the particle pass, never swaps, even after a recompile)",
    fused.fxPass._latePass?.() === fused.particlesOverCloudsPass && fused.fxPass.needsSwap === false &&
    (fused.fxPass.recompile(), fused.fxPass.needsSwap === false));
  check("fused: attributes — scrub DEPTH, haze NONE, both SRC blend",
    fused.fxPass.effects[0].attributes === EffectAttribute.DEPTH && fused.layeredHazeEffect.attributes === EffectAttribute.NONE &&
    fused.fxPass.effects[0].blendMode.blendFunction === BlendFunction.SRC &&
    fused.layeredHazeEffect.blendMode.blendFunction === BlendFunction.SRC);
  check("fused: post half and late scrub are the =off ones, shader for shader",
    fused.fxPostPass.fullscreenMaterial.fragmentShader === offOpts.fxPostPass.fullscreenMaterial.fragmentShader &&
    fused.composer.passes.find((x) => describe(x) === SCRUB).fullscreenMaterial.fragmentShader ===
      offOpts.composer.passes.filter((x) => describe(x) === SCRUB)[1].fullscreenMaterial.fragmentShader);
  check("=off: the standalone scrubs carry no alpha clamp (the pre-fuse shader)",
    offOpts.composer.passes.filter((x) => describe(x) === SCRUB)
      .every((x) => !/clamp\(inputColor\.a/.test(x.effects[0].getFragmentShader())));
}
{
  // Unsplit chain (no clouds in the post chain: low / mid): untouched.
  const uOn = build({ particlesOverClouds: false });
  const uOff = build({ particlesOverClouds: false, postFuse: false });
  const a = names(uOn);
  const b = names(uOff);
  check("unsplit: identical pass lists with postFuse on and off", JSON.stringify(a) === JSON.stringify(b), a.join(" | "));
  check("unsplit: the standalone first scrub and the haze pass are still there",
    a.includes(SCRUB) && a.includes("LayeredHazePass") && uOn.postFuse === false && uOn.layeredHazeEffect === null);
  const shaders = (p) => p.composer.passes.map((x) => x.fullscreenMaterial?.fragmentShader ?? null);
  check("unsplit: every pass's fragment shader byte-identical on vs off",
    JSON.stringify(shaders(uOn)) === JSON.stringify(shaders(uOff)));
  uOn.dispose(); uOff.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- F3 one fused frame -------------------------------------------------");
{
  const p = fused;
  const T = p.particlesOverCloudsPass.renderTarget;
  const c = frame(p);
  const iW = c.findIndex((x) => x.scene === scene);
  const iA = c.findIndex((x) => x.scene === p.fxPass.scene);
  const iL = c.findIndex((x) => x.scene === p.particlesOverCloudsPass.scene);
  const lateScrub = p.composer.passes.find((x) => describe(x) === SCRUB);
  const iS = c.findIndex((x) => x.scene === lateScrub.scene);
  const iP = c.findIndex((x) => x.scene === p.fxPostPass.scene);
  check("order: world -> atmosphere pass -> late particles -> late scrub -> post half",
    iW >= 0 && iW < iA && iA < iL && iL < iS && iS < iP, `w=${iW} a=${iA} l=${iL} s=${iS} p=${iP}`);
  check("the atmosphere pass reads the world pass's colour (the MSAA world target's resolve)",
    !!p.msaaWorldTarget && c[iA].input === p.msaaWorldTarget.texture);
  check("... and writes T; the particles go into T after it", c[iA].target === T && c[iL].target === T);
  check("the late scrub reads T, the post half renders to screen", c[iS].input === T.texture && c[iP].target === null);
  check("no haze quad drawn (the effect did the haze)", !c.some((x) => x.scene === p.layeredHaze.scene));
  const u = p.layeredHaze.material.uniforms;
  check("the haze ran at its default strength through the effect",
    u.uHaze.value.x === p.layeredHaze.strength && p.layeredHaze.strength > 0 && p.layeredHaze.stats.frames === 1);
  check("its depth = the pass's stable depth copy, never T's depth attachment (no feedback)",
    !!u.tDepth.value && u.tDepth.value === p.fxPass.getDepthTexture() && u.tDepth.value !== T.depthTexture);

  const off = offOpts;
  const cOff = frame(off);
  const fs = (list, pp) => list.filter((x) => x.scene !== scene && x.scene?.name !== "sky" &&
    !(pp.ssaoPass && x.scene === pp.ssaoPass.scene) && !/^ParticlesOver/.test(x.scene?.name || ""));
  check("exactly two full-screen renders fewer than =off (same everything else)",
    c.length === cOff.length - 2 && fs(c, p).length === fs(cOff, off).length - 2, `fused=${c.length} off=${cOff.length}`);
  const uo = off.layeredHaze.material.uniforms;
  const same = LH.LAYER_HAZE_EFFECT_UNIFORMS.every((k) => {
    const x = u[k].value, y = uo[k].value;
    return typeof x === "number" ? x === y : x.equals(y);
  });
  check("every haze uniform the fused effect drew with == the =off pass's this frame", same);
  check("the pass stays the state owner (`__layerHaze` stats): fused marked, =off not",
    p.layeredHaze.stats.fused === true && off.layeredHaze.stats.fused === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- F4 shaders ---------------------------------------------------------");
{
  // The effect GLSL is LAYER_HAZE_FRAG with the pass I/O swapped for the
  // effect's: colour in as inputColor, depth from depthBuffer, out to outputColor.
  const asEffect = LH.LAYER_HAZE_FRAG
    .replace("uniform sampler2D inputBuffer;\n", "")
    .replace("uniform sampler2D tDepth;\n", "")
    .replace("varying vec2 vUv;\n", "")
    .replace("void main() {", "void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {")
    .replace("vec4 src = texture2D(inputBuffer, vUv);", "vec4 src = inputColor;")
    .replaceAll("gl_FragColor", "outputColor")
    .replaceAll("tDepth", "depthBuffer");
  check("LAYER_HAZE_EFFECT_FRAG == LAYER_HAZE_FRAG line for line (I/O aside)",
    asEffect === LH.LAYER_HAZE_EFFECT_FRAG, `\n${asEffect}\n----\n${LH.LAYER_HAZE_EFFECT_FRAG}`);
  const fsOn = fused.fxPass.fullscreenMaterial.fragmentShader;
  const fsOff = offOpts.fxPass.fullscreenMaterial.fragmentShader;
  check("compiled: the haze samples the material's depthBuffer at vUv (unprefixed), no tDepth",
    /texture2D\(depthBuffer, vUv\)\.r \* e\d+ULogFar/.test(fsOn) && !/\btDepth\b/.test(fsOn));
  const samplers = (s) => [...new Set([...s.matchAll(/uniform\s+(?:\w+\s+)?sampler\w*\s+(\w+)\s*;/g)].map((m) => m[1].replace(/^e\d+/, "")))].sort();
  check("compiled: the fused pass declares no sampler the =off atmosphere pass lacks (16-unit ANGLE cap)",
    JSON.stringify(samplers(fsOn)) === JSON.stringify(samplers(fsOff)), `${samplers(fsOn)} vs ${samplers(fsOff)}`);
  const mainCalls = [...fsOn.matchAll(/(e\d+)MainImage\(color0/g)].map((m) => m[1]);
  // (fxDistort is mainUv only: one mainImage call per effect that has one.)
  check("compiled: the scrub's mainImage runs first, the haze's last",
    mainCalls.length === fused.fxPass.effects.filter((e) => /mainImage/.test(e.getFragmentShader())).length &&
    mainCalls[0] === "e0" && fsOn.indexOf("bool e0HbNonFinite") >= 0 &&
    new RegExp(`${mainCalls[mainCalls.length - 1]}MainImage\\(const in vec4 inputColor[^)]*\\)\\s*\\{\\s*vec4 src = inputColor;`).test(fsOn));
  const mat = fused.fxPass.fullscreenMaterial.uniforms;
  const hu = fused.layeredHaze.material.uniforms;
  check("the compound material holds the pass's OWN uniform objects (one write reaches both)",
    LH.LAYER_HAZE_EFFECT_UNIFORMS.every((k) => Object.values(mat).includes(hu[k])));
  const scrubSrc = fused.fxPass.effects[0].getFragmentShader();
  check("fused scrub: exponent-bit non-finite test (wall 93), no isnan, alpha clamped like the pass's write",
    /floatBitsToUint/.test(scrubSrc) && !/isnan/.test(scrubSrc) && /clamp\(inputColor\.a, 0\.0, 1\.0\)/.test(scrubSrc));

  // Per texel (an unwarped sample is the texel itself): standalone = scrub,
  // then the EffectMaterial's write clamp `color0.a = clamp(color0.a, 0, 1)`;
  // fused = the fused scrub feeding the next effect directly.
  const nonFinite = (c) => c.some((x) => !Number.isFinite(x));
  const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
  const standalone = (c) => {
    const s = nonFinite(c) ? [0, 0, 0, 1] : c.map((x) => Math.max(x, 0));
    return [s[0], s[1], s[2], clamp01(s[3])];
  };
  const fusedScrub = (c) => (nonFinite(c) ? [0, 0, 0, 1] : [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0), clamp01(c[3])]);
  const texels = [[0.2, 0.5, 3.7, 1], [NaN, 0, 0, 1], [1, Infinity, 0, 1], [-0.19, 0.4, 0.1, 1],
    [0.3, 0.3, 0.3, 1.75], [0.3, 0.3, 0.3, 0], [0.1, -0.0, 2, -0.5], [0, 0, -Infinity, 1]];
  check("per texel: fused scrub == standalone scrub + write clamp (NaN, Inf, negative, alpha > 1, grass alpha 0)",
    texels.every((t) => JSON.stringify(fusedScrub(t)) === JSON.stringify(standalone(t))));
}

// ---------------------------------------------------------------------------
console.log("\n-- F5 strength 0 rule, flag combinations, dispose ---------------------");
{
  const p = fused;
  const u = p.layeredHaze.material.uniforms;
  skyDomeLive._lastSkyBlocked = true;
  frame(p);
  check("sky-blocked cell: the fused haze is a pass-through (strength 0)", u.uHaze.value.x === 0);
  skyDomeLive._lastSkyBlocked = false;
  frame(p);
  check("sky back: strength restored", u.uHaze.value.x === p.layeredHaze.strength);
  const ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 5000);
  ortho.position.set(0, 300, 0);
  ortho.updateMatrixWorld(true);
  frame(p, ortho);
  check("ortho camera (C-key top-down): pass-through, the pass state followed the switch",
    u.uHaze.value.x === 0 && p.layeredHaze.camera === ortho);
  frame(p, camera);
  check("back to perspective: hazing again", u.uHaze.value.x === p.layeredHaze.strength && p.layeredHaze.camera === camera);
}
{
  const p = build({}, "?nanScrub=off");
  check("?nanScrub=off, fused: no scrub anywhere, the haze still trails the atmosphere pass",
    !names(p).some((n) => /NanScrub/.test(n)) && effectNames(p.fxPass).at(-1) === "LayeredHazeEffect" &&
    !names(p).includes("LayeredHazePass"), names(p).join(" | "));
  // SKY-5 on the fused chain: the post half reads T, so the haze must be IN T.
  const T = p.particlesOverCloudsPass.renderTarget;
  const c = frame(p);
  const iA = c.findIndex((x) => x.scene === p.fxPass.scene);
  const iP = c.findIndex((x) => x.scene === p.fxPostPass.scene);
  check("?nanScrub=off, fused: the post half reads T, which the hazing atmosphere pass wrote first",
    iA >= 0 && iA < iP && c[iA].target === T && c[iP].input === T.texture &&
    p.layeredHaze.material.uniforms.uHaze.value.x === p.layeredHaze.strength, `a=${iA} p=${iP}`);
  p.dispose();
}
{
  const p = build({}, "?layerHaze=off");
  const n = names(p);
  check("?layerHaze=off, fused: the scrub leads the atmosphere pass, no haze, one scrub pass (the late one)",
    p.layeredHaze === null && p.layeredHazeEffect === null && effectNames(p.fxPass)[0] === "NanScrub" &&
    !effectNames(p.fxPass).includes("LayeredHazeEffect") && n.filter((x) => x === SCRUB).length === 1, n.join(" | "));
  p.dispose();
}
{
  const p = build({}, "?layerHaze=off&nanScrub=off");
  const q = build({ postFuse: false }, "?layerHaze=off&nanScrub=off");
  check("both off: fused == =off (nothing to fuse; the haze-off target pass either way)",
    JSON.stringify(names(p)) === JSON.stringify(names(q)) &&
    p.fxPass.fullscreenMaterial.fragmentShader === q.fxPass.fullscreenMaterial.fragmentShader);
  p.dispose(); q.dispose();
}
{
  const p = fused;
  let disposed = 0;
  const md = p.layeredHaze.material.dispose.bind(p.layeredHaze.material);
  p.layeredHaze.material.dispose = () => { disposed++; md(); };
  p.dispose();
  check("dispose: the haze pass (never in the composer) is disposed with its effect", disposed >= 1);
  check("dispose: `__layerHaze` dropped", window.__layerHaze === null);
}
offOpts.dispose();
offUrl.dispose();

unregister();
console.log(`\npost fuse: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
