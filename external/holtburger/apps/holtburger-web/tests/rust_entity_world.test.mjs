// tests/rust_entity_world.test.mjs — `?rustEntityWorld` (scene3d/entity_world.js) IDENTITY SUITE.
// Lane notes, measurements and the exactness argument: docs/2026-10-26-rust-entity-walk.md.
//
// The flag replaces three r184's generic per-node work for entity rigs — the matrix walk and
// projectObject — with code that knows the rig shape. Its only bar is EXACTNESS, proven here in
// node (no wasm: both parts are JS, so nothing SKIPs):
//   P  premises — the three bodies the module reproduces (Matrix4.compose / multiplyMatrices,
//      Object3D.updateMatrix / updateMatrixWorld, projectObject + render()'s order) are the
//      installed three's; the closure premises it cannot read at run time (WebGLObjects.update,
//      WebGLGeometries.get / update, WebGLAttributes.update's version test) are three.module.js's;
//      the flag is default OFF; a drifted premise refuses the install.
//   W  the walk — two identical worlds, A = three's walk, B = the entity walk (every rig root),
//      synthetic rigs with every special case and every mutation the app makes; after EVERY walk
//      every node's matrix, matrixWorld (Object.is per element: −0 and NaN included) and
//      matrixWorldNeedsUpdate compared.
//   R  the projection (+ walk) — three's real WebGLRenderer over tests/helpers/fake_webgl2.mjs with
//      the production patch chain in scene3d/index.js order (reversed-Z, uniform_bind_patch, the
//      program sort with the punch phase, depth bands, async_link, skip_empty, batched_runs,
//      draw_exec with rigs — today's defaults), stock vs flag-on, frame by frame: EVERY GL call
//      with its arguments, renderer.info, and the sorted render lists, over scripted scenarios.
//   E  the real spawn path — EntityManager rigs (fake wasm) built with index.js's scene3dForBuilders
//      shape (no renderer / scene), flag off vs on: the rig build installs the root walk, index.js's
//      explicit line installs the projection (the lazy path cannot, and P checks index.js has the
//      line); matrices and GL streams identical over ticks.
//   L  lifetime — despawned rigs (a shrinking crowd, a dropped held item on a groupOrder carrier, an
//      empty entities group): after gc the flag-on arm keeps exactly the rigs stock keeps (WeakRefs),
//      and the stand-in pool holds no node after any render.
// Run:   cd apps/holtburger-web && node tests/rust_entity_world.test.mjs
// Bench: node tests/rust_entity_world.test.mjs --bench   (paired, in-process, both build orders; notes §1)
// EW_INDEX_SRC=<file>: read that file as scene3d/index.js (the install-wiring check; lane notes §6).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import v8 from "node:v8";
import vm from "node:vm";

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
const { installDrawSortProgram, setDrawSortPhase } = await import("../scene3d/draw_sort_program.js");
const { installDepthBandSort } = await import("../scene3d/depth_band_sort.js");
const { installShadowCasterList } = await import("../scene3d/shadow_caster_list.js");
const DX = await import("../scene3d/draw_exec.js");
const SH = await import("../scene3d/skip_hidden_matrix.js");
// EW_MODULE: a mutated copy of the module (the suite must FAIL on it — lane notes §5).
const EW = await import(process.env.EW_MODULE || "../scene3d/entity_world.js");

const BENCH = process.argv.includes("--bench");
let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

// process-wide installs, index.js preInit3D order
RUNS.installBatchedRunsChunks(THREE, { force: true });
installLightUboChunks(THREE, { force: true });
applyBatchedMeshColorTextureFix(THREE);
PERCAM.installBatchedIndirectPerCamera(THREE, { force: true });
SH.installSkipHiddenMatrix(THREE, { force: true });

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const Z = new THREE.Vector3(0, 0, 1);
const O3D = THREE.Object3D.prototype;

// =============================================================================================
// P — premises, flag, refusal
// =============================================================================================
if (!BENCH) console.log("PART P — premises, flag, install refusal");
if (!BENCH) {
  EW.__setEntityWorldForTest(undefined);
  check("rustEntityWorld default OFF (node: no URL)", EW.entityWorldEnabled() === false);
  check("flag off: installEntityWorldRoot refuses", EW.installEntityWorldRoot(new THREE.Group()) === false);
  const norm = (s) => String(s).replace(/\s+/g, " ");
  const body = (fn) => { const s = norm(Function.prototype.toString.call(fn)); return s.slice(s.indexOf("{") + 1).trim(); };
  const P = EW.WALK_PREMISES;
  check("walk premise: Matrix4.compose is three r184's", body(THREE.Matrix4.prototype.compose).startsWith(P.compose));
  check("walk premise: Matrix4.multiplyMatrices is three r184's", body(THREE.Matrix4.prototype.multiplyMatrices).startsWith(P.multiplyMatrices));
  check("walk premise: Object3D.updateMatrix is three r184's", body(O3D.updateMatrix).startsWith(P.updateMatrix) && body(O3D.updateMatrix).includes("this.matrixWorldNeedsUpdate = true;"));
  const umw = body(O3D.__hbSkipHidden || O3D.updateMatrixWorld);
  check("walk premise: Object3D.updateMatrixWorld is three r184's", umw.startsWith(P.updateMatrixWorld) && umw.includes(P.updateMatrixWorldChildren));
  const rsrc = Function.prototype.toString.call(THREE.WebGLRenderer);
  check("projection premises hold in the installed WebGLRenderer", EW.projectPremiseFailure(rsrc) === null, EW.projectPremiseFailure(rsrc) ?? `${EW.PROJECT_PREMISES.length} premises`);
  check("projection premise drift is refused (a mutated projectObject)", EW.projectPremiseFailure(rsrc.replace("if ( object.visible === false ) return;", "if ( object.visible !== true ) return;")) !== null);
  const require = createRequire(import.meta.url);
  const src = norm(readFileSync(require.resolve("three").replace(/[^/\\]+$/, "") + "three.module.js", "utf8"));
  // closure premises (WebGLObjects / WebGLGeometries / WebGLAttributes are not readable at run time)
  const CLOSURE = [
    "function update( object ) { const frame = info.render.frame; const geometry = object.geometry; const buffergeometry = geometries.get( object, geometry ); // Update once per frame if ( updateMap.get( buffergeometry ) !== frame ) { geometries.update( buffergeometry ); updateMap.set( buffergeometry, frame ); } if ( object.isInstancedMesh ) {",
    "if ( object.isSkinnedMesh ) {",
    "function get( object, geometry ) { if ( geometries[ geometry.id ] === true ) return geometry; geometry.addEventListener( 'dispose', onGeometryDispose ); geometries[ geometry.id ] = true; info.memory.geometries ++; return geometry; }",
    "function update( geometry ) { const geometryAttributes = geometry.attributes; // Updating index buffer in VAO now. See WebGLBindingStates. for ( const name in geometryAttributes ) { attributes.update( geometryAttributes[ name ], gl.ARRAY_BUFFER ); } }",
    "function update( attribute, bufferType ) { if ( attribute.isInterleavedBufferAttribute ) attribute = attribute.data; if ( attribute.isGLBufferAttribute ) {",
    "const data = buffers.get( attribute ); if ( data === undefined ) { buffers.set( attribute, createBuffer( attribute, bufferType ) ); } else if ( data.version < attribute.version ) {",
  ];
  for (const p of CLOSURE) check(`closure premise in three.module.js: ${p.slice(0, 64)}…`, src.includes(norm(p)));
  // the WebGLObjects.update object branch ends at the skinned branch: nothing else is done for a plain Mesh
  {
    const i = src.indexOf(norm(CLOSURE[0]));
    const seg = i >= 0 ? src.slice(i, src.indexOf("return buffergeometry;", i)) : "";
    check("closure premise: WebGLObjects.update does nothing else for a plain Mesh (instanced / skinned branches only)",
      seg.length > 0 && !/gl\.|state\.|bindBuffer/.test(seg.replace(/attributes\.update\( object\.instance[A-Za-z]+, gl\.ARRAY_BUFFER \)/g, "")), `${seg.length} chars`);
  }
  // refusal on a drifted walk premise (Matrix4.compose replaced), then recovery
  EW.__setEntityWorldForTest(true);
  const compose0 = THREE.Matrix4.prototype.compose;
  THREE.Matrix4.prototype.compose = function composePatched(p, q, s) { return compose0.call(this, p, q, s); };
  EW.__resetEntityWorldForTest({ premises: true });
  const refused = quiet(() => EW.installEntityWorldRoot(new THREE.Group()));
  check("walk premise drift (a patched Matrix4.compose) refuses the root walk", refused === false && /compose/.test(EW.entityWorldStats().refused || ""), EW.entityWorldStats().refused);
  THREE.Matrix4.prototype.compose = compose0;
  EW.__resetEntityWorldForTest({ premises: true });
  const g = new THREE.Group();
  check("restored premises: installEntityWorldRoot installs", EW.installEntityWorldRoot(g) === true && EW.entityWorldRootInstalled(g));
  const own = new THREE.Group(); own.updateMatrixWorld = function () {};
  check("a root with an own updateMatrixWorld is refused", EW.installEntityWorldRoot(own) === false);
  EW.__setEntityWorldForTest(undefined);
  // install wiring (2026-10-29): the client's EntityManager gets index.js's scene3dForBuilders, which
  // has no renderer / scene, so the rig build's ensureEntityWorld installs nothing there (Part E);
  // the projection must come from an explicit line in index.js, after the draw executor (the suite's
  // patch order) and once the entities group exists. installEntityWorld is inert with the flag off.
  const ixSrc = readFileSync(process.env.EW_INDEX_SRC || new URL("../scene3d/index.js", import.meta.url), "utf8");
  const ixImport = /import\s*\{[^}]*\binstallEntityWorld\b[^}]*\}\s*from\s*"\.\/entity_world\.js";/.test(ixSrc);
  const ixCall = ixSrc.indexOf("installEntityWorld(renderer, () => scene, () => entitiesGroup)");
  const ixLine = ixCall < 0 ? "" : ixSrc.slice(ixSrc.lastIndexOf("\n", ixCall) + 1, ixSrc.indexOf("\n", ixCall));
  const ixDx = ixSrc.indexOf("installDrawExec(renderer, () => scene)");
  const ixGroups = ixSrc.indexOf("worldRoot.add(terrainGroup, buildingsGroup, staticsGroup, cellsGroup, entitiesGroup)");
  check("install wiring: index.js imports installEntityWorld and calls installEntityWorld(renderer, () => scene, () => entitiesGroup) in a try, after installDrawExec and after the world groups are attached",
    ixImport && ixCall > 0 && /^\s*try \{ installEntityWorld\(/.test(ixLine) && ixDx > 0 && ixGroups > 0 && ixCall > ixDx && ixCall > ixGroups,
    `import ${ixImport}, call @${ixCall}, drawExec @${ixDx}, groups @${ixGroups}`);
  {
    const r = { render() {}, renderLists: { get() {} }, domElement: null, info: { render: { frame: 0 } } };
    const render0 = r.render, get0 = r.renderLists.get;
    const sc0 = new THREE.Scene();
    const obr = sc0.onBeforeRender;
    check("install wiring: installEntityWorld with the flag off returns null and touches nothing (renderer, render lists, scene hook)",
      EW.installEntityWorld(r, () => sc0, () => new THREE.Group()) === null && !("__hbEntityWorld" in r) && r.render === render0 && r.renderLists.get === get0 &&
      sc0.onBeforeRender === obr && !Object.prototype.hasOwnProperty.call(sc0, "onBeforeRender"));
  }
}

// =============================================================================================
// Shared world builder: rigs with every special case. Deterministic; built identically per arm.
// =============================================================================================
const GEOMS = () => [new THREE.BoxGeometry(0.3, 0.3, 0.6), new THREE.SphereGeometry(0.2, 8, 6), new THREE.ConeGeometry(0.15, 0.4, 8), new THREE.CylinderGeometry(0.08, 0.1, 0.4, 6)];
function dataTex(n = 2) { const t = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n); t.needsUpdate = true; return t; }

/**
 * A world: scene → lights, worldRoot (−π/2 about X) → statics / entities groups; rigs under
 * entities. `o.ew` installs the entity walk on every rig root (and held-item root).
 * Returns { scene, worldRoot, statics, entities, rigs, specials, camera, mats }.
 */
function buildWorld(o = {}) {
  const r = rng(o.seed ?? 0x5eed);
  const rnd = (k = 1) => (r() * 2 - 1) * k;
  const quat = () => new THREE.Quaternion(rnd(), rnd(), rnd(), rnd()).normalize();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8899aa, 50, 400);
  const lights = new THREE.Group(); lights.name = "lights"; scene.add(lights);
  lights.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(10, 20, 5); lights.add(sun);
  if (o.shadows) { sun.castShadow = true; sun.shadow.mapSize.set(16, 16); }
  for (let i = 0; i < 3; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30, 2); p.position.set(rnd(30), 3, rnd(30)); lights.add(p); }
  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  worldRoot.userData.__punchPhase = 2;
  const terrain = new THREE.Group(); terrain.name = "terrain"; terrain.userData.__punchPhase = 0;
  const statics = new THREE.Group(); statics.name = "statics";
  const entities = new THREE.Group(); entities.name = "entities";
  worldRoot.add(terrain, statics, entities);
  entities.layers.set(1);
  const G = GEOMS();
  const sMats = [0, 1, 2, 3].map(() => new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.7 }));
  for (let i = 0; i < 24; i++) {
    const m = new THREE.Mesh(G[i % 4], sMats[i % 4]);
    m.position.set(rnd(30), rnd(30), r()); m.updateMatrix(); m.matrixAutoUpdate = i % 2 === 0; m.name = `static-${i}`;
    m.castShadow = !!o.shadows;
    statics.add(m);
  }
  { const t = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ roughness: 1 })); t.position.z = -0.5; t.name = "terrain-surface"; terrain.add(t); }
  const rigs = [];
  const specials = {};
  const mats = [];
  const vgProto = O3D;
  const mkMat = (x = {}) => { const m = new THREE.MeshStandardMaterial({ map: dataTex(), roughness: 0.6, ...x }); mats.push(m); return m; };
  const spriteMat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true });
  const rigGeoms = Array.from({ length: 17 }, (_, p) => G[p % 4]);
  const makeRig = (k, nParts, opts = {}) => {
    const root = new THREE.Group(); root.name = `entity-${k}`;
    root.position.set(rnd(16), rnd(16), 0);
    root.quaternion.setFromAxisAngle(Z, r() * 6.28);
    // visual_ground.js: an own updateMatrix on the root (dz on the matrix only)
    const vg = { dz: (k % 3) * 0.01 };
    root.updateMatrix = function visualGroundUpdateMatrix() { vgProto.updateMatrix.call(this); if (vg.dz !== 0) this.matrix.elements[14] += vg.dz; };
    const parts = [];
    const own = [];
    for (let p = 0; p < nParts; p++) {
      const part = new THREE.Group(); part.name = `part_${p}`;
      part.userData.didDegrade = 0;
      part.position.set(0.05 * p, 0.01 * p, 0.1 * p);
      part.quaternion.copy(quat());
      const ns = p % 5 === 0 ? 2 : 1;
      for (let j = 0; j < ns; j++) {
        let mat;
        if (own.length && r() < 0.3) mat = own[(r() * own.length) | 0]; else { mat = mkMat(); own.push(mat); }
        const m = new THREE.Mesh(rigGeoms[(p + j) % 17], mat);
        m.name = `part_${p}_surface_${j}`;
        m.userData = { guid: 0x50000000 + k, partIndex: p };
        m.castShadow = !!o.shadows;
        part.add(m);
      }
      parts.push(part);
      root.add(part);
    }
    if (opts.nameplate !== false) { const sp = new THREE.Sprite(spriteMat); sp.position.set(0, 0, 2.2); sp.name = "nameplate"; root.add(sp); }
    root.traverse((x) => x.layers.set(1));
    entities.add(root);
    const rec = { root, parts, k, vg, phase: r() * 6.28 };
    rigs.push(rec);
    return rec;
  };
  for (let k = 0; k < (o.rigs ?? 8); k++) makeRig(k, k % 3 === 2 ? 6 : 17);
  // ---- special cases (identical in every arm) ----
  if (rigs.length >= 5 && o.specials !== false) addSpecials();
  function addSpecials() {
  const R0 = rigs[0], R1 = rigs[1], R2 = rigs[2], R3 = rigs[3];
  // a held item: a nested rig root under a hand part (its own entity walk in B)
  {
    const item = new THREE.Group(); item.name = "held-item";
    item.position.set(0.02, 0, 0.1);
    for (let p = 0; p < 2; p++) { const g = new THREE.Group(); g.name = `item_part_${p}`; g.position.set(0, 0, 0.2 * p); g.add(new THREE.Mesh(G[3], mkMat())); item.add(g); }
    item.traverse((x) => x.layers.set(1));
    R0.parts[5].add(item);
    specials.held = item;
  }
  // light, camera, sprite, InstancedMesh, SkinnedMesh, a mesh with a child under parts
  {
    const pl = new THREE.PointLight(0x66ccff, 1, 6, 2); pl.name = "part-light"; pl.layers.set(1); R0.parts[2].add(pl); specials.light = pl;
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); cam.name = "part-camera"; cam.layers.set(1); R1.parts[1].add(cam); specials.cam = cam;
    const im = new THREE.InstancedMesh(G[1], mkMat(), 3);
    for (let i = 0; i < 3; i++) im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 0.1, 0, 0));
    im.name = "part-instanced"; im.layers.set(1); R1.parts[3].add(im); specials.inst = im;
    const bones = [new THREE.Bone(), new THREE.Bone()]; bones[0].add(bones[1]); bones[1].position.y = 0.2;
    const sg = new THREE.BoxGeometry(0.1, 0.4, 0.1);
    const n = sg.attributes.position.count;
    sg.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    sg.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const sk = new THREE.SkinnedMesh(sg, mkMat());
    sk.add(bones[0]); sk.bind(new THREE.Skeleton(bones));
    sk.name = "part-skinned"; sk.traverse((x) => x.layers.set(1)); R1.parts[4].add(sk); specials.skinned = sk;
    const parentMesh = R2.parts[1].children[0];
    const childMesh = new THREE.Mesh(G[2], mkMat()); childMesh.name = "mesh-child"; childMesh.position.set(0, 0, 0.1); childMesh.layers.set(1);
    parentMesh.add(childMesh); specials.meshChild = childMesh;
  }
  // non-identity meshes: an offset one, a −0-positioned one, a scaled one; a pivot part and a pivot mesh
  {
    R2.parts[2].children[0].position.set(0.02, 0, -0.01);
    R2.parts[3].children[0].position.set(0, -0, 0);
    R2.parts[4].children[0].scale.set(1, 1.5, 1);
    R3.parts[1].pivot = new THREE.Vector3(0.05, 0, 0.1);
    R3.parts[2].children[0].pivot = new THREE.Vector3(0, 0.02, 0);
  }
  // flags: a part with matrixAutoUpdate off, a mesh with matrixWorldAutoUpdate off, a frozen
  // part whose world matrix holds −0 / NaN / Infinity (its identity meshes must multiply)
  {
    const pa = R3.parts[3]; pa.updateMatrix(); pa.matrixAutoUpdate = false; specials.noAuto = pa;
    const mw = R3.parts[4].children[0]; mw.matrixWorldAutoUpdate = false; specials.noWorldAuto = mw;
    const fr = R3.parts[5]; specials.frozen = fr;
  }
  // entity-only geometries (no static, no other rig draws them) for the in-place attribute events
  {
    R0.parts[0].children[0].geometry = R0.parts[0].children[0].geometry.clone();
    rigs[5].parts[2].children[0].geometry = rigs[5].parts[2].children[0].geometry.clone();
    specials.ownGeomA = R0.parts[0].children[0];
    specials.ownGeomB = rigs[5].parts[2].children[0];
    // never frustum-culled: three runs objects.update for them on every frame they are drawn
    specials.ownGeomA.frustumCulled = false;
    specials.ownGeomB.frustumCulled = false;
  }
  // a multi-material mesh (geometry groups) and a frustumCulled=false mesh
  {
    const mm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), [mkMat(), mkMat(), mkMat(), mkMat(), mkMat(), mkMat()]);
    mm.name = "multi-material"; mm.layers.set(1); R3.parts[6].add(mm); specials.multi = mm;
    R3.parts[7].children[0].frustumCulled = false;
  }
  }
  // parts with an own updateMatrixWorld in one rig (three's body, called through an own
  // property): the entity walk hands such a part to it. This stood for ?rigMeshAlias's part
  // walk until that flag was deleted (round 3 R3-2, 2026-10-30).
  if (o.ownPartWalk) {
    const umw = THREE.Object3D.prototype.updateMatrixWorld;
    for (const p of rigs[4].parts) p.updateMatrixWorld = function ownPartUpdateMatrixWorld(force) { umw.call(this, force); };
  }
  if (o.ew) {
    EW.__setEntityWorldForTest(true);
    for (const rec of rigs) EW.installEntityWorldRoot(rec.root);
    if (specials.held) EW.installEntityWorldRoot(specials.held);
  }
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 300);
  camera.layers.enableAll();
  return { scene, worldRoot, statics, entities, rigs, specials, camera, mats, G, makeRig, mkMat };
}

/** Per-frame motion: raw part poses (as ?rustRig writes them), root moves, the visual-ground dz. */
function poseWorld(W, f) {
  for (let i = 0; i < W.rigs.length; i++) {
    const rec = W.rigs[i];
    rec.root.position.x += Math.sin(f * 0.05 + rec.phase) * 0.01;
    rec.vg.dz = ((f + i) % 4) * 0.005;
    const parts = rec.parts;
    for (let p = 0; p < parts.length; p++) {
      const g = parts[p];
      if (g === W.specials.noAuto || g === W.specials.frozen) continue;
      const a = f * 0.07 + p * 0.3 + rec.phase;
      g.position.x = 0.05 * p + Math.sin(a) * 0.01; g.position.z = 0.1 * p + Math.cos(a) * 0.01;
      const c = Math.cos(a * 0.5), s = Math.sin(a * 0.5);
      const q = g.quaternion; q._x = s * 0.6; q._y = s * 0.8; q._z = 0; q._w = c;
    }
  }
}

// node-state comparison: matrix, matrixWorld (Object.is per element), matrixWorldNeedsUpdate
function nodesOf(root) { const out = []; root.traverse((o) => out.push(o)); return out; }
function firstNodeDiff(A, B) {
  const na = nodesOf(A.scene), nb = nodesOf(B.scene);
  if (na.length !== nb.length) return `node count ${na.length} vs ${nb.length}`;
  for (let i = 0; i < na.length; i++) {
    const x = na[i], y = nb[i];
    if (x.type !== y.type || x.name !== y.name) return `node ${i}: shape ${x.type} ${x.name} vs ${y.type} ${y.name}`;
    for (const k of ["matrix", "matrixWorld"]) {
      const ea = x[k].elements, eb = y[k].elements;
      for (let j = 0; j < 16; j++) if (!Object.is(ea[j], eb[j])) return `node ${i} (${x.type} ${x.name}) ${k}[${j}] ${ea[j]} vs ${eb[j]}`;
    }
    if (x.matrixWorldNeedsUpdate !== y.matrixWorldNeedsUpdate) return `node ${i} (${x.type} ${x.name}) matrixWorldNeedsUpdate ${x.matrixWorldNeedsUpdate} vs ${y.matrixWorldNeedsUpdate}`;
    if (x.isSkinnedMesh && !Object.is(x.bindMatrixInverse.elements[12], y.bindMatrixInverse.elements[12])) return `node ${i} bindMatrixInverse`;
    if (x.isCamera) for (let j = 0; j < 16; j++) if (!Object.is(x.matrixWorldInverse.elements[j], y.matrixWorldInverse.elements[j])) return `node ${i} matrixWorldInverse[${j}]`;
  }
  return null;
}

// =============================================================================================
// W — the walk: A = three's walk, B = the entity walk
// =============================================================================================
if (!BENCH) console.log("\nPART W — the entity walk vs three's walk, every node after every walk");
if (!BENCH) {
  EW.__resetEntityWorldForTest();
  const A = buildWorld({ ownPartWalk: true });
  const B = buildWorld({ ownPartWalk: true, ew: true });
  const st0 = EW.entityWorldStats();
  check("W: every rig root + the held item got the entity walk", st0.roots === A.rigs.length + 1, `${st0.roots} roots`);
  let bad = null, walks = 0;
  const both = (fn) => { fn(A); fn(B); };
  const walk = (tag, how = "scene") => {
    if (bad) return;
    if (how === "scene") { A.scene.updateMatrixWorld(); B.scene.updateMatrixWorld(); }
    else if (how === "direct") { A.rigs[2].root.updateMatrixWorld(true); B.rigs[2].root.updateMatrixWorld(true); }
    walks += 1;
    const d = firstNodeDiff(A, B);
    if (d) bad = `${tag}: ${d}`;
  };
  let f = 0;
  const frames = (tag, n) => { for (let i = 0; i < n && !bad; i++, f++) { both((W) => poseWorld(W, f)); walk(`${tag} f${f}`); } };
  frames("poses + root moves", 6);
  both((W) => { W.rigs[1].root.visible = false; W.rigs[2].parts[3].visible = false; W.rigs[0].parts[1].children[0].visible = false; });
  frames("hidden root / part / mesh", 4);
  both((W) => { W.rigs[2].parts[3].position.x += 0.5; }); // moved while hidden
  both((W) => { W.rigs[1].root.visible = true; W.rigs[2].parts[3].visible = true; W.rigs[0].parts[1].children[0].visible = true; });
  frames("shown again (the whole subtree recomputed)", 3);
  // a direct root.updateMatrixWorld(true) outside a scene walk: hidden nodes are updated there
  both((W) => { W.rigs[2].parts[4].visible = false; });
  if (!bad) { both((W) => poseWorld(W, f)); walk("direct root walk with a hidden part", "direct"); }
  frames("after the direct walk", 2);
  both((W) => { W.rigs[2].parts[4].visible = true; });
  // skip_hidden live seam off / on
  window.__skipHiddenMatrix.on = false;
  both((W) => { W.rigs[5].root.visible = false; });
  frames("skip_hidden live seam off (hidden nodes walked)", 3);
  window.__skipHiddenMatrix.on = true;
  both((W) => { W.rigs[5].root.visible = true; });
  frames("seam back on", 2);
  // unclean part worlds: a frozen part with −0 / NaN / ±Infinity in its world matrix
  both((W) => { const p = W.specials.frozen; p.matrixWorldAutoUpdate = false; p.matrixWorld.elements[1] = -0; p.matrixWorld.elements[4] = -0; });
  frames("frozen part, −0 in its world matrix", 2);
  both((W) => { const p = W.specials.frozen; p.matrixWorld.elements[2] = NaN; p.matrixWorld.elements[6] = Infinity; p.matrixWorld.elements[9] = -Infinity; });
  frames("frozen part, NaN / ±Infinity in its world matrix", 2);
  both((W) => { const p = W.specials.frozen; p.matrixWorldAutoUpdate = true; });
  frames("thawed", 2);
  // dislocation (quaternion + position writes on a mesh), its heal; scale / applyMatrix4 / Euler writes
  both((W) => { const m = W.rigs[0].parts[3].children[0]; m.position.set(0.03, -0.01, 0); m.quaternion.setFromAxisAngle(Z, 0.4); });
  frames("dislocated mesh", 2);
  both((W) => { const m = W.rigs[0].parts[3].children[0]; m.position.set(0, 0, 0); m.quaternion.identity(); });
  frames("healed (identity again)", 2);
  both((W) => { const m = W.rigs[0].parts[6].children[0]; m.scale.set(1.2, 1, 1); W.rigs[0].parts[7].children[0].applyMatrix4(new THREE.Matrix4().makeRotationZ(0.3)); W.rigs[0].parts[8].children[0].rotation.set(0.1, 0.2, 0.3); });
  frames("scale / applyMatrix4 / Euler writes", 2);
  // reparent part → part, detach to the entities group (debris) and back, a new mesh added, a part removed
  both((W) => { const m = W.rigs[6].parts[2].children[0]; W.rigs[6].parts[9].add(m); });
  frames("mesh reparented part → part", 2);
  both((W) => { const m = W.rigs[6].parts[9].children[W.rigs[6].parts[9].children.length - 1]; W.entities.attach(m); W.specials.debris = m; });
  frames("mesh attached to the entities group (debris)", 2);
  both((W) => { W.rigs[6].parts[2].attach(W.specials.debris); });
  frames("debris re-attached to its part", 2);
  both((W) => { const m = new THREE.Mesh(W.G[0], W.mkMat()); m.name = "added"; m.layers.set(1); W.rigs[7].parts[1].add(m); W.rigs[7].root.remove(W.rigs[7].parts[0]); });
  frames("mesh added, part removed", 2);
  // matrixAutoUpdate toggles on parts / meshes, pivot changes
  both((W) => { W.specials.noAuto.matrixAutoUpdate = true; W.specials.noWorldAuto.matrixWorldAutoUpdate = true; W.rigs[3].parts[1].pivot = null; W.rigs[2].parts[5].pivot = new THREE.Vector3(0.1, 0, 0); });
  frames("flags + pivots changed", 2);
  // the walk census: B must leave every node to the patched method so it is counted
  const fb0 = EW.entityWorldStats().walkFallbacks;
  SH.startWalkCensus();
  for (let i = 0; i < 2; i++, f++) { both((W) => poseWorld(W, f)); A.scene.updateMatrixWorld(); B.scene.updateMatrixWorld(); walks += 1; if (!bad) { const d = firstNodeDiff(A, B); if (d) bad = `walk census f${f}: ${d}`; } }
  const census = SH.stopWalkCensus();
  check("W: during the census every root walk was handed to three (counted)", EW.entityWorldStats().walkFallbacks - fb0 >= 2 * B.rigs.length && census && census.visited > 0, `${EW.entityWorldStats().walkFallbacks - fb0} fallbacks`);
  // live walkOff
  window.__entityWorld.walkOff = true;
  frames("walkOff (three's walk)", 2);
  window.__entityWorld.walkOff = false;
  frames("walkOff cleared", 3);
  // a full render() walk (renderer calls scene.updateMatrixWorld) is covered in Part R
  const st = EW.entityWorldStats();
  check(`W: ${walks} walks — every node's matrix / matrixWorld / matrixWorldNeedsUpdate identical (Object.is)`, bad === null, bad ?? "");
  check("W: the entity walk ran, served identity meshes by copy and met unclean part worlds", st.walks > 0 && st.identity > 0 && st.unclean > 0, `walks ${st.walks} identity ${st.identity} unclean ${st.unclean}`);
}

// =============================================================================================
// R — the projection (+ walk) through three's real renderer, the full GL stream
// =============================================================================================
function fnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
function val(v) {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "string") return v.length <= 40 ? JSON.stringify(v) : `str${v.length}#${fnv(Buffer.from(v))}`;
  if (typeof v === "function") return "fn";
  if (ArrayBuffer.isView(v)) { if (v.length <= 32) return `[${Array.from(v).join(",")}]`; return `ta${v.length}#${fnv(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`; }
  if (Array.isArray(v)) return `[${v.map(val).join(",")}]`;
  if (typeof v === "object") { if (v.__kind === "loc") return `loc:${v.name}`; if (v.__kind !== undefined) return `${v.__kind}#${v.__id}`; return `{${Object.keys(v).sort().map((k) => `${k}:${val(v[k])}`).join(",")}}`; }
  return String(v);
}
const win = (a, off, n) => `[${Array.from(a.subarray ? a.subarray(off, off + n) : a.slice(off, off + n)).join(",")}]`;
function ser(name, a) {
  switch (name) {
    case "multiDrawElementsWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[6])},${a[3]},${win(a[4], a[5], a[6])},${a[6]})`;
    case "multiDrawArraysWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[5])},${win(a[3], a[4], a[5])},${a[5]})`;
    case "multiDrawElementsInstancedWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[8])},${a[3]},${win(a[4], a[5], a[8])},${win(a[6], a[7], a[8])},${a[8]})`;
    case "multiDrawArraysInstancedWEBGL": return `${name}(${a[0]},${win(a[1], a[2], a[7])},${win(a[3], a[4], a[7])},${win(a[5], a[6], a[7])},${a[7]})`;
    default: { let s = `${name}(`; for (let i = 0; i < a.length; i++) s += (i ? "," : "") + val(a[i]); return s + ")"; }
  }
}
function restorableCanvas(gl, width = 640, height = 480) {
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
function phaseOf(obj) {
  const c = obj.__hbPunchPhase;
  if (c !== undefined) return c;
  let p = 0;
  for (let o = obj; o; o = o.parent) { const t = o.userData?.__punchPhase; if (t !== undefined) { p = t; break; } }
  obj.__hbPunchPhase = p;
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

/** One arm: fake context (logging) + renderer + the production patch chain + a world. */
function makeArm(flagOn, sc, { log = true } = {}) {
  const calls = [];
  let logging = false;
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32, clipControl: true, onCall: log ? (name, args) => { if (logging) calls.push(ser(name, args)); } : undefined });
  const G = log ? gl : gl.__fake.plain();
  const canvas = restorableCanvas(G);
  const renderer = new THREE.WebGLRenderer({ canvas, context: G, ...depthRendererParams("reversed") });
  installReversedZ(THREE, renderer);
  renderer.capabilities.maxTextures = G.getParameter(G.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
  installDrawSortProgram(renderer);
  setDrawSortPhase(renderer, phaseOf, phaseOnlySort);
  installDepthBandSort(renderer, { perOctave: sc.bands || 0 });
  if (sc.shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
  const W = buildWorld({ ...sc, ew: flagOn });
  installAsyncLinkGuard(renderer, () => W.scene);
  if (sc.shadows) installShadowCasterList(renderer, { force: true });
  SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
  RUNS.installBatchedRuns(renderer);
  const dx = DX.installDrawExec(renderer, () => W.scene, { force: true, rigs: true });
  let ew = null;
  if (flagOn) {
    EW.__setEntityWorldForTest(true);
    ew = EW.installEntityWorld(renderer, () => W.scene, () => W.entities);
  }
  // the sorted render list of each main-scene render (object index, material index, z, orders)
  const ids = new WeakMap();
  let nid = 0;
  W.scene.traverse((o) => ids.set(o, nid++));
  W.mats.forEach((m, i) => ids.set(m, 100000 + i));
  const lists = [];
  const lget = renderer.renderLists.get;
  const seen = new WeakSet();
  renderer.renderLists.get = function (scene, depth) {
    const list = lget.call(this, scene, depth);
    if (list && !seen.has(list) && scene === W.scene) {
      seen.add(list);
      const s0 = list.sort;
      list.sort = function (a, b) {
        const r = s0.call(this, a, b);
        const idOf = (o) => { if (!ids.has(o)) ids.set(o, nid++); return ids.get(o); };
        const snap = (arr) => arr.map((it) => `${idOf(it.object)}:${idOf(it.material)}:${val(it.z)}:${it.groupOrder}:${it.renderOrder}:${it.group ? it.group.start : "-"}`).join(" ");
        lists.push(`O[${snap(this.opaque)}] T[${snap(this.transparent)}]`);
        return r;
      };
    }
    return list;
  };
  return {
    gl: G, canvas, renderer, W, dx, ew, calls, lists, ids,
    startLog() { calls.length = 0; lists.length = 0; logging = true; },
    stopLog() { logging = false; return { calls: calls.slice(), lists: lists.slice() }; },
  };
}
async function settle(arm) {
  const api = arm.renderer.__hbAsyncLink;
  await sleep(8);
  for (let i = 0; i < 400 && api && (api.pending > 0 || api.stats.inFlight > 0); i++) await sleep(4);
}
function renderOnce(arm, sc) {
  const { renderer, W } = arm;
  const out = [];
  if (sc.split) {
    for (const [p, mask] of [[0, 1], [1, 2]]) {
      W.camera.layers.mask = mask;
      renderer.autoClear = p === 0;
      if (p > 0) renderer.clearDepth();
      renderer.render(W.scene, W.camera);
      const i = renderer.info.render; out.push(`calls=${i.calls} tri=${i.triangles}`);
    }
    W.camera.layers.enableAll();
    return out;
  }
  renderer.render(W.scene, sc.arrayCamera ? W.arrayCam : W.camera);
  const i = renderer.info.render; out.push(`calls=${i.calls} tri=${i.triangles}`);
  return out;
}
function moveCamera(W, f) {
  W.camera.position.set(Math.sin(f * 0.3) * 18, 12 + Math.cos(f * 0.2) * 3, 18 + Math.sin(f * 0.17) * 6);
  W.camera.lookAt(0, 0, 0);
  W.camera.updateMatrixWorld();
  if (W.subCams) for (let i = 0; i < 2; i++) { const c = W.subCams[i]; c.position.copy(W.camera.position).add(new THREE.Vector3(i - 0.5, 0, 0)); c.lookAt(0, 0, 0); c.updateMatrixWorld(); c.matrixWorldInverse.copy(c.matrixWorld).invert(); }
}

/** Scripted events, applied identically to both arms before frame f. */
function events(arm, f, sc) {
  const W = arm.W, S = W.specials, ev = sc.events || {};
  const at = (k) => ev[k] === f;
  if (at("versionBump")) { const g = W.specials.ownGeomA.geometry; g.attributes.uv.needsUpdate = true; }
  if (at("attrAddInPlace")) { const g = W.specials.ownGeomB.geometry; g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0.25), 3)); }
  if (at("attrDeleteInPlace")) { W.specials.ownGeomB.geometry.deleteAttribute("color"); }
  if (at("attrSwapInPlace")) { const g = W.specials.ownGeomA.geometry; g.setAttribute("uv", g.attributes.uv.clone()); }
  if (at("attrReplace")) { const m = W.rigs[1].parts[2].children[0]; m.geometry = m.geometry.clone(); m.geometry.setAttribute("uv", m.geometry.attributes.uv.clone()); }
  if (at("attrAdd")) { const m = W.rigs[2].parts[1].children[0]; const g = m.geometry = m.geometry.clone(); g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0.5), 3)); }
  if (at("attrDelete")) { const m = W.rigs[2].parts[1].children[0]; m.geometry.deleteAttribute("color"); }
  if (at("geomSwap")) { const m = W.rigs[3].parts[8].children[0]; m.geometry = W.G[(f % 3) + 1]; }
  if (at("dispose")) { const m = W.rigs[4].parts[2].children[0]; const g = m.geometry = m.geometry.clone(); W.disposedG = g; }
  if (ev.dispose !== undefined && f === ev.dispose + 2) W.disposedG.dispose(); // disposed while drawn, drawn again
  if (at("matInvisible")) W.rigs[5].parts[1].children[0].material.visible = false;
  if (at("matVisible")) W.rigs[5].parts[1].children[0].material.visible = true;
  if (at("bsNull")) { const m = W.rigs[0].parts[4].children[0]; m.geometry = m.geometry.clone(); m.geometry.boundingSphere = null; m.frustumCulled = false; }
  // three's update memo (once per info.render.frame value) is set by a shadow raster AFTER frame++,
  // so the next render's first visit to a caster's geometry uploads nothing (stock too); with no
  // raster in that render, stock uploads in the one after. Entity-only, never frustum-culled casters.
  if (at("memoDispose")) W.specials.ownGeomA.geometry.dispose(); // disposed while drawn (animation.js EVICT-DISPOSE)
  if (at("memoBump")) W.specials.ownGeomB.geometry.attributes.uv.needsUpdate = true;
  if (at("memoSibling")) {
    // a mesh with ANOTHER program sharing the disposed geometry comes into view: its VAO is built
    // from whatever buffers three holds by now
    const mat = new THREE.MeshBasicMaterial({ color: 0x55aa77 }); W.mats.push(mat); arm.ids.set(mat, 200000 + f);
    const s = new THREE.Mesh(W.specials.ownGeomA.geometry, mat); s.name = "memo-sibling"; s.layers.set(1); s.castShadow = true; s.frustumCulled = false;
    W.rigs[6].parts[1].add(s); arm.ids.set(s, 300000 + f);
  }
  if (at("nanPose")) {
    // NaN world matrices → NaN sort keys: three's comparator is then inconsistent and the sorted
    // order depends on the input order, so every push must land at three's pre-order position.
    // rigs[0] carries hot nodes (a light, a held item) ahead of the NaN part's cold meshes.
    const p = W.rigs[6].parts[3]; p.position.set(NaN, 0, 0); W.nanPart = p;
    const p2 = W.rigs[0].parts[7]; p2.position.set(0, NaN, 0); W.nanPart2 = p2;
    // rigs[2].parts[1]'s first mesh has a child (always HOT); a later part's cold mesh takes its
    // material and a NaN pose: equal sort keys up to z, an inconsistent z — input order decides.
    const hotM = W.rigs[2].parts[1].children[0];
    const coldM = W.rigs[2].parts[5].children[0];
    coldM.material = hotM.material;
    W.rigs[2].parts[5].position.set(NaN, 0, 0); W.nanPart3 = W.rigs[2].parts[5];
  }
  if (at("nanHeal") && W.nanPart) { W.nanPart.position.set(0.1, 0, 0); W.nanPart2.position.set(0, 0.1, 0); W.nanPart3.position.set(0, 0, 0.1); }
  if (at("renderOrder")) { W.rigs[1].parts[6].renderOrder = 3; W.rigs[2].root.renderOrder = -2; W.rigs[0].parts[2].renderOrder = 5; }
  if (at("renderOrderClear")) { W.rigs[1].parts[6].renderOrder = 0; W.rigs[2].root.renderOrder = 0; W.rigs[0].parts[2].renderOrder = 0; }
  if (at("layerMix")) {
    // a root on layer 1 with renderOrder 4, whose nameplate and one mesh (under a layer-1 part) sit
    // on layer 0: in the layer-0 pass the root and the part fail their layers test, so three
    // gives those two the groupOrder from ABOVE the root
    const rec = W.rigs[1];
    rec.root.renderOrder = 4;
    rec.parts[2].children[0].layers.set(0);
    for (const c of rec.root.children) if (c.isSprite) c.layers.set(0);
  }
  if (at("groupRenderOrder")) W.entities.renderOrder = 1; // the groupOrder three passes INTO the entities group's children
  if (at("groupRenderOrderClear")) W.entities.renderOrder = 0;
  if (at("fade")) { const m = W.rigs[7].parts[1].children[0]; m.material = m.material.clone(); m.material.transparent = true; m.material.opacity = 0.5; W.mats.push(m.material); arm.ids.set(m.material, 200000 + f); }
  if (at("hideRoot")) { W.rigs[3].root.visible = false; W.rigs[4].parts[5].visible = false; W.rigs[5].parts[0].children[0].visible = false; }
  if (at("showRoot")) { W.rigs[3].root.visible = true; W.rigs[4].parts[5].visible = true; W.rigs[5].parts[0].children[0].visible = true; }
  if (at("layer")) { W.rigs[0].parts[9].children[0].layers.set(2); W.rigs[1].parts[7].layers.set(0); }
  if (at("debris")) { const m = W.rigs[6].parts[5].children[0]; W.entities.attach(m); }
  if (at("addRig")) { const rec = W.makeRig(100 + f, 6, { nameplate: true }); if (arm.ew) EW.installEntityWorldRoot(rec.root); rec.root.traverse((o) => { if (!arm.ids.has(o)) arm.ids.set(o, 300000 + f * 100 + (arm.__n = (arm.__n || 0) + 1)); }); }
  if (at("removeRig")) { W.entities.remove(W.rigs[2].root); }
  if (at("projOff") && arm.ew) window.__entityWorld.projOff = true;
  if (at("projOn") && arm.ew) window.__entityWorld.projOff = false;
  if (at("sortOff")) arm.renderer.sortObjects = false;
  if (at("sortOn")) arm.renderer.sortObjects = true;
  if (at("nested")) {
    const mini = new THREE.Scene(); mini.add(new THREE.Mesh(W.G[0], new THREE.MeshBasicMaterial({ color: 0xff00ff })));
    const miniCam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); miniCam.position.z = 3;
    const rt = new THREE.WebGLRenderTarget(8, 8);
    W.rigs[0].parts[0].children[0].onBeforeRender = (renderer) => { const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(mini, miniCam); renderer.setRenderTarget(prev); };
  }
}

async function runArm(flagOn, sc) {
  RUNS.__resetBatchedRunsFrameForTest();
  RUNS.__resetStableForTest();
  const arm = makeArm(flagOn, sc);
  if (sc.arrayCamera) {
    arm.W.subCams = [0, 1].map((i) => { const c = new THREE.PerspectiveCamera(60, 2 / 3, 0.1, 300); c.viewport = new THREE.Vector4(i * 320, 0, 320, 480); c.layers.enableAll(); return c; });
    arm.W.arrayCam = new THREE.ArrayCamera(arm.W.subCams);
    arm.W.arrayCam.fov = 60; arm.W.arrayCam.aspect = 4 / 3; arm.W.arrayCam.near = 0.1; arm.W.arrayCam.far = 300; arm.W.arrayCam.updateProjectionMatrix();
    arm.W.arrayCam.layers.enableAll();
    arm.W.subCams[1].layers.set(0);
  }
  const frames = [];
  const errs = [];
  for (let f = 0; f < sc.frames; f++) {
    poseWorld(arm.W, f);
    moveCamera(arm.W, f);
    if (sc.arrayCamera) { arm.W.arrayCam.position.copy(arm.W.camera.position); arm.W.arrayCam.quaternion.copy(arm.W.camera.quaternion); arm.W.arrayCam.updateMatrixWorld(); }
    events(arm, f, sc);
    if (sc.events?.restore === f) quiet(() => arm.canvas.loseAndRestore());
    if (sc.events?.throwAt === f) {
      // a node inside a rig whose `layers` throws once: projectObject throws mid-traversal
      const bomb = new THREE.Object3D(); bomb.name = "bomb";
      let armed = true;
      Object.defineProperty(bomb, "layers", { get() { if (armed) { armed = false; throw new Error("bomb"); } return arm.W.camera.layers; } });
      arm.W.rigs[1].parts[0].add(bomb);
      arm.bomb = bomb;
    }
    if (sc.shadowGate) {
      // lighting.js RP5 static-shadow gate: autoUpdate off, a raster only on some frames
      arm.renderer.shadowMap.autoUpdate = false;
      arm.renderer.shadowMap.needsUpdate = sc.shadowGate.includes(f);
    }
    arm.startLog();
    let counters;
    try { counters = renderOnce(arm, sc); } catch (e) { counters = [`threw ${e.message}`]; errs.push(f); }
    if (arm.bomb && sc.events?.throwAt === f) { arm.bomb.parent.remove(arm.bomb); arm.bomb = null; }
    const realKids = arm.W.entities.children.every((c) => c.isObject3D === true && c.parent === arm.W.entities);
    const pool = poolEmpty(arm.ew);
    await settle(arm);
    frames.push({ ...arm.stopLog(), counters, realKids, pool });
  }
  return { arm, frames, errs };
}
function firstStreamDiff(A, B) {
  for (let f = 0; f < A.frames.length; f++) {
    const a = A.frames[f].calls, b = B.frames[f].calls;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        const ctx = (arr) => arr.slice(Math.max(0, i - 3), i + 2).map((s, k) => `${Math.max(0, i - 3) + k === i ? ">>" : "  "} ${s === undefined ? "(end)" : s.slice(0, 150)}`).join("\n      ");
        return `frame ${f} call ${i} (stock ${a.length}, flag ${b.length})\n    stock:\n      ${ctx(a)}\n    flag:\n      ${ctx(b)}`;
      }
    }
    if (A.frames[f].counters.join() !== B.frames[f].counters.join()) return `frame ${f} renderer.info ${A.frames[f].counters} vs ${B.frames[f].counters}`;
    const la = A.frames[f].lists, lb = B.frames[f].lists;
    if (la.length !== lb.length) return `frame ${f}: ${la.length} vs ${lb.length} sorted lists`;
    for (let k = 0; k < la.length; k++) if (la[k] !== lb[k]) return `frame ${f} render list ${k} differs:\n    stock ${la[k].slice(0, 300)}\n    flag  ${lb[k].slice(0, 300)}`;
  }
  return null;
}

async function scenario(name, sc, expect = {}) {
  if (process.env.EW_ONLY && !name.includes(process.env.EW_ONLY)) return;
  console.log(`\nSCENARIO ${name}`);
  EW.__resetEntityWorldForTest();
  const A = await runArm(false, sc);
  const s0 = EW.entityWorldStats();
  const B = await runArm(true, sc);
  const s = EW.entityWorldStats();
  window.__entityWorld && (window.__entityWorld.projOff = false);
  const d = firstStreamDiff(A, B);
  const total = A.frames.reduce((x, fr) => x + fr.calls.length, 0);
  check(`${name}: GL call stream + renderer.info + sorted render lists identical over ${sc.frames} frames`, d === null, d ?? `${total} GL calls compared`);
  const dn = firstNodeDiff(A.arm.W, B.arm.W);
  check(`${name}: every node's matrices identical after the last frame`, dn === null, dn ?? "");
  check(`${name}: the stand-in never outlives a render (entities group holds its real children, the pool holds no node, every frame)`,
    B.frames.every((fr) => fr.realKids && fr.pool), `${B.frames.filter((fr) => !fr.pool).length} frames with a non-empty pool`);
  check(`${name}: same frames threw in both arms`, JSON.stringify(A.errs) === JSON.stringify(B.errs), `${JSON.stringify(A.errs)} vs ${JSON.stringify(B.errs)}`);
  const dd = (k) => s[k] - s0[k];
  console.log(`    flag arm: renders ${dd("renders")} rigs ${dd("rigs")} cold ${dd("cold")} hot ${dd("hot")} carriers ${dd("carriers")} walks ${dd("walks")} identity ${dd("identity")} lateRestores ${dd("lateRestores")}`);
  if (expect.cold !== false) check(`${name}: the projection pushed cold meshes and the walk ran`, dd("cold") > 0 && dd("walks") > 0, `cold ${dd("cold")} walks ${dd("walks")}`);
  if (expect.carriers) check(`${name}: groupOrder carriers used`, dd("carriers") > 0, `${dd("carriers")}`);
  if (expect.late) check(`${name}: the throw was caught by the late restore`, dd("lateRestores") > 0, `${dd("lateRestores")}`);
  return { A, B };
}

if (!BENCH) {
console.log("\nPART R — projection + walk through three's renderer: the full GL stream");
await scenario("baseline (moving camera, rigs + nameplates + statics, drawExec rigs)", { frames: 8 });
await scenario("geometry events (version bump, attribute replaced / added / deleted — on clones and in place —, geometry swapped, disposed + redrawn, null boundingSphere)", {
  frames: 16, events: { versionBump: 3, attrReplace: 4, attrAdd: 5, attrDelete: 7, geomSwap: 8, dispose: 9, bsNull: 10, attrAddInPlace: 11, attrDeleteInPlace: 13, attrSwapInPlace: 14 },
});
await scenario("visibility + materials (hidden root / part / mesh, material.visible, a fade to transparent, layers, NaN pose, debris, rigs added / removed)", {
  frames: 14, events: { matInvisible: 2, matVisible: 4, hideRoot: 3, showRoot: 6, fade: 5, layer: 7, nanPose: 8, nanHeal: 10, debris: 9, addRig: 11, removeRig: 12 },
});
await scenario("renderOrder on parts / roots / the entities group (groupOrder carriers)", { frames: 9, events: { renderOrder: 2, renderOrderClear: 5, groupRenderOrder: 6, groupRenderOrderClear: 8 } }, { carriers: true });
await scenario("indoor split (two render() per frame, layer masks, nodes on the other layer) + depth bands", { frames: 7, split: true, bands: 1, events: { layerMix: 2 } });
await scenario("shadows (the shadow pass over the real graph after the stand-in is restored)", { frames: 7, shadows: true });
await scenario("shadow memo (gated rasters at R0 R1 R5 R8: a geometry disposed and one version-bumped right after a raster; a sibling with another program sharing the disposed geometry; a bump and a throw inside projectObject right after a raster)", {
  frames: 10, shadows: true, shadowGate: [0, 1, 5, 8], events: { memoDispose: 2, memoBump: 2, memoSibling: 4, versionBump: 6, throwAt: 6 },
}, { late: true });
await scenario("context loss + restore (every cold record expires; three re-uploads)", { frames: 9, events: { restore: 4 } });
await scenario("live projOff toggle + renderer.sortObjects false", { frames: 10, events: { projOff: 2, projOn: 4, sortOff: 6, sortOn: 8 } });
await scenario("ArrayCamera (sub-cameras, different layers)", { frames: 6, arrayCamera: true });
await scenario("a nested render inside an entity mesh's onBeforeRender", { frames: 6, events: { nested: 2 } });
await scenario("a throw inside projectObject (the stand-in restored, the next frames identical)", { frames: 6, events: { throwAt: 3 } }, { late: true });
}

// =============================================================================================
// E — the real spawn path (EntityManager, fake wasm): the rig build installs both halves
// =============================================================================================
// (EW_MODULE mutants: Part E spawns through entities.js, which imports the real module — skipped)
const RUN_E = !BENCH && !process.env.EW_MODULE;
if (RUN_E) console.log("\nPART E — EntityManager rigs through the real spawn path, flag off vs on");
if (RUN_E) {
  const gen = await import("../tools/rust_parity/gen_rig.mjs");
  const descs = gen.buildRigDescriptors();
  const byName = (n) => descs.find((x) => x.name === n).desc;
  const READY = 0x41000003, WALK = 0x45000005;
  const clips = { [READY]: byName("human-17p-identity-root"), [WALK]: byName("human-17p-run") };
  const partMesh = (p) => ({
    triCount: 1,
    positions: new Float32Array([p * 0.1, 0, 0, p * 0.1 + 0.5, 0, 0, p * 0.1 + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234 + (p % 3)]),
  });
  const wasmExports = {
    async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
      const d = (fromMotion >>> 0) ? null : clips[cmd >>> 0];
      const n = d ? d.numFrames : 0;
      const meshes = Array.from({ length: 17 }, (_, p) => partMesh(p));
      const out = {
        partCount: 17, numFrames: n, framerate: n ? 30 : 0, duration: n / 30, frameTimes: Float32Array.from({ length: n }, (_, f) => f / 30),
        segmentStarts: n ? Uint32Array.of(0) : new Uint32Array(0), segmentCounts: n ? Uint32Array.of(n) : new Uint32Array(0),
        resolvedStance: stance || 0x3d, partFrames: d ? d.partFrames : new Float32Array(0),
        takePartMeshes() { return meshes.splice(0); }, takeHooks() { return []; },
      };
      if (d && d.posFrames !== undefined) out.posFrames = d.posFrames;
      if (d && d.rootFrames) out.rootFrames = d.rootFrames;
      return out;
    },
    async fetchEntitySurfacesPixels(dids) { return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 })); },
  };
  const spawnMeta = (guid, x, y) => ({
    guid, modelId: 0x02000001, mtableId: 0x09000001, landblockId: 0xa9b40001, x, y, z: 0, qw: 1, qx: 0, qy: 0, qz: 0,
    paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t", wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), subPalettes: new Uint32Array(0),
  });
  const { EntityManager } = await import("../scene3d/entities.js");
  const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
  installFakeMotionSequence();
  // index.js's scene3dForBuilders shape: the groups (and the camera / material cache this suite's
  // fake needs), NO renderer, NO scene — the object the client's EntityManager is built with
  const facadeOf = (W) => ({ entitiesGroup: W.entities, materialCache: null, camera: W.camera });
  const mk = async (flagOn) => {
    EW.__setEntityWorldForTest(flagOn);
    const arm = makeArm(false, { rigs: 0 });
    const W = arm.W;
    // index.js's line, at its place (after installDrawExec, the groups attached), with either flag value
    const ewState = EW.installEntityWorld(arm.renderer, () => W.scene, () => W.entities);
    const em = new EntityManager(facadeOf(W), wasmExports);
    const insts = [];
    for (let i = 0; i < 4; i++) insts.push(await em.spawn(spawnMeta(0x50000400 + i, -6 + i * 4, (i % 2) * 3)));
    em._tweenClockMs = 1000;
    for (const inst of insts) inst && inst.root.traverse((o) => { if (!arm.ids.has(o)) arm.ids.set(o, 400000 + (arm.__e = (arm.__e || 0) + 1)); if (o.material && !arm.ids.has(o.material)) arm.ids.set(o.material, 500000 + arm.__e); });
    return { arm, em, insts, ewState };
  };
  EW.__resetEntityWorldForTest();
  {
    // the rig build's lazy path, handed the client's facade, cannot install the projection
    EW.__setEntityWorldForTest(true);
    const probe = makeArm(false, { rigs: 0 });
    const st = EW.ensureEntityWorld(facadeOf(probe.W));
    check("E: ensureEntityWorld(index.js's scene3dForBuilders shape: no renderer / scene) installs nothing — the projection needs index.js's explicit line",
      st === null && !probe.renderer.__hbEntityWorld && EW.entityWorldStats().projections === 0);
  }
  const A = await mk(false);
  const B = await mk(true);
  const sB = EW.entityWorldStats();
  check("E: spawned rigs in both managers", A.insts.every((x) => x && x.parts.length === 17) && B.insts.every((x) => x && x.parts.length === 17));
  check("E: the rig build installed the root walk (flag on) and nothing (flag off)",
    B.insts.every((x) => EW.entityWorldRootInstalled(x.root)) && A.insts.every((x) => !EW.entityWorldRootInstalled(x.root)), `${sB.roots} roots`);
  check("E: index.js's install line put the projection on the flag-on renderer only (null with the flag off)",
    B.ewState !== null && B.arm.renderer.__hbEntityWorld === B.ewState && A.ewState === null && !A.arm.renderer.__hbEntityWorld && sB.projections === 1,
    `projections ${sB.projections}`);
  let bad = null, ticks = 0;
  const tick = async (n, fn) => {
    for (let i = 0; i < n && !bad; i++) {
      for (const X of [A, B]) {
        EW.__setEntityWorldForTest(X === B);
        if (fn) await fn(X);
        X.em.tick(0.016);
        // the rigs stand at their landblock's world position: aim the camera at them
        const tgt = X.insts[0].root.getWorldPosition(new THREE.Vector3());
        const cam = X.arm.W.camera;
        cam.position.set(tgt.x + 6 + Math.sin(ticks * 0.3) * 2, tgt.y + 5, tgt.z + 8);
        cam.lookAt(tgt);
        cam.updateMatrixWorld();
        X.arm.startLog();
        X.arm.renderer.render(X.arm.W.scene, X.arm.W.camera);
        X.frame = X.arm.stopLog();
        await settle(X.arm);
      }
      ticks += 1;
      const d = firstStreamDiff({ frames: [{ ...A.frame, counters: [] }] }, { frames: [{ ...B.frame, counters: [] }] });
      if (d) bad = `tick ${ticks}: ${d}`;
      const dn = firstNodeDiff(A.arm.W, B.arm.W);
      if (!bad && dn) bad = `tick ${ticks}: ${dn}`;
    }
  };
  await tick(8);
  await tick(1, async (X) => { await X.em.setMotion(X.insts[0].guid, WALK, 0x3d); await X.em.setMotion(X.insts[2].guid, WALK, 0x3d); });
  await tick(14);
  await tick(1, (X) => { X.insts[1].root.visible = false; });
  await tick(4);
  await tick(1, (X) => { X.insts[1].root.visible = true; });
  await tick(4);
  const s2 = EW.entityWorldStats();
  if (process.env.EW_DEBUG) {
    console.log("    E stats", JSON.stringify(s2));
    const inst = B.insts[0];
    const m = inst.parts[0].children[0];
    console.log("    E mesh", m && m.type, m && Array.isArray(m.material), m && m.children.length, m && m.boundingSphere, m && Object.keys(m.geometry.attributes), m && m.__hbEw && { ok: m.__hbEw.ok, n: m.__hbEw.n, epoch: m.__hbEw.epoch, st: m.__hbEw.st.epoch });
    console.log("    E root children", inst.root.children.map((c) => c.type + ":" + c.name).slice(0, 5), "E kids", B.arm.W.entities.children.length);
  }
  check(`E: ${ticks} ticks — GL stream, sorted render lists and every node's matrices identical`, bad === null, bad ?? "");
  check("E: the flag-on manager's rigs were walked and projected by the module", s2.walks - sB.walks > 0 && s2.renders - sB.renders > 0 && s2.cold - sB.cold > 0,
    `walks ${s2.walks - sB.walks} renders ${s2.renders - sB.renders} cold ${s2.cold - sB.cold}`);
  A.em.dispose(); B.em.dispose();
  EW.__setEntityWorldForTest(undefined);
}

// =============================================================================================
// L — lifetime: after its render the stand-in holds nothing, so despawned rigs are collectable
// =============================================================================================
// Stock three drops its inactive render items' references in list.finish; the stand-in pool
// (RigPusher targets / hot nodes, Carrier slots, SegPusher items) must not outlive its render
// either. WeakRefs to despawned roots, a full gc, and the survivors compared with stock's (three
// itself may keep one recently drawn object; whatever it keeps, both arms must keep the same).
function getGc() {
  if (typeof globalThis.gc === "function") return globalThis.gc;
  try { v8.setFlagsFromString("--expose-gc"); return vm.runInNewContext("gc"); } catch (_) { return null; }
}
/** Every pusher, carrier and segment of the flag-on renderer's pool is empty. */
function poolEmpty(st) {
  if (!st) return true;
  for (const rp of st.pushers) {
    if (rp.target !== null || rp.children.length !== 0 || rp.nCar !== 0 || rp.nSeg !== 0) return false;
    for (const c of rp.cars) if (c.children[0] !== null) return false;
    for (const s of rp.segs) { if (s.n !== 0) return false; for (const x of s.items) if (x !== null && x !== undefined) return false; }
  }
  return st.standIn.length === 0;
}
async function lifetimeArm(flagOn, gc) {
  RUNS.__resetBatchedRunsFrameForTest();
  RUNS.__resetStableForTest();
  const arm = makeArm(flagOn, { rigs: 8, specials: false }, { log: false });
  const W = arm.W;
  const st = arm.ew;
  // Everything that touches a rig node runs in a plain function: an async function's generator keeps
  // its last temporaries in registers, which would keep a despawned rig alive in BOTH arms.
  const H = { item: null };
  // rig 0 wields an item (a nested rig root of two parts) under a part with renderOrder 5: a hot
  // node riding a groupOrder carrier on pusher 0, which rig 0 keeps using after the item is gone
  const wieldItem = () => {
    const wield = W.rigs[0].parts[3];
    wield.renderOrder = 5;
    const item = new THREE.Group(); item.name = "held-item";
    for (let p = 0; p < 2; p++) { const g = new THREE.Group(); g.add(new THREE.Mesh(W.G[3], W.mkMat())); item.add(g); }
    item.traverse((x) => x.layers.set(1));
    wield.add(item);
    if (flagOn) EW.installEntityWorldRoot(item);
    H.item = item;
  };
  // EntityInstance.dispose: GPU side freed, the root removed from its parent, the subtree left whole
  const freeGpu = (root) => root.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material)) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  // 1. the crowd shrinks to rig 0 (pushers 1..7 surplus), and rig 0 drops its item (stale carrier slot)
  const shrink = () => {
    const refs = [];
    for (let k = 1; k < 8; k++) { const rec = W.rigs[k]; refs.push(new WeakRef(rec.root)); W.entities.remove(rec.root); freeGpu(rec.root); }
    W.rigs.length = 1;
    const item = H.item;
    H.item = null;
    refs.push(new WeakRef(item));
    item.parent.remove(item);
    freeGpu(item);
    return refs;
  };
  // 2. the last rig despawns: the entities group is empty (onGet returns before any stand-in)
  const emptyOut = () => {
    const rec = W.rigs[0];
    W.rigs.length = 0;
    W.entities.remove(rec.root);
    freeGpu(rec.root);
    return [new WeakRef(rec.root)];
  };
  const survivors = (refs) => { const out = []; for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) out.push(i); return out; };
  let f = 0;
  let poolOk = true;
  const renderFrame = () => {
    poseWorld(W, f); moveCamera(W, f);
    arm.renderer.render(W.scene, W.camera);
    if (!poolEmpty(st)) poolOk = false;
    f += 1;
  };
  const frames = async (n) => { for (let i = 0; i < n; i++) { renderFrame(); await settle(arm); } };
  const alive = async (refs) => { await sleep(5); gc(); await sleep(5); gc(); await sleep(5); return survivors(refs); };
  wieldItem();
  await frames(5);
  const cold = flagOn ? EW.entityWorldStats().cold : 0;
  const refs1 = shrink();
  await frames(4);
  const alive1 = await alive(refs1);
  const refs2 = emptyOut();
  await frames(3);
  const alive2 = await alive(refs2);
  return { alive1, alive2, poolOk, cold, pushers: st ? st.pushers.length : 0 };
}
const RUN_L = !BENCH && (!process.env.EW_ONLY || "lifetime".includes(process.env.EW_ONLY));
if (RUN_L) {
  console.log("\nPART L — lifetime: despawned rigs are not kept reachable by the stand-in");
  const gc = getGc();
  check("L: a full gc is available (v8 --expose-gc set at run time)", typeof gc === "function");
  if (typeof gc === "function") {
    EW.__resetEntityWorldForTest();
    const S = await lifetimeArm(false, gc);
    const F = await lifetimeArm(true, gc);
    EW.__setEntityWorldForTest(undefined);
    console.log(`    stock: alive after the crowd shrank ${JSON.stringify(S.alive1)} of 8, after the last despawn ${JSON.stringify(S.alive2)}; flag: ${JSON.stringify(F.alive1)}, ${JSON.stringify(F.alive2)} (${F.pushers} pushers, ${F.cold} cold before)`);
    check("L: the flag arm projected rigs through the stand-in (pushers used, cold meshes pushed)", F.pushers >= 8 && F.cold > 0, `${F.pushers} pushers, cold ${F.cold}`);
    check("L: a shrinking crowd + a dropped held item (stale carrier) — the flag arm keeps exactly the despawned rigs stock keeps",
      JSON.stringify(F.alive1) === JSON.stringify(S.alive1), `stock ${JSON.stringify(S.alive1)} vs flag ${JSON.stringify(F.alive1)}`);
    check("L: an empty entities group (no stand-in render) — the flag arm keeps exactly what stock keeps",
      JSON.stringify(F.alive2) === JSON.stringify(S.alive2), `stock ${JSON.stringify(S.alive2)} vs flag ${JSON.stringify(F.alive2)}`);
    check("L: after every render the stand-in pool (targets, hot nodes, carrier slots, segment items) is empty", F.poolOk === true);
  }
}


// =============================================================================================
// --bench: the lane notes' measurement (docs §2). A Holtburg-shaped world (19 visible rigs:
// 9 humanoid / 6 creature / 4 item, 30 hidden; ~250 static draws), three arms in ONE process —
// `none` (rigs hidden), `stock`, `flag` — many short rounds in rotated order, medians per phase:
//   walk  scene.updateMatrixWorld        proj  end of the walk → list.finish (hooks included)
//   sort  list.sort                      draw  after the sort → end of render()
// The world built LAST measures faster (heap placement, an A/A control shows ~10%), so the bench
// runs itself twice (stock built before flag, then after) and averages the two.
//   node tests/rust_entity_world.test.mjs --bench [--rounds 25] [--block 30]
// =============================================================================================
function benchWorld(seed = 7) {
  const r = rng(seed);
  const rnd = (k = 1) => (r() * 2 - 1) * k;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x8899aa, 50, 400);
  const lights = new THREE.Group(); scene.add(lights);
  lights.add(new THREE.AmbientLight(0x404040, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(10, 20, 5); lights.add(sun);
  lights.add(new THREE.HemisphereLight(0x8888ff, 0x442200, 0.3));
  for (let i = 0; i < 8; i++) { const p = new THREE.PointLight(0xffaa66, 1, 30, 2); p.position.set(rnd(40), 3, rnd(40)); lights.add(p); }
  const worldRoot = new THREE.Group(); worldRoot.name = "worldRoot"; worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot);
  const grp = (n) => { const g = new THREE.Group(); g.name = n; return g; };
  const terrain = grp("terrain"), buildings = grp("buildings"), statics = grp("statics"), cells = grp("cells"), entities = grp("entities");
  worldRoot.add(terrain, buildings, statics, cells, entities);
  worldRoot.userData.__punchPhase = 2; terrain.userData.__punchPhase = 0;
  cells.layers.set(1); entities.layers.set(1);
  const sg = GEOMS();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  const randMat = (k = 60) => m4.compose(v.set(rnd(k), rnd(k), r() * 3), q.setFromEuler(e.set(0, 0, r() * 6)), s1);
  const std = (x = {}) => new THREE.MeshStandardMaterial({ map: dataTex(4), roughness: 0.5 + r() * 0.5, ...x });
  const classMats = []; for (let i = 0; i < 20; i++) classMats.push(std({ side: THREE.DoubleSide }));
  for (let b = 0; b < 120; b++) {
    const bm = new THREE.BatchedMesh(16, 2048, 4096, classMats[b % 20]);
    const ids = [bm.addGeometry(sg[b % 4]), bm.addGeometry(sg[(b + 1) % 4])];
    for (let k = 0; k < 6; k++) bm.setMatrixAt(bm.addInstance(ids[k & 1]), randMat());
    bm.perObjectFrustumCulled = false; bm.sortObjects = false; bm.frustumCulled = false; bm.matrixAutoUpdate = b % 3 !== 0;
    bm.name = `static-batch-c-${b}`; RUNS.markBatchedRuns(bm); statics.add(bm);
  }
  const sMats = []; for (let i = 0; i < 30; i++) sMats.push(new THREE.MeshStandardMaterial({ map: dataTex(4), roughness: 0.8 }));
  for (let i = 0; i < 90; i++) {
    const m = new THREE.Mesh(sg[i % 4], sMats[i % 30]); m.position.set(rnd(60), rnd(60), r() * 2); m.rotation.z = r() * 6;
    m.updateMatrix(); m.matrixAutoUpdate = i % 2 === 0; m.name = `static-${i}`; statics.add(m);
  }
  for (let i = 0; i < 6; i++) { const lod = new THREE.LOD(); lod.addLevel(new THREE.Mesh(sg[1], sMats[3]), 0); lod.addLevel(new THREE.Mesh(sg[0], sMats[4]), 30); lod.position.set(i * 9 - 27, -14, 0); statics.add(lod); }
  for (let i = 0; i < 10; i++) { const im = new THREE.InstancedMesh(sg[2], std(), 6); for (let k = 0; k < 6; k++) im.setMatrixAt(k, randMat(40)); im.matrixAutoUpdate = false; statics.add(im); }
  for (let i = 0; i < 300; i++) { const g = new THREE.Group(); g.visible = false; g.add(new THREE.Group()); statics.add(g); }
  const cMats = [0, 1, 2, 3, 4, 5].map(() => new THREE.MeshStandardMaterial({ map: dataTex(4), roughness: 0.7 }));
  for (let c = 0; c < 8; c++) {
    const cont = new THREE.Group(); cont.layers.set(1); cells.add(cont); cont.position.set(rnd(40), rnd(40), 0);
    for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(sg[(i + c) % 4], cMats[(i + c) % 6]); m.position.set(rnd(3), rnd(3), 0.5); m.updateMatrix(); m.matrixAutoUpdate = false; m.layers.set(1); cont.add(m); }
  }
  for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(sg[0], std()); m.position.set(rnd(50), rnd(50), 0); m.scale.set(6, 6, 4); m.updateMatrix(); m.matrixAutoUpdate = false; buildings.add(m); }
  {
    const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uT0: { value: dataTex(4) } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform float uTime; uniform sampler2D uT0; varying vec2 vUv; void main(){ gl_FragColor = texture(uT0, vUv) + uTime; }" });
    const t = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat); t.position.z = -1; terrain.add(t);
    for (let i = 0; i < 10; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), mat.clone()); p.position.set(i * 45 - 220, 150, -2); terrain.add(p); }
  }
  // rigs: per-setup shared part geometries, per-entity materials (some shared within a rig)
  const kinds = { humanoid: { parts: 17, surf: [2, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1], sprite: true }, creature: { parts: 9, surf: [1, 1, 2, 1, 1, 1, 1, 1, 1], sprite: true }, item: { parts: 2, surf: [1, 1], sprite: false } };
  const setupGeoms = {};
  for (const [k, K] of Object.entries(kinds)) {
    setupGeoms[k] = [0, 1, 2].map(() => K.surf.map((n, p) => Array.from({ length: n }, (_, j) => ((p + j) % 3 === 0 ? new THREE.BoxGeometry(0.2 + r() * 0.2, 0.2, 0.4) : (p + j) % 3 === 1 ? new THREE.CylinderGeometry(0.08, 0.1, 0.4, 6) : new THREE.SphereGeometry(0.12, 6, 4)))));
  }
  const spriteMat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true });
  const rigs = [];
  let k = 0;
  const makeRig = (kind, hidden) => {
    const K = kinds[kind], geo = setupGeoms[kind][k % 3];
    const root = new THREE.Group(); root.name = `entity-${k}`;
    root.position.set(rnd(25), rnd(25), 0); root.quaternion.setFromAxisAngle(Z, r() * 6.28);
    const dz = (k % 3) * 0.01;
    root.updateMatrix = function visualGroundUpdateMatrix() { O3D.updateMatrix.call(this); if (dz !== 0) this.matrix.elements[14] += dz; };
    const parts = [], own = [];
    for (let p = 0; p < K.parts; p++) {
      const part = new THREE.Group(); part.name = `part_${p}`; part.userData.didDegrade = 0;
      part.position.set(0.05 * p, 0.01 * p, 0.1 * p); part.quaternion.set(0.1, 0.2, 0.3, 0.927).normalize();
      for (let j = 0; j < geo[p].length; j++) {
        let mat;
        if (own.length && r() < 0.35) mat = own[(r() * own.length) | 0]; else { mat = new THREE.MeshStandardMaterial({ map: dataTex(4), roughness: 0.6 }); own.push(mat); }
        const m = new THREE.Mesh(geo[p][j], mat); m.name = `part_${p}_surface_${j}`; m.userData = { guid: 0x50000000 + k, partIndex: p };
        if (r() < 0.06) m.visible = false;
        part.add(m);
      }
      parts.push(part); root.add(part);
    }
    if (K.sprite) { const sp = new THREE.Sprite(spriteMat); sp.position.set(0, 0, 2.2); sp.name = "nameplate"; root.add(sp); }
    root.traverse((x) => x.layers.set(1));
    if (hidden) root.visible = false;
    entities.add(root);
    rigs.push({ root, parts, hidden, phase: r() * 6.28 });
    k++;
  };
  const order = [...Array(9).fill("humanoid"), ...Array(6).fill("creature"), ...Array(4).fill("item")];
  let hidden = 30;
  for (let i = 0; i < order.length; i++) { makeRig(order[i], false); if (hidden > 0 && i % 2 === 1) { makeRig(i % 3 === 0 ? "creature" : "humanoid", true); hidden--; } }
  while (hidden-- > 0) makeRig("humanoid", true);
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 500); camera.layers.enable(1);
  let visNodes = 0, visMeshes = 0;
  for (const rec of rigs) if (!rec.hidden) rec.root.traverseVisible((o) => { visNodes++; if (o.isMesh) visMeshes++; });
  return { scene, entities, rigs, camera, counts: { rigs: rigs.length, visibleRigs: rigs.filter((x) => !x.hidden).length, visNodes, visMeshes } };
}
function benchStep(W, f) {
  const cam = W.camera;
  cam.position.set(Math.sin(f * 0.02) * 30, 22 + Math.cos(f * 0.013) * 3, 30 + Math.sin(f * 0.017) * 6); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  for (const rec of W.rigs) {
    rec.root.position.x += Math.sin(f * 0.05 + rec.phase) * 0.01;
    if (rec.hidden) continue;
    for (let p = 0; p < rec.parts.length; p++) {
      const g = rec.parts[p], a = f * 0.07 + p * 0.3 + rec.phase;
      g.position.x = 0.05 * p + Math.sin(a) * 0.01; g.position.z = 0.1 * p + Math.cos(a) * 0.01;
      const c = Math.cos(a * 0.5), sn = Math.sin(a * 0.5); const qq = g.quaternion; qq._x = sn * 0.6; qq._y = sn * 0.8; qq._z = 0; qq._w = c;
    }
  }
}
function benchArm(kind) {
  const gl = createFakeWebGL2({ maxTextures: 16, maxCombined: 32, clipControl: true }).__fake.plain();
  const canvas = restorableCanvas(gl);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...depthRendererParams("reversed") });
  installReversedZ(THREE, renderer);
  renderer.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  installUniformBindPatch(renderer, { texUnitPin: true, lightUploadOnce: true, lightUbo: true });
  installDrawSortProgram(renderer); setDrawSortPhase(renderer, phaseOf, phaseOnlySort); installDepthBandSort(renderer, { perOctave: 0 });
  const W = benchWorld();
  if (kind === "none") for (const rec of W.rigs) { rec.root.visible = false; rec.hidden = true; }
  installAsyncLinkGuard(renderer, () => W.scene);
  SKIP.installSkipEmptyMultiDraw(renderer, { force: true });
  RUNS.installBatchedRuns(renderer);
  DX.installDrawExec(renderer, () => W.scene, { force: true, rigs: true });
  if (kind === "flag" || kind === "flagWalk" || kind === "flagProj") {
    EW.__setEntityWorldForTest(true);
    if (kind !== "flagProj") for (const rec of W.rigs) EW.installEntityWorldRoot(rec.root);
    if (kind !== "flagWalk") EW.installEntityWorld(renderer, () => W.scene, () => W.entities);
  }
  // phase timers, outermost
  const T = { walk: 0, proj: 0, sort: 0, draw: 0, total: 0, n: 0 };
  const now = () => performance.now();
  let tProj = 0, tSortEnd = 0;
  const sUMW = W.scene.updateMatrixWorld;
  // proj runs from the end of the walk (camera, every onBeforeRender hook, frustum, renderLists.get,
  // projectObject) to list.finish, so a hook's own work is counted where it is spent
  W.scene.updateMatrixWorld = function (f) { const t = now(); const res = sUMW.call(this, f); tProj = now(); T.walk += tProj - t; return res; };
  const lg = renderer.renderLists.get, done = new WeakSet();
  renderer.renderLists.get = function (sc, depth) {
    const list = lg.call(this, sc, depth);
    if (list && !done.has(list)) {
      done.add(list);
      const fin = list.finish, so = list.sort;
      list.finish = function () { const x = fin.call(this); if (sc === W.scene) T.proj += now() - tProj; return x; };
      list.sort = function (a, b) { const t = now(); const x = so.call(this, a, b); if (sc === W.scene) { tSortEnd = now(); T.sort += tSortEnd - t; } return x; };
    }
    return list;
  };
  const r0 = renderer.render;
  renderer.render = function (sc, cam) { const t = now(); const x = r0.call(this, sc, cam); const t1 = now(); if (sc === W.scene) { T.total += t1 - t; T.draw += t1 - tSortEnd; T.n++; } return x; };
  return { kind, gl, renderer, W, T };
}
async function runBenchChild(armKind, order) {
  const argv = process.argv;
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? +argv[i + 1] : d; };
  const ROUNDS = opt("--rounds", 25), BLOCK = opt("--block", 30);
  const names = ["none", "stock", armKind];
  const build = order === "flagFirst" ? ["none", armKind, "stock"] : names;
  const built = {};
  for (const n of build) built[n] = benchArm(n === "stock" ? "stock" : n);
  const arms = names.map((n) => built[n]);
  const nullGl = (gl) => { const nop = function () {}; for (const n of ["uniform1i", "uniform2i", "uniform3i", "uniform4i", "uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform1iv", "uniformMatrix3fv", "uniformMatrix4fv", "uniformMatrix2fv", "activeTexture", "bindTexture", "useProgram", "bufferSubData"]) gl[n] = nop; gl.__fake?.setCheckUnits?.(false); };
  let f0 = 0;
  for (const a of arms) { for (let f = 0; f < 8; f++) { benchStep(a.W, f); a.renderer.render(a.W.scene, a.W.camera); await sleep(15); } nullGl(a.gl); }
  f0 = 8;
  for (const a of arms) for (let f = 0; f < 90; f++) { benchStep(a.W, f0 + f); a.renderer.render(a.W.scene, a.W.camera); }
  f0 += 90;
  const K = ["walk", "proj", "sort", "draw", "total"];
  const per = names.map(() => Object.fromEntries(K.map((k) => [k, []])));
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < 3; i++) {
      const ai = (i + r) % 3, a = arms[ai];
      for (const k of K) a.T[k] = 0; a.T.n = 0;
      for (let f = 0; f < BLOCK; f++) { benchStep(a.W, f0 + f); a.renderer.render(a.W.scene, a.W.camera); }
      for (const k of K) per[ai][k].push(1000 * a.T[k] / a.T.n);
    }
    f0 += BLOCK;
  }
  const med = (vv) => vv.slice().sort((x, y) => x - y)[vv.length >> 1];
  const out = { order, counts: arms[1].W.counts, D: {}, E: {} };
  for (const k of K) { out.D[k] = med(per[1][k].map((x, i) => x - per[0][k][i])); out.E[k] = med(per[2][k].map((x, i) => x - per[1][k][i])); }
  console.log("JSON " + JSON.stringify(out));
}
async function runBench() {
  const ci = process.argv.indexOf("--bench-child");
  if (ci >= 0) { await runBenchChild(process.argv[ci + 1], process.argv[ci + 2]); return; }
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  const extra = process.argv.slice(2).filter((x) => x !== "--bench");
  const K = ["walk", "proj", "sort", "draw", "total"];
  const res = {};
  for (const armKind of ["flag", "flagWalk", "flagProj"]) {
    for (const order of ["stockFirst", "flagFirst"]) {
      const p = spawnSync(process.execPath, [self, "--bench", "--bench-child", armKind, order, ...extra], { encoding: "utf8", maxBuffer: 1 << 24 });
      const line = (p.stdout || "").split("\n").find((l) => l.startsWith("JSON "));
      if (!line) { console.log(`  ${armKind}/${order}: failed ${String(p.stderr).slice(-400)}`); continue; }
      (res[armKind] ||= []).push(JSON.parse(line.slice(5)));
    }
  }
  const first = Object.values(res)[0]?.[0];
  if (!first) return;
  const c = first.counts;
  console.log(`BENCH — ${c.visibleRigs} visible rigs of ${c.rigs}, ${c.visNodes} visible entity nodes, ${c.visMeshes} visible part meshes; µs/frame (node, this machine)`);
  const avg = (rows, key, k) => rows.reduce((x, j) => x + j[key][k], 0) / rows.length;
  const all = Object.values(res).flat();
  const D = Object.fromEntries(K.map((k) => [k, avg(all, "D", k)]));
  console.log(`  stock entity cost (rigs visible − hidden): walk ${D.walk.toFixed(1)}, proj ${D.proj.toFixed(1)}, sort ${D.sort.toFixed(1)}, draw ${D.draw.toFixed(1)}, total ${D.total.toFixed(1)}`);
  console.log(`  per visible entity node: walk ${(1000 * D.walk / c.visNodes).toFixed(0)} ns, proj ${(1000 * D.proj / c.visNodes).toFixed(0)} ns, sort ${(1000 * D.sort / c.visNodes).toFixed(0)} ns; per visible mesh: draw ${(1000 * D.draw / c.visMeshes).toFixed(0)} ns`);
  const sw = D.walk + D.proj + D.sort;
  for (const [armKind, rows] of Object.entries(res)) {
    const E = Object.fromEntries(K.map((k) => [k, avg(rows, "E", k)]));
    const ew = E.walk + E.proj + E.sort;
    console.log(`  ${armKind.padEnd(9)} Δ walk ${E.walk.toFixed(1)} (${(100 * -E.walk / D.walk).toFixed(0)}%)  proj ${E.proj.toFixed(1)} (${(100 * -E.proj / D.proj).toFixed(0)}%)  sort ${E.sort.toFixed(1)}  walk+proj+sort ${ew.toFixed(1)} (${(100 * -ew / sw).toFixed(0)}% of the entity scene walk)  draw ${E.draw.toFixed(1)}  frame ${E.total.toFixed(1)}`);
  }
}

if (BENCH) { await runBench(); process.exit(0); }
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
