// three r184 BatchedMesh `colorTexture` bug — the workaround's contract.
//
// THE BUG (upstream, in three's bundled build AND its unbundled src):
//   WebGLRenderer.js:2400  } else if ( object.isBatchedMesh && materialProperties.batchingColor === true
//                                      && object.colorTexture === null ) { needsProgramChange = true; }
//   WebGLRenderer.js:2404  } else if ( object.isBatchedMesh && materialProperties.batchingColor === false
//                                      && object.colorTexture !== null ) { needsProgramChange = true; }
// BatchedMesh has NO `colorTexture` — the field is `_colorsTexture`. So
// `object.colorTexture` is `undefined`, `undefined !== null` is TRUE, and :2404
// fires for EVERY BatchedMesh EVERY frame -> getProgram -> getParameters + a
// program-cache-key string build, landing back on the identical program.
// Measured on the 1070: 179 fires/frame, getProgram 258->78/frame, renderCPU
// -11.8% once fixed (net-review/npc-counter-probe.mjs).
//
// This test asserts the workaround makes BOTH branches inert in BOTH colour
// states — which is why it must be a GETTER onto the real field and not
// `colorTexture = null`. A bare null silences :2404 today but INVERTS the bug the
// moment anything calls setColorAt(): `_colorsTexture` becomes non-null,
// `batchingColor` flips true, and :2400 (`colorTexture === null`) then fires
// every frame instead. Test 4 is that case, and it is the whole reason for the
// getter.
//
// Run: cd apps/holtburger-web/ && node test_bm_colortexture_fix.mjs
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) { return null; }
}
if (!locateThree()) { console.log("bm-colortexture-fix test: SKIP (three not located)."); process.exit(0); }
const THREE = await import("three");
const { applyBatchedMeshColorTextureFix, __resetBmColorTextureFixForTest } =
  await import("./scene3d/three_batchedmesh_colortexture_fix.js");

let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };
console.log("three r184 BatchedMesh colorTexture bug — workaround contract");
console.log("=========================");

const mkBatch = () => {
  const m = new THREE.MeshBasicMaterial();
  return new THREE.BatchedMesh(4, 64, 128, m);
};

// ===== 1. the bug is REAL in the three we ship =====
{
  const b = mkBatch();
  const bugPresent = !("colorTexture" in Object.getPrototypeOf(b)) && b.colorTexture === undefined;
  check("1: three r184 BatchedMesh really has NO colorTexture (the bug exists)", bugPresent,
    bugPresent ? "object.colorTexture === undefined" : "three appears to have fixed it — this workaround can retire");
  // and that undefined is what makes :2404's comparison vacuously true
  check("1b: `undefined !== null` is what fires the branch", b.colorTexture !== null);
}

// ===== 2. the fix aliases the real field =====
{
  __resetBmColorTextureFixForTest();
  const ok = applyBatchedMeshColorTextureFix(THREE);
  check("2: fix applies", ok === true);
  const b = mkBatch();
  check("2b: colorTexture is now null (not undefined) when there are no colours",
    b.colorTexture === null, `got ${String(b.colorTexture)}`);
}

// ===== 3. both branches are inert with NO per-instance colours =====
{
  const b = mkBatch();
  const batchingColor = b._colorsTexture !== null; // what three's getParameters computes
  const branch2400 = b.isBatchedMesh && batchingColor === true && b.colorTexture === null;
  const branch2404 = b.isBatchedMesh && batchingColor === false && b.colorTexture !== null;
  check("3: :2400 inert (no colours)", branch2400 === false);
  check("3b: :2404 inert (no colours) — THE 179/frame fire is gone", branch2404 === false);
}

// ===== 4. both branches stay inert WITH colours — the case a bare `= null` breaks =====
{
  const b = mkBatch();
  const gid = b.addGeometry(new THREE.BufferGeometry().setAttribute(
    "position", new THREE.BufferAttribute(new Float32Array(9), 3)));
  const iid = b.addInstance(gid);
  b.setColorAt(iid, new THREE.Color(1, 0, 0)); // -> _colorsTexture becomes non-null
  const batchingColor = b._colorsTexture !== null;
  check("4: setColorAt populated _colorsTexture", batchingColor === true);
  check("4b: the alias tracks it (getter, not a frozen null)", b.colorTexture === b._colorsTexture);
  const branch2400 = b.isBatchedMesh && batchingColor === true && b.colorTexture === null;
  const branch2404 = b.isBatchedMesh && batchingColor === false && b.colorTexture !== null;
  check("4c: :2400 inert WITH colours (a bare `colorTexture = null` would FIRE here every frame)",
    branch2400 === false);
  check("4d: :2404 inert WITH colours", branch2404 === false);
}

// ===== 5. idempotent + self-retiring =====
{
  __resetBmColorTextureFixForTest();
  check("5: re-applying is safe", applyBatchedMeshColorTextureFix(THREE) === true);
  const b = mkBatch();
  check("5b: still correct after a second apply", b.colorTexture === null);
  check("5c: no-op when three itself ships the property (self-retires)",
    "colorTexture" in Object.getPrototypeOf(b));
}

console.log("=========================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
