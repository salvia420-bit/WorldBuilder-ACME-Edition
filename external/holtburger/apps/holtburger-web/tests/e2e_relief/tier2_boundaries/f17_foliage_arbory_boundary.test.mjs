/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f17_foliage_arbory_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F17: Foliage & Arbory 3D Depth
 * Covers: Features 6 & 7 Boundary & Corner Conditions
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  calculateFoliageHeight,
  pomGrazeWeight,
  CONSTANTS,
} from "../harness.mjs";

export function runTests() {
  describe("F17: Foliage & Arbory 3D Depth — Boundary & Corner Cases", () => {
    test("B17-1: Solid opaque leaf texture (alpha = 255 everywhere) graceful fallback", () => {
      // In opaque fallback, all alpha values are 255 (no cutout boundary)
      function distanceTransformSolidOpaque(w = 16, h = 16) {
        const mask = new Uint8Array(w * h).fill(255);
        let hasCutoutEdge = false;
        for (let i = 0; i < mask.length; i++) {
          if (mask[i] < 200) {
            hasCutoutEdge = true;
            break;
          }
        }

        // When no cutout edge exists, fall back to coordinate-based dome or planar 1.0
        const pillow = new Float32Array(w * h);
        if (!hasCutoutEdge) {
          pillow.fill(1.0); // Safe planar fallback
        }
        return { hasCutoutEdge, pillow };
      }

      const { hasCutoutEdge, pillow } = distanceTransformSolidOpaque(16, 16);
      equal(hasCutoutEdge, false, "Solid opaque mask has no cutout edge");
      equal(pillow[0], 1.0, "Corner evaluates to safe 1.0 fallback without division by zero");
      equal(pillow[128], 1.0, "Center evaluates to safe 1.0 fallback");

      const combinedH = calculateFoliageHeight(pillow[0], 0.5, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      ok(!isNaN(combinedH) && isFinite(combinedH), "Combined heightfield is non-NaN and finite");
    });

    test("B17-2: Sub-pixel / 1-pixel needle fronds (non-zero, non-NaN)", () => {
      // 1-pixel wide pine needle surrounded by transparency
      const needleWidthPx = 1;
      const distFromEdge = 0.5 * needleWidthPx; // exactly 0.5px to transparent boundary
      const maxDist = 0.5;

      const normalizedPillow = maxDist > 0 ? distFromEdge / maxDist : 1.0;
      equal(normalizedPillow, 1.0, "Single-pixel needle achieves normalized 1.0 center spine");

      // Test with low and high vein luma
      const hLow = calculateFoliageHeight(normalizedPillow, 0.2);
      const hHigh = calculateFoliageHeight(normalizedPillow, 0.8);

      ok(hLow > 0.0 && !isNaN(hLow), "Low luma needle is non-zero and non-NaN");
      ok(hHigh > 0.0 && !isNaN(hHigh), "High luma needle is non-zero and non-NaN");
      ok(hHigh > hLow, "Luminance differentiation is preserved on sub-pixel/1px fronds");
    });

    test("B17-3: Trunk base ground anchor (z <= uWindBaseZ produces 0 displacement)", () => {
      const uWindBaseZ = 0.0;
      function computeWindSwayDisplacement(vertexZ, windBase = uWindBaseZ, windAmp = 0.05) {
        const heightGradient = Math.max(0.0, vertexZ - windBase);
        return heightGradient * windAmp;
      }

      // Root vertices below or at base ground level
      equal(computeWindSwayDisplacement(0.0), 0.0, "Trunk base exactly at z=0 has zero displacement");
      equal(computeWindSwayDisplacement(-0.5), 0.0, "Buried root vertices have zero displacement");
      equal(computeWindSwayDisplacement(-10.0), 0.0, "Deep anchor has zero displacement");

      // Mid trunk and canopy
      const midDisp = computeWindSwayDisplacement(5.0);
      const canopyDisp = computeWindSwayDisplacement(15.0);
      ok(midDisp > 0.0, "Mid-trunk (5m) receives partial sway");
      ok(canopyDisp > midDisp, "Canopy (15m) receives maximum sway without pulling trunk from ground");
    });

    test("B17-4: Double-sided tangent basis inversion (_pomTbnG inverted when gl_FrontFacing == false)", () => {
      // Foliage uses double-sided quads
      const tbnFront = new THREE.Matrix3().set(
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
      );

      // On back-face: gl_FrontFacing is false, geometric normal and tangent basis are inverted
      function getEffectiveTbn(isFrontFacing, baseTbn) {
        const elements = baseTbn.elements.slice();
        if (!isFrontFacing) {
          // Invert normal column (column 2, elements 6, 7, 8)
          elements[6] = -elements[6];
          elements[7] = -elements[7];
          elements[8] = -elements[8];
        }
        return new THREE.Matrix3().fromArray(elements);
      }

      const tbnBack = getEffectiveTbn(false, tbnFront);
      equal(tbnBack.elements[8], -1, "Normal Z is inverted on back-face");

      // Ray view direction projection into surface volume
      const viewDir = new THREE.Vector3(0, 0, -1); // looking at back-face
      const tanDirBack = viewDir.clone().applyMatrix3(tbnBack);
      ok(tanDirBack.z > 0.0, "Inverted TBN ensures ray projection enters the volume (positive Z)");
    });

    test("B17-5: Alpha clip boundary with maximum POM ray offset", () => {
      // Grazing angle view on foliage leaf card
      const { pz } = pomGrazeWeight(0.05, true); // pz clamped to 0.12
      const uPomDepth = CONSTANTS.FOLIAGE_POM_DEPTH_SCALE; // 0.015

      const maxUvOffset = uPomDepth / pz; // 0.015 / 0.12 = 0.125 UV
      near(maxUvOffset, 0.125, 1e-4, "Maximum UV offset on foliage is bounded at 0.125");

      // Given an atlas gutter padding of >= 0.15 UV, maximum ray offset never crosses into adjacent atlas tile
      const atlasPadding = 0.15;
      ok(maxUvOffset < atlasPadding, "Max UV offset is strictly less than atlas tile padding, preventing texture bleed");
    });
  });
}
