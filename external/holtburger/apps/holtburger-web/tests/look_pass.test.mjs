// tests/look_pass.test.mjs — the 2026-10-07 owner look pass on the GTX 1070.
//
//   L1  ?tone        Neutral default, agx / aces escapes, the JS curve mirrors.
//   L2  ?grade       day/night blend, the post-saturation tint, and its slot in
//                    BOTH post chains (after the tone curve, before dithering).
//   L3  ?lumNight    ambient-like luminosity dims at night, light sources don't.
//   L4  ?adaptiveResBootGrace  no lowering / no latch until ready + 30 s.
//   L5  the split post chain: the late passes skip the MSAA depth resolve, and
//       the clouds get their scene depth back after adoption (source checks —
//       the live fix was measured on the 1070, gl.getError 1282 → 0).
//   L6  CSM receivers compare against the cascade DEPTH texture.
//   L7  grass blades take the unflipped ground normal on both faces.
//   L8  ?swayShadow  swaying casters get the sway-aware depth material.
//   L9  docs: every new flag has a url-flags.md row.
//   L10 ?ssao        the half-res AO pass and its grass marker.
//   L11 ?canopySoften crown-radial normals for tree crowns, trunks/panels kept.
//   L12 ?retailFill  the hemisphere fill follows the retail diurnal ambient
//                    (shaded walls keep their share of the sunlit brightness).
//   L13 ?grassIndoorCull  no grass blades inside building interior cells.
//   L14 dusk: the fog probe keeps out of the sun's halo (?farFogSunAvoid) and
//       the water's sun glint fades out once the sky's sun is down.
//   L15 the terrain reflection cube renders from the viewer (Dereth's moons
//       where they really are) and carries the volumetric clouds (?waterClouds).
//
// Fails on the pre-change code: tone_curve.js / color_grade.js /
// luminous_night.js / sway_shadow.js do not exist, the composer was AGX-only,
// the late passes resolved depth, CSM sampled the colour attachment.
//
// Run: node tests/look_pass.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---------------------------------------------------------------------------
console.log("\n-- L1 ?tone ----------------------------------------------------");
{
  const T = await import("../scene3d/tone_curve.js");
  check("default curve is neutral", T.toneCurveName("") === "neutral" && T.TONE_CURVE_DEFAULT === "neutral");
  check("?tone=agx / ?tone=aces select those curves",
    T.toneCurveName("?tone=agx") === "agx" && T.toneCurveName("?tone=ACES") === "aces");
  check("garbage falls back to neutral", T.toneCurveName("?tone=filmic") === "neutral");
  const MODE = { AGX: 7, ACES_FILMIC: 6, NEUTRAL: 8 };
  check("pmndrs mode mapping", T.toneMappingModeFor("agx", MODE) === 7
    && T.toneMappingModeFor("aces", MODE) === 6 && T.toneMappingModeFor("neutral", MODE) === 8);
  // three r184 NeutralToneMapping: below the knee it is out = x - offset.
  const v = T.neutralToneMap([0.3, 0.2, 0.1]);
  check("neutral below the knee subtracts the 0.04 offset (x_min >= 0.08)",
    near(v[0], 0.26) && near(v[1], 0.16) && near(v[2], 0.06), `got ${v}`);
  const d = T.neutralToneMap([0.05, 0.05, 0.05]);
  check("neutral near black keeps 6.25 x^2 (x_min < 0.08)", near(d[0], 6.25 * 0.05 * 0.05), `got ${d}`);
  const hi = T.neutralToneMap([4, 2, 1]);
  check("neutral compresses highlights under 1", Math.max(...hi) < 1 && Math.max(...hi) > 0.9, `got ${hi}`);
  const a = T.acesToneMap([50, 0.5, -1]);
  check("aces output is clamped to [0, 1]", a.every((c) => c >= 0 && c <= 1), `got ${a}`);
  const pipe = src("scene3d/atmosphere_pipeline.js");
  check("the composer's ToneMappingEffect takes its mode from ?tone",
    /new ToneMappingEffect\(\{ mode: toneMappingModeFor\(toneCurveName\(\), ToneMappingMode\) \}\)/.test(pipe));
}

// ---------------------------------------------------------------------------
console.log("\n-- L2 ?grade ---------------------------------------------------");
{
  const G = await import("../scene3d/color_grade.js");
  check("default ON; off / 0 / false escape",
    G.colorGradeEnabled("") === true && G.colorGradeEnabled("?grade=off") === false
    && G.colorGradeEnabled("?grade=0") === false && G.colorGradeEnabled("?grade=on") === true);
  const day = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 0);
  const night = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 1);
  const mid = G.blendGrade(G.GRADE_DAY, G.GRADE_NIGHT, 0.5);
  check("t=0 is the day look, t=1 the night look",
    near(day.saturation, G.GRADE_DAY.saturation) && near(night.saturation, G.GRADE_NIGHT.saturation));
  check("t=0.5 is the midpoint", near(mid.contrast, (G.GRADE_DAY.contrast + G.GRADE_NIGHT.contrast) / 2));
  check("night tint is the moonlit blue (B > G > R) and desaturates",
    night.tint[2] > night.tint[1] && night.tint[1] > night.tint[0] && night.saturation < 0.8);
  check("day tint is neutral", day.tint.every((c) => near(c, 1)));
  const fx = G.createColorGradeEffect({ enabled: true, nightSource: () => 1 });
  fx.update(null, null, 1 / 60);
  check("effect night source drives the uniforms (sat = night)",
    near(fx.uniforms.get("uSat").value, G.GRADE_NIGHT.saturation, 1e-3), `uSat ${fx.uniforms.get("uSat").value}`);
  fx.off = true; fx.update(null, null, 1 / 60);
  check("`off` bypasses (uMix 0)", fx.uniforms.get("uMix").value === 0);
  check("?grade=off builds no effect", G.createColorGradeEffect({ enabled: false }) === null);
  const glsl = src("scene3d/color_grade.js");
  check("the tint multiplies AFTER the saturation mix", /mix\(vec3\(luma\), g, s\) \* uTint/.test(glsl));
  const pipe = src("scene3d/atmosphere_pipeline.js");
  check("split chain: [.., toneMapping, colorGrade, dithering]",
    pipe.includes("[lensFlare, bloom, vignette, toneMapping, colorGrade, dithering]"));
  check("legacy chain: [.., toneMapping, colorGrade, dithering]",
    pipe.includes("vignette, toneMapping, colorGrade, dithering].filter(Boolean)"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L3 ?lumNight ------------------------------------------------");
{
  const L = await import("../scene3d/luminous_night.js");
  check("default full-night scale 0.25; off = 1; numbers clamp",
    L.lumNightScale("") === 0.25 && L.lumNightScale("?lumNight=off") === 1
    && L.lumNightScale("?lumNight=0.5") === 0.5 && L.lumNightScale("?lumNight=7") === 1
    && L.lumNightScale("?lumNight=0") === 0);
  check("lumScaleAt: 1 by day, k at full night", L.lumScaleAt(0, 0.25) === 1 && near(L.lumScaleAt(1, 0.25), 0.25));
  const mat = (ei) => ({ emissiveIntensity: ei, userData: {} });
  const leaf = mat(0.5), brazier = mat(1.0);
  check("ambient-like luminosity is tracked", L.registerLuminousMaterial(leaf, 0.5) === true);
  check("a light source (>= 0.99) is never tracked", L.registerLuminousMaterial(brazier, 1.0) === false);
  // AC night: authored pitch bottoms at 0.9 deg -> night fraction 1.
  L.tickLuminousNight({ dirPitch: 0.9 }, "");
  check("night tick dims the leaf to 25 %", near(leaf.emissiveIntensity, 0.125), `got ${leaf.emissiveIntensity}`);
  check("...and leaves the brazier at full glow", brazier.emissiveIntensity === 1.0);
  const late = mat(0.235);
  L.registerLuminousMaterial(late, 0.235);
  check("a material registered at night takes the night scale at once", near(late.emissiveIntensity, 0.235 * 0.25));
  L.tickLuminousNight({ dirPitch: 60 }, "");
  check("day tick restores the authored luminosity", near(leaf.emissiveIntensity, 0.5) && near(late.emissiveIntensity, 0.235));
  L.tickLuminousNight({ dirPitch: 0.9 }, "?lumNight=off");
  check("?lumNight=off keeps the noon value all night", near(leaf.emissiveIntensity, 0.5));
  L.tickLuminousNight({ dirPitch: 60 }, "");
  check("materials.js + entities.js register at every luminosity site",
    (src("scene3d/materials.js").match(/registerLuminousMaterial\(mat, sfLuminosity\)/g) || []).length >= 2
    && src("scene3d/entities.js").includes("registerLuminousMaterial(mat, sfLuminosity)"));
  check("loop.js ticks it after the sky snapshot",
    src("scene3d/loop.js").includes("tickLuminousNight(scene3d.skyLightingController._lastState)"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L4 ?adaptiveResBootGrace -------------------------------------");
{
  const A = await import("../scene3d/adaptive_render_scale.js");
  const now = 1_000_000;
  check("no ready yet -> booting", A.bootGraceActive([{ state: "in-world", ts: now }], now) === true);
  check("ready 10 s ago -> still booting", A.bootGraceActive([{ state: "ready", ts: now - 10_000 }], now) === true);
  check("ready 31 s ago -> settled", A.bootGraceActive([{ state: "ready", ts: now - 31_000 }], now) === false);
  check("no history at all -> not booting (non-browser callers)", A.bootGraceActive(null, now) === false);
  const run = (booting) => {
    let scale = 1, t = 0;
    const c = new A.AdaptiveRenderScaleController({
      getScale: () => scale, applyScale: (s) => { scale = s; },
      now: () => t, isBooting: () => booting, settle: true,
    });
    // Catastrophic frames (4x the band) back to back, then a slow window.
    for (let i = 0; i < 40; i++) { t += 240; c.recordFrame(); }
    return { scale, holds: c.bootHolds, latches: c.settleLatches };
  };
  const b = run(true), s = run(false);
  check("booting: catastrophic + slow frames never lower the scale", b.scale === 1 && b.holds > 0, JSON.stringify(b));
  check("settled: the same frames lower it (the controller still works)", s.scale < 1, JSON.stringify(s));
  check("index.js wires the grace into the controller",
    src("scene3d/index.js").includes("? () => bootGraceActive(window.__bootStateHistory)"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L5 split post chain fixes -----------------------------------");
{
  const pipe = src("scene3d/atmosphere_pipeline.js");
  const cls = pipe.slice(pipe.indexOf("class PostChainSourcePass"), pipe.indexOf("const _lateNow"));
  check("PostChainSourcePass turns the output's depth resolve off around the draw",
    /outputBuffer\.resolveDepthBuffer = false/.test(cls) && /outputBuffer\.resolveDepthBuffer = true/.test(cls)
    && /finally/.test(cls));
  const adopt = pipe.slice(pipe.indexOf("const cloudsMainAdopted"), pipe.indexOf("installHeatHazeHandle(heatHaze)"));
  check("after cloud adoption the fxPass depth is re-handed to its effects",
    /fxPass\.setDepthTexture\(fxPass\.getDepthTexture\(\)/.test(adopt));
}

// ---------------------------------------------------------------------------
console.log("\n-- L6 CSM receivers ---------------------------------------------");
{
  const mats = src("scene3d/materials.js"), terr = src("scene3d/terrain.js"), csm = src("scene3d/csm.js");
  check("materials.js + terrain.js declare the cascades as sampler2DShadow",
    /uniform sampler2DShadow uCsmShadowMap0/.test(mats) && /uniform sampler2DShadow uCsmShadowMap0/.test(terr));
  check("neither receiver reads the colour attachment as depth any more",
    !/texture2D\(sm, shadowCoord\.xy\)\.r/.test(mats) && !/texture\(sm, sc\.xy\)\.r/.test(terr));
  check("csm.js binds shadow.map.depthTexture", /return light\?\.shadow\?\.map\?\.depthTexture \?\? null/.test(csm));
}

// ---------------------------------------------------------------------------
console.log("\n-- L7 grass normal ----------------------------------------------");
{
  const Gr = await import("../scene3d/terrain_grass.js");
  const shader = {
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main() {\n#include <normal_fragment_begin>\n#include <color_fragment>\n}",
  };
  Gr.injectTerrainGrassShader(shader);
  const fs = shader.fragmentShader;
  const at = fs.indexOf("#include <normal_fragment_begin>");
  check("the unflipped normal is re-taken right after normal_fragment_begin",
    at !== -1 && fs.indexOf("normal = normalize( vNormal );") > at);
  check("blade tints sit near the ground hue (Grassland G > R > B, darker than the old 0.54 G)",
    Gr.GRASS_VARIANTS[1].tint[1] > Gr.GRASS_VARIANTS[1].tint[0] && Gr.GRASS_VARIANTS[1].tint[1] < 0.4);
}

// ---------------------------------------------------------------------------
console.log("\n-- L8 ?swayShadow -----------------------------------------------");
{
  const S = await import("../scene3d/sway_shadow.js");
  const sway = { material: { userData: { __vfxSetKey: "deformation.windSwayGpu" } } };
  const plain = { material: { userData: {} } };
  check("isSwayMaterial reads the frag set key", S.isSwayMaterial(sway.material) && !S.isSwayMaterial(plain.material));
  check("a swaying caster gets the shared sway depth material", S.applySwayShadow(sway) === true
    && sway.customDepthMaterial === S.swayDepthMaterial());
  check("...once", S.applySwayShadow(sway) === false);
  check("a plain caster keeps three's default depth material", S.applySwayShadow(plain) === false
    && plain.customDepthMaterial === undefined);
  const dm = S.swayDepthMaterial();
  const stub = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main() {\n}",
  };
  dm.onBeforeCompile(stub);
  check("the depth material carries the windSwayGpu vertex shear",
    stub.vertexShader.includes("VFX_WINDSWAY_BEGIN") && stub.uniforms.uWindAmp && stub.uniforms.uTime);
  check("shadow_caster_list.js applies it from the caster walk",
    src("scene3d/shadow_caster_list.js").includes("applySwayShadow(o)"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L10 ?ssao ---------------------------------------------------");
{
  const A = await import("../scene3d/ssao.js");
  const Q = await import("../scene3d/quality.js");
  check("preset decides by default (high/ultra on, low/mid off)",
    A.ssaoEnabled(Q.PRESETS.ultra, "") === true && A.ssaoEnabled(Q.PRESETS.high, "") === true
    && A.ssaoEnabled(Q.PRESETS.mid, "") === false && A.ssaoEnabled(Q.PRESETS.low, "") === false);
  check("?ssao=off beats the preset, ?ssao=on lifts a low tier",
    A.ssaoEnabled(Q.PRESETS.ultra, "?ssao=off") === false && A.ssaoEnabled(Q.PRESETS.low, "?ssao=on") === true);
  const pass = new A.SsaoPass({ isPerspectiveCamera: true, projectionMatrix: { elements: new Array(16).fill(1) }, far: 5000 });
  pass.setSize(1920, 1080);
  check("AO renders at half resolution", pass.rtA.width === 960 && pass.rtA.height === 540);
  check("the pass asks the composer for its depth texture and never swaps", pass.needsDepthTexture === true && pass.needsSwap === false);
  const fx = new A.SsaoCompositeEffect(pass);
  pass.enabled = false; fx.update();
  check("`off` zeroes the composite strength (alpha restore still runs)", fx.uniforms.get("uSsaoStrength").value === 0);
  const ssaoSrc = src("scene3d/ssao.js");
  check("composite restores the grass marker's alpha to 1", /mix\(inputColor\.a, 1\.0, grass\)/.test(ssaoSrc));
  check("log depth decoded as exp2(d * log2(far + 1)) - 1", /exp2\(d \* uLogFC\) - 1\.0/.test(ssaoSrc));
  const pipe = src("scene3d/atmosphere_pipeline.js");
  check("composite is the first atmosphere effect after heat haze (before clouds + aerial)",
    pipe.includes("[heatHaze, ssaoComposite, cloudsMain, aerialPerspective, horizonDissolve]"));
  check("the AO pass is added right before fxPass", /if \(ssaoPass\) composer\.addPass\(ssaoPass\);\s*composer\.addPass\(fxPass\);/.test(pipe));
  check("grass is marked only while a composite exists", pipe.includes("SSAO_GRASS_MARKER.value = ssaoComposite ? 1 : 0;"));
  const Gr = await import("../scene3d/terrain_grass.js");
  const sh = {
    vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n#include <project_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main() {\n#include <normal_fragment_begin>\n#include <color_fragment>\n#include <dithering_fragment>\n}",
  };
  Gr.injectTerrainGrassShader(sh);
  check("grass writes the marker after dithering and declares its uniform",
    sh.fragmentShader.indexOf("gl_FragColor.a = mix(gl_FragColor.a, 0.0, uSsaoGrassMarker);") > sh.fragmentShader.indexOf("#include <dithering_fragment>")
    && sh.fragmentShader.includes("uniform float uSsaoGrassMarker;"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L11 ?canopySoften --------------------------------------------");
{
  const C = await import("../scene3d/canopy_soften.js");
  check("default 0.65; off = 0; numbers clamp",
    C.canopySoftenStrength("") === 0.65 && C.canopySoftenStrength("?canopySoften=off") === 0
    && C.canopySoftenStrength("?canopySoften=0.3") === 0.3 && C.canopySoftenStrength("?canopySoften=4") === 1);
  // A 4 m crown made of flat faces: every face normal points straight out of
  // its face; the softened normals must lean toward the crown-radial direction.
  const box = (sx, sy, sz, z0) => {
    const P = [], N = [];
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [nx, ny, nz] of faces) {
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        let x, y, z;
        if (nx) { x = nx; y = a; z = b; } else if (ny) { x = a; y = ny; z = b; } else { x = a; y = b; z = nz; }
        P.push(x * sx / 2, y * sy / 2, z0 + (z + 1) * sz / 2); N.push(nx, ny, nz);
      }
    }
    return { P: new Float32Array(P), N: new Float32Array(N) };
  };
  const crown = box(4, 4, 3.5, 3);
  const before = Float32Array.from(crown.N);
  check("a crown-like group is softened", C.softenCanopyNormals(crown.P, crown.N, 0.65) === true);
  // vertex 0 sits on the +X face at the (-y, low-z) corner: radial leans -y and down.
  check("normals tilt toward the crown-radial direction", crown.N[1] < before[1] - 0.1 && crown.N[2] < before[2] - 0.1,
    `n0 ${[...crown.N.slice(0, 3)].map((v) => v.toFixed(2))}`);
  check("softened normals stay unit length", Math.abs(Math.hypot(crown.N[0], crown.N[1], crown.N[2]) - 1) < 1e-5);
  const trunk = box(0.4, 0.4, 6, 0);
  check("a trunk (tall + thin) is left alone", C.softenCanopyNormals(trunk.P, trunk.N, 0.65) === false);
  const flag = box(2.0, 0.04, 1.5, 4);
  check("a flat panel (flag / banner / card) is left alone", C.softenCanopyNormals(flag.P, flag.N, 0.65) === false);
  const g = { geometry: { attributes: { position: { itemSize: 3, array: box(4, 4, 3.5, 3).P }, normal: { itemSize: 3, array: box(4, 4, 3.5, 3).N, needsUpdate: false } }, userData: {} } };
  check("softenCanopyGroups softens once and marks the geometry", C.softenCanopyGroups([g], 0.65) === 1 && g.geometry.userData.hbCanopySoft === true
    && g.geometry.attributes.normal.needsUpdate === true);
  check("...and never bends a shared geometry twice", C.softenCanopyGroups([g], 0.65) === 0);
  check("statics.js softens wind-responsive models after the content stamp",
    /stampStaticContentKeys\(id, groups\);\s*groupsByModel\.set\(id, groups\);[\s\S]{0,400}windResponds\(vfxDescriptorFor\(id\)\)\) softenCanopyGroups\(groups\)/.test(src("scene3d/statics.js")));
  check("animated scenery softens every part build (3 sites)",
    (src("scene3d/animated_scenery.js").match(/softenCanopyGroups\(/g) || []).length === 3);
}

// ---------------------------------------------------------------------------
console.log("\n-- L12 ?retailFill ----------------------------------------------");
{
  const R = await import("../scene3d/retail_fill.js");
  check("gain: default 4.5, off = 0, on = default, numbers clamp to [0, 20], junk = default",
    R.retailFillGain("") === 4.5 && R.retailFillGain("?retailFill=off") === 0 && R.retailFillGain("?retailFill=on") === 4.5
    && R.retailFillGain("?retailFill=3") === 3 && R.retailFillGain("?retailFill=99") === 20 && R.retailFillGain("?retailFill=x") === 4.5);
  check("the base is the old constant hemisphere (lighting.js HEMI_INTENSITY)",
    R.RETAIL_FILL_BASE === 0.15 && src("scene3d/lighting.js").includes("const HEMI_INTENSITY = 0.15;"));
  const noon = { ambBright: 0.28, dirPitch: 45 };
  check("noon: gain x ambBright (the 1070 tune, 4.5 x 0.28 = 1.26)", near(R.retailFillIntensity(noon, 4.5, false, ""), 1.26, 1e-9));
  check("the retail LSCAPE_LIGHT_MINIMUM floor (0.2) holds under a dim ambient",
    near(R.retailFillIntensity({ ambBright: 0.05, dirPitch: 45 }, 4.5, false, ""), 0.9, 1e-9));
  check("clamped to 2.0 under a bright ambient", R.retailFillIntensity({ ambBright: 0.9, dirPitch: 45 }, 4.5, false, "") === 2.0);
  const night = R.retailFillIntensity({ ambBright: 0.28, dirPitch: 0.9 }, 4.5, false, "");
  check("full night keeps 12 % of the daytime fill (never below the base)", near(night, Math.max(0.15, 1.26 * 0.12), 1e-9), `got ${night}`);
  check("?nightRamp=off: no night fade", near(R.retailFillIntensity({ ambBright: 0.28, dirPitch: 0.9 }, 4.5, false, "?nightRamp=off"), 1.26, 1e-9));
  check("off / enclosed cell / no snapshot: the base",
    R.retailFillIntensity(noon, 0, false, "") === 0.15 && R.retailFillIntensity(noon, 4.5, true, "") === 0.15
    && R.retailFillIntensity(null, 4.5, false, "") === 0.15);
  // tickRetailFill against a fake scene: one hemisphere under a parent.
  const hemi = { isHemisphereLight: true, parent: {}, intensity: 0.15 };
  const scene3d = { scene: { traverse: (fn) => { fn({}); fn(hemi); } }, atmosphereLights: { _indoorMute: false }, skyDome: { _lastIsIndoor: false } };
  R.tickRetailFill(scene3d, noon);
  check("the tick drives the scene's hemisphere light", near(hemi.intensity, 1.26, 1e-9), `got ${hemi.intensity}`);
  scene3d.skyDome._lastIsIndoor = true; // a SeenOutside cottage interior: lit like the street
  R.tickRetailFill(scene3d, noon);
  check("a SeenOutside interior keeps the fill (no cut at the cottage door)", near(hemi.intensity, 1.26, 1e-9));
  scene3d.atmosphereLights._indoorMute = true; // an enclosed dungeon cell
  R.tickRetailFill(scene3d, noon);
  check("an enclosed cell drops to the base", hemi.intensity === 0.15);
  scene3d.atmosphereLights._indoorMute = false;
  R.setRetailFillGain(2);
  R.tickRetailFill(scene3d, noon);
  check("setGain (live A/B) applies on the next tick", near(hemi.intensity, 0.56, 1e-9) && R.retailFillState().gain === 2);
  R.setRetailFillGain(4.5);
  const hemi2 = { isHemisphereLight: true, parent: {}, intensity: 0.15 };
  hemi.parent = null; // the scene was rebuilt: re-find and re-write even at an unchanged value
  scene3d.scene = { traverse: (fn) => fn(hemi2) };
  R.tickRetailFill(scene3d, noon);
  check("a rebuilt scene's new hemisphere is found and written", near(hemi2.intensity, 1.26, 1e-9));
  const loop = src("scene3d/loop.js");
  const iTick = loop.indexOf("tickRetailFill(scene3d, scene3d.skyLightingController._lastState);");
  check("loop.js imports and ticks it right after the sky snapshot",
    loop.includes('import { tickRetailFill } from "./retail_fill.js";') && iTick > loop.indexOf("tickLuminousNight(scene3d.skyLightingController._lastState);")
    && iTick > loop.indexOf("skyLightingController.tick("));
}

// ---------------------------------------------------------------------------
console.log("\n-- L13 ?grassIndoorCull -----------------------------------------");
{
  const M = await import("../scene3d/grass_interior_mask.js");
  check("default on; =off escape", M.grassIndoorCullEnabled("") === true && M.grassIndoorCullEnabled("?grassIndoorCull=off") === false);
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rotZ = (deg, tx, ty, tz) => {
    const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
  };
  const prod = M.mat4Mul(rotZ(37, 5, -3, 2), M.mat4AffineInverse(rotZ(37, 5, -3, 2)));
  check("the affine inverse round-trips", prod.every((v, i) => Math.abs(v - I4[i]) < 1e-9));
  // worldRoot as measured live: AC Z-up -> three Y-up (rotation -90 deg about X).
  const ROOT = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const geom = (x0, y0, z0, x1, y1, z1) => ({ boundingBox: { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } } });
  // container -> mesh-<id> group (the cell frame) -> fused structure mesh; props hang off the container.
  function cell(id, local, structure, prop) {
    const world = M.mat4Mul(ROOT, local);
    const mg = { name: "mesh-" + id.toString(16), matrixWorld: { elements: world }, children: [] };
    mg.children.push({ isMesh: true, name: "surfaces-fused-opaque", geometry: structure, matrixWorld: { elements: world }, children: [] });
    const c = { name: "envcell-" + id.toString(16), children: [mg] };
    if (prop) c.children.push({ isMesh: true, name: "cellstatic", geometry: prop, matrixWorld: { elements: world }, children: [] });
    return c;
  }
  const root = { matrixWorld: { elements: ROOT } };
  // A cottage's ground floor at AC (1000, 2000), floor z 50, yawed 90 deg:
  // local x (+-2 m) runs along world y, local y (+-4 m) along world -x.
  const ground = cell(0xA9B40100, rotZ(90, 1000, 2000, 50), geom(-2, -4, 0, 2, 4, 3), geom(-30, -30, 0, 30, 30, 1));
  const cellar = cell(0xA9B40101, rotZ(90, 1000, 2000, 50), geom(-2, -4, -3, 2, 4, 0.1));
  const upper = cell(0xA9B40102, rotZ(0, 1100, 2000, 53), geom(-3, -3, 0, 3, 3, 3));
  const map = new Map([[0xA9B40100, ground]]);
  const scene3d = { cellContainers3d: map, worldRoot: root };
  const mask = M.createInteriorMask({ checkFrames: 1 });
  check("the first sync builds the index", mask.sync(scene3d) === true && mask.stats().boxes === 1);
  check("...an unchanged cell set is a no-op", mask.sync(scene3d) === false);
  check("a ground point inside the yawed ground-floor cell is culled", mask.contains(1003, 2001, 50.05) === true);
  check("the box is oriented, not world-aligned (3 m along world y is past the 2 m half-width)", mask.contains(1001, 2003, 50) === false);
  check("the 0.25 m wall margin catches the wall foot, and no further",
    mask.contains(1000, 2002.2, 50) === true && mask.contains(1000, 2002.4, 50) === false);
  check("props are not part of the box (a 30 m prop box culls nothing)", mask.contains(1015, 2015, 50) === false);
  check("ground 0.5 m under the floor (a slope) is still under the cell; 1.5 m is not",
    mask.contains(1003, 2001, 49.5) === true && mask.contains(1003, 2001, 48.5) === false);
  const only = (c) => { const m = M.createInteriorMask({ checkFrames: 1 }); m.sync({ cellContainers3d: new Map([[1, c]]), worldRoot: root }); return m; };
  check("a cellar (ceiling at the ground) never culls the lawn above it", only(cellar).contains(1003, 2001, 50) === false);
  check("an upper storey never culls the ground under it", only(upper).contains(1100, 2000, 50) === false);
  map.set(0xA9B40102, upper);
  check("a newly loaded cell re-indexes", mask.sync(scene3d) === true && mask.stats().boxes === 2);
  const bare = { name: "envcell-x", children: [{ name: "mesh-x", matrixWorld: { elements: ROOT }, children: [] }] };
  map.set(0xA9B40199, bare);
  check("a cell whose structure mesh has not attached yet is pending, not a box", mask.sync(scene3d) === true && mask.stats().pending === 1);
  // The pool's exclude hook: refused blades are counted and the rest still live.
  const { createScatterPool } = await import("../scene3d/terrain_scatter.js");
  const oracle = { sample: (x, y, out) => Object.assign(out || {}, { code: 1, family: 1, hasHeight: true, height: 10, normal: { x: 0, y: 0, z: 1 }, cornerCodes: null }) };
  const pool = createScatterPool({
    count: 1024, radiusM: 30, seed: 3, oracle,
    attributes: [{ name: "aOffset", itemSize: 3 }, { name: "aScale", itemSize: 1 }],
    exclude: (x) => x < 400,
  });
  pool.update(0.016, 400, 400, 10);
  const ps = pool.stats();
  check("the scatter pool's exclude test refuses blades (counted) and the rest live",
    ps.excludeRejects > 100 && ps.live > 100, `excl ${ps.excludeRejects} live ${ps.live}`);
  const g = src("scene3d/terrain_grass.js");
  check("terrain_grass.js feeds the mask to the pool and re-examines on a change",
    g.includes("exclude: indoorMask ? (x, y, z) => indoorMask.contains(x, y, z) : undefined")
    && /indoorMask\.sync\([^)]*\)\) pool\.invalidate\(\)/.test(g));
}

// ---------------------------------------------------------------------------
console.log("\n-- L14 dusk: fog probe vs the sun, night glint -------------------");
{
  const F = await import("../scene3d/far_terrain_flags.js");
  const D = Math.PI / 180;
  const sunAt = (azDeg, elDeg) => ({ x: Math.cos(elDeg * D) * Math.sin(azDeg * D), y: Math.sin(elDeg * D), z: Math.cos(elDeg * D) * Math.cos(azDeg * D) });
  const ang = (fx, fz, elRad, sun) => {
    const px = Math.cos(elRad) * fx, py = Math.sin(elRad), pz = Math.cos(elRad) * fz;
    return Math.acos(Math.min(1, px * sun.x + py * sun.y + pz * sun.z)) / D;
  };
  const el = 2 * D;
  check("default 45 deg; off / 0 disable", F.farFogSunAvoidDeg() === 45);
  // Facing a 2-deg sun dead ahead: the probe turns to >= 45 deg from it.
  const sun = sunAt(270, 2.2);
  const fwd = { x: Math.sin(270 * D), z: Math.cos(270 * D) };
  const o = F.avoidSunAzimuth(fwd.x, fwd.z, el, sun, 45);
  check("facing a setting sun, the probe turns 45 deg away from it",
    Math.abs(ang(o.x, o.z, el, sun) - 45) < 0.05 && Math.abs(Math.hypot(o.x, o.z) - 1) < 1e-9, `angle ${ang(o.x, o.z, el, sun).toFixed(2)}`);
  // 20 deg left of the sun stays on the left.
  const f2 = { x: Math.sin(250 * D), z: Math.cos(250 * D) };
  const o2 = F.avoidSunAzimuth(f2.x, f2.z, el, sun, 45);
  const sideOf = (x, z) => Math.sign(sun.x * z - sun.z * x);
  check("...keeping the camera's side of the sun", sideOf(o2.x, o2.z) === sideOf(f2.x, f2.z) && Math.abs(ang(o2.x, o2.z, el, sun) - 45) < 0.05);
  const f3 = { x: Math.sin(180 * D), z: Math.cos(180 * D) };
  const o3 = F.avoidSunAzimuth(f3.x, f3.z, el, sun, 45);
  check("90 deg off the sun: unchanged", o3.x === f3.x && o3.z === f3.z);
  const noon = sunAt(270, 68);
  const o4 = F.avoidSunAzimuth(fwd.x, fwd.z, el, noon, 45);
  check("a high sun is never inside 45 deg of a 2-deg probe: unchanged", o4.x === fwd.x && o4.z === fwd.z);
  const o5 = F.avoidSunAzimuth(fwd.x, fwd.z, el, sun, 0);
  check("minDeg 0 (=off): unchanged", o5.x === fwd.x && o5.z === fwd.z);
  const loop = src("scene3d/loop.js");
  check("the probe aims through avoidSunAzimuth at the SKY's sun",
    /avoidSunAzimuth\(_fogProbeFwd\.x, _fogProbeFwd\.z, elev, skySun, farFogSunAvoidDeg\(\), _fogProbeAvoid\)/.test(loop)
    && loop.includes("scene3d.atmosphereSky?.skyMaterial?.sunDirection"));
  check("the light tick pushes the night glint fade onto the terrain",
    loop.includes("g.sunGlint = sunGlintMul(state);") && loop.includes("if (u.uSunGlint) u.uSunGlint.value = g.sunGlint;"));
  // The glint follows the SKY's sun (the night-ramp art pitch): authored 6.36
  // deg (t 0.19) is art -4.3 -> 0; authored 10 (art 2.2) -> 0.8; noon -> 1.
  const N = await import("../scene3d/night_ramp.js");
  const glint = (authored) => Math.min(1, Math.max(0, (N.artSunPitchDeg(authored) + 1) / 4));
  check("glint fade: 0 with the sky's sun down, ~0.8 at a 2 deg sun, 1 by day",
    glint(6.36) === 0 && glint(8.18) === 0 && Math.abs(glint(10) - 0.8) < 0.01 && glint(68) === 1
    && /export const SUN_GLINT_FADE_DEG = Object\.freeze\(\[-1, 3\]\);/.test(loop));
}

// ---------------------------------------------------------------------------
console.log("\n-- L15 reflection cube: viewer position + clouds ------------------");
{
  const ibl = src("scene3d/ibl_environment.js");
  check("the PMREM renders from the viewer", ibl.includes("this._pmrem.fromScene(this.skyScene, 0.03, 0.1, 1e7, { position: this._viewPos })"));
  check("...and so does the terrain cube camera",
    /this\._cubeCam\.position\.copy\(this\._viewPos\);\s*this\._cubeCam\.updateMatrixWorld\(true\);\s*this\._cubeCam\.update\(this\.renderer, this\.skyScene\);/.test(ibl));
  check("?waterClouds: default on, =off escape",
    /export function readWaterCloudsFlag\(search\)[\s\S]{0,420}if \(v == null\) return true;[\s\S]{0,120}t === "off"/.test(ibl));
  check("each cube texel projects its own direction into the main view and samples the clouds there",
    ibl.includes("vec3 dir = normalize(mat3(uFaceWorld) * (v.xyz / v.w));")
    && ibl.includes("vec4 clip = uViewProj * vec4(uViewPos + dir * 1.0e4, 1.0);")
    && ibl.includes("c = texture2D(uClouds, uv);"));
  check("off-screen directions take the upper screen's mean cloud", ibl.includes("vec4 c = offscreenClouds();"));
  check("composited like AerialPerspective (premultiplied over the clear sky)",
    ibl.includes("blendSrc: THREE.OneFactor,") && ibl.includes("blendDst: THREE.OneMinusSrcAlphaFactor,"));
  check("one mip generation after the last face", ibl.includes("tex.generateMipmaps = f === 5 ? genMips : false;"));
  check("the terrain cube follows the clouds at 1 Hz; the PMREM keeps its cadence",
    /export const CLOUD_CUBE_REFRESH_MS = 1000;/.test(ibl)
    && /else if \(nowMs - this\._lastCubeMs >= CLOUD_CUBE_REFRESH_MS && this\._cloudsBuffer\(\)\)/.test(ibl));
  const idx = src("scene3d/index.js");
  check("index.js hands the IBL the camera and the main-pass clouds buffer",
    idx.includes("camera: liveScene3d.camera,") && idx.includes("liveScene3d.cloudOverlay?.volume?.effect?.cloudsPass?.outputBuffer"));
}

// ---------------------------------------------------------------------------
console.log("\n-- L9 docs ------------------------------------------------------");
{
  const doc = src("docs/url-flags.md");
  for (const f of ["tone", "grade", "lumNight", "adaptiveResBootGrace", "swayShadow", "ssao", "canopySoften", "retailFill", "grassIndoorCull", "farFogSunAvoid", "waterClouds"]) {
    check(`url-flags.md row: ${f}`, doc.includes("| `" + f + "` |"));
  }
}

console.log(`\nlook pass: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
