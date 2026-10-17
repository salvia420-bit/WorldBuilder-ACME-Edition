// tests/clouds_main_pass.test.mjs
//
// `?cloudsMainPass=on` (opt-in, 2026-10-05; HANDOFF section 7 item 4): the
// volumetric CloudsEffect runs inside the MAIN atmosphere composer's one
// post-chain EffectPass, ahead of AerialPerspective (takram's documented
// integration), instead of in cloud_overlay.js's private EffectComposer +
// sky-scene quad.
//
//   C1  source: the pipeline's flag reader is a strict `=== "on"` opt-in, the
//       fxPass list carries `cloudsMain` between heatHaze and
//       aerialPerspective, adoption happens after `composer.addPass(fxPass)`,
//       and dispose keeps the effect single-owner.
//   C2  real CloudOverlay (vendored takram build, resolved by a loader hook):
//       adoptMainPass retires the private composer and the sky quad, wires
//       AerialPerspective's overlay/shadowLength proxies, and preRender in
//       main-pass mode never builds a second composer (no extra RenderPass).
//   C3  the raymarch is ARMED by preRender only: unarmed frames (indoors) skip
//       CloudsEffect.update and point the proxies at a transparent texture.
//   C4  real pmndrs EffectPass: the clouds effect lands BEFORE the
//       AerialPerspective stand-in and BEFORE ToneMapping in one pass, and the
//       pass asks the composer for its depth texture.
//   C5  releaseMainPass restores the legacy path.
//
// Fails on the pre-change code: CloudOverlay has no adoptMainPass and the
// pipeline has no cloudsMain slot.
//
// Run: node tests/clouds_main_pass.test.mjs

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
// node has no import map, so mirror that one entry with a resolve hook.
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
const { EffectPass, Effect, EffectAttribute, ToneMappingEffect } = await import("postprocessing");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
console.log("-- C1 pipeline source ---------------------------------------------");
const PIPE = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
check("cloudsMainPassEnabled is default-on with an =off escape",
  /export function cloudsMainPassEnabled\(\)[\s\S]{0,200}get\("cloudsMainPass"\) !== "off"/.test(PIPE));
// 2026-10-10 tier 1: fxDistort (UV warp, behind the heat haze) and fxGlow (ahead of lens flare / bloom);
// tier 2: fxDecals (ground marks, after the AO composite, before the clouds).
check("fxPass list: heatHaze, fxDistort, ssaoComposite, fxDecals, cloudsMain, aerialPerspective, ... fxGlow, ... toneMapping, colorGrade, dithering",
  /\.\.\.\[heatHaze, fxDistort, ssaoComposite, fxDecals, cloudsMain, aerialPerspective, horizonDissolve, fxGlow, lensFlare, bloom, vignette, toneMapping, colorGrade, dithering\]\.filter\(Boolean\)/.test(PIPE));
check("cloudsMain is null unless the flag is on",
  /const cloudOverlayForMain = cloudsMainPassEnabled\(\)\s*\?/.test(PIPE));
const addAt = PIPE.indexOf("composer.addPass(fxPass);");
const adoptAt = PIPE.indexOf("adoptMainPass({ aerialPerspective })");
check("adoption happens after the fxPass is added to the composer",
  addAt > 0 && adoptAt > addAt);
check("the clouds never get their own EffectPass in the pipeline",
  !/new EffectPass\([^)]*cloudsMain/.test(PIPE));
check("dispose releases the clouds and shields the effect from fxPass.dispose",
  /releaseMainPass\?\.\(\)/.test(PIPE) && /cloudsMain\.dispose = \(\) => \{\};/.test(PIPE));

// ---------------------------------------------------------------------------
console.log("\n-- C2 adoptMainPass on a real CloudOverlay ------------------------");
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 4000);
const overlay = new CloudOverlay({ camera, proceduralTextures: true });
const effect = overlay.volume.effect;
const skyScene = new THREE.Scene();
overlay.attachToSkyScene(skyScene);
check("legacy: the quad is in the sky scene before adoption", overlay.overlayMesh.parent === skyScene);
check("adoptMainPass exists", typeof overlay.adoptMainPass === "function");

// Stand-in for CloudsEffect.update (the real one needs a GL renderer). Own
// property, installed BEFORE adoption, so the gate wraps it.
let raymarches = 0;
effect.update = function () { raymarches++; };
const ap = { overlay: null, shadowLength: null };
const adopted = overlay.adoptMainPass({ aerialPerspective: ap });
check("adoptMainPass returns true", adopted === true);
check("mainPassActive", overlay.mainPassActive === true);
check("adopting twice is refused", overlay.adoptMainPass({ aerialPerspective: ap }) === false);
check("no private composer (no second RenderPass / EffectPass)", overlay.composer === null &&
  overlay._renderPass === null && overlay._cloudEffectPass === null);
check("the sky-scene quad is retired (no double composite)", overlay.overlayMesh.parent !== skyScene);
check("AerialPerspective got overlay + shadowLength proxies",
  ap.overlay && ap.shadowLength && ap.overlay.map?.isDataTexture === true && ap.shadowLength.map?.isDataTexture === true);
check("skipRendering stays true (AerialPerspective composites — takram default)", effect.skipRendering === true);

// A preRender in main-pass mode must not lazily build the legacy composer.
const calls = [];
const fakeRenderer = {
  getRenderTarget: () => null, setRenderTarget: () => calls.push("setRenderTarget"),
  render: () => calls.push("render"), getSize: (v) => v.set(1280, 720), autoClear: true,
};
const proxyOverlay = ap.overlay;
const proxyShadowLength = ap.shadowLength;
const blank = ap.overlay.map;

// ---------------------------------------------------------------------------
console.log("\n-- C3 the raymarch is armed by preRender only ---------------------");
effect.update(fakeRenderer, null, 0.016);
check("unarmed update (indoors / sky blocked) skips the raymarch", raymarches === 0);
check("…and leaves the overlay transparent", ap.overlay.map === blank && ap.shadowLength.map === blank);
overlay.preRender(fakeRenderer, 0.016, camera);
check("main-pass preRender issues no draw and builds no composer",
  calls.length === 0 && overlay.composer === null);
effect.update(fakeRenderer, null, 0.016);
check("armed update runs the raymarch exactly once", raymarches === 1);
check("…and points the overlay at the cloud buffer",
  ap.overlay.map === effect.cloudsPass.outputBuffer && ap.overlay.map !== blank);
effect.update(fakeRenderer, null, 0.016);
check("the arm is single-frame", raymarches === 1 && ap.overlay.map === blank);
check("proxy identities never change (no HAS_OVERLAY define flip / recompile)",
  ap.overlay === proxyOverlay && ap.shadowLength === proxyShadowLength);
overlay.renderOverlay(fakeRenderer);
check("renderOverlay draws nothing in main-pass mode", calls.length === 0);

// ---------------------------------------------------------------------------
console.log("\n-- C4 one EffectPass: clouds → aerial perspective → tone mapping ----");
const apStandIn = new Effect("AerialPerspectiveStandIn",
  "void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) { outputColor = inputColor; }",
  { attributes: EffectAttribute.DEPTH });
const tone = new ToneMappingEffect();
const fx = new EffectPass(camera, ...[null, effect, apStandIn, tone].filter(Boolean));
fx.recompile(); // builds the compound material; sets needsDepthTexture
const order = fx.effects;
check("clouds precede aerial perspective after pmndrs' attribute sort",
  order.indexOf(effect) >= 0 && order.indexOf(effect) < order.indexOf(apStandIn));
check("clouds precede ToneMapping in the same pass", order.indexOf(effect) < order.indexOf(tone));
check("the pass requests the composer's depth texture (clouds read real scene depth)",
  fx.needsDepthTexture === true);

// ---------------------------------------------------------------------------
console.log("\n-- C5 releaseMainPass ---------------------------------------------");
overlay.releaseMainPass();
check("mainPassActive false", overlay.mainPassActive === false);
check("AerialPerspective proxies cleared", ap.overlay === null && ap.shadowLength === null);
check("the original update is restored", (effect.update(), raymarches === 2));
check("the legacy sky quad is back", overlay.overlayMesh.parent === skyScene);

// ---------------------------------------------------------------------------
console.log("\n-- C6 window.__cloudStateDiag (cloudStateSnapshot) ---------------");
{
  const { cloudStateSnapshot, diagTextureInfo } = await import("../scene3d/cloud_overlay.js");
  const cm = effect.cloudsPass.currentMaterial;
  const progs = new Map();
  const reads = [];
  // binary16 of 0.5 / 1.0 / 0.25 / 2048 for the probe decode.
  const H = { 0.5: 0x3800, 1: 0x3c00, 0.25: 0x3400, 2048: 0x6800 };
  const diagRenderer = {
    properties: { get: (m) => { if (!progs.has(m)) progs.set(m, {}); return progs.get(m); } },
    getPixelRatio: () => 1,
    readRenderTargetPixels(rt, x, y, w, h, buf, _face, index = 0) {
      reads.push({ rt, x, y, index });
      if (buf instanceof Uint16Array) buf.set(index === 1 ? [H[2048], 0, 0, H[1]] : [H[0.5], H[0.25], H[0.5], H[1]]);
    },
  };
  effect.cloudsPass.setSize(64, 36);
  const s1 = cloudStateSnapshot(overlay, diagRenderer, {});
  check("noise source + per-texture identities (procedural = render-target textures)",
    s1.noise.source === "procedural" && s1.noise.procedural.shape?.needsRender === true &&
    s1.materials.clouds.textures.shapeTexture?.kind === "rt" &&
    s1.materials.clouds.textures.localWeatherTexture?.kind === "rt", JSON.stringify(s1.materials.clouds.textures.shapeTexture));
  check("boot timeline stamps (created, procedural install, adoption)",
    Number.isFinite(s1.timeline.created) && Number.isFinite(s1.timeline.procedural) && Number.isFinite(s1.timeline.adopted));
  const s2 = cloudStateSnapshot(overlay, diagRenderer, {});
  check("uniform digest is stable between calls", s1.materials.clouds.uniformsDigest === s2.materials.clouds.uniformsDigest);
  cm.uniforms.viewMatrix?.value?.makeTranslation?.(1, 2, 3);
  cm.uniforms.frame.value += 7;
  const s3 = cloudStateSnapshot(overlay, diagRenderer, {});
  check("camera / frame uniforms are outside the digest",
    s3.materials.clouds.uniformsDigest === s1.materials.clouds.uniformsDigest);
  const cov = effect.coverage;
  effect.coverage = cov + 0.05;
  const s4 = cloudStateSnapshot(overlay, diagRenderer, {});
  effect.coverage = cov;
  check("a look uniform (coverage) changes the digest",
    s4.materials.clouds.uniformsDigest !== s1.materials.clouds.uniformsDigest && s4.look.coverage === cov + 0.05);
  progs.get(cm).currentProgram = { id: 9, cacheKey: Object.keys(cm.defines).filter((d) => d !== "HAZE").join(",") };
  const s5 = cloudStateSnapshot(overlay, diagRenderer, {});
  check("a material define the linked program lacks is reported",
    s5.materials.clouds.program?.id === 9 &&
    JSON.stringify(s5.materials.clouds.program.definesNotInProgram) === (cm.defines.HAZE != null ? '["HAZE"]' : "[]"),
    JSON.stringify(s5.materials.clouds.program));
  check("probe: raw march colour + frontDepth and the resolved buffer, half floats decoded",
    JSON.stringify(s5.probe.march) === "[0.5,0.25,0.5,1]" && s5.probe.marchDepthVelocity[0] === 2048 &&
    JSON.stringify(s5.probe.resolved) === "[0.5,0.25,0.5,1]" &&
    reads.some((r) => r.rt === effect.cloudsPass.currentRenderTarget && r.index === 1) &&
    reads.some((r) => r.rt === effect.cloudsPass.historyRenderTarget), JSON.stringify(s5.probe));
  const s6 = cloudStateSnapshot(overlay, diagRenderer, {
    atmosphereRuntime: { ready: true, source: "bake", plan: "bandwidth:high", loadTimedOut: true, bakeMs: 812 },
  });
  check("LUT source / plan / timeout and the look are reported",
    s6.lut.source === "bake" && s6.lut.loadTimedOut === true && s6.lut.bakeMs === 812 &&
    Array.isArray(s6.look.layers) && s6.look.layers.length === 4 && s6.camera.near === camera.near);
  check("diagTextureInfo: prebaked Data3DTexture vs image texture vs null",
    diagTextureInfo(new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2)).kind === "data3d" &&
    diagTextureInfo(new THREE.Texture({ width: 4, height: 4, src: "x/local_weather.png" })).src === "local_weather.png" &&
    diagTextureInfo(null) === null);
  const bare = cloudStateSnapshot(null, null, {});
  check("no overlay / renderer -> partial snapshot, never throws", bare.noise.source === "prebaked" && bare.materials === undefined);
  const ix = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
  check("index.js installs window.__cloudStateDiag over the overlay's diagSnapshot",
    /window\.__cloudStateDiag = \(o\) => cloudOverlay\.diagSnapshot\(renderer, \{/.test(ix));
}

console.log(`\nclouds main pass: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
