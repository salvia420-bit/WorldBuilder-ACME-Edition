/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f11_program_cache_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F11: Program Cache Disambiguation
 */

import { describe, test, ok, equal, buildProgramCacheKey } from "../harness.mjs";

export function runTests() {
  describe("F11: Program Cache Disambiguation — Boundary & Corner Cases", () => {
    test("B11-1: Empty or null userData generates valid default program cache key", () => {
      const keyNull = buildProgramCacheKey(null);
      const keyEmpty = buildProgramCacheKey({});

      equal(keyNull, keyEmpty, "Null and empty userData produce identical canonical default key");
      ok(keyEmpty.startsWith("hb|d0|c0|p0"), "Starts with standard default tokens");
    });

    test("B11-2: All enhancement bits active simultaneously produce valid unified key", () => {
      const fullUserData = {
        detailEnabled: true,
        csmEnabled: true,
        pomEnabled: true,
        lightClampRetail: true,
        __aoPatched: true,
        __depthBiased: true,
        __floorBiased: true,
        __staticBiased: true,
        __acBakedLight: true,
        __acBakedDirectOut: true,
        __creviceAo: true,
        __microShadow: true,
        __vfxSetKey: "vfx_test",
      };

      const key = buildProgramCacheKey(fullUserData);
      ok(key.includes("|p1"), "Includes POM bit");
      ok(key.includes("|mc1"), "Includes crevice AO bit");
      ok(key.includes("|ms1"), "Includes micro-shadow bit");
      ok(key.includes("vfx_test"), "Includes VFX set key");
    });

    test("B11-3: Rapid consecutive key evaluations produce identical string without cache jitter", () => {
      const ud = { pomEnabled: true, __creviceAo: true };
      const k1 = buildProgramCacheKey(ud);
      const k2 = buildProgramCacheKey(ud);
      const k3 = buildProgramCacheKey(ud);

      equal(k1, k2, "k1 equals k2");
      equal(k2, k3, "k2 equals k3");
    });

    test("B11-4: Unrelated custom properties on userData do not perturb shader cache key", () => {
      const udBase = { pomEnabled: true };
      const udExtra = { pomEnabled: true, customGameEntityId: 12345, temporaryDebugFlag: "foo" };

      const kBase = buildProgramCacheKey(udBase);
      const kExtra = buildProgramCacheKey(udExtra);

      equal(kBase, kExtra, "Unrelated userData properties do not break program caching");
    });

    test("B11-5: Program cache key length remains bounded and compact (< 256 characters)", () => {
      const ud = { pomEnabled: true, __creviceAo: true, __microShadow: true, __vfxSetKey: "standard_wall" };
      const key = buildProgramCacheKey(ud);
      ok(key.length < 256, `Key length (${key.length}) is compact and well below 256 char budget`);
    });
  });
}
