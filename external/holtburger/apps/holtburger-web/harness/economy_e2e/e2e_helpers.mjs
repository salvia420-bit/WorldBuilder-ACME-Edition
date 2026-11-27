// harness/economy_e2e/e2e_helpers.mjs
// Shared opaque-box E2E helpers for the Guild-Based Physicalized Town Control
// & Closed-Loop Economy suite (Phases A-E + R6).
// Zero Math.random(); deterministic clocks, real subprocess/DB/HTTP/WS/3D checks.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { requireThree } from "../lib/locate_three.mjs";
import { createFakeWebGL2, fakeCanvas } from "../../tests/helpers/fake_webgl2.mjs";
import { installFakeAudio } from "../../tests/helpers/fake_audio_context.mjs";
import { lintManifest, lintSource } from "../../scene3d/vfx/lint_caps.js";
import { filterErrors } from "../lib/console_allowlist.mjs";

export { assert, createFakeWebGL2, fakeCanvas, installFakeAudio, lintManifest, lintSource, filterErrors };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = path.resolve(HERE, "..");
export const APP_ROOT = path.resolve(HARNESS_ROOT, "..");
export const EXT_HOLTBURGER_ROOT = path.resolve(APP_ROOT, "..", "..");
export const REPO_ROOT = path.resolve(EXT_HOLTBURGER_ROOT, "..", "..");
export const VEHICLE_DIR = path.join(APP_ROOT, "scene3d", "vehicle");
export const PROTOCOL_DIR = path.join(APP_ROOT, "docs", "vehicles-2026-11-01", "protocol");
export const ACE_PATCH_DIR = path.join(APP_ROOT, "docs", "vehicles-2026-11-01", "ace");

export const ACE_ROOT = process.env.ACE_SERVER_DIR
  || (existsSync("/workspace/wb/home/ace-server") ? "/workspace/wb/home/ace-server" : "/home/wbterminal/ace-server");
export const ACE_TESTS_CSPROJ = path.join(ACE_ROOT, "Source", "ACE.Server.Tests", "ACE.Server.Tests.csproj");
export const ACE_SHARD_UPDATES_DIR = path.join(ACE_ROOT, "Source", "ACE.Server", "Database", "Updates", "Shard");
export const ACE_DB_SHARD_UPDATES_DIR = path.join(ACE_ROOT, "Database", "Updates", "Shard");

export const DIST_ROOT = process.env.HOLTBURGER_DIST
  || (existsSync("/workspace/wb/hb-serve/dist/current") ? "/workspace/wb/hb-serve/dist/current" : path.join(EXT_HOLTBURGER_ROOT, "dist"));

export const DOTNET_ROOT = process.env.DOTNET_ROOT || "/workspace/wb/dotnet";
export const DOTNET_BIN = existsSync(path.join(DOTNET_ROOT, "dotnet")) ? path.join(DOTNET_ROOT, "dotnet") : "dotnet";

export const PLAYWRIGHT_CORE_PATH = process.env.HB_PLAYWRIGHT_CORE
  || "/workspace/wb/mnt1/ac-refs/webac/node_modules/playwright-core";
export const CHROME_BIN = process.env.HB_CHROME
  || "/workspace/wb/ms-playwright/chromium-1254/chrome-linux64/chrome";

export const REQUIRED_FEATURES = Object.freeze([
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9",
  "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "R6",
]);

// Pinned to commit 7ac2867f — ALL 18 Automated Warehouse files MUST remain untouched.
export const WAREHOUSE_18_FILES = Object.freeze([
  { rel: "scene3d/vehicle/warehouse_specs.js", sha256: "e6f241f7e44fbc1e34cd71a87526df5b57a0c4812c2c22973e3fcb1fd730a14f" },
  { rel: "scene3d/vehicle/warehouse_kinematics.js", sha256: "9c690269122fdc4a2e16eec88f9a47bd582b25794ab7ba4ae9dc1bbbca974de8" },
  { rel: "scene3d/vehicle/warehouse_manager.js", sha256: "86ab50346b68dbab82bd556666b81ca0c769d78d70b678aea415565c55cf290f" },
  { rel: "scene3d/vehicle/warehouse_rack_model.js", sha256: "c3778fa3d53903c1736e4a053c64758274240d88d19913466c64ab98a5fdd20a" },
  { rel: "scene3d/vehicle/agf_forklift_model.js", sha256: "91c4b44e329de7b1c18a036ab3027a5fc1ea683761be455f5ddd1bb1f55dc112" },
  { rel: "scene3d/vehicle/amr_underride_model.js", sha256: "a231d9f84b7b5c0a6842dbc925bdece43ec8d50c4766cca622e4e475aa63c2cd" },
  { rel: "scene3d/vehicle/warehouse_infra_model.js", sha256: "c7663ce0434c7538346bdeb8909f2dbbc41159d8c79e93994fb40080b8b23a42" },
  { rel: "tests/vehicle_warehouse_specs_kinematics.test.mjs", sha256: "5d3b898b72a3ba0b1b63e534138d2f3b4cf13b75360b2e8eb103cd59c8f9dbcc" },
  { rel: "tests/vehicle_warehouse_models.test.mjs", sha256: "5e00dbe3aa4c54dde4cf268eb493828d4de723ebbcbe0b748409b461514cac6e" },
  { rel: "tests/vehicle_warehouse_manager.test.mjs", sha256: "b92071a8be9d2c2041926c08a38e6406b5f3fdfc202c08aaad9fb90a09d36054" },
  { rel: "tests/vehicle_warehouse_tier5.test.mjs", sha256: "fc6d9de5572198955f6eee4a59309581575c6b86b47a7a8f4456d331ce59e0a8" },
  { rel: "harness/warehouse-hub-stage.js", sha256: "5a9dd9e98d89aecf8df1caea602acedd36a4857845829ef5e80b6b07099fc5f7" },
  { rel: "harness/warehouse_e2e/run_e2e.mjs", sha256: "fd01738516f04802b5ea1227459e00ab9ac72418153965f54353a1bf5388b92d" },
  { rel: "harness/warehouse_e2e/e2e_helpers.mjs", sha256: "216a1e1c0b42019a9984a5801ff1d9c63600110561b5a01ecec9a89d775206dc" },
  { rel: "harness/warehouse_e2e/tier1_features.mjs", sha256: "4390e967d347e33a525bc778a786a2d5fc966c2a60079d7801a45e2a6b5d49f1" },
  { rel: "harness/warehouse_e2e/tier2_boundaries.mjs", sha256: "9c6223b2be45ae00a0cad2c5d2cf03c217b8a7213d932755f1a3053a8dca1322" },
  { rel: "harness/warehouse_e2e/tier3_pairwise.mjs", sha256: "7be1f36a2a4c4102310210e71c1c04da8cce5b5afefa2f4a661a29663321c1ad" },
  { rel: "harness/warehouse_e2e/tier4_scenarios.mjs", sha256: "6e0b586967d588f788295999f689fb044ac32955c075a7de168981acc5dc30c2" },
]);

export const WAREHOUSE_UNIT_TEST_FILES = Object.freeze([
  "tests/vehicle_warehouse_specs_kinematics.test.mjs",
  "tests/vehicle_warehouse_models.test.mjs",
  "tests/vehicle_warehouse_manager.test.mjs",
  "tests/vehicle_warehouse_tier5.test.mjs",
]);

export const OUTER_OCEAN_PORTS = Object.freeze([
  { name: "NE Marine Terminal", lb: "0xEAF9", x: 44960, y: 47880 },
  { name: "Dericost Landing", lb: "0x600D8001", x: 18552, y: 71496 },
  { name: "Port Eastham", lb: "0xD097", x: 39984, y: 29016 },
  { name: "Port Hebian-To", lb: "0xE94F", x: 44760, y: 15312 },
  { name: "Port North-Watch", lb: "0x64EC", x: 19320, y: 45432 },
  { name: "Port Direlands-South", lb: "0x1A13", x: 5160, y: 3648 },
  { name: "Port Sanamar", lb: "0x34D8", x: 10008, y: 41568 },
  { name: "Port Bluespire", lb: "0x21AF", x: 6456, y: 33768 },
  { name: "Port Kryst", lb: "0xE61D", x: 44208, y: 5592 },
  { name: "Port Vissidal", lb: "0xD0E3", x: 40056, y: 43704 },
  { name: "Port Singularity Caul", lb: "0x0610", x: 1152, y: 3192 },
]);

export const ECONOMY_WCID_SPECS = Object.freeze({
  containers: {
    4000060: { code: "22R1", kind: 30, kw: 5, pallets: 8 },
    4000061: { code: "45R1", kind: 31, kw: 6, pallets: 18 },
    4000062: { code: "22T1", kind: 32, kw: 0, liters: 24000 },
    4000063: { code: "22K2", kind: 33, kw: 0, liters: 20000 },
    4000064: { code: "22B0", kind: 34, kw: 0, tonnes: 26 },
    4000065: { code: "22U1", kind: 35, kw: 0, tonnes: 27 },
    4000066: { code: "22P1", kind: 36, kw: 0, tonnes: 32 },
    4000067: { code: "42P1", kind: 37, kw: 0, tonnes: 40 },
  },
  prospecting: {
    4000070: { name: "GPR", kind: 38, kw: 1.5 },
    4000071: { name: "VibroseisSeismic", kind: 39, kw: 4.0 },
    4000072: { name: "DiamondCoreDrill", kind: 40, kw: 18 },
    4000073: { name: "MobileAssayLab", kind: 41, kw: 6 },
    4000074: { name: "CoreSampleCrate", kind: 42, kw: 0 },
  },
  skids: {
    4000075: { name: "BoreholeMiner", kind: 43, kw: 28 },
    4000076: { name: "JawCrusher", kind: 44, kw: 45 },
    4000077: { name: "Concentrator", kind: 45, kw: 35 },
    4000078: { name: "RotaryOilRig", kind: 46, kw: 85 },
    4000079: { name: "PumpjackTree", kind: 47, kw: 15 },
    4000080: { name: "ThreePhaseSeparator", kind: 48, kw: 12 },
    4000081: { name: "AduRefinery", kind: 49, kw: 60 },
    4000082: { name: "HdtVduDewaxer", kind: 50, kw: 55 },
    4000083: { name: "PyroSmelter", kind: 51, kw: 75 },
    4000084: { name: "ContactAcidWorks", kind: 52, kw: 40 },
    4000085: { name: "BioProcessorTannery", kind: 53, kw: 18 },
    4000086: { name: "IndustrialGenset150kW", kind: 54, kw: -150 },
    4000087: { name: "IndustrialBess18MJ", kind: 55, mj: 18 },
  },
  civic: {
    4000090: { name: "TownControlNode", kind: 56, kw: 0 },
    4000091: { name: "TownDepotApron", kind: 57, kw: 0 },
    4000092: { name: "ForwardSiegeBeacon", kind: 58, kw: 0 },
    4000093: { name: "TownMint", kind: 59, kw: 30 },
    4000094: { name: "TownWorkshop", kind: 60, kw: 25 },
    4000095: { name: "PublicCommonsStarterHearth", kind: 61, kw: 0 },
  },
  maritime: {
    4000050: { name: "ContainerShipFeeder", locomotion: 3, vehicleClass: 4 },
    4000051: { name: "StsGantryCrane", kind: 23 },
    4000052: { name: "RmgYardCrane", kind: 24 },
    4000053: { name: "RtgYardCrane", kind: 25 },
    4000054: { name: "TerminalTractorShuttle", kind: 26 },
    4000055: { name: "ReeferRackBay", kind: 27 },
    4000056: { name: "QuayBollard", kind: 28 },
    4000057: { name: "MarineFender", kind: 29 },
  },
});

export const ECONOMY_TABLES = Object.freeze([
  "town_control",
  "town_vendor_ledger",
  "town_warehouse_stock",
  "subsurface_deposit",
  "industry_facility",
  "logistics_convoy",
  "monarch_order",
]);

export const DERICOS_PROVINCIAL_QUOTAS = Object.freeze({
  "Gelid Plateau": 10,
  "Ashatiri Lowlands": 8,
  "Valley of Tresimaen": 8,
  "Dericost Marshes": 6,
  "The High Desert Plateau": 6,
  "Nesortania Maritime Coast": 3,
});

// =============================================================================
// Three.js / WebGL2 / Source Lint Helpers
// =============================================================================

let cachedThree = null;
export async function getThree() {
  if (!cachedThree) {
    cachedThree = await requireThree("economy-e2e");
  }
  return cachedThree;
}

export function countLights(root) {
  const lights = [];
  if (root && typeof root.traverse === "function") {
    root.traverse((obj) => {
      if (obj && obj.isLight) lights.push(obj.type || obj.constructor?.name || "Light");
    });
  }
  return { total: lights.length, lights };
}

export function spyDisposal(root) {
  let geometries = 0;
  let materials = 0;
  let textures = 0;
  const seenGeo = new Set();
  const seenMat = new Set();
  const seenTex = new Set();
  if (root && typeof root.traverse === "function") {
    root.traverse((obj) => {
      if (obj.geometry && !seenGeo.has(obj.geometry)) {
        seenGeo.add(obj.geometry);
        geometries++;
        if (typeof obj.geometry.dispose === "function") obj.geometry.dispose();
      }
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        if (!m || seenMat.has(m)) continue;
        seenMat.add(m);
        materials++;
        for (const k of Object.keys(m)) {
          const val = m[k];
          if (val && val.isTexture && !seenTex.has(val)) {
            seenTex.add(val);
            textures++;
            if (typeof val.dispose === "function") val.dispose();
          }
        }
        if (typeof m.dispose === "function") m.dispose();
      }
    });
  }
  return { geometries, materials, textures };
}

export function assertNoNaNDeep(root) {
  let verticesChecked = 0;
  let nodesChecked = 0;
  root.traverse((obj) => {
    nodesChecked++;
    for (const v of [obj.position.x, obj.position.y, obj.position.z, obj.scale.x, obj.scale.y, obj.scale.z]) {
      assert.ok(Number.isFinite(v), `Non-finite transform on ${obj.name || obj.type}`);
    }
    const q = obj.quaternion;
    for (const v of [q.x, q.y, q.z, q.w]) {
      assert.ok(Number.isFinite(v), `Non-finite quaternion on ${obj.name || obj.type}`);
    }
    if (obj.geometry?.attributes) {
      for (const [attrName, attr] of Object.entries(obj.geometry.attributes)) {
        if (!attr?.array) continue;
        for (let i = 0; i < attr.array.length; i++) {
          assert.ok(Number.isFinite(attr.array[i]), `Non-finite ${attrName}[${i}] on ${obj.name || obj.type}`);
          verticesChecked++;
        }
      }
    }
  });
  return { nodesChecked, verticesChecked };
}

export function renderWithFakeWebGL2(THREE, root) {
  const gl = createFakeWebGL2({ width: 640, height: 480 });
  const canvas = fakeCanvas(gl, 640, 480);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.1, 1000);
  camera.position.set(12, 8, 12);
  camera.lookAt(0, 0, 0);
  scene.add(root);
  gl.__fake.reset();
  renderer.render(scene, camera);
  const drawCalls = (gl.__fake.counts.drawElements || 0)
    + (gl.__fake.counts.drawArrays || 0)
    + (gl.__fake.counts.drawElementsInstanced || 0)
    + (gl.__fake.counts.drawArraysInstanced || 0);
  const unitConflicts = gl.__fake.unitConflicts;
  const uboErrors = gl.__fake.uboErrors;
  renderer.dispose();
  assert.equal(unitConflicts, 0, `FakeWebGL2 texture unit conflicts: ${gl.__fake.conflictLog.join("; ")}`);
  assert.equal(uboErrors, 0, `FakeWebGL2 UBO errors: ${gl.__fake.uboErrorLog.join("; ")}`);
  assert.ok(drawCalls > 0, "Expected > 0 WebGL draw calls during render");
  return { drawCalls, counts: { ...gl.__fake.counts } };
}

// =============================================================================
// R6 Automated Warehouse Immutability Guard
// =============================================================================

export function sha256File(absPath) {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

export function verifyWarehouseImmutability(pinOverrides = null) {
  const pins = pinOverrides || WAREHOUSE_18_FILES;
  assert.equal(pins.length, 18, `Expected exactly 18 pinned warehouse files, got ${pins.length}`);
  const mismatched = [];
  for (const item of pins) {
    const abs = path.join(APP_ROOT, item.rel);
    if (!existsSync(abs)) {
      mismatched.push({ rel: item.rel, reason: "missing" });
      continue;
    }
    const actual = sha256File(abs);
    if (actual !== item.sha256) {
      mismatched.push({ rel: item.rel, reason: `sha256 mismatch: got ${actual}, expected ${item.sha256}` });
    }
  }
  assert.equal(
    mismatched.length,
    0,
    `R6 Warehouse immutability SHA256 violation: ${JSON.stringify(mismatched)}`
  );

  // Also check git diff (unstaged + staged) against REPO_ROOT for all 18 files
  const gitPaths = pins.map((p) => path.posix.join("external/holtburger/apps/holtburger-web", p.rel));
  const diffUnstaged = execFileSync("git", ["-C", REPO_ROOT, "diff", "--name-only", "--", ...gitPaths], {
    encoding: "utf8",
  }).trim();
  const diffStaged = execFileSync("git", ["-C", REPO_ROOT, "diff", "--cached", "--name-only", "--", ...gitPaths], {
    encoding: "utf8",
  }).trim();
  const dirty = [diffUnstaged, diffStaged].filter(Boolean).join("\n");
  assert.equal(dirty, "", `R6 Warehouse git diff is non-empty:\n${dirty}`);

  return { ok: true, checked: pins.length, diffFiles: [] };
}

// =============================================================================
// Subprocess Runners (Node, Python, Cargo, Dotnet -c Debug)
// =============================================================================

export function runProcess(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd || APP_ROOT,
      env,
      encoding: "utf8",
      maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
      timeout: opts.timeoutMs || 120000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : (err.message || String(err)),
      error: err,
    };
  }
}

export function runNode(relOrAbsPath, args = [], opts = {}) {
  const target = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(APP_ROOT, relOrAbsPath);
  return runProcess(process.execPath, [target, ...args], opts);
}

export function runPython(scriptPath, args = [], opts = {}) {
  const target = path.isAbsolute(scriptPath) ? scriptPath : path.join(APP_ROOT, scriptPath);
  return runProcess("python3", [target, ...args], opts);
}

export function runCargoProtocolTests(opts = {}) {
  return runProcess("cargo", ["test", "-p", "holtburger-protocol"], {
    cwd: EXT_HOLTBURGER_ROOT,
    timeoutMs: opts.timeoutMs || 180000,
    ...opts,
  });
}

export function runDotnetEconomyTests(filter = "FullyQualifiedName~EconomyE2E", opts = {}) {
  // HARD SAFETY RULE: NEVER run dotnet test -c Release while live ACE.Server is running.
  if (opts.configuration && opts.configuration !== "Debug") {
    throw new Error(`FORBIDDEN dotnet configuration "${opts.configuration}": must strictly use Debug`);
  }
  const args = [
    "test",
    ACE_TESTS_CSPROJ,
    "-c", "Debug",
    "--no-restore",
    "--filter", filter,
    "--verbosity", opts.verbosity || "normal",
  ];
  const env = {
    DOTNET_ROOT,
    PATH: `${DOTNET_ROOT}:${process.env.PATH || ""}`,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    ...(opts.strict !== undefined ? { ECONOMY_E2E_STRICT: opts.strict ? "1" : "0" } : {}),
    ...(opts.env || {}),
  };
  return runProcess(DOTNET_BIN, args, {
    cwd: ACE_ROOT,
    env,
    timeoutMs: opts.timeoutMs || 180000,
  });
}

const dotnetCache = new Map();

/**
 * Runs the entire EconomyE2E MSTest suite once per (strict) mode and caches the
 * per-method outcomes so T1/T2 checks verify specific C# [TestMethod]s rapidly
 * without spawning 80 redundant `dotnet test` processes.
 */
export function getDotnetEconomyOutcomes(opts = {}) {
  const strict = opts.strict ?? (process.env.ECONOMY_E2E_STRICT === "1");
  const cacheKey = strict ? "strict" : "preimpl";
  if (!opts.fresh && dotnetCache.has(cacheKey)) {
    return dotnetCache.get(cacheKey);
  }
  const res = runDotnetEconomyTests("FullyQualifiedName~EconomyE2E", {
    strict,
    verbosity: "normal",
    timeoutMs: 180000,
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  const outcomes = new Map();
  // MSTest `-v normal` outputs lines like:
  //   Passed TestName [12 ms]
  //   Failed TestName [12 ms]
  //   Skipped TestName [12 ms]
  for (const line of combined.split(/\r?\n/)) {
    const m = /^\s*(Passed|Failed|Skipped)\s+([^\s\[]+)(?:\s+\[.*\])?\s*$/.exec(line);
    if (m) {
      outcomes.set(m[2], m[1]);
    }
  }
  const summary = { code: res.code, stdout: res.stdout, stderr: res.stderr, outcomes };
  dotnetCache.set(cacheKey, summary);
  return summary;
}

export function assertDotnetMethodPassed(methodName, opts = {}) {
  const { code, outcomes, stdout, stderr } = getDotnetEconomyOutcomes(opts);
  const status = outcomes.get(methodName);
  if (!status) {
    // Fallback: suffix match in case console logger included class prefix
    for (const [k, v] of outcomes.entries()) {
      if (k === methodName || k.endsWith(`.${methodName}`)) {
        assert.equal(v, "Passed", `C# test ${k} had status=${v} (exit=${code}).\n${stdout.slice(-1200)}\n${stderr}`);
        return { method: k, status: v };
      }
    }
    throw new Error(`C# EconomyE2E test method "${methodName}" did not execute or was not found (exit=${code}).\n${stdout.slice(-1200)}\n${stderr}`);
  }
  assert.equal(status, "Passed", `C# test ${methodName} had status=${status} (exit=${code}).\n${stdout.slice(-1200)}\n${stderr}`);
  return { method: methodName, status };
}

export function runWarehouseUnitTests() {
  const results = [];
  for (const rel of WAREHOUSE_UNIT_TEST_FILES) {
    const res = runNode(rel, [], {
      timeoutMs: 1800000,
    });
    const errTag = res.error ? ` (${res.error.code || res.error.message})` : "";
    const tail = `${res.stdout || ""}\n${res.stderr || ""}`.trim().slice(-1500);
    assert.equal(res.code, 0, `${rel} failed (exit ${res.code})${errTag}:\n${tail}`);
    results.push({ rel, code: res.code });
  }
  return results;
}

export function runWarehouseE2E(args = ["--tier=all", "--json"]) {
  const res = runNode("harness/warehouse_e2e/run_e2e.mjs", args, {
    timeoutMs: 900000,
  });
  assert.equal(res.code, 0, `warehouse_e2e failed (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  return res;
}

// =============================================================================
// MariaDB CLI & SQL Collation Helpers
// =============================================================================

export function getMysqlConfig() {
  return {
    host: process.env.ACE_MYSQL_HOST || "127.0.0.1",
    port: String(process.env.ACE_MYSQL_PORT || "3306"),
    user: process.env.ACE_MYSQL_USER || "ace",
    password: process.env.ACE_MYSQL_PASSWORD || "ace",
    shardDb: process.env.ACE_MYSQL_SHARD_DB || "ace_shard",
    worldDb: process.env.ACE_MYSQL_WORLD_DB || "ace_world",
    authDb: process.env.ACE_MYSQL_AUTH_DB || "ace_auth",
  };
}

export function queryMysql(sql, db = null) {
  const cfg = getMysqlConfig();
  const args = [
    "-h", cfg.host,
    "-P", cfg.port,
    "-u", cfg.user,
    `-p${cfg.password}`,
    "-N",
    "--batch",
  ];
  if (db) args.push(db);
  args.push("-e", sql);
  const res = runProcess("mysql", args, { timeoutMs: 30000 });
  if (res.code !== 0) {
    throw new Error(`mysql query failed (exit ${res.code}): ${res.stderr || res.stdout}\nSQL: ${sql}`);
  }
  const lines = res.stdout.trim() ? res.stdout.trim().split(/\r?\n/) : [];
  return lines.map((line) => line.split("\t"));
}

export function queryMysqlScalar(sql, db = null) {
  const rows = queryMysql(sql, db);
  if (rows.length === 0 || rows[0].length === 0) return null;
  return rows[0][0];
}

export function assertMariaDbCollation(sqlText) {
  const text = String(sqlText || "");
  assert.ok(text.trim().length > 0, "SQL migration text must be non-empty");
  // Strip SQL comments AND single-quoted string literals ('...') BEFORE collation & CREATE TABLE checks
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/'(?:\\.|''|[^'\\])*'/g, "''");
  if (/utf8mb4_0900_ai_ci/i.test(stripped)) {
    throw new Error("Forbidden MySQL 8.0 collation utf8mb4_0900_ai_ci detected (breaks MariaDB 10.11); require utf8mb4_general_ci");
  }
  const createStmts = [
    ...stripped.matchAll(/CREATE\s+(?:TEMPORARY\s+)?TABLE\b[\s\S]*?(?=;|\bCREATE\s+(?:TEMPORARY\s+)?TABLE\b|$)/gi),
  ];
  for (let i = 0; i < createStmts.length; i++) {
    const stmt = createStmts[i][0];
    assert.ok(
      !/utf8mb4_0900_ai_ci/i.test(stmt),
      `CREATE TABLE statement #${i + 1} uses forbidden utf8mb4_0900_ai_ci`
    );
    assert.ok(
      /utf8mb4_general_ci/i.test(stmt),
      `CREATE TABLE statement #${i + 1} must explicitly declare MariaDB-compatible COLLATE=utf8mb4_general_ci`
    );
  }
  return true;
}

export function extractXmlEnumBlock(xmlText, enumName) {
  const esc = enumName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<enum\\s+name="${esc}"[^>]*>([\\s\\S]*?)<\\/enum>`, "i");
  const m = re.exec(String(xmlText || ""));
  return m ? m[1] : null;
}

export function assertProtocolV8Xml(xmlText) {
  const xml = String(xmlText || "");
  assert.ok(/<schema\b[^>]*\bversion="8"/.test(xml), 'vehicles.protocol.xml must declare version="8"');
  for (const op of ["0x0911", "0x0912", "0x0913", "0x0914", "0x0915", "0x0916"]) {
    assert.ok(xml.includes(op), `vehicles.protocol.xml missing HBV1 v8 opcode ${op}`);
  }
  return true;
}

// =============================================================================
// Nav Graph Validator & Strict Item 2 Exclusion Guard
// =============================================================================

export function findNavGraphPath() {
  const candidates = [
    process.env.ECONOMY_NAV_GRAPH,
    path.join(APP_ROOT, "data", "logistics_nav_graph.json"),
    path.join(EXT_HOLTBURGER_ROOT, "dist", "world", "logistics_nav_graph.json"),
    path.join(EXT_HOLTBURGER_ROOT, "dist", "logistics_nav_graph.json"),
    path.join(DIST_ROOT, "world", "logistics_nav_graph.json"),
    path.join(DIST_ROOT, "logistics_nav_graph.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadNavGraph() {
  const p = findNavGraphPath();
  assert.ok(p, "logistics_nav_graph.json not found in data/ or dist/");
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  return { path: p, graph: parsed };
}

export function assertItem2Excluded(graph) {
  assert.ok(graph && typeof graph === "object", "Nav graph must be an object");

  const normText = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");
  const isForbiddenItem2LbOrCell = (val) => {
    if (val === undefined || val === null) return false;
    if (typeof val === "number" && Number.isFinite(val)) {
      const u = val >>> 0;
      const hi = (u >>> 16) & 0xffff;
      return u === 0x7a63 || u === 0x4866 || hi === 0x7a63 || hi === 0x4866;
    }
    const s = String(val).trim().toLowerCase();
    if (!s) return false;
    if (/^\d+$/.test(s)) {
      const num = Number(s);
      if (Number.isFinite(num)) {
        const u = num >>> 0;
        const hi = (u >>> 16) & 0xffff;
        if (u === 0x7a63 || u === 0x4866 || hi === 0x7a63 || hi === 0x4866) return true;
      }
    }
    const m = /^(?:0x)?([0-9a-f]+)$/.exec(s);
    if (m) {
      const u = parseInt(m[1], 16) >>> 0;
      const hi = (u >>> 16) & 0xffff;
      if (u === 0x7a63 || u === 0x4866 || hi === 0x7a63 || hi === 0x4866) return true;
      const trimmed = m[1].replace(/^0+/, "") || "0";
      if (trimmed === "7a63" || trimmed === "4866") return true;
    }
    return /\b(?:0x)?0*(?:7a63|4866)[0-9a-f]{0,4}\b/i.test(s);
  };

  // 1. Verify 101 towns (60 Dereth + 41 Dericost)
  const towns = Array.isArray(graph.towns)
    ? graph.towns
    : Array.isArray(graph.nodes)
      ? graph.nodes.filter((n) => n.kind === "town" || n.type === "town" || n.townId !== undefined)
      : [];
  assert.equal(towns.length, 101, `Expected 101 towns (60 Dereth + 41 Dericost), got ${towns.length}`);

  const derethCount = towns.filter((t) => String(t.continent || "").toLowerCase() === "dereth" || t.continent === 0).length;
  const dericostCount = towns.filter((t) => String(t.continent || "").toLowerCase() === "dericost" || t.continent === 1).length;
  assert.equal(derethCount, 60, `Expected 60 Dereth towns, got ${derethCount}`);
  assert.equal(dericostCount, 41, `Expected 41 Dericost towns, got ${dericostCount}`);

  // 2. Verify strictly 11 canonical Outer Ocean ports (exact set match, Item 2 excluded)
  const ports = Array.isArray(graph.ports)
    ? graph.ports
    : Array.isArray(graph.nodes)
      ? graph.nodes.filter((n) => n.kind === "port" || n.type === "port" || n.isPort === true)
      : [];
  assert.equal(ports.length, 11, `Expected strictly 11 Outer Ocean ports (Item 2 excluded), got ${ports.length}`);

  const expectedPortNames = new Set(OUTER_OCEAN_PORTS.map((p) => normText(p.name)));
  const actualPortNames = new Set(ports.map((p) => normText(p.name)));
  for (const exp of expectedPortNames) {
    assert.ok(actualPortNames.has(exp), `Nav graph missing canonical Outer Ocean port: ${exp}`);
  }
  for (const act of actualPortNames) {
    assert.ok(expectedPortNames.has(act), `Forbidden/non-canonical port found in nav graph: ${act}`);
  }

  for (const p of ports) {
    const rawBlob = JSON.stringify(p);
    const normBlob = normText(rawBlob);
    assert.ok(!normBlob.includes("innersea"), `Forbidden Inner Sea port found: ${rawBlob}`);
    assert.ok(!normBlob.includes("direlandseast"), `Forbidden Item 2 Port Direlands-East found: ${rawBlob}`);
    assert.ok(!normBlob.includes("portyaraq"), `Forbidden Item 2 Port Yaraq found: ${rawBlob}`);
    for (const fieldVal of [p.lb, p.landblock, p.landblockId, p.cellId]) {
      assert.equal(isForbiddenItem2LbOrCell(fieldVal), false, `Forbidden Item 2 port landblock/cellId found: ${rawBlob}`);
    }
    assert.equal(/\b(?:0x)?(?:7a63|4866)[0-9a-f]{0,4}\b/i.test(rawBlob), false,
      `Forbidden Item 2 hex reference in port: ${rawBlob}`);
    if (p.terrainCode !== undefined) {
      assert.equal(p.terrainCode & 0x1f, 20, `Port ${p.name || p.id} terrainCode must have (b & 0x1F) == 20`);
    }
  }

  // 3. Inspect all edge/route arrays for Item 2 Inner Sea lanes
  const taggedEdges = [];
  const pushEdges = (arr, isSeaArrayEdge) => {
    if (!Array.isArray(arr)) return;
    for (const edge of arr) taggedEdges.push({ edge, isSeaArrayEdge });
  };
  pushEdges(graph.edges, false);
  pushEdges(graph.roadEdges, false);
  pushEdges(graph.seaLanes, true);
  pushEdges(graph.seaEdges, true);
  pushEdges(graph.maritimeRoutes, true);
  pushEdges(graph.maritimeEdges, true);
  pushEdges(graph.routes, false);
  pushEdges(graph.links, false);

  for (const { edge: e, isSeaArrayEdge } of taggedEdges) {
    if (!e || typeof e !== "object") continue;
    const rawBlob = JSON.stringify(e);
    const normBlob = normText(rawBlob);
    const isSea = isSeaArrayEdge || normBlob.includes("sea") || normBlob.includes("marine") || e.mode === "sea" || e.kind === "sea" || e.type === "sea";
    assert.ok(!normBlob.includes("innersea"), `Forbidden Item 2 Inner Sea edge found: ${rawBlob}`);
    assert.ok(!normBlob.includes("direlandseast"), `Forbidden Item 2 Direlands-East edge found: ${rawBlob}`);
    for (const fieldVal of [
      e.lb, e.landblock, e.landblockId, e.cellId,
      e.fromLb, e.toLb, e.fromLandblock, e.toLandblock, e.fromCellId, e.toCellId, e.sourceLb, e.targetLb,
    ]) {
      assert.equal(isForbiddenItem2LbOrCell(fieldVal), false,
        `Forbidden Item 2 edge landblock/cellId found: ${rawBlob}`);
    }
    if (isSea) {
      assert.ok(!normBlob.includes("portyaraq"), `Forbidden Item 2 Yaraq<->Direlands-East sea lane found: ${rawBlob}`);
      assert.equal(/\b(?:0x)?0*(?:7a63|4866)[0-9a-f]{0,4}\b/i.test(rawBlob), false,
        `Forbidden Item 2 hex reference in sea lane: ${rawBlob}`);
    }
  }

  if (Array.isArray(graph.basins)) {
    for (const b of graph.basins) {
      const bNorm = typeof b === "string" ? normText(b) : normText(JSON.stringify(b));
      if (bNorm.includes("innersea")) {
        throw new Error(`Nav graph basins array must NOT contain inner_sea: ${JSON.stringify(b)}`);
      }
    }
  }

  const metaNorm = normText(JSON.stringify({
    basins: graph.basins,
    seas: graph.seas,
    excluded: graph.excluded,
    summary: graph.summary,
  }));
  if (metaNorm.includes("innersea")) {
    if (graph.basins && !Array.isArray(graph.basins) && (graph.basins.inner_sea || graph.basins.innerSea)) {
      throw new Error("Nav graph must NOT contain active inner_sea basin");
    }
  }

  return { towns: towns.length, derethCount, dericostCount, ports: ports.length, edges: taggedEdges.length };
}

// =============================================================================
// AgentGatewayService (127.0.0.1:8090) Native Node 22 fetch + WebSocket Helpers
// =============================================================================

export function getGatewayConfig() {
  const baseUrl = (process.env.ECONOMY_GATEWAY_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
  const wsUrl = process.env.ECONOMY_GATEWAY_WS_URL || `${baseUrl.replace(/^http/, "ws")}/ws`;
  const token = process.env.ECONOMY_GATEWAY_TOKEN || "dev-economy-gateway-token";
  return { baseUrl, wsUrl, token };
}

export async function gatewayFetch(routePath, opts = {}) {
  const cfg = getGatewayConfig();
  const url = routePath.startsWith("http") ? routePath : `${cfg.baseUrl}${routePath.startsWith("/") ? "" : "/"}${routePath}`;
  const headers = { ...(opts.headers || {}) };
  if (opts.token !== null) {
    const tok = opts.token !== undefined ? opts.token : cfg.token;
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  let body = opts.body;
  if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(body);
  }
  const resp = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body,
    signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 10000),
  });
  const raw = await resp.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (_) {
    json = null;
  }
  return { status: resp.status, ok: resp.ok, headers: resp.headers, body: json, raw };
}

export function validateGatewayAuthResponse(resp, expectAuthenticated) {
  if (!expectAuthenticated) {
    assert.ok(
      resp.status === 401 || resp.status === 403,
      `Expected unauthenticated gateway call to return 401/403, got ${resp.status}`
    );
    return true;
  }
  assert.equal(resp.status, 200, `Expected authenticated gateway call to return 200, got ${resp.status}: ${resp.raw}`);
  return true;
}

export function gatewayWs(opts = {}) {
  const cfg = getGatewayConfig();
  const token = opts.token !== undefined ? opts.token : cfg.token;
  const base = opts.url || cfg.wsUrl;
  const url = token ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : base;

  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error(`WebSocket connection timeout to ${url}`));
    }, opts.timeoutMs || 8000);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        events,
        waitForEvent(predicate, waitMs = 8000) {
          const hit = events.find(predicate);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`Timed out waiting for WS event after ${waitMs}ms`)), waitMs);
            waiters.push({ predicate, res, t });
          });
        },
        close() {
          try { ws.close(); } catch (_) {}
        },
      });
    });

    ws.addEventListener("message", (ev) => {
      let data = ev.data;
      try { data = JSON.parse(String(ev.data)); } catch (_) {}
      events.push(data);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(data)) {
          clearTimeout(waiters[i].t);
          const w = waiters.splice(i, 1)[0];
          w.res(data);
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error (${url}): ${err?.message || "connection failed"}`));
    });
  });
}

// =============================================================================
// Network Probe & Headless Playwright Chromium Loader
// =============================================================================

export function probeTcpPort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok, detail = null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ ok, detail });
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false, "timeout"));
    sock.on("error", (err) => finish(false, err.code || err.message));
  });
}

export async function bootLiveClient(queryOverrides = {}, opts = {}) {
  assert.ok(existsSync(PLAYWRIGHT_CORE_PATH), `playwright-core missing at ${PLAYWRIGHT_CORE_PATH}`);
  assert.ok(existsSync(CHROME_BIN), `Chromium binary missing at ${CHROME_BIN}`);
  const pw = await import(pathToFileURL(path.join(PLAYWRIGHT_CORE_PATH, "index.mjs")).href);
  const chromium = pw.chromium || pw.default?.chromium;
  assert.ok(chromium, "chromium export missing from playwright-core");

  const params = new URLSearchParams({
    nosw: "1",
    autoLogin: "1",
    account: process.env.HB_TEST_ACCOUNT || "tailnet1",
    password: process.env.HB_TEST_PASSWORD || "tailnet1",
    autoSpawn: "first",
    bridge_url: process.env.HB_BRIDGE_URL || "ws://127.0.0.1:8080/",
    server_host: process.env.HB_SERVER_HOST || "127.0.0.1",
    server_port: process.env.HB_SERVER_PORT || "9000",
    vehicles: "on",
    nullRender: opts.egl ? "0" : "1",
    ...queryOverrides,
  });
  const baseUrl = process.env.HB_CLIENT_URL || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
  const url = `${baseUrl}?${params.toString()}`;

  const args = opts.egl
    ? [
        "--headless=new",
        "--use-gl=angle",
        "--use-angle=gl-egl",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--mute-audio",
        "--window-position=-32000,-32000",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ]
    : [
        "--headless=new",
        "--use-gl=swiftshader",
        "--mute-audio",
        "--window-position=-32000,-32000",
      ];

  const consoleErrors = [];
  const ignoredOptional404s = [];
  const pageErrors = [];
  const browser = await chromium.launch({
    executablePath: CHROME_BIN,
    headless: true,
    args,
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(err?.message || String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        const locUrl = msg.location?.()?.url || "";
        const isOptionalProbe404 =
          text === "Failed to load resource: the server responded with a status of 404 (File not found)" &&
          /(?:\/dist\/events\/index\.bin|\/scene3d\/assets\/(?:terrain_bc7\/t(?:1024|512|256)|pbr_terrain)\/manifest\.json)$/.test(locUrl);
        if (isOptionalProbe404) {
          ignoredOptional404s.push(locUrl);
        } else {
          consoleErrors.push(text);
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(
      () =>
        window.__bootState === "error" ||
        window.__bootState === "in-world" ||
        (Array.isArray(window.__bootStateHistory) &&
          window.__bootStateHistory.some((e) => e && e.state === "in-world")),
      null,
      { timeout: opts.bootTimeoutMs || 60000 }
    );
    const bootState = await page.evaluate(() => ({
      bootState: window.__bootState,
      history: window.__bootStateHistory || [],
      hasSession: Boolean(window.__sessionHandle),
      pose: window.__sessionHandle?.getLocalPlayerPose?.() || null,
    }));
    assert.notEqual(bootState.bootState, "error", `Client failed to reach in-world: ${JSON.stringify(bootState)}`);
    assert.ok(
      bootState.bootState === "in-world" || bootState.bootState === "ready",
      `Client failed to reach in-world: ${JSON.stringify(bootState)}`
    );
    assert.ok(
      Array.isArray(bootState.history) && bootState.history.some((e) => e && e.state === "in-world"),
      `Client bootStateHistory missing "in-world" transition (Bug 11 invariant): ${JSON.stringify(bootState)}`
    );

    let evalResult = null;
    if (typeof opts.onInWorld === "function") {
      evalResult = await opts.onInWorld(page, bootState);
    }

    const filtered = filterErrors([...consoleErrors, ...pageErrors]);
    assert.equal(
      filtered.failing.length,
      0,
      `Gating console/page errors:\n${filtered.failing.join("\n")}`
    );

    return { bootState, evalResult, consoleErrors, ignoredOptional404s, pageErrors, filtered };
  } finally {
    await browser.close();
  }
}

// =============================================================================
// Baseline Ground-Truth & Implementation Probes
// =============================================================================

export function verifyBaselineWorldAndDericostData() {
  const dericostIndexPath = path.join(DIST_ROOT, "dericost", "towns", "dericost_towns_index.json");
  assert.ok(existsSync(dericostIndexPath), `Missing ${dericostIndexPath}`);
  const dericostIndex = JSON.parse(readFileSync(dericostIndexPath, "utf8"));
  assert.equal(dericostIndex.totalTowns, 41, `Expected 41 Dericost towns, got ${dericostIndex.totalTowns}`);
  assert.equal(dericostIndex.towns?.length, 41, "Expected 41 entries in dericost towns array");
  for (const [prov, quota] of Object.entries(DERICOS_PROVINCIAL_QUOTAS)) {
    const cnt = dericostIndex.towns.filter((t) => t.province === prov).length;
    assert.equal(cnt, quota, `Dericost province ${prov} expected ${quota} towns, got ${cnt}`);
  }

  const worldMetaPath = path.join(DIST_ROOT, "world", "world_meta.json");
  const dericostMetaPath = path.join(DIST_ROOT, "world", "dericost_meta.json");
  assert.ok(existsSync(worldMetaPath), `Missing ${worldMetaPath}`);
  assert.ok(existsSync(dericostMetaPath), `Missing ${dericostMetaPath}`);
  const worldMeta = JSON.parse(readFileSync(worldMetaPath, "utf8"));
  const dericostMeta = JSON.parse(readFileSync(dericostMetaPath, "utf8"));
  assert.equal(worldMeta.width, 2041);
  assert.equal(worldMeta.cellSizeM, 24);
  assert.equal(dericostMeta.continent, "Dericost");
  assert.equal(dericostMeta.originYGlobal, 68928);

  return { dericostTowns: dericostIndex.towns.length, roadVertices: dericostMeta.roadVertices };
}

export function verifyBaselineMysqlGroundTruth() {
  const vendorWeenies = Number(queryMysqlScalar("SELECT COUNT(*) FROM weenie WHERE type = 12;", "ace_world"));
  assert.equal(vendorWeenies, 1179, `Expected 1179 vendor weenies in ace_world, got ${vendorWeenies}`);

  const pyreal70263 = Number(queryMysqlScalar(
    "SELECT COUNT(*) FROM weenie_properties_create_list WHERE object_Id = 70263 AND destination_Type = 4 AND weenie_Class_Id = 273;",
    "ace_world"
  ));
  assert.ok(pyreal70263 >= 1, "Expected baseline 70263 Festival Vendor Pyreal (273) Shop listing in ace_world");

  const slumlords = Number(queryMysqlScalar(
    "SELECT COUNT(*) FROM landblock_instance li JOIN weenie w ON w.class_Id = li.weenie_Class_Id WHERE w.type = 55;",
    "ace_world"
  ));
  assert.equal(slumlords, 6250, `Expected 6250 SlumLord instances in ace_world, got ${slumlords}`);

  const tradeNotes = Number(queryMysqlScalar(
    "SELECT COUNT(*) FROM weenie WHERE class_Id IN (2621,2622,2623,2624,2625,7374,7375,7376,2626,7377,2627,20628,20629,20630);",
    "ace_world"
  ));
  assert.equal(tradeNotes, 14, `Expected 14 Trade Note denominations in ace_world, got ${tradeNotes}`);

  return { vendorWeenies, pyreal70263, slumlords, tradeNotes };
}

export async function runNegativeSelfChecks(THREE) {
  const results = [];

  // 1. Item 2 exclusion negative check: MUST reject Port Yaraq <-> Port Direlands-East / inner_sea
  const badGraph = {
    towns: [
      ...Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `Dereth_${i}`, continent: "Dereth" })),
      ...Array.from({ length: 41 }, (_, i) => ({ id: 61 + i, name: `Dericost_${i}`, continent: "Dericost" })),
    ],
    ports: OUTER_OCEAN_PORTS.map((p, i) => ({ ...p, id: i + 1, terrainCode: 20 })),
    seaLanes: [
      { from: "Port Yaraq", to: "Port Direlands-East", basin: "inner_sea", fromLb: "0x7A63", toLb: "0x4866" },
    ],
  };
  assert.throws(
    () => assertItem2Excluded(badGraph),
    /Forbidden Item 2|Inner Sea/i,
    "assertItem2Excluded failed to reject synthetic Item 2 inner_sea edge"
  );
  results.push({ id: "NEG-ITEM2", status: "PASS", detail: "assertItem2Excluded rejected synthetic Inner Sea / 0x7A63<->0x4866 lane" });

  // 2. MariaDB collation negative check: MUST reject utf8mb4_0900_ai_ci
  assert.throws(
    () => assertMariaDbCollation("CREATE TABLE town_control (id INT) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;"),
    /utf8mb4_0900_ai_ci/,
    "assertMariaDbCollation failed to reject utf8mb4_0900_ai_ci"
  );
  results.push({ id: "NEG-COLLATION", status: "PASS", detail: "assertMariaDbCollation rejected utf8mb4_0900_ai_ci" });

  // 3. Three.js 0-light & source lint negative check
  const group = new THREE.Group();
  group.add(new THREE.PointLight(0xffffff, 1, 10));
  const lightCheck = countLights(group);
  assert.equal(lightCheck.total, 1, "countLights failed to detect injected PointLight");
  const badLint = lintSource("const x = Math.random(); mesh.visible = false;");
  assert.ok(badLint.length >= 2, `lintSource failed to detect forbidden Math.random / .visible=, got ${badLint.length}`);
  results.push({ id: "NEG-3D-LIGHT-LINT", status: "PASS", detail: "countLights detected PointLight & lintSource detected Math.random + .visible=" });

  // 4. Gateway auth negative check: MUST reject 401 on missing Bearer token
  assert.throws(
    () => validateGatewayAuthResponse({ status: 401, raw: "Unauthorized" }, true),
    /Expected authenticated gateway call to return 200/,
    "validateGatewayAuthResponse failed to reject 401 when auth expected"
  );
  assert.equal(validateGatewayAuthResponse({ status: 401, raw: "Unauthorized" }, false), true);
  results.push({ id: "NEG-GATEWAY-401", status: "PASS", detail: "validateGatewayAuthResponse rejected missing-token 401" });

  // 5. Warehouse SHA256 tamper negative check
  const tamperedPins = WAREHOUSE_18_FILES.map((item, idx) =>
    idx === 0 ? { ...item, sha256: "0".repeat(64) } : item
  );
  assert.throws(
    () => verifyWarehouseImmutability(tamperedPins),
    /R6 Warehouse immutability SHA256 violation/,
    "verifyWarehouseImmutability failed to detect tampered SHA256 pin"
  );
  results.push({ id: "NEG-R6-TAMPER", status: "PASS", detail: "verifyWarehouseImmutability detected tampered SHA256 pin" });

  // 6. Item 2 dummy-port replacement bypass check (11 ports with Port Kryst swapped out)
  const dummyPortGraph = {
    towns: badGraph.towns,
    ports: OUTER_OCEAN_PORTS.map((p, i) =>
      p.name === "Port Kryst" ? { name: "DummyPort", lb: "0x9999", x: 1000, y: 1000, id: i + 1, terrainCode: 20 } : { ...p, id: i + 1, terrainCode: 20 }
    ),
    seaEdges: [],
  };
  assert.throws(
    () => assertItem2Excluded(dummyPortGraph),
    /missing canonical Outer Ocean port|Forbidden\/non-canonical port/i,
    "assertItem2Excluded failed to reject dummy port replacement"
  );
  results.push({ id: "NEG-ITEM2-DUMMY-PORT", status: "PASS", detail: "assertItem2Excluded rejected dummy port replacement of Port Kryst" });

  // 7. Item 2 space-separated name + 32-bit cell ID (0x48660001) bypass check
  const spaceAndCell32Graph = {
    towns: badGraph.towns,
    ports: OUTER_OCEAN_PORTS.map((p, i) => ({ ...p, id: i + 1, terrainCode: 20 })),
    seaEdges: [
      { from: "Port Yaraq", to: "Port Direlands East", fromCellId: "0x7A630001", toCellId: "0x48660001", mode: "sea" },
    ],
  };
  assert.throws(
    () => assertItem2Excluded(spaceAndCell32Graph),
    /Forbidden Item 2/i,
    "assertItem2Excluded failed to reject space-separated 'Port Direlands East' / 32-bit cellId 0x48660001"
  );
  results.push({ id: "NEG-ITEM2-SPACE-CELL32", status: "PASS", detail: "assertItem2Excluded rejected 'Port Direlands East' & 0x48660001" });

  // 8. Multi-table SQL collation bypass check (2nd CREATE TABLE omits utf8mb4_general_ci)
  const multiTableBadSql = [
    "CREATE TABLE town_control (town_id INT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;",
    "CREATE TABLE second_table (id INT PRIMARY KEY) ENGINE=InnoDB;",
  ].join("\n");
  assert.throws(
    () => assertMariaDbCollation(multiTableBadSql),
    /CREATE TABLE statement #2.*utf8mb4_general_ci/i,
    "assertMariaDbCollation failed to reject 2nd CREATE TABLE omitting utf8mb4_general_ci"
  );
  results.push({ id: "NEG-COLLATION-MULTI", status: "PASS", detail: "assertMariaDbCollation rejected multi-table SQL with 2nd CREATE TABLE missing collation" });

  // 9. SQL string-literal positive test (MED-02): DEFAULT 'utf8mb4_0900_ai_ci' inside string literal must pass
  assert.equal(
    assertMariaDbCollation("CREATE TABLE t (note VARCHAR(64) DEFAULT 'utf8mb4_0900_ai_ci') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;"),
    true,
    "assertMariaDbCollation false-positived on single-quoted SQL string literal"
  );
  results.push({ id: "POS-COLLATION-STRING-LITERAL", status: "PASS", detail: "assertMariaDbCollation ignored single-quoted string literal 'utf8mb4_0900_ai_ci'" });

  // 10. Item 2 MED-01 bypasses: seaLanes without sea/marine keywords, zero-padded hex, decimal string, array basins
  const baseValidGraph = {
    towns: badGraph.towns,
    ports: OUTER_OCEAN_PORTS.map((p, i) => ({ ...p, id: i + 1, terrainCode: 20 })),
    edges: [],
    seaLanes: [],
  };
  assert.throws(
    () => assertItem2Excluded({ ...baseValidGraph, seaLanes: [{ from: "Port Yaraq", to: "X" }] }),
    /Forbidden Item 2/i,
    "assertItem2Excluded failed to reject seaLanes edge lacking sea/marine keywords"
  );
  assert.throws(
    () => assertItem2Excluded({ ...baseValidGraph, edges: [{ lb: "0x00007a63", mode: "road" }] }),
    /Forbidden Item 2/i,
    "assertItem2Excluded failed to reject zero-padded hex 0x00007a63"
  );
  assert.throws(
    () => assertItem2Excluded({ ...baseValidGraph, edges: [{ lb: "31331", mode: "road" }] }),
    /Forbidden Item 2/i,
    "assertItem2Excluded failed to reject decimal string 31331 (0x7A63)"
  );
  assert.throws(
    () => assertItem2Excluded({ ...baseValidGraph, basins: ["outer_ocean", "inner_sea"] }),
    /inner_sea/i,
    "assertItem2Excluded failed to reject array graph.basins containing inner_sea"
  );
  results.push({ id: "NEG-ITEM2-MED01-BYPASSES", status: "PASS", detail: "assertItem2Excluded rejected seaLanes-keywordless, 0x00007a63, decimal 31331, and array basins" });

  return results;
}

export async function probeImplementationTargets() {
  const probes = [];
  const checkFile = (key, phase, label, absPath) => {
    if (existsSync(absPath)) {
      probes.push({ key, phase, label, status: "AVAILABLE", detail: absPath });
    } else {
      probes.push({ key, phase, label, status: "NOT_YET_IMPLEMENTED", detail: `Missing: ${absPath}` });
    }
  };

  // Phase A-E C# files
  checkFile("cs_town_registry", "Phase A", "TownRegistry.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "TownRegistry.cs"));
  checkFile("cs_town_economy", "Phase A", "TownEconomyManager.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "TownEconomyManager.cs"));
  checkFile("cs_siege_manager", "Phase B", "SiegeManager.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs"));
  checkFile("cs_town_commands", "Phase B", "TownCommands.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Command", "Handlers", "TownCommands.cs"));
  checkFile("cs_geology", "Phase C", "GeologyService.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "GeologyService.cs"));
  checkFile("cs_perishable", "Phase C", "PerishableDecay.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "PerishableDecay.cs"));
  checkFile("cs_logistics", "Phase D", "LogisticsEngine.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "LogisticsEngine.cs"));
  checkFile("cs_gateway", "Phase E", "AgentGatewayService.cs", path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "AgentGatewayService.cs"));

  // Protocol v8 XML check
  const xmlPath = path.join(PROTOCOL_DIR, "vehicles.protocol.xml");
  if (!existsSync(xmlPath)) {
    probes.push({ key: "proto_v8", phase: "Phase C", label: "vehicles.protocol.xml v8", status: "LOAD_ERROR", detail: `Missing ${xmlPath}` });
  } else {
    const xml = readFileSync(xmlPath, "utf8");
    const isV8 = /version="8"/.test(xml) && /0x0916/.test(xml);
    probes.push({
      key: "proto_v8",
      phase: "Phase C",
      label: "vehicles.protocol.xml v8",
      status: isV8 ? "AVAILABLE" : "NOT_YET_IMPLEMENTED",
      detail: isV8 ? "version=8 + 0x0911..0x0916 present" : "Currently < version 8",
    });
  }

  // Nav graph
  const navPath = findNavGraphPath();
  probes.push({
    key: "nav_graph",
    phase: "Phase D",
    label: "logistics_nav_graph.json",
    status: navPath ? "AVAILABLE" : "NOT_YET_IMPLEMENTED",
    detail: navPath || "Not yet baked",
  });

  // MariaDB ace_shard 7 tables
  try {
    const cfg = getMysqlConfig();
    const rows = queryMysql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN (${ECONOMY_TABLES.map((t) => `'${t}'`).join(",")});`
    );
    const present = rows.map((r) => r[0]);
    probes.push({
      key: "mysql_shard_tables",
      phase: "Phase A-E",
      label: "ace_shard 7 economy tables",
      status: present.length === ECONOMY_TABLES.length ? "AVAILABLE" : "NOT_YET_IMPLEMENTED",
      detail: `${present.length}/${ECONOMY_TABLES.length} present (${present.join(", ") || "none"})`,
    });
  } catch (err) {
    probes.push({ key: "mysql_shard_tables", phase: "Phase A-E", label: "ace_shard 7 economy tables", status: "LOAD_ERROR", detail: err.message });
  }

  // Live TCP ports (:3306, :8080, :8765, :8090)
  for (const [key, phase, label, port] of [
    ["port_mysql", "Baseline", "MariaDB :3306", 3306],
    ["port_wsbridge", "Baseline", "wsbridge :8080", 8080],
    ["port_serve", "Baseline", "serve.py :8765", 8765],
    ["port_gateway", "Phase E", "AgentGatewayService :8090", 8090],
  ]) {
    const res = await probeTcpPort("127.0.0.1", port);
    probes.push({
      key,
      phase,
      label,
      status: res.ok ? "AVAILABLE" : "NOT_YET_IMPLEMENTED",
      detail: res.ok ? `127.0.0.1:${port} listening` : `127.0.0.1:${port} closed (${res.detail})`,
    });
  }

  return probes;
}

export function discoverEconomyVehicleModelFiles() {
  const excluded = new Set(WAREHOUSE_18_FILES.map((w) => path.basename(w.rel)));
  const candidates = [
    "economy_models.js",
    "industry_models.js",
    "siege_models.js",
    "prospecting_models.js",
    "civic_models.js",
    "special_container_models.js",
    "container_models.js",
    "deployable_models.js",
    "port_models.js",
  ];
  const found = [];
  for (const name of readdirSync(VEHICLE_DIR)) {
    if (!name.endsWith(".js")) continue;
    if (excluded.has(name)) continue;
    if (candidates.includes(name) || /economy|siege|industry|prospect|civic|town|reefer|skid/.test(name)) {
      found.push(path.join(VEHICLE_DIR, name));
    }
  }
  return found;
}

export function findShardMigrationSqlFiles() {
  const dirs = [ACE_SHARD_UPDATES_DIR, ACE_DB_SHARD_UPDATES_DIR].filter((d) => existsSync(d));
  const sqlFiles = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".sql") && /economy|town|siege|geology|industry|logistics|monarch|2026-11-27/i.test(f)) {
        sqlFiles.push(path.join(dir, f));
      }
    }
  }
  return sqlFiles;
}
