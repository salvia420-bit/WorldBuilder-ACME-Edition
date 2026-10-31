// tests/interior_batch_maps.test.mjs — AO / roughness / emissive members of
// `?interiorBatch` (scene3d/gpu_batch/interior_batch.js "AO / ROUGHNESS /
// EMISSIVE MEMBERS"; the kit side: class_materials.js "EXTRA-MAP MEMBERS",
// layer_state.js "EXTRA-MAP FIELDS"). Realboot census (Holtburg, ultra,
// 2026-10-31, `?interiorBatch=on`): extraMaps {aoMap+roughnessMap 364,
// aoMap+roughnessMap+emissiveMap 14, emissiveMap 14}, unitReasons
// {cells:map:aoMap 81, props:map:aoMap 227, props:map:emissiveMap 14,
// props:transparent 8}: the batch batched nothing. Every member below is
// built by materials.js's OWN path: the MaterialCache ladder
// (`_materialFromFlags`, the luminous ladder for the emissive alias), the
// texchan planes attached by its own `_attachRoughnessMap` -> `_resolveRough`
// -> `_applyRough` from texchan-shaped records (rig.mjs installTexchan: the
// manifest + a source answering the decoded record, sync or late), the
// clones cells.js draws with (getCachedCellBaked / getCachedStaticBias, and
// `_reseatVariantsForDid` for a late record). No hand-made stand-ins.
//
//   X1  the kit's extension row: packExtState lays POM state (texels 0-1) and
//       the extra-map state (texel 2: AO layer, roughness layer,
//       aoMapIntensity; texel 3: emissive rgb, emissive layer) out as
//       documented, equals packPomState without maps, the table adds /
//       rewrites / frees it; extraMapStateOf is three's uniform arithmetic
//       (emissive = color * intensity per channel, aoMapIntensity only with
//       an aoMap).
//   X2  eligibility of materials.js's own members: the texchan planes
//       (R8 AO at aoMapIntensityValue(), RGBA8 linear roughness in .g) on the
//       base and both clone families, and the luminous ladder's emissive
//       alias, are accepted with their map set; the chain fingerprint is the
//       plane-less family's (a map is program state, not chain text); the
//       refusals (an AO plane a page cannot hold, an emissiveMap that is not
//       the map, a luminous member without one, a light map).
//   X3  the class program = the member's program MODULO the documented
//       substitutions, for every set the realboot has (AO + roughness, + emissive,
//       emissive alone) on each member chain (baked clone, static-bias clone,
//       the normal-mapped base): A1-E2 undone on the class text give three's
//       own chunks back and the member's text, vertex and fragment, byte for
//       byte; the uniforms differ by the kit samplers only; the key gains
//       `|xm<set>`; a chunk that lost an anchor refuses the class.
//   X4  a flag-on world (three r184 + the recording fake WebGL2; the rig's
//       texchan + luminous material cache): the chunk goes active with AO /
//       roughness / emissive slots and no extra-map refusal left; each slot's
//       roughness / aoMapIntensity / emissive equal the uniforms three bound
//       for that member's LEGACY draw (the fake GL's draw snapshot); its AO
//       and roughness layers are per-level copies of the very 2D textures
//       the legacy draw bound to aoMap / roughnessMap, whose level 0 three
//       uploaded from the texchan record's bytes; the emissive layer is the
//       map layer, a copy of the texture the legacy draw bound to BOTH map
//       and emissiveMap; the class draws bind the slot pages; the programs
//       three compiled carry the substituted chunks where the legacy ones
//       carry three's.
//   X5  drift: a LATE texchan record (texchan's async arm, then
//       `_reseatVariantsForDid`) hands the chunk back to legacy in that sync
//       and re-plans it into the new set IB_MAP_SETTLE_SYNCS later
//       (`replan:ao-map-arrived`, outside the texture cap and the re-plan
//       limit, although the re-seat also re-keys a baked clone k1d -> k1:
//       materials.js _reseatSurfaceState drops `__acBakedDirectOut`); an emissive
//       intensity change (lumNight) rewrites the extension row with no
//       re-plan; an AO re-upload re-plans under the texture cap onto a fresh
//       copy (once the swap settled: interior_batch.js "TEXTURE SWAPS").
//   X6  dispose frees every extension row and AO / roughness layer.
//   X7  a real POM chain with texchan planes: ONE extension row carries the
//       POM half and the extra-map half; the class text is the member's
//       modulo P1-P4 + A1-R2; a POM world with texchan planes goes active.
//
// Each check fails on the pre-change tree (no packExtState / map sets / map
// classes; the planes refused as `map:aoMap`, the alias as `map:emissiveMap`).
//
// Run: node tests/interior_batch_maps.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const { aoMapIntensityValue } = await import("../scene3d/vfx_flags.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { memberChainHook } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
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
const KIT_SAMPLERS = ["hbBatchMapArr", "hbBatchNrmArr", "hbBatchAoArr", "hbBatchRghArr", "hbBatchStateTex", "hbIbBits"];
const settleMicro = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function tex(w = 16, h = 16, seed = 1) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 29 + seed) & 255;
  return adapter.surfacePixelsToTexture(px, w, h);
}
const nrm = (w = 16, h = 16) => adapter.surfacePixelsToNormalTexture(new Uint8Array(w * h * 3).fill(128), w, h);

/**
 * A MaterialCache with two surfaces built by its own ladder, their texchan
 * planes attached by its own `_attachRoughnessMap` (sync records): 0x08000c01
 * plain opaque (normal-mapped), 0x08000c02 luminous (L = 0.6: the luminous
 * ladder's white emissive + emissiveMap alias).
 */
function texchanCache() {
  const mc = new M.MaterialCache();
  const recs = new Map([[0x08000c01, R.texchanRecord(16, 16, 3)], [0x08000c02, R.texchanRecord(16, 16, 5)]]);
  const tc = R.installTexchan(mc, recs);
  const plain = mc._materialFromFlags(0x2, tex(), undefined, nrm(), undefined, null, FLOATS);
  mc._attachRoughnessMap(plain, 0x08000c01);
  mc.materials.set(0x08000c01, plain);
  const lum = mc._materialFromFlags(0x2, tex(16, 16, 7), undefined, null, undefined, null, { ...FLOATS, luminosity: 0.6 });
  mc._attachRoughnessMap(lum, 0x08000c02);
  mc.materials.set(0x08000c02, lum);
  return { mc, plain, lum, recs, tc };
}

// ---------------------------------------------------------------------------

await t("X1 the kit's extension row: POM + extra-map state, the documented layout, add / rewrite / free; three's uniform arithmetic", () => {
  const pom = { layer: 4, depth: 0.08, steps: 16.7, shadowSteps: 8, lodNear: 5, lodFar: 10, shadowDarkness: 0.5, graze: 1 };
  const maps = { aoLayer: 3, roughLayer: 7, aoIntensity: 0.6, emissiveR: 0.6, emissiveG: 0.3, emissiveB: 1.25, emissiveLayer: 9 };
  const out = LS.packExtState(pom, maps, new Float32Array(16).fill(5), 0);
  assert.deepEqual(Array.from(out), [4, F(0.08), 16, 8, 5, 10, 0.5, 1, 3, 7, F(0.6), 0, F(0.6), F(0.3), 1.25, 9],
    "texels 0-1 POM, texel 2 (AO layer, roughness layer, aoMapIntensity, 0), texel 3 (emissive rgb, emissive layer)");
  assert.deepEqual(Array.from(LS.packExtState(pom, null, new Float32Array(16).fill(5), 0)), Array.from(LS.packPomState(pom, new Float32Array(16).fill(6), 0)),
    "no maps: exactly what packPomState writes");
  assert.deepEqual(Array.from(LS.packExtState(null, maps, new Float32Array(16).fill(5), 0)).slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0], "no POM: texels 0-1 zero");
  assert.deepEqual(LS.unpackMapState(out, 0), { aoLayer: 3, roughLayer: 7, aoIntensity: F(0.6), emissive: [F(0.6), F(0.3), 1.25], emissiveLayer: 9 });
  // The table.
  KIT.resetKit();
  const table = KIT.kitStateTable();
  const row = table.addExt(null, maps, null);
  assert.ok(row > 0);
  const slot = table.addFromMaterial(new THREE.MeshStandardMaterial({ map: tex() }), 2, null, 0, row);
  const base = (r) => r * table.rows.floatsPerRow;
  assert.equal(LS.unpackLayerState(table.rows.data, base(slot)).extRow, row, "the slot row points at its extension row");
  assert.equal(table.writeExt(row, null, maps), false, "unchanged: no store, no upload");
  assert.equal(table.writeExt(row, null, { ...maps, emissiveR: 0.15 }), true);
  assert.equal(LS.unpackMapState(table.rows.data, base(row)).emissive[0], F(0.15));
  table.remove(row);
  table.remove(slot);
  assert.equal(table.rows._next - 1 - table.rows._free.length, 0, "every row back");
  KIT.resetKit();
  // extraMapStateOf: the arithmetic three's WebGLMaterials applies.
  const { lum, plain } = texchanCache();
  const s = CM.extraMapStateOf(lum, 2, 5, 8, {});
  const c = lum.emissive.clone().multiplyScalar(lum.emissiveIntensity);
  assert.deepEqual([s.emissiveR, s.emissiveG, s.emissiveB], [c.r, c.g, c.b], "emissive = Color.multiplyScalar(emissiveIntensity), channel for channel");
  assert.equal(s.aoIntensity, lum.aoMapIntensity);
  assert.deepEqual([s.aoLayer, s.roughLayer, s.emissiveLayer], [2, 5, 8]);
  const bare = new THREE.MeshStandardMaterial({ map: tex(), aoMapIntensity: 0.4 });
  assert.equal(CM.extraMapStateOf(bare, 0, 0, 0, {}).aoIntensity, 0, "no aoMap: 0 (three uploads none)");
  assert.equal(CM.extraMapStateOf(plain, 1, 1, 0, {}).emissiveR, 0, "a black emissive: 0");
});

await t("X2 eligibility of materials.js's own texchan / emissive members: accepted with their map set; the refusals", () => {
  const { mc, plain, lum, recs } = texchanCache();
  // Premises: materials.js's _applyRough attached the planes it mints.
  for (const [m, did] of [[plain, 0x08000c01], [lum, 0x08000c02]]) {
    const rec = recs.get(did);
    assert.ok(m.aoMap && m.aoMap.format === THREE.RedFormat && m.aoMap.colorSpace === THREE.NoColorSpace, "AO: an R8 linear plane");
    assert.deepEqual(Array.from(m.aoMap.image.data), Array.from(rec.ao), "the record's AO bytes");
    assert.equal(m.aoMapIntensity, aoMapIntensityValue(), "aoMapIntensity from vfx_flags");
    assert.ok(m.roughnessMap && m.roughnessMap.format === THREE.RGBAFormat && m.roughnessMap.colorSpace === THREE.NoColorSpace, "roughness: RGBA8 linear");
    assert.equal(m.roughnessMap.image.data[1], adapter.roughnessMapByteFromContrast(rec.roughness[0]), "the value in .g");
    assert.ok(m.userData.texchanAo === true && m.userData.texchanRoughness === true);
  }
  assert.ok(lum.emissiveMap === lum.map && lum.emissive.r === 1 && lum.emissiveIntensity === 0.6, "premise: the luminous ladder aliases the map");
  const members = {
    plain, lum,
    plainBaked: mc.getCachedCellBaked(0x08000c01), plainBias: mc.getCachedStaticBias(0x08000c01),
    lumBaked: mc.getCachedCellBaked(0x08000c02), lumBias: mc.getCachedStaticBias(0x08000c02),
  };
  for (const [name, m] of Object.entries(members)) {
    assert.ok(m.aoMap && m.roughnessMap, `${name}: the clone carries the planes (Material.copy)`);
    assert.equal(IB.interiorArrayReason(m), null, `${name}: accepted`);
    const set = CM.memberMapSet(m);
    assert.equal(set.key, name.startsWith("lum") ? "|xmare" : "|xmar", `${name}: its map set`);
  }
  // The chain fingerprint does not see the maps (they are program state, not chain text).
  const mc0 = new M.MaterialCache();
  mc0.materials.set(0x08000c01, mc0._materialFromFlags(0x2, tex(), undefined, nrm(), undefined, null, FLOATS));
  assert.equal(IB.chainFingerprintId(members.plainBaked).id, IB.chainFingerprintId(mc0.getCachedCellBaked(0x08000c01)).id, "the plane-less family's fingerprint");
  // Refusals.
  const mk = (f) => { const m = members.plainBias.clone(); f(m); return IB.interiorArrayReason(m); };
  assert.equal(mk((m) => { m.aoMap = m.aoMap.clone(); m.aoMap.offset.set(0.5, 0); m.aoMap.updateMatrix(); }), "ao-map-format", "an AO plane a page cannot hold");
  assert.equal(mk((m) => { m.roughnessMap = adapter.surfacePixelsToHeightTexture(new Uint8Array(64), 8, 8); }), "roughness-map-format");
  assert.equal(mk((m) => { m.emissiveMap = tex(); m.emissive.setRGB(1, 1, 1); }), "map:emissiveMap", "an emissiveMap that is not the map");
  assert.equal(mk((m) => { m.emissive.setRGB(1, 1, 1); }), "luminous", "luminous without an emissiveMap");
  assert.equal(mk((m) => { m.lightMap = tex(); }), "map:lightMap");
});

await t("X3 the class program = the member's program modulo the documented substitutions (A1-E2), every realboot map set", () => {
  const { mc } = texchanCache();
  // A1-E2 are three's own chunks with exactly the documented substitutions.
  for (const [name, subs] of Object.entries(CM.MAP_CHUNK_SUBSTITUTIONS)) {
    let s = CM.batchMapChunk(name);
    assert.ok(typeof s === "string", name);
    for (const [from, to] of subs) { assert.equal(count(s, to), 1, `${name}: ${to} once`); s = s.replace(to, from); }
    assert.equal(s, THREE.ShaderChunk[name], `${name}: three's own chunk back`);
  }
  const cases = [
    ["baked clone, AO + roughness", mc.getCachedCellBaked(0x08000c01)],
    ["static-bias clone, AO + roughness + emissive", mc.getCachedStaticBias(0x08000c02)],
    ["base (light clamp, normal map), AO + roughness", mc.materials.get(0x08000c01)],
  ];
  // The emissive-only set (realboot: 14 props) on the static-bias clone.
  const eOnly = mc.getCachedStaticBias(0x08000c02).clone();
  eOnly.aoMap = null; eOnly.roughnessMap = null;
  eOnly.onBeforeCompile = mc.getCachedStaticBias(0x08000c02).onBeforeCompile;
  eOnly.customProgramCacheKey = mc.getCachedStaticBias(0x08000c02).customProgramCacheKey;
  cases.push(["static-bias, emissive alone", eOnly]);
  for (const [label, m] of cases) {
    assert.equal(IB.interiorArrayReason(m), null, `${label}: accepted`);
    const ms = CM.memberMapSet(m);
    const withNormal = !!m.normalMap;
    const fp = IB.chainFingerprintId(m);
    const hook = memberChainHook(m);
    const ms0 = stock();
    hook.call(new THREE.MeshStandardMaterial(), ms0, null);
    const mat = CM.makeClassMaterial({
      cls: IB.interiorMemberClass(m), chain: hook, chainKey: IB.interiorChainKey(m, fp.pom),
      mapUniform: { value: null }, normalUniform: withNormal ? { value: null } : null, stateUniform: { value: null },
      aoUniform: ms.ao ? { value: null } : null, roughnessUniform: ms.rough ? { value: null } : null, emissive: ms.emissive,
      vertexHook: (sh) => { sh.uniforms[IB.IB_BITS_SAMPLER] = { value: null }; IB.injectIbColorHook(sh); },
      vertexHookKey: `ibCell1|fp${fp.id}|rs1`,
    });
    assert.equal(!!mat.aoMap, ms.ao, `${label}: USE_AOMAP switched by the set`);
    assert.equal(!!mat.roughnessMap, ms.rough);
    assert.equal(!!mat.emissiveMap, ms.emissive);
    const cs = stock();
    mat.onBeforeCompile.call(mat, cs, null);
    // --- fragment: undo every documented substitution ---
    let fs = cs.fragmentShader;
    const head = CM.classFragmentHeader(withNormal, ms);
    assert.ok(fs.startsWith(head), `${label}: the class header first`);
    fs = fs.slice(head.length);
    for (const [from, to] of CM.fragmentReplacements(withNormal, false, ms)) {
      assert.ok(to !== null, `${label}: ${from} has its replacement`);
      assert.equal(count(fs, to), 1, `${label}: ${from} replaced exactly once`);
      fs = fs.replace(to, from);
    }
    assert.equal(fs, ms0.fragmentShader, `${label}: fragment, the member's text back byte for byte`);
    if (ms.ao) assert.ok(cs.fragmentShader.includes("texture( hbBatchAoArr, vec3( vAoMapUv, vHbP2.x ) )") && cs.fragmentShader.includes("* vHbP2.z + 1.0"), "A1 / A2");
    if (ms.rough) assert.ok(cs.fragmentShader.includes("texture( hbBatchRghArr, vec3( vRoughnessMapUv, vHbP2.y ) )"), "R2");
    if (ms.emissive) assert.ok(cs.fragmentShader.includes(CM.EMISSIVE_RADIANCE_BATCH) && cs.fragmentShader.includes("texture( hbBatchMapArr, vec3( vEmissiveMapUv, vHbP3.w ) )"), "E1 / E2");
    // --- vertex: the layer-state header (+ the extension texels), the cell-bit hook ---
    let vs = cs.vertexShader;
    const lh = CM.layerStateVertexChunk(false, ms);
    assert.equal(lh.includes("vHbP2 = texelFetch(hbBatchStateTex, ivec2(2, hbP), 0);"), ms.ao || ms.rough, `${label}: texel 2 only for AO / roughness`);
    assert.equal(lh.includes("vHbP3 = texelFetch(hbBatchStateTex, ivec2(3, hbP), 0);"), ms.emissive, `${label}: texel 3 only for emissive`);
    assert.ok(!lh.includes("vHbP0") && !lh.includes("vHbP1"), "no POM texels without POM");
    assert.ok(vs.startsWith(lh + IB.ibVertexHeader()), `${label}: headers first`);
    vs = vs.slice(lh.length + IB.ibVertexHeader().length);
    assert.equal(count(vs, "void main() {\n  hbBatchSlotSetup();"), 1);
    vs = vs.replace("void main() {\n  hbBatchSlotSetup();", "void main() {");
    assert.equal(count(vs, "#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE), 1);
    vs = vs.replace("#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE, "#include <begin_vertex>");
    assert.equal(vs, ms0.vertexShader, `${label}: vertex, the member's text back byte for byte`);
    // Uniforms: the kit samplers in, the rest the member's values.
    const mk = Object.keys(ms0.uniforms).sort();
    const want = [...mk, ...KIT_SAMPLERS.filter((n) => (n !== "hbBatchNrmArr" || withNormal) && (n !== "hbBatchAoArr" || ms.ao) && (n !== "hbBatchRghArr" || ms.rough))].sort();
    assert.deepEqual(Object.keys(cs.uniforms).sort(), want, `${label}: uniforms`);
    for (const n of mk) assert.deepEqual(cs.uniforms[n].value, ms0.uniforms[n].value, n);
    const key = mat.customProgramCacheKey();
    assert.ok(key.endsWith((withNormal ? "|n1" : "|n0") + ms.key), `${label}: ${key}`);
    assert.equal(CM.classPatchMissing({ chain: hook, withNormal, maps: ms }), 0, `${label}: complete`);
  }
  // A chain that expanded the AO include (or a three whose chunk lost an anchor) refuses the AO class, never half-patches it.
  const m = mc.getCachedCellBaked(0x08000c01);
  const inner = memberChainHook(m);
  const expanding = (sh, r) => { inner.call(new THREE.MeshStandardMaterial(), sh, r); sh.fragmentShader = sh.fragmentShader.replace("#include <aomap_fragment>", THREE.ShaderChunk.aomap_fragment); };
  assert.equal(CM.classPatchMissing({ chain: expanding, withNormal: false }), 0, "premise: the set-less class does not need that include");
  assert.ok(CM.classPatchMissing({ chain: expanding, withNormal: false, maps: CM.mapSetOf(true, true, false) }) > 0, "the AO class refuses");
  const saved = THREE.ShaderChunk.aomap_fragment;
  try {
    THREE.ShaderChunk.aomap_fragment = saved.replace("aoMapIntensity", "aoMapIntensity * aoMapIntensity");
    assert.equal(CM.batchMapChunk("aomap_fragment"), null, "an anchor twice: no chunk");
    assert.ok(CM.classPatchMissing({ chain: inner, maps: CM.mapSetOf(true, false, false) }) > 0, "and no class");
  } finally { THREE.ShaderChunk.aomap_fragment = saved; }
  for (const g of [CM.mapFragmentHeader(CM.mapSetOf(true, true, true)), CM.layerStateVertexChunk(false, CM.mapSetOf(true, true, true)), CM.EMISSIVE_RADIANCE_BATCH,
    ...Object.values(CM.MAP_CHUNK_SUBSTITUTIONS).flat().map(([, to]) => to)]) {
    assert.ok(!/[`'"]/.test(g), `no backtick, quote or apostrophe: ${g.slice(0, 60)}`);
  }
});

// --- X4: the world ------------------------------------------------------------

/** Every copyTexSubImage3D with the READ attachment and the 2D-array binding in force. */
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

/** GL texture -> its level-0 texSubImage2D call args (the active unit's TEXTURE_2D binding tracked). */
function uploadsOf(calls, gl) {
  let unit = 0;
  const bound = new Map();
  const out = new Map();
  for (const [n, a] of calls) {
    if (n === "activeTexture") unit = a[0] - gl.TEXTURE0;
    else if (n === "bindTexture" && a[0] === gl.TEXTURE_2D) bound.set(unit, a[1]);
    else if (n === "texSubImage2D" && a[0] === gl.TEXTURE_2D && a[1] === 0) out.set(bound.get(unit), a);
  }
  return out;
}

const glTexOf = (w, t) => w.renderer.properties.get(t).__webglTexture;
const texId = (w, t) => `tex#${glTexOf(w, t).__id}`;
const INDOOR = () => ({ player: R.CELL(0), indoor: true, frustum: R.CELL_IDS, walk: R.CELL_IDS, bfs: [] });

let world = null;
await t("X4 a flag-on world: map slots, values = the legacy draw's uniforms, layers copied from the legacy draw's planes, the chunks three compiled", async () => {
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld({ M, adapter }, { recordShaders: true, recordCalls: true, texchan: true, luminous: R.LUMINOUS });
  world = w;
  await R.build(cellsOn, w);
  const sh = R.makeSession(INDOOR());
  const legacy = [];
  for (let f = 0; f < 4; f += 1) {
    R.tick(cellsOn, w, sh);
    w.gl.__fake.startSnapshots();
    R.renderPass(w, R.MASK_BOTH, { shadow: true });
    R.renderPass(w, R.MASK_BOTH);
    for (const s of w.gl.__fake.takeSnapshots()) if (/^draw/.test(s.kind) && s.uniforms.hbBatchStateTex === undefined && s.uniforms.aoMapIntensity !== undefined) legacy.push(s);
  }
  const d = IB.interiorBatchDiag();
  assert.equal(d.chunks.active, 1, `active: ${JSON.stringify({ chunks: d.chunks, unit: d.unitReasons, legacy: d.legacyReasons })}`);
  assert.deepEqual(d.extraMaps, {}, "no member refused for an extra map");
  assert.ok(!Object.keys(d.unitReasons).some((k) => /map:|luminous/.test(k)), JSON.stringify(d.unitReasons));
  assert.ok(d.mapSlots.ao >= 5 && d.mapSlots.roughness >= 5 && d.mapSlots.emissive >= 2, JSON.stringify(d.mapSlots));
  assert.ok(d.mapSlots.sets["|xmar"] >= 3 && d.mapSlots.sets["|xmare"] >= 2, "both realboot sets");
  assert.ok(legacy.length > 0, "premise: the legacy draws ran (overlap)");
  const S = IB.__interiorBatchStateForTest();
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const copies = copiesOf(w.calls, w.gl);
  const uploads = uploadsOf(w.calls, w.gl);
  const rec = w.mc.__texchan.records;
  const recOf = (e) => [...rec.entries()].find(([did]) => w.mc.materials.get(did) && w.mc.materials.get(did).aoMap === e.aoTex);
  let checked = 0;
  const layerCopies = (ref, glTex, what) => {
    const desc = ref.page.desc;
    const mine = copies.filter((c) => c.dst === ref.page.gl.tex && c.layer === ref.layer);
    assert.equal(mine.length, desc.levels, `${what}: one copy per level`);
    mine.forEach((c, l) => {
      const [lw, lh] = PA.levelSize(desc.width, desc.height, l);
      assert.deepEqual({ ...c }, { src: glTex, srcLevel: l, dst: ref.page.gl.tex, level: l, layer: ref.layer, w: lw, h: lh }, `${what} level ${l}`);
    });
  };
  for (const e of S.slots.values()) {
    if (!e.maps.any) continue;
    checked += 1;
    const snaps = legacy.filter((s) => (!e.aoTex || s.uniforms.aoMap === texId(w, e.aoTex)) && s.uniforms.map === texId(w, e.map)
      && (!e.rghTex || s.uniforms.roughnessMap === texId(w, e.rghTex)));
    assert.ok(snaps.length > 0, "its legacy draw bound its own planes");
    const main = LS.unpackLayerState(table.rows.data, e.slot * fpr);
    const ext = LS.unpackMapState(table.rows.data, e.extRow * fpr);
    assert.equal(main.extRow, e.extRow, "the slot row points at its extension row");
    for (const snap of snaps) {
      assert.equal(main.roughness, snap.uniforms.roughness, "roughness: the value three bound");
      if (e.aoTex) assert.equal(ext.aoIntensity, snap.uniforms.aoMapIntensity, "aoMapIntensity: the value three bound");
      if (e.maps.emissive) {
        assert.deepEqual(ext.emissive, snap.uniforms.emissive, "emissive: the value three bound");
        assert.equal(snap.uniforms.emissiveMap, snap.uniforms.map, "the legacy draw sampled ONE texture as map and emissiveMap");
      }
    }
    if (e.maps.emissive) {
      assert.ok(ext.emissive[0] > 0, "premise: a lit emissive");
      assert.equal(ext.emissiveLayer, e.mapRef.layer, "E2: the emissive layer is the map layer");
      layerCopies(e.mapRef, glTexOf(w, e.map), "map / emissive");
    }
    if (e.aoTex) {
      assert.equal(e.aoRef.page.desc.format, "r8", "AO: a kit R8 page");
      assert.equal(ext.aoLayer, e.aoRef.layer);
      layerCopies(e.aoRef, glTexOf(w, e.aoTex), "AO");
      const [, r] = recOf(e);
      const up = uploads.get(glTexOf(w, e.aoTex));
      assert.deepEqual(up.slice(0, 8), [w.gl.TEXTURE_2D, 0, 0, 0, r.width, r.height, w.gl.RED, w.gl.UNSIGNED_BYTE], "AO: level 0 as RED / UNSIGNED_BYTE");
      assert.deepEqual(Array.from(up[8]), Array.from(r.ao), "AO: three uploaded the texchan record's bytes");
    }
    if (e.rghTex) {
      assert.equal(e.rghRef.page.desc.format, "rgba8");
      assert.equal(e.rghRef.page.desc.colorSpace, THREE.NoColorSpace, "roughness: a linear page");
      assert.equal(ext.roughLayer, e.rghRef.layer);
      layerCopies(e.rghRef, glTexOf(w, e.rghTex), "roughness");
      const [, r] = recOf(e);
      const up = uploads.get(glTexOf(w, e.rghTex));
      const want = new Uint8Array(r.width * r.height * 4);
      for (let i = 0; i < r.width * r.height; i += 1) { want[i * 4 + 1] = adapter.roughnessMapByteFromContrast(r.roughness[i]); want[i * 4 + 3] = 255; }
      assert.deepEqual(Array.from(up[8]), Array.from(want), "roughness: three uploaded the record's planes (.g)");
    }
  }
  assert.ok(checked >= 6, `map slots checked: ${checked}`);
  // The class draws: the slot pages bound; no handed-over legacy mesh draws.
  w.draws.length = 0;
  w.gl.__fake.startSnapshots();
  R.renderPass(w, R.MASK_BOTH);
  const snaps = w.gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind));
  const aoPages = new Set([...S.slots.values()].filter((e) => e.aoRef).map((e) => `tex#${e.aoRef.page.gl.tex.__id}`));
  const rghPages = new Set([...S.slots.values()].filter((e) => e.rghRef).map((e) => `tex#${e.rghRef.page.gl.tex.__id}`));
  const classDraws = snaps.filter((s) => s.uniforms.hbBatchAoArr !== undefined);
  assert.ok(classDraws.length >= 3, `AO class draws: ${classDraws.length}`);
  for (const s of classDraws) {
    assert.ok(aoPages.has(s.uniforms.hbBatchAoArr), "an AO class samples an AO page of its slots");
    assert.ok(rghPages.has(s.uniforms.hbBatchRghArr), "and a roughness page");
  }
  const handed = new Set();
  for (const rec2 of S.lbs.values()) for (const ch of rec2.chunks) for (const mi of ch.meshInfo) if (mi.suppressed) handed.add(mi.mesh);
  assert.ok(handed.size >= 6, "premise: meshes handed over");
  assert.equal(w.draws.filter((r) => handed.has(r.object)).length, 0, "no handed-over legacy mesh draws");
  // The programs three built: the class carries the substituted chunks, legacy three's own.
  // (Fragment sources compiled with USE_AOMAP: a class one declares the kit's map page, a legacy one does not.)
  const aoFs = w.sources.filter((s) => s.includes("#define USE_AOMAP") && s.includes("out highp vec4 pc_fragColor;"));
  const classFs = aoFs.filter((s) => s.includes("uniform highp sampler2DArray hbBatchMapArr;"));
  const legacyFs = aoFs.filter((s) => !s.includes("hbBatchMapArr"));
  assert.ok(classFs.length >= 2 && legacyFs.length >= 2, `both kinds compiled (${classFs.length} / ${legacyFs.length})`);
  assert.ok(classFs.every((s) => s.includes("uniform highp sampler2DArray hbBatchAoArr;")), "every class AO program samples the AO page");
  for (const name of ["aomap_fragment", "roughnessmap_fragment"]) {
    assert.ok(classFs.every((s) => s.includes(CM.batchMapChunk(name))), `class: ${name} with A1-R2`);
    assert.ok(legacyFs.every((s) => s.includes(THREE.ShaderChunk[name])), `legacy: three's ${name}`);
  }
  const em = w.sources.filter((s) => s.includes(CM.EMISSIVE_RADIANCE_BATCH));
  assert.ok(em.length >= 1 && em.every((s) => s.includes(CM.batchMapChunk("emissivemap_fragment"))), "an emissive class: E1 + E2");
  const pk = [...S.classMats.values()].map((ce) => ce.material.customProgramCacheKey());
  assert.ok(pk.some((k) => k.endsWith("|xmar")) && pk.some((k) => k.endsWith("|xmare")), `a class per set: ${pk}`);
});

await t("X5 drift: a late texchan record re-plans into the new set after the settle window; a lumNight dim rewrites the row; an AO re-upload re-plans", async () => {
  // (a) the emissive value: rewritten in the next sync, no re-plan.
  const w = world;
  assert.ok(w, "premise: X4 ran");
  const S = IB.__interiorBatchStateForTest();
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const sh = R.makeSession(INDOOR());
  const lumE = [...S.slots.values()].find((e) => e.maps.emissive);
  const r0 = IB.interiorBatchDiag().replans + IB.interiorBatchDiag().textureReplans;
  lumE.member.emissiveIntensity *= 0.25; // luminous_night.js: only the value moves
  R.tick(cellsOn, w, sh);
  const c = lumE.member.emissive.clone().multiplyScalar(lumE.member.emissiveIntensity);
  assert.deepEqual(LS.unpackMapState(table.rows.data, lumE.extRow * fpr).emissive, [F(c.r), F(c.g), F(c.b)], "the row follows the member");
  assert.equal(IB.interiorBatchDiag().replans + IB.interiorBatchDiag().textureReplans, r0, "no re-plan");
  // (b) an AO re-upload: a texture swap under the texture cap, onto a fresh copy.
  const e0 = [...S.slots.values()].find((e) => e.aoTex);
  const member = e0.member;
  const ao = e0.aoTex;
  const oldKey = e0.aoRef.contentKey;
  const pages = KIT.kitPages(w.renderer);
  const tr0 = IB.interiorBatchDiag().textureReplans;
  ao.needsUpdate = true;
  // The re-plan waits the swap settle (interior_batch.js "TEXTURE SWAPS").
  for (let f = 0; f < IB.IB_TEXTURE_SETTLE_SYNCS + 8; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  let d = IB.interiorBatchDiag();
  assert.ok((d.unitReasons["replan:ao-map"] || 0) >= 1, JSON.stringify(d.unitReasons));
  assert.ok(d.textureReplans > tr0, "counted as a texture swap");
  assert.equal(d.chunks.active, 1, "active again");
  const e1 = S.slots.get(member);
  assert.equal(e1.aoRef.contentKey, AP.contentKeyOf(ao), "the new upload's content");
  // Released: idle (0), or (-1) its idle layer already reused by the fresh copy
  // (the kit's demand-sized pages are full: page_allocator.js "DEMAND-SIZED PAGES").
  assert.ok(pages.alloc.refCount(oldKey) <= 0, "the stale copy released");
  IB.disposeInteriorBatches();
  KIT.resetKit();
  // (c) a LATE texchan record: the world builds and activates without planes.
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const wl = await R.makeWorld({ M, adapter }, { texchan: { late: true } });
  await R.build(cellsOn, wl);
  const shl = R.makeSession(INDOOR());
  for (let f = 0; f < 4; f += 1) { R.tick(cellsOn, wl, shl); R.renderPass(wl, R.MASK_BOTH); }
  d = IB.interiorBatchDiag();
  assert.equal(d.chunks.active, 1);
  assert.equal(d.mapSlots.ao, 0, "premise: no plane yet");
  assert.ok(wl.mc.__texchan.pending() >= 6, "premise: the fetches are in flight");
  const Sl = IB.__interiorBatchStateForTest();
  const handed = [];
  for (const rec2 of Sl.lbs.values()) for (const ch of rec2.chunks) for (const mi of ch.meshInfo) if (mi.suppressed) handed.push(mi.mesh);
  assert.ok(handed.length >= 6);
  wl.mc.__texchan.release();
  await settleMicro();
  const base = wl.mc.materials.get(R.TEXCHAN_DIDS[0]);
  assert.ok(base.aoMap && base.roughnessMap, "premise: materials.js's async arm attached the planes");
  assert.ok(wl.mc.getCachedCellBaked(R.TEXCHAN_DIDS[0]).aoMap === base.aoMap, "premise: _reseatVariantsForDid carried them to the clones");
  const tr1 = d.textureReplans;
  const rp1 = d.replans;
  R.tick(cellsOn, wl, shl);
  d = IB.interiorBatchDiag();
  assert.equal(d.replans, rp1, "not a chain / member drift either (the re-seat also re-keys a baked clone: told apart, X5 note)");
  assert.ok((d.unitReasons["replan:ao-map-arrived"] || 0) + (d.unitReasons["replan:roughness-map-arrived"] || 0) >= 1, JSON.stringify(d.unitReasons));
  assert.equal(d.chunks.pending, 1, "handed back to legacy in that sync");
  assert.ok(handed.every((m) => !Object.prototype.hasOwnProperty.call(m, "boundingSphere")), "every legacy mesh draws again (no sentinel) in that frame's render");
  assert.equal(d.textureReplans, tr1, "an arrival is not a texture swap (outside the cap)");
  assert.ok(d.mapArrivals >= 1);
  for (let f = 0; f < IB.IB_MAP_SETTLE_SYNCS - 2; f += 1) R.tick(cellsOn, wl, shl);
  assert.equal(IB.interiorBatchDiag().chunks.pending, 1, "the burst settles first");
  for (let f = 0; f < 6; f += 1) { R.tick(cellsOn, wl, shl); R.renderPass(wl, R.MASK_BOTH); }
  d = IB.interiorBatchDiag();
  assert.equal(d.chunks.active, 1, `active again: ${JSON.stringify(d.chunks)}`);
  assert.ok(d.mapSlots.ao >= 5 && d.mapSlots.roughness >= 5, `re-planned into the AO + roughness set: ${JSON.stringify(d.mapSlots)}`);
  world = wl;
});

await t("X6 dispose frees every extension row and AO / roughness layer", () => {
  const w = world;
  const S = IB.__interiorBatchStateForTest();
  const pages = KIT.kitPages(w.renderer);
  const keys = [];
  for (const e of S.slots.values()) { if (e.aoRef) keys.push(e.aoRef.contentKey); if (e.rghRef) keys.push(e.rghRef.contentKey); }
  assert.ok(keys.length >= 10, `premise: layers (${keys.length})`);
  IB.disposeInteriorBatches();
  for (const k of keys) assert.equal(pages.alloc.refCount(k), 0, `layer ${k} released`);
  const rows = KIT.kitStateTable().rows;
  assert.equal(rows._next - 1 - rows._free.length, 0, "every slot row and extension row freed");
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

await t("X7 POM + extra maps in ONE extension row: the POM chain with texchan planes (class text modulo P1-P4 + A1-R2), a POM world goes active", async () => {
  // The member: materials.js's POM base (pomEnabled ladder) with its texchan planes.
  const mc = new M.MaterialCache({ pomEnabled: true });
  R.installTexchan(mc, new Map([[0x08000c05, R.texchanRecord(16, 16, 9)]]));
  const h = adapter.surfacePixelsToHeightTexture(R.heightPixels(16, 16, 2), 16, 16);
  const base = mc._materialFromFlags(0x2, tex(), M.SURFACE_CATEGORY.Stone, nrm(), undefined, h, FLOATS);
  mc._attachRoughnessMap(base, 0x08000c05);
  mc.materials.set(0x08000c05, base);
  assert.ok(base.aoMap && base.roughnessMap && base.userData.pomEnabled === true, "premise: POM + texchan planes");
  assert.equal(IB.interiorArrayReason(base), null);
  const fp = IB.chainFingerprintId(base);
  assert.ok(fp.pom && fp.pom.pom === true, "a real POM chain");
  const ms = CM.memberMapSet(base);
  const hook = memberChainHook(base);
  const m0 = stock();
  hook.call(new THREE.MeshStandardMaterial(), m0, null);
  const mat = CM.makeClassMaterial({
    cls: IB.interiorMemberClass(base), chain: hook, chainKey: IB.interiorChainKey(base, fp.pom),
    mapUniform: { value: null }, normalUniform: { value: null }, pomUniform: { value: null }, stateUniform: { value: null },
    aoUniform: { value: null }, roughnessUniform: { value: null },
    vertexHook: (sh) => { sh.uniforms[IB.IB_BITS_SAMPLER] = { value: null }; IB.injectIbColorHook(sh); }, vertexHookKey: `ibCell1|fp${fp.id}|rs1`,
  });
  const cs = stock();
  mat.onBeforeCompile.call(mat, cs, null);
  let fs = cs.fragmentShader;
  const head = CM.classFragmentHeader(true, ms);
  assert.ok(fs.startsWith(head));
  fs = fs.slice(head.length);
  for (const [from, to] of CM.fragmentReplacements(true, true, ms)) { assert.equal(count(fs, to), 1, from); fs = fs.replace(to, from); }
  assert.equal(count(fs, CM.POM_MAP_SAMPLE_BATCH), 1);
  fs = fs.replace(CM.POM_MAP_SAMPLE_BATCH, CM.POM_MAP_SAMPLE);
  fs = fs.replace(/texture\( hbBatchPomArr, vec3\( ([A-Za-z_][A-Za-z0-9_]*), vHbP0\.x \) \)/g, "texture2D(uPomMap, $1)");
  for (const [from, to] of CM.pomDeclarationSubstitutions()) { assert.equal(count(fs, to), 1, from); fs = fs.replace(to, from); }
  assert.equal(fs, m0.fragmentShader, "fragment: the member's text back");
  let vs = cs.vertexShader;
  const lh = CM.layerStateVertexChunk(true, ms);
  assert.equal(count(lh, "int hbP = int(vHbS3.y + 0.5);"), 1, "one extension-row index for POM and maps");
  assert.ok(lh.includes("vHbP0 = ") && lh.includes("vHbP1 = ") && lh.includes("vHbP2 = ") && !lh.includes("vHbP3 = "));
  assert.ok(vs.startsWith(lh + IB.ibVertexHeader()));
  vs = vs.slice(lh.length + IB.ibVertexHeader().length).replace("void main() {\n  hbBatchSlotSetup();", "void main() {").replace("#include <begin_vertex>\n" + IB.IB_COLOR_COLLAPSE, "#include <begin_vertex>");
  assert.equal(vs, m0.vertexShader, "vertex: the member's text back");
  assert.ok(mat.customProgramCacheKey().endsWith("|n1|pom1|xmar"));
  assert.equal(CM.classPatchMissing({ chain: hook, withNormal: true, withPom: true, maps: ms }), 0);
  // A POM world with texchan planes: one extension row per slot carries both halves.
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld({ M, adapter }, { pom: true, texchan: true });
  await R.build(cellsOn, w, { baked: false });
  const sh = R.makeSession(INDOOR());
  for (let f = 0; f < 4; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  const d = IB.interiorBatchDiag();
  assert.equal(d.chunks.active, 1, JSON.stringify({ chunks: d.chunks, unit: d.unitReasons }));
  assert.ok(d.pomSlots >= 3 && d.mapSlots.ao >= 5, JSON.stringify({ pomSlots: d.pomSlots, mapSlots: d.mapSlots }));
  const S = IB.__interiorBatchStateForTest();
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  let both = 0;
  for (const e of S.slots.values()) {
    if (!e.pom || !e.aoRef) continue;
    both += 1;
    const pr = LS.unpackPomState(table.rows.data, e.extRow * fpr);
    const mr = LS.unpackMapState(table.rows.data, e.extRow * fpr);
    assert.equal(pr.layer, e.pomRef.layer, "POM half: the height layer");
    assert.equal(mr.aoLayer, e.aoRef.layer, "map half: the AO layer");
    assert.equal(mr.roughLayer, e.rghRef.layer);
    assert.equal(mr.aoIntensity, F(e.member.aoMapIntensity));
  }
  assert.ok(both >= 3, `POM + AO slots: ${both}`);
  assert.ok([...S.classMats.values()].some((ce) => ce.material.customProgramCacheKey().endsWith("|pom1|xmar")), "a POM class with the AO + roughness set");
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest(null);
  KIT.resetKit();
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
