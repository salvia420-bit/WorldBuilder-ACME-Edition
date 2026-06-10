# Melt → WorldBuilder.Terminal Integration Plan

**Date:** 2026-06-10
**Purpose:** Absorb the useful functionality of vendored `external/melt` (bdekaru's AC DAT-manipulation toolbox) into WorldBuilder.Terminal's JSON agent API, specifically to assist **holtburger-web 3D scene development** (sky/terrain/lighting fidelity, scenery debugging, test-world fabrication).
**Status:** PLAN — not yet implemented.

---

## 0. Ground rules (read first)

1. **Reimplement, never link or copy melt code.** `external/melt/VENDORED.md` marks the repo research-reference-only: `Source/ACE.*` dirs are AGPL-derived with stripped headers; the rest has **no license**. Every feature below is specified as a *native* WB.Terminal implementation on top of **DatReaderWriter / DatReaderWriter.Extensions** types, using melt only as a behavioral reference and `~/ac-headers/acclient.h` as the struct-truth oracle.
2. **Melt's DAT engine is redundant — do not port it.** Melt's headline component (custom btree DAT read/write, `Source/datFile/*`, full-rewrite architecture) duplicates what WB already has: `Project.ExportDats()` (WorldBuilder.Shared/Models/Project.cs:182–543) opens export DATs `DatAccessType.ReadWrite` and writes via `DatEasyWriter` (DatReaderWriter.Extensions/DatEasyWriter.cs:30–85) with iteration tracking. The retail on-disk format (DiskFileInfo_t / BTNode 62-ptr+61-entry, acclient.h:28231–28607) matches what DatReaderWriter implements. **Zero work item here.**
3. **Pre-ToD / Dark Majesty era support is out of scope** unless a multi-era research task appears. Melt's DM↔ToD migration tables, `darkMajestyToPNG`, retail→ToD landblock conversion, and Cache4/6/8/9 converters exist for historical-server reconstruction — not relevant to holtburger-web (which targets EoR ToD DATs only). Listed in §7 as explicitly deferred.
4. **New commands follow the existing mechanical pattern** (§6): partial class `CommandEngine.X.cs` + result records in `CommandResults.cs` + handler registration in `JsonCommandProcessor.BuildCommandHandlers()` (JsonCommandProcessor.cs:151–250). Update `docs/agent_api_reference.md`, `docs/agent_api_schema.json`, and `~/.claude/skills/worldbuilder-terminal/skill.md` per phase.

---

## 1. What melt actually contains (functional inventory)

| Melt module | Functionality | Verdict |
|---|---|---|
| `datFile/*` (cDatFile, btree, block cache) | Full DAT container read/**write**, full-rewrite block allocation, iteration stamping | **Skip** — WB's DatEasyWriter covers it (rule 2) |
| `datFileManipulation.cs` | Landblock/cell surgery: `replaceLandblock` (heightmap/textures/objects/cells independently togglable), cross-DAT building transplant (`addBuildingFrom`), recursive cell copy with **cell-ID remapping** (`replaceCellNewIdRecursive`, `copyBuildingCellsNewId`), bulk texture ops (`landblockBucketFill`, `replaceLandblockSpecificTexture`), road removal, settlement removal, missing-cell census | **Port concepts** — §4. Cell-ID remap partially exists in `remap-buildings-v2` (CommandEngine.Placements.cs:8489+) |
| `datFileUtilities.cs` | Texture/object **ID migration tables** between two DATs, `exportCellJson`, coords→cellId | Mostly DM-era; `exportCellJson`-style dump covered by existing parity commands. **Skip except** cross-DAT census ideas folded into §4 |
| `RegionConverter.cs` / `RegionComparer.cs` | Region 0x13 **full parse → text export → re-import → repack**, plus deep field-by-field region diff. Covers RegionMisc, TexMerge (corner/side/road alpha maps, TerrainTex with tiling + vertex bright/sat/hue ranges, detail tex), TerrainDesc, SceneDesc, SkyDesc (DayGroups → SkyObjects + SkyTimeOfDay), SoundDesc | **Port** — §2. Highest holtburger-web value |
| `SceneUtilities.cs` | Scene 0x12 object-list comparison across DATs/eras | **Port** — §3 |
| `GfxObjTools.cs` | GfxObj load/save-bin; **`FindUsedBy`**: reverse lookup surface → every GfxObj referencing it; surface translation by fingerprint (Type+OrigTextureId+ColorValue+Translucency+Luminosity+Diffuse) | **Port FindUsedBy generalized into an asset-reference graph** — §5. Save-bin via DatEasyWriter |
| `SetupModelTools.cs` | Setup load/save-bin, part-list comparison | Fold into §5 (asset graph already exposes part lists); write path low priority |
| `TextureConverter.cs` / `TextureHeader.cs` | Texture 0x06 bin↔PNG/BMP both directions incl. JPEG payloads; format codes (RGB24/RGBA32/A8/P8/JPEG) | **Mostly covered**: decode = TextureParity + RenderSurfaceExtensions (12+ formats, BCnEncoder DXT); inject = `import-render-surface` (CommandEngine.Texture.cs:18–45). **Gap**: batch export + alpha/palette injection — §5.4 |
| `PlayScriptTools.cs` | PhysicsScript 0x33 load/edit/save (insert anim hooks) | **Defer** — holtburger-web already parses 0x33 in Rust; mutation has no current consumer. §7 |
| `SpellManipulationTools.cs`, `LanguageFileTools.cs`, `charGen.cs`, `GoArrowUtilities.cs`, `aceDatabaseUtilities.cs`, `aceMutationScripts.cs` | Spell table edit, StringTable edit, CharGen edit, GoArrow XML atlas, ~60 ACE-DB vendor/loot mutation recipes | **Skip** — custom-content workflows, explicitly out of scope per VENDORED.md |
| `Diff.cs`, `Patcher.cs` | Folder/file binary diff; .dif hex patcher | **Skip** — trivial, shell tools suffice |

---

## 2. Phase R — Region 0x13 round-trip (`region-*` family) — **TOP PRIORITY**

**Why for holtburger-web:** the 3D scene's sky (DayGroups/SkyTimeOfDay drives sun/ambient/fog — see sun-angle-lerp and Sky-K work), terrain blending (TexMerge corner/side/road alpha maps), terrain vertex modulation (`?terrainMod=on` reads TerrainTex bright/sat/hue ranges), and ambient sound all derive from Region. Today WB.Terminal can only partially *read* it (CommandEngine.Skybox.cs); there is no canonical JSON view, no diff, no edit. A JSON round-trip gives holtburger-web a ground-truth fixture generator AND lets us fabricate experiment regions (e.g. exaggerated fog/light values for eye-test A/Bs).

**New commands** (`CommandEngine.Region.cs`):

| Command | Args | Behavior |
|---|---|---|
| `region-export-json` | `out?, parts?` | Parse 0x13000002 via `dats.TryGet<Region>` into a complete, stable-ordered JSON document. `parts` filters to `sky\|sound\|scene\|terrain\|misc`. Must cover **every** part the retail client reads (acclient.h:53237–53253 CRegionDesc): TerrainDesc+LandSurf+TexMerge (TerrainAlphaMap tcode/tex_gid, RoadAlphaMap rcode, TMTerrainDesc, TerrainTex full field set acclient.h:52974–52988), SkyDesc/DayGroup/SkyTimeOfDay/SkyObject (52835–53190), CSoundDesc, CSceneDesc/CSceneType, RegionMisc. |
| `region-import-json` | `path, apply?` | Validate JSON → rebuild Region DBObj → stage into project; lands in export DATs via the existing `ExportDats()` path. `apply:false` = dry-run validation report. |
| `region-diff` | `otherDat? \| otherJson?` | Melt RegionComparer equivalent: deep field-by-field diff of project region vs a second DAT (§4 handle) or an exported JSON; output structured `{path, ours, theirs}` rows. |

**Implementation notes:**
- First verify DatReaderWriter's `Region` DBObj parses *all* parts (encounter/water/fog/dist-fog/region-map pointers exist in CRegionDesc; confirm presence/absence in the EoR file and in the DRW model — gaps must be modeled before export claims completeness). Validate by byte-identical repack: `export → import → export` must produce identical bytes (parity test in WorldBuilder.Tests).
- Reuse the JSON shape holtburger-web's Rust `sky.rs` already consumes where practical, so fixtures are directly comparable.

**Acceptance:** round-trip byte parity on retail region; `region-diff` of retail-vs-retail = 0 rows; holtburger-web can diff its baked sky tables against `region-export-json` output in CI.

---

## 3. Phase S — Scene 0x12 inspection & diff (`scene-*` family)

**Why:** holtburger-web's scenery bake (Scenery Bake B.5, wave-3 re-bake debt) is built on Scene→ObjectDesc placement rules. Bugs like "missing/duplicated scenery" need a symbolic oracle: which scene, which ObjectDesc, what freq/displace/slope bounds. ObjectDesc field order is fixed by acclient.h:57271–57286 (obj_id, base_loc Frame, freq, displace_x/y, min/max_scale, max_rot, min/max_slope, align, orient, weenie_obj).

**New commands** (`CommandEngine.Scene.cs`):

| Command | Args | Behavior |
|---|---|---|
| `scene-export-json` | `sceneId \| all, out?` | Dump Scene 0x12 → ObjectDesc list, fully fielded. |
| `scene-diff` | `sceneId, otherDat` | Per-object diff vs second DAT (melt SceneUtilities.CompareObjects equivalent). |
| `scene-where-used` | `sceneId` | Reverse map: which Region SceneTypes / terrain types reference this scene (joins §2's SceneDesc). Answers "why does this tree appear on this terrain". |
| `scene-edit` | `sceneId, index, fields…, apply?` | Mutate one ObjectDesc (freq/scale/slope…) and stage for export — enables controlled scenery A/B test worlds. Lowest priority of the four. |

**Acceptance:** `scene-diff` retail-vs-retail = 0; holtburger-web scenery bake verifier can consume `scene-export-json` as fixture input.

---

## 4. Phase X — Cross-DAT surgery (`dat-open` + transplant ops)

**Why:** melt's killer workflow is "compose a world from pieces of other DATs." For holtburger-web this is the **test-world fabricator**: copy a problematic building/dungeon/landblock into a scratch world, strip distractions, and eye-test a single render/physics feature in isolation (e.g. the white-door/dark-building lighting issue, indoor EnvCell work).

**4.1 Secondary DAT handles (prerequisite).** WB currently has exactly one project DAT set (`DocumentManager.Dats`). Add:

| Command | Args | Behavior |
|---|---|---|
| `dat-open` | `path, alias` | Open an external DAT directory read-only (`new DefaultDatReaderWriter(path, DatAccessType.Read)`), register under `alias` in a `Dictionary<string, IDatReaderWriter>` on CommandEngine. |
| `dat-close` / `dat-list` | `alias` / — | Lifecycle + enumeration. |

All §2/§3 diff commands and §5 graph commands accept `dat:<alias>` to target a handle.

**4.2 Transplant ops** (`CommandEngine.Transplant.cs`) — generalize the cell-ID remap logic that already exists inside `remap-buildings-v2` (CommandEngine.Placements.cs:8489+) into a reusable service, then expose:

| Command | Args | Behavior |
|---|---|---|
| `copy-landblock` | `fromDat, srcLbX/Y, dstLbX/Y?, heightmap?, textures?, objects?, cells?` | Melt `replaceLandblock` semantics: independently togglable copy of terrain heights, terrain types, LandBlockInfo objects/buildings, and EnvCells. When relocating, remap all cell IDs. |
| `copy-building` | `fromDat, srcLbX/Y, buildingIndex, dstLbX/Y, x,y,z,qw…` | Melt `addBuildingFrom`: copy BuildInfo + transitively-reachable interior EnvCells (follow CBldPortal/CCellPortal graphs), allocate a free cell-ID block, remap. |
| `remove-building` | `lbX/Y, buildingIndex, removeCells?` | Melt `removeBuilding`: drop BuildInfo and cascade-delete its interior cells. |
| `bulk-paint-replace` | `lbList \| rect, fromType, toType` | Melt `replaceLandblockSpecificTexture` / `landblockBucketFill`: bulk terrain-type substitution across many LBs (existing `paint`/`fill` are single-brush). |

**Cross-reference fixup contract** (the part melt got right and any remap MUST honor — retail truth at acclient.h:31893–32308):
- `CLandBlockInfo.cell_ids[]` and `cell_ownership` hash
- `BuildInfo.portals[] → CBldPortal.other_cell_id` **and** `stab_list[]`
- `CEnvCell.portals[] → CCellPortal.other_cell_id`, `VisibleCells`, and `StaticObjects`
- Cycle-safe recursive traversal (portal graphs are cyclic — keep a copied-set, melt pattern)

**Validation:** after any transplant run `validate-landblock`/`validate-all` (DNG###/BLD### families already catch broken portal links and orphaned cells — this is the safety net melt never had). Route mutations through `transact` so a bad transplant rolls back.

**Acceptance:** copy Holtburg meeting hall (0xA9B4) to an empty scratch LB, `validate-all` clean, export, and holtburger-web loads/renders it at the new location.

---

## 5. Phase G — Asset-reference graph & reverse lookups (`find-used-by`)

**Why:** melt's `FindUsedBy` (GfxObjTools.cs:206–247) answers "which GfxObjs use surface X" — exactly the question holtburger-web debugging keeps hitting from the other direction (white objects → which Surface; Surface render-state pivot; lighting still-open). Generalize into a graph service:

| Command | Args | Behavior |
|---|---|---|
| `asset-refs` | `id` | Forward edges: Setup→GfxObjs→Surfaces→SurfaceTexture→Texture(+palette); Scene→ObjectDescs; EnvCell→surfaces/environment; PhysicsScript/MotionTable→PES links. |
| `asset-used-by` | `id, scope?` | Reverse index (built lazily, cached per project): surface→GfxObjs, GfxObj→Setups, Setup→Scenes/LandblockInfo placements/weenies (join weenie index), texture→surfaces. `scope` limits the scan (portal-only vs +cell). |
| `surface-fingerprint` | `id` / `match:{…}` | Melt FindTranslation generalized: fingerprint a Surface (Type, OrigTextureId, ColorValue, Translucency, Luminosity, Diffuse) and find all surfaces matching a fingerprint — locates "the same material under a different ID". |

**5.4 Texture odds-and-ends** (extend `CommandEngine.Texture.cs`): batch `export-textures --filter` (folder-to-PNG, melt `folderToPNG`); confirm `import-render-surface` handles A8/P8/JPEG payload classes, add if missing. DXT codec already present via BCnEncoder — no work.

**Acceptance:** `asset-used-by 0x08000xxx` returns the GfxObj/Setup set in <2s warm; used at least once to close a real holtburger-web lighting/texture bug.

---

## 6. Mechanics: how each command lands (per-phase checklist)

1. `CommandEngine.<Family>.cs` partial class; methods return records added to `CommandResults.cs`.
2. Register in `JsonCommandProcessor.BuildCommandHandlers()` (JsonCommandProcessor.cs:151–250) + `Cmd<Name>` handler (param extraction → engine call → `Serialize(...)`).
3. Help text + `docs/agent_api_reference.md` §family + `docs/agent_api_schema.json` entry.
4. Tests in `WorldBuilder.Tests`: retail-data round-trip/zero-diff cases (real DATs per house rules — no synthetic fixtures).
5. Update `~/.claude/skills/worldbuilder-terminal/skill.md` catalog (it claims exact command counts — keep current).
6. Mutating commands must participate in `transact` staging and the validate-before-export loop.

**Suggested order & sizing** (each phase independently shippable):

| Phase | Commands | Est. size | Depends on |
|---|---|---|---|
| R (Region) | 3 | M — mostly JSON shaping + DRW completeness audit | — |
| G (Asset graph) | 3–4 | M — read-only, no export-path risk | — |
| X.1 (dat-open) | 3 | S | — |
| S (Scene) | 4 | S–M | X.1 for diffs |
| X.2 (Transplant) | 4 | L — remap extraction + fixup contract | X.1 |

R and G first: read-only, immediately useful to holtburger-web, zero risk to the export path. X.2 last: biggest payoff (test-world fabricator) but touches the most invariants.

---

## 7. Explicitly deferred / rejected

- **Melt btree DAT engine** — redundant (rule 2).
- **Pre-ToD/Dark Majesty formats**: DM texture codecs, DM↔ToD ID migration tables, retail→ToD landblock conversion, Cache4/6/8/9 converters — no holtburger-web consumer; revisit only for historical-era research.
- **ACE-DB content mutation** (`aceDatabaseUtilities`, `aceMutationScripts`) — custom-content workflows, out of scope per VENDORED.md; WB already has its own ACE-DB ingest/export.
- **Spell/Language/CharGen/GoArrow editors** — same.
- **PhysicsScript 0x33 mutation** (PlayScriptTools) — holtburger-web reads 0x33 natively; revisit if a "test PES injection" need appears.
- **ObjectExtensions.Copy port** — standing decision: skip (no callers).
- **Diff.cs/Patcher.cs** — shell tools suffice.

## 8. Source cross-reference map (for implementers)

| Topic | Behavioral ref (melt) | Canonical types | Retail truth |
|---|---|---|---|
| Region parts/order | `misc/RegionConverter.cs`, `RegionComparer.cs` | DRW `Region` DBObj | acclient.h:52835–53253 |
| Scene ObjectDesc | `misc/SceneUtilities.cs` | DRW `Scene` | acclient.h:57271–57295 |
| Cell/building remap | `datFileManipulation.cs:1106–1471` | DRW `LandBlockInfo`/`EnvCell`; WB `remap-buildings-v2` | acclient.h:31893–32308 |
| Surface fingerprint / used-by | `misc/GfxObjTools.cs:137–247` | DRW `Surface`/`GfxObj`/`Setup` | acclient.h Surface structs |
| Texture formats | `misc/TextureConverter.cs` | `RenderSurfaceExtensions.cs:98–285` (chorizite DRW.Extensions) | acclient.h:2550–2605 PixelFormatID |
| DAT container (no-op) | `datFile/*` | `DatEasyWriter`, `Project.ExportDats()` | acclient.h:28231–28607 |
