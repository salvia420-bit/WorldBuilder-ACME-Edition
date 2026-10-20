// ?shadowStaticCache (scene3d/shadow_caster_list.js, DEFAULT ON, `=off`
// escape) — fps wave 1, 2026-10-17. Each cascade's static depth is cached;
// a frame where only rigs changed blits the cache back and draws just the rigs.
//
// Drives the REAL chain: lighting.js gate (setupSceneLighting +
// tickLightingForCellState, csm.js fit) → the ?shadowCasterList wrapper →
// three r184's REAL WebGLShadowMap (extracted from three.module.js) on a stub
// renderer that MODELS DEPTH CONTENT: each render target holds the set of
// casters drawn into it (with the pose they were drawn at); clear() empties
// the bound target; copyTextureToTexture copies a depth set between targets.
// Every cascade three rasters is then compared with what a single full pass
// would hold (three's own culling rules, applied to the live scene).
//
//   S1  warm frame: all NORMAL, exact, no cache yet
//   S2  the staggered 12-frame ceilings: REFRESH — statics pass, map→cache
//       blit, rigs pass
//   S3  a rig walking (camera still): OVERLAY — cache→map blit, ZERO static
//       draws, no clear, no whole-scene walk; every rastered map exact
//   S4  camera move: every refit cascade REFRESHes in that raster (cache
//       rebuilt at once — 2026-10-20 shadows-restore-1; it used to be NORMAL
//       and the next rig frame paid a second static raster); next rig frame
//       OVERLAY straight away
//   S5  a static added while standing still shows up by the next ceiling
//       (≤12 frames — the RP5 bound), not before it is due
//   S6  WebGL context loss/restore: the next rig frame rebuilds (REFRESH)
//   S7  shadow.map disposed: the cache is freed with it and re-made
//   S8  hidden rigs root: overlay draws nothing dynamic, still exact
//   S9  scissor off + depth mask on at every blit; render target and
//       renderer.clear restored after the call
//   S10 a throwing blit — or a GL error reported after one of the first two
//       blits — falls back to plain rasters for the session, output exact
//   S11 stand-downs: =off seam, no dynamic root, ?shadowMoverScope=off
//   S12 the flag reader
//
// Run:  cd apps/holtburger-web && node tests/shadow_static_cache.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

globalThis.window = globalThis.window || {};
// ?csmStable=off (2026-10-20, shadows-restore-1): these scenarios are written
// against the view-slice cascade fit (every camera move refits all three; 12-frame
// ceilings on every cascade). The stable cascades' refits, ceilings and overlay
// frames are pinned in tests/csm_stable.test.mjs.
globalThis.location = { search: "?csmStable=off" };
window.location = globalThis.location;

const L = await import("../scene3d/lighting.js");
const SCL = await import("../scene3d/shadow_caster_list.js");
const SSC = SCL; // the static cache lives in shadow_caster_list.js

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.error(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}

// --- three's own WebGLShadowMap --------------------------------------------------
const require = createRequire(import.meta.url);
const threeDir = require.resolve("three").replace(/[^/\\]+$/, "");
const src = readFileSync(threeDir + "three.module.js", "utf8");
const a = src.indexOf("const vertex = \"void main()");
const b = src.indexOf("function WebGLState(");
if (a < 0 || b < 0 || !src.slice(a, b).includes("function WebGLShadowMap(")) {
  console.log("shadow_static_cache: three.module.js layout changed — re-anchor the extraction.");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const WebGLShadowMap = new Function("THREE", "with (THREE) {\n" + src.slice(a, b) + "\nreturn WebGLShadowMap; }")(THREE);

const poseKey = (o) => o.matrixWorld.elements.map((v) => v.toFixed(4)).join(",");

// A renderer stub with a depth-content model.
function makeRenderer() {
  const content = new Map(); // rt -> Set("objectId@poseKey") — depth is min(), so an old pose stays until a clear
  const byDepth = new Map(); // depthTexture -> rt
  const log = { draws: [], clears: [], blits: [], setRT: [] };
  let current = null;
  let scissor = true; // start "on": a previous pass may have left it on
  let depthMask = false;
  const listeners = {};
  const reg = (rt) => { if (rt && rt.depthTexture) byDepth.set(rt.depthTexture, rt); if (rt && !content.has(rt)) content.set(rt, new Set()); };
  const r = {
    throwOnBlit: false,
    domElement: {
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of listeners[type] || []) fn({ type }); },
    },
    getRenderTarget: () => current,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(rt) { current = rt; log.setRT.push(rt); reg(rt); },
    clear() { if (current) { content.set(current, new Set()); log.clears.push(current); } },
    initRenderTarget(rt) { reg(rt); },
    copyTextureToTexture(srcTex, dstTex) {
      if (r.throwOnBlit) { r.throwOnBlit = false; throw new Error("blit boom"); }
      const s = byDepth.get(srcTex), d = byDepth.get(dstTex);
      if (!s || !d) throw new Error("blit between unregistered targets");
      log.blits.push({ s, d, scissor, depthMask });
      content.set(d, new Set(content.get(s)));
    },
    state: {
      setBlending() {}, viewport() {},
      setScissorTest(v) { scissor = !!v; },
      buffers: {
        depth: { getReversed: () => false, setTest() {}, setMask(v) { depthMask = !!v; } },
        color: { setClear() {} },
      },
    },
    renderBufferDirect(camera, scene, geometry, material, object) {
      if (!current) return;
      content.get(current).add(`${object.id}@${poseKey(object)}`);
      log.draws.push({ rt: current, object });
    },
  };
  const sm = new WebGLShadowMap(r, { update: (o) => o.geometry }, { maxTextureSize: 16384 });
  sm.enabled = true;
  sm.type = THREE.PCFShadowMap;
  r.shadowMap = sm;
  return { renderer: r, sm, content, log };
}

function makeWorld() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const staticsGroup = new THREE.Group();
  const entitiesGroup = new THREE.Group();
  worldRoot.add(staticsGroup, entitiesGroup);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  camera.position.set(0, 5, 0); // looks down three -Z = AC +Y
  scene.add(camera);
  return { scene, worldRoot, staticsGroup, entitiesGroup, camera };
}

const box = new THREE.BoxGeometry(2, 2, 4);
const mat = new THREE.MeshStandardMaterial();
function addStatic(world, x, y) {
  const m = new THREE.Mesh(box, mat);
  m.castShadow = true;
  m.position.set(x, y, 2);
  world.staticsGroup.add(m);
  return m;
}
function addRig(world, x, y) {
  const root = new THREE.Group();
  root.position.set(x, y, 0);
  const part = new THREE.Group();
  root.add(part);
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 2), mat);
  m.castShadow = true;
  m.position.set(0, 0, 1);
  part.add(m);
  world.entitiesGroup.add(root);
  return { root };
}

function makeSession({ dynRoot = true } = {}) {
  const world = makeWorld();
  // A spread of static casters: near, mid, far, off to the sides.
  for (let i = 0; i < 40; i += 1) addStatic(world, ((i * 37) % 160) - 80, 5 + ((i * 53) % 320));
  world.scene.updateMatrixWorld(true);
  const R = makeRenderer();
  SCL.installShadowCasterList(R.renderer);
  const lighting = L.setupSceneLighting(world.scene, { csm: true });
  const lights = lighting.csmState.lights;
  for (const l of lights) l.shadow.mapSize.set(64, 64);
  const entityMap = new Map();
  const scene3d = {
    renderer: R.renderer, lighting, camera: world.camera, scene: world.scene,
    entityManager: { entityMap },
    entitiesGroup: dynRoot ? world.entitiesGroup : undefined,
  };
  const before = () => SSC.getShadowStaticCacheStats();
  function frame(move) {
    L.tickLightingForCellState(scene3d, null);
    if (move) move();
    world.scene.updateMatrixWorld();
    R.log.draws.length = 0; R.log.clears.length = 0; R.log.blits.length = 0; R.log.setRT.length = 0;
    const s0 = before();
    const mainRT = { isMainTarget: true };
    R.renderer.setRenderTarget(mainRT);
    R.log.setRT.length = 0;
    const clearFn = R.renderer.clear;
    // The world pass may enter the shadow phase with a scissor box on and
    // depth writes off (a previous transparent / narrowed pass).
    R.renderer.state.setScissorTest(true);
    R.renderer.state.buffers.depth.setMask(false);
    R.sm.render(lights, world.scene, world.camera);
    const s1 = before();
    const rastered = new Set();
    for (const rt of R.log.setRT) { const i = lights.findIndex((l) => l.shadow.map === rt); if (i >= 0) rastered.add(i); }
    return {
      rastered: [...rastered].sort().join(""),
      normal: s1.normal - s0.normal, refresh: s1.refresh - s0.refresh, overlay: s1.overlay - s0.overlay,
      blits: R.log.blits.slice(), draws: R.log.draws.slice(), clears: R.log.clears.slice(),
      rtRestored: R.renderer.getRenderTarget() === mainRT,
      clearRestored: R.renderer.clear === clearFn,
    };
  }
  // What a single full pass of cascade i would hold right now.
  function reference(i) {
    const out = new Set();
    const fr = lights[i].shadow.getFrustum();
    (function walk(o) {
      if (o.visible === false) return;
      if (o.isMesh && o.castShadow && o.layers.test(world.camera.layers) && (!o.frustumCulled || fr.intersectsObject(o))) out.add(`${o.id}@${poseKey(o)}`);
      for (const c of o.children) walk(c);
    })(world.scene);
    return out;
  }
  function exact(i) {
    const got = R.content.get(lights[i].shadow.map) || new Set();
    const want = reference(i);
    if (got.size !== want.size) return false;
    for (const k of want) if (!got.has(k)) return false;
    return true;
  }
  function allRasteredExact(res) {
    for (const ch of res.rastered) if (!exact(Number(ch))) return false;
    return true;
  }
  return { world, lighting, lights, scene3d, entityMap, frame, exact, allRasteredExact, R };
}
const isStatic = (o, world) => { for (let x = o; x; x = x.parent) if (x === world.staticsGroup) return true; return false; };

SSC.__resetShadowStaticCacheForTest();
L.__resetRp5ConfigForTest(undefined);

// ---------------------------------------------------------------- S1 + S2 + S3
{
  const S = makeSession();
  const f1 = S.frame();
  check("S1 warm frame rasters all 3 cascades", f1.rastered === "012");
  check("S1 ...in the plain single pass (no cache yet, no blits)", f1.refresh === 0 && f1.overlay === 0 && f1.blits.length === 0);
  check("S1 ...exact", S.allRasteredExact(f1));
  // Still scene: the staggered ceilings (c2@5, c1@9, c0@13) each REFRESH one
  // cascade — statics pass, one map→cache blit, rigs pass.
  const seen = [];
  let ceilOk = true;
  for (let f = 2; f <= 13; f += 1) {
    const res = S.frame();
    if (!res.rastered) continue;
    seen.push(`${res.rastered}@${f}`);
    if (!(res.rastered.length === 1 && res.refresh === 1 && res.overlay === 0 && res.blits.length === 1 &&
      res.blits[0].s === S.lights[Number(res.rastered)].shadow.map && S.allRasteredExact(res))) ceilOk = false;
  }
  check("S2 still scene: only the staggered ceilings raster", seen.join(" ") === "2@5 1@9 0@13", seen.join(" "));
  check("S2 ...each a REFRESH (one map→cache blit), exact", ceilOk);

  // A rig walking in view, camera still.
  const rig = addRig(S.world, 2, 12);
  S.entityMap.set(1, rig);
  // (frames 14..23: the c2 ceiling lands on 17 and the c1 one on 21 — those
  // two cascades REFRESH there; everything else a rig dirties OVERLAYs.)
  let allOverlay = true, exactAll = true, noStaticDraws = true, noClears = true, blitsOk = true, frames = 0, overlays = 0, refreshes = 0;
  for (let f = 0; f < 10; f += 1) {
    const res = S.frame(() => { rig.root.position.y += 0.4; });
    if (!res.rastered) continue;
    frames += 1;
    if (res.normal > 0 || res.refresh > 1) allOverlay = false;
    overlays += res.overlay;
    refreshes += res.refresh;
    if (!S.allRasteredExact(res)) exactAll = false;
    if (res.refresh === 0) {
      if (res.draws.some((d) => isStatic(d.object, S.world))) noStaticDraws = false;
      if (res.clears.length) noClears = false;
    }
    if (res.blits.length !== res.overlay + res.refresh) blitsOk = false;
  }
  check("S3 rig frames raster", frames >= 8, `frames=${frames}`);
  check("S3 ...OVERLAY, except the two ceilings due in the window", allOverlay && overlays > 0 && refreshes === 2, JSON.stringify({ overlays, refreshes }));
  check("S3 ...zero static draws on the overlay-only frames", noStaticDraws);
  check("S3 ...no map clears on them (statics come from the cache blit)", noClears);
  check("S3 ...one blit per overlaid / refreshed cascade", blitsOk);
  check("S3 ...every rastered map exact (static + the rig's current pose)", exactAll);

  // S4 — camera move.
  const f = S.frame(() => {});
  void f;
  S.world.camera.position.x += 4;
  const fr0 = SSC.getShadowStaticCacheStats().frustumRefresh;
  const fc = S.frame(() => { rig.root.position.y += 0.4; });
  // 2026-10-20 (shadows-restore-1): FRUSTUM rasters as REFRESH — statics pass,
  // map→cache blit, rigs pass — same depth as the old single NORMAL pass.
  check("S4 camera move: all 3 REFRESH in that raster (cache rebuilt at once), exact", fc.rastered === "012" && fc.refresh === 3 && fc.normal === 0 && fc.overlay === 0 && fc.blits.length === 3 && S.allRasteredExact(fc), JSON.stringify({ r: fc.rastered, n: fc.normal, rf: fc.refresh, o: fc.overlay, b: fc.blits.length }));
  check("S4 ...counted as FRUSTUM refreshes", SSC.getShadowStaticCacheStats().frustumRefresh - fr0 === 3);
  const fr = S.frame(() => { rig.root.position.y += 0.4; });
  check("S4 next rig frame (camera settled): OVERLAY at once — no second static raster, exact", fr.overlay > 0 && fr.refresh === 0 && fr.normal === 0 && !fr.draws.some((d) => isStatic(d.object, S.world)) && S.allRasteredExact(fr), JSON.stringify({ r: fr.rastered, n: fr.normal, rf: fr.refresh, o: fr.overlay }));
  const fo = S.frame(() => { rig.root.position.y += 0.4; });
  check("S4 then OVERLAY again, exact", fo.overlay > 0 && fo.refresh === 0 && fo.normal === 0 && S.allRasteredExact(fo));

  // S4b — the frustum key, not the refit signal, guards the cache: shift a
  // cascade light behind the gate's back (no refit) and a rig frame must not
  // overlay that cascade's old cache.
  {
    const l = S.lights[2];
    l.position.x += 7; l.target.position.x += 7;
    l.updateMatrixWorld(); l.target.updateMatrixWorld();
    const fk = S.frame(() => { rig.root.position.y += 0.4; });
    const st2 = SSC.__shadowStaticCacheStateForTest(l);
    check("S4b a cascade whose frustum moved without a refit is rebuilt, not overlaid", fk.rastered.includes("2") ? (fk.refresh >= 1 && S.exact(2)) : true, JSON.stringify({ r: fk.rastered, rf: fk.refresh, o: fk.overlay }));
    check("S4b ...and its cache now matches the new frustum", !!st2 && st2.valid === true);
  }

  // S4c — a raster consumed by a layer-masked render (a different caster set)
  // must not reuse the world pass's cache, nor leave its own behind for it.
  {
    S.frame(() => { rig.root.position.y += 0.4; });
    const mask0 = S.world.camera.layers.mask;
    S.world.camera.layers.enable(3);
    const fm = S.frame(() => { rig.root.position.y += 0.4; });
    S.world.camera.layers.mask = mask0;
    const fb = S.frame(() => { rig.root.position.y += 0.4; });
    check("S4c another camera layer mask rebuilds instead of overlaying", fm.overlay === 0 && fm.refresh > 0, JSON.stringify({ rf: fm.refresh, o: fm.overlay }));
    check("S4c ...and the world mask after it rebuilds again", fb.overlay === 0 && fb.refresh > 0 && S.allRasteredExact(fb), JSON.stringify({ rf: fb.refresh, o: fb.overlay }));
  }

  // S5 — a static appears while standing still (rig keeps walking).
  const added = addStatic(S.world, 1, 20);
  S.world.scene.updateMatrixWorld();
  let seenAt = -1;
  for (let k = 1; k <= 13; k += 1) {
    S.frame(() => { rig.root.position.y += 0.2; });
    const has = (l) => [...S.R.content.get(l.shadow.map)].some((k) => k.startsWith(`${added.id}@`));
    const inMap = has(S.lights[0]) || has(S.lights[1]);
    if (inMap && seenAt < 0) seenAt = k;
  }
  check("S5 a static added mid-walk is in the maps within the 12-frame ceiling", seenAt > 0 && seenAt <= 12, `seenAt=${seenAt}`);
  const fx = S.frame(() => { rig.root.position.y += 0.2; });
  check("S5 ...and rasters stay exact after its refresh", S.allRasteredExact(fx));

  // S6 — context loss/restore.
  S.R.renderer.domElement.fire("webglcontextlost");
  S.R.renderer.domElement.fire("webglcontextrestored");
  const fl = S.frame(() => { rig.root.position.y += 0.2; });
  const fl2 = S.frame(() => { rig.root.position.y += 0.2; });
  check("S6 after a context restore the next rig raster rebuilds (no OVERLAY of a stale cache)", (fl.overlay === 0 && fl.refresh > 0) || (fl.rastered === "" && fl2.refresh > 0 && fl2.overlay === 0), JSON.stringify({ a: [fl.rastered, fl.refresh, fl.overlay], b: [fl2.rastered, fl2.refresh, fl2.overlay] }));

  // S7 — shadow.map disposed (csm.js dispose / type change).
  const l0 = S.lights[0];
  const st0 = SSC.__shadowStaticCacheStateForTest(l0);
  const oldRT = st0 && st0.rt;
  let disposed = false;
  if (oldRT) oldRT.addEventListener("dispose", () => { disposed = true; });
  const oldMap = l0.shadow.map;
  oldMap.dispose();
  check("S7 disposing a shadow map frees its cache", disposed && st0.rt === null);
  l0.shadow.map = null; // three re-creates it on the next raster
  S.world.camera.position.x += 1; // FRUSTUM: three allocates a fresh map
  S.frame(() => { rig.root.position.y += 0.2; });
  const f7 = S.frame(() => { rig.root.position.y += 0.2; });
  const st0b = SSC.__shadowStaticCacheStateForTest(l0);
  check("S7 ...and a new cache is made for the new map", !!(st0b && st0b.rt && st0b.mapRef === l0.shadow.map && st0b.rt !== oldRT), JSON.stringify({ r: f7.rastered, rf: f7.refresh }));
  check("S7 ...exact", S.allRasteredExact(f7));

  // S8 — the rigs' root hidden (portal space hides the world, etc.).
  S.frame(() => { rig.root.position.y += 0.2; });
  S.world.entitiesGroup.visible = false;
  const f8 = S.frame(() => {});
  check("S8 hidden dynamic root: the flip rasters, nothing dynamic drawn, exact", f8.rastered !== "" && f8.draws.every((d) => isStatic(d.object, S.world)) && S.allRasteredExact(f8));
  S.world.entitiesGroup.visible = true;

  // S9 — renderer state around the cache path.
  const f9 = S.frame(() => { rig.root.position.y += 0.2; });
  const f9b = S.frame(() => { rig.root.position.y += 0.2; });
  const blits = [...f9.blits, ...f9b.blits];
  check("S9 every blit runs with the scissor test off and depth writes on", blits.length > 0 && blits.every((x) => x.scissor === false && x.depthMask === true));
  check("S9 the caller's render target is restored", f9.rtRestored && f9b.rtRestored);
  check("S9 renderer.clear is restored", f9.clearRestored && f9b.clearRestored);

  // S10a — a blit the driver rejects (gl.getError after one of the first
  // blits of the session) is an error too.
  {
    SSC.__resetShadowStaticCacheForTest();
    const GL_INVALID_OPERATION = 0x0502;
    let pendingErr = 0;
    const gl = { NO_ERROR: 0, getError() { const e = pendingErr; pendingErr = 0; return e; } };
    S.R.renderer.getContext = () => gl;
    const copy = S.R.renderer.copyTextureToTexture;
    S.R.renderer.copyTextureToTexture = function (...args) { copy.apply(this, args); pendingErr = GL_INVALID_OPERATION; };
    // FRUSTUM now: since 2026-10-20 (shadows-restore-1) that very raster
    // REFRESHes, so ITS blit is the checked one.
    S.world.camera.position.x += 1;
    const warn0 = console.warn; console.warn = () => {};
    const fe = S.frame(() => { rig.root.position.y += 0.2; });
    console.warn = warn0;
    const st = SSC.getShadowStaticCacheStats();
    check("S10a a GL error after a checked blit stands the cache down, this frame re-rastered plain + exact", st.errors === 1 && /GL error 0x502/.test(st.lastError || "") && fe.rastered !== "" && S.allRasteredExact(fe), JSON.stringify({ e: st.errors, le: st.lastError, r: fe.rastered }));
    S.R.renderer.copyTextureToTexture = copy;
    delete S.R.renderer.getContext;
    SSC.__resetShadowStaticCacheForTest();
    S.world.camera.position.x += 1;
    S.frame(() => { rig.root.position.y += 0.2; });
  }

  // S10 — a throwing blit.
  S.R.renderer.throwOnBlit = true;
  const warn = console.warn; console.warn = () => {};
  const f10 = S.frame(() => { rig.root.position.y += 0.2; });
  console.warn = warn;
  check("S10 a throwing blit falls back to a plain raster, exact", f10.rastered !== "" && S.allRasteredExact(f10) && SSC.getShadowStaticCacheStats().errors === 1);
  const f10b = S.frame(() => { rig.root.position.y += 0.2; });
  check("S10 ...and the session stays on plain rasters", f10b.overlay === 0 && f10b.refresh === 0 && S.allRasteredExact(f10b));
  SSC.__resetShadowStaticCacheForTest();
}

// ---------------------------------------------------------------- S11
{
  SSC.__setShadowStaticCacheOffForTest(true);
  const S = makeSession();
  S.frame();
  const rig = addRig(S.world, 2, 12);
  S.entityMap.set(1, rig);
  let plain = true, exactAll = true;
  for (let f = 0; f < 16; f += 1) {
    const res = S.frame(() => { rig.root.position.y += 0.4; });
    if (res.overlay || res.refresh || res.blits.length) plain = false;
    if (!S.allRasteredExact(res)) exactAll = false;
  }
  check("S11 =off seam: plain rasters only, exact", plain && exactAll);
  SSC.__setShadowStaticCacheOffForTest(false);
}
{
  const S = makeSession({ dynRoot: false });
  S.frame();
  const rig = addRig(S.world, 2, 12);
  S.entityMap.set(1, rig);
  let plain = true, exactAll = true;
  for (let f = 0; f < 16; f += 1) {
    const res = S.frame(() => { rig.root.position.y += 0.4; });
    if (res.overlay || res.refresh || res.blits.length) plain = false;
    if (!S.allRasteredExact(res)) exactAll = false;
  }
  check("S11 no dynamic root registered: stands down (never caches a rig as static)", plain && exactAll);
}
{
  L.__resetRp5ConfigForTest({ shadowMoverScope: false });
  const S = makeSession();
  S.frame();
  const rig = addRig(S.world, 2, 12);
  S.entityMap.set(1, rig);
  let plain = true, exactAll = true;
  for (let f = 0; f < 16; f += 1) {
    const res = S.frame(() => { rig.root.position.y += 0.4; });
    if (res.overlay || res.refresh || res.blits.length) plain = false;
    if (!S.allRasteredExact(res)) exactAll = false;
  }
  check("S11 ?shadowMoverScope=off (no managed lights): stands down", plain && exactAll);
  L.__resetRp5ConfigForTest(undefined);
}

// ---------------------------------------------------------------- S12
check("S12 absent ⇒ on", SSC.shadowStaticCacheFlag("") === true);
check("S12 off/0/false/no ⇒ off", ["off", "0", "false", "no", "OFF"].every((v) => SSC.shadowStaticCacheFlag(`?shadowStaticCache=${v}`) === false));
check("S12 on ⇒ on", SSC.shadowStaticCacheFlag("?shadowStaticCache=on") === true);

console.log(`\nshadow_static_cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
