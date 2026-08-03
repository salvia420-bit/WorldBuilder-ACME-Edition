#!/usr/bin/env node
// harness/run-js-headless.mjs — pure-Node (NO browser) flag-harness runner.
//
// ============================================================================
// Runs the existing already-green Tier-1 JS unit tests PLUS the two NEW Tier-4
// tests, each as its own `node <file>` child (exit 0 = PASS), aggregates the
// outcomes into a flag|file|status table, prints a summary, and exits non-zero
// if ANY test FAILS. This is the host-JS leg of the flag harness — the SIBLING
// of harness/cargo-tests.mjs (native Rust coverage) and harness/playwright/
// drive.mjs (the in-browser leg). It needs neither a wasm rebuild nor a server:
// every listed file is a self-contained Node unit test (the .mjs ones import
// app modules with three-stub shims; the .cjs ones under tests/ are CommonJS).
//
// WHY A SEPARATE RUNNER: these are deterministic, dependency-free unit tests
// that assert JS-side flag logic (input funnel, hook windows/fire-queue,
// surface bitfield fold, script-manager queue, particle ownership/degrade,
// pre-create buffer, run-keys, root-motion, pursuit monitor, rig module,
// camera retail math, remote-interp ownership, jump-charge parity) and the two
// new Tier-4 blocking-particle / default-script-spawn tests. They run green
// today against the CURRENT pkg/; this runner is meant to be invoked AFTER the
// user's separate wasm rebuild as a fast regression gate, but it does not
// depend on that rebuild.
//
// IMPORTANT — cwd: each child is spawned with cwd = apps/holtburger-web (the
// app root) so the tests' RELATIVE imports (e.g. ./loop.js, ./_three_stub*.mjs,
// ../<module>) resolve exactly as they do when run by hand. File paths in the
// embedded list are relative to that same app root.
//
// MISSING-FILE TOLERANCE: the two Tier-4 files are authored in a parallel wave
// and may not exist yet when this runner is invoked. A missing file is reported
// as a distinct MISSING row (and, by default, does NOT fail the run) — never a
// crash. Use --strict-missing to treat a missing file as a failure (e.g. once
// the Tier-4 authors have landed their files and you want the gate to enforce
// their presence).
//
// USAGE
//   node harness/run-js-headless.mjs [--only=substr,substr] [--tier=1|4|all]
//                                    [--quiet] [--list] [--strict-missing]
//                                    [--timeout=MS] [--bail] [--allow-skips]
//
//   --only=...        Run only files whose path OR flag contains any listed
//                     substring (comma-separated, case-insensitive).
//   --tier=1|4|all    Restrict to Tier-1, Tier-4, or both (default: all).
//   --quiet           Suppress each child's own stdout/stderr on PASS (failures
//                     and MISSING always print their captured output).
//   --list            Print the resolved test plan (tier/flag/file/exists) and
//                     exit 0 without running anything.
//   --strict-missing  Treat a MISSING file as a FAIL (default: MISSING is
//                     tolerated and does not affect the exit code).
//   --timeout=MS      Per-test wall-clock timeout (default 120000). On timeout
//                     the test is a FAIL (killed).
//   --bail            Stop at the first FAIL (still prints the partial table).
//   --allow-skips     Tolerate a child that printed a SKIP banner and exited 0.
//                     OFF by default: such a child asserted NOTHING, so
//                     counting it as a pass is exactly the defect the
//                     2026-08-03 review found (F5).
//
// EXIT CODE: 0 unless at least one test FAILED, or a test SKIPPED (unless
// --allow-skips), or -- under --strict-missing -- a file was MISSING.
// MISSING alone (default) and an empty plan exit 0.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ (the app root; child cwd + path base).
const APP_ROOT = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------
// EMBEDDED TEST PLAN (authoritative). Paths are relative to APP_ROOT.
// `tier` 1 = already-green unit tests; `tier` 4 = new (may be MISSING).
// ---------------------------------------------------------------------------
const TIER1 = [
  { flag: "inputFunnel", file: "test_a14_i1_input_controller.mjs" },
  { flag: "inputFunnelV2", file: "test_input_funnel_v2.mjs" },
  { flag: "hookDrain", file: "test_hook_windows.mjs" },
  { flag: "hookDrain", file: "test_hook_fire_queue.mjs" },
  { flag: "surfaceUnified+surfaceParityV2", file: "test_f7_8_surface_bitfield.mjs" },
  { flag: "scriptQueue", file: "test_script_manager.mjs" },
  { flag: "particleOwner", file: "test_particle_owner.mjs" },
  { flag: "preCreateBuffer", file: "test_a8_m4_pre_create_buffer.mjs" },
  { flag: "retailRunKeys(JS)", file: "test_a14_i3_run_keys.mjs" },
  { flag: "particleDegrade(JS)", file: "test_a11_s4_particle_degrade.mjs" },
  { flag: "rootMotionObject(JS)", file: "test_a5_p3_root_motion.mjs" },
  { flag: "wasmPursuit(monitor)", file: "test_a14_i2_pursuit_monitor.mjs" },
  { flag: "rigModule", file: "test_a9_stage2_setup_rig.mjs" },
  { flag: "retailCamZoom+camStiffness+mouseSmooth", file: "tests/camera_retail_math.test.cjs" },
  { flag: "remoteInterp(JS)", file: "tests/remote_interp_ownership.test.cjs" },
  { flag: "jumpParity(JS)", file: "tests/jump_charge_parity.test.cjs" },
  { flag: "unifiedMotion(poser)", file: "test_motion_sequence.mjs" },
  // Exercises the REAL compiled wasm MotionSequence boundary (entities.js path);
  // SKIPs (exit 0) gracefully when pkg/ isn't built, so it's safe in the pure-JS tier.
  { flag: "unifiedMotion(wasm)", file: "test_motion_sequence_wasm_smoke.mjs" },
  // VFX (Visual-Behavior Suite) — tree-wind + the component system (2026-06-23).
  { flag: "treeWind(JS)", file: "test_wind_clip_gen.mjs" },
  { flag: "treeWindRig(JS)", file: "test_bbox_rig.mjs" },
  { flag: "treeWindOffFrozen(JS)", file: "test_wind_off_frozen.mjs" },
  { flag: "vfxComponent(JS)", file: "test_vfx_windbend.mjs" },
  { flag: "vfxMaterialSubstrate(JS)", file: "test_vfx_material_substrate.mjs" },
  { flag: "vfxCatalog(JS)", file: "test_vfx_catalog.mjs" },
  { flag: "vfxLegacySafety(JS)", file: "test_vfx_legacy_safety.mjs" },
  { flag: "vfxShadowPass(JS)", file: "test_vfx_shadow_pass.mjs" },
  { flag: "vfxOscillators(JS)", file: "test_vfx_oscillators.mjs" },
  { flag: "vfxPerInstanceHash(JS)", file: "test_vfx_per_instance_hash.mjs" },
  { flag: "vfxFragInstall(JS)", file: "test_vfx_frag_install.mjs" },
  { flag: "vfxVertexInstall(JS)", file: "test_vfx_vertex_install.mjs" }, // P2.1 MECH-B firewall
  { flag: "vfxTipFlex(JS)", file: "test_vfx_tipflex.mjs" },              // P2.2 deformation.tipFlex
  { flag: "vfxFragAttach(JS)", file: "test_vfx_frag_attach.mjs" },
  { flag: "vfxGlint(JS)", file: "test_vfx_glint.mjs" },
  { flag: "vfxMagicGlow(JS)", file: "test_vfx_magicglow.mjs" },
  { flag: "vfxEnchantShimmer(JS)", file: "test_vfx_enchantshimmer.mjs" },
  { flag: "vfxTarnish(JS)", file: "test_vfx_tarnish.mjs" },
  { flag: "vfxWetness(JS)", file: "test_vfx_wetness.mjs" },
  { flag: "vfxFrost(JS)", file: "test_vfx_frost.mjs" },
  { flag: "vfxFlameFlicker(JS)", file: "test_vfx_flameflicker.mjs" },
  { flag: "vfxWeatherInputs(JS)", file: "test_vfx_weather_inputs.mjs" },
  { flag: "vfxFlags(JS)", file: "test_vfx_flags.mjs" },
  { flag: "vfxCostModel(JS)", file: "test_vfx_cost_model.mjs" },
  { flag: "vfxFirewall(JS)", file: "test_vfx_firewall.mjs" },
].map((t) => ({ ...t, tier: 1 }));

// New files (authored in parallel). Referenced by path even if not present yet:
// the runner reports a missing file as a MISSING row, never a crash.
const TIER4 = [
  { flag: "blockingParticleParity", file: "test_a11_s0_blocking_particle.mjs" },
  { flag: "defaultScriptSpawn", file: "test_a11_s5_default_script_spawn.mjs" },
  { flag: "acWindowPositionMerge(R11)", file: "test_ac_window_position_merge.mjs" },
  { flag: "aliasSplit(JS)", file: "test_p1_alias_split.mjs" },
].map((t) => ({ ...t, tier: 4 }));

const PLAN = [...TIER1, ...TIER4];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    only: null,
    tier: "all",
    quiet: false,
    list: false,
    strictMissing: false,
    // F5: a SKIP (exit 0 but nothing asserted) fails the run by default.
    allowSkips: false,
    timeoutMs: 120000,
    bail: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--quiet") opts.quiet = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--strict-missing") opts.strictMissing = true;
    else if (a === "--allow-skips") opts.allowSkips = true;
    else if (a === "--bail") opts.bail = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--only=")) {
      opts.only = a
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (opts.only.length === 0) opts.only = null;
    } else if (a.startsWith("--tier=")) {
      const v = a.slice("--tier=".length).trim().toLowerCase();
      if (v === "1" || v === "4" || v === "all") opts.tier = v;
      else console.warn(`[run-js-headless] --tier: expected 1|4|all, got ${v} — ignoring`);
    } else if (a.startsWith("--timeout=")) {
      const n = Number(a.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) opts.timeoutMs = n;
      else console.warn(`[run-js-headless] --timeout: expected a positive number — ignoring ${a}`);
    } else {
      console.warn(`[run-js-headless] ignoring unknown arg: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// plan selection
// ---------------------------------------------------------------------------
function selectPlan(opts) {
  let plan = PLAN.slice();
  if (opts.tier !== "all") {
    const t = Number(opts.tier);
    plan = plan.filter((p) => p.tier === t);
  }
  if (opts.only) {
    plan = plan.filter((p) => {
      const hay = `${p.file} ${p.flag}`.toLowerCase();
      return opts.only.some((sub) => hay.includes(sub));
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------
const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  SKIP: "SKIP",
  MISSING: "MISSING",
});

// A child that prints a SKIP banner and exits 0 asserted NOTHING (2026-08-03
// review, finding F5). The runner used to classify purely on `status === 0`,
// so six suites whose `locateThree()` exit-0'd were tabulated PASS and counted
// in the "N passed" line. run-all.mjs's own skip detector could not see them
// either: its SKIP_MARKERS list only covers TIER-level banners (SERVER_DOWN /
// PLAYWRIGHT_MISSING / cargo-absent), not per-test ones.
//
// Matches the banner forms actually in use, all of which put SKIP in caps
// followed by a delimiter:
//     "paletted-LRU ESM test: SKIP (three not located)."
//     "Phase 7.5 camera ESM test: SKIP (OrbitControls.js not found ...)."
//     "SKIP: cannot locate three.module.js — set THREE_PATH."
//     "A11-S5: SKIP — could not extract genuine pickScriptEntry ..."
// Deliberately case-sensitive on SKIP + requires a delimiter, so ordinary
// assertion text ("[OK] ... is skipped", "parkSkippedInEntriesMiss") is not
// mistaken for a banner.
const SKIP_BANNER = [
  /^[^\n]*:[ \t]*SKIP[ \t]*[(—:-]/m,
  /^[ \t]*SKIP[ \t]*[(—:-]/m,
];

function looksSkipped(output) {
  return SKIP_BANNER.some((re) => re.test(output));
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function renderTable(rows) {
  const flagW = Math.max(4, ...rows.map((r) => r.flag.length));
  const fileW = Math.max(4, ...rows.map((r) => r.file.length));
  const statW = Math.max(6, ...rows.map((r) => r.status.length));
  const line = (a, b, c) => `  ${pad(a, flagW)}  ${pad(b, fileW)}  ${pad(c, statW)}`;
  const out = [];
  out.push(line("flag", "file", "status"));
  out.push("  " + "-".repeat(flagW + fileW + statW + 4));
  for (const r of rows) {
    let mark = r.status;
    if (r.status === STATUS.FAIL) mark += r.detail ? ` (${r.detail})` : "";
    out.push(line(r.flag, r.file, mark));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// run one test file
// ---------------------------------------------------------------------------
function runOne(entry, opts) {
  const abs = path.resolve(APP_ROOT, entry.file);
  if (!existsSync(abs)) {
    return { ...entry, status: STATUS.MISSING, code: null, detail: "file not present", output: "" };
  }
  const run = spawnSync(process.execPath, [entry.file], {
    cwd: APP_ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  // spawnSync sets .error (e.g. ETIMEDOUT) and/or .signal on a kill.
  const timedOut = run.error && run.error.code === "ETIMEDOUT";
  const killed = !!run.signal;
  const ok = !run.error && !killed && run.status === 0;
  const output = [run.stdout || "", run.stderr || ""].join("");
  let detail = "";
  if (!ok) {
    if (timedOut) detail = `timeout ${opts.timeoutMs}ms`;
    else if (run.error) detail = run.error.message;
    else if (killed) detail = `signal ${run.signal}`;
    else detail = `exit ${run.status}`;
  }
  // F5: exit 0 + a SKIP banner is NOT a pass — the suite asserted nothing.
  let status;
  if (!ok) status = STATUS.FAIL;
  else if (looksSkipped(output)) {
    status = STATUS.SKIP;
    const line = output.split("\n").find((l) => looksSkipped(l));
    detail = (line || "skipped").trim().slice(0, 100);
  } else status = STATUS.PASS;
  return { ...entry, status, code: run.status, detail, output };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "usage: node harness/run-js-headless.mjs [--only=substr,...] [--tier=1|4|all] " +
        "[--quiet] [--list] [--strict-missing] [--timeout=MS] [--bail]"
    );
    process.exit(0);
  }

  const plan = selectPlan(opts);

  console.log("");
  console.log("=".repeat(76));
  console.log("  run-js-headless — host-JS flag harness (Tier-1 green + Tier-4 new)");
  console.log("=".repeat(76));
  console.log(`  app root  : ${APP_ROOT}`);
  console.log(`  node      : ${process.version}`);
  console.log(`  selected  : ${plan.length} test(s)` +
    (opts.tier !== "all" ? ` (tier=${opts.tier})` : "") +
    (opts.only ? ` (only~[${opts.only.join(", ")}])` : ""));
  console.log(`  missing   : ${opts.strictMissing ? "STRICT (counts as FAIL)" : "tolerated (no effect on exit)"}`);
  console.log(`  skips     : ${opts.allowSkips ? "tolerated (--allow-skips)" : "count as FAIL (a SKIP asserts nothing)"}`);
  console.log("=".repeat(76));

  // --list: print the plan (with existence) and exit 0.
  if (opts.list) {
    const rows = plan.map((p) => ({
      flag: p.flag,
      file: p.file,
      status: existsSync(path.resolve(APP_ROOT, p.file)) ? `tier${p.tier}` : `tier${p.tier} MISSING`,
    }));
    console.log("");
    console.log(rows.length ? renderTable(rows) : "  (no tests selected)");
    console.log("");
    process.exit(0);
  }

  if (plan.length === 0) {
    console.log("\n[run-js-headless] no tests selected — nothing to do (exit 0).");
    process.exit(0);
  }

  const results = [];
  for (const entry of plan) {
    process.stdout.write(`\n----- [tier${entry.tier}] ${entry.flag} :: ${entry.file} -----\n`);
    const res = runOne(entry, opts);
    results.push(res);

    const showOutput =
      res.status === STATUS.FAIL ||
      (res.status === STATUS.MISSING && opts.strictMissing) ||
      !opts.quiet;
    if (res.status === STATUS.MISSING) {
      console.log(`  MISSING: ${entry.file} not present at ${APP_ROOT}` +
        (opts.strictMissing ? " (STRICT → counts as FAIL)" : " (tolerated)"));
    } else {
      if (showOutput && res.output.trim()) {
        // Indent child output for readability.
        process.stdout.write(
          res.output
            .replace(/\n$/, "")
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n") + "\n"
        );
      }
      console.log(`  → ${res.status}` + (res.detail ? ` (${res.detail})` : ""));
    }

    const isFailNow =
      res.status === STATUS.FAIL ||
      (res.status === STATUS.SKIP && !opts.allowSkips) ||
      (res.status === STATUS.MISSING && opts.strictMissing);
    if (opts.bail && isFailNow) {
      console.log("\n[run-js-headless] --bail: stopping at first failure.");
      break;
    }
  }

  // Tabulate.
  const tableRows = results.map((r) => ({ flag: r.flag, file: r.file, status: r.status, detail: r.detail }));
  console.log("\n" + "=".repeat(76));
  console.log("  RESULTS");
  console.log("=".repeat(76));
  console.log(renderTable(tableRows));

  const passed = results.filter((r) => r.status === STATUS.PASS);
  const failed = results.filter((r) => r.status === STATUS.FAIL);
  const missing = results.filter((r) => r.status === STATUS.MISSING);
  const skipped = results.filter((r) => r.status === STATUS.SKIP);

  console.log("\n" + "=".repeat(76));
  console.log(
    `[run-js-headless] ${passed.length} passed, ${failed.length} failed, ` +
      `${missing.length} missing  (of ${results.length} run` +
      (plan.length !== results.length ? `; ${plan.length - results.length} skipped by --bail` : "") +
      ")"
  );
  for (const r of failed) {
    console.log(`  FAIL    : ${r.file}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  for (const r of missing) {
    console.log(`  MISSING : ${r.file}${opts.strictMissing ? " (STRICT → FAIL)" : ""}`);
  }
  console.log("=".repeat(76));

  for (const r of skipped) {
    console.log(`  SKIP    : ${r.file} — ${r.detail}` +
      (opts.allowSkips ? " (tolerated)" : " (asserts nothing → FAIL)"));
  }
  const missingCountsAsFail = opts.strictMissing ? missing.length : 0;
  const skipCountsAsFail = opts.allowSkips ? 0 : skipped.length;
  const exitNonZero =
    failed.length > 0 || missingCountsAsFail > 0 || skipCountsAsFail > 0;
  process.exit(exitNonZero ? 1 : 0);
}

main();
