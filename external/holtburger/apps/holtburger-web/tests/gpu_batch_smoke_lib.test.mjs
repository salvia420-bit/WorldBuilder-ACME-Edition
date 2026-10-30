// tests/gpu_batch_smoke_lib.test.mjs — node dry run of the SwiftShader smoke's
// arms (harness/glsl_smoke/gpu_batch_lib.mjs) against the fake WebGL2.
//
// The smoke itself (gpu_batch_smoke.mjs) launches Chromium and is run by the
// orchestrator; this keeps its arm code honest in the node gate: every arm
// runs through the real modules without throwing, the texel arm really
// batches with the flag on (ARRAY draws for the insect cloud, the ClipMap
// pair and the bundle-shaped setup, SAME draws, the translucent setup legacy)
// and really does not with it off, the bundle setup really comes from an
// HBG1 bundle (indexed buckets over one shared stream) and merges compacted
// and exact, the layers arm admits and reads back every level, and the f32
// arm builds both compositions. Pixels are not checked here (the fake does
// not rasterise) — that is the smoke's job.
//
// Run from apps/holtburger-web/:  node tests/gpu_batch_smoke_lib.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};
globalThis.window.location ??= { search: "" };
globalThis.window.requestAnimationFrame = () => 1;
globalThis.window.cancelAnimationFrame = () => {};

const THREE = await import("three");
const { createFakeWebGL2, fakeCanvas } = await import("./helpers/fake_webgl2.mjs");
const LIB = await import("../harness/glsl_smoke/gpu_batch_lib.mjs");
const mods = {
  arrayPages: await import("../scene3d/gpu_batch/array_pages.js"),
  rowTexture: await import("../scene3d/gpu_batch/row_texture.js"),
  adapter: await import("../scene3d/adapter.js"),
  animatedScenery: await import("../scene3d/animated_scenery.js"),
  animSceneryGpu: await import("../scene3d/anim_scenery_gpu.js"),
  materials: await import("../scene3d/materials.js"),
  geomBundles: await import("../scene3d/geom_bundles.js"),
};
const KIT = await import("../scene3d/gpu_batch/kit.js");
const ASB = await import("../scene3d/gpu_batch/anim_scenery_batch.js");

function rig() {
  const gl = createFakeWebGL2({ width: LIB.CANVAS, height: LIB.CANVAS });
  return { gl, renderer: new THREE.WebGLRenderer({ canvas: fakeCanvas(gl, LIB.CANVAS, LIB.CANVAS), context: gl }) };
}

test("layers arm: every texture admitted, every level read back", () => {
  const { renderer } = rig();
  const r = LIB.runLayersArm(THREE, renderer, mods);
  assert.equal(r.textures, 20, "10 albedo + 10 normal textures");
  assert.ok(r.levels > 60);
  assert.equal(r.mismatchedLevels, 0, r.firstMismatch); // the fake reads zeros on both sides
  assert.equal(r.scratch, 10);
  assert.ok(r.pages >= 4, `several pages (3 layers max each): ${r.pages}`);
});

async function texel(on) {
  mods.animatedScenery.disposeAnimatedScenery();
  KIT.resetKit();
  mods.animatedScenery.__setAnimSceneryBatchForTest(on);
  const { renderer } = rig();
  const r = await LIB.runTexelArm(THREE, renderer, mods, { ticks: 24, settleMs: 10000 });
  renderer.render(r.scene, r.camera);
  return r;
}

test("texel arm: batches with the flag on, not with it off", async () => {
  const off = await texel(false);
  assert.equal(off.built, 10);
  assert.equal(off.diag.batch, undefined);
  assert.deepEqual(off.bundle, { buckets: 6, sharedStream: true, indexed: true, batchDraws: 0, referencedVertices: 48, mergedVertices: null },
    "the bundle setup's buckets: 6 indexed groups over ONE 45-vertex stream (the ?geomBundles shape)");
  const on = await texel(true);
  assert.equal(on.built, 10);
  const b = on.diag.batch;
  assert.ok(b, "armed");
  assert.equal(b.byStatus.active, 4, JSON.stringify(b.byStatus));
  assert.equal(b.byStatus.legacy, 1);
  assert.equal(b.arrayDraws, 3, "insect cloud 7A+7C, ClipMap pair 100/200, bundle A+B");
  assert.equal(b.sameDraws, 3, "insect 7B, butterfly, bundle C");
  assert.deepEqual(on.bundle, { buckets: 6, sharedStream: true, indexed: true, batchDraws: 2, referencedVertices: 48, mergedVertices: 48 },
    "the bundle merges are indexed and compacted: 48 merged vertices for 48 referenced (6 x 45 = 270 uncompacted)");
  // The merge is exact: every triangle corner of every slice names the same
  // source vertex, every attribute verbatim (what the smoke then rasterises).
  const bg = ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === LIB.TEXEL_SETUPS.BUNDLE);
  for (const d of bg.draws) {
    const mi = d.geometry.index.array;
    for (const sl of d.slices) {
      const src = sl.bucket.mesh.geometry;
      for (let k = 0; k < sl.count; k++) {
        const m = mi[sl.start + k];
        assert.ok(m >= sl.vertexStart && m < sl.vertexStart + sl.vertexCount, "inside its slice");
        const sv = src.index.array[k];
        assert.equal(sl.vertexMap[m - sl.vertexStart], sv);
        for (const name of Object.keys(src.attributes)) {
          const a = src.attributes[name];
          for (let c = 0; c < a.itemSize; c++) assert.equal(d.geometry.getAttribute(name).array[m * a.itemSize + c], a.array[sv * a.itemSize + c], name);
        }
      }
    }
  }
  // (K3) What the smoke's kit-budget check reads after the final render:
  // every merged-geometry ticket landed through three's upload callbacks,
  // and the S1 timing fields are numbers (layers and geometry timed).
  const kb = mods.animatedScenery.animatedSceneryDiag().batch.kit.budget;
  assert.equal(kb.openTickets, 0, "every geometry ticket landed");
  assert.ok(kb.landed >= 4 && kb.tickets >= 4, JSON.stringify({ tickets: kb.tickets, landed: kb.landed }));
  assert.ok(kb.timed.layer > 0 && kb.timed.geometry > 0, JSON.stringify(kb.timed));
  for (const k of ["ms", "maxMs", "timed", "phaseMs"]) {
    assert.ok(Object.values(kb[k]).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0), `${k}: ${JSON.stringify(kb[k])}`);
  }
  const clips = ASB.__animSceneryBatchGroupsForTest().find((g) => g.setupId === LIB.TEXEL_SETUPS.CLIPS);
  const arr = clips.draws.find((d) => d.kind === "array");
  assert.equal(arr.classEntry.material.alphaTest > 0, true, "the alpha-tested class");
  const refs = arr.units.map((u) => Math.round(u.member.alphaTest * 255)).sort((x, y) => x - y);
  assert.deepEqual(refs, [100, 200], "per-slot ClipMap refs (paletted, DDS)");
  mods.animatedScenery.disposeAnimatedScenery();
  mods.animatedScenery.__setAnimSceneryBatchForTest(undefined);
  delete globalThis.window.liveScene3d;
  KIT.resetKit();
});

test("f32 arm: both compositions build and render", () => {
  const { renderer } = rig();
  for (const baseX of [150, 32400]) {
    const r = LIB.runF32Arm(THREE, renderer, mods, { baseX, baseY: 120 });
    renderer.render(r.sceneA, r.camera);
    renderer.render(r.sceneB, r.camera);
    const meshB = r.sceneB.children.find((o) => o.isInstancedMesh);
    assert.ok(Math.abs(meshB.matrixWorld.elements[12] - r.camera.position.x) < 1e-9, "kit mesh anchored at the camera");
  }
  assert.equal(LIB.frameDiff(new Uint8Array([1, 2, 3]), new Uint8Array([1, 4, 3])).maxDiff, 2);
});
