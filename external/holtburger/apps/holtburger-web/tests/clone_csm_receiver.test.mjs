// tests/clone_csm_receiver.test.mjs
//
// 2026-10-20 (improvement hunt gpu-shading-2, CSM half only) — the four
// cache-owned clone families (materials.js getCachedFloorBias = every building
// shell surface, getCachedStaticBias = cell décor, getCachedCellBaked = baked
// EnvCell structure, getCachedVariant = VFX variants incl. the windSwayGpu
// trees) are `base.clone()`s. three r184 `Material.copy` keeps the base's
// `csmEnabled` flag (key `|c2`) but drops onBeforeCompile, so the CSM receiver
// hook was never in their programs. `_reinstallCloneCsm` strips the copied
// claim and re-installs the hook (gated on the same flag) before the clone's
// own patch.
//
//   D   DEFAULT PATH (no csmState — CSM is off in every preset): for all four
//       families the clone is byte-identical to the pre-change construction —
//       program key, compiled vertex + fragment text, uniform names, userData
//       and own-property order. A base that merely CARRIES a stale csmEnabled
//       flag (no csmState) is left alone too (its key keeps `|c2`, no hook).
//   C   ?csm=on: each family's compiled program carries the CSM receiver
//       exactly once, bound BY REFERENCE to csmState.uniforms, plus its own
//       patch — and NOTHING else changed: the text equals the old clone with
//       only the CSM hook installed first (no POM, no light clamp re-install;
//       the base's light clamp stays lost on the clone exactly as before).
//       Program key unchanged (`|c2` before and after — now backed).
//   T   swaying trees: the windSwayGpu shear edits `transformed` before the
//       CSM receiver reads it after <project_vertex>, so the shadow lookup
//       follows the swaying geometry.
//   R   re-seat gating: a clone first built from the CSM-carrying fallback that
//       re-seats onto a no-CSM base (translucent) drops the hook (key `|c0`, no
//       CSM text) — one-way, since three r184 would reuse a cached `|c2`
//       program with the `|c0` compile's uniforms; re-seated onto an opaque
//       base it keeps the receiver.
//   B   a batched variant (buildingMatBatch / static buckets) of a CSM clone
//       compiles the same receiver (shared userData drives the gate).
//
// Run: node tests/clone_csm_receiver.test.mjs

import * as THREE from "three";
import {
  MaterialCache,
  SURFACE_TYPE,
  VERTEX_BAKE,
  VFX_GLOBALS,
  installCsmShaderPatch,
  applyFloorDepthBias,
  applyStaticDepthBias,
  applyBakedVertexLightPatch,
  installVfxComponentPatch,
} from "../scene3d/materials.js";
import { setupCsm } from "../scene3d/csm.js";
import { windSwayGpu } from "../scene3d/vfx/components/windSwayGpu.js";
import { batchedMaterialFor } from "../scene3d/batched_material_variant.js";

let passed = 0, failed = 0;
function check(label, cond, extra = "") {
  if (cond) { passed++; console.log(`  [OK] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label} ${extra}`); }
}

/** Run `mat`'s onBeforeCompile chain on the REAL r184 standard shader text. */
function compile(mat) {
  const lib = THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}
const count = (s, needle) => s.split(needle).length - 1;
const CSM_VS = "vCsmWorldPos = _wp.xyz;";
const CSM_FS = "float _csmShadowFactor(";
const CSM_UNIFORMS = ["uCsmShadowMap0", "uCsmShadowMap1", "uCsmShadowMap2", "uCsmMatrix0", "uCsmMatrix1",
  "uCsmMatrix2", "uCsmSplits", "uCsmFar", "uCsmBlend"];
const hasCsmText = (sh) => /vCsmWorldPos|_csmSampleCascade|uCsmShadowMap/.test(sh.vertexShader + sh.fragmentShader);

const tex = new THREE.DataTexture(new Uint8Array([200, 150, 100, 255]), 1, 1);
tex.needsUpdate = true;
const swayBuilder = (m) => installVfxComponentPatch(m, windSwayGpu, windSwayGpu.defaults, VFX_GLOBALS);
const SWAY_SET = "deformation.windSwayGpu";

// The pre-change construction of each family (verbatim from materials.js
// before gpu-shading-2), with an optional hook installed right after the
// userData re-seat — where `_reinstallCloneCsm` now sits.
function oldClone(family, base, preHook) {
  const v = base.clone();
  if (family === "variant") {
    v.userData = { ...(base.userData || {}), __cacheOwned: true, __vfxSetKey: SWAY_SET, __vfxColorPassOnly: true };
  } else {
    v.userData = { ...(base.userData || {}), __cacheOwned: true };
  }
  if (preHook) preHook(v);
  if (family === "floor") applyFloorDepthBias(v);
  else if (family === "static") applyStaticDepthBias(v);
  else if (family === "baked") applyBakedVertexLightPatch(v, { suppressDirect: VERTEX_BAKE.suppressDirect });
  else if (family === "variant") { swayBuilder(v); v.needsUpdate = true; }
  return v;
}
function newClone(family, cache, did) {
  if (family === "floor") return cache.getCachedFloorBias(did);
  if (family === "static") return cache.getCachedStaticBias(did);
  if (family === "baked") return cache.getCachedCellBaked(did);
  return cache.getCachedVariant(did, SWAY_SET, "cfg", swayBuilder);
}
const FAMILIES = ["floor", "static", "baked", "variant"];
const OWN_MARK = {
  floor: (sh) => sh.fragmentShader.includes("gl_FragDepth -= 2.0e-4;"),
  static: (sh) => sh.fragmentShader.includes("gl_FragDepth -= 4.0e-4;"),
  baked: (sh) => /acBakedLight/.test(sh.vertexShader) && /uAcBakedGain/.test(sh.fragmentShader),
  variant: (sh) => sh.vertexShader.includes("VFX_WINDSWAY_BEGIN"),
};

check("precondition: vertexBake default is on (getCachedCellBaked clones)", VERTEX_BAKE.enabled === true);

// ---------------------------------------------------------------------------
console.log("\n-- D default path (no csmState): byte-identical clones ----------");
{
  const cache = new MaterialCache({});
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  check("precondition: default base carries no CSM", base.userData?.csmEnabled !== true);
  let did = 0x08000100;
  for (const fam of FAMILIES) {
    cache.materials.set(did, base);
    const v = newClone(fam, cache, did);
    const ref = oldClone(fam, base);
    const sv = compile(v), sr = compile(ref);
    check(`${fam}: program key identical (${v.customProgramCacheKey()})`,
      v.customProgramCacheKey() === ref.customProgramCacheKey(), `${v.customProgramCacheKey()} vs ${ref.customProgramCacheKey()}`);
    check(`${fam}: compiled vertex + fragment text identical`,
      sv.vertexShader === sr.vertexShader && sv.fragmentShader === sr.fragmentShader);
    check(`${fam}: same uniform set`,
      Object.keys(sv.uniforms).join(",") === Object.keys(sr.uniforms).join(","));
    check(`${fam}: userData identical`, JSON.stringify(v.userData) === JSON.stringify(ref.userData),
      `${JSON.stringify(v.userData)} vs ${JSON.stringify(ref.userData)}`);
    check(`${fam}: own-property order identical (one hidden class)`,
      Object.keys(v).join(",") === Object.keys(ref).join(","));
    check(`${fam}: no CSM text`, !hasCsmText(sv));
    check(`${fam}: own patch present`, OWN_MARK[fam](sv));
    did += 1;
  }

  // A base flagged csmEnabled without any csmState (synthetic — production
  // bases only get the flag WITH a csmState): untouched, as before.
  const cache2 = new MaterialCache({});
  const flagged = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide });
  flagged.userData = { csmEnabled: true };
  cache2.materials.set(0x08000200, flagged);
  const fb = cache2.getCachedFloorBias(0x08000200);
  const fbRef = oldClone("floor", flagged);
  check("stale csmEnabled + no csmState: key unchanged (|c2 kept, as before)",
    fb.customProgramCacheKey() === fbRef.customProgramCacheKey() && /\|c2\|/.test(fb.customProgramCacheKey()),
    fb.customProgramCacheKey());
  check("stale csmEnabled + no csmState: still no hook (nothing to bind it to)", !hasCsmText(compile(fb)));
}

// ---------------------------------------------------------------------------
console.log("\n-- C ?csm=on: a working receiver on every clone family ----------");
const sceneC = new THREE.Scene();
const csmState = setupCsm(sceneC, { sunDir: { x: 60, y: 80, z: 30 } });
{
  const cache = new MaterialCache({ csmState });
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  check("precondition: opaque base has CSM (|c2) and the default light clamp",
    base.userData?.csmEnabled === true && /\|c2\|/.test(base.customProgramCacheKey()) &&
    !!compile(base).uniforms.uLightColorClamp, base.customProgramCacheKey());
  const baseObc = base.onBeforeCompile;
  const baseText = (() => { const s = compile(base); return s.vertexShader + s.fragmentShader; })();
  let did = 0x08000300;
  for (const fam of FAMILIES) {
    cache.materials.set(did, base);
    const before = oldClone(fam, base); // what shipped: claims |c2, no hook
    check(`${fam}: (bug trigger) the old clone claims |c2 but compiles no CSM`,
      /\|c2\|/.test(before.customProgramCacheKey()) && !hasCsmText(compile(before)));
    const v = newClone(fam, cache, did);
    const sv = compile(v);
    check(`${fam}: one CSM receiver block (vertex + fragment + shade multiply)`,
      count(sv.vertexShader, CSM_VS) === 1 && count(sv.fragmentShader, CSM_FS) === 1 &&
      count(sv.fragmentShader, "gl_FragColor.rgb *= _csmAtten;") === 1);
    check(`${fam}: all nine CSM uniforms bound BY REFERENCE to csmState.uniforms`,
      CSM_UNIFORMS.every((k) => sv.uniforms[k] === csmState.uniforms[k]));
    check(`${fam}: own patch still present`, OWN_MARK[fam](sv));
    check(`${fam}: program key unchanged |c2 (now backed by the hook)`,
      v.customProgramCacheKey() === before.customProgramCacheKey(), v.customProgramCacheKey());
    // CSM ONLY: exactly the old clone plus the CSM hook first.
    const exp = oldClone(fam, base, (m) => { delete m.userData.csmEnabled; installCsmShaderPatch(m, csmState); });
    const se = compile(exp);
    check(`${fam}: text == old clone + CSM hook only (no POM / light clamp re-install)`,
      sv.vertexShader === se.vertexShader && sv.fragmentShader === se.fragmentShader);
    check(`${fam}: the light clamp stays off the clone (default look of the clone unchanged)`,
      !sv.uniforms.uLightColorClamp);
    check(`${fam}: own-property order == a plain CSM install (one hidden class)`,
      Object.keys(v).join(",") === Object.keys(exp).join(","));
    const { csmEnabled: _a, ...udNew } = v.userData;
    const { csmEnabled: _b, ...udOld } = before.userData;
    check(`${fam}: every other userData flag as the clone copied it (pomEnabled / lightClampRetail untouched)`,
      JSON.stringify(udNew) === JSON.stringify(udOld) && v.userData.csmEnabled === true);
    did += 1;
  }
  const after = compile(base);
  check("the shared base is never touched (same hook, same compiled text)",
    base.onBeforeCompile === baseObc && after.vertexShader + after.fragmentShader === baseText);
  // An additive / translucent base never gets CSM -> neither does its clone.
  const tb = cache._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, tex, undefined);
  cache.materials.set(0x08000380, tb);
  const tclone = cache.getCachedFloorBias(0x08000380);
  check("translucent base (no CSM) -> clone gets none either (|c0, no text)",
    tb.userData?.csmEnabled !== true && /\|c0\|/.test(tclone.customProgramCacheKey()) && !hasCsmText(compile(tclone)),
    tclone.customProgramCacheKey());
}

// ---------------------------------------------------------------------------
console.log("\n-- T swaying trees: shadow lookup follows the sway --------------");
{
  const cache = new MaterialCache({ csmState });
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  cache.materials.set(0x08000400, base);
  const v = cache.getCachedVariant(0x08000400, SWAY_SET, "cfg", swayBuilder);
  const vs = compile(v).vertexShader;
  const iSway = vs.indexOf("transformed.x += _wsDisp.x;");
  const iProj = vs.indexOf("#include <project_vertex>");
  const iCsm = vs.indexOf(CSM_VS);
  check("sway shear writes `transformed` before <project_vertex>, CSM reads it after",
    iSway > 0 && iSway < iProj && iProj < iCsm, `${iSway} ${iProj} ${iCsm}`);
  check("variant key: |c2 + the sway set key", /\|c2\|/.test(v.customProgramCacheKey()) &&
    v.customProgramCacheKey().includes(SWAY_SET), v.customProgramCacheKey());
  check("cached: the same variant comes back (CSM installed once)",
    cache.getCachedVariant(0x08000400, SWAY_SET, "cfg", swayBuilder) === v && count(compile(v).vertexShader, CSM_VS) === 1);
}

// ---------------------------------------------------------------------------
console.log("\n-- R re-seat follows the base -----------------------------------");
{
  const cache = new MaterialCache({ csmState });
  const D = 0x08000500;
  const fromFallback = cache.getCachedFloorBias(D); // surface not loaded yet
  check("precondition: clone built from the fallback (which carries CSM)",
    cache.fallbackMaterial.userData?.csmEnabled === true && hasCsmText(compile(fromFallback)));
  const translucent = cache._materialFromFlags(SURFACE_TYPE.Base1Image | SURFACE_TYPE.Translucent, tex, undefined);
  cache.materials.set(D, translucent);
  const v0 = fromFallback.version;
  cache._reseatVariantsForDid(D);
  check("re-seat onto a translucent (no-CSM) base: same object, key |c0, no CSM text",
    cache.getCachedFloorBias(D) === fromFallback && /\|c0\|/.test(fromFallback.customProgramCacheKey()) &&
    !hasCsmText(compile(fromFallback)), fromFallback.customProgramCacheKey());
  check("…program re-resolved (needsUpdate bumped version)", fromFallback.version > v0);
  check("…its own floor bias survives", OWN_MARK.floor(compile(fromFallback)));
  // One-way: three r184 would reuse the cached |c2 program with the |c0
  // compile's uniforms object (no uCsm* bound), so the gate never re-opens.
  const opaque = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  cache.materials.set(D, opaque);
  cache._reseatVariantsForDid(D);
  check("…one-way: a later CSM base does not re-open it (stays |c0, consistent key + text)",
    /\|c0\|/.test(fromFallback.customProgramCacheKey()) && !hasCsmText(compile(fromFallback)),
    fromFallback.customProgramCacheKey());
  // The common path: fallback-built clone re-seats onto an opaque CSM base.
  const D2 = 0x08000501;
  const fb2 = cache.getCachedFloorBias(D2);
  cache.materials.set(D2, cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined));
  cache._reseatVariantsForDid(D2);
  const s = compile(fb2);
  check("fallback-built clone re-seated onto an opaque CSM base keeps one receiver (|c2)",
    /\|c2\|/.test(fb2.customProgramCacheKey()) && count(s.vertexShader, CSM_VS) === 1 &&
    count(s.fragmentShader, CSM_FS) === 1 && OWN_MARK.floor(s), fb2.customProgramCacheKey());
}

// ---------------------------------------------------------------------------
console.log("\n-- B batched variant of a CSM clone -----------------------------");
{
  const cache = new MaterialCache({ csmState });
  const base = cache._materialFromFlags(SURFACE_TYPE.Base1Image, tex, undefined);
  cache.materials.set(0x08000600, base);
  const fb = cache.getCachedFloorBias(0x08000600);
  const bv = batchedMaterialFor(fb);
  check("precondition: a distinct batched variant was made", !!bv && bv !== fb);
  const sb = compile(bv), sf = compile(fb);
  check("batched variant: same key and the same receiver text as the clone",
    bv.customProgramCacheKey() === fb.customProgramCacheKey() &&
    sb.vertexShader === sf.vertexShader && sb.fragmentShader === sf.fragmentShader && count(sb.vertexShader, CSM_VS) === 1);
}

csmState.dispose?.();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
