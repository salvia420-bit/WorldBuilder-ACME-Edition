// tests/far_bake_shared_textures.test.mjs — the far-terrain bake rig shares the live
// terrain material's TEXTURE OBJECTS (2026-10-11).
//
// three r184's ShaderMaterial.clone() runs cloneUniforms, which gives every texture
// uniform a NEW Texture on the SAME Source (and nulls render-target textures). The
// bake clone then held its own reference on the shared WebGLTexture, so the terrain
// BC7 ladder's in-place swap (dispose + re-spec) could not re-allocate: on the 1070
// the new tier's mips went into the old immutable storage (glCompressedTexSubImage3D
// "subregion dimensions are outside of the image" / "Texture level does not exist").
//
//   S1  three's own clone behaviour (the trap this guards): a new Texture on the same
//       Source, render-target textures nulled
//   S2  shareLiveTextureUniforms re-points every non-render-target texture uniform at the
//       live object and reports how many; render-target uniforms stay as three left them
//   S3  non-texture uniforms stay independent copies (the bake still writes its own)
//   S4  ensureBakeRig calls it right after src.clone()
//
// Run: node tests/far_bake_shared_textures.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

globalThis.location = { search: "" };
globalThis.window = globalThis;

const { shareLiveTextureUniforms } = await import("../scene3d/far_terrain.js");

let failures = 0;
function t(name, fn) {
  try { fn(); console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

function liveMaterial() {
  const atlas = new THREE.CompressedArrayTexture([{ data: new Uint8Array(16 * 2), width: 4, height: 4 }], 4, 4, 2, THREE.RGBA_BPTC_Format);
  const rt = new THREE.WebGLRenderTarget(4, 4);
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uDepth: { value: rt.texture },
      uBakeAlbedo: { value: 0.0 },
      uSun: { value: new THREE.Vector3(0, 0, 1) },
      uNone: { value: null },
    },
    vertexShader: "void main() { gl_Position = vec4(0.0); }",
    fragmentShader: "void main() { gl_FragColor = vec4(1.0); }",
  });
}

// three warns once per render-target texture it nulls; keep the run quiet.
const warn = console.warn;
const quietClone = (m) => { console.warn = () => {}; try { return m.clone(); } finally { console.warn = warn; } };

t("S1 three's clone: a new Texture on the same Source, render-target textures nulled", () => {
  const src = liveMaterial();
  const c = quietClone(src);
  assert.notEqual(c.uniforms.uAtlas.value, src.uniforms.uAtlas.value);
  assert.equal(c.uniforms.uAtlas.value.source, src.uniforms.uAtlas.value.source);
  assert.equal(c.uniforms.uDepth.value, null);
});

t("S2 texture uniforms point at the live object; render-target uniforms are left alone", () => {
  const src = liveMaterial();
  const c = quietClone(src);
  const n = shareLiveTextureUniforms(c, src);
  assert.equal(n, 1);
  assert.equal(c.uniforms.uAtlas.value, src.uniforms.uAtlas.value);
  assert.equal(c.uniforms.uDepth.value, null, "the bake has always run without render targets");
  assert.equal(shareLiveTextureUniforms(c, src), 0, "idempotent");
});

t("S3 non-texture uniforms stay independent", () => {
  const src = liveMaterial();
  const c = quietClone(src);
  shareLiveTextureUniforms(c, src);
  c.uniforms.uBakeAlbedo.value = 1.0;
  c.uniforms.uSun.value.set(1, 0, 0);
  assert.equal(src.uniforms.uBakeAlbedo.value, 0.0);
  assert.deepEqual(src.uniforms.uSun.value.toArray(), [0, 0, 1]);
  assert.equal(c.uniforms.uNone.value, null);
  assert.equal(shareLiveTextureUniforms(null, src), 0);
  assert.equal(shareLiveTextureUniforms(c, {}), 0);
});

t("S4 ensureBakeRig shares the live textures right after src.clone()", () => {
  const src = readFileSync(new URL("../scene3d/far_terrain.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function ensureBakeRig("));
  const iClone = body.indexOf("const mat = src.clone();");
  const iShare = body.indexOf("shareLiveTextureUniforms(mat, src);");
  assert.ok(iClone > 0 && iShare > iClone, "shareLiveTextureUniforms(mat, src) follows src.clone()");
  assert.ok(iShare < body.indexOf("uBakeAlbedo.value = 1.0"), "before the bake writes its own values");
});

console.log(failures ? `\n[far_bake_shared_textures] ${failures} FAILED` : "\n[far_bake_shared_textures] all passed");
process.exit(failures ? 1 : 0);
