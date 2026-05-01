# WorldBuilder.Terminal — Agent API Reference

> **Protocol version:** 1.2  
> **Transport:** stdin/stdout, one JSON object per line  
> **Startup:** `WorldBuilder.Terminal --stdin [--project <path>]`

---

## Table of Contents

- [Protocol Overview](#protocol-overview)
- [Startup & Modes](#startup--modes)
- [Command Index](#command-index)
- [Project Management](#project-management)
  - [load](#load)
  - [export](#export)
  - [info](#info)
- [Terrain Editing](#terrain-editing)
  - [smooth](#smooth)
  - [raise](#raise)
  - [lower](#lower)
  - [set-height](#set-height)
  - [paint](#paint)
  - [fill](#fill)
  - [road](#road)
- [Terrain Queries](#terrain-queries)
  - [get-height](#get-height)
  - [terrain-info](#terrain-info)
  - [get-heightmap](#get-heightmap)
  - [get-terrain-data](#get-terrain-data)
- [Object Management](#object-management)
  - [list-objects](#list-objects)
  - [add-object](#add-object)
  - [remove-object](#remove-object)
  - [move-object](#move-object)
  - [rotate-object](#rotate-object)
- [Spatial Queries](#spatial-queries)
  - [query-radius](#query-radius)
- [Dungeon Tools](#dungeon-tools)
  - [analyze-dungeons](#analyze-dungeons)
  - [get-dungeon-info](#get-dungeon-info)
- [Validation](#validation)
  - [validate-dungeon](#validate-dungeon)
  - [validate-landblock](#validate-landblock)
  - [validate-terrain](#validate-terrain)
  - [validate-building-portals](#validate-building-portals)
  - [validate-all](#validate-all)
- [Transact](#transact)
  - [transact](#transact-1)
  - [transact-diff](#transact-diff)
- [World Observation](#world-observation)
  - [list-landblocks](#list-landblocks)
  - [get-world-info](#get-world-info)
  - [get-region](#get-region)
- [Control](#control)
  - [help](#help)
  - [quit / exit](#quit--exit)
- [Coordinate System Reference](#coordinate-system-reference)
- [Validation Diagnostic Codes](#validation-diagnostic-codes)

---

## Protocol Overview

### Connection

The agent spawns the terminal process and communicates via piped stdio:

```
Agent Process                       WorldBuilder.Terminal
    │                                       │
    │  spawn: --stdin [--project X]         │
    │──────────────────────────────────────>│
    │                                       │
    │  {"success":true,"command":"ready",   │
    │   "version":"1.2","message":"..."}    │
    │<──────────────────────────────────────│
    │                                       │
    │  {"command":"load","path":"X.wbproj"} │
    │──────────────────────────────────────>│
    │                                       │
    │  {"success":true,"command":"load",...} │
    │<──────────────────────────────────────│
    │                                       │
    │  {"command":"quit"}                   │
    │──────────────────────────────────────>│
    │                                       │
    │  {"success":true,"command":"quit"}    │
    │<──────────────────────────────────────│
    │                                  [exit]│
```

### Message Format

- **Input:** One JSON object per line on **stdin**. Must contain a `"command"` field.
- **Output:** One JSON object per line on **stdout**.
- Blank lines on stdin are silently skipped.
- EOF (stdin closed) terminates the process.

### Response Envelope

Every response includes at minimum:

```jsonc
// Success
{ "success": true, "command": "command-name", /* ...result fields */ }

// Failure
{ "success": false, "command": "command-name", "error": "Error message" }

// Parse failure (invalid JSON or missing "command" field)
{ "success": false, "command": "parse_error", "error": "..." }
```

### JSON Serialization Rules

- Property names use **camelCase** (e.g. `projectName`, `lbX`)
- Null fields are **omitted** (not serialized as `null`)
- Responses are **not indented** (single-line JSON)
- Landblock IDs are formatted as hex strings: `"0x1A2B"`
- Model IDs are formatted as hex strings: `"0x02001234"`
- Quaternions are formatted as `{ "w": 1.0, "x": 0.0, "y": 0.0, "z": 0.0 }`
- Heights are rounded to 2 decimal places

---

## Startup & Modes

### Command Line

```
WorldBuilder.Terminal [options]
```

| Flag | Short | Description |
|------|-------|-------------|
| `--project <path>` | `-p` | Path to a `.wbproj` project file |
| `--export <path>` | `-e` | Directory to export DAT files into |
| `--iteration <N>` | `-i` | Portal iteration number (default: current + 1) |
| `--stdin` | | JSON-line stdin/stdout mode (for agents) |
| `--version` | `-v` | Show version and exit |
| `--help` | `-h` | Show help and exit |

### Operating Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| **Batch** | `--project` AND `--export` | Export DATs and exit (no REPL) |
| **Interactive** | No `--export` or `--stdin` | Human-friendly REPL with colored output |
| **Agent (stdin)** | `--stdin` | JSON-line protocol for agent piping |

### Startup Sequence (Agent Mode)

1. Process starts. Console logging is suppressed. Minimum log level = Warning.
2. If `--project` was provided, the project is pre-loaded. On failure, a JSON error is written.
3. A `ready` message is emitted:
   ```json
   {"success":true,"command":"ready","version":"1.2","message":"WorldBuilder.Terminal JSON mode ready"}
   ```
4. The agent can now send commands.

---

## Command Index

| Command | Category | Parameters | Description |
|---------|----------|------------|-------------|
| `load` | Project | `path` | Load a `.wbproj` project |
| `export` | Project | `directory`, `iteration?` | Export DATs to disk |
| `info` | Project | — | Show project info |
| `smooth` | Terrain Edit | `x`, `y`, `radius`, `strength?` | Smooth terrain heights |
| `raise` | Terrain Edit | `x`, `y`, `radius`, `delta?` | Raise terrain heights |
| `lower` | Terrain Edit | `x`, `y`, `radius`, `delta?` | Lower terrain heights |
| `set-height` | Terrain Edit | `x`, `y`, `radius`, `height` | Set terrain to exact height |
| `paint` | Terrain Edit | `x`, `y`, `radius`, `type` | Paint terrain texture |
| `fill` | Terrain Edit | `x`, `y`, `type` | Flood-fill terrain texture |
| `road` | Terrain Edit | `x1`, `y1`, `x2`, `y2`, `value?` | Draw road between points |
| `get-height` | Terrain Query | `x`, `y` | Query height at world position |
| `terrain-info` | Terrain Query | `lbX`, `lbY` | Landblock terrain statistics |
| `get-heightmap` | Terrain Query | `lbX`, `lbY` | Full 9×9 height grid |
| `get-terrain-data` | Terrain Query | `lbX`, `lbY` | All 81 vertex data |
| `list-objects` | Objects | `lbX`, `lbY` | List static objects |
| `add-object` | Objects | `lbX`, `lbY`, `modelId`, `x`, `y`, `z`, ... | Place a static object |
| `remove-object` | Objects | `lbX`, `lbY`, `index` | Remove object by index |
| `move-object` | Objects | `lbX`, `lbY`, `index`, `x`, `y`, `z` | Move object to new position |
| `rotate-object` | Objects | `lbX`, `lbY`, `index`, `qw/qx/qy/qz` or `yaw` | Set object orientation |
| `query-radius` | Spatial | `x`, `y`, `radius`, `z?`, `includeZ?` | Find objects within radius |
| `analyze-dungeons` | Dungeon | `outputPath?` | Scan and catalog dungeon rooms |
| `get-dungeon-info` | Dungeon | `lbX`, `lbY` | Get dungeon cell layout |
| `validate-dungeon` | Validation | `lbX`, `lbY` | Validate dungeon structure |
| `validate-landblock` | Validation | `lbX`, `lbY` | Validate landblock objects |
| `validate-terrain` | Validation | `lbX`, `lbY`, `cliffThreshold?` | Validate terrain data |
| `validate-building-portals` | Validation | `lbX`, `lbY` | Validate building portal links |
| `validate-all` | Validation | `lbX`, `lbY`, `cliffThreshold?` | Run all validators |
| `transact` | Transact | `ops[]` or `opsFile`, `rollback_on_fail?`, `validate?`, `diff?` | Atomic batched mutations with rollback on failure |
| `transact-diff` | Transact | `txId`, `render?`, `renderMode?`, `lbs?`, `resolution?`, `out?` | Structured before/after report for a committed transaction |
| `list-landblocks` | World | `minX?`, `minY?`, `maxX?`, `maxY?`, `limit?` | List landblocks with height stats |
| `get-world-info` | World | — | World metadata and constants |
| `get-region` | World | — | Height table and terrain type names |
| `help` | Control | — | List all commands |
| `quit` / `exit` | Control | — | Terminate the session |

---

## Project Management

### load

Loads a `.wbproj` project file. Must be called before any terrain/object commands.

**Request:**
```json
{"command":"load","path":"C:\\Projects\\demo.wbproj"}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | Absolute or relative path to a `.wbproj` file |

**Response:**
```json
{
  "success": true,
  "command": "load",
  "projectName": "My World",
  "projectFile": "C:\\Projects\\demo.wbproj",
  "projectDir": "C:\\Projects",
  "datDirectory": "C:\\Projects\\dats\\base"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `projectName` | string | Display name of the project |
| `projectFile` | string | Full path to the loaded project file |
| `projectDir` | string | Directory containing the project |
| `datDirectory` | string | Path to the base DAT file directory |

---

### export

Exports modified DAT files to a directory.

**Request:**
```json
{"command":"export","directory":"C:\\Output","iteration":5}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `directory` | string | ✅ | — | Output directory for DAT files |
| `iteration` | int | ❌ | current + 1 | Portal iteration number |

**Response:**
```json
{
  "success": true,
  "command": "export",
  "directory": "C:\\Output",
  "iteration": 5
}
```

---

### info

Returns metadata about the currently loaded project,  or `loaded: false` if none.

**Request:**
```json
{"command":"info"}
```

**Response (project loaded):**
```json
{
  "success": true,
  "command": "info",
  "loaded": true,
  "projectName": "My World",
  "projectFile": "C:\\Projects\\demo.wbproj",
  "projectDir": "C:\\Projects",
  "datDirectory": "C:\\Projects\\dats\\base",
  "databasePath": "C:\\Projects\\demo.db",
  "portalIteration": 2072
}
```

**Response (no project):**
```json
{"success":true,"command":"info","loaded":false}
```

---

## Terrain Editing

> **Prerequisite:** A project must be loaded (`load` command).
>
> **Coordinate system:** All coordinates are in **world space** (see [Coordinate System Reference](#coordinate-system-reference)). A landblock is 192×192 units. Each 24×24 cell has 9×9 = 81 height vertices.

### smooth

Smooths terrain heights within a radius by averaging neighboring vertices.

**Request:**
```json
{"command":"smooth","x":1500.0,"y":2000.0,"radius":48.0,"strength":0.7}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `x` | float | ✅ | — | World X coordinate (center) |
| `y` | float | ✅ | — | World Y coordinate (center) |
| `radius` | float | ✅ | — | Radius in world units |
| `strength` | float | ❌ | 0.5 | Smoothing strength (0.0–1.0) |

**Response:**
```json
{
  "success": true,
  "command": "smooth",
  "verticesModified": 45,
  "landblocks": ["0x0708", "0x0808"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `verticesModified` | int | Number of terrain vertices changed |
| `landblocks` | string[] | Hex IDs of modified landblocks |

---

### raise

Raises terrain height by a delta value (height index units, not world units).

**Request:**
```json
{"command":"raise","x":1500.0,"y":2000.0,"radius":48.0,"delta":10}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `x` | float | ✅ | — | World X center |
| `y` | float | ✅ | — | World Y center |
| `radius` | float | ✅ | — | Radius in world units |
| `delta` | int | ❌ | 5 | Height index increase (0–255 range, clamped) |

**Response:**
```json
{
  "success": true,
  "command": "raise",
  "verticesModified": 30,
  "delta": 10,
  "landblocks": ["0x0708"]
}
```

---

### lower

Lowers terrain height. Parameters identical to `raise`.

**Request:**
```json
{"command":"lower","x":1500.0,"y":2000.0,"radius":48.0,"delta":10}
```

**Response:** Same shape as `raise`, with `"command": "lower"`.

---

### set-height

Sets all vertices within a radius to an exact height index.

**Request:**
```json
{"command":"set-height","x":1500.0,"y":2000.0,"radius":48.0,"height":128}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | float | ✅ | World X center |
| `y` | float | ✅ | World Y center |
| `radius` | float | ✅ | Radius in world units |
| `height` | byte | ✅ | Target height index (0–255) |

**Response:**
```json
{
  "success": true,
  "command": "set-height",
  "verticesModified": 81,
  "targetHeight": 128,
  "landblocks": ["0x0708"]
}
```

---

### paint

Paints terrain texture type within a radius.

**Request:**
```json
{"command":"paint","x":1500.0,"y":2000.0,"radius":48.0,"type":3}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | float | ✅ | World X center |
| `y` | float | ✅ | World Y center |
| `radius` | float | ✅ | Radius in world units |
| `type` | byte | ✅ | Terrain type index (use `get-region` to see available types) |

**Response:**
```json
{
  "success": true,
  "command": "paint",
  "verticesModified": 45,
  "terrainType": 3,
  "landblocks": ["0x0708"]
}
```

---

### fill

Flood-fills contiguous terrain of the same type, starting from a seed point.

**Request:**
```json
{"command":"fill","x":1500.0,"y":2000.0,"type":5}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | float | ✅ | World X seed point |
| `y` | float | ✅ | World Y seed point |
| `type` | byte | ✅ | New terrain type to fill with |

**Response:**
```json
{
  "success": true,
  "command": "fill",
  "verticesModified": 200,
  "terrainType": 5,
  "landblocks": ["0x0708", "0x0709", "0x0808"]
}
```

---

### road

Draws a road path between two world positions. The path follows terrain-aware routing.

**Request:**
```json
{"command":"road","x1":1000.0,"y1":1500.0,"x2":2000.0,"y2":2500.0,"value":1}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `x1` | float | ✅ | — | Start X |
| `y1` | float | ✅ | — | Start Y |
| `x2` | float | ✅ | — | End X |
| `y2` | float | ✅ | — | End Y |
| `value` | byte | ❌ | 1 | Road intensity value (0 = remove, 1+ = road) |

**Response:**
```json
{
  "success": true,
  "command": "road",
  "waypoints": 85,
  "verticesModified": 85,
  "roadValue": 1,
  "landblocks": ["0x0708", "0x0808", "0x0908"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `waypoints` | int | Total waypoints in the computed path |
| `verticesModified` | int | Vertices that actually changed |
| `roadValue` | byte | The road value applied |

---

## Terrain Queries

### get-height

Queries the terrain height at a specific world position. Returns the height along with all vertex metadata.

**Request:**
```json
{"command":"get-height","x":1500.0,"y":2000.0}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | float | ✅ | World X coordinate |
| `y` | float | ✅ | World Y coordinate |

**Response:**
```json
{
  "success": true,
  "command": "get-height",
  "x": 1500.0,
  "y": 2000.0,
  "height": 156.42,
  "heightIndex": 78,
  "terrainType": 2,
  "road": 0,
  "scenery": 3,
  "landblock": "0x070A",
  "vertexIndex": 41
}
```

| Field | Type | Description |
|-------|------|-------------|
| `height` | float | World-space height (using height table lookup) |
| `heightIndex` | byte | Raw height table index (0–255) |
| `terrainType` | byte | Terrain texture type index |
| `road` | byte | Road value at this vertex (0 = no road) |
| `scenery` | byte | Scenery value at this vertex |
| `landblock` | string | Hex landblock ID containing this point |
| `vertexIndex` | int | Vertex index within the 9×9 grid (0–80) |

---

### terrain-info

Returns statistical summary of a landblock's terrain.

**Request:**
```json
{"command":"terrain-info","lbX":7,"lbY":8}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lbX` | uint | ✅ | Landblock grid X coordinate (0–254) |
| `lbY` | uint | ✅ | Landblock grid Y coordinate (0–254) |

**Response:**
```json
{
  "success": true,
  "command": "terrain-info",
  "landblock": "0x0708",
  "found": true,
  "lbX": 7,
  "lbY": 8,
  "worldOriginX": 1344,
  "worldOriginY": 1536,
  "vertexCount": 81,
  "heightMin": 45,
  "heightMax": 120,
  "heightAvg": 82.5,
  "terrainTypes": [
    {"type": 0, "count": 50, "percent": 62},
    {"type": 3, "count": 31, "percent": 38}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `found` | bool | Whether terrain data exists for this landblock |
| `worldOriginX` | int | World X of the landblock's (0,0) corner = `lbX * 192` |
| `worldOriginY` | int | World Y of the landblock's (0,0) corner = `lbY * 192` |
| `heightMin` / `heightMax` | int | Height index range across all 81 vertices |
| `heightAvg` | float | Average height index |
| `terrainTypes` | array | Terrain type distribution (type index, count, percentage) |

---

### get-heightmap

Returns the full 9×9 height grid for a landblock — both world-space heights and raw height indices.

**Request:**
```json
{"command":"get-heightmap","lbX":7,"lbY":8}
```

**Response:**
```json
{
  "success": true,
  "command": "get-heightmap",
  "landblock": "0x0708",
  "found": true,
  "lbX": 7,
  "lbY": 8,
  "worldOriginX": 1344,
  "worldOriginY": 1536,
  "gridSize": 9,
  "cellSize": 24,
  "heightsWorld": [
    [120.5, 122.3, ...],
    ...
  ],
  "heightIndices": [
    [60, 61, ...],
    ...
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `gridSize` | int | Always 9 (9×9 vertex grid) |
| `cellSize` | int | Always 24 (spacing between vertices in world units) |
| `heightsWorld` | float[9][9] | World-space heights (looked up from height table) |
| `heightIndices` | int[9][9] | Raw height indices (0–255) |

> **Grid layout:** `heightsWorld[x][y]` where `x` is the column (0=west, 8=east) and `y` is the row (0=south, 8=north). World position of vertex `[x][y]` = `(worldOriginX + x*24, worldOriginY + y*24)`.

---

### get-terrain-data

Returns complete vertex data for all 81 vertices in a landblock — height, terrain type, road, and scenery.

**Request:**
```json
{"command":"get-terrain-data","lbX":7,"lbY":8}
```

**Response:**
```json
{
  "success": true,
  "command": "get-terrain-data",
  "landblock": "0x0708",
  "found": true,
  "lbX": 7,
  "lbY": 8,
  "worldOriginX": 1344,
  "worldOriginY": 1536,
  "vertexCount": 81,
  "gridSize": 9,
  "cellSize": 24,
  "vertices": [
    {
      "index": 0,
      "gridX": 0,
      "gridY": 0,
      "heightIndex": 60,
      "heightWorld": 120.5,
      "terrainType": 2,
      "road": 0,
      "scenery": 3
    }
  ]
}
```

| Vertex Field | Type | Description |
|-------------|------|-------------|
| `index` | int | Flat index (0–80). Formula: `gridX * 9 + gridY` |
| `gridX` | int | Column in 9×9 grid (0–8) |
| `gridY` | int | Row in 9×9 grid (0–8) |
| `heightIndex` | int | Raw height table index (0–255) |
| `heightWorld` | float | World-space height |
| `terrainType` | int | Terrain type index |
| `road` | int | Road value (0 = none) |
| `scenery` | int | Scenery value |

---

## Object Management

> **Static objects** are placed per-landblock. Each object has a 0-based index within its landblock. Indices shift when objects are removed — always re-query after removal.

### list-objects

Lists all static objects in a landblock.

**Request:**
```json
{"command":"list-objects","lbX":7,"lbY":8}
```

**Response:**
```json
{
  "success": true,
  "command": "list-objects",
  "landblock": "0x0708",
  "count": 3,
  "objects": [
    {
      "index": 0,
      "modelId": "0x02001234",
      "type": "Setup",
      "x": 1380.5,
      "y": 1560.2,
      "z": 120.0,
      "orientation": {"w": 1.0, "x": 0.0, "y": 0.0, "z": 0.0},
      "scale": {"x": 1.0, "y": 1.0, "z": 1.0}
    }
  ]
}
```

| Object Field | Type | Description |
|-------------|------|-------------|
| `index` | int | 0-based index within this landblock |
| `modelId` | string | Hex model ID (Setup `0x02xxxxxx` or GfxObj `0x01xxxxxx`) |
| `type` | string | `"Setup"` or `"GfxObj"` |
| `x`, `y`, `z` | float | World-space position |
| `orientation` | object | Quaternion `{w, x, y, z}` |
| `scale` | object | Scale vector `{x, y, z}` |

---

### add-object

Places a new static object in a landblock.

**Request:**
```json
{
  "command": "add-object",
  "lbX": 7,
  "lbY": 8,
  "modelId": "0x02001234",
  "x": 1380.0,
  "y": 1560.0,
  "z": 120.0,
  "qw": 0.707,
  "qx": 0.0,
  "qy": 0.0,
  "qz": 0.707,
  "scale": 1.5,
  "snap": true
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lbX` | uint | ✅ | — | Landblock grid X |
| `lbY` | uint | ✅ | — | Landblock grid Y |
| `modelId` | string | ✅ | — | Hex model ID (e.g. `"0x02001234"`) |
| `x` | float | ✅ | — | World X position |
| `y` | float | ✅ | — | World Y position |
| `z` | float | ✅ | — | World Z position |
| `qw` | float | ❌ | 1.0 | Quaternion W (rotation) |
| `qx` | float | ❌ | 0.0 | Quaternion X |
| `qy` | float | ❌ | 0.0 | Quaternion Y |
| `qz` | float | ❌ | 0.0 | Quaternion Z |
| `scale` | float | ❌ | 1.0 | Uniform scale (applies to all axes) |
| `scaleX` | float | ❌ | `scale` | Per-axis X scale (overrides `scale`) |
| `scaleY` | float | ❌ | `scale` | Per-axis Y scale (overrides `scale`) |
| `scaleZ` | float | ❌ | `scale` | Per-axis Z scale (overrides `scale`) |
| `snap` | bool | ❌ | false | Snap position to nearest outdoor cell center |

> **Scale precedence:** If `scaleX`/`scaleY`/`scaleZ` are provided, they override `scale`. If `scale` is provided but per-axis values are not, `scale` applies uniformly. If neither is provided, scale defaults to 1.0 on all axes.

**Response:**
```json
{
  "success": true,
  "command": "add-object",
  "landblock": "0x0708",
  "index": 3,
  "modelId": "0x02001234",
  "type": "Setup",
  "x": 1380.0,
  "y": 1560.0,
  "z": 120.0,
  "snapped": true,
  "orientation": {"w": 0.707107, "x": 0.0, "y": 0.0, "z": 0.707107},
  "scale": {"x": 1.5, "y": 1.5, "z": 1.5}
}
```

---

### remove-object

Removes a static object by index. **Warning:** Indices of subsequent objects shift down after removal.

**Request:**
```json
{"command":"remove-object","lbX":7,"lbY":8,"index":2}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lbX` | uint | ✅ | Landblock grid X |
| `lbY` | uint | ✅ | Landblock grid Y |
| `index` | int | ✅ | 0-based object index |

**Response:**
```json
{
  "success": true,
  "command": "remove-object",
  "landblock": "0x0708",
  "index": 2,
  "removedModelId": "0x02001234",
  "removedPosition": {"x": 1380.0, "y": 1560.0, "z": 120.0}
}
```

---

### move-object

Moves a static object to a new world position.

**Request:**
```json
{"command":"move-object","lbX":7,"lbY":8,"index":0,"x":1400.0,"y":1580.0,"z":125.0}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lbX` | uint | ✅ | Landblock grid X |
| `lbY` | uint | ✅ | Landblock grid Y |
| `index` | int | ✅ | 0-based object index |
| `x` | float | ✅ | New world X |
| `y` | float | ✅ | New world Y |
| `z` | float | ✅ | New world Z |

**Response:**
```json
{
  "success": true,
  "command": "move-object",
  "landblock": "0x0708",
  "index": 0,
  "modelId": "0x02001234",
  "from": {"x": 1380.0, "y": 1560.0, "z": 120.0},
  "to": {"x": 1400.0, "y": 1580.0, "z": 125.0}
}
```

---

### rotate-object

Sets an object's orientation. Supports either quaternion or yaw shorthand. **This SETS the orientation — it does not compose with the existing rotation.**

**Request (quaternion):**
```json
{"command":"rotate-object","lbX":7,"lbY":8,"index":0,"qw":0.707,"qx":0.0,"qy":0.0,"qz":0.707}
```

**Request (yaw shorthand):**
```json
{"command":"rotate-object","lbX":7,"lbY":8,"index":0,"yaw":90.0}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `lbX` | uint | ✅ | Landblock grid X |
| `lbY` | uint | ✅ | Landblock grid Y |
| `index` | int | ✅ | 0-based object index |
| `qw` | float | ⚡ | Quaternion W — provide all q* fields OR yaw |
| `qx` | float | ⚡ | Quaternion X |
| `qy` | float | ⚡ | Quaternion Y |
| `qz` | float | ⚡ | Quaternion Z |
| `yaw` | float | ⚡ | Z-axis rotation in degrees (alternative to quaternion) |

> ⚡ One of these groups is required: quaternion (`qw`/`qx`/`qy`/`qz`) OR `yaw`.
>
> **Yaw shorthand:** `yaw: 90` creates a quaternion for 90° rotation around the Z axis (vertical).

**Response:**
```json
{
  "success": true,
  "command": "rotate-object",
  "landblock": "0x0708",
  "index": 0,
  "modelId": "0x02001234",
  "oldOrientation": {"w": 1.0, "x": 0.0, "y": 0.0, "z": 0.0},
  "newOrientation": {"w": 0.707107, "x": 0.0, "y": 0.0, "z": 0.707107}
}
```

---

## Spatial Queries

### query-radius

Searches for all static objects within a radius of a world position, across landblock boundaries.

**Request:**
```json
{"command":"query-radius","x":1500.0,"y":2000.0,"radius":200.0,"z":100.0,"includeZ":true}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `x` | float | ✅ | — | Center X |
| `y` | float | ✅ | — | Center Y |
| `radius` | float | ✅ | — | Search radius in world units |
| `z` | float | ❌ | 0.0 | Center Z (for 3D distance) |
| `includeZ` | bool | ❌ | auto | Use 3D distance? Auto-set to `true` if `z ≠ 0` |

**Response:**
```json
{
  "success": true,
  "command": "query-radius",
  "center": {"x": 1500.0, "y": 2000.0, "z": 100.0},
  "radius": 200.0,
  "includeZ": true,
  "totalFound": 15,
  "uniqueModels": 5,
  "density": 0.0001,
  "objects": [
    {
      "distance": 12.5,
      "landblock": "0x070A",
      "index": 3,
      "modelId": "0x02001234",
      "type": "Setup",
      "x": 1510.0,
      "y": 2005.0,
      "z": 102.0,
      "orientation": {"w": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}
    }
  ],
  "modelFrequency": [
    {"modelId": "0x02001234", "count": 5},
    {"modelId": "0x01000042", "count": 10}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `totalFound` | int | Total objects within radius |
| `uniqueModels` | int | Number of distinct model IDs |
| `density` | float | Objects per square unit: `count / (π × r²)` |
| `objects` | array | Found objects sorted by distance (nearest first) |
| `modelFrequency` | array | Model ID occurrence counts, sorted descending |

---

## Dungeon Tools

### analyze-dungeons

Scans all dungeon cells in the loaded DATs and produces a statistical catalog of room types, portal counts, and starter candidates.

**Request:**
```json
{"command":"analyze-dungeons","outputPath":"C:\\analysis_report.json"}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `outputPath` | string | ❌ | null | If provided, saves the full report to this file path |

**Response:**
```json
{
  "success": true,
  "command": "analyze-dungeons",
  "totalLandblocksScanned": 65025,
  "totalCellsScanned": 12000,
  "uniqueRoomTypes": 150,
  "topStarterCandidates": [
    {
      "envFileId": "0x0D000042",
      "cellStructIndex": 0,
      "portalCount": 4,
      "usageCount": 25,
      "sampleDungeonNames": ["Dungeon A", "Dungeon B"]
    }
  ],
  "savedTo": "C:\\analysis_report.json"
}
```

---

### get-dungeon-info

Returns the full cell layout of a dungeon within a landblock — cells, portals, static objects, and positions.

**Request:**
```json
{"command":"get-dungeon-info","lbX":7,"lbY":8}
```

**Response:**
```json
{
  "success": true,
  "command": "get-dungeon-info",
  "landblock": "0x0708",
  "hasDungeon": true,
  "cellCount": 5,
  "cells": [
    {
      "cellNumber": "0x0100",
      "environmentId": "0x0042",
      "cellStructure": 0,
      "origin": {"x": 0.0, "y": 0.0, "z": 0.0},
      "portalCount": 3,
      "portals": [
        {"otherCellId": "0x0101", "polygonId": 1}
      ],
      "staticObjectCount": 2,
      "staticObjects": [
        {"id": "0x02001234", "x": 5.0, "y": 3.0, "z": 0.0}
      ]
    }
  ]
}
```

| Cell Field | Type | Description |
|-----------|------|-------------|
| `cellNumber` | string | Hex cell ID within the landblock (0x0100+) |
| `environmentId` | string | Hex ID of the Environment prefab (0x0Dxxxxxx in full) |
| `cellStructure` | int | CellStruct index within the Environment |
| `origin` | object | Cell position `{x, y, z}` |
| `portals` | array | Portal connections to other cells |
| `staticObjects` | array | Static objects within the cell |

---

## Validation

All validation commands return a uniform **ValidationReport** response shape:

```json
{
  "success": true,
  "command": "validate-*",
  "landblock": "0x0708",
  "isValid": false,
  "errorCount": 2,
  "warningCount": 3,
  "infoCount": 1,
  "diagnostics": [
    {
      "severity": "error",
      "code": "DNG003",
      "message": "Cell 0x0100 portal references non-existent cell 0x0105.",
      "context": "Cell 0x0100 → 0x0105"
    }
  ]
}
```

| Report Field | Type | Description |
|-------------|------|-------------|
| `isValid` | bool | `true` if there are zero errors (warnings/infos are OK) |
| `errorCount` | int | Number of error-severity diagnostics |
| `warningCount` | int | Number of warning-severity diagnostics |
| `infoCount` | int | Number of informational diagnostics |
| `diagnostics` | array | All diagnostic items |

| Diagnostic Field | Type | Description |
|-----------------|------|-------------|
| `severity` | string | `"error"`, `"warning"`, or `"info"` |
| `code` | string | Machine-readable code (see [Diagnostic Codes](#validation-diagnostic-codes)) |
| `message` | string | Human-readable description |
| `context` | string? | Additional context (e.g. which cell, which object) |

---

### validate-dungeon

Validates a dungeon for structural integrity — broken portal links, orphaned cells, portal symmetry, environment references, degenerate geometry, and graph connectivity.

**Request:**
```json
{"command":"validate-dungeon","lbX":7,"lbY":8}
```

---

### validate-landblock

Validates a landblock's static objects — bounds checking, terrain-vs-object Z, zero-scale, degenerate quaternions, model existence in DATs, and duplicate positions.

**Request:**
```json
{"command":"validate-landblock","lbX":7,"lbY":8}
```

---

### validate-terrain

Validates terrain data — extreme height cliffs between adjacent vertices, edge stitching with neighbor landblocks, flat/mono-type warnings.

**Request:**
```json
{"command":"validate-terrain","lbX":7,"lbY":8,"cliffThreshold":50.0}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lbX` | uint | ✅ | — | Landblock grid X |
| `lbY` | uint | ✅ | — | Landblock grid Y |
| `cliffThreshold` | float | ❌ | 12.0 | Height delta threshold for cliff warnings (world units) |

---

### validate-building-portals

Validates building portal links — building→EnvCell existence, reciprocal outdoor exit portals, interior portal BFS, and VisibleCells validation.

**Request:**
```json
{"command":"validate-building-portals","lbX":7,"lbY":8}
```

---

### validate-all

Runs **all four validators** in a single call and returns a combined report. This is the recommended validation command for agents.

**Request:**
```json
{"command":"validate-all","lbX":7,"lbY":8,"cliffThreshold":50.0}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `lbX` | uint | ✅ | — | Landblock grid X |
| `lbY` | uint | ✅ | — | Landblock grid Y |
| `cliffThreshold` | float | ❌ | 12.0 | Cliff warning threshold |

---

## Transact

The `transact` command and its `transact-diff` companion close the agent **action loop**: stage a batch of mutations, validate the staged delta, atomically commit or rollback, and (optionally) inspect *what changed* via a structured before/after report.

### transact

Stages N mutating ops as one atomic batch. The engine snapshots affected document projections before any op runs, executes them sequentially, validates the staged delta, and either commits or rolls back the in-memory state.

**Request:**
```jsonc
{
  "command": "transact",
  "ops": [
    {"command": "set-landblock-heightmap", "lbX": 169, "lbY": 180, "heights": [/*81*/]},
    {"command": "bulk-place-objects",      "lbX": 169, "lbY": 180, "objects": [/*…*/]}
  ],
  "rollback_on_fail": true,
  "validate": "auto",
  "diff": false
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `ops` | object[] | ❌* | — | Inline list of op objects (each shaped as a normal JSON command) |
| `opsFile` | string | ❌* | — | Path to a JSON file holding either a top-level array or `{"ops": [...]}`. Use when stdin line-buffer would clip a large inline payload |
| `rollback_on_fail` | bool | ❌ | `true` | Restore pre-state on any failure |
| `validate` | string \| object | ❌ | `"auto"` | `auto` (touched LBs + right/top neighbors), `all`, `none`, or `{"landblocks": ["0xXXXX"]}` |
| `diff` | bool \| string | ❌ | `false` | When set, returns the [transact-diff](#transact-diff) response inline. Values: `true \| "structured" \| "visual" \| "both"` |
| `renderMode` | string | ❌ | `"overlay"` | Visual diff mode when `diff` includes a visual: `overlay \| side-by-side \| after-only-with-diff` |
| `resolution` | int | ❌ | 1024 | Visual diff resolution in pixels (square) |

*Exactly one of `ops` or `opsFile` must be supplied.

**Response:**
```jsonc
{
  "success": true,
  "command": "transact",
  "status": "committed",        // committed | rolled-back | rejected
  "reason": "ok",               // ok | rejected | op-threw | op-returned-failure | validation-failure
  "ops": [/* per-op outcome with embedded inner response */],
  "validation": [/* validationReport[] */],
  "journal": {
    "transactionId": "<guid>",
    "startedAt": "<ISO-8601>",
    "finishedAt": "<ISO-8601>",
    "documentsTouched": ["terrain", "landblock_A9B4"],
    "documentsCreated": [],
    "opsApplied": 2,
    "opsRolledBack": 0
  },
  "diff": {/* present only when `diff` was requested */}
}
```

**Op alphabet** — a transact composes existing JSON commands rather than introducing a parallel mutation language. The allow-list covers terrain edits (`set-landblock-heightmap`, `set-landblock-terrain`, `raise`, `lower`, `smooth`, `set-height`, `paint`, `fill`, `road`, `paste-stamp`), object placement (`add-object`, `remove-object`, `move-object`, `rotate-object`, `clear-objects`, `bulk-place-objects`), and `generate-dungeon`. Read-only and side-effecting ops are rejected, as is nesting.

**Failure modes** — `reason` distinguishes rejection (op not in allow-list, malformed batch), op throw, op returning `success:false`, and validation failure on the staged delta.

---

### transact-diff

Produces a structured before/after report for a previously committed transaction, plus an optional visual diff PNG. Field semantics mirror `describe-landblock`'s body schema where applicable — added/removed/moved objects, structure deltas, validation regressions cleared/added, plus categorical biome/road/cliffs comparison.

**Request:**
```jsonc
{
  "command": "transact-diff",
  "txId": "<guid from a prior transact response>",
  "render": true,
  "renderMode": "overlay",
  "lbs": [[7, 10]],
  "resolution": 1024,
  "out": null
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `txId` | string | ✅ | — | Transaction GUID returned by a prior transact |
| `render` | bool | ❌ | `false` | Also return a visual diff PNG |
| `renderMode` | string | ❌ | `"overlay"` | `overlay` (after-state + diff overlay), `side-by-side` (before \| after panels with separator), `after-only-with-diff` (alias of overlay) |
| `lbs` | `[int,int][]` | ❌ | all touched | Restrict diff to specific `[lbX, lbY]` pairs |
| `resolution` | int | ❌ | 1024 | Visual diff pixel resolution |
| `out` | string | ❌ | — | Write PNG to disk; response then carries `outPath` instead of `pngBase64` |

**Response (success):**
```jsonc
{
  "success": true,
  "command": "transact-diff",
  "txId": "<guid>",
  "summary": {
    "documentsTouched": 3,
    "objectsAdded": 12, "objectsRemoved": 4, "objectsMoved": 2,
    "structuresAdded": 1, "structuresRemoved": 0,
    "validationDelta": {"errors": -1, "warnings": 3, "info": 8},
    "spawnsAdded": 0, "spawnsRemoved": 0,
    "poisAdded": 0, "poisRemoved": 0,
    "biomeShift": false, "roadShift": false, "cliffShift": false
  },
  "perLandblock": [
    {
      "lbX": 7, "lbY": 10, "lbHex": "0x0707",
      "createdByBatch": false,
      "objects": {
        "added":   [{"wcid": 1234, "model": "0x02000abc", "position": [x, y, z], "ontology": ["Architecture", "Aluvian"]}],
        "removed": [],
        "moved":   [{"wcid": 5678, "model": "0x02000def", "from": [x, y, z], "to": [x, y, z], "deltaXY": 1.7, "deltaZ": 0.0}]
      },
      "structures": {"added": [], "removed": []},
      "validation": {"added": [{"code": "BLD-3", "severity": "warning", "msg": "..."}], "cleared": []},
      "spawns": {"added": [], "removed": []},
      "pois":   {"added": [], "removed": []},
      "categorical": {
        "biomeBefore": "grassland", "biomeAfter": "grassland",
        "roadBefore": true, "roadAfter": true,
        "cliffsBefore": 0, "cliffsAfter": 0
      }
    }
  ],
  "visual": {
    "mode": "overlay",
    "width": 1024, "height": 1024,
    "pngBase64": "..."
  }
}
```

**Response (error):**
```jsonc
{"success": false, "command": "transact-diff", "txId": "<guid>", "errorCode": "TXDIFF-EXPIRED", "error": "..."}
```

| Error code | Meaning |
|-----------|---------|
| `TXDIFF-EXPIRED` | The transaction's snapshot has been evicted from the LRU (default 32 entries / 256 MB). Reissue the transact if you need the diff |
| `TXDIFF-ROLLED-BACK` | The transaction ran ops then rolled back; no diff is retained for it |
| `TXDIFF-REJECTED` | The transaction was refused before any op ran (bad allow-list entry, malformed `validate`, no project loaded). Fix the request and resubmit |

**Retention** — committed transactions are held in an in-memory LRU keyed by transaction id. Defaults: 32 entries or 256 MB, whichever bound is hit first. Configurable via `--transact-diff-retention <n>` and `--transact-diff-mem-cap <mb>` on the Terminal CLI. Lookups bump LRU on access. Failed transactions are not retained — they leave a lightweight marker in a separate bounded set so the diff command can distinguish "rejected", "rolled back", and "expired".

**Visual diff overlay glyphs:**

| Color | Meaning |
|-------|---------|
| 🟥 Red | Object removed (drawn at original position) |
| 🟩 Green | Object added (drawn at new position) |
| 🟨 Yellow + arrow | Object moved (arrow from old to new; hidden when `deltaXY < 0.1m`) |
| Cyan outline | Validation regressed on this LB |
| Magenta outline | Validation cleared on this LB |

Glyph shape and size match `render-preview`'s dispatch — a removed structure draws as a red filled square (the same shape `render-preview` uses for buildings), so identity is preserved across the diff.

**Terrain-only batches** — when only the terrain doc was touched (so all 256² LBs are dirty), per-LB enumeration is suppressed. The response carries a `terrainSummary` block instead:

```jsonc
{
  "terrainSummary": {
    "biomeBefore": {"1": 12345, "21": 6789, /*...*/},   // terrain-type → vertex count
    "biomeAfter":  {"1": 11200, "21": 7890, /*...*/},
    "vertexHeightChanged": 4521,
    "vertexTypeChanged":  1109,
    "vertexRoadChanged":   233
  }
}
```

In that case the `visual` block is also omitted with an info note unless `lbs` is supplied to scope the render.

---

## World Observation

### list-landblocks

Lists landblocks within a coordinate range that have terrain data. Returns height min/max for each.

**Request:**
```json
{"command":"list-landblocks","minX":5,"minY":5,"maxX":15,"maxY":15,"limit":100}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `minX` | uint | ❌ | 0 | Minimum landblock X |
| `minY` | uint | ❌ | 0 | Minimum landblock Y |
| `maxX` | uint | ❌ | 254 | Maximum landblock X |
| `maxY` | uint | ❌ | 254 | Maximum landblock Y |
| `limit` | int | ❌ | 500 | Maximum results to return |

**Response:**
```json
{
  "success": true,
  "command": "list-landblocks",
  "count": 42,
  "range": {"minX": 5, "minY": 5, "maxX": 15, "maxY": 15},
  "truncated": false,
  "landblocks": [
    {
      "landblock": "0x0505",
      "lbX": 5,
      "lbY": 5,
      "worldOriginX": 960,
      "worldOriginY": 960,
      "heightMin": 30,
      "heightMax": 80
    }
  ]
}
```

---

### get-world-info

Returns world-level constants and metadata about the loaded project.

**Request:**
```json
{"command":"get-world-info"}
```

**Response:**
```json
{
  "success": true,
  "command": "get-world-info",
  "projectName": "My World",
  "mapWidth": 255,
  "mapHeight": 255,
  "landblockSize": 192,
  "cellSize": 24,
  "gridPerLandblock": 9,
  "verticesPerLandblock": 81,
  "totalLandblocks": 65025,
  "modifiedLandblocks": 3,
  "heightTableSize": 256,
  "heightMin": 0.0,
  "heightMax": 510.0,
  "portalIteration": 2072
}
```

| Field | Type | Description |
|-------|------|-------------|
| `mapWidth` / `mapHeight` | int | Grid dimensions (always 255×255) |
| `landblockSize` | int | World units per landblock side (always 192) |
| `cellSize` | int | World units per cell/vertex spacing (always 24) |
| `gridPerLandblock` | int | Vertices per side (always 9) |
| `verticesPerLandblock` | int | Total vertices per landblock (always 81) |
| `totalLandblocks` | int | Total possible landblocks (always 65,025) |
| `modifiedLandblocks` | int | Landblocks with modified terrain data in this project |
| `heightTableSize` | int | Number of entries in the height lookup table |
| `heightMin` / `heightMax` | float | World-space height range from the height table |
| `portalIteration` | int? | Current portal DAT iteration number |

---

### get-region

Returns the full height lookup table and all terrain type names defined in the game's Region data.

**Request:**
```json
{"command":"get-region"}
```

**Response:**
```json
{
  "success": true,
  "command": "get-region",
  "heightTable": [0.0, 2.0, 4.0, 6.0, 8.0, "...255 entries total"],
  "heightTableSize": 256,
  "terrainTypeCount": 32,
  "terrainTypes": [
    {"index": 0, "name": "Grassland"},
    {"index": 1, "name": "SemiBarren"},
    {"index": 2, "name": "Snow"}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `heightTable` | float[] | Maps height index (0–255) → world-space height |
| `terrainTypes` | array | Maps terrain type index → human-readable name |

> **Usage:** When reading a vertex with `heightIndex: 78`, the world height is `heightTable[78]`. When reading `terrainType: 2`, the name is `terrainTypes[2].name`.

---

## DerethMaps Enhanced

The `emit-static-site` command and its supporting batch commands compose the
WorldBuilder observation stack into a self-contained `dist/` folder that
viewers can drag onto Google Drive (or any HTTP origin, including
`file://`) and explore as a Leaflet-based map. The set of commands below
are designed to be called in order, but each is independently usable —
the orchestrator just glues them together.

### extract-cell-footprints

Walks every cached dungeon document, projects each `EnvCell`'s wall
vertices through the cell's frame, and emits a 2D polygon + portal
wall-spans + Z range to `projects/<name>/cell_footprints.jsonl`. Cells
whose `Environment` can't be resolved fall back to a synthetic 24u AABB
around `cell.Origin` (so the renderer always has *something* to draw).

**Request:**
```json
{"command":"extract-cell-footprints","force":false,"lbFilter":["0xA9B4"]}
```

`lbFilter` (optional) is an array of LB hex strings or numeric keys; when
provided, the cache is updated **incrementally** — entries for other LBs
are preserved. Without `lbFilter`, the full cache is rebuilt.

**Response:**
```json
{"success":true,"command":"extract-cell-footprints",
 "cellsExtracted":37272,"synthetic":7,"dungeonsScanned":179,
 "cachePath":"projects/RetailSmoke/cell_footprints.jsonl"}
```

---

### generate-object-sprites

Renders top-down orthographic PNG sprites for every model id placed in
the project's loaded landblock + dungeon documents. Each sprite is sized
at `spritePx` pixels per the model's longest XY world dim — uniform
fidelity per pixel of model surface across all sprites. Lighting matches
`render-preview`'s hillshade convention (sun at azimuth 135°, elevation
60°, Lambert shade with floor 0.55). Albedo comes from the model's
`Surface` texture(s) (DXT skipped, falls back to ontology category color
if texture decode fails). Soft drop shadow composited under the silhouette.
Output: per-sprite PNG + a packed `atlas.png` + `manifest.jsonl`.

**Request:**
```json
{"command":"generate-object-sprites","force":false,"spritePx":512,
 "lbFilter":["0xA9B4"]}
```

**Response:**
```json
{"success":true,"command":"generate-object-sprites",
 "modelsCollected":119,"modelsRendered":108,"modelsFailed":11,
 "atlasWidth":4096,"atlasHeight":1296,
 "spritesDir":"…/sprites","atlasPath":"…/sprites/atlas.png",
 "manifestPath":"…/sprites/manifest.jsonl"}
```

`modelsFailed` covers degenerate cases (no triangles, no top-facing
faces, sub-millimeter XY extent) and DAT-record corruption that the
renderer handles with `SafeTryGet`-wrapped reads.

---

### render-dungeon

Per-floor interior renderer. Reuses `LandblockDescriber.ClusterByCellZ`
for the floor partition (top-down ordered: index 0 = highest Z = closest
to surface). Draws cell-fills with deterministic per-cell hue jitter
inside each floor's hue family, exterior walls (thick) + interior strokes
(thin), portal classification (same-floor → dark gap, cross-floor →
amber marker, exterior → green marker), cell-resident `DungeonStabData`
objects via the sprite atlas if loaded (else a glyph fallback), and
LB-doc loose objects filtered by Z band + point-in-polygon test.

**Request:**
```json
{"command":"render-dungeon","lbX":0,"lbY":176,"floor":0,"resolution":1024,
 "outputPath":"/tmp/dungeon.png"}
```

`floor` (optional, integer) selects a single floor; omit to render all
floors on one canvas with floor distinguished by hue.

**Response:**
```json
{"success":true,"command":"render-dungeon","landblock":"0x00B0",
 "floorIndex":0,"floorCount":4,"cellsRendered":810,
 "floorZMin":18,"floorZMax":18,
 "outputPath":"/tmp/dungeon.png","pngBytes":78471}
```

---

### emit-tile-pyramid

Standard Leaflet z/x/y pyramid generator. Renders each LB once at the
deepest zoom (`LbPx = 256 · 2^(maxZoom−8)`), slices into 256×256 tiles,
then 2×2 mitchell-downsamples to fill all lower zooms. Skips
fully-transparent tiles so the dist doesn't accumulate empty PNGs over
ocean. Optional `emitObject` produces a sprite-mode tier at z≥11; optional
`emitFloor` emits a per-LB-per-floor image overlay for every dungeon LB.

**Request:**
```json
{"command":"emit-tile-pyramid","outDir":"/tmp/dist/projects/foo/tiles",
 "maxZoom":12,"minZoom":3,"emitObject":true,"emitFloor":true,
 "dirtyOnly":false,"lbFilter":null}
```

`maxZoom` is constrained to `[8, 12]`. `dirtyOnly` reuses the existing
`_tileCache.DirtyLbs` set populated by `OnTransactCommitted` — re-renders
after a small `transact` complete in seconds rather than re-rendering
every LB.

**Response:**
```json
{"success":true,"command":"emit-tile-pyramid",
 "maxZoom":12,"minZoom":3,"lbsProcessed":4,
 "exteriorTilesAtMaxZoom":1024,"objectTilesAtMaxZoom":1024,
 "floorTilesWritten":12,"downsampledTiles":348,"outDir":"…/tiles"}
```

---

### describe-floor

Per-floor variant of `describe-landblock`. Returns cell count, Z band,
cell-resident object count, loose objects in band, and a one-line verbal
summary specific to the floor.

**Request:**
```json
{"command":"describe-floor","lbX":0,"lbY":176,"floor":0}
```

**Response:**
```json
{"success":true,"command":"describe-floor","landblock":"0x00B0",
 "floorIndex":0,"floorCount":4,"zMin":18,"zMax":18,
 "cellCount":810,"cellResidentObjects":2048,"looseObjectsInFloor":120,
 "verbal":"Landblock 0x00B0, top: 810 cells between Z 18.0 and 18.0, …"}
```

---

### emit-static-site

The orchestrator. Composes everything above into a self-contained
`dist/` folder per the contract documented at the top of
`docs/prompts/dereth_maps_enhanced.md`. Multi-project support: a second
invocation with a different `projectSlug` into the same `outDir` merges
into `manifest.js` rather than wiping it.

**Request:**
```json
{"command":"emit-static-site","projectSlug":"vanilla","outDir":"/tmp/dist",
 "maxZoom":12,"minZoom":3,"emitObject":true,"emitFloor":true,
 "lbFilter":null}
```

**Response:**
```json
{"success":true,"command":"emit-static-site","projectSlug":"vanilla",
 "outDir":"/tmp/dist","lbsDescribed":4928,"dungeonsEmitted":179,
 "overlaysEmitted":4,"tilesAtMaxZoom":1262144,"frontendFilesCopied":10,
 "manifestProjectCount":1}
```

The frontend bundle (vendored Leaflet 1.9.4 + `index.html` / `app.js` /
`app.css`) ships next to the binary as `Content` resources and is copied
into `outDir` on every emit. The bundle's only runtime dependency is the
JSONP-style data files (`manifest.js`, `meta.js`, `desc/*.js`,
`dungeons/*.js`, `overlays/*.js`, `sprites/atlas.js`) — all loaded via
dynamic `<script>` tag injection so the dist is `file://`-viable without
fetch flags.

---

## Control

### help

Returns the command list as structured JSON.

**Request:**
```json
{"command":"help"}
```

**Response:**
```json
{
  "success": true,
  "command": "help",
  "protocol": "json-line",
  "version": "1.2",
  "description": "Send one JSON object per line. Each must have a 'command' field.",
  "commands": [
    {"name": "load", "args": "path", "description": "Load a .wbproj project"},
    "... etc"
  ]
}
```

---

### quit / exit

Terminates the JSON session. Both commands are equivalent.

**Request:**
```json
{"command":"quit"}
```

**Response:**
```json
{"success":true,"command":"quit"}
```

The process exits after sending this response.

---

## Coordinate System Reference

```
                  Y (North)
                  ▲
                  │
                  │  Landblock (7, 8)
                  │  World Origin = (1344, 1536)
                  │  ┌─────────────────────┐
                  │  │  192 × 192 units      │
                  │  │                       │
                  │  │  9×9 vertex grid      │
                  │  │  24 units spacing     │
                  │  │                       │
                  │  │  vertex[0][0] = SW    │
                  │  │  vertex[8][8] = NE    │
                  │  └─────────────────────┘
                  │
    ─────────────┼──────────────────────► X (East)
                  │
                  │
```

### Key Relationships

| Concept | Formula |
|---------|---------|
| World origin of landblock (lbX, lbY) | `(lbX × 192, lbY × 192)` |
| Landblock ID from grid coords | `(lbX << 8) \| lbY` → hex string `"0x{lbX:X2}{lbY:X2}"` |
| Grid coords from landblock ID | `lbX = id >> 8`, `lbY = id & 0xFF` |
| World position of vertex [x][y] | `(lbX×192 + x×24, lbY×192 + y×24)` |
| Landblock containing world point | `lbX = floor(worldX / 192)`, `lbY = floor(worldY / 192)` |
| World height from height index | `heightTable[heightIndex]` |
| Model type from ID | Setup if `(id & 0x02000000) ≠ 0`, otherwise GfxObj |

### Valid Ranges

| Property | Range | Notes |
|----------|-------|-------|
| Landblock X/Y | 0–254 | 255×255 = 65,025 total landblocks |
| World X/Y | 0–48,768 | `254 × 192 + 192` |
| Height index | 0–255 | Byte value, mapped via height table |
| Terrain type | 0–31+ | Depends on Region data |
| Object index | 0–N | Per-landblock, shifts on removal |
| Cell number | 0x0001–0x0040 | Outdoor LandCells |
| EnvCell number | 0x0100–0xFFFD | Indoor cells (dungeons, buildings) |

---

## Validation Diagnostic Codes

### Dungeon Diagnostics (DNG)

| Code | Severity | Description |
|------|----------|-------------|
| `DNG001` | Error | Dungeon has no cells |
| `DNG002` | Error | Duplicate cell number |
| `DNG003` | Error | Portal references non-existent cell |
| `DNG004` | Warning | Portal has no return (asymmetric link) |
| `DNG005` | Warning | VisibleCells references non-existent cell |
| `DNG006` | Error | Environment ID does not exist in DAT |
| `DNG007` | Error | CellStructure index does not exist in Environment |
| `DNG008` | Warning | Portal uses polygon ID not in CellStruct |
| `DNG009` | Info | Unconnected portal slots available |
| `DNG010` | Error | Degenerate orientation quaternion (length ≠ ~1.0) |
| `DNG011` | Error | Cells disconnected from main dungeon graph |

### Landblock Diagnostics (LBK)

| Code | Severity | Description |
|------|----------|-------------|
| `LBK001` | Info | Landblock has no static objects |
| `LBK002` | Warning | Object outside landblock bounds (±24 unit margin) |
| `LBK003` | Warning | Object >50 units below terrain |
| `LBK004` | Info | Object >500 units above terrain (floating) |
| `LBK005` | Error | Near-zero scale (object invisible) |
| `LBK006` | Error | Degenerate orientation quaternion |
| `LBK007` | Warning | Unexpected model ID prefix (not 0x01 or 0x02) |
| `LBK008` | Error | Model ID does not exist in DAT |
| `LBK009` | Warning | Duplicate object (same model + same position) |

### Terrain Diagnostics (TRN)

| Code | Severity | Description |
|------|----------|-------------|
| `TRN001` | Info | No terrain data for landblock |
| `TRN002` | Warning | Extreme height cliff between adjacent vertices |
| `TRN003` | Info | All 81 vertices use same terrain type |
| `TRN004` | Info | All 81 vertices have same height (completely flat) |
| `TRN005` | Warning | Edge height mismatch with adjacent landblock |

### Building Portal Diagnostics (BLD)

| Code | Severity | Description |
|------|----------|-------------|
| `BLD001` | Info | No LandBlockInfo for this landblock |
| `BLD002` | Info | Landblock has no buildings |
| `BLD003` | Error | Building portal targets non-existent EnvCell |
| `BLD004` | Warning | EnvCell has no outdoor exit portal |
| `BLD005` | Error | Interior cell does not exist in DAT |
| `BLD006` | Error | Interior portal targets non-existent cell |
| `BLD007` | Warning | VisibleCells references non-existent EnvCell |
| `BLD008` | Warning | VisibleCells contains unexpected cell ID |

---

## Error Handling

### Common Error Conditions

| Condition | Error Message |
|-----------|---------------|
| No project loaded | `"No project loaded."` |
| Missing required parameter | `"Missing 'fieldName' field"` |
| Invalid hex model ID | Standard parse exception |
| Invalid object index | `"Invalid index N. Landblock has M objects."` |
| Project file not found | `"Project file not found: path"` |
| Unknown command | `"Unknown command: 'name'"` |
| Invalid JSON input | `"Invalid JSON: parse details"` |

### Recommended Agent Error Strategy

1. **Always check `success`** before processing response fields.
2. **After mutations** (terrain edit, add/remove object), run `validate-all` to verify integrity.
3. **After `remove-object`**, re-query `list-objects` — indices have shifted.
4. **Retry on transient errors** (file locks, DAT read failures).
5. **Validate before export** — run `validate-all` on all modified landblocks.

---

## Sync Wave 2026-04-30 — Headless Parity Commands

These commands close the headless-parity debt opened by the 2026-04-26 → 2026-04-30 upstream sync wave. Each one matches a GUI editor surface; see `wireprompt.md` for the architectural mapping.

### Texture & Heightmap

#### `import-render-surface`

**Request:** `{"command":"import-render-surface","imagePath":"…","renderSurfaceId":"0x06000123","ui":false,"name":"…"}`
**Response:** `{success, command, renderSurfaceId, name, mode, deferred, error?}`

Default mode (`ui=false`) registers the image in the project's `CustomTextureStore`; the next `export` writes it to the DAT via `RenderSurfaceImporter.WriteCustomTexturesToDats`. `ui=true` uses the deferred portal-doc path so the original DAT stays untouched until export. Both modes require the source image to match the target RenderSurface dimensions and `PFID_A8R8G8B8` format.

#### `import-heightmap`

**Request:** `{"command":"import-heightmap","imagePath":"…","startLbX":169,"startLbY":178,"lbCountX":4,"lbCountY":4,"apply":false}`
**Response:** `{success, command, applied, imagePath, startLbX, startLbY, lbCountX, lbCountY, landblocksConsidered, landblocksChanged, verticesChanged, perLandblock[], modifiedLandblocks[]}`

Default is dry-run (returns per-LB change counts only). `apply:true` writes via `TerrainDocument.ApplyBulkImport` and is allow-listed in `transact`. Height comes from luminance, terrain type from nearest texture-color match (uses `TerrainAverageColorBuilder` over the project's local DAT).

### ACE DB Editing

#### `creature-get`, `creature-save`, `creature-export-sql`

- `{"command":"creature-get","objectId":31226}`
- `{"command":"creature-save","objectId":31226,"fromJson":"…"}` — JSON shape is `AceCreatureOverrides`
- `{"command":"creature-export-sql","objectId":31226,"out":"…"}`

Routes through `AceDbConnector.{LoadCreatureOverridesAsync,SaveCreatureOverridesAsync,GenerateCreatureOverridesSql}`. The save path replaces all `weenie_properties_texture_map` and `weenie_properties_anim_part` rows in a single transaction.

#### `spell-list`, `spell-get`, `spell-save`, `spell-copy`, `spell-delete`

- `{"command":"spell-list","limit":500,"source":"dat"}` — source is `"dat"` or `"db"`
- `{"command":"spell-get","id":1234}`
- `{"command":"spell-save","id":1234,"fromJson":"…"}` — JSON shape is `SpellRecord`
- `{"command":"spell-copy","fromId":1234,"newId":99999}` — `newId` auto-allocates `max+1` if omitted
- `{"command":"spell-delete","id":1234}`

`spell save/copy/delete` always update the project's `SpellDbDocument` overlay; if `ace-db` is connected they also push UPSERT/DELETE through MySQL. `spell get` prefers the project overlay then falls back to ace-db.

#### `weenie-save`, `weenie-insert`, `weenie-delete`, `weenie-list-property-keys`

- `{"command":"weenie-save","classId":31226,"fromJson":"…"}` — JSON shape is `AceWeenieSnapshot`
- `{"command":"weenie-insert","className":"my_thing","fromJson":"…"}` — auto-class-id ≥ 100 000
- `{"command":"weenie-delete","classId":99999}` — wipes weenie row + every `weenie_properties_*` row
- `{"command":"weenie-list-property-keys","family":"int"}` — family ∈ `int|int64|bool|float|string|did|iid`

Insert + save mirror `AceDbConnector.Weenie.cs:262/163`; delete uses the new transactional helper that strips every property table.

### Outdoor + Dungeon Instance Placements

- `{"command":"placement-list","lbX":169,"lbY":178,"kind":"outdoor"}` — kind ∈ `all|outdoor|dungeon`
- `{"command":"placement-add-outdoor","lbX":169,"lbY":178,"wcid":7777,"cellNumber":1,"originX":96,"originY":96,"originZ":120,"anglesW":1,"anglesX":0,"anglesY":0,"anglesZ":0}`
- `{"command":"placement-add-dungeon","lbX":169,"lbY":178,"wcid":7777,"cellNumber":256,…}`
- `{"command":"placement-remove","kind":"outdoor","index":3}`
- `{"command":"placement-export-sql","out":"…","apply":false}`

`placement-export-sql` writes `landblock_instances.sql` (outdoor) and `dungeon_instances.sql` (dungeon) into the chosen directory. With `apply:true` and ace-db configured, both files are also executed against the database. `add-outdoor`, `add-dungeon`, and `remove` are allow-listed in `transact`; `export-sql` is excluded as a side-effecting op.

### Layout Viewer / Overlay (no preview canvas)

- `{"command":"layout-list","overlayOnly":false}` — annotates rows with `hasOverlay`
- `{"command":"layout-get","layoutId":"0x16000010"}`
- `{"command":"layout-save","layoutId":"0x16000010","fromJson":"…"}`
- `{"command":"layout-delete-overlay","layoutId":"0x16000010"}`

Reads the local DAT's `LayoutDesc` enumeration; prefers the project overlay (`LayoutDatDocument`) when present. Save accepts a JSON `LayoutDesc` and stores it in the overlay; the next `export` packs it back into the local DAT.

### FreshStart + GenerateWorld + Towns CSV

#### `fresh-start`

**Request:** `{"command":"fresh-start","confirm":true}` — *destructive*; requires explicit `confirm:true`
**Response:** `{success, command, landblocksReset, verticesReset}`

Wipes all terrain to `WaterDeepSea`, sets `SkipDatStatics=true` while running, then calls `DocumentManager.ResetWorldDocumentsAsync` (clears active landblock docs, deletes inactive landblock + dungeon docs).

#### `generate-world`

**Request:** `{"command":"generate-world","params":{…WorldGeneratorParams…},"apply":false,"exportTownsCsv":"…"}`
**Response:** `{success, command, seed, applied, landblocksAffected, verticesModified, towns, buildingsPlaced, decorationsPlaced, roadVertices, townsCsvPath, townsCsvRows, townSummaries[]}`

Mirrors the GUI's GenerateWorld flow when `apply:true`: ResetWorldDocs → bulk-import terrain → place buildings → place decorations. Optionally writes the towns CSV through `TownsExporter.Write` so the byte-for-byte output matches the GUI's "Export Towns CSV" button.

#### `export-towns-csv`

**Request:** `{"command":"export-towns-csv","fromResult":"…worldgen-result.json","out":"…towns.csv"}`
**Response:** `{success, command, outPath, rows}`

Renders the towns CSV from a serialized `WorldGenerator` result (the JSON shape produced by `worldgen --output` / `generate-world`).

### Logging

#### `open-log-folder`

**Request:** `{"command":"open-log-folder"}`
**Response:** `{success, command, logPath, folder}` (or `{success:false, error}` if `--log-file` was not passed at startup)

Returns the active log path so the agent can ingest the file directly. **No folder-opening side effects** — the JSON-mode terminal never spawns a UI process.

### CLI flags added in this wave

| Flag | Effect |
|---|---|
| `--log-file <path>` | Adds a rotated `FileLoggerProvider` that writes the same format as the GUI's `worldbuilder.log`. Sets `CommandEngine.ActiveLogPath` so `open-log-folder` can surface it. |
