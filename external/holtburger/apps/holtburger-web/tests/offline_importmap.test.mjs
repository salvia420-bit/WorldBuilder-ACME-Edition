// tests/offline_importmap.test.mjs — Offline importmap, vendor sync, SW v3, and index.html hygiene
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { EXPECTED_WASM_MANIFEST_VERSION } from "../scene3d/wasm_manifest_version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const INDEX_HTML = path.join(APP_DIR, "index.html");
const SW_JS = path.join(APP_DIR, "service-worker.js");
const SYNC_VENDOR = path.join(APP_DIR, "scripts", "sync-vendor.mjs");
const GEN_PRELOAD = path.join(APP_DIR, "scripts", "gen-modulepreload.mjs");
const VENDOR_DIR = path.join(APP_DIR, "vendor");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

console.log("offline_importmap.test.mjs — testing offline vendor importmap, SW v3 & boot hygiene");

// 1. Importmap in index.html is fully local and contains no remote CDNs
await test("index.html importmap uses local ./vendor/* paths and no remote CDNs", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const m = /<script\s+type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "importmap script block exists");
  const map = JSON.parse(m[1]);
  assert.ok(map.imports, "importmap has 'imports'");

  assert.equal(map.imports["three"], "./vendor/three/build/three.module.js");
  assert.equal(map.imports["three/addons/"], "./vendor/three/examples/jsm/");
  assert.equal(map.imports["postprocessing"], "./vendor/postprocessing/build/index.js");
  assert.equal(map.imports["tiny-invariant"], "./vendor/tiny-invariant/dist/esm/tiny-invariant.js");

  // Ensure no CDN domains exist in importmap
  assert.ok(!m[1].includes("cdn.jsdelivr.net"), "no jsdelivr in importmap");
  assert.ok(!m[1].includes("unpkg.com"), "no unpkg in importmap");
  assert.ok(!m[1].includes("cdnjs.cloudflare.com"), "no cloudflare cdn in importmap");
});

// 2. scripts/sync-vendor.mjs syncs vendor files and passes --check
await test("scripts/sync-vendor.mjs --check succeeds and all vendor files exist", () => {
  const out = execFileSync(process.execPath, [SYNC_VENDOR, "--check"], {
    cwd: APP_DIR,
    encoding: "utf8",
  });
  assert.match(out, /--check passed/, "sync-vendor check passes");

  const requiredVendorFiles = [
    "three/build/three.module.js",
    "three/build/three.core.js",
    "three/examples/jsm/controls/OrbitControls.js",
    "three/examples/jsm/utils/BufferGeometryUtils.js",
    "three/examples/jsm/loaders/EXRLoader.js",
    "three/examples/jsm/libs/fflate.module.js",
    "postprocessing/build/index.js",
    "tiny-invariant/dist/esm/tiny-invariant.js",
  ];
  for (const rel of requiredVendorFiles) {
    const full = path.join(VENDOR_DIR, rel);
    assert.ok(fs.existsSync(full), `vendor file exists: ${rel}`);
    assert.ok(fs.statSync(full).size > 0, `vendor file non-empty: ${rel}`);
  }
});

// 3. scripts/gen-modulepreload.mjs generates preloads for vendor files and passes --check
await test("scripts/gen-modulepreload.mjs --check passes and includes vendor modules", () => {
  // gen-modulepreload outputs info to stderr
  const res = execFileSync(process.execPath, [GEN_PRELOAD, "--check"], {
    cwd: APP_DIR,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.ok(
    html.includes('<link rel="modulepreload" href="./vendor/three/build/three.module.js">'),
    "three.module.js preloaded"
  );
  assert.ok(
    html.includes('<link rel="modulepreload" href="./vendor/postprocessing/build/index.js">'),
    "postprocessing preloaded"
  );
});

// 4. Service Worker v3 configuration
await test("service-worker.js has SW_V3 constant defined and no dead prefetch URLs", () => {
  const swCode = fs.readFileSync(SW_JS, "utf8");
  assert.match(swCode, /const\s+SW_V3\s*=\s*(?:true|false);/, "SW_V3 is defined");
  assert.ok(
    !swCode.includes('"dist/boot.hba"'),
    "dead boot.hba removed from prefetch"
  );
  assert.ok(
    !swCode.includes('"dist/manifest/eor-portal.bin"'),
    "dead eor-portal.bin removed from prefetch"
  );
});

// 5. index.html checks EXPECTED_WASM_MANIFEST_VERSION and parallelizes plugins & wasm
await test("index.html imports EXPECTED_WASM_MANIFEST_VERSION and parallelizes pluginBarPromise", () => {
  assert.ok(typeof EXPECTED_WASM_MANIFEST_VERSION === "number" && EXPECTED_WASM_MANIFEST_VERSION >= 1, "EXPECTED_WASM_MANIFEST_VERSION is a valid number");
  const html = fs.readFileSync(INDEX_HTML, "utf8");

  // EXPECTED_WASM_MANIFEST_VERSION check
  assert.ok(
    html.includes('import { EXPECTED_WASM_MANIFEST_VERSION } from "./scene3d/wasm_manifest_version.js"'),
    "EXPECTED_WASM_MANIFEST_VERSION imported"
  );
  assert.ok(
    html.includes("wasmManifest.version < expectedWasmVersion") ||
    html.includes("wasmManifest < expectedWasmVersion") ||
    html.includes("manifest_version < expectedWasmVersion"),
    "checks wasm manifest version against expected"
  );

  // Parallel plugin manifest and wasm compile
  assert.ok(
    html.includes("pluginBarPromise") && html.includes("Promise.all([pluginBarPromise, wasmPromise])"),
    "parallelizes plugin bar initialization with wasm initialization"
  );

  // Zombie loop removal
  assert.ok(!html.includes("function followTick("), "followTick zombie loop removed");
  assert.ok(!html.includes("requestAnimationFrame(followTick)"), "followTick rAF removed");

  // CSS pixelated removal
  assert.ok(!html.includes("image-rendering: pixelated;"), "image-rendering pixelated removed");

  // 2D renderer deprecated
  assert.ok(
    html.includes("?renderer=2d is retired and deprecated"),
    "renderer=2d trap deprecated with console warning"
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} tests passed.`);
  process.exit(0);
}
