// tests/sky_glow.test.mjs
//
// 2026-10-07 — the "lines through the sky" were the moon SkyObject's nebula
// sheets (PES 0x330007DB -> 0x32000455/456/457 -> GfxObj 0x01001A61/62/63, a
// 275-unit additive quad at scale 7-8, 450-700 m out) drawn as ordinary
// world-pass particles: depth-tested over distant terrain/sea, FOGGED (three's
// fog mixes an additive quad toward fogColor across the whole quad, black
// texels included), and added in HDR. `?skyGlow` (DEFAULT ON) makes them
// retail sky objects: far depth (sky pixels only, so the clouds and the world
// sit in front), no fog, a radial window that reaches exactly 0 inside the quad
// edge, and a display-space gain (strength / exposure).
//
//   G1  ?skyGlow parsing: default on/0.5, off/0/false/no hide, N clamps, legacy.
//   G2  the window is 1 at the centre and exactly 0 from r = 0.8 (edge midpoints
//       r = 1, corners r = 1.41) — no hard edge can survive any exposure.
//   G3  the shader patch on three r184's real MeshBasic source: window, gain,
//       FAR depth after the colour write, no backticks in the injected GLSL.
//   G4  applySkyGlowMaterial: fog off, no depth write, LEQUAL, constant program
//       key, idempotent; map-less (the lightning box) and clones are not patched.
//   G5  per-frame gain = strength / exposure; sky-blocked frames and =off hide.
//   G6  REAL ParticleManager: a skyGlow emitter gets its own `-sky` instanced
//       bucket with a patched material; a world emitter of the SAME GfxObj keeps
//       a plain (non-sky-glow) material in a separate bucket. (Its fog is OFF
//       since 2026-10-07 `?additiveFogBlack` — tests/additive_fog.test.mjs.)
//   G7  wiring: sky_dome tags its anchor, statics derives `skyGlow` from it.
//   G8  ?aerialSun: AerialPerspective copies the sky's sun (it was (0,0,0)).
//
// Fails on the pre-change code: sky_glow.js does not exist, the manager has no
// skyGlow request field, and AerialPerspective's sun is never written.
//
// Run: node tests/sky_glow.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis.window || {};
const THREE = await import("three");
const G = await import("../scene3d/sky_glow.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
console.log("-- G1 ?skyGlow parsing -------------------------------------------");
{
  const p = G.parseSkyGlow;
  check("absent -> on at the subtle default", p("").mode === "on" && p("").strength === G.SKY_GLOW_DEFAULT);
  check("default strength is subtle (< retail 1.0)", G.SKY_GLOW_DEFAULT > 0 && G.SKY_GLOW_DEFAULT < 1);
  for (const v of ["off", "0", "false", "no", "-1"]) {
    check(`?skyGlow=${v} hides`, p(`?skyGlow=${v}`).mode === "off");
  }
  check("?skyGlow=0.25 -> 0.25", p("?skyGlow=0.25").mode === "on" && p("?skyGlow=0.25").strength === 0.25);
  check("?skyGlow=99 clamps", p("?skyGlow=99").strength === G.SKY_GLOW_MAX);
  check("?skyGlow=on -> default", p("?skyGlow=on").strength === G.SKY_GLOW_DEFAULT);
  check("?skyGlow=legacy -> no patch", p("?skyGlow=legacy").mode === "legacy");
  check("garbage -> default (never a silent off)", p("?skyGlow=abc").mode === "on");
}

// ---------------------------------------------------------------------------
console.log("-- G2 radial window ----------------------------------------------");
{
  const w = G.skyGlowWindow;
  const [inner, outer] = G.SKY_GLOW_FALLOFF;
  check("1 at the centre", w(0) === 1);
  check("1 inside the inner radius", w(inner) === 1);
  check("exactly 0 at the outer radius", w(outer) === 0);
  check("exactly 0 at the edge midpoints (r = 1)", w(1) === 0);
  check("exactly 0 at the corners (r = sqrt 2)", w(Math.SQRT2) === 0);
  check("outer radius is well inside the quad edge", outer <= 0.85);
  let mono = true;
  for (let r = 0; r < 1.5; r += 0.01) if (w(r + 0.01) > w(r) + 1e-12) mono = false;
  check("monotone non-increasing (no ring)", mono);
  // C1 at both ends: the slope of smoothstep vanishes there.
  check("soft shoulder at the outer edge", w(outer - 1e-3) < 1e-4);
}

// ---------------------------------------------------------------------------
console.log("-- G3 shader patch (real r184 MeshBasic source) ------------------");
{
  const shader = {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),
  };
  check("patch applies", G.patchSkyGlowShader(shader) === true);
  const fs = shader.fragmentShader;
  const vs = shader.vertexShader;
  check("vertex passes the raw uv", /vHbSkyGlowUv = uv;/.test(vs) && /varying vec2 vHbSkyGlowUv;/.test(vs));
  check("fragment declares gain + falloff + uv",
    /uniform float hbSkyGlowGain;/.test(fs) && /uniform vec2 hbSkyGlowFalloff;/.test(fs) && /varying vec2 vHbSkyGlowUv;/.test(fs));
  check("window is smoothstep over the uv radius",
    /length\( vHbSkyGlowUv - vec2\( 0\.5 \) \) \* 2\.0/.test(fs) &&
    /1\.0 - smoothstep\( hbSkyGlowFalloff\.x, hbSkyGlowFalloff\.y, hbSkyGlowR \)/.test(fs));
  const mulAt = fs.indexOf("outgoingLight *= hbSkyGlowW * hbSkyGlowGain;");
  const opaqueAt = fs.indexOf("#include <opaque_fragment>");
  const depthAt = fs.indexOf("gl_FragDepth = 1.0;");
  const logAt = fs.indexOf("#include <logdepthbuf_fragment>");
  const fogAt = fs.indexOf("#include <fog_fragment>");
  check("gain applied before the colour write", mulAt > 0 && opaqueAt > mulAt);
  check("opaque_fragment kept exactly once", fs.split("#include <opaque_fragment>").length === 2);
  check("far depth written AFTER three's log-depth write (wins)", depthAt > logAt && logAt > 0);
  check("far depth written before fog/dither tail", depthAt < fogAt);
  check("uniforms are the SHARED objects (live updates)",
    shader.uniforms.hbSkyGlowGain === G.SKY_GLOW_UNIFORMS.hbSkyGlowGain &&
    shader.uniforms.hbSkyGlowFalloff === G.SKY_GLOW_UNIFORMS.hbSkyGlowFalloff);
  const injected = [G.SKY_GLOW_VERTEX_DECL, G.SKY_GLOW_VERTEX_BODY, G.SKY_GLOW_FRAGMENT_DECL, G.SKY_GLOW_FRAGMENT_BODY].join("");
  check("no backticks in the injected GLSL", !injected.includes("`"));
  check("non-MeshBasic source is refused", G.patchSkyGlowShader({ vertexShader: "", fragmentShader: "" }) === false);
}

// ---------------------------------------------------------------------------
console.log("-- G4 applySkyGlowMaterial ----------------------------------------");
const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
function additiveMat() {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  m.blending = THREE.AdditiveBlending;
  return m;
}
{
  const m = additiveMat();
  check("fog is on by default (the bug's precondition)", m.fog === true);
  check("patched", G.applySkyGlowMaterial(m) === true);
  check("fog off (retail: no fog for sky objects)", m.fog === false);
  check("no depth write, LEQUAL depth test", m.depthWrite === false && m.depthTest === true && m.depthFunc === THREE.LessEqualDepth);
  check("blend left additive", m.blending === THREE.AdditiveBlending);
  check("constant program key (one program for all three glows)", m.customProgramCacheKey() === G.SKY_GLOW_PROGRAM_KEY);
  const s = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  m.onBeforeCompile(s, null);
  check("onBeforeCompile patches the shader", s.fragmentShader.includes("gl_FragDepth = 1.0;"));
  const before = m.onBeforeCompile;
  check("idempotent", G.applySkyGlowMaterial(m) === true && m.onBeforeCompile === before);
  const plain = new THREE.MeshBasicMaterial({ transparent: true });
  plain.blending = THREE.AdditiveBlending;
  check("map-less (storm lightning box) left alone", G.applySkyGlowMaterial(plain) === false && plain.fog === true);
  const c = m.clone();
  check("a clone is not mistaken for patched (WeakSet, not userData)",
    c.userData.__skyGlow === true && G.applySkyGlowMaterial(c) === true && c.customProgramCacheKey() === G.SKY_GLOW_PROGRAM_KEY);
}

// ---------------------------------------------------------------------------
console.log("-- G5 per-frame gain + visibility ---------------------------------");
{
  const m = additiveMat();
  G.applySkyGlowMaterial(m);
  G.updateSkyGlowFrame(5, true);
  check("gain = strength / exposure (default / 5)", near(G.SKY_GLOW_UNIFORMS.hbSkyGlowGain.value, G.SKY_GLOW_DEFAULT / 5));
  check("visible while the sky is", m.visible === true);
  G.updateSkyGlowFrame(10, false);
  check("tracks exposure", near(G.SKY_GLOW_UNIFORMS.hbSkyGlowGain.value, G.SKY_GLOW_DEFAULT / 10));
  check("hidden on a sky-blocked frame", m.visible === false);
  G.updateSkyGlowFrame(5, true);
  check("back on with the sky", m.visible === true);
  G.setSkyGlowStrength("off");
  check("live =off hides", m.visible === false && G.skyGlowState().mode === "off");
  G.setSkyGlowStrength(1);
  check("live strength 1 -> gain 1/exposure, visible", near(G.SKY_GLOW_UNIFORMS.hbSkyGlowGain.value, 0.2) && m.visible === true);
  G.setSkyGlowStrength(G.SKY_GLOW_DEFAULT);
  check("live falloff retune", G.setSkyGlowFalloff(0.1, 0.7).join() === "0.1,0.7" &&
    G.SKY_GLOW_UNIFORMS.hbSkyGlowFalloff.value.x === 0.1);
  check("bad falloff ignored", G.setSkyGlowFalloff(0.9, 0.2).join() === "0.1,0.7");
  G.setSkyGlowFalloff(G.SKY_GLOW_FALLOFF[0], G.SKY_GLOW_FALLOFF[1]);
  G.installSkyGlowHandle();
  check("window.__skyGlow handle installed", typeof window.__skyGlow === "function" &&
    typeof window.__skyGlow.falloff === "function" && window.__skyGlow().mode === "on");
  const n0 = G.skyGlowState().materials;
  m.dispose();
  check("disposed materials leave the registry", G.skyGlowState().materials === n0 - 1);
}

// ---------------------------------------------------------------------------
console.log("-- G6 real ParticleManager ----------------------------------------");
{
  const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const { ParticleManager } = await import("../scene3d/particles/particle_manager.js");
  const group = new THREE.Group();
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  cam.updateMatrixWorld(true);
  const prevLive = window.liveScene3d;
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  const quad = new THREE.PlaneGeometry(275, 275);
  const base = additiveMat();
  const mgr = new ParticleManager({
    scene: group,
    instancing: true,
    geometryFactory: () => quad,
    materialFactory: () => base,
  });
  const info = {
    id: 0x32000455, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x01001a61,
    birthrate: 10, maxParticles: 3, initialParticles: 3, totalParticles: 0, totalSeconds: 0,
    lifespan: 3300, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 7, finalScale: 7,
    transRand: 0, startTrans: 0.8, finalTrans: 1, isParentLocal: true, billboard: false,
  };
  const skyAnchor = new THREE.Object3D(); skyAnchor.position.set(0, 40, 0);
  const worldAnchor = new THREE.Object3D(); worldAnchor.position.set(0, 0, -10);
  group.add(skyAnchor, worldAnchor);
  const idSky = await mgr.addEmitter({ emitterInfo: { ...info }, parent: skyAnchor, skyGlow: true });
  const idWorld = await mgr.addEmitter({ emitterInfo: { ...info }, parent: worldAnchor });
  for (let i = 0; i < 4; i += 1) { t += 0.016; mgr.tick(); }
  check("both emitters live", mgr.particleTable.get(idSky)?.skyGlow === true && mgr.particleTable.get(idWorld)?.skyGlow === false);
  const ims = group.children.filter((o) => o.isInstancedMesh);
  const skyIm = ims.find((o) => o.userData?.skyGlow === true);
  const worldIm = ims.find((o) => o.userData?.isParticleInstanced && o.userData.skyGlow !== true);
  check("sky emitter has its own -sky bucket", !!skyIm && /-sky$/.test(skyIm.name), ims.map((o) => o.name).join(","));
  check("world emitter of the same GfxObj keeps a separate bucket", !!worldIm && worldIm !== skyIm && worldIm.material !== skyIm?.material);
  check("sky bucket material is a sky glow (no fog, program key)",
    skyIm?.material?.fog === false && skyIm?.material?.customProgramCacheKey() === G.SKY_GLOW_PROGRAM_KEY);
  // 2026-10-07 `?additiveFogBlack` (DEFAULT retail): every ADDITIVE world
  // particle is now unfogged too (retail D3DRS_FOGENABLE off for 0x10000), so
  // `fog` no longer tells the two apart — the sky-glow tag + program key do.
  check("world bucket material is not a sky glow (default key, retail additive no-fog)",
    worldIm?.material?.userData?.__skyGlow !== true &&
    worldIm?.material?.customProgramCacheKey() !== G.SKY_GLOW_PROGRAM_KEY &&
    worldIm?.material?.fog === false);
  check("base cache material never patched", base.fog === true);
  check("sky bucket keeps the additive blend", skyIm?.material?.blending === THREE.AdditiveBlending);
  setCurrentTime(null);
  window.liveScene3d = prevLive;
}

// ---------------------------------------------------------------------------
console.log("-- G7 wiring -------------------------------------------------------");
{
  const SKY = readFileSync(path.join(APP, "scene3d", "sky_dome.js"), "utf8");
  const STA = readFileSync(path.join(APP, "scene3d", "statics.js"), "utf8");
  const PM = readFileSync(path.join(APP, "scene3d", "particles", "particle_manager.js"), "utf8");
  check("sky_dome tags the sky-chain anchor", /_skyBirdAnchor\.userData\.isSkyGlowAnchor = true;/.test(SKY));
  check("sky_dome syncs exposure + sky visibility every tick",
    /updateSkyGlowFrame\(this\.liveScene3dRef\?\.renderer\?\.toneMappingExposure, !skyBlocked\)/.test(SKY));
  check("statics derives skyGlow from the anchor (survives the CallPES loop)",
    /skyGlow: anchor\?\.userData\?\.isSkyGlowAnchor === true,/.test(STA));
  check("manager: pooled clones keyed apart (|sky)", /baseMaterial\.uuid\}\$\{skyGlow \? "\|sky" : ""\}/.test(PM));
  check("manager: per-mesh path patches too", /if \(skyGlow\) applySkyGlowMaterial\(mat\);/.test(PM));
}

// ---------------------------------------------------------------------------
console.log("-- G8 ?aerialSun ---------------------------------------------------");
{
  const PIPE = readFileSync(path.join(APP, "scene3d", "atmosphere_pipeline.js"), "utf8");
  const IDX = readFileSync(path.join(APP, "scene3d", "index.js"), "utf8");
  // The pipeline module imports postprocessing + takram; slice the two pure
  // helpers out and evaluate them against THREE vectors instead.
  const fnSrc = (name) => {
    const at = PIPE.indexOf(`export function ${name}(`);
    let depth = 0;
    for (let i = PIPE.indexOf("{", at); i < PIPE.length; i++) {
      if (PIPE[i] === "{") depth++;
      else if (PIPE[i] === "}" && --depth === 0) return PIPE.slice(at + "export ".length, i + 1);
    }
    return "";
  };
  // eslint-disable-next-line no-new-func
  const lib = new Function(`${fnSrc("aerialSunEnabled")}\n${fnSrc("syncAerialSun")}\nreturn { aerialSunEnabled, syncAerialSun };`)();
  check("default on", lib.aerialSunEnabled("") === true && lib.aerialSunEnabled("?x=1") === true);
  check("=off escape", lib.aerialSunEnabled("?aerialSun=off") === false && lib.aerialSunEnabled("?aerialSun=0") === false);
  const ap = { sunDirection: new THREE.Vector3(), moonDirection: new THREE.Vector3() };
  const sky = { skyMaterial: { sunDirection: new THREE.Vector3(0.94, 0.342, 0), moonDirection: new THREE.Vector3(0, 0.5, 0.866) } };
  check("pre-fix state reproduced: AP sun is (0,0,0)", ap.sunDirection.lengthSq() === 0);
  check("sync copies the sky's sun", lib.syncAerialSun(ap, sky) === true && ap.sunDirection.equals(sky.skyMaterial.sunDirection));
  check("and its moon", ap.moonDirection.equals(sky.skyMaterial.moonDirection));
  check("copy, not alias", ap.sunDirection !== sky.skyMaterial.sunDirection);
  const keep = ap.sunDirection.clone();
  check("a zero (un-ticked) sky sun is ignored",
    lib.syncAerialSun(ap, { skyMaterial: { sunDirection: new THREE.Vector3() } }) === false && ap.sunDirection.equals(keep));
  check("null sky is a no-op", lib.syncAerialSun(ap, null) === false);
  check("preFrameSkySync takes the sky and syncs when the flag is on",
    /preFrameSkySync\(skyDome, mainCamera, atmosphereSky = null\)/.test(PIPE) &&
    /if \(aerialSunOn && atmosphereSky\) syncAerialSun\(aerialPerspective, atmosphereSky\);/.test(PIPE));
  check("index.js passes liveScene3dRef.atmosphereSky",
    /preFrameSkySync\(\s*liveScene3dRef\?\.skyDome,\s*activeCam,\s*liveScene3dRef\?\.atmosphereSky/.test(IDX));
}

console.log(`\nsky glow + aerial sun: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
