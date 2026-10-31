// tests/entity_batch_maps.test.mjs — AO / roughness / emissive parts of
// `?entityBatch` (scene3d/gpu_batch/entity_batch.js "AO / ROUGHNESS /
// EMISSIVE PARTS"; the kit side: class_materials.js "EXTRA-MAP MEMBERS",
// layer_state.js "EXTRA-MAP FIELDS"; the model: interior_batch.js "AO /
// ROUGHNESS / EMISSIVE MEMBERS" and tests/interior_batch_maps.test.mjs).
// Laptop real boot (Holtburg, 2026-10-31, `?entityBatch=on`): leafRoutes
// {translucent 263, map:aoMap 48, map:emissiveMap 2}, extraMaps
// {aoMap+roughnessMap 47, aoMap+roughnessMap+emissiveMap 1, emissiveMap 2}.
// Every member below is built by materials.js's OWN path: the MaterialCache
// ladder (`_materialFromFlags`, the luminous ladder for the emissive alias)
// and the texchan planes attached by its own `_attachRoughnessMap` ->
// `_resolveRough` -> `_applyRough` from texchan-shaped records (the smoke
// lib's materialCacheFor `texchan`: a manifest + a source answering the
// decoded record, sync or late), on the REAL EntityManager (three r184 over
// the recording fake WebGL2, tests/entity_batch_rig.mjs). The one hand write
// is the Luminous hook's own (entities.js `_applyRampValueToMaterial`: a
// ramp to 0 under `?surfaceLumWins=off` sets `emissive` to black and keeps
// the alias) where a black-emissive alias member is needed.
//
//   EM0 flag OFF (run first): the shared scenario
//       (tests/entity_batch_lifecycle.test.mjs golden) and a texchan scenario
//       (planes, the luminous alias, a late plane landing) fingerprint equal
//       what the PRE-change tree produced; nothing of the batch or the kit
//       is created.
//   EM1 routing: materials.js's texchan members (R8 AO at aoMapIntensity,
//       RGBA8 linear roughness) are batchable with their map set (`|xmar`),
//       plain and ClipMap, POM ones too; their run key gains the set and the
//       AO / roughness page keys (a plane-less run key is unchanged); the kit
//       array rule itself still refuses them (anim scenery untouched); the
//       luminous ladder member with planes + alias stays legacy as
//       `luminous`; a black-emissive alias batches (`|xmare` / `|xme`);
//       lightMap / bumpMap / displacementMap / metalnessMap / alphaMap /
//       envMap next to the planes still route `map:<name>`, a non-alias
//       emissiveMap `map:emissiveMap`, planes a page cannot hold
//       `ao-map-format` / `roughness-map-format`.
//   EM2 the class programs (the entity's own `_classOpts`, every set the
//       boot has + the emissive ones + POM with planes): USE_* switched by
//       the set, the key `...|entPart1[|pomc<id>]|n<0|1>[|pom1]|xm<set>`,
//       the fragment = the member's MODULO the documented substitutions (A1-E2,
//       + P1-P4), the vertex = the set-less class's with the extension
//       texels fetched, the page samplers bound, classPatchMissing 0.
//   EM3 a flag-on world (a cache rig with planes + a recolored rig): both
//       active, no `map:` route left, the luminous leaf legacy; per map row
//       the slot's roughness, the extension row's aoMapIntensity and emissive
//       equal the uniforms three bound for that member's LEGACY draw; the AO
//       layer (an R8 page) and the roughness layer (a linear RGBA8 page) are
//       per-level copies of the very 2D planes the legacy draw bound, whose
//       level 0 three uploaded from the texchan record's bytes; the emissive
//       layer is the map layer; the class draws bind the row pages and no
//       legacy draw with a plane is left; the programs three compiled carry
//       the substituted chunks where the legacy ones carry three's;
//       verify() clean incl. `mapMismatches`; the census counters.
//   EM4 drift: an aoMapIntensity change rewrites the row (no re-plan); an AO
//       re-upload / a roughness swap / a plane that leaves re-plan
//       (`drift:map`) onto the new planes; an emissive alias that leaves
//       demotes (`drift:luminous`) and re-plans into the new set.
//   EM4b POM + planes: one extension row carries both halves (packExtState),
//       a POM rig with planes goes active with `|pom1|xmar` classes.
//   EM5 a LATE texchan record (texchan's async arm on the cache material):
//       the rig is legacy in that very frame (no batch draw, every leaf
//       unparked, the planes drawn by the legacy leaves), re-plans into the
//       new set ENTITY_BATCH_MAP_SETTLE_FRAMES later, not churn.
//   EM6 verify().mapMismatches catches a corrupt map half and a stale plane.
//   EM7 page-full: an AO layer the cap refuses keeps its member a legacy leaf
//       (the rest batches, no churn, its map layer released); the retry
//       check reads the planes; once the cap takes them the rig re-plans
//       with every member.
//   EM8 the smoke's maps arm dry-runs in node (the luminous + translucent
//       leaves legacy, AO / roughness classes, verify clean) and the layers
//       readback walks the AO / roughness layers; the page and the runner
//       carry the arms.
//
// EM1-EM8 (and EM4b) fail on the pre-change tree (the planes routed `map:aoMap`, the
// alias `map:emissiveMap`; no map rows / classes / counters). EM0 is the
// identity check (its goldens were captured on the pre-change tree).
//
// Run from apps/holtburger-web/:  node tests/entity_batch_maps.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import * as R from "./entity_batch_rig.mjs";

const { THREE, EB, KIT, M, ADAPTER, D } = R;
R.requireBatch();
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const AP = await import("../scene3d/gpu_batch/array_pages.js");
const PA = await import("../scene3d/gpu_batch/page_allocator.js");
const CM = await import("../scene3d/gpu_batch/class_materials.js");
const { aoMapIntensityValue } = await import("../scene3d/vfx_flags.js");
const ASB = await import("../scene3d/gpu_batch/anim_scenery_batch.js");

const { check, done } = R.suite("entity_batch_maps");
const LIB = R.LIB;
const F = Math.fround;
const PAL = { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) };
const count = (s, sub) => s.split(sub).length - 1;
const stock = () => ({ vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} });
const settleMicro = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const texCache = (o = {}) => LIB.materialCacheFor(M, ADAPTER, { clamp: true, texchan: true, ...o });
const eb0 = () => new EB.EntityBatch({ scene3d: {} }, { diagGlobal: false, env: () => ({}) });
const PLANE_DIDS = [D.A, D.B, D.C, D.E, D.CLIP];
const MAP_DIDS = [...PLANE_DIDS, D.LUM];
const smallTex = () => ADAPTER.surfacePixelsToTexture(new Uint8Array(16 * 16 * 4).fill(77), 16, 16);

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
const mapRows = (b) => [...b.plan.memberRefs.values()].filter((r) => r.maps && r.maps.any);
const isParked = (leaf) => leaf.userData.hbParked === true && leaf.layers.mask === EB.ENTITY_PARK_MASK;
const verifyZero = (v) => [v.rowMismatches, v.stateMismatches, v.pomMismatches, v.mapMismatches, v.parkMismatches, v.attrMismatches];

// --- EM0: flag off (first: no flag-on world has run yet) ---------------------------

// tests/entity_batch_lifecycle.test.mjs GOLDEN (captured on the pre-R3-4 tree).
const SHARED_GOLDEN = {
  phases: [
    { tag: "walk", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "59acafcb", counts: "018b00fe" },
    { tag: "ramps", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "5d66ccb6", counts: "881adc6f" },
    { tag: "camFade", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "57c76530", counts: "881adc6f" },
    { tag: "back", draws: 38, graph: "9b9f0b7e", nodes: 79, snaps: "20b9c546", counts: "881adc6f" },
  ],
  programs: "decc9fed", programCount: 11, diagGlobal: "undefined", kitBudget: "null",
};
// Captured 2026-10-31 by mapsFlagOffFingerprint() below with the PRE-change
// entity_batch.js (r3-batching/eb-maps: entity_batch.pre.js swapped in by a
// module-resolve hook; everything else this tree).
const MAPS_GOLDEN = {
  phases: [
    { tag: "walk", draws: 38, graph: "86c2623f", nodes: 77, snaps: "68143aad", counts: "069ff40c" },
    { tag: "arrived", draws: 38, graph: "86c2623f", nodes: 77, snaps: "41dd5016", counts: "de01c970" },
  ],
  programs: "2f36a21f", programCount: 18, diagGlobal: "undefined", kitBudget: "null", batchProp: "null",
};

function snapJson(snaps) {
  return JSON.stringify(snaps, (k, v) => {
    if (v && typeof v === "object" && v.__kind !== undefined) return `${v.__kind}#${v.__id}`;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    return v;
  });
}

/** A flag-off texchan scenario: a cache rig with planes (the luminous one too) + a recolored rig, walking, a late plane landing. */
async function mapsFlagOffFingerprint() {
  const mc = texCache({ texchan: { late: true, dids: [D.A, D.B, D.C, D.LUM] } });
  const w = await R.world(false, { materialCache: mc, parts: LIB.MIXED_PARTS });
  await w.spawn(0x50000e31, 10, 10, 0);
  await w.spawn(0x50000e32, 11, 10, 0, PAL);
  const phases = [];
  const capture = (tag) => {
    w.gl.__fake.reset();
    w.gl.__fake.startSnapshots();
    w.renderer.render(w.scene, w.camera);
    const snaps = w.gl.__fake.takeSnapshots();
    const counts = { ...w.gl.__fake.counts };
    const graph = R.graphFingerprint(w.scene);
    phases.push({
      tag, draws: snaps.filter((s) => /^draw/.test(s.kind)).length, graph: R.hashStr(graph.join("\n")), nodes: graph.length,
      snaps: R.hashStr(snapJson(snaps)), counts: R.hashStr(JSON.stringify(Object.keys(counts).sort().map((k) => [k, counts[k]]))),
    });
  };
  w.frame(20);
  capture("walk");
  mc.__texchan.release();
  await settleMicro();
  w.frame(4);
  capture("arrived");
  const programs = (w.renderer.info.programs || []).map((p) => p.cacheKey).sort();
  return {
    phases, programs: R.hashStr(programs.join("\n")), programCount: programs.length,
    diagGlobal: typeof globalThis.window.__entityBatch, kitBudget: KIT.kitSummary().budget === null ? "null" : "set",
    batchProp: w.em._entityBatch === undefined ? "undefined" : String(w.em._entityBatch),
  };
}

await check("EM0 flag OFF: the shared and the texchan scenario equal the pre-change tree's; nothing of the batch or the kit exists", async () => {
  const fp = await R.flagOffFingerprint();
  const { batchProp, ...rest } = fp;
  assert.equal(batchProp, "null");
  assert.deepEqual(rest, SHARED_GOLDEN);
  const mf = await mapsFlagOffFingerprint();
  if (process.env.HB_EB_MAPS_CAPTURE) console.log("MAPS_GOLDEN " + JSON.stringify(mf));
  assert.deepEqual(mf, MAPS_GOLDEN);
});

// ---------------------------------------------------------------------------

await check("EM1 routing: texchan members batch with their map set; the luminous one stays legacy; every other map still refuses", () => {
  const mc = texCache();
  const a = mc.materials.get(D.A);
  const rec = mc.__texchan.records.get(D.A);
  // Premises: materials.js's _applyRough attached the planes it mints.
  assert.ok(a.aoMap && a.aoMap.format === THREE.RedFormat && a.aoMap.colorSpace === THREE.NoColorSpace, "AO: an R8 linear plane");
  assert.deepEqual(Array.from(a.aoMap.image.data), Array.from(rec.ao), "the record's AO bytes");
  assert.equal(a.aoMapIntensity, aoMapIntensityValue(), "aoMapIntensity from vfx_flags");
  assert.ok(a.roughnessMap && a.roughnessMap.format === THREE.RGBAFormat && a.roughnessMap.colorSpace === THREE.NoColorSpace, "roughness: RGBA8 linear");
  assert.equal(a.roughnessMap.image.data[1], ADAPTER.roughnessMapByteFromContrast(rec.roughness[0]), "the value in .g");
  assert.equal(ASB.memberProgramKey(a), "hb|d0|c0|p0|l1|a0|b0|f0|s0|k0|v", "the realboot cache chain (light clamp)");
  assert.equal(ASB.unitArrayReason(a), "map:aoMap", "the kit array rule itself still refuses it (anim scenery untouched)");
  for (const did of PLANE_DIDS) {
    const m = mc.materials.get(did);
    assert.equal(EB.entityArrayReason(m), null, `${did.toString(16)}: batchable`);
    assert.equal(CM.memberMapSet(m).key, "|xmar", `${did.toString(16)}: its map set`);
  }
  assert.equal(ASB.memberClass(mc.materials.get(D.CLIP)).blend, "alphaTest", "a ClipMap part too");
  // Run keys: the set and the AO / roughness page keys; a plane-less member's key is unchanged.
  const ad = AP.describeTexture(a.aoMap, AP.R8_PLANES), rd = AP.describeTexture(a.roughnessMap);
  assert.equal(ad.format, "r8");
  assert.equal(EB.entityRunKeyOf(a), ASB.arraySignature(a) + "|xmar|a:" + PA.pageKeyOf(ad) + "|r:" + PA.pageKeyOf(rd));
  const h1 = mc.materials.get(D.H1);
  assert.ok(!h1.aoMap && EB.entityArrayReason(h1) === null && EB.entityRunKeyOf(h1) === ASB.arraySignature(h1), "a plane-less run key is unchanged");
  // The luminous ladder member: planes + the emissive alias + white emissive.
  const lum = mc.materials.get(D.LUM);
  assert.ok(lum.aoMap && lum.roughnessMap && lum.emissiveMap === lum.map && lum.emissive.r === 1, "premise: the realboot aoMap+roughnessMap+emissiveMap leaf");
  assert.equal(EB.entityArrayReason(lum), "luminous", "a luminous leaf stays legacy (not a map: route)");
  // Variants of `a` (its chain kept).
  const mk = (f) => {
    const m = a.clone();
    m.onBeforeCompile = a.onBeforeCompile;
    m.customProgramCacheKey = a.customProgramCacheKey;
    f(m);
    return m;
  };
  const why = (f) => EB.entityArrayReason(mk(f));
  for (const k of ["lightMap", "bumpMap", "displacementMap", "metalnessMap", "alphaMap", "envMap"]) {
    assert.equal(why((m) => { m[k] = smallTex(); }), "map:" + k, `${k} next to the planes still refuses`);
  }
  assert.equal(why((m) => { m.emissiveMap = smallTex(); }), "map:emissiveMap", "an emissiveMap that is not the map");
  assert.equal(why((m) => { m.emissiveMap = m.map; m.emissive.setRGB(0.5, 0.5, 0.5); }), "luminous", "an alias on a lit emissive");
  assert.equal(why((m) => { m.aoMap = m.aoMap.clone(); m.aoMap.offset.set(0.5, 0); m.aoMap.updateMatrix(); }), "ao-map-format", "an AO plane a page cannot hold");
  assert.equal(why((m) => { m.aoMap = m.aoMap.clone(); m.aoMap.channel = 1; }), "ao-map-format", "an AO plane on another uv channel");
  assert.equal(why((m) => { m.roughnessMap = ADAPTER.surfacePixelsToHeightTexture(new Uint8Array(64), 8, 8); }), "roughness-map-format", "an R8 roughness plane");
  // A black-emissive alias (the Luminous hook's write at 0): the emissive sets.
  const ea = mk((m) => { m.emissiveMap = m.map; });
  assert.equal(EB.entityArrayReason(ea), null);
  assert.equal(CM.memberMapSet(ea).key, "|xmare");
  const eo = mk((m) => { m.emissiveMap = m.map; m.aoMap = null; m.roughnessMap = null; });
  assert.equal(EB.entityArrayReason(eo), null);
  assert.equal(CM.memberMapSet(eo).key, "|xme");
  assert.equal(EB.entityRunKeyOf(eo), ASB.arraySignature(eo) + "|xme");
  // A stock-chain member (no key of its own) with planes: the array view keeps three's key.
  const st = new THREE.MeshStandardMaterial({ map: smallTex(), aoMap: a.aoMap, roughnessMap: a.roughnessMap, side: THREE.DoubleSide });
  assert.equal(ASB.memberProgramKey(st), "");
  assert.equal(EB.entityArrayReason(st), null, "a stock-chain member with planes");
  // POM parts with planes: both halves.
  const pc = texCache({ pom: true, clamp: false });
  const p = pc.materials.get(D.A);
  assert.ok(p.aoMap && p.roughnessMap && p.userData.pomEnabled === true, "premise: POM + texchan planes");
  assert.equal(EB.entityArrayReason(p), null, "a POM part with planes");
  const v = EB.entityPomVerdict(p);
  assert.ok(v && v.pom && v.pom.pom === true);
  const hd = AP.describeTexture(v.pom.texture, AP.R8_PLANES);
  const pad = AP.describeTexture(p.aoMap, AP.R8_PLANES), prd = AP.describeTexture(p.roughnessMap);
  assert.equal(EB.entityRunKeyOf(p), ASB.arraySignature(p) + "|pomc" + v.id + "|h:" + PA.pageKeyOf(hd) + "|xmar|a:" + PA.pageKeyOf(pad) + "|r:" + PA.pageKeyOf(prd));
  const pm = p.clone();
  pm.onBeforeCompile = p.onBeforeCompile;
  pm.customProgramCacheKey = p.customProgramCacheKey;
  pm.metalnessMap = smallTex();
  assert.equal(EB.entityArrayReason(pm), "map:metalnessMap", "POM path: another map still refuses");
});

await check("EM2 the class programs: the key gains the set, the fragment is the member's modulo A1-E2 (+ P1-P4), the vertex fetches the extension texels", () => {
  const mc = texCache();
  const e = eb0();
  const a = mc.materials.get(D.A);
  const mk = (f) => { const m = a.clone(); m.onBeforeCompile = a.onBeforeCompile; m.customProgramCacheKey = a.customProgramCacheKey; f(m); return m; };
  const pc = texCache({ pom: true, clamp: false });
  const cases = [
    ["opaque, AO + roughness (the boot's set)", a],
    ["ClipMap, AO + roughness", mc.materials.get(D.CLIP)],
    ["AO + roughness + emissive alias (black)", mk((m) => { m.emissiveMap = m.map; })],
    ["emissive alias alone", mk((m) => { m.emissiveMap = m.map; m.aoMap = null; m.roughnessMap = null; })],
    ["roughness alone", mk((m) => { m.aoMap = null; })],
    ["POM + AO + roughness (normal-mapped)", pc.materials.get(D.B)],
  ];
  const sets = new Set();
  for (const [label, m] of cases) {
    assert.equal(EB.entityArrayReason(m), null, `${label}: batchable`);
    const ms = CM.memberMapSet(m);
    sets.add(ms.key);
    const withNormal = !!m.normalMap;
    const pv = EB.entityPomVerdict(m);
    const withPom = !!(pv && pv.pom);
    const cls = ASB.memberClass(m);
    const nrmU = withNormal ? { value: null } : null;
    const pomU = withPom ? { value: null } : null;
    const maps = { aoUniform: ms.ao ? { value: null } : null, roughnessUniform: ms.rough ? { value: null } : null, emissive: ms.emissive };
    const mat = CM.makeClassMaterial(e._classOpts(m, cls, { value: null }, nrmU, pomU, maps));
    const none = CM.makeClassMaterial(e._classOpts(m, cls, { value: null }, nrmU, pomU, null));
    assert.equal(!!mat.aoMap, ms.ao, `${label}: USE_AOMAP switched by the set`);
    assert.equal(!!mat.roughnessMap, ms.rough, `${label}: USE_ROUGHNESSMAP`);
    assert.equal(!!mat.emissiveMap, ms.emissive, `${label}: USE_EMISSIVEMAP`);
    assert.equal(mat.userData.hbBatchMaps, ms.key);
    const key = mat.customProgramCacheKey();
    const chainKey = ASB.memberProgramKey(m);
    const hook = withPom ? `entPart1|pomc${pv.id}` : "entPart1";
    assert.equal(key, `${chainKey}|hbBatch1|${CM.classKeyOf(cls)}|${hook}|n${withNormal ? 1 : 0}${withPom ? "|pom1" : ""}${ms.key}`, `${label}: ${key}`);
    assert.equal(none.customProgramCacheKey() + ms.key, key, "the set-less class key + the set");
    // The member's own text on three's stock template.
    const m0 = stock();
    ASB.memberChainHook(m).call(new THREE.MeshStandardMaterial(), m0, null);
    const cs = stock();
    mat.onBeforeCompile.call(mat, cs, null);
    const cn = stock();
    none.onBeforeCompile.call(none, cn, null);
    // --- fragment: undo every documented substitution ---
    let fs = cs.fragmentShader;
    const head = CM.classFragmentHeader(withNormal, ms);
    assert.ok(fs.startsWith(head), `${label}: the class header first`);
    fs = fs.slice(head.length);
    for (const [from, to] of CM.fragmentReplacements(withNormal, withPom, ms)) {
      assert.ok(to !== null, `${label}: ${from} has its replacement`);
      assert.equal(count(fs, to), 1, `${label}: ${from} replaced exactly once`);
      fs = fs.replace(to, from);
    }
    if (withPom) {
      assert.equal(count(fs, CM.POM_MAP_SAMPLE_BATCH), 1);
      fs = fs.replace(CM.POM_MAP_SAMPLE_BATCH, CM.POM_MAP_SAMPLE);
      fs = fs.replace(/texture\( hbBatchPomArr, vec3\( ([A-Za-z_][A-Za-z0-9_]*), vHbP0\.x \) \)/g, "texture2D(uPomMap, $1)");
      for (const [from, to] of CM.pomDeclarationSubstitutions()) { assert.equal(count(fs, to), 1, from); fs = fs.replace(to, from); }
    }
    assert.equal(fs, m0.fragmentShader, `${label}: fragment, the member's text back byte for byte`);
    if (ms.ao) assert.ok(cs.fragmentShader.includes(CM.batchMapChunk("aomap_fragment")), `${label}: A1 / A2`);
    if (ms.rough) assert.ok(cs.fragmentShader.includes(CM.batchMapChunk("roughnessmap_fragment")), `${label}: R1 / R2`);
    if (ms.emissive) assert.ok(cs.fragmentShader.includes(CM.EMISSIVE_RADIANCE_BATCH) && cs.fragmentShader.includes(CM.batchMapChunk("emissivemap_fragment")), `${label}: E1 / E2`);
    // --- vertex: the set-less class's text with the extension texels fetched ---
    const lh0 = CM.layerStateVertexChunk(withPom, CM.MAP_SET_NONE), lh = CM.layerStateVertexChunk(withPom, ms);
    assert.equal(count(cn.vertexShader, lh0), 1, "the set-less header once");
    assert.equal(cs.vertexShader, cn.vertexShader.replace(lh0, lh), `${label}: vertex = the set-less class + the extension texels`);
    assert.equal(lh.includes("vHbP2 = texelFetch(hbBatchStateTex, ivec2(2, hbP), 0);"), ms.ao || ms.rough, `${label}: texel 2 only for AO / roughness`);
    assert.equal(lh.includes("vHbP3 = texelFetch(hbBatchStateTex, ivec2(3, hbP), 0);"), ms.emissive, `${label}: texel 3 only for emissive`);
    assert.ok(cs.vertexShader.includes("hbBatchRowSetup") && cs.uniforms.hbEntPartTex, `${label}: the part-row redirect is kept`);
    // Uniforms: the set-less class's plus exactly the set's page samplers.
    const want = [...Object.keys(cn.uniforms), ...(ms.ao ? ["hbBatchAoArr"] : []), ...(ms.rough ? ["hbBatchRghArr"] : [])].sort();
    assert.deepEqual(Object.keys(cs.uniforms).sort(), want, `${label}: uniforms`);
    assert.equal(cs.uniforms.hbBatchAoArr, ms.ao ? maps.aoUniform : undefined);
    assert.equal(cs.uniforms.hbBatchRghArr, ms.rough ? maps.roughnessUniform : undefined);
    assert.equal(CM.classPatchMissing({ chain: ASB.memberChainHook(m), withNormal, withPom, maps: ms }), 0, `${label}: complete`);
  }
  assert.deepEqual([...sets].sort(), ["|xmar", "|xmare", "|xme", "|xmr"]);
});

// --- EM3: the world -----------------------------------------------------------

let W = null;
await check("EM3 a flag-on world: map rows = the legacy draw's uniforms, layers copied from the legacy draw's planes, the chunks three compiled, verify clean", async () => {
  const calls = [];
  const sources = [];
  const mc = texCache();
  // The Luminous hook's write at 0 (entities.js `_applyRampValueToMaterial`,
  // `?surfaceLumWins=off`): a black emissive, the alias kept.
  const lumC = mc.materials.get(D.LUM);
  lumC.emissive.setRGB(0, 0, 0);
  const w = await R.world(true, { materialCache: mc, parts: LIB.MIXED_PARTS, onCall: (n, a) => { calls.push([n, Array.from(a)]); if (n === "shaderSource") sources.push(String(a[1])); } });
  const A = await w.spawn(0x50000e01);
  const B = await w.spawn(0x50000e02, 11, 10, 0, PAL);
  // Frame 1 draws the legacy leaves (the rigs are still admitting / warming).
  w.gl.__fake.startSnapshots();
  w.frame();
  const legacy = w.gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind) && s.uniforms.hbBatchStateTex === undefined && s.uniforms.aoMap !== undefined);
  w.settle(80);
  const eb = w.em._entityBatch;
  const st = eb.stats();
  assert.deepEqual([A._hbBatch.status, B._hbBatch.status], ["active", "active"], JSON.stringify(st.live));
  assert.ok(legacy.length >= 6, `premise: legacy plane draws in frame 1 (${legacy.length})`);
  // Routing of the real leaves.
  const ctx = { animated: () => false };
  for (const leaf of R.leavesOf(A)) {
    const did = leaf.userData.surfaceDid >>> 0;
    assert.equal(EB.leafRouteReason(leaf, ctx), did === D.TRANS ? "translucent" : null, `A ${did.toString(16)}`);
  }
  const lumB = R.leavesOf(B).find((l) => (l.userData.surfaceDid >>> 0) === D.LUM);
  assert.equal(EB.leafRouteReason(lumB, ctx), "luminous", "the recolored luminous leaf stays legacy");
  assert.ok(!Object.keys(st.leafRoutes).some((k) => k.startsWith("map:")), JSON.stringify(st.leafRoutes));
  assert.deepEqual(st.extraMaps, {}, "no leaf refused for an extra map");
  assert.ok(st.leafRoutes.luminous >= 1 && st.leafRoutes.translucent >= 2, JSON.stringify(st.leafRoutes));
  // Counters.
  assert.deepEqual(st.mapMembers, { members: 6, ao: 6, roughness: 6, emissive: 1, sets: { "|xmar": 5, "|xmare": 1 } }, JSON.stringify(st.mapMembers));
  assert.ok(st.mapLeaves["aoMap+roughnessMap"] >= 14 && st.mapLeaves["aoMap+roughnessMap+emissiveMap"] >= 1, JSON.stringify(st.mapLeaves));
  assert.ok(st.layers.ao >= 6 && st.layers.roughness >= 6 && st.layers.emissive >= 1, JSON.stringify(st.layers));
  assert.equal(st.mapArrivals, 0);
  const v = eb.verify();
  assert.deepEqual(verifyZero(v), [0, 0, 0, 0, 0, 0], JSON.stringify(v));
  assert.equal(v.entities, 2);
  // Rows vs the legacy draw.
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const copies = copiesOf(calls, w.gl);
  const uploads = uploadsOf(calls, w.gl);
  const layerCopies = (page, layer, glTex, what) => {
    const desc = page.desc;
    const mine = copies.filter((c) => c.dst === page.gl.tex && c.layer === layer);
    assert.equal(mine.length, desc.levels, `${what}: one copy per level`);
    mine.forEach((c, l) => {
      const [lw, lh] = PA.levelSize(desc.width, desc.height, l);
      assert.deepEqual({ ...c }, { src: glTex, srcLevel: l, dst: page.gl.tex, level: l, layer, w: lw, h: lh }, `${what} level ${l}`);
    });
  };
  const rows = mapRows(A._hbBatch);
  assert.equal(rows.length, 6);
  assert.equal(mapRows(B._hbBatch).length, 0, "the recolored rig's members carry no planes");
  for (const row of rows) {
    const did = [...mc.materials.entries()].find(([, m]) => m === row.member)[0];
    const snaps = legacy.filter((s) => s.uniforms.aoMap === texId(w, row.aoTex) && s.uniforms.map === texId(w, row.map) && s.uniforms.roughnessMap === texId(w, row.rghTex));
    assert.ok(snaps.length > 0, `${did.toString(16)}: its legacy draw bound its own planes`);
    const main = LS.unpackLayerState(table.rows.data, row.slot * fpr);
    const ext = LS.unpackMapState(table.rows.data, row.extRow * fpr);
    assert.equal(main.extRow, row.extRow, "the slot row points at its extension row");
    assert.deepEqual(Array.from(table.rows.data.slice(row.extRow * fpr, row.extRow * fpr + 8)), [0, 0, 0, 0, 0, 0, 0, 0], "no POM half");
    for (const snap of snaps) {
      assert.equal(main.roughness, snap.uniforms.roughness, "roughness: the value three bound");
      assert.equal(ext.aoIntensity, snap.uniforms.aoMapIntensity, "aoMapIntensity: the value three bound");
      if (row.maps.emissive) {
        assert.deepEqual(ext.emissive, snap.uniforms.emissive, "emissive: the value three bound");
        assert.equal(snap.uniforms.emissiveMap, snap.uniforms.map, "the legacy draw sampled ONE texture as map and emissiveMap");
      }
    }
    if (row.maps.emissive) assert.equal(ext.emissiveLayer, row.layer, "E2: the emissive layer is the map layer");
    else assert.deepEqual([...ext.emissive, ext.emissiveLayer], [0, 0, 0, 0]);
    assert.equal(ext.aoLayer, row.aoLayer);
    assert.equal(ext.roughLayer, row.rghLayer);
    assert.equal(row.aoPage.desc.format, "r8", "AO: a kit R8 page");
    assert.equal(row.rghPage.desc.format, "rgba8");
    assert.equal(row.rghPage.desc.colorSpace, THREE.NoColorSpace, "roughness: a linear page");
    layerCopies(row.aoPage, row.aoLayer, glTexOf(w, row.aoTex), "AO");
    layerCopies(row.rghPage, row.rghLayer, glTexOf(w, row.rghTex), "roughness");
    const r = mc.__texchan.records.get(did);
    const up = uploads.get(glTexOf(w, row.aoTex));
    assert.deepEqual(up.slice(0, 8), [w.gl.TEXTURE_2D, 0, 0, 0, r.width, r.height, w.gl.RED, w.gl.UNSIGNED_BYTE], "AO: level 0 as RED / UNSIGNED_BYTE");
    assert.deepEqual(Array.from(up[8]), Array.from(r.ao), "AO: three uploaded the texchan record's bytes");
    const want = new Uint8Array(r.width * r.height * 4);
    for (let i = 0; i < r.width * r.height; i += 1) { want[i * 4 + 1] = ADAPTER.roughnessMapByteFromContrast(r.roughness[i]); want[i * 4 + 3] = 255; }
    assert.deepEqual(Array.from(uploads.get(glTexOf(w, row.rghTex))[8]), Array.from(want), "roughness: three uploaded the record's plane (.g)");
  }
  // The class draws: the row pages bound; no legacy draw with a plane is left.
  const snaps = w.drawsOf();
  const aoPages = new Set(rows.map((r) => `tex#${r.aoPage.gl.tex.__id}`));
  const rghPages = new Set(rows.map((r) => `tex#${r.rghPage.gl.tex.__id}`));
  const classDraws = snaps.filter((s) => s.uniforms.hbBatchAoArr !== undefined);
  assert.ok(classDraws.length >= 2, `AO class draws: ${classDraws.length}`);
  for (const s of classDraws) {
    assert.ok(aoPages.has(s.uniforms.hbBatchAoArr), "an AO class samples an AO page of its rows");
    assert.ok(rghPages.has(s.uniforms.hbBatchRghArr), "and a roughness page");
  }
  assert.equal(snaps.filter((s) => s.uniforms.aoMap !== undefined && s.uniforms.hbBatchStateTex === undefined).length, 0, "no legacy plane draw left");
  for (const leaf of R.leavesOf(A)) if ((leaf.userData.surfaceDid >>> 0) !== D.TRANS) assert.ok(isParked(leaf), "every map leaf parked");
  // The programs three built: the class carries the substituted chunks, legacy three's own.
  const aoFs = sources.filter((s) => s.includes("#define USE_AOMAP") && s.includes("out highp vec4 pc_fragColor;"));
  const classFs = aoFs.filter((s) => s.includes("uniform highp sampler2DArray hbBatchMapArr;"));
  const legacyFs = aoFs.filter((s) => !s.includes("hbBatchMapArr"));
  assert.ok(classFs.length >= 2 && legacyFs.length >= 2, `both kinds compiled (${classFs.length} / ${legacyFs.length})`);
  for (const name of ["aomap_fragment", "roughnessmap_fragment"]) {
    assert.ok(classFs.every((s) => s.includes(CM.batchMapChunk(name))), `class: ${name} with A1-R2`);
    assert.ok(legacyFs.every((s) => s.includes(THREE.ShaderChunk[name])), `legacy: three's ${name}`);
  }
  const em = sources.filter((s) => s.includes(CM.EMISSIVE_RADIANCE_BATCH));
  assert.ok(em.length >= 1 && em.every((s) => s.includes(CM.batchMapChunk("emissivemap_fragment"))), "an emissive class: E1 + E2");
  // Class map-set keys: the live program keys and each run's class.
  assert.ok(st.programKeys.some((k) => k.endsWith("|entPart1|n0|xmar")) && st.programKeys.some((k) => k.endsWith("|entPart1|n0|xmare")), JSON.stringify(st.programKeys));
  for (const run of A._hbBatch.plan.runs) assert.equal(run.classEntry.material.userData.hbBatchMaps || "", run.row.maps.key);
  // The footprint counts the planes' layers.
  const own = new Set();
  for (const b of [A._hbBatch, B._hbBatch]) for (const r of b.plan.memberRefs.values()) for (const k of [r.contentKey, r.nrmKey, r.aoKey, r.rghKey]) if (k) own.add(k);
  assert.equal(st.footprint.ownLayers, own.size, "footprint: the AO / roughness layers are this consumer's");
  W = { w, mc, A, B, lumC };
});

await check("EM4 drift: aoMapIntensity rewrites the row; an AO re-upload / roughness swap / a plane leaving re-plans; an alias leaving demotes and re-plans", async () => {
  assert.ok(W, "premise: EM3 ran");
  const { w, mc, A, lumC } = W;
  const eb = w.em._entityBatch;
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const pages = KIT.kitPages(w.renderer);
  const a = mc.materials.get(D.A);
  // (a) aoMapIntensity (a value: no re-plan).
  const rp0 = eb.stats().replans;
  a.aoMapIntensity = 0.25;
  w.frame();
  let row = A._hbBatch.plan.memberRefs.get(a);
  assert.equal(LS.unpackMapState(table.rows.data, row.extRow * fpr).aoIntensity, F(0.25), "the row follows the member");
  assert.equal(eb.stats().replans, rp0, "no re-plan");
  assert.equal(A._hbBatch.status, "active");
  // (b) an AO re-upload: drift:map, onto a fresh copy.
  const ao = row.aoTex;
  const oldKey = row.aoKey;
  ao.needsUpdate = true;
  w.frame();
  assert.ok((eb.stats().replanReasons["drift:map"] || 0) >= 1, JSON.stringify(eb.stats().replanReasons));
  w.settle(80);
  assert.equal(A._hbBatch.status, "active");
  row = A._hbBatch.plan.memberRefs.get(a);
  assert.equal(row.aoKey, AP.contentKeyOf(ao), "the new upload's content");
  assert.ok(pages.alloc.refCount(oldKey) <= 0, "the stale copy released");
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  // (c) a roughness swap.
  const b = mc.materials.get(D.B);
  const r0 = eb.stats().replanReasons["drift:map"];
  const fresh = ADAPTER.surfacePixelsToRoughnessTexture(new Uint8Array(64 * 128).fill(90), 64, 128);
  b.roughnessMap = fresh;
  w.frame();
  assert.equal(eb.stats().replanReasons["drift:map"], r0 + 1);
  w.settle(80);
  assert.equal(A._hbBatch.status, "active");
  assert.equal(A._hbBatch.plan.memberRefs.get(b).rghTex, fresh, "re-planned onto the new plane");
  // (d) a plane that leaves: the member re-plans into the roughness-only set.
  const c = mc.materials.get(D.C);
  c.aoMap = null;
  c.needsUpdate = true;
  w.frame();
  assert.equal(eb.stats().replanReasons["drift:map"], r0 + 2);
  w.settle(80);
  assert.equal(A._hbBatch.status, "active");
  assert.equal(A._hbBatch.plan.memberRefs.get(c).maps.key, "|xmr");
  assert.equal(eb.stats().mapMembers.sets["|xmr"], 1);
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  // (e) the emissive alias leaves (the hook's restore): a luminous drift demotes, the poll re-plans on the new set.
  lumC.emissiveMap = null;
  lumC.needsUpdate = true;
  w.frame();
  assert.ok((eb.stats().demoteReasons["drift:luminous"] || 0) >= 1, JSON.stringify(eb.stats().demoteReasons));
  for (let i = 0; i < 80 && A._hbBatch.status !== "active"; i += 1) w.frame();
  assert.equal(A._hbBatch.status, "active");
  assert.ok((eb.stats().replanReasons["promote:changed"] || 0) >= 1, JSON.stringify(eb.stats().replanReasons));
  assert.equal(A._hbBatch.plan.memberRefs.get(lumC).maps.key, "|xmar");
  assert.equal(eb.stats().mapMembers.emissive, 0);
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  w.em._entityBatch.dispose();
});

await check("EM4b POM + planes: ONE extension row carries the POM half and the map half; a POM rig with planes goes active, verify clean", async () => {
  const mc = texCache({ pom: true, clamp: false });
  const w = await R.world(true, { materialCache: mc });
  const inst = await w.spawn(0x50000e05);
  w.settle(80);
  const eb = w.em._entityBatch;
  assert.equal(inst._hbBatch.status, "active", JSON.stringify(eb.stats().live));
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const both = [...inst._hbBatch.plan.memberRefs.values()].filter((r) => r.pomRow > 0 && r.aoKey);
  assert.ok(both.length >= 4, `POM + AO rows: ${both.length}`);
  for (const row of both) {
    assert.equal(row.pomRow, row.extRow, "the POM row IS the extension row");
    assert.equal(LS.unpackLayerState(table.rows.data, row.slot * fpr).extRow, row.extRow);
    const want = LS.packExtState(CM.pomStateOf(row.member, row.pom, row.pomLayer, {}),
      CM.extraMapStateOf(row.member, row.aoLayer, row.rghLayer, 0, {}), new Float32Array(16), 0);
    assert.deepEqual(Array.from(table.rows.data.slice(row.extRow * fpr, row.extRow * fpr + 16)), Array.from(want), "both halves");
    assert.equal(LS.unpackPomState(table.rows.data, row.extRow * fpr).layer, row.pomLayer);
    assert.equal(LS.unpackMapState(table.rows.data, row.extRow * fpr).aoIntensity, F(row.member.aoMapIntensity));
  }
  assert.ok(eb.stats().programKeys.some((k) => /\|pom1\|xmar$/.test(k)), JSON.stringify(eb.stats().programKeys));
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  eb.dispose();
});

let L = null;
await check("EM5 a late texchan record: legacy in that frame (the planes drawn by the legacy leaves), re-planned into the new set after the settle window, not churn", async () => {
  const mc = texCache({ texchan: { late: true } });
  const w = await R.world(true, { materialCache: mc });
  const inst = await w.spawn(0x50000e11);
  w.settle(80);
  const eb = w.em._entityBatch;
  const b = inst._hbBatch;
  assert.equal(b.status, "active");
  assert.equal(eb.stats().mapMembers.members, 0, "premise: no plane yet");
  assert.ok(mc.__texchan.pending() >= 5, "premise: the fetches are in flight");
  const replans0 = b.replans;
  const s0 = eb.stats();
  mc.__texchan.release();
  await settleMicro();
  for (const did of PLANE_DIDS) assert.ok(mc.materials.get(did).aoMap && mc.materials.get(did).roughnessMap, "premise: materials.js's async arm attached the planes in place");
  // The very frame: legacy, the planes drawn by the legacy leaves, no batch draw.
  w.gl.__fake.startSnapshots();
  w.frame();
  const snaps = w.gl.__fake.takeSnapshots().filter((s) => /^draw/.test(s.kind));
  const s1 = eb.stats();
  assert.equal(b.status, "pending", "handed back to legacy in that sync");
  assert.ok(/^drift:(ao|roughness)-map-arrived$/.test(b.reason), b.reason);
  assert.ok(!b.mesh && !b.plan, "no batch mesh, no plan");
  for (const leaf of R.leavesOf(inst)) assert.notEqual(leaf.userData.hbParked, true, "every leaf unparked");
  assert.equal(snaps.filter((s) => s.uniforms.hbBatchStateTex !== undefined).length, 0, "no batch draw in that frame");
  assert.ok(snaps.filter((s) => s.uniforms.aoMap !== undefined).length >= 10, "the legacy leaves draw the planes");
  assert.equal(s1.mapArrivals - s0.mapArrivals, 1, "one arrival for the burst");
  assert.equal((s1.replanReasons["drift:ao-map-arrived"] || 0) + (s1.replanReasons["drift:roughness-map-arrived"] || 0), 1, JSON.stringify(s1.replanReasons));
  assert.equal(b.replans, replans0, "not churn");
  assert.equal(b.retryFrame - eb._frameNo, EB.ENTITY_BATCH_MAP_SETTLE_FRAMES);
  w.frame(EB.ENTITY_BATCH_MAP_SETTLE_FRAMES - 2);
  assert.equal(b.status, "pending", "the burst settles first");
  w.settle(80);
  assert.equal(b.status, "active");
  const st = eb.stats();
  assert.deepEqual(st.mapMembers, { members: 5, ao: 5, roughness: 5, emissive: 0, sets: { "|xmar": 5 } }, `re-planned into the AO + roughness set: ${JSON.stringify(st.mapMembers)}`);
  assert.equal(b.replans, replans0, "still not churn");
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  L = { w, mc, inst };
});

await check("EM6 verify().mapMismatches catches a corrupt map half and a stale plane", () => {
  assert.ok(L, "premise: EM5 ran");
  const { w, mc, inst } = L;
  const eb = w.em._entityBatch;
  const table = KIT.kitStateTable();
  const fpr = table.rows.floatsPerRow;
  const row = mapRows(inst._hbBatch)[0];
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  const o = row.extRow * fpr + 10; // texel 2 .z: aoMapIntensity
  const keep = table.rows.data[o];
  table.rows.data[o] = keep + 0.5;
  let v = eb.verify();
  assert.equal(v.mapMismatches, 1, JSON.stringify(v));
  assert.equal(v.pomMismatches + v.stateMismatches, 0, "only the map half");
  w.frame();
  assert.equal(table.rows.data[o], keep, "the sync rewrote it");
  assert.equal(eb.verify().mapMismatches, 0);
  // A plane the row does not sample (checked before any sync could re-plan).
  const m = row.member;
  const real = m.aoMap;
  m.aoMap = ADAPTER.surfacePixelsToAoTexture(new Uint8Array(64 * 64).fill(200), 64, 64);
  v = eb.verify();
  assert.ok(v.mapMismatches >= 1 && v.details.some((d) => d.startsWith("planes")), JSON.stringify(v));
  m.aoMap = real;
  assert.equal(eb.verify().mapMismatches, 0);
  eb.dispose();
  void mc;
});

await check("EM7 page-full: a refused AO layer keeps its member a legacy leaf (no churn); the retry reads the planes; the cap freeing batches every member", async () => {
  const mc = texCache();
  const w = await R.world(true, { materialCache: mc });
  const pages = KIT.kitPages(w.renderer);
  const admit = pages.admit;
  let block = true;
  // The kit's byte cap refusing every R8 plane (array_pages.js admit -> null, lastRefusal "cap").
  pages.admit = function blockedAdmit(tex, budget, opts) {
    if (block && opts && opts.r8 && tex.format === THREE.RedFormat) { this.lastRefusal = "cap"; return null; }
    return admit.call(this, tex, budget, opts);
  };
  const inst = await w.spawn(0x50000e21);
  w.frame(40);
  const eb = w.em._entityBatch;
  const b = inst._hbBatch;
  assert.equal(b.status, "active", "the rest of the rig batches");
  const pageFull = b.plan.legacy.filter((c) => c.reason === "pageFull");
  assert.deepEqual([...new Set(pageFull.map((c) => c.did))].sort(), [...PLANE_DIDS].sort(), "the AO members stay legacy leaves");
  for (const c of pageFull) assert.notEqual(c.leaf.userData.hbParked, true, "drawn as legacy");
  assert.equal(eb.stats().mapMembers.members, 0);
  assert.ok(eb.stats().layers.refusedMembers >= 5);
  assert.equal(b.replans, 0, "no churn");
  for (const did of PLANE_DIDS) assert.ok(pages.alloc.refCount(AP.contentKeyOf(mc.materials.get(did).map)) <= 0, `${did.toString(16)}: its map layer released`);
  // The retry check reads the planes.
  const wa = pages.alloc.wouldAcquire;
  pages.alloc.wouldAcquire = function (desc, key) { return desc.format === "r8" ? false : wa.call(this, desc, key); };
  assert.equal(eb._refusedWouldFit(b, pages), false, "an AO plane the cap cannot take: no retry");
  pages.alloc.wouldAcquire = wa;
  assert.equal(eb._refusedWouldFit(b, pages), true);
  // The cap takes them: the retry re-plans with every member.
  block = false;
  for (let i = 0; i < EB.ENTITY_BATCH_PAGEFULL_RETRY_FRAMES + 80 && !(b.status === "active" && b.plan.legacy.every((c) => c.reason !== "pageFull")); i += 1) w.frame();
  assert.equal(b.status, "active");
  assert.equal(eb.stats().mapMembers.members, 5, JSON.stringify(eb.stats().mapMembers));
  assert.ok((eb.stats().replanReasons["pageFull:retry"] || 0) >= 1);
  assert.equal(b.replans, 0, "no churn");
  assert.deepEqual(verifyZero(eb.verify()), [0, 0, 0, 0, 0, 0]);
  pages.admit = admit;
  eb.dispose();
});

await check("EM8 the smoke's maps arm + the AO / roughness layers readback dry-run; the page and the runner carry them", async () => {
  const mods = {
    entities: { EntityManager: R.EntityManager }, entityBatch: EB, kit: KIT, materials: M, adapter: ADAPTER,
    selectionLighting: await import("../scene3d/selection_lighting.js"),
  };
  const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
  const mk = () => { const gl = createFakeWebGL2(); return new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl }); };
  const off = await LIB.runEntityArm(THREE, mk(), mods, { arm: "maps", batch: false, frames: 12 });
  const offR = globalThis.window.liveScene3d.renderer;
  offR.render(off.scene, off.camera);
  const offCalls = offR.info.render.calls;
  const on = await LIB.runEntityArm(THREE, mk(), mods, { arm: "maps", batch: true, frames: 12 });
  const r = globalThis.window.liveScene3d.renderer;
  r.render(on.scene, on.camera);
  assert.deepEqual(on.status, ["active", "active"]);
  assert.ok(r.info.render.calls < offCalls, `${r.info.render.calls} < ${offCalls}`);
  assert.ok(on.stats.mapMembers.ao >= 5 && on.stats.mapMembers.roughness >= 5, JSON.stringify(on.stats.mapMembers));
  assert.ok(on.stats.leafRoutes.luminous >= 2 && on.stats.leafRoutes.translucent >= 2, JSON.stringify(on.stats.leafRoutes));
  assert.deepEqual(on.stats.extraMaps, {});
  assert.deepEqual(verifyZero(on.verify), [0, 0, 0, 0, 0, 0], JSON.stringify(on.verify));
  assert.ok(on.stats.programKeys.some((k) => /\|xmar$/.test(k)));
  const Lb = await LIB.runEntityArm(THREE, mk(), mods, { arm: "humans", batch: true, frames: 12, maps: true });
  const lb = LIB.readbackLayers(Lb.em._entityBatch, KIT.kitPages(globalThis.window.liveScene3d.renderer));
  assert.ok(lb.ao >= 5 && lb.roughness >= 5 && lb.levels > lb.layers && lb.mismatched === 0, JSON.stringify(lb));
  const page = fs.readFileSync(new URL("../harness/glsl_smoke/entity_batch_page.html", import.meta.url), "utf8");
  assert.ok(page.includes('q.get("maps") === "1"') && /runEntityArm\([^)]*maps, pom \}/.test(page) && page.includes("mapMembers: r.stats.mapMembers"), "the page passes maps through");
  const runner = fs.readFileSync(new URL("../harness/glsl_smoke/entity_batch_smoke.mjs", import.meta.url), "utf8");
  assert.ok(runner.includes('run("?arm=layers&maps=1")') && /\n  maps: \{ status: \["active", "active"\]/.test(runner) && runner.includes("if (want.maps)"), "the runner loads the maps arms and gates them");
});

done();
