// Every shader portal_punch.js builds must DECLARE the log-depth names it
// uses. three r184 only adds `#define USE_LOGARITHMIC_DEPTH_BUFFER` to a
// ShaderMaterial's prefix; it declares no logDepthBufFC / vFragDepth /
// vIsPerspective. The depth-restore shader once used them undeclared, so it
// failed to compile on the first indoor frame with a doorway in view.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

const mod = await import("../scene3d/portal_punch.js");
const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);

function checkDecls(label, src) {
  // Strip comments so prose mentions don't count as uses.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const [name, decl] of [
    ["logDepthBufFC", /uniform\s+float\s+logDepthBufFC\s*;/],
    ["vFragDepth", /(varying|in|out)\s+float\s+vFragDepth\s*;/],
    ["vIsPerspective", /(varying|in|out)\s+float\s+vIsPerspective\s*;/],
  ]) {
    if (new RegExp(`\\b${name}\\b`).test(code)) {
      assert.match(code, decl, `${label}: uses ${name} without declaring it`);
    }
  }
}

test("seal, punch and depth-restore shaders declare every log-depth name they use", () => {
  globalThis.window = { location: { search: "" } };
  const shaders = [];
  for (const kind of ["punch", "seal"]) {
    const p = new mod.PortalPunchPass(null, cam, kind);
    shaders.push([`${kind}.vs`, p._punchMat.vertexShader], [`${kind}.fs`, p._punchMat.fragmentShader]);
  }
  delete globalThis.window;
  const restore = mod.__test_makeDepthRestoreMaterial?.();
  assert.ok(restore, "portal_punch.js must export __test_makeDepthRestoreMaterial");
  shaders.push(["restore.vs", restore.vertexShader], ["restore.fs", restore.fragmentShader]);
  for (const [label, src] of shaders) checkDecls(label, src);
});
