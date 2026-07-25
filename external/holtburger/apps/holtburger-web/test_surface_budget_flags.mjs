// Surface-cache budget S2 — `?surfaceBudgetMB=` host plumbing.
//
// The store itself is Rust (`SURFACE_PIXEL_CACHE` / `configured_surface_budget_bytes`
// in src/lib.rs, native tests in `tests_surface_cache`); this pins the HOST
// half: the `N` / `N:M` grammar, the main/worker split, and above all that an
// unauthored page leaves BOTH globals unset — which is what makes the slice
// default-neutral (Rust keeps its 96 MiB `SURFACE_CACHE_BUDGET_BYTES`).
//
//   node apps/holtburger-web/test_surface_budget_flags.mjs

import {
  parseSurfaceBudgetSpec,
  resolveSurfaceBudget,
  applySurfaceBudget,
} from "./scene3d/bake_worker_client.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MB = 1024 * 1024;

// ---- grammar ----
check("a lone N gives BOTH instances N (no silent halving, unlike decodeAdmission)",
  eq(parseSurfaceBudgetSpec("48"), { mainMB: 48, workerMB: 48 }),
  JSON.stringify(parseSurfaceBudgetSpec("48")));
check("N:M is main:worker, in that order",
  eq(parseSurfaceBudgetSpec("24:64"), { mainMB: 24, workerMB: 64 }),
  JSON.stringify(parseSurfaceBudgetSpec("24:64")));
check("fractional MB allowed", eq(parseSurfaceBudgetSpec("0.5:1.5"), { mainMB: 0.5, workerMB: 1.5 }));
check("whitespace tolerated", eq(parseSurfaceBudgetSpec("  24:64 "), { mainMB: 24, workerMB: 64 }));
check("a space separator (the `+`-shaped mistake) is accepted",
  eq(parseSurfaceBudgetSpec("24 64"), { mainMB: 24, workerMB: 64 }));
check("worker may exceed main (the design's asymmetric recommendation)",
  eq(parseSurfaceBudgetSpec("8:96"), { mainMB: 8, workerMB: 96 }));
check("worker may be smaller than main (no ordering constraint is imposed)",
  eq(parseSurfaceBudgetSpec("96:8"), { mainMB: 96, workerMB: 8 }));

for (const bad of [null, undefined, "", "off", "0", "0:0", "-1:2", "24:", ":64", "24:64:96", "24x64", "abc"]) {
  check(`garbage ${JSON.stringify(bad)} => null (Rust default)`, parseSurfaceBudgetSpec(bad) === null,
    JSON.stringify(parseSurfaceBudgetSpec(bad)));
}

// ---- resolution ----
check("no param => default", resolveSurfaceBudget("") === null);
check("unrelated params => default", resolveSurfaceBudget("?nosw=1&agent=1") === null);
check("resolve reads the surfaceBudgetMB param",
  eq(resolveSurfaceBudget("?surfaceBudgetMB=24:64"), { mainMB: 24, workerMB: 64 }));
check("`:` survives URLSearchParams untouched (no %3A needed)",
  eq(resolveSurfaceBudget("?nosw=1&surfaceBudgetMB=24:64&agent=1"), { mainMB: 24, workerMB: 64 }));

// ---- globals: the neutrality contract ----
const GLOBALS = ["__hbSurfaceBudgetBytes", "__hbSurfaceBudgetBytesWorker"];
function fakeGlobal(search) {
  return { location: { search }, __hbSurfaceBudgetBytes: 99, __hbSurfaceBudgetBytesWorker: 99 };
}

// THE negative control: absent ⇒ unset. If this regresses, every "default"
// measurement arm silently runs at some other budget.
let g = fakeGlobal("");
check("no param: applySurfaceBudget returns null", applySurfaceBudget(g) === null);
check("no param: both Rust-read globals are DELETED (Rust keeps 96 MiB, bit-for-bit)",
  GLOBALS.every((k) => !(k in g)), JSON.stringify(GLOBALS.map((k) => [k, g[k]])));

g = fakeGlobal("?nosw=1");
applySurfaceBudget(g);
check("unrelated param: still unset", GLOBALS.every((k) => !(k in g)));

g = fakeGlobal("?surfaceBudgetMB=garbage");
applySurfaceBudget(g);
check("garbage value: unset, never a 0-byte budget (which would disable the cache)",
  GLOBALS.every((k) => !(k in g)));

g = fakeGlobal("?surfaceBudgetMB=24:64");
const split = applySurfaceBudget(g);
check("armed N:M: main global takes the FIRST field",
  g.__hbSurfaceBudgetBytes === 24 * MB, String(g.__hbSurfaceBudgetBytes));
check("armed N:M: the worker's half is stashed for the init message (not main's)",
  g.__hbSurfaceBudgetBytesWorker === 64 * MB, String(g.__hbSurfaceBudgetBytesWorker));
check("armed: applySurfaceBudget returns both halves in MB and bytes",
  eq(split, { mainMB: 24, workerMB: 64, mainBytes: 24 * MB, workerBytes: 64 * MB }),
  JSON.stringify(split));

g = fakeGlobal("?surfaceBudgetMB=32");
applySurfaceBudget(g);
check("armed N: both globals get the same bytes",
  g.__hbSurfaceBudgetBytes === 32 * MB && g.__hbSurfaceBudgetBytesWorker === 32 * MB);

g = fakeGlobal("?surfaceBudgetMB=0.0000001");
applySurfaceBudget(g);
check("a sub-byte budget floors to 1, never 0 (0 would read as unset in the worker forward)",
  g.__hbSurfaceBudgetBytes === 1 && g.__hbSurfaceBudgetBytesWorker === 1,
  `${g.__hbSurfaceBudgetBytes}/${g.__hbSurfaceBudgetBytesWorker}`);

// Independence from the other budget knob: they ratchet differently (shards are
// wire records, surfaces are decoded pixels) and must never arm each other.
g = { location: { search: "?surfaceBudgetMB=24:64" } };
applySurfaceBudget(g);
check("surface budget alone does not touch the shard-budget global",
  !("__hbShardBudgetBytes" in g) && g.__hbSurfaceBudgetBytes === 24 * MB);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
