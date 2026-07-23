#!/usr/bin/env node
// rynth_goto_compose_test.cjs — unit tests for rynth/goto_compose.js (task #7:
// outdoor<->indoor composition for bot.goto). No infra, no network, no wasm:
// the indoor graph, pose, current-cell id, the OUTDOOR planner (outdoorGoto)
// and the leg walker (walk) are all injected via the composeGoto deps seam
// (mirrors dungeon_nav.js's graphSource injection). walkLegs is exercised
// separately against a scripted fake router.
//
// Run: node rynth_goto_compose_test.cjs   (exits 1 on any FAIL)
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ── fixture: dungeon landblock X (0x01a9) and building landblock Y (0x02a9) ──
// LB X:  CX ── BX ── AX ──(outdoor exit portal 0x01a90005)
//                    │
//        GX (vertical DROP off CX — unreachable without a jump)
// LB Y:  PY ── QY   (QY is the indoor goal)
const LBX = 0x01a90000, LBY = 0x02a90000;
const AX = LBX | 0x100, BX = LBX | 0x101, CX = LBX | 0x102, GX = LBX | 0x103;
const PY = LBY | 0x100, QY = LBY | 0x101;
const EXIT_LANDCELL = LBX | 0x0005; // low word < 0x100 => a real outdoor LandCell id

const graphX = () => new Map([
  [AX, { pos: { x: 202, y: 32458, z: 0 }, neighbors: [BX], exits: [EXIT_LANDCELL] }],
  [BX, { pos: { x: 212, y: 32458, z: 0 }, neighbors: [AX, CX], exits: [] }],
  [CX, { pos: { x: 222, y: 32458, z: 0 }, neighbors: [BX, GX], exits: [] }],
  // GX sits directly below CX (dHoriz 0.5m => vertical shaft => drop edge).
  [GX, { pos: { x: 222, y: 32458.5, z: -10 }, neighbors: [CX], exits: [] }],
]);
const graphY = () => new Map([
  [PY, { pos: { x: 394, y: 32458, z: 0 }, neighbors: [QY], exits: [] }],
  [QY, { pos: { x: 404, y: 32458, z: 0 }, neighbors: [PY], exits: [] }],
]);

// pose {objCellId,x,y,z} with landblock-local x/y for a full cell id + world pt.
const poseAt = (cell, wx, wy, z = 0) => ({
  objCellId: cell >>> 0,
  x: wx - ((cell >>> 24) & 0xff) * 192,
  y: wy - ((cell >>> 16) & 0xff) * 192,
  z,
});
const poseCX = () => poseAt(CX, 222, 32458, 0);         // indoors at CX
const poseAX = () => poseAt(AX, 202, 32458, 0);         // indoors at AX
const poseOutY = () => poseAt(LBY | 0x0001, 394, 32458, 0); // outdoors by PY's door

// A test host: injected current cell + pose (both static — the fake sidecar/walk
// don't actually move the world; we assert the composition SEQUENCE, not motion).
const mkHost = (cell, pose) => ({ s: { getCurrentCellId: () => cell >>> 0 }, TryGetPlayerPose: () => pose });

// Recording deps factories.
function recorders() {
  const walks = [], outdoors = [], built = [];
  const okWalk = async (legs, o = {}) => { walks.push({ label: o.label, legs }); return { ok: true, state: "DONE", legsWalked: legs.length }; };
  const failWalk = async (legs, o = {}) => { walks.push({ label: o.label, legs }); return { ok: false, state: "FAILED", error: "blocked stitch leg", legsWalked: 1 }; };
  const okOutdoor = async (to) => { outdoors.push(to); return { ok: true, state: "DONE", legsWalked: 2, coverage: "detour", replans: 0 }; };
  const failOutdoor = async (to) => { outdoors.push(to); return { ok: false, state: "FAILED", error: "empty route", legsWalked: 0, coverage: null }; };
  const buildGraph = (map) => async (lb) => { built.push(lb >>> 0); return map[(lb >>> 0) & 0xffff0000] || null; };
  return { walks, outdoors, built, okWalk, failWalk, okOutdoor, failOutdoor, buildGraph };
}
const lastLeg = (legs) => legs[legs.length - 1];
const isOutdoorLeg = (leg) => ((leg.lb >>> 0) & 0xffff) > 0 && ((leg.lb >>> 0) & 0xffff) < 0x100;

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "goto_compose.js")).href);
  const { composeGoto, walkLegs } = mod;
  const ir = await import(pathToFileURL(path.join(__dirname, "rynth", "indoor_router.js")).href);
  check("exports composeGoto + walkLegs", typeof composeGoto === "function" && typeof walkLegs === "function");

  // ── task #15: two-stage doorway-approach waypoints (toLegs {doorwayApproach}) ─
  // Path A->B->C with B OFFSET from the A-C line (an offset doorframe). Expect
  // per-transition 30% pre-approach + 50% doorway-midpoint, then the last cell
  // centre — NOT the {midpoints} shape. lb 0x0000 base so world == local.
  {
    const A = 0x100, B = 0x101, C = 0x102; // EnvCell low words, landblock 0x0000
    const g = new Map([
      [A, { pos: { x: 0, y: 0, z: 0 }, neighbors: [B] }],
      [B, { pos: { x: 10, y: 4, z: 0 }, neighbors: [A, C] }], // offset off the 0..20 x-axis
      [C, { pos: { x: 20, y: 0, z: 0 }, neighbors: [B] }],
    ]);
    const legs = ir.toLegs(g, [A, B, C], { doorwayApproach: true });
    const near = (leg, x, y) => Math.abs(leg.x - x) < 1e-6 && Math.abs(leg.y - y) < 1e-6;
    check("doorway: 30% + 50% per transition + final centre = 5 legs", legs.length === 5, `${legs.length}`);
    check("doorway: A->B 30% pre-approach (3,1.2) stamped dest B", near(legs[0], 3, 1.2) && legs[0].lb === B, JSON.stringify(legs[0]));
    check("doorway: A->B 50% midpoint (5,2)", near(legs[1], 5, 2), JSON.stringify(legs[1]));
    check("doorway: B->C 30% (13,2.8) + 50% (15,2)", near(legs[2], 13, 2.8) && near(legs[3], 15, 2), JSON.stringify([legs[2], legs[3]]));
    check("doorway: final leg = C centre (20,0)", near(legs[4], 20, 0) && legs[4].lb === C, JSON.stringify(legs[4]));
    // Contrast: {midpoints} emits midpoint+centre PER cell (A centre, mid, B, mid, C) — different shape.
    const mp = ir.toLegs(g, [A, B, C], { midpoints: true });
    check("doorway: distinct from {midpoints} (no bare cell centres mid-run)", mp.length !== legs.length || !near(mp[0], 3, 1.2), `${mp.length} vs ${legs.length}`);
    // Single-cell path degrades to just that cell's centre.
    check("doorway: single-cell path -> one centre leg", ir.toLegs(g, [A], { doorwayApproach: true }).length === 1);
  }

  // ── findPath opts.excludeEdges (2026-07-20, indoor-wedge bounded retry) ────
  // A diamond: A->B->D (cheap/direct) and A->C->D (longer detour). Plain
  // findPath must prefer the cheap route; excluding its first edge must force
  // the detour; excluding an edge with NO alternate route must return null
  // (never silently ignored), same contract as walkableOverrides' inverse.
  {
    const A = 0x200, B = 0x201, C = 0x202, D = 0x203;
    const g = new Map([
      [A, { pos: { x: 0, y: 0, z: 0 }, neighbors: [B, C] }],
      [B, { pos: { x: 10, y: -1, z: 0 }, neighbors: [A, D] }],
      [C, { pos: { x: 10, y: 5, z: 0 }, neighbors: [A, D] }],
      [D, { pos: { x: 20, y: 0, z: 0 }, neighbors: [B, C] }],
    ]);
    check("excludeEdges: absent -> prefers the cheap A-B-D route", JSON.stringify(ir.findPath(g, A, D)) === JSON.stringify([A, B, D]));
    check(
      "excludeEdges: excluding A-B forces the A-C-D detour",
      JSON.stringify(ir.findPath(g, A, D, { excludeEdges: new Set([ir.edgeKey(A, B)]) })) === JSON.stringify([A, C, D]),
    );
    check(
      "excludeEdges: excluding the ONLY route (both direct edges) -> unreachable (null)",
      ir.findPath(g, A, D, { excludeEdges: new Set([ir.edgeKey(A, B), ir.edgeKey(A, C)]) }) === null,
    );
    check("excludeEdges: edgeKey is undirected (B,A) === (A,B)", ir.edgeKey(B, A) === ir.edgeKey(A, B));
  }

  const OPTS = { poseTimeoutMs: 60, pollMs: 2, stallMs: 500 };

  // ── Case 0: pure outdoor — IDENTICAL passthrough, no graph/walk touched ────
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(LBX | 0x0001, poseAt(LBX | 0x0001, 300, 300)), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({}), walk: R.okWalk },
      { ns: 12.3, ew: -45.6 }, OPTS,
    );
    check("case0: returns the outdoor result (ok/detour)", r.ok === true && r.coverage === "detour", JSON.stringify(r));
    check("case0: outdoorGoto got the raw {ns,ew}", R.outdoors.length === 1 && R.outdoors[0].ns === 12.3 && R.outdoors[0].ew === -45.6, JSON.stringify(R.outdoors));
    check("case0: no indoor graph built, no indoor walk", R.built.length === 0 && R.walks.length === 0);
    check("case0: NOT composed (result unwrapped)", r.composed === undefined, JSON.stringify(r));
  }

  // ── Case 1: START indoors, goal OUTDOORS — exit walk then outdoor goto ─────
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(CX, poseCX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: R.okWalk },
      { ns: 5, ew: 5 }, OPTS,
    );
    check("case1: composed ok", r.ok === true && r.composed === true, JSON.stringify(r));
    check("case1: exit walk THEN outdoor goto", R.walks.length === 1 && R.walks[0].label === "exit" && R.outdoors.length === 1, JSON.stringify({ walks: R.walks.map((w) => w.label), outdoors: R.outdoors.length }));
    check("case1: exit legs cross the door (final leg outdoors)", isOutdoorLeg(lastLeg(R.walks[0].legs)), JSON.stringify(lastLeg(R.walks[0].legs)));
    check("case1: exit path walked CX->BX->AX (>=3 cell legs before the door)", R.walks[0].legs.length >= 4, `${R.walks[0].legs.length} legs`);
    check("case1: phases exit+outdoor, legsWalked summed", r.phases.map((p) => p.phase).join(",") === "exit,outdoor" && r.legsWalked === R.walks[0].legs.length + 2, JSON.stringify(r.phases));
    check("case1: coverage passes through the outdoor phase", r.coverage === "detour", JSON.stringify(r));
  }

  // ── Case 1b: exit walk FAILS — outdoor goto is NOT attempted ───────────────
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(CX, poseCX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: R.failWalk },
      { ns: 5, ew: 5 }, OPTS,
    );
    check("case1b: composed failure, no outdoor phase", r.ok === false && R.outdoors.length === 0 && r.error === "blocked stitch leg", JSON.stringify(r));
  }

  // ── Case 2: START indoors, goal indoors SAME landblock — pure indoor A* ────
  {
    const R = recorders();
    const goal = { lb: CX, x: 30, y: 10, z: 0 }; // CX local (world 222,32458)
    const r = await composeGoto(
      { host: mkHost(AX, poseAX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: R.okWalk },
      goal, OPTS,
    );
    check("case2: composed ok, coverage indoor", r.ok === true && r.coverage === "indoor" && r.composed === true, JSON.stringify(r));
    check("case2: single indoor walk, NO outdoor goto", R.walks.length === 1 && R.walks[0].label === "indoor" && R.outdoors.length === 0, JSON.stringify({ walks: R.walks.map((w) => w.label), out: R.outdoors.length }));
    check("case2: AX->BX->CX walked, precise goal leg last", lastLeg(R.walks[0].legs).lb === (CX >>> 0) && lastLeg(R.walks[0].legs).x === 30 && lastLeg(R.walks[0].legs).y === 10, JSON.stringify(lastLeg(R.walks[0].legs)));
  }

  // ── Case 2 unreachable: goal reachable only across a DROP -> honest fail ────
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(AX, poseAX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: R.okWalk },
      { lb: GX, x: 30, y: 10.5, z: -10 }, OPTS,
    );
    check("case2-drop: unreachable, never walked", r.ok === false && /unreachable/.test(r.error) && R.walks.length === 0, JSON.stringify(r));
  }

  // ── Case 3: goal indoors (from outdoors) — approach then entry A* ──────────
  {
    const R = recorders();
    const goal = { lb: QY, x: 20, y: 10, z: 0 }; // QY local (world 404,32458)
    const r = await composeGoto(
      { host: mkHost(LBY | 0x0001, poseOutY()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBY]: graphY() }), walk: R.okWalk },
      goal, OPTS,
    );
    check("case3: composed ok", r.ok === true && r.composed === true, JSON.stringify(r));
    check("case3: approach outdoor goto used a {ns,ew} target (not the raw indoor lb)", R.outdoors.length === 1 && typeof R.outdoors[0].ns === "number" && !("lb" in R.outdoors[0]), JSON.stringify(R.outdoors[0]));
    check("case3: phases approach THEN enter", r.phases.map((p) => p.phase).join(",") === "approach,enter", JSON.stringify(r.phases));
    check("case3: enter walk PY->QY, precise goal leg last", R.walks.length === 1 && R.walks[0].label === "enter" && lastLeg(R.walks[0].legs).lb === (QY >>> 0) && lastLeg(R.walks[0].legs).x === 20, JSON.stringify(lastLeg(R.walks[0].legs)));
    check("case3: built the GOAL landblock graph", R.built.includes(LBY >>> 0), JSON.stringify(R.built));
  }

  // ── Case 3: entry doorway unreachable (empty/streamed-out graph) -> honest ─
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(LBY | 0x0001, poseOutY()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({}) /* returns null */, walk: R.okWalk },
      { lb: QY, x: 20, y: 10, z: 0 }, OPTS,
    );
    check("case3-nograph: approach ran, then honest indoor-graph-unavailable", r.ok === false && r.error === "indoor graph unavailable" && R.outdoors.length === 1 && R.walks.length === 0, JSON.stringify(r));
  }

  // ── Case 3: outdoor approach itself fails -> propagates, no entry attempt ──
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(LBY | 0x0001, poseOutY()), router: null, outdoorGoto: R.failOutdoor, buildGraph: R.buildGraph({ [LBY]: graphY() }), walk: R.okWalk },
      { lb: QY, x: 20, y: 10, z: 0 }, OPTS,
    );
    check("case3-approachfail: propagates outdoor failure, no build/walk", r.ok === false && r.error === "empty route" && R.built.length === 0 && R.walks.length === 0, JSON.stringify(r));
  }

  // ── Cross-landblock indoor->indoor: exit (case1) THEN case3 ───────────────
  {
    const R = recorders();
    const r = await composeGoto(
      { host: mkHost(CX, poseCX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX(), [LBY]: graphY() }), walk: R.okWalk },
      { lb: QY, x: 20, y: 10, z: 0 }, OPTS,
    );
    check("cross-lb: composed ok", r.ok === true && r.composed === true, JSON.stringify(r));
    check("cross-lb: phases exit,approach,enter", r.phases.map((p) => p.phase).join(",") === "exit,approach,enter", JSON.stringify(r.phases));
    check("cross-lb: exit then enter walks + one approach", R.walks.map((w) => w.label).join(",") === "exit,enter" && R.outdoors.length === 1, JSON.stringify({ walks: R.walks.map((w) => w.label), out: R.outdoors.length }));
    check("cross-lb: built both landblocks", R.built.includes(LBX >>> 0) && R.built.includes(LBY >>> 0), JSON.stringify(R.built));
  }

  // ── Degradations ──────────────────────────────────────────────────────────
  {
    const R = recorders();
    // indoor start but no graph anywhere
    const rNoGraph = await composeGoto(
      { host: mkHost(AX, poseAX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({}), walk: R.okWalk },
      { ns: 1, ew: 1 }, OPTS,
    );
    check("degrade: indoor start, no graph -> indoor graph unavailable", rNoGraph.ok === false && rNoGraph.error === "indoor graph unavailable", JSON.stringify(rNoGraph));
    // indoor start but no pose (never produces one)
    const rNoPose = await composeGoto(
      { host: mkHost(AX, null), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: R.okWalk },
      { ns: 1, ew: 1 }, OPTS,
    );
    check("degrade: indoor start, no pose -> no player pose", rNoPose.ok === false && rNoPose.error === "no player pose", JSON.stringify(rNoPose));
    // hostile host must not throw into the caller
    let threw = false;
    try {
      const rHostile = await composeGoto(
        { host: { s: { getCurrentCellId() { throw new Error("boom"); } }, TryGetPlayerPose() { throw new Error("boom"); } }, router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({}), walk: R.okWalk },
        { ns: 1, ew: 1 }, OPTS,
      );
      // current cell falls back to 0 (outdoor) -> case0 -> outdoorGoto
      check("degrade: hostile host -> resolves via outdoor path, no throw", rHostile.ok === true);
    } catch (_) { threw = true; }
    check("degrade: hostile host never throws", threw === false);
  }

  // ── walkLegs unit: scripted fake router ────────────────────────────────────
  {
    const seqRouter = (seq) => {
      let i = 0, followed = null;
      return {
        follow(legs) { followed = legs; },
        cancel() { this._cancelled = true; },
        get status() { const s = seq[Math.min(i, seq.length - 1)]; i++; return s; },
        followed: () => followed,
      };
    };
    const rEmpty = await walkLegs(seqRouter([{ state: "DONE", leg: 0, walked: 0 }]), [], { pollMs: 1 });
    check("walkLegs: empty legs -> DONE/0", rEmpty.ok === true && rEmpty.state === "DONE" && rEmpty.legsWalked === 0, JSON.stringify(rEmpty));

    const rDone = await walkLegs(
      seqRouter([{ state: "WALK", leg: 0, walked: 0 }, { state: "WALK", leg: 1, walked: 1 }, { state: "DONE", leg: 2, walked: 2 }]),
      [{ lb: 1 }, { lb: 2 }], { pollMs: 1, stallMs: 500 },
    );
    check("walkLegs: polls to DONE, legsWalked from status.walked", rDone.ok === true && rDone.state === "DONE" && rDone.legsWalked === 2, JSON.stringify(rDone));

    const rCancel = await walkLegs(
      seqRouter([{ state: "WALK", leg: 0, walked: 0 }, { state: "IDLE", leg: 0, walked: 1 }]),
      [{ lb: 1 }], { pollMs: 1, stallMs: 500 },
    );
    check("walkLegs: external cancel (IDLE) -> route cancelled", rCancel.ok === false && rCancel.error === "route cancelled", JSON.stringify(rCancel));

    const rFail = await walkLegs(
      seqRouter([{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 0, walked: 0, stitchBlocked: true }]),
      [{ lb: 1, stitch: true }], { pollMs: 1, stallMs: 500 },
    );
    check("walkLegs: FAILED -> ok:false with stitchBlocked carried", rFail.ok === false && rFail.state === "FAILED" && rFail.stitchBlocked === true, JSON.stringify(rFail));

    const rStall = await walkLegs(
      seqRouter([{ state: "WALK", leg: 0, walked: 0 }]),
      [{ lb: 1 }], { pollMs: 1, stallMs: 20 },
    );
    check("walkLegs: no progress past stallMs -> STALLED (cancelled)", rStall.ok === false && rStall.state === "STALLED", JSON.stringify(rStall));
  }

  // ── task #14: in-EnvCell portal transit ────────────────────────────────────
  // Models the live acceptance run: an OUTDOOR goto walks through the Town
  // Network portal, gets parked in an EnvCell, and the sidecar fails fast on a
  // straight stitch leg into the dungeon interior toward the Holtburg exit
  // portal. Recovery walks the cell graph to the portal, USE()s it, waits for
  // the hop, and re-plans from the far side.
  const ITEM_TYPE_PORTAL = 0x00010000;
  const LP = 0x00070000, NA = LP | 0x143, NB = LP | 0x120, NC = LP | 0x121; // spawn / portal / mid cell
  const PORTAL_GUID = 0x7000abcd;
  // Live blocked-leg (bucketed into an outdoor-format lb by WorldToLeg): its
  // world point is the portal's true position (0x0006*192+152.04 == 0x0007*192-39.95).
  const BLOCKED = { lb: 0x00060017, x: 53.904, y: 152.04, z: -0.063 };
  const twx = ((BLOCKED.lb >>> 24) & 0xff) * 192 + BLOCKED.x; // 53.904
  const twy = ((BLOCKED.lb >>> 16) & 0xff) * 192 + BLOCKED.y; // 1304.04
  const flatGraph = () => new Map([
    [NA, { pos: { x: 60, y: 1330, z: 0 }, neighbors: [NB], exits: [] }],
    [NB, { pos: { x: twx, y: twy, z: -0.063 }, neighbors: [NA], exits: [] }],
  ]);
  // Portal cell NB sits at the portal point (so nearestCell picks it, in z-band)
  // but is reachable only by a vertical SHAFT DROP off the mid cell NC — A*
  // prunes that edge, so the portal cell is unreachable.
  const dropGraph = () => new Map([
    [NA, { pos: { x: 60, y: 1330, z: 10 }, neighbors: [NC], exits: [] }],
    [NC, { pos: { x: twx, y: twy, z: 10 }, neighbors: [NA, NB], exits: [] }],
    [NB, { pos: { x: twx, y: twy, z: 0 }, neighbors: [NC], exits: [] }], // 10m below NC (dHoriz<1 => drop)
  ]);
  // task #16: the WRONG-portal landing — a different dungeon (the academy, live
  // v15: 0x860201AD, ~44km away). One EnvCell with an outdoor exit portal.
  const LA = 0x86020000, EA = LA | 0x1ad;
  const academyGraph = () => new Map([
    [EA, { pos: { x: 0x86 * 192 + 10, y: 0x02 * 192 + 10, z: 0 }, neighbors: [], exits: [LA | 0x0005] }],
  ]);

  function portalWorld(knobs = {}) {
    const state = {
      cell: 0xaab40001, // start OUTDOORS
      pose: { objCellId: 0xaab40001, x: 20, y: 20, z: 0 },
      used: [], outdoorCalls: 0,
    };
    const host = {
      s: { getCurrentCellId: () => state.cell >>> 0 },
      TryGetPlayerPose: () => state.pose,
      NearbyGuids: () => (knobs.noPortal ? [] : [PORTAL_GUID]),
      TryGetObjectIntProperty: (g, st) => (g === PORTAL_GUID && st === 1 ? ITEM_TYPE_PORTAL : 0),
      TryGetObjectDescFlags: () => 0,
      TryGetObjectPosition: (g) => (g === PORTAL_GUID ? { objCellId: NB, x: twx, y: twy - 7 * 192, z: -0.063 } : null),
      TryGetObjectName: (g) => (g === PORTAL_GUID ? "Portal to Holtburg" : null),
      UseObject: (g) => {
        state.used.push(g >>> 0);
        if (knobs.useRejects) return false;
        // Teleport target: outdoors by default; knobs.hopToIndoor flings us into
        // a WRONG dungeon (task #16 re-entrancy — must be >500m for the walk-in
        // hop threshold and detected by awaitTeleport).
        const dest = (knobs.hopToIndoor || 0x8fa00001) >>> 0;
        if (!knobs.noTeleport) setTimeout(() => { state.pose = { objCellId: dest, x: 10, y: 10, z: 0 }; state.cell = dest; }, 4);
        return true;
      },
    };
    // Fake indoor walk: fails the first `knobs.walkFails` calls (pose stays put
    // on the wedge), then "arrives" at the last leg's cell (updating BOTH pose
    // and current-cell so an exit walk transitions us to outdoors). Records
    // labels so a test can assert the re-walk / re-exit sequences.
    state.walkCalls = 0;
    state.walkLabels = [];
    const walk = async (legs, o = {}) => {
      state.walkCalls++;
      state.walkLabels.push(o.label);
      if (state.walkCalls <= (knobs.walkFails || 0)) return { ok: false, state: "FAILED", legsWalked: 0 };
      const last = legs[legs.length - 1];
      state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
      state.cell = last.lb >>> 0; // arriving updates the current cell
      return { ok: true, state: "DONE", legsWalked: legs.length };
    };
    const outdoorGoto = async () => {
      state.outdoorCalls++;
      if (state.outdoorCalls === 1) {
        if (!knobs.stayOutdoor) { state.cell = NA >>> 0; state.pose = { objCellId: NA >>> 0, x: 60, y: 1330 - 7 * 192, z: 0 }; }
        return { ok: false, state: "FAILED", error: "blocked stitch leg", blockedLeg: { ...BLOCKED }, legsWalked: 11, coverage: "mixed" };
      }
      return { ok: true, state: "DONE", legsWalked: 3, coverage: "detour" };
    };
    const graphFn = knobs.dropGated ? dropGraph : flatGraph;
    const deps = {
      host, router: null, outdoorGoto, walk,
      buildGraph: async (lb) => {
        // Unsigned lb-word compare: the academy lb (0x86020000) exceeds 2^31, so
        // a signed `& 0xffff0000` would mis-match; >>> 0 keeps both sides u32.
        const w = ((lb >>> 0) & 0xffff0000) >>> 0;
        if (w === ((LP & 0xffff0000) >>> 0)) return graphFn();
        if (w === ((LA & 0xffff0000) >>> 0)) return academyGraph();
        return null;
      },
    };
    return { state, deps };
  }
  const POPTS = { poseTimeoutMs: 60, pollMs: 2, stallMs: 200, portalTeleportMs: 200, portalRangeM: 10 };

  {
    const pw = portalWorld();
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: transit recovers + re-plans to success", r.ok === true, JSON.stringify(r));
    check("portal: outdoor planner called twice (fail -> transit -> re-plan)", pw.state.outdoorCalls === 2, `calls=${pw.state.outdoorCalls}`);
    check("portal: the portal entity was USE()d", pw.state.used.length === 1 && pw.state.used[0] === (PORTAL_GUID >>> 0), JSON.stringify(pw.state.used));
  }
  {
    const pw = portalWorld({ noPortal: true });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: no portal entity in reach -> honest error, no re-plan",
      r.ok === false && r.error === "portal transit failed: portal entity not found" && pw.state.outdoorCalls === 1, JSON.stringify(r));
  }
  {
    const pw = portalWorld({ noTeleport: true });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: use() but no teleport -> honest error after timeout",
      r.ok === false && r.error === "portal transit failed: no teleport" && pw.state.used.length === 1, JSON.stringify(r));
  }
  {
    const pw = portalWorld({ useRejects: true });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: use() rejected -> honest error", r.ok === false && r.error === "portal transit failed: use rejected", JSON.stringify(r));
  }
  {
    const pw = portalWorld({ dropGated: true });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: portal cell only reachable via a DROP -> honest unreachable",
      r.ok === false && r.error === "portal transit failed: portal cell unreachable" && pw.state.used.length === 0, JSON.stringify(r));
  }
  {
    // Blocked stitch but the walker is NOT in an EnvCell: transit must NOT engage;
    // the raw outdoor failure propagates (outdoor-only stitch fail is unchanged).
    const pw = portalWorld({ stayOutdoor: true });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("portal: not in an EnvCell -> no transit, raw blocked-stitch failure",
      r.ok === false && r.error === "blocked stitch leg" && !!r.blockedLeg && pw.state.used.length === 0 && pw.state.outdoorCalls === 1, JSON.stringify(r));
  }

  // ── task #15: one re-walk retry of the remaining indoor path on a wedge ─────
  {
    // First indoor walk wedges; the single re-walk threads it -> success.
    const pw = portalWorld({ walkFails: 1 });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("rewalk: first walk wedges, retry threads it -> transit ok", r.ok === true, JSON.stringify(r));
    check("rewalk: retry ran exactly once (approach then approach-retry)",
      pw.state.walkCalls === 2 && pw.state.walkLabels.join(",") === "portal-approach,portal-approach-retry", JSON.stringify(pw.state.walkLabels));
    check("rewalk: portal USE()d after the retry threaded the doorway", pw.state.used.length === 1, JSON.stringify(pw.state.used));
  }
  {
    // Both walks wedge and no portal in desperate range: retry runs ONCE and only
    // once (exactly two walk calls — no infinite re-walk), then honest failure.
    const pw = portalWorld({ walkFails: 99 });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("rewalk: both wedge -> honest indoor-walk failure", r.ok === false && /indoor walk/.test(r.error), JSON.stringify(r));
    check("rewalk: retry runs once and only once (exactly 2 walk calls)",
      pw.state.walkCalls === 2 && pw.state.walkLabels.join(",") === "portal-approach,portal-approach-retry", JSON.stringify(pw.state.walkLabels));
  }

  // ── task #16: re-entrancy — a hop that lands in a WRONG dungeon re-composes ─
  {
    // The portal transit clips a hallway portal and flings us into the academy
    // (a different-lb EnvCell). Instead of 400ing the sidecar with an indoor
    // `from`, we exit the academy, then the outdoor planner re-plans from there.
    const pw = portalWorld({ hopToIndoor: EA });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, POPTS);
    check("re-entrancy: wrong-dungeon hop becomes a detour -> success", r.ok === true, JSON.stringify(r));
    check("re-entrancy: sequence = portal-approach, RE-EXIT, then a 2nd sidecar plan",
      pw.state.walkLabels.join(",") === "portal-approach,re-exit" && pw.state.outdoorCalls === 2, JSON.stringify({ walks: pw.state.walkLabels, out: pw.state.outdoorCalls }));
    check("re-entrancy: the wrong portal was USE()d exactly once", pw.state.used.length === 1, JSON.stringify(pw.state.used));
  }
  {
    // Budget: re-dispatches count against maxTransits. With portalTransits=1 the
    // single transit consumes the budget; the next indoor landing can't re-exit
    // and we fail honestly WITH the current location.
    const pw = portalWorld({ hopToIndoor: EA });
    const r = await composeGoto(pw.deps, { ns: 42.1, ew: 33.6 }, { ...POPTS, portalTransits: 1 });
    check("re-entrancy: budget exhaustion fails honestly with the stranded location",
      r.ok === false && /budget exhausted/.test(r.error) && r.error.includes("0x860201AD"), JSON.stringify(r));
    check("re-entrancy: no re-plan attempted past the budget (outdoor called once)", pw.state.outdoorCalls === 1, `calls=${pw.state.outdoorCalls}`);
  }

  // ── task #17: portal-aware route REPLAY (contract v2) ──────────────────────
  const { deriveRouteFlags, prepareReplayLegs, routeHasPortals, replayRoute } = mod;
  const worldXf = (lb, x) => ((lb >>> 24) & 0xff) * 192 + x;
  const worldYf = (lb, y) => ((lb >>> 16) & 0xff) * 192 + y;
  {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "rynth", "testdata", "v16_arwic_holtburg_route.json"), "utf8"));
    const legs = fixture.route.legs;
    check("fixture: no fmt (legacy) with 19 legs", fixture.route.fmt === undefined && legs.length === 19, `fmt=${fixture.route.fmt} n=${legs.length}`);

    const flagged = deriveRouteFlags(legs); // legacy -> derive
    const portalIdx = flagged.map((l, i) => (l.portal ? i : -1)).filter((i) => i >= 0);
    const indoorIdx = flagged.map((l, i) => (l.indoor ? i : -1)).filter((i) => i >= 0);
    check("derive: portal flags on the DEPARTURE legs 4 and 16", portalIdx.join(",") === "4,16", JSON.stringify(portalIdx));
    check("derive: indoor flags on legs 5..16 (the 12 Town Network legs)", indoorIdx.join(",") === "5,6,7,8,9,10,11,12,13,14,15,16", JSON.stringify(indoorIdx));
    check("derive: legacy arrival-portal flags (fixture legs 5,17) are cleared", !flagged[5].portal && !flagged[17].portal, JSON.stringify([flagged[5].portal, flagged[17].portal]));
    check("derive: does not mutate the input", legs[4].portal === undefined && legs[16].portal === undefined);
    // fmt:2 trusts recorder flags (no re-derivation).
    const trusted = deriveRouteFlags([{ lb: 0x10101, x: 0, y: 0, portal: true }, { lb: 0x10102, x: 1, y: 0 }], 2);
    check("derive: fmt:2 trusts recorder flags (short hop stays portal)", trusted[0].portal === true);

    // Ground-truth nav-import navType survives LEGACY re-derivation even when
    // a short hop wouldn't trip the 500m geometric heuristic (the MatronHive
    // "portal hub" pattern: several ptl options recorded within metres of each
    // other) — a route replayed via bot.followRoute(route.legs, opts) WITHOUT
    // opts.fmt threaded through must not silently lose a real portal leg.
    const hubLegs = [
      { lb: 0x10101, x: 0, y: 0, z: 0, portal: true, meta: { navType: "ptl", objName: "Portal A" } },
      { lb: 0x10101, x: 3, y: 0, z: 0, portal: true, meta: { navType: "ptl", objName: "Portal B" } }, // <500m from neighbours either side
      { lb: 0x10101, x: 6, y: 0, z: 0 },
    ];
    const hubFlagged = deriveRouteFlags(hubLegs); // legacy (no fmt)
    check("derive: ground-truth ptl/rcl/prt navType survives legacy re-derivation on a close hub (no 500m jump)",
      hubFlagged[0].portal === true && hubFlagged[1].portal === true, JSON.stringify(hubFlagged.map((l) => l.portal)));
    // Contrast: the SAME close spacing with a recorded (non-nav-import) stale
    // .portal marker and NO meta is still cleared — recorded routes never
    // carry meta.navType, so this preserves the exact existing arrival-flag-
    // clearing contract asserted above (fixture legs 5,17).
    const staleLegs = [
      { lb: 0x10101, x: 0, y: 0, z: 0, portal: true },
      { lb: 0x10101, x: 3, y: 0, z: 0 },
    ];
    check("derive: a stale recorded .portal marker (no meta) on a close hop is still cleared, unaffected by the ground-truth fix",
      deriveRouteFlags(staleLegs)[0].portal === undefined);

    const prepared = prepareReplayLegs(legs);
    check("prepare: portal legs preserved (4,16)", prepared[4].portal === true && prepared[16].portal === true);
    check("prepare: indoor legs get a long per-leg timeoutMs", prepared[5].timeoutMs >= 200000 && prepared[16].timeoutMs >= 200000, JSON.stringify(prepared[5].timeoutMs));
    check("prepare: indoor normalize PRESERVES the world point (native neg-local -> walkable frame)",
      Math.abs(worldXf(prepared[5].lb, prepared[5].x) - worldXf(legs[5].lb, legs[5].x)) < 1e-6 &&
      Math.abs(worldYf(prepared[5].lb, prepared[5].y) - worldYf(legs[5].lb, legs[5].y)) < 1e-6,
      JSON.stringify({ was: [worldXf(legs[5].lb, legs[5].x), worldYf(legs[5].lb, legs[5].y)], now: [worldXf(prepared[5].lb, prepared[5].x), worldYf(prepared[5].lb, prepared[5].y)] }));
    check("prepare: outdoor legs (0-4,17,18) untouched (no timeoutMs)", prepared[0].timeoutMs === undefined && prepared[18].timeoutMs === undefined);
    check("routeHasPortals: fixture is a portal route", routeHasPortals(prepared) === true);
    check("routeHasPortals: a plain outdoor route is not", routeHasPortals(prepareReplayLegs([{ lb: 0x10101, x: 0, y: 0 }, { lb: 0x10101, x: 30, y: 0 }])) === false);
  }

  // replayRoute: portal-hold FAILS (no walk-in hop) -> touch assist -> resume the
  // remaining legs from the far side. Scripted fake router + fake host.
  {
    const PGUID = 0x9911abcd, ITEM_TYPE_PORTAL = 0x00010000;
    const PLB = 0x05050001, FARLB = 0x40400001;
    const state = { pose: { objCellId: PLB, x: 40, y: 40, z: 0 }, used: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      NearbyGuids: () => [PGUID],
      TryGetObjectIntProperty: (g, st) => (g === PGUID && st === 1 ? ITEM_TYPE_PORTAL : 0),
      TryGetObjectDescFlags: () => 0,
      TryGetObjectPosition: (g) => (g === PGUID ? { objCellId: PLB, x: 40, y: 40, z: 0 } : null),
      TryGetObjectName: () => "Portal",
      UseObject: (g) => { state.used.push(g >>> 0); setTimeout(() => { state.pose = { objCellId: FARLB, x: 10, y: 10, z: 0 }; }, 4); return true; },
    };
    const follows = [];
    const script = [
      [{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1, portalBlocked: true }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = {
      seamJumpM: 30,
      follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); },
      cancel() {},
      get status() { return q.length ? q.shift() : { state: "DONE", leg: 0, legs: 0, walked: 0 }; },
    };
    const legs = [
      { lb: PLB, x: 0, y: 0, z: 0 },
      { lb: PLB, x: 40, y: 40, z: 0, portal: true },
      { lb: FARLB, x: 10, y: 10, z: 0 },
    ];
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, portalTeleportMs: 300, portalRangeM: 10 });
    check("replay: blocked portal -> touch assist -> DONE", r.ok === true && r.state === "DONE", JSON.stringify(r));
    check("replay: the portal we stood on was USE()d once", state.used.length === 1 && state.used[0] === (PGUID >>> 0), JSON.stringify(state.used));
    check("replay: resumed with the FAR-SIDE remaining leg only", follows.length === 2 && follows[1].length === 1 && follows[1][0].lb === FARLB, JSON.stringify(follows.map((f) => f.length)));
  }

  // replayRoute: blocked portal with NO portal entity in reach -> honest failure.
  {
    const host = { TryGetPlayerPose: () => ({ objCellId: 0x05050001, x: 40, y: 40, z: 0 }), NearbyGuids: () => [], UseObject: () => true };
    let q = [];
    const script = [[{ state: "FAILED", leg: 0, walked: 0, portalBlocked: true }]];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, [{ lb: 0x05050001, x: 40, y: 40, portal: true }], { pollMs: 2, portalTeleportMs: 60 });
    check("replay: blocked portal, no entity in reach -> honest portal-touch failure", r.ok === false && /portal touch failed/.test(r.error), JSON.stringify(r));
  }

  // ── nav-import ptl meta: NAME-based portal targeting (MatronHive leg-8 finding) ──
  // The recorded LEG coordinate is only the VTank approach point (can be far
  // from the real object); meta.objName/meta.objPos carry the object's real
  // ground truth. These tests exercise attemptMetaPortalTouch indirectly via
  // replayRoute's portalBlocked branch.
  {
    // NAME match succeeds even though the entity carries NEITHER the
    // ItemType.Portal property NOR the portal ObjectDescriptionFlag (proving
    // the name search is independent of the old flag-based heuristic, which
    // would find nothing here).
    const PGUID = 0xaa11, OBJ_LB = 0x05050001, OBJ_X = 10, OBJ_Y = 40, FARLB = 0x40400001;
    const state = { pose: { objCellId: OBJ_LB, x: 10, y: 10, z: 0 }, used: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      NearbyGuids: () => [PGUID], // unconditional — proves player-proximity to the OBJECT isn't required for the name path
      TryGetObjectIntProperty: () => 0, // NOT ItemType.Portal
      TryGetObjectDescFlags: () => 0, // NOT the portal ODF
      TryGetObjectPosition: (g) => (g === PGUID ? { objCellId: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } : null),
      TryGetObjectName: (g) => (g === PGUID ? "Portal to Town Network" : null),
      UseObject: (g) => { state.used.push(g >>> 0); setTimeout(() => { state.pose = { objCellId: FARLB, x: 5, y: 5, z: 0 }; }, 4); return true; },
    };
    const meta = { navType: "ptl", objName: "Portal to Town Network", objectClass: 14, isTie: true, objPos: { lb: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } };
    const legs = [
      { lb: OBJ_LB, x: 0, y: 0, z: 0 },
      { lb: OBJ_LB, x: 10, y: 10, z: 0, portal: true, meta },
      { lb: FARLB, x: 5, y: 5, z: 0 },
    ];
    const follows = [];
    const script = [
      [{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1, portalBlocked: true }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, portalTeleportMs: 300 });
    check("meta-touch: NAME match finds the entity with no portal item-type/descflag", r.ok === true && r.state === "DONE", JSON.stringify(r));
    check("meta-touch: the name-matched entity was USE()d", state.used.length === 1 && state.used[0] === (PGUID >>> 0), JSON.stringify(state.used));
    check("meta-touch: resumed with the FAR-SIDE remaining leg only", follows.length === 2 && follows[1].length === 1 && follows[1][0].lb === FARLB, JSON.stringify(follows.map((f) => f.length)));
  }
  {
    // NAME doesn't match anything nearby -> falls back to the nearest
    // PORTAL-flagged entity to the OBJECT's coordinates (not the leg anchor).
    const PGUID = 0xbb22, ITEM_TYPE_PORTAL = 0x00010000, OBJ_LB = 0x05050001, OBJ_X = 10, OBJ_Y = 40, FARLB = 0x40400001;
    const state = { pose: { objCellId: OBJ_LB, x: 8, y: 38, z: 0 }, used: [] }; // near the object, not the leg anchor
    const host = {
      TryGetPlayerPose: () => state.pose,
      NearbyGuids: () => [PGUID],
      TryGetObjectIntProperty: (g, st) => (g === PGUID && st === 1 ? ITEM_TYPE_PORTAL : 0),
      TryGetObjectDescFlags: () => 0,
      TryGetObjectPosition: (g) => (g === PGUID ? { objCellId: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } : null),
      TryGetObjectName: (g) => (g === PGUID ? "Unnamed Portal Device" : null), // does NOT match objName
      UseObject: (g) => { state.used.push(g >>> 0); setTimeout(() => { state.pose = { objCellId: FARLB, x: 5, y: 5, z: 0 }; }, 4); return true; },
    };
    const meta = { navType: "ptl", objName: "Portal to Town Network", objectClass: 14, isTie: true, objPos: { lb: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } };
    const legs = [
      { lb: OBJ_LB, x: 100, y: 100, z: 0, portal: true, meta }, // leg anchor is FAR from the object
      { lb: FARLB, x: 5, y: 5, z: 0 },
    ];
    const script = [
      [{ state: "FAILED", leg: 0, walked: 0, portalBlocked: true }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, portalTeleportMs: 300 });
    check("meta-touch: name miss falls back to nearest portal-flagged entity near objPos", r.ok === true && state.used[0] === (PGUID >>> 0), JSON.stringify({ r, used: state.used }));
  }
  {
    // Nothing in range at the approach point -> walk toward the object's real
    // position, then retry the search from there.
    const PGUID = 0xcc33, OBJ_LB = 0x05050001, OBJ_X = 10, OBJ_Y = 40, FARLB = 0x40400001;
    const worldXt = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
    const worldYt = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;
    const owx = worldXt(OBJ_LB, OBJ_X), owy = worldYt(OBJ_LB, OBJ_Y);
    const state = { pose: { objCellId: OBJ_LB, x: 0, y: 0, z: 0 }, used: [], walkCalls: [] }; // far from the object
    const host = {
      TryGetPlayerPose: () => state.pose,
      // Perception-scoped: the entity only "streams in" once the player is
      // within 25m of its real position — realistic NearbyGuids behavior.
      NearbyGuids: () => {
        const pwx = worldXt(state.pose.objCellId >>> 0, state.pose.x), pwy = worldYt(state.pose.objCellId >>> 0, state.pose.y);
        return Math.hypot(pwx - owx, pwy - owy) <= 25 ? [PGUID] : [];
      },
      TryGetObjectIntProperty: () => 0,
      TryGetObjectDescFlags: () => 0,
      TryGetObjectPosition: (g) => (g === PGUID ? { objCellId: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } : null),
      TryGetObjectName: (g) => (g === PGUID ? "Portal to Town Network" : null),
      UseObject: (g) => { state.used.push(g >>> 0); setTimeout(() => { state.pose = { objCellId: FARLB, x: 5, y: 5, z: 0 }; }, 4); return true; },
    };
    const walk = async (legs, o = {}) => {
      state.walkCalls.push(o.label);
      const last = legs[legs.length - 1];
      state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
      return { ok: true, state: "DONE", legsWalked: legs.length };
    };
    const meta = { navType: "ptl", objName: "Portal to Town Network", objectClass: 14, isTie: true, objPos: { lb: OBJ_LB, x: OBJ_X, y: OBJ_Y, z: 0 } };
    const legs = [
      { lb: OBJ_LB, x: 0, y: 0, z: 0, portal: true, meta },
      { lb: FARLB, x: 5, y: 5, z: 0 },
    ];
    const script = [
      [{ state: "FAILED", leg: 0, walked: 0, portalBlocked: true }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router, walk }, legs, { pollMs: 2, portalTeleportMs: 300 });
    check("meta-touch: nothing in range -> walk toward objPos -> retry finds it", r.ok === true && state.used.length === 1, JSON.stringify({ r, used: state.used }));
    check("meta-touch: walked via the portal-object-approach leg", state.walkCalls.includes("portal-object-approach"), JSON.stringify(state.walkCalls));
  }

  // ── rcl legs: recall-cast replay (task: recall dependency) ─────────────────
  {
    // Known + castable spell -> cast -> teleport -> resume from the far side.
    const FARLB = 0x40400001;
    const state = { pose: { objCellId: 0x05050001, x: 40, y: 40, z: 0 } };
    const host = {
      s: { playerKnownSpells: () => [1636] },
      TryGetPlayerPose: () => state.pose,
      GetCastBusyState: () => 0,
      CastSpell: () => { setTimeout(() => { state.pose = { objCellId: FARLB, x: 5, y: 5, z: 0 }; }, 4); return true; },
    };
    const meta = { navType: "rcl", spellId: 1636, spellName: "Lifestone Sending" };
    const legs = [
      { lb: 0x05050001, x: 40, y: 40, z: 0, portal: true, meta },
      { lb: FARLB, x: 5, y: 5, z: 0 },
    ];
    const follows = [];
    const script = [
      [{ state: "FAILED", leg: 0, walked: 0, portalBlocked: true }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, portalTeleportMs: 300, recallTeleportMs: 300 });
    check("recall: known+castable spell -> cast -> teleport -> DONE", r.ok === true && r.state === "DONE", JSON.stringify(r));
    check("recall: resumed with the far-side remaining leg", follows.length === 2 && follows[1].length === 1 && follows[1][0].lb === FARLB, JSON.stringify(follows.map((f) => f.length)));
  }
  {
    // Spell NOT known -> honest, correctly-labelled failure (never a
    // misleading "portal entity not found" — there was never an entity to find).
    const state = { pose: { objCellId: 0x05050001, x: 40, y: 40, z: 0 } };
    const host = {
      s: { playerKnownSpells: () => [999] }, // does not include 1636
      TryGetPlayerPose: () => state.pose,
      GetCastBusyState: () => 0,
      CastSpell: () => true,
    };
    const meta = { navType: "rcl", spellId: 1636, spellName: "Lifestone Sending" };
    const legs = [{ lb: 0x05050001, x: 40, y: 40, z: 0, portal: true, meta }];
    let q = [];
    const script = [[{ state: "FAILED", leg: 0, walked: 0, portalBlocked: true }]];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2 });
    check("recall: spell not known -> honest recall-unavailable failure (NOT a portal-entity message)",
      r.ok === false && r.reason === "recall-unavailable" && /Lifestone Sending/.test(r.error) && !/portal entity/.test(r.error), JSON.stringify(r));
  }

  // ── jmp legs: jump-primitive replay (2026-07-21, DESIGN-jump-primitive
  // Phase 1) ───────────────────────────────────────────────────────────────
  // Fast tuning knobs shared by every jmp test below (real defaults are
  // seconds-scale; tests need this in milliseconds).
  const FAST_JUMP_TUNE = {
    jumpTurnTimeoutMs: 50,
    jumpApproachMinMs: 1,
    jumpApproachMaxMs: 5,
    jumpAirborneTimeoutMs: 6,
    jumpLandingPollMs: 2,
    jumpLandingSettlePadMs: 2,
  };
  {
    check("routeHasJumps: a route with a jmp-meta leg is detected",
      mod.routeHasJumps([{ lb: 0x10101, x: 0, y: 0, meta: { navType: "jmp", headingDeg: 90 } }]) === true);
    check("routeHasJumps: a plain route is not", mod.routeHasJumps([{ lb: 0x10101, x: 0, y: 0 }]) === false);
  }
  {
    // Basic fire: FAILED walk leg IS the jmp-tagged leg itself. Heading
    // already faced (pose.heading pre-set to the target radian) so the turn
    // loop exits on its first read with no TurnToHeading call needed.
    const FARLB = 0x40400001;
    const headingDeg = 90; // -> pi/2 rad, +X east (combat_loop.js _faceGate convention)
    const headingRad = Math.PI / 2;
    const state = { pose: { objCellId: 0x05050001, x: 40, y: 40, z: 0, heading: headingRad }, moves: [], jumps: [], turns: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: (r) => { state.turns.push(r); state.pose = { ...state.pose, heading: r }; },
      CanJumpNow: () => true,
      SetMovementInput: (f, s, t, run) => { state.moves.push([f, s, t, run]); },
      Jump: (p) => { state.jumps.push(p); },
    };
    const meta = { navType: "jmp", headingDeg, holdShift: true, delayMs: 800 };
    const legs = [
      { lb: 0x05050001, x: 44, y: -41, z: 0, meta },
      { lb: FARLB, x: 5, y: 5, z: 0 },
    ];
    const follows = [];
    const script = [
      [{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 0, walked: 0 }],
      [{ state: "DONE", leg: 0, legs: 1, walked: 1 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: fires on the jmp leg itself -> DONE", r.ok === true && r.state === "DONE", JSON.stringify(r));
    check("jmp: Jump() called once with power = delayMs/1000 (0.8)", state.jumps.length === 1 && Math.abs(state.jumps[0] - 0.8) < 1e-6, JSON.stringify(state.jumps));
    check("jmp: SetMovementInput held FORWARD with run=false (holdShift=true -> walk)", state.moves.some((m) => m[0] === 1 && m[3] === false), JSON.stringify(state.moves));
    check("jmp: SetMovementInput released (0,0,0,false) after firing", state.moves.length >= 2 && state.moves[state.moves.length - 1].every((v, i) => v === [0, 0, 0, false][i]), JSON.stringify(state.moves));
    check("jmp: resumed with the FAR-SIDE remaining leg only", follows.length === 2 && follows[1].length === 1 && follows[1][0].lb === FARLB, JSON.stringify(follows.map((f) => f.length)));
    check("jmp: no TurnToHeading call needed (already facing the target)", state.turns.length === 0, JSON.stringify(state.turns));
  }
  {
    // holdShift=false -> run:true (uncharged/fast hop gait, the corpus's rare
    // 2/99 case) — the opposite gait mapping from the test above.
    const state = { pose: { objCellId: 0x05050001, x: 0, y: 0, z: 0, heading: 0 }, moves: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: () => {},
      CanJumpNow: () => true,
      SetMovementInput: (f, s, t, run) => { state.moves.push([f, s, t, run]); },
      Jump: () => {},
    };
    const meta = { navType: "jmp", headingDeg: 0, holdShift: false, delayMs: 95 };
    const legs = [{ lb: 0x05050001, x: 43, y: -42, z: 0, meta }, { lb: 0x05050002, x: 1, y: 1, z: 0 }];
    const script = [[{ state: "FAILED", leg: 0, walked: 0 }], [{ state: "DONE", leg: 0, legs: 1, walked: 1 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: holdShift=false -> run:true", r.ok === true && state.moves.some((m) => m[0] === 1 && m[3] === true), JSON.stringify(state.moves));
    check("jmp: power floors at jumpPowerMin for a tiny delayMs (95ms)", true); // covered by the power-clamp test below
  }
  {
    // Power clamp: delayMs=0 (or absent) still fires with the configured
    // floor, never 0 (a 0-power jump() call is a no-op vertical hop).
    const state = { pose: { objCellId: 0x05050001, x: 0, y: 0, z: 0, heading: 0 }, jumps: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: () => {},
      CanJumpNow: () => true,
      SetMovementInput: () => {},
      Jump: (p) => state.jumps.push(p),
    };
    const meta = { navType: "jmp", headingDeg: 0, holdShift: true, delayMs: 0 };
    const legs = [{ lb: 0x05050001, x: 1, y: 1, z: 0, meta }];
    const script = [[{ state: "FAILED", leg: 0, walked: 0 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE, jumpPowerMin: 0.05 });
    check("jmp: delayMs=0 still fires with the power floor (never 0)", r.ok === true && state.jumps.length === 1 && state.jumps[0] === 0.05, JSON.stringify(state.jumps));
  }
  {
    // Search window: the FAILED leg is a sentinel-fixed cht/pau leg TWO
    // positions before the real jmp-tagged leg (nav_import.js
    // fixupSentinelLegs collapses cht/pau coordinates onto the jmp leg's own
    // position — see nav_import.js header) — findUpcomingJumpLeg must still
    // find and fire it, mirroring the real vr-bridge-jump corpus idiom
    // cht->pau->jmp->pau->chk.
    const JX = 35075, JY = 14489;
    const state = { pose: { objCellId: 0x00000001, x: JX, y: JY, z: 117, heading: 0 }, jumps: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: () => {},
      CanJumpNow: () => true,
      SetMovementInput: () => {},
      Jump: (p) => state.jumps.push(p),
    };
    const legs = [
      { lb: 0x00000001, x: JX, y: JY, z: 117, meta: { navType: "cht", text: "/ub mexec ..." } }, // sentinel-fixed onto jmp's coords
      { lb: 0x00000001, x: JX, y: JY, z: 117, meta: { navType: "pau", pauseMs: 1000 } },
      { lb: 0x00000001, x: JX, y: JY, z: 117, meta: { navType: "jmp", headingDeg: 170, holdShift: true, delayMs: 800 } }, // the real jmp leg — index 2
      { lb: 0x00000001, x: JX, y: JY, z: 117, meta: { navType: "pau", pauseMs: 1000 } },
      { lb: 0x00000002, x: 1, y: 1, z: 117, meta: { navType: "chk" } },
    ];
    const follows = [];
    const script = [
      [{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 0, walked: 0 }], // fails walking leg 0 (the cht sentinel)
      [{ state: "DONE", leg: 0, legs: 2, walked: 2 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: search window finds the jmp leg 2 positions past the FAILED sentinel leg", r.ok === true && state.jumps.length === 1, JSON.stringify({ r, jumps: state.jumps }));
    check("jmp: resumes with legs AFTER the jmp leg (index 3 onward, 2 legs)", follows.length === 2 && follows[1].length === 2, JSON.stringify(follows.map((f) => f.length)));
  }
  {
    // Regression lock: the REAL vr-bridge-jump.nav corpus fixture's own
    // compiled leg shape (routes-json/mudzereli-metaf-sample__vr-bridge-jump.nav.json,
    // read directly), first jump attempt — a 5-leg gap from the failing walk
    // leg (index 1: chk->cht) to the jmp leg (index 6), wider than the
    // simpler cht->pau->jmp idiom tested above. This is the exact structure
    // the live-fire run replays; JUMP_LEG_SEARCH_WINDOW must cover it.
    const GAPX = 35075.28, GAPY = 14489.97, GAPZ = 117.0;
    const START = { x: 35051.15, y: 14568.33, z: 116.01 };
    const state = { pose: { objCellId: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, heading: 0 }, jumps: [] };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: () => {},
      CanJumpNow: () => true,
      SetMovementInput: () => {},
      Jump: (p) => state.jumps.push(p),
    };
    const legs = [
      { lb: 0x00000001, x: START.x, y: START.y, z: START.z, meta: { navType: "chk" } }, // idx0 = @teleloc start
      { lb: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, meta: { navType: "cht", text: "/vt opt set navclosestoprange ..." } }, // idx1 = the WALL failure per the offline oracle
      { lb: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, meta: { navType: "cht", text: "/vt opt set idlepeacemode false" } },
      { lb: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, meta: { navType: "cht", text: "/ub mexec $jumpnum=1" } }, // sentinel-fixed onto idx2
      { lb: 0x00000001, x: START.x, y: START.y, z: START.z, meta: { navType: "chk" } }, // real, back near start
      { lb: 0x00000001, x: START.x, y: START.y, z: START.z, meta: { navType: "pau", pauseMs: 1000 } }, // sentinel-fixed onto idx4
      { lb: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, meta: { navType: "jmp", headingDeg: 185, holdShift: true, delayMs: 400 } }, // idx6 = the real jmp leg
      { lb: 0x00000001, x: GAPX, y: GAPY, z: GAPZ, meta: { navType: "pau", pauseMs: 1000 } },
      { lb: 0x00000002, x: 35050.75, y: 14563.58, z: 117.0, meta: { navType: "chk" } }, // landing checkpoint
    ];
    const follows = [];
    const script = [
      [{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }], // WALL at leg 1, exactly like the offline oracle report
      [{ state: "DONE", leg: 0, legs: 2, walked: 2 }],
    ];
    let q = [];
    const router = { seamJumpM: 30, follow(fl) { follows.push(fl); q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: vr-bridge-jump-shaped 5-leg gap (real corpus prefix) -> jump still found and fired", r.ok === true && state.jumps.length === 1, JSON.stringify({ r, jumps: state.jumps }));
    check("jmp: vr-bridge-jump-shaped gap -> power = delayMs/1000 = 0.4 (heading 185deg attempt)", Math.abs(state.jumps[0] - 0.4) < 1e-6, JSON.stringify(state.jumps));
    check("jmp: vr-bridge-jump-shaped gap -> resumes with legs AFTER the jmp leg (index 7 onward, 2 legs)", follows.length === 2 && follows[1].length === 2, JSON.stringify(follows.map((f) => f.length)));
  }
  {
    // Typed failure: CanJumpNow() false (e.g. genuinely airborne/blocked
    // motion state) -> honest jump-unavailable, never a generic FAILED with
    // no explanation.
    const state = { pose: { objCellId: 0x05050001, x: 0, y: 0, z: 0, heading: 0 } };
    const host = {
      TryGetPlayerPose: () => state.pose,
      TurnToHeading: () => {},
      CanJumpNow: () => false,
      SetMovementInput: () => {},
      Jump: () => {},
    };
    const meta = { navType: "jmp", headingDeg: 0, holdShift: true, delayMs: 500 };
    const legs = [{ lb: 0x05050001, x: 1, y: 1, z: 0, meta }];
    const script = [[{ state: "FAILED", leg: 0, walked: 0 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: canJumpNow() false -> typed jump-unavailable failure", r.ok === false && r.reason === "jump-unavailable" && /canJumpNow/.test(r.error), JSON.stringify(r));
  }
  {
    // Typed failure: stale pkg/ build — host has no Jump/SetMovementInput at
    // all. Must degrade to an honest typed failure, never throw into the walk.
    const state = { pose: { objCellId: 0x05050001, x: 0, y: 0, z: 0, heading: 0 } };
    const host = { TryGetPlayerPose: () => state.pose };
    const meta = { navType: "jmp", headingDeg: 0, holdShift: true, delayMs: 500 };
    const legs = [{ lb: 0x05050001, x: 1, y: 1, z: 0, meta }];
    const script = [[{ state: "FAILED", leg: 0, walked: 0 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2, ...FAST_JUMP_TUNE });
    check("jmp: missing Jump/SetMovementInput (stale pkg/) -> typed failure, never throws", r.ok === false && r.reason === "jump-unavailable" && /stale pkg/.test(r.error), JSON.stringify(r));
  }
  {
    // Control: a plain FAILED walk with NO jmp leg anywhere in the search
    // window must fall through unchanged to the existing terminal-failure
    // path (zero behavior change for jmp-less routes) — proves the new
    // branch doesn't misfire on an ordinary wall stall.
    const state = { pose: { objCellId: 0xaab40001, x: 40, y: 40, z: 0 } };
    const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
    const legs = [{ lb: 0xaab40001, x: 40, y: 40, z: 0 }, { lb: 0xaab40001, x: 60, y: 40, z: 0 }];
    const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2 });
    check("jmp: no jmp leg nearby -> unchanged honest terminal failure", r.ok === false && r.state === "FAILED" && r.leg === 1, JSON.stringify(r));
  }

  // ── runtime indoor-wedge derivation (imported routes never carry leg.indoor) ─
  {
    // An EnvCell-id waypoint but the LEG ITSELF carries no `.indoor` flag (the
    // nav-import shape — VTank coordinates are always outdoor-projected, see
    // nav_import.js IND1). replayRoute must still recognize the wedge from the
    // LIVE pose's cell (isEnvCellId) and run the one-shot indoor re-path.
    const EA = 0x08080143, EB = 0x08080144; // EnvCell ids (low word in [0x100,0xfffd])
    const graph = new Map([
      [EA, { pos: { x: 10, y: 10, z: 0 }, neighbors: [EB] }],
      [EB, { pos: { x: 20, y: 10, z: 0 }, neighbors: [EA] }],
    ]);
    const state = { pose: { objCellId: EA, x: 10, y: 10, z: 0 } };
    const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
    const walkCalls = [];
    const walk = async (legs, o = {}) => {
      walkCalls.push(o.label);
      const last = legs[legs.length - 1];
      state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
      return { ok: true, state: "DONE", legsWalked: legs.length };
    };
    const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === ((EA & 0xffff0000) >>> 0) ? graph : null);
    const legs = [
      { lb: EA, x: 10, y: 10, z: 0 },
      { lb: EB, x: 20, y: 10, z: 0 }, // NO .indoor flag — imported-route style
    ];
    const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]]; // NOT portalBlocked
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
    check("indoor-wedge runtime derive: re-paths despite failed.indoor being undefined (live pose IS an EnvCell)", r.ok === true && r.state === "DONE", JSON.stringify(r));
    check("indoor-wedge runtime derive: repathIndoor's walk ran (wedge-repath label)", walkCalls.includes("wedge-repath"), JSON.stringify(walkCalls));
  }
  {
    // Control: neither the leg NOR the live pose is indoors -> the wedge
    // branch must NOT engage (falls through to the honest terminal failure) —
    // proves the runtime check doesn't fire spuriously outdoors.
    const state = { pose: { objCellId: 0xaab40001, x: 40, y: 40, z: 0 } };
    const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
    const legs = [{ lb: 0xaab40001, x: 40, y: 40, z: 0 }, { lb: 0xaab40001, x: 60, y: 40, z: 0 }];
    const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]];
    let q = [];
    const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
    const r = await replayRoute({ host, router }, legs, { pollMs: 2 });
    check("indoor-wedge control: outdoors + no flag -> honest terminal FAILED, no re-path attempted", r.ok === false && r.state === "FAILED" && r.leg === 1, JSON.stringify(r));
  }

  // ── indoor-wedge BOUNDED RETRY (2026-07-20, live MatronHive report #3) ─────
  // repathIndoor used to be one-shot: find A*, walk it, give up entirely on
  // any stall. Now it retries up to tune.wedgeAttempts, excluding whatever
  // doorway edge the walk actually stalled inside so the next attempt's A*
  // can't just re-offer the same jam, and it always finishes at the EXACT
  // requested target (not just the nearest cell's bbox-derived centre).
  {
    // Diamond graph: EA -(cheap)-> EB -> ED, or EA -(detour)-> EC -> ED.
    // Landblock 0x0000 base so world == local (graph `pos` is WORLD-frame per
    // the module contract; avoids an unrelated landblock-offset shift here).
    const LB = 0x00000000;
    const EA = LB | 0x143, EB = LB | 0x144, EC = LB | 0x145, ED = LB | 0x146;
    const diamond = () => new Map([
      [EA, { pos: { x: 10, y: 10, z: 0 }, neighbors: [EB, EC] }],
      [EB, { pos: { x: 20, y: 9, z: 0 }, neighbors: [EA, ED] }], // cheap route
      [EC, { pos: { x: 20, y: 15, z: 0 }, neighbors: [EA, ED] }], // detour
      [ED, { pos: { x: 30, y: 10, z: 0 }, neighbors: [EB, EC] }],
    ]);

    // Attempt 1 wedges on the FIRST edge (EA-EB); attempt 2 must exclude it,
    // route via EC instead, and succeed.
    {
      const state = { pose: { objCellId: EA, x: 10, y: 10, z: 0 } };
      const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
      const walkCalls = [];
      const walk = async (legs, o = {}) => {
        // normalizeLegWorldFrame re-buckets EVERY leg's .lb into an
        // outdoor-style cell index (existing, pre-fix behavior — even the
        // real EnvCell id toLegs stamped gets overwritten), so identify which
        // route was actually walked by WORLD-frame position, not raw lb.
        walkCalls.push({ label: o.label, worldYs: legs.map((l) => worldYf(l.lb, l.y)) });
        if (walkCalls.length === 1) {
          // Stalls after the doorway-approach's FIRST leg (30% into EA->EB) —
          // legsWalked=1 maps back to edge index 0 (EA-EB).
          return { ok: false, state: "FAILED", legsWalked: 1 };
        }
        const last = legs[legs.length - 1];
        state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
        return { ok: true, state: "DONE", legsWalked: legs.length };
      };
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? diamond() : null);
      const legs = [{ lb: EA, x: 10, y: 10, z: 0 }, { lb: ED, x: 30, y: 10, z: 0 }];
      const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }], [{ state: "DONE", leg: 0, legs: 1, walked: 1 }]];
      let q = [];
      const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("wedge-retry: recovers via edge exclusion on attempt 2", r.ok === true && r.state === "DONE", JSON.stringify(r));
      check("wedge-retry: exactly 2 walk attempts, labelled wedge-repath then wedge-repath-retry2",
        walkCalls.length === 2 && walkCalls[0].label === "wedge-repath" && walkCalls[1].label === "wedge-repath-retry2",
        JSON.stringify(walkCalls.map((w) => w.label)));
      // EB sits at y=9 (below both EA/ED's y=10); EC sits at y=15 (above).
      // The EA-EB-ED route's world Y never exceeds 10; only the EC detour
      // reaches above ~11 (its 30/50% doorway waypoints sit at y=11.5/12.5).
      check("wedge-retry: attempt 2 routed via the EC detour, never re-offering the excluded EA-EB edge",
        Math.max(...walkCalls[1].worldYs) > 11, JSON.stringify(walkCalls[1].worldYs));
    }

    // Both routes wedge (EA-EB then EA-EC) -> attempt 3's findPath has nothing
    // left to offer (both direct edges excluded) -> stop EARLY, no 3rd walk.
    {
      const state = { pose: { objCellId: EA, x: 10, y: 10, z: 0 } };
      const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
      const walkCalls = [];
      const walk = async (legs) => {
        walkCalls.push(legs.map((l) => l.lb >>> 0));
        return { ok: false, state: "FAILED", legsWalked: 1 }; // always stalls on the first doorway leg
      };
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? diamond() : null);
      const legs = [{ lb: EA, x: 10, y: 10, z: 0 }, { lb: ED, x: 30, y: 10, z: 0 }];
      const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]];
      let q = [];
      const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("wedge-retry: both routes exhausted -> honest failure", r.ok === false && r.state === "FAILED", JSON.stringify(r));
      check("wedge-retry: stops after exactly 2 walks (3rd attempt's A* had nothing left, no wasted walk)",
        walkCalls.length === 2, `${walkCalls.length} walk calls`);
    }

    // Fix: the recovery ends at the EXACT requested target, not the nearest
    // cell's bbox-derived centre (live MatronHive: a raw centre can sit
    // inside static-object clutter). Target world point is near ED but offset
    // from ED's own (30,10) centre by 6m — nearestCell still resolves to ED
    // (only candidate), but the FINAL walked leg must preserve the target's
    // own world point, not collapse to ED's centre.
    {
      const state = { pose: { objCellId: EA, x: 10, y: 10, z: 0 } };
      const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
      let finalLeg = null;
      const walk = async (legs) => {
        finalLeg = legs[legs.length - 1];
        const last = legs[legs.length - 1];
        state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
        return { ok: true, state: "DONE", legsWalked: legs.length };
      };
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? diamond() : null);
      // Target: an outdoor-projected id in the SAME landblock family, world
      // point (36,10) — 6m past ED's own centre (30,10) — mirrors nav_import's
      // outdoor-projection-only leg coordinate for an indoor waypoint.
      const targetLb = (LB | 0x0005) >>> 0;
      const legs = [{ lb: EA, x: 10, y: 10, z: 0 }, { lb: targetLb, x: 36, y: 10, z: 0 }];
      const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }], [{ state: "DONE", leg: 0, legs: 1, walked: 1 }]];
      let q = [];
      const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("wedge-retry: recovery succeeds", r.ok === true && r.state === "DONE", JSON.stringify(r));
      check("wedge-retry: final leg preserves the EXACT target world point (not ED's bbox centre)",
        finalLeg && Math.abs(worldXf(finalLeg.lb, finalLeg.x) - worldXf(targetLb, 36)) < 1e-6 && Math.abs(worldYf(finalLeg.lb, finalLeg.y) - worldYf(targetLb, 10)) < 1e-6,
        JSON.stringify({ finalLeg, wantWorld: [worldXf(targetLb, 36), worldYf(targetLb, 10)] }));
    }
  }

  // ── fixture: real 0x0007 Town-Network EnvCell cluster (live MatronHive
  // report #3 stall site — 0x0007017D/0x0007017C/0x00070178, WorldBuilder.
  // Terminal chorizite-parse-dat-record dump against client_cell_1.dat, real
  // portal records + cell origins). Confirms: (a) 0x0007017D is DIRECTLY,
  // mutually portal-connected to BOTH 0x0007017C and 0x00070178 (no
  // wall-cutting synthetic adjacency); (b) the edge is FLAT (dz=0, well under
  // the drop-angle threshold) — the stall is not a misclassified drop edge;
  // (c) pins the exact doorway-approach waypoint coordinates our code
  // generates for this real geometry, tying the unit test to the live
  // incident site.
  {
    const CELL_017D = 0x0007017d, CELL_017C = 0x0007017c, CELL_0178 = 0x00070178;
    // DAT dump gives position.origin in LANDBLOCK-LOCAL frame (blockX=0,
    // blockY=7 for this whole cluster — (cell>>>16)&0xff==7); the graph
    // CONTRACT requires WORLD-frame pos (buildGraphFromWasm's own
    // cellOriginX/Y are pre-shifted the same way, indoor_router.js:17593-97),
    // so add the landblock's own 7*192=1344 world offset to Y here (X needs
    // no shift, blockX=0). z=0 for all three -> same floor, flat building.
    const worldYshift = 7 * 192;
    const townCluster = new Map([
      [CELL_017D, { pos: { x: 130, y: -70 + worldYshift, z: 0 }, neighbors: [CELL_017C, CELL_0178] }],
      [CELL_017C, { pos: { x: 130, y: -60 + worldYshift, z: 0 }, neighbors: [CELL_017D] }],
      [CELL_0178, { pos: { x: 120, y: -70 + worldYshift, z: 0 }, neighbors: [CELL_017D] }],
    ]);
    check("town-cluster: 0x0007017D<->0x0007017C is flat (not a drop edge)", ir.isDropEdge(townCluster.get(CELL_017D), townCluster.get(CELL_017C)) === false);
    check("town-cluster: 0x0007017D<->0x00070178 is flat (not a drop edge)", ir.isDropEdge(townCluster.get(CELL_017D), townCluster.get(CELL_0178)) === false);
    const path = ir.findPath(townCluster, CELL_017D, CELL_0178);
    check("town-cluster: 017D->0178 is a single direct portal edge (real doorway, matches the DAT's mutual portal record)",
      JSON.stringify(path) === JSON.stringify([CELL_017D, CELL_0178]), JSON.stringify(path));
    const legs = ir.toLegs(townCluster, path, { doorwayApproach: true });
    // 30% pre-approach + 50% doorway-midpoint along the (130,-70)->(120,-70)
    // vector, then the (120,-70) cell centre -- the exact waypoints a live
    // wedge-repath would generate walking THIS real doorway.
    check("town-cluster: 30% pre-approach lands at (127,-70)", Math.abs(legs[0].x - 127) < 1e-6 && Math.abs(legs[0].y - (-70)) < 1e-6, JSON.stringify(legs[0]));
    check("town-cluster: 50% doorway-midpoint lands at (125,-70)", Math.abs(legs[1].x - 125) < 1e-6 && Math.abs(legs[1].y - (-70)) < 1e-6, JSON.stringify(legs[1]));
    check("town-cluster: final leg = 0x00070178's own centre (120,-70), stamped with its id",
      legs[2].lb === (CELL_0178 >>> 0) && Math.abs(legs[2].x - 120) < 1e-6 && Math.abs(legs[2].y - (-70)) < 1e-6, JSON.stringify(legs[2]));
  }

  // ── closed-door detection in recovery walks (gap 3, HANDOFF-metanav-
  // 2026-07-20 "Door-state in navigation") ────────────────────────────────
  // repathIndoor's bounded-retry recovery walk used to have NO door check —
  // a closed door on the ONLY edge of the recovery path would stall the walk,
  // get excluded like any other jammed doorway, and (with no detour
  // available) fail the whole recovery outright. Single-edge graph here so
  // there is deliberately no detour: success is possible ONLY if the door
  // gets opened and the SAME edge is re-walked (never excluded).
  {
    const LB = 0x03000000;
    const DA = LB | 0x140, DB = LB | 0x141;
    const singleEdge = () => new Map([
      [DA, { pos: { x: 10, y: 10, z: 0 }, neighbors: [DB] }],
      [DB, { pos: { x: 30, y: 10, z: 0 }, neighbors: [DA] }],
    ]);
    const DOOR_GUID = 0x7001;
    const legs = [{ lb: DA, x: 10, y: 10, z: 0 }, { lb: DB, x: 30, y: 10, z: 0 }];
    const script = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }], [{ state: "DONE", leg: 0, legs: 1, walked: 1 }]];

    // First attempt stalls at the doorway; a closed (non-ethereal) door sits
    // within DOOR_RETRY_RANGE_M -> opened, then the SAME edge is re-walked
    // (no detour exists) and succeeds.
    {
      const state = { pose: { objCellId: DA, x: 10, y: 10, z: 0 } };
      const host = {
        TryGetPlayerPose: () => state.pose,
        s: { getCurrentCellId: () => state.pose.objCellId >>> 0 },
        calls: [],
        NearbyGuids: () => [DOOR_GUID],
        TryGetObjectDescFlags: (g) => (g === DOOR_GUID ? 0x1000 : 0),
        TryGetObjectState: () => 0, // NOT ethereal -> closed
        TryGetObjectPosition: () => ({ objCellId: DA, x: 12, y: 10, z: 0 }), // ~2m from pose
        TryGetObjectName: (g) => (g === DOOR_GUID ? "Rusty Gate" : "?"),
        UseObject: (g) => { host.calls.push(["use", g >>> 0]); return true; },
      };
      const walkCalls = [];
      const walk = async (rlegs, o = {}) => {
        walkCalls.push({ label: o.label, lbs: rlegs.map((l) => l.lb >>> 0) });
        if (walkCalls.length === 1) return { ok: false, state: "FAILED", legsWalked: 1 };
        const last = rlegs[rlegs.length - 1];
        state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
        return { ok: true, state: "DONE", legsWalked: rlegs.length };
      };
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? singleEdge() : null);
      let q = [];
      const router = { seamJumpM: 30, follow() { q = (script.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("door-recovery: closed door opened -> same-edge retry succeeds", r.ok === true && r.state === "DONE", JSON.stringify(r));
      check("door-recovery: exactly 2 walk attempts (no detour, edge never excluded)", walkCalls.length === 2, JSON.stringify(walkCalls));
      check("door-recovery: UseObject called on the door guid", host.calls.some((c) => c[0] === "use" && c[1] === DOOR_GUID), JSON.stringify(host.calls));
    }

    // An OPEN (ethereal) door in range must NOT be re-used; with no detour
    // available and the door untouched, the recovery honestly fails via edge
    // exclusion (single-edge graph -> unreachable after excluding it).
    {
      const state = { pose: { objCellId: DA, x: 10, y: 10, z: 0 } };
      const host = {
        TryGetPlayerPose: () => state.pose,
        s: { getCurrentCellId: () => state.pose.objCellId >>> 0 },
        calls: [],
        NearbyGuids: () => [DOOR_GUID],
        TryGetObjectDescFlags: (g) => (g === DOOR_GUID ? 0x1000 : 0),
        TryGetObjectState: () => 0x4, // ethereal -> already open
        TryGetObjectPosition: () => ({ objCellId: DA, x: 12, y: 10, z: 0 }),
        TryGetObjectName: (g) => (g === DOOR_GUID ? "Rusty Gate" : "?"),
        UseObject: (g) => { host.calls.push(["use", g >>> 0]); return true; },
      };
      const walk = async () => ({ ok: false, state: "FAILED", legsWalked: 1 });
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? singleEdge() : null);
      let q = [];
      const script2 = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]];
      const router = { seamJumpM: 30, follow() { q = (script2.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("door-recovery: open door not re-used -> honest unreachable failure", r.ok === false && /indoor re-path: unreachable/.test(r.error || ""), JSON.stringify(r));
      check("door-recovery: open door left untouched", !host.calls.some((c) => c[0] === "use"), JSON.stringify(host.calls));
    }

    // No NearbyGuids at all (host doesn't support object queries, e.g. a
    // recorded-route replay context without the AI perception surface) ->
    // nearestClosedDoor degrades to null, same honest failure, never throws.
    {
      const state = { pose: { objCellId: DA, x: 10, y: 10, z: 0 } };
      const host = { TryGetPlayerPose: () => state.pose, s: { getCurrentCellId: () => state.pose.objCellId >>> 0 } };
      const walk = async () => ({ ok: false, state: "FAILED", legsWalked: 1 });
      const buildGraph = async (lb) => (((lb >>> 0) & 0xffff0000) === LB ? singleEdge() : null);
      let q = [];
      const script3 = [[{ state: "WALK", leg: 0, walked: 0 }, { state: "FAILED", leg: 1, walked: 1 }]];
      const router = { seamJumpM: 30, follow() { q = (script3.shift() || []).slice(); }, cancel() {}, get status() { return q.length ? q.shift() : { state: "DONE" }; } };
      const r = await replayRoute({ host, router, buildGraph, walk }, legs, { pollMs: 2 });
      check("door-recovery: no NearbyGuids support -> degrades cleanly to honest failure", r.ok === false && /indoor re-path: unreachable/.test(r.error || ""), JSON.stringify(r));
    }
  }

  // ── composeEgress: the bounded egress retry ladder (2026-07-23, live
  // Holtburg-tavern fix). A tavern-shaped world: the NEAREST exit path runs
  // over a serving-window CellPortal edge (real in the DAT, never walkable at
  // floor level — walks across it always wedge), and the alternate south
  // route out is gated by a CLOSED door. The ladder must: wedge twice on the
  // window edge, exclude it, re-route to the south exit, open the door when
  // wedged against it, and finish OUTDOORS with an honest awaited result. ──
  {
    const { composeEgress } = mod;
    const TLB = 0x11220000; // lbX=0x11 (world x base 3264), lbY=0x22 (y base 6528)
    const BAR = TLB | 0x155, WIN = TLB | 0x15c, EXITE = TLB | 0x164;
    const S1 = TLB | 0x153, S2 = TLB | 0x154, EXITS = TLB | 0x150;
    const tavernGraph = () => new Map([
      [BAR,   { pos: { x: 3274, y: 6538, z: 0 }, neighbors: [WIN, S1], exits: [] }],
      [WIN,   { pos: { x: 3278, y: 6538, z: 0 }, neighbors: [BAR, EXITE], exits: [] }],
      [EXITE, { pos: { x: 3282, y: 6538, z: 0 }, neighbors: [WIN], exits: [(TLB | 0xffff) >>> 0] }], // outside sentinel
      [S1,    { pos: { x: 3274, y: 6534, z: 0 }, neighbors: [BAR, S2], exits: [] }],
      [S2,    { pos: { x: 3274, y: 6530, z: 0 }, neighbors: [S1, EXITS], exits: [] }],
      [EXITS, { pos: { x: 3274, y: 6526, z: 0 }, neighbors: [S2], exits: [(TLB | 0x0005) >>> 0] }], // direct LandCell
    ]);
    const DOOR_GUID = 0x70012345; // closed door on the S2->EXITS doorway (world 3274,6528)
    function tavernWorld() {
      const nodes = tavernGraph();
      const state = { cell: BAR >>> 0, pos: { wx: 3274, wy: 6538, z: 0 }, doorOpen: false, used: [], walkLabels: [] };
      const nearestGraphCell = (wx, wy) => {
        let best = 0, bestD = Infinity;
        for (const [cid, n] of nodes) {
          const d = (n.pos.x - wx) ** 2 + (n.pos.y - wy) ** 2;
          if (d < bestD) { bestD = d; best = cid; }
        }
        return best >>> 0;
      };
      const poseOf = () => {
        // lb-local pose in the OUTDOOR frame of the world point (the sim walk
        // normalizes legs the same way, so this matches what MoveTo would see).
        const lbX = Math.floor(state.pos.wx / 192), lbY = Math.floor(state.pos.wy / 192);
        return { objCellId: state.cell >>> 0, x: state.pos.wx - lbX * 192, y: state.pos.wy - lbY * 192, z: state.pos.z };
      };
      const host = {
        s: { getCurrentCellId: () => state.cell >>> 0 },
        TryGetPlayerPose: () => poseOf(),
        NearbyGuids: () => [DOOR_GUID],
        TryGetObjectDescFlags: (g) => (g === DOOR_GUID ? 0x1000 : 0), // ODF Door
        TryGetObjectState: (g) => (g === DOOR_GUID && state.doorOpen ? 0x4 : 0), // Ethereal while open
        TryGetObjectPosition: (g) =>
          g === DOOR_GUID ? { objCellId: (TLB | 0x0001) >>> 0, x: 3274 - 0x11 * 192, y: 6528 - 0x22 * 192, z: 0 } : null,
        TryGetObjectName: (g) => (g === DOOR_GUID ? "Sturdy Door" : "?"),
        UseObject: (g) => {
          state.used.push(g >>> 0);
          if (g === DOOR_GUID) state.doorOpen = true;
          return true;
        },
      };
      // Physics sim: legs walk in order; a leg is BLOCKED when its world point
      // is (a) past the serving window (y=6538 corridor, x > 3278.5 — the
      // WIN->EXITE opening is never floor-walkable) or (b) past the closed
      // door (x=3274 corridor, y < 6529 while the door is shut). A wedge
      // leaves the pose at the last COMPLETED leg (partial progress persists);
      // completing every leg lands the final (outdoor) point.
      const walk = async (legs, o = {}) => {
        state.walkLabels.push(o.label);
        for (let i = 0; i < legs.length; i++) {
          const wx = worldXf(legs[i].lb >>> 0, legs[i].x);
          const wy = worldYf(legs[i].lb >>> 0, legs[i].y);
          const windowBlocked = Math.abs(wy - 6538) < 1 && wx > 3278.5;
          const doorBlocked = !state.doorOpen && Math.abs(wx - 3274) < 1 && wy < 6529;
          if (windowBlocked || doorBlocked) return { ok: false, state: "FAILED", error: "walk stalled", legsWalked: i };
          state.pos = { wx, wy, z: legs[i].z };
          state.cell = i === legs.length - 1 ? legs[i].lb >>> 0 : nearestGraphCell(wx, wy); // final leg = the outdoor point
        }
        return { ok: true, state: "DONE", legsWalked: legs.length };
      };
      const buildGraph = async (lb) => ((((lb >>> 0) & 0xffff0000) >>> 0) === (TLB >>> 0) ? tavernGraph() : null);
      return { state, deps: { host, router: null, walk, buildGraph } };
    }

    const EOPTS = { poseTimeoutMs: 60, pollMs: 2, egressAttempts: 5 };
    {
      const tw = tavernWorld();
      const r = await composeEgress(tw.deps, EOPTS);
      check("egress: tavern multi-door egress completes OUTDOORS", r.ok === true && r.composed === true, JSON.stringify(r));
      check("egress: pose ended outdoors (LandCell, not EnvCell)", ((tw.state.cell & 0xffff) >>> 0) < 0x100, `cell=0x${tw.state.cell.toString(16)}`);
      check("egress: converged in 4 attempts (window x2 -> exclude -> door -> out)", r.attempts === 4, JSON.stringify(r));
      check(
        "egress: walk labels egress, -retry2, -retry3, -retry4",
        tw.state.walkLabels.join(",") === "egress,egress-retry2,egress-retry3,egress-retry4",
        JSON.stringify(tw.state.walkLabels),
      );
      check("egress: the closed door was opened exactly once", tw.state.used.length === 1 && tw.state.used[0] === (DOOR_GUID >>> 0), JSON.stringify(tw.state.used));
      check("egress: exited via the SOUTH exit (window edge excluded)", (r.exitCell >>> 0) === (EXITS >>> 0), JSON.stringify(r));
      check("egress: one summary phase entry with the attempt count", r.phases.length === 1 && r.phases[0].phase === "egress" && r.phases[0].attempts === 4, JSON.stringify(r.phases));
    }
    {
      // Already outdoors -> immediate no-walk success.
      const tw = tavernWorld();
      tw.state.cell = (TLB | 0x0001) >>> 0;
      const r = await composeEgress(tw.deps, EOPTS);
      check("egress: already outdoors -> ok, no walk", r.ok === true && r.alreadyOutdoors === true && tw.state.walkLabels.length === 0, JSON.stringify(r));
    }
    {
      // Attempt budget too small to reach the door remedy -> honest failure
      // carrying the LAST walk error, and never a throw.
      const tw = tavernWorld();
      const r = await composeEgress(tw.deps, { ...EOPTS, egressAttempts: 2 });
      check("egress: exhausted budget fails honestly with the walk error", r.ok === false && r.error === "walk stalled", JSON.stringify(r));
      check("egress: still indoors after the failed budget", ((tw.state.cell & 0xffff) >>> 0) >= 0x100, `cell=0x${tw.state.cell.toString(16)}`);
    }
    {
      // No graph at all -> honest "indoor graph unavailable".
      const tw = tavernWorld();
      const r = await composeEgress({ ...tw.deps, buildGraph: async () => null }, EOPTS);
      check("egress: no graph -> indoor graph unavailable", r.ok === false && r.error === "indoor graph unavailable", JSON.stringify(r));
    }

    // composeGoto Phase A now retries the exit walk through the same ladder:
    // first exit walk wedges (transient), the retry threads it, then the
    // outdoor phase runs — previously ANY exit-walk failure was terminal.
    {
      const R = recorders();
      let exitWalks = 0;
      const flakyWalk = async (legs, o = {}) => {
        R.walks.push({ label: o.label, legs });
        if (o.label && o.label.startsWith("exit") && ++exitWalks === 1) {
          return { ok: false, state: "FAILED", error: "wedged on the doorframe", legsWalked: 0 };
        }
        return { ok: true, state: "DONE", legsWalked: legs.length };
      };
      const r = await composeGoto(
        { host: mkHost(CX, poseCX()), router: null, outdoorGoto: R.okOutdoor, buildGraph: R.buildGraph({ [LBX]: graphX() }), walk: flakyWalk },
        { ns: 5, ew: 5 }, OPTS,
      );
      check("phaseA-ladder: transient exit wedge is retried to success", r.ok === true, JSON.stringify(r));
      check(
        "phaseA-ladder: walks = exit, exit-retry2, then the outdoor phase ran",
        R.walks.map((w) => w.label).join(",") === "exit,exit-retry2" && R.outdoors.length === 1,
        JSON.stringify(R.walks.map((w) => w.label)),
      );
      check("phaseA-ladder: phases exit(attempt 2) then outdoor", r.phases.map((p) => p.phase).join(",") === "exit,outdoor" && r.phases[0].attempts === 2, JSON.stringify(r.phases));
    }
  }

  console.log(`\ngoto_compose: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
