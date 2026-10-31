// tests/entity_batch_geometry.test.mjs — R3-4 stage A `?entityBatch`: the
// merged geometry (scene3d/gpu_batch/entity_batch.js: shared entries,
// per-entity geometries, groups, the GL lifecycle and the upload tickets), on
// the shared world of tests/entity_batch_rig.mjs.
//
//   1. the shared entry is the batched leaves' geometries concatenated in
//      (run key, part, group) order, attribute for attribute;
//   2. two rigs of one (setup, appearance, run keys) share ONE entry (users
//      2) whose arrays both draw; a leaf whose content differs by one float
//      makes a separate entry (a key collision verified bit-equal, never
//      shared on the key alone);
//   3. the per-entity `hbBatchSlot` / `hbEntPart` hold each leaf's state row
//      and part row; one group per run, the draws are the runs;
//   4. a page that fills up splits a run (one more group / draw);
//   5. INDEXED leaves sharing one vertex stream (the bundle shape) are
//      compacted to the vertices their index names and drawn with
//      drawElementsInstanced over the remapped index, placing the same
//      vertices as the legacy leaves;
//   6. GL lifecycle through three r184's real dispose events: releasing a
//      non-last user deletes only its own two buffers (the shared attributes
//      keep drawing, nothing re-uploads); the last user's release deletes the
//      shared buffers too and the entry idles;
//   7. upload tickets: the build charges the shared arrays once (on a ticket
//      the entry owns) plus each rig's own attributes; three's upload
//      callbacks land them at the first render; a rig released before its
//      first render drops its tickets (nothing stays carried).
//
// Run from apps/holtburger-web/:  node tests/entity_batch_geometry.test.mjs

import * as R from "./entity_batch_rig.mjs";
import assert from "node:assert/strict";

const { THREE, KIT, D } = R;
const { check, done } = R.suite("entity_batch_geometry");

await check("0. the batch module exists", () => R.requireBatch());

await check("1. the entry is the batched leaves concatenated in run order", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000901);
  w.settle();
  const b = inst._hbBatch;
  const e = b.entry;
  for (const name of ["position", "normal", "uv"]) {
    const parts = b.plan.batch.map((c) => c.leaf.geometry.attributes[name].array);
    const want = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of parts) { want.set(a, o); o += a.length; }
    assert.deepEqual(Array.from(e.attrs[name].array), Array.from(want), name);
  }
  // Run order: run keys by first appearance, then (part, group).
  const keys = b.plan.runKeys;
  const first = new Map();
  keys.forEach((k, i) => { if (!first.has(k)) first.set(k, i); });
  for (let i = 1; i < b.plan.batch.length; i += 1) {
    const x = b.plan.batch[i - 1], y = b.plan.batch[i];
    const kx = first.get(keys[i - 1]), ky = first.get(keys[i]);
    assert.ok(kx < ky || (kx === ky && (x.part < y.part || (x.part === y.part && x.group < y.group))), `order at ${i}`);
  }
  assert.equal(e.vertexCount, b.plan.batch.length * 6);
});

await check("2. one entry for two rigs of one key; a one-float difference is a separate entry", async () => {
  const w = await R.world(true);
  const a = await w.spawn(0x50000911);
  const b = await w.spawn(0x50000912, 11, 10, 0);
  const c = await w.spawn(0x50000913, 12, 10, 0);
  // c: one leaf's geometry differs by one float (same counts: the same key).
  const leaf = R.leavesOf(c)[4];
  const g = leaf.geometry.clone();
  g.attributes.uv.array[3] += 0.25;
  leaf.geometry = g;
  w.settle();
  const eb = w.em._entityBatch;
  assert.equal(a._hbBatch.entry, b._hbBatch.entry, "shared");
  assert.equal(a._hbBatch.entry.users, 2);
  assert.notEqual(c._hbBatch.entry, a._hbBatch.entry, "not shared on the key alone");
  assert.equal(c._hbBatch.plan.key, a._hbBatch.plan.key, "same key");
  const st = eb.stats().entries;
  assert.equal(st.live, 2);
  assert.equal(st.collisions, 1);
  assert.equal(a._hbBatch.geometry.attributes.position, b._hbBatch.geometry.attributes.position, "the same BufferAttribute");
  assert.notEqual(a._hbBatch.geometry, b._hbBatch.geometry, "per-entity geometries");
  assert.equal(w.drawsOf().length, 21);
});

await check("3. hbBatchSlot / hbEntPart per leaf; one group per run", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000921, 10, 10, 0, { paletteId: 0x04000a01 });
  w.settle();
  const b = inst._hbBatch;
  const plan = b.plan;
  for (let i = 0; i < plan.batch.length; i += 1) {
    const sl = b.slices[i];
    const slot = plan.memberRefs.get(plan.members[i]).slot;
    const part = plan.partRow[plan.batch[i].part];
    for (let v = sl.vertexStart; v < sl.vertexStart + sl.vertexCount; v += 1) {
      assert.equal(b.attrSlot.array[v], slot);
      assert.equal(b.attrPart.array[v], part);
    }
    assert.ok(slot > 0 && part > 0);
  }
  assert.equal(b.geometry.groups.length, plan.runs.length);
  assert.equal(plan.runs.length, 7);
  let covered = 0;
  for (const gr of b.geometry.groups) covered += gr.count;
  assert.equal(covered, b.entry.vertexCount, "the groups cover the merged vertices");
  assert.equal(b.attrSlot.array.constructor, Float32Array, "Float32 (no USCALED conversion on ANGLE/D3D11)");
  assert.equal(b.mesh.material.length, new Set(plan.runs.map((r) => r.classEntry)).size);
});

await check("4. a full page splits a run (one more draw)", async () => {
  const w = await R.world(true);
  const pages = KIT.kitPages(w.renderer);
  pages.alloc.maxLayers = 1;
  pages.alloc.minLayers = 1;
  const inst = await w.spawn(0x50000931);
  w.settle();
  const b = inst._hbBatch;
  // A and A2 share a run key (64x64, opaque, one chain) but now land in two
  // pages. The run's leaves are in (part, group) order — A (parts 0, 3, 5,
  // 9), A2 (part 14), A (part 16) — so the run splits at every page change:
  // three runs instead of one (pages are per admission; the shared vertex
  // order is not).
  const ra = b.plan.runs.filter((r) => r.row.member.map.image.width === 64 && r.row.member.map.image.height === 64 && r.row.member.alphaTest === 0);
  assert.deepEqual(ra.map((r) => r.count), [4, 1, 1]);
  assert.notEqual(ra[0].row.page, ra[1].row.page);
  assert.equal(ra[0].row.page, ra[2].row.page);
  assert.ok(ra.every((r) => r.runKey === ra[0].runKey));
  assert.equal(b.plan.runs.length, 9);
  assert.equal(w.drawsOf().length, 9);
});

await check("5. indexed leaves over one shared stream: compacted, remapped, placed as the legacy leaves", async () => {
  const w = await R.world(true);
  const inst = await w.spawn(0x50000941);
  // Bundle-shaped: every leaf's geometry = ONE shared stream (all leaves'
  // vertices) + its own index naming its six vertices.
  const leaves = R.leavesOf(inst);
  const streams = { position: [], normal: [], uv: [] };
  const idx = [];
  let base = 0;
  for (const l of leaves) {
    const g = l.geometry;
    for (const n of Object.keys(streams)) streams[n].push(...g.attributes[n].array);
    const k = g.attributes.position.count;
    idx.push(Array.from({ length: k }, (_, j) => base + (k - 1 - j))); // reversed: a real remap
    base += k;
  }
  const shared = {
    position: new THREE.BufferAttribute(new Float32Array(streams.position), 3),
    normal: new THREE.BufferAttribute(new Float32Array(streams.normal), 3),
    uv: new THREE.BufferAttribute(new Float32Array(streams.uv), 2),
  };
  leaves.forEach((l, i) => {
    const g = new THREE.BufferGeometry();
    for (const n of Object.keys(shared)) g.setAttribute(n, shared[n]);
    g.setIndex(idx[i]);
    l.geometry = g;
  });
  w.settle();
  const b = inst._hbBatch;
  assert.equal(b.status, "active");
  assert.ok(b.entry.index, "indexed entry");
  assert.equal(b.entry.vertexCount, b.plan.batch.length * 6, "compacted to the referenced vertices");
  const draws = w.drawsOf();
  assert.equal(draws.length, 7);
  assert.ok(draws.every((d) => d.kind === "drawElementsInstanced"));
  // Each merged triangle names the same positions the leaf's index named.
  const ep = b.entry.attrs.position.array, ei = b.entry.index.array;
  for (let i = 0; i < b.plan.batch.length; i += 1) {
    const sl = b.slices[i];
    const g = b.plan.batch[i].leaf.geometry;
    for (let k = 0; k < g.index.count; k += 1) {
      const s = g.index.array[k] * 3, m = ei[sl.start + k] * 3;
      for (let c = 0; c < 3; c += 1) assert.equal(ep[m + c], g.attributes.position.array[s + c]);
    }
  }
});

await check("6. dispose: a non-last user deletes only its own buffers; the last one the shared ones too", async () => {
  const calls = [];
  const w = await R.world(true, { onCall: (n, a) => calls.push([n, a[0]]) });
  await w.spawn(0x50000951);
  await w.spawn(0x50000952, 11, 10, 0);
  w.settle();
  w.frame(2);
  const entry = w.em.entityMap.get(0x50000951)._hbBatch.entry;
  assert.equal(entry.users, 2);
  assert.equal(entry.glLive, true);
  calls.length = 0;
  w.em.remove(0x50000951);
  const del1 = calls.filter(([n]) => n === "deleteBuffer").length;
  calls.length = 0;
  w.frame(2);
  const created = calls.filter(([n]) => n === "createBuffer").length;
  assert.equal(w.drawsOf().length, 7, "the second rig still draws");
  calls.length = 0;
  w.em.remove(0x50000952);
  const del2 = calls.filter(([n]) => n === "deleteBuffer").length;
  assert.equal(del1, 2, "first release: its hbBatchSlot + hbEntPart buffers only");
  assert.equal(created, 0, "nothing re-uploaded for the second rig");
  assert.equal(del2, 2 + 3, "last release: its own two + the shared position / normal / uv");
  assert.equal(entry.users, 0);
  assert.equal(entry.glLive, false);
  assert.equal(w.em._entityBatch.stats().entries.idle, 1);
});

await check("7. tickets: shared arrays charged once, landed by three's upload callbacks; dropped on an early release", async () => {
  const w = await R.world(true);
  await w.spawn(0x50000961);
  await w.spawn(0x50000962, 11, 10, 0);
  const budget = KIT.kitBudget();
  // Tick (no render) until both rigs were built: tickets open, nothing uploaded.
  for (let i = 0; i < 10 && Object.keys(w.em._entityBatch.stats().byStatus).join() !== "overlap"; i += 1) w.tickOnly();
  assert.deepEqual(w.em._entityBatch.stats().byStatus, { overlap: 2 });
  assert.equal(budget.openTickets(), 3, "one shared (the entry's) + one per rig");
  const entry = w.em.entityMap.get(0x50000961)._hbBatch.entry;
  assert.ok(entry.ticket, "the entry owns the shared ticket");
  w.renderer.render(w.scene, w.camera);
  assert.equal(budget.openTickets(), 0, "landed at the first render");
  assert.equal(entry.ticket, null);
  assert.equal(entry.glLive, true);
  // Early release: built, never rendered.
  const w2 = await R.world(true);
  await w2.spawn(0x50000971);
  const b2 = KIT.kitBudget();
  for (let i = 0; i < 10 && w2.em._entityBatch.stats().byStatus.overlap !== 1; i += 1) w2.tickOnly();
  assert.equal(b2.openTickets(), 2);
  const dropped0 = b2.stats.dropped;
  w2.em.remove(0x50000971);
  assert.equal(b2.openTickets(), 0, "nothing stays open");
  assert.equal(b2.stats.dropped, dropped0 + 2, "both tickets dropped");
});

done();
