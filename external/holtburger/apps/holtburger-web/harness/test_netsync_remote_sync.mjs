// harness/test_netsync_remote_sync.mjs — NETSYNC (2026-10-07, Coldeve capture).
//
// Covers:
//   1. `__diag.remoteSync` (scene3d/diag/remote_sync.js): the per-update
//      classification (jump / correction / held) on cases lifted from the
//      capture, the summary roll-up, and the remote cast tallies.
//   2. The hook sites are wired where the numbers are true: entities.js
//      `setPose` reads the drawn rig BEFORE `_wirePos` advances; the cast
//      gesture / action hooks sit on the commit paths; diag.js attaches it.
//   3. NETSYNC-1 (Rust, `?remoteMotionKeep`) is present in source: the scene
//      switch, the WorldState re-seed, the wasm flag parse + plumbing. The
//      behaviour itself is the Rust unit test
//      `netsync1_remote_body_keeps_motion_state_across_position_corrections`
//      (cargo test -p holtburger-world netsync1).
//
// Run: node harness/test_netsync_remote_sync.mjs   (cwd = apps/holtburger-web)

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRemoteUpdate,
  classifyHeldReason,
  createRemoteSync,
  attachRemoteSync,
  MOVING_M,
  HELD_M,
  FAR_M,
} from "../scene3d/diag/remote_sync.js";
import { ghostRigSweepStep, GHOST_RIG_GRACE_MS, GHOST_RIG_SWEEP_ON } from "../scene3d/ghost_rigs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const HB = path.resolve(APP, "..", "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ─── 1. classification ────────────────────────────────────────────────────
// Capture (Bashe, t=1353→1694 ms): server pose stepped 3.86 m; the rig had
// converged onto the previous pose and stood there (err 0.00) → held.
check("held: the rig stood on the previous server pose (capture: Bashe 1.7 s)", () => {
  const prev = { x: 32505.99, y: 34562.46 };
  const next = { x: 32503.04, y: 34559.97 };
  const c = classifyRemoteUpdate({ x: 32505.99, y: 34562.46 }, prev, next);
  assert.ok(c.moving, "a 3.9 m step is locomotion");
  assert.ok(c.held, "drawn == previous server pose → held");
  assert.ok(near(c.ratio, 1, 1e-9), `no better than standing still, ratio ${c.ratio}`);
});

check("dead-reckoned: the rig ran on toward the next pose → low ratio", () => {
  const prev = { x: 0, y: 0 };
  const next = { x: 0, y: 4 };
  const c = classifyRemoteUpdate({ x: 0.2, y: 3.7 }, prev, next);
  assert.ok(c.moving && !c.held);
  assert.ok(c.ratio < 0.15, `ratio ${c.ratio}`);
});

check("overshoot (capture: Yeevoid II 142.9 s, 11 m past a 2.5 m step)", () => {
  const prev = { x: 32543.29, y: 34579.39 };
  const next = { x: 32545.77, y: 34577.69 };
  const c = classifyRemoteUpdate({ x: 32554.34, y: 34579.02 }, prev, next);
  assert.ok(!c.held);
  assert.ok(c.ratio > 2.5, `an overshoot reads as ratio > 1: ${c.ratio}`);
});

check("first update (no previous pose) and teleport-class steps are skipped", () => {
  assert.equal(classifyRemoteUpdate({ x: 0, y: 0 }, null, { x: 1, y: 1 }), null);
  assert.equal(classifyRemoteUpdate({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 60 }), null);
});

check("standing jitter below MOVING_M is not a moving update", () => {
  const c = classifyRemoteUpdate({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0.1, y: 0 });
  assert.ok(!c.moving && !c.held);
  assert.ok(MOVING_M === 0.5 && HELD_M === 0.05);
});

// ─── 1b. summary + cast tallies ──────────────────────────────────────────
check("summary: held fraction, correction/ratio percentiles, worst list", () => {
  let now = 0;
  const rs = createRemoteSync(() => (now += 200));
  // 4 held updates + 1 dead-reckoned update for one runner.
  let p = { x: 0, y: 0 };
  for (let i = 0; i < 4; i += 1) {
    const n = { x: 0, y: p.y + 4 };
    rs.onWirePose(0x50001234, "Runner", { x: p.x, y: p.y }, p, n);
    p = n;
  }
  const n = { x: 0, y: p.y + 4 };
  rs.onWirePose(0x50001234, "Runner", { x: 0, y: p.y + 3.8 }, p, n);
  const s = rs.summary();
  assert.equal(s.remotes, 1);
  assert.equal(s.movingUpdates, 5);
  assert.equal(s.heldFrac, 0.8);
  assert.equal(s.jumpP50, 4);
  assert.equal(s.worst[0].name, "Runner");
  assert.equal(s.worst[0].heldFrac, 0.8);
  assert.ok(rs.tail.length === 5);
});

check("cast tallies: gestures with/without the raise link, actions played/missed", () => {
  const rs = createRemoteSync(() => 0);
  rs.onCastGesture(0x50063081, 0x4000002c, true, true, "Yeecher");
  rs.onCastGesture(0x50063081, 0x4000002c, false, true, "Yeecher");
  rs.onCastAction(0x50063081, 0x1000006f, true, "Yeecher");
  rs.onCastAction(0x50063081, 0x1000006f, false, "Yeecher");
  const c = rs.summary().cast;
  assert.deepEqual(
    [c.gestures, c.gestureLinkPlayed, c.gestureNoLink, c.actions, c.actionsPlayed, c.actionsMissed],
    [2, 1, 1, 2, 1, 1],
  );
  assert.equal(rs.byGuid.get(0x50063081).cast.linkPlayed, 1);
  rs.reset();
  assert.equal(rs.summary().cast.gestures, 0);
  assert.equal(rs.byGuid.size, 0);
});

check("attachRemoteSync installs once on the diag object", () => {
  const diag = {};
  const a = attachRemoteSync(diag);
  assert.equal(diag.remoteSync, a);
  assert.equal(attachRemoteSync(diag), a, "idempotent");
});

// ─── 2. hook sites ────────────────────────────────────────────────────────
const ENT = fs.readFileSync(path.join(APP, "scene3d", "entities.js"), "utf8");
check("entities.js setPose reads the drawn rig BEFORE _wirePos advances", () => {
  const i = ENT.indexOf("  setPose(guid, x, y, z, qw, qx, qy, qz) {");
  assert.ok(i > 0);
  const body = ENT.slice(i, i + 7000);
  const hook = body.indexOf("rs.onWirePose(g, inst.meta?.name, inst.root.position, inst._wirePos, { x, y }, {");
  const adv = body.indexOf("wp.set(x, y, z);");
  assert.ok(hook > 0, "onWirePose hook missing");
  assert.ok(adv > hook, "the hook must run before the wire pose is overwritten");
  // round 2: the held-reason context rides the hook.
  for (const k of ["wasmDriven: (inst._wasmDriven | 0) > 0,", "bodyState: () => window.__sessionHandle?.remoteBodyState?.(g),", "playerPose: () => this._localPlayerWorldPose(),"]) {
    assert.ok(body.includes(k), `ctx field missing: ${k}`);
  }
});

check("entities.js reports remote cast gestures and action links", () => {
  assert.ok(ENT.includes("window.__diag?.remoteSync?.onCastGesture?.("), "gesture hook");
  assert.ok(ENT.includes("guid >>> 0, cmd >>> 0, entryPlayed, !!entry?.clip, inst.meta?.name,"), "gesture args");
  assert.ok(ENT.includes("window.__diag?.remoteSync?.onCastAction?.("), "action hook");
  assert.ok(ENT.includes("played ? null : { reason: inst._linkMissReason ?? \"unknown\", cls, stance: stance >>> 0, fromCmd: READY_SUBSTATE >>> 0 },"), "miss reason forwarded");
  for (const r of ["noWasm", "removed", "superseded", "lateSkip", "noLink", "playFailed"]) {
    assert.ok(ENT.includes(`inst._linkMissReason = "${r}";`), `_tryPlayLink records ${r}`);
  }
});

check("diag.js attaches the remoteSync surface", () => {
  const D = fs.readFileSync(path.join(APP, "scene3d", "diag.js"), "utf8");
  assert.ok(D.includes('import { attachRemoteSync as _attachRemoteSync } from "./diag/remote_sync.js";'));
  assert.ok(D.includes('["remoteSync", _attachRemoteSync],'));
});

// ─── 3. NETSYNC-1 (Rust) present in source ───────────────────────────────
check("NETSYNC-1: scene switch + WorldState re-seed + wasm flag plumbing", () => {
  const scene = fs.readFileSync(path.join(HB, "crates", "holtburger-world", "src", "spatial", "scene.rs"), "utf8");
  assert.ok(scene.includes("remote_motion_keep_enabled: true,"), "default ON");
  assert.ok(scene.includes("pub fn remote_motion_keep_active(&self) -> bool {"));
  const mut = fs.readFileSync(path.join(HB, "crates", "holtburger-world", "src", "state", "mutations.rs"), "utf8");
  assert.ok(mut.includes("self.scene.remote_motion_keep_active()"), "re-seed gate");
  assert.ok(mut.includes(".and_then(|entity| entity.motion_snapshot);"), "re-seed source = entity snapshot");
  const lib = fs.readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  assert.ok(lib.includes('!trimmed.split(\'&\').any(|kv| kv == "remoteMotionKeep=off")'), "parse is `=off` escape");
  assert.ok(lib.includes("let remote_motion_keep_on: bool = parse_remote_motion_keep_flag(&flag_search());"));
  for (const f of [["src", "session", "commands", "lifecycle.rs"], ["src", "session", "messages", "login.rs"]]) {
    const src = fs.readFileSync(path.join(APP, ...f), "utf8");
    assert.ok(src.includes(".set_remote_motion_keep_enabled(remote_motion_keep_on);"), f.join("/"));
    assert.ok(src.includes("new_world.scene.set_remote_turn_enabled(remote_turn_on);"), f.join("/") + " (NETSYNC-3)");
  }
  const tests = fs.readFileSync(path.join(HB, "crates", "holtburger-world", "src", "state", "tests.rs"), "utf8");
  assert.ok(tests.includes("fn netsync1_remote_body_keeps_motion_state_across_position_corrections()"));
});

check("url-flags.md documents the NETSYNC flags", () => {
  const doc = fs.readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  assert.ok(/^\| `remoteMotionKeep` \|/m.test(doc), "remoteMotionKeep row");
  assert.ok(/^\| `remoteTurnGateFix` \|/m.test(doc), "remoteTurnGateFix row");
  assert.ok(/^\| `remoteTurn` \|/m.test(doc), "remoteTurn row (NETSYNC-3)");
  assert.ok(/^\| `maintPrune` \| `off`/m.test(doc), "maintPrune row now default-on (NETSYNC-4)");
});

// ─── round 2 (2026-10-07): held reasons, far gating, metric, misses ───────
// remoteBodyState layout (src/lib.rs remote_body_state): see remote_sync.js.
const bs = (o = {}) => {
  const a = new Array(15).fill(0);
  a[6] = 1; // contact
  a[14] = 1; // has motion state
  for (const [k, v] of Object.entries(o)) a[+k] = v;
  return a;
};
check("held reasons: structural causes win, in order", () => {
  assert.equal(classifyHeldReason(null, false), "noBodyNoRows");
  assert.equal(classifyHeldReason(undefined, true), "noBodyState");
  assert.equal(classifyHeldReason(bs({ 7: 1, 0: 7, 11: 4 }), true), "indoor");
  assert.equal(classifyHeldReason(bs({ 10: 1 }), true), "airborne");
  assert.equal(classifyHeldReason(bs({ 6: 0 }), true), "noContact");
  assert.equal(classifyHeldReason(bs({ 9: 1 }), true), "sticky");
  assert.equal(classifyHeldReason(bs({ 8: 2 }), true), "moveToWalk");
  assert.equal(classifyHeldReason(bs({ 8: 1 }), true), "moveToTurn");
  assert.equal(classifyHeldReason(bs({ 14: 0 }), true), "noMotionState");
  assert.equal(classifyHeldReason(bs({ 0: 3 }), true), "noForwardAxis");
  assert.equal(classifyHeldReason(bs({ 0: 7, 1: 0 }), true), "zeroForwardSpeed");
  assert.equal(classifyHeldReason(bs({ 0: 7, 1: 1, 11: 4 }), true), "walkStalled");
  assert.equal(classifyHeldReason(bs({ 0: 7, 1: 1, 11: 4 }), false), "rowsNotFlowing");
});

check("summary: held reasons tallied; ratioMovedP50 / beatHoldFrac ignore the held cluster", () => {
  const rs = createRemoteSync(() => 0);
  const ctxIndoor = { wasmDriven: true, bodyState: () => bs({ 7: 1 }) };
  // 3 held (indoor) + 2 good dead-reckoned updates.
  let p = { x: 0, y: 0 };
  for (let i = 0; i < 3; i += 1) {
    const n = { x: 0, y: p.y + 4 };
    rs.onWirePose(0x50001, "Indoors", { x: p.x, y: p.y }, p, n, ctxIndoor);
    p = n;
  }
  for (let i = 0; i < 2; i += 1) {
    const n = { x: 0, y: p.y + 4 };
    rs.onWirePose(0x50001, "Indoors", { x: 0, y: p.y + 3.6 }, p, n, ctxIndoor);
    p = n;
  }
  const s = rs.summary();
  assert.equal(s.heldFrac, 0.6);
  assert.deepEqual(s.heldReasons, { indoor: 3 });
  assert.equal(s.ratioP50, 1, "the legacy median sits in the held cluster");
  assert.equal(s.ratioMovedP50, 0.1, "non-held updates: 0.4 m / 4 m");
  assert.equal(s.beatHoldFrac, 0.4);
  assert.deepEqual(s.worst[0].heldReasons, { indoor: 3 });
});

check("far updates (> FAR_M from the player) are not scored", () => {
  const rs = createRemoteSync(() => 0);
  const far = { playerPose: () => ({ x: 0, y: -FAR_M - 10 }) };
  assert.equal(rs.onWirePose(0x50002, "Away", { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 4 }, far), null);
  const s = rs.summary();
  assert.equal(s.farUpdates, 1);
  assert.equal(s.movingUpdates, 0);
});

check("action misses keep reason, class and command", () => {
  const rs = createRemoteSync(() => 0);
  rs.onCastAction(0x50003, 0x13000087, false, "Waver", { reason: "noLink", cls: "attack", stance: 0x8000003c });
  rs.onCastAction(0x50003, 0x1000006f, false, "Waver", { reason: "lateSkip", cls: "cast", stance: 0x80000049 });
  const c = rs.summary().cast;
  assert.deepEqual(c.missReasons, { noLink: 1, lateSkip: 1 });
  assert.equal(c.lastMisses[0].action, "0x13000087");
  assert.equal(c.lastMisses[1].stance, "0x80000049");
  rs.reset();
  assert.deepEqual(rs.summary().cast.missReasons, {});
});

check("NETSYNC-3/-4 + remoteBodyState present in source", () => {
  const scene = fs.readFileSync(path.join(HB, "crates", "holtburger-world", "src", "spatial", "scene.rs"), "utf8");
  assert.ok(scene.includes("remote_turn_enabled: true,"), "remoteTurn default ON");
  assert.ok(scene.includes("body.pose.rotation = body.pose.rotation.multiply(spin).normalize();"), "turn step");
  const types = fs.readFileSync(path.join(HB, "crates", "holtburger-world", "src", "spatial", "types.rs"), "utf8");
  assert.ok(types.includes("pub const RETAIL_HUMAN_TURN_RIGHT_OMEGA_Z: f32 = -1.5;"), "DAT-pinned player omega");
  const lib = fs.readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
  assert.ok(lib.includes('!trimmed.split(\'&\').any(|kv| kv == "remoteTurn=off")'), "remoteTurn `=off` escape");
  assert.ok(lib.includes('!trimmed.split(\'&\').any(|kv| kv == "maintPrune=off")'), "maintPrune now `=off` escape");
  assert.ok(lib.includes("#[wasm_bindgen(js_name = remoteBodyState)]"), "remoteBodyState export");
  const dat = fs.readFileSync(path.join(HB, "crates", "holtburger-dat", "src", "file_type", "motion_table.rs"), "utf8");
  assert.ok(dat.includes("fn netsync3_turn_right_omega_is_clockwise_in_retail_tables()"), "DAT sign test");
});

// ─── NETSYNC-4b: ghost player-rig backstop (scene3d/ghost_rigs.js) ───────
check("ghost rigs: a player rig unknown to wasm for 30 s is dropped; others never", () => {
  assert.equal(GHOST_RIG_SWEEP_ON, true, "default ON (no window in Node)");
  assert.ok(GHOST_RIG_GRACE_MS > 25000, "grace exceeds retail's 25 s so the KIND_REMOVE path wins");
  const state = new Map();
  const LOCAL = 0x5006c651, GHOST = 0x5006bdac, LIVE = 0x5006c655, NPC = 0x80001a95;
  const rigs = [LOCAL, GHOST, LIVE, NPC];
  const known = (g) => g === LOCAL || g === LIVE; // wasm forgot GHOST (and never had the NPC)
  assert.deepEqual(ghostRigSweepStep(state, 0, rigs, known, LOCAL), [], "first sighting arms the timer");
  assert.deepEqual(ghostRigSweepStep(state, 29000, rigs, known, LOCAL), [], "inside the grace");
  assert.deepEqual(ghostRigSweepStep(state, 30000, rigs, known, LOCAL), [GHOST], "dropped at the grace");
  assert.equal(state.size, 0, "state cleared for the dropped guid");
  // A guid the wasm knows again resets; a non-player is never swept; local never.
  ghostRigSweepStep(state, 0, [GHOST], () => false, LOCAL);
  ghostRigSweepStep(state, 10000, [GHOST], () => true, LOCAL);
  assert.deepEqual(ghostRigSweepStep(state, 45000, [GHOST], () => false, LOCAL), [], "re-known resets the timer");
  assert.deepEqual(ghostRigSweepStep(new Map(), 0, [NPC, LOCAL], () => false, LOCAL), []);
  // A rig that left by itself is forgotten.
  const st = new Map([[GHOST, 0]]);
  ghostRigSweepStep(st, 1, [], () => false, LOCAL);
  assert.equal(st.size, 0);
});

check("loop.js runs the ghost sweep after the managed-pose drain, typeof-guarded", () => {
  const LOOP = fs.readFileSync(path.join(APP, "scene3d", "loop.js"), "utf8");
  assert.ok(LOOP.includes('import { GHOST_RIG_SWEEP_ON, GHOST_RIG_SWEEP_INTERVAL_MS, ghostRigSweepStep } from "./ghost_rigs.js";'));
  assert.ok(LOOP.includes('if (typeof ghostRigSweepStep !== "function" || typeof GHOST_RIG_SWEEP_ON === "undefined") return;'));
  const drain = LOOP.indexOf("    drainRemotePoses(scene3d, sessionHandle);\n    // NETSYNC-4b");
  const sweep = LOOP.indexOf("    sweepGhostRigs(scene3d, sessionHandle);");
  assert.ok(drain > 0 && sweep > drain, "sweep follows drainRemotePoses in tickPerFrame");
  assert.ok(LOOP.includes("try { _armRemove(scene3d, em, { guid: g }); } catch (_) {}"), "removal rides the KIND_REMOVE path");
});

console.log(`\ntest_netsync_remote_sync: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
