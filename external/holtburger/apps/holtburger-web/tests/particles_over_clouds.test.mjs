// tests/particles_over_clouds.test.mjs
//
// `?particlesOverClouds` (2026-10-07, DEFAULT ON, `=off` escape). Owner, 1070:
// "clouds are over particle effect shouldnt be". With `?cloudsMainPass` the
// clouds are composited by AerialPerspective AFTER the world pass, so every
// additive (depthWrite:false) particle against the sky got the cloud laid over
// it. Fix: split the post chain and draw the particles between the cloud +
// aerial composite and bloom, into a private target that borrows the
// composer's scene depth texture.
//
//   P1  flag parsing: absent / on / garbage -> on, off-forms -> off.
//   P2  collectLateFx: dedupe, hidden ancestor, detached, layer mask, lit
//       material, throwing source.
//   P3  REAL ParticleManager: the collector hands over the additive bucket,
//       the alpha bucket and per-mesh slot meshes, never the sky chain
//       (patched `-sky` bucket or not).
//   P4  REAL pipeline (vendored takram via a resolve hook, recording renderer):
//       pass order; the first half never swaps and writes the late target;
//       the second half reads it; the late target is single-sample and gets
//       composer.depthTexture; one composer.render draws every particle
//       exactly once — hidden in the world pass, drawn in the late pass after
//       the cloud/aerial pass and before bloom — the -sky bucket stays in the
//       world pass, and everything is visible again afterwards.
//   P5  split frame (indoor depth split armed): legacy passes, no late draw.
//   P6  `__particlesOverClouds.set(false)` A/B without a reload.
//   P7  `=off` (URL and opts): the legacy single EffectPass, no late pass, the
//       particles drawn in the world pass.
//   P8  `?cloudsMainPass=off`: no split even with the flag on (the legacy
//       overlay is drawn by the sky pass, already behind the world).
//   P9  wiring: url-flags.md row, harness registration, the two sources
//       (particle_manager collector, play_effect_vfx placeholder bursts).
//
// Fails on the pre-change code: particles_over_clouds.js does not exist, the
// pipeline has one post-chain EffectPass and particles render in the world
// pass under the cloud composite.
//
// Run: node tests/particles_over_clouds.test.mjs

import { register } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;

// index.html's import map, mirrored for node.
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

// ---------------------------------------------------------------------------
console.log("-- P1 ?particlesOverClouds parsing -----------------------------------");
check("absent -> on", POC.particlesOverCloudsEnabled("") === true);
check("on -> on", POC.particlesOverCloudsEnabled("?particlesOverClouds=on") === true);
check("garbage -> on", POC.particlesOverCloudsEnabled("?particlesOverClouds=banana") === true);
for (const off of ["off", "0", "false", "no", "OFF"]) {
  check(`${off} -> off`, POC.particlesOverCloudsEnabled(`?particlesOverClouds=${off}`) === false);
}
check("no location (node) -> on", POC.particlesOverCloudsEnabled() === true);

// ---------------------------------------------------------------------------
console.log("\n-- P2 collectLateFx filtering ----------------------------------------");
{
  const root = new THREE.Scene();
  const g = new THREE.Group(); root.add(g);
  const basic = () => new THREE.MeshBasicMaterial();
  const geo = new THREE.PlaneGeometry(1, 1);
  const ok = new THREE.Mesh(geo, basic()); g.add(ok);
  const l1 = new THREE.Mesh(geo, basic()); l1.layers.set(1); g.add(l1);
  const l2 = new THREE.Mesh(geo, basic()); l2.layers.set(2); g.add(l2);
  const hiddenSelf = new THREE.Mesh(geo, basic()); hiddenSelf.visible = false; g.add(hiddenSelf);
  const hiddenParent = new THREE.Group(); hiddenParent.visible = false; root.add(hiddenParent);
  const underHidden = new THREE.Mesh(geo, basic()); hiddenParent.add(underHidden);
  const detached = new THREE.Mesh(geo, basic());
  const lit = new THREE.Mesh(geo, new THREE.MeshStandardMaterial()); g.add(lit);
  const litArr = new THREE.Mesh(geo, [basic(), new THREE.MeshLambertMaterial()]); g.add(litArr);
  const litShader = new THREE.Mesh(geo, new THREE.ShaderMaterial({ lights: true })); g.add(litShader);
  const unlitShader = new THREE.Mesh(geo, new THREE.ShaderMaterial()); g.add(unlitShader);
  const src = (out) => out.push(ok, ok, l1, l2, hiddenSelf, underHidden, detached, lit, litArr, litShader, unlitShader, null);
  const bad = () => { throw new Error("boom"); };
  const un1 = POC.registerLateFxSource(src);
  const un2 = POC.registerLateFxSource(bad);
  const stats = {};
  const out = POC.collectLateFx([1, 2, 3], root, (1 << 0) | (1 << 1), stats);
  check("kept: the visible unlit objects on layers 0/1, once each",
    out.length === 3 && out.includes(ok) && out.includes(l1) && out.includes(unlitShader),
    out.map((o) => o?.id).join(","));
  check("dropped: off-mask layer, hidden self, hidden ancestor, detached",
    !out.includes(l2) && !out.includes(hiddenSelf) && !out.includes(underHidden) && !out.includes(detached));
  check("dropped: lit materials (Standard, Lambert in an array, lit ShaderMaterial)",
    !out.includes(lit) && !out.includes(litArr) && !out.includes(litShader) && stats.rejectedLit === 3, `rejectedLit=${stats.rejectedLit}`);
  check("a throwing source is counted, not fatal", stats.sourceErrors === 1);
  check("the input array is cleared first (no stale entries)", !out.includes(1));
  un1(); un2();
  check("unregister", POC.collectLateFx([], root, 3).length === 0);
}

// ---------------------------------------------------------------------------
// Shared fixture: two REAL ParticleManagers in a main scene.
const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
let t = 1000;
setCurrentTime(() => t);
const PM = await import("../scene3d/particles/particle_manager.js");
const { ParticleManager, collectParticlesOverClouds } = PM;
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera };
const quad = new THREE.PlaneGeometry(1, 1);
const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
tex.needsUpdate = true;
const GFX_ADD = 0x01000b01, GFX_ALPHA = 0x01000b02, GFX_SKY = 0x01001a61, GFX_MESH = 0x01000b04;
const baseAdd = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
baseAdd.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
const baseAlpha = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
baseAlpha.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
const baseSky = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
baseSky.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10102 };
const baseMesh = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
baseMesh.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
const bases = new Map([[GFX_ADD, baseAdd], [GFX_ALPHA, baseAlpha], [GFX_SKY, baseSky], [GFX_MESH, baseMesh]]);
const info = (hw) => ({
  id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: hw,
  birthrate: 10, maxParticles: 4, initialParticles: 4, totalParticles: 0, totalSeconds: 0,
  lifespan: 600, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
  minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 1, finalScale: 1,
  transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
});
const mk = (instancing, group) => new ParticleManager({
  scene: group, instancing,
  geometryFactory: () => quad,
  materialFactory: (hw) => bases.get(hw >>> 0),
});
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8899aa, 10, 900);
const staticsGroup = new THREE.Group(); staticsGroup.name = "staticsGroup"; scene.add(staticsGroup);
const entitiesGroup = new THREE.Group(); entitiesGroup.name = "entitiesGroup"; scene.add(entitiesGroup);
const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -30); staticsGroup.add(anchor);
const skyAnchor = new THREE.Object3D(); skyAnchor.position.set(0, 0, -600); staticsGroup.add(skyAnchor);
const anchor2 = new THREE.Object3D(); anchor2.position.set(0, 0, -20); entitiesGroup.add(anchor2);
// A non-particle world mesh, for the "world pass still draws the world" check.
const terrain = new THREE.Mesh(quad, new THREE.MeshStandardMaterial()); terrain.name = "terrain"; scene.add(terrain);
const mgr = mk(true, staticsGroup);      // instanced: additive + alpha + sky-chain buckets
const mgrMesh = mk(false, entitiesGroup); // per-mesh slot meshes (?particleInstancing=off analogue)
await mgr.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
await mgr.addEmitter({ emitterInfo: info(GFX_ALPHA), parent: anchor });
await mgr.addEmitter({ emitterInfo: info(GFX_SKY), parent: skyAnchor, skyGlow: true });
await mgrMesh.addEmitter({ emitterInfo: info(GFX_MESH), parent: anchor2 });
const tickAll = () => { for (let i = 0; i < 3; i += 1) { t += 0.016; mgr.tick(); mgrMesh.tick(); } };
tickAll();
scene.updateMatrixWorld(true);
const ims = staticsGroup.children.filter((o) => o.isInstancedMesh);
const imAdd = ims.find((o) => o.userData.gfxObjId === GFX_ADD && !o.userData.alpha);
const imAlpha = ims.find((o) => o.userData.gfxObjId === GFX_ALPHA && o.userData.alpha);
const imSky = ims.find((o) => o.userData.gfxObjId === GFX_SKY);
const meshParts = () => entitiesGroup.children.filter((o) => o.isMesh && o.userData.__particle && o.visible);

// ---------------------------------------------------------------------------
console.log("\n-- P3 real ParticleManager collector ---------------------------------");
{
  check("fixture: additive, alpha and sky-chain buckets exist with instances",
    !!imAdd && !!imAlpha && !!imSky && imAdd.count > 0 && imAlpha.count > 0 && imSky.count > 0,
    ims.map((o) => `${o.name}:${o.count}`).join(","));
  check("fixture: the sky bucket carries the sky-chain marker", imSky?.userData.skyChain === true);
  check("fixture: live per-mesh slot meshes under entitiesGroup", meshParts().length > 0, `n=${meshParts().length}`);
  const raw = [];
  collectParticlesOverClouds(raw);
  check("raw collector: additive + alpha buckets", raw.includes(imAdd) && raw.includes(imAlpha));
  check("raw collector: every live per-mesh slot mesh", meshParts().every((m) => raw.includes(m)));
  check("raw collector: NEVER the sky chain", !raw.includes(imSky));
  const out = POC.collectLateFx([], scene, 3);
  check("filtered collect == additive + alpha + per-mesh, nothing else",
    out.length === 2 + meshParts().length && !out.includes(terrain) && !out.includes(imSky));
  // Unpatched sky-chain bucket (e.g. the map-less storm lightning box, or
  // ?skyGlow=off): skyGlow false but still the sky chain.
  const skyGlowFlag = imSky.userData.skyGlow;
  imSky.userData.skyGlow = false;
  const raw2 = []; collectParticlesOverClouds(raw2);
  check("an UNPATCHED sky-chain bucket is still excluded (skyChain marker)", !raw2.includes(imSky));
  imSky.userData.skyGlow = skyGlowFlag;
}

// ---------------------------------------------------------------------------
// Recording renderer: enough of WebGLRenderer for EffectComposer + the passes.
const W = 1280, H = 720;
const gl = new Proxy({ getContextAttributes: () => ({ alpha: false }), getExtension: () => null, getParameter: () => 0 }, {
  get(tgt, k) {
    if (k in tgt) return tgt[k];
    return typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => null;
  },
});
let tracked = [];
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
    const rec = { scene: sc, target: this._target, mask: cam?.layers?.mask };
    if (sc === scene) rec.visible = new Map(tracked.map((o) => [o, o.visible]));
    if (sc && sc.name === "ParticlesOverClouds.Scene") rec.children = sc.children.slice();
    calls.push(rec);
  },
  clear() {}, clearDepth() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
  state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
};

const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
function build(opts = {}) {
  const skyScene = new THREE.Scene(); skyScene.name = "sky";
  const skyCamera = new THREE.PerspectiveCamera();
  const overlay = new CloudOverlay({ camera, proceduralTextures: true });
  overlay.attachToSkyScene(skyScene);
  const p = createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera,
    bloom: true, vignette: false, msaa: 2, portalPunch: true, punchRetail: true, ...opts,
  });
  return { p, overlay, skyScene };
}
const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
const describe = (pass) => pass.name + (Array.isArray(pass.effects) ? `[${pass.effects.map((e) => e.name).join(",")}]` : "");
function frame(p) {
  tickAll();
  scene.updateMatrixWorld(true);
  tracked = [imAdd, imAlpha, imSky, terrain, ...meshParts()];
  calls.length = 0;
  p.preFrameSkySync(skyDome, camera);
  p.render(camera, 0);
}
const worldCalls = () => calls.filter((c) => c.scene === scene);
const lateCalls = () => calls.filter((c) => c.scene?.name === "ParticlesOverClouds.Scene");
const lateObjects = () => [imAdd, imAlpha, ...meshParts()];

// ---------------------------------------------------------------------------
console.log("\n-- P4 the real pipeline ---------------------------------------------");
const A = build();
{
  const { p } = A;
  const names = p.composer.passes.map(describe);
  const at = (re) => names.findIndex((n) => re.test(n));
  const iRestore = at(/^CameraLayerMask\(Restore\)$/);
  const iScrub = at(/NanScrub/);
  const iAtmos = at(/^EffectPass\[CloudsEffect,AerialPerspectiveEffect\]$/);
  const iLate = at(/^ParticlesOverClouds$/);
  const iPost = at(/^EffectPass\[BloomEffect,ToneMappingEffect,ColorGradeEffect,DitheringEffect\]$/);
  console.log("     " + names.slice(iRestore).join(" -> "));
  check("clouds adopted into the main pass (the bug's precondition)", p.cloudsMainPass === true);
  // 2026-10-07 (later): the late target is scrubbed again before bloom (1070:
  // negative-radiance pixels in T brought the black flashing back).
  const iLateScrub = names.findLastIndex((n) => /^EffectPass\[NanScrub\]$/.test(n));
  // 2026-10-08 — ?layerHaze (default on) sits between the late scrub and the
  // post half: haze in HDR over the finished scene, before bloom/tone mapping.
  const iHaze = names.indexOf("LayeredHazePass");
  check("order: Restore -> NanScrub -> [Clouds, Aerial] -> ParticlesOverClouds -> NanScrub -> LayeredHaze -> [Bloom, ToneMapping, ColorGrade, Dithering]",
    iRestore >= 0 && iRestore < iScrub && iScrub < iAtmos && iAtmos < iLate && iLate < iLateScrub &&
    iLateScrub === iHaze - 1 && iHaze === iPost - 1 && iPost === names.length - 1,
    names.join(" | "));
  check("the late scrub reads the late target, swaps, and the post half reads the composer input",
    p.composer.passes[iLateScrub]._latePass?.() === p.particlesOverCloudsPass && p.composer.passes[iLateScrub].needsSwap === true &&
    p.fxPostPass._latePass?.() === null);
  check("the clouds never get their own EffectPass (they share AerialPerspective's)",
    names.filter((n) => /CloudsEffect/.test(n)).length === 1);
  check("bloom/tone mapping are NOT in the atmosphere half (particles still bloom)",
    !/Bloom|ToneMapping/.test(names[iAtmos]));
  check("returned handles: fxPass = atmosphere half, fxPostPass = post half",
    p.fxPass === p.composer.passes[iAtmos] && p.fxPostPass === p.composer.passes[iPost] &&
    p.particlesOverCloudsPass === p.composer.passes[iLate]);
  check("the atmosphere half never swaps the ping-pong buffers (even after a recompile)",
    p.fxPass.needsSwap === false && (p.fxPass.recompile(), p.fxPass.needsSwap === false));
  check("the late pass neither swaps nor blits depth",
    p.particlesOverCloudsPass.needsSwap === false && p.particlesOverCloudsPass.needsDepthBlit === false);
  check("only the post half renders to screen",
    p.fxPostPass.renderToScreen === true && p.fxPass.renderToScreen === false && p.particlesOverCloudsPass.renderToScreen === false);
  const rt = p.particlesOverCloudsPass.renderTarget;
  check("late target: single-sample RGBA16F at the drawing-buffer size",
    rt.samples === 0 && rt.texture.type === THREE.HalfFloatType && rt.width === W && rt.height === H,
    `samples=${rt.samples} ${rt.width}x${rt.height} composerSamples=${p.composer.multisampling}`);
  check("composer buffers are MSAA (why a private single-sample target)", p.composer.multisampling === 2);

  frame(p);
  const atmosScene = p.fxPass.scene;
  const postScene = p.fxPostPass.scene;
  const idx = (pred) => calls.findIndex(pred);
  const iW = idx((c) => c.scene === scene);
  const iA = idx((c) => c.scene === atmosScene);
  const iL = idx((c) => c.scene?.name === "ParticlesOverClouds.Scene");
  const iP = idx((c) => c.scene === postScene);
  check("one world render, one late render", worldCalls().length === 1 && lateCalls().length === 1,
    `world=${worldCalls().length} late=${lateCalls().length}`);
  check("draw order: world -> cloud/aerial composite -> particles -> bloom/tone map",
    iW >= 0 && iW < iA && iA < iL && iL < iP, `w=${iW} a=${iA} l=${iL} p=${iP}`);
  check("the composite writes the late target, the particles draw into it",
    calls[iA]?.target === rt && calls[iL]?.target === rt);
  check("the post half renders to screen", calls[iP]?.target === null);
  const lateScrubPass = p.composer.passes[iLateScrub];
  check("the late scrub's input is the late target", lateScrubPass.fullscreenMaterial.uniforms.inputBuffer.value === rt.texture);
  check("the post half's input is NOT the late target (it reads the scrubbed copy)",
    p.fxPostPass.fullscreenMaterial.uniforms.inputBuffer.value !== rt.texture);
  check("late target depth = composer.depthTexture (the scene depth, no copy)",
    !!p.composer.depthTexture && rt.depthTexture === p.composer.depthTexture);
  const w = worldCalls()[0];
  const late = lateCalls()[0];
  const objs = lateObjects();
  check("world pass: every particle draw object HIDDEN", objs.every((o) => w.visible.get(o) === false));
  check("world pass: the -sky bucket still drawn there (behind the clouds)", w.visible.get(imSky) === true);
  check("world pass: the world itself untouched", w.visible.get(terrain) === true);
  check("late pass: exactly the particle draw objects, never the sky bucket",
    late.children.length === objs.length && objs.every((o) => late.children.includes(o)) && !late.children.includes(imSky),
    `late=${late.children.length} want=${objs.length}`);
  check("late pass: with both world layers on the camera", (late.mask & 3) === 3);
  // No double draw: each particle object is drawn by exactly one of the two renders.
  const drawnWorld = (o) => w.visible.get(o) === true;
  const drawnLate = (o) => late.children.includes(o);
  check("NO double draw: every particle in exactly one pass",
    [...objs, imSky].every((o) => drawnWorld(o) !== drawnLate(o)));
  check("after the frame: everything visible again, late scene emptied",
    objs.every((o) => o.visible === true) && p.particlesOverCloudsPass.scene.children.length === 0);
  check("the late scene shares the world's Fog OBJECT (fog kept, no program change)",
    p.particlesOverCloudsPass.scene.fog === scene.fog);
  const st = window.__particlesOverClouds.stats();
  check("stats surface: built, armed, counts", st.built === true && st.armed === true && st.objects === objs.length &&
    st.buckets === 2 && st.meshes === objs.length - 2 && st.drawnFrames === 1, JSON.stringify(st));
  check("stats surface: target reports the composer depth texture", /composer\.depthTexture/.test(st.target), st.target);
  check("passes() lists the split chain", window.__particlesOverClouds.passes().some((n) => n === "ParticlesOverClouds"));

  // A throw inside the composer must not leave the particles hidden.
  const realRender = renderer.render;
  renderer.render = function (sc) { if (sc === atmosScene) throw new Error("boom"); return realRender.apply(this, arguments); };
  let threw = false;
  try { frame(p); } catch (_) { threw = true; }
  renderer.render = realRender;
  check("a throw mid-chain still restores every particle", threw && objs.every((o) => o.visible === true));
}

// ---------------------------------------------------------------------------
console.log("\n-- P5 split frame (indoor depth split armed) -------------------------");
{
  const { p } = A;
  p.setIndoorSplitArmed(true);
  skyDome._lastIsIndoor = true;
  frame(p);
  check("late pass disabled on the split frame", p.particlesOverCloudsPass.enabled === false);
  check("no late render; the particles stay in their legacy passes",
    lateCalls().length === 0 && worldCalls().every((c) => lateObjects().every((o) => c.visible.get(o) === true)));
  check("skipped split frame counted", window.__particlesOverClouds.stats().skippedSplitFrames >= 1);
  p.setIndoorSplitArmed(false);
  skyDome._lastIsIndoor = false;
  frame(p);
  check("back outdoors: the late draw resumes", lateCalls().length === 1 && p.particlesOverCloudsPass.enabled === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- P6 A/B without a reload ------------------------------------------");
{
  const { p } = A;
  const s = window.__particlesOverClouds.set(false);
  check("set(false) disarms", s.armed === false && p.particlesOverCloudsPass.enabled === false);
  frame(p);
  check("disarmed: particles drawn in the world pass, no late render",
    lateCalls().length === 0 && lateObjects().every((o) => worldCalls()[0].visible.get(o) === true));
  window.__particlesOverClouds.set(true);
  frame(p);
  check("set(true): back to the late draw next frame", lateCalls().length === 1 && window.__particlesOverClouds.armed === true);
  p.dispose();
  check("dispose leaves the borrowed depth texture alone (detached first)",
    p.particlesOverCloudsPass.renderTarget.depthTexture === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- P7 =off restores the legacy chain ----------------------------------");
for (const how of ["opts", "url"]) {
  let built;
  if (how === "url") {
    globalThis.location = { search: "?particlesOverClouds=off" };
    built = build();
    delete globalThis.location;
  } else {
    built = build({ particlesOverClouds: false });
  }
  const { p } = built;
  const names = p.composer.passes.map(describe);
  // 2026-10-08 — unsplit chain: the post EffectPass also tone-maps, so the
  // ?layerHaze pass goes in front of it (after the scrub).
  check(`${how}: ONE post-chain EffectPass with clouds -> aerial -> bloom -> tone map -> dither`,
    names[names.length - 1] === "EffectPass[CloudsEffect,AerialPerspectiveEffect,BloomEffect,ToneMappingEffect,ColorGradeEffect,DitheringEffect]" &&
    names[names.length - 2] === "LayeredHazePass" &&
    names[names.length - 3] === "EffectPass[NanScrub]", names.slice(-3).join(" | "));
  check(`${how}: no late pass, no post half`, !names.includes("ParticlesOverClouds") &&
    p.particlesOverCloudsPass === null && p.fxPostPass === null);
  frame(p);
  check(`${how}: particles drawn in the world pass, no late render`,
    lateCalls().length === 0 && lateObjects().every((o) => worldCalls()[0].visible.get(o) === true));
  check(`${how}: stats say why`, window.__particlesOverClouds.stats().why === "flag off");
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- P8 ?cloudsMainPass=off: nothing to fix, no split -------------------");
{
  globalThis.location = { search: "?cloudsMainPass=off" };
  const { p } = build();
  delete globalThis.location;
  const names = p.composer.passes.map(describe);
  check("legacy overlay path: one post-chain pass, no clouds in it, no late pass",
    !names.includes("ParticlesOverClouds") && !names.some((n) => /CloudsEffect/.test(n)) && p.cloudsMainPass === false,
    names.slice(-2).join(" | "));
  check("stats explain it", /clouds not in the main pass/.test(window.__particlesOverClouds.stats().why));
  p.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- P9 wiring ---------------------------------------------------------");
{
  const DOC = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  check("url-flags.md row", /^\| `particlesOverClouds` \|/m.test(DOC));
  const HARNESS = readFileSync(path.join(APP, "harness", "run-js-headless.mjs"), "utf8");
  check("registered in the JS gate", HARNESS.includes("tests/particles_over_clouds.test.mjs"));
  const PMSRC = readFileSync(path.join(APP, "scene3d", "particles", "particle_manager.js"), "utf8");
  check("particle_manager registers its collector", /registerLateFxSource\(collectParticlesOverClouds\)/.test(PMSRC));
  const PEV = readFileSync(path.join(APP, "scene3d", "play_effect_vfx.js"), "utf8");
  check("placeholder spell bursts join the late group (live set kept by acquire/release)",
    /registerLateFxSource\(\(out\) => \{ for \(const m of _liveBursts\) out\.push\(m\); \}\)/.test(PEV) &&
    /_liveBursts\.add\(mesh\);\s*\n\s*return mesh;/.test(PEV) &&
    /function _releaseBurstMesh\(mesh\) \{\s*\n\s*if \(!mesh\) return;\s*\n\s*_liveBursts\.delete\(mesh\);/.test(PEV));
}

console.log(`\nparticles over clouds: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
