// M2 (worker-based asset bake) — Node unit test for the transferable
// serialization core (scene3d/bake_transfer.js). This is the bug-prone
// part of M2 (field mapping, transfer-list construction, derived getters),
// and it is PURE, so it is fully verifiable headless. The thin remaining
// glue (`new Worker()` + WASM `init` in the worker) is browser-only.
//
// Run:  cd apps/holtburger-web && node test_bake_transfer.mjs
//
// Loads the ESM module via a data: URL import (the module is pure — no
// `three`/DOM/WASM — so this sidesteps Node's package.json CJS/ESM
// resolution, mirroring the other standalone tests' load-the-source style).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolvePath(__dirname, "scene3d/bake_transfer.js"), "utf8");
const mod = await import("data:text/javascript," + encodeURIComponent(src));
const {
  serializeModelMesh,
  serializeModelMeshes,
  reconstructModelMesh,
  reconstructModelMeshes,
  serializeSurfacePixels,
  serializeSurfacePixelsBatch,
  reconstructSurfacePixels,
  reconstructSurfacePixelsBatch,
} = mod;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}
function eqTA(a, b) {
  if (!a || !b || a.length !== b.length || a.constructor !== b.constructor) return false;
  for (let i = 0; i < a.length; i++) {
    // Bit-exact for floats (Object.is handles -0/NaN); strict for ints.
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

// A fake wasm-bindgen ModelMesh: getters return a FRESH copy on each read
// (mirrors wasm-bindgen's clone-out-of-WASM-memory semantics).
function makeFakeMesh(seed = 0) {
  const positions = Float32Array.from({ length: 18 }, (_, i) => i + 0.5 + seed); // 2 tris
  const uvs = Float32Array.from({ length: 12 }, (_, i) => i * 0.25 + seed);
  const normals = Float32Array.from({ length: 18 }, (_, i) => -i - seed);
  const surfaceIndices = Uint8Array.from([0, 255]);
  const sidesTypes = Uint8Array.from([1, 0]);
  const surfaces = Uint32Array.from([0x05000001 + seed, 0x05000002 + seed]);
  const bbox = Float32Array.from([-1, -2, -3, 4, 5, 6]);
  const didDegrade = (0x01abcdef + seed) >>> 0;
  return {
    get positions() { return positions.slice(); },
    get uvs() { return uvs.slice(); },
    get normals() { return normals.slice(); },
    get surfaceIndices() { return surfaceIndices.slice(); },
    get sidesTypes() { return sidesTypes.slice(); },
    get surfaces() { return surfaces.slice(); },
    get bbox() { return bbox.slice(); },
    get triCount() { return positions.length / 9; },
    get worldBounds() { return Float32Array.from([bbox[3] - bbox[0], bbox[4] - bbox[1]]); },
    get didDegrade() { return didDegrade; },
  };
}

console.log("M2 bake_transfer — ModelMesh transferable serialization");

// 1. Single-mesh round-trip: every field byte-identical to the wasm getters.
{
  const fake = makeFakeMesh();
  const { mesh, transfer } = serializeModelMesh(fake);
  const r = reconstructModelMesh(mesh);

  check("positions byte-identical", eqTA(r.positions, fake.positions));
  check("uvs byte-identical", eqTA(r.uvs, fake.uvs));
  check("normals byte-identical", eqTA(r.normals, fake.normals));
  check("surfaceIndices byte-identical", eqTA(r.surfaceIndices, fake.surfaceIndices));
  check("sidesTypes byte-identical", eqTA(r.sidesTypes, fake.sidesTypes));
  check("surfaces byte-identical", eqTA(r.surfaces, fake.surfaces));
  check("bbox byte-identical", eqTA(r.bbox, fake.bbox));
  check("didDegrade preserved", r.didDegrade === fake.didDegrade, `${r.didDegrade} vs ${fake.didDegrade}`);

  // 2. Derived getters recomputed to match the wasm-bindgen getters exactly.
  check("triCount derived matches getter", r.triCount === fake.triCount, `${r.triCount} vs ${fake.triCount}`);
  check("worldBounds derived matches getter", eqTA(r.worldBounds, fake.worldBounds));
  check("triCount is integer 2", r.triCount === 2);
  check("worldBounds == [5,7]", r.worldBounds[0] === 5 && r.worldBounds[1] === 7);

  // 3. Transfer list = the 7 distinct backing buffers, and they ARE the
  //    payload's buffers (zero-copy: the worker would detach exactly these).
  check("transfer list has 7 buffers", transfer.length === 7, `got ${transfer.length}`);
  const payloadBufs = [
    mesh.positions.buffer, mesh.uvs.buffer, mesh.normals.buffer,
    mesh.surfaceIndices.buffer, mesh.sidesTypes.buffer, mesh.surfaces.buffer, mesh.bbox.buffer,
  ];
  check("transfer buffers are the payload's buffers",
    payloadBufs.every((b) => transfer.includes(b)) && transfer.every((b) => payloadBufs.includes(b)));
  check("all transferred buffers are ArrayBuffers",
    transfer.every((b) => b instanceof ArrayBuffer));

  // 4. Drop-in completeness: every field the main-thread consumers read.
  const required = ["positions", "uvs", "normals", "surfaceIndices", "sidesTypes",
    "surfaces", "triCount", "bbox", "worldBounds", "didDegrade"];
  check("reconstructed exposes all consumer fields",
    required.every((k) => k in r), required.filter((k) => !(k in r)).join(","));
}

// 5. Shared-buffer dedup: two views over ONE ArrayBuffer must not be
//    transferred twice (would throw "already detached").
{
  const shared = new ArrayBuffer(18 * 4 + 12 * 4);
  const positions = new Float32Array(shared, 0, 18);
  const uvs = new Float32Array(shared, 18 * 4, 12);
  positions.fill(1);
  uvs.fill(2);
  const fake = {
    get positions() { return positions; },
    get uvs() { return uvs; },
    get normals() { return new Float32Array(18); },
    get surfaceIndices() { return new Uint8Array(2); },
    get sidesTypes() { return new Uint8Array(2); },
    get surfaces() { return new Uint32Array(2); },
    get bbox() { return Float32Array.from([0, 0, 0, 1, 1, 1]); },
    get didDegrade() { return 0; },
  };
  const { transfer } = serializeModelMesh(fake);
  // positions & uvs share one buffer → 6 distinct buffers, not 7.
  check("shared buffer deduped in transfer list", transfer.length === 6, `got ${transfer.length}`);
  check("shared buffer appears once", transfer.filter((b) => b === shared).length === 1);
}

// 6. Batch round-trip preserves order + dedups across meshes.
{
  const fakes = [makeFakeMesh(0), makeFakeMesh(100), makeFakeMesh(200)];
  const { meshes, transfer } = serializeModelMeshes(fakes);
  const rs = reconstructModelMeshes(meshes);
  check("batch length preserved", rs.length === 3);
  check("batch order preserved (surfaces[0])",
    rs[0].surfaces[0] === 0x05000001 && rs[1].surfaces[0] === (0x05000001 + 100) && rs[2].surfaces[0] === (0x05000001 + 200));
  check("batch transfer list = 3×7 distinct buffers", transfer.length === 21, `got ${transfer.length}`);
  check("batch buffers all distinct", new Set(transfer).size === transfer.length);
}

// ---- SurfacePixels ----
function makeFakeSurface({ emptyNormal = false, emptyHeight = false } = {}) {
  const w = 2, h = 2;
  const pixels = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 7) & 0xff);
  const normalPixels = emptyNormal ? new Uint8Array(0) : Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 11) & 0xff);
  const heightPixels = emptyHeight ? new Uint8Array(0) : Uint8Array.from({ length: w * h }, (_, i) => (i * 13) & 0xff);
  return {
    get width() { return w; },
    get height() { return h; },
    get pixels() { return pixels.slice(); },
    get surfaceType() { return 0x0000_0011; },
    get category() { return 12; },
    get normalPixels() { return normalPixels.slice(); },
    get heightPixels() { return heightPixels.slice(); },
    get roughnessOverride() { return 0.42; },
    get normalScaleOverride() { return 1.25; },
    get translucency() { return 0.0; },
    get luminosity() { return 3.5; },
    get diffuse() { return 0.8; },
  };
}

console.log("\nM2 bake_transfer — SurfacePixels transferable serialization");
{
  const fake = makeFakeSurface();
  const { surface, transfer } = serializeSurfacePixels(fake);
  const r = reconstructSurfacePixels(surface);

  check("pixels byte-identical", eqTA(r.pixels, fake.pixels));
  check("normalPixels byte-identical", eqTA(r.normalPixels, fake.normalPixels));
  check("heightPixels byte-identical", eqTA(r.heightPixels, fake.heightPixels));
  check("width/height preserved", r.width === 2 && r.height === 2);
  check("surfaceType preserved", r.surfaceType === 0x11);
  check("category preserved", r.category === 12);
  check("roughnessOverride preserved", Math.abs(r.roughnessOverride - 0.42) < 1e-6);
  check("normalScaleOverride preserved", Math.abs(r.normalScaleOverride - 1.25) < 1e-6);
  check("translucency/luminosity/diffuse preserved",
    r.translucency === 0 && Math.abs(r.luminosity - 3.5) < 1e-6 && Math.abs(r.diffuse - 0.8) < 1e-6);
  check("surface transfer list = 3 buffers", transfer.length === 3, `got ${transfer.length}`);

  const required = ["width", "height", "pixels", "surfaceType", "category", "normalPixels",
    "heightPixels", "roughnessOverride", "normalScaleOverride", "translucency", "luminosity", "diffuse"];
  check("reconstructed surface exposes all consumer fields",
    required.every((k) => k in r), required.filter((k) => !(k in r)).join(","));
}

// Empty normal/height arrays (Luminous / flat surfaces) round-trip cleanly.
{
  const fake = makeFakeSurface({ emptyNormal: true, emptyHeight: true });
  const { surface, transfer } = serializeSurfacePixels(fake);
  const r = reconstructSurfacePixels(surface);
  check("empty normalPixels round-trips", r.normalPixels.length === 0);
  check("empty heightPixels round-trips", r.heightPixels.length === 0);
  check("empty arrays still produce transfer buffers (harmless)", transfer.length === 3);
}

// Batch surfaces preserve order + dedup.
{
  const fakes = [makeFakeSurface(), makeFakeSurface(), makeFakeSurface()];
  const { surfaces, transfer } = serializeSurfacePixelsBatch(fakes);
  const rs = reconstructSurfacePixelsBatch(surfaces);
  check("surface batch length preserved", rs.length === 3);
  check("surface batch transfer = 3×3 distinct buffers", transfer.length === 9, `got ${transfer.length}`);
  check("surface batch buffers all distinct", new Set(transfer).size === transfer.length);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
