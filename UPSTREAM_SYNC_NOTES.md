# Upstream Sync Notes

This file tracks the state of porting commits from `Vanquish-6/WorldBuilder-ACME-Edition`
(upstream) into `salvia420-bit/WorldBuilder-ACME-Edition` (this fork). It exists because
the two histories **share no common ancestor** — `git merge-base` returns nothing —
so a normal `git pull upstream master` is impossible. All sync is manual or
patch-by-patch.

Last full audit: **2026-04-26**.

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
| `b8a09dd` | 03-04 | Dungeon editor refactor, landscape shader fix, doc save bugs | 27 | +1 700/-1 100 | 🔒 DEFERRED | Begins the dungeon-editor refactor chain. |
| `da88e74` | 03-04 | more prefab stuff | 5 | +356/-39 | 🔒 DEFERRED | Dungeon prefab system. |
| `7b89961` | 03-04 | More prefab stuff, generator, favorites | many | large | 🔒 DEFERRED | Dungeon prefab + generator. |
| `67912c1` | 03-04 | add SQL connector to export, direct DB Z-shift | 13 | +705/-102 | ⏳ TODO | Touches our heavily-modified `AceDbConnector.cs`. Manually port the SQL-export logic. |
| `f45e230` | 03-05 | Dungeon generator v2: favorites, room furnishing | many | large | 🔒 DEFERRED | Dungeon refactor chain. |
| `5faec77` | 03-05 | heightmap import, export progress, static repositioning | 11 | +718/-22 | ⏳ TODO | **Prereq for `7293629` (mini map).** Adds `LandSurfaceManager.GetTerrainAverageColors`. |
| `c66b13f` | 03-05 | add history to dungeon editor | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `40e9567` | 03-05 | fix dungeon dock crash | 4 | +61/-4 | 🚫 BLOCKED | Needs `DungeonGraphPanelViewModel` + `HistoryPanel` from earlier dungeon refactors. |
| `675fb1d` | 03-05 | grid and recenter view for dungeon editor | 3 | +181/-6 | 🔒 DEFERRED | Dungeon UI feature. |
| `ff36b20` | 03-05 | dungeon generator: portal alignment, yaw, capping | 3 | +480/-88 | 🔒 DEFERRED | Dungeon refactor chain. |
| `8847c28` | 03-05 | change camera down to C | 3 | +7/-3 | ✅ PORTED | Cherry-picked. |
| `a858af7` | 03-06 | Fix LayoutDesc position and child nodes | 1 | +13/-8 | ✅ PORTED | Cherry-picked. |
| `e619002` | 03-07 | Maximize editor window | 1 | +1/-2 | ✅ PORTED | Cherry-picked. |
| `0aec0dc` | 03-09 | dungeon gen v3 | many | large | 🔒 DEFERRED | Dungeon refactor chain peak. |
| `d512ef2` | 03-10 | ACE DB instance placements: weenie picker, panels | many | medium | ⏳ TODO | New editor surface. |
| `75fb32e` | 03-10 | fix EnvCell log spam | 2 | +10/-17 | ✅ PORTED | Cherry-picked. |
| `b671cee` | 03-10 | more fixes | 6 | +113/-27 | 🔒 DEFERRED | Touches dungeon-refactor types we don't have. |
| `b9ffe3e` | 03-10 | make dungeon view fill | 8 | +25/-14 | ⏳ TODO | Mostly csproj changes. |
| `af985b2` | 03-10 | Changelog from commit messages; add `release.yml` | 3 | +58/-32 | 🔧 PERMISSIONS | OAuth token lacks `workflow` scope — modifies `.github/workflows/BuildEdge.yml`. Push from a session with `workflow` scope, or split changelog from yml. |
| `f29948e` | 03-11 | fix fill tool preview | 1 | +2/-2 | ✅ PORTED | Cherry-picked. |
| `9a0dbc3` | 03-11 | Dungeon editor improvements | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `7293629` | 03-11 | mini map for terrain editor | 5 | +539/-0 | 🚫 BLOCKED | Pure addition, but calls `LandSurfaceManager.GetTerrainAverageColors` which is added by `5faec77`. Port that first, then this. |
| `cd3e377` | 03-12 | dungeon 'world template' WIP | many | medium | 🔒 DEFERRED | Dungeon refactor chain. |
| `6a317bc` | 03-12 | world mini map fix, remove templates | 26 | +116/-604 | 🔒 DEFERRED | Mostly DELETIONS (template removal). Don't port without verifying we want those deletions. |
| `0998c38` | 03-13 | landscape refactor, dungeon scene + settings | 51 | +1 197/-358 | 🔒 DEFERRED | Big landscape refactor. |
| `f26345e` | 03-22 | weenie editor, layout overhaul, transform gizmo, world gen, mesh import/export, texture | 86 | +10 452/-661 | 🟡 PARTIAL | See "f26345e split into 4 slices" below. Slices 1-3 (headless) ✅ PORTED. Slice 4 (GUI) ✅ waves A-D, ⏳ waves E-G remain. |
| `fa7c58c` | 03-22 | Surface browser paging + dungeon scan fixes | 6 | +479/-75 | ⏳ TODO | Smaller; check feasibility. |
| `ee39f71` | 03-22 | fix dungeon export crash on corrupt setup | 1 | +9/-1 | 🚫 BLOCKED | Needs `SanitizeEnvCellSurfacesForExport` (hundreds of lines of upstream `DungeonDocument.cs` we don't have). |
| `4dc3983` | 03-23 | Weenie property enums + DID/int pickers | many | medium | ⏳ TODO | Cluster B (weenie/spell editor). |
| `44f47f8` | 03-23 | gizmo improvement | 7 | +679/-110 | ⏳ TODO | Worth attempting; check prereqs. |
| `5f963ee` | 03-24 | fix(landscape): skip redundant terrain apply, command doc IDs | 4 | +47/-26 | ✅ PORTED | Cherry-picked. |
| `39d68d7` | 03-31 | World gen: coastal water bands, building/road tweaks | 15 | +351/-120 | ⏳ TODO | Touches WorldGen + DocumentManager. Likely conflicts. |
| `33709a5` | 03-31 | Dungeon editor: per-static scale, surface alignment | 8 | +446/-24 | 🔒 DEFERRED | Dungeon refactor chain. |
| `239c0c1` | 04-09 | fix buildings + new monster builder | many | medium | ⏳ TODO | Cluster B. |
| `92fafff` | 04-09 | monster editor improvements | 9 | +465/-53 | ⏳ TODO | Cluster B. |
| `4ee4211` | 04-09 | fix xp auto scale | 2 | +113/-20 | ✅ PORTED | Cherry-picked. |
| `3457ea7` | 04-10 | feat(SpellEditor): add copy spell | 5 | +2 008/-471 | ⏳ TODO | Cluster B. |
| `d780244` | 04-11 | improve spell editor UX | many | medium | ⏳ TODO | Cluster B. |
| `55604d2` | 04-11 | fix spell editor rebase | 1 | +77/-127 | ⏳ TODO | Cluster B. |
| `34c612b` | 04-11 | Defer portal writes via PortalDatDocument; simplify world-gen buildings | 5 | +27/-104 | ⏳ TODO | Net negative refactor; relatively focused, attempt next. |
| `38b22c2` | 04-12 | texture fixes; documentation | many | small | ⏳ TODO | Look first. |
| `7d6ce84` | 04-12 | UI layout additions (some names from string) | 8 | +576/-37 | ⏳ TODO | Look first. |
| `15cb9ed` | 04-14 | add logging, fix texture import/dat export | 9 | +506/-4 | 🚫 BLOCKED | Needs `FileLoggerProvider` + related logging infrastructure. |

### Tally
- **7 ✅ PORTED** (in the side branch we just merged)
- **1 🟡 PARTIAL** (`f26345e` slices 1-3 + slice 4 waves A-D done; waves E-G remain)
- **5 🚫 BLOCKED** (attempted, prereq gap documented above)
- **14 🔒 DEFERRED** (large refactors or stacked dungeon-chain — port only with in-game testing)
- **1 🔧 PERMISSIONS** (just needs the right token to push)
- **14 ⏳ TODO** (not yet attempted, lower-risk than the deferred set)

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

### Slice 4 — GUI changes 🟡 in progress
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

**Waves E–G** ⏳ remaining (deferred — heavy local merge work):
- Wave E: ObjectBrowserItem/ViewModel particle-emitter integration,
  SelectorToolViewModel + SelectSubToolViewModel align-to-surface command
  + new placement flow, dungeon SelectTool gizmo wiring (+232),
  TextureImportService improvements (+148), ObjectRaycast (+84),
  StaticObjectManager rendering changes beyond the wave C overlay (+96),
  ProjectManager (+/-), corresponding axaml view bindings.
- Wave F: Layout editor view+vm overhaul (+416 + 260 + 188 + 85). The
  Layout editor was substantially rewritten upstream.
- Wave G: GameScene (+328) gains gizmo render/hit-test integration; and
  LandscapeEditorViewModel (+490 with heavy local mods) gains
  GenerateWorldCommand wiring, gizmo state, ShowParticles/ShowWeenieSpawns
  bindings, etc. This is the hardest merge — local has been heavily
  modified along with upstream.

The minimum viable slice 4 (waves A-D) leaves the GUI compiling cleanly
with the new editors visible from the menu, gizmo infrastructure ready,
and headless backend fully wired. Waves E-G add behaviour to existing
editor surfaces but the editors themselves are present and functional.

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
| B. Weenie / Spell / Monster editor | ~7 commits, new editor surfaces | Med-High | Manual; new editors may not exist locally. |
| C. Landscape / heightmap / mini-map | ~5 commits | Medium | `5faec77 → 7293629` is a tractable chain if heightmap import is wanted. |
| D. Texture / DAT export / logging | ~3 commits remaining | Medium | `34c612b` is the cleanest; `15cb9ed` needs logging infra prereq. |
| E. Chorizite / OpenGL backend | (Originally proposed cluster — debunked: those commits are actually multi-subsystem.) | — | Cluster doesn't really exist as I first defined it. |
| F. Misc fixes | Various | Medium | `fa7c58c`, `44f47f8`, `b9ffe3e` — each individually attempt. |

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
