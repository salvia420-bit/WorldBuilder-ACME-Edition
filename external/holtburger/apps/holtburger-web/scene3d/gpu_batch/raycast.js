// scene3d/gpu_batch/raycast.js — R3-3 K2: the raycast facade
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 7).
//
// A batch draw moves its vertices on the GPU (row matrices, per-vertex pose
// rows), so three's Mesh / InstancedMesh raycast — which only knows the
// object's own matrix and the static instance attribute — misses what is
// drawn. The facade raycasts the batch as SLICES: a slice is a contiguous
// index (or vertex) range of the merged geometry that moves as one (a part),
// and `matrixAt(instance, slice, out)` supplies the matrix the vertex shader
// composes for it (the JS mirror of the shader, e.g. anim_scenery_gpu.js
// posedMatrixFromRow). Each (instance, slice) is tested with three's own
// Mesh.raycast on a scratch Mesh restricted to the slice's range, so hit
// points, faces, uvs and distances are three's.
//
// Hits report `object` = the batch mesh, `instanceId`, `batchSlice` (the
// slice index) and `batchPart` (the slice's `part` tag). A zero matrix (a
// collapsed instance or part) is skipped: it draws nothing, so it is not
// hit — "only what is drawn is pickable" (picking.js PICK-VIS).

import * as THREE from "three";

let _scratchMesh = null; // lazy: no import-time allocation
const _m = new THREE.Matrix4();
const _hits = [];

function _isZero(e) {
  for (let i = 0; i < 16; i += 1) if (e[i] !== 0) return false;
  return true;
}

/**
 * Raycast `mesh` (an InstancedMesh or Mesh carrying a merged geometry) slice
 * by slice. `opts.slices`: [{ start, count, part }] in index units (vertex
 * units for a non-indexed geometry); `opts.matrixAt(instanceId, slice, out)`
 * writes the slice's object-space -> mesh-space matrix (return false to
 * skip); `opts.instances()` the instance count (default mesh.count, or 1).
 */
export function raycastBatchSlices(mesh, raycaster, intersects, opts) {
  const geo = mesh.geometry;
  if (!geo || !opts || !Array.isArray(opts.slices) || typeof opts.matrixAt !== "function") return;
  const n = typeof opts.instances === "function" ? opts.instances() : (mesh.isInstancedMesh ? mesh.count : 1);
  if (geo.boundingSphere === null) geo.computeBoundingSphere();
  const saveRange = { start: geo.drawRange.start, count: geo.drawRange.count };
  const tmp = _scratchMesh || (_scratchMesh = new THREE.Mesh());
  tmp.geometry = geo;
  tmp.material = mesh.material;
  try {
    for (let i = 0; i < n; i += 1) {
      for (let s = 0; s < opts.slices.length; s += 1) {
        const slice = opts.slices[s];
        if (opts.matrixAt(i, slice, _m) === false) continue;
        if (_isZero(_m.elements)) continue;
        tmp.matrixWorld.multiplyMatrices(mesh.matrixWorld, _m);
        geo.drawRange.start = slice.start;
        geo.drawRange.count = slice.count;
        _hits.length = 0;
        THREE.Mesh.prototype.raycast.call(tmp, raycaster, _hits);
        for (const h of _hits) {
          h.object = mesh;
          h.instanceId = i;
          h.batchSlice = s;
          h.batchPart = slice.part;
          intersects.push(h);
        }
      }
    }
  } finally {
    geo.drawRange.start = saveRange.start;
    geo.drawRange.count = saveRange.count;
    tmp.geometry = null;
    tmp.material = null;
    _hits.length = 0;
  }
}

/** Install the facade as `mesh.raycast`. Returns the mesh. */
export function installBatchRaycast(mesh, opts) {
  mesh.raycast = function hbBatchRaycast(raycaster, intersects) {
    raycastBatchSlices(this, raycaster, intersects, opts);
  };
  return mesh;
}

/** `raycast` that reports nothing (a legacy mesh whose draw a batch took over). */
export function noRaycast() {}
