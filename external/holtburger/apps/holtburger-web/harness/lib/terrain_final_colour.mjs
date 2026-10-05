// harness/lib/terrain_final_colour.mjs — the terrain fragment's FINAL colour
// statement, as the shader writes it today.
//
// WHY (2026-10-05). Five terrain wave suites (snow, ice, sand sparkle, dirt,
// volcano) each pinned the final write with the same byte-exact regex:
//
//     fragColor = vec4(modulated * ndotl * cloudShadow * csmShadow + iblSpec
//                      + sandSparkle * cloudShadow * csmShadow, 1.0);
//
// Two later, deliberate changes broke that text without changing the maths:
//   * the shadowed multiply moved into the SHARED lighting tail
//     (scene3d/terrain_shared_glsl.js `terrainApplyLight`, so the far
//     composite ring provably runs the same expression), and retail range fog
//     wraps the result (`terrainApplyFog`, an identity when scene.fog is null);
//   * the FAR COMPOSITE RING albedo bake (2026-08-02) added ONE early
//     `if (uBakeAlbedo > 0.5) { fragColor = vec4(modulated, 1.0); return; }`
//     — uBakeAlbedo is 0.0 in every shipped frame.
// The suites' intent ("no wave term was spliced into the final colour; every
// term rides `modulated` / `iblSpec` / `sandSparkle`") is what this checks,
// against the real structure — once, here, instead of five drifting copies.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The expected statements, whitespace-normalised. */
export const TERRAIN_LIT_STMT =
  "vec3 terrainLit = terrainApplyLight(modulated, ndotl, cloudShadow, csmShadow) + iblSpec + sandSparkle * cloudShadow * csmShadow;";
export const FINAL_FRAGCOLOR_STMT = "fragColor = vec4(terrainApplyFog(terrainLit, vViewDepth), 1.0);";
export const BAKE_EARLY_RETURN_STMT = "if (uBakeAlbedo > 0.5) { fragColor = vec4(modulated, 1.0); return; }";

const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * @param {string} frag  the TERRAIN_FRAGMENT_GLSL body
 * @returns {{ok: boolean, why: string, finalBlock: string}}
 *   finalBlock = the source from `vec3 terrainLit =` to the end of main(),
 *   for callers that also assert no wave-specific identifier appears in it.
 */
export function checkTerrainFinalColour(frag) {
  const iLit = frag.indexOf("vec3 terrainLit =");
  if (iLit < 0) return { ok: false, why: "no `vec3 terrainLit =` statement", finalBlock: "" };
  const finalBlock = frag.slice(iLit, frag.indexOf("\n}", iLit));
  const flat = norm(finalBlock);
  const withoutComments = norm(finalBlock.replace(/\/\/[^\n]*/g, ""));
  if (!withoutComments.startsWith(TERRAIN_LIT_STMT)) {
    return { ok: false, why: `terrainLit statement drifted: ${JSON.stringify(flat.slice(0, 200))}`, finalBlock };
  }
  if (!withoutComments.endsWith(FINAL_FRAGCOLOR_STMT)) {
    return { ok: false, why: `final fragColor statement drifted: ${JSON.stringify(flat.slice(-160))}`, finalBlock };
  }
  const writes = (frag.match(/fragColor = vec4\(/g) || []).length;
  if (writes !== 2 || !norm(frag).includes(BAKE_EARLY_RETURN_STMT)) {
    return { ok: false, why: `expected exactly the final write + the uBakeAlbedo early return, got ${writes} writes`, finalBlock };
  }
  // The shared tail's multiply must still be the original maths.
  const tail = readFileSync(resolve(APP_ROOT, "scene3d/terrain_shared_glsl.js"), "utf8");
  if (!/vec3 terrainApplyLight\(vec3 albedo, float ndotl, float cloudShadow, float csmShadow\) \{\s*return albedo \* ndotl \* cloudShadow \* csmShadow;\s*\}/.test(tail)) {
    return { ok: false, why: "terrainApplyLight no longer returns albedo * ndotl * cloudShadow * csmShadow", finalBlock };
  }
  return { ok: true, why: "", finalBlock };
}
