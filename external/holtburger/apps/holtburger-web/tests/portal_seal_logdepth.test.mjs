// tests/portal_seal_logdepth.test.mjs
//
// The indoor portal SEAL (scene3d/portal_punch.js::makeSealMaterial) must write
// its doorway depth wall in the renderer's OWN depth space. The renderer runs
// `logarithmicDepthBuffer: true`; a bespoke ShaderMaterial without three's
// logdepthbuf chunks writes PERSPECTIVE gl_FragCoord.z instead, so the wall sits
// at the wrong depth for every interior cell / particle that tests against it.
//
// Pinned here (module level, the real PortalPunchPass, no browser):
//   1. a BARE URL (and node, no window) builds a seal whose fragment shader
//      writes the log gl_FragDepth and whose vertex shader feeds vFragDepth —
//      FAILS on the pre-fix code, where the fix was opt-in `=== "on"`.
//   2. `?sealLogDepth=off` is the escape: no gl_FragDepth write at all
//      (byte-identical to the old seal).
//   3. the PUNCH material is untouched (constant FAR_DEPTH write, no log chunk).
//
// Run: node tests/portal_seal_logdepth.test.mjs

import * as THREE from "three";
import assert from "node:assert/strict";
import { PortalPunchPass, sealLogDepthEnabled } from "../scene3d/portal_punch.js";

let groups = 0;
function t(name, fn) {
  fn();
  groups++;
  console.log("  ok ", name);
}
const cam = new THREE.PerspectiveCamera();
const LOG_WRITE = /gl_FragDepth\s*=\s*vIsPerspective\s*==\s*0\.0\s*\?\s*gl_FragCoord\.z\s*:\s*log2\(\s*vFragDepth\s*\)\s*\*\s*logDepthBufFC\s*\*\s*0\.5/;

console.log("portal seal log-depth");

t("node / no window: sealLogDepthEnabled() defaults OFF (opt-in since the wave-1 critic)", () => {
  delete globalThis.window;
  assert.equal(sealLogDepthEnabled(), false);
});

t("?sealLogDepth=on seal writes the three r184 log gl_FragDepth, first in main()", () => {
  globalThis.window = { location: { search: "?sealLogDepth=on" } };
  const p = new PortalPunchPass(null, cam, "seal");
  delete globalThis.window;
  const fs = p._punchMat.fragmentShader;
  const vs = p._punchMat.vertexShader;
  assert.match(fs, LOG_WRITE, "fragment must write log depth");
  assert.match(fs, /uniform float logDepthBufFC;/);
  const body = fs.slice(fs.search(/void\s+main\s*\(\s*\)\s*\{/));
  assert.ok(body.indexOf("gl_FragDepth") >= 0 && body.indexOf("gl_FragDepth") < body.indexOf("_c = vec4(0.0)"),
    "gl_FragDepth must precede the colour write");
  assert.match(vs, /vFragDepth = 1\.0 \+ gl_Position\.w;/);
  assert.ok(vs.indexOf("vFragDepth = 1.0 + gl_Position.w") > vs.indexOf("gl_Position = projectionMatrix"),
    "vFragDepth must be written after gl_Position is final");
  // Guarded on three's own define so a non-log renderer compiles the old shader.
  assert.match(fs, /#if defined\( USE_LOGARITHMIC_DEPTH_BUFFER \)/);
  // The seal's raster state is unchanged.
  assert.equal(p._punchMat.depthFunc, THREE.AlwaysDepth);
  assert.equal(p._punchMat.depthWrite, true);
  assert.equal(p._punchMat.colorWrite, false);
  assert.ok(p._punchMat.isShaderMaterial && !p._punchMat.isRawShaderMaterial,
    "must stay a non-raw ShaderMaterial (Raw gets no USE_LOGARITHMIC_DEPTH_BUFFER define)");
});

t("only ?sealLogDepth=on arms it; bare URL and other values leave it off", () => {
  for (const q of ["", "?sealLogDepth=off", "?sealLogDepth=1", "?foo=bar"]) {
    globalThis.window = { location: { search: q } };
    assert.equal(sealLogDepthEnabled(), false, `search ${JSON.stringify(q)}`);
  }
  globalThis.window = { location: { search: "?sealLogDepth=on" } };
  assert.equal(sealLogDepthEnabled(), true);
  delete globalThis.window;
});

t("default seal: the pre-fix perspective seal (no gl_FragDepth write)", () => {
  delete globalThis.window;
  const p = new PortalPunchPass(null, cam, "seal");
  delete globalThis.window;
  assert.doesNotMatch(p._punchMat.fragmentShader, /gl_FragDepth/);
  assert.doesNotMatch(p._punchMat.vertexShader, /vFragDepth/);
});

t("PUNCH material is unaffected (constant FAR write, no log chunk)", () => {
  const p = new PortalPunchPass(null, cam, "punch");
  assert.match(p._punchMat.fragmentShader, /gl_FragDepth = 0\.99999899;/);
  assert.doesNotMatch(p._punchMat.fragmentShader, /vFragDepth/);
});

console.log(`portal seal log-depth: ${groups} groups ok`);
