// tests/remote_sticky_radius.test.mjs — OpenAC comparison 2026-10-04, remote
// motion D6 (docs/openac-comparison-2026-10-04/4-remote-motion.md).
//
// Retail `StickyManager::adjust_offset` (acclient.c:388519-388601) moves a
// sticky holder until
//     cylinder_distance_no_z(GetRadius(self), self, target_radius, target) - 0.3
// is zero (:388557-388559), with `target_radius` stored by `StickTo`
// (:388665, :388681). The remote lane used 0.0 for BOTH radii, gluing a mob
// 0.3 m from its target's centre. The Rust fix landed in 86c3ef14; this is
// the JS-side regression pin for the cross-crate plumbing (the wasm session
// arm → SpatialScene → PositionManager) and the hand-over to JS, which no
// Rust unit test covers end to end. Source assertions only (wasm + THREE).
//
// Run: node tests/remote_sticky_radius.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

test("wasm install passes the holder's AND the target's radius", () => {
  const rs = src("../src/session/messages/position.rs");
  const i = rs.indexOf("w.scene.stick_remote_entity_to(");
  assert.ok(i > 0, "remote sticky install present");
  const pre = rs.slice(Math.max(0, i - 900), i);
  assert.match(pre, /let holder_radius = w\.combat_part_dims\(data\.guid\)\.0;/);
  assert.match(pre, /let target_radius = w\.combat_sticky_radius\(target\);/);
  assert.match(
    rs.slice(i, i + 300),
    /stick_remote_entity_to\(\s*data\.guid,\s*target,\s*holder_radius,\s*target_radius,\s*\)/,
  );
});

test("SpatialScene keeps both radii and feeds them to the retail sticky step", () => {
  const scene = src("../../../crates/holtburger-world/src/spatial/scene.rs");
  assert.match(scene, /remote_sticky_targets: HashMap<Guid, \(Guid, f32, f32\)>/);
  assert.match(scene, /body\.position_manager\.stick_to\(target, target_radius\)/);
  assert.match(scene, /step_sticky_pose\(\s*body\.pose, my_radius,/);
  assert.doesNotMatch(scene, /stick_to\(target, 0\.0\)/, "no radius-blind install left");
  assert.doesNotMatch(scene, /my_radius \(OPEN Q3 fallback\) \*\/ 0\.0/);
});

test("the retail standoff: centre distance r_holder + r_target + 0.3", () => {
  // StickyManager::adjust_offset closes `cylinder_distance_no_z - 0.3` to 0;
  // cylinder distance is centre distance minus both radii.
  const standoff = (rHolder, rTarget) => rHolder + rTarget + 0.3;
  assert.equal(standoff(0, 0), 0.3, "the radius-blind bug: 0.3 m from centre");
  assert.ok(Math.abs(standoff(0.9, 0.48) - 1.68) < 1e-9);
});

test("a sticky row hands ownership from the JS glue to the wasm lane", () => {
  const loop = src("../scene3d/loop.js");
  const d = loop.slice(loop.indexOf("function drainRemotePoses("));
  assert.match(d.slice(0, 5000), /if \(stickyFlags && stickyFlags\[i\]\) \{[\s\S]*?em\.setStickyTarget\(g, 0\);[\s\S]*?em\.applyManagedPose\(/);
});
