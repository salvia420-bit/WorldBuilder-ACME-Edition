// tests/entity_batch_layers.test.mjs — R3-4 stage A `?entityBatch`: palette
// composites as VALUE-KEYED kit layers (scene3d/gpu_batch/entity_batch.js
// PaletteKeys / admitPixelsMismatch / `_admitMap`), on three r184 over the
// recording fake WebGL2 and the shared world of tests/entity_batch_rig.mjs.
//
//   a. two composites with EQUAL bytes (different texture objects, as two
//      subpalette lists that compose to the same colours produce) get the
//      same key and ONE layer (one upload: one copyTexSubImage3D per level);
//      unequal bytes never share; since 2026-10-31 (real boot) the key is
//      (bytes, page key): equal bytes of ANOTHER surface share too, equal
//      bytes under another sampler state (wrap) never do;
//   b. a forced hash collision (an injected hash) is separated by the
//      full-byte compare (`#1`, counted); equal bytes still join;
//   c. the scratch `admitPixels` builds names the SAME page as the legacy
//      surfacePixelsToTexture texture (page key, the driver-mip rule) for
//      every size class, and the layer really lands in that page; every
//      field that would change what three uploads routes the texture to the
//      identity admit instead (unpack flags, mips, filters, format, short
//      data); wrap / anisotropy / colour space follow the texture;
//   d. in a real plan the bytes handed to admitPixels ARE `map.image.data`
//      (what three would upload), and a recolored member whose texture would
//      not match goes to `admit(tex)` (counted `identityAdmits`);
//   e. a deferred admit (`?gpuBatchAdmits=1`) keeps the rig "admitting" with
//      the legacy leaves on screen and no batch mesh, then it batches;
//   f. end to end: two recolored rigs whose composites are equal share their
//      8 layers; a third, with another palette, gets its own.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_layers.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, EB, KIT, D, ADAPTER } = R;
const { ArrayPages, describeTexture } = await import("../scene3d/gpu_batch/array_pages.js");
const { pageKeyOf, fullMipLevels } = await import("../scene3d/gpu_batch/page_allocator.js");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const { check, done } = R.suite("entity_batch_layers");

await check("0. the batch module exists", () => R.requireBatch());

function glWorld() {
  const calls = [];
  const gl = createFakeWebGL2({ onCall: (n) => calls.push(n) });
  const renderer = new THREE.WebGLRenderer({ canvas: fakeCanvas(gl), context: gl });
  return { gl, renderer, calls, pages: new ArrayPages(renderer) };
}
const tex = (px, w, h) => ADAPTER.surfacePixelsToTexture(px, w, h);
const bytes = (w, h, seed) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < a.length; i += 1) a[i] = (i * 13 + seed) & 255; return a; };

await check("a. equal bytes: one key, one layer, one upload; unequal bytes never share", () => {
  const { pages, calls } = glWorld();
  const keys = new EB.PaletteKeys();
  const t1 = tex(bytes(64, 64, 5), 64, 64);
  const t2 = tex(bytes(64, 64, 5), 64, 64); // equal composite, another object
  const t3 = tex(bytes(64, 64, 6), 64, 64);
  assert.notEqual(t1.image.data, t2.image.data);
  const k1 = keys.keyFor(t1, D.A), k2 = keys.keyFor(t2, D.A), k3 = keys.keyFor(t3, D.A);
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  // 2026-10-31 (real boot): the key is (bytes, page key), no surface DID.
  assert.match(k1, /^pal:[0-9a-f]{16}:64x64:[0-9a-f]{8}$/);
  assert.equal(keys.keyFor(tex(bytes(64, 64, 5), 64, 64), D.B), k1, "equal bytes on another surface share (same sampling)");
  assert.equal(keys.stats.crossSurfaceJoins, 1);
  const clamp = tex(bytes(64, 64, 5), 64, 64);
  clamp.wrapS = THREE.ClampToEdgeWrapping;
  assert.notEqual(keys.keyFor(clamp, D.A), k1, "equal bytes with another wrap (another page) never share");
  const opts = EB.admitPixelsOpts(t1);
  const r1 = pages.admitPixels(t1.image.data, 64, 64, opts, k1, null);
  const copies1 = calls.filter((n) => n === "copyTexSubImage3D").length;
  const r2 = pages.admitPixels(t2.image.data, 64, 64, opts, k2, null);
  const r3 = pages.admitPixels(t3.image.data, 64, 64, opts, k3, null);
  assert.equal(r1.page, r2.page); assert.equal(r1.layer, r2.layer);
  assert.ok(r3.layer !== r1.layer || r3.page !== r1.page);
  assert.equal(pages.alloc.refCount(k1), 2);
  assert.equal(copies1, fullMipLevels(64, 64), "one copy per level");
  assert.equal(calls.filter((n) => n === "copyTexSubImage3D").length, 2 * fullMipLevels(64, 64), "the equal composite uploaded nothing");
  assert.equal(keys.stats.joins, 2, "t2 (and the other surface's twin) joined t1 after a full-byte compare");
});

await check("b. a forced hash collision is separated by the full-byte compare", () => {
  const keys = new EB.PaletteKeys(() => [7, 9]);
  const t1 = tex(bytes(32, 32, 1), 32, 32), t2 = tex(bytes(32, 32, 1), 32, 32), t3 = tex(bytes(32, 32, 2), 32, 32);
  const k1 = keys.keyFor(t1, D.C);
  const k3 = keys.keyFor(t3, D.C);
  const k2 = keys.keyFor(t2, D.C);
  assert.equal(k3, `${k1}#1`);
  assert.equal(k2, k1, "equal bytes still join");
  assert.equal(keys.stats.hashCollisions, 1);
  // The memo is per texture object AND version.
  t3.image.data[0] ^= 1; t3.needsUpdate = true;
  assert.notEqual(keys.keyFor(t3, D.C), k3, "a new version re-hashes");
});

await check("c. the admitPixels scratch names the legacy texture's page; mismatches route to identity", () => {
  const { pages } = glWorld();
  for (const [w, h] of [[64, 64], [64, 128], [128, 64], [32, 32], [256, 128], [48, 80], [1, 1]]) {
    const t = tex(bytes(w, h, w + h), w, h);
    assert.equal(EB.admitPixelsMismatch(t), null, `${w}x${h}`);
    const legacy = describeTexture(t);
    assert.equal(pageKeyOf(EB.scratchDescriptor(w, h, EB.admitPixelsOpts(t))), pageKeyOf(legacy));
    const r = pages.admitPixels(t.image.data, w, h, EB.admitPixelsOpts(t), `k${w}x${h}`, null);
    assert.equal(r.page.key, pageKeyOf(legacy), `${w}x${h}: the layer is in the legacy texture's page`);
    assert.equal(r.page.desc.levels, fullMipLevels(w, h), "driver mips: the full chain");
  }
  const base = () => tex(bytes(16, 16, 3), 16, 16);
  const cases = [
    ["flipY", (t) => { t.flipY = true; }, "unpack"],
    ["premultiplyAlpha", (t) => { t.premultiplyAlpha = true; }, "unpack"],
    ["unpackAlignment 8", (t) => { t.unpackAlignment = 8; }, "unpack"],
    ["generateMipmaps off", (t) => { t.generateMipmaps = false; }, "mips"],
    ["minFilter Linear", (t) => { t.minFilter = THREE.LinearFilter; }, "mips"],
    ["magFilter Nearest", (t) => { t.magFilter = THREE.NearestFilter; }, "mips"],
    ["RGB format", (t) => { t.format = THREE.RGBFormat ?? 1022; }, "describe"],
    ["short data", (t) => { t.image.data = t.image.data.subarray(0, 100); }, "data-short"],
    ["uv offset", (t) => { t.offset.set(0.5, 0); }, "describe"],
  ];
  for (const [name, mut, why] of cases) {
    const t = base();
    mut(t);
    assert.equal(EB.admitPixelsMismatch(t), why, name);
  }
  for (const [name, mut] of [["wrap clamp", (t) => { t.wrapS = THREE.ClampToEdgeWrapping; }], ["anisotropy 8", (t) => { t.anisotropy = 8; }], ["linear colour space", (t) => { t.colorSpace = THREE.LinearSRGBColorSpace; }]]) {
    const t = base();
    mut(t);
    assert.equal(EB.admitPixelsMismatch(t), null, `${name}: the scratch follows`);
    assert.equal(pageKeyOf(EB.scratchDescriptor(16, 16, EB.admitPixelsOpts(t))), pageKeyOf(describeTexture(t)), name);
  }
});

await check("d. a real plan hands admitPixels the composite's own bytes; a mismatching one is admitted by identity", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000a01, 10, 10, 0, { paletteId: 0x04000a01 });
  const pages = KIT.kitPages(w.renderer);
  const seen = [];
  const ap = pages.admitPixels;
  pages.admitPixels = function (rgba, ww, hh, opts, key, budget) { seen.push({ rgba, key }); return ap.call(this, rgba, ww, hh, opts, key, budget); };
  // One composite would not upload like its scratch: identity admit.
  const odd = R.leavesOf(inst).find((l) => l.userData.surfaceDid === D.E);
  odd.material.map.premultiplyAlpha = true;
  w.settle();
  assert.equal(inst._hbBatch.status, "active");
  const datas = new Set(R.leavesOf(inst).map((l) => l.material.map.image.data));
  assert.equal(seen.length, 7, "seven value-keyed composites");
  for (const s of seen) assert.ok(datas.has(s.rgba), "the bytes are map.image.data");
  const st = w.em._entityBatch.stats().layers;
  assert.equal(st.value, 7);
  assert.equal(st.identityAdmits, 1);
  const row = [...inst._hbBatch.plan.memberRefs.values()].find((r) => r.member === odd.material);
  assert.ok(row.contentKey.startsWith(odd.material.map.uuid), "identity content key");
});

await check("e. a deferred admit keeps the rig admitting (legacy on screen, no batch mesh), then it batches", async () => {
  KIT.resetKit();
  const save = globalThis.location;
  globalThis.location = { search: "?gpuBatchAdmits=1" };
  try {
    const w = await R.world(true);
    const inst = await w.spawn(0x50000a11);
    let admittingFrames = 0;
    for (let i = 0; i < 30 && inst._hbBatch.status !== "active"; i += 1) {
      w.frame();
      if (inst._hbBatch.status === "admitting") {
        admittingFrames += 1;
        assert.equal(inst.root.children.some((c) => c.userData?.hbBatchMesh), false, "no batch mesh while admitting");
        assert.equal(w.drawsOf().length, 19, "legacy draws");
      }
    }
    assert.ok(admittingFrames >= 6, `one admit a frame: ${admittingFrames} frames admitting`);
    assert.equal(inst._hbBatch.status, "active");
    assert.ok(w.em._entityBatch.stats().layers.deferred >= 6);
    assert.equal(w.drawsOf().length, 7);
  } finally { globalThis.location = save; KIT.resetKit(); }
});

await check("f. two rigs with equal composites share 8 layers; another palette gets its own", async () => {
  const w = await R.world(true);
  await w.spawn(0x50000a21, 10, 10, 0, { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) });
  await w.spawn(0x50000a22, 11, 10, 0, { paletteId: 0x04000a01, subPalettes: Uint32Array.of(0x0400bb02, 0, 8) });
  w.settle();
  const s1 = w.em._entityBatch.stats();
  assert.equal(s1.kit.pages.live, 8, "8 shared layers");
  assert.equal(s1.layers.valueKeys, 8);
  const m1 = R.leavesOf(w.em.entityMap.get(0x50000a21))[0].material, m2 = R.leavesOf(w.em.entityMap.get(0x50000a22))[0].material;
  assert.notEqual(m1, m2, "two palette signatures: two materials");
  assert.notEqual(m1.map, m2.map, "and two textures");
  await w.spawn(0x50000a23, 12, 10, 0, { paletteId: 0x04000a02, subPalettes: Uint32Array.of(0x0400aa01, 0, 8) });
  w.settle();
  const s2 = w.em._entityBatch.stats();
  assert.equal(s2.kit.pages.live, 16, "the other palette's 8 layers");
  assert.equal(w.drawsOf().length, 21);
});

done();
