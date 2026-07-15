// Regression test for RETAIL CULL PARITY on surfaces — `?surfaceSinglePass`
// (2026-07-15).
//
// THE BUG. three r184 submits a material TWICE — BackSide then FrontSide, with a
// `needsUpdate` program re-resolve between them — when
//     transparent === true && side === DoubleSide && forceSinglePass === false
// (three.module.js:18065 `renderObject`; same branch at :17280
// `prepareMaterial`). Every surface material built here is DoubleSide, so every
// TRANSLUCENT one was drawn — and, more expensively, SHADED — twice.
//
// Retail does not do this. Its per-polygon path picks ONE cull mode and issues
// ONE draw (`D3DPolyRender::DrawPolyInternal`, acclient.c:455306):
//     if ( override_cull_state_0 || p->sides_type == 1 )
//         SetCullMode(CULLMODE_NONE);      // two-sided -> cull nothing
//     else
//         SetCullMode(CULLMODE_CW);
//     ... DrawPrimitiveUP(D3DPT_TRIANGLEFAN, ...)    // once
// So the single pass is the PARITY behaviour; the two-pass is our deviation.
// Measured worth: -11% draws / +45% fps at a settled Holtburg (the fps win is
// FILL, not call count, so it scales with translucent screen coverage — see the
// url-flags row; it is ~0 where nothing translucent is in frame).
//
// WHAT THIS GUARDS, and why each guard exists:
//   1. a Translucent surface material comes out single-pass by DEFAULT (the flag
//      is default-ON, so absence of the param must NOT disable it — the
//      documented flag footgun, inverted: for a default-ON flag only `=== "off"`
//      may disable)
//   2. three's double-submit predicate is FALSE for it — the actual behaviour,
//      computed with three's own condition rather than our belief about it
//   3. `?surfaceSinglePass=off` really restores the two-pass (an escape hatch
//      that does not escape is worse than no flag, because it invites "just turn
//      it off" as a rollback that silently does nothing)
//   4. it does NOT touch OPAQUE materials (they never met three's condition; if
//      this started flipping them it would be a no-op today and a trap the day
//      someone makes them transparent)
//   5. it leaves `side`/`transparent` ALONE — the fix must drop the second
//      SUBMIT, not the two-sidedness. Turning a surface FrontSide would also
//      make guards 1+2 pass while dropping real fragments retail draws
//      (CULLMODE_NONE means cull NOTHING).
//
// Per the handoff rule "a regression test can be GREEN ON BROKEN SOURCE — always
// run it against the bug", this WAS run against pre-fix source: 0 passed, 3
// failed, each naming the absent export rather than throwing. (The pre-fix tree
// has no flag at all, so the honest pre-fix signal is "not implemented", not a
// per-guard diff — see the `withSearch` bail.)
//
// Run from apps/holtburger-web/:  node test_surface_single_pass.mjs

import * as THREE from "three";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++; else failed++;
}

// three r184's EXACT double-submit condition (three.module.js:18065). Written as
// three writes it, so this test tracks three's behaviour, not our reading of it.
const submitsPerFrame = (m) =>
  (m.transparent === true && m.side === THREE.DoubleSide && m.forceSinglePass === false) ? 2 : 1;

// The bit that makes a surface transparent, and therefore double-submitted.
// Imported from the module rather than hardcoded: a first cut of this test
// guessed 0x4 (that is Base1ClipMap, which decodes to transparent=FALSE +
// alphaTest) and its "translucent" material was never transparent at all — at
// which point guard 2 passed VACUOUSLY, since a non-transparent material trivially
// submits once. The preconditions below caught it; the import removes the class.
const { SURFACE_TYPE } = await import("./scene3d/materials.js");
const TRANSLUCENT = SURFACE_TYPE.Translucent; // 0x10

async function withSearch(search, fn) {
  // The flag readers memoize at MODULE scope on first call, so each arm needs a
  // fresh module registry — hence the cache-busting query on the import specifier.
  // They also read BARE `location.search` (= globalThis.location, which node does
  // not define): unset, it throws, the catch fires, and the arm silently lands on
  // the DEFAULT instead of on what we asked for.
  globalThis.window = globalThis.window || {};
  globalThis.location = { search };
  window.location = globalThis.location;
  const mod = await import(`./scene3d/materials.js?arm=${encodeURIComponent(search)}`);
  // Pre-fix source has no flag AT ALL. Report that as a legible failure rather
  // than dying with "surfaceSinglePassEnabled is not a function" — a test whose
  // "fails on the bug" evidence is a TypeError is not showing you the bug, and
  // the run-against-the-bug rule is worth nothing if the output is a stack trace.
  if (typeof mod.surfaceSinglePassEnabled !== "function" || typeof mod.applyRetailSinglePass !== "function") {
    check(`retail single-pass parity is IMPLEMENTED (arm "${search || "<default>"}")`, false,
      "materials.js exports no surfaceSinglePassEnabled/applyRetailSinglePass — every translucent surface is still double-submitted");
    return null;
  }
  return fn(mod);
}

// A DoubleSide material as every surface factory builds one, pre-decode.
const freshMat = () => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, transparent: false });

async function run() {
  // ---- 1 + 2 + 5: default (no param at all) --------------------------------
  await withSearch("", ({ applySurfaceRenderState, surfaceSinglePassEnabled }) => {
    check("precondition: flag defaults ON when the param is absent",
      surfaceSinglePassEnabled() === true, `enabled=${surfaceSinglePassEnabled()}`);

    const mat = freshMat();
    applySurfaceRenderState(mat, { flags: TRANSLUCENT, translucency: 0.5 }, {});
    // Precondition: the decoder really did make it transparent. Without this the
    // guards below could pass over a material that never met three's condition —
    // green for the wrong reason.
    check("precondition: a Translucent surface decodes to transparent+DoubleSide",
      mat.transparent === true && mat.side === THREE.DoubleSide,
      `transparent=${mat.transparent} side=${mat.side === THREE.DoubleSide ? "DoubleSide" : mat.side}`);

    check("1. default: a translucent surface is single-pass",
      mat.forceSinglePass === true, `forceSinglePass=${mat.forceSinglePass}`);
    check("2. default: three's double-submit predicate is FALSE",
      submitsPerFrame(mat) === 1, `submits/frame=${submitsPerFrame(mat)} (2 = the bug)`);
    check("5. side is untouched — drop the second SUBMIT, not the second SIDE",
      mat.side === THREE.DoubleSide, `side=${mat.side === THREE.DoubleSide ? "DoubleSide" : mat.side}`);
    check("5. transparent is untouched", mat.transparent === true, `transparent=${mat.transparent}`);

    // ---- 4: opaque surfaces are not touched --------------------------------
    const opaque = freshMat();
    applySurfaceRenderState(opaque, { flags: 0, translucency: 0 }, {});
    check("4. an OPAQUE surface is left alone (never met three's condition)",
      opaque.transparent === false && opaque.forceSinglePass === false,
      `transparent=${opaque.transparent} forceSinglePass=${opaque.forceSinglePass}`);
  });

  // ---- 3: the escape hatch actually escapes --------------------------------
  await withSearch("?surfaceSinglePass=off", ({ applySurfaceRenderState, surfaceSinglePassEnabled }) => {
    check("precondition: ?surfaceSinglePass=off reads as disabled",
      surfaceSinglePassEnabled() === false, `enabled=${surfaceSinglePassEnabled()}`);
    const mat = freshMat();
    applySurfaceRenderState(mat, { flags: TRANSLUCENT, translucency: 0.5 }, {});
    check("3. =off restores three's two-pass",
      mat.forceSinglePass === false && submitsPerFrame(mat) === 2,
      `forceSinglePass=${mat.forceSinglePass} submits/frame=${submitsPerFrame(mat)}`);
  });

  // ---- the footgun: a bogus value must NOT disable a default-ON flag -------
  await withSearch("?surfaceSinglePass=1", ({ surfaceSinglePassEnabled }) => {
    check("footgun: only `=off` disables — any other value keeps the default ON",
      surfaceSinglePassEnabled() === true, `?surfaceSinglePass=1 -> enabled=${surfaceSinglePassEnabled()}`);
  });

  console.log(`\n[test_surface_single_pass] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
