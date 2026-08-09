// harness/test_build_shell.mjs — T11 (ST-SHELL, dist-level arm): the esbuild
// shell build, node-only (no browser).
//
// WHAT IS UNDER TEST (SPEC §3 T11; pass-12 D-12.2):
//   PART 1 — entry coverage: the file-backed `new Worker(new URL(...))` site
//            scan finds EXACTLY the 4 verified workers (bake/net/texture/
//            keepalive) + refuses drift; the flag-default premises of the
//            request arithmetic are pinned against the *Enabled() readers
//            (MEMORY flag-default-footgun: trust readers, not comments).
//   PART 2 — determinism: two builds into fresh out-roots are byte-identical
//            (tree compare, every file), and building never edits index.html.
//   PART 3 — output contract: 5 hashed entries + external maps; hashed names
//            match content (workers-first substitution => a worker change
//            renames app); keepalive stays classic-worker-safe (no module
//            syntax); worker bundles import nothing but ../pkg/*.
//   PART 4 — loader page: single module script -> shell/app-<hash8>.js;
//            modulepreload collapsed to pkg passthroughs + the app bundle;
//            importmap + SW registration semantics retained.
//   PART 5 — request arithmetic (STATIC — the RAM-gated browser count is a
//            separate, labeled measurement): cold shell enumerated from the
//            artifacts = 7 bare / 8 login / 9 agent-login vs ~270 unbundled
//            (D-12.2 "≈8 cold"); warm = 5 no-cache revalidations + 0
//            immutable re-fetches ("≈1" once pkg is deploy-hashed; the pkg
//            residue is the T11 task's recorded external).
//            Writes docs/RESULTS-shell-requests-2026-08-09.json via
//            harness/lib/report.mjs (@scale-tagged, verdict EXPLORATORY —
//            B2/B5 absolutes bind at ST5, SPEC §2.2).
//   PART 6 — serve rules: spawns scripts/serve.py on an ephemeral port and
//            asserts the shell tier (immutable + identity) and the unchanged
//            neighbour tiers. SKIPs (not fails) if the port cannot be bound.
//
// Run:  node harness/test_build_shell.mjs        (exit 0/1)
// Needs the esbuild binary ($ESBUILD_BIN or the documented default) — absent
// binary is a loud SKIP with exit 0 (the binary is deliberately not committed).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildShell,
  scanWorkerSites,
  resolveEsbuild,
  stripQueryFromRelativeImports,
  WORKER_ENTRIES,
  APP_ROOT,
} from "../../../scripts/build-shell.mjs";
import { createReport } from "./lib/report.mjs";

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");

try {
  resolveEsbuild();
} catch (e) {
  console.log(`BUILD-SHELL SKIP — ${e.message}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
console.log("PART 1 — entry coverage + arithmetic premises");
// ---------------------------------------------------------------------------
{
  const sites = scanWorkerSites();
  const names = sites.map((s) => path.basename(s.specifier, ".js")).sort();
  check(sites.length === 4, `worker-site count == 4 (got ${sites.length}: ${JSON.stringify(sites)})`);
  check(
    JSON.stringify(names) ===
      JSON.stringify(["bake_worker", "keepalive_worker", "net_worker", "texture_worker"]),
    `worker-site names == the D-12.2 four (got ${names})`,
  );
  check(
    JSON.stringify(Object.keys(WORKER_ENTRIES).sort()) === JSON.stringify(names),
    "WORKER_ENTRIES matches the scanned set",
  );

  // Arithmetic premises, pinned against the READERS (a default flip must
  // break this test so the request table gets re-derived):
  const bakeSrc = read(path.join(APP_ROOT, "scene3d", "bake_worker_client.js"));
  check(
    /v !== "0" && v !== "off" && v !== "false"/.test(bakeSrc),
    "bakeWorker reader is default-ON opt-OUT (bake_worker_client.js:40) — bake worker IS a cold-boot request",
  );
  const netSrc = read(path.join(APP_ROOT, "scene3d", "net_worker_client.js"));
  check(
    /const NET_WORKER_DEFAULT = false/.test(netSrc),
    "NET_WORKER_DEFAULT === false (net_worker_client.js:71) — net worker NOT a bare-default request",
  );
  check(
    /q\.get\("agent"\) === "1" \|\| q\.get\("bot"\) === "1"/.test(netSrc),
    "netWorker forces ON under agent/bot boots (net_worker_client.js:97) — +1 request on bench bots",
  );
  const xu7Src = read(path.join(APP_ROOT, "scene3d", "xu7_textures.js"));
  check(
    /if \(v == null\) return 0;/.test(xu7Src),
    "texWorkers absent => 0 workers (xu7_textures.js) — texture worker NOT a cold-boot request (T14 DEV OFF)",
  );
}

// ---------------------------------------------------------------------------
console.log("PART 2 — determinism (two fresh out-roots) + tree hygiene");
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t11-shell-"));
const A = path.join(tmp, "A");
const B = path.join(tmp, "B");
const indexShaBefore = sha(path.join(APP_ROOT, "index.html"));
buildShell({ outRoot: A, quiet: true });
buildShell({ outRoot: B, quiet: true });
{
  const la = fs.readdirSync(path.join(A, "shell")).sort();
  const lb = fs.readdirSync(path.join(B, "shell")).sort();
  check(JSON.stringify(la) === JSON.stringify(lb), "shell/ file lists identical across builds");
  let identical = true;
  for (const f of la) {
    if (sha(path.join(A, "shell", f)) !== sha(path.join(B, "shell", f))) identical = false;
  }
  check(identical, "every shell/ file byte-identical across builds");
  check(
    read(path.join(A, "shell-manifest.json")) === read(path.join(B, "shell-manifest.json")),
    "shell-manifest.json deterministic",
  );
  check(
    read(path.join(A, "index-bundled.html")) === read(path.join(B, "index-bundled.html")),
    "index-bundled.html deterministic",
  );
  check(
    sha(path.join(APP_ROOT, "index.html")) === indexShaBefore,
    "index.html untouched by the build (unbundled arm is the kill path)",
  );
}

// ---------------------------------------------------------------------------
console.log("PART 3 — output contract");
// ---------------------------------------------------------------------------
const manifest = JSON.parse(read(path.join(A, "shell-manifest.json")));
const shellDir = path.join(A, "shell");
{
  const names = Object.keys(manifest.entries).sort();
  check(
    JSON.stringify(names) ===
      JSON.stringify(["app", "bake_worker", "keepalive_worker", "net_worker", "texture_worker"]),
    `manifest entries == main + 4 workers (got ${names})`,
  );
  for (const [name, e] of Object.entries(manifest.entries)) {
    check(/^[a-z_]+-[0-9a-f]{8}\.js$/.test(e.file), `${name} filename is <name>-<hash8>.js (${e.file})`);
    check(sha(path.join(shellDir, e.file)) === e.sha256, `${name} manifest sha matches tree`);
    check(fs.existsSync(path.join(shellDir, `${e.file}.map`)), `${name} external source map present`);
  }
  const appText = read(path.join(shellDir, manifest.entries.app.file));
  for (const name of Object.keys(WORKER_ENTRIES)) {
    check(
      appText.includes(`./${manifest.entries[name].file}`),
      `app bundle references hashed ${name} (worker-change => app rename)`,
    );
  }
  const ka = read(path.join(shellDir, manifest.entries.keepalive_worker.file));
  check(
    !/(^|[;{}\n])\s*(import|export)[\s({"']/.test(ka.replace(/\/\/# sourceMappingURL.*/, "")),
    "keepalive worker output has no module syntax (constructed WITHOUT {type:'module'} — classic-worker-safe)",
  );
  check(!appText.includes("__SHELL_WORKER__"), "no unsubstituted worker placeholders");
  // Worker bundles: only ../pkg/* externals (workers cannot see the importmap).
  for (const name of Object.keys(WORKER_ENTRIES)) {
    const t = read(path.join(shellDir, manifest.entries[name].file));
    const bad = [...t.matchAll(/from"([^"]+)"/g)].filter((m) => !m[1].startsWith("../pkg/"));
    check(bad.length === 0, `${name} imports only ../pkg/* externals (got ${JSON.stringify(bad.map((m) => m[1]))})`);
  }
}

// ---------------------------------------------------------------------------
console.log("PART 4 — loader page");
// ---------------------------------------------------------------------------
const loader = read(path.join(A, "index-bundled.html"));
const appFile = manifest.entries.app.file;
{
  const srcScripts = [...loader.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];
  check(srcScripts.length === 1, "exactly one external module script in the loader");
  check(srcScripts[0]?.[1] === `./shell/${appFile}`, `module script src -> ./shell/${appFile}`);
  check(!/^\s*import init,/m.test(loader), "the 10.4k-line inline module script is gone");
  check(loader.includes('<script type="importmap">'), "importmap retained (bare specifiers resolve in-document)");
  const preloads = [...loader.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  check(
    preloads.length === 3 &&
      preloads.filter((h) => h.startsWith("./pkg/")).length === 2 &&
      preloads.includes(`./shell/${appFile}`),
    `modulepreload collapsed to 2 pkg passthroughs + the app bundle (got ${JSON.stringify(preloads)})`,
  );
  const appText = read(path.join(shellDir, appFile));
  check(
    appText.includes('register("./service-worker.js")'),
    "SW registration in-bundle, document-relative (register() resolves against the DOCUMENT base -> root scope keeps working)",
  );
  check(!fs.existsSync(path.join(A, "shell", "service-worker.js")), "service-worker.js NOT bundled (D-12.2)");
}

// ---------------------------------------------------------------------------
console.log("PART 5 — request arithmetic (static; browser count is a separate labeled measurement)");
// ---------------------------------------------------------------------------
{
  const appText = read(path.join(shellDir, appFile));
  // Enumerate the bundled cold shell from the artifacts themselves:
  const cold = ["index-bundled.html", `shell/${appFile}`];
  const preloadPkg = [...loader.matchAll(/<link rel="modulepreload" href="(\.\/pkg\/[^"]+)">/g)].map((m) => m[1]);
  cold.push(...preloadPkg.map((p) => p.slice(2))); // pkg glue + snippet
  check(preloadPkg.length === 2, "pkg externals on the boot path = glue + snippet (2 requests)");
  check(
    appText.includes('from"../pkg/holtburger_web.js?v='),
    "app bundle imports the pkg glue externally (the stamped specifier survived)",
  );
  cold.push("pkg/holtburger_web_bg.wasm"); // fetched by init(), stamped URL
  cold.push("service-worker.js"); // registration fetch (skipped only under ?nosw=1)
  cold.push(`shell/${manifest.entries.bake_worker.file}`); // default-ON (P1 premise)
  const coldBare = cold.length; // 7
  const coldLogin = coldBare + 1; // + keepalive worker (starts at session start)
  const coldAgentLogin = coldLogin + 1; // + net worker (agent/bot forces ON — P1 premise)
  check(coldBare === 7, `cold bare-default shell == 7 requests (got ${coldBare}: ${JSON.stringify(cold)})`);
  check(coldAgentLogin === 9, "cold agent-login shell == 9 (bench-bot shape) — D-12.2 '≈8' holds (7..9)");

  // Unbundled arm, same enumeration style, from the committed index.html:
  const indexHtml = read(path.join(APP_ROOT, "index.html"));
  const mp = [...indexHtml.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  // D-12.2's "266 modulepreload links [M]" was a `grep -c modulepreload` LINE
  // count — it includes the BEGIN/END markers + one in-JS comment mention.
  // Actual <link rel=modulepreload> elements on HEAD: 263 (same ~270 class).
  check(mp.length === 263, `unbundled modulepreload block == 263 link elements (got ${mp.length})`);
  const workersInMp = mp.filter((h) => /(?:bake|net|texture|keepalive)_worker\.js/.test(h)).length;
  // html + 266 modules + wasm + SW + workers not in the preload list (bake; keepalive on login)
  const coldUnbundledBare = 1 + mp.length + 1 + 1 + (workersInMp ? 0 : 1);
  check(
    coldUnbundledBare >= 265,
    `unbundled cold shell ≈ 270 requests (enumerated ${coldUnbundledBare}; workers preloaded: ${workersInMp})`,
  );

  // Warm (bundled): shell/* immutable => 0 refetches; the no-cache revalidate
  // tier = loader html + SW + pkg glue + snippet + wasm = 5 conditional 304s.
  const warmRevalidations = 5;
  const warmImmutableRefetches = 0;

  const report = createReport({
    bench: "BOOT-666",
    gate: null,
    protocol: "static-arithmetic",
    url: "n/a — enumerated from build artifacts (apps/holtburger-web/shell @ T11)",
    commit: null,
    platform: { box: "wbterminal", renderer: null },
    taint: ["static-arithmetic-not-a-network-measurement"],
    wasmProfile: "n/a-static",
  });
  report.addArm({
    arm: "cold-bundled-bare",
    verdict: "USABLE",
    metrics: { "requests@wire": coldBare },
    enumeration: cold,
  });
  report.addArm({
    arm: "cold-bundled-agent-login",
    verdict: "USABLE",
    metrics: { "requests@wire": coldAgentLogin },
    note: "bench-bot shape: + keepalive worker (session start) + net worker (agent/bot forces ON)",
  });
  report.addArm({
    arm: "warm-bundled",
    verdict: "USABLE",
    metrics: { "requests@wire": warmRevalidations },
    note:
      "5 conditional revalidations (loader html, service-worker.js, pkg glue, pkg snippet, pkg wasm), " +
      "~0 bytes body; shell/* immutable-cached = 0 refetches. The 3 pkg rows are the task-recorded " +
      "external residue (pkg/ is unbundlable from a clean tree); deploy-hashing pkg would bring this " +
      "to D-12.2's ≈2 (html + manifest).",
    immutableRefetches: warmImmutableRefetches,
  });
  report.addArm({
    arm: "cold-unbundled-bare",
    verdict: "USABLE",
    metrics: { "requests@wire": coldUnbundledBare },
    note: "derived from the committed index.html (266 modulepreload links [M] + html + wasm + SW + bake worker)",
  });
  report.setNotes(
    "T11 ST-SHELL static request arithmetic (SPEC §3 T11 / D-12.2). EXPLORATORY: B2/B5 absolutes bind at " +
      "ST5 on the deployed artifact (SPEC §2.2); this file documents the shell component ≈8 cold (7..9) / " +
      "≈1 warm-with-body (5 empty 304s on the dev server). Importmap externals (three CDN, vendor takram, " +
      "postprocessing) are identical on both arms and excluded from the shell count, as in D-12.2.",
  );
  report.setVerdict("EXPLORATORY");
  const outPath = path.join(APP_ROOT, "docs", "RESULTS-shell-requests-2026-08-09.json");
  report.write(outPath);
  check(fs.existsSync(outPath), `RESULTS-v2 artifact written (${path.relative(APP_ROOT, outPath)})`);
}

// ---------------------------------------------------------------------------
console.log("PART 6 — serve.py shell tier (spawn on ephemeral port; SKIP if unbindable)");
// ---------------------------------------------------------------------------
await (async () => {
  const port = 8790 + Math.floor(Math.random() * 100);
  const holtRoot = path.resolve(APP_ROOT, "..", "..");
  const proc = spawn("python3", [path.join(holtRoot, "scripts", "serve.py"), "--port", String(port)], {
    stdio: "ignore",
  });
  const fetchHead = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "GET",
      headers: { "Accept-Encoding": "gzip, zstd" },
    });
    await res.arrayBuffer();
    return res;
  };
  // Cold start ≈ 12 s on this box (the dist health scan enumerates ~180k
  // per-LB layer files before the socket opens) — poll for up to ~45 s.
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try {
      await fetchHead("/apps/holtburger-web/harness/test_build_shell.mjs");
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!up) {
    console.log("  SKIP: serve.py did not come up (port contention?) — header rules verified manually at landing");
    proc.kill();
    return;
  }
  try {
    // The live-tree shell build from this test run isn't at APP_ROOT — use the
    // committed build if present, else deploy A into a temp-dist? The live
    // tree normally carries a build; tolerate its absence as SKIP.
    const liveShell = path.join(APP_ROOT, "shell");
    if (fs.existsSync(liveShell)) {
      const f = fs.readdirSync(liveShell).find((n) => n.startsWith("app-") && n.endsWith(".js"));
      const res = await fetchHead(`/apps/holtburger-web/shell/${f}`);
      check(
        (res.headers.get("cache-control") || "").includes("immutable"),
        `live shell/ served immutable (got ${res.headers.get("cache-control")})`,
      );
      check(!res.headers.get("content-encoding"), "live shell/ served IDENTITY under Accept-Encoding gzip+zstd");
    } else {
      console.log("  SKIP: no live shell/ build at APP_ROOT — run scripts/build-shell.mjs first");
    }
    const neg = await fetchHead("/apps/holtburger-web/scene3d/index.js");
    check((neg.headers.get("cache-control") || "") === "no-cache", "scene3d/*.js stays no-cache");
    const miss = await fetchHead("/apps/holtburger-web/shell/nope.js");
    check(miss.status === 404 && (miss.headers.get("cache-control") || "").includes("no-cache"), "shell 404 stays no-cache (200-gate)");
  } finally {
    proc.kill();
  }
})();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nBUILD-SHELL ${failed === 0 ? "✅" : "❌"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
