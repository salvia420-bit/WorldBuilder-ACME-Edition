// harness/test_gate_browser_smokes.mjs — Tier-5 test for the JS gate's
// COVERAGE GUARD over the browser smokes (test-tooling-1, 2026-10-13).
//
// The 8 root `test_*_gpu.cjs` SwiftShader shader smokes and
// harness/glsl_smoke/light_loops_smoke.mjs sat outside every pattern
// harness/run-js-headless.mjs scanned (root `test_*.mjs` only), so they ran in
// no gate and the guard written for "exists but never executes" never said
// so. They are now scanned and listed in NEEDS_BROWSER (printed, never run by
// the Node gate). This suite drives the REAL runner in its `--coverage` /
// `--list` modes — a readdir and a print, no suite runs, no heavy lock, no
// browser:
//
//   1  real tree: the NEEDS-BROWSER lines name exactly the on-disk root
//      `test_*.cjs` + harness/glsl_smoke/*_smoke.mjs files, every listed file
//      exists, and none of them is UNREGISTERED or QUARANTINED (so
//      --run-quarantined can never launch a browser)
//   2  real tree: none of them is in the executed plan (`--list`)
//   3  a copy of the runner over a temp tree: an UNLISTED root
//      `test_*_gpu.cjs` and an unlisted glsl_smoke `*_smoke.mjs` are
//      UNREGISTERED (exit 1) — the widened scan sees them — while a listed
//      smoke and a non-matching page are not; the old root `test_*.mjs`
//      pattern still fires
//   4  the same temp tree holding only a listed smoke exits 0
//
// Pure Node. Run: node harness/test_gate_browser_smokes.mjs — exit 0/1.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const RUNNER_REL = "harness/run-js-headless.mjs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};

// The runner's own env, minus anything that could make a mode take the lock.
const ENV = { ...process.env, HB_HEAVY_LOCK: "0" };

function runRunner(root, args) {
  const r = spawnSync(process.execPath, [path.join(root, RUNNER_REL), ...args], {
    cwd: root, encoding: "utf8", env: ENV, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, error: r.error };
}

/** `  TAG...: <file> — why` lines → file paths. */
function filesTagged(out, tag) {
  const re = new RegExp(`^  ${tag}[^:]*: (\\S+)`, "gm");
  return [...out.matchAll(re)].map((m) => m[1]);
}

/** The browser-smoke patterns, read independently of the runner. */
function browserSmokesOnDisk(root) {
  const list = (dir, re) => {
    try { return readdirSync(path.join(root, dir)).filter((n) => re.test(n)).map((n) => (dir ? `${dir}/${n}` : n)); }
    catch (_) { return []; }
  };
  return [...list("", /^test_.*\.cjs$/), ...list("harness/glsl_smoke", /_smoke\.mjs$/)].sort();
}

const isBrowserSmoke = (f) => /^test_[^/]*\.cjs$/.test(f) || /^harness\/glsl_smoke\/[^/]*_smoke\.mjs$/.test(f);

// ---- 1 + 2: the real tree ---------------------------------------------------
{
  const cov = runRunner(APP_ROOT, ["--coverage"]);
  ok(!cov.error && (cov.code === 0 || cov.code === 1), `1: --coverage ran (exit ${cov.code}${cov.error ? `, ${cov.error.message}` : ""})`);
  ok(/--coverage: \d+ unregistered/.test(cov.out), "1: --coverage printed its summary line");
  ok(!/heavy-lock:/.test(cov.out), "1: --coverage took no heavy lock");

  const listed = filesTagged(cov.out, "NEEDS-BROWSER").sort();
  const onDisk = browserSmokesOnDisk(APP_ROOT);
  ok(onDisk.length >= 9, `1: found the browser smokes on disk (${onDisk.length})`);
  ok(JSON.stringify(listed) === JSON.stringify(onDisk),
    `1: NEEDS-BROWSER lists exactly the on-disk smokes\n      listed : ${listed.join(", ")}\n      on disk: ${onDisk.join(", ")}`);
  for (const f of listed) ok(existsSync(path.join(APP_ROOT, f)), `1: listed smoke exists: ${f}`);
  ok(/NEEDS-BROWSER \(not run here\): test_particle_fx_gpu\.cjs — .*capped-build, one tab/.test(cov.out),
    "1: a NEEDS-BROWSER line says how to run it (capped-build, one tab)");

  const unregisteredSmokes = filesTagged(cov.out, "UNREGISTERED").filter(isBrowserSmoke);
  ok(unregisteredSmokes.length === 0, `1: no browser smoke is UNREGISTERED (${unregisteredSmokes.join(", ")})`);
  const quarantinedSmokes = filesTagged(cov.out, "QUARANTINED").filter(isBrowserSmoke);
  ok(quarantinedSmokes.length === 0, `1: no browser smoke is QUARANTINED (${quarantinedSmokes.join(", ")})`);

  const plan = runRunner(APP_ROOT, ["--list"]);
  ok(plan.code === 0, `2: --list exits 0 (${plan.code})`);
  ok(/\btier[0-9]/.test(plan.out), "2: --list printed the plan");
  const planned = onDisk.filter((f) => plan.out.includes(` ${f} `) || plan.out.includes(` ${f}\n`));
  ok(planned.length === 0, `2: no browser smoke is in the executed plan (${planned.join(", ")})`);
}

// ---- 3 + 4: a copy of the runner over a temp tree ---------------------------
const BASE = mkdtempSync(path.join(os.tmpdir(), "hb-gate-browser-smokes-"));
try {
  const fakeTree = (name, files) => {
    const root = path.join(BASE, name);
    mkdirSync(path.join(root, "harness"), { recursive: true });
    cpSync(path.join(APP_ROOT, RUNNER_REL), path.join(root, RUNNER_REL));
    cpSync(path.join(HERE, "lib"), path.join(root, "harness", "lib"), { recursive: true });
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), "// fixture: never executed\n");
    }
    return root;
  };

  const probe = fakeTree("probe", [
    "test_particle_fx_gpu.cjs",               // listed in NEEDS_BROWSER
    "test_zz_probe_gpu.cjs",                  // unlisted root smoke
    "harness/glsl_smoke/zz_probe_smoke.mjs",  // unlisted glsl smoke
    "harness/glsl_smoke/zz_probe_page.html",  // a page, not a suite
    "test_zz_probe_node.mjs",                 // the original root pattern
  ]);
  const r3 = runRunner(probe, ["--coverage"]);
  const unreg = filesTagged(r3.out, "UNREGISTERED");
  ok(r3.code === 1, `3: unlisted smokes fail --coverage (exit ${r3.code})`);
  ok(unreg.includes("test_zz_probe_gpu.cjs"), "3: an unlisted root test_*.cjs is UNREGISTERED");
  ok(unreg.includes("harness/glsl_smoke/zz_probe_smoke.mjs"), "3: an unlisted harness/glsl_smoke/*_smoke.mjs is UNREGISTERED");
  ok(unreg.includes("test_zz_probe_node.mjs"), "3: the root test_*.mjs pattern still fires");
  ok(!unreg.includes("test_particle_fx_gpu.cjs"), "3: a NEEDS_BROWSER smoke is not UNREGISTERED");
  ok(!unreg.some((f) => f.endsWith(".html")), "3: a glsl_smoke page is not a suite");

  const clean = fakeTree("clean", ["test_particle_fx_gpu.cjs", "harness/glsl_smoke/light_loops_smoke.mjs"]);
  const r4 = runRunner(clean, ["--coverage"]);
  ok(r4.code === 0, `4: only listed smokes → --coverage exits 0 (exit ${r4.code})\n${r4.out}`);
  ok(/--coverage: 0 unregistered/.test(r4.out), "4: 0 unregistered");
} finally {
  rmSync(BASE, { recursive: true, force: true });
}

console.log(`gate-browser-smokes: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("GATE-BROWSER-SMOKES ✅");
  process.exit(0);
} else {
  console.error("GATE-BROWSER-SMOKES ❌");
  process.exit(1);
}
