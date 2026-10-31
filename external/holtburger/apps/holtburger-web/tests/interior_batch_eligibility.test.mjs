// tests/interior_batch_eligibility.test.mjs — R3-5 `?interiorBatch` eligibility
// (scene3d/gpu_batch/interior_batch.js; design §2.3, proof §6.1).
//
//   E1  chain keys: k1d (baked EnvCell structure), s1 (static depth bias),
//       l0 / l1 (light clamp) and (2026-10-31) p1 (POM: flag-only or the
//       real patch, the dry run decides — tests/interior_batch_pom.test.mjs)
//       are accepted; d1 (detail), c2 (CSM), a1 (AO), b1 (depth bias), f1
//       (floor bias), |e2 (env detail) and a VFX component set are refused —
//       on the key regex AND on materials carrying the real installers
//       (materials.js) where they exist.
//   E2  the chain fingerprint: equal for every clone of one cache family
//       (getCachedCellBaked of two surfaces), different between families
//       whose program keys claim the same light clamp (the baked clone lost
//       the clamp chain: Material.copy drops onBeforeCompile); a
//       texture-valued chain uniform refuses the member — except the POM
//       patch's height map (2026-10-31: slot data, fingerprinted by name).
//   E3  member reasons: alpha / light maps, an emissiveMap other than the
//       map, a luminous emissive without one, an AO / roughness plane a page
//       cannot hold (2026-10-31: page-describable AO / roughness planes and the
//       luminous ladder's emissive alias are accepted, tests/
//       interior_batch_maps.test.mjs), an R8 map, a non-identity uv transform, transparent,
//       invisible, blending, polygon offset; mesh reasons: instanced,
//       frustumCulled off, an own boundingSphere, a layer other than the
//       container's, an attribute outside {position, normal, uv,
//       acBakedLight}, a render hook.
//   E4  the draw class: alphaTest > 0 -> alphaTest; FrontSide -> front;
//       __acBakedLight -> baked (the class is then built with the member's
//       baked chain); the batch keys differ per class and per kind.
//   E5  REAL client_portal.dat surfaces through the MaterialCache ladders
//       (`_materialFromFlags`, then the getCachedCellBaked / getCachedStaticBias
//       clones cells.js draws with): every transparent / additive one is
//       refused for its own reason, every luminous one is accepted as an
//       emissive-alias member (2026-10-31); every accepted member's kit slot
//       row equals layerStateFromMaterial (field for field at f32); for every
//       accepted chain the class patch (every extra-map set too), the
//       collapse anchor and the depth patch find all their stock lines
//       (classPatchMissing === 0).
//
// Fixture: ~/ac_base_dats/client_portal.dat (HB_PORTAL_DAT overrides); E5
// FAILS loudly when it is missing.
//
// Run: node tests/interior_batch_eligibility.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { openPortalDat } from "../tools/clip-alpha-gate.mjs";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.location ??= { search: "" };

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { classPatchMissing, mapSetOf } = await import("../scene3d/gpu_batch/class_materials.js");
const { memberChainHook } = await import("../scene3d/gpu_batch/anim_scenery_batch.js");

const PORTAL_DAT = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const tex = (w = 8, h = 8, seed = 1) => {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 29 + seed) & 255;
  return adapter.surfacePixelsToTexture(px, w, h);
};
const keyed = (key) => {
  const m = new THREE.MeshStandardMaterial({ map: tex(), side: THREE.DoubleSide });
  m.onBeforeCompile = function () {};
  m.customProgramCacheKey = () => key;
  return m;
};

await t("E1 chain keys: accept k1d / s1 / l0 / l1 / p1, refuse d1 c2 a1 b1 f1 e2 and VFX sets", () => {
  const base = (o = {}) => `hb|d${o.d ?? 0}|c${o.c ?? 0}|p${o.p ?? 0}|l${o.l ?? 1}|a${o.a ?? 0}|b${o.b ?? 0}|f${o.f ?? 0}|s${o.s ?? 0}|k${o.k ?? 0}|v${o.v ?? ""}${o.e ? "|e" + o.e : ""}`;
  for (const k of [base(), base({ l: 0 }), base({ k: "1d" }), base({ k: 1 }), base({ s: 1 }), base({ s: 1, l: 0 }), base({ p: 1 }), base({ k: "1d", p: 1 }), base({ s: 1, p: 1 })]) {
    assert.ok(IB.INTERIOR_CHAIN_KEY.test(k), k);
    assert.equal(IB.interiorArrayReason(keyed(k)), null, k);
  }
  for (const k of [base({ d: 1 }), base({ c: 2 }), base({ a: 1 }), base({ b: 1 }), base({ f: 1 }), base({ e: 2 }), base({ v: "windSway:1" }), base({ d: 1, p: 1 })]) {
    assert.equal(IB.INTERIOR_CHAIN_KEY.test(k), false, k);
    assert.equal(IB.interiorArrayReason(keyed(k)), "shader-chain", k);
  }
  // The real installers.
  const real = (fn) => { const m = new THREE.MeshStandardMaterial({ map: tex(), side: THREE.DoubleSide }); fn(m); return m; };
  assert.equal(IB.interiorArrayReason(real((m) => M.applyStaticDepthBias(m))), null, "s1");
  assert.equal(IB.interiorArrayReason(real((m) => M.applyBakedVertexLightPatch(m, { suppressDirect: true }))), null, "k1d");
  assert.equal(IB.interiorArrayReason(real((m) => M.installLightClampShaderPatch(m))), null, "l1");
  assert.equal(IB.interiorArrayReason(real((m) => M.applyFloorDepthBias(m))), "shader-chain", "f1");
  const h = adapter.surfacePixelsToHeightTexture(new Uint8Array(64).fill(100), 8, 8);
  const pom = real((m) => M.installPomShaderPatch(m, h, {}));
  assert.equal(IB.interiorArrayReason(pom), null, "p1 passes the key gate");
  assert.equal(IB.interiorPomReason(pom, IB.chainFingerprintId(pom).pom), "pom-no-normal", "p1 without a normal map: the POM gate refuses");
  // A chain without a key (or a key without a chain) is unknown: refused.
  const half = new THREE.MeshStandardMaterial({ map: tex() });
  half.onBeforeCompile = function () {};
  assert.equal(IB.interiorArrayReason(half), "shader-chain");
});

await t("E2 fingerprints: one per cache family, the lost clamp shows, a texture uniform refuses", () => {
  const mc = new M.MaterialCache();
  for (const did of [0x08000a01, 0x08000a02]) mc.materials.set(did, mc._materialFromFlags(0x2, tex(8, 8, did & 255), undefined, null, undefined, null, { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true }));
  const bk1 = mc.getCachedCellBaked(0x08000a01), bk2 = mc.getCachedCellBaked(0x08000a02);
  const sb1 = mc.getCachedStaticBias(0x08000a01), sb2 = mc.getCachedStaticBias(0x08000a02);
  const b1 = mc.materials.get(0x08000a01);
  const fp = (m) => IB.chainFingerprintId(m);
  assert.equal(fp(bk1).id, fp(bk2).id, "baked family: one fingerprint");
  assert.equal(fp(sb1).id, fp(sb2).id, "static-bias family: one fingerprint");
  assert.notEqual(fp(bk1).id, fp(sb1).id);
  // The base carries the real light clamp; its baked clone claims l1 too but lost it.
  assert.ok(b1.customProgramCacheKey().includes("|l1|") && bk1.customProgramCacheKey().includes("|l1|"), "premise: both keys claim l1");
  assert.notEqual(fp(b1).id, fp(bk1).id, "the fingerprint sees the chain, not the flag");
  const raw = IB.chainFingerprint(b1).fp;
  assert.ok(raw.includes("uLightColorClamp=n1"), "numeric uniform values are part of it");
  // A texture-valued chain uniform refuses the member; the POM height map is
  // slot data (fingerprinted by name, its texture handed back as `pom`).
  const pom = new THREE.MeshStandardMaterial({ map: tex() });
  const hp = adapter.surfacePixelsToHeightTexture(new Uint8Array(64).fill(9), 8, 8);
  M.installPomShaderPatch(pom, hp, {});
  const pf = IB.chainFingerprint(pom);
  assert.ok(!pf.reason && pf.fp.includes("uPomMap=slot") && pf.pom.texture === hp, "POM: fingerprinted, the height map handed back");
  const texU = new THREE.MeshStandardMaterial({ map: tex() });
  texU.onBeforeCompile = function texChain(sh) { sh.uniforms.uTile = { value: tex() }; };
  assert.equal(IB.chainFingerprint(texU).reason, "chain-uniform:uTile", "any other texture uniform still refuses");
  // A member's live userData handles are left exactly as they were.
  const before = Object.getOwnPropertyDescriptor(bk1.userData, "acBakedLightUniforms");
  IB.chainFingerprint(bk1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(bk1.userData, "acBakedLightUniforms"), before);
  // Cached per member + version: a needsUpdate recomputes.
  const id0 = fp(sb1).id;
  sb1.needsUpdate = true;
  assert.equal(fp(sb1).id, id0);
});

await t("E3 member and mesh reasons", () => {
  const ok = () => new THREE.MeshStandardMaterial({ map: tex(), side: THREE.DoubleSide });
  const mk = (f) => { const m = ok(); f(m); return IB.interiorArrayReason(m); };
  assert.equal(IB.interiorArrayReason(ok()), null, "control");
  // 2026-10-31 (AO / roughness / emissive members, tests/interior_batch_maps.test.mjs):
  // a page-describable roughness / AO plane and an emissiveMap that IS the map batch
  // through a class map set; every other extra map, a foreign emissiveMap and a
  // luminous member without one still refuse.
  assert.equal(mk((m) => { m.roughnessMap = tex(); }), null, "roughness plane: a class map set");
  assert.equal(mk((m) => { m.aoMap = tex(); }), null, "AO plane: a class map set");
  assert.equal(mk((m) => { m.emissiveMap = m.map; m.emissive.setRGB(1, 1, 1); }), null, "the luminous ladder's emissive alias");
  assert.equal(mk((m) => { m.aoMap = tex(); m.aoMap.repeat.set(2, 2); m.aoMap.updateMatrix(); }), "ao-map-format", "AO uv transform");
  assert.equal(mk((m) => { m.roughnessMap = adapter.surfacePixelsToHeightTexture(new Uint8Array(64), 8, 8); }), "roughness-map-format", "R8 roughness");
  assert.equal(mk((m) => { m.alphaMap = tex(); }), "map:alphaMap");
  assert.equal(mk((m) => { m.lightMap = tex(); m.aoMap = tex(); }), "map:lightMap");
  assert.equal(mk((m) => { m.emissiveMap = tex(); }), "map:emissiveMap", "an emissiveMap that is not the map");
  assert.equal(mk((m) => { m.emissive.setRGB(1, 1, 1); }), "luminous");
  assert.equal(mk((m) => { m.map = adapter.surfacePixelsToHeightTexture(new Uint8Array(64), 8, 8); }), "map-format", "R8");
  assert.equal(mk((m) => { m.map.repeat.set(2, 2); m.map.updateMatrix(); }), "map-format", "uv transform");
  assert.equal(mk((m) => { m.transparent = true; }), "transparent");
  assert.equal(mk((m) => { m.visible = false; }), "invisible");
  assert.equal(mk((m) => { m.blending = THREE.AdditiveBlending; }), "blending");
  assert.equal(mk((m) => { m.polygonOffset = true; }), "raster-state");
  assert.equal(mk((m) => { m.map = null; }), "no-map");
  assert.equal(IB.interiorArrayReason(new THREE.MeshPhysicalMaterial({ map: tex() })), "type");
  assert.equal(IB.interiorArrayReason(new THREE.MeshBasicMaterial({ map: tex() })), "type");
  // Meshes.
  const container = new THREE.Group();
  container.layers.set(1);
  const geo = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
    return g;
  };
  const mesh = (f) => { const m = new THREE.Mesh(geo(), ok()); m.layers.set(1); if (f) f(m); return IB.interiorMeshReason(m, container); };
  assert.equal(mesh(), null, "control");
  assert.equal(IB.interiorMeshReason(new THREE.InstancedMesh(geo(), ok(), 2), null), "kind");
  assert.equal(mesh((m) => { m.frustumCulled = false; }), "frustum-culled-off");
  assert.equal(mesh((m) => { m.boundingSphere = new THREE.Sphere(); }), "own-sphere");
  assert.equal(mesh((m) => { m.layers.set(2); }), "layers");
  assert.equal(mesh((m) => { m.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9), 3)); }), "attribute:color");
  assert.equal(mesh((m) => { m.onBeforeRender = () => {}; }), "render-hooks");
  assert.equal(mesh((m) => { m.visible = false; }), "invisible");
  assert.equal(mesh((m) => { m.renderOrder = 3; }), "render-order");
  assert.equal(mesh((m) => { m.geometry.deleteAttribute("uv"); }), "attribute-set");
});

await t("E4 class and side mapping; per-class batch keys", () => {
  const mc = new M.MaterialCache();
  mc.materials.set(0x08000b01, mc._materialFromFlags(0x2, tex(), undefined, null, undefined, null, { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true }));
  mc.materials.set(0x08000b02, mc._materialFromFlags(0x4, tex(), undefined, null, undefined, null, { translucency: 0, luminosity: 0, diffuse: 1, hasPalette: true }));
  const cls = (m) => IB.interiorMemberClass(m);
  assert.deepEqual(cls(mc.getCachedCellBaked(0x08000b01)), { blend: "opaque", light: "baked", side: "double" });
  assert.deepEqual(cls(mc.getCachedStaticBias(0x08000b01)), { blend: "opaque", light: "lit", side: "double" });
  assert.deepEqual(cls(mc.getCachedStaticBias(0x08000b02)), { blend: "alphaTest", light: "lit", side: "double" });
  assert.ok(mc.getCachedStaticBias(0x08000b02).alphaTest > 0, "premise: ClipMap -> alpha ref");
  const front = new THREE.MeshStandardMaterial({ map: tex(), side: THREE.FrontSide });
  assert.equal(cls(front).side, "front");
  // Signatures separate raster state that is not slot data.
  const a = new THREE.MeshStandardMaterial({ map: tex() });
  const b = new THREE.MeshStandardMaterial({ map: tex() });
  assert.equal(IB.interiorMemberSignature(a), IB.interiorMemberSignature(b));
  b.depthWrite = false;
  assert.notEqual(IB.interiorMemberSignature(a), IB.interiorMemberSignature(b));
});

// --- E5 -------------------------------------------------------------------------
await t("E5 premise: the retail portal DAT is present", () => {
  assert.ok(fs.existsSync(PORTAL_DAT), `fixture missing: ${PORTAL_DAT} (set HB_PORTAL_DAT)`);
});

function readSurfaces() {
  const dat = openPortalDat(PORTAL_DAT);
  const out = [];
  try {
    for (const id of dat.ids(0x08)) {
      const b = dat.read(id);
      if (!b || b.length < 16) continue;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const flags = v.getUint32(0, true);
      const textured = (flags & (LS.SURFACE_BITS.Base1Image | LS.SURFACE_BITS.Base1ClipMap)) !== 0;
      if (!textured) continue; // the interior batch needs a map
      out.push({ id, flags, translucency: v.getFloat32(12, true), luminosity: v.getFloat32(16, true), diffuse: v.getFloat32(20, true), hasPalette: (id & 1) === 0 });
    }
  } finally { dat.close(); }
  return out;
}

await t("E5 real surfaces through the MaterialCache ladders: reasons, slot rows = layerStateFromMaterial, every accepted chain complete", () => {
  if (!fs.existsSync(PORTAL_DAT)) throw new Error("portal DAT missing");
  const surfaces = readSurfaces();
  assert.ok(surfaces.length > 3000, `textured surfaces read: ${surfaces.length}`);
  KIT.resetKit();
  const table = KIT.kitStateTable();
  const mc = new M.MaterialCache();
  const shared = tex(4, 4, 3);
  const reasons = {};
  const chains = new Map(); // fp id -> member
  let accepted = 0, rows = 0;
  const bad = [];
  const B = LS.SURFACE_BITS;
  for (const s of surfaces) {
    const base = mc._materialFromFlags(s.flags, shared, undefined, null, undefined, null, { translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette });
    mc.materials.set(s.id >>> 0, base);
    const members = [base, mc.getCachedCellBaked(s.id >>> 0), mc.getCachedStaticBias(s.id >>> 0)];
    for (const m of members) {
      const r = IB.interiorArrayReason(m);
      const want = (s.flags & (B.Translucent | B.Additive | B.Alpha | B.InvAlpha)) ? "transparent"
        : (s.luminosity > 0 ? "luminous" : null);
      if (want === "transparent" && r !== "transparent") bad.push(`0x${s.id.toString(16)} flags 0x${s.flags.toString(16)}: ${r} (want transparent)`);
      if (want === null && r !== null) bad.push(`0x${s.id.toString(16)} flags 0x${s.flags.toString(16)}: refused ${r}`);
      // 2026-10-31: the luminous ladder aliases the map as emissiveMap -> an emissive class.
      if (want === "luminous" && !(r === null && m.emissiveMap && m.emissiveMap === m.map)) bad.push(`0x${s.id.toString(16)}: ${r} (want an emissive-alias member)`);
      reasons[r || "accepted"] = (reasons[r || "accepted"] || 0) + 1;
      if (r) continue;
      accepted += 1;
      const fp = IB.chainFingerprintId(m);
      assert.ok(fp.id, `fingerprint for 0x${s.id.toString(16)}`);
      if (!chains.has(fp.id)) chains.set(fp.id, m);
      // The slot row the batch writes for this member.
      const slot = table.addFromMaterial(m, 9, null, 2);
      assert.ok(slot > 0);
      const u = LS.unpackLayerState(table.rows.data, slot * table.rows.floatsPerRow);
      const st = LS.layerStateFromMaterial(m);
      if (!LS.sameSurfaceState(st, u) || u.layer !== 9 || u.normalLayer !== 2) bad.push(`row 0x${s.id.toString(16)}: ${LS.surfaceStateDiff(st, u).join(", ")}`);
      table.remove(slot);
      rows += 1;
      const cls = IB.interiorMemberClass(m);
      if ((s.flags & B.Base1ClipMap) && !(s.flags & (B.Translucent | B.Additive | B.Alpha | B.InvAlpha)) && cls.blend !== "alphaTest") bad.push(`0x${s.id.toString(16)}: ClipMap not alphaTest`);
    }
  }
  console.log(`      surfaces ${surfaces.length}, members ${surfaces.length * 3}, accepted ${accepted}, chains ${chains.size}, reasons ${JSON.stringify(reasons)}`);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} disagreements`);
  assert.ok(accepted > 1000 && rows === accepted);
  assert.ok(chains.size >= 3, "base (clamp), baked clone, static-bias clone");
  for (const [id, m] of chains) {
    for (const withNormal of [false, true]) assert.equal(classPatchMissing({ chain: memberChainHook(m), withNormal }), 0, `class patch complete for chain ${id} (normal ${withNormal})`);
    // Every map set (AO, roughness, emissive: header "EXTRA-MAP MEMBERS") on every accepted chain.
    for (let i = 1; i < 8; i += 1) {
      const maps = mapSetOf((i & 1) !== 0, (i & 2) !== 0, (i & 4) !== 0);
      assert.equal(classPatchMissing({ chain: memberChainHook(m), withNormal: true, maps }), 0, `class patch complete for chain ${id}, set ${maps.key}`);
    }
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} };
    const hook = memberChainHook(m);
    if (hook) hook.call(new THREE.MeshStandardMaterial(), shader, null);
    assert.equal(IB.injectIbColorHook(shader), true, `collapse anchor survives chain ${id}`);
  }
  assert.equal(IB.depthPatchMissing(false), 0);
  assert.equal(IB.depthPatchMissing(true), 0);
  KIT.resetKit();
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
