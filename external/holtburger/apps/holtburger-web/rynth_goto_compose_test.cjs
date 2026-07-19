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

  console.log(`\ngoto_compose: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
