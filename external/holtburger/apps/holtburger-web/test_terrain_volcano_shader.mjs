// test_terrain_volcano_shader.mjs — the LAVA CRACK GLOW injection into the
// TERRAIN fragment shader (Wave 2B, plan §3.6 item 3; reworked 2026-10-23).
//
// Deliberately a SEPARATE suite from `test_terrain_volcano.mjs`: the terrain
// fragment shader is shared by every family, so the shader edit and its test
// stay one self-contained unit. The OBSIDIAN glass block that used to live in
// the same block (code 6) is its own family since the 2026-10-23 split; its
// shader assertions are in `test_terrain_obsidian.mjs`.
//
// Structure and technique mirror `test_terrain_sand_sparkle.mjs` (which mirrors
// `test_terrain_water.mjs`): slice the two GLSL template literals out of
// `scene3d/terrain.js` and assert on the source — no GPU needed.
//
// Locks:
//   V1  Every lava uniform is DECLARED EXACTLY ONCE, in the FRAGMENT stage
//       only, and the block is recompile-safe (part of the source string).
//   V2  Gated on FAM_VOLCANO read from **uVertexTypes** (plan trap T3), through
//       an `isVolcanoCode()` helper shaped exactly like `isWaterCode()` and
//       reading a JS-built mask — never a hardcoded range and never the
//       `terrainCode` geometry ATTRIBUTE.
//   V3  NO new geometry attribute, so the `terrain_batch.js` attribute
//       whitelist is untouched and the batched GLSL rewrite anchors still match.
//   V4  ORDERING (plan §2.7.3): AFTER the POM march and the albedo chain; the
//       cellTouchesWater bypass; ADDED to `iblSpec` (emissive: lava glows in
//       shadow) and the final `fragColor` line is BYTE-UNCHANGED.
//   V5  STRICT NO-OP when off: one gate uniform, seeded from two flags that
//       ship OFF, and skipped when the lava fraction is 0.
//   V6  NO WATER / SAND REGRESSION: their invariants are still in the source.
//   V7  The JS side binds every uniform and DERIVES the mask from
//       `terrain_families.js`, and it agrees with `terrain_volcano.js`.
//   V8  The BREATH is pushed by `loop.js::tickTerrainUTime` (NOT bound by
//       reference), because `terrain_batch.js` clones uniform values.
//   T1  2026-10-23 — THE TEXTURE'S OWN CRACKS: the glow is the heat of the
//       finished albedo (`result`, linear: r standing clear of 0.55 g and b)
//       made emissive in the texel's own colour; no procedural vein field. The
//       heat window is calibrated against the real Volcano1 texture (and must
//       reject the obsidian / ash textures) — asserted below on the DAT PNGs
//       when they are on disk.
//   T2  The pulse is deterministic (hash/noise of the ground point + uTime)
//       and ≤ 1 Hz; the day scale reads the flat-ground retail light level.
//
// Run from apps/holtburger-web/:  node test_terrain_volcano_shader.mjs

import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { checkTerrainFinalColour } from "./harness/lib/terrain_final_colour.mjs";
import { volcanoCodeBitmask } from "./scene3d/terrain_volcano.js";

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

// The MAIN block's marker (the uniform-declaration comment uses the dated
// `=== 2026-08-01 (Wave 2B) - ...` form, so this matches exactly ONE site).
const MARKER = "=== Wave 2B - LAVA CRACK GLOW";
const iPomMarch = FRAG.indexOf("cellUv += uvOff;");
const iWaterScroll = FRAG.indexOf("vec2 waterCellUv = cellUv;");
const iWaterSheen = FRAG.indexOf("iblSpec += waterSpec * waterW;");
const iMacro = FRAG.indexOf("result *= mix(vec3(1.0), macroMod, mFade * uMacroStrength);");
const iVolcW = FRAG.indexOf("float volcW = clamp(");
const iBlock = FRAG.indexOf(MARKER);
const iFragColor = FRAG.indexOf("fragColor = vec4(");
const VOLC_BLOCK = FRAG.slice(iBlock, FRAG.indexOf("// Clouds-L — cloud-shadow modulation", iBlock));
const codeOnly = (s) => s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

// ===========================================================================
console.log("\n-- V1 uniforms declared once, fragment stage only ----------------");
// ===========================================================================
const UNIFORMS = [
  ["uCrackGlowEnabled", "float"],
  ["uVolcanoCodeMask", "int"],
  ["uCrackGlowStrength", "float"],
  ["uCrackGlowDay", "float"],
  ["uCrackGlowHeat", "vec2"],
  ["uCrackGlowColor", "vec3"],
  ["uCrackGlowPulse", "float"],
  ["uCrackGlowBreath", "float"],
  ["uCrackGlowFadeStart", "float"],
  ["uCrackGlowFadeEnd", "float"],
];
for (const [name, type] of UNIFORMS) {
  check(`${name} declared exactly once in the FRAGMENT stage`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1);
  check(`${name} is NOT declared in the vertex stage (no dead uniform)`,
    !VERT.includes(name));
}
check("the retired vein / v1-obsidian uniforms are GONE (no dead uniforms)",
  ["uCrackGlowDensity", "uCrackGlowWidth", "uObsidianShininess", "uObsidianSpecular", "uObsidianEnv"]
    .every((n) => !SRC.includes(n)));
check("no backticks anywhere in the fragment GLSL (they close the JS literal)",
  !FRAG.includes("`"));
check("the lava block is ASCII-only (GLSL template rule)",
  [...VOLC_BLOCK].every((c) => c.charCodeAt(0) < 128));
check("the lava block is part of the SHADER SOURCE, not a runtime patch",
  countOf(FRAG, MARKER) === 1 && !SRC.includes("CRACK_GLOW_BEGIN"));

// ===========================================================================
console.log("\n-- V2 gated on FAM_VOLCANO from uVertexTypes (trap T3) ------------");
// ===========================================================================
check("isVolcanoCode() is shaped exactly like isWaterCode() (same bound, same mask test)",
  /bool isVolcanoCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uVolcanoCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("the corner codes come from vertexTypeAt() — the 9x9 uVertexTypes "
  + "DataTexture, NOT the terrainCode attribute (trap T3)",
  /int t00 = vertexTypeAt\(/.test(FRAG) && /volcW = clamp\(/.test(FRAG)
  && /isVolcanoCode\(t00\)/.test(FRAG) && /isVolcanoCode\(t11\)/.test(FRAG));
check("the fragment stage never reads a terrainCode attribute",
  !/\bin float terrainCode\b/.test(FRAG) && !/\battribute float terrainCode\b/.test(FRAG));
check("the VERTEX stage still reads terrainCode (the water/lava branch is untouched)",
  /in float terrainCode;/.test(VERT));
check("no hardcoded volcano code anywhere in the fragment stage",
  !/c == 25|t00 == 25|c == 6 \|\|/.test(FRAG));
check("volcW uses the SAME four bilinear corner weights as the texture blend",
  /volcW = clamp\(\s*\n\s*\(isVolcanoCode\(t00\) \? w00 : 0\.0\) \+ \(isVolcanoCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isVolcanoCode\(t01\) \? w01 : 0\.0\) \+ \(isVolcanoCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));
check("volcW is computed next to sandW and waterW, from the same corner data",
  iVolcW > 0 && FRAG.indexOf("float sandW = clamp(") > 0
  && Math.abs(iVolcW - FRAG.indexOf("float sandW = clamp(")) < 2400);

// ===========================================================================
console.log("\n-- V3 no new geometry attribute → whitelist untouched -------------");
// ===========================================================================
check("terrain_batch.js still whitelists exactly [position, normal, terrainCode]",
  /\["position", "normal", "terrainCode"\]/.test(BATCH));
check("the batched-GLSL rewrite anchors are intact",
  BATCH.includes("uniform sampler2D uVertexTypes;")
  && BATCH.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);")
  && FRAG.includes("uniform sampler2D uVertexTypes;")
  && FRAG.includes("  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);"));
check("the lava block does not use uLbOriginXy (zeroed on the batched path)",
  !VOLC_BLOCK.includes("uLbOriginXy"));
check("the block adds no new varying",
  countOf(VOLC_BLOCK, "\nin ") === 0 && countOf(VOLC_BLOCK, "\nout ") === 0);

// ===========================================================================
console.log("\n-- V4 ordering: POM, the albedo chain, water bypass, emissive add --");
// ===========================================================================
check("the POM march, the water scroll, the water sheen and the block all exist",
  iPomMarch > 0 && iWaterScroll > 0 && iWaterSheen > 0 && iBlock > 0 && iFragColor > 0);
check("V4: the block is computed AFTER the POM march", iBlock > iPomMarch);
check("V4: … AFTER the far-macro modulation, i.e. at the END of the albedo chain "
  + "(result is the finished albedo it reads)", iMacro > 0 && iBlock > iMacro);
check("V4: … after the water sheen block (it never pre-empts water)", iBlock > iWaterSheen);
check("V4: … and before the final fragColor write", iBlock < iFragColor);
check("V4: the pulse phase reads the PARALLAX-CORRECTED ground point",
  /vec2 pomShiftV = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(VOLC_BLOCK)
  && /vec2 groundXy = vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ pomShiftV;/.test(VOLC_BLOCK));
check("V4: the block HONOURS the cellTouchesWater bypass (the gate the dirt suite pins)",
  /uCrackGlowEnabled > 0\.5 && !cellTouchesWater && volcW > 0\.0/.test(FRAG));
check("V4: EMISSIVE — added to iblSpec, NOT multiplied by cloudShadow/csmShadow",
  /iblSpec \+= result \* uCrackGlowColor/.test(VOLC_BLOCK)
  && !/cloudShadow|csmShadow/.test(codeOnly(VOLC_BLOCK)));
check("V4: THE FINAL fragColor LINE IS BYTE-UNCHANGED (no new term there)",
  checkTerrainFinalColour(FRAG).ok);
check("V4: a distance fade exists",
  /crackFade = 1\.0 - smoothstep\(uCrackGlowFadeStart, uCrackGlowFadeEnd, vViewDepth\)/.test(VOLC_BLOCK));
check("V4: the block never writes cellUv, waterCellUv, waterW, result or modulated",
  !/cellUv \+=|waterCellUv =|waterW =/.test(VOLC_BLOCK)
  && !/\bmodulated\s*[*+-]?=/.test(VOLC_BLOCK) && !/\bresult\s*[*+-]?=/.test(VOLC_BLOCK));

// ===========================================================================
console.log("\n-- T1 the texture's OWN cracks ----------------------------------");
// ===========================================================================
check("T1: the heat mask is the linear chroma r - max(0.55 g, b) of `result`",
  /float crackHeat = smoothstep\(uCrackGlowHeat\.x, uCrackGlowHeat\.y,\s*\n\s*result\.r - max\(0\.55 \* result\.g, result\.b\)\);/.test(VOLC_BLOCK));
check("T1: the emissive colour IS the texel colour (times a tint), not a constant",
  /iblSpec \+= result \* uCrackGlowColor\s*\n\s*\* \(crackGain \* crackW \* uCrackGlowBreath \* crackPulse\);/.test(VOLC_BLOCK));
check("T1: NO procedural vein field any more (no ridged-noise threshold)",
  !/abs\(n1 \* 2\.0 - 1\.0\)|veinXy|float vein\b/.test(VOLC_BLOCK));
check("T1: the default heat window is the measured one ([0.03, 0.25])",
  /const DEFAULT_CRACK_GLOW_HEAT = Object\.freeze\(\[0\.03, 0\.25\]\);/.test(SRC));
// Calibration against the real DAT textures (exported PNGs, 8-bit RGB/RGBA,
// decoded below with node:zlib — no dependency). Optional: the scratch export
// may not exist on another machine — skip, never fail, then.
/** Minimal PNG decoder: 8-bit, colour type 2 (RGB) or 6 (RGBA), no interlace. */
function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) return null;
      ct = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      out[(y * w + x) * 4] = cur[x * bpp];
      out[(y * w + x) * 4 + 1] = cur[x * bpp + 1];
      out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}
{
  const TEX = "/mnt/wbterminal1/tmp/claude-scratch/mirage-2026-10-23/terraintex/";
  const have = ["0x06006D54", "0x06006D56", "0x06006D6A"].every((n) => existsSync(`${TEX}${n}.png`));
  if (!have) {
    console.log("  [skip] DAT texture calibration (the PNG export is not on this machine)");
  } else {
    const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const heatFrac = (name, lo) => {
      const png = decodePng(readFileSync(`${TEX}${name}.png`));
      if (!png) return NaN;
      let n = 0, hot = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const r = lin(png.data[i]), g = lin(png.data[i + 1]), b = lin(png.data[i + 2]);
        if (r - Math.max(0.55 * g, b) > lo) hot += 1;
        n += 1;
      }
      return hot / n;
    };
    const lava = heatFrac("0x06006D54", 0.03);
    const obs = heatFrac("0x06006D56", 0.03);
    const ash = heatFrac("0x06006D6A", 0.03);
    check("T1: on the REAL Volcano1 texture the window lights the painted cracks (5-15 % of texels)",
      lava > 0.05 && lava < 0.15, `lava=${lava.toFixed(4)}`);
    // 9 / 13 stray texels of 262144 graze the window's lower edge (max heat
    // 0.045 / 0.072 => smoothstep weight <= 0.07); the family gate excludes
    // those codes anyway — the point is the window is not a "warm" detector.
    check("T1: … and essentially NOTHING on the ObsidianPlain or Volcano2 textures (< 0.01 %)",
      obs < 1e-4 && ash < 1e-4, `obsidian=${obs} ash=${ash}`);
  }
}

// ===========================================================================
console.log("\n-- T2 pulse + day scale -----------------------------------------");
// ===========================================================================
check("T2: the pulse is deterministic — noise of the ground point + the shared clock, <= 1 Hz",
  /float crackPhase = 6\.2831853 \* fragValueNoise2D\(groundXy \* 0\.05\) \+ uTime \* 0\.8;/.test(VOLC_BLOCK)
  && 0.8 / (2 * Math.PI) <= 1);
check("T2: the day scale reads the flat-ground retail light level (the snow exposure's measure)",
  /uAcSunColor \* max\(uAcSunVec\.z, 0\.0\) \+ uAcAmbColor \* uAcAmbLevel/.test(VOLC_BLOCK)
  && /mix\(1\.0, uCrackGlowDay, crackDay\)/.test(VOLC_BLOCK));
// 2026-10-24 — the night-specular fix gated the SUN-lit specular terms (sand,
// snow, ice, wet mud, obsidian glints) on the sun's elevation x |uAcSunVec|.
// The lava glow is EMISSIVE and must keep glowing at night: it never takes that
// gate (the day scale above DIMS it by day, night is its full strength).
check("T2: the crack glow is NOT night-gated (emissive: full strength at night)",
  !/smoothstep\(0\.05, 0\.25, sunDir\.z\)|length\(uAcSunVec\)|uSunGlint/.test(VOLC_BLOCK.replace(/\/\/[^\n]*/g, "")));

// ===========================================================================
console.log("\n-- V5 strict no-op when off --------------------------------------");
// ===========================================================================
check("ONE gate uniform guards the whole block",
  countOf(FRAG, "uCrackGlowEnabled > 0.5") === 1);
// 2026-10-24: and the two MASTER kill switches (terrainVfxShaderLive() =
// visualEnabled() && terrainVfxEnabled()), so ?visual=off / ?terrainVfx=off
// kill the glow as the docs say (behaviour: test_vfx_flags.mjs).
check("the gate is composed from the master kills, the family master AND the effect flag",
  /crackGlowEnabled: terrainVfxLive && terrainVolcanoEnabled\(\) && terrainCrackGlowEnabled\(\),/.test(SRC)
  && SRC.includes("const terrainVfxLive = terrainVfxShaderLive();"));
check("terrain.js imports the flag readers from vfx_flags.js (no second reader)",
  /import \{ terrainVolcanoEnabled, terrainCrackGlowEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));
check("the wave-1B sand import line is UNTOUCHED (its own suite locks it)",
  /import \{ terrainSandEnabled, terrainSandSparkleEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));
check("the wireframe short-circuit carries the fields off, for shape parity",
  /crackGlowEnabled: false,\s*\n\s*volcanoCodeMask: 0,\s*\n\s*obsidianCodeMask: 0,\s*\n\s*obsidianEnabled: false,/.test(SRC));

// ===========================================================================
console.log("\n-- V6 no water / sand regression ---------------------------------");
// ===========================================================================
check("water still bypasses POM on any water-touching cell",
  /if \(uPomEnabled > 0\.5 && vViewDepth < uPomFadeEnd && !cellTouchesWater\)/.test(FRAG));
check("the water scroll UV is still derived AFTER the POM march", iWaterScroll > iPomMarch);
check("the swell mask (uWaterCodeMask) is still vertex-stage only",
  VERT.includes("uWaterCodeMask") && !FRAG.includes("uniform int uWaterCodeMask;"));
check("the fragment stage still tests water through the wider surface mask",
  /uWaterSurfaceCodeMask & \(1 << c\)/.test(FRAG));
check("the lattice-locked swell is untouched", /waterSwellLattice/.test(VERT));
check("the water sheen block is still present and still fade-banded",
  /sheenFade = \(1\.0 - smoothstep\(uWaterSheenFade\.x, uWaterSheenFade\.y, vViewDepth\)\) \* footFade;/.test(FRAG));
check("the SAND sparkle block is still present, POM-corrected and shadow-multiplied",
  /=== Wave 1B — SAND GRAIN SPARKLE ===/.test(FRAG)
  && /vec2 pomShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(FRAG)
  && /sandSparkle \* cloudShadow \* csmShadow/.test(FRAG));
check("TERRAIN_LAVA_CODES is still the empty set and the vertex lava branch is "
  + "untouched (explicitly out of scope for this family)",
  /const TERRAIN_LAVA_CODES = new Set\(\[\]\);/.test(SRC) && /uLavaCodeMask/.test(VERT));

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
check("the derived mask agrees with terrain_volcano.js: lava (25) alone since the split",
  volcanoCodeBitmask() === ((1 << 25) >>> 0));
check("the constants are named, not magic numbers at the bind site",
  ["DEFAULT_CRACK_GLOW_STRENGTH", "DEFAULT_CRACK_GLOW_DAY", "DEFAULT_CRACK_GLOW_HEAT",
    "DEFAULT_CRACK_GLOW_COLOR", "DEFAULT_CRACK_GLOW_PULSE", "DEFAULT_CRACK_GLOW_BREATH",
    "DEFAULT_CRACK_GLOW_FADE_START", "DEFAULT_CRACK_GLOW_FADE_END"].every((k) => SRC.includes(k)));
check("the mid-tier degrade is coherent: nothing in the block requires POM",
  !VOLC_BLOCK.includes("uPomEnabled"));
check("every live knob in terrain_volcano.js CRACK_GLOW_KNOBS names a bound uniform",
  await (async () => {
    const { CRACK_GLOW_KNOBS } = await import("./scene3d/terrain_volcano.js");
    return Object.values(CRACK_GLOW_KNOBS).every((k) => new RegExp(`${k.uniform}: \\{`).test(SRC));
  })());

// ===========================================================================
console.log("\n-- V8 the breath is PUSHED, not bound by reference ----------------");
// ===========================================================================
check("loop.js imports the oscillator name from terrain_volcano.js",
  /import \{ CRACK_GLOW_OSC_NAME \} from "\.\/terrain_volcano\.js";/.test(LOOP));
check("loop.js reads the registered channel through getOscillator",
  /getOscillator\(CRACK_GLOW_OSC_NAME\)/.test(LOOP));
check("loop.js PUSHES it onto every terrain material next to uTime",
  /mat\.uniforms\.uCrackGlowBreath\.value = breath;/.test(LOOP)
  && /for \(const mat of scene3d\.terrainMaterials\)/.test(LOOP));
check("V8: the PUSH is necessary — terrain_batch.js still CLONES uniform values",
  /uniforms\[name\] = \{ value: _cloneUniformValue\(u \? u\.value : null\) \};/.test(BATCH));

console.log(`\nterrain volcano shader: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
