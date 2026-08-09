#!/usr/bin/env node
// scripts/build-shell.mjs — T11 ST-SHELL: bundle + content-hash the app shell
// (SPEC.md §0.2.2 / §3 T11; pass-12 D-12.2).
//
// WHAT THIS BUILDS
// ----------------
// The deployed/benched app shell for apps/holtburger-web: the ~270-request
// unbundled module tree (266 modulepreload links + the ~10.4k-line inline
// <script type="module"> in index.html) is bundled by esbuild into
// content-hashed files under apps/holtburger-web/shell/:
//
//   shell/app-<hash8>.js              main app (the inline module script's graph)
//   shell/bake_worker-<hash8>.js      \
//   shell/net_worker-<hash8>.js        | the 4 read-verified
//   shell/texture_worker-<hash8>.js    | `new Worker(new URL(...))` entries
//   shell/keepalive_worker-<hash8>.js /
//   shell/*.js.map                    external source maps (not on the boot path)
//
// plus a loader page `index-bundled.html` (index.html with the inline module
// script swapped for `<script type=module src=./shell/app-<hash8>.js>` and the
// modulepreload block collapsed) and a build manifest `shell-manifest.json`.
// All three land at the app root and are gitignored build output.
//
// THE ARM IS DIST-LEVEL (no client runtime flag): the bundled arm is opened via
// index-bundled.html; the untouched index.html remains the unbundled kill path
// (K3-class repoint — SPEC §3 T11 "Kill"). This script only READS index.html /
// scene3d / plugins / ui; it never edits tracked sources.
//
// WHAT STAYS EXTERNAL (and why)
// -----------------------------
// - pkg/ (wasm glue + snippets + .wasm): gitignored wasm-pack output — it does
//   not exist in a clean tree at build time, so it CANNOT be bundled (T11 task
//   directive). Imports are kept external and re-based ./pkg/ -> ../pkg/ so
//   they resolve from shell/. Counted in the request arithmetic.
// - every importmap key (three, three/addons/, @takram/*, postprocessing,
//   tiny-invariant, @dgreenheck/three-pinata): resolved by the browser via the
//   importmap retained in the loader page — identical on both arms.
// - service-worker.js: explicitly NOT bundled (D-12.2 — SW scope rules; it is
//   a stable-name no-cache root file).
//
// BUILD-TIME SOURCE TRANSFORMS (staging copies only — .shell-build/, never the
// tree):
//   1. `?v=...` cache-buster queries are stripped from RELATIVE import
//      specifiers that are not pkg/ imports (esbuild cannot resolve
//      "./terrain.js?v=phase-d-batch" to a file). NOTE the recorded behavioral
//      delta: today the browser treats "./statics.js" and
//      "./statics.js?v=phase7-par" as DISTINCT module instances (both exist on
//      HEAD: statics.js, buildings.js, scene3d/index.js); the bundle collapses
//      each pair to one instance, as any bundler must (see task-T11-report).
//   2. the 4 worker `new URL("./x.js", import.meta.url)` sites become
//      placeholders substituted post-bundle with the hashed sibling filenames.
//   3. remaining scene3d `new URL("./X", import.meta.url)` asset bases (e.g.
//      "./assets/moons/", "./transcoder/") are re-based to "../scene3d/X" —
//      import.meta.url of the bundle is .../shell/app-<hash8>.js, and shell/
//      is a sibling of scene3d/, so "../scene3d/" restores today's meaning.
//      "../X" bases (../pkg/, ../assets/, ../data/) already resolve
//      identically from shell/ and pass through untouched.
//   4. the extracted entry's `from "./pkg/..."` imports become "../pkg/...".
//
// HASHING: sha256(content minus the sourceMappingURL line), first 8 hex chars.
// Workers are hashed first; their hashed names are substituted into the app
// bundle BEFORE the app is hashed, so a worker-only change renames the app
// file too (immutable-cache correctness). Fully deterministic: no timestamps,
// fixed esbuild flags, relative source-map paths.
//
// ESBUILD BINARY (no npm — D-12.2 "single static binary"): looked up via
//   $ESBUILD_BIN, default /mnt/wbterminal2/reeng/T11/bin/esbuild
// The binary is NOT committed. To (re)install: download the official
// @esbuild/linux-x64 tarball from registry.npmjs.org and copy package/bin/
// esbuild there (see scripts/README.md). Built + verified against esbuild
// 0.28.2 (binary sha256 e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4
// beb0b1884100).
//
// USAGE
//   node scripts/build-shell.mjs [--out-root <dir>] [--keep-stage] [--quiet]
//
// Serve rules for shell/ (immutable CAS tier, identity encoding) live in
// scripts/serve.py; staging into the dist tree is scripts/deploy-shell.mjs.
// Tests: apps/holtburger-web/harness/test_build_shell.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOLT_ROOT = path.resolve(SCRIPT_DIR, "..");
export const APP_ROOT = path.join(HOLT_ROOT, "apps", "holtburger-web");
export const ESBUILD_DEFAULT = "/mnt/wbterminal2/reeng/T11/bin/esbuild";

/** The verified worker-entry set (read-verified on HEAD, 2026-08-09):
 *  bake_worker_client.js:795, net_worker_client.js:136,
 *  keepalive_worker_client.js:66, xu7_textures.js:780 (T14).
 *  D-12.2 wrote "main + 4 workers" naming exactly these; the coverage scan
 *  below FAILS the build if the tree ever grows a 5th file-backed site. */
export const WORKER_ENTRIES = Object.freeze({
  bake_worker: "scene3d/bake_worker.js",
  net_worker: "scene3d/net_worker.js",
  texture_worker: "scene3d/texture_worker.js",
  keepalive_worker: "scene3d/keepalive_worker.js",
});

const BUNDLED_DIRS = ["scene3d", "plugins", "ui", "rynth"];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function resolveEsbuild() {
  const bin = process.env.ESBUILD_BIN || ESBUILD_DEFAULT;
  let version = null;
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (r.status === 0) version = r.stdout.trim();
  } catch {
    /* fall through */
  }
  if (!version) {
    throw new Error(
      `esbuild binary not runnable at ${bin} — set $ESBUILD_BIN or install the ` +
        `official static binary there (scripts/README.md "esbuild (T11)" has the recipe; ` +
        `the binary is deliberately NOT committed).`,
    );
  }
  return { bin, version };
}

function* walkFiles(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p);
    else if (ent.isFile()) yield p;
  }
}

/** Extract the single inline `<script type="module">` block from index.html.
 *  Returns { before, inner, after } (before includes the opening tag's line
 *  start; after begins right after the closing </script>). */
export function extractInlineModuleScript(html) {
  const opens = [...html.matchAll(/<script\b([^>]*)>/g)];
  const hits = opens.filter(
    (m) => /type\s*=\s*["']module["']/.test(m[1]) && !/\bsrc\s*=/.test(m[1]),
  );
  if (hits.length === 0) {
    throw new Error("no inline <script type=\"module\"> found in index.html");
  }
  const open = hits[0];
  const bodyStart = open.index + open[0].length;
  const closeIdx = html.indexOf("</script>", bodyStart);
  if (closeIdx < 0) throw new Error("unterminated inline module script");
  // Later "matches" INSIDE the first block's body are JS text (e.g. the
  // `// <script type="module">;` comment at index.html:2061), not tags; a
  // candidate AFTER the block would be a real second script — refuse it.
  const outside = hits.slice(1).filter((m) => m.index >= closeIdx);
  if (outside.length) {
    throw new Error(
      `found ${outside.length} additional inline <script type="module"> after the ` +
        `first block — the T11 single-entry extraction contract changed; re-verify.`,
    );
  }
  return {
    start: open.index,
    end: closeIdx + "</script>".length,
    inner: html.slice(bodyStart, closeIdx),
  };
}

/** Importmap keys -> esbuild --external patterns (keys ending "/" become
 *  prefix wildcards, e.g. "three/addons/" -> "three/addons/*"). */
export function extractImportmapExternals(html) {
  const m = html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
  if (!m) throw new Error("importmap script not found in index.html");
  const keys = Object.keys(JSON.parse(m[1]).imports);
  return keys.map((k) => (k.endsWith("/") ? `${k}*` : k));
}

/** Scan sources for file-backed `new Worker(new URL("./x.js", import.meta.url))`
 *  sites. Returns [{file, specifier}]. The Blob-URL worker in
 *  pack_fetch_controller.js (no `new URL`) is deliberately out of scope. */
export function scanWorkerSites(appRoot = APP_ROOT) {
  const sites = [];
  const re =
    /new\s+Worker\s*\(\s*new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
  const files = [];
  for (const dir of BUNDLED_DIRS) files.push(...walkFiles(path.join(appRoot, dir)));
  for (const file of files) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      sites.push({ file: path.relative(appRoot, file), specifier: m[2] });
    }
    if (/new\s+SharedWorker\s*\(/.test(text)) {
      throw new Error(`unexpected SharedWorker construction in ${file} — T11 entry set is stale`);
    }
  }
  const html = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");
  for (const m of extractInlineModuleScript(html).inner.matchAll(re)) {
    sites.push({ file: "index.html(inline)", specifier: m[2] });
  }
  return sites;
}

function assertWorkerCoverage(appRoot) {
  const sites = scanWorkerSites(appRoot);
  const found = new Set(
    sites.map((s) => path.basename(s.specifier.split("?")[0], ".js")),
  );
  const expected = new Set(Object.keys(WORKER_ENTRIES));
  const missing = [...expected].filter((n) => !found.has(n));
  const extra = [...found].filter((n) => !expected.has(n));
  if (missing.length || extra.length) {
    throw new Error(
      `worker-entry coverage drift: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} ` +
        `(sites: ${JSON.stringify(sites)}). Update WORKER_ENTRIES + D-12.2 arithmetic together.`,
    );
  }
  return sites;
}

// ---------------------------------------------------------------------------
// staging transforms
// ---------------------------------------------------------------------------

/** Strip `?v=...` cache busters from RELATIVE, non-pkg import specifiers in
 *  the three syntactic positions (from-clause, bare import, dynamic import).
 *  pkg/ specifiers keep their query — pkg is external and the stamp is
 *  load-bearing for its staleness contract. */
export function stripQueryFromRelativeImports(text) {
  const fix = (spec) =>
    spec.startsWith(".") && spec.includes("?") && !spec.includes("pkg/")
      ? spec.slice(0, spec.indexOf("?"))
      : spec;
  return text
    .replace(/(\bfrom\s*)(["'])([^"']+)\2/g, (a, p, q, s) => `${p}${q}${fix(s)}${q}`)
    .replace(/(\bimport\s*)(["'])([^"']+)\2/g, (a, p, q, s) => `${p}${q}${fix(s)}${q}`)
    .replace(/(\bimport\s*\(\s*)(["'])([^"']+)\2/g, (a, p, q, s) => `${p}${q}${fix(s)}${q}`);
}

/** scene3d-only: placeholder the worker URL sites, then re-base remaining
 *  "./" import.meta.url URLs onto "../scene3d/". */
function transformScene3dUrls(text) {
  let out = text;
  for (const name of Object.keys(WORKER_ENTRIES)) {
    out = out.replace(
      new RegExp(
        `new URL\\(\\s*(["'])\\./${name}\\.js\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`,
        "g",
      ),
      (m, q) => `new URL(${q}__SHELL_WORKER__${name}__${q}, import.meta.url)`,
    );
  }
  out = out.replace(
    /new URL\(\s*(["'])\.\/([^"']*)\1\s*,\s*import\.meta\.url/g,
    (m, q, rest) => `new URL(${q}../scene3d/${rest}${q}, import.meta.url`,
  );
  return out;
}

/** Entry-only: re-base pkg imports for a shell/-resident output. */
export function rebaseEntryPkgImports(text) {
  return text
    .replace(/(\bfrom\s*)(["'])\.\/pkg\//g, (a, p, q) => `${p}${q}../pkg/`)
    .replace(/(\bimport\s*)(["'])\.\/pkg\//g, (a, p, q) => `${p}${q}../pkg/`)
    .replace(/(\bimport\s*\(\s*)(["'])\.\/pkg\//g, (a, p, q) => `${p}${q}../pkg/`);
}

function stageTree(appRoot, stageSrc) {
  for (const dir of BUNDLED_DIRS) {
    for (const file of walkFiles(path.join(appRoot, dir))) {
      if (!/\.(js|mjs|cjs)$/.test(file)) continue;
      const rel = path.relative(appRoot, file);
      let text = fs.readFileSync(file, "utf8");
      text = stripQueryFromRelativeImports(text);
      if (rel.startsWith("scene3d" + path.sep)) text = transformScene3dUrls(text);
      const dest = path.join(stageSrc, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export function buildShell(opts = {}) {
  const appRoot = opts.appRoot || APP_ROOT;
  const outRoot = opts.outRoot || appRoot;
  const quiet = !!opts.quiet;
  const log = (...a) => { if (!quiet) console.log("[build-shell]", ...a); };

  const { bin, version } = resolveEsbuild();
  const html = fs.readFileSync(path.join(appRoot, "index.html"), "utf8");
  const externals = [...extractImportmapExternals(html), "../pkg/*", "./pkg/*"];
  const workerSites = assertWorkerCoverage(appRoot);

  // -- stage ----------------------------------------------------------------
  const stage = path.join(outRoot, ".shell-build");
  const stageSrc = path.join(stage, "src");
  const stageOut = path.join(stage, "out");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stageSrc, { recursive: true });
  stageTree(appRoot, stageSrc);

  const script = extractInlineModuleScript(html);
  const entryText = rebaseEntryPkgImports(stripQueryFromRelativeImports(script.inner));
  fs.writeFileSync(path.join(stageSrc, "app.mjs"), entryText);

  // -- esbuild --------------------------------------------------------------
  const entries = [
    "app=app.mjs",
    ...Object.entries(WORKER_ENTRIES).map(([n, p]) => `${n}=${p}`),
  ];
  const args = [
    ...entries,
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--target=es2022",
    "--charset=utf8",
    `--outdir=${path.relative(stageSrc, stageOut)}`,
    "--entry-names=[name]",
    "--sourcemap=linked",
    "--minify-whitespace",
    "--minify-syntax",
    `--metafile=${path.relative(stageSrc, path.join(stage, "meta.json"))}`,
    ...externals.map((e) => `--external:${e}`),
  ];
  const r = spawnSync(bin, args, { cwd: stageSrc, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(stage, "esbuild.log"), `${r.stdout || ""}\n${r.stderr || ""}`);
  if (r.status !== 0) {
    throw new Error(`esbuild failed (status ${r.status}):\n${r.stderr || r.stdout}`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(stage, "meta.json"), "utf8"));

  // -- metafile guards: worker graphs must stay importmap-free --------------
  const outKey = (n) => Object.keys(meta.outputs).find((k) => k.endsWith(`/${n}.js`) || k === `${n}.js`);
  for (const name of Object.keys(WORKER_ENTRIES)) {
    const o = meta.outputs[outKey(name)];
    const bad = (o.imports || []).filter(
      (i) => i.kind !== "sourcemap" && !i.path.startsWith("../pkg/") && !i.path.startsWith("./pkg/"),
    );
    if (bad.length) {
      throw new Error(
        `worker bundle ${name} has non-pkg external imports ${JSON.stringify(bad)} — ` +
          `workers cannot use the document importmap; this would break at runtime.`,
      );
    }
  }

  // -- hash + substitute + emit --------------------------------------------
  const shellDir = path.join(outRoot, "shell");
  fs.rmSync(shellDir, { recursive: true, force: true });
  fs.mkdirSync(shellDir, { recursive: true });

  const SM_RE = /\n?\/\/# sourceMappingURL=.*\n?$/;
  const emitted = {}; // name -> { file, sha256, bytes }
  const emit = (name, content) => {
    const body = content.replace(SM_RE, "");
    const full = sha256Hex(body);
    const file = `${name}-${full.slice(0, 8)}.js`;
    const map = JSON.parse(fs.readFileSync(path.join(stageOut, `${name}.js.map`), "utf8"));
    map.file = file;
    const final = `${body}\n//# sourceMappingURL=${file}.map\n`;
    fs.writeFileSync(path.join(shellDir, file), final);
    fs.writeFileSync(path.join(shellDir, `${file}.map`), JSON.stringify(map));
    emitted[name] = { file, sha256: sha256Hex(final), bytes: Buffer.byteLength(final) };
    return file;
  };

  for (const name of Object.keys(WORKER_ENTRIES)) {
    emit(name, fs.readFileSync(path.join(stageOut, `${name}.js`), "utf8"));
  }
  let appText = fs.readFileSync(path.join(stageOut, "app.js"), "utf8");
  for (const name of Object.keys(WORKER_ENTRIES)) {
    const before = appText;
    appText = appText.replaceAll(`__SHELL_WORKER__${name}__`, `./${emitted[name].file}`);
    if (appText === before) {
      throw new Error(
        `worker placeholder for ${name} absent from app bundle — the client-site ` +
          `rewrite failed; see .shell-build/src for the staged sources.`,
      );
    }
  }
  if (appText.includes("__SHELL_WORKER__")) {
    throw new Error("unsubstituted __SHELL_WORKER__ placeholder left in app bundle");
  }
  emit("app", appText);

  // -- output guards --------------------------------------------------------
  // Any surviving `new URL("./..., import.meta.url)` must be one of our hashed
  // worker names — anything else would silently re-base against shell/.
  const okLocal = new Set(Object.values(emitted).map((e) => `./${e.file}`));
  for (const { file } of Object.values(emitted)) {
    const text = fs.readFileSync(path.join(shellDir, file), "utf8");
    for (const m of text.matchAll(/new URL\(\s*(["'])(\.\/[^"']*)\1\s*,\s*import\.meta\.url/g)) {
      if (!okLocal.has(m[2])) {
        throw new Error(
          `unrewritten shell-relative URL ${m[2]} in ${file} — a new ` +
            `import.meta.url-relative site appeared; extend the T11 rewrite table.`,
        );
      }
    }
  }

  // -- shell manifest (deterministic — no timestamps) -----------------------
  const manifest = {
    schema: "hb-shell-manifest-v1",
    tool: { name: "esbuild", version },
    entries: emitted,
    externals,
    workerSites,
    entrySourceSha256: sha256Hex(script.inner),
  };
  fs.writeFileSync(
    path.join(outRoot, "shell-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // -- loader page ----------------------------------------------------------
  const appHref = `./shell/${emitted.app.file}`;
  const mpBegin = html.indexOf("<!-- BEGIN modulepreload");
  const mpEnd = html.indexOf("<!-- END modulepreload -->");
  if (mpBegin < 0 || mpEnd < 0) throw new Error("modulepreload markers not found in index.html");
  const mpBlock = html.slice(mpBegin, mpEnd);
  const pkgPreloads = mpBlock
    .split("\n")
    .filter((l) => l.includes('href="./pkg/'))
    .map((l) => l.trim());
  const newPreload = [
    "<!-- BEGIN modulepreload (BUNDLED ARM — generated by scripts/build-shell.mjs; the",
    "         unbundled index.html keeps the full generated block) -->",
    ...pkgPreloads.map((l) => `    ${l}`),
    `    <link rel="modulepreload" href="${appHref}">`,
    "    ",
  ].join("\n");
  let bundled = html.slice(0, mpBegin) + newPreload + html.slice(mpEnd);

  const script2 = extractInlineModuleScript(bundled);
  bundled =
    bundled.slice(0, script2.start) +
    `<!-- T11 ST-SHELL loader (generated by scripts/build-shell.mjs — do not edit).\n` +
    `         Kill path: open index.html (unbundled tree, byte-identical boot). -->\n` +
    `    <script type="module" src="${appHref}"></script>` +
    bundled.slice(script2.end);
  fs.writeFileSync(path.join(outRoot, "index-bundled.html"), bundled);

  if (!opts.keepStage) fs.rmSync(stage, { recursive: true, force: true });

  log(`esbuild ${version}`);
  for (const [n, e] of Object.entries(emitted)) {
    log(`  shell/${e.file}  ${(e.bytes / 1024).toFixed(0)} KB  (${n})`);
  }
  log(`  index-bundled.html + shell-manifest.json written under ${outRoot}`);
  return { emitted, manifest, outRoot };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-root") opts.outRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--keep-stage") opts.keepStage = true;
    else if (argv[i] === "--quiet") opts.quiet = true;
    else {
      console.error(`unknown arg ${argv[i]}\nusage: node scripts/build-shell.mjs [--out-root <dir>] [--keep-stage] [--quiet]`);
      process.exit(2);
    }
  }
  try {
    buildShell(opts);
  } catch (e) {
    console.error(`[build-shell] FAIL: ${e.message}`);
    process.exit(1);
  }
}
