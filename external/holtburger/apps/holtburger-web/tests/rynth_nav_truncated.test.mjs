// tests/rynth_nav_truncated.test.mjs — RYNTH-2 (2026-10-18 review): a .nav
// cut off mid-point (or with a non-numeric position line) stops with a
// warning and drops the partial point; it never becomes a waypoint at 0N /
// 0E / z 0 that the VT import accepts silently.
//
// Exercises the REAL nav_file.parseNav / writeNav and the VT import
// (nav_profiles.parseNavVt → route_model.normalizePoint).
//
// Run from apps/holtburger-web/:  node tests/rynth_nav_truncated.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { parseNav, writeNav } = await import("../rynth/nav_file.js");
const { parseNavVt } = await import("../rynth/vt/nav/nav_profiles.js");

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

const nav = (lines) => lines.join("\r\n") + "\r\n";
// A 2-point Linear route: (33.6E, 42.0N) then (42.2E, 41.9N).
const FULL = ["uTank2 NAV 1.2", "2", "2", "0", "33.6", "42.0", "0.1", "0", "0", "42.2", "41.9", "0.1", "0"];

await check("control: the whole file parses with no warning", () => {
  const p = parseNav(nav(FULL));
  assert.equal(p.warning, null);
  assert.equal(p.points.length, 2);
  const r = parseNavVt(nav(FULL));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.route.points.map((q) => [q.ew, q.ns]), [[33.6, 42.0], [42.2, 41.9]]);
});

await check("cut after the 2nd point's EW line: the partial point is dropped with a warning (not 42.2E 0N z 0)", () => {
  const text = nav(FULL.slice(0, 10));
  const p = parseNav(text);
  assert.equal(p.points.length, 1, "only the complete point");
  assert.match(p.warning || "", /point 2 .*file ended mid-point; stopped \(1 pts\)/);
  for (const q of p.points) assert.ok(Number.isFinite(q.ew) && Number.isFinite(q.ns) && Number.isFinite(q.z));
  const r = parseNavVt(text);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1, "the import surfaces the stop");
  assert.match(r.warnings[0], /file ended mid-point/);
  assert.deepEqual(r.route.points.map((q) => [q.ew, q.ns, q.z]), [[33.6, 42.0, 0.1]], "no waypoint at 0N");
});

await check("the cut point's lines stay in `tail`, so writeNav still round-trips byte-for-byte", () => {
  for (const cut of [9, 10, 11, 12]) {
    const text = nav(FULL.slice(0, cut));
    const p = parseNav(text);
    assert.equal(p.points.length, 1, `cut ${cut}`);
    assert.deepEqual(p.tail, FULL.slice(8, cut), `cut ${cut}: tail`);
    assert.equal(writeNav(p), text, `cut ${cut}: round trip`);
  }
});

await check("a Jump point cut inside its trailer is dropped (no delayMs 0 jump)", () => {
  const jump = ["uTank2 NAV 1.2", "4", "2", "0", "33.6", "42.0", "0.1", "0", "9", "33.6", "42.0", "0.1", "0", "90", "False"];
  const r = parseNavVt(nav(jump));
  assert.equal(r.ok, true);
  assert.equal(r.route.points.length, 1);
  assert.equal(r.route.points[0].type, 0);
  assert.match(r.warnings.join("\n"), /point 2 .*file ended mid-point/);
  const whole = parseNavVt(nav([...jump, "750"]));
  assert.deepEqual(whole.warnings, []);
  assert.equal(whole.route.points[1].delayMs, 750);
});

await check("a non-numeric position line stops the same way (never a 0 coordinate)", () => {
  const bad = FULL.slice();
  bad[10] = "forty-one"; // the 2nd point's NS line
  const p = parseNav(nav(bad));
  assert.equal(p.points.length, 1);
  assert.match(p.warning || "", /point 2 .*non-numeric position/);
  const r = parseNavVt(nav(bad));
  assert.deepEqual(r.route.points.map((q) => [q.ew, q.ns]), [[33.6, 42.0]]);
  assert.match(r.warnings.join("\n"), /non-numeric position/);
});

await check("the repo's real VTank .nav fixtures still parse whole, with no warning", () => {
  for (const f of ["../rynth/testdata/vt/nav/typed_points.nav", "../rynth/testdata/vt/nav/VRTreeJump500Rat.nav", "../rynth/testdata/MatronHive.nav"]) {
    const text = readFileSync(path.join(HERE, f), "latin1");
    const p = parseNav(text);
    assert.equal(p.warning, null, f);
    assert.equal(p.points.length, p.pointCount, f);
    assert.equal(writeNav(p), text, `${f}: round trip`);
  }
});

console.log(fail === 0 ? `rynth_nav_truncated: all ${pass} checks passed` : `rynth_nav_truncated: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
