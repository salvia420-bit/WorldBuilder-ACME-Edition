// tests/sky1_particles_over_haze.test.mjs — 2026-10-18 systematic review,
// SKY-1 remainder (docs/2026-10-18-systematic-code-review.md §10.5).
//
// The fix pass moved the `?layerHaze` pass in front of the late particle draw
// on the SPLIT chain (tests/sky_late_haze_camera.test.mjs). The UNSPLIT chain
// — no clouds in the post chain: low / mid by default, or `?clouds=off`,
// `?cloudsMainPass=off`, `?particlesOverClouds=off` — still drew the particles
// in the world pass and ran the haze over them afterwards, so a spell 30 m out
// against hills 3 km behind it was fogged by the hills' distance (particles
// write no depth). `?particlesOverHaze` (default on, `=off` escape) draws the
// same particle objects right after the haze, into the composer buffer the haze
// wrote, depth-tested against composer.depthTexture.
//
//   H1  flag parsing: absent / on / garbage -> on, off-forms -> off.
//   H2  pass list (mid: msaa 2 via ?msaaWorldOnly; low: msaa 0, no bloom): the
//       `=off` list with exactly one pass inserted, ParticlesOverHaze, between
//       LayeredHazePass and the post EffectPass. It owns no render target.
//   H3  one frame, mid and low: the spark is drawn EXACTLY ONCE — hidden in the
//       world pass, drawn by the late render, which runs after the haze and
//       before the post EffectPass, into the buffer the haze wrote (the one the
//       post pass reads), carrying composer.depthTexture. Cost: the `=off`
//       frame's render calls in the same order plus that one particle render;
//       no other target, no extra full-screen draw, no soft-particle hook.
//   H4  frames the late draw skips (the spark stays in the world pass, still
//       once): an indoor split frame; a sky-blocked cell and haze strength 0
//       (the haze is a pass-through there); `__particlesOverClouds.set(false)`.
//   H5  not built: `?particlesOverHaze=off` (URL, opts), `?layerHaze=off`,
//       `?msaaWorldOnly=off` (multisampled ping-pong buffers), and the split
//       chain (clouds in the main pass), which has its own late draw.
//   H6  a throw mid-chain restores the spark; dispose leaves the composer's
//       depth texture alone.
//
// Runs the REAL atmosphere pipeline (vendored takram via a resolve hook,
// a recording renderer), as tests/sky_late_haze_camera.test.mjs.
//
// Run: node tests/sky1_particles_over_haze.test.mjs

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
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

// ---------------------------------------------------------------------------
console.log("-- H1 ?particlesOverHaze parsing ------------------------------------");
{
  const f = POC.particlesOverHazeEnabled;
  check("the reader exists", typeof f === "function");
  if (typeof f === "function") {
    check("absent -> on", f("") === true && f("?particlesOverClouds=off") === true);
    check("on / garbage -> on", f("?particlesOverHaze=on") === true && f("?particlesOverHaze=banana") === true);
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      check(`${off} -> off`, f(`?particlesOverHaze=${off}`) === false);
    }
    check("no location (node) -> on", f() === true);
  }
}

// ---------------------------------------------------------------------------
const skyDome = { _lastIsIndoor: false, _lastSkyBlocked: false, syncSkyCamera() {} };
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
// layered_haze.js reads the sky-blocked flag off liveScene3d.skyDome.
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera, skyDome };
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8899aa, 10, 900);
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
terrain.position.set(0, -2, -3000);
scene.add(terrain);
// One additive "spell" 30 m out: the particle draw object.
const spark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
spark.position.set(0, 0, -30);
scene.add(spark);
const unregister = POC.registerLateFxSource((out) => out.push(spark));
// A soft-particle style hook: must not run on the unsplit chain (its depth copy
// would be a full-screen pass the default low / mid frame never paid).
let hookBefore = 0;
let hookAfter = 0;
const unhook = POC.registerLateFxHooks({ before() { hookBefore++; }, after() { hookAfter++; } });

/** Would three draw `o` in this render of `sc` with `cam`? */
function drawsObject(sc, cam, o) {
  if (!sc) return false;
  if (sc === scene) {
    if ((o.layers.mask & cam.layers.mask) === 0) return false;
    for (let p = o; p; p = p.parent) { if (p.visible === false) return false; if (p === scene) return true; }
    return false;
  }
  return Array.isArray(sc.children) && sc.children.includes(o);
}

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
    calls.push({
      scene: sc, target: this._target, input,
      depth: this._target ? this._target.depthTexture ?? null : null,
      spark: drawsObject(sc, cam, spark),
      terrain: drawsObject(sc, cam, terrain),
    });
  },
  clear() {}, clearDepth() {}, setClearColor() {}, getClearColor: (c) => c, getClearAlpha: () => 1, setClearAlpha() {},
  state: { buffers: { stencil: { setFunc() {} } } }, properties: { get: () => ({}) },
};

const { createAtmospherePipeline } = await import("../scene3d/atmosphere_pipeline.js");
const { CloudOverlay } = await import("../scene3d/cloud_overlay.js");
// `search` reaches the globalThis.location readers (particlesOverHaze,
// msaaWorldOnly, ...); `winSearch` the window.location ones (layerHaze).
function build(opts = {}, search = "", winSearch = "") {
  if (search) globalThis.location = { search };
  if (winSearch) window.location = { search: winSearch };
  try {
    const skyScene = new THREE.Scene(); skyScene.name = "sky";
    return quiet(() => createAtmospherePipeline(renderer, scene, camera, {
      // No CloudOverlay: the clouds are not in the post chain -> unsplit chain.
      atmosphereRuntime: { textures: {} }, cloudOverlay: null, skyScene, skyCamera: new THREE.PerspectiveCamera(),
      bloom: true, vignette: false, msaa: 2, portalPunch: true, punchRetail: true, ...opts,
    }));
  } finally {
    if (search) delete globalThis.location;
    if (winSearch) delete window.location;
  }
}
const LOW = { msaa: 0, bloom: false };
function frame(p) {
  scene.updateMatrixWorld(true);
  calls.length = 0;
  p.preFrameSkySync(skyDome, camera);
  p.render(camera, 1 / 60);
  return calls.slice();
}
const describe = (pass) => pass.name + (Array.isArray(pass.effects) ? `[${pass.effects.map((e) => e.name).join(",")}]` : "");
const names = (p) => p.composer.passes.map(describe);
const lateScene = (p) => p.particlesOverHazePass?.scene ?? null;
const sparkDraws = (cs) => cs.filter((c) => c.spark).length;
const ownTargets = (p) => p.composer.passes.flatMap((x) => Object.values(x).filter((o) => o && o.isWebGLRenderTarget));

// ---------------------------------------------------------------------------
for (const [tier, opts] of [["mid (msaa 2)", {}], ["low (msaa 0, no bloom)", LOW]]) {
  console.log(`\n-- H2/H3 ${tier}: the particles land after the haze, once ---------------`);
  // `off` first: `window.__particlesOverClouds` is the last-built pipeline's.
  const off = build({ ...opts, particlesOverHaze: false });
  const on = build(opts);
  const nOn = names(on);
  const nOff = names(off);
  check("fixture: unsplit chain with the default haze, no split-chain late pass",
    !!on.layeredHaze && on.particlesOverCloudsPass === null && on.fxPostPass === null && on.cloudsMainPass === false);
  check("fixture: single-sample ping-pong buffers", on.composer.multisampling === 0,
    `ms=${on.composer.multisampling}`);
  const iH = nOn.indexOf("LayeredHazePass");
  const iL = nOn.indexOf("ParticlesOverHaze");
  check("the late pass sits right after LayeredHazePass, right before the post EffectPass",
    iH >= 0 && iL === iH + 1 && on.composer.passes[iL + 1] === on.fxPass && iL + 1 === nOn.length - 1, nOn.slice(-4).join(" | "));
  const without = nOn.filter((n, i) => i !== iL);
  check("otherwise the pass list is the =off list exactly",
    without.length === nOff.length && without.every((n, i) => n === nOff[i]), `\n     on : ${nOn.join(" | ")}\n     off: ${nOff.join(" | ")}`);
  const late = on.particlesOverHazePass;
  check("the returned handle is that pass; it neither swaps nor blits depth",
    !!late && late === on.composer.passes[iL] && late.needsSwap === false && late.needsDepthBlit === false);
  check("no new render target: the late pass owns none, the passes own as many as with =off",
    late?.renderTarget === null && ownTargets(on).length === ownTargets(off).length,
    `on=${ownTargets(on).length} off=${ownTargets(off).length}`);

  hookBefore = 0; hookAfter = 0;
  const fOff = frame(off);
  const fOn = frame(on);
  check("=off frame (the old order): the spark is drawn once, in the world pass, BEFORE the haze",
    sparkDraws(fOff) === 1 && fOff.findIndex((c) => c.spark) < fOff.findIndex((c) => c.scene === off.layeredHaze.scene));
  check("EXACTLY ONCE: one draw of the spark in the whole frame", sparkDraws(fOn) === 1, `draws=${sparkDraws(fOn)}`);
  const iWorld = fOn.findIndex((c) => c.scene === scene);
  const iHaze = fOn.findIndex((c) => c.scene === on.layeredHaze.scene);
  const iLate = fOn.findIndex((c) => c.scene === lateScene(on));
  const iPost = fOn.findIndex((c) => c.scene === on.fxPass.scene);
  check("the world pass still draws the world, without the spark",
    iWorld >= 0 && fOn[iWorld].terrain === true && fOn[iWorld].spark === false);
  check("the spark's one draw is the late render, after the haze and before the post pass",
    iLate >= 0 && fOn[iLate].spark === true && iHaze < iLate && iLate < iPost, `h=${iHaze} l=${iLate} p=${iPost}`);
  check("the late render draws into the buffer the haze wrote, which the post pass then reads",
    !!fOn[iLate]?.target && fOn[iLate].target === fOn[iHaze].target && fOn[iPost].input === fOn[iLate].target.texture);
  check("... carrying the scene depth (composer.depthTexture) at the draw",
    !!on.composer.depthTexture && fOn[iLate]?.depth === on.composer.depthTexture);
  check("the haze read the world pass's image, not the buffer the particle goes into, at its default strength",
    !!fOn[iLate] && fOn[iHaze].input !== fOn[iLate].target?.texture &&
    on.layeredHaze.material.uniforms.uHaze.value.x === on.layeredHaze.strength && on.layeredHaze.strength > 0);
  // Each render call named by the composer pass that owns its scene.
  const owner = (p, sc) => {
    if (sc === scene) return "world";
    const pass = p.composer.passes.find((x) => x.scene === sc);
    // Otherwise an effect's own internal pass (bloom's luminance + mip blur).
    const m = sc?.children?.[0]?.material;
    return pass ? describe(pass) : `(${m?.name || m?.constructor?.name || "?"})`;
  };
  const seqOff = fOff.map((c) => owner(off, c.scene));
  const seqOn = fOn.filter((c, i) => i !== iLate).map((c) => owner(on, c.scene));
  check("cost: the =off frame's renders, pass for pass, plus that one particle render",
    fOn.length === fOff.length + 1 && seqOn.length === seqOff.length && seqOn.every((n, i) => n === seqOff[i]), `\n     on : ${seqOn.join(" > ")}\n     off: ${seqOff.join(" > ")}`);
  const targetsOn = new Set(fOn.map((c) => c.target).filter(Boolean));
  check("no target in the frame that the frame did not already draw into (late = the haze's target)",
    [...targetsOn].every((t) => fOn.some((c, i) => i !== iLate && c.target === t)));
  check("no soft-particle hook ran (no depth copy pass)", hookBefore === 0 && hookAfter === 0, `before=${hookBefore} after=${hookAfter}`);
  check("after the frame: the spark is visible again, the late scene is empty",
    spark.visible === true && lateScene(on)?.children.length === 0);
  check("the late scene shares the world's Fog OBJECT (fog kept, no program change)", lateScene(on)?.fog === scene.fog);
  const st = window.__particlesOverClouds.stats();
  check("stats: overHaze, drawn, one object", st.overHaze === true && st.built === false && st.drawnFrames >= 1 && st.objects === 1,
    JSON.stringify(st));
  on.dispose();
  off.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- H4 frames the late draw skips: the spark stays in the world pass ------");
{
  const p = build();
  const inWorldOnce = (cs) => sparkDraws(cs) === 1 && cs.find((c) => c.spark)?.scene === scene &&
    !cs.some((c) => c.scene === lateScene(p));

  p.setIndoorSplitArmed(true);
  skyDome._lastIsIndoor = true;
  check("indoor split frame: legacy passes, no late render, spark once", inWorldOnce(frame(p)) && p.particlesOverHazePass?.enabled === false);
  check("... counted as a split frame", window.__particlesOverClouds.stats().skippedSplitFrames >= 1);
  p.setIndoorSplitArmed(false);
  skyDome._lastIsIndoor = false;
  check("back outdoors: the late draw resumes", sparkDraws(frame(p)) === 1 && p.particlesOverHazePass?.enabled === true &&
    calls.some((c) => c.scene === lateScene(p) && c.spark));

  skyDome._lastSkyBlocked = true;
  check("sky-blocked cell (the haze is a pass-through): no late render, spark once", inWorldOnce(frame(p)));
  check("... the haze really was a pass-through", p.layeredHaze.material.uniforms.uHaze.value.x === 0);
  check("... counted", window.__particlesOverClouds.stats().skippedNoHazeFrames >= 1);
  skyDome._lastSkyBlocked = false;

  window.__layerHaze.strength = 0;
  check("`__layerHaze.strength = 0`: no late render, spark once", inWorldOnce(frame(p)));
  window.__layerHaze.strength = 0.4;
  check("strength back: the late draw resumes", calls.length && sparkDraws(frame(p)) === 1 && calls.some((c) => c.scene === lateScene(p) && c.spark));

  const s = window.__particlesOverClouds.set(false);
  check("__particlesOverClouds.set(false) disarms this chain's late draw too", s.armed === false && p.particlesOverHazePass?.enabled === false);
  check("disarmed: spark once, in the world pass", inWorldOnce(frame(p)));
  window.__particlesOverClouds.set(true);
  check("set(true): back to the late draw", sparkDraws(frame(p)) === 1 && calls.some((c) => c.scene === lateScene(p) && c.spark));

  // A throw inside the composer must not leave the spark hidden.
  const realRender = renderer.render;
  renderer.render = function (sc) { if (sc === p.fxPass.scene) throw new Error("boom"); return realRender.apply(this, arguments); };
  let threw = false;
  try { frame(p); } catch (_) { threw = true; }
  renderer.render = realRender;
  check("H6 a throw mid-chain still restores the spark", threw && spark.visible === true);
  const depth = p.composer.depthTexture;
  p.dispose();
  check("H6 dispose: no target to free, the composer's depth texture untouched",
    p.particlesOverHazePass?.renderTarget === null && p.composer.depthTexture === depth);
}

// ---------------------------------------------------------------------------
console.log("\n-- H5 not built -------------------------------------------------------");
{
  const cases = [
    ["?particlesOverHaze=off (URL)", () => build({}, "?particlesOverHaze=off")],
    ["opts.particlesOverHaze = false", () => build({ particlesOverHaze: false })],
    ["?layerHaze=off (nothing to draw over)", () => build({}, "", "?layerHaze=off")],
    ["?msaaWorldOnly=off at msaa 2 (multisampled ping-pong buffers)", () => build({}, "?msaaWorldOnly=off")],
  ];
  for (const [label, mk] of cases) {
    const p = mk();
    const fr = frame(p);
    check(`${label}: no late pass; spark once, in the world pass`,
      (p.particlesOverHazePass ?? null) === null && !names(p).includes("ParticlesOverHaze") &&
      sparkDraws(fr) === 1 && fr.find((c) => c.spark)?.scene === scene, names(p).slice(-3).join(" | "));
    if (/msaaWorldOnly/.test(label)) check("... (the fixture really has multisampled buffers)", p.composer.multisampling > 0);
    p.dispose();
  }
  // The split chain (clouds in the main pass) has its own late draw.
  const skyScene = new THREE.Scene(); skyScene.name = "sky";
  const overlay = new CloudOverlay({ camera, proceduralTextures: true });
  overlay.attachToSkyScene(skyScene);
  const p = quiet(() => createAtmospherePipeline(renderer, scene, camera, {
    atmosphereRuntime: { textures: {} }, cloudOverlay: overlay, skyScene, skyCamera: new THREE.PerspectiveCamera(),
    bloom: true, vignette: false, msaa: 2, portalPunch: true, punchRetail: true,
  }));
  hookBefore = 0;
  const fr = frame(p);
  check("split chain: its own late pass, no ParticlesOverHaze",
    !!p.particlesOverCloudsPass && (p.particlesOverHazePass ?? null) === null && !names(p).includes("ParticlesOverHaze"));
  check("split chain: the spark once, in its late pass, which still runs the hooks",
    sparkDraws(fr) === 1 && fr.find((c) => c.spark)?.scene === p.particlesOverCloudsPass.scene && hookBefore === 1);
  p.dispose();
}

unhook();
unregister();
console.log(`\nsky1 particles over haze: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
