// tests/upload_warm_draw.test.mjs — `?uploadWarmDraw` (round 3 R3-2,
// 2026-10-30, DEFAULT OFF, `=on` opt-in).
//
// WebAC's play-time upload draw (scene/RendererWarmup.ts:49-57): each newly
// arrived subtree is drawn once, at arrival, into a 1x1 scissor with an unlit
// material, so its buffer uploads land on the arrival frame instead of the
// first turn that reveals it (scene3d/upload_warm_draw.js). Real three r184
// over tests/helpers/fake_webgl2.mjs, every GL call observed at the bottom of
// the context.
//
//   U1  flag reader (absent ⇒ off, `=on` ⇒ on) and the OFF install: null, no
//       listener of any type on any group, no window diag, nothing allocated.
//   U1b ON install: one `childadded` AND one `childremoved` listener per
//       group; dispose removes both.
//   U1c ?nullRender: the install returns null even with the flag on (no
//       listener, no queue, no diag).
//   U2  both unlit variant programs (vertexNormals off / on), each on its own
//       material, are compiled with the private target bound before any warm
//       draw; until both are ready a tick issues no draw.
//   U2b ASYNC LINK (KHR_parallel_shader_compile emulated: links finish in the
//       background, COMPLETION_STATUS polls, a link-status / uniform query on a
//       program still linking is a synchronous link wait), in BOTH link orders
//       (position-only variant slower, then normals variant slower): no warm
//       draw happens before BOTH variants are linked, no tick ever waits on a
//       link, and each geometry is drawn with its own variant's program.
//   U2c CONTEXT RESTORE (three's webglcontextrestored handler rebuilds its
//       properties / program cache): the next tick with work compiles both
//       variants again and draws nothing (stats.recompiles); the tick after
//       draws with the new programs and links nothing.
//   U3  the warm draw: bound to the private 1x1 target, viewport 1x1,
//       scissor test ON with box (0,0,1,1) at every warm draw; its program is
//       an unlit variant's; the subtree's own materials are never compiled;
//       the subtree's vertex + index buffers are uploaded in the tick and NOT
//       again by the next real render (moved, not duplicated).
//   U4  state restore: render target (null and a live RT), the GL
//       framebuffer / viewport / scissor box / scissor test, renderer
//       viewport / scissor / scissorTest, autoClear, sortObjects and (with
//       info.autoReset off) the info counters all equal their pre-tick values;
//       the next real render's draws see the same program, uniforms,
//       textures, framebuffer, viewport and scissor as a run without the warm.
//   U5  once per new subtree: re-adding the same root, or a second root that
//       shares a geometry, issues no second warm draw for it; a tick with
//       nothing new issues ZERO GL calls; the live scene graph is never
//       modified (children, parents, matrices, visibility).
//   U6  budget: draws per frame capped; the first proxy always goes; a large
//       subtree progresses across frames; a detached root is dropped, a hidden
//       one is parked (not dropped); the pending cap.
//   U7  wiring pins in index.js: installed with the world groups and
//       { nullRender }, ticked once per frame before vfxGaugeBeginFrame, never
//       under nullRender; the drawExec install comment states its real default.
//   U8  LATE CONTENT under an already-walked root: a prop added deep in a
//       warmed cell container, a BatchedMesh whose setGeometrySize replaced its
//       geometry, a BatchedMesh added empty and filled later — each is warmed
//       by the watch, once, before the real render (no re-upload there).
//   U9  HIDDEN: a root hidden at arrival is parked and warmed when it is shown
//       (no re-add); a root under a hidden group waits for the group; a hidden
//       part inside a walked root is warmed when shown; a root removed while
//       still hidden is released AT the removal and counts droppedHidden; a
//       released root re-queues on re-add.
//   U9f a paused arrival walk whose ROOT turns hidden is parked in the watch
//       (not dropped) and warmed once shown; its later removal is not a
//       droppedHidden (it was visible at its first walk).
//   U9g a root parked hidden at arrival, then shown and warmed, is no longer
//       "hidden only": its removal is a release, not a droppedHidden.
//   U9h the watch also runs on frames WITH arrivals that leave budget: an
//       arrival and a late prop are warmed in the same tick, and a trickle of
//       small arrivals every frame does not keep the watch from late content.
//   U10 BOUND: with 2,040 watched nodes and a 64-node rescan budget, no tick
//       reads more than 64 node `visible` flags (no whole-scene walk), ticks
//       that find nothing issue zero GL calls, one pass takes ≤ 33 frames, and
//       a late geometry anywhere in the watch is warmed within that.
//   U10b a watched root BIGGER than the rescan budget is resumed across frames,
//       not restarted or abandoned: a late geometry at its end is warmed within
//       one pass.
//   U11 a walk paused in an earlier frame re-checks its WHOLE stack before it
//       reads a child: (a) arrival walk paused inside A under P, P removed from
//       the still-attached root and every geometry disposed: nothing disposed
//       is drawn or re-registered with three (info.memory.geometries, the
//       geometry's dispose listener, bufferData), and the sibling that shifted
//       into P's slot is still warmed by the same walk; (b) the same for a
//       watch walk paused inside late content; (c) a node hidden since the
//       pause is not warmed while hidden, and is warmed by the watch once shown.
//   U12 every read of a root or a node below one is charged: with a big
//       arrival plus the watch, and with a flood of 400 hidden arrivals, no
//       tick reads more than maxNodes + rescanNodes `visible` flags; budgets are
//       clamped to UPLOAD_WARM_MIN_NODE_BUDGET; a 40-level chain under the
//       minimum budgets neither stalls the arrival nor the watch (the walk
//       stacks at most UPLOAD_WARM_MAX_WALK_DEPTH nodes, stats.depthCapped).
//   U13 EVICTION: nothing the module holds keeps an evicted subtree alive
//       (checked with WeakRefs and a forced GC: roots, meshes, geometries and
//       their attribute arrays). (a) During a burst whose arrivals spend the
//       draw budget every frame (the watch starved), a watched root, a root
//       parked hidden, a root still queued and the root mid arrival walk are
//       released AT their removal and collected within 2 saturated frames; the
//       watch still covers every remaining root afterwards. (b) A watch walk
//       paused inside late content that is removed during the burst is cut
//       on the next starved tick; (b2) one paused inside a watched ROOT that
//       is evicted is dropped at the removal itself. (c) The last warm batch
//       is not held by three's render list of the private Scene once it is
//       evicted. (d) A ring release before the cursor skips no unvisited root
//       for the pass, moved roots keep their slot index, and the listener
//       reads no node. (e) Queue releases stay O(1) and exact across the
//       queue's compaction and the squeeze of released slots (the array stays
//       bounded). (f) A root that an earlier childremoved listener moves
//       straight into another listened group stays watched. (g) A root whose
//       whole group leaves the scene (no childremoved for it) is released by
//       the watch cursor (the fallback).
//   U14 STATS KEYS: the module header's STATS list and the uploadWarmDraw row
//       of docs/url-flags.md each name exactly the keys stats() returns.
//
// Run from apps/holtburger-web/:  node tests/upload_warm_draw.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

// U13 needs a forced, full GC (WeakRef targets are kept alive until the end
// of the job that created / dereferenced them: collect() yields first).
v8.setFlagsFromString("--expose-gc");
const forceGc = vm.runInNewContext("gc");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis.window || {};
window.location = { search: "" };
globalThis.location = window.location;

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { __setRustFlagForTest } = await import("../scene3d/rust/scene_core.js");
const UWD = await import("../scene3d/upload_warm_draw.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Full GCs between jobs; true when a GC really ran. */
async function collect() {
  if (typeof forceGc !== "function") return false;
  for (let i = 0; i < 3; i++) { await sleep(0); forceGc(); }
  await sleep(0);
  return true;
}

const DRAWS = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);

/**
 * A renderer over the fake GL with a GL-state tracker and a call log.
 * `asyncLink` (U2b): KHR_parallel_shader_compile is exposed and links finish
 * in the background on a virtual clock (`advance()`), `linkTicks(isNormals)`
 * long; COMPLETION_STATUS_KHR reports it without blocking, and any link-status
 * / info-log / reflection / useProgram call on a program still linking is a
 * SYNCHRONOUS LINK WAIT (recorded in `syncWaits`, then the link completes).
 * `canvasEvents` (U2c): the canvas keeps the listeners three registers
 * (webglcontextlost / webglcontextrestored) and `fireCanvas(type)` runs them.
 */
function rig({ asyncLink = null, canvasEvents = false } = {}) {
  const st = { fb: null, viewport: null, scissor: null, scissorTest: false, program: null };
  const log = [];
  const atDraw = [];
  let gl = null;
  const raw = createFakeWebGL2({
    width: 800, height: 600,
    onCall(name, args) {
      log.push({ name, args: Array.from(args) });
      if (name === "bindFramebuffer") { if (args[0] !== gl.READ_FRAMEBUFFER) st.fb = args[1] ? args[1].__id : null; }
      else if (name === "viewport") st.viewport = Array.from(args).join(",");
      else if (name === "scissor") st.scissor = Array.from(args).join(",");
      else if (name === "enable" && args[0] === gl.SCISSOR_TEST) st.scissorTest = true;
      else if (name === "disable" && args[0] === gl.SCISSOR_TEST) st.scissorTest = false;
      else if (name === "useProgram") st.program = args[0] ? args[0].__id : null;
      else if (DRAWS.has(name)) atDraw.push({ ...st });
    },
  });
  gl = raw;
  const A = { clock: 0, doneAt: new Map(), planned: new Map(), normals: new Map(), syncWaits: [], polls: 0 };
  if (asyncLink) {
    const COMPLETION_STATUS_KHR = 0x91b1;
    const ext = { COMPLETION_STATUS_KHR, MAX_SHADER_COMPILER_THREADS_KHR: 0x91b0, maxShaderCompilerThreadsKHR() {} };
    const src = new Map();
    const shadersOf = new Map();
    const o = {};
    for (const k of ["getExtension", "shaderSource", "attachShader", "linkProgram", "getProgramParameter", "getProgramInfoLog",
      "getActiveUniform", "getUniformLocation", "getAttribLocation", "getActiveAttrib", "getUniformBlockIndex", "useProgram"]) o[k] = raw[k];
    const block = (p, call) => {
      if (p && A.doneAt.has(p) && A.clock < A.doneAt.get(p)) {
        A.syncWaits.push({ id: p.__id, call, normals: A.normals.get(p), clock: A.clock });
        A.doneAt.set(p, A.clock);
      }
    };
    raw.getExtension = function (name) { return name === "KHR_parallel_shader_compile" ? ext : o.getExtension.call(this, name); };
    raw.shaderSource = function (s, text) { src.set(s, text); return o.shaderSource.call(this, s, text); };
    raw.attachShader = function (p, s) { if (!shadersOf.has(p)) shadersOf.set(p, []); shadersOf.get(p).push(s); return o.attachShader.call(this, p, s); };
    raw.linkProgram = function (p) {
      const isN = (shadersOf.get(p) || []).some((s) => /#define HAS_NORMAL\b/.test(src.get(s) || ""));
      A.normals.set(p, isN);
      A.doneAt.set(p, A.clock + asyncLink.linkTicks(isN, p));
      A.planned.set(p, A.doneAt.get(p)); // the link's own end (a sync wait moves doneAt, not this)
      return o.linkProgram.call(this, p);
    };
    raw.getProgramParameter = function (p, pname) {
      if (pname === COMPLETION_STATUS_KHR) { A.polls++; return !A.doneAt.has(p) || A.clock >= A.doneAt.get(p); }
      block(p, "getProgramParameter");
      return o.getProgramParameter.call(this, p, pname);
    };
    for (const k of ["getProgramInfoLog", "getActiveUniform", "getUniformLocation", "getAttribLocation", "getActiveAttrib", "getUniformBlockIndex", "useProgram"]) {
      raw[k] = function (p, ...rest) { block(p, k); return o[k].call(this, p, ...rest); };
    }
  }
  const canvas = fakeCanvas(raw, 800, 600);
  const canvasListeners = new Map();
  if (canvasEvents) {
    canvas.addEventListener = (type, fn) => { if (!canvasListeners.has(type)) canvasListeners.set(type, []); canvasListeners.get(type).push(fn); };
  }
  const renderer = new THREE.WebGLRenderer({ canvas, context: raw });
  renderer.setSize(800, 600, false);
  return {
    raw, renderer, st, log, atDraw, A, advance() { A.clock += 1; },
    fireCanvas(type) { const fns = canvasListeners.get(type) || []; for (const fn of fns) fn({ preventDefault() {} }); return fns.length; },
  };
}

/** Any listener of any type on an EventDispatcher. */
const anyListener = (g) => !!g._listeners && Object.values(g._listeners).some((a) => Array.isArray(a) && a.length > 0);

function world() {
  const scene = new THREE.Scene();
  const worldRoot = new THREE.Group();
  const statics = new THREE.Group();
  const cells = new THREE.Group();
  cells.layers.set(1);
  scene.add(worldRoot);
  worldRoot.add(statics, cells);
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.layers.enable(1);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 1000);
  camera.layers.enable(1);
  camera.position.set(0, 2, 10);
  camera.updateMatrixWorld(true);
  return { scene, worldRoot, statics, cells, camera };
}

/** A streamed subtree: a Group of lit, textured meshes. */
function subtree(n, { shareWith = null, mat = null } = {}) {
  const g = new THREE.Group();
  const tex = new THREE.DataTexture(new Uint8Array([200, 100, 50, 255]), 1, 1);
  tex.needsUpdate = true;
  for (let i = 0; i < n; i++) {
    const geo = shareWith && i === 0 ? shareWith : new THREE.BoxGeometry(1 + i, 1, 1);
    const m = new THREE.Mesh(geo, mat || new THREE.MeshStandardMaterial({ map: tex }));
    m.position.set(i * 2, 0, -5);
    g.add(m);
  }
  return g;
}

function bareGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  return g;
}

function snapGraph(root) {
  const out = [];
  root.traverse((o) => out.push([o.uuid, o.parent ? o.parent.uuid : null, o.children.length, o.visible,
    o.matrixWorld.elements.join(","), o.geometry ? o.geometry.uuid : null, o.material ? o.material.uuid : null]));
  return JSON.stringify(out);
}

/** The variant materials, whatever the module calls them (one per vertexNormals variant). */
function variantMats(uwd) {
  return Array.isArray(uwd.materials) ? uwd.materials : [uwd.material];
}

/**
 * Tick (one frame apart, so a timer-driven compile can finish) until the
 * module has compiled and drawn its queued arrivals (at most `max` ticks).
 */
async function tickUntilReady(uwd, max = 6) {
  let n = 0;
  for (let i = 0; i < max; i++) {
    n = uwd.tick();
    if (n > 0 && uwd.pending === 0) break;
    await sleep(15);
  }
  return n;
}

const bufferUploads = (log) => log.filter((c) => c.name === "bufferData").length;

// ---------------------------------------------------------------------------
console.log("-- U1 flag + OFF install --------------------------------------------");
{
  const read = (s) => { window.location.search = s; __setRustFlagForTest("uploadWarmDraw", undefined);
    const on = UWD.uploadWarmDrawEnabled(); __setRustFlagForTest("uploadWarmDraw", undefined); return on; };
  check("absent ⇒ off; =on ⇒ on; =off ⇒ off", read("") === false && read("?uploadWarmDraw=on") === true &&
    read("?uploadWarmDraw=off") === false);
  window.location.search = "";
  __setRustFlagForTest("uploadWarmDraw", false);
  UWD.__resetUploadWarmDrawForTest();
  const { renderer } = rig();
  const w = world();
  const inst = UWD.installUploadWarmDraw(renderer, w.scene, [w.worldRoot, w.statics, w.cells]);
  check("off ⇒ install returns null", inst === null);
  const hasListener = [w.worldRoot, w.statics, w.cells].some((g) => g._listeners && g._listeners.childadded &&
    g._listeners.childadded.length > 0);
  check("off ⇒ no childadded listener on any group", !hasListener);
  check("off ⇒ no listener of any type (childadded, childremoved, …) on any group or the scene",
    ![w.scene, w.worldRoot, w.statics, w.cells].some(anyListener));
  check("off ⇒ no window diag", !Object.prototype.hasOwnProperty.call(window, "__uploadWarmDraw"));
  const MOD = readFileSync(path.join(APP, "scene3d", "upload_warm_draw.js"), "utf8");
  check("module reads the flag through rustFlag, default off", /rustFlag\("uploadWarmDraw", false\)/.test(MOD));
  check("no top-level THREE construction in the module", !/^(const|let|var)\s+\w+\s*=\s*new THREE\./m.test(MOD));
  __setRustFlagForTest("uploadWarmDraw", undefined);
}

// ---------------------------------------------------------------------------
console.log("-- U1c ?nullRender install ------------------------------------------");
{
  __setRustFlagForTest("uploadWarmDraw", true);
  UWD.__resetUploadWarmDrawForTest();
  delete window.__uploadWarmDraw;
  const { renderer } = rig();
  const w = world();
  const groups = [w.worldRoot, w.statics, w.cells];
  const inst = UWD.installUploadWarmDraw(renderer, w.scene, groups, { nullRender: true });
  check("flag on + nullRender ⇒ install returns null", inst === null);
  check("flag on + nullRender ⇒ no childadded listener on any group",
    !groups.some((g) => g._listeners && g._listeners.childadded && g._listeners.childadded.length > 0));
  check("flag on + nullRender ⇒ no listener of any type on any group or the scene", ![w.scene, ...groups].some(anyListener));
  check("flag on + nullRender ⇒ no window diag", !Object.prototype.hasOwnProperty.call(window, "__uploadWarmDraw"));
  // Many arrivals under nullRender: nothing is held (no instance to hold them).
  for (let i = 0; i < 50; i++) w.statics.add(new THREE.Group());
  const inst2 = UWD.installUploadWarmDraw(renderer, w.scene, groups, { nullRender: false });
  check("…and the singleton is not poisoned: a later install without nullRender installs", inst2 !== null && inst2.pending === 0);
  inst2?.dispose();
  UWD.__resetUploadWarmDrawForTest();
  __setRustFlagForTest("uploadWarmDraw", undefined);
  delete window.__uploadWarmDraw;
}

// ---------------------------------------------------------------------------
console.log("-- U2/U3 the warm draw --------------------------------------------");
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.worldRoot, w.statics, w.cells]);
  const sub = subtree(3);
  // A position-only geometry too: three keys the unlit program on vertexNormals.
  sub.add(new THREE.Mesh(bareGeometry(), new THREE.MeshLambertMaterial()));
  const realMats = [];
  sub.traverse((o) => { if (o.material) realMats.push(o.material); });
  w.statics.add(sub);
  const before = snapGraph(w.scene);
  check("arrival queued once", uwd.pending === 1 && uwd.stats.noted === 1);
  R.log.length = 0; R.atDraw.length = 0;
  const n0 = uwd.tick();
  check("U2 first tick compiles, draws nothing", n0 === 0 && R.atDraw.length === 0 && uwd.stats.compileWaitFrames === 1);
  const mats = variantMats(uwd);
  check("U2 one unlit material per vertexNormals variant (two materials)", mats.length === 2 && mats[0] !== mats[1] &&
    mats.every((m) => m && m.isMeshBasicMaterial === true), String(mats.length));
  const progOf = (m) => R.renderer.properties.get(m).currentProgram;
  const pP = mats[0] && progOf(mats[0]);
  const pN = mats[1] && progOf(mats[1]);
  check("U2 both variants compiled up front, each on its own material: position-only and position + normal",
    !!pP && !!pN && pP !== pN && R.raw.__fake.programInfo.has(pP.program) && R.raw.__fake.programInfo.has(pN.program) &&
    R.renderer.properties.get(mats[0]).programs.size === 1 && R.renderer.properties.get(mats[1]).programs.size === 1);
  const progIds = new Set([pP?.program.__id, pN?.program.__id]);
  await sleep(20);
  // Track state across the warm tick.
  const target = uwd.target;
  R.log.length = 0; R.atDraw.length = 0;
  const preFb = R.st.fb, preVp = R.st.viewport, preSc = R.st.scissor, preScT = R.st.scissorTest;
  const n1 = uwd.tick();
  const warmLog = R.log.slice();
  const warmDraws = R.atDraw.slice();
  const targetFbo = R.renderer.properties.get(target).__webglFramebuffer;
  check("U3 one warm render: 4 new geometries ⇒ 4 draws", n1 === 4 && warmDraws.length === 4, `n=${n1} draws=${warmDraws.length}`);
  check("U3 every warm draw is bound to the private 1x1 target",
    warmDraws.every((d) => d.fb === targetFbo.__id), JSON.stringify(warmDraws.map((d) => d.fb)));
  check("U3 every warm draw: viewport 0,0,1,1", warmDraws.every((d) => d.viewport === "0,0,1,1"),
    JSON.stringify(warmDraws.map((d) => d.viewport)));
  check("U3 every warm draw: scissor test ON, box 0,0,1,1",
    warmDraws.every((d) => d.scissorTest === true && d.scissor === "0,0,1,1"),
    JSON.stringify(warmDraws.map((d) => [d.scissorTest, d.scissor])));
  check("U2 the warm draw links nothing: the programs compiled up front are the ones drawn",
    !warmLog.some((c) => c.name === "linkProgram" || c.name === "compileShader" || c.name === "createProgram"));
  check("U3 every warm draw uses an unlit variant program",
    warmDraws.every((d) => progIds.has(d.program)), JSON.stringify(warmDraws.map((d) => d.program)));
  check("U3 the three boxes (normals) draw with the normal variant, the bare triangle with the position-only one",
    !!pP && !!pN && JSON.stringify(warmDraws.map((d) => d.program)) ===
      JSON.stringify([pN.program.__id, pN.program.__id, pN.program.__id, pP.program.__id]),
    JSON.stringify({ draws: warmDraws.map((d) => d.program), pP: pP?.program.__id, pN: pN?.program.__id }));
  check("U2 the warm created no further program (each variant material still has exactly one)",
    !!pP && !!pN && R.renderer.properties.get(mats[0]).programs.size === 1 && R.renderer.properties.get(mats[1]).programs.size === 1 &&
    progOf(mats[0]) === pP && progOf(mats[1]) === pN);
  check("U3 the materials are unlit (MeshBasicMaterial, no map / depth / fog)",
    mats.every((m) => m.isMeshBasicMaterial === true && m.map === null && m.depthTest === false && m.depthWrite === false && m.fog === false));
  check("U3 the subtree's own materials were never compiled",
    realMats.every((m) => R.renderer.properties.get(m).currentProgram === undefined));
  const bufData = bufferUploads(warmLog);
  check("U3 vertex + index buffers uploaded in the tick (3 boxes × (pos, normal, uv, index) + 1 position-only)", bufData === 13,
    String(bufData));
  check("U3 no texture uploaded by the warm (unlit, no map)",
    !warmLog.some((c) => c.name === "texImage2D" || c.name === "texSubImage2D" || c.name === "texStorage2D"));
  check("U4 GL framebuffer / viewport / scissor / scissor test restored",
    R.st.fb === preFb && R.st.viewport === preVp && R.st.scissor === preSc && R.st.scissorTest === preScT,
    JSON.stringify({ pre: [preFb, preVp, preSc, preScT], post: [R.st.fb, R.st.viewport, R.st.scissor, R.st.scissorTest] }));
  check("U5 the live scene graph is unchanged by the warm (children, parents, matrices, visibility, geometry, material)",
    snapGraph(w.scene) === before);
  // The next real render: no re-upload of the warmed buffers.
  R.log.length = 0; R.atDraw.length = 0;
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera);
  const realBufData = bufferUploads(R.log);
  check("U3 the real render does not re-upload the warmed buffers (moved, not duplicated)", realBufData === 0,
    String(realBufData));
  check("U3 the real render draws the subtree with its own materials (4 draws)", R.atDraw.length === 4);
  // Nothing new: zero GL calls (the watch re-walks the root and finds nothing).
  R.log.length = 0;
  const n2 = uwd.tick();
  check("U5 a tick with nothing new issues ZERO GL calls", n2 === 0 && R.log.length === 0, String(R.log.length));
  // Re-add the same root: no second warm.
  w.statics.remove(sub);
  w.statics.add(sub);
  R.log.length = 0;
  const n3 = uwd.tick();
  check("U5 re-adding a warmed root issues no warm draw", n3 === 0 && R.log.length === 0 && uwd.pending === 0);
  // A second root sharing a geometry: only its new geometry is drawn.
  const shared = sub.children[0].geometry;
  const sub2 = subtree(2, { shareWith: shared });
  w.cells.add(sub2);
  R.atDraw.length = 0;
  const n4 = uwd.tick();
  check("U5 a shared geometry is warmed once: second root draws only its new geometry", n4 === 1 && R.atDraw.length === 1,
    `n=${n4}`);
  // Adds deeper than a listened group are not arrivals (the watch finds them: U8).
  const deep = subtree(1);
  sub2.add(deep);
  check("only direct children of the listened groups queue", uwd.pending === 0);
  check("…and the watch warms the deeper add on the next tick", uwd.tick() === 1 && uwd.stats.lateDraws === 1,
    JSON.stringify(uwd.stats));
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U2b async link: no warm draw before both variants are linked ----------");
for (const slowNormals of [false, true]) {
  // One variant links in 3 frames, the other in 1: first the position-only
  // variant is the slow one, then the normals variant (a readiness test that
  // polls only one variant passes one order and fails the other). The first
  // warm proxy is position-only.
  const T = slowNormals ? "[normals variant slower] " : "[position-only variant slower] ";
  const R = rig({ asyncLink: { linkTicks: (isN) => (isN === slowNormals ? 3 : 1) } });
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(bareGeometry(), new THREE.MeshLambertMaterial()));
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
  w.statics.add(root);
  const frames = [];
  const waitsAtStart = R.A.syncWaits.length;
  for (let f = 0; f < 8; f++) {
    R.advance();
    await sleep(15); // let any timer-driven poll run between frames
    R.atDraw.length = 0;
    const w0 = R.A.syncWaits.length;
    const n = uwd.tick();
    frames.push({ clock: R.A.clock, n, draws: R.atDraw.map((d) => d.program), waits: R.A.syncWaits.slice(w0) });
  }
  const tickWaits = R.A.syncWaits.slice(waitsAtStart);
  const firstDraw = frames.find((f) => f.n > 0);
  const linkDone = [...R.A.doneAt.entries()].filter(([p]) => R.A.normals.has(p));
  check(`U2b ${T}exactly the two unlit variants were linked asynchronously (one with normals, one without)`,
    linkDone.length === 2 && new Set(linkDone.map(([p]) => R.A.normals.get(p))).size === 2,
    JSON.stringify(linkDone.map(([p, t]) => [p.__id, R.A.normals.get(p), t])));
  check(`U2b ${T}no tick ever waited on a link (no link-status / reflection / useProgram on a linking program)`,
    tickWaits.length === 0, JSON.stringify(tickWaits));
  const slowDoneAt = Math.max(...linkDone.map(([, t]) => t));
  check(`U2b ${T}the first warm draw comes only after BOTH variants finished linking`,
    !!firstDraw && firstDraw.clock >= slowDoneAt, JSON.stringify({ firstDraw, slowDoneAt, frames: frames.map((f) => [f.clock, f.n]) }));
  const plannedSlow = Math.max(...[...R.A.planned.entries()].filter(([p]) => R.A.normals.has(p)).map(([, t]) => t));
  check(`U2b ${T}…and only after the SLOW variant's own link end (clock ${plannedSlow}), not one a sync wait cut short`,
    !!firstDraw && Number.isFinite(plannedSlow) && firstDraw.clock >= plannedSlow,
    JSON.stringify({ first: firstDraw && firstDraw.clock, plannedSlow }));
  check(`U2b ${T}both geometries were warmed (2 draws, once)`, frames.reduce((s, f) => s + f.n, 0) === 2);
  const pOf = (isN) => linkDone.find(([p]) => R.A.normals.get(p) === isN)?.[0]?.__id;
  check(`U2b ${T}each geometry drew with its own variant's program (position-only, then normals)`,
    !!firstDraw && JSON.stringify(firstDraw.draws) === JSON.stringify([pOf(false), pOf(true)]),
    JSON.stringify({ draws: firstDraw && firstDraw.draws, pP: pOf(false), pN: pOf(true) }));
  check(`U2b ${T}the module counted its wait frames (compile frame + until the slow link)`,
    uwd.stats.compileWaitFrames >= 3, String(uwd.stats.compileWaitFrames));
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U2c context restore: compile again before any further draw ----------");
{
  // three's webglcontextrestored handler (initGLContext) builds new
  // properties and a new program cache: both variants lose their programs.
  const R = rig({ canvasEvents: true });
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  w.statics.add(subtree(1));
  await tickUntilReady(uwd);
  check("U2c setup: ready, the first arrival warmed", uwd._ready === true && uwd.stats.draws === 1 && uwd.stats.recompiles === 0,
    JSON.stringify(uwd.stats));
  const props0 = R.renderer.properties;
  const fired = R.fireCanvas("webglcontextlost") + R.fireCanvas("webglcontextrestored");
  check("U2c (three's lost + restored handlers ran and replaced renderer.properties)", fired === 2 && R.renderer.properties !== props0,
    String(fired));
  w.statics.add(subtree(2));
  R.log.length = 0; R.atDraw.length = 0;
  const n0 = uwd.tick();
  const links0 = R.log.filter((c) => c.name === "linkProgram").length;
  check("U2c the first tick after the restore draws nothing and compiles both variants again (stats.recompiles 1)",
    n0 === 0 && R.atDraw.length === 0 && links0 === 2 && uwd.stats.recompiles === 1,
    JSON.stringify({ n0, draws: R.atDraw.length, links0, recompiles: uwd.stats.recompiles }));
  await sleep(20);
  R.log.length = 0; R.atDraw.length = 0;
  const n1 = uwd.tick();
  const progs = new Set(variantMats(uwd).map((m) => R.renderer.properties.get(m).currentProgram?.program.__id));
  check("U2c …the next tick draws the arrival with the NEW variant programs and links / compiles nothing",
    n1 === 2 && R.atDraw.length === 2 && R.atDraw.every((d) => progs.has(d.program)) &&
      !R.log.some((c) => c.name === "linkProgram" || c.name === "compileShader"),
    JSON.stringify({ n1, draws: R.atDraw.map((d) => d.program), progs: [...progs] }));
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U4 state restore + no visual change ---------------------------------");
{
  // Two identical sessions; one warms the arrival before the frame's render.
  // The frame's draws (program, uniforms, textures, fb, viewport, scissor) must match.
  async function session(warm, { liveTarget = false, autoReset = true } = {}) {
    const R = rig();
    const w = world();
    const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.worldRoot, w.statics, w.cells]);
    R.renderer.info.autoReset = autoReset;
    const rt = liveTarget ? new THREE.WebGLRenderTarget(320, 200, { type: THREE.HalfFloatType }) : null;
    if (rt) { rt.scissor.set(10, 10, 100, 50); rt.scissorTest = true; }
    R.renderer.setScissor(5, 6, 70, 80);
    R.renderer.setScissorTest(true);
    R.renderer.setViewport(0, 0, 640, 480);
    const sharedTex = new THREE.DataTexture(new Uint8Array([10, 20, 30, 255]), 1, 1);
    sharedTex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: sharedTex });
    // Frame 0: some content already drawn.
    w.statics.add(subtree(2, { mat }));
    R.renderer.setRenderTarget(rt);
    R.renderer.render(w.scene, w.camera);
    uwd.tick(); // compile (both arms; only the warm arm ticks again below)
    await sleep(20);
    // Arrival, then the frame.
    w.cells.add(subtree(3, { mat }));
    R.renderer.setRenderTarget(rt);
    const pre = {
      target: R.renderer.getRenderTarget(), vp: R.renderer.getViewport(new THREE.Vector4()).toArray().join(","),
      sc: R.renderer.getScissor(new THREE.Vector4()).toArray().join(","), scT: R.renderer.getScissorTest(),
      autoClear: R.renderer.autoClear, sort: R.renderer.sortObjects,
      calls: R.renderer.info.render.calls, tris: R.renderer.info.render.triangles,
      gl: [R.st.fb, R.st.viewport, R.st.scissor, R.st.scissorTest].join("|"),
    };
    let warmed = 0;
    if (warm) warmed = uwd.tick();
    const post = {
      target: R.renderer.getRenderTarget(), vp: R.renderer.getViewport(new THREE.Vector4()).toArray().join(","),
      sc: R.renderer.getScissor(new THREE.Vector4()).toArray().join(","), scT: R.renderer.getScissorTest(),
      autoClear: R.renderer.autoClear, sort: R.renderer.sortObjects,
      calls: R.renderer.info.render.calls, tris: R.renderer.info.render.triangles,
      gl: [R.st.fb, R.st.viewport, R.st.scissor, R.st.scissorTest].join("|"),
    };
    R.atDraw.length = 0;
    R.raw.__fake.startSnapshots();
    R.renderer.render(w.scene, w.camera);
    const snaps = R.raw.__fake.takeSnapshots();
    const frame = snaps.map((s, i) => JSON.stringify({ s, at: { ...R.atDraw[i], program: undefined } }));
    uwd.dispose();
    return { pre, post, warmed, frame, rt };
  }
  for (const liveTarget of [false, true]) {
    for (const autoReset of [true, false]) {
      const tag = `${liveTarget ? "live RT" : "canvas"}, autoReset ${autoReset}`;
      const off = await session(false, { liveTarget, autoReset });
      const on = await session(true, { liveTarget, autoReset });
      // 2 already drawn (queued before the compile finished; their buffers are
      // already up, so the warm only draws them) + 3 new.
      check(`[${tag}] the warm ran (2 + 3 geometries)`, on.warmed === 5, String(on.warmed));
      check(`[${tag}] render target restored`, on.post.target === on.pre.target);
      check(`[${tag}] renderer viewport / scissor / scissorTest restored`,
        on.post.vp === on.pre.vp && on.post.sc === on.pre.sc && on.post.scT === on.pre.scT,
        JSON.stringify([on.pre, on.post]));
      check(`[${tag}] autoClear / sortObjects restored`, on.post.autoClear === on.pre.autoClear && on.post.sort === on.pre.sort);
      check(`[${tag}] GL framebuffer / viewport / scissor / scissor test restored`, on.post.gl === on.pre.gl,
        `${on.pre.gl} -> ${on.post.gl}`);
      if (!autoReset) {
        check(`[${tag}] info counters untouched by the warm`, on.post.calls === on.pre.calls && on.post.tris === on.pre.tris,
          JSON.stringify([on.pre.calls, on.post.calls, on.pre.tris, on.post.tris]));
      }
      check(`[${tag}] the next frame's draws are identical to a run without the warm (${off.frame.length} draws)`,
        off.frame.length === 5 && JSON.stringify(off.frame) === JSON.stringify(on.frame),
        `off=${off.frame.length} on=${on.frame.length}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("-- U6 budget + drops --------------------------------------------------");
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 2 }).attach([w.statics]);
  uwd.tick(); // nothing pending: no compile either
  check("no work ⇒ no compile started", uwd._compiling === false && uwd._ready === false);
  w.statics.add(subtree(5));
  uwd.tick();
  await sleep(20);
  const seq = [uwd.tick(), uwd.tick(), uwd.tick(), uwd.tick()];
  check("draws per frame capped at 2; a 5-geometry root progresses 2,2,1,0", JSON.stringify(seq) === "[2,2,1,0]",
    JSON.stringify(seq));
  check("deferred frames counted", uwd.stats.deferredFrames === 2, String(uwd.stats.deferredFrames));
  const big = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxBytes: 1 }).attach([w.cells]);
  w.cells.add(subtree(2));
  big.tick();
  await sleep(20);
  check("the first proxy always goes, even over the byte budget", big.tick() === 1 && big.tick() === 1);
  const gone = subtree(2);
  w.statics.add(gone);
  w.statics.remove(gone);
  const hidden = subtree(2);
  w.statics.add(hidden);
  hidden.visible = false;
  check("a removed root is dropped and a hidden one is parked, neither drawn", uwd.tick() === 0 &&
    uwd.stats.droppedDetached === 1 && uwd.stats.deferredHidden === 1 && uwd.stats.droppedHidden === 0 &&
    uwd.watched === 2, JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  hidden.visible = true;
  check("…the parked root is warmed once it is shown (no re-add)", uwd.tick() === 2 && uwd.stats.lateDraws === 2,
    JSON.stringify(uwd.stats));
  w.statics.add(gone);
  check("…and a dropped root re-queues on a later re-add", uwd.pending === 1 && uwd.tick() === 2);
  uwd.dispose();
  big.dispose();
  // The pending cap (a program that never becomes ready must not pin roots).
  const capped = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.cells]);
  const N = UWD.UPLOAD_WARM_MAX_PENDING + 3;
  const first = [];
  for (let i = 0; i < N; i++) { const g = new THREE.Group(); if (i < 3) first.push(g); w.cells.add(g); }
  check("pending is capped; the oldest are dropped (not warmed)", capped.pending === UWD.UPLOAD_WARM_MAX_PENDING &&
    capped.stats.droppedOverflow === 3, JSON.stringify({ pending: capped.pending, dropped: capped.stats.droppedOverflow }));
  w.cells.remove(first[0]);
  w.cells.add(first[0]);
  check("…a dropped root re-queues on a later re-add", capped.stats.noted === N + 1);
  capped.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U8 late content under an already-walked root ----------------------");
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.worldRoot, w.statics, w.cells]);
  // A cell container: walls first; props land later (?interiorWallsFirst).
  const cell = new THREE.Group();
  cell.add(new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), new THREE.MeshStandardMaterial()));
  w.cells.add(cell);
  await tickUntilReady(uwd);
  check("U8 the cell container was walked (walls warmed)", uwd.stats.roots === 1 && uwd.stats.draws === 1 && uwd.watched === 1,
    JSON.stringify(uwd.stats));
  const props = new THREE.Group();
  cell.add(props);
  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
  props.add(prop);
  check("U8 a prop two levels under the walked root is not an arrival", uwd.pending === 0);
  R.log.length = 0; R.atDraw.length = 0;
  const n = uwd.tick();
  const tfbo = R.renderer.properties.get(uwd.target).__webglFramebuffer.__id;
  check("U8 the watch warms the late prop on the next tick (1 draw, on the private target)",
    n === 1 && R.atDraw.length === 1 && R.atDraw[0].fb === tfbo && uwd.stats.lateDraws === 1, `n=${n}`);
  check("U8 its buffers (pos, normal, uv, index) uploaded in the tick", bufferUploads(R.log) === 4, String(bufferUploads(R.log)));
  R.log.length = 0;
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera);
  check("U8 the real render does not upload the prop again", bufferUploads(R.log) === 0, String(bufferUploads(R.log)));
  R.log.length = 0;
  check("U8 a second pass over the cell draws nothing and issues no GL call", uwd.tick() === 0 && R.log.length === 0);

  // A BatchedMesh chunk bucket: setGeometrySize replaces `geometry` (three r184 BatchedMesh).
  const bm = new THREE.BatchedMesh(8, 64, 128, new THREE.MeshStandardMaterial());
  bm.addInstance(bm.addGeometry(new THREE.BoxGeometry(1, 1, 1)));
  w.statics.add(bm);
  check("U8 a BatchedMesh root is warmed on arrival", uwd.tick() === 1);
  const g0 = bm.geometry;
  bm.setGeometrySize(256, 512);
  bm.addInstance(bm.addGeometry(new THREE.BoxGeometry(2, 1, 1)));
  check("U8 (setGeometrySize replaced the bucket's geometry)", bm.geometry !== g0);
  R.log.length = 0;
  const nb = uwd.tick();
  check("U8 the grown bucket's new geometry is warmed by the watch (1 draw, its buffers uploaded in the tick)",
    nb === 1 && bufferUploads(R.log) === 4, `n=${nb} bufferData=${bufferUploads(R.log)}`);
  // A BatchedMesh added EMPTY (no attributes yet) and filled later.
  const bmEmpty = new THREE.BatchedMesh(8, 64, 128, new THREE.MeshStandardMaterial());
  w.statics.add(bmEmpty);
  check("U8 an empty BatchedMesh arrives: nothing to draw yet", uwd.tick() === 0);
  bmEmpty.addInstance(bmEmpty.addGeometry(new THREE.BoxGeometry(1, 2, 1)));
  check("U8 …filled later: its geometry is warmed by the watch", uwd.tick() === 1);
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U9 hidden roots and hidden parts ----------------------------------");
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.worldRoot, w.statics, w.cells]);
  w.statics.add(subtree(1));
  await tickUntilReady(uwd);
  // (a) hidden at arrival, shown later without a re-add.
  const hid = subtree(2);
  hid.visible = false;
  w.statics.add(hid);
  R.log.length = 0;
  const h0 = uwd.tick();
  check("U9a a root hidden at arrival is not drawn, and is parked (not dropped)",
    h0 === 0 && R.log.length === 0 && uwd.stats.deferredHidden === 1 && uwd.stats.droppedHidden === 0 && uwd.watched === 2,
    JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  check("U9a while it stays hidden: no draw, no GL call", uwd.tick() === 0 && R.log.length === 0);
  hid.visible = true;
  R.log.length = 0;
  const h1 = uwd.tick();
  check("U9a shown (no re-add) ⇒ warmed on the next tick: 2 draws, 8 buffer uploads",
    h1 === 2 && bufferUploads(R.log) === 8, `n=${h1} bufferData=${bufferUploads(R.log)}`);
  // (b) hidden through an ancestor: the listened group itself.
  w.cells.visible = false;
  const inCells = subtree(1);
  w.cells.add(inCells);
  check("U9b a root under a hidden group is parked, not drawn", uwd.tick() === 0 && uwd.stats.deferredHidden === 2,
    JSON.stringify(uwd.stats));
  w.cells.visible = true;
  check("U9b …and warmed once the group shows", uwd.tick() === 1);
  // (c) a hidden part inside a walked root (a PVS cell, a degrade part).
  const room = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshStandardMaterial());
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial());
  lamp.visible = false;
  room.add(shell, lamp);
  w.statics.add(room);
  check("U9c a walked root warms only its visible part", uwd.tick() === 1);
  check("U9c the hidden part stays cold while hidden", uwd.tick() === 0);
  lamp.visible = true;
  check("U9c shown ⇒ warmed by the watch", uwd.tick() === 1);
  // (d) removed while still hidden: droppedHidden counts it; a re-add queues it again.
  const ghost = subtree(1);
  ghost.visible = false;
  w.statics.add(ghost);
  uwd.tick();
  // The baseline is taken BEFORE the removal: the release must happen exactly
  // once over removal + tick (at the removal, by the childremoved listener).
  const rel0 = uwd.stats.released;
  w.statics.remove(ghost);
  check("U9d the hidden root is released AT its removal, before any tick (watch slot freed, droppedHidden counted)",
    uwd.stats.released === rel0 + 1 && uwd.stats.droppedHidden === 1 && uwd.watched === 4,
    JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  uwd.tick();
  check("U9d a root that leaves the scene while hidden is released and counted in droppedHidden",
    uwd.stats.droppedHidden === 1 && uwd.stats.released === rel0 + 1 && uwd.watched === 4,
    JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  ghost.visible = true;
  w.statics.add(ghost);
  check("U9d …a re-add queues it again and warms it", uwd.pending === 1 && uwd.tick() === 1);
  // (e) the diag reports the watch.
  __setRustFlagForTest("uploadWarmDraw", true);
  UWD.__resetUploadWarmDrawForTest();
  const inst = UWD.installUploadWarmDraw(R.renderer, w.scene, [w.statics]);
  const s = window.__uploadWarmDraw?.stats?.();
  check("U9e window diag carries the watch stats (watched, deferredHidden, droppedHidden, lateDraws, rescanVisits)",
    !!s && ["watched", "deferredHidden", "droppedHidden", "lateDraws", "rescanVisits", "rescanCycles", "released", "recompiles",
      "prunedFrames", "depthCapped"].every((k) => typeof s[k] === "number"), JSON.stringify(s));
  inst?.dispose();
  UWD.__resetUploadWarmDrawForTest();
  __setRustFlagForTest("uploadWarmDraw", undefined);
  delete window.__uploadWarmDraw;
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U9f-h paused root hidden, hidden-only marker, watch on arrival frames --");
{
  // (f) The arrival walk pauses inside a root (draw budget 1); then the ROOT
  // itself is hidden. The resume finds it hidden: it is parked in the watch,
  // not dropped, and the watch warms the rest once it is shown.
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 1 }).attach([w.statics]);
  w.statics.add(subtree(1));
  await tickUntilReady(uwd);
  const root = subtree(4);
  w.statics.add(root);
  check("U9f setup: the arrival walk drew 1 of 4 and paused", uwd.tick() === 1 && uwd.pending === 1,
    JSON.stringify({ pending: uwd.pending, ...uwd.stats }));
  root.visible = false;
  const wd0 = uwd.watched;
  const dh0 = uwd.stats.deferredHidden;
  const h = uwd.tick();
  check("U9f a paused arrival walk whose ROOT turns hidden is parked in the watch (not dropped); nothing drawn",
    h === 0 && uwd.pending === 0 && uwd.stats.deferredHidden === dh0 + 1 && uwd.watched === wd0 + 1,
    JSON.stringify({ h, pending: uwd.pending, watched: uwd.watched, wd0, ...uwd.stats }));
  root.visible = true;
  const late0 = uwd.stats.lateDraws;
  let shown = 0;
  for (let i = 0; i < 8; i++) shown += uwd.tick();
  check("U9f …shown again (no re-add) ⇒ the watch warms its 3 remaining meshes", shown === 3 && uwd.stats.lateDraws === late0 + 3,
    JSON.stringify({ shown, ...uwd.stats }));
  const dhid0 = uwd.stats.droppedHidden;
  const rel0 = uwd.stats.released;
  w.statics.remove(root);
  uwd.tick();
  check("U9f …it was visible at its first walk: its removal is a release, not a droppedHidden",
    uwd.stats.droppedHidden === dhid0 && uwd.stats.released === rel0 + 1, JSON.stringify(uwd.stats));
  uwd.dispose();
}
{
  // (g) Parked hidden at arrival ("hidden only"), then shown and warmed: it
  // is no longer hidden-only, so leaving the scene later is no droppedHidden.
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  w.statics.add(subtree(1));
  await tickUntilReady(uwd);
  const hid = subtree(2);
  hid.visible = false;
  w.statics.add(hid);
  const p = uwd.tick();
  check("U9g setup: parked hidden at arrival", p === 0 && uwd.stats.deferredHidden === 1 && uwd.watched === 2, JSON.stringify(uwd.stats));
  hid.visible = true;
  check("U9g shown ⇒ warmed by the watch (2 draws)", uwd.tick() === 2);
  const dh0 = uwd.stats.droppedHidden;
  const rel0 = uwd.stats.released;
  w.statics.remove(hid);
  uwd.tick();
  check("U9g …a root shown and warmed is no longer 'hidden only': its removal is a release, not a droppedHidden",
    uwd.stats.droppedHidden === dh0 && uwd.stats.released === rel0 + 1, JSON.stringify(uwd.stats));
  uwd.dispose();
}
{
  // (h) The watch runs on every frame whose arrivals leave budget, not only
  // on frames without arrivals.
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  const cell = subtree(1);
  w.statics.add(cell);
  await tickUntilReady(uwd);
  cell.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial()));
  w.statics.add(subtree(1));
  const late0 = uwd.stats.lateDraws;
  const n = uwd.tick();
  check("U9h a frame with an arrival that leaves budget still runs the watch: the arrival AND the late prop are warmed in that tick",
    n === 2 && uwd.stats.lateDraws === late0 + 1, JSON.stringify({ n, ...uwd.stats }));
  cell.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.4), new THREE.MeshStandardMaterial()));
  let at = -1;
  for (let f = 0; f < 3 && at < 0; f++) {
    w.statics.add(subtree(1)); // a small arrival every frame
    uwd.tick();
    if (uwd.stats.lateDraws === late0 + 2) at = f;
  }
  check("U9h …a trickle of small arrivals (one per frame) does not keep the watch from late content (warmed on the first frame)",
    at === 0, `frame ${at}`);
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U10 bounded per-frame cost -----------------------------------------");
{
  const R = rig();
  const w = world();
  const RESCAN = 64;
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { rescanNodes: RESCAN }).attach([w.statics]);
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  const ROOTS = 40;
  const PER = 50; // nodes per root (the group + 49 meshes)
  const roots = [];
  for (let r = 0; r < ROOTS; r++) {
    const g = new THREE.Group();
    for (let i = 0; i < PER - 1; i++) g.add(new THREE.Mesh(shared, mat));
    w.statics.add(g);
    roots.push(g);
  }
  for (let i = 0; i < 8 && uwd.pending > 0; i++) { uwd.tick(); await sleep(15); }
  check("U10 setup: 40 roots × 50 nodes walked and watched; the shared geometry drawn once",
    uwd.pending === 0 && uwd.watched === ROOTS && uwd.stats.draws === 1, JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  // Count every read of a watched node's `visible` flag (three reads it too; only our ticks run here).
  let reads = 0;
  for (const g of roots) g.traverse((o) => {
    let v = o.visible;
    Object.defineProperty(o, "visible", { configurable: true, enumerable: true, get() { reads++; return v; }, set(x) { v = x; } });
  });
  const total = ROOTS * PER;
  const passFrames = Math.ceil((total + ROOTS) / RESCAN);
  let maxReads = 0;
  let gl = 0;
  const c0 = uwd.stats.rescanCycles;
  for (let f = 0; f < passFrames + 2; f++) {
    reads = 0;
    R.log.length = 0;
    uwd.tick();
    maxReads = Math.max(maxReads, reads);
    gl += R.log.length;
  }
  check(`U10 no tick reads more than the ${RESCAN}-node rescan budget (of ${total} watched nodes)`, maxReads > 0 && maxReads <= RESCAN,
    String(maxReads));
  check("U10 ticks that find nothing new issue zero GL calls", gl === 0, String(gl));
  check(`U10 a full pass over the watch completes within ${passFrames} frames`, uwd.stats.rescanCycles - c0 >= 1,
    JSON.stringify(uwd.stats));
  // A late geometry in the middle of the watch is warmed within one pass.
  const late = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat);
  roots[ROOTS >> 1].children[PER >> 1].add(late);
  let at = -1;
  for (let f = 0; f < passFrames + 1; f++) { if (uwd.tick() > 0) { at = f; break; } }
  check(`U10 a late geometry anywhere in the watch is warmed within one pass (≤ ${passFrames + 1} frames)`, at >= 0,
    `frame ${at}`);
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U10b a watched root larger than the rescan budget --------------------");
{
  // The watch walk of one root spans several frames: it must RESUME where it
  // stopped, not restart (or drop) the root every frame, or content past the
  // first budget's worth of nodes is never found.
  const R = rig();
  const w = world();
  const RESCAN = 64;
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { rescanNodes: RESCAN }).attach([w.statics]);
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  const BIG = 300;
  const big = new THREE.Group();
  for (let i = 0; i < BIG; i++) big.add(new THREE.Mesh(shared, mat));
  w.statics.add(big);
  const SMALL = 3;
  for (let r = 0; r < SMALL; r++) { const g = new THREE.Group(); g.add(new THREE.Mesh(shared, mat)); w.statics.add(g); }
  for (let i = 0; i < 8 && (uwd.pending > 0 || uwd.stats.draws === 0); i++) { uwd.tick(); await sleep(15); }
  check("U10b setup: a 301-node root and 3 small roots walked and watched", uwd.pending === 0 && uwd.watched === 1 + SMALL,
    JSON.stringify({ ...uwd.stats, watched: uwd.watched }));
  for (let i = 0; i < 7; i++) uwd.tick(); // the cursor anywhere in the ring
  const late = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat);
  big.children[BIG - 1].add(late); // at the END of the big root
  // One pass: every visible watched node + one examination per root, at
  // RESCAN - 1 node visits per frame (a resumed walk's root re-check costs one).
  const nodes = (BIG + 1 + 1) + SMALL * 2 + (1 + SMALL);
  const passFrames = Math.ceil(nodes / (RESCAN - 1)) + 1;
  let at = -1;
  for (let f = 0; f < 4 * passFrames; f++) { if (uwd.tick() > 0) { at = f; break; } }
  check(`U10b a late geometry at the end of a watched root bigger than the ${RESCAN}-node budget is warmed within one pass (≤ ${passFrames} frames)`,
    at >= 0 && at + 1 <= passFrames, `frame ${at}`);
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U11 a resumed walk re-checks its whole stack ----------------------");
{
  /** Geometries three has (re-)registered: WebGLGeometries.get adds a 'dispose' listener. */
  const registered = (geos) => geos.filter((g) => g._listeners && g._listeners.dispose && g._listeners.dispose.length > 0).length;
  const boxes = (parent, n, s = 1) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const g = new THREE.BoxGeometry(s + i, 1, 1);
      out.push(g);
      parent.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()));
    }
    return out;
  };

  // (a) ARRIVAL walk paused (draw budget 1) inside A, where root → P → A →
  // 5 meshes and root → sib after P. P is removed from the still-attached
  // root (A stays P's child, so only a WHOLE-stack check catches it) and
  // every geometry under it is disposed, as an unloader does.
  {
    const R = rig();
    const w = world();
    const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 1 }).attach([w.statics]);
    w.statics.add(subtree(1));
    await tickUntilReady(uwd);
    const root = new THREE.Group();
    const P = new THREE.Group();
    const A = new THREE.Group();
    const geos = boxes(A, 5);
    P.add(A);
    const sib = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial());
    root.add(P, sib);
    w.statics.add(root);
    const n1 = uwd.tick();
    check("U11a setup: the arrival walk drew A's first mesh and paused (draw budget 1)", n1 === 1 && uwd.pending === 1,
      JSON.stringify({ n1, pending: uwd.pending }));
    root.remove(P);
    for (const g of geos) g.dispose();
    const mem0 = R.renderer.info.memory.geometries;
    const late0 = uwd.stats.lateDraws;
    R.log.length = 0;
    let after = 0;
    for (let i = 0; i < 8; i++) after += uwd.tick();
    check("U11a no geometry of the removed + disposed subtree is drawn again (none re-registered with three)",
      registered(geos) === 0, `re-registered ${registered(geos)} of ${geos.length}`);
    check("U11a three's geometry count grows by the sibling only (no leaked registration)",
      R.renderer.info.memory.geometries === mem0 + 1, `${mem0} -> ${R.renderer.info.memory.geometries}`);
    check("U11a the only buffers uploaded are the sibling's 4 (no re-created buffers for disposed geometry)",
      bufferUploads(R.log) === 4 && after === 1, `bufferData=${bufferUploads(R.log)} draws=${after}`);
    check("U11a the sibling that shifted into the removed node's slot is warmed by the same arrival walk (not left to the watch)",
      uwd.stats.lateDraws === late0 && uwd.pending === 0, JSON.stringify(uwd.stats));
    check("U11a the cut is counted (stats.prunedFrames)", uwd.stats.prunedFrames === 1, String(uwd.stats.prunedFrames));
    uwd.dispose();
  }

  // (b) WATCH walk paused (draw budget 1) inside late content A under an
  // already-walked root; A is removed and its geometries disposed.
  {
    const R = rig();
    const w = world();
    const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 1 }).attach([w.statics]);
    const root = subtree(1);
    w.statics.add(root);
    await tickUntilReady(uwd);
    const A = new THREE.Group();
    const geos = boxes(A, 6, 2);
    root.add(A);
    const n1 = uwd.tick();
    check("U11b setup: the watch drew A's first late mesh and paused (draw budget 1)", n1 === 1 && uwd.stats.lateDraws === 1,
      JSON.stringify({ n1, ...uwd.stats }));
    root.remove(A);
    for (const g of geos) g.dispose();
    const mem0 = R.renderer.info.memory.geometries;
    R.log.length = 0;
    let after = 0;
    for (let i = 0; i < 8; i++) after += uwd.tick();
    check("U11b no draw, no buffer upload, no re-registration after the removal + dispose",
      after === 0 && bufferUploads(R.log) === 0 && registered(geos) === 0 && R.renderer.info.memory.geometries === mem0,
      JSON.stringify({ after, bufferData: bufferUploads(R.log), registered: registered(geos), mem0, mem: R.renderer.info.memory.geometries }));
    uwd.dispose();
  }

  // (c) HIDDEN since the pause: the arrival walk paused inside A, then A is
  // hidden. Nothing under A is warmed while it is hidden; once it is shown
  // the watch warms the rest.
  {
    const R = rig();
    const w = world();
    const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 1 }).attach([w.statics]);
    w.statics.add(subtree(1));
    await tickUntilReady(uwd);
    const root = new THREE.Group();
    const A = new THREE.Group();
    boxes(A, 5, 3);
    root.add(A);
    w.statics.add(root);
    check("U11c setup: the arrival walk paused inside A after one draw", uwd.tick() === 1 && uwd.pending === 1);
    A.visible = false;
    R.log.length = 0;
    let hiddenDraws = 0;
    for (let i = 0; i < 6; i++) hiddenDraws += uwd.tick();
    check("U11c nothing under a node hidden since the pause is warmed while it is hidden (no draw, no GL call)",
      hiddenDraws === 0 && R.log.length === 0 && uwd.pending === 0, JSON.stringify({ hiddenDraws, gl: R.log.length, pending: uwd.pending }));
    A.visible = true;
    const late0 = uwd.stats.lateDraws;
    let shown = 0;
    for (let i = 0; i < 8; i++) shown += uwd.tick();
    check("U11c shown again ⇒ the watch warms the 4 remaining meshes", shown === 4 && uwd.stats.lateDraws === late0 + 4,
      JSON.stringify({ shown, ...uwd.stats }));
    uwd.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log("-- U12 every read is charged; deep stacks cannot stall -------------------");
{
  const R = rig();
  const w = world();
  const MAXN = 100;
  const RESCAN = 50;
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxNodes: MAXN, rescanNodes: RESCAN }).attach([w.statics]);
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial();
  let reads = 0;
  const instrument = (root) => root.traverse((o) => {
    let v = o.visible;
    Object.defineProperty(o, "visible", { configurable: true, enumerable: true, get() { reads++; return v; }, set(x) { v = x; } });
  });
  const watchRoots = [];
  for (let r = 0; r < 10; r++) {
    const g = new THREE.Group();
    for (let i = 0; i < 19; i++) g.add(new THREE.Mesh(shared, mat));
    w.statics.add(g);
    watchRoots.push(g);
  }
  for (let i = 0; i < 8 && (uwd.pending > 0 || uwd.stats.draws === 0); i++) { uwd.tick(); await sleep(15); }
  check("U12 setup: a watch of 10 roots × 20 nodes", uwd.pending === 0 && uwd.watched === 10);
  for (const g of watchRoots) instrument(g);
  // (a) a big arrival two levels deep (a resumed walk re-checks a stacked node).
  const big = new THREE.Group();
  for (let a = 0; a < 30; a++) {
    const ga = new THREE.Group();
    for (let b = 0; b < 19; b++) ga.add(new THREE.Mesh(shared, mat));
    big.add(ga);
  }
  instrument(big);
  w.statics.add(big);
  const perTick = [];
  for (let f = 0; f < 12; f++) { reads = 0; uwd.tick(); perTick.push(reads); }
  check(`U12a a big arrival + the watch: no tick reads more than ${MAXN} + ${RESCAN} root-or-below visible flags`,
    Math.max(...perTick) <= MAXN + RESCAN && Math.max(...perTick) > 0, JSON.stringify(perTick));
  check("U12a …and the arrival still completes", uwd.pending === 0 && uwd.stats.roots >= 11, JSON.stringify(uwd.stats));
  // (b) a flood of hidden arrival roots: each examination is charged.
  const d0 = uwd.stats.deferredHidden;
  for (let i = 0; i < 400; i++) { const g = new THREE.Group(); g.visible = false; instrument(g); w.statics.add(g); }
  const perTickB = [];
  for (let f = 0; f < 8; f++) { reads = 0; uwd.tick(); perTickB.push(reads); }
  check(`U12b 400 hidden arrivals: no tick reads more than ${MAXN} + ${RESCAN} flags; all are parked within a few frames`,
    Math.max(...perTickB) <= MAXN + RESCAN && uwd.stats.deferredHidden === d0 + 400, JSON.stringify({ perTickB, deferredHidden: uwd.stats.deferredHidden - d0 }));
  uwd.dispose();

  // (c) DEPTH: budgets are clamped to the minimum that always leaves a resume
  // one visit of progress, the walk stacks at most UPLOAD_WARM_MAX_WALK_DEPTH
  // nodes, and a 40-level chain under the minimum budgets neither stalls the
  // arrival nor the watch.
  const R2 = rig();
  const w2 = world();
  const u2 = new UWD.UploadWarmDraw(R2.renderer, w2.scene, { maxNodes: 1, rescanNodes: 1 }).attach([w2.statics]);
  const MIN = UWD.UPLOAD_WARM_MIN_NODE_BUDGET;
  const DEPTH = UWD.UPLOAD_WARM_MAX_WALK_DEPTH;
  check("U12c node budgets are clamped to UPLOAD_WARM_MIN_NODE_BUDGET = UPLOAD_WARM_MAX_WALK_DEPTH + 1",
    Number.isInteger(MIN) && Number.isInteger(DEPTH) && MIN === DEPTH + 1 && u2.maxNodes === MIN && u2.rescanNodes === MIN,
    JSON.stringify({ MIN, DEPTH, maxNodes: u2.maxNodes, rescanNodes: u2.rescanNodes }));
  w2.statics.add(subtree(1));
  await tickUntilReady(u2);
  const chain = new THREE.Group();
  let cur = chain;
  const LEVELS = 40;
  for (let d = 0; d < LEVELS; d++) {
    cur.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1 + d * 0.01, 1), mat));
    const next = new THREE.Group();
    cur.add(next);
    cur = next;
  }
  instrument(chain);
  w2.statics.add(chain);
  let maxReads = 0;
  let f = 0;
  for (; f < 400 && u2.pending > 0; f++) { reads = 0; u2.tick(); maxReads = Math.max(maxReads, reads); }
  check(`U12c a ${LEVELS}-level chain under the minimum budgets: the arrival walk completes (no stall)`, u2.pending === 0,
    `after ${f} ticks, pending ${u2.pending}`);
  check(`U12c …warming the ${DEPTH} meshes within ${DEPTH} levels of the root, not the deeper ones (stats.depthCapped counts the cut)`,
    u2.stats.draws === 1 + DEPTH && u2.stats.depthCapped >= 1, JSON.stringify(u2.stats));
  const c0 = u2.stats.rescanCycles;
  for (let i = 0; i < 40; i++) { reads = 0; u2.tick(); maxReads = Math.max(maxReads, reads); }
  check("U12c …the watch keeps completing passes over it (no stall)", u2.stats.rescanCycles - c0 >= 2,
    String(u2.stats.rescanCycles - c0));
  check(`U12c …and no tick read more than ${MIN} + ${MIN} flags`, maxReads > 0 && maxReads <= 2 * MIN, String(maxReads));
  u2.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U13 eviction: nothing held after a root leaves ------------------------");
/** WeakRefs to every node under `root`, its geometries and their attribute / index arrays. */
function weakSubtree(root, out) {
  root.traverse((o) => {
    out.push(new WeakRef(o));
    const g = o.geometry;
    if (!g) return;
    out.push(new WeakRef(g));
    for (const k in g.attributes) { const a = g.attributes[k]; if (a && a.array) out.push(new WeakRef(a.array)); }
    if (g.index && g.index.array) out.push(new WeakRef(g.index.array));
  });
}
/** What an unloader does: remove the root from its parent, dispose its geometries. */
function evict(root) {
  root.parent.remove(root);
  root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
const aliveOf = (refs) => refs.filter((r) => r.deref() !== undefined).length;
/** Roots of `n` meshes, each with its own geometry. */
function rootMaker() {
  const mat = new THREE.MeshBasicMaterial();
  let seq = 0;
  return (n) => {
    const g = new THREE.Group();
    for (let i = 0; i < n; i++) g.add(new THREE.Mesh(new THREE.BoxGeometry(1 + (seq++) * 1e-3, 1, 1), mat));
    return g;
  };
}

// Everything that holds an evicted root runs inside a plain (synchronous)
// function below: the async test body is a suspended generator whose stale
// registers could otherwise keep the last root it touched alive. The frame's
// own render follows every tick in the client (index.js), and it rebinds
// three's vertex state; U13 renders that frame before collecting, or three's
// last-bound vertex state would still point at the last warmed geometry.

// (a) A burst whose arrivals spend the draw budget every frame (the watch is
// starved): a watched root, a root parked hidden, a root still queued and the
// root mid arrival walk are evicted.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 2 }).attach([w.statics, w.cells]);
  const mk = rootMaker();
  const W = [];
  (() => { for (let i = 0; i < 4; i++) { const g = mk(1); W.push(g); w.statics.add(g); } })();
  for (let i = 0; i < 12 && (uwd.pending > 0 || !uwd._ready); i++) { uwd.tick(); await sleep(15); }
  // Every burst frame lands a 5-geometry root; the budget is 2 draws.
  let frames = 0;
  let starved = 0;
  const burstTick = () => {
    w.statics.add(mk(5));
    const d0 = uwd.stats.deferredFrames;
    const n = uwd.tick();
    frames += 1;
    if (n === 2 && uwd.stats.deferredFrames === d0 + 1) starved += 1;
  };
  const refs = [];
  const res = (() => {
    const H = mk(2);
    H.visible = false;
    w.cells.add(H);
    uwd.tick();
    const setup = { pending: uwd.pending, watched: uwd.watched, deferredHidden: uwd.stats.deferredHidden };
    burstTick();
    burstTick();
    const Q = mk(2);
    w.cells.add(Q); // queued behind the backlog
    burstTick();
    const A = uwd._aWalk.root; // the root whose arrival walk is in progress
    const mid = { A: A !== null && A !== Q, Qqueued: uwd._queued.has(Q), pending: uwd.pending };
    const victims = [W[1], H, Q, A];
    W[1] = null;
    for (let i = 0; i < victims.length; i++) weakSubtree(victims[i], refs);
    const s0 = { ...uwd.stats };
    const watched0 = uwd.watched;
    const pending0 = uwd.pending;
    for (let i = 0; i < victims.length; i++) evict(victims[i]);
    victims.length = 0;
    const at = { watched0, watched: uwd.watched, pending0, pending: uwd.pending, walk: uwd._aWalk.root === null, s0, s: { ...uwd.stats } };
    return { setup, mid, at };
  })();
  check("U13a setup: 4 walked + watched roots and 1 parked hidden, nothing pending",
    res.setup.pending === 0 && res.setup.watched === 5 && res.setup.deferredHidden === 1, JSON.stringify(res.setup));
  check("U13a setup: every burst frame spent the draw budget; Q still queued; another root mid arrival walk",
    starved === frames && frames === 3 && res.mid.A && res.mid.Qqueued && res.mid.pending >= 3,
    JSON.stringify({ starved, frames, ...res.mid }));
  const { at } = res;
  check("U13a released AT the removal, before any tick: 2 watch slots, the queue slot and the arrival walk (stats.releasedOnRemove 4)",
    at.watched === at.watched0 - 2 && at.pending === at.pending0 - 2 && at.walk &&
      at.s.releasedOnRemove === at.s0.releasedOnRemove + 4 && at.s.released === at.s0.released + 2 &&
      at.s.droppedDetached === at.s0.droppedDetached + 2 && at.s.droppedHidden === at.s0.droppedHidden + 1,
    JSON.stringify(at));
  burstTick();
  burstTick();
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera); // the frame after the last tick
  R.log.length = 0; // the GL call log keeps the uploaded attribute arrays
  const gcRan = await collect();
  const alive = aliveOf(refs);
  check("U13a within 2 more saturated frames nothing of the 4 evicted roots is referenced (roots, meshes, geometries, attribute arrays collected)",
    gcRan && starved === frames && alive === 0, `gc ${gcRan}, starved ${starved}/${frames}, alive ${alive} of ${refs.length}`);
  // After the burst: the watch still covers every remaining root.
  for (let i = 0; i < 40 && uwd.pending > 0; i++) uwd.tick();
  const mat = new THREE.MeshBasicMaterial();
  [W[0], W[2], W[3]].forEach((g, i) => g.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2 + 0.01 * i), mat)));
  const late0 = uwd.stats.lateDraws;
  for (let i = 0; i < 20 && uwd.stats.lateDraws < late0 + 3; i++) uwd.tick();
  check("U13a after the burst the watch still covers the remaining roots (a late geometry under each is warmed)",
    uwd.pending === 0 && uwd.stats.lateDraws === late0 + 3, JSON.stringify({ pending: uwd.pending, late: uwd.stats.lateDraws - late0 }));
  uwd.dispose();
}

// (b) A watch walk paused inside late content A; the burst starves the
// watch; A is removed from its (still watched) root during the burst.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 2 }).attach([w.statics]);
  const mk = rootMaker();
  const root = mk(1);
  w.statics.add(root);
  for (let i = 0; i < 12 && (uwd.pending > 0 || !uwd._ready); i++) { uwd.tick(); await sleep(15); }
  let starved = 0;
  const burstTick = () => {
    w.statics.add(mk(5));
    const d0 = uwd.stats.deferredFrames;
    const n = uwd.tick();
    if (n === 2 && uwd.stats.deferredFrames === d0 + 1) starved += 1;
  };
  const refs = [];
  const res = (() => {
    const A = mk(5);
    root.add(A);
    const n1 = uwd.tick();
    const paused = uwd._wWalk.nodes.includes(A);
    burstTick();
    const stillPaused = uwd._wWalk.nodes.includes(A);
    weakSubtree(A, refs);
    const p0 = uwd.stats.prunedFrames;
    evict(A);
    return { n1, paused, stillPaused, p0 };
  })();
  check("U13b setup: the watch walk drew 2 of A's 5 late meshes and paused inside A", res.n1 === 2 && res.paused, JSON.stringify(res));
  check("U13b the burst starves the watch; its walk stays paused inside A", starved === 1 && res.stillPaused, JSON.stringify(res));
  burstTick();
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera);
  R.log.length = 0;
  const gcRan = await collect();
  const alive = aliveOf(refs);
  check("U13b one starved tick after A's removal nothing under A is referenced: the paused watch stack is re-checked on a starved frame too (prunedFrames)",
    gcRan && starved === 2 && alive === 0 && uwd.stats.prunedFrames === res.p0 + 1,
    `gc ${gcRan}, starved ${starved}, alive ${alive} of ${refs.length}, prunedFrames +${uwd.stats.prunedFrames - res.p0}`);
  uwd.dispose();
}

// (c) The last warm batch, then an eviction and no further warm render.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  const mk = rootMaker();
  w.statics.add(mk(1));
  await tickUntilReady(uwd);
  const refs = [];
  const n = (() => {
    const E = mk(3);
    w.statics.add(E);
    const drawn = uwd.tick();
    weakSubtree(E, refs);
    evict(E);
    return drawn;
  })();
  let quiet = 0;
  for (let i = 0; i < 4; i++) quiet += uwd.tick();
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera);
  R.log.length = 0;
  const gcRan = await collect();
  const alive = aliveOf(refs);
  check("U13c the last warm batch is not held once evicted, with no further warm render (three's render list of the private Scene is cleared)",
    gcRan && n === 3 && quiet === 0 && alive === 0, `gc ${gcRan}, n ${n}, quiet ${quiet}, alive ${alive} of ${refs.length}`);
  uwd.dispose();
}

// (d) Ring releases keep the pass and the slot indexes; the listener reads no node.
{
  const R = rig();
  const w = world();
  const RESCAN = UWD.UPLOAD_WARM_MIN_NODE_BUDGET; // 33 visits: one 32-node root per frame
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { rescanNodes: RESCAN }).attach([w.statics]);
  const shared = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const roots = [];
  for (let r = 0; r < 6; r++) {
    const g = new THREE.Group();
    for (let i = 0; i < RESCAN - 2; i++) g.add(new THREE.Mesh(shared, mat));
    w.statics.add(g);
    roots.push(g);
  }
  for (let i = 0; i < 8 && (uwd.pending > 0 || !uwd._ready); i++) { uwd.tick(); await sleep(15); }
  for (let i = 0; i < 12 && uwd._wCursor !== 3; i++) uwd.tick();
  check("U13d setup: 6 watched roots of 32 nodes (one per frame), 3 visited this pass", uwd.watched === 6 &&
    uwd._wCursor === 3 && uwd._wWalk.root === null, JSON.stringify({ watched: uwd.watched, cursor: uwd._wCursor }));
  const ring0 = uwd._watch.slice();
  const unvisited = ring0.slice(3);
  let reads = 0;
  for (const g of roots) g.traverse((o) => {
    let v = o.visible;
    Object.defineProperty(o, "visible", { configurable: true, enumerable: true, get() { reads++; return v; }, set(x) { v = x; } });
  });
  w.statics.remove(ring0[1]); // visited this pass (before the cursor)
  check("U13d a root visited this pass is released at its removal; the listener read no node", uwd.watched === 5 && reads === 0,
    JSON.stringify({ watched: uwd.watched, reads }));
  unvisited.forEach((g, i) => g.children[0].add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1 + 0.01 * i), mat)));
  const late0 = uwd.stats.lateDraws;
  let f = 0;
  for (; f < unvisited.length && uwd.stats.lateDraws < late0 + unvisited.length; f++) uwd.tick();
  check(`U13d …and no root not yet visited this pass is skipped: a late geometry under each of the ${unvisited.length} is warmed within ${unvisited.length} frames`,
    uwd.stats.lateDraws === late0 + unvisited.length, `${uwd.stats.lateDraws - late0} in ${f} frames`);
  const idxExact = () => !!uwd._wIdx && typeof uwd._wIdx.get === "function" && uwd._watch.every((r, i) => uwd._wIdx.get(r) === i);
  const before = uwd.watched;
  w.statics.remove(ring0[5]); // moved into the freed slot by the first release
  w.statics.remove(ring0[2]); // moved into the visited part by it
  check("U13d roots moved by a release keep their slot index: removing them releases them at once; every index stays exact",
    uwd.watched === before - 2 && idxExact(), JSON.stringify({ before, watched: uwd.watched, exact: idxExact() }));
  uwd.dispose();
}

// (e) Queue releases across the compaction of the spent prefix and the
// squeeze of released slots.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics]);
  const mk = rootMaker();
  w.statics.add(mk(1));
  await tickUntilReady(uwd);
  const N = 600;
  const roots = [];
  for (let i = 0; i < N; i++) { const g = mk(1); w.statics.add(g); roots.push(g); }
  const r0 = uwd.stats.roots;
  for (let i = 0; i < 10; i++) uwd.tick();
  const walked = uwd.stats.roots - r0;
  check("U13e setup: 10 ticks of 32 draws walked 320 of 600 queued roots (the spent queue prefix was compacted)",
    walked === 320 && uwd.pending === N - walked, JSON.stringify({ walked, pending: uwd.pending }));
  const gone = [];
  for (let i = walked + 1; i < N; i++) if (i % 3 === 0) gone.push(roots[i]);
  const p0 = uwd.pending;
  const dd0 = uwd.stats.droppedDetached;
  for (const g of gone) w.statics.remove(g);
  check(`U13e ${gone.length} queued roots removed after the compaction are released at once (pending and droppedDetached exact)`,
    uwd.pending === p0 - gone.length && uwd.stats.droppedDetached === dd0 + gone.length,
    JSON.stringify({ p0, pending: uwd.pending, dropped: uwd.stats.droppedDetached - dd0 }));
  for (let i = 0; i < 20 && uwd.pending > 0; i++) uwd.tick();
  const registered = (g) => !!(g._listeners && g._listeners.dispose && g._listeners.dispose.length > 0);
  check("U13e …every remaining root is still walked (FIFO intact) and no removed root's geometry is ever drawn",
    uwd.pending === 0 && uwd.stats.roots - r0 === N - gone.length && gone.every((g) => !registered(g.children[0].geometry)),
    JSON.stringify({ pending: uwd.pending, walked: uwd.stats.roots - r0, want: N - gone.length }));
  uwd.dispose();

  // The squeeze: a head that cannot move (no tick at all) and many removals behind it.
  const R2 = rig();
  const w2 = world();
  const u2 = new UWD.UploadWarmDraw(R2.renderer, w2.scene).attach([w2.statics]);
  const M = 1500;
  const q = [];
  for (let i = 0; i < M; i++) { const g = mk(1); w2.statics.add(g); q.push(g); }
  for (let i = 0; i < 1200; i++) w2.statics.remove(q[i + 100]);
  const DEAD = UWD.UPLOAD_WARM_MAX_DEAD_SLOTS;
  check(`U13e released slots are squeezed out: the queue array stays within live + UPLOAD_WARM_MAX_DEAD_SLOTS (${DEAD})`,
    Number.isInteger(DEAD) && DEAD > 0 && u2.pending === M - 1200 && u2._queue.length <= u2.pending + DEAD,
    JSON.stringify({ DEAD, pending: u2.pending, length: u2._queue.length }));
  const left = q.filter((g) => g.parent !== null);
  for (let i = 0; i < left.length; i += 4) w2.statics.remove(left[i]);
  const removed2 = Math.ceil(left.length / 4);
  check("U13e …after the squeeze every live root still has its slot: further removals are released at once",
    u2.pending === left.length - removed2, JSON.stringify({ pending: u2.pending, want: left.length - removed2 }));
  const r2 = u2.stats.roots;
  for (let i = 0; i < 40 && u2.pending > 0; i++) { u2.tick(); await sleep(5); }
  check("U13e …and the rest are all walked, in order", u2.pending === 0 && u2.stats.roots - r2 === left.length - removed2,
    JSON.stringify({ pending: u2.pending, walked: u2.stats.roots - r2 }));
  u2.dispose();
}

// (b2) The watch walk is paused inside a watched ROOT that is evicted during
// the burst: the walk on it is dropped at the removal itself.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene, { maxDraws: 2 }).attach([w.statics]);
  const mk = rootMaker();
  w.statics.add(mk(1));
  for (let i = 0; i < 12 && (uwd.pending > 0 || !uwd._ready); i++) { uwd.tick(); await sleep(15); }
  let starved = 0;
  const burstTick = () => {
    w.statics.add(mk(5));
    const d0 = uwd.stats.deferredFrames;
    const n = uwd.tick();
    if (n === 2 && uwd.stats.deferredFrames === d0 + 1) starved += 1;
  };
  const refs = [];
  const res = (() => {
    const B = mk(1);
    w.statics.add(B);
    const n0 = uwd.tick();
    B.add(mk(5)); // late content under the watched root B
    const n1 = uwd.tick();
    const paused = uwd._wWalk.root === B;
    burstTick();
    const stillPaused = uwd._wWalk.root === B;
    weakSubtree(B, refs);
    const watched0 = uwd.watched;
    evict(B);
    return { n0, n1, paused, stillPaused, walkDropped: uwd._wWalk.root === null && uwd._wWalk.nodes.length === 0,
      watched0, watched: uwd.watched };
  })();
  check("U13b2 setup: the watch walk paused inside the watched root B's late content; a burst frame starved it",
    res.n0 === 1 && res.n1 === 2 && res.paused && res.stillPaused && starved === 1, JSON.stringify({ ...res, starved }));
  check("U13b2 B's removal drops its watch slot AND the watch walk in progress on it at once (no tick)",
    res.walkDropped && res.watched === res.watched0 - 1, JSON.stringify(res));
  burstTick();
  R.renderer.setRenderTarget(null);
  R.renderer.render(w.scene, w.camera);
  R.log.length = 0;
  const gcRan = await collect();
  const alive = aliveOf(refs);
  check("U13b2 …and nothing of B is referenced after the next starved tick", gcRan && starved === 2 && alive === 0,
    `gc ${gcRan}, starved ${starved}, alive ${alive} of ${refs.length}`);
  uwd.dispose();
}

// (f) An earlier `childremoved` listener moves the removed root straight into
// another listened group: it is back in the scene when ours runs, so it stays
// covered (three already fired the new group's `childadded`, which found it
// still watched).
{
  const R = rig();
  const w = world();
  const bounce = (ev) => { if (ev.child && ev.child.userData.bounce) w.cells.add(ev.child); };
  w.statics.addEventListener("childremoved", bounce); // registered before the module's
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics, w.cells]);
  const r = subtree(1);
  r.userData.bounce = true;
  w.statics.add(r);
  await tickUntilReady(uwd);
  check("U13f setup: the root is walked and watched", uwd.watched === 1 && uwd.pending === 0);
  w.statics.remove(r);
  check("U13f a root re-parented into another listened group by an earlier childremoved listener stays watched",
    r.parent === w.cells && uwd.watched === 1 && uwd.stats.releasedOnRemove === 0, JSON.stringify({ watched: uwd.watched, ...uwd.stats }));
  r.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial()));
  check("U13f …and late content under it is still warmed by the watch", uwd.tick() === 1 && uwd.stats.lateDraws === 1);
  w.statics.removeEventListener("childremoved", bounce);
  uwd.dispose();
}

// (g) A root that leaves the scene without a `childremoved` on its group (the
// whole group detached): released when the watch cursor reaches it.
{
  const R = rig();
  const w = world();
  const uwd = new UWD.UploadWarmDraw(R.renderer, w.scene).attach([w.statics, w.cells]);
  w.cells.add(subtree(1));
  await tickUntilReady(uwd);
  const rel0 = uwd.stats.released;
  w.worldRoot.remove(w.cells);
  check("U13g setup: the cells group left the scene (no event for its child); its root is still watched", uwd.watched === 1);
  uwd.tick();
  uwd.tick();
  check("U13g …released when the watch cursor reaches it (the fallback), not drawn", uwd.watched === 0 && uwd.stats.released === rel0 + 1 &&
    uwd.stats.releasedOnRemove === 0, JSON.stringify({ watched: uwd.watched, ...uwd.stats }));
  uwd.dispose();
}

// ---------------------------------------------------------------------------
console.log("-- U14 stats keys: the diag, the module header and the url-flags row agree --");
{
  __setRustFlagForTest("uploadWarmDraw", true);
  UWD.__resetUploadWarmDrawForTest();
  delete window.__uploadWarmDraw;
  const { renderer } = rig();
  const w = world();
  const inst = UWD.installUploadWarmDraw(renderer, w.scene, [w.statics]);
  const keys = Object.keys(window.__uploadWarmDraw?.stats?.() || {});
  inst?.dispose();
  UWD.__resetUploadWarmDrawForTest();
  __setRustFlagForTest("uploadWarmDraw", undefined);
  delete window.__uploadWarmDraw;
  const missing = (want, have) => want.filter((k) => !have.includes(k));
  check("U14 stats() returns the live keys (lastDraws, releasedOnRemove, pending, watched, ready among them)",
    ["lastDraws", "releasedOnRemove", "pending", "watched", "ready"].every((k) => keys.includes(k)), JSON.stringify(keys));
  const MOD = readFileSync(path.join(APP, "scene3d", "upload_warm_draw.js"), "utf8");
  const documented = [];
  const at = MOD.indexOf("\n// STATS (");
  if (at >= 0) {
    let started = false;
    for (const line of MOD.slice(at + 1).split("\n").slice(1, 80)) {
      const m = /^\/\/ {3}([A-Za-z]\w*) /.exec(line);
      if (m) { started = true; documented.push(m[1]); } else if (started) break;
    }
  }
  check("U14a the module header's STATS list names exactly the keys stats() returns (each once)",
    keys.length > 0 && missing(keys, documented).length === 0 && missing(documented, keys).length === 0 &&
      new Set(documented).size === documented.length,
    JSON.stringify({ undocumented: missing(keys, documented), stale: missing(documented, keys) }));
  const FLAGS = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const row = FLAGS.split("\n").find((l) => l.startsWith("| `uploadWarmDraw` |")) || "";
  // The " / "-separated key list right after "stats()`: " (prose after the last key is not part of it).
  const m = /`window\.__uploadWarmDraw\.stats\(\)`: ((?:[A-Za-z]\w* \/ )*[A-Za-z]\w*)/.exec(row);
  const listed = m ? m[1].split(" / ").map((x) => x.trim()) : [];
  check("U14b docs/url-flags.md's uploadWarmDraw row lists exactly the keys stats() returns (lastDraws was missing)",
    keys.length > 0 && missing(keys, listed).length === 0 && missing(listed, keys).length === 0,
    JSON.stringify({ unlisted: missing(keys, listed), stale: missing(listed, keys) }));
}

// ---------------------------------------------------------------------------
console.log("-- U1b ON install ----------------------------------------------------");
{
  __setRustFlagForTest("uploadWarmDraw", true);
  UWD.__resetUploadWarmDrawForTest();
  const { renderer } = rig();
  const w = world();
  const inst = UWD.installUploadWarmDraw(renderer, w.scene, [w.worldRoot, w.statics, w.cells]);
  check("on ⇒ an instance listening on every group", inst !== null &&
    [w.worldRoot, w.statics, w.cells].every((g) => g._listeners && g._listeners.childadded.length === 1));
  check("on ⇒ exactly one childremoved listener on every group too (the EVICTION release)", inst !== null &&
    [w.worldRoot, w.statics, w.cells].every((g) => g._listeners && g._listeners.childremoved && g._listeners.childremoved.length === 1));
  check("on ⇒ idempotent", UWD.installUploadWarmDraw(renderer, w.scene, []) === inst);
  check("on ⇒ window diag", typeof window.__uploadWarmDraw?.stats === "function");
  inst.dispose();
  check("dispose ⇒ every listener it added is removed (both types, every group)",
    ![w.worldRoot, w.statics, w.cells].some(anyListener));
  UWD.__resetUploadWarmDrawForTest();
  __setRustFlagForTest("uploadWarmDraw", undefined);
  delete window.__uploadWarmDraw;
}

// ---------------------------------------------------------------------------
console.log("-- U7 index.js wiring -----------------------------------------------");
{
  const IDX = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
  check("imported", /import \{ installUploadWarmDraw \} from "\.\/upload_warm_draw\.js";/.test(IDX));
  check("installed in init3D with worldRoot + the five world groups and { nullRender }",
    /const _uploadWarm = installUploadWarmDraw\(renderer, scene,\s*\[worldRoot, terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup\], \{ nullRender \}\);/.test(IDX));
  const iInit = IDX.indexOf("export async function init3D(");
  const iInst = IDX.indexOf("const _uploadWarm = installUploadWarmDraw(");
  const iTickFn = IDX.indexOf("async function tick(nowTs)");
  check("install precedes the frame tick, inside init3D", iInit > 0 && iInst > iInit && iTickFn > iInst);
  const iPreNull = IDX.indexOf("\n    nullRender,\n", iInit);
  check("nullRender is in scope at the install (destructured from the pre-init bag before it)",
    iPreNull > iInit && iPreNull < iInst, `@${iPreNull}`);
  const iSync = IDX.indexOf("try { syncBatchMatVariants(); } catch (_) {");
  const iTick = IDX.indexOf("if (_uploadWarm !== null && !nullRender) {");
  const iGauge = IDX.indexOf("vfxGaugeBeginFrame(renderer);", iSync);
  const iCall = IDX.indexOf("_uploadWarm.tick()");
  check("ticked once per frame after syncBatchMatVariants and before vfxGaugeBeginFrame, never under nullRender",
    iSync > iTickFn && iTick > iSync && iCall > iTick && iGauge > iCall &&
    (IDX.match(/_uploadWarm\.tick\(\)/g) || []).length === 1);
  // The drawExec install comment (index.js preInit3D) states drawExec's real default.
  const DX = readFileSync(path.join(APP, "scene3d", "draw_exec.js"), "utf8");
  const dxDefaultOn = /rustFlag\("drawExec", true\)/.test(DX);
  const dxLine = (IDX.match(/^.*installDrawExec\(renderer, \(\) => scene\);.*$/m) || [""])[0];
  check("the installDrawExec comment matches draw_exec.js's default (ON since 2026-10-26), not 'default off'",
    dxDefaultOn && dxLine !== "" && !/default off/i.test(dxLine) && /DEFAULT ON since 2026-10-26/.test(dxLine), dxLine.trim());
}

console.log(`\nupload_warm_draw: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
