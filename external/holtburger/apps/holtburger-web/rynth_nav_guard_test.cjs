#!/usr/bin/env node
// rynth_nav_guard_test.cjs (WP-9) — unit tests for rynth/nav_guard.js, the pure
// nav *shield* in front of every indoor leg issuance. Verifies:
//   1. sub-floor-Z guard (C6): an EnvCell pose strictly BELOW the floor plane
//      is un-solved -> PARK; z AT the plane (exact faithful settle, decomp-
//      verified 2026-07-21) and z=0.005 both PROCEED; outdoor z≈0 is exempt;
//      floorPlaneZ is honored.
//   2. landblock-legality guard (C7): a direct indoor->indoor cross-landblock
//      leg is REJECTED; within-LB / indoor<->outdoor legs pass.
//   3. legalIndoorReroute picks the PORTAL exit (findExitPath, injected from
//      the REAL indoor_router.js) instead of the rejected direct cross-LB leg.
//   4. indoor_router.js re-exports the SAME guard bindings (this.ir.guardLeg).
//   5. bot.js ExplorePressureController wiring: a sub-floor (z<plane−ε)
//      EnvCell pose + a guardLeg-carrying ir PARKS (no MoveToPosition, journal
//      says un-solved); z=5 and z=0 (at-plane settle) PROCEED; and a
//      guardLeg-LESS ir degrades to today's behavior.
//
// No infra, no network, no DOM — pure JS + a mocked host/router/bot. The clock
// is injected (opts.now). Run: node rynth_nav_guard_test.cjs (exits 1 on FAIL).

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const imp = (...rel) => import(pathToFileURL(path.join(__dirname, ...rel)).href);

// ── landblock/cell fixtures ──────────────────────────────────────────────────
const LB_A = 0x01ad0000, LB_B = 0x01ae0000;
const A1 = (LB_A | 0x100) >>> 0, A2 = (LB_A | 0x101) >>> 0; // EnvCells, landblock A
const B1 = (LB_B | 0x100) >>> 0;                            // EnvCell, landblock B
const OUT_A = (LB_A | 0x0015) >>> 0;                        // outdoor LandCell in A
const OUT_B = (LB_B | 0x0007) >>> 0;                        // outdoor LandCell in B

(async () => {
  const ng = await imp("rynth", "nav_guard.js");
  const ir = await imp("rynth", "indoor_router.js");

  // ── 0. module shape ────────────────────────────────────────────────────────
  for (const fn of ["guardLeg", "isSubFloorZ", "isCrossLandblockIndoor", "legalIndoorReroute"])
    check(`export: ${fn}`, typeof ng[fn] === "function");
  check("const FLOOR_EPSILON === 0.0002", ng.FLOOR_EPSILON === 0.0002);
  check("const FLOOR_PLANE_Z === 0", ng.FLOOR_PLANE_Z === 0);
  check("MSG_UNSOLVED text", ng.MSG_UNSOLVED === "NAV: pose un-solved (sub-floor z), holding");
  check("MSG_CROSS_LB text", ng.MSG_CROSS_LB === "NAV: no legal path this landblock");

  // ── 1. isSubFloorZ (EnvCell-only) ──────────────────────────────────────────
  check("subfloor: EnvCell z=0 (at-plane faithful settle) -> solved", ng.isSubFloorZ(A1, 0) === false);
  check("subfloor: EnvCell z=-0.0001 (within tolerance below plane) -> solved", ng.isSubFloorZ(A1, -0.0001) === false);
  check("subfloor: EnvCell z=-0.001 (beyond tolerance below plane) -> un-solved", ng.isSubFloorZ(A1, -0.001) === true);
  check("subfloor: EnvCell z=0.005 -> solved", ng.isSubFloorZ(A1, 0.005) === false);
  check("subfloor: EnvCell z=5 -> solved", ng.isSubFloorZ(A1, 5) === false);
  check("subfloor: EnvCell z=-3 -> un-solved (below default plane)", ng.isSubFloorZ(A1, -3) === true);
  check("subfloor: EnvCell non-finite z -> un-solved", ng.isSubFloorZ(A1, NaN) === true);
  check("subfloor: EnvCell missing z -> un-solved", ng.isSubFloorZ(A1, undefined) === true);
  check("subfloor: OUTDOOR z=0 is EXEMPT (real ground)", ng.isSubFloorZ(OUT_A, 0) === false);
  check("subfloor: unresolved id 0 is exempt", ng.isSubFloorZ(0, 0) === false);
  // floorPlaneZ honored: a cell whose real floor is z=100 flags z=99, allows z=100 (at plane) and z=101.
  check("subfloor: floorPlaneZ=100 flags z=99", ng.isSubFloorZ(A1, 99, 100) === true);
  check("subfloor: floorPlaneZ=100 allows z=100 (at plane)", ng.isSubFloorZ(A1, 100, 100) === false);
  check("subfloor: floorPlaneZ=100 allows z=101", ng.isSubFloorZ(A1, 101, 100) === false);

  // ── 2. isCrossLandblockIndoor ──────────────────────────────────────────────
  check("crossLB: two EnvCells, different LB -> true", ng.isCrossLandblockIndoor(A1, B1) === true);
  check("crossLB: two EnvCells, same LB -> false", ng.isCrossLandblockIndoor(A1, A2) === false);
  check("crossLB: indoor -> outdoor is NOT this rule", ng.isCrossLandblockIndoor(A1, OUT_B) === false);
  check("crossLB: outdoor -> indoor is NOT this rule", ng.isCrossLandblockIndoor(OUT_A, B1) === false);
  check("crossLB: two OUTDOOR cells, diff LB -> false (indoor-only rule)", ng.isCrossLandblockIndoor(OUT_A, OUT_B) === false);

  // ── 3. guardLeg verdicts (the shield) ──────────────────────────────────────
  // sub-floor (z below plane−ε) EnvCell pose -> PARK, no leg.
  {
    const v = ng.guardLeg({ cellId: A1, z: -0.01 }, { cellId: A1, z: -0.01 });
    check("guardLeg: sub-floor EnvCell pose -> park (unsolved)", v.ok === false && v.reason === ng.NAV_UNSOLVED);
    check("guardLeg: sub-floor EnvCell pose -> MSG_UNSOLVED", v.message === ng.MSG_UNSOLVED);
  }
  // z=0 (at-plane faithful settle) and z=0.005 both PROCEED.
  {
    const v = ng.guardLeg({ cellId: A1, z: 0 }, { cellId: A2, z: 0 });
    check("guardLeg: z=0 at-plane same-LB indoor -> ok (proceeds)", v.ok === true && v.reason === ng.NAV_OK);
  }
  {
    const v = ng.guardLeg({ cellId: A1, z: 0.005 }, { cellId: A2, z: 0.005 });
    check("guardLeg: z=0.005 same-LB indoor -> ok (proceeds)", v.ok === true && v.reason === ng.NAV_OK);
    check("guardLeg: ok verdict carries no message", v.message === undefined);
  }
  // a solved TARGET but un-solved START still parks (don't path FROM it).
  {
    const v = ng.guardLeg({ cellId: A1, z: -0.01 }, { cellId: A2, z: 5 });
    check("guardLeg: solved target but sub-floor start -> still parks", v.ok === false && v.reason === ng.NAV_UNSOLVED);
  }
  // a solved START but un-solved TARGET parks (don't path TO it).
  {
    const v = ng.guardLeg({ cellId: A1, z: 5 }, { cellId: A2, z: -0.01 });
    check("guardLeg: solved start but sub-floor target -> parks", v.ok === false && v.reason === ng.NAV_UNSOLVED);
  }
  // cross-LB direct leg REJECTED (both solved z).
  {
    const v = ng.guardLeg({ cellId: A1, z: 5 }, { cellId: B1, z: 5 });
    check("guardLeg: indoor cross-LB direct leg -> rejected (cross_lb)", v.ok === false && v.reason === ng.NAV_CROSS_LB);
    check("guardLeg: cross_lb -> MSG_CROSS_LB", v.message === ng.MSG_CROSS_LB);
  }
  // sub-floor is checked BEFORE cross-LB: a sub-floor endpoint on a cross-LB pair is "unsolved", not "cross_lb".
  {
    const v = ng.guardLeg({ cellId: A1, z: -0.01 }, { cellId: B1, z: 5 });
    check("guardLeg: sub-floor endpoint on a cross-LB pair -> unsolved (priority)", v.reason === ng.NAV_UNSOLVED);
  }
  // within-LB solved indoor leg -> ok. indoor<->outdoor -> ok (portal transition).
  check("guardLeg: within-LB solved indoor -> ok", ng.guardLeg({ cellId: A1, z: 5 }, { cellId: A2, z: 5 }).ok === true);
  check("guardLeg: indoor->outdoor (portal transition) -> ok", ng.guardLeg({ cellId: A1, z: 5 }, { cellId: OUT_B, z: 12 }).ok === true);
  // accepts a router-leg shape ({lb}) as well as a pose ({objCellId}).
  check("guardLeg: accepts {lb} leg shape", ng.guardLeg({ objCellId: A1, z: 5 }, { lb: B1, z: 5 }).reason === ng.NAV_CROSS_LB);
  // never throws on junk.
  {
    let threw = false;
    try { ng.guardLeg(null, undefined); ng.guardLeg({}, {}); ng.guardLeg({ cellId: -1 }, { cellId: NaN }); }
    catch { threw = true; }
    check("guardLeg: never throws on junk input", threw === false);
    check("guardLeg: empty objects -> ok (no indoor endpoints)", ng.guardLeg({}, {}).ok === true);
  }

  // ── 4. legalIndoorReroute: reject direct cross-LB, SELECT the portal exit ───
  {
    // two-indoor-LB graph: landblock A (A1<->A2) has an outdoor exit portal on
    // A1; landblock B (B1) is a separate block. A direct A1->B1 leg is illegal.
    const graph = new Map([
      [A1, { pos: { x: 202, y: 33221, z: 5 }, neighbors: [A2], exits: [OUT_A] }],
      [A2, { pos: { x: 226, y: 33221, z: 5 }, neighbors: [A1] }],
      [B1, { pos: { x: 10, y: 33413, z: 5 }, neighbors: [] }],
    ]);
    // guardLeg first refuses the direct cross-seam leg...
    check("two-LB: direct A1->B1 leg rejected", ng.guardLeg({ cellId: A1, z: 5 }, { cellId: B1, z: 5 }).reason === ng.NAV_CROSS_LB);
    // ...then the reroute selects the portal exit within landblock A.
    const exit = ng.legalIndoorReroute(ir, graph, A1, {});
    check("two-LB: reroute returns a portal route", exit !== null && Array.isArray(exit.path) && exit.path.length >= 1);
    check("two-LB: reroute exitCell is the portal cell A1", exit && (exit.exitCell >>> 0) === A1);
    check("two-LB: reroute selects the outdoor portal id (OUT_A)", exit && (exit.outdoorId >>> 0) === OUT_A);
    // the emitted leg stays INSIDE landblock A (never a cross-LB leg).
    const legs = ir.toLegs(graph, exit.path);
    const legLb = (legs[legs.length - 1].lb >>> 16) & 0xffff;
    check("two-LB: reroute leg stays in landblock A (not cross-seam)", legLb === ((LB_A >>> 16) & 0xffff));
    // reroute is null-safe: no findExitPath / no exits known -> null (never throws).
    check("reroute: null ir -> null", ng.legalIndoorReroute(null, graph, A1) === null);
    check("reroute: ir without findExitPath -> null", ng.legalIndoorReroute({}, graph, A1) === null);
    const noExit = new Map([[A1, { pos: { x: 0, y: 0, z: 5 }, neighbors: [A2] }], [A2, { pos: { x: 24, y: 0, z: 5 }, neighbors: [A1] }]]);
    check("reroute: graph with no exits -> null", ng.legalIndoorReroute(ir, noExit, A1) === null);
  }

  // ── 5. production merge mechanism: createGrindBot folds the guard into the
  //      indoor-router namespace the controller reads as `this.ir` (bot.js:
  //      `{ ...irMod, guardLeg, legalIndoorReroute }`). indoor_router.js stays
  //      import-free (its tmpdir-copy sim copies only that one file), so verify
  //      the SPREAD preserves every indoor_router export AND adds the guard. ──
  {
    const merged = { ...ir, guardLeg: ng.guardLeg, legalIndoorReroute: ng.legalIndoorReroute };
    check("merge: guardLeg is the nav_guard binding", merged.guardLeg === ng.guardLeg);
    check("merge: legalIndoorReroute is the nav_guard binding", merged.legalIndoorReroute === ng.legalIndoorReroute);
    check("merge: indoor_router.findExitPath survives the spread", merged.findExitPath === ir.findExitPath);
    check("merge: indoor_router.buildGraphFromWasm survives the spread", merged.buildGraphFromWasm === ir.buildGraphFromWasm);
    check("merge: indoor_router.isEnvCellId survives the spread", merged.isEnvCellId === ir.isEnvCellId);
    // indoor_router.js must remain import-free (no accidental guard re-export).
    check("indoor_router does NOT re-export guardLeg (stays import-free)", ir.guardLeg === undefined);
  }

  // ── 6. bot.js ExplorePressureController wiring (mocked host/bot/router) ──────
  {
    const bot = await imp("rynth", "bot.js");
    const { ExplorePressureController } = bot;
    check("bot.js exports ExplorePressureController", typeof ExplorePressureController === "function");

    const now = 5_000_000;
    const clock = () => now;
    const isEnv = (id) => { const lo = (id >>> 0) & 0xffff; return lo >= 0x100 && lo <= 0xfffd; };
    const graph = new Map([
      [A1, { pos: { x: 200, y: 32450, z: 5 }, neighbors: [A2] }],
      [A2, { pos: { x: 224, y: 32450, z: 5 }, neighbors: [A1] }],
    ]);
    const mkHost = (pose) => {
      const moves = [];
      return {
        _pose: pose, s: {},
        TryGetPlayerPose() { return this._pose; },
        MoveToPosition(lb, x, y, z, run) { moves.push({ lb, x, y, z, run }); },
        NearbyGuids: () => [], TryGetObjectDescFlags: () => 0,
        TryGetObjectPosition: () => null, TryGetObjectName: () => null,
        UseObject: () => true, InvokeChatParser: () => {}, _moves: moves,
      };
    };
    const mkBot = () => {
      const notes = [];
      return {
        ai: {
          director: { enabled: true, isBusy: () => false, get lastCheckAt() { return null; } },
          journal: { add: (kind, text) => notes.push({ kind, text: String(text) }) },
          extensions: undefined,
        },
        globalRouter: { busy: false },
        lastMission: null,
        goto: () => Promise.resolve({ ok: true }),
        travel: () => ({ ok: true }),
        _notes: notes,
      };
    };
    const mkIr = (withGuard) => ({
      isEnvCellId: isEnv,
      nearestCell: () => null,
      buildGraphFromWasm: async () => graph,
      toLegs: (g, pathArr) => pathArr.map((id) => {
        const n = g.get(id >>> 0);
        return { lb: id >>> 0, x: n.pos.x - ((id >>> 24) & 0xff) * 192, y: n.pos.y - ((id >>> 16) & 0xff) * 192, z: n.pos.z };
      }),
      ...(withGuard ? { guardLeg: ng.guardLeg } : {}),
    });
    const ops = { isOperatorStopLatched: () => false };

    // (a) sub-floor EnvCell pose + guardLeg-carrying ir -> PARK: no move, journal note.
    {
      const host = mkHost({ objCellId: A1, x: 8, y: 2, z: -0.01 });
      const c = new ExplorePressureController(host, mkRouter(), mkIr(true), ops, { now: clock });
      c.bot = mkBot();
      await c._indoorHop(host._pose, null);
      check("wiring: sub-floor EnvCell pose -> NO MoveToPosition (parked)", host._moves.length === 0);
      check("wiring: sub-floor pose -> journal reports un-solved hold",
        c.bot._notes.some((n) => n.text.includes("un-solved")));
    }
    // (b) z=5 solved EnvCell pose + guardLeg-carrying ir -> PROCEEDS (walks A2).
    {
      const host = mkHost({ objCellId: A1, x: 8, y: 2, z: 5 });
      const c = new ExplorePressureController(host, mkRouter(), mkIr(true), ops, { now: clock });
      c.bot = mkBot();
      await c._indoorHop(host._pose, null);
      check("wiring: z=5 solved pose -> a MoveToPosition IS issued", host._moves.length === 1 && (host._moves[0].lb >>> 0) === A2);
    }
    // (b2) z=0 at-plane pose + guardLeg-carrying ir -> PROCEEDS (the faithful
    //      settle rests exactly on the plane; an earlier guard revision parked
    //      here and froze frontier exploration — soak 2026-07-21).
    {
      const host = mkHost({ objCellId: A1, x: 8, y: 2, z: 0 });
      const c = new ExplorePressureController(host, mkRouter(), mkIr(true), ops, { now: clock });
      c.bot = mkBot();
      await c._indoorHop(host._pose, null);
      check("wiring: z=0 at-plane pose -> a MoveToPosition IS issued (no false park)",
        host._moves.length === 1 && (host._moves[0].lb >>> 0) === A2);
    }
    // (c) guardLeg-LESS ir + sub-floor pose -> degrades to today's behavior (walks A2).
    {
      const host = mkHost({ objCellId: A1, x: 8, y: 2, z: -0.01 });
      const c = new ExplorePressureController(host, mkRouter(), mkIr(false), ops, { now: clock });
      c.bot = mkBot();
      await c._indoorHop(host._pose, null);
      check("wiring: no guardLeg -> sub-floor pose still hops (degrades to today's behavior)",
        host._moves.length === 1 && (host._moves[0].lb >>> 0) === A2);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e && e.stack || e); process.exit(1); });

function mkRouter() { return { status: { state: "IDLE" } }; }
