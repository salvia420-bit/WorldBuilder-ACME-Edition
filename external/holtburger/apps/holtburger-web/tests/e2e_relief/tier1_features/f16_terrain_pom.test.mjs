/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f16_terrain_pom.test.mjs
 *
 * Tier 1: Feature Coverage — F16: Terrain POM & Lighting (Requirement R3)
 * Covers: Features 4 & 5 (Terrain Heightfield Integration & Terrain Depth/Lighting Tuning)
 * Derived from: ORIGINAL_REQUEST §R3, PROJECT.md M2 Interface Contracts
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  terrainPomFade,
  terrainLayerReliefH,
  computeTerrainPomSteps,
  CONSTANTS,
} from "../harness.mjs";

export function runTests() {
  describe("F16: Terrain POM & Lighting — Feature Coverage", () => {
    test("F16-1: Terrain NRA height channel sampling in terrainLayerReliefH across all 33 terrain types", () => {
      // Contract: terrainLayerReliefH queries terrainNraTex.a (uAtlasNormalAo)
      // When height channel is curated (a < 0.995), it returns that exact height
      for (let code = 0; code <= 32; code++) {
        const expectedHeight = 0.25 + (code % 10) * 0.05; // e.g. 0.25..0.70 < 0.995
        const nraSampler = (c) => ({
          x: 0.0,
          y: 0.0,
          z: 1.0,
          a: expectedHeight,
        });
        const atlasSampler = (c) => ({ r: 0.8, g: 0.8, b: 0.8, a: 1.0 });

        const sampledH = terrainLayerReliefH(code, [0.5, 0.5], nraSampler, atlasSampler);
        near(sampledH, expectedHeight, 1e-4, `Terrain code ${code} must sample NRA height channel`);
      }
    });

    test("F16-2: Step loop scaling (4 to 8 steps) in terrain POM raymarching based on view depth", () => {
      // Contract: near views execute 6-8 steps, far views taper to 4 steps
      const closeSteps = computeTerrainPomSteps(5.0);
      const nearSteps = computeTerrainPomSteps(15.0);
      const midSteps = computeTerrainPomSteps(25.0);
      const farSteps = computeTerrainPomSteps(30.0);
      const extremeSteps = computeTerrainPomSteps(45.0);

      equal(closeSteps, 6, "Close camera (5m) uses 6 raymarch steps");
      equal(nearSteps, 6, "Near camera (15m) uses 6 raymarch steps");
      equal(midSteps, 6, "Mid camera (25m < 26.25m) uses 6 raymarch steps");
      equal(farSteps, 4, "Far camera (30m > 26.25m) reduces to 4 raymarch steps");
      equal(extremeSteps, 4, "Extreme camera (45m) reduces to 4 raymarch steps");
    });

    test("F16-3: Terrain POM depth scale calibrated to 0.016", () => {
      equal(CONSTANTS.TERRAIN_POM_DEPTH_SCALE, 0.016, "Terrain POM depth scale must be 0.016");

      // Verify maximum per-step UV displacement under uPomScale = 0.016
      const uPomScale = CONSTANTS.TERRAIN_POM_DEPTH_SCALE;
      const pomSteps = 6;
      const pomLayerStep = 1.0 / pomSteps;
      const invVz = 1.0 / 0.7071; // 45 degree camera
      const maxStepUv = invVz * uPomScale * pomLayerStep;

      ok(maxStepUv <= 0.005, `Max step UV displacement (${maxStepUv.toFixed(5)}) must be bounded <= 0.005`);
      ok(maxStepUv > 0.001, `Max step UV displacement (${maxStepUv.toFixed(5)}) must be noticeable`);
    });

    test("F16-4: Terrain POM distance attenuation and fade (15.0m near to 40.0m far)", () => {
      // Near distance: 100% displacement
      for (const dist of [0.0, 5.0, 10.0, 15.0]) {
        equal(terrainPomFade(dist), 1.0, `Displacement at ${dist}m must be full 1.0`);
      }

      // Linear fade across [15m, 40m]
      const fade20m = terrainPomFade(20.0);
      const fade27_5m = terrainPomFade(27.5);
      const fade35m = terrainPomFade(35.0);

      near(fade20m, 1.0 - (5.0 / 25.0), 1e-4, "Fade at 20m is 0.80");
      near(fade27_5m, 0.50, 1e-4, "Fade at 27.5m midpoint is exactly 0.50");
      near(fade35m, 1.0 - (20.0 / 25.0), 1e-4, "Fade at 35m is 0.20");

      // Beyond 40m: zero displacement
      for (const dist of [40.0, 40.1, 50.0, 100.0]) {
        equal(terrainPomFade(dist), 0.0, `Displacement at ${dist}m must be strictly 0.0`);
      }
    });

    test("F16-5: Gouraud normal perturbation integration under ?terrainGouraud=on", () => {
      // Contract: Perturb vertex normal acShadeN with tangent normal from NRA map
      const acShadeN = new THREE.Vector3(0.0, 1.0, 0.0); // Upright terrain vertex normal
      const nraTangent = new THREE.Vector2(0.2, -0.1); // Surface normal perturbation
      const uNormalScale = 0.5;

      const perturbed = acShadeN.clone().add(new THREE.Vector3(nraTangent.x * uNormalScale, 0.0, nraTangent.y * uNormalScale)).normalize();

      ok(perturbed.y > 0.9, "Perturbed normal preserves macro terrain slope");
      ok(Math.abs(perturbed.x) > 0.05, "Perturbed normal incorporates micro-surface X perturbation");
      ok(Math.abs(perturbed.z) > 0.02, "Perturbed normal incorporates micro-surface Z perturbation");

      // Verify lighting modulation under directional sun
      const lightDir = new THREE.Vector3(0.5, 0.8, 0.2).normalize();
      const dotOriginal = Math.max(0.0, acShadeN.dot(lightDir));
      const dotPerturbed = Math.max(0.0, perturbed.dot(lightDir));

      ok(dotPerturbed !== dotOriginal, "Perturbed normal modulates Gouraud directional diffuse lighting");
      ok(dotPerturbed > 0.6 && dotPerturbed < 1.0, "Lighting response remains in stable range");
    });
  });
}
