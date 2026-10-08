// tests/remote_moveto_sticky_arrival.test.mjs — R3 moveto-1 (2026-10-08).
//
// Retail `MovementManager::unpack_movement` (acclient.c:339492) runs
// cancel_moveto + unstick_from_object for every movement message and sticks
// only from the case-0 (interpreted) `sticky_object`. A MoveToObject (case 6)
// only arms the MoveTo; its Sticky bit (0x80 — ACE sets it on every monster
// chase) sticks ON ARRIVAL (MoveToManager::BeginNextNode :345521 →
// PositionManager::StickTo), which the client remote MoveTo pump
// (`drive_remote_movetos`) already does. The wasm UpdateMotion arm used to
// stick every chase at ARM time: the D5 chase walk was zeroed and the mob was
// dragged toward its target at the sticky pull speed.
//
// The decision itself is a pure Rust helper with unit tests
// (holtburger-world handlers/movement.rs `remote_motion_sticky_target`); this
// pins the wasm wiring around it, which no Rust test reaches (the session
// module is wasm32-only). Source assertions only.
//
// Run: node tests/remote_moveto_sticky_arrival.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

test("the pure helper sticks case 0 only and defers a MoveToObject to arrival", () => {
  const mv = src("../../../crates/holtburger-world/src/handlers/movement.rs");
  const i = mv.indexOf("pub fn remote_motion_sticky_target(");
  assert.ok(i > 0, "helper present");
  const body = mv.slice(i, i + 700);
  assert.match(body, /MovementTypeData::Invalid\(inv\) => inv\.sticky_object\.map\(u32::from\)\.unwrap_or\(0\)/);
  assert.match(body, /MovementTypeData::MoveToObject\(m\)\s*if !rust_moveto_sticks && m\.params\.movement_parameters & STICKY != 0/);
});

test("the wasm arm gates on the remote MoveTo pump and uses the gated value twice", () => {
  const rs = src("../src/session/messages/position.rs");
  assert.match(
    rs,
    /let rust_moveto_sticks = remote_sticky_on\s*&& world\s*\.borrow\(\)\s*\.as_ref\(\)\s*\.is_some_and\(\|w\| w\.scene\.remote_moveto_active\(\)\);/,
  );
  assert.match(
    rs,
    /let remote_sticky_target: u32 =\s*holtburger_world::handlers::movement::remote_motion_sticky_target\(\s*&data\.data,\s*rust_moveto_sticks,\s*\);/,
  );
  // The REMOTE install reads the gated value…
  const i = rs.indexOf("w.scene.stick_remote_entity_to(");
  assert.ok(i > 0, "remote sticky install present");
  const pre = rs.slice(Math.max(0, i - 900), i);
  assert.match(pre, /if remote_sticky_target != 0 \{/);
  assert.match(pre, /let target = holtburger_common::Guid\(remote_sticky_target\);/);
  // …and so does the KIND_MOTION ride-along to the JS F3-4 glue.
  assert.match(rs, /model_id: remote_sticky_target,/);
  assert.doesNotMatch(rs, /model_id: sticky_target,/, "no arm-time chase stick reaches JS");
});

test("the remote pump still sticks on a sticky-bit arrival", () => {
  const sys = src("../../../crates/holtburger-core/src/client/movement/system.rs");
  const i = sys.indexOf("pub(crate) fn drive_remote_movetos(");
  assert.ok(i > 0, "pump present");
  assert.match(
    sys.slice(i, i + 9000),
    /if let Some\(\(target, radius, _height\)\) = out\.stick_to \{[\s\S]*?\.stick_remote_entity_to\(guid, target, self_radius, target_radius\);/,
  );
});
