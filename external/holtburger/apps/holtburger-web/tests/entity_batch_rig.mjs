// tests/entity_batch_rig.mjs — the shared world for the `?entityBatch` node
// suites (tests/entity_batch_*.test.mjs; R3-4 stage A,
// scene3d/gpu_batch/entity_batch.js). Not a test itself.
//
// A REAL EntityManager (scene3d/entities.js) spawning 17-part rigs through
// its real `_spawnImpl` (AnimationCache, setup_rig.js leaves, the real
// paletted / cache material ladders: MaterialCache._materialFromFlags over
// adapter.js textures, entities.js _applyPalettedSurfaceRenderState +
// MaterialCache.installPaletted), posed by the real unified motion path
// (harness/lib/fake_motion_sequence.mjs stands in for the wasm class) and
// drawn by three r184's real WebGLRenderer against the recording fake WebGL2
// (tests/helpers/fake_webgl2.mjs). `window.liveScene3d` carries the renderer,
// camera, scene and the rAF frame time, exactly the fields the batch reads in
// the app.
//
// Import this module FIRST (it sets up `window` before entities.js loads).

import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame ??= () => 1;
globalThis.window.cancelAnimationFrame ??= () => {};

export const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
// Optional so the flag-off identity capture also runs on the PRE-change tree
// (no entity_batch.js there); every batch suite asserts it is present.
export const EB = await import("../scene3d/gpu_batch/entity_batch.js").catch(() => null);
export const KIT = await import("../scene3d/gpu_batch/kit.js");
export const M = await import("../scene3d/materials.js");
export const ADAPTER = await import("../scene3d/adapter.js");
const ENT = await import("../scene3d/entities.js");
export const EntityManager = ENT.EntityManager;
export const LIB = await import("../harness/glsl_smoke/entity_batch_lib.mjs");
const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
installFakeMotionSequence();

export const { READY, WALK, SETUP, D, SURF, HUMAN_PARTS, MIXED_PARTS, pixelsFor } = LIB;
export const wasmFor = (parts = HUMAN_PARTS) => LIB.wasmFor(THREE, parts);
export const materialCacheFor = (opts) => LIB.materialCacheFor(M, ADAPTER, opts);
export const spawnMeta = LIB.spawnMeta;

/**
 * The world: `batch` = `?entityBatch` for the EntityManager built here.
 * Returns helpers: spawn, frame (tick + render), draws (one rendered frame's
 * draw snapshots), etc.
 */
export async function world(batch, opts = {}) {
  KIT.resetKit();
  if (EB) EB.__setEntityBatchForTest(batch);
  else if (batch) throw new Error("scene3d/gpu_batch/entity_batch.js is missing");
  const gl = createFakeWebGL2({ onCall: opts.onCall });
  const canvas = fakeCanvas(gl);
  const listeners = {};
  canvas.addEventListener = (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); };
  canvas.removeEventListener = (type, fn) => { const l = listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  let lost = false;
  gl.isContextLost = () => lost;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  worldRoot.name = "worldRoot";
  worldRoot.rotation.x = -Math.PI / 2;
  scene.add(worldRoot);
  const entitiesGroup = new THREE.Group();
  entitiesGroup.name = "entities";
  worldRoot.add(entitiesGroup);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  camera.layers.enable(1); // the entities' render layer (RENDER_LAYER_INDOOR); `aim` points it
  camera.updateMatrixWorld();
  let ts = 1000;
  globalThis.window.liveScene3d = { renderer, camera, scene, frameTime: { tsMs: ts, tsSec: ts / 1000, dt: 0 } };
  const mc = opts.materialCache || materialCacheFor();
  const wasm = wasmFor(opts.parts || HUMAN_PARTS);
  const scene3d = { entitiesGroup, materialCache: mc, ...(opts.scene3d || {}) };
  const em = new EntityManager(scene3d, wasm);
  em._tweenClockMs = 1000;
  const w = {
    gl, renderer, scene, camera, entitiesGroup, em, mc, wasm, listeners, worldRoot,
    get ts() { return ts; },
    async spawn(guid, x = 10, y = 10, z = 0, o = {}) {
      const inst = await em.spawn(spawnMeta(guid, x, y, z, o));
      assert.ok(inst, "spawned");
      if (!w._aimed) { w._aimed = true; w.aim(inst); }
      return inst;
    },
    /** Point the camera at a rig root (4 m off, slightly above). */
    aim(inst, dist = 4) {
      scene.updateMatrixWorld();
      const p = new THREE.Vector3();
      inst.root.getWorldPosition(p);
      camera.position.set(p.x + 1, p.y + 1.2, p.z + dist);
      camera.lookAt(p.x + 1, p.y + 0.6, p.z);
      camera.updateMatrixWorld();
    },
    /** One app frame: rAF timestamp, entities tick (+ batch sync), render. */
    frame(n = 1, dt = 1 / 60, render = true) {
      for (let i = 0; i < n; i += 1) {
        ts += 16.7;
        globalThis.window.liveScene3d.frameTime = { tsMs: ts, tsSec: ts / 1000, dt };
        em.tick(dt);
        if (render) renderer.render(scene, camera);
      }
    },
    tickOnly(dt = 1 / 60) {
      ts += 16.7;
      globalThis.window.liveScene3d.frameTime = { tsMs: ts, tsSec: ts / 1000, dt };
      em.tick(dt);
    },
    /** The draw snapshots of one render (no tick). */
    drawsOf() {
      gl.__fake.startSnapshots();
      renderer.render(scene, camera);
      return gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind));
    },
    /** Run frames until every rig is active (or `max` frames). */
    settle(max = 40) {
      for (let i = 0; i < max; i += 1) {
        w.frame();
        const st = em._entityBatch ? em._entityBatch.stats().byStatus : {};
        const busy = Object.keys(st).some((k) => k !== "active" && k !== "legacy");
        if (!busy) return i + 1;
      }
      return max;
    },
    loseContext() { lost = true; for (const fn of [...(listeners.webglcontextlost || [])]) fn({ preventDefault() {} }); },
    restoreContext() { lost = false; for (const fn of [...(listeners.webglcontextrestored || [])]) fn({}); },
  };
  return w;
}

/** Every leaf (per-surface Mesh) of a rig, (part, children) order. */
export function leavesOf(inst) {
  const out = [];
  for (const p of inst.parts) for (const c of p.children) if (c.isMesh && c.userData && c.userData.surfaceDid !== undefined) out.push(c);
  return out;
}

/** Scene-graph fingerprint: names, node count, layer masks, visibility, materials (flag-off identity). */
export function graphFingerprint(root) {
  const rows = [];
  root.traverse((o) => {
    rows.push([o.type, o.name, o.layers.mask, o.visible, o.isMesh ? (Array.isArray(o.material) ? "arr" : o.material?.uuid ? o.material.type + ":" + (o.material.name || "") : "-") : "-", o.children.length].join("|"));
  });
  return rows;
}

/** FNV-1a 32 of a string, hex. */
export function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function _snapJson(snaps) {
  return JSON.stringify(snaps, (k, v) => {
    if (v && typeof v === "object" && v.__kind !== undefined) return `${v.__kind}#${v.__id}`;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    return v;
  });
}

/**
 * The flag-OFF fingerprint of a fixed scenario (shipped suite + the scratch
 * capture on the pre-change tree run this SAME function): two rigs (one plain,
 * one recolored), 24 frames of walking, a TransparentPart 0 -> 0 and 1 -> 1
 * ramp, a camera fade and back, then 6 more frames. Per phase: the whole
 * scene graph (types, names, layer masks, visibility, material kind / name,
 * child counts), every draw's program + uniform snapshot, the GL call counts
 * of the render, and the program cache keys.
 */
export async function flagOffFingerprint() {
  const w = await world(false);
  const a = await w.spawn(0x50000101, 10, 10, 0);
  const b = await w.spawn(0x50000102, 11, 10, 0, { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) });
  const phases = [];
  const capture = (tag) => {
    w.gl.__fake.reset();
    w.gl.__fake.startSnapshots();
    w.renderer.render(w.scene, w.camera);
    const snaps = w.gl.__fake.takeSnapshots();
    const counts = { ...w.gl.__fake.counts };
    const graph = graphFingerprint(w.scene);
    phases.push({
      tag, draws: snaps.filter((s) => /^draw/.test(s.kind)).length,
      graph: hashStr(graph.join("\n")), nodes: graph.length,
      snaps: hashStr(_snapJson(snaps)), counts: hashStr(JSON.stringify(Object.keys(counts).sort().map((k) => [k, counts[k]]))),
    });
  };
  w.frame(24);
  capture("walk");
  w.em._spawnMaterialRampTween(a, 7, -1, { rampStart: 0, rampEnd: 0, rampTime: 0.5 });
  w.em._spawnMaterialRampTween(b, 7, 3, { rampStart: 1, rampEnd: 1, rampTime: 0.25 });
  w.frame(4);
  capture("ramps");
  w.em._applyCamFadeToInst(a, 0.5);
  w.frame(2);
  capture("camFade");
  w.em._applyCamFadeToInst(a, 1);
  w.frame(6);
  capture("back");
  const programs = (w.renderer.info.programs || []).map((p) => p.cacheKey).sort();
  return {
    phases, programs: hashStr(programs.join("\n")), programCount: programs.length,
    diagGlobal: typeof globalThis.window.__entityBatch, kitBudget: KIT.kitSummary().budget === null ? "null" : "set",
    batchProp: w.em._entityBatch === undefined ? "undefined" : String(w.em._entityBatch),
  };
}

/** The suites' runner: `check(name, fn)` (async ok), `done()` exits 0 / 1 (entities.js arms 30 s timers). */
export function suite(title) {
  let passed = 0, failed = 0;
  const check = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  [PASS] ${name}`); }
    catch (e) { failed += 1; console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`); }
  };
  const done = () => { console.log(`\n${title}: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); };
  return { check, done, get failed() { return failed; } };
}

/** The batch module must be present in a batch suite (the pre-change tree has none). */
export function requireBatch() {
  if (!EB) { console.log("  [FAIL] scene3d/gpu_batch/entity_batch.js is missing"); process.exit(1); }
}

