#!/usr/bin/env node
// harness/run-all.mjs — SINGLE ENTRY POINT for the unified-pipeline flag harness.
//
// ============================================================================
// THREE TIERS, ONE GATE.
// ============================================================================
// The unified-movement / render work is split across three test surfaces. Each
// has a self-contained sibling runner (a plain `node <file>` that self-reports
// via process.exit(0|1)); this file orchestrates them, aggregates their exit
// codes, and prints one final GREEN/RED gate.
//
//   --js  (default)  harness/run-js-headless.mjs
//                    Pure-Node unit tests (NO browser, NO wasm rebuild, NO
//                    server). The host-JS flag logic: input funnel, hook
//                    windows/fire-queue, surface bitfield fold, script-manager
//                    queue, particle ownership/degrade, pre-create buffer,
//                    run-keys, root-motion, pursuit monitor, rig module, camera
//                    retail math, remote-interp ownership, jump-charge parity,
//                    + the two new Tier-4 tests. >>> THIS IS THE GATE THAT
//                    WORKS TODAY. <<<
//
//   --rust           harness/cargo-tests.mjs
//                    Native `cargo test -p <crate> --lib` for the rebuild-
//                    coupled flags' Rust coverage (tick spine, transitions,
//                    pursuit/auto_run, world lifecycle, sticky, getLink, root-
//                    motion fold, placement frames). Needs the cargo toolchain.
//                    On this 8GB laptop it auto-prefixes the OOM-jailed
//                    `capped-build` wrapper; prefer the buildbox for a full
//                    sweep. If cargo is absent it is PRINT-ONLY-SAFE (prints the
//                    commands, exits 0). See README "Tier 2 — Rust (cargo)".
//
//   --playwright     harness/playwright/drive.mjs
//                    In-browser, in-world descriptors (flags.spine/remote/anim/
//                    sync.mjs) read live wasm getters + diag globals inside
//                    page.evaluate. Needs a RUNNING serve.py + ACE + wsbridge
//                    AND a fresh wasm rebuild for the v4 additive getters
//                    (else those descriptors classify rebuild-pending, NOT
//                    fail). SERVER_DOWN / PLAYWRIGHT_MISSING => the whole tier
//                    SKIPs (exit 0). See README "Tier 3 — Playwright (browser)".
//
//   --all            Run all three, aggregate, print the final gate.
//
// ----------------------------------------------------------------------------
// WHAT NEEDS THE USER'S SEPARATE WASM REBUILD
// ----------------------------------------------------------------------------
//   Tier 1 (--js)         : NOTHING. Runs green against the current pkg/ today.
//   Tier 2 (--rust)       : a host cargo toolchain (native target; these are
//                           plain #[test], NOT wasm-bindgen — see cargo-tests.mjs).
//                           Rebuild NOT strictly required to run the rust tests,
//                           but the flags they cover only go LIVE in the browser
//                           after `wasm-pack build --target web --out-dir pkg`.
//   Tier 3 (--playwright) : the wasm rebuild (so v4 getters exist) + serve.py +
//                           ACE + wsbridge. Pre-rebuild, getters read absent and
//                           descriptors are rebuild-pending (still exit 0).
//
//   Rebuild command (mirror of docs/url-flags.md:339 + pkg-node/README.md):
//     # locally (OOM-jailed):
//     export PATH="$HOME/.cargo/bin:$PATH" \
//       && capped-build wasm-pack build --target web --out-dir pkg --dev
//     # on the buildbox (uncapped, ~1m30s --release):
//     export PATH="$HOME/.cargo/bin:$PATH" \
//       && wasm-pack build --target web --out-dir pkg --release
//     # then bump the ?v=wave-… cache-bust in index.html (2 spots ~947 + 1234).
//
// ----------------------------------------------------------------------------
// EXIT CODE (the gate)
// ----------------------------------------------------------------------------
//   0 (GREEN) when every selected tier that RAN exited 0. skip / rebuild-pending
//             / print-only are NOT failures — the sibling runners already fold
//             those into exit 0, so a tier exiting 0 means "no hard failure".
//   1 (RED)   if any selected tier exited non-zero (a real, present+reachable
//             behavior was WRONG, or a JS unit test failed).
//
// USAGE
//   node harness/run-all.mjs                 # default: --js (the works-today gate)
//   node harness/run-all.mjs --js
//   node harness/run-all.mjs --rust [--print-only] [--no-cap] [--cap]
//   node harness/run-all.mjs --playwright [--smoke]
//   node harness/run-all.mjs --all
//   node harness/run-all.mjs --list          # show the tier plan + child cmds, exit 0
//
//   Any UNRECOGNIZED arg is forwarded VERBATIM to every selected child runner,
//   so e.g. `--all --quiet`, `--js --only=surface`, `--playwright --only=jumpParity`,
//   `--rust --only=holtburger-core` all work. (The tier selectors --js/--rust/
//   --playwright/--all and the orchestrator-only flags --list/--help/--no-rebuild-note
//   are consumed here and NOT forwarded.)
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// harness/ → apps/holtburger-web/ (the app root; children are spawned from here
// so their relative imports resolve; cargo-tests resolves the workspace itself).
const APP_ROOT = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------
// Tier registry. `needsRebuild` / `needsServer` drive the header + report; the
// actual exit semantics come from each child runner.
// ---------------------------------------------------------------------------
const TIERS = Object.freeze({
  js: {
    id: "js",
    label: "Tier 1 — host JS unit (run-js-headless.mjs)",
    runner: path.join(HERE, "run-js-headless.mjs"),
    needsRebuild: false,
    needsServer: false,
    note: "works TODAY — no rebuild, no server, no browser.",
  },
  rust: {
    id: "rust",
    label: "Tier 2 — native Rust (cargo-tests.mjs)",
    runner: path.join(HERE, "cargo-tests.mjs"),
    needsRebuild: false, // tests run native; flags go live in-browser after rebuild
    needsServer: false,
    note: "needs a cargo toolchain (capped-build locally / buildbox). PRINT-ONLY-SAFE if cargo absent.",
  },
  playwright: {
    id: "playwright",
    label: "Tier 3 — in-browser in-world (playwright/drive.mjs)",
    runner: path.join(HERE, "playwright", "drive.mjs"),
    needsRebuild: true,
    needsServer: true,
    note: "needs a WASM REBUILD + running serve.py + ACE + wsbridge. SERVER_DOWN / PLAYWRIGHT_MISSING => SKIP (exit 0).",
  },
});

// ---------------------------------------------------------------------------
// arg parsing — split orchestrator-only flags from pass-through child args.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    tiers: [], // resolved order: subset of ["js","rust","playwright"]
    list: false,
    help: false,
    showRebuildNote: true,
    passThrough: [], // forwarded verbatim to each child
  };
  const selected = new Set();
  for (const a of argv) {
    switch (a) {
      case "--js":
        selected.add("js");
        break;
      case "--rust":
        selected.add("rust");
        break;
      case "--playwright":
      case "--pw":
        selected.add("playwright");
        break;
      case "--all":
        selected.add("js");
        selected.add("rust");
        selected.add("playwright");
        break;
      case "--list":
        opts.list = true;
        break;
      case "--no-rebuild-note":
        opts.showRebuildNote = false;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        // Unknown => forward to the child runners (e.g. --quiet, --only=…,
        // --smoke, --print-only, --timeout=…, --strict-missing, --bail).
        opts.passThrough.push(a);
        break;
    }
  }
  // Default tier when none chosen: --js (the gate that works today).
  if (selected.size === 0) selected.add("js");
  // Stable canonical order.
  for (const id of ["js", "rust", "playwright"]) {
    if (selected.has(id)) opts.tiers.push(id);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// pass-through filtering: a child only gets the args it understands, so a
// combined invocation like `--all --print-only --smoke --only=foo` does not
// make run-js-headless choke on --print-only or --smoke (it warns on unknowns).
// We hand each child ALL pass-through args EXCEPT the ones known to belong to a
// DIFFERENT child; shared/own args pass through. The child runners themselves
// only WARN (never crash) on an unknown arg, so this filtering is a courtesy to
// keep their stderr clean.
// ---------------------------------------------------------------------------
const CHILD_KNOWN_FLAGS = {
  js: new Set([
    "--quiet",
    "--list",
    "--strict-missing",
    "--bail",
    "--help",
    "-h",
  ]),
  js_prefixes: ["--only=", "--tier=", "--timeout="],
  rust: new Set(["--print-only", "--no-cap", "--cap", "--exact", "--quiet", "--help", "-h"]),
  rust_prefixes: ["--only="],
  playwright: new Set(["--smoke", "--no-group", "--list", "--help", "-h"]),
  playwright_prefixes: ["--only=", "--timeout="],
};

function argsForChild(tierId, passThrough) {
  const known = CHILD_KNOWN_FLAGS[tierId];
  const prefixes = CHILD_KNOWN_FLAGS[`${tierId}_prefixes`] || [];
  // Build the union of EVERY other child's known flags so we can drop args that
  // are clearly meant for a sibling tier (e.g. --print-only is rust-only).
  const otherExact = new Set();
  const otherPrefixes = [];
  for (const otherId of ["js", "rust", "playwright"]) {
    if (otherId === tierId) continue;
    for (const f of CHILD_KNOWN_FLAGS[otherId]) otherExact.add(f);
    for (const p of CHILD_KNOWN_FLAGS[`${otherId}_prefixes`] || []) otherPrefixes.push(p);
  }
  const out = [];
  for (const a of passThrough) {
    const isOwn =
      known.has(a) || prefixes.some((p) => a.startsWith(p));
    const isOther =
      otherExact.has(a) || otherPrefixes.some((p) => a.startsWith(p));
    if (isOwn) {
      out.push(a);
    } else if (isOther) {
      // Belongs to a different tier — drop for this child.
      continue;
    } else {
      // Truly unknown to all: forward (child will warn-and-ignore). Keeps the
      // door open for future child flags without editing this list.
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// run one tier as a child `node <runner> <args>`.
// ---------------------------------------------------------------------------
function runTier(tier, childArgs) {
  if (!existsSync(tier.runner)) {
    return {
      id: tier.id,
      label: tier.label,
      status: "MISSING",
      code: null,
      detail: `runner not found: ${tier.runner}`,
    };
  }
  const argv = [tier.runner, ...childArgs];
  const banner = `node ${path.relative(APP_ROOT, tier.runner)}${childArgs.length ? " " + childArgs.join(" ") : ""}`;
  console.log("\n" + "#".repeat(76));
  console.log(`#  ${tier.label}`);
  console.log(`#  $ ${banner}`);
  console.log("#".repeat(76));

  const run = spawnSync(process.execPath, argv, {
    cwd: APP_ROOT,
    stdio: "inherit", // stream the child's own pass/fail table live
    encoding: "utf8",
  });

  const killed = !!run.signal;
  const spawnErr = run.error ? run.error.message : "";
  const code = typeof run.status === "number" ? run.status : null;
  // A child runner is GREEN iff it exited 0 with no spawn error / signal. The
  // child has ALREADY folded skip / rebuild-pending / print-only into exit 0.
  const ok = !run.error && !killed && code === 0;
  let detail = "";
  if (!ok) {
    if (spawnErr) detail = `spawn error: ${spawnErr}`;
    else if (killed) detail = `killed by signal ${run.signal}`;
    else detail = `child exited ${code}`;
  }
  return {
    id: tier.id,
    label: tier.label,
    status: ok ? "GREEN" : "RED",
    code,
    detail,
  };
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------
function printHeader(opts) {
  console.log("");
  console.log("=".repeat(76));
  console.log("  holtburger-web — unified-pipeline FLAG HARNESS (run-all)");
  console.log("=".repeat(76));
  console.log(`  app root  : ${APP_ROOT}`);
  console.log(`  node      : ${process.version}`);
  console.log(`  tiers     : ${opts.tiers.join(", ")}`);
  if (opts.passThrough.length) {
    console.log(`  fwd args  : ${opts.passThrough.join(" ")}`);
  }
  console.log("-".repeat(76));
  console.log("  TIER       NEEDS REBUILD   NEEDS SERVER   WHAT IT IS");
  for (const id of ["js", "rust", "playwright"]) {
    const t = TIERS[id];
    const sel = opts.tiers.includes(id) ? "*" : " ";
    const reb = t.needsRebuild ? "yes" : "no ";
    const srv = t.needsServer ? "yes" : "no ";
    console.log(`  ${sel} ${pad(id, 10)} ${pad(reb, 13)} ${pad(srv, 13)} ${t.note}`);
  }
  console.log("-".repeat(76));
  if (opts.showRebuildNote) {
    console.log("  WASM REBUILD (needed for the playwright tier's v4 getters; rust flags go");
    console.log("  live in-browser after it too). Mirror of docs/url-flags.md:339:");
    console.log("    local (OOM-jailed):");
    console.log('      export PATH="$HOME/.cargo/bin:$PATH" \\');
    console.log("        && capped-build wasm-pack build --target web --out-dir pkg --dev");
    console.log("    buildbox (uncapped, ~1m30s):");
    console.log('      export PATH="$HOME/.cargo/bin:$PATH" \\');
    console.log("        && wasm-pack build --target web --out-dir pkg --release");
    console.log("    then bump the ?v=wave-… cache-bust in index.html (2 spots ~947 + 1234).");
    console.log("  Tier 1 (--js) needs NONE of this — it is the gate that works today.");
    console.log("=".repeat(76));
  }
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

// ---------------------------------------------------------------------------
// --list: show the resolved plan + the exact child command each tier will run.
// ---------------------------------------------------------------------------
function printList(opts) {
  console.log("\n[run-all] resolved tier plan:");
  for (const id of opts.tiers) {
    const t = TIERS[id];
    const childArgs = argsForChild(id, opts.passThrough);
    const present = existsSync(t.runner) ? "present" : "MISSING";
    console.log(
      `  ${pad(id, 11)} -> node ${path.relative(APP_ROOT, t.runner)}` +
        (childArgs.length ? " " + childArgs.join(" ") : "") +
        `   [${present}]`
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      [
        "usage: node harness/run-all.mjs [--js|--rust|--playwright|--all] [--list] [child args...]",
        "",
        "  --js          (default) host-JS unit tests — works TODAY, no rebuild/server.",
        "  --rust        native cargo tests (capped-build locally / buildbox).",
        "  --playwright  in-browser in-world descriptors (needs rebuild + serve.py/ACE/wsbridge).",
        "  --all         run all three and print one GREEN/RED gate.",
        "  --list        print the tier plan + child commands, exit 0.",
        "",
        "  Unrecognized args are forwarded to the selected child runner(s), e.g.:",
        "    --js --only=surface           --rust --print-only --only=holtburger-core",
        "    --playwright --smoke          --all --quiet",
      ].join("\n")
    );
    process.exit(0);
  }

  printHeader(opts);

  if (opts.list) {
    printList(opts);
    process.exit(0);
  }

  const results = [];
  for (const id of opts.tiers) {
    const tier = TIERS[id];
    const childArgs = argsForChild(id, opts.passThrough);
    results.push(runTier(tier, childArgs));
  }

  // ---- final gate ----
  console.log("\n" + "=".repeat(76));
  console.log("  RUN-ALL GATE");
  console.log("=".repeat(76));
  for (const r of results) {
    const mark = r.status === "GREEN" ? "GREEN" : r.status === "RED" ? "RED  " : "MISS ";
    console.log(`  [${mark}] ${pad(r.id, 11)} ${r.label}${r.detail ? `  — ${r.detail}` : ""}`);
  }
  console.log("-".repeat(76));

  const reds = results.filter((r) => r.status === "RED");
  const missing = results.filter((r) => r.status === "MISSING");
  // A MISSING runner is a hard problem (the harness is incomplete) → RED gate.
  const hardFail = reds.length > 0 || missing.length > 0;

  if (hardFail) {
    console.log("  GATE: RED  ✗");
    if (reds.length) {
      console.log(
        `        ${reds.length} tier(s) failed: ${reds.map((r) => r.id).join(", ")}`
      );
    }
    if (missing.length) {
      console.log(
        `        ${missing.length} runner(s) missing: ${missing.map((r) => r.id).join(", ")}`
      );
    }
  } else {
    console.log("  GATE: GREEN  ✓");
    console.log(
      "        all selected tiers passed (skip / rebuild-pending / print-only are not failures)."
    );
  }
  console.log("=".repeat(76));

  process.exit(hardFail ? 1 : 0);
}

main();
