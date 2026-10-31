// tests/entity_batch_state.test.mjs — R3-4 stage A `?entityBatch`: which
// entity surfaces batch, in which class, with which state row — over EVERY
// Surface (0x08) of the retail client_portal.dat (decoded as
// tests/gpu_batch_state_table.test.mjs does), for both entity material
// ladders:
//   - the RECOLORED ladder: the material entities.js builds
//     (MeshStandardMaterial map / roughness 0.9 / DoubleSide) + the REAL
//     `EntityManager.prototype._applyPalettedSurfaceRenderState`;
//   - the CACHE ladder: MaterialCache._materialFromFlags (+ the retail light
//     clamp the cache's default patch set carries).
// For each built member, as a leaf Mesh:
//   1. `leafRouteReason` keeps translucent / additive surfaces legacy (that
//      blend class, including every `materialRendersNothing` one) and
//      luminous ones legacy (the class patch does not redirect emissive);
//      every other textured surface batches;
//   2. a batched member's class is its `blendClassOf` class (opaque /
//      alpha-tested), and the state row the batch writes for it
//      (kitStateTable().addFromMaterial — the row `hbBatchSlot` names) is
//      packLayerState(layerStateFromSurface(surface, env, ladder)) at f32 in
//      every SetSurface field (alpha-test ref incl. the paletted 100/255 and
//      DDS 200/255 ClipMap refs, opacity, luminosity, diffuse, flags);
//   3. the per-tick member drift (`_memberDrift`) catches a map swap, a map
//      upload (version), a blend / alpha-class / side / luminous / chain /
//      raster change, and treats `visible = false` as a collapse (no drift).
//
// Fixture: ~/ac_base_dats/client_portal.dat (HB_PORTAL_DAT overrides); FAILS
// loudly when missing (the gate entry carries a `requires`).
//
// Run from apps/holtburger-web/:  node tests/entity_batch_state.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const { THREE, EB, M, KIT, ADAPTER } = R;
const LS = await import("../scene3d/gpu_batch/layer_state.js");
const ASB = await import("../scene3d/gpu_batch/anim_scenery_batch.js");
const { openPortalDat } = await import("../tools/clip-alpha-gate.mjs");
const { check, done } = R.suite("entity_batch_state");
const PORTAL_DAT = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";

await check("0. the batch module exists", () => R.requireBatch());
await check("premise: the retail portal DAT is present", () => assert.ok(fs.existsSync(PORTAL_DAT), `fixture missing: ${PORTAL_DAT}`));

// --- DAT decode (tests/gpu_batch_state_table.test.mjs's walker) -------------
const PALETTED_FORMATS = new Set([41, 101]);
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
      const off = textured ? 12 : 8;
      const s = { id, flags, textured, translucency: v.getFloat32(off, true), luminosity: v.getFloat32(off + 4, true), diffuse: v.getFloat32(off + 8, true), hasPalette: false };
      if (textured) {
        const st = dat.read(v.getUint32(4, true));
        if (st && st.length >= 13) {
          const tv = new DataView(st.buffer, st.byteOffset, st.byteLength);
          const n = tv.getInt32(9, true);
          if (n > 0 && 13 + 4 * n <= st.length) {
            const rs = dat.read(tv.getUint32(13 + 4 * (n - 1), true));
            if (rs && rs.length >= 20) s.hasPalette = PALETTED_FORMATS.has(new DataView(rs.buffer, rs.byteOffset, rs.byteLength).getUint32(16, true));
          }
        }
      }
      out.push(s);
    }
  } finally { dat.close(); }
  return out;
}
const SURFACES = fs.existsSync(PORTAL_DAT) ? readSurfaces() : [];

const em = new R.EntityManager({ entitiesGroup: new THREE.Group(), materialCache: null }, {});
const mc = new M.MaterialCache();
const px = new Uint8Array(16 * 16 * 4).fill(200);
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
function build(s, ladder) {
  const tex = ADAPTER.surfacePixelsToTexture(px, 16, 16);
  let mat;
  if (ladder === "paletted") {
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false });
    em._applyPalettedSurfaceRenderState(mat, { surfaceType: s.flags, translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette });
  } else {
    mat = mc._materialFromFlags(s.flags, tex, undefined, undefined, undefined, undefined,
      { translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette });
    if (mat.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) M.installLightClampShaderPatch(mat);
  }
  const leaf = new THREE.Mesh(geo, mat);
  leaf.userData = { surfaceDid: s.id };
  return { mat, leaf };
}

const tally = { paletted: { batch: 0, translucent: 0, additive: 0, luminous: 0, nothing: 0, opaque: 0, alphaTest: 0 }, cache: { batch: 0, translucent: 0, additive: 0, luminous: 0, nothing: 0, opaque: 0, alphaTest: 0 } };

await check("1-2. every textured Surface: routed by blend class / luminosity; batched rows equal the decoder's", () => {
  assert.ok(SURFACES.length > 6000, `surfaces: ${SURFACES.length}`);
  KIT.resetKit();
  const table = KIT.kitStateTable();
  const env = LS.DEFAULT_SURFACE_ENV;
  const scratch = LS.layerStateFromMaterial(null);
  const want = new Float32Array(LS.LAYER_STATE_FLOATS);
  let checked = 0;
  for (const s of SURFACES) {
    if (!s.textured) continue;
    for (const ladder of ["paletted", "cache"]) {
      const { mat, leaf } = build(s, ladder);
      const st = LS.layerStateFromSurface(s, env, ladder);
      const cls = LS.blendClassOf(st);
      const route = EB.leafRouteReason(leaf, null, scratch);
      const t = tally[ladder];
      if (M.materialRendersNothing(mat)) { t.nothing += 1; assert.ok(route === "translucent" || route === "additive", `${s.id.toString(16)} ${ladder}: renders nothing -> ${route}`); }
      if (cls === "translucent" || cls === "additive") {
        assert.equal(route, cls, `${s.id.toString(16)} ${ladder}`);
        t[cls] += 1;
        continue;
      }
      if (st.luminosity > 0) {
        assert.ok(route === "luminous" || route === "map:emissiveMap", `${s.id.toString(16)} ${ladder}: luminous -> ${route}`);
        t.luminous += 1;
        continue;
      }
      assert.equal(route, null, `${s.id.toString(16)} ${ladder}: a textured ${cls} surface batches`);
      t.batch += 1;
      assert.equal(ASB.memberClass(mat).blend, cls, `${s.id.toString(16)} ${ladder}: class`);
      t[cls] += 1;
      const layer = 3;
      const row = table.addFromMaterial(mat, layer, null, 0);
      assert.ok(row > 0);
      LS.packLayerState(st, layer, want, 0, 0);
      const d = table.rows.data;
      for (let k = 0; k < LS.LAYER_STATE_FLOATS; k += 1) {
        if (k >= 4 && k <= 7) continue; // roughness / metalness / normalScale: per-ladder PBR scalars, not SetSurface
        assert.equal(d[row * LS.LAYER_STATE_FLOATS + k], want[k], `${s.id.toString(16)} ${ladder}: row float ${k}`);
      }
      table.remove(row);
      checked += 1;
    }
  }
  console.log(`    ${JSON.stringify(tally)}`);
  for (const l of ["paletted", "cache"]) {
    assert.ok(tally[l].batch > 3000 && tally[l].alphaTest > 100 && tally[l].translucent > 100 && tally[l].additive > 10 && tally[l].luminous > 10, `${l}: every route seen`);
  }
  assert.ok(checked > 6000);
});

await check("3. the per-tick member drift", () => {
  const eb = new EB.EntityBatch({ scene3d: {} }, { diagGlobal: false, env: () => ({}) });
  const base = () => {
    const m = new THREE.MeshStandardMaterial({ map: ADAPTER.surfacePixelsToTexture(px, 16, 16), side: THREE.DoubleSide });
    return { member: m, map: m.map, mapVersion: m.map.version, normalMap: null, nrmVersion: -1, snap: eb._snapshotMember(m) };
  };
  const cases = [
    ["map swap", (m) => { m.map = ADAPTER.surfacePixelsToTexture(px, 16, 16); }, "drift:map"],
    ["map upload", (m) => { m.map.needsUpdate = true; }, "drift:map"],
    ["normal map", (m) => { m.normalMap = ADAPTER.surfacePixelsToTexture(px, 16, 16); }, "drift:map"],
    ["transparent", (m) => { m.transparent = true; }, "drift:blend"],
    ["blending", (m) => { m.blending = THREE.AdditiveBlending; }, "drift:blend"],
    ["alpha class", (m) => { m.alphaTest = 0.5; }, "drift:blend"],
    ["side", (m) => { m.side = THREE.FrontSide; }, "drift:side"],
    ["emissive", (m) => { m.emissive.setRGB(0.3, 0.3, 0.3); }, "drift:luminous"],
    ["emissiveMap", (m) => { m.emissiveMap = m.map; }, "drift:luminous"],
    ["chain", (m) => { M.installLightClampShaderPatch(m); }, "drift:chain"],
    ["depthWrite", (m) => { m.depthWrite = false; }, "drift:raster"],
    ["fog", (m) => { m.fog = false; }, "drift:raster"],
    ["visible false: a collapse, not a drift", (m) => { m.visible = false; }, null],
    ["opacity / colour: the state row follows", (m) => { m.opacity = 0.5; m.color.setRGB(0.5, 0.6, 0.7); m.needsUpdate = true; }, null],
  ];
  for (const [name, mut, want] of cases) {
    const row = base();
    assert.equal(eb._memberDrift(row), null, `${name}: clean before`);
    mut(row.member);
    assert.equal(eb._memberDrift(row), want, name);
  }
});

done();
