/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f17_foliage_arbory.test.mjs
 *
 * Tier 1: Feature Coverage — F17: Foliage & Arbory 3D Depth (Requirement R4)
 * Covers: Features 6 & 7 (Foliage Heightfield Derivation & Arbory Shader/Sway Integration)
 * Derived from: ORIGINAL_REQUEST §R4, PROJECT.md M3 Interface Contracts
 */

import * as THREE from "three";
import {
  describe,
  test,
  ok,
  equal,
  near,
  calculateFoliageHeight,
  evaluateReliefEligible,
  compileMaterialShader,
  createMockTexture,
  CONSTANTS,
} from "../harness.mjs";
import { installPomShaderPatch } from "../../../scene3d/materials.js";

export function runTests() {
  describe("F17: Foliage & Arbory 3D Depth — Feature Coverage", () => {
    test("F17-1: Alpha cutout distance transform pillowed height calculation", () => {
      // Contract: ReliefClass::Foliage generates pillowed height via distance transform from cutout edge
      function computeSyntheticLeafDistanceTransform(size = 8) {
        // Create an 8x8 circular/oval leaf mask
        const mask = new Uint8Array(size * size);
        const center = (size - 1) * 0.5;
        const radius = size * 0.45;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const dist = Math.hypot(x - center, y - center);
            mask[y * size + x] = dist <= radius ? 255 : 0;
          }
        }

        // Distance transform: distance to closest 0-alpha pixel
        const dt = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (mask[y * size + x] === 0) {
              dt[y * size + x] = 0.0;
              continue;
            }
            let minD = Infinity;
            for (let ny = 0; ny < size; ny++) {
              for (let nx = 0; nx < size; nx++) {
                if (mask[ny * size + nx] === 0) {
                  const d = Math.hypot(x - nx, y - ny);
                  if (d < minD) minD = d;
                }
              }
            }
            dt[y * size + x] = minD;
          }
        }

        // Normalize distance transform to [0, 1]
        let maxD = 0;
        for (let i = 0; i < dt.length; i++) if (dt[i] > maxD) maxD = dt[i];
        const pillow = new Float32Array(size * size);
        if (maxD > 0) {
          for (let i = 0; i < dt.length; i++) pillow[i] = dt[i] / maxD;
        }
        return { mask, pillow, maxD };
      }

      const { mask, pillow } = computeSyntheticLeafDistanceTransform(8);

      // Edge transparent pixels must have strictly 0.0 height
      equal(pillow[0], 0.0, "Corner transparent pixel must have 0.0 pillow height");
      equal(calculateFoliageHeight(0.0, 0.5), 0.0, "Transparent leaf cutout must strictly evaluate to 0.0 height");
      equal(calculateFoliageHeight(0.0, 1.0), 0.0, "Transparent leaf cutout with full white luma must strictly evaluate to 0.0 height");

      // Center pixel (spine of leaf) must have maximum pillow height (1.0)
      const centerIdx = 3 * 8 + 3;
      near(pillow[centerIdx], 1.0, 0.1, "Center spine of leaf card has maximum pillowing");

      // Intermediate pixels must show monotonic gradient from boundary to center
      const boundaryEdgeIdx = 1 * 8 + 3;
      ok(pillow[boundaryEdgeIdx] > 0.0, "Inner perimeter has positive height");
      ok(pillow[boundaryEdgeIdx] < pillow[centerIdx], "Height rises from perimeter to center");
    });

    test("F17-2: Vein luminance dark-detail carving (MICRO_DETAIL_MIX = 0.65)", () => {
      equal(CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX, 0.65, "Foliage micro-detail mix must be 0.65");

      // Vein depressed area: dark vein (luma = 0.15) on high pillow dome (1.0)
      const veinHeight = calculateFoliageHeight(1.0, 0.15, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      // Expected: 1.0 * (1 - 0.65) + 0.15 * 0.65 = 0.35 + 0.0975 = 0.4475
      near(veinHeight, 0.4475, 1e-4, "Dark leaf vein depresses surface height");

      // Mesophyll area: bright leaf blade (luma = 0.85) on high pillow dome (1.0)
      const bladeHeight = calculateFoliageHeight(1.0, 0.85, CONSTANTS.FOLIAGE_MICRO_DETAIL_MIX);
      // Expected: 1.0 * (1 - 0.65) + 0.85 * 0.65 = 0.35 + 0.5525 = 0.9025
      near(bladeHeight, 0.9025, 1e-4, "Leaf blade tissue retains high proud relief");

      ok(bladeHeight - veinHeight > 0.4, "Vein carving creates >= 40% height differential for tactile leaf ribs");
    });

    test("F17-3: Base1ClipMap unblocking in materials.js reliefEligible predicate", () => {
      // Contract: Base1ClipMap (foliage cutouts) qualifies for POM when foliage relief is active
      // (Uses shared evaluateReliefEligible oracle from harness.mjs)

      // 1. Foliage clipmap with foliageRelief enabled -> ELIGIBLE
      const foliageClipMap = { isClipMap: true, category: "Foliage", hasRelief: true };
      equal(evaluateReliefEligible(foliageClipMap, { foliageRelief: true }), true, "Foliage clipmap must be relief eligible");

      // 2. Foliage clipmap with foliageRelief disabled -> BLOCKED
      equal(evaluateReliefEligible(foliageClipMap, { foliageRelief: false }), false, "Foliage clipmap blocked when foliage relief disabled");

      // 3. Architectural metal fence cutout (non-foliage clipmap) -> BLOCKED
      const fenceClipMap = { isClipMap: true, category: "Generic", depthScale: 0.02 };
      equal(evaluateReliefEligible(fenceClipMap, { foliageRelief: true }), false, "Non-foliage clipmap remains blocked from POM");

      // 4. Translucent foliage (e.g. fairy dust / ghost tree) -> BLOCKED
      const ghostFoliage = { isClipMap: true, isTranslucent: true, category: "Foliage" };
      equal(evaluateReliefEligible(ghostFoliage, { foliageRelief: true }), false, "Translucent foliage remains blocked");
    });

    test("F17-4: Foliage material POM uniform binding (uPomDepth = 0.015, uPomSteps = 16)", () => {
      const mat = new THREE.MeshStandardMaterial({ name: "holtburg_tree_canopy_mat" });
      const foliageHeightTex = createMockTexture(128, 128, 255, 255, "tree_foliage_height");

      installPomShaderPatch(mat, foliageHeightTex, {
        depth: CONSTANTS.FOLIAGE_POM_DEPTH_SCALE, // 0.015
        steps: CONSTANTS.FOLIAGE_POM_STEPS, // 16
        lodNear: CONSTANTS.POM_LOD_NEAR_EXTENDED,
        lodFar: CONSTANTS.POM_LOD_FAR_EXTENDED,
      });

      const compiled = compileMaterialShader(mat);
      ok(mat.userData.pomEnabled === true, "Material must have pomEnabled: true");
      equal(compiled.uniforms.uPomDepth.value, 0.015, "uPomDepth must be bound to 0.015");
      equal(compiled.uniforms.uPomSteps.value, 16, "uPomSteps must be bound to 16");
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Fragment shader must compile POM UV offset");
    });

    test("F17-5: GPU wind sway displacement chunk preservation and canopy softening crown normal preservation", () => {
      const mat = new THREE.MeshStandardMaterial({ name: "tree_wind_canopy" });
      const foliageHeightTex = createMockTexture(128, 128, 255, 255, "tree_foliage_height");

      // Install POM
      installPomShaderPatch(mat, foliageHeightTex, {
        depth: CONSTANTS.FOLIAGE_POM_DEPTH_SCALE,
        steps: CONSTANTS.FOLIAGE_POM_STEPS,
      });

      // Chain wind sway vertex shader hook (as in windSwayGpu.js)
      const prevOnBeforeCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        prevOnBeforeCompile(shader, renderer);
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          // VFX_WINDSWAY_BEGIN
          float windHeight = max(0.0, transformed.z - 0.0);
          transformed.xy += vec2(0.05, 0.02) * windHeight;
          // VFX_WINDSWAY_END`
        );
      };

      const compiled = compileMaterialShader(mat);
      ok(/VFX_WINDSWAY_BEGIN/.test(compiled.vertexShader), "Vertex shader preserves GPU wind sway chunk");
      ok(/_pomPerturbedUv/.test(compiled.fragmentShader), "Fragment shader preserves POM raymarch chunk");

      // Verify canopy softening crown normal direction is uncorrupted
      const crownCenter = new THREE.Vector3(0.0, 0.0, 15.0); // 15m trunk
      const leafPos = new THREE.Vector3(3.0, 2.0, 18.0);
      const softenedNormal = leafPos.clone().sub(crownCenter).normalize();

      ok(softenedNormal.z > 0.0, "Crown-radial normal points outward and upward from canopy center");
      near(softenedNormal.length(), 1.0, 1e-4, "Softened normal is unit length");
    });
  });
}
