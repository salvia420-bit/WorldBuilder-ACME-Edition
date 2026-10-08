// tests/additive_fog.test.mjs
//
// 2026-10-07 `?additiveFogBlack` (DEFAULT ON = retail). three's fog_fragment
// ends `gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor )`; on an
// ADDITIVE particle that ADDS `fogFactor * fogColor` across the whole quad,
// black texels included, so every distant glow / fire / spark / portal swirl in
// the fog band drew as a pale fog-coloured rectangle. Retail turns fixed-function
// fog OFF for every Additive (0x10000) surface (D3DPolyRender::SetSurface,
// acclient.c:454551-454553 -> SetFFFogAlphaDisabled :460295 =
// SetRenderState(D3DRS_FOGENABLE = 28, FALSE)). Default: `fog = false` on
// additive particle materials. `=fade` keeps fog but scales the colour toward 0;
// `=off` is stock three.
//
//   F1  flag parsing: absent/on/garbage -> retail, off-forms -> off, fade/black.
//   F2  the fade patch on three r184's REAL chunks: the fog chunk alone changes,
//       include-resolved MeshBasic + MeshStandard sources are well-formed, both
//       linear and exp2 fogFactor survive, no backticks in the GLSL.
//   F3  JS mirror of the math: an additive BLACK texel stays black under fog in
//       retail + fade (stock adds fogColor: the bug); a lit texel fades to 0 at
//       fogFactor 1 (fade), is unchanged (retail), becomes fogColor (stock).
//   F4  applyAdditiveParticleFog: additive only (normal-blended + sky glows left
//       alone), retail = three's stock no-fog program (no hook, default key),
//       fade = ONE constant key (chained after an existing hook), live
//       switches restore exactly, `off` on an untouched material is a no-op,
//       a clone of a patched material restores the AUTHORED fog.
//   F5  REAL ParticleManager: additive instanced bucket + per-slot clones are
//       unfogged, the alpha bucket keeps stock fog + its own key, the base cache
//       materials are never touched, the Alpha+Additive (CustomBlending
//       SRCALPHA/ONE) base is caught, the per-mesh path too, pooled clones are
//       reused without program churn, and `window.__additiveFogBlack` switches
//       every live material in place.
//   F6  wiring: the flag row in docs/url-flags.md, both material sites.
//
// Fails on the pre-change code: additive_fog.js does not exist and every
// additive particle material keeps `fog: true`.
//
// Run: node tests/additive_fog.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

globalThis.window = globalThis.window || {};
const THREE = await import("three");
const F = await import("../scene3d/particles/additive_fog.js");

let passed = 0;
let failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// three r184 WebGLProgram's resolveIncludes (three.module.js:6474-6500), for
// inspecting the shader the GPU would actually receive.
const includePattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
function resolveIncludes(s) {
  return s.replace(includePattern, (m, inc) => {
    const chunk = THREE.ShaderChunk[inc];
    if (chunk === undefined) throw new Error(`unknown chunk ${inc}`);
    return resolveIncludes(chunk);
  });
}
function balancedPreprocessor(src) {
  let depth = 0;
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (/^#if(n?def)?\b/.test(t)) depth++;
    else if (/^#endif\b/.test(t)) { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
console.log("-- F1 ?additiveFogBlack parsing -------------------------------------");
{
  const p = F.parseAdditiveFogBlack;
  check("absent -> retail (DEFAULT ON)", p("") === "retail" && p("?x=1") === "retail");
  for (const v of ["", "on", "1", "true", "yes", "retail", "RETAIL", "garbage"]) {
    check(`?additiveFogBlack=${v} -> retail`, p(`?additiveFogBlack=${v}`) === "retail");
  }
  for (const v of ["off", "0", "false", "no", "OFF"]) {
    check(`?additiveFogBlack=${v} -> off (stock three fog)`, p(`?additiveFogBlack=${v}`) === "off");
  }
  check("?additiveFogBlack=fade / black -> fade", p("?additiveFogBlack=fade") === "fade" && p("?additiveFogBlack=black") === "fade");
  check("module default (no location in Node) is retail", F.additiveFogMode() === "retail");
  check("setAdditiveFogMode takes the URL spellings", F.setAdditiveFogMode("false") === "off" &&
    F.setAdditiveFogMode("black") === "fade" && F.setAdditiveFogMode("nonsense") === "retail");
  F.setAdditiveFogMode("retail");
}

// ---------------------------------------------------------------------------
console.log("-- F2 fade patch on three r184's real chunks -------------------------");
{
  const stock = THREE.ShaderChunk.fog_fragment;
  check("r184 fog_fragment ends in the stock mix (the bug's line)", stock.includes(F.STOCK_FOG_MIX_LINE));
  const chunk = F.additiveFogFadeChunk();
  check("fade chunk built from the real chunk", typeof chunk === "string");
  check("fade chunk drops the mix toward fogColor", !chunk.includes("fogColor"));
  check("fade chunk scales toward 0", chunk.includes(F.ADDITIVE_FOG_FADE_LINE));
  check("linear fogFactor kept verbatim", chunk.includes("float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );"));
  check("exp2 fogFactor kept verbatim",
    chunk.includes("float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );"));
  check("only the last statement differs", chunk === stock.replace(F.STOCK_FOG_MIX_LINE, F.ADDITIVE_FOG_FADE_LINE));
  check("still inside #ifdef USE_FOG (fog-less programs unaffected)", /^#ifdef USE_FOG/.test(chunk) && /#endif$/.test(chunk));
  check("a reshaped chunk is refused, not half-patched", F.additiveFogFadeChunk("gl_FragColor.rgb = fogColor;") === null);

  for (const lib of ["basic", "standard"]) {
    const shader = {
      vertexShader: THREE.ShaderLib[lib].vertexShader,
      fragmentShader: THREE.ShaderLib[lib].fragmentShader,
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib[lib].uniforms),
    };
    const vsBefore = shader.vertexShader;
    const before = shader.fragmentShader;
    check(`${lib}: patch applies`, F.patchAdditiveFogShader(shader) === true);
    const fs = shader.fragmentShader;
    check(`${lib}: vertex shader untouched (vFogDepth still written)`, shader.vertexShader === vsBefore);
    check(`${lib}: fog include replaced exactly once`, !fs.includes("#include <fog_fragment>") &&
      fs.split(F.ADDITIVE_FOG_FADE_LINE).length === 2);
    check(`${lib}: nothing else changed`, fs === before.replace("#include <fog_fragment>", chunk));
    const at = fs.indexOf(F.ADDITIVE_FOG_FADE_LINE);
    check(`${lib}: fades AFTER colour space conversion, BEFORE premultiplied alpha`,
      fs.indexOf("#include <colorspace_fragment>") < at && at < fs.indexOf("#include <premultiplied_alpha_fragment>"));
    const full = resolveIncludes(fs);
    check(`${lib}: include-resolved source has no fogColor mix left`,
      !/mix\(\s*gl_FragColor\.rgb\s*,\s*fogColor/.test(full));
    check(`${lib}: fogFactor declared before it is used`,
      full.indexOf("float fogFactor = smoothstep") > 0 && full.indexOf("float fogFactor = smoothstep") < full.indexOf(F.ADDITIVE_FOG_FADE_LINE));
    check(`${lib}: fog uniforms/varying still declared (fog_pars_fragment)`,
      /uniform float fogNear;/.test(full) && /varying float vFogDepth;/.test(full));
    check(`${lib}: #if/#endif balanced after resolution`, balancedPreprocessor(full));
    check(`${lib}: second patch is a no-op (no fog include left)`, F.patchAdditiveFogShader(shader) === false);
  }
  const injected = [F.ADDITIVE_FOG_FADE_LINE, F.STOCK_FOG_MIX_LINE, chunk].join("");
  check("no backticks in the GLSL", !injected.includes("`"));
  check("a source without a fog include is refused", F.patchAdditiveFogShader({ fragmentShader: "void main(){}" }) === false);
}

// ---------------------------------------------------------------------------
console.log("-- F3 JS mirror of the per-channel math --------------------------------");
{
  const fogColor = 0.78; // a pale day fog channel (the sheets' colour)
  const ch = F.additiveFogChannel;
  // three's linear fogFactor over the day horizon band (computeFogBand ~475 -> 1003 m).
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  let blackRetail = true, blackFade = true, blackStockAdds = true, fadeMono = true;
  let prev = Infinity;
  for (let d = 0; d <= 1200; d += 25) {
    const f = smooth(475, 1003, d);
    if (ch(0, f, fogColor, "retail") !== 0) blackRetail = false;
    if (ch(0, f, fogColor, "fade") !== 0) blackFade = false;
    if (f > 0 && !(ch(0, f, fogColor, "off") > 0)) blackStockAdds = false;
    const v = ch(1, f, fogColor, "fade");
    if (v > prev + 1e-15) fadeMono = false;
    prev = v;
  }
  check("additive BLACK texel stays black at every distance (retail)", blackRetail);
  check("additive BLACK texel stays black at every distance (fade)", blackFade);
  check("stock (=off) reproduces the bug: a black texel adds fogFactor * fogColor",
    blackStockAdds && near(ch(0, 1, fogColor, "off"), fogColor) && near(ch(0, 0.5, fogColor, "off"), 0.5 * fogColor));
  check("fade: lit texel unchanged at fogFactor 0", ch(0.9, 0, fogColor, "fade") === 0.9);
  check("fade: lit texel fades to exactly 0 at fogFactor 1", ch(0.9, 1, fogColor, "fade") === 0);
  check("fade: half-fogged lit texel at half strength", near(ch(0.9, 0.5, fogColor, "fade"), 0.45));
  check("fade: monotone non-increasing across the band", fadeMono);
  check("fade: a particle past the band edge (1003 m) contributes 0", ch(1, smooth(475, 1003, 1100), fogColor, "fade") === 0);
  check("retail: lit texel unchanged at any fogFactor (D3DRS_FOGENABLE off)",
    ch(0.9, 0, fogColor, "retail") === 0.9 && ch(0.9, 1, fogColor, "retail") === 0.9);
  check("stock: lit texel becomes fogColor at fogFactor 1", near(ch(0.9, 1, fogColor, "off"), fogColor));
  // Blend stage (AdditiveBlending = SRC_ALPHA, ONE): dst += out * srcAlpha.
  const add = (dst, out, a) => dst + out * a;
  check("blend: retail + black texel leaves the framebuffer unchanged", add(0.3, ch(0, 0.8, fogColor, "retail"), 1) === 0.3);
  check("blend: stock + black texel brightens it (the pale sheet)", add(0.3, ch(0, 0.8, fogColor, "off"), 1) > 0.9);
}

// ---------------------------------------------------------------------------
console.log("-- F4 applyAdditiveParticleFog --------------------------------------");
const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
function additiveMat() {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.blending = THREE.AdditiveBlending;
  return m;
}
const stockKey = new THREE.MeshBasicMaterial().customProgramCacheKey();
{
  F.setAdditiveFogMode("retail");
  const m = additiveMat();
  check("precondition: an additive particle material is fogged by default", m.fog === true);
  const v0 = m.version;
  check("retail: applied", F.applyAdditiveParticleFog(m) === true);
  check("retail: fog off (D3DRS_FOGENABLE = FALSE)", m.fog === false);
  check("retail: program re-resolved (needsUpdate)", m.version === v0 + 1);
  check("retail: NO shader hook (three's stock no-fog program)", !Object.prototype.hasOwnProperty.call(m, "onBeforeCompile") &&
    !Object.prototype.hasOwnProperty.call(m, "customProgramCacheKey") && m.customProgramCacheKey() === stockKey);
  check("retail: blend, depth and opacity untouched",
    m.blending === THREE.AdditiveBlending && m.depthWrite === false && m.transparent === true && m.opacity === 1);
  const v1 = m.version;
  check("idempotent: re-apply costs no program churn (pool reuse)", F.applyAdditiveParticleFog(m) === true && m.version === v1);
  check("state reported", F.additiveFogStateOf(m) === "retail");

  const n = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  check("normal-blended (alpha) particle left on stock fog", F.applyAdditiveParticleFog(n) === false && n.fog === true &&
    F.additiveFogStateOf(n) === null);
  const sky = additiveMat();
  sky.fog = false;
  sky.userData = { __skyGlow: true };
  const skyKey = () => "hbSkyGlow1";
  sky.customProgramCacheKey = skyKey;
  F.setAdditiveFogMode("fade");
  check("sky glow left alone in every mode", F.applyAdditiveParticleFog(sky) === false && sky.fog === false &&
    sky.customProgramCacheKey === skyKey);
  F.setAdditiveFogMode("retail");

  // fade: one constant key, real shader patch through the hook.
  const a = additiveMat(), b = additiveMat();
  F.applyAdditiveParticleFog(a, "fade");
  F.applyAdditiveParticleFog(b, "fade");
  check("fade: fog kept on", a.fog === true);
  check("fade: ONE constant program key for every material",
    a.customProgramCacheKey() === F.ADDITIVE_FOG_FADE_KEY && b.customProgramCacheKey() === F.ADDITIVE_FOG_FADE_KEY);
  const s = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  a.onBeforeCompile(s, null);
  check("fade: the hook patches the real MeshBasic source", s.fragmentShader.includes(F.ADDITIVE_FOG_FADE_LINE));
  // live switch back: everything restored exactly
  F.applyAdditiveParticleFog(a, "retail");
  check("fade -> retail: hook removed, fog off, stock key",
    a.fog === false && !Object.prototype.hasOwnProperty.call(a, "onBeforeCompile") && a.customProgramCacheKey() === stockKey);
  F.applyAdditiveParticleFog(a, "off");
  check("retail -> off: authored fog restored, stock key", a.fog === true && a.customProgramCacheKey() === stockKey);
  F.applyAdditiveParticleFog(a, "fade");
  F.applyAdditiveParticleFog(a, "off");
  check("fade -> off: hook removed, fog on", a.fog === true && !Object.prototype.hasOwnProperty.call(a, "customProgramCacheKey"));

  // A pre-existing hook (e.g. a lit legacy material patch) is chained, its key kept in front.
  const c = additiveMat();
  let prevCalls = 0;
  const prevHook = function (sh) { prevCalls++; sh.fragmentShader += "\n// prev"; };
  c.onBeforeCompile = prevHook;
  c.customProgramCacheKey = () => "prevKey";
  F.applyAdditiveParticleFog(c, "fade");
  const s2 = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} };
  c.onBeforeCompile(s2, null);
  check("fade: an existing hook still runs", prevCalls === 1 && s2.fragmentShader.endsWith("// prev"));
  check("fade: existing key kept in front (constant per base)", c.customProgramCacheKey() === `prevKey|${F.ADDITIVE_FOG_FADE_KEY}`);
  F.applyAdditiveParticleFog(c, "retail");
  check("fade -> retail: the ORIGINAL hook + key are back", c.onBeforeCompile === prevHook && c.customProgramCacheKey() === "prevKey");

  // `off` must be byte-identical on an untouched material.
  const d = additiveMat();
  const vd = d.version;
  check("off on an untouched material is a no-op", F.applyAdditiveParticleFog(d, "off") === false && d.fog === true &&
    d.version === vd && d.userData.__hbAddFogOrig === undefined);

  // A clone of a patched material (the runtime instancing toggle clones a slot
  // material): clone() copies fog=false + userData, NOT the hook.
  const e = additiveMat();
  F.applyAdditiveParticleFog(e, "retail");
  const ec = e.clone();
  check("clone carries the patched fog (precondition)", ec.fog === false && ec.userData.__hbAddFogOrig === true);
  F.applyAdditiveParticleFog(ec, "off");
  check("clone + off restores the AUTHORED fog (true), not the copied false", ec.fog === true);
}

// ---------------------------------------------------------------------------
console.log("-- F5 real ParticleManager --------------------------------------------");
{
  F.setAdditiveFogMode("retail");
  const { setCurrentTime } = await import("../scene3d/particles/time_rng.js");
  let t = 1000;
  setCurrentTime(() => t);
  const PM = await import("../scene3d/particles/particle_manager.js");
  const { ParticleManager } = PM;
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 10000);
  cam.updateMatrixWorld(true);
  const prevLive = window.liveScene3d;
  window.liveScene3d = { cameraSwitcher: { activeCamera: cam }, camera: cam };
  const quad = new THREE.PlaneGeometry(1, 1);
  const GFX_ADD = 0x01000a01, GFX_ALPHA = 0x01000a02, GFX_AA = 0x01000a03;
  // Base cache materials as materials.js getParticleUnlit builds them.
  const baseAdd = additiveMat();
  baseAdd.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10000 };
  const baseAlpha = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  baseAlpha.userData = { __cacheOwned: true, surfaceTypeFlags: 0x100 };
  // Alpha+Additive (0x10102, 183/202 additive surfaces): CustomBlending SRCALPHA/ONE
  // on the lit material; getParticleUnlit copies only `.blending`, so the
  // manager's surfaceTypeFlags probe is what catches it.
  const baseAA = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  baseAA.blending = THREE.CustomBlending;
  baseAA.userData = { __cacheOwned: true, surfaceTypeFlags: 0x10102 };
  const bases = new Map([[GFX_ADD, baseAdd], [GFX_ALPHA, baseAlpha], [GFX_AA, baseAA]]);
  const info = (hw) => ({
    id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: hw,
    birthrate: 10, maxParticles: 4, initialParticles: 4, totalParticles: 0, totalSeconds: 0,
    lifespan: 60, lifespanRand: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0,
    minOffset: 0, maxOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 0, maxA: 0,
    bX: 0, bY: 0, bZ: 0, cX: 0, cY: 0, cZ: 0, scaleRand: 0, startScale: 1, finalScale: 1,
    transRand: 0, startTrans: 0, finalTrans: 0, isParentLocal: true, billboard: false,
  });
  const mk = (instancing, group) => new ParticleManager({
    scene: group, instancing,
    geometryFactory: () => quad,
    materialFactory: (hw) => bases.get(hw >>> 0),
  });
  const group = new THREE.Group();
  const anchor = new THREE.Object3D(); anchor.position.set(0, 0, -10);
  group.add(anchor);
  const mgr = mk(true, group);
  const idAdd = await mgr.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor });
  const idAlpha = await mgr.addEmitter({ emitterInfo: info(GFX_ALPHA), parent: anchor });
  const idAA = await mgr.addEmitter({ emitterInfo: info(GFX_AA), parent: anchor });
  for (let i = 0; i < 4; i += 1) { t += 0.016; mgr.tick(); }
  const ims = group.children.filter((o) => o.isInstancedMesh);
  const imAdd = ims.find((o) => o.name === `particle-inst-0x${GFX_ADD.toString(16)}`);
  const imAlpha = ims.find((o) => o.name === `particle-inst-0x${GFX_ALPHA.toString(16)}-a`);
  const imAA = ims.find((o) => o.name === `particle-inst-0x${GFX_AA.toString(16)}`);
  check("three emitters, three buckets", !!imAdd && !!imAlpha && !!imAA, ims.map((o) => o.name).join(","));
  check("additive bucket: unfogged, still additive", imAdd?.material.fog === false && imAdd?.material.blending === THREE.AdditiveBlending);
  check("additive bucket: three's stock no-fog program (no hook, default key)",
    !Object.prototype.hasOwnProperty.call(imAdd.material, "onBeforeCompile") && imAdd.material.customProgramCacheKey() === stockKey);
  check("Alpha+Additive (CustomBlending base) bucket: unfogged", imAA?.material.fog === false && imAA?.material.blending === THREE.AdditiveBlending);
  check("alpha bucket: stock fog toward fogColor kept", imAlpha?.material.fog === true);
  check("alpha bucket: its own program key untouched", imAlpha?.material.customProgramCacheKey() === "hbParticleInstAlpha");
  const slots = (id) => mgr.particleTable.get(id).partStorage.filter(Boolean).map((m) => m.material);
  check("additive per-slot clones unfogged", slots(idAdd).length === 4 && slots(idAdd).every((m) => m.fog === false));
  check("Alpha+Additive per-slot clones unfogged", slots(idAA).every((m) => m.fog === false));
  check("alpha per-slot clones keep fog", slots(idAlpha).every((m) => m.fog === true));
  check("base cache materials never touched", baseAdd.fog === true && baseAlpha.fog === true && baseAA.fog === true &&
    F.additiveFogStateOf(baseAdd) === null);
  check("bucket materials share ONE program shape (no per-instance variant)",
    imAdd.material.customProgramCacheKey() === imAA.material.customProgramCacheKey());

  // per-mesh path (?particleInstancing=off analogue)
  const g2 = new THREE.Group();
  const anchor2 = new THREE.Object3D(); anchor2.position.set(0, 0, -10);
  g2.add(anchor2);
  const mgr2 = mk(false, g2);
  const id2 = await mgr2.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor2 });
  for (let i = 0; i < 4; i += 1) { t += 0.016; mgr2.tick(); }
  const live2 = g2.children.filter((o) => o.isMesh && o.userData.__particle);
  check("per-mesh path: live additive particle meshes are unfogged",
    live2.length > 0 && live2.every((o) => o.material.fog === false), `live=${live2.length}`);

  // pool reuse: teardown parks the clones; a rebuilt emitter reuses them as-is.
  const before = mgr2.particleTable.get(id2).partStorage.filter(Boolean).map((m) => [m.material, m.material.version]);
  mgr2.destroyParticleEmitter(id2);
  const id3 = await mgr2.addEmitter({ emitterInfo: info(GFX_ADD), parent: anchor2 });
  const after = mgr2.particleTable.get(id3).partStorage.filter(Boolean).map((m) => m.material);
  const reused = before.filter(([m]) => after.includes(m));
  check("pooled clones reused", reused.length === before.length && reused.length > 0, `${reused.length}/${before.length}`);
  check("pooled clones keep the mode with NO program churn", reused.every(([m, v]) => m.fog === false && m.version === v));

  // live switch, no reload
  check("window.__additiveFogBlack installed", typeof window.__additiveFogBlack === "function");
  const d0 = window.__additiveFogBlack();
  check("diag: every additive material unfogged in retail",
    d0.mode === "retail" && d0.materials > 0 && d0.unfogged === d0.materials && d0.buckets >= 2 && d0.bucketsUnfogged === d0.buckets,
    JSON.stringify(d0));
  const d1 = window.__additiveFogBlack("fade");
  check("live -> fade: every additive material fogged-to-black",
    d1.mode === "fade" && d1.fade === d1.materials && d1.bucketsFade === d1.buckets && imAdd.material.fog === true &&
    imAdd.material.customProgramCacheKey() === F.ADDITIVE_FOG_FADE_KEY, JSON.stringify(d1));
  check("live -> fade: alpha bucket untouched", imAlpha.material.fog === true && imAlpha.material.customProgramCacheKey() === "hbParticleInstAlpha");
  const d2 = window.__additiveFogBlack("off");
  check("live -> off: stock fog everywhere, stock key",
    d2.stockFogged === d2.materials && imAdd.material.fog === true && imAdd.material.customProgramCacheKey() === stockKey, JSON.stringify(d2));
  // a NEW emitter built while =off stays stock
  const id4 = await mgr.addEmitter({ emitterInfo: { ...info(GFX_ADD), id: 0x32000002 }, parent: anchor });
  check("new emitter under =off keeps stock fog", mgr.particleTable.get(id4).partStorage.filter(Boolean).every((m) => m.material.fog === true));
  const d3 = window.__additiveFogBlack("retail");
  check("live -> retail: everything unfogged again (incl. the =off-born emitter)", d3.unfogged === d3.materials && d3.materials === d0.materials + 4,
    JSON.stringify(d3));
  check("alpha slots never touched by any switch", slots(idAlpha).every((m) => m.fog === true));

  setCurrentTime(null);
  window.liveScene3d = prevLive;
}

// ---------------------------------------------------------------------------
console.log("-- F6 wiring -------------------------------------------------------");
{
  const PM = readFileSync(path.join(APP, "scene3d", "particles", "particle_manager.js"), "utf8");
  const DOC = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  check("per-slot clones: additive branch applies it after the sky glow",
    /if \(skyGlow\) applySkyGlowMaterial\(mat\);[\s\S]{0,600}if \(baseIsAdditive\) applyAdditiveParticleFog\(mat\);/.test(PM));
  check("instanced bucket: additive branch applies it", /if \(!alpha\) applyAdditiveParticleFog\(mat\);/.test(PM));
  check("url-flags.md row documents the flag, default and escape",
    /^\| `additiveFogBlack` \|.*\*\*ON\*\*.*acclient\.c:454551/m.test(DOC));
}

console.log(`\nadditive particle fog: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
