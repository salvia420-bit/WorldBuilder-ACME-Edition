#!/usr/bin/env node
// rynth_navimport_test.cjs — unit tests for rynth/nav_import.js (the actual
// import PATH from a VTank/uTank2 .nav/.af file to a named, walkable atlas
// route — nav_file.js is only the validated format parser; this module wires
// it to atlas.js). REAL VTank routes (rynth/testdata/*.nav) drive the fixture
// import checks; synthetic cases cover the full record-type mapping table
// (pnt/prt/rcl/pau/cht/vnd/ptl/tlk/chk/jmp) and warning-on-unknown-type
// behavior. No browser/wasm.
//
// Run: node rynth_navimport_test.cjs   (exits 1 on any FAIL)
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
async function t(id, name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${id} ${name}: ${e.message}`);
  }
}

const FIXTURES = path.join(__dirname, "rynth", "testdata");

// ── synthetic multi-record .nav builder (mirrors nav_file.js's writeNav
// shape so we can hand-construct exact trailer lines per NavPointType) ──────
function navText(points, { routeType = 4 } = {}) {
  const lines = ["uTank2 NAV 1.2", String(routeType), String(points.length)];
  for (const p of points) {
    lines.push(String(p.type), String(p.ew ?? 0), String(p.ns ?? 0), String(p.z ?? 0), "0");
    lines.push(...(p.trailer || []));
  }
  return lines.join("\r\n") + "\r\n";
}

(async () => {
  const NI = await import(pathToFileURL(path.join(__dirname, "rynth", "nav_import.js")).href);
  const NF = await import(pathToFileURL(path.join(__dirname, "rynth", "nav_file.js")).href);
  const AtlasMod = await import(pathToFileURL(path.join(__dirname, "rynth", "atlas.js")).href);
  const { Atlas } = AtlasMod;

  // ── real fixtures: import path end to end ─────────────────────────────────
  for (const file of ["HoltburgTest.nav", "muleall.nav", "MatronHive.nav"]) {
    await t(`FX-${file}`, `real fixture imports cleanly (legs == points, no parser warning)`, () => {
      const text = fs.readFileSync(path.join(FIXTURES, file), "utf8");
      const parsed = NF.parseNav(text);
      const { route, warnings } = NI.importNavText(text, { name: file, fileName: file });
      assert.ok(route, "route built");
      assert.equal(route.legs.length, parsed.points.length, "one leg per point");
      assert.ok(!warnings.some((w) => w.startsWith("parser:")), `no parser warning: ${JSON.stringify(warnings)}`);
      assert.equal(route.source, "vtank-nav");
      assert.equal(route.fmt, 2);
      assert.deepEqual(route.provenance && route.provenance.fileName, file);
      assert.ok(Number.isFinite(route.provenance.importedAt));
    });
  }

  await t("HB1", "HoltburgTest: first leg lands in Holtburg (lb 0xA9B4), sanity-checked coord", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "HoltburgTest.nav"), "utf8");
    const { route } = NI.importNavText(text, { name: "holtburg" });
    const leg0 = route.legs[0];
    assert.equal((leg0.lb >>> 16) & 0xffff, 0xa9b4, `expected Holtburg lb, got 0x${((leg0.lb >>> 16) & 0xffff).toString(16)}`);
    assert.ok(leg0.x >= 0 && leg0.x < 192 && leg0.y >= 0 && leg0.y < 192, "local coords in-landblock");
  });

  await t("MH1", "MatronHive: PortalNPC/Recall waypoints -> portal-flagged legs with ptl/rcl meta", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "MatronHive.nav"), "utf8");
    const { route } = NI.importNavText(text, { name: "matron-hive" });
    const portalLegs = route.legs.filter((l) => l.portal);
    assert.ok(portalLegs.length >= 4, `expected >=4 portal legs (1 recall + 3 portalNPC), got ${portalLegs.length}`);
    const ptl = route.legs.find((l) => l.meta && l.meta.navType === "ptl");
    assert.ok(ptl, "has a ptl-mapped leg");
    assert.ok(ptl.meta.objName, "ptl leg carries the NPC/portal object name");
    assert.ok(ptl.meta.objPos && Number.isFinite(ptl.meta.objPos.x) && Number.isFinite(ptl.meta.objPos.lb), "ptl leg carries a world-frame objPos {lb,x,y,z}");
    const rcl = route.legs.find((l) => l.meta && l.meta.navType === "rcl");
    assert.ok(rcl && rcl.meta.spellId === 1636, `recall spellId preserved, got ${rcl && rcl.meta.spellId}`);
    assert.equal(rcl.meta.spellName, "Lifestone Sending", `recall spellName resolved from RECALL_SPELL_NAMES, got ${rcl.meta.spellName}`);
    assert.equal(route.portalsUsed, portalLegs.length);
  });

  await t("MH2", "MatronHive: leg-8 'Portal to Town Network' objPos is the REAL object position, ~27m from the recorded approach-point anchor (live replay finding)", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "MatronHive.nav"), "utf8");
    const { route } = NI.importNavText(text, { name: "matron-hive-leg8" });
    const leg8 = route.legs[8];
    assert.ok(leg8.meta && leg8.meta.navType === "ptl", `leg 8 is the ptl record, got ${leg8.meta && leg8.meta.navType}`);
    assert.equal(leg8.meta.objName, "Portal to Town Network");
    assert.equal(leg8.meta.objectClass, 14, "portal objectClass");
    assert.equal(leg8.meta.isTie, true);
    // The leg's OWN coordinate is the approach point (reused from leg 0's
    // recall anchor, per VTank's ptl-record convention) — objPos must be a
    // DIFFERENT, real position (world-frame conversion of the trailer's
    // objx/objy/objz), not a copy of the leg anchor.
    const worldX = (lb, x) => ((lb >>> 24) & 0xff) * 192 + x;
    const worldY = (lb, y) => ((lb >>> 16) & 0xff) * 192 + y;
    const legWx = worldX(leg8.lb, leg8.x), legWy = worldY(leg8.lb, leg8.y);
    const objWx = worldX(leg8.meta.objPos.lb, leg8.meta.objPos.x), objWy = worldY(leg8.meta.objPos.lb, leg8.meta.objPos.y);
    const dist = Math.hypot(objWx - legWx, objWy - legWy);
    assert.ok(dist > 15 && dist < 40, `expected objPos ~27m from the leg anchor (VTank hub-reuse pattern), got ${dist.toFixed(1)}m`);
    // Cross-checked against a manual navPointToLeg conversion of the raw
    // trailer coords (56.7764208475749, 33.4926058292389, 0.175825029611588).
    assert.ok(Math.abs(objWx - 38094.341) < 0.01 && Math.abs(objWy - 32506.225) < 0.01, `objPos world coords, got (${objWx},${objWy})`);
  });

  await t("AT1", "importNavText({atlas}) saves into the atlas — listable + followable by name", () => {
    const atlas = new Atlas({});
    const text = fs.readFileSync(path.join(FIXTURES, "HoltburgTest.nav"), "utf8");
    const { route, warnings } = NI.importNavText(text, { name: "holtburg-loop", atlas, fileName: "HoltburgTest.nav" });
    assert.ok(!warnings.length || warnings.every((w) => typeof w === "string"), "warnings well-formed");
    assert.ok(route.id, "atlas assigned an id");
    const back = atlas.getRoute("holtburg-loop");
    assert.ok(back, "route retrievable by name");
    assert.equal(back.legs.length, route.legs.length);
    const rows = atlas.summaries();
    assert.ok(rows.some((r) => r.name === "holtburg-loop"), "listed in summaries()");
  });

  // ── synthetic: the FULL record-type mapping table (one of each) ───────────
  await t("MAP1", "every NavPointType maps to a leg with the right meta.navType (nothing silently dropped)", () => {
    const points = [
      { type: 0, ew: 10, ns: 10, z: 1, trailer: [] }, // pnt
      { type: 1, ew: 10.1, ns: 10, z: 1, trailer: ["777"] }, // prt (guid=777)
      { type: 2, ew: 10.2, ns: 10, z: 1, trailer: ["1636"] }, // rcl (spellId=1636)
      { type: 3, ew: 10.3, ns: 10, z: 1, trailer: ["5000"] }, // pau (pauseMs=5000)
      { type: 4, ew: 10.4, ns: 10, z: 1, trailer: ["/t hello"] }, // cht
      { type: 5, ew: 10.5, ns: 10, z: 1, trailer: ["42", "Fredere"] }, // vnd
      { type: 6, ew: 10.6, ns: 10, z: 1, trailer: ["Town Network", "14", "True", "11", "12", "1"] }, // ptl
      { type: 7, ew: 10.7, ns: 10, z: 1, trailer: ["Some NPC", "37", "False", "0", "0", "0"] }, // tlk
      { type: 8, ew: 10.8, ns: 10, z: 1, trailer: [] }, // chk
      { type: 9, ew: 10.9, ns: 10, z: 1, trailer: ["185", "True", "400"] }, // jmp
    ];
    const text = navText(points);
    const parsed = NF.parseNav(text);
    assert.equal(parsed.warning, null, `clean synthetic parse: ${parsed.warning}`);
    assert.equal(parsed.points.length, points.length, "all 10 synthetic points parsed");

    const { route, warnings } = NI.importNavText(text, { name: "type-coverage" });
    assert.equal(route.legs.length, 10);
    const navTypes = route.legs.map((l) => (l.meta ? l.meta.navType : "pnt"));
    assert.deepEqual(navTypes, ["pnt", "prt", "rcl", "pau", "cht", "vnd", "ptl", "tlk", "chk", "jmp"], JSON.stringify(navTypes));

    // ground-truth portal types
    assert.deepEqual(route.legs.map((l) => !!l.portal), [false, true, true, false, false, false, true, false, false, false]);

    // field preservation spot-checks
    assert.equal(route.legs[1].meta.guid, 777);
    assert.equal(route.legs[2].meta.spellId, 1636);
    assert.equal(route.legs[2].meta.spellName, "Lifestone Sending");
    assert.equal(route.legs[3].meta.pauseMs, 5000);
    assert.equal(route.legs[4].meta.text, "/t hello");
    assert.equal(route.legs[5].meta.vendorId, 42);
    assert.equal(route.legs[5].meta.name, "Fredere");
    assert.equal(route.legs[6].meta.objName, "Town Network");
    assert.equal(route.legs[6].meta.objectClass, 14);
    assert.equal(route.legs[6].meta.isTie, true);
    assert.ok(route.legs[6].meta.objPos && Number.isFinite(route.legs[6].meta.objPos.x), "ptl leg carries a world-frame objPos");
    assert.equal(route.legs[7].meta.objName, "Some NPC");
    assert.ok(route.legs[7].meta.objPos && Number.isFinite(route.legs[7].meta.objPos.y), "tlk leg also carries objPos");
    assert.equal(route.legs[9].meta.headingDeg, 185);
    assert.equal(route.legs[9].meta.holdShift, true);
    assert.equal(route.legs[9].meta.delayMs, 400);

    // jmp is preserved but flagged with a loud warning (no walk primitive)
    assert.ok(warnings.some((w) => /Jump record/.test(w) && /leg 9/.test(w)), `expected a jmp warning: ${JSON.stringify(warnings)}`);
    // rcl legs get a route-level recall-dependency notice (import-time warning)
    assert.ok(warnings.some((w) => /leg 2/.test(w) && /recall spell/.test(w) && /Lifestone Sending/.test(w)), `expected a recall-dependency warning: ${JSON.stringify(warnings)}`);
    // exactly the jmp + rcl warnings on this clean, fully-known-type file
    assert.equal(warnings.length, 2, `expected exactly 2 warnings (rcl dependency + jmp), got: ${JSON.stringify(warnings)}`);
  });

  // ── synthetic: portal + pause + chat, the addendum's minimal multi-record case ──
  await t("MIX1", "portal + pause + chat mix: correct mapping, portal flag, no warnings", () => {
    const points = [
      { type: 0, ew: 20, ns: 20, z: 1, trailer: [] },
      { type: 6, ew: 20.1, ns: 20, z: 1, trailer: ["Some Portal", "14", "True", "-101.6", "-96.6", "0"] },
      { type: 3, ew: 20.2, ns: 20, z: 1, trailer: ["2000"] },
      { type: 4, ew: 20.3, ns: 20, z: 1, trailer: ["/vt opt set foo true"] },
    ];
    const text = navText(points);
    const { route, warnings } = NI.importNavText(text, { name: "mix" });
    assert.equal(route.legs.length, 4);
    assert.deepEqual(route.legs.map((l) => !!l.portal), [false, true, false, false]);
    assert.deepEqual(route.legs.map((l) => (l.meta ? l.meta.navType : "pnt")), ["pnt", "ptl", "pau", "cht"]);
    assert.equal(warnings.length, 0, `expected no warnings on a clean known-type file: ${JSON.stringify(warnings)}`);
  });

  // ── unknown type: preserved (not dropped) + loud warning, truncates cleanly ──
  await t("UNK1", "a genuinely unknown numeric type is preserved as meta + warned, route not silently truncated to nothing", () => {
    const points = [
      { type: 0, ew: 30, ns: 30, z: 1, trailer: [] },
      { type: 42, ew: 30.1, ns: 30, z: 1, trailer: [] }, // stops nav_file's own parser here (unknown type)
    ];
    const text = navText(points);
    const { route, warnings } = NI.importNavText(text, { name: "unk" });
    // nav_file.js's parser itself stops BEFORE the unknown-type point (contract:
    // never desync mid-file) — so only the first point survives, but the import
    // must say so loudly, not just silently hand back a 1-leg route.
    assert.equal(route.legs.length, 1, "parser stopped before the unknown point");
    assert.ok(warnings.some((w) => /^parser:/.test(w) && /unknown waypoint type 42/.test(w)), `expected a parser warning: ${JSON.stringify(warnings)}`);
  });

  // ── embedded .af: multi-section import, one route per NAV: section ───────
  await t("AF1", "importAfText: NAV: token section(s) -> named routes, jmp/chk not silently dropped", () => {
    const af = [
      "NAV: patrol circular ~~ {",
      "pnt 33.6 42.08 0.39",
      "chk 33.7 42.1 0.39",
      "jmp 33.8 42.2 0.39 90 {True} 300",
      "pau 5",
      "rcl 33.6 42.08 0.39 {Lifestone Recall}",
      "~~ }",
    ].join("\n");
    const { routes, warnings } = NI.importAfText(af, { fileName: "synthetic.af" });
    assert.equal(warnings.length, 0, `no top-level warnings: ${JSON.stringify(warnings)}`);
    assert.equal(routes.length, 1);
    const r = routes[0];
    assert.equal(r.name, "patrol");
    assert.ok(r.route, "route built");
    assert.equal(r.route.legs.length, 5, `pnt,chk,jmp,pau,rcl = 5 legs, got ${r.route.legs.length}`);
    const navTypes = r.route.legs.map((l) => (l.meta ? l.meta.navType : "pnt"));
    assert.deepEqual(navTypes, ["pnt", "chk", "jmp", "pau", "rcl"], JSON.stringify(navTypes));
    assert.ok(r.warnings.some((w) => /Jump record/.test(w)), "jmp warning present in the per-route warnings");
    assert.ok(r.route.legs[4].portal, "rcl leg is portal-flagged");
    assert.equal(r.route.legs[4].meta.spellId, 1635, "lifestone recall id resolved by name");
  });

  await t("AF2", "importAfText({atlas}): each NAV: section becomes its own saved atlas route", () => {
    const atlas = new Atlas({});
    const af = [
      "NAV: navNone once ~~{",
      "pau 0 0 -1000 1000000",
      "~~}",
      "NAV: navJump once ~~ {",
      "chk 1 2 0.1",
      "jmp 1.1 2.1 0.1 185 {True} 400",
      "~~}",
    ].join("\n");
    const { routes } = NI.importAfText(af, { atlas, namePrefix: "bridge" });
    assert.equal(routes.length, 2);
    assert.ok(atlas.getRoute("bridge:navNone"), "navNone route saved under its prefixed name");
    assert.ok(atlas.getRoute("bridge:navJump"), "navJump route saved under its prefixed name");
  });

  // ── indoor flag never fires on nav-imported legs (format edge case) ──────
  await t("IND1", "nav-imported legs are always outdoor-frame (navPointToLeg has no EnvCell concept) — indoor never set", () => {
    const text = fs.readFileSync(path.join(FIXTURES, "MatronHive.nav"), "utf8");
    const { route } = NI.importNavText(text, { name: "mh-indoor-check" });
    assert.ok(!route.legs.some((l) => l.indoor), "no leg carries indoor:true (VTank .nav coordinates are outdoor-projected only)");
  });

  console.log(`\nnav_import: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
