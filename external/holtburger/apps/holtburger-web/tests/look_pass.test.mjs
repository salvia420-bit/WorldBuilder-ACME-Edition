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
console.log("\n-- L9 docs ------------------------------------------------------");
{
  const doc = src("docs/url-flags.md");
  for (const f of ["tone", "grade", "lumNight", "adaptiveResBootGrace", "swayShadow", "ssao", "canopySoften"]) {
    check(`url-flags.md row: ${f}`, doc.includes("| `" + f + "` |"));
  }
}

console.log(`\nlook pass: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
