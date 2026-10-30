// tests/gpu_batch_class_materials.test.mjs — R3-3 K2: class materials and
// their shader_prewarm registration (scene3d/gpu_batch/class_materials.js,
// scene3d/shader_prewarm.js; docs/2026-10-29-round3-gpu-driven.md §R3-3 item 6).
//
// Locks:
//   1. the class space {opaque, alphaTest, translucent, additive} x {lit,
//      baked} x {front, double}: 16 keys, each with its own program key
//      ending the base key + '|hbBatch1|<class>|<hook>|n0/n1'; render state
//      per class (blend, depth write, alpha-test switch, side, additive fog
//      off); a baked class without its chain is refused;
//   2. the patch on three r184's REAL physical templates: every replaced
//      stock line is found (none silently missed), the map / normal map are
//      sampled from the array pages at the slot's layers, diffuse / opacity /
//      roughness / metalness / normal scale / alpha ref come from FLAT
//      varyings fetched once per vertex from the state table;
//   3. through three r184 + a fake WebGL2: the class program links, binds
//      the page (an ExternalTexture over the page's GL texture) as a
//      sampler2DArray and the state table as a sampler2D;
//   4. exactness of the data path: a stock MeshStandardMaterial's uniform
//      upload (diffuse, opacity, roughness, metalness, normalScale,
//      alphaTest — as the f32 the GPU receives) equals the slot row the kit
//      writes for that material, value for value;
//   5. shader_prewarm: nothing registered = nothing compiled; a registered
//      class compiles once per renderer against the warm target (composer
//      variant), its proxies stay parked (program refcount), a re-run is free;
//      a WebGL context loss + restore on the same renderer compiles it again.
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_class_materials.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

const CM = await import("../scene3d/gpu_batch/class_materials.js");
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const RT = await import("../scene3d/gpu_batch/row_texture.js");
const SP = await import("../scene3d/shader_prewarm.js");

const holders = () => ({
  mapUniform: { value: null }, normalUniform: { value: null }, stateUniform: { value: null },
});

test("1. the class space, program keys and render state per class", () => {
  const keys = CM.allClassKeys();
  assert.equal(keys.length, 16);
  assert.equal(new Set(keys).size, 16);
  for (const k of keys) assert.equal(CM.classKeyOf(CM.parseClassKey(k)), k);
  const programKeys = new Set();
  for (const k of keys) {
    const cls = CM.parseClassKey(k);
    const h = holders();
    const chain = cls.light === "baked" ? (shader) => { shader.__baked = true; } : undefined;
    for (const withNormal of [false, true]) {
      const m = CM.makeClassMaterial({ cls, ...h, normalUniform: withNormal ? h.normalUniform : null, chain, chainKey: chain ? "hb|k1" : "", vertexHookKey: "aiPose" });
      const pk = m.customProgramCacheKey();
      assert.ok(pk.includes("|hbBatch1|" + k + "|aiPose|n" + (withNormal ? 1 : 0)), pk);
      if (chain) assert.ok(pk.startsWith("hb|k1|hbBatch1"), "base chain key first, then the suffix");
      programKeys.add(pk);
      assert.equal(m.side, cls.side === "front" ? THREE.FrontSide : THREE.DoubleSide);
      assert.equal(m.alphaTest > 0, cls.blend === "alphaTest");
      assert.equal(m.transparent, cls.blend === "translucent" || cls.blend === "additive");
      assert.equal(m.depthWrite, !(cls.blend === "translucent" || cls.blend === "additive"));
      if (cls.blend === "additive") { assert.equal(m.blending, THREE.AdditiveBlending); assert.equal(m.fog, false, "retail: additive draws unfogged"); }
      if (cls.blend === "translucent") assert.equal(m.blending, THREE.NormalBlending);
      assert.ok(m.map && m.map.image.width === 1, "dummy map switches USE_MAP on");
      assert.equal(!!m.normalMap, withNormal);
    }
  }
  assert.equal(programKeys.size, 32, "every class x normal bit is its own program");
  assert.throws(() => CM.makeClassMaterial({ cls: { blend: "opaque", light: "baked", side: "double" }, ...holders() }), /baked-light chain/);
  assert.throws(() => CM.makeClassMaterial({ cls: { blend: "glow", light: "lit", side: "double" }, ...holders() }), /bad class/);
});

test("2. the patch on three r184's real physical templates", () => {
  for (const withNormal of [false, true]) {
    const shader = {
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      uniforms: {},
    };
    assert.equal(CM.applyClassPatch(shader, withNormal), 0, "every stock line found");
    const fs = shader.fragmentShader;
    const vs = shader.vertexShader;
    assert.ok(!fs.includes("#include <map_fragment>") && fs.includes("texture( hbBatchMapArr, vec3( vMapUv, vHbS2.y ) )"));
    assert.ok(fs.includes("vec4 diffuseColor = vHbS0;") && !fs.includes("vec4 diffuseColor = vec4( diffuse, opacity );"));
    assert.ok(fs.includes("if ( diffuseColor.a < vHbS2.x ) discard;") && !fs.includes("#include <alphatest_fragment>"));
    assert.ok(fs.includes("float roughnessFactor = vHbS1.x;") && fs.includes("float metalnessFactor = vHbS1.y;"));
    assert.equal(fs.includes("texture( hbBatchNrmArr, vec3( vNormalMapUv, vHbS3.x ) )"), withNormal);
    assert.equal(fs.includes("mapN.xy *= vHbS1.zw;"), withNormal);
    assert.equal(fs.includes("#include <normal_fragment_maps>"), !withNormal);
    for (const v of ["vHbS0", "vHbS1", "vHbS2", "vHbS3"]) {
      assert.ok(fs.includes(`flat varying vec4 ${v};`) && vs.includes(`flat varying vec4 ${v};`), `${v} flat in both stages`);
    }
    assert.ok(/void main\(\) \{\n  hbBatchSlotSetup\(\);/.test(vs), "one state fetch per vertex, first in main");
    assert.ok(vs.includes("texelFetch(hbBatchStateTex, ivec2(3, hbS), 0)"));
    const again = { ...shader };
    CM.applyClassPatch(again, withNormal);
    assert.equal(again.fragmentShader, fs, "idempotent");
  }
});

function rig() {
  const gl = createFakeWebGL2({});
  const canvas = fakeCanvas(gl);
  // The canvas events three listens to, so a test can lose / restore the context.
  const listeners = {};
  canvas.addEventListener = (type, fn) => { listeners[type] = fn; };
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  let lost = false;
  gl.isContextLost = () => lost;
  return {
    gl, renderer,
    loseContext() { lost = true; listeners.webglcontextlost({ preventDefault() {} }); },
    restoreContext() { lost = false; listeners.webglcontextrestored({}); },
  };
}
const tri = (extra = []) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  for (const a of extra) g.setAttribute(a, new THREE.BufferAttribute(new Float32Array(3), 1));
  return g;
};

test("3. the class program binds the page as sampler2DArray and the state table", () => {
  const { gl, renderer } = rig();
  const glTex = gl.createTexture();
  const page = new THREE.ExternalTexture(glTex);
  const nrmTex = gl.createTexture();
  const nrmPage = new THREE.ExternalTexture(nrmTex);
  const rows = new RT.RowTexture({ texelsPerRow: LS.LAYER_STATE_TEXELS, rows: 4 });
  const m = CM.makeClassMaterial({
    cls: { blend: "alphaTest", light: "lit", side: "double" },
    mapUniform: { value: page }, normalUniform: { value: nrmPage }, stateUniform: rows.uniform,
  });
  const mesh = new THREE.InstancedMesh(tri([CM.SLOT_ATTR]), m, 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  const scene = new THREE.Scene();
  scene.add(mesh);
  gl.__fake.startSnapshots();
  renderer.render(scene, new THREE.PerspectiveCamera());
  const snaps = gl.__fake.takeSnapshots();
  const draw = snaps.find((s) => s.kind === "drawArraysInstanced");
  assert.ok(draw, "drawn instanced");
  assert.equal(draw.uniforms.hbBatchMapArr, `tex#${glTex.__id}`, "the page's own GL texture");
  assert.equal(draw.uniforms.hbBatchNrmArr, `tex#${nrmTex.__id}`);
  assert.match(draw.uniforms.hbBatchStateTex, /^tex#\d+$/);
  const info = [...gl.__fake.programInfo.values()].find((p) => p.uniforms.some((u) => u.name === "hbBatchMapArr"));
  assert.equal(info.uniforms.find((u) => u.name === "hbBatchMapArr").type, gl.__fake.K.SAMPLER_2D_ARRAY);
  assert.equal(info.uniforms.find((u) => u.name === "hbBatchStateTex").type, gl.__fake.K.SAMPLER_2D);
  assert.equal(gl.__fake.unitConflicts, 0, "no texture-unit type clash");
});

test("4. the slot row holds exactly the f32 uniforms three uploads for the member", () => {
  const { gl, renderer } = rig();
  const map = new THREE.DataTexture(new Uint8Array(16), 2, 2);
  map.needsUpdate = true;
  const nrm = new THREE.DataTexture(new Uint8Array(16), 2, 2);
  nrm.needsUpdate = true;
  const members = [
    Object.assign(new THREE.MeshStandardMaterial({ map, normalMap: nrm, roughness: 0.83, metalness: 0.11, side: THREE.DoubleSide }),
      { alphaTest: 100 / 255 }),
    new THREE.MeshStandardMaterial({ map, normalMap: nrm, roughness: 0.9, metalness: 0, color: new THREE.Color(0.47, 0.47, 0.47), side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0.05, opacity: 0.7, side: THREE.DoubleSide }),
  ];
  members[0].normalScale.set(0.8, 0.8);
  members[1].normalScale.set(1.3, 0.6);
  const table = new LS.LayerStateTable(new RT.RowTexture({ texelsPerRow: LS.LAYER_STATE_TEXELS, rows: 8 }));
  for (const m of members) {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(tri(), m));
    gl.__fake.startSnapshots();
    renderer.render(scene, new THREE.PerspectiveCamera());
    const u = gl.__fake.takeSnapshots().find((s) => s.kind === "drawArrays").uniforms;
    const slot = table.addFromMaterial(m, 5, null, 2);
    const d = table.rows.data;
    const o = slot * table.rows.floatsPerRow;
    assert.deepEqual([d[o], d[o + 1], d[o + 2]], u.diffuse, "diffuse");
    assert.equal(d[o + 3], u.opacity, "opacity");
    assert.equal(d[o + 4], u.roughness, "roughness");
    assert.equal(d[o + 5], u.metalness, "metalness");
    if (m.normalMap) assert.deepEqual([d[o + 6], d[o + 7]], u.normalScale, "normalScale");
    if (m.alphaTest > 0) assert.equal(d[o + 8], u.alphaTest, "alpha-test ref");
    assert.equal(d[o + 9], 5);
    assert.equal(d[o + 12], 2);
    assert.equal(table.writeFromMaterial(slot, m, 5, 2), false, "unchanged material: no rewrite");
    m.opacity = 0.5;
    assert.equal(table.writeFromMaterial(slot, m, 5, 2), true, "a changed scalar is rewritten");
  }
});

test("5. shader_prewarm: registered classes compile once per renderer against the warm target", () => {
  const { renderer } = rig();
  const targets = [];
  const orig = renderer.setRenderTarget.bind(renderer);
  renderer.setRenderTarget = (t, ...rest) => { targets.push(t); return orig(t, ...rest); };
  const cam = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  scene.add(new THREE.DirectionalLight());
  const none = SP.prewarmBatchClasses(renderer, cam, scene);
  assert.deepEqual(none.keys, [], "nothing registered: nothing compiled");
  assert.equal(targets.length, 0);
  const rows = new RT.RowTexture({ texelsPerRow: LS.LAYER_STATE_TEXELS, rows: 4 });
  const mat = CM.makeClassMaterial({ cls: { blend: "opaque", light: "lit", side: "double" },
    mapUniform: { value: new THREE.ExternalTexture(null) }, normalUniform: null, stateUniform: rows.uniform, vertexHookKey: "test" });
  const key = mat.customProgramCacheKey();
  assert.equal(SP.registerBatchClassPrewarm(key, () => [CM.classPrewarmProxy(mat)]), true);
  assert.equal(SP.registerBatchClassPrewarm(key, () => []), false, "idempotent per key");
  assert.ok(SP.batchClassPrewarmKeys().includes(key));
  const r = SP.prewarmBatchClasses(renderer, cam, scene);
  assert.deepEqual(r.keys, [key]);
  assert.ok(r.compiled >= 1 && r.materials.has(mat));
  assert.equal(targets[0], SP.getWarmTarget(), "compiled with the warm target bound (composer variant)");
  assert.equal(targets.at(-1), null, "the previous target restored");
  assert.ok(SP.programsOf(renderer, mat).length >= 1, "the program exists and stays (parked proxy)");
  assert.ok(SP.programsOf(renderer, mat).every((p) => p.cacheKey.includes("|hbBatch1|opaque.lit.double")));
  assert.deepEqual(SP.batchClassWarmedKeys(renderer), [key]);
  targets.length = 0;
  assert.deepEqual(SP.prewarmBatchClasses(renderer, cam, scene).keys, [], "already warm: free");
  assert.equal(targets.length, 0);
  // A second renderer warms again.
  const other = rig().renderer;
  assert.deepEqual(SP.prewarmBatchClasses(other, cam, scene).keys, [key]);
  // A context loss + restore on the SAME renderer: three builds a new
  // WebGLProperties / program cache, the program is gone, so the class must
  // be compiled again (warmed = per GL context, not per renderer object).
  const r2 = rig();
  assert.deepEqual(SP.prewarmBatchClasses(r2.renderer, cam, scene).keys, [key]);
  const propsBefore = r2.renderer.properties;
  r2.loseContext();
  r2.restoreContext();
  assert.notEqual(r2.renderer.properties, propsBefore, "premise: three re-initialised its properties on restore");
  assert.equal(SP.programsOf(r2.renderer, mat).length, 0, "premise: no program on the restored context");
  assert.deepEqual(SP.batchClassWarmedKeys(r2.renderer), [], "nothing warm on the restored context");
  assert.deepEqual(SP.prewarmBatchClasses(r2.renderer, cam, scene).keys, [key], "restored context: compiled again");
  assert.ok(SP.programsOf(r2.renderer, mat).length >= 1, "the program exists on the restored context");
  assert.deepEqual(SP.prewarmBatchClasses(r2.renderer, cam, scene).keys, [], "and only once");
});
