// tests/luminous_hook.test.mjs
//
// 2026-10-13 lighting-materials-5 — how a Luminous(8) / LuminousPart(9) hook
// value lands on an entity material (scene3d/luminous_hook.js +
// entities.js `_applyRampValueToMaterial`).
//
// `?surfaceLumWins` (DEFAULT ON; `off/0/false/no` escape). Retail
// D3DPolyRender::RenderMeshSubset (acclient.c:454688-454719) draws a surface
// with its own luminosity using that value in place of the part material's
// Emissive and restores it after (:454828-454845), so a Luminous hook never
// reaches it. The ramp used to write `emissive = v`, `emissiveIntensity = 1`
// on every surface: a ramp to 0 killed a crystal's glow, a ramp to 1
// over-brightened a 0.3 surface.
//
// `?lumHookTexel` (DEFAULT ON; same escape). Retail's FF stage draws
// texture × saturate(emissive + lighting); three ADDS emissive and modulates it
// by the texture only through emissiveMap, so a hook on a textured surface with
// no luminosity of its own washed it flat white. While v > 0 `map` is the
// emissiveMap; at 0 the authored one comes back.
//
//   K1  flag parsing for both flags.
//   K2  syncLuminousHookTexel (pure, real three): attach / restore, the
//       USE_EMISSIVEMAP version bump only on presence changes, authored maps,
//       the luminous alias, no map, NaN, a map swapped mid-ramp, the escape.
//   K3  the REAL `_applyRampValueToMaterial` body (spliced from entities.js):
//       the verifier's plan (surface luminosity 0.75 keeps emissive /
//       emissiveIntensity 0.75 after v=0 and v=1; luminosity 0 gets emissive=v,
//       intensity 1), ?lumNight tracking kept, the texel, both escapes.
//   K4  the stamp from all three Surface ladders (real materials.js
//       applySurfaceRenderState / `_materialFromFlags`, the real entities.js
//       `_applyPalettedSurfaceRenderState`), and clone() carrying it.
//   K5  wiring.
//
// Fails on the pre-change code: luminous_hook.js does not exist, no ladder
// stamps `__surfaceLuminosity`, and the hook overwrites a luminous surface.
//
// Run: node tests/luminous_hook.test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { spliceModule } from "../harness/lib/splice_module.mjs";
import { MATERIALS_JS_STUBS } from "../harness/lib/scene3d_stubs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const src = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const H = await import("../scene3d/luminous_hook.js");
const L = await import("../scene3d/luminous_night.js");
const OFF_FORMS = ["off", "0", "false", "no", "OFF"];

// ---------------------------------------------------------------------------
console.log("\n-- K1 flags ---------------------------------------------------");
for (const [name, fn] of [["surfaceLumWins", H.surfaceLumWinsEnabled], ["lumHookTexel", H.lumHookTexelEnabled]]) {
  check(`${name}: absent / empty -> on`, fn("") === true && fn("?x=1") === true);
  check(`${name}: =on / garbage -> on`, fn(`?${name}=on`) === true && fn(`?${name}=maybe`) === true);
  check(`${name}: off / 0 / false / no / OFF -> off`, OFF_FORMS.every((v) => fn(`?${name}=${v}`) === false));
  check(`${name}: node default (no window) -> on`, fn() === true);
}

// ---------------------------------------------------------------------------
console.log("\n-- K2 syncLuminousHookTexel ----------------------------------");
const tex = new THREE.Texture();
const other = new THREE.Texture();
{
  const m = new THREE.MeshStandardMaterial({ map: tex });
  const v0 = m.version;
  check("premise: a non-luminous material has no emissiveMap", m.emissiveMap === null);
  check("v > 0: map becomes the emissiveMap, one version bump (USE_EMISSIVEMAP)",
    H.syncLuminousHookTexel(m, 0.6) === true && m.emissiveMap === tex && m.version === v0 + 1);
  check("later ramp frames change nothing (no per-frame recompile)",
    H.syncLuminousHookTexel(m, 0.9) === false && H.syncLuminousHookTexel(m, 1) === false && m.version === v0 + 1);
  check("v = 0: the authored (null) emissiveMap is back, one version bump",
    H.syncLuminousHookTexel(m, 0) === true && m.emissiveMap === null && m.version === v0 + 2);
  check("v = 0 again is a no-op", H.syncLuminousHookTexel(m, 0) === false && m.emissiveMap === null && m.version === v0 + 2);
  check("a second ramp attaches again", H.syncLuminousHookTexel(m, 0.3) === true && m.emissiveMap === tex);
  H.syncLuminousHookTexel(m, 0);
}
{
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: other });
  const v0 = m.version;
  check("an authored emissiveMap is swapped for map with no define change",
    H.syncLuminousHookTexel(m, 1) === true && m.emissiveMap === tex && m.version === v0);
  check("...and restored at 0", H.syncLuminousHookTexel(m, 0) === true && m.emissiveMap === other && m.version === v0);
}
{
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex });
  const v0 = m.version;
  check("the luminous alias (emissiveMap === map) is left alone at v > 0 and at 0",
    H.syncLuminousHookTexel(m, 1) === false && H.syncLuminousHookTexel(m, 0) === false
    && m.emissiveMap === tex && m.version === v0);
}
{
  const m = new THREE.MeshStandardMaterial();
  check("no map: nothing to attach", H.syncLuminousHookTexel(m, 1) === false && m.emissiveMap === null);
  const n = new THREE.MeshStandardMaterial({ map: tex });
  check("NaN / null material: no-op",
    H.syncLuminousHookTexel(n, NaN) === false && n.emissiveMap === null && H.syncLuminousHookTexel(null, 1) === false);
}
{
  const m = new THREE.MeshStandardMaterial({ map: tex });
  H.syncLuminousHookTexel(m, 1);
  const scrolled = tex.clone(); // TextureVelocity's per-entity map clone
  m.map = scrolled;
  const v1 = m.version;
  check("a map swapped mid-ramp is followed on the next write (no define change)",
    H.syncLuminousHookTexel(m, 0.5) === true && m.emissiveMap === scrolled && m.version === v1);
  check("...and the authored null still comes back at 0", H.syncLuminousHookTexel(m, 0) === true && m.emissiveMap === null);
}
{
  const m = new THREE.MeshStandardMaterial({ map: tex });
  const v0 = m.version;
  check("?lumHookTexel=off: untouched (pre-change flat emissive)",
    H.syncLuminousHookTexel(m, 1, "?lumHookTexel=off") === false && m.emissiveMap === null && m.version === v0);
}

// ---------------------------------------------------------------------------
console.log("\n-- K3 the real _applyRampValueToMaterial ----------------------");
const ENT = src("scene3d/entities.js");
function method(name) {
  const m = new RegExp(`\\n  ${name}\\([^)]*\\) \\{\\n`).exec(ENT);
  if (!m) throw new Error(`entities.js: method ${name} not found`);
  const start = m.index + 1;
  const end = ENT.indexOf("\n  }\n", start);
  return ENT.slice(start, end + 4);
}
function managerWith({ wins = "", texel = "" } = {}) {
  const Cls = new Function(
    "releaseLuminousMaterial", "surfaceLumWinsEnabled", "syncLuminousHookTexel",
    `return class {\n${method("_applyRampValueToMaterial")}\n};`,
  )(L.releaseLuminousMaterial, () => H.surfaceLumWinsEnabled(wins), (m, v) => H.syncLuminousHookTexel(m, v, texel));
  return new Cls();
}
const keep = [];
const crystal = (lum = 0.75) => {
  const m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveIntensity: lum, emissiveMap: tex });
  m.userData = { __surfaceLuminosity: lum };
  keep.push(m);
  return m;
};
const plain = (ud = {}) => {
  const m = new THREE.MeshStandardMaterial({ map: tex });
  m.userData = { ...ud };
  keep.push(m);
  return m;
};
const mgr = managerWith();
{
  const m = crystal(0.75);
  const v0 = m.version;
  mgr._applyRampValueToMaterial(8, m, 0);
  check("surface luminosity 0.75, Luminous v=0: emissive + emissiveIntensity 0.75 kept",
    m.emissive.getHex() === 0xffffff && near(m.emissiveIntensity, 0.75), `got ${m.emissive.getHexString()} × ${m.emissiveIntensity}`);
  mgr._applyRampValueToMaterial(8, m, 1);
  check("...and after v=1 (no over-brightening)", m.emissive.getHex() === 0xffffff && near(m.emissiveIntensity, 0.75));
  mgr._applyRampValueToMaterial(9, m, 0);
  check("LuminousPart(9) is skipped the same way", m.emissive.getHex() === 0xffffff && near(m.emissiveIntensity, 0.75));
  check("...its emissiveMap and program are untouched", m.emissiveMap === tex && m.version === v0);
  mgr._applyRampValueToMaterial(20, m, 0.5);
  check("a Transparent(20) hook still reaches it (only 8/9 skip)", near(m.opacity, 0.5) && m.transparent === true);
}
{
  // ?lumNight: the crystal-ish 0.5 surface keeps dimming at night through a hook.
  L.applyLuminousScale(1);
  const cache = crystal(0.5);
  L.registerLuminousMaterial(cache, 0.5);
  const clone = cache.clone();
  keep.push(clone);
  check("premise: the clone carries the stamp (userData is copied)", clone.userData.__surfaceLuminosity === 0.5);
  L.adoptLuminousClone(clone);
  const n0 = L.luminousNightState().tracked;
  mgr._applyRampValueToMaterial(8, clone, 1);
  check("a skipped luminous clone stays on ?lumNight (not released)",
    L.luminousNightState().tracked === n0 && clone.userData.hbLumBase === 0.5);
  L.applyLuminousScale(0.25);
  check("...and dims with its peers at night", near(clone.emissiveIntensity, 0.125) && near(cache.emissiveIntensity, 0.125),
    `got ${clone.emissiveIntensity}`);
  L.applyLuminousScale(1);
}
{
  const m = plain({ __surfaceLuminosity: 0 });
  mgr._applyRampValueToMaterial(8, m, 0.6);
  check("surface luminosity 0: emissive = v at intensity 1", near(m.emissive.r, 0.6) && near(m.emissive.b, 0.6) && m.emissiveIntensity === 1);
  check("...lit through the texel (emissiveMap = map)", m.emissiveMap === tex);
  mgr._applyRampValueToMaterial(8, m, 0);
  check("v=0: emissive black, authored (null) emissiveMap restored", m.emissive.getHex() === 0 && m.emissiveMap === null);
  const n = plain();
  mgr._applyRampValueToMaterial(9, n, 1);
  check("no stamp at all (never luminous): LuminousPart(9) applies", n.emissive.getHex() === 0xffffff && n.emissiveIntensity === 1 && n.emissiveMap === tex);
  const bare = new THREE.MeshStandardMaterial();
  keep.push(bare);
  mgr._applyRampValueToMaterial(8, bare, 0.4);
  check("an untextured surface keeps the flat emissive", near(bare.emissive.r, 0.4) && bare.emissiveMap === null);
}
{
  const off = managerWith({ wins: "?surfaceLumWins=off" });
  L.applyLuminousScale(1);
  const cache = crystal(0.5);
  L.registerLuminousMaterial(cache, 0.5);
  const m = cache.clone();
  keep.push(m);
  L.adoptLuminousClone(m);
  const n0 = L.luminousNightState().tracked;
  off._applyRampValueToMaterial(8, m, 0);
  check("?surfaceLumWins=off: the hook overwrites the luminous surface (pre-change)",
    m.emissive.getHex() === 0 && m.emissiveIntensity === 1.0);
  check("...and releases it from ?lumNight (pre-change)", L.luminousNightState().tracked === n0 - 1);
  check("...its authored emissiveMap alias is kept", m.emissiveMap === tex);
}
{
  const off = managerWith({ texel: "?lumHookTexel=off" });
  const m = plain();
  const v0 = m.version;
  off._applyRampValueToMaterial(8, m, 1);
  check("?lumHookTexel=off: flat emissive with no emissiveMap (pre-change)",
    m.emissive.getHex() === 0xffffff && m.emissiveIntensity === 1 && m.emissiveMap === null && m.version === v0);
}

// ---------------------------------------------------------------------------
console.log("\n-- K4 the Surface ladders stamp ------------------------------");
const M = new Function(
  "THREE",
  spliceModule(src("scene3d/materials.js"), { stubs: MATERIALS_JS_STUBS, label: "scene3d/materials.js" }) +
    "\n; return { MaterialCache, SURFACE_TYPE, applySurfaceRenderState, readSurfaceUnifiedFlag, applyClipMapRenderState, applyRetailSinglePass, readLuminousEmissiveMapFlag };",
)(THREE);
{
  const m = new THREE.MeshStandardMaterial({ map: tex });
  M.applySurfaceRenderState(m, { flags: 0, luminosity: 0.75 }, { texture: tex });
  check("applySurfaceRenderState (flags 0, L 0.75) stamps 0.75", m.userData.__surfaceLuminosity === 0.75);
  const t = new THREE.MeshStandardMaterial({ map: tex });
  M.applySurfaceRenderState(t, { flags: M.SURFACE_TYPE.Translucent, translucency: 0.25, luminosity: 0.3 }, { texture: tex });
  check("applySurfaceRenderState (Translucent, L 0.3) stamps 0.3 next to __baseTranslucency",
    t.userData.__surfaceLuminosity === 0.3 && t.userData.__baseTranslucency === 0.25);
  const z = new THREE.MeshStandardMaterial({ map: tex });
  M.applySurfaceRenderState(z, { flags: M.SURFACE_TYPE.Translucent, luminosity: 0 }, { texture: tex });
  check("luminosity 0 is not stamped", z.userData.__surfaceLuminosity === undefined);
}
{
  check("premise: node runs the legacy (default) cache ladder", M.readSurfaceUnifiedFlag() === false);
  const cache = new M.MaterialCache();
  const m = cache._materialFromFlags(0, tex, undefined, undefined, undefined, undefined, { luminosity: 0.6 });
  check("_materialFromFlags inline ladder stamps 0.6", m.userData.__surfaceLuminosity === 0.6 && near(m.emissiveIntensity, 0.6));
  const c = m.clone();
  check("clone() carries the stamp to the per-entity material", c.userData.__surfaceLuminosity === 0.6);
  const n = cache._materialFromFlags(M.SURFACE_TYPE.Translucent, tex, undefined, undefined, undefined, undefined, { translucency: 0.3 });
  check("a non-luminous surface is not stamped", n.userData.__surfaceLuminosity === undefined);
}
{
  const Pal = new Function(
    "THREE", "SURFACE_TYPE", "readSurfaceUnifiedFlag", "applySurfaceRenderState", "applyClipMapRenderState",
    "readLuminousEmissiveMapFlag", "registerLuminousMaterial", "applyRetailSinglePass",
    `return class {\n${method("_applyPalettedSurfaceRenderState")}\n};`,
  )(THREE, M.SURFACE_TYPE, M.readSurfaceUnifiedFlag, M.applySurfaceRenderState, M.applyClipMapRenderState,
    M.readLuminousEmissiveMapFlag, () => false, M.applyRetailSinglePass);
  const pal = new Pal();
  const m = new THREE.MeshStandardMaterial({ map: tex });
  pal._applyPalettedSurfaceRenderState(m, { surfaceType: M.SURFACE_TYPE.Base1Image, luminosity: 0.6 });
  check("paletted ladder (legacy arm) stamps 0.6", m.userData.__surfaceLuminosity === 0.6 && near(m.emissiveIntensity, 0.6));
  const z = new THREE.MeshStandardMaterial({ map: tex });
  pal._applyPalettedSurfaceRenderState(z, { surfaceType: M.SURFACE_TYPE.Base1Image, luminosity: 0 });
  check("paletted ladder: luminosity 0 is not stamped", z.userData.__surfaceLuminosity === undefined);
  // The real ladder output feeds the real hook: the recoloured glow survives.
  const c = m.clone();
  mgr._applyRampValueToMaterial(8, c, 0);
  check("a recoloured luminous clone keeps its glow through a Luminous ramp to 0",
    c.emissive.getHex() === 0xffffff && near(c.emissiveIntensity, 0.6));
}

// ---------------------------------------------------------------------------
console.log("\n-- K5 wiring --------------------------------------------------");
{
  check("entities.js imports the helpers from luminous_hook.js",
    /import \{[^}]*\bsurfaceLumWinsEnabled\b[^}]*\bsyncLuminousHookTexel\b[^}]*\} from "\.\/luminous_hook\.js"/.test(ENT));
  const ramp = method("_applyRampValueToMaterial");
  const lum = ramp.slice(ramp.indexOf("hookType === 8 || hookType === 9"), ramp.indexOf("hookType === 10 || hookType === 11"));
  const skip = lum.indexOf("material.userData?.__surfaceLuminosity > 0 && surfaceLumWinsEnabled()) return;");
  check("the 8/9 branch skips a stamped surface BEFORE it writes emissive",
    skip > 0 && skip < lum.indexOf("material.emissive.setRGB(value, value, value)"));
  const sync = lum.indexOf("syncLuminousHookTexel(material, value)");
  check("the 8/9 branch syncs the texel after its emissiveIntensity write",
    sync > lum.indexOf("material.emissiveIntensity = 1.0"));
  const MAT = src("scene3d/materials.js");
  check("materials.js stamps in applyFloatLumDiffuse and the inline ladder",
    (MAT.match(/__surfaceLuminosity = sfLuminosity/g) || []).length === 2);
  check("entities.js paletted ladder stamps before registering with ?lumNight",
    /mat\.userData\.__surfaceLuminosity = sfLuminosity;\s*registerLuminousMaterial\(mat, sfLuminosity\);/.test(
      method("_applyPalettedSurfaceRenderState")));
}

console.log(`\nluminous hook: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
