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
// 2026-10-10 tier 1: fxDistort (UV warp, behind the heat haze) and fxGlow (ahead of lens flare / bloom).
check("fxPass list: heatHaze, fxDistort, ssaoComposite, cloudsMain, aerialPerspective, ... fxGlow, ... toneMapping, colorGrade, dithering",
  /\.\.\.\[heatHaze, fxDistort, ssaoComposite, cloudsMain, aerialPerspective, horizonDissolve, fxGlow, lensFlare, bloom, vignette, toneMapping, colorGrade, dithering\]\.filter\(Boolean\)/.test(PIPE));
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

console.log(`\nclouds main pass: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
