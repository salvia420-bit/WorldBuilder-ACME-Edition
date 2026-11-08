/**
 * apps/holtburger-web/tests/e2e_relief/tier2_boundaries/f3_texture_reclassification_boundary.test.mjs
 *
 * Tier 2: Boundary & Corner Cases — F3: Brick & Stone Texture Reclassification
 */

import { describe, test, equal, allowsMacro } from "../harness.mjs";

export function runTests() {
  describe("F3: Brick & Stone Texture Reclassification — Boundary & Corner Cases", () => {
    test("B3-1: Unknown or unlisted texture DIDs default safely to Flush ('F')", () => {
      function resolveTextureClass(did, classMap) {
        return classMap[did] || "F";
      }

      const emptyMap = {};
      equal(resolveTextureClass("0x06009999", emptyMap), "F", "Unlisted texture DID defaults to Flush");
      equal(allowsMacro(resolveTextureClass("0x06009999", emptyMap)), false, "Unlisted texture does not receive macro relief");
    });

    test("B3-2: Null, undefined, and non-string class inputs handled defensively", () => {
      equal(allowsMacro(null), false, "null class code returns false");
      equal(allowsMacro(undefined), false, "undefined class code returns false");
      equal(allowsMacro(123), false, "number class code returns false");
      equal(allowsMacro({}), false, "object class code returns false");
    });

    test("B3-3: Invalid single-character codes ('X', '9', '?') treated as non-macro", () => {
      for (const badCode of ["X", "Z", "9", "!", "?"]) {
        equal(allowsMacro(badCode), false, `Invalid code '${badCode}' must not allow macro relief`);
      }
    });

    test("B3-4: Case-insensitivity and whitespace resilience in class code resolution", () => {
      equal(allowsMacro("s"), true, "lowercase 's' allows macro relief");
      equal(allowsMacro("b"), true, "lowercase 'b' allows macro relief");
      equal(allowsMacro(" S "), true, "padded ' S ' allows macro relief");
      equal(allowsMacro(" f "), false, "padded ' f ' suppresses macro relief");
    });

    test("B3-5: Boundary classification between ivy foliage vs stone wall", () => {
      // Foliage 'V' suppresses macro seam displacement; Stone 'S' enables it
      const wallSurfaces = [
        { name: "wall_stone_base", class: "S" },
        { name: "wall_ivy_decal", class: "V" },
      ];

      equal(allowsMacro(wallSurfaces[0].class), true, "Base stone wall receives macro seam relief");
      equal(allowsMacro(wallSurfaces[1].class), false, "Ivy decal on top of wall suppresses macro seam displacement");
    });
  });
}
