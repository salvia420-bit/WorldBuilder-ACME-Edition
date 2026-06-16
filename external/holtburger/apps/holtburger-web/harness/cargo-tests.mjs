#!/usr/bin/env node
// harness/cargo-tests.mjs — native cargo-test runner for the REBUILD-COUPLED
// flags' Rust coverage (the host-toolchain half of the flag harness; SEPARATE
// from the browser half in harness/playwright/drive.mjs).
//
// ============================================================================
// RUN IT ON THE BUILDBOX, or LOCALLY via the OOM-jailed `capped-build` wrapper.
// ============================================================================
// This 8GB laptop's OOM rules FORBID an uncapped `cargo test` / any
// `--workspace` build (see MEMORY: OOM protection stack). The two safe ways to
// actually execute the commands this script prints are:
//
//   * BUILDBOX (preferred for a full sweep): the 18-core GCE box has no cap.
//   * LOCAL, capped: prefix every cargo invocation with `capped-build`
//     (/usr/local/bin/capped-build — joins the 3.5G "builds" cgroup, oom.group,
//     CARGO_BUILD_JOBS=2, nice/ionice). This script does that automatically
//     when it runs cargo locally and `capped-build` is on PATH (override with
//     --no-cap / --cap to force).
//
// By default the script is PRINT-ONLY-SAFE: if `cargo` is not resolvable it
// prints the exact commands and exits 0 (never pretends to have run them). Pass
// no flag to auto-run when cargo IS present (still capped locally); pass
// --print-only to only print regardless.
//
// USAGE
//   node harness/cargo-tests.mjs [--print-only] [--no-cap] [--cap]
//                                [--only=crate1,crate2] [--exact] [--quiet]
//
//   --print-only   Print the commands and exit 0 (do not run cargo).
//   --no-cap       Do NOT prefix with capped-build even locally (buildbox/CI).
//   --cap          Force the capped-build prefix even if not auto-detected.
//   --only=...     Restrict to the named crates
//                  (holtburger-core|holtburger-world|holtburger-dat|holtburger-web).
//   --exact        Use `-- --exact <name>` per test (exact-match each name)
//                  instead of the default space-separated substring-filter list.
//                  NOTE: the q4_get_link_*_hop PREFIXES are substring filters by
//                  design (each matches 2 tests); under --exact they are expanded
//                  to the concrete test names so --exact stays correct.
//   --quiet        Suppress cargo's own stdout on success (still prints summary).
//
// WASM-CRATE CAVEAT (holtburger-web): it is a `crate-type=["cdylib","rlib"]`
// crate, BUT every listed test is a PLAIN #[test] in a #[cfg(test)] module
// (NOT wasm_bindgen_test). Its Cargo.toml [dev-dependencies] comment is explicit
// (lines 106-122): the math/fold helpers under test are
// `cfg(any(target_arch="wasm32", test))`-gated so they are "exercised via
// `cargo test -p holtburger-web --lib` without requiring a wasm runtime." So we
// run them on the NATIVE host target with plain `cargo test -p holtburger-web
// --lib` — DO NOT use `wasm-pack test` / `--target wasm32` for these.
//
// ============================================================================
// EMBEDDED, VERIFIED PER-CRATE TEST LIST (authoritative — does NOT depend on
// import order or on the playwright flags.*.mjs files being present at author
// time). Names are real #[test] functions (or substring prefixes that match
// real tests), with the api-spec CORRECTIONS already applied:
//   - production-fn "tests" (zero-test filters) DROPPED:
//       apply_self_update_motion, record_server_control_sequence (wireStatePacks)
//       parse_world_lifecycle_flag, entity_lifecycle_state (worldLifecycle)
//       unified_transition_enabled (unifiedTransition)
//       poll_remote_poses, flatten_remote_pose_rows, resolve_remote_sticky_target_pose (remoteInterp)
//       remote_sticky_enabled, set_remote_sticky_enabled, parse_sticky_retail_flag,
//       local_sticky_target, apply_local_sticky_from_invalid (stickyRetail)
//       all jump_charge_* (jumpParity), q4_table (getLink),
//       collect_setup_placement_frames, fetch_setup_placement_frames (placementId)
//   - CRATE re-homed: build_jump_echoes_server_control_sequence is in
//       holtburger-CORE (not -world); it is the shared jumpParity/wireStatePacks
//       test. (apply_local_sticky_from_invalid / record_server_control_sequence
//       were also core, but they are production fns → dropped anyway.)
//   - PREFIX filters kept for getLink (q4_get_link_forward_hop /
//       q4_get_link_backward_hop each substring-match 2 tests).
// The driver in harness/playwright/drive.mjs carries the same names verbatim in
// each descriptor's `rustTests`; this file is the corrected, runnable view.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ → apps/ → external/holtburger/ (workspace root).
const WORKSPACE_ROOT = path.resolve(HERE, "..", "..", "..");

// Embedded list: { crate -> { tests:[...], exactTests:[...]? , flags:[...] } }.
// `tests` = the default substring-filter list. `exactTests` (optional) overrides
// for --exact when a substring prefix must expand to concrete names.
const EMBEDDED = {
  "holtburger-core": {
    flags: [
      "unifiedTick",
      "maintPrune",
      "unifiedTransition",
      "wasmPursuit",
      "retailRunKeys",
      "jumpParity",
    ],
    tests: [
      // unifiedTick / maintPrune (tick spine)
      "tick_spine_handle_ticks_and_preserves_tick_count",
      "tick_spine_handle_reports_out_of_visibility_prune_despawn",
      // unifiedTransition
      "unified_transition_spine_manual_collision_matrix",
      "unified_transition_manual_slice_matches_legacy_on_open_ground",
      // wasmPursuit
      "second_pursuit_entry_turn_begins_on_first_driver_frame",
      "pursuit_status_lifecycle_and_cancel_restore",
      // retailRunKeys (auto_run)
      "auto_run_default_off_keeps_manual_drive_verbatim",
      "auto_run_engage_installs_forward_run_and_cancels_pursuit",
      "auto_run_off_restores_held_manual_state",
      "auto_run_overrides_forward_keys_but_keeps_sidestep_turn",
      "auto_run_same_value_is_a_noop",
      // jumpParity (shared with wireStatePacks; lives in core)
      "build_jump_echoes_server_control_sequence",
    ],
  },
  "holtburger-world": {
    flags: ["worldLifecycle", "stickyRetail"],
    tests: [
      // worldLifecycle
      "test_remove_entity_clears_lifecycle_metadata",
      "test_retention_snapshot_reflects_lifecycle_metadata",
      // stickyRetail (remote + local sticky manager)
      "remote_sticky_converges_flags_rows_and_times_out",
      "remote_sticky_lazy_install_and_removal_cleanup",
      "remote_sticky_unstick_clears_and_restick_rearms_timeout",
      "remote_sticky_disabled_is_inert",
      "local_sticky_install_feed_step_converges_and_times_out",
    ],
  },
  "holtburger-dat": {
    flags: ["getLink"],
    // The two _hop names are substring PREFIXES (each matches 2 tests).
    tests: [
      "q4_get_link_forward_hop",
      "q4_get_link_backward_hop",
      "q4_get_link_full_miss_is_none",
      "q4_get_link_inner_key_is_full_command",
    ],
    // --exact expansion of the prefixes to concrete test names.
    exactTests: [
      "q4_get_link_forward_hop1_exact",
      "q4_get_link_forward_hop2_style_level_group",
      "q4_get_link_backward_hop1_reversed",
      "q4_get_link_backward_hop2_style_defaults_bridge",
      "q4_get_link_full_miss_is_none",
      "q4_get_link_inner_key_is_full_command",
    ],
  },
  "holtburger-web": {
    flags: ["remoteInterp", "rootMotionObject", "placementId"],
    tests: [
      // remoteInterp (the ONE real test among its names)
      "remote_pose_rows_flatten_to_parallel_arrays",
      // rootMotionObject (a5p3_*)
      "a5p3_net_translation_sums_deltas_across_segments",
      "a5p3_forward_then_reverse_nets_to_zero",
      "a5p3_yaw_net_survives_fold_that_zeroes_pos_channel",
      "a5p3_no_pos_frames_yields_identity_net",
      "a5p3_no_cycle_fallback_has_empty_root_motion_net",
      "a5p3_inner_v2_surfaces_root_motion_net_for_cycle_and_link",
      // placementId (the ONE real test among its names)
      "resolve_static_placement_frame_orders",
    ],
  },
};

const VALID_CRATES = new Set(Object.keys(EMBEDDED));

// Production fns / fixtures that masquerade as tests in some descriptor
// rustTests lists. Used to FILTER the optional live cross-check so we never
// emit a zero-test cargo filter. (resolve_static_placement_frame is NOT here:
// as a substring filter it still hits resolve_static_placement_frame_orders.)
const ZERO_TEST_FILTERS = new Set([
  "apply_self_update_motion",
  "record_server_control_sequence",
  "parse_world_lifecycle_flag",
  "entity_lifecycle_state",
  "unified_transition_enabled",
  "poll_remote_poses",
  "flatten_remote_pose_rows",
  "resolve_remote_sticky_target_pose",
  "remote_sticky_enabled",
  "set_remote_sticky_enabled",
  "parse_sticky_retail_flag",
  "local_sticky_target",
  "apply_local_sticky_from_invalid",
  "q4_table",
  "collect_setup_placement_frames",
  "fetch_setup_placement_frames",
  "jump_charge_begin",
  "jump_charge_commence",
  "jump_charge_release",
  "jump_charge_abort",
  "jump_charge_cancel",
  "jump_charge_level",
  "jump_charge_power",
]);

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    printOnly: false,
    cap: null, // null = auto-detect (cap locally, not on a big box)
    only: null,
    exact: false,
    quiet: false,
  };
  for (const a of argv) {
    if (a === "--print-only") opts.printOnly = true;
    else if (a === "--no-cap") opts.cap = false;
    else if (a === "--cap") opts.cap = true;
    else if (a === "--exact") opts.exact = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a.startsWith("--only=")) {
      opts.only = new Set(
        a
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (a === "--help" || a === "-h") opts.help = true;
    else console.warn(`[cargo-tests] ignoring unknown arg: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// cargo / capped-build detection
// ---------------------------------------------------------------------------
function which(bin) {
  // Use the INHERITED env PATH (non-login `sh -c`). A login shell (`sh -lc`)
  // re-sources profile and can DROP ~/.cargo/bin (cargo's PATH is usually added
  // via ~/.cargo/env sourced from ~/.bashrc, which a login `dash` won't read) →
  // a false "cargo not found" → silent print-only fallback.
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (r.status === 0 && out) return out;
  // Fallback: probe well-known absolute locations directly.
  for (const p of [
    `${os.homedir()}/.cargo/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`,
    `/bin/${bin}`,
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// "Big box" heuristic for cap auto-detect: lots of RAM => no cap needed.
function looksLikeBigBox() {
  const totalGiB = os.totalmem() / 1024 ** 3;
  return totalGiB >= 24; // the laptop is 8GB; the buildbox is far larger.
}

// ---------------------------------------------------------------------------
// optional live cross-check against the playwright descriptors (tolerant)
// ---------------------------------------------------------------------------
async function liveCrossCheck() {
  const rels = [
    "./playwright/flags.spine.mjs",
    "./playwright/flags.remote.mjs",
    "./playwright/flags.anim.mjs",
    "./playwright/flags.sync.mjs",
  ];
  const byCrate = new Map(); // crate -> Set(testName)
  let loaded = 0;
  for (const rel of rels) {
    const abs = path.join(HERE, rel);
    try {
      const mod = await import(abs);
      const flags = Array.isArray(mod.flags)
        ? mod.flags
        : Array.isArray(mod.default)
          ? mod.default
          : [];
      loaded += 1;
      for (const d of flags) {
        const crate = d.crate;
        const tests = Array.isArray(d.rustTests) ? d.rustTests : [];
        if (!crate || tests.length === 0) continue;
        if (!byCrate.has(crate)) byCrate.set(crate, new Set());
        for (const t of tests) {
          if (!ZERO_TEST_FILTERS.has(t)) byCrate.get(crate).add(t);
        }
      }
    } catch (_) {
      /* module absent / broken — tolerate (embedded list is authoritative) */
    }
  }
  return { byCrate, loaded };
}

// ---------------------------------------------------------------------------
// command building
// ---------------------------------------------------------------------------
function buildCargoArgs(crate, names, exact) {
  // cargo test -p <crate> --lib [-j2] -- [--exact] <names...>
  const base = ["test", "-p", crate, "--lib", "-j2", "--"];
  if (exact) {
    const withExact = [];
    for (const n of names) {
      withExact.push("--exact", n);
    }
    return [...base, ...withExact];
  }
  return [...base, ...names];
}

function renderCmd(prefix, cargoBin, cargoArgs) {
  const parts = [];
  if (prefix) parts.push(prefix);
  parts.push(cargoBin, ...cargoArgs);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "usage: node harness/cargo-tests.mjs [--print-only] [--no-cap] [--cap] " +
        "[--only=crate1,crate2] [--exact] [--quiet]"
    );
    process.exit(0);
  }

  // Resolve which crates to run.
  let crates = Object.keys(EMBEDDED);
  if (opts.only) {
    for (const c of opts.only) {
      if (!VALID_CRATES.has(c)) console.warn(`[cargo-tests] --only: unknown crate ${c}`);
    }
    crates = crates.filter((c) => opts.only.has(c));
  }
  if (crates.length === 0) {
    console.log("[cargo-tests] no crates selected.");
    process.exit(0);
  }

  // Optional live cross-check (report-only): confirm the embedded list and the
  // descriptors' rustTests do not drift. Never fatal.
  const { byCrate, loaded } = await liveCrossCheck();
  if (loaded > 0) {
    console.log(`[cargo-tests] cross-check: loaded ${loaded}/4 descriptor module(s).`);
    for (const crate of crates) {
      const live = byCrate.get(crate);
      if (!live) continue;
      const embedded = new Set(EMBEDDED[crate].tests);
      // Note descriptor tests not represented by any embedded name/prefix.
      const notCovered = [...live].filter(
        (t) => ![...embedded].some((e) => t === e || t.startsWith(e) || e.startsWith(t))
      );
      if (notCovered.length) {
        console.log(
          `  [drift] ${crate}: descriptor names not in embedded list: ${notCovered.join(", ")}`
        );
      }
    }
  } else {
    console.log("[cargo-tests] cross-check: no descriptor modules loaded (using embedded list).");
  }

  // Detect cargo + decide on the capped-build prefix.
  const cargoBin = which("cargo");
  const cappedBin = which("capped-build");
  let useCap;
  if (opts.cap === true) useCap = true;
  else if (opts.cap === false) useCap = false;
  else useCap = !looksLikeBigBox(); // auto: cap on the small laptop, not the box
  if (useCap && !cappedBin) {
    console.warn(
      "[cargo-tests] WARN: capped-build requested/auto-selected but not on PATH — " +
        "commands will run UNCAPPED if executed. On this box that risks OOM; prefer " +
        "--print-only or run on the buildbox."
    );
    useCap = false;
  }
  const prefix = useCap ? cappedBin : "";

  // Print a header + every command.
  console.log("");
  console.log("=".repeat(76));
  console.log("  cargo-tests — native Rust coverage for the rebuild-coupled flags");
  console.log("=".repeat(76));
  console.log(`  workspace : ${WORKSPACE_ROOT}`);
  console.log(`  cargo     : ${cargoBin || "(not found — print-only)"}`);
  console.log(`  cap       : ${useCap ? cappedBin : "off"}`);
  console.log(`  mode      : ${opts.printOnly || !cargoBin ? "PRINT-ONLY" : "RUN"}` +
    (opts.exact ? " (--exact)" : ""));
  console.log("=".repeat(76));

  const plan = crates.map((crate) => {
    const spec = EMBEDDED[crate];
    const names = opts.exact && spec.exactTests ? spec.exactTests : spec.tests;
    const cargoArgs = buildCargoArgs(crate, names, opts.exact);
    return { crate, names, cargoArgs, cmd: renderCmd(prefix, cargoBin || "cargo", cargoArgs) };
  });

  for (const p of plan) {
    console.log(`\n# ${p.crate}  (${p.names.length} test filter${p.names.length === 1 ? "" : "s"}: ${EMBEDDED[p.crate].flags.join(", ")})`);
    console.log(`  ${p.cmd}`);
  }

  // Print-only (explicit, or cargo absent): exit 0 without running.
  if (opts.printOnly || !cargoBin) {
    if (!cargoBin && !opts.printOnly) {
      console.log("\n[cargo-tests] cargo not found — printed commands only (exit 0, PRINT-ONLY-SAFE).");
    } else {
      console.log("\n[cargo-tests] --print-only: not running cargo (exit 0).");
    }
    process.exit(0);
  }

  // Run each crate's tests from the workspace root. Aggregate pass/fail.
  console.log(`\n[cargo-tests] running ${plan.length} crate test step(s) from ${WORKSPACE_ROOT} ...`);
  const results = [];
  for (const p of plan) {
    console.log(`\n----- ${p.crate} -----`);
    console.log(`  $ ${p.cmd}`);
    const argv0 = prefix || cargoBin;
    const argv = prefix ? [cargoBin, ...p.cargoArgs] : [...p.cargoArgs];
    const run = spawnSync(argv0, argv, {
      cwd: WORKSPACE_ROOT,
      stdio: opts.quiet ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
    });
    const ok = run.status === 0;
    if (opts.quiet && !ok && run.stdout) process.stdout.write(run.stdout);
    if (run.error) {
      console.error(`  spawn error: ${run.error.message}`);
    }
    results.push({ crate: p.crate, ok, code: run.status, signal: run.signal });
    console.log(`  → ${p.crate}: ${ok ? "PASS" : `FAIL (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ""})`}`);
  }

  // Summary.
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(76));
  console.log(`[cargo-tests] ${passed}/${results.length} crate step(s) passed.`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.crate} (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ""})`);
  }
  console.log("=".repeat(76));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[cargo-tests] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
