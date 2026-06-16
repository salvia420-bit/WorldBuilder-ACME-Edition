#!/usr/bin/env node
// harness/playwright/drive.mjs — Playwright flag-harness DRIVER.
//
// Imports the flag descriptors from flags.spine/remote/anim/sync.mjs,
// concatenates their `flags` arrays, and for each descriptor: builds the boot
// URL query (the descriptor's own query already carries its composeDeps with
// the right values; the driver additionally guarantees every composeDep token
// is present), launches a headless in-world session via boot.mjs#launchAndEnter,
// runs assertBrowser(helpers), classifies the {status,detail}, and closes the
// browser. Sessions are GROUPED by merged query so the ~boot cost is amortized
// across descriptors that share a query.
//
// USAGE
//   node harness/playwright/drive.mjs [--smoke] [--only=key1,key2] [--timeout=MS]
//                                     [--no-group] [--list]
//
//   --smoke        Validate harness PLUMBING on a NON-rebuilt bundle: treat
//                  'rebuild-pending' (and 'skip') as OK; exit nonzero ONLY on a
//                  hard 'fail'. (Without --smoke, exit code is identical because
//                  rebuild-pending/skip are never failures — but --smoke also
//                  relaxes the "every descriptor ran" expectation and is the
//                  documented mode for pre-rebuild plumbing checks.)
//   --only=a,b     Run only the descriptors whose `key` is in the comma list.
//   --timeout=MS   Per-launch boot timeout (default 60000).
//   --no-group     Launch a fresh session per descriptor (skip query grouping).
//   --list         Print the discovered descriptors (key/name/query) and exit 0.
//
// EXIT CODE: 0 unless at least one descriptor returned a hard 'fail'.
//   - SERVER_DOWN  → clear SKIP banner, exit 0 (start serve.py + ACE + wsbridge).
//   - PLAYWRIGHT_MISSING → clear SKIP banner with the install hint, exit 0.
//   - boot stall (inWorld:false) → that descriptor is 'skip', not a fail.
//
// The four flag modules are imported DYNAMICALLY + tolerantly: a sibling wave
// may not have authored flags.anim.mjs yet at the time this file is written, so
// a missing/broken module is reported as a warning and its flags are skipped —
// it never crashes the driver or `node --check`.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchAndEnter } from "../lib/boot.mjs";
import { STATUSES } from "../lib/assert.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The four descriptor modules the driver aggregates. Order is report-only; the
// flags arrays are concatenated. Missing modules degrade gracefully.
const FLAG_MODULES = [
  "./flags.spine.mjs",
  "./flags.remote.mjs",
  "./flags.anim.mjs",
  "./flags.sync.mjs",
];

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { smoke: false, only: null, timeoutMs: 60000, group: true, list: false };
  for (const a of argv) {
    if (a === "--smoke") opts.smoke = true;
    else if (a === "--no-group") opts.group = false;
    else if (a === "--list") opts.list = true;
    else if (a.startsWith("--only=")) {
      opts.only = new Set(
        a
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (a.startsWith("--timeout=")) {
      const n = Number(a.slice("--timeout=".length));
      if (Number.isFinite(n) && n > 0) {
        opts.timeoutMs = n;
        opts._timeoutExplicit = true;
      }
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      console.warn(`[drive] ignoring unknown arg: ${a}`);
    }
  }
  // --smoke validates plumbing on a non-rebuilt / ACE-down bundle that never
  // reaches in-world, so cap the per-group in-world wait low — otherwise every
  // session group burns the full 60s default before resolving inWorld:false and
  // the run *looks* hung. An explicit --timeout always wins.
  if (opts.smoke && !opts._timeoutExplicit) opts.timeoutMs = 10000;
  return opts;
}

// ---------------------------------------------------------------------------
// descriptor loading (dynamic + tolerant)
// ---------------------------------------------------------------------------
async function loadDescriptors() {
  const all = [];
  const moduleStatus = [];
  for (const rel of FLAG_MODULES) {
    const abs = path.join(HERE, rel);
    try {
      const mod = await import(abs);
      const flags = Array.isArray(mod.flags)
        ? mod.flags
        : Array.isArray(mod.default)
          ? mod.default
          : null;
      if (!flags) {
        moduleStatus.push({ rel, ok: false, why: "no `flags` array export", count: 0 });
        continue;
      }
      for (const d of flags) all.push({ ...d, __module: rel });
      moduleStatus.push({ rel, ok: true, why: "", count: flags.length });
    } catch (err) {
      const code = err && err.code ? err.code : "";
      const why =
        code === "ERR_MODULE_NOT_FOUND"
          ? "module not present (sibling wave may not have authored it yet)"
          : `import failed: ${err && err.message ? err.message : String(err)}`;
      moduleStatus.push({ rel, ok: false, why, count: 0 });
    }
  }
  return { all, moduleStatus };
}

// ---------------------------------------------------------------------------
// query merge — guarantee every composeDep token is present in the boot query
// without clobbering a value the descriptor already set (e.g. wireStatePacks
// uses =stage1, NOT =on, so only add a bare composeDep as =on when ABSENT).
// ---------------------------------------------------------------------------
function mergedQueryFor(descriptor) {
  const params = new URLSearchParams();
  // Start from the descriptor's own query (string fragment or object).
  const q = descriptor.query;
  if (typeof q === "string" && q) {
    for (const [k, v] of new URLSearchParams(q.replace(/^[?&]/, "")).entries()) {
      params.set(k, v);
    }
  } else if (q && typeof q === "object") {
    for (const [k, v] of Object.entries(q)) params.set(k, String(v));
  }
  // Fold in any composeDep token not already present (default value "on").
  // wireStatePacks=stage1 etc. authored in `query` are preserved because the
  // key already exists in params.
  const deps = Array.isArray(descriptor.composeDeps) ? descriptor.composeDeps : [];
  for (const dep of deps) {
    if (!dep) continue;
    if (!params.has(dep)) params.set(dep, "on");
  }
  // Canonical query string (stable key order via URLSearchParams insertion).
  return params.toString();
}

// ---------------------------------------------------------------------------
// status rendering
// ---------------------------------------------------------------------------
const STATUS_TAG = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  "rebuild-pending": "PEND",
};
function tag(status) {
  return STATUS_TAG[status] || String(status).toUpperCase();
}

function normalizeResult(r) {
  if (!r || typeof r !== "object" || !STATUSES.includes(r.status)) {
    return {
      status: "fail",
      detail: `assertBrowser returned a non-result value: ${safeStr(r)}`,
    };
  }
  return { status: r.status, detail: String(r.detail || "") };
}

function safeStr(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// table printer
// ---------------------------------------------------------------------------
function printTable(rows) {
  const KEY_W = Math.max(3, ...rows.map((r) => r.key.length));
  const STAT_W = 4; // PASS/FAIL/SKIP/PEND
  const header = `${"KEY".padEnd(KEY_W)}  ${"STAT".padEnd(STAT_W)}  DETAIL`;
  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    const detail = (r.detail || "").replace(/\s+/g, " ").trim();
    console.log(`${r.key.padEnd(KEY_W)}  [${tag(r.status)}] ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "usage: node harness/playwright/drive.mjs [--smoke] [--only=k1,k2] " +
        "[--timeout=MS] [--no-group] [--list]"
    );
    process.exit(0);
  }

  const { all, moduleStatus } = await loadDescriptors();

  console.log("[drive] flag modules:");
  for (const m of moduleStatus) {
    console.log(
      `  ${m.ok ? "OK " : "-- "} ${m.rel}` +
        (m.ok ? ` (${m.count} flag${m.count === 1 ? "" : "s"})` : ` — ${m.why}`)
    );
  }

  // Filter by --only.
  let descriptors = all;
  if (opts.only) {
    descriptors = all.filter((d) => opts.only.has(d.key));
    const found = new Set(descriptors.map((d) => d.key));
    for (const k of opts.only) {
      if (!found.has(k)) console.warn(`[drive] --only key not found: ${k}`);
    }
  }

  if (descriptors.length === 0) {
    console.log("\n[drive] no descriptors to run.");
    // Not a failure: nothing was asked of us (or modules absent in --smoke).
    process.exit(0);
  }

  if (opts.list) {
    console.log("\n[drive] descriptors:");
    for (const d of descriptors) {
      console.log(
        `  ${d.key}  (${d.__module})  query="${mergedQueryFor(d)}"` +
          (d.rebuildCoupled ? "  [rebuild-coupled]" : "")
      );
    }
    process.exit(0);
  }

  // Group descriptors by merged query so we boot once per distinct query.
  const groups = new Map(); // query -> descriptor[]
  for (const d of descriptors) {
    const key = opts.group ? mergedQueryFor(d) : `${d.key}::${mergedQueryFor(d)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  console.log(
    `\n[drive] ${descriptors.length} descriptor(s) in ${groups.size} session group(s)` +
      (opts.smoke ? " — SMOKE mode (rebuild-pending/skip tolerated)" : "")
  );

  const rows = [];
  let serverDownOrNoPw = null; // {kind, message}

  for (const [groupKey, groupDescriptors] of groups.entries()) {
    // The merged query is the same for the whole group (when grouping) — take
    // it from the first descriptor.
    const query = mergedQueryFor(groupDescriptors[0]);
    console.log(
      `\n[drive] session: query="${query}"  (${groupDescriptors
        .map((d) => d.key)
        .join(", ")})`
    );

    let session = null;
    try {
      session = await launchAndEnter({ query, timeoutMs: opts.timeoutMs });
    } catch (err) {
      const code = err && err.code ? err.code : "";
      if (code === "SERVER_DOWN" || code === "PLAYWRIGHT_MISSING") {
        serverDownOrNoPw = { kind: code, message: err.message || code };
        // Mark every descriptor in EVERY group skip and bail the launch loop.
        for (const d of descriptors) {
          if (!rows.find((r) => r.key === d.key)) {
            rows.push({
              key: d.key,
              status: "skip",
              detail:
                code === "SERVER_DOWN"
                  ? "SERVER_DOWN — dev server/bridge/ACE unreachable"
                  : "PLAYWRIGHT_MISSING — browser dep absent",
            });
          }
        }
        break;
      }
      // Any other launch error is a real boot failure for this group → fail
      // each descriptor in the group (it could not be exercised at all).
      for (const d of groupDescriptors) {
        rows.push({
          key: d.key,
          status: "fail",
          detail: `launch failed: ${err && err.message ? err.message : String(err)}`,
        });
      }
      continue;
    }

    const { helpers, inWorld, url } = session;
    try {
      if (!inWorld) {
        // Boot stalled / geometry-only scene / no pose → SKIP (never FAIL).
        // Do NOT call assertBrowser against a world-less page (schema rule).
        for (const d of groupDescriptors) {
          rows.push({
            key: d.key,
            status: "skip",
            detail: `boot did not reach in-world (no pose) at ${url} — likely ACE/bridge down; SKIP (not a fail)`,
          });
        }
        // In --smoke, if the first booted group can't reach in-world then ACE/
        // login is down for the whole run — don't relaunch a browser per
        // remaining group (each would burn the full in-world timeout). Mark the
        // rest SKIP and stop.
        if (opts.smoke) {
          for (const d of descriptors) {
            if (!rows.find((r) => r.key === d.key)) {
              rows.push({
                key: d.key,
                status: "skip",
                detail:
                  "skipped after the first session could not reach in-world (smoke; ACE/bridge down)",
              });
            }
          }
          break;
        }
        continue;
      }
      // In-world: run each descriptor's assertBrowser against the shared
      // helpers. Catch uncaught throws as 'fail' (genuine harness bug).
      for (const d of groupDescriptors) {
        let res;
        try {
          res = normalizeResult(await d.assertBrowser(helpers));
        } catch (err) {
          res = {
            status: "fail",
            detail: `assertBrowser threw: ${err && err.message ? err.message : String(err)}`,
          };
        }
        rows.push({ key: d.key, status: res.status, detail: res.detail });
        console.log(`  [${tag(res.status)}] ${d.key} — ${res.detail}`);
      }
    } finally {
      // The DRIVER owns lifecycle (assertBrowser must NOT close).
      await helpers.close();
    }
  }

  // ---- report ----
  if (serverDownOrNoPw) {
    const isServer = serverDownOrNoPw.kind === "SERVER_DOWN";
    console.log("\n" + "=".repeat(72));
    console.log(`  SKIP: ${serverDownOrNoPw.kind}`);
    console.log("=".repeat(72));
    if (isServer) {
      console.log("  The dev server / bridge / ACE was not reachable on 127.0.0.1.");
      console.log("  Start them and re-run:");
      console.log("    1) dev server : python3 scripts/serve.py        (binds 127.0.0.1:8765)");
      console.log("    2) wsbridge   : the local ws bridge              (ws://127.0.0.1:8080/)");
      console.log("    3) ACE server : the ACEmulator world server      (127.0.0.1:9000)");
      console.log("  Then: node harness/playwright/drive.mjs [--smoke]");
    } else {
      console.log("  Playwright is not installed where the driver can require it.");
      console.log("  Install chromium and re-run:");
      console.log("    npx -y playwright@1.59.1 install chromium");
      console.log("  (or vendor: npm i -D playwright@1.59.1 && npx playwright install chromium)");
    }
    console.log("=".repeat(72));
  }

  printTable(rows);

  const counts = { pass: 0, fail: 0, skip: 0, "rebuild-pending": 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(
    `\n[drive] ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip, ` +
      `${counts["rebuild-pending"]} rebuild-pending  (${rows.length} total)`
  );

  // Exit nonzero ONLY on a hard 'fail'. skip + rebuild-pending are never
  // failures (--smoke does not change this; it is documented as the
  // plumbing-validation mode and tolerates the non-fail statuses, which the
  // exit code already does).
  const hardFail = counts.fail > 0;
  if (hardFail && opts.smoke) {
    console.log("[drive] SMOKE: hard 'fail' present — plumbing is broken (not just rebuild-pending).");
  }
  process.exit(hardFail ? 1 : 0);
}

main().catch((err) => {
  console.error("[drive] fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
