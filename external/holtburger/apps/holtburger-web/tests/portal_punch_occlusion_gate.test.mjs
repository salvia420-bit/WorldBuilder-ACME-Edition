// tests/portal_punch_occlusion_gate.test.mjs
//
// Guards the 2026-08-13 occlusion gate on scene3d/portal_punch.js — the fix for
// "portals visible through walls".
//
// Retail never punches an unreachable portal: `PView::ConstructView`
// (acclient.c:462423-462462) seeds `cell_todo_list` from the cell the camera is
// in and grows it only through `PView::ClipPortals` (:462461), and each
// building's punch + interior are drawn inside that building's own back-to-front
// `InsCellTodoList`/`DrawCells` pass (:461917-461925, :461567). Our selection
// (`visible_portal_apertures_flat`, src/lib.rs) has no reachability and no
// building occluder, and we punch every aperture in ONE pass after the whole
// world pass — so the punch itself must carry the occlusion test.
//
// The three invariants that make that safe, each with a failure mode that has
// already cost this project a revert:
//
//  1. MARK is DEPTH-TESTED and marks only on Z-PASS. If stencilZFail were
//     anything but Keep, an occluded doorway would mark and the leak returns.
//  2. PUNCH tests stencil EQUAL with writeMask 0. A nonzero write mask would let
//     the punch edit the mark it is reading.
//  3. The gate is OPT-IN and never arms for the SEAL pass. Arming it without a
//     real stencil attachment makes the EQUAL test fail everywhere → every
//     interior vanishes, which is the 2026-08-12 regression shape exactly.

import * as THREE from "three";
import assert from "node:assert/strict";
import { PortalPunchPass } from "../scene3d/portal_punch.js";

let groups = 0;
function t(name, fn) {
  fn();
  groups++;
  console.log("  ok ", name);
}

const cam = new THREE.PerspectiveCamera();

console.log("portal_punch occlusion gate");

t("default construction leaves the gate DISABLED (legacy unconditional punch)", () => {
  const p = new PortalPunchPass(null, cam);
  assert.equal(p.occlusionGated, false);
  assert.equal(p._markMat, null);
  // The punch material must not carry a stencil test it can never satisfy.
  assert.notEqual(p._punchMat.stencilWrite, true);
});

t("stencil:false is as inert as omitting it", () => {
  const p = new PortalPunchPass(null, cam, "punch", { stencil: false });
  assert.equal(p.occlusionGated, false);
  assert.equal(p._markMat, null);
});

t("only a STRICT true arms the gate — no truthy coercion", () => {
  for (const v of [1, "on", "true", {}, []]) {
    const p = new PortalPunchPass(null, cam, "punch", { stencil: v });
    assert.equal(p.occlusionGated, false, `stencil:${JSON.stringify(v)} must not arm`);
  }
});

t("stencil:true arms the gate and builds a MARK material", () => {
  const p = new PortalPunchPass(null, cam, "punch", { stencil: true });
  assert.equal(p.occlusionGated, true);
  assert.ok(p._markMat);
});

t("INVARIANT 1 — MARK is depth-tested, marks on Z-PASS only, never writes depth", () => {
  const m = new PortalPunchPass(null, cam, "punch", { stencil: true })._markMat;
  assert.equal(m.depthTest, true, "an untested MARK marks occluded doorways");
  assert.equal(m.depthFunc, THREE.LessEqualDepth);
  assert.equal(m.depthWrite, false, "MARK must not perturb the world depth it tests");
  assert.equal(m.colorWrite, false);
  assert.equal(m.stencilWrite, true);
  assert.equal(m.stencilFunc, THREE.AlwaysStencilFunc);
  assert.equal(m.stencilZPass, THREE.ReplaceStencilOp, "visible → mark");
  assert.equal(m.stencilZFail, THREE.KeepStencilOp, "OCCLUDED → must NOT mark");
  assert.equal(m.stencilFail, THREE.KeepStencilOp);
  assert.equal(m.stencilWriteMask, 0xff);
  assert.equal(m.side, THREE.DoubleSide, "a doorway is viewed from either face");
});

t("INVARIANT 2 — PUNCH tests stencil EQUAL and never writes stencil", () => {
  const m = new PortalPunchPass(null, cam, "punch", { stencil: true })._punchMat;
  assert.equal(m.stencilWrite, true, "three needs this true to enable the TEST");
  assert.equal(m.stencilFunc, THREE.EqualStencilFunc);
  assert.equal(m.stencilWriteMask, 0x00, "the punch must not edit the mark it reads");
  assert.equal(m.stencilZPass, THREE.KeepStencilOp);
  assert.equal(m.stencilZFail, THREE.KeepStencilOp);
  assert.equal(m.stencilFail, THREE.KeepStencilOp);
});

t("the gate does NOT change the punch's retail depth behaviour", () => {
  const gated = new PortalPunchPass(null, cam, "punch", { stencil: true })._punchMat;
  const plain = new PortalPunchPass(null, cam)._punchMat;
  // retail DEPTHTEST_ALWAYS + depth write, both arms
  for (const m of [gated, plain]) {
    assert.equal(m.depthTest, true);
    assert.equal(m.depthFunc, THREE.AlwaysDepth);
    assert.equal(m.depthWrite, true);
    assert.equal(m.colorWrite, false);
  }
  // and the far-Z literal is untouched
  assert.match(gated.fragmentShader, /gl_FragDepth = 0\.99999899/);
  assert.equal(gated.fragmentShader, plain.fragmentShader);
});

t("INVARIANT 3 — the SEAL pass never gates, even when asked to", () => {
  const p = new PortalPunchPass(null, cam, "seal", { stencil: true });
  assert.equal(p.occlusionGated, false);
  assert.equal(p._markMat, null);
  // The seal runs after PView::DrawCells' Z-wipe (acclient.c:461484), so there
  // is no world depth left to test against; it writes TRUE depth, not far Z.
  assert.equal(p._punchMat.name, "portal-seal");
  assert.doesNotMatch(p._punchMat.fragmentShader, /gl_FragDepth/);
});

t("an armed pass with no apertures still reports hasApertures false", () => {
  const p = new PortalPunchPass(null, cam, "punch", { stencil: true });
  assert.equal(p.hasApertures, false);
  p.setApertures(null);
  assert.equal(p.hasApertures, false);
  p.setApertures([0]);
  assert.equal(p.hasApertures, false);
});

t("setApertures still builds geometry unchanged under the gate", () => {
  // one quad aperture: [count=1, nverts=4, 4 xyz triples]
  const flat = [1, 4, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
  for (const opts of [undefined, { stencil: true }]) {
    const p = new PortalPunchPass(null, cam, "punch", opts);
    p.setApertures(flat);
    assert.equal(p.hasApertures, true, "the gate must not change SELECTION");
    // fan triangulation of a quad → 2 tris → 6 verts
    assert.equal(p._apertureMesh.geometry.drawRange.count, 6);
  }
});

console.log(`\nportal_punch_occlusion_gate.test.mjs — ${groups} assertion groups passed`);
