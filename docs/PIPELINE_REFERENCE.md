# Vanquish World Pipeline — Complete Mechanical Reference

> **Purpose**: This document is the definitive reference for how buildings, NPCs, terrain, and game objects flow from the WorldBuilder project through to the ACE server and Asheron's Call client. Every agent working on this codebase **must read and understand this document** before making changes to any part of the pipeline.

---

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Layer 1: Terrain (DAT File `client_cell_1.dat`)](#2-layer-1-terrain)
3. [Layer 2: Buildings & EnvCells (DAT File `client_cell_1.dat`)](#3-layer-2-buildings--envcells)
4. [Layer 3: NPC/Object Instances (ACE MySQL Database)](#4-layer-3-npcobject-instances)
5. [The Full Pipeline — Step by Step](#5-the-full-pipeline)
6. [Critical Files & Their Roles](#6-critical-files--their-roles)
7. [Common Failure Modes & Root Causes](#7-common-failure-modes--root-causes)
8. [Coordinate Systems](#8-coordinate-systems)
9. [DAT File Structure Reference](#9-dat-file-structure-reference)
10. [Debugging Checklist](#10-debugging-checklist)

---

## 1. Architecture Overview

The Vanquish world has **three independent data layers** that must all agree for the game to work correctly:

```
┌─────────────────────────────────────────────────────────┐
│                    AC Client Rendering                   │
│  Reads terrain + buildings from DAT files on disk        │
│  Reads NPC positions from ACE server over network        │
└──────────┬──────────────────────┬───────────────────────┘
           │                      │
  ┌────────▼────────┐    ┌───────▼────────┐
  │  DAT Files       │    │  ACE Server     │
  │  (D:\ACE\Dats)   │    │  (D:\ACE\Server)│
  │                  │    │                 │
  │  • Terrain       │    │  Reads from:    │
  │    (LandBlock)   │    │  • ace_world DB │
  │  • Buildings     │    │  • DAT files    │
  │    (LandBlockInfo│    │    (D:\ACE\Dats) │
  │     + EnvCells)  │    │                 │
  └────────▲────────┘    └───────▲────────┘
           │                      │
  ┌────────┴────────┐    ┌───────┴────────┐
  │  WorldBuilder    │    │  MariaDB        │
  │  export command  │    │  ace_world DB   │
  │                  │    │  landblock_     │
  │  Writes DATs to  │    │  instance table │
  │  D:\ACE\Dats     │    │                 │
  └─────────────────┘    └────────────────┘
```

> [!IMPORTANT]
> The **client reads buildings from DAT files** but **NPCs/objects come from the ACE server's database**. These are completely separate systems. A building can be visible in the client but have no NPCs inside it if the database instances weren't updated. Conversely, NPCs can exist at positions where no building is rendered if the DAT export was wrong.

---

## 2. Layer 1: Terrain

### What It Is
Each landblock (192×192 meter tile) has an **81-vertex heightmap** (9×9 grid, 24m spacing) stored in `client_cell_1.dat`. Each vertex has:
- **Height index** (byte 0-255) → mapped to world Z via `Region.LandDefs.LandHeightTable`
- **Terrain type** (byte) — grass, rock, sand, snow, etc.
- **Road** (byte) — road overlay value
- **Scenery** (byte) — auto-placed scenery group

### How It Gets Exported

**Source**: [Project.cs ExportDats()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Models/Project.cs#L138-L370)

1. Base DATs from `vanquishtest/dats/base/` are **copied** to the export directory (`D:\ACE\Dats`).
2. For each landblock with terrain modifications in the `TerrainDocument`:
   - Layer compositing resolves per-vertex field overrides (height, type, road, scenery).
   - The composited terrain is written into the copied `client_cell_1.dat` via `DatReaderWriter`.
3. LandBlock entries use ID format `0xXXYYFFFF` where `XX` = lbX, `YY` = lbY.

### Where Terrain Comes From
- **Base terrain**: `vanquishtest/dats/base/client_cell_1.dat` (the Vanquish procedural terrain, or retail Dereth terrain)
- **Project modifications**: Stored in `vanquishtest/project.db` (SQLite) via the `TerrainDocument`/`LayerDocument` system
- Modifications are made by commands like `remap-buildings-v2 --flatten` which sets terrain height under building footprints

> [!WARNING]
> If the `vanquishtest/dats/base/` contains **retail** Dereth terrain (from `vanquishdat/client_cell_1.dat`) but the terrain document has been cleared, export will produce retail terrain. This was the intended behavior in recent runs — **do NOT re-add project terrain modifications** unless you want to override the base terrain.

---

## 3. Layer 2: Buildings & EnvCells

### The Dual Nature of Buildings
In Asheron's Call, a "building" is actually **two things**:

1. **Exterior Model** (the visible shell): Stored as a `BuildingInfo` entry in `LandBlockInfo` (`0xXXYYFFFE`). Contains:
   - `ModelId` (e.g., `0x02001234`) — the 3D model to render
   - `Frame` (position + orientation) — where to draw it
   - `Portals` — doorway connection points from exterior → interior EnvCells
   - `NumLeaves` — BSP tree leaf count

2. **Interior Rooms** (EnvCells): Stored as individual entries in `client_cell_1.dat` with IDs `0xXXYY0100` through `0xXXYYFFFD`. Each EnvCell contains:
   - `Position` (Frame with origin + orientation) — room position in landblock-local space
   - `EnvironmentId` + `CellStructure` — which 3D room template to use
   - `CellPortals` — connections to adjacent EnvCells (doorways between rooms)
   - `VisibleCells` — list of cells visible from this cell (includes LandCells `0x0001-0x0040` for outdoor visibility)
   - `StaticObjects` — furniture, decorations inside the room
   - `Surfaces` — textures/materials on walls

### How Buildings Get Into DATs

**Source**: [LandblockDocument.SaveToDatsInternal()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Documents/LandblockDocument.cs#L98-L248)

During `export`, for each landblock that has a `LandblockDocument`:

1. **Match existing buildings**: Each `StaticObject` in the document is compared to existing `BuildingInfo` entries in the DAT by `ModelId` + closest position. Matched buildings get their `Frame` updated.

2. **Detect new buildings**: Unmatched `StaticObjects` are checked via `BuildingBlueprintCache.IsBuildingModelId()`. If it's a known building model:
   - A **blueprint** is extracted from a "donor" instance (same `ModelId` found elsewhere in the base DATs)
   - `InstantiateBlueprint()` creates new EnvCells with remapped cell IDs, writing them directly to the export DAT
   - A new `BuildingInfo` is generated with proper portal connections
   - `NumCells` on the `LandBlockInfo` is incremented

3. **Non-building objects** (trees, decorations) become `Stab` entries in `LandBlockInfo.Objects`

**Source**: [BuildingBlueprintCache.InstantiateBlueprint()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Lib/BuildingBlueprintCache.cs#L294-L453)

### The Blueprint System

When a building is placed at a new location, the system needs to create its interior rooms. Since room geometry is defined by `EnvironmentId` + `CellStructure` templates (not freeform), the system:

1. Finds a **donor** — an existing instance of the same `ModelId` in the base DATs
2. **Extracts** all EnvCells belonging to that donor (BFS through portal graph)
3. Stores positions **relative to the donor's origin** (in donor-local coordinates)
4. During instantiation, rotates/translates these relative positions to the new building origin
5. Assigns **new cell IDs** starting from `currentNumCells + 0x0100`
6. **Remaps all portal references** (CellPortals, VisibleCells, BuildingPortals) to use new cell IDs
7. Fixes up **LandCell references** (`0x0001-0x0040`) in VisibleCells based on the outdoor cell grid position delta between donor and new position

> [!CAUTION]
> **Pre-extraction is critical**: During export, source landblock documents are processed in arbitrary order. If the source landblock (where buildings were cleared) is processed BEFORE the destination landblock, the donor building gets deleted from the export DAT before the destination can use it. The export code pre-extracts all blueprints from the **read-only base DATs** (line 280-303 in [Project.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Models/Project.cs#L280-L303)) to prevent this race condition.

### `NumCells` — The Silent Killer

`LandBlockInfo.NumCells` tells the engine how many EnvCells exist in a landblock. If this number is **wrong**:
- **Too low**: Some EnvCells won't be loaded → missing rooms, walk-through walls
- **Too high**: The engine looks for cells that don't exist → crashes or undefined behavior

The system tracks `NumCells` by:
- Starting with the original value from the base DAT
- Subtracting cells when buildings are deleted
- Adding cells when new buildings are instantiated via blueprint

---

## 4. Layer 3: NPC/Object Instances

### What They Are
NPCs, vendors, portals, and interactive objects are stored in the **ACE MySQL database** (`ace_world.landblock_instance` table), NOT in DAT files. Each instance has:

```sql
-- Key columns in landblock_instance:
guid            -- unique instance ID
weenie_Class_Id  -- what kind of object (NPC type, vendor type, etc.)
obj_Cell_Id     -- WHERE the object is: 0xXXYYCCCC
                 -- XX = landblock X, YY = landblock Y
                 -- CCCC = cell ID (0x0001-0x0040 = outdoor, 0x0100-0xFFFD = interior)
origin_X, origin_Y, origin_Z  -- position within the cell
```

### The Critical `obj_Cell_Id` Field

This is the **single most important field** for correct NPC placement:

- **Outdoor cells** (`0x0001-0x0040`): NPCs standing outside. The cell ID encodes which 24×24m outdoor cell they're in. `origin_X/Y` is in landblock-local coordinates (0-192).
- **Interior cells** (`0x0100-0xFFFD`): NPCs inside buildings. The cell ID **must match** an existing EnvCell in the DAT file. If the EnvCell doesn't exist at that cell ID, the NPC has nowhere to stand and will either not spawn or fall through the world.

> [!IMPORTANT]
> When buildings are remapped from retail landblocks to Vanquish landblocks, the **EnvCell IDs change**. A room that was `0xAABB0105` in retail might become `0xCCDD0100` in the Vanquish DATs. The `remap-buildings-sql` command generates SQL to update `obj_Cell_Id` values to match the new cell IDs.

### The Z-Height Problem ("NPCs Falling From Sky")

NPCs have an `origin_Z` that must match the **actual ground/floor height** at their position. There are two distinct scenarios:

1. **Outdoor NPCs**: Z must match the terrain height at `(origin_X, origin_Y)` in the current terrain DAT. If terrain was modified (flattened, raised, etc.), the `ace-db reposition` command recalculates Z values using `TerrainHeightSampler.SampleHeightTriangle()`.

2. **Interior NPCs**: Z is relative to the EnvCell's coordinate system. When buildings are remapped, the building's `Frame.Origin.Z` changes (because Vanquish terrain has different heights than retail). The `remap-buildings-sql` command computes a `deltaZ` by comparing the Z-origin of the first EnvCell in the old vs new buildings, then adds this delta to every interior instance's `origin_Z`.

**Source**: [CommandEngine.GenerateBuildingRemapSql()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Terminal/CommandEngine.cs#L6294-L6518) — lines 6399-6411 compute `deltaZ`

---

## 5. The Full Pipeline — Step by Step

### Pipeline Commands (in order)

```
1. clear-objects --all            Remove all StaticObjects from project LandblockDocuments
2. remap-buildings-v2 <json>      Copy buildings from retail LBs to Vanquish LBs as StaticObjects
3. export D:\ACE\Dats             Export DATs (terrain + buildings with EnvCells)
4. remap-buildings-sql <json> ... Generate + apply SQL to remap interior obj_Cell_Id values
5. ace-db reposition              Reposition outdoor instances to match new terrain heights
```

### Step-by-Step Detail

#### Step 1: `clear-objects --all`
Iterates all 255×255 landblocks. For each one with a `LandBlockInfo`, clears all `StaticObjects` from the `LandblockDocument`. This ensures a clean slate — no leftover buildings from previous runs.

#### Step 2: `remap-buildings-v2 <lb_remap.json>`
**Source**: [CommandEngine.RemapBuildingsV2()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Terminal/CommandEngine.cs#L5946-L6196)

1. Loads `lb_remap.json` which maps `"oldX,oldY"` → `"newX,newY"` (e.g., `"170,180"` → `"124,242"`)
2. For each remap entry:
   - Reads `LandBlockInfo` from the **base DAT** (read-only) for the source (retail) landblock
   - Computes `deltaZ = vanquishTerrainZ - minBuildingZ` to adjust building heights to Vanquish terrain
   - For each `Building` and `Object` (Stab) in the source:
     - Creates a `StaticObject` in the **destination** `LandblockDocument`
     - Position = destination LB origin + source local offset + Z delta
   - Optionally flattens terrain under each building position (within `flattenRadius`)
3. Saves `building_old_cells.json` — maps each building to its original EnvCell IDs for the SQL step
4. Does NOT touch DAT files — only modifies the project database

> [!WARNING]
> **Position format**: `remap-buildings-v2` stores building origins as **world coordinates** in StaticObjects (`lbX * 192 + localX, lbY * 192 + localY`). During export, `LandblockDocument.SaveToDatsInternal()` calls `ReverseOffset()` to convert back to landblock-local coordinates before writing to DAT.

#### Step 3: `export D:\ACE\Dats`
**Source**: [Project.ExportDats()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Models/Project.cs#L138-L370)

1. Copies base DATs (`vanquishtest/dats/base/*.dat`) → `D:\ACE\Dats/`
2. Opens the copy for read-write
3. Writes terrain modifications (height, type, road, scenery) to `LandBlock` entries
4. **Pre-extracts all building blueprints** from base DATs (prevents donor-deletion race)
5. For each `LandblockDocument`:
   - Calls `SaveToDatsInternal()` which:
     - Matches `StaticObjects` to existing `BuildingInfo` entries (preserving portal/cell data)
     - Instantiates new buildings via `BuildingBlueprintCache.InstantiateBlueprint()`
     - Creates new EnvCells in the DAT with remapped cell IDs
     - Writes non-building objects as `Stab` entries
     - Saves the `LandBlockInfo`
   - Releases the document from cache (memory management)
6. Processes `DungeonDocument`s and `PortalDatDocument`s
7. Writes custom textures and updates `Region`

#### Step 4: `remap-buildings-sql <lb_remap.json> D:\ACE\Dats building_remap_v2.sql --apply`
**Source**: [CommandEngine.GenerateBuildingRemapSql()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Terminal/CommandEngine.cs#L6294-L6518)

This is the **critical bridge** between DAT buildings and database instances:

1. Opens **both** the retail base DATs and the exported DATs
2. For each remapped landblock:
   - Collects old building EnvCell IDs from retail DATs (BFS through portal graph)
   - Finds matching building in exported DATs (by `ModelId`)
   - Collects new EnvCell IDs from exported DATs
   - Maps old cell IDs → new cell IDs by matching `(EnvironmentId, CellStructure)` pairs
   - Computes `deltaZ` from old/new first EnvCell Z-origins
3. Generates SQL:
   ```sql
   UPDATE `landblock_instance` SET `obj_Cell_Id` = <newFullCellId>,
     `origin_Z` = `origin_Z` + <deltaZ>
   WHERE `obj_Cell_Id` = <oldFullCellId>;
   ```
4. If `--apply` is specified, executes the SQL directly against MariaDB

> [!CAUTION]
> **Cell count mismatch**: If the export produced a different number of EnvCells than the retail building had (e.g., due to blueprint extraction issues), the SQL step will warn about mismatches. Some cell mappings may be lost, meaning NPCs in those rooms won't be remapped → they'll reference nonexistent cells → **NPCs disappear or fall from sky**.

#### Step 5: `ace-db reposition`
**Source**: [InstanceRepositionService.RunAsync()](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Lib/AceDb/InstanceRepositionService.cs#L32-L67)

For **outdoor** instances only (cell ID `0x0001-0x0040`):
1. Queries `landblock_instance` table for all instances in modified landblocks
2. For each outdoor instance:
   - Samples **old terrain height** at `(origin_X, origin_Y)` using the base DAT terrain
   - Samples **new terrain height** at the same position using the current terrain
   - Computes `delta = newZ - oldZ`
   - If `abs(delta) > threshold`: generates `UPDATE origin_Z = origin_Z + delta`
3. Applies SQL to database

---

## 6. Critical Files & Their Roles

### Project Files
| File | Purpose |
|------|---------|
| [vanquishtest/vanquishtest.wbproj](file:///d:/Clones/WorldBuilder-ACME-Edition-master/vanquishtest/vanquishtest.wbproj) | Project definition (JSON). Contains `AceDb` connection settings. |
| `vanquishtest/project.db` | SQLite database storing all document states (terrain mods, placed objects) |
| `vanquishtest/dats/base/client_cell_1.dat` | Base terrain + buildings DAT (≈350MB). **Read-only** during export. |
| `vanquishtest/dats/base/client_portal.dat` | Base portal DAT (≈900MB). Models, textures, game data. |
| `vanquishtest/building_old_cells.json` | Maps each remapped building to its original retail EnvCell IDs |

### Export/Runtime Files
| File | Purpose |
|------|---------|
| `D:\ACE\Dats\client_cell_1.dat` | **Exported** DAT read by both client and server. Contains modified terrain + new building EnvCells. |
| `D:\ACE\Dats\client_portal.dat` | Copied from base. Models/textures. |
| `building_remap_v2.sql` | SQL statements to remap interior `obj_Cell_Id` values |

### Pipeline Input Files
| File | Purpose |
|------|---------|
| [population_output/lb_remap.json](file:///d:/Clones/WorldBuilder-ACME-Edition-master/population_output/lb_remap.json) | Maps `"oldX,oldY"` → `"newX,newY"` for building relocation |
| [population_output/town_placements.json](file:///d:/Clones/WorldBuilder-ACME-Edition-master/population_output/town_placements.json) | 58 town positions on Vanquish map (`lbX`, `lbY`) |
| [scripts/build_remap_from_placements.py](file:///d:/Clones/WorldBuilder-ACME-Edition-master/scripts/build_remap_from_placements.py) | Generates `lb_remap.json` from town placements + retail building positions |

### Source Code Files
| File | Key Functions |
|------|--------------|
| [CommandEngine.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Terminal/CommandEngine.cs) | `RemapBuildingsV2()` (L5946), `GenerateBuildingRemapSql()` (L6294), `Export()` (L62) |
| [LandblockDocument.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Documents/LandblockDocument.cs) | `SaveToDatsInternal()` (L98) — converts StaticObjects → BuildingInfo + EnvCells |
| [BuildingBlueprintCache.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Lib/BuildingBlueprintCache.cs) | `GetBlueprint()`, `InstantiateBlueprint()` — creates EnvCells for new buildings |
| [Project.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Models/Project.cs) | `ExportDats()` (L138) — full export pipeline including pre-extraction |
| [InstanceRepositionService.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Shared/Lib/AceDb/InstanceRepositionService.cs) | `RunAsync()` — outdoor instance Z repositioning |
| [HeadlessProjectManager.cs](file:///d:/Clones/WorldBuilder-ACME-Edition-master/WorldBuilder.Terminal/HeadlessProjectManager.cs) | Wires up project loading for terminal mode |

---

## 7. Common Failure Modes & Root Causes

### ❌ Buildings Not Visible (Invisible Buildings)

**Symptom**: You teleport to a town and see flat terrain but no buildings.

**Root Causes**:
1. **No `LandBlockInfo` in exported DAT**: The `export` step didn't write a `LandBlockInfo` for the destination landblock. Check that:
   - The `LandblockDocument` for the destination LB was created and has `StaticObjects`
   - `SaveToDatsInternal()` was called (check export logs for `[LBDoc] Saving landblock 0xXXXX`)
   - The export directory (`D:\ACE\Dats`) has the updated `client_cell_1.dat`

2. **`NumCells` mismatch**: If `NumCells` on the `LandBlockInfo` is wrong, some cells may fail to load. The engine uses `NumCells` to determine the valid cell ID range.

3. **Blueprint extraction failed**: If `GetBlueprint()` returned null for a building model, it falls back to being added as a regular `Stab` (exterior object only, no interior). Check logs for `[Blueprint] No donor instance found for building model 0x...`. This means the base DATs don't contain any instance of that building model.

4. **Pre-extraction race condition**: If the pre-extraction step (L280-303 in Project.cs) was bypassed, donor buildings may have been deleted from the export DAT before destination landblocks could use them. The export writes source LBs (with cleared objects) before destination LBs → donor deleted → `GetBlueprint()` fails silently on the export DAT.

5. **Client DAT mismatch**: The client reads DATs from the path in its **Windows Registry** (`DatFilesDirectory`). If the registry points to different DATs than what was exported, the client sees stale data. Verify:
   ```
   HKCU\SOFTWARE\Microsoft\Microsoft Games\Asheron's Call\DatFilesDirectory = D:\Asheron's Call\
   ```
   And ensure `D:\Asheron's Call\client_cell_1.dat` is what was exported (or is the same as `D:\ACE\Dats\client_cell_1.dat`).

### ❌ NPCs Falling From Sky

**Symptom**: NPCs spawn at the correct X/Y but at a wildly wrong Z, falling through terrain or floating in the air.

**Root Causes**:
1. **`ace-db reposition` not run**: Outdoor NPCs still have retail Z heights. Vanquish terrain is at different elevation → NPCs spawn at retail Z while terrain is at Vanquish Z.

2. **`remap-buildings-sql` not run**: Interior NPCs still reference retail cell IDs. If the cell ID doesn't exist in the new DAT, the ACE server can't determine the floor position.

3. **`deltaZ` calculation wrong in `remap-buildings-sql`**: The delta is computed from the Z-origin of the first EnvCell in old vs new buildings (L6399-6411 in CommandEngine.cs). If cells are matched incorrectly (wrong `(EnvironmentId, CellStructure)` pair), the delta could be wrong.

4. **Terrain flattening mismatch**: `remap-buildings-v2` flattens terrain to `vanquishZ` (sampled at LB center), but actual building Z = `original_Z + (vanquishZ - minRetailZ)`. If the terrain isn't flat enough or the sample point is wrong, there's a Z gap.

### ❌ NPCs Missing Entirely

**Symptom**: You enter a building and there are no NPCs, vendors, or portals inside.

**Root Causes**:
1. **`remap-buildings-sql` not run or failed**: Interior instance `obj_Cell_Id` still points to old retail cell IDs → ACE server can't find the cell in the current DATs → instance not spawned.

2. **Cell count mismatch**: Building had N cells in retail but only M < N cells in export → (N - M) cells have no mapping → instances in those rooms lost.

3. **ACE server needs restart**: The ACE server caches landblock data. After modifying the database and DATs, you **must restart the server** for changes to take effect. Simply relogging the client is not sufficient.

4. **Mega-structure filtering**: The script `build_remap_from_placements.py` skips 6 specific large dungeon/apartment building models to prevent crashes. NPCs inside these structures won't be remapped. This is intentional — these are accessed via portals and don't need outdoor placement.

### ❌ Walk-Through Walls / Missing Portals

**Symptom**: Building interiors exist but you can walk through walls, or doorways don't work.

**Root Causes**:
1. **Stale `VisibleCells` LandCell references**: When a building moves across outdoor cell boundaries (24m grid), the LandCell references in `VisibleCells` must be adjusted. Both `InstantiateBlueprint()` and `MoveBuildingEnvCells()` perform this fixup, but if it fails (e.g., cell coordinates clamped to 0-7 range), portals break.

2. **`CellPortal` references not remapped**: All `OtherCellId` values in `CellPortals` must point to valid EnvCell IDs in the new landblock. If the remap table is incomplete, portals point to nonexistent cells.

### ❌ ACE Server Crash on Login

**Symptom**: Server crashes or hangs when a player enters a landblock with remapped buildings.

**Root Causes**:
1. **`NumCells` too high**: Server tries to load cell IDs that don't exist in the DAT.
2. **Circular portal references**: BFS traversal of building cells enters an infinite loop.
3. **Missing EnvCell data**: A cell ID referenced by a `BuildingPortal` or `CellPortal` doesn't exist in the DAT.

---

## 8. Coordinate Systems

### World Coordinates
- **Origin**: (0, 0, 0) is the southwest corner of landblock (0, 0)
- **X**: Increases eastward (each landblock = 192m)
- **Y**: Increases northward (each landblock = 192m)
- **Z**: Altitude (determined by terrain heightmap or EnvCell position)
- **Range**: 0 to 255×192 = 48,960 meters in each horizontal direction

### Landblock Coordinates
- **lbKey**: 16-bit value `(lbX << 8) | lbY`
- **Full cell ID**: 32-bit `(lbKey << 16) | cellId`
  - `0xXXYYFFFF` = LandBlock (terrain)
  - `0xXXYYFFFE` = LandBlockInfo (objects + buildings)
  - `0xXXYY0001-0040` = Outdoor LandCells (8×8 grid, 24m each)
  - `0xXXYY0100-FFFD` = Interior EnvCells (building rooms)

### AC Map Coordinates (for `/tele`)
```
NS = 0.8 * lbY - 102.4   (positive = North, negative = South)
EW = 0.8 * lbX - 102.4   (positive = East, negative = West)
```
Format: `/tele 42.1N 33.6E`

### Landblock-Local Coordinates
- Used inside `LandBlockInfo` for building positions
- Range: 0.0 to 192.0 for X and Y
- **WorldToLocal**: `localX = worldX - lbX * 192`, `localY = worldY - lbY * 192`
- **LocalToWorld**: `worldX = lbX * 192 + localX`, `worldY = lbY * 192 + localY`

> [!IMPORTANT]
> `remap-buildings-v2` stores positions as **world coordinates** in StaticObjects. `SaveToDatsInternal()` uses `ReverseOffset()` to convert back to local. If you see positions like (23808.0, 46464.0, 30.5), those are world coords for LB (124, 242).

---

## 9. DAT File Structure Reference

### LandBlock (`0xXXYYFFFF`)
```
- Terrain[81]    — 9×9 grid of terrain vertices
- Height[81]     — height index for each vertex
```

### LandBlockInfo (`0xXXYYFFFE`)
```
- NumCells       — count of EnvCells in this landblock
- Objects[]      — Stab entries (trees, decorations, exterior elements)
  - Id           — model/setup ID
  - Frame        — position + orientation (landblock-local)
- Buildings[]    — BuildingInfo entries
  - ModelId      — exterior model ID
  - NumLeaves    — BSP leaf count
  - Frame        — position + orientation (landblock-local)
  - Portals[]    — BuildingPortal (exterior → interior doorways)
    - OtherCellId   — which EnvCell the doorway leads to
    - StabList[]    — additional cell visibility references
```

### EnvCell (`0xXXYY0100-FFFD`)
```
- Flags          — bitfield (HasStaticObjs, HasRestrictionObj, etc.)
- Position       — Frame with origin + orientation
- Surfaces[]     — texture/material references
- EnvironmentId  — which room shape template
- CellStructure  — which variant of the template
- CellPortals[]  — doorways to other EnvCells
  - OtherCellId  — adjacent cell
  - PolygonId    — which wall polygon is the doorway
- VisibleCells[] — cells visible from here (EnvCells + outdoor LandCells)
- StaticObjects[]— furniture, decorations inside the room
```

---

## 10. Debugging Checklist

When something goes wrong, work through this checklist:

### Before Running the Pipeline
- [ ] Is the project loaded? (`load vanquishtest/vanquishtest.wbproj`)
- [ ] Are `ace-db` settings configured? (`ace-db status`)
- [ ] Does `lb_remap.json` exist and have entries? (`population_output/lb_remap.json`)
- [ ] Were objects cleared? (`clear-objects --all`)

### After `remap-buildings-v2`
- [ ] Check console output: "Added X buildings from Y landblocks"
- [ ] Check `building_old_cells.json` was created in `vanquishtest/`
- [ ] Verify Z delta range is reasonable (typically -50 to +50)

### After `export`
- [ ] Check export directory has updated `client_cell_1.dat`
- [ ] Compare file sizes: exported DAT should be **larger** than base DAT (new EnvCells added)
- [ ] Check console for `[LBDoc]` messages — each destination LB should show buildings + cells
- [ ] Look for warnings: "No blueprint found", "FAILED to save"

### After `remap-buildings-sql`
- [ ] Check "Matched X buildings, Y cell ID remaps" — Y should be in the thousands
- [ ] Check for cell count mismatch warnings
- [ ] Verify SQL was applied if `--apply` was used

### After `ace-db reposition`
- [ ] Check "X/Y instances updated" — should be non-zero for modified landblocks

### In-Game Verification
- [ ] **Restart ACE server** after all pipeline commands
- [ ] Teleport to a town center and verify buildings are visible
- [ ] Enter a building and verify NPCs are present and standing on the floor
- [ ] Check that outdoor NPCs are at ground level, not floating

### Registry / Client Config
- [ ] Client `DatFilesDirectory` registry key points to correct folder
- [ ] ACE server `Config.js` `DatFilesDirectory` points to `D:\ACE\Dats\`
- [ ] Both client and server are reading the **same** DAT files (or equivalent exports)

---

## Environment Details

| Component | Path / Value |
|-----------|-------------|
| **WorldBuilder Project** | `d:\Clones\WorldBuilder-ACME-Edition-master\vanquishtest\vanquishtest.wbproj` |
| **Base DATs** | `vanquishtest\dats\base\` |
| **Export Target** | `D:\ACE\Dats\` |
| **ACE Server** | `D:\ACE\Server\ACE.Server.exe` |
| **AC Client** | `D:\Asheron's Call\acclient.exe` |
| **MariaDB** | `C:\Program Files\MariaDB 12.2\bin\mysql.exe` (root/baltic) |
| **Database** | `ace_world` (instances), `ace_auth` (accounts) |
| **Terminal Build** | `dotnet run --project WorldBuilder.Terminal -- --project vanquishtest/vanquishtest.wbproj` |

### Key Mega-Structure Model IDs (SKIP in remap)
```
0x01002BEF  — Apartment/housing block (2426 cells, 15 copies)
0x01003414  — Large dungeon storage (852 cells, 2 copies)
0x010029E2  — Large dungeon storage (749 cells, 4 copies)
0x01003D00  — Large dungeon storage (712 cells, 4 copies)
0x01004031  — Large dungeon storage (650 cells, 7 copies)
0x010045CD  — Large dungeon storage (208 cells, 1 copy)
```

These are filtered by `build_remap_from_placements.py` because moving them caused cell count mismatches and server crashes. They are accessed via in-game portals and don't need outdoor positioning.

---

## 11. Worked Example: Finding Holtburg's Buildings in the DATs

This section walks through a **concrete example** — Holtburg — showing exactly how to locate building data in the DAT files, what IDs to look up, and how the retail → Vanquish mapping works.

### Holtburg's Position

| | Landblock (lbX, lbY) | lbKey (hex) | AC Map Coords |
|---|---|---|---|
| **Retail Dereth** | (170, 180) | `0xAAB4` | 42.1N, 33.6E |
| **Vanquish World** | (124, 242) | `0x7CF2` | 91.2N, -3.2E |

Holtburg is not contained in a single landblock. Its buildings span a **cluster of ~7 landblocks** around the center point, roughly (167-173, 177-183) in retail, remapped to (121-127, 239-245) in Vanquish.

### How to Find the Buildings

#### Step 1: Look Up the LandBlockInfo

Every building exists inside a `LandBlockInfo` entry in `client_cell_1.dat`. The ID format is:

```
LandBlockInfo ID = (lbX << 24) | (lbY << 16) | 0xFFFE
```

For Holtburg's main landblock (retail):
```
Retail:   0xAAB4FFFE    ← LandBlockInfo for (170, 180)
Vanquish: 0x7BF2FFFE    ← remapped to (123, 242) — note: most of the buildings ended up here
```

To read it in code (C#):
```csharp
// Using DatReaderWriter
uint lbiId = 0x7BF2FFFE; // Vanquish Holtburg main LB
if (dats.TryGet<LandBlockInfo>(lbiId, out var lbi)) {
    Console.WriteLine($"Objects: {lbi.Objects.Count}");  // trees, decorations
    Console.WriteLine($"Buildings: {lbi.Buildings.Count}"); // building shells
    Console.WriteLine($"NumCells: {lbi.NumCells}"); // total interior rooms

    foreach (var b in lbi.Buildings) {
        Console.WriteLine($"  ModelId=0x{b.ModelId:X8} pos=({b.Frame.Origin.X:F1},{b.Frame.Origin.Y:F1},{b.Frame.Origin.Z:F1})");
    }
}
```

#### Step 2: Understand the Building → EnvCell Relationship

Each building in `lbi.Buildings` has **Portals** that connect the exterior to interior **EnvCells**. For Holtburg, the densest landblock is `(169,180) = 0xA9B4` in retail, which maps to `(123,242) = 0x7BF2` in Vanquish. This single LB contains **12 buildings** with a total of ~118 EnvCells:

| Building Key | ModelId | Interior Rooms | Notes |
|---|---|---|---|
| `A9B4_0` | `0x01000C1E` | 17 cells | Large building (tavern/inn) |
| `A9B4_1` | `0x01000BC3` | 5 cells | Small cottage |
| `A9B4_2` | `0x0100082E` | 9 cells | Medium building |
| `A9B4_3` | `0x01000830` | 8 cells | Medium building |
| `A9B4_4` | `0x01000827` | 17 cells | Large building |
| `A9B4_5` | `0x0100081C` | 7 cells | Medium building |
| `A9B4_6` | `0x01000A2B` | 18 cells | Large building |
| `A9B4_7` | `0x01000C17` | 25 cells | Large multi-room building |
| `A9B4_8` | `0x01000BC3` | 5 cells | Small cottage (duplicate model) |
| `A9B4_9` | `0x01002232` | 7 cells | Medium building |
| `A9B4_10` | `0x01002A1B` | 3 cells | Small structure |
| `A9B4_11` | `0x01000F69` | 2 cells | Very small (outhouse/shed) |

#### Step 3: Find the Actual EnvCells

In the **retail** DATs, the EnvCells for Holtburg's main LB are at:
```
0xA9B40100  ← first EnvCell (room in building A9B4_0)
0xA9B40101  ← second room
  ...
0xA9B4017A  ← last EnvCell (room in building A9B4_11)
```

In the **exported Vanquish** DATs, these have been **remapped** to new cell IDs under the destination landblock:
```
0x7BF20100  ← first EnvCell in Vanquish Holtburg
0x7BF20101  ← second room
  ...
```

The cell IDs are assigned sequentially by `InstantiateBlueprint()` starting from `NumCells + 0x0100`. The exact new IDs depend on the order buildings were processed during export.

To read an EnvCell in code:
```csharp
uint cellId = 0x7BF20100; // First room in Vanquish Holtburg
if (dats.TryGet<EnvCell>(cellId, out var envCell)) {
    Console.WriteLine($"EnvironmentId: 0x{envCell.EnvironmentId:X4}");
    Console.WriteLine($"Position: ({envCell.Position.Origin.X:F1},{envCell.Position.Origin.Y:F1},{envCell.Position.Origin.Z:F1})");
    Console.WriteLine($"Portals: {envCell.CellPortals.Count}");
    Console.WriteLine($"Visible cells: {envCell.VisibleCells.Count}");
    Console.WriteLine($"Furniture: {envCell.StaticObjects.Count}");
}
```

#### Step 4: Find NPCs in the Database

Interior NPCs reference EnvCells by their full 32-bit `obj_Cell_Id`. After `remap-buildings-sql`, they should point to the Vanquish cell IDs:

```sql
-- Find all instances inside Holtburg buildings (Vanquish)
-- LB (123,242) = high bytes 0x7BF2, interior cells start at 0x0100
SELECT guid, weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y, origin_Z
FROM ace_world.landblock_instance
WHERE obj_Cell_Id >= 0x7BF20100 AND obj_Cell_Id <= 0x7BF2FFFD;

-- Find outdoor instances in Holtburg (Vanquish)
-- Outdoor cells are 0x0001-0x0040
SELECT guid, weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y, origin_Z
FROM ace_world.landblock_instance
WHERE obj_Cell_Id >= 0x7BF20001 AND obj_Cell_Id <= 0x7BF20040;
```

### Full Holtburg Landblock Map

The complete cluster of landblocks that make up Holtburg on Vanquish:

```
Retail (lbX,lbY)  →  Vanquish (lbX,lbY)  │ Retail LBI      │ Vanquish LBI    │ Buildings
──────────────────────────────────────────┼─────────────────┼─────────────────┼──────────
(167,179) → (121,241)                     │ 0xA7B3FFFE      │ 0x79F1FFFE      │ 1 (5 cells)
(167,180) → (121,242)                     │ 0xA7B4FFFE      │ 0x79F2FFFE      │ 2 (5+0 cells)
(168,178) → (122,240)                     │ 0xA8B2FFFE      │ 0x7AF0FFFE      │ 1 (5 cells)
(169,178) → (123,240)                     │ 0xA9B2FFFE      │ 0x7BF0FFFE      │ 2 (0+25 cells)
(169,179) → (123,241)                     │ 0xA9B3FFFE      │ 0x7BF1FFFE      │ 1 (17 cells)
(169,180) → (123,242)                     │ 0xA9B4FFFE      │ 0x7BF2FFFE      │ 12 (118 cells) ★ densest
(170,179) → (124,241)                     │ 0xAAB3FFFE      │ 0x7CF1FFFE      │ 2 (7+4 cells)
(170,181) → (124,243)                     │ 0xAAB5FFFE      │ 0x7CF3FFFE      │ 1 (1 cell)
(171,179) → (125,241)                     │ 0xABB3FFFE      │ 0x7DF1FFFE      │ 1 (5 cells)
(172,183) → (126,245)                     │ 0xACB7FFFE      │ 0x7EF5FFFE      │ 1 (5 cells)
(173,178) → (127,240)                     │ 0xADB2FFFE      │ 0x7FF0FFFE      │ 1 (5 cells)
(173,182) → (127,244)                     │ 0xADB6FFFE      │ 0x7FF4FFFE      │ 1 (5 cells)
(173,183) → (127,245)                     │ 0xADB7FFFE      │ 0x7FF5FFFE      │ 1 (7 cells)
```

> [!TIP]
> To teleport to Vanquish Holtburg in-game: `/tele 91.2N, -3.2E`
> Or by landblock: `/teleloc 0x7CF20101 84 84 0`

### How to Verify Buildings Are Working

1. **Check DAT has the LandBlockInfo**:
   Open the exported DAT and verify `0x7BF2FFFE` exists and has buildings
2. **Check DAT has EnvCells**:
   Verify `0x7BF20100` through the expected range exist
3. **Check database has remapped instances**:
   Run the SQL above — you should see NPCs with `obj_Cell_Id` in the `0x7BF2xxxx` range
4. **In-game**:
   - Buildings visible? → DAT export worked (LandBlockInfo + BuildingInfo written)
   - Doors work? → EnvCells exist and portal references are correct
   - NPCs inside? → Database `obj_Cell_Id` was remapped and `origin_Z` adjusted
   - NPCs on floor (not floating)? → `deltaZ` computation was correct

