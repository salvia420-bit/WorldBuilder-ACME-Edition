// tests/vendor_range_cylinder.test.mjs — bug 3 (2026-10-07): the vendor window
// closes where retail and OpenAC close it.
//
// Retail: gmVendorUI::OpenVendor (acclient.c:246660) → ObjectsInRange
// (:436730) → CPhysicsObj::get_distance_to_object(use_cyls=1) →
// Position::cylinder_distance (:467221) against the vendor's own wire
// _useRadius (0 when absent, :470951). OpenAC: RuntimeVendorRangeQuery.cs.
// Human Setup 0x02000001 dims (CPartArray radius/height): 0.6788225 / 1.835
// (crates/holtburger-world/src/handlers/movement.rs test fixture).
//
// Run from apps/holtburger-web/:
//   node tests/vendor_range_cylinder.test.mjs

import assert from "node:assert/strict";
import {
  vendorCylinderDistance,
  vendorRangeVerdict,
  VENDOR_FALLBACK_RANGE_M,
} from "../plugins/vendor_range.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
const R = 0.6788225, H = 1.835;
const human = (useRadius) => ({
  useRadius, vendorRadius: R, vendorHeight: H, playerRadius: R, playerHeight: H,
});
const at = (x, y = 0, z = 0) => ({ x, y, z });

check("flat ground: range edge is useRadius + both radii, centre to centre", () => {
  const edge = 3.0 + 2 * R; // 4.357645
  assert.equal(vendorRangeVerdict(human(3.0), at(0), at(edge - 0.01)).inRange, true);
  assert.equal(vendorRangeVerdict(human(3.0), at(0), at(edge + 0.01)).inRange, false);
  const d = vendorCylinderDistance(R, H, at(edge), R, H, at(0));
  assert.ok(Math.abs(d - 3.0) < 1e-9, `distance at the edge = ${d}`);
});

check("the old planar 3.96 m cut-off is gone (4.2 m apart is still in range)", () => {
  const v = vendorRangeVerdict(human(3.0), at(0), at(4.2));
  assert.equal(v.mode, "cylinder");
  assert.equal(v.inRange, true);
});

check("a vendor with a 5 m use radius keeps the window open further out", () => {
  assert.equal(vendorRangeVerdict(human(5.0), at(0), at(6.3)).inRange, true);
  assert.equal(vendorRangeVerdict(human(5.0), at(0), at(6.4)).inRange, false);
});

check("absent use radius is 0 m: open only while the cylinders touch", () => {
  assert.equal(vendorRangeVerdict(human(0), at(0), at(2 * R - 0.01)).inRange, true);
  assert.equal(vendorRangeVerdict(human(0), at(0), at(2 * R + 0.01)).inRange, false);
});

check("vertical gap counts (player on a ledge 4 m above the vendor)", () => {
  // player p1 at z=4, vendor p2 at z=0: vgap = 4 - (0 + 1.835) = 2.165
  const p = at(2, 0, 4), v = at(0, 0, 0);
  const radial = Math.hypot(2, 4) - 2 * R;
  const expect = Math.hypot(4 - H, radial);
  const d = vendorCylinderDistance(R, H, p, R, H, v);
  assert.ok(Math.abs(d - expect) < 1e-9, `${d} vs ${expect}`);
});

check("retail branch: stacked bodies (radial <= 0, vgap > 0) measure the vertical gap", () => {
  const d = vendorCylinderDistance(R, H, at(0, 0, 0), R, H, at(0, 0, 1.0 + H));
  // radial = (1.0 + H) - 2R; vgap = (1.0 + H) - (0 + H) = 1.0
  const radial = 1.0 + H - 2 * R;
  assert.ok(radial > 0); // sanity: here radial is positive → sqrt branch
  assert.ok(Math.abs(d - Math.hypot(1.0, radial)) < 1e-9);
  const d2 = vendorCylinderDistance(5, H, at(0, 0, 0), 5, H, at(0, 0, H + 0.5));
  assert.ok(Math.abs(d2 - 0.5) < 1e-9, `vgap branch ${d2}`);
});

check("overlapping in both axes is negative", () => {
  assert.ok(vendorCylinderDistance(R, H, at(0), R, H, at(0.5)) < 0);
});

check("stale pkg/ (no useRadius) falls back to the old fixed planar range", () => {
  const v = vendorRangeVerdict({ useRadius: null }, at(0), at(VENDOR_FALLBACK_RANGE_M + 0.1));
  assert.equal(v.mode, "fallback");
  assert.equal(v.inRange, false);
  assert.equal(vendorRangeVerdict({}, at(0), at(3.9)).inRange, true);
});

console.log(`\nvendor_range_cylinder: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
