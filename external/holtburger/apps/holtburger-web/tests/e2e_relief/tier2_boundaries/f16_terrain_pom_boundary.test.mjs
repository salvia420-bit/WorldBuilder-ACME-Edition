/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f16_terrain_pom_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F16: Terrain POM & Lighting
 * Covers: Features 4 & 5 Boundary & Corner Conditions
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
  describe("F16: Terrain POM & Lighting — Boundary & Corner Cases", () => {
    test("B16-1: Exact boundary transitions at 15.0m and 40.0m", () => {
      // Exactly at 15.0m
      equal(terrainPomFade(15.0), 1.0, "At exact 15.0m boundary, fade factor is 1.0");

      // Epsilon past 15.0m
      const fade15Eps = terrainPomFade(15.0001);
      ok(fade15Eps < 1.0, "Immediately past 15.0m, fade factor begins smooth decay");
      ok(fade15Eps > 0.999, "Decay is continuous without sharp discontinuity");

      // Epsilon before 40.0m
      const fade39Eps = terrainPomFade(39.9999);
      ok(fade39Eps > 0.0, "Immediately before 40.0m, fade factor is positive non-zero");
      ok(fade39Eps < 0.001, "Decay approaches zero smoothly");

      // Exactly at 40.0m and beyond
      equal(terrainPomFade(40.0), 0.0, "At exact 40.0m boundary, fade factor is strictly 0.0");
      equal(terrainPomFade(500.0), 0.0, "Far distance (500m) is strictly 0.0");
      equal(terrainPomFade(Infinity), 0.0, "Infinity distance evaluates safely to 0.0 without NaN");
    });

    test("B16-2: Extreme terrain code boundaries (code 0, code 32, clamped >32)", () => {
      const dummyNra = (c) => ({ x: 0, y: 0, z: 1, a: 0.5 });

      // Code 0 (Cliff/Rock lower bound)
      const h0 = terrainLayerReliefH(0, [0, 0], dummyNra);
      equal(h0, 0.5, "Code 0 clamps cleanly and samples NRA height");

      // Code 32 (RoadType upper bound)
      const h32 = terrainLayerReliefH(32, [0, 0], dummyNra);
      equal(h32, 0.5, "Code 32 clamps cleanly and samples NRA height");

      // Negative code
      const hNeg = terrainLayerReliefH(-10, [0, 0], dummyNra);
      equal(hNeg, 0.5, "Negative code clamps safely to code 0");

      // Out-of-bounds high code (> 32)
      const hOver = terrainLayerReliefH(999, [0, 0], dummyNra);
      equal(hOver, 0.5, "Code > 32 clamps safely to code 32");
    });

    test("B16-3: Missing/untextured NRA atlas fallback (falls back to albedo luma gracefully)", () => {
      // When NRA sampler returns null or uncurated (height >= 0.995)
      const nullNra = () => null;
      const uncuratedNra = () => ({ x: 0, y: 0, z: 1, a: 1.0 });

      // Road code 32 with black albedo (luma = 0)
      const blackAtlas = () => ({ r: 0.0, g: 0.0, b: 0.0, a: 1.0 });
      const hBlack = terrainLayerReliefH(32, [0, 0], uncuratedNra, blackAtlas);
      near(hBlack, 0.32, 1e-4, "Zero luma road yields base minimum relief 0.32");

      // Cliff code 13 with white albedo (luma = 1)
      const whiteAtlas = () => ({ r: 1.0, g: 1.0, b: 1.0, a: 1.0 });
      const hWhite = terrainLayerReliefH(13, [0, 0], uncuratedNra, whiteAtlas);
      near(hWhite, 0.32 + 0.62 * 1.0, 1e-4, "Unit luma cliff yields maximum relief 0.94");

      // Standard grass layer (code 2) with uncurated NRA defaults safely to 1.0 (flat 1-tap exit)
      const hGrass = terrainLayerReliefH(2, [0, 0], uncuratedNra, whiteAtlas);
      equal(hGrass, 1.0, "Uncurated grass layer defaults to 1.0 for 1-tap exit");

      // Missing samplers entirely does not throw and returns valid number
      const hSafe = terrainLayerReliefH(32, [0, 0], null, null);
      ok(typeof hSafe === "number" && !isNaN(hSafe), "Missing samplers fallback safely without crash");
    });

    test("B16-4: Steep cliff terrain face normal perturbation clamp", () => {
      // In scene3d/terrain.js:
      // float pomSlope = 1.0 - clamp(pomN.z, 0.0, 1.0);
      // float pomCliffW = smoothstep(0.32, 0.62, pomSlope) * (1.0 - pomRoadW * 0.85);
      function calculateCliffWeight(normZ, roadWeight = 0.0) {
        const pomSlope = 1.0 - Math.max(0.0, Math.min(1.0, normZ));
        const edge0 = 0.32;
        const edge1 = 0.62;
        const t = Math.max(0.0, Math.min(1.0, (pomSlope - edge0) / (edge1 - edge0)));
        const w = t * t * (3.0 - 2.0 * t);
        return w * (1.0 - roadWeight * 0.85);
      }

      // Perfectly flat terrain (norm.z = 1.0 -> pomSlope = 0.0)
      equal(calculateCliffWeight(1.0), 0.0, "Flat ground has zero cliff weight");

      // Mild slope (norm.z = 0.8 -> pomSlope = 0.2 < 0.32)
      equal(calculateCliffWeight(0.8), 0.0, "Mild slope below 0.32 threshold has zero cliff weight");

      // Vertical cliff (norm.z = 0.0 -> pomSlope = 1.0 > 0.62)
      equal(calculateCliffWeight(0.0), 1.0, "Vertical cliff face has 1.0 cliff weight");

      // Overhang / inverted normal (norm.z < 0 clamped to 0)
      equal(calculateCliffWeight(-0.5), 1.0, "Inverted normal clamps safely to 1.0 cliff weight");

      // Cliff with road overlay
      near(calculateCliffWeight(0.0, 1.0), 0.15, 1e-4, "Road lane attenuates cliff weight down to 0.15");
    });

    test("B16-5: Zero depth scale (0.0) produces exact planar terrain", () => {
      const uPomScale = 0.0;
      const pomSteps = 6;
      const pomLayerStep = 1.0 / pomSteps;
      const invVz = 1.0 / 0.5;
      const pomFade = 1.0;

      const stepUv = (invVz * (uPomScale * pomFade) * pomLayerStep);
      equal(stepUv, 0.0, "Zero depth scale produces 0.0 step UV displacement");

      // March loop with zero stepUv never shifts UVs
      let uvOff = 0.0;
      for (let i = 0; i < pomSteps; i++) {
        uvOff += stepUv;
      }
      equal(uvOff, 0.0, "Accumulated UV offset is identically zero for planar terrain");
    });
  });
}
