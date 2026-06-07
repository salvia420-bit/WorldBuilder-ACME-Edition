// Batch 14 — #13 Option A: init3D re-fire idempotency guard.
//
// Standalone node ESM static test (no live ACE session, no browser). Reads
// index.html as text and asserts that the `useRenderer3d` block short-circuits
// on `window.liveScene3d` BEFORE it imports/calls init3D — so the autoLogin /
// kick-retry path (a 0x0D rejection then success) cannot re-enter
// renderHoltburg and stack a 2nd WebGLRenderer.
//
// Run:
//   cd apps/holtburger-web/
//   node test_init3d_idempotency_guard.mjs
//
// Covers (from the master fix-plan Batch 14 GATE, static portion):
//   - index.html `useRenderer3d` block contains a `window.liveScene3d`
//     short-circuit before `init3D(`.
//   - The guard sits inside `if (useRenderer3d) {` and before both the
//     `await import(".../scene3d/index.js...")` and the `await init3D(` call.
//   - The guard returns (skips the body) rather than falling through.
//
// The single-WebGL-context / unchanged resize-listener-count capture is
// browser/laptop-only (see plan); it is NOT run here.

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const src = readFileSync(joinPath(__dirname, "index.html"), "utf8");

// ---- locate the useRenderer3d block ---------------------------------
const blockStart = src.indexOf("if (useRenderer3d) {");
check("index.html has an `if (useRenderer3d) {` block", blockStart >= 0);

// The init3D import marks the start of the real (heavy) init path.
const importIdx = src.indexOf('import("./scene3d/index.js', blockStart);
check("useRenderer3d block dynamically imports scene3d/index.js (init3D)", importIdx >= 0);

// The init3D call site.
const callIdx = src.indexOf("init3D(canvas", blockStart);
check("useRenderer3d block calls init3D(canvas, …)", callIdx >= 0);

// ---- the guard must appear AFTER the block opens, BEFORE import+call ----
const guardIdx = src.indexOf("window.liveScene3d", blockStart);
check(
  "a `window.liveScene3d` reference exists inside the useRenderer3d block",
  guardIdx >= 0 && guardIdx > blockStart,
);

check(
  "the window.liveScene3d short-circuit is BEFORE the init3D import",
  guardIdx >= 0 && importIdx >= 0 && guardIdx < importIdx,
  `guard@${guardIdx} import@${importIdx}`,
);

check(
  "the window.liveScene3d short-circuit is BEFORE the init3D call",
  guardIdx >= 0 && callIdx >= 0 && guardIdx < callIdx,
  `guard@${guardIdx} call@${callIdx}`,
);

// ---- the guard is a real short-circuit (if (window.liveScene3d) { … return) --
// Slice from the block open to the init3D import; the guard + early-out must
// live entirely in that prefix.
const prefix = src.slice(blockStart, importIdx >= 0 ? importIdx : blockStart);
const guardIf = /if\s*\(\s*window\.liveScene3d\s*\)\s*\{/.test(prefix);
check("guard is `if (window.liveScene3d) {` form", guardIf);

const guardReturns = /if\s*\(\s*window\.liveScene3d\s*\)\s*\{[\s\S]*?\breturn\b[\s\S]*?\}/.test(
  prefix,
);
check("guard early-returns (skips the init3D import/call)", guardReturns);

// The guard should set a render-status message so the user sees feedback.
check(
  "guard sets renderStatus when short-circuiting",
  /if\s*\(\s*window\.liveScene3d\s*\)\s*\{[\s\S]*?renderStatus\.(?:innerHTML|textContent)\s*=/.test(
    prefix,
  ),
);

// ---- do-not-regress: the heavy init path is unchanged (still present) ----
check(
  "init3D import target unchanged (scene3d/index.js)",
  importIdx >= 0,
);

// ---------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
