// tests/remote_leash.test.mjs — motion-remote-3 (WebAC comparison, 2026-10-13): the remote
// ConstraintManager leash applies to the object's OWN motion and re-arms after every accepted
// correction.
//
// Retail `PositionManager::adjust_offset` runs interpolation, sticky, then
// `ConstraintManager::adjust_offset` on every frame's offset, root motion included
// (acclient.c:388287-388304, from `UpdatePositionInternal` :320027-320030), and
// `HandleReceivedPosition` re-arms `ConstrainTo(object->m_position)` after every `MoveOrTeleport`
// that returns 1 — teleport, far snap and interpolate arms, the <=0.05 m stop included
// (:145223-145227, :323451-323498). A remote whose positions stop therefore runs 10 m (5 m indoors),
// then slows to a halt by 50 m (20 m). Holtburger leashed interpolation only and re-armed only when
// a node queued, so a link-dead or out-of-range runner ran until its DeleteObject.
//
// The behaviour is covered by Rust unit tests
// (crates/holtburger-world/src/spatial/remote_leash_tests.rs: halts a runner whose updates stop,
// re-arms on a new position, far snap / hard set / !contact, body-cell distances, slide unleashed,
// `=off` byte-identical). This file pins the wiring around them (source assertions; wasm cannot
// load under node).
//
// Run: node tests/remote_leash.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");
const WORLD = "../../../crates/holtburger-world/src/";

const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.ok(a >= 0, `anchor not found: ${from}`);
  const b = text.indexOf(to, a + from.length);
  assert.ok(b > a, `end anchor not found: ${to}`);
  return text.slice(a, b);
};
const count = (text, needle) => text.split(needle).length - 1;

test("?remoteLeash is a default-on wasm flag with off/0/false escapes, installed on the world", () => {
  const lib = src("../src/lib.rs");
  const body = between(lib, "fn parse_remote_leash_flag(search: &str) -> bool {", "\n}\n");
  for (const kv of ["remoteLeash=off", "remoteLeash=0", "remoteLeash=false"]) {
    assert.ok(body.includes(`"${kv}"`), kv);
  }
  assert.match(body, /!trimmed\.split\('&'\)\.any/, "absent = ON");
  assert.match(
    lib,
    /holtburger_world::spatial::set_remote_leash\(parse_remote_leash_flag\(&flag_search\(\)\)\);/,
    "the boot path sets the switch",
  );
  const spatial = src(WORLD + "spatial.rs");
  assert.match(spatial, /pub use scene::\{remote_leash_enabled, set_remote_leash\};/);
  assert.match(spatial, /mod remote_leash_tests;/, "the Rust tests are registered");
  const scene = src(WORLD + "spatial/scene.rs");
  assert.match(
    scene,
    /static REMOTE_LEASH: std::cell::Cell<bool> = const \{ std::cell::Cell::new\(true\) \};/,
    "the switch defaults ON (tests + native)",
  );
});

test("every accepted MoveOrTeleport arm re-arms on the body's own cell; !contact does not", () => {
  const scene = src(WORLD + "spatial/scene.rs");
  const rearm = between(scene, "fn rearm_remote_leash(body: &mut SpatialBody) {", "\n}\n");
  assert.match(rearm, /if body\.pose\.is_indoors\(\)/, "the object's own cell, after the arm");
  assert.match(rearm, /set_hold_leash\(true\)/, "held across interp completion");
  assert.match(rearm, /remote_constrain_to\(0\.0, start, max\)/, "seeded at zero");

  const lattice = between(
    scene,
    "let leash = remote_leash_enabled();",
    "} else if body.position_manager.queue_active() {",
  );
  assert.equal(count(lattice, "rearm_remote_leash(&mut body);"), 3, "hard set, far snap, interpolate");
  const noContact = between(lattice, "} else if ctx.contact == Some(false) {", "} else {");
  assert.ok(!noContact.includes("rearm_remote_leash"), "!contact returns 0: no re-arm");
  assert.match(lattice, /\} else if queued \{/, "=off keeps the queued-only arm");
  assert.match(
    lattice,
    /let indoor = if leash \{\s*body\.pose\.is_indoors\(\)\s*\} else \{\s*pose\.is_indoors\(\)\s*\};/,
    "the blip reads the body's cell too; =off keeps the target's",
  );
});

test("the leash scales the walk only, in both the swept plan and the floor-sampled move", () => {
  const scene = src(WORLD + "spatial/scene.rs");
  assert.equal(
    count(scene, "let leash = if leash_on { remote_leash_scale(body) } else { 1.0 };"),
    2,
    "plan_remote_moves + ground_moves",
  );
  assert.equal(
    count(scene, "Vector3::new(walk_v.x * quantum * leash, walk_v.y * quantum * leash, 0.0);"),
    2,
  );
  assert.equal(count(scene, "walk_offset.x + slide_offset.x,"), 2, "the slide is added unscaled");
  assert.ok(!/slide_offset\.[xy] \* leash/.test(scene), "the slide is never leashed");
  assert.match(
    scene,
    /if leash_on \{\s*body\.position_manager\.constraint\.accumulate\(walk_offset\);/,
    "the per-body step accumulates the applied walk, flag-gated",
  );
  const rt = src(WORLD + "spatial/remote_transition.rs");
  assert.equal(count(rt, "pub walk_offset: Vector3,"), 2, "plan + resolved carry the offset");
  assert.match(rt, /walk_offset: plan\.walk_offset,/);
});

test("the remote hold keeps the leash armed past interp completion; preview matches adjust_offset", () => {
  const pm = src(WORLD + "spatial/position_manager.rs");
  assert.match(pm, /if !self\.retail_leash\s*&& !self\.hold_leash\s*&& matches!\(step, InterpStep::Completed/);
  assert.match(pm, /hold_leash: false,/, "default: the shipped auto-release");
  const preview = between(pm, "pub fn preview_scale(&self, on_contact: bool) -> f32 {", "\n    }\n");
  assert.match(preview, /if !self\.constrained \|\| !on_contact \{\s*return 1\.0;/);
  assert.match(preview, /return \(self\.constraint_max - self\.constraint_pos_offset\) \/ span;/);
  const accumulate = between(pm, "pub fn accumulate(&mut self, applied: Vector3) {", "\n    }\n");
  assert.match(accumulate, /if self\.constrained \{\s*self\.constraint_pos_offset \+= applied\.length\(\);/);
});
