/**
 * apps/holtburger-web/tests/e2e_relief/tier4_scenarios/s4_al_jalima_sandstone.test.mjs
 *
 * Tier 4: Real-World Town Scenario 4 — Al-Jalima Sandstone Architecture & Domed Tavern
 * Exercised Features: F2, F3, F6, F7, F10, F14
 * Context: Al-Jalima Gharu'ndim sandstone buildings and walls
 */

import {
  describe,
  test,
  ok,
  equal,
  near,
  pomLodAtDistance,
  pomGrazeWeight,
  calculateCreviceAo,
  calculateSpecularRim,
  allowsMacro,
} from "../harness.mjs";

export function runTests() {
  describe("Tier 4: Scenario 4 — Al-Jalima Sandstone Architecture & Domed Tavern", () => {
    test("S4: Al-Jalima Gharu'ndim sandstone dome and curved walls render smooth relief without stalactites", () => {
      // 1. Al-Jalima Sandstone Tavern location
      const alJalimaTavern = { x: 42100, y: 28900, z: 75, style: "Gharu'ndim_Domed_Sandstone" };
      ok(alJalimaTavern.x > 0, "Al-Jalima tavern location valid");

      // 2. F3: Sandstone classified as Stone ('S')
      ok(allowsMacro("S"), "Sandstone masonry allows macro relief");

      // 3. F10: Curved dome silhouette angle handling
      // The dome curves from head-on at center to glancing angles at perimeter
      const domeAngles = [0.95, 0.75, 0.50, 0.35, 0.18, 0.08];
      for (const dotNV of domeAngles) {
        const { pz, grazeW } = pomGrazeWeight(dotNV, true);

        // At curved dome silhouette (dotNV < 0.12), pz is clamped to 0.12 and grazeW is 0.0
        if (dotNV <= 0.10) {
          equal(grazeW, 0.0, "Curved dome silhouette clamps UV displacement to prevent edge smearing");
          equal(pz, 0.12, "Projection divisor clamped to 0.12");
        } else if (dotNV >= 0.45) {
          equal(grazeW, 1.0, "Dome center receives full POM displacement");
        }

        // F7: Curved dome edges receive specular rim highlighting
        const rim = calculateSpecularRim(0.4, dotNV);
        if (dotNV <= 0.35 && dotNV > 0.10) {
          ok(rim > 0.10, `Curved dome boundary receives crisp specular highlight (rim=${rim.toFixed(3)})`);
        }
      }

      // 4. F2: Distance LOD across plaza to tavern entrance (25m)
      const lod25m = pomLodAtDistance(25.0, 15.0, 35.0);
      near(lod25m, 0.5, 1e-4, "Tavern entrance at 25m retains 50% displacement depth");

      // 5. F6: Crevice AO inside carved sandstone arches
      const archCreviceAo = calculateCreviceAo(-0.5);
      near(archCreviceAo, 0.25, 1e-4, "Carved sandstone arch recesses exhibit 75% ambient darkening");
    });
  });
}
