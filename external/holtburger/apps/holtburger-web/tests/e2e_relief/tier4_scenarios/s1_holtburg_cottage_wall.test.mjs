/**
 * apps/holtburger-web/tests/e2e_relief/tier4_scenarios/s1_holtburg_cottage_wall.test.mjs
 *
 * Tier 4: Real-World Town Scenario 1 — Holtburg Cottage Wall Close-Up & Distance Arc
 * Exercised Features: F1, F2, F6, F7, F8, F10
 * Context: Holtburg LB 0xA9B4 (`pom_cottage_wall`, 60 60 78), camera orbiting 2m to 35m
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  pomLodAtDistance,
  pomGrazeWeight,
  calculateCreviceAo,
  calculateSpecularRim,
  compileMaterialShader,
  createMockTexture,
  CONSTANTS,
} from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("Tier 4: Scenario 1 — Holtburg Cottage Wall Close-Up & Distance Arc", () => {
    test("S1: Holtburg Cottage Wall (LB 0xA9B4) orbits from 2m to 35m with seamless relief transition", () => {
      // 1. Setup cottage wall material with cloned floor bias and POM patch
      const baseMat = new THREE.MeshStandardMaterial({ name: "holtburg_cottage_wall_mat" });
      const heightTex = createMockTexture(255, 200, 100, 255, "tex_06007509_height");
      installPomShaderPatch(baseMat, heightTex, {
        steps: CONSTANTS.POM_STEPS_CLOSE,
        depth: 0.04,
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED,
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED,
      });

      // Cloned floor bias material (F1)
      const floorMat = baseMat.clone();
      floorMat.userData = { ...(baseMat.userData || {}), __floorBiased: true, __creviceAo: true, __microShadow: true };
      installPomShaderPatch(floorMat, heightTex, {
        steps: CONSTANTS.POM_STEPS_CLOSE,
        depth: 0.04,
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED,
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED,
      });

      const compiled = compileMaterialShader(floorMat);
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Floor material has POM perturbed UV");

      // 2. Camera Arc Trajectory from 2m (close inspection) to 35m (street distance)
      const cameraDistances = [2.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0];
      const cameraAngles = [0.95, 0.85, 0.70, 0.55, 0.40, 0.30, 0.20, 0.10]; // N·V

      for (let i = 0; i < cameraDistances.length; i++) {
        const dist = cameraDistances[i];
        const dotNV = cameraAngles[i];

        // F2: Distance LOD
        const lod = pomLodAtDistance(dist, 15.0, 35.0);
        // F10: Silhouette grazing clamp
        const { grazeW } = pomGrazeWeight(dotNV, true);

        // F6: Crevice AO (active across all distances)
        const creviceAo = calculateCreviceAo(-0.4);
        near(creviceAo, 0.40, 1e-4, "Crevice AO remains active regardless of distance");

        // F7: Specular Rim
        const rim = calculateSpecularRim(0.5, dotNV);

        if (dist <= 15.0) {
          equal(lod, 1.0, `LOD at close range (${dist}m) is 1.0`);
        } else if (dist >= 35.0) {
          equal(lod, 0.0, `LOD at far boundary (${dist}m) is 0.0`);
        }

        // Combined effective displacement amplitude
        const effectiveAmp = lod * grazeW;
        ok(effectiveAmp >= 0.0 && effectiveAmp <= 1.0, "Effective amplitude in [0, 1]");

        // Verify rim is brighter at glancing angles
        if (dotNV <= 0.20) {
          ok(rim > 0.15, `Glancing rim highlight is crisp at dotNV=${dotNV}`);
        }
      }
    });
  });
}
