// tests/gpu_batch_state_table.test.mjs — R3-3 K1: the layer state table on
// REAL data (scene3d/gpu_batch/layer_state.js; docs/2026-10-29-round3-gpu-
// driven.md §R3-3 item 2 and its node proof).
//
// Every Surface (0x08) record in the retail client_portal.dat is decoded
// here (type bits, T / L / D floats, and the palettedness of its highest-res
// RenderSurface — the same `highest_res()` rung lib.rs reads for
// `SurfacePixels.hasPalette`), then fed to BOTH of today's ladders:
//   - the cache ladder, `MaterialCache._materialFromFlags` (materials.js);
//   - the paletted ladder, entities.js `_applyPalettedSurfaceRenderState`
//     (the real method body, spliced from the source as tests/luminous_hook
//     does), on the material entities.js constructs for it;
// and the state each built material carries (alpha-test ref incl. the
// ClipMap paletted / DDS refs, opacity = 1 - T, flat emissive luminosity,
// diffuse tint, blend function, depth write, fog exemption, sidedness,
// single pass, emissive map) must equal `layerStateFromSurface` — the
// decoder as data — field for field at f32, under the shipped defaults and
// under each flag the decoder reads (clipMapParity off / ref, clipMapOpaque
// off, surfaceParityV2 on, additiveObjFog off). The packed row must carry
// the same f32 values and unpack to the same state. The DAT has no type-0
// Surface, so synthetic type-0 surfaces (L > 0, D != 1) prove the paletted
// ladder's early return and the cache ladder's float half on both ladders.
//
// Fixture: ~/ac_base_dats/client_portal.dat (HB_PORTAL_DAT overrides). The
// suite FAILS loudly when the DAT is missing (the gate entry carries a
// `requires` on it).
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_state_table.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { openPortalDat } from "../tools/clip-alpha-gate.mjs";

const PORTAL_DAT = process.env.HB_PORTAL_DAT || "/home/wbterminal/ac_base_dats/client_portal.dat";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const LS = await import("../scene3d/gpu_batch/layer_state.js");
const M = await import("../scene3d/materials.js");

// --- the real paletted ladder, spliced from entities.js -----------------------
const ENT = fs.readFileSync(path.join(ROOT, "scene3d/entities.js"), "utf8");
function method(name) {
  const m = new RegExp(`\\n  ${name}\\([^)]*\\) \\{\\n`).exec(ENT);
  if (!m) throw new Error(`entities.js: method ${name} not found`);
  const start = m.index + 1;
  const end = ENT.indexOf("\n  }\n", start);
  return ENT.slice(start, end + 4);
}
const Paletted = new Function(
  "THREE", "SURFACE_TYPE", "readSurfaceUnifiedFlag", "applySurfaceRenderState", "applyClipMapRenderState",
  "additiveObjFogExemptEnabled", "readLuminousEmissiveMapFlag", "registerLuminousMaterial", "applyRetailSinglePass",
  `return class {\n${method("_applyPalettedSurfaceRenderState")}\n};`,
)(THREE, M.SURFACE_TYPE, M.readSurfaceUnifiedFlag, M.applySurfaceRenderState, M.applyClipMapRenderState,
  M.additiveObjFogExemptEnabled, M.readLuminousEmissiveMapFlag, () => false, M.applyRetailSinglePass);
const pal = new Paletted();

// --- DAT decode ---------------------------------------------------------------
const PALETTED_FORMATS = new Set([41, 101]); // PFID_P8, PFID_INDEX16
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
      const s = {
        id, flags,
        translucency: v.getFloat32(off, true), luminosity: v.getFloat32(off + 4, true), diffuse: v.getFloat32(off + 8, true),
        hasPalette: false,
      };
      if (textured) {
        const st = dat.read(v.getUint32(4, true));
        if (st && st.length >= 13) {
          const tv = new DataView(st.buffer, st.byteOffset, st.byteLength);
          const n = tv.getInt32(9, true);
          if (n > 0 && 13 + 4 * n <= st.length) {
            const rs = dat.read(tv.getUint32(13 + 4 * (n - 1), true)); // highest_res(): the last rung
            if (rs && rs.length >= 20) s.hasPalette = PALETTED_FORMATS.has(new DataView(rs.buffer, rs.byteOffset, rs.byteLength).getUint32(16, true));
          }
        }
      }
      out.push(s);
    }
  } finally {
    dat.close();
  }
  return out;
}

const ENVS = [
  { name: "defaults", search: "", env: { ...LS.DEFAULT_SURFACE_ENV } },
  { name: "clipMapParity=off", search: "?clipMapParity=off", env: { ...LS.DEFAULT_SURFACE_ENV, clipMapParity: "legacy" } },
  { name: "clipMapParity=ref", search: "?clipMapParity=ref", env: { ...LS.DEFAULT_SURFACE_ENV, clipMapParity: "ref" } },
  { name: "clipMapOpaque=off", search: "?clipMapOpaque=off", env: { ...LS.DEFAULT_SURFACE_ENV, clipMapOpaque: false } },
  { name: "surfaceParityV2=on", search: "?surfaceParityV2=on", env: { ...LS.DEFAULT_SURFACE_ENV, parityV2: true } },
  { name: "additiveObjFog=off", search: "?additiveObjFog=off", env: { ...LS.DEFAULT_SURFACE_ENV, additiveObjFog: false } },
];

test("premise: the retail portal DAT is present", () => {
  assert.ok(fs.existsSync(PORTAL_DAT), `fixture missing: ${PORTAL_DAT} (set HB_PORTAL_DAT)`);
});

const SURFACES = fs.existsSync(PORTAL_DAT) ? readSurfaces() : [];

test("the DAT decode covers every Surface class the decoder distinguishes", () => {
  assert.ok(SURFACES.length > 6000, `surfaces read: ${SURFACES.length}`);
  const has = (mask) => SURFACES.some((s) => (s.flags & mask) === mask);
  const B = LS.SURFACE_BITS;
  for (const [n, mask] of [["ClipMap", B.Base1ClipMap], ["Translucent", B.Translucent], ["Alpha", B.Alpha],
    ["Additive", B.Additive], ["Alpha+Additive", B.Alpha | B.Additive]]) assert.ok(has(mask), n);
  assert.ok(SURFACES.some((s) => s.luminosity > 0), "luminous");
  assert.ok(SURFACES.some((s) => s.translucency > 0 && (s.flags & B.Translucent)), "translucent with T > 0");
  assert.ok(SURFACES.some((s) => s.diffuse > 0 && Math.abs(s.diffuse - 1) > 0.01), "diffuse tint");
  const clip = SURFACES.filter((s) => (s.flags & B.Base1ClipMap) && !(s.flags & (B.Translucent | B.Alpha | B.InvAlpha | B.Additive)));
  assert.ok(clip.some((s) => s.hasPalette) && clip.some((s) => !s.hasPalette), "pure ClipMap: both paletted (100/255) and DDS (200/255) refs");
});

test("state rows equal both ladders' materials on every real surface, every decoder flag", () => {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const cache = new M.MaterialCache();
  const row = new Float32Array(LS.LAYER_STATE_FLOATS);
  const report = [];
  try {
    for (const E of ENVS) {
      globalThis.window = { location: { search: E.search } };
      let nCache = 0, nPal = 0, refs = new Set();
      const bad = [];
      for (const s of SURFACES) {
        const floats = { translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette };
        // Cache ladder.
        const mc = cache._materialFromFlags(s.flags, tex, undefined, null, undefined, null, floats);
        const wantC = LS.layerStateFromSurface(s, E.env, "cache");
        const gotC = LS.layerStateFromMaterial(mc);
        if (!LS.sameSurfaceState(wantC, gotC)) bad.push(`cache 0x${s.id.toString(16)} flags 0x${s.flags.toString(16)}: ${LS.surfaceStateDiff(wantC, gotC).join(", ")}`);
        else nCache++;
        refs.add(gotC.alphaRef);
        // Paletted ladder (entities.js constructs exactly this material first).
        const mp = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false });
        pal._applyPalettedSurfaceRenderState(mp, { surfaceType: s.flags, translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette });
        const wantP = LS.layerStateFromSurface(s, E.env, "paletted");
        const gotP = LS.layerStateFromMaterial(mp);
        if (!LS.sameSurfaceState(wantP, gotP)) bad.push(`paletted 0x${s.id.toString(16)} flags 0x${s.flags.toString(16)}: ${LS.surfaceStateDiff(wantP, gotP).join(", ")}`);
        else nPal++;
        // The packed row carries the material's f32 values and unpacks to the same state.
        LS.packLayerState(gotC, 7, row, 0, 3);
        const u = LS.unpackLayerState(row, 0);
        if (!LS.sameSurfaceState(gotC, u) || u.layer !== 7 || u.normalLayer !== 3) bad.push(`pack 0x${s.id.toString(16)}`);
        if (row[8] !== Math.fround(mc.alphaTest > 0 ? mc.alphaTest : 0) || row[3] !== Math.fround(mc.opacity)) bad.push(`row f32 0x${s.id.toString(16)}`);
        mc.dispose(); mp.dispose();
      }
      report.push(`${E.name}: cache ${nCache}/${SURFACES.length}, paletted ${nPal}/${SURFACES.length}, alpha refs {${[...refs].map((r) => Math.round(r * 255)).sort((a, b) => a - b).join(",")}}/255`);
      assert.deepEqual(bad.slice(0, 10), [], `${E.name}: ${bad.length} mismatches`);
      if (E.name === "defaults") {
        assert.ok(refs.has(LS.CLIPMAP_REF_PALETTED) && refs.has(LS.CLIPMAP_REF_DDS), "default refs: 100/255 paletted, 200/255 DDS");
        assert.ok(!refs.has(LS.CLIPMAP_REF_LEGACY));
      }
      if (E.name === "clipMapParity=off") assert.ok(refs.has(LS.CLIPMAP_REF_LEGACY) && !refs.has(LS.CLIPMAP_REF_DDS));
    }
  } finally {
    delete globalThis.window;
  }
  for (const line of report) console.log(`  ${line}`);
});

// The retail DAT carries NO Surface with type bits == 0 (0 of 6,152), so the
// sweep above never reaches the paletted ladder's fail-soft early return
// (entities.js: `if (flags === 0) return;` — empty / fallback surface stays
// opaque, NO luminosity, NO diffuse tint) nor the cache ladder's float-driven
// half for type 0 (it still applies luminosity and the diffuse tint). These
// synthetic type-0 surfaces cover both, in every decoder environment.
test("type-0 surfaces (none in the DAT): the paletted ladder returns early, the cache ladder applies the floats", () => {
  const zero = SURFACES.filter((s) => s.flags === 0).length;
  console.log(`  retail Surfaces with flags == 0: ${zero}`);
  // f32 floats, as the DAT stores them.
  const f = Math.fround;
  const SYNTH = [
    { id: 0xf0000001, flags: 0, translucency: 0, luminosity: f(0.7), diffuse: 0.5, hasPalette: true },
    { id: 0xf0000002, flags: 0, translucency: f(0.3), luminosity: 2.5, diffuse: 0.25, hasPalette: false },
    { id: 0xf0000003, flags: 0, translucency: 0, luminosity: f(0.4), diffuse: 1.5, hasPalette: undefined },
  ];
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const cache = new M.MaterialCache();
  try {
    for (const E of ENVS) {
      globalThis.window = { location: { search: E.search } };
      for (const s of SYNTH) {
        const floats = { translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette };
        const mc = cache._materialFromFlags(s.flags, tex, undefined, null, undefined, null, floats);
        const wantC = LS.layerStateFromSurface(s, E.env, "cache");
        const gotC = LS.layerStateFromMaterial(mc);
        assert.ok(LS.sameSurfaceState(wantC, gotC), `${E.name} cache 0x${s.id.toString(16)}: ${LS.surfaceStateDiff(wantC, gotC).join(", ")}`);
        assert.equal(gotC.luminosity, Math.min(2, s.luminosity), "cache ladder: luminosity applied on type 0");
        assert.equal(gotC.diffuse[0], s.diffuse, "cache ladder: diffuse tint applied on type 0");
        const mp = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, transparent: false });
        pal._applyPalettedSurfaceRenderState(mp, { surfaceType: s.flags, translucency: s.translucency, luminosity: s.luminosity, diffuse: s.diffuse, hasPalette: s.hasPalette });
        const wantP = LS.layerStateFromSurface(s, E.env, "paletted");
        const gotP = LS.layerStateFromMaterial(mp);
        assert.ok(LS.sameSurfaceState(wantP, gotP), `${E.name} paletted 0x${s.id.toString(16)}: ${LS.surfaceStateDiff(wantP, gotP).join(", ")}`);
        assert.deepEqual([gotP.luminosity, gotP.diffuse, gotP.emissiveMap, gotP.alphaRef, gotP.transparent], [0, [1, 1, 1], false, 0, false],
          "paletted ladder: type 0 stays an untouched opaque surface");
        assert.ok(!LS.sameSurfaceState(wantC, wantP), "the two ladders differ on type 0 (the early return is load-bearing)");
        mc.dispose(); mp.dispose();
      }
    }
  } finally {
    delete globalThis.window;
  }
});

test("blend classes and flags of the real population", () => {
  const counts = {};
  for (const s of SURFACES) {
    const st = LS.layerStateFromSurface(s, LS.DEFAULT_SURFACE_ENV, "cache");
    const c = LS.blendClassOf(st);
    counts[c] = (counts[c] || 0) + 1;
    const w = LS.flagsWordOf(st);
    assert.equal(w >> 8, st.blend);
    assert.equal((w & LS.LS_FLAG.ALPHA_TEST) !== 0, st.alphaRef > 0);
    if (st.blend === LS.BLEND.ADDITIVE || st.blend === LS.BLEND.SRCALPHA_ONE) assert.equal(st.fogOff, true, "additive surfaces draw unfogged");
  }
  console.log(`  classes: ${JSON.stringify(counts)}`);
  for (const k of ["opaque", "alphaTest", "translucent", "additive"]) assert.ok(counts[k] > 0, k);
});
