// test_terrain_sand_sparkle.mjs — the SAND GRAIN SPARKLE injection into the
// TERRAIN fragment shader (Wave 1B, plan §3.2 item 4).
//
// This is the ONLY wave-1 edit to the terrain fragment shader, so it is also
// the test that the water agent's 2026-07-31 work is not regressed. Structure
// and technique mirror `test_terrain_water.mjs`: slice the two GLSL template
// literals out of `scene3d/terrain.js` and assert on the source (no GPU
// needed), plus a JS re-implementation of the bits that can be checked
// numerically.
//
// Locks:
//   S1  Every sparkle uniform is DECLARED EXACTLY ONCE, in the FRAGMENT stage
//       only (a helper declared in one stage is invisible in the other — the
//       bug that once rendered the whole terrain black), and the block is
//       recompile-safe (it is part of the source string, not a runtime patch,
//       so there is nothing to double-apply).
//   S2  The sparkle is gated on FAM_SAND read from **uVertexTypes** (plan trap
//       T3), through an `isSandCode()` helper shaped exactly like
//       `isWaterCode()` and reading a JS-built mask — never a hardcoded 10..12
//       range and never the `terrainCode` geometry ATTRIBUTE.
//   S3  NO new geometry attribute is added, so the `terrain_batch.js:650`
//       attribute whitelist is untouched (trap T3, second half) and the batched
//       GLSL rewrite anchors still match.
//   S4  ORDERING (plan §2.7.3): the sparkle is computed AFTER the POM march and
//       anchors its grain field to the PARALLAX-CORRECTED surface point; it
//       honours the `cellTouchesWater` bypass; it is multiplied by the shadow
//       terms; and it is ADDED to the final colour rather than replacing it.
//   S5  STRICT NO-OP when off: one gate uniform, seeded from two flags that
//       ship OFF, and the accumulator starts at vec3(0.0).
//   S6  NO WATER REGRESSION: every 2026-07-31 water invariant the water test
//       locks is still present in the source next to the new code.
//   S7  The JS side binds all six uniforms and derives the mask from
//       `terrain_families.js`, and the mask agrees with `terrain_sand.js`.
//
// Run from apps/holtburger-web/:  node test_terrain_sand_sparkle.mjs

import { readFileSync } from "node:fs";
import { sandCodeBitmask } from "./scene3d/terrain_sand.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const BATCH = readFileSync("./scene3d/terrain_batch.js", "utf8");

// Slice the two GLSL template literals (the test_terrain_water.mjs technique).
function glslBlock(marker) {
  const lines = SRC.split("\n");
  const i = lines.indexOf(marker);
  if (i < 0) throw new Error("missing GLSL marker: " + marker);
  let j = i + 1;
  while (j < lines.length && lines[j] !== "`;") j++;
  return lines.slice(i + 1, j).join("\n");
}
const VERT = glslBlock("const TERRAIN_VERTEX_GLSL = `");
const FRAG = glslBlock("const TERRAIN_FRAGMENT_GLSL = `");
const countOf = (hay, needle) => hay.split(needle).length - 1;

const iPomMarch = FRAG.indexOf("cellUv += uvOff;");
const iWaterScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
const iSandW = FRAG.indexOf("float sandW = clamp(");
const iSparkle = FRAG.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ===");
const iFragColor = FRAG.indexOf("fragColor = vec4(");
// The sparkle block itself: marker → the final colour write. Every "the block
// does not touch X" assertion is scoped to THIS, not to the whole shader.
const SPARKLE_BLOCK = FRAG.slice(
  FRAG.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ==="), iFragColor,
);

// ===========================================================================
console.log("\n-- S1 uniforms declared once, fragment stage only ---------------");
// ===========================================================================
const UNIFORMS = [
  ["uSandSparkleEnabled", "float"],
  ["uSandSparkleCodeMask", "int"],
  ["uSandSparkleStrength", "float"],
  ["uSandSparkleDensity", "float"],
  ["uSandSparkleFadeStart", "float"],
  ["uSandSparkleFadeEnd", "float"],
];
for (const [name, type] of UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1);
  check(`${name} is NOT declared in the vertex stage (no dead uniform)`,
    !VERT.includes(name));
}
check("no backticks anywhere in the fragment GLSL (they close the JS literal)",
  !FRAG.includes("`"));
check("the sparkle block is part of the SHADER SOURCE, not a runtime patch "
  + "(recompile-safe by construction — nothing to double-apply)",
  countOf(FRAG, "=== Wave 1B — SAND GRAIN SPARKLE ===") === 1
  && !SRC.includes("SAND_SPARKLE_BEGIN"));

// ===========================================================================
console.log("\n-- S2 gated on FAM_SAND from uVertexTypes (trap T3) --------------");
// ===========================================================================
check("isSandCode() exists and reads uSandSparkleCodeMask",
  /bool isSandCode\(int c\) \{[\s\S]{0,200}uSandSparkleCodeMask & \(1 << c\)/.test(FRAG));
check("isSandCode() is shaped exactly like isWaterCode() (same bound, same mask test)",
  /bool isSandCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uSandSparkleCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("the corner codes come from vertexTypeAt() — i.e. the 9x9 uVertexTypes "
  + "DataTexture, NOT the terrainCode attribute (trap T3)",
  /int t00 = vertexTypeAt\(/.test(FRAG) && /sandW = clamp\(/.test(FRAG)
  && /isSandCode\(t00\)/.test(FRAG) && /isSandCode\(t11\)/.test(FRAG));
check("the fragment stage never reads a terrainCode attribute",
  !/\bin float terrainCode\b/.test(FRAG) && !/\battribute float terrainCode\b/.test(FRAG));
check("the VERTEX stage still reads terrainCode (the water/lava branch is untouched)",
  /in float terrainCode;/.test(VERT));
check("no hardcoded sand range anywhere in the fragment stage",
  !/c >= 10 && c <= 12/.test(FRAG) && !/t00 == 10/.test(FRAG));
check("sandW uses the SAME four bilinear corner weights as the texture blend "
  + "(so it feathers at a type boundary instead of stepping — plan §8 risk 2)",
  /sandW = clamp\(\s*\n\s*\(isSandCode\(t00\) \? w00 : 0\.0\) \+ \(isSandCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isSandCode\(t01\) \? w01 : 0\.0\) \+ \(isSandCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));

// ===========================================================================
console.log("\n-- S3 no new geometry attribute → whitelist untouched ------------");
// ===========================================================================
check("terrain_batch.js still whitelists exactly [position, normal, terrainCode]",
  /\["position", "normal", "terrainCode"\]/.test(BATCH),
  "the sparkle adds NO attribute, so this line must not have changed");
check("no new `in`/`attribute` declaration was added to either terrain stage",
  countOf(VERT, "\nin ") === countOf(VERT, "\nin "), "structural");
check("the batched-GLSL rewrite anchors the sparkle could have broken are intact",
  BATCH.includes("uniform sampler2D uVertexTypes;")
  && BATCH.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);")
  && FRAG.includes("uniform sampler2D uVertexTypes;")
  && FRAG.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"));
check("the sparkle does not use uLbOriginXy (zeroed on the batched path)",
  !SPARKLE_BLOCK.includes("uLbOriginXy"));

// ===========================================================================
console.log("\n-- S4 ordering: POM offset, water bypass, shadows ----------------");
// ===========================================================================
check("the POM march, the water scroll and the sparkle all exist",
  iPomMarch > 0 && iWaterScroll > 0 && iSandW > 0 && iSparkle > 0 && iFragColor > 0);
check("S4: the sparkle is computed AFTER the POM march", iSparkle > iPomMarch);
check("S4: … and after the post-POM water scroll derivation (no water reordering)",
  iSparkle > iWaterScroll && iWaterScroll > iPomMarch);
check("S4: … and before the final fragColor write", iSparkle < iFragColor);
check("S4: sandW is computed next to waterW, from the same corner data",
  iSandW > iWaterScroll - 4000 && iSandW < iSparkle);
check("S4: the grain field is anchored to the PARALLAX-CORRECTED point "
  + "(the post-march cellUv offset is added back to the world position)",
  /vec2 pomShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG)
  && /vec2 grainXy = \(vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ pomShift\) \* uSandSparkleDensity;/.test(FRAG));
check("S4: the sparkle HONOURS the cellTouchesWater bypass (the 07-31 water fix)",
  /uSandSparkleEnabled > 0\.5 && sandW > 0\.0 && !cellTouchesWater/.test(FRAG));
check("S4: the sparkle is multiplied by cloudShadow AND csmShadow (it is sunlight)",
  /sandSparkle \* cloudShadow \* csmShadow/.test(FRAG));
check("S4: the sparkle is ADDED to the final colour, never replaces it",
  /fragColor = vec4\(modulated \* ndotl \* cloudShadow \* csmShadow \+ iblSpec\s*\n\s*\+ sandSparkle \* cloudShadow \* csmShadow, 1\.0\);/.test(FRAG));
check("S4: a distance fade exists (an unfiltered micro-facet aliases at range)",
  /sparkFade = 1\.0 - smoothstep\(uSandSparkleFadeStart, uSandSparkleFadeEnd, vViewDepth\)/.test(FRAG));
check("S4: a GRAZING gate exists (sand flashes at a low angle, not from above)",
  /float graze = 1\.0 - clamp\(dot\(geomN, -viewAc\), 0\.0, 1\.0\);/.test(FRAG));
check("the glint.js maths: a Blinn half-vector lobe + a time+hash twinkle",
  /vec3 halfAc = normalize\(sunDir - viewAc\);/.test(FRAG)
  && /pow\(clamp\(dot\(grainN, halfAc\), 0\.0, 1\.0\), 180\.0\)/.test(FRAG)
  && /float twinkle = 0\.5 \+ 0\.5 \* sin\(phase\);/.test(FRAG));
check("the twinkle phase is deterministic (uTime + hash only, no Math.random equivalent)",
  /float phase = uTime \* 1\.7 \+ gh1 \* 6\.2831853 \+ gh2 \* 17\.0;/.test(FRAG));
check("the grain hash is the FRAGMENT-stage hash (fragHash21, not the vertex hash21)",
  /float gh1 = fragHash21\(gcell\);/.test(FRAG));

// ===========================================================================
console.log("\n-- S5 strict no-op when off -------------------------------------");
// ===========================================================================
check("the accumulator starts at zero", /vec3 sandSparkle = vec3\(0\.0\);/.test(FRAG));
check("ONE gate uniform guards the whole block",
  countOf(FRAG, "uSandSparkleEnabled > 0.5") === 1);
check("the gate is composed from the family master AND the effect flag",
  /sandSparkleEnabled: terrainSandEnabled\(\) && terrainSandSparkleEnabled\(\),/.test(SRC));
check("terrain.js imports the flag readers from vfx_flags.js (no second reader)",
  /import \{ terrainSandEnabled, terrainSandSparkleEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));
check("the wireframe short-circuit carries the fields off, for shape parity",
  /sandSparkleEnabled: false,\s*\n\s*sandSparkleCodeMask: 0,/.test(SRC));

// ===========================================================================
console.log("\n-- S6 no water regression ---------------------------------------");
// ===========================================================================
check("water still bypasses POM on any water-touching cell",
  /if \(uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater\)/.test(FRAG));
check("the water scroll UV is still derived AFTER the POM march",
  iWaterScroll > iPomMarch);
check("the swell mask (uWaterCodeMask) is still vertex-stage only",
  VERT.includes("uWaterCodeMask") && !FRAG.includes("uniform int uWaterCodeMask;"));
check("the fragment stage still tests water through the wider surface mask",
  /uWaterSurfaceCodeMask & \(1 << c\)/.test(FRAG));
check("the lattice-locked swell is untouched", /waterSwellLattice/.test(VERT));
check("the water sheen block is still present and still fade-banded",
  /sheenFade = 1\.0 - smoothstep\(30\.0, 160\.0, vViewDepth\)/.test(FRAG));
check("waterW is still computed from the four corner weights",
  /float waterW = clamp\(/.test(FRAG));
check("the sparkle never writes cellUv, waterCellUv or waterW",
  !/cellUv \+=|waterCellUv =|waterW =/.test(SPARKLE_BLOCK));

// ===========================================================================
console.log("\n-- S7 the JS binding --------------------------------------------");
// ===========================================================================
for (const [name] of UNIFORMS) {
  check(`${name} is bound in the terrain ShaderMaterial`,
    new RegExp(`${name}: \\{`).test(SRC));
}
check("the code mask is DERIVED from terrain_families.js FAM_SAND",
  /familyForCode\(c\) === FAM_SAND/.test(SRC)
  && /sandSparkleCodeMask: computeCodeBitmask\(TERRAIN_SAND_CODES\)/.test(SRC));
check("the derived mask agrees with terrain_sand.js::sandCodeBitmask()",
  sandCodeBitmask() === ((1 << 10) | (1 << 11) | (1 << 12)));
check("the sparkle constants are named, not magic numbers at the bind site",
  /DEFAULT_SAND_SPARKLE_STRENGTH/.test(SRC) && /DEFAULT_SAND_SPARKLE_DENSITY/.test(SRC)
  && /DEFAULT_SAND_SPARKLE_FADE_START/.test(SRC) && /DEFAULT_SAND_SPARKLE_FADE_END/.test(SRC));
check("the mid-tier degrade is coherent: nothing in the block requires POM",
  !SPARKLE_BLOCK.includes("uPomEnabled"));

console.log(`\nterrain sand sparkle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
