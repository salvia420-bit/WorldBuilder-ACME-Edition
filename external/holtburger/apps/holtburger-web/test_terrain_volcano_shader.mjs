// test_terrain_volcano_shader.mjs — the VOLCANO CRACK GLOW + OBSIDIAN
// injection into the TERRAIN fragment shader (Wave 2B, plan §3.6 items 3 + 5).
//
// Deliberately a SEPARATE suite from `test_terrain_volcano.mjs`: the terrain
// fragment shader is the one file wave 2A (SNOW) and wave 2B (VOLCANO) both
// touch, so the shader edit and its test are one self-contained commit that
// rebases mechanically on top of 2A's snow sparkle.
//
// Structure and technique mirror `test_terrain_sand_sparkle.mjs` (which mirrors
// `test_terrain_water.mjs`): slice the two GLSL template literals out of
// `scene3d/terrain.js` and assert on the source — no GPU needed.
//
// Locks:
//   V1  Every volcano uniform is DECLARED EXACTLY ONCE, in the FRAGMENT stage
//       only, and the block is recompile-safe (it is part of the source string,
//       not a runtime patch, so there is nothing to double-apply).
//   V2  Gated on FAM_VOLCANO read from **uVertexTypes** (plan trap T3), through
//       `isVolcanoCode()` / `isObsidianCode()` helpers shaped exactly like
//       `isWaterCode()` and reading JS-built masks — never a hardcoded 6/25/26
//       range and never the `terrainCode` geometry ATTRIBUTE.
//   V3  NO new geometry attribute is added, so the `terrain_batch.js:650`
//       attribute whitelist is untouched and the batched GLSL rewrite anchors
//       still match.
//   V4  ORDERING (plan §2.7.3): the block is computed AFTER the POM march and
//       anchors its vein field to the PARALLAX-CORRECTED surface point; it
//       honours the `cellTouchesWater` bypass; and it is ADDED to `iblSpec`
//       rather than replacing anything — so the crack glow is EMISSIVE (not
//       shadow-multiplied: lava glows in shadow) and the final `fragColor`
//       line is BYTE-UNCHANGED.
//   V5  STRICT NO-OP when off: one gate uniform, seeded from two flags that
//       ship OFF, and each term is skipped when its bilinear fraction is 0.
//   V6  NO WATER REGRESSION and NO SAND REGRESSION: every invariant those two
//       suites lock is still present in the source next to the new code.
//   V7  The JS side binds every uniform, derives both masks from
//       `terrain_families.js` / the retail enum, and the masks agree with
//       `terrain_volcano.js`.
//   V8  The BREATH is pushed by `loop.js::tickTerrainUTime` (NOT bound by
//       reference), because `terrain_batch.js` clones uniform values and
//       `?terrainBatch` is default-ON.
//   V9  OBSIDIAN is code 6 alone and runs in BOTH shading modes — it is
//       deliberately NOT inside the `uPbrEnabled && !acGouraud` block, which
//       retail Gouraud (default-ON) wins and which is exactly the trap the
//       2026-07-31 water sheen fell into.
//
// Run from apps/holtburger-web/:  node test_terrain_volcano_shader.mjs

import { readFileSync } from "node:fs";
import { volcanoCodeBitmask, obsidianCodeBitmask, TERRAIN_CODE_OBSIDIAN_PLAIN }
  from "./scene3d/terrain_volcano.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const BATCH = readFileSync("./scene3d/terrain_batch.js", "utf8");
const LOOP = readFileSync("./scene3d/loop.js", "utf8");

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

// The MAIN block's marker. The uniform-declaration comment further up uses the
// dated `=== 2026-08-01 (Wave 2B) — …` form on purpose, so this substring
// matches exactly ONE site — the same trick `test_terrain_sand_sparkle.mjs`
// plays with `=== Wave 1B — SAND GRAIN SPARKLE ===`.
const MARKER = "=== Wave 2B — VOLCANO CRACK GLOW + OBSIDIAN ===";
const iPomMarch = FRAG.indexOf("cellUv += uvOff;");
const iWaterScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
const iWaterSheen = FRAG.indexOf("iblSpec += waterSpec * waterW * sheenFade;");
const iVolcW = FRAG.indexOf("float volcW = clamp(");
const iBlock = FRAG.indexOf(MARKER);
const iFragColor = FRAG.indexOf("fragColor = vec4(");
// The volcano block itself: marker → the end of its closing brace. Every "the
// block does not touch X" assertion is scoped to THIS, not the whole shader.
const VOLC_BLOCK = FRAG.slice(iBlock, FRAG.indexOf("// Clouds-L — cloud-shadow modulation", iBlock));

// ===========================================================================
console.log("\n-- V1 uniforms declared once, fragment stage only ----------------");
// ===========================================================================
const UNIFORMS = [
  ["uCrackGlowEnabled", "float"],
  ["uVolcanoCodeMask", "int"],
  ["uObsidianCodeMask", "int"],
  ["uCrackGlowStrength", "float"],
  ["uCrackGlowDensity", "float"],
  ["uCrackGlowWidth", "float"],
  ["uCrackGlowColor", "vec3"],
  ["uCrackGlowBreath", "float"],
  ["uCrackGlowFadeStart", "float"],
  ["uCrackGlowFadeEnd", "float"],
  ["uObsidianShininess", "float"],
  ["uObsidianSpecular", "float"],
  ["uObsidianEnv", "float"],
];
for (const [name, type] of UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1);
  check(`${name} is NOT declared in the vertex stage (no dead uniform)`,
    !VERT.includes(name));
}
check("no backticks anywhere in the fragment GLSL (they close the JS literal)",
  !FRAG.includes("`"));
check("the volcano block is part of the SHADER SOURCE, not a runtime patch "
  + "(recompile-safe by construction — nothing to double-apply)",
  countOf(FRAG, MARKER) === 1 && !SRC.includes("CRACK_GLOW_BEGIN"));

// ===========================================================================
console.log("\n-- V2 gated on FAM_VOLCANO from uVertexTypes (trap T3) ------------");
// ===========================================================================
check("isVolcanoCode() exists and reads uVolcanoCodeMask",
  /bool isVolcanoCode\(int c\) \{[\s\S]{0,200}uVolcanoCodeMask & \(1 << c\)/.test(FRAG));
check("isVolcanoCode() is shaped exactly like isWaterCode() (same bound, same mask test)",
  /bool isVolcanoCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uVolcanoCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("isObsidianCode() is the same shape against uObsidianCodeMask",
  /bool isObsidianCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uObsidianCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("the corner codes come from vertexTypeAt() — i.e. the 9x9 uVertexTypes "
  + "DataTexture, NOT the terrainCode attribute (trap T3)",
  /int t00 = vertexTypeAt\(/.test(FRAG) && /volcW = clamp\(/.test(FRAG)
  && /isVolcanoCode\(t00\)/.test(FRAG) && /isVolcanoCode\(t11\)/.test(FRAG));
check("the fragment stage never reads a terrainCode attribute",
  !/\bin float terrainCode\b/.test(FRAG) && !/\battribute float terrainCode\b/.test(FRAG));
check("the VERTEX stage still reads terrainCode (the water/lava branch is untouched)",
  /in float terrainCode;/.test(VERT));
check("no hardcoded volcano range anywhere in the fragment stage",
  !/c == 6 \|\| c == 25/.test(FRAG) && !/t00 == 25/.test(FRAG));
check("volcW uses the SAME four bilinear corner weights as the texture blend "
  + "(so it feathers at a type boundary instead of stepping — plan §8 risk 2)",
  /volcW = clamp\(\s*\n\s*\(isVolcanoCode\(t00\) \? w00 : 0\.0\) \+ \(isVolcanoCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isVolcanoCode\(t01\) \? w01 : 0\.0\) \+ \(isVolcanoCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));
check("obsidianW does the same, from the code-6-only mask",
  /obsidianW = clamp\(\s*\n\s*\(isObsidianCode\(t00\) \? w00 : 0\.0\)/.test(FRAG));
check("volcW/obsidianW are computed next to sandW and waterW, from the same "
  + "corner data (one gather, three fractions)",
  iVolcW > 0 && FRAG.indexOf("float sandW = clamp(") > 0
  && Math.abs(iVolcW - FRAG.indexOf("float sandW = clamp(")) < 1200);

// ===========================================================================
console.log("\n-- V3 no new geometry attribute → whitelist untouched -------------");
// ===========================================================================
check("terrain_batch.js still whitelists exactly [position, normal, terrainCode]",
  /\["position", "normal", "terrainCode"\]/.test(BATCH),
  "the crack glow adds NO attribute, so this line must not have changed");
check("the batched-GLSL rewrite anchors the crack glow could have broken are intact",
  BATCH.includes("uniform sampler2D uVertexTypes;")
  && BATCH.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);")
  && FRAG.includes("uniform sampler2D uVertexTypes;")
  && FRAG.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"));
check("the volcano block does not use uLbOriginXy (zeroed on the batched path)",
  !VOLC_BLOCK.includes("uLbOriginXy"));
check("the block adds no new varying either (nothing new crosses the stages)",
  countOf(VOLC_BLOCK, "\nin ") === 0 && countOf(VOLC_BLOCK, "\nout ") === 0);

// ===========================================================================
console.log("\n-- V4 ordering: POM offset, water bypass, emissive add ------------");
// ===========================================================================
check("the POM march, the water scroll, the water sheen and the block all exist",
  iPomMarch > 0 && iWaterScroll > 0 && iWaterSheen > 0 && iBlock > 0 && iFragColor > 0);
check("V4: the block is computed AFTER the POM march", iBlock > iPomMarch);
check("V4: … and after the post-POM water scroll derivation (no water reordering)",
  iBlock > iWaterScroll && iWaterScroll > iPomMarch);
check("V4: … and after the water sheen block (it never pre-empts water)",
  iBlock > iWaterSheen);
check("V4: … and before the final fragColor write", iBlock < iFragColor);
check("V4: the vein field is anchored to the PARALLAX-CORRECTED point "
  + "(the post-march cellUv offset is added back to the world position)",
  /vec2 pomShiftV = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG)
  && /vec2 groundXy = vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ pomShiftV;/.test(FRAG));
check("V4: the block HONOURS the cellTouchesWater bypass (the 07-31 water fix)",
  /uCrackGlowEnabled > 0\.5 && !cellTouchesWater && \(volcW > 0\.0 \|\| obsidianW > 0\.0\)/.test(FRAG));
check("V4: the crack glow is EMISSIVE — added to iblSpec, NOT multiplied by "
  + "cloudShadow/csmShadow (lava glows in shadow)",
  /iblSpec \+= uCrackGlowColor/.test(FRAG)
  && !/uCrackGlowColor[\s\S]{0,200}csmShadow/.test(VOLC_BLOCK));
check("V4: the obsidian specular is also added to iblSpec",
  /iblSpec \+= obsSpec \* obsidianW;/.test(FRAG));
check("V4: THE FINAL fragColor LINE IS BYTE-UNCHANGED (no new term there) — "
  + "which is also what keeps this rebasable next to wave 2A's sparkle",
  /fragColor = vec4\(modulated \* ndotl \* cloudShadow \* csmShadow \+ iblSpec\s*\n\s*\+ sandSparkle \* cloudShadow \* csmShadow, 1\.0\);/.test(FRAG));
check("V4: a distance fade exists (a high-frequency noise field aliases at range)",
  /crackFade = 1\.0 - smoothstep\(uCrackGlowFadeStart, uCrackGlowFadeEnd, vViewDepth\)/.test(FRAG));
check("V4: the veins are a RIDGED threshold (abs(2n-1) is 0 along the field's "
  + "mid-level contour, so the threshold draws LINES not blobs)",
  /float f1 = abs\(n1 \* 2\.0 - 1\.0\);/.test(FRAG)
  && /float vein = 1\.0 - smoothstep\(0\.0, uCrackGlowWidth, f1\);/.test(FRAG));
check("V4: two octaves, so the veins branch rather than run parallel",
  /fragValueNoise2D\(veinXy \* 2\.31 \+ vec2\(11\.7, 5\.3\)\)/.test(FRAG));
check("V4: the noise is the FRAGMENT-stage helper (fragValueNoise2D)",
  /float n1 = fragValueNoise2D\(veinXy\);/.test(FRAG));
check("V4: the glow is multiplied by the BREATH uniform",
  /uCrackGlowStrength \* vein \* volcW \* crackFade \* uCrackGlowBreath/.test(FRAG));
check("V4: the block never writes cellUv, waterCellUv or waterW",
  !/cellUv \+=|waterCellUv =|waterW =/.test(VOLC_BLOCK));
check("V4: the block never writes `modulated` or `result` (the albedo is left "
  + "alone so both texture arms keep their own black)",
  !/\bmodulated\s*[*+-]?=/.test(VOLC_BLOCK) && !/\bresult\s*[*+-]?=/.test(VOLC_BLOCK));

// ===========================================================================
console.log("\n-- V5 strict no-op when off --------------------------------------");
// ===========================================================================
check("ONE gate uniform guards the whole block",
  countOf(FRAG, "uCrackGlowEnabled > 0.5") === 1);
check("each term is additionally skipped when its own fraction is 0",
  /if \(volcW > 0\.0\) \{/.test(VOLC_BLOCK) && /if \(obsidianW > 0\.0\) \{/.test(VOLC_BLOCK));
check("the gate is composed from the family master AND the effect flag",
  /crackGlowEnabled: terrainVolcanoEnabled\(\) && terrainCrackGlowEnabled\(\),/.test(SRC));
check("terrain.js imports the flag readers from vfx_flags.js (no second reader)",
  /import \{ terrainVolcanoEnabled, terrainCrackGlowEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));
check("the wave-1B sand import line is UNTOUCHED (its own suite locks it)",
  /import \{ terrainSandEnabled, terrainSandSparkleEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));
check("the wireframe short-circuit carries the fields off, for shape parity",
  /crackGlowEnabled: false,\s*\n\s*volcanoCodeMask: 0,\s*\n\s*obsidianCodeMask: 0,/.test(SRC));

// ===========================================================================
console.log("\n-- V6 no water / sand regression ---------------------------------");
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
check("the SAND sparkle block is still present, still POM-corrected and still "
  + "shadow-multiplied (it is sunlight; the crack glow is not)",
  /=== Wave 1B — SAND GRAIN SPARKLE ===/.test(FRAG)
  && /vec2 pomShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG)
  && /sandSparkle \* cloudShadow \* csmShadow/.test(FRAG));
check("sandW is still computed from the four corner weights",
  /float sandW = clamp\(/.test(FRAG));
check("TERRAIN_LAVA_CODES is still the empty set and the vertex lava branch is "
  + "untouched (explicitly out of scope for this family)",
  /const TERRAIN_LAVA_CODES = new Set\(\[\]\);/.test(SRC)
  && /uLavaCodeMask/.test(VERT));

// ===========================================================================
console.log("\n-- V7 the JS binding ---------------------------------------------");
// ===========================================================================
for (const [name] of UNIFORMS) {
  check(`${name} is bound in the terrain ShaderMaterial`,
    new RegExp(`${name}: \\{`).test(SRC));
}
check("the volcano mask is DERIVED from terrain_families.js FAM_VOLCANO",
  /familyForCode\(c\) === FAM_VOLCANO/.test(SRC)
  && /volcanoCodeMask: computeCodeBitmask\(TERRAIN_VOLCANO_CODES\)/.test(SRC));
check("the obsidian mask is code 6 alone, named off the retail enum",
  /const TERRAIN_OBSIDIAN_CODES = Object\.freeze\(new Set\(\[6\]\)\);/.test(SRC)
  && /obsidianCodeMask: computeCodeBitmask\(TERRAIN_OBSIDIAN_CODES\)/.test(SRC));
check("the derived masks agree with terrain_volcano.js",
  volcanoCodeBitmask() === (((1 << 6) | (1 << 25) | (1 << 26)) >>> 0)
  && obsidianCodeBitmask() === (1 << TERRAIN_CODE_OBSIDIAN_PLAIN)
  && TERRAIN_CODE_OBSIDIAN_PLAIN === 6);
check("the constants are named, not magic numbers at the bind site",
  ["DEFAULT_CRACK_GLOW_STRENGTH", "DEFAULT_CRACK_GLOW_DENSITY",
    "DEFAULT_CRACK_GLOW_WIDTH", "DEFAULT_CRACK_GLOW_COLOR",
    "DEFAULT_CRACK_GLOW_BREATH", "DEFAULT_CRACK_GLOW_FADE_START",
    "DEFAULT_CRACK_GLOW_FADE_END", "DEFAULT_OBSIDIAN_SHININESS",
    "DEFAULT_OBSIDIAN_SPECULAR", "DEFAULT_OBSIDIAN_ENV"].every((k) => SRC.includes(k)));
check("the mid-tier degrade is coherent: nothing in the block requires POM",
  !VOLC_BLOCK.includes("uPomEnabled"));

// ===========================================================================
console.log("\n-- V8 the breath is PUSHED, not bound by reference ----------------");
// ===========================================================================
check("loop.js imports the oscillator name from terrain_volcano.js",
  /import \{ CRACK_GLOW_OSC_NAME \} from "\.\/terrain_volcano\.js";/.test(LOOP));
check("loop.js reads the registered channel through getOscillator",
  /getOscillator/.test(LOOP) && /getOscillator\(CRACK_GLOW_OSC_NAME\)/.test(LOOP));
check("loop.js PUSHES it onto every terrain material next to uTime",
  /mat\.uniforms\.uCrackGlowBreath\.value = breath;/.test(LOOP)
  && /for \(const mat of scene3d\.terrainMaterials\)/.test(LOOP));
check("an unregistered channel writes NOTHING (crack glow off ⇒ the uniform "
  + "keeps its shader default)",
  /const breath = breathOsc \? breathOsc\.value : undefined;/.test(LOOP)
  && /if \(breath !== undefined && mat\?\.uniforms\?\.uCrackGlowBreath\)/.test(LOOP));
check("V8: the PUSH is necessary — terrain_batch.js still CLONES uniform values "
  + "into fresh objects, so a by-reference binding would freeze on the "
  + "default-ON batched path",
  /uniforms\[name\] = \{ value: _cloneUniformValue\(u \? u\.value : null\) \};/.test(BATCH));

// ===========================================================================
console.log("\n-- V9 obsidian runs in BOTH shading modes -------------------------");
// ===========================================================================
check("V9: the obsidian term is OUTSIDE the uPbrEnabled && !acGouraud block "
  + "(retail Gouraud is default-ON and wins that test — the exact trap the "
  + "2026-07-31 water sheen fell into)",
  iBlock > FRAG.indexOf("if (uPbrEnabled > 0.5 && !acGouraud) {")
  && !VOLC_BLOCK.includes("acGouraud"));
check("V9: it is a TIGHT lobe (a high Blinn exponent = roughness down-down)",
  /pow\(clamp\(dot\(geomN, halfAcO\), 0\.0, 1\.0\), uObsidianShininess\)/.test(FRAG));
check("V9: … at LOW intensity (dark specular, not a white highlight)",
  /vec3 obsSpec = uAcSunColor \* \(obsLobe \* uObsidianSpecular\);/.test(FRAG));
check("V9: the env reflection is NEAR-MIRROR (low mip = glass, not stone)",
  /textureLod\(uEnvCube, reflO, 0\.5\)/.test(FRAG));
check("V9: the AC→three space bridge matches the water sheen's convention",
  /vec3 nWorldO = normalize\(vec3\(geomN\.x, geomN\.z, -geomN\.y\)\);/.test(FRAG));
check("V9: it is gated behind uIblEnabled like every other env read",
  /if \(uIblEnabled > 0\.5\) \{[\s\S]{0,400}reflO/.test(VOLC_BLOCK));

console.log(`\nterrain volcano shader: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
