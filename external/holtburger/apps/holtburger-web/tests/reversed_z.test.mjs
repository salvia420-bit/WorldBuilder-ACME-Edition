// tests/reversed_z.test.mjs
//
// `?reversedZ=on` (2026-10-17, OPT-IN, exact `=== "on"`) — reversed-Z depth
// (three r184 `reversedDepthBuffer`, EXT_clip_control) instead of the
// logarithmic depth buffer, so opaque draws keep early depth rejection
// (scene3d/shader_logdepth.js "REVERSED-Z").
//
//   Z1  flag reader: exact opt-in.
//   Z2  depth-mode decision + renderer params (the log arm is today's exact
//       `{ logarithmicDepthBuffer: true }`), the EXT_clip_control probe, and
//       the probe's context attributes == three r184's WebGLRenderer ones.
//   Z3  depth decode helpers for both encodings against three's REAL reversed
//       projection (Matrix4.makePerspective reversedDepth) — the pmndrs
//       identity conventional = 1 - reversed, the near/far end points.
//   Z4  the conventional packing chunk built from three's REAL ShaderChunk.
//   Z5  installReversedZ: the Always/Never + Equal/NotEqual pre-map against
//       three's REAL WebGLState (r184 ReversedDepthFuncs maps Always -> NEVER),
//       the render-list sort-key negation, the packing swap, the context-
//       restore re-install, and a no-op on a non-reversed renderer.
//   Z6  the reversed twins of the log-depth biases: same relative distance
//       shift, right sign, vertex-stage GLSL.
//   Z7  CPU clip-space helpers on REAL reversed cameras: GL-convention MVP,
//       behind-camera NDC test, Frustum plane extraction (why culling.js passes
//       camera.reversedDepth), ortho picking ray origin.
//   Z8  every patched shader: has its reversed branch, and with the define
//       ABSENT (the log buffer) strips back to the pre-reversed-Z shader byte
//       for byte (hashes pinned 2026-10-17 from bf474c67).
//   Z9  reversed branches decode reversed depth (no log decode, sky = d <= 0),
//       far writes are 0, the restore test is relative, CSM compares flip.
//   Z10 source wiring: index.js renderer params + probe, cells.js MVPs,
//       culling / particle frustum, nameplates / brackets, takram vendor
//       patches + their re-apply in the vendor build, the pipeline's
//       near/far sync, the docs row and the harness registration.
//   Z11 takram clouds FrustumCorners: reversed corners == conventional ones.
//   Z12 base-Camera renders (takram's GPU bakes on a reversed buffer): three
//       r184's reversed flip calls `updateProjectionMatrix()` unguarded and
//       the base Camera has none, so takram's GPU noise / LUT bakes threw on
//       their first draw and the noise was never generated; the vendored
//       Procedural*TextureBase classes run against a recording renderer that
//       replays three's flip, unfixed vs installReversedZ vs log. Plus the
//       pipeline's eager clouds define and `window.__reversedZDiag`.
//
// Run: node tests/reversed_z.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;
// In a page globalThis.location IS window.location; the readers use globalThis.
globalThis.location ??= window.location;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const v = (p) => pathToFileURL(path.join(APP, p)).href;
const src = (p) => readFileSync(path.join(APP, p), "utf8");

const THREE = await import("three");
const Z = await import(v("scene3d/shader_logdepth.js"));
// Z12: three r184's own base Camera, before any installReversedZ below patches it.
const BASE_CAMERA_UPDATE_AT_IMPORT = typeof THREE.Camera.prototype.updateProjectionMatrix;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };

// ---------------------------------------------------------------------------
console.log("-- Z1 flag reader ----------------------------------------------------");
{
  const R = Z.reversedZRequested;
  check("absent / empty -> off", R("") === false && R("?foo=1") === false);
  check("exact `on` -> on", R("?reversedZ=on") === true && R("?a=1&reversedZ=on") === true);
  check("anything else -> off (ON / 1 / true / yes / off)",
    ["ON", "1", "true", "yes", "off", "0"].every((x) => R(`?reversedZ=${x}`) === false));
  window.location.search = "?reversedZ=on";
  check("no argument reads location.search", R() === true);
  window.location.search = "";
  check("no argument, bare URL -> off", R() === false);
}

// ---------------------------------------------------------------------------
console.log("-- Z2 decision, renderer params, probe ------------------------------");
{
  const D = Z.resolveDepthMode;
  const a = D({ requested: false, clipControl: true });
  const b = D({ requested: true, clipControl: false });
  const c = D({ requested: true, clipControl: true });
  check("not requested -> log (even with the extension)", a.mode === "log" && a.reversed === false && a.reason === "default");
  check("requested, no EXT_clip_control -> log, reason named", b.mode === "log" && b.reversed === false && b.reason === "no-EXT_clip_control");
  check("requested + EXT_clip_control -> reversed", c.mode === "reversed" && c.reversed === true);
  check("D() with no args -> log", D().mode === "log");
  const lp = Z.depthRendererParams("log");
  const rp = Z.depthRendererParams("reversed");
  check("log arm is EXACTLY today's { logarithmicDepthBuffer: true } (no reversedDepthBuffer key)",
    JSON.stringify(lp) === JSON.stringify({ logarithmicDepthBuffer: true }));
  check("reversed arm: no log buffer, reversedDepthBuffer: true",
    rp.logarithmicDepthBuffer === false && rp.reversedDepthBuffer === true);
  check("unknown mode -> log arm", JSON.stringify(Z.depthRendererParams("garbage")) === JSON.stringify(lp));

  const ctx = (exts) => ({ getSupportedExtensions: () => exts });
  const canvas = (gl, sink) => ({ getContext: (name, attrs) => { if (sink) sink.push({ name, attrs }); return gl; } });
  const calls = [];
  check("probe: extension listed -> true", Z.probeClipControl(canvas(ctx(["EXT_color_buffer_float", "EXT_clip_control"]), calls), { x: 1 }) === true);
  check("probe asks for webgl2 with the attributes it was given", calls[0].name === "webgl2" && calls[0].attrs.x === 1);
  check("probe: extension absent -> false", Z.probeClipControl(canvas(ctx(["EXT_color_buffer_float"]))) === false);
  check("probe: no context / no canvas / throwing canvas -> false (never throws)",
    Z.probeClipControl(canvas(null)) === false && Z.probeClipControl(null) === false &&
    Z.probeClipControl({ getContext() { throw new Error("x"); } }) === false &&
    Z.probeClipControl(canvas(ctx(null))) === false);

  // The probe's attributes must be three r184's, or the first getContext wins
  // with different attributes and three silently gets them.
  const wr = readFileSync(path.join(APP, "node_modules/three/src/renderers/WebGLRenderer.js"), "utf8");
  const block = /const contextAttributes = \{([\s\S]*?)\};/.exec(wr);
  const keys = block ? block[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean) : [];
  const attrs = Z.threeContextAttributes({ antialias: true });
  check("threeContextAttributes has exactly three's contextAttributes keys",
    keys.length === 8 && keys.every((k) => k in attrs) && Object.keys(attrs).length === keys.length, keys.join(","));
  const defaults = /constructor\( parameters = \{\} \) \{\s*const \{([\s\S]*?)\} = parameters;/.exec(wr);
  const dflt = {};
  if (defaults) for (const m of defaults[1].matchAll(/(\w+) = ([^,\n]+)/g)) dflt[m[1]] = m[2].trim();
  check("…with three's defaults (alpha always true in the request; the rest r184 defaults)",
    /alpha: true,/.test(block ? block[1] : "") && attrs.alpha === true && attrs.antialias === true &&
    String(attrs.depth) === dflt.depth && String(attrs.stencil) === dflt.stencil &&
    String(attrs.premultipliedAlpha) === dflt.premultipliedAlpha &&
    String(attrs.preserveDrawingBuffer) === dflt.preserveDrawingBuffer &&
    `'${attrs.powerPreference}'` === dflt.powerPreference &&
    String(attrs.failIfMajorPerformanceCaveat) === dflt.failIfMajorPerformanceCaveat, JSON.stringify(dflt));
  check("antialias defaults false", Z.threeContextAttributes().antialias === false);
}

// ---------------------------------------------------------------------------
console.log("-- Z3 depth decode helpers vs three's real projections ---------------");
{
  const n = 0.1, f = 5000;
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, n, f);
  cam._reversedDepth = true;
  cam.updateProjectionMatrix();
  const std = new THREE.PerspectiveCamera(60, 16 / 9, n, f);
  check("three r184 has Camera.reversedDepth driving makePerspective", cam.reversedDepth === true &&
    cam.projectionMatrix.elements[10] !== std.projectionMatrix.elements[10]);
  let worstRev = 0, worstFlip = 0, worstLog = 0, worstStd = 0;
  for (const D of [0.1, 0.5, 1, 3, 10, 47, 120, 480, 833, 1150, 2400, 4000, 4999]) {
    const p = new THREE.Vector4(0.3, -0.2, -D, 1).applyMatrix4(cam.projectionMatrix);
    const dRev = p.z / p.w; // ZERO_TO_ONE clip control: window depth == NDC z
    worstRev = Math.max(worstRev, Math.abs(dRev - Z.viewDistToReversedDepth(D, n, f)));
    worstRev = Math.max(worstRev, Math.abs(Z.reversedDepthToViewDist(dRev, n, f) - D) / D);
    const q = new THREE.Vector4(0.3, -0.2, -D, 1).applyMatrix4(std.projectionMatrix);
    const dStd = 0.5 * (q.z / q.w) + 0.5;
    worstFlip = Math.max(worstFlip, Math.abs((1 - dRev) - dStd));
    worstStd = Math.max(worstStd, Math.abs(Z.perspectiveDepthToViewDist(dStd, n, f) - D) / D);
    worstLog = Math.max(worstLog, Math.abs(Z.logDepthToViewDist(Z.viewDistToLogDepth(D, f), f) - D) / Math.max(1, D));
  }
  check("viewDistToReversedDepth == three's reversed projection; decode inverts it", worstRev < 1e-9, `worst ${worstRev}`);
  check("conventional depth == 1 - reversed depth (the pmndrs readDepth flip is exact)", worstFlip < 1e-12, `worst ${worstFlip}`);
  check("perspective + log decodes invert their encoders", worstStd < 1e-6 && worstLog < 1e-9, `${worstStd} ${worstLog}`);
  check("reversed: near plane -> 1, far plane -> 0; decode(1) = near, decode(0) = far",
    near(Z.viewDistToReversedDepth(n, n, f), 1) && Math.abs(Z.viewDistToReversedDepth(f, n, f)) < 1e-15 &&
    near(Z.reversedDepthToViewDist(1, n, f), n) && near(Z.reversedDepthToViewDist(0, n, f), f));
  const d1k = Z.viewDistToReversedDepth(1000, n, f);
  check("float32 keeps reversed depth at 1 km to ~1e-7 relative (the precision argument)",
    Math.abs(Math.fround(d1k) - d1k) / d1k < 1.2e-7 && d1k > 1e-5 && d1k < 1e-3, `${d1k}`);
}

// ---------------------------------------------------------------------------
console.log("-- Z4 conventional packing chunk ------------------------------------");
{
  const real = THREE.ShaderChunk.packing;
  const out = Z.conventionalPackingChunk(real);
  check("three r184 packing has the two reversed branches the patch expects",
    (real.match(/#ifdef USE_REVERSED_DEPTH_BUFFER/g) || []).length === 2);
  check("patched chunk: no reversed branch left, conventional formulas kept",
    typeof out === "string" && !/USE_REVERSED_DEPTH_BUFFER/.test(out) &&
    /return \( near \* far \) \/ \( \( far - near \) \* depth - far \);/.test(out) &&
    /return depth \* \( near - far \) - near;/.test(out) &&
    !/\( near - far \) \* depth - near/.test(out));
  check("everything else in the chunk is untouched (packDepthToRGBA etc.)",
    out.includes("packDepthToRGBA") && out.includes("viewZToPerspectiveDepth") &&
    out.length < real.length && out.length > real.length - 400);
  check("not the r184 shape (already patched / garbage / non-string) -> null",
    Z.conventionalPackingChunk(out) === null && Z.conventionalPackingChunk("float x;") === null &&
    Z.conventionalPackingChunk(null) === null);
}

// ---------------------------------------------------------------------------
console.log("-- Z5 installReversedZ against three's real WebGLState ----------------");
{
  // A recording WebGL2 stub: enough for three r184's WebGLState constructor.
  const GLC = {
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205,
    GEQUAL: 0x0206, ALWAYS: 0x0207, DEPTH_FUNC: 0x0B74, VERSION: 0x1F02, SCISSOR_BOX: 0x0C10,
    VIEWPORT: 0x0BA2, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
  };
  function makeGl() {
    const st = { depthFunc: GLC.LESS, clipControl: [], clearDepth: [], calls: 0 };
    const target = {
      ...GLC,
      depthFunc(f) { st.depthFunc = f; },
      clearDepth(d) { st.clearDepth.push(d); },
      getParameter(p) {
        if (p === GLC.DEPTH_FUNC) return st.depthFunc;
        if (p === GLC.VERSION) return "WebGL 2.0";
        if (p === GLC.SCISSOR_BOX || p === GLC.VIEWPORT) return new Int32Array([0, 0, 1, 1]);
        if (p === GLC.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 32;
        return 0;
      },
      createTexture() { return {}; },
    };
    const gl = new Proxy(target, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === "string" && /^[A-Z_0-9]+$/.test(k)) return 0x9000 + k.length; // any other GL enum
        return () => { st.calls++; return null; };
      },
    });
    return { gl, st };
  }
  const { WebGLState } = await import(v("node_modules/three/src/renderers/webgl/WebGLState.js"));
  const ext = { get: () => ({ LOWER_LEFT_EXT: 1, ZERO_TO_ONE_EXT: 2, NEGATIVE_ONE_TO_ONE_EXT: 3, clipControlEXT() {} }) };
  function makeRenderer(reversed = true) {
    const { gl, st } = makeGl();
    const state = new WebGLState(gl, ext);
    if (reversed) state.buffers.depth.setReversed(true);
    const listeners = {};
    const lists = new Map();
    const makeList = () => {
      const items = [];
      return {
        items,
        push(o, g, m, go, z, gr) { items.push({ o, z, gr }); },
        unshift(o, g, m, go, z, gr) { items.unshift({ o, z, gr }); },
      };
    };
    const renderer = {
      state,
      getContext: () => gl,
      renderLists: { get(scene, depth) { const k = `${scene}|${depth}`; if (!lists.has(k)) lists.set(k, makeList()); return lists.get(k); } },
      domElement: { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } },
    };
    return { renderer, gl, st, listeners };
  }
  const fakeTHREE = (packing) => ({ ...THREE, ShaderChunk: { packing } });

  // r184's own table, through the real DepthBuffer: Always becomes NEVER.
  {
    const { renderer, st } = makeRenderer(true);
    renderer.state.buffers.depth.setFunc(THREE.AlwaysDepth);
    check("three r184 reversed DepthBuffer maps AlwaysDepth to GL NEVER (the bug being fixed)", st.depthFunc === GLC.NEVER);
  }
  const T = fakeTHREE(THREE.ShaderChunk.packing);
  const { renderer, st, listeners } = makeRenderer(true);
  const r = Z.installReversedZ(T, renderer);
  check("installs on a reversed renderer: depth-func + sort-key + packing fixes",
    r.installed && r.depthFuncFix && r.sortKeyFix && r.packing, JSON.stringify(r));
  const d = renderer.state.buffers.depth;
  const fn = (f) => { d.setFunc(f); return st.depthFunc; };
  check("after the fix: Always -> ALWAYS, Never -> NEVER, Equal -> EQUAL, NotEqual -> NOTEQUAL",
    fn(THREE.AlwaysDepth) === GLC.ALWAYS && fn(THREE.NeverDepth) === GLC.NEVER &&
    fn(THREE.EqualDepth) === GLC.EQUAL && fn(THREE.NotEqualDepth) === GLC.NOTEQUAL);
  check("…and the direction flips stay three's: LessEqual -> GEQUAL, Less -> GREATER, Greater -> LESS",
    fn(THREE.LessEqualDepth) === GLC.GEQUAL && fn(THREE.LessDepth) === GLC.GREATER && fn(THREE.GreaterDepth) === GLC.LESS);
  check("packing chunk swapped on the THREE it was given (conventional helpers)",
    !/USE_REVERSED_DEPTH_BUFFER/.test(T.ShaderChunk.packing) && THREE.ShaderChunk.packing !== T.ShaderChunk.packing);
  const list = renderer.renderLists.get("scene", 0);
  list.push("a", null, null, 0, 0.25, null);
  list.unshift("b", null, null, 0, -3, null);
  check("render-list keys negated on push and unshift (reversed clip z shrinks with distance)",
    list.items[0].z === 3 && list.items[1].z === -0.25 && list.items[0].o === "b");
  const again = renderer.renderLists.get("scene", 0);
  again.push("c", null, null, 0, 1, null);
  check("the same list is patched once (no double negation)", again === list && list.items[2].z === -1);
  const r2 = Z.installReversedZ(T, renderer);
  list.push("d", null, null, 0, 2, null);
  check("a second install is idempotent (still exactly one negation)", r2.installed && list.items[3].z === -2);

  // Context restore: three rebuilds state + renderLists, our listener re-installs.
  const fresh = makeRenderer(true);
  renderer.state = fresh.renderer.state;
  renderer.renderLists = fresh.renderer.renderLists;
  renderer.getContext = fresh.renderer.getContext;
  for (const l of listeners.webglcontextrestored || []) l();
  renderer.state.buffers.depth.setFunc(THREE.AlwaysDepth);
  const l2 = renderer.renderLists.get("scene", 0);
  l2.push("e", null, null, 0, 5, null);
  check("webglcontextrestored re-installs both fixes on the rebuilt state / lists",
    (listeners.webglcontextrestored || []).length >= 1 && fresh.st.depthFunc === GLC.ALWAYS && l2.items[0].z === -5);

  const off = makeRenderer(false);
  const T2 = fakeTHREE(THREE.ShaderChunk.packing);
  const r3 = Z.installReversedZ(T2, off.renderer);
  off.renderer.state.buffers.depth.setFunc(THREE.AlwaysDepth);
  const l3 = off.renderer.renderLists.get("s", 0);
  l3.push("x", null, null, 0, 7, null);
  check("non-reversed renderer: nothing installed, nothing touched",
    r3.installed === false && off.st.depthFunc === GLC.ALWAYS && l3.items[0].z === 7 &&
    T2.ShaderChunk.packing === THREE.ShaderChunk.packing);
  check("no renderer / no THREE -> installed false, never throws",
    Z.installReversedZ(null, renderer).installed === false && Z.installReversedZ(T, null).installed === false);
}

// ---------------------------------------------------------------------------
console.log("-- Z6 reversed twins of the log-depth biases --------------------------");
{
  const n = 0.1, f = 5000;
  // log arm: gl_FragDepth += delta  ->  (1 + D') = (1 + D) (f + 1)^delta
  // reversed arm: gl_Position.z *= s  ->  D' = D / (s + (1 - s) D / f)
  // so the reversed shift is the log shift times ~D / (1 + D) * (1 - D / f):
  // half of it at 1 m, ~all of it from a few metres to a few hundred, 80 % at 1 km.
  const rows = [];
  let ok = true;
  for (const delta of [2e-4, -2e-4, -4e-4]) {
    const s = Z.reversedBiasScale(delta);
    for (const D of [1, 5, 20, 100, 400, 1000]) {
      const Dlog = Math.pow(2, Math.log2(1 + D) + delta * Math.log2(f + 1)) - 1;
      const Drev = Z.reversedDepthToViewDist(s * Z.viewDistToReversedDepth(D, n, f), n, f);
      const ratio = (Drev - D) / (Dlog - D);
      const expect = (D / (1 + D)) * (1 - D / f);
      rows.push(`${delta}@${D}:${ratio.toFixed(3)}`);
      if (!(ratio > 0 && Math.abs(ratio - expect) < 0.01)) ok = false;
    }
  }
  check("the reversed scale shifts distance like the log bias it replaces (same sign; ratio D/(1+D)*(1-D/f))", ok, rows.join(" "));
  check("signs: fill (+2e-4) pushes away (s < 1); floor (-2e-4) and statics (-4e-4) pull in (s > 1, statics stronger)",
    Z.reversedBiasScale(2e-4) < 1 && Z.reversedBiasScale(-2e-4) > 1 && Z.reversedBiasScale(-4e-4) > Z.reversedBiasScale(-2e-4));
  const g = Z.reversedDepthBiasVertexGlsl(1.25);
  check("vertex snippet: guarded gl_Position.z scale, no gl_FragDepth, no trailing newline",
    g === "\n#ifdef USE_REVERSED_DEPTH_BUFFER\n\tgl_Position.z *= 1.250000000;\n#endif" && !/FragDepth/.test(g));
  check("stripReversedZBranches(include + snippet + rest) is the original text",
    Z.stripReversedZBranches("#include <logdepthbuf_vertex>" + g + "\n\t#include <x>") === "#include <logdepthbuf_vertex>\n\t#include <x>");
}

// ---------------------------------------------------------------------------
console.log("-- Z7 CPU clip-space helpers on real reversed cameras -----------------");
{
  const cam = new THREE.PerspectiveCamera(60, 1.5, 0.1, 5000);
  cam.position.set(3, 4, 5);
  cam.lookAt(10, 2, -40);
  cam.updateMatrixWorld();
  const std = cam.clone();
  std.updateProjectionMatrix();
  cam._reversedDepth = true;
  cam.updateProjectionMatrix();
  const scratch = new THREE.Matrix4();
  const gl = Z.glClipProjection(cam, scratch);
  let worst = 0;
  for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(gl.elements[i] - std.projectionMatrix.elements[i]));
  check("glClipProjection(reversed) == the conventional GL projection", gl === scratch && worst < 1e-9, `worst ${worst}`);
  check("glClipProjection(not reversed) is the camera's own matrix (no copy)", Z.glClipProjection(std, scratch) === std.projectionMatrix);
  const ortho = new THREE.OrthographicCamera(-50, 50, 40, -40, 1, 2200);
  const orthoStd = ortho.clone();
  ortho._reversedDepth = true;
  ortho.updateProjectionMatrix();
  orthoStd.updateProjectionMatrix();
  const go = Z.glClipProjection(ortho, new THREE.Matrix4());
  let wo = 0;
  for (let i = 0; i < 16; i++) wo = Math.max(wo, Math.abs(go.elements[i] - orthoStd.projectionMatrix.elements[i]));
  check("…also for an orthographic camera", wo < 1e-9, `worst ${wo}`);

  const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
  const at = (d) => cam.position.clone().addScaledVector(fwd, d);
  const front = at(30).project(cam), behind = at(-30).project(cam), past = at(6000).project(cam);
  const fStd = at(30).project(std), bStd = at(-30).project(std);
  check("reversed NDC: in front z in (0, 1]; behind the eye and past far z < 0",
    front.z > 0 && front.z <= 1 && behind.z < 0 && past.z < 0, `${front.z} ${behind.z} ${past.z}`);
  check("ndcBehindCamera: reversed uses z < 0, GL uses z > 1",
    !Z.ndcBehindCamera(front.z, cam) && Z.ndcBehindCamera(behind.z, cam) &&
    !Z.ndcBehindCamera(fStd.z, std) && Z.ndcBehindCamera(bStd.z, std) &&
    // and the GL rule alone would MISS the behind-camera point under reversed (the bug)
    !(behind.z > 1));

  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const right = new THREE.Frustum().setFromProjectionMatrix(vp, cam.coordinateSystem, true);
  const wrong = new THREE.Frustum().setFromProjectionMatrix(vp);
  check("Frustum with reversedDepth culls past-far and keeps in-range; without it far culling is lost",
    right.containsPoint(at(30)) && !right.containsPoint(at(6000)) && wrong.containsPoint(at(6000)));

  // picking.js — ortho ray origin on the camera plane under reversed.
  ortho.position.set(0, 500, 0);
  ortho.lookAt(0, 0, 0);
  ortho.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(0.2, -0.1), ortho);
  const threeOrigin = rc.ray.origin.clone();
  rc.ray.origin.set(0.2, -0.1, ortho.far / (ortho.far - ortho.near)).unproject(ortho);
  const local = rc.ray.origin.clone().applyMatrix4(ortho.matrixWorldInverse);
  const threeLocal = threeOrigin.clone().applyMatrix4(ortho.matrixWorldInverse);
  check("ortho picking: three's setFromCamera origin lands behind the scene under reversed; the fix puts it on the camera plane",
    Math.abs(local.z) < 1e-6 && threeLocal.z < -ortho.far, `fixed z ${local.z}, three z ${threeLocal.z}`);
}

// ---------------------------------------------------------------------------
console.log("-- Z8 the log arm of every patched shader is byte-identical -----------");
// Hashes of the pre-reversed-Z shaders (bf474c67), taken through the same
// accessors. If you changed one of these shaders ON PURPOSE, re-pin it with
// fnv(stripReversedZBranches(<accessor>)) — the point is only that the
// reversed-Z branches compile out to exactly the log-buffer program.
const PINNED = {};
const pin = (name, hash, len, text, opts = {}) => {
  PINNED[name] = true;
  const s = Z.stripReversedZBranches(text);
  check(`${name}: carries a reversed branch`, opts.noBranch === true || /#ifdef USE_REVERSED_DEPTH_BUFFER/.test(text));
  check(`${name}: log arm == the pre-reversed-Z shader byte for byte`, fnv(s) === hash && s.length === len,
    `${fnv(s)}/${s.length} (pinned ${hash}/${len})`);
};
{
  const ft = await import(v("scene3d/far_terrain.js"));
  pin("far terrain vertex", "ddfe3fb4", 1508, ft.FAR_VERTEX_GLSL);
  const gf = await import(v("scene3d/ground_fog.js"));
  pin("ground fog fragment", "b1eaa3e2", 2144, gf.GROUND_FOG_FRAGMENT_GLSL);
  const sg = await import(v("scene3d/sky_glow.js"));
  pin("sky glow fragment body", "8d027088", 395, sg.SKY_GLOW_FRAGMENT_BODY);
  const lh = await import(v("scene3d/layered_haze.js"));
  pin("layered haze", "c1b709ba", 1048, lh.LAYER_HAZE_FRAG);
  const hh = await import(v("scene3d/vfx/heat_haze_effect.js"));
  pin("heat haze effect", "adcbf918", 2469, new hh.HeatHazeEffect({}).getFragmentShader());
  const fd = await import(v("scene3d/vfx/fx_distort_effect.js"));
  pin("fx distort effect", "2df31453", 2926, new fd.FxDistortEffect({}).getFragmentShader());
  const ss = await import(v("scene3d/ssao.js"));
  pin("ssao (SAO pass)", "4c7ca565", 2292, new ss.SsaoPass(new THREE.PerspectiveCamera()).saoMat.fragmentShader);
  const pp = await import(v("scene3d/portal_punch.js"));
  pin("portal punch", "70abf2c8", 135, new pp.PortalPunchPass(null, new THREE.PerspectiveCamera())._punchMat.fragmentShader);
  pin("portal seal (armed)", "cd68919a", 487, new pp.PortalPunchPass(null, new THREE.PerspectiveCamera(), "seal")._punchMat.fragmentShader);
  pin("portal seal depth restore", "047eb026", 1028, pp.__test_makeDepthRestoreMaterial().fragmentShader);
  const ps = await import(v("scene3d/portal_stencil.js"));
  const psPass = new ps.PortalStencilPass(new THREE.Scene(), new THREE.PerspectiveCamera());
  pin("portal stencil reset", "4daa938a", 134,
    Object.values(psPass).filter((x) => x && x.isShaderMaterial).map((x) => x.fragmentShader).join("\n//--\n"));
  const ff = await import(v("scene3d/vfx/fx_fields.js"));
  pin("fx fields glow", "af2f9b36", 1476, ff.FX_FIELDS_GLSL.fragment);
  const fs = await import(v("scene3d/vfx/fx_showcase.js"));
  pin("fx showcase glow", "32500600", 5837, fs.FX_SHOWCASE_GLSL.fragment);
  const ls = await import(v("scene3d/vfx/lifestone_fx.js"));
  pin("lifestone glow", "dc4e7f24", 985, ls.LIFESTONE_GLOW_GLSL.fragment);
  const fx = await import(v("scene3d/vfx/fx_decal_effect.js"));
  pin("fx decal box (smooth)", "84851a7f", 9208, fx.FX_DECAL_GLSL.fragment);
  // (the legacy decal box is pinned by test_particle_fx_tier2 8b the same way)
  const mats = await import(v("scene3d/materials.js"));
  const biased = (apply, lib, Mat) => {
    const m = new Mat();
    apply(m);
    const sh = { vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader, uniforms: {} };
    m.onBeforeCompile(sh, null);
    return sh.vertexShader + "\n//FRAG\n" + sh.fragmentShader;
  };
  pin("floor depth bias (MeshStandard)", "510a3a0a", 5283, biased(mats.applyFloorDepthBias, "standard", THREE.MeshStandardMaterial));
  pin("static depth bias (MeshStandard)", "c90bb7f8", 5283, biased(mats.applyStaticDepthBias, "standard", THREE.MeshStandardMaterial));
  pin("wire fill depth bias (MeshBasic)", "312ad7d8", 2684, biased(mats.applyFillDepthBias, "basic", THREE.MeshBasicMaterial));
  const pf = await import(v("scene3d/particles/particle_fx.js"));
  const psh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  pf.patchParticleFxShader(psh);
  pin("particle fx (patched MeshBasic) fragment", "899f1591", 9552, psh.fragmentShader);
  pin("particle fx (patched MeshBasic) vertex", "8ba2b5b2", 9140, psh.vertexShader);
  // The big terrain program: its log arm is checked structurally in Z9 (pinning
  // a 166 KB shader that every terrain card edits would only add merge churn).
}

// ---------------------------------------------------------------------------
console.log("-- Z9 what the reversed branches do -----------------------------------");
const revBranches = (text) => {
  // The reversed-ONLY text: lines inside `#ifdef USE_REVERSED_DEPTH_BUFFER`
  // before its `#else` (non-nested; none of ours nest).
  const out = [];
  const re = /#ifdef USE_REVERSED_DEPTH_BUFFER[^\n]*\n([\s\S]*?)^[ \t]*#(else|endif)\b/gm;
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
};
const REV_DECODE = /\(\s*(\w+(?:\.\w+)?)\s*\*\s*(\w+(?:\.\w+)?)\s*\)\s*\/\s*\(\s*\w+\s*\*\s*\(\s*\2\s*-\s*\1\s*\)\s*\+\s*\1\s*\)/;
{
  const decoders = {
    "heat haze": (await import(v("scene3d/vfx/heat_haze_effect.js"))),
    "fx distort": (await import(v("scene3d/vfx/fx_distort_effect.js"))),
  };
  const hh = new decoders["heat haze"].HeatHazeEffect({}).getFragmentShader();
  const fdx = new decoders["fx distort"].FxDistortEffect({}).getFragmentShader();
  const gf = (await import(v("scene3d/ground_fog.js"))).GROUND_FOG_FRAGMENT_GLSL;
  const lh = (await import(v("scene3d/layered_haze.js"))).LAYER_HAZE_FRAG;
  const sao = new (await import(v("scene3d/ssao.js"))).SsaoPass(new THREE.PerspectiveCamera()).saoMat.fragmentShader;
  const fxd = (await import(v("scene3d/vfx/fx_decal_effect.js")));
  const ffg = (await import(v("scene3d/vfx/fx_fields.js"))).FX_FIELDS_GLSL.fragment;
  const fsg = (await import(v("scene3d/vfx/fx_showcase.js"))).FX_SHOWCASE_GLSL.fragment;
  const lsg = (await import(v("scene3d/vfx/lifestone_fx.js"))).LIFESTONE_GLOW_GLSL.fragment;
  const psh = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  (await import(v("scene3d/particles/particle_fx.js"))).patchParticleFxShader(psh);
  const readers = {
    "heat haze": hh, "fx distort": fdx, "ground fog": gf, "layered haze": lh, "ssao": sao,
    "fx decal (smooth)": fxd.FX_DECAL_GLSL.fragment, "fx decal (legacy)": fxd.FX_DECAL_GLSL_LEGACY.fragment,
    "fx fields glow": ffg, "fx showcase glow": fsg, "lifestone glow": lsg, "particle fx glow": psh.fragmentShader,
  };
  for (const [name, text] of Object.entries(readers)) {
    const br = revBranches(text);
    const all = br.join("\n");
    check(`${name}: reversed branch decodes n*f/(d*(f-n)+n), never the log decode`,
      br.length > 0 && (REV_DECODE.test(all) || /revW\(/.test(all)) && !/exp2\s*\(/.test(all) && !/log2\s*\(/.test(all),
      all.slice(0, 160).replace(/\s+/g, " "));
    check(`${name}: no gl_FragDepth write in a reader's reversed branch`, !/gl_FragDepth/.test(all));
  }
  check("sky tests flip: reversed sky is d <= 0 (heat haze, fx distort, decals, glows, ssao)",
    [hh, fdx, fxd.FX_DECAL_GLSL.fragment, ffg, fsg, lsg, psh.fragmentShader, sao]
      .every((t) => /<= 0\.0\s*\)/.test(revBranches(t).join("\n"))));
  check("ground fog / cloud overlay treat any reversed depth > 0 as an occluder",
    /if \(d > 0\.0\)/.test(revBranches(gf).join("\n")) &&
    /if \(d > 0\.0\) discard;/.test(revBranches(src("scene3d/cloud_overlay.js")).join("\n")));

  const pp = await import(v("scene3d/portal_punch.js"));
  const punch = new pp.PortalPunchPass(null, new THREE.PerspectiveCamera())._punchMat.fragmentShader;
  const seal = new pp.PortalPunchPass(null, new THREE.PerspectiveCamera(), "seal")._punchMat.fragmentShader;
  const sealOff = new pp.PortalPunchPass(null, new THREE.PerspectiveCamera(), "seal", { logDepth: false })._punchMat.fragmentShader;
  const restore = pp.__test_makeDepthRestoreMaterial().fragmentShader;
  check("punch writes far = 0.0 under reversed (the cleared value)",
    pp.FAR_DEPTH_REVERSED === 0 && /gl_FragDepth = 0\.0;/.test(revBranches(punch).join("\n")));
  check("armed seal writes its own pixel-centre depth per fragment under reversed (MSAA resolve == restore's own)",
    /gl_FragDepth = gl_FragCoord\.z;/.test(revBranches(seal).join("\n")) && !/USE_REVERSED_DEPTH_BUFFER/.test(sealOff));
  check("restore compares RELATIVE to the seal depth under reversed",
    /abs\(cur - own\) <= 1\.0e-5 \* abs\(own\)/.test(revBranches(restore).join("\n")));
  const R = pp.restoredDepth;
  check("restoredDepth(reversed): relative eps, log arm unchanged",
    R(0.002, 0.002 * (1 + 5e-6), 0.9, true) === 0.9 && R(0.002, 0.002 * (1 + 5e-5), 0.9, true) === 0.002 &&
    R(0.5, 0.500005, 0.9) === 0.9 && R(0.5, 0.5002, 0.9) === 0.5 &&
    // absolute 1e-5 would have matched a surface 0.5 % away at d = 0.002 — the bug the relative test avoids
    R(0.002, 0.002005, 0.9, false) === 0.9 && R(0.002, 0.002005, 0.9, true) === 0.002);
  const ps = src("scene3d/portal_stencil.js");
  check("portal stencil reset writes 0.0 under reversed", /#ifdef USE_REVERSED_DEPTH_BUFFER\n\s*gl_FragDepth = 0\.0;/.test(ps));
  const sg = (await import(v("scene3d/sky_glow.js"))).SKY_GLOW_FRAGMENT_BODY;
  check("sky glow writes far = 0.0 under reversed (only cleared pixels pass GreaterEqual)",
    /gl_FragDepth = 0\.0;/.test(revBranches(sg).join("\n")) && /#else\n\tgl_FragDepth = 1\.0;/.test(sg));

  const terr = (await import(v("scene3d/terrain.js")))._terrainGlslForTest().fragment;
  const csmSrc = src("scene3d/materials.js");
  const pfx = psh.vertexShader + psh.fragmentShader + src("scene3d/particles/particle_fx.js");
  for (const [name, text, refRe] of [
    ["terrain CSM", terr, /float ref = sc\.z \+ bias;/],
    ["materials CSM", csmSrc, /float ref = shadowCoord\.z \+ bias;/],
    ["particle fx CSM", pfx, /sc\.z \+ 0\.0015/],
  ]) {
    const all = revBranches(text).join("\n");
    check(`${name}: reversed cascade compare — past-far is z < 0, bias toward the light (+)`,
      refRe.test(all) && /z < 0\.0/.test(all));
  }
  const terrCode = terr.replace(/\/\/[^\n]*/g, "");
  check("terrain shader: its only gl_FragDepth write is the guarded log one (none under reversed)",
    (terrCode.match(/gl_FragDepth\s*=/g) || []).length === 1 &&
    /#if defined\( USE_LOGARITHMIC_DEPTH_BUFFER \)[^\n]*\n\s*gl_FragDepth = vIsPerspective/.test(terrCode) &&
    !/gl_FragDepth/.test(revBranches(terr).join("\n")));

  const far = (await import(v("scene3d/far_terrain.js")));
  const fv = revBranches(far.FAR_VERTEX_GLSL).join("\n");
  check("far ring: the log push becomes a vertex z scale (uFarDepthBias declared in the vertex stage)",
    /uniform float uFarDepthBias;/.test(fv) && /gl_Position\.z \*= exp2\(-uFarDepthBias \* 12\.288\d+\);/.test(fv) &&
    near(Math.pow(2, -1e-6 * 12.288107), Z.reversedBiasScale(1e-6), 1e-9));
  const bd = src("scene3d/blood_decals.js");
  check("blood decals: the 0.1 % eye pull becomes gl_Position.z /= 0.9990 under reversed",
    /#ifdef USE_REVERSED_DEPTH_BUFFER[\s\S]{0,400}gl_Position\.z \/= \$\{BLOOD_DEPTH_BIAS\.toFixed\(4\)\};/.test(bd));
  const pfSoft = src("scene3d/particles/particle_fx.js");
  check("soft-particle depth copy (raw material, no define): a uIsRev branch set from the renderer's depth state",
    /uniform float uIsRev;/.test(pfSoft) && /if \( uIsRev > 0\.5 \) \{\s*\/\/[^\n]*\n\s*w = \( uNear \* uFar \) \/ \( d \* \( uFar - uNear \) \+ uNear \);/.test(pfSoft) &&
    /u\.uIsRev\.value = isRev \? 1 : 0;/.test(pfSoft) && /getReversed\?\.\(\) === true/.test(pfSoft));
}

// ---------------------------------------------------------------------------
console.log("-- Z10 source wiring --------------------------------------------------");
{
  const idx = src("scene3d/index.js");
  check("index.js: probe only when ?reversedZ=on, renderer params from depthRendererParams",
    /if \(reversedZRequested\(\)\) \{\s*_depthMode = resolveDepthMode\(\{\s*requested: true,\s*clipControl: probeClipControl\(canvas, threeContextAttributes/.test(idx) &&
    /let renderer = new THREE\.WebGLRenderer\(\{\s*canvas,\s*antialias: !!quality\.flags\.antialias && \(wireframeMode \|\| _canvasMsaa\),\s*\.\.\.depthRendererParams\(_depthMode\.mode\),\s*\}\);/.test(idx) &&
    !/logarithmicDepthBuffer: true,/.test(idx.slice(idx.indexOf("installRadialFog(THREE);"), idx.indexOf("Goal-1 (2026-06-22)"))));
  check("index.js: installReversedZ right after construction, log rebuild if three did not arm it, one console line per outcome",
    /const _rz = installReversedZ\(THREE, renderer\);/.test(idx) && /renderer\.dispose\(\);[\s\S]{0,200}depthRendererParams\("log"\)/.test(idx) &&
    /console\.warn\(`\[reversedZ\] \?reversedZ=on but/.test(idx) && /console\.log\(`\[reversedZ\] on/.test(idx) && /window\.__depthMode = Object\.freeze/.test(idx));
  const cells = src("scene3d/cells.js");
  check("cells.js: every camera MVP goes through glClipProjection (wasm frustum / PView / aperture walks)",
    (cells.match(/glClipProjection\((camera|cam), _glClipProj\)/g) || []).length === 6 &&
    !/multiplyMatrices\((camera|cam)\.projectionMatrix/.test(cells));
  check("culling.js + particle RP6 + index.js diag: Frustum gets camera.reversedDepth",
    /setFromProjectionMatrix\(this\._mvp, camera\.coordinateSystem, camera\.reversedDepth === true\)/.test(src("scene3d/culling.js")) &&
    /setFromProjectionMatrix\(_rp6Mvp, camera\.coordinateSystem, camera\.reversedDepth === true\)/.test(src("scene3d/particles/particle_manager.js")) &&
    (idx.match(/rp6Cam\.reversedDepth === true/g) || []).length === 2);
  check("nameplates + selection brackets: reversed behind-camera test (z < 0)",
    /camera\.reversedDepth === true\s*\?\s*this\._tmpVec\.z < 0/.test(src("scene3d/hud.js")) &&
    /this\._behindRev \? this\._vC\.z < 0/.test(src("scene3d/selection_brackets.js")) &&
    /this\._behindRev === true \? ndc\.z < 0/.test(src("scene3d/selection_brackets.js")));
  check("picking.js: ortho ray origin re-placed on the camera plane under reversed",
    /camera\.isOrthographicCamera && camera\.reversedDepth === true[\s\S]{0,500}camera\.far \/ \(camera\.far - camera\.near\)/.test(src("scene3d/picking.js")));
  const geo = src("vendor/takram/three-geospatial-shaders.js");
  check("takram readDepthValue hands conventional depth (1 - d) under the define",
    /#ifdef USE_REVERSED_DEPTH_BUFFER[\s\S]{0,300}return 1\.0 - texture\(depthBuffer, uv\)\.r;\s*#else[^\n]*\n\s*return texture\(depthBuffer, uv\)\.r;/.test(geo));
  const vb = src("scripts/build-vendor-takram.mjs");
  check("the takram vendor build re-applies that patch (and fails loudly if the anchor moves)",
    /return 1\.0 - texture\(depthBuffer, uv\)\.r;/.test(vb) && /readDepthValue anchor not found/.test(vb));
  const clouds = src("vendor/takram-three-clouds/build/index.js");
  const cloudsTs = src("vendor/takram-three-clouds/src/CloudsMaterial.ts");
  check("takram clouds (raw material) mirror USE_REVERSED_DEPTH_BUFFER from the renderer (build + src)",
    /const nextReversedDepthBuffer = renderer\.state\?\.buffers\?\.depth\?\.getReversed\?\.\(\) === true;/.test(clouds) &&
    /this\.defines\.USE_REVERSED_DEPTH_BUFFER = "1";/.test(clouds) &&
    /USE_REVERSED_DEPTH_BUFFER = '1'/.test(cloudsTs));
  const ap = src("scene3d/atmosphere_pipeline.js");
  check("pipeline: effect cameraNear/cameraFar kept live, only on a reversed renderer",
    /const reversedZ = renderer\.state\?\.buffers\?\.depth\?\.getReversed\?\.\(\) === true;/.test(ap) &&
    /if \(reversedZ\) _syncFxNearFar\(activeCamera\);/.test(ap));
  const doc = src("docs/url-flags.md");
  check("docs/url-flags.md: reversedZ row (opt-in, default off) + §0 adjudication row",
    /^\| `reversedZ` \| `on` \| \*\*off\*\*/m.test(doc) && /^> \| `reversedZ` \|/m.test(doc));
  const h = src("harness/run-js-headless.mjs");
  check("harness registers this suite as tier 5", /\{ tier: 5, flag: "reversedZ", file: "tests\/reversed_z\.test\.mjs" \}/.test(h));
}

// Z11 takram clouds FrustumCorners (the cloud shadow cascades' camera frustum):
// it unprojected NDC z = -1 / +1 as near / far, which under three's reversed
// projection land behind the camera and on the near plane (1070 2026-10-17:
// reversed sky/clouds 17% brighter than log). The vendored class, run against
// REAL cameras, must give the same corners for a reversed and a conventional
// projection.
{
  const build = src("vendor/takram-three-clouds/build/index.js");
  const m = build.match(/var FrustumCorners = class _FrustumCorners \{[\s\S]*?\n\};\n/);
  check("takram clouds: FrustumCorners class found in the vendored build", !!m);
  if (m) {
    const FrustumCorners = new Function("Vector3", `${m[0]}\nreturn FrustumCorners;`)(THREE.Vector3);
    const mk = (reversed) => {
      const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
      if (reversed) cam._reversedDepth = true; // what three's setProgram does under reversedDepthBuffer
      cam.updateProjectionMatrix();
      return cam;
    };
    const cl = mk(false), cr = mk(true);
    check("real reversed camera: reversedDepth set and the projection differs", cr.reversedDepth === true &&
      Math.abs(cr.projectionMatrix.elements[10] - cl.projectionMatrix.elements[10]) > 1e-3);
    const fl = new FrustumCorners(cl, 800), fr = new FrustumCorners(cr, 800);
    let worst = 0;
    for (const k of ["near", "far"]) for (let i = 0; i < 4; i++) worst = Math.max(worst, fl[k][i].distanceTo(fr[k][i]));
    check("FrustumCorners: reversed camera corners == conventional ones (near plane 0.1 m, far clamped 800 m)",
      worst < 1e-3, `worst corner delta ${worst}`);
    check("FrustumCorners: near corners at z = -near, far corners at z = -800",
      Math.abs(fr.near[0].z + 0.1) < 1e-5 && Math.abs(fr.far[2].z + 800) < 1e-2,
      `near z ${fr.near[0].z}, far z ${fr.far[2].z}`);
  }
  const ts = src("vendor/takram-three-clouds/src/helpers/FrustumCorners.ts");
  check("takram clouds src FrustumCorners.ts carries the same reversed near/far NDC z",
    /const nearZ = reversed \? 1 : -1/.test(ts) && /const farZ = reversed \? 0 : 1/.test(ts));
}

// Z12 base-Camera renders under the reversed flip (shader_logdepth.js header
// item 8; found chasing the 2026-10-17 bright-sky A/B, which turned out to
// flip per session in log mode too — a separate mechanism). three r184's setProgram
// flips every camera it meets on a reversed buffer with an UNGUARDED
// `camera.updateProjectionMatrix()`; the base Camera has none, so the takram
// bakes that draw with `new Camera()` threw on their first draw. The cloud
// noise bases clear `needsRender` before drawing, so the four noise textures
// of the procedural path (`?cloudProcedural=on`, or the prebaked-noise load
// failing) were never generated on the reversed buffer only.
console.log("-- Z12 base-Camera renders under the reversed flip ----------------------");
{
  check("three r184's base Camera has no updateProjectionMatrix (the root cause)",
    BASE_CAMERA_UPDATE_AT_IMPORT === "undefined", BASE_CAMERA_UPDATE_AT_IMPORT);
  const flipRe = /if \( reversedDepthBuffer && camera\.reversedDepth !== true \) \{\s*camera\._reversedDepth = true;\s*camera\.updateProjectionMatrix\(\);/;
  check("three r184 setProgram flips with an unguarded updateProjectionMatrix (src + build)",
    flipRe.test(src("node_modules/three/src/renderers/WebGLRenderer.js")) &&
    flipRe.test(src("node_modules/three/build/three.module.js")));

  // A recording renderer that replays exactly that flip on every draw.
  const makeRec = (reversed) => {
    const rec = { draws: [], targets: [] };
    rec.renderer = {
      state: { buffers: { depth: { getReversed: () => reversed } } },
      setRenderTarget(rt, layer = 0) { rec.targets.push(rt ? layer : null); },
      render(mesh, camera) {
        if (reversed && camera.reversedDepth !== true) {
          camera._reversedDepth = true;
          camera.updateProjectionMatrix();
        }
        rec.draws.push(mesh.material.uniforms.layer.value);
      },
    };
    return rec;
  };

  // The vendored classes, bound to the REAL three classes their build imports.
  const build = src("vendor/takram-three-clouds/build/index.js");
  const extract = (name) => {
    const re = new RegExp(`import \\{([^}]*)\\} from "three";\\s*var ${name} = class \\{[\\s\\S]*?\\n\\};\\n`);
    const m = build.match(re);
    if (!m) return null;
    const names = [], vals = [];
    for (const part of m[1].split(",").map((t) => t.trim()).filter(Boolean)) {
      const [orig, alias = orig] = part.split(/\s+as\s+/);
      names.push(alias); vals.push(THREE[orig]);
    }
    const body = m[0].slice(m[0].indexOf(`var ${name} =`));
    return new Function(...names, `${body}\nreturn ${name};`)(...vals);
  };
  const P3 = extract("Procedural3DTextureBase");
  const P2 = extract("ProceduralTextureBase");
  check("takram clouds: Procedural3DTextureBase + ProceduralTextureBase found, both draw with a base `new Camera()`",
    !!P3 && !!P2 && new P3({ size: 2, fragmentShader: "" }).camera.constructor === THREE.Camera &&
    new P2({ size: 2, fragmentShader: "" }).camera.constructor === THREE.Camera);

  if (P3 && P2) {
    const SIZE = 4;
    const run = (Base, reversed) => {
      const tex = new Base({ size: SIZE, fragmentShader: "" });
      const rec = makeRec(reversed);
      let threw = null;
      for (let frame = 0; frame < 3; frame++) {
        try { tex.render(rec.renderer, 1 / 60); } catch (e) { threw ??= e; }
      }
      return { tex, rec, threw };
    };

    // Unfixed: the camera method deleted == the import-time r184 base Camera.
    const proto = THREE.Camera.prototype;
    const saved = Object.getOwnPropertyDescriptor(proto, "updateProjectionMatrix");
    if (saved) delete proto.updateProjectionMatrix;
    let u3, u2, l3, l2;
    try {
      u3 = run(P3, true); u2 = run(P2, true);
      l3 = run(P3, false); l2 = run(P2, false);
    } finally {
      if (saved) Object.defineProperty(proto, "updateProjectionMatrix", saved);
    }
    check("UNFIXED reversed: the 3D noise bake throws a TypeError on its first draw",
      u3.threw instanceof TypeError && /updateProjectionMatrix/.test(u3.threw.message), String(u3.threw));
    check("UNFIXED reversed: needsRender already false -> 0 of the layers ever drawn (texture never generated)",
      u3.tex.needsRender === false && u3.rec.draws.length === 0 && u2.rec.draws.length === 0 &&
      u2.threw instanceof TypeError, `3D draws ${u3.rec.draws.length}, 2D draws ${u2.rec.draws.length}`);
    check("log buffer: no flip, every layer drawn once (3D: size layers, 2D: one)",
      !l3.threw && !l2.threw && l3.rec.draws.length === SIZE && l2.rec.draws.length === 1);

    // Fixed: installReversedZ on a reversed renderer gives the base Camera a no-op.
    const rz = Z.installReversedZ(THREE, makeRec(true).renderer);
    check("installReversedZ: baseCameraFix on a reversed renderer", rz.installed && rz.baseCameraFix === true, JSON.stringify(rz));
    const f3 = run(P3, true), f2 = run(P2, true);
    check("FIXED reversed: no throw, the same layers in the same order as the log buffer",
      !f3.threw && !f2.threw && JSON.stringify(f3.rec.draws) === JSON.stringify(l3.rec.draws) &&
      JSON.stringify(f2.rec.draws) === JSON.stringify(l2.rec.draws) &&
      JSON.stringify(f3.rec.targets) === JSON.stringify(l3.rec.targets), JSON.stringify(f3.rec.draws));
    check("FIXED reversed: the bake camera is flipped once and its identity matrix kept",
      f3.tex.camera.reversedDepth === true && f3.tex.camera.projectionMatrix.equals(new THREE.Matrix4()));
  }

  // The no-op leaves every matrix alone and no subclass resolves to it.
  const cam = new THREE.Camera();
  cam.projectionMatrix.makePerspective(-1, 1, 1, -1, 0.5, 100);
  const before = cam.projectionMatrix.clone();
  cam._reversedDepth = true;
  cam.updateProjectionMatrix();
  check("base Camera no-op keeps a user-set projection matrix",
    cam.projectionMatrix.equals(before) && typeof THREE.Camera.prototype.updateProjectionMatrix === "function");
  check("Perspective / Orthographic / Array cameras keep their own updateProjectionMatrix",
    THREE.PerspectiveCamera.prototype.updateProjectionMatrix !== THREE.Camera.prototype.updateProjectionMatrix &&
    THREE.OrthographicCamera.prototype.updateProjectionMatrix !== THREE.Camera.prototype.updateProjectionMatrix &&
    new THREE.ArrayCamera().updateProjectionMatrix === THREE.PerspectiveCamera.prototype.updateProjectionMatrix);
  const fnBefore = THREE.Camera.prototype.updateProjectionMatrix;
  const rzAgain = Z.installReversedZ(THREE, makeRec(true).renderer);
  check("a second install keeps the same no-op (idempotent)",
    rzAgain.baseCameraFix === true && THREE.Camera.prototype.updateProjectionMatrix === fnBefore);
  const offRz = Z.installReversedZ(THREE, makeRec(false).renderer);
  check("log renderer: installReversedZ installs nothing (baseCameraFix false)",
    offRz.installed === false && offRz.baseCameraFix === false);

  // The atmosphere LUT bake draws the same way (takram PrecomputedTexturesGenerator).
  const atm = src("vendor/takram/three-atmosphere.js");
  check("takram atmosphere: the LUT generator renders with a base Camera (`Camera as St`, `this.camera = new St()`)",
    /\bCamera as St\b/.test(atm) && /this\.camera = new St\(\), this\.updating = false/.test(atm));

  // Wiring: the clouds define set at adoption, the boot log + diag.
  const ap = src("scene3d/atmosphere_pipeline.js");
  check("pipeline: USE_REVERSED_DEPTH_BUFFER set on the adopted CloudsMaterial (reversed renderer only)",
    /if \(cloudsMainAdopted && renderer\.state\?\.buffers\?\.depth\?\.getReversed\?\.\(\) === true\) \{[\s\S]{0,200}cm\.defines\.USE_REVERSED_DEPTH_BUFFER = "1";/.test(ap));
  const ix = src("scene3d/index.js");
  check("index.js: boot log + __depthMode carry baseCameraFix; window.__reversedZDiag installed",
    /baseCameraFix=\$\{_rz\.baseCameraFix\}/.test(ix) && /baseCameraFix: _rzFixes\.baseCameraFix/.test(ix) &&
    /window\.__reversedZDiag = \(\) => reversedZDiagSnapshot\(/.test(ix));

  // window.__reversedZDiag's snapshot on stubs: the discriminators it reports.
  const m = build.match(/var FrustumCorners = class _FrustumCorners \{[\s\S]*?\n\};\n/);
  const FrustumCorners = m ? new Function("Vector3", `${m[0]}\nreturn FrustumCorners;`)(THREE.Vector3) : null;
  const mainCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  mainCam._reversedDepth = true;
  mainCam.updateProjectionMatrix();
  const cm = { defines: { USE_REVERSED_DEPTH_BUFFER: "1" }, uniforms: { depthBuffer: { value: {} } } };
  const never = { needsRender: false, camera: new THREE.Camera(), renderTarget: { width: 512, height: 512 } };
  const snap = Z.reversedZDiagSnapshot({
    renderer: {
      state: { buffers: { depth: { getReversed: () => true } } },
      capabilities: { logarithmicDepthBuffer: false },
      autoClear: false,
      properties: { get: (o) => (o === cm ? { currentProgram: { cacheKey: "x,USE_REVERSED_DEPTH_BUFFER,y" } } : {}) },
    },
    cloudOverlay: {
      mainPassActive: true, _proceduralTextures: true, _prebakedLoaded: false, lastError: "prebake load failed: x",
      volume: { effect: {
        camera: mainCam, frame: 42, cloudsPass: { currentMaterial: cm },
        proceduralLocalWeather: never,
        shadowMaps: FrustumCorners ? { far: 800, cameraFrustum: new FrustumCorners() } : null,
      } },
    },
    atmosphereRuntime: { ready: true, source: "load", plan: "default", loadTimedOut: true, generator: {}, error: null },
    Camera: THREE.Camera,
    readRT: () => new Uint8Array(4),
  });
  check("__reversedZDiag: depth mode, LUT source / timeout / bake attempt, noise source + never-generated texel",
    snap.reversed === true && snap.logarithmic === false && snap.baseCameraUpdate === true &&
    snap.lut.source === "load" && snap.lut.loadTimedOut === true && snap.lut.bakeAttempted === true &&
    snap.clouds.noise === "procedural" && snap.clouds.prebakedLoaded === false &&
    snap.clouds.procedural.localWeather.needsRender === false &&
    JSON.stringify(snap.clouds.procedural.localWeather.centreTexel) === "[0,0,0,0]", JSON.stringify(snap));
  check("__reversedZDiag: clouds define + program both reversed, depth bound, cascades start at -near",
    snap.clouds.definesReversed && !snap.clouds.definesLog && snap.clouds.programReversed === true &&
    snap.clouds.depthBufferBound && snap.clouds.cameraReversed === true &&
    (!FrustumCorners || (snap.clouds.frustumCornersReversedAware && Math.abs(snap.clouds.cascadeNearZ + 0.1) < 1e-5)),
    JSON.stringify(snap.clouds));
  const empty = Z.reversedZDiagSnapshot({});
  check("__reversedZDiag: no renderer / overlay / runtime -> nulls, never throws",
    empty.reversed === false && empty.lut === null && empty.clouds === null);
}

console.log(`\nreversed z: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
