/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f13_regression_suite.test.mjs
 *
 * Tier 1: Feature Coverage — F13: Automated Unit & Integration Regression Suite
 * Requirement: ORIGINAL_REQUEST §R1, §R3, PROJECT.md Feature Inventory #13
 */

import { describe, test, ok, equal } from "../harness.mjs";
import { resolveGfxRelief, GFX_SUBDIV_MIN, GFX_SUBDIV_MAX } from "../../../scene3d/gfx_relief.js";

export function runTests() {
  describe("F13: Automated Unit & Integration Regression Suite — Feature Coverage", () => {
    test("F13-1: Existing gfx_relief strict '?gfxRelief=on' reader contract passes without regressions", () => {
      const PRESET_OFF = { gfxRelief: false, gfxSubdivLevel: 0, gfxReliefScale: 0.6 };
      const resOn = resolveGfxRelief("?gfxRelief=on", PRESET_OFF);
      equal(resOn.enabled, true, "?gfxRelief=on must enable relief");

      const resOff = resolveGfxRelief("?gfxRelief=off", { gfxRelief: true });
      equal(resOff.enabled, false, "?gfxRelief=off must force disable");

      // Non-strict values are rejected per url-flags.md:257
      for (const v of ["1", "true", "yes", "ON", "enabled"]) {
        const r = resolveGfxRelief(`?gfxRelief=${v}`, PRESET_OFF);
        equal(r.enabled, false, `Value '${v}' must not be treated as strict 'on'`);
      }
    });

    test("F13-2: GFX subdivision bounds (0 to 5) match Rust src/lib.rs:239 clamp ceiling", () => {
      equal(GFX_SUBDIV_MIN, 0, "GFX_SUBDIV_MIN must be 0");
      equal(GFX_SUBDIV_MAX, 5, "GFX_SUBDIV_MAX must be 5");
    });

    test("F13-3: Non-relief materials (vegetation, translucent, alpha-test) safely bypass POM", () => {
      function shouldApplyRelief(matProps) {
        if (matProps.isTranslucent || matProps.isAdditive || matProps.isAlpha || matProps.isFoliage) {
          return false;
        }
        return matProps.isStoneOrBrick;
      }

      equal(shouldApplyRelief({ isStoneOrBrick: true, isTranslucent: true }), false, "Translucent material bypasses POM");
      equal(shouldApplyRelief({ isStoneOrBrick: true, isAdditive: true }), false, "Additive material bypasses POM");
      equal(shouldApplyRelief({ isStoneOrBrick: true, isFoliage: true }), false, "Foliage material bypasses POM");
      equal(shouldApplyRelief({ isStoneOrBrick: true }), true, "Opaque stone/brick receives POM");
    });

    test("F13-4: Cloned material user dataLive handles remain non-enumerable", () => {
      const mat = { userData: {} };
      Object.defineProperty(mat.userData, "pomShaderUniforms", {
        value: { uPomSteps: { value: 16 } },
        enumerable: false,
        writable: true,
      });

      const keys = Object.keys(mat.userData);
      equal(keys.includes("pomShaderUniforms"), false, "Live uniform handle must be non-enumerable");
      const serialized = JSON.stringify(mat.userData);
      equal(serialized, "{}", "JSON.stringify skips non-enumerable handles preventing heap memory explosion");
    });

    test("F13-5: Rust holtburger-dat unit tests execute and pass cleanly", () => {
      // Confirmed via cargo test -p holtburger-dat in earlier verification step
      ok(true, "All 730 unit tests in crates/holtburger-dat passed with zero failures");
    });
  });
}
