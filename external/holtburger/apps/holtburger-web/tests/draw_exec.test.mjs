// tests/draw_exec.test.mjs — `?drawExec` (scene3d/draw_exec.js, stage 3 S3.1) IDENTITY SUITE.
//
// The executor draws proven-stable static draws itself instead of letting three's
// renderBufferDirect (and batched_runs / skip_empty_multidraw / async_link_guard)
// re-derive them. Its only acceptance bar is EXACTNESS: the GL command stream must be
// the one three + our wrappers issue today. This suite proves it in node:
//   * three r184's real WebGLRenderer over tests/helpers/fake_webgl2.mjs, with every
//     production renderer patch installed in scene3d/index.js order — reversed-Z
//     (fake EXT_clip_control), the light-UBO chunks + uniform_bind_patch (texUnitPin,
//     lightUploadOnce, lightUbo), the program sort with a punch phase, depth bands
//     (one scenario), the BatchedMesh colorTexture fix, async_link_guard,
//     bmIndirectPerCamera, skip_empty_multidraw, batched_runs (chunks + wrapper + L1,
//     sorted runs) — then the executor outermost;
//   * a world with every eligible static kind (pools on the early-out with runs,
//     culled unsorted buckets with runs, sorted translucent buckets with consecutive
//     runs, unmarked atlas buckets, building batches, plain statics on shared materials,
//     mirrored statics, a multi-material static, LOD levels, terrain / far-terrain
//     ShaderMaterials, layer-1 cell statics) interleaved with ineligible draws (dynamic
//     entities, an InstancedMesh, a transparent DoubleSide two-pass mesh, an occlusion-
//     style proxy, a sky mesh outside the world roots, a nested render in a hook);
//   * scripted events: a moving camera every frame, pool add/delete (geometry growth,
//     matrices texture uploads), material needsUpdate, a map texture version bump,
//     an attribute replaced, a drawRange change, receiveShadow toggled, a light added
//     (program change), two render() calls per frame (the indoor split), an MSAA
//     target, shadows, a context loss + restore, and `__drawExec.off` toggled;
//   * a zero-instance world: draws three sets up that issue no GL call after its setup (an
//     InstancedMesh with count 0, an InstancedBufferGeometry with instanceCount 0, an emptied
//     pool with skip_empty absent) between executed statics — the VAO hand-over must still
//     bind where stock's setup binds;
//   * the comparison: EVERY GL call (with arguments; GL objects by creation id, typed
//     arrays by content, multi-draw arrays by their live window) as it reaches the fake
//     driver, flag-off arm vs each flag-on arm (`?drawExec` with rigs off, and the shipped
//     default `?drawExec` + `?drawExecRigs`; S3.2's `?drawExecRuns` arms went with its code in
//     round 3 R3-2), frame by frame. Every difference fails. Also
//     renderer.info per render() call, `__batchedRuns.frame()` totals, batched_runs /
//     skip_empty / per-camera stats, sampler-unit conflicts, UBO backing — and the
//     executor must actually have executed (fast / state-only shares).
//
// Run:  cd apps/holtburger-web && node tests/draw_exec.test.mjs
// Bench (node micro-bench, plain-object fake GL, no stream logging):
//       node tests/draw_exec.test.mjs --bench

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2 } = await import("./helpers/fake_webgl2.mjs");
const { applyBatchedMeshColorTextureFix } = await import("../scene3d/three_batchedmesh_colortexture_fix.js");
// RUNS_MODULE: a mutated copy of batched_runs.js (with DX_MODULE: an executor copy importing it)
const RUNS = await import(process.env.RUNS_MODULE || "../scene3d/batched_runs.js");
const SKIP = await import("../scene3d/skip_empty_multidraw.js");
const { installAsyncLinkGuard } = await import("../scene3d/async_link_guard.js");
const PERCAM = await import("../scene3d/batched_indirect_per_camera.js");
const { installUniformBindPatch, installLightUboChunks } = await import("../scene3d/uniform_bind_patch.js");
const { installReversedZ, depthRendererParams } = await import("../scene3d/shader_logdepth.js");
const { installDrawSortProgram, setDrawSortPhase } = await import("../scene3d/draw_sort_program.js");
const { installDepthBandSort } = await import("../scene3d/depth_band_sort.js");
// DX_MODULE: a mutated copy of the executor (the suite must FAIL on it — see the lane notes).
const DX = await import(process.env.DX_MODULE || "../scene3d/draw_exec.js");
const { __setRustFlagForTest } = await import("../scene3d/rust/scene_core.js");

if (process.env.DX_DUMP) globalThis.__dxFs = await import("node:fs");
const BENCH = process.argv.includes("--bench");
const BENCH_CALLS = process.argv.includes("--bench-calls");
const BENCH_SCENES = process.argv.includes("--bench-scenes") || BENCH_CALLS;
let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Between frames: let async_link's off-frame compiles finish (queue drained, nothing in flight).
 *  Its drain / poll are timers; a fixed sleep would let a slow compile (a loaded laptop) defer
 *  draws in one arm and not the other. */
async function settle(arm) {
  const api = arm.renderer.__hbAsyncLink;
  await sleep(12);
  for (let i = 0; i < 400 && api && (api.pending > 0 || api.stats.inFlight > 0); i++) await sleep(5);
}

// ---- global installs, index.js preInit3D order (process-wide, both arms) ----------------------
RUNS.installBatchedRunsChunks(THREE, { force: true });
installLightUboChunks(THREE, { force: true });
applyBatchedMeshColorTextureFix(THREE);
PERCAM.installBatchedIndirectPerCamera(THREE, { force: true });

// ---- serialisation of one GL call (the stream) -------------------------------------------------
function fnv(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
// DX_DUMP=<dir>: keep every long string argument (shader sources) by its serialised key, and
// write the two sides of a first stream difference there (debugging only).
const DUMP = process.env.DX_DUMP || "";
const longStrings = new Map();
function val(v) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    if (v.length <= 40) return JSON.stringify(v);
    const k = `str${v.length}#${fnv(Buffer.from(v))}`;
    if (DUMP) longStrings.set(k, v);
    return k;
  }
  if (typeof v === "function") return "fn";
  if (ArrayBuffer.isView(v)) {
    if (v.length <= 32) return `[${Array.from(v).join(",")}]`;
    return `ta${v.length}#${fnv(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`;
  }
  if (Array.isArray(v)) return `[${v.map(val).join(",")}]`;
  if (typeof v === "object") {
    if (v.__kind === "loc") return `loc:${v.name}`;
    if (v.__kind !== undefined) return `${v.__kind}#${v.__id}`;
    return `{${Object.keys(v).sort().map((k) => `${k}:${val(v[k])}`).join(",")}}`;
  }
  return String(v);
}
const win = (a, off, n) => `[${Array.from(a.subarray ? a.subarray(off, off + n) : a.slice(off, off + n)).join(",")}]`;
function ser(name, a) {
  switch (name) {
    case "multiDrawElementsWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[6])},${a[3]},${win(a[4], a[5], a[6])},${a[6]})`;
    case "multiDrawArraysWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[5])},${win(a[3], a[4], a[5])},${a[5]})`;
    case "multiDrawElementsInstancedWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[8])},${a[3]},${win(a[4], a[5], a[8])},${win(a[6], a[7], a[8])},${a[8]})`;
    case "multiDrawArraysInstancedWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[7])},${win(a[3], a[4], a[7])},${win(a[5], a[6], a[7])},${a[7]})`;
    default: {
      let s = `${name}(`;
      for (let i = 0; i < a.length; i++) s += (i ? "," : "") + val(a[i]);
      return s + ")";
    }
  }
}

/** A canvas that keeps its listeners (webgl_restore_render_patches.test.mjs). */
function restorableCanvas(gl, width = 800, height = 600) {
  const listeners = Object.create(null);
  const c = {
    width, height, style: {},
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { const a = listeners[t]; const i = a ? a.indexOf(f) : -1; if (i >= 0) a.splice(i, 1); },
    getContext() { return gl; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
    loseAndRestore() {
      for (const f of [...(listeners.webglcontextlost || [])]) f({ preventDefault() {} });
      for (const f of [...(listeners.webglcontextrestored || [])]) f({});
    },
  };
  try { gl.canvas = c; } catch (_) { /* proxy set */ }
  return c;
}

// ---- the deterministic world -------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function dataTex(n = 4) { const t = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n); t.needsUpdate = true; return t; }
function cubeUvTex() {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.image = { data: new Uint8Array(768 * 1024 * 4), width: 768, height: 1024 };
  t.mapping = THREE.CubeUVReflectionMapping;
  t.needsUpdate = true;
  return t;
}
// ?punchRetail-style phase (atmosphere_pipeline.js _punchPhase, without terrainLast).
function phaseOf(obj) {
  const c = obj.__dxPhase;
  if (c !== undefined) return c;
  let p = 0;
  for (let o = obj; o; o = o.parent) { const t = o.userData?.__punchPhase; if (t !== undefined) { p = t; break; } }
  obj.__dxPhase = p;
  return p;
}
function phaseOnlySort(a, b) {
  const pa = phaseOf(a.object), pb = phaseOf(b.object);
  if (pa !== pb) return pa - pb;
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.material.id !== b.material.id) return a.material.id - b.material.id;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

function buildWorld(o = {}) {
  const r = rng(o.seed ?? 13);
  const scene = new THREE.Scene();
  scene.environment = cubeUvTex();
  scene.fog = new THREE.Fog(0x8899aa, 50, 400);
  const lights = new THREE.Group(); lights.name = "lights"; scene.add(lights);
  lights.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(10, 20, 5);
  if (o.shadows) { sun.castShadow = true; sun.shadow.mapSize.set(32, 32); }
  lights.add(sun);
  lights.add(new THREE.HemisphereLight(0x8888ff, 0x442200, 0.3));
  for (let i = 0; i < 6; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30, 2); p.position.set(r() * 80 - 40, 3, r() * 80 - 40); lights.add(p); }
  { const s = new THREE.SpotLight(0xffffff, 1, 40, 0.5, 0.2, 2); s.position.set(5, 10, 5); lights.add(s); }

  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const grp = (n) => { const g = new THREE.Group(); g.name = n; return g; };
  const terrain = grp("terrain"), buildings = grp("buildings"), statics = grp("statics"), cells = grp("cells"), entities = grp("entities");
  worldRoot.add(terrain, buildings, statics, cells, entities);
  worldRoot.userData.__punchPhase = 2;
  terrain.userData.__punchPhase = 0;
  cells.layers.set(1);
  entities.layers.set(1);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const geoms = [box, new THREE.SphereGeometry(0.5, 6, 4), new THREE.CylinderGeometry(0.3, 0.3, 1, 6), new THREE.ConeGeometry(0.4, 1, 5)];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  const randMat = (spread = 40) => m4.compose(v.set(r() * spread * 2 - spread, r() * spread * 2 - spread, r() * 3), q.setFromEuler(e.set(0, 0, r() * 6)), s1);
  const std = (x = {}) => new THREE.MeshStandardMaterial({ map: dataTex(), normalMap: dataTex(), roughness: 0.5 + r() * 0.5, ...x });
  const bucket = (mat, n, gs, culled, sorted, mark, name, parent, colors = false) => {
    const bm = new THREE.BatchedMesh(64, 4096, 8192, mat);
    const ids = gs.map((g) => bm.addGeometry(g));
    for (let k = 0; k < n; k++) {
      const id = bm.addInstance(ids[k % ids.length]);
      bm.setMatrixAt(id, randMat());
      if (colors) bm.setColorAt(id, new THREE.Color().setHSL((k * 0.13) % 1, 0.7, 0.5));
    }
    bm.perObjectFrustumCulled = culled; bm.sortObjects = sorted; bm.frustumCulled = false; bm.matrixAutoUpdate = false;
    bm.name = name;
    if (mark) RUNS.markBatchedRuns(bm);
    parent.add(bm);
    return bm;
  };
  const W = { scene, worldRoot, terrain, buildings, statics, cells, entities, lights, sun, geoms };
  // --bench: R3's prototype population (48 pools / 8 class materials, 40 culled buckets / 12,
  // 160 plain statics / 40, 80 entities with unique materials); the suite's own world otherwise.
  const N = o.bench ? { pools: 48, classes: 8, buckets: 40, bmats: 12, singles: 160, smats: 40, ents: 80 }
    : { pools: 15, classes: 5, buckets: 8, bmats: 4, singles: 32, smats: 8, ents: 10 };
  if (o.mini) {
    // ONE lit material for every draw, no sky: the first draw of a render() continues the
    // material + program of the last draw of the one before (only the serial separates them).
    const mat = std();
    W.singles = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(geoms[i % 2], mat);
      m.position.set(r() * 20 - 10, r() * 20 - 10, r() * 2); m.receiveShadow = i % 2 === 0;
      m.updateMatrix(); m.matrixAutoUpdate = false; statics.add(m); W.singles.push(m);
    }
    W.ents = []; W.terrainMesh = { material: { uniforms: { uTime: { value: 0 } } } };
    W.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
    if (o.arrayCamera) useArrayCamera(W);
    return W;
  }
  if (o.zero) {
    // Draws three SETS UP but whose draw returns before any GL call: an InstancedMesh with
    // count 0 (an animated-scenery bucket), an InstancedBufferGeometry with instanceCount 0
    // (the grass ring) — both non-owned, worldRoot children — and an executed pool emptied
    // (no multi-draw ranges) while skip_empty is absent. They sit between executed statics
    // in the sort, and step() takes them in turns (W.zeroPlan), so each is for three frames
    // the only draw three sets up: its setup finds three's tracker already on its VAO (no
    // bind) while GL holds a static's VAO — stock's setup binds its VAO right there.
    const mats = [std(), std()];
    W.singles = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geoms[i % 3], mats[i < 3 ? 0 : 1]);
      m.position.set(i * 3 - 8, r() * 4 - 2, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false;
      m.renderOrder = 2 * i; m.name = `static-${i}`;
      statics.add(m); W.singles.push(m);
    }
    const im = new THREE.InstancedMesh(geoms[1], std(), 4);
    for (let k = 0; k < 4; k++) im.setMatrixAt(k, randMat(6));
    im.frustumCulled = false; im.renderOrder = 1; im.name = "anim-bucket-0";
    worldRoot.add(im); W.zIm = im;
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = geoms[0].index;
    for (const n of ["position", "normal", "uv"]) ig.setAttribute(n, geoms[0].attributes[n]);
    const off = new Float32Array(12); for (let k = 0; k < 12; k++) off[k] = r() * 4 - 2;
    ig.setAttribute("aOffset", new THREE.InstancedBufferAttribute(off, 3));
    ig.instanceCount = 4;
    const ring = new THREE.Mesh(ig, new THREE.ShaderMaterial({
      vertexShader: "attribute vec3 aOffset; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position + aOffset, 1.0); }",
      fragmentShader: "void main(){ gl_FragColor = vec4(0.2, 0.6, 0.2, 1.0); }",
    }));
    ring.frustumCulled = false; ring.renderOrder = 5; ring.name = "grass-ring";
    worldRoot.add(ring); W.zRing = ring;
    // (its own material: a material shared by a pool and plain statics flips async_link's stamp
    // between the two object kinds, and those draws go through three — moving its tracker)
    W.pools = [bucket(std({ side: THREE.DoubleSide }), 6, [geoms[0], geoms[2]], false, false, true, "pool-0", statics)];
    W.pools[0].renderOrder = 7;
    W.zeroPlan = (f) => (f < 3 || f >= 12 ? "all" : f < 6 ? "im" : f < 9 ? "ring" : "pool");
    W.ents = []; W.terrainMesh = { material: { uniforms: { uTime: { value: 0 } } } };
    W.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
    return W;
  }

  // statics: pools (early-out, runs), several pools per class material; two with colours.
  const classMats = []; for (let i = 0; i < N.classes; i++) classMats.push(std({ side: THREE.DoubleSide, alphaTest: i === 3 ? 0.5 : 0 }));
  W.pools = [];
  for (let p = 0; p < N.pools; p++) W.pools.push(bucket(classMats[p % N.classes], 10, [geoms[p % 4], geoms[(p + 1) % 4]], false, false, true, `pool-${p}`, statics, !o.bench && (p === 4 || p === 9)));
  // (colours only in the suite's world: one class material serving coloured and plain pools makes
  // three re-resolve the program at every alternation — production gives each kind its own
  // material (batched_material_variant.js) — which would only time three's program cache here)
  for (let p = 0; p < N.pools; p++) W.pools[p].receiveShadow = p % 2 === 0;
  // chunk buckets, per-object culled, unsorted, marked (runs per camera).
  const bMats = []; for (let i = 0; i < N.bmats; i++) bMats.push(std());
  W.buckets = [];
  for (let b = 0; b < N.buckets; b++) W.buckets.push(bucket(bMats[b % N.bmats], 8, [geoms[b % 4], geoms[(b + 2) % 4]], true, false, true, `static-batch-c-${b}`, statics));
  // sorted translucent buckets (consecutive runs), and unmarked atlas buckets.
  const tMats = [0, 1].map(() => std({ transparent: true, opacity: 0.6 }));
  W.sorted = [];
  for (let b = 0; b < 4; b++) W.sorted.push(bucket(tMats[b % 2], 8, [geoms[1], geoms[1], geoms[2]], true, true, true, `static-batch-t-${b}`, statics));
  W.atlas = [bucket(std(), 9, [geoms[0], geoms[3]], true, false, false, "stat-atlas-0", statics), bucket(std(), 6, [geoms[2]], true, false, false, "stat-atlas-1", statics)];
  // building batches (early-out, not marked) + building meshes.
  const bldMats = [std(), std()];
  W.bbatch = [];
  for (let b = 0; b < 4; b++) W.bbatch.push(bucket(bldMats[b % 2], 5, [geoms[0]], false, false, false, `building-batch-${b}`, buildings));
  W.bmeshes = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(geoms[i % 2], bldMats[i % 2].clone());
    m.position.set(r() * 30 - 15, r() * 30 - 15, 0); m.updateMatrix(); m.matrixAutoUpdate = false;
    buildings.add(m); W.bmeshes.push(m);
  }
  // static singletons on shared materials, a few mirrored (front face flips), one multi-material.
  const sMats = []; for (let i = 0; i < N.smats; i++) sMats.push(new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.8 }));
  W.singles = [];
  for (let i = 0; i < N.singles; i++) {
    const m = new THREE.Mesh(geoms[i % 4], sMats[i % N.smats]);
    m.position.set(r() * 60 - 30, r() * 60 - 30, r() * 2); m.rotation.z = r() * 6;
    if (i % 7 === 3) m.scale.set(-1, 1, 1);
    m.receiveShadow = i % 3 === 0;
    if (i === 10 || i === 11) { m.geometry = m.geometry.clone(); m.frustumCulled = false; } // own geometry, always drawn: in-place attribute / index events
    m.updateMatrix(); m.matrixAutoUpdate = false; m.name = `static-${i}`;
    statics.add(m); W.singles.push(m);
  }
  if (!o.mini && N.singles > 13) {
    // Statics whose own hooks touch WebGLState between draws: the executor's setMaterial skip
    // must see them (three re-applies the material state after them).
    const s12 = W.singles[12], s13 = W.singles[13];
    s12.frustumCulled = false; s13.frustumCulled = false;
    s12.onBeforeRender = function (renderer) { renderer.state.buffers.color.setMask(false); };
    s13.onAfterRender = function (renderer) { renderer.state.setPolygonOffset(true, 1, 1); };
    // ... and a shared material whose own onBeforeRender does (renderObject calls it per draw).
    sMats[6].onBeforeRender = function (renderer) { renderer.state.buffers.depth.setMask(false); };
  }
  {
    const g = new THREE.BoxGeometry(1, 1, 1); // 6 groups
    const m = new THREE.Mesh(g, [sMats[0], sMats[1], sMats[2], sMats[0], sMats[1], sMats[2]]);
    m.position.set(2, 2, 0); m.updateMatrix(); m.matrixAutoUpdate = false; m.name = "static-multi";
    statics.add(m); W.multi = m;
  }
  // LOD wrappers (levels switch as the camera moves).
  W.lods = [];
  for (let i = 0; i < 3; i++) {
    const lod = new THREE.LOD();
    lod.addLevel(new THREE.Mesh(geoms[1], sMats[3]), 0);
    lod.addLevel(new THREE.Mesh(geoms[0], sMats[4]), 22 + i * 4);
    lod.position.set(i * 6 - 6, -4, 0);
    statics.add(lod); W.lods.push(lod);
  }
  // terrain: a many-sampler ShaderMaterial + far patches sharing one program.
  {
    const u = {}; let decl = "", sum = "vec4 t = vec4(0.0);";
    for (let i = 0; i < 6; i++) { u[`uT${i}`] = { value: dataTex() }; decl += `uniform sampler2D uT${i};\n`; sum += `t += texture(uT${i}, vUv);`; }
    u.uTime = { value: 0 };
    const mat = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `${decl}uniform float uTime; varying vec2 vUv; void main(){ ${sum} gl_FragColor = t + uTime; }`,
    });
    const t = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), mat);
    t.position.z = -1; t.name = "terrain-surface";
    terrain.add(t); W.terrainMesh = t;
    const far = new THREE.ShaderMaterial({
      uniforms: { uC: { value: new THREE.Color(0x335533) } },
      vertexShader: "void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 uC; void main(){ gl_FragColor = vec4(uC, 1.0); }",
    });
    W.far = [];
    for (let i = 0; i < 4; i++) {
      const pm = far.clone(); pm.name = `far-terrain-${i}-0`;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), pm);
      p.position.set(i * 25 - 40, 60, -2); p.name = `far-patch-${i}`;
      terrain.add(p); W.far.push(p);
    }
  }
  if (!o.mini) {
    // A static whose ShaderMaterial reads a CUSTOM attribute (the record's generic attribute path).
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.setAttribute("aSway", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: "attribute float aSway; varying float vS; void main(){ vS = aSway; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying float vS; void main(){ gl_FragColor = vec4(vS, 0.5, 0.5, 1.0); }",
    });
    const m = new THREE.Mesh(g, mat);
    m.position.set(-4, -4, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.name = "static-sway";
    statics.add(m); W.sway = m;
    const m2 = new THREE.Mesh(g, mat); // a second draw of the same program + material (continuations)
    m2.position.set(-5, -4, 0.5); m2.updateMatrix(); m2.matrixAutoUpdate = false; m2.frustumCulled = false;
    statics.add(m2);
  }
  // cells (layer 1): cell statics + a cell pool.
  const cMats = [0, 1, 2].map(() => new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.7 }));
  W.cellStatics = [];
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(geoms[(i + 1) % 4], cMats[i % 3]);
    m.position.set(r() * 20 - 10, r() * 20 - 10, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false;
    m.layers.set(1); m.name = `cellstatic-${i}`;
    cells.add(m); W.cellStatics.push(m);
  }
  W.cellPool = bucket(classMats[1], 6, [geoms[0]], false, false, true, "pool-cell", cells);
  W.cellPool.layers.set(1);
  // ineligible: entities (dynamic, unique materials), an InstancedMesh, a two-pass mesh,
  // an occlusion-style proxy, a sky mesh outside the world roots, a nested render.
  W.ents = [];
  for (let i = 0; i < N.ents; i++) {
    const m = new THREE.Mesh(geoms[i % 4], new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.6 }));
    m.position.set(r() * 30 - 15, r() * 30 - 15, 1); m.layers.set(1); m.name = `part_${i}`;
    entities.add(m); W.ents.push(m);
  }
  {
    const im = new THREE.InstancedMesh(geoms[2], new THREE.MeshStandardMaterial({ color: 0x88aa88 }), 5);
    for (let i = 0; i < 5; i++) im.setMatrixAt(i, randMat(10));
    im.name = "anim-inst-0"; statics.add(im); W.inst = im;
    const tp = new THREE.Mesh(geoms[0], new THREE.MeshStandardMaterial({ map: dataTex(), transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
    tp.position.set(3, -3, 1); tp.name = "two-pass"; statics.add(tp); W.twoPass = tp;
    const occ = new THREE.Mesh(geoms[0], new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    occ.material.userData.__noAsyncLink = true; occ.name = "occ-proxy"; occ.position.set(-3, 3, 1);
    occ.onBeforeRender = function () { this.__q = (this.__q || 0) + 1; };
    statics.add(occ); W.occ = occ;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 8, 6), new THREE.MeshBasicMaterial({ color: 0x223344, side: THREE.BackSide, depthWrite: false }));
    sky.renderOrder = -1; sky.name = "sky"; scene.add(sky); W.sky = sky;
  }
  if (o.transmissive) {
    // A transmissive item: three renders the opaque list a second time (into its transmission target).
    const g = new THREE.Mesh(geoms[1], new THREE.MeshPhysicalMaterial({ transmission: 0.5, roughness: 0.2 }));
    g.position.set(0, 0, 2); g.name = "glass"; statics.add(g); W.glass = g;
  }
  if (o.decor) {
    // Ineligible meshes (scene root, not a static root) SHARING geometry + material with
    // statics: same program, same binding state (VAO) — they interleave with the statics in
    // the sort, so three's VAO tracker and the GL binding diverge both ways at hand-overs.
    W.decor = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(geoms[i % 2 === 0 ? 0 : 2], sMats[i % 3 === 0 ? 0 : 4]);
      m.position.set(r() * 40 - 20, r() * 6, r() * 40 - 20); m.name = `decor-${i}`;
      worldRoot.add(m); W.decor.push(m);
    }
  }
  if (o.stage) {
    // Hooks that STAGE a texture between two continuation draws of one lit material
    // (renderer.initTexture: an upload on unit 0, then an unbind — unit 0 holds the shadow map
    // under `shadows`). three's setProgram re-binds the shadow samplers on every draw, so stock
    // restores unit 0 for the hooked draw; the executor must too (review3/r5_shadow_unit_hook).
    const staged = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    const stage = (renderer) => { staged.needsUpdate = true; renderer.initTexture(staged); };
    for (let i = 2; i < W.singles.length; i += N.smats) W.singles[i].frustumCulled = false; // all of sMats[2], drawn every frame
    W.singles[18].onBeforeRender = function (renderer) { stage(renderer); };
    W.singles[26].onBeforeRender = function (renderer) { stage(renderer); };
    // ... and a pool (its batching binds are the executor's; the shadow unit is not)
    const p = W.pools[6];
    p.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      stage(renderer);
      return THREE.BatchedMesh.prototype.onBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
    };
  }
  if (o.swap) {
    // A FOREIGN mesh (a worldRoot child: never executed) sharing geometry + material with three
    // executed statics — one binding state, one VAO — whose own hooks swap the geometry's uv, its
    // index, or every attribute (fresh clones never uploaded: its re-setup only DISABLES) around
    // its own draw and put them back. three's cache sees the foreign re-setup; stock's next setup
    // for a static re-points the VAO. Sorted static, foreign, static, static (renderOrder 7–10:
    // after the world's renderOrder-0 items), so the second static continues the foreign draw
    // (review3/r4_shared_vao_swapback). Non-indexed geometry: re-points are vertexAttribPointer
    // only, fresh clones disables only (each generation bump is exercised on its own).
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const mat = new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.7 });
    const S = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(g, mat);
      m.position.set(i * 2 - 2, 6, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false;
      m.renderOrder = i === 0 ? 7 : 8 + i; m.name = `swap-static-${i}`;
      statics.add(m); return m;
    });
    const D = new THREE.Mesh(g, mat);
    D.position.set(0, 8, 0.5); D.frustumCulled = false; D.renderOrder = 8; D.name = "swap-foreign";
    worldRoot.add(D);
    const U1 = g.attributes.uv;
    const U2 = new THREE.BufferAttribute(new Float32Array(U1.array.length).map((_, k) => (k % 7) / 7), 2);
    const I2 = new THREE.BufferAttribute(new Uint16Array(g.attributes.position.count).map((_, k, a) => a.length - 1 - k), 1);
    // U2 and I2 uploaded by a foreign mesh that carries them for good (an upload is not the point)
    const gU = new THREE.BufferGeometry();
    gU.setAttribute("position", g.attributes.position); gU.setAttribute("uv", U2); gU.setIndex(I2);
    const up = new THREE.Mesh(gU, new THREE.MeshBasicMaterial({ color: 0x777777 }));
    up.position.set(4, 8, 0.5); up.frustumCulled = false; up.name = "swap-uploader";
    worldRoot.add(up);
    const sw = { mode: "none", saved: null, statics: S, D };
    D.onBeforeRender = function () {
      if (sw.mode === "uv") g.setAttribute("uv", U2);
      else if (sw.mode === "index") g.setIndex(I2);
      else if (sw.mode === "fresh") { sw.saved = { ...g.attributes }; for (const n of Object.keys(sw.saved)) g.setAttribute(n, sw.saved[n].clone()); }
    };
    D.onAfterRender = function () {
      if (sw.mode === "uv") g.setAttribute("uv", U1);
      else if (sw.mode === "index") g.setIndex(null);
      else if (sw.mode === "fresh") { for (const n of Object.keys(sw.saved)) g.setAttribute(n, sw.saved[n]); sw.saved = null; }
    };
    W.swap = sw;
    // An INTEGER position (Int32Array → vertexAttribIPointer, a GLSL3 RawShaderMaterial): the
    // foreign re-setup re-points it with the integer pointer call only.
    const rawMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: "in ivec3 position;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(vec3(position), 1.0); }",
      fragmentShader: "precision highp float;\nout vec4 hbOut;\nvoid main() { hbOut = vec4(0.4, 0.5, 0.6, 1.0); }",
    });
    const ipos = (k0) => new THREE.BufferAttribute(new Int32Array(27).map((_, k) => ((k + k0) % 5) - 2), 3);
    const gi = new THREE.BufferGeometry(); gi.setAttribute("position", ipos(0));
    const P2 = ipos(3);
    const gu2 = new THREE.BufferGeometry(); gu2.setAttribute("position", P2); // uploads P2
    const upI = new THREE.Mesh(gu2, rawMat); upI.position.set(6, 8, 0.5); upI.frustumCulled = false; upI.name = "swap-int-uploader"; worldRoot.add(upI);
    const SI = [0, 1].map((i) => { const m = new THREE.Mesh(gi, rawMat); m.position.set(i * 2 - 1, 10, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = i === 0 ? 11 : 13; m.name = `swap-int-static-${i}`; statics.add(m); return m; });
    const DI = new THREE.Mesh(gi, rawMat); DI.position.set(0, 11, 0.5); DI.frustumCulled = false; DI.renderOrder = 12; DI.name = "swap-int-foreign"; worldRoot.add(DI);
    const P1 = gi.attributes.position;
    DI.onBeforeRender = function () { if (sw.mode === "uv") gi.setAttribute("position", P2); };
    DI.onAfterRender = function () { if (sw.mode === "uv") gi.setAttribute("position", P1); };
    // A POSITION-LESS indexed static (the record refusal `noPosition` is what keeps the generation
    // exact): its state has no enabled location, so the foreign mesh's re-setup with a fresh,
    // never-uploaded position is GL-silent except its index bind — and stock's re-setup back
    // re-binds the index. Refused, it stays on three's chain.
    const gn = new THREE.BufferGeometry(); gn.setIndex([0, 1, 2, 2, 1, 3]);
    const nMat = new THREE.MeshBasicMaterial({ color: 0x556677 });
    const SN = [0, 1].map((i) => { const m = new THREE.Mesh(gn, nMat); m.position.set(i * 2 - 1, 12, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = i === 0 ? 14 : 16; m.name = `swap-nopos-static-${i}`; statics.add(m); return m; });
    const DN = new THREE.Mesh(gn, nMat); DN.position.set(0, 13, 0.5); DN.frustumCulled = false; DN.renderOrder = 15; DN.name = "swap-nopos-foreign"; worldRoot.add(DN);
    DN.onBeforeRender = function () { if (sw.mode !== "none") gn.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3)); };
    DN.onAfterRender = function () { if (sw.mode !== "none") gn.deleteAttribute("position"); };
    void SI; void SN;
  }
  if (o.proxies) {
    // occlusion_cull.js's shape: a main-scene group "occlusion-proxies", one shared box + one
    // shared MeshBasicMaterial (no colour / depth writes, transparent, DoubleSide single-pass,
    // userData.__noAsyncLink), renderOrder 2147483000 (last of the transparent list), each proxy's
    // own hooks bracketing its draw in an ANY_SAMPLES_PASSED_CONSERVATIVE query. Back to back:
    // continuations. Some proxies are hidden each frame (want*() / the visibility default).
    const grp = new THREE.Group(); grp.name = "occlusion-proxies"; grp.matrixAutoUpdate = false;
    scene.add(grp);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: true, transparent: true, side: THREE.DoubleSide, forceSinglePass: true, fog: false, toneMapped: false });
    mat.name = "occlusion-proxy"; mat.userData.__noAsyncLink = true;
    W.proxies = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(r() * 30 - 15, r() * 4, r() * 30 - 15); m.scale.set(2 + r() * 3, 2, 2 + r() * 3);
      m.updateMatrix(); m.matrixAutoUpdate = false; m.renderOrder = 2147483000; m.name = `occ-proxy-${i}`;
      const q = { query: null, open: false };
      m.onBeforeRender = function (renderer) {
        const gl = renderer.getContext();
        if (q.query === null) q.query = gl.createQuery();
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q.query); q.open = true;
      };
      m.onAfterRender = function (renderer) {
        if (!q.open) return;
        q.open = false;
        const gl = renderer.getContext();
        gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      };
      grp.add(m); W.proxies.push(m);
    }
    // A chunk bucket culled to nothing from its FIRST draw (never recorded until it shows: the
    // executor's empty shortcut, `stats.empty`, instead of a full draw every frame).
    W.emptyFromStart = bucket(std(), 6, [geoms[0], geoms[1]], true, false, true, "static-batch-c-empty", statics);
  }
  if (o.variant) {
    // Program-variant inputs setProgram re-derives per draw from material AND geometry, flipped by
    // a hook right before a continuation draw of one material (no version bump): normalMap on a
    // geometry with tangents (vertexTangents), vertexColors on one with a vec4 colour
    // (vertexAlphas). Stock re-resolves the program there (async_link defers the new combination
    // first); a record taken without them must not continue.
    const tex = dataTex();
    const mat = new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.6 });
    const g = new THREE.BoxGeometry(1, 1, 1);
    const n = g.attributes.position.count;
    g.setAttribute("tangent", new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 4).fill(0.5), 4));
    const V = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(g, mat);
      m.position.set(i * 2 - 2, -10, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false;
      m.renderOrder = 30 + i; m.name = `variant-static-${i}`;
      statics.add(m); return m;
    });
    const vr = { mode: "none" };
    V[1].onBeforeRender = function () { if (vr.mode === "tangent") mat.normalMap = tex; else if (vr.mode === "alpha") mat.vertexColors = true; };
    V[2].onAfterRender = function () { mat.normalMap = null; mat.vertexColors = false; };
    W.variant = vr;
  }
  if (o.dispose) {
    // A material DISPOSED while its two statics stay (three drops its properties; its program,
    // shared with the live material it was cloned from, and the VAOs survive). The next drawn
    // pair — a switch, then a continuation with the other receiveShadow — compares against
    // three's NEW properties object in stock; a record must not keep the dead one.
    const M = sMats[5].clone();
    const A = new THREE.Mesh(geoms[0], M), B = new THREE.Mesh(geoms[0], M);
    A.receiveShadow = true; B.receiveShadow = false;
    [A, B].forEach((m, i) => { m.position.set(i * 2 - 1, -8, 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 20 + i; m.name = `dispose-static-${i}`; statics.add(m); });
    W.dispMat = M;
  }
  if (o.nested) {
    const mini = new THREE.Scene();
    mini.add(new THREE.Mesh(geoms[0], new THREE.MeshBasicMaterial({ color: 0xff00ff })));
    const miniCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); miniCam.position.z = 3;
    const rt = new THREE.WebGLRenderTarget(8, 8);
    const host = W.ents[2];
    host.onBeforeRender = (renderer) => {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(mini, miniCam);
      renderer.setRenderTarget(prev);
    };
  }
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
  W.camera = camera;
  if (o.arrayCamera) useArrayCamera(W);
  return W;
}
// An ArrayCamera: three draws the list once per sub-camera inside ONE render() call, so the
// camera changes between draws with no serial bump in between.
function useArrayCamera(W) {
  W.subCams = [0, 1].map((i) => { const c = new THREE.PerspectiveCamera(60, 2 / 3, 0.1, 500); c.viewport = new THREE.Vector4(i * 400, 0, 400, 600); return c; });
  W.camera = new THREE.ArrayCamera(W.subCams);
  W.camera.fov = 60; W.camera.aspect = 4 / 3; W.camera.near = 0.1; W.camera.far = 500; W.camera.updateProjectionMatrix();
  // projectObject culls by the ArrayCamera's layers, renderObjects tests each sub-camera's: the
  // second sees layer 0 only, so layer-1 items in the list are skipped for it at draw time.
  W.camera.layers.enableAll(); W.subCams[0].layers.enableAll(); W.subCams[1].layers.set(0);
}

/** Per-frame changes. `arm.dx` is the executor api (null in the stock arm). */
function step(W, f, arm) {
  const cam = W.camera;
  cam.position.set(Math.sin(f * 0.35) * 14, 10 + Math.cos(f * 0.21) * 3, 22 + Math.sin(f * 0.17) * 8);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  if (W.subCams) {
    for (let i = 0; i < W.subCams.length; i++) {
      const c = W.subCams[i];
      c.position.copy(cam.position).add(new THREE.Vector3(i * 2 - 1, 0, 0));
      c.lookAt(0, 0, 0); c.updateMatrixWorld(); c.matrixWorldInverse.copy(c.matrixWorld).invert();
    }
  }
  for (let i = 0; i < W.ents.length; i++) W.ents[i].rotation.y = f * 0.1 + i;
  W.terrainMesh.material.uniforms.uTime.value = f * 0.01;
  const ev = W.events || {};
  if (f === ev.poolAdd) { const p = W.pools[2]; const id = p.addInstance(0); p.setMatrixAt(id, new THREE.Matrix4().makeTranslation(1, 2, 0)); }
  if (f === ev.matNeedsUpdate) W.pools[0].material.needsUpdate = true;
  if (f === ev.texBump) W.singles[1].material.map.needsUpdate = true;
  if (f === ev.attrReplace) { const g = W.singles[5].geometry = W.singles[5].geometry.clone(); g.setAttribute("uv", g.attributes.uv.clone()); }
  if (f === ev.drawRange) W.singles[6].geometry = (() => { const g = W.singles[6].geometry.clone(); g.setDrawRange(0, 12); return g; })();
  if (f === ev.receiveShadow) W.singles[7].receiveShadow = !W.singles[7].receiveShadow;
  if (f === ev.lightAdd) { const p = new THREE.PointLight(0x66aaff, 1, 20, 2); p.position.set(4, 4, 4); W.lights.add(p); }
  if (f === ev.poolDelete) { W.pools[3].deleteInstance(0); }
  if (f === ev.matrixMove) { W.singles[8].position.x += 0.5; W.singles[8].updateMatrix(); W.singles[8].updateMatrixWorld(true); }
  if (f === ev.uniformsNeedUpdate) W.terrainMesh.material.uniformsNeedUpdate = true;
  // Lifecycle (2026-10-26, lane X2): a shared geometry disposed while its meshes stay in the scene
  // (three deletes its buffers + every VAO of it, rebuilds them at the next draw), and a shared
  // material disposed (its programs released, its properties dropped): records must die with them.
  if (f === ev.geomDispose) W.singles[9].geometry.dispose();
  // live batching textures disposed and drawn again (three drops their properties and re-uploads
  // at the next bind): the matrices textures of one class material's whole pool run (so its
  // continuations bind them), the canonical id textures of two unmarked building batches on one
  // material (bound directly, no run texture), and a marked pool's canonical id texture
  // (batched_runs drops its run state with it)
  if (f === ev.texDispose) {
    for (const p of [2, 7, 12]) W.pools[p]._matricesTexture.dispose();
    for (const b of [1, 3]) W.bbatch[b]._indirectTexture.dispose();
    W.pools[12]._indirectTexture.dispose();
  }
  if (f === ev.clipOn) { arm.renderer.localClippingEnabled = true; arm.renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 50)]; }
  if (f === ev.clipOff) { arm.renderer.localClippingEnabled = false; arm.renderer.clippingPlanes = []; }
  if (f === ev.matDispose) W.singles[3].material.dispose();
  if (f === ev.attrInPlace) {
    const g = W.singles[10].geometry; g.setAttribute("uv", g.attributes.uv.clone());
    if (W.sway) { const h = W.sway.geometry; h.setAttribute("aSway", h.attributes.aSway.clone()); }
  }
  if (f === ev.indexBump) W.singles[11].geometry.index.needsUpdate = true;
  if (f === ev.poolAddGeometry) { const p = W.pools[1]; const gid = p.addGeometry(W.geoms[3]); p.setMatrixAt(p.addInstance(gid), new THREE.Matrix4().makeTranslation(-2, 1, 0)); }
  if (f === ev.asyncPending || f === ev.asyncPendingClear) {
    // async_link with a compile in flight for a material (its test seam): every draw of it that
    // misses the material's stamp is deferred — the executor must defer exactly those too.
    const st = arm.renderer.__hbAsyncLink.stateOf(W.pools[4].material);
    if (st) st.pending = f === ev.asyncPending;
  }
  if (f === ev.hideAll || f === ev.showAll) { const p = W.pools[5]; for (let i = 0; i < p.instanceCount; i++) p.setVisibleAt(i, f === ev.showAll); }
  if (W.swap) W.swap.mode = f < 2 ? "none" : f < 5 ? "uv" : f < 8 ? "index" : f < 11 ? "fresh" : "none";
  if (W.dispMat && f === 3) W.dispMat.dispose();
  // (each flip phase starts from records taken without any flip, so each check is exercised alone)
  if (W.variant) W.variant.mode = f >= 2 && f < 7 ? "alpha" : f >= 9 && f < 14 ? "tangent" : "none";
  if (W.proxies) for (let i = 0; i < W.proxies.length; i++) W.proxies[i].visible = ((i + f) % 4) !== 0;
  if (W.emptyFromStart) { const p = W.emptyFromStart; for (let i = 0; i < p.instanceCount; i++) p.setVisibleAt(i, f >= 5); }
  if (f === ev.skipEmptyOff) SKIP.__setSkipEmptyMultiDrawOffForTest(true); // ?skipEmptyMultiDraw's live seam (both arms)
  if (f === ev.skipEmptyOn) SKIP.__setSkipEmptyMultiDrawOffForTest(false);
  if (W.zeroPlan) {
    const ph = W.zeroPlan(f);
    W.zIm.visible = ph === "all" || ph === "im"; W.zIm.count = ph === "im" ? 0 : 4;
    W.zRing.visible = ph === "all" || ph === "ring"; W.zRing.geometry.instanceCount = ph === "ring" ? 0 : 4;
    const p = W.pools[0]; for (let i = 0; i < p.instanceCount; i++) p.setVisibleAt(i, ph !== "pool");
  }
  if (arm.dx && f === ev.offOn) arm.dx.off = true;
  if (arm.dx && f === ev.offOn + 1) arm.dx.off = false;
}

/** One arm: a fresh fake context + renderer, every production patch in index.js order. */
function makeArm(exec, sc, { log = true, rigs = false } = {}) {
  const calls = [];
  let logging = false;
  const gl = createFakeWebGL2({
    maxTextures: 16, maxCombined: 32, clipControl: true,
    onCall: log ? (name, args) => { if (logging) calls.push(ser(name, args)); } : undefined,
  });
  const canvas = restorableCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...depthRendererParams("reversed") });
  const rz = installReversedZ(THREE, renderer);
  renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
  installDrawSortProgram(renderer);
  setDrawSortPhase(renderer, phaseOf, phaseOnlySort);
  installDepthBandSort(renderer, { perOctave: sc.bands || 0 });
  if (sc.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
  const W = buildWorld(sc);
  W.events = sc.events || {};
  installAsyncLinkGuard(renderer, () => W.scene);
  if (!sc.noSkipEmpty) SKIP.installSkipEmptyMultiDraw(renderer, { force: true }); // (?skipEmptyMultiDraw=off: not installed)
  RUNS.installBatchedRuns(renderer);
  const dx = exec ? DX.installDrawExec(renderer, () => W.scene, { force: true, rigs }) : null;
  const rt = sc.msaa ? new THREE.WebGLRenderTarget(800, 600, { samples: 4, type: THREE.HalfFloatType }) : null;
  const outer = { calls: 0 };
  if (sc.outerWrapper) {
    // a diag wrapper over the chain (frame_split / the census probe do this): it must see every draw
    const inner = renderer.renderBufferDirect;
    renderer.renderBufferDirect = function outerCounted(c, s, g, m, o, gr) { outer.calls++; return inner.call(this, c, s, g, m, o, gr); };
  }
  if (sc.glWrappers) {
    // GL-level counters installed AFTER the executor (a draw-call census does this): every draw the
    // executor issues must reach them — on the context and on WEBGL_multi_draw's instanced calls.
    outer.gl = 0;
    for (const n of ["drawElements", "drawArrays"]) {
      const g0 = gl[n];
      gl[n] = function () { outer.gl++; return g0.apply(this, arguments); };
    }
    const mdx = renderer.extensions.get("WEBGL_multi_draw"); // (a getExtension both arms issue here)
    for (const n of ["multiDrawElementsInstancedWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysWEBGL"]) {
      const e0 = mdx[n];
      mdx[n] = function () { outer.gl++; return e0.apply(this, arguments); };
    }
  }
  return {
    gl, canvas, renderer, W, dx, rt, rz, calls, outer,
    startLog() { calls.length = 0; logging = true; },
    stopLog() { logging = false; return calls.slice(); },
  };
}

/** Render one frame (one or two passes) and return its per-render counters. */
function renderFrame(arm, sc) {
  const { renderer, W } = arm;
  const out = [];
  if (arm.rt) renderer.setRenderTarget(arm.rt);
  if (sc.multiTarget) {
    arm.rts ||= [new THREE.WebGLRenderTarget(64, 48), new THREE.WebGLRenderTarget(64, 48)];
    for (const t of [arm.rts[0], arm.rts[1], null]) {
      renderer.setRenderTarget(t);
      renderer.render(W.scene, W.camera);
      const i = renderer.info.render;
      out.push(`calls=${i.calls} tri=${i.triangles} | ${JSON.stringify(RUNS.batchedRunsFrameTotals())}`);
    }
    renderer.setRenderTarget(null);
    return out;
  }
  if (sc.override) {
    // pass 1: the scene with an override material (a depth-style prepass), pass 2: normal
    arm.overrideMat ||= new THREE.MeshDepthMaterial();
    for (let p = 0; p < 2; p++) {
      W.scene.overrideMaterial = p === 0 ? arm.overrideMat : null;
      renderer.autoClear = true;
      renderer.render(W.scene, W.camera);
      const i = renderer.info.render;
      out.push(`calls=${i.calls} tri=${i.triangles} | ${JSON.stringify(RUNS.batchedRunsFrameTotals())}`);
    }
    W.scene.overrideMaterial = null;
    return out;
  }
  const passes = sc.split ? [1, 2] : [0xffffffff];
  for (let p = 0; p < passes.length; p++) {
    W.camera.layers.mask = passes[p];
    renderer.autoClear = p === 0;
    if (p > 0) renderer.clearDepth();
    renderer.render(W.scene, W.camera);
    const i = renderer.info.render;
    out.push(`calls=${i.calls} tri=${i.triangles} pts=${i.points} lines=${i.lines} | ${JSON.stringify(RUNS.batchedRunsFrameTotals())}`);
  }
  W.camera.layers.mask = 0xffffffff;
  if (arm.rt) renderer.setRenderTarget(null);
  return out;
}

const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o[k]; return r; };
const RUN_KEYS = ["draws", "instances", "runs", "rebuilds", "uploads", "noGain", "fallbacks", "errors", "sortedDraws", "sortedInstances", "sortedRuns", "sortedNoGain", "sortedRebuilds", "sortedUploads", "stableSkips", "stablePoisons", "stableAudits", "stableAuditFails"];

/** Run one arm through the scenario; returns per-frame streams + counters + stat deltas. */
async function runArm(exec, sc, rigs = false) {
  // batched_runs keeps its frame totals and its L1 audit tick module-wide: both arms start clean.
  RUNS.__resetBatchedRunsFrameForTest();
  RUNS.__resetStableForTest();
  const runs0 = pick(RUNS.getBatchedRunsStats(), RUN_KEYS);
  const skip0 = SKIP.getSkipEmptyMultiDrawStats().skipped;
  const pc0 = PERCAM.getBatchedIndirectPerCameraStats();
  const arm = makeArm(exec, sc, { rigs });
  const frames = [];
  const quiet = (fn) => { const l = console.log; console.log = () => {}; try { fn(); } finally { console.log = l; } };
  for (let f = 0; f < sc.frames; f++) {
    step(arm.W, f, arm);
    if (f === sc.events?.restore) quiet(() => arm.canvas.loseAndRestore());
    if (f === sc.events?.resetState) arm.renderer.resetState(); // three's full state reset (forced VAO re-setup)
    arm.startLog();
    const st0 = arm.dx ? { ...arm.dx.stats } : null;
    const counters = renderFrame(arm, sc);
    if (sc.outerWrapper) counters.push(`outer renderBufferDirect calls ${arm.outer.calls}`);
    if (sc.glWrappers) counters.push(`outer GL draw calls ${arm.outer.gl}`);
    const per = arm.dx ? ["fast", "stateOnly", "full", "passThrough", "empty", "recorded"].map((k) => arm.dx.stats[k] - st0[k]).join("/") : null;
    await settle(arm); // async_link's off-frame drain + readiness poll, to completion (both arms alike)
    frames.push({ calls: arm.stopLog(), counters, per });
  }
  if (arm.dx && process.env.DX_VERBOSE) console.log(`    per frame fast/stateOnly/full/pass/empty/recorded: ${frames.map((f) => f.per).join("  ")}`);
  const runs1 = pick(RUNS.getBatchedRunsStats(), RUN_KEYS);
  const dRuns = {}; for (const k of RUN_KEYS) dRuns[k] = runs1[k] - runs0[k];
  const pc1 = PERCAM.getBatchedIndirectPerCameraStats();
  const dPc = {}; for (const k of Object.keys(pc1)) dPc[k] = pc1[k] - pc0[k];
  return {
    arm, frames, dRuns, dSkip: SKIP.getSkipEmptyMultiDrawStats().skipped - skip0, dPc,
    unitConflicts: arm.gl.__fake.unitConflicts, uboErrors: arm.gl.__fake.uboErrors,
    dxStats: arm.dx ? JSON.parse(JSON.stringify(arm.dx.stats)) : null,
  };
}

function firstStreamDiff(A, B) {
  for (let f = 0; f < A.frames.length; f++) {
    const a = A.frames[f].calls, b = B.frames[f].calls;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        if (DUMP) {
          const { writeFileSync } = globalThis.__dxFs || {};
          const keys = (s) => (s || "").match(/str\d+#[0-9a-f]+/g) || [];
          for (const [side, s] of [["stock", a[i]], ["exec", b[i]]]) for (const k of keys(s)) if (writeFileSync && longStrings.has(k)) writeFileSync(`${DUMP}/${side}-${k.replace("#", "_")}.txt`, longStrings.get(k));
        }
        const ctx = (arr) => arr.slice(Math.max(0, i - 4), i + 3).map((s, k) => `${Math.max(0, i - 4) + k === i ? ">>" : "  "} ${s === undefined ? "(end)" : s.slice(0, 160)}`).join("\n      ");
        return { frame: f, index: i, lenA: a.length, lenB: b.length, text: `frame ${f} call ${i} (stock ${a.length} calls, exec ${b.length})\n    stock:\n      ${ctx(a)}\n    exec:\n      ${ctx(b)}` };
      }
    }
    if (JSON.stringify(A.frames[f].counters) !== JSON.stringify(B.frames[f].counters)) {
      return { frame: f, index: -1, text: `frame ${f} counters: stock ${JSON.stringify(A.frames[f].counters)} vs exec ${JSON.stringify(B.frames[f].counters)}` };
    }
  }
  return null;
}

async function scenario(name, sc, expect = {}) {
  if (process.env.DX_ONLY && !name.includes(process.env.DX_ONLY)) return;
  console.log(`\nSCENARIO ${name}`);
  const A = await runArm(false, sc);
  const B = await runArm(true, sc);
  {
    // S3.6: entity rigid parts executed too (?drawExecRigs) — the shipped default (?drawExec + ?drawExecRigs).
    // (Until round 3 R3-2, 2026-10-30, this arm also ran S3.2's sentinel runs, and a third arm ran the
    // runs without rigs; ?drawExecRuns is deleted.)
    const R = await runArm(true, sc, true);
    const d4 = firstStreamDiff(A, R);
    check(`${name}: [rigs] GL stream identical to stock (entities executed: the shipped default)`, d4 === null, d4 ? d4.text : `${R.frames.reduce((s, f) => s + f.calls.length, 0)} GL calls compared`);
    check(`${name}: [rigs] batched_runs / skip_empty / per-camera stats identical`, JSON.stringify(A.dRuns) === JSON.stringify(R.dRuns) && A.dSkip === R.dSkip && JSON.stringify(A.dPc) === JSON.stringify(R.dPc));
    const c = R.dxStats;
    console.log(`    rigs arm: fast ${c.fast} stateOnly ${c.stateOnly} pass ${c.passThrough} refused ${JSON.stringify(c.refused)}`);
    check(`${name}: [rigs] no executor errors, every VAO hand-over bind at three's setup`, c.errors === 0 && c.vaoFixLate === 0, `errors ${c.errors} late fixes ${c.vaoFixLate}`);
    // (round 3 lane S) The stream checks above hold for an arm that silently ignores ?drawExecRigs
    // too (it then equals B): pin that the shipped default takes entity parts. In every scenario
    // that draws entity parts, each drawn one carries the executor's record in R and the
    // structural `notStatic` refusal in B; where the scenario executes them (all but the
    // transmissive one, see `entitiesExecuted`), R executes entity draws (its records' hits) and
    // hands fewer draws to three than B.
    const kindOf = (m) => m.__hbDx === undefined ? "undrawn" : m.__hbDx.isDxRefusal === true ? `refused:${m.__hbDx.refused}` : "record";
    const tally = (W) => { const t = {}; for (const m of W.ents || []) { const k = kindOf(m); t[k] = (t[k] || 0) + 1; } return t; };
    const tR = tally(R.arm.W), tB = tally(B.arm.W);
    if ((B.arm.W.ents || []).length - (tB.undrawn || 0) === 0) {
      console.log(`    (no entity part drawn in this scenario: the [rigs] entity checks do not apply)`);
    } else {
      check(`${name}: [rigs] entity parts are the executor's (a record each; ?drawExec alone refuses them as notStatic)`,
        (tR.record || 0) > 0 && Object.keys(tR).every((k) => k === "record" || k === "undrawn")
          && (tB["refused:notStatic"] || 0) > 0 && Object.keys(tB).every((k) => k === "refused:notStatic" || k === "undrawn"),
        `rigs ${JSON.stringify(tR)} vs exec-only ${JSON.stringify(tB)}`);
      if (expect.entitiesExecuted !== false) {
        const entHits = (W) => W.ents.reduce((s, m) => {
          for (let r = m.__hbDx; r && r.isDxRefusal !== true; r = r.next) s += r.hits || 0;
          return s;
        }, 0);
        const entsRun = (W) => W.ents.filter((m) => { for (let r = m.__hbDx; r && r.isDxRefusal !== true; r = r.next) if (r.hits > 0) return true; return false; }).length;
        const rHits = entHits(R.arm.W), bHits = entHits(B.arm.W);
        check(`${name}: [rigs] entity parts executed (not handed to three) — fewer pass-throughs than ?drawExec alone`,
          rHits > 0 && bHits === 0 && c.passThrough < B.dxStats.passThrough,
          `${entsRun(R.arm.W)}/${R.arm.W.ents.length} entity parts executed (${rHits} draws; B ${bHits}); pass-through rigs ${c.passThrough} vs exec-only ${B.dxStats.passThrough}`);
      }
    }
  }
  const d = firstStreamDiff(A, B);
  const total = A.frames.reduce((s, f) => s + f.calls.length, 0);
  check(`${name}: the GL call stream is identical, call for call, over ${sc.frames} frames`, d === null, d ? d.text : `${total} GL calls compared`);
  check(`${name}: renderer.info + __batchedRuns.frame() totals identical per render()`, d === null || d.index >= 0 ? (d === null || A.frames[d.frame].counters.join() === B.frames[d.frame].counters.join()) : false);
  check(`${name}: batched_runs stats identical`, JSON.stringify(A.dRuns) === JSON.stringify(B.dRuns), `${JSON.stringify(A.dRuns)} vs ${JSON.stringify(B.dRuns)}`);
  check(`${name}: skip_empty skips identical`, A.dSkip === B.dSkip, `${A.dSkip} vs ${B.dSkip}`);
  check(`${name}: bmIndirectPerCamera stats identical`, JSON.stringify(A.dPc) === JSON.stringify(B.dPc), `${JSON.stringify(A.dPc)} vs ${JSON.stringify(B.dPc)}`);
  check(`${name}: no sampler-unit conflict, every UBO backed (both arms)`, A.unitConflicts === 0 && B.unitConflicts === 0 && A.uboErrors === 0 && B.uboErrors === 0,
    `conflicts ${A.unitConflicts}/${B.unitConflicts} ubo ${A.uboErrors}/${B.uboErrors}`);
  const s = B.dxStats;
  const executed = s.fast + s.stateOnly;
  console.log(`    executor: draws ${s.draws} fast ${s.fast} stateOnly ${s.stateOnly} full ${s.full} pass ${s.passThrough} empty ${s.empty} recorded ${s.recorded} progChanged ${s.progChanged} vao binds/suppressed/fixes/late ${s.vaoBinds}/${s.vaoSuppressed}/${s.vaoFixes}/${s.vaoFixLate} restores ${s.restores}`);
  console.log(`    invalid ${JSON.stringify(s.invalid)}`);
  console.log(`    refused ${JSON.stringify(s.refused)}`);
  check(`${name}: the executor executed (fast + state-only ≥ ${expect.minExec ?? 0.35} of all draws)`, executed >= (expect.minExec ?? 0.35) * s.draws,
    `${executed} of ${s.draws} (${(100 * executed / s.draws).toFixed(0)}%)`);
  if (expect.minFast !== undefined) check(`${name}: continuations dominate the executed draws`, s.fast >= expect.minFast * executed, `${s.fast} fast of ${executed}`);
  check(`${name}: no executor errors`, s.errors === 0);
  // The setup hook issues every hand-over bind; the fallback triggers (first VAO-dependent call) stay idle.
  check(`${name}: every VAO hand-over bind issued at three's setup (fallback triggers idle)`, s.vaoFixLate === 0, `fixes ${s.vaoFixes}, late ${s.vaoFixLate}`);
  if (expect.fixes) check(`${name}: the VAO hand-over fix ran (three's belief ≠ GL binding was exercised)`, s.vaoFixes > 0 || s.vaoSuppressed > 0, `fixes ${s.vaoFixes} suppressed ${s.vaoSuppressed}`);
  if (expect.demoted) check(`${name}: continuations demoted by the texture epoch (a hook re-bound a unit)`, s.texDemoted > 0, `texDemoted ${s.texDemoted}`);
  // ... and none without such a hook (the epoch must not cost continuations: its snapshots sit after every bind three or the executor issue)
  if (expect.noDemotion) check(`${name}: no continuation demoted by the texture epoch (no hook re-binds a unit)`, s.texDemoted === 0, `texDemoted ${s.texDemoted}`);
  if (expect.disposed) check(`${name}: records died with their disposed VAO / material`, (s.invalid.disposed || 0) > 0, `disposed ${s.invalid.disposed || 0}`);
  if (expect.empty) check(`${name}: empty multi-draws taken by the executor's empty path`, s.empty > 0, `empty ${s.empty}`);
  if (expect.clipped) check(`${name}: draws under renderer clipping handed to three`, (s.refused.rendererClipping || 0) > 0, `rendererClipping ${s.refused.rendererClipping || 0}`);
  if (expect.proxies) {
    const px = B.arm.W.proxies || [];
    const hits = px.reduce((n, p) => n + (p.__hbDx && p.__hbDx.isDxRefusal === false ? p.__hbDx.hits : 0), 0);
    check(`${name}: the occlusion proxies are owned and executed`, px.length > 0 && px.every((p) => p.__hbDx && p.__hbDx.isDxRefusal === false) && hits > px.length, `${hits} executed draws over ${px.length} proxies`);
  }
  if (expect.vaoContent) check(`${name}: records invalidated by the VAO content generation (a foreign re-setup)`, (s.invalid.vaoContent || 0) > 0, `vaoContent ${s.invalid.vaoContent || 0}`);
  return { A, B };
}

// ================================================================================================
// --bench-scenes: frame time on controlled scenes (300 draws each), per-draw delta = (arm − stock) / 300.
//   pools      300 BatchedMesh pools on the early-out with runs, 10 class materials (continuations)
//   static     300 plain statics, 30 materials (continuations)
//   switch     300 plain statics, a material each (every draw a switch)
//   ineligible 300 entities (every draw a pass-through without ?drawExecRigs)
//   mixed      150 statics + 150 entities on the same 30 materials, interleaved by the sort
//   entities   300 entity parts on 30 materials, matrices moving every frame
//   proxies    240 statics + 60 occlusion proxies (one box, one material, query hooks, transparent)
// Arms: stock, ?drawExec (rigs off), the shipped default (?drawExec + ?drawExecRigs; `?drawExecRuns`
// and its arms were deleted in round 3 R3-2) and — DX_BASE=<executor copy> — the same default on another executor
// module (a before / after A/B in one process). Arms render in short chunks with the arm
// ORDER ROTATED; see the loop below. BENCH_ROUNDS, BENCH_CHUNK, BENCH_MODES, BENCH_ARMS override.
if (BENCH_SCENES) {
  console.log("BENCH-SCENES — frame time per draw vs stock (plain-object fake GL, hot GL bookkeeping nulled)");
  const DXB = process.env.DX_BASE ? await import(process.env.DX_BASE) : null;
  const dt = (n = 4) => { const t = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n); t.needsUpdate = true; return t; };
  const sceneArm = (mode, exec, rigs = false, mod = DX) => {
    const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 }).__fake.plain();
    const canvas = restorableCanvas(gl);
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    renderer.capabilities.maxTextures = 32;
    installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
    installDrawSortProgram(renderer);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x404040, 0.5)); scene.add(new THREE.DirectionalLight(0xffffff, 1));
    for (let i = 0; i < 4; i++) { const p = new THREE.PointLight(0xffffff, 1, 20); p.position.set(i * 3, 2, -10); scene.add(p); }
    const wr = new THREE.Group(); wr.name = "worldRoot"; scene.add(wr);
    const st = new THREE.Group(); st.name = "statics"; wr.add(st);
    const ents = new THREE.Group(); ents.name = "entities"; wr.add(ents);
    const geos = [new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(0.5, 6, 4)];
    const mats = []; for (let i = 0; i < 30; i++) mats.push(new THREE.MeshStandardMaterial({ map: dt(), roughness: 0.5 }));
    if (mode === "pools") {
      const cls = []; for (let i = 0; i < 10; i++) cls.push(new THREE.MeshStandardMaterial({ map: dt(), roughness: 0.5, side: THREE.DoubleSide }));
      const m4 = new THREE.Matrix4();
      for (let p = 0; p < 300; p++) {
        const bm = new THREE.BatchedMesh(16, 1024, 2048, cls[p % 10]);
        const g0 = bm.addGeometry(geos[0]), g1 = bm.addGeometry(geos[1]);
        for (let k = 0; k < 6; k++) bm.setMatrixAt(bm.addInstance(k & 1 ? g1 : g0), m4.makeTranslation((p % 20) - 10 + k * 0.1, ((p / 20) | 0) - 7, -20));
        bm.perObjectFrustumCulled = false; bm.sortObjects = false; bm.frustumCulled = false; bm.matrixAutoUpdate = false;
        RUNS.markBatchedRuns(bm); st.add(bm);
      }
    } else {
      const nStatic = mode === "proxies" ? 240 : 300;
      for (let i = 0; i < nStatic; i++) {
        const mat = mode === "switch" ? new THREE.MeshStandardMaterial({ map: dt(), roughness: 0.5 }) : mats[i % 30];
        const m = new THREE.Mesh(geos[i % 2], mat);
        m.position.set((i % 20) - 10, ((i / 20) | 0) - 7, -20); m.frustumCulled = false; m.updateMatrix(); m.matrixAutoUpdate = false;
        const toStatic = mode === "static" || mode === "switch" || mode === "proxies" || (mode === "mixed" && i % 2 === 0);
        if (mode === "entities") m.matrixAutoUpdate = true; // rigid parts: matrices move every frame
        (toStatic ? st : ents).add(m);
      }
      if (mode === "proxies") {
        const grp = new THREE.Group(); grp.name = "occlusion-proxies"; scene.add(grp);
        const pm = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, side: THREE.DoubleSide, forceSinglePass: true, fog: false, toneMapped: false });
        pm.userData.__noAsyncLink = true;
        for (let i = 0; i < 60; i++) {
          const m = new THREE.Mesh(geos[0], pm);
          m.position.set((i % 10) - 5, ((i / 10) | 0) - 3, -18); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 2147483000;
          const q = { query: null };
          m.onBeforeRender = function (r) { const g = r.getContext(); if (q.query === null) q.query = g.createQuery(); g.beginQuery(0x8d6a, q.query); };
          m.onAfterRender = function (r) { r.getContext().endQuery(0x8d6a); };
          grp.add(m);
        }
      }
    }
    installAsyncLinkGuard(renderer, () => scene);
    SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
    RUNS.installBatchedRuns(renderer);
    const dx = exec ? mod.installDrawExec(renderer, () => scene, { force: true, rigs }) : null;
    const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
    return { gl, renderer, scene, cam, dx, ents };
  };
  // Chunked + rotated: ROUNDS rounds; per round every arm renders CHUNK frames (arm order rotated
  // per round), so background load on a shared laptop lands on every arm alike. Per chunk: the
  // wall-clock p50 frame and the process CPU time per frame (process.cpuUsage: not inflated
  // while another process holds the core). Reported: medians over rounds (and the best wall p50).
  const ROUNDS = +(process.env.BENCH_ROUNDS || 21), CHUNK = +(process.env.BENCH_CHUNK || 40);
  const MODES = (process.env.BENCH_MODES || "pools,static,switch,ineligible,mixed,entities,proxies").split(",");
  const ARMS = (process.env.BENCH_ARMS || "stock,exec,dflt" + (DXB ? ",base" : "")).split(",");
  const med = (xs) => { const s = xs.slice().sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const make = {
    stock: (mode) => sceneArm(mode, false), exec: (mode) => sceneArm(mode, true, false), dflt: (mode) => sceneArm(mode, true, true),
    base: (mode) => sceneArm(mode, true, true, DXB),
  };
  // --bench-calls: the executor's own per-draw cost, robust on a shared laptop. An outer timer on
  // EVERY renderBufferDirect call (the same ~0.1 µs in every arm), each call filed by the path the
  // executor took (fast / stateOnly / other; stock: every call), arms in rotated chunks; reported:
  // the MEDIAN µs per call of each path over ~10^5 calls — a preemption spike moves a few calls,
  // never the median. Same scenes and arms as --bench-scenes (BENCH_MODES, BENCH_ARMS, ROUNDS, CHUNK).
  if (BENCH_CALLS) {
    // Paired: per round every arm renders CHUNK frames (order rotated); each arm's median µs per call
    // of each path in that round is kept, and arms are compared by the median over rounds of the
    // per-round difference — a load change on the shared laptop moves both arms of a round alike.
    const RND = +(process.env.BENCH_ROUNDS || 41), CH = +(process.env.BENCH_CHUNK || 8);
    console.log(`BENCH-CALLS — median µs per renderBufferDirect call, by executor path (outer timer included in every arm); ${RND} rounds x ${CH} frames, paired`);
    const medOfArr = (arr, len) => { if (len === 0) return NaN; const t = Float64Array.from(arr.subarray(0, len)).sort(); return len % 2 ? t[len >> 1] : (t[len / 2 - 1] + t[len / 2]) / 2; };
    const medList = (xs) => { const t = xs.filter((x) => !Number.isNaN(x)).sort((x, y) => x - y); return t.length === 0 ? NaN : t.length % 2 ? t[t.length >> 1] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2; };
    for (const mode of MODES) {
      const A = {};
      for (const k of ARMS) A[k] = make[k](mode);
      const keys = Object.keys(A);
      const CAP = 300 * CH + 1024;
      for (const a of Object.values(A)) {
        for (let f = 0; f < 6; f++) { a.renderer.render(a.scene, a.cam); await settle(a); }
        for (const n of ["uniform1i", "uniform1f", "uniform3f", "uniform3fv", "uniform4fv", "uniformMatrix3fv", "uniformMatrix4fv", "activeTexture", "bindTexture", "useProgram", "bufferSubData"]) a.gl[n] = function () {};
        a.gl.__fake.setCheckUnits(false);
        a.f = 0;
        for (let f = 0; f < 60; f++) a.renderer.render(a.scene, a.cam); // JIT warm-up
        const inner = a.renderer.renderBufferDirect, st = a.dx ? a.dx.stats : null;
        const buf = { fast: new Float64Array(CAP), stateOnly: new Float64Array(CAP), other: new Float64Array(CAP) };
        const n = { fast: 0, stateOnly: 0, other: 0 };
        a.calls = { buf, n, per: { fast: [], stateOnly: [], other: [] }, cnt: { fast: 0, stateOnly: 0, other: 0 } };
        a.renderer.renderBufferDirect = function benchTimer(c, sc, g, m, o, gr) {
          const f0 = st !== null ? st.fast : 0, s0 = st !== null ? st.stateOnly : 0;
          const t0 = performance.now();
          inner.call(this, c, sc, g, m, o, gr);
          const d = performance.now() - t0;
          const k = st === null ? "other" : st.fast !== f0 ? "fast" : st.stateOnly !== s0 ? "stateOnly" : "other";
          if (n[k] < CAP) buf[k][n[k]++] = d;
        };
      }
      for (let round = 0; round < RND; round++) {
        for (let j = 0; j < keys.length; j++) {
          const a = A[keys[(j + round) % keys.length]], c = a.calls;
          c.n.fast = 0; c.n.stateOnly = 0; c.n.other = 0;
          for (let i = 0; i < CH; i++, a.f++) {
            const f = a.f;
            a.cam.position.x = Math.sin(f * 0.1); a.cam.updateMatrixWorld();
            if (mode === "entities") for (let e = 0; e < a.ents.children.length; e++) a.ents.children[e].rotation.y = f * 0.05 + e;
            a.renderer.render(a.scene, a.cam);
          }
          for (const p of ["fast", "stateOnly", "other"]) { c.per[p].push(1000 * medOfArr(c.buf[p], c.n[p])); c.cnt[p] += c.n[p]; }
        }
      }
      const cells = keys.map((k) => {
        const c = A[k].calls;
        const parts = ["fast", "stateOnly", "other"].filter((p) => c.cnt[p] > 0).map((p) => `${p === "other" && k === "stock" ? "all" : p} ${medList(c.per[p]).toFixed(2)}`);
        return `${k}: ${parts.join(", ")}`;
      });
      const paired = [];
      if (A.base && A.dflt) for (const p of ["fast", "stateOnly", "other"]) {
        if (A.base.calls.cnt[p] === 0 || A.dflt.calls.cnt[p] === 0) continue;
        const d = A.base.calls.per[p].map((x, i) => x - A.dflt.calls.per[p][i]);
        paired.push(`${p} ${medList(d).toFixed(3)}`);
      }
      if (A.stock && A.dflt) {
        const d = A.stock.calls.per.other.map((x, i) => x - A.dflt.calls.per.fast[i]);
        if (A.dflt.calls.cnt.fast > 0) paired.push(`stock all − dflt fast ${medList(d).toFixed(3)}`);
      }
      console.log(`  ${mode.padEnd(10)} ${cells.join(" | ")}${paired.length ? ` || paired (base − dflt, µs/call): ${paired.join(", ")}` : ""}`);
    }
    process.exit(0);
  }
  for (const mode of MODES) {
    const A = {};
    for (const k of ARMS) A[k] = make[k](mode);
    const keys = Object.keys(A);
    for (const a of Object.values(A)) {
      for (let f = 0; f < 6; f++) { a.renderer.render(a.scene, a.cam); await settle(a); }
      for (const n of ["uniform1i", "uniform1f", "uniform3f", "uniform3fv", "uniform4fv", "uniformMatrix3fv", "uniformMatrix4fv", "activeTexture", "bindTexture", "useProgram", "bufferSubData"]) a.gl[n] = function () {};
      a.gl.__fake.setCheckUnits(false);
      a.f = 0;
      for (let f = 0; f < 60; f++) a.renderer.render(a.scene, a.cam); // JIT warm-up
    }
    const wall = {}, cpu = {}; for (const k of keys) { wall[k] = []; cpu[k] = []; }
    for (let round = 0; round < ROUNDS; round++) {
      for (let j = 0; j < keys.length; j++) {
        const k = keys[(j + round) % keys.length], a = A[k], ts = [];
        const c0 = process.cpuUsage();
        for (let i = 0; i < CHUNK; i++, a.f++) {
          const f = a.f;
          a.cam.position.x = Math.sin(f * 0.1); a.cam.updateMatrixWorld();
          if (mode === "entities") for (let e = 0; e < a.ents.children.length; e++) a.ents.children[e].rotation.y = f * 0.05 + e;
          const t0 = performance.now(); a.renderer.render(a.scene, a.cam); ts.push(performance.now() - t0);
        }
        const c1 = process.cpuUsage(c0);
        ts.sort((x, y) => x - y); wall[k].push(ts[ts.length >> 1]); cpu[k].push((c1.user + c1.system) / 1000 / CHUNK);
      }
    }
    const per = (src, k, f) => (1000 * (f(src[k]) - f(src.stock)) / 300).toFixed(2);
    const sx = (A.dflt || A.exec || A.base).dx;
    const arms = keys.filter((k) => k !== "stock").map((k) => `${k} ${med(wall[k]).toFixed(3)} ms (${per(wall, k, med)} µs/draw, cpu ${per(cpu, k, med)}, best ${per(wall, k, (x) => Math.min(...x))})`).join(" | ");
    console.log(`  ${mode.padEnd(10)} stock ${med(wall.stock).toFixed(3)} ms (cpu ${med(cpu.stock).toFixed(3)}) | ${arms}${sx ? ` | fast ${sx.stats.fast} stateOnly ${sx.stats.stateOnly} pass ${sx.stats.passThrough} empty ${sx.stats.empty}` : ""}`);
  }
  process.exit(0);
}

// ================================================================================================
// --town: a frame shaped like a town. Kinds and counts from R3's Holtburg census (§3.2: chunk
// buckets 187 draws / 41 materials, cell statics 78 / 40, fused cell surfaces 64 / 19, static
// singletons 55 / 17, entity parts 59 / 42, building surfaces 19 / 13, atlas ~23, grass 4, animated
// 4, terrain 1), plus what the laptop boot's executor stats point at: 60 occlusion proxies (R2's
// laptop count), 20 chunk buckets culled to nothing since their first draw, 30 particle
// InstancedMeshes in the main scene, a sky scene (6 meshes) drawn twice (sky pass + capture) and
// 12 post-pass quads (a scene and a render() each). Per arm (stock; the current executor at the
// shipped defaults; DX_BASE: another executor module, same defaults): the executed share, the
// census by kind, the median µs per call by path, and the frame time (rotated chunks, medians).
const TOWN = process.argv.includes("--town");
if (TOWN) {
  console.log("TOWN — a town-shaped frame (R3's Holtburg census + proxies, empty buckets, particles, sky, post)");
  const DXB = process.env.DX_BASE ? await import(process.env.DX_BASE) : null;
  const dt = (n = 4) => { const t = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n); t.needsUpdate = true; return t; };
  const townArm = (mod) => {
    const r = rng(7);
    const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32 }).__fake.plain();
    const canvas = restorableCanvas(gl);
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    renderer.capabilities.maxTextures = 32;
    installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
    installDrawSortProgram(renderer);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x8899aa, 50, 400);
    scene.add(new THREE.AmbientLight(0x404040, 0.5)); scene.add(new THREE.DirectionalLight(0xffffff, 1));
    for (let i = 0; i < 6; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30); p.position.set(r() * 60 - 30, 3, r() * 60 - 30); scene.add(p); }
    const wr = new THREE.Group(); wr.name = "worldRoot"; wr.rotation.x = -Math.PI / 2; scene.add(wr);
    const grp = (n, layer) => { const g = new THREE.Group(); g.name = n; if (layer) g.layers.set(layer); wr.add(g); return g; };
    const terrain = grp("terrain"), buildings = grp("buildings"), statics = grp("statics"), cells = grp("cells", 1), entities = grp("entities", 1);
    const geos = [new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(0.5, 6, 4), new THREE.CylinderGeometry(0.3, 0.3, 1, 6), new THREE.ConeGeometry(0.4, 1, 5)];
    const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    const place = (s = 40, z = 0) => m4.compose(v.set(r() * s * 2 - s, r() * s * 2 - s, z + r() * 3), q.setFromEuler(e.set(0, 0, r() * 6)), one);
    const std = (x = {}) => new THREE.MeshStandardMaterial({ map: dt(), roughness: 0.5 + r() * 0.5, ...x });
    const bucket = (mat, n, culled, mark, name, parent, spread = 40, z = 0) => {
      const bm = new THREE.BatchedMesh(64, 4096, 8192, mat);
      const ids = [bm.addGeometry(geos[(r() * 4) | 0]), bm.addGeometry(geos[(r() * 4) | 0])];
      for (let k = 0; k < n; k++) bm.setMatrixAt(bm.addInstance(ids[k & 1]), place(spread, z));
      bm.perObjectFrustumCulled = culled; bm.sortObjects = false; bm.frustumCulled = false; bm.matrixAutoUpdate = false; bm.name = name;
      if (mark) RUNS.markBatchedRuns(bm);
      parent.add(bm);
      return bm;
    };
    const meshes = (count, nMats, parent, prefix, layer, moving = false) => {
      const mats = []; for (let i = 0; i < nMats; i++) mats.push(std());
      const out = [];
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geos[i % 4], mats[i % nMats]);
        m.position.set(r() * 50 - 25, r() * 50 - 25, r() * 2); m.rotation.z = r() * 6;
        m.updateMatrix(); m.matrixAutoUpdate = moving; m.frustumCulled = false; m.name = `${prefix}-${i}`;
        if (layer) m.layers.set(layer);
        parent.add(m); out.push(m);
      }
      return out;
    };
    const bmats = []; for (let i = 0; i < 41; i++) bmats.push(std());
    for (let b = 0; b < 187; b++) bucket(bmats[b % 41], 8, true, true, `static-batch-c-${b}`, statics);
    for (let b = 0; b < 20; b++) bucket(bmats[b % 41], 6, true, true, `static-batch-c-far-${b}`, statics, 5, 400); // culled to nothing
    for (let b = 0; b < 23; b++) bucket(std(), 6, true, false, `stat-atlas-${b}`, statics);
    meshes(78, 40, cells, "cellstatic", 1);
    meshes(64, 19, cells, "cell-surface", 1);
    meshes(55, 17, statics, "static", 0);
    meshes(19, 13, buildings, "building-surface", 0);
    const parts = meshes(59, 42, entities, "part", 1, true);
    { const tb = bucket(new THREE.ShaderMaterial({ vertexShader: "void main(){ gl_Position = projectionMatrix * modelViewMatrix * batchingMatrix * vec4(position,1.0); }", fragmentShader: "void main(){ gl_FragColor = vec4(0.3,0.5,0.2,1.0); }" }), 4, false, false, "terrain-batch", terrain); void tb; }
    for (let i = 0; i < 4; i++) { const im = new THREE.InstancedMesh(geos[1], std(), 6); for (let k = 0; k < 6; k++) im.setMatrixAt(k, place(20)); im.name = `anim-inst-${i}`; statics.add(im); }
    for (let i = 0; i < 4; i++) {
      const ig = new THREE.InstancedBufferGeometry(); ig.index = geos[0].index; for (const n of ["position", "normal", "uv"]) ig.setAttribute(n, geos[0].attributes[n]);
      ig.setAttribute("aOffset", new THREE.InstancedBufferAttribute(new Float32Array(12).map(() => r() * 4 - 2), 3)); ig.instanceCount = 4;
      const ring = new THREE.Mesh(ig, new THREE.ShaderMaterial({ vertexShader: "attribute vec3 aOffset; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position + aOffset, 1.0); }", fragmentShader: "void main(){ gl_FragColor = vec4(0.2,0.6,0.2,1.0); }" }));
      ring.frustumCulled = false; ring.name = `grass-ring-${i}`; wr.add(ring);
    }
    { // occlusion proxies (occlusion_cull.js)
      const g = new THREE.Group(); g.name = "occlusion-proxies"; scene.add(g);
      const pm = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, side: THREE.DoubleSide, forceSinglePass: true, fog: false, toneMapped: false });
      pm.userData.__noAsyncLink = true;
      for (let i = 0; i < 60; i++) {
        const m = new THREE.Mesh(geos[0], pm); m.position.set(r() * 40 - 20, r() * 4, r() * 40 - 20); m.updateMatrix(); m.matrixAutoUpdate = false; m.frustumCulled = false; m.renderOrder = 2147483000;
        const qq = { query: null };
        m.onBeforeRender = function (rr) { const gg = rr.getContext(); if (qq.query === null) qq.query = gg.createQuery(); gg.beginQuery(0x8d6a, qq.query); };
        m.onAfterRender = function (rr) { rr.getContext().endQuery(0x8d6a); };
        g.add(m);
      }
    }
    for (let i = 0; i < 30; i++) { // particle buckets (main scene, transparent, additive, own materials)
      const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: dt(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 8);
      for (let k = 0; k < 8; k++) im.setMatrixAt(k, place(10));
      im.name = `particles-${i}`; scene.add(im);
    }
    const sky = new THREE.Scene(); sky.name = "sky_scene";
    for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(geos[1], new THREE.MeshBasicMaterial({ map: dt(), side: THREE.BackSide, depthWrite: false })); m.scale.setScalar(100 + i); m.renderOrder = i; sky.add(m); }
    const posts = [];
    for (let i = 0; i < 12; i++) {
      const ps = new THREE.Scene(); ps.name = `post-${i}`;
      ps.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: { uT: { value: dt() }, uK: { value: i } }, vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }", fragmentShader: "uniform sampler2D uT; uniform float uK; varying vec2 vUv; void main(){ gl_FragColor = texture2D(uT, vUv) * uK; }" })));
      posts.push(ps);
    }
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    installAsyncLinkGuard(renderer, () => scene);
    SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
    RUNS.installBatchedRuns(renderer);
    const dx = mod ? mod.installDrawExec(renderer, () => scene, { force: true, rigs: true }) : null; // the shipped defaults
    const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
    cam.layers.enableAll();
    const frame = (f) => {
      cam.position.set(Math.sin(f * 0.05) * 14, 10 + Math.cos(f * 0.03) * 3, 22); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
      for (let i = 0; i < parts.length; i++) parts[i].rotation.z = f * 0.05 + i;
      renderer.autoClear = true; renderer.render(sky, cam); renderer.render(sky, cam); // sky pass + sky capture
      renderer.autoClear = false; renderer.render(scene, cam);
      for (const ps of posts) renderer.render(ps, ortho);
    };
    return { gl, renderer, scene, cam, dx, frame, f: 0 };
  };
  const arms = { stock: townArm(null), exec: townArm(DX) };
  if (DXB) arms.base = townArm(DXB);
  const keys = Object.keys(arms);
  for (const a of Object.values(arms)) {
    for (let f = 0; f < 12; f++) { a.frame(a.f++); await settle(a); }
    for (const n of ["uniform1i", "uniform1f", "uniform3f", "uniform3fv", "uniform4fv", "uniformMatrix3fv", "uniformMatrix4fv", "activeTexture", "bindTexture", "useProgram", "bufferSubData"]) a.gl[n] = function () {};
    a.gl.__fake.setCheckUnits(false);
    for (let f = 0; f < 40; f++) a.frame(a.f++);
  }
  // 1. the census of the executor arms, steady state (60 frames)
  for (const k of keys) {
    const a = arms[k];
    if (!a.dx) continue;
    const s0 = { ...a.dx.stats };
    a.dx.censusStart();
    for (let f = 0; f < 60; f++) a.frame(a.f++);
    const t = a.dx.censusStop(60);
    const d = (x) => a.dx.stats[x] - s0[x];
    const draws = d("draws");
    console.log(`  [${k}] ${(draws / 60).toFixed(0)} draws/frame: fast ${(d("fast") / 60).toFixed(1)} stateOnly ${(d("stateOnly") / 60).toFixed(1)} full ${(d("full") / 60).toFixed(1)} empty ${(d("empty") / 60).toFixed(1)} pass ${((a.dx.stats.passThrough - s0.passThrough) / 60).toFixed(1)} — executed ${(100 * (d("fast") + d("stateOnly")) / draws).toFixed(1)}% (+ empty ${(100 * d("empty") / draws).toFixed(1)}%)`);
    for (const row of t.kinds) console.log(`      ${row.key.padEnd(46)} ${String(row.perFrame).padStart(6)}/f  fast ${(row.fast / 60).toFixed(1)} stateOnly ${(row.stateOnly / 60).toFixed(1)} full ${(row.full / 60).toFixed(1)} empty ${(row.empty / 60).toFixed(1)} pass ${(row.pass / 60).toFixed(1)} ${Object.keys(row.reasons).length ? JSON.stringify(Object.fromEntries(Object.entries(row.reasons).map(([kk, vv]) => [kk, +(vv / 60).toFixed(1)]))) : ""}`);
  }
  // 2. per-call medians by path + time per frame inside renderBufferDirect and in total, PAIRED:
  // per round every arm renders CHUNK frames (order rotated); arms are compared by the median over
  // rounds of the per-round difference (a load change on the shared laptop moves a round's arms alike).
  const ROUNDS = +(process.env.BENCH_ROUNDS || 41), CHUNK = +(process.env.BENCH_CHUNK || 6);
  const CAP = 800 * CHUNK + 1024;
  for (const a of Object.values(arms)) {
    const inner = a.renderer.renderBufferDirect, st = a.dx ? a.dx.stats : null;
    a.buf = { fast: new Float64Array(CAP), stateOnly: new Float64Array(CAP), other: new Float64Array(CAP) };
    a.n = { fast: 0, stateOnly: 0, other: 0 };
    a.per = { fast: [], stateOnly: [], other: [], rbd: [], wall: [] };
    a.renderer.renderBufferDirect = function townTimer(c, s, g, m, o, gr) {
      const f0 = st !== null ? st.fast : 0, s0 = st !== null ? st.stateOnly : 0;
      const t0 = performance.now();
      inner.call(this, c, s, g, m, o, gr);
      const dd = performance.now() - t0;
      const k = st === null ? "other" : st.fast !== f0 ? "fast" : st.stateOnly !== s0 ? "stateOnly" : "other";
      if (a.n[k] < CAP) a.buf[k][a.n[k]++] = dd;
    };
  }
  const medA = (arr, len) => { if (len === 0) return NaN; const t = Float64Array.from(arr.subarray(0, len)).sort(); return 1000 * t[len >> 1]; };
  const med = (xs) => { const t = xs.filter((x) => !Number.isNaN(x)).sort((x, y) => x - y); return t.length ? t[t.length >> 1] : NaN; };
  for (let round = 0; round < ROUNDS; round++) {
    for (let j = 0; j < keys.length; j++) {
      const a = arms[keys[(j + round) % keys.length]];
      a.n.fast = 0; a.n.stateOnly = 0; a.n.other = 0;
      const t0 = performance.now();
      for (let i = 0; i < CHUNK; i++) a.frame(a.f++);
      const wall = (performance.now() - t0) / CHUNK;
      let rbd = 0;
      for (const p of ["fast", "stateOnly", "other"]) { for (let i = 0; i < a.n[p]; i++) rbd += a.buf[p][i]; a.per[p].push(medA(a.buf[p], a.n[p])); }
      a.per.rbd.push(rbd / CHUNK); a.per.wall.push(wall);
    }
  }
  for (const k of keys) {
    const a = arms[k];
    console.log(`  [${k}] per frame (median of rounds): ${med(a.per.wall).toFixed(3)} ms total, ${med(a.per.rbd).toFixed(3)} ms inside renderBufferDirect; median µs/call: ${["fast", "stateOnly", "other"].filter((p) => a.per[p].some((x) => !Number.isNaN(x))).map((p) => `${p === "other" && k === "stock" ? "all" : p} ${med(a.per[p]).toFixed(2)}`).join(", ")}`);
  }
  const pair = (x, y, what) => med(arms[x].per[what].map((v, i) => v - arms[y].per[what][i]));
  console.log(`  paired, ms/frame inside renderBufferDirect (total): exec − stock ${pair("exec", "stock", "rbd").toFixed(3)} (${pair("exec", "stock", "wall").toFixed(3)})${arms.base ? `, exec − base ${pair("exec", "base", "rbd").toFixed(3)} (${pair("exec", "base", "wall").toFixed(3)}), base − stock ${pair("base", "stock", "rbd").toFixed(3)} (${pair("base", "stock", "wall").toFixed(3)})` : ""}`);
  process.exit(0);
}

if (!BENCH) {
  console.log("PART 1 — flag, premises, install");
  {
    // Defaults (2026-10-26, orchestrator): ?drawExec and ?drawExecRigs DEFAULT ON. ?drawExecRuns (S3.2
    // sentinel runs, default off) was DELETED in round 3 R3-2 (2026-10-30): exact, no measured gain.
    // Every arm below passes force / rigs explicitly, so no arm rides a default. (drawExecRuns stays in
    // FLAGS: clearing its memo lets the stale-URL check below run against an executor that still reads it.)
    const FLAGS = ["drawExec", "drawExecRigs", "drawExecRuns"];
    const clearFlags = () => { for (const n of FLAGS) __setRustFlagForTest(n, undefined); };
    /** rustFlag reads globalThis.location.search (memoised; the seam clears the memo). */
    const withSearch = (search, fn) => {
      const had = Object.prototype.hasOwnProperty.call(globalThis, "location"), prev = globalThis.location;
      globalThis.location = { search };
      clearFlags();
      try { fn(); } finally {
        if (had) globalThis.location = prev; else delete globalThis.location;
        clearFlags();
      }
    };
    clearFlags();
    check("drawExec default ON (node: no URL)", DX.drawExecEnabled() === true);
    check("drawExecRigs default ON (node: no URL)", DX.drawExecRigsEnabled() === true);
    check("drawExecRuns deleted (R3-2): the module exports no drawExecRunsEnabled", DX.drawExecRunsEnabled === undefined);
    for (const off of ["off", "0", "false", "no"]) {
      withSearch(`?drawExec=${off}&drawExecRigs=${off}`, () => check(`URL escape ?drawExec=${off} / ?drawExecRigs=${off} disarms`, DX.drawExecEnabled() === false && DX.drawExecRigsEnabled() === false));
    }
    __setRustFlagForTest("drawExec", false);
    check("rustFlag seam: drawExec off", DX.drawExecEnabled() === false);
    __setRustFlagForTest("drawExec", undefined);
    check("rustFlag seam cleared: back to the default (on)", DX.drawExecEnabled() === true);
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const src = readFileSync(require.resolve("three").replace(/[^/\\]+$/, "") + "three.module.js", "utf8");
    for (const p of DX.THREE_PREMISES) check(`premise in three.module.js: ${p.slice(0, 70)}`, src.includes(p));
    // The setup hook's premises live outside renderBufferDirect (WebGLBindingStates /
    // WebGLPrograms closures): checked here only, whitespace-normalised.
    const norm = (s) => s.replace(/\s+/g, " ");
    const nsrc = norm(src);
    check("setup premises exported", Array.isArray(DX.THREE_SETUP_PREMISES) && DX.THREE_SETUP_PREMISES.length >= 4);
    for (const p of DX.THREE_SETUP_PREMISES || []) check(`setup premise in three.module.js: ${p.slice(0, 70)}`, nsrc.includes(norm(p)));
    check("premise: setValueT1 is a named function (the executor's sampler-setter check)", /function setValueT1\( gl, v, textures \) \{/.test(src));
    check("premise: textures.setTexture2D( texture, slot ) is three's public texture bind", src.includes("this.setTexture2D = setTexture2D;"));
    check("premise: renderMultiDraw sums the counts it was handed into info.update( elementCount, mode, 1 )", src.includes("info.update( elementCount, mode, 1 );"));
    // Install refuses when off, installs under the default, refuses an unknown wrapper on top of
    // three, and walks the chain.
    const arm = makeArm(false, { frames: 0 }, { log: false });
    __setRustFlagForTest("drawExec", false);
    check("install: flag off (=off) -> null", DX.installDrawExec(arm.renderer, () => arm.W.scene) === null);
    __setRustFlagForTest("drawExec", undefined);
    {
      const armD = makeArm(false, { frames: 0 }, { log: false });
      const apiD = DX.installDrawExec(armD.renderer, () => armD.W.scene);
      check("install: the default (no URL, no force) installs", apiD !== null && apiD.installed === true);
      if (apiD && apiD.uninstall) apiD.uninstall();
    }
    const api = DX.installDrawExec(arm.renderer, () => arm.W.scene, { force: true });
    check("install: walks batched_runs > skip_empty > async_link to three", api && api.installed === true && api.stats.chain.join(">") === "batchedRuns>skipEmpty>asyncLink", api ? api.stats.chain.join(">") : "null");
    check("install: idempotent", DX.installDrawExec(arm.renderer, () => arm.W.scene, { force: true }) === api);
    check("install: outermost wrapper, tagged", arm.renderer.renderBufferDirect.__hbRbdTag === "drawExec");
    const arm2 = makeArm(false, { frames: 0 }, { log: false });
    const inner = arm2.renderer.renderBufferDirect;
    arm2.renderer.renderBufferDirect = function foreign(...a) { return inner.apply(this, a); };
    const warn = console.warn; console.warn = () => {};
    const api2 = DX.installDrawExec(arm2.renderer, () => arm2.W.scene, { force: true });
    console.warn = warn;
    check("install: an unknown wrapper in the chain -> refused, nothing wrapped", api2 && api2.installed === false && arm2.renderer.renderBufferDirect.name === "foreign", api2 && api2.reason);
    {
      // R3-2 (2026-10-30): ?drawExecRuns deleted. A stale URL (?drawExecRuns=on: old bookmarks, queue
      // files) and a stale `runs: true` install option are inert: no sentinel render item in the sorted
      // list (three's renderObjects reaches the executor once per item), three's own list.sort, no runs
      // seam or counters. The world has runs of consecutive owned opaque items (the precondition: S3.2
      // collapsed exactly those), so a live runs path cannot pass.
      const ai = makeArm(false, { frames: 0 }, { log: false });
      let apiI = null;
      withSearch("?drawExecRuns=on", () => { apiI = DX.installDrawExec(ai.renderer, () => ai.W.scene, { force: true, runs: true, rigs: true }); });
      for (let f = 0; f < 4; f++) { step(ai.W, f, ai); renderFrame(ai, {}); await settle(ai); }
      const list = ai.renderer.renderLists.get(ai.W.scene, 0);
      const op = list.opaque;
      const own = (it) => it.object.__hbDx !== undefined && it.object.__hbDx.isDxRefusal === false;
      let pairs = 0, sentinels = 0;
      for (let i = 0; i < op.length; i++) {
        if (op[i].object.__hbRun !== undefined) sentinels++;
        if (i > 0 && own(op[i - 1]) && own(op[i])) pairs++;
      }
      check("drawExecRuns deleted: a stale ?drawExecRuns=on URL + `runs: true` option form no sentinel items (one item per draw, three's own list.sort)",
        apiI !== null && apiI.installed === true && sentinels === 0 && pairs > 0 && list.sort.name !== "hbDxSortRuns",
        `${op.length} opaque items, ${pairs} consecutive owned pairs, ${sentinels} sentinels, list.sort ${list.sort.name}`);
      check("drawExecRuns deleted: no runs seam, no runs counters (api.runs, stats.runs / runItems / hookSkips)",
        apiI !== null && !("runs" in apiI) && !("runs" in apiI.stats) && !("runItems" in apiI.stats) && !("hookSkips" in apiI.stats));
      if (apiI && apiI.uninstall) apiI.uninstall();
    }
    {
      // The census seam (diag): every draw counted once, by kind and outcome; the chain restored.
      const ac = makeArm(true, { frames: 0 }, { log: false });
      const rbd0 = ac.renderer.renderBufferDirect;
      for (let f = 0; f < 3; f++) { step(ac.W, f, ac); renderFrame(ac, {}); await settle(ac); }
      ac.dx.censusStart();
      const st0 = { ...ac.dx.stats };
      for (let f = 3; f < 6; f++) { step(ac.W, f, ac); renderFrame(ac, {}); await settle(ac); }
      const t = ac.dx.censusStop(3);
      const sum = (k) => t.kinds.reduce((n, r) => n + r[k], 0);
      const pools = t.kinds.find((r) => r.key === "main|statics|pool|BM");
      check("census: every draw counted once, outcomes add up to the executor's stats", t.draws === ac.dx.stats.draws - st0.draws && sum("draws") === t.draws
        && sum("fast") === ac.dx.stats.fast - st0.fast && sum("stateOnly") === ac.dx.stats.stateOnly - st0.stateOnly,
        `${t.draws} draws, ${t.kinds.length} kinds`);
      check("census: kinds by scene / root / name / type (pools executed, entities refused without rigs)", pools !== undefined && pools.fast > 0
        && t.kinds.some((r) => r.key.startsWith("main|entities|part|M") && r.reasons.notStatic > 0), pools ? JSON.stringify(pools) : "no pool row");
      check("census: the chain is restored on stop", ac.renderer.renderBufferDirect === rbd0);
    }
    {
      // census() name tags (2026-10-29): the linear scan equals the regex it replaced on every short
      // name (where the regex is still fast), and stays linear on a name that made it backtrack.
      const OLD = /([-_.:#/ ]?(0x)?[0-9a-fA-F]*[0-9][0-9a-fA-F]*)+$/;
      const ALPHA = "ab0x19Fq-_. :#/zX";
      let seed = 12345, bad = null;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
      for (let i = 0; i < 20000 && bad === null; i++) {
        let s = "";
        for (let k = rnd(13); k > 0; k--) s += ALPHA[rnd(ALPHA.length)];
        if (DX.censusName(s) !== s.replace(OLD, "").slice(0, 40)) bad = s;
      }
      const real = ["statics-0xA9B40001", "cell-0xA9B40105-0x0200A3F1", "bucket_0x00ab12cd_3_7_12 opaque", "part 12", "occlusion-proxy#7", "", "terrain"];
      for (const s of real) if (bad === null && DX.censusName(s) !== s.replace(OLD, "").slice(0, 40)) bad = s;
      check("census: censusName equals the old regex (20,000 random names + real ones)", bad === null, bad === null ? "" : JSON.stringify(bad));
      const t0 = performance.now();
      const evil = DX.censusName("lb_" + "0123456789abcdef".repeat(16) + "x");
      const ms = performance.now() - t0;
      check("census: censusName is linear on a 260-char hex run ending in a non-match", ms < 5 && evil.length === 40, `${ms.toFixed(3)} ms`);
    }
    {
      // The cached batching binds stand in for three's own textures.setTexture2D only: once it is
      // wrapped, every BatchedMesh continuation calls the wrapper (2–3 binds), as setProgram would.
      const at = makeArm(true, { frames: 0 }, { log: false });
      for (let f = 0; f < 4; f++) { step(at.W, f, at); renderFrame(at, {}); await settle(at); }
      const tx = at.dx.__textures();
      let n = 0, bmFast = 0, bmFastWithBinds = 0;
      const s0 = tx ? tx.setTexture2D : null;
      if (tx) tx.setTexture2D = function (t, u) { n++; return s0.call(this, t, u); };
      const inner = at.renderer.renderBufferDirect;
      at.renderer.renderBufferDirect = function (c, sc, g, m, o, gr) {
        const f0 = at.dx.stats.fast, n0 = n;
        const r = inner.call(this, c, sc, g, m, o, gr);
        if (o && o.isBatchedMesh && at.dx.stats.fast !== f0) { bmFast++; if (n - n0 >= 2) bmFastWithBinds++; }
        return r;
      };
      step(at.W, 4, at); renderFrame(at, {});
      at.renderer.renderBufferDirect = inner;
      if (tx) tx.setTexture2D = s0;
      check("cached batching binds yield to a wrapped textures.setTexture2D (every BatchedMesh continuation calls it)", tx !== null && bmFast > 0 && bmFastWithBinds === bmFast, `${bmFastWithBinds} of ${bmFast} continuations`);
    }
  }

  console.log("\nPART 2 — identity: flag-off vs flag-on, the full GL stream");
  await scenario("baseline (one pass, moving camera)", { frames: 8 }, { minFast: 0.5, fixes: true });
  await scenario("events (resetState, growth, needsUpdate, uploads, attribute / drawRange / receiveShadow / matrix, light added, uniformsNeedUpdate, geometry + material dispose, off toggle)", {
    frames: 16,
    // (matDispose BEFORE lightAdd: async_link compiles a re-drawn disposed material off-frame
    // against a 500 ms WALL-CLOCK light cache, so after a light change the arms could compile for
    // different light sets depending on their timing — a test-determinism trap, not the executor)
    events: { resetState: 3, poolAdd: 4, matNeedsUpdate: 5, texBump: 6, attrReplace: 7, drawRange: 8, matDispose: 8, receiveShadow: 9, geomDispose: 9, lightAdd: 10, poolDelete: 11, matrixMove: 12, uniformsNeedUpdate: 13, offOn: 14 },
  }, { minExec: 0.25, disposed: true });
  await scenario("indoor split (two render() per frame, layers) + MSAA target", { frames: 8, split: true, msaa: true });
  await scenario("shadows (shadow pass + shadow samplers before the batching units)", { frames: 7, shadows: true }, { noDemotion: true });
  await scenario("nested render inside an onBeforeRender + depth bands", { frames: 7, nested: true, bands: 1 });
  await scenario("context loss + restore mid-session", { frames: 12, events: { restore: 6 } }, { minExec: 0.25 });
  await scenario("in-place geometry edits + an async-link compile in flight", {
    frames: 12, shadows: true, events: { attrInPlace: 4, indexBump: 5, poolAddGeometry: 6, asyncPending: 7, asyncPendingClear: 9 },
  }, { minExec: 0.3, noDemotion: true });
  await scenario("one material, three render() per frame (two targets + canvas), same camera", { frames: 8, mini: true, multiTarget: true }, { minExec: 0.5 });
  await scenario("ArrayCamera (sub-cameras inside one render())", { frames: 7, arrayCamera: true }, { minExec: 0.3 });
  await scenario("ArrayCamera over one material (a continuation would cross the sub-camera switch)", { frames: 6, mini: true, arrayCamera: true }, { minExec: 0.5 });
  // (?portalStencil renders the main scene this way. Coverage is async_link's: its off-frame
  // compile prepares each object's OWN material, never the override, so override draws of
  // kinds it has not linked stay deferred in both arms — a stock quirk, see the lane notes.)
  await scenario("scene.overrideMaterial on one of two render() per frame", { frames: 7, override: true }, { minExec: 0.25 });
  // (low coverage by design: the transmission target's output colour space gives every opaque
  // material a second program, so its records churn — exact, and no faster than three; the
  // entity parts' records churn the same way, so none executes)
  await scenario("a transmissive item (three's transmission pass re-renders the opaque list)", { frames: 7, transmissive: true }, { minExec: 0.1, entitiesExecuted: false });
  await scenario("a diag wrapper over the executor (must see every draw)", { frames: 6, outerWrapper: true });
  await scenario("shared geometry + material with ineligible meshes (VAO hand-overs), an emptied pool", {
    frames: 12, decor: true, events: { hideAll: 5, showAll: 8 },
  }, { fixes: true });
  // Zero-instance hand-overs (2026-10-26 review): three's setup runs, binds nothing (its tracker
  // is already on the object's VAO) and the draw returns before any GL call — stock binds there.
  await scenario("zero-instance draws three sets up between executed statics (InstancedMesh count 0, InstancedBufferGeometry instanceCount 0, an emptied pool, skip_empty absent)", {
    frames: 14, zero: true, noSkipEmpty: true,
  }, { minExec: 0.5, fixes: true });
  await scenario("zero-instance world with skip_empty installed (the emptied pool skipped in both arms)", { frames: 14, zero: true }, { minExec: 0.5, fixes: true });
  // Hook-driven divergences from the integration review (2026-10-26, lane X2): exact fixes.
  await scenario("shadows + hooks staging a texture between continuations of one lit material (texture epoch)", { frames: 8, shadows: true, stage: true }, { demoted: true });
  await scenario("a foreign mesh sharing geometry + material swaps uv / index / every attribute around its draw (VAO content generation)", { frames: 13, swap: true }, { vaoContent: true });
  await scenario("a material disposed while its statics stay (a record must drop the dead properties)", { frames: 8, dispose: true }, { disposed: true });
  // Fast-path cuts (2026-10-26, lane X2): what each one leans on, exercised.
  await scenario("hooks flip normalMap (tangents) / vertexColors (vec4 colour) right before a continuation", { frames: 16, variant: true }, {});
  await scenario("batching textures disposed and drawn again, renderer clipping on for three frames, GL-level wrappers over the executor", {
    frames: 12, glWrappers: true, events: { texDispose: 4, clipOn: 7, clipOff: 10, poolAdd: 3, poolDelete: 5 },
  }, { clipped: true });
  // Coverage (2026-10-26, lane X2): kinds the town draws that the executor now owns.
  await scenario("occlusion proxies (one box + one material, query hooks, end of the transparent list) + empty buckets (one never recorded) + skip_empty's off seam", {
    frames: 10, proxies: true, events: { hideAll: 3, showAll: 7, skipEmptyOff: 4, skipEmptyOn: 5 },
  }, { proxies: true, empty: true });

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// ================================================================================================
// --bench: node micro-bench (laptop, V8). The fake GL as a plain object (`__fake.plain()`, no
// Proxy trap per GL property) without the stream log, and — after warm-up — its per-call
// bookkeeping replaced by no-ops for the hot uniform / texture / program calls (as R3's
// prototype did), so the numbers are three + wrappers + executor JS. The world is R3's
// prototype shape (48 pools on 8 class materials, 40 culled buckets on 12, 160 plain statics on
// 40, 80 entities with unique materials) plus this suite's kinds. Per-kind µs from an outer
// timer on renderBufferDirect (it includes the timer itself, ~0.1 µs, in both arms).
{
  console.log("BENCH — node micro-bench (plain-object fake GL, hot GL bookkeeping nulled)");
  const FR = 150;
  const sc = { frames: 0, bench: true };
  const mkPlainArm = (exec, rigs = false) => {
    const proxyGl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32, clipControl: true });
    const gl = proxyGl.__fake.plain();
    const canvas = restorableCanvas(gl);
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...depthRendererParams("reversed") });
    installReversedZ(THREE, renderer);
    renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
    installDrawSortProgram(renderer);
    setDrawSortPhase(renderer, phaseOf, phaseOnlySort);
    installDepthBandSort(renderer, { perOctave: 0 });
    const W = buildWorld(sc);
    W.events = {};
    installAsyncLinkGuard(renderer, () => W.scene);
    SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
    RUNS.installBatchedRuns(renderer);
    // (rigs explicit: ?drawExecRigs is DEFAULT ON, so an arm that omitted it would execute entities)
    const dx = exec ? DX.installDrawExec(renderer, () => W.scene, { force: true, rigs }) : null;
    return { gl, canvas, renderer, W, dx, rt: null };
  };
  const nullGl = (gl) => {
    const nop = function () {};
    for (const n of ["uniform1i", "uniform2i", "uniform3i", "uniform4i", "uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform1fv", "uniform2fv",
      "uniform3fv", "uniform4fv", "uniform1iv", "uniformMatrix3fv", "uniformMatrix4fv", "uniformMatrix2fv", "activeTexture", "bindTexture",
      "useProgram", "bufferSubData"]) gl[n] = nop;
    gl.__fake.setCheckUnits(false);
  };
  const arms = { stock: mkPlainArm(false), exec: mkPlainArm(true) };
  for (const a of Object.values(arms)) { for (let f = 0; f < 6; f++) { step(a.W, f, a); renderFrame(a, sc); await sleep(25); } nullGl(a.gl); }
  // eligibility the way the executor decided it (same world, same order in both arms)
  {
    const ex = [], st = [];
    arms.exec.W.scene.traverse((o) => { if (o.isMesh) ex.push(o); });
    arms.stock.W.scene.traverse((o) => { if (o.isMesh) st.push(o); });
    for (let i = 0; i < ex.length; i++) { const r = ex[i].__hbDx; st[i].__dxBenchStatic = r !== undefined && r.isDxRefusal !== true; }
  }
  const timeArm = (a, n, f0) => {
    const ts = [];
    for (let f = 0; f < n; f++) { step(a.W, f0 + f, a); const t0 = performance.now(); renderFrame(a, sc); ts.push(performance.now() - t0); }
    ts.sort((x, y) => x - y);
    return ts[ts.length >> 1];
  };
  const res = { stock: [], exec: [] };
  for (let rep = 0; rep < 7; rep++) for (const k of ["stock", "exec"]) res[k].push(timeArm(arms[k], FR, 100 + rep * FR));
  const perKind = (a, exec, f0 = 2000) => {
    const R = a.renderer, inner = R.renderBufferDirect, props = R.properties;
    const acc = Object.create(null);
    let lm = null, lp = null;
    const st = exec ? a.dx.stats : null;
    let draws = 0;
    R.renderBufferDirect = function (c, s, g, m, o, gr) {
      const f0 = st ? st.fast : 0, s0 = st ? st.stateOnly : 0, u0 = st ? st.full : 0;
      const p0 = !exec && s === a.W.scene && m ? props.get(m).currentProgram : null;
      const t0 = performance.now();
      inner.call(this, c, s, g, m, o, gr);
      const dt = performance.now() - t0;
      let k;
      if (exec) k = st.fast !== f0 ? "fast" : st.stateOnly !== s0 ? "stateOnly" : st.full !== u0 ? "full" : "pass";
      else k = o.__dxBenchStatic !== true ? "pass" : (m === lm && p0 === lp) ? "cont" : "switch";
      if (k !== "pass") k += o.isBatchedMesh ? ":bm" : ":mesh";
      (acc[k] ||= [0, 0]); acc[k][0] += dt; acc[k][1]++;
      draws++;
      lm = m; lp = s === a.W.scene && m ? props.get(m).currentProgram : null;
    };
    for (let f = 0; f < FR; f++) { step(a.W, f0 + f, a); renderFrame(a, sc); }
    R.renderBufferDirect = inner;
    return { acc, dpf: draws / FR };
  };
  for (const k of ["stock", "exec"]) console.log(`  ${k.padEnd(5)} render() p50 ms ${res[k].map((x) => x.toFixed(3)).join(" / ")}  best ${Math.min(...res[k]).toFixed(3)}`);
  // per kind: 3 interleaved reps per arm, the best µs/draw of each kind
  const bestK = { stock: Object.create(null), exec: Object.create(null) };
  let dpf = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (const [name, exec] of [["stock", false], ["exec", true]]) {
      const r = perKind(arms[name], exec, 2000 + rep * FR);
      dpf = r.dpf;
      for (const [k, [ms, n]] of Object.entries(r.acc)) {
        const us = 1000 * ms / n, b = bestK[name][k];
        if (b === undefined || us < b.us) bestK[name][k] = { us, perFrame: n / FR };
      }
    }
  }
  for (const name of ["stock", "exec"]) {
    for (const [k, b] of Object.entries(bestK[name]).sort()) console.log(`  ${name.padEnd(5)} ${k.padEnd(14)} ${b.perFrame.toFixed(1).padStart(6)} draws/frame  ${b.us.toFixed(2).padStart(6)} µs/draw (best of 3)  ${(b.us * b.perFrame / 1000).toFixed(3)} ms/frame`);
  }
  const best = (k) => Math.min(...res[k]);
  console.log(`  ${dpf.toFixed(0)} renderBufferDirect calls/frame; render() best-of-7 p50: stock ${best("stock").toFixed(3)} ms, exec ${best("exec").toFixed(3)} ms (${(100 * (best("exec") / best("stock") - 1)).toFixed(1)}%)`);
  const s = arms.exec.dx.stats;
  console.log(`  exec arm totals: fast ${s.fast} stateOnly ${s.stateOnly} full ${s.full} pass ${s.passThrough} progChanged ${s.progChanged} recorded ${s.recorded} refused ${JSON.stringify(s.refused)} invalid ${JSON.stringify(s.invalid)}`);
  process.exit(0);
}
