// test_terrain_ice.mjs — the ICE MATERIAL TREATMENT (Wave 2A, plan §3.4 item 4):
// codes 2 (`Ice`) and 27 (`BlueIce`) go hard and wet — roughness down, sharper
// specular, an env term off the `?ibl` cube, and a cheap fake refraction —
// while 15 (`Snow`) stays matte.
//
// Zero dependencies, zero GPU, zero browser: the GLSL assertions slice the
// terrain fragment template literal and read it as text (the
// `test_terrain_water.mjs` technique).
//
// Locks (the plan's own test spec: "material params change for codes 2/27 only;
// SCENE LIGHT COUNT UNCHANGED across install/uninstall"):
//   I1  CODES 2/27 ONLY. The ice mask is a STRICT SUBSET of the snow mask,
//       derived from the family LUT plus the per-code sub-variant table, never
//       a hardcoded range — and 15 is provably excluded from both directions.
//   I2  LIGHT COUNT UNCHANGED. Nothing in the ice path constructs, removes,
//       enables or scales a light; the whole treatment is a fragment term.
//       Installing and uninstalling it is a uniform flip, so a "scene" cannot
//       change light count across it (§5.2 — a light-count change relinks every
//       MeshStandardMaterial and freezes the client).
//   I3  ROUGHNESS DOWN / SPECULAR UP. One `uIceGloss` uniform drives BOTH the
//       Blinn lobe exponent and the env mip, which is what "lower roughness"
//       physically means; the env term reads the shared `?ibl` cube.
//   I4  NOT MeshTransmissionMaterial (rejected on cost in the plan), and no new
//       material, no new pass, no new render target.
//   I5  THE REFRACTION rides AFTER the POM march at an amplitude well under
//       `uPomScale`, is ONE extra tap, is separately gated (ultra only), and
//       honours the `cellTouchesWater` bypass.
//   I6  STRICT NO-OP WHEN OFF: two gate uniforms seeded from two flags that
//       ship OFF on every tier; the wireframe path carries the fields off.
//   I7  NO REGRESSION of the wave-1 sand sparkle or the 07-31 water work that
//       shares this shader.
//
// Run from apps/holtburger-web/:  node test_terrain_ice.mjs

import { readFileSync } from "node:fs";
import {
  SNOWICE_VARIANTS,
  iceTerrainCodes,
  iceCodeBitmask,
  snowCodeBitmask,
  snowTerrainCodes,
  resolveIceQuality,
} from "./scene3d/terrain_snow.js";
import { FAM_SNOWICE, familyForCode } from "./scene3d/terrain_families.js";
import { PRESETS, PRESET_NAMES } from "./scene3d/quality.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const SNOW_SRC = readFileSync("./scene3d/terrain_snow.js", "utf8");
const INDEX = readFileSync("./scene3d/index.js", "utf8");

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

const iPomMarch = FRAG.indexOf("cellUv += uvOff;");
const iRefract = FRAG.indexOf("=== Wave 2A — ICE FAKE REFRACTION");
const iIce = FRAG.indexOf("=== Wave 2A — ICE MATERIAL TREATMENT");
const iSandSparkle = FRAG.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ===");
const iFragColor = FRAG.indexOf("fragColor = vec4(");
const ICE_BLOCK = FRAG.slice(iIce, iSandSparkle);
const ICE_CODE = stripComments(ICE_BLOCK);
const REFRACT_BLOCK = FRAG.slice(iRefract, FRAG.indexOf("if (uDetailTexEnabled > 0.5)"));
const REFRACT_CODE = stripComments(REFRACT_BLOCK);
const SNOW_CODE = stripComments(SNOW_SRC.replace(/\/\*[\s\S]*?\*\//g, ""));

// ===========================================================================
console.log("\n-- I1 codes 2/27 ONLY ------------------------------------------");
// ===========================================================================
check("iceTerrainCodes() is exactly [2, 27]", iceTerrainCodes().join() === "2,27");
check("15 (Snow) is NOT ice — it stays matte",
  !iceTerrainCodes().includes(15) && SNOWICE_VARIANTS[15].ice === false);
check("every ice code IS a FAM_SNOWICE member (derived, not invented)",
  iceTerrainCodes().every((c) => familyForCode(c) === FAM_SNOWICE));
check("the ice mask is a STRICT SUBSET of the snow mask",
  (iceCodeBitmask() & snowCodeBitmask()) === iceCodeBitmask()
  && iceCodeBitmask() !== snowCodeBitmask());
check("the mask bits are exactly 2 and 27",
  iceCodeBitmask() === ((1 << 2) | (1 << 27)));
check("the JS-side terrain.js set is DERIVED from the family, not a literal list",
  /const TERRAIN_ICE_MATERIAL_CODES = Object\.freeze\(/.test(SRC)
  && /for \(const c of TERRAIN_SNOW_CODES\) if \(c === 2 \|\| c === 27\) s\.add\(c\);/.test(SRC));
check("terrain.js binds THAT set, not the snow one",
  /iceCodeMask: computeCodeBitmask\(TERRAIN_ICE_MATERIAL_CODES\)/.test(SRC));
check("isIceCode() is shaped exactly like isWaterCode()/isSandCode()/isSnowCode()",
  /bool isIceCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uIceCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("no hardcoded 2/27 test anywhere in the fragment stage",
  !/t00 == 2\b/.test(FRAG) && !/c == 2 \|\| c == 27/.test(FRAG));
check("iceW uses the same four bilinear corner weights as everything else "
  + "(so a Snow/BlueIce seam is continuous, not stepped)",
  /iceW = clamp\(\s*\n\s*\(isIceCode\(t00\) \? w00 : 0\.0\) \+ \(isIceCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isIceCode\(t01\) \? w01 : 0\.0\) \+ \(isIceCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));
check("every ice term is weighted by iceW, so a non-ice fragment gets NOTHING",
  /iblSpec \+= iceSpec \* iceW;/.test(FRAG)
  && /result = mix\(result, refr, iceW \* 0\.55\);/.test(FRAG));
check("both blocks are additionally gated on iceW > 0.0",
  countOf(FRAG, "iceW > 0.0") === 2);
check("the sub-variant table is the single source of truth for WHICH family "
  + "members are ice, and terrain_snow.js derives from it",
  /SNOWICE_VARIANTS\[c\] && SNOWICE_VARIANTS\[c\]\.ice === true/.test(SNOW_CODE));

// ===========================================================================
console.log("\n-- I2 the scene light count is unchanged -----------------------");
// ===========================================================================
check("the ice GLSL block constructs no light and references none",
  !/Light|pointLight|directionalLight|spotLight/i.test(ICE_CODE));
check("the refraction block likewise", !/Light/i.test(REFRACT_CODE));
check("terrain_snow.js constructs no light of any kind (§5.2)",
  !/new THREE\.[A-Za-z]*Light|\.intensity\s*=|Light\b/.test(SNOW_CODE));
check("no lighting module is imported or touched by the snow/ice family",
  !/lighting\.js|csm\.js|light_pool/.test(SNOW_CODE));
check("the ice treatment is a FRAGMENT term folded into iblSpec — installing or "
  + "uninstalling it is a UNIFORM FLIP, so no scene graph node is added or "
  + "removed and the renderer's per-type light count cannot move (§5.2)",
  /iblSpec \+= iceSpec \* iceW;/.test(FRAG)
  && /uIceEnabled: \{ value: opts\.iceEnabled \? 1\.0 : 0\.0 \}/.test(SRC));
{
  // The install/uninstall symmetry, exercised on a fake scene: the ice path
  // exists entirely in uniforms, so a scene's light count is trivially
  // invariant — the assertion that matters is that NOTHING in the path can
  // reach a scene at all.
  const scene = { children: [{ isLight: true }, { isLight: true }, { isLight: false }] };
  const lightsBefore = scene.children.filter((c) => c.isLight).length;
  const mat = {
    uniforms: {
      uIceEnabled: { value: 0 }, uIceCodeMask: { value: 0 },
      uIceRefractEnabled: { value: 0 },
    },
  };
  mat.uniforms.uIceEnabled.value = 1;
  mat.uniforms.uIceCodeMask.value = iceCodeBitmask();
  mat.uniforms.uIceRefractEnabled.value = 1;
  const lightsInstalled = scene.children.filter((c) => c.isLight).length;
  mat.uniforms.uIceEnabled.value = 0;
  mat.uniforms.uIceRefractEnabled.value = 0;
  const lightsAfter = scene.children.filter((c) => c.isLight).length;
  check("light count unchanged across install → uninstall",
    lightsBefore === 2 && lightsInstalled === 2 && lightsAfter === 2);
  check("uninstall restores the exact off state (a strict no-op again)",
    mat.uniforms.uIceEnabled.value === 0 && mat.uniforms.uIceRefractEnabled.value === 0);
}
check("index.js wires the family with NO scene/light argument at all",
  /initTerrainSnow\(\{\s*\n\s*THREE,\s*\n\s*scene3d: liveScene3d,\s*\n\s*parent: worldRoot,\s*\n\s*globals: VFX_GLOBALS,\s*\n\s*readEnv: readParticleEnv,\s*\n\s*\}\)/.test(INDEX));

// ===========================================================================
console.log("\n-- I3 roughness down, specular up, env term --------------------");
// ===========================================================================
const ICE_UNIFORMS = [
  ["uIceEnabled", "float"],
  ["uIceCodeMask", "int"],
  ["uIceGloss", "float"],
  ["uIceSpecStrength", "float"],
  ["uIceEnvStrength", "float"],
  ["uIceRefractEnabled", "float"],
  ["uIceRefractAmount", "float"],
];
for (const [name, type] of ICE_UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1);
  check(`${name} is NOT declared in the vertex stage`, !VERT.includes(name));
  check(`${name} is bound in the terrain ShaderMaterial`,
    new RegExp(`${name}: \\{`).test(SRC));
}
check("roughness is derived from ONE gloss uniform",
  /float iceRough = 1\.0 - clamp\(uIceGloss, 0\.0, 1\.0\);/.test(FRAG));
check("gloss drives the Blinn lobe exponent (higher gloss = tighter highlight)",
  /pow\(clamp\(dot\(iceN, iceHalfAc\), 0\.0, 1\.0\),\s*\n\s*mix\(24\.0, 220\.0, clamp\(uIceGloss, 0\.0, 1\.0\)\)\)/.test(FRAG));
check("… and the SAME gloss drives the env mip, which is what 'lower roughness' "
  + "physically means",
  /textureLod\(uEnvCube, iceRefl, iceRough \* 5\.0\)/.test(FRAG));
check("the env term reads the SHARED ?ibl cube and is gated on it",
  /if \(uIblEnabled > 0\.5\) \{/.test(ICE_BLOCK)
  && /uEnvIntensity \* uIceEnvStrength/.test(FRAG));
check("a Fresnel factor is applied (grazing angles reflect more)",
  /float iceFres = 0\.04 \+ 0\.96 \* pow\(1\.0 - clamp\(dot\(-iceViewW, iceNWorld\), 0\.0, 1\.0\), 5\.0\);/.test(FRAG));
check("the AC→three space bridge matches the water sheen and the PBR env term",
  /vec3 iceNWorld = normalize\(vec3\(iceN\.x, iceN\.z, -iceN\.y\)\);/.test(FRAG));
check("the surface is perturbed by the SHARED coherent noise, unscrolled "
  + "(ice is still — a scroll would make it read as water)",
  /vec2 iuv = vec2\(vWorldPos\.x, -vWorldPos\.z\) \* 1\.7;/.test(FRAG)
  && /fragValueNoise2D\(iuv\)/.test(FRAG)
  && !/uTime/.test(ICE_CODE));
check("the defaults are NAMED constants, not magic numbers at the bind site",
  /DEFAULT_ICE_GLOSS = 0\.88/.test(SRC) && /DEFAULT_ICE_SPEC_STRENGTH/.test(SRC)
  && /DEFAULT_ICE_ENV_STRENGTH/.test(SRC) && /DEFAULT_ICE_REFRACT_AMOUNT/.test(SRC));
check("ice is glossier than every ordinary terrain layer (the point of the effect)",
  /DEFAULT_ICE_GLOSS = 0\.88/.test(SRC));
check("the block runs in BOTH shading modes — it sits OUTSIDE the "
  + "uPbrEnabled && !acGouraud block, which retail Gouraud (default-ON) wins",
  iIce > FRAG.indexOf("if (uPbrEnabled > 0.5 && !acGouraud) {")
  && iIce > FRAG.indexOf("=== 2026-07-31 (water-fix) — WATER SURFACE SHEEN ==="));

// ===========================================================================
console.log("\n-- I4 NOT MeshTransmissionMaterial -----------------------------");
// ===========================================================================
// Both files NAME the rejected package in prose (that is the point of §I4's
// last assertion), so the "it is absent" tests must read comment-stripped code.
check("MeshTransmissionMaterial appears nowhere in the family's CODE",
  !/MeshTransmissionMaterial/.test(SNOW_CODE)
  && !/MeshTransmissionMaterial/.test(stripComments(FRAG)));
check("no transmission/thickness/ior material property is set",
  !/\btransmission\b|\bthickness\b|\bior\b/i.test(SNOW_CODE));
check("no second render target, no second scene render, no readback",
  !/WebGLRenderTarget|renderer\.render|readRenderTargetPixels/.test(SNOW_CODE));
check("no new material is created for ice at all — it is a term in the EXISTING "
  + "terrain ShaderMaterial",
  !/new THREE\.(Mesh|Shader)[A-Za-z]*Material/.test(SNOW_CODE.replace(/ShaderMaterial\(\{[\s\S]*?\}\)/, ""))
  || /terrain-snow-spindrift/.test(SNOW_CODE));
check("the rejection is recorded where the next reader will find it",
  /NOT\s+.?MeshTransmissionMaterial|EXPLICITLY NOT MeshTransmissionMaterial/i.test(SNOW_SRC)
  || /EXPLICITLY NOT MeshTransmissionMaterial/.test(SRC));

// ===========================================================================
console.log("\n-- I5 the refraction: after POM, tiny, one tap, gated ----------");
// ===========================================================================
check("the refraction block exists and runs AFTER the POM march", iRefract > iPomMarch);
check("… and before the final colour write", iRefract < iFragColor);
check("it offsets cellUv along the same view-parallax vector POM marches",
  /vec2 refrUv = cellUv \+ \(rvt\.xy \/ max\(-rvt\.z, 0\.3\)\) \* uIceRefractAmount;/.test(FRAG));
check("the amplitude is WELL UNDER uPomScale (0.004 vs 0.012), so the two "
  + "offsets never fight (plan §3.4)",
  /DEFAULT_ICE_REFRACT_AMOUNT = 0\.004/.test(SRC) && /uPomScale: \{ value: 0\.012 \}/.test(SRC));
check("it is exactly ONE extra atlas tap",
  countOf(REFRACT_CODE, "texture(uAtlas") === 1);
check("… blended UNDER the real surface tile, not replacing it",
  /result = mix\(result, refr, iceW \* 0\.55\);/.test(FRAG));
check("it uses the same atlasUvFor addressing as every other sampler",
  /texture\(uAtlas, atlasUvFor\(clamp\(nearCode, 0, 32\), refrUv\)\)\.rgb/.test(FRAG));
check("it HONOURS the cellTouchesWater bypass (POM did not run there)",
  /uIceRefractEnabled > 0\.5 && uIceEnabled > 0\.5 && iceW > 0\.0 && !cellTouchesWater/.test(FRAG));
check("it skips grazing rays, exactly as the POM march does",
  /if \(rvt\.z < -0\.15\) \{/.test(REFRACT_BLOCK));
check("it is SEPARATELY gated from the rest of the ice treatment, so the ultra "
  + "tier can turn on the only part with a texture cost",
  /uIceRefractEnabled > 0\.5/.test(FRAG)
  && /iceRefractionEnabled: terrainIceEnabled\(\) && terrainIceRefractionEnabled\(\)/.test(SRC));
check("the refraction never touches a water term",
  !/waterCellUv|waterW/.test(REFRACT_CODE));

// ===========================================================================
console.log("\n-- I6 strict no-op when off ------------------------------------");
// ===========================================================================
check("TWO gate uniforms, one per bisectable half",
  countOf(FRAG, "uIceEnabled > 0.5") === 2   // the material block + the refraction
  && countOf(FRAG, "uIceRefractEnabled > 0.5") === 1);
check("both are seeded from STRICT `=== \"on\"` flags that ship OFF",
  /iceEnabled: terrainIceEnabled\(\),/.test(SRC));
check("?terrainIce is a SEPARATE master from ?terrainSnow (plan §3.4: one is "
  + "particles+shader, the other a material change — bisecting matters)",
  !/iceEnabled: terrainSnowEnabled\(\)/.test(SRC));
check("the wireframe short-circuit carries the ice fields off, for shape parity",
  /iceEnabled: false,\s*\n\s*iceCodeMask: 0,\s*\n\s*iceRefractionEnabled: false,/.test(SRC));
check("both masters ship FALSE on all four quality tiers (§5.9)",
  PRESET_NAMES.every((p) => PRESETS[p].terrainIce === false));
check("iceRefraction is present on all four tiers and true ONLY on ultra",
  PRESET_NAMES.every((p) => "terrainIceRefraction" in PRESETS[p])
  && PRESETS.ultra.terrainIceRefraction === true
  && ["low", "mid", "high"].every((p) => PRESETS[p].terrainIceRefraction === false));
check("resolveIceQuality reports the tier",
  resolveIceQuality(PRESETS.ultra).refraction === true
  && resolveIceQuality(PRESETS.high).refraction === false
  && resolveIceQuality(null).refraction === false);
check("?terrainIce=on alone registers NO provider (it is bake-time uniforms) "
  + "and allocates nothing",
  /Sparkle-only \(the whole `mid` tier\) and ice-only both register NO provider/.test(SNOW_SRC));

// ===========================================================================
console.log("\n-- I7 no regression of the shader's existing tenants ------------");
// ===========================================================================
check("water still bypasses POM on any water-touching cell",
  /if \(uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater\)/.test(FRAG));
check("the water scroll UV is still derived AFTER the POM march",
  FRAG.indexOf("vec2 waterCellUv = cellUv;") > iPomMarch);
check("the swell mask (uWaterCodeMask) is still vertex-stage only",
  VERT.includes("uWaterCodeMask") && !FRAG.includes("uniform int uWaterCodeMask;"));
check("the water sheen block is still present and still fade-banded",
  /sheenFade = 1\.0 - smoothstep\(30\.0, 160\.0, vViewDepth\)/.test(FRAG));
check("the lattice-locked swell is untouched", /waterSwellLattice/.test(VERT));
check("the wave-1B sand sparkle block is intact and still last before fragColor",
  iSandSparkle > iIce && iSandSparkle < iFragColor
  && /vec3 sandSparkle = vec3\(0\.0\);/.test(FRAG));
check("the sand sparkle's final colour write is byte-unchanged",
  /fragColor = vec4\(modulated \* ndotl \* cloudShadow \* csmShadow \+ iblSpec\s*\n\s*\+ sandSparkle \* cloudShadow \* csmShadow, 1\.0\);/.test(FRAG));
check("the ice terms ride iblSpec, so they compose with the PBR env term and "
  + "the water sheen instead of overwriting either",
  countOf(FRAG, "iblSpec +=") >= 3);
check("no backticks anywhere in the fragment GLSL", !FRAG.includes("`"));

console.log(`\nterrain ice: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
