// tests/remote_root_scale.test.mjs — motion-remote-1 (WebAC comparison,
// 2026-10-13): remote root motion travels at the object's scale.
//
// Retail `CPhysicsObj::UpdatePositionInternal` multiplies the part array's
// offset ORIGIN by `m_scale` on walkable ground (acclient.c:320014-320020;
// ACE `PhysicsObj.UpdatePositionInternal` `offsetFrame.Origin *= Scale`, and
// ACE's monster speed is `runSpeed × RunRate × ObjScale`). The spine moved
// every remote at its unscaled table speed, so a scale-2 creature fell 50%
// short between UpdatePositions and rubber-banded. The leave-ground velocity
// (`get_leave_ground_velocity` :343806 → `get_state_velocity`) has no scale.
//
// The motion itself is covered by Rust unit tests
// (crates/holtburger-world/src/spatial/remote_spine_tests.rs
// `spine_root_motion_scales_origin_by_obj_scale` and neighbours,
// state/remote_movement.rs `step_remote_objects_moves_a_scaled_object_at_its_scale`,
// motion/root_motion.rs `scaled_multiplies_the_origin_only`). This file pins
// the wiring around them (source assertions; wasm cannot load under node).
//
// Run: node tests/remote_root_scale.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");
const WORLD = "../../../crates/holtburger-world/src/";

test("?remoteRootScale is a default-on wasm flag with off/0/false escapes, set on the scene", () => {
  const lib = src("../src/lib.rs");
  const parse = lib.slice(lib.indexOf("fn parse_remote_root_scale_flag(search: &str) -> bool {"));
  assert.ok(parse.length > 0 && lib.includes("fn parse_remote_root_scale_flag("), "parser exists");
  const body = parse.slice(0, 400);
  for (const kv of ["remoteRootScale=off", "remoteRootScale=0", "remoteRootScale=false"]) {
    assert.ok(body.includes(`"${kv}"`), kv);
  }
  assert.match(body, /!trimmed\.split\('&'\)\.any/, "absent = ON");
  assert.match(lib, /let remote_root_scale_on: bool = parse_remote_root_scale_flag\(&flag_search\(\)\);/);
  const flags = lib.slice(lib.indexOf("flags: session::LoopFlags {"));
  assert.match(flags.slice(0, 3000), /\bremote_root_scale_on,/, "rides LoopFlags");
  assert.match(src("../src/session/mod.rs"), /pub\(crate\) remote_root_scale_on: bool,/);
  for (const f of ["../src/session/messages/login.rs", "../src/session/commands/lifecycle.rs"]) {
    const s = src(f);
    assert.match(s, /\bremote_root_scale_on,/, `${f} destructures the flag`);
    assert.match(s, /new_world\.scene\.set_remote_root_scale_enabled\(remote_root_scale_on\)/, f);
  }
});

test("the scene defaults the scale ON and gates it in remote_root_motions_scaled", () => {
  const scene = src(WORLD + "spatial/scene.rs");
  assert.match(scene, /remote_root_scale_enabled: true,/, "struct default ON (tests + native)");
  const fn = scene.slice(scene.indexOf("pub(crate) fn remote_root_motions_scaled("));
  assert.match(fn.slice(0, 1500), /if self\.remote_root_scale_enabled \{\s*motion = motion\.scaled\(scale_of\(\*guid\)\);/);
  // The unscaled entry point stays (scale 1.0 = byte-identical).
  assert.match(scene, /self\.remote_root_motions_scaled\(kinematics, \|_\| 1\.0\)/);
});

test("the world reads each object's ObjScale every slice, sanitised like entity_part_dims", () => {
  const rm = src(WORLD + "state/remote_movement.rs");
  const step = rm.slice(rm.indexOf("pub fn step_remote_objects("));
  const body = step.slice(0, 2500);
  assert.match(body, /self\.scene\.remote_root_motions_scaled\(Some\(&kinematics\), \|guid\| \{/);
  assert.match(body, /\.and_then\(\|e\| e\.obj_scale\(\)\)/);
  assert.match(body, /\.filter\(\|s\| s\.is_finite\(\) && \*s > 0\.0\)/);
  assert.match(body, /\.unwrap_or\(1\.0\)/);
  assert.doesNotMatch(body, /self\.scene\.remote_root_motions\(Some/, "no unscaled call left in the live step");
});

test("only the origin is scaled; the leave-ground velocity stays unscaled", () => {
  const rm = src(WORLD + "motion/root_motion.rs");
  const scaled = rm.slice(rm.indexOf("pub fn scaled(self, scale: f32) -> RootMotion {"));
  assert.match(scaled.slice(0, 400), /if scale == 1\.0 \|\| !scale\.is_finite\(\) \|\| scale <= 0\.0 \{\s*return self;/);
  assert.match(scaled.slice(0, 400), /velocity: self\.unscaled_velocity \* scale,\s*\.\.self/, "omega untouched");
  assert.match(rm, /unscaled_velocity: velocity,/, "root_motion seeds the unscaled copy");

  const scene = src(WORLD + "spatial/scene.rs");
  assert.match(scene, /let leave_walk_v = spine_v\.map_or\(walk_v, \|\(_, unscaled\)\| unscaled\);/);
  assert.match(scene, /Vector3::new\(leave_walk_v\.x, leave_walk_v\.y, 0\.0\)/);
  const rt = src(WORLD + "spatial/remote_transition.rs");
  assert.match(rt, /pub leave_walk_v: Vector3,/);
  assert.match(rt, /Vector3::new\(plan\.leave_walk_v\.x, plan\.leave_walk_v\.y, 0\.0\)/);
});
