// tests/gpu_batch_anim_scenery.test.mjs — R3-3 K3: `?animSceneryBatch`
// (DEFAULT OFF), the GPU batch kit's first consumer
// (scene3d/gpu_batch/anim_scenery_batch.js + the hooks in
// scene3d/animated_scenery.js; docs/2026-10-29-round3-gpu-driven.md §R3-3
// item 8 and its "fake-WebGL2 GL-stream check of the consumer").
//
// The scene is the census case: the insect cloud 0x020004B0 (13 parts over
// three real surfaces — 0x0800007A 64x64, 0x0800007B 32x64 on 8 parts,
// 0x0800007C 64x64 on 4 parts; all Base1Image), a butterfly-like setup (2
// parts, one ClipMap surface: alpha-tested), and a setup whose surface is
// translucent. Members are built by the REAL MaterialCache ladder
// (`_materialFromFlags`) over adapter.js textures, posed by the real
// animated_scenery.js / anim_scenery_gpu.js path and drawn by three r184
// against a recording fake WebGL2.
//
// Locks:
//   1. flag OFF: nothing of the kit runs or allocates; one instanced draw per
//      visible bucket (17), exactly as before;
//   2. flag ON: insect cloud 13 draws -> 2 (one ARRAY draw for 7A + 7C, whose
//      64x64 textures share a page; one SAME draw for the 8 parts of 7B),
//      butterfly 2 -> 1 (SAME), the translucent setup stays legacy (2):
//      17 -> 5 draws; the legacy buckets the batch draws for are hidden and
//      their raycast muted;
//   3. the posed matrix of every (instance, part) the batch draws equals the
//      matrix the legacy bucket drew (JS mirror of the shared shader math),
//      for many frames of animation and orbit; the merged geometry carries
//      each bucket's vertices and pose row verbatim;
//   4. a SAME draw binds the very uniforms the legacy bucket bound (same
//      program, same textures, same values); an ARRAY draw binds the page and
//      the state table, and each slot row holds the member's f32 uniforms;
//   5. the GL stream of the build: one texStorage3D per page, one
//      copyTexSubImage3D per (layer, level), the driver's mips (three's
//      generateMipmap on the 2D source), never a re-mip of the array;
//   6. the upload budget: with 1 admit a frame the batch waits (legacy keeps
//      drawing) until every layer is in, then shows;
//   7. a member map swap (a BC7 upgrade) tears the batch down in the same
//      frame (legacy back on screen) and rebuilds it on the new texture;
//   8. park / hide collapse: no live instance -> the batch hides; shown
//      again -> its shared instance attribute is uploaded whole;
//   9. the raycast facade hits the POSED part (instance and part reported);
//  10. disposeAnimatedScenery removes the batch;
//  11. the class programs are registered and compiled at the first
//      registration;
//  12. ARRAY refusals: a member with a POM / detail / CSM / baked-light /
//      depth-bias / VFX chain, a luminous emissive (flat, or the ladder's
//      emissiveMap), an extra map (ao / light / roughness / bump) or a shadow
//      caster keeps its own program (SAME draws), each for its own reason,
//      next to a control setup that does go ARRAY; a member that becomes a
//      shadow caster later tears its ARRAY draw down into SAME draws; the
//      class compile runs the member's chain but leaves the member's live
//      userData uniform handles exactly as they were;
//  13. the geometry upload gate: in a frame whose budget is spent, nothing
//      is merged or allocated, the group stays "building", the legacy buckets
//      keep drawing; the batch shows once a frame admits its bytes;
//  14. overlap has no time cap: the legacy buckets stay on screen until three
//      has drawn the class material (hidden frames do not count); never drawn
//      for BATCH_OVERLAP_GIVEUP_FRAMES frames on screen -> legacy for good;
//  15. a WebGL context loss + restore: torn down (legacy shows), and the
//      class programs are compiled again on the restored context before the
//      batch shows (not left to a 120-frame wait and a link at first draw);
//  16. bundle-shaped parts (?geomBundles, default on: INDEXED part groups
//      that share the whole model's vertex stream, built by the real
//      geom_bundles.js bundleToPartGroups): each merged bucket is compacted
//      to the vertices its index names (6 buckets x 300 shared vertices merge
//      306 vertices, not 1,800), with the same triangles over the same
//      per-vertex values, and mergedBytesOf == the allocation (16/32-bit
//      index by the compacted count, out-of-range index refused);
//  17. the frame that pays for a kit geometry is the frame that uploads it:
//      while a class program links or the setup has no live instance nothing
//      is charged, and every frame's charged geometry bytes equal the bytes
//      three uploads for batch geometry in that frame's render;
//  17b. a member that drifts while its setup waits in "building" re-plans
//      before anything is charged (the first shown batch is never stale);
//  18. a context lost AND restored with no tick in between (a new GL-context
//      generation while gl.isContextLost() is false again): the batch is torn
//      down, re-planned onto new pages and class programs, no texture of the
//      lost context is bound by any later draw, the legacy buckets draw until
//      the class material does — with the canvas events (render before the
//      first tick) and without them (the per-tick generation check);
//  18b. pages reset by another kit consumer (a new generation): every batch
//      built on them starts over;
//  19. (K3) a context loss / restore deletes NO GL object of the lost context
//      (no deleteBuffer / deleteVertexArray / deleteTexture / ... on an id
//      made before the loss, from the loss on) — with the canvas events,
//      without them (the per-tick generation check), and without them with a
//      render on the restored context before the first tick, where the
//      torn-down geometries' buffers and VAOs of the RESTORED context are
//      still deleted (nothing leaks on the live context);
//  20. (K3) the cap holds per UPLOAD frame: in the app's order (the render
//      loop runs before this module's tick in a rAF frame), with paced
//      renders and in the flipped order, the kit bytes that reach GL in a rAF
//      frame (layer copies in its tick + batch geometry its render uploads)
//      stay within the cap or are one upload alone; a batch torn down before
//      its first render carries nothing;
//  21. (K3) S1 timings: kit.budget ms / maxMs / timed per kind and the
//      geometry phases are numbers, and the layer admits, the merge, three's
//      attribute upload and the first draw are each timed.
//
// Tests 3 and 13 run on the default (non-indexed) fixture AND the bundle one.
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_anim_scenery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 1;
globalThis.window.cancelAnimationFrame ??= () => {};

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const AS = await import("../scene3d/animated_scenery.js");
const GPU = await import("../scene3d/anim_scenery_gpu.js");
const ASB = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const M = await import("../scene3d/materials.js");
const {
  surfacePixelsToTexture, surfacePixelsToNormalTexture, surfacePixelsToHeightTexture, surfacePixelsToRoughnessTexture, surfacePixelsToAoTexture,
} = await import("../scene3d/adapter.js");
const SP = await import("../scene3d/shader_prewarm.js");
const { UPLOAD_KIND } = await import("../scene3d/gpu_batch/upload_budget.js");
const GB = await import("../scene3d/geom_bundles.js");
const LIB = await import("../harness/glsl_smoke/gpu_batch_lib.mjs");

const INSECTS = 0x020004b0;
const BUTTERFLY = 0x02000493;
const GHOST = 0x02000777;
const ANIM = { [INSECTS]: 0x03000700, [BUTTERFLY]: 0x030006cb, [GHOST]: 0x03000778 };
// Part -> surface, as the DAT has it for 0x020004B0 (dump 2026-10-30).
const PARTS = {
  [INSECTS]: [0x0800007a, 0x0800007b, 0x0800007b, 0x0800007c, 0x0800007b, 0x0800007b, 0x0800007b,
    0x0800007b, 0x0800007b, 0x0800007b, 0x0800007c, 0x0800007c, 0x0800007c],
  [BUTTERFLY]: [0x0800128c, 0x0800128c],
  [GHOST]: [0x08000999, 0x08000999],
};
const SURF = {
  0x0800007a: { w: 64, h: 64, flags: 0x2 },
  0x0800007b: { w: 32, h: 64, flags: 0x2 },
  0x0800007c: { w: 64, h: 64, flags: 0x2, diffuse: 0.5 },
  0x0800128c: { w: 128, h: 64, flags: 0x4, hasPalette: false },
  0x08000999: { w: 16, h: 16, flags: 0x10, translucency: 0.4 },
};

// The ARRAY refusal fixtures (test 12): per case a setup of 4 parts over two
// 64x64 Base1Image surfaces [A, B, A, B] that WOULD share one ARRAY draw (the
// "control" case does), each member built by the real ladder — with a cache
// knob (POM / detail / CSM, as MaterialCache installs them) or a real
// installer / mutation applied to the built member — so exactly one thing
// stands between it and the ARRAY draw. `reason` = the unit's arrayReason.
const r8 = (w, h, v) => new Uint8Array(w * h).fill(v);
const REFUSALS = [
  { name: "control", reason: null },
  { name: "control-clip", reason: null, flags: 0x4, hasPalette: true },
  { name: "pom", reason: "shader-chain", cache: "pom", key: /\|p1\|/ },
  { name: "detail", reason: "shader-chain", cache: "detail", key: /\|d1\|/ },
  { name: "csm", reason: "shader-chain", cache: "csm", key: /\|c2\|/ },
  { name: "baked-light", reason: "shader-chain", mutate: (m) => M.applyBakedVertexLightPatch(m), key: /\|k1/ },
  { name: "static-bias", reason: "shader-chain", mutate: (m) => M.applyStaticDepthBias(m), key: /\|s1\|/ },
  { name: "vfx", reason: "shader-chain", mutate: (m) => { m.userData.__vfxSetKey = "frag:test"; }, key: /\|vfrag:test/ },
  { name: "luminous-ladder", reason: "map:emissiveMap", luminosity: 0.6 },
  { name: "luminous-flat", reason: "luminous", mutate: (m) => { m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = 0.6; } },
  { name: "ao-map", reason: "map:aoMap", mutate: (m) => { m.aoMap = surfacePixelsToAoTexture(r8(64, 64, 200), 64, 64); } },
  { name: "light-map", reason: "map:lightMap", mutate: (m) => { m.lightMap = surfacePixelsToAoTexture(r8(64, 64, 180), 64, 64); } },
  { name: "roughness-map", reason: "map:roughnessMap", mutate: (m) => { m.roughnessMap = surfacePixelsToRoughnessTexture(r8(64, 64, 120), 64, 64); } },
  { name: "bump-map", reason: "map:bumpMap", mutate: (m) => { m.bumpMap = surfacePixelsToHeightTexture(r8(64, 64, 90), 64, 64); } },
  { name: "shadow-caster", reason: "shadow-caster", castShadow: true },
];
// The bundle-shaped setup (?geomBundles, DEFAULT ON in the app): ONE shared
// vertex stream (5 parts x 60 vertices = 300) and a 16-bit index; each part
// names index ranges, part 4 carries two surfaces whose triangles share a row
// of 6 vertices. The real geom_bundles.js bundleToPartGroups hands every
// (part, surface) group the WHOLE stream + its own index (6 buckets).
const BUNDLE = 0x02000b00;
const BA = 0x08000b0a, BB = 0x08000b0b, BC = 0x08000b0c;
ANIM[BUNDLE] = 0x03000b00;
PARTS[BUNDLE] = [BA, BB, BA, BC, BC]; // part count for the anim mock (geometry comes from the bundle)
SURF[BA] = { w: 64, h: 64, flags: 0x2 };
SURF[BB] = { w: 64, h: 64, flags: 0x2, diffuse: 0.7 };
SURF[BC] = { w: 32, h: 64, flags: 0x2 };
const BUNDLE_SURFS = [[BA], [BB], [BA], [BC], [BC, BA]];
function bundleModel() {
  const COLS = 6, ROWS = 10;
  const positions = [], normals = [], uvs = [], index = [], parts = [];
  for (let p = 0; p < BUNDLE_SURFS.length; p++) {
    const base = p * COLS * ROWS;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const j = r * COLS + c;
        positions.push(p * 0.8 + c * 0.1, r * 0.07, 0.003 * j + 0.01 * p);
        const n = new THREE.Vector3(0.01 * c - 0.02, 0.02 * r - 0.05, 1).normalize();
        normals.push(n.x, n.y, n.z);
        uvs.push(c / (COLS - 1) + 0.01 * p, r / (ROWS - 1));
      }
    }
    const quads = (r0, r1) => {
      const first = index.length;
      for (let r = r0; r < r1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const a = base + r * COLS + c;
          index.push(a, a + 1, a + COLS + 1, a, a + COLS + 1, a + COLS);
        }
      }
      return { firstIndex: first, indexCount: index.length - first };
    };
    const surfs = BUNDLE_SURFS[p];
    const subsets = surfs.length === 1
      ? [{ surfaceDid: surfs[0], flags: 0, ...quads(0, ROWS - 1) }]
      : [{ surfaceDid: surfs[0], flags: 0, ...quads(0, 5) }, { surfaceDid: surfs[1], flags: 0, ...quads(5, ROWS - 1) }];
    parts.push({ subsets, hinge: [0.05 * p, 0, 0.4, 1, 0, 0, 0] });
  }
  return { id: BUNDLE, positions, normals, uvs, index, parts };
}

REFUSALS.forEach((c, i) => {
  c.setup = 0x02001000 + i;
  c.surfaces = [0x08001000 + 2 * i, 0x08001001 + 2 * i];
  ANIM[c.setup] = 0x03001000 + i;
  PARTS[c.setup] = [c.surfaces[0], c.surfaces[1], c.surfaces[0], c.surfaces[1]];
  for (const sid of c.surfaces) {
    SURF[sid] = { w: 64, h: 64, flags: c.flags ?? 0x2, hasPalette: c.hasPalette, luminosity: c.luminosity, cache: c.cache, mutate: c.mutate };
  }
});

// The cache knobs MaterialCache reads (materials.js: pomEnabled + forcePom,
// detailTileCache + forceDetail, csmState with csm.js's shared uniforms).
const CSM_STUB = { uniforms: {
  uCsmShadowMap0: { value: null }, uCsmShadowMap1: { value: null }, uCsmShadowMap2: { value: null },
  uCsmMatrix0: { value: new THREE.Matrix4() }, uCsmMatrix1: { value: new THREE.Matrix4() }, uCsmMatrix2: { value: new THREE.Matrix4() },
  uCsmSplits: { value: new THREE.Vector2(20, 80) }, uCsmFar: { value: 300 }, uCsmBlend: { value: 0.1 },
} };
function cacheFor(kind) {
  if (kind === "pom") return new M.MaterialCache({ pomEnabled: true, forcePom: true });
  if (kind === "detail") {
    const tile = surfacePixelsToHeightTexture(r8(16, 16, 128), 16, 16);
    return new M.MaterialCache({ detailTileCache: new Map([["generic-rough", tile]]), forceDetail: true });
  }
  if (kind === "csm") return new M.MaterialCache({ csmState: CSM_STUB });
  return new M.MaterialCache();
}

// Materials through the real cache ladder, memoised per DID like MaterialCache.get.
function materialCache() {
  const caches = new Map();
  const mats = new Map();
  const get = async (sid) => {
    if (mats.has(sid)) return mats.get(sid);
    const s = SURF[sid];
    const kind = s.cache || "plain";
    if (!caches.has(kind)) caches.set(kind, cacheFor(kind));
    const px = new Uint8Array(s.w * s.h * 4);
    for (let i = 0; i < px.length; i++) px[i] = (i * 31 + sid) & 255;
    const nrm = new Uint8Array(s.w * s.h * 3);
    for (let i = 0; i < nrm.length; i++) nrm[i] = (i * 7 + 90) & 255;
    const height = s.cache === "pom" ? surfacePixelsToHeightTexture(r8(s.w, s.h, 77), s.w, s.h) : null;
    const m = caches.get(kind)._materialFromFlags(s.flags, surfacePixelsToTexture(px, s.w, s.h), undefined,
      surfacePixelsToNormalTexture(nrm, s.w, s.h), undefined, height,
      { translucency: s.translucency ?? 0, luminosity: s.luminosity ?? 0, diffuse: s.diffuse ?? 1, hasPalette: s.hasPalette });
    if (s.mutate) s.mutate(m);
    mats.set(sid, m);
    return m;
  };
  return { get, mats };
}

function framesFor(numParts, seed) {
  const out = [];
  for (let f = 0; f < 6; f++) {
    for (let p = 0; p < numParts; p++) {
      const a = (f / 6) * Math.PI * 2 + p * 0.37 + seed;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.2, 0.3 + p * 0.01, 1).normalize(), Math.sin(a) * 0.6);
      out.push(Math.sin(p) * 2, Math.cos(p) * 1.5, 3 + p * 0.1 + 0.2 * Math.sin(a), q.w, q.x, q.y, q.z);
    }
  }
  return new Float32Array(out);
}
function wasm() {
  const tri = (sid, k) => ({
    triCount: 1,
    positions: new Float32Array([0, 0, 0, 0.4 + k * 0.01, 0, 0, 0, 0.3, 0.05 * k]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([sid]),
  });
  return {
    async fetchAnimation(animId) {
      const setup = Number(Object.keys(ANIM).find((k) => ANIM[k] === (animId >>> 0)));
      const n = PARTS[setup].length;
      const a = { numParts: n, numFrames: 6, flags: 2, frames: framesFor(n, setup & 7), free() {} };
      if (setup === BUTTERFLY) a.setOmega = new Float32Array([0.01, 0.006, -0.03]);
      return a;
    },
    async fetchBuildingPlacement(setupId) {
      const parts = PARTS[setupId >>> 0];
      return {
        partCount: parts.length,
        takePartMeshes: () => parts.map((sid, k) => tri(sid, k)),
        takePartHingeFrames: () => parts.map((_, k) => ({ x: k * 0.1, y: 0, z: 0.5, qw: 1, qx: 0, qy: 0, qz: 0 })),
        free() {},
      };
    },
    fetch_surfaces_pixels: async () => [],
  };
}

const LB = 0xa9b30000;
const DEFAULT_SETUPS = [INSECTS, BUTTERFLY, GHOST];
function placements(setups = DEFAULT_SETUPS) {
  const out = [];
  let i = 0;
  for (const setup of setups) {
    for (let k = 0; k < 3; k++) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4 * k + i);
      out.push({ objId: setup, defaultAnimationId: ANIM[setup], landblockId: LB, sourceObjIdx: ++i,
        x: 20 + 30 * k + i, y: 40 + 7 * i, z: 50, qw: q.w, qx: q.x, qy: q.y, qz: q.z, scale: 1 + 0.1 * k });
    }
  }
  return out;
}

// The production per-frame path: animated_scenery.js's own rAF loop, captured.
let _rafCb = null;
let _rafTs = 1000;
globalThis.window.requestAnimationFrame = (cb) => { _rafCb = cb; return 1; };
function step(n = 1) {
  for (let i = 0; i < n; i++) {
    const cb = _rafCb;
    assert.ok(cb, "the loop is armed");
    _rafTs += 16.7;
    cb(_rafTs);
  }
}

async function world(batch, opts = {}) {
  AS.disposeAnimatedScenery();
  _rafCb = null;
  KIT.resetKit();
  GPU.__setAnimSceneryGpuForTest(true);
  AS.__setAnimSceneryBatchForTest(batch);
  AS.__setAnimSceneryOmegaHzForTest(15);
  const calls = [];
  const gl = createFakeWebGL2({ onCall: (n, a) => { if (opts.record !== false) calls.push([n, Array.from(a)]); } });
  const canvas = fakeCanvas(gl);
  // The canvas events, so a test can lose / restore the context: three's own
  // listeners (added first, in the WebGLRenderer constructor) and the batch's.
  // `contextEvents: false` delivers them to three only (no event reaches the
  // batch: its per-tick generation check must notice on its own).
  const listeners = {};
  canvas.addEventListener = (type, fn) => {
    const l = listeners[type] || (listeners[type] = []);
    if (opts.contextEvents === false && l.length > 0) return;
    l.push(fn);
  };
  canvas.removeEventListener = (type, fn) => {
    const l = listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  let lost = false;
  gl.isContextLost = () => lost;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const scene = new THREE.Scene();
  const staticsGroup = new THREE.Group();
  scene.add(staticsGroup);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(0, 0, 200);
  ASB.__setAnimSceneryBatchEnvForTest(batch ? { renderer, camera, scene } : null);
  const mc = materialCache();
  const scene3d = { staticsGroup, materialCache: { get: mc.get } };
  const setups = opts.setups || DEFAULT_SETUPS;
  // ?geomBundles: the bundle setup's geometry comes from an HBG1 bundle
  // through the real geom_bundles.js (other setups: reported missing ->
  // the runtime decode, as in the app).
  if (opts.bundle) GB._testArm(LIB.bundleWasmExports({ [BUNDLE]: bundleModel() }));
  let r;
  try {
    r = await AS.attachAnimatedScenery(scene3d, placements(setups), wasm(), {});
  } finally {
    GB._testDisarm();
  }
  assert.equal(r.built, setups.length * 3);
  return {
    gl, calls, renderer, scene, staticsGroup, camera, mats: mc.mats, listeners,
    loseContext() { lost = true; for (const fn of [...(listeners.webglcontextlost || [])]) fn({ preventDefault() {} }); },
    restoreContext() { lost = false; for (const fn of [...(listeners.webglcontextrestored || [])]) fn({}); },
  };
}
const buckets = (g) => g.staticsGroup.children.filter((o) => o.isInstancedMesh && /^anim-inst-/.test(o.name));
const batchMeshes = (g) => g.staticsGroup.children.filter((o) => o.isInstancedMesh && o.userData?.animSceneryBatch);
function drawsOf(w) {
  w.gl.__fake.startSnapshots();
  w.renderer.render(w.scene, w.camera);
  return w.gl.__fake.takeSnapshots().filter((s) => s.kind === "drawArraysInstanced" || s.kind === "drawElementsInstanced");
}

test("1. flag off: no kit, one draw per bucket, as before", async () => {
  const w = await world(false);
  step(4);
  assert.equal(buckets(w).length, 13 + 2 + 2);
  assert.equal(batchMeshes(w).length, 0);
  assert.equal(drawsOf(w).length, 17);
  assert.equal(AS.animatedSceneryDiag().batch, undefined, "the batch never armed");
  const kit = KIT.kitSummary();
  assert.deepEqual([kit.budget, kit.pages, kit.stateRows], [null, null, null], "the kit allocated nothing");
  assert.equal(AS.animSceneryBatchEnabled(), false);
  AS.__setAnimSceneryBatchForTest(undefined);
  assert.equal(AS.animSceneryBatchEnabled(), false, "DEFAULT OFF with no URL");
});

// A frame of the app: the anim loop, then the render (the batch shows next
// to the legacy buckets until three has drawn its class materials once).
function frame(w, n = 1) {
  for (let i = 0; i < n; i++) { step(1); w.renderer.render(w.scene, w.camera); }
}
async function activeWorld(opts) {
  const w = await world(true, opts);
  frame(w, 6);
  return w;
}

test("2. flag on: 17 draws -> 5; legacy buckets hidden and muted", async () => {
  // The overlap frame: the batch is on screen next to the still-visible
  // legacy buckets until three has drawn its class material once.
  {
    const w0 = await world(true);
    const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
    let k = 0;
    while (ins().status !== "overlap" && k++ < 10) step(1);
    assert.equal(ins().status, "overlap");
    assert.ok(ins().draws.every((d) => d.mesh.parent && d.mesh.visible), "batch draws shown");
    assert.equal(buckets(w0).filter((b) => b.name.includes(INSECTS.toString(16)) && b.visible).length, 13, "legacy still drawn");
    step(1);
    assert.equal(ins().status, "overlap", "no draw of the class material yet: keep overlapping");
    w0.renderer.render(w0.scene, w0.camera);
    step(1);
    assert.equal(ins().status, "active", "drawn once: the legacy buckets go");
  }
  const w = await activeWorld();
  const groups = ASB.__animSceneryBatchGroupsForTest();
  const by = (setup) => groups.find((g) => g.setupId === setup);
  assert.equal(by(INSECTS).status, "active");
  assert.deepEqual(by(INSECTS).draws.map((d) => [d.kind, d.units.length]), [["array", 2], ["same", 1]]);
  assert.equal(by(BUTTERFLY).status, "active");
  assert.deepEqual(by(BUTTERFLY).draws.map((d) => d.kind), ["same"]);
  assert.equal(by(GHOST).status, "legacy", "translucent: blend order stays per bucket");
  assert.equal(by(GHOST).reason, "nothing-to-merge");
  assert.equal(drawsOf(w).length, 5);
  for (const b of buckets(w)) {
    const mine = b.name.includes(INSECTS.toString(16)) || b.name.includes(BUTTERFLY.toString(16));
    assert.equal(b.visible, !mine, b.name);
    assert.equal(Object.prototype.hasOwnProperty.call(b, "raycast"), mine, `${b.name} raycast muted iff batched`);
  }
  const diag = AS.animatedSceneryDiag().batch;
  assert.equal(diag.draws, 3);
  assert.equal(diag.bucketsTaken, 15);
  assert.equal(diag.arrayDraws, 1);
  assert.equal(diag.sameDraws, 2);
});

function slotOf(bucketMesh, inst) {
  return inst.slots.find((s) => s.bucket.mesh === bucketMesh).index;
}

test("3. every drawn (instance, part) matrix equals the legacy bucket's, frame after frame", async () => {
  // The default fixture (non-indexed parts) and the bundle one (indexed,
  // shared vertex stream: compacted per bucket).
  for (const fx of [{ opts: {}, active: 2 }, { opts: { setups: [BUNDLE], bundle: true }, active: 1 }]) {
    await mergedEqualsLegacy(fx);
  }
});
async function mergedEqualsLegacy(fx) {
  await activeWorld(fx.opts);
  const groups = ASB.__animSceneryBatchGroupsForTest().filter((g) => g.status === "active");
  assert.equal(groups.length, fx.active, "insects + butterfly batched / the bundle setup batched");
  const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();
  for (let frame = 0; frame < 12; frame++) {
    AS.tickAnimatedScenery(frame % 3 === 0 ? 0.05 : 1 / 60);
    for (const g of groups) {
      const repMembers = g.rep.members;
      for (const d of g.draws) {
        assert.equal(d.mesh.count, repMembers.length);
        assert.equal(d.mesh.instanceMatrix, g.rep.mesh.instanceMatrix, "the rep bucket's attribute, shared");
        for (let i = 0; i < d.mesh.count; i++) {
          const inst = repMembers[i];
          for (const slice of d.slices) {
            // What the batch draws: the facade's matrix (= the shader's composition).
            d.mesh.getMatrixAt(i, mA);
            GPU.posedMatrixFromRow(mA, slice.row, mA);
            // What the legacy bucket drew for the same instance and part.
            AS.animSceneryEffectiveMatrixAt(slice.bucket.mesh, slotOf(slice.bucket.mesh, inst), mB);
            assert.deepEqual(Array.from(mA.elements), Array.from(mB.elements), `${g.key} part ${slice.part} inst ${i}`);
          }
        }
      }
    }
  }
  // Merged geometry = each bucket's vertices (every attribute) and pose row,
  // verbatim, in part order; an indexed bucket's triangles name the same
  // source vertices in the same order (index remapped + rebased).
  for (const g of groups) {
    for (const d of g.draws) {
      const pose = d.geometry.getAttribute("hbAiPose");
      const mi = d.geometry.index;
      for (const sl of d.slices) {
        const src = sl.bucket.mesh.geometry;
        assert.equal(!!mi, !!src.index, "indexed iff the sources are");
        for (let v = 0; v < sl.vertexCount; v++) {
          const sv = sl.vertexMap ? sl.vertexMap[v] : v;
          for (const name of Object.keys(src.attributes)) {
            const a = src.attributes[name], m = d.geometry.getAttribute(name);
            for (let c = 0; c < a.itemSize; c++) {
              assert.equal(m.array[(sl.vertexStart + v) * a.itemSize + c], a.array[sv * a.itemSize + c], `${g.key} ${name} vertex ${v}`);
            }
          }
          assert.equal(pose.array[sl.vertexStart + v], sl.bucket.mesh.userData.animGpuRow);
        }
        if (mi) {
          for (let k = 0; k < sl.count; k++) {
            const m = mi.array[sl.start + k];
            assert.ok(m >= sl.vertexStart && m < sl.vertexStart + sl.vertexCount, `${g.key} part ${sl.part}: index ${k} inside its slice (${m})`);
            assert.equal(sl.vertexMap[m - sl.vertexStart], src.index.array[k], `${g.key} part ${sl.part}: triangle corner ${k} names the same source vertex`);
          }
        }
      }
      const parts = d.slices.map((s) => s.part);
      assert.deepEqual(parts, [...parts].sort((a, b) => a - b), "part order");
    }
  }
}

test("4. SAME draws bind the legacy uniforms; ARRAY slots hold the members' f32 uniforms", async () => {
  const w = await activeWorld();
  const groups = ASB.__animSceneryBatchGroupsForTest().filter((g) => g.status === "active");
  const draws = drawsOf(w);
  // Legacy reference: draw one hidden bucket alone.
  const ins = groups.find((g) => g.setupId === INSECTS);
  const same = ins.draws.find((d) => d.kind === "same");
  const ref = same.units[0].buckets[0].mesh;
  const solo = new THREE.Scene();
  const solo3 = new THREE.Group();
  solo.add(solo3);
  const saveParent = ref.parent;
  solo3.add(ref);
  ref.visible = true;
  w.gl.__fake.startSnapshots();
  w.renderer.render(solo, w.camera);
  const legacy = w.gl.__fake.takeSnapshots().find((s) => s.kind === "drawArraysInstanced");
  saveParent.add(ref);
  ref.visible = false;
  assert.equal(same.mesh.material, ref.material, "the bucket's own GPU variant material");
  const batched = draws.find((s) => s.program === legacy.program && s.uniforms.map === legacy.uniforms.map);
  assert.ok(batched, "a batch draw with the legacy program and map");
  for (const k of Object.keys(legacy.uniforms)) {
    assert.deepEqual(batched.uniforms[k], legacy.uniforms[k], `uniform ${k}`);
  }
  // The ARRAY draw: class material, page + state table bound, rows = member uniforms.
  const arr = ins.draws.find((d) => d.kind === "array");
  const pageTex = arr.units[0].mapRef.page.gl.tex;
  assert.ok(arr.units.every((u) => u.mapRef.page === arr.units[0].mapRef.page), "one page");
  const snap = draws.find((s) => s.uniforms.hbBatchMapArr !== undefined);
  assert.equal(snap.uniforms.hbBatchMapArr, `tex#${pageTex.__id}`);
  assert.match(snap.uniforms.hbBatchNrmArr, /^tex#\d+$/);
  const rows = KIT.kitStateTable().rows;
  for (const u of arr.units) {
    const o = u.slot * rows.floatsPerRow;
    const m = u.member;
    assert.deepEqual(Array.from(rows.data.subarray(o, o + 9)), [m.color.r, m.color.g, m.color.b, m.opacity, m.roughness, m.metalness,
      m.normalScale.x, m.normalScale.y, m.alphaTest > 0 ? m.alphaTest : 0].map(Math.fround));
    assert.equal(rows.data[o + 9], u.mapRef.layer);
    assert.equal(rows.data[o + 12], u.nrmRef.layer);
  }
  assert.notDeepEqual(Array.from(rows.data.subarray(arr.units[0].slot * 16, arr.units[0].slot * 16 + 3)),
    Array.from(rows.data.subarray(arr.units[1].slot * 16, arr.units[1].slot * 16 + 3)), "7A untinted, 7C diffuse 0.5: per-slot tint");
  // Merged slot attribute: each slice carries its unit's slot.
  const slot = arr.geometry.getAttribute("hbBatchSlot");
  for (const sl of arr.slices) {
    const u = arr.units.find((x) => x.buckets.includes(sl.bucket));
    for (let v = 0; v < sl.vertexCount; v++) assert.equal(slot.array[sl.vertexStart + v], u.slot);
  }
});

test("5. the build's GL stream: one storage per page, one copy per (layer, level), driver mips", async () => {
  const w = await world(true);
  w.calls.length = 0;
  step(6);
  const c = w.calls;
  const s3 = c.filter((x) => x[0] === "texStorage3D");
  assert.equal(s3.length, 2, "one albedo page (64x64 sRGB) + one normal page (64x64 linear)");
  assert.deepEqual(s3.map((x) => x[1].slice(1, 5)).sort(), [[7, w.gl.RGBA8, 64, 64], [7, w.gl.SRGB8_ALPHA8, 64, 64]].sort());
  const copies = c.filter((x) => x[0] === "copyTexSubImage3D");
  assert.equal(copies.length, 4 * 7, "2 albedo + 2 normal layers x 7 levels");
  const layers = new Set(copies.map((x) => x[1][4]));
  assert.deepEqual([...layers].sort(), [0, 1]);
  assert.equal(c.filter((x) => x[0] === "generateMipmap" && x[1][0] === w.gl.TEXTURE_2D_ARRAY).length, 0, "never re-mips an array");
  assert.equal(c.filter((x) => x[0] === "texSubImage3D" || x[0] === "texImage3D").length, 0);
  assert.ok(c.filter((x) => x[0] === "generateMipmap" && x[1][0] === w.gl.TEXTURE_2D).length >= 4, "the 2D sources' own driver mips");
  // Steady state: nothing more is admitted.
  w.calls.length = 0;
  step(3);
  assert.equal(w.calls.filter((x) => /copyTexSubImage3D|texStorage3D|compressedTexSubImage3D/.test(x[0])).length, 0);
});

test("6. the upload budget: one admit a frame -> the batch waits, legacy keeps drawing", async () => {
  const saved = globalThis.location;
  globalThis.location = { search: "?gpuBatchAdmits=1" };
  try {
    const w = await world(true);
    const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
    const seen = [];
    for (let k = 0; k < 8; k++) {
      frame(w, 1);
      seen.push(ins().status);
      if (ins().status !== "active") {
        const vis = buckets(w).filter((b) => b.name.includes(INSECTS.toString(16)) && b.visible).length;
        assert.equal(vis, 13, `frame ${k}: every insect bucket still drawn by the legacy path`);
      }
    }
    assert.deepEqual(seen.slice(0, 3), ["admitting", "admitting", "admitting"], `4 layer admits at 1 a frame: ${seen}`);
    assert.ok(seen.includes("overlap"), `the batch first draws next to the legacy buckets: ${seen}`);
    assert.equal(seen.at(-1), "active");
    assert.ok(KIT.kitBudget().stats.refused >= 3);
  } finally {
    globalThis.location = saved;
    KIT.resetKit();
  }
});

test("7. a member map swap (BC7 upgrade) tears down in the same frame and rebuilds", async () => {
  const w = await activeWorld();
  const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
  assert.equal(ins().status, "active");
  const m7c = w.mats.get(0x0800007c);
  const px = new Uint8Array(64 * 64 * 4).fill(77);
  m7c.map = surfacePixelsToTexture(px, 64, 64);
  step(1);
  assert.equal(ins().status, "pending");
  assert.equal(buckets(w).filter((b) => b.name.includes(INSECTS.toString(16)) && b.visible).length, 13, "legacy back this frame");
  assert.ok(buckets(w).filter((b) => b.name.includes(INSECTS.toString(16))).every((b) => !Object.prototype.hasOwnProperty.call(b, "raycast")), "raycast restored");
  assert.ok(buckets(w).filter((b) => b.name.includes(BUTTERFLY.toString(16))).every((b) => !b.visible), "the other setup's batch is untouched");
  assert.ok(buckets(w).filter((b) => b.name.includes(INSECTS.toString(16))).every((b) => b.instanceMatrix.updateRanges.length === 0 && b.instanceMatrix.version > 0),
    "restored buckets upload their whole attribute");
  frame(w, 5);
  assert.equal(ins().status, "active");
  const arr = ins().draws.find((d) => d.kind === "array");
  const u = arr.units.find((x) => x.member === m7c);
  assert.equal(u.map, m7c.map, "built on the new texture");
  assert.ok(AS.animatedSceneryDiag().batch.replans >= 1);
});

test("8. park / hide: no live instance -> the batch hides; shown again -> whole-attribute upload", async () => {
  const w = await activeWorld();
  const g = ASB.__animSceneryBatchGroupsForTest().find((x) => x.setupId === BUTTERFLY);
  const anchors = w.staticsGroup.children.filter((o) => o.isGroup && o.name === `anim-scenery-0x${BUTTERFLY.toString(16)}`);
  assert.equal(anchors.length, 3);
  for (const a of anchors) a.visible = false;
  frame(w, 1);
  assert.equal(g.rep.active, 0);
  assert.equal(g.draws[0].mesh.visible, false, "no live instance: the batch draw hides");
  anchors[1].visible = true;
  step(1);
  assert.equal(g.draws[0].mesh.visible, true);
  assert.equal(g.rep.mesh.instanceMatrix.updateRanges.length, 0, "the shared attribute goes up whole");
  assert.ok(buckets(w).filter((b) => b.name.includes(BUTTERFLY.toString(16))).every((b) => !b.visible), "legacy stays hidden");
});

test("9. the raycast facade hits the posed part", async () => {
  const w = await activeWorld();
  const g = ASB.__animSceneryBatchGroupsForTest().find((x) => x.setupId === BUTTERFLY);
  const d = g.draws[0];
  w.scene.updateMatrixWorld(true);
  // Aim at the centroid of instance 0's part-1 triangle, as the shader places it.
  const m = new THREE.Matrix4();
  d.mesh.getMatrixAt(0, m);
  const sl = d.slices[1];
  GPU.posedMatrixFromRow(m, sl.row, m);
  const pos = d.geometry.getAttribute("position");
  const c = new THREE.Vector3();
  for (let v = 0; v < 3; v++) c.add(new THREE.Vector3().fromBufferAttribute(pos, sl.vertexStart + v));
  c.multiplyScalar(1 / 3).applyMatrix4(m).applyMatrix4(d.mesh.matrixWorld);
  const ray = new THREE.Raycaster(c.clone().add(new THREE.Vector3(0.001, 0.002, 5)), new THREE.Vector3(-0.0002, -0.0004, -1).normalize());
  const hits = ray.intersectObjects(w.staticsGroup.children, false);
  const mine = hits.filter((h) => h.object === d.mesh);
  assert.ok(mine.length >= 1, `facade hit (${hits.length} hits total)`);
  assert.equal(mine[0].instanceId, 0);
  assert.equal(mine[0].batchPart, sl.part);
  assert.ok(hits.every((h) => !buckets(w).includes(h.object) || h.object.name.includes(GHOST.toString(16))), "muted legacy buckets report nothing");
});

test("11. the class programs are registered and compiled at the first registration (behind the loading screen)", async () => {
  const SP = await import("../scene3d/shader_prewarm.js");
  const w = await world(true);
  const keys = await ASB.__animSceneryBatchCanonicalForTest();
  assert.ok(Array.isArray(keys));
  const all = SP.batchClassPrewarmKeys().filter((k) => k.includes("|hbBatch1|") && k.includes("|aiPose|"));
  assert.equal(all.length, 8, "opaque / alphaTest x double / front x n0 / n1");
  assert.ok(all.every((k) => k.startsWith("hb|d0|c0|p0|l1|")), "with the members' default light-clamp chain key in front");
  frame(w, 6);
  const ins = ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
  const arr = ins.draws.find((d) => d.kind === "array");
  const pk = arr.classEntry.programKey;
  assert.ok(all.includes(pk), `the live array draw uses a pre-registered program: ${pk}`);
  assert.ok(SP.batchClassWarmedKeys(w.renderer).includes(pk), "and it was compiled before the draw showed");
  drawsOf(w);
  const prog = SP.programsOf(w.renderer, arr.mesh.material);
  assert.ok(prog.length >= 1 && prog.every((p) => p.cacheKey.includes(pk)), "the draw's program carries that key");
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const insectBuckets = (w) => buckets(w).filter((b) => b.name.includes(INSECTS.toString(16)));
const anchorsOf = (w, setup) => w.staticsGroup.children.filter((o) => o.isGroup && o.name === `anim-scenery-0x${setup.toString(16)}`);
const reasonDelta = (now, before) => {
  const out = {};
  for (const [k, n] of Object.entries(now)) if (n !== (before[k] || 0)) out[k] = n - (before[k] || 0);
  return out;
};

test("12. ARRAY refusals keep the member program (SAME draws), each for its reason; live handles untouched", async () => {
  const w = await world(true, { setups: REFUSALS.map((c) => c.setup) });
  const groups = ASB.__animSceneryBatchGroupsForTest();
  const by = (setup) => groups.find((g) => g.setupId === setup);
  for (const c of REFUSALS) if (c.castShadow) for (const b of by(c.setup).buckets) b.mesh.castShadow = true;
  // A live uniform handle (materials.js _defineLiveUserData: non-enumerable,
  // the member's own compile result) on the control member whose chain the
  // ARRAY class compile runs; none on the clip control's.
  const [ctl, clip] = REFUSALS;
  const SENT = { sentinel: "the member's own lightClampShaderUniforms" };
  Object.defineProperty(w.mats.get(ctl.surfaces[0]).userData, "lightClampShaderUniforms", { value: SENT, writable: true, enumerable: false, configurable: true });
  assert.equal(hasOwn(w.mats.get(clip.surfaces[0]).userData, "lightClampShaderUniforms"), false, "premise: no handle on the clip control's member");
  const before = { ...AS.animatedSceneryDiag().batch.unitReasons };
  frame(w, 8);
  for (const c of REFUSALS) {
    const g = by(c.setup);
    assert.equal(g.status, "active", `${c.name}: ${g.status} ${g.reason}`);
    assert.deepEqual(g.units.map((u) => u.mergeReason), [null, null], `${c.name}: mergeable`);
    assert.deepEqual(g.units.map((u) => u.arrayReason), [c.reason, c.reason], `${c.name}: unit array reasons`);
    if (c.key) for (const u of g.units) assert.match(ASB.memberProgramKey(u.member), c.key, `${c.name}: premise, the member carries the chain`);
    if (c.reason === null) {
      assert.deepEqual(g.draws.map((d) => [d.kind, d.units.length]), [["array", 2]], `${c.name}: one ARRAY draw`);
      continue;
    }
    assert.deepEqual(g.draws.map((d) => [d.kind, d.units.length]), [["same", 1], ["same", 1]], `${c.name}: SAME draws`);
    for (const d of g.draws) {
      assert.equal(d.classEntry, null, c.name);
      assert.equal(d.mesh.material, d.units[0].variant, `${c.name}: drawn with the member's own GPU variant`);
      assert.ok(!String(d.mesh.material.customProgramCacheKey()).includes("|hbBatch1|"), `${c.name}: no class program`);
    }
    for (const b of g.buckets) assert.equal(b.mesh.visible, false, `${c.name}: the SAME draws took the buckets`);
  }
  const want = {};
  for (const c of REFUSALS) if (c.reason) want["array:" + c.reason] = (want["array:" + c.reason] || 0) + 2;
  assert.deepEqual(reasonDelta(AS.animatedSceneryDiag().batch.unitReasons, before), want, "diag unitReasons, two units per refused setup");
  // The ARRAY class compile ran the member's chain (the light clamp's uniform
  // is in the class program's uniforms) and left the member's live handles as
  // they were: the sentinel stays, the absent one stays absent.
  for (const [c, sentinel] of [[ctl, SENT], [clip, undefined]]) {
    const arr = by(c.setup).draws[0];
    const member = arr.units[0].member;
    assert.equal(member, w.mats.get(c.surfaces[0]), "premise: the class chain is unit 0's member");
    assert.ok(w.renderer.properties.get(arr.classEntry.material).uniforms?.uLightColorClamp, `${c.name}: premise, the class compile ran the member chain`);
    const desc = Object.getOwnPropertyDescriptor(member.userData, "lightClampShaderUniforms");
    if (sentinel) assert.deepEqual([desc?.value, desc?.enumerable], [sentinel, false], `${c.name}: the member's handle survives the class compile`);
    else assert.equal(desc, undefined, `${c.name}: the class compile left no handle on the member`);
  }
  // A member that starts casting shadows later: its ARRAY draw is torn down
  // that frame and re-planned as SAME draws.
  for (const b of by(ctl.setup).buckets) b.mesh.castShadow = true;
  step(1);
  assert.equal(by(ctl.setup).status, "pending");
  assert.ok(by(ctl.setup).buckets.every((b) => b.mesh.visible), "legacy back this frame");
  frame(w, 3);
  assert.equal(by(ctl.setup).status, "active");
  assert.deepEqual(by(ctl.setup).units.map((u) => u.arrayReason), ["shadow-caster", "shadow-caster"]);
  assert.deepEqual(by(ctl.setup).draws.map((d) => d.kind), ["same", "same"]);
});

// The app has ONE renderer, on which the class programs are compiled at the
// first registration (behind the loading screen). The canonical registration
// is once per module, so a test's later renderer gets that warm here.
async function bootWarm(w) {
  await ASB.__animSceneryBatchCanonicalForTest();
  SP.prewarmBatchClasses(w.renderer, w.camera, w.scene);
}

test("13. the geometry upload gate: a refused frame merges nothing, legacy keeps drawing; built once admitted", async () => {
  const w = await world(true);
  await bootWarm(w);
  const groups = () => ASB.__animSceneryBatchGroupsForTest();
  const ins = () => groups().find((g) => g.setupId === INSECTS);
  const bf = () => groups().find((g) => g.setupId === BUTTERFLY);
  // The insect ARRAY draw's layers are already resident (another kit
  // consumer admitted them), so only the merged geometry needs the budget ...
  const pages = KIT.kitPages(w.renderer);
  for (const sid of [0x0800007a, 0x0800007c]) {
    const m = w.mats.get(sid);
    assert.ok(pages.admit(m.map, null)?.page && pages.admit(m.normalMap, null)?.page, "pre-admitted");
  }
  // ... and each frame below starts with its byte budget spent by another
  // consumer (its layer admits: they upload inside that frame; a geometry
  // spend would also be carried into the NEXT frame — upload_budget.js "THE
  // CAP HOLDS PER UPLOAD FRAME" — and leave no "frame with room" below).
  const budget = KIT.kitBudget();
  const spendFrame = () => { KIT.kitBeginFrame(_rafTs + 16.7); assert.ok(budget.trySpend(budget.bytesPerFrame, UPLOAD_KIND.LAYER)); };
  const geomId = () => new THREE.BufferGeometry().id; // three's BufferGeometry id counter
  for (let k = 0; k < 4; k++) {
    spendFrame();
    const refused = budget.stats.refused;
    const id0 = geomId();
    step(1);
    assert.equal(geomId(), id0 + 1, `frame ${k}: nothing merged or allocated while the budget refuses`);
    assert.ok(budget.stats.refused >= refused + 2, `frame ${k}: both groups asked the gate and were refused`);
    assert.deepEqual([ins().status, bf().status], ["building", "building"], `frame ${k}`);
    assert.equal(batchMeshes(w).length, 0, "nothing of the batch in the scene");
    assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "the insect buckets keep drawing");
    assert.equal(drawsOf(w).length, 17, "every legacy bucket draws");
  }
  // A frame with room: both build; the bytes charged are exactly the merged
  // geometry's (computed before allocating).
  const g0 = budget.stats.byKind.geometry;
  step(1);
  assert.ok(["warming", "overlap"].includes(ins().status) && ["warming", "overlap", "active"].includes(bf().status), `${ins().status} ${bf().status}`);
  const bytesOf = (geo) => Object.values(geo.attributes).reduce((n, a) => n + a.array.byteLength, 0) + (geo.index ? geo.index.array.byteLength : 0);
  const built = [...ins().draws, ...bf().draws].reduce((n, d) => n + bytesOf(d.geometry), 0);
  assert.equal(budget.stats.byKind.geometry - g0, built, "charged bytes == allocated merged bytes");
  for (const d of [...ins().draws, ...bf().draws]) {
    const geos = d.slices.map((sl) => sl.bucket.mesh.geometry);
    assert.equal(ASB.mergedBytesOf(geos, d.kind === "array"), bytesOf(d.geometry), "mergedBytesOf == the merge's allocation");
  }
  frame(w, 4);
  assert.equal(ins().status, "active");
  assert.equal(drawsOf(w).length, 5);
  await geometryGateBundle();
});

// Test 13 on the bundle fixture: indexed, shared-stream sources; the bytes
// charged include the (compacted) index and equal the allocation.
async function geometryGateBundle() {
  const w = await world(true, { setups: [BUNDLE], bundle: true });
  await bootWarm(w);
  const bg = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === BUNDLE);
  const pages = KIT.kitPages(w.renderer);
  for (const sid of [BA, BB]) {
    const m = w.mats.get(sid);
    assert.ok(pages.admit(m.map, null)?.page && pages.admit(m.normalMap, null)?.page, "bundle: pre-admitted");
  }
  const budget = KIT.kitBudget();
  const geomId = () => new THREE.BufferGeometry().id;
  for (let k = 0; k < 3; k++) {
    KIT.kitBeginFrame(_rafTs + 16.7);
    assert.ok(budget.trySpend(budget.bytesPerFrame, UPLOAD_KIND.LAYER)); // another consumer's layers (see test 13)
    const id0 = geomId();
    step(1);
    assert.equal(geomId(), id0 + 1, `bundle frame ${k}: nothing merged or allocated while the budget refuses`);
    assert.equal(bg().status, "building", `bundle frame ${k}`);
    assert.equal(batchMeshes(w).length, 0);
    assert.equal(drawsOf(w).length, 6, "the 6 bundle buckets keep drawing");
  }
  const g0 = budget.stats.byKind.geometry;
  step(1);
  assert.equal(bg().status, "overlap");
  const bytesOf = (geo) => Object.values(geo.attributes).reduce((n, a) => n + a.array.byteLength, 0) + (geo.index ? geo.index.array.byteLength : 0);
  const built = bg().draws.reduce((n, d) => n + bytesOf(d.geometry), 0);
  assert.ok(bg().draws.every((d) => d.geometry.index && d.geometry.index.array.byteLength > 0), "premise: indexed merges");
  assert.equal(budget.stats.byKind.geometry - g0, built, "bundle: charged bytes == allocated merged bytes (index included)");
  for (const d of bg().draws) {
    const geos = d.slices.map((sl) => sl.bucket.mesh.geometry);
    assert.equal(ASB.mergedBytesOf(geos, d.kind === "array"), bytesOf(d.geometry), "bundle: mergedBytesOf == the merge's allocation");
  }
  frame(w, 3);
  assert.equal(bg().status, "active");
  assert.equal(drawsOf(w).length, 2);
}

test("14. overlap: legacy stays until the class material has drawn (no time cap); never drawn -> legacy", async () => {
  {
    // Never rendered: the class material never draws, the legacy buckets stay.
    const w = await world(true);
    const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
    const bf = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === BUTTERFLY);
    let k = 0;
    while (ins().status !== "overlap" && k++ < 10) step(1);
    assert.equal(ins().status, "overlap");
    step(90); // past the old 60-frame cap
    assert.equal(ins().status, "overlap", "the class material never drew: still overlapping");
    assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "the legacy buckets stay on screen");
    assert.ok(ins().draws.every((d) => d.mesh.parent && d.mesh.visible), "next to the batch draws");
    assert.equal(bf().status, "active", "a SAME-only batch draws the legacy variant: nothing to wait for");
    // Hidden frames (no live instance) do not count toward giving up.
    for (const a of anchorsOf(w, INSECTS)) a.visible = false;
    step(ASB.BATCH_OVERLAP_GIVEUP_FRAMES + 20);
    assert.equal(ins().rep.active, 0);
    assert.equal(ins().status, "overlap", "hidden: waiting costs nothing and counts nothing");
    for (const a of anchorsOf(w, INSECTS)) a.visible = true;
    step(1);
    assert.equal(ins().status, "overlap", "shown again, still undrawn: overlap");
    assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13);
    w.renderer.render(w.scene, w.camera); // the class material's first draw
    step(1);
    assert.equal(ins().status, "active");
    assert.equal(insectBuckets(w).filter((b) => b.visible).length, 0);
  }
  {
    // Shown and never drawn for BATCH_OVERLAP_GIVEUP_FRAMES frames: legacy for good.
    const w = await world(true);
    const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
    const before = AS.animatedSceneryDiag().batch.legacyReasons["never-drawn"] || 0;
    step(ASB.BATCH_OVERLAP_GIVEUP_FRAMES + 12);
    assert.deepEqual([ins().status, ins().reason], ["legacy", "never-drawn"]);
    assert.equal(AS.animatedSceneryDiag().batch.legacyReasons["never-drawn"], before + 1);
    assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "legacy on screen");
    assert.ok(insectBuckets(w).every((b) => !hasOwn(b, "raycast")), "legacy raycast back");
    assert.equal(batchMeshes(w).filter((m) => m.name.includes(INSECTS.toString(16))).length, 0, "the batch draws are gone");
    step(5);
    assert.equal(ins().status, "legacy", "and it stays legacy");
    assert.equal(drawsOf(w).length, 13 + 1 + 2, "insects legacy, butterfly SAME, ghost legacy");
  }
});

test("15. context loss + restore: legacy back at once; the class programs compile again on the restored context", async () => {
  const w = await activeWorld();
  const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
  assert.equal(ins().status, "active");
  const pk = ins().draws.find((d) => d.kind === "array").classEntry.programKey;
  w.loseContext();
  step(1);
  assert.equal(ins().status, "pending", "torn down on the loss");
  assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "legacy back in that frame");
  step(3);
  assert.equal(ins().status, "pending", "nothing re-plans while the context is lost");
  const propsBefore = w.renderer.properties;
  w.restoreContext();
  assert.notEqual(w.renderer.properties, propsBefore, "premise: three re-initialised its properties / program cache");
  assert.deepEqual(SP.batchClassWarmedKeys(w.renderer), [], "nothing is warm on the restored context yet");
  let n = 0;
  while (ins().status !== "overlap" && ins().status !== "active" && n < 20) { step(1); n++; }
  assert.equal(ins().status, "overlap", `re-planned and built (${n} frames)`);
  assert.ok(n <= 6, `class programs compiled on the restored context at once, not after the ${ASB.BATCH_WARM_WAIT_FRAMES}-frame wait (${n} frames)`);
  assert.ok(SP.batchClassWarmedKeys(w.renderer).includes(pk), "the class key is warm on the restored context");
  assert.ok(w.renderer.info.programs.some((p) => p.cacheKey.includes(pk)), "its program exists on the restored context before any draw");
  assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "legacy still drawn while overlapping");
  frame(w, 2);
  assert.equal(ins().status, "active");
  assert.equal(drawsOf(w).length, 5);
});

test("16. bundle-shaped parts (indexed, one shared vertex stream): each bucket compacted to its referenced vertices, exact", async () => {
  // Through the production path: geom_bundles.js bundleToPartGroups ->
  // animated_scenery.js buckets (hbAiPose over the whole stream) -> the batch.
  const off = await world(false, { setups: [BUNDLE], bundle: true });
  step(2);
  const legacy = buckets(off);
  assert.equal(legacy.length, 6, "5 parts, part 4 with two surfaces");
  assert.ok(legacy.every((b) => b.geometry.index), "premise: indexed part groups");
  const views = new Set(legacy.map((b) => { const a = b.geometry.getAttribute("position").array; return `${a.byteOffset}:${a.length}`; }));
  assert.equal(new Set(legacy.map((b) => b.geometry.getAttribute("position").array.buffer)).size, 1, "premise: one bundle buffer");
  assert.equal(views.size, 1, "premise: every bucket's position is a view of the SAME vertex stream");
  assert.ok(legacy.every((b) => b.geometry.getAttribute("position").count === 300), "premise: the whole model's stream (5 x 60)");
  assert.equal(drawsOf(off).length, 6);
  const on = await activeWorld({ setups: [BUNDLE], bundle: true });
  const g = ASB.__animSceneryBatchGroupsForTest().find((x) => x.setupId === BUNDLE);
  assert.equal(g.status, "active");
  assert.equal(drawsOf(on).length, 2, "6 legacy draws -> 2");
  assert.deepEqual(g.draws.map((d) => [d.kind, d.units.length]), [["array", 2], ["same", 1]], "A + B in one ARRAY draw, C in a SAME draw");
  // Compacted: each slice holds exactly the vertices its source index names.
  const want = { array: 60 + 60 + 60 + 30, same: 60 + 36 };
  let merged = 0;
  for (const d of g.draws) {
    const n = d.geometry.getAttribute("position").count;
    merged += n;
    assert.equal(n, want[d.kind], `${d.kind}: merged vertices = referenced (${n})`);
    for (const sl of d.slices) {
      const src = sl.bucket.mesh.geometry;
      const used = new Set(Array.from(src.index.array));
      assert.equal(sl.vertexCount, used.size, `part ${sl.part}: ${sl.vertexCount} vertices for ${used.size} referenced`);
      assert.deepEqual(Array.from(sl.vertexMap), [...used].sort((a, b) => a - b), "source vertex order kept");
    }
    assert.ok(d.geometry.index.array instanceof Uint16Array);
    const geos = d.slices.map((sl) => sl.bucket.mesh.geometry);
    const bytes = Object.values(d.geometry.attributes).reduce((k, a) => k + a.array.byteLength, 0) + d.geometry.index.array.byteLength;
    assert.equal(ASB.mergedBytesOf(geos, d.kind === "array"), bytes, `${d.kind}: mergedBytesOf == allocated`);
  }
  assert.equal(merged, 306, "6 buckets x 300 shared vertices -> 306 merged (part 4's two surfaces share a row of 6), not 1,800");
});

test("16b. mergeGeometriesForBatch on shared streams: compaction picks the index width; out-of-range indices refused", () => {
  // A 70,000-vertex shared stream (a 32-bit index uncompacted), two groups
  // naming 1,000 vertices each, the second overlapping the first.
  const N = 70000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = i * 0.25;
  const shared = new THREE.BufferAttribute(pos, 3);
  const mk = (ids, row) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", shared);
    geo.setAttribute("hbAiPose", new THREE.BufferAttribute(new Float32Array(N).fill(row), 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ids), 1));
    return geo;
  };
  const tri = (start, step) => { const out = []; for (let k = 0; k < 999; k++) out.push(start + k * step, start + (k + 1) * step, start + ((k + 500) % 1000) * step); return out; };
  const a = mk(tri(68000, 1), 1);       // vertices 68,000..68,999
  const b = mk(tri(67600, 1), 2);         // vertices 67,600..68,599 (overlaps a)
  assert.equal(ASB.geometryMergeReason([a, b]), null);
  const m = ASB.mergeGeometriesForBatch([a, b], [3, 4]);
  const ua = new Set(a.index.array), ub = new Set(b.index.array);
  assert.equal(m.geometry.getAttribute("position").count, ua.size + ub.size, "compacted per source");
  assert.ok(m.geometry.index.array instanceof Uint16Array, "the compacted count fits 16 bits");
  assert.equal(ASB.mergedBytesOf([a, b], true), m.bytes, "mergedBytesOf == bytes");
  const allocated = Object.values(m.geometry.attributes).reduce((k, x) => k + x.array.byteLength, 0) + m.geometry.index.array.byteLength;
  assert.equal(m.bytes, allocated);
  for (const [i, src] of [[0, a], [1, b]]) {
    const sl = m.slices[i];
    for (let k = 0; k < sl.count; k++) {
      const mv = m.geometry.index.array[sl.start + k];
      const sv = src.index.array[k];
      for (let c = 0; c < 3; c++) assert.equal(m.geometry.getAttribute("position").array[mv * 3 + c], pos[sv * 3 + c]);
      assert.equal(m.geometry.getAttribute("hbAiPose").array[mv], i + 1);
      assert.equal(m.geometry.getAttribute("hbBatchSlot").array[mv], 3 + i);
    }
  }
  const bad = mk([0, 1, N], 1);
  assert.equal(ASB.geometryMergeReason([a, bad]), "index-range", "an index past the stream is refused");
});

test("17. the frame that pays for a kit geometry is the frame that uploads it", async () => {
  const CTL = REFUSALS[0].setup;
  const w = await world(true, { setups: [INSECTS, BUTTERFLY, CTL, BUNDLE], bundle: true });
  await bootWarm(w);
  const groups = ASB.__animSceneryBatchGroupsForTest();
  const by = (setup) => groups.find((g) => g.setupId === setup);
  const budget = KIT.kitBudget();
  // Every ARRAY draw here uses a canonical class program: keep it "linking"
  // (KHR_parallel_shader_compile not complete) for the first 4 frames.
  let hold = true;
  const held = w.renderer.info.programs.filter((p) => String(p.cacheKey).includes("|hbBatch1|"));
  assert.ok(held.length >= 8, `premise: the class programs were compiled ahead (${held.length})`);
  for (const p of held) p.isReady = () => !hold;
  // The butterflies are out of view (no live instance) until frame 7.
  const bfAnchors = anchorsOf(w, BUTTERFLY);
  for (const a of bfAnchors) a.visible = false;
  const kitArrays = () => {
    const set = new Set();
    for (const m of batchMeshes(w)) {
      for (const a of Object.values(m.geometry.attributes)) set.add(a.array);
      if (m.geometry.index) set.add(m.geometry.index.array);
    }
    return set;
  };
  const rows = [];
  for (let f = 0; f < 14; f++) {
    if (f === 4) hold = false;
    if (f === 7) for (const a of bfAnchors) a.visible = true;
    const g0 = budget.stats.byKind.geometry;
    step(1);
    const charged = budget.stats.byKind.geometry - g0;
    const c0 = w.calls.length;
    w.renderer.render(w.scene, w.camera);
    const arrays = kitArrays();
    let uploaded = 0;
    for (let i = c0; i < w.calls.length; i++) {
      const [n, a] = w.calls[i];
      if (n === "bufferData" && ArrayBuffer.isView(a[1]) && arrays.has(a[1])) uploaded += a[1].byteLength;
      if (n === "bufferSubData" && ArrayBuffer.isView(a[2]) && arrays.has(a[2])) uploaded += (a[4] || (a[2].length - (a[3] || 0))) * a[2].BYTES_PER_ELEMENT;
    }
    rows.push({ f, charged, uploaded, ins: by(INSECTS).status, bf: by(BUTTERFLY).status, ctl: by(CTL).status, bun: by(BUNDLE).status });
  }
  const table = JSON.stringify(rows);
  for (const r of rows) assert.equal(r.uploaded, r.charged, `frame ${r.f}: the bytes uploaded are the bytes this frame paid for — ${table}`);
  for (const r of rows.slice(0, 4)) {
    assert.equal(r.charged, 0, `frame ${r.f}: a class program still linking / no live instance: nothing charged — ${table}`);
    assert.deepEqual([r.ins, r.ctl, r.bun], ["warming", "warming", "warming"], `frame ${r.f}`);
  }
  assert.ok(rows[4].charged > 0 && ["overlap"].includes(rows[4].ins) && rows[4].ctl === "overlap" && rows[4].bun === "overlap", `frame 4: linked -> built, shown and uploaded at once — ${table}`);
  for (const r of rows.slice(0, 7)) assert.equal(r.bf, "building", `frame ${r.f}: the butterflies have no live instance: not built, not charged`);
  const bfBytes = by(BUTTERFLY).draws.reduce((k, d) => k + Object.values(d.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0), 0);
  assert.equal(rows[7].charged, bfBytes, "frame 7: the butterfly batch is charged in the frame it is first shown");
  const all = groups.filter((g) => g.status === "active");
  assert.equal(all.length, 4, table);
  const total = rows.reduce((k, r) => k + r.charged, 0);
  const allocated = all.reduce((k, g) => k + g.draws.reduce((n, d) => n + Object.values(d.geometry.attributes).reduce((x, a) => x + a.array.byteLength, 0) + (d.geometry.index ? d.geometry.index.array.byteLength : 0), 0), 0);
  assert.equal(total, allocated, "every merged byte charged once");
  assert.ok(rows.every((r) => r.uploaded <= budget.bytesPerFrame));
});

test("17b. a member that changes while its setup waits to be shown re-plans before anything is charged", async () => {
  const w = await world(true);
  await bootWarm(w);
  const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
  const budget = KIT.kitBudget();
  for (const a of anchorsOf(w, INSECTS)) a.visible = false;
  frame(w, 3);
  assert.equal(ins().status, "building", "no live instance: waits to be shown, nothing charged");
  const m7c = w.mats.get(0x0800007c);
  m7c.map = surfacePixelsToTexture(new Uint8Array(64 * 64 * 4).fill(91), 64, 64); // a BC7-style upgrade lands meanwhile
  const g0 = budget.stats.byKind.geometry;
  step(1);
  assert.equal(ins().status, "pending", "re-planned on the drift");
  assert.equal(budget.stats.byKind.geometry - g0, 0, "nothing charged for the stale plan");
  for (const a of anchorsOf(w, INSECTS)) a.visible = true;
  frame(w, 6);
  assert.equal(ins().status, "active");
  const u = ins().draws.find((d) => d.kind === "array").units.find((x) => x.member === m7c);
  assert.equal(u.map, m7c.map, "built (and first shown) on the new texture");
});

test("18. context lost AND restored with no tick between: re-planned on the new context, no lost-context texture bound, legacy until the class draw", async () => {
  for (const events of [true, false]) {
    const tag = events ? "canvas events" : "no event reaches the batch (per-tick generation check)";
    const w = await activeWorld({ contextEvents: events });
    const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
    assert.equal(ins().status, "active");
    const arr0 = ins().draws.find((d) => d.kind === "array");
    const oldPage = arr0.units[0].mapRef.page;
    const pk = arr0.classEntry.programKey;
    const d0 = AS.animatedSceneryDiag().batch;
    w.loseContext();
    // Every GL object with an id below this was made on the lost context.
    const fence = w.gl.createTexture().__id;
    w.restoreContext();
    assert.equal(w.gl.isContextLost(), false, "premise: not lost any more");
    const staleBound = (snaps) => {
      const out = [];
      for (const sn of snaps) {
        for (const [k, v] of Object.entries(sn.uniforms)) {
          for (const x of [].concat(v)) {
            const mm = /^tex#(\d+)$/.exec(String(x));
            if (mm && Number(mm[1]) < fence) out.push(`${k}=${x}`);
          }
        }
      }
      return out;
    };
    const render = (label) => {
      w.gl.__fake.startSnapshots();
      w.renderer.render(w.scene, w.camera);
      const snaps = w.gl.__fake.takeSnapshots();
      assert.deepEqual(staleBound(snaps), [], `${tag}, ${label}: no texture of the lost context is bound`);
      return snaps;
    };
    const legacyOn = () => insectBuckets(w).filter((b) => b.visible).length;
    // The app's render loop can run before this module's rAF loop in a frame.
    if (events) {
      render("render before the first tick");
      assert.equal(legacyOn(), 13, `${tag}: the legacy buckets are back before any tick`);
    }
    const seen = [];
    let n = 0;
    do {
      step(1);
      seen.push(ins().status);
      if (ins().status !== "active") assert.equal(legacyOn(), 13, `${tag}, frame ${n}: legacy drawn until the class material has drawn (${ins().status})`);
      render(`frame ${n}`);
      n++;
    } while (ins().status !== "active" && n < 20);
    assert.equal(ins().status, "active", `${tag}: ${seen}`);
    assert.ok(seen.includes("pending") || events, `${tag}: torn down at the first tick: ${seen}`);
    assert.ok(seen.includes("overlap"), `${tag}: the batch drew next to the legacy buckets first: ${seen}`);
    const d1 = AS.animatedSceneryDiag().batch;
    assert.ok(d1.contextResets > d0.contextResets && d1.teardowns > d0.teardowns, `${tag}: torn down and the pages reset`);
    const arr1 = ins().draws.find((d) => d.kind === "array");
    const page = arr1.units[0].mapRef.page;
    assert.notEqual(page, oldPage, `${tag}: a new page`);
    assert.ok(page.gl.tex.__id > fence, `${tag}: the page texture was made on the restored context`);
    assert.ok(SP.batchClassWarmedKeys(w.renderer).includes(pk), `${tag}: the class program compiled on the restored context`);
    for (let k = 0; k < 3; k++) { step(1); render(`settled ${k}`); }
    assert.equal(drawsOf(w).length, 5);
  }
});

test("18b. the kit pages reset by another consumer: every batch built on them starts over", async () => {
  const w = await activeWorld();
  const ins = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === INSECTS);
  const pages = KIT.kitPages(w.renderer);
  const gen = pages.generation;
  assert.equal(ins().status, "active");
  pages.reset(); // e.g. another kit consumer noticed a loss first
  assert.equal(pages.generation, gen + 1);
  step(1);
  assert.equal(ins().status, "pending", "torn down: its layers lived on the dropped pages");
  assert.equal(insectBuckets(w).filter((b) => b.visible).length, 13, "legacy back in that frame");
  frame(w, 6);
  assert.equal(ins().status, "active");
  assert.equal(ins().pagesGen, pages.generation, "re-planned on the new generation");
  assert.ok(ins().draws.find((d) => d.kind === "array").units.every((u) => pages.alloc.pages.includes(u.mapRef.page)), "its layers live in the current pages");
});

// Every delete* call from `from` on whose GL object was made before `fence`.
const DELETES = /^delete(Buffer|VertexArray|Texture|Framebuffer|Renderbuffer|Program|Shader|Sampler|Query|Sync|TransformFeedback)$/;
function staleDeletes(w, from, fence) {
  const out = [];
  for (let i = from; i < w.calls.length; i++) {
    const [n, a] = w.calls[i];
    if (DELETES.test(n) && a[0] && typeof a[0].__id === "number" && a[0].__id < fence) out.push(`${n}(#${a[0].__id})`);
  }
  return out;
}
function deletesIn(w, from, to, name) {
  const out = [];
  for (let i = from; i < to; i++) if (w.calls[i][0] === name && w.calls[i][1][0]) out.push(w.calls[i][1][0].__id);
  return out;
}

test("19. a context loss / restore deletes no GL object of the lost context; the restored context's objects of the torn-down batch are deleted", async () => {
  for (const mode of ["events", "no-events", "no-events, render before the tick"]) {
    const events = mode === "events";
    const w = await activeWorld({ contextEvents: events });
    const groups = () => ASB.__animSceneryBatchGroupsForTest();
    const ins = () => groups().find((g) => g.setupId === INSECTS);
    assert.equal(ins().status, "active", mode);
    const builtOn = groups().filter((g) => g.status === "active").flatMap((g) => g.draws.map((d) => d.geometry));
    assert.ok(builtOn.length >= 3, `${mode}: premise: batch geometries uploaded on the first context (${builtOn.length})`);
    // Every GL object with an id below the fence was made before the loss.
    const fence = w.gl.createTexture().__id;
    const from = w.calls.length;
    w.loseContext();
    w.restoreContext();
    const reupload = mode === "no-events, render before the tick";
    if (reupload) {
      // No event reached the batch: the app's render (before this module's
      // tick) draws it on the restored context, so its geometries now hold
      // buffers of BOTH generations.
      const c0 = w.calls.length;
      w.renderer.render(w.scene, w.camera);
      const created = w.calls.slice(c0).filter(([n]) => n === "createBuffer" || n === "createVertexArray").length;
      assert.ok(created > 0, `${mode}: premise: the batch drew (uploaded) on the restored context`);
    }
    const t0 = w.calls.length;
    step(1);
    const t1 = w.calls.length;
    assert.notEqual(ins().status, "active", `${mode}: torn down`);
    assert.deepEqual(staleDeletes(w, from, fence), [], `${mode}: no GL object of the lost context is deleted (loss, restore, teardown)`);
    if (reupload) {
      // The teardown still deletes what three made on the LIVE context.
      const wantBuffers = builtOn.reduce((k, geo) => k + Object.keys(geo.attributes).length + (geo.index ? 1 : 0), 0);
      const bufs = deletesIn(w, t0, t1, "deleteBuffer");
      const vaos = deletesIn(w, t0, t1, "deleteVertexArray");
      assert.equal(bufs.length, wantBuffers, `${mode}: every restored-context buffer of the torn-down geometries is deleted (${bufs.length} of ${wantBuffers})`);
      assert.ok(bufs.every((id) => id > fence) && vaos.every((id) => id > fence), `${mode}: only restored-context ids`);
      assert.ok(vaos.length >= builtOn.length, `${mode}: their restored-context VAOs too (${vaos.length})`);
    }
    // Re-plans and settles on the restored context; still no stale delete.
    frame(w, 8);
    assert.equal(ins().status, "active", mode);
    assert.equal(drawsOf(w).length, 5, mode);
    assert.deepEqual(staleDeletes(w, from, fence), [], `${mode}: none later either`);
    // The consumer's teardown and the kit's own resources (its pages and the
    // state-row texture, which three uploaded on BOTH contexts) released
    // after the restore: nothing of the lost context is deleted.
    const r0 = w.calls.length;
    ASB.disposeAnimSceneryBatches();
    KIT.resetKit();
    assert.deepEqual(staleDeletes(w, r0, fence), [], `${mode}: the batch teardown + resetKit after the restore delete nothing of the lost context`);
    assert.ok(deletesIn(w, r0, w.calls.length, "deleteTexture").some((id) => id > fence), `${mode}: the kit's restored-context textures are deleted`);
    // (The legacy buckets' own geometries are three's ordinary disposal in
    // animated_scenery.js — not kit resources — and stay out of this check.)
    AS.disposeAnimatedScenery();
  }
});

test("20. the cap holds per UPLOAD frame: geometry that uploads in a rAF frame leaves only the rest for that frame's layers", async () => {
  const runs = [
    { order: "render-first", pace: 1, tag: "the app: render loop first, then this module's tick" },
    { order: "render-first", pace: 2, tag: "paced: a render every 2nd rAF frame" },
    { order: "tick-first", pace: 1, tag: "flipped: tick first (a setTimeout-armed render rAF)" },
  ];
  for (const run of runs) {
    const w = await world(true, { setups: [BUTTERFLY, INSECTS] });
    await bootWarm(w);
    const groups = ASB.__animSceneryBatchGroupsForTest();
    const by = (setup) => groups.find((g) => g.setupId === setup);
    assert.deepEqual(groups.map((g) => g.setupId), [BUTTERFLY, INSECTS], "premise: the butterfly is planned first");
    const L = w.mats.get(0x0800007a).map.image.width * w.mats.get(0x0800007a).map.image.height * 4 * 4 / 3 | 0;
    const gBf = ASB.mergedBytesOf(by(BUTTERFLY).buckets.map((b) => b.mesh.geometry), false);
    // A cap one byte short of (a layer + the butterfly's geometry): either
    // fits a frame alone, both do not.
    const budget = KIT.kitBudget();
    const layerBytes = 21844; // a 64x64 RGBA8 layer, full chain
    assert.ok(Math.abs(L - layerBytes) < 8, "premise: 64x64 layers");
    budget.bytesPerFrame = layerBytes + gBf - 1;
    const cap = budget.bytesPerFrame;
    const rows = [];
    let fr = 0;
    let settled = -1;
    const kitArrays = () => {
      const m = new Map();
      for (const mesh of batchMeshes(w)) {
        const setup = /^anim-batch-(0x[0-9a-f]+)/.exec(mesh.name)[1];
        for (const a of Object.values(mesh.geometry.attributes)) m.set(a.array, setup);
        if (mesh.geometry.index) m.set(mesh.geometry.index.array, setup);
      }
      return m;
    };
    while (fr < 40) {
      const c0 = w.calls.length;
      const renders = fr % run.pace === 0;
      if (run.order === "tick-first") { step(1); if (renders) w.renderer.render(w.scene, w.camera); } else { if (renders) w.renderer.render(w.scene, w.camera); step(1); }
      const arrays = kitArrays();
      let bytes = 0;
      let layers = 0;
      const setups = new Set();
      for (let i = c0; i < w.calls.length; i++) {
        const [n, a] = w.calls[i];
        if (n === "copyTexSubImage3D") { bytes += a[7] * a[8] * 4; if (a[1] === 0) layers += 1; }
        if (n === "compressedTexSubImage3D") { bytes += a[9].byteLength; if (a[1] === 0) layers += 1; }
        if (n === "bufferData" && ArrayBuffer.isView(a[1]) && arrays.has(a[1])) { bytes += a[1].byteLength; setups.add(arrays.get(a[1])); }
        if (n === "bufferSubData" && ArrayBuffer.isView(a[2]) && arrays.has(a[2])) { bytes += (a[4] || (a[2].length - (a[3] || 0))) * a[2].BYTES_PER_ELEMENT; setups.add(arrays.get(a[2])); }
      }
      const row = { fr, bytes, uploads: layers + setups.size, ins: by(INSECTS).status, bf: by(BUTTERFLY).status };
      rows.push(row);
      // THE CHECK, per rAF frame: what reached GL in it fits the cap (or is
      // one upload alone: the oversize rule).
      assert.ok(row.bytes <= cap || row.uploads === 1, `${run.tag}: rAF frame ${fr} carried ${row.bytes} B in ${row.uploads} kit uploads (cap ${cap}) — ${JSON.stringify(rows)}`);
      fr++;
      if (settled < 0 && by(INSECTS).status === "active" && by(BUTTERFLY).status === "active") settled = fr;
      if (settled >= 0 && fr >= settled + 2 * run.pace) break;
    }
    const table = JSON.stringify(rows);
    assert.deepEqual([by(INSECTS).status, by(BUTTERFLY).status], ["active", "active"], `${run.tag}: both built — ${table}`);
    const total = rows.reduce((k, r) => k + r.bytes, 0);
    assert.ok(total >= 4 * layerBytes + gBf, `${run.tag}: premise: every layer and geometry was uploaded in the window (${total})`);
    assert.equal(budget.openTickets(), 0, `${run.tag}: every geometry ticket landed`);
    KIT.resetKit();
  }
  // A batch torn down before its first render carries nothing afterwards.
  {
    const w = await world(true, { setups: [BUTTERFLY] });
    await bootWarm(w);
    const bf = () => ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === BUTTERFLY);
    const budget = KIT.kitBudget();
    let n = 0;
    while (bf().status !== "overlap" && bf().status !== "active" && n++ < 6) step(1);
    assert.ok(["overlap", "active"].includes(bf().status));
    assert.equal(budget.openTickets(), 1, "charged, not uploaded yet (no render)");
    w.loseContext(); // torn down before any render drew it
    assert.equal(budget.openTickets(), 0, "the ticket is dropped with the batch");
    step(1);
    assert.equal(budget.carriedBytes, 0, "nothing of the dropped batch is carried into the next frame");
    w.restoreContext();
    frame(w, 6);
    assert.equal(bf().status, "active", "re-built on the restored context");
    assert.equal(budget.openTickets(), 0, "and that build's ticket landed");
  }
});

test("21. S1 timings: kit.budget per-kind milliseconds, numbers, flag on", async () => {
  const builds0 = ASB.animSceneryBatchDiag().builds; // module-wide counter (the kit budget is per world)
  const w = await activeWorld();
  const kb = AS.animatedSceneryDiag().batch.kit.budget;
  for (const k of ["ms", "maxMs", "timed"]) {
    assert.deepEqual(Object.keys(kb[k]).sort(), ["geometry", "layer", "rowGrow"], k);
    for (const [kind, v] of Object.entries(kb[k])) assert.ok(typeof v === "number" && Number.isFinite(v) && v >= 0, `${k}.${kind} = ${v}`);
  }
  for (const [ph, v] of Object.entries(kb.phaseMs)) assert.ok(typeof v === "number" && Number.isFinite(v) && v >= 0, `phaseMs.${ph} = ${v}`);
  const pages = AS.animatedSceneryDiag().batch.kit.pages;
  assert.equal(kb.timed.layer, pages.gl.admits, "every layer admit timed");
  const built = AS.animatedSceneryDiag().batch.builds - builds0;
  // Per build: the merge; per merged geometry: three's attribute upload and the first draw.
  const geos = ASB.__animSceneryBatchGroupsForTest().filter((g) => g.status === "active").reduce((k, g) => k + g.draws.length, 0);
  assert.equal(kb.timed.geometry, built + 2 * geos, `merge x ${built} builds + (upload + first draw) x ${geos} geometries`);
  assert.ok(kb.phaseMs.geometryBuild + kb.phaseMs.geometryUpload + kb.phaseMs.geometryFirstDraw <= kb.ms.geometry + 1e-9);
  assert.ok(kb.maxMs.layer <= kb.ms.layer + 1e-9 && kb.maxMs.geometry <= kb.ms.geometry + 1e-9);
  // Flag off: nothing of the kit, so no timings at all.
  const off = await world(false);
  step(3);
  assert.equal(AS.animatedSceneryDiag().batch, undefined);
  assert.equal(KIT.kitSummary().budget, null);
  void w; void off;
});

test("10. disposeAnimatedScenery removes the batch", async () => {
  const w = await activeWorld();
  assert.ok(batchMeshes(w).length === 3);
  AS.disposeAnimatedScenery();
  assert.equal(batchMeshes(w).length, 0);
  assert.equal(ASB.__animSceneryBatchGroupsForTest().length, 0);
  assert.equal(AS.animatedSceneryDiag().batch, undefined);
  ASB.__setAnimSceneryBatchEnvForTest(null);
  AS.__setAnimSceneryBatchForTest(undefined);
  KIT.resetKit();
});
