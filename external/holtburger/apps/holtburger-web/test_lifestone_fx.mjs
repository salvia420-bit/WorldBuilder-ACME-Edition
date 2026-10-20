// test_lifestone_fx.mjs — the lifestone's glow (`?lifestoneFx`, 2026-10-11).
//
// Owner, on the GTX 1070: "there is a light shaft coming from the lifestone or
// something, which is undesirable, instead add more of a glowing emanance and
// make the crystal look more lifelike." scene3d/vfx/lifestone_fx.js + the aura
// kind in scene3d/vfx/fx_showcase.js (+ the `skip` seam in fx_lights.js).
//
// Guards:
//   1. the flag: default ON, off / 0 / false / no escape, other values keep it;
//      the seam; a literal reader the url-flag lints can see; the docs row
//   2. GLSL hygiene: no backticks in any shader string; no pow() in the new GLSL;
//      every pow() left in the showcase has a base in [0, 1]; the flare's ghost
//      ring is squared by hand; balanced braces / parens
//   3. the crystal patch on three's real MeshStandard sources: once, idempotent,
//      at the right seams, uniforms by reference, everything gated by the level,
//      inert on a non-PBR material; it keeps the VFX component contract and is
//      not registered in the catalog; the module passes the legacy-safety scan
//   4. a lifestone end to end through the showcase: no shaft, no ring; the
//      crystal gets an OWNED variant (CSM re-installed, the set key) once warmed;
//      the aura sits on the crystal; the level ramps in; one light carrier
//   5. two lifestones: two materials, ONE program key, identical compiled
//      sources (0 new programs); one showcase draw; one glow program
//   6. the light: day / night, breathing; no carrier for a stone with its own
//      emitter light (whose colour the set piece takes)
//   7. lifecycle: base mirroring (no per-frame needsUpdate), a re-point rebuilds,
//      out of range fades out and reverts, a disposed entity drops at once, the
//      showcase switched off reverts; the glow extra at high / ultra
//   8. calibration on the Neutral tone curve at exposure 5: the shaped crystal
//      stays blue (no whitening), the aura is a bounded lift by day and a visible
//      glow at night (a fraction of the old shaft's), the motes are bright specks
//   9. `?lifestoneFx=off`: the 2026-10-10 shaft + ring, no state, no light, the
//      crystal untouched
//
// Run from apps/holtburger-web/:  node test_lifestone_fx.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (hay, needle) => hay.split(needle).length - 1;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

async function run() {
  globalThis.window = globalThis.window || {};
  globalThis.location = { search: "" };
  window.location = globalThis.location;
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};

  const ls = await import("./scene3d/vfx/lifestone_fx.js");
  const show = await import("./scene3d/vfx/fx_showcase.js");
  const dec = await import("./scene3d/vfx/fx_decals.js");
  const fxl = await import("./scene3d/vfx/fx_lights.js");
  const t1f = await import("./scene3d/vfx/fx_tier1.js");
  const t2f = await import("./scene3d/vfx/fx_tier2.js");
  const poc = await import("./scene3d/particles_over_clouds.js");
  const { MaterialCache, VFX_GLOBALS } = await import("./scene3d/materials.js");
  const { validateComponent, getComponent } = await import("./scene3d/vfx/registry.js");
  const { lintManifest, lintSource } = await import("./scene3d/vfx/lint_caps.js");
  const { neutralToneMap } = await import("./scene3d/tone_curve.js");
  const { nightFactorFromAuthoredPitch } = await import("./scene3d/night_ramp.js");
  await ls._lifestoneFxModulesForTest();

  // ---- 1. the flag -----------------------------------------------------------------------------------
  console.log("1. the flag");
  check("1. ?lifestoneFx defaults ON (no query, other flags only)",
    ls.readLifestoneFxFlag("") === true && ls.readLifestoneFxFlag("?quality=mid&fxShowcase=on") === true);
  check("1. off / 0 / false / no (any case, padded) are the escape",
    ["off", "0", "false", "no", "OFF", " Off "].every((v) => ls.readLifestoneFxFlag("?lifestoneFx=" + encodeURIComponent(v)) === false));
  check("1. on / 1 / true / yes / anything else keep it on",
    ["on", "1", "true", "yes", "banana", ""].every((v) => ls.readLifestoneFxFlag("?lifestoneFx=" + v) === true));
  check("1. lifestoneFxEnabled(): on with no flag; the seam forces off and restores",
    ls.lifestoneFxEnabled() === true && (ls._setLifestoneFxForTest(false), ls.lifestoneFxEnabled() === false) &&
    (ls._setLifestoneFxForTest(null), ls.lifestoneFxEnabled() === true));
  const lsSrc = src("./scene3d/vfx/lifestone_fx.js");
  check("1. the reader is a literal URLSearchParams .get(\"lifestoneFx\") with the 0 / false spellings (the url-flag lints see it)",
    lsSrc.includes('.get("lifestoneFx")') && lsSrc.includes('on = s !== "off" && s !== "0" && s !== "false" && s !== "no";') &&
    lsSrc.includes("let on = true; // default-on; ?lifestoneFx=off is the escape"));
  const flagsDoc = src("./docs/url-flags.md");
  check("1. docs/url-flags.md carries a lifestoneFx row (default ON, the escape spellings)",
    /^\| `lifestoneFx` \| `off`\/`0`\/`false`\/`no` \(escape\) \| \*\*ON\*\*/m.test(flagsDoc));

  // ---- 2. GLSL hygiene -------------------------------------------------------------------------------
  console.log("2. GLSL hygiene");
  const SG = show.FX_SHOWCASE_GLSL;
  const CG = ls.LIFESTONE_CRYSTAL_GLSL;
  const GG = ls.LIFESTONE_GLOW_GLSL;
  const auraFrag = SG.fragment.slice(SG.fragment.indexOf("// lifestone aura (vfx/lifestone_fx.js)"), SG.fragment.indexOf("c *= vCol.a * vInfo.w;"));
  const auraVert = SG.vertex.slice(SG.vertex.indexOf("// lifestone aura: camera-facing"), SG.vertex.indexOf("vDepth = -mv.z;"));
  const allGlsl = [SG.vertex, SG.fragment, CG.vertexDecls, CG.vertexBody, CG.fragmentDecls, CG.fragmentBody, GG.vertex, GG.fragment];
  check("2. no backticks in any shader string (showcase, crystal patch, crystal glow)", allGlsl.every((g) => !g.includes("`")));
  const code = (g) => g.replace(/\/\/[^\n]*/g, "");   // GLSL with its // comments blanked (a comment is not a call)
  check("2. the new GLSL calls no pow() (crystal patch, crystal glow, the aura branch)",
    auraFrag.length > 200 && auraVert.length > 50 &&
    [CG.vertexDecls, CG.vertexBody, CG.fragmentDecls, CG.fragmentBody, GG.vertex, GG.fragment, auraFrag, auraVert].every((g) => !/\bpow\s*\(/.test(code(g))));
  const sgFragCode = code(SG.fragment);
  const powSites = [...sgFragCode.matchAll(/\bpow\s*\(/g)].map((m) => sgFragCode.slice(m.index, m.index + 40));
  check("2. every pow() left in the showcase has a base in [0, 1]: 0.5 + 0.5 * sin(...) (disc stars, shaft glitter)",
    powSites.length === 2 && powSites.every((s) => /^pow\(\s*0\.5 \+ 0\.5 \* sin\(/.test(s)), JSON.stringify(powSites));
  check("2. the flare's ghost ring is squared by hand (no pow of the signed offset)",
    SG.fragment.includes("float k = ( length( q ) - 1.6 ) / 0.12;") && SG.fragment.includes("float ring = exp( -k * k ) * 0.25;") &&
    !SG.fragment.includes("exp( -pow("));
  for (const [n, g] of [["showcase vertex", SG.vertex], ["showcase fragment", SG.fragment], ["crystal fragment decls", CG.fragmentDecls],
    ["crystal fragment body", CG.fragmentBody], ["crystal vertex body", CG.vertexBody], ["glow vertex", GG.vertex], ["glow fragment", GG.fragment]]) {
    check(`2. ${n}: balanced braces and parens`, count(g, "{") === count(g, "}") && count(g, "(") === count(g, ")"));
  }
  // Static name check (no GPU here): every identifier the new GLSL uses is declared
  // in it, a GLSL builtin, or provided by three at that seam. Catches typos and
  // names that only exist in another stage.
  const GLSL_WORDS = new Set(["abs", "max", "min", "clamp", "mix", "smoothstep", "step", "sin", "cos", "exp", "exp2", "fract",
    "floor", "dot", "cross", "normalize", "length", "reflect", "refract", "dFdx", "dFdy", "inverse", "sqrt", "atan", "pow",
    "texture2D", "vec2", "vec3", "vec4", "float", "int", "bool", "mat3", "mat4", "if", "else", "for", "return", "uniform",
    "varying", "attribute", "true", "false", "discard", "highp", "sampler2D", "void", "main", "gl_Position", "gl_FragCoord",
    "gl_FragColor"]);
  const undeclared = (glsl, provided) => {
    const c = code(glsl).replace(/^\s*#[^\n]*$/gm, "");
    const declared = new Set();
    for (const m of c.matchAll(/\b(?:float|vec2|vec3|vec4|int|bool|mat3|mat4|sampler2D)\s+([A-Za-z_]\w*)/g)) declared.add(m[1]);
    const used = new Set();
    for (const m of c.matchAll(/(?<![.\w])([A-Za-z_]\w*)/g)) used.add(m[1]);
    return [...used].filter((n) => !declared.has(n) && !GLSL_WORDS.has(n) && !provided.has(n));
  };
  const u1 = undeclared(CG.vertexDecls + CG.vertexBody, new Set(["transformed", "objectNormal", "modelViewMatrix"]));
  const u2 = undeclared("uniform float uTime;\n" + CG.fragmentDecls + CG.fragmentBody,
    new Set(["diffuseColor", "totalEmissiveRadiance", "roughnessFactor", "vViewPosition"]));
  const u3 = undeclared(GG.vertex, new Set(["position", "normal", "modelViewMatrix", "normalMatrix", "projectionMatrix"]));
  const u4 = undeclared(GG.fragment, new Set());
  const u5 = undeclared(SG.vertex, new Set(["position", "viewMatrix", "projectionMatrix", "cameraPosition"]));
  const u6 = undeclared(SG.fragment, new Set());
  check("2. static name check: every identifier in the new / changed GLSL is declared, a builtin, or three's at that seam",
    [u1, u2, u3, u4, u5, u6].every((u) => u.length === 0), JSON.stringify({ u1, u2, u3, u4, u5, u6 }));
  check("2. the glow variant still draws only the flares; the scene draws the aura (kind 4)",
    SG.vertex.includes("bool keep = kind > 2.5 && kind < 3.5;") && SG.vertex.includes("bool keep = kind < 2.5 || kind > 3.5 || uShowFlareInScene > 0.5;") &&
    show.FX_SHOWCASE_KIND.aura === 4 && show.FX_SHOWCASE_KIND.shaft === 2 && show.FX_SHOWCASE_KIND.flare === 3 && show.FX_SHOWCASE_KIND.disc === 1);

  // ---- 3. the crystal patch on three's real sources ---------------------------------------------------
  console.log("3. the crystal patch");
  const P = ls.LIFESTONE_CRYSTAL_PATCH;
  const freshShader = (lib = "standard") => {
    const sl = THREE.ShaderLib[lib];
    return { uniforms: THREE.UniformsUtils.clone(sl.uniforms), vertexShader: sl.vertexShader, fragmentShader: sl.fragmentShader };
  };
  const stU = { uLsLevel: { value: 0 }, uLsBreath: { value: 1 }, uLsSeed: { value: 0.3 }, uLsLumBoost: { value: 1 }, uLsColor: { value: { x: 0.55, y: 0.78, z: 1 } } };
  const meU = { uLsCore: { value: { x: 0, y: 0, z: 0 } }, uLsHalf: { value: { x: 1, y: 1, z: 1 } } };
  const shA = freshShader();
  P.declareUniforms(shA, {}, { uTime: VFX_GLOBALS.uTime, ls: stU, lsMesh: meU });
  P.inject(shA);
  const vs1 = shA.vertexShader, fs1 = shA.fragmentShader;
  P.inject(shA);
  check("3. spliced once; a re-inject is a no-op", shA.vertexShader === vs1 && shA.fragmentShader === fs1 && count(fs1, ls.LS_MARKER) === 1);
  check("3. vertex: varyings declared once; object-space position / normal and eye after project_vertex",
    count(vs1, "varying vec3 vHbLsObj;") === 1 && vs1.indexOf("#include <project_vertex>") < vs1.indexOf("vHbLsObj = transformed;") &&
    vs1.includes("vHbLsEye = ( inverse( modelViewMatrix ) * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;") && count(vs1, "#include <project_vertex>") === 1);
  check("3. fragment: helpers before main(); the body after the emissive seam and before the lights",
    fs1.indexOf("float hbLsVeins") < fs1.indexOf("void main()") && fs1.indexOf("#include <emissivemap_fragment>") < fs1.indexOf(ls.LS_MARKER) &&
    fs1.indexOf(ls.LS_MARKER) < fs1.indexOf("#include <lights_physical_fragment>") && fs1.indexOf("#include <roughnessmap_fragment>") < fs1.indexOf(ls.LS_MARKER));
  check("3. uTime declared exactly once (and only if absent)", count(fs1, "uniform float uTime;") === 1);
  check("3. uniforms bound BY REFERENCE (the lifestone's, the mesh's, the shared ones, the VFX clock)",
    shA.uniforms.uLsLevel === stU.uLsLevel && shA.uniforms.uLsColor === stU.uLsColor && shA.uniforms.uLsCore === meU.uLsCore &&
    shA.uniforms.uTime === VFX_GLOBALS.uTime && !!shA.uniforms.uLsCal && !!shA.uniforms.uLsGain && !!shA.uniforms.uLsShape);
  const body = CG.fragmentBody;
  check("3. everything in the body is gated by uLsLevel > 0 and mixed by it (level 0 = the retail surface exactly)",
    body.trim().startsWith(ls.LS_MARKER) && body.indexOf("if ( uLsLevel > 0.0 ) {") < body.indexOf("totalEmissiveRadiance") &&
    body.trim().endsWith("}") && count(body, "totalEmissiveRadiance") === 2 &&
    body.includes("totalEmissiveRadiance *= mix( vec3( 1.0 ),") && body.includes("totalEmissiveRadiance += lsAdd * ( uLsCal * lsL );") &&
    body.includes("diffuseColor.a = mix( diffuseColor.a, lsA, lsL );") && body.includes("roughnessFactor = mix( roughnessFactor, uLsGain.w, lsL );"));
  check("3. the inner light is sampled along the REFRACTED view ray (parallax), in object space",
    body.includes("vec3 lsR = refract( lsV, lsNf, 0.645 );") && body.includes("hbLsVeins( lsP + lsRd * 0.22") && body.includes("vec3 lsV = normalize( vHbLsObj - vHbLsEye );"));
  check("3. facet normals from derivatives (flat facets flash); glints against view-fixed lights",
    body.includes("cross( dFdx( vHbLsObj ), dFdy( vHbLsObj ) )") && body.includes("cross( dFdx( vViewPosition ), dFdy( vViewPosition ) )"));
  const lam = freshShader("lambert");
  P.inject(lam);
  check("3. inert on a non-PBR (Lambert) material", lam.fragmentShader === THREE.ShaderLib.lambert.fragmentShader && lam.vertexShader === THREE.ShaderLib.lambert.vertexShader);
  check("3. the patch keeps the VFX component contract (validateComponent + lintManifest pass)",
    validateComponent(P).length === 0 && lintManifest(P).length === 0, JSON.stringify([validateComponent(P), lintManifest(P)]));
  check("3. it is NOT registered in the descriptor catalog (only lifestone_fx installs it)", getComponent(P.id) === undefined);
  const lintHits = lintSource(lsSrc);
  check("3. lifestone_fx.js passes the legacy-safety source scan (no Math.random / Date.now() / .visible= / per-instance key)",
    lintHits.length === 0, JSON.stringify(lintHits));

  // ---- 4. a lifestone end to end ---------------------------------------------------------------------
  console.log("4. a lifestone end to end");
  const csmState = { uniforms: Object.fromEntries(["uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", "uCsmMatrix0", "uCsmMatrix1",
    "uCsmMatrix2", "uCsmSplits", "uCsmFar", "uCsmBlend"].map((k) => [k, { value: null }])) };
  const mc = new MaterialCache({ csmState });
  const crystalTex = new THREE.DataTexture(new Uint8Array([66, 132, 216, 255]), 1, 1);
  // what the cache builds for surface 0x080011DE (Translucent 0.25, luminosity 0.75):
  // map + white emissive x 0.75 with the map as emissiveMap, alpha 0.75, depthWrite off
  const crystalBase = () => {
    const m = new THREE.MeshStandardMaterial({ map: crystalTex, emissive: 0xffffff, emissiveIntensity: 0.75, emissiveMap: crystalTex,
      roughness: 0.9, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
    m.name = "scene3d-surface-080011de";
    m.userData = { __cacheOwned: true, csmEnabled: true, detailEnabled: true, hbLumBase: 0.75 };
    return m;
  };
  const clawMat = new THREE.MeshStandardMaterial({ map: crystalTex, roughness: 0.9 });
  clawMat.userData = { __cacheOwned: true };
  // Setup 0x020002EE in miniature: three claws round a crystal part at (0, 0, 2)
  // (AC frame, Z up, under a rig turned to THREE's Y up); the crystal shaped to
  // GfxObj 0x01000CFA's bounds (x -0.75..0.56, y -0.91..0.87, z -1.35..1.61)
  const makeStone = (guid, x, z, base) => {
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    const rig = new THREE.Group();
    rig.rotation.x = -Math.PI / 2;
    root.add(rig);
    const parts = [];
    for (const [px, py] of [[-0.89, 0], [0.42, 0.67], [0.54, -0.59]]) {
      const part = new THREE.Group();
      part.position.set(px, py, 0);
      const claw = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 2.2).translate(0, 0, 1.1), clawMat);
      claw.userData = { surfaceDid: 0x080011df };
      part.add(claw);
      rig.add(part);
      parts.push(part);
    }
    const cpart = new THREE.Group();
    cpart.position.set(0, 0, 2);
    const geo = new THREE.OctahedronGeometry(1);
    geo.scale(0.65, 0.89, 1.48);
    geo.translate(-0.1, -0.02, 0.13);
    const crystal = new THREE.Mesh(geo, base);
    crystal.userData = { surfaceDid: 0x080011de };
    cpart.add(crystal);
    rig.add(cpart);
    parts.push(cpart);
    return { guid, root, parts, meta: { objDescFlags: show.ODF_LIFESTONE }, crystal, base };
  };
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();
  fxl._resetFxLightsForTest();
  const scene = new THREE.Scene();
  const stone = makeStone(0x70000101, 0, 0, crystalBase());
  scene.add(stone.root);
  scene.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  cam.position.set(0, 2, 10);
  cam.updateMatrixWorld(true);
  const sky = { _lastState: { dirPitch: 60 } };   // noon
  const s3d = { entityManager: { entityMap: new Map([[stone.guid, stone]]), materialCache: mc }, scene, camera: cam,
    renderer: { toneMappingExposure: 5 }, skyLightingController: sky };
  const lightsBefore = fxl.fxLightsStats().emitterLightsNow;
  show.tickFxShowcase(s3d, 1000);
  const st = ls.lifestoneFxStateOf(stone);
  check("4. the scan hands the lifestone to lifestone_fx (a state at level 0)", !!st && st.level === 0 && st.recs.size === 1);
  check("4. the crystal keeps its base until its variant has been warmed (no blink, no sync link)", stone.crystal.material === stone.base);
  await settle();
  const v1 = stone.crystal.material;
  check("4. after the warm the crystal wears an OWNED variant (entity-freed, not cache-owned, same texture)",
    v1 !== stone.base && v1.userData.__lsCrystal === st.id && v1.userData.__disposable === true && v1.userData.__cacheOwned === undefined &&
    v1.map === stone.base.map && v1.name.endsWith("+lifestone"));
  check("4. the claws keep their shared material (only the translucent crystal is touched)",
    stone.parts.slice(0, 3).every((p) => p.children[0].material === clawMat));
  const key1 = v1.customProgramCacheKey();
  check("4. program key: CSM re-installed, the lost detail flag dropped, the lifestone SET (never the instance)",
    // 2026-10-20 (shadows-restore-2/-4): the CSM token is the hook version `|c2`.
    v1.userData.csmEnabled === true && v1.userData.detailEnabled === undefined && key1.includes("|c2") && key1.includes("|d0") &&
    key1.endsWith("|v" + ls.LS_SET_KEY), key1);
  const shV = freshShader();
  v1.onBeforeCompile(shV, null);
  check("4. the compile hook carries CSM and the crystal, with this lifestone's uniforms",
    shV.fragmentShader.includes("_csmShadowFactor") && shV.fragmentShader.includes(ls.LS_MARKER) &&
    shV.uniforms.uLsLevel === st.u.uLsLevel && shV.uniforms.uLsCore === st.recs.get(stone.crystal).u.uLsCore);
  const core = st.recs.get(stone.crystal).u;
  check("4. the mesh's own bounds feed the inner light (core / half-extents, object space)",
    near(core.uLsCore.value.x, -0.1, 1e-3) && near(core.uLsCore.value.z, 0.13, 1e-3) && near(core.uLsHalf.value.z, 1.48, 1e-3) &&
    near(core.uLsHalf.value.x, 0.65, 1e-3));
  check("4. no shaft and no ground ring for the lifestone", dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 1000).length === 0);
  show.tickFxShowcase(s3d, 1700);
  const sMesh = scene.children.find((o) => o.userData?.isFxShowcase);
  const A = sMesh.geometry.attributes;
  check("4. one aura instance (kind 4) once the level ramps in", sMesh.geometry.instanceCount === 1 && A.aS0.array[3] === show.FX_SHOWCASE_KIND.aura &&
    near(st.level, 0.5, 1e-6) && near(A.aS1.array[2], 0.5, 1e-6));
  // the crystal turns about its part's vertical axis: the aura is centred on it and
  // sized by the farthest vertex from it (both stay put while it turns)
  check("4. the aura sits on the crystal: centre on the axis at mid-height, radii = extents + the margin",
    near(A.aS0.array[0], 0, 1e-4) && near(A.aS0.array[1], 2.13, 1e-3) && near(A.aS0.array[2], 0, 1e-4) &&
    near(st.hh, 1.48, 1e-3) && near(st.hw, Math.hypot(0.1, 0.91), 1e-3) &&
    near(A.aS1.array[0], st.hw + ls.LIFESTONE_AURA_MARGIN_M, 1e-5) && near(A.aS1.array[1], st.hh + ls.LIFESTONE_AURA_MARGIN_M, 1e-5),
    JSON.stringify({ c: [...A.aS0.array.slice(0, 3)], hw: st.hw, hh: st.hh }));
  const ce = A.aS3.array[1];
  check("4. aura terms: the crystal's edge in aura units, the breath, the soft share",
    ce > 0.4 && ce < 0.75 && A.aS3.array[2] > 0.85 && A.aS3.array[2] < 1.15 && near(A.aS3.array[3], ls.LIFESTONE_FX_DEFAULTS.auraDay, 1e-6));
  check("4. the crystal's uniforms follow the level; the shared calibration is 1 / exposure",
    near(st.u.uLsLevel.value, 0.5, 1e-6) && near(shV.uniforms.uLsCal.value, 0.2, 1e-9));
  show.tickFxShowcase(s3d, 3000);
  check("4. the level reaches 1 after the fade-in", st.level === 1 && st.u.uLsLevel.value === 1);
  check("4. ONE light carrier inside the crystal (an FX source: no light added to the scene)",
    fxl.fxLightsStats().emitterLightsNow === lightsBefore + 1 && st.lightOurs === true && ls.isLifestoneLightCarrier(st.light) &&
    !scene.children.some((o) => o.isLight));
  const lp = new THREE.Vector3();
  check("4. the carrier sits in the lower crystal (centre - 0.35 x half-height)",
    st.light.resolvePosition(lp) && near(lp.y, 2.13 - 0.35 * 1.48, 1e-3) && near(lp.x, 0, 1e-4));

  // ---- 5. two lifestones: zero new programs -----------------------------------------------------------
  console.log("5. two lifestones");
  const stone2 = makeStone(0x70000102, -6, 0, crystalBase());
  scene.add(stone2.root);
  scene.updateMatrixWorld(true);
  s3d.entityManager.entityMap.set(stone2.guid, stone2);
  show.tickFxShowcase(s3d, 3600);
  await settle();
  show.tickFxShowcase(s3d, 4400);
  const st2 = ls.lifestoneFxStateOf(stone2);
  const v2 = stone2.crystal.material;
  check("5. the second crystal: its own material and uniforms", !!st2 && v2 !== v1 && v2.userData.__lsCrystal === st2.id && st2.u !== st.u);
  check("5. …and the SAME program key", v2.customProgramCacheKey() === key1);
  const sh1 = freshShader(), sh2 = freshShader();
  v1.onBeforeCompile(sh1, null);
  v2.onBeforeCompile(sh2, null);
  check("5. identical compiled sources (three's program cache hands both one program: 0 new programs)",
    sh1.vertexShader === sh2.vertexShader && sh1.fragmentShader === sh2.fragmentShader &&
    sh1.uniforms.uLsLevel !== sh2.uniforms.uLsLevel && sh1.uniforms.uLsCal === sh2.uniforms.uLsCal);
  check("5. different seeds (each stone's pattern differs; stable per guid)", st.seed !== st2.seed && ls.lifestoneSeed(stone.guid) === st.seed);
  check("5. still ONE showcase mesh / material / draw — two aura instances",
    scene.children.filter((o) => o.userData?.isFxShowcase).length === 1 && sMesh.material.name === "fx-showcase" &&
    show.fxShowcaseStats().auras === 2 && sMesh.geometry.instanceCount === 2);

  // ---- 6. the light ----------------------------------------------------------------------------------
  console.log("6. the light");
  const T = ls.LIFESTONE_FX_DEFAULTS;
  check("6. night fractions used: noon 0, the authored midnight pitch (0.9 deg) 1",
    nightFactorFromAuthoredPitch(60) === 0 && near(nightFactorFromAuthoredPitch(0.9), 1, 1e-6));
  const dayI = [];
  for (let t = 5000; t <= 10200; t += 650) { show.tickFxShowcase(s3d, t); dayI.push(st.light.baseIntensity / st.breath); }
  const dayB = [];
  for (let t = 10300; t <= 15500; t += 650) { show.tickFxShowcase(s3d, t); dayB.push(st.light.baseIntensity); }
  check("6. by day the light runs at lightDay x its night value (breath divided out)",
    dayI.every((v) => near(v, T.light * T.lightDay, 1e-9)), JSON.stringify(dayI.slice(0, 3)));
  check("6. it breathes (+-breathAmp over a period)",
    Math.max(...dayB) > T.light * T.lightDay * 1.06 && Math.min(...dayB) < T.light * T.lightDay * 0.94, JSON.stringify([Math.min(...dayB), Math.max(...dayB)]));
  sky._lastState.dirPitch = 0.9;   // midnight
  show.tickFxShowcase(s3d, 16000);
  check("6. at night: the full intensity (x breath); the aura's soft share 1",
    near(st.light.baseIntensity / st.breath, T.light, 1e-9) && near(ls.lifestoneFxAuras([])[0].soft, 1, 1e-9));
  check("6. range from the tuning; its colour the stone's", near(st.light.distance, T.lightRange, 1e-9) && near(st.light.color.b, 1, 1e-6));
  sky._lastState.dirPitch = 60;
  // a stone with its OWN emitter light (the 9 "new" stones, Setup 0x02000EAD)
  const stone3 = makeStone(0x70000103, 0, -8, crystalBase());
  scene.add(stone3.root);
  scene.updateMatrixWorld(true);
  s3d.entityManager.entityMap.set(stone3.guid, stone3);
  const own = fxl.bindEmitterFxLight({ emitter: { numParticles: 4, parent: stone3.root }, resolvePosition: (o) => o.set(0, 2.2, -8),
    intensity: 20, range: 6, color: [0.3, 0.9, 1.0] });
  show.tickFxShowcase(s3d, 16600);
  const st3 = ls.lifestoneFxStateOf(stone3);
  check("6. a stone with its own emitter light: no carrier is added, and its colour (max channel 1) is used",
    !!st3 && st3.lightOurs === false && st3.realLight === true && st3.light === null &&
    near(st3.color[0], 0.3, 1e-6) && near(st3.color[1], 0.9, 1e-6) && near(st3.color[2], 1, 1e-6), JSON.stringify(st3 && st3.color));
  check("6. fxEmitterLightNear's skip leaves the carriers out (a stone's real light is told apart)",
    fxl.fxEmitterLightNear(new THREE.Vector3(0, 1.5, 0), 3, ls.isLifestoneLightCarrier) === null &&
    fxl.fxEmitterLightNear(new THREE.Vector3(0, 1.5, 0), 3) === st.light);
  fxl.releaseFxLight(own);
  s3d.entityManager.entityMap.delete(stone3.guid);

  // ---- 7. lifecycle ----------------------------------------------------------------------------------
  console.log("7. lifecycle");
  show.tickFxShowcase(s3d, 17200);
  const ver0 = v1.version;
  for (let t = 17250; t < 17500; t += 50) show.tickFxShowcase(s3d, t);
  check("7. steady frames never bump the variant's version (no per-frame needsUpdate: the link guard stays quiet)", v1.version === ver0);
  stone.base.opacity = 0.5;
  show.tickFxShowcase(s3d, 17550);
  check("7. an in-place base change (a fade) is mirrored, still without a program change", v1.opacity === 0.5 && v1.version === ver0);
  const tex2 = new THREE.DataTexture(new Uint8Array([10, 20, 250, 255]), 1, 1);
  stone.base.map = tex2;
  show.tickFxShowcase(s3d, 17600);
  check("7. a late texture is adopted (program-affecting: one needsUpdate)", v1.map === tex2 && v1.version === ver0 + 1);
  stone.base.opacity = 0.75;
  stone.base.map = crystalTex;
  show.tickFxShowcase(s3d, 17650);
  // nightKeep: ?lumNight dims the base to 25 % at night; the crystal is a light source
  stone.base.emissiveIntensity = 0.75 * 0.25;
  show.tickFxShowcase(s3d, 17700);
  check("7. at night the crystal keeps its glow (uLsLumBoost undoes ?lumNight's dim)",
    near(st.u.uLsLumBoost.value, 4, 1e-9) && near(ls.lifestoneLumBoost({ userData: { hbLumBase: 0.75 }, emissiveIntensity: 0.1875 }, 0), 1, 1e-12) &&
    ls.lifestoneLumBoost({ userData: {}, emissiveIntensity: 0.75 }, 1) === 1);
  stone.base.emissiveIntensity = 0.75;
  // a camera-fade clone re-pointed onto the mesh (entities.js _getOrCloneEntityMaterial)
  const fadeClone = stone.base.clone();
  fadeClone.userData = { ...stone.base.userData, __disposable: true };
  delete fadeClone.userData.__cacheOwned;
  let v1Disposed = false;
  v1.addEventListener("dispose", () => { v1Disposed = true; });
  stone.crystal.material = fadeClone;
  show.tickFxShowcase(s3d, 18300);
  await settle();
  const v1b = stone.crystal.material;
  check("7. a re-pointed mesh is rebuilt on its new material; the old variant is freed",
    v1b !== fadeClone && v1b.userData.__lsCrystal === st.id && st.recs.get(stone.crystal).base === fadeClone && v1Disposed && st.level === 1);
  // the glow extra (high / ultra, a glow pass running)
  t1f.setFxTier1Flag("fxGlow", true);
  window.__fxGlow = { effect: {} };
  show.tickFxShowcase(s3d, 18400);
  const gx = [];
  for (const s of poc.fxGlowExtraSources()) s.collect(gx);
  const mine = gx.filter((e) => e.material && e.material.name === "lifestone-crystal-glow");
  check("7. with ?fxGlow (and its pass running) each crystal is drawn into the glow buffer, depth-occluded there",
    mine.length === 2 && mine.some((e) => e.object === stone.crystal) && mine[0].material.blending === THREE.AdditiveBlending &&
    mine[0].material.depthTest === false && "uGlowDepth" in mine[0].material.uniforms);
  check("7. …one glow program for every lifestone (same sources, no defines)",
    mine[0].material !== mine[1].material && mine[0].material.vertexShader === mine[1].material.vertexShader &&
    mine[0].material.fragmentShader === mine[1].material.fragmentShader && Object.keys(mine[0].material.defines || {}).length === 0);
  check("7. …the in-scene aura halo steps back (x0.6) while the glow buffer carries the crystal",
    near(ls.lifestoneFxAuras([])[0].soft, T.auraDay * 0.6, 1e-9));
  t1f.setFxTier1Flag("fxGlow", false);
  const gx2 = [];
  for (const s of poc.fxGlowExtraSources()) s.collect(gx2);
  check("7. without ?fxGlow nothing goes to the glow buffer", gx2.every((e) => e.material?.name !== "lifestone-crystal-glow"));
  t1f.setFxTier1Flag("fxGlow", null);
  delete window.__fxGlow;
  // a disposed entity: dropped at once, no revert (its own dispose frees the variant)
  const st2Light = st2.light;
  stone2._disposed = true;
  show.tickFxShowcase(s3d, 18500);
  check("7. a disposed entity is dropped at once; its mesh is left alone; its carrier released",
    ls.lifestoneFxStateOf(stone2) === null && stone2.crystal.material === v2 && st2Light.released === true);
  stone2._disposed = false;
  s3d.entityManager.entityMap.delete(stone2.guid);
  // out of range: fades out, then reverts
  let v1bDisposed = false;
  v1b.addEventListener("dispose", () => { v1bDisposed = true; });
  const carrier = st.light;
  cam.position.set(0, 2, 200);
  cam.updateMatrixWorld(true);
  show.tickFxShowcase(s3d, 19000);
  check("7. out of range: the lifestone starts fading (still on its variant)", st.dying === true && st.level < 1 && stone.crystal.material === v1b);
  for (let t = 19100; t <= 20200; t += 100) show.tickFxShowcase(s3d, t);
  check("7. …then reverts: the mesh back on its material, the variant freed, the carrier released, the aura gone",
    stone.crystal.material === fadeClone && v1bDisposed && carrier.released === true && ls.lifestoneFxStateOf(stone) === null &&
    show.fxShowcaseStats().auras === 0);
  cam.position.set(0, 2, 10);
  cam.updateMatrixWorld(true);
  // the showcase switched off at runtime: everything reverts at once
  show.tickFxShowcase(s3d, 21000);
  await settle();
  show.tickFxShowcase(s3d, 21600);
  const stB = ls.lifestoneFxStateOf(stone);
  check("7. back in range: the lifestone is picked up again", !!stB && stone.crystal.material.userData.__lsCrystal === stB.id);
  t2f.setFxTier2Flag("fxShowcase", false);
  show.tickFxShowcase(s3d, 21700);
  check("7. ?fxShowcase off at runtime: the crystal reverts, the light is released, nothing drawn",
    stone.crystal.material === fadeClone && ls.lifestoneFxStats().lifestones === 0 && stB.light === null && sMesh.visible === false);
  t2f.setFxTier2Flag("fxShowcase", null);

  // ---- 8. calibration (Neutral, exposure 5) ---------------------------------------------------------
  console.log("8. calibration on the Neutral tone curve, exposure 5");
  const EXPOSURE = 5;
  const tone = (pre) => neutralToneMap([pre[0] * EXPOSURE, pre[1] * EXPOSURE, pre[2] * EXPOSURE]);
  const toneIn = (v) => neutralToneMap([v[0], v[1], v[2]]);   // already exposed (tone-mapper input units)
  const whiteness = (d) => Math.min(...d) / Math.max(...d);   // 1 = grey / white, 0 = a pure hue
  const lum = (d) => 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
  // the crystal texture's mean LINEAR colour (0x06005E03, decoded from the base DAT)
  const TEX = [0.077, 0.224, 0.696];
  const LUMI = 0.75;
  const pale = (() => {
    const m = Math.max(...TEX);
    const hue = [0, 1, 2].map((i) => 0.4 * [0.55, 0.78, 1][i] + 0.6 * TEX[i] / m);
    return hue.map((h) => h + (1 - h) * 0.45);
  })();
  const crystal = (vein, heart, breath, fres = 0, ndv = 1) => {
    const shape = (T.shapeBase + T.shapeVein * vein + T.shapeHeart * heart) * breath;
    const add = pale.map((p) => p * (T.inner * (vein * (0.35 + 0.65 * ndv) + 0.6 * heart * breath) + T.rim * fres));
    return toneIn(TEX.map((t, i) => t * LUMI * EXPOSURE * shape + add[i]));
  };
  const stock = tone(TEX.map((t) => t * LUMI));
  const deep = crystal(0, 0, 1 - T.breathAmp);
  const bright = crystal(1, 1, 1 + T.breathAmp);
  const rim = crystal(0, 0, 1, 1, 0);
  const fmt = (d) => d.map((v) => v.toFixed(3)).join(", ");
  check("8. the stock crystal (reference): a light blue on the curve's shoulder", whiteness(stock) < 0.35, fmt(stock));
  check("8. between the veins it goes DEEPER and more saturated than retail", lum(deep) < lum(stock) && whiteness(deep) < whiteness(stock), fmt(deep));
  check("8. the heart + a vein at full breath is BRIGHTER than retail but stays blue (no whitening: min / max < 0.6)",
    lum(bright) > lum(stock) && whiteness(bright) < 0.6, fmt(bright));
  check("8. even the fresnel rim (a deliberately paler edge) stays off white (min / max < 0.75)", whiteness(rim) < 0.75, fmt(rim));
  // the aura: constants read off the shader, so this cannot drift from it
  const auraK = +/halo \* ([0-9.]+) \* vSoft \* vAux\.w/.exec(SG.fragment)[1];
  const moteK = +/motes \* ([0-9.]+) \) \+ vec3\(/.exec(SG.fragment)[1];
  const moteW = +/vec3\( motes \* ([0-9.]+) \)/.exec(SG.fragment)[1];
  const CAL = Math.min(1, 3 / EXPOSURE);   // fx_showcase uShowCal at exposure 5, gain 1
  const BLUE = [0.55, 0.78, 1.0];
  const auraPre = (soft, wisp, breath) => BLUE.map((c) => c * auraK * soft * breath * (0.6 + 0.8 * wisp) * CAL);
  const lift = (bgPre, addPre) => { const a = tone(bgPre), b = tone(bgPre.map((v, i) => v + addPre[i])); return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; };
  const NIGHT_GRASS = [0.006, 0.008, 0.01];
  const DAY_WALL = [0.12, 0.11, 0.1];
  const nightMean = lift(NIGHT_GRASS, auraPre(1, 0.5, 1));
  const dayPeak = lift(DAY_WALL, auraPre(T.auraDay, 1, 1 + T.breathAmp));
  const dayMean = lift(DAY_WALL, auraPre(T.auraDay, 0.5, 1));
  check("8. at night the aura is a visible blue glow on dark grass (+0.08..0.4 in blue)", nightMean[2] > 0.08 && nightMean[2] < 0.4 && nightMean[2] > nightMean[0], fmt(nightMean));
  check("8. by day it is a bounded lift on a sunlit wall: peak < +0.12, mean < +0.08 (no wash-out)",
    Math.max(...dayPeak) < 0.12 && Math.max(...dayMean) < 0.08, `peak ${fmt(dayPeak)} mean ${fmt(dayMean)}`);
  const shaftPre = BLUE.map((c) => c * 1.0 * 0.8 * CAL);   // the 2026-10-10 shaft's core (prof 1, noise 1, intensity 0.8)
  const shaftDay = lift(DAY_WALL, shaftPre);
  const shaftOnWall = tone(DAY_WALL.map((v, i) => v + shaftPre[i]));
  check("8. the old shaft drove that wall up the curve's shoulder (blue > 0.9, the 1070 capture's washed house); the aura's daytime peak lift is under a quarter of the shaft's",
    shaftOnWall[2] > 0.9 && Math.max(...dayPeak) < Math.max(...shaftDay) / 4,
    `shaft-on-wall ${fmt(shaftOnWall)} shaft lift ${fmt(shaftDay)} aura peak ${fmt(dayPeak)}`);
  const motePre = BLUE.map((c) => (c * moteK + moteW) * CAL);
  const mote = tone(NIGHT_GRASS.map((v, i) => v + motePre[i]));
  check("8. a mote at its peak is a bright pale-blue speck (blue > 0.75 displayed, blue-dominant)", mote[2] > 0.75 && mote[2] >= mote[0], fmt(mote));

  // ---- 9. ?lifestoneFx=off ---------------------------------------------------------------------------
  console.log("9. ?lifestoneFx=off");
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();
  ls._setLifestoneFxForTest(false);
  const offBase = crystalBase();
  const stone4 = makeStone(0x70000104, 0, 0, offBase);
  scene.add(stone4.root);
  scene.updateMatrixWorld(true);
  const s3dOff = { entityManager: { entityMap: new Map([[stone4.guid, stone4]]), materialCache: mc }, scene, camera: cam,
    renderer: { toneMappingExposure: 5 }, skyLightingController: sky };
  const lightsOff = fxl.fxLightsStats().emitterLightsNow;
  show.tickFxShowcase(s3dOff, 40000);
  await settle();
  show.tickFxShowcase(s3dOff, 40700);
  const kinds = [];
  for (let i = 0; i < sMesh.geometry.instanceCount; i++) kinds.push(sMesh.geometry.attributes.aS0.array[i * 4 + 3]);
  check("9. off: the 2026-10-10 shaft (and no aura)", kinds.length === 1 && kinds[0] === show.FX_SHOWCASE_KIND.shaft);
  const offRings = dec.collectFxDecals({ x: 0, y: 0, z: 0 }, [], 40700);
  check("9. off: the ground ring is back", offRings.length === 1 && offRings[0].kindName === "ring" && near(offRings[0].radius, 1.6, 1e-9));
  check("9. off: no lifestone state, no light carrier, the crystal untouched",
    ls.lifestoneFxStats().lifestones === 0 && fxl.fxLightsStats().emitterLightsNow === lightsOff && stone4.crystal.material === offBase);
  ls._setLifestoneFxForTest(null);
  show._resetFxShowcaseForTest();
  dec._resetFxDecalsForTest();
  fxl._resetFxLightsForTest();

  console.log(`\n[test_lifestone_fx] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
