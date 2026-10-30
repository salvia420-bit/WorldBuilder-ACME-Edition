// tests/hot_night_ramp.test.mjs — lane F hot spots (2026-10-26):
// `?hotNightRamp` in scene3d/night_ramp.js — artSunPitchDeg reads
// `location.search` once per call.
//
// CLAIM: artSunPitchDeg (and so nightFactorFromAuthoredPitch) returns the
// same value (Object.is) with the flag on as off, for every authored pitch
// class (NaN, ±Infinity, -0, both sides of the knee, below the retail floor),
// every `enabled` form, and every URL the readers distinguish (nightRamp
// off-forms / on / junk, knee and floor overrides incl. clamps, empty and
// non-numeric values) — including a URL rewritten between calls
// (history.replaceState) — while reading the URL once per call instead of
// two or three times, and not at all for an explicit `enabled === false`.
//
// Run:   cd apps/holtburger-web && node tests/hot_night_ramp.test.mjs [--bench]

let reads = 0;
let current = "";
globalThis.window = { location: { get search() { reads += 1; return current; } } };

const NR = await import("../scene3d/night_ramp.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const URLS = [
  "", "?x=1", "?nightRamp=off", "?nightRamp=OFF", "?nightRamp=0", "?nightRamp=false", "?nightRamp=no",
  "?nightRamp=on", "?nightRamp=maybe", "?nightRamp=", "?nightRampKnee=30", "?nightRampKnee=0.2",
  "?nightRampKnee=500", "?nightRampKnee=abc", "?nightRampKnee=", "?nightRampFloor=-30", "?nightRampFloor=-99",
  "?nightRampFloor=40", "?nightRampFloor=1e400", "?nightRampKnee=12&nightRampFloor=-5",
  "?nightRamp=off&nightRampKnee=10", "?nightRampKnee=0.9", "?nightRampKnee=1&nightRampFloor=20",
];
const PITCHES = [NaN, Infinity, -Infinity, -0, 0, 0.9, 0.5, -3, 1, 5, 10, 12, 19.999, 20, 20.001, 25, 30, 45, 90, 1e-9, -1e-9];
const ENABLED = [undefined, null, true, false, 0, 1, "", "x"];

let mismatch = null, readsOff = 0, readsOn = 0, calls = 0, readsOnFalse = 0;
for (const u of URLS) {
  for (const p of PITCHES) {
    for (const en of ENABLED) {
      current = u;
      NR.__setHotNightRampForTest(false);
      reads = 0;
      const a = NR.artSunPitchDeg(p, en);
      const fa = NR.nightFactorFromAuthoredPitch(p, en);
      readsOff += reads;
      NR.__setHotNightRampForTest(true);
      reads = 0;
      const b = NR.artSunPitchDeg(p, en);
      const fb = NR.nightFactorFromAuthoredPitch(p, en);
      readsOn += reads;
      if (en === false) readsOnFalse += reads;
      calls += 2;
      if (!Object.is(a, b) || !Object.is(fa, fb)) { mismatch = `url ${u} pitch ${p} enabled ${String(en)}: ${a} vs ${b} / ${fa} vs ${fb}`; break; }
    }
    if (mismatch) break;
  }
  if (mismatch) break;
}
NR.__setHotNightRampForTest(undefined);
check(`[1] ${calls / 2} (url, pitch, enabled) cases: identical results, flag off vs on`, () => assert(!mismatch, mismatch));
check("[2] URL reads per call: one (or none for enabled === false) instead of two or three", () => {
  assert(readsOn <= calls, `on-arm reads ${readsOn} for ${calls} calls`);
  assert(readsOnFalse === 0, `an explicit enabled=false must not read the URL (${readsOnFalse})`);
  assert(readsOff > readsOn * 1.5, `off ${readsOff} vs on ${readsOn}`);
  console.log(`      location.search reads: shipped ${readsOff} → ${readsOn} over ${calls} calls`);
});
check("[3] a URL rewritten between calls is seen on the very next call (as before)", () => {
  NR.__setHotNightRampForTest(true);
  current = "?nightRampKnee=30";
  const a = NR.artSunPitchDeg(25);
  current = "?nightRampKnee=20";
  const b = NR.artSunPitchDeg(25);
  current = "?nightRamp=off";
  const c = NR.artSunPitchDeg(5);
  NR.__setHotNightRampForTest(false);
  current = "?nightRampKnee=30";
  const a0 = NR.artSunPitchDeg(25);
  current = "?nightRampKnee=20";
  const b0 = NR.artSunPitchDeg(25);
  current = "?nightRamp=off";
  const c0 = NR.artSunPitchDeg(5);
  NR.__setHotNightRampForTest(undefined);
  assert(Object.is(a, a0) && Object.is(b, b0) && Object.is(c, c0), `${a},${b},${c} vs ${a0},${b0},${c0}`);
  assert(a !== 25 && b === 25 && c === 5, "the rewrite must take effect");
});
check("[4] the refactored readers are unchanged (nightRampEnabled / nightNumFlag on every URL)", () => {
  for (const u of URLS) {
    current = u;
    const en = NR.nightRampEnabled();
    const t = (new URLSearchParams(u).get("nightRamp") ?? null);
    const expect = t == null ? true : !["off", "0", "false", "no"].includes(String(t).toLowerCase());
    assert(en === expect, `nightRampEnabled ${u}`);
    const raw = new URLSearchParams(u).get("nightRampKnee");
    const n = raw == null || raw === "" ? 20 : (Number.isFinite(Number(raw)) ? Math.min(90, Math.max(1, Number(raw))) : 20);
    assert(Object.is(NR.nightKneeDeg(), n), `nightKneeDeg ${u}`);
  }
});
{
  const { rustFlag, __setRustFlagForTest } = await import("../scene3d/rust/scene_core.js");
  __setRustFlagForTest("hotNightRamp", undefined);
  check("[5] flag default ON since 2026-10-26 (rustFlag reader, no query)", () => assert(rustFlag("hotNightRamp", true) === true, "default"));
}

if (process.argv.includes("--bench")) {
  // A Location-like getter that costs what a native accessor building a fresh
  // string costs (~1 µs is typical in Chrome); node cannot time the real one.
  current = "?autoLogin=1&account=agentp10&autoSpawn=first&nosw=1&camDebug=on&adaptiveRes=off&quality=ultra";
  Object.defineProperty(window.location, "search", { get() { reads += 1; let s = ""; for (let i = 0; i < current.length; i++) s += current[i]; return s; } });
  const run = (on, label) => {
    NR.__setHotNightRampForTest(on);
    for (let i = 0; i < 20000; i++) NR.artSunPitchDeg(i % 30);
    const N = 200000; reads = 0;
    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < N; i++) acc += NR.artSunPitchDeg(i % 30);
    const ns = Number(process.hrtime.bigint() - t0) / N;
    console.log(`  bench ${label}: ${ns.toFixed(0)} ns/call, ${(reads / N).toFixed(2)} URL reads/call (checksum ${acc.toFixed(3)})`);
  };
  run(false, "shipped     ");
  run(true, "?hotNightRamp");
  NR.__setHotNightRampForTest(undefined);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
