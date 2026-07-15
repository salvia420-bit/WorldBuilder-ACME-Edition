// ?walkInInstance (2026-07-15) — the CONSUMER GUARD test.
//
// WHAT IT PROTECTS. The walk-in baker has always emitted plain Mesh / LOD nodes
// and never an InstancedMesh, so three downstream consumers filter with
// `n.isMesh && !n.isLOD` and none of them guard `isInstancedMesh`:
//   statics.js         consolidateStaticSingletons        (legacy per-LB batcher)
//   static_batch_x.js  consolidateStaticSingletonsCrossLb (the DEFAULT-ON chunk batcher)
//   statics.js ~:2194  the statAtlas feed                 (DEFAULT-ON)
// `InstancedMesh.isMesh === true`. So the moment ?walkInInstance puts one in
// `addedNodes`, an unguarded consumer consumes it, calls addGeometry/addInstance
// ONCE and setMatrixAt(node.matrix) — the InstancedMesh's own per-instance
// matrices are NEVER read. Result: N placements collapse to 1 and the scenery
// silently disappears. That is the "half-missing forge" class of bug, it would
// be invisible to every draw-count probe (draws go DOWN, which reads as a win),
// and only a human looking at a town would catch it.
//
// This test asserts the guard directly: hand each consolidator a mixed list and
// require the InstancedMesh to come back UNCONSUMED and UNMUTATED.
//
// Run: cd apps/holtburger-web/ && node test_walkin_instance_guard.mjs
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
if (!tp) { console.log("walkin-instance-guard test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("file://" + tp);
console.log("?walkInInstance — downstream consumer guard test");
console.log("=========================");

const loadModule = (relPath, exportsList) => {
  let src = readFileSync(resolvePath(__dirname, relPath), "utf8");
  src = src.replace(/^\s*import\s+.*$/gm, "");
  const stripped = src
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+let\s+/gm, "let ")
    .replace(/^\s*export\s+default\s+/gm, "const __default = ");
  return new Function("THREE", stripped + `\n; return { ${exportsList.join(", ")} };`)(THREE);
};

function triGeom(tris = 1) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(tris * 9);
  for (let i = 0; i < tris; i++) pos.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(tris * 6), 2));
  return g;
}
const LB1 = 0x96960000 >>> 0;
const plainMesh = (surfaceDid, x, geom, mat) => {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, 0, 0);
  m.userData = { surfaceDid, landblockId: LB1 };
  return m;
};
// A walk-in instanced node, as ?walkInInstance pass 2 builds it: 4 placements,
// distinct per-instance matrices, stamped landblockId for per-LB eviction.
const instancedNode = (surfaceDid, count, geom, mat) => {
  const im = new THREE.InstancedMesh(geom, mat, count);
  for (let i = 0; i < count; i++) {
    im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
  }
  im.userData = { surfaceDid, landblockId: LB1, modelId: 0x1234 };
  return im;
};

// ===== 1. the chunk batcher (DEFAULT-ON — the live path) =====
{
  const M = loadModule("scene3d/static_batch_x.js", [
    "consolidateStaticSingletonsCrossLb", "__setStatBatchChunkForTest", "__resetStatBatchXForTest",
  ]);
  M.__setStatBatchChunkForTest(true);
  M.__resetStatBatchXForTest?.();
  const scene3d = { staticsGroup: new THREE.Group() };
  const mat = new THREE.MeshBasicMaterial();
  const geom = triGeom(2);
  const im = instancedNode(0x0A00, 4, geom, mat);
  // >=2 plain meshes on the SAME material as the InstancedMesh: this is the
  // adversarial case — the group is batchable, and the InstancedMesh keys to the
  // same material, so an unguarded filter pulls it straight in.
  const nodes = [plainMesh(0x0A00, 0, triGeom(1), mat), plainMesh(0x0A00, 1, triGeom(1), mat), im];
  const res = M.consolidateStaticSingletonsCrossLb(nodes, scene3d, LB1);
  const out = res ? res.out : nodes;
  check("1a: chunk batcher does NOT consume the InstancedMesh", out.includes(im),
    out.includes(im) ? "passed through" : "CONSUMED — every placement but one would vanish");
  check("1b: its instanceMatrix is untouched", im.instanceMatrix.array.length === 16 * 4);
  check("1c: it still reports 4 instances", im.count === 4);
  const batched = scene3d.staticsGroup.children.filter((c) => c.isBatchedMesh);
  check("1d: the >=2 plain group still batched (guard did not disable batching)", batched.length === 1,
    `${batched.length} BatchedMesh`);
}

// ===== 2. the legacy per-LB batcher =====
{
  const M = loadModule("scene3d/statics.js", ["consolidateStaticSingletons"]);
  const mat = new THREE.MeshBasicMaterial();
  const im = instancedNode(0x0A00, 4, triGeom(2), mat);
  const nodes = [plainMesh(0x0A00, 0, triGeom(1), mat), plainMesh(0x0A00, 1, triGeom(1), mat), im];
  const batches = [];
  const out = M.consolidateStaticSingletons(nodes, batches);
  check("2a: legacy batcher does NOT consume the InstancedMesh", out.includes(im),
    out.includes(im) ? "passed through" : "CONSUMED — every placement but one would vanish");
  check("2b: it still reports 4 instances", im.count === 4);
  check("2c: the >=2 plain group still batched", batches.length === 1, `${batches.length} batches`);
}

console.log("=========================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
