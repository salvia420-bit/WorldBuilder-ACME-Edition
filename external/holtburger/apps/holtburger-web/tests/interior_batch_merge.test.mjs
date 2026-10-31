// tests/interior_batch_merge.test.mjs — R3-5 `?interiorBatch` merged geometry
// (scene3d/gpu_batch/interior_batch.js mergeChunk / chunkBytesOf / planChunks;
// design §2.4, proof §6.1).
//
//   M1  merged vertices vs ?cellStaticMerge (scene3d/cell_static_merge.js
//       mergeCellStatics) on the SAME built containers: per prop group the
//       same triangles in the same order; position + landblock origin within
//       one f32 ulp of the merge's container-space f32; positions BIT-EXACT
//       against fround(f64 M * v - origin); normals and uvs exactly the
//       merge's. Shapes: multi-surface fused props, single-surface props,
//       legacy non-indexed cell slabs, T13 indexed shared-stream cells
//       (through the real cell_fusion.js), `?envcellFusion=off` meshes.
//   M2  compaction + remap: every source triangle of every entry maps to the
//       same per-vertex values; a vertex shared by two groups of one stream
//       is copied once per group; the merged index stays inside the entry's
//       vertex range; acBakedLight bytes verbatim (normalized u8).
//   M3  `hbBatchSlot` / `hbIbCell` per vertex = the entry's slot / code.
//   M4  planChunks: byte cap, 1536-cell cap, cell order, an oversize cell alone.
//   M5  chunkBytesOf == the bytes mergeChunk allocates (16-bit index up to
//       65,535 vertices, 32-bit past it); the live flag-on batches charged
//       exactly what they allocated.
//   M6  the merge job (beginMerge / mergeStep / finishMerge, the per-sync
//       budget's unit = one entry): sliced one entry per step it gives the
//       one-shot bytes, slices and M1-M3 values; its bounding box / sphere
//       are exactly three's computeBoundingBox / computeBoundingSphere.
//
// Run: node tests/interior_batch_merge.test.mjs   (needs `three` resolvable)

import assert from "node:assert/strict";
import * as THREE from "three";
import * as R from "./interior_batch_rig.mjs";

globalThis.window ??= {};
globalThis.location = { search: R.BASE_SEARCH };
globalThis.window.location = globalThis.location;
globalThis.window.requestAnimationFrame ??= () => 1;

const M = await import("../scene3d/materials.js");
const adapter = await import("../scene3d/adapter.js");
const KIT = await import("../scene3d/gpu_batch/kit.js");
const IB = await import("../scene3d/gpu_batch/interior_batch.js");
const { mergeCellStatics } = await import("../scene3d/cell_static_merge.js");
const { fuseSurfaceGroups } = await import("../scene3d/cell_fusion.js");
const deps = { M, adapter };
const cellsOff = await R.loadCells("");
const cellsUnfused = cellsOff; // envcellFusion is read at build time (R.build extra)
const cellsOn = await R.loadCells("interiorBatch=on");

let failures = 0;
let passes = 0;
async function t(name, fn) {
  try { await fn(); passes++; console.log("  ok ", name); } catch (e) { failures++; console.log("  FAIL", name); console.log(e); }
}

const ORIGIN = [R.LB_X, R.LB_Y, 0];
const f32 = Math.fround;
const ulp = (x) => {
  const a = Math.abs(f32(x));
  if (a === 0) return 2 ** -149;
  const e = Math.floor(Math.log2(a));
  return 2 ** (e - 23);
};

/** Entries of one candidate mesh (every drawn range), as interior_batch.js plans them. */
function entriesOf(container, mesh, group, slot0 = 3, code0 = 4097) {
  const matrix = IB.candidateMatrix(container, mesh, group, new THREE.Matrix4());
  return IB.drawnRangesOf(mesh).map((rg, i) => ({
    mesh, member: rg.material, geometry: mesh.geometry, start: rg.start, count: rg.count, matrix, slot: slot0 + i, code: code0 + 2 * i,
  }));
}

/** The source vertex the entry's k-th triangle corner names. */
const srcVertex = (e, k) => (e.geometry.index ? e.geometry.index.array[e.start + k] : e.start + k);

/** The reference vertex (cellStaticMerge math): f64 M * v (position), N * n normalized, uv verbatim. */
function refVertex(e, v) {
  const g = e.geometry;
  const p = new THREE.Vector3().fromBufferAttribute(g.attributes.position, v).applyMatrix4(e.matrix);
  const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, v).applyMatrix3(new THREE.Matrix3().getNormalMatrix(e.matrix)).normalize();
  return { p, n, uv: [g.attributes.uv.getX(v), g.attributes.uv.getY(v)] };
}

/** Check one merged geometry against its entries (M1 formula + M2 + M3). */
function checkMerged(entries, merged) {
  const g = merged.geometry;
  const P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv.array;
  const SL = g.attributes.hbBatchSlot.array, CE = g.attributes.hbIbCell.array, I = g.index.array;
  const B = g.attributes.acBakedLight ? g.attributes.acBakedLight.array : null;
  for (let k = 0; k < entries.length; k += 1) {
    const e = entries[k];
    const s = merged.slices[k];
    assert.equal(s.indexCount, e.count);
    const seen = new Map(); // source vertex -> merged vertex (must be one-to-one per entry)
    for (let j = 0; j < e.count; j += 1) {
      const v = srcVertex(e, j);
      const mv = I[s.indexStart + j];
      assert.ok(mv >= s.vertexStart && mv < s.vertexStart + s.vertexCount, "index inside the entry's vertices");
      if (seen.has(v)) assert.equal(seen.get(v), mv, "one merged copy per source vertex per entry");
      seen.set(v, mv);
      const r = refVertex(e, v);
      // Positions: bit-exact vs fround(f64 - origin).
      assert.equal(P[mv * 3], f32(r.p.x - ORIGIN[0]));
      assert.equal(P[mv * 3 + 1], f32(r.p.y - ORIGIN[1]));
      assert.equal(P[mv * 3 + 2], f32(r.p.z - ORIGIN[2]));
      // + origin: within one f32 ulp of the container-space f32 (the merge's precision).
      for (let c = 0; c < 3; c += 1) {
        const back = P[mv * 3 + c] + ORIGIN[c];
        const cs = f32([r.p.x, r.p.y, r.p.z][c]);
        assert.ok(Math.abs(back - cs) <= ulp(cs), `pos+origin ${back} vs ${cs}`);
      }
      assert.equal(N[mv * 3], f32(r.n.x)); assert.equal(N[mv * 3 + 1], f32(r.n.y)); assert.equal(N[mv * 3 + 2], f32(r.n.z));
      assert.equal(U[mv * 2], r.uv[0]); assert.equal(U[mv * 2 + 1], r.uv[1]);
      if (B) for (let c = 0; c < 3; c += 1) assert.equal(B[mv * 3 + c], e.geometry.attributes.acBakedLight.array[v * 3 + c], "baked light verbatim");
      assert.equal(SL[mv], e.slot, "M3 slot per vertex");
      assert.equal(CE[mv], e.code, "M3 cell code per vertex");
    }
    assert.equal(seen.size, s.vertexCount, "compacted: exactly the referenced vertices");
  }
  if (B) assert.equal(g.attributes.acBakedLight.normalized, true);
}

await t("M1 props: merged triangles = mergeCellStatics', positions f32-exact + within an ulp of its container-space f32, normals / uvs equal", async () => {
  KIT.resetKit();
  const w = await R.makeWorld(deps);
  await R.build(cellsOff, w);
  let groupsChecked = 0;
  for (const id of R.CELL_IDS) {
    const container = w.scene3d.cellContainers3d.get(id);
    const { props } = IB.interiorCandidatesOf(container);
    if (props.length === 0) continue;
    const entries = props.flatMap((m) => entriesOf(container, m, null));
    const merged = IB.mergeChunk(entries, ORIGIN);
    checkMerged(entries, merged);
    // The real ?cellStaticMerge on a clone of the same container (it replaces
    // the props in place), bucketed by (material, layout) in prop order.
    const clone = container.clone();
    const propsClone = clone.children.filter((c) => c.userData?.isCellStatic && c.isMesh);
    const r = mergeCellStatics(THREE, clone, { shadow: false });
    assert.equal(r.props, propsClone.length);
    const mergedMeshes = clone.children.filter((c) => c.userData?.isCellStaticMerged);
    // Reconstruct bucket offsets exactly as mergeCellStatics fills them.
    const buckets = new Map();
    for (const m of propsClone) {
      for (const rg of IB.drawnRangesOf(m)) {
        const k = rg.material;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({ mesh: m, ...rg });
      }
    }
    let bi = 0;
    for (const [mat, items] of buckets) {
      const mm = mergedMeshes[bi++];
      assert.equal(mm.material, mat, "bucket order = first use");
      const P2 = mm.geometry.attributes.position.array, N2 = mm.geometry.attributes.normal.array, U2 = mm.geometry.attributes.uv.array;
      let wv = 0;
      for (const it of items) {
        const pi = propsClone.indexOf(it.mesh);
        const e = entries.find((x) => x.mesh === props[pi] && x.start === it.start);
        const s = merged.slices[entries.indexOf(e)];
        const I = merged.geometry.index.array, P = merged.geometry.attributes.position.array;
        const N = merged.geometry.attributes.normal.array, U = merged.geometry.attributes.uv.array;
        for (let j = 0; j < it.count; j += 1, wv += 1) {
          const mv = I[s.indexStart + j];
          for (let c = 0; c < 3; c += 1) {
            const back = P[mv * 3 + c] + ORIGIN[c];
            assert.ok(Math.abs(back - P2[wv * 3 + c]) <= ulp(P2[wv * 3 + c]), `vs mergeCellStatics: ${back} vs ${P2[wv * 3 + c]}`);
            assert.equal(N[mv * 3 + c], N2[wv * 3 + c], "normal = the merge's");
          }
          assert.equal(U[mv * 2], U2[wv * 2]); assert.equal(U[mv * 2 + 1], U2[wv * 2 + 1]);
        }
        groupsChecked += 1;
      }
      assert.equal(wv, mm.geometry.attributes.position.count, "same triangle count");
    }
  }
  assert.ok(groupsChecked >= 4, `prop groups checked: ${groupsChecked} (single + multi-surface)`);
});

await t("M1 cells: legacy non-indexed slabs (fused) and ?envcellFusion=off meshes, C * G * m in f64", async () => {
  for (const [cells, label, extra] of [[cellsOff, "fused", ""], [cellsUnfused, "unfused", "envcellFusion=off"]]) {
    KIT.resetKit();
    const w = await R.makeWorld(deps);
    await R.build(cells, w, {}, extra);
    let n = 0;
    for (const id of R.CELL_IDS) {
      const container = w.scene3d.cellContainers3d.get(id);
      const { cells: cand } = IB.interiorCandidatesOf(container);
      assert.ok(cand.length > 0, `${label}: cell surface candidates in ${id.toString(16)}`);
      const entries = cand.flatMap((c) => entriesOf(container, c.mesh, c.group));
      const merged = IB.mergeChunk(entries, ORIGIN);
      checkMerged(entries, merged);
      n += entries.length;
      // The reference matrix really is what three draws with (below cellsGroup).
      for (const c of cand) {
        c.mesh.updateWorldMatrix(true, false);
        const mw = new THREE.Matrix4().copy(w.scene3d.cellsGroup.matrixWorld).multiply(IB.candidateMatrix(container, c.mesh, c.group));
        for (let i = 0; i < 16; i += 1) assert.ok(Math.abs(mw.elements[i] - c.mesh.matrixWorld.elements[i]) <= 1e-9 * Math.max(1, Math.abs(mw.elements[i])), "matrixWorld agrees");
      }
      if (label === "unfused") assert.ok(cand.every((c) => !c.mesh.userData.fused), "unfused: per-surface meshes");
    }
    assert.equal(n, 7, `${label}: every opaque cell surface (3 + 1 + 2 + 1; the translucent one stays out)`);
  }
});

await t("M1 + M2 T13 indexed shared-stream cells through the real cell_fusion.js (shared vertices copied per group)", () => {
  // One cell stream of 6 vertices, two groups whose indices SHARE vertices 2..3.
  const pos = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0.5, 2, 1, 0.25]), 3);
  const nrm = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0.6, 0.8, 0, 0, 1, 0.6, 0, 0.8, 0, 0, 1]), 3);
  const uv = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 0.25, 0.75]), 2);
  const bl = new THREE.BufferAttribute(new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180]), 3, true);
  const group = (idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", pos); g.setAttribute("normal", nrm); g.setAttribute("uv", uv); g.setAttribute("acBakedLight", bl);
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    return { group: { geometry: g } };
  };
  const fused = fuseSurfaceGroups([group([0, 1, 2, 0, 2, 3]), group([2, 4, 5, 3, 2, 5])], true);
  assert.ok(fused.index, "premise: T13 shape stays indexed");
  assert.equal(fused.attributes.position, pos, "premise: shared stream");
  const mat = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
  const mesh = new THREE.Mesh(fused, mat);
  const container = new THREE.Group();
  const mg = new THREE.Group();
  mg.name = "mesh-x";
  mg.position.set(R.LB_X + 50.5, R.LB_Y + 60.25, 7);
  mg.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  container.add(mg);
  mg.add(mesh);
  const entries = entriesOf(container, mesh, mg);
  assert.equal(entries.length, 2);
  const merged = IB.mergeChunk(entries, ORIGIN);
  checkMerged(entries, merged);
  assert.equal(merged.slices[0].vertexCount, 4);
  assert.equal(merged.slices[1].vertexCount, 4, "group 2 references 2,3,4,5: its own copies of 2 and 3");
  assert.equal(merged.vertexCount, 8);
  assert.equal(merged.geometry.index.array.constructor, Uint16Array);
  // An index naming a vertex the stream lacks is refused (no out-of-range copy).
  const bad = new THREE.BufferGeometry();
  bad.setAttribute("position", pos);
  bad.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 99]), 1));
  assert.equal(IB.rangeVerticesOf(bad, 0, 3), false);
});

await t("M4 planChunks: byte cap, 1536-cell cap, order kept, an oversize cell alone", () => {
  const cells = (bytes) => bytes.map((b) => ({ bytes: b }));
  assert.deepEqual(IB.planChunks(cells([10, 10, 10]), 100), [[0, 1, 2]]);
  assert.deepEqual(IB.planChunks(cells([60, 50, 40, 70]), 100), [[0], [1, 2], [3]]);
  assert.deepEqual(IB.planChunks(cells([500, 10, 10]), 100), [[0], [1, 2]], "oversize alone");
  const many = IB.planChunks(cells(new Array(4000).fill(1)), 1e9);
  assert.deepEqual(many.map((c) => c.length), [1536, 1536, 928]);
  assert.deepEqual(many.flat(), Array.from({ length: 4000 }, (_, i) => i), "cell order kept");
});

await t("M5 chunkBytesOf == allocated bytes (16-bit and 32-bit index); live batches charged what they allocated", async () => {
  // A non-indexed slab over 70k vertices: 32-bit index.
  const n = 70002;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => i * 0.001), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const e = { geometry: g, start: 0, count: n, matrix: new THREE.Matrix4(), slot: 1, code: 4096 };
  const big = IB.mergeChunk([e], ORIGIN);
  assert.equal(big.geometry.index.array.constructor, Uint32Array);
  assert.equal(IB.chunkBytesOf([e]), big.bytes);
  let alloc = 0;
  for (const a of Object.values(big.geometry.attributes)) alloc += a.array.byteLength;
  alloc += big.geometry.index.array.byteLength;
  assert.equal(alloc, big.bytes);
  const small = { ...e, count: 300 };
  const s = IB.mergeChunk([small], ORIGIN);
  assert.equal(s.geometry.index.array.constructor, Uint16Array);
  assert.equal(IB.chunkBytesOf([small]), s.bytes);
  // Live: the flag-on world's chunk charged exactly its batches' bytes.
  KIT.resetKit();
  IB.disposeInteriorBatches();
  IB.__setInteriorBatchEnvForTest({ mode: "on", now: R.FROZEN_CLOCK });
  const w = await R.makeWorld(deps);
  await R.build(cellsOn, w);
  const sh = R.makeSession({ player: (R.LB | 0x31) >>> 0, indoor: false, frustum: R.CELL_IDS, walk: [], bfs: [] });
  for (let f = 0; f < 3; f += 1) { R.tick(cellsOn, w, sh); R.renderPass(w, R.MASK_BOTH); }
  const S = IB.__interiorBatchStateForTest();
  const ch = [...S.lbs.values()][0].chunks[0];
  assert.equal(ch.status, "active");
  let sum = 0;
  for (const b of ch.batches) {
    let a = 0;
    for (const at of Object.values(b.geometry.attributes)) a += at.array.byteLength;
    a += b.geometry.index.array.byteLength;
    assert.equal(a, b.cpuBytes);
    assert.equal(IB.chunkBytesOf(b.entries), b.cpuBytes);
    // The live batch is the pure merge of its entries.
    const again = IB.mergeChunk(b.entries, [R.LB_X, R.LB_Y, 0]);
    assert.deepEqual(Array.from(again.geometry.attributes.position.array), Array.from(b.geometry.attributes.position.array));
    sum += a;
  }
  assert.equal(ch.bytes, sum, "the deferred geometry ticket = the allocation");
  IB.disposeInteriorBatches();
});

await t("M6 a merge sliced entry by entry = the one-shot merge; finishMerge's bounds = three's computeBoundingBox / computeBoundingSphere", async () => {
  KIT.resetKit();
  const w = await R.makeWorld(deps);
  await R.build(cellsOff, w);
  const entries = [];
  for (const id of R.CELL_IDS) {
    const container = w.scene3d.cellContainers3d.get(id);
    const { cells, props } = IB.interiorCandidatesOf(container);
    for (const c of cells) entries.push(...entriesOf(container, c.mesh, c.group, 5, 4097 + entries.length * 2));
    for (const m of props) entries.push(...entriesOf(container, m, null, 9, 4097 + entries.length * 2));
  }
  // One layout per merge (the planner's key): the baked cell slabs, the props.
  const byLayout = new Map();
  for (const e of entries) {
    const k = IB.layoutOf(e.geometry);
    if (!byLayout.has(k)) byLayout.set(k, []);
    byLayout.get(k).push(e);
  }
  assert.ok(byLayout.size >= 2 && entries.length >= 10, `premise: ${entries.length} entries, ${byLayout.size} layouts`);
  for (const list of byLayout.values()) {
    const one = IB.mergeChunk(list, ORIGIN);
    const job = IB.beginMerge(list, ORIGIN);
    let calls = 0;
    while (!IB.mergeStep(job, 0, () => 1)) calls += 1; // every clock read past the deadline: one entry a call
    assert.equal(calls, list.length - 1, "one entry per step");
    const sliced = IB.finishMerge(job);
    for (const n of Object.keys(one.geometry.attributes)) {
      assert.deepEqual(Array.from(sliced.geometry.attributes[n].array), Array.from(one.geometry.attributes[n].array), n);
    }
    assert.deepEqual(Array.from(sliced.geometry.index.array), Array.from(one.geometry.index.array));
    assert.deepEqual(sliced.slices, one.slices);
    assert.equal(sliced.bytes, one.bytes);
    // Bounds: three's own computation on the same attributes.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", one.geometry.attributes.position.clone());
    g.computeBoundingBox();
    g.computeBoundingSphere();
    assert.ok(one.geometry.boundingBox.min.equals(g.boundingBox.min) && one.geometry.boundingBox.max.equals(g.boundingBox.max), "box");
    assert.ok(one.geometry.boundingSphere.center.equals(g.boundingSphere.center), "sphere centre");
    assert.equal(one.geometry.boundingSphere.radius, g.boundingSphere.radius, "sphere radius");
    checkMerged(list, sliced);
  }
  // An empty-range edge: a single-vertex-free entry list cannot occur (a batch has >= 1 entry);
  // a degenerate 3-vertex slab still bounds exactly.
  const tri = new THREE.BufferGeometry();
  tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([1, 2, 3, 1, 2, 3, 1, 2, 3]), 3));
  tri.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  tri.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  const d = IB.mergeChunk([{ geometry: tri, start: 0, count: 3, matrix: new THREE.Matrix4(), slot: 1, code: 4096 }], ORIGIN);
  assert.equal(d.geometry.boundingSphere.radius, 0);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
