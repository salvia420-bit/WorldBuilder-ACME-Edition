// A15 §2 (a) / S4 — `?decodeAdmission*` spec parsing + the main/worker split.
//
// The gate itself is Rust (src/decode_admission.rs, native tests there); this
// pins the HOST half: the grammar, the shorthand's asymmetric split (§2.5 — the
// worker carries the bulk load, so a 50/50 split starves it), and above all
// that an unauthored page leaves EVERY global unset, which is what makes S4
// behaviour-neutral by default.
//
//   node apps/holtburger-web/test_decode_admission_flags.mjs

import {
  parseDecodeAdmissionSpec,
  resolveDecodeAdmission,
  applyDecodeAdmission,
  parseDecodePressureSpec,
  resolveDecodePressure,
} from "./scene3d/bake_worker_client.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MB = 1024 * 1024;

// ---- grammar ----
check("4x192+2 parses to all three fields",
  eq(parseDecodeAdmissionSpec("4x192+2"), { jobs: 4, bytes: 192 * MB, reserve: 2 }),
  JSON.stringify(parseDecodeAdmissionSpec("4x192+2")));
check("jobs alone = count-only bound (bytes 0 => Rust usize::MAX)",
  eq(parseDecodeAdmissionSpec("4"), { jobs: 4, bytes: 0, reserve: 0 }));
check("jobs+reserve without a byte cap",
  eq(parseDecodeAdmissionSpec("4+1"), { jobs: 4, bytes: 0, reserve: 1 }));
check("fractional MB allowed", eq(parseDecodeAdmissionSpec("1x0.5"), { jobs: 1, bytes: 524288, reserve: 0 }));
check("capital X accepted", eq(parseDecodeAdmissionSpec("2X64"), { jobs: 2, bytes: 64 * MB, reserve: 0 }));
check("whitespace tolerated", eq(parseDecodeAdmissionSpec("  4x192+2 "), { jobs: 4, bytes: 192 * MB, reserve: 2 }));

// URLSearchParams decodes a literal `+` as a SPACE — a hand-typed
// `?decodeAdmission=4x192+2` arrives here as "4x192 2". If this ever regresses,
// every armed arm silently runs with urgentReserve 0.
check("space separator (what a typed `+` actually decodes to) == `+`",
  eq(parseDecodeAdmissionSpec("4x192 2"), { jobs: 4, bytes: 192 * MB, reserve: 2 }),
  JSON.stringify(parseDecodeAdmissionSpec("4x192 2")));

for (const bad of [null, undefined, "", "off", "0", "0x64", "-1x8", "4x", "x64", "4x192+", "4;192", "abc"]) {
  check(`garbage ${JSON.stringify(bad)} => null (unbounded)`, parseDecodeAdmissionSpec(bad) === null,
    JSON.stringify(parseDecodeAdmissionSpec(bad)));
}

// ---- resolution / split ----
check("no params => both unbounded",
  eq(resolveDecodeAdmission(""), { main: null, worker: null }));
check("unrelated params => both unbounded",
  eq(resolveDecodeAdmission("?nosw=1&agent=1"), { main: null, worker: null }));

const short = resolveDecodeAdmission("?decodeAdmission=4x192%2B2");
check("shorthand: worker takes the spec verbatim",
  eq(short.worker, { jobs: 4, bytes: 192 * MB, reserve: 2 }), JSON.stringify(short.worker));
check("shorthand: main takes half of each field (design's 2/96+1)",
  eq(short.main, { jobs: 2, bytes: 96 * MB, reserve: 1 }), JSON.stringify(short.main));
check("shorthand halving never zeroes a non-zero field",
  eq(resolveDecodeAdmission("?decodeAdmission=1x1+1").main, { jobs: 1, bytes: 524288, reserve: 1 }));
check("shorthand halving keeps an absent field absent",
  eq(resolveDecodeAdmission("?decodeAdmission=4").main, { jobs: 2, bytes: 0, reserve: 0 }));

const explicit = resolveDecodeAdmission("?decodeAdmissionMain=2x64%2B1&decodeAdmissionWorker=4x192%2B2");
check("explicit per-instance params both parse",
  eq(explicit.main, { jobs: 2, bytes: 64 * MB, reserve: 1 }) &&
  eq(explicit.worker, { jobs: 4, bytes: 192 * MB, reserve: 2 }));
const mixed = resolveDecodeAdmission("?decodeAdmission=8x256&decodeAdmissionMain=1x8%2B1");
check("explicit beats the shorthand, per side",
  eq(mixed.main, { jobs: 1, bytes: 8 * MB, reserve: 1 }) &&
  eq(mixed.worker, { jobs: 8, bytes: 256 * MB, reserve: 0 }));
check("only one side authored: the other is unbounded",
  resolveDecodeAdmission("?decodeAdmissionWorker=4x192").main === null);

// ---- globals: the neutrality contract ----
const GLOBALS = ["__hbDecodeMaxJobs", "__hbDecodeMaxBytes", "__hbDecodeUrgentReserve"];
function fakeGlobal(search) {
  return { location: { search }, __hbDecodeMaxJobs: 99, __hbDecodeMaxBytes: 99, __hbDecodeUrgentReserve: 99 };
}
let g = fakeGlobal("");
applyDecodeAdmission(g);
check("no param: every Rust-read global is DELETED (unbounded, bit-for-bit S1)",
  GLOBALS.every((k) => !(k in g)), JSON.stringify(GLOBALS.map((k) => [k, g[k]])));
check("no param: nothing is forwarded to the worker", g.__hbDecodeAdmissionWorker === undefined);

g = fakeGlobal("?decodeAdmission=4x192+2");
const applied = applyDecodeAdmission(g);
check("armed: main globals set from the MAIN half",
  g.__hbDecodeMaxJobs === 2 && g.__hbDecodeMaxBytes === 96 * MB && g.__hbDecodeUrgentReserve === 1,
  `${g.__hbDecodeMaxJobs}/${g.__hbDecodeMaxBytes}/${g.__hbDecodeUrgentReserve}`);
check("armed: the WORKER half is stashed for the init message (not the main half)",
  eq(g.__hbDecodeAdmissionWorker, { jobs: 4, bytes: 192 * MB, reserve: 2 }));
check("armed: applyDecodeAdmission returns both halves", eq(applied.worker, g.__hbDecodeAdmissionWorker));

g = fakeGlobal("?decodeAdmissionMain=4");
applyDecodeAdmission(g);
check("count-only arming leaves the byte/reserve globals unset",
  g.__hbDecodeMaxJobs === 4 && !("__hbDecodeMaxBytes" in g) && !("__hbDecodeUrgentReserve" in g));

// ---- S5: `?decodePressure` grammar + the inert-by-default contract ----
check("1024:1536 parses both steps",
  eq(parseDecodePressureSpec("1024:1536"), { t1MB: 1024, t2MB: 1536 }),
  JSON.stringify(parseDecodePressureSpec("1024:1536")));
check("a lone T1 arms only the halving step",
  eq(parseDecodePressureSpec("1024"), { t1MB: 1024, t2MB: 0 }));
check("fractional MB allowed", eq(parseDecodePressureSpec("0.5:1.5"), { t1MB: 0.5, t2MB: 1.5 }));
check("whitespace tolerated", eq(parseDecodePressureSpec("  1024:1536 "), { t1MB: 1024, t2MB: 1536 }));
check("a space separator (the `+`-shaped mistake) is accepted",
  eq(parseDecodePressureSpec("1024 1536"), { t1MB: 1024, t2MB: 1536 }));
check("t2 <= t1 degrades to one step, not to nonsense",
  eq(parseDecodePressureSpec("1536:1024"), { t1MB: 1536, t2MB: 0 }) &&
  eq(parseDecodePressureSpec("1024:1024"), { t1MB: 1024, t2MB: 0 }));
for (const bad of [null, undefined, "", "off", "0", "0:0", "-1:2", "1024:", ":1536", "1024:1536:2048", "abc"]) {
  check(`garbage ${JSON.stringify(bad)} => null (inert)`, parseDecodePressureSpec(bad) === null,
    JSON.stringify(parseDecodePressureSpec(bad)));
}
check("no param => inert", resolveDecodePressure("?nosw=1") === null);
check("resolve reads the decodePressure param",
  eq(resolveDecodePressure("?decodePressure=1024:1536"), { t1MB: 1024, t2MB: 1536 }));

const PGLOBALS = ["__hbDecodePressureT1MB", "__hbDecodePressureT2MB"];
function fakePGlobal(search) {
  return { location: { search }, __hbDecodePressureT1MB: 7, __hbDecodePressureT2MB: 7 };
}
g = fakePGlobal("");
applyDecodeAdmission(g);
check("no param: both pressure globals are DELETED (inert, bit-for-bit S4)",
  PGLOBALS.every((k) => !(k in g)), JSON.stringify(PGLOBALS.map((k) => [k, g[k]])));
check("no param: no pressure spec forwarded to the worker",
  g.__hbDecodePressureWorker === undefined);

g = fakePGlobal("?decodePressure=1024:1536");
const withP = applyDecodeAdmission(g);
check("armed: both pressure globals set, in MB",
  g.__hbDecodePressureT1MB === 1024 && g.__hbDecodePressureT2MB === 1536,
  `${g.__hbDecodePressureT1MB}/${g.__hbDecodePressureT2MB}`);
check("armed: the SAME pair is forwarded to the worker (each instance measures itself)",
  eq(g.__hbDecodePressureWorker, { t1MB: 1024, t2MB: 1536 }));
check("armed: applyDecodeAdmission returns the pressure spec", eq(withP.pressure, { t1MB: 1024, t2MB: 1536 }));

g = fakePGlobal("?decodePressure=1024");
applyDecodeAdmission(g);
check("lone T1: the T2 global stays unset (Rust keeps u64::MAX)",
  g.__hbDecodePressureT1MB === 1024 && !("__hbDecodePressureT2MB" in g));

// Pressure and the cap bound are independent params: arming one must not arm
// the other, in either direction.
g = { location: { search: "?decodePressure=1024:1536" } };
applyDecodeAdmission(g);
check("pressure alone does not arm the cap globals",
  !("__hbDecodeMaxJobs" in g) && g.__hbDecodePressureT1MB === 1024);
g = { location: { search: "?decodeAdmission=4x192+2" } };
applyDecodeAdmission(g);
check("caps alone leave pressure inert",
  g.__hbDecodeMaxJobs === 2 && !("__hbDecodePressureT1MB" in g));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
