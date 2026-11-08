/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f13_regression_suite_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F13: Automated Unit & Integration Regression Suite
 */

import { describe, test, equal } from "../harness.mjs";
import {
  resolveGfxRelief,
  GFX_SUBDIV_MIN,
  GFX_SUBDIV_MAX,
  GFX_RELIEF_SCALE_MIN,
  GFX_RELIEF_SCALE_MAX,
} from "../../../scene3d/gfx_relief.js";

export function runTests() {
  describe("F13: Automated Unit & Integration Regression Suite — Boundary & Corner Cases", () => {
    const PRESET_ON = { gfxRelief: true, gfxSubdivLevel: 1, gfxReliefScale: 1.0 };

    test("B13-1: GFX subdiv level below minimum (negative value -4) clamps to 0", () => {
      const res = resolveGfxRelief("?gfxRelief=on&gfxSubdivLevel=-4", PRESET_ON);
      equal(res.subdivLevel, GFX_SUBDIV_MIN, "Negative subdiv level clamps to GFX_SUBDIV_MIN (0)");
    });

    test("B13-2: GFX subdiv level above maximum (level 99) clamps to 5", () => {
      const res = resolveGfxRelief("?gfxRelief=on&gfxSubdivLevel=99", PRESET_ON);
      equal(res.subdivLevel, GFX_SUBDIV_MAX, "Over-range subdiv level clamps to GFX_SUBDIV_MAX (5)");
    });

    test("B13-3: GFX relief scale negative (-1.0) clamps to GFX_RELIEF_SCALE_MIN (0.0)", () => {
      const res = resolveGfxRelief("?gfxRelief=on&gfxReliefScale=-1.0", PRESET_ON);
      equal(res.scale, GFX_RELIEF_SCALE_MIN, "Negative scale clamps to 0.0");
    });

    test("B13-4: GFX relief scale over-range (99.0) clamps to GFX_RELIEF_SCALE_MAX", () => {
      const res = resolveGfxRelief("?gfxRelief=on&gfxReliefScale=99.0", PRESET_ON);
      equal(res.scale, GFX_RELIEF_SCALE_MAX, "Over-range scale clamps to GFX_RELIEF_SCALE_MAX");
    });

    test("B13-5: Non-numeric junk parameter (?gfxSubdivLevel=banana) falls back to preset", () => {
      const res = resolveGfxRelief("?gfxRelief=on&gfxSubdivLevel=banana", PRESET_ON);
      equal(res.subdivLevel, PRESET_ON.gfxSubdivLevel, "Junk param falls back to preset subdivLevel (1)");
      equal(res.source.subdivLevel, "preset", "Reports source as 'preset'");
    });
  });
}
