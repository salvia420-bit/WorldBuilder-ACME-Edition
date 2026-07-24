// indoor_nav_no_pose.test.mjs — regression tests for the Town Network
// ("Facility Hub", landblock 0x0007) indoor-navigation wedge (2026-07-24,
// branch fix/indoor-nav-no-pose):
//
//   1. nav_frame.normalizeLegWorldFrame — the shared world-frame re-bucket
//      (goto_compose.js convention). Town Network EnvCell frames carry
//      cell-local coords OUTSIDE [0,192) (y ≈ −70); raw legs fed
//      MoveToPosition the documented "cell re-derivation garbage" frame.
//   2. webhost.js snap-pose heal — a raw pose whose landblockId reads 0
//      (login/teleport straight into a dungeon; the WP-3 shadow had nothing
//      to retain) is healed from getCurrentCellId() so nav consumers get a
//      correct objCellId/world frame. cellResolved is NOT faked.
//   3. ai/tools/world.js indoorLegsTo — legs come out normalized (world
//      point preserved, outdoor-bucketed lb/locals in range) even when the
//      dungeon frame carries negative locals.
//
// Standalone node script (repo test convention): run with
//   cd apps/holtburger-web && node tests/indoor_nav_no_pose.test.mjs

const here = new URL(".", import.meta.url);
const navFrame = await import(new URL("../rynth/nav_frame.js", here));
const { RynthWebHost } = await import(new URL("../rynth/webhost.js", here));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

// ── 1. normalizeLegWorldFrame ───────────────────────────────────────────────
{
  const { normalizeLegWorldFrame, worldX, worldY } = navFrame;
  // Town Network cell 0x00070178: lb frame (0x00, 0x07), local y NEGATIVE.
  const raw = { lb: 0x00070178, x: 121, y: -70, z: 0, portal: true };
  const n = normalizeLegWorldFrame(raw);
  check(
    "TN leg world point preserved",
    worldX(n.lb, n.x) === worldX(raw.lb, raw.x) && worldY(n.lb, n.y) === worldY(raw.lb, raw.y),
    JSON.stringify(n)
  );
  check("TN leg locals in [0,192)", n.x >= 0 && n.x < 192 && n.y >= 0 && n.y < 192, JSON.stringify(n));
  check("TN leg lb re-bucketed to containing landblock (0x00,0x06)",
    ((n.lb >>> 24) & 0xff) === 0x00 && ((n.lb >>> 16) & 0xff) === 0x06, n.lb.toString(16));
  check("TN leg low word is an outdoor LandCell (1..64)",
    (n.lb & 0xffff) >= 1 && (n.lb & 0xffff) <= 64, n.lb.toString(16));
  check("TN leg extra fields preserved (portal flag, z)", n.portal === true && n.z === 0, JSON.stringify(n));

  // In-range indoor leg: world point + locals unchanged; lb becomes the same
  // landblock's outdoor cell (the goto_compose convention).
  const inRange = { lb: 0x860201b0, x: 60, y: 50, z: 3 };
  const n2 = normalizeLegWorldFrame(inRange);
  check(
    "in-range leg x/y identity, same landblock",
    n2.x === 60 && n2.y === 50 && ((n2.lb >>> 24) & 0xff) === 0x86 && ((n2.lb >>> 16) & 0xff) === 0x02,
    JSON.stringify(n2)
  );

  // Outdoor leg: identity up to float round-trip wobble (already normalized).
  const outdoor = { lb: 0xa9b40019, x: 84, y: 7.1, z: 94 };
  const n3 = normalizeLegWorldFrame(outdoor);
  check(
    "outdoor leg identity (epsilon)",
    n3.lb === outdoor.lb && Math.abs(n3.x - outdoor.x) < 1e-6 && Math.abs(n3.y - outdoor.y) < 1e-6,
    JSON.stringify(n3)
  );
}

// ── 2. webhost snap-pose heal ───────────────────────────────────────────────
function makeSession({ rawLb, currentCell }) {
  return {
    getLocalPlayerPose: () => ({ landblockId: rawLb, x: 121, y: -70, z: 0, heading: 0 }),
    getLocalPlayerPoseCellResolved: () => false,
    getCurrentCellId: () => currentCell,
    pursuitStatus: () => 0,
    nearbyEntityGuids: () => new Uint32Array(0),
  };
}
{
  // Raw pose cell 0 + session knows the cell -> healed objCellId.
  const host = new RynthWebHost(makeSession({ rawLb: 0, currentCell: 0x00070178 }), { noEventTap: true });
  host._tick();
  const p = host.TryGetPlayerPose();
  check("raw lb 0 healed from getCurrentCellId", p && (p.objCellId >>> 0) === 0x00070178, JSON.stringify(p));
  check("healed pose keeps coords", p && p.x === 121 && p.y === -70 && p.z === 0, JSON.stringify(p));
  check("cellResolved NOT faked by the heal", p && p.cellResolved === false, JSON.stringify(p));
}
{
  // Raw pose valid -> untouched (heal must not fire).
  const host = new RynthWebHost(makeSession({ rawLb: 0xa9b40019, currentCell: 0x00070178 }), { noEventTap: true });
  host._tick();
  const p = host.TryGetPlayerPose();
  check("valid raw lb untouched", p && (p.objCellId >>> 0) === 0xa9b40019, JSON.stringify(p));
}
{
  // Raw pose 0 AND session cell 0 -> stays 0 (legacy sentinel preserved).
  const host = new RynthWebHost(makeSession({ rawLb: 0, currentCell: 0 }), { noEventTap: true });
  host._tick();
  const p = host.TryGetPlayerPose();
  check("no cell anywhere stays 0", p && (p.objCellId >>> 0) === 0, JSON.stringify(p));
}
{
  // Host without getCurrentCellId (stale pkg) -> graceful degrade, stays 0.
  const s = makeSession({ rawLb: 0, currentCell: 0x00070178 });
  delete s.getCurrentCellId;
  const host = new RynthWebHost(s, { noEventTap: true });
  host._tick();
  const p = host.TryGetPlayerPose();
  check("stale pkg (no getCurrentCellId) degrades to 0", p && (p.objCellId >>> 0) === 0, JSON.stringify(p));
}

// ── 3. indoorLegsTo emits normalized legs for a negative-local dungeon ──────
{
  const worldTools = await import(new URL("../rynth/ai/tools/world.js", here));
  const actions = {};
  for (const def of worldTools.worldActions()) actions[def.type] = def;
  const { worldX, worldY } = navFrame;

  // Two-cell Town-Network-style graph in the 0x0007 landblock frame with
  // NEGATIVE local y: world pos = lbX*192 + localX, lbY*192 + localY.
  const LBX = 0x00 * 192, LBY = 0x07 * 192;
  const graph = new Map([
    [0x00070178, { pos: { x: LBX + 121, y: LBY - 70, z: 0 }, neighbors: [0x00070175] }],
    [0x00070175, { pos: { x: LBX + 131, y: LBY - 70, z: 0 }, neighbors: [0x00070178] }],
  ]);

  const calls = [];
  let pose = { objCellId: 0x00070178, x: 121, y: -70, z: 0 };
  const host = {
    TryGetPlayerPose: () => pose,
    __setPose: (p) => { pose = p; },
    TryGetObjectPosition: (g) => (g === 0x5001 ? { objCellId: 0x00070175, x: 131, y: -70, z: 0 } : null),
    NearbyGuids: () => [0x5001],
    TryGetObjectName: (g) => (g === 0x5001 ? "Lin Portal" : null),
    UseObject: (g) => { calls.push(["use", g]); return true; },
    MoveToPosition: (...a) => { calls.push(["moveTo", ...a]); return true; },
    PursueObject: (...a) => { calls.push(["pursue", ...a]); return true; },
    StopCompletely: () => {},
    GetPursuitStatus: () => ({ now: 0, last: 0 }),
  };
  const router = {
    state: "IDLE",
    followed: null,
    walked: 0,
    legTimeoutMs: 50,
    follow(legs) {
      this.followed = legs;
      this.state = "DONE";
      this.walked = legs.length;
      const last = legs[legs.length - 1];
      host.__setPose({ objCellId: last.lb, x: last.x, y: last.y, z: last.z });
    },
    cancel() { this.state = "IDLE"; },
    get done() { return this.state === "DONE" || this.state === "FAILED"; },
    get status() { return { state: this.state, leg: 0, legs: this.followed?.length ?? 0, walked: this.walked }; },
  };
  const bot = { host, router, kernel: { running: false, stop() {}, start() {} }, indoorGraph: graph };

  const journal = { add: () => {} };
  const r = await actions.use_object.apply(bot, { type: "use_object", object: "Lin Portal" }, { journal });
  const legs = router.followed;
  check("TN cross-room use_object routed", !!r && r.ok === true && Array.isArray(legs) && legs.length >= 1, JSON.stringify(r));
  check(
    "TN legs all in-range locals (normalized)",
    Array.isArray(legs) && legs.every((l) => l.x >= 0 && l.x < 192 && l.y >= 0 && l.y < 192),
    JSON.stringify(legs)
  );
  check(
    "TN legs all outdoor-bucketed lb (no raw EnvCell frame)",
    Array.isArray(legs) && legs.every((l) => (l.lb & 0xffff) < 0x100),
    JSON.stringify(legs)
  );
  check(
    "TN final leg world point == target world point",
    Array.isArray(legs) &&
      worldX(legs[legs.length - 1].lb, legs[legs.length - 1].x) === LBX + 131 &&
      worldY(legs[legs.length - 1].lb, legs[legs.length - 1].y) === LBY - 70,
    JSON.stringify(legs)
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
