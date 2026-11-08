/**
 * apps/holtburger-web/tests/e2e_relief/tier1_features/f3_texture_reclassification.test.mjs
 *
 * Tier 1: Feature Coverage — F3: Brick & Stone Texture Reclassification
 * Requirement: ORIGINAL_REQUEST §R1, PROJECT.md Feature Inventory #3
 */

import fs from "node:fs";
import path from "node:path";
import { describe, test, ok, equal, allowsMacro } from "../harness.mjs";

function loadCompactClasses() {
  const possiblePaths = [
    path.resolve(process.cwd(), "data/tex-relief-classes.compact.json"),
    path.resolve(process.cwd(), "../../data/tex-relief-classes.compact.json"),
    path.resolve("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/data/tex-relief-classes.compact.json"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  return null;
}

export function runTests() {
  describe("F3: Brick & Stone Texture Reclassification — Feature Coverage", () => {
    test("F3-1: Architectural masonry classes (Stone 'S', Brick 'B') allow macro seam operators", () => {
      ok(allowsMacro("S"), "Stone ('S') must allow macro relief operators");
      ok(allowsMacro("B"), "Brick ('B') must allow macro relief operators");
      ok(allowsMacro("T"), "Timber ('T') must allow macro relief operators");
      ok(allowsMacro("P"), "Plank ('P') must allow macro relief operators");
      ok(allowsMacro("H"), "Shingle ('H') must allow macro relief operators");
    });

    test("F3-2: Non-masonry classes (Flush 'F', Cloth 'C', Foliage 'V', Unknown 'U') suppress macro operators", () => {
      equal(allowsMacro("F"), false, "Flush ('F') must suppress macro relief");
      equal(allowsMacro("C"), false, "Cloth ('C') must suppress macro relief");
      equal(allowsMacro("V"), false, "Foliage ('V') must suppress macro relief");
      equal(allowsMacro("U"), false, "Unknown ('U') must suppress macro relief");
      equal(allowsMacro(""), false, "Empty string must suppress macro relief");
    });

    test("F3-3: Holtburg cottage wall brick textures are classified as Brick ('B')", () => {
      const data = loadCompactClasses();
      ok(data && data.classes, "tex-relief-classes.compact.json must be loaded");
      const cls09 = data.classes["0x06007509"];
      const cls73 = data.classes["0x06007573"];
      equal(cls09, "B", "Holtburg cottage wall 0x06007509 must be classified as Brick ('B')");
      equal(cls73, "B", "Holtburg cottage wall 0x06007573 must be classified as Brick ('B')");
      ok(allowsMacro(cls09), "0x06007509 must allow macro seam displacement");
    });

    test("F3-4: Sanamar dressed stone and limestone masonry are classified as Stone ('S')", () => {
      const data = loadCompactClasses();
      ok(data && data.classes, "tex-relief-classes.compact.json must be loaded");
      const clsE8 = data.classes["0x060074E8"];
      const cls01 = data.classes["0x06007501"];
      const cls72 = data.classes["0x06007572"];
      equal(clsE8, "S", "Sanamar masonry 0x060074E8 must be Stone ('S')");
      equal(cls01, "S", "Sanamar masonry 0x06007501 must be Stone ('S')");
      equal(cls72, "S", "Sanamar masonry 0x06007572 must be Stone ('S')");
      ok(allowsMacro(clsE8), "Sanamar masonry must allow macro seam generation");
    });

    test("F3-5: Neydisa Castle and Bandit Castle architectural textures are classified into macro classes", () => {
      const data = loadCompactClasses();
      ok(data && data.classes, "tex-relief-classes.compact.json must be loaded");
      const cls06 = data.classes["0x06007506"];
      const cls07 = data.classes["0x06007507"];
      const cls74 = data.classes["0x06007574"];
      const cls75 = data.classes["0x06007575"];

      ok(cls06 === "S" || cls06 === "B", "Neydisa texture 0x06007506 must be Stone or Brick");
      ok(cls07 === "S" || cls07 === "B", "Neydisa texture 0x06007507 must be Stone or Brick");
      ok(cls74 === "S" || cls74 === "B", "Bandit Castle texture 0x06007574 must be Stone or Brick");
      ok(cls75 === "S" || cls75 === "B", "Bandit Castle texture 0x06007575 must be Stone or Brick");
      ok(allowsMacro(cls06), "Neydisa texture must activate macro seam generation");
      ok(allowsMacro(cls75), "Bandit Castle texture must activate macro seam generation");
    });
  });
}
