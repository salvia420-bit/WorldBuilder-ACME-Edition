// tests/remote_jump_arc.test.mjs — OpenAC comparison 2026-10-04, remote
// motion D7, wave-1 critic issues 1 + 2 (docs/openac-comparison-2026-10-04/
// 4-remote-motion.md).
//
// The remote jump arc moved out of JS into the wasm remote body (retail has
// ONE body per object: CPhysics::UseTime → update_object acclient.c:311375 →
// UpdatePhysicsInternal :317701). The JS-only arc flew while the wasm body
// stayed at the take-off, so the first managed row after landing snapped the
// jumper back; and the arms-up pose never cleared because the airborne edge
// only fired on a |vz| <= 1 VectorUpdate that ACE never sends on landing
// (Player.cs:954 is the only remote VectorUpdate).
//
// The arc physics, landing, no-snap-back and airborne edges are covered by
// Rust unit tests (crates/holtburger-world/src/spatial/tests.rs,
// remote_pose_driver::remote_jump_* / running_jump_lands_without_snapping_back
// / remote_airborne_edges_follow_the_body). This file pins the wasm/JS
// wiring around them, which no Rust test reaches (source assertions; wasm +
// THREE cannot load under node).
//
// Run: node tests/remote_jump_arc.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

test("the remote VectorUpdate feeds the wasm body's arc (DoVectorUpdate → set_velocity)", () => {
  const rs = src("../src/session/messages/position.rs");
  const arm = rs.slice(rs.indexOf("GameMessage::VectorUpdate(data) => {"));
  assert.match(arm.slice(0, 6000), /w\.scene\.remote_jump_arc_active\(\)/);
  assert.match(arm.slice(0, 6000), /w\.scene\.remote_vector_update\(data\.guid, wire, gravity\)/);
  // The legacy |vz| edge only runs when the body does NOT own the arc.
  assert.match(arm.slice(0, 6000), /if !arc_owned && remote_guid != local_guid/);
});

test("airborne set AND clear come from the body's leave/hit-ground edges", () => {
  const mv = src("../src/session/commands/movement.rs");
  const i = mv.indexOf("w.scene.take_remote_airborne_changes()");
  assert.ok(i > 0, "the tick drains the edges");
  assert.match(mv.slice(i, i + 600), /kind: CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED/);
  assert.match(mv.slice(i, i + 600), /u32_payload_2: Some\(u32::from\(airborne\)\)/);
});

test("?remoteJumpArc is a wasm flag, default on, =off escape, set on the scene", () => {
  const lib = src("../src/lib.rs");
  assert.match(lib, /fn parse_remote_jump_arc_flag\(search: &str\) -> bool \{[\s\S]{0,200}kv == "remoteJumpArc=off"/);
  for (const f of ["../src/session/messages/login.rs", "../src/session/commands/lifecycle.rs"]) {
    assert.match(src(f), /new_world\.scene\.set_remote_jump_arc_enabled\(remote_jump_arc_on\)/, f);
  }
});

test("the scene flies the arc in step_remote_position_managers (one body)", () => {
  const scene = src("../../../crates/holtburger-world/src/spatial/scene.rs");
  assert.match(scene, /const REMOTE_ARC_GRAVITY: f32 = -9\.8;/);
  assert.match(scene, /const REMOTE_ARC_MAX_VELOCITY: f32 = 50\.0;/);
  const step = scene.slice(scene.indexOf("pub fn step_remote_position_managers("));
  assert.match(step.slice(0, 16000), /step_remote_arc\(self, &arc, body\.pose, body\.remote_velocity, quantum\)/);
  assert.match(step.slice(0, 16000), /if body\.remote_arc\.is_some\(\) \|\| body\.pose\.is_indoors\(\)/, "no root motion while airborne");
  // Wave 3: retail landing bounce + friction slide constants.
  assert.match(scene, /const REMOTE_FRICTION: f32 = 0\.95;/);
  assert.match(scene, /const REMOTE_ELASTICITY: f32 = 0\.05;/);
});

test("the JS-only arc is gone (it was the second body that snapped back)", () => {
  assert.equal(existsSync(new URL("../scene3d/remote_airborne.js", here)), false);
  const e = src("../scene3d/entities.js");
  assert.doesNotMatch(e, /_remoteJump|remote_airborne\.js|airborneOwned/);
  const loop = src("../scene3d/loop.js");
  assert.doesNotMatch(loop, /upd\.weenieFlags, lbId & 0xffff/);
});
