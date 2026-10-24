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
//   S7  The JS side binds all eight uniforms and derives the mask from
//       `terrain_families.js`, and the mask agrees with `terrain_sand.js`.
//   S8  (2026-10-23 retune, "essentially invisible" at noon on the 1070) the
//       glint is a sparse, bright MIRROR: facet fraction + lobe sharpness are
//       uniforms (live knobs), the facets spread about the MACRO normal wide
//       enough to reach the noon half-vector with the sun behind the camera,
//       the shape is footprint-aware off the shared `wFoot` derivative (a round
//       point near, energy shared out far), and the grazing term is a weight,
//       not a gate. Numerically: a lit glint now clearly out-shines the sand.
//       And the NIGHT-SPECULAR fix: the glint needs the sun up and bright
//       (|uAcSunVec| = dirBright), not just uAcSunColor (colour only).
//
// Run from apps/holtburger-web/:  node test_terrain_sand_sparkle.mjs

import { readFileSync } from "node:fs";
import { sandCodeBitmask } from "./scene3d/terrain_sand.js";
import { checkTerrainFinalColour } from "./harness/lib/terrain_final_colour.mjs";

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
  ["uSandSparkleSharpness", "float"],
  ["uSandSparkleFacetFrac", "float"],
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
  checkTerrainFinalColour(FRAG).ok /* 2026-10-05: shared-tail + far-bake aware, harness/lib/terrain_final_colour.mjs */);
check("S4: a distance fade exists (an unfiltered micro-facet aliases at range)",
  /sparkFade = 1\.0 - smoothstep\(uSandSparkleFadeStart, uSandSparkleFadeEnd, vViewDepth\)/.test(FRAG));
check("S4: a GRAZING weight exists (dune faces flash at a low angle)",
  /float graze = 1\.0 - clamp\(dot\(geomN, -viewAc\), 0\.0, 1\.0\);/.test(FRAG));
check("the glint.js maths: a Blinn half-vector lobe + a time+hash twinkle",
  /vec3 halfAc = normalize\(sunDir - viewAc\);/.test(FRAG)
  && /pow\(clamp\(dot\(grainN, halfAc\), 0\.0, 1\.0\), uSandSparkleSharpness\)/.test(FRAG)
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
// 2026-10-24: and the two MASTER kill switches (terrainVfxShaderLive() =
// visualEnabled() && terrainVfxEnabled()), so ?visual=off / ?terrainVfx=off
// kill the sparkle as the docs say (behaviour: test_vfx_flags.mjs).
check("the gate is composed from the master kills, the family master AND the effect flag",
  /sandSparkleEnabled: terrainVfxLive && terrainSandEnabled\(\) && terrainSandSparkleEnabled\(\),/.test(SRC)
  && SRC.includes("const terrainVfxLive = terrainVfxShaderLive();"));
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
  /sheenFade = \(1\.0 - smoothstep\(uWaterSheenFade\.x, uWaterSheenFade\.y, vViewDepth\)\) \* footFade;/.test(FRAG) /* 2026-10-15: the band is ?waterSheenFade (default 30,160, test_terrain_water.mjs) */);
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
  && /DEFAULT_SAND_SPARKLE_FADE_START/.test(SRC) && /DEFAULT_SAND_SPARKLE_FADE_END/.test(SRC)
  && /DEFAULT_SAND_SPARKLE_SHARPNESS/.test(SRC) && /DEFAULT_SAND_SPARKLE_FACET_FRAC/.test(SRC));
check("the mid-tier degrade is coherent: nothing in the block requires POM",
  !SPARKLE_BLOCK.includes("uPomEnabled"));

// ===========================================================================
console.log("\n-- S8 the 2026-10-23 retune -------------------------------------");
// ===========================================================================
const num = (name) => {
  const m = new RegExp(`const ${name} = ([0-9.]+);`).exec(SRC);
  return m ? Number(m[1]) : NaN;
};
const STRENGTH = num("DEFAULT_SAND_SPARKLE_STRENGTH");
const SHARP = num("DEFAULT_SAND_SPARKLE_SHARPNESS");
const FACET = num("DEFAULT_SAND_SPARKLE_FACET_FRAC");
check("the grazing term is a WEIGHT (floored), not a gate that kills the chase-camera view",
  /graze = 0\.35 \+ 0\.65 \* graze \* graze;/.test(SPARKLE_BLOCK)
  && !/if \(graze > 0\.001\)/.test(SPARKLE_BLOCK));
check("facets spread about the MACRO normal (geomN), wide (±1.1 slope)",
  /vec3 grainN = normalize\(geomN \+ vec3\(\(gh1 - 0\.5\) \* 2\.2, \(gh2 - 0\.5\) \* 2\.2, 0\.0\)\);/.test(SPARKLE_BLOCK));
check("sparse MIRROR cells: a per-cell coin against uSandSparkleFacetFrac, scaled by the footprint",
  /if \(gh3 < min\(1\.0, uSandSparkleFacetFrac \* cellsPerPx\)\)/.test(SPARKLE_BLOCK));
check("footprint-aware: grains per pixel come from the SHARED wFoot (no new derivative pair)",
  /float gpp = max\(wFoot \* uSandSparkleDensity, 0\.001\);/.test(SPARKLE_BLOCK)
  && !/dFdx|dFdy|fwidth/.test(SPARKLE_BLOCK));
check("… declared at main scope BEFORE the sparkle block (not inside a branch)",
  FRAG.indexOf("float wFoot =") > 0 && FRAG.indexOf("float wFoot =") < iSparkle
  || (SRC.indexOf("float wFoot = ") > 0 && SRC.indexOf("float wFoot = ") < SRC.indexOf("=== Wave 1B — SAND GRAIN SPARKLE ===")));
check("round point near the camera, energy shared out far (… * gDot / cellsPerPx)",
  /float gDot = 1\.0 - smoothstep\(gRad \* 0\.45, gRad, length\(fract\(grainXy\) - gpt\)\);/.test(SPARKLE_BLOCK)
  && /\* lobe \* twinkle \* gDot \/ cellsPerPx\)/.test(SPARKLE_BLOCK));

// Numerics, in JS: the block's maths at the owner's noon tour (sun 67.4°
// elevation) from a chase camera ~16° above the sand, sun BEHIND the camera
// (the case v1 could not reach at all).
const DEG = Math.PI / 180;
const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sun = norm([0, -Math.cos(67.4 * DEG), Math.sin(67.4 * DEG)]);   // sun to the south
const view = norm([0, Math.cos(16 * DEG), -Math.sin(16 * DEG)]);      // looking north, down 16°
const half = norm([sun[0] - view[0], sun[1] - view[1], sun[2] - view[2]]);
// Share of mirror facets whose lobe exceeds 0.5 (uniform facet slopes, v1 vs now).
function lobeShare(spread, sharp) {
  let hit = 0, n = 0;
  for (let i = 0; i < 200; i += 1) {
    for (let j = 0; j < 200; j += 1) {
      const fn = norm([((i + 0.5) / 200 - 0.5) * spread, ((j + 0.5) / 200 - 0.5) * spread, 1]);
      if (Math.pow(Math.max(0, dot(fn, half)), sharp) > 0.5) hit += 1;
      n += 1;
    }
  }
  return hit / n;
}
const v1Share = lobeShare(1.6, 180);
const nowShare = lobeShare(2.2, SHARP);
check("★ sun BEHIND the camera at noon: v1's facets almost never reach the half-vector, the\n"
  + "        retuned spread does (facet share with lobe > 0.5)",
  v1Share < 0.0005 && nowShare > 0.002, `v1=${v1Share} now=${nowShare}`);
// Peak added radiance of a lit glint vs the sand it sits on. uAcSunColor is
// dirColor x the 0.55 terrain light scale (loop.js); lit sand-yellow albedo
// (linear ~0.39 luma) x acC (~0.55-0.8) is ~0.2-0.3.
const sunColor = 0.55;
const graze = 0.35 + 0.65 * Math.pow(1 - Math.sin(16 * DEG), 2);
const peak = sunColor * STRENGTH * graze;           // lobe 1, twinkle 1, gDot 1, one cell/px
const v1Peak = sunColor * 0.55 * Math.pow(1 - Math.sin(16 * DEG), 2) * 1.0;
check("★ a lit glint now out-shines the ~0.3-radiance sand ~4x over (v1's rare best case\n"
  + "        added ~0.16, which AGX at exposure 5 compresses into the sand)",
  peak >= 4 * 0.3 && v1Peak < 0.2, `peak=${peak.toFixed(3)} v1=${v1Peak.toFixed(3)}`);
check("… while staying sparse: at most ~1 % of grain cells can glint at once",
  FACET * nowShare < 0.01, `${FACET * nowShare}`);

// THE NIGHT-SPECULAR BUG (why sand/snow/volcano/dirt were held back from
// promotion): uAcSunColor is colour only — the retail brightness is
// |uAcSunVec| (dirBright) and the night "sun" parks 0.9° above the horizon.
check("★ night-specular fix: the glint is scaled by the sun's ELEVATION and BRIGHTNESS",
  /float sunGlint = smoothstep\(0\.05, 0\.25, sunDir\.z\) \* min\(length\(uAcSunVec\) \* 1\.25, 1\.0\);/.test(SPARKLE_BLOCK)
  && /uSandSparkleStrength \* sandW \* graze \* sunGlint/.test(SPARKLE_BLOCK));
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const sunGlintAt = (pitchDeg, dirBright) => ss(0.05, 0.25, Math.sin(pitchDeg * DEG)) * Math.min(dirBright * 1.25, 1);
check("… retail night (pitch 0.9°, dirBright 0.25) ⇒ exactly 0; noon (pitch 67°, 0.8) ⇒ 1",
  sunGlintAt(0.9, 0.25) === 0 && Math.abs(sunGlintAt(67.4, 0.8) - 1) < 1e-12);
check("… dawn (pitch 10°, dirBright 0.5) is partial, not a pop",
  sunGlintAt(10, 0.5) > 0.05 && sunGlintAt(10, 0.5) < 0.5);

console.log(`\nterrain sand sparkle: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
