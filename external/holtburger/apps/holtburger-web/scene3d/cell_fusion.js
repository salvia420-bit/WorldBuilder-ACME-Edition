// Per-cell surface-group fusion (extracted from cells.js buildFusedMesh,
// 2026-08-10, so the E1-DIRTY fracture class has a node-testable seam).
//
// Fuses one cell's per-surface geometry groups into a single BufferGeometry
// whose `groups` map materialIndex slots onto the caller's parallel materials
// array. Two source shapes exist, and feeding shape 2 through shape 1's copy
// is exactly the "fractured interiors" defect the R9 290 eye run found
// (missing triangle chunks + giant shards — the raw vertex stream drawn as
// triangle soup):
//   1. legacy `meshToGeometryGroups`: NON-indexed per-surface geometries
//      (position[N*9]/uv[N*6]/normal[N*9]) — concatenate the slabs,
//      vertex-unit groups.
//   2. T13 `cellToGeometryGroups` bundles: INDEXED groups whose attributes
//      are SHARED whole-cell vertex-stream views (one `_entryAttributes`
//      per cell) + a compact per-group index. Fuse by concatenating the
//      per-group INDEX arrays over the shared streams — `addGroup` counts
//      index values once `setIndex` is present, and the de-index blowup
//      T13 avoided stays avoided.
import * as THREE from "three";

/**
 * @param {Array<{group: {geometry: THREE.BufferGeometry}}>} bucket
 * @param {boolean} cellBaked attach the fused acBakedLight attribute
 *   (RND-04: caller guarantees EVERY group carries it when true —
 *   all-or-nothing per bucket, a partial fusion would feed (0,0,0) to the
 *   un-baked runs, which under the suppress-direct arm renders them black)
 * @returns {THREE.BufferGeometry}
 */
export function fuseSurfaceGroups(bucket, cellBaked) {
  const allIndexed = bucket.every((b) => b.group.geometry.getIndex());
  const sharedStreams =
    allIndexed &&
    bucket.every(
      (b) =>
        b.group.geometry.attributes.position ===
        bucket[0].group.geometry.attributes.position
    );
  const fused = new THREE.BufferGeometry();

  if (sharedStreams) {
    const g0 = bucket[0].group.geometry;
    let totalIdx = 0;
    for (const b of bucket) totalIdx += b.group.geometry.getIndex().count;
    const IndexArr =
      g0.attributes.position.count <= 0xffff ? Uint16Array : Uint32Array;
    const mergedIndex = new IndexArr(totalIdx);
    let idxOffset = 0;
    for (let i = 0; i < bucket.length; i += 1) {
      const idx = bucket[i].group.geometry.getIndex();
      mergedIndex.set(idx.array, idxOffset);
      fused.addGroup(idxOffset, idx.count, i);
      idxOffset += idx.count;
    }
    fused.setAttribute("position", g0.attributes.position);
    fused.setAttribute("uv", g0.attributes.uv);
    fused.setAttribute("normal", g0.attributes.normal);
    if (cellBaked) {
      fused.setAttribute("acBakedLight", g0.getAttribute("acBakedLight"));
    }
    fused.setIndex(new THREE.BufferAttribute(mergedIndex, 1, false));
  } else {
    // Non-indexed slabs (legacy), or the defensive mixed case — de-index
    // everything into merged flat arrays. `vertsOf` counts OUTPUT vertices
    // (index count when indexed).
    const vertsOf = (g) =>
      g.getIndex() ? g.getIndex().count : g.attributes.position.count;
    let totalVerts = 0;
    for (const b of bucket) totalVerts += vertsOf(b.group.geometry);

    const mergedPos = new Float32Array(totalVerts * 3);
    const mergedUv = new Float32Array(totalVerts * 2);
    const mergedNormal = new Float32Array(totalVerts * 3);
    const mergedBaked = cellBaked ? new Uint8Array(totalVerts * 3) : null;

    let vertexOffset = 0;
    for (let i = 0; i < bucket.length; i += 1) {
      const srcGeom = bucket[i].group.geometry;
      const srcPos = srcGeom.attributes.position.array;
      const srcUv = srcGeom.attributes.uv.array;
      const srcNorm = srcGeom.attributes.normal.array;
      const srcBaked = mergedBaked
        ? srcGeom.getAttribute("acBakedLight").array
        : null;
      const idx = srcGeom.getIndex();
      const vertCount = vertsOf(srcGeom);

      if (idx) {
        for (let k = 0; k < idx.count; k += 1) {
          const v = idx.array[k];
          const o = vertexOffset + k;
          mergedPos[o * 3] = srcPos[v * 3];
          mergedPos[o * 3 + 1] = srcPos[v * 3 + 1];
          mergedPos[o * 3 + 2] = srcPos[v * 3 + 2];
          mergedUv[o * 2] = srcUv[v * 2];
          mergedUv[o * 2 + 1] = srcUv[v * 2 + 1];
          mergedNormal[o * 3] = srcNorm[v * 3];
          mergedNormal[o * 3 + 1] = srcNorm[v * 3 + 1];
          mergedNormal[o * 3 + 2] = srcNorm[v * 3 + 2];
          if (mergedBaked) {
            mergedBaked[o * 3] = srcBaked[v * 3];
            mergedBaked[o * 3 + 1] = srcBaked[v * 3 + 1];
            mergedBaked[o * 3 + 2] = srcBaked[v * 3 + 2];
          }
        }
      } else {
        mergedPos.set(srcPos, vertexOffset * 3);
        mergedUv.set(srcUv, vertexOffset * 2);
        mergedNormal.set(srcNorm, vertexOffset * 3);
        if (mergedBaked) {
          mergedBaked.set(srcBaked, vertexOffset * 3);
        }
      }

      // addGroup is in *vertex* units for non-indexed geometry (the docs
      // use "index/vertex" interchangeably depending on whether setIndex
      // was called) — start/count count vertices, materialIndex picks the
      // slot in the caller's materials array.
      fused.addGroup(vertexOffset, vertCount, i);
      vertexOffset += vertCount;
    }

    fused.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3, false));
    fused.setAttribute("uv", new THREE.BufferAttribute(mergedUv, 2, false));
    fused.setAttribute("normal", new THREE.BufferAttribute(mergedNormal, 3, false));
    if (mergedBaked) {
      fused.setAttribute(
        "acBakedLight",
        new THREE.BufferAttribute(mergedBaked, 3, true),
      );
    }
  }
  fused.computeBoundingSphere();
  return fused;
}
