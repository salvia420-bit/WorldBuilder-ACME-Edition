// tests/rynth_portal_hazards.test.mjs — rynth-macro-nav-6: proactive portal
// avoidance for the indoor graph walks (rynth/portal_hazards.js, wired into
// rynth/goto_compose.js behind the DEFAULT-OFF ?botPortalAvoid=on /
// opts.portalAvoid).
//
// Portals are ethereal: the cell graph and the walker's collision walk straight
// over one, and the touch teleports the player (ACE Player.OnCollideObject ->
// Portal.OnCollideObject). The indoor legs run centre to centre, and the first
// is the centre of the player's own cell.
//
//   F1-F2  the flag: absent / off reads false, on|1|true reads true;
//          opts.portalAvoid wins over the URL
//   H1-H4  portalHazards: ItemType / desc-flag portals, 80 m range, held items,
//          excludeGuids, the nearest-to-target exclusion, world frame + r
//   A1     a centre-to-centre leg crosses a portal disk -> a side-step leg is
//          inserted, and no segment (pose included) enters any disk
//   A2     the own-cell-centre leg inside a disk: dropped with dropLeading,
//          moved to the rim without it
//   A3     no clear detour (a wall of portals) -> the SAME legs array back
//   A4     the goal's own disk is exempt; a portal on another floor is ignored
//   A5     a walk starting inside a disk may head away; heading in steps out
//   A6     originalLegsWalked maps a walk count back past side-steps
//   S1     sidecarAvoidCircles: only portals near the straight line
//   C1     composeGoto indoor (same landblock), flag off: the walk gets exactly
//          toLegs(midpoints) + the goal leg and the host's object list is never
//          read; flag on: the walk avoids the portal
//   C2     composeGoto entry (Phase C), flag on: the arrival portal is avoided
//   C3     composeEgress (egress ladder), flag on: normalized legs avoid the
//          portal (side-steps keep the indoor watchdog); flag off unchanged
//   C4     the egress ladder's stalled-edge mapping counts side-steps out
//   O1     outdoor (case 0) is untouched either way: outdoorGoto gets the same
//          opts object, and GlobalRouter's first /route body has no `avoid`
//
// Run from apps/holtburger-web/:  node tests/rynth_portal_hazards.test.mjs

import assert from "node:assert/strict";

const PH = await import("../rynth/portal_hazards.js");
const GC = await import("../rynth/goto_compose.js");
const IR = await import("../rynth/indoor_router.js");
const { GlobalRouter } = await import("../rynth/global_router.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

// ── frame helpers (router.js / indoor_router.js world frame) ────────────────
const baseX = (lb) => (((lb >>> 0) >>> 24) & 0xff) * 192;
const baseY = (lb) => (((lb >>> 0) >>> 16) & 0xff) * 192;
const W = (leg) => ({ wx: baseX(leg.lb) + leg.x, wy: baseY(leg.lb) + leg.y, z: leg.z });
const localAt = (lb, wx, wy, z = 0) => ({ objCellId: lb >>> 0, x: wx - baseX(lb), y: wy - baseY(lb), z });

// Distance from point c to segment a-b (2D).
function segDist(a, b, c) {
  const dx = b.wx - a.wx;
  const dy = b.wy - a.wy;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.wx - a.wx) * dx + (c.wy - a.wy) * dy) / len2)) : 0;
  return Math.hypot(a.wx + dx * t - c.wx, a.wy + dy * t - c.wy);
}
// Every segment of start -> legs... keeps out of every disk (skipping disks
// that contain the goal, which the module exempts).
function assertClear(start, legs, disks, msg = "") {
  const pts = [start, ...legs.map(W)].filter(Boolean);
  const goal = pts[pts.length - 1];
  for (const d of disks) {
    if (Math.hypot(goal.wx - d.wx, goal.wy - d.wy) < d.r) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      const dist = segDist(pts[i], pts[i + 1], d);
      assert.ok(dist >= d.r - 1e-6, `${msg} segment ${i} passes ${dist.toFixed(3)} m from portal @${d.wx},${d.wy} (r ${d.r})`);
    }
  }
}

// ── a dungeon landblock 0x01D9: A - B - C along +x (world y 41700) ──────────
const LB = 0x01d90000;
const A = (LB | 0x100) >>> 0;
const B = (LB | 0x101) >>> 0;
const C = (LB | 0x102) >>> 0;
const WY = 41700; // 0xD9 * 192 = 41664 -> local y 36
const graph = () =>
  new Map([
    [A, { pos: { x: 200, y: WY, z: 0 }, neighbors: [B], exits: [] }],
    [B, { pos: { x: 220, y: WY, z: 0 }, neighbors: [A, C], exits: [] }],
    [C, { pos: { x: 240, y: WY, z: 0 }, neighbors: [B], exits: [] }],
  ]);

const R = PH.PORTAL_REACH_M + PH.PORTAL_CLEARANCE_M;
const disk = (wx, wy, z = 0, guid = 0x7a000001) => ({ guid, wx, wy, z, r: R });

// A fake host with world objects { guid: {cell, wx, wy, z, itemType?, desc?, container?} }.
function mkHost({ cell = A, pose, objects = {} } = {}) {
  const st = { nearbyCalls: 0 };
  const host = {
    st,
    s: { getCurrentCellId: () => cell >>> 0 },
    TryGetPlayerPose: () => pose,
    NearbyGuids: () => {
      st.nearbyCalls++;
      return Object.keys(objects).map(Number);
    },
    TryGetObjectIntProperty: (g, k) => (k === 1 ? (objects[g] && objects[g].itemType) ?? 0 : undefined),
    TryGetObjectDescFlags: (g) => (objects[g] && objects[g].desc) ?? 0,
    TryGetObjectPosition: (g) => {
      const o = objects[g];
      return o ? localAt(o.cell ?? A, o.wx, o.wy, o.z ?? 0) : null;
    },
    TryGetObjectOwnershipInfo: (g) => ({ container: (objects[g] && objects[g].container) || 0, wielder: 0, location: 0 }),
    TryGetObjectName: (g) => (objects[g] ? objects[g].name || "Portal" : null),
  };
  return host;
}
const PORTAL_IT = 0x00010000;

// ── F: the flag ─────────────────────────────────────────────────────────────
await check("F1 portalAvoidEnabled: absent/off/other -> false; on|1|true -> true", () => {
  assert.equal(PH.portalAvoidEnabled(""), false);
  assert.equal(PH.portalAvoidEnabled("?bot=1"), false);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=off"), false);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=yes"), false);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=on"), true);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=ON"), true);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=1"), true);
  assert.equal(PH.portalAvoidEnabled("?botPortalAvoid=true"), true);
  assert.equal(PH.portalAvoidEnabled(), false, "node has no page URL");
});
await check("F2 resolvePortalAvoid: opts.portalAvoid wins; default false; buildTune carries it", () => {
  assert.equal(PH.resolvePortalAvoid({}), false);
  assert.equal(PH.resolvePortalAvoid(undefined), false);
  assert.equal(PH.resolvePortalAvoid({ portalAvoid: true }), true);
  assert.equal(PH.resolvePortalAvoid({ portalAvoid: false }), false);
  assert.equal(PH.resolvePortalAvoid({ portalAvoid: "on" }), false, "a boolean option, not a URL string");
  assert.equal(GC.buildTune({}).portalAvoid, false);
  assert.equal(GC.buildTune({ portalAvoid: true }).portalAvoid, true);
});

// ── H: portalHazards ────────────────────────────────────────────────────────
await check("H1 portalHazards: ItemType and desc-flag portals, world frame, r = reach + clearance", () => {
  const host = mkHost({
    pose: localAt(A, 200, WY),
    objects: {
      0x7a000001: { wx: 215, wy: WY + 0.6, z: 0.25, itemType: PORTAL_IT },
      0x7a000002: { wx: 230, wy: WY, desc: 0x40000 },
      0x7a000003: { wx: 205, wy: WY, itemType: 0x10 }, // a creature
    },
  });
  const hz = PH.portalHazards(host);
  assert.equal(hz.length, 2);
  const p1 = hz.find((d) => d.guid === 0x7a000001);
  assert.ok(Math.abs(p1.wx - 215) < 1e-9 && Math.abs(p1.wy - (WY + 0.6)) < 1e-9 && p1.z === 0.25, JSON.stringify(p1));
  assert.ok(Math.abs(p1.r - 2.3) < 1e-9, `r ${p1.r}`);
  assert.equal(PH.portalHazards(host, { reachM: 1, clearanceM: 0.5 })[0].r, 1.5);
});
await check("H2 portalHazards: beyond 80 m of the player and held/contained portals are skipped", () => {
  const host = mkHost({
    pose: localAt(A, 200, WY),
    objects: {
      0x7a000001: { wx: 279, wy: WY, itemType: PORTAL_IT }, // 79 m
      0x7a000002: { wx: 281, wy: WY, itemType: PORTAL_IT }, // 81 m
      0x7a000003: { wx: 210, wy: WY, itemType: PORTAL_IT, container: 0x50000001 },
    },
  });
  assert.deepEqual(PH.portalHazards(host).map((d) => d.guid), [0x7a000001]);
  assert.equal(PH.portalHazards(host, { maxM: 200 }).length, 2);
  assert.equal(PH.portalHazards(host, { center: { wx: 280, wy: WY } }).length, 2, "explicit center");
});
await check("H3 portalHazards: excludeGuids and the nearest-to-target exclusion", () => {
  const host = mkHost({
    pose: localAt(A, 200, WY),
    objects: {
      0x7a000001: { wx: 210, wy: WY, itemType: PORTAL_IT },
      0x7a000002: { wx: 230, wy: WY, itemType: PORTAL_IT },
      0x7a000003: { wx: 236, wy: WY, itemType: PORTAL_IT },
    },
  });
  assert.deepEqual(PH.portalHazards(host, { excludeGuids: [0x7a000002] }).map((d) => d.guid), [0x7a000001, 0x7a000003]);
  // The transit target point sits 1 m from 0x7a000003: only that one is dropped.
  assert.deepEqual(PH.portalHazards(host, { target: { wx: 237, wy: WY } }).map((d) => d.guid), [0x7a000001, 0x7a000002]);
  // No portal within the target radius: nothing is dropped.
  assert.equal(PH.portalHazards(host, { target: { wx: 400, wy: WY, maxM: 5 } }).length, 3);
});
await check("H4 portalHazards: never throws on a hostile/absent host", () => {
  assert.deepEqual(PH.portalHazards(null), []);
  assert.deepEqual(PH.portalHazards({}), []);
  const hostile = {
    NearbyGuids: () => [1, 2],
    TryGetPlayerPose: () => {
      throw new Error("x");
    },
    TryGetObjectIntProperty: () => {
      throw new Error("x");
    },
    TryGetObjectDescFlags: () => 0x40000,
    TryGetObjectPosition: () => {
      throw new Error("x");
    },
  };
  assert.deepEqual(PH.portalHazards(hostile), []);
  assert.deepEqual(PH.portalHazards({ NearbyGuids: () => { throw new Error("x"); } }), []);
});

// ── A: avoidPortalDisks ─────────────────────────────────────────────────────
await check("A1 a centre-to-centre leg over a portal -> side-step inserted; nothing enters a disk", () => {
  const legs = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  const start = { wx: 199, wy: WY, z: 0 };
  // The B -> mid(B,C) leg (220 -> 230) passes 0.6 m from the portal at 225.
  const disks = [disk(225, WY + 0.6)];
  const r = PH.avoidPortalDisks(legs, disks, { start });
  assert.equal(r.changed, true);
  assert.ok(r.sideSteps >= 1, `sideSteps ${r.sideSteps}`);
  assert.equal(r.displaced, 0);
  assertClear(start, r.legs, disks, "A1");
  const steps = r.legs.filter((l) => l.portalSideStep);
  assert.equal(steps.length, r.sideSteps);
  for (const s of steps) {
    assert.equal(s.arriveM, PH.SIDE_STEP_ARRIVE_M);
    assert.equal(s.lb, (LB | 0x102) >>> 0, "stamped with the destination leg's cell (mid B-C)");
  }
  // The original legs survive in order; only the corner before the side-step tightens.
  const orig = r.legs.filter((l) => !l.portalSideStep).map(({ arriveM, ...l }) => l);
  assert.deepEqual(orig, legs);
  // The side-step goes round the side away from the portal (it sits north of the line).
  assert.ok(steps.every((s) => W(s).wy < WY), JSON.stringify(steps));
  // Input untouched.
  assert.equal(legs.some((l) => "portalSideStep" in l || "arriveM" in l), false);
});
await check("A2 the own-cell-centre leg inside a disk: dropped with dropLeading, moved without", () => {
  const legs = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  const start = { wx: 196, wy: WY, z: 0 };
  const disks = [disk(200.5, WY + 1)]; // A's centre (200, WY) sits 1.1 m from it
  const dropped = PH.avoidPortalDisks(legs, disks, { start, dropLeading: true });
  assert.equal(dropped.changed, true);
  assert.equal(dropped.dropped, 1);
  assert.equal(dropped.legs.some((l) => l.lb === A), false, "A's centre leg is gone");
  assertClear(start, dropped.legs, disks, "A2 drop");
  const moved = PH.avoidPortalDisks(legs, disks, { start });
  assert.equal(moved.dropped, 0);
  assert.equal(moved.displaced, 1);
  const m = moved.legs.find((l) => l.portalDisplaced);
  assert.ok(m && m.lb === A && m.arriveM === PH.SIDE_STEP_ARRIVE_M, JSON.stringify(m));
  const mw = W(m);
  assert.ok(Math.hypot(mw.wx - 200.5, mw.wy - (WY + 1)) >= R, "moved outside the disk");
  assertClear(start, moved.legs, disks, "A2 move");
});
await check("A3 no clear detour (a wall of portals across the way) -> the same legs array", () => {
  const legs = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  const disks = [disk(225, WY - 3, 0, 1), disk(225, WY, 0, 2), disk(225, WY + 3, 0, 3)];
  const r = PH.avoidPortalDisks(legs, disks, { start: { wx: 199, wy: WY, z: 0 } });
  assert.equal(r.changed, false);
  assert.equal(r.legs, legs, "identity, not a copy");
  assert.equal(typeof r.unresolved, "string");
  // Nothing near at all: same array, no unresolved note.
  const far = PH.avoidPortalDisks(legs, [disk(500, WY)], { start: { wx: 199, wy: WY, z: 0 } });
  assert.equal(far.legs, legs);
  assert.equal(far.changed, false);
  assert.equal(far.unresolved, undefined);
  assert.equal(PH.avoidPortalDisks(legs, []).legs, legs);
});
await check("A4 the goal's own portal disk is exempt; a portal on another floor is ignored", () => {
  const legs = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  const goalDisk = [disk(241, WY + 0.5)]; // contains C's centre (the goal)
  assert.equal(PH.avoidPortalDisks(legs, goalDisk, { start: { wx: 199, wy: WY, z: 0 } }).legs, legs);
  const below = [disk(225, WY + 0.6, -10)];
  assert.equal(PH.avoidPortalDisks(legs, below, { start: { wx: 199, wy: WY, z: 0 } }).legs, legs);
  const sameFloor = [disk(225, WY + 0.6, 2.5)];
  assert.equal(PH.avoidPortalDisks(legs, sameFloor, { start: { wx: 199, wy: WY, z: 0 } }).changed, true, "within the 3 m floor span");
});
await check("A5 starting inside a disk: heading away is clear; heading in steps out first", () => {
  const legs = [{ lb: A, x: 230 - baseX(A), y: WY - baseY(A), z: 0 }];
  const away = PH.avoidPortalDisks(legs, [disk(199, WY)], { start: { wx: 200, wy: WY, z: 0 } });
  assert.equal(away.legs, legs, "walking away from a portal we stand beside");
  const twoLegs = [
    { lb: A, x: 205 - baseX(A), y: WY - baseY(A), z: 0 },
    { lb: A, x: 230 - baseX(A), y: WY - baseY(A), z: 0 },
  ];
  const d = disk(201, WY);
  const toward = PH.avoidPortalDisks(twoLegs, [d], { start: { wx: 199.5, wy: WY, z: 0 } });
  assert.equal(toward.changed, true);
  const first = W(toward.legs[0]);
  assert.ok(toward.legs[0].portalSideStep && Math.hypot(first.wx - 201, first.wy - WY) >= R, JSON.stringify(toward.legs[0]));
  // Every segment after the first (which leaves the disk) is clear.
  assertClear(null, toward.legs, [d], "A5");
});
await check("A6 originalLegsWalked counts side-steps out (identity without them)", () => {
  const legs = [{ x: 0 }, { portalSideStep: true }, { x: 1 }, { portalSideStep: true }, { portalSideStep: true }, { x: 2 }];
  assert.equal(PH.originalLegsWalked(legs, 0), 0);
  assert.equal(PH.originalLegsWalked(legs, 1), 1);
  assert.equal(PH.originalLegsWalked(legs, 2), 1);
  assert.equal(PH.originalLegsWalked(legs, 3), 2);
  assert.equal(PH.originalLegsWalked(legs, 6), 3);
  assert.equal(PH.originalLegsWalked([{ x: 0 }, { x: 1 }], 2), 2);
});

// ── S: the outdoor helper (not wired yet) ───────────────────────────────────
await check("S1 sidecarAvoidCircles: only disks near the straight line, never one at either end", () => {
  const from = { wx: 0, wy: 0 };
  const to = { wx: 100, wy: 0 };
  const disks = [disk(50, 4), disk(50, 40), disk(100.5, 0.5), disk(-30, 0)];
  assert.deepEqual(PH.sidecarAvoidCircles(disks, from, to), [{ x: 50, y: 4, r: R }]);
  assert.deepEqual(PH.sidecarAvoidCircles([], from, to), []);
  // A wider corridor takes in (50, 40) and the one 30 m behind the start, never the end's own.
  assert.deepEqual(
    PH.sidecarAvoidCircles(disks, from, to, { corridorM: 40 }).map((c) => [c.x, c.y]),
    [[50, 4], [50, 40], [-30, 0]],
  );
});

// ── C: composeGoto / composeEgress wiring ───────────────────────────────────
const OPTS = { poseTimeoutMs: 60, pollMs: 2, stallMs: 500 };
function recorder() {
  const walks = [];
  const outdoors = [];
  return {
    walks,
    outdoors,
    walk: async (legs, o = {}) => {
      walks.push({ label: o.label, legs });
      return { ok: true, state: "DONE", legsWalked: legs.length };
    },
    outdoorGoto: async (to, o) => {
      outdoors.push({ to, opts: o });
      return { ok: true, state: "DONE", legsWalked: 2, coverage: "detour", replans: 0 };
    },
  };
}
const portalOnTheWay = { 0x7a000001: { wx: 225, wy: WY + 0.6, z: 0, itemType: PORTAL_IT } };
const goalC = { lb: C, x: 241 - baseX(C), y: WY - baseY(C), z: 0 };

await check("C1 composeGoto indoor, flag OFF: exactly toLegs(midpoints) + the goal leg; objects never read", async () => {
  const host = mkHost({ cell: A, pose: localAt(A, 199, WY), objects: portalOnTheWay });
  const rec = recorder();
  const r = await GC.composeGoto({ host, router: {}, outdoorGoto: rec.outdoorGoto, walk: rec.walk, buildGraph: async () => graph() }, goalC, OPTS);
  assert.equal(r.ok, true);
  assert.equal(rec.walks.length, 1);
  const expected = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  expected.push({ lb: C, x: goalC.x, y: goalC.y, z: 0 });
  assert.deepEqual(rec.walks[0].legs, expected);
  assert.equal(host.st.nearbyCalls, 0, "flag off never scans objects");
});
await check("C1b composeGoto indoor, flag ON: the walk side-steps the portal", async () => {
  const host = mkHost({ cell: A, pose: localAt(A, 199, WY), objects: portalOnTheWay });
  const rec = recorder();
  const logs = [];
  const r = await GC.composeGoto(
    { host, router: {}, outdoorGoto: rec.outdoorGoto, walk: rec.walk, buildGraph: async () => graph(), log: (m) => logs.push(m) },
    goalC,
    { ...OPTS, portalAvoid: true },
  );
  assert.equal(r.ok, true);
  const legs = rec.walks[0].legs;
  assert.ok(legs.some((l) => l.portalSideStep), JSON.stringify(legs));
  assertClear({ wx: 199, wy: WY, z: 0 }, legs, [disk(225, WY + 0.6)], "C1b");
  assert.deepEqual(legs[legs.length - 1], { lb: C, x: goalC.x, y: goalC.y, z: 0 }, "the goal leg is last, unchanged");
  assert.ok(logs.some((m) => /portal avoid/.test(m)), logs.join(" | "));
  // No portal near: the flag-on walk is the plain one.
  const rec2 = recorder();
  const quiet = mkHost({ cell: A, pose: localAt(A, 199, WY), objects: {} });
  await GC.composeGoto({ host: quiet, router: {}, outdoorGoto: rec2.outdoorGoto, walk: rec2.walk, buildGraph: async () => graph() }, goalC, { ...OPTS, portalAvoid: true });
  const plain = IR.toLegs(graph(), [A, B, C], { midpoints: true });
  plain.push({ lb: C, x: goalC.x, y: goalC.y, z: 0 });
  assert.deepEqual(rec2.walks[0].legs, plain);
});
await check("C2 composeGoto entry (Phase C), flag ON: the exit portal beside the arrival point is avoided", async () => {
  // Arrive outdoors-adjacent: start outdoors (cell 0x01D90001), the goal in C.
  // After the outdoor approach the pose reads A's doorway; the dungeon's exit
  // portal stands between the arrival point and A's centre.
  const arrival = localAt(LB | 0x0001, 196, WY);
  const host = mkHost({ cell: (LB | 0x0001) >>> 0, pose: arrival, objects: { 0x7a000009: { wx: 198.2, wy: WY + 0.3, itemType: PORTAL_IT } } });
  const rec = recorder();
  const r = await GC.composeGoto(
    { host, router: {}, outdoorGoto: rec.outdoorGoto, walk: rec.walk, buildGraph: async () => graph() },
    goalC,
    { ...OPTS, portalAvoid: true },
  );
  assert.equal(r.ok, true);
  const enter = rec.walks.find((w) => w.label === "enter");
  assert.ok(enter, "entry walk ran");
  // The arrival point sits inside the disk (2.2 m < 2.3 m) and the first leg
  // heads toward the portal, so the walk first steps out.
  assertClear(null, enter.legs, [disk(198.2, WY + 0.3)], "C2");
  const first = W(enter.legs[0]);
  assert.ok(Math.hypot(first.wx - 198.2, first.wy - (WY + 0.3)) >= R, JSON.stringify(enter.legs[0]));
});
await check("C3 composeEgress, flag ON: normalized legs avoid the portal; flag OFF unchanged", async () => {
  // A building whose exit cell A opens outdoors west; the player stands in C.
  const g = () => {
    const m = graph();
    m.get(A).exits = [(LB | 0x0001) >>> 0];
    return m;
  };
  const host = mkHost({ cell: C, pose: localAt(C, 241, WY), objects: { 0x7a000001: { wx: 215, wy: WY - 0.5, itemType: PORTAL_IT } } });
  let walked = null;
  const walk = async (legs) => {
    walked = legs;
    host.s.getCurrentCellId = () => (LB | 0x0001) >>> 0; // now outdoors
    return { ok: true, state: "DONE", legsWalked: legs.length };
  };
  const r = await GC.composeEgress({ host, router: {}, walk, buildGraph: async () => g() }, { ...OPTS, portalAvoid: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(walked.some((l) => l.portalSideStep), JSON.stringify(walked));
  for (const l of walked) assert.ok(l.x >= 0 && l.x < 192 && l.y >= 0 && l.y < 192, `normalized ${JSON.stringify(l)}`);
  assert.ok(walked.filter((l) => l.portalSideStep).every((l) => l.timeoutMs === 60_000), "side-steps keep the indoor watchdog");
  assertClear({ wx: 241, wy: WY, z: 0 }, walked, [disk(215, WY - 0.5)], "C3");
  // Flag off: no side-steps, objects never read.
  host.s.getCurrentCellId = () => C;
  host.st.nearbyCalls = 0;
  walked = null;
  await GC.composeEgress({ host, router: {}, walk, buildGraph: async () => g() }, OPTS);
  assert.equal(walked.some((l) => l.portalSideStep || l.arriveM !== undefined), false);
  assert.equal(host.st.nearbyCalls, 0);
});

await check("C4 egress ladder, flag ON: a stall on a doorway leg after a side-step blames that doorway edge", async () => {
  // Path C -> B -> A; the portal at (225, +0.6) puts ONE side-step before the
  // B->A 30% leg: [C-B 30%, C-B 50%, SIDE, B-A 30%, B-A 50%, A centre, outdoor].
  // A walk that stalls with 4 legs walked is on the B->A 50% leg: edge B-A.
  // Counting the side-step as a doorway leg would read 4 >= 2*2 legs -> no
  // edge, and the ladder would never exclude it.
  const g = () => {
    const m = graph();
    m.get(A).exits = [(LB | 0x0001) >>> 0];
    return m;
  };
  const host = mkHost({ cell: C, pose: localAt(C, 241, WY), objects: { 0x7a000001: { wx: 225, wy: WY + 0.6, itemType: PORTAL_IT } } });
  const logs = [];
  const seen = [];
  const walk = async (legs) => {
    seen.push(legs);
    return { ok: false, state: "FAILED", error: "leg timeout", legsWalked: 4 };
  };
  const r = await GC.composeEgress({ host, router: {}, walk, buildGraph: async () => g(), log: (m) => logs.push(m) }, { ...OPTS, portalAvoid: true });
  assert.equal(r.ok, false);
  assert.equal(seen[0][2].portalSideStep, true, JSON.stringify(seen[0]));
  assert.equal(seen[0].filter((l) => l.portalSideStep).length, 1);
  assert.ok(
    logs.some((m) => m.includes(`doorway edge ${IR.edgeKey(B, A)} wedged twice`)),
    logs.join(" | "),
  );
});

// ── O: the outdoor first request ────────────────────────────────────────────
await check("O1 outdoor case 0: outdoorGoto gets the same opts either way; GlobalRouter's first body has no avoid", async () => {
  const host = mkHost({ cell: (LB | 0x0001) >>> 0, pose: localAt(LB | 0x0001, 196, WY), objects: portalOnTheWay });
  for (const portalAvoid of [undefined, true]) {
    const rec = recorder();
    const opts = { ...OPTS, ...(portalAvoid ? { portalAvoid } : {}) };
    await GC.composeGoto({ host, router: {}, outdoorGoto: rec.outdoorGoto, walk: rec.walk }, { ns: 1, ew: 2 }, opts);
    assert.equal(rec.outdoors.length, 1);
    assert.equal(rec.outdoors[0].opts, opts, "the caller's opts object, untouched");
    assert.equal("avoid" in rec.outdoors[0].opts, false);
  }
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: false, error: "stub" }) };
  };
  try {
    const gr = new GlobalRouter(host, { log: () => {} });
    await gr.goto({ status: { state: "IDLE" }, follow() {}, cancel() {} }, { ns: 1, ew: 2 }, { poseTimeoutMs: 10, pollMs: 1 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies.length, 1);
  assert.equal("avoid" in bodies[0], false, JSON.stringify(bodies[0]));
});

console.log(fail === 0 ? `rynth_portal_hazards: all ${pass} checks passed` : `rynth_portal_hazards: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
