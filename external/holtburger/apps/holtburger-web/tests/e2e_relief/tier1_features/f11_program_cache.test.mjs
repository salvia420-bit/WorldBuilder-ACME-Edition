/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f11_program_cache.test.mjs
 *
 * Tier 1: Feature Coverage — F11: Program Cache Disambiguation
 * Requirement: ORIGINAL_REQUEST §R2, PROJECT.md Feature Inventory #11
 */

import { describe, test, ok, equal, buildProgramCacheKey } from "../harness.mjs";

export function runTests() {
  describe("F11: Program Cache Disambiguation — Feature Coverage", () => {
    test("F11-1: POM toggle generates unique cache key token (|p0 vs |p1)", () => {
      const keyOff = buildProgramCacheKey({ pomEnabled: false });
      const keyOn = buildProgramCacheKey({ pomEnabled: true });

      ok(keyOff.includes("|p0"), "POM off key must contain '|p0'");
      ok(keyOn.includes("|p1"), "POM on key must contain '|p1'");
      ok(keyOff !== keyOn, "Keys must be strictly non-equal");
    });

    test("F11-2: Micro-surface crevice AO generates unique cache key token (|mc0 vs |mc1)", () => {
      const keyOff = buildProgramCacheKey({ __creviceAo: false });
      const keyOn = buildProgramCacheKey({ __creviceAo: true });

      ok(keyOff.includes("|mc0"), "Crevice AO off key must contain '|mc0'");
      ok(keyOn.includes("|mc1"), "Crevice AO on key must contain '|mc1'");
      ok(keyOff !== keyOn, "Keys must not collide");
    });

    test("F11-3: Micro-contact shadowing generates unique cache key token (|ms0 vs |ms1)", () => {
      const keyOff = buildProgramCacheKey({ __microShadow: false });
      const keyOn = buildProgramCacheKey({ __microShadow: true });

      ok(keyOff.includes("|ms0"), "Micro-shadow off key must contain '|ms0'");
      ok(keyOn.includes("|ms1"), "Micro-shadow on key must contain '|ms1'");
      ok(keyOff !== keyOn, "Keys must not collide");
    });

    test("F11-4: Compound visual enhancements produce unique multi-token key without collision", () => {
      const kBase = buildProgramCacheKey({});
      const kPomOnly = buildProgramCacheKey({ pomEnabled: true });
      const kAoOnly = buildProgramCacheKey({ __creviceAo: true });
      const kShadowOnly = buildProgramCacheKey({ __microShadow: true });
      const kFullAll = buildProgramCacheKey({ pomEnabled: true, __creviceAo: true, __microShadow: true });

      const allKeys = new Set([kBase, kPomOnly, kAoOnly, kShadowOnly, kFullAll]);
      equal(allKeys.size, 5, "All 5 permutations must generate completely unique program cache keys");
    });

    test("F11-5: Program cache key evaluation is lazy and order-independent", () => {
      const ud = { pomEnabled: false };
      const keyInitial = buildProgramCacheKey(ud);
      ok(keyInitial.includes("|p0"), "Initial key has |p0");

      ud.pomEnabled = true;
      const keyUpdated = buildProgramCacheKey(ud);
      ok(keyUpdated.includes("|p1"), "Updated key has |p1 without re-installing key generator");
    });
  });
}
