// tests/selection_brackets_offscreen.test.mjs — Area 7 (2026-11):
// Off-screen target indicator arrow angle and position verification.
//
// Retail status 2 (acclient.c:289826-289928): off-screen targets display ONE
// indicator triangle on the viewport edge pointing AT the target.
// The CSS triangle is authored pointing UP (0° rotation).
// Pre-fix: atan2(nx, ny) * 180 / PI + 180 inverted all angles, pointing 180°
// backwards (e.g., target UP rotated 180° pointing DOWN away from target).
// Post-fix: atan2(nx, ny) * 180 / PI correctly points toward the target:
//   - Target UP: 0.0° (pointing UP)
//   - Target RIGHT: 90.0° (pointing RIGHT)
//   - Target DOWN: 180.0° (pointing DOWN)
//   - Target LEFT: -90.0° (pointing LEFT)
//   - Target UP-RIGHT: 45.0° (pointing UP-RIGHT)

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
installFakeDom(globalThis);

const { SelectionBracketLayer } = await import("../scene3d/selection_brackets.js");

function createTestLayer(w = 800, h = 600) {
  const domRoot = document.createElement("div");
  document.body.appendChild(domRoot);
  const layer = new SelectionBracketLayer(domRoot, { clientWidth: w, clientHeight: h });
  return { layer, domRoot, w, h };
}

function parseRotateDeg(transform) {
  const match = /rotate\(([-0-9.]+)deg\)/.exec(transform);
  assert.ok(match, `Transform '${transform}' must contain rotate(...)`);
  return parseFloat(match[1]);
}

function parseTranslatePx(transform) {
  const match = /translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/.exec(transform);
  assert.ok(match, `Transform '${transform}' must contain translate3d(...)`);
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
}

test("1. Off-screen indicator rotation angle points TOWARD the target", () => {
  const { layer, w, h } = createTestLayer();

  // 1A: Target UP (ndc.x = 0, ndc.y = 2) -> triangle pointing UP (0.0°)
  layer._showOffScreen({ x: 0, y: 2, z: 0.5 }, w, h);
  let deg = parseRotateDeg(layer._arrow.style.transform);
  assert.equal(deg, 0.0, `Target UP must point 0.0deg, got ${deg}deg (pre-fix was 180.0deg)`);

  // 1B: Target RIGHT (ndc.x = 2, ndc.y = 0) -> triangle pointing RIGHT (90.0°)
  layer._showOffScreen({ x: 2, y: 0, z: 0.5 }, w, h);
  deg = parseRotateDeg(layer._arrow.style.transform);
  assert.equal(deg, 90.0, `Target RIGHT must point 90.0deg, got ${deg}deg (pre-fix was 270.0deg)`);

  // 1C: Target DOWN (ndc.x = 0, ndc.y = -2) -> triangle pointing DOWN (180.0°)
  layer._showOffScreen({ x: 0, y: -2, z: 0.5 }, w, h);
  deg = parseRotateDeg(layer._arrow.style.transform);
  assert.ok(Math.abs(Math.abs(deg) - 180.0) < 1e-3, `Target DOWN must point 180.0deg, got ${deg}deg`);

  // 1D: Target LEFT (ndc.x = -2, ndc.y = 0) -> triangle pointing LEFT (-90.0°)
  layer._showOffScreen({ x: -2, y: 0, z: 0.5 }, w, h);
  deg = parseRotateDeg(layer._arrow.style.transform);
  assert.equal(deg, -90.0, `Target LEFT must point -90.0deg, got ${deg}deg (pre-fix was 90.0deg)`);

  // 1E: Target UP-RIGHT (ndc.x = 2, ndc.y = 2) -> triangle pointing UP-RIGHT (45.0°)
  layer._showOffScreen({ x: 2, y: 2, z: 0.5 }, w, h);
  deg = parseRotateDeg(layer._arrow.style.transform);
  assert.equal(deg, 45.0, `Target UP-RIGHT must point 45.0deg, got ${deg}deg`);

  // 1F: Target DOWN-LEFT (ndc.x = -2, ndc.y = -2) -> triangle pointing DOWN-LEFT (-135.0°)
  layer._showOffScreen({ x: -2, y: -2, z: 0.5 }, w, h);
  deg = parseRotateDeg(layer._arrow.style.transform);
  assert.equal(deg, -135.0, `Target DOWN-LEFT must point -135.0deg, got ${deg}deg`);

  layer.dispose();
});

test("2. Off-screen indicator clamps position to viewport margins", () => {
  const { layer, w, h } = createTestLayer(800, 600);

  // Target directly UP
  layer._showOffScreen({ x: 0, y: 5, z: 0.5 }, w, h);
  let pos = parseTranslatePx(layer._arrow.style.transform);
  assert.equal(pos.x, 400, "X position should be centered horizontally");
  assert.ok(pos.y <= 24, `Y position should be clamped near top margin, got ${pos.y}`);

  // Target directly RIGHT
  layer._showOffScreen({ x: 5, y: 0, z: 0.5 }, w, h);
  pos = parseTranslatePx(layer._arrow.style.transform);
  assert.ok(pos.x >= 776, `X position should be clamped near right margin, got ${pos.x}`);
  assert.equal(pos.y, 300, "Y position should be centered vertically");

  // Arrow is visible and marked status 2
  assert.equal(layer._arrow.style.display, "block");
  assert.equal(layer.lastStatus, 2);

  layer.dispose();
});
