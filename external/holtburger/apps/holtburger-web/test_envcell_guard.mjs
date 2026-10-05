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

// ---- load cells.js as a REAL ES module ------------------------------
// 2026-10-05: the hand-rolled splice rotted as cells.js grew module-top-level
// reads of imported symbols (readPortalPass2Flag(null), makeLosCache(),
// STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT) — it died with a bare ReferenceError and
// sat in QUARANTINE. Node resolves every cells.js import from the tree
// (verified: the whole graph imports headless), so the GENUINE module runs.
// Its flag readers look at globalThis.location at module load, so the sync-
// path flag is set BEFORE the import.
globalThis.location = { search: "?noEnvcellTimeSlice=1" };
const { buildEnvCellsForLandblock } = await import("./scene3d/cells.js");

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
    // P6 hardening (2026-07-10): cells.js now prewarms through
    // bake_prewarm.js guardedCompileAsync, which calls the SYNC
    // `renderer.compile()` and polls program readiness itself — it never calls
    // `renderer.compileAsync`. The old mock only had compileAsync, so compile()
    // threw, cells.js swallowed it ("cells will lazy-compile") and the
    // simulated eviction never ran. Drive the hook from compile(); an empty
    // Set = "no programs pending", so the guard re-checks right after.
    renderer: {
      compile: (subtree, camera, scene) => { compileAsyncImpl(subtree, camera, scene); return new Set(); },
      compileAsync: compileAsyncImpl,
    },
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
// (globalThis.location set above, before the import.)

// =====================================================================
// Test 1: eviction lands during compileAsync await (sync path) →
//   guard catches it → evictedDuringBuild true, cell NOT attached.
// =====================================================================
{
  const scene3d = makeScene3d(async (subtree, camera, scene) => {
    // Simulate an eviction tick interleaving while compile is in flight:
    // evict() removes the lbKey from envCellLoadedLbs.
    // geom-audit (2026-07-02): the mid-build eviction signal is now the
    // per-LB generation token, which landblock_lru's evict() deletes along
    // with the loaded mark — mirror both.
    scene3d.envCellLoadedLbs.delete(LB_KEY);
    scene3d.envCellBuildGen?.delete(LB_KEY);
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
