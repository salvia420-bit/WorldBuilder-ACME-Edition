# AcmeRedline

An in-game art-annotation tool for the ACME Edition client, built as a **Chorizite plugin**.

While playing, you point at something that looks wrong — a texture, a patch of triangles, a whole
object — describe the problem in plain language, tag and rate it, and hit submit. The plugin appends
a structured entry to a local **redline queue** (`redline.jsonl` + screenshot attachments). A
separate AI-agent pipeline (`tools/dat-patch/redline/`, **not** part of this plugin) consumes that
queue and executes the fix through the WorldBuilder dat-patching pipeline, writing progress back to
`redline-status.jsonl`, which this plugin reads to show you where your reports stand.

It compiles clean. The queue/schema/kit-meta/status halves are fully implemented and
schema-validated; the in-world half — polygon-accurate picking, drag-lasso triangle selection,
"all instances of this texture in view", and a status-tinted world overlay — is implemented against
verified client memory and the client's own D3D vtable (the SkunkVision RenderHook method). What
still can't be done without a live client is validating the on-screen *look*, plus a few genuinely
blocked pieces; each is a stub with a TODO naming exactly what is missing and where it was searched.
See **§4b** (picking & feedback) and **§5a** (verified vs assumed).

---

## 1. Architecture

```
                         ┌──────────────────────────────────────────┐
   input (mouse/keys)    │            AcmeRedlinePlugin             │  IPluginCore
   ────────────────────▶ │  (entry, DI, input wiring, compose+submit)│  ISerializeSettings<T>
                         └───┬──────────┬──────────┬──────────┬─────┘
                             │          │          │          │
                   ┌─────────▼──┐  ┌────▼─────┐ ┌──▼──────┐ ┌─▼──────────┐
                   │ Selection  │  │ Capture  │ │ KitMeta │ │ RedlinePanel│  RmlUi
                   │ Service    │  │ Service  │ │         │ │   (UI)      │
                   └──┬──────┬──┘  └────┬─────┘ └──┬──────┘ └─┬──────────┘
                      │      │          │          │          │
        ┌─────────────▼─┐  ┌─▼──────────▼──────────▼──────────▼──┐
        │ ClientMemory  │  │            QueueWriter               │  append-only
        │ (ACBindings)  │  │  redline.jsonl · shots/              │
        └───────────────┘  └──────────────┬───────────────────────┘
                                          │ reads only
                              ┌───────────▼────────────┐
                              │     StatusReader       │  redline-status.jsonl
                              └───────────┬────────────┘
                                          │
                              ┌───────────▼────────────┐
                              │    OverlayRenderer     │  IRenderer hooks + IDrawList (2D chrome)
                              └───────────┬────────────┘
                                          │ publishes once per frame
                              ┌───────────▼────────────┐
                              │     HighlightState     │  plain statics, lock-free
                              └───────────┬────────────┘
                                          │ read by detours
                              ┌───────────▼────────────┐
                              │      DeviceHooks       │  IDirect3DDevice9 vtable
                              │  slot 82 / 65 / 16     │  (SkunkVision method)
                              └───────────┬────────────┘
                                          │
                              ┌───────────▼────────────┐
                              │    TextureRegistry     │  IDirect3DTexture9* <-> RS id
                              └────────────────────────┘
```

| File | Role |
|---|---|
| `AcmeRedlinePlugin.cs` | Entry class. DI, lifecycle, input wiring, compose-and-submit. |
| `manifest.json` | Chorizite plugin manifest. |
| `Model/RedlineEntry.cs` | **Frozen queue-entry schema v1.** |
| `Model/RedlineStatusEvent.cs` | One line of `redline-status.jsonl` (read-only from here). |
| `Model/AcmeMeta.cs` | The `acme-meta.json` sidecar shape. |
| `Lib/RedlineJson.cs` | Source-generated `System.Text.Json` contracts. |
| `Lib/RedlineSettings.cs` | Persisted settings (`queueDir`, `kitMetaPath`, overlay flags…). |
| `Lib/ClientMemory.cs` | The **only** place raw client memory is touched. |
| `Services/SelectionService.cs` | Picking: object / triangles / texture, multi-select, lasso. |
| `Services/OverlayRenderer.cs` | 2D chrome (HUD, lasso, legend) + per-frame highlight publish + hook arming. |
| `Lib/D3D9.cs` | D3D9 vtable slots, state constants, the raw vtable swap. |
| `Services/DeviceHooks.cs` | **World-space highlight**: IDirect3DDevice9 vtable detours + tint pass. |
| `Services/HighlightState.cs` | Once-per-frame static handoff from managed selection to the detours. |
| `Services/TextureRegistry.cs` | Native texture pointer ↔ dat RenderSurface id map. |
| `Services/CaptureService.cs` | World/camera context + screenshot attachments. |
| `Services/QueueWriter.cs` | Append-only `redline.jsonl` + `shots/`. |
| `Services/StatusReader.cs` | Read-only fold of `redline-status.jsonl`. |
| `Services/KitMeta.cs` | Release stamping + protected/palettized surface guards. |
| `UI/RedlinePanel.cs` + `assets/panels/Redline.rml` | The in-game panel. |

---

## 2. Framework contracts used (every one verified in `external/chorizite/`)

### Plugin declaration and loading

| Contract | Source |
|---|---|
| A plugin is a **directory under the plugin directory containing `manifest.json`** | `external/chorizite/Chorizite/Chorizite.Core/Plugins/PluginManager.cs:297-300` — `foreach (var file in Directory.EnumerateDirectories(PluginDirectory))` → `Path.Combine(file, "manifest.json")` |
| Manifest fields | `Chorizite.Core/Plugins/PluginManifest.cs` — `Id`, `Name`, `Author`, `Version`, `Description`, `Repo`, `Icon`, `Dependencies`, `Environments`, `EntryFile` |
| Plugin directory default | `Chorizite.Core/ChoriziteConfig.cs:44-45` — `<base>/plugins`, storage `<base>/data` |
| Wired up at | `Chorizite.Core/Chorizite.cs:170` — `new PluginManager(Config.Environment, Config.PluginDirectory, config.StorageDirectory, …)` |
| Entry base type is an abstract **class** | `Chorizite.Core/Plugins/AssemblyLoader/IPluginCore.cs:8`, ctor `:36`, `Initialize()` `:43`, `Dispose()` `:48` |
| `AssemblyDirectory` / `DataDirectory` | `IPluginCore.cs:24` / `:29` |
| Settings round-trip | `Chorizite.Core/Plugins/AssemblyLoader/ISerializeSettings.cs` — needs a `JsonTypeInfo<T>` |
| Dev/live-reload manifest | `Chorizite.Core/Plugins/PluginInstance.cs:176` — optional `manifest.dev.json` (`source`, `bin`) |

Reference implementations read end-to-end: `external/chorizite/ACPlugin/ACPlugin.cs` +
`ACPlugin/manifest.json` + `ACPlugin/AC.csproj`, and `external/chorizite/RmlUiPlugin/RmlUiPlugin.cs`
+ `RmlUiPlugin/manifest.json`.

### Backends and services (constructor-injected via Autofac)

| Contract | Source |
|---|---|
| `IChoriziteBackend.Renderer` / `.Input` / `.Invoke(Action)` (game thread) | `Chorizite.Core/Backend/IChoriziteBackend.cs:21` / `:26` / `:74` |
| `IClientBackend.SelectedObjectId`, `OnObjectSelected` | `Chorizite.Core/Backend/Client/IClientBackend.cs:28`, `:53` |
| `IDatReaderInterface.Portal` / `.Cell` / `TryGet<T>` | `Chorizite.Core/Dats/IDatReaderInterface.cs:19`, `:24`, `:71` |
| `IInputManager` — `MouseX/Y`, `OnMouseDown/Move/Up`, `OnKeyDown`, `IsKeyPressed` | `Chorizite.Core/Input/IInputManager.cs` |

### Render hooks

| Contract | Source |
|---|---|
| Six frame events, all `EventHandler<EventArgs>`: `OnBeforeRender3D`, `OnRender3D`, `OnAfterRender3D`, `OnBeforeRenderUI`, `OnRenderUI`, `OnAfterRenderUI` | `Chorizite.Core/Render/IRenderer.cs:43`, `:48`, `:53`, `:63` |
| The only plugin-facing draw surface | `IRenderer.DrawList` (`IRenderer.cs:23`) → `Chorizite.Core/Render/IDrawList.cs` |
| Device-reset events are **not** on `IRenderer` | `OnGraphicsPreReset`/`OnGraphicsPostReset` are on `IGraphicsDevice` (`IGraphicsDevice.cs:58,63`), and `IRenderer.GraphicsDevice` throws `NotImplementedException` (`DX9RenderInterface.cs:95`) — so `DeviceHooks` hooks `IDirect3DDevice9::Reset` itself |
| Fonts | `IRenderer.FontManager` (`IRenderer.cs:38`) → `Chorizite.Core/Render/IFontManager.cs` |

### UI

Chorizite's plugin UI system is **RmlUi** (RML/RCSS documents, HTML/CSS-like, optionally
Lua-scripted) — verified, not assumed:

| Contract | Source |
|---|---|
| `RmlUiPlugin.CreatePanel(name, rmlFilePath, init?)` → `Panel?` | `external/chorizite/RmlUiPlugin/RmlUiPlugin.cs:182` |
| `Panel : UIDocument` | `RmlUiPlugin/Lib/Panel.cs:17` |
| `UIDocument.GetElementById` / `QuerySelector` | `RmlUiPlugin/Lib/UIDocument.cs:181` / `:182` |
| `Show()` / `Hide()` | `RmlUiPlugin/Lib/UIDocument.cs:206` / `:197` |
| Registered templates are only `modal` and `tabpanel` | `RmlUiPlugin/RmlUiPlugin.cs:95-96` |
| Element events | `RmlUiNet.Element.AddEventListener(string, Action<Event>)` (RmlUi.Net 1.0.1) |

### D3D9 render path (used by the world highlight — see §4a)

| Contract | Source |
|---|---|
| IDirect3DDevice9 vtable slot indices | SkunkVision `HookAll.cpp` (names every slot); cross-checked by `SVRenderHook.cpp` HookMethods 44/51/83/89 |
| Device pointer, path 1 | `DX9RenderInterface.NativeDevice` — `external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Render/DX9RenderInterface.cs:92` (reached by reflection) |
| Device pointer, path 2 | `RenderDeviceD3D::m_pDirect3DDevice` @ offset **1128** off `RenderDevice::render_device` = `(RenderDevice**)0x00870340` — `ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs`, `.../RenderDevice.cs`; cross-checked against `DirectXHooks.cs` |
| Draw → part correlation | `RenderDeviceD3D::s_current_physics_part = (CPhysicsPart**)0x008EE3D8` — `ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs:20` |
| Bound surface | `Render::curr_surface = (CSurface**)0x00867380` — `ACBindings/Generated/Rendering/Render.cs:87` |
| Surface → RenderSurface id | `CSurface::base1map` → `ImgTex::GetSurfaceDID` @`0x0053FE40` — `ACBindings/Generated/Dats/DBObjs/ImgTex.cs:200` |
| Chorizite's own hooks (must not collide) | `.../Hooks/DirectXHooks.cs`, `.../Hooks/HookBase.cs` (Reloaded.Hooks 4.3.3), `.../AcClient/_Hook.cs` (`VHook`) |
| Object vertex formats | `ACBindings/Generated/Rendering/D3D/CUSTOM_D3D_VERTEX.cs` (FVF 0x152, stride 36), `CUSTOM_D3D_VERTEX2.cs` (FVF 0x252, stride 44) |
| `D3DRS_*`/`D3DTSS_*`/`D3DTOP_*`/`D3DTA_*` values | public `d3d9types.h` (documented ABI) |

### Client memory (ACBindings)

All in `external/chorizite/ACBindings/Generated/` — generated structs over retail `acclient.exe`
with hardcoded absolute addresses.

| What | Where |
|---|---|
| Camera pose | `Rendering/Render.cs` — `viewer_pos = (Position*)0x0081FF10`, `fov = (float*)0x0081FC88` (radians; set by `Render::SetFOVRad`), `znear/zfar` |
| Player pose | `Rendering/Render.cs` — `player_pos = (Position*)0x0081FF58` |
| `Position` = `objcell_id` + `Frame` | `Net/Types/Position.cs`; `Frame.cs` — `qw,qx,qy,qz`, `m_fl2gv[9]`, `m_fOrigin` |
| Viewport | `Rendering/RenderDevice.cs` — `render_device = (RenderDevice**)0x00870340` → `m_viewportWidth/Height` |
| View + projection matrices | `Rendering/RenderDevice.cs:55-57` — `m_GState.{ModelToWorld,WorldToView,ViewToClip}Matrix` |
| Screen → world ray | `Rendering/Render.cs` — `pick_ray(Vector3*, int, int)` @`0x0054C220` |
| Arm/clear polygon-accurate pick | `Render::set_selection_cursor` @`0x0054C360`, `clear_selection_cursor` @`0x0054C3A0` |
| Read the pick back | `Render::GetMouseSelectionObjectID` @`0x0054D560`, `GetMouseSelectionPartIndex` @`0x0054D590`, `Render.m_MouseSelectData = 0x0086C1A0` (`bFoundPolygon`, `PolygonID`, `PolygonIndex`, `bFoundSphere`, …) |
| Runtime object table | `Physics/CPhysicsObj.cs` — `obj_maint = (CObjectMaint**)0x00844D64`; `CObjectMaint::GetObjectA(uint)` @`0x00508890` (`CObjectMaint.cs`) |
| Object → setup id | `CPartArray.cs` — `GetDataID(uint*)` @`0x005195F0`; parts via `parts` / `num_parts` |
| Part → GfxObj | `Physics/CPhysicsPart.cs` — `gfxobj` (`CGfxObj**`, indexed by `deg_level`), `pos` |
| GfxObj/Surface → dat id | `Dats/DBObjs/CGfxObj.cs` (`m_rgSurfaces`, `num_surfaces`) and `Dats/DBObjs/DBObj.cs` → `m_DID.BaseClass_uint` (`IDClass.cs:25-28`) |
| Client screenshot | `Input/Device.cs:218` — `Device::SaveScreenshot(int*)` @`0x0043A780`; real signature `char __cdecl Device::SaveScreenshot(PStringBase<char>*)`, writes `<prefs dir>ScreenShot%05d.jpg` (confirmed in `ac-headers/acclient.c`, `Device::SaveScreenshot`) |

### DAT parsing

Comes from the **`Chorizite.DatReaderWriter` package**, pulled transitively by `Chorizite.Core` —
that is the assembly `IDatReaderInterface.Portal`/`.Cell` are typed against.

| What | Type |
|---|---|
| `GfxObj` (0x01) | `Surfaces: List<uint>`, `VertexArray`, `Polygons: Dictionary<ushort, Polygon>` |
| `Polygon` | `PosSurface: short`, `VertexIds: List<short>`, `PosUVIndices: List<byte>` |
| `SWVertex` | `Origin`, `Normal`, `UVs: List<Vec2Duv>` |
| `Surface` (0x08) | `OrigTextureId: uint`, `OrigPaletteId`, `ColorValue`, `Translucency/Luminosity/Diffuse` |
| `SurfaceTexture` (0x05) | `Textures: List<uint>` |
| Raw record bytes | `DatDatabase.TryGetFileBytes(uint, out byte[])` — used for `baseRecordSha256` |
| Type enumeration | `DatDatabase.GetAllIdsOfType<T>()` |

> The **vendored** `external/DatReaderWriter/` sources are *newer* than the packaged 1.0.0
> (they wrap ids in `QualifiedDataId<T>`). This project deliberately does **not** reference them —
> see §6.

---

## 3. Queue entry schema v1 (frozen)

> **The contract is `tools/dat-patch/redline/schema_v1.json`** (draft-07, `additionalProperties:false`
> throughout). The plugin emits exactly `#/definitions/entry`; the three sample entries in
> `samples/redline.jsonl` are validated against it by `samples/emit_sample` (NJsonSchema).

### 3.0 SCHEMA — triangle index convention (PINNED — the pipeline resolves against this)

**`selection.triangles.indices` are indices into the record's fan-triangulated draw-triangle stream,
over EVERY polygon in CGfxObj record order — NOT drawn-only.** Polygon *pi* (0-based, record
positional order) contributes `len(v) − 2` triangles, emitted `(v[0], v[k], v[k+1])` for
`k = 1 … n−2`. Stippled / NoPos-filler polygons (`Stippling & 0x4`) stay IN the stream so an index
is a stable address into the record; the worker separately reports `triCountAll` vs `triCountDrawn`.

Evidence (each verified, not assumed):

| # | Claim | Source |
|---|---|---|
| 1 | The client stores draw polygons as a positional array `polygons[0..num_polygons-1]` and iterates it by array index | `ac-headers/acclient.c:379997` `Render::GfxObjUnderSelectionRay` — `while (!CPolygon::polygon_hits_ray(&mesh->polygons[v9], …)) { ++v9; if (v8 >= mesh->num_polygons) … }` |
| 2 | The client exposes **no** polygon index — its "PolygonIndex"/"PolygonID" are the part index + object id | same fn stores `pCurrentPart->physobj_index` / `get_physobj_id`; `Render::GetMouseSelectionPartIndex` (`acclient.c:380105`) returns that part index |
| 3 | The pipeline builds the stream over every polygon in record order, fan `(v[0],v[k],v[k+1])` | `tools/dat-patch/redline/queue_worker.py:284-291` `_tri_stream` (`for pi,p in enumerate(rec["polys"])`), `docs/redline/SCHEMA.md §2` |
| 4 | All-polys, not drawn-only, is explicit and load-bearing | `docs/redline/SCHEMA.md §2` "keeps *every* polygon in the stream … an index should be a stable address" |
| 5 | DatReaderWriter's `Polygons` keys are dense `0..n-1` and enumerate in record order | empirical, `samples/emit_sample`: `0x01000827` (137 polys), `0x0100004B`, `0x01000001` all `denseFrom0=True`, `dictIterEqAsc=True` |
| 6 | The fixture proves all-polys directly | fixture `rl-…-9d44` uses index **229** on `0x01000827` where `triDrawn=226`, `triAll=242` — 229 is in range only under all-polys |

The plugin implements this in `SelectionService.BuildFanStreamStatic` / `BuildFanTrianglePayload`,
and `samples/emit_sample` asserts byte-for-byte parity with a C# port of `_tri_stream` (picked
polys `{8,40,136}` → indices `[16,85,241]`, `parity=True`, `max 241 > triDrawn 226`).

**Why there is no `indexBasis` / `triCountAll` field in the entry** (the coordinator asked for one):
the frozen `triangles` object is `additionalProperties:false` and permits only
`{gfxObjId, indices, footprint, baseRecordSha256}` — adding a field would make every entry fail
validation. The convention is instead carried by matching the schema's stated definition exactly,
and the worker independently computes `triCountAll` / `triCountDrawn` and flags any off-by-N drift
(`queue_worker.py:376-378`). This is flagged as a schema/instruction conflict in the handoff report.

### 3.1 The shape

Emitted exactly as specified, verified by validating every sample line against
`schema_v1.json #/definitions/entry`:

```json
{"id":"rl-20260820-104500-a1b2","v":1,"createdAt":"2026-08-20T10:45:00.000Z","author":"sample-author",
 "clientRelease":{"kitTag":"acme-r9","portalSha256":"aa","highresSha256":null},
 "world":{"landblock":"0x016C0107","pos":[12.5,33.25,6],"heading":180},
 "camera":{"pos":[1,2,3],"lookAt":[1,3,3],"fovDeg":60},
 "selection":{"kind":"triangles",
   "objects":[{"objectId":"0x80000123","setupId":"0x0200042A","gfxObjId":"0x0100AB01",
               "worldFrame":{"pos":[1,2,3],"quat":[1,0,0,0]}}],
   "renderSurfaces":[{"rsId":"0x0600ABCD","surfaceId":"0x08001234",
                      "surfaceTextureId":"0x05004321","uvHints":[[0.25,0.75]]}],
   "triangles":{"gfxObjId":"0x0100AB01","indices":[4,5,6],
                "footprint":{"centroids":[[0,0,1]],"normals":[[0,0,1]],"areaM2":0.5},
                "baseRecordSha256":"deadbeef"},
   "screenLasso":{"points":[[10,20],[30,40]],"viewport":[1920,1080]}},
 "prompt":"this texture is too blurry, should look like weathered granite",
 "tags":["too-blurry","wrong-material"],"severity":2,"attachments":[],
 "guards":{"terrainProtected":false,"paletteRoute":true},"status":{"state":"queued"}}
```

Rules honoured in code:

* **Absent optionals are OMITTED, not null** (`JsonIgnoreCondition.WhenWritingNull`). The schema
  types `selection.triangles` / `selection.screenLasso` / etc. as objects with no `"null"` and is
  `additionalProperties:false`, so a present `null` fails validation as "object expected". Omission
  also satisfies the `anyOf[…, null]` scalars (`highresSha256`, `setupId`, `surfaceId`,
  `surfaceTextureId`), none of which are `required`. *(This reverses the earlier "emit null for
  stub fields" choice — the frozen schema forbids it. See §3.2.)*
* **`triangles.footprint` is object-LOCAL and emitted per selected TRIANGLE** (centroid + unit
  normal). Raw indices go stale when the pipeline reships a rebuilt mesh; the footprint survives, so
  the worker relocates by nearest current triangle centroid.
* **Kind is normalised to what the payload can back** (`AcmeRedlinePlugin.NormalizeKind`):
  `triangles` needs a real triangles block, `texture` needs ≥1 renderSurface, else `object`.
* Every payload member is a **property** and every vector a `float[]`. `System.Text.Json` silently
  drops public *fields* without `IncludeFields`, and serialises `Vector3` as `{"X":…}` rather than
  `[x,y,z]` — both would have broken the frozen shape.
* Every sub-object is filtered to what the schema accepts before emit: objects need a real `0x01`
  gfxObjId, renderSurfaces need a real `0x06` rsId, triangles need a gfxObjId + non-empty indices —
  anything that would fail validation is dropped, never emitted as a null the pipeline rejects
  (`SelectionService.BuildSelectionPayload`).
* `redline.jsonl` is **append-only**: `QueueWriter.Append` opens `FileMode.Append` /
  `FileShare.ReadWrite`, never truncates, and strips any embedded newline so one entry is always
  one line.
* `redline-status.jsonl` is **written by the pipeline only**. The plugin holds no writer for it.

### 3.2 Schema mismatches found and fixed

Validating my emit against the pipeline's `schema_v1.json` (which the pipeline agent wrote) surfaced
several places my initial models diverged. All fixed; flagged here per the "flag mismatches" rule:

| # | Mismatch | Fix |
|---|---|---|
| 1 | Status event used `id`; schema field is **`entryId`** | `RedlineStatusEvent.EntryId` (`Model/RedlineStatusEvent.cs`) |
| 2 | Status states were `verified` / `fixed-in-rX`; schema enum is **`{queued, in-progress, fixed}`** with the kit tag in a separate `release` field | `RedlineStatus` collapsed to three states; `RedlineStatusEvent.Release`/`By` added; consumers updated |
| 3 | `triangles.indices` emitted **polygon keys**; schema wants **fan-triangle-stream indices** (§3.0) | `BuildFanTrianglePayload` — proven at parity in `samples/` |
| 4 | Optional objects emitted as `null`; schema is `additionalProperties:false` with object types → **omit** | `WhenWritingNull` (§3.1) |
| 5 | `severity` capped at 3; schema allows **1–5** | clamp widened to `1..5` |
| 6 | `objects[].gfxObjId` / `renderSurfaces[].rsId` could be `null`; schema **requires** them | rows with a missing required id are dropped pre-emit |

**Remaining constraint (not a bug, a consequence):** `clientRelease.kitTag` + `portalSha256` and
`world.landblock` + `pos` are `required` and pattern-checked. Without `acme-meta.json` (no kit
installed) or when not in-world, those cannot be produced, so the plugin **blocks submit with a
panel message** rather than write a line the pipeline would reject. A report genuinely cannot exist
without a pinned release.

---

## 4. Picking strategy

**Object** — ride the client's own targeting/hover machinery rather than reinventing it.
`Render::set_selection_cursor(x, y, /*polyAccurate*/ true)` is armed on click; on the next
`OnAfterRender3D` the answer is read from `GetMouseSelectionObjectID()`,
`GetMouseSelectionPartIndex()` and `m_MouseSelectData`. `IClientBackend.SelectedObjectId` is the
managed fallback, but it carries no part or polygon index, which is why the bindings path is
primary. Two-phase by necessity: the client resolves the cursor during its own render pass.

**Triangles** — the runtime object guid + part index resolve to a dat identity
(`CObjectMaint::GetObjectA` → `CPartArray` → `CPhysicsPart.gfxobj[deg_level]` → `CGfxObj.m_DID`),
then the GfxObj is loaded through `IDatReaderInterface` and ray-cast **in object space**: the
camera ray from `Render::pick_ray` is rotated into the part's local frame by the conjugate of the
part quaternion and tested against every render polygon with Möller–Trumbore (fan-triangulating
n-gons the way the client draws them). Doing it on managed dat data rather than trusting the
client's index means (a) it is testable offline against a real `portal.dat`, and (b) it yields the
barycentric weights the texture step needs. The client's own `PolygonIndex` is kept as a
cross-check and as the fallback when the dat load fails.

**Texture** — `polygon → Polygon.PosSurface → GfxObj.Surfaces[i] → Surface (0x08) →
Surface.OrigTextureId → SurfaceTexture (0x05) → Textures[0] → RenderSurface (0x06)`, plus the UV at
the hit point interpolated from the polygon's per-corner UVs (`PosUVIndices` selects which of a
shared vertex's several UV pairs applies) with the barycentric weights from the raycast. `rsId` is
the load-bearing id because the pipeline repaints RenderSurfaces; `surfaceId`/`surfaceTextureId`
ride along so it can tell which of several Surfaces routed to the same pixels. A colour-only
Surface (no texture) still yields a chain, with the texture legs zeroed.

**Multi-select** — shift-click accumulates into `SelectionSet.Surfaces`, keyed by RenderSurface id
so repeats merge and each contributes another `uvHint`. Ctrl-click removes. Shift-drag draws a
screen-space lasso. "Select all instances of this texture in view" expands by RenderSurface id.

**`baseRecordSha256`** — SHA-256 of the GfxObj's raw dat record bytes
(`DatDatabase.TryGetFileBytes`), so the pipeline can tell whether the mesh it is holding is the
mesh the reporter was looking at.

---

## 4a. World-space highlight — the SkunkVision RenderHook method

### Provenance and licence

The technique is **SkunkVision RenderHook**, by **Gregory Kusnick (SkunkWorks)**, later ported by
**Virindi**. **MIT licensed** — adapted here with attribution. Sources read in full:

| File | What it gave us |
|---|---|
| `SVRenderHook.cpp` (585 lines) | The whole method: lazy vtable hooks armed in `PreBeginScene` behind an `FNeedHook()` gate and dropped in `PostEndScene` when idle; a once-per-frame copy of plugin state into plain statics; `HookVTable`/`UnhookVTable` ("Ripped from Decal's Direct3D9Hook.h"); the four shipping slots 44/51/83/89. |
| `HookAll.cpp` | A full-vtable trace build that hooks **every** slot and names each one — the **primary source** for every slot index we use. |
| `RenderHook-ReadMe.txt` | ATL project boilerplate; nothing load-bearing. |

**The core insight, kept intact: never draw your own overlay — mutate the client's own draw calls
in flight.** The highlight is then depth-correct, lit and pixel-aligned for free, because it *is*
the real geometry. That is what makes this work where a 2D draw list cannot.

### What changed for our target, and why

SkunkVision tints **terrain**, which AC submits through `DrawPrimitiveUP` — a user-pointer path, so
it walks the caller's vertex array and blends a colour into each vertex's diffuse before
forwarding (`SVRenderHook.cpp` `DrawPrimitiveUPH`, with the comment *"We happen to know that
DrawPrimitiveUP is used only for terrain"*). Objects are a different pipeline and that trick does
not carry. Two independent reasons, both verified:

1. **Objects are buffer-based, not user-pointer.** The path is
   `CPhysicsPart::Draw → RenderDeviceD3D::DrawMeshInternal (0x005A0470) → D3DPolyRender::DrawMesh
   (0x0059E8A0) → RenderMeshSubset (0x0059DA60) → ID3DXMesh::DrawSubset`. The mesh is built by
   `D3DXCreateMeshFVF` in `D3DPolyRender::ConstructMesh` (0x0059F0B0), so the actual
   `DrawIndexedPrimitive` is issued from **inside `d3dx9`**, not from acclient. It still travels
   through the device vtable we own — so slot 82 sees it — but there is no caller-owned vertex
   array to mutate. (A fallback path exists when `MeshBuffer::pMesh` is null:
   `RenderVertexBufferD3D::RenderIndexedPrimitives`, which calls `DrawIndexedPrimitive` at device
   vtable `+328` = slot 82. The two agree, which is a nice cross-check on the slot number.)

2. **Even if we could write the vertices, it would not reliably tint.** The object FVFs do carry a
   per-vertex diffuse — FVF `0x152` (stride 36) or `0x252` (stride 44, detail UVs), diffuse at byte
   24, matching `ACBindings/Generated/Rendering/D3D/CUSTOM_D3D_VERTEX.cs` and `CUSTOM_D3D_VERTEX2.cs`.
   But the fixed-function pipeline only *consumes* it as emissive when
   `MeshBuffer::burnedInStaticLights < 0`; otherwise colour comes from the material
   (`RenderDeviceD3D::SetFFDiffuseColorSource` / `SetFFAmbientColorSource`). Writing vertex diffuse
   would tint some objects and silently no-op on others.

**So for objects we re-issue the draw as a second, tinted pass.** After forwarding the real draw,
`DrawIndexedPrimitiveH` switches texture stage 0 to `D3DTA_TFACTOR` for both colour and alpha, puts
the tint in `D3DRS_TEXTUREFACTOR`, enables alpha blending (`SRCALPHA`/`INVSRCALPHA`), keeps the
depth **test** on but turns depth **writes** off, and applies a small negative `D3DRS_DEPTHBIAS` so
the tint wins the coplanar z-fight without poking through geometry in front of it. Then it re-issues
the identical call and restores every state it touched. Same geometry, same transform, same
visibility — a true overlay. Tinting *after* the real draw matters: the tint blends over the
finished surface instead of being overwritten by it.

### Draw-call → part correlation — **verified, not inferred**

This is the part that would normally require heuristics (stream-source fingerprinting, index-range
matching). It does not, because the client keeps a global that says exactly what it is drawing:

```
RenderDeviceD3D::s_current_physics_part   ->  CPhysicsPart*
  ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs:20
    public static CPhysicsPart** s_current_physics_part = (CPhysicsPart**)0x008EE3D8;
  PDB (acclient.txt): ?s_current_physics_part@RenderDeviceD3D@@1PAVCPhysicsPart@@A
```

`CPhysicsPart::Draw` sets it immediately before calling `DrawMesh` and zeroes it straight after, so
it is non-null for exactly the duration of one part's mesh draw — **including inside the D3DX
`DrawSubset` that issues our hooked `DrawIndexedPrimitive`**. From the part:
`gfxobj[deg_level] → CGfxObj → BaseClass_DBObj.m_DID` = the GfxObj dat id (0x01......), which is
precisely the key `SelectionService` already stores.

**Known gap, verified rather than discovered later:** the global is **null during the deferred alpha
pass**. Translucent meshes are queued by `D3DPolyRender::AddMeshToAlphaList` (0x0059D240) as
`AlphaListEntry{MeshBuffer*, surfaceNum, CSurface*, CMaterial*, worldMatrix, …}`
(`ACBindings/Generated/Rendering/AlphaListEntry.cs`) and flushed later by `FlushAlphaList`
(0x0059E3F0), by which time the `CPhysicsPart` is gone. So **a translucent object gets no
object-kind tint** — but it still gets the texture-kind tint, because `AlphaListEntry` keeps the
`CSurface*`.

### Texture correlation — **also verified; no pointer fingerprinting needed**

The original plan was to map `IDirect3DTexture9*` → dat RS id by learning it during the picked
object's draws. That turned out to be unnecessary for the common case, because the client publishes
the currently-bound surface:

```
Render::curr_surface = (CSurface**)0x00867380      ACBindings/Generated/Rendering/Render.cs:87
```

It is assigned on every `D3DPolyRender::SetSurface` (0x0059D520) — the single funnel every textured
draw passes through. From there, two reads, both with PDB-confirmed offsets:

* **Surface id (0x08......)** — `CSurface` derives from `DBObj`, so `BaseClass_DBObj.m_DID`. One
  pointer chase, safe in the hot path.
* **RenderSurface id (0x06......)** — `CSurface::base1map` (offset 108) → `ImgTex*`, then
  `ImgTex::GetSurfaceDID(IDClass*)` @`0x0053FE40`
  (`ACBindings/Generated/Dats/DBObjs/ImgTex.cs:200`), which reads `m_SourceLevels[0]` and honours
  `Render::ShouldDropHighDetail()` by returning `[1]` at reduced detail.

The RS id is the one that matters — the dat-patch pipeline repaints RenderSurfaces, and several
different `Surface` records can route to the same one, which is exactly what **"select all instances
of this texture in view"** needs. So the tint predicate matches on RS id, and only runs the
`ImgTex` walk when the user actually has textures selected.

`TextureRegistry` and the `SetTexture` (slot 65) hook are retained as the **observational
fallback**: they record which native texture was bound while a known Surface was current, which
covers any path where `curr_surface` is not the authority. It is a fallback by design — see the
class remarks for why learning was preferred over walking `ImgTex::texture_table`.

### Coexistence with Chorizite's hooks — the footgun, and how it is avoided

Two independent vtable swaps on one slot is a crash. Verified this cannot happen:

**Chorizite does not hook the IDirect3DDevice9 vtable at all.** Its D3D touchpoints are *inline
detours on client functions*, installed with **Reloaded.Hooks 4.3.3**:

* `external/chorizite/Chorizite/Chorizite.NativeClientBootstrapper/Hooks/DirectXHooks.cs` —
  `RenderDeviceD3D::EndScene` (signature scan, drives `Render2D`),
  `RenderDeviceD3D::OnDeviceDisplayModeChange` (device create/reset), and the Win32 `WndProc`.
* `.../Hooks/HookBase.cs` — `ReloadedHooks.Instance.CreateHook<T>(...).Activate()`.

Chorizite *does* have vtable-patching machinery — `class VHook` in `.../AcClient/_Hook.cs`
(`PatchVCall` + `Marshal.GetFunctionPointerForDelegate`, with a `hookers` list for `Cleanup()`) —
but it targets **client C++ vtables**, never the D3D device. So our slots (16 / 65 / 82) are
disjoint from everything Chorizite installs.

Two defensive invariants are kept anyway, both SkunkVision's, so we stay safe if that ever changes:

* `HookVTable` is a **no-op when the slot already holds our detour** — arming is idempotent, so the
  per-frame arm check is free and cannot double-install.
* `UnhookVTable` **restores only if the slot still holds our detour**
  (`if (lpHooked == lpDetour)`). This is the single most important line in the technique. If a third
  party hooked the same slot *after* us, their detour is what is installed and their saved
  "original" is *our* detour; blindly restoring would uninstall them **and** leave them calling into
  memory we are about to free. We refuse, and mark ourselves pinned.

One accepted consequence: our detours also see Chorizite's own 2D draws, since `DX9RenderInterface`
renders inside the `EndScene` detour on the same device. Harmless — the predicate only matches draws
whose current `CPhysicsPart` resolves to a selected GfxObj, and UI draws have no `CPhysicsPart`.

### Getting the device pointer

Two paths, preferred order:

1. **Ask Chorizite.** `IChoriziteBackend.Renderer` is a `DX9RenderInterface` with
   `public IntPtr NativeDevice => D3Ddevice?.NativePointer ?? IntPtr.Zero`
   (`.../Render/DX9RenderInterface.cs:92`) — the pointer Chorizite captured at device creation.
   Reached by **reflection**, because `Chorizite.NativeClientBootstrapper` is not a package a plugin
   can reference and `IRenderer` does not declare `NativeDevice`. The obvious route,
   `IRenderer.GraphicsDevice.NativeDevice`, is a dead end: `DX9RenderInterface.GraphicsDevice`
   **throws `NotImplementedException`** (`DX9RenderInterface.cs:95`).
2. **Read it out of the client.** `RenderDeviceD3D::m_pDirect3DDevice` at byte offset **1128**
   (PDB: `LF_MEMBER, offset = 1128, member name = 'm_pDirect3DDevice'`; declared in
   `ACBindings/Generated/Rendering/D3D/RenderDeviceD3D.cs`), off the singleton
   `RenderDevice::render_device = (RenderDevice**)0x00870340`. **Independent cross-check:** Chorizite
   hardcodes the same 1128 — `_unmanagedD3DPtr = *(int*)(a + 1128)` in `DirectXHooks.cs`.

### Arm / disarm discipline

Straight from SkunkVision's `FNeedHook()` gate:

* `OverlayRenderer.HandleBeforeRender3D` (our `PreBeginScene`) publishes the frame's
  `HighlightState` snapshot, then calls `DeviceHooks.SyncArmState(want && !HighlightState.Idle)`.
* Hooks are installed only while something is actually selected/hovered, and dropped the moment
  nothing is. Idle cost is zero — not "a cheap branch", *zero*, because the detours are not in the
  vtable at all.
* `HighlightState` is written exactly once per frame into **plain statics** (SkunkVision's
  `s_fSlope = m_fSlope; …`). The detours never allocate, never lock and never touch
  `SelectionService` — a lock inside `DrawIndexedPrimitive` would deadlock against the thread that
  owns the device.
* `IDirect3DDevice9::Reset` (slot 16) is hooked so a device reset invalidates the texture map,
  drops the hooks, **and forgets the saved vtable entries** (`InvalidateDevice`) — writing
  pre-reset function pointers back into a rebuilt vtable would install stale detours. This is *why* it is hooked: `IRenderer` exposes no reset event —
  `OnGraphicsPreReset`/`OnGraphicsPostReset` live on `IGraphicsDevice`
  (`Chorizite.Core/Render/IGraphicsDevice.cs:58,63`), which is unreachable here (see above). Our own
  hook is the authority.

### Unload safety (.NET collectible-ALC semantics)

Chorizite loads plugins into a **collectible `AssemblyLoadContext`**
(`.../Plugins/AssemblyLoader/AssemblyPluginLoadContext.cs`). Our detours are `[UnmanagedCallersOnly]`
stubs in *this* assembly, so their addresses die with the ALC. A vtable slot still pointing at one
after unload is a guaranteed crash on the next frame.

**Chosen answer: refuse hot-unload while armed.** `DeviceHooks.Dispose` marshals the disarm onto the
render thread via `IChoriziteBackend.Invoke` — the thread that owns the device — and **blocks (5 s
bounded) until it is confirmed**, so the vtable is clean before Dispose returns. If the disarm cannot
be confirmed (no render thread, or a third party hooked over our slot) we set `Pinned`, take a
process-lifetime `GCHandle`, log an error telling the user to **restart the client rather than
reload the plugin**, and leave the detours installed but **inert** (`HighlightState.Active` is false,
so each one immediately tail-calls the original).

The alternative — a small `VirtualAlloc`'d native thunk whose jump target we rewrite to the saved
original on unload — is genuinely unload-safe and is the right answer if this ever needs to survive
plugin reloads. **Not done here** because it means hand-assembled x86 (a 6-byte
`jmp dword ptr [cell]` per slot) that cannot be validated without a live 32-bit client, and a wrong
thunk is silent memory corruption rather than a loud failure. Documented, with the exact shape, on
`DeviceHooks.AllocateNativeThunks`. Reloaded.Hooks would provide trampolines, but it is referenced
only by `Chorizite.NativeClientBootstrapper.csproj`, is not on a plugin's dependency path, and
pulling it in would put a **second hooking engine** in the process — the exact class of footgun this
whole section exists to avoid.

### Wiring to the selection

`OverlayRenderer.HandleBeforeRender3D` publishes, every frame:

| Source | Tint |
|---|---|
| `SelectionService.Current.Objects` + `TriangleGfxObjId` | **solid** `SelectedArgb` |
| `SelectionService.HoveredObjectId` → GfxObj id | **pulsing** `HoveredArgb`, alpha × `HoverPulse` (0.45–1.0 at ~1.1 Hz) |
| `SelectionService.Current.Surfaces` (RS ids) | solid, matched via `curr_surface` → RS id |
| `QueueWriter.ReadOwnEntries` + `StatusReader` | per-entry status colour, same palette as the 2D legend (`HighlightState.ArgbForState` → `OverlayRenderer.ColorForState`) |

## 4b. Picking & feedback (making the experience real)

### The world→screen projection source (verified)

The lasso needs to project geometry to the screen. The projection is read from the client's live
render state, not guessed:

* `RenderDevice::m_GState` — a `GraphicsStatesType` at
  `ACBindings/Generated/Rendering/RenderDevice.cs:116` — holds `ModelToWorldMatrix`,
  `WorldToViewMatrix`, `ViewToClipMatrix` (`RenderDevice.cs:55-57`) and the viewport is on the same
  struct (`m_viewportWidth/Height`, `:101-102`), off the singleton `render_device = 0x00870340`.
* **These ARE the matrices D3D renders with.** `RenderDeviceD3D::SetViewToClipMatrix`
  (`ac-headers/acclient.c`) does `qmemcpy(&this->m_GState.ViewToClipMatrix, _m)` **and then calls
  the device `SetTransform` with state `3` = `D3DTS_PROJECTION`**; its siblings push
  `WorldToView` as `D3DTS_VIEW(2)` and `ModelToWorld` as `D3DTS_WORLD(256)`. So a point run through
  them lands exactly where the player sees it. `Matrix4` is row-major `_11.._44`, and AC is
  fixed-function D3D9 (row-vector, LH clip, y-down screen) — implemented to that standard in
  `Lib/Projection.cs`. The arithmetic (transform · divide · viewport map) has an offline self-test
  in `samples/emit_sample` (PASS); the on-screen *look* is the only unvalidated part.

### 1. Drag-lasso → triangles — **implemented**

Shift-drag draws a screen lasso; on release `SelectionService.EndLasso` defers resolution to the
render tick. `DeviceHooks` captures the target object's **own MVP** (`m_GState.ModelToWorld ·
WorldToView · ViewToClip`) during its `DrawIndexedPrimitive` — so the GfxObj's raw model-space
vertices project with the client's exact transform, sidestepping any cell/landblock reconstruction.
`ResolveLassoWithMvp` projects every draw-triangle's centroid, point-in-polygon tests it against the
lasso, and adds the hit triangles' **source polygons**. Emission reuses `BuildFanStreamStatic`, so
the indices are the identical fan-triangle-all-polys stream the click path and the pipeline use
(§3.0). The raw lasso polygon + viewport are still emitted in `selection.screenLasso` regardless.

### 2. "All instances of this texture in view" — **implemented**

Selecting the RS id immediately lights up **every** draw that binds it this frame (the texture tint
pass matches on `curr_surface → ImgTex::GetSurfaceDID` — the same RS-id map, no texture-cache walk).
A frame-accumulation collector (`DeviceHooks.ArmTextureCollect(rsId, frames=3)`) records the
distinct GfxObjs carrying the texture over a short window for the panel's instance count. **Lifecycle:**
`SelectAllInstancesOfTexture` raises a request → `OverlayRenderer` arms the collector and keeps the
hooks live → the draw detour appends matching GfxObjs → `TickTextureCollect` closes the window at 0
frames and hands the set back → `ApplyTextureInView` records the count. The report payload stays a
single RS id (the pipeline fixes the RenderSurface once for every instance).

### 3. In-world status overlay — **implemented**

With the toggle on, `OverlayRenderer.BuildStatusTints` reconciles this account's stored annotations
(`redline-status.jsonl`, last-event-wins via `StatusReader`) back to live draws using the same
correlation as the highlight: object/triangle annotations → GfxObj id (`current-physics-part`),
texture annotations → RenderSurface id (`curr_surface`). The `DeviceHooks` tint pass then glows each
target by state — **queued = yellow, in-progress = blue, fixed = green** — so a player watches their
spot go yellow while queued and green once a fix ships. (Triangle annotations tint at whole-GfxObj
granularity — see §5 stubs.)

### 4. My-reports + double-submit guard — **implemented**

The panel's "my reports" list filters `QueueWriter.ReadOwnEntries` to the logged-in account
(`AC.ACPlugin.Game.AccountName`) and shows each entry's derived status. `HandleSubmit` computes a
signature — kind + sorted target ids + trimmed prompt — and refuses a second identical submission in
the same session (`_submittedSignatures`), so a double-click can't double-file.

## 5. Implemented vs stubbed

### Implemented and exercised

* Plugin manifest, entry class, DI, lifecycle, settings serialization — **builds clean**.
* Schema v1 emission — round-trip verified (see §3).
* `QueueWriter`: append-only JSONL, `shots/` management, id minting (`rl-<utc>-<4hex>`), read-back
  for the reports list.
* `StatusReader`: mtime/length-gated re-read of `redline-status.jsonl`, last-event-wins fold,
  `FileShare.ReadWrite` so a concurrent pipeline append is never blocked.
* `KitMeta`: sidecar load + probe order, release stamping, terrain-protected / palette-route guard
  evaluation, and the pre-submit warning text.
* `SelectionService`: the full pick→dat-identity→texture-chain→payload path, the object-space
  Möller–Trumbore raycast, UV interpolation, Newell-normal + area footprint, record hashing,
  multi-select accumulation. `RaycastGfxObj` and `RayTriangle` are `public static` and side-effect
  free specifically so they can be unit-tested against a real `portal.dat`.
* `CaptureService`: world (landblock/pos/heading) and camera (pos/lookAt/fov) capture.
* `OverlayRenderer`: real hook subscription, HUD, lasso trail, status legend, per-frame
  `HighlightState` publish and hook arming.
* `DeviceHooks` + `D3D9` + `HighlightState` + `TextureRegistry`: the **world-space highlight** —
  vtable swap with SkunkVision's idempotence + only-restore-if-ours discipline, verified
  draw→part correlation via `s_current_physics_part`, verified texture correlation via
  `Render::curr_surface`, the `TEXTUREFACTOR` tint pass with full state save/restore, lazy
  arm/disarm, `Reset` handling, and synchronous-disarm-on-dispose. Compiles clean; **not executed
  against a live client** (this repo has no Windows AC client to run), so treat the runtime
  behaviour as reviewed-but-unproven — see §5a.
* `RedlinePanel`: prompt, seven quick tags, severity 1–3, submit, clear, status-overlay toggle,
  "my reports" list with per-entry status colour.
* **End-to-end selection → annotation → queue flow** (`AcmeRedlinePlugin.HandleSubmit`): live
  selection shown in the panel with the actual target ids → prompt/tags/severity → schema-v1 entry
  built from `SelectionService` + `KitMeta` guards + `CaptureService` world/camera → `QueueWriter`
  append, with a pre-flight that blocks (with a panel reason) when the selection is empty or no kit
  release can be stamped. Multi-select (shift-add textures, ctrl-remove, lasso) feeds the same path.
* **Triangle-index emission** matching the frozen convention (§3.0), **proven at parity** with
  `queue_worker._tri_stream` and **validated** end-to-end — `samples/emit_sample` emits three
  entries (triangles/texture/object) and checks each against `schema_v1.json`. Output in
  `samples/redline.jsonl`.
* **Drag-lasso → triangles, "all instances in view", in-world status overlay, my-reports filter
  and double-submit dedupe** (§4b) — all against verified client memory + the client's own MVP /
  correlation globals. The projection arithmetic has an offline self-test (PASS); on-screen look is
  unvalidated (no live client here).

### Stubbed, and why

| Stub | Why | TODO lives at |
|---|---|---|
| **Screenshot capture** — DECISION: attachments left empty (honest) | Chorizite exposes **no pixel readback** — `ITexture.SetData` has no getter, `IGraphicsDevice` has no `ReadPixels`/`GetData` (grep across `Chorizite/`, `RmlUiPlugin/`, `ACPlugin/` finds nothing). The client's own `Device::SaveScreenshot` **works and now captures the in-world DeviceHooks highlight for free** (it grabs the back buffer), but returns its path via a `PStringBase<char>*` out-param the bindings type as `int*`; a wrong refcount on the `PSRefBufferCharData` corrupts the client heap, and it can't be validated without a live client. An out-param-free variant (pick up the newest `ScreenShot*.jpg` from the prefs dir) and an external OBS/WGC path are both documented. The emitted `attachments` is `[]` and **never names a file that didn't land**. | `ClientMemory.TrySaveClientScreenshot`, `CaptureService.TryCaptureShots` |
| **Translucent objects get no object-kind tint** | Verified client behaviour, not a coding gap: `RenderDeviceD3D::s_current_physics_part` is null during the deferred alpha pass (`AddMeshToAlphaList` → `FlushAlphaList`), so a draw cannot be correlated back to its part. Texture-kind tint still works there, because `AlphaListEntry` keeps the `CSurface*`. Fixing it means correlating on `MeshBuffer*`/`CSurface*` captured at queue time. | `DeviceHooks.CurrentGfxObjId` |
| **Unload-safe native thunks** | Hot-unload while armed is refused instead. Requires hand-assembled x86 that cannot be validated without a live 32-bit client; a wrong thunk corrupts memory silently. Full design recorded. | `DeviceHooks.AllocateNativeThunks` |
| **Triangle-granular status tint** | The in-world status overlay tints a *reported-triangle* annotation at whole-GfxObj granularity, not per-triangle — the draw detour correlates a draw to its GfxObj, but re-issuing only the reported fan triangles would need per-index slicing in the hot path. Object and texture status tints are exact; triangle is the documented approximation. | `OverlayRenderer.BuildStatusTints` |
| **Cross-cell picking** | Camera and part frames are only directly comparable inside one cell for the *click* raycast. Rebasing needs `Frame::localtoglobal`. (The *lasso* avoids this entirely — it projects with the client's own captured MVP.) Guarded rather than producing garbage geometry. | `SelectionService.RaycastObjectSpace` |
| **Client graphics settings** | Reachable (`Render.m_RenderPrefs`, `RenderDevice.m_config/m_caps/m_displayInfo`, `UserPreferences`) but **schema v1 has no field for it**, so capturing it would mean breaking the frozen contract. Recorded for v2. | `CaptureService.CaptureGraphicsSettings` |
| **Configurable hotkey** | Chorizite has no plugin keybinding registry (`Chorizite.Core/Input/*` is raw events; `ChoriziteConfig` has no input section). F8 is hardcoded. | `AcmeRedlinePlugin.HandleKeyDown` |

---

### 5a. Verified vs assumed (world highlight)

Everything the highlight depends on, and how far it is actually nailed down:

| Claim | Status | Evidence |
|---|---|---|
| D3D9 vtable slot indices (16, 65, 82, and the Get/Set state slots) | **Verified — primary source** | Extracted from SkunkVision `HookAll.cpp`, which hooks every slot and names each. Cross-checked: its shipping set 44/51/83/89 matches, and the decomp's `DrawIndexedPrimitive` at device vtable `+328` = slot 82 agrees independently. |
| `RenderDeviceD3D::m_pDirect3DDevice` at offset 1128 | **Verified — two sources** | PDB `LF_MEMBER, offset = 1128`; and Chorizite hardcodes the same value in `DirectXHooks.cs`. |
| `s_current_physics_part` @ `0x008EE3D8` is the drawing part | **Verified** | Declared in `ACBindings/.../RenderDeviceD3D.cs:20`; PDB symbol `?s_current_physics_part@RenderDeviceD3D@@1PAVCPhysicsPart@@A`; set/cleared around `DrawMesh` inside `CPhysicsPart::Draw`. |
| It is null during the alpha pass | **Verified** | `AddMeshToAlphaList` (0x0059D240) → `AlphaListEntry` (no part) → `FlushAlphaList` (0x0059E3F0). Documented as a known gap, not discovered later. |
| `Render::curr_surface` @ `0x00867380` names the bound Surface | **Verified** | `ACBindings/.../Render.cs:87`; assigned in `D3DPolyRender::SetSurface` (0x0059D520), the single funnel for textured draws. |
| `CSurface::base1map` (+108) → `ImgTex`, `GetSurfaceDID` → RS id | **Verified** | PDB offsets; `ImgTex::GetSurfaceDID` @`0x0053FE40` in `ACBindings/.../ImgTex.cs:200`. |
| Object geometry reaches D3D via `ID3DXMesh::DrawSubset` | **Verified** | `D3DPolyRender::ConstructMesh` (0x0059F0B0) builds it with `D3DXCreateMeshFVF`; `RenderMeshSubset` (0x0059DA60) draws it. Implication: the `DrawIndexedPrimitive` originates inside `d3dx9` but still goes through our hooked vtable. |
| Per-vertex diffuse exists but is unreliable as a tint | **Verified** | FVF `0x152`/`0x252`, diffuse at byte 24; consumed as emissive only when `burnedInStaticLights < 0`. This is *why* the second-pass approach was chosen over SkunkVision's vertex mutation. |
| Chorizite does not hook the D3D vtable | **Verified** | Full read of `DirectXHooks.cs`, `HookBase.cs`, `_Hook.cs`; its detours are Reloaded.Hooks inline hooks on client functions, and `VHook` targets client C++ vtables. |
| `D3DRS_*` / `D3DTSS_*` / `D3DTOP_*` / `D3DTA_*` constant values | **Documented ABI** | Public `d3d9types.h`. Not reverse-engineered, not guessed. |
| The tint pass *looks right* on screen | **ASSUMED — unproven** | Depth bias magnitude, blend factors and whether stage 1+ needs disabling are judgement calls that need an eye test on a real client. Nothing here has been run. |
| `[UnmanagedCallersOnly]` stdcall detours are ABI-correct for COM on x86 | **ASSUMED — by analogy** | Chorizite does exactly this in `DirectXHooks.cs` (`CallConvStdcall` for `WndProc`, `CallConvMemberFunction` for thiscall client methods). COM methods are stdcall-with-this, which is the shape used here — but it has not been executed. |

**Bottom line:** the *correlation* and *plumbing* are grounded in real, cited symbols; the *visual
tuning* and *live ABI behaviour* are the parts that still need a client to validate.

## 6. Framework limitations that changed the design

1. **No 3D overlay path *through the supported API*.** The plugin-facing renderer is a 2D draw
   list (`IDrawList`: rect / filled-rect / texture / text / ring — no line, no triangle, no depth),
   and `IRenderer.GraphicsDevice`, which would have exposed `IGraphicsDevice.DrawElements` and the
   reset events, **throws `NotImplementedException`** in the client backend
   (`DX9RenderInterface.cs:95`). So there is no supported way to tint world geometry.
   **Resolved by going under the API**: `DeviceHooks` hooks the client's own IDirect3DDevice9
   vtable and re-issues matching draws as a tinted pass — the SkunkVision RenderHook method (§4a).
   The 2D overlay keeps only what belongs in screen space. This is the single biggest design
   change in the plugin, and it is why `Lib/D3D9.cs` and `Services/DeviceHooks.cs` exist.
2. **No pixel readback**, so `attachments` ships empty rather than pointing at files that do not
   exist. The schema field is still emitted.
3. **`IFontManager.GetFont(string, int)` returns `null` unconditionally** in Chorizite.Core's
   implementation (`Render/FontManager.cs:57-60`); only `GetFont(uint datFontId)` works. Rather
   than hardcode a magic Font id, the HUD takes the first `Font` record the portal dat actually
   contains via `GetAllIdsOfType<Font>()`, overridable through `settings.hudFontDid`. Null means
   "skip the text", never "crash".
4. **RmlUi form values are not readable through the `Element` handle.** `GetValue()`/`SetValue()`
   exist only on the concrete `ElementFormControlInput`, which has no public constructor and no
   downcast helper from the `Element` that `GetElementById` returns (verified by reflecting over
   RmlUi.Net 1.0.1). The panel therefore reads/writes via `GetAttribute("value")` /
   `SetAttribute("value")` plus the `change` event's `Parameters["value"]` — RmlUi's own
   convention, no cast needed.
5. **No `window` RML template.** RmlUiPlugin registers only `modal` and `tabpanel`
   (`RmlUiPlugin.cs:95-96`), so the panel uses a plain `<body>`, matching
   `ACPlugin/assets/panels/Indicators.rml`.
6. **The dat directory is not published to plugins.** `IDatReaderInterface` hands out database
   objects, not paths, and `FSDatReader` keeps its root private — so `acme-meta.json` is probed in
   the plugin directory / data directory / parent, or pinned via `settings.kitMetaPath`.
7. **DatReaderWriter identity.** `IDatReaderInterface.Portal` is typed against the
   `Chorizite.DatReaderWriter` **package** that `Chorizite.Core` depends on. Adding
   `external/DatReaderWriter/` as a second `ProjectReference` would create two `DatReaderWriter.dll`
   identities and break `Portal`/`Cell`. So the vendored DatReaderWriter is deliberately unused —
   note that it is *newer* than the package (ids wrapped in `QualifiedDataId<T>` vs bare `uint`),
   which is exactly the kind of mismatch that would have silently broken the build.
8. **Package-version alignment.** The shipped plugins pin `Autofac 8.2.0` /
   `Microsoft.Extensions.Logging.Abstractions 9.0.0` because they compile against the
   `Chorizite.Core` *package* 0.0.13. Against the **vendored** Chorizite.Core project those pins are
   a NuGet downgrade (NU1605), so this project pins 8.4.0 / 9.0.9 to match.

---

## 7. Build

```bash
cd AcmeRedline
DOTNET_ROLL_FORWARD=LatestMajor dotnet build -c Release
```

Output lands in `AcmeRedline/bin/net8.0/`:

```
AcmeRedline.dll          <- entryfile
manifest.json
assets/panels/Redline.rml
```

Framework assemblies are **not** copied (`Private="false" ExcludeAssets="runtime"` on the project
references, `ExcludeAssets="runtime"` — plus `native` for RmlUi.Net — on the package references),
because the Chorizite host owns them at runtime. This mirrors
`external/chorizite/ACPlugin/AC.csproj`.

### Build contracts, and why some refs stay on NuGet

Real Chorizite plugins reference the framework as **NuGet packages**
(`ACPlugin/AC.csproj`, `RmlUiPlugin/RmlUi.csproj`). Per the brief, this project uses the **vendored
csproj equivalents** wherever one exists in a compatible shape:

* `ProjectReference` → `external/chorizite/Chorizite/Chorizite.Core/Chorizite.Core.csproj`
* `ProjectReference` → `external/chorizite/ACBindings/Chorizite.ACBindings.csproj`

The remaining three stay on NuGet, for concrete reasons:

* **`Chorizite.Plugins.RmlUi`** — the vendored `RmlUiPlugin/RmlUi.csproj` sets
  `GeneratePackageOnBuild=True` and runs a post-build `DeleteFiles` target, i.e. building it writes
  `.nupkg` and deletes files inside `external/`. It also `PackageReference`s `Chorizite.Core 0.0.13`,
  which would sit alongside the vendored Chorizite.Core project.
* **`Chorizite.Plugins.AC`** — same shape (`ACPlugin/AC.csproj`), used only for
  `Game.AccountName`.
* **`Chorizite.DatReaderWriter`** — arrives transitively; see limitation 7 above.

NuGet resolves the vendored **project** reference over the transitive **package** of the same name
(verified: the compile line uses
`external/chorizite/Chorizite/Chorizite.Core/obj/Release/ref/Chorizite.Core.dll`, not the 0.0.13
package).

## 8. Install

Chorizite loads plugins from `<ChoriziteConfig.PluginDirectory>` = `<base>/plugins`
(`Chorizite.Core/ChoriziteConfig.cs:44`), scanning each **subdirectory** for `manifest.json`
(`Chorizite.Core/Plugins/PluginManager.cs:297-300`).

```
<chorizite base>/plugins/AcmeRedline/
    manifest.json
    AcmeRedline.dll
    assets/panels/Redline.rml
```

i.e. copy the contents of `bin/net8.0/` into a directory named `AcmeRedline` under the plugin
directory. The manifest declares `"environments": ["Client"]` and depends on `RmlUi` and `AC`, both
of which ship with Chorizite.

For live-reload development, drop a `manifest.dev.json` beside `manifest.json`
(`Chorizite.Core/Plugins/PluginInstance.cs:176`):

```json
{ "source": "/home/wbterminal/WorldBuilder-ACME-Edition/AcmeRedline",
  "bin":    "/home/wbterminal/WorldBuilder-ACME-Edition/AcmeRedline/bin/net8.0" }
```

## 9. Using it

* **F8** toggles the panel.
* **Click** a surface to pick it (object + polygon + texture chain in one go).
* **Shift-click** adds another texture to the selection; **shift-drag** draws a lasso.
* **Ctrl-click** removes a target.
* Type what is wrong, pick quick tags and a severity, hit **Submit redline**.
* If the selection touches a terrain-protected or palette-routed surface, an amber warning appears
  **before** submit, and the entry carries the matching `guards` flag.
* The **my reports** list shows every entry from `redline.jsonl` with its live state from
  `redline-status.jsonl`.
* Selected geometry is tinted **in the world**, solid; the hovered target pulses. With the status
  overlay on, previously-annotated objects are tinted by their pipeline state. Set
  `worldHighlightEnabled: false` to disable the D3D hooks entirely.

### Licence note

The world-highlight technique is adapted from **SkunkVision RenderHook** (Gregory Kusnick /
SkunkWorks, ported by Virindi), **MIT licensed**. See §4a. Attribution is also carried in the
headers of `Lib/D3D9.cs` and `Services/DeviceHooks.cs`.

## 10. Settings

Persisted through `ISerializeSettings<RedlineSettings>`:

| Key | Default | Meaning |
|---|---|---|
| `queueDir` | `""` → `<StorageDirectory>/AcmeRedline/redline` | Where `redline.jsonl`, `redline-status.jsonl` and `shots/` live. |
| `kitMetaPath` | `""` → probe | Explicit path to `acme-meta.json`. |
| `overlayEnabled` | `true` | Draw the overlay and enable picking. |
| `statusOverlayEnabled` | `false` | Tint by pipeline status. |
| `worldHighlightEnabled` | `true` | Enable the IDirect3DDevice9 vtable hooks that draw the world-space highlight. Separate from `overlayEnabled` on purpose — a user chasing a graphics problem can turn just the hooks off without losing picking. |
| `defaultSeverity` | `2` | Pre-selected severity. |
| `hudFontDid` | `0` → first `Font` in portal.dat | Dat Font id for HUD text. |
