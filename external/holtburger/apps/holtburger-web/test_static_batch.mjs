// Problem-B (2026-06-15) — headless test for consolidateStaticSingletons
// (?staticBatch) in scene3d/statics.js. Proves the per-LB singleton→BatchedMesh
// consolidation: plain Meshes sharing a surfaceDid collapse into one BatchedMesh
// per surface (with all instances + correct tagging), while LOD wrappers and
// lone singletons pass through untouched, and the batch disposes cleanly.
//
// Run: cd apps/holtburger-web/ && node test_static_batch.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok?"OK":"FAIL"}] ${n}${d?" — "+d:""}`); ok?passed++:failed++; };

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
const tp = locateThree();
if (!tp) { console.log("static-batch test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);
console.log("Problem-B — static singleton BatchedMesh consolidation test");
console.log("=========================");

// Load statics.js with all imports stripped + unused deps stubbed (the helper
// under test only uses THREE).
let src = readFileSync(resolvePath(__dirname, "scene3d/statics.js"), "utf8");
src = src.replace(/^\s*import\s+.*$/gm, ""); // drop every import line
const shims =
  "const meshToGeometryGroups=()=>[],materialCanCastShadow=()=>false,lbKeyOf=x=>(x>>>0)&0xffff0000," +
  "modelMeshFetcher=()=>null,surfacePixelsFetcher=()=>null,CULL_DIST_SQ=Infinity,particleClockMode=()=>0," +
  "ownerRegistry={},particleOwnerOn=()=>false;class MaterialCache{};\n";
const stripped = src
  .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
  .replace(/^\s*export\s+function\s+/gm, "function ")
  .replace(/^\s*export\s+const\s+/gm, "const ")
  .replace(/^\s*export\s+class\s+/gm, "class ")
  .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
const factory = new Function("THREE", shims + stripped + "\n; return { consolidateStaticSingletons };");
const { consolidateStaticSingletons } = factory(THREE);

// ---- build mock singleton nodes ----
function triGeom() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  g.setIndex([0, 1, 2]);
  return g;
}
function singleton(surfaceDid, x) {
  const m = new THREE.Mesh(triGeom(), new THREE.MeshBasicMaterial());
  m.position.set(x, 0, 0);
  m.userData = { surfaceDid, landblockId: 0xAABB0000 >>> 0 };
  return m;
}
// share one material object per surfaceDid (mirrors materialCache.getCached)
const matA = new THREE.MeshBasicMaterial(), matB = new THREE.MeshBasicMaterial();
const nodes = [];
for (let i = 0; i < 5; i++) { const m = singleton(0x0A00, i); m.material = matA; nodes.push(m); } // surf A ×5
for (let i = 0; i < 3; i++) { const m = singleton(0x0B00, i); m.material = matB; nodes.push(m); } // surf B ×3
const lone = singleton(0x0C00, 99); nodes.push(lone);                                              // surf C ×1 (lone)
const lod = new THREE.LOD(); lod.userData = { surfaceDid: 0x0D00, landblockId: 0xAABB0000 }; nodes.push(lod); // LOD

const batches = [];
const out = consolidateStaticSingletons(nodes, batches);

const outBatched = out.filter((n) => n.isBatchedMesh);
const outMeshes = out.filter((n) => n.isMesh && !n.isBatchedMesh && !n.isLOD);
const outLods = out.filter((n) => n.isLOD);

check("1: produced 2 BatchedMeshes (surf A + surf B)", outBatched.length === 2, `got ${outBatched.length}`);
check("2: lone singleton (surf C) passed through as a plain Mesh", outMeshes.length === 1 && outMeshes[0] === lone, `meshes=${outMeshes.length}`);
check("3: LOD wrapper passed through untouched", outLods.length === 1 && outLods[0] === lod, `lods=${outLods.length}`);

const bA = outBatched.find((b) => b.userData.surfaceDid === 0x0A00);
const bB = outBatched.find((b) => b.userData.surfaceDid === 0x0B00);
check("4: surf-A batch holds 5 instances", bA && bA.instanceCount === 5, `instanceCount=${bA && bA.instanceCount}`);
check("5: surf-B batch holds 3 instances", bB && bB.instanceCount === 3, `instanceCount=${bB && bB.instanceCount}`);
check("6: batches tagged landblockId + __staticBatch + share the surface material",
  bA && bA.userData.landblockId === (0xAABB0000 >>> 0) && bA.userData.__staticBatch === true && bA.material === matA,
  `lb=${bA && bA.userData.landblockId?.toString(16)}, mat=${bA && bA.material === matA}`);

// node-count win: 9 plain singletons + 1 LOD = 10 in → batched A(5)+B(3) become 2 nodes,
// + lone(1) + LOD(1) = 4 nodes out. 10 draw-candidate nodes → 4.
check("7: node count collapsed 10 → 4 (8 singletons batched into 2)", out.length === 4, `out=${out.length}`);

// instance preservation: 5 + 3 batched instances + 1 lone = 9 rendered placements
const batchedInstances = outBatched.reduce((s, b) => s + b.instanceCount, 0);
check("8: all 8 batchable placements preserved as instances", batchedInstances === 8, `instances=${batchedInstances}`);

// matrix carried: surf-A instance 0 at x=0, instance 4 at x=4 (BEFORE dispose)
const m0 = new THREE.Matrix4(), m4 = new THREE.Matrix4();
bA.getMatrixAt(0, m0); bA.getMatrixAt(4, m4);
check("9: per-instance matrices carried (x=0 .. x=4)",
  Math.abs(m0.elements[12] - 0) < 1e-6 && Math.abs(m4.elements[12] - 4) < 1e-6,
  `x0=${m0.elements[12]}, x4=${m4.elements[12]}`);

// dispose cleanly (no throw) — the LRU calls this on evict
let disposed = true;
try { for (const b of outBatched) b.dispose(); } catch (e) { disposed = false; }
check("10: BatchedMesh.dispose() runs without throwing (evict path)", disposed, "");

// ===== P1.14 EDIT F — material-identity keying (the ?visual-ON correctness) =====
// Two DIDs sharing a surfaceDid but carrying DIFFERENT frag SETs resolve (via
// getCachedVariant) to DIFFERENT material objects. consolidateStaticSingletons now
// keys by material identity, so they must NOT fuse into one batch inheriting a
// single SET's material. (The ?visual-OFF case — one shared base per surfaceDid —
// is checks 1–8 above, which prove the grouping stays byte-identical.)
{
  const matE1 = new THREE.MeshBasicMaterial(), matE2 = new THREE.MeshBasicMaterial();
  const ns = [];
  for (let i = 0; i < 2; i++) { const m = singleton(0x0E00, i); m.material = matE1; ns.push(m); }
  for (let i = 0; i < 2; i++) { const m = singleton(0x0E00, i + 10); m.material = matE2; ns.push(m); }
  const bs = [];
  consolidateStaticSingletons(ns, bs);
  check("F1: same surfaceDid + 2 distinct materials ⇒ 2 batches (no cross-SET fusion)", bs.length === 2, `batches=${bs.length}`);
  check("F2: each batch keeps its OWN material (matE1 + matE2 both present)",
    bs.length === 2 && bs.some((b) => b.material === matE1) && bs.some((b) => b.material === matE2));
  check("F3: both batches still tag the shared surfaceDid 0x0E00",
    bs.length === 2 && bs.every((b) => (b.userData.surfaceDid >>> 0) === 0x0E00));
}

console.log("=========================");
console.log(`static-batch test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
