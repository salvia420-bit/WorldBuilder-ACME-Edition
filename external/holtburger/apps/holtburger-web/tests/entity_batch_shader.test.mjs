// tests/entity_batch_shader.test.mjs — R3-4 stage A `?entityBatch`: the class
// programs the entity batch compiles (scene3d/gpu_batch/entity_batch.js
// `_classOpts` over the kit's class_materials.js / row_texture.js chunks).
//
//   1. program keys: `<chain>|hbBatch1|<class>|entPart1|n0` for both member
//      chains the batch meets — the stock chain of the recolored materials
//      ("") and the cache materials' retail light clamp
//      (`hb|d0|c0|p0|l1|a0|b0|f0|s0|k0|v`) — and the live draws of a
//      batched rig carry exactly those keys (+ three's instancing bit);
//   2. `classPatchMissing({ chain })` is 0 for the stock and the real
//      light-clamp chain (every stock line the class patch replaces survives);
//   3. vertex text: main() calls the state-row setup, then the part-row setup
//      (under USE_INSTANCING), both before the first stock chunk; in the
//      program three really compiled, `#define instanceMatrix
//      hbBatchInstanceMatrix` comes before every use of `instanceMatrix`
//      (three's `attribute mat4 instanceMatrix` stays declared but unused:
//      inactive, never bound), and the part row is fetched from
//      `hbEntPartTex` by `hbEntPart`;
//   4. no backtick anywhere in the emitted vertex or fragment GLSL;
//   5. the canonical classes ({stock, light clamp} x {opaque, alphaTest} x
//      double) are registered with shader_prewarm.js once, at the first spawn.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_shader.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, EB, M } = R;
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const ASB = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const SP = await import("../scene3d/shader_prewarm.js");
const { preprocessGlsl } = await import("./helpers/fake_webgl2.mjs");
const { check, done } = R.suite("entity_batch_shader");

await check("0. the batch module exists", () => R.requireBatch());

const CLAMP = "hb|d0|c0|p0|l1|a0|b0|f0|s0|k0|v";
function member(clamp, blend = "opaque", side = THREE.DoubleSide) {
  const m = new THREE.MeshStandardMaterial({ map: CM.dummyMap(), side, roughness: 0.9 });
  if (blend === "alphaTest") m.alphaTest = 100 / 255;
  if (clamp) M.installLightClampShaderPatch(m);
  return m;
}
const eb = () => new EB.EntityBatch({ scene3d: {} }, { diagGlobal: false, env: () => ({}) });

await check("1a. program keys for the stock and the light-clamp chain", () => {
  const e = eb();
  assert.equal(ASB.memberProgramKey(member(true)), CLAMP, "the cache members' chain");
  for (const [clamp, blend, side, sideKey] of [[false, "opaque", THREE.DoubleSide, "double"], [true, "opaque", THREE.DoubleSide, "double"],
    [false, "alphaTest", THREE.DoubleSide, "double"], [true, "alphaTest", THREE.FrontSide, "front"]]) {
    const m = member(clamp, blend, side);
    const cls = ASB.memberClass(m);
    const mat = CM.makeClassMaterial(e._classOpts(m, cls, { value: null }, null));
    assert.equal(mat.customProgramCacheKey(), `${clamp ? CLAMP : ""}|hbBatch1|${blend}.lit.${sideKey}|entPart1|n0`);
  }
});

await check("1b. a batched rig's live draws use exactly those programs", async () => {
  const w = await R.world(true, { materialCache: R.materialCacheFor({ clamp: true }) });
  await w.spawn(0x50000b01);
  await w.spawn(0x50000b02, 11, 10, 0, { paletteId: 0x04000a01 });
  w.settle();
  const keys = new Set();
  for (const inst of w.em.entityMap.values()) {
    for (const mat of inst._hbBatch.mesh.material) keys.add(mat.customProgramCacheKey());
  }
  assert.deepEqual([...keys].sort(), [
    `${CLAMP}|hbBatch1|alphaTest.lit.double|entPart1|n0`, `${CLAMP}|hbBatch1|opaque.lit.double|entPart1|n0`,
    "|hbBatch1|alphaTest.lit.double|entPart1|n0", "|hbBatch1|opaque.lit.double|entPart1|n0",
  ].sort());
  const progs = w.renderer.info.programs.filter((p) => /hbBatch1/.test(p.cacheKey));
  assert.ok(progs.length >= 4);
  for (const p of progs) assert.ok(/entPart1/.test(p.cacheKey), p.cacheKey.slice(0, 80));
});

await check("2. classPatchMissing is 0 for the stock and the real light-clamp chain", () => {
  assert.equal(CM.classPatchMissing({ chain: null }), 0);
  assert.equal(CM.classPatchMissing({ chain: ASB.memberChainHook(member(true)) }), 0);
  assert.equal(CM.classPatchMissing({ chain: ASB.memberChainHook(member(true)), withNormal: true }), 0);
});

function compiledSources(w) {
  const out = [];
  for (const p of w.renderer.info.programs) {
    if (!/hbBatch1/.test(p.cacheKey) || !/entPart1/.test(p.cacheKey)) continue;
    out.push({ key: p.cacheKey, vs: w.gl.getShaderSource(p.vertexShader), fs: w.gl.getShaderSource(p.fragmentShader) });
  }
  return out;
}

await check("3. main() order, the instanceMatrix redirect before every use, the part-row fetch", async () => {
  // onBeforeCompile on three's stock physical template.
  for (const clamp of [false, true]) {
    const m = member(clamp);
    const mat = CM.makeClassMaterial(eb()._classOpts(m, ASB.memberClass(m), { value: null }, null));
    const sh = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} };
    mat.onBeforeCompile(sh, null);
    const body = sh.vertexShader.slice(sh.vertexShader.indexOf("void main() {"));
    const iSlot = body.indexOf("hbBatchSlotSetup();"), iRow = body.indexOf("hbBatchRowSetup();"), iStock = body.indexOf("#include <");
    assert.ok(iSlot > 0 && iRow > iSlot && iStock > iRow, `order slot ${iSlot} < row ${iRow} < first stock chunk ${iStock}`);
    assert.ok(/#ifdef USE_INSTANCING\s+hbBatchRowSetup\(\);/.test(body), "the row setup is guarded by USE_INSTANCING");
    assert.ok(sh.uniforms.hbEntPartTex && sh.uniforms.hbBatchStateTex && sh.uniforms.hbBatchMapArr);
  }
  // The programs three really built for a batched rig.
  const w = await R.world(true, { materialCache: R.materialCacheFor({ clamp: true }) });
  await w.spawn(0x50000b11);
  w.settle();
  const srcs = compiledSources(w);
  assert.ok(srcs.length >= 2);
  for (const { key, vs } of srcs) {
    const pp = preprocessGlsl(vs); // the active lines (USE_INSTANCING is on: an InstancedMesh)
    const lines = pp.text.split("\n").map((l) => l.trim());
    assert.equal(pp.macros.get("instanceMatrix"), "hbBatchInstanceMatrix", `${key}: the redirect is active`);
    const def = vs.indexOf("#define instanceMatrix hbBatchInstanceMatrix");
    assert.ok(def > 0, `${key}: the redirect`);
    assert.ok(lines.some((l) => /int hbR = int\( ?hbEntPart \+ 0\.5\)/.test(l) || /int hbR = int\(hbEntPart \+ 0\.5\);/.test(l)), "the part row index is hbEntPart");
    assert.ok(lines.some((l) => /texelFetch\(hbEntPartTex, ivec2\(0, hbR\), 0\)/.test(l)), "fetched from hbEntPartTex");
    const uses = [...vs.matchAll(/\binstanceMatrix\b/g)].map((m) => m.index);
    const decl = vs.indexOf("attribute mat4 instanceMatrix;");
    assert.ok(decl >= 0 && decl < def, "three's declaration precedes the define");
    for (const u of uses) {
      if (u === decl + "attribute mat4 ".length) continue;
      assert.ok(u >= def, `${key}: instanceMatrix used before the redirect at ${u}`);
    }
  }
});

await check("4. no backtick in any emitted GLSL", async () => {
  const w = await R.world(true, { materialCache: R.materialCacheFor({ clamp: true }) });
  await w.spawn(0x50000b21);
  await w.spawn(0x50000b22, 11, 10, 0, { paletteId: 0x04000a01 });
  w.settle();
  const srcs = compiledSources(w);
  assert.ok(srcs.length >= 4);
  for (const { key, vs, fs } of srcs) {
    assert.equal(vs.indexOf("`"), -1, `${key} vertex`);
    assert.equal(fs.indexOf("`"), -1, `${key} fragment`);
  }
});

await check("5. the canonical classes are registered with shader_prewarm once", async () => {
  const want = [`${CLAMP}|hbBatch1|alphaTest.lit.double|entPart1|n0`, `${CLAMP}|hbBatch1|opaque.lit.double|entPart1|n0`,
    "|hbBatch1|alphaTest.lit.double|entPart1|n0", "|hbBatch1|opaque.lit.double|entPart1|n0"];
  const w = await R.world(true);
  await w.spawn(0x50000b31);
  await w.em._entityBatch._registerCanonicalClasses();
  const keys = SP.batchClassPrewarmKeys().filter((k) => /entPart1/.test(k));
  for (const k of want) assert.ok(keys.includes(k), k);
  const n = keys.length;
  const w2 = await R.world(true);
  await w2.spawn(0x50000b32);
  await w2.em._entityBatch._registerCanonicalClasses();
  assert.equal(SP.batchClassPrewarmKeys().filter((k) => /entPart1/.test(k)).length, n, "registered once per page");
  assert.ok(SP.batchClassWarmedKeys(w2.renderer).length >= 0);
});

done();
