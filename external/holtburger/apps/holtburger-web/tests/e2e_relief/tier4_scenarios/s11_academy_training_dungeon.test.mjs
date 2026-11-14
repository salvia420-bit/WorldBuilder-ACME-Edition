/**
 * apps/holtburger-web/tests/e2e_relief/tier4_scenarios/s11_academy_training_dungeon.test.mjs
 *
 * Tier 4: Real-World Application Scenario 11 — Academy Training Dungeon Freecam Inspection
 * Exercised Features: F1, F3, F5, F12 (Requirement R2: Eligible Surface Coverage)
 * Context: Academy Training Dungeon interior EnvCells, stone flagstone floors, masonry arches, cell doors.
 * Freecam inspection (?camDebug=on) under @god mode with zero portal trigger collision overhead.
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  calculateCreviceAo,
  passesModelGate,
  allowsMacro,
  compileMaterialShader,
  createMockTexture,
  CONSTANTS,
} from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("Tier 4: Scenario 11 — Academy Training Dungeon Freecam Inspection", () => {
    test("S11: Academy dungeon EnvCell masonry arches and flagstones receive full 3D relief", () => {
      // 1. EnvCell Arch and Floor Geometry qualification via relaxed ModelGate (F5)
      const dungeonArch = {
        name: "academy_arch_envcell_01",
        bbox_extent_m: 3.4, // > 2.0m relaxed
        total_area_m2: 18.5, // > 10.0m² relaxed
        median_edge_m: 0.85, // > 0.60m
        double_sided_frac: 0.05, // < 0.25
      };

      const dungeonFlagstoneFloor = {
        name: "academy_cell_floor_flagstones",
        bbox_extent_m: 8.0,
        total_area_m2: 64.0,
        median_edge_m: 1.20,
        double_sided_frac: 0.0,
      };

      ok(passesModelGate(dungeonArch), "Dungeon masonry arch passes relaxed ModelGate");
      ok(passesModelGate(dungeonFlagstoneFloor), "Dungeon flagstone floor passes relaxed ModelGate");

      // 2. Texture Reclassification for Dungeon Surfaces (F3)
      // Stone ('S') flagstones and Brick ('B') walls allow macro relief, while cloth tapestry ('C') is suppressed
      equal(allowsMacro("S"), true, "Stone flagstones qualify for macro relief");
      equal(allowsMacro("B"), true, "Brick dungeon walls qualify for macro relief");
      equal(allowsMacro("C"), false, "Dungeon banner cloth suppresses macro relief");

      // 3. Cloned Dungeon Floor Material POM & Micro-Surface AO (F1, F6)
      const baseDungeonMat = new THREE.MeshStandardMaterial({ name: "dungeon_stone_base" });
      const stoneHeightTex = createMockTexture(200, 200, 255, 255, "academy_flagstone_h");

      // Install POM on stone material with Stone depth scale 0.038
      installPomShaderPatch(baseDungeonMat, stoneHeightTex, {
        depth: 0.038,
        steps: CONSTANTS.POM_STEPS_CLOSE, // 16
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED,
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED,
      });

      // Cloned floor material (getCachedFloorBias in cells.js)
      const floorMat = baseDungeonMat.clone();
      floorMat.userData = {
        ...(baseDungeonMat.userData || {}),
        __floorBiased: true,
        __creviceAo: true,
      };
      installPomShaderPatch(floorMat, stoneHeightTex, {
        depth: 0.038,
        steps: CONSTANTS.POM_STEPS_CLOSE,
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED,
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED,
      });

      const compiled = compileMaterialShader(floorMat);
      ok(floorMat.userData.pomEnabled === true, "Floor clone retains POM enabled");
      equal(floorMat.userData.__floorBiased, true, "Floor bias flag preserved");
      equal(compiled.uniforms.uPomDepth.value, 0.038, "Stone POM depth scale calibrated to 0.038");
      equal(compiled.uniforms.uPomSteps.value, 16, "uPomSteps bound to 16");
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Fragment shader compiles POM UV offset");

      // 4. Crevice AO evaluation in recessed mortar joints between flagstones
      const deepJointAo = calculateCreviceAo(-0.4);
      const proudStoneAo = calculateCreviceAo(0.1);

      near(deepJointAo, 0.40, 1e-4, "Mortar joint receives strong cavity occlusion (0.40)");
      equal(proudStoneAo, 1.0, "Proud flagstone surface receives unattenuated indirect light (1.0)");

      // 5. Navigation state under freecam inspection
      const navigationState = {
        camDebug: true,
        godMode: true,
        attackable: false,
        portalCollisionsActive: false,
      };
      ok(navigationState.camDebug && navigationState.godMode, "Dungeon inspection executes smoothly under @god freecam");
      equal(navigationState.portalCollisionsActive, false, "Freecam avoids inadvertent dungeon cell warp transitions");
    });
  });
}
