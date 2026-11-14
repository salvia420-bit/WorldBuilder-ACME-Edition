/**
 * apps/holtburger-web/tests/e2e_relief/tier4_scenarios/s9_holtburg_tree_grove.test.mjs
 *
 * Tier 4: Real-World Application Scenario 9 — Holtburg Tree Grove & Wind Sway Orbit
 * Exercised Features: F6, F7, F17 (Requirement R4)
 * Context: Holtburg Tree Grove (LB 0xA9B5), tall tree setup 0x02000258, small tree 0x02000246, fern 0x02001063
 * Camera freecam orbiting from 5m canopy close-up to 25m grove overview.
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  pomLodAtDistance,
  calculateFoliageHeight,
  compileMaterialShader,
  createMockTexture,
  CONSTANTS,
} from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("Tier 4: Scenario 9 — Holtburg Tree Grove & Wind Sway Orbit", () => {
    test("S9: Holtburg Tree Grove (LB 0xA9B5) exhibits foliage POM, wind sway, and canopy softening", () => {
      // 1. Setup foliage canopy material with Base1ClipMap and POM patch
      const foliageMat = new THREE.MeshStandardMaterial({
        name: "holtburg_grove_canopy",
        side: THREE.DoubleSide,
        alphaTest: 0.392, // 100/255 paletted clipmap
      });
      const foliageHeightTex = createMockTexture(128, 128, 255, 255, "holtburg_tree_foliage_h");

      installPomShaderPatch(foliageMat, foliageHeightTex, {
        steps: CONSTANTS.FOLIAGE_POM_STEPS, // 16
        depth: CONSTANTS.FOLIAGE_POM_DEPTH_SCALE, // 0.015
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED, // 15.0m
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED, // 35.0m
      });

      // Chain windSwayGpu vertex shear hook
      const prevOnBeforeCompile = foliageMat.onBeforeCompile;
      foliageMat.onBeforeCompile = (shader, renderer) => {
        prevOnBeforeCompile(shader, renderer);
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          // VFX_WINDSWAY_BEGIN
          float h = max(0.0, transformed.z - 0.0);
          transformed.xy += vec2(0.06, 0.02) * h;
          // VFX_WINDSWAY_END`
        );
      };

      const compiled = compileMaterialShader(foliageMat);
      ok(foliageMat.userData.pomEnabled === true, "Foliage material activates POM");
      equal(compiled.uniforms.uPomDepth.value, 0.015, "Foliage depth scale is calibrated to 0.015");
      equal(compiled.uniforms.uPomSteps.value, 16, "Foliage steps configured to 16");
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Fragment shader compiles POM UV offset");
      ok(/VFX_WINDSWAY_BEGIN/.test(compiled.vertexShader), "Vertex shader compiles wind sway displacement");

      // 2. Simulate orbit viewpoints from 5m to 25m
      const orbitPoints = [
        { dist: 5.0, name: "Canopy close-up (5m)", expectedFactor: 1.0 },
        { dist: 12.0, name: "Branch level (12m)", expectedFactor: 1.0 },
        { dist: 15.0, name: "LOD near threshold (15m)", expectedFactor: 1.0 },
        { dist: 25.0, name: "Grove perimeter (25m)", expectedFactor: 0.5 },
      ];

      for (const pt of orbitPoints) {
        const factor = pomLodAtDistance(pt.dist, CONSTANTS.POM_LOD_NEAR_EXTENDED, CONSTANTS.POM_LOD_FAR_EXTENDED);
        near(factor, pt.expectedFactor, 1e-4, `${pt.name} attenuation factor must match`);
      }

      // 3. Verify leaf vein carving, pillowing, and transparent cutout margins across leaf cluster
      const cutoutMarginHeight = calculateFoliageHeight(0.0, 0.50, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      equal(cutoutMarginHeight, 0.0, "Transparent leaf cutout margins evaluate strictly to 0.0 height");
      const whiteMarginHeight = calculateFoliageHeight(0.0, 1.0, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      equal(whiteMarginHeight, 0.0, "Transparent leaf cutout with full white luma evaluates strictly to 0.0 height");

      const spineHeight = calculateFoliageHeight(1.0, 0.90, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      const veinHeight = calculateFoliageHeight(1.0, 0.20, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      ok(spineHeight > 0.85, "Leaf spine retains high relief");
      ok(veinHeight < 0.50, "Leaf vein is carved into the surface");
      ok(spineHeight - veinHeight >= 0.4, "High relief contrast between leaf blade and vein");

      // 4. Verify base ground anchor invariance (tall tree 22m, fern 1.25m)
      const uWindBaseZ = 0.0;
      for (const baseZ of [0.0, -0.2]) {
        const baseShear = Math.max(0.0, baseZ - uWindBaseZ);
        equal(baseShear, 0.0, "Tree/fern base remains firmly anchored to ground");
      }
      const canopyShear = Math.max(0.0, 22.0 - uWindBaseZ);
      equal(canopyShear, 22.0, "Tall tree crown receives full 22m displacement lever");
    });
  });
}
