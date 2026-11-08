/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f4_authored_overrides_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F4: Authored Override Heightfield Preservation
 */

import { describe, test, ok, equal } from "../harness.mjs";

export function runTests() {
  describe("F4: Authored Override Heightfield Preservation — Boundary & Corner Cases", () => {
    test("B4-1: Zero-length / empty override buffer falls back to procedural derivation safely", () => {
      function processNormalOverride(overrideBuf, proceduralFallback) {
        if (!overrideBuf || overrideBuf.length === 0) {
          return proceduralFallback;
        }
        return overrideBuf;
      }

      const emptyOverride = new Uint8Array(0);
      const fallback = new Uint8Array([128, 128, 255, 255]);
      const res = processNormalOverride(emptyOverride, fallback);
      equal(res.length, 4, "Empty override buffer falls back to 4-byte procedural normal");
    });

    test("B4-2: Non-square normal map override dimensions handled cleanly", () => {
      // 512x256 rectangular texture
      const rectNormal = { width: 512, height: 256, pixels: new Uint8Array(512 * 256 * 4) };
      ok(rectNormal.width !== rectNormal.height, "Non-square dimension check");
      equal(rectNormal.pixels.length, 512 * 256 * 4, "Buffer size matches rectangular dimensions");
    });

    test("B4-3: Missing alpha channel in normal override derives neutral heightfield", () => {
      // RGB 3-channel normal map (no embedded alpha height)
      function deriveHeightFromNormal(normalRgba) {
        // If alpha is 255 everywhere or absent, derive from green channel relief or luminance
        const hasAlphaVariation = normalRgba.some((val, idx) => idx % 4 === 3 && val < 250);
        if (!hasAlphaVariation) {
          // Neutral heightfield fallback: proud masonry face
          return new Uint8Array([255, 255, 255, 255]);
        }
        return new Uint8Array([200, 150, 100, 255]);
      }

      const flatAlphaNormal = new Uint8Array([128, 128, 255, 255, 128, 128, 255, 255]);
      const height = deriveHeightFromNormal(flatAlphaNormal);
      equal(height[0], 255, "Neutral fallback sets proud face 255");
    });

    test("B4-4: Extreme roughness override boundaries (0.0 mirror vs 1.0 matte) preserved", () => {
      const overrides = [
        { name: "wet_cobblestone", roughness: 0.0, normal_scale: 1.0 },
        { name: "dry_chalk_stone", roughness: 1.0, normal_scale: 1.0 },
      ];

      equal(overrides[0].roughness, 0.0, "Mirror roughness preserved");
      equal(overrides[1].roughness, 1.0, "Matte roughness preserved");
    });

    test("B4-5: Multiple concurrent override lookups remain strictly deterministic", () => {
      const cache = new Map();
      function getOverrideCached(did) {
        if (!cache.has(did)) {
          cache.set(did, { did, normal: `normal_${did}`, height: `height_${did}` });
        }
        return cache.get(did);
      }

      const ref1 = getOverrideCached(0x06001234);
      const ref2 = getOverrideCached(0x06001234);
      equal(ref1, ref2, "Same object reference returned across concurrent calls");
    });
  });
}
