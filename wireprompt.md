# wireprompt — Headless Wiring Spec for the 2026-04-26 → 2026-04-30 Upstream Sync Wave

> **Format:** Context · Intent · Why · Objectives · Deliverables · Validation
>
> **Scope:** A single round of work that closes the headless-parity debt opened by the
> two-week upstream sync sprint documented in `UPSTREAM_SYNC_NOTES.md` (last full audit
> 2026-04-30). No new editor features, no protocol redesign — only the ports needed so
> a JSON agent or REPL user can drive everything that just landed in the GUI.

---

## 1. Context

### 1.1 Where the project is right now

`WorldBuilder-ACME-Edition` is a fork that ships **two parallel interfaces over one
service layer** (per `README.md` lines 1–7, 27–32):

- `WorldBuilder` — Avalonia GUI (Spell, Skill, Vital, Experience, CharGen, SpellSet,
  Layout, Weenie, Monster/Creature, Object Debug, Dungeon, Landscape editors).
- `WorldBuilder.Terminal` — headless console: batch (`--export`), human REPL, and a
  JSON-line agent protocol (`--stdin`).

The README (line 3) frames the design contract as:

> *"…anything you can do in the editor you can also do from a JSON command stream."*

The **architectural status table** (lines 612–619) treats Phase 1 ("Service Layer
Consolidation") as ✅ done. That is true for terrain / objects / dungeons / ontology
/ stamps — but it is **not** true for the new editor surfaces and DAT-write paths that
landed in the last upstream wave.

### 1.2 What the upstream sync wave landed (2026-04-26 → 2026-04-30)

`UPSTREAM_SYNC_NOTES.md` (470 lines, last updated 2026-04-30) tracks the manual port
of upstream commits with no shared ancestor. The table at lines 72–116 records 20
PORTED, 5 PARTIAL, 4 BLOCKED, 13 DEFERRED across the March + April 2026 window. The
ports that are relevant to this spec (i.e. introduce new headless-relevant logic):

| Upstream commit | Subject | What it added | Where the code lives |
|---|---|---|---|
| `5faec77` 03-05 | heightmap import + reposition | `HeightmapImportService` (BuildChanges / Luminance / FindClosestTerrainType) — pure logic, no UI deps. | `WorldBuilder/Editors/Landscape/HeightmapImportService.cs` (currently in GUI project, ~150 LOC) |
| `34c612b` 04-11 | defer portal writes via `PortalDatDocument` | `TextureImportService.TryOverwriteUiRenderSurface(path, id, portalDoc)` (deferred portal writes; 3-arg local signature). | `WorldBuilder/Services/TextureImportService.cs` (594 LOC) |
| `38b22c2` 04-12 | texture fixes + docs | `TextureImportService.TryImportRenderSurfaceReplacement(path, id, name, out err)` — A8R8G8B8 / dimensions validation; render-surface-by-id overwrite; new `WriteRenderSurfaceReplacementsToDats` export tail. | same file |
| `15cb9ed` 04-14 | logging + dat-export fix | `WorldBuilder/Lib/FileLogging.cs` (Log rotation, level/enabled live from settings); `DatExportFixer` (`PatchFreeBlocksBeforeExport`, `FixLeafBranchSentinels`) wired into `Project.ExportDats`. | `WorldBuilder/Lib/FileLogging.cs` (168 LOC), `WorldBuilder.Shared/Lib/DatExportFixer.cs` (237 LOC) |
| `3457ea7` 04-10 + `d780244` 04-11 + `55604d2` 04-11 | SpellEditor copy + UX | `SpellRecord` (60+ ACE-DB columns), `SpellDbDocument` (per-project cache keyed by spell id), `AceDbConnector.GetSpellAsync` / `SaveSpellAsync` (full INSERT … ON DUPLICATE KEY UPDATE), `CloneDbSpellRecord(SpellRecord, uint)` helper, presets (Blank/Basic Bolt/Basic Buff/Basic Portal), validation gate, page-of-500 newest-first paging. | `WorldBuilder.Shared/Lib/AceDb/SpellRecord.cs`, `WorldBuilder.Shared/Documents/SpellDbDocument.cs`, `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.cs:307–671`, `WorldBuilder/Editors/Spell/SpellEditorViewModel.cs` (1478 LOC; UX logic only above the data layer) |
| `4dc3983` 03-23 | Weenie property enums + DID/int pickers + `InsertWeenieAsync` | `AceWeeniePropertyEnums.cs` (873 LOC: AcePropertyInt/Int64/Bool/Float/String/DataId/InstanceId), `AceWeenieDidPickerModes.cs`, `AceWeenieIntEnumOptions.cs`, 16 EntityEnums files; templates expanded 1 → 13 (`WeenieTemplates.json`); `AceDbConnector.Weenie.InsertWeenieAsync(className, snapshot)` (auto-assigns class_Id ≥ 100 000, full transactional insert). | `WorldBuilder.Shared/Lib/AceDb/AceWeeniePropertyEnums.cs` etc., `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Weenie.cs:262+`, `WorldBuilder/Data/WeenieTemplates.json` |
| `239c0c1` 04-09 + `92fafff` 04-09 | Monster builder + editor improvements | `AceCreatureSnapshot` (creature row mirror + animation-part fields), `AceDbConnector.Creature.cs` (`LoadCreatureOverridesAsync` / `SaveCreatureOverridesAsync` / `GenerateCreatureOverridesSql`), Monster editor with part-swap / hide-part / texture-remap (UI). | `WorldBuilder.Shared/Lib/AceDb/AceCreatureSnapshot.cs`, `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Creature.cs` (218 LOC), `WorldBuilder/Editors/Monster/MonsterEditorViewModel.cs` (1030 LOC — includes the headless-relevant CRUD plus the GUI-only preview wiring) |
| `d512ef2` 03-10 | ACE DB instance placements | `OutdoorInstancePlacement` (Vector3/Quaternion + Angles fields), `DungeonInstancePlacement` MemoryPackable, `DungeonDocument.InstancePlacements`, `AceDbConnector.GenerateInsertSql` / `GenerateInsertSqlBatch` / `ToLandblockInstanceRecords[FromOutdoor]`, `Project.OutdoorInstancePlacements` + `OnExportDungeonInstances` hook + `ExportDats` invocation. | `WorldBuilder.Shared/Models/OutdoorInstancePlacement.cs`, `WorldBuilder.Shared/Documents/DungeonDocument.cs:14–84`, `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.cs:211–298` |
| `f26345e` 03-22 Wave F (landed 2026-04-30) + `34c612b` plumbing | Layout editor overhaul | `LayoutDescBinary` (clone + read), `LayoutDatDocument` (per-project layout overlay; `SetLayout` / `TryGetLayout` / `RemoveLayout`), `LayoutMediaHelper.PopulateStateRows`, deferred-write `_portalDoc` plumbing through `LayoutDetailViewModel`. | `WorldBuilder.Shared/Lib/LayoutDescBinary.cs`, `WorldBuilder.Shared/Documents/LayoutDatDocument.cs`, `WorldBuilder/Editors/Layout/LayoutEditorViewModel.cs` (491 LOC — UX shell only) |
| `7d6ce84` 04-12 (BLOCKED) | UI string resolver | `LayoutUiStringResolver` + StringTable in `DefaultDatReaderWriter` switch. Pure-additive halves are tractable; the `LayoutEditorViewModel` consumer half is BLOCKED on a divergent `_stringDats` shape. | `WorldBuilder/Editors/Layout/...` (upstream — not present locally) |
| `39d68d7` 03-31 + 2026-04-30 follow-up | WorldGen upgrade + FreshStart | `LandblockDocument.ClearAllStatics`, real `SkipDatStatics` early-return in `LandblockDocument.InitInternal`, `DocumentManager.ResetWorldDocumentsAsync`, `LandscapeEditorViewModel.FreshStart` + `GenerateWorld` (progress dialog + town summary + `ExportTownsCsv` + `BuildAceTeleLoc` + `GetTownTelelocAnchor`); BiomeMapper coastal water bands; PortalDatDocument schema-changed log + `ArgumentException` catch. | `WorldBuilder.Shared/Documents/{DocumentManager,LandblockDocument}.cs`, `WorldBuilder.Shared/Lib/WorldGen/*.cs`, `WorldBuilder/Editors/Landscape/ViewModels/LandscapeEditorViewModel.cs:625–943` |

**Pre-existing gap analysis** (`docs/gui_terminal_gap_analysis_2026-03-25.md`, dated
*before* this sync wave) already flagged Spell / Skill / Vital / Experience / CharGen
/ Layout / SpellSet table editors as missing from the headless surface and proposed
P1/P2/P3 command families. That document is now stale: the gap has grown, not shrunk.

### 1.3 What `WorldBuilder.Terminal` exposes today

REPL handler table (`TerminalRepl.cs:83–199`) and JSON dispatch table
(`JsonCommandProcessor.cs:151–264`) — both keyed off the same `CommandEngine`
(`CommandEngine.cs`, 11 577 LOC) and same `HeadlessProjectManager`.

REPL only (not in JSON): `terrain` (sample-height), `analyze-map-image`,
`calibrate-world-map`, `quick-world`, `remap-buildings*`, `ace-db` (`connect`,
`status`, `query-instances`, `reposition`, `export-sql`, `stats`, `clear-instances`),
`dungeon` (`add-cell`, `remove-cell`, `connect`, `disconnect`, `validate`, `autofix`,
`recompute`, `reload`, `copy-cells`, `move-cell`, `rotate-cell`, `move-object`,
`rotate-object`, `set-cell-position`, `set-cell-rotation`, `set-object-position`,
`set-object-rotation`).

JSON-only or both: terrain edit + query family (`raise`/`lower`/`smooth`/`set-height`
/`paint`/`fill`/`road`, `get-height`/`terrain-info`/`get-heightmap`/`get-terrain-data`),
object family (`list-objects`/`add-object`/`remove-object`/`clear-objects`/
`move-object`/`rotate-object`/`get-object-detail`), dungeon analytics (`analyze-*`,
`get-dungeon-info`), validation 6-pack, `transact` + `transact-diff`, the three
observation channels (`render-preview`, `describe-landblock`, `compare-to-retail`),
the static-site emitter chain (`extract-cell-footprints`, `generate-object-sprites`,
`render-dungeon`, `emit-tile-pyramid`, `describe-floor`, `emit-static-site`),
ontology + enrichment, ML pipeline ingest (`ingest-spawn-maps`, `ingest-spells`,
`ingest-recipes`, `ingest-weenies`, `enrich-*`, `apply-population`, `compute-vanilla-baseline`, `extract-retail-heightmaps`, `export-training-data`,
`export-raw-world-facts`), the `f26345e` headless slices (`obj-export`, `obj-import`,
`bsp-build`, `weenie-snapshot`, `weenie-template-list`, `weenie-template-apply`,
`worldgen`, `worldgen-analyze-buildings`, `worldgen-scan-retail-towns`).

**Empirical gap test:** `grep -l` for any of `SpellRecord`, `SpellDbDocument`,
`AceCreatureSnapshot`, `AceWeeniePropertyEnums`, `LayoutDescBinary`, `LayoutDatDocument`,
`HeightmapImportService`, `TextureImportService`, `DatExportFixer`, `FileLogger`,
`FreshStart`, `ResetWorldDocumentsAsync`, `ExportTownsCsv`, `OutdoorInstancePlacement`,
`DungeonInstancePlacement`, `InsertWeenieAsync`, `GetSpellAsync`, `SaveSpellAsync`
inside `WorldBuilder.Terminal/` returns **zero hits**. Every one of these subsystems
exists only in `WorldBuilder.Shared/` and `WorldBuilder/`.

---

## 2. Intent

Wire the 2026-04-26 → 2026-04-30 upstream sync wave into `WorldBuilder.Terminal` —
both the JSON agent protocol and the human REPL — so the README's stated contract
("anything you can do in the editor you can also do from a JSON command stream")
becomes true again at the close of the sprint.

This means **three concrete moves** for each in-scope feature cluster:

1. **Promote** any GUI-housed pure logic to `WorldBuilder.Shared` so `CommandEngine`
   can reach it without an Avalonia reference. (Pattern precedent:
   `f26345e` Slice 3 moved 10 WorldGen files from `WorldBuilder.Editors.Landscape.WorldGen`
   to `WorldBuilder.Shared.Lib.WorldGen` because they had zero Avalonia deps.)
2. **Expose** the operation on `CommandEngine` with a result type in
   `CommandResults.cs`, then bind it on both surfaces — `JsonCommandProcessor` handler
   + `TerminalRepl` handler.
3. **Document** in `docs/agent_api_reference.md`, `docs/agent_api_schema.json`, and
   `docs/terminal_repl_commands.md`. Add Python protocol-test coverage in
   `tests/test_agent_protocol.py`.

The intent is **not** to redesign the protocol, port the dungeon-refactor chain
(Cluster A — 13 commits, deliberately deferred), or build new editors. It is to close
the gap that the recent porting opened, and to do so in the established service-layer
pattern.

---

## 3. Why

### 3.1 The promise on the tin

The README sells WorldBuilder.ACME as a tool whose entire engine is reachable from
both interfaces. The April sync added enough GUI-only feature surface (Layout overhaul,
Monster editor, Spell DB save, Weenie property pickers, FreshStart, Outdoor + Dungeon
Instance Placements, RenderSurface replacement, Heightmap import) that this is
demonstrably no longer true. Headless agents cannot regenerate a world via FreshStart,
cannot bulk-insert weenies or save spell rows, cannot export `dungeon_instances.sql`
without first opening the GUI.

### 3.2 The agent loop is a single-process loop

The `transact` / `transact-diff` / observation-channel architecture is built on the
premise that an LLM agent runs **inside one terminal process** and never escapes to
the GUI for any operation. Every GUI-only DAT-mutation primitive added in the sync
wave is a pinhole leak in that container. Specifically:

- `transact`'s op alphabet (`README.md:189`) is "all mutating commands" and is
  allow-listed. Every new mutator added below should land on that allow-list, or it
  silently can't participate in atomic batches — which is the whole point of
  `transact`.
- The validation engine has 34 codes today. The new mutators (RenderSurface
  replacement, weenie insert, instance placement export) introduce DAT-write paths
  that the current validators can't see. Wiring them through `CommandEngine` means
  they get the same up-front validation pass that every other mutator gets.

### 3.3 The ML pipeline needs DB CRUD

The README's North Star is the train → place → score → tune loop running hot inside a
single agent process (line 268). That loop now wants to:

- Insert generated weenies into ACE DB (`InsertWeenieAsync`) — currently GUI-only.
- Save spell rows when balancing is automated (`SaveSpellAsync`) — currently GUI-only.
- Apply creature visual overrides at scale (`SaveCreatureOverridesAsync`) — currently
  GUI-only.
- Export `dungeon_instances.sql` + `landblock_instances.sql` after a generation pass
  (the `OnExportDungeonInstances` Project hook fires only inside `ExportDats`, which
  the headless `export` command does call — but the corresponding *placement
  insertion/edit* APIs that *populate* those lists are GUI-only).

A headless ML loop that has to bounce through the GUI for any of these is operationally
broken. The ports are cheap; the absence is expensive.

### 3.4 The deferred work fences itself

This wireprompt explicitly **excludes** the dungeon-editor v2/v3 refactor chain
(`UPSTREAM_SYNC_NOTES.md` Cluster A — `da88e74`, `7b89961`, `f45e230`, `0aec0dc`,
`9a0dbc3`, `cd3e377`, `33709a5`, `0998c38`, `c66b13f`, `40e9567`, `675fb1d`,
`ff36b20`, `b671cee`) because those are sequentially-dependent refactors that need
in-game testing. Wiring up what's *already merged* doesn't take on that risk.

---

## 4. Objectives

The objectives below are grouped by feature cluster. Each one names: the public API
to expose, the current location, the proposed move (if any), and the acceptance check.

### O1. RenderSurface texture replacement → headless

**API to expose** (from `WorldBuilder/Services/TextureImportService.cs`):

- `TryImportRenderSurfaceReplacement(string imagePath, uint renderSurfaceId, string name, out string error)` — line 118. Pure logic; image-decode + A8R8G8B8 / dimensions validation + `CustomTextureStore` write.
- `TryOverwriteUiRenderSurface(string imagePath, uint renderSurfaceId, PortalDatDocument portalDoc)` — line 197. Defers writes via `PortalDatDocument`.
- `LoadImageAsBgra(string imagePath, int targetWidth=512, int targetHeight=512)` — line 168.
- `IsRenderSurfaceDatId(uint id)` static — line 190.

**Move:** `TextureImportService` currently lives in `WorldBuilder/Services/`. It
references `Avalonia.Media.Imaging.WriteableBitmap` (line 254 — `TryCreateWriteableBitmapPreview`).
Split: keep the bitmap-preview helper in GUI; promote everything else to
`WorldBuilder.Shared/Services/TextureImportService.cs` (or a dedicated
`WorldBuilder.Shared.Lib.Texture.RenderSurfaceImporter` static class for the
non-instance methods).

**Headless commands:**

- `import-render-surface <imagePath> <id> [--ui]` (REPL) ↔
  `{ "command": "import-render-surface", "imagePath": "...", "renderSurfaceId": 0x06000123, "ui": false }` (JSON).
  - `--ui` / `"ui":true` routes through `TryOverwriteUiRenderSurface` against the
    `PortalDatDocument`; default routes through `TryImportRenderSurfaceReplacement`.
  - Response: `{ success, command, renderSurfaceId, name, deferred: true|false }`.

**Acceptance:** an A8R8G8B8 PNG of matching dimensions is accepted; a DXT or wrong-size
image is rejected with the same error string the GUI shows; the round-trip via
`export` writes the replacement back to `client_portal.dat` (verifiable via
`AceDbConnector` is irrelevant here — this is a DAT round-trip, so the test is "import,
export, reopen, see the new pixels").

### O2. Heightmap import → headless

**API to expose** (`WorldBuilder/Editors/Landscape/HeightmapImportService.cs`):

- `LoadAndResampleRgb(string filePath, int targetWidth, int targetHeight)` — line 40.
- `BuildChanges(grid, startLbX, startLbY, lbCountX, lbCountY, terrainSystem, averageColors)` — line 95. Returns `Dictionary<ushort, List<VertexChange>>`.
- `GetTargetDimensions(int lbCountX, int lbCountY)` — line 33.
- `Luminance` / `FindClosestTerrainType` — already pure.

**Move:** This entire file is pure logic. No `Avalonia.*` imports. Verbatim move to
`WorldBuilder.Shared/Lib/Terrain/HeightmapImportService.cs`. Acceptance: existing GUI
landscape editor still compiles after the using-namespace swap.

**Headless commands:**

- `import-heightmap <imagePath> <startLbX> <startLbY> <lbCountX> <lbCountY> [--apply]` (REPL) ↔ `{ "command": "import-heightmap", ... }` (JSON).
  - Default is dry-run → returns per-LB change counts (additive on top of existing
    `worldgen` dry-run pattern).
  - `--apply` writes the changes via `TerrainDocument.ApplyBulkImport` (already used
    by `worldgen --apply`).
- Allow-list this command in `TransactionEngine` — `import-heightmap --apply` is a
  bulk mutator and belongs in the same family as `set-landblock-heightmap`.

**Acceptance:** A 254×254 PNG of Holtburg's region applied to LBs (169..172, 178..181)
produces the same `Dictionary<ushort, List<VertexChange>>` map the GUI's Import
Heightmap dialog produces against the same project.

### O3. ACE DB Spell save / fetch → headless

**API to expose** (`WorldBuilder.Shared/Lib/AceDb/AceDbConnector.cs`):

- `GetSpellAsync(uint id, CancellationToken ct = default)` — line 307. Returns `SpellRecord?`.
- `SaveSpellAsync(SpellRecord spell, CancellationToken ct = default)` — line 430. INSERT … ON DUPLICATE KEY UPDATE the full row.
- Helper to clone a spell with a new id from `SpellEditorViewModel.CloneDbSpellRecord` — promote to a `SpellRecord.CloneWithNewId(uint newId)` instance method on `WorldBuilder.Shared.Lib.AceDb.SpellRecord`.

**Document plumbing:** `SpellDbDocument` (`WorldBuilder.Shared/Documents/SpellDbDocument.cs`) exposes `TryGet(id, out spell)` / `Set(id, spell)` / `Remove(id)`. CommandEngine should resolve this document via `_projectManager.Project.DocumentManager.GetOrCreateDocumentAsync<SpellDbDocument>(SpellDbDocument.DocumentId)`.

**Headless commands** (REPL `spell <sub>` family, mirrored under `ace-db spell <sub>` is also acceptable):

- `spell list [--limit N] [--from-db|--from-dat]`
- `spell get <id>` — returns the full SpellRecord JSON.
- `spell save <id> [--from-json <path>]` — accepts a JSON SpellRecord on stdin or from a file; routes through `SaveSpellAsync` when ace-db is connected, otherwise updates the DAT-backed spell table only.
- `spell copy <fromId> [<newId>]` — auto-assigns `_allSpells.Keys.Max() + 1` when `newId` is omitted (matches the editor's behavior).
- `spell delete <id>`
- `spell apply-preset <id> <Blank|BasicBolt|BasicBuff|BasicPortal>` — port the preset table from `SpellEditorViewModel`'s `ApplyPresetToSelected`.

**JSON dispatch:** `{ "command": "spell-list" }`, `{ "command": "spell-get", "id": 1234 }`, etc. Bind under both names in the REPL switch (single subcommand parser) and individual JSON commands.

**Acceptance:** `spell get 6001` against a connected ace_world matches the GUI editor's view of the same row byte-for-byte. `spell copy 6001` produces a new id ≥ `max(id) + 1`, and `spell save` round-trips through MySQL.

### O4. ACE DB Weenie insert / scalar save → headless

**API to expose** (`WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Weenie.cs`):

- `LoadWeenieSnapshotAsync(uint classId, ct)` — line 110.
- `SaveWeenieScalarsAsync(AceWeenieSnapshot snapshot, ct)` — line 163.
- `InsertWeenieAsync(string className, AceWeenieSnapshot snapshot, ct)` — line 262. Auto-class-id ≥ 100 000.

`weenie-snapshot` already exists (REPL/JSON), but **only as a read** of the DAT-side
snapshot. Add the write side.

**Headless commands:**

- `weenie save <classId> [--from-json <path>]` — routes to `SaveWeenieScalarsAsync`.
- `weenie insert <className> [--from-template <name> | --from-json <path>] [--class-id <id>]` — routes to `InsertWeenieAsync`. Template selection reuses `WeenieTemplateCatalog` (already exposed via `weenie-template-list` / `weenie-template-apply`).
- `weenie delete <classId>` — sql-DELETE row + properties; new method on `AceDbConnector.Weenie.cs` (scope: 30-line helper).
- `weenie list-property-keys <int|int64|bool|float|string|did|iid>` — enumerates the new `AcePropertyInt` / `AcePropertyBool` / etc. enum values from `AceWeeniePropertyEnums.cs` so an agent can discover what scalar keys exist without reading the source.

**Acceptance:** `weenie insert generic --from-template generic` inserts a row,
`weenie save <returnedId>` mutates a scalar, `weenie list-property-keys int` returns
the same labels GUI's `WeenieEditorViewModel.AllIntTypes` shows.

### O5. ACE DB Creature visual overrides → headless

**API to expose** (`WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Creature.cs`):

- `LoadCreatureOverridesAsync(uint objectId, ct)` — line 16.
- `SaveCreatureOverridesAsync(AceCreatureOverrides overrides, ct)` — line 121.
- `GenerateCreatureOverridesSql(AceCreatureOverrides overrides)` static — line 173.

**Headless commands:**

- `creature get <objectId>` — returns `AceCreatureOverrides` JSON.
- `creature save <objectId> [--from-json <path>]` — applies via `SaveCreatureOverridesAsync`.
- `creature export-sql <objectId> [--out <path>]` — writes the `GenerateCreatureOverridesSql` output.

**Acceptance:** GUI Monster editor's part-swap / hide-part / texture-remap state can
be round-tripped via these three commands.

### O6. ACE DB Outdoor + Dungeon Instance Placements → headless

**API to expose:**

- `Project.OutdoorInstancePlacements` (already a public list).
- `Project.OnExportDungeonInstances` hook (line 171; already invoked in `ExportDats:543`).
- `AceDbConnector.GenerateInsertSql(record)` / `GenerateInsertSqlBatch(records)` — line 211 / 237.
- `AceDbConnector.ToLandblockInstanceRecords(landblockId, IEnumerable<DungeonInstancePlacement>)` — line 250.
- `AceDbConnector.ToLandblockInstanceRecordsFromOutdoor(IEnumerable<OutdoorInstancePlacement>)` — line 276.
- `DungeonDocument.InstancePlacements` (line 83).

**Headless commands** (REPL `placement <sub>` family):

- `placement list [--lb <lbX> <lbY>] [--outdoor|--dungeon]`
- `placement add-outdoor <lbX> <lbY> <wcid> <cellNumber> <originX> <originY> <originZ> [--angles w x y z]` — appends to `Project.OutdoorInstancePlacements`.
- `placement add-dungeon <lbX> <lbY> <wcid> <cellNumber> <originX> <originY> <originZ> [--angles w x y z]` — appends to the dungeon document's `InstancePlacements`.
- `placement remove <kind> <index>` — by index in either list.
- `placement export-sql [--out <dir>] [--apply]` — writes `landblock_instances.sql` (outdoor) and `dungeon_instances.sql` (dungeon) into `<dir>` (default project-root), and runs `AceDbConnector.ExecuteSqlAsync` when `--apply` is set + ace-db is connected. Matches `ExportDatsWindowViewModel` behavior.

**Allow-list mutators** (`add-outdoor` / `add-dungeon` / `remove`) in
`TransactionEngine`. `export-sql` is a side-effecting op (writes files / hits DB) and
stays excluded from `transact`.

**Acceptance:** ace_world `landblock_instance` table rows from a `placement export-sql --apply` match the GUI's `ExportDatsWindow`'s "apply directly" output.

### O7. Layout viewer / DAT overlay → headless (read-only)

**API to expose:**

- `LayoutDescBinary.Clone(LayoutDesc source, uint id, IDatReaderWriter dats)` — `WorldBuilder.Shared/Lib/LayoutDescBinary.cs`.
- `LayoutDatDocument.HasStoredLayout(layoutId)` / `TryGetLayout(layoutId, out layout)` / `SetLayout(layoutId, layout)` / `RemoveLayout(layoutId)` — `WorldBuilder.Shared/Documents/LayoutDatDocument.cs:42–101`.

**Headless commands** (read-only — no preview canvas in headless mode):

- `layout list [--overlay-only]` — lists every `LayoutDesc` ID from the DAT (or only the ones that have a project overlay).
- `layout get <id>` — returns the LayoutDesc JSON (Width/Height/Elements tree, primary surface id per element).
- `layout save <id> [--from-json <path>]` — writes through `LayoutDatDocument.SetLayout`.
- `layout delete-overlay <id>` — removes the project overlay (DAT original is untouched).

**Out of scope:** the visual preview canvas, drag-resize, render-surface decode for
preview — those are GUI features. Headless agents work in JSON.

**Acceptance:** `layout list --overlay-only` returns every id the GUI list panel
shows with the `*` suffix.

### O8. FreshStart + GenerateWorld parity → headless

**API to expose:**

- `DocumentManager.ResetWorldDocumentsAsync()` — `WorldBuilder.Shared/Documents/DocumentManager.cs:274`. Clears active LB docs, deletes inactive LB + dungeon docs.
- `WorldGenerator` + `WorldGeneratorParams` — already in `WorldBuilder.Shared/Lib/WorldGen/`.
- The `LandscapeEditorViewModel.GenerateWorld:668` flow (`Task.Run` apply, `SkipDatStatics` toggle, warmup queue, town summary) — distill into a `WorldGenerationOrchestrator` static class in `WorldBuilder.Shared/Lib/WorldGen/`.
- `LandscapeEditorViewModel.ExportTownsCsv:857` + `LandscapeEditorViewModel.BuildAceTeleLoc:923` — promote both to `WorldBuilder.Shared/Lib/WorldGen/TownsExporter.cs` (pure logic).

**Headless commands:**

- `fresh-start` (REPL/JSON) — runs `ResetWorldDocumentsAsync` + clears terrain to `WaterDeepSea` + deletes dungeons. **Confirmation is interactive in REPL only.** JSON requires `"confirm": true`. Add to JSON `transact` allow-list **after** confirming the agent flow uses it deliberately (it's destructive — defaults to **off** the allow-list).
- `generate-world [--params <json>] [--export-towns-csv <path>] [--apply]` — extends the existing `worldgen` command. Default dry-run. `--apply` runs the same Generate → ResetWorldDocs → bulk-import → buildings → decorations flow as the GUI.
- `export-towns-csv [--from-result <path>] [--out <path>]` — accepts a serialized `WorldGeneratorResult` OR re-runs from the current project state, writes the same CSV the GUI's "Export Towns CSV" button writes.

**Acceptance:** A FreshStart followed by `generate-world --apply --export-towns-csv ./towns.csv` reproduces the GUI's WorldGen progress dialog → town summary CSV flow byte-for-byte.

### O9. DAT export safety → already-wired audit

**API:** `DatExportFixer.PatchFreeBlocksBeforeExport` / `FixLeafBranchSentinels`
(`WorldBuilder.Shared/Lib/DatExportFixer.cs:48,87`). These are already invoked from
`Project.ExportDats` per the 2026-04-29 port.

**Audit task:** verify that the headless `export <directory>` command (REPL +
JSON) routes through the same `Project.ExportDats` and therefore picks up
`DatExportFixer` automatically. If a parallel headless export path exists in
`CommandEngine` that bypasses it, fold it back into `Project.ExportDats`.

**Acceptance:** a `dotnet test`-runnable assertion that opening the post-export
`client_portal.dat` succeeds via the ACE-shape DAT loader (the failure mode
`DatExportFixer` is supposed to prevent).

### O10. File logging → headless

**API:** `WorldBuilder/Lib/FileLogging.cs` (`FileLoggerProvider`, `FileLogger`,
`FileLogSink`).

**Move:** Promote to `WorldBuilder.Shared/Lib/Logging/FileLogging.cs`. The existing
`AppSettings.EnableFileLogging` + `AppSettings.MaxLogFileSizeMb` already drive it; the
Terminal needs a parallel settings hook (`HeadlessProjectManager` should read its
own `terminal.settings.json` or fall back to the GUI's `WorldBuilderSettings.App`).

**Headless surface:**

- `--log-file <path>` CLI flag (additive on `CommandLineArgs.cs`) for batch / REPL.
- `{ "command": "open-log-folder" }` → JSON-mode hint that returns the active log
  path so the agent can ingest it (no actual folder-opening — that's GUI-only).

**Acceptance:** `dotnet run --project WorldBuilder.Terminal -- --stdin --log-file /tmp/wb.log` writes a populated rotated log file with the same format the GUI writes.

### O11. Catalog + protocol documentation

For every command added in O1–O10:

1. Append a row to `docs/agent_api_reference.md` with the same response-shape table
   the existing 32 commands use.
2. Update `docs/agent_api_schema.json` so the JSON schema validates the new commands.
3. Add the human REPL spelling to `docs/terminal_repl_commands.md` under the
   right category (most belong under a new "ACE Database Editing" + existing
   "Texture Tools" / "World Generation" sections).
4. Add a Python integration test per command in `tests/test_agent_protocol.py` that
   spawns `--stdin` mode, sends the command, asserts on the response shape. Reuse
   the existing fixtures.

**Acceptance:** the `gh actions run` integration-test job (or the local equivalent
`pytest tests/`) goes from N to N+~25 passing tests with no regressions.

---

## 5. Deliverables

| # | Deliverable | Files touched (primary) | LOC est. |
|---|---|---|---|
| D1 | RenderSurface import (O1) | `WorldBuilder.Shared/Services/TextureImportService.cs` (new), `WorldBuilder.Terminal/CommandEngine.cs`, `WorldBuilder.Terminal/JsonCommandProcessor.cs`, `WorldBuilder.Terminal/TerminalRepl.cs` | ~250 |
| D2 | Heightmap import (O2) | `WorldBuilder.Shared/Lib/Terrain/HeightmapImportService.cs` (move), wiring in 3 Terminal files | ~120 |
| D3 | Spell DB CRUD (O3) | `CommandEngine.Spell.cs` (new partial), JSON + REPL handlers | ~400 |
| D4 | Weenie DB CRUD (O4) | `CommandEngine.Weenie.cs` (extend), JSON + REPL handlers, `weenie delete` SQL helper on `AceDbConnector.Weenie.cs` | ~300 |
| D5 | Creature overrides (O5) | `CommandEngine.Creature.cs` (new partial), JSON + REPL handlers | ~180 |
| D6 | Instance placements (O6) | `CommandEngine.Placements.cs` (new partial), JSON + REPL handlers, allow-list updates in `TransactionEngine.cs` | ~350 |
| D7 | Layout viewer (O7) | `CommandEngine.Layout.cs` (new partial), JSON + REPL handlers | ~220 |
| D8 | FreshStart + GenerateWorld (O8) | `WorldBuilder.Shared/Lib/WorldGen/WorldGenerationOrchestrator.cs` (new), `WorldBuilder.Shared/Lib/WorldGen/TownsExporter.cs` (new), wiring | ~450 |
| D9 | Export safety audit (O9) | Verification + 1 test, no new code expected | ~30 |
| D10 | File logging (O10) | `WorldBuilder.Shared/Lib/Logging/FileLogging.cs` (move), `CommandLineArgs.cs` flag, JSON hint | ~120 |
| D11 | Docs + tests (O11) | `docs/agent_api_reference.md`, `docs/agent_api_schema.json`, `docs/terminal_repl_commands.md`, `tests/test_agent_protocol.py` | ~500 |

**Total:** ~2 920 LOC across roughly 12 new/extended files. About a quarter of that is
docs and tests.

**Result-type pattern:** add records to `WorldBuilder.Terminal/CommandResults.cs`
(currently 1 223 LOC, holds every other result type — keep it as the single result
namespace).

**Partial-class pattern:** `CommandEngine.cs` is 11 577 LOC. Don't append. Use partial
classes (`CommandEngine.Spell.cs`, `CommandEngine.Weenie.cs`, …) the way upstream's
`AceDbConnector` is split across `.cs` / `.Weenie.cs` / `.Creature.cs`.

---

## 6. Validation

For each cluster O1..O8:

1. **Build clean:** `dotnet build WorldBuilder.slnx` zero-warning across Shared,
   WorldBuilder, Terminal, Tests.
2. **GUI parity test:** open the GUI editor for the cluster (Spell editor for O3,
   Weenie editor for O4, etc.), perform an operation, capture the on-disk diff
   (project SQLite + ace_world rows). Run the equivalent headless command on a
   fresh copy of the project. Diffs must match.
3. **JSON protocol test:** `tests/test_agent_protocol.py` adds one happy-path and
   one error-path test per command. Use the existing `test_*.py` fixtures.
4. **REPL smoke test:** `tests/Test-AgentProtocol.ps1` adds one happy-path
   invocation per REPL command.
5. **`transact` integration:** for each new mutator added to the allow-list, an
   `ops.json` fixture batches it with an existing op and round-trips
   `transact` → `transact-diff`.
6. **Docs are not optional:** PR is rejected if `docs/agent_api_reference.md` is not
   updated. The README's "32 documented commands" / "110+ REPL commands" line counts
   should be updated with the new totals.

---

## 7. Out of scope

- The dungeon-editor v2/v3 refactor chain (Cluster A in `UPSTREAM_SYNC_NOTES.md`).
  Those are sequentially-dependent and need in-game testing.
- The `7d6ce84` `LayoutEditorViewModel` consumer half (BLOCKED on a divergent
  `_stringDats` shape — pure-additive halves are tractable but defer until Wave F's
  `_stringDats` is reconciled).
- ObjectBrowser-side `PlaceWeenieAsInstance` UX shortcut (the `AceInstancesPanel`
  drives the same write through `OutdoorInstancePlacements` — this is GUI ergonomics
  with no headless equivalent needed).
- Surface browser favorites / paging UX (GUI ergonomics).
- `44f47f8` gizmo improvements (GUI render-only).
- Wave G particle simulator + weenie-spawn rendering (GUI render-only — the data
  layer pieces, e.g. `Scene.SetWeenieSpawns`, are upstream-of-render and already
  feed from `AceDbConnector.GetInstancesAsync` which is reachable via
  `ace-db query-instances`).
- `.github/workflows/*.yml` modifications (PERMISSIONS-blocked on `workflow` token
  scope; tracked in `UPSTREAM_SYNC_NOTES.md`).

---

## 8. Quick reference — file map

```
WorldBuilder.Shared/
├── Lib/AceDb/
│   ├── AceDbConnector.cs              (GetSpellAsync 307, SaveSpellAsync 430,
│   │                                   GenerateInsertSql 211, ExecuteSqlAsync 300)
│   ├── AceDbConnector.Weenie.cs       (InsertWeenieAsync 262, SaveWeenieScalarsAsync 163)
│   ├── AceDbConnector.Creature.cs     (LoadCreatureOverridesAsync 16,
│   │                                   SaveCreatureOverridesAsync 121,
│   │                                   GenerateCreatureOverridesSql 173)
│   ├── AceWeeniePropertyEnums.cs      (873 LOC — int/int64/bool/float/string/did/iid)
│   ├── AceWeenieTypes.cs              (AceWeenieType + AcePropertyDataId + labels)
│   ├── SpellRecord.cs                 (60+ ACE columns; needs CloneWithNewId)
│   └── EntityEnums/                   (16 enum files)
├── Documents/
│   ├── DocumentManager.cs             (ResetWorldDocumentsAsync 274)
│   ├── DungeonDocument.cs             (DungeonInstancePlacement 59,
│   │                                   InstancePlacements 83)
│   ├── LandblockDocument.cs           (ClearAllStatics, SkipDatStatics gate)
│   ├── LayoutDatDocument.cs           (SetLayout 46, TryGetLayout 71,
│   │                                   RemoveLayout 101)
│   └── SpellDbDocument.cs             (TryGet 38, Set 48, Remove 57)
├── Lib/
│   ├── DatExportFixer.cs              (PatchFreeBlocksBeforeExport,
│   │                                   FixLeafBranchSentinels)
│   ├── LayoutDescBinary.cs            (Clone, read)
│   └── WorldGen/                      (BiomeMapper, WorldGenerator,
│                                       BuildingPlacer, RoadGenerator, …)
└── Models/
    ├── OutdoorInstancePlacement.cs    (LandblockId, WeenieClassId, CellNumber,
    │                                   Origin, AnglesW/X/Y/Z)
    └── Project.cs                     (OutdoorInstancePlacements 149,
                                        OnExportDungeonInstances 171,
                                        ExportDats 173)

WorldBuilder/   (SOURCES — promote logic to Shared, delete from here)
├── Editors/Landscape/HeightmapImportService.cs    (move whole file)
├── Editors/Landscape/ViewModels/LandscapeEditorViewModel.cs
│                                                  (FreshStart 625, GenerateWorld 668,
│                                                   ExportTownsCsv 857,
│                                                   BuildAceTeleLoc 923 — distill)
├── Editors/Spell/SpellEditorViewModel.cs          (CloneDbSpellRecord — promote)
├── Services/TextureImportService.cs               (split: bitmap helper stays,
│                                                   render-surface logic moves)
└── Lib/FileLogging.cs                             (move whole file to Shared/Lib/Logging)

WorldBuilder.Terminal/   (TARGETS — these grow)
├── CommandEngine.cs                               (existing 11 577 LOC — leave alone)
├── CommandEngine.Spell.cs                         (NEW partial)
├── CommandEngine.Weenie.cs                        (NEW partial)
├── CommandEngine.Creature.cs                      (NEW partial)
├── CommandEngine.Placements.cs                    (NEW partial)
├── CommandEngine.Layout.cs                        (NEW partial)
├── CommandEngine.WorldGen.cs                      (NEW partial — FreshStart + town CSV)
├── CommandEngine.Texture.cs                       (NEW partial — RenderSurface +
│                                                   heightmap import)
├── CommandResults.cs                              (extend with new result records)
├── JsonCommandProcessor.cs                        (extend BuildCommandHandlers 151–264)
├── TerminalRepl.cs                                (extend BuildCommandHandlers 83–199)
├── TransactionEngine.cs                           (extend allow-list)
└── CommandLineArgs.cs                             (--log-file flag)
```

---

## 9. References

- `UPSTREAM_SYNC_NOTES.md` — full porting log, status table, cluster overview.
- `docs/gui_terminal_gap_analysis_2026-03-25.md` — pre-sync gap analysis (now stale
  but the framing — "command-surface gaps rather than core-logic gaps" — still
  applies and is the right north star for this work).
- `README.md:1–7, 27–32, 107–139, 612–619` — design contract, headless agent
  protocol intro, architectural status table.
- `docs/agent_api_reference.md` — current 32-command JSON protocol catalog (1 808
  lines).
- `docs/terminal_repl_commands.md` — current REPL command catalog (171 lines).

---

## 10. One-paragraph TL;DR

`UPSTREAM_SYNC_NOTES.md` records a six-day push (2026-04-26 → 2026-04-30) that
brought a Spell editor with ACE-DB save, a Monster/Creature editor with override
CRUD, a Weenie editor with property-enum pickers and `InsertWeenieAsync`, an Outdoor
+ Dungeon Instance Placements stack with SQL helpers, a Layout editor overhaul, a
RenderSurface-replacement texture path, a `HeightmapImportService`, a real
`FreshStart` + `GenerateWorld` upgrade with town CSV export, file logging, and
DAT-export safety fixes. **None of that surfaces in `WorldBuilder.Terminal`.** The
README promises the headless interface mirrors the GUI; right now it doesn't. This
spec lays out 10 objectives, 11 deliverables (~2 900 LOC, mostly mechanical), and a
six-step validation process to close the gap using the same Slice-3 / Wave-F pattern
the project has already used twice this sprint: promote pure logic to
`WorldBuilder.Shared`, expose it on `CommandEngine`, bind it on JSON + REPL surfaces,
update docs and tests, allow-list new mutators in `transact`. No editor redesign, no
new protocol, no in-game testing required — only wiring up what was already merged.
