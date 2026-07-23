#!/usr/bin/env node
// rynth_route_flags_test.cjs — direct-import unit tests for rynth/route_flags.js
// (owed follow-up, HANDOFF-remediation-2026-07-23 line 91: "route_flags.js has
// no direct-import coverage"). Pure function, no infra/network/wasm — exercises
// deriveRouteFlags's legacy geometric portal rule, the fmt===2 trust path, the
// nav-import ground-truth navType override, EnvCell indoor flagging, stale
// arrival-flag clearing, and input immutability. Mirrors the harness idiom of
// rynth_goto_compose_test.cjs (dynamic ESM import + check() counters).
//
// Run: node rynth_route_flags_test.cjs   (exits 1 on any FAIL)
// Auto-discovered + run by rynth_test_all_node.cjs (rynth_*_test.cjs glob).
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ── cell-id fixtures ─────────────────────────────────────────────────────────
// Cell id = 0xXXYYCCCC: XX = landblock x-byte, YY = landblock y-byte, CCCC =
// cell within the landblock. worldX = XX*192 + x-local; a LandCell (CCCC < 0x100)
// is outdoor, an EnvCell (CCCC >= 0x100) is indoor (isEnvCellId).
const OUT_A = 0x01010001; // lb x-byte 0x01, outdoor cell
const OUT_FAR = 0x05010001; // lb x-byte 0x05 -> (5-1)*192 = 768m from OUT_A (same local x)
const IN_CELL = 0x01010100; // low word 0x0100 -> EnvCell (indoor)

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "route_flags.js")).href);
  const { deriveRouteFlags, HOP_DISCONTINUITY_M } = mod;

  // 1. non-array input degrades to [] (never throws).
  check("non-array -> []",
    Array.isArray(deriveRouteFlags(null)) && deriveRouteFlags(null).length === 0 &&
    deriveRouteFlags(undefined).length === 0 && deriveRouteFlags("nope").length === 0);

  // 2. exported threshold constant.
  check("HOP_DISCONTINUITY_M === 500", HOP_DISCONTINUITY_M === 500, String(HOP_DISCONTINUITY_M));

  // 3. legacy: departure leg of a >=500m hop gets portal; last leg (no next) does not.
  {
    const legs = [{ lb: OUT_A, x: 10, y: 10 }, { lb: OUT_FAR, x: 10, y: 10 }];
    const out = deriveRouteFlags(legs); // fmt undefined -> legacy
    check("legacy hop: departure leg gets portal:true",
      out[0].portal === true, JSON.stringify(out[0]));
    check("legacy hop: last leg has no portal",
      out[1].portal === undefined, JSON.stringify(out[1]));
  }

  // 4. legacy: adjacent close legs (<500m) get no portal.
  {
    const legs = [{ lb: OUT_A, x: 10, y: 10 }, { lb: OUT_A, x: 20, y: 10 }];
    const out = deriveRouteFlags(legs);
    check("legacy close legs: no portal",
      out[0].portal === undefined && out[1].portal === undefined, JSON.stringify(out));
  }

  // 5. legacy: indoor EnvCell gets indoor:true; outdoor LandCell does not.
  {
    const out = deriveRouteFlags([{ lb: IN_CELL, x: 5, y: 5 }, { lb: OUT_A, x: 5, y: 5 }]);
    check("legacy indoor: EnvCell -> indoor:true", out[0].indoor === true, JSON.stringify(out[0]));
    check("legacy outdoor: LandCell -> no indoor", out[1].indoor === undefined, JSON.stringify(out[1]));
  }

  // 6. fmt===2 trusts recorded flags and ignores geometry / cell taxonomy.
  {
    // Two far-apart legs (would be geomPortal legacy) but fmt=2 with no l.portal.
    const geomWouldHop = deriveRouteFlags(
      [{ lb: OUT_A, x: 10, y: 10 }, { lb: OUT_FAR, x: 10, y: 10 }], 2);
    check("fmt2: geometry ignored (no recorded portal -> none)",
      geomWouldHop[0].portal === undefined, JSON.stringify(geomWouldHop[0]));
    // Close legs but recorded portal:true is trusted.
    const recorded = deriveRouteFlags(
      [{ lb: OUT_A, x: 10, y: 10, portal: true }, { lb: OUT_A, x: 20, y: 10 }], 2);
    check("fmt2: recorded portal:true trusted despite close neighbour",
      recorded[0].portal === true, JSON.stringify(recorded[0]));
    // EnvCell but no recorded indoor flag -> NOT indoor (fmt2 trusts l.indoor).
    const noIndoor = deriveRouteFlags([{ lb: IN_CELL, x: 5, y: 5 }], 2);
    check("fmt2: EnvCell without recorded indoor -> not indoor",
      noIndoor[0].indoor === undefined, JSON.stringify(noIndoor[0]));
  }

  // 7. legacy: nav-import ground-truth navType (prt/rcl/ptl) forces portal even
  // when the geometric neighbour is within 500m; a non-portal navType does not.
  {
    const gt = deriveRouteFlags([
      { lb: OUT_A, x: 10, y: 10, meta: { navType: "rcl" } },
      { lb: OUT_A, x: 20, y: 10 },
    ]);
    check("legacy ground-truth navType rcl forces portal on close leg",
      gt[0].portal === true, JSON.stringify(gt[0]));
    const notGt = deriveRouteFlags([
      { lb: OUT_A, x: 10, y: 10, meta: { navType: "run" } },
      { lb: OUT_A, x: 20, y: 10 },
    ]);
    check("legacy non-portal navType stays non-portal when close",
      notGt[0].portal === undefined, JSON.stringify(notGt[0]));
  }

  // 8. legacy: a stale recorded arrival portal flag is recomputed away.
  {
    const out = deriveRouteFlags([
      { lb: OUT_A, x: 10, y: 10, portal: true }, // stale arrival flag, not a real hop
      { lb: OUT_A, x: 20, y: 10 },
    ]);
    check("legacy clears stale arrival portal flag",
      out[0].portal === undefined, JSON.stringify(out[0]));
  }

  // 9. input legs are not mutated; a new array of new objects is returned.
  {
    const legs = [{ lb: OUT_A, x: 10, y: 10, portal: true }];
    const out = deriveRouteFlags(legs);
    check("input not mutated + returns new objects",
      legs[0].portal === true && out !== legs && out[0] !== legs[0], JSON.stringify({ in: legs[0], out: out[0] }));
  }

  console.log(`\nroute_flags: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
