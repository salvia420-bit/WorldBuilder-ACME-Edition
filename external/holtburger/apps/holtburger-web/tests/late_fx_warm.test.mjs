// tests/late_fx_warm.test.mjs
//
// 2026-10-20 (improvement hunt streaming-hitch-1) — `?lateFxWarm` (DEFAULT ON,
// `=off` escape). The late particle pass (atmosphere_pipeline.js
// ParticlesOverCloudsPass) and the `?fxGlow` buffer (vfx/fx_glow_effect.js)
// draw in their OWN light-less scenes, and three r184 keys every program on the
// light counts, so no warm built the program their first draw links: the tunnel
// warm compiled the late scene EMPTY (its children are `_noChildren` between
// frames) and the buckets in the MAIN scene with the world's lights. Now
// particles_over_clouds.js `warmLateFx` lends every FX object the sources hold
// (`{all: true}`) to those scenes for one compile, and portal_space.js
// warmWorldPrograms runs it on every tunnel warm pass.
//
// The keys are REAL: the fake renderer's compile() computes them with three's
// own WebGLPrograms (three/src) from the target scene's lights + fog and the
// bound target — exactly what getProgram does at a draw.
//
//   L1  flag parsing + seam
//   L2  premise: a real FX bucket's key in the late scene (no lights, world fog)
//       differs from its key in the world scene; only setProgram writes
//       `__version` (so the first draw always re-keys); the old tunnel warm of
//       the late scene compiles nothing
//   L3  collectLateFxAll / collectFxGlowAll: parked bucket, hidden kids layer,
//       slot meshes, a hidden detached source object; never the sky chain or a
//       lit material; the per-frame collect is unchanged
//   L4  warmLateFx: ONE compile against the late scene (the world Fog OBJECT,
//       no lights, non-null target) of exactly the held objects (no proxies);
//       every key the late draw derives is warmed (the world warm's is not);
//       the scene is handed back untouched
//   L5  glow: the warm twin keys exactly like FxGlowEffect._twin (real effect),
//       compiled in the glow scene (no fog, no lights); extras: plain Mesh twin
//   L6  memo / escape / no target
//   L7  portal_space.warmWorldPrograms: runs it, holds its still-linking
//       programs (asyncLink defers main-scene draws only), not when the late pass
//       is switched off right now; `=off` ⇒ today's passes exactly
//   L8  wiring pins
//
// Fails on the pre-change code: particles_over_clouds.js has no warmLateFx /
// collectLateFxAll and warmWorldPrograms compiles the late scene empty.
//
// Run: node tests/late_fx_warm.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
  body: { appendChild() {} },
};

const THREE = await import("three");
const { WebGLPrograms } = await import("three/src/renderers/webgl/WebGLPrograms.js");
const POC = await import("../scene3d/particles_over_clouds.js");
const SP = await import("../scene3d/shader_prewarm.js");
const ALG = await import("../scene3d/async_link_guard.js");
const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
let t = 1000;
setCurrentTime(() => t);
const PM = await import("../scene3d/particles/particle_manager.js");
const { ParticleFxKids } = await import("../scene3d/particles/particle_fx_kids.js");
const { FxGlowEffect } = await import("../scene3d/vfx/fx_glow_effect.js");
const ps = await import("../scene3d/portal_space.js");

// ── a recording renderer with three's real program keys ────────────────────
const CAPS = { logarithmicDepthBuffer: true, reversedDepthBuffer: false, precision: "highp", getMaxPrecision: (p) => p, vertexTextures: true, floatVertexTextures: true, maxVertexUniforms: 1024 };
function lightState(lights) {
  const dir = lights.filter((l) => l.isDirectionalLight);
  const point = lights.filter((l) => l.isPointLight);
  return {
    directional: dir, point, spot: [], spotLightMap: [], rectArea: [], hemi: [],
    directionalShadowMap: dir.filter((l) => l.castShadow), pointShadowMap: point.filter((l) => l.castShadow),
    spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0,
  };
}
// three r184 prepareMaterial / renderObjects: a transparent DoubleSide material
// without forceSinglePass is drawn (and compiled) Back then Front.
function forSides(m, fn) {
  if (m.transparent === true && m.side === THREE.DoubleSide && m.forceSinglePass === false) {
    m.side = THREE.BackSide; m.needsUpdate = true; fn();
    m.side = THREE.FrontSide; m.needsUpdate = true; fn();
    m.side = THREE.DoubleSide;
  } else fn();
}
function makeKeyRenderer() {
  const props = new WeakMap();
  const r = {
    _rt: null,
    calls: [],
    slow: new Set(), // materials whose programs are still linking (KHR_parallel_shader_compile)
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    state: { buffers: { depth: { getReversed: () => false } } },
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    getRenderTarget() { return this._rt; },
    setRenderTarget(tg) { this._rt = tg ?? null; },
    getActiveCubeFace() { return 0; },
    getActiveMipmapLevel() { return 0; },
    render() {},
    keyOf(m, lights, scene, o) {
      try {
        return this.programs.getProgramCacheKey(this.programs.getParameters(m, lightState(lights), lights.filter((l) => l.castShadow), scene, o, []));
      } catch (e) {
        return `unkeyable:${m.type}:${e.message}`;
      }
    },
    compile(root, camera, targetScene = null) {
      const ts = targetScene ?? root;
      const lights = [];
      const pushLight = (o) => { if (o.isLight && o.layers.test(camera.layers)) lights.push(o); };
      ts.traverseVisible?.(pushLight);
      if (root !== ts) root.traverseVisible?.(pushLight);
      const set = new Set();
      const objects = [];
      const keys = [];
      root.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
        objects.push(o);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue;
          forSides(m, () => {
            const key = this.keyOf(m, lights, ts, o);
            const mp = this.properties.get(m);
            if (!mp.programs) mp.programs = new Map();
            if (!mp.programs.has(key)) mp.programs.set(key, { key, usedTimes: 1, isReady: () => !this.slow.has(m) });
            mp.currentProgram = mp.programs.get(key);
            keys.push(key);
          });
          set.add(m);
        }
      });
      this.calls.push({ target: this._rt, ts, fog: ts.fog ?? null, lights: lights.length, objects, keys, mats: set });
      return set;
    },
  };
  r.programs = new WebGLPrograms(r, { get: () => null }, { has: () => false }, CAPS, {}, { numPlanes: 0, numIntersection: 0 });
  return r;
}
const warmedKeys = (r, m) => [...(r.properties.get(m).programs?.keys() ?? [])];
// The keys a draw of `o` in `scene` (lights, fog) derives, with a non-null target bound.
function drawKeys(r, o, lights, scene) {
  const prev = r._rt;
  r._rt = SP.getWarmTarget();
  const out = [];
  try {
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) forSides(m, () => out.push(r.keyOf(m, lights, scene, o)));
  } finally { r._rt = prev; }
  return out;
}

// ── fixture: REAL ParticleManagers (as tests/particles_over_clouds.test.mjs P3) ─
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
camera.layers.enable(1);
camera.updateMatrixWorld(true);
window.liveScene3d = { cameraSwitcher: { activeCamera: camera }, camera };
const quad = new THREE.PlaneGeometry(1, 1);
const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
tex.needsUpdate = true;
const GFX_ADD = 0x01000b01, GFX_ALPHA = 0x01000b02, GFX_SKY = 0x01001a61, GFX_MESH = 0x01000b04, GFX_PARK = 0x01000b05;
const mkBase = (o, flags) => { const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, ...o }); m.userData = { __cacheOwned: true, surfaceTypeFlags: flags }; return m; };
const bases = new Map([
  [GFX_ADD, mkBase({ map: tex, blending: THREE.AdditiveBlending }, 0x10000)],
  [GFX_ALPHA, mkBase({ map: tex }, 0x100)],
  [GFX_SKY, mkBase({ map: tex, blending: THREE.AdditiveBlending }, 0x10102)],
  [GFX_MESH, mkBase({ map: tex, blending: THREE.AdditiveBlending }, 0x10000)],
  // map-less additive: its own program class, seen only by a bucket that is parked at warm time
  [GFX_PARK, mkBase({ blending: THREE.AdditiveBlending }, 0x10000)],
]);
const info = (hw) => ({
  id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: hw,
  birthrate: 10, maxParticles: 4, initialParticles: 4, totalParticles: 0, totalSeconds: 0,
  lifespan: 600, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
  minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
  bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 1, finalScale: 1,
  transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
});
const mkMgr = (instancing, group) => new PM.ParticleManager({
  scene: group, instancing, geometryFactory: () => quad, materialFactory: (hw) => bases.get(hw >>> 0),
});
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8899aa, 10, 900);
const sun = new THREE.DirectionalLight();
sun.castShadow = true;
scene.add(sun);
const staticsGroup = new THREE.Group(); scene.add(staticsGroup);
const entitiesGroup = new THREE.Group(); scene.add(entitiesGroup);
const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -30); staticsGroup.add(anchor);
const skyAnchor = new THREE.Object3D(); skyAnchor.position.set(0, 0, -200); staticsGroup.add(skyAnchor);
const anchor2 = new THREE.Object3D(); anchor2.position.set(0, 0, -20); entitiesGroup.add(anchor2);
const mgr = mkMgr(true, staticsGroup);
const mgrMesh = mkMgr(false, entitiesGroup);
await mgr.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
await mgr.addEmitter({ emitterInfo: info(GFX_ALPHA), parent: anchor });
await mgr.addEmitter({ emitterInfo: info(GFX_SKY), parent: skyAnchor, skyGlow: true });
const parkId = await mgr.addEmitter({ emitterInfo: info(GFX_PARK), parent: anchor });
await mgrMesh.addEmitter({ emitterInfo: info(GFX_MESH), parent: anchor2 });
const tick = (n) => { for (let i = 0; i < n; i += 1) { t += 0.016; mgr.tick(); mgrMesh.tick(); } };
tick(3);
const imPark0 = staticsGroup.children.find((o) => o.isInstancedMesh && o.userData.gfxObjId === GFX_PARK);
mgr.destroyParticleEmitter(parkId);
tick(1); // the GFX_PARK bucket parks: count 0, still held for the idle window
scene.updateMatrixWorld(true);
// Tier 1 `?fxKids`: one children layer, nothing in it this frame (hidden).
if (!mgr._kids) mgr._kids = new ParticleFxKids(staticsGroup);
const kidsLayer = mgr._kids.layer(0);
const ims = staticsGroup.children.filter((o) => o.isInstancedMesh);
const imAdd = ims.find((o) => o.userData.gfxObjId === GFX_ADD && !o.userData.alpha);
const imAlpha = ims.find((o) => o.userData.gfxObjId === GFX_ALPHA && o.userData.alpha);
const imSky = ims.find((o) => o.userData.gfxObjId === GFX_SKY);
const imPark = ims.find((o) => o.userData.gfxObjId === GFX_PARK);
const slots = () => entitiesGroup.children.filter((o) => o.isMesh && o.userData.__particle);
// A source that holds a hidden, detached object (and a lit one), honouring `opts.all`.
const hiddenSpark = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ name: "hidden-spark", transparent: true, blending: THREE.AdditiveBlending }));
hiddenSpark.visible = false;
const litThing = new THREE.Mesh(quad, new THREE.MeshStandardMaterial({ name: "lit" }));
const unSrc = POC.registerLateFxSource((out, opts) => { if (opts?.all) out.push(hiddenSpark, litThing, hiddenSpark); });
// A glow extra: a plain Mesh (twinned) and an InstancedMesh object (no plain-Mesh twin from its class).
const fieldMesh = new THREE.Mesh(quad, new THREE.ShaderMaterial({ name: "field" }));
fieldMesh.visible = false;
const fieldGlow = new THREE.ShaderMaterial({ name: "field-glow", transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false });
const oddExtra = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial(), 1);
const unExtra = POC.registerFxGlowExtras({
  collect(out, opts) { if (opts?.all) out.push({ object: fieldMesh, material: fieldGlow }, { object: oddExtra, material: new THREE.ShaderMaterial({ name: "odd-glow" }) }); },
});

console.log("-- fixture ------------------------------------------------------------");
check("real buckets: additive, alpha, sky chain; a PARKED map-less additive bucket (count 0)",
  !!imAdd && !!imAlpha && !!imSky && !!imPark && imPark === imPark0 && imAdd.count > 0 && imPark.count === 0,
  ims.map((o) => `${o.name}:${o.count}`).join(","));
check("FX buckets (particle_fx applied: the real defines + customProgramCacheKey)", imAdd.userData.particleFx === true && imPark.userData.particleFx === true);
check("a hidden kids layer and live per-mesh slot meshes", kidsLayer.mesh.visible === false && kidsLayer.n === 0 && slots().length > 0);

// ---------------------------------------------------------------------------
console.log("\n-- L1 ?lateFxWarm parsing ---------------------------------------------");
check("absent -> on", POC.lateFxWarmEnabled("") === true);
check("on / garbage -> on", POC.lateFxWarmEnabled("?lateFxWarm=on") === true && POC.lateFxWarmEnabled("?lateFxWarm=x") === true);
check("off / 0 / false / no / OFF -> off", ["off", "0", "false", "no", "OFF"].every((v) => POC.lateFxWarmEnabled(`?lateFxWarm=${v}`) === false));
check("no-arg reads location (memoised) -> on", POC.lateFxWarmEnabled() === true);
POC.setLateFxWarmFlag(false);
check("seam: forced off", POC.lateFxWarmEnabled() === false);
POC.setLateFxWarmFlag(null);
check("seam: null re-reads -> on", POC.lateFxWarmEnabled() === true);

// ---------------------------------------------------------------------------
console.log("\n-- L2 premise (three r184) -------------------------------------------");
{
  const r = makeKeyRenderer();
  const lateDraw = drawKeys(r, imAdd, [], { isScene: true, fog: scene.fog });
  const worldDraw = drawKeys(r, imAdd, [sun], scene);
  check("an FX bucket's late-pass key (no lights, world fog) != its world-pass key (the sun)",
    lateDraw.length === 1 && worldDraw.length === 1 && lateDraw[0] !== worldDraw[0] && !lateDraw[0].startsWith("unkeyable"), lateDraw[0]);
  check("…for a MeshBasicMaterial (the key carries numDirLights even unlit)", imAdd.material.isMeshBasicMaterial === true);
  const SRC = readFileSync(path.join(APP, "node_modules/three/src/renderers/WebGLRenderer.js"), "utf8");
  const writes = [...SRC.matchAll(/materialProperties\.__version = material\.version/g)].map((m) => m.index);
  const sp = SRC.indexOf("function setProgram(");
  const after = SRC.indexOf("\n\t\tfunction ", sp + 10);
  check("only setProgram writes __version (compile() never does ⇒ the first draw re-keys from ITS scene)",
    writes.length === 1 && writes[0] > sp && (after < 0 || writes[0] < after));
  // The old tunnel warm of the late pass: its scene is empty between frames.
  const lateScene = new THREE.Scene();
  const res = SP.warmSceneMaterials(r, lateScene, camera, SP.getWarmTarget(), { seen: new WeakMap() });
  check("pre-change: warming the late pass's scene compiles nothing (children empty)", res.compiled === 0 && r.calls.length === 0);
  // The main-scene warm compiles the hidden buckets with the world lights — not the late key.
  SP.warmSceneMaterials(r, scene, camera, SP.getWarmTarget(), { seen: new WeakMap() });
  check("pre-change: the main-scene warm builds the WORLD variant of the bucket, not the late one",
    warmedKeys(r, imAdd.material).includes(worldDraw[0]) && !warmedKeys(r, imAdd.material).includes(lateDraw[0]));
}

// ---------------------------------------------------------------------------
console.log("\n-- L3 the {all:true} collects -----------------------------------------");
const lateAll = POC.collectLateFxAll([1, 2]);
{
  check("all: additive, alpha AND the parked bucket", lateAll.includes(imAdd) && lateAll.includes(imAlpha) && lateAll.includes(imPark));
  check("all: the hidden kids layer mesh and every claimed slot mesh", lateAll.includes(kidsLayer.mesh) && slots().every((m) => lateAll.includes(m)));
  check("all: a hidden, detached source object, once", lateAll.filter((o) => o === hiddenSpark).length === 1);
  check("all: never the sky chain, never a lit material, input cleared", !lateAll.includes(imSky) && !lateAll.includes(litThing) && !lateAll.includes(1));
  const perFrame = POC.collectLateFx([], scene, camera.layers.mask);
  check("the per-frame collect is unchanged: no parked bucket, no hidden kids / source objects",
    perFrame.includes(imAdd) && !perFrame.includes(imPark) && !perFrame.includes(kidsLayer.mesh) && !perFrame.includes(hiddenSpark));
  const glowAll = POC.collectFxGlowAll([]);
  const gObjs = glowAll.map((e) => e.object);
  check("glow all: every additive FX bucket incl. the parked one, never alpha / sky",
    gObjs.includes(imAdd) && gObjs.includes(imPark) && !gObjs.includes(imAlpha) && !gObjs.includes(imSky));
  check("glow all: the bucket entry carries the provider's glow material (materialFor)",
    glowAll.find((e) => e.object === imAdd)?.material === POC.fxGlowProvider().materialFor(imAdd) && glowAll.find((e) => e.object === imAdd)?.instanced === true);
  check("glow all: extras too (hidden), as plain-Mesh entries", glowAll.some((e) => e.object === fieldMesh && e.material === fieldGlow && e.instanced === false));
}

// ---------------------------------------------------------------------------
console.log("\n-- L4 warmLateFx: the late scene's key, exactly ----------------------");
const lateScene = new THREE.Scene();
lateScene.matrixWorldAutoUpdate = false;
const noChildren = lateScene.children;
{
  const r = makeKeyRenderer();
  const seen = new WeakMap();
  const res = POC.warmLateFx(r, camera, { scene: lateScene, fog: scene.fog, target: SP.getWarmTarget(), warm: SP.warmSceneMaterials, seen });
  check("ONE compile() for the late scene", r.calls.length === 1, String(r.calls.length));
  const c = r.calls[0];
  check("…against the world's Fog OBJECT, zero lights, a non-null target",
    c && c.fog === scene.fog && c.lights === 0 && c.target === SP.getWarmTarget());
  const want = POC.collectLateFxAll([]);
  check("…of exactly the objects the sources hold (no proxies, no placeholder geometry)",
    c && c.objects.length === want.length && want.every((o) => c.objects.includes(o)) && res.objects === want.length,
    `${c?.objects.length} vs ${want.length}`);
  // What the late draw derives: ParticlesOverCloudsPass.render sets fog = worldScene.fog
  // and children = objs in a light-less scene, with T (non-null) bound.
  const drawScene = { isScene: true, fog: scene.fog };
  const misses = [];
  for (const o of want) for (const k of drawKeys(r, o, [], drawScene)) if (!warmedKeys(r, o.material).includes(k)) misses.push(o.name || o.material.name);
  check("every key the late draw derives is warmed (buckets, parked bucket, kids, slots)", misses.length === 0, misses.join(","));
  check("the parked map-less class got its own late program", warmedKeys(r, imPark.material).length === 1 && warmedKeys(r, imPark.material)[0] !== warmedKeys(r, imAdd.material)[0]);
  check("compiled materials returned (for the release hold)", res.compiled > 0 && res.materials instanceof Set && res.materials.has(imAdd.material));
  check("the late scene is handed back: same empty children array, no fog",
    lateScene.children === noChildren && noChildren.length === 0 && lateScene.fog === null);
  check("objects keep their real parents", imAdd.parent === staticsGroup && kidsLayer.mesh.parent === staticsGroup);

  console.log("\n-- L6 memo / escape / guards -------------------------------------------");
  const again = POC.warmLateFx(r, camera, { scene: lateScene, fog: scene.fog, target: SP.getWarmTarget(), warm: SP.warmSceneMaterials, seen });
  check("a second pass with nothing new compiles nothing (shared memo)", again.compiled === 0 && r.calls.length === 1);
  imAdd.material.needsUpdate = true;
  const third = POC.warmLateFx(r, camera, { scene: lateScene, fog: scene.fog, target: SP.getWarmTarget(), warm: SP.warmSceneMaterials, seen });
  check("a version bump recompiles just that material", third.compiled === 1 && third.materials.has(imAdd.material));
  const r2 = makeKeyRenderer();
  check("no target ⇒ nothing (never the canvas variant)",
    POC.warmLateFx(r2, camera, { scene: lateScene, fog: scene.fog, target: null, warm: SP.warmSceneMaterials }).compiled === 0 && r2.calls.length === 0);
  check("no warm function ⇒ nothing", POC.warmLateFx(r2, camera, { scene: lateScene, target: SP.getWarmTarget() }).compiled === 0 && r2.calls.length === 0);
  POC.setLateFxWarmFlag(false);
  const offRes = POC.warmLateFx(r2, camera, { scene: lateScene, fog: scene.fog, target: SP.getWarmTarget(), warm: SP.warmSceneMaterials, seen: new WeakMap() });
  POC.setLateFxWarmFlag(null);
  check("?lateFxWarm=off ⇒ no compile at all", offRes.compiled === 0 && offRes.objects === 0 && r2.calls.length === 0);
  const throwing = POC.warmLateFx(r2, camera, { scene: lateScene, fog: scene.fog, target: SP.getWarmTarget(), warm: () => { throw new Error("x"); } });
  check("a throwing warm is contained and the scene still handed back", throwing.compiled === 0 && lateScene.children === noChildren && lateScene.fog === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- L5 glow twins: FxGlowEffect's key, in the glow scene --------------");
{
  const fx = new FxGlowEffect({ camera });
  const live = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ name: "live-twin" }));
  fx.glowScene.add(live); // a twin from the last drawn frame
  const before = fx.glowScene.children;
  const r = makeKeyRenderer();
  const res = POC.warmLateFx(r, camera, { glowScene: fx.glowScene, target: SP.getWarmTarget(), warm: SP.warmSceneMaterials, seen: new WeakMap() });
  check("ONE compile() for the glow scene: no fog, zero lights, non-null target",
    r.calls.length === 1 && r.calls[0].fog === null && r.calls[0].lights === 0 && r.calls[0].target === SP.getWarmTarget());
  const c = r.calls[0];
  const twinOf = (b) => c.objects.find((o) => o.isInstancedMesh && o.geometry === b.geometry && o.instanceColor === b.instanceColor);
  const tw = twinOf(imAdd);
  const glowMat = POC.fxGlowProvider().materialFor(imAdd);
  check("bucket twin: an InstancedMesh on the bucket's geometry + instance buffers, with its glow material",
    !!tw && tw.constructor === THREE.InstancedMesh && tw.instanceMatrix === imAdd.instanceMatrix && tw.material === glowMat && !!twinOf(imPark));
  const effTwin = fx._twin(imAdd, glowMat); // what update() would draw
  const effKey = drawKeys(r, effTwin, [], fx.glowScene);
  check("the warmed key == the key FxGlowEffect's own twin draws with", effKey.length === 1 && warmedKeys(r, glowMat).includes(effKey[0]), effKey[0]);
  fx.glowScene.remove(effTwin);
  fx._twins.delete(imAdd);
  const ft = c.objects.find((o) => o.geometry === fieldMesh.geometry && o.material === fieldGlow);
  check("extra twin: a plain Mesh on the extra's geometry (as the effect builds it)", !!ft && ft.constructor === THREE.Mesh && !ft.isInstancedMesh);
  check("an extra whose class cannot give a plain-Mesh twin is left alone (links at first draw)",
    !c.objects.some((o) => o.material?.name === "odd-glow"));
  check("twins are warm-only: never parented", c.objects.every((o) => o.parent === null));
  check("the glow scene is handed back (its live twins, no fog)", fx.glowScene.children === before && before.length === 1 && before[0] === live && fx.glowScene.fog === null);
  check("glow counters", res.glowObjects === c.objects.length && res.glowCompiled > 0 && res.glowMaterials instanceof Set && res.glowMaterials.has(glowMat));
  fx.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L7 portal_space.warmWorldPrograms --------------------------------");
function makeWorld(r, { lateEnabled = true } = {}) {
  const lateScn = new THREE.Scene();
  lateScn.matrixWorldAutoUpdate = false;
  const fx = new FxGlowEffect({ camera });
  // The shape portal_space reads off atmosphere_pipeline's late pass (pinned in L8).
  const latePass = { name: "ParticlesOverClouds", scene: lateScn, camera, worldScene: scene, enabled: lateEnabled, needsSwap: false, renderToScreen: false, fullscreenMaterial: null, render() {} };
  const worldPass = { name: "RenderPass", scene, camera, fullscreenMaterial: null, renderToScreen: false, render() {} };
  const postPass = { name: "EffectPass", fullscreenMaterial: new THREE.ShaderMaterial({ name: "EffectMaterial-post" }), renderToScreen: true, needsSwap: true, enabled: true, effects: [fx], render() {} };
  const sc = {
    renderer: r, scene, camera,
    atmospherePipeline: { composer: { passes: [worldPass, latePass, postPass] }, particlesOverCloudsPass: latePass, particlesOverHazePass: null },
  };
  return { sc, latePass, lateScn, fx };
}
const bumpAll = () => {
  for (const o of POC.collectLateFxAll([])) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
  for (const e of POC.collectFxGlowAll([])) e.material.needsUpdate = true;
  for (const o of [imAdd, imAlpha, imPark, imSky]) o.material.needsUpdate = true;
};
const lateCall = (r, lateScn) => r.calls.find((c) => c.lights === 0 && c.fog === scene.fog && c.objects.includes(imAdd));
{
  bumpAll();
  const r = makeKeyRenderer();
  r.__hbAsyncLink = { off: false, guards: (m) => ALG.asyncLinkEligible(m) };
  r.slow.add(imAdd.material); // its programs are still linking
  const w = makeWorld(r);
  const res = ps.warmWorldPrograms(w.sc);
  const lc = lateCall(r, w.lateScn);
  check("the tunnel warm pass compiles the late scene: world fog, no lights, non-null target", !!lc && lc.target !== null);
  check("…and the main scene with the sun (the split-frame variant stays warmed too)",
    r.calls.some((c) => c.lights === 1 && c.objects.includes(imAdd)));
  const drawK = drawKeys(r, imAdd, [], { isScene: true, fog: scene.fog })[0];
  check("the late draw's key of the live additive bucket is warmed", warmedKeys(r, imAdd.material).includes(drawK));
  check("the glow scene is compiled too (no fog, no lights)", r.calls.some((c) => c.lights === 0 && c.fog === null && c.objects.some((o) => o.geometry === imAdd.geometry && o.isInstancedMesh)));
  check("counters: res.late counted inside res.compiled", res.late > 0 && res.compiled >= res.late, JSON.stringify(res));
  check("a still-linking late program HOLDS the release (the guard would defer it only in the main scene)",
    res.held >= 1 && ALG.asyncLinkEligible(imAdd.material) === true, JSON.stringify(res));
  check("the late scene is handed back", w.lateScn.children.length === 0 && w.lateScn.fog === null);
  r.slow.clear(); // linked: portal_space's (module-level) hold set lets go of them
  check("…and lets go once they have linked", ps.warmWorldPrograms(w.sc).held === 0);
  w.fx.dispose();
}
{
  bumpAll();
  const r = makeKeyRenderer();
  r.__hbAsyncLink = { off: false, guards: (m) => ALG.asyncLinkEligible(m) };
  r.slow.add(imAdd.material);
  const w = makeWorld(r, { lateEnabled: false });
  const res = ps.warmWorldPrograms(w.sc);
  check("late pass switched off right now (indoor split frame): warmed for later…", !!lateCall(r, w.lateScn) && res.late > 0);
  check("…but never holds the release", res.held === 0, JSON.stringify(res));
  r.slow.clear();
  w.fx.dispose();
}
{
  bumpAll();
  POC.setLateFxWarmFlag(false);
  const r = makeKeyRenderer();
  r.__hbAsyncLink = { off: false, guards: (m) => ALG.asyncLinkEligible(m) };
  r.slow.add(imAdd.material);
  const w = makeWorld(r);
  const res = ps.warmWorldPrograms(w.sc);
  POC.setLateFxWarmFlag(null);
  check("?lateFxWarm=off: no late / glow compile (today's passes)",
    !lateCall(r, w.lateScn) && !r.calls.some((c) => c.fog === null && c.lights === 0 && c.objects.some((o) => o.isInstancedMesh && o.geometry === imAdd.geometry)) && res.late === 0);
  check("?lateFxWarm=off: the guarded bucket holds nothing (as before)", res.held === 0, JSON.stringify(res));
  r.slow.clear();
  w.fx.dispose();
}
{
  bumpAll();
  const r = makeKeyRenderer();
  const w = makeWorld(r);
  w.sc.atmospherePipeline.composer.passes.length = 1; // world pass only: no late pass, no glow effect
  const res = ps.warmWorldPrograms(w.sc);
  check("no late pass and no glow effect in the composer ⇒ no late warm (particles draw in the world pass)",
    !lateCall(r, w.lateScn) && res.late === 0);
  w.fx.dispose();
}

// ---------------------------------------------------------------------------
console.log("\n-- L8 wiring ----------------------------------------------------------");
{
  const AP = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  check("atmosphere_pipeline: the late pass keeps `worldScene` and draws its private scene with the world fog",
    /const lateScene = new THREE\.Scene\(\);\s*\n\s*super\(name, lateScene, camera\);/.test(AP) &&
    /this\.worldScene = worldScene;/.test(AP) && /scene\.fog = this\.worldScene\?\.fog \?\? null;\s*\n\s*scene\.children = objs;/.test(AP));
  check("atmosphere_pipeline: the pipeline exposes both late passes",
    /\n\s+particlesOverCloudsPass,\n/.test(AP) && /\n\s+particlesOverHazePass,\n/.test(AP));
  const fx = new FxGlowEffect({ camera });
  check("fx_glow_effect: the effect owns glowScene (a Scene) + glowTarget (portal_space finds it by that shape)",
    fx.glowScene?.isScene === true && !!fx.glowTarget?.isWebGLRenderTarget);
  fx.dispose();
  const PSRC = readFileSync(path.join(APP, "scene3d", "portal_space.js"), "utf8");
  check("portal_space: warmWorldPrograms runs the late warm", /_warmLateFxPass\(renderer, sc, comp, off, res, hold\);/.test(PSRC) && /warm: warmSceneMaterials,/.test(PSRC));
  const FF = readFileSync(path.join(APP, "scene3d", "vfx", "fx_fields.js"), "utf8");
  check("fx_fields honours {all:true} (fields are built hidden)", /registerLateFxSource\(\(out, opts\) => \{/.test(FF) && /all \|\| \(f\.mesh\.visible && f\.mesh\.parent\)/.test(FF) && /f\.glowMat && \(all \|\| f\.mesh\.visible\)/.test(FF));
  const PMSRC = readFileSync(path.join(APP, "scene3d", "particles", "particle_manager.js"), "utf8");
  check("particle_manager: still registers its collector (P9 pin)", /registerLateFxSource\(collectParticlesOverClouds\)/.test(PMSRC));
}

unSrc();
unExtra();
console.log(`\nlate fx warm: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
