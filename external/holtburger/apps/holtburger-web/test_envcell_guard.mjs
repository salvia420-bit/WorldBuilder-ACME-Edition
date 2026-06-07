// Batch 11 — EnvCell post-compileAsync eviction guard (likely:envcell-guard).
//
// Finding: buildEnvCellsForLandblock awaits `renderer.compileAsync(...)`
// to pre-warm shader programs BEFORE attaching the new cell containers to
// the live scene graph. The post-await guard that bails when the LB was
// evicted mid-build was qualified by `envcellTimeSlice &&` — WRONG,
// because `compileAsync` itself yields to the event loop on EVERY path
// (time-sliced or not). So with `?noEnvcellTimeSlice=1` (sync path), an
// eviction landing during the compileAsync await would still let the
// stale cells attach → duplicate cells on re-approach. The fix drops the
// `envcellTimeSlice &&` qualifier so residency is ALWAYS re-checked after
// the await.
//
// This harness loads cells.js + adapter.js by hand-splicing them through
// `new Function` (the same self-contained trick the Batch-9 lifecycle test
// uses), injects a `lbKeyOf` (real, from the zero-import leaf) +
// `materialCanCastShadow` (stub — never called on an empty cell), and a
// `renderer.compileAsync` mock that DELETES the lbKey from
// envCellLoadedLbs mid-await. With the fix, the returned summary has
// `evictedDuringBuild === true` and NO cell is attached even though
// `envcellTimeSlice` is false.
//
// Run:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/three.module.js node test_envcell_guard.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { lbKeyOf } from "./scene3d/landblock_lru.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) return process.env.THREE_PATH;
  try { return require.resolve("three"); } catch (_) {}
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Batch 11 envcell-guard test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/three.module.js node test_envcell_guard.mjs");
  process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("Batch 11 — EnvCell post-compileAsync eviction guard (envcell-guard)");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load + splice the modules (strip imports/exports) --------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  if (!existsSync(full)) throw new Error(`module not found: ${full}`);
  let src = readFileSync(full, "utf8");
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  src = src.replace(/^\s*import\s+\{[^{}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^\s*import\s+\{[^{}]*\n[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  src = src.replace(/^\s*import\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  return src;
}
function stripExports(src) {
  return src
    .replace(/^\s*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ")
    .replace(/^\s*export\s+let\s+/gm, "let ")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

const adapterSrc = loadModule("scene3d/adapter.js");
const cellsSrc = loadModule("scene3d/cells.js");

const composite =
  "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
  "// === cells.js ===\n" + stripExports(cellsSrc) + "\n" +
  "; return { buildEnvCellsForLandblock };";

// Inject the cross-module symbols cells.js imported: `lbKeyOf` (real) and
// `materialCanCastShadow` (stub — never reached on an empty cell). adapter
// symbols (meshToGeometryGroups / acQuatToThree / placementToMatrix4 /
// meshToFusedGeometry) are spliced inline above.
const factory = new Function(
  "THREE", "performance", "window", "globalThis", "lbKeyOf", "materialCanCastShadow",
  composite,
);
const { buildEnvCellsForLandblock } = factory(
  THREE,
  globalThis.performance ?? { now: () => Date.now() },
  undefined,
  globalThis,
  lbKeyOf,
  () => false,
);

// ---- wasm/scene3d mocks ---------------------------------------------
const LB_FULL = 0xA9B40000;          // Holtburg LB (full 32-bit id)
const LB_KEY = lbKeyOf(LB_FULL);     // masked lb-key
const CELL_ID = (LB_KEY | 0x0100) >>> 0;

// One env-cell placement with an EMPTY mesh (triCount 0 → meshToGeometryGroups
// returns no groups) and no statics/portals. Enough to push one container into
// `newCells` so the compileAsync await fires.
function makePlacement() {
  return {
    cellId: CELL_ID,
    environmentId: 1,
    cellOriginX: 0, cellOriginY: 0, cellOriginZ: 0,
    cellOrientationQw: 1, cellOrientationQx: 0, cellOrientationQy: 0, cellOrientationQz: 0,
    takePortalCellIds: () => [],
    takeMesh: () => ({ triCount: 0, free() {} }),
    takeStaticObjects: () => [],
    free() {},
  };
}

function makeScene3d(compileAsyncImpl) {
  return {
    cellsGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    cellContainers3d: new Map(),
    envCellLoadedLbs: new Set(),
    materialCache: {
      getCached: () => new THREE.MeshBasicMaterial(),
      fallbackMaterial: new THREE.MeshBasicMaterial(),
      async preload() {},
    },
    renderer: { compileAsync: compileAsyncImpl },
  };
}

const wasmExports = {
  fetchEnvCellsInLandblock: async () => [makePlacement()],
  fetch_surfaces_pixels: () => {},
  // No statics → fetch_model_meshes never needed.
};

// Force the SYNC path (envcellTimeSlice = false) so this test proves the
// guard fires WITHOUT the `envcellTimeSlice &&` qualifier (the bug was that
// the qualifier suppressed the guard on exactly this path).
globalThis.location = { search: "?noEnvcellTimeSlice=1" };

// =====================================================================
// Test 1: eviction lands during compileAsync await (sync path) →
//   guard catches it → evictedDuringBuild true, cell NOT attached.
// =====================================================================
{
  const scene3d = makeScene3d(async (subtree, camera, scene) => {
    // Simulate an eviction tick interleaving while compile is in flight:
    // evict() removes the lbKey from envCellLoadedLbs.
    scene3d.envCellLoadedLbs.delete(LB_KEY);
    // Yield once to model the real async boundary.
    await Promise.resolve();
  });

  const summary = await buildEnvCellsForLandblock(scene3d, LB_FULL, wasmExports);
  check("Test1: returned summary.evictedDuringBuild === true (guard fired on sync path)",
    summary?.evictedDuringBuild === true, `got=${summary?.evictedDuringBuild}`);
  check("Test1: cellCount === 0 (build bailed)", summary?.cellCount === 0, `got=${summary?.cellCount}`);
  check("Test1: NO cell attached to cellsGroup", scene3d.cellsGroup.children.length === 0, `n=${scene3d.cellsGroup.children.length}`);
  check("Test1: cellContainers3d empty (no orphan registration)", scene3d.cellContainers3d.size === 0, `n=${scene3d.cellContainers3d.size}`);
}

// =====================================================================
// Test 2: no eviction during build → cell DOES attach (proves the guard
//   only suppresses the evicted case, not a clean build).
// =====================================================================
{
  const scene3d = makeScene3d(async () => { await Promise.resolve(); });
  const summary = await buildEnvCellsForLandblock(scene3d, LB_FULL, wasmExports);
  check("Test2: clean build NOT flagged evictedDuringBuild", !summary?.evictedDuringBuild, `got=${summary?.evictedDuringBuild}`);
  check("Test2: one cell attached", scene3d.cellsGroup.children.length === 1, `n=${scene3d.cellsGroup.children.length}`);
  check("Test2: cellContainers3d has the cell", scene3d.cellContainers3d.has(CELL_ID));
  check("Test2: lbKey still in envCellLoadedLbs", scene3d.envCellLoadedLbs.has(LB_KEY));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
