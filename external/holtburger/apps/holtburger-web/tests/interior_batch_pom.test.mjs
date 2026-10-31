// tests/interior_batch_pom.test.mjs — POM members of `?interiorBatch`
// (scene3d/gpu_batch/interior_batch.js "POM MEMBERS"; the kit side:
// class_materials.js "POM MEMBERS", layer_state.js POM extension rows,
// array_pages.js R8 planes). Realboot keys (Holtburg, ultra, 2026-10-31):
// 823 of 1008 cell materials carry `|p1|`; every member below is built by
// materials.js's OWN POM installer (the MaterialCache ladder at `pomEnabled`,
// or installPomShaderPatch), never a hand-made stand-in.
//
//   P1  the kit's POM extension rows: packLayerState carries the extension
//       row index in texel 3 .y (0 when not given: every existing call writes
//       what it wrote), packPomState / unpackPomState lay the seven scalars
//       out as documented (the two ints as uniform1i's ToInt32), the table
//       adds / rewrites / frees them; the row fields are exactly the uniforms
//       the real patch declares.
//   P2  R8 planes in kit pages: OPT-IN (an R8 texture without R8_PLANES is
//       still refused); the descriptor of adapter.js's height plane; the GL
//       stream of an admit: three's OWN upload of the 2D R8 texture
//       (texStorage2D R8 + texSubImage2D of the very bytes + generateMipmap),
//       R8 array storage with the full chain, one framebufferTexture2D +
//       copyTexSubImage3D per level from that 2D texture into the layer, the
//       2D texture's sampler state on the page, never a re-mip of the array.
//   P3  eligibility: a real POM chain (base material) is accepted with its
//       dry run's POM verdict (the very height texture, the scalars
//       materials.js recorded); the fingerprint leaves POM values out (two
//       depths, one class); flag-only p1 clones (static bias, cell baked) are
//       accepted with no POM, key as the p0 chain they run and share the p0
//       family's fingerprint; no normal map / a mangled POM text / a non-POM
//       texture uniform still refuse.
//   P4  the class program equals the member's program MODULO the documented
//       substitutions (P1-P4, the class patch, the cell-bit hook): every one
//       of them undone on the class text gives the member's text back,
//       vertex and fragment, byte for byte; the uniform sets differ by
//       exactly the POM uniforms out and the kit samplers in; the key gains
//       `|pom1`; the member's live uniform handle is untouched.
//   P5  a flag-on POM world (three r184 + the recording fake WebGL2; cells
//       drawn with the POM base materials, props with flag-only p1 clones):
//       the chunk goes active with POM slots; each POM slot's extension row
//       equals the uniforms three bound for that member's LEGACY draw (the
//       fake GL's draw snapshot), its height layer is a per-level copy of the
//       very 2D texture the legacy draw bound to uPomMap; the class draws
//       bind the height page and no uPomMap; the POM text three compiled for
//       the class (march, self-shadow, the POM block) equals the legacy
//       program's modulo P2-P4; the flag-only props batch as p0.
//   P6  drift + release: a height re-upload re-plans (texture cap, once the
//       swap settled: interior_batch.js "TEXTURE SWAPS") onto a fresh copy;
//       dispose frees every POM extension row and height layer.
//   P7  the extra-map census (`stats().extraMaps`): a member refused for an
//       extra map (a light map next to its texchan planes, materials.js
//       _applyRough: aoMap + roughnessMap, which batch since 2026-10-31) is
//       counted by its WHOLE extra-map set, not only the one the reason names.
//
// Each check fails on the pre-change tree (no POM rows / R8 pages / POM
// class; `p1` refused as "shader-chain").
//
// Run: node tests/interior_batch_pom.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";
import { createFakeWebGL2, fakeCanvas } from "./helpers/fake_webgl2.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { memberChainHook, memberProgramKey } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}
const count = (s, sub) => s.split(sub).length - 1;
const stock = () => ({ vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} });
const F = Math.fround;
const FLOATS = { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true };
const POM_NAMES = ["uPomMap", "uPomSteps", "uPomDepth", "uPomLodNear", "uPomLodFar", "uPomShadowSteps", "uPomShadowDarkness", "uPomGraze"];

function tex(w = 16, h = 16, seed = 1) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 29 + seed) & 255;
  return adapter.surfacePixelsToTexture(px, w, h);
}
const nrm = (w = 16, h = 16) => adapter.surfacePixelsToNormalTexture(new Uint8Array(w * h * 3).fill(128), w, h);
const hgt = (w = 16, h = 16, seed = 0) => adapter.surfacePixelsToHeightTexture(R.heightPixels(w, h, seed), w, h);

/** A MaterialCache at `pomEnabled` with one Stone surface (its base gets materials.js's POM patch + light clamp). */
function pomCache(flags = 0x2) {
  const mc = new M.MaterialCache({ pomEnabled: true });
  const h = hgt();
  const base = mc._materialFromFlags(flags, tex(), M.SURFACE_CATEGORY.Stone, nrm(), undefined, h, FLOATS);
  mc.materials.set(0x08000c01, base);
  return { mc, base, h, did: 0x08000c01 };
}

// ---------------------------------------------------------------------------

await t("P1 the kit's POM extension rows: texel 3 .y, the documented layout, add / rewrite / free", () => {
  const st = LS.layerStateFromMaterial(new THREE.MeshStandardMaterial({ color: 0x806040, roughness: 0.7 }));
  const a = LS.packLayerState(st, 3, new Float32Array(16), 0, 2, 9);
  assert.equal(a[12], 2, "normal layer");
  assert.equal(a[13], 9, "the extension row rides texel 3 .y");
  const b = LS.packLayerState(st, 3, new Float32Array(16).fill(7), 0, 2);
  assert.equal(b[13], 0, "no extension row given: 0 (every existing call writes what it wrote)");
  assert.equal(LS.unpackLayerState(a, 0).extRow, 9);
  const p = { layer: 4, depth: 0.08, steps: 16.7, shadowSteps: 8, lodNear: 5, lodFar: 10, shadowDarkness: 0.5, graze: 1 };
  const out = LS.packPomState(p, new Float32Array(16).fill(3), 0);
  assert.deepEqual(Array.from(out), [4, F(0.08), 16, 8, 5, 10, 0.5, 1, 0, 0, 0, 0, 0, 0, 0, 0], "texel 0 (layer, depth, steps, shadow steps), texel 1 (LOD near / far, darkness, graze), the rest zero");
  assert.equal(LS.packPomState({ ...p, steps: -2.5 }, new Float32Array(16), 0)[2], -2, "the ints as uniform1i converts them (ToInt32)");
  assert.deepEqual(LS.unpackPomState(out, 0), { layer: 4, depth: F(0.08), steps: 16, shadowSteps: 8, lodNear: 5, lodFar: 10, shadowDarkness: 0.5, graze: 1 });
  // The row fields are exactly the scalars the real patch declares.
  const m = new THREE.MeshStandardMaterial({ map: tex() });
  M.installPomShaderPatch(m, hgt(), {});
  const sh = stock();
  memberChainHook(m).call(new THREE.MeshStandardMaterial(), sh, null);
  const declared = Object.keys(sh.uniforms).filter((n) => n.startsWith("uPom")).sort();
  assert.deepEqual(declared, [...POM_NAMES].sort(), "materials.js's POM uniforms");
  assert.deepEqual(Object.keys(LS.POM_STATE_FIELDS).sort(), POM_NAMES.filter((n) => n !== "uPomMap").sort(), "one row field per scalar");
  assert.deepEqual(CM.POM_UNIFORMS.map(([n]) => n), POM_NAMES, "the class patch knows the same eight, in the patch's order");
  // The table.
  KIT.resetKit();
  const table = KIT.kitStateTable();
  const pr = table.addPom(p, null);
  assert.ok(pr > 0);
  const slot = table.addFromMaterial(m, 3, null, 2, pr);
  const base = (r) => r * table.rows.floatsPerRow;
  assert.equal(LS.unpackLayerState(table.rows.data, base(slot)).extRow, pr);
  assert.deepEqual(LS.unpackPomState(table.rows.data, base(pr)), LS.unpackPomState(out, 0));
  assert.equal(table.writePom(pr, p), false, "unchanged: no store, no upload");
  assert.equal(table.writePom(pr, { ...p, depth: 0.05 }), true);
  assert.equal(table.writeFromMaterial(slot, m, 3, 2, pr), false, "the extension index kept by a rewrite that passes it");
  table.remove(pr);
  table.remove(slot);
  assert.equal(table.rows._next - 1 - table.rows._free.length, 0, "every row back");
  KIT.resetKit();
});

function glRig() {
  const calls = [];
  const gl = createFakeWebGL2({ onCall: (name, args) => calls.push([name, Array.from(args)]) });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  return { gl, calls, renderer };
}

/** Walk a recorded GL stream: every copyTexSubImage3D with the READ attachment and the 2D-array binding in force. */
function copiesOf(calls, gl) {
  let read = null, readLevel = -1, arr = null;
  const out = [];
  for (const [n, a] of calls) {
    if (n === "framebufferTexture2D" && a[0] === gl.READ_FRAMEBUFFER) { read = a[3]; readLevel = a[4]; }
    else if (n === "bindTexture" && a[0] === gl.TEXTURE_2D_ARRAY) arr = a[1];
    else if (n === "copyTexSubImage3D") out.push({ src: read, srcLevel: readLevel, dst: arr, level: a[1], layer: a[4], w: a[7], h: a[8] });
  }
  return out;
}

await t("P2 R8 planes in kit pages: opt-in, the height plane's descriptor, three's own upload + a per-level GPU copy", () => {
  const h = hgt(32, 16, 3);
  assert.equal(AP.describeTexture(h), null, "without R8_PLANES an R8 texture is refused as before (an R8 MAP stays map-format)");
  const d = AP.describeTexture(h, AP.R8_PLANES);
  assert.deepEqual({ ...d }, {
    format: "r8", levels: PA.fullMipLevels(32, 16), width: 32, height: 16, colorSpace: THREE.NoColorSpace,
    wrapS: h.wrapS, wrapT: h.wrapT, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: h.anisotropy || 1,
  });
  const srgb = hgt(32, 16); srgb.colorSpace = THREE.SRGBColorSpace;
  const flt = new THREE.DataTexture(new Float32Array(4), 2, 2, THREE.RedFormat, THREE.FloatType);
  assert.equal(AP.describeTexture(srgb, AP.R8_PLANES), null, "sRGB R8: refused");
  assert.equal(AP.describeTexture(flt, AP.R8_PLANES), null, "float R: refused");
  assert.notEqual(PA.pageKeyOf(d), PA.pageKeyOf(AP.describeTexture(tex(32, 16))), "never an RGBA8 page");
  // The GL stream of one admit.
  const { gl, calls, renderer } = glRig();
  const pages = new AP.ArrayPages(renderer, { pageBytes: 1, minLayers: 4, maxLayers: 4 });
  calls.length = 0;
  assert.equal(pages.admit(h, null), null, "admit without the option: refused (no GL)");
  const r = pages.admit(h, null, AP.R8_PLANES);
  assert.ok(r && !r.deferred && r.page.desc.format === "r8", JSON.stringify(r && r.page.desc));
  const src = renderer.properties.get(h).__webglTexture;
  assert.ok(src, "three uploaded the 2D plane itself");
  const s2 = calls.find((c) => c[0] === "texStorage2D");
  assert.deepEqual(s2[1], [gl.TEXTURE_2D, d.levels, gl.R8, 32, 16], "texStorage2D(TEXTURE_2D, full chain, R8): the legacy allocation");
  const up = calls.find((c) => c[0] === "texSubImage2D");
  assert.deepEqual(up[1].slice(0, 8), [gl.TEXTURE_2D, 0, 0, 0, 32, 16, gl.RED, gl.UNSIGNED_BYTE], "level 0 as RED / UNSIGNED_BYTE");
  assert.deepEqual(Array.from(up[1][8]), Array.from(R.heightPixels(32, 16, 3)), "the very height bytes (three's own upload, the legacy draw's)");
  const gm = calls.filter((c) => c[0] === "generateMipmap");
  assert.equal(gm.length, 1);
  assert.equal(gm[0][1][0], gl.TEXTURE_2D, "the driver's mips, on the 2D plane");
  const s3 = calls.find((c) => c[0] === "texStorage3D");
  assert.deepEqual(s3[1], [gl.TEXTURE_2D_ARRAY, d.levels, gl.R8, 32, 16, 4], "R8 array storage, the same full chain");
  const copies = copiesOf(calls, gl);
  assert.equal(copies.length, d.levels);
  copies.forEach((c, l) => {
    const [lw, lh] = PA.levelSize(32, 16, l);
    assert.deepEqual({ ...c }, { src, srcLevel: l, dst: r.page.gl.tex, level: l, layer: r.layer, w: lw, h: lh }, `level ${l}: the 2D plane's level l into (layer, l)`);
  });
  assert.ok(calls.findIndex((c) => c[0] === "generateMipmap") < calls.findIndex((c) => c[0] === "copyTexSubImage3D"), "mips before the first copy");
  assert.equal(calls.filter((c) => c[0] === "texSubImage3D" || c[0] === "texImage3D" || (c[0] === "generateMipmap" && c[1][0] === gl.TEXTURE_2D_ARRAY)).length, 0, "never a re-mip / re-upload of the array");
  const p3 = calls.filter((c) => c[0] === "texParameteri" && c[1][0] === gl.TEXTURE_2D_ARRAY).map((c) => [c[1][1], c[1][2]]);
  for (const p of calls.filter((c) => c[0] === "texParameteri" && c[1][0] === gl.TEXTURE_2D).map((c) => [c[1][1], c[1][2]])) {
    assert.ok(p3.some((q) => q[0] === p[0] && q[1] === p[1]), `2D sampler state ${p} mirrored on the page`);
  }
  // Resident: no GL at all; the content key is the texture's identity.
  calls.length = 0;
  const r2 = pages.admit(h, null, AP.R8_PLANES);
  assert.equal(r2.layer, r.layer);
  assert.equal(r2.contentKey, AP.contentKeyOf(h));
  assert.deepEqual(calls.map((c) => c[0]).filter((n) => n !== "isContextLost"), []);
  pages.dispose();
});

await t("P3 eligibility of materials.js's own POM members: the real chain, flag-only clones, the refusals", () => {
  const { mc, base, h, did } = pomCache();
  assert.match(memberProgramKey(base), /\|p1\|/, "premise: the base's key says p1");
  assert.ok(base.userData.pomEnabled === true && base.normalMap, "premise: materials.js installed POM (normal map present)");
  assert.equal(IB.interiorArrayReason(base), null, "a p1 key passes the chain-key gate");
  const fp = IB.chainFingerprintId(base);
  assert.ok(fp.id && fp.pom && fp.pom.pom === true, `fingerprinted with a POM verdict: ${JSON.stringify(fp && { id: fp.id, reason: fp.reason })}`);
  assert.equal(fp.pom.texture, h, "the very height texture the chain binds");
  const u = base.userData.pomUniforms;
  assert.deepEqual(fp.pom.values, {
    steps: u.steps, depth: u.depth, lodNear: u.lodNear, lodFar: u.lodFar, shadowSteps: u.shadowSteps, shadowDarkness: u.shadowDarkness,
    graze: M.pomGrazeEnabled() ? 1 : 0,
  }, "the scalars materials.js recorded (+ the graze switch its compile reads)");
  assert.equal(IB.interiorPomReason(base, fp.pom), null);
  // POM values are slot data: another depth, the same class fingerprint.
  const a = new THREE.MeshStandardMaterial({ map: tex(), normalMap: nrm() });
  const b = new THREE.MeshStandardMaterial({ map: tex(), normalMap: nrm() });
  M.installPomShaderPatch(a, hgt(), { depth: 0.08, steps: 16 });
  M.installPomShaderPatch(b, hgt(16, 16, 5), { depth: 0.05, steps: 12 });
  assert.equal(IB.chainFingerprintId(a).id, IB.chainFingerprintId(b).id, "two depths / step counts / height maps: one fingerprint");
  assert.ok(IB.chainFingerprint(a).fp.includes("uPomDepth=slot") && IB.chainFingerprint(a).fp.includes("uPomMap=slot"));
  // Flag-only p1: the clone families cells.js draws with.
  const mc0 = new M.MaterialCache();
  mc0.materials.set(did, mc0._materialFromFlags(0x2, tex(), M.SURFACE_CATEGORY.Stone, nrm(), undefined, null, FLOATS));
  for (const fam of ["getCachedStaticBias", "getCachedCellBaked"]) {
    const clone = mc[fam](did);
    const plain = mc0[fam](did);
    assert.match(memberProgramKey(clone), /\|p1\|/, `${fam}: premise, the clone's key copied p1`);
    assert.equal(IB.interiorArrayReason(clone), null, `${fam}: accepted`);
    const cf = IB.chainFingerprintId(clone);
    assert.ok(cf.id && cf.pom && cf.pom.pom === false, `${fam}: no POM in the chain it runs`);
    assert.equal(cf.id, IB.chainFingerprintId(plain).id, `${fam}: the p0 family's fingerprint (one class, one draw)`);
    assert.equal(IB.interiorChainKey(clone, cf.pom), memberProgramKey(plain), `${fam}: keyed as the p0 chain it runs`);
  }
  // Refusals.
  const bare = new THREE.MeshStandardMaterial({ map: tex() });
  M.installPomShaderPatch(bare, hgt(), {});
  assert.equal(IB.interiorPomReason(bare, IB.chainFingerprintId(bare).pom), "pom-no-normal", "the POM text calls getTangentFrame");
  const bad = new THREE.MeshStandardMaterial({ map: tex(), normalMap: nrm() });
  M.installPomShaderPatch(bad, hgt(), {});
  const inner = bad.onBeforeCompile;
  bad.onBeforeCompile = function mangled(sh, r) { inner.call(this, sh, r); sh.fragmentShader = sh.fragmentShader.replace("texture2D(map, _pomUv)", "texture2D(map, _pomUv * 1.0)"); };
  assert.equal(IB.chainFingerprint(bad).reason, "chain-pom-shape", "POM text of another shape: refused, never half-patched");
  const tx = new THREE.MeshStandardMaterial({ map: tex() });
  tx.onBeforeCompile = function texChain(sh) { sh.uniforms.uFoo = { value: tex() }; };
  tx.customProgramCacheKey = () => "hb|d0|c0|p0|l1|a0|b0|f0|s0|k0|v";
  assert.equal(IB.chainFingerprint(tx).reason, "chain-uniform:uFoo", "any other texture uniform still refuses");
});

await t("P4 the class program = the member's program modulo the documented substitutions", () => {
  const { base } = pomCache();
  const fp = IB.chainFingerprintId(base);
  const cls = IB.interiorMemberClass(base);
  const hook = memberChainHook(base);
  const before = Object.getOwnPropertyDescriptor(base.userData, "pomShaderUniforms");
  // The member's own program (its chain on three's templates).
  const ms = stock();
  hook.call(new THREE.MeshStandardMaterial(), ms, null);
  // The class program, built with the interior consumer's options.
  const mat = CM.makeClassMaterial({
    cls, chain: hook, chainKey: IB.interiorChainKey(base, fp.pom),
    mapUniform: { value: null }, normalUniform: { value: null }, pomUniform: { value: null }, stateUniform: { value: null },
    vertexHook: (sh) => { sh.uniforms[IB.IB_BITS_SAMPLER] = { value: null }; IB.injectIbColorHook(sh); },
    vertexHookKey: `ibCell1|fp${fp.id}|rs1`,
  });
  const cs = stock();
  mat.onBeforeCompile.call(mat, cs, null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(base.userData, "pomShaderUniforms"), before, "the member's live POM handle untouched");
  assert.ok(!/\buPomMap\b/.test(cs.fragmentShader), "no uPomMap left");
  // --- undo every documented substitution on the class FRAGMENT text ---
  let fs = cs.fragmentShader;
  const head = CM.classFragmentHeader(true);
  assert.ok(fs.startsWith(head), "the class header first");
  fs = fs.slice(head.length);
  const undo = (to, from, what) => { assert.equal(count(fs, to), 1, `${what}: exactly once`); fs = fs.replace(to, from); };
  for (const [from, to] of CM.fragmentReplacements(true, true)) undo(to, from, `class patch ${from}`);
  undo(CM.POM_MAP_SAMPLE_BATCH, CM.POM_MAP_SAMPLE, "P4");
  let p3 = 0;
  fs = fs.replace(/texture\( hbBatchPomArr, vec3\( ([A-Za-z_][A-Za-z0-9_]*), vHbP0\.x \) \)/g, (_, uv) => { p3 += 1; return `texture2D(uPomMap, ${uv})`; });
  assert.equal(p3, count(ms.fragmentShader, "texture2D(uPomMap,"), "P3: every height sample, and only those");
  assert.equal(p3, 5, "premise: the patch samples the height map five times");
  for (const [from, to] of CM.pomDeclarationSubstitutions()) undo(to, from, `P1/P2 ${from}`);
  assert.equal(fs, ms.fragmentShader, "fragment: the member's text back, byte for byte");
  // --- the VERTEX text: the layer-state header (+ the POM row fetch), the cell-bit hook ---
  let vs = cs.vertexShader;
  const lh = CM.layerStateVertexChunk(true);
  assert.ok(lh.includes("vHbP0 = texelFetch(hbBatchStateTex, ivec2(0, hbP), 0);") && lh.includes("int hbP = int(vHbS3.y + 0.5);"), "the POM row fetched once per vertex from texel 3 .y");
  assert.ok(vs.startsWith(lh + IB.ibVertexHeader()), "headers first");
  vs = vs.slice(lh.length + IB.ibVertexHeader().length);
  assert.equal(count(vs, "void main() {\n  hbBatchSlotSetup();"), 1);
  vs = vs.replace("void main() {\n  hbBatchSlotSetup();", "void main() {");
  assert.equal(count(vs, "#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE), 1);
  vs = vs.replace("#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE, "#include <begin_vertex>");
  assert.equal(vs, ms.vertexShader, "vertex: the member's text back, byte for byte");
  // Uniforms: the POM eight out, the kit samplers in, the rest the member's values.
  const mk = Object.keys(ms.uniforms).sort();
  const ck = Object.keys(cs.uniforms).sort();
  assert.deepEqual(ck, [...mk.filter((n) => !POM_NAMES.includes(n)), "hbBatchMapArr", "hbBatchNrmArr", "hbBatchPomArr", "hbBatchStateTex", IB.IB_BITS_SAMPLER].sort());
  for (const n of mk) if (!POM_NAMES.includes(n)) assert.deepEqual(cs.uniforms[n].value, ms.uniforms[n].value, n);
  // Keys and self-checks.
  const key = mat.customProgramCacheKey();
  assert.ok(key.startsWith("hb|d0|c0|p1|l1|") && key.endsWith("|n1|pom1"), key);
  assert.equal(CM.classPatchMissing({ chain: hook, withNormal: true, withPom: true }), 0);
  assert.ok(CM.classPatchMissing({ chain: hook, withNormal: false, withPom: true }) > 0, "a POM class needs the normal page");
  assert.ok(CM.classPatchMissing({ chain: hook, withNormal: true }) > 0, "a POM chain is never patched as a plain class");
  for (const g of [CM.POM_FRAG_HEADER, CM.POM_MAP_SAMPLE_BATCH, CM.layerStateVertexChunk(true), ...CM.pomDeclarationSubstitutions().map(([, to]) => to)]) {
    assert.ok(!/[`'"]/.test(g), `no backtick, quote or apostrophe: ${g.slice(0, 60)}`);
  }
});

// --- P5: the world ---------------------------------------------------------------

const S_FIELDS = [["uPomSteps", "steps"], ["uPomDepth", "depth"], ["uPomShadowSteps", "shadowSteps"], ["uPomLodNear", "lodNear"],
  ["uPomLodFar", "lodFar"], ["uPomShadowDarkness", "shadowDarkness"], ["uPomGraze", "graze"]];

/** The text of a GLSL function `name` in `src` (its signature line to the closing brace at column 0). */
function fnText(src, sig) {
  const a = src.indexOf(sig);
  assert.ok(a >= 0, `function ${sig}`);
  const b = src.indexOf("\n}\n", a);
  return src.slice(a, b + 2);
}
const undoP3 = (s) => s.replace(/texture\( hbBatchPomArr, vec3\( ([A-Za-z_][A-Za-z0-9_]*), vHbP0\.x \) \)/g, "texture2D(uPomMap, $1)");

let world = null;
await t("P5 a flag-on POM world: rows = the legacy draw's uniforms, height layers copied from the legacy draw's plane, the POM text three built", async () => {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld({ M, adapter }, { recordShaders: true, recordCalls: true, pom: true });
  world = w;
  await R.build(cellsOn, w, { baked: false }); // cells: the POM base materials; props: their static-bias clones (flag-only p1)
  const st = { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] };
  const sh = R.makeSession(st);
  const legacy = [];
  for (let f = 0; f < 4; f += 1) {
    R.tick(cellsOn, w, sh);
    w.gl.__fake.startSnapshots();
    R.renderPass(w, R.MASK_BOTH, { shadow: true });
    R.renderPass(w, R.MASK_BOTH);
    for (const s of w.gl.__fake.takeSnapshots()) if (/^draw/.test(s.kind) && s.uniforms.uPomSteps !== undefined) legacy.push(s);
  }
  const d = IB.interiorBatchDiag();
  assert.equal(d.chunks.active, 1, `active: ${JSON.stringify({ chunks: d.chunks, unit: d.unitReasons, legacy: d.legacyReasons })}`);
  assert.ok(d.pomSlots >= 4, `POM slots: ${d.pomSlots}`);
  assert.ok(legacy.length > 0, "premise: the legacy POM draws ran (frame 1, overlap)");
  const S = IB.__interiorBatchStateForTest();
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const pages = KIT.kitPages(w.renderer);
  const copies = copiesOf(w.calls, w.gl);
  let checked = 0;
  for (const e of S.slots.values()) {
    if (!e.pom) continue;
    checked += 1;
    const glTex = w.renderer.properties.get(e.pomTex).__webglTexture;
    const snap = legacy.find((s) => s.uniforms.uPomMap === `tex#${glTex.__id}`);
    assert.ok(snap, `${e.member.name || "member"}: its legacy draw bound its own height plane`);
    const main = LS.unpackLayerState(table.rows.data, e.slot * fpr);
    assert.equal(main.extRow, e.pomRow, "the slot row points at its POM row");
    const row = LS.unpackPomState(table.rows.data, e.pomRow * fpr);
    assert.equal(row.layer, e.pomRef.layer, "the height layer");
    for (const [n, f] of S_FIELDS) assert.equal(row[f], snap.uniforms[n], `${n}: the value three bound for the legacy draw`);
    // The layer: a per-level copy of THAT 2D texture.
    const desc = e.pomRef.page.desc;
    assert.equal(desc.format, "r8");
    const mine = copies.filter((c) => c.dst === e.pomRef.page.gl.tex && c.layer === e.pomRef.layer);
    assert.equal(mine.length, desc.levels, "one copy per level");
    mine.forEach((c, l) => {
      const [lw, lh] = PA.levelSize(desc.width, desc.height, l);
      assert.deepEqual({ ...c }, { src: glTex, srcLevel: l, dst: e.pomRef.page.gl.tex, level: l, layer: e.pomRef.layer, w: lw, h: lh }, `level ${l}`);
    });
    assert.equal(pages.alloc.refCount(e.pomRef.contentKey) >= 1, true);
  }
  assert.ok(checked >= 4);
  // The class draws: the height page bound, no uPomMap, no legacy POM draw left (every visible cell handed over).
  w.gl.__fake.startSnapshots();
  R.renderPass(w, R.MASK_BOTH);
  const snaps = w.gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind));
  const pomPages = new Set([...S.slots.values()].filter((e) => e.pom).map((e) => `tex#${e.pomRef.page.gl.tex.__id}`));
  const classDraws = snaps.filter((s) => s.uniforms.hbBatchPomArr !== undefined);
  assert.ok(classDraws.length >= 2, `POM class draws: ${classDraws.length}`);
  for (const s of classDraws) assert.ok(pomPages.has(s.uniforms.hbBatchPomArr), "a POM class samples a height page of its slots");
  assert.equal(snaps.filter((s) => s.uniforms.uPomMap !== undefined).length, 0, "no legacy POM draw left");
  // The programs three built: the class POM text equals the legacy one modulo P2-P4.
  const fragOf = (pred) => w.sources.find((s) => pred(s) && s.includes("_pomPerturbedUv"));
  const legacyFs = fragOf((s) => s.includes("uniform sampler2D uPomMap;"));
  const classFs = fragOf((s) => s.includes("uniform highp sampler2DArray hbBatchPomArr;"));
  assert.ok(legacyFs && classFs, "both programs compiled");
  for (const sig of ["vec2 _pomPerturbedUv(", "float _pomShadow("]) assert.equal(undoP3(fnText(classFs, sig)), fnText(legacyFs, sig), `${sig}: the member's own text`);
  const block = (s) => s.slice(s.indexOf("// Phase 3.1 POM begin"), s.indexOf("// Phase 3.1 POM end"));
  assert.equal(block(classFs).replace(CM.POM_MAP_SAMPLE_BATCH, CM.POM_MAP_SAMPLE), block(legacyFs), "the POM block, the diffuse sample redirected only");
  for (const [n] of S_FIELDS) assert.ok(classFs.includes(`#define ${n} ${CM.POM_SCALAR_SOURCE[n]}`), `${n} from the POM row`);
  assert.ok(w.sources.some((s) => s.includes("vHbP1 = texelFetch(hbBatchStateTex, ivec2(1, hbP), 0);")), "the vertex stage fetches the POM row");
  // The flag-only props: batched as the p0 chain they run.
  const props = [...S.slots.values()].filter((e) => !e.pom);
  assert.ok(props.length >= 1);
  for (const e of props) {
    assert.match(e.programKey, /\|p1\|.*\|s1\|/, "premise: a static-bias clone keyed p1");
    assert.equal(e.pomRow, 0);
  }
  const pk = [...S.classMats.values()].map((ce) => ce.material.customProgramCacheKey());
  assert.ok(pk.some((k) => /\|p0\|l1\|a0\|b0\|f0\|s1\|/.test(k) && !k.endsWith("|pom1")), `a p0 static-bias class: ${pk}`);
  assert.ok(pk.some((k) => /\|p1\|/.test(k) && k.endsWith("|pom1")), "a POM class");
});

await t("P6 drift + release: a height re-upload re-plans onto a fresh copy; dispose frees every POM row and layer", async () => {
  const w = world;
  assert.ok(w, "premise: P5 ran");
  const S = IB.__interiorBatchStateForTest();
  const e0 = [...S.slots.values()].find((e) => e.pom);
  const member = e0.member;
  const h = e0.pomTex;
  const oldKey = e0.pomRef.contentKey;
  const pages = KIT.kitPages(w.renderer);
  const tr0 = IB.interiorBatchDiag().textureReplans;
  h.needsUpdate = true; // a re-upload of the height plane (new bytes / version)
  const st = { player: R.CELL(0), indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] };
  const sh = R.makeSession(st);
  // The re-plan waits the swap settle (interior_batch.js "TEXTURE SWAPS").
  for (let f = 0; f < IB.IB_TEXTURE_SETTLE_SYNCS + 8; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  const d = IB.interiorBatchDiag();
  assert.ok((d.unitReasons["replan:pom-map"] || 0) >= 1, JSON.stringify(d.unitReasons));
  assert.ok(d.textureReplans > tr0, "counted as a texture swap (its own cap)");
  assert.equal(d.chunks.active, 1, "active again");
  const e1 = S.slots.get(member);
  assert.ok(e1 && e1.pomRef, "re-admitted");
  assert.equal(e1.pomRef.contentKey, AP.contentKeyOf(h), "the new upload's content");
  assert.notEqual(e1.pomRef.contentKey, oldKey);
  // Released: idle (0), or (-1) its idle layer already reused by the fresh copy
  // (the kit's demand-sized pages are full: page_allocator.js "DEMAND-SIZED PAGES").
  assert.ok(pages.alloc.refCount(oldKey) <= 0, "the stale copy released");
  const keys = [...S.slots.values()].filter((e) => e.pom).map((e) => e.pomRef.contentKey);
  IB.disposeInteriorBatches();
  for (const k of keys) assert.equal(pages.alloc.refCount(k), 0, `height layer ${k} released`);
  const rows = KIT.kitStateTable().rows;
  assert.equal(rows._next - 1 - rows._free.length, 0, "every slot row and POM extension row freed");
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

await t("P7 the extra-map census: a member refused for an extra map is counted by its whole extra-map set", async () => {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld({ M, adapter }, { pom: true });
  // The texchan shape (materials.js _applyRough: both planes on one surface,
  // batched since 2026-10-31, tests/interior_batch_maps.test.mjs) next to a
  // light map no class reproduces: refused for the light map, counted by the whole set.
  const m = w.mc.materials.get(0x08000102);
  m.roughnessMap = adapter.surfacePixelsToRoughnessTexture(new Uint8Array(32 * 32).fill(40), 32, 32);
  m.aoMap = adapter.surfacePixelsToAoTexture(new Uint8Array(32 * 32).fill(200), 32, 32);
  m.lightMap = adapter.surfacePixelsToTexture(new Uint8Array(32 * 32 * 4).fill(90), 32, 32);
  await R.build(cellsOn, w, { baked: false });
  const sh = R.makeSession({ player: R.CELL(0), indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] });
  for (let f = 0; f < 3; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  const d = IB.interiorBatchDiag();
  assert.ok((d.unitReasons["cells:map:lightMap"] || 0) >= 1, JSON.stringify(d.unitReasons));
  assert.ok((d.extraMaps["lightMap+aoMap+roughnessMap"] || 0) >= 1, JSON.stringify(d.extraMaps));
  assert.equal(d.chunks.active, 1, "the rest of the landblock still batches");
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
