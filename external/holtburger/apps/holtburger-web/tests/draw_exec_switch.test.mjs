// tests/draw_exec_switch.test.mjs — `?drawExecSwitch` (scene3d/draw_exec.js SAME-PROGRAM SWITCH,
// round 3, 2026-10-31) IDENTITY SUITE.
//
// The executor does three r184's setProgram + state.setMaterial itself for a SWITCH whose material
// resolves to the program three has bound (same program, same camera, same render call). Its only
// bar is EXACTNESS: the GL command stream with ?drawExecSwitch on must be stock three's, call for
// call, frame by frame. This suite proves it in node, the machinery of tests/draw_exec.test.mjs (three
// r184's real WebGLRenderer over tests/helpers/fake_webgl2.mjs, every production renderer patch in
// scene3d/index.js order — reversed-Z, uniform_bind_patch (texUnitPin, lightUploadOnce, lightUbo),
// the program sort, the BatchedMesh colorTexture fix, async_link_guard, bmIndirectPerCamera,
// skip_empty_multidraw, batched_runs — then the executor outermost), on SWITCH-HEAVY worlds:
//   * many materials sharing one program per family — MeshStandard (maps, colours, emissive,
//     roughness / metalness, opacity), normal-mapped Standard (normalScale), alphaTest Standard,
//     Standard with emissive / ao / light maps, Basic, Lambert, Phong, Toon, ShaderMaterial clones
//     (lights + fog, a non-caching float-array uniform, a texture uniform), onBeforeCompile-patched
//     Standard (extra uniforms, a custom program key), the APP'S CACHE MATERIALS
//     (materials.js MaterialCache._materialFromFlags + the light-clamp / static-depth-bias
//     onBeforeCompile chain keyed by _patchSetCacheKey), BatchedMesh pools on distinct materials;
//   * fog + ambient / directional / hemisphere / point / spot lights, no environment (three's
//     PMREM state is refused) except in the frames that set one;
//   * events between frames: colours, opacity, emissive intensity, alphaTest, a map swapped without
//     needsUpdate, a map upload due, map offset / repeat (the transform uniform), normalScale,
//     material.needsUpdate (same program: three's getProgram early-out), toneMappingExposure, fog
//     colour / far, the fog OBJECT replaced, receiveShadow toggles, a ShaderMaterial uniform value
//     mutated and its CONTAINER replaced, a patched material's stashed shader.uniforms container
//     replaced, a light added (programs move), scene.environment set and cleared;
//   * inside the frame: a hook mutating a later material's colour and staging a map upload (upload
//     due mid-frame), a hook bumping the switched material's version between its switch and a
//     same-program hand-over of it;
//   * three's MATERIAL TRACKER: foreign (non-owned) meshes sharing materials with switched statics,
//     ordered so the hand-over draws three's tracked material (`switchSyncsTracked`) or the switched
//     one (`switchSyncsOwn`), a static first drawn mid-session inside a switched run;
//   * render shapes: two render() per frame (layers split) into an MSAA target, two cameras per
//     frame, an ArrayCamera, a nested render + setRenderTarget in a hook, resetState and a context
//     loss + restore, shadows on (the switch refuses shadow samplers), the executor installed after
//     programs were linked (refused as unknown programs).
// Every scenario compares the stock arm (no executor) with the switch arm (?drawExec + ?drawExecRigs
// + ?drawExecSwitch): every GL call with its arguments, renderer.info + __batchedRuns.frame() per
// render(), batched_runs / skip_empty / per-camera stats; and requires the switch to have run
// (same-program switches > 0, the scenario's own path counters). On the pre-change executor every
// scenario check fails (no switch path), see the lane report.
//
// Run:  cd apps/holtburger-web && node tests/draw_exec_switch.test.mjs
//       DX_MODULE=<executor copy> node tests/draw_exec_switch.test.mjs   (a mutated / older executor)
//       DX_ONLY=<substring>  (one scenario)

globalThis.window ??= {};
window.location ??= { search: "" };
window.requestAnimationFrame ??= () => 0;

const THREE = await import("three");
const { createFakeWebGL2 } = await import("./helpers/fake_webgl2.mjs");
const { applyBatchedMeshColorTextureFix } = await import("../scene3d/three_batchedmesh_colortexture_fix.js");
const RUNS = await import("../scene3d/batched_runs.js");
const SKIP = await import("../scene3d/skip_empty_multidraw.js");
const { installAsyncLinkGuard } = await import("../scene3d/async_link_guard.js");
const PERCAM = await import("../scene3d/batched_indirect_per_camera.js");
const { installUniformBindPatch, installLightUboChunks } = await import("../scene3d/uniform_bind_patch.js");
const { installReversedZ, depthRendererParams } = await import("../scene3d/shader_logdepth.js");
const { installDrawSortProgram } = await import("../scene3d/draw_sort_program.js");
const DX = await import(process.env.DX_MODULE || "../scene3d/draw_exec.js");
const { __setRustFlagForTest } = await import("../scene3d/rust/scene_core.js");
const M = await import("../scene3d/materials.js");
const ADAPTER = await import("../scene3d/adapter.js");
const fs = await import("node:fs");

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ---- serialisation of one GL call (as tests/draw_exec.test.mjs) ---------------------------------
function fnv(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function val(v) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length <= 40 ? JSON.stringify(v) : `str${v.length}#${fnv(Buffer.from(v))}`;
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

// ---- the switch-heavy world ---------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function dataTex(n = 4, seed = 0) {
  const d = new Uint8Array(n * n * 4); for (let i = 0; i < d.length; i++) d[i] = (i * 31 + seed * 17) & 255;
  const t = new THREE.DataTexture(d, n, n); t.needsUpdate = true; return t;
}
function cubeUvTex() {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.image = { data: new Uint8Array(768 * 1024 * 4), width: 768, height: 1024 };
  t.mapping = THREE.CubeUVReflectionMapping;
  t.needsUpdate = true;
  return t;
}
// The app's cache materials: materials.js MaterialCache's surface decode (_materialFromFlags, a
// MeshStandardMaterial from the surface flags) + the patch chain index.js / statics.js install
// (light clamp, static depth bias), keyed by _patchSetCacheKey: one program per patch set.
function cacheMaterials(n, seed) {
  const mc = new M.MaterialCache();
  const out = [];
  for (let i = 0; i < n; i++) {
    const tex = ADAPTER.surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).map((_, k) => (k * 13 + i * 29 + seed) & 255), 16, 16);
    const m = mc._materialFromFlags(0x2, tex, undefined, undefined, undefined, undefined, { translucency: 0, luminosity: i % 3 === 0 ? 0.3 : 0, diffuse: 1 });
    if (typeof M.installLightClampShaderPatch === "function") M.installLightClampShaderPatch(m);
    if (i % 2 === 1 && typeof M.applyStaticDepthBias === "function") M.applyStaticDepthBias(m);
    m.userData = { ...(m.userData || {}), __cacheOwned: true };
    out.push(m);
  }
  return out;
}

function buildWorld(o = {}) {
  const r = rng(o.seed ?? 29);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8899aa, 40, 420);
  const lights = new THREE.Group(); lights.name = "lights"; scene.add(lights);
  lights.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(10, 20, 5);
  if (o.shadows) { sun.castShadow = true; sun.shadow.mapSize.set(32, 32); }
  lights.add(sun);
  lights.add(new THREE.HemisphereLight(0x8888ff, 0x442200, 0.3));
  for (let i = 0; i < 3; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30, 2); p.position.set(r() * 60 - 30, 3, r() * 60 - 30); lights.add(p); }
  { const s = new THREE.SpotLight(0xffffff, 1, 40, 0.5, 0.2, 2); s.position.set(5, 10, 5); lights.add(s); }
  if (o.probe) lights.add(new THREE.LightProbe(new THREE.SphericalHarmonics3().set(new Array(9).fill(0).map((_, k) => new THREE.Vector3(0.1 * k, 0.05, 0.02)))));
  if (o.lightsAllLayers) lights.traverse((l) => l.layers.enableAll());

  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const grp = (n) => { const g = new THREE.Group(); g.name = n; return g; };
  const terrain = grp("terrain"), buildings = grp("buildings"), statics = grp("statics"), cells = grp("cells"), entities = grp("entities");
  worldRoot.add(terrain, buildings, statics, cells, entities);
  cells.layers.set(1);

  const geoms = [new THREE.BoxGeometry(1, 1, 1), new THREE.SphereGeometry(0.5, 6, 4), new THREE.CylinderGeometry(0.3, 0.3, 1, 6), new THREE.ConeGeometry(0.4, 1, 5)];
  const W = { scene, worldRoot, terrain, buildings, statics, cells, entities, lights, sun, geoms, fam: {}, meshes: [] };
  const col = () => new THREE.Color().setHSL(r(), 0.6, 0.45);
  const fam = W.fam;
  // material families: each family shares one program
  fam.std = []; for (let i = 0; i < 18; i++) fam.std.push(new THREE.MeshStandardMaterial({ map: dataTex(4, i), color: col(), roughness: 0.3 + r() * 0.7, metalness: r() * 0.5, emissive: col(), emissiveIntensity: r() }));
  fam.nrm = []; for (let i = 0; i < 6; i++) fam.nrm.push(new THREE.MeshStandardMaterial({ map: dataTex(4, 40 + i), normalMap: dataTex(4, 60 + i), normalScale: new THREE.Vector2(r() * 2, r() * 2), color: col() }));
  fam.alpha = []; for (let i = 0; i < 5; i++) fam.alpha.push(new THREE.MeshStandardMaterial({ map: dataTex(4, 80 + i), alphaTest: 0.2 + i * 0.1, color: col() }));
  fam.maps = []; for (let i = 0; i < 4; i++) fam.maps.push(new THREE.MeshStandardMaterial({ map: dataTex(4, 90 + i), emissiveMap: dataTex(4, 100 + i), aoMap: dataTex(4, 110 + i), aoMapIntensity: r(), lightMap: dataTex(4, 120 + i), lightMapIntensity: r() * 2, emissive: col() }));
  fam.basic = []; for (let i = 0; i < 8; i++) fam.basic.push(new THREE.MeshBasicMaterial({ map: dataTex(4, 130 + i), color: col(), opacity: 1 }));
  fam.lambert = []; for (let i = 0; i < 5; i++) fam.lambert.push(new THREE.MeshLambertMaterial({ map: dataTex(4, 140 + i), color: col(), emissive: col() }));
  fam.phong = []; for (let i = 0; i < 5; i++) fam.phong.push(new THREE.MeshPhongMaterial({ map: dataTex(4, 150 + i), color: col(), specular: col(), shininess: r() * 80 }));
  const grad = dataTex(4, 7);
  fam.toon = []; for (let i = 0; i < 3; i++) fam.toon.push(new THREE.MeshToonMaterial({ map: dataTex(4, 160 + i), color: col(), gradientMap: grad }));
  {
    // ShaderMaterial clones on one program: lights + fog merged in, a texture, a float array (three's
    // array setters upload without a cache), a colour
    const base = new THREE.ShaderMaterial({
      lights: true, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, { uC: { value: new THREE.Color() }, uT: { value: null }, uF: { value: 0 }, uArr: { value: [0, 0, 0, 0] } }]),
      vertexShader: "#include <fog_pars_vertex>\nvarying vec2 vUv; void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}",
      fragmentShader: "#include <common>\n#include <lights_pars_begin>\n#include <fog_pars_fragment>\nuniform vec3 uC; uniform sampler2D uT; uniform float uF; uniform float uArr[4]; varying vec2 vUv; void main(){ vec3 c = uC * texture2D(uT, vUv).rgb + uF + uArr[0] + uArr[3] + ambientLightColor; gl_FragColor = vec4(c, 1.0);\n#include <fog_fragment>\n}",
    });
    fam.shader = [];
    for (let i = 0; i < 6; i++) {
      const m = base.clone(); m.name = `shader-${i}`;
      m.uniforms.uC.value = col(); m.uniforms.uT.value = dataTex(4, 170 + i); m.uniforms.uF.value = r(); m.uniforms.uArr.value = [r(), r(), r(), r()];
      if (i === 4) m.uniforms.uF.needsUpdate = false; // three's upload skips a container marked clean
      fam.shader.push(m);
    }
  }
  {
    // onBeforeCompile-patched Standard (the app's patch style: extra uniforms, stashed shader uniforms, a key)
    const detail = dataTex(4, 3);
    fam.patched = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.MeshStandardMaterial({ map: dataTex(4, 180 + i), color: col(), roughness: 0.8 });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uDetail = { value: detail };
        sh.uniforms.uTint = { value: col() };
        sh.uniforms.uGain = { value: 0.5 + i * 0.1 };
        sh.fragmentShader = sh.fragmentShader.replace("void main() {", "uniform sampler2D uDetail; uniform vec3 uTint; uniform float uGain;\nvoid main() {")
          .replace("#include <dithering_fragment>", "gl_FragColor.rgb *= uTint * uGain * texture2D(uDetail, vMapUv).r;\n#include <dithering_fragment>");
        Object.defineProperty(m.userData, "sh", { value: sh, enumerable: false, configurable: true, writable: true });
      };
      m.customProgramCacheKey = () => "sw|patched";
      fam.patched.push(m);
    }
  }
  fam.cache = cacheMaterials(8, 5);
  // statics: 2-3 meshes per material, spread over the static roots
  const roots = [statics, buildings, terrain];
  const all = [];
  const monoFam = o.mono === "basic" ? "basic" : "std";
  for (const [k, mats] of Object.entries(fam)) if (!o.mono || k === monoFam) for (const m of mats) all.push([k, m]);
  let n = 0;
  for (const [k, m] of all) {
    const copies = 2 + (n % 2);
    for (let c = 0; c < copies; c++) {
      const g = k === "maps" ? geoms[0] : geoms[(n + c) % 4];
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(r() * 60 - 30, r() * 60 - 30, r() * 3);
      mesh.rotation.z = r() * 6;
      if ((n + c) % 9 === 4) mesh.scale.set(-1, 1, 1);
      mesh.receiveShadow = (n + c) % 3 === 0;
      mesh.updateMatrix(); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      mesh.name = `${k}-${n}-${c}`;
      roots[(n + c) % 3].add(mesh); W.meshes.push(mesh);
    }
    n++;
  }
  if (o.mono) {
    // one std material drawn at both ends of the run (renderOrder): its second draw is a switch to a
    // material three last refreshed at the camera change (its light flags still set)
    const mf = fam[monoFam];
    const mesh = new THREE.Mesh(geoms[1], mf[0]);
    mesh.position.set(3, 3, 1); mesh.updateMatrix(); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
    mesh.renderOrder = 9; mesh.name = `${monoFam}-again`; statics.add(mesh);
    // ... and another material last, so the next pass (sub-camera / render call) starts with a switch
    const tail = new THREE.Mesh(geoms[2], mf[5]);
    tail.position.set(-3, 3, 1); tail.updateMatrix(); tail.matrixAutoUpdate = false; tail.frustumCulled = false;
    tail.renderOrder = 10; tail.name = `${monoFam}-tail`; statics.add(tail);
  }
  // a few cell statics (layer 1) on the std family
  for (let i = 0; i < (o.mono === "basic" ? 0 : 4); i++) {
    const mesh = new THREE.Mesh(geoms[i % 4], fam.std[i * 3]);
    mesh.position.set(r() * 20 - 10, r() * 20 - 10, 0.5); mesh.updateMatrix(); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
    mesh.layers.set(1); mesh.name = `cell-${i}`; cells.add(mesh);
  }
  // BatchedMesh pools on distinct materials sharing one program (class-material style), marked runs
  W.pools = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  for (let p = 0; p < (o.mono ? 0 : 6); p++) {
    const mat = new THREE.MeshStandardMaterial({ map: dataTex(4, 200 + p), color: col(), side: THREE.DoubleSide, roughness: 0.4 + p * 0.1 });
    const bm = new THREE.BatchedMesh(16, 2048, 4096, mat);
    const ids = [bm.addGeometry(geoms[p % 4]), bm.addGeometry(geoms[(p + 1) % 4])];
    for (let k = 0; k < 6; k++) bm.setMatrixAt(bm.addInstance(ids[k % 2]), m4.compose(v.set(r() * 40 - 20, r() * 40 - 20, r() * 2), q.identity(), s1));
    bm.perObjectFrustumCulled = p % 2 === 0; bm.sortObjects = false; bm.frustumCulled = false; bm.matrixAutoUpdate = false;
    bm.receiveShadow = p % 2 === 1; bm.name = `pool-${p}`;
    RUNS.markBatchedRuns(bm);
    statics.add(bm); W.pools.push(bm);
  }
  if (o.handover) {
    // three's material tracker, both hand-over kinds, ordered by renderOrder (the program sort orders
    // by renderOrder first). [A static][B static][A foreign] on a program only they use: A starts the
    // program (three sets it: three's tracker is A), B is a same-program switch (GL holds B), the
    // foreign draw hands A to three. [C static][D static][D foreign] likewise on another program: the
    // foreign draw hands the switched material D to three. Foreign = a worldRoot child (notStatic).
    // D's own onAfterRender (between its switch and its hand-over) mutates D: a colour (stock does
    // not upload it until D's next refresh), its version (three's getProgram early-out), or stages a
    // map upload + a colour change on the next materials of the std family (an upload due mid-frame).
    const flat = (i) => new THREE.MeshStandardMaterial({ map: dataTex(4, 220 + i), color: col(), flatShading: true });
    const flatP = (i) => new THREE.MeshPhongMaterial({ map: dataTex(4, 230 + i), color: col(), flatShading: true });
    const flatL = (i) => new THREE.MeshLambertMaterial({ map: dataTex(4, 240 + i), color: col(), flatShading: true });
    const mA = flat(0), mB = flat(1), mG = flat(2), mC = flatP(0), mD = flatP(1), mF = flatL(0), mE = flatL(1);
    fam.ho = [mA, mB, mG, mC, mD, mF, mE];
    const put = (mat, ro, owned, name, inst = false) => {
      const mesh = inst ? new THREE.InstancedMesh(geoms[ro % 4], mat, 2) : new THREE.Mesh(geoms[ro % 4], mat);
      if (inst) { mesh.setMatrixAt(0, new THREE.Matrix4()); mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0.5, 0, 0)); }
      mesh.position.set((Math.abs(ro) % 20) * 1.5 - 15, 25, 1); mesh.updateMatrix(); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
      mesh.renderOrder = ro; mesh.name = name;
      (owned ? statics : worldRoot).add(mesh);
      return mesh;
    };
    W.ho = {
      // A starts its program (three: three's tracker is A), B switches, A' hands A to three (tracked);
      // G switches after A', A'' — an InstancedMesh on A — hands A to three again (the sync must not
      // take A'' as its object: curMat on an InstancedMesh is another program)
      a0: put(mA, 101, true, "ho-A-static"), b0: put(mB, 102, true, "ho-B-static"), a1: put(mA, 103, false, "ho-A-foreign"),
      g0: put(mG, 104, true, "ho-G-static"), a2: put(mA, 105, false, "ho-A-foreign-inst", true),
      // C starts its program, D switches, D' (mirrored: another front face) hands D itself to three
      c0: put(mC, 111, true, "ho-C-static"), d0: put(mD, 112, true, "ho-D-static"), d1: put(mD, 113, false, "ho-D-foreign"),
      // F starts its program, E switches as the LAST draw of the render; E' — first draw of the next
      // render — hands E to three after three reset its tracker at render() end
      f0: put(mF, 199, true, "ho-F-static"), e0: put(mE, 200, true, "ho-E-static"), e1: put(mE, -50, false, "ho-E-foreign"),
      late: null, mode: "none", mD, dMap: mD.map,
    };
    W.ho.d1.scale.set(-1, 1, 1); W.ho.d1.updateMatrix();
    const fm = fam.std;
    W.ho.d0.onAfterRender = function (renderer) {
      const mode = W.ho.mode;
      if (mode === "color") mD.color.offsetHSL(0.05, 0, 0);
      else if (mode === "version") mD.needsUpdate = true;
      else if (mode === "key") { mD.map = mD.map ? null : W.ho.dMap; mD.needsUpdate = true; } // program key moves
      else if (mode === "srt") { renderer.setRenderTarget(renderer.getRenderTarget()); mD.color.offsetHSL(0.05, 0, 0); } // three resets its tracker: D' refreshes D
    };
    // (the std family draws in material order: a hook after std[0]'s first draw stages a map upload
    // and a colour change for std[5] / std[6], drawn later in the same run — due mid-frame)
    const first = W.meshes.find((m) => m.material === fm[0]);
    first.onAfterRender = function (renderer) {
      if (W.ho.mode === "stage") { fm[5].map.needsUpdate = true; fm[6].color.offsetHSL(0.03, 0, 0); fm[7].emissiveIntensity += 0.1; renderer.toneMappingExposure += 0.01; }
    };
  }
  if (o.nested) {
    const mini = new THREE.Scene();
    mini.add(new THREE.Mesh(geoms[0], new THREE.MeshBasicMaterial({ color: 0xff00ff })));
    const miniCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); miniCam.position.z = 3;
    const rt = new THREE.WebGLRenderTarget(8, 8);
    const host = W.meshes[7];
    host.onBeforeRender = (renderer) => {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(mini, miniCam);
      renderer.setRenderTarget(prev);
    };
  }
  W.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500);
  W.camera2 = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 400);
  if (o.arrayCamera) {
    W.subCams = [0, 1].map((i) => { const c = new THREE.PerspectiveCamera(60, 2 / 3, 0.1, 500); c.viewport = new THREE.Vector4(i * 400, 0, 400, 600); return c; });
    W.camera = new THREE.ArrayCamera(W.subCams);
    W.camera.fov = 60; W.camera.aspect = 4 / 3; W.camera.near = 0.1; W.camera.far = 500; W.camera.updateProjectionMatrix();
    W.camera.layers.enableAll(); W.subCams[0].layers.enableAll(); W.subCams[1].layers.set(0);
  }
  return W;
}

/** Per-frame changes (identical in both arms). */
function step(W, f, arm) {
  const cam = W.camera;
  cam.position.set(Math.sin(f * 0.35) * 16, 12 + Math.cos(f * 0.21) * 3, 24 + Math.sin(f * 0.17) * 8);
  cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  W.camera2.position.set(-cam.position.x, cam.position.y + 4, cam.position.z - 6); W.camera2.lookAt(0, 0, 0); W.camera2.updateMatrixWorld();
  if (W.subCams) {
    for (let i = 0; i < W.subCams.length; i++) {
      const c = W.subCams[i];
      c.position.copy(cam.position).add(new THREE.Vector3(i * 2 - 1, 0, 0));
      c.lookAt(0, 0, 0); c.updateMatrixWorld(); c.matrixWorldInverse.copy(c.matrixWorld).invert();
    }
  }
  const F = W.fam, ev = W.events || {};
  const at = (k) => ev[k] === f;
  if (at("colors")) {
    F.std[0].color.setHex(0x22aa44); F.std[1].opacity = 0.75; F.std[2].emissiveIntensity = 2.5; F.basic[0].color.setHex(0x113355);
    F.lambert[1].emissive.setHex(0x441100); F.phong[2].shininess = 7; F.toon[1].color.setHex(0x777700);
    // (mid-family materials: a family's first material is drawn by three at the program change)
    F.std[9].roughness = 0.11; F.std[10].metalness = 0.77; F.phong[3].specular.setHex(0x334455); F.nrm[3].normalScale.set(0.3, 1.7);
    if (F.cache) F.cache[2].color.setHex(0x99aa33);
  }
  if (at("mapSwap")) { F.std[3].map = F.std[9].map; F.alpha[1].alphaTest = 0.85; F.basic[2].map = F.basic[5].map; }
  if (at("upload")) { F.std[4].map.needsUpdate = true; F.lambert[0].map.needsUpdate = true; F.cache[1].map.needsUpdate = true; }
  if (at("version")) { F.std[5].needsUpdate = true; F.patched[2].needsUpdate = true; arm.renderer.toneMappingExposure = 1.3; }
  if (at("uniforms")) {
    F.shader[0].uniforms.uC.value.setRGB(0.1, 0.9, 0.2);
    F.shader[1].uniforms.uC = { value: new THREE.Color(0.7, 0.2, 0.9) }; // container replaced
    F.shader[2].uniforms.uArr.value[1] = 0.33; F.shader[2].uniforms.uArr.value[3] = 0.66;
    F.shader[3].uniforms.uF.value = 0.123;
    F.shader[4].uniforms.uF.value = 0.456; // (marked clean: three does not upload it)
    const sh0 = F.patched[0].userData.sh, sh1 = F.patched[1].userData.sh;
    if (sh0) sh0.uniforms.uTint = { value: new THREE.Color(0.3, 0.3, 0.9) }; // container replaced in three's uniforms object
    if (sh1) sh1.uniforms.uGain.value = 2.0;
  }
  if (at("fog")) { W.scene.fog.color.setHex(0x553322); W.scene.fog.far = 300; }
  if (at("fogObject")) W.scene.fog = new THREE.Fog(0x335577, 30, 380);
  if (at("transform")) { F.std[6].map.offset.set(0.1, 0.2); F.std[7].map.repeat.set(2, 3); F.std[8].map.rotation = 0.4; F.nrm[0].normalScale.set(2, 2); }
  if (at("receiveShadow")) for (let i = 0; i < W.meshes.length; i += 5) W.meshes[i].receiveShadow = !W.meshes[i].receiveShadow;
  if (at("lightAdd")) { const p = new THREE.PointLight(0x66aaff, 1, 20, 2); p.position.set(4, 4, 4); W.lights.add(p); }
  if (at("envOn")) W.scene.environment = (W.cube ||= cubeUvTex());
  if (at("envOff")) W.scene.environment = null;
  if (at("colorSpace")) arm.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // every program moves; the fog colour's target space too
  if (at("staticLate") && W.ho) {
    // a static on the switched material D, first drawn right after D's switch (a full-chain record)
    const mesh = new THREE.Mesh(W.geoms[1], W.ho.mD);
    mesh.position.set(10, 26, 1); mesh.updateMatrix(); mesh.matrixAutoUpdate = false; mesh.frustumCulled = false; mesh.renderOrder = 112; mesh.name = "ho-late-static";
    W.statics.add(mesh); W.ho.late = mesh;
  }
  if (W.ho) {
    W.ho.mode = W.hoPlan ? W.hoPlan(f) : "none";
    if (W.ho.mode !== "key" && W.ho.mD.map === null) { W.ho.mD.map = W.ho.dMap; W.ho.mD.needsUpdate = true; }
  }
  if (at("resetState")) arm.renderer.resetState();
}

/** One arm: a fresh fake context + renderer, every production patch in index.js order. */
function makeArm(exec, sc) {
  const calls = [];
  let logging = false;
  const gl = createFakeWebGL2({
    maxTextures: 16, maxCombined: 32, clipControl: true,
    onCall: (name, args) => { if (logging) calls.push(ser(name, args)); },
  });
  const canvas = restorableCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...depthRendererParams("reversed") });
  installReversedZ(THREE, renderer);
  renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: !sc.noLightOnce, lightUbo: true });
  installDrawSortProgram(renderer);
  if (sc.toneMapping) renderer.toneMapping = THREE.ACESFilmicToneMapping; // toneMappingExposure live in toneMapped programs
  if (sc.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
  const W = buildWorld(sc);
  W.events = sc.events || {};
  W.hoPlan = sc.hoPlan || null;
  installAsyncLinkGuard(renderer, () => W.scene);
  SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
  RUNS.installBatchedRuns(renderer);
  const arm = { gl, canvas, renderer, W, dx: null, calls, rt: sc.msaa ? new THREE.WebGLRenderTarget(800, 600, { samples: 4, type: THREE.HalfFloatType }) : null };
  arm.install = () => { if (exec && arm.dx === null) arm.dx = DX.installDrawExec(renderer, () => W.scene, { force: true, rigs: true, switch: true }); };
  if (!sc.lateInstall) arm.install();
  arm.startLog = () => { calls.length = 0; logging = true; };
  arm.stopLog = () => { logging = false; return calls.slice(); };
  return arm;
}

function renderFrame(arm, sc) {
  const { renderer, W } = arm;
  const out = [];
  const one = (cam) => {
    renderer.render(W.scene, cam);
    const i = renderer.info.render;
    out.push(`calls=${i.calls} tri=${i.triangles} | ${JSON.stringify(RUNS.batchedRunsFrameTotals())}`);
  };
  if (arm.rt) renderer.setRenderTarget(arm.rt);
  if (sc.split) {
    for (const [p, mask] of [[0, 1], [1, 2]]) { W.camera.layers.mask = mask; renderer.autoClear = p === 0; if (p > 0) renderer.clearDepth(); one(W.camera); }
    W.camera.layers.mask = 0xffffffff;
  } else if (sc.twoCameras) {
    one(W.camera); one(W.camera2);
  } else if (sc.twice) {
    one(W.camera); one(W.camera);
  } else one(W.camera);
  if (arm.rt) renderer.setRenderTarget(null);
  return out;
}

const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o[k]; return r; };
const RUN_KEYS = ["draws", "instances", "runs", "rebuilds", "uploads", "noGain", "fallbacks", "errors", "sortedDraws", "sortedInstances", "sortedRuns", "stableSkips", "stablePoisons"];

async function runArm(exec, sc) {
  RUNS.__resetBatchedRunsFrameForTest();
  RUNS.__resetStableForTest();
  const runs0 = pick(RUNS.getBatchedRunsStats(), RUN_KEYS);
  const skip0 = SKIP.getSkipEmptyMultiDrawStats().skipped;
  const pc0 = PERCAM.getBatchedIndirectPerCameraStats();
  const arm = makeArm(exec, sc);
  const frames = [];
  const quiet = (fn) => { const l = console.log; console.log = () => {}; try { fn(); } finally { console.log = l; } };
  for (let f = 0; f < sc.frames; f++) {
    if (sc.lateInstall && f === sc.lateInstall) arm.install();
    step(arm.W, f, arm);
    if (f === sc.events?.restore) quiet(() => arm.canvas.loseAndRestore());
    arm.startLog();
    const st0 = arm.dx && process.env.DX_DEBUG ? { ...arm.dx.stats } : null;
    const counters = renderFrame(arm, sc);
    if (st0) console.log(`      f${f} ${arm.W.ho ? arm.W.ho.mode : ""}: ` + ["sameProgramSwitches", "stateOnly", "fast", "full", "switchSyncs", "switchSyncsOwn", "switchSyncAborts", "switchSyncFailed"].map((k) => `${k} ${arm.dx.stats[k] - st0[k]}`).join(" "));
    await settle(arm);
    frames.push({ calls: arm.stopLog(), counters });
  }
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
        const ctx = (arr) => arr.slice(Math.max(0, i - 4), i + 3).map((s, k) => `${Math.max(0, i - 4) + k === i ? ">>" : "  "} ${s === undefined ? "(end)" : s.slice(0, 160)}`).join("\n      ");
        return { frame: f, index: i, text: `frame ${f} call ${i} (stock ${a.length} calls, switch ${b.length})\n    stock:\n      ${ctx(a)}\n    switch:\n      ${ctx(b)}` };
      }
    }
    if (JSON.stringify(A.frames[f].counters) !== JSON.stringify(B.frames[f].counters)) {
      return { frame: f, index: -1, text: `frame ${f} counters: stock ${JSON.stringify(A.frames[f].counters)} vs switch ${JSON.stringify(B.frames[f].counters)}` };
    }
  }
  return null;
}

const TOTAL = { calls: 0, frames: 0, sps: 0, scenarios: 0 };
async function scenario(name, sc, expect = {}) {
  if (process.env.DX_ONLY && !name.includes(process.env.DX_ONLY)) return;
  console.log(`\nSCENARIO ${name}`);
  const A = await runArm(false, sc);
  const B = await runArm(true, sc);
  const s = B.dxStats || {};
  const sps = s.sameProgramSwitches | 0;
  const d = firstStreamDiff(A, B);
  const total = A.frames.reduce((n, f) => n + f.calls.length, 0);
  TOTAL.calls += total; TOTAL.frames += sc.frames; TOTAL.sps += sps; TOTAL.scenarios += 1;
  console.log(`    switch arm: sps ${sps} stateOnly ${s.stateOnly} fast ${s.fast} full ${s.full} pass ${s.passThrough} syncs ${s.switchSyncs} (own ${s.switchSyncsOwn} tracked ${s.switchSyncsTracked}) aborts ${s.switchSyncAborts} failed ${s.switchSyncFailed} plans ${s.switchPlans}`);
  console.log(`    switch refused ${JSON.stringify(s.switchRefused)}`);
  if (process.env.DX_DEBUG) {
    const fam = {};
    for (const o of B.arm.W.meshes.concat(B.arm.W.pools)) {
      const k = o.name.split("-")[0]; const t = (fam[k] ||= { recs: 0, hits: 0, sw: 0, swNo: {}, refused: {}, struct: {} });
      const h = o.__hbDx;
      if (h === undefined) { t.struct.undrawn = (t.struct.undrawn || 0) + 1; continue; }
      if (h.isDxRefusal) { t.struct[h.refused] = (t.struct[h.refused] || 0) + 1; continue; }
      for (let r = h; r; r = r.next) { t.recs++; t.hits += r.hits; t.sw += r.swHits || 0; if (r.swNo) t.swNo[r.swNo] = (t.swNo[r.swNo] || 0) + 1; if (r.refused) t.refused[r.refused] = (t.refused[r.refused] || 0) + 1; }
    }
    console.log("    families:", JSON.stringify(fam));
  }
  // (each check carries "the switch ran": on an executor without it every one of them fails)
  check(`${name}: GL call stream identical to stock, call for call, ${sc.frames} frames — with same-program switches executed`,
    d === null && sps >= (expect.minSps ?? 1), d ? d.text : `${total} GL calls compared, ${sps} same-program switches`);
  check(`${name}: renderer.info + __batchedRuns.frame() per render(), batched_runs / skip_empty / per-camera stats identical (switch on)`,
    sps > 0 && (d === null || d.index >= 0) && JSON.stringify(A.dRuns) === JSON.stringify(B.dRuns) && A.dSkip === B.dSkip && JSON.stringify(A.dPc) === JSON.stringify(B.dPc),
    `runs ${JSON.stringify(A.dRuns) === JSON.stringify(B.dRuns)} skip ${A.dSkip}/${B.dSkip}`);
  check(`${name}: no executor error, no unproven tracker sync, no late VAO fix, no unit conflict / UBO error (switch on)`,
    s.switchOn === true && s.errors === 0 && s.switchSyncFailed === 0 && s.vaoFixLate === 0 && A.unitConflicts === 0 && B.unitConflicts === 0 && A.uboErrors === 0 && B.uboErrors === 0,
    `on ${s.switchOn} errors ${s.errors} syncFailed ${s.switchSyncFailed} late ${s.vaoFixLate} conflicts ${A.unitConflicts}/${B.unitConflicts} ubo ${A.uboErrors}/${B.uboErrors}`);
  if (expect.refused) for (const why of expect.refused) check(`${name}: switches refused as "${why}" (left to the state-only path)`, ((s.switchRefused || {})[why] || 0) > 0, `${why}: ${(s.switchRefused || {})[why] || 0}`);
  if (expect.syncsOwn) check(`${name}: three's tracker synced before hand-overs of the switched material`, (s.switchSyncsOwn | 0) > 0, `own ${s.switchSyncsOwn}`);
  if (expect.aborts) check(`${name}: the sync's getProgram fence aborted (a compile / another cached program: the hand-over binds another program)`, (s.switchSyncAborts | 0) > 0, `aborts ${s.switchSyncAborts}`);
  if (expect.syncsTracked) check(`${name}: three's tracker synced before hand-overs of three's tracked material`, (s.switchSyncsTracked | 0) > 0, `tracked ${s.switchSyncsTracked}`);
  if (expect.kinds) {
    // the families the switch took (each material family's records)
    const took = new Set();
    for (const o of B.arm.W.meshes.concat(B.arm.W.pools)) for (let r = o.__hbDx; r && r.isDxRefusal !== true; r = r.next) if (r.swHits > 0) took.add(o.name.split("-")[0]);
    check(`${name}: the switch executed draws of every material family (${expect.kinds.join(", ")})`, expect.kinds.every((k) => took.has(k)), `switched: ${[...took].sort().join(", ")}`);
  }
  return { A, B };
}

// ================================================================================================
{
  console.log("PREMISES + FLAG");
  const norm = (x) => x.replace(/\s+/g, " ");
  const msrc = norm(fs.readFileSync(new URL("../node_modules/three/build/three.module.js", import.meta.url), "utf8"));
  const csrc = norm(fs.readFileSync(new URL("../node_modules/three/build/three.core.js", import.meta.url), "utf8"));
  const P = DX.THREE_SWITCH_PREMISES, PC = DX.THREE_SWITCH_CORE_PREMISES;
  check("switch premises exported (setProgram / WebGLMaterials / getProgram / WebGLUniforms / three.core shapes), three REVISION 184 (the switch is refused at install on any other)",
    Array.isArray(P) && P.length >= 20 && Array.isArray(PC) && PC.length >= 2 && THREE.REVISION === "184", `${P ? P.length : 0} + ${PC ? PC.length : 0}, r${THREE.REVISION}`);
  let miss = [];
  for (const p of P || []) if (!msrc.includes(norm(p))) miss.push(p.slice(0, 80));
  for (const p of PC || []) if (!csrc.includes(norm(p))) miss.push(p.slice(0, 80));
  check("every switch premise is in three r184's source, whitespace-normalised", Array.isArray(P) && miss.length === 0, miss.length ? `missing: ${miss.join(" | ")}` : `${(P || []).length + (PC || []).length} premises`);
  check("drawExecSwitchEnabled(): DEFAULT OFF", typeof DX.drawExecSwitchEnabled === "function" && DX.drawExecSwitchEnabled() === false);
  __setRustFlagForTest("drawExecSwitch", true);
  check("drawExecSwitchEnabled(): ?drawExecSwitch=on", typeof DX.drawExecSwitchEnabled === "function" && DX.drawExecSwitchEnabled() === true);
  {
    const arm = makeArm(false, { frames: 0 });
    const api = DX.installDrawExec(arm.renderer, () => arm.W.scene, { force: true });
    check("install under ?drawExecSwitch=on (no option): the switch is on", !!api && api.stats && api.stats.switchOn === true);
  }
  __setRustFlagForTest("drawExecSwitch", undefined);
  {
    const arm = makeArm(false, { frames: 0 });
    const api = DX.installDrawExec(arm.renderer, () => arm.W.scene, { force: true });
    check("install by default: the switch is off (stats.switchOn false, no switch counters move)", !!api && api.stats && api.stats.switchOn === false && api.stats.sameProgramSwitches === 0);
  }
}

// (program-moving events two frames apart: a record whose program moves three times in a row rests on
// the chain for a cool-down — the executor's churn rule — and would take no switch after them)
const EV = { colors: 2, mapSwap: 3, upload: 4, version: 5, uniforms: 6, fog: 7, transform: 8, receiveShadow: 9, fogObject: 10, lightAdd: 12, envOn: 15, envOff: 18, colorSpace: 21 };
await scenario("switch-heavy world: every family on one program each, tone mapping on, events between frames (colours, maps, uploads, versions, toneMappingExposure, uniforms + containers + a clean-marked one, fog, transforms, receiveShadow, a light, an environment, the output colour space)", {
  frames: 24, events: EV, toneMapping: true,
}, { minSps: 200, refused: ["fog", "envMap"], kinds: ["std", "nrm", "alpha", "maps", "basic", "lambert", "phong", "toon", "shader", "patched", "cache", "pool"] });
await scenario("three's material tracker: hand-overs of three's tracked material (plain + InstancedMesh) and of the switched material (mirrored), across render() end, a mid-frame colour change / upload / toneMappingExposure / setRenderTarget between switch and hand-over, a static first drawn inside a switched run", {
  frames: 16, handover: true, toneMapping: true, events: { staticLate: 6, colors: 3 }, hoPlan: (f) => (f >= 2 && f < 5 ? "color" : f >= 8 && f < 11 ? "stage" : f >= 12 && f < 15 ? "srt" : "none"),
}, { syncsOwn: true, syncsTracked: true });
await scenario("three's material tracker: a hook bumps the switched material's version (getProgram's early-out) or moves its program key (a compile, then another cached program: the sync's fence aborts) between its switch and its hand-over", {
  // (every other frame: a bump invalidates D's own record, re-taken in the frame between — so D switches again)
  frames: 14, handover: true, hoPlan: (f) => (f === 2 || f === 4 ? "version" : f === 7 || f === 9 || f === 11 ? "key" : "none"),
}, { syncsOwn: true, aborts: true });
await scenario("two render() per frame (layers split, lights on world layer 0 only: the lights state moves between them) into an MSAA target", { frames: 8, split: true, msaa: true, events: { colors: 3, upload: 5 } }, { refused: ["lightsState"] });
await scenario("two render() per frame (layers split, lights on every layer) into an MSAA target", { frames: 8, split: true, msaa: true, lightsAllLayers: true, events: { colors: 3, upload: 5 } }, { minSps: 100 });
await scenario("one-program world: two render() per frame on ONE camera, a light probe, lightUploadOnce off (a switch right after three's render() end; light flags left set by a camera change)", { frames: 8, mono: true, twice: true, probe: true, noLightOnce: true, events: { colors: 3 } }, { minSps: 50 });
await scenario("one-program world: ArrayCamera (the camera changes between two same-program draws), a light probe, lightUploadOnce off", { frames: 7, mono: true, arrayCamera: true, probe: true, noLightOnce: true, events: { colors: 3 } }, { minSps: 50 });
await scenario("one-program UNLIT world (MeshBasic + fog): two render() per frame on ONE camera (no lights witness gates an unlit switch: only the render-call gate)", { frames: 8, mono: "basic", twice: true, events: { colors: 3 } }, { minSps: 30 });
await scenario("two cameras per frame (one render() each)", { frames: 8, twoCameras: true, events: { colors: 3, uniforms: 5 } }, {});
await scenario("ArrayCamera (sub-cameras inside one render())", { frames: 7, arrayCamera: true, events: { colors: 3 } }, {});
await scenario("a nested render + setRenderTarget inside an onBeforeRender (three's tracker reset mid-frame)", { frames: 7, nested: true, handover: true, hoPlan: () => "none" }, {});
await scenario("resetState and a context loss + restore mid-session", { frames: 12, events: { resetState: 3, restore: 7, colors: 9 } }, {});
await scenario("shadows on (lit programs with shadow samplers: refused)", { frames: 7, shadows: true, events: { colors: 3 } }, { refused: ["plan:shadowMaps"] });
await scenario("the executor installed after three linked the programs (unknown programs refused; new ones taken)", { frames: 10, lateInstall: 2, events: { lightAdd: 6 } }, { refused: ["plan:programUnknown"] });

check(`[total] ${TOTAL.scenarios} scenarios: ${TOTAL.frames} frames, ${TOTAL.calls} GL calls compared, ${TOTAL.sps} same-program switches`, TOTAL.sps > 0 && TOTAL.scenarios > 0);
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
