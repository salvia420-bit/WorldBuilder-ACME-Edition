// tests/rust_scene_core_smoke.test.mjs — the Rust scene core's JS handshake
// against the REAL compiled wasm (docs/2026-10-26-rust-scene-core.md).
//
// Loads `${HB_PKG || "pkg"}/holtburger_web.js` the way
// test_motion_sequence_wasm_smoke.mjs does, points scene3d/rust/scene_core.js at
// it, and checks: the ABI handshake, class lookup (present / absent), the
// stale-pkg fallback, and that WasmF32View survives memory growth.
//
// Run: node tests/rust_scene_core_smoke.test.mjs   (HB_PKG=pkg-rustcore for a dev build)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pkgDir = process.env.HB_PKG || "pkg";
let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

const core = await import("../scene3d/rust/scene_core.js");

// Stale / absent pkg first: no namespace → unavailable, never throws.
core.__setSceneWasmForTest(null, null);
check("no pkg: sceneCoreAvailable() is false", core.sceneCoreAvailable() === false);
check("no pkg: sceneWasmClass() is null", core.sceneWasmClass("SceneParticles") === null);
core.__setSceneWasmForTest({ sceneCoreAbi: () => 999 }, { buffer: new ArrayBuffer(8) });
const _warn = console.warn; let warned = 0; console.warn = () => { warned += 1; };
check("wrong ABI: unavailable", core.sceneCoreAvailable() === false);
console.warn = _warn;
check("wrong ABI: warns once", warned === 1, `warned=${warned}`);

let ns, out;
try {
  ns = await import(join(app, pkgDir, "holtburger_web.js"));
  out = await ns.default(readFileSync(join(app, pkgDir, "holtburger_web_bg.wasm")));
} catch (e) {
  console.log(`scene core smoke: SKIP — wasm pkg ${pkgDir}/ not loadable in Node: ${String(e.message).slice(0, 120)}`);
  process.exit(0);
}
if (typeof ns.sceneCoreAbi !== "function") {
  console.log(`scene core smoke: SKIP — ${pkgDir}/ predates the scene core (no sceneCoreAbi export); rebuild with wasm-pack`);
  process.exit(0);
}

core.__setSceneWasmForTest(ns, out.memory);
check("real pkg: ABI matches", ns.sceneCoreAbi() === core.SCENE_CORE_ABI, `abi=${ns.sceneCoreAbi()}`);
check("real pkg: sceneCoreAvailable()", core.sceneCoreAvailable() === true);
check("real pkg: unknown class → null", core.sceneWasmClass("NoSuchClass") === null);
check("real pkg: sceneWasmMemory() is the instance memory", core.sceneWasmMemory() === out.memory);

// Views: write through one view, read through another; then grow memory and
// make sure the view re-creates itself instead of reading a detached buffer.
// The scratch lives in a page this test grows itself, so it never touches
// memory the Rust allocator owns.
out.memory.grow(1);
const v = new core.WasmF32View();
const ptr = out.memory.buffer.byteLength - 64; // last 16 floats of our page
const a = v.get(ptr, 16);
a[0] = 1.5; a[15] = -2.25;
const b = new core.WasmF32View().get(ptr, 16);
check("view reads what another view wrote", b[0] === 1.5 && b[15] === -2.25);
check("same args → same view object", v.get(ptr, 16) === a);
out.memory.grow(1);
check("old view detached by grow", a.length === 0);
const c = v.get(ptr, 16);
check("view re-created after grow", c !== a && c.length === 16 && c[0] === 1.5 && c[15] === -2.25);

// Flags.
core.__setRustFlagForTest("rustSmokeFlag", undefined);
check("rustFlag default off", core.rustFlag("rustSmokeFlag", false) === false);
check("rustFlag default on", core.rustFlag("rustSmokeFlag2", true) === true);
core.__setRustFlagForTest("rustSmokeFlag", true);
check("rustFlag test override", core.rustFlag("rustSmokeFlag", false) === true);

console.log(`\nscene core smoke: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
