// test_terrain_volcano.mjs — VOLCANO / OBSIDIAN terrain VFX (Wave 2B:
// `scene3d/terrain_volcano.js`, `scene3d/vfx/heat_haze_effect.js`,
// `scene3d/vfx/components/terrainVolcanoEmbers.js`).
//
// The terrain-FRAGMENT half of this family (crack glow + obsidian specular)
// has its own suite, `test_terrain_volcano_shader.mjs`, deliberately kept
// separate so the shader commit is self-contained for rebase.
//
// Locks (docs/2026-07-31-terrain-vfx-plan.md §3.6 "Tests", plus the invariants
// §5.1-§5.9 every terrain-VFX module signs up to):
//   H1  The heat-haze Effect CONSTRUCTS with `EffectAttribute.DEPTH` and
//       EXPOSES `mainUv` (the cheapest effect class — a pure UV warp).
//   H2  It DECODES LOG DEPTH (trap T4): a source scan for `exp2(`, reading the
//       RAW `depthBuffer` texel rather than pmndrs' already-decoding
//       `readDepth()` helper — and the decode survives pmndrs' uniform/function
//       prefixing intact.
//   H3  It is inserted into the EXISTING `EffectPass`: adding it changes
//       `composer.passes.length` by ZERO, it is the FIRST effect in the pass,
//       and `createHeatHazeEffect()` returns `null` when off so
//       `filter(Boolean)` drops the slot entirely.
//   H4  It BINDS THE SHARED CLOCK BY IDENTITY (§5.6) — `VFX_GLOBALS.uTime`, the
//       same `{value}` object the oscillator tick writes — and the identity
//       still holds after pmndrs re-keys the uniform into the compound
//       material.
//   H5  `uHeatRadius → 0` WITH NO VOLCANIC LB RESIDENT. Evict clears it; PARK
//       clears it too (a parked LB's terrain mesh is detached from
//       terrainGroup, so it is not on screen); unpark restores it.
//   E1  THE EMBER RE-ANCHOR produces THE SAME EMITTER SPEC AS THE BRAZIER PATH
//       MODULO ANCHOR — field-for-field `emitterInfo` equality against
//       `brazierEmbers.emit()` on the same config, with only `parentOffset`
//       (and `partIndex`) differing.
//   E2  VENT PLACEMENT IS HASH-STABLE per lbKey, lands only on FAM_VOLCANO
//       vertices, and takes DISTINCT vertices (§5.5).
//   E3  PARK STOPS EMISSION AND DESTROYS NOTHING; EVICT calls
//       `destroyAllForOwner` EXACTLY ONCE on the `:volcano`-SCOPED key, never
//       the bare `static:<lb>` key (which a mere LOD rebake would then reap).
//   E4  The ember DESCRIPTOR passes the VFX firewall: manifest lint (layer A),
//       source denylist (layer B — a per-component test responsibility, plan
//       §5.1), `lightCountDelta 0`, `cacheKeyScope "none"`, `linkVariant() ===
//       ""`, and a gated-out env synthesizes NO emitter at all.
//   F1  SHIP-OFF: with no URL flags every volcano flag reads false,
//       `initTerrainVolcano` registers NOTHING and allocates NOTHING, and the
//       DEFAULT-ON effect count is still 14.
//   F2  The quality ladder matches plan §3.6 (`low: null`), and the volcano
//       code set is DERIVED from `terrain_families.js`, never hardcoded.
//   O1  The crack-glow BREATHING OSCILLATOR rides the shared registry, is
//       ≤ 1 Hz (so the tick's 3600 s clock wrap is phase-continuous), and its
//       range is bounded.
//
// Run from apps/holtburger-web/:  node test_terrain_volcano.mjs
// (`three` + `postprocessing` resolve as bare imports via node_modules — the
// plan §6 tier for anything touching a real Effect/EffectPass.)

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { BlendFunction, EffectAttribute, EffectPass, VignetteEffect } from "postprocessing";
import { FAM_VOLCANO, FAM_GRASS, familyForCode } from "./scene3d/terrain_families.js";
import { lintManifest, lintSource } from "./scene3d/vfx/lint_caps.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

// ---------------------------------------------------------------------------
// URL + quality harness. Every flag reader memoizes, so the window has to be in
// place BEFORE the first read and `_resetVfxFlags()` after every change.
// ---------------------------------------------------------------------------
const HIGH_FLAGS = {
  terrainVolcano: false,
  terrainHaze: true,
  terrainCrackGlow: true,
  terrainVolcanoEmberCount: 1,
  terrainHazeStrength: 1,
  terrainVolcanoRadius: 160,
};
function setUrl(search, qualityFlags = HIGH_FLAGS) {
  globalThis.window = {
    location: { search },
    liveScene3d: { quality: { flags: { ...qualityFlags } } },
  };
}
function clearUrl() { delete globalThis.window; }

const { _resetVfxFlags, terrainVolcanoEnabled, terrainHazeEnabled,
  terrainEmbersEnabled, terrainCrackGlowEnabled, vfxEffectEnabled,
  VFX_EFFECT_FLAGS } = await import("./scene3d/vfx_flags.js");

const volc = await import("./scene3d/terrain_volcano.js");
const { terrainVolcanoEmbers, volcanoEmberGate, gatedVentConfig, ventHash01, VENT_GATE_MIN } =
  await import("./scene3d/vfx/components/terrainVolcanoEmbers.js");
const { brazierEmbers } = await import("./scene3d/vfx/components/brazierEmbers.js");
const vfx = await import("./scene3d/terrain_vfx.js");
const { VFX_GLOBALS } = await import("./scene3d/materials.js");
const haze = await import("./scene3d/vfx/heat_haze_effect.js");
const { PRESETS } = await import("./scene3d/quality.js");

const HAZE_SRC = readFileSync("./scene3d/vfx/heat_haze_effect.js", "utf8");
const PIPE_SRC = readFileSync("./scene3d/atmosphere_pipeline.js", "utf8");
const EMBER_SRC = readFileSync("./scene3d/vfx/components/terrainVolcanoEmbers.js", "utf8");
const INDEX_SRC = readFileSync("./scene3d/index.js", "utf8");
const VOLC_SRC = readFileSync("./scene3d/terrain_volcano.js", "utf8");

/** Comment-stripped source, the `lint_caps.js::lintSource` convention — these
 *  files DOCUMENT the `Math.random` ban in prose, so a raw scan would fail on
 *  its own comment. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const HAZE_CODE = stripComments(HAZE_SRC);
const EMBER_CODE = stripComments(EMBER_SRC);
const VOLC_CODE = stripComments(VOLC_SRC);

// ===========================================================================
console.log("\n-- F2 family + quality ladder ----------------------------------");
// ===========================================================================
check("volcano codes are DERIVED from terrain_families (6, 25, 26)",
  JSON.stringify(volc.volcanoTerrainCodes()) === JSON.stringify([6, 25, 26]),
  JSON.stringify(volc.volcanoTerrainCodes()));
check("every derived volcano code really is FAM_VOLCANO",
  volc.volcanoTerrainCodes().every((c) => familyForCode(c) === FAM_VOLCANO));
check("volcanoCodeBitmask() sets exactly bits 6, 25, 26",
  volc.volcanoCodeBitmask() === ((1 << 6) | (1 << 25) | (1 << 26)) >>> 0,
  volc.volcanoCodeBitmask().toString(2));
check("no volcano code is grass (the family sets are disjoint)",
  volc.volcanoTerrainCodes().every((c) => familyForCode(c) !== FAM_GRASS));
check("obsidian is CODE 6 ALONE (plan §3.6 item 5), not the whole family",
  volc.obsidianCodeBitmask() === (1 << 6) && volc.TERRAIN_CODE_OBSIDIAN_PLAIN === 6);
check("the obsidian mask is a strict subset of the volcano mask",
  (volc.obsidianCodeBitmask() & volc.volcanoCodeBitmask()) === volc.obsidianCodeBitmask()
  && volc.obsidianCodeBitmask() !== volc.volcanoCodeBitmask());

check("quality low ⇒ null (plan §3.6 'low: null', §5.8)",
  volc.resolveVolcanoQuality(PRESETS.low) === null);
const qMid = volc.resolveVolcanoQuality(PRESETS.mid);
check("quality mid ⇒ crack glow ONLY (no haze, no embers)",
  qMid && qMid.crackGlow === true && qMid.emberCount === 0
  && (qMid.hazeStrength === 0 || qMid.hazeRadiusM === 0), JSON.stringify(qMid));
const qHigh = volc.resolveVolcanoQuality(PRESETS.high);
check("quality high ⇒ {crackGlow, haze, embers:1}",
  qHigh && qHigh.crackGlow === true && qHigh.emberCount === 1
  && qHigh.hazeStrength > 0 && qHigh.hazeRadiusM > 0, JSON.stringify(qHigh));
const qUltra = volc.resolveVolcanoQuality(PRESETS.ultra);
check("quality ultra ⇒ {crackGlow, haze, embers:3}",
  qUltra && qUltra.crackGlow === true && qUltra.emberCount === 3
  && qUltra.hazeStrength > 0 && qUltra.hazeRadiusM > 0, JSON.stringify(qUltra));
check("a missing flag bag ⇒ null (never a silent default-on)",
  volc.resolveVolcanoQuality(null) === null && volc.resolveVolcanoQuality({}) === null);
for (const tier of ["low", "mid", "high", "ultra"]) {
  check(`PRESETS.${tier} carries every volcano key`,
    ["terrainVolcano", "terrainHaze", "terrainCrackGlow", "terrainVolcanoEmberCount",
      "terrainHazeStrength", "terrainVolcanoRadius"].every((k) => k in PRESETS[tier]));
  check(`PRESETS.${tier}.terrainVolcano ships FALSE (§5.9)`,
    PRESETS[tier].terrainVolcano === false);
}
check("ASH: no ash key on any tier (deferred, plan §8 risk 9)",
  ["low", "mid", "high", "ultra"].every((t) =>
    !Object.keys(PRESETS[t]).some((k) => /ash/i.test(k))));

// ===========================================================================
console.log("\n-- F1 ship-OFF -------------------------------------------------");
// ===========================================================================
clearUrl(); _resetVfxFlags();
check("no window: every volcano flag reads false",
  terrainVolcanoEnabled() === false && terrainHazeEnabled() === false
  && terrainEmbersEnabled() === false && terrainCrackGlowEnabled() === false);
setUrl(""); _resetVfxFlags();
check("no flags + a high-tier preset: the MASTER is still off (ship-OFF, §5.9)",
  terrainVolcanoEnabled() === false);
check("no flags: initTerrainVolcano registers NOTHING",
  volc.initTerrainVolcano({ scene3d: {} }) === null
  && vfx.terrainVfxStats().providers.length === 0);
check("no flags: createHeatHazeEffect() returns null (the fxPass slot is dropped)",
  haze.createHeatHazeEffect() === null);
check("no flags: HEAT_HAZE_STATE is inert (radiusM 0, enabled 0)",
  volc.HEAT_HAZE_STATE.radiusM === 0 && volc.HEAT_HAZE_STATE.enabled === 0);
check("no flags: window.__heatHaze is NOT installed",
  typeof globalThis.window.__heatHaze === "undefined");

// The four VFX_EFFECT_FLAGS rows exist BY NAME (deleting one is a failure, not
// merely a miss against the `terrain.` prefix rule).
const VOLCANO_ROWS = ["terrain.volcano", "terrain.volcanoHaze",
  "terrain.volcanoEmbers", "terrain.volcanoCrackGlow"];
check("all four volcano rows are registered in VFX_EFFECT_FLAGS",
  VOLCANO_ROWS.every((id) => typeof VFX_EFFECT_FLAGS[id] === "function"),
  Object.keys(VFX_EFFECT_FLAGS).join());
check("no flags: every volcano row resolves FALSE through vfxEffectEnabled",
  VOLCANO_ROWS.every((id) => vfxEffectEnabled(id) === false));
check("the DEFAULT-ON effect count is unchanged at 14 (volcano ids are ship-OFF)",
  Object.keys(VFX_EFFECT_FLAGS).filter((id) => !id.startsWith("terrain.")).length === 14);
check("the ember DESCRIPTOR id is also its VFX_EFFECT_FLAGS row "
  + "(so vfxEffectEnabled(component.id) resolves)",
  VOLCANO_ROWS.includes(terrainVolcanoEmbers.id)
  && terrainVolcanoEmbers.id === volc.EMBER_PROVIDER_ID);

// Strict exact-match opt-in: `1`/`true`/`yes` must NOT enable.
for (const bad of ["1", "true", "yes", "ON"]) {
  setUrl(`?terrainVolcano=${bad}`); _resetVfxFlags();
  check(`?terrainVolcano=${bad} does NOT enable (strict === "on", plan §2.4)`,
    terrainVolcanoEnabled() === false);
}
setUrl("?terrainVolcano=on"); _resetVfxFlags();
check("?terrainVolcano=on enables the master", terrainVolcanoEnabled() === true);
check("… and the tier lights haze + crack glow, but the count-driven embers "
  + "follow terrainVolcanoEmberCount (1 at high)",
  terrainHazeEnabled() === true && terrainCrackGlowEnabled() === true
  && terrainEmbersEnabled() === true);
setUrl("?terrainVolcano=on&terrainVolcano=on", { ...HIGH_FLAGS, terrainVolcanoEmberCount: 0 });
_resetVfxFlags();
check("a zero ember count at the tier leaves ?terrainEmbers off",
  terrainEmbersEnabled() === false);
setUrl("?terrainVolcano=off&terrainHaze=on"); _resetVfxFlags();
check("?terrainVolcano=off kills the family even with a sub-flag on",
  vfxEffectEnabled("terrain.volcanoHaze") === false);

// ===========================================================================
console.log("\n-- H1/H2 the Effect: DEPTH, mainUv, log-depth decode -------------");
// ===========================================================================
setUrl("?terrainVolcano=on&terrainHaze=on"); _resetVfxFlags();
const effect = haze.createHeatHazeEffect({ cameraFar: 12000 });
check("?terrainVolcano=on&terrainHaze=on ⇒ the Effect is constructed", !!effect);
check("H1: it declares EffectAttribute.DEPTH",
  (effect.getAttributes() & EffectAttribute.DEPTH) !== 0, String(effect.getAttributes()));
check("H1: it does NOT declare CONVOLUTION (incompatible with a UV transform)",
  (effect.getAttributes() & EffectAttribute.CONVOLUTION) === 0);
check("H1: blendFunction is NORMAL (never DST, which EffectPass would skip)",
  effect.blendMode.blendFunction === BlendFunction.NORMAL);
check("H2: the fragment shader exposes `void mainUv(inout vec2 uv)`",
  /void\s+mainUv\s*\(\s*inout\s+vec2\s+uv\s*\)/.test(effect.getFragmentShader()));
check("H2: it implements NO mainImage (a pure UV warp is the cheapest class)",
  !/mainImage/.test(effect.getFragmentShader()));
check("H2: log-depth DECODE present — a source scan for `exp2(` (trap T4)",
  /exp2\(\s*2\.0 \* d \/ uLogDepthFC\s*\)\s*-\s*1\.0/.test(effect.getFragmentShader())
  && HAZE_SRC.includes("exp2("));
check("H2: it reads the RAW depthBuffer texel, NOT pmndrs' readDepth() "
  + "(which already decodes the log buffer in 6.39.1 — double-decoding is the bug)",
  /texture2D\(depthBuffer, uv\)\.r/.test(effect.getFragmentShader())
  && !/\breadDepth\s*\(/.test(effect.getFragmentShader()));
check("H2: uLogDepthFC is seeded from cameraFar exactly like HorizonDissolve",
  Math.abs(effect.uniforms.get("uLogDepthFC").value - 2.0 / Math.log2(12000 + 1)) < 1e-12);
check("H2: setCameraFar re-seeds it", (() => {
  effect.setCameraFar(5000);
  const ok = Math.abs(effect.uniforms.get("uLogDepthFC").value - 2.0 / Math.log2(5001)) < 1e-12;
  effect.setCameraFar(12000);
  return ok;
})());
check("sky pixels are rejected before any warp (depth >= 0.9999 ⇒ -1.0)",
  /if \(d >= 0\.9999\) return -1\.0;/.test(effect.getFragmentShader())
  && /if \(dist < 0\.0\) return;/.test(effect.getFragmentShader()));
check("no backticks in the GLSL (a stray one closes the JS template literal)",
  !effect.getFragmentShader().includes("`"));
check("the warp is deterministic — sines of (uv, uTime) only, no Math.random",
  !/random|noise\s*\(/i.test(effect.getFragmentShader())
  && !/Math\.random/.test(HAZE_CODE));
check("the temporal rate is ≤ 1 Hz, so the shared clock's 3600 s wrap is "
  + "phase-continuous (plan §3.6 / oscillators.js)",
  haze.HEAT_BASE_SPEED / (2 * Math.PI) <= 1);
check("the base amplitude is a whisper (< 2 % of the frame)",
  haze.HEAT_BASE_AMPLITUDE > 0 && haze.HEAT_BASE_AMPLITUDE < 0.02);

// ===========================================================================
console.log("\n-- H3 inserted into the EXISTING EffectPass ---------------------");
// ===========================================================================
// The pipeline composes ONE EffectPass from a `.filter(Boolean)` list and adds
// exactly that one pass. Reproduce the composition against a fake composer with
// the Effect present and absent: the PASS COUNT must not move.
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 12000);
function fakeComposer() {
  return { passes: [], addPass(p) { this.passes.push(p); } };
}
function composeLike(heatHazeOrNull) {
  const composer = fakeComposer();
  const stand1 = new VignetteEffect();
  const stand2 = new VignetteEffect();
  const fxPass = new EffectPass(
    camera,
    ...[heatHazeOrNull, stand1, stand2].filter(Boolean),
  );
  composer.addPass(fxPass);
  return { composer, fxPass };
}
const withoutHaze = composeLike(null);
const withHaze = composeLike(effect);
check("H3: composer.passes.length is UNCHANGED by the heat haze (1 == 1)",
  withHaze.composer.passes.length === withoutHaze.composer.passes.length
  && withHaze.composer.passes.length === 1);
check("H3: it went INTO the existing pass — the pass carries one more effect",
  withHaze.fxPass.effects.length === withoutHaze.fxPass.effects.length + 1);
check("H3: it is the FIRST effect in the pass (EffectPass's attribute sort is "
  + "stable, and DEPTH ties with aerialPerspective)",
  withHaze.fxPass.effects[0] === effect);
check("H3: null when off ⇒ filter(Boolean) drops the slot, list identical",
  withoutHaze.fxPass.effects.length === 2);
withHaze.fxPass.recompile();
const COMPOUND = withHaze.fxPass.fullscreenMaterial.fragmentShader;
check("H3: the compound shader calls the prefixed mainUv",
  /e0MainUv\(UV\)/.test(COMPOUND));
check("H3: the log-depth decode survived pmndrs' prefixing intact",
  /exp2\(2\.0 \* d \/ e0ULogDepthFC\) - 1\.0/.test(COMPOUND));
check("H3: `depthBuffer` and `aspect` are the pmndrs built-ins, NOT prefixed",
  COMPOUND.includes("texture2D(depthBuffer, uv).r") && /\* aspect\b/.test(COMPOUND));
check("H3: the pass asks the composer for a depth texture",
  withHaze.fxPass.needsDepthTexture === true);

// The real wiring, by source scan — the fake composer above proves the shape,
// this proves atmosphere_pipeline.js actually uses it.
check("H3: atmosphere_pipeline builds exactly ONE EffectPass",
  (PIPE_SRC.match(/new EffectPass\(/g) || []).length === 1);
check("H3: heatHaze is inside the fxPass argument list, behind filter(Boolean)",
  /\.\.\.\[heatHaze, aerialPerspective, horizonDissolve, lensFlare, bloom, vignette, toneMapping, dithering\]\.filter\(Boolean\)/
    .test(PIPE_SRC));
check("H3: heatHaze is never given its own pass",
  !/composer\.addPass\(\s*heatHaze/.test(PIPE_SRC));
check("H3: the pipeline exposes it for diagnostics and disposes it",
  /\n    heatHaze,/.test(PIPE_SRC) && /heatHaze\?\.dispose\?\.\(\)/.test(PIPE_SRC));
check("H3: the live-tuning handle is installed (the __horizonFade pattern)",
  /installHeatHazeHandle\(heatHaze\)/.test(PIPE_SRC));

// ===========================================================================
console.log("\n-- H4 the shared clock, BY IDENTITY -----------------------------");
// ===========================================================================
check("H4: uTime IS VFX_GLOBALS.uTime — the same object, not a clone (§5.6)",
  effect.uniforms.get("uTime") === VFX_GLOBALS.uTime);
check("H4: the identity SURVIVES pmndrs' uniform re-keying into the pass",
  withHaze.fxPass.fullscreenMaterial.uniforms.e0UTime === VFX_GLOBALS.uTime);
check("H4: writing the shared clock is visible through the effect",
  (() => {
    const prev = VFX_GLOBALS.uTime.value;
    VFX_GLOBALS.uTime.value = 123.5;
    const ok = effect.uniforms.get("uTime").value === 123.5;
    VFX_GLOBALS.uTime.value = prev;
    return ok;
  })());
check("H4: the Effect never calls performance.now()/Date.now()",
  !/performance\.now|Date\.now/.test(HAZE_SRC));

// ===========================================================================
console.log("\n-- H5 uHeatRadius → 0 with no volcanic LB resident --------------");
// ===========================================================================
volc._resetTerrainVolcano();
const fakeCam = {
  projectionMatrix: { elements: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 12000).projectionMatrix.elements },
  matrixWorldInverse: { elements: new THREE.Matrix4().elements },
};
// Nothing resident yet.
volc.updateHeatHazeState(qHigh, { x: 0, y: 0, z: 0 }, fakeCam);
effect.update(null, null, 0);
check("H5: no resident volcanic LB ⇒ HEAT_HAZE_STATE.radiusM === 0",
  volc.HEAT_HAZE_STATE.radiusM === 0 && volc.HEAT_HAZE_STATE.enabled === 0);
check("H5: … and the Effect's uHeatRadius uniform is 0",
  effect.uniforms.get("uHeatRadius").value === 0
  && effect.uniforms.get("uStrength").value === 0);

// Drive a real landblock through the spine so the provider populates itself.
function volcanoGrids(code = 25) {
  const codes = new Uint8Array(81).fill(code);
  const heights = new Float32Array(81).fill(12);
  return { codes, heights };
}
const g = volcanoGrids();
setUrl("?terrainVolcano=on&terrainEmbers=off"); _resetVfxFlags();
vfx._resetTerrainVfx();
volc._resetTerrainVolcano();
const hazeScene = {
  terrainGroup: { children: [], parent: null },
  frameTime: { tsSec: 0, dt: 0.016 },
  quality: { flags: { ...HIGH_FLAGS } },
  camera: fakeCam,
  cameraSwitcher: { _safePlayerPos: () => ({ x: 0x02 * 192 + 96, y: 0x03 * 192 + 96, z: 14 }) },
};
vfx.initTerrainVfx({ scene3d: hazeScene });
const hazeSurface = volc.initTerrainVolcano({ scene3d: hazeScene, readEnv: () => null });
check("?terrainVolcano=on ⇒ the haze provider is registered",
  !!hazeSurface && vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.volcanoHaze"));
check("?terrainEmbers=off ⇒ the ember provider is NOT registered",
  !vfx.terrainVfxStats().providers.every((p) => p.id === "terrain.volcanoEmbers")
  || vfx.terrainVfxStats().providers.length === 1);

const lbKey = vfx.lbKeyFromXY(0x02, 0x03);
vfx.terrainVfxNoteLandblockMesh(hazeScene, {
  userData: { lbX: 0x02, lbY: 0x03, terrainCodes: g.codes, heights: g.heights },
});
vfx.terrainVfxTick(0.016, hazeScene);
effect.update(null, null, 0);
check("H5: a resident volcanic LB raises uHeatRadius above 0",
  volc.HEAT_HAZE_STATE.radiusM === 160 && volc.HEAT_HAZE_STATE.enabled === 1
  && effect.uniforms.get("uHeatRadius").value === 160,
  JSON.stringify({ r: volc.HEAT_HAZE_STATE.radiusM, u: effect.uniforms.get("uHeatRadius").value }));
check("H5: the centre is the LB's volcanic-vertex mean, in AC metres",
  Math.abs(volc.HEAT_HAZE_STATE.centerX - (0x02 * 192 + 96)) < 1e-6
  && Math.abs(volc.HEAT_HAZE_STATE.centerY - (0x03 * 192 + 96)) < 1e-6);
check("H5: the strength uniform is amplitude × tier strength",
  Math.abs(effect.uniforms.get("uStrength").value - haze.HEAT_BASE_AMPLITUDE * 1) < 1e-12);

vfx.terrainVfxLandblockPark(lbKey);
vfx.terrainVfxTick(0.016, hazeScene);
effect.update(null, null, 0);
check("H5: PARK clears it too — a parked LB's terrain mesh is detached from "
  + "terrainGroup, so it must not hold the shimmer up",
  volc.HEAT_HAZE_STATE.radiusM === 0 && effect.uniforms.get("uHeatRadius").value === 0);

vfx.terrainVfxLandblockUnpark(lbKey);
vfx.terrainVfxTick(0.016, hazeScene);
check("H5: UNPARK restores it", volc.HEAT_HAZE_STATE.radiusM === 160);

vfx.terrainVfxLandblockGone(lbKey, "evict");
vfx.terrainVfxTick(0.016, hazeScene);
effect.update(null, null, 0);
check("H5: EVICT clears it (the plan's literal requirement)",
  volc.HEAT_HAZE_STATE.radiusM === 0 && effect.uniforms.get("uHeatRadius").value === 0);
check("H5: leaving the region is a CLEAR, not a stale carry — every field is inert",
  volc.HEAT_HAZE_STATE.enabled === 0 && volc.HEAT_HAZE_STATE.screenRadiusUv === 0
  && volc.HEAT_HAZE_STATE.strength === 0);

// ===========================================================================
console.log("\n-- H6 distance gate — LRU residency must not carry the shimmer --");
// ===========================================================================
// The LRU parks on capacity pressure, not distance, so after a teleport a
// volcanic LB can stay in `_hazeLbs` for minutes (live repro 2026-08-01:
// lbKey 0xC8ED0000 still driving a min-radius shimmer from Holtburg, 10 km
// out). `hazeMaxEngageM` is the hard ceiling on player→field distance.
vfx.terrainVfxNoteLandblockMesh(hazeScene, {
  userData: { lbX: 0x02, lbY: 0x03, terrainCodes: g.codes, heights: g.heights },
});
vfx.terrainVfxTick(0.016, hazeScene);
check("H6: near player ⇒ engaged", volc.HEAT_HAZE_STATE.enabled === 1);
volc.updateHeatHazeState(qHigh,
  { x: 0x02 * 192 + 96 + volc.VOLCANO_TUNING.hazeMaxEngageM + 1, y: 0x03 * 192 + 96, z: 14 },
  fakeCam);
effect.update(null, null, 0);
check("H6: player beyond hazeMaxEngageM ⇒ CLEARED even with the LB resident",
  volc.HEAT_HAZE_STATE.enabled === 0 && volc.HEAT_HAZE_STATE.radiusM === 0
  && effect.uniforms.get("uHeatRadius").value === 0);
check("H6: back inside the ceiling ⇒ re-engages",
  (() => {
    volc.updateHeatHazeState(qHigh,
      { x: 0x02 * 192 + 96 + 500, y: 0x03 * 192 + 96, z: 14 }, fakeCam);
    return volc.HEAT_HAZE_STATE.enabled === 1;
  })());
volc._resetTerrainVolcano();
vfx._resetTerrainVfx();

// ---- the CPU projection is pure and frame-correct --------------------------
{
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 12000);
  // Sit at AC (0,0,0) looking north (AC +Y = three -Z).
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const p = volc.projectAcPointToUv(cam, 0, 100, 0, undefined);
  check("projection: a point 100 m due AC-north lands at screen centre",
    p && Math.abs(p.u - 0.5) < 1e-3 && Math.abs(p.v - 0.5) < 1e-3 && !p.behind,
    JSON.stringify(p));
  check("projection: … at 100 m eye-forward distance (AC→three is (x, z, -y))",
    Math.abs(p.distM - 100) < 1e-3, String(p && p.distM));
  const behind = volc.projectAcPointToUv(cam, 0, -100, 0, undefined);
  check("projection: a point BEHIND the camera reports behind:true",
    behind && behind.behind === true);
  check("projection: a camera with no matrices returns null (never throws)",
    volc.projectAcPointToUv(null, 0, 0, 0) === null
    && volc.projectAcPointToUv({}, 0, 0, 0) === null);
  const right = volc.projectAcPointToUv(cam, 20, 100, 0, undefined);
  check("projection: AC +X (east) moves the mask to screen RIGHT", right.u > 0.5);
}

// ===========================================================================
console.log("\n-- E1 the ember RE-ANCHOR: same spec as the brazier modulo anchor");
// ===========================================================================
const anchor = { partIndex: -1, center: { x: 11, y: -3, z: 40 } };
// A REAL env (see the note in test_terrain_sand.mjs). `env: null` used to lean on
// volcanoEmberGate's null-env => 1.0; that is now a gated-OUT wiring fault, so the
// dry/day baseline is expressed explicitly. gate == 1 here, so every "same spec as
// the brazier modulo anchor" assertion below is unchanged.
const VENT_ENV = Object.freeze({ wetness: 0, nightFactor: 0 });
const ventSpecs = terrainVolcanoEmbers.emit({ anchor, env: VENT_ENV, seed: 7 });
const cfg = gatedVentConfig({ ...terrainVolcanoEmbers.defaults }, 1);
const brazierSpecs = brazierEmbers.emit({ config: cfg });
check("E1: the re-anchor returns the SAME NUMBER of specs (ember + smoke)",
  ventSpecs.length === 2 && brazierSpecs.length === 2);
for (let i = 0; i < 2; i += 1) {
  const a = ventSpecs[i].emitterInfo, b = brazierSpecs[i].emitterInfo;
  const keysA = Object.keys(a).sort().join(","), keysB = Object.keys(b).sort().join(",");
  check(`E1: spec[${i}] emitterInfo has the SAME FIELD SET as the brazier path`,
    keysA === keysB, `${keysA} vs ${keysB}`);
  const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
  check(`E1: spec[${i}] emitterInfo is FIELD-FOR-FIELD identical to the brazier`,
    diffs.length === 0, diffs.join());
}
check("E1: only the ANCHOR differs — parentOffset is the terrain vent frame",
  ventSpecs[0].parentOffset.position.x === 11
  && ventSpecs[0].parentOffset.position.y === -3
  && Math.abs(ventSpecs[0].parentOffset.position.z
    - (40 + terrainVolcanoEmbers.defaults.footLiftM)) < 1e-9
  && brazierSpecs[0].parentOffset.position.z === 0
  && brazierEmbers.emit({ config: brazierEmbers.defaults })[0].parentOffset.position.z === 0.77);
check("E1: partIndex is the STATIC root anchor (-1), never a bowl part",
  ventSpecs.every((s) => s.partIndex === -1));
check("E1: it authors NO emitterInfo field of its own — the builders are the "
  + "brazier's (re-anchor, don't rewrite)",
  !/emitterType\s*:/.test(EMBER_SRC) && !/particleType\s*:/.test(EMBER_SRC)
  && /brazierEmbers\.emit\(/.test(EMBER_SRC));
check("E1: the sprites are inherited, not re-declared (DAT-confirmed there)",
  !/PARTICLE_SPRITES/.test(EMBER_SRC)
  && (ventSpecs[0].emitterInfo.hwGfxObjId >>> 0) === (brazierEmbers.defaults.hwGfxObjIdEmber >>> 0)
  && (ventSpecs[1].emitterInfo.hwGfxObjId >>> 0) === (brazierEmbers.defaults.hwGfxObjIdSmoke >>> 0));
check("E1: the VOLCANO config really is different from the brazier's "
  + "(bigger, longer-lived, faster-rising embers)",
  terrainVolcanoEmbers.defaults.emberLifespan > brazierEmbers.defaults.emberLifespan
  && terrainVolcanoEmbers.defaults.emberRiseSpeed > brazierEmbers.defaults.emberRiseSpeed
  && terrainVolcanoEmbers.defaults.emberStartScale > brazierEmbers.defaults.emberStartScale
  && terrainVolcanoEmbers.defaults.bowlRadius > brazierEmbers.defaults.bowlRadius);
check("E1: the spawn-ball clamp is respected, not fought (maxOffset ≤ 1 m — the "
  + "wider footprint is N vents per landblock, documented in the header)",
  ventSpecs[0].emitterInfo.maxOffset <= 1
  && /LANDBLOCK scale/.test(EMBER_SRC));

// gate behaviour
check("★ E4: a null env gates OUT (0) — a missing env is a wiring fault, not weather;\n"
  + "        matches pollenGate/firefliesGate/leavesGate/breathFogGate (2026-08-03)",
  volcanoEmberGate(null) === 0);
check("E4: a REAL dry/day env is the 1.0 baseline the null case used to fake",
  volcanoEmberGate(VENT_ENV) === 1);
check("E4: rain DAMPS a vent but never kills it (vents are geology, not weather)",
  volcanoEmberGate({ wetness: 1, nightFactor: 0 }) < 1
  && volcanoEmberGate({ wetness: 1, nightFactor: 0 }) > 0);
check("E4: night reads slightly STRONGER (a dull ember registers at night)",
  volcanoEmberGate({ wetness: 0, nightFactor: 1 })
  >= volcanoEmberGate({ wetness: 0, nightFactor: 0 }));
check("E4: the gate is clamped to [0,1] for absurd inputs",
  volcanoEmberGate({ wetness: 9, nightFactor: 9 }) >= 0
  && volcanoEmberGate({ wetness: -9, nightFactor: 9 }) <= 1);
check("E4: a gated-out env synthesizes NO emitter at all (as cheap as flag-off)",
  terrainVolcanoEmbers.emit({ anchor, env: VENT_ENV, config: null, seed: 1 }).length === 2
  && terrainVolcanoEmbers.emit({
    anchor, seed: 1,
    // Force the gate under GATE_MIN through the descriptor's own gateFn.
    env: { wetness: 1, nightFactor: 0 },
    config: null,
  }).length === (volcanoEmberGate({ wetness: 1, nightFactor: 0 }) > VENT_GATE_MIN ? 2 : 0));
check("E4: gatedVentConfig only touches the two birthrates (a PERIOD, so a "
  + "stronger gate means a shorter period)",
  (() => {
    const base = { ...terrainVolcanoEmbers.defaults };
    const out = gatedVentConfig(base, 0.5);
    const changed = Object.keys(out).filter((k) => out[k] !== base[k]);
    return changed.sort().join() === "emberBirthrate,smokeBirthrate"
      && out.emberBirthrate === base.emberBirthrate / 0.5;
  })());
check("E4: gate 1 is the IDENTITY config (so the brazier comparison above is exact)",
  gatedVentConfig(terrainVolcanoEmbers.defaults, 1) === terrainVolcanoEmbers.defaults);
check("ventHash01 is deterministic and in [0,1)",
  ventHash01(7) === ventHash01(7) && ventHash01(7) >= 0 && ventHash01(7) < 1
  && ventHash01(7) !== ventHash01(8));

// ===========================================================================
console.log("\n-- E4 the descriptor passes the VFX firewall --------------------");
// ===========================================================================
check("layer A: lintManifest(terrainVolcanoEmbers) is clean",
  lintManifest(terrainVolcanoEmbers).length === 0,
  lintManifest(terrainVolcanoEmbers).join("; "));
check("layer B: lintSource(the component file) is clean (plan §5.1)",
  lintSource(EMBER_SRC).length === 0, lintSource(EMBER_SRC).join("; "));
check("§5.2 lightCountDelta === 0 (embers are additive sprites, never a light)",
  terrainVolcanoEmbers.lightCountDelta === 0);
check("§5.4 cacheKeyScope === 'none' and linkVariant() === '' (no shader program)",
  terrainVolcanoEmbers.cacheKeyScope === "none" && terrainVolcanoEmbers.linkVariant() === "");
check("§5.5 deterministic === true and no Math.random in the source",
  terrainVolcanoEmbers.deterministic === true && !/Math\.random/.test(EMBER_CODE));
check("the enable() composes the family master AND the per-effect flag",
  /terrainVolcanoEnabled\(\) && terrainEmbersEnabled\(\)/.test(EMBER_SRC));

// ===========================================================================
console.log("\n-- E2 vent placement is hash-stable and volcanic-only -----------");
// ===========================================================================
{
  // A mixed landblock: volcanic on one half, grass on the other.
  const codes = new Uint8Array(81);
  const heights = new Float32Array(81);
  for (let i = 0; i < 81; i += 1) {
    const vx = (i / 9) | 0;
    codes[i] = vx < 4 ? 26 : 1;             // 26 = Volcano2, 1 = Grassland
    heights[i] = 5 + i * 0.01;
  }
  const opts = { lbKey: vfx.lbKeyFromXY(0x40, 0x50), lbX: 0x40, lbY: 0x50, codes, heights, count: 3 };
  const a = volc.ventSlotsForLandblock(opts);
  const b = volc.ventSlotsForLandblock({ ...opts, codes: Uint8Array.from(codes), heights: Float32Array.from(heights) });
  check("E2: three vents on a mixed landblock", a.length === 3);
  check("E2: placement is BYTE-IDENTICAL across two calls (hash-stable, §5.5)",
    JSON.stringify(a) === JSON.stringify(b));
  check("E2: every vent stands on a FAM_VOLCANO vertex",
    a.every((s) => familyForCode(s.code) === FAM_VOLCANO));
  check("E2: the vents take DISTINCT vertices",
    new Set(a.map((s) => `${s.vx},${s.vy}`)).size === a.length);
  check("E2: every vent is inside its own landblock",
    a.every((s) => s.x >= 0x40 * 192 && s.x <= 0x40 * 192 + 192
      && s.y >= 0x50 * 192 && s.y <= 0x50 * 192 + 192));
  check("E2: a landblock with NO volcanic vertex gets no vents",
    volc.ventSlotsForLandblock({ ...opts, codes: new Uint8Array(81).fill(1) }).length === 0);
  check("E2: count 0 (the low/mid tier) gets no vents",
    volc.ventSlotsForLandblock({ ...opts, count: 0 }).length === 0);
  check("E2: a different lbKey gives a different arrangement",
    JSON.stringify(volc.ventSlotsForLandblock({ ...opts, lbKey: vfx.lbKeyFromXY(0x41, 0x50), lbX: 0x41 }))
    !== JSON.stringify(a));
  check("E2: asking for more vents than volcanic vertices simply gets fewer",
    (() => {
      const one = new Uint8Array(81).fill(1);
      one[40] = 6;
      return volc.ventSlotsForLandblock({ ...opts, codes: one, count: 8 }).length === 1;
    })());
  check("E2: the LB centre helper averages only the VOLCANIC vertices",
    (() => {
      const c = volc.volcanoCentreOfLandblock(0, 0, codes, heights);
      // volcanic vx are 0..3 ⇒ mean vx = 1.5 ⇒ 36 m; vy spans 0..8 ⇒ 96 m.
      return c && Math.abs(c.x - 36) < 1e-6 && Math.abs(c.y - 96) < 1e-6;
    })());
  check("E2: … and returns null for a landblock with none",
    volc.volcanoCentreOfLandblock(0, 0, new Uint8Array(81).fill(1), heights) === null);
}

// ===========================================================================
console.log("\n-- E3 owner scoping, park/evict through the spine ---------------");
// ===========================================================================
function makeSpyRegistry() {
  const owners = new Map();
  const calls = { add: 0, stop: [], destroyAll: [] };
  return {
    calls,
    async addEmitter(ownerKey, manager, req) {
      calls.add += 1;
      const id = (req && req.emitterId) || 1;
      if (!owners.has(ownerKey)) owners.set(ownerKey, new Set());
      owners.get(ownerKey).add(id);
      await manager.addEmitter(req);
      return id;
    },
    stopEmitter(ownerKey, handle) { calls.stop.push([ownerKey, handle]); return true; },
    destroyAllForOwner(ownerKey) {
      calls.destroyAll.push(ownerKey);
      const n = owners.get(ownerKey)?.size ?? 0;
      owners.delete(ownerKey);
      return n;
    },
    emitterCountForOwner(ownerKey) { return owners.get(ownerKey)?.size ?? 0; },
  };
}
{
  const spy = makeSpyRegistry();
  const fakeManager = { added: 0, async addEmitter() { this.added += 1; return 1; } };
  const scene3d = {
    terrainGroup: { children: [], parent: null },
    frameTime: { tsSec: 0 },
    quality: { flags: { ...HIGH_FLAGS } },
  };
  setUrl("?terrainVolcano=on&terrainHaze=off"); _resetVfxFlags();
  vfx._resetTerrainVfx();
  volc._resetTerrainVolcano();
  vfx.initTerrainVfx({ scene3d });
  const surface = volc.initTerrainVolcano({
    scene3d,
    ownerRegistry: spy,
    getParticleManager: () => fakeManager,
    // 2026-08-03: was `() => null`, which made this integration test exercise the
    // gate's WIRING-FAULT path (null env) instead of the real one. The live host
    // passes `vfx/particle_env.js::readParticleEnv`, which ALWAYS returns a filled
    // snapshot and never null. Supply the same baseline the unit assertions use.
    readEnv: () => VENT_ENV,
  });
  check("E3: ?terrainVolcano=on registers the ember provider",
    !!surface && vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.volcanoEmbers"));
  check("E3: ?terrainHaze=off ⇒ the haze provider is NOT registered",
    !vfx.terrainVfxStats().providers.some((p) => p.id === "terrain.volcanoHaze"));

  const gg = volcanoGrids(6);
  vfx.terrainVfxNoteLandblockMesh(scene3d, {
    userData: { lbX: 0xcd, lbY: 0x34, terrainCodes: gg.codes, heights: gg.heights },
  });
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  const key = vfx.lbKeyFromXY(0xcd, 0x34);
  const ownerKey = volc.volcanoOwnerKeyForLb(key);
  check("E3: the owner key is the static key with a `:volcano` scope",
    ownerKey.endsWith(":volcano") && ownerKey.startsWith("static:"), ownerKey);
  check("E3: a volcanic landblock spawns its vent (ember + smoke) under it",
    spy.emitterCountForOwner(ownerKey) === 2,
    `count=${spy.emitterCountForOwner(ownerKey)}`);
  check("E3: both emitters really reached the ParticleManager", fakeManager.added === 2);

  const beforePark = spy.emitterCountForOwner(ownerKey);
  vfx.terrainVfxLandblockPark(key);
  await Promise.resolve();
  check("E3: park leaves emitterCountForOwner UNCHANGED (nothing destroyed)",
    spy.emitterCountForOwner(ownerKey) === beforePark && beforePark === 2);
  check("E3: park STOPS emission through the registry (never .visible=, §5.3)",
    spy.calls.stop.length === 2 && spy.calls.stop.every(([k]) => k === ownerKey));
  check("E3: park does NOT call destroyAllForOwner", spy.calls.destroyAll.length === 0);

  vfx.terrainVfxLandblockUnpark(key);
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  check("E3: unpark re-arms emission (hash-stable placement, no re-scatter)",
    spy.emitterCountForOwner(ownerKey) === 2 && spy.calls.add === 4);

  const before = spy.calls.destroyAll.length;
  vfx.terrainVfxLandblockGone(key, "evict");
  check("E3: evict calls destroyAllForOwner EXACTLY ONCE",
    spy.calls.destroyAll.length === before + 1);
  check("E3: … on the VOLCANO-scoped key, never the bare statics key (a LOD "
    + "rebake would otherwise reap the LB's brazier/foliage emitters)",
    spy.calls.destroyAll[spy.calls.destroyAll.length - 1] === ownerKey
    && !spy.calls.destroyAll.some((k) => !k.endsWith(":volcano")));
  check("E3: the owner is empty afterwards", spy.emitterCountForOwner(ownerKey) === 0);

  const addsBefore = spy.calls.add;
  vfx.terrainVfxNoteLandblockMesh(scene3d, {
    userData: {
      lbX: 0x11, lbY: 0x22, terrainCodes: new Uint8Array(81).fill(1),
      heights: new Float32Array(81),
    },
  });
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  check("E3: a landblock with no FAM_VOLCANO vertex spawns nothing",
    spy.calls.add === addsBefore);
  check("E3: the emitter handles are distinct per (slot, ember/smoke)",
    volc.ventEmitterHandle(0, 0) !== volc.ventEmitterHandle(0, 1)
    && volc.ventEmitterHandle(0, 0) !== volc.ventEmitterHandle(1, 0)
    && volc.ventEmitterHandle(0, 0) !== 0);

  volc._resetTerrainVolcano();
  vfx._resetTerrainVfx();
}

// ===========================================================================
console.log("\n-- O1 the crack-glow breathing oscillator -----------------------");
// ===========================================================================
const osc = await import("./scene3d/vfx/oscillators.js");
check("O1: the oscillator spec is a `sine` at ≤ 1 Hz (the tick wraps the clock "
  + "at 3600 s and is phase-continuous only there)",
  volc.CRACK_GLOW_OSC_SPEC.kind === "sine" && volc.CRACK_GLOW_OSC_SPEC.config.freq <= 1);
check("O1: the breath range is bounded and never negative "
  + "(bias − amp .. bias + amp)",
  (() => {
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < 30; t += 0.05) {
      const v = volc.crackGlowBreathAt(t);
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    return lo > 0.4 && lo < 0.5 && hi > 0.99 && hi <= 1.0;
  })());
check("O1: it is deterministic in t alone", volc.crackGlowBreathAt(3.5) === volc.crackGlowBreathAt(3.5));
check("O1: the JS twin agrees with the REGISTERED oscillator's own tick",
  (() => {
    setUrl("?terrainVolcano=on&terrainCrackGlow=on&terrainHaze=off&terrainEmbers=off");
    _resetVfxFlags();
    vfx._resetTerrainVfx();
    volc._resetTerrainVolcano();
    osc._clearOscillators();
    volc.initTerrainVolcano({ scene3d: { terrainGroup: { children: [] } } });
    const registered = osc.getOscillator(volc.CRACK_GLOW_OSC_NAME);
    if (!registered) return false;
    osc.tickOscillators(4.25, 0.016);
    const ok = Math.abs(registered.value - volc.crackGlowBreathAt(4.25)) < 1e-12;
    volc._resetTerrainVolcano();
    return ok;
  })());
check("O1: the oscillator is UNREGISTERED on reset (no leak across sessions)",
  osc.getOscillator(volc.CRACK_GLOW_OSC_NAME) === undefined);
check("O1: crack glow OFF ⇒ the oscillator is never registered",
  (() => {
    setUrl("?terrainVolcano=on&terrainCrackGlow=off&terrainHaze=off&terrainEmbers=off");
    _resetVfxFlags();
    vfx._resetTerrainVfx();
    volc._resetTerrainVolcano();
    const r = volc.initTerrainVolcano({ scene3d: { terrainGroup: { children: [] } } });
    const none = osc.getOscillator(volc.CRACK_GLOW_OSC_NAME) === undefined;
    volc._resetTerrainVolcano();
    vfx._resetTerrainVfx();
    return r === null && none;
  })());

// ===========================================================================
console.log("\n-- wiring ------------------------------------------------------");
// ===========================================================================
check("scene3d/index.js constructs the family next to initTerrainSand",
  /import \{ initTerrainVolcano \} from "\.\/terrain_volcano\.js";/.test(INDEX_SRC)
  && /const volcanoSurface = initTerrainVolcano\(\{/.test(INDEX_SRC));
check("scene3d/index.js exposes window.__terrainVolcano, mirroring __terrainSand",
  /window\.__terrainVolcano = volcanoSurface;/.test(INDEX_SRC));
check("the stats surface mirrors the __terrainSand shape",
  (() => {
    const s = volc.terrainVolcanoStats();
    return ["enabled", "inited", "counters", "volcanoCodes", "volcanoCodeMask"]
      .every((k) => k in s);
  })());
check("terrain_volcano.js imports no three (injected — the pure-node contract)",
  !/^import .*from "three"/m.test(VOLC_SRC));
check("terrain_volcano.js never calls Math.random (§5.5)",
  !/Math\.random/.test(VOLC_CODE));

clearUrl(); _resetVfxFlags();
console.log(`\nterrain volcano: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
