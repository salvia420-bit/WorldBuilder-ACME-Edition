// Phase 7.1+ — wasm → three.js converters.
//
// CRITICAL invariant: every adapter MUST copy wasm-backed buffers
// (e.g. `Float32Array.from(wasmArr)`) before constructing three.js
// BufferAttributes. Wasm linear memory grows on subsequent allocations,
// invalidating any view that points into the old buffer — three.js
// then renders garbage or hits a "detached ArrayBuffer" exception.
// The ~50 KB/landblock memcpy is dwarfed by texture upload time.
//
// Phase 7.1 ships:
//   - landblockMeshToGeometry(wasmMesh) → THREE.BufferGeometry
//   - buildTerrainAtlasArrayBytes(terrainTextures) → { atlasArrayBytes,
//       tileSize, depth, roadCanvas } — DataArrayTexture-ready bytes
//       (eliminates the gutter-less-atlas bleed at cell vertex lines)
//   - buildVertexTypesDataTexture(terrainCodes) → THREE.DataTexture
//
// Phase 7.2 adds:
//   - meshToGeometryGroups(wasmMesh) — surface-partitioned BufferGeometry
//     siblings, one per unique surface index. Used by buildings (where
//     each part needs per-surface materials).
//   - meshToFusedGeometry(wasmMesh) — single-fused BufferGeometry. Used
//     by statics (where draw-call cost dominates visual fidelity).
//   - surfacePixelsToTexture(rgba8, width, height) — DataTexture for
//     wasm-decoded RGBA8 surfaces.
//   - placementToMatrix4(placement) — ObjectPlacement → Matrix4 (the
//     wasm only exposes `rotationZ`; quaternion is reconstructed as a
//     pure z-axis rotation per AC's yaw-only ground-object convention).
//   - acQuatToThree(qw, qx, qy, qz) — AC (qw,qx,qy,qz) → three (x,y,z,w).

import * as THREE from "three";

// ---- Atlas layout constants ---------------------------------------
// Codes 0..32 are packed as layers of a `THREE.DataArrayTexture`. Each
// layer is 512×512 RGBA8 = `ATLAS_TILE_PX² × 4 = 1 MiB`; 33 layers
// total ≈ 33 MiB GPU (≈ 46 MiB with the per-layer mip pyramid). Native
// size matches what `fetch_terrain_textures` actually emits from the
// retail DAT — PFID_CUSTOM_LSCAPE_R8G8B8 / PFID_INDEX16 / DXT chains
// decoded to RGBA8 land at 512×512 for all 33 terrain codes
// (verified 2026-05-20 via the pkg-node wasm). The prior 256² constant
// downsampled every tile via `drawImage` before upload, halving the
// visible grass-blade / rock-aggregate detail.
//
// Replaces the prior 6×6 `CanvasTexture` atlas (1536×1536 single 2D
// image) which bled adjacent tiles' colours into each cell at mip
// levels ≥3 — the bleed line landed on the 24 m cell vertex grid
// (the original "not flush with vertices" artefact). Per-layer
// isolation in DataArrayTexture eliminates the cross-tile bleed
// entirely. Code 32 (RoadType, DID 0x05001458) also stays in the
// array (layer 32) and is independently extracted as a standalone
// `RepeatWrapping` road texture for the overlay path.
const ATLAS_TILE_PX = 512;
const ATLAS_DEPTH = 33;

/**
 * Convert a wasm `LandblockMesh` into a `THREE.BufferGeometry` with:
 *   - `position` attribute (Float32Array, 81×3 — copied from wasm).
 *   - `index` (Uint16, 384 entries — 64 cells × 6 indices each).
 *   - `terrainCode` (Uint8, 81×1) — non-standard per-vertex attribute
 *     used by the bilinear-blend shader's neighbour lookups (currently
 *     the shader samples `uVertexTypes` as a 9×9 texture, but exposing
 *     the per-vertex code keeps options open for a future direct-attr
 *     path).
 *   - `roadCode` (Uint8, 81×1) — same idea for road overlays.
 *
 * Calls `computeVertexNormals()` so Phase 7.6 Lambert sun lighting
 * works without a separate pass; at minimum the normals are non-zero
 * so the shader can sample them.
 *
 * Calls `computeBoundingSphere()` for three's frustum culling.
 *
 * The wasm Float32Array `positions` layout is (x, y, z) per vertex
 * with (x, y) in LB-local metres (0..192, 24 m vertex spacing on a
 * 9×9 grid) and z = terrain height in metres. The 2D path positions
 * the *parent container* at `(lbX * 192, lbY * 192)` and renders the
 * raw vertex positions inside it; three.js mirrors that — the
 * geometry stays LB-local, the parent `Mesh` carries the world
 * offset.
 */
export function landblockMeshToGeometry(wasmMesh) {
  // Always copy — see adapter header re: wasm buffer detach.
  const positions = Float32Array.from(wasmMesh.positions);
  const rawIndices = Uint16Array.from(wasmMesh.indices);
  const terrainCodes = Uint8Array.from(wasmMesh.terrainCodes);
  const roadCodes = Uint8Array.from(wasmMesh.roadCodes);

  // F#27 winding fix (2026-05-10). The wasm heightfield emits triangles
  // wound CW when viewed from AC +Z (top-down). three.js's default
  // front-face is CCW in screen-projected NDC. After `worldRoot.rotation.x
  // = -π/2` maps AC +Z → three.js +Y, the original CW-from-+Z triangles
  // become CW-from-+Y in screen space — three.js sees them as back-faces
  // and `THREE.FrontSide` culls them, leaving the renderer's clearColor
  // (`0x101418`, near-black) showing through. F#9 visual diff caught
  // this: with FrontSide the terrain rendered ~black at 88% diff; with
  // DoubleSide the diff dropped to 85% as terrain became visible from
  // both sides. Reverse the index winding per-triangle here so FrontSide
  // is correct without paying for back-face shading (the heightfield is
  // never viewed from below in normal gameplay).
  //
  // Validated: buildings + statics use `MaterialCache` which defaults to
  // DoubleSide so they're unaffected by winding. Only this adapter is
  // load-bearing for terrain visibility post-rotation.
  const indices = new Uint16Array(rawIndices.length);
  for (let i = 0; i < rawIndices.length; i += 3) {
    indices[i + 0] = rawIndices[i + 0];
    indices[i + 1] = rawIndices[i + 2];
    indices[i + 2] = rawIndices[i + 1];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3, false)
  );
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  // Non-standard per-vertex attributes. `normalized=false` for both —
  // the shader treats them as raw byte indices, not 0..1 fractions.
  geom.setAttribute(
    "terrainCode",
    new THREE.BufferAttribute(terrainCodes, 1, false)
  );
  geom.setAttribute(
    "roadCode",
    new THREE.BufferAttribute(roadCodes, 1, false)
  );

  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Phase 2.1 — convert a wasm `SubdividedLandblockMesh` into a
 * `THREE.BufferGeometry`.
 *
 * Drop-in sibling of [`landblockMeshToGeometry`] above. The mesh is
 * `(gridSize)² = (subdiv * 8 + 1)²` vertices with Catmull-Rom bicubic
 * heights + per-category clamped noise (≤ ±0.3 m). Indices are 32-bit
 * (4225 verts at subdiv=8 fits in u16 but 16641 at subdiv=8 does not —
 * we always use Uint32Array for headroom).
 *
 * The Phase 7.1 F#27 winding-reversal is applied identically here so
 * `THREE.FrontSide` rendering matches the legacy 9×9 path.
 */
export function subdividedLandblockMeshToGeometry(wasmSub) {
  const positions = Float32Array.from(wasmSub.positions);
  const normals = Float32Array.from(wasmSub.normals);
  const terrainCodes = Uint8Array.from(wasmSub.terrainCodes);
  const roadCodes = Uint8Array.from(wasmSub.roadCodes);
  const rawIndices = Uint32Array.from(wasmSub.indices);

  // Mirror the F#27 winding-reversal pass — the wasm emits SW-last
  // winding (CW from AC +Z, matching `build_mesh`), and the worldRoot
  // rotation flips CCW expectations in screen space. Reverse per-triangle
  // so FrontSide culling sees front faces.
  const indices = new Uint32Array(rawIndices.length);
  for (let i = 0; i < rawIndices.length; i += 3) {
    indices[i + 0] = rawIndices[i + 0];
    indices[i + 1] = rawIndices[i + 2];
    indices[i + 2] = rawIndices[i + 1];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3, false)
  );
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3, false));
  geom.setAttribute(
    "terrainCode",
    new THREE.BufferAttribute(terrainCodes, 1, false)
  );
  geom.setAttribute(
    "roadCode",
    new THREE.BufferAttribute(roadCodes, 1, false)
  );
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Build a `THREE.DataArrayTexture`-ready byte block + the standalone
 * road tile from a wasm `TerrainTexture[]` (33 entries, terrainType
 * 0..32).
 *
 * Each terrain code becomes one 256×256 RGBA8 layer in the returned
 * `atlasArrayBytes` (layer stride `ATLAS_TILE_PX² × 4 = 262144 bytes`,
 * total 33 × 262144 = 8 650 752 bytes ≈ 8.5 MiB). The caller wraps the
 * block as `new THREE.DataArrayTexture(bytes, tileSize, tileSize,
 * depth)` and picks the colour-space / filter / mipmap policy.
 *
 * Returns:
 *   - `atlasArrayBytes`: Uint8Array of length `tileSize² × 4 × depth`
 *     with layer `i` occupying bytes `[i*stride, (i+1)*stride)`.
 *   - `tileSize`: 256 (per-layer width = height).
 *   - `depth`: 33 (one layer per terrain code 0..32).
 *   - `roadCanvas`: the code-32 RoadType tile copied to its own canvas
 *     at native resolution, so the road overlay sampler can use
 *     `RepeatWrapping` at the texture's true dimensions instead of the
 *     downsampled layer size.
 *
 * Memory: each tile is decoded through a working `<canvas>` to handle
 * variable native sizes (wasm gives us per-tile width/height); the
 * canvas is then `getImageData`'d at the uniform 256×256 layer size
 * and the bytes are copied directly into the array texture buffer.
 */
export function buildTerrainAtlasArrayBytes(terrainTextures) {
  if (!Array.isArray(terrainTextures) && !terrainTextures.length) {
    throw new Error(
      `buildTerrainAtlasArrayBytes: terrainTextures is not array-like (got ${typeof terrainTextures})`
    );
  }
  if (terrainTextures.length !== ATLAS_DEPTH) {
    throw new Error(
      `buildTerrainAtlasArrayBytes: expected ${ATLAS_DEPTH} terrain textures, got ${terrainTextures.length}`
    );
  }

  const layerStride = ATLAS_TILE_PX * ATLAS_TILE_PX * 4;
  const atlasArrayBytes = new Uint8Array(layerStride * ATLAS_DEPTH);

  // Lazily-allocated resize scratch — only constructed if a tile comes
  // in at a non-`ATLAS_TILE_PX` native size and needs canvas-side
  // resampling. The fast path (every retail tile is 512×512 per the
  // wasm decoder) skips canvas entirely and memcpy's the wasm RGBA
  // bytes straight into the array-texture buffer, which avoids the
  // double sRGB roundtrip the `putImageData` -> `drawImage` ->
  // `getImageData` chain otherwise applies (canvas linearises on put,
  // re-encodes sRGB on get; the texture is then marked SRGBColorSpace
  // and Three.js linearises a third time in the fragment shader).
  let tileCanvas = null;
  let tctx = null;
  let layerCanvas = null;
  let lctx = null;
  const ensureResizeScratch = () => {
    if (tileCanvas) return;
    tileCanvas = document.createElement("canvas");
    tctx = tileCanvas.getContext("2d");
    layerCanvas = document.createElement("canvas");
    layerCanvas.width = ATLAS_TILE_PX;
    layerCanvas.height = ATLAS_TILE_PX;
    lctx = layerCanvas.getContext("2d");
  };

  let roadCanvas = null;

  for (const tex of terrainTextures) {
    const code = tex.terrainType;
    const w = tex.width;
    const h = tex.height;
    const px = tex.pixels; // wasm-bindgen Uint8Array, length w*h*4
    const dstOffset = code * layerStride;

    if (w === ATLAS_TILE_PX && h === ATLAS_TILE_PX) {
      // Fast path: byte-exact copy of the wasm-decoded RGBA into the
      // array-texture buffer. No canvas, no resample, no sRGB
      // roundtrip — the bytes Three.js uploads are the same bytes the
      // DAT decoder produced.
      atlasArrayBytes.set(px, dstOffset);
    } else {
      // Slow path: resample non-512x512 tiles down/up to the layer
      // size via canvas. Defensive — retail emits 512x512 for all 33
      // codes today, but a future palette change or non-retail mod
      // could land a differently-sized tile and we'd rather render it
      // resampled than crash the array-texture upload.
      ensureResizeScratch();
      tileCanvas.width = w;
      tileCanvas.height = h;
      const clamped = new Uint8ClampedArray(
        px.buffer,
        px.byteOffset,
        px.byteLength
      );
      tctx.putImageData(new ImageData(clamped, w, h), 0, 0);
      lctx.clearRect(0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX);
      lctx.drawImage(
        tileCanvas, 0, 0, w, h,
        0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX
      );
      const layerImg = lctx.getImageData(0, 0, ATLAS_TILE_PX, ATLAS_TILE_PX);
      atlasArrayBytes.set(layerImg.data, dstOffset);
    }

    if (code === 32) {
      // Standalone road tile at native resolution — preserves the
      // texture's true dimensions for `RepeatWrapping` UVs in the road
      // overlay. Even at the new 512x512 layer size the road overlay
      // still gets its own canvas so the road sampler can wrap at the
      // tile's authored period rather than the atlas-layer dim.
      roadCanvas = document.createElement("canvas");
      roadCanvas.width = w;
      roadCanvas.height = h;
      const rctx = roadCanvas.getContext("2d");
      const clamped = new Uint8ClampedArray(
        px.buffer,
        px.byteOffset,
        px.byteLength
      );
      rctx.putImageData(
        new ImageData(new Uint8ClampedArray(clamped), w, h),
        0,
        0
      );
    }

    if (typeof tex.free === "function") tex.free();
  }

  return {
    atlasArrayBytes,
    tileSize: ATLAS_TILE_PX,
    depth: ATLAS_DEPTH,
    roadCanvas,
  };
}

/**
 * Build a 9×9 `THREE.DataTexture` from this LB's per-vertex terrain
 * codes (Uint8Array, length 81).
 *
 * Mirrors `buildVertexTypesTexture` at `index.html:1136-1149`. The
 * shader samples this with `texelFetch(uVertexTypes, ivec2(iu, iv), 0)`
 * (nearest filter, no mipmaps) to retrieve the integer code at each
 * vertex of the cell containing the fragment.
 *
 * **CRITICAL transpose**: wasm `terrainCodes` is laid out
 * **column-major** — vertex i has gridX = i/9, gridY = i%9 (per the
 * 2D-path comment block at `index.html:1118-1135`, verified empirically
 * vs WB.Terminal `get-terrain-data` 2026-05-06). Canvas / GL textures
 * are row-major. Without this transpose, Holtburg's water + road
 * network render diagonal-mirrored.
 *
 * Output layout: RGBA8, 9×9, `R = terrainCode, G = roadCode * 64,
 * B = 0, A = 255`. R holds the terrain palette index (0–31). G holds
 * the 2-bit AC road code (0–3) scaled by 64 so even with the texture
 * sampled NearestFilter the value reads cleanly (0, 64, 128, 192) and
 * a `> 0.5` test in the shader picks "any road" reliably regardless
 * of byte rounding. retail roads are encoded as bits 0–1 of the
 * per-vertex 16-bit surface word (see crates/holtburger-dat/src/
 * landblock.rs); the wasm `roadCodes` getter already shifts/masks
 * those out. This lets the terrain shader bilinear-blend a road
 * texture over the base terrain at vertices where road != 0 — same
 * physics-painting model retail used, no separate overlay mesh.
 *
 * `roadCodes` is optional for back-compat — when omitted G=0 so the
 * shader's road bilinear weight stays 0 and behaviour matches the
 * old terrain-only path. Same column-major source layout as
 * terrainCodes (verified by `wasmMesh.roadCodes` against
 * WB.Terminal `get-terrain-data`).
 */
export function buildVertexTypesDataTexture(terrainCodes, roadCodes) {
  // Always copy: this byte block lives on for the lifetime of the
  // texture, well past wasm-memory growth.
  const bytes = new Uint8Array(9 * 9 * 4);
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      const dst = (row * 9 + col) * 4;
      // Column-major source: terrainCodes[col * 9 + row].
      const src = col * 9 + row;
      bytes[dst + 0] = terrainCodes[src];
      bytes[dst + 1] = roadCodes ? roadCodes[src] * 64 : 0;
      bytes[dst + 2] = 0;
      bytes[dst + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(
    bytes,
    9,
    9,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  // Discrete bytes — any interpolation corrupts the codes.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  // Per-vertex codes are unitless integers, not colour data — leave
  // the colour-space as no-conversion so they round-trip byte-exact.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// =====================================================================
// Phase 7.2 — model meshes, surface textures, placement transforms.
// =====================================================================

// JS sentinel matching the wasm `0xFF` "no surface" marker emitted by
// `triangulate_model` for triangles whose Polygon had no resolved
// Surface DID. Group these into a synthetic FALLBACK bucket so the
// caller can paint them with a flat material.
const FALLBACK_SURFACE_INDEX = 0xff;
// Surface DID 0 is unused by AC (DIDs start at 0x08000000). We use it
// as a sentinel for the FALLBACK bucket so callers can branch on it.
const FALLBACK_SURFACE_DID = 0;

/**
 * Convert a wasm `ModelMesh` into a list of `THREE.BufferGeometry`
 * siblings, one per unique `surfaceIndex` used by the model.
 *
 * Each output geometry is non-indexed (the wasm mesh is a triangle
 * soup with no shared vertices — see `lib.rs:1284-1305`). For each
 * triangle in the source mesh:
 *   - The 3 vertex positions are copied verbatim.
 *   - The 3 vertex UVs are copied verbatim.
 *   - The single face normal is broadcast to 3 per-vertex normals
 *     (three.js's MeshStandardMaterial expects per-vertex normals).
 *
 * Triangles with `surfaceIndex === 0xFF` ("no surface", per
 * `lib.rs:1295`) are bucketed under a synthetic FALLBACK group keyed
 * with `surfaceDid === 0`. The caller paints these with the
 * `MaterialCache.fallbackMaterial`.
 *
 * **Two-sided polys with distinct pos/neg surfaces** (Phase 7
 * follow-on #7, landed 2026-05-10): the Rust triangulator
 * (`append_gfx_tris_with_tex_swaps` in lib.rs) now emits TWO tris for
 * polygons where `sides_type == CullMode::Clockwise (0x2)` AND
 * `pos_surface != neg_surface` — one with the pos surface_did + ABC
 * winding, one with the neg surface_did + ACB winding (reverse
 * winding, negated normal). Each tri gets its own `surfaceIndex`
 * naturally during the pack-model-mesh dedupe step, so the existing
 * `byIdx` grouping below correctly emits one mesh per unique
 * (pos, neg) tuple without needing a tuple-keyed map — the Rust side
 * already split the polygon into two oriented tris with distinct
 * surface_dids, and we just bucket by surfaceIndex as before.
 *
 * Output geometries have `computeBoundingSphere()` called for three's
 * frustum culling.
 *
 * Returns:
 *   {
 *     groups: [{ geometry: BufferGeometry, surfaceDid: u32 }],
 *     surfaceDids: u32[]   // unique non-fallback DIDs (0 not included)
 *   }
 *
 * Note: an empty `triCount === 0` mesh returns `{ groups: [], surfaceDids: [] }`.
 */
export function meshToGeometryGroups(wasmMesh) {
  // wasm-bindgen sometimes hands us a wrapper whose inner Rust pointer
  // is null (the entity's mesh DID resolved but `fetchEntityModelRender`
  // returned no triangles, or the wasm-side cache evicted the mesh
  // between the lookup and this read). Any getter on a null-ptr wrapper
  // throws "null pointer passed to rust" — guard the first read.
  let triCount;
  try {
    triCount = wasmMesh.triCount | 0;
  } catch (_) {
    return { groups: [], surfaceDids: [] };
  }
  if (triCount === 0) {
    return { groups: [], surfaceDids: [] };
  }

  // Snapshot every typed array up front — each wasm getter clones,
  // and we want a single self-consistent view we can safely retain.
  const positions = wasmMesh.positions; // Float32Array, len = triCount * 9
  const uvs = wasmMesh.uvs; // Float32Array, len = triCount * 6
  const normals = wasmMesh.normals; // Float32Array, len = triCount * 3
  const sIdx = wasmMesh.surfaceIndices; // Uint8Array, len = triCount
  const surfaces = wasmMesh.surfaces; // Uint32Array, unique DIDs

  // Bucket triangles by their surface index. surfaceIndex → array of
  // triangle indices. Doing two passes (count first, then write) saves
  // the O(N) Array#push allocations.
  const byIdx = new Map(); // surface_idx_byte → number[] of tri indices
  for (let t = 0; t < triCount; t += 1) {
    const si = sIdx[t];
    let bucket = byIdx.get(si);
    if (!bucket) {
      bucket = [];
      byIdx.set(si, bucket);
    }
    bucket.push(t);
  }

  const groups = [];
  const surfaceDids = [];

  for (const [surfIdx, triIndices] of byIdx) {
    const n = triIndices.length;
    const groupPositions = new Float32Array(n * 9);
    const groupUvs = new Float32Array(n * 6);
    const groupNormals = new Float32Array(n * 9); // broadcast face → 3 verts

    for (let i = 0; i < n; i += 1) {
      const t = triIndices[i];
      const pSrc = t * 9;
      const uSrc = t * 6;
      const nSrc = t * 3;
      const pDst = i * 9;
      const uDst = i * 6;
      const nDst = i * 9;
      // 3 verts × xyz: 9 floats per triangle.
      groupPositions[pDst + 0] = positions[pSrc + 0];
      groupPositions[pDst + 1] = positions[pSrc + 1];
      groupPositions[pDst + 2] = positions[pSrc + 2];
      groupPositions[pDst + 3] = positions[pSrc + 3];
      groupPositions[pDst + 4] = positions[pSrc + 4];
      groupPositions[pDst + 5] = positions[pSrc + 5];
      groupPositions[pDst + 6] = positions[pSrc + 6];
      groupPositions[pDst + 7] = positions[pSrc + 7];
      groupPositions[pDst + 8] = positions[pSrc + 8];
      // 3 verts × uv: 6 floats per triangle.
      groupUvs[uDst + 0] = uvs[uSrc + 0];
      groupUvs[uDst + 1] = uvs[uSrc + 1];
      groupUvs[uDst + 2] = uvs[uSrc + 2];
      groupUvs[uDst + 3] = uvs[uSrc + 3];
      groupUvs[uDst + 4] = uvs[uSrc + 4];
      groupUvs[uDst + 5] = uvs[uSrc + 5];
      // 1 face normal → broadcast to 3 vertex normals: 9 floats per tri.
      const nx = normals[nSrc + 0];
      const ny = normals[nSrc + 1];
      const nz = normals[nSrc + 2];
      groupNormals[nDst + 0] = nx;
      groupNormals[nDst + 1] = ny;
      groupNormals[nDst + 2] = nz;
      groupNormals[nDst + 3] = nx;
      groupNormals[nDst + 4] = ny;
      groupNormals[nDst + 5] = nz;
      groupNormals[nDst + 6] = nx;
      groupNormals[nDst + 7] = ny;
      groupNormals[nDst + 8] = nz;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(groupPositions, 3, false)
    );
    geom.setAttribute(
      "uv",
      new THREE.BufferAttribute(groupUvs, 2, false)
    );
    geom.setAttribute(
      "normal",
      new THREE.BufferAttribute(groupNormals, 3, false)
    );
    geom.computeBoundingSphere();

    let surfaceDid;
    if (surfIdx === FALLBACK_SURFACE_INDEX) {
      surfaceDid = FALLBACK_SURFACE_DID;
    } else {
      // surfaces[surfIdx] — the wasm stores unique surface DIDs in
      // first-seen order (see lib.rs:1297-1300). surfIdx is a byte
      // index into this Uint32Array.
      surfaceDid = surfaces[surfIdx] >>> 0;
      surfaceDids.push(surfaceDid);
    }
    groups.push({ geometry: geom, surfaceDid });
  }

  return { groups, surfaceDids };
}

/**
 * Convert a wasm `ModelMesh` into a single fused `THREE.BufferGeometry`
 * with all triangles merged, ignoring per-poly surface partitioning.
 *
 * Used for static-object placements where draw-call cost outweighs
 * visual fidelity (Holtburg has 100s of placed statics — going
 * per-surface would multiply draw calls). Painted with the fallback
 * material if no surface texture is supplied; future polish can pick
 * the model's "dominant" surface for a one-texture lookup.
 *
 * Empty meshes return `null` (caller skips the placement).
 */
export function meshToFusedGeometry(wasmMesh) {
  const triCount = wasmMesh.triCount | 0;
  if (triCount === 0) return null;

  const positions = Float32Array.from(wasmMesh.positions);
  const uvs = Float32Array.from(wasmMesh.uvs);
  const wasmNormals = wasmMesh.normals; // length = triCount * 3 (face normals)

  // Broadcast face normals → vertex normals (3 copies per triangle).
  const normals = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t += 1) {
    const nSrc = t * 3;
    const nDst = t * 9;
    const nx = wasmNormals[nSrc + 0];
    const ny = wasmNormals[nSrc + 1];
    const nz = wasmNormals[nSrc + 2];
    normals[nDst + 0] = nx;
    normals[nDst + 1] = ny;
    normals[nDst + 2] = nz;
    normals[nDst + 3] = nx;
    normals[nDst + 4] = ny;
    normals[nDst + 5] = nz;
    normals[nDst + 6] = nx;
    normals[nDst + 7] = ny;
    normals[nDst + 8] = nz;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3, false)
  );
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2, false));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3, false));
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Wrap raw RGBA8 pixels into a `THREE.DataTexture`.
 *
 * Inputs:
 *   - `rgba8` — Uint8Array of length `width * height * 4`. Always
 *     copied (caller's buffer may be a wasm-bindgen view that can
 *     detach on memory growth).
 *   - `width`, `height` — pixel dimensions.
 *
 * Texture flags (matches the existing 2D path's expectations and
 * three.js best practice for albedo textures):
 *   - `colorSpace = SRGBColorSpace` — albedo, linearised by the
 *     renderer before lighting.
 *   - `magFilter = LinearFilter`, `minFilter = LinearMipmapLinearFilter`,
 *     `generateMipmaps = true`.
 *   - `flipY = false` — wasm pixels are top-down, matching PIXI's
 *     `Texture.from(canvas)` convention. With `flipY = true` (three's
 *     default) we'd render every surface upside-down.
 *   - `wrapS = wrapT = RepeatWrapping` — most AC textures tile.
 *
 * Returns the texture; caller owns lifecycle.
 */
export function surfacePixelsToTexture(rgba8, width, height) {
  if (!rgba8 || width === 0 || height === 0) {
    throw new Error(
      `surfacePixelsToTexture: bad input (w=${width}, h=${height}, hasPixels=${!!rgba8})`
    );
  }
  // Always copy: the wasm side can re-allocate linear memory between
  // this call and the GPU upload, detaching the original buffer.
  const copy = new Uint8Array(rgba8.byteLength);
  copy.set(rgba8);

  const tex = new THREE.DataTexture(
    copy,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Phase 1.1 — wrap an RGB8 normal map (from
 * `holtburger_dat::normal_gen::normal_from_luminance` exposed via
 * `SurfacePixels.normalPixels`) into a `THREE.DataTexture`.
 *
 * Three.js r152+ removed `RGBFormat`; we pad the source RGB8 buffer
 * into RGBA8 with `a = 255` and upload as `RGBAFormat`. The padding is
 * a one-time cost at decode and the alpha channel is unread by the
 * normal-map sampler anyway.
 *
 * Critical flags (differ from `surfacePixelsToTexture`):
 *   - `colorSpace = NoColorSpace` — normals are NOT colour data.
 *     sRGB would gamma-encode the bytes, corrupting the vector
 *     direction.
 *   - All other flags (wrap, filter, mipmaps, flipY) mirror the
 *     diffuse path so the normal samples align pixel-for-pixel with
 *     the albedo.
 *
 * Returns `null` if `normalRgb8` is empty (e.g. Luminous surfaces
 * skipped on the wasm side); caller leaves `material.normalMap` unset.
 */
export function surfacePixelsToNormalTexture(normalRgb8, width, height) {
  if (!normalRgb8 || normalRgb8.byteLength === 0 || width === 0 || height === 0) {
    return null;
  }
  const expected = width * height * 3;
  if (normalRgb8.byteLength < expected) {
    return null;
  }
  // Pad RGB → RGBA. Allocating fresh also detaches from wasm memory.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4 + 0] = normalRgb8[i * 3 + 0];
    rgba[i * 4 + 1] = normalRgb8[i * 3 + 1];
    rgba[i * 4 + 2] = normalRgb8[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(
    rgba,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  // CRITICAL: NoColorSpace. sRGB would corrupt the normal vectors.
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Phase 3.1 — wrap an R8 heightmap (from
 * `holtburger_dat::normal_gen::height_from_luminance` exposed via
 * `SurfacePixels.heightPixels`) into a `THREE.DataTexture`.
 *
 * Single-channel red-only data — `THREE.RedFormat`, `LinearMipmapLinear`
 * filtering so POM samples interpolate smoothly between texels.
 * Color space is linear (NOT sRGB — heights are scalar depth, not
 * colour data; sRGB would gamma-encode and corrupt the ray-march).
 *
 * Returns `null` if `heightR8` is empty (e.g. Luminous surfaces or
 * constant-luminance surfaces — the wasm side returns an empty Vec in
 * either case). The caller leaves the POM patch off when the texture
 * is null, so the surface falls back to flat normal mapping only.
 */
export function surfacePixelsToHeightTexture(heightR8, width, height) {
  if (!heightR8 || heightR8.byteLength === 0 || width === 0 || height === 0) {
    return null;
  }
  const expected = width * height;
  if (heightR8.byteLength < expected) {
    return null;
  }
  // Copy off the wasm-bindgen view so a future memory growth doesn't
  // detach the buffer the GPU is reading from.
  const copy = new Uint8Array(width * height);
  copy.set(heightR8.subarray(0, expected));

  const tex = new THREE.DataTexture(
    copy,
    width,
    height,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );
  // CRITICAL: NoColorSpace. Heights are scalar depth, not colour.
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Convert AC quaternion ordering (qw, qx, qy, qz) to three.js's
 * (x, y, z, w) convention. AC stores w-first in wire and DAT formats;
 * three.js's `Quaternion` constructor takes w last.
 */
export function acQuatToThree(qw, qx, qy, qz) {
  return new THREE.Quaternion(qx, qy, qz, qw);
}

// =====================================================================
// Phase 0.2 — detail-tile cache.
// =====================================================================
//
// Loads the 5 grayscale 512² detail tiles under `assets/detail/` once
// per scene and returns a `Map<key, THREE.Texture>` shared across every
// `DetailMaterial` instance. Keys match the picker labels in
// `materials.js::_pickDetailKey`:
//
//   "generic-rough" | "stone-grain" | "wood-grain"
//                   | "fabric-weave" | "sand-grain"
//
// Textures use `linear` colour space (the tile is a luminance mask, not
// colour data — wrong colour-space causes a visible darken when the
// SRGB → linear pass fires on the diffuse path) and `RepeatWrapping`
// (the shader samples at `vUv * uDetailScale`, default 8.0).
//
// `null` is returned for any tile that fails to load (offline / 404 /
// captures with no asset server). The DetailMaterial picker treats a
// missing tile as "fall through to opaque", so this is safe — the
// material simply renders without the detail composite, matching the
// pre-Phase-0.2 baseline.
export const DETAIL_TILE_KEYS = Object.freeze([
  "generic-rough",
  "stone-grain",
  "wood-grain",
  "fabric-weave",
  "sand-grain",
]);

function _detailTileUrl(key, baseUrl) {
  const base = baseUrl ?? "scene3d/assets/detail";
  return `${base}/${key}.png`;
}

/**
 * Load every Phase 0.2 detail tile in parallel. Resolves to a Map of
 * `key → THREE.Texture` (linear colour space, RepeatWrapping). Missing
 * tiles are simply absent from the returned map so the caller can
 * `cache.get("stone-grain") ?? cache.get("generic-rough")` fall-through
 * cleanly.
 *
 * Idempotent in the trivial sense — calling twice issues two image
 * loads. Callers should keep the resolved Map on `scene3d.detailTileCache`
 * and not re-call.
 *
 * @param {{ baseUrl?: string, THREE?: object }} opts
 * @returns {Promise<Map<string, THREE.Texture>>}
 */
export async function loadDetailTileCache(opts = {}) {
  const { baseUrl, THREE: ThreeOverride } = opts;
  // Allow the test harness to inject a mock three; default to the real
  // import.
  const T = ThreeOverride ?? THREE;
  const loader = new T.TextureLoader();
  const cache = new Map();

  async function loadOne(key) {
    const url = _detailTileUrl(key, baseUrl);
    try {
      const tex = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
      // Linear: this is a luminance mask, not colour data. If we left
      // it on SRGBColorSpace the GPU would re-linearise it once more
      // when sampling and darken the composite.
      tex.colorSpace = T.NoColorSpace;
      tex.wrapS = T.RepeatWrapping;
      tex.wrapT = T.RepeatWrapping;
      tex.minFilter = T.LinearMipmapLinearFilter;
      tex.magFilter = T.LinearFilter;
      tex.generateMipmaps = true;
      tex.name = `scene3d-detail-${key}`;
      tex.needsUpdate = true;
      cache.set(key, tex);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[phase-0.2] detail tile ${key} failed to load:`, e);
    }
  }

  await Promise.all(DETAIL_TILE_KEYS.map(loadOne));
  return cache;
}

// =====================================================================
// Phase 1.2 — terrain detail-normal array.
// =====================================================================
//
// Loads the 5 RGB 1024² normal-map PNGs under `assets/terrain_detail/`
// into a single `THREE.DataArrayTexture` (depth=5), indexed by terrain
// category. Returned to the terrain shader so its fragment can sample
// the correct slice per vertex without 5 separate texture units.
//
// Categories + slice order match `TERRAIN_DETAIL_KEYS`:
//
//   0 grass | 1 dirt | 2 sand | 3 stone | 4 snow
//
// Mapping from Region 0x13 terrain code → slice index lives in
// `terrain.js` (TERRAIN_CODE_TO_DETAIL_SLICE) — see that file's
// docstring for the per-code rationale.
//
// Texture is linear (`THREE.NoColorSpace`), `RepeatWrapping`, with
// mipmaps. Returns `null` if any PNG fails — the terrain shader
// branches on `uDetailNormalEnabled` and skips sampling when the
// array is missing, matching the pre-Phase-1.2 baseline (flat
// surface normal only).
export const TERRAIN_DETAIL_KEYS = Object.freeze([
  "terrain_grass_normal",
  "terrain_dirt_normal",
  "terrain_sand_normal",
  "terrain_stone_normal",
  "terrain_snow_normal",
]);

const TERRAIN_DETAIL_TILE_SIZE = 1024;

function _terrainDetailUrl(key, baseUrl) {
  const base = baseUrl ?? "scene3d/assets/terrain_detail";
  return `${base}/${key}.png`;
}

/**
 * Decode a PNG URL into a `Uint8ClampedArray` of RGBA pixels via a
 * dom-canvas. Resolves to `{ width, height, rgba }`. Returns null on
 * failure.
 */
async function _decodePngRgba(url) {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return null;
  }
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = (e) => reject(e);
    i.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, rgba: data.data };
}

/**
 * Load all 5 Phase 1.2 terrain detail normal maps into a single
 * `THREE.DataArrayTexture` (depth=5). Resolves to `{ texture, keys }`
 * on success or `null` on any load/decode failure.
 *
 * Memory: 1024 × 1024 × 5 layers × 4 bytes (RGBA) = ~20 MB GPU.
 *
 * @param {{ baseUrl?: string, THREE?: object }} opts
 * @returns {Promise<{ texture: THREE.DataArrayTexture, keys: string[] } | null>}
 */
export async function loadTerrainDetailNormalArray(opts = {}) {
  const { baseUrl, THREE: ThreeOverride } = opts;
  const T = ThreeOverride ?? THREE;
  if (typeof T.DataArrayTexture !== "function") {
    // eslint-disable-next-line no-console
    console.warn(
      "[phase-1.2] THREE.DataArrayTexture unavailable; terrain detail normal disabled"
    );
    return null;
  }

  const decoded = await Promise.all(
    TERRAIN_DETAIL_KEYS.map((key) =>
      _decodePngRgba(_terrainDetailUrl(key, baseUrl)).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[phase-1.2] terrain detail ${key} decode failed:`, e);
        return null;
      })
    )
  );
  if (decoded.some((d) => !d)) return null;

  const w = decoded[0].width;
  const h = decoded[0].height;
  if (decoded.some((d) => d.width !== w || d.height !== h)) {
    // eslint-disable-next-line no-console
    console.warn(
      "[phase-1.2] terrain detail tiles mismatched dimensions; expected uniform tile size"
    );
    return null;
  }

  // Pack RGBA byte plane into a single contiguous Uint8Array of size
  // (w * h * 4) * depth. DataArrayTexture expects RGBAFormat + UnsignedByteType
  // in three.js r0.184.
  const layerStride = w * h * 4;
  const data = new Uint8Array(layerStride * decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    data.set(decoded[i].rgba, i * layerStride);
  }

  const tex = new T.DataArrayTexture(data, w, h, decoded.length);
  tex.format = T.RGBAFormat;
  tex.type = T.UnsignedByteType;
  // Linear colour space — these are normal vectors, not sRGB-encoded
  // colour data. Wrong colour-space causes a visible bias on the
  // mid-tone (128) channel due to the sRGB de-gamma.
  tex.colorSpace = T.NoColorSpace;
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.name = "scene3d-terrain-detail-normal-array";
  tex.needsUpdate = true;

  return { texture: tex, keys: [...TERRAIN_DETAIL_KEYS] };
}

/**
 * Compose a `THREE.Matrix4` from an `ObjectPlacement`-shaped object.
 *
 * The actual wasm `ObjectPlacement` exposes:
 *   `{ x, y, z, rotationZ, modelId, landblockId, isBuilding }`
 *
 * It does NOT carry a full quaternion; the wasm exporter pre-extracts
 * yaw via `atan2(2(qw*qz + qx*qy), 1 - 2(qy² + qz²))` (per
 * `lib.rs:692-708`). This is sufficient because every placed
 * landblock object in AC's wire format carries axis-aligned-Z rotation
 * (objects don't tilt — that's a Frame-on-the-server property only
 * dynamic doors / pieces use).
 *
 * Inputs the function accepts either shape:
 *   1. `{ x, y, z, rotationZ, scale? }` — wasm `ObjectPlacement`.
 *   2. `{ x, y, z, qw, qx, qy, qz, scale? }` — shape used by
 *      `StaticObjectPlacement` (from EnvCells) and the long-term
 *      ObjectPlacement extension. Detected by presence of `qw`.
 *
 * Returns a fresh `THREE.Matrix4` carrying T·R·S in that order.
 */
/**
 * AC world position → three.js world position.
 *
 * `worldRoot` carries `rotation.x = -π/2` so geometry inside it that's
 * authored in AC coords (Z-up, +Y north) renders in three.js's Y-up
 * frame correctly. But cameras + lights live OUTSIDE `worldRoot` (as
 * direct children of `scene`) — their positions are in three.js world
 * coords, not AC coords. This helper applies the same rotation that
 * `worldRoot` applies to its children, so a camera "looking at AC
 * position (ax, ay, az)" can be positioned via
 * `camera.position.set(...acToThree(ax, ay, az))`.
 *
 * The math: rotating (ax, ay, az) by -π/2 around the X axis gives
 * (ax, az, -ay).
 *
 * Used by `scene3d/camera.js` (CameraSwitcher.positionCamera) and
 * `scene3d/index.js` (init3D's initial frame). Validated against
 * `capture_phase7_7_frustum.cjs`'s in-line `acToThree` — a naively-
 * positioned camera (no transform) lands 0 draw calls; the transformed
 * camera lands 153.
 */
export function acToThree(ax, ay, az) {
  return [ax, az, -ay];
}

export function placementToMatrix4(placement) {
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3(placement.x, placement.y, placement.z);
  let quat;
  if (typeof placement.qw === "number") {
    quat = acQuatToThree(
      placement.qw,
      placement.qx,
      placement.qy,
      placement.qz
    );
  } else {
    // Yaw-only — z-axis rotation. Matches AC's ground-object convention
    // and the 2D path's `buildingContainer.rotation = -obj.rotationZ`
    // behaviour. The 2D code negates because PIXI flips Y at the world
    // root with `scale.y = -1`; the 3D path uses `worldRoot.rotation.x =
    // -π/2` instead, which preserves the AC handedness, so we DON'T
    // negate here.
    const yaw = placement.rotationZ ?? placement.rotation ?? 0;
    quat = new THREE.Quaternion();
    quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  }
  const s =
    typeof placement.scale === "number" && placement.scale > 0
      ? placement.scale
      : 1;
  const scale = new THREE.Vector3(s, s, s);
  m.compose(pos, quat, scale);
  return m;
}
