#!/usr/bin/env node
// scripts/sync-vendor.mjs — Vendor external CDN libraries from node_modules into local /vendor/*
//
// Enables air-gapped offline operation by copying pinned versions of:
//   - three (0.184.0)
//   - postprocessing (6.39.1)
//   - tiny-invariant (1.3.3)
//
// USAGE:
//   node scripts/sync-vendor.mjs          # sync from node_modules to vendor/
//   node scripts/sync-vendor.mjs --check  # verify vendored files exist

import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // apps/holtburger-web
const VENDOR_DIR = resolve(ROOT, "vendor");

// Candidate locations for node_modules
const CANDIDATE_NODE_MODULES = [
  resolve(ROOT, "node_modules"),
  resolve(ROOT, "..", "..", "..", "external", "holtburger", "apps", "holtburger-web", "node_modules"),
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/node_modules",
  "/workspace/wb/home/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/node_modules",
];

function findNodeModules() {
  for (const dir of CANDIDATE_NODE_MODULES) {
    if (existsSync(join(dir, "three", "package.json"))) {
      return dir;
    }
  }
  return null;
}

const SYNC_SPEC = [
  {
    pkg: "three",
    expectedVersion: "0.184.0",
    files: [
      ["package.json", "three/package.json"],
      ["LICENSE", "three/LICENSE"],
      ["build/three.module.js", "three/build/three.module.js"],
      ["build/three.core.js", "three/build/three.core.js"],
      ["examples/jsm/controls/OrbitControls.js", "three/examples/jsm/controls/OrbitControls.js"],
      ["examples/jsm/utils/BufferGeometryUtils.js", "three/examples/jsm/utils/BufferGeometryUtils.js"],
      ["examples/jsm/loaders/EXRLoader.js", "three/examples/jsm/loaders/EXRLoader.js"],
      ["examples/jsm/libs/fflate.module.js", "three/examples/jsm/libs/fflate.module.js"],
    ],
  },
  {
    pkg: "postprocessing",
    expectedVersion: "6.39.1",
    files: [
      ["package.json", "postprocessing/package.json"],
      ["LICENSE.md", "postprocessing/LICENSE.md"],
      ["build/index.js", "postprocessing/build/index.js"],
    ],
  },
  {
    pkg: "tiny-invariant",
    expectedVersion: "1.3.3",
    files: [
      ["package.json", "tiny-invariant/package.json"],
      ["LICENSE", "tiny-invariant/LICENSE"],
      ["dist/esm/tiny-invariant.js", "tiny-invariant/dist/esm/tiny-invariant.js"],
    ],
  },
];

const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  let missing = 0;
  for (const entry of SYNC_SPEC) {
    for (const [, targetRel] of entry.files) {
      const targetPath = join(VENDOR_DIR, targetRel);
      if (!existsSync(targetPath) || statSync(targetPath).size === 0) {
        console.error(`[sync-vendor] Missing or empty: ${targetRel}`);
        missing++;
      }
    }
  }
  if (missing > 0) {
    console.error(`[sync-vendor] --check failed: ${missing} files missing`);
    process.exit(1);
  } else {
    console.log("[sync-vendor] --check passed: all vendor files present and populated");
    process.exit(0);
  }
}

const nodeModulesDir = findNodeModules();
if (!nodeModulesDir) {
  console.error("[sync-vendor] Error: node_modules not found in search paths");
  process.exit(1);
}

console.log(`[sync-vendor] Using node_modules from: ${nodeModulesDir}`);

let totalCopied = 0;

for (const entry of SYNC_SPEC) {
  const pkgJsonPath = join(nodeModulesDir, entry.pkg, "package.json");
  if (!existsSync(pkgJsonPath)) {
    console.error(`[sync-vendor] Package not found: ${entry.pkg}`);
    process.exit(1);
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  console.log(`[sync-vendor] Syncing ${entry.pkg}@${pkgJson.version} (expected ~${entry.expectedVersion})`);

  for (const [srcRel, targetRel] of entry.files) {
    const srcPath = join(nodeModulesDir, entry.pkg, srcRel);
    const targetPath = join(VENDOR_DIR, targetRel);
    if (!existsSync(srcPath)) {
      console.error(`[sync-vendor] Source file not found: ${srcPath}`);
      process.exit(1);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(srcPath, targetPath);
    totalCopied++;
  }
}

console.log(`[sync-vendor] Successfully synced ${totalCopied} files to ${VENDOR_DIR}`);
