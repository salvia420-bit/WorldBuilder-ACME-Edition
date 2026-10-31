// tests/interior_batch_shader.test.mjs — R3-5 `?interiorBatch` shader text
// (scene3d/gpu_batch/interior_batch.js; design §2.6-2.7, proof §6.1).
//
//   S1  the colour hook on three's stock physical templates, for every chain
//       the batch accepts (stock, light clamp, baked vertex light, static
//       depth bias — the members MaterialCache hands cells.js): EXACTLY ONE
//       collapse, right after `#include <begin_vertex>`, after the member's
//       chain and before the class patch (makeClassMaterial's order); the
//       class patch still finds all its lines; the bits header is declared
//       once.
//   S2  the programs three really built for a flag-on world (fake WebGL2
//       shaderSource capture): every interior class program declares the
//       bits sampler and the cell attribute once and collapses after the
//       resolved begin_vertex chunk; the depth programs collapse on the CAST
//       row and the base-cast bit, the alpha-tested one samples the page at
//       the slot layer and tests the slot ref.
//   S2b one alpha-tested depth material PER MAP PAGE: every alpha-tested
//       caster batch's customDepthMaterial binds that batch's own page (two
//       pages in the fixture), the opaque casters share one.
//   S3  the depth patch finds every anchor on three's MeshDepthMaterial
//       templates (opaque: no texture sample left; alpha: page + slot ref).
//   S4  program keys: distinct from stock materials, from the anim-scenery
//       classes (`aiPose`), between classes / chains / receive-shadow, and
//       the depth keys from three's stock depth material.
//   S5  no backtick, quote or apostrophe in any GLSL this module injects.
//
// Run: node tests/interior_batch_shader.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const { memberChainHook, memberProgramKey } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}
const count = (s, sub) => s.split(sub).length - 1;
const stock = () => ({ vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} });

function members() {
  const mc = new M.MaterialCache();
  const tex = adapter.surfacePixelsToTexture(new Uint8Array(8 * 8 * 4).fill(90), 8, 8);
  mc.materials.set(0x08000c01, mc._materialFromFlags(0x2, tex, undefined, null, undefined, null, { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true }));
  return {
    stock: new THREE.MeshStandardMaterial({ map: tex }),
    clamp: mc.materials.get(0x08000c01),
    baked: mc.getCachedCellBaked(0x08000c01),
    bias: mc.getCachedStaticBias(0x08000c01),
  };
}

await t("S1 the colour hook: one collapse after begin_vertex, after the member chain, before the class patch, every accepted chain", () => {
  for (const [name, m] of Object.entries(members())) {
    assert.equal(IB.interiorArrayReason(m), null, `${name} accepted`);
    for (const withNormal of [false, true]) {
      const shader = stock();
      const mat = CM.makeClassMaterial({
        cls: IB.interiorMemberClass(m), chain: memberChainHook(m), chainKey: memberProgramKey(m) || "",
        mapUniform: { value: null }, normalUniform: withNormal ? { value: null } : null, stateUniform: { value: null },
        vertexHook: (sh) => { sh.uniforms[IB.IB_BITS_SAMPLER] = { value: null }; IB.injectIbColorHook(sh); }, vertexHookKey: "ibCell1|fpx|rs1",
      });
      mat.onBeforeCompile.call(mat, shader, null);
      const vs = shader.vertexShader;
      assert.equal(count(vs, IB.IB_COLOR_COLLAPSE), 1, `${name}: exactly one collapse`);
      assert.ok(vs.includes("#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE), `${name}: right after begin_vertex`);
      assert.equal(count(vs, "bool hbIbHidden( int base )"), 1, "decode declared once");
      assert.equal(count(vs, "attribute float hbIbCell;"), 1);
      assert.ok(vs.indexOf(IB.IB_MARKER) < vs.indexOf("void main() {"), "header before main");
      if (name === "baked") {
        assert.ok(vs.indexOf(IB.IB_COLOR_COLLAPSE) < vs.indexOf("vAcBakedLight = acBakedLight;"), "the chain ran first, its varying still written");
      }
      assert.ok(shader.fragmentShader.includes("texture( hbBatchMapArr"), "the class patch ran after the hook");
      assert.ok(shader.uniforms[IB.IB_BITS_SAMPLER], "bits uniform bound");
      assert.equal(CM.classPatchMissing({ chain: memberChainHook(m), withNormal }), 0);
    }
  }
  // Idempotent / anchor-less shaders are refused, never half-patched.
  const sh = stock();
  assert.equal(IB.injectIbColorHook(sh), true);
  assert.equal(IB.injectIbColorHook(sh), false, "a second call adds nothing");
  assert.equal(count(sh.vertexShader, IB.IB_COLOR_COLLAPSE), 1);
  assert.equal(IB.injectIbColorHook({ vertexShader: "void main() {}" }), false);
});

let worldPrograms = null;
await t("S2 the programs three built for a flag-on world: colour collapse after begin_vertex, depth on CAST + base cast, the alpha page", async () => {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld({ M, adapter }, { recordShaders: true });
  await R.build(cellsOn, w);
  const st = { player: (R.LB | 0x31) >>> 0, indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] };
  const sh = R.makeSession(st);
  st.player = R.CELL(0); // indoors: interiors cast (castOn), the depth programs are used
  for (let f = 0; f < 3; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH, { shadow: true }); R.renderPass(w, R.MASK_BOTH); }
  assert.equal(IB.interiorBatchDiag().chunks.active, 1, "premise: active");
  const vsrc = w.sources.filter((s) => s.includes("void main()") && s.includes("gl_Position"));
  const colour = vsrc.filter((s) => s.includes("hbIbHidden( 0 )"));
  const depth = vsrc.filter((s) => s.includes("hbIbHidden( 16 )"));
  assert.ok(colour.length >= 4, `interior colour programs: ${colour.length}`);
  assert.ok(depth.length >= 2, `interior depth programs: ${depth.length}`);
  for (const s of colour) {
    assert.equal(count(s, "bool hbIbHidden( int base )"), 1);
    assert.equal(count(s, "in float hbIbCell;") + count(s, "attribute float hbIbCell;"), 1, "the cell attribute once");
    assert.equal(count(s, IB.IB_COLOR_COLLAPSE.trim()), 1);
    const a = s.indexOf("vec3 transformed = vec3( position );");
    const c = s.indexOf(IB.IB_COLOR_COLLAPSE.trim());
    const p = s.indexOf("vec4 mvPosition = vec4( transformed, 1.0 );");
    assert.ok(a >= 0 && a < c && c < p, "after the resolved begin_vertex, before project_vertex");
  }
  for (const s of depth) {
    assert.equal(count(s, IB.IB_DEPTH_COLLAPSE.trim()), 1);
    const a = s.indexOf("vec3 transformed = vec3( position );");
    assert.ok(a >= 0 && a < s.indexOf(IB.IB_DEPTH_COLLAPSE.trim()));
  }
  const fsrc = w.sources.filter((s) => s.includes("gl_FragColor") || s.includes("pc_fragColor") || s.includes("void main()"));
  assert.ok(fsrc.some((s) => s.includes("texture( hbIbMapArr, vec3( vMapUv, vHbIbS2.y ) )") && s.includes("if ( diffuseColor.a < vHbIbS2.x ) discard;")), "the alpha depth program samples the page at the slot layer and tests the slot ref");
  worldPrograms = IB.__interiorBatchStateForTest();
});

await t("S2b one alpha depth material per map page: every alpha-tested caster batch samples ITS page", () => {
  const S = worldPrograms;
  assert.ok(S, "premise: S2 ran");
  const alpha = [];
  for (const rec of S.lbs.values()) for (const ch of rec.chunks) for (const b of ch.batches) if (b.depthEntry && b.cls.blend === "alphaTest") alpha.push(b);
  const pages = new Set(alpha.map((b) => b.mapPage));
  assert.ok(pages.size >= 2, `premise: alpha-tested casters on ${pages.size} map pages`);
  for (const b of alpha) {
    const sh = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader, uniforms: {}, defines: {} };
    b.depthEntry.material.onBeforeCompile(sh);
    assert.ok(sh.uniforms.hbIbMapArr, "the page sampler is bound");
    assert.equal(sh.uniforms.hbIbMapArr.value, b.mapPage.gl.texture, `${b.key}: the depth material samples the batch's own page`);
    assert.equal(b.mesh.customDepthMaterial, b.depthEntry.material);
  }
  const opaque = [];
  for (const rec of S.lbs.values()) for (const ch of rec.chunks) for (const b of ch.batches) if (b.depthEntry && b.cls.blend === "opaque") opaque.push(b);
  assert.equal(new Set(opaque.map((b) => b.depthEntry)).size, 1, "every opaque caster shares the one opaque depth material");
});

await t("S3 the depth patch finds every anchor (opaque: no sample left; alpha: page + slot ref)", () => {
  assert.equal(IB.depthPatchMissing(false), 0);
  assert.equal(IB.depthPatchMissing(true), 0);
  const o = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader };
  IB.patchIbDepthShader(o, false);
  assert.ok(!o.fragmentShader.includes("#include <map_fragment>"), "opaque: the map sample is gone");
  assert.ok(o.fragmentShader.includes("#include <alphatest_fragment>"), "opaque: stock alpha test untouched");
  assert.equal(count(o.vertexShader, IB.IB_DEPTH_COLLAPSE), 1);
  const a = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader };
  IB.patchIbDepthShader(a, true);
  assert.ok(a.vertexShader.includes("void main() {\n\thbIbSlotSetup();"));
  assert.ok(!a.fragmentShader.includes("#include <alphatest_fragment>") && !a.fragmentShader.includes("#include <map_fragment>"));
  assert.equal(IB.patchIbDepthShader(a, true), 0, "idempotent");
});

await t("S4 program keys: distinct from stock, anim classes, each other; depth keys", () => {
  const S = worldPrograms;
  assert.ok(S, "premise: S2 ran");
  const entries = [...S.classMats.values()];
  const keys = entries.map((ce) => ce.material.customProgramCacheKey());
  assert.ok(keys.length >= 4);
  // Entries that share a program differ ONLY in their pages (sampler uniforms,
  // not program state): the entry key without the page ids is the program.
  const stripPages = (k) => k.split("|").filter((_, i, a) => !(i === a.length - 2 || i === a.length - 3)).join("|");
  const byProgram = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    const sp = stripPages(entries[i].key);
    if (!byProgram.has(keys[i])) byProgram.set(keys[i], new Set());
    byProgram.get(keys[i]).add(sp);
  }
  for (const [k, set] of byProgram) assert.equal(set.size, 1, `program ${k}: shared only across pages`);
  assert.ok(byProgram.size < entries.length, "premise: the fixture has two pages of one class (shared program)");
  for (const k of keys) {
    assert.ok(k.includes(CM.CLASS_KEY_SUFFIX) && k.includes("|ibCell1|fp"), k);
    assert.ok(!k.includes("aiPose"), "never an anim-scenery class key");
  }
  const mem = members();
  for (const m of Object.values(mem)) assert.ok(!keys.includes(typeof m.customProgramCacheKey === "function" ? m.customProgramCacheKey() : ""), "never a member key");
  // Two class materials that differ only in chain fingerprint / receive shadow differ in key.
  const mk = (fp, rs) => CM.makeClassMaterial({ cls: { blend: "opaque", light: "lit", side: "double" }, mapUniform: { value: null }, stateUniform: { value: null }, vertexHook: () => {}, vertexHookKey: `ibCell1|fp${fp}|rs${rs}` }).customProgramCacheKey();
  assert.equal(new Set([mk("a", 1), mk("b", 1), mk("a", 0)]).size, 3);
  const dk = [...S.depthMats.values()].map((d) => d.material.customProgramCacheKey());
  assert.ok(dk.every((k) => k.startsWith(IB.IB_DEPTH_KEY_PREFIX)));
  assert.ok(dk.includes(IB.IB_DEPTH_KEY_PREFIX + "opaque") && dk.includes(IB.IB_DEPTH_KEY_PREFIX + "alphaTest"));
  assert.ok(!dk.includes(new THREE.MeshDepthMaterial().customProgramCacheKey()), "not the stock depth key");
  IB.disposeInteriorBatches();
});

await t("S5 no backtick, quote or apostrophe in any injected GLSL", () => {
  const anchors = { vertexShader: "#include <begin_vertex>\nvoid main() {", fragmentShader: "#include <map_fragment>\n#include <alphatest_fragment>" };
  const injected = [IB.ibVertexHeader(), IB.IB_COLOR_COLLAPSE, IB.IB_DEPTH_COLLAPSE];
  for (const alpha of [false, true]) {
    const s = { ...anchors };
    IB.patchIbDepthShader(s, alpha);
    injected.push(s.vertexShader, s.fragmentShader);
  }
  const c = { vertexShader: "#include <begin_vertex>\nvoid main() {" };
  IB.injectIbColorHook(c);
  injected.push(c.vertexShader);
  for (const g of injected) assert.ok(!/[`'"]/.test(g), `forbidden character in: ${g.slice(0, 120)}`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
