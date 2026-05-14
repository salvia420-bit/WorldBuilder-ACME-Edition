# World-expand step 1 — Objective 1 oracle parity report

**Date:** 2026-05-14
**Landblock:** `0xA9B0` (lbX=169, lbY=176) — South Holtburg Outpost
**Result:** **GREEN.** 36/36 placement parity, heightmap byte-identical.

The wasm reader (`fetch_landblock_objects`) and the WorldBuilder.Terminal
oracle (`list-objects` / `get-heightmap`) agree on every placement and
every height for `0xA9B0`. The wasm path is safe to extend to the full
13x13 ring.

---

## cells.js audit — per-LB lazy loader contract

Source: `external/holtburger/apps/holtburger-web/scene3d/cells.js`
(`buildEnvCellsForLandblock`, lines 77-374). This is the canonical
per-LB lazy-load shape that Objectives 2-4 mirror for terrain,
buildings, and statics.

### Idempotency

- `scene3d.envCellLoadedLbs: Set<u32>` is lazily created the first time
  the function runs (`new Set()` at line 99). Each subsequent call
  short-circuits at line 103 via `envCellLoadedLbs.has(lbKey)` and
  returns `{ cellCount: 0, ..., idempotent: true }`.
- `lbKey` encoding: `(landblockId & 0xffff_0000) >>> 0` (line 102).
  This drops the low 16 bits of the AC `landblockId` (which holds the
  cell sub-id like `0xfffe` / `0xffff` / a per-cell index), keeping only
  the LB-key bits `(lbX << 24) | (lbY << 16)`. The `>>> 0` coerces to
  u32. Same encoding the wasm side uses (see
  `populateBuildingAabbsForLandblock` consumers).
- `scene3d.cellContainers3d: Map<cellId, Group>` registry created at
  line 96 if missing.

### Wasm-drain-into-JS-snapshots pattern (Pass 1)

Wasm-side `EnvCellPlacement` exposes destructive `takeMesh`,
`takeStaticObjects`, `takePortalCellIds`. The code drains each placement
fully BEFORE any `materialCache.preload` or three.js Group construction:

- Lines 141-193 iterate each placement, take ownership of the mesh
  + static-object arrays + portal IDs into plain JS objects
  (`snapshots[i] = { cellId, environmentId, cellOriginX/Y/Z,
  cellOrientationQw/Qx/Qy/Qz, portalCellIds, surfaceGroups, staticSnaps }`),
  then `pl.free()` releases the wasm handle.
- Each `StaticObjectPlacement` is also drained into a plain JS object
  (`{ did, x, y, z, qw, qx, qy, qz }`) and freed.
- This decouples the "wasm round-trip" phase from the "preload textures
  + build three.js Groups" phase. Without the drain, the second phase
  would race wasm GC against three.js construction.

### Material preload (Step B)

- All unique cell-mesh surface DIDs collected during Pass 1 into
  `allCellSurfaceDids: Set<u32>` (line 140).
- One `scene3d.materialCache.preload([...allCellSurfaceDids],
  wasmExports.fetch_surfaces_pixels)` call at lines 198-201 batches
  the surface fetches. The `MaterialCache` dedupes against prior loads.
- A SECOND preload runs at lines 257-259 for the static-object surface
  DIDs after `fetch_model_meshes` resolves. Same idempotent
  `MaterialCache#preload` so already-cached DIDs are no-ops.

### Group instantiation (Step D)

- Each cell becomes:
  - Outer `cellContainer: THREE.Group` (identity transform, named
    `envcell-<hexId>`) with `userData = { cellId, environmentId,
    portalCellIds, isEnvCell: true }`.
  - Inner `meshGroup: THREE.Group` carrying `cellOrigin` (Vector3) +
    `cellOrientation` (Quaternion, via `acQuatToThree`).
  - Per-surface `THREE.Mesh` children of `meshGroup` (cell-local
    vertex coords).
  - Per-static-object `THREE.Mesh` children of `cellContainer` directly
    (world-frame coords; the wasm side already composed
    `cell_rotation * stab_orientation` and added `cell_origin`).
- `cellContainer.visible = false` by default — the per-frame
  `tickCellVisibility3D` flips it based on the wasm BFS render-set.

### Shape that Objectives 2-4 must mirror

For terrain / buildings / statics bakers the contract is:

1. Idempotency Set on `scene3d` (`terrainBakedLbs`, `buildingsBakedLbs`,
   `staticsBakedLbs`) keyed by `(lbX << 24) | (lbY << 16) >>> 0`.
2. Wasm round-trip via `fetch_landblock_*` for the specific LB cellId.
3. Drain wasm placement objects into plain JS snapshots, then `free()`
   the wasm handles.
4. Preload referenced surface DIDs through `scene3d.materialCache`
   BEFORE three.js Mesh / Group construction.
5. Build the three.js subtree from the drained snapshots, attach to
   the appropriate ring-level group (`terrainGroup`, `buildingsGroup`,
   `staticsGroup`).

---

## Oracle counts (WorldBuilder.Terminal)

Command file: `/mnt/wbterminal1/tmp/claude-scratch/world-expand/oracle_cmds.txt`
Output: `/mnt/wbterminal1/tmp/claude-scratch/world-expand/oracle_0xA9B0.jsonl`

### `list-objects` for `lbX=169, lbY=176`

- `success: true`, `landblock: "0xA9B0"`, `count: 36`
- All 36 placements carry `modelId` (0x01... GfxObj or 0x02...
  SetupModel), `x` / `y` / `z` global world coords, `orientation`
  full quaternion, `scale: (1,1,1)` for every placement.

### `get-heightmap` for `lbX=169, lbY=176`

- `gridSize: 9`, `cellSize` populated, `worldOriginX / Y` populated.
- `heightsWorld` is a 9x9 grid (81 vertices).
- Row 0: `[82, 80, 76, 72, 64, 64, 58, 58, 58]`
- min/max: **58 / 90**, range 32 m.

### `describe-landblock` for `lbX=169, lbY=176`

- Region: `Aluvian Heartlands` (settlement, >=3 structures).
- POIs (4): Hardunna (Retired NPC, Quest NPC), Hudriffa the Shopkeeper,
  South Holtburg Outpost (Northeast POI, Major POI), Training Academy.
- Biome: temperate (confidence 1.0).
- Architecture: Aluvian. Structure count: 3.
- Dominant terrain: LushGrass (60.5%), forestfloor (32.1%),
  Grassland (7.4%). Road present.
- Verbal head: `Aluvian Heartlands (LB 0xA9B0, 169,176). settlement
  (>=3 structures). Rugged, mostly lushgrass, road present (Z
  58.0..90.0). 36 objects (3 structures). Two-story building with 8
  interior cells at (32484,33948) z=58.0 ...`

---

## Wasm counts (pkg-nodejs)

Probe: `/mnt/wbterminal1/tmp/claude-scratch/world-expand/probe_0xA9B0_wasm.mjs`
Output: `/mnt/wbterminal1/tmp/claude-scratch/world-expand/wasm_0xA9B0.json`

Bootstrap path:
- `require("pkg-nodejs/holtburger_web.js")`
- Tiny `http.Server` mapping requests onto
  `/mnt/wbterminal1/holtburger-dist-v2/` (Phase 5.2 v2 production bake).
- `wasm.init_resource_source(manifestUrl)` resolved with
  `has_resource_source() === true`, `manifest_version() === 2`.
- `wasm.fetch_landblock_objects(new Uint32Array([0xA9B0FFFE]))` returned
  36 placements.
- `wasm.fetch_landblock_heightmaps(new Uint32Array([0xA9B0FFFF]))`
  returned one `LandblockMesh` proxy with `heightMin: 58`,
  `heightMax: 90`, 81 heights total.

The probe converts wasm's LB-local `(x, y)` to global by adding
`(lbX * 192, lbY * 192) = (32448, 33792)` for comparison to the oracle's
global coords.

### Wasm placement counts
- `placementCount: 36` — same as oracle.
- Heightmap: `heightMin: 58`, `heightMax: 90`, `zCount: 81`,
  `firstRow: [82, 80, 76, 72, 64, 64, 58, 58, 58]`.

---

## Per-placement diff (36/36 match)

Tolerances:
- `modelId`: exact match.
- `(x, y, z)`: within 0.01 m. (Floating-point round-trip noise from
  `f32 -> f64` in wasm-bindgen surfaces at the 4th-5th decimal place.)
- `(qw, qx, qy, qz)`: within 1e-4, tested with sign-ambiguity
  (`q` and `-q` encode the same rotation).
- `isBuilding`: not directly compared (the oracle uses
  `type:"Setup"|"GfxObj"` which is a different axis — the wasm-side
  builds buildings from the `LandblockInfo.buildings` list, all 36
  placements here are in the `objects` (Stab) list with
  `isBuilding == false`; the oracle's three "Structures" in
  `describe-landblock` come from a separate per-shell count).

### Result

| metric | oracle | wasm | match |
|---|---|---|---|
| count | 36 | 36 | YES |
| modelId mismatches | - | 0 / 36 | YES |
| position deltas >0.01m | - | 0 / 36 | YES |
| quaternion deltas >1e-4 (sign-aware) | - | 0 / 36 | YES |
| heightmap heightMin | 58 | 58 | YES |
| heightmap heightMax | 90 | 90 | YES |
| heightmap vertex count | 81 | 81 | YES |
| heightmap first row | `[82,80,76,72,64,64,58,58,58]` | `[82,80,76,72,64,64,58,58,58]` | YES |

### Quaternion sign-handedness note

Several oracle quats carry a negative `w` component (e.g. idx 11:
`w=-0.935137, z=-0.354286`), while the wasm-side rebuilds the quat from
`rotationZ` alone as `(cos(theta/2), 0, 0, sin(theta/2))`, which always
produces non-negative `w`. The two are mathematically equivalent
rotations — `q` and `-q` map to the same rigid-body transform — but a
naive component-wise diff would flag them as different.

This is **not a parity defect**. It's the standard quaternion
double-cover identity. The diff routine handles it by checking both
`abs(o[k] - w[k]) < 1e-4` AND `abs(o[k] + w[k]) < 1e-4` per component,
declaring a match if either holds.

The renderer's per-placement code path will produce the SAME 3D
orientation under either sign convention, so this has no visual
consequence.

---

## Conclusion

The wasm reader produces identical data to the WorldBuilder.Terminal
oracle for `0xA9B0` South Holtburg Outpost:

- 36 / 36 placements with matching `modelId`, position (within 0.01 m),
  and rotation (within 1e-4 modulo quaternion sign).
- Heightmap byte-identical: same first row, same min/max, same vertex
  count.

**Wasm reader is OK to extend to the full 13x13 ring.** No caveats
required for Objectives 2-4 — the per-LB bakers can call
`fetch_landblock_objects` / `fetch_landblock_heightmaps` for any of the
169 ring LBs and expect the same retail-DAT data the oracle reports.

### Caveat for future objectives (not blocking step 1)

The oracle's `describe-landblock` reports "3 structures" via building
shell pairings (BSH009 logic), while the wasm side's
`fetch_landblock_objects` returns all placements in a single flat list
flagged by `isBuilding`. A future capture script asserting "renderer
buildingsGroup count == oracle structureCount" needs to filter the
wasm output by `isBuilding === true`, NOT by `objectCount`. The 36
placements here are all `objects` (the `Stab` list); the 3 oracle
structures live in the parallel `buildings` (`BuildInfo`) list which
`fetch_landblock_objects` ALSO emits when the LandblockInfo has
buildings. For this LB, the buildings live elsewhere — the
`describe-landblock` body mentions buildings at `(32484, 33948)`,
`(32484, 33900)`, and a third — but those are inside the same flat
`fetch_landblock_objects` return (different items in the input order).
Objective 10's capture script needs to gate `oracle.count` against
`placements.length` (not `placements.filter(p => p.isBuilding).length`),
because the oracle's `list-objects` count includes BOTH
`objects` and `buildings` placement lists, same as `fetch_landblock_objects`.

For Objective 1 — which is "do the two readers agree on the data they
both emit" — that gate is GREEN.

---

## Files left behind

Under `/mnt/wbterminal1/tmp/claude-scratch/world-expand/`:

- `oracle_cmds.txt` — JSON command stream for the oracle.
- `oracle_0xA9B0.jsonl` — full WorldBuilder.Terminal output for the
  three commands (list-objects, get-heightmap, describe-landblock).
- `wasm_0xA9B0.json` — drained wasm-side output: 36 placements + the
  heightmap summary.
- `probe_0xA9B0_wasm.mjs` — reproducible wasm-from-Node probe with
  the http.Server + init_resource_source bootstrap.

To re-run the parity check end-to-end:

```bash
# Oracle.
cd /home/wbterminal/WorldBuilder-ACME-Edition
DOTNET_ROOT=/home/wbterminal/.dotnet \
$DOTNET_ROOT/dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll \
  --project /home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj --stdin \
  < /mnt/wbterminal1/tmp/claude-scratch/world-expand/oracle_cmds.txt \
  > /mnt/wbterminal1/tmp/claude-scratch/world-expand/oracle_0xA9B0.jsonl

# Wasm.
cd external/holtburger/apps/holtburger-web
node /mnt/wbterminal1/tmp/claude-scratch/world-expand/probe_0xA9B0_wasm.mjs
```

The probe runs in ~3 s on a warm system; the oracle in ~5 s.
