// tests/remote_jump_arc.test.mjs — OpenAC comparison 2026-10-04, remote
// motion D3 + D7 (docs/openac-comparison-2026-10-04/4-remote-motion.md).
//
// D7: a remote player's jump rose along the LINEAR 500 ms VectorUpdate
// extrapolation (no gravity) and then popped to the next wire pose. Retail
// runs full physics on every remote within 96 m (CPhysics::UseTime →
// update_object acclient.c:311375 → UpdatePhysicsInternal :317701, gravity
// -9.8 :45824), so the jump is a parabola that lands on the ground.
// D3: retail drops a remote's `!contact` position outright
// (CPhysicsObj::MoveOrTeleport :323481-323482); ours reached setPose, which
// retargeted heading, cleared the sticky glue and eased toward the mid-air
// pose. The wasm now carries the wire contact bit on KIND_POSITION
// (`weenieFlags`), and setPose drops `!contact` poses while a remote flies its
// arc.
//
// The arc physics is a pure module (scene3d/remote_airborne.js) driven
// directly; the entities.js / loop.js / position.rs wiring needs THREE + DOM +
// wasm, so it is pinned by source assertions (tests/attackable_target.test.mjs
// style).
//
// Run: node tests/remote_jump_arc.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RETAIL_GRAVITY,
  RETAIL_MAX_VELOCITY,
  REMOTE_JUMP_VZ_MIN,
  WIRE_FLAGS_PRESENT,
  WIRE_FLAG_IS_GROUNDED,
  decodeWireContact,
  isRemoteJumpVelocity,
  readRemoteJumpArcFlag,
  startRemoteJump,
  stepRemoteJump,
} from "../scene3d/remote_airborne.js";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

function fly(arc, pos, terrainZAt, dt = 1 / 60, maxSteps = 600) {
  let peak = pos.z;
  for (let i = 1; i <= maxSteps; i++) {
    const r = stepRemoteJump(arc, pos, dt, terrainZAt);
    if (pos.z > peak) peak = pos.z;
    if (r === "landed") return { steps: i, t: i * dt, peak };
  }
  return { steps: maxSteps, t: maxSteps * dt, peak, timedOut: true };
}

test("retail constants: gravity -9.8, velocity clamp 50 m/s", () => {
  assert.equal(RETAIL_GRAVITY, -9.8); // PhysicsGlobals::gravity acclient.c:45824
  assert.equal(RETAIL_MAX_VELOCITY, 50.0); // acclient.c:317740-317747
});

test("a remote jump is a parabola under retail gravity that lands on flat terrain", () => {
  const pos = { x: 100, y: 200, z: 10 };
  const arc = startRemoteJump(pos, { vx: 4, vy: 0, vz: 5 }, 0x0021, 0);
  const flat = () => 10;
  const r = fly(arc, pos, flat);
  assert.ok(!r.timedOut, "the arc lands");
  // Analytic: apex = vz^2 / (2|g|) = 1.2755 m, flight = 2 vz / |g| = 1.0204 s.
  assert.ok(Math.abs(r.peak - 10 - 25 / 19.6) < 0.01, `apex ${r.peak - 10}`);
  assert.ok(Math.abs(r.t - 10 / 9.8) < 1 / 60 + 1e-9, `flight ${r.t}`);
  assert.equal(pos.z, 10, "lands exactly on the surface, no sink");
  // Horizontal velocity carries the jumper (no friction off walkable ground).
  assert.ok(Math.abs(pos.x - 100 - 4 * r.t) < 1e-6);
  assert.equal(pos.y, 200);
});

test("per-frame steps match the closed form (retail's quantum size does not matter)", () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  const arcA = startRemoteJump(a, { vx: 1, vy: 2, vz: 6 }, 0, 0);
  const arcB = startRemoteJump(b, { vx: 1, vy: 2, vz: 6 }, 0, 0);
  const sky = () => -1000;
  for (let i = 0; i < 30; i++) stepRemoteJump(arcA, a, 1 / 60, sky);
  stepRemoteJump(arcB, b, 0.25, sky);
  stepRemoteJump(arcB, b, 0.25, sky);
  for (const k of ["x", "y", "z"]) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, k);
  assert.ok(Math.abs(a.z - (6 * 0.5 - 4.9 * 0.25)) < 1e-9);
});

test("lands on the terrain under it, not the take-off height (jump off a slope)", () => {
  const pos = { x: 0, y: 0, z: 20 };
  const arc = startRemoteJump(pos, { vx: 5, vy: 0, vz: 3 }, 0x0010, 0);
  const slope = (x) => 20 - 0.5 * x; // falls away by 0.5 m per metre
  const r = fly(arc, pos, slope);
  assert.ok(!r.timedOut);
  assert.ok(pos.z < 20, "landed below the take-off height");
  assert.ok(Math.abs(pos.z - slope(pos.x)) < 1e-9, "on the surface");
});

test("indoors / unloaded terrain: lands at the take-off height", () => {
  const pos = { x: 0, y: 0, z: 5 };
  const indoor = startRemoteJump(pos, { vx: 0, vy: 0, vz: 4 }, 0x0105, 0);
  assert.equal(indoor.indoor, true);
  // The terrain sampler is never consulted indoors (env cells have no terrain).
  const r = fly(indoor, pos, () => { throw new Error("terrain sampled indoors"); });
  assert.ok(!r.timedOut);
  assert.equal(pos.z, 5);
  const p2 = { x: 0, y: 0, z: 7 };
  const outdoorNoTerrain = startRemoteJump(p2, { vx: 0, vy: 0, vz: 4 }, 0x0001, 0);
  assert.ok(!fly(outdoorNoTerrain, p2, () => null).timedOut);
  assert.equal(p2.z, 7);
});

test("a >2 s gap is not integrated (retail update_object skips it) — put down in place", () => {
  const pos = { x: 3, y: 4, z: 12 };
  const arc = startRemoteJump(pos, { vx: 9, vy: 9, vz: 9 }, 0, 0);
  assert.equal(stepRemoteJump(arc, pos, 2.5, () => 10), "landed");
  assert.deepEqual(pos, { x: 3, y: 4, z: 10 });
});

test("velocity is clamped to 50 m/s before integrating", () => {
  const pos = { x: 0, y: 0, z: 0 };
  const arc = startRemoteJump(pos, { vx: 0, vy: 0, vz: 100 }, 0, 0);
  stepRemoteJump(arc, pos, 0.1, () => -1e9);
  assert.ok(Math.abs(pos.z - (50 * 0.1 - 4.9 * 0.01)) < 1e-9, `z ${pos.z}`);
});

test("jump detection and the wire contact bit", () => {
  assert.equal(REMOTE_JUMP_VZ_MIN, 1.0);
  assert.equal(isRemoteJumpVelocity(4.2), true);
  assert.equal(isRemoteJumpVelocity(0.3), false, "slope walking is not a jump");
  assert.equal(isRemoteJumpVelocity(-6), false, "a fall is not a launch");
  assert.equal(isRemoteJumpVelocity(NaN), false);
  assert.equal(decodeWireContact((WIRE_FLAGS_PRESENT | WIRE_FLAG_IS_GROUNDED) >>> 0), true);
  assert.equal(decodeWireContact((WIRE_FLAGS_PRESENT | 0x01) >>> 0), false, "airborne frame");
  assert.equal(decodeWireContact(0), null, "stale pkg: unknown");
  assert.equal(decodeWireContact(undefined), null);
  assert.equal(readRemoteJumpArcFlag(""), true, "default on");
  assert.equal(readRemoteJumpArcFlag("?remoteJumpArc=off"), false);
  assert.equal(readRemoteJumpArcFlag("?remoteJumpArc=on"), true);
});

test("wasm carries the wire flags + marker on KIND_POSITION (needs a pkg rebuild)", () => {
  const rs = src("../src/session/messages/position.rs");
  const m = rs.match(/const KIND_POSITION_WIRE_FLAGS_PRESENT: u32 = (0x[0-9a-fA-F_]+);/);
  assert.ok(m, "marker constant");
  assert.equal(Number(m[1].replace(/_/g, "")) >>> 0, WIRE_FLAGS_PRESENT >>> 0, "JS/Rust marker agree");
  const arm = rs.slice(rs.indexOf("kind: ENTITY_UPDATE_KIND_POSITION"));
  assert.match(
    arm.slice(0, 4000),
    /weenie_flags: KIND_POSITION_WIRE_FLAGS_PRESENT\s*\|\s*data\.pos\.flags\.bits\(\)/,
  );
});

test("loop.js hands the row's flags + cell to setPose", () => {
  const loop = src("../scene3d/loop.js");
  assert.match(loop, /em\.setPose\(\s*g,\s*wx, wy, wz,[^)]*upd\.weenieFlags, lbId & 0xffff\s*\)/);
});

test("entities.js: setVelocity seeds the arc; tick flies it and skips the ease/glue", () => {
  const e = src("../scene3d/entities.js");
  const sv = e.slice(e.indexOf("  setVelocity(upd) {"));
  assert.match(sv.slice(0, 8000), /isRemoteJumpVelocity\(\+upd\.vz\)[\s\S]*inst\._remoteJump = startRemoteJump\(/);
  assert.match(e, /stepRemoteJump\(arc, inst\.root\.position, dt, _terrainZAt\) === "landed"/);
  assert.match(e, /if \(inst\._stickyTarget && !airborneOwned\)/);
  assert.match(e, /!stickyGlued && !airborneOwned && !wasmDriven/);
});

test("entities.js setPose drops a !contact pose BEFORE touching heading or sticky", () => {
  const e = src("../scene3d/entities.js");
  const body = e.slice(e.indexOf("  setPose(guid, x, y, z, qw, qx, qy, qz, wireFlags, cellIdx) {"));
  assert.ok(body.length > 0 && e.includes("setPose(guid, x, y, z, qw, qx, qy, qz, wireFlags, cellIdx)"));
  const drop = body.indexOf("if (contact === false) {");
  const stickyClear = body.indexOf("if (inst._stickyTarget) inst._stickyTarget = null;");
  const heading = body.indexOf("const easeHeading =");
  assert.ok(drop > 0, "contact gate present");
  assert.ok(drop < stickyClear && drop < heading, "gate runs first");
  assert.match(body.slice(drop, drop + 900), /return;/);
});

test("entities.js applyManagedPose: near rows cannot pin a jumper to the ground", () => {
  const e = src("../scene3d/entities.js");
  const body = e.slice(e.indexOf("  applyManagedPose(guid, x, y, z, qw, qx, qy, qz) {"));
  const gate = body.indexOf("if (inst._remoteJump) {");
  const write = body.indexOf("inst.root.position.set(x, y, z);");
  assert.ok(gate > 0 && gate < write, "jump gate before the position write");
  assert.match(body.slice(gate, write), /<= DEAD_RECKON_TELEPORT_SNAP_SQ\) return;/);
});
