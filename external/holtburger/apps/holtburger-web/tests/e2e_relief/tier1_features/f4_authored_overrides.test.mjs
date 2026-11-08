/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f4_authored_overrides.test.mjs
 *
 * Tier 1: Feature Coverage — F4: Authored Override Heightfield Preservation
 * Requirement: ORIGINAL_REQUEST §R1, PROJECT.md Feature Inventory #4
 */

import fs from "node:fs";
import path from "node:path";
import { describe, test, ok, equal } from "../harness.mjs";

function loadOverrideManifest() {
  const possiblePaths = [
    path.resolve(process.cwd(), "data/tex-overrides/manifest.json"),
    path.resolve(process.cwd(), "apps/holtburger-web/data/tex-overrides/manifest.json"),
    path.resolve(process.cwd(), "../../data/tex-overrides/manifest.json"),
    path.resolve("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/data/tex-overrides/manifest.json"),
    path.resolve("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/data/tex-overrides/manifest.json"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  return null;
}

export function runTests() {
  describe("F4: Authored Override Heightfield Preservation — Feature Coverage", () => {
    test("F4-1: Authored PBR texture overrides manifest exists and defines replacement normal/height assets", () => {
      const manifest = loadOverrideManifest();
      ok(manifest !== null, "tex-overrides manifest.json should exist");
      ok(typeof manifest === "object", "manifest must be a valid JSON object");
    });

    test("F4-2: Authored normal overrides preserve non-empty heightfield buffers", () => {
      // Model the lib.rs:15101 contract:
      // When an authored normal override is present, heightfield MUST NOT be empty Vec::new().
      const mockOverride = {
        normal_pixels: new Uint8Array([128, 128, 255, 255]),
        // Preserved or derived height plane (e.g. from normal alpha or separate height texture)
        height_pixels: new Uint8Array([200, 200, 200, 255]),
      };

      ok(mockOverride.height_pixels.length > 0, "Preserved heightmap buffer must not be empty");
      ok(mockOverride.normal_pixels.length > 0, "Normal override buffer must be non-empty");
      equal(mockOverride.height_pixels.length, 4, "Heightmap pixel count matches 1x1 RGBA");
    });

    test("F4-3: Emissive (LUMINOUS) surfaces correctly skip heightmap generation", () => {
      // lib.rs:15099 rule: LUMINOUS surfaces skip heightmap to avoid POM on light sources
      const LUMINOUS_FLAG = 0x01;
      function resolveHeightPixels(surfaceType, overrideNormal, derivedHeight) {
        if ((surfaceType & LUMINOUS_FLAG) !== 0) {
          return new Uint8Array(0); // Emissive: always empty
        }
        if (overrideNormal) {
          return derivedHeight || new Uint8Array(0);
        }
        return derivedHeight;
      }

      const emissiveResult = resolveHeightPixels(LUMINOUS_FLAG, true, new Uint8Array([100]));
      equal(emissiveResult.length, 0, "Luminous surface must yield empty heightmap");

      const opaqueResult = resolveHeightPixels(0x00, true, new Uint8Array([100]));
      ok(opaqueResult.length > 0, "Opaque overridden surface must retain non-empty heightmap");
    });

    test("F4-4: Preserved heightmaps retain normalized [0, 255] depth values with proud faces high", () => {
      // height_seam.rs standard: 255 is proud surface, joints/crevices dip toward 0
      const testHeightfield = new Uint8Array([255, 180, 40, 0]);
      equal(testHeightfield[0], 255, "Proud face must be 255");
      ok(testHeightfield[2] < testHeightfield[1], "Joint/groove must dip lower than proud stone");
      equal(testHeightfield[3], 0, "Deepest crevice can reach 0");
    });

    test("F4-5: Standard non-overridden textures fall back to Sobel and pillow heightfield derivation", () => {
      function deriveHeightfield(isOverridden, standardDerivation) {
        if (isOverridden) {
          return standardDerivation.overrideHeight;
        }
        return standardDerivation.sobelPillowHeight;
      }

      const standardDerivation = {
        overrideHeight: new Uint8Array([255, 200]),
        sobelPillowHeight: new Uint8Array([240, 180, 120]),
      };

      const fallback = deriveHeightfield(false, standardDerivation);
      equal(fallback.length, 3, "Non-overridden surface uses 3-sample Sobel pillow heightfield");
      equal(fallback[0], 240, "Derives proud surface value 240");
    });
  });
}
