// tests/entity_batch_rows.test.mjs — R3-4 stage A `?entityBatch`: the PART
// ROWS (scene3d/gpu_batch/entity_batch.js `_lateRows`), composed in JS from
// the posed part Groups at the frame's first batch draw (onBeforeRender), on
// the shared world of tests/entity_batch_rig.mjs.
//
//   1. after real ticks (the unified motion path posing the walk clip), every
//      batched part's row is the f32 of the part.matrix three rendered with,
//      frame after frame;
//   2. writers AFTER the tick sync and before the render (the late hook's
//      reason to exist): ragdoll's real `applyFrozenPose`, raw quaternion
//      stores (the Rust route's `_x` writes, no onChange), position-only and
//      non-uniform scale writes, a `matrixAutoUpdate = false` part with its
//      own matrix, a part pivot — every row equals three's matrix of that
//      frame (a row computed in the tick would be a frame stale);
//   3. the vertex the batch shader places (mesh.matrixWorld x f32(row) x v)
//      equals the legacy leaf's (leaf.matrixWorld x v) to f32 precision, and
//      each batch draw is handed modelViewMatrix = f32(V x root) plus the
//      part-row and state-row textures;
//   4. unchanged parts write nothing (no row write, no texture upload) and the
//      late hook runs once per frame however many renders draw the batch;
//   5. a part going invisible zeroes its row (its leaves draw nothing) and
//      comes back rewritten.
//
// Run from apps/holtburger-web/:  node tests/entity_batch_rows.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE } = R;
const { applyFrozenPose } = await import("../scene3d/ragdoll.js");
const { check, done } = R.suite("entity_batch_rows");
const f = Math.fround;

await check("0. the batch module exists", () => R.requireBatch());

async function rigs(n = 2) {
  const w = await R.world(true);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await w.spawn(0x50000801 + i, 10 + 0.7 * i, 10, 0, i % 2 ? { paletteId: 0x04000a01 } : {}));
  w.settle();
  for (const r of out) assert.equal(r._hbBatch.status, "active");
  return { w, rigs: out, eb: w.em._entityBatch };
}

/** Every batched part row equals f32(part.matrix) as three just rendered it. */
function rowsMatch(eb, inst, tag) {
  const b = inst._hbBatch;
  const data = eb._partRows.data;
  let n = 0;
  for (let p = 0; p < b.plan.partRow.length; p += 1) {
    const row = b.plan.partRow[p];
    if (row <= 0) continue;
    const e = inst.parts[p].matrix.elements;
    for (let k = 0; k < 16; k += 1) assert.equal(data[row * 16 + k], f(e[k]), `${tag}: part ${p} element ${k}`);
    n += 1;
  }
  return n;
}

await check("1. after real ticks every part row is f32(part.matrix), frame after frame", async () => {
  const { w, rigs: rr, eb } = await rigs(2);
  let moved = 0;
  let prev = null;
  for (let fr = 0; fr < 12; fr += 1) {
    w.frame();
    for (const r of rr) assert.equal(rowsMatch(eb, r, `frame ${fr}`), 17);
    const cur = Array.from(rr[0].parts[4].quaternion.toArray());
    if (prev && cur.some((v, i) => v !== prev[i])) moved += 1;
    prev = cur;
  }
  // A 30 fps clip under 60 Hz ticks: the pose changes every other frame.
  assert.ok(moved >= 5, `the walk clip moved the parts (${moved})`);
});

await check("2. writers after the tick and before the render land in that frame's rows", async () => {
  const { w, rigs: [a, b], eb } = await rigs(2);
  const n = a.parts.length;
  const pos = new Float32Array(n * 3), quat = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    pos.set([0.1 * i, -0.05 * i, 0.3 + 0.02 * i], i * 3);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1 * i, -0.2, 0.05 * i));
    quat.set([q.x, q.y, q.z, q.w], i * 4);
  }
  a._ragdollFrozenPose = { n, pos, quat };
  for (let step = 0; step < 4; step += 1) {
    w.tickOnly();
    applyFrozenPose(a); // ragdoll's frozen corpse pose, after the tick
    const qb = b.parts[2].quaternion; // the Rust route stores raw components (no onChange)
    qb._x = 0.1 + 0.05 * step; qb._y = -0.2; qb._z = 0.3; qb._w = Math.sqrt(1 - qb._x * qb._x - 0.04 - 0.09);
    b.parts[5].position.set(0.2, 0.1 * step, 0.9); // position-only writer
    b.parts[6].scale.set(1.2, 0.9, 1.1); // non-uniform scale
    b.parts[7].matrixAutoUpdate = false; // a part with its own matrix
    b.parts[7].matrix.makeRotationY(0.3 * step).setPosition(0.1, 0.2, 0.3 + 0.1 * step);
    b.parts[8].pivot = new THREE.Vector3(0.05, 0.02, 0.1 * step); // three r184 pivots
    w.renderer.render(w.scene, w.camera);
    assert.equal(rowsMatch(eb, a, `frozen pose step ${step}`), 17);
    assert.equal(rowsMatch(eb, b, `mixed writers step ${step}`), 17);
  }
  const r7 = b._hbBatch.plan.partRow[7];
  assert.equal(eb._partRows.data[r7 * 16 + 14], f(0.6), "the manual matrix reached the row");
});

await check("3. the batch places every vertex where the legacy leaf did (f32), modelView = V x root", async () => {
  const { w, rigs: rr, eb } = await rigs(2);
  w.frame(3);
  w.gl.__fake.startSnapshots();
  w.renderer.render(w.scene, w.camera);
  const snaps = w.gl.__fake.takeSnapshots().filter((s) => s.kind === "drawArraysInstanced");
  assert.equal(snaps.length, 14);
  for (const s of snaps) {
    assert.ok(s.uniforms.hbEntPartTex && s.uniforms.hbBatchStateTex && s.uniforms.hbBatchMapArr, "part rows, state rows and the page are bound");
  }
  const V = w.camera.matrixWorldInverse;
  const mvs = rr.map((r) => new THREE.Matrix4().multiplyMatrices(V, r.root.children.find((c) => c.userData?.hbBatchMesh).matrixWorld).elements.map(f));
  for (const s of snaps) {
    const mv = Array.from(s.uniforms.modelViewMatrix);
    assert.ok(mvs.some((m) => m.every((x, k) => x === mv[k])), "modelViewMatrix = f32(V x root.matrixWorld)");
  }
  let worst = 0;
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const row = new THREE.Matrix4();
  for (const inst of rr) {
    const bb = inst._hbBatch;
    const mesh = bb.mesh;
    for (let i = 0; i < bb.leaves.length; i += 1) {
      const leaf = bb.leaves[i];
      const r = bb.plan.partRow[bb.plan.batch[i].part];
      row.fromArray(Array.from(eb._partRows.data.subarray(r * 16, r * 16 + 16)));
      const pa = leaf.geometry.attributes.position;
      for (let k = 0; k < pa.count; k += 1) {
        v.fromBufferAttribute(pa, k);
        a.copy(v).applyMatrix4(leaf.matrixWorld);
        b.copy(v).applyMatrix4(row).applyMatrix4(mesh.matrixWorld);
        worst = Math.max(worst, a.distanceTo(b) / Math.max(1, a.length()));
      }
    }
  }
  assert.ok(worst < 2e-7, `relative placement error ${worst}`);
});

await check("4. unchanged parts write nothing; the late hook runs once per frame", async () => {
  const { w, eb } = await rigs(2);
  w.frame(2);
  const s0 = eb.stats().rows;
  w.frame(1, 0); // dt = 0: the dt-recovery sync, nothing moves
  const s1 = eb.stats().rows;
  assert.equal(s1.lateFrames, s0.lateFrames + 1);
  assert.equal(s1.lateWrites, s0.lateWrites, "no row write");
  assert.equal(s1.uploads, s0.uploads, "no texture upload");
  assert.ok(s1.lateSkips > s0.lateSkips);
  w.renderer.render(w.scene, w.camera); // a second render in the same frame
  const s2 = eb.stats().rows;
  assert.equal(s2.lateFrames, s1.lateFrames, "once per sync");
});

await check("5. a hidden part zeroes its row; shown again it is rewritten", async () => {
  const { w, rigs: [a], eb } = await rigs(1);
  const b = a._hbBatch;
  const r = b.plan.partRow[6];
  a.parts[6].visible = false;
  w.frame(1);
  for (let k = 0; k < 16; k += 1) assert.equal(eb._partRows.data[r * 16 + k], 0);
  assert.ok(eb.stats().rows.lateZeros >= 1);
  a.parts[6].visible = true;
  w.frame(1);
  assert.equal(rowsMatch(eb, a, "shown again"), 17);
  // A leaf hidden (partDegrade writes leaf.visible) collapses the same way.
  const leaf = b.leaves[b.plan.batch.findIndex((c) => c.part === 6)];
  leaf.visible = false;
  w.frame(1);
  assert.equal(b.partAllCollapsed[6], 1);
  for (let k = 0; k < 16; k += 1) assert.equal(eb._partRows.data[r * 16 + k], 0);
  leaf.visible = true;
  w.frame(1);
  assert.equal(rowsMatch(eb, a, "leaf shown again"), 17);
});

done();
