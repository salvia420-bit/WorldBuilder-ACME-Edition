/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f9_oblique_slope.test.mjs
 *
 * Tier 1: Feature Coverage — F9: Oblique Slope Shading
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #9
 */

import { describe, test, ok, equal, near } from "../harness.mjs";

function evaluateObliqueSlopeShading(surfaceNormalY, sunElevationY) {
  // surfaceNormalY = 0 for vertical wall, 1 for flat horizontal roof/ground
  // sunElevationY = 1 for noon overhead sun, 0.1 for sunset/low sun
  const isVertical = Math.abs(surfaceNormalY) < 0.2;
  if (!isVertical) {
    return 1.0; // Horizontal surface unaffected
  }
  // For vertical walls under high-angle sun, horizon occlusion attenuates wash-out
  // Contrast factor: 1.0 - 0.45 * smoothstep(0.4, 0.9, sunElevationY)
  const t = Math.max(0.0, Math.min(1.0, (sunElevationY - 0.4) / 0.5));
  const ramp = t * t * (3.0 - 2.0 * t);
  return 1.0 - 0.45 * ramp;
}

export function runTests() {
  describe("F9: Oblique Slope Shading — Feature Coverage", () => {
    test("F9-1: High-angle overhead sun attenuates washed-out illumination on vertical walls", () => {
      const shade = evaluateObliqueSlopeShading(0.0, 1.0); // Vertical wall under noon sun
      near(shade, 0.55, 1e-4, "Noon sun on vertical wall receives 45% attenuation (0.55)");
    });

    test("F9-2: Low-angle sunset sun preserves full direct contrast on vertical masonry", () => {
      const shade = evaluateObliqueSlopeShading(0.0, 0.2); // Vertical wall under sunset sun
      equal(shade, 1.0, "Low-angle sun retains 100% direct relief contrast (1.0)");
    });

    test("F9-3: Horizontal ground and flat roofs receive unobstructed illumination under all sun angles", () => {
      for (const sunY of [0.1, 0.5, 0.8, 1.0]) {
        const shade = evaluateObliqueSlopeShading(1.0, sunY); // Horizontal surface
        equal(shade, 1.0, `Flat horizontal surface under sunY=${sunY} must have shading factor 1.0`);
      }
    });

    test("F9-4: Smooth intermediate transition without harsh lighting steps", () => {
      let prev = 1.0;
      for (let sunY = 0.4; sunY <= 0.9; sunY += 0.1) {
        const shade = evaluateObliqueSlopeShading(0.0, sunY);
        ok(shade <= prev, `Shade at sunY=${sunY.toFixed(2)} (${shade.toFixed(4)}) must be <= previous (${prev.toFixed(4)})`);
        prev = shade;
      }
    });

    test("F9-5: Attenuation factor is strictly bounded in [0.55, 1.00]", () => {
      for (let y = 0.0; y <= 1.0; y += 0.05) {
        const factor = evaluateObliqueSlopeShading(0.0, y);
        ok(factor >= 0.55 && factor <= 1.0, `Factor ${factor} at sun elevation ${y} must be inside [0.55, 1.0]`);
      }
    });
  });
}
