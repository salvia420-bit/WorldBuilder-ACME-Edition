// ?terrainBatch (DEFAULT-ON) — headless test for scene3d/terrain_batch.js.
//
// TWO JOBS.
//
// 1. ANCHOR-DRIFT LOCK. The batched material's GLSL is derived from terrain.js's
//    legacy shader strings by anchored string replacement. Every anchor must
//    match EXACTLY ONCE or the module disables itself with one console.warn and
//    the whole ring silently falls back to per-LB draws. A shader edit that
//    reflows one of these lines is invisible in review, so the anchors are
//    pinned against the real terrain.js source here.
//
// 2. THE MIXED-SUBDIV RING (2026-08-03 fix). `acLightNormal` is supplied ONLY by
//    adapter.js `subdividedLandblockMeshToGeometry` (:386), never by
//    `landblockMeshToGeometry` (:288-352), and the LOD ring holds both kinds at
//    quality=high. The canonical attribute set used to be keyed off whichever
//    landblock streamed FIRST, so the session outcome was order-dependent:
//    base-first latched `uAcGouraudEnabled` to 0 batch-wide (every subdivided
//    LB silently lost the retail calc_lighting term), subdiv-first rejected
//    every base LB as an attribute-set mismatch (~194 of 203 LBs fell out of
//    the batch behind ONE `_warnOnce`). These tests drive both orders and
//    assert the outcome is identical and per-LB.
//
// Run: cd apps/holtburger-web/ && node test_terrain_batch.mjs
// (needs `three` resolvable or THREE_PATH=/path/to/three.module.js)

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
// NOT a silent exit(0): a suite that cannot run must not report success
// (see the round-6 CORRECTION in docs/2026-08-03-random-review-fixes.md).
if (!tp) {
  console.log("terrain-batch test: FAIL — three not located (set THREE_PATH).");
  process.exit(1);
}
const THREE = await import("file://" + tp);

console.log("?terrainBatch — cross-LB terrain BatchedMesh test");
console.log("=========================");

// ---------------------------------------------------------------------------
// 1. Anchor-drift lock against the REAL terrain.js shader source.
// ---------------------------------------------------------------------------
console.log("\n-- GLSL anchors present exactly once in scene3d/terrain.js --");

const terrainSrc = readFileSync(resolvePath(__dirname, "scene3d/terrain.js"), "utf8");
const ANCHORS = [
  ["vertex decls", "in float vertexHue;"],
  ["vertex worldXy", "  vec2 worldXy = uLbOriginXy + position.xy;"],
  ["vertex placement",
    "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;\n  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);"],
  ["frag uVertexTypes decl", "uniform sampler2D uVertexTypes;"],
  ["frag vertexTypeAt", "  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"],
  ["frag vertexRoadAt", "  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;"],
  ["frag uMergeData decl", "uniform highp sampler2D uMergeData;"],
  ["frag merge base fetch", "vec4 baseTexel = texelFetch(uMergeData, ivec2(colBase, iv), 0);"],
  ["frag merge slot fetch", "vec4 t = texelFetch(uMergeData, ivec2(colBase + s, iv), 0);"],
  ["frag merge gate", "  if (uTexMergeEnabled > 0.5) {\n    int colBase = iu * 6;"],
  ["frag road gate",
    "  if (uRoadEnabled > 0.5 && !(uTexMergeEnabled > 0.5 && uRoadSlotsEnabled > 0.5)) {"],
  ["frag gouraud gate", "  bool acGouraud = uAcGouraudEnabled > 0.5;"],
];
for (const [label, anchor] of ANCHORS) {
  const n = terrainSrc.split(anchor).length - 1;
  check(`anchor "${label}" occurs exactly once`, n === 1, `found ${n}`);
}

// The A channel the per-LB Gouraud gate rides must stay unread by terrain.js
// and constant-255 in BOTH legacy writers, or the gate would fight a real
// consumer.
{
  const fetches = terrainSrc.match(/texelFetch\(uVertexTypes[^)]*\)\s*\.\s*([rgba])/g) || [];
  const readsAlpha = fetches.some((s) => /\.\s*a$/.test(s));
  check("terrain.js never reads uVertexTypes.a (the Gouraud gate channel is free)",
    !readsAlpha, `${fetches.length} uVertexTypes fetches`);
  check("terrain.js pooled vertex-types writer stores A=255",
    terrainSrc.includes("bytes[dst + 3] = 255;"));
  const adapterSrc = readFileSync(resolvePath(__dirname, "scene3d/adapter.js"), "utf8");
  check("adapter.js buildVertexTypesDataTexture stores A=255",
    adapterSrc.includes("bytes[dst + 3] = 255;"));
  // The premise of the whole fix: acLightNormal is subdiv-only.
  const subdivIdx = adapterSrc.indexOf("export function subdividedLandblockMeshToGeometry");
  const baseIdx = adapterSrc.indexOf("export function landblockMeshToGeometry");
  const baseBody = adapterSrc.slice(baseIdx, subdivIdx);
  check("adapter.js landblockMeshToGeometry does NOT set acLightNormal",
    baseIdx >= 0 && subdivIdx > baseIdx && !baseBody.includes("acLightNormal"));
  check("adapter.js subdividedLandblockMeshToGeometry DOES set acLightNormal",
    adapterSrc.slice(subdivIdx).includes('"acLightNormal"'));
}

// ---------------------------------------------------------------------------
// Module load (three import stripped; prewarmSubtree is undefined and its call
// site is already try-wrapped).
// ---------------------------------------------------------------------------
let src = readFileSync(resolvePath(__dirname, "scene3d/terrain_batch.js"), "utf8");
src = src.replace(/^\s*import\s+.*$/gm, "");
const stripped = src
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ");
const factory = new Function(
  "THREE", "window",
  stripped +
    "\n; return { tryAbsorbTerrainLbIntoBatch, evictTerrainBatchForLb, parkTerrainBatchForLb," +
    " unparkTerrainBatchForLb, tickTerrainBatchOptimize, terrainBatchEnabled," +
    " __state: () => _state, __reset: () => { _state = null; _disabled = false; _warned.clear(); } };"
);

// Minimal GLSL carrying every anchor, so the derivation runs for real.
const VERT_GLSL = [
  "in float vertexHue;",
  "in vec3 acLightNormal;",
  "void main() {",
  "  vec3 displacedPos = position;",
  "  vec2 worldXy = uLbOriginXy + position.xy;",
  "  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;",
  "  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);",
  "}",
].join("\n");
const FRAG_GLSL = [
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

const EXTRAS = { vertexGlsl: VERT_GLSL, fragmentGlsl: FRAG_GLSL, texMergeAlphaRound: true };
const OPTS = { texMergeEnabled: true, texMergeAlphaArray: true };

function vtTexture() {
  const data = new Uint8Array(9 * 9 * 4);
  for (let i = 0; i < 9 * 9; i += 1) {
    data[i * 4 + 0] = 3; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, 9, 9);
  return t;
}

/** @param {boolean} subdiv carries acLightNormal (subdivided path) */
function lbMesh(lbX, lbY, subdiv, gouraudFlagOn = true) {
  const n = subdiv ? 33 * 33 : 9 * 9;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("terrainCode", new THREE.BufferAttribute(new Float32Array(n), 1));
  if (subdiv) {
    const al = new Float32Array(n * 3);
    al.fill(0.5);
    g.setAttribute("acLightNormal", new THREE.BufferAttribute(al, 3));
  }
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(Math.max(3, (n - 1) * 3)), 1));
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      // terrain.js seeds this as TERRAIN_GOURAUD_ON && geom.getAttribute(...)
      uAcGouraudEnabled: { value: (gouraudFlagOn && subdiv) ? 1.0 : 0.0 },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uTime: { value: 0 },
    },
    vertexShader: VERT_GLSL,
    fragmentShader: FRAG_GLSL,
  });
  const m = new THREE.Mesh(g, mat);
  m.position.set(lbX * 192, lbY * 192, 0);
  m.userData = { lbX, lbY, vertexTypesTexture: vtTexture(), mergeDataTexture: null };
  return m;
}

function freshScene() {
  return { terrainGroup: new THREE.Group(), terrainMaterials: [], wireframeMode: false };
}

// A-channel of a slot's layer (the per-LB Gouraud bit).
function slotAlpha(state, slot) {
  return state.vtArray.image.data[slot * 9 * 9 * 4 + 3];
}

// ---------------------------------------------------------------------------
// 2. Mixed-subdiv ring, BOTH stream orders.
// ---------------------------------------------------------------------------
for (const order of ["subdiv-first", "base-first"]) {
  console.log(`\n-- mixed-subdiv ring, ${order} --`);
  const M = factory(THREE, undefined);
  const scene = freshScene();
  const meshes = order === "subdiv-first"
    ? [lbMesh(10, 10, true), lbMesh(11, 10, false), lbMesh(12, 10, false)]
    : [lbMesh(11, 10, false), lbMesh(12, 10, false), lbMesh(10, 10, true)];

  const results = meshes.map((m) => M.tryAbsorbTerrainLbIntoBatch(scene, m, OPTS, EXTRAS));
  const st = M.__state();

  check("every landblock absorbed (no attribute-set passthrough)",
    results.every(Boolean) && st && st.byLb.size === 3,
    `absorbed=${results.filter(Boolean).length}/3 rows=${st ? st.byLb.size : 0}`);
  check("passthroughCount is 0", st && st.passthroughCount === 0,
    `passthrough=${st ? st.passthroughCount : "?"}`);
  check("attrMismatches is 0", st && st.attrMismatches === 0);
  check("uAcGouraudEnabled promoted to 1 (a subdivided LB proved the flag is on)",
    st && st.material.uniforms.uAcGouraudEnabled.value === 1.0,
    `value=${st ? st.material.uniforms.uAcGouraudEnabled.value : "?"}`);
  check("exactly one LB counted as Gouraud-capable", st && st.gouraudLbs === 1,
    `gouraudLbs=${st ? st.gouraudLbs : "?"}`);
  check("canonical attribute set carries acLightNormal",
    st && st.attrNames.includes("acLightNormal"), st ? st.attrNames.join(",") : "");

  // Per-LB gate: the subdivided LB's slot must be 255, both base LBs 0.
  // `slotOf` returns -1 for an LB that never made it into the batch, so a
  // regression reports a FAIL on every remaining assertion instead of throwing
  // and skipping the rest of the suite (notably the opposite stream order).
  const slotOf = (lbX, lbY) => {
    const e = st && st.byLb.get((((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0);
    return e ? e.slot : -1;
  };
  const subdivSlot = slotOf(10, 10);
  check("subdivided LB's A-channel gate is ON (255)",
    subdivSlot >= 0 && slotAlpha(st, subdivSlot) === 255,
    subdivSlot < 0 ? "LB not in batch" : `alpha=${slotAlpha(st, subdivSlot)}`);
  for (const lbX of [11, 12]) {
    const s = slotOf(lbX, 10);
    check(`base LB ${lbX} A-channel gate is OFF (0)`, s >= 0 && slotAlpha(st, s) === 0,
      s < 0 ? "LB not in batch (fell out as an attribute-set mismatch)" : `alpha=${slotAlpha(st, s)}`);
  }
  // The zeroed stand-in must not corrupt the real data next to it.
  check("vertex-types R channel survives the A-channel write",
    subdivSlot >= 0 && st.vtArray.image.data[subdivSlot * 9 * 9 * 4 + 0] === 3);
}

// ---------------------------------------------------------------------------
// 3. ?terrainGouraud=off — the uniform must stay 0 and no LB may gate on.
// ---------------------------------------------------------------------------
console.log("\n-- ?terrainGouraud=off (no LB ever presents a live source uniform) --");
{
  const M = factory(THREE, undefined);
  const scene = freshScene();
  const ok = [
    M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(10, 10, true, false), OPTS, EXTRAS),
    M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(11, 10, false, false), OPTS, EXTRAS),
  ];
  const st = M.__state();
  check("both landblocks still absorbed", ok.every(Boolean) && st.byLb.size === 2);
  check("uAcGouraudEnabled stays 0 (promote-on-evidence never fired)",
    st.material.uniforms.uAcGouraudEnabled.value === 0.0);
  check("gouraudLbs is 0", st.gouraudLbs === 0);
  for (const { slot } of st.byLb.values()) {
    check(`slot ${slot} A-channel gate is OFF`, slotAlpha(st, slot) === 0);
  }
}

// ---------------------------------------------------------------------------
// 4. quality=low shape — every LB is a base mesh; batch must still consolidate.
// ---------------------------------------------------------------------------
console.log("\n-- quality=low (all base meshes) --");
{
  const M = factory(THREE, undefined);
  const scene = freshScene();
  const n = 5;
  let all = true;
  for (let i = 0; i < n; i += 1) {
    all = M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(20 + i, 7, false), OPTS, EXTRAS) && all;
  }
  const st = M.__state();
  check("all base landblocks absorbed", all && st.byLb.size === n, `rows=${st.byLb.size}`);
  check("uAcGouraudEnabled 0 (matches the legacy per-LB seed)",
    st.material.uniforms.uAcGouraudEnabled.value === 0.0);
  check("no passthrough", st.passthroughCount === 0);
}

// ---------------------------------------------------------------------------
// 5. Merge-capability vs merge-shape are reported as DIFFERENT causes.
// ---------------------------------------------------------------------------
console.log("\n-- merge failure causes are distinguishable --");
{
  const M = factory(THREE, undefined);
  // First absorb happens with texMerge NOT yet resolved -> no merge array.
  const scene = freshScene();
  const first = M.tryAbsorbTerrainLbIntoBatch(
    scene, lbMesh(30, 3, true), { texMergeEnabled: false, texMergeAlphaArray: false }, EXTRAS);
  const st = M.__state();
  check("merge-less first absorb succeeds", first === true);
  check("batch built without a merge array", st.mergeArray === null);
  // Now a later LB DOES carry merge data — the batch cannot hold it.
  const late = lbMesh(31, 3, true);
  const md = new Uint8Array(48 * 8 * 4);
  late.userData.mergeDataTexture = new THREE.DataTexture(md, 48, 8);
  const r = M.tryAbsorbTerrainLbIntoBatch(scene, late, OPTS, EXTRAS);
  check("merge-carrying LB falls back to a per-LB draw", r === false);
  check("counted as a CAPABILITY miss, not a shape miss",
    st.mergeCapabilityMisses === 1 && st.mergeShapeMisses === 0,
    `capability=${st.mergeCapabilityMisses} shape=${st.mergeShapeMisses}`);
}

// ---------------------------------------------------------------------------
// 6. Anchor failure still disables the batch (fail-soft contract preserved).
// ---------------------------------------------------------------------------
console.log("\n-- anchor drift disables batching rather than mis-rendering --");
{
  const M = factory(THREE, undefined);
  const scene = freshScene();
  const drifted = { ...EXTRAS, fragmentGlsl: FRAG_GLSL.replace("  bool acGouraud = uAcGouraudEnabled > 0.5;", "  bool acGouraud = true;") };
  const r = M.tryAbsorbTerrainLbIntoBatch(scene, lbMesh(40, 4, true), OPTS, drifted);
  check("absorb refused when the gouraud anchor is missing", r === false);
  check("no batch state was created", M.__state() === null);
}

console.log("\n=========================");
console.log(`terrain batch: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
