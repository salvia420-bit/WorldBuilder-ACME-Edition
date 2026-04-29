# Upstream Sync Notes

This file tracks the state of porting commits from `Vanquish-6/WorldBuilder-ACME-Edition`
(upstream) into `salvia420-bit/WorldBuilder-ACME-Edition` (this fork). It exists because
the two histories **share no common ancestor** — `git merge-base` returns nothing —
so a normal `git pull upstream master` is impossible. All sync is manual or
patch-by-patch.

Last full audit: **2026-04-26** (incremental: 2026-04-29 — `44f47f8` gizmo improvement and `fa7c58c` surface-browser paging + terrain conformance ported; later same day `b9ffe3e` dungeon view fill ported, `38b22c2` texture fixes / docs ported partially, and `15cb9ed` logging + dat-export fix ported in full — closed the audit window. Also same day `3457ea7` SpellEditor copy spell ported in full, `39d68d7` WorldGen tweaks ported partially, and `4dc3983` ported in full across two passes — first the dungeon object-browser slice, then the property-pickers + entity-enums + Weenie-editor + remaining dungeon/landscape wire-up. Final 04-29 pass: `67912c1` SQL-export reposition reclassified ✅ PORTED — verification showed the SQL connector + `InstanceRepositionService` + `RepositionContext` + `LandblockInstanceRecord` + DB-export wiring were all already in place from prior slice work and locally extended with indoor-building delta support; doc had it as TODO. Also ported `d780244` spell-editor UX improvements (presets, undo, validation, toast, paging, sort, change tracking) — spell-only slice; the landscape/dungeon/InstancePlacementsPanelView pieces depend on `d512ef2` and stay deferred. Auto-merge produced two `CopySpell` methods (upstream's new one + our 3457ea7 one); resolved with `55604d2`'s pattern (delete the duplicate, hoist DB-clone block into `CloneDbSpellRecord` helper) — so `55604d2` lands ✅ PORTED in the same pass. **2026-04-29 final**: `239c0c1` (new monster builder) + `92fafff` (monster editor improvements) ported — Cluster B almost closed, only `d512ef2` (ACE DB instance placements) remains TODO. The `239c0c1` cherry-pick auto-merged most of the file but conflicted on `LandscapeEditorViewModel.GenerateWorld` (where upstream's pre-commit base differs from ours: upstream had FreshStart + the big GenerateWorld upgrade; we have the simpler version). Resolution: dropped the entire upstream GenerateWorld block and kept ours — Monster editor doesn't depend on it. `GameScene` conflict bringing in duplicate Wave-G content was resolved by keeping only the two genuinely-new methods (`InvalidateEnvCellsForLandblock`, `PreviewBuildingInterior`); `QueueModelWarmup` + `_pendingModelWarmup` were skipped (consistent with the deliberate Wave G skips). Added a stub `DocumentManager.SkipDatStatics { get; set; }` property so the cherry-picked GameScene retry-loop guard compiles. Also backfilled `38b22c2`'s previously-skipped Monster pieces: `ReplaceRenderSurfaceAsync` [RelayCommand] + the GUI button in `MonsterEditorView.axaml` + the `MonsterPreviewView.axaml` inner-Panel `#0d0a14` background.

**2026-04-29 follow-up (common-sense Wave G backfill):** ported the previously-skipped `_pendingModelWarmup` queue + `DrainPendingModelWarmup` helper + `QueueModelWarmup(uint, bool)` public API in `GameScene.cs`. `SetWeenieSpawns` now enqueues each unique spawn id to the cross-context queue. Without this, weenie spawns whose models weren't already in the cache silently skipped rendering until something else triggered a load — exactly the failure mode flagged in the original Wave G skip note. `_lastVisibleCellHash` (visibility-cache hash refinement) was N/A — local doesn't carry the upstream `_lastCameraCellId`/`_lastVisibleCellCount` cache fields and instead aggressively rebuilds whenever `visibility != null`, so the optimization has nothing to attach to. `_lastSpawnDiag` log throttling skipped — depends on per-frame `context` + `_visibleObjectsBuffer` plumbing the local doesn't have in the same shape; `DrainPendingModelWarmup`'s own per-drain `Console.WriteLine` already gives queue-depth visibility. Same pass: `b8a09dd` reclassified ✅ PORTED — its three isolated, non-dungeon-refactor pieces (Landscape.frag/vert shader fixes adopting the AC client's TexMerge sequential-blend + actual `dot(N, -L)` lighting; `DocumentManager` `isNewDoc` flag re-projecting after creation; `LandblockDocument._loadedFromProjection` skip-DAT-reinit) were already silently in place from prior slice work; the doc had this commit listed as DEFERRED on the dungeon-refactor chain.

**2026-04-29 d512ef2 re-implementation (the last ⏳ TODO).** `d512ef2` "ACE DB instance placements: weenie picker, dungeon/landscape placement panels, DB import with position fix" re-implemented from intent (the cherry-pick attempt earlier in the day aborted with 8 conflicts including 6 in `AceDbConnector.cs`). All 10 net-new files created — `OutdoorInstancePlacement`, `WeeniePickerViewModel`, `AddInstancePlacementCommand`, `InstancePlacementsPanelViewModel + view`, `AceInstancesPanelViewModel + view`. Schema additions on `DungeonDocument` (`DungeonInstancePlacement` MemoryPackable + `InstancePlacements` list), `LandblockInstanceRecord.IsDungeon`, `Project.OutdoorInstancePlacements + OnExportDungeonInstances` hook + `ExportDats` invocation. `AceDbConnector` gains 4 static SQL helpers (`GenerateInsertSql`/`GenerateInsertSqlBatch` + 2 `ToLandblockInstanceRecords` overloads). DungeonEditor side: `_weenieSetupCache` + `CacheWeenieSetup` + `IntegrateInstancePlacements` on `DungeonScene`; `_pendingWeenieClassId` + `SetPendingWeenie` + weenie-branch in `TryPlaceObject` on `ObjectEditingService`; placement collections + commands + RefreshInstancePlacementList + DB-load on `DungeonEditorViewModel`; `EnvCellManager.DungeonDepthOffset` private→internal so the placement code can subtract it. Both editors register the new panels in `InitDocking`. `ExportDatsWindowViewModel` prefills DB creds from `_settings.AceDbConnection` when project lacks them, wires `OnExportDungeonInstances` to write `dungeon_instances.sql` + apply-directly, exports outdoor placements to `landblock_instances.sql`, reports counts in the success dialog. **Skipped: ObjectBrowser-side weenie loading UX** (ShowWeenies checkbox / Load Weenies button / paged Show More / weenie items in the grid) — local `ObjectBrowserViewModel` is structurally different from upstream's pre-d512ef2 base (carries ShowParticleEmitters / ShowBuildingsOnly / ShowSceneryOnly filters none of which exist upstream); a careful merge into local's existing ApplyFilter/BuildItems shape would be its own substantial port. The `AceInstancesPanel` drives weenie loading through its own `WeeniePickerViewModel` so the ObjectBrowser button is a UX shortcut rather than a hard dependency. Cluster B is now closed for ports — only the ObjectBrowser UX shortcut remains as deliberate skip. Builds clean across Shared + WorldBuilder + Tests + Terminal; 92/93 tests pass (the 1 failure is the pre-existing Windows-path-separator test that has failed on Linux all along). In-game DB write + dungeon-instance render verification still pending.

## Quick orient

| Side | Branch | HEAD |
|---|---|---|
| Local fork | `origin/master` | post-merge of `sync/upstream-tiny-fixes` (Apr 2026 work) |
| Upstream | `upstream/master` | 2026-04-14 (`15cb9ed`) at last fetch |

```sh
# (Re)fetch upstream
git remote add upstream https://github.com/Vanquish-6/WorldBuilder-ACME-Edition.git  # one-time
git fetch upstream

# Counts
git rev-list --count upstream/master ^master       # upstream-only commits
git rev-list --count master ^upstream/master       # our-only commits
git log --no-merges --format=%ad --date=format:%Y-%m upstream/master ^master | sort | uniq -c
```

## Why the histories diverged

Earlier in the project's life there were issues with GitHub that left this fork's
history detached from upstream. Since then, work has been brought across by manually
re-implementing the *intent* of upstream commits, with an AI helper interpreting the
changes against this repo's structure. The result is **functional equivalence**, not
textual equivalence — `git cherry`'s patch-id matching is essentially useless here
because every "ported" commit has a different diff than upstream's original.

## Per-month upstream-only commit counts (last audit)

| Month | Upstream-only commits | Status |
|---|---|---|
| 2025-09 | 9 | Likely already ported |
| 2025-10 | 61 | Likely mostly ported |
| 2025-12 | 3 | — |
| 2026-02 | 158 | Some ported, gaps remain |
| 2026-03 | 33 | Audited 2026-04-26 (see below) |
| 2026-04 | 10 | Audited 2026-04-26 (see below) |

The detailed table below covers the **March + April 2026 window**, which was the
most likely actual gap at last audit.

## March + April 2026 upstream commits — status table

Status legend:

- ✅ **PORTED** — successfully cherry-picked into our master
- 🚫 **BLOCKED** — attempted, conflicts on a prerequisite we don't have
- 🔒 **DEFERRED** — not attempted; large refactor or stacked-on prereqs that aren't worth porting without in-game testing
- 🔧 **PERMISSIONS** — blocked at git push by token scope or LFS, not by code
- ⏳ **TODO** — not yet looked at

Sorted chronologically.

| SHA | Date | Subject | Files | ± Lines | Status | Notes |
|---|---|---|---|---|---|---|
| `b8a09dd` | 03-04 | Dungeon editor refactor, landscape shader fix, doc save bugs | 27 | +1 700/-1 100 | 🟡 PARTIAL | Reclassified 2026-04-29. Three isolated non-dungeon pieces already silently in place from prior slice work: `Chorizite.OpenGLSDLBackend/Shaders/Landscape.frag` (sequential overlay blending matching AC client's `TexMerge::FillTempTexBuffer` — `totalAlpha`/`hasAny`/`coverage` form, `maskBlend3` removed), `Landscape.vert` (`vLightingFactor = max(0, dot(vNormal, -normalize(xLightDirection)))` — actual lambert instead of constant 1.0), `DocumentManager.cs` (`isNewDoc` flag + post-create `UpdateDocumentAsync(SaveToProjection())` so a fresh doc is persisted with its initial projection), `LandblockDocument.cs` (`_loadedFromProjection` flag short-circuits `InitInternal` re-fetching from the DAT when the doc was already loaded from the storage projection). The dungeon-editor-refactor majority (DungeonDocument +216, DungeonEditorViewModel rewrite, DungeonGenerator/KnowledgeBuilder/Prefab/CellEditingService/DungeonDialogService net-new, full Commands/* family) remains 🔒 DEFERRED on the chain. |
| `da88e74` | 03-04 | more prefab stuff | 5 | +356/-39 | 🔒 DEFERRED | Dungeon prefab system. |
| `7b89961` | 03-04 | More prefab stuff, generator, favorites | many | large | 🔒 DEFERRED | Dungeon prefab + generator. |
| `67912c1` | 03-04 | add SQL connector to export, direct DB Z-shift | 13 | +705/-102 | ✅ PORTED | Reclassified 2026-04-29. Verification: `AceDbSettings.cs` matches upstream byte-for-byte; `InstanceRepositionService.cs` / `LandblockInstanceRecord.cs` / `RepositionContext.cs` are local supersets (extended with indoor-building Z deltas + quaternion angles for full placement round-trip from later commits — Wave G); `AceDbConnector` has all three methods (`TestConnectionAsync`/`GetOutdoorInstancesAsync`/`ExecuteSqlAsync`); `Project.cs` + `ExportDatsWindowViewModel` + `ServiceCollectionExtensions` + `MainViewModel` all wired. The commit landed silently as part of the slice work — audit had it tagged TODO because the original cherry-pick into our heavily-modified `AceDbConnector.cs` was anticipated to conflict. |
| `f45e230` | 03-05 | Dungeon generator v2: favorites, room furnishing | many | large | 🔒 DEFERRED | Dungeon refactor chain. |
| `5faec77` | 03-05 | heightmap import, export progress, static repositioning | 11 | +718/-22 | ✅ PORTED | All 11 files: 2 net-new (`HeightImportCommand`, `HeightmapImportService`), additive on `TerrainDocument` (`ApplyBulkImport`), `LandSurfaceManager` (`GetTerrainAverageColors`), `CommandHistory` (`AddExecutedCommand[Async]`), `Project` (`ExportDats` progress + DAT static reposition + dirty skip), `ExportDatsWindowViewModel` (progress dialog), `AceDbConnector.GetOutdoorInstancesAsync` (bulk-or-batched), `LandscapeEditorViewModel` (Import Heightmap command + dialog), axaml button, csproj `SixLabors.ImageSharp`. Skipped FreshStart batch refactor — not present locally. |
| `c66b13f` | 03-05 | add history to dungeon editor | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `40e9567` | 03-05 | fix dungeon dock crash | 4 | +61/-4 | 🚫 BLOCKED | Needs `DungeonGraphPanelViewModel` + `HistoryPanel` from earlier dungeon refactors. |
| `675fb1d` | 03-05 | grid and recenter view for dungeon editor | 3 | +181/-6 | 🔒 DEFERRED | Dungeon UI feature. |
| `ff36b20` | 03-05 | dungeon generator: portal alignment, yaw, capping | 3 | +480/-88 | 🔒 DEFERRED | Dungeon refactor chain. |
| `8847c28` | 03-05 | change camera down to C | 3 | +7/-3 | ✅ PORTED | Cherry-picked. |
| `a858af7` | 03-06 | Fix LayoutDesc position and child nodes | 1 | +13/-8 | ✅ PORTED | Cherry-picked. |
| `e619002` | 03-07 | Maximize editor window | 1 | +1/-2 | ✅ PORTED | Cherry-picked. |
| `0aec0dc` | 03-09 | dungeon gen v3 | many | large | 🔒 DEFERRED | Dungeon refactor chain peak. |
| `d512ef2` | 03-10 | ACE DB instance placements: weenie picker, panels | 29 | +1 617/-143 | 🟡 PARTIAL | Cluster B. Re-implemented from intent on 2026-04-29 (the previously-aborted cherry-pick had 8 conflicts including 6 in `AceDbConnector.cs`). Net-new files landed (10): `WorldBuilder.Shared/Models/OutdoorInstancePlacement.cs` (Vector3/Quaternion JsonIgnore wrappers); `WorldBuilder/ViewModels/WeeniePickerViewModel.cs` (browses `weenie_properties_string` via `AceDbConnector.GetWeenieNamesAsync`, fires `WeeniesLoaded` + `WeenieSelected`); `WorldBuilder/Editors/Dungeon/{Commands/AddInstancePlacementCommand.cs, InstancePlacementsPanelViewModel.cs, Views/InstancePlacementsPanelView.axaml + .cs}`; `WorldBuilder/Editors/Landscape/{ViewModels/AceInstancesPanelViewModel.cs (+OutdoorPlacementItemViewModel), Views/AceInstancesPanelView.axaml + .cs}`. Shared schema additions: `DungeonDocument.cs` gains `DungeonInstancePlacement` MemoryPackable type and `DungeonData.InstancePlacements` list (with public passthrough on `DungeonDocument`); `LandblockInstanceRecord.cs` gains `IsDungeon` helper (`AnglesW/X/Y/Z` already present from Wave G); `Project.cs` gains `OutdoorInstancePlacements` list + `OnExportDungeonInstances` hook + ExportDats invocation that scans active `DungeonDocument`s for placements and fires the hook before reposition. `AceDbConnector.cs` gains four static helpers: `GenerateInsertSql`/`GenerateInsertSqlBatch` (build INSERTs against `landblock_instance` with InvariantCulture F6 floats and identity-quaternion fallback when angles are null), `ToLandblockInstanceRecords(landblockId, IEnumerable<DungeonInstancePlacement>)`, `ToLandblockInstanceRecordsFromOutdoor(IEnumerable<OutdoorInstancePlacement>)` — `GetWeenieNamesAsync`/`GetSetupDidsAsync`/`GetInstancesAsync` already in local from Wave C/G. Editor wiring: `DungeonEditorViewModel` gains `InstancePlacementItems` + `InstancePlacementCellNumbers` collections, `NewPlacementWcid/CellNumber/X/Y/Z` observable props, `RefreshInstancePlacementList`/`TryLoadDbInstancesAsync` helpers, `AddInstancePlacement`/`RemoveInstancePlacement`/`AddPlacementAtSelectedRoom` commands, `OnObjectPlacementRequested` weenie-vs-DAT branch (uses `ObjectEditing.SetPendingWeenie` for weenies with a 3D model, falls back to manual entry when SetupId=0), `WeenieSetupsLoaded` subscription on `ObjectBrowser` driving `_scene.CacheWeenieSetup`, `RefreshInstancePlacementList` calls in `NewLandblock`/`EnsureDocument`/`CopyFrom`/`LoadDungeon` paths, and `_ = TryLoadDbInstancesAsync(landblockKey)` after a successful dungeon load. `DungeonScene` gains `_weenieSetupCache` dict + `CacheWeenieSetup` API + `IntegrateInstancePlacements` (renders WCID placements as static objects with the cached SetupId, capped at 50 rendered + 10 model-warmups per integration; uses `EnvCellManager.DungeonDepthOffset` for landblock-Z offset). `EnvCellManager.DungeonDepthOffset` flipped `private` → `internal`. `ObjectEditingService` gains `_pendingWeenieClassId` + `IsWeeniePlacement` + `SetPendingWeenie(weenieClassId, setupId)` and `TryPlaceObject` weenie-vs-stab branch (weenie path subtracts `DungeonDepthOffset` to convert from world to dungeon-local Z; otherwise +50 Z bump). `DungeonEditorViewModel.InitDocking` registers the new `"InstancePlacements"`/"Instance Placements" panel; `LandscapeEditorViewModel.InitDocking` registers `"AceInstances"`/"ACE Instances" panel. `ExportDatsWindowViewModel` gains app-settings prefill of DB credentials when `_project.AceDb` is null, sets `_project.OnExportDungeonInstances` to write `dungeon_instances.sql` (and execute via `ExecuteSqlAsync` when `ApplyDirectly`), reports the dungeon + outdoor placement counts in the success dialog, exports outdoor placements to `landblock_instances.sql`, and clears the hook in `finally`. Builds clean (Shared + WorldBuilder + Tests + Terminal); 92/93 tests pass — the only failing one is the pre-existing Windows-path-separator test that has been failing on Linux from before this work. **Skipped from this commit (deferred)**: the `WorldBuilder/Editors/Landscape/ViewModels/ObjectBrowserViewModel.cs` `_settings` parameter + `LoadWeeniesFromDbAsync` command + `ShowWeenies` checkbox + paged Show-More; the `Views/ObjectBrowserView.axaml` checkbox/button additions; the parallel `DungeonObjectBrowserViewModel` paging + `LoadWeeniesFromDb` + `ShowWeenies` work; the `Views/DungeonObjectBrowserView.axaml` corresponding UI; the `ObjectBrowserItem` weenie ctor changes. Local `ObjectBrowserViewModel` is structurally different from upstream (carries `ShowParticleEmitters` + `ShowBuildingsOnly` + `ShowSceneryOnly` filters none of which exist in upstream's pre-d512ef2 base) — porting d512ef2's ApplyFilter merge would clobber these. The `AceInstancesPanel` already drives weenie loading via its own `WeeniePickerViewModel`, so the ObjectBrowser-side load button is a UX shortcut rather than a hard dependency. In-game DB write + dungeon-instance render verification still pending. |
| `75fb32e` | 03-10 | fix EnvCell log spam | 2 | +10/-17 | ✅ PORTED | Cherry-picked. |
| `b671cee` | 03-10 | more fixes | 6 | +113/-27 | 🔒 DEFERRED | Touches dungeon-refactor types we don't have. |
| `b9ffe3e` | 03-10 | make dungeon view fill | 8 | +25/-14 | ✅ PORTED | Cherry-picked clean (auto-merge in 4 csprojs + `Base3DView.cs`). Removes the duplicate `<PrivateAssets>all</PrivateAssets>` / `<IncludeAssets>none</IncludeAssets>` lines on `Avalonia.Diagnostics` (the Condition-bearing entries above them already cover Release; in Debug the duplicates were force-stripping the assembly so DevTools never linked). Adds `Base3DView.CurrentRenderSize` accessor + ceiling-based pixel sizing (`Math.Ceiling(viewportBounds.Width * scaling)` with `Max(1, …)`), which `DungeonViewportControl` and `ViewportControl` now read instead of `(int)Bounds.Width/Height` — fixes the right/bottom render gap on fractional-DPI scaling. `MainWindow.AttachDevTools()` re-enabled under `#if DEBUG`. |
| `af985b2` | 03-10 | Changelog from commit messages; add `release.yml` | 3 | +58/-32 | 🔧 PERMISSIONS | OAuth token lacks `workflow` scope — modifies `.github/workflows/BuildEdge.yml`. Push from a session with `workflow` scope, or split changelog from yml. |
| `f29948e` | 03-11 | fix fill tool preview | 1 | +2/-2 | ✅ PORTED | Cherry-picked. |
| `9a0dbc3` | 03-11 | Dungeon editor improvements | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `7293629` | 03-11 | mini map for terrain editor | 5 | +539/-0 | ✅ PORTED | Unblocked once `5faec77` landed. 4 net-new files (`WorldMapPanelViewModel`, `WorldMapCanvas`, `WorldMapPanelView` axaml + .cs); `LandscapeEditorViewModel` adds `WorldMapPanel` observable + DI + dock register. ViewLocator picks up the View by name. |
| `cd3e377` | 03-12 | dungeon 'world template' WIP | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `6a317bc` | 03-12 | world mini map fix, remove templates | 26 | +116/-604 | 🔒 DEFERRED | Mostly DELETIONS (template removal). Don't port without verifying we want those deletions. |
| `0998c38` | 03-13 | landscape refactor, dungeon scene + settings | 51 | +1 197/-358 | 🔒 DEFERRED | Big landscape refactor. |
| `f26345e` | 03-22 | weenie editor, layout overhaul, transform gizmo, world gen, mesh import/export, texture | 86 | +10 452/-661 | 🟡 PARTIAL | See "f26345e split into 4 slices" below. Slices 1-3 (headless) ✅ PORTED. Slice 4 waves A-E ✅, G ✅. Wave F (Layout editor overhaul) ⏳ deferred. |
| `fa7c58c` | 03-22 | Surface browser paging + dungeon scan fixes | 6 | +479/-75 | ✅ PORTED | Cherry-picked with one trivial conflict (local `items`-named ObservableCollection vs upstream `itemsList`/`FilteredItems`); resolved to upstream form. Adds `WorldBuilder.Tests/ClientReference.cs` (decompiled-AC-client oracle for split-direction + pal-code) and `TerrainConformanceTests.cs` (27 tests, all pass). `TerrainGeometryGenerator.CalculateSplitDirection` now delegates to `TerrainHeightSampler.IsSWtoNEcut` so render and export agree. SurfaceBrowser gains 200-per-page Load More + `CollectDungeonSurfaces` helper + 0xFFFE-LBI fallback scan + 0x06-only RenderSurface guard. `DungeonEditorViewModel.InitDocking` now `DockingManager.Clear()`s before re-registering. |
| `ee39f71` | 03-22 | fix dungeon export crash on corrupt setup | 1 | +9/-1 | 🚫 BLOCKED | Needs `SanitizeEnvCellSurfacesForExport` (hundreds of lines of upstream `DungeonDocument.cs` we don't have). |
| `4dc3983` | 03-23 | Weenie property enums + DID/int pickers | many | medium | ✅ PORTED | Cluster B. Two-pass port: dungeon object-browser slice landed 2026-04-29 morning (see prior note), the rest landed 2026-04-29 afternoon. Final pass adds: net-new `WorldBuilder.Shared/Lib/AceDb/AceWeeniePropertyEnums.cs` (873 LOC — `AcePropertyInt`/`AcePropertyInt64`/`AcePropertyBool`/`AcePropertyFloat`/`AcePropertyString`/`AcePropertyDataId`/`AcePropertyInstanceId`), `AceWeenieDidPickerModes.cs`, `AceWeenieIntEnumOptions.cs`, and 16 `EntityEnums/*` (AttunedStatus/BondedStatus/CombatMode/CombatStyle/CombatUse/CreatureType/DamageType/EquipMask/HeritageGroup/ImbuedEffectType/MaterialType/PaletteTemplate/PhysicsState/PlayerKillerStatus/PortalBitmask/Skill/Usable/WeaponType/WieldRequirement). `AceWeenieTypes.cs` `AceWeeniePropertyLabels` rewritten to delegate to the new enums (Int/Int64/Bool/Float/String/InstanceId now use `Enum.IsDefined`). `AceDbConnector.Weenie.cs` gains `InsertWeenieAsync` (auto-assigns next class_Id min 100000, INSERTs weenie row + scalar properties in a transaction). `WeenieTemplates.json` expanded from 1 → 13 templates (generic, melee/missile weapon, armor, food/scroll/spellcomp/portal/door/chest/lifestone/coin/creature) with full int/bool/string/dataIds blocks. **Weenie editor**: `WeenieEditorViewModel` gains per-row `RowDescription`, `IsCreatingNew`/`NewClassName` mode, `SaveButtonText` toggle, `PropertyTypeOption` dropdown class, static `AllIntTypes/AllInt64Types/AllBoolTypes/AllFloatTypes/AllStringTypes/AllDidTypes/AllIidTypes` lists built from the new enums, `AddIntProperty/Add{Int64,Bool,Float,String,Did,Iid}Property` + matching `RemoveXxxRow` commands, `CreateNew/CancelNew/InsertNewWeenieAsync` flow, `BrowseDidAsync` stub. `WeenieEditorView.axaml` overhauled (+260/-203) with the Add/Remove pickers, Create New button, RowDescription tooltips. **Dungeon side**: `DungeonEditorViewModel.Init` + `InitTools` re-entrancy guards + Escape routing tweak; `DungeonScene` `UnloadLandblock` calls switched to `EnvCellManager.QueueUnload` (deferred GL-thread unload — line-width aesthetic tweaks skipped, local has its own tuning); `RoomPaletteViewModel` favorite-prefab filter ordering fix + thumbnail/favorite carry-over rebuild; `SurfaceBrowserViewModel` gains `_favoriteSurfaceIds`/`ShowFavoritesOnly`/`ToggleFavorite` persisted to `%LOCALAPPDATA%/ACME WorldBuilder/surface_favorites.json`. `Views/DungeonEditorView.axaml` adds "Object placement mode" overlay; `Views/DungeonEditorView.axaml.cs` routes Escape outside Ctrl modifier; `Views/DungeonViewportControl.axaml.cs` removes the right-click cell context menu (-51 lines — upstream's intent: cleaner placement-mode UX); `Views/RoomPaletteView.axaml` switches `ListBox` → `ScrollViewer + ItemsControl + WrapPanel` for wide-panel grid layout; `Views/RoomPaletteView.axaml.cs` adds `PrefabItem_PointerPressed` for explicit selection on click; `Views/SurfaceBrowserView.axaml` adds Favorites toggle + per-tile star overlay. **Landscape side**: `EnvCellManager` gains `_pendingUnloads` queue + `QueueUnload` API + drain in `ProcessUploads` (deferred GL-thread unload — fixes the UI-thread/render-thread race that previously could delete GL resources mid-frame). `LandscapeEditorViewModel` gains `IsInPlacementMode`/`PlacementStatusText` observables (set on Escape, set on tool-switch / placement-state restore); `Views/LandscapeEditorView.axaml` adds the matching placement-mode overlay above the viewport. `ObjectDebug/ViewModels/ObjectDebugViewModel.cs` adds `gl.ClearDepth(1f)` before clear and replaces `uTextureIndex` uniform with `glVertexAttrib1` on attrib slot 7 (fixes texture-array indexing for instance-shader path). **Skipped from this commit (deferred)**: `LandscapeEditorViewModel` favorites + paging + `PlaceWeenieAsInstance` (`ApplyFilter` favorites branch needs the upstream 3-arg `ApplySearchFilter` signature + `_displayLimit/BatchSize` paging + `HasMore` flag, none of which our local `ObjectBrowserViewModel` carries — porting them would require pulling in pre-4dc3983 paging work that lives in another upstream commit chain) and the `Views/ObjectBrowserView.axaml` favorites overlay (binds to those same not-yet-ported props). |
| `44f47f8` | 03-23 | gizmo improvement | 7 | +679/-110 | ✅ PORTED | Cherry-picked clean (auto-merge in `DungeonEditingContext.cs` + `EnvCellManager.cs`). Adds env-cell collision-mesh ray picking + surface alignment for dungeon and outdoor selectors, full TransformGizmo overhaul (cylindrical shafts / torus rings / sphere center handle / view-axis ring / rotation arc + hover/active highlight uniforms), `GizmoAxis.ViewAxis`, center-handle `All` translate, `GetLocalAxisDirection` API. Builds clean (WorldBuilder + Shared + Terminal + Tests; only pre-existing test failure unrelated). In-game verification still pending. |
| `5f963ee` | 03-24 | fix(landscape): skip redundant terrain apply, command doc IDs | 4 | +47/-26 | ✅ PORTED | Cherry-picked. |
| `39d68d7` | 03-31 | World gen: coastal water bands, building/road tweaks | 15 | +351/-120 | 🟡 PARTIAL | Cherry-picked 2026-04-29 with conflicts. WorldGen substantive tweaks landed: BiomeMapper coastal water bands, BuildingAnalyzer/Placer/HeightMapGenerator/RoadGenerator/TownPlacer/WorldGenerator/WorldGeneratorParams + DialogService minimap-data hook. PortalDatDocument export now logs "schema changed" on stale cache and catches `ArgumentException` on malformed entries (records `_unpackFailures` so subsequent runs skip with a clear warning). FreshStart command + the big GenerateWorld upgrade (progress dialog / town summary / CSV export) skipped — depend on `LandblockDocument.ClearAllStatics`, `DocumentManager.SkipDatStatics`, and `Scene.QueueModelWarmup`, none of which are ported. Upstream's `GetDocumentIdsByPrefixAsync` collapsed into local's pre-existing `ListDocumentIdsAsync(prefix)` (functionally equivalent). Builds clean. |
| `33709a5` | 03-31 | Dungeon editor: per-static scale, surface alignment | 8 | +446/-24 | 🔒 DEFERRED | Dungeon refactor chain. |
| `239c0c1` | 04-09 | fix buildings + new monster builder | 18 | +2 039/-12 | ✅ PORTED | Cluster B. Cherry-picked 2026-04-29 with three conflicts. Net-new: `WorldBuilder.Shared/Lib/AceDb/AceCreatureSnapshot.cs` (32 LOC) + `AceDbConnector.Creature.cs` (158 LOC partial — `GetCreatureAsync`/`SaveCreatureAsync`/list helpers), `WorldBuilder/Editors/Monster/{MonsterEditorViewModel.cs (715 LOC), Views/MonsterEditorView.axaml + .cs, Views/MonsterPreviewView.axaml + .cs}`. Additive: `BuildingBlueprintCache.ComputePreviewCells` (in-memory EnvCell synthesis from blueprint, no DAT writes), `GameScene.PreviewBuildingInterior` + `InvalidateEnvCellsForLandblock` + `_pendingPreviewCells` queue + retry-loop guard, `StaticObjectManager` gains `TextureRemapping`/`HiddenPartIndices`/`GfxObjRemapping` dictionaries (driven by Monster editor for live preview of part-swap and texture-replace), `ObjectCommands.AddStaticObjectCommand` queues preview cells when the placed object is a building model, `DatIconLoader.LoadSurfaceTextureIcon` (decodes 0x05xxxxxx through SurfaceTexture→last RenderSurface chain), `SurfaceBrowserViewModel.TryBitmapFromRenderSurface` visibility static→`internal static`, `LandscapeEditorSettings._showBuildingInteriors` default flips false→true, DI registration + MainView menu entry + DataTemplate. Conflict 1: `LandscapeEditorViewModel.GenerateWorld` — upstream's pre-commit version is the big upgrade (FreshStart + progress dialog + town summary CSV) we deferred; cherry-pick brought in the whole conflicting block (~420 lines). Resolution: kept HEAD (our simpler GenerateWorld) and dropped the entire upstream conflict block. Conflict 2: `GameScene.cs` block where upstream re-introduced Wave-G code as part of the surrounding context. Resolution: kept only the two genuinely-new methods (`InvalidateEnvCellsForLandblock`, `PreviewBuildingInterior`); dropped the Wave-G duplicates and skipped `QueueModelWarmup`/`_pendingModelWarmup` (consistent with the existing deliberate Wave-G skip — see "Skipped from upstream's Wave G"). Conflict 3: `ServiceCollectionExtensions.cs` import block — added single `using WorldBuilder.Editors.Monster;` line. Plumbing: added stub `DocumentManager.SkipDatStatics { get; set; }` (single bool property, no behaviour) so the cherry-picked GameScene retry-loop guard compiles — actual `SkipDatStatics=true` setters live in the deferred GenerateWorld upgrade and aren't reachable. Builds clean (WorldBuilder + Shared + Terminal + Tests). In-game verification still pending. |
| `92fafff` | 04-09 | monster editor improvements | 9 | +465/-53 | ✅ PORTED | Cluster B. Cherry-picked 2026-04-29 with one trivial modify/delete conflict (upstream modified `_reflect_types/Program.cs` which we'd previously deleted — resolution: keep deletion via `git rm`). All other hunks auto-merged: `Chorizite.OpenGLSDLBackend/Lib/TextureHelpers.cs` gains a 21-line helper; `AceCreatureSnapshot.cs` extended (+26 LOC) with weenie-properties-anim-part fields; `AceDbConnector.Creature.cs` extended (+64 LOC); `DefaultDatReaderWriter.cs` adds RenderSurface/SurfaceTexture cases to the dispatch (2 LOC); `StaticObjectManager.cs` extended (+35 LOC) for the Monster preview path; `MonsterEditorViewModel.cs` extended (+311 LOC) with mix-and-match part-swap UX, hide-part toggles, animation-part live preview wiring; `MonsterEditorView.axaml` (+18 LOC) and `MonsterPreviewView.axaml.cs` (+34 LOC) round out the GUI. Builds clean. In-game verification still pending. |
| `4ee4211` | 04-09 | fix xp auto scale | 2 | +113/-20 | ✅ PORTED | Cherry-picked. |
| `3457ea7` | 04-10 | feat(SpellEditor): add copy spell | 5 | +2 008/-471 | ✅ PORTED | Cherry-picked 2026-04-29 with two textual conflicts (resolved). Adds `SpellRecord.cs` (full ACE-DB spell row mirror — 60+ properties from `stat_Mod_Type` through `dot_Duration`) + `SpellDbDocument.cs` (per-project SpellRecord cache keyed by spell id, follows the same pattern as PortalDatDocument). `SpellEditorViewModel` gains `_spellDbDoc`, `_dbSpellCache`, `SaveToDb` toggle, async `OnSelectedSpellChanged` (LoadFromDb → cache → DB), new `CopySpell` command (uses `_allSpells.Keys.Max() + 1` for new id, deep-copies all SpellRecord props), and `SaveSpell` is now async with optional `SaveSpellAsync` to ACE DB. `AceDbConnector.cs` gains `GetSpellAsync` + `SaveSpellAsync` (full INSERT … ON DUPLICATE KEY UPDATE for the spell table). Conflict resolution: dropped upstream's duplicate `WeenieEntry`/`GetWeenieNamesAsync`/`GetSetupDidsAsync` injections (already live in `AceDbConnector.Weenie.cs` partial from Wave C); merged the local `idx`-find form of the SaveSpell loop with upstream's DB-save tail. Builds clean (WorldBuilder + Tests + Terminal). In-game DB-save verification still pending. |
| `d780244` | 04-11 | improve spell editor UX | many | medium | 🟡 PARTIAL | Cluster B. Spell-editor slice ✅ ported 2026-04-29 (`SpellEditorViewModel.cs` +505/-50, `SpellEditorView.axaml` +185/-...): presets dropdown for new spells (Blank/Basic Bolt/Basic Buff/Basic Portal), undo stack with `SpellUndoAction` discriminated kinds, validation messages with `HasBlockingIssues`/`CanSave` gating, toast notifications with optional action, paging (`SpellPageSize=500`, `HasMoreResults`, `VisibleLimit`), newest-first sort, "Go to last created spell", change-tracking (`HasUnsavedChanges`, `ChangedFields`), onboarding overlay, `ApplyPresetToSelected` command. Build clean across WorldBuilder + Shared + Terminal + Tests. Cherry-pick auto-merged the spell VM cleanly but produced two `[RelayCommand] CopySpell` methods (upstream's new lean form + our 3457ea7 inline-clone form) — resolved by applying `55604d2`'s pattern (see that row). **Skipped from this commit (deferred)**: `Dungeon/InstancePlacementsPanelView.axaml` (+27/-... selected-state styling) and the dungeon/landscape changes (`DungeonEditorViewModel`, `DungeonScene`, `DungeonObjectRaycast`, `DungeonSelectionManager`, `Dungeon/Tools/SelectTool`, `Landscape/{GameScene,ObjectRaycast,ObjectSelectionState,TerrainEditingContext,TerrainSystem,LandscapeEditorViewModel,ObjectBrowserViewModel,SelectSubToolViewModel,Views/ObjectBrowserView.axaml}`) all consume `InstancePlacementsPanelViewModel` / `WeeniePickerViewModel` / `AddInstancePlacementCommand` from `d512ef2` and were skipped pending that port. In-game UX verification still pending. |
| `55604d2` | 04-11 | fix spell editor rebase | 1 | +77/-127 | ✅ PORTED | Cluster B. Landed 2026-04-29 as the resolution of the `d780244` cherry-pick auto-merge: deleted the duplicate `[RelayCommand] CopySpell` (our 3457ea7 inline-clone form), hoisted the DB-clone block into a `CloneDbSpellRecord(SpellRecord, uint)` static helper (with `LastModified` carried over — that field exists in our local SpellRecord from the 3457ea7 port), and added the call site in upstream's new lean CopySpell right after `SelectedDetail.ApplyTo(copy)`. Net effect: a single `CopySpell` that combines upstream's d780244 `MarkSpellTableDirty` + `PushUndo` + `ShowToast` + `FocusSpellById` + `_lastCreatedSpellId` flow with our DB-spell clone behaviour. Builds clean. |
| `34c612b` | 04-11 | Defer portal writes via PortalDatDocument; simplify world-gen buildings | 5 | +27/-104 | 🟡 PARTIAL | PortalDatDocument RenderSurface dispatch ✅; `ObjSingleMeshImporter.TrySaveToPortal` deleted (dead code) ✅; `TextureImportService.TryOverwriteUiRenderSurface` now defers via PortalDatDocument ✅; LandscapeEditorViewModel world-gen simplify N/A (local already uses simple AddStaticObject pattern); LayoutEditorViewModel `_portalDoc` plumbing **deferred to Wave F**. |
| `38b22c2` | 04-12 | texture fixes; documentation | many | small | ✅ PORTED | Cherry-picked with conflicts on `README.md` (resolved: keep local ACME intro, splice in upstream's User Guide pointer + Custom Textures additions) and modify/delete on `WorldBuilder/Editors/Monster/{MonsterEditorViewModel.cs,Views/MonsterPreviewView.axaml}` (deleted from cherry-pick — Cluster B; the editor didn't exist locally at the time — fork's master starts at root commit `98d9a1a` 2026-03-21 with no Monster files, so there was nothing to delete, only upstream's modifications to skip). What landed initially: `CustomTextureStore` gains `RenderSurfaceReplace` enum + `ReplacesRenderSurfaceId` field + `GetRenderSurfaceReplacement(s)` helpers; `TextureImportService` gains `TryImportRenderSurfaceReplacement` (validates target exists + dimensions + `PFID_A8R8G8B8` format) and a new `WriteRenderSurfaceReplacementsToDats` export path that round-trips through `RenderSurfaceWithReplacedPixels` (preserves original metadata). Existing terrain + dungeon-surface export paths gain the same up-front format/dimension validation so DXT or buffer-size-mismatched data is rejected before write. Background colors set to `#1a1a1a` on `DungeonViewportControl`/`ObjectDebugView`/`ViewportControl` (Transparent panels show black flash during DAT load); `WeenieSetupPreviewView` panel gets explicit `#0d0a14`. `ObjectDebugView` Grid first column changes from `250` to `Auto`. New `docs/USER_GUIDE.md`. **Doc-trim correction (2026-04-29):** the original cherry-pick trimmed the Monster Creator section + 4 inline references from `docs/USER_GUIDE.md` on the rationale "the editor isn't in this fork." That conflated current state with intent — upstream's User Guide describes the fork's north-star feature set, and dropping the section also drops a future contributor's roadmap. Restored the full Monster Creator H2 (with its `### Replacing a RenderSurface by ID` subsection), the Setup-prerequisites mention, the Quick-map table row, the ACE/MySQL settings reference, and the Tips Creatures bullet. Two intentional local refinements kept in the Custom Textures section: extra "RenderSurface by ID" bullet (describes the local-available import API even without the GUI) and reworded validation paragraph (explicit `A8R8G8B8` + present-tense). **Backfill (2026-04-29 after `239c0c1`+`92fafff` ported):** Monster editor now exists locally, so the originally-skipped Monster pieces from this commit landed: `ReplaceRenderSurfaceAsync` [RelayCommand] in `MonsterEditorViewModel.cs` (writes `_textureImport.TryImportRenderSurfaceReplacement` against a user-entered hex ID), the matching "Replace by ID…" `Button` added to `MonsterEditorView.axaml` next to the "Import…" button, and `MonsterPreviewView.axaml` inner Panel gains the same `Background="#0d0a14"` as the outer view. Reclassified ✅ PORTED. |
| `7d6ce84` | 04-12 | UI layout additions (some names from string) | 8 | +576/-37 | 🚫 BLOCKED | Pure-additive parts (`LayoutUiStringResolver.cs` new file; `DefaultDatReaderWriter` adds `StringTable` to `TryGet`/`TrySave` switches; `LayoutMediaHelper.PopulateStateRows` gains optional `DatCollection?` + `IReadOnlyList<uint>?` params) would land cleanly on their own. The blocker is the `LayoutEditorViewModel.cs` + `LayoutPreviewCanvas.cs` + `LayoutEditorView.axaml` changes: they consume `ElementTreeNode.Caption` / `TreeLine` / `HierarchyTooltip` / `CaptionDisplay` / `TypeLabel` / `EffectiveTypeHint` and assume an upstream-shape `ElementTreeNode(ElementDesc, DatCollection?, uint[]?, uint)` ctor + `LayoutDetailViewModel(_dats, _textureImport, _portalDoc, _stringDats)` shape that this fork doesn't have (our local `ElementTreeNode` is a plain class with the simple `(ElementDesc)` ctor; our `LayoutDetailViewModel` doesn't carry `_dats`). The upstream-shape `LayoutDetailViewModel` overlaps Wave F territory (the deferred Layout overhaul), so a clean port wants Wave F first. A lighter "additive-only" port (resolver + DefaultDatReaderWriter switch entries + optional-param helper) would be dead code with no caller; not worth landing alone. |
| `15cb9ed` | 04-14 | add logging, fix texture import/dat export | 9 | +506/-4 | ✅ PORTED | Net-new `WorldBuilder/Lib/FileLogging.cs` (`FileLoggerProvider`/`FileLogger`/`FileLogSink` — `%APPDATA%/ACME WorldBuilder/Logs/worldbuilder.log` with single-backup rotation, level/enabled toggles read live from `WorldBuilderSettings.App`). `ServiceCollectionExtensions.AddCommonServices` constructs the provider before DI is built so the rotation cap can be honoured from the very first byte (reads `MaxLogFileSizeMb` from `settings.json` directly); `AddProjectServices` re-uses the singleton. `App.OnFrameworkInitializationCompleted` wires `GetMinLevel`/`GetEnabled` to settings after DI builds. `AppSettings` gains `EnableFileLogging` (default true) + `MaxLogFileSizeMb` (1-50, default 5). Net-new `WorldBuilder.Shared/Lib/DatExportFixer.cs` (237 lines): `PatchFreeBlocksBeforeExport` (resets FreeCount=0 so Chorizite's contiguous-allocator can't stomp in-use blocks) called per dat file before opening the writer; `FixLeafBranchSentinels` (walks B-tree post-write, replaces 0xCDCDCDCD branch slots with 0 so ACE's DatLoader correctly identifies leaves) called after `writer.Dispose()` and BEFORE `OnExportReposition` so the reposition hook (which uses ACE-shape DAT loading) sees fixed-up data. `Project.ExportDats` drops the `using` so writer can be disposed mid-method. MainViewModel + MainView gain `OpenLogFolderCommand` / "Open Log Folder" menu item (cross-platform: explorer/open/xdg-open). `.gitignore` adds `_tmp_reflect/`. Builds clean across WorldBuilder, Shared, Terminal, Tests. In-game export verification still pending. |

### Tally
- **20 ✅ PORTED** (incl. `5faec77` heightmap import + `7293629` mini map landed 2026-04-26; `44f47f8` gizmo improvement and `fa7c58c` surface-browser paging + terrain conformance landed 2026-04-29; `b9ffe3e` dungeon view fill landed 2026-04-29; `15cb9ed` logging + dat-export fix landed 2026-04-29 — closed the audit window; `3457ea7` SpellEditor copy spell + ACE-DB save landed 2026-04-29; `4dc3983` Weenie property enums + DID/int pickers + dungeon/landscape browser wire-up landed 2026-04-29 in two passes — landscape-side favorites/paging hunks deferred, see row; `67912c1` SQL-export reposition reclassified ✅ on 2026-04-29 audit — already silently in place from prior slice work; `55604d2` spell-editor rebase fix landed 2026-04-29 as the d780244 merge resolution; `239c0c1` Monster builder + `92fafff` Monster editor improvements landed 2026-04-29 final pass; `38b22c2` reclassified ✅ same pass after Monster-editor backfill of `ReplaceRenderSurfaceAsync` + GUI button + preview-Panel background)
- **6 🟡 PARTIAL** (`b8a09dd` reclassified 2026-04-29 — landscape shader fixes + DocumentManager/LandblockDocument doc-save bug fixes ✅ already silently in place; dungeon-editor refactor majority remains DEFERRED — `f26345e` slices 1-3 ✅ + slice 4 waves A, B, C, D, E, G ✅ (Wave G `_pendingModelWarmup`/`DrainPendingModelWarmup`/`QueueModelWarmup` backfilled 2026-04-29; `_lastSpawnDiag` and `_lastVisibleCellHash` skipped — see Wave G section); wave F (Layout editor) ⏳ — `34c612b` portal-defer + dead-code deletion ✅; LayoutEditorViewModel plumbing pending Wave F — `39d68d7` WorldGen substantive tweaks ✅; FreshStart + big GenerateWorld upgrade skipped, depends on `ClearAllStatics`/`SkipDatStatics` (now stub-only)/`QueueModelWarmup` (now landed) — `d780244` spell-editor UX slice ✅ landed 2026-04-29; landscape/dungeon/InstancePlacementsPanelView pieces of `d780244` now unblocked behind `d512ef2` (could be revisited) — `d512ef2` re-implemented from intent 2026-04-29 final pass, panels + Project state + DB SQL helpers ✅; ObjectBrowser-side weenie UX shortcut deliberately skipped — see row)
- **4 🚫 BLOCKED** (`40e9567`, `ee39f71`, `7d6ce84` plus prior; `7d6ce84` blocked on Wave F shape — see row)
- **13 🔒 DEFERRED** (large refactors or stacked dungeon-chain — port only with in-game testing)
- **1 🔧 PERMISSIONS** (just needs the right token to push)
- **0 ⏳ TODO** (`d512ef2` ACE DB instance placements re-implemented from intent 2026-04-29 — Cluster B closed for ports)

## f26345e split into 4 slices

`f26345e` was too large to cherry-pick as a unit (86 files, +10 452 LOC). It was
decomposed into 4 slices, each on its own side branch stacked off the previous:

### Slice 1 — Mesh I/O + BSP + particle simulator (headless backend) ✅
Branch: `sync/f26345e-slice1-mesh-particle`

5 net-new pure-backend files in `WorldBuilder.Shared/Lib/`:
`AcParticleEmitterSimulator`, `BspGenerator`, `ObjSingleMeshImporter`,
`WavefrontMeshExport`, `LayoutDescBinary`. Plus `PortalDatDocument` extended
to dispatch `GfxObj`/`Setup` saves with an unpack-failure cache and
`GetEntryIds()`. Wired into headless via 3 REPL/JSON commands:
`obj-export`, `obj-import`, `bsp-build`.

### Slice 2 — AceDb weenie data layer (headless backend) ✅
Branch: `sync/f26345e-slice2-weenie-data` (stacked on slice 1)

7 net-new files: `AceWeenieSnapshot`, `AceWeenieTypes`,
`WeenieTemplateDefinition`, `AceDbConnector.Weenie` (partial),
plus GUI-side `WorldBuilder/Lib/WeenieTemplateCatalog` and
`WorldBuilder/Data/WeenieTemplates.json` (embedded). `AceDbConnector` is
now `partial`. The Weenie partial also gained `GetWeenieNamesAsync` +
`GetSetupDidsAsync` + `WeenieEntry` (slice 4 wave C added these here
rather than touch the heavily-locally-modified `AceDbConnector.cs`).
Headless wired via 3 commands: `weenie-snapshot`, `weenie-template-list`,
`weenie-template-apply`.

### Slice 3 — WorldGen pipeline (relocated to Shared.Lib) ✅
Branch: `sync/f26345e-slice3-worldgen` (stacked on slice 2)

10 net-new files relocated from upstream's `WorldBuilder.Editors.Landscape.WorldGen`
(GUI namespace) to `WorldBuilder.Shared.Lib.WorldGen` since they have zero
Avalonia dependencies. Files: `BiomeMapper`, `BuildingAnalyzer`,
`BuildingPlacer`, `HeightMapGenerator`, `RetailTownBuildingScanner`,
`RoadGenerator`, `TownDecorationCatalog`, `TownPlacer`, `WorldGenerator`,
`WorldGeneratorParams`. `Shared/Lib/Noise/SimplexNoise` extended with
upstream-compatible `FBM` and `RidgedNoise` methods.

Headless wired via 3 commands: `worldgen` (dry-run + `--apply` flag for
TerrainDocument/LandblockDocument writes), `worldgen-analyze-buildings`,
`worldgen-scan-retail-towns`.

### Slice 4 — GUI changes 🟡 in progress (waves A-E + G done; F deferred)
Branch: `sync/f26345e-slice4-gui` (stacked on slice 3)

Decomposed into waves:

**Wave A** ✅ — extract clean-add files (`LayoutDatDocument`, `TransformGizmo`,
`SetObjectOrientationCommand`, Gizmo shaders, Layout helpers, full
Weenie editor, full ObjectDebug refactor with old paths deleted,
`WorldGeneratorDialogService`).

**Wave B** ✅ — Shared diff hunks (`LandblockDocument` particle-emitter
detection, `Project.ReloadDatReadersAfterExternalWrite` +
`LayoutDatDocument` save dispatch, `BuildingBlueprintCache.GetAllBuildingModelIds`,
`DefaultDatReaderWriter` `ParticleEmitter` + `LayoutDesc` routes,
`CustomTextureStore.UiRenderSurface` legacy enum value, csproj
embedded shaders/JSON).

**Wave C** ✅ — fix the 13 build errors via `AceDbConnectionSettings`
new file, `WorldBuilderSettings.AceDbConnection` property,
`JsonSourceGenerationContext` registration, `ServiceCollectionExtensions`
DI for `ObjectDebugEditorViewModel` + `WeenieEditorViewModel` (replacing
the deleted `AddTransient<ObjectDebugViewModel>()`),
`StaticObjectManager.SetPortalDatDocument` + `TryGetSetup`/`TryGetGfxObj`
overlay + `RegisterGfxObj`/`RegisterSetup`,
`AceDbConnector.Weenie` extended with `WeenieEntry`/`GetWeenieNamesAsync`/`GetSetupDidsAsync`.

**Wave D** ✅ — small-file diff hunks (EnvCellManager buffer-grow fix,
ObjectSelectionState.HasEditableEntry, SceneContext gizmo init,
TerrainEditingContext normal/align helpers, DungeonScene gizmo render,
DungeonSelectionManager position tracking, MainViewModel + MainView axaml
menu items + DataTemplates for the two new editors, full SnapSettings
class on LandscapeEditorSettings, ShowParticles/ShowWeenieSpawns overlay
toggles).

**Wave E** ✅ landed:
- ObjectBrowserItem.cs replaced with upstream (gains particle-emitter
  ctor, weenie ctor, IsParticleEmitter / ThumbnailGraphicsId properties).
- ObjectRaycast.cs full diff applied — particle-emitter visual-resolve
  helper used by world-ray hit, scenery hit, screen-rect hit; new
  scenery loop in marquee selection.
- SelectSubToolViewModel: AlignToSurfaceCommand + view button +
  keyboard-shortcut hint; placement-side IsParticleEmitter wiring (3
  sites); selection routes through PromoteSceneryToDocument helper for
  click + marquee.
- LandscapeEditorViewModel: ShowParticles / ShowWeenieSpawns toggles;
  GenerateWorldCommand opens WorldGeneratorDialogService and applies
  the result through TerrainDocument + LandblockDocument.
- LandscapeEditorView.axaml: Particles + Spawns overlay toggles +
  Generate... action button.
- SelectorToolViewModel.cs replaced wholesale (local was undivergent).
- Dungeon Tools/SelectTool.cs replaced wholesale (same).
- ScaleObjectSubToolViewModel.cs new file + ScaleObjectCommand added
  to ObjectCommands.cs.
- GameScene._gizmo accessor (delegates to first context's Gizmo).
- TextureImportService: UI render-surface replacement API
  (TryOverwriteUiRenderSurface, TryCreateWriteableBitmapPreview,
  RenderSurfaceWithReplacedPixels, IsRenderSurfaceDatId), plus
  EnsureGidsAllocated filters out deprecated UiRenderSurface entries.

**Wave G** ✅ landed:
- GameScene.RenderTransformGizmo + TryGetParticleGfxId + TryGetStaticDrawModel
  helpers added; render call sits alongside RenderSelectionHighlight
  in the per-frame render loop.
- RenderStaticObjectsPreTransformed (with EnsureUploadBuffer +
  WriteMatrixToBuffer + BatchDrawEntry) ported — accepts a parallel
  list of pre-computed transforms (needed for particles).
- Particle simulation pipeline ported: _particleEmitters dict per
  (lbKey, index), CollectParticleDraws, ParticleAnchorInFrustum,
  per-frame Begin/Advance, additive-blend render call. Particles in
  the visible-objects loop are skipped (rendered separately). Cache
  cleared on InvalidateStaticObjectsCache + ClearAllChunks.
- Weenie spawn pipeline ported: _weenieSpawnObjects ConcurrentDictionary
  with SetWeenieSpawns/ClearWeenieSpawns/ClearAllWeenieSpawns API.
  GetAllStaticObjects folds spawns in when ShowWeenieSpawns is true;
  cleanup hooks in both landblock-unload paths.
- LandblockIntegrated event on GameScene fires when background-loaded
  landblocks fold into the scene.
- LandblockInstanceRecord gains AnglesW/X/Y/Z fields.
- AceDbConnector.GetInstancesAsync(landblockId, cellMin, cellMax,
  includeAngles) for single-landblock outdoor queries.
- LandscapeEditorViewModel weenie spawn loading: ShowWeenieSpawns
  setter triggers LoadWeenieSpawnsForLoadedLandblocks; subscribes to
  Scene.LandblockIntegrated for newly-loaded landblocks; ACE DB
  connection + spawn-fetch + setup-DID resolve + StaticObject build +
  Scene.SetWeenieSpawns; SemaphoreSlim caps DB concurrency at 8.
- ObjectBrowserViewModel.WeenieSetupsLoaded event fires; LandscapeEditor
  ReloadAllWeenieSpawns when new mappings arrive so already-rendered
  landblocks refresh.

**Skipped from upstream's Wave G** (deliberately):
- ~~_pendingModelWarmup queue + DrainPendingModelWarmup helper — would
  smooth weenie-spawn mesh loading. Without it, spawns pointing at
  models not yet warmed will silently skip until something else
  triggers a load. Worth revisiting if it shows up in practice.~~
  ✅ landed 2026-04-29: cross-context `_pendingModelWarmup` queue +
  `DrainPendingModelWarmup` (called from `Update()` after
  `IntegrateBackgroundLoadResults`) + public `QueueModelWarmup(uint, bool)`
  API + `SetWeenieSpawns` enqueue of unique spawn ids. Drain logs
  per-call queue / cached / failed counts.
- _lastSpawnDiag log throttling — diagnostic only. Skipped permanently:
  upstream's diag block depends on per-frame `context` + `_visibleObjectsBuffer`
  plumbing the local doesn't have in the same shape; the new
  `DrainPendingModelWarmup` already prints queue activity.
- _lastVisibleCellHash visibility-cache hash refinement — N/A locally.
  Local `GetAllStaticObjects` doesn't carry the upstream
  `_lastCameraCellId`/`_lastVisibleCellCount` cache fields and
  unconditionally rebuilds whenever `visibility != null`, so the hash
  optimization has nothing to attach to.
- The fancy GenerateWorld replacement in LandscapeEditorViewModel
  (minimap data + progress dialog + town summary panel + CSV export).
  See "the big GenerateWorld upgrade remaining" below.

**Wave F** ⏳ deferred:
- Layout editor overhaul: LayoutEditorViewModel (+416), LayoutPreviewCanvas
  (+260), LayoutEditorView axaml (+188) + axaml.cs (+85). The four
  files are tightly coupled — the VM gains many new property names
  (`ElementGeomXText/YText/WidthText/HeightText/ZText/LeftText/TopText/
  RightText/BottomText`, `ElementReadOrderText`, `ElementTextures`)
  and `ElementTreeNode` gains `PropertyChanged` + `SetBounds` that the
  axaml.cs and PreviewCanvas both consume. Local has its own 100+ LOC
  of `LayoutEditorViewModel` work (custom `LayoutListItem` ctor,
  `BaseLayoutId/BaseLayoutHex` properties, `Summary` field) that a
  wholesale upstream replace would clobber. A careful four-file
  synchronized port is needed; not started.

**Wave E partial follow-ups remaining:**
- ~~ObjectBrowserViewModel BuildItems hasn't been taught to USE the new
  ShowParticleEmitters flag yet~~ ✅ landed 2026-04-26: BuildItems now
  takes an optional particle array; normal-mode ApplyFilter passes the
  `_allParticleEmitterIds` slice (filtered by hex / keyword index) when
  ShowParticleEmitters is true. `OnThumbnailReady` walks FilteredItems
  matching on both `ThumbnailGraphicsId` and `Id` so particle entries
  share thumbnails with their resolved GfxObj. `RequestThumbnails`
  caches/queues by `ThumbnailGraphicsId` and routes the IsSetup flag
  through `IsParticleEmitter ? false : item.IsSetup`. ObjectBrowserView
  axaml already had the "Particles" checkbox bound.
- StaticObjectManager Vertices.TryGetValue refinements (defensive
  against missing vertex keys) — skipped because we currently throw,
  which surfaces bugs faster.
- TextureAtlasManager.FlushMipmaps calls — Chorizite NuGet pin (0.0.17)
  doesn't expose the method. Bump the package or skip permanently.

**The big GenerateWorld upgrade remaining:**
- Upstream replaces our simple Wave E GenerateWorld with one that
  shows a progress dialog, runs Generate on a Task, and after the
  result builds a town summary panel + CSV export. Depends on
  LandblockDocument.ClearAllStatics, TerrainDocument.ApplyBulkImport,
  DocumentManager.SkipDatStatics (stub only — no behaviour),
  Scene.QueueModelWarmup (✅ landed 2026-04-29 as part of the
  common-sense Wave G backfill). Still partially blocked on
  ClearAllStatics / ApplyBulkImport / real SkipDatStatics. Our
  simpler version still works.

## Workflow for porting future commits

### When a small focused fix is missing and looks tractable

1. `git fetch upstream`
2. Identify the SHA. Read the diff: `git show <sha>`.
3. Try `git cherry-pick <sha>` on a side branch:
   ```sh
   git switch -c sync/<short-name>
   git cherry-pick <sha>
   ```
4. On clean apply: build (`dotnet build WorldBuilder/WorldBuilder.csproj` or the relevant
   project) to confirm. On success: push and merge into master via fast-forward.
5. On conflict: inspect with `git diff`. If the conflict surfaces a prereq commit that
   needs porting first, abort (`git cherry-pick --abort`) and either port the prereq or
   mark this commit as 🚫 BLOCKED here.
6. **Do not silence build errors with `#pragma`, empty catches, or fabricated types.**
   If upstream references a type we don't have, that's a missing prereq, not a bug to
   work around.

### When the change is structural / large / dungeon-related

Don't cherry-pick. Read the upstream diff, understand the *behavior* it produces, and
re-implement against the local code structure. Port test cases (or write fresh ones)
that prove the behavior. Verify in-game when possible.

### Known gotchas

- **OAuth `workflow` scope.** This fork's GitHub token can't push commits that modify
  `.github/workflows/*.yml`. Either use a session/credential with `workflow` scope, or
  split the workflow change out of any commit you intend to push.
- **Git LFS write.** This fork can't push to upstream's LFS storage. Modifications to
  `pipeline_data/heightmaps/retail_heightmaps.jsonl` (an LFS pointer) will be rejected.
  Either skip those changes or regenerate the LFS pointer locally with the data you
  have access to.
- **No common ancestor.** `git merge-base master upstream/master` returns nothing.
  Don't attempt `git pull upstream master` — it will refuse, and `--allow-unrelated-histories`
  produces an unmergeable mess.

## Cluster overview (for triage)

| Cluster | Theme | Risk | Recommendation |
|---|---|---|---|
| A. Dungeon editor v2/v3 chain | ~13 commits, sequentially dependent refactors | High | Don't auto-port. Re-implement + verify in-game. |
| B. Weenie / Spell / Monster editor | ~7 commits, new editor surfaces | Med-High | `3457ea7` SpellEditor copy ✅ ported 2026-04-29. `4dc3983` ✅ ported 2026-04-29 in full (Weenie property enums + DID/int pickers + Weenie editor Add/Remove/Create-New + dungeon/landscape browser wire-up; landscape favorites/paging hunks deferred — depend on a paging refactor that isn't in this fork). `d780244` 🟡 spell-editor UX slice ✅ ported 2026-04-29 (presets/undo/validation/toast/paging); landscape+dungeon parts and the `InstancePlacementsPanelView` styling tweak now unblocked behind `d512ef2` and could be revisited. `55604d2` ✅ ported 2026-04-29. `239c0c1` + `92fafff` Monster editor ✅ ported 2026-04-29 (final pass); after they landed, `38b22c2`'s previously-skipped Monster pieces were backfilled and `38b22c2` reclassified ✅ PORTED. `d512ef2` 🟡 PARTIAL re-implemented from intent 2026-04-29 final-final pass: all 10 net-new files landed (OutdoorInstancePlacement / WeeniePickerViewModel / dungeon InstancePlacementsPanel + Add command / landscape AceInstancesPanel), DungeonDocument schema additions for instance placements, Project export hook, four AceDbConnector static SQL helpers, both editors register the new panels, ExportDatsWindowViewModel writes `dungeon_instances.sql` + `landblock_instances.sql` and applies-directly when configured, DungeonScene/ObjectEditingService get the weenie-placement code paths. ObjectBrowser-side load-weenies UX shortcut deliberately skipped (would clobber local's particle/buildings/scenery filter shape). Cluster B is now closed for tractable ports. |
| C. Landscape / heightmap / mini-map | ~5 commits | Medium | `5faec77 → 7293629` is a tractable chain if heightmap import is wanted. |
| D. Texture / DAT export / logging | Cluster effectively closed | Medium | `34c612b` ✅; `15cb9ed` ✅ ported 2026-04-29 (FileLoggerProvider + DatExportFixer landed); `39d68d7` PortalDatDocument export error-handling subset ✅ ported 2026-04-29. |
| E. Chorizite / OpenGL backend | (Originally proposed cluster — debunked: those commits are actually multi-subsystem.) | — | Cluster doesn't really exist as I first defined it. |
| F. Misc fixes | Various | Medium | `fa7c58c` + `44f47f8` ported 2026-04-29; `b9ffe3e` ported 2026-04-29; `38b22c2` ✅ fully ported 2026-04-29 (texture-import safety + docs landed first; Monster `ReplaceRenderSurfaceAsync` + GUI button + preview-Panel background backfilled in the same final pass after `239c0c1`+`92fafff` Monster editor landed); `39d68d7` WorldGen substantive tweaks (BiomeMapper coastal, Building/RoadGenerator improvements) ✅ ported 2026-04-29; FreshStart + big GenerateWorld upgrade skipped on missing prereqs. |

## Subagent pilot finding (2026-04-26)

A pilot subagent was spawned to port `7293629` (mini map, the cleanest "purely additive"
commit). Result: **the cherry-pick succeeded but the build failed** because
`LandSurfaceManager.GetTerrainAverageColors` is missing locally — added by prereq commit
`5faec77` (an 11-file, +718-line "heightmap import + repositioning" commit that itself
touches `AceDbConnector.cs` and `LandscapeEditorViewModel.cs`, both of which have local
modifications).

**Lesson:** even the smallest "purely additive" upstream commit usually has a
non-trivial ancestral dependency. Subagents work mechanically (cherry-pick + build +
report), but each port is realistically a *chain port* of 1–3 commits. Budget
accordingly. The agent correctly halted instead of fabricating types — that's the
behaviour we want, but it limits the throughput.

## Reference: full SHA list of the most-likely-missing window

Saved to `/tmp/upstream_march_april.txt` during the 2026-04-26 audit. Regenerate any
time with:

```sh
git log --no-merges --reverse \
  --pretty=format:"%h | %ad | %an | %s" --date=format:"%Y-%m-%d" \
  upstream/master ^master --since="2026-03-01" \
  > /tmp/upstream_march_april.txt
```
