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
 *
 * SAB GUARD (AUDIT-sab-views-2026-07-24 must-fix 1). Under a threaded
 * (shared-memory) wasm build a getter could hand back a view into wasm
 * linear memory, i.e. a `SharedArrayBuffer`. A SAB can NEVER appear in a
 * `postMessage` transfer list (unconditional throw), and even cloned it
 * would alias live wasm memory on the far side. So when the backing buffer
 * is shared we copy the VIEW into a fresh, non-shared buffer and transfer
 * that instead — `TypedArray.prototype.slice()` always allocates a fresh
 * non-shared `ArrayBuffer`. The SAB itself never enters `out`.
 *
 * Because the copy is per view, callers MUST use the returned typed array
 * in the payload they post (the original still points at wasm memory).
 * Dedup is unaffected: distinct views get distinct fresh buffers, and in
 * the non-shared case this is byte-for-byte the previous behavior.
 *
 * @param {Set<ArrayBuffer>} seen
 * @param {ArrayBuffer[]} out
 * @param {*} ta typed array
 * @returns {*} the typed array to put in the payload (`ta`, or its copy)
 */
function pushBuffer(seen, out, ta) {
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    ta.buffer instanceof SharedArrayBuffer
  ) {
    ta = ta.slice();
  }
  const buf = ta.buffer;
  if (!seen.has(buf)) {
    seen.add(buf);
    out.push(buf);
  }
  return ta;
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
  // Each getter is read EXACTLY ONCE and routed through `pushBuffer`, which
  // both collects the buffer to transfer and returns the array to put in the
  // payload (identical object today; a non-shared copy under a SAB build).
  const seen = new Set();
  const transfer = [];
  const positions = pushBuffer(seen, transfer, wasmMesh.positions); // Float32Array
  const uvs = pushBuffer(seen, transfer, wasmMesh.uvs); // Float32Array
  const normals = pushBuffer(seen, transfer, wasmMesh.normals); // Float32Array
  const surfaceIndices = pushBuffer(seen, transfer, wasmMesh.surfaceIndices); // Uint8Array
  const sidesTypes = pushBuffer(seen, transfer, wasmMesh.sidesTypes); // Uint8Array
  const surfaces = pushBuffer(seen, transfer, wasmMesh.surfaces); // Uint32Array
  const bbox = pushBuffer(seen, transfer, wasmMesh.bbox); // Float32Array(6)
  const didDegrade = wasmMesh.didDegrade >>> 0; // u32
  // geom-audit — decode-starvation flag (0 = complete decode). typeof-
  // guarded so a stale pkg without the getter serializes 0.
  const decodeMisses =
    typeof wasmMesh.decodeMisses === "number" ? wasmMesh.decodeMisses >>> 0 : 0;

  const mesh = {
    positions,
    uvs,
    normals,
    surfaceIndices,
    sidesTypes,
    surfaces,
    bbox,
    didDegrade,
    decodeMisses,
  };

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
    // geom-audit — decode-starvation flag; absent (older worker) → 0.
    decodeMisses: (p.decodeMisses ?? 0) >>> 0,
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
// Call-level surface decode audit (P2↔P3 ABI, net-fixwave 2026-07-10)
// ---------------------------------------------------------------------------
//
// The wasm surface exports stamp two OPTIONAL fields on their CALL-level
// result — `decodeMisses` (number) + `provenAbsent` (Array<"0x%08X">) — as
// properties on the returned Array (`fetch_surfaces_pixels`,
// `fetchEntitySurfacesPixels`) or getters on the batch handle
// (`fetchEntitySurfacesPixelsBatch`). materials.js poisons its negative
// cache ONLY from these fields (`surfaceResultProvenAbsent`). These helpers
// carry the audit across the worker boundary: extract before postMessage,
// re-apply onto the reconstructed result. A result without the fields
// (legacy wasm) yields `null`, `applySurfaceAudit` is then a no-op, and the
// readers treat the reconstructed result as legacy → never poison.

/** Read the call-level audit off a wasm result (Array props or handle
 * getters). Returns `{decodeMisses?, provenAbsent?}` or null (legacy). */
export function extractSurfaceAudit(result) {
  if (!result || (typeof result !== "object" && typeof result !== "function")) {
    return null;
  }
  let decodeMisses;
  let provenAbsent;
  try {
    const n = result.decodeMisses;
    if (typeof n === "number" && Number.isFinite(n)) decodeMisses = n >>> 0;
    const pa = result.provenAbsent;
    if (Array.isArray(pa)) provenAbsent = pa.map(String);
  } catch (_) {
    return null; // throwing getter (freed wasm handle) → treat as legacy
  }
  if (decodeMisses === undefined && provenAbsent === undefined) return null;
  return { decodeMisses, provenAbsent };
}

/** Stamp an extracted audit back onto a reconstructed result. No-op when
 * `audit` is null/absent (legacy wasm on the other side). Returns target. */
export function applySurfaceAudit(target, audit) {
  if (!target || !audit) return target;
  if (typeof audit.decodeMisses === "number") {
    target.decodeMisses = audit.decodeMisses >>> 0;
  }
  if (Array.isArray(audit.provenAbsent)) {
    target.provenAbsent = audit.provenAbsent.map(String);
  }
  return target;
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
  // Read each getter once, through the SAB-guarded `pushBuffer` (see its
  // doc comment): the returned array is what goes in the payload.
  const seen = new Set();
  const transfer = [];
  const pixels = pushBuffer(seen, transfer, sp.pixels); // Uint8Array
  const normalPixels = pushBuffer(seen, transfer, sp.normalPixels); // Uint8Array (maybe empty)
  const heightPixels = pushBuffer(seen, transfer, sp.heightPixels); // Uint8Array (maybe empty)

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
  // A10-M3a — carry the palettedness bit ONLY when the getter exists
  // (strict boolean; older pkg lacks it). The consumers key on
  // `typeof sp.hasPalette === "boolean"` and otherwise keep the legacy
  // alphaTest 0.5, so leaving the key absent on a stale pkg preserves
  // the exact `undefined` fallback semantics across the worker boundary.
  if (typeof sp.hasPalette === "boolean") surface.hasPalette = sp.hasPalette;

  return { surface, transfer };
}

/**
 * Serialize a `Vec<SurfacePixels>` into one payload + deduped transfer list.
 * Also extracts the call-level decode audit (P2↔P3 ABI) off the input
 * Array so the worker can post it alongside the payload.
 * @param {Iterable<*>} surfaces
 * @returns {{ surfaces: SurfacePixelsPayload[], transfer: ArrayBuffer[], audit: ({decodeMisses?: number, provenAbsent?: string[]}|null) }}
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
  return { surfaces: out, transfer, audit: extractSurfaceAudit(surfaces) };
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
    // `undefined` when the payload omitted it (stale pkg) — matches the
    // consumers' `typeof … === "boolean" ? … : undefined` contract.
    hasPalette: p.hasPalette,
  };
}

/** @param {SurfacePixelsPayload[]} payload */
export function reconstructSurfacePixelsBatch(payload) {
  return payload.map(reconstructSurfacePixels);
}

// ---------------------------------------------------------------------------
// EntitySurfacesPixelsBatch — `fetchEntitySurfacesPixelsBatch` decoder output
// ---------------------------------------------------------------------------
//
// The batched entity-surface decoder (F.41) returns an
// `EntitySurfacesPixelsBatch` wasm handle whose `payloadAt(i)` MOVES out
// one group's `Vec<SurfacePixels>` (single-shot; `wasDrained(i)` after).
// To cross the worker boundary we drain every group into a plain
// array-of-arrays of `SurfacePixelsPayload` (reusing the single-surface
// serializer, so the pixel/normal/height `ArrayBuffer`s transfer zero-copy
// and dedupe across the whole batch), then free the handle in the worker.
// The reconstructed main-thread object re-implements the SAME consumer
// surface the wasm handle exposed — `len`, `payloadAt(i)` (single-shot),
// `wasDrained(i)`, `free()` — so `materials.js::preloadBatch` is a drop-in.

/**
 * Serialize a wasm `EntitySurfacesPixelsBatch` handle by draining every
 * group. Frees each drained `SurfacePixels` handle (their pixels were
 * already copied into JS-owned typed arrays by `serializeSurfacePixels`)
 * and the batch handle itself. `null` groups (drained/out-of-range) round-
 * trip as `null`.
 * @param {*} batch wasm `EntitySurfacesPixelsBatch`
 * @returns {{ groups: (SurfacePixelsPayload[]|null)[], transfer: ArrayBuffer[], audit: ({decodeMisses?: number, provenAbsent?: string[]}|null) }}
 */
export function serializeEntitySurfacesBatch(batch) {
  // Read the call-level audit getters BEFORE draining/freeing the handle.
  const audit = extractSurfaceAudit(batch);
  const groups = [];
  const seen = new Set();
  const transfer = [];
  const n = batch.len >>> 0;
  for (let i = 0; i < n; i += 1) {
    const payload = batch.payloadAt(i); // Array<SurfacePixels> | undefined
    if (!payload) {
      groups.push(null);
      continue;
    }
    const { surfaces, transfer: t } = serializeSurfacePixelsBatch(payload);
    groups.push(surfaces);
    for (const buf of t) {
      if (!seen.has(buf)) {
        seen.add(buf);
        transfer.push(buf);
      }
    }
    // Pixels are copied out; the wasm handles can go now.
    for (const sp of payload) {
      try {
        if (sp && typeof sp.free === "function") sp.free();
      } catch (_) {
        /* best-effort */
      }
    }
  }
  try {
    if (batch && typeof batch.free === "function") batch.free();
  } catch (_) {
    /* best-effort */
  }
  return { groups, transfer, audit };
}

/**
 * Reconstruct a drop-in for the wasm `EntitySurfacesPixelsBatch` handle.
 * Mirrors its `len` / `payloadAt(i)` (single-shot MOVE) / `wasDrained(i)` /
 * `free()` surface so `materials.js::preloadBatch` consumes it unchanged.
 * @param {(SurfacePixelsPayload[]|null)[]} groups
 */
export function reconstructEntitySurfacesBatch(groups) {
  const rebuilt = groups.map((g) => (g ? reconstructSurfacePixelsBatch(g) : null));
  return {
    get len() {
      return rebuilt.length;
    },
    payloadAt(i) {
      if (i < 0 || i >= rebuilt.length) return null;
      const g = rebuilt[i];
      rebuilt[i] = null; // single-shot MOVE, matching the wasm handle
      return g;
    },
    wasDrained(i) {
      return i < 0 || i >= rebuilt.length || rebuilt[i] === null;
    },
    free() {
      /* plain object — nothing wasm-backed to release */
    },
  };
}
