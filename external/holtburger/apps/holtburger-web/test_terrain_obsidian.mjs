// test_terrain_obsidian.mjs — OBSIDIAN GLASS (2026-10-23, the volcano split):
// `scene3d/terrain_obsidian.js` + the `OBSIDIAN GLASS` block of the terrain
// fragment shader (`scene3d/terrain.js`).
//
// The owner, on the 1070: "we have obsidian plains and dark isles texture mixed
// up with lava, should make new effect for obsidian". Code 6 (ObsidianPlain,
// 0x06006D56: dark purple mottled glass, no lava) left FAM_VOLCANO for its own
// family, FAM_OBSIDIAN, with its own effect: sparse sharp sun glints on glass
// facets + a dark purple sheen at grazing angles. NO glow, NO embers, NO shimmer.
//
// Locks:
//   F1  FAMILY: the code set is DERIVED from terrain_families.js (= [6]) — in
//       this module AND in terrain.js — and obsidian draws none of the lava
//       effects (not FAM_VOLCANO; the shader block references no crack glow).
//   F2  FLAG: `?terrainObsidian` is a STRICT `=== "on"` opt-in (promoted 2026-10-24: on at high/ultra);
//       the preset key is `terrainMaster("obsidian", tier)` on all four tiers,
//       `TERRAIN_VFX_PROMOTED.obsidian === true` (2026-10-24), it is out of BOOL_FLAGS,
//       it has a firewall row (`?visual=off` kills it) and it is independent
//       of `?terrainVolcano`.
//   F3  LIFECYCLE: `initTerrainObsidian` registers NOTHING with the flag off,
//       and one camera-scope provider with it on.
//   K1  KNOBS: `tune()` writes the terrain uniforms now, the provider
//       re-asserts them every frame (later materials included), values clamp,
//       `tune(null)` writes the captured defaults back once, then stops.
//   G1  SHADER: every uniform declared once (fragment only) and bound; an
//       `isObsidianCode()` helper shaped like `isWaterCode()`; a bilinear
//       `obsidianW`; the block sits AFTER the cast shadows resolve, honours the
//       cellTouchesWater bypass, reads the PARALLAX-CORRECTED ground point, and
//       only ADDS to `iblSpec` (albedo, cellUv, water and the final fragColor
//       line untouched); ASCII-only, no backticks.
//   G2  GLINTS are sunlight (cloud x CSM x sun up AND bright -- exactly 0 at the
//       retail night since 2026-10-24 -- x uSunGlint), footprint-faded,
//       facet normals hashed about the macro normal (deterministic), a round
//       pixel-space core; the SHEEN is a capped glass Fresnel of a blurred sky
//       reflection, tinted, distance-eased — and it is NOT emissive.
//   G3  The ASSEMBLED program (every interpolation resolved) carries the block
//       and its facet Jacobian at main() scope.
//
// Run from apps/holtburger-web/:  node test_terrain_obsidian.mjs

import { readFileSync } from "node:fs";
import { checkTerrainFinalColour } from "./harness/lib/terrain_final_colour.mjs";
import { FAM_OBSIDIAN, FAM_VOLCANO, familyForCode } from "./scene3d/terrain_families.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

function setUrl(search, qualityFlags = null) {
  globalThis.window = { location: { search } };
  if (qualityFlags) globalThis.window.liveScene3d = { quality: { flags: { ...qualityFlags } } };
}
function clearUrl() { delete globalThis.window; }

const flags = await import("./scene3d/vfx_flags.js");
const { _resetVfxFlags, terrainObsidianEnabled, terrainVolcanoEnabled, vfxEffectEnabled, VFX_EFFECT_FLAGS } = flags;
const { _resetVfxCatalog } = await import("./scene3d/vfx_catalog.js");
const obs = await import("./scene3d/terrain_obsidian.js");
const vfx = await import("./scene3d/terrain_vfx.js");
const { PRESETS, PRESET_NAMES, TERRAIN_VFX_PROMOTED, terrainMaster } = await import("./scene3d/quality.js");

const SRC = readFileSync("./scene3d/terrain.js", "utf8");
const OBS_SRC = readFileSync("./scene3d/terrain_obsidian.js", "utf8");
const INDEX_SRC = readFileSync("./scene3d/index.js", "utf8");
const QUALITY_SRC = readFileSync("./scene3d/quality.js", "utf8");
const FLAGS_DOC = readFileSync("./docs/url-flags.md", "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ===========================================================================
console.log("\n-- F1 the family -------------------------------------------------");
// ===========================================================================
check("F1: the obsidian codes are DERIVED from terrain_families (= [6])",
  JSON.stringify(obs.obsidianTerrainCodes()) === "[6]", JSON.stringify(obs.obsidianTerrainCodes()));
check("F1: obsidianCodeBitmask() is bit 6 alone, and 6 is the retail ObsidianPlain enum value",
  obs.obsidianCodeBitmask() === (1 << 6) && obs.TERRAIN_CODE_OBSIDIAN_PLAIN === 6);
check("F1: code 6 is FAM_OBSIDIAN and NOT FAM_VOLCANO (no lava effects can reach it)",
  familyForCode(6) === FAM_OBSIDIAN && familyForCode(6) !== FAM_VOLCANO);
check("F1: terrain.js derives its shader set from FAM_OBSIDIAN too (no hardcoded [6])",
  /familyForCode\(c\) === FAM_OBSIDIAN/.test(SRC)
  && !/TERRAIN_OBSIDIAN_CODES = Object\.freeze\(new Set\(\[6\]\)\)/.test(SRC)
  && /obsidianCodeMask: computeCodeBitmask\(TERRAIN_OBSIDIAN_CODES\)/.test(SRC));

// ===========================================================================
console.log("\n-- F2 the flag ---------------------------------------------------");
// ===========================================================================
clearUrl(); _resetVfxFlags();
check("F2: no window ⇒ off", terrainObsidianEnabled() === false);
// PROMOTED 2026-10-24 (the owner's vistest tour): on at high / ultra, off at
// low / mid. A non-"on"/"off" value is not an opt-in: it falls back to the tier.
setUrl("", PRESETS.ultra); _resetVfxFlags();
check("F2: no URL + the ultra preset ⇒ ON (promoted 2026-10-24)",
  terrainObsidianEnabled() === true);
setUrl("", PRESETS.mid); _resetVfxFlags();
check("F2: no URL + the mid preset ⇒ OFF (the {high, ultra} ladder)",
  terrainObsidianEnabled() === false);
for (const bad of ["1", "true", "yes", "ON"]) {
  setUrl(`?terrainObsidian=${bad}`, PRESETS.mid); _resetVfxFlags();
  check(`F2: ?terrainObsidian=${bad} does NOT enable on a tier without it (strict === "on")`, terrainObsidianEnabled() === false);
}
setUrl("?terrainObsidian=on", PRESETS.low); _resetVfxFlags();
check("F2: ?terrainObsidian=on enables it (any tier — an eye-test override)", terrainObsidianEnabled() === true);
setUrl("?terrainObsidian=off", { ...PRESETS.high, terrainObsidian: true }); _resetVfxFlags();
check("F2: ?terrainObsidian=off beats a promoted preset", terrainObsidianEnabled() === false);
setUrl("?terrainObsidian=on&terrainVolcano=off", PRESETS.high); _resetVfxFlags();
check("F2: independent of the volcano master (volcano off, obsidian on)",
  terrainObsidianEnabled() === true && terrainVolcanoEnabled() === false);
check("F2: TERRAIN_VFX_PROMOTED.obsidian === true (promoted after the 2026-10-24 vistest)",
  TERRAIN_VFX_PROMOTED.obsidian === true);
check("F2: every tier carries terrainObsidian = terrainMaster('obsidian', tier)",
  PRESET_NAMES.every((t) => PRESETS[t].terrainObsidian === terrainMaster("obsidian", t)));
check("F2: … i.e. the high/ultra ladder: on at high / ultra, off at low / mid",
  PRESET_NAMES.every((t) => PRESETS[t].terrainObsidian === (t === "high" || t === "ultra"))
  && terrainMaster("obsidian", "high") === true);
check("F2: the master is OUT of BOOL_FLAGS (parseBool would widen the strict opt-in)",
  (() => {
    const bools = QUALITY_SRC.slice(QUALITY_SRC.indexOf("const BOOL_FLAGS"), QUALITY_SRC.indexOf("const INT_FLAGS"));
    return !bools.includes('"terrainObsidian"');
  })());
check("F2: the firewall row exists and IS the reader",
  VFX_EFFECT_FLAGS["terrain.obsidian"] === terrainObsidianEnabled
  && obs.OBSIDIAN_PROVIDER_ID === "terrain.obsidian");
setUrl("?terrainObsidian=on&visual=off", PRESETS.high); _resetVfxCatalog(); _resetVfxFlags();
check("F2: ?visual=off kills it through the firewall", vfxEffectEnabled("terrain.obsidian") === false);
setUrl("?terrainObsidian=on", PRESETS.high); _resetVfxCatalog(); _resetVfxFlags();
check("F2: … and it is live with ?visual absent", vfxEffectEnabled("terrain.obsidian") === true);
check("F2: the reset seam forgets the memo",
  (() => { setUrl("", PRESETS.mid); _resetVfxFlags(); return terrainObsidianEnabled() === false; })());

// ===========================================================================
console.log("\n-- F3 lifecycle --------------------------------------------------");
// ===========================================================================
// (mid: the promoted master is off there — high / ultra light it since 2026-10-24.)
setUrl("", PRESETS.mid); _resetVfxFlags();
vfx._resetTerrainVfx(); obs._resetTerrainObsidian();
check("F3: flag off ⇒ initTerrainObsidian returns null and registers NOTHING",
  obs.initTerrainObsidian({ scene3d: {} }) === null && vfx.terrainVfxStats().providers.length === 0);
setUrl("?terrainObsidian=on", PRESETS.high); _resetVfxFlags();
const mkMat = () => ({ uniforms: {
  uObsidianEnabled: { value: 1 }, uObsidianGlint: { value: 6 }, uObsidianSheen: { value: 0.3 },
  uObsidianGlintFade: { value: { x: 40, y: 120 } },
  uObsidianSheenColor: { value: { x: 0.62, y: 0.42, z: 1.0 } },
} });
const mats = [mkMat()];
const scene3d = { terrainGroup: { children: [] }, frameTime: { tsSec: 0 }, terrainMaterials: mats };
vfx.initTerrainVfx({ scene3d });
const surf = obs.initTerrainObsidian({ scene3d });
const provs = vfx.terrainVfxStats().providers;
check("F3: flag on ⇒ ONE camera-scope provider, id terrain.obsidian",
  !!surf && provs.length === 1 && provs[0].id === "terrain.obsidian" && provs[0].scope === "camera",
  JSON.stringify(provs));
check("F3: a second init is idempotent", obs.initTerrainObsidian({ scene3d }) !== null
  && vfx.terrainVfxStats().providers.length === 1);
check("F3: the stats surface", (() => {
  const s = obs.terrainObsidianStats();
  return s.enabled === true && s.inited === true && s.obsidianCodeMask === 64
    && JSON.stringify(s.obsidianCodes) === "[6]" && typeof s.counters === "object";
})());

// ===========================================================================
console.log("\n-- K1 live knobs -------------------------------------------------");
// ===========================================================================
const got = surf.tune({ glint: 9, sheenColor: [0.5, 0.3, 0.9], glintFade: [60, 200], nope: 1 });
check("K1: tune() writes the uniforms NOW",
  mats[0].uniforms.uObsidianGlint.value === 9
  && mats[0].uniforms.uObsidianSheenColor.value.y === 0.3
  && mats[0].uniforms.uObsidianGlintFade.value.y === 200);
check("K1: it reports the live overrides by knob name (unknown knobs ignored)",
  got.glint === 9 && Array.isArray(got.sheenColor) && !("nope" in got));
mats.push(mkMat());
vfx.terrainVfxTick(0.016, scene3d);
check("K1: a material that appears later gets the override on the next frame",
  mats[1].uniforms.uObsidianGlint.value === 9 && mats[1].uniforms.uObsidianSheenColor.value.z === 0.9);
check("K1: values clamp to the knob range", surf.tune({ glint: 1e6 }).glint === 64);
check("K1: a malformed vector knob is ignored, not half-applied",
  (() => { const before = surf.tune({}).sheenColor.join(); return surf.tune({ sheenColor: [1] }).sheenColor.join() === before; })());
surf.tune(null);
// 2026-10-24 verify pass: tune(null) is the vistest's RESET, so it must write
// the defaults back (it used to only stop pushing, leaving every resident
// material and the batched one on the last override for the whole session).
check("K1: tune(null) RESTORES the captured defaults on every material it overrode",
  mats.every((m) => m.uniforms.uObsidianGlint.value === 6
    && m.uniforms.uObsidianSheenColor.value.x === 0.62 && m.uniforms.uObsidianSheenColor.value.y === 0.42
    && m.uniforms.uObsidianSheenColor.value.z === 1.0
    && m.uniforms.uObsidianGlintFade.value.x === 40 && m.uniforms.uObsidianGlintFade.value.y === 120),
  JSON.stringify(mats.map((m) => m.uniforms.uObsidianGlint.value)));
mats.push(mkMat());
mats[2].uniforms.uObsidianGlint.value = 7;   // a value only a push could clobber
vfx.terrainVfxTick(0.016, scene3d);
check("K1: … then the push STOPS (one write-back, nothing re-asserted)",
  mats[2].uniforms.uObsidianGlint.value === 7 && mats[0].uniforms.uObsidianGlint.value === 6);
mats[2].uniforms.uObsidianGlint.value = 6;
check("K1: the write-back restores the TRUE default even after a re-override queued over it",
  (() => {
    const ov = obs.createUniformOverrides(obs.OBSIDIAN_KNOBS);
    const m = [mkMat()];
    ov.set({ glint: 9, enabled: 0 }); ov.push(m);
    ov.set(null);                 // queued, not yet pushed
    ov.set({ glint: 10 }); ov.push(m);
    ov.set(null); ov.push(m);
    const ok = m[0].uniforms.uObsidianGlint.value === 6 && m[0].uniforms.uObsidianEnabled.value === 1
      && ov.active === false;
    ov.set({ glint: 3 }); ov.reset();
    return ok && ov.active === false && ov.size === 0;
  })());
check("K1: every knob names a uniform the terrain material binds",
  Object.values(obs.OBSIDIAN_KNOBS).every((k) => new RegExp(`${k.uniform}: \\{`).test(SRC)));
check("K1: the push is allocation-free (flat preallocated arrays, no per-frame object)",
  /function push\(materials\)/.test(OBS_SRC) && !/push\(materials\)[\s\S]{0,900}\bnew \w+\(/.test(OBS_SRC.slice(OBS_SRC.indexOf("function push(materials)"), OBS_SRC.indexOf("function current()"))));
obs._resetTerrainObsidian();
vfx._resetTerrainVfx();
check("F3: the reset seam unregisters the provider", vfx.terrainVfxStats().providers.length === 0);

// ===========================================================================
console.log("\n-- G1 the shader block -------------------------------------------");
// ===========================================================================
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
const MARKER = "=== 2026-10-23 - OBSIDIAN GLASS (FAM_OBSIDIAN, ?terrainObsidian)";
const iBlock = FRAG.indexOf(MARKER);
const BLOCK = FRAG.slice(iBlock, FRAG.indexOf("=== Wave 3B", iBlock));
const CODE = BLOCK.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const UNIFORMS = [
  ["uObsidianEnabled", "float"], ["uObsidianCodeMask", "int"], ["uObsidianGlint", "float"],
  ["uObsidianGlintDensity", "float"], ["uObsidianGlintFrac", "float"],
  ["uObsidianGlintSharpness", "float"], ["uObsidianGlintCorePx", "float"],
  ["uObsidianGlintFade", "vec2"], ["uObsidianSheen", "float"], ["uObsidianSheenColor", "vec3"],
  ["uObsidianSheenFade", "vec2"],
];
for (const [name, type] of UNIFORMS) {
  check(`G1: ${name} declared exactly once, fragment stage only, and bound`,
    countOf(FRAG, `uniform ${type} ${name};`) === 1 && !VERT.includes(name)
    && new RegExp(`${name}: \\{`).test(SRC));
}
check("G1: the block exists exactly once", iBlock > 0 && countOf(FRAG, MARKER) === 1);
check("G1: ASCII-only and no backticks", [...BLOCK].every((c) => c.charCodeAt(0) < 128) && !BLOCK.includes("`"));
check("G1: isObsidianCode() is shaped exactly like isWaterCode()",
  /bool isObsidianCode\(int c\) \{\s*\n\s*return c >= 0 && c < 32 && \(uObsidianCodeMask & \(1 << c\)\) != 0;/.test(FRAG));
check("G1: obsidianW is the bilinear corner fraction from uVertexTypes (trap T3)",
  /obsidianW = clamp\(\s*\n\s*\(isObsidianCode\(t00\) \? w00 : 0\.0\) \+ \(isObsidianCode\(t10\) \? w10 : 0\.0\) \+\s*\n\s*\(isObsidianCode\(t01\) \? w01 : 0\.0\) \+ \(isObsidianCode\(t11\) \? w11 : 0\.0\), 0\.0, 1\.0\);/.test(FRAG));
check("G1: no hardcoded obsidian code in the fragment stage", !/c == 6\b|t00 == 6\b/.test(FRAG));
check("G1: the block runs AFTER the cast shadows resolve (cloudShadow, csmShadow) and after the ice",
  iBlock > FRAG.indexOf("float cloudShadow = 1.0;") && iBlock > FRAG.indexOf("float csmShadow = 1.0;")
  && iBlock > FRAG.indexOf("iblSpec += iceSpec * iceW;"));
check("G1: … and before the final colour", iBlock < FRAG.indexOf("fragColor = vec4("));
check("G1: one gate: the flag uniform AND the obsidian fraction AND the water bypass",
  /if \(uObsidianEnabled > 0\.5 && obsidianW > 0\.0 && !cellTouchesWater\) \{/.test(CODE)
  && countOf(FRAG, "uObsidianEnabled > 0.5") === 1);
check("G1: the facet field reads the PARALLAX-CORRECTED ground point",
  /vec2 obsShift = \(cellUv - vec2\(fu, fv\)\) \* 24\.0;/.test(CODE)
  && /vec2 obsGp = vec2\(vWorldPos\.x, -vWorldPos\.z\) \+ obsShift;/.test(CODE));
check("G1: it only ADDS to iblSpec — never result, modulated, cellUv or a water term",
  (CODE.match(/iblSpec \+=/g) || []).length === 2
  && !/\bresult\s*[*+-]?=|\bmodulated\s*[*+-]?=|cellUv \+=|waterCellUv =|waterW =/.test(CODE));
check("G1: NO lava: the block references no crack-glow term and no emissive colour",
  !/uCrackGlow|volcW/.test(CODE));
check("G1: the final fragColor line is byte-unchanged", checkTerrainFinalColour(FRAG).ok);
check("G1: the gate is composed from the reader in resolveTerrainRingOpts, and wireframe carries it off",
  /obsidianEnabled: terrainVfxLive && terrainObsidianEnabled\(\),/.test(SRC)
  && SRC.includes("const terrainVfxLive = terrainVfxShaderLive();")
  && /obsidianCodeMask: 0,\s*\n\s*obsidianEnabled: false,/.test(SRC)
  && /uObsidianEnabled: \{ value: opts\.obsidianEnabled \? 1\.0 : 0\.0 \}/.test(SRC));
check("G1: terrain.js reads the flag through vfx_flags.js (no second reader)",
  /import \{ terrainObsidianEnabled \} from "\.\/vfx_flags\.js";/.test(SRC));

// ===========================================================================
console.log("\n-- G2 glints + sheen ---------------------------------------------");
// ===========================================================================
// 2026-10-24 — THE NIGHT-SPECULAR FIX: the sun term is the sand sparkle's
// (elevation smoothstep 0.05..0.25 x min(1.25 |uAcSunVec|, 1)); uSunGlint stays.
check("G2: glints are SUNLIGHT — cloud x CSM x sun up AND bright x uSunGlint",
  /clamp\(\(cloudShadow - 0\.3\) \/ 0\.7, 0\.0, 1\.0\)\s*\n\s*\* clamp\(\(csmShadow - 0\.45\) \/ 0\.55, 0\.0, 1\.0\)\s*\n\s*\* smoothstep\(0\.05, 0\.25, sunDir\.z\) \* min\(length\(uAcSunVec\) \* 1\.25, 1\.0\) \* uSunGlint;/.test(CODE));
{
  // uSunGlint is 1.0 whenever ?nightRamp=off, and the old smoothstep(0, 0.12)
  // elevation ramp was ~4.7 % at the retail night pitch (0.9 deg): glints all
  // night. The new term is EXACTLY 0 there whatever uSunGlint says.
  const DEG = Math.PI / 180;
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const gate = (pitchDeg, dirBright) => ss(0.05, 0.25, Math.sin(pitchDeg * DEG)) * Math.min(dirBright * 1.25, 1);
  check("G2: NIGHT — retail night (pitch 0.9 deg, dirBright 0.25) => exactly 0 (the old ramp was > 4 %); noon => 1",
    gate(0.9, 0.25) === 0 && Math.abs(gate(67.4, 0.8) - 1) < 1e-12 && ss(0.0, 0.12, Math.sin(0.9 * DEG)) > 0.04);
  check("G2: NIGHT — the glint is the block's ONLY uAcSunColor term (the sheen is sky light)",
    (CODE.match(/uAcSunColor/g) || []).length === 1 && /iblSpec \+= uAcSunColor \* \(uObsidianGlint/.test(CODE));
}
check("G2: glints fade with distance AND where a facet drops under a pixel",
  /obsFade = 1\.0 - smoothstep\(uObsidianGlintFade\.x, uObsidianGlintFade\.y, vViewDepth\);/.test(CODE)
  && /obsFade \*= 1\.0 - smoothstep\(0\.4, 0\.9, obsFoot\);/.test(CODE));
// 2026-10-24: landblock-local, integer-keyed lattice (hbCellHash3) — the sin
// hash on the world cell index drew straight dotted lines (1070 vistest tour).
check("G2: facets are a deterministic HASH of the ground cell (no time, no random)",
  /vec2 facetXy = \(grid \* 24\.0 \+ obsShift\) \* uObsidianGlintDensity;/.test(CODE)
  && /vec2 fcell = floor\(facetXy\);/.test(CODE) && /hbCellHash3\(fcell, hbLbKey, 6u\)\.x < uObsidianGlintFrac/.test(CODE)
  && !/fragHash21\(fcell/.test(CODE) && !/uTime/.test(CODE));
check("G2: facet normals are tilted about the MACRO normal (slopes keep their glints)",
  /vec3 facetN = normalize\(geomN \* \(0\.6 \+ 0\.8 \* fh3\)/.test(CODE));
check("G2: a round PIXEL-space core through the inverse facet-grid Jacobian (the snow recipe)",
  /float obsCore = exp\(-dot\(obsPx, obsPx\) \/ \(2\.0 \* obsSig \* obsSig\)\);/.test(CODE)
  && /float obsDet = obsJx\.x \* obsJy\.y - obsJy\.x \* obsJx\.y;/.test(CODE));
check("G2: the facet Jacobian is taken at main() scope (uniform control flow), before the gate",
  BLOCK.indexOf("vec2 obsJx") >= 0 && BLOCK.indexOf("vec2 obsJx") < BLOCK.indexOf("if (uObsidianEnabled > 0.5")
  && /gTerrainGridDx \* \(24\.0 \* uObsidianGlintDensity\)/.test(BLOCK)
  && /dFdx\(obsGrid\)/.test(BLOCK));
// 2026-10-24 (1070 vistest, 0xC8ED): fragValueNoise2D returns [-0.5, 0.5]. Read
// raw, the glassy smoothstep(0.3, 0.72) fired only in rare blobs — a pink stain
// — and (obsB - 0.5) tilted every facet the same way. All three are shifted to [0, 1].
check("G2: the sheen noises are shifted onto [0, 1] (fragValueNoise2D is centred on 0)",
  /float obsA = fragValueNoise2D\(obsGp \* 0\.071\) \+ 0\.5;/.test(CODE)
  && /float obsB = fragValueNoise2D\(obsGp \* 0\.31 \+ vec2\(17\.3, 4\.1\)\) \+ 0\.5;/.test(CODE)
  && /float obsC = fragValueNoise2D\(obsGp \* 0\.31 \+ vec2\(2\.9, 33\.7\)\) \+ 0\.5;/.test(CODE)
  && /return \(mix\(mix\(a, b, u\), mix\(c, d, u\), v\) - 0\.5\);/.test(SRC));
check("G2: the sheen is a capped glass Fresnel (F0 0.045, max 0.6) of a BLURRED sky reflection",
  /float obsFres = min\(0\.045 \+ 0\.955 \* pow\(1\.0 - obsCos, 5\.0\), 0\.6\);/.test(CODE)
  && /textureLod\(uEnvCube, obsRefl, 3\.0\)/.test(CODE) && /if \(uIblEnabled > 0\.5\) \{/.test(CODE));
check("G2: … tinted purple and eased (never removed) with distance",
  /obsSky \* uObsidianSheenColor/.test(CODE)
  && /1\.0 - 0\.6 \* smoothstep\(uObsidianSheenFade\.x, uObsidianSheenFade\.y, vViewDepth\)/.test(CODE));
check("G2: the reflection never mirrors the ground half of the cube", /obsRefl\.y = abs\(obsRefl\.y\);/.test(CODE));
check("G2: named defaults (no magic numbers at the bind site)",
  ["DEFAULT_OBSIDIAN_GLINT", "DEFAULT_OBSIDIAN_GLINT_DENSITY", "DEFAULT_OBSIDIAN_GLINT_FRAC",
    "DEFAULT_OBSIDIAN_GLINT_SHARPNESS", "DEFAULT_OBSIDIAN_GLINT_CORE_PX", "DEFAULT_OBSIDIAN_GLINT_FADE",
    "DEFAULT_OBSIDIAN_SHEEN", "DEFAULT_OBSIDIAN_SHEEN_COLOR", "DEFAULT_OBSIDIAN_SHEEN_FADE"]
    .every((k) => new RegExp(`const ${k} = `).test(SRC)));

// ===========================================================================
console.log("\n-- G3 the assembled program ----------------------------------------");
// ===========================================================================
{
  const terrain = await import("./scene3d/terrain.js");
  const { fragment } = terrain._terrainGlslForTest();
  const i = fragment.indexOf(MARKER);
  const asm = fragment.slice(i, fragment.indexOf("=== Wave 3B", i));
  check("G3: the assembled fragment carries the block once", i > 0 && countOf(fragment, MARKER) === 1);
  check("G3: the Jacobian interpolation resolved to real GLSL (no `${` left)",
    /vec2 obsJx = /.test(asm) && !asm.includes("${"));
  check("G3: braces balance in the assembled block",
    countOf(asm, "{") === countOf(asm, "}"));
  check("G3: every obsidian uniform the block uses is declared in the assembled program",
    UNIFORMS.every(([n, t]) => fragment.includes(`uniform ${t} ${n};`)));
}

// ===========================================================================
console.log("\n-- wiring + docs -------------------------------------------------");
// ===========================================================================
check("index.js constructs the family and exposes window.__terrainObsidian",
  /import \{ initTerrainObsidian \} from "\.\/terrain_obsidian\.js";/.test(INDEX_SRC)
  && /const obsidianSurface = initTerrainObsidian\(\{ scene3d: liveScene3d \}\);/.test(INDEX_SRC)
  && /window\.__terrainObsidian = obsidianSurface;/.test(INDEX_SRC));
check("terrain_obsidian.js imports no three and never calls Math.random (§5.5)",
  !/^import .*from "three"/m.test(OBS_SRC) && !/Math\.random/.test(stripComments(OBS_SRC)));
check("docs/url-flags.md documents ?terrainObsidian with its reader",
  (() => {
    const row = FLAGS_DOC.split("\n").find((l) => l.startsWith("| `terrainObsidian` |"));
    return !!row && /terrainObsidianEnabled/.test(row) && /STRICT/.test(row);
  })());

clearUrl(); _resetVfxFlags();
console.log(`\nterrain obsidian: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
