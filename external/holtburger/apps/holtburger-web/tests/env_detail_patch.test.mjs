// tests/env_detail_patch.test.mjs
//
// 2026-10-13 lighting-materials-7 — retail "Environment Detail Textures" on
// building shells + EnvCell structure, `?envDetailTex=on` (DEFAULT OFF, exact
// opt-in; a 1070 eye-test gates any default flip).
//
// Retail (acclient.c): LScape::SetDetailTexturing :308209 reads the Region's
// detail surface at terrain_desc list index 1 (building) / 2 (environment);
// RenderDeviceD3D::DrawBuilding :456943 / DrawEnvCell :456894 set it around the
// shell / cell-structure draw only, blend DESTCOLOR/INVSRCALPHA, and
// D3DPolyRender::RenderMeshSubset :454792 redraws the subset with it:
//     out = texel*L*(1 + detail.rgb*L - detail.a)
// holtburger folds that into one fragment sample (materials.js
// `_installEnvDetailPatch`) on the building floor-bias variant and the EnvCell
// baked-light variant, via `MaterialCache.applyEnvDetail`.
//
//   E1  flag parsing (`envDetailTexEnabled`): exact `on`, everything else off.
//   E2  flag OFF: `applyEnvDetail` is a no-op (same object, no hook, no key bit)
//       and the default program keys are byte-identical.
//   E3  flag ON: one shared program key per kind (`|e1` / `|e2`), idempotent,
//       shared uniforms bound by reference, composes with the variant's own
//       patch against REAL three r184 shader text, never patches the shared
//       base / a foreign variant, survives a re-seat.
//   E4  uniforms + the one-shot region load (stale pkg, success, shared decode,
//       failure).
//   E5  the gamma-space fold matches the retail blend.
//   E6  wiring: applied only from buildings.js + cells.js (structure only), the
//       atlas / pool bypass, the wasm export.
//
// Run: node tests/env_detail_patch.test.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
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

function setSearch(s) {
  globalThis.window = { location: { search: s } };
}
function clearWindow() {
  delete globalThis.window;
}

const M = new Function(
  "THREE",
  spliceModule(src("scene3d/materials.js"), { stubs: MATERIALS_JS_STUBS, label: "scene3d/materials.js" }) +
    "\n; return { MaterialCache, envDetailTexEnabled, ENV_DETAIL_KIND_CODE, envDetailUniformsFor," +
    " setEnvDetailSurface, loadEnvDetailSurfaces, installEnvDetailPatch, __resetEnvDetailForTest, VERTEX_BAKE };",
)(THREE);

const tex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
function seed(cache, did) {
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.userData = { csmEnabled: true }; // a base flag the clones inherit
  cache.materials.set(did >>> 0, m);
  return m;
}
// Run a material's onBeforeCompile chain against the REAL three r184 standard
// shader text (so every anchor the patches rely on is the production one).
function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}
const count = (s, needle) => s.split(needle).length - 1;

// ---------------------------------------------------------------------------
console.log("\n-- E1 flag -----------------------------------------------------");
clearWindow();
check("node default (no window) -> off", M.envDetailTexEnabled() === false);
setSearch("");
check("absent -> off", M.envDetailTexEnabled() === false);
setSearch("?envDetailTex=on");
check("=on -> on", M.envDetailTexEnabled() === true);
setSearch("?envDetailTex=ON");
check("=ON -> on (case-insensitive)", M.envDetailTexEnabled() === true);
check("1 / true / yes / off / 0 / garbage / empty -> off (exact opt-in)",
  ["1", "true", "yes", "off", "0", "maybe", ""].every((v) => {
    setSearch(`?envDetailTex=${v}`);
    return M.envDetailTexEnabled() === false;
  }));
check("explicit search arg wins over window", M.envDetailTexEnabled("?envDetailTex=on") === true &&
  M.envDetailTexEnabled("?other=1") === false);
globalThis.window = { get location() { throw new Error("boom"); } };
check("a throwing location -> off", M.envDetailTexEnabled() === false);
clearWindow();
check("a cache built with no flag reads it OFF", new M.MaterialCache().envDetailOn === false);
setSearch("?envDetailTex=on");
check("a cache built under ?envDetailTex=on reads it ON", new M.MaterialCache().envDetailOn === true);
clearWindow();

// ---------------------------------------------------------------------------
console.log("\n-- E2 flag OFF: no-op ------------------------------------------");
{
  M.__resetEnvDetailForTest();
  let fetches = 0;
  const wasm = { fetchRegionDetailSurfaces: async () => { fetches++; return null; } };
  const cache = new M.MaterialCache({ wasmExports: wasm });
  check("premise: flag off", cache.envDetailOn === false);
  check("premise: vertex bake on in node (cell-baked variants mint)", M.VERTEX_BAKE.enabled === true);
  seed(cache, 0x08000100);
  seed(cache, 0x08000200);
  const fb = cache.getCachedFloorBias(0x08000100);
  const cb = cache.getCachedCellBaked(0x08000200);
  const fbHook = fb.onBeforeCompile, cbHook = cb.onBeforeCompile;
  const fbKey = fb.customProgramCacheKey(), cbKey = cb.customProgramCacheKey();
  check("applyEnvDetail(building) returns the same object", cache.applyEnvDetail(fb, "building", 0x08000100) === fb);
  check("applyEnvDetail(environment) returns the same object",
    cache.applyEnvDetail(cb, "environment", 0x08000200) === cb);
  check("no marker stamped", fb.userData.__envDetailKind === undefined && cb.userData.__envDetailKind === undefined);
  check("no hook chained", fb.onBeforeCompile === fbHook && cb.onBeforeCompile === cbHook);
  check("program keys unchanged", fb.customProgramCacheKey() === fbKey && cb.customProgramCacheKey() === cbKey);
  check("default keys carry no |e bit (byte-identical to pre-change)",
    fbKey === "hb|d0|c1|p0|l0|a0|b0|f1|s0|k0|v" && cbKey === "hb|d0|c1|p0|l0|a0|b0|f0|s0|k1|v",
    `fb=${fbKey} cb=${cbKey}`);
  const sh = compile(fb);
  check("compiled shader has no env-detail text", !sh.fragmentShader.includes("uAcEnvDetail"));
  check("no region fetch", fetches === 0);
  check("explicit opts.envDetailTex=false also off", new M.MaterialCache({ envDetailTex: false }).envDetailOn === false);
}

// ---------------------------------------------------------------------------
console.log("\n-- E3 flag ON: one program per kind -----------------------------");
{
  M.__resetEnvDetailForTest();
  let fetches = 0;
  const wasm = { fetchRegionDetailSurfaces: async () => { fetches++; return null; } };
  const cache = new M.MaterialCache({ envDetailTex: true, wasmExports: wasm });
  const dids = [0x08000301, 0x08000302, 0x08000303];
  for (const d of dids) seed(cache, d);
  const b1 = cache.applyEnvDetail(cache.getCachedFloorBias(dids[0]), "building", dids[0]);
  const b2 = cache.applyEnvDetail(cache.getCachedFloorBias(dids[1]), "building", dids[1]);
  const e1 = cache.applyEnvDetail(cache.getCachedCellBaked(dids[0]), "environment", dids[0]);
  const e2 = cache.applyEnvDetail(cache.getCachedCellBaked(dids[2]), "environment", dids[2]);
  check("returns the variant itself (patched in place)", b1 === cache.floorBiasMaterials.get(dids[0]) &&
    e1 === cache.cellBakedMaterials.get(dids[0]));
  check("markers stamped per kind", b1.userData.__envDetailKind === "building" &&
    e2.userData.__envDetailKind === "environment");
  const kb1 = b1.customProgramCacheKey(), kb2 = b2.customProgramCacheKey();
  const ke1 = e1.customProgramCacheKey(), ke2 = e2.customProgramCacheKey();
  check("building variants share ONE key, ending |e1", kb1 === kb2 && kb1.endsWith("|e1"), `${kb1} / ${kb2}`);
  check("environment variants share ONE key, ending |e2", ke1 === ke2 && ke1.endsWith("|e2"), `${ke1} / ${ke2}`);
  check("the two kinds never share a key", kb1 !== ke1);
  check("key = the unpatched variant key + the kind bit only",
    kb1 === "hb|d0|c1|p0|l0|a0|b0|f1|s0|k0|v|e1" && ke1 === "hb|d0|c1|p0|l0|a0|b0|f0|s0|k1|v|e2", `${kb1} ${ke1}`);
  check("key codes", M.ENV_DETAIL_KIND_CODE.building === 1 && M.ENV_DETAIL_KIND_CODE.environment === 2);

  // Idempotent.
  const hook = b1.onBeforeCompile;
  const again = cache.applyEnvDetail(b1, "building", dids[0]);
  check("idempotent: second apply returns same object, chains nothing", again === b1 && b1.onBeforeCompile === hook);
  check("installEnvDetailPatch on an already-patched material -> false",
    M.installEnvDetailPatch(b1, "building") === false && M.installEnvDetailPatch(b1, "environment") === false);
  check("region load requested once for the whole session", fetches === 1, `fetches=${fetches}`);
  await M.loadEnvDetailSurfaces(wasm);
  check("a null bundle leaves both kinds off (no throw)",
    M.envDetailUniformsFor("building").uAcEnvDetailOn.value === 0 &&
      M.envDetailUniformsFor("environment").uAcEnvDetailOn.value === 0);

  // Compile against the real three shader text.
  const sb1 = compile(b1), sb2 = compile(b2), se1 = compile(e1);
  const ub = M.envDetailUniformsFor("building"), ue = M.envDetailUniformsFor("environment");
  check("building programs bind the SHARED building uniforms by reference",
    sb1.uniforms.uAcEnvDetailMap === ub.uAcEnvDetailMap && sb2.uniforms.uAcEnvDetailMap === ub.uAcEnvDetailMap &&
    sb1.uniforms.uAcEnvDetailOn === ub.uAcEnvDetailOn && sb2.uniforms.uAcEnvDetailTiling === ub.uAcEnvDetailTiling);
  check("environment program binds the environment set", se1.uniforms.uAcEnvDetailOn === ue.uAcEnvDetailOn &&
    se1.uniforms.uAcEnvDetailMap !== ub.uAcEnvDetailMap);
  const f = sb1.fragmentShader;
  check("uniform declared once", count(f, "uniform sampler2D uAcEnvDetailMap;") === 1);
  check("opaque_fragment kept exactly once, after the term",
    count(f, "#include <opaque_fragment>") === 1 && f.indexOf("acEnvDetail") < f.indexOf("#include <opaque_fragment>"));
  check("term is compiled out without a map (fallback-born variants)", /#ifdef USE_MAP\s*\nif \(uAcEnvDetailOn > 0\.5\)/.test(f));
  check("detail UV = tiling x the map UV (retail UV set 1)", f.includes("vMapUv * uAcEnvDetailTiling"));
  check("building variant keeps its floor-bias patch", f.includes("gl_FragDepth -= 2.0e-4"));
  check("cell variant keeps its baked-light patch",
    se1.fragmentShader.includes("uAcBakedGain") && se1.uniforms.uAcBakedGain !== undefined &&
    se1.fragmentShader.includes("uAcEnvDetailMap"));
  check("no backticks in the injected GLSL", !f.slice(f.indexOf("uAcEnvDetailMap")).includes("`"));

  // Never the shared base, never a foreign variant, never an unknown kind.
  const base = cache.getCached(dids[1]);
  check("the shared base (statics / objects in cells) is never patched",
    cache.applyEnvDetail(base, "building", dids[1]) === base && base.userData.__envDetailKind === undefined);
  const fb3 = cache.getCachedFloorBias(dids[2]);
  check("a floor-bias variant offered as 'environment' is left alone",
    cache.applyEnvDetail(fb3, "environment", dids[2]) === fb3 && fb3.userData.__envDetailKind === undefined);
  check("wrong DID for the variant is left alone",
    cache.applyEnvDetail(fb3, "building", dids[0]) === fb3 && fb3.userData.__envDetailKind === undefined);
  check("unknown kind is left alone", cache.applyEnvDetail(fb3, "object", dids[2]) === fb3 &&
    fb3.userData.__envDetailKind === undefined);
  check("null material passes through", cache.applyEnvDetail(null, "building", 1) === null);

  // Re-seat (base re-installed) keeps the marker, hence the key.
  cache.materials.set(dids[0] >>> 0, seed(new M.MaterialCache(), dids[0]));
  cache._reseatVariantsForDid(dids[0]);
  check("re-seat keeps the kind marker + key", b1.userData.__envDetailKind === "building" &&
    b1.customProgramCacheKey() === kb1, b1.customProgramCacheKey());
  check("re-seat keeps the hook", b1.onBeforeCompile === hook);

  // Wireframe caches never patch.
  const wire = new M.MaterialCache({ envDetailTex: true, wireframeMode: true });
  const wm = new THREE.MeshBasicMaterial();
  check("wireframe cache: no-op", wire.applyEnvDetail(wm, "building", 1) === wm && wm.userData.__envDetailKind === undefined);
}

// ---------------------------------------------------------------------------
console.log("\n-- E4 uniforms + region load ------------------------------------");
{
  M.__resetEnvDetailForTest();
  const ub = M.envDetailUniformsFor("building");
  check("unknown kind -> null uniforms / false", M.envDetailUniformsFor("object") === null &&
    M.setEnvDetailSurface("object", tex, 4) === false);
  check("texture + tiling -> on", M.setEnvDetailSurface("building", tex, 4) === true &&
    ub.uAcEnvDetailOn.value === 1 && ub.uAcEnvDetailTiling.value === 4 && ub.uAcEnvDetailMap.value === tex);
  check("zero tiling -> off (retail: a zero factor disables detailing)",
    M.setEnvDetailSurface("building", tex, 0) === false && ub.uAcEnvDetailOn.value === 0);
  check("no texture -> off", M.setEnvDetailSurface("building", null, 4) === false && ub.uAcEnvDetailOn.value === 0);
  M.__resetEnvDetailForTest();

  check("no wasm -> null (stays off)", M.loadEnvDetailSurfaces(null) === null);
  check("stale pkg (export missing) -> null (stays off)", M.loadEnvDetailSurfaces({}) === null &&
    ub.uAcEnvDetailOn.value === 0);

  let freed = 0, fetches = 0;
  const px = new Uint8Array(2 * 2 * 4).fill(42);
  const bundle = {
    takeTextures: () => [{ width: 2, height: 2, pixels: px, free() { freed++; } }],
    buildingSlice: 0, buildingTiling: 4, buildingGid: 0x05001787,
    environmentSlice: 0, environmentTiling: 4, environmentGid: 0x05001787,
    free() { freed++; },
  };
  const wasm = { fetchRegionDetailSurfaces: async () => { fetches++; return bundle; } };
  const p1 = M.loadEnvDetailSurfaces(wasm);
  const p2 = M.loadEnvDetailSurfaces(wasm);
  check("one shared promise per page", p1 === p2 && fetches === 1);
  const on = await p1;
  const ue = M.envDetailUniformsFor("environment");
  check("both kinds on", on === 2 && ub.uAcEnvDetailOn.value === 1 && ue.uAcEnvDetailOn.value === 1);
  check("shared GID decodes ONE texture for both kinds", ub.uAcEnvDetailMap.value &&
    ub.uAcEnvDetailMap.value === ue.uAcEnvDetailMap.value);
  const t = ub.uAcEnvDetailMap.value;
  check("raw bytes (NoColorSpace), WRAP, linear-mipmapped, unflipped",
    t.colorSpace === THREE.NoColorSpace && t.wrapS === THREE.RepeatWrapping && t.wrapT === THREE.RepeatWrapping &&
    t.minFilter === THREE.LinearMipmapLinearFilter && t.magFilter === THREE.LinearFilter && t.flipY === false &&
    t.image.width === 2 && t.image.height === 2);
  check("tiling carried", ub.uAcEnvDetailTiling.value === 4 && ue.uAcEnvDetailTiling.value === 4);
  check("wasm objects freed (texture + bundle)", freed === 2, `freed=${freed}`);

  // A region with only a building surface.
  M.__resetEnvDetailForTest();
  const onlyB = {
    takeTextures: () => [{ width: 1, height: 1, pixels: new Uint8Array(4) }],
    buildingSlice: 0, buildingTiling: 4, environmentSlice: 255, environmentTiling: 0,
  };
  await M.loadEnvDetailSurfaces({ fetchRegionDetailSurfaces: async () => onlyB });
  check("slice 255 -> that kind stays off", ub.uAcEnvDetailOn.value === 1 && ue.uAcEnvDetailOn.value === 0);

  // Failure is fail-soft.
  M.__resetEnvDetailForTest();
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  const r = await M.loadEnvDetailSurfaces({ fetchRegionDetailSurfaces: async () => { throw new Error("404"); } });
  console.warn = warn;
  check("fetch failure -> resolves 0, both off, one warning", r === 0 && warned === 1 &&
    ub.uAcEnvDetailOn.value === 0 && ue.uAcEnvDetailOn.value === 0);
  M.__resetEnvDetailForTest();
}

// ---------------------------------------------------------------------------
console.log("\n-- E5 gamma-space fold == retail blend --------------------------");
{
  // Retail (D3D, gamma space): dst = texel*L; src = detail.rgb*L; out = src*dst + dst*(1 - a).
  const retail = (texel, L, d, a) => {
    const dst = texel * L;
    const s = Math.min(1, Math.max(0, d * L));
    return Math.min(1, Math.max(0, s * dst + dst * (1 - a)));
  };
  // Ours: linear outgoing = (texel*L)^2.2; L recovered as (outgoing/albedo)^(1/2.2);
  // outgoing *= f^2.2 with f = 1 + clamp(d*L) - a. Displayed = outgoing^(1/2.2).
  const ours = (texel, L, d, a) => {
    const albedo = Math.pow(texel, 2.2);
    const outgoing = Math.pow(texel * L, 2.2);
    const Lg = Math.pow(Math.min(1, Math.max(0, outgoing / Math.max(albedo, 1e-3))), 1 / 2.2);
    const fv = 1 + Math.min(1, Math.max(0, d * Lg)) - a;
    return Math.pow(outgoing * Math.pow(Math.max(fv, 0), 2.2), 1 / 2.2);
  };
  let worst = 0;
  for (const texel of [0.1, 0.35, 0.6, 0.85]) {
    for (const L of [0.2, 0.5, 0.8, 1.0]) {
      for (const [d, a] of [[42 / 255, 34 / 255], [0, 0], [0.5, 0.2], [0.1, 0.4]]) {
        const r = retail(texel, L, d, a);
        if (r >= 1) continue; // retail clamps; the HDR path does not
        worst = Math.max(worst, Math.abs(ours(texel, L, d, a) - r));
      }
    }
  }
  check("matches the retail DESTCOLOR/INVSRCALPHA result (unclamped range)", worst < 1e-6, `worst=${worst}`);
  // Retail Dereth's tile (rgb ~42, alpha ~34) is a near-neutral grain.
  const fFull = 1 + 42 / 255 - 34 / 255;
  check("near-neutral at full light (|f-1| < 5%)", Math.abs(fFull - 1) < 0.05, `f=${fFull}`);
  check("a detail texel with rgb 0 and alpha 0 is the identity", Math.abs(ours(0.5, 0.7, 0, 0) - 0.5 * 0.7) < 1e-9);

  // The shipped GLSL is the formula above (pinned so a drive-by edit is caught).
  const MAT = src("scene3d/materials.js");
  check("GLSL: L = (outgoing / albedo)^(1/2.2), clamped",
    MAT.includes("clamp(outgoingLight / max(diffuseColor.rgb, vec3(1e-3)), 0.0, 1.0)") &&
      MAT.includes("pow(acEnvLin, vec3(1.0 / 2.2))"));
  check("GLSL: f = 1 + clamp(detail.rgb * L) - detail.a, applied as f^2.2",
    MAT.includes("1.0 + clamp(acEnvDetail.rgb * acEnvL, 0.0, 1.0) - acEnvDetail.a") &&
      MAT.includes("outgoingLight *= pow(max(acEnvF, vec3(0.0)), vec3(2.2))"));
}

// ---------------------------------------------------------------------------
console.log("\n-- E6 wiring ----------------------------------------------------");
{
  const MAT = src("scene3d/materials.js");
  const BLD = src("scene3d/buildings.js");
  const CEL = src("scene3d/cells.js");
  // Every JS file the client ships (scene3d, app, ui, plugins, rynth) + index.html.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      const st = statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(m?js|html)$/.test(name)) files.push(rel);
    }
  };
  for (const d of ["scene3d", "app", "ui", "plugins", "rynth"]) {
    try { walk(d); } catch (_) { /* dir absent */ }
  }
  files.push("index.html");
  const callers = files.filter((f) => /\.applyEnvDetail\(/.test(src(f)));
  check("applyEnvDetail is called from buildings.js + cells.js ONLY",
    callers.length === 2 && callers.includes(path.join("scene3d", "buildings.js")) &&
      callers.includes(path.join("scene3d", "cells.js")), callers.join(", "));
  const installers = files.filter((f) => /\binstallEnvDetailPatch\(|_installEnvDetailPatch\(/.test(src(f)));
  check("the patch installer is reached only through materials.js",
    installers.length === 1 && installers[0] === path.join("scene3d", "materials.js"), installers.join(", "));
  check("materials.js installs it only from applyEnvDetail (+ the exported twin)",
    count(MAT, "_installEnvDetailPatch(") === 3, `n=${count(MAT, "_installEnvDetailPatch(")}`);

  check("buildings.js: kind 'building', right after the shell material pick",
    /getCachedFloorBias\(g\.surfaceDid\)[\s\S]{0,400}applyEnvDetail\(mat, "building", g\.surfaceDid\)/.test(BLD));
  check("cells.js: kind 'environment', once, inside cellMaterialFor (structure, not statics)",
    count(CEL, ".applyEnvDetail(") === 1 &&
      /function cellMaterialFor\([^)]*\) \{[\s\S]*?applyEnvDetail\(mat, "environment", group\.surfaceDid\)[\s\S]*?\n\}/.test(CEL));
  check("statics never get it", !src("scene3d/statics.js").includes("applyEnvDetail"));
  check("buildings.js: patched shells bypass pools + atlas",
    /function _feedBuildingGroupsToAtlas[\s\S]*?_carriesEnvDetail[\s\S]*?addSingletonsToPools/.test(BLD));
  check("cells.js: patched cells are not offered to the pools",
    /function _offerCellSurfaces\([^)]*\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(resolved\.some\([^\n]*__envDetailKind/.test(CEL));
  check("re-seat + clone-loss lists know the marker",
    /_RESEAT_KEEP_USERDATA = \[[^\]]*"__envDetailKind"/.test(MAT) && /_CLONE_LOST_PATCH_FLAGS = \[[^\]]*"__envDetailKind"/.test(MAT));
  check("JS guards the wasm export (stale pkg degrades)",
    /typeof wasm\.fetchRegionDetailSurfaces !== "function"/.test(MAT));
  // MaterialCache._envDetailWasm IS the curated init3D opts object, so the
  // export must be plumbed there (namespace access: stale pkg -> undefined).
  check("index.html plumbs fetchRegionDetailSurfaces into the init3D opts",
    /^\s*fetchRegionDetailSurfaces: __hbWasmNs\.fetchRegionDetailSurfaces,$/m.test(src("index.html")));

  const LIB = src("src/lib.rs");
  check("lib.rs exports fetchRegionDetailSurfaces",
    /#\[wasm_bindgen\(js_name = fetchRegionDetailSurfaces\)\]\s*\npub async fn fetch_region_detail_surfaces\(\)/.test(LIB));
  check("lib.rs reads terrain_desc list index 1 (building) / 2 (environment)",
    /const REGION_DETAIL_BUILDING: usize = 1;/.test(LIB) && /const REGION_DETAIL_ENVIRONMENT: usize = 2;/.test(LIB));
  check("lib.rs has the Rust unit tests", /mod tests_region_detail_surfaces/.test(LIB) &&
    /fn picks_building_and_environment_by_list_index\(\)/.test(LIB));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
