// tests/sky_game_date.test.mjs
//
// daytime-1 (R2 2026-10-08) `?skyServerClock` (DEFAULT ON). The sky's AC sun
// (wasm SkyEvalState) now runs on the server's PortalYearTicks clock — retail
// GameTime::UseTime reads Timer::cur_time, which ClientNet::HandleTimeSynch sets
// (acclient.c:463395, :371516 -> :75365). The takram moon + stars
// (atmosphere_sky.js) must follow the SAME clock or they slide 780 s (0.1 of a
// day) off the sun. scene3d/sky_game_date.js maps `getSkyPortalTicks()` to the
// synthetic Date; before the sky is populated (NaN / stale pkg) the legacy
// formula runs unchanged.
//
//   G1  no handle / stale pkg / NaN / throwing export -> the legacy formula,
//       bit for bit (pre-sync behaviour is today's).
//   G2  ticks -> launch + ticks * 86400/7620; the legacy wasm ticks
//       (now - launch) reproduce the legacy Date (<= 1 ms).
//   G3  the moon/star Date keeps today's relation to the AC sun for ANY clock:
//       UTC day fraction == (ticks mod 7620)/7620 == AC tod - 3600/7620.
//   G4  wiring: atmosphere_sky.js routes gameDateNow through the helper; the
//       wasm export + TimeSync hook exist; the docs row is present.
//
// Run: node tests/sky_game_date.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const G = await import("../scene3d/sky_game_date.js");
const {
  AC_LAUNCH_UNIX_EPOCH_MS,
  AC_LAUNCH_UNIX_EPOCH_S,
  AC_TIME_COMPRESSION,
  skyGameDateMs,
  legacyGameDateMs,
  readSkyPortalTicks,
  gameDateMsNow,
} = G;

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
}

const NOW_MS = Date.UTC(2026, 9, 8, 12, 34, 56, 789);
// The pre-change atmosphere_sky.js gameDateNow body, verbatim.
function oldFormula(nowMs) {
  const realElapsedMs = nowMs - 941_500_800 * 1000;
  const gameElapsedMs = realElapsedMs * (86400 / 7620);
  return 941_500_800 * 1000 + gameElapsedMs;
}
const dayFracUtc = (ms) => (((ms / 1000) % 86400) + 86400) % 86400 / 86400;
const mod = (a, n) => ((a % n) + n) % n;

console.log("G1 — pre-sync / no sky clock = the legacy formula");
check("constants are the retail ones", () => {
  assert(AC_LAUNCH_UNIX_EPOCH_S === 941_500_800, "1999-11-02 UTC");
  assert(AC_LAUNCH_UNIX_EPOCH_MS === 941_500_800_000, "ms");
  assert(AC_TIME_COMPRESSION === 86400 / 7620, "compression");
});
check("legacyGameDateMs is the old body exactly", () => {
  assert(legacyGameDateMs(NOW_MS) === oldFormula(NOW_MS), "bit-identical");
});
for (const [label, handle] of [
  ["no handle", undefined],
  ["null handle", null],
  ["stale pkg (no export)", {}],
  ["sky not populated (NaN)", { getSkyPortalTicks: () => NaN }],
  ["undefined return", { getSkyPortalTicks: () => undefined }],
  ["throwing export", { getSkyPortalTicks: () => { throw new Error("borrow"); } }],
]) {
  check(`${label} → legacy`, () => {
    assert(Number.isNaN(readSkyPortalTicks(handle)), "reads NaN");
    assert(gameDateMsNow(handle, NOW_MS) === oldFormula(NOW_MS), "legacy date");
  });
}

console.log("G2 — the sky clock drives the date");
check("server ticks map to launch + ticks × 86400/7620", () => {
  const ticks = 304_118_000.25;
  const handle = { getSkyPortalTicks: () => ticks };
  assert(readSkyPortalTicks(handle) === ticks, "reads the export");
  assert(gameDateMsNow(handle, NOW_MS) === skyGameDateMs(ticks), "uses the sky clock");
  near(skyGameDateMs(ticks), AC_LAUNCH_UNIX_EPOCH_MS + ticks * 1000 * AC_TIME_COMPRESSION, 0, "formula");
});
check("the legacy wasm ticks reproduce the legacy Date (pre-sync / =off)", () => {
  const legacyTicks = NOW_MS / 1000 - AC_LAUNCH_UNIX_EPOCH_S;
  near(skyGameDateMs(legacyTicks), oldFormula(NOW_MS), 1, "≤ 1 ms");
});

console.log("G3 — moon/stars keep today's relation to the AC sun");
check("UTC day fraction == (ticks mod 7620)/7620 == AC tod − 3600/7620", () => {
  for (const ticks of [0, 210, 4020, 1_368_000, 291_408_060, 304_118_000.5]) {
    const frac = dayFracUtc(skyGameDateMs(ticks));
    near(frac, mod(ticks, 7620) / 7620, 1e-6, `date frac @${ticks}`);
    const acTod = mod(ticks + 3600, 7620) / 7620; // GameTime zero_time_of_year 3600
    near(mod(frac - acTod, 1), mod(-3600 / 7620, 1), 1e-6, `relation @${ticks}`);
  }
  // The same relation the legacy clock had (ticks = now − launch).
  const legacyTicks = NOW_MS / 1000 - AC_LAUNCH_UNIX_EPOCH_S;
  const frac = dayFracUtc(oldFormula(NOW_MS));
  const acTod = mod(legacyTicks + 3600, 7620) / 7620;
  near(mod(frac - acTod, 1), mod(-3600 / 7620, 1), 1e-6, "legacy relation");
});

console.log("G4 — wiring");
check("atmosphere_sky.js gameDateNow goes through the helper", () => {
  const src = readFileSync(path.join(APP, "scene3d", "atmosphere_sky.js"), "utf8");
  assert(/import\s*\{\s*gameDateMsNow\s*\}\s*from\s*"\.\/sky_game_date\.js"/.test(src), "imports the helper");
  assert(/gameDateMsNow\(globalThis\.window\?\.__sessionHandle,\s*Date\.now\(\)\)/.test(src), "feeds the session handle");
  assert(!/Date\.now\(\)\s*-\s*AC_LAUNCH_UNIX_EPOCH_MS/.test(src), "the private-clock body is gone");
});
check("wasm: getSkyPortalTicks export + TimeSync hook + populate seed", () => {
  const lib = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  assert(/js_name = getSkyPortalTicks\)\]/.test(lib), "SessionHandle.getSkyPortalTicks");
  assert(/js_name = derethCalendarAt\)\]/.test(lib), "SessionHandle.derethCalendarAt");
  assert(/fn note_sky_server_time\(portal_ticks: f64\)/.test(lib), "note_sky_server_time");
  assert(/evaluator\.set_server_clock\(portal_ticks, at_unix\)/.test(lib), "populate/live re-anchor");
  assert(/"skyServerClock=off" \| "skyServerClock=0" \| "skyServerClock=false"/.test(lib), "off/0/false reader");
  const msgs = readFileSync(path.join(APP, "src", "session", "messages", "mod.rs"), "utf8");
  assert(/SessionEvent::TimeSync\(server_time\)[\s\S]{0,900}crate::note_sky_server_time\(server_time\)/.test(msgs), "TimeSync arm feeds the sky");
});
check("docs row: skyServerClock under the round-2 time & death section", () => {
  const docs = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const at = docs.indexOf("### 2026-10-08 (round 2) — time & death");
  assert(at >= 0, "section heading");
  const section = docs.slice(at, at + 8000);
  assert(/\| `skyServerClock`=off/.test(section), "skyServerClock row");
  assert(/\| `deadInputGate`=off/.test(section), "deadInputGate row");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
