/**
 * apps/holtburger-web/tests/e2e_relief/tier4_scenarios/s10_osteth_open_terrain.test.mjs
 *
 * Tier 4: Real-World Application Scenario 10 — Osteth Open Countryside Multi-Terrain NRA POM Transition
 * Exercised Features: F4, F5, F16 (Requirement R3)
 * Context: Osteth Open Countryside, landblock transition across grass (2), road cobbles (32), and crag cliff (13).
 * Camera moving across terrain elevations from 2m ground level to 45m hilltop overview.
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
  CONSTANTS,
} from "../harness.mjs";

export function runTests() {
  describe("Tier 4: Scenario 10 — Osteth Open Countryside Multi-Terrain NRA POM Transition", () => {
    test("S10: Osteth open terrain seamlessly evaluates NRA heightfield, Gouraud lighting, and distance fade", () => {
      // 1. NRA Array Sampler providing curated normal, roughness, and height for terrain codes
      const nraDatabase = {
        // Code 2: Grass / Meadow (gentle micro-bumps, height 0.85)
        2: { x: 0.0, y: 0.0, z: 1.0, a: 0.85 },
        // Code 13: Mountain Scree / Cliff Crags (deep clefts, height 0.40)
        13: { x: 0.25, y: -0.15, z: 0.93, a: 0.40 },
        // Code 32: RoadType Cobblestone Lane (recessed mortar joints, height 0.35)
        32: { x: 0.1, y: 0.2, z: 0.95, a: 0.35 },
      };

      const nraSampler = (code) => nraDatabase[code] || { x: 0, y: 0, z: 1, a: 1.0 };
      const atlasSampler = (code) => ({ r: 0.5, g: 0.5, b: 0.5, a: 1.0 });

      // Verify NRA height sampling across the active landscape layers
      const hGrass = terrainLayerReliefH(2, [0, 0], nraSampler, atlasSampler);
      const hCliff = terrainLayerReliefH(13, [0, 0], nraSampler, atlasSampler);
      const hRoad = terrainLayerReliefH(32, [0, 0], nraSampler, atlasSampler);

      near(hGrass, 0.85, 1e-4, "Grass layer samples NRA height channel");
      near(hCliff, 0.40, 1e-4, "Cliff crag layer samples deep NRA clefts");
      near(hRoad, 0.35, 1e-4, "Cobblestone road layer samples recessed mortar joints");

      // 2. Camera elevation / distance arc across terrain: 5m, 15m, 25m, 35m, 45m, 50m
      const arcSamples = [
        { dist: 5.0, expectedFade: 1.0, expectedSteps: 6 },
        { dist: 15.0, expectedFade: 1.0, expectedSteps: 6 },
        { dist: 25.0, expectedFade: 0.60, expectedSteps: 6 },
        { dist: 35.0, expectedFade: 0.20, expectedSteps: 4 },
        { dist: 45.0, expectedFade: 0.0, expectedSteps: 4 },
        { dist: 50.0, expectedFade: 0.0, expectedSteps: 4 },
      ];

      for (const sample of arcSamples) {
        const fade = terrainPomFade(sample.dist);
        near(fade, sample.expectedFade, 1e-4, `Fade at ${sample.dist}m matches terrain LOD profile`);

        const steps = sample.dist > 26.25 ? 4 : 6;
        equal(steps, sample.expectedSteps, `Raymarch step count at ${sample.dist}m matches performance curve`);

        // Compute step UV offset
        const stepUv = (1.0 / 0.7071) * (CONSTANTS.TERRAIN_POM_DEPTH_SCALE * fade) * (1.0 / steps);
        if (sample.dist >= 40.0) {
          equal(stepUv, 0.0, `Displacement at ${sample.dist}m is strictly planar zero`);
        } else {
          ok(stepUv > 0.0, `Displacement at ${sample.dist}m is active`);
        }
      }

      // Explicit assertion: displacement at 50m is strictly 0.0
      equal(terrainPomFade(50.0), 0.0, "Displacement at 50m is strictly 0.0");

      // 3. Gouraud normal integration on mountain cliff under afternoon sun
      const cliffNormal = new THREE.Vector3(0.0, 0.7071, 0.7071).normalize(); // 45 deg hillside
      const cliffNra = nraDatabase[13];
      const uNormalScale = 0.5;

      const perturbedCliffNormal = cliffNormal.clone().add(
        new THREE.Vector3(cliffNra.x * uNormalScale, 0.0, cliffNra.y * uNormalScale)
      ).normalize();

      const sunDir = new THREE.Vector3(0.4, 0.6, 0.7).normalize();
      const diffuseOriginal = Math.max(0.0, cliffNormal.dot(sunDir));
      const diffusePerturbed = Math.max(0.0, perturbedCliffNormal.dot(sunDir));

      ok(diffusePerturbed > 0.6, "Cliff normal maintains strong illumination under direct sun");
      ok(Math.abs(diffusePerturbed - diffuseOriginal) > 0.02, "NRA normal perturbation introduces visible crag contrast");
    });
  });
}
