#!/usr/bin/env node
// test_battery_liveness_abort.mjs — unit test for the battery's session-liveness
// abort (2026-07-26; mitigation (b) of the armSlim teleport wedge,
// RESULTS-matcache-falsifier-2026-07-26.md execution-log item 5).
//
// Run with:
//   node scripts/net-review/test_battery_liveness_abort.mjs
//
// battery-telepoi.mjs is a top-level-await driver script (it launches a browser
// on import), so it cannot be imported. Instead we SPLICE the marked pure
// reducer out of the source and eval it — the same source-splice pattern the
// web tests use (apps/holtburger-web/test_ambient_liveness.mjs et al.). That
// keeps the tested code and the shipped code literally the same bytes: an edit
// to the block inside battery-telepoi.mjs is what this file exercises.
//
// What must hold:
//   1. A healthy full route with the four scattered legit `no-move dup`
//      destinations (Hotel Swank / HotelSwank / Swank / NightClub) NEVER
//      aborts — those stops still have server traffic.
//   2. The 2026-07-25 wedge (19 consecutive no-moves, Sawato→Zaikhal, zero
//      inbound frames) aborts at exactly the Nth dead stop.
//   3. Consecutive no-moves WITH liveness advancing never abort, however many.
//   4. Mixed: a live no-move (or any landed stop) in the middle RESETS the
//      streak — dead stops must be CONSECUTIVE to abort.
//   5. Missing telemetry (recvMinMs null, legacy pkg) is fail-soft: never abort.
//   6. The threshold is strict-less-than deadMs, and the returned `live`
//      tri-state is what the stop row records as sessionLive.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "battery-telepoi.mjs");

// ── splice the marked block out of the driver ───────────────────────────────
function spliceBlock(src, name) {
  const open = `// <${name}>`;
  const close = `// </${name}>`;
  const a = src.indexOf(open);
  const b = src.indexOf(close);
  if (a < 0 || b < 0 || b < a) {
    throw new Error(`marker block <${name}> not found in ${SRC} — did the driver drop the markers?`);
  }
  return src.slice(a, b + close.length);
}

const block = spliceBlock(fs.readFileSync(SRC, "utf8"), "liveness-abort");
// eslint-disable-next-line no-new-func
const { livenessStep } = new Function(block + "\n; return { livenessStep };")();

// ── tiny harness ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : `\n     got=${JSON.stringify(got)}\n    want=${JSON.stringify(want)}`));
  ok ? passed++ : failed++;
};

const OPTS = { stops: 3, deadMs: 15000 };   // the shipped defaults

/**
 * Drive a whole route through the reducer exactly as the driver's stop loop
 * does, and report where (if anywhere) it aborted.
 * stops: [{ poi, noMove, recvMinMs }]
 */
function runRoute(stops, opts = OPTS) {
  let state = { streak: 0, firstPoi: null };
  const lives = [];
  for (let i = 0; i < stops.length; i++) {
    const lv = livenessStep(state, stops[i], opts);
    state = lv.state;
    lives.push(lv.live);
    if (lv.abort) {
      return { abortedAt: i, abortedPoi: stops[i].poi, abort: lv.abort, visited: i + 1, lives };
    }
  }
  return { abortedAt: null, abortedPoi: null, abort: null, visited: stops.length, lives };
}

const landed = (poi, recvMinMs = 120) => ({ poi, noMove: false, recvMinMs });
const liveDup = (poi, recvMinMs = 800) => ({ poi, noMove: true, recvMinMs });
const deadDup = (poi, recvMinMs = 60000) => ({ poi, noMove: true, recvMinMs });

console.log("battery-telepoi session-liveness abort — unit tests");
console.log("==================================================");

// ── 1. healthy full route: 62 stops, 4 scattered legit dups, never aborts ───
// Shape mirrors a real armLong route: the duplicate-POI destinations resolve to
// the same points_of_interest row, so the land window expires with no movement
// while the server keeps talking to us.
{
  const route = [];
  const DUP_AT = new Set([13, 47, 48, 49]);   // 4 legit dups, incl. the Swank cluster
  const DUP_NAME = { 13: "Swank", 47: "Hotel Swank", 48: "HotelSwank", 49: "NightClub" };
  for (let i = 0; i < 62; i++) {
    route.push(DUP_AT.has(i) ? liveDup(DUP_NAME[i]) : landed(`poi${i}`));
  }
  const r = runRoute(route);
  eq("healthy route (62 stops, 4 legit dups) — no abort", r.abortedAt, null);
  eq("healthy route — every stop visited", r.visited, 62);
  eq("healthy route — dups classified live (recorded exactly as today)",
    [13, 47, 48, 49].map((i) => r.lives[i]), [true, true, true, true]);
  eq("healthy route — zero dead classifications",
    r.lives.filter((v) => v === false).length, 0);
}

// ── 2. THREE consecutive live dups (the Swank cluster back-to-back) ─────────
// The wedge night's dups were adjacent; adjacency alone must not abort.
{
  const r = runRoute([
    landed("Cragstone"), liveDup("Hotel Swank"), liveDup("HotelSwank"),
    liveDup("NightClub"), landed("Timaru"),
  ]);
  eq("3 ADJACENT live dups — no abort", r.abortedAt, null);
  eq("3 adjacent live dups — all live", r.lives, [true, true, true, true, true]);
}

// ── 3. the 2026-07-25 wedge: 19 consecutive dead no-moves, Sawato→Zaikhal ───
{
  const names = ["Sawato", "Shoushi", "Hebian-To", "Yanshi", "Nanto", "Tou-Tou",
    "Fadar'las", "Khayyaban", "Uziz", "Zaikhal", "Ayan Baqur", "Al-Arqas",
    "Al-Jalima", "Samsur", "Xarabydun", "Yaraq", "Tufa", "Dryreach", "Zaikhal2"];
  // 30 s stale at the first dead stop, ageing 12 s per stop thereafter.
  const route = [landed("Arwic"), ...names.map((n, i) => deadDup(n, 30000 + i * 12000))];
  const r = runRoute(route);
  eq("wedge — aborts", r.abort?.reason, "session-lost");
  eq("wedge — aborts at the 3rd dead stop (route index 3)", r.abortedAt, 3);
  eq("wedge — abort names the stop", r.abortedPoi, "Hebian-To");
  eq("wedge — abort names the FIRST dead stop", r.abort?.sincePoi, "Sawato");
  eq("wedge — streak length reported", r.abort?.stops, 3);
  eq("wedge — carries the freshest recv age at the abort", r.abort?.recvMinMs, 30000 + 2 * 12000);
  eq("wedge — 16 wasted stops never attempted", r.visited, 4);
}

// ── 4. no-moves WITH liveness advancing: never aborts, however many ─────────
// (Not a real route shape, but the load-bearing negative: liveness, not the
// no-move count, is what arms the abort.)
{
  const route = Array.from({ length: 19 }, (_, i) => liveDup(`dup${i}`, 200 + i));
  const r = runRoute(route);
  eq("19 consecutive LIVE no-moves — no abort", r.abortedAt, null);
  eq("19 consecutive live no-moves — all classified live",
    r.lives.every((v) => v === true), true);
}

// ── 5. mixed: a live stop resets the streak ────────────────────────────────
{
  // dead, dead, LIVE dup, dead, dead, landed, dead, dead — never 3 in a row.
  const r = runRoute([
    deadDup("d1"), deadDup("d2"), liveDup("Swank"), deadDup("d3"), deadDup("d4"),
    landed("Arwic"), deadDup("d5"), deadDup("d6"),
  ]);
  eq("mixed (live dup + landed stops break the run) — no abort", r.abortedAt, null);
  eq("mixed — classifications", r.lives,
    [false, false, true, false, false, true, false, false]);
}
{
  // A LANDED stop mid-run resets too, then three fresh dead ones abort.
  const r = runRoute([
    deadDup("d1"), deadDup("d2"), landed("Arwic"), deadDup("d3"), deadDup("d4"), deadDup("d5"),
    deadDup("d6"),
  ]);
  eq("mixed — landed stop resets, abort at the next 3 dead", r.abortedAt, 5);
  eq("mixed — sincePoi is the post-reset first dead stop", r.abort?.sincePoi, "d3");
}

// ── 6. fail-soft: no telemetry (legacy pkg / eval failure) never aborts ────
{
  const route = Array.from({ length: 19 }, (_, i) => ({ poi: `x${i}`, noMove: true, recvMinMs: null }));
  const r = runRoute(route);
  eq("null recvMinMs (legacy pkg) — no abort", r.abortedAt, null);
  eq("null recvMinMs — live is the unknown tri-state (null)",
    r.lives.every((v) => v === null), true);
}
{
  // A null in the MIDDLE of a dead run also resets — we never abort on a gap
  // in the instrument.
  const r = runRoute([
    deadDup("d1"), deadDup("d2"), { poi: "gap", noMove: true, recvMinMs: null },
    deadDup("d3"), deadDup("d4"),
  ]);
  eq("null recvMinMs mid-run resets the streak", r.abortedAt, null);
}

// ── 7. threshold + landed-stop edges ───────────────────────────────────────
{
  const at = (recvMinMs) =>
    livenessStep({ streak: 0, firstPoi: null }, { poi: "p", noMove: true, recvMinMs }, OPTS).live;
  eq("recv age just under deadMs is live", at(14999), true);
  eq("recv age exactly deadMs is dead", at(15000), false);
  eq("recv age over deadMs is dead", at(15001), false);
  eq("u32::MAX (nothing ever received) is dead", at(4294967295), false);
  // A LANDED stop is alive by construction — the server moved us — even if the
  // recv sample happened to look stale.
  const l = livenessStep({ streak: 2, firstPoi: "d1" },
    { poi: "Arwic", noMove: false, recvMinMs: 99999 }, OPTS);
  eq("landed stop never counts toward the streak", l.abort, null);
  eq("landed stop resets state", l.state, { streak: 0, firstPoi: null });
}

// ── 8. the N knob is honoured ──────────────────────────────────────────────
{
  const route = Array.from({ length: 10 }, (_, i) => deadDup(`d${i}`));
  eq("stops=1 aborts on the first dead stop",
    runRoute(route, { stops: 1, deadMs: 15000 }).abortedAt, 0);
  eq("stops=5 aborts on the fifth",
    runRoute(route, { stops: 5, deadMs: 15000 }).abortedAt, 4);
  eq("recvDeadMs raised above the samples disarms the abort",
    runRoute(route, { stops: 3, deadMs: 120000 }).abortedAt, null);
}

console.log("==================================================");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
