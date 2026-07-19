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
const graphs = { [LBX]: null, [LBY]: null }; // filled per test
const lastLeg = (legs) => legs[legs.length - 1];
const isOutdoorLeg = (leg) => ((leg.lb >>> 0) & 0xffff) > 0 && ((leg.lb >>> 0) & 0xffff) < 0x100;

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "goto_compose.js")).href);
  const { composeGoto, walkLegs } = mod;
  check("exports composeGoto + walkLegs", typeof composeGoto === "function" && typeof walkLegs === "function");

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
        if (!knobs.noTeleport) setTimeout(() => { state.pose = { objCellId: 0x8fa00001, x: 50, y: 50, z: 0 }; state.cell = 0x8fa00001; }, 4);
        return true;
      },
    };
    // Fake indoor walk: "arrives" at the last leg's cell.
    const walk = async (legs) => {
      const last = legs[legs.length - 1];
      state.pose = { objCellId: last.lb >>> 0, x: last.x, y: last.y, z: last.z };
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
    const buildGraph = (knobs.dropGated ? dropGraph : flatGraph);
    const deps = {
      host, router: null, outdoorGoto, walk,
      buildGraph: async (lb) => (((lb >>> 0) & 0xffff0000) === LP ? buildGraph() : null),
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

  console.log(`\ngoto_compose: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
