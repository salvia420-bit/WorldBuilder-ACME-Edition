#!/usr/bin/env node
// scripts/deploy-shell.mjs — T11 ST-SHELL: stage the built shell/ into a dist
// tree with the same CAS discipline as packs/ (SPEC §3 T11; pass-12 D-12.2).
//
// Copies, from apps/holtburger-web (or --from <root>, e.g. a build-shell
// --out-root):
//   shell/*                -> <dist>/shell/            (content-hashed CAS:
//                             existing identical files are skipped; an
//                             existing file with DIFFERENT bytes under the
//                             same hashed name is a hard failure — that is
//                             corruption, never a legal overwrite)
//   shell-manifest.json    -> <dist>/shell-manifest.json   (mutable pointer)
//   index-bundled.html     -> <dist>/index-bundled.html    (mutable pointer)
//
// The two pointers are deliberately OUTSIDE <dist>/shell/ — everything under
// shell/ is served immutable (serve.py SHELL_PREFIXES) and a mutable-named
// file there would be cached forever on first fetch.
//
// NOTE (hosting shape, R-10): the dist copy is CAS retention/hosting prep.
// The staged index-bundled.html references ./shell/ (correct at /dist/) but
// also ./pkg/, ./scene3d/assets/ etc., which live in the APP tree — serving
// the bundled arm today means opening
//   /apps/holtburger-web/index-bundled.html
// against the live tree; a production origin must mount app-shaped paths
// (owner call, SPEC §5 R-10). Until then <dist>/shell/ is the durable CAS
// home the N-1 retention rule applies to.
//
// USAGE
//   node scripts/deploy-shell.mjs --dist <dist-root> [--from <root>] [--dry-run]
//
// --dist is REQUIRED (never defaults to the live dist symlink — staging into
// the served tree is an explicit operator act, mirroring the bake tools).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, "..", "apps", "holtburger-web");

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function deployShell({ dist, from = APP_ROOT, dryRun = false, quiet = false } = {}) {
  if (!dist) throw new Error("--dist <dist-root> is required (no default — see header)");
  const log = (...a) => { if (!quiet) console.log("[deploy-shell]", ...a); };
  const srcShell = path.join(from, "shell");
  const manifestPath = path.join(from, "shell-manifest.json");
  const loaderPath = path.join(from, "index-bundled.html");
  for (const p of [srcShell, manifestPath, loaderPath]) {
    if (!fs.existsSync(p)) {
      throw new Error(`${p} missing — run \`node scripts/build-shell.mjs\` first`);
    }
  }
  // Cross-check the build manifest before staging anything: every entry file
  // must exist in shell/ with its recorded sha256 (a half-written or stale
  // build never reaches the dist tree).
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const [name, e] of Object.entries(manifest.entries)) {
    const p = path.join(srcShell, e.file);
    if (!fs.existsSync(p)) throw new Error(`manifest entry ${name} -> ${e.file} missing from shell/`);
    const got = sha256(p);
    if (got !== e.sha256) {
      throw new Error(`manifest/tree sha mismatch for ${e.file}: manifest ${e.sha256} != tree ${got} — rebuild`);
    }
  }

  const destShell = path.join(dist, "shell");
  if (!dryRun) fs.mkdirSync(destShell, { recursive: true });
  let copied = 0, skipped = 0;
  for (const name of fs.readdirSync(srcShell).sort()) {
    const src = path.join(srcShell, name);
    const dest = path.join(destShell, name);
    if (fs.existsSync(dest)) {
      if (sha256(dest) === sha256(src)) { skipped++; continue; }
      throw new Error(
        `CAS violation: ${dest} exists with different bytes than ${src} — ` +
          `hashed names must never collide; refusing to overwrite (corrupt dist or non-CAS name).`,
      );
    }
    if (!dryRun) fs.copyFileSync(src, dest);
    copied++;
  }
  if (!dryRun) {
    fs.copyFileSync(manifestPath, path.join(dist, "shell-manifest.json"));
    fs.copyFileSync(loaderPath, path.join(dist, "index-bundled.html"));
  }
  log(`${dryRun ? "[dry-run] " : ""}shell/: ${copied} copied, ${skipped} already present (CAS hits) -> ${destShell}`);
  log(`pointers: shell-manifest.json + index-bundled.html -> ${dist}/`);
  return { copied, skipped };
}

const isMain =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dist") opts.dist = path.resolve(argv[++i]);
    else if (argv[i] === "--from") opts.from = path.resolve(argv[++i]);
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--quiet") opts.quiet = true;
    else {
      console.error(`unknown arg ${argv[i]}\nusage: node scripts/deploy-shell.mjs --dist <dist-root> [--from <root>] [--dry-run]`);
      process.exit(2);
    }
  }
  try {
    deployShell(opts);
  } catch (e) {
    console.error(`[deploy-shell] FAIL: ${e.message}`);
    process.exit(1);
  }
}
