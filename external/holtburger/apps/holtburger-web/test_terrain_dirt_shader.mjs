// test_terrain_dirt_shader.mjs — the MUD PRINT + WET MUD injection into the
// TERRAIN fragment shader (Wave 3B, plan §3.7 items 2 + 4).
//
// This is wave 3's only edit to the terrain fragment shader, so it is also the
// test that the water agent's 2026-07-31 work and the wave-1B/2A/2B blocks are
// not regressed. Structure and technique mirror `test_terrain_water.mjs` /
// `test_terrain_sand_sparkle.mjs` / `test_terrain_volcano_shader.mjs`: slice the
// two GLSL template literals out of `scene3d/terrain.js` and assert on the
// source (no GPU needed), plus JS-side checks of the masks and the gates.
//
// Locks:
//   M1  Every mud uniform is DECLARED EXACTLY ONCE, in the FRAGMENT stage only
//       (a helper declared in one stage is invisible in the other — the bug that
//       once rendered the whole terrain black), and no backtick enters the GLSL.
//   M2  GATING FROM uVertexTypes (plan trap T3), through `isDirtCode()` /
//       `isClayCode()` helpers shaped exactly like `isWaterCode()` and reading
//       JS-built masks — never a hardcoded 5/7/8/24/31 range and never the
//       `terrainCode` geometry ATTRIBUTE. Clay is a STRICT SUBSET of dirt.
//   M3  NO new geometry attribute, so the `terrain_batch.js:650` whitelist is
//       untouched (trap T3, second half) and the batched GLSL anchors still hit.
//   M4  NO SECOND SAMPLER. The mud print reads the SAME trail `sampler2D` the
//       snow print binds; the shader's sampler count is unchanged by wave 3B.
//   M5  ORDERING (plan §2.7.3): the mud dent runs AFTER the POM march and AFTER
//       the snow dent, samples at the parallax-corrected point and shifts
//       `cellUv` along the same view vector; the wet sheen is computed after the
//       shadow terms and ADDED through `iblSpec`; every block honours the
//       `cellTouchesWater` bypass; the mid degrade (no POM) is darkening-only.
//   M6  THE SHARED `fragColor` STATEMENT IS BYTE-UNCHANGED — every wave-3B term
//       rides `iblSpec` or `modulated`, the established seams.
//   M7  STRICT NO-OP when off: two gate uniforms, both seeded from flags that
//       ship OFF, plus a second per-frame gate for the trail map.
//   M8  THE WETNESS CURVE IS `vfx/components/wetness.js`'s, REUSED: the same
//       `smoothstep(0.05, 0.6, up)` weight, the same 0.62 darken, the same 0.25
//       roughness drop, and the shared weight is one main()-scope local.
//   M9  NO WATER / SAND / SNOW / ICE / VOLCANO REGRESSION: every invariant those
//       suites lock is still present in the source next to the new code.
//   M10 The JS side binds every uniform and derives both masks from
//       `terrain_families.js`, agreeing with `terrain_dirt.js`.
//
// Run from apps/holtburger-web/:  node test_terrain_dirt_shader.mjs

import { readFileSync } from "node:fs";
import { dirtCodeBitmask, clayCodeBitmask } from "./scene3d/terrain_dirt.js";
import { FAM_DIRT, familyForCode } from "./scene3d/terrain_families.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const BATCH = readFileSync("./scene3d/terrain_batch.js", "utf8");
const WETNESS = readFileSync("./scene3d/vfx/components/wetness.js", "utf8");

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
const stripComments = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const FRAG_CODE = stripComments(FRAG);

const iPomMarch = FRAG.indexOf("cellUv += uvOff;");
const iSnowPrint = FRAG.indexOf("=== Wave 2A — SNOW FOOTPRINTS");
const iMudPrint = FRAG.indexOf("=== Wave 3B — MUD PRINTS");
const iWaterScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
const iDirtW = FRAG.indexOf("float dirtW = clamp(");
const iSnowDarken = FRAG.indexOf("=== Wave 2A — SNOW FOOTPRINT DARKENING");
const iMudDarken = FRAG.indexOf("=== Wave 3B — MUD PRINT DARKENING");
const iWetDarken = FRAG.indexOf("=== Wave 3B — WET MUD DARKENING");
const iIce = FRAG.indexOf("=== Wave 2A — ICE MATERIAL TREATMENT");
const iWetSheen = FRAG.indexOf("=== Wave 3B — WET MUD SHEEN");
const iSandSparkle = FRAG.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ===");
const iFragColor = FRAG.indexOf("fragColor = vec4(");
const MUD_PRINT_BLOCK = FRAG.slice(iMudPrint, iWaterScroll);
const WET_SHEEN_BLOCK = FRAG.slice(iWetSheen, iSandSparkle);
const MUD_PRINT_CODE = stripComments(MUD_PRINT_BLOCK);
const WET_SHEEN_CODE = stripComments(WET_SHEEN_BLOCK);

// ===========================================================================
console.log("\n-- M1 uniforms declared once, fragment stage only ---------------");
// ===========================================================================
const MUD_UNIFORMS = [
  ["uMudPrintEnabled", "float"],
  ["uMudTrailEnabled", "float"],
  ["uDirtCodeMask", "int"],
  ["uClayCodeMask", "int"],
  ["uMudPrintDepth", "float"],
  ["uMudPrintDarken", "float"],
  ["uMudPrintDryScale", "float"],
  ["uMudWetEnabled", "float"],
  ["uMudWetness", "float"],
  ["uMudWetStrength", "float"],
  ["uMudWetDarken", "float"],
  ["uMudWetRoughDrop", "float"],
  ["uMudBaseRough", "float"],
  ["uMudWetSpec", "float"],
  ["uMudWetEnv", "float"],
  ["uClayWetTint", "vec3"],
  ["uClayWetGloss", "float"],
];
for (const [name, type] of MUD_UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1, String(countOf(FRAG, `uniform ${type} ${name};`)));
  check(`${name} is NOT declared in the vertex stage`, !VERT.includes(`uniform ${type} ${name};`));
}
check("no backticks anywhere in the fragment GLSL (they close the JS literal)",
  !FRAG.includes("`"));
check("no backticks anywhere in the vertex GLSL", !VERT.includes("`"));
check("no NEW sampler was declared by wave 3B",
  !FRAG.includes("uMudTrailMap") && !/uniform sampler2D uMud/.test(FRAG));

// ===========================================================================
console.log("\n-- M2 gating from uVertexTypes; clay is a strict subset ---------");
// ===========================================================================
check("isDirtCode() exists and reads uDirtCodeMask",
  /bool isDirtCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uDirtCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("isClayCode() exists and reads uClayCodeMask",
  /bool isClayCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uClayCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("isDirtCode is shaped exactly like isWaterCode",
  FRAG.includes("(uWaterSurfaceCodeMask & (1 << c)) != 0")
  && FRAG.includes("(uDirtCodeMask & (1 << c)) != 0"));
check("the corner codes come from vertexTypeAt (uVertexTypes), not the attribute",
  MUD_PRINT_CODE.includes("cellTouchesDirt") && FRAG_CODE.includes("bool cellTouchesDirt = isDirtCode(t00)"));
check("the fragment stage never reads the terrainCode ATTRIBUTE (trap T3)",
  !/\bin float terrainCode\b/.test(FRAG) && !/\bvTerrainCodeAttr\b/.test(FRAG));
check("dirtW is bilinear over the SAME four corner weights the blend uses",
  /float dirtW = clamp\(\s*\n\s*\(isDirtCode\(t00\) \? w00 : 0\.0\)/.test(FRAG));
check("clayW is bilinear over the same four weights",
  /float clayW = clamp\(\s*\n\s*\(isClayCode\(t00\) \? w00 : 0\.0\)/.test(FRAG));
check("dirtW / clayW are computed BEFORE the darkening that consumes them",
  iDirtW > 0 && iDirtW < iMudDarken);
// The JS-side masks.
check("the dirt mask is {5,7,8,24,31}",
  dirtCodeBitmask() === (((1 << 5) | (1 << 7) | (1 << 8) | (1 << 24) | (1 << 31)) >>> 0));
check("every set bit really is FAM_DIRT",
  Array.from({ length: 32 }, (_, c) => c)
    .filter((c) => (dirtCodeBitmask() >>> 0) & (1 << c))
    .every((c) => familyForCode(c) === FAM_DIRT));
check("the clay mask is bit 24 alone", clayCodeBitmask() === (1 << 24) >>> 0);
check("clay is a STRICT SUBSET of dirt",
  (clayCodeBitmask() & dirtCodeBitmask()) === clayCodeBitmask()
  && clayCodeBitmask() !== dirtCodeBitmask());
check("terrain.js derives TERRAIN_DIRT_CODES from familyForCode, not a literal",
  SRC.includes("if (familyForCode(c) === FAM_DIRT) s.add(c)")
  && !/TERRAIN_DIRT_CODES = Object\.freeze\(\s*new Set\(\[/.test(SRC));
check("terrain.js derives TERRAIN_CLAY_CODES by FILTERING the dirt set",
  SRC.includes("for (const c of TERRAIN_DIRT_CODES) if (c === 24) s.add(c)"));
check("terrain.js records the shared-RenderSurface trap (plan §2.7.2)",
  SRC.includes("BarrenRock (0)") && SRC.includes("Argila (24)"));

// ===========================================================================
console.log("\n-- M3 no new geometry attribute --------------------------------");
// ===========================================================================
check("the terrain_batch attribute whitelist is untouched",
  BATCH.includes('["position", "normal", "terrainCode"]'));
check("wave 3B added no `attribute`/`in` to the terrain vertex stage",
  !/\bin (float|vec[234]) (aMud|aDirt|aClay)/.test(VERT)
  && !/setAttribute\("(aMud|aDirt|aClay)/.test(SRC));

// ===========================================================================
console.log("\n-- M4 the trail sampler is SHARED, not duplicated ---------------");
// ===========================================================================
check("uSnowTrailMap is still the ONLY trail sampler2D", countOf(FRAG, "uniform sampler2D uSnowTrailMap;") === 1);
check("the mud print samples THAT sampler", MUD_PRINT_CODE.includes("texture(uSnowTrailMap, mudUv)"));
check("the mud print uses the shared centre + radius",
  MUD_PRINT_CODE.includes("uSnowTrailCenter") && MUD_PRINT_CODE.includes("uSnowTrailRadius"));
check("the mud print gates on its OWN float, not snow's",
  MUD_PRINT_CODE.includes("uMudTrailEnabled > 0.5") && !MUD_PRINT_CODE.includes("uSnowTrailEnabled"));
check("the total sampler count is unchanged by wave 3B (15, none added)",
  countOf(FRAG, "uniform sampler") + countOf(FRAG, "uniform highp sampler") === 15,
  String(countOf(FRAG, "uniform sampler") + countOf(FRAG, "uniform highp sampler")));
check("the uniform block explains the shared-sampler naming",
  FRAG.includes("THE TRAIL SAMPLER IS SHARED"));
check("an off-map UV yields NO trail (never a clamped smear)",
  /if \(mudUv\.x >= 0\.0 && mudUv\.x <= 1\.0 && mudUv\.y >= 0\.0 && mudUv\.y <= 1\.0\)/.test(MUD_PRINT_CODE));

// ===========================================================================
console.log("\n-- M5 ordering, POM registration, water bypass ------------------");
// ===========================================================================
check("the mud dent runs AFTER the POM march", iPomMarch > 0 && iPomMarch < iMudPrint);
check("the mud dent runs AFTER the snow dent (the two compose additively)",
  iSnowPrint > 0 && iSnowPrint < iMudPrint);
check("the mud dent runs BEFORE the water-scroll UV derivation (i.e. before any tap)",
  iMudPrint < iWaterScroll);
check("it samples at the PARALLAX-CORRECTED point (the post-march cellUv offset)",
  MUD_PRINT_CODE.includes("vec2 mudShift = (cellUv - vec2(fu, fv)) * 24.0;")
  && MUD_PRINT_CODE.includes("vec2 mudXy = vec2(vWorldPos.x, -vWorldPos.z) + mudShift;"));
check("the dent shifts cellUv along the SAME view-parallax vector POM marches",
  MUD_PRINT_CODE.includes("cellUv += (mvt.xy / max(-mvt.z, 0.3)) * (uMudPrintDepth * mudPrint);"));
check("the dent skips grazing rays exactly as the POM march does",
  MUD_PRINT_CODE.includes("if (mvt.z < -0.15)"));
check("the dent is INSIDE a uPomEnabled test (the mid degrade is darkening-only)",
  /if \(mudPrint > 0\.0 && uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd\)/.test(MUD_PRINT_CODE));
check("mudPrint is computed OUTSIDE that test, so the darkening survives POM-off",
  MUD_PRINT_CODE.indexOf("mudPrint = clamp(texture") < MUD_PRINT_CODE.indexOf("uPomEnabled > 0.5"));
check("the mud dent honours the cellTouchesWater bypass",
  MUD_PRINT_CODE.includes("cellTouchesDirt && !cellTouchesWater"));
check("the wet darkening honours it too",
  FRAG_CODE.includes("if (uMudWetEnabled > 0.5 && dirtW > 0.0 && !cellTouchesWater)"));
check("the wet sheen honours it too",
  WET_SHEEN_CODE.includes("!cellTouchesWater"));
check("the dent amplitude is well under uPomScale (0.012 vs 0.006)",
  SRC.includes("const DEFAULT_MUD_PRINT_DEPTH = 0.006;") && SRC.includes("uPomScale"));
check("the RAIN DEPENDENCE rides amplitude, not a second fade",
  MUD_PRINT_CODE.includes("mudPrint *= mix(uMudPrintDryScale, 1.0, clamp(uMudWetness, 0.0, 1.0));"));
check("the darkening is applied to `modulated` (pre cloud/CSM, no double-darken)",
  FRAG_CODE.includes("modulated *= mix(1.0, 1.0 - uMudPrintDarken, mudPrint * dirtW);"));
check("the print darkening sits right after the SNOW one",
  iSnowDarken > 0 && iSnowDarken < iMudDarken && iMudDarken < iWetDarken);
check("the sheen sits after the ICE treatment and before the SAND sparkle",
  iIce > 0 && iIce < iWetSheen && iWetSheen < iSandSparkle);
check("the sheen adds through iblSpec, never to albedo/cellUv/water",
  WET_SHEEN_CODE.includes("iblSpec += mudSpec * mudWetAmt;")
  && !/\bcellUv\b/.test(WET_SHEEN_CODE)
  && !/\bwaterCellUv\b|\bwaterW\b/.test(WET_SHEEN_CODE));
check("the sheen is OUTSIDE the uPbrEnabled block (retail Gouraud wins by default)",
  !/uPbrEnabled/.test(WET_SHEEN_CODE) && WET_SHEEN_CODE.includes("uIblEnabled > 0.5"));

// ===========================================================================
console.log("\n-- M6 the shared fragColor statement is BYTE-UNCHANGED ----------");
// ===========================================================================
const FRAG_COLOR_LINE = FRAG.slice(iFragColor, FRAG.indexOf("\n}", iFragColor));
check("fragColor is written exactly once", countOf(FRAG, "fragColor = vec4(") === 1);
check("the statement is byte-identical to the wave-2 one",
  FRAG_COLOR_LINE.replace(/\s+/g, " ").trim()
  === "fragColor = vec4(modulated * ndotl * cloudShadow * csmShadow + iblSpec + sandSparkle * cloudShadow * csmShadow, 1.0);",
  JSON.stringify(FRAG_COLOR_LINE));
check("no wave-3B term appears in the final colour statement",
  !/mud|Mud|clay|Clay|dirt|Dirt/.test(FRAG_COLOR_LINE));

// ===========================================================================
console.log("\n-- M7 strict no-op when off ------------------------------------");
// ===========================================================================
check("the print has TWO gates: the baked flag and the per-frame trail push",
  MUD_PRINT_CODE.includes("uMudPrintEnabled > 0.5 && uMudTrailEnabled > 0.5"));
check("the darkening re-tests the flag", FRAG_CODE.includes("if (uMudPrintEnabled > 0.5 && mudPrint > 0.0"));
check("the wetness has its OWN gate, independent of the print",
  FRAG_CODE.includes("uMudWetEnabled > 0.5"));
check("both accumulators start at zero",
  FRAG_CODE.includes("float mudPrint = 0.0;") && FRAG_CODE.includes("float mudWetAmt = 0.0;"));
check("uMudPrintEnabled is seeded from the composed flags in resolveTerrainRingOpts",
  SRC.includes("mudPrintEnabled: terrainDirtEnabled() && terrainMudPrintsEnabled(),"));
check("uMudWetEnabled is seeded from the composed flags",
  SRC.includes("mudWetnessEnabled: terrainDirtEnabled() && terrainMudWetnessEnabled(),"));
check("both gates are seeded 0.0 when the flag is absent",
  SRC.includes("uMudPrintEnabled: { value: opts.mudPrintEnabled ? 1.0 : 0.0 }")
  && SRC.includes("uMudWetEnabled: { value: opts.mudWetnessEnabled ? 1.0 : 0.0 }"));
check("uMudTrailEnabled and uMudWetness are seeded INERT (pushed per frame)",
  SRC.includes("uMudTrailEnabled: { value: 0.0 }") && SRC.includes("uMudWetness: { value: 0.0 }"));
check("the flags reach terrain.js through their own import statement",
  SRC.includes('import { terrainDirtEnabled, terrainMudPrintsEnabled, terrainMudWetnessEnabled } from "./vfx_flags.js";'));
check("the wave-1B one-line sand import is untouched (its suite locks that form)",
  SRC.includes('import { terrainSandEnabled, terrainSandSparkleEnabled } from "./vfx_flags.js";'));

// ===========================================================================
console.log("\n-- M8 the wetness.js response curve is REUSED, not re-invented --");
// ===========================================================================
check("wetness.js still has the curve this block copies",
  WETNESS.includes("smoothstep( 0.05, 0.6, vVfxWorldNormal.y )")
  && WETNESS.includes("darken: 0.62") && WETNESS.includes("roughDrop: 0.25"));
check("the same up-facing weight, with AC geomN.z for world normal.y",
  FRAG_CODE.includes("float mudWetUp = smoothstep(0.05, 0.6, geomN.z);"));
check("the same clamp(wetness * strength) * up product",
  FRAG_CODE.includes("mudWetAmt = clamp(uMudWetness * uMudWetStrength, 0.0, 1.0) * mudWetUp * dirtW;"));
check("the same mix(1, darken, amt) diffuse form",
  FRAG_CODE.includes("mix(vec3(1.0), vec3(uMudWetDarken)"));
check("the same mix(1, roughDrop, amt) roughness form",
  WET_SHEEN_CODE.includes("uMudBaseRough * mix(1.0, clayDrop, clamp(mudWetAmt, 0.0, 1.0))"));
check("the darken/roughDrop DEFAULTS are wetness.js's own numbers",
  SRC.includes("const DEFAULT_MUD_WET_DARKEN = 0.62;")
  && SRC.includes("const DEFAULT_MUD_WET_ROUGH_DROP = 0.25;")
  && SRC.includes("const DEFAULT_MUD_WET_STRENGTH = 1.0;"));
check("the shared weight is ONE main()-scope local, read by BOTH halves",
  countOf(FRAG_CODE, "float mudWetAmt = 0.0;") === 1
  && FRAG_CODE.includes("mudWetAmt > 0.0") && iWetDarken < iWetSheen);
check("the block cites the component it is reusing",
  FRAG.includes("vfx/components/wetness.js"));
check("CLAY goes redder in the darkening", FRAG_CODE.includes("mix(vec3(1.0), uClayWetTint, clayW)"));
check("CLAY goes slicker in the sheen",
  WET_SHEEN_CODE.includes("uMudWetRoughDrop * (1.0 - clamp(uClayWetGloss, 0.0, 1.0) * clayW)"));
check("wet mud is DAMP, not glazed: its gains sit under the ice treatment's",
  SRC.includes("const DEFAULT_MUD_WET_SPEC = 0.22;")
  && SRC.includes("const DEFAULT_MUD_WET_ENV = 0.28;")
  && SRC.includes("const DEFAULT_ICE_SPEC_STRENGTH = 0.55;"));
check("the sheen's surface noise is UNSCROLLED (mud does not flow)",
  WET_SHEEN_CODE.includes("fragValueNoise2D(muv)") && !/uTime/.test(WET_SHEEN_CODE));

// ===========================================================================
console.log("\n-- M9 no regression of the earlier waves ------------------------");
// ===========================================================================
check("WATER: the per-corner classification is intact",
  FRAG.includes("bool cellTouchesWater = wc00 || wc10 || wc01 || wc11;"));
check("WATER: POM still bypasses water-touching cells",
  FRAG.includes("if (uPomEnabled > 0.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater) {"));
check("WATER: the scroll UV is still derived post-POM",
  iPomMarch < iWaterScroll && FRAG.includes("vec2 waterCellUv = cellUv;"));
check("SAND: the grain sparkle block is intact", iSandSparkle > 0 && FRAG.includes("uSandSparkleEnabled > 0.5 && sandW > 0.0 && !cellTouchesWater"));
check("SNOW: the print dent and darkening are intact",
  FRAG.includes("uSnowPrintEnabled > 0.5 && uSnowTrailEnabled > 0.5")
  && FRAG.includes("modulated *= mix(1.0, 1.0 - uSnowPrintDarken, snowPrint * snowW);"));
check("SNOW: the crystal sparkle is intact", FRAG.includes("uSnowSparkleEnabled > 0.5 && snowW > 0.0 && !cellTouchesWater"));
check("ICE: the material treatment is intact", FRAG.includes("uIceEnabled > 0.5 && iceW > 0.0 && !cellTouchesWater"));
check("VOLCANO: the crack glow is intact", FRAG.includes("uCrackGlowEnabled > 0.5 && !cellTouchesWater"));
check("every earlier bilinear fraction is still computed",
  ["sandW", "snowW", "iceW", "volcW", "obsidianW", "waterW"]
    .every((w) => FRAG.includes(`float ${w} = clamp(`) || FRAG.includes(`float ${w} =`)));

// ===========================================================================
console.log("\n-- M10 the JS side binds everything -----------------------------");
// ===========================================================================
for (const [name] of MUD_UNIFORMS) {
  check(`${name} is bound in the material uniform bag`, SRC.includes(`${name}: {`));
}
check("the masks are bound through computeCodeBitmask of the DERIVED sets",
  SRC.includes("dirtCodeMask: computeCodeBitmask(TERRAIN_DIRT_CODES)")
  && SRC.includes("clayCodeMask: computeCodeBitmask(TERRAIN_CLAY_CODES)"));
check("the bound masks agree with terrain_dirt.js",
  SRC.includes("TERRAIN_DIRT_CODES") && dirtCodeBitmask() > 0 && clayCodeBitmask() > 0);
check("uClayWetTint is a real Vector3", SRC.includes("uClayWetTint: {") && SRC.includes("DEFAULT_CLAY_WET_TINT[0]"));
check("the uniform block documents the per-frame push (terrain_batch clones values)",
  SRC.includes("terrain_batch.js CLONES") || FRAG.includes("terrain_batch.js CLONES uniform"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
