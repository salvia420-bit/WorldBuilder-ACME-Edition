// Workstream Sky-E — SkyObject asset resolver.
//
// Resolves the `default_gfx_object_id` values from a SkyDesc's
// SkyObjects through the existing manifest-v2 lazy fetch +
// GfxObj/SetupModel/Surface/Texture parsing path so Sky-D's renderer
// has meshes + textures to consume.
//
// **Dispatch on prefix.** SkyObject DIDs can be either:
//   - `0x01xxxxxx` — raw GfxObj. Single-part mesh, surfaces[] resolves
//     directly to textures via the Surface→SurfaceTexture→Texture chain.
//   - `0x02xxxxxx` — SetupModel. Walks `parts[]` (each a 0x01 GfxObj)
//     and aggregates their surfaces. E.g. Dereth Sunny SkyObject[6] is
//     `0x02000714` paired with PhysicsScript `0x330007DB` for the moon.
//
// Both prefixes flow through the same `fetchBuildingPlacement` wasm
// export (lib.rs `fetch_building_placement`) — that function already
// dispatches on the high byte and routes 0x01 to a single-part Vec and
// 0x02 through the SetupModel parts walker. **By reusing it we avoid
// touching the wasm boundary at all for this resolver** — the texture
// pipeline plumbing piggy-backs on the building pipeline.
//
// **Output shape.** Sky-D's renderer needs:
//   1. Per-SkyObject: list of `(geometry, surfaceDid, material)` tuples
//      ready to instantiate as `THREE.Mesh`. Multi-surface (e.g. the
//      moon's 2-surface halo + body) becomes N meshes under a parent.
//   2. The per-SkyObject hinge frames are NOT needed (sky objects don't
//      have doors / articulated parts that swing). But the bundle is
//      preserved as-is from `fetchBuildingPlacement` so future polish
//      (e.g. per-part luminosity from the SkyObjectReplace's per-part
//      overrides) can layer in without re-baking.
//   3. Surface materials are baked via the shared `MaterialCache` so
//      sky textures share the same path as buildings/EnvCells: one
//      wasm round-trip per unique surface, then per-DID DataTexture +
//      MeshStandardMaterial.
//
// **Idempotency.** A second call with the same `skyObjectIds` is a
// no-op — `liveScene3d.skyAssets` is checked at entry; if it's already
// populated the function returns the cached snapshot.
//
// **The 7 retail SkyObjects** (Dereth Region 1, DayGroup[0] "Sunny",
// verified against real `client_portal.dat` 2026-05-11):
//
//   | ID           | Type       | Role
//   |--------------|------------|------------------------------------
//   | 0x010015EE   | GfxObj     | base sky shell (4 surfaces)
//   | 0x010015EF   | GfxObj     | second base shell (Translucent)
//   | 0x01001F67   | GfxObj     | sun (Index16, palette 0x040000FF)
//   | 0x01001F6A   | GfxObj     | moon (2 surfaces: body + halo)
//   | 0x01004C36   | GfxObj     | scrolling cloud band (Translucent)
//   | 0x01001348   | GfxObj     | stars (Translucent+Additive)
//   | 0x02000714   | SetupModel | physics moon → part 0x010001EC
//
// All seven resolve cleanly through `fetchBuildingPlacement`.

import * as THREE from "three";
import { meshToGeometryGroups, acQuatToThree } from "./adapter.js";
import { MaterialCache } from "./materials.js";

/**
 * Resolve a single SkyObject's GfxObj/SetupModel into a JS-owned bake.
 *
 * Returns:
 *   {
 *     skyObjectId: u32,             // input ID (0x01.. or 0x02..)
 *     setupId:     u32,             // wasm-reported setup ID (== input for 0x01)
 *     prefix:      0x01 | 0x02,
 *     parts: [
 *       {
 *         partIndex: number,
 *         groups: [{ geometry, surfaceDid }],
 *         hinge:  { x, y, z, qw, qx, qy, qz }
 *       }
 *     ],
 *     surfaceDids: Set<u32>
 *   }
 *
 * Returns `null` on resolution failure (wasm threw / setup_id invalid).
 */
async function bakeSkyObject(skyObjectId, fetchBuildingPlacement) {
  const id = skyObjectId >>> 0;
  const prefix = (id >>> 24) & 0xff;
  if (prefix !== 0x01 && prefix !== 0x02) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.sky_assets] unsupported SkyObject prefix 0x${prefix.toString(16)} for id 0x${id.toString(16).padStart(8, "0")}`
    );
    return null;
  }

  let bundle;
  try {
    bundle = await fetchBuildingPlacement(id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.sky_assets] fetchBuildingPlacement(0x${id.toString(16).padStart(8, "0")}) failed:`,
      e
    );
    return null;
  }

  const setupId = bundle.setupId >>> 0;
  const partCount = bundle.partCount | 0;
  if (partCount === 0) {
    if (typeof bundle.free === "function") bundle.free();
    return {
      skyObjectId: id,
      setupId,
      prefix,
      parts: [],
      surfaceDids: new Set(),
    };
  }

  const meshes = bundle.takePartMeshes();
  const hinges = bundle.takePartHingeFrames();
  if (typeof bundle.free === "function") bundle.free();

  const surfaceDids = new Set();
  const parts = new Array(meshes.length);
  for (let pi = 0; pi < meshes.length; pi += 1) {
    const mesh = meshes[pi];
    const hinge = hinges[pi];
    const hingeSnapshot = hinge
      ? {
          x: hinge.x,
          y: hinge.y,
          z: hinge.z,
          qw: hinge.qw,
          qx: hinge.qx,
          qy: hinge.qy,
          qz: hinge.qz,
        }
      : { x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0 };
    if (hinge && typeof hinge.free === "function") hinge.free();

    const { groups, surfaceDids: dids } = meshToGeometryGroups(mesh);
    for (const did of dids) surfaceDids.add(did);

    parts[pi] = {
      partIndex: pi,
      groups,
      hinge: hingeSnapshot,
    };
    if (typeof mesh.free === "function") mesh.free();
  }

  return {
    skyObjectId: id,
    setupId,
    prefix,
    parts,
    surfaceDids,
  };
}

/**
 * Resolve a list of SkyObject IDs to baked meshes + textures and stash
 * the result on `liveScene3d.skyAssets`.
 *
 * Inputs:
 *   - `scene3d` — the `scene3dForBuilders` (or fully-constructed
 *     `liveScene3d`) object that owns `materialCache`. Sky textures
 *     share the building/EnvCell texture cache so a sky texture that
 *     happens to also be referenced by a building doesn't trigger a
 *     duplicate wasm fetch.
 *   - `skyObjectIds` — array of `u32` SkyObject IDs (typically the 7
 *     IDs from Sky-B's `getSkyObjectStates().map(s => s.gfxObjectId)`,
 *     but the function is agnostic — any list of `0x01..` / `0x02..`
 *     DIDs is valid).
 *   - `wasmExports` — must carry `fetchBuildingPlacement` +
 *     `fetch_surfaces_pixels`. Throws if either is missing.
 *
 * Returns a summary:
 *   {
 *     resolved:           number,       // SkyObjects with at least one part
 *     failed:             number,       // SkyObjects whose bake returned null
 *     uniqueSurfaceCount: number,       // total unique surface DIDs
 *     uniqueModelCount:   number,       // === resolved (one model per SkyObject)
 *     setupModelCount:    number,       // SkyObjects with prefix 0x02 (multi-part)
 *     largestTexture: { surfaceDid: u32, w: number, h: number } | null,
 *     totalTriangles:     number,       // sum across all parts/groups
 *   }
 *
 * Side effects:
 *   - `scene3d.skyAssets = Map<skyObjectId, bake>` — Map keyed by
 *     the input SkyObject ID. Sky-D's renderer reads through this.
 *   - `scene3d.materialCache` — preloaded with every surface DID
 *     referenced by the resolved SkyObjects.
 *   - `window.liveScene3d.skyAssets` — mirrored for capture-script
 *     access (matches the `window.buildingMap3d` pattern).
 *
 * Idempotent: a second call with the same ID list is a no-op. Pass
 * `{ force: true }` to re-bake (e.g. on DayGroup change — though in
 * practice the 7 IDs are stable across DayGroups in retail Dereth).
 */
export async function resolveSkyAssets(
  scene3d,
  skyObjectIds,
  wasmExports,
  opts = {}
) {
  if (!scene3d) {
    throw new Error("resolveSkyAssets: scene3d missing");
  }
  if (!Array.isArray(skyObjectIds)) {
    throw new Error(
      `resolveSkyAssets: skyObjectIds must be an array (got ${typeof skyObjectIds})`
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetchBuildingPlacement !== "function" ||
    typeof wasmExports.fetch_surfaces_pixels !== "function"
  ) {
    throw new Error(
      "resolveSkyAssets: wasmExports missing fetchBuildingPlacement / fetch_surfaces_pixels"
    );
  }

  // Dedupe + normalise. SkyObject IDs are u32; coerce in case the caller
  // passed signed ints or strings.
  const uniqueIds = [];
  const seen = new Set();
  for (const raw of skyObjectIds) {
    const id = (raw >>> 0);
    if (id === 0) continue; // sentinel "no mesh" per PhatSDK
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }

  // Idempotent path — return cached snapshot unless forced.
  const force = !!opts.force;
  const cached = scene3d.skyAssets;
  if (!force && cached instanceof Map && cached.size > 0) {
    const sameSet =
      cached.size === uniqueIds.length &&
      uniqueIds.every((id) => cached.has(id));
    if (sameSet) {
      return summariseSkyAssets(cached);
    }
  }

  // Bake every unique SkyObject in parallel.
  const bakes = await Promise.all(
    uniqueIds.map((id) => bakeSkyObject(id, wasmExports.fetchBuildingPlacement))
  );

  // Collect unique surface DIDs across every bake.
  const allSurfaceDids = new Set();
  let resolved = 0;
  let failed = 0;
  let setupModelCount = 0;
  const skyAssets = new Map();
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const id = uniqueIds[i];
    const bake = bakes[i];
    if (!bake) {
      failed += 1;
      continue;
    }
    if (bake.parts.length === 0) {
      failed += 1;
      continue;
    }
    resolved += 1;
    if (bake.prefix === 0x02) setupModelCount += 1;
    for (const did of bake.surfaceDids) allSurfaceDids.add(did);
    skyAssets.set(id, bake);
  }

  // Preload all referenced surfaces in one wasm round-trip.
  // Phase 0.2 — detail tile cache propagation. See buildings.js.
  // Phase 3.3 — deliberately do NOT pass csmState here. SkyObjects
  // (moons, weather streaks, cloud bands) render far past the
  // 300 m cascade range; the CSM shader's `viewDepth > uCsmFar` early-
  // return handles that, but creating a fresh MaterialCache without
  // CSM keeps the sky's compiled shaders strictly smaller for the
  // common case where sky_assets runs before the shared `materialCache`
  // is set on scene3d. When the shared cache IS already on scene3d
  // (the common case post-Phase-0.2), this branch is skipped and the
  // skybox inherits CSM along with terrain + buildings — the shader
  // path still draws correctly since sky meshes sit beyond uCsmFar.
  const materialCache =
    scene3d.materialCache ||
    new MaterialCache({
      detailTileCache: scene3d.detailTileCache ?? null,
      forceDetail: !!scene3d.forceDetail,
      pomEnabled: !!scene3d.pomEnabled,
      forcePom: !!scene3d.forcePom,
    });
  if (allSurfaceDids.size > 0) {
    try {
      await materialCache.preload(
        [...allSurfaceDids],
        wasmExports.fetch_surfaces_pixels
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.sky_assets] materialCache.preload failed:", e);
    }
  }
  scene3d.materialCache = materialCache;
  scene3d.skyAssets = skyAssets;

  // Mirror to window for capture-script access (matches buildingMap3d).
  if (typeof window !== "undefined") {
    window.liveScene3d = window.liveScene3d || scene3d;
    window.liveScene3d.skyAssets = skyAssets;
  }

  return summariseSkyAssets(skyAssets);
}

/**
 * Compute the summary fields a capture script asserts on. Pure
 * function of the cached `skyAssets` map — safe to call repeatedly.
 */
function summariseSkyAssets(skyAssets) {
  let resolved = 0;
  let setupModelCount = 0;
  const allSurfaceDids = new Set();
  let totalTriangles = 0;
  for (const bake of skyAssets.values()) {
    if (bake.parts.length > 0) {
      resolved += 1;
      if (bake.prefix === 0x02) setupModelCount += 1;
      for (const did of bake.surfaceDids) allSurfaceDids.add(did);
      for (const part of bake.parts) {
        for (const g of part.groups) {
          const positions = g.geometry.getAttribute?.("position");
          if (positions) {
            // 3 verts per triangle.
            totalTriangles += positions.count / 3;
          }
        }
      }
    }
  }
  return {
    resolved,
    failed: 0, // failed entries aren't stored in the map
    uniqueSurfaceCount: allSurfaceDids.size,
    uniqueModelCount: skyAssets.size,
    setupModelCount,
    largestTexture: null,
    totalTriangles,
  };
}

/**
 * Build a `THREE.Group` for one SkyObject, using a per-part hinge
 * wrapper tree just like buildings.js so Sky-D's renderer can address
 * parts uniformly. The Group is NOT added to any scene — caller decides
 * placement (typically under a `skyDome` Group at the camera position
 * with billboard / world-fixed orientation).
 *
 *   skyObjectGroup (named `sky-<id>`)
 *     ├─ partGroup-0 (hinge transform; identity for non-articulated)
 *     │   ├─ surfaceMesh-0 (one per geometry group)
 *     │   └─ surfaceMesh-1 (if part has multiple surfaces)
 *     └─ partGroup-1 (next part)
 *
 * `userData` on the placement Group carries `{ skyObjectId, setupId,
 * prefix, partGroups }` so Sky-D's per-tick `updateSkyObjectPose`
 * (which receives `SkyObjectState.heading`, `pitch`, `texOffsetX/Y`,
 * etc. from Sky-B's `getSkyObjectStates`) can address the part by
 * index.
 *
 * Materials come from the shared `MaterialCache` — caller must have
 * already populated it via `resolveSkyAssets` (which calls preload).
 */
export function buildSkyObjectGroup(bake, materialCache) {
  if (!bake || !Array.isArray(bake.parts)) {
    throw new Error("buildSkyObjectGroup: bake missing parts[]");
  }
  if (!materialCache) {
    throw new Error("buildSkyObjectGroup: materialCache missing");
  }
  const id = bake.skyObjectId >>> 0;
  const group = new THREE.Group();
  group.name = `sky-${id.toString(16).padStart(8, "0")}`;
  group.userData = {
    skyObjectId: id,
    setupId: bake.setupId,
    prefix: bake.prefix,
    partGroups: [],
  };
  for (const part of bake.parts) {
    const hingeWrapper = new THREE.Group();
    hingeWrapper.name = `part-${part.partIndex}`;
    hingeWrapper.position.set(part.hinge.x, part.hinge.y, part.hinge.z);
    hingeWrapper.quaternion.copy(
      acQuatToThree(part.hinge.qw, part.hinge.qx, part.hinge.qy, part.hinge.qz)
    );
    hingeWrapper.userData = {
      skyObjectId: id,
      partIndex: part.partIndex,
      hinge: part.hinge,
    };
    for (const g of part.groups) {
      const mat = materialCache.getCached(g.surfaceDid);
      const mesh = new THREE.Mesh(g.geometry, mat);
      mesh.name = `surface-${g.surfaceDid.toString(16).padStart(8, "0")}`;
      mesh.userData = {
        skyObjectId: id,
        partIndex: part.partIndex,
        surfaceDid: g.surfaceDid,
      };
      // Sky meshes don't shadow-cast and are typically rendered after
      // the world (depthTest=false would be a Sky-D concern). Default
      // material settings come from MaterialCache flags (Translucent,
      // Additive, etc.) which already match the surface_type bitfield.
      hingeWrapper.add(mesh);
    }
    group.add(hingeWrapper);
    group.userData.partGroups.push(hingeWrapper);
  }
  return group;
}
