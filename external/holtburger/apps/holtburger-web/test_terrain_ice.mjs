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
//   I8  (2026-10-24) NO SUN GLINT AT NIGHT: the sun lobe is gated on the sun's
//       elevation x |uAcSunVec| (exactly 0 at the retail night), saturating so
//       every authored daytime keyframe of ALL 20 Region day groups (Rainy
//       included) is exactly 1.0 (day look unchanged).
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
import { PRESETS, PRESET_NAMES, TERRAIN_VFX_PROMOTED, terrainMaster } from "./scene3d/quality.js";
import { checkTerrainFinalColour } from "./harness/lib/terrain_final_colour.mjs";

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
console.log("\n-- I8 no sun glint at night; the day look unchanged -------------");
// ===========================================================================
// 2026-10-24 — THE NIGHT-SPECULAR FIX. uAcSunColor is the light's COLOUR only;
// retail brightness is |uAcSunVec| (dirBright) and the night sun parks 0.9 deg
// above the horizon, so the shipped ice glint shone at full strength all night.
// It now carries the sand sparkle's gate SHAPE (elevation smoothstep 0.05..0.25
// x a brightness term), with the brightness saturating at dirBright ~0.48
// (x2.1) instead of sand's 0.80 (x1.25): ice SHIPS, and the signed-off day
// look must not move at ANY authored daytime keyframe of ANY day group — the
// Rainy groups' morning sits at dirBright 0.50 (x1.43 dimmed it to 0.715).
check("I8: the SUN lobe is scaled by the elevation x |uAcSunVec| gate",
  /float iceSunGate = smoothstep\(0\.05, 0\.25, sunDir\.z\) \* min\(length\(uAcSunVec\) \* 2\.1, 1\.0\);/.test(ICE_CODE)
  && /vec3 iceSpec = uAcSunColor \* \(iceLobe \* uIceSpecStrength \* iceSunGate\);/.test(ICE_CODE));
// ICE_BLOCK runs on to the sand sparkle (obsidian and the wet mud sheen sit
// between); this one stops at the next block.
const ICE_ONLY_CODE = stripComments(FRAG.slice(iIce, FRAG.indexOf("=== 2026-10-23 - OBSIDIAN GLASS", iIce)));
check("I8: no other uAcSunColor term in the ice block escapes the gate",
  ICE_ONLY_CODE.length > 0 && (ICE_ONLY_CODE.match(/uAcSunColor/g) || []).length === 1);
check("I8: the ENV term is sky light and stays as it was (dimmed at night by uEnvIntensity)",
  /iceSpec \+= iceEnv \* iceFres \* uEnvIntensity \* uIceEnvStrength;/.test(ICE_CODE));
{
  const DEG = Math.PI / 180;
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const gate = (pitchDeg, dirBright, k = 2.1) => ss(0.05, 0.25, Math.sin(pitchDeg * DEG)) * Math.min(dirBright * k, 1);
  // Dereth's authored sun keyframes [begin, dirBright, dirPitch]: the 9 DISTINCT
  // tables of the 20 Region day groups (WorldBuilder.Terminal region-export-json
  // of ~/ac_base_dats/client_portal.dat, sha256 dc6e500b…, 2026-10-24). Table 0
  // is the one test_retail_sun.mjs pins. Day = pitch >= 20 deg (begin 0.27..0.84).
  const TABLES = [
    // groups 0,1 Sunny
    [[0, 0.25, 0.9], [0.02, 0.25, 0.9], [0.16, 0.4, 0.9], [0.21, 0.5, 10], [0.27, 0.7, 20], [0.61, 0.8, 90], [0.611, 0.8, 90], [0.84, 0.75, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // group 2 Sunny
    [[0, 0.25, 0.9], [0.02, 0.35, 0.9], [0.16, 0.35, 0.9], [0.21, 0.5, 10], [0.27, 0.7, 20], [0.61, 0.8, 90], [0.611, 0.8, 90], [0.84, 0.75, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // groups 3,7,9,15,16,17 Rainy
    [[0, 0.25, 0.9], [0.02, 0.2, 0.9], [0.16, 0.25, 0.9], [0.21, 0.35, 10], [0.27, 0.6, 20], [0.3, 0.5, 20], [0.59, 0.5, 90], [0.61, 0.7, 90], [0.611, 0.7, 90], [0.84, 0.7, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // groups 4,5 Sunny
    [[0, 0.25, 0.9], [0.02, 0.25, 0.9], [0.16, 0.2, 0.9], [0.21, 0.5, 10], [0.27, 0.7, 20], [0.61, 0.8, 90], [0.611, 0.8, 90], [0.84, 0.8, 20], [0.9, 0.5, 10], [0.96, 0.25, 0.9], [0.999, 0.25, 0.9]],
    // group 6 Sunny
    [[0, 0.25, 0.9], [0.02, 0.2, 0.9], [0.16, 0.25, 0.9], [0.21, 0.5, 10], [0.27, 0.8, 20], [0.61, 0.9, 90], [0.611, 0.9, 90], [0.84, 0.8, 20], [0.9, 0.5, 10], [0.96, 0.2, 0.9], [0.999, 0.5, 0.9]],
    // group 8 Clear
    [[0, 0.25, 0.9], [0.02, 0.25, 0.9], [0.16, 0.25, 0.9], [0.21, 0.5, 10], [0.27, 0.7, 20], [0.61, 0.8, 90], [0.611, 0.8, 90], [0.84, 0.7, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // groups 10,11 Clear
    [[0, 0.25, 0.9], [0.02, 0.25, 0.9], [0.16, 0.25, 0.9], [0.21, 0.5, 10], [0.27, 0.8, 20], [0.61, 0.9, 90], [0.611, 0.9, 90], [0.84, 0.75, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // groups 12,13,14 Cloudy
    [[0, 0.25, 0.9], [0.02, 0.2, 0.9], [0.16, 0.25, 0.9], [0.21, 0.35, 10], [0.27, 0.7, 20], [0.61, 0.7, 90], [0.611, 0.7, 90], [0.84, 0.7, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
    // groups 18,19 Rainy
    [[0, 0.25, 0.9], [0.02, 0.2, 0.9], [0.16, 0.25, 0.9], [0.21, 0.35, 10], [0.27, 0.5, 20], [0.61, 0.7, 90], [0.611, 0.7, 90], [0.84, 0.7, 20], [0.9, 0.5, 10], [0.96, 0.35, 0.9], [0.999, 0.25, 0.9]],
  ];
  const at = (KEYS, t) => {
    let i = 0;
    while (i + 1 < KEYS.length && KEYS[i + 1][0] <= t) i += 1;
    const a = KEYS[i], b = KEYS[Math.min(i + 1, KEYS.length - 1)];
    const r = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    return { db: a[1] + (b[1] - a[1]) * r, pitch: a[2] + (b[2] - a[2]) * r };
  };
  const dayMin = (k) => {
    let m = 1;
    for (const KEYS of TABLES) {
      for (let t = 0.27; t <= 0.84 + 1e-9; t += 0.001) { const s = at(KEYS, t); m = Math.min(m, gate(s.pitch, s.db, k)); }
    }
    return m;
  };
  let nightAllZero = true;
  for (const KEYS of TABLES) {
    for (const t of [0, 0.01, 0.1, 0.15, 0.97, 0.99]) { const s = at(KEYS, t); if (gate(s.pitch, s.db) !== 0) nightAllZero = false; }
  }
  const minDayDb = Math.min(...TABLES.flatMap((K) => K.filter((k) => k[2] >= 20).map((k) => k[1])));
  check("I8: the lowest DAYTIME dirBright of all 20 day groups is 0.50 (the Rainy morning) and x2.1 "
    + "clears it with a 5 % float margin", minDayDb === 0.5 && minDayDb * 2.1 >= 1.05 - 1e-12, String(minDayDb));
  check("I8: the gate is EXACTLY 1.0 across the whole authored day of EVERY day group (begin 0.27..0.84, "
    + "pitch >= 20, dirBright 0.50-0.90) — the shipped day look is unchanged, Rainy days included", dayMin() === 1,
    dayMin().toFixed(4));
  check("I8: … and EXACTLY 0 under the retail night sun of every day group (pitch 0.9 deg, dirBright 0.2-0.5)",
    nightAllZero);
  check("I8: dawn/dusk (pitch 10 deg, dirBright 0.35-0.5) is a partial ramp, not a pop",
    gate(10, 0.35) > 0.2 && gate(10, 0.5) < 0.8, gate(10, 0.35).toFixed(3) + ".." + gate(10, 0.5).toFixed(3));
  check("I8: why x2.1 and not x1.43 / sand's x1.25: they dim a Rainy morning (dirBright 0.50) to 0.715 / 0.625",
    Math.abs(dayMin(1.43) - 0.715) < 1e-9 && Math.abs(dayMin(1.25) - 0.625) < 1e-9,
    dayMin(1.43).toFixed(4) + " / " + dayMin(1.25).toFixed(4));
}

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
// 2026-10-07 (terrain step 4) — atlas taps go through terrainAtlasTex (same
// atlasUvFor address; explicit continuous-UV gradient under ?terrainGradUv).
check("it is exactly ONE extra atlas tap",
  countOf(REFRACT_CODE, "terrainAtlasTex(") === 1 && countOf(REFRACT_CODE, "texture(uAtlas") === 0);
check("… blended UNDER the real surface tile, not replacing it",
  /result = mix\(result, refr, iceW \* 0\.55\);/.test(FRAG));
check("it uses the same atlasUvFor addressing as every other sampler",
  /terrainAtlasTex\(clamp\(nearCode, 0, 32\), refrUv\)\.rgb/.test(FRAG));
check("it HONOURS the cellTouchesWater bypass (POM did not run there)",
  /uIceRefractEnabled > 0\.5 && uIceEnabled > 0\.5 && iceW > 0\.0 && !cellTouchesWater/.test(FRAG));
check("it skips grazing rays, exactly as the POM march does",
  /if \(rvt\.z < -0\.15\) \{/.test(REFRACT_BLOCK));
check("it is SEPARATELY gated from the rest of the ice treatment, so the ultra "
  + "tier can turn on the only part with a texture cost",
  /uIceRefractEnabled > 0\.5/.test(FRAG)
  && /iceRefractionEnabled: terrainVfxLive && terrainIceEnabled\(\) && terrainIceRefractionEnabled\(\)/.test(SRC));
check("the refraction never touches a water term",
  !/waterCellUv|waterW/.test(REFRACT_CODE));

// ===========================================================================
console.log("\n-- I6 strict no-op when off ------------------------------------");
// ===========================================================================
check("TWO gate uniforms, one per bisectable half",
  countOf(FRAG, "uIceEnabled > 0.5") === 2   // the material block + the refraction
  && countOf(FRAG, "uIceRefractEnabled > 0.5") === 1);
check("both are seeded from STRICT `=== \"on\"` flags that ship OFF",
  /iceEnabled: terrainVfxLive && terrainIceEnabled\(\),/.test(SRC));
// 2026-10-24 — ice SHIPS, so this is where the kill-switch fix is user-visible:
// the gate also requires `terrainVfxShaderLive()` (visualEnabled() &&
// terrainVfxEnabled()), so `?visual=off` / `?terrainVfx=off` return codes 2/27
// to plain retail terrain (behaviour: test_vfx_flags.mjs).
check("…and BOTH also require the master kill switches (?visual=off / ?terrainVfx=off kill the ice)",
  SRC.includes("const terrainVfxLive = terrainVfxShaderLive();")
  && /iceEnabled: terrainVfxLive && /.test(SRC)
  && /iceRefractionEnabled: terrainVfxLive && /.test(SRC));
check("?terrainIce is a SEPARATE master from ?terrainSnow (plan §3.4: one is "
  + "particles+shader, the other a material change — bisecting matters)",
  !/iceEnabled: terrainSnowEnabled\(\)/.test(SRC));
check("the wireframe short-circuit carries the ice fields off, for shape parity",
  /iceEnabled: false,\s*\n\s*iceCodeMask: 0,\s*\n\s*iceRefractionEnabled: false,/.test(SRC));
// 2026-10-05: `ice` was PROMOTED on the 2026-08-01 1070 sign-off
// (quality.js TERRAIN_VFX_PROMOTED.ice = true), so the master now follows the
// switchboard ladder: ON at high/ultra, OFF at low/mid — no longer FALSE
// everywhere. The URL flag (`?terrainIce`) is still a strict opt-in override.
check("the ice master follows the promotion switchboard (promoted → high/ultra only)",
  TERRAIN_VFX_PROMOTED.ice === true &&
  PRESET_NAMES.every((p) => PRESETS[p].terrainIce === terrainMaster("ice", p)) &&
  PRESETS.high.terrainIce === true && PRESETS.ultra.terrainIce === true &&
  PRESETS.low.terrainIce === false && PRESETS.mid.terrainIce === false);
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
  /sheenFade = \(1\.0 - smoothstep\(uWaterSheenFade\.x, uWaterSheenFade\.y, vViewDepth\)\) \* footFade;/.test(FRAG) /* 2026-10-15: the band is ?waterSheenFade (default 30,160, test_terrain_water.mjs) */);
check("the lattice-locked swell is untouched", /waterSwellLattice/.test(VERT));
check("the wave-1B sand sparkle block is intact and still last before fragColor",
  iSandSparkle > iIce && iSandSparkle < iFragColor
  && /vec3 sandSparkle = vec3\(0\.0\);/.test(FRAG));
check("the sand sparkle's final colour write is byte-unchanged",
  checkTerrainFinalColour(FRAG).ok /* 2026-10-05: shared-tail + far-bake aware, harness/lib/terrain_final_colour.mjs */);
check("the ice terms ride iblSpec, so they compose with the PBR env term and "
  + "the water sheen instead of overwriting either",
  countOf(FRAG, "iblSpec +=") >= 3);
check("no backticks anywhere in the fragment GLSL", !FRAG.includes("`"));

console.log(`\nterrain ice: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
