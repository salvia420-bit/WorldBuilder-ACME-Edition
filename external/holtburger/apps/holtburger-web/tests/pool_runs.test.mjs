// 2026-10-22 — ?poolRuns (scene3d/pool_registry.js; handoff
// docs/HANDOFF-gpu-resident-statics-2026-10-22.md §5 F1): OPAQUE draw pools opt
// into ?batchedRuns, so a pool's repeated (content, layer) ranges reach ANGLE as
// one INSTANCED range per distinct geometry instead of one range per placement.
// Plus the two three-r184 early-out corollaries the pools needed (node bounds,
// band swaps) and the stage-B several-plans-per-tile fix (pool_stream.js), and
// the 2026-10-23 review fixes (park-aware commit, vacate wiring, bounds grown
// per add, avalanching + per-stream content hash).
//
// What is pinned here, without a GPU:
//   P   the three r184 premises the change leans on (early-out text, the
//       blending rule, setGeometryIdAt not raising _visibilityChanged, the
//       lazy node sphere, the batching includes of every program that draws a
//       pool: standard colour, depth, distance);
//   F   flag grammar: DEFAULT ON, off/0/false/no escape;
//   O   the draw-order predicate (depth test + write, no blending);
//   M   which pools are marked: opaque order-free YES; translucent, additive,
//       opaque-class-but-blended, depth-write-off NO (counted); flag off /
//       marker absent / marker throwing ⇒ unmarked, counted, fail-soft;
//   S   the shader half: a REAL class material (plain and baked-light) keeps
//       the batching includes after its onBeforeCompile, the resolved vertex
//       text reads the run slot, and the shadow walk gives a pool no custom
//       depth material;
//   R   a marked pool's canonical list regroups through prepareRunDraw
//       (emulated GPU lookup == three's pairs), and three's early-out keeps the
//       list byte-identical so the compare HITS (no rebuild, no upload);
//   W   through the renderBufferDirect wrapper with ?bmIndirectPerCamera live:
//       two cameras share ONE canonical texture and ONE run layout; frame
//       totals issued < subDraws; park → adopt costs no re-derive; a new feed
//       re-derives once; a translucent pool steps aside;
//   B   node bounds follow membership (a feed GROWS the cached sphere, a release
//       dirties it, park does not; a stage-B feed culled every frame never
//       recomputes it);
//   L   a band swap reaches the multidraw list under the early-out;
//   T   stage B: several TilePlans for one tile all commit; per-plan texture
//       gating; a vacate abandons every plan of the tile;
//   V   a plan that commits after its tile PARKED commits invisible, and the
//       re-adopt brings back every plan (also a park before the first commit);
//   VP  the producer's live hooks: EMPTY / teleport abandon in-flight plans, a
//       plan for an EMPTY tile comes back as passthrough, any re-admit lifts
//       the vacate, an EMPTY with nothing resident drops the park mark;
//   C   the producer's content key: byte-identical geometry OBJECTS from two
//       LBs share one pool geometry (so their ranges repeat and regroup);
//       any byte / layout difference keeps them apart (sign flips, mirrors,
//       equal high-byte deltas included); keyed once per object, each shared
//       vertex stream hashed / verified once; a collision chains and still
//       shares; `?poolRuns=off` keeps the object-identity key;
//   P8  the producer hands the registry the real marker; ?poolRuns=off does not.
// The GPU half (patched GLSL drawing a pooled world identically with and
// without runs) is harness/glsl_smoke/pool_runs_smoke.mjs (headless Chromium).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/pool_runs.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { applyBatchedMeshColorTextureFix } from "../scene3d/three_batchedmesh_colortexture_fix.js";
import {
  PoolRegistry, poolRunsEnabled, poolDrawOrderFree, _resetDrawPoolsForTest,
} from "../scene3d/pool_registry.js";
import { classKeyOf, passClassOf } from "../scene3d/pool_class_key.js";
import {
  markBatchedRuns, isBatchedRunsMarked, prepareRunDraw, installBatchedRuns, uninstallBatchedRuns,
  getBatchedRunsStats, patchBatchingChunks, __setBatchedRunsChunksForTest, __pendingForTest, RUN_MARKER,
} from "../scene3d/batched_runs.js";
import {
  installBatchedIndirectPerCamera, uninstallBatchedIndirectPerCamera, getBatchedIndirectPerCameraStats,
} from "../scene3d/batched_indirect_per_camera.js";
import { PoolStreamController } from "../scene3d/pool_stream.js";
import { FrameWorkScheduler, getFrameWorkScheduler } from "../scene3d/frame_work.js";
import { UploadStager } from "../scene3d/upload_stage.js";
import { tileKeyOf, tileOfLb } from "../scene3d/residency_grid.js";
import { ClassMaterialRegistry } from "../scene3d/pool_material.js";
import { applySwayShadow } from "../scene3d/sway_shadow.js";
import {
  initPoolWorld, _resetPoolWorldForTest, addSingletonsToPools, poolWorldCensus, getPoolRegistry,
  getPoolWorld, _poolContentForTest, poolOnSlotState, poolOnTeleport, poolTickP4,
} from "../scene3d/pool_producer.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// index.js applies it before any BatchedMesh exists; the registry verifies it.
applyBatchedMeshColorTextureFix(THREE);

// --- fixtures ----------------------------------------------------------------------
const PLAIN_PATCH = { d: 0, c: 0, p: 0, l: 0, a: 0, b: 0, f: 0, s: 0, k: 0, v: "" };
function rec(over = {}) {
  return {
    domain: "st", transparent: false, alphaTest: 0, depthWrite: true, blending: 1, blendTriple: null,
    wrap: "c", side: 2, patch: { ...PLAIN_PATCH }, vfxConfigKey: null,
    texW: 256, texH: 256, texCompressed: true, hasTex: true, castShadow: false, receiveShadow: false,
    ...over,
  };
}
/** The class material a class key implies (what ClassMaterialRegistry builds,
 *  minus the texture machinery): the render state is what marking reads. */
function materialFor(r) {
  const m = new THREE.MeshStandardMaterial();
  m.transparent = r.transparent === true;
  m.alphaTest = r.alphaTest || 0;
  m.depthWrite = r.depthWrite !== false;
  m.blending = r.blending == null ? THREE.NormalBlending : r.blending;
  return m;
}
const AXES = {
  opaque: rec(),
  clipMap: rec({ alphaTest: 0.5 }),                         // ?clipMapOpaque shape
  translucent: rec({ transparent: true }),
  additive: rec({ transparent: true, blending: THREE.AdditiveBlending }),
  blendedCut: rec({ transparent: true, alphaTest: 0.5 }),   // passClass opaque, but blends
  noDepthWrite: rec({ depthWrite: false }),                 // passClass opaque, order-bound
};
function member(axes, over = {}) {
  return {
    domain: axes.domain, classKey: classKeyOf(axes), passClass: passClassOf(axes),
    sectorKey: "s0x0", contentKey: "a|0", layer: 0,
    matrix: new THREE.Matrix4().toArray(), ...over,
  };
}
const at = (x, y = 0) => new THREE.Matrix4().makeTranslation(x, y, 0).toArray();
/** A distinct indexed triangle per content key (distinct vertex data ⇒ the
 *  geometry identity is the key, as HBG1 content keys are). */
const _keyOff = new Map();
function triFor(key) {
  if (!_keyOff.has(key)) _keyOff.set(key, _keyOff.size);
  const o = _keyOff.get(key) * 0.01;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([o, 0, 0, 1 + o, 0, 0, o, 1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}
const geomSource = () => ({ get: (contentKey) => triFor(String(contentKey)) });
function makeReg({ markRuns = markBatchedRuns, search = "" } = {}) {
  const group = new THREE.Group();
  const reg = new PoolRegistry({
    THREE, group, markRuns, search, warn: () => {},
    materialFactory: (classKey, m) => {
      for (const a of Object.values(AXES)) if (classKeyOf(a) === classKey) return materialFor(a);
      return materialFor(AXES.opaque);
    },
  });
  return { reg, group };
}
function planOf(tile, members) { return { tile, lbs: [], members, counts: {} }; }
const poolOf = (reg, axes) => reg.pools.get(PoolRegistry.poolKeyOf("s0x0", classKeyOf(axes)));
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
cam.position.set(0, 0, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true);
cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
const cam2 = cam.clone();
cam2.position.set(3, 1, 40); cam2.lookAt(0, 0, 0); cam2.updateMatrixWorld(true);
cam2.matrixWorldInverse.copy(cam2.matrixWorld).invert();
/** three's own onBeforeRender, as renderObject calls it (prototype, so a
 *  prototype patch such as ?bmIndirectPerCamera runs too). */
const obr = (bm, c = cam, renderer = null) => bm.onBeforeRender(renderer, null, c, bm.geometry, bm.material, null);
function emulate(layout, runs) {
  // The patched vertex lookup, run by run: head marker, then ids[ runStart_r + i ].
  if (layout[0] !== RUN_MARKER) return null;
  const out = [];
  for (let r = 0; r < runs.r; r++) {
    for (let i = 0; i < runs.inst[r]; i++) out.push(`${runs.starts[r]}:${runs.counts[r]}:${layout[layout[1 + r] + i]}`);
  }
  return out.sort();
}
function canonPairs(bm) {
  const ids = bm._indirectTexture.image.data;
  const out = [];
  for (let k = 0; k < bm._multiDrawCount; k++) out.push(`${bm._multiDrawStarts[k]}:${bm._multiDrawCounts[k]}:${ids[k]}`);
  return out.sort();
}

/** Every ACTIVE instance's world sphere lies inside the pool's cached node sphere. */
function coversAll(bm) {
  const S = bm.boundingSphere;
  if (!S) return false;
  const s = new THREE.Sphere(), m = new THREE.Matrix4();
  for (let i = 0; i < bm._instanceInfo.length; i++) {
    const ii = bm._instanceInfo[i];
    if (!ii.active) continue;
    bm.getBoundingSphereAt(ii.geometryIndex, s);
    bm.getMatrixAt(i, m);
    s.applyMatrix4(m);
    if (s.center.distanceTo(S.center) + s.radius > S.radius + 1e-3) return false;
  }
  return true;
}

// --- P: three r184 premises ------------------------------------------------------------
{
  const require = createRequire(import.meta.url);
  const dir = require.resolve("three").replace(/[^/\\]+$/, "");
  const core = readFileSync(dir + "three.core.js", "utf8");
  const mod = readFileSync(dir + "three.module.js", "utf8");
  check("premise: the early-out is `!_visibilityChanged && !perObjectFrustumCulled && !sortObjects`",
    core.includes("if ( ! this._visibilityChanged && ! this.perObjectFrustumCulled && ! this.sortObjects ) {"));
  const sg = core.indexOf("setGeometryIdAt( instanceId, geometryId ) {");
  const sgEnd = core.indexOf("getGeometryIdAt(", sg);
  check("premise: setGeometryIdAt does NOT raise _visibilityChanged (the band-swap corollary)",
    sg > 0 && sgEnd > sg && !core.slice(sg, sgEnd).includes("_visibilityChanged"));
  check("premise: the node sphere is computed lazily on the first cull (and only when null)",
    core.includes("if ( object.boundingSphere === null ) object.computeBoundingSphere();"));
  const ai = core.indexOf("addInstance( geometryId ) {");
  const aiEnd = core.indexOf("addGeometry(", ai);
  check("premise: addInstance never clears the node sphere (the bounds corollary)",
    ai > 0 && aiEnd > ai && !core.slice(ai, aiEnd).includes("boundingSphere"));
  check("premise: blending is OFF exactly for NormalBlending on a non-transparent material (or NoBlending)",
    mod.includes("( material.blending === NormalBlending && material.transparent === false )\n\t\t\t? setBlending( NoBlending )"));
  for (const [name, lib] of [["standard", THREE.ShaderLib.standard], ["depth", THREE.ShaderLib.depth], ["distance", THREE.ShaderLib.distance]]) {
    check(`premise: ShaderLib.${name} vertex includes batching_pars_vertex + batching_vertex`,
      lib.vertexShader.includes("#include <batching_pars_vertex>") && lib.vertexShader.includes("#include <batching_vertex>"));
  }
  check("premise: ShaderLib.standard vertex includes color_vertex",
    THREE.ShaderLib.standard.vertexShader.includes("#include <color_vertex>"));
}

// --- F: flag grammar -------------------------------------------------------------------
{
  for (const s of ["", "?other=1", "?poolRuns", "?poolRuns=", "?poolRuns=on", "?poolRuns=1", "?poolRuns=garbage"]) {
    check(`flag: "${s}" reads ON (default on)`, poolRunsEnabled(s) === true);
  }
  for (const v of ["off", "0", "false", "no", "OFF", "False", "No"]) {
    check(`flag: poolRuns=${v} reads OFF`, poolRunsEnabled(`?poolRuns=${v}`) === false);
  }
}

// --- O: the draw-order predicate ---------------------------------------------------------
{
  const m = (o) => Object.assign(new THREE.MeshStandardMaterial(), o);
  check("order: opaque NormalBlending ⇒ free", poolDrawOrderFree(m({}), THREE) === true);
  check("order: NoBlending ⇒ free", poolDrawOrderFree(m({ blending: THREE.NoBlending }), THREE) === true);
  check("order: ClipMap opaque (alphaTest, not transparent) ⇒ free", poolDrawOrderFree(m({ alphaTest: 0.5 }), THREE) === true);
  check("order: transparent NormalBlending ⇒ bound", poolDrawOrderFree(m({ transparent: true }), THREE) === false);
  check("order: transparent + alphaTest ⇒ bound (it still blends)", poolDrawOrderFree(m({ transparent: true, alphaTest: 0.5 }), THREE) === false);
  check("order: additive ⇒ bound", poolDrawOrderFree(m({ blending: THREE.AdditiveBlending }), THREE) === false);
  check("order: custom blending ⇒ bound", poolDrawOrderFree(m({ blending: THREE.CustomBlending }), THREE) === false);
  check("order: depthWrite off ⇒ bound", poolDrawOrderFree(m({ depthWrite: false }), THREE) === false);
  check("order: depthTest off ⇒ bound", poolDrawOrderFree(m({ depthTest: false }), THREE) === false);
  check("order: no material / multi-material ⇒ bound", poolDrawOrderFree(null, THREE) === false && poolDrawOrderFree([m({})], THREE) === false);
  check("order: works without THREE (inlined constants)", poolDrawOrderFree(m({}), null) === true && poolDrawOrderFree(m({ transparent: true }), null) === false);
}

// --- M: which pools are marked -------------------------------------------------------------
{
  const { reg } = makeReg();
  const gs = geomSource();
  const members = [];
  for (const [k, a] of Object.entries(AXES)) members.push(member(a, { contentKey: `${k}|0` }));
  reg.feedTile(planOf(tileKeyOf(1, 1), members), gs);
  const marked = (a) => { const p = poolOf(reg, a); return !!p && isBatchedRunsMarked(p.mesh) && p.mesh.userData.runs === true && p.runs === true; };
  check("mark: an opaque pool is marked for batchedRuns", marked(AXES.opaque));
  check("mark: a ClipMap-opaque pool (alphaTest, depth-written, no blend) is marked", marked(AXES.clipMap));
  const op = poolOf(reg, AXES.opaque).mesh;
  check("mark: a marked pool keeps the D-07.4 early-out pair", op.sortObjects === false && op.perObjectFrustumCulled === false);
  const tr = poolOf(reg, AXES.translucent).mesh;
  check("mark: a translucent pool is NOT marked (sorted, D-07.3)", !isBatchedRunsMarked(tr) && tr.sortObjects === true && tr.userData.runs === false);
  check("mark: an additive pool is NOT marked", !isBatchedRunsMarked(poolOf(reg, AXES.additive).mesh));
  const bc = poolOf(reg, AXES.blendedCut);
  check("mark: an opaque-CLASS pool that blends (transparent + alphaTest) is NOT marked",
    bc.passClass === "opaque" && bc.mesh.sortObjects === false && !isBatchedRunsMarked(bc.mesh));
  check("mark: a depth-write-off opaque pool is NOT marked", !isBatchedRunsMarked(poolOf(reg, AXES.noDepthWrite).mesh));
  const r = reg.census().runs;
  check("census: runs = {enabled, injected, live 2, marked 2, orderBound 2, disabled 0}",
    r.enabled === true && r.injected === true && r.live === 2 && r.marked === 2 && r.orderBound === 2 && r.disabled === 0, JSON.stringify(r));

  const off = makeReg({ search: "?poolRuns=off" }).reg;
  off.feedTile(planOf(tileKeyOf(1, 1), members.map((x) => ({ ...x }))), gs);
  const anyMarked = [...off.pools.values()].some((p) => isBatchedRunsMarked(p.mesh));
  const ro = off.census().runs;
  check("flag off: no pool is marked; every opaque pool counted disabled",
    !anyMarked && ro.enabled === false && ro.marked === 0 && ro.disabled === 4, JSON.stringify(ro));

  const bare = makeReg({ markRuns: null }).reg;
  bare.feedTile(planOf(tileKeyOf(1, 1), [member(AXES.opaque)]), gs);
  const rb = bare.census().runs;
  check("no marker injected: unmarked, counted disabled, `injected` false",
    rb.injected === false && rb.disabled === 1 && rb.marked === 0 && !isBatchedRunsMarked(poolOf(bare, AXES.opaque).mesh), JSON.stringify(rb));

  const boom = makeReg({ markRuns: () => { throw new Error("marker boom"); } }).reg;
  boom.feedTile(planOf(tileKeyOf(1, 1), [member(AXES.opaque)]), gs);
  const pb = poolOf(boom, AXES.opaque);
  check("a throwing marker is fail-soft: the pool exists, unmarked, the error recorded",
    !!pb && pb.instances === 1 && pb.runs === false && boom.census().errors.lastError === "marker boom");
}

// --- S: the shader half (every program that draws a pool sees the patched chunks) ---------------
{
  const patched = patchBatchingChunks(THREE.ShaderChunk);
  const chunks = { ...THREE.ShaderChunk, batching_pars_vertex: patched.pars, batching_vertex: patched.vert, color_vertex: patched.color };
  const resolve = (src, depth = 0) => (depth > 8 ? src
    : src.replace(/^[ \t]*#include +<([\w./]+)>/gm, (_, n) => resolve(chunks[n] ?? `/*missing ${n}*/`, depth + 1)));
  const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
  const cmr = new ClassMaterialRegistry({ warn: () => {} });
  const plain = cmr._classOf("st|runs-plain", 256, 256, false, new THREE.MeshStandardMaterial({ map: tex }));
  const bakedMember = new THREE.MeshStandardMaterial({ map: tex });
  bakedMember.userData = { __acBakedLight: true };
  const baked = cmr._classOf("ec|runs-baked", 256, 256, false, bakedMember);
  for (const [name, c] of [["plain class", plain], ["baked-light class", baked]]) {
    const m = c && c.material;
    const lib = THREE.ShaderLib.standard;
    const shader = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, defines: {} };
    try { m.onBeforeCompile(shader, null); } catch (e) { shader.err = String(e); }
    const v = shader.vertexShader;
    check(`shader: ${name} material is a MeshStandardMaterial (three's batching program)`, !!m && m.isMeshStandardMaterial === true);
    check(`shader: ${name} keeps all three batching includes after onBeforeCompile`,
      !shader.err && v.includes("#include <batching_pars_vertex>") && v.includes("#include <batching_vertex>") && v.includes("#include <color_vertex>"), shader.err);
    const full = resolve(v);
    check(`shader: ${name} resolved vertex reads the run slot (hbBatchSlot), never gl_DrawID directly`,
      full.includes("getBatchingMatrix( getIndirectIndex( hbBatchSlot() ) )")
        && !/getIndirectIndex\( gl_DrawID \)/.test(full.replace("getIndirectIndex( gl_DrawID + 1 )", "")));
    check(`shader: ${name} draws order-free (eligible for runs)`, poolDrawOrderFree(m, THREE) === true);
  }
  const depthFull = resolve(THREE.ShaderLib.depth.vertexShader);
  check("shader: the shadow depth program resolves to the run slot too", depthFull.includes("getIndirectIndex( hbBatchSlot() )"));
  // The shadow walk's one per-caster hook must not hand a pool a custom depth
  // material (it would be a program the run layout has never been proven on).
  const { reg } = makeReg();
  reg.feedTile(planOf(tileKeyOf(1, 1), [member(AXES.opaque, { castShadow: true })]), geomSource());
  const bm = poolOf(reg, AXES.opaque).mesh;
  bm.material = plain.material; // the real class material, as the producer wires it
  applySwayShadow(bm);
  check("shader: the shadow walk leaves a pool on three's own depth material (no customDepthMaterial)", bm.customDepthMaterial === undefined);
}

// --- R: canonical list → runs through prepareRunDraw ------------------------------------------
{
  const { reg } = makeReg();
  const keys = ["a", "a", "b", "a", "b", "c"];
  reg.feedTile(planOf(tileKeyOf(2, 2), keys.map((k, i) => member(AXES.opaque, { contentKey: `${k}|0`, matrix: at(i * 2) }))), geomSource());
  const p = poolOf(reg, AXES.opaque);
  const bm = p.mesh;
  check("feed: 6 placements over 3 content keys dedup to 3 pool geometries", p.instances === 6 && p.gids.size === 3);
  bm.updateMatrixWorld(true);
  obr(bm);
  check("canonical: three listed one range per visible instance (6)", bm._multiDrawCount === 6);
  check("canonical: the rebuild consumed _visibilityChanged", bm._visibilityChanged === false);
  const s0 = getBatchedRunsStats();
  const st = prepareRunDraw(bm);
  check("runs: prepareRunDraw regroups the pool (not noGain)", st !== null && st.gain === true);
  const buf = st && st.buf;
  check("runs: 6 ranges → 3 runs", buf && buf.r === 3);
  check("runs: instances per run follow first-seen order a,b,c = 3,2,1", buf && [...buf.inst.subarray(0, 3)].join() === "3,2,1");
  check("runs: the run texture head is the marker", st && st.tex.image.data[0] === RUN_MARKER);
  check("runs: the emulated GPU lookup reaches exactly three's (range, instance) pairs",
    st && JSON.stringify(emulate(st.tex.image.data, buf)) === JSON.stringify(canonPairs(bm)));
  const s1 = getBatchedRunsStats();
  check("runs: one rebuild + one upload for the first draw", s1.rebuilds - s0.rebuilds === 1 && s1.uploads - s0.uploads === 1);

  // Settled frame: three's early-out leaves the canonical list byte-identical.
  const canon = bm._indirectTexture;
  const ver = canon.version;
  const snap = canonPairs(bm).join();
  obr(bm);
  obr(bm, cam2);
  check("early-out: a settled frame does not touch the canonical list (no version bump, same pairs)",
    canon.version === ver && canonPairs(bm).join() === snap && bm._multiDrawCount === 6);
  const tv = st.tex.version;
  const st2 = prepareRunDraw(bm);
  const s2 = getBatchedRunsStats();
  check("early-out: batchedRuns' compare HITS — same state, no rebuild, no upload, run texture untouched",
    st2 === st && s2.rebuilds === s1.rebuilds && s2.uploads === s1.uploads && st.tex.version === tv);
}

// --- W: through the wrapper, ?bmIndirectPerCamera live, two cameras ----------------------------
{
  installBatchedIndirectPerCamera(THREE, { force: true });
  __setBatchedRunsChunksForTest(true);
  const calls = [];
  const ext = {
    multiDrawElementsWEBGL(mode, counts, co, type, offsets, oo, n) { calls.push({ kind: "elems", n }); },
    multiDrawElementsInstancedWEBGL(mode, counts, co, type, offsets, oo, inst, io, n) {
      calls.push({ kind: "inst", n, inst: [...inst].slice(io, io + n), counts: [...counts].slice(co, co + n) });
    },
  };
  const seenTex = [];
  const r = {
    info: { render: { frame: 0 } },
    extensions: { has: (n) => n === "WEBGL_multi_draw", get: () => ext },
    renderBufferDirect(camera, scene, geometry, material, object) {
      seenTex.push(object._indirectTexture);
      if (object.isBatchedMesh && object._multiDrawCount > 0) {
        ext.multiDrawElementsWEBGL(4, object._multiDrawCounts, 0, 5125, object._multiDrawStarts, 0, object._multiDrawCount);
      }
    },
  };
  installBatchedRuns(r);
  const draw = (bm, c) => { obr(bm, c, r); r.renderBufferDirect(c, null, bm.geometry, bm.material, bm, null); return calls.at(-1); };

  const { reg } = makeReg();
  const T = tileKeyOf(3, 3);
  const keys = ["a", "b", "a", "a", "c", "b"];
  reg.feedTile(planOf(T, keys.map((k, i) => member(AXES.opaque, { contentKey: `${k}|0`, matrix: at(i * 2) }))), geomSource());
  const bm = poolOf(reg, AXES.opaque).mesh;
  bm.updateMatrixWorld(true);
  const pc0 = getBatchedIndirectPerCameraStats();
  r.info.render.frame = 1;
  const c1 = draw(bm, cam);
  check("wrap: a marked pool draws ONE instanced multidraw of 3 runs (6 instances)", c1.kind === "inst" && c1.n === 3 && c1.inst.join() === "3,2,1", JSON.stringify(c1));
  check("wrap: the canonical texture is restored and nothing is left pending", bm._indirectTexture !== seenTex.at(-1) && __pendingForTest() === null);
  const runTex = seenTex.at(-1);
  const sA = getBatchedRunsStats();
  const c2 = draw(bm, cam2);
  check("wrap: a second camera draws the same runs from the SAME run texture", c2.kind === "inst" && c2.n === 3 && seenTex.at(-1) === runTex);
  const pc1 = getBatchedIndirectPerCameraStats();
  check("wrap: ?bmIndirectPerCamera passes the camera-independent pool straight through (one canonical texture)",
    pc1.passthrough - pc0.passthrough === 2 && pc1.calls === pc0.calls);
  r.info.render.frame = 2;
  draw(bm, cam); draw(bm, cam2);
  const sB = getBatchedRunsStats();
  check("wrap: settled frames, both cameras: zero rebuilds, zero uploads", sB.rebuilds === sA.rebuilds && sB.uploads === sA.uploads);
  r.info.render.frame = 3;
  draw(bm, cam); // closes frame 2
  const fr = getBatchedRunsStats().frame;
  check("frame: 2 pool draws asked for 12 ranges and issued 6 (issuedSubDraws < subDraws)",
    fr.batchedCalls === 2 && fr.subDraws === 12 && fr.issued === 6, JSON.stringify(fr));

  // Park → adopt: the list round-trips, so the run layout is reused as is.
  reg.parkTile(T);
  const cp = draw(bm, cam);
  check("park: a parked pool lists 0 ranges and issues no draw", bm._multiDrawCount === 0 && cp === calls.at(-1));
  const sC = getBatchedRunsStats();
  reg.adoptTile(T);
  const ca = draw(bm, cam);
  const sD = getBatchedRunsStats();
  check("adopt: back to the same 3 runs", ca.kind === "inst" && ca.inst.join() === "3,2,1");
  check("adopt: park → adopt re-derives nothing (compare hit, no upload)", sD.rebuilds === sC.rebuilds && sD.uploads === sC.uploads);

  // A membership event re-derives exactly once.
  reg.feedTile(planOf(tileKeyOf(3, 4), [member(AXES.opaque, { contentKey: "c|0", matrix: at(40) })]), geomSource());
  const cn = draw(bm, cam);
  const sE = getBatchedRunsStats();
  check("event: a new feed re-derives once (rebuild +1, upload +1) and joins its run",
    cn.kind === "inst" && cn.inst.join() === "3,2,2" && sE.rebuilds - sD.rebuilds === 1 && sE.uploads - sD.uploads === 1, JSON.stringify(cn));
  draw(bm, cam2);
  check("event: the other camera then hits the new layout", getBatchedRunsStats().rebuilds === sE.rebuilds);

  // A translucent pool steps aside (three's sorted list, three's draw).
  reg.feedTile(planOf(tileKeyOf(3, 3), [
    member(AXES.translucent, { contentKey: "g|0", matrix: at(0) }),
    member(AXES.translucent, { contentKey: "g|0", matrix: at(2) }),
  ]), geomSource());
  const tbm = poolOf(reg, AXES.translucent).mesh;
  tbm.updateMatrixWorld(true);
  const ct = draw(tbm, cam);
  check("step-aside: a translucent pool draws three's canonical multidraw", ct.kind === "elems" && ct.n === 2);

  uninstallBatchedRuns(r);
  uninstallBatchedIndirectPerCamera(THREE);
  __setBatchedRunsChunksForTest(false);
}

// --- B: node bounds follow membership ---------------------------------------------------------
{
  const { reg } = makeReg();
  const gs = geomSource();
  reg.feedTile(planOf(tileKeyOf(4, 4), [member(AXES.opaque, { matrix: at(0) })]), gs);
  const bm = poolOf(reg, AXES.opaque).mesh;
  bm.updateMatrixWorld(true);
  const east = new THREE.OrthographicCamera(590, 610, 10, -10, 0.1, 100);
  east.position.set(0, 0, 50); east.updateMatrixWorld(true);
  east.matrixWorldInverse.copy(east.matrixWorld).invert();
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(east.projectionMatrix, east.matrixWorldInverse));
  check("bounds: a camera looking 600 m east does not see the first tile's pool", fr.intersectsObject(bm) === false && bm.boundingSphere !== null);
  const dirtied0 = reg.census().bounds.dirtied;
  reg.feedTile(planOf(tileKeyOf(4, 5), [member(AXES.opaque, { matrix: at(600) })]), gs);
  // 2026-10-23 review (pools-dirtybounds-per-step): an ADD grows the cached sphere in place
  // (O(1)); nulling it made every frame with a W3 feed step recompute the pool over all of its
  // instances in the next cull.
  check("bounds: a feed into the same sector pool GROWS the cached node sphere (no recompute owed)",
    bm.boundingSphere !== null && reg.census().bounds.grown === 1 && reg.census().bounds.dirtied === dirtied0,
    JSON.stringify(reg.census().bounds));
  check("bounds: …so the next cull covers the new member (the pool is drawn)", fr.intersectsObject(bm) === true);
  check("bounds: …and the grown sphere holds every active instance", coversAll(bm));
  const dirtied = reg.census().bounds.dirtied;
  reg.parkTile(tileKeyOf(4, 5));
  reg.adoptTile(tileKeyOf(4, 5));
  check("bounds: park/adopt are visibility only — no bounds work", reg.census().bounds.dirtied === dirtied && bm.boundingSphere !== null);
  reg.releaseTile(tileKeyOf(4, 5));
  check("bounds: a release clears it again", bm.boundingSphere === null);
  check("bounds: …and the recomputed sphere drops the released member", fr.intersectsObject(bm) === false);

  // Stage B: one plan fed chunk by chunk over several frames, culled every frame (the render
  // loop between P4 slots). Grown per add, the sphere is never recomputed while the feed runs.
  const clock = { t: 0 };
  const sched = new FrameWorkScheduler({ now: () => clock.t, isInWorld: () => true, budgetMs: 6 });
  const ctl = new PoolStreamController({ registry: reg, scheduler: sched, feedChunk: 2 });
  let recomputes = 0;
  const own = bm.computeBoundingSphere;
  bm.computeBoundingSphere = function () { recomputes += 1; return own.call(this); };
  fr.intersectsObject(bm);
  const r0 = recomputes;
  ctl.onPlanReady(planOf(tileKeyOf(4, 6), Array.from({ length: 12 }, (_, i) => member(AXES.opaque, { contentKey: `bb${i % 3}|0`, matrix: at(600 - i * 50) }))), gs);
  let frames = 0;
  while (ctl.stats_().feedsInFlight > 0 && frames < 20) { ctl.tickP4(); sched.run({}); fr.intersectsObject(bm); frames += 1; }
  check("bounds: a 6-step stage-B feed, culled every frame, recomputes the node sphere 0 times",
    recomputes === r0 && frames >= 6 && ctl.stats.feedsCommitted === 1, `${recomputes - r0} recomputes over ${frames} frames`);
  check("bounds: …and the 600 m-east member it fed is inside the sphere the cull reads", fr.intersectsObject(bm) === true && coversAll(bm));
  delete bm.computeBoundingSphere;
}

// --- L: a band swap reaches the multidraw list under the early-out -----------------------------
{
  const { reg } = makeReg();
  reg.feedTile(planOf(tileKeyOf(5, 5), [
    member(AXES.opaque, { contentKey: "near|0", bandGids: ["near|0", "far|0"], band: 0, pos: { x: 0, y: 0, z: 0 } }),
  ]), geomSource());
  const p = poolOf(reg, AXES.opaque);
  const bm = p.mesh;
  bm.updateMatrixWorld(true);
  obr(bm);
  const bpe = bm.geometry.getIndex().array.BYTES_PER_ELEMENT;
  const nearGid = p.geomByContent.get("near|0|0");
  const farGid = p.geomByContent.get("far|0|0");
  const startOf = (gid) => bm.getGeometryRangeAt(gid).start * bpe;
  check("band: the near band's range is listed", bm._multiDrawStarts[0] === startOf(nearGid) && nearGid !== farGid);
  const swaps = reg.bandTick({ x: 0, y: 0, z: 120 }, 100);
  check("band: one swap past the hysteresis edge", swaps === 1);
  check("band: the swap raises _visibilityChanged (three's setGeometryIdAt does not)", bm._visibilityChanged === true);
  obr(bm);
  check("band: the next draw lists the FAR band's range", bm._multiDrawStarts[0] === startOf(farGid) && bm._multiDrawCount === 1);
  obr(bm);
  check("band: and settles back into the early-out", bm._visibilityChanged === false && bm._multiDrawStarts[0] === startOf(farGid));
}

// --- T: stage B — several TilePlans for one tile -----------------------------------------------
{
  const { reg } = makeReg();
  const gs = geomSource();
  const clock = { t: 0 };
  const sched = new FrameWorkScheduler({ now: () => clock.t, isInWorld: () => true, budgetMs: 6 });
  const uploads = new UploadStager({ renderer: { initTexture: () => {} }, now: () => clock.t });
  const ctl = new PoolStreamController({ registry: reg, scheduler: sched, uploads, feedChunk: 2 });
  const T = tileKeyOf(6, 6);
  const RS = 0x06000777;
  // Statics of LB 1, statics of LB 2 (gated on a texture), buildings of LB 1 —
  // three plans for one 2×2-LB tile, all arriving before any feed step ran.
  ctl.onPlanReady(planOf(T, [0, 1, 2].map((i) => member(AXES.opaque, { contentKey: `s${i}|0`, matrix: at(i * 2) }))), gs);
  ctl.onPlanReady(planOf(T, [3, 4].map((i) => member(AXES.opaque, { contentKey: `s${i}|0`, matrix: at(i * 2), rsId: RS }))), gs);
  ctl.onPlanReady(planOf(T, [member(AXES.opaque, { contentKey: "b0|0", matrix: at(20) })]), gs);
  const st0 = ctl.stats_();
  check("stage B: three plans for one tile are three feeds in flight on one tile", st0.feedsInFlight === 3 && st0.feedTiles === 1, JSON.stringify(st0));
  for (let f = 0; f < 8; f++) { ctl.tickP4(); sched.run({}); }
  const p = poolOf(reg, AXES.opaque);
  const vis = () => { let n = 0; for (let i = 0; i < p.instances; i++) if (p.mesh.getVisibleAt(i)) n++; return n; };
  check("stage B: the two ungated plans commit; the gated one waits on its texture",
    ctl.stats.feedsCommitted === 2 && ctl.stats_().feedsInFlight === 1 && vis() === 4, `committed ${ctl.stats.feedsCommitted}, visible ${vis()}/${p.instances}`);
  uploads.beginFrame();
  uploads.enqueueTexture({ texture: { isTexture: true }, rsId: RS, bytes: 1 });
  uploads.drain();
  for (let f = 0; f < 3; f++) { ctl.tickP4(); sched.run({}); }
  const mem = reg.tiles.get(T);
  const ids = mem ? [...mem.values()].reduce((n, m) => n + m.instanceIds.length, 0) : 0;
  check("stage B: once staged, every plan committed — all 6 instances LIVE, all in the tile's membership",
    ctl.stats.feedsCommitted === 3 && vis() === 6 && p.instances === 6 && ids === 6 && ctl.stats_().feedsInFlight === 0);
  reg.parkTile(T);
  check("stage B: the merged tile parks as one (every plan's instances)", vis() === 0);
  reg.adoptTile(T);

  // A vacate abandons EVERY plan of the tile still in flight.
  const T2 = tileKeyOf(7, 7);
  const before = p.instances;
  ctl.onPlanReady(planOf(T2, [member(AXES.opaque, { contentKey: "v0|0" }), member(AXES.opaque, { contentKey: "v1|0" })]), gs);
  ctl.onPlanReady(planOf(T2, [member(AXES.opaque, { contentKey: "v2|0" })]), gs);
  sched.run({});
  const ab0 = ctl.stats.feedsAbandoned;
  ctl.onVacate(T2);
  for (let f = 0; f < 3; f++) { ctl.tickP4(); sched.run({}); }
  check("stage B: a vacate abandons both in-flight plans; nothing of the tile persists",
    ctl.stats.feedsAbandoned - ab0 === 2 && !reg.tiles.has(T2) && p.instances === before && ctl.stats_().feedsInFlight === 0);
}

// --- V: a tile's LATER plans honour PARK (2026-10-23 review, pools-park-merge) -----------------
{
  const gs = geomSource();
  const world = () => {
    const { reg } = makeReg();
    const clock = { t: 0 };
    const sched = new FrameWorkScheduler({ now: () => clock.t, isInWorld: () => true, budgetMs: 6 });
    // The LIVE wiring: pool_producer.js builds the controller with no UploadStager.
    const ctl = new PoolStreamController({ registry: reg, scheduler: sched, feedChunk: 2 });
    return { reg, ctl, frame: () => { ctl.tickP4(); sched.run({}); } };
  };
  const vis = (reg) => {
    let v = 0, a = 0;
    for (const p of reg.pools.values()) for (const ii of p.mesh._instanceInfo) { if (!ii.active) continue; a++; if (ii.visible) v++; }
    return { v, a };
  };
  const liveOf = (reg, T) => [...(reg.tiles.get(T) || new Map()).values()].map((m) => m.live);
  {
    // Plan A (LB 1) commits; the grid parks the tile while plan B (LB 2) is still feeding.
    const { reg, ctl, frame } = world();
    const T = tileKeyOf(8, 8);
    ctl.onPlanReady(planOf(T, [member(AXES.opaque, { contentKey: "pa|0" })]), gs);
    ctl.onPlanReady(planOf(T, [1, 2, 3, 4, 5].map((i) => member(AXES.opaque, { contentKey: `pb${i}|0`, matrix: at(i * 2) }))), gs);
    frame(); frame();
    check("park: plan A committed, plan B still feeding", ctl.stats.feedsCommitted === 1 && ctl.stats_().feedsInFlight === 1);
    ctl.enqueuePark(T); frame();
    check("park: the parked tile draws nothing", vis(reg).v === 0);
    for (let f = 0; f < 6; f++) frame();
    const c = vis(reg);
    check("park: plan B commits INTO the parked tile — its instances stay invisible, the record reads parked",
      ctl.stats.feedsCommitted === 2 && c.v === 0 && c.a === 6 && liveOf(reg, T).every((l) => l === false), JSON.stringify({ ...c, live: liveOf(reg, T) }));
    ctl.enqueueAdopt(T); frame();
    const d = vis(reg);
    check("park: the re-adopt brings back BOTH plans' instances", d.v === 6 && d.a === 6, JSON.stringify(d));
  }
  {
    // Parked before ANY plan of the tile committed (no record to flip yet).
    const { reg, ctl, frame } = world();
    const T = tileKeyOf(8, 9);
    ctl.onPlanReady(planOf(T, [1, 2, 3].map((i) => member(AXES.opaque, { contentKey: `pc${i}|0`, matrix: at(i) }))), gs);
    ctl.enqueuePark(T);
    for (let f = 0; f < 4; f++) frame();
    const c = vis(reg);
    check("park: a tile parked before its first commit stays invisible when the plan lands", ctl.stats.feedsCommitted === 1 && c.v === 0 && c.a === 3, JSON.stringify(c));
    ctl.enqueueAdopt(T); frame();
    check("park: …and its re-adopt shows it", vis(reg).v === 3);
    check("park: adopt clears the tile's park mark", reg.census().tiles.parked === 0);
  }
}

// --- VP: the LIVE wiring vacates in-flight plans (2026-10-23 review, pools-vacate-unwired) -------
// The producer's own hooks (`poolOnSlotState`, `poolOnTeleport`) over the armed stage-B world
// (`?frameWork=on` ⇒ the controller on the frame_work singleton), exactly as index.js wires them.
{
  const ARMED_FW = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on&frameWork=on";
  const quiet = console.warn;
  console.warn = () => {};
  const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = { surfaceDid: 0x08000021, __pvwRsId: 0x06000021 };
  const geomOf = (seed) => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(9).map((_, i) => Math.sin(seed * 7.1 + i));
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6).fill(0.25), 2));
    g.setIndex([0, 1, 2]);
    return g;
  };
  const nodesOf = (seed, n) => Array.from({ length: n }, (_, i) => { const m = new THREE.Mesh(geomOf(seed), mat); m.position.set(i * 3, 0, 0); return m; });
  try {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    const w = initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED_FW });
    check("wiring: ?frameWork=on arms the stage-B controller", !!w && !!w.controller);
    const reg = w.registry;
    const sched = getFrameWorkScheduler();
    const drain = (n = 6) => { for (let f = 0; f < n; f++) { poolTickP4(); sched.run({}); } };
    const vis = () => {
      let v = 0, a = 0;
      for (const p of reg.pools.values()) for (const ii of p.mesh._instanceInfo) { if (!ii.active) continue; a++; if (ii.visible) v++; }
      return { v, a };
    };
    const LB1 = 0x50500000, LB2 = 0x51500000; // two LBs of ONE tile
    const T = tileOfLb(0x50, 0x50);
    check("wiring: the two LBs share one tile", tileOfLb(0x51, 0x50) === T);

    addSingletonsToPools(nodesOf(1, 2), {}, { domain: "st", lbKey: LB1 });
    drain();
    check("wiring: LB 1's plan is resident and drawn", reg.isTileResident(T) && vis().v === 2);
    // LB 2's plan is still in flight when the grid drops the tile.
    addSingletonsToPools(nodesOf(2, 3), {}, { domain: "st", lbKey: LB2 });
    poolOnSlotState({ tile: T, from: "STAGED", to: "EMPTY" });
    drain();
    const e = vis();
    check("vacate: EMPTY abandons the plan still in flight — the tile does not come back resident",
      !reg.isTileResident(T) && e.a === 0 && w.controller.stats.feedsAbandoned === 1, JSON.stringify({ resident: reg.isTileResident(T), ...e }));

    // A plan landing while the tile is EMPTY is handed back to the legacy producer, never lost.
    const late = nodesOf(3, 2);
    const r = addSingletonsToPools(late, {}, { domain: "st", lbKey: LB1 });
    drain();
    check("vacate: a plan for an EMPTY tile comes back as passthrough (legacy renders it)",
      r.pooled === 0 && r.passthrough.length === 2 && late.every((n) => r.passthrough.includes(n)) && !reg.isTileResident(T),
      JSON.stringify({ pooled: r.pooled, pt: r.passthrough.length }));
    check("vacate: counted on the producer census", poolWorldCensus().producer.vacatedPassthrough === 2);

    // Re-admitted by ANY path — here FETCHING with no onShift/onSeed, as a teleport re-admit or
    // `readmitEmptyTiles` does it — the grid's own transition clears the vacate.
    poolOnSlotState({ tile: T, from: "EMPTY", to: "FETCHING" });
    const again = addSingletonsToPools(nodesOf(1, 2), {}, { domain: "st", lbKey: LB1 });
    drain();
    check("vacate: after a re-admit the tile's plans pool again", again.pooled === 2 && reg.isTileResident(T) && vis().v === 2);

    // Teleport: the vacated set drains as releases AND abandons what is in flight.
    addSingletonsToPools(nodesOf(4, 2), {}, { domain: "st", lbKey: LB2 });
    poolOnTeleport({ vacated: [T] });
    drain();
    check("vacate: a teleport abandons the vacated tile's in-flight plan too", !reg.isTileResident(T) && vis().a === 0);

    // A tile PARKED with nothing committed, then EMPTY: the park mark must not outlive the
    // slot (a stale mark would hold the tile's next life invisible).
    const T2 = tileOfLb(0x60, 0x60);
    poolOnSlotState({ tile: T2, from: "LIVE", to: "PARKED" });
    drain();
    check("park mark: a park with nothing resident still marks the tile", reg.census().tiles.parked === 1);
    poolOnSlotState({ tile: T2, from: "PARKED", to: "EMPTY" });
    check("park mark: EMPTY clears it with nothing resident to release", reg.census().tiles.parked === 0);
    poolOnSlotState({ tile: T2, from: "EMPTY", to: "STAGED" });
    addSingletonsToPools(nodesOf(5, 2), {}, { domain: "st", lbKey: 0x60600000 });
    drain();
    const t2 = [...reg.tiles.get(T2).values()].every((m) => m.live === true);
    check("park mark: the tile's next life commits LIVE", t2 && vis().v === vis().a && vis().a === 2);
  } finally {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    console.warn = quiet;
  }
}

// --- C: the producer's content key ---------------------------------------------------------------
{
  const ARMED = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";
  /** A model as one LB's decode mints it: a FRESH object, the model's bytes. */
  function modelGeom(seed, { interleaved = false, normalizedUv = false, baked = false, verts = 6 } = {}) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), uv = new Float32Array(verts * 2);
    for (let i = 0; i < pos.length; i++) pos[i] = Math.sin(seed * 13.7 + i) * 2;
    for (let i = 0; i < nor.length; i++) nor[i] = (i % 3) === 2 ? 1 : 0;
    for (let i = 0; i < uv.length; i++) uv[i] = (seed + i * 0.125) % 1;
    if (interleaved) {
      const buf = new THREE.InterleavedBuffer(new Float32Array(verts * 8), 8);
      for (let v = 0; v < verts; v++) {
        buf.array.set([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2], uv[v * 2], uv[v * 2 + 1]], v * 8);
      }
      g.setAttribute("position", new THREE.InterleavedBufferAttribute(buf, 3, 0));
      g.setAttribute("normal", new THREE.InterleavedBufferAttribute(buf, 3, 3));
      g.setAttribute("uv", new THREE.InterleavedBufferAttribute(buf, 2, 6));
    } else {
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      g.setAttribute("uv", normalizedUv
        ? new THREE.BufferAttribute(Uint16Array.from(uv, (x) => Math.round(x * 65535)), 2, true)
        : new THREE.BufferAttribute(uv, 2));
    }
    if (baked) g.setAttribute("acBakedLight", new THREE.BufferAttribute(new Uint8Array(verts * 3).fill(128), 3, true));
    const idx = [];
    for (let i = 0; i + 2 < verts; i += 3) idx.push(i, i + 1, i + 2);
    g.setIndex(idx);
    return g;
  }
  const { hash, same } = _poolContentForTest;
  check("content: two fresh objects with the same bytes hash and compare equal",
    hash(modelGeom(1)) === hash(modelGeom(1)) && same(modelGeom(1), modelGeom(1)));
  const g1 = modelGeom(1);
  const moved = modelGeom(1); moved.attributes.position.array[4] += 1e-6;
  check("content: one moved vertex ⇒ a different key, and NOT the same content", hash(moved) !== hash(g1) && !same(moved, g1));
  const reIdx = modelGeom(1); reIdx.setIndex([0, 2, 1, 3, 4, 5]);
  check("content: a different index ⇒ different", hash(reIdx) !== hash(g1) && !same(reIdx, g1));
  check("content: a normalized-integer uv is not the float uv", hash(modelGeom(1, { normalizedUv: true })) !== hash(g1) && !same(modelGeom(1, { normalizedUv: true }), g1));
  check("content: an acBakedLight attribute is part of the content", hash(modelGeom(1, { baked: true })) !== hash(g1) && !same(modelGeom(1, { baked: true }), g1));
  check("content: interleaved streams hash and compare by component",
    hash(modelGeom(2, { interleaved: true })) === hash(modelGeom(2, { interleaved: true })) && same(modelGeom(2, { interleaved: true }), modelGeom(2, { interleaved: true })));
  check("content: interleaved vs plain with equal values compare equal (keys stay apart — conservative)",
    same(modelGeom(2, { interleaved: true }), modelGeom(2)) && hash(modelGeom(2, { interleaved: true })) !== hash(modelGeom(2)));

  // 2026-10-23 review (pools-hash-not-64bit): the key must be a real 64-bit hash on float data.
  // Plain FNV over 32-bit words never moves a high-bit difference down, so equal deltas in two
  // words (two sign flips, a mirrored model) cancelled in BOTH lanes.
  const flip2 = modelGeom(1); { const a = flip2.attributes.position.array; a[4] = -a[4]; a[10] = -a[10]; }
  check("content: two sign flips do not cancel", hash(flip2) !== hash(g1) && !same(flip2, g1));
  const mirror = modelGeom(1); { const a = mirror.attributes.position.array; for (let v = 0; v < 6; v++) a[v * 3] = -a[v * 3]; }
  check("content: a mirrored model (x negated on an even vertex count) keys apart", hash(mirror) !== hash(g1));
  {
    let seed = 0x2545f491;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const base = hash(modelGeom(1, { verts: 12 }));
    let coll = 0;
    for (let t = 0; t < 2000; t++) {
      const g = modelGeom(1, { verts: 12 });
      const u = new Uint32Array(g.attributes.position.array.buffer);
      const i = (rnd() * u.length) | 0;
      const j = (i + 1 + ((rnd() * (u.length - 1)) | 0)) % u.length;
      const d = ((((rnd() * 255) | 0) + 1) << 24) >>> 0;
      u[i] ^= d; u[j] ^= d;
      if (hash(g) === base) coll += 1;
    }
    check("content: the same high-byte delta in two words never collides (2,000 trials)", coll === 0, `${coll} collisions`);
  }

  // 2026-10-23 review (pools-contentkey-sync-cost): geom_bundles.js `_subsetsToGroups` hands
  // every per-surface group of a model the SAME vertex stream objects, so a stream is hashed
  // once per model (not once per surface) and verified once per (representative, candidate)
  // stream pair; only the per-group index is per group.
  function groupsOf(seed, K, verts = 30) {
    const base = modelGeom(seed, { verts });
    return Array.from({ length: K }, (_, k) => {
      const g = new THREE.BufferGeometry();
      for (const n of ["position", "normal", "uv"]) g.setAttribute(n, base.attributes[n]);
      g.setIndex([0, 1, 2].map((i) => (k * 3 + i) % verts));
      return g;
    });
  }
  {
    const st = { contentStreamsHashed: 0, contentStreamsVerified: 0 };
    const lbA = groupsOf(21, 4), lbB = groupsOf(21, 4);
    const ka = lbA.map((g) => hash(g, st));
    check("content: 4 surface groups over one model's streams hash 3 streams + 4 indices (7, not 16)",
      st.contentStreamsHashed === 7, JSON.stringify(st));
    const kb = lbB.map((g) => hash(g, st));
    check("content: the other LB's copy keys identically, again 7 stream hashes", st.contentStreamsHashed === 14 && kb.join() === ka.join());
    const eq = lbA.every((g, k) => same(g, lbB[k], st));
    check("content: verifying the 4 cross-LB groups compares 3 streams once + 4 indices (7)", eq && st.contentStreamsVerified === 7, JSON.stringify(st));
    check("content: distinct surfaces of one model key apart (their indices differ)", new Set(ka).size === 4);
  }

  const quiet = console.warn;
  console.warn = () => {};
  const tex = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex });
  mat.userData = { surfaceDid: 0x08000020, __pvwRsId: 0x06000020 };
  const node = (geom, x) => { const n = new THREE.Mesh(geom, mat); n.position.set(x, 0, 0); return n; };
  try {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED });
    // LB 0x40,0x40 and LB 0x41,0x40 (one sector) each decode the same two
    // models into their OWN objects; LB 1 places model A twice (one object).
    const lb1A = modelGeom(7), lb1B = modelGeom(8), lb2A = modelGeom(7), lb2B = modelGeom(8);
    addSingletonsToPools([node(lb1A, 0), node(lb1A, 4), node(lb1B, 8)], {}, { domain: "st", lbKey: 0x40400000 });
    addSingletonsToPools([node(lb2A, 12), node(lb2B, 16)], {}, { domain: "st", lbKey: 0x41400000 });
    const reg = getPoolRegistry();
    const pools = [...reg.pools.values()];
    const p = pools[0];
    const prod = poolWorldCensus().producer;
    check("content: 5 placements of 2 models from 2 LBs → ONE pool, 2 pool geometries",
      pools.length === 1 && p.instances === 5 && p.gids.size === 2, `pools ${pools.length}, gids ${p && p.gids.size}`);
    check("content: 4 geometry objects hashed once each; the 2 cross-LB copies verified and shared; 0 collisions",
      prod.contentHashed === 4 && prod.contentShared === 2 && prod.contentCollisions === 0, JSON.stringify({ h: prod.contentHashed, s: prod.contentShared, c: prod.contentCollisions }));
    check("content: the pool is marked for runs", isBatchedRunsMarked(p.mesh) && p.runs === true);
    p.mesh.updateMatrixWorld(true);
    obr(p.mesh);
    const st = prepareRunDraw(p.mesh);
    check("content: the cross-LB repeats regroup — 5 ranges → 2 runs (3 + 2)",
      st !== null && st.buf.r === 2 && [...st.buf.inst.subarray(0, 2)].join() === "3,2");

    // A hash hit whose bytes differ (a collision, staged by planting a foreign
    // representative under the key) must never share: it takes the key's next
    // chained slot (2026-10-23 review — was the object's own uuid, which cost
    // the colliding content its cross-LB sharing for the session).
    const victim = modelGeom(9);
    const vk = hash(victim);
    getPoolWorld().geomByContent.set(vk, modelGeom(10));
    const gidsBefore = p.gids.size;
    addSingletonsToPools([node(victim, 20)], {}, { domain: "st", lbKey: 0x40400000 });
    const prod2 = poolWorldCensus().producer;
    check("content: a verified MISMATCH on a hash hit is counted and never shares the foreign geometry",
      prod2.contentCollisions === 1 && getPoolWorld().geomByContent.get(`${vk}~1`) === victim && p.gids.size === gidsBefore + 1);
    addSingletonsToPools([node(modelGeom(9), 24)], {}, { domain: "st", lbKey: 0x41400000 });
    const prod3 = poolWorldCensus().producer;
    check("content: a later copy of the colliding content still shares (the chained representative), one collision counted",
      prod3.contentShared === prod2.contentShared + 1 && prod3.contentCollisions === 1 && p.gids.size === gidsBefore + 1,
      JSON.stringify({ s: prod3.contentShared - prod2.contentShared, c: prod3.contentCollisions, g: p.gids.size - gidsBefore }));

    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED + "&poolRuns=off" });
    addSingletonsToPools([node(modelGeom(7), 0), node(modelGeom(7), 4)], {}, { domain: "st", lbKey: 0x40400000 });
    const pOff = [...getPoolRegistry().pools.values()][0];
    check("content: ?poolRuns=off keeps the object-identity key (2 objects → 2 pool geometries, unmarked)",
      pOff.gids.size === 2 && !isBatchedRunsMarked(pOff.mesh) && poolWorldCensus().producer.contentHashed === 0);
  } finally {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    console.warn = quiet;
  }
}

// --- P8: the producer hands the registry the real marker ---------------------------------------
{
  const ARMED = "?drawPools=on&slotGrid=on&packSource=on&geomBundles=on&texCompressedOnly=on";
  const quiet = console.warn;
  console.warn = () => {};
  try {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    const w = initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED });
    check("producer: the armed world's registry carries batched_runs' markBatchedRuns",
      !!w && w.registry.markRuns === markBatchedRuns && w.registry.census().runs.injected === true);
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    const w2 = initPoolWorld({ THREE, group: new THREE.Group(), search: ARMED + "&poolRuns=off" });
    check("producer: ?poolRuns=off arms the world with no marker",
      !!w2 && w2.registry.markRuns === null && w2.registry.census().runs.enabled === false);
  } finally {
    _resetPoolWorldForTest(); _resetDrawPoolsForTest();
    console.warn = quiet;
  }
}

console.log(`\npool_runs: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
