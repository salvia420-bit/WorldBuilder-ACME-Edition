// tests/terrain_batch_no_drawid.test.mjs
//
// `?terrainNoDrawId` (2026-10-22, DEFAULT OFF, exact-match on/1/true/yes) —
// scene3d/terrain_batch.js's batch program without gl_DrawID (improvement hunt
// B10 = findings-round1 `gl-driver-2`, handoff P1d). The LB's BatchedMesh
// instance id rides a per-vertex `aLbIid`, the vertex stage reads
// `getBatchingMatrix( aLbIid )`, and `#include <batching_pars_vertex>` is
// replaced by its matrix half lifted from THREE.ShaderChunk — so ANGLE's D3D11
// multi-draw loop finds no gl_DrawID uniform and skips the per-range
// setDrawIDUniform + vertex uniform-block re-upload (terrain_batch.js header).
//
//   N1  flag parsing (exact-match opt-in; absent / off / junk = off).
//   N2  _batchingMatrixGlsl: lifts exactly three's batchingTexture declaration
//       + getBatchingMatrix (stock AND batched_runs-patched chunk give the same
//       text), refuses drift.
//   N3  the derivation on the toy anchors and on the REAL assembled terrain
//       program: =on names gl_DrawID nowhere, even with every #include resolved
//       against the batched_runs-patched ShaderChunk (prod default); the
//       fragment stage is byte-identical; the vertex stage differs ONLY in the
//       declaration block and the matrix line; one vertex sampler fewer.
//   N4  the attribute writes, through the real BatchedMesh lifecycle: fresh
//       absorbs, evict + optimize() (ranges move), re-absorb (slot != instance
//       id), park/unpark, setGeometrySize growth (bm.geometry replaced), slot
//       steal, unpark re-absorb. After every step each live row's aLbIid range
//       == its instance id, whose batching matrix places that LB.
//   N5  fail-soft: an aLbIid write that cannot happen drops the row (geometry +
//       instance deleted, slot released) and the LB draws per-LB.
//   N6  flag off: no aLbIid attribute, today's program (2-arg derivation),
//       counters inert; flag on under ?terrainBatch=off does nothing.
//   N7  fallbacks: chunk drift / no ShaderChunk / a legacy stage that names
//       gl_DrawID, or reaches it through a three #include (stock or
//       batched_runs chunks), or carries an unresolvable #include -> the batch
//       keeps today's program, says why once. A benign #include does not.
//
// The GPU half (both programs compile and draw the same pixels) is
// harness/glsl_smoke/terrain_no_drawid_smoke.mjs (headless Chromium).
//
// Run: cd apps/holtburger-web/ && node tests/terrain_batch_no_drawid.test.mjs

import * as THREE from "three";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { register } from "node:module";
import { patchBatchingChunks } from "../scene3d/batched_runs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolvePath(HERE, "..");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const count = (hay, needle) => hay.split(needle).length - 1;

// ---------------------------------------------------------------------------
// Module factory: terrain_batch.js evaluated with its imports stripped (the
// test_terrain_batch.mjs pattern), a fake `window` carrying the URL flags, and
// the THREE of our choice (its ShaderChunk is where the matrix half comes from).
// ---------------------------------------------------------------------------
const BATCH_SRC = readFileSync(resolvePath(APP, "scene3d/terrain_batch.js"), "utf8");
const STRIPPED = BATCH_SRC.replace(/^\s*import\s+.*$/gm, "")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");

function loadBatch(search, three = THREE) {
  const win = { location: { search } };
  const M = new Function(
    "THREE", "window", "TERRAIN_FX_LIGHT_UNIFORMS",
    STRIPPED +
      "\n; return { tryAbsorbTerrainLbIntoBatch, evictTerrainBatchForLb, parkTerrainBatchForLb," +
      " unparkTerrainBatchForLb, tickTerrainBatchOptimize, terrainBatchEnabled, terrainNoDrawIdEnabled," +
      " _buildBatchedGlsl, _batchingMatrixGlsl, _resolveNoDrawId, LB_MATRIX_IID, LB_MATRIX_DRAWID, __state: () => _state };",
  )(three, win, undefined);
  return { M, win };
}

// Toy GLSL carrying every anchor (the test_terrain_batch.mjs set).
const VERT = [
  "in float vertexHue;",
  "in vec3 acLightNormal;",
  "void main() {",
  "  vec3 displacedPos = position;",
  "  vec2 worldXy = uLbOriginXy + position.xy;",
  "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;",
  "  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);",
  "}",
].join("\n");
const FRAG = [
  "uniform sampler2D uVertexTypes;",
  "uniform highp sampler2D uMergeData;",
  "int vertexTypeAt(int iu, int iv) {",
  "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);",
  "}",
  "float vertexRoadAt(int iu, int iv) {",
  "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;",
  "}",
  "void main() {",
  "  bool acGouraud = uAcGouraudEnabled > 0.5;",
  "  if (uTexMergeEnabled > 0.5) {",
  "    int colBase = iu * 6;",
  "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);",
  "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);",
  "  }",
  "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {",
  "  }",
  "}",
].join("\n");
const EXTRAS = { vertexGlsl: VERT, fragmentGlsl: FRAG, texMergeAlphaRound: true };
const OPTS = { texMergeEnabled: true, texMergeAlphaArray: true };

function vtTexture() {
  const data = new Uint8Array(9 * 9 * 4);
  for (let i = 0; i < 81; i += 1) { data[i * 4] = 3; data[i * 4 + 3] = 255; }
  return new THREE.DataTexture(data, 9, 9);
}
function lbMesh(lbX, lbY, subdiv = false, extras = EXTRAS) {
  const n = subdiv ? 33 * 33 : 9 * 9;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { pos[i * 3] = (i % 9) * 24; pos[i * 3 + 1] = Math.floor(i / 9) * 24; }
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("terrainCode", new THREE.BufferAttribute(new Float32Array(n), 1));
  if (subdiv) g.setAttribute("acLightNormal", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(Math.max(3, (n - 1) * 3)), 1));
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAcGouraudEnabled: { value: subdiv ? 1.0 : 0.0 }, uTime: { value: 0 } },
    vertexShader: extras.vertexGlsl,
    fragmentShader: extras.fragmentGlsl,
  });
  const m = new THREE.Mesh(g, mat);
  m.position.set(lbX * 192, lbY * 192, 0);
  m.userData = { lbX, lbY, vertexTypesTexture: vtTexture(), mergeDataTexture: null };
  return m;
}
const freshScene = () => ({ terrainGroup: new THREE.Group(), terrainMaterials: [], wireframeMode: false });
const keyOf = (lbX, lbY) => (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;

/** Every live row: aLbIid range == iid, aLbSlot range == slot, the instance's
 *  geometry is the row's, and the matrix at iid places this LB. Independent of
 *  the module's own verifyIids (which is checked against this). */
function auditRows(st, meshesByKey) {
  const r = { rows: 0, bad: [], slotNeIid: 0 };
  const iidAttr = st.bm.geometry.getAttribute("aLbIid");
  const slotAttr = st.bm.geometry.getAttribute("aLbSlot");
  const m = new THREE.Matrix4();
  for (const [key, e] of st.byLb) {
    r.rows += 1;
    if (e.slot !== e.iid) r.slotNeIid += 1;
    const range = st.bm.getGeometryRangeAt(e.gid, {});
    let ok = !!iidAttr && st.bm.getGeometryIdAt(e.iid) === e.gid && range.vertexCount > 0;
    for (let i = range.vertexStart; ok && i < range.vertexStart + range.vertexCount; i += 1) {
      if (iidAttr.array[i] !== e.iid || slotAttr.array[i] !== e.slot) ok = false;
    }
    const mesh = meshesByKey.get(key);
    st.bm.getMatrixAt(e.iid, m);
    if (ok && mesh) {
      ok = m.elements[12] === mesh.userData.lbX * 192 && m.elements[13] === mesh.userData.lbY * 192;
    }
    if (!ok) r.bad.push(key.toString(16));
  }
  return r;
}

// ===========================================================================
console.log("?terrainNoDrawId — terrain batch without gl_DrawID");
console.log("=================================================");

// ---------------------------------------------------------------------------
console.log("\n-- N1. flag parsing --");
for (const [search, want] of [
  ["", false], ["?terrainNoDrawId=on", true], ["?terrainNoDrawId=1", true], ["?terrainNoDrawId=true", true],
  ["?terrainNoDrawId=yes", true], ["?terrainNoDrawId=ON", true], ["?terrainNoDrawId=off", false],
  ["?terrainNoDrawId=0", false], ["?terrainNoDrawId=onn", false], ["?terrainNoDrawId=", false],
  ["?terrainNoDrawId", false], ["?terrainBatch=off&terrainNoDrawId=on", true],
]) {
  check(`terrainNoDrawIdEnabled() for ${JSON.stringify(search)} === ${want}`, loadBatch(search).M.terrainNoDrawIdEnabled() === want);
}
check("the reader is the exact-match opt-in idiom",
  BATCH_SRC.includes('on = v === "on" || v === "1" || v === "true" || v === "yes";'));

// ---------------------------------------------------------------------------
console.log("\n-- N2. the matrix half of batching_pars_vertex --");
const { M: M0 } = loadBatch("");
const STOCK = THREE.ShaderChunk.batching_pars_vertex;
const PATCHED = patchBatchingChunks(THREE.ShaderChunk);
const liftStock = M0._batchingMatrixGlsl(STOCK);
const liftPatched = PATCHED ? M0._batchingMatrixGlsl(PATCHED.pars) : null;
check("stock r184 chunk lifts", typeof liftStock === "string", String(liftStock));
check("the batched_runs-patched chunk (prod default) is patched, and lifts to the SAME text",
  !!PATCHED && PATCHED.pars.includes("hbBatchSlot") && liftPatched === liftStock);
if (liftStock) {
  const [decl, ...rest] = liftStock.split("\n");
  const fn = rest.join("\n");
  check("line 1 is the batchingTexture declaration", decl === "uniform highp sampler2D batchingTexture;");
  check("the rest is three's own getBatchingMatrix, verbatim", fn.startsWith("mat4 getBatchingMatrix( const in float i ) {")
    && fn.endsWith("\n\t}") && STOCK.includes(fn) && fn.includes("return mat4( v1, v2, v3, v4 );"));
  check("nothing else comes along (no gl_DrawID, batchingIdTexture, getIndirectIndex, hbBatchSlot, _gl_DrawID)",
    !/gl_DrawID|batchingIdTexture|getIndirectIndex|hbBatchSlot/.test(liftStock));
  check("balanced braces", count(liftStock, "{") === count(liftStock, "}") && count(liftStock, "{") === 1);
}
check("drift: renamed function -> null", M0._batchingMatrixGlsl(STOCK.replace("getBatchingMatrix", "getBatchMat")) === null);
check("drift: no batchingTexture declaration -> null",
  M0._batchingMatrixGlsl(STOCK.replace("uniform highp sampler2D batchingTexture;", "uniform sampler2D batchingTexture;")) === null);
check("drift: declared twice -> null", M0._batchingMatrixGlsl(STOCK + "\n" + STOCK) === null);
check("drift: a getBatchingMatrix that reads gl_DrawID -> null",
  M0._batchingMatrixGlsl(STOCK.replace("int j = int( i ) * 4;", "int j = ( int( i ) + gl_DrawID ) * 4;")) === null);
check("not a string -> null", M0._batchingMatrixGlsl(undefined) === null && M0._batchingMatrixGlsl(null) === null);

// ---------------------------------------------------------------------------
console.log("\n-- N3a. derivation on the toy anchors --");
const INC = /^[ \t]*#include +<([\w\d./]+)>/gm;
function resolveIncludes(src, chunks, depth = 0) {
  if (depth > 8) throw new Error("include depth");
  return src.replace(INC, (_, name) => {
    const c = chunks[name];
    if (typeof c !== "string") throw new Error(`missing chunk ${name}`);
    return resolveIncludes(c, chunks, depth + 1);
  });
}
const PROD_CHUNKS = { ...THREE.ShaderChunk, batching_pars_vertex: PATCHED.pars, batching_vertex: PATCHED.vert, color_vertex: PATCHED.color };

function derivationChecks(tag, V, F) {
  const off = M0._buildBatchedGlsl(V, F);
  const on = M0._buildBatchedGlsl(V, F, { batchingGlsl: liftStock });
  check(`${tag}: both derivations succeed`, !!off && !!on);
  if (!off || !on) return;
  check(`${tag}: =off is the 2-arg derivation (null / {} options change nothing)`,
    JSON.stringify(off) === JSON.stringify(M0._buildBatchedGlsl(V, F, null))
    && JSON.stringify(off) === JSON.stringify(M0._buildBatchedGlsl(V, F, {})));
  check(`${tag}: =off keeps the include and the gl_DrawID matrix line`,
    count(off.vertexShader, "#include <batching_pars_vertex>") === 1 && count(off.vertexShader, M0.LB_MATRIX_DRAWID) === 1);
  const v = on.vertexShader;
  check(`${tag}: =on vertex names gl_DrawID nowhere`, !v.includes("gl_DrawID"));
  check(`${tag}: =on has no batching include, getIndirectIndex or batchingIdTexture`,
    !v.includes("#include <batching_pars_vertex>") && !v.includes("getIndirectIndex") && !v.includes("batchingIdTexture"));
  check(`${tag}: =on declares aLbIid once, after aLbSlot, and reads the matrix through it once`,
    count(v, "in float aLbIid;") === 1 && v.indexOf("in float aLbSlot;") < v.indexOf("in float aLbIid;")
    && count(v, M0.LB_MATRIX_IID) === 1 && count(v, "getBatchingMatrix(") === 2);
  check(`${tag}: =on carries the lifted matrix half once, before main()`,
    count(v, liftStock) === 1 && v.indexOf(liftStock) < v.indexOf("void main()"));
  check(`${tag}: fragment stage byte-identical`, on.fragmentShader === off.fragmentShader);
  // The vertex stages differ ONLY in the declaration block and the matrix line.
  const head = "flat out float vLbSlot;\n";
  const i0 = v.indexOf(head) + head.length;
  const i1 = v.indexOf(liftStock) + liftStock.length;
  const block = v.slice(i0, i1);
  const rebuilt = (v.slice(0, i0) + "#include <batching_pars_vertex>" + v.slice(i1)).replace(M0.LB_MATRIX_IID, M0.LB_MATRIX_DRAWID);
  check(`${tag}: vertex =on -> =off by swapping back the block and the matrix line (nothing else differs)`,
    i0 > head.length && i1 > i0 && rebuilt === off.vertexShader);
  check(`${tag}: the swapped block is comments + aLbIid + the lifted GLSL only`,
    block.replace(liftStock, "").split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).join("|") === "in float aLbIid;");
  // Every #include resolved against the batched_runs-patched chunks (prod).
  let onR = null, offR = null;
  try { onR = resolveIncludes(v, PROD_CHUNKS); offR = resolveIncludes(off.vertexShader, PROD_CHUNKS); } catch (e) { check(`${tag}: includes resolve`, false, String(e)); }
  if (onR && offR) {
    check(`${tag}: resolved =off names gl_DrawID (probe sanity: main + hbBatchSlot)`, count(offR, "gl_DrawID") >= 3);
    check(`${tag}: resolved =on names gl_DrawID NOWHERE`, !onR.includes("gl_DrawID"));
    check(`${tag}: resolved vertex samplers: =on keeps batchingTexture only, =off also batchingIdTexture`,
      count(onR, "uniform highp sampler2D batchingTexture;") === 1 && !onR.includes("batchingIdTexture")
      && offR.includes("uniform highp usampler2D batchingIdTexture;"));
  }
  return on;
}
derivationChecks("toy", VERT, FRAG);

// ---------------------------------------------------------------------------
console.log("\n-- N4. attribute writes through the BatchedMesh lifecycle (flag on) --");
{
  const { M, win } = loadBatch("?terrainNoDrawId=on");
  const scene = freshScene();
  const meshes = new Map();
  const absorb = (lbX, lbY, subdiv = false) => {
    const m = lbMesh(lbX, lbY, subdiv);
    const ok = M.tryAbsorbTerrainLbIntoBatch(scene, m, OPTS, EXTRAS);
    if (ok) meshes.set(keyOf(lbX, lbY), m);
    return { ok, m };
  };
  const step = (label) => {
    const st = M.__state();
    const a = auditRows(st, meshes);
    const v = win.__terrainBatch.verifyIids();
    check(`${label}: every live row's aLbIid == its instance id, aLbSlot == its slot, matrix places its LB`,
      a.bad.length === 0 && a.rows === st.byLb.size, `bad=${a.bad.slice(0, 6).join(",")} rows=${a.rows}`);
    check(`${label}: module verifyIids agrees (checked ${v.checked}, bad ${v.bad}, slot!=iid ${v.slotNeIid})`,
      v.enabled === true && v.bad === 0 && v.checked === st.byLb.size && v.slotNeIid === a.slotNeIid);
    return a;
  };

  // a. fresh ring
  let all = true;
  for (let i = 0; i < 16; i += 1) all = absorb(100 + (i % 4), 50 + Math.floor(i / 4)).ok && all;
  const st = M.__state();
  check("16 LBs absorbed", all && st.byLb.size === 16);
  check("state: noDrawId live, no fallback", st.noDrawId === true && st.noDrawIdFallback === null);
  check("material: no gl_DrawID, reads getBatchingMatrix( aLbIid )",
    !st.material.vertexShader.includes("gl_DrawID") && st.material.vertexShader.includes(M.LB_MATRIX_IID));
  const a0 = st.bm.geometry.getAttribute("aLbIid");
  check("batch geometry carries aLbIid (Float32, itemSize 1, not normalized)",
    !!a0 && a0.array instanceof Float32Array && a0.itemSize === 1 && a0.normalized === false);
  check("canonical attribute list unchanged (aLbIid rides beside aLbSlot, not in attrNames)",
    !st.attrNames.includes("aLbIid") && !st.attrNames.includes("aLbSlot"));
  check("an absorbed proxy is hidden + tagged (unchanged contract)",
    [...meshes.values()].every((m) => m.visible === false && m.userData.__terrainBatchGid != null));
  step("fresh");

  // c. evict 7, compact
  const evicted = [];
  for (const [lbX, lbY] of [[100, 50], [102, 50], [101, 51], [103, 51], [100, 52], [102, 53], [101, 53]]) {
    M.evictTerrainBatchForLb(keyOf(lbX, lbY));
    meshes.delete(keyOf(lbX, lbY));
    evicted.push([lbX, lbY]);
  }
  const starts0 = new Map([...st.byLb].map(([k, e]) => [k, st.bm.getGeometryRangeAt(e.gid, {}).vertexStart]));
  M.tickTerrainBatchOptimize();
  const moved = [...st.byLb].filter(([k, e]) => st.bm.getGeometryRangeAt(e.gid, {}).vertexStart !== starts0.get(k)).length;
  check("optimize() ran (43.75% dead > 30%) and moved live ranges", st.optimizes === 1 && moved > 0, `optimizes=${st.optimizes} moved=${moved}`);
  step("after evict + optimize");

  // d. re-absorb: slots pop LIFO, instance ids reuse ascending -> they diverge
  for (const [lbX, lbY] of evicted) absorb(lbX, lbY);
  const ad = step("after re-absorb");
  check("re-absorb split slot from instance id (the case a slot-for-id shortcut gets wrong)", ad.slotNeIid >= 4, `slotNeIid=${ad.slotNeIid}`);

  // e. park / unpark
  M.parkTerrainBatchForLb(keyOf(101, 50));
  M.parkTerrainBatchForLb(keyOf(103, 53));
  M.unparkTerrainBatchForLb(keyOf(101, 50), [meshes.get(keyOf(101, 50))]);
  const e53 = st.byLb.get(keyOf(103, 53));
  check("park hides the row, unpark shows it (rows kept, ids kept)",
    st.bm.getVisibleAt(e53.iid) === false && st.bm.getVisibleAt(st.byLb.get(keyOf(101, 50)).iid) === true && st.byLb.size === 16);
  step("after park/unpark");

  // f. growth: setGeometrySize replaces bm.geometry; aLbIid must be copied over
  const geom0 = st.bm.geometry, maxV0 = st.maxVerts;
  let grown = false;
  for (let i = 0; i < 90 && !grown; i += 1) {
    absorb(10 + (i % 30), 120 + Math.floor(i / 30), true);
    grown = st.maxVerts > maxV0;
  }
  check("vertex buffer grew (setGeometrySize) and bm.geometry was replaced", grown && st.bm.geometry !== geom0, `maxVerts ${maxV0} -> ${st.maxVerts}`);
  // a couple more after the growth: the write must hit the NEW geometry
  absorb(60, 130, true); absorb(61, 130, false);
  step("after growth");

  // g. fill to the 256-slot cap, park the oldest, steal it
  let lbx = 0;
  while (st.byLb.size < 256 && lbx < 400) { absorb(lbx % 200, 200 + Math.floor(lbx / 200)); lbx += 1; }
  check("ring at the 256-slot cap", st.byLb.size === 256);
  const victimKey = keyOf(102, 52);
  const victimMesh = meshes.get(victimKey);
  const victimIid = st.byLb.get(victimKey).iid;
  M.parkTerrainBatchForLb(victimKey);
  M.unparkTerrainBatchForLb(keyOf(103, 53), [meshes.get(keyOf(103, 53))]); // only one parked row: the victim
  const steal = absorb(220, 220);
  check("a fresh LB at the cap steals the parked row", steal.ok && st.slotSteals === 1 && !st.byLb.has(victimKey));
  check("the stealer reuses the freed instance id (and its aLbIid says so)",
    st.byLb.get(keyOf(220, 220)).iid === victimIid);
  meshes.delete(victimKey);
  step("after slot steal");

  // h. unpark of the stolen LB re-absorbs it (a slot freed first)
  M.evictTerrainBatchForLb(keyOf(0, 200)); meshes.delete(keyOf(0, 200));
  M.unparkTerrainBatchForLb(victimKey, [victimMesh]);
  check("unpark re-absorbed the stolen LB", st.unparkReabsorbs === 1 && st.byLb.has(victimKey));
  meshes.set(victimKey, victimMesh);
  step("after unpark re-absorb");

  // Negative control: both audits must SEE a wrong id (one vertex of one row).
  {
    const e = st.byLb.get(keyOf(101, 52));
    const attr = st.bm.geometry.getAttribute("aLbIid");
    const at = st.bm.getGeometryRangeAt(e.gid, {}).vertexStart + 5;
    const keep = attr.array[at];
    attr.array[at] = (e.iid + 1) % 256;
    const a = auditRows(st, meshes);
    const v = win.__terrainBatch.verifyIids();
    check("negative control: a corrupted vertex id is caught by both audits", a.bad.length === 1 && v.bad === 1,
      `audit=${a.bad.length} verifyIids=${v.bad}`);
    attr.array[at] = keep;
    check("negative control restored", win.__terrainBatch.verifyIids().bad === 0);
  }

  const s = win.__terrainBatch.stats();
  check("stats(): noDrawId / requested / no fallback",
    s.noDrawId === true && s.noDrawIdRequested === true && s.noDrawIdFallback === null);
  check("stats(): one aLbIid write per successful absorb + re-absorb, no failures",
    s.iidWrites === st.absorbs + st.reabsorbs && s.iidWriteFails === 0 && s.passthrough === 0,
    `iidWrites=${s.iidWrites} absorbs=${st.absorbs} reabsorbs=${st.reabsorbs} fails=${s.iidWriteFails} passthrough=${s.passthrough}`);
}

// ---------------------------------------------------------------------------
console.log("\n-- N5. fail-soft: the aLbIid write cannot happen --");
{
  const { M } = loadBatch("?terrainNoDrawId=on");
  const scene = freshScene();
  const warns = [];
  const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  try {
    M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(1, 1), OPTS, EXTRAS);
    M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(2, 1), OPTS, EXTRAS);
    const st = M.__state();
    const active = () => st.bm._instanceInfo.filter((i) => i.active).length;
    const geoms = () => st.bm._geometryInfo.filter((g) => g.active).length;
    st.bm.getGeometryRangeAt = () => { throw new Error("range lookup refused (test)"); };
    const m3 = lbMesh(3, 1);
    const ok = M.tryAbsorbTerrainLbIntoBatch(scene, m3, OPTS, EXTRAS);
    check("absorb refused", ok === false);
    check("counted: iidWriteFails 1, passthrough 1, no row", st.iidWriteFails === 1 && st.passthroughCount === 1 && st.byLb.size === 2);
    check("the half-made row is gone (instance AND geometry deleted)", active() === 2 && geoms() === 2);
    check("its slot went back to the free list", st.freeSlots.length === 1);
    check("the proxy stays a visible per-LB draw (untagged)", m3.visible === true && m3.userData.__terrainBatchGid == null);
    check("one warning, naming the cause", warns.some((w) => w.includes("aLbIid write failed")));
    delete st.bm.getGeometryRangeAt;
    check("the next absorb works again", M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(3, 1), OPTS, EXTRAS) === true);
    const meshes = new Map(); // matrix check not needed here
    const a = auditRows(st, meshes);
    check("rows consistent after the failure", a.bad.length === 0 && a.rows === 3);
  } finally { console.warn = ow; }
}

// ---------------------------------------------------------------------------
console.log("\n-- N6. flag off: today's batch, untouched --");
{
  const { M, win } = loadBatch("");
  const scene = freshScene();
  const ok = [lbMesh(5, 5, true), lbMesh(6, 5), lbMesh(7, 5)].map((m) => M.tryAbsorbTerrainLbIntoBatch(scene, m, OPTS, EXTRAS));
  const st = M.__state();
  check("absorbs as before", ok.every(Boolean) && st.byLb.size === 3);
  check("no aLbIid attribute, noDrawId false", !st.bm.geometry.getAttribute("aLbIid") && st.noDrawId === false);
  check("the program is the 2-arg derivation (include + gl_DrawID matrix line)",
    st.material.vertexShader === M._buildBatchedGlsl(VERT, FRAG).vertexShader
    && st.material.vertexShader.includes(M.LB_MATRIX_DRAWID));
  const s = win.__terrainBatch.stats();
  check("stats(): inert counters", s.noDrawId === false && s.noDrawIdRequested === false && s.noDrawIdFallback === null
    && s.iidWrites === 0 && s.iidWriteFails === 0);
  check("verifyIids() reports disabled", win.__terrainBatch.verifyIids().enabled === false);

  const { M: Moff } = loadBatch("?terrainBatch=off&terrainNoDrawId=on");
  check("?terrainBatch=off&terrainNoDrawId=on: nothing absorbs, no state",
    Moff.tryAbsorbTerrainLbIntoBatch(freshScene(), lbMesh(5, 5), OPTS, EXTRAS) === false && Moff.__state() === null);
}

// ---------------------------------------------------------------------------
console.log("\n-- N7. fallbacks keep today's program --");
for (const [label, three, extras, needle] of [
  ["batching chunk drift", { ...THREE, ShaderChunk: { ...THREE.ShaderChunk, batching_pars_vertex: STOCK.replace("getBatchingMatrix", "getBatchMat") } }, EXTRAS, "did not match"],
  ["no ShaderChunk", { ...THREE, ShaderChunk: undefined }, EXTRAS, "did not match"],
  ["a legacy vertex stage that names gl_DrawID", THREE,
    { ...EXTRAS, vertexGlsl: VERT.replace("  vec3 displacedPos = position;", "  vec3 displacedPos = position + vec3(float(gl_DrawID) * 0.0);") },
    "still names gl_DrawID"],
  // 2026-10-23 review b10-terrain-1: the draw index behind a three #include. The
  // =on stage declares no getIndirectIndex / hbBatchSlot, so taking that program
  // would be a compile failure with every absorbed LB already hidden.
  ["a legacy vertex stage that reaches it through #include <batching_vertex> (stock chunks)", THREE,
    { ...EXTRAS, vertexGlsl: VERT.replace("  vec3 displacedPos = position;", "  vec3 displacedPos = position;\n#include <batching_vertex>") },
    "still names getIndirectIndex"],
  ["the same through the batched_runs-patched chunks (prod default: hbBatchSlot)", { ...THREE, ShaderChunk: PROD_CHUNKS },
    { ...EXTRAS, vertexGlsl: VERT.replace("  vec3 displacedPos = position;", "  vec3 displacedPos = position;\n#include <batching_vertex>") },
    "still names getIndirectIndex"],
  ["a #include that does not resolve (cannot be vouched for)", THREE,
    { ...EXTRAS, vertexGlsl: VERT.replace("  vec3 displacedPos = position;", "  vec3 displacedPos = position;\n#include <hb_no_such_chunk>") },
    "did not resolve"],
]) {
  const { M, win } = loadBatch("?terrainNoDrawId=on", three);
  const warns = [];
  const ow = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  let ok1, ok2;
  try {
    const scene = freshScene();
    ok1 = M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(8, 8, false, extras), OPTS, extras);
    ok2 = M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(9, 8, false, extras), OPTS, extras);
  } finally { console.warn = ow; }
  const st = M.__state();
  check(`${label}: the batch still batches`, ok1 === true && ok2 === true && st && st.byLb.size === 2);
  check(`${label}: today's program, no aLbIid`, st && st.noDrawId === false && st.material.vertexShader.includes(M.LB_MATRIX_DRAWID)
    && !st.bm.geometry.getAttribute("aLbIid"));
  check(`${label}: says why once (stats + one console.warn)`,
    st && typeof st.noDrawIdFallback === "string" && st.noDrawIdFallback.includes(needle)
    && win.__terrainBatch.stats().noDrawIdRequested === true
    && warns.filter((w) => w.includes("?terrainNoDrawId")).length === 1, warns.join(" | "));
}
// The include scan must not over-reject: a chunk that never reaches the draw
// index leaves the =on program in place.
{
  const { M } = loadBatch("?terrainNoDrawId=on", { ...THREE, ShaderChunk: PROD_CHUNKS });
  const v = VERT.replace("void main() {", "#include <common>\nvoid main() {");
  const r = M._resolveNoDrawId({ vertexGlsl: v, fragmentGlsl: FRAG });
  check("a benign #include (<common>) keeps the =on program, no fallback",
    !!r.glsl && r.fallback === null && r.glsl.vertexShader.includes(M.LB_MATRIX_IID), String(r.fallback));
}

// ---------------------------------------------------------------------------
console.log("\n-- N3b. derivation on the REAL assembled terrain program --");
{
  const STUB_LOADER = resolvePath(APP, "_three_stub_palette_loader.mjs");
  if (!existsSync(STUB_LOADER)) {
    check("stub loader present (run test_terrain_palette.mjs once)", false, STUB_LOADER);
  } else {
    register(pathToFileURL(STUB_LOADER).href, pathToFileURL(APP + "/").href);
    const T = await import(pathToFileURL(resolvePath(APP, "scene3d/terrain.js")).href);
    const { vertex: RV, fragment: RF } = T._terrainGlslForTest();
    const on = derivationChecks("real", RV, RF);
    if (on) {
      // The water bank's vertex fetch (default on) reads aLbSlot — still declared first.
      const bankFetch = "  return texelFetch(uVertexTypes, ivec3(27 + x, y, int(aLbSlot + 0.5)), 0).r;";
      check("real: the water-bank vertex fetch (if present) still follows the aLbSlot declaration",
        !on.vertexShader.includes(bankFetch) || on.vertexShader.indexOf("in float aLbSlot;") < on.vertexShader.indexOf(bankFetch));
    }
    // The runtime guard (#includes expanded against the prod chunks) passes the
    // real program: no false fallback on today's terrain source.
    const { M: Mr } = loadBatch("?terrainNoDrawId=on", { ...THREE, ShaderChunk: PROD_CHUNKS });
    const r = Mr._resolveNoDrawId({ vertexGlsl: RV, fragmentGlsl: RF });
    check("real: _resolveNoDrawId picks the =on program, no fallback",
      !!r.glsl && r.fallback === null && !!on && r.glsl.vertexShader === on.vertexShader, String(r.fallback));
  }
}

console.log("\n=================================================");
console.log(`terrain batch no-drawid: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
