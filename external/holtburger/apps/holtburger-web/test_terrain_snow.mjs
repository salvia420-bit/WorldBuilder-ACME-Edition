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
//       the right coercion sets, and the DEFAULT-ON effect count is still 14.
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
check("the crystal cell is quantised from the WORLD position",
  /vec2 crystalXy = \(vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ snowShift\) \* uSnowSparkleDensity;/.test(FRAG)
  && /vec2 ccell = floor\(crystalXy\);/.test(FRAG));
check("three decorrelated hash draws per cell, from the FRAGMENT-stage hash",
  /float ch1 = fragHash21\(ccell\);/.test(FRAG)
  && /float ch2 = fragHash21\(ccell \+ vec2\(19\.3, 71\.9\)\);/.test(FRAG)
  && /float ch3 = fragHash21\(ccell \+ vec2\(53\.1, 7\.7\)\);/.test(FRAG));
check("no per-instance hash is used or available in the terrain fragment stage",
  !/vVfxHash/.test(FRAG_CODE) && !SPARKLE_CODE.includes("instanceMatrix"));
check("the facet normal has a WIDE spread about the vertical (snow crystals lie "
  + "at every angle — a narrow cone would only flash at a grazing view)",
  /vec3 crystalN = normalize\(vec3\(\(ch1 - 0\.5\) \* 2\.4, \(ch2 - 0\.5\) \* 2\.4, 0\.45 \+ ch3 \* 1\.1\)\);/.test(FRAG));
check("CAMERA-MOTION twinkle: a Blinn half-vector of (sun, view) through a very "
  + "tight lobe is what makes moving the camera light different crystals",
  /vec3 snowHalfAc = normalize\(sunDir - snowViewAc\);/.test(FRAG)
  && /pow\(clamp\(dot\(crystalN, snowHalfAc\), 0\.0, 1\.0\), uSnowSparkleSharpness\)/.test(FRAG)
  && /DEFAULT_SNOW_SPARKLE_SHARPNESS = 420\.0/.test(SRC));
check("the snow lobe is SHARPER than the sand lobe (sand 180, snow 420)",
  /pow\(clamp\(dot\(grainN, halfAc\), 0\.0, 1\.0\), 180\.0\)/.test(FRAG));
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
check("it is multiplied by cloudShadow AND csmShadow (a sparkle is sunlight)",
  /\* cloudShadow \* csmShadow;/.test(SPARKLE_BLOCK));
check("a distance fade exists (an unfiltered micro-facet aliases at range)",
  /snowFade = 1\.0 - smoothstep\(uSnowSparkleFadeStart, uSnowSparkleFadeEnd, vViewDepth\)/.test(FRAG));
check("the sand sparkle's final colour write is untouched (no new term spliced "
  + "into it — wave 1B's exact-match lock still holds)",
  /fragColor = vec4\(modulated \* ndotl \* cloudShadow \* csmShadow \+ iblSpec\s*\n\s*\+ sandSparkle \* cloudShadow \* csmShadow, 1\.0\);/.test(FRAG));
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
check("the gates are composed from the family master AND the effect flag",
  /snowSparkleEnabled: terrainSnowEnabled\(\) && terrainSnowSparkleEnabled\(\),/.test(SRC)
  && /snowPrintEnabled: terrainSnowEnabled\(\) && terrainSnowPrintsEnabled\(\),/.test(SRC));
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
  check("a DEAD-FLAT snowfield keeps only the floor fraction of ribbons",
    flat.live > 0 && flat.live / inDisc(flat) < 0.3,
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
  check("the GLSL computes the same expression as the JS twin",
    /float travelled = uTime \* uSpeed \* aDrift\.y \* wl \+ aDrift\.x \* uSpanM;/.test(glsl)
    && /float s = mod\(travelled, uSpanM\) - uSpanM \* 0\.5;/.test(glsl)
    && /vec2 adv = dir \* s;/.test(glsl));
  check("SPINDRIFT IS HIGHER-FREQUENCY THAN THE SAND STREAMER (plan §3.4 item 1): "
    + "faster, over a shorter recycle span, on a shorter ribbon",
    SNOW_TUNING.advectSpeed > 3.2 && SNOW_TUNING.advectSpanM < 26
    && SNOW_TUNING.ribbonLengthM < 2.6 && SNOW_TUNING.pulseFreq > 0.055);
  check("a RIBBON, not a streak: a lateral serpentine along its length",
    /float wave = sin\(s \* uWaveFreq \+ uTime \* uWaveHz \* 6\.2831853 \+ aDrift\.x \* 6\.2831853\)/.test(glsl)
    && /side \* \(position\.y \* aScale\.y \+ wave\)/.test(glsl));
  check("it rides the SHARED wind vector, not a private one",
    /uniform vec2  uWindAc;/.test(glsl));
  check("degenerate instances collapse through the pool's instanceMatrix scale",
    /vec4 placed = instanceMatrix \* vec4\(local, 1\.0\);/.test(glsl));
  check("the distance blend is the pool's own hbScatterFade (grass/sand parity)",
    /float fade = hbScatterFade\(placed\.xy\);/.test(glsl)
    && /float hbScatterFade\(vec2 worldXy\)/.test(glsl));
  check("the schema declares exactly the three attributes the GLSL reads",
    SNOW_SPINDRIFT_SCHEMA.map((a2) => a2.name).join() === "aOffset,aScale,aDrift"
    && /attribute vec3 aOffset;/.test(glsl) && /attribute vec2 aScale;/.test(glsl)
    && /attribute vec4 aDrift;/.test(glsl));
  check("the fragment stage is additive-friendly and discards empty pixels",
    /if \(a <= 0\.0\) discard;/.test(SNOW_SPINDRIFT_FRAGMENT_GLSL));
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
  check("ABSENT MAP ⇒ the uniform is driven OFF and the texture nulled "
    + "(no lazy-ensure — the grass-stomp precedent)",
    (() => {
      pushSnowTrailUniforms(mats, null);
      return mats[0].uniforms.uSnowTrailEnabled.value === 0
        && mats[0].uniforms.uSnowTrailMap.value === null;
    })());
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
check("both family masters ship OFF on every tier (§5.9)",
  PRESET_NAMES.every((p) => PRESETS[p].terrainSnow === false && PRESETS[p].terrainIce === false));
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

console.log(`\nterrain snow: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
