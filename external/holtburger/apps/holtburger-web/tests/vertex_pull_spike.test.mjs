// 2026-10-22 — handoff P4 SPIKE (GPU-resident statics §6 L3, vertex pulling), the
// CPU half. Harness only: harness/glsl_smoke/vertex_pull_lib.mjs is imported by the
// smoke page and by this test, never by scene3d/.
//
// What is pinned here, without a GPU:
//   * the three r184 premises the spike leans on (renderBufferDirect's draw-range
//     clamp and early return, BufferGeometry's Infinity default, integer attributes,
//     the fragment USE_COLOR_ALPHA for batching colours, the program-cache trap);
//   * the vertex/fragment patch: anchors, the gl_DrawID-free result (with and
//     without batched_runs.js's chunk patch), hbPull() first in main(), the
//     position/normal/uv redirect reaching only the intended uses, refusal on drift;
//   * the data half, by EMULATING both draws on the CPU: the BatchedMesh arm as
//     three builds its canonical list and batched_runs.js regroups it into runs,
//     and every pulled arm (packed / pair / attribute / indexed) through mirrors of
//     the GLSL addressing — the same (position, normal, uv, slot) for every corner
//     in the same primitive order, bit for bit;
//   * the instance textures' layout against a real BatchedMesh's;
//   * the bit budget of the packed u32 and the bytes the doc quotes.
// The GPU half (the GLSL compiling, linking and drawing A's exact pixels) is
// harness/glsl_smoke/vertex_pull_smoke.mjs (headless Chromium, orchestrator only).
//
// Run:
//   cd apps/holtburger-web/
//   node tests/vertex_pull_spike.test.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { patchBatchingChunks, buildRuns, makeRunBuffers, RUN_MARKER } from "../scene3d/batched_runs.js";
import * as VP from "../harness/glsl_smoke/vertex_pull_lib.mjs";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// --- premises, anchored in three's source ------------------------------------------
{
  const require = createRequire(import.meta.url);
  const dir = require.resolve("three").replace(/[^/\\]+$/, "");
  const mod = readFileSync(dir + "three.module.js", "utf8");
  const core = readFileSync(dir + "three.core.js", "utf8");
  check("premise: renderBufferDirect clamps by the index first",
    mod.includes("if ( index !== null ) {\n\n\t\t\t\tdrawStart = Math.max( drawStart, 0 );\n\t\t\t\tdrawEnd = Math.min( drawEnd, index.count );"));
  check("premise: ... else ONLY by a position attribute (no other attribute clamps)",
    mod.includes("} else if ( position !== undefined && position !== null ) {\n\n\t\t\t\tdrawStart = Math.max( drawStart, 0 );\n\t\t\t\tdrawEnd = Math.min( drawEnd, position.count );"));
  check("premise: the early return is drawCount < 0 || Infinity (not 'no position')",
    mod.includes("if ( drawCount < 0 || drawCount === Infinity ) return;"));
  check("premise: setProgram runs BEFORE the early return (a no-range draw still compiles)",
    mod.indexOf("const program = setProgram( camera, scene, geometry, material, object );")
      < mod.indexOf("if ( drawCount < 0 || drawCount === Infinity ) return;"));
  check("premise: BufferGeometry.drawRange defaults to { start: 0, count: Infinity }",
    core.includes("this.drawRange = { start: 0, count: Infinity };"));
  check("premise: a Uint32 attribute binds through vertexAttribIPointer",
    mod.includes("const integer = ( type === gl.INT || type === gl.UNSIGNED_INT || geometryAttribute.gpuType === IntType );"));
  check("premise: the FRAGMENT prefix defines USE_COLOR_ALPHA for batching colours",
    mod.includes("parameters.vertexAlphas || parameters.batchingColor ? '#define USE_COLOR_ALPHA' : '',"));
  check("premise: USE_BATCHING / USE_BATCHING_COLOR come from parameters.batching(Color) (BatchedMesh only)",
    mod.includes("parameters.batching ? '#define USE_BATCHING' : '',") && mod.includes("parameters.batchingColor ? '#define USE_BATCHING_COLOR' : '',"));
  check("premise: the default program-cache key is onBeforeCompile.toString() (one factory = one program unless overridden)",
    /customProgramCacheKey\(\) \{\s*return this\.onBeforeCompile\.toString\(\);/.test(core));
  check("premise: three binds batching uniforms only for isBatchedMesh (a pulled Mesh names its own)",
    mod.includes("if ( object.isBatchedMesh ) {\n\n\t\t\t\tp_uniforms.setOptional( _gl, object, 'batchingTexture' );"));
  const pars = THREE.ShaderChunk.batching_pars_vertex;
  check("premise: three's getBatchingMatrix body is the one PULL_VERTEX_PARS copies",
    pars.includes("int size = textureSize( batchingTexture, 0 ).x;\n\t\tint j = int( i ) * 4;")
    && VP.PULL_VERTEX_PARS.includes("int size = textureSize( hbMatrices, 0 ).x;\n\tint j = int( i ) * 4;"));
  check("premise: three's getBatchingColor body is the one PULL_VERTEX_PARS copies",
    pars.includes("int size = textureSize( batchingColorTexture, 0 ).x;\n\t\tint j = int( i );")
    && VP.PULL_VERTEX_PARS.includes("int size = textureSize( hbColors, 0 ).x;\n\t\tint j = int( i );"));
}

// --- the shader patch -----------------------------------------------------------------
function resolveIncludes(src, chunks) {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    if (typeof chunks[name] !== "string") throw new Error("unknown chunk " + name);
    return resolveIncludes(chunks[name], chunks);
  });
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
{
  const stockChunks = THREE.ShaderChunk;
  const p = patchBatchingChunks(stockChunks);
  check("batched_runs.js chunk patch available for the comparison", p !== null);
  const runChunks = { ...stockChunks, batching_pars_vertex: p.pars, batching_vertex: p.vert, color_vertex: p.color };
  const vs0 = THREE.ShaderLib.standard.vertexShader;
  const fs0 = THREE.ShaderLib.standard.fragmentShader;
  const a = VP.patchPullVertex(vs0, stockChunks, { colors: true });
  const b = VP.patchPullVertex(vs0, runChunks, { colors: true });
  check("vertex patch applies on three's stock chunks", typeof a === "string");
  check("vertex patch applies under batched_runs.js's chunks — and gives the same text", typeof b === "string" && a === b);
  check("vertex patch: USE_BATCHING + USE_BATCHING_COLOR defined at the body top",
    a.startsWith("#define USE_BATCHING\n#define USE_BATCHING_COLOR\n"));
  check("vertex patch: hbPull() is the first statement of main()", a.includes("void main() {\n\thbPull();\n"));
  check("vertex patch: no batching include left to resolve",
    !/#include <(batching_pars_vertex|batching_vertex|color_vertex)>/.test(a));
  const resolved = resolveIncludes(a, runChunks);
  const code = stripComments(resolved);
  check("resolved vertex reads no gl_DrawID, no indirect texture, no runs helper",
    !/\bgl_DrawID\b|\bgetIndirectIndex\b|\bbatchingIdTexture\b|\bhbBatchSlot\b|\bbatchingTexture\b|\bbatchingColorTexture\b/.test(code));
  check("resolved vertex: batchingMatrix comes from the pulled slot",
    code.includes("mat4 batchingMatrix = getBatchingMatrix( hbSlot );"));
  check("resolved vertex: the colour comes from the pulled slot",
    code.includes("vColor *= getBatchingColor( hbSlot );"));
  check("resolved vertex: three's batched transform chunks still apply batchingMatrix",
    code.includes("mvPosition = batchingMatrix * mvPosition;") && code.includes("mat3 bm = mat3( batchingMatrix );"));
  // Every use of the redirected names after the #defines must be one we meant.
  const after = code.slice(code.indexOf("#define uv hbUv") + "#define uv hbUv".length);
  const uses = [...after.matchAll(/^.*\b(position|normal|uv)\b.*$/gm)].map((m) => m[0].trim());
  const allowed = new Set(["vec3 transformed = vec3( position );", "vPosition = vec3( position );",
    "vec3 objectNormal = vec3( normal );", "vUv = vec3( uv, 1 ).xy;"]);
  check("redirect reaches only begin_vertex / beginnormal_vertex / uv_vertex",
    uses.length >= 3 && uses.every((u) => allowed.has(u)), JSON.stringify(uses));
  check("redirect is declared after the prefix attributes would be (in the body, after the pars)",
    code.indexOf("#define position hbPos") > code.indexOf("vec3 hbPos;"));
  const f = VP.patchPullFragment(fs0, { colors: true });
  check("fragment patch: USE_COLOR_ALPHA guarded at the top", f.startsWith("#ifndef USE_COLOR_ALPHA\n#define USE_COLOR_ALPHA\n#endif\n") && f.endsWith(fs0));
  check("fragment patch: no colours -> untouched", VP.patchPullFragment(fs0, { colors: false }) === fs0);
  check("vertex patch refuses drift (no batching_vertex include)",
    VP.patchPullVertex(vs0.replace("#include <batching_vertex>", ""), stockChunks) === null);
  check("vertex patch refuses drift (colour fetch rewritten upstream)",
    VP.patchPullVertex(vs0, { ...stockChunks, color_vertex: "vColor *= getBatchingColor( 0.0 );" }) === null);
  check("vertex patch refuses a doubled anchor", VP.patchPullVertex(vs0 + "\n#include <color_vertex>", stockChunks) === null);

  // makePullMaterial: onBeforeCompile on a three-shaped shader object, and the cache key.
  const tex = { isTexture: true };
  const m1 = VP.makePullMaterial(new THREE.MeshStandardMaterial(), stockChunks, { stream: VP.STREAM_PACKED, vbits: 9, uniforms: { hbArena: tex } });
  const m2 = VP.makePullMaterial(new THREE.MeshStandardMaterial(), stockChunks, { stream: VP.STREAM_PAIR, vbits: 9, uniforms: { hbArena: tex } });
  const shader = { vertexShader: vs0, fragmentShader: fs0, uniforms: {} };
  m1.onBeforeCompile(shader);
  check("makePullMaterial: patches both stages and adds the uniforms",
    shader.vertexShader === VP.patchPullVertex(vs0, stockChunks) && shader.fragmentShader.startsWith("#ifndef USE_COLOR_ALPHA")
    && shader.uniforms.hbArena && shader.uniforms.hbArena.value === tex);
  check("makePullMaterial: keeps MeshStandardMaterial's STANDARD define, adds the stream switches",
    m1.defines.STANDARD === "" && m1.defines.HB_PULL_STREAM === "1" && m1.defines.HB_PULL_VBITS === "9");
  check("makePullMaterial: one program per stream encoding (cache keys differ; toString would not)",
    m1.customProgramCacheKey() !== m2.customProgramCacheKey() && m1.onBeforeCompile.toString() === m2.onBeforeCompile.toString());
  let threw = false;
  try { VP.makePullMaterial(new THREE.MeshStandardMaterial(), { color_vertex: "" }).onBeforeCompile({ vertexShader: vs0, fragmentShader: fs0, uniforms: {} }); } catch (_) { threw = true; }
  check("makePullMaterial: drift throws at compile instead of drawing garbage", threw);
}

// --- the data half: emulate both draws ---------------------------------------------------
{
  const { geoms, instances } = VP.buildSpikeScene(THREE);
  const bm = new THREE.BatchedMesh(VP.SPIKE_MAX_INSTANCES, 4096, 8192, new THREE.MeshStandardMaterial());
  const gid = geoms.map((g) => bm.addGeometry(g));
  instances.forEach((it, k) => { const id = bm.addInstance(gid[it.geom]); bm.setMatrixAt(id, it.matrix); bm.setColorAt(id, it.color); });
  // three's canonical list (unsorted, every instance visible), then batched_runs' runs.
  bm.perObjectFrustumCulled = false;
  bm.sortObjects = false;
  bm.onBeforeRender(null, null, new THREE.PerspectiveCamera(), bm.geometry, bm.material);
  const n = bm._multiDrawCount;
  const ids = bm._indirectTexture.image.data;
  const out = makeRunBuffers();
  const R = buildRuns(bm._multiDrawStarts, bm._multiDrawCounts, ids, n, out);
  check("BatchedMesh canonical list holds every instance", n === instances.length);
  check("batched_runs groups the bucket (runs < instances)", R === geoms.length && R < n, `R=${R} n=${n}`);

  const instanceGeom = Int32Array.from(instances, (it) => it.geom);
  const { order, runs } = VP.groupedOrder(instanceGeom);
  check("groupedOrder == batched_runs' run layout (same runs, same id order)",
    out.layout[0] === RUN_MARKER && runs.length === R
    && Array.from(order).every((s, i) => s === out.layout[1 + R + i])
    && runs.every((r, ri) => out.layout[1 + ri] === 1 + R + r.first && out.inst[ri] === r.count));

  // A's corner sequence: for run r, for instance i, for index k of range r.
  const bpe = bm.geometry.index.array.BYTES_PER_ELEMENT;
  const P = bm.geometry.attributes.position.array, N = bm.geometry.attributes.normal.array, U = bm.geometry.attributes.uv.array;
  const I = bm.geometry.index.array;
  const aCorners = [];
  for (let r = 0; r < R; r++) {
    for (let i = 0; i < out.inst[r]; i++) {
      const slot = out.layout[out.layout[1 + r] + i];
      for (let k = 0; k < out.counts[r]; k++) {
        const v = I[out.starts[r] / bpe + k];
        aCorners.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2], N[v * 3], N[v * 3 + 1], N[v * 3 + 2], U[v * 2], U[v * 2 + 1], slot]);
      }
    }
  }
  const arena = VP.buildArena(geoms);
  const fromArena = (v, slot) => { const a = VP.fetchArenaVertex(arena, v); return [...a.pos, ...a.nrm, ...a.uv, slot]; };
  const sameSeq = (seq) => seq.length === aCorners.length && seq.every((c, i) => c.every((x, j) => Object.is(Math.fround(x), Math.fround(aCorners[i][j]))));

  const packed = VP.buildCornerStream(geoms, arena, instanceGeom, order, "packed");
  const pair = VP.buildCornerStream(geoms, arena, instanceGeom, order, "pair");
  const indexed = VP.buildIndexedStream(geoms, arena, instanceGeom, order);
  const seqPacked = [], seqPair = [], seqAttr = [], seqIndexed = [];
  const attr = packed.data.slice(0, packed.corners);
  for (let c = 0; c < packed.corners; c++) {
    let d = VP.decodeStreamEntry(packed, c); seqPacked.push(fromArena(d.vertex, d.slot));
    d = VP.decodeStreamEntry(pair, c); seqPair.push(fromArena(d.vertex, d.slot));
    d = VP.decodePackedValue(attr[c], packed.vbits); seqAttr.push(fromArena(d.vertex, d.slot));
    d = VP.decodeStreamEntry(indexed, indexed.index[c]); seqIndexed.push(fromArena(d.vertex, d.slot));
  }
  check("corner count: pulled corners == BatchedMesh run corners", packed.corners === aCorners.length && indexed.corners === aCorners.length);
  check("B_packed (R32UI) reaches A's (position, normal, uv, slot) for every corner, in order", sameSeq(seqPacked));
  check("B_pair (RG32UI) reaches the same", sameSeq(seqPair));
  check("B_attr (u32 attribute) reaches the same", sameSeq(seqAttr));
  check("B_index (stream + index buffer) reaches the same", sameSeq(seqIndexed));
  check("arena width is even (a vertex's two texels share a row)", arena.width % 2 === 0 && arena.width * arena.height >= 2 * arena.vertices);

  // Instance textures in BatchedMesh's layout.
  const mSide = VP.batchingMatricesSide(VP.SPIKE_MAX_INSTANCES);
  const cSide = VP.batchingColorsSide(VP.SPIKE_MAX_INSTANCES);
  const matrices = new Float32Array(mSide * mSide * 4);
  const colors = new Float32Array(cSide * cSide * 4).fill(1);
  instances.forEach((it, k) => { it.matrix.toArray(matrices, k * 16); it.color.toArray(colors, k * 4); });
  const eq = (x, y) => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
  check("matrices texture: BatchedMesh's dims and bit-equal data",
    bm._matricesTexture.image.width === mSide && bm._matricesTexture.image.height === mSide && eq(matrices, bm._matricesTexture.image.data));
  check("colours texture: BatchedMesh's dims and bit-equal data",
    bm._colorsTexture.image.width === cSide && eq(colors, bm._colorsTexture.image.data));

  // The geometry three draws.
  const sphere = new THREE.Sphere(new THREE.Vector3(1, 2, 3), 9);
  const gNon = VP.makePullGeometry(THREE, { corners: packed.corners, sphere });
  const gAttr = VP.makePullGeometry(THREE, { corners: packed.corners, sphere, attr });
  const gIdx = VP.makePullGeometry(THREE, { corners: indexed.corners, sphere, index: indexed.index });
  // renderBufferDirect's arithmetic (premises above) applied to each geometry.
  const drawCount = (g) => {
    let s0 = g.drawRange.start, e0 = g.drawRange.start + g.drawRange.count;
    if (g.index !== null) { s0 = Math.max(s0, 0); e0 = Math.min(e0, g.index.count); }
    else if (g.attributes.position) { s0 = Math.max(s0, 0); e0 = Math.min(e0, g.attributes.position.count); }
    const c = e0 - s0;
    return c < 0 || c === Infinity ? null : c;
  };
  check("pulled geometry carries no position attribute", !gNon.attributes.position && !gAttr.attributes.position && !gIdx.attributes.position);
  check("non-indexed pull: drawRange makes the draw (corners), without it three returns early",
    drawCount(gNon) === packed.corners && drawCount(new THREE.BufferGeometry()) === null);
  check("attribute pull: a non-position attribute does NOT clamp — drawRange still needed",
    drawCount(gAttr) === packed.corners && gAttr.attributes.hbPullCorner.array instanceof Uint32Array
    && (() => { const g = new THREE.BufferGeometry(); g.setAttribute("hbPullCorner", new THREE.BufferAttribute(attr, 1)); return drawCount(g) === null; })());
  check("indexed pull: the index alone clamps (no drawRange set)", gIdx.drawRange.count === Infinity && drawCount(gIdx) === indexed.corners);
  check("manual bounding sphere (a copy, not the caller's object)", gNon.boundingSphere.equals(sphere) && gNon.boundingSphere !== sphere);

  // Bit budget of the packed u32.
  const b1 = VP.packBits(arena.vertices, VP.SPIKE_MAX_INSTANCES);
  check("packBits: the spike bucket fits a packed u32", b1.fits && b1.vbits === packed.vbits);
  check("packBits: 2^20 arena vertices x 4096 slots = 32 bits, fits", VP.packBits(2 ** 20, 4096).fits === true);
  check("packBits: 2^20 arena vertices x 4097 slots does not — pair (8 B) or a bucket-local arena",
    VP.packBits(2 ** 20, 4097).fits === false);
  let threw = false;
  try { VP.buildCornerStream(geoms, { ...arena, vertices: 2 ** 28 }, instanceGeom, order, "packed"); } catch (e) { threw = e instanceof RangeError; }
  check("buildCornerStream refuses a packed stream past the bit budget", threw);

  // The bytes the doc quotes (this scene) [D, computed here].
  let vertexInstances = 0;
  instances.forEach((it) => { vertexInstances += geoms[it.geom].attributes.position.count; });
  const bytes = {
    arenaVertices: arena.vertices, arenaPayloadBytes: arena.payloadBytes, arenaTextureBytes: arena.textureBytes,
    corners: packed.corners, packedBytes: packed.payloadBytes, pairBytes: pair.payloadBytes,
    indexedEntries: indexed.entries, indexedBytes: indexed.payloadBytes, indexBytesPerElement: indexed.bytesPerIndex,
    vertexInstances, cornersPerVertexInstance: +(packed.corners / vertexInstances).toFixed(3),
    vbits: packed.vbits, sbits: packed.sbits,
  };
  console.log("  bytes (spike scene):", JSON.stringify(bytes));
  check("bytes: packed 4 B/corner, pair 8 B/corner, arena 32 B/vertex",
    packed.payloadBytes === 4 * packed.corners && pair.payloadBytes === 8 * pair.corners && arena.payloadBytes === 32 * arena.vertices);
}

console.log(`\nvertex_pull_spike: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
