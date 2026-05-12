// Phase 7.1 — terrain heightfield + bilinear-blend shader.
//
// Ports the GLSL ES 3.00 shader pair from `index.html:975-1082` to a
// `THREE.ShaderMaterial`. The 2D path uses PIXI v8's MeshPipe shader
// chain (`uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix`,
// `vColor` modulation, `aPosition` as vec2) — three.js injects its own
// `projectionMatrix` + `modelViewMatrix` + `position` (vec3) so we
// drop the PIXI plumbing and keep the bilinear-blend body byte-for-
// byte identical, which is what the visual output depends on.
//
// Builds one heightfield Mesh per landblock (Holtburg 9-LB ring), each
// with vertex Z = real terrain height in metres (range [0, 510]). The
// 2D `buildLandblockChildren` path (`index.html:2071-2199`) flattens to
// 2D positions before upload; we keep the third dimension and rely on
// `computeVertexNormals()` (called inside `landblockMeshToGeometry`)
// to set up Lambert sun lighting for Phase 7.6.
//
// Roads are rendered as a thin triangle-strip overlay mesh, lifted
// 0.1 m above terrain to avoid Z-fighting. Mirrors the directional
// scan from `index.html:2113-2176` (E / N / NE / NW pairs), but uses
// triangle pairs instead of `PIXI.Graphics` strokes.

import * as THREE from "three";
import {
  landblockMeshToGeometry,
  buildVertexTypesDataTexture,
  buildTerrainAtlasCanvas,
} from "./adapter.js";

// ----- AC world-coord constants -------------------------------------
const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

// ----- GLSL — bilinear-blend shader, three.js port ------------------
//
// Vertex shader: drops the PIXI mat3 chain in favour of three.js's
// auto-injected `projectionMatrix` + `modelViewMatrix` + `position`
// (vec3) builtins. The per-fragment `vGridUv = position.xy / 24.0`
// matches the 2D path: position.xy is in LB-local metres (0..192,
// 24 m vertex spacing), so dividing by 24 yields a [0, 8] grid coord
// the fragment shader uses to bilinear-blend.
//
// Vertex Z (height) ends up in clip-space via the same
// `projectionMatrix * modelViewMatrix * vec4(position, 1.0)` chain;
// the fragment shader is height-agnostic — it samples by xy only —
// which is correct because terrain types are 2D footprints, not 3D.
const TERRAIN_VERTEX_GLSL = `
precision highp float;

out vec2 vGridUv;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Per-vertex grid coordinate in [0, 8] across the 192 m landblock
  // (8 cells × 24 m each). Fragment splits into integer cell index
  // + intra-cell UV, looks up the cell's 4 corner terrain types
  // from uVertexTypes, samples uAtlas at each corner, and blends by
  // bilinear weights.
  vGridUv = position.xy / 24.0;
}
`;

// Fragment shader: ported verbatim from `index.html:1006-1082` minus
// the PIXI-specific `vColor` varying + uColor/uWorldColorAlpha
// modulation. The bilinear-blend body is byte-identical to the 2D
// path — same texelFetch lookup, same atlasUvFor mapping, same 4-
// corner weights — so visual output should match the 2D bilinear
// reference once the camera converges (Phase 7.5+ camera work).
const TERRAIN_FRAGMENT_GLSL = `
precision highp float;
precision highp int;

uniform sampler2D uAtlas;             // 6×6 grid of 256×256 retail terrain tiles
uniform vec2 uAtlasGridSize;          // (cols, rows) — typically (6, 6)
uniform sampler2D uVertexTypes;       // 9×9 RGBA8: R = terrain type byte, A = 255

in vec2 vGridUv;

out vec4 fragColor;

// Map terrain code (0..32) → atlas UV at the given cell-local UV.
// Retail terrain atlas is a 6×6 grid; tile index = code.
vec2 atlasUvFor(int code, vec2 cellUv) {
  int cols = int(uAtlasGridSize.x);
  int col = code - (code / cols) * cols;
  int row = code / cols;
  vec2 origin = vec2(float(col), float(row)) / uAtlasGridSize;
  vec2 size = vec2(1.0) / uAtlasGridSize;
  return origin + size * cellUv;
}

int vertexTypeAt(int iu, int iv) {
  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);
}

void main() {
  // vGridUv is [0, 8] across the 192 m LB. Bilinear 4-corner blend.
  vec2 grid = vGridUv;
  int iu = int(floor(grid.x));
  int iv = int(floor(grid.y));
  iu = clamp(iu, 0, 7);
  iv = clamp(iv, 0, 7);
  float fu = grid.x - float(iu);
  float fv = grid.y - float(iv);
  vec2 cellUv = vec2(fu, fv);

  int t00 = vertexTypeAt(iu,     iv    );  // SW
  int t10 = vertexTypeAt(iu + 1, iv    );  // SE
  int t01 = vertexTypeAt(iu,     iv + 1);  // NW
  int t11 = vertexTypeAt(iu + 1, iv + 1);  // NE

  vec3 c00 = texture(uAtlas, atlasUvFor(clamp(t00, 0, 32), cellUv)).rgb;
  vec3 c10 = texture(uAtlas, atlasUvFor(clamp(t10, 0, 32), cellUv)).rgb;
  vec3 c01 = texture(uAtlas, atlasUvFor(clamp(t01, 0, 32), cellUv)).rgb;
  vec3 c11 = texture(uAtlas, atlasUvFor(clamp(t11, 0, 32), cellUv)).rgb;

  float w00 = (1.0 - fu) * (1.0 - fv);
  float w10 = fu * (1.0 - fv);
  float w01 = (1.0 - fu) * fv;
  float w11 = fu * fv;

  vec3 result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;

  fragColor = vec4(result, 1.0);
}
`;

/**
 * Compute the Holtburg 9-LB neighbourhood cell ids (matches the
 * `NEIGHBOURHOOD` const at `index.html:802-811`). Returned as a flat
 * `{ ids: Uint32Array, coords: Array<{x, y, id}> }` for symmetry with
 * the 2D path's `n.x / n.y / n.id` layout. The traversal order
 * (`dy: +1 → -1, dx: -1 → +1`) matches the 2D path exactly so
 * `meshes[i]` aligns with `coords[i]` after the parallel
 * `fetch_landblock_heightmaps` call.
 */
function holtburgNeighbourhoodCellIds() {
  const coords = [];
  for (let dy = 1; dy >= -1; dy -= 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = HOLTBURG_X + dx;
      const y = HOLTBURG_Y + dy;
      coords.push({
        x,
        y,
        id: ((x << 24) | (y << 16) | 0xffff) >>> 0,
      });
    }
  }
  const ids = new Uint32Array(coords.map((c) => c.id >>> 0));
  return { ids, coords };
}

/**
 * Build a thin triangle-strip road overlay mesh for one landblock.
 *
 * Mirrors the 2D vector-stroke pass at `index.html:2113-2176`. For
 * each vertex with `roadCode != 0`, emit a thin quad (two triangles)
 * to its E / N / NE / NW neighbour if that neighbour is also road.
 *
 * Quad construction: take the 3D segment from vertex A to vertex B
 * (xy from `positions`, z = height + 0.1 m to lift above terrain),
 * compute a 2D perpendicular in the xy plane, and emit two corner
 * pairs (A±perp*halfWidth, B±perp*halfWidth) as a 2-triangle quad.
 * Z lift dodges Z-fighting against the heightfield without needing
 * `polygonOffset` (which works but is fiddly per-driver).
 *
 * Returns null if the LB has no roads (skips the empty-mesh allocation
 * + draw-call cost). Holtburg has roads in every LB per the 2D
 * `render-preview` baseline, but neighbouring LBs may not.
 */
function buildRoadOverlayMesh(positions, roadCodes, roadTexture) {
  const halfWidth = 0.75; // 1.5 m total — matches 2D `width: 1.5`.
  const liftZ = 0.1;
  const ROAD_DIRS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];

  const verts = [];
  const indices = [];
  const uvs = [];

  let edgeCount = 0;
  // Tile the road texture every 6 m along each segment, mirroring the
  // 2D path's `ROAD_TEXTURE_TILE_M = 6.0`. Native tile is sampled with
  // RepeatWrapping in the caller; the V coord goes [0, halfWidth*2 / TILE]
  // across the stroke width, U progresses by segment length / TILE.
  const TILE_M = 6.0;
  for (let vv = 0; vv < 9; vv += 1) {
    for (let vu = 0; vu < 9; vu += 1) {
      const idx = vv * 9 + vu;
      if (!roadCodes[idx]) continue;
      for (const [du, dv] of ROAD_DIRS) {
        const nu = vu + du;
        const nv = vv + dv;
        if (nu < 0 || nu > 8 || nv < 0 || nv > 8) continue;
        const nIdx = nv * 9 + nu;
        if (!roadCodes[nIdx]) continue;

        const ax = positions[idx * 3 + 0];
        const ay = positions[idx * 3 + 1];
        const az = positions[idx * 3 + 2] + liftZ;
        const bx = positions[nIdx * 3 + 0];
        const by = positions[nIdx * 3 + 1];
        const bz = positions[nIdx * 3 + 2] + liftZ;

        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;

        // 2D perpendicular in the xy plane. Rotate (dx, dy) by 90°.
        const px = -dy / len;
        const py = dx / len;
        const ox = px * halfWidth;
        const oy = py * halfWidth;

        const base = (verts.length / 3) | 0;
        // 4 corners: A-left, A-right, B-left, B-right.
        verts.push(ax + ox, ay + oy, az);
        verts.push(ax - ox, ay - oy, az);
        verts.push(bx + ox, by + oy, bz);
        verts.push(bx - ox, by - oy, bz);

        const uMax = len / TILE_M;
        const vMax = (halfWidth * 2) / TILE_M;
        // UVs: U progresses along the segment, V across the stroke.
        // Left edge V=0, right V=vMax.
        uvs.push(0, 0, 0, vMax, uMax, 0, uMax, vMax);

        // Two triangles, CCW from the +Z-up side (terrain side).
        indices.push(base + 0, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);

        edgeCount += 1;
      }
    }
  }

  if (edgeCount === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(verts), 3, false)
  );
  geom.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(uvs), 2, false)
  );
  geom.setIndex(
    new THREE.BufferAttribute(new Uint32Array(indices), 1)
  );
  geom.computeBoundingSphere();

  // Polygon offset belt-and-braces with the 0.1 m Z lift. polygonOffset
  // handles cases where the lift gets compressed by clip-space depth
  // precision at long view distances.
  const mat = roadTexture
    ? new THREE.MeshBasicMaterial({
        map: roadTexture,
        transparent: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    : new THREE.MeshBasicMaterial({
        color: 0xc8b888,
        transparent: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "road-overlay";
  return mesh;
}

/**
 * Build the Holtburg 9-LB terrain (heightfield meshes + bilinear-blend
 * shader + per-LB vertex-types texture + road overlays) and add it to
 * `scene3d.terrainGroup`.
 *
 * Returns a summary `{ atlasTexture, roadTexture, lbCount, atlasCanvas,
 * roadCanvas }` with the shared atlas / road textures stashed for later
 * phases (Phase 7.5 camera, Phase 7.7 cleanup) to reuse.
 */
export async function buildHoltburgTerrain(scene3d, wasmExports) {
  if (!scene3d || !scene3d.terrainGroup) {
    throw new Error(
      "buildHoltburgTerrain: scene3d.terrainGroup missing (call init3D first)"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function" ||
    typeof wasmExports.fetch_terrain_textures !== "function"
  ) {
    throw new Error(
      "buildHoltburgTerrain: wasmExports missing fetch_landblock_heightmaps / fetch_terrain_textures"
    );
  }

  // 1. Compute the 9 cell ids.
  const { ids, coords } = holtburgNeighbourhoodCellIds();

  // 2. Fetch heightmaps + terrain textures in parallel.
  const [meshes, terrainTextures] = await Promise.all([
    wasmExports.fetch_landblock_heightmaps(ids),
    wasmExports.fetch_terrain_textures(),
  ]);
  if (meshes.length !== coords.length) {
    throw new Error(
      `buildHoltburgTerrain: expected ${coords.length} meshes, got ${meshes.length}`
    );
  }

  // 3. Build the shared atlas + road canvases, wrap as three textures.
  const { atlasCanvas, roadCanvas } =
    buildTerrainAtlasCanvas(terrainTextures);

  const atlasTexture = new THREE.CanvasTexture(atlasCanvas);
  // Atlas tiles are colour data — sRGB so three's renderer linearises
  // them before the fragment shader does its bilinear blend.
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.magFilter = THREE.LinearFilter;
  atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTexture.generateMipmaps = true;
  atlasTexture.needsUpdate = true;

  let roadTexture = null;
  if (roadCanvas) {
    roadTexture = new THREE.CanvasTexture(roadCanvas);
    roadTexture.colorSpace = THREE.SRGBColorSpace;
    roadTexture.wrapS = THREE.RepeatWrapping;
    roadTexture.wrapT = THREE.RepeatWrapping;
    roadTexture.magFilter = THREE.LinearFilter;
    roadTexture.minFilter = THREE.LinearMipmapLinearFilter;
    roadTexture.generateMipmaps = true;
    roadTexture.needsUpdate = true;
  }

  // 4 + 5. Per-LB heightfield + road overlay.
  const ATLAS_GRID_SIZE = new THREE.Vector2(6, 6);
  let lbWithRoads = 0;
  for (let i = 0; i < coords.length; i += 1) {
    const wasmMesh = meshes[i];
    const { x: lbX, y: lbY } = coords[i];

    // Snapshot what we need from the wasm mesh BEFORE freeing it. The
    // adapter copies the buffers into BufferAttributes, but the road
    // overlay needs raw `positions` + `roadCodes` to walk neighbours;
    // copy those once here so we can free the wasm struct safely.
    const positionsCopy = Float32Array.from(wasmMesh.positions);
    const roadCodesCopy = Uint8Array.from(wasmMesh.roadCodes);
    const terrainCodesCopy = Uint8Array.from(wasmMesh.terrainCodes);
    const heightMin = wasmMesh.heightMin;
    const heightMax = wasmMesh.heightMax;

    const geom = landblockMeshToGeometry(wasmMesh);
    const vertexTypesTex = buildVertexTypesDataTexture(terrainCodesCopy);

    const material = new THREE.ShaderMaterial({
      // three.js auto-injects `projectionMatrix`, `modelViewMatrix`,
      // and the `position` attribute. We just supply the user
      // uniforms.
      uniforms: {
        uAtlas: { value: atlasTexture },
        uAtlasGridSize: { value: ATLAS_GRID_SIZE },
        uVertexTypes: { value: vertexTypesTex },
      },
      vertexShader: TERRAIN_VERTEX_GLSL,
      fragmentShader: TERRAIN_FRAGMENT_GLSL,
      glslVersion: THREE.GLSL3,
      // Heightfield is single-sided: backfaces are looking at the
      // world from below the terrain — never the player's vantage.
      // The F#27 fix in `landblockMeshToGeometry` reverses the wasm's
      // CW-from-AC-+Z index winding so FrontSide is correct post-
      // worldRoot rotation. Don't flip back to DoubleSide without
      // also reverting the adapter's index reversal.
      side: THREE.FrontSide,
    });

    const lbMesh = new THREE.Mesh(geom, material);
    lbMesh.name = `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`;
    // Per-LB world offset (xy in metres). The geometry is LB-local
    // (x,y in [0, 192]) so the world position is just (lbX*192, lbY*192).
    lbMesh.position.set(
      lbX * METERS_PER_LANDBLOCK,
      lbY * METERS_PER_LANDBLOCK,
      0
    );
    // Stash height range on the userData so the capture can verify
    // terrain isn't flat-zero without a wasm round-trip.
    //
    // Task D (2026-05-12) — `terrainCodes` is the wasm column-major
    // 81-byte block (vertex `i` has gridX = i/9, gridY = i%9; see
    // `adapter.js::buildVertexTypesDataTexture` for the transpose note).
    // The ambient-runtime sampler reads this per tick to look up the
    // player's terrain type for the Region → AmbientSTB chain. Storing
    // the raw bytes (not the DataTexture) keeps the runtime free of
    // GPU readback — sampling is a single byte fetch per tick.
    lbMesh.userData = {
      lbX,
      lbY,
      lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
      heightMin,
      heightMax,
      vertexTypesTexture: vertexTypesTex,
      terrainCodes: terrainCodesCopy,
    };

    // Group keeps the road overlay parented under the same lbMesh
    // transform — simpler than a sibling group, and toggling
    // `lbMesh.visible` still hides both atomically.
    scene3d.terrainGroup.add(lbMesh);

    const roadMesh = buildRoadOverlayMesh(
      positionsCopy,
      roadCodesCopy,
      roadTexture
    );
    if (roadMesh) {
      lbMesh.add(roadMesh);
      lbWithRoads += 1;
    }

    // Free the wasm mesh now that all needed data is copied.
    if (typeof wasmMesh.free === "function") wasmMesh.free();
  }

  // Stash on the scene3d for later phases.
  scene3d.terrainAtlasTexture = atlasTexture;
  scene3d.terrainRoadTexture = roadTexture;
  scene3d.terrainAtlasCanvas = atlasCanvas;
  scene3d.terrainRoadCanvas = roadCanvas;
  scene3d.terrainLbCount = coords.length;

  return {
    atlasTexture,
    roadTexture,
    atlasCanvas,
    roadCanvas,
    lbCount: coords.length,
    lbWithRoads,
  };
}
