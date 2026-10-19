// tests/rynth_route_point_nan.test.mjs — RYNTH-2 follow-up (2026-10-18 review
// §10.5 "Rynth"): route_model.normalizePoint mapped a NaN / non-numeric ew, ns
// or z to 0, so an `.af` NAV: point with a bad coordinate token, or a JSON
// route whose coordinate is null (how JSON carries a NaN), became a waypoint
// at 0N / 0E that the bot walks toward, with no warning.
//
// Now the point is refused (normalizePoint → null) and every caller drops it
// with a warning — the treatment RYNTH-2 gave a truncated `.nav` point; valid
// points are unchanged.
//   N1  normalizePoint: non-numeric / null / missing ew or ns, non-finite z → null;
//       an absent z is still 0; valid points (numeric strings included) unchanged
//   N2  `.af` NAV: import: the bad point is dropped with a warning; parseAfNavsVt
//       carries it per route and NavProfiles.importText surfaces it
//   N3  JSON route import: ActiveNav.load drops a null-coordinate point and says so
//   N4  writeNavVt names the reason for a point it does not write
//
// Exercises the REAL route_model, nav_profiles and active_nav.
// Run from apps/holtburger-web/:  node tests/rynth_route_point_nan.test.mjs

import assert from "node:assert/strict";

const { normalizePoint, makeRoute, POINT, ROUTE } = await import("../rynth/vt/nav/route_model.js");
const { parseAfNavsVt, writeNavVt, NavProfiles } = await import("../rynth/vt/nav/nav_profiles.js");
const { ActiveNav } = await import("../rynth/vt/nav/active_nav.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

function fakeStore() {
  const m = new Map();
  return {
    m,
    list: () => [...m.values()].map((v) => ({ name: v.name, savedAt: v.savedAt })),
    get: (k) => (m.has(k.toLowerCase()) ? JSON.parse(JSON.stringify(m.get(k.toLowerCase()))) : null),
    put: (k, v) => { m.set(k.toLowerCase(), JSON.parse(JSON.stringify(v))); return { ok: true }; },
    remove: (k) => { m.delete(k.toLowerCase()); return { ok: true }; },
  };
}

const at = (ew, ns, z = 0.1) => ({ type: POINT.Point, ew, ns, z });

await check("N1 normalizePoint refuses a non-numeric position, keeps valid points", () => {
  for (const [label, p] of [
    ["NaN ns", at(42.2, NaN)],
    ["non-numeric ew", at("forty", 41.9)],
    ["null ns (a JSON NaN)", at(42.2, null)],
    ["empty ew", at("", 41.9)],
    ["missing ns", { type: POINT.Point, ew: 42.2, z: 0 }],
    ["Infinity ew", at(Infinity, 41.9)],
    ["NaN z", at(42.2, 41.9, NaN)],
    ["null z", at(42.2, 41.9, null)],
    ["NaN on an action point", { type: POINT.Chat, ew: NaN, ns: 0, z: 0, chat: "hi" }],
  ]) {
    assert.equal(normalizePoint(p), null, label);
  }
  assert.deepEqual(normalizePoint(at(42.2, 41.9)), { type: 0, ew: 42.2, ns: 41.9, z: 0.1 });
  assert.deepEqual(normalizePoint({ type: POINT.Point, ew: 42.2, ns: 41.9 }), { type: 0, ew: 42.2, ns: 41.9, z: 0 }, "an absent z is 0");
  assert.deepEqual(normalizePoint(at("42.2", "41.9", "0.1")), { type: 0, ew: 42.2, ns: 41.9, z: 0.1 }, "numeric strings still read");
  assert.deepEqual(
    normalizePoint({ type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "hi" }),
    { type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "hi" },
    "the 0,0 action-point sentinel is a real 0, kept",
  );
  const r = makeRoute({ routeType: ROUTE.Linear, points: [at(33.6, 42.0), at(42.2, NaN), at(42.2, 41.9)] });
  assert.deepEqual(r.points.map((q) => [q.ew, q.ns]), [[33.6, 42.0], [42.2, 41.9]], "makeRoute drops it");
});

const AF = [
  "NAV: hunt linear ~~ {",
  "\tpnt 33.6 42.0 0.1",
  "\tpnt 42.2 forty-one 0.1", // a bad NS token
  "\tchk 42.3 41.9 0.1",
  "~~ }",
  "",
].join("\r\n");

await check("N2 `.af` NAV: import drops the bad point with a warning (not a waypoint at 0N)", () => {
  const navs = parseAfNavsVt(AF);
  assert.deepEqual(navs.hunt.points.map((q) => [q.type, q.ew, q.ns]), [[0, 33.6, 42.0], [8, 42.3, 41.9]], "no waypoint at 0N");
  assert.equal(navs.hunt.warnings.length, 1);
  assert.match(navs.hunt.warnings[0], /point 2: non-numeric position \(42\.2, NaN, 0\.1\); dropped/);
  const np = new NavProfiles({ store: fakeStore(), now: () => 1 });
  const r = np.importText("hunt", AF);
  assert.equal(r.ok, true, r.error);
  assert.match(r.warnings.join("\n"), /point 2: non-numeric position/, "the import surfaces it");
  assert.deepEqual(np.get("hunt").points.map((q) => [q.ew, q.ns]), [[33.6, 42.0], [42.3, 41.9]], "only the valid points are stored");
});

await check("N2b a clean `.af` NAV: imports with no warning and every point", () => {
  const clean = AF.replace("forty-one", "41.95");
  const navs = parseAfNavsVt(clean);
  assert.deepEqual(navs.hunt.warnings ?? [], []);
  assert.deepEqual(navs.hunt.points.map((q) => q.ns), [42.0, 41.95, 41.9]);
  const r = new NavProfiles({ store: fakeStore() }).importText("hunt", clean);
  assert.deepEqual(r.warnings, []);
});

await check("N3 JSON route import: ActiveNav.load drops a null-coordinate point and reports it", () => {
  const json = JSON.stringify({ routeType: ROUTE.Linear, points: [at(33.6, 42.0), at(42.2, NaN), at(42.2, 41.9)] });
  assert.match(json, /"ns":null/, "JSON writes the NaN as null");
  const nav = new ActiveNav({ log: () => {} });
  const r = nav.load(JSON.parse(json), { name: "imported" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(nav.state.route.points.map((q) => [q.ew, q.ns]), [[33.6, 42.0], [42.2, 41.9]], "no waypoint at 0N");
  assert.match(r.warnings.join("\n"), /1 waypoint\(s\) .*non-numeric position dropped/);
  assert.equal(nav.add(at(1, "x")), -1, "a hand-added point with a bad coordinate is refused");
  assert.equal(nav.updatePoint(0, { ns: NaN }).ok, false, "an edit to a non-numeric coordinate is refused");
  assert.deepEqual([nav.state.route.points[0].ew, nav.state.route.points[0].ns], [33.6, 42.0], "the point keeps its position");
});

await check("N4 writeNavVt names why it skips a point", () => {
  const { text, warnings } = writeNavVt({ routeType: ROUTE.Linear, points: [at(33.6, 42.0), at(42.2, NaN), { type: 42, ew: 1, ns: 1, z: 0 }] });
  assert.match(warnings[0], /^point 2: non-numeric position \(42\.2, NaN, 0\.1\) not written$/);
  assert.match(warnings[1], /^point 3: unknown waypoint type 42 not written$/);
  assert.match(text, /^uTank2 NAV 1\.2\r\n2\r\n1\r\n/, "one point written");
});

console.log(fail === 0 ? `rynth_route_point_nan: all ${pass} checks passed` : `rynth_route_point_nan: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
