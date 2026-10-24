// test_terrain_snow.mjs — the SNOW family (Wave 2A, plan §3.4 items 1/2/3):
// slope-biased spindrift ribbons, the terrain-shader crystal sparkle, and
// persistent footprints through the shared trail map.
//
// Zero dependencies, zero GPU, zero browser. The GLSL assertions slice the
// template literals out of the source and read them as text (the
// `test_terrain_water.mjs` / `test_terrain_sand_sparkle.mjs` technique); the
// behavioural assertions drive the real module headless (no THREE — the pool
// and the field are both first-class in that mode).
//
// Locks:
//   N1  SPARKLE GLSL HYGIENE. Every snow/print/ice uniform is declared EXACTLY
//       ONCE, in the FRAGMENT stage only, and no backtick ever enters the GLSL.
//   N2  THE CLOCK. The sparkle rides the terrain shader's single `uTime` (one
//       declaration, driven by `loop.js::tickTerrainUTime` off the same
//       `frameTime.tsSec` VFX_GLOBALS.uTime is) and introduces NO second clock
//       uniform; the SPINDRIFT material binds `VFX_GLOBALS.uTime` BY IDENTITY,
//       the `test_vfx_glint.mjs` assertion.
//   N3  WORLD-SPACE HASH. The sparkle's per-crystal hash is a function of the
//       WORLD position (POM-corrected), never of an instance, and there is no
//       `vVfxHash` in the terrain fragment stage to fall back on.
//   N4  EMISSIVE ONLY. The sparkle block writes no albedo, no cellUv, no water
//       term — it only adds into `iblSpec` — and it never varies a program key
//       or adds a light.
//   N5  GATING FROM uVertexTypes (trap T3) and NO NEW GEOMETRY ATTRIBUTE, so
//       the `terrain_batch.js:650` whitelist is untouched.
//   N6  ORDERING (plan §2.7.3): the print dent runs right after the POM march
//       and shifts cellUv; the sparkle is computed after the march and anchors
//       its field to the parallax-corrected point; both honour the
//       `cellTouchesWater` bypass; the MID degrade (no POM) is darkening-only,
//       not broken.
//   N7  STRICT NO-OP WHEN OFF: one gate uniform per effect, all seeded from
//       flags that ship OFF.
//   N8  SLOPE BIAS is a pure, deterministic probability curve in `1 - normal.z`
//       with a flat-ground floor, and the pool honours it through `accept`.
//   N9  SPINDRIFT ADVECTION is a pure function of (wind, clock, hash) and the
//       GLSL computes the same expression the JS twin does.
//   N10 WEATHER: spindrift intensifies while it is SNOWING, using the same
//       cold+storm rule `weather/manager.js::_selectPrecip` uses, and this
//       module never duplicates falling snow.
//   N11 FOOTPRINTS: player-only stamps; an ABSENT trail map drives the uniform
//       to 0 with NO lazy-ensure; the push reaches every terrain material
//       (including the batched one) and skips pre-Wave-2A materials.
//   N12 FIREWALL + INVARIANTS over the module source (§5.2/§5.3/§5.4/§5.5).
//   N13 FLAGS + TIERS: six strict ship-OFF opt-ins, keys on all four tiers, in
//       the right coercion sets, and the DEFAULT-ON effect count is still the suite's own (16 since the 2026-10-10 per-weapon rows).
//   N14 THE 2026-10-23 LOOK PASS: the pink triangles are the passability
//       overlay, not snow; SNOW EXPOSURE (parity between the terrain fragment,
//       the spindrift vertex stage and the JS twin; powder only; bake-safe;
//       strict no-op off); the point glint (screen-Jacobian core, footprint
//       fade, direct sun); the cold print + sun-side relief (one tap, same
//       sampler); the lit, normal-blended axial-billboard spindrift; the
//       live knobs. 2026-10-24: the exposure ramp is 0.25 -> 0.6 in all three
//       copies (the GLSL literal is derived from SNOW_EXPOSURE_RAMP) and retail
//       noon reaches the full day scale (the old 0.85 top was unreachable:
//       ~0.66 weight); the reset-fallback tables mirror terrain.js
//       DEFAULT_SNOW_* and the SNOW_TUNING fields a fresh field is seeded from.
//   N15 tune({reset:true}) END TO END through the real spine + providers: knobs
//       tuned before the field or any terrain material existed are restored
//       (originals are recorded lazily at first application, shipped values
//       otherwise). Runs LAST: it installs a URL and clears it again.
//   N16 THE GUST PULSE NEVER RACES (2026-10-24; runs just before N15). The
//       pulse scroll was 'dir * (uTime * uPulseScroll)', whose derivative
//       carries uTime * scroll * d(dir)/dt: under the calm wind's +-12 deg /
//       45 s direction wander the ropes swept sideways ever faster with
//       session age. A 3600 s session under the REAL wind
//       (weather_inputs.js::writeWindVector) evaluates the spindrift GLSL's OWN
//       'pulseXy' line on the field's live uniforms: the per-frame pattern step
//       at a fixed world point stays <= dt x scroll (the old line, through the
//       same machinery, must race in the same session); at a constant
//       direction the step is exactly the old one; a long frame is clamped.
//       Fails on the pre-fix module (the GLSL line itself is the racing form).
//   N17 uTravel WRAPS SEAMLESSLY (2026-10-24 verifier; runs just before N15):
//       the rest of the rock grit fix. Ribbon speeds are k/64
//       (spindriftSpeedMul), the GLSL's own advection line is unchanged across
//       a wrap for every k, uTravel stays in [0, wrap) through a 3600 s real-
//       wind session with every live ribbon's step bounded across each wrap,
//       and a float32 model of that line 24 h in keeps the per-frame step to
//       within 0.5 cm (the unwrapped accumulator, same model, is off by >5 cm).
//
// Run from apps/holtburger-web/:  node test_terrain_snow.mjs

import { readFileSync } from "node:fs";
import {
  SNOW_TUNING,
  SNOWICE_VARIANTS,
  SNOW_SPINDRIFT_VERTEX_GLSL,
  SNOW_SPINDRIFT_FRAGMENT_GLSL,
  SNOW_SPINDRIFT_SCHEMA,
  SNOW_RECOMMENDED_FADE_SEC,
  SPINDRIFT_FLAT_KEEP,
  SPINDRIFT_PROVIDER_ID,
  PRINT_PROVIDER_ID,
  snowTerrainCodes,
  snowCodeBitmask,
  iceTerrainCodes,
  resolveSnowQuality,
  snowfallIntensity,
  spindriftKeep,
  spindriftAdvect,
  windAcFromGlobals,
  createSpindriftField,
  pushSnowTrailUniforms,
  SNOW_EXPOSURE_DAY,
  SNOW_EXPOSURE_RAMP,
  SNOW_TERRAIN_TUNE_KEYS,
  snowExposureScale,
  applySnowTerrainTuning,
  copyTerrainLighting,
  tuneTerrainSnow,
  SNOW_TERRAIN_TUNE_DEFAULTS,
  SPINDRIFT_TUNE_KEYS,
  SPINDRIFT_TUNE_FIELDS,
  snowTuneShippedValue,
  snowExposureShipped,
  initTerrainSnow,
  _resetTerrainSnow,
} from "./scene3d/terrain_snow.js";
// The 2026-10-24 exports, read off the NAMESPACE so this suite still links
// against a pre-fix module and the N16 regression fails on its merits there.
import * as SNOW_MODULE from "./scene3d/terrain_snow.js";
import { writeWindVector } from "./scene3d/vfx/weather_inputs.js";
import { PASSABILITY_DEFAULTS, CELL_TRIANGLES } from "./scene3d/passability_overlay.js";
import { FAM_SNOWICE, familyForCode } from "./scene3d/terrain_families.js";
import { PRESETS, PRESET_NAMES } from "./scene3d/quality.js";
import { checkTerrainFinalColour } from "./harness/lib/terrain_final_colour.mjs";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const SNOW_SRC = readFileSync("./scene3d/terrain_snow.js", "utf8");
const BATCH = readFileSync("./scene3d/terrain_batch.js", "utf8");
const QUALITY = readFileSync("./scene3d/quality.js", "utf8");
const FLAGS = readFileSync("./scene3d/vfx_flags.js", "utf8");

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
const iPrint = FRAG.indexOf("=== Wave 2A — SNOW FOOTPRINTS");
const iWaterScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
const iSnowW = FRAG.indexOf("float snowW = clamp(");
const iSparkle = FRAG.indexOf("=== Wave 2A — SNOW CRYSTAL SPARKLE");
const iDarken = FRAG.indexOf("=== Wave 2A — SNOW FOOTPRINT DARKENING");
const iSandSparkle = FRAG.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ===");
const iFragColor = FRAG.indexOf("fragColor = vec4(");
// The sparkle block alone: marker → the ICE block that follows it.
const SPARKLE_BLOCK = FRAG.slice(iSparkle, FRAG.indexOf("=== Wave 2A — ICE MATERIAL TREATMENT"));
const PRINT_BLOCK = FRAG.slice(iPrint, iWaterScroll);
// Comment-stripped variants. These blocks EXPLAIN themselves in prose ("nothing
// here reads uPomEnabled", "vVfxHash does not exist here"), so a naive substring
// test over the raw text finds the very words it is trying to prove absent.
const stripComments = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
const FRAG_CODE = stripComments(FRAG);
const SPARKLE_CODE = stripComments(SPARKLE_BLOCK);
const SNOW_CODE = stripComments(SNOW_SRC.replace(/\/\*[\s\S]*?\*\//g, ""));

// ===========================================================================
console.log("\n-- N1 sparkle/print uniforms declared once, fragment only -------");
// ===========================================================================
const SNOW_UNIFORMS = [
  ["uSnowSparkleEnabled", "float"],
  ["uSnowSparkleCodeMask", "int"],
  ["uSnowSparkleStrength", "float"],
  ["uSnowSparkleDensity", "float"],
  ["uSnowSparkleSharpness", "float"],
  ["uSnowSparkleFadeStart", "float"],
  ["uSnowSparkleFadeEnd", "float"],
  ["uSnowPrintEnabled", "float"],
  ["uSnowPrintDepth", "float"],
  ["uSnowPrintDarken", "float"],
  ["uSnowTrailMap", "sampler2D"],
  ["uSnowTrailCenter", "vec2"],
  ["uSnowTrailRadius", "float"],
  ["uSnowTrailEnabled", "float"],
];
for (const [name, type] of SNOW_UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1, `saw ${countOf(FRAG, `uniform ${type} ${name};`)}`);
  check(`${name} is NOT declared in the vertex stage (no dead uniform)`,
    !VERT.includes(name));
}
check("no backticks anywhere in the terrain fragment GLSL (they close the JS literal)",
  !FRAG.includes("`"));
check("no backticks in the spindrift GLSL either",
  !SNOW_SPINDRIFT_VERTEX_GLSL.includes("`".repeat(1))
  && !SNOW_SPINDRIFT_FRAGMENT_GLSL.includes("`".repeat(1)));
check("the snow blocks are part of the SHADER SOURCE, not a runtime patch "
  + "(recompile-safe by construction — nothing to double-apply)",
  countOf(FRAG, "=== Wave 2A — SNOW CRYSTAL SPARKLE") === 1
  && countOf(FRAG, "=== Wave 2A — SNOW FOOTPRINTS") === 1
  && !SRC.includes("SNOW_SPARKLE_BEGIN"));

// ===========================================================================
console.log("\n-- N2 the clock ------------------------------------------------");
// ===========================================================================
check("the terrain shader still declares exactly ONE uTime (the snow blocks "
  + "add no second clock uniform)",
  countOf(FRAG, "uniform float uTime;") === 1);
check("the sparkle phase reads that shared uTime",
  /float snowPhase = uTime \* 1\.1 \+ ch1 \* 6\.2831853 \+ ch2 \* 23\.0;/.test(FRAG));
check("the phase is deterministic — uTime + hash only, nothing else",
  !/random|noise\(|gl_FragCoord/.test(SPARKLE_BLOCK.replace(/\/\/.*$/gm, "")));
{
  // The glint.js identity assertion, on the material this module actually owns.
  const sharedTime = { value: 0 };
  const globals = { uTime: sharedTime, uWindDir: { value: { x: 1, y: 0 } } };
  const f = createSpindriftField({ count: 9, radiusM: 16, globals });
  check("the spindrift material binds VFX_GLOBALS.uTime BY IDENTITY (§5.6, the "
    + "test_vfx_glint.mjs assertion)", f.uniforms.uTime === sharedTime);
  check("… and reports that it does not own the clock", f.ownsClock === false);
  sharedTime.value = 42;
  f.update(0.016, 999, 0, 0, 0, 0);
  check("a later oscillator tick is seen through the bound reference, and "
    + "update() does NOT overwrite the shared clock", f.uniforms.uTime.value === 42);
  const g = createSpindriftField({ count: 9, radiusM: 16 });
  check("with no globals it MINTS its own clock and writes it (headless/node)",
    g.ownsClock === true && (g.update(0.016, 7.5, 0, 0, 0, 0), g.uniforms.uTime.value === 7.5));
  check("the spindrift GLSL declares uTime exactly once",
    countOf(SNOW_SPINDRIFT_VERTEX_GLSL, "uniform float uTime;") === 1);
}

// ===========================================================================
console.log("\n-- N3 a WORLD-SPACE hash, not a per-instance one ----------------");
// ===========================================================================
// 2026-10-24: the lattice is LANDBLOCK-LOCAL and integer-keyed (hbCellHash3):
// fragHash21 on the world cell index (~160k crystal cells at 46 km) drew the
// glints as straight dotted lines (1070 vistest tour). Still a pure function of
// world position: the landblock key + the local cell name one ground spot.
check("the crystal cell is quantised from the LANDBLOCK-LOCAL position",
  /vec2 crystalXy = \(grid \* 24\.0 \+ snowShift\) \* uSnowSparkleDensity;/.test(FRAG)
  && /vec2 ccell = floor\(crystalXy\);/.test(FRAG));
check("three decorrelated hash draws per cell, from the INTEGER lattice hash",
  /vec3 ch = hbCellHash3\(ccell, hbLbKey, 3u\);/.test(FRAG)
  && /float ch1 = ch\.x;/.test(FRAG) && /float ch2 = ch\.y;/.test(FRAG) && /float ch3 = ch\.z;/.test(FRAG)
  && /vec2 snowC = vec2\(0\.25\) \+ 0\.5 \* hbCellHash3\(ccell, hbLbKey, 4u\)\.xy;/.test(FRAG)
  && !/fragHash21\(ccell/.test(FRAG));
check("no per-instance hash is used or available in the terrain fragment stage",
  !/vVfxHash/.test(FRAG_CODE) && !SPARKLE_CODE.includes("instanceMatrix"));
check("the facet normal has a WIDE spread about the vertical (snow crystals lie "
  + "at every angle — a narrow cone would only flash at a grazing view)",
  /vec3 crystalN = normalize\(vec3\(\(ch1 - 0\.5\) \* 2\.4, \(ch2 - 0\.5\) \* 2\.4, 0\.45 \+ ch3 \* 1\.1\)\);/.test(FRAG));
check("CAMERA-MOTION twinkle: a Blinn half-vector of (sun, view) through a "
  + "tight lobe is what makes moving the camera light different crystals",
  /vec3 snowHalfAc = normalize\(sunDir - snowViewAc\);/.test(FRAG)
  && /pow\(clamp\(dot\(crystalN, snowHalfAc\), 0\.0, 1\.0\), uSnowSparkleSharpness\)/.test(FRAG)
  && /DEFAULT_SNOW_SPARKLE_SHARPNESS = 160\.0/.test(SRC));
// (The old "snow lobe is sharper than sand's 180" check read the SAND block's
// literal; sand's own look pass owns that line now, so this suite no longer
// pins another family's numbers.)
check("2026-10-23: snow's glint is a POINT inside its cell, not the whole cell",
  /float snowCore = exp\(-dot\(snowPx, snowPx\) \/ \(2\.0 \* snowSig \* snowSig\)\);/.test(FRAG)
  && /snowLobe \* snowTwinkle \* snowCore\);/.test(FRAG));
check("the view direction is derived per fragment from cameraPosition, so the "
  + "twinkle tracks the camera and not the clock",
  /vec3 snowViewW = normalize\(vWorldPos - cameraPosition\);/.test(FRAG));
check("NO grazing gate (unlike sand): snow glitters from above too",
  !/graze/.test(SPARKLE_BLOCK));

// ===========================================================================
console.log("\n-- N4 emissive only --------------------------------------------");
// ===========================================================================
check("the sparkle adds into iblSpec and nothing else",
  /iblSpec \+= uAcSunColor \* \(uSnowSparkleStrength \* snowW \* snowFade/.test(FRAG));
check("the sparkle block never writes albedo / cellUv / a water term",
  !/\bresult\s*=|\bresult\s*\*=|cellUv \+=|waterCellUv =|waterW =|modulated\s*[*+]?=/.test(SPARKLE_BLOCK));
check("it needs DIRECT sun: un-floored cloud AND CSM terms (their 0.3/0.45 floors "
  + "are ambient fill a specular flash does not have) and the sun up AND bright",
  /clamp\(\(cloudShadow - 0\.3\) \/ 0\.7, 0\.0, 1\.0\)/.test(SPARKLE_BLOCK)
  && /clamp\(\(csmShadow - 0\.45\) \/ 0\.55, 0\.0, 1\.0\)/.test(SPARKLE_BLOCK)
  && /\* smoothstep\(0\.05, 0\.25, sunDir\.z\) \* min\(length\(uAcSunVec\) \* 1\.25, 1\.0\);/.test(SPARKLE_BLOCK)
  && /snowFade \*= snowDirect;/.test(SPARKLE_BLOCK));
{
  // THE NIGHT-SPECULAR BUG (test_terrain_vfx_promotion.mjs: why snow is held
  // back): retail's night sun parks at 0.9 deg with dirBright ~0.25, and
  // uAcSunColor is colour only. The 2026-10-23 v1 gate (smoothstep 0..0.12 of
  // the elevation alone) left ~4.7 % of the noon glint all night; the gate must
  // be EXACTLY 0 there (the sand sparkle's term, test_terrain_sand_sparkle.mjs).
  const DEG = Math.PI / 180;
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const gate = (pitchDeg, dirBright) => ss(0.05, 0.25, Math.sin(pitchDeg * DEG)) * Math.min(dirBright * 1.25, 1);
  check("night-specular: retail night (pitch 0.9 deg, dirBright 0.25) => exactly 0; "
    + "noon (67 deg, 0.8) => 1; the v1 elevation-only ramp was NOT 0 at night",
    gate(0.9, 0.25) === 0 && Math.abs(gate(67.4, 0.8) - 1) < 1e-12
    && ss(0.0, 0.12, Math.sin(0.9 * DEG)) > 0.04);
}
check("a distance fade exists (an unfiltered micro-facet aliases at range)",
  /snowFade = 1\.0 - smoothstep\(uSnowSparkleFadeStart, uSnowSparkleFadeEnd, vViewDepth\)/.test(FRAG));
check("the sand sparkle's final colour write is untouched (no new term spliced "
  + "into it — wave 1B's exact-match lock still holds)",
  checkTerrainFinalColour(FRAG).ok /* 2026-10-05: shared-tail + far-bake aware, harness/lib/terrain_final_colour.mjs */);
check("no light is constructed anywhere in the snow module (§5.2)",
  !/new THREE\.[A-Za-z]*Light|PointLight/.test(SNOW_SRC));

// ===========================================================================
console.log("\n-- N5 gated from uVertexTypes (trap T3), no new attribute -------");
// ===========================================================================
check("isSnowCode() exists and reads uSnowSparkleCodeMask",
  /bool isSnowCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uSnowSparkleCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("it is shaped exactly like isWaterCode()/isSandCode()",
  /bool isWaterCode\(int c\) \{/.test(FRAG) && /bool isSandCode\(int c\) \{/.test(FRAG));
check("the corner codes come from vertexTypeAt() — the 9x9 uVertexTypes "
  + "DataTexture, NOT the terrainCode attribute (trap T3)",
  /int t00 = vertexTypeAt\(/.test(FRAG)
  && /isSnowCode\(t00\)/.test(FRAG) && /isSnowCode\(t11\)/.test(FRAG));
check("no hardcoded snow range anywhere in the fragment stage",
  !/c == 2 \|\| c == 15 \|\| c == 27/.test(FRAG) && !/t00 == 15/.test(FRAG));
check("snowW uses the SAME four bilinear corner weights as the texture blend "
  + "(so it feathers at a type boundary instead of stepping — plan §8 risk 2)",
  /snowW = clamp\(\s*\n\s*\(isSnowCode\(t00\) \? w00 : 0\.0\) \+ \(isSnowCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isSnowCode\(t01\) \? w01 : 0\.0\) \+ \(isSnowCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));
check("terrain_batch.js still whitelists exactly [position, normal, terrainCode]",
  /\["position", "normal", "terrainCode"\]/.test(BATCH),
  "the snow work adds NO attribute, so this line must not have changed");
check("the batched-GLSL rewrite anchors are intact",
  BATCH.includes("uniform sampler2D uVertexTypes;")
  && BATCH.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);")
  && FRAG.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"));
check("nothing in the snow blocks uses uLbOriginXy (zeroed on the batched path)",
  !SPARKLE_BLOCK.includes("uLbOriginXy") && !PRINT_BLOCK.includes("uLbOriginXy"));
check("the mask is DERIVED from terrain_families.js FAM_SNOWICE",
  /familyForCode\(c\) === FAM_SNOWICE/.test(SRC)
  && /snowSparkleCodeMask: computeCodeBitmask\(TERRAIN_SNOW_CODES\)/.test(SRC));
check("the derived mask agrees with terrain_snow.js::snowCodeBitmask()",
  snowCodeBitmask() === ((1 << 2) | (1 << 15) | (1 << 27)));
check("every FAM_SNOWICE code and no other is in the set",
  snowTerrainCodes().every((c) => familyForCode(c) === FAM_SNOWICE)
  && snowTerrainCodes().join() === "2,15,27");

// ===========================================================================
console.log("\n-- N6 ordering: POM, the dent, the water bypass -----------------");
// ===========================================================================
check("the POM march, the print, the water scroll and the sparkle all exist",
  iPomMarch > 0 && iPrint > 0 && iWaterScroll > 0 && iSnowW > 0
  && iSparkle > 0 && iDarken > 0 && iFragColor > 0);
check("N6: the print block runs immediately AFTER the POM march …",
  iPrint > iPomMarch);
check("N6: … and BEFORE the water scroll derivation (no water reordering)",
  iPrint < iWaterScroll);
check("N6: the trail is sampled at the PARALLAX-CORRECTED point (the post-march "
  + "cellUv offset is added back to the world position in cell units × 24 m)",
  /vec2 printShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG)
  && /vec2 printXy = vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ printShift;/.test(FRAG));
check("N6: the DENT then shifts cellUv along the same view-parallax vector POM "
  + "marches, so every downstream sampler rides one offset",
  /cellUv \+= \(pvt\.xy \/ max\(-pvt\.z, 0\.3\)\) \* \(uSnowPrintDepth \* snowPrint\);/.test(FRAG));
check("N6: the dent amplitude is well under uPomScale (0.012) so the two never fight",
  /DEFAULT_SNOW_PRINT_DEPTH = 0\.004/.test(SRC) && /uPomScale: \{ value: 0\.012 \}/.test(SRC));
check("N6: MID DEGRADE — the dent is inside a uPomEnabled test but snowPrint is "
  + "computed outside it, so with POM off the print is DARKENING ONLY",
  /if \(snowPrint > 0\.0 && uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd\)/.test(FRAG)
  && /float snowPrint = 0\.0;/.test(FRAG)
  && !/uPomEnabled/.test(stripComments(
    FRAG.slice(FRAG.indexOf("float snowPrint = 0.0;"), FRAG.indexOf("snowPrint = clamp(")))));
check("N6: the DARKENING half needs no POM at all (that IS the mid degrade)",
  !SPARKLE_CODE.includes("uPomEnabled")
  && !/uPomEnabled/.test(stripComments(FRAG.slice(iDarken, iSparkle))));
check("N6: the darkening is weighted by the SMOOTH snowW, not the binary cell test",
  /modulated \*= mix\(1\.0, 1\.0 - uSnowPrintDarken, snowPrint \* snowW\);/.test(FRAG));
check("N6: the print HONOURS the cellTouchesWater bypass (the 07-31 water fix)",
  /uSnowPrintEnabled > 0\.5 && uSnowTrailEnabled > 0\.5\s*\n\s*&& cellTouchesSnow && !cellTouchesWater/.test(FRAG));
check("N6: the sparkle honours it too",
  /uSnowSparkleEnabled > 0\.5 && snowW > 0\.0 && !cellTouchesWater/.test(FRAG));
check("N6: the sparkle is computed after the POM march and before fragColor",
  iSparkle > iPomMarch && iSparkle < iFragColor);
check("N6: the sparkle anchors its field to the parallax-corrected point too",
  /vec2 snowShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG));
check("N6: the binary cellTouchesSnow gate is resolved next to cellTouchesWater "
  + "(the dent must run before the albedo taps, where snowW does not exist yet)",
  /bool cellTouchesSnow = isSnowCode\(t00\) \|\| isSnowCode\(t10\)\s*\n\s*\|\| isSnowCode\(t01\) \|\| isSnowCode\(t11\);/.test(FRAG)
  && FRAG.indexOf("bool cellTouchesSnow") < iPomMarch
  && FRAG.indexOf("bool cellTouchesSnow") > FRAG.indexOf("bool cellTouchesWater"));
check("N6: an off-map trail UV is NO trail, never a clamped smear "
  + "(the trail_map.js contract)",
  /if \(trailUv\.x >= 0\.0 && trailUv\.x <= 1\.0 && trailUv\.y >= 0\.0 && trailUv\.y <= 1\.0\)/.test(FRAG));

// ===========================================================================
console.log("\n-- N7 strict no-op when off ------------------------------------");
// ===========================================================================
check("each accumulator/gate starts inert",
  /float snowPrint = 0\.0;/.test(FRAG));
check("ONE gate uniform guards the sparkle",
  countOf(FRAG, "uSnowSparkleEnabled > 0.5") === 1);
check("ONE gate uniform pair guards the print (the flag AND a bound map)",
  countOf(FRAG, "uSnowPrintEnabled > 0.5") === 2   // the dent + the darkening
  && countOf(FRAG, "uSnowTrailEnabled > 0.5") === 1);
// 2026-10-24: and the two MASTER kill switches (terrainVfxShaderLive() =
// visualEnabled() && terrainVfxEnabled()), so ?visual=off / ?terrainVfx=off
// kill the shader terms as the docs say (behaviour: test_vfx_flags.mjs).
check("the gates are composed from the master kills, the family master AND the effect flag",
  /snowSparkleEnabled: terrainVfxLive && terrainSnowEnabled\(\) && terrainSnowSparkleEnabled\(\),/.test(SRC)
  && /snowPrintEnabled: terrainVfxLive && terrainSnowEnabled\(\) && terrainSnowPrintsEnabled\(\),/.test(SRC)
  && SRC.includes("const terrainVfxLive = terrainVfxShaderLive();"));
check("the wireframe short-circuit carries the fields off, for shape parity",
  /snowSparkleEnabled: false,\s*\n\s*snowSparkleCodeMask: 0,\s*\n\s*snowPrintEnabled: false,/.test(SRC));
for (const [name] of SNOW_UNIFORMS) {
  check(`${name} is bound in the terrain ShaderMaterial`,
    new RegExp(`${name}: \\{`).test(SRC));
}
check("the sparkle constants are named, not magic numbers at the bind site",
  /DEFAULT_SNOW_SPARKLE_STRENGTH/.test(SRC) && /DEFAULT_SNOW_SPARKLE_DENSITY/.test(SRC)
  && /DEFAULT_SNOW_SPARKLE_SHARPNESS/.test(SRC) && /DEFAULT_SNOW_PRINT_DEPTH/.test(SRC)
  && /DEFAULT_SNOW_PRINT_DARKEN/.test(SRC));

// ===========================================================================
console.log("\n-- N8 slope bias -----------------------------------------------");
// ===========================================================================
check("threshold <= 0 disables the bias entirely",
  spindriftKeep(0, 0, 0.999) === true && spindriftKeep(0.9, -1, 0.999) === true);
check("dead-flat ground keeps exactly the documented floor",
  spindriftKeep(0, 0.12, SPINDRIFT_FLAT_KEEP - 1e-6) === true
  && spindriftKeep(0, 0.12, SPINDRIFT_FLAT_KEEP + 1e-6) === false);
check("at/above the threshold every ribbon survives",
  spindriftKeep(0.12, 0.12, 0.999) === true && spindriftKeep(0.9, 0.12, 0.999) === true);
check("the curve is MONOTONIC in slope (steeper never keeps fewer)",
  (() => {
    let prev = -1;
    for (let s = 0; s <= 0.3; s += 0.01) {
      // Recover the probability by bisection on the draw.
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i += 1) {
        const m = (lo + hi) / 2;
        if (spindriftKeep(s, 0.12, m)) lo = m; else hi = m;
      }
      if (lo < prev - 1e-9) return false;
      prev = lo;
    }
    return true;
  })());
check("it is PURE — same inputs, same answer, no clock, no Math.random",
  spindriftKeep(0.07, 0.12, 0.4) === spindriftKeep(0.07, 0.12, 0.4));
check("negative/NaN slopes are clamped rather than throwing",
  spindriftKeep(-1, 0.12, 0.5) === spindriftKeep(0, 0.12, 0.5)
  && typeof spindriftKeep(NaN, 0.12, 0.5) === "boolean");
{
  // The pool must actually honour it: a flat oracle keeps ~FLAT_KEEP, a steep
  // one keeps ~everything, with the SAME seed and the same cells.
  function fieldOn(nz) {
    const oracle = {
      sample(x, y, out) {
        const r = out || {};
        r.code = 15;
        r.family = FAM_SNOWICE;
        r.hasHeight = true;
        r.height = 10;
        let c = r.cornerCodes;
        if (!c || c.length !== 4) { c = new Uint8Array(4); r.cornerCodes = c; }
        c[0] = c[1] = c[2] = c[3] = 15;
        let n = r.normal;
        if (!n) { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
        n.x = 0; n.y = Math.sqrt(Math.max(0, 1 - nz * nz)); n.z = nz;
        return r;
      },
    };
    const f = createSpindriftField({ count: 400, radiusM: 40, slopeBias: 0.12, oracle });
    f.update(0.016, 0, 1000, 1000, 5, 0);
    return f.pool.stats();
  }
  const flat = fieldOn(1.0);        // slope 0
  const steep = fieldOn(0.8);       // slope 0.2 — past the threshold
  // The denominator is the IN-DISC population: the pool's square slot window
  // has corners outside the radius and rejects those before the oracle ever
  // runs (`outOfRange`), which has nothing to do with the slope bias.
  const inDisc = (s) => s.count - s.outOfRange;
  check("a DEAD-FLAT snowfield keeps only the floor fraction of ribbons "
    + "(2026-10-23 floor: 0.4)",
    flat.live > 0 && Math.abs(flat.live / inDisc(flat) - SPINDRIFT_FLAT_KEEP) < 0.1,
    `live ${flat.live}/${inDisc(flat)} in-disc`);
  check("a STEEP snowfield keeps (almost) all of them",
    steep.live / inDisc(steep) > 0.9,
    `live ${steep.live}/${inDisc(steep)} in-disc`);
  check("the steep field keeps strictly more than the flat one",
    steep.live > flat.live * 2);
  check("the rejected ribbons are DEGENERATE, not missing",
    flat.live + flat.degenerate === flat.count);
  check("the slope bias is deterministic across two identical fields",
    fieldOn(1.0).live === flat.live);
  check("the field reports its bias for diagnosis",
    createSpindriftField({ count: 4, slopeBias: 0.25 }).slopeBias === 0.25);
}

// ===========================================================================
console.log("\n-- N9 advection is pure, and the GLSL is its twin ---------------");
// ===========================================================================
{
  const a = spindriftAdvect(1, 0, 3.0, 0.25, 17, 5.4);
  const b = spindriftAdvect(1, 0, 3.0, 0.25, 17, 5.4);
  check("pure: same (wind, clock, hash) ⇒ same offset",
    a.x === b.x && a.y === b.y && a.s === b.s);
  check("it travels ALONG the wind direction",
    Math.abs(spindriftAdvect(0, 1, 2.0, 0.1, 17, 5.4).x) < 1e-12);
  check("it recycles within ±span/2 for any time",
    [0, 1, 7.5, 1234.5, 99999].every((t) => {
      const o = spindriftAdvect(0.7, -0.7, t, 0.3, 17, 5.4);
      return o.s >= -8.5 - 1e-9 && o.s <= 8.5 + 1e-9;
    }));
  check("wind MAGNITUDE scales the speed (gusts blow harder)",
    Math.abs(spindriftAdvect(2, 0, 1, 0, 17, 5.4).s - spindriftAdvect(1, 0, 1, 0, 17, 5.4).s) > 1e-6);
  check("zero wind does not divide by zero",
    Number.isFinite(spindriftAdvect(0, 0, 1, 0.5, 17, 5.4).x));
  const glsl = SNOW_SPINDRIFT_VERTEX_GLSL;
  check("the GLSL computes the same expression as the JS twin (with tSec*|wind| "
    + "replaced by uTravel, the integrated gust — equal for a constant wind)",
    /float travelled = uTravel \* uSpeed \* aDrift\.y \+ aDrift\.x \* uSpanM;/.test(glsl)
    && /float s = mod\(travelled, uSpanM\) - uSpanM \* 0\.5;/.test(glsl)
    && /vec2 adv = dir \* s;/.test(glsl));
  check("SPINDRIFT IS HIGHER-FREQUENCY THAN THE SAND STREAMER (plan §3.4 item 1): "
    + "faster, over a shorter recycle span, on a shorter ribbon",
    SNOW_TUNING.advectSpeed > 3.2 && SNOW_TUNING.advectSpanM < 26
    && SNOW_TUNING.ribbonLengthM < 2.6 && SNOW_TUNING.pulseFreq > 0.055);
  check("a RIBBON, not a streak: a lateral serpentine moves its centre",
    /float wave = sin\(s \* uWaveFreq \+ uTime \* uWaveHz \* 6\.2831853 \+ aDrift\.x \* 6\.2831853\)/.test(glsl)
    && /vec2 travel = adv \+ side \* wave;/.test(glsl)
    && /vec3 local = vec3\(travel, hump \+ follow\);/.test(glsl));
  check("2026-10-23: a travelling ribbon FOLLOWS its anchor's ground plane (a flat "
    + "z buried ribbons blowing up crest faces), clamped, nz guarded",
    /float follow = clamp\(-dot\(aNormal\.xy, travel\) \/ gnz, -6\.0, 6\.0\);/.test(glsl)
    && /float gnz = max\(aNormal\.z, 0\.25\);/.test(glsl));
  check("it rides the SHARED wind vector, not a private one",
    /uniform vec2  uWindAc;/.test(glsl));
  check("degenerate instances collapse through the pool's instanceMatrix scale",
    /vec4 placed = instanceMatrix \* vec4\(local, 1\.0\);/.test(glsl));
  check("the distance blend is the pool's own hbScatterFade (grass/sand parity)",
    /float fade = hbScatterFade\(placed\.xy\);/.test(glsl)
    && /float hbScatterFade\(vec2 worldXy\)/.test(glsl));
  check("the schema declares exactly the four attributes the GLSL declares "
    + "(aNormal since 2026-10-23 — the pool writes it from the oracle)",
    SNOW_SPINDRIFT_SCHEMA.map((a2) => a2.name).join() === "aOffset,aScale,aDrift,aNormal"
    && /attribute vec3 aOffset;/.test(glsl) && /attribute vec2 aScale;/.test(glsl)
    && /attribute vec4 aDrift;/.test(glsl) && /attribute vec3 aNormal;/.test(glsl));
  check("the fragment stage writes PREMULTIPLIED colour and discards empty pixels",
    /if \(a <= 0\.003\) discard;/.test(SNOW_SPINDRIFT_FRAGMENT_GLSL)
    && /gl_FragColor = vec4\(vColour \* a, a\);/.test(SNOW_SPINDRIFT_FRAGMENT_GLSL));
}
{
  const w = windAcFromGlobals({ uWindDir: { value: { x: 0.6, y: 0.8 } } }, { x: 0, y: 0 });
  check("the three→AC wind conversion is (w.x, -w.y)", w.x === 0.6 && w.y === -0.8);
  const d = windAcFromGlobals(null, { x: 0, y: 0 });
  check("with no globals it falls back to the tree_wind 135° prevailing wind",
    Math.abs(Math.atan2(d.y, d.x) * 180 / Math.PI - 135) < 1e-9);
}

// ===========================================================================
console.log("\n-- N10 weather: spindrift intensifies while it snows ------------");
// ===========================================================================
check("no env ⇒ 0 (calm); the field still drifts at its base",
  snowfallIntensity(null) === 0 && SNOW_TUNING.snowfallBase > 0);
check("a WARM storm is not snow (matches weather/manager _selectPrecip)",
  snowfallIntensity({ isStorm: true, temperatureC: 15, stormness: 1, frost: 0 }) === 0);
check("a COLD storm is full intensity",
  snowfallIntensity({ isStorm: true, temperatureC: -4, stormness: 1, frost: 1 }) === 1);
check("a cold storm ramps with the smoothed stormness (no pop)",
  snowfallIntensity({ isStorm: true, temperatureC: 0, stormness: 0, frost: 1 }) < 0.5
  && snowfallIntensity({ isStorm: true, temperatureC: 0, stormness: 0.5, frost: 1 })
     > snowfallIntensity({ isStorm: true, temperatureC: 0, stormness: 0, frost: 1 }));
check("a cold CLEAR day still lifts a little drift, off the frost ramp",
  snowfallIntensity({ isStorm: false, temperatureC: -10, frost: 1 }) > 0
  && snowfallIntensity({ isStorm: false, temperatureC: -10, frost: 1 }) < 0.4);
check("the 1 °C boundary is the manager's SNOW_TEMPERATURE_C",
  snowfallIntensity({ isStorm: true, temperatureC: 1.0, stormness: 1 }) > 0
  && snowfallIntensity({ isStorm: true, temperatureC: 1.01, stormness: 1 }) === 0);
check("the shader applies it as base + gain × intensity",
  /float wx = uSnowfallBase \+ uSnowfallGain \* clamp\(uSnowfall, 0\.0, 1\.0\);/.test(SNOW_SPINDRIFT_VERTEX_GLSL));
check("it is plumbed through update() into the uniform",
  (() => {
    const f = createSpindriftField({ count: 4 });
    f.update(0.016, 0, 0, 0, 0, 0.75);
    return f.uniforms.uSnowfall.value === 0.75 && f.stats().snowfall === 0.75;
  })());
check("FALLING SNOW IS NOT DUPLICATED: the module never touches the weather "
  + "systems, only reads the injected derived env",
  !/weather\/snow\.js|SnowSystem|WeatherEffectsManager/.test(SNOW_CODE)
  && /readEnv/.test(SNOW_CODE));

// ===========================================================================
console.log("\n-- N11 footprints ----------------------------------------------");
// ===========================================================================
{
  function fakeMat(withSnow = true) {
    const u = {
      uTime: { value: 0 },
      uSandSparkleEnabled: { value: 0 },
    };
    if (withSnow) {
      u.uSnowTrailMap = { value: null };
      u.uSnowTrailCenter = { value: { x: 0, y: 0 } };
      u.uSnowTrailRadius = { value: 0 };
      u.uSnowTrailEnabled = { value: 0 };
    }
    return { uniforms: u };
  }
  const fakeTrail = {
    uniforms: {
      uTrailMap: { value: { isTexture: true, id: 7 } },
      uTrailCenter: { value: { x: 384, y: -192 } },
      uTrailRadius: { value: 64 },
      uTrailTexel: { value: 0.25 },
      uTrailEnabled: { value: 1 },
    },
  };
  const mats = [fakeMat(), fakeMat(), fakeMat(false)];
  const touched = pushSnowTrailUniforms(mats, fakeTrail);
  check("the push reaches every Wave-2A terrain material", touched === 2);
  check("… and SKIPS a pre-Wave-2A material rather than throwing",
    mats[2].uniforms.uSnowTrailEnabled === undefined);
  check("the map texture, centre and radius all arrive",
    mats[0].uniforms.uSnowTrailMap.value.id === 7
    && mats[0].uniforms.uSnowTrailCenter.value.x === 384
    && mats[0].uniforms.uSnowTrailCenter.value.y === -192
    && mats[0].uniforms.uSnowTrailRadius.value === 64
    && mats[0].uniforms.uSnowTrailEnabled.value === 1);
  // 2026-08-03 — EXPECTATION UPDATED. This used to also require the shared
  // sampler to be NULLED on the absent-map path. That was wrong and actively
  // harmful: `uSnowTrailMap` / `uSnowTrailCenter` / `uSnowTrailRadius` are
  // SHARED with the wave-3B mud family (one trail map, one sampler; the "snow"
  // name is a wave-2A artefact), and mud gates on its own `uMudTrailEnabled`.
  // Nulling the sampler here yanked it out from under a LIVE mud provider —
  // snow's dispose() does exactly this — leaving the mud block sampling three's
  // default 1x1 white texture, i.e. a full-strength dent + darkening over the
  // whole dirt family. The mud sibling already guarded its shared writes on
  // `tex`; snow now matches. The gate is what turns the effect off, and each
  // family owns only its own gate.
  check("ABSENT MAP ⇒ this family's GATE is driven OFF (no lazy-ensure — the "
    + "grass-stomp precedent)",
    (() => {
      pushSnowTrailUniforms(mats, null);
      return mats[0].uniforms.uSnowTrailEnabled.value === 0;
    })());
  check("ABSENT MAP ⇒ the SHARED sampler/centre/radius are left alone for the "
    + "mud family (they are never read behind a closed gate)",
    mats[0].uniforms.uSnowTrailMap.value !== null
    && mats[0].uniforms.uSnowTrailMap.value.id === 7
    && mats[0].uniforms.uSnowTrailRadius.value === 64);
  check("a trail whose own map is null also reads as OFF",
    (() => {
      const dead = { uniforms: { uTrailMap: { value: null }, uTrailRadius: { value: 48 } } };
      pushSnowTrailUniforms(mats, dead);
      return mats[0].uniforms.uSnowTrailEnabled.value === 0;
    })());
  check("an empty / missing material list is a no-op, not a throw",
    pushSnowTrailUniforms(null, fakeTrail) === 0
    && pushSnowTrailUniforms([], fakeTrail) === 0);
  check("the push writes the centre COMPONENTWISE, so a plain {x,y} works "
    + "(the batched material's clone is a real Vector2; a stub may not be)",
    !/uSnowTrailCenter\.value\.set\(/.test(SNOW_SRC));
  check("it walks scene3d.terrainMaterials, which carries the ?terrainBatch "
    + "BatchedMesh material too (terrain_batch.js:447)",
    /terrainMaterials/.test(SNOW_SRC)
    && /scene3d\.terrainMaterials/.test(BATCH));
}
check("prints are PLAYER-ONLY and the limitation is stated, not faked",
  /PLAYER-ONLY stamps/.test(SNOW_SRC));
check("the stamp is tighter than the grass stomp blob (a print, not a swathe)",
  SNOW_TUNING.stampRadiusM < 0.75);
check("the trail-RT decision is documented in the module, with the recommended "
  + "fade exported and a warn when the live fade is short",
  /THE TRAIL-RT DECISION/.test(SNOW_SRC)
  && SNOW_RECOMMENDED_FADE_SEC === 300
  && /terrainTrailFade=\$\{SNOW_RECOMMENDED_FADE_SEC\}/.test(SNOW_SRC));
// 2026-08-01: prints now IMPLY the map (`vfx_flags.js::terrainTrailEnabled`),
// so the only way to reach this branch is an EXPLICIT `?terrainTrail=off`. The
// check still guards that the module never assumes the map is there.
check("prints check the map and say so when an explicit off removed it",
  /terrainTrailEnabled\(\) !== true/.test(SNOW_CODE)
  && /EXPLICIT \?terrainTrail=off/.test(SNOW_CODE));
check("this module NEVER constructs a trail map (no lazy-ensure, no second RT)",
  !/createTrailMap/.test(SNOW_CODE) && !/trail_map\.js/.test(SNOW_CODE));

// ===========================================================================
console.log("\n-- N12 firewall + invariants over the module source -------------");
// ===========================================================================
{
  const code = SNOW_SRC.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  check("no Math.random (§5.5)", !/Math\.random/.test(code));
  check("no wall-clock read (§5.5)", !/Date\.now\(\)|performance\.now/.test(code));
  check("no `.visible =` (§5.3)", !/\.visible\s*=/.test(code));
  check("no customProgramCacheKey (§5.4)", !/customProgramCacheKey/.test(code));
  check("no light of any kind (§5.2)", !/Light\b/.test(code));
  check("castShadow is forced false (§5.7)", /castShadow = false/.test(code));
  check("no wire / physics / replicated write (§5.1)",
    !/wasmExports\.(enqueue|send)|setPosition|moveTo|teleport\(/.test(code));
  check("it imports no three (injected — keeps this test pure-node)",
    !/from "three"/.test(code));
  check("it does NOT import terrain_sand.js (which registers a VFX descriptor "
    + "at import time — six lines of wind arithmetic are duplicated instead)",
    !/terrain_sand\.js/.test(code));
  check("the scatter pool owns placement — no second slot grid here",
    /createScatterPool/.test(code) && !/wrapSlotToCell/.test(code));
  check("it dogfoods BOTH wave-1 handoff §6 pool rough edges",
    /uniforms,\s*$/m.test(code) && /randSalt: 0x2a/.test(code));
}

// ===========================================================================
console.log("\n-- N13 flags + quality tiers -----------------------------------");
// ===========================================================================
const SNOW_BOOL_FLAGS = [
  "terrainSnow", "terrainSnowSpindrift", "terrainSnowSparkle",
  "terrainSnowPrints", "terrainIce", "terrainIceRefraction",
];
for (const name of SNOW_BOOL_FLAGS) {
  check(`?${name} is a STRICT exact-match opt-in (never the !== "off" footgun)`,
    new RegExp(`_strFlag\\("${name}"\\)|_terrainStrictFlag\\("${name}"`).test(FLAGS)
    && !new RegExp(`"${name}"[^\\n]*!==\\s*"off"`).test(FLAGS));
}
check("every snow/ice boolean is kept OUT of quality.js BOOL_FLAGS (parseBool "
  + "would widen the exact-`on` opt-in — the gfxRelief rule)",
  (() => {
    const boolSet = QUALITY.slice(QUALITY.indexOf("const BOOL_FLAGS"), QUALITY.indexOf("const INT_FLAGS"));
    return SNOW_BOOL_FLAGS.every((n) => !boolSet.includes(`"${n}"`));
  })());
check("the two numeric knobs ARE in the right coercion sets",
  /"terrainSnowSpindriftCount",/.test(QUALITY.slice(QUALITY.indexOf("const INT_FLAGS"), QUALITY.indexOf("const FLOAT_FLAGS")))
  && /"terrainSnowRadius",/.test(QUALITY.slice(QUALITY.indexOf("const FLOAT_FLAGS"))));
check("?terrainSnowSlope is URL-ONLY (no preset key), like ?terrainGrassDensity",
  /_numFlag\("terrainSnowSlope"/.test(FLAGS) && !/terrainSnowSlope:/.test(QUALITY));
const TIER_KEYS = [
  "terrainSnow", "terrainSnowSpindriftCount", "terrainSnowSparkle",
  "terrainSnowPrints", "terrainSnowRadius", "terrainIce", "terrainIceRefraction",
];
for (const key of TIER_KEYS) {
  check(`${key} is present on ALL FOUR tiers`,
    PRESET_NAMES.every((p) => Object.prototype.hasOwnProperty.call(PRESETS[p], key)),
    PRESET_NAMES.filter((p) => !(key in PRESETS[p])).join());
}
check("snow PROMOTED on {high, ultra} (2026-10-24 vistest), off on low / mid; "
  + "ice PROMOTED on {high, ultra} (USER 1070 SIGN-OFF 2026-08-01)",
  PRESETS.low.terrainSnow === false && PRESETS.mid.terrainSnow === false
  && PRESETS.high.terrainSnow === true && PRESETS.ultra.terrainSnow === true
  && PRESETS.low.terrainIce === false && PRESETS.mid.terrainIce === false
  && PRESETS.high.terrainIce === true && PRESETS.ultra.terrainIce === true);
check("plan §3.4 tier table: low is NULL (nothing enabled at all)",
  resolveSnowQuality(PRESETS.low) === null);
check("plan §3.4 tier table: mid = sparkle only",
  (() => {
    const q = resolveSnowQuality(PRESETS.mid);
    return q && q.sparkle === true && q.spindriftCount === 0 && q.prints === false;
  })());
check("plan §3.4 tier table: high = sparkle + 1200 spindrift + prints",
  (() => {
    const q = resolveSnowQuality(PRESETS.high);
    return q && q.sparkle === true && q.spindriftCount === 1200 && q.prints === true;
  })());
check("2026-10-23 radius ladder: high 48 m / ultra 64 m (density where the camera looks)",
  PRESETS.high.terrainSnowRadius === 48 && PRESETS.ultra.terrainSnowRadius === 64
  && resolveSnowQuality(PRESETS.high).radiusM === 48);
check("plan §3.4 tier table: ultra = sparkle + 2500 spindrift + prints + iceRefraction",
  (() => {
    const q = resolveSnowQuality(PRESETS.ultra);
    return q && q.sparkle === true && q.spindriftCount === 2500 && q.prints === true
      && PRESETS.ultra.terrainIceRefraction === true;
  })());
check("iceRefraction is ULTRA ONLY",
  PRESETS.low.terrainIceRefraction === false && PRESETS.mid.terrainIceRefraction === false
  && PRESETS.high.terrainIceRefraction === false && PRESETS.ultra.terrainIceRefraction === true);
check("the radius ladder rises with the tier",
  PRESETS.low.terrainSnowRadius <= PRESETS.mid.terrainSnowRadius
  && PRESETS.mid.terrainSnowRadius <= PRESETS.high.terrainSnowRadius
  && PRESETS.high.terrainSnowRadius <= PRESETS.ultra.terrainSnowRadius);
check("the provider ids match the VFX_EFFECT_FLAGS rows",
  SPINDRIFT_PROVIDER_ID === "terrain.snowSpindrift"
  && PRINT_PROVIDER_ID === "terrain.snowPrints"
  && FLAGS.includes('"terrain.snowSpindrift":') && FLAGS.includes('"terrain.snowPrints":')
  && FLAGS.includes('"terrain.snow":') && FLAGS.includes('"terrain.ice":'));
check("the SNOWICE sub-variant table covers exactly the family",
  Object.keys(SNOWICE_VARIANTS).map((k) => k | 0).sort((a, b) => a - b).join()
  === snowTerrainCodes().join());
check("ice is the 2/27 subset of it, never 15 (Snow stays matte)",
  iceTerrainCodes().join() === "2,27" && SNOWICE_VARIANTS[15].ice === false);
check("ice sheds far less spindrift than powder (there is nothing loose on it)",
  SNOWICE_VARIANTS[2].drift < SNOWICE_VARIANTS[15].drift
  && SNOWICE_VARIANTS[27].drift < SNOWICE_VARIANTS[15].drift);

// ---------------------------------------------------------------------------
console.log("\n-- SHARED TRAIL SAMPLER: snow and mud must not disable each other --");
// There is ONE trail map and ONE sampler in the terrain shader; the wave-2A
// "uSnowTrail*" names are shared with the wave-3B mud family, which gates on its
// own `uMudTrailEnabled`. Snow's absent-map / dispose() path used to null the
// shared sampler while mud was still gated ON.
{
  const { pushMudTrailUniforms } = await import("./scene3d/terrain_dirt.js");
  const tex = { isTexture: true, id: 42 };
  const trail = {
    uniforms: {
      uTrailMap: { value: tex },
      uTrailCenter: { value: { x: 96, y: 48 } },
      uTrailRadius: { value: 32 },
    },
  };
  const mat = () => ({
    uniforms: {
      uSnowTrailMap: { value: null },
      uSnowTrailCenter: { value: { x: 0, y: 0 } },
      uSnowTrailRadius: { value: 0 },
      uSnowTrailEnabled: { value: 0 },
      uMudTrailEnabled: { value: 0 },
      uMudWetness: { value: 0 },
    },
  });

  // Both families live and pushing this frame.
  const mats = [mat()];
  pushSnowTrailUniforms(mats, trail);
  pushMudTrailUniforms(mats, trail, 0.5);
  const u = mats[0].uniforms;
  check("both families share one bound sampler while both are live",
    u.uSnowTrailMap.value === tex && u.uSnowTrailEnabled.value === 1
    && u.uMudTrailEnabled.value === 1);

  // Snow goes away (its provider disposes / its map is absent) — mud stays.
  pushSnowTrailUniforms(mats, null);
  check("snow's teardown closes only ITS gate",
    u.uSnowTrailEnabled.value === 0 && u.uMudTrailEnabled.value === 1);
  check("snow's teardown does NOT unbind the sampler mud is still reading",
    u.uSnowTrailMap.value === tex,
    `map=${u.uSnowTrailMap.value === null ? "null" : "bound"}`);
  check("… nor does it move the centre/radius mud is still reading",
    u.uSnowTrailCenter.value.x === 96 && u.uSnowTrailRadius.value === 32);

  // And symmetrically: mud's teardown must not disable a live snow.
  const mats2 = [mat()];
  pushSnowTrailUniforms(mats2, trail);
  pushMudTrailUniforms(mats2, trail, 0.5);
  pushMudTrailUniforms(mats2, null, 0);
  const u2 = mats2[0].uniforms;
  check("mud's teardown closes only ITS gate and leaves snow bound",
    u2.uMudTrailEnabled.value === 0 && u2.uSnowTrailEnabled.value === 1
    && u2.uSnowTrailMap.value === tex);
}

// ===========================================================================
console.log("\n-- N14 the 2026-10-23 look pass ----------------------------------");
// ===========================================================================
{
  // ---- the PINK TRIANGLES are not ours --------------------------------------
  const DISPLAY = readFileSync("./plugins/rynth-vt/display.js", "utf8");
  check("PINK TRIANGLES: the steep-ground overlay is translucent RED over whole "
    + "retail terrain triangles (red at 0x60 over white snow = salmon pink)",
    PASSABILITY_DEFAULTS.color === 0xff2020
    && Math.abs(PASSABILITY_DEFAULTS.opacity - 0x60 / 255) < 1e-9
    && CELL_TRIANGLES.swNe.length === 2 && CELL_TRIANGLES.seNw.length === 2);
  check("… and it is DEFAULT OFF since 2026-10-23 (owner), through the VTank profile (ShowTerrainPassability)",
    /ShowTerrainPassability: false/.test(DISPLAY));
  check("the snow family itself draws nothing red: the ribbon albedo is a COOL "
    + "white (r <= g <= b) and the print tint is blue-shifted",
    SNOW_TUNING.colour[0] <= SNOW_TUNING.colour[1] && SNOW_TUNING.colour[1] <= SNOW_TUNING.colour[2]
    && SNOW_TUNING.colour[0] > 0.7
    && /DEFAULT_SNOW_PRINT_TINT = \[0\.84, 0\.93, 1\.1\]/.test(SRC));
  check("the finding is written into the module header for the next agent",
    /NOT OURS/.test(SNOW_SRC) && /passability_overlay\.js/.test(SNOW_SRC)
    && /__rynthPassabilityOverlay\.setVisible\(false\)/.test(SNOW_SRC));

  // ---- SNOW EXPOSURE ---------------------------------------------------------
  const iExpo = FRAG.indexOf("=== Wave 2A -- SNOW EXPOSURE");
  const EXPO_BLOCK = FRAG.slice(iExpo, iDarken);
  check("SNOW EXPOSURE sits after the retail Gouraud and before the print darkening",
    iExpo > FRAG.indexOf("modulated = terrainAcGouraud(") && iExpo < iDarken);
  check("the terrain default equals terrain_snow.js SNOW_EXPOSURE_DAY (one number)",
    new RegExp(`const DEFAULT_SNOW_EXPOSURE = ${SNOW_EXPOSURE_DAY};`).test(SRC)
    && SNOW_EXPOSURE_DAY > 0 && SNOW_EXPOSURE_DAY < 1);
  check("it is POWDER only (the shipped ice look is untouched) and skipped in the "
    + "far-ring albedo bake",
    /float powderW = clamp\(snowW - iceW, 0\.0, 1\.0\);/.test(EXPO_BLOCK)
    && /uBakeAlbedo < 0\.5/.test(EXPO_BLOCK));
  check("strict no-op when off (1.0) AND when the uniform is missing (0 => never black snow)",
    /if \(uSnowExposure > 0\.0 && uSnowExposure < 0\.999 && uBakeAlbedo < 0\.5\)/.test(EXPO_BLOCK)
    && /uSnowExposure: \{ value: opts\.snowExposureEnabled \? DEFAULT_SNOW_EXPOSURE : 1\.0 \}/.test(SRC));
  check("it rides the family MASTER (behind the master kills), and the wireframe opts carry it off",
    /snowExposureEnabled: terrainVfxLive && terrainSnowEnabled\(\),/.test(SRC)
    && /snowPrintEnabled: false,\s*\n\s*snowExposureEnabled: false,/.test(SRC));
  check("it is a plain MULTIPLY on modulated (ratios preserved), never an add",
    /modulated \*= mix\(1\.0, snowExpo, powderW\);/.test(EXPO_BLOCK)
    && !/modulated \+=/.test(stripComments(EXPO_BLOCK)));
  // The three copies of the ramp must be the same expression. The GLSL literal
  // is DERIVED from SNOW_EXPOSURE_RAMP, so the JS twin, the terrain fragment
  // and the spindrift vertex stage can only move together.
  const glslNum = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  const RAMP_STEP = `smoothstep(${glslNum(SNOW_EXPOSURE_RAMP[0])}, ${glslNum(SNOW_EXPOSURE_RAMP[1])}, snowDay)`;
  const RAMP = [
    "vec3 snowRef = min(vec3(1.0), ",
    "float snowDay = dot(snowRef, vec3(0.2126, 0.7152, 0.0722));",
    `float snowExpo = mix(1.0, uSnowExposure, ${RAMP_STEP});`,
  ];
  check("PARITY: the terrain fragment, the spindrift vertex stage and the JS twin "
    + `compute the SAME flat-ground ramp (${RAMP_STEP})`,
    RAMP.every((t) => EXPO_BLOCK.includes(t) && SNOW_SPINDRIFT_VERTEX_GLSL.includes(t))
    && countOf(EXPO_BLOCK, "snowDay)") === 1 && countOf(SNOW_SPINDRIFT_VERTEX_GLSL, "snowDay)") === 1);
  check("2026-10-24: the ramp is 0.25 -> 0.6 (the 0.85 top is gone from all three copies)",
    SNOW_EXPOSURE_RAMP[0] === 0.25 && SNOW_EXPOSURE_RAMP[1] === 0.6
    && !EXPO_BLOCK.includes("smoothstep(0.25, 0.85, snowDay)")
    && !SNOW_SPINDRIFT_VERTEX_GLSL.includes("smoothstep(0.25, 0.85, snowDay)"));
  const W = { r: 1, g: 1, b: 1 };
  const A = { r: 0.6, g: 0.7, b: 0.9 };
  check("JS twin: full sun => the day scale; night (ambient floor only) => 1.0",
    Math.abs(snowExposureScale(1.0, W, A, 0.3, 0.3) - 0.3) < 1e-9
    && snowExposureScale(0.0, W, { r: 0.2, g: 0.2, b: 0.25 }, 0.2, 0.3) === 1);
  check("JS twin: monotonic in light level and exactly 1 when exposure = 1",
    snowExposureScale(0.3, W, A, 0.3, 0.3) >= snowExposureScale(0.6, W, A, 0.3, 0.3)
    && snowExposureScale(0.6, W, A, 0.3, 0.3) >= snowExposureScale(0.9, W, A, 0.3, 0.3)
    && snowExposureScale(1.0, W, A, 0.3, 1) === 1);
  {
    // RETAIL light levels, as loop.js writes them: both colour terms carry the
    // 0.55 terrain light scale (AC_TERRAIN_LIGHT_SCALE_DEFAULT), uAcSunVec
    // carries dirBright (~0.8 at noon) as its magnitude, and uAcAmbLevel is
    // floored at LSCAPE_LIGHT_MINIMUM = 0.2.
    const TLS = 0.55;
    const sunCol = { r: 1.0 * TLS, g: 0.98 * TLS, b: 0.94 * TLS };
    const noonAmb = { r: 0.8 * TLS, g: 0.85 * TLS, b: 0.95 * TLS };
    const sunZ = 0.8 * Math.sin((70 * Math.PI) / 180);   // dirBright 0.8, sun 70 deg up
    const lum = (z, sc, ac, al) => 0.2126 * Math.min(1, sc.r * z + ac.r * al)
      + 0.7152 * Math.min(1, sc.g * z + ac.g * al) + 0.0722 * Math.min(1, sc.b * z + ac.b * al);
    const noonDay = lum(sunZ, sunCol, noonAmb, 0.45);
    const sunTerm = lum(sunZ, sunCol, { r: 0, g: 0, b: 0 }, 0);
    const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    check("retail noon: the sun term is <= ~0.41 and the flat-ground level sits ~0.6 "
      + "(so a 0.85 ramp top was never reached)",
      sunTerm <= 0.42 && noonDay > 0.55 && noonDay < 0.66 && smooth(0.25, 0.85, noonDay) < 0.7,
      `sun ${sunTerm.toFixed(3)} day ${noonDay.toFixed(3)} old weight ${smooth(0.25, 0.85, noonDay).toFixed(3)}`);
    const noonScale = snowExposureScale(sunZ, sunCol, noonAmb, 0.45, SNOW_EXPOSURE_DAY);
    check("retail noon now gets the FULL day scale (the old 0.85 top gave it only a ~0.66 weight)",
      Math.abs(noonScale - SNOW_EXPOSURE_DAY) < 1e-9
      && Math.abs(smooth(0.25, 0.85, noonDay) - 0.66) < 0.03,
      `noon scale ${noonScale}`);
    // A dimmer noon (lower sun, thinner ambient) still gets most of it.
    const dimNoon = snowExposureScale(sunZ * 0.92, sunCol, noonAmb, 0.3, SNOW_EXPOSURE_DAY);
    const dimDay = lum(sunZ * 0.92, sunCol, noonAmb, 0.3);
    check("a dimmer noon (sun x0.92, ambient level 0.3) gets >= 80 % of the day "
      + "scale (under 50 % with the old 0.85 top)",
      (1 - dimNoon) / (1 - SNOW_EXPOSURE_DAY) >= 0.8 && smooth(0.25, 0.85, dimDay) < 0.5,
      `dim noon scale ${dimNoon}`);
    // Night: retail parks the sun 0.9 deg up at dirBright ~0.25; the ambient is
    // the floor 0.2 x the (desaturated) magenta night tint x 0.55.
    const nightAmb = { r: 0.6 * TLS, g: 0.45 * TLS, b: 0.85 * TLS };
    const nightZ = 0.25 * Math.sin((0.9 * Math.PI) / 180);
    check("retail night stays strictly untouched (level well under the 0.25 start)",
      snowExposureScale(nightZ, sunCol, nightAmb, 0.2, SNOW_EXPOSURE_DAY) === 1
      && lum(nightZ, sunCol, nightAmb, 0.2) < SNOW_EXPOSURE_RAMP[0] * 0.5);
    // A low sun (~15 deg) is only lightly corrected: the ramp eases in.
    const lowZ = 0.8 * Math.sin((15 * Math.PI) / 180);
    const lowScale = snowExposureScale(lowZ, sunCol, noonAmb, 0.45, SNOW_EXPOSURE_DAY);
    check("a low sun (~15 deg) is only lightly corrected (the ramp eases in)",
      lowScale > 0.8 && lowScale < 1, `low-sun scale ${lowScale}`);
  }

  // ---- the POINT GLINT -------------------------------------------------------
  const iJac = FRAG.indexOf("vec2 snowJx = gTerrainGridDx * (24.0 * uSnowSparkleDensity);");
  const iGate = FRAG.indexOf("if (uSnowSparkleEnabled > 0.5 && snowW > 0.0 && !cellTouchesWater)");
  check("the screen Jacobian is resolved at main() scope BEFORE the per-fragment "
    + "gate: the shared top-of-main grid gradient under ?terrainGradUv (default — "
    + "the program keeps ONE derivative pair, test_terrain_micro's lock), its own "
    + "dFdx/dFdy pair only under ?terrainGradUv=off",
    iJac > iSparkle && iJac < iGate
    && FRAG.includes("vec2 snowJy = gTerrainGridDy * (24.0 * uSnowSparkleDensity);")
    && FRAG.includes("vec2 snowJx = dFdx(snowGrid);") && FRAG.includes("vec2 snowJy = dFdy(snowGrid);")
    && /vec2 snowGrid = vec2\(vWorldPos\.x, -vWorldPos\.z\) \* uSnowSparkleDensity;/.test(FRAG)
    && FRAG.indexOf("TERRAIN_MICRO.gradUv", iSparkle) > 0
    && FRAG.indexOf("TERRAIN_MICRO.gradUv", iSparkle) < iGate);
  check("the glint offset is mapped to PIXELS through the inverse Jacobian, with a "
    + "guarded determinant",
    /float snowDet = snowJx\.x \* snowJy\.y - snowJy\.x \* snowJx\.y;/.test(FRAG)
    && /abs\(snowDet\) > 1e-12/.test(FRAG));
  check("the glint fades by FOOTPRINT (cells per pixel), not only by distance",
    /float snowFoot = max\(length\(snowJx\), length\(snowJy\)\);/.test(FRAG)
    && /snowFade \*= 1\.0 - smoothstep\(0\.35, 0\.7, snowFoot\);/.test(FRAG));
  check("uSnowSparkleCorePx is declared once, fragment only, and bound",
    countOf(FRAG, "uniform float uSnowSparkleCorePx;") === 1 && !VERT.includes("uSnowSparkleCorePx")
    && /uSnowSparkleCorePx: \{ value: DEFAULT_SNOW_SPARKLE_CORE_PX \}/.test(SRC));
  check("the glint is bright enough to bloom (composer threshold 1.1) and the "
    + "cell coarse enough to stay a few px at the chase camera",
    /DEFAULT_SNOW_SPARKLE_STRENGTH = 4\.0;/.test(SRC)
    && /DEFAULT_SNOW_SPARKLE_DENSITY = 3\.5;/.test(SRC));

  // ---- the COLD PRINT + SUN-SIDE RELIEF --------------------------------------
  check("the relief is ONE extra tap of the SAME trail sampler, inside the "
    + "HB_TERRAIN_TRAIL_MAP guard, in-bounds only (never a clamped smear)",
    countOf(FRAG, "uniform sampler2D uSnowTrailMap;") === 1
    && /float rimTow = clamp\(textureLod\(uSnowTrailMap, rimUv, 0\.0\)\.r, 0\.0, 1\.0\);/.test(PRINT_BLOCK)
    && /if \(rimUv\.x >= 0\.0 && rimUv\.x <= 1\.0 && rimUv\.y >= 0\.0 && rimUv\.y <= 1\.0\)/.test(PRINT_BLOCK)
    && PRINT_BLOCK.indexOf("#ifdef HB_TERRAIN_TRAIL_MAP") < PRINT_BLOCK.indexOf("rimTow"));
  check("the darkening is COLD (tint) and the relief models the walls, stronger "
    + "with a low sun",
    /modulated \*= mix\(vec3\(1\.0\), printTint, snowPrint \* snowW\);/.test(FRAG)
    && /vec3 printTint = dot\(uSnowPrintTint, vec3\(1\.0\)\) > 0\.0 \? uSnowPrintTint : vec3\(1\.0\);/.test(FRAG)
    && /float rimLowSun = 1\.0 - 0\.5 \* clamp\(sunDir\.z, 0\.0, 1\.0\);/.test(FRAG)
    && /uSnowPrintRim \* snowPrintRelief \* snowW \* rimLowSun/.test(FRAG));
  for (const [name, type] of [["uSnowPrintTint", "vec3"], ["uSnowPrintRim", "float"], ["uSnowPrintRimM", "float"], ["uSnowExposure", "float"]]) {
    check(`${name} declared exactly once (fragment) and bound in the material`,
      countOf(FRAG, `uniform ${type} ${name};`) === 1 && !VERT.includes(name)
      && new RegExp(`${name}: \\{`).test(SRC));
  }

  // ---- the SPINDRIFT ---------------------------------------------------------
  check("spindrift is NORMAL premultiplied blending now (additive white on white "
    + "snow adds nothing the tone curve can show)",
    /blending: THREE\.NormalBlending,/.test(SNOW_CODE) && /premultipliedAlpha: true,/.test(SNOW_CODE)
    && !/AdditiveBlending/.test(SNOW_CODE));
  const V = SNOW_SPINDRIFT_VERTEX_GLSL;
  check("an AXIAL BILLBOARD: width perpendicular to the axis and the view ray",
    /vec3 sideView = cross\(aView, rayView\);/.test(V)
    && /sideView \* \(position\.y \* wid\)/.test(V) && /aView \* \(position\.x \* len\)/.test(V));
  check("no NaN paths: wind, side vector and sun vector are all guarded",
    /length\(uWindAc\) > 1e-4 \? uWindAc \/ wl : vec2\(1\.0, 0\.0\)/.test(V)
    && /sideLen > 1e-4 \?/.test(V) && /inversesqrt\(max\(dot\(sunView, sunView\), 1e-8\)\)/.test(V));
  check("no pop at the recycle wrap, nothing pasted over the lens, gusts lift it",
    /float travelFade = /.test(V) && /float nearFade = /.test(V)
    && /float gust = 1\.0 \+ uGustGain \* smoothstep\(1\.05, 1\.6, wl\);/.test(V)
    && /vAlpha = live \* pulse \* fade \* travelFade \* nearFade \* aDrift\.w \* wx \* gust;/.test(V));
  {
    // 2026-10-23 — the advection must not race as the session ages. Drive a
    // field 2 h into the session with the calm breathing wind: per-frame travel
    // must stay ~ dt * |wind| (the old uTime * |wind| moved ~t * d|w|/dt).
    const wind = { x: 1, y: 0 };
    const g = { uTime: { value: 7200 }, uWindDir: { value: wind } };
    const f = createSpindriftField({ count: 4, globals: g });
    let maxStep = 0;
    let prev = 0;
    for (let i = 0; i < 600; i += 1) {
      const t = 7200 + i / 60;
      const mag = 1 + 0.06 * Math.sin((t / 13) * 2 * Math.PI);
      wind.x = mag; wind.y = 0;
      f.update(1 / 60, t, 0, 0, 0, 0);
      const tr = f.uniforms.uTravel.value;
      if (i > 0) maxStep = Math.max(maxStep, tr - prev);
      prev = tr;
    }
    check("uTravel integrates the gust: per-frame travel ~ dt*|wind| even 2 h in "
      + "(the product form raced ~100 m/s ten minutes into a session)",
      maxStep > 0 && maxStep < (1.07 / 60) + 1e-9, `max step ${maxStep}`);
    const before = f.uniforms.uTravel.value;
    f.update(30, 7300, 0, 0, 0, 0);
    check("a long (backgrounded-tab) frame is clamped to 0.1 s of travel",
      f.uniforms.uTravel.value - before <= 0.1 * 1.07 + 1e-9);
  }
  check("LIT by the terrain's own light with a forward-scatter lobe, and EXPOSED "
    + "like the snow under it",
    /vec3 lit = snowRef \* uShade/.test(V) && /pow\(max\(dot\(rayView, sunView\), 0\.0\), uForwardPow\)/.test(V)
    && /vColour = uColour \* lit \* snowExpo;/.test(V));
  check("the scatter-time ctx.fade is no longer baked into the alpha (the shader's "
    + "live hbScatterFade already fades the edge)",
    !/ctx\.fade/.test(SNOW_CODE));
  {
    const f = createSpindriftField({ count: 4 });
    const declared = [...(V + SNOW_SPINDRIFT_FRAGMENT_GLSL).matchAll(/uniform\s+\w+\s+(\w+);/g)].map((m) => m[1]);
    // 2026-10-24: uPulseScroll is a CPU-SIDE rate (update() integrates it into
    // uPulseOffset), the one bag key the GLSL must NOT declare.
    const CPU_ONLY = ["uPulseScroll"];
    check("every uniform the spindrift GLSL declares is in its bag, and vice versa "
      + "(bar the CPU-side pulse rate, which the GLSL must not read)",
      declared.every((u) => u in f.uniforms)
      && Object.keys(f.uniforms).every((k) => declared.includes(k) || CPU_ONLY.includes(k))
      && CPU_ONLY.every((k) => k in f.uniforms && !declared.includes(k)),
      declared.filter((u) => !(u in f.uniforms)).join()
      + " | " + Object.keys(f.uniforms).filter((k) => !declared.includes(k)).join());
    // copyTerrainLighting: componentwise, from the first terrain material.
    const mats = [
      { uniforms: { uTime: { value: 0 } } },
      { uniforms: {
        uAcSunVec: { value: { x: 0.1, y: 0.2, z: 0.85 } },
        uAcSunColor: { value: { r: 1, g: 0.9, b: 0.8 } },
        uAcAmbColor: { value: { r: 0.4, g: 0.5, b: 0.7 } },
        uAcAmbLevel: { value: 0.33 },
        uSunDir: { value: { x: 0.11, y: 0.22, z: 0.97 } },
        uSnowExposure: { value: 0.42 },
      } },
    ];
    const before = f.uniforms.uSunCol.value;
    const ok = copyTerrainLighting(mats, f.uniforms);
    check("copyTerrainLighting takes the FIRST terrain material carrying the light, "
      + "componentwise (no object re-pointed)",
      ok === true && f.uniforms.uSunCol.value === before
      && f.uniforms.uSunCol.value.y === 0.9 && f.uniforms.uSunVec.value.z === 0.85
      && f.uniforms.uAmbLevel.value === 0.33 && f.uniforms.uSunDir.value.z === 0.97
      && f.uniforms.uSnowExposure.value === 0.42);
    check("… and is a fail-soft no-op with no terrain material",
      copyTerrainLighting([], f.uniforms) === false && copyTerrainLighting(null, f.uniforms) === false);
    f.syncLighting(mats);
    check("the field reports its live exposure for diagnosis",
      Math.abs(f.stats().exposureNow - snowExposureScale(0.85, { r: 1, g: 0.9, b: 0.8 },
        { r: 0.4, g: 0.5, b: 0.7 }, 0.33, 0.42)) < 1e-9 && f.stats().lightSynced === true);
  }

  // ---- LIVE KNOBS ------------------------------------------------------------
  {
    const m = () => ({ uniforms: {
      uSnowExposure: { value: 0.3 },
      uSnowSparkleStrength: { value: 4 },
      uSnowPrintTint: { value: { x: 0.84, y: 0.93, z: 1.1 } },
    } });
    const mats = [m(), m(), { uniforms: {} }];
    const tintObj = mats[0].uniforms.uSnowPrintTint.value;
    const n = applySnowTerrainTuning(mats, { exposure: 1, sparkleStrength: 6, printTint: [1, 1, 1], bogus: 3 });
    check("applySnowTerrainTuning writes scalars + arrays componentwise, skips "
      + "unknown keys and materials without the uniform",
      n === 6 && mats[1].uniforms.uSnowExposure.value === 1
      && mats[0].uniforms.uSnowSparkleStrength.value === 6
      && mats[0].uniforms.uSnowPrintTint.value === tintObj && tintObj.x === 1 && tintObj.z === 1);
    check("every terrain knob names a real terrain uniform",
      Object.values(SNOW_TERRAIN_TUNE_KEYS).every((u) => new RegExp(`${u}: \\{`).test(SRC)));
    const r = tuneTerrainSnow({ exposure: 0.5, opacity: 0.9 });
    check("tuneTerrainSnow stores both halves (applied per frame by the providers)",
      r.terrain.exposure === 0.5 && r.spindrift.opacity === 0.9);
    const z = tuneTerrainSnow({ reset: true });
    check("tune({ reset: true }) drops every override",
      z.terrain === null && z.spindrift === null);
    // 2026-10-24 — those two knobs were tuned with NO field and NO terrain
    // material (nothing inited), so no original was ever recorded. The reset
    // must still name their shipped values instead of leaving the override.
    check("reset with no recorded original falls back to the SHIPPED values "
      + "(exposure: the snow master is off here, so the material value 1.0)",
      z.restored && z.restored.terrain.exposure === 1.0 && snowExposureShipped() === 1.0
      && z.restored.spindrift.opacity === SNOW_TUNING.opacity);
  }

  // ---- RESET FALLBACK TABLES (2026-10-24) -----------------------------------
  {
    const TERRAIN_CONST = {
      exposure: "DEFAULT_SNOW_EXPOSURE",
      sparkleStrength: "DEFAULT_SNOW_SPARKLE_STRENGTH",
      sparkleDensity: "DEFAULT_SNOW_SPARKLE_DENSITY",
      sparkleSharpness: "DEFAULT_SNOW_SPARKLE_SHARPNESS",
      sparkleCorePx: "DEFAULT_SNOW_SPARKLE_CORE_PX",
      sparkleFadeStart: "DEFAULT_SNOW_SPARKLE_FADE_START",
      sparkleFadeEnd: "DEFAULT_SNOW_SPARKLE_FADE_END",
      printDarken: "DEFAULT_SNOW_PRINT_DARKEN",
      printDepth: "DEFAULT_SNOW_PRINT_DEPTH",
      printTint: "DEFAULT_SNOW_PRINT_TINT",
      printRim: "DEFAULT_SNOW_PRINT_RIM",
      printRimM: "DEFAULT_SNOW_PRINT_RIM_M",
    };
    const terrainConst = (name) => {
      const m = SRC.match(new RegExp(`const ${name} = ([^;]+);`));
      if (!m) return undefined;
      const t = m[1].trim();
      if (t.startsWith("[")) return JSON.parse(t);
      return Number(t);
    };
    const same = (a, b) => (Array.isArray(a)
      ? Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
      : a === b);
    const keys = Object.keys(SNOW_TERRAIN_TUNE_KEYS);
    const bad = keys.filter((k) => !TERRAIN_CONST[k] || !same(SNOW_TERRAIN_TUNE_DEFAULTS[k], terrainConst(TERRAIN_CONST[k])));
    check("SNOW_TERRAIN_TUNE_DEFAULTS covers every terrain knob and MIRRORS terrain.js "
      + "DEFAULT_SNOW_* exactly", bad.length === 0
      && Object.keys(SNOW_TERRAIN_TUNE_DEFAULTS).length === keys.length, bad.join());
    check("each mirrored constant is what the terrain material is actually built with",
      keys.filter((k) => k !== "exposure" && k !== "printTint")
        .every((k) => new RegExp(`${SNOW_TERRAIN_TUNE_KEYS[k]}: \\{ value: ${TERRAIN_CONST[k]} \\}`).test(SRC))
      && /DEFAULT_SNOW_PRINT_TINT\[0\], DEFAULT_SNOW_PRINT_TINT\[1\], DEFAULT_SNOW_PRINT_TINT\[2\]/.test(SRC));
    const f = createSpindriftField({ count: 4 });
    const spKeys = Object.keys(SPINDRIFT_TUNE_KEYS);
    const spBad = spKeys.filter((k) => !SPINDRIFT_TUNE_FIELDS[k]
      || f.uniforms[SPINDRIFT_TUNE_KEYS[k]].value !== SNOW_TUNING[SPINDRIFT_TUNE_FIELDS[k]]
      || snowTuneShippedValue(k) !== f.uniforms[SPINDRIFT_TUNE_KEYS[k]].value);
    check("every spindrift knob maps to the SNOW_TUNING field a fresh field is seeded "
      + "from (so the shipped value needs no field)",
      spBad.length === 0 && Object.keys(SPINDRIFT_TUNE_FIELDS).length === spKeys.length, spBad.join());
    const sz = snowTuneShippedValue("sizeMul");
    const tint = snowTuneShippedValue("printTint");
    tint[0] = 9;
    check("sizeMul ships [1, 1]; array values are fresh copies (a caller cannot "
      + "mutate the table); an unknown key is undefined",
      sz[0] === 1 && sz[1] === 1 && f.uniforms.uSizeMul.value.x === 1 && f.uniforms.uSizeMul.value.y === 1
      && SNOW_TERRAIN_TUNE_DEFAULTS.printTint[0] === 0.84 && snowTuneShippedValue("bogus") === undefined);
  }
}

// ===========================================================================
console.log("\n-- N16 2026-10-24: the gust pulse never races ---------------------");
// ===========================================================================
// Placed BEFORE N15, which installs a URL and must stay last.
{
  const V16 = SNOW_SPINDRIFT_VERTEX_GLSL;
  const MAX_DT = SNOW_MODULE.SPINDRIFT_MAX_DT;
  const pulseStepFn = typeof SNOW_MODULE.spindriftPulseStep === "function"
    ? SNOW_MODULE.spindriftPulseStep : null;
  check("the pulse GLSL reads the CPU-integrated offset, never the clock "
    + "(uPulseOffset declared once as a vec2; uPulseScroll no longer declared)",
    /vec2 pulseXy = placed\.xy \* uPulseFreq \+ uPulseOffset;/.test(V16)
    && countOf(V16, "uniform vec2  uPulseOffset;") === 1
    && !/uniform float uPulseScroll;/.test(V16)
    && !/uTime \* uPulseScroll/.test(V16));
  {
    let ok = !!pulseStepFn && MAX_DT === 0.1;
    if (ok) {
      const a = pulseStepFn(3, 4, 0.5, 0.12);          // dt clamped to 0.1
      const b = pulseStepFn(0, 0, 1 / 60, 0.12);       // dead calm: the GLSL's +X
      const c = pulseStepFn(-2, 0, -1, 0.12);          // negative dt: no step
      const o = { x: 9, y: 9 };
      const d = pulseStepFn(0, -5, 1 / 60, 0.12, o);   // zero-alloc, unit dir
      ok = Math.abs(a.x - 0.1 * 0.12 * 0.6) < 1e-15 && Math.abs(a.y - 0.1 * 0.12 * 0.8) < 1e-15
        && Math.abs(b.x - 0.12 / 60) < 1e-15 && b.y === 0 && c.x === 0 && c.y === 0
        && d === o && Math.abs(o.x) < 1e-18 && Math.abs(o.y + 0.12 / 60) < 1e-15;
    }
    check("spindriftPulseStep = dir x scroll x dt with the GLSL's own dir (unit wind "
      + "direction, +X at a dead calm) and dt clamped to SPINDRIFT_MAX_DT (0.1 s, the "
      + "uTravel clamp)", ok);
  }

  // Evaluate the shader's OWN pulse line. It is linear in its vec2 terms
  // (vec2 x float, vec2 + vec2), so each component is the same expression over
  // that component of every vec2 identifier.
  const m16 = /vec2 pulseXy = ([^;]+);/.exec(V16);
  check("the spindrift GLSL carries exactly one pulse line to evaluate",
    !!m16 && countOf(V16, "vec2 pulseXy =") === 1);
  const ARGS = ["placed", "uPulseFreq", "uPulseOffset", "dir", "uTime", "uPulseScroll"];
  const vecLine = (expr) => {
    const comp = (c) => expr.replace(/placed\.xy/g, `placed.${c}`)
      .replace(/\buPulseOffset\b/g, `uPulseOffset.${c}`)
      .replace(/\bdir\b/g, `dir.${c}`);
    // eslint-disable-next-line no-new-func
    const fx = new Function(...ARGS, `return (${comp("x")});`);
    // eslint-disable-next-line no-new-func
    const fy = new Function(...ARGS, `return (${comp("y")});`);
    return (e, out) => {
      try {
        out.x = fx(e.placed, e.uPulseFreq, e.uPulseOffset, e.dir, e.uTime, e.uPulseScroll);
        out.y = fy(e.placed, e.uPulseFreq, e.uPulseOffset, e.dir, e.uTime, e.uPulseScroll);
      } catch (_) { out.x = NaN; out.y = NaN; }
      return out;
    };
  };
  const glslPulse = vecLine(m16 ? m16[1] : "NaN");
  // The OLD line through the same machinery: the suite's own proof that the
  // session discriminates (it must race where the fix does not).
  const oldPulse = vecLine("placed.xy * uPulseFreq + dir * (uTime * uPulseScroll)");
  const NAN2 = { x: NaN, y: NaN };
  /**
   * The env the GLSL sees this frame, from the field's live uniforms. Headless
   * (no THREE) the bag's uWindAc stays null, so the wind is what update()
   * publishes into it: windAcFromGlobals over the same globals.
   */
  const wAc = { x: 0, y: 0 };
  const envOf = (U, placed, e, globals) => {
    const w = U.uWindAc.value || windAcFromGlobals(globals, wAc);
    const len = Math.hypot(w.x, w.y);
    const wl = Math.max(len, 1e-4);
    // vec2 dir = length(uWindAc) > 1e-4 ? uWindAc / wl : vec2(1.0, 0.0);
    e.dir.x = len > 1e-4 ? w.x / wl : 1;
    e.dir.y = len > 1e-4 ? w.y / wl : 0;
    e.placed = placed;
    e.uPulseFreq = U.uPulseFreq.value;
    e.uPulseOffset = U.uPulseOffset ? U.uPulseOffset.value : NAN2;
    e.uTime = U.uTime.value;
    e.uPulseScroll = U.uPulseScroll.value;
    return e;
  };
  const step = (a, b) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return Number.isNaN(d) ? Infinity : d;
  };

  {
    // THE SESSION. 3600 s at 60 fps under the REAL calm wind: |wind| breathes
    // +-6 % over 13 s and the direction wanders +-12 deg over 45 s. The shared
    // clock is driven the way loop.js drives it. At two fixed world points the
    // pattern must move <= dt x scroll noise units per frame; the old
    // dir x (uTime x scroll) moved uTime x scroll x d(dir)/dt on top.
    const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 0, y: 0 } } };
    const field = createSpindriftField({ count: 16, radiusM: 16, globals });
    const U = field.uniforms;
    const DT = 1 / 60;
    const FRAMES = 3600 * 60;
    const POINTS = [{ x: 500, y: 500 }, { x: -1234.5, y: 20480.25 }];
    const e = { dir: { x: 0, y: 0 } };
    writeWindVector(0, 0, globals.uWindDir.value);
    field.update(DT, 0, 500, 500, 10, 0);
    const prevNew = POINTS.map((p) => glslPulse(envOf(U, p, e, globals), { x: 0, y: 0 }));
    const prevOld = POINTS.map((p) => oldPulse(envOf(U, p, e, globals), { x: 0, y: 0 }));
    const cur = { x: 0, y: 0 };
    let maxStep = 0, maxStepOld = 0;
    for (let f = 1; f <= FRAMES; f += 1) {
      const t = f * DT;
      globals.uTime.value = t;                               // loop.js drives the shared clock
      writeWindVector(t, 0, globals.uWindDir.value);         // the real calm wind
      field.update(DT, t, 500, 500, 10, 0);
      for (let j = 0; j < POINTS.length; j += 1) {
        envOf(U, POINTS[j], e, globals);
        glslPulse(e, cur);
        const dN = step(cur, prevNew[j]);
        if (!(dN <= maxStep)) maxStep = dN;
        prevNew[j].x = cur.x; prevNew[j].y = cur.y;
        oldPulse(e, cur);
        const dO = step(cur, prevOld[j]);
        if (dO > maxStepOld) maxStepOld = dO;
        prevOld[j].x = cur.x; prevOld[j].y = cur.y;
      }
    }
    const scroll = U.uPulseScroll.value;
    const bound = DT * scroll;
    const toMs = (d) => (d / U.uPulseFreq.value / DT).toFixed(2);
    check("self-check: the OLD dir x (uTime x scroll) line races in this very session "
      + "(so the next check has teeth)", maxStepOld > 10 * bound,
      `old max step ${maxStepOld.toFixed(4)} units/frame (~${toMs(maxStepOld)} m/s) vs bound ${bound.toFixed(5)}`);
    check("★ no racing: over a 3600 s session under the real wandering wind the GLSL's "
      + "own pulse line moves <= dt x scroll per frame at a fixed world point",
      maxStep <= bound + 1e-9,
      `max step ${maxStep} units/frame (~${Number.isFinite(maxStep) ? toMs(maxStep) : "inf"} m/s) vs bound ${bound}`);
    const st = field.stats();
    const po = U.uPulseOffset ? U.uPulseOffset.value : null;
    check("the offset is published to the bag and to stats() (live diagnosis)",
      !!po && !!st.pulseOffset && st.pulseOffset.x === po.x && st.pulseOffset.y === po.y
      && Math.hypot(po.x, po.y) > 0 && Math.hypot(po.x, po.y) <= FRAMES * bound + 1e-6);
    // A resumed background tab: a 30 s frame advances at most SPINDRIFT_MAX_DT.
    const before = po ? { x: po.x, y: po.y } : null;
    globals.uTime.value = 3630;
    field.update(30, 3630, 500, 500, 10, 0);
    check("a long (backgrounded-tab) frame is clamped to SPINDRIFT_MAX_DT of pulse scroll",
      !!before && Math.hypot(po.x - before.x, po.y - before.y) <= MAX_DT * scroll + 1e-12
      && Math.hypot(po.x - before.x, po.y - before.y) > 0);
    check("the field still never writes the adopted shared clock",
      globals.uTime.value === 3630 && U.uTime === globals.uTime);
    field.dispose();
  }
  {
    // THE LOOK AT A CONSTANT DIRECTION IS UNCHANGED. Two hours in, a breathing
    // gust along a fixed heading: every frame's pattern step is exactly the old
    // line's step (the same ropes scrolling at the same rate and heading), and
    // the offset is dir x scroll x elapsed.
    const heading = (200 * Math.PI) / 180;
    const wd = { x: 0, y: 0 };
    const globals = { uTime: { value: 7200 }, uWindDir: { value: wd } };
    const field = createSpindriftField({ count: 4, radiusM: 16, globals });
    const U = field.uniforms;
    const DT = 1 / 60;
    const P = { x: 300, y: -40 };
    const e = { dir: { x: 0, y: 0 } };
    const setWind = (t) => {
      const mag = 1 + 0.06 * Math.sin((t / 13) * 2 * Math.PI);
      wd.x = Math.cos(heading) * mag; wd.y = Math.sin(heading) * mag;
    };
    setWind(7200);
    field.update(DT, 7200, 0, 0, 0, 0);
    const startOffset = U.uPulseOffset ? { x: U.uPulseOffset.value.x, y: U.uPulseOffset.value.y } : NAN2;
    const pN = glslPulse(envOf(U, P, e, globals), { x: 0, y: 0 });
    const pO = oldPulse(envOf(U, P, e, globals), { x: 0, y: 0 });
    const cN = { x: 0, y: 0 }, cO = { x: 0, y: 0 };
    let maxDiff = 0;
    const N = 1200;
    for (let i = 1; i <= N; i += 1) {
      const t = 7200 + i * DT;
      globals.uTime.value = t;
      setWind(t);
      field.update(DT, t, 0, 0, 0, 0);
      envOf(U, P, e, globals);
      glslPulse(e, cN);
      oldPulse(e, cO);
      const d = Math.hypot((cN.x - pN.x) - (cO.x - pO.x), (cN.y - pN.y) - (cO.y - pO.y));
      maxDiff = Number.isNaN(d) ? Infinity : Math.max(maxDiff, d);
      pN.x = cN.x; pN.y = cN.y; pO.x = cO.x; pO.y = cO.y;
    }
    const scroll = U.uPulseScroll.value;
    const po = U.uPulseOffset ? U.uPulseOffset.value : NAN2;
    // AC dir of the three-space wind (x, -y), as windAcFromGlobals converts it.
    const dirX = Math.cos(heading), dirY = -Math.sin(heading);
    const want = { x: startOffset.x + dirX * scroll * N * DT, y: startOffset.y + dirY * scroll * N * DT };
    check("★ constant wind direction: every frame's pattern step equals the old line's "
      + "step (same ropes, same rate, same heading; only the phase at creation differs)",
      maxDiff < 1e-9, `max diff ${maxDiff}`);
    check("… and the offset is exactly dir x scroll x elapsed seconds",
      Math.hypot(po.x - want.x, po.y - want.y) < 1e-9,
      `got (${po.x}, ${po.y}) want (${want.x}, ${want.y})`);
    field.dispose();
  }
}

// ===========================================================================
console.log("\n-- N17 2026-10-24: uTravel wraps seamlessly (float32 never decays) --");
// ===========================================================================
// Placed BEFORE N15, which installs a URL and must stay last. Exports read off
// the namespace so the suite still links against a module without them.
{
  const QUANT = SNOW_MODULE.SPINDRIFT_SPEED_QUANTUM;
  const LAPS = SNOW_MODULE.SPINDRIFT_TRAVEL_WRAP_LAPS;
  const speedMulFn = typeof SNOW_MODULE.spindriftSpeedMul === "function"
    ? SNOW_MODULE.spindriftSpeedMul : null;
  const wrapFn = typeof SNOW_MODULE.spindriftTravelWrap === "function"
    ? SNOW_MODULE.spindriftTravelWrap : null;
  check("the travel-wrap API is exported (spindriftSpeedMul / spindriftTravelWrap; "
    + "quantum 64, whole laps)",
    !!speedMulFn && !!wrapFn && QUANT === 64 && Number.isInteger(LAPS) && LAPS > 0);
  {
    let ok = !!speedMulFn, lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 1000 && speedMulFn; i += 1) {
      const r = i / 1000;
      const m = speedMulFn(r);
      lo = Math.min(lo, m); hi = Math.max(hi, m);
      if (!Number.isInteger(m * 64) || Math.fround(m) !== m) ok = false;
      if (Math.abs(m - (0.8 + r * 0.7)) > 1 / 128 + 1e-12) ok = false;
    }
    check("spindriftSpeedMul is k/64 (exact in float32) over the shipped 0.8..1.5 "
      + "spread, within 1/128 of the old continuous draw",
      ok && lo >= 0.79 && lo <= 0.8 && hi === 1.5, `${lo}..${hi}`);
  }
  const V17 = SNOW_SPINDRIFT_VERTEX_GLSL;
  const m17 = /float travelled = ([^;]+);/.exec(V17);
  check("the spindrift GLSL carries exactly one advection line to evaluate",
    !!m17 && countOf(V17, "float travelled =") === 1);
  // eslint-disable-next-line no-new-func
  const glslTravelled = new Function("uTravel", "uSpeed", "uSpanM", "aDrift",
    `return (${m17 ? m17[1] : "NaN"});`);
  const span = SNOW_TUNING.advectSpanM;
  const speed = SNOW_TUNING.advectSpeed;
  // s = mod(travelled, uSpanM) - uSpanM * 0.5; the recycle is a wrap, not a step.
  const sOf = (tr) => tr - span * Math.floor(tr / span) - span * 0.5;
  const circ = (d) => Math.abs(d - span * Math.round(d / span));
  const wrap = wrapFn ? wrapFn(span, speed) : NaN;
  {
    let seam = wrapFn ? 0 : Infinity;
    for (let k = 51; k <= 96 && wrapFn; k += 1) {
      for (const x of [0, 0.123, 17.5, wrap * 0.5, wrap - 1e-3]) {
        const a = { x: 0.42, y: k / 64 };
        const d = circ(sOf(glslTravelled(x, speed, span, a)) - sOf(glslTravelled(x + wrap, speed, span, a)));
        if (!(d <= seam)) seam = Number.isNaN(d) ? Infinity : d;
      }
    }
    check("the travel wrap is SEAMLESS for every k/64 multiplier through the GLSL's own "
      + "advection line (<= 1e-6 m), and short enough for float32 (< 1024 s x gust)",
      seam < 1e-6 && wrap > 100 && wrap < 1024, `seam=${seam} wrap=${wrap}`);
    check("a non-positive speed never wraps (nothing moves)",
      !!wrapFn && wrapFn(span, 0) === Infinity);
  }
  // A steep snowfield: (almost) every ribbon is live.
  const steepOracle = {
    sample(x, y, out) {
      const r = out || {};
      r.code = 15; r.family = FAM_SNOWICE; r.hasHeight = true; r.height = 10;
      let c = r.cornerCodes;
      if (!c || c.length !== 4) { c = new Uint8Array(4); r.cornerCodes = c; }
      c[0] = c[1] = c[2] = c[3] = 15;
      let n = r.normal;
      if (!n) { n = { x: 0, y: 0, z: 1 }; r.normal = n; }
      n.x = 0; n.y = 0.6; n.z = 0.8;
      return r;
    },
  };
  const liveDrifts = (field) => {
    const ad = field.pool.arrays.aDrift;
    const out = [];
    for (let i = 0; i < field.pool.count; i += 1) {
      if (field.pool.isLive(i)) out.push({ x: ad[i * 4], y: ad[i * 4 + 1] });
    }
    return out;
  };
  {
    // THE SESSION: 3600 s at 60 fps under the real calm wind. Every live
    // ribbon's per-frame step (the GLSL line on the live uTravel) stays bounded
    // across every wrap frame, and uTravel never leaves [0, wrap).
    const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 0, y: 0 } } };
    const field = createSpindriftField({ count: 64, radiusM: 16, oracle: steepOracle, globals });
    const U = field.uniforms;
    const DT = 1 / 60;
    writeWindVector(0, 0, globals.uWindDir.value);
    field.update(DT, 0, 500, 500, 10, 0);
    const live = liveDrifts(field);
    check("the wrap session has live ribbons to watch, every speed an exact k/64",
      live.length > 8 && live.every((a) => Number.isInteger(a.y * 64) && a.y >= 0.79 && a.y <= 1.5),
      `${live.length} live`);
    let maxMul = 0;
    for (const a of live) maxMul = Math.max(maxMul, a.y);
    const prev = live.map((a) => sOf(glslTravelled(U.uTravel.value, U.uSpeed.value, U.uSpanM.value, a)));
    let maxStep = 0, maxGust = field.stats().gust, lo = Infinity, hi = -Infinity;
    for (let f = 1; f <= 3600 * 60; f += 1) {
      const t = f * DT;
      globals.uTime.value = t;
      writeWindVector(t, 0, globals.uWindDir.value);
      field.update(DT, t, 500, 500, 10, 0);
      const g = field.stats().gust;
      if (g > maxGust) maxGust = g;
      const tr = U.uTravel.value;
      if (tr < lo) lo = tr;
      if (tr > hi) hi = tr;
      for (let j = 0; j < live.length; j += 1) {
        const s = sOf(glslTravelled(tr, U.uSpeed.value, U.uSpanM.value, live[j]));
        const d = circ(s - prev[j]);
        if (!(d <= maxStep)) maxStep = Number.isNaN(d) ? Infinity : d;
        prev[j] = s;
      }
    }
    const st = field.stats();
    const bound = DT * speed * Math.max(maxMul, 1.5) * maxGust;
    check("★ uTravel stays BOUNDED all session: in [0, wrap), and it wrapped (seamlessly: "
      + "every live ribbon's per-frame step <= dt x speed x max multiplier x max gust "
      + "across every wrap frame)",
      lo >= 0 && hi < wrap && st.travelWraps >= 3 && st.travelWrap === wrap && maxStep <= bound + 1e-9,
      `range ${lo}..${hi} wrap=${wrap} wraps=${st.travelWraps} maxStep=${maxStep} bound=${bound}`);
    field.dispose();
  }
  {
    // FLOAT32, 24 h IN. Fast-forward a day at the 0.1 s clamp, then run 600
    // frames evaluating the advection line the way the GPU does (each op
    // rounded to float32, uTravel uploaded as float32). The per-frame step must
    // stay within 0.5 cm of the true dt x |wind| x speed x k/64. The same model
    // over the UNWRAPPED integral (kept here in a double) is the self-check.
    const f32 = Math.fround;
    const globals = { uTime: { value: 0 }, uWindDir: { value: { x: 0, y: 0 } } };
    const field = createSpindriftField({ count: 16, radiusM: 16, globals });
    const U = field.uniforms;
    let unwrapped = 0;
    const T0 = 24 * 3600;
    for (let i = 0; i < T0 * 10; i += 1) {
      const t = i * 0.1;
      writeWindVector(t, 0, globals.uWindDir.value);
      field.update(0.1, t, 0, 0, 0, 0);
      unwrapped += 0.1 * field.stats().gust;
    }
    const sp = f32(U.uSpeed.value), sm = f32(U.uSpanM.value);
    const a = { x: f32(0.42), y: 88 / 64 };
    const gpuS = (uT) => {
      const tr = f32(f32(f32(f32(uT) * sp) * f32(a.y)) + f32(a.x * sm));
      return f32(f32(tr - f32(sm * Math.floor(f32(tr / sm)))) - f32(sm * 0.5));
    };
    const DT = 1 / 60;
    let pW = gpuS(U.uTravel.value), pU = gpuS(unwrapped);
    let errW = 0, errU = 0;
    for (let i = 1; i <= 600; i += 1) {
      const t = T0 + i * DT;
      writeWindVector(t, 0, globals.uWindDir.value);
      field.update(DT, t, 0, 0, 0, 0);
      const g = field.stats().gust;
      unwrapped += DT * g;
      const ideal = DT * g * U.uSpeed.value * a.y;
      const sW = gpuS(U.uTravel.value), sU = gpuS(unwrapped);
      errW = Math.max(errW, Math.abs(circ(sW - pW) - ideal));
      errU = Math.max(errU, Math.abs(circ(sU - pU) - ideal));
      pW = sW; pU = sU;
    }
    check("self-check: unwrapped, float32 has lost the per-frame step a day in "
      + "(> 5 cm error on a ~12 cm step)", errU > 0.05, `err ${(errU * 100).toFixed(2)} cm`);
    check("★ wrapped, the float32 per-frame step 24 h in is within 0.5 cm of the true step",
      Number.isFinite(wrap) && U.uTravel.value < wrap && errW < 0.005,
      `err ${(errW * 100).toFixed(3)} cm, uTravel ${U.uTravel.value}`);
    field.dispose();
  }
}

// ===========================================================================
console.log("\n-- N15 tune({reset:true}) end to end through the real providers ---");
// ===========================================================================
// 2026-10-24 review finding: knobs tuned BEFORE the spindrift field or any
// terrain material existed were never given an original (originals were read
// only at tune() time), so the providers' per-frame re-apply wrote the override
// onto every later material / the new field and reset left it there. Driven
// through the real spine + providers. LAST in the file: it installs a URL
// (every flag reader memoises) and clears it again.
{
  const flagsMod = await import("./scene3d/vfx_flags.js");
  const vfx = await import("./scene3d/terrain_vfx.js");
  const QF = {
    terrainSnow: false, terrainSnowSpindriftCount: 4, terrainSnowSparkle: true,
    terrainSnowPrints: false, terrainSnowRadius: 48, terrainIce: false, terrainIceRefraction: false,
  };
  const setUrl = (search) => {
    globalThis.window = { location: { search }, liveScene3d: { quality: { flags: { ...QF } } } };
    flagsMod._resetVfxFlags();
  };
  const SHIP = SNOW_TERRAIN_TUNE_DEFAULTS;
  const mkMat = () => ({ uniforms: {
    uSnowExposure: { value: SHIP.exposure },
    uSnowSparkleStrength: { value: SHIP.sparkleStrength },
    uSnowPrintTint: { value: { x: SHIP.printTint[0], y: SHIP.printTint[1], z: SHIP.printTint[2] } },
  } });
  const shipped = (m) => m.uniforms.uSnowExposure.value === SHIP.exposure
    && m.uniforms.uSnowSparkleStrength.value === SHIP.sparkleStrength
    && m.uniforms.uSnowPrintTint.value.x === SHIP.printTint[0]
    && m.uniforms.uSnowPrintTint.value.z === SHIP.printTint[2];
  try {
    setUrl("?terrainSnow=on&terrainSnowSpindrift=on&terrainSnowSpindriftCount=4");
    vfx._resetTerrainVfx();
    _resetTerrainSnow();
    check("with the snow master lit, the shipped exposure is the day scale",
      snowExposureShipped() === SNOW_EXPOSURE_DAY && snowTuneShippedValue("exposure") === SNOW_EXPOSURE_DAY);
    const terrainMaterials = [];
    const scene3d = {
      terrainGroup: { children: [], parent: null },
      terrainMaterials,
      frameTime: { tsSec: 0 },
      quality: { flags: { ...QF } },
      cameraSwitcher: { _safePlayerPos: () => ({ x: 96, y: 96, z: 10 }) },
    };
    vfx.initTerrainVfx({ scene3d });
    const surface = initTerrainSnow({ scene3d, getOracle: () => null });
    check("the spindrift provider registered (the fixture is live)",
      !!surface && vfx.terrainVfxStats().providers.some((p) => p.id === SPINDRIFT_PROVIDER_ID));

    // Tune with NO field and NO terrain material.
    surface.tune({ exposure: 0.55, sparkleStrength: 9, printTint: [1, 1, 1],
      opacity: 0.2, rise: 0.5, sizeMul: [2, 3] });
    check("nothing exists yet: no field, no material", surface.field === null && terrainMaterials.length === 0);

    // A landblock bakes, then the first frame builds the field.
    terrainMaterials.push(mkMat());
    vfx.terrainVfxTick(0.016, scene3d, 1);
    const f = surface.field;
    check("the first frame builds the field and carries every override onto it and "
      + "onto the new material",
      !!f && f.uniforms.uOpacity.value === 0.2 && f.uniforms.uRise.value === 0.5
      && f.uniforms.uSizeMul.value.x === 2 && f.uniforms.uSizeMul.value.y === 3
      && terrainMaterials[0].uniforms.uSnowExposure.value === 0.55
      && terrainMaterials[0].uniforms.uSnowSparkleStrength.value === 9
      && terrainMaterials[0].uniforms.uSnowPrintTint.value.x === 1);
    // A landblock baked later picks the override up on the next frame.
    terrainMaterials.push(mkMat());
    vfx.terrainVfxTick(0.016, scene3d, 1.016);
    check("a later landblock picks the override up on the next frame",
      terrainMaterials[1].uniforms.uSnowExposure.value === 0.55
      && terrainMaterials[1].uniforms.uSnowPrintTint.value.y === 1);

    const z = surface.tune({ reset: true });
    check("reset restores EVERY material to the shipped terrain values (the knobs "
      + "were tuned before any material existed)", terrainMaterials.every(shipped),
      JSON.stringify(terrainMaterials.map((m) => m.uniforms.uSnowExposure.value)));
    check("reset restores the FIELD to SNOW_TUNING (tuned before the field existed)",
      f.uniforms.uOpacity.value === SNOW_TUNING.opacity && f.uniforms.uRise.value === SNOW_TUNING.riseSlope
      && f.uniforms.uSizeMul.value.x === 1 && f.uniforms.uSizeMul.value.y === 1);
    check("reset reports the bags it wrote and drops the overrides",
      z.terrain === null && z.spindrift === null
      && z.restored.terrain.exposure === SNOW_EXPOSURE_DAY && z.restored.terrain.sparkleStrength === 4
      && z.restored.spindrift.opacity === SNOW_TUNING.opacity
      && surface.stats().tune.terrain === null && surface.stats().tune.spindrift === null);
    terrainMaterials.push(mkMat());
    vfx.terrainVfxTick(0.016, scene3d, 1.032);
    check("after reset the providers re-apply nothing (a new material stays shipped)",
      terrainMaterials.every(shipped) && f.uniforms.uOpacity.value === SNOW_TUNING.opacity);

    // Tuned WITH everything resident: the original is read at tune() time.
    surface.tune({ exposure: 0.8, waveAmp: 0.9 });
    check("a knob tuned with the field + materials resident applies at once",
      terrainMaterials.every((m) => m.uniforms.uSnowExposure.value === 0.8)
      && f.uniforms.uWaveAmp.value === 0.9);
    surface.tune({ reset: true });
    check("… and its reset restores the recorded original",
      terrainMaterials.every(shipped) && f.uniforms.uWaveAmp.value === SNOW_TUNING.waveAmpM);

    // FIX A ON ITS OWN (2026-10-24 verifier). Every check above also passes with
    // the providers' re-apply / the field build writing WITHOUT recording,
    // because the shipped-table fallback names the same numbers. A material that
    // carries a value OTHER than the table (a stand-in for one built with a
    // different default) tells them apart: the LAZILY recorded original must
    // come back, not the table's.
    vfx._resetTerrainVfx();
    _resetTerrainSnow();
    terrainMaterials.length = 0;
    vfx.initTerrainVfx({ scene3d });
    const s2 = initTerrainSnow({ scene3d, getOracle: () => null });
    s2.tune({ sparkleStrength: 9 });
    const odd = mkMat();
    odd.uniforms.uSnowSparkleStrength.value = 5;
    terrainMaterials.push(odd);
    vfx.terrainVfxTick(0.016, scene3d, 2);
    const oddApplied = odd.uniforms.uSnowSparkleStrength.value === 9;
    const z2 = s2.tune({ reset: true });
    check("the original is recorded LAZILY at the provider's first re-apply: a "
      + "material carrying a non-table value gets THAT value back, not the table's",
      oddApplied && odd.uniforms.uSnowSparkleStrength.value === 5
      && z2.restored.terrain.sparkleStrength === 5,
      `applied ${oddApplied}, after reset ${odd.uniforms.uSnowSparkleStrength.value}`);
  } finally {
    vfx._resetTerrainVfx();
    _resetTerrainSnow();
    delete globalThis.window;
    flagsMod._resetVfxFlags();
  }
}

console.log(`\nterrain snow: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
