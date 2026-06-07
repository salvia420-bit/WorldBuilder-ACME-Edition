// scene3d/bake_transfer.js
//
// M2 (worker-based asset bake) — transferable serialization for the heavy
// WASM decoders so their output can cross a Web Worker `postMessage`
// boundary with zero-copy `ArrayBuffer` transfer.
//
// WHY THIS EXISTS
// `wasmExports.fetch_model_meshes(ids)` returns wasm-bindgen `ModelMesh`
// instances backed by WASM linear memory; their getters copy fresh typed
// arrays out of that memory on each read. Such instances cannot be
// structured-cloned or transferred across a worker boundary. A bake worker
// must therefore (1) read each getter ONCE into a plain typed array and
// (2) `postMessage` a plain object whose keys EXACTLY mirror the
// wasm-bindgen JS getter names, transferring the backing `ArrayBuffer`s.
//
// The reconstructed object is then a DROP-IN for the existing main-thread
// consumers, which read these fields as properties:
//   - `adapter.js::meshToGeometryGroups` →
//       `.positions .uvs .normals .surfaceIndices .sidesTypes .surfaces .triCount`
//   - `statics.js` LOD / sprite-footprint → `.didDegrade`, `.bbox`, `.worldBounds`
// so NO consumer needs to change when a mesh arrives via the worker.
//
// `triCount` and `worldBounds` are DERIVED getters on the wasm struct
// (`tri_count = positions.len()/9`; `worldBounds = bbox max-min on X,Y`).
// We recompute them on reconstruct so the plain object is byte-identical to
// what the wasm getters would have returned — never transferring redundant
// data for them.
//
// This module is intentionally PURE (no `three`, no DOM, no WASM) so it can
// be unit-tested under Node and reused unchanged in the worker and on the
// main thread. The actual `new Worker()` + WASM init live in
// `bake_worker.js` / `bake_worker_client.js` (browser glue) on top of this.

/**
 * @typedef {Object} ModelMeshPayload
 * @property {Float32Array} positions      9 floats/tri (3 verts × xyz)
 * @property {Float32Array} uvs            6 floats/tri (3 verts × uv)
 * @property {Float32Array} normals        9 floats/tri (per-vertex)
 * @property {Uint8Array}   surfaceIndices 1 byte/tri → index into `surfaces` (0xFF = none)
 * @property {Uint8Array}   sidesTypes     1 byte/tri → polygon `sides_type` cull bit
 * @property {Uint32Array}  surfaces       unique surface DIDs, first-seen order
 * @property {Float32Array} bbox           [minX,minY,minZ, maxX,maxY,maxZ]
 * @property {number}       didDegrade     LOD degrade-chain DID (0 = none)
 */

/**
 * Collect a typed array's backing buffer into `out` (deduped) — defensive
 * against multiple views sharing one `ArrayBuffer`, which would throw
 * ("ArrayBuffer at index N is already detached") if transferred twice.
 * @param {Set<ArrayBuffer>} seen
 * @param {ArrayBuffer[]} out
 * @param {{buffer: ArrayBuffer}} ta
 */
function pushBuffer(seen, out, ta) {
  const buf = ta.buffer;
  if (!seen.has(buf)) {
    seen.add(buf);
    out.push(buf);
  }
}

/**
 * Serialize one wasm-bindgen `ModelMesh` (or any object exposing the same
 * JS getters) into a transferable payload + the `ArrayBuffer`s to transfer.
 * Each getter is read exactly once (one copy out of WASM memory).
 *
 * @param {*} wasmMesh
 * @returns {{ mesh: ModelMeshPayload, transfer: ArrayBuffer[] }}
 */
export function serializeModelMesh(wasmMesh) {
  const positions = wasmMesh.positions; // Float32Array
  const uvs = wasmMesh.uvs; // Float32Array
  const normals = wasmMesh.normals; // Float32Array
  const surfaceIndices = wasmMesh.surfaceIndices; // Uint8Array
  const sidesTypes = wasmMesh.sidesTypes; // Uint8Array
  const surfaces = wasmMesh.surfaces; // Uint32Array
  const bbox = wasmMesh.bbox; // Float32Array(6)
  const didDegrade = wasmMesh.didDegrade >>> 0; // u32

  const mesh = {
    positions,
    uvs,
    normals,
    surfaceIndices,
    sidesTypes,
    surfaces,
    bbox,
    didDegrade,
  };

  const seen = new Set();
  const transfer = [];
  pushBuffer(seen, transfer, positions);
  pushBuffer(seen, transfer, uvs);
  pushBuffer(seen, transfer, normals);
  pushBuffer(seen, transfer, surfaceIndices);
  pushBuffer(seen, transfer, sidesTypes);
  pushBuffer(seen, transfer, surfaces);
  pushBuffer(seen, transfer, bbox);

  return { mesh, transfer };
}

/**
 * Serialize a `Vec<ModelMesh>` (array of wasm meshes) into one payload +
 * a single deduped transfer list for a batched `postMessage`.
 *
 * @param {Iterable<*>} wasmMeshes
 * @returns {{ meshes: ModelMeshPayload[], transfer: ArrayBuffer[] }}
 */
export function serializeModelMeshes(wasmMeshes) {
  const meshes = [];
  const seen = new Set();
  const transfer = [];
  for (const wm of wasmMeshes) {
    const { mesh, transfer: t } = serializeModelMesh(wm);
    meshes.push(mesh);
    for (const buf of t) {
      if (!seen.has(buf)) {
        seen.add(buf);
        transfer.push(buf);
      }
    }
  }
  return { meshes, transfer };
}

/**
 * Reconstruct a drop-in mesh object from a transferred payload. The result
 * exposes the SAME field surface the main-thread consumers read off a wasm
 * `ModelMesh`. `triCount` and `worldBounds` are derived to match the
 * wasm-bindgen getters exactly.
 *
 * @param {ModelMeshPayload} p
 */
export function reconstructModelMesh(p) {
  const positions = p.positions;
  const bbox = p.bbox;
  const hasBbox = bbox && bbox.length >= 6;
  return {
    positions,
    uvs: p.uvs,
    normals: p.normals,
    surfaceIndices: p.surfaceIndices,
    sidesTypes: p.sidesTypes,
    surfaces: p.surfaces,
    bbox,
    didDegrade: p.didDegrade >>> 0,
    // Derived — identical to the wasm-bindgen `triCount` / `worldBounds`
    // getters (tri_count = positions.len()/9; world bounds = bbox max-min
    // on X,Y). Recomputed so we never transfer redundant scalars.
    triCount: (positions.length / 9) >>> 0,
    worldBounds: hasBbox
      ? Float32Array.of(bbox[3] - bbox[0], bbox[4] - bbox[1])
      : Float32Array.of(0, 0),
  };
}

/**
 * Reconstruct an array of drop-in meshes from a batched payload.
 * @param {ModelMeshPayload[]} payload
 */
export function reconstructModelMeshes(payload) {
  return payload.map(reconstructModelMesh);
}

// ---------------------------------------------------------------------------
// SurfacePixels — `fetch_surfaces_pixels` decoder output
// ---------------------------------------------------------------------------
//
// Same drop-in contract as ModelMesh. Consumers read these JS getter names:
//   - `adapter.js::surfacePixelsToTexture` → `.pixels .width .height`
//   - `adapter.js::surfacePixels{Normal,Height}Texture` → `.normalPixels .heightPixels`
//   - `materials.js::_materialFromFlags` → `.surfaceType .category
//       .roughnessOverride .normalScaleOverride .translucency .luminosity .diffuse`
// All fields are direct (no derived getters), so reconstruct is a plain
// passthrough that pins key presence + scalar coercion. Empty `normalPixels`
// / `heightPixels` (Luminous / flat surfaces) round-trip as empty arrays.

/**
 * @typedef {Object} SurfacePixelsPayload
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} pixels        RGBA8, length = width*height*4
 * @property {number} surfaceType       Surface.surface_type bitfield
 * @property {number} category          SurfaceCategory::as_u8
 * @property {Uint8Array} normalPixels  RGB8 (may be empty)
 * @property {Uint8Array} heightPixels  R8 (may be empty)
 * @property {number} roughnessOverride
 * @property {number} normalScaleOverride
 * @property {number} translucency
 * @property {number} luminosity
 * @property {number} diffuse
 */

/**
 * Serialize one wasm-bindgen `SurfacePixels` into a transferable payload.
 * @param {*} sp
 * @returns {{ surface: SurfacePixelsPayload, transfer: ArrayBuffer[] }}
 */
export function serializeSurfacePixels(sp) {
  const pixels = sp.pixels; // Uint8Array
  const normalPixels = sp.normalPixels; // Uint8Array (maybe empty)
  const heightPixels = sp.heightPixels; // Uint8Array (maybe empty)

  const surface = {
    width: sp.width >>> 0,
    height: sp.height >>> 0,
    pixels,
    surfaceType: sp.surfaceType >>> 0,
    category: sp.category & 0xff,
    normalPixels,
    heightPixels,
    roughnessOverride: sp.roughnessOverride,
    normalScaleOverride: sp.normalScaleOverride,
    translucency: sp.translucency,
    luminosity: sp.luminosity,
    diffuse: sp.diffuse,
  };

  const seen = new Set();
  const transfer = [];
  pushBuffer(seen, transfer, pixels);
  pushBuffer(seen, transfer, normalPixels);
  pushBuffer(seen, transfer, heightPixels);

  return { surface, transfer };
}

/**
 * Serialize a `Vec<SurfacePixels>` into one payload + deduped transfer list.
 * @param {Iterable<*>} surfaces
 * @returns {{ surfaces: SurfacePixelsPayload[], transfer: ArrayBuffer[] }}
 */
export function serializeSurfacePixelsBatch(surfaces) {
  const out = [];
  const seen = new Set();
  const transfer = [];
  for (const sp of surfaces) {
    const { surface, transfer: t } = serializeSurfacePixels(sp);
    out.push(surface);
    for (const buf of t) {
      if (!seen.has(buf)) {
        seen.add(buf);
        transfer.push(buf);
      }
    }
  }
  return { surfaces: out, transfer };
}

/**
 * Reconstruct a drop-in surface object from a transferred payload. All
 * fields are direct; this normalizes key presence + scalar types.
 * @param {SurfacePixelsPayload} p
 */
export function reconstructSurfacePixels(p) {
  return {
    width: p.width >>> 0,
    height: p.height >>> 0,
    pixels: p.pixels,
    surfaceType: p.surfaceType >>> 0,
    category: p.category & 0xff,
    normalPixels: p.normalPixels,
    heightPixels: p.heightPixels,
    roughnessOverride: p.roughnessOverride,
    normalScaleOverride: p.normalScaleOverride,
    translucency: p.translucency,
    luminosity: p.luminosity,
    diffuse: p.diffuse,
  };
}

/** @param {SurfacePixelsPayload[]} payload */
export function reconstructSurfacePixelsBatch(payload) {
  return payload.map(reconstructSurfacePixels);
}
