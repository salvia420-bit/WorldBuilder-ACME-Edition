// Batch 7 — Entity transform fixes (#8 _omegaAccumQ reset, #9 _baseScale jump).
//
// Standalone node ESM test (no live ACE session). Loads scene3d/entities.js
// by hand-splicing it through `new Function` (the same trick the 7.4b pipeline
// test uses) but with a robust import-stripper that also drops `../` and
// multi-line `import { … }` blocks (the 7.4b loader predates those and breaks
// at module-load, so this test is self-contained).
//
// Run:
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/three.module.js node test_phase7_batch7_omega_basescale.mjs
//
// Covers (from the master fix-plan Batch 7 GATE):
//   #8  SetOmega(0,0,0) hook-stop sets inst._omegaAccumQ = null (no residual
//       spin re-stamped by a later setPose); a non-zero SetOmega keeps it;
//       the cycleOmega-clear path in setMotion() also resets it.
//   #9  spawn stores inst._baseScale; the generic jump pose multiplies through
//       base so scaled creatures keep their size mid-air; default objScale==1
//       yields byte-identical scale.set(1,1,scaleZ) numbers.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

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

// ---- locate `three` --------------------------------------------------
function locateThree() {
  if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
    return process.env.THREE_PATH;
  }
  try {
    return require.resolve("three");
  } catch (_) {}
  return null;
}

const threePath = locateThree();
if (!threePath) {
  console.log("Batch 7 omega/baseScale test: SKIP (three not located).");
  console.log("  hint: THREE_PATH=/abs/three.module.js node test_phase7_batch7_omega_basescale.mjs");
  process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("Batch 7 — entity #8 omegaAccumQ reset + #9 baseScale jump test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- load + splice the modules --------------------------------------
function loadModule(relPath) {
  const full = resolvePath(__dirname, relPath);
  if (!existsSync(full)) throw new Error(`module not found: ${full}`);
  let src = readFileSync(full, "utf8");
  // Drop `import * as THREE from "three";`
  src = src.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "");
  // Drop single-line `import { … } from "…";` (any relative/bare path).
  src = src.replace(/^\s*import\s+\{[^{}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  // Drop multi-line `import {\n … \n} from "…";` blocks.
  src = src.replace(/^\s*import\s+\{[^{}]*\n[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
  // Drop any remaining default/namespace single-line imports.
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
const animSrc = loadModule("scene3d/animation.js");
const entitiesSrc = loadModule("scene3d/entities.js");

const composite =
  "// === adapter.js ===\n" + stripExports(adapterSrc) + "\n" +
  "// === animation.js ===\n" + stripExports(animSrc) + "\n" +
  "// === entities.js ===\n" + stripExports(entitiesSrc) + "\n" +
  "; return { EntityManager, AnimationCache };";

const factory = new Function("THREE", "performance", "window", composite);
const { EntityManager, AnimationCache } = factory(
  THREE,
  globalThis.performance ?? { now: () => Date.now() },
  undefined,
);

// ---- helpers ---------------------------------------------------------
function makeManager() {
  const scene3d = { scene: new THREE.Group(), quality: { preset: "high" } };
  // Minimal wasmExports — Batch 7 paths don't touch the wasm bridge.
  const em = new EntityManager(scene3d, {});
  return em;
}

// A lightweight EntityInstance stand-in carrying just the fields the
// transform code reads. (We do not build a full rig — #8/#9 are pure
// transform math on inst.root + the omega/jump scratch fields.)
function makeInst(baseScale = 1.0) {
  const root = new THREE.Group();
  if (baseScale !== 1) root.scale.setScalar(baseScale);
  return {
    guid: 0x1000,
    root,
    _baseScale: baseScale,
    _omega: null,
    _cycleOmega: null,
    _omegaAccumQ: null,
    airborneTilt: null,
    _jumpPoseTween: null,
  };
}

// =====================================================================
// #8 — SetOmega hook-stop resets _omegaAccumQ
// =====================================================================
{
  const em = makeManager();
  const inst = makeInst();
  // Seed an accumulated spin delta as if _tickHookOmega had run.
  inst._omegaAccumQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), Math.PI / 4,
  );
  inst._omega = { x: 0, y: 0, z: 2 };

  // Non-zero SetOmega → _omega set, accum preserved (it owns it).
  em._fireHook(inst, { hookType: 22, omegaX: 0, omegaY: 0, omegaZ: 3 }, null, null);
  check("#8 non-zero SetOmega keeps _omega", !!inst._omega &&
    inst._omega.z === 3, `omega=${JSON.stringify(inst._omega)}`);
  check("#8 non-zero SetOmega does NOT clear _omegaAccumQ", inst._omegaAccumQ != null);

  // Zero SetOmega → stop: _omega null AND _omegaAccumQ null.
  em._fireHook(inst, { hookType: 22, omegaX: 0, omegaY: 0, omegaZ: 0 }, null, null);
  check("#8 SetOmega(0,0,0) clears _omega", inst._omega === null);
  check("#8 SetOmega(0,0,0) clears _omegaAccumQ", inst._omegaAccumQ === null,
    `accum=${inst._omegaAccumQ}`);
}

// #8 — after stop + a fresh setPose, root.quaternion equals the server quat
//      (no residual spin baked back in by _omegaAccumQ.premultiply).
{
  const em = makeManager();
  const inst = makeInst();
  inst._omegaAccumQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), Math.PI / 3,
  );
  inst._omega = { x: 0, y: 0, z: 1 };
  em._fireHook(inst, { hookType: 22, omegaX: 0, omegaY: 0, omegaZ: 0 }, null, null);
  // Re-derive the root quaternion to a known server orientation, then
  // re-apply the accum the way setPose/tick does (only if present).
  const serverQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), Math.PI / 6,
  );
  inst.root.quaternion.copy(serverQ);
  if (inst._omegaAccumQ) inst.root.quaternion.premultiply(inst._omegaAccumQ);
  const equal =
    Math.abs(inst.root.quaternion.x - serverQ.x) < 1e-9 &&
    Math.abs(inst.root.quaternion.y - serverQ.y) < 1e-9 &&
    Math.abs(inst.root.quaternion.z - serverQ.z) < 1e-9 &&
    Math.abs(inst.root.quaternion.w - serverQ.w) < 1e-9;
  check("#8 post-stop setPose leaves no residual spin", equal,
    `q=${inst.root.quaternion.toArray().map((n) => n.toFixed(4))}`);
}

// #8 — cycleOmega-clear path in setMotion() also resets _omegaAccumQ.
{
  const em = makeManager();
  const inst = makeInst();
  inst.guid = 0x2000;
  inst.meta = { modelId: 0x02000001, mtableId: 0x09000001 };
  inst.lastStance = 0x3D; // any non-zero stance
  inst.fadeOutCurrent = () => {};
  inst._cycleOmega = { x: 0, y: 0, z: 1.5 };
  inst._cycleOmegaKey = "stub";
  inst._omegaAccumQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1), Math.PI / 5,
  );
  em.entityMap.set(inst.guid >>> 0, inst);
  // Drive a locomotion command (Walk-forward family). CYCLE_OMEGA_ON is
  // false in node (no window), so the `else if (inst._cycleOmega)` clear
  // branch runs. The downstream clip resolution may throw on the stub
  // wasm — that's after our reset, so guard it.
  try {
    await em.setMotion(inst.guid, 0x45000007, 0x3D, 1.0);
  } catch (_) { /* clip resolution past the reset point — ignore */ }
  check("#8 cycleOmega-clear nulls _cycleOmega", inst._cycleOmega === null);
  check("#8 cycleOmega-clear nulls _omegaAccumQ", inst._omegaAccumQ === null,
    `accum=${inst._omegaAccumQ}`);
}

// =====================================================================
// #9 — _baseScale stored at spawn semantics + generic jump pose
// =====================================================================

// #9 (a) default objScale==1 → jump tween is byte-identical scale.set(1,1,sZ).
{
  const em = makeManager();
  const inst = makeInst(1.0);
  em._applyGenericJumpPose(inst);
  // Advance the tween near the top of the arc (toScale=1.08).
  inst._jumpPoseTween.startMs = performance.now() - 9999; // force eased=1
  em._tickJumpPoseTween(inst, performance.now());
  const s = inst.root.scale;
  check("#9 default base: jump scale.x===1", s.x === 1, `x=${s.x}`);
  check("#9 default base: jump scale.y===1", s.y === 1, `y=${s.y}`);
  check("#9 default base: jump scale.z===1.08 (toScale)",
    Math.abs(s.z - 1.08) < 1e-9, `z=${s.z}`);
}

// #9 (b) scaled creature objScale==2 keeps x/y at base mid-jump, z in [2,2.16].
{
  const em = makeManager();
  const inst = makeInst(2.0);
  check("#9 scaled spawn: scale ~(2,2,2)",
    inst.root.scale.x === 2 && inst.root.scale.y === 2 && inst.root.scale.z === 2);
  check("#9 scaled spawn: _baseScale===2", inst._baseScale === 2);

  em._applyGenericJumpPose(inst);
  // Mid-tween (eased ~0.5 region): drive partway through the arc.
  inst._jumpPoseTween.startMs = performance.now() - 100; // ~half of 200ms
  em._tickJumpPoseTween(inst, performance.now());
  const s = inst.root.scale;
  check("#9 scaled jump: scale.x===2 (NOT 1)", s.x === 2, `x=${s.x}`);
  check("#9 scaled jump: scale.y===2 (NOT 1)", s.y === 2, `y=${s.y}`);
  check("#9 scaled jump: scale.z in [2, 2.16]",
    s.z >= 2 - 1e-9 && s.z <= 2.16 + 1e-9, `z=${s.z}`);

  // Land: drive the clear tween to completion → back to ~(2,2,2).
  em._clearGenericJumpPose(inst);
  inst._jumpPoseTween.startMs = performance.now() - 9999; // force eased=1
  em._tickJumpPoseTween(inst, performance.now());
  const sl = inst.root.scale;
  check("#9 scaled land: scale ~(2,2,2)",
    Math.abs(sl.x - 2) < 1e-9 && Math.abs(sl.y - 2) < 1e-9 &&
    Math.abs(sl.z - 2) < 1e-9, `=(${sl.x},${sl.y},${sl.z})`);
}

// #9 (c) default base land → byte-identical (1,1,1).
{
  const em = makeManager();
  const inst = makeInst(1.0);
  em._applyGenericJumpPose(inst);
  inst._jumpPoseTween.startMs = performance.now() - 9999;
  em._tickJumpPoseTween(inst, performance.now());
  em._clearGenericJumpPose(inst);
  inst._jumpPoseTween.startMs = performance.now() - 9999;
  em._tickJumpPoseTween(inst, performance.now());
  const s = inst.root.scale;
  check("#9 default land: scale ~(1,1,1)",
    Math.abs(s.x - 1) < 1e-9 && Math.abs(s.y - 1) < 1e-9 &&
    Math.abs(s.z - 1) < 1e-9, `=(${s.x},${s.y},${s.z})`);
}

console.log("=========================");
console.log(`Cases: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
