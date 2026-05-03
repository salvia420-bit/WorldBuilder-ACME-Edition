# Object Display Expansion — Agent Action Plan

## Context

`emit-static-site` produces a Leaflet pyramid where each landblock is rendered top-down. The renderer pulls textured triangle meshes through `Setup → GfxObj → Surface → SurfaceTexture → RenderSurface` and packs per-setup sprites into an atlas. Spawns are placed via the WeenieIndex → setup resolver.

A full audit of `external/DatReaderWriter/DatReaderWriter.Tests/DBObjs/` (52 DBObj types) against WorldBuilder's actual reads found that **only 15 of 52 types are consumed**. The seven gaps below explain every "object missing or wrong" symptom we currently see in the rendered tiles. Cross-references against `external/DatReaderWriter/DatReaderWriter/dats.xml` (canonical schema) and `external/GDL/PhatSDK/` (canonical C++ implementation) confirm the impact.

The Holtburg billboard-as-disc fix (portals rendering as cyan discs) is in place but a workaround — not a substitute for the items below.

Concurrent runtime issue: the most recent full sprite-gen regen died at 145 of 5,391 collected setupIds (`/tmp/sprite-full2.log` truncated mid-run, no `SurfaceDiag` report emitted). Fix this first — none of the work below can be measured until the regen completes end-to-end.

## Intent

Bring `emit-static-site` from "shows about half the spawned objects with the right texture" to "shows every spawned object with the right shape, the right texture, and the right variant." Within scope: top-down sprite fidelity, NPC variation, portal/effect visibility, EoR-content coverage. Out of scope: 3D rendering, animation playback, sound.

## Objectives

Execute in order — each unblocks the next or its measurement.

### 0. Stabilize the sprite atlas regeneration

**Preconditions:** none.

**Acceptance:** `generate-object-sprites` with `force:true` over the full RetailSmoke setup pool runs to completion, writes a manifest matching the rendered count, and emits the `[SurfaceDiag]` and `[Sprites] rendered=…` summary lines visible in `/tmp/sprite-billboard-test.log`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:11367-11395` (`GenerateObjectSprites`), `WorldBuilder.Terminal/CommandEngine.cs:11097-11148` (atlas loader).

**Verification:** `wc -l ~/projects/RetailSmoke/sprites/manifest.jsonl` matches `modelsRendered` in the JSON response. Tail of stderr/stdout contains `[SurfaceDiag] ok=…` and the failure breakdown.

### 1. Surface chain: handle `0x15` RenderTexture

**Preconditions:** Objective 0 done so we can measure `SurfaceDiag.badRenderSurfKinds[0x15]` before/after.

**Acceptance:** `TryLoadSurface` resolves `kind == 0x15` by reading `RenderTexture.SourceLevels[0]` and continuing the chain at `0x06 RenderSurface`. Schema reference: `dats.xml:3892-3899`. Test reference: `RenderTextureTests.cs:71-91` confirms `0x15000000.SourceLevels[0] = 0x06004B91`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:651-695` (add `else if (kind == 0x15)` branch).

**Verification:** Re-run sprite-gen. `SurfaceDiag.badRenderSurfKinds[0x15]` drops to 0; `SurfaceDiag.ok` rises by the same count.

### 2. Surface chain: handle `0x18` MaterialInstance → `0x16` RenderMaterial → `0x17` MaterialModifier

**Preconditions:** Objective 1 in place so the new branches share the same fall-through to RenderSurface.

**Acceptance:** `TryLoadSurface` resolves `kind == 0x18` via `MaterialInstance.MaterialId → RenderMaterial`, then samples the first texture-bearing material property. `kind == 0x16` direct also handled. `MaterialModifier (0x17)` is consulted only when present in `MaterialInstance.ModifierRefs` and only for properties that override the texture sampler. Schema: `dats.xml:3900-3917`. Tests: `MaterialInstanceTests.cs:55-66`, `MaterialModifierTests.cs` (output-only test — validate against retail bytes via `CanReadAndWriteIdentical`).

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:651-695` (extend the `else if` chain).

**Verification:** `SurfaceDiag.badRenderSurfKinds[0x18]`/`[0x16]` drop to 0. EoR clothing/armor that previously flat-filled now shows texture in regenerated sprites.

### 3. ClothingTable variants — sprite-gen iterates `(setupId, clothingBaseId, paletteTemplate)` tuples

**Preconditions:** Objectives 1+2 (so the textures the variant chain points at actually decode).

**Acceptance:** `GenerateObjectSprites` enumerates not just bare setupIds but `(setupId, clothingBaseId, paletteTemplate, shadeIdx)` keys discovered from the WeenieIndex (already loaded, 43,911 entries). For each, run `ClothingTable.ClothingBaseEffects[setupId]` to substitute parts/textures and apply `ClothingSubPalEffects` palette overrides before triangulation. Manifest schema bumps to include the variant tuple. Spawn placement consults the same key. Schema: `dats.xml:3825-3836`. Tests: `ClothingTableTests.cs:54-67`. Canonical: `external/GDL/PhatSDK/ClothingTable.cpp:41` (`BuildObjDesc`) and `:140` (`ApplyPartAndTextureChanges`); fall back to setup `0x02000001` when the wcid's setup isn't in the table (GDL line 49).

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (TriangulateModel + iteration), `WorldBuilder.Terminal/CommandEngine.cs:11367-11395`, `WorldBuilder.Terminal/RenderPreviewRenderer.cs` (sprite key lookup), `WorldBuilder.Shared/Lib/WeenieIndex.cs` (expose ClothingBase/PaletteTemplate per entry — currently only setup is exposed).

**Verification:** Render Holtburg 3×3. NPC variants visible: town guards in armor, vendors in robes, citizens in clothing — each tinted by their palette template instead of all sharing one base setup color.

### 4. PhysicsScript / PhysicsScriptTable — replace billboard-disc workaround with actual particle puff

**Preconditions:** none of the above; can run in parallel with 1–3.

**Acceptance:** When a Setup has `DefaultScriptTable` (verified at `dats.xml:3683`), the sprite-gen overlays a particle-puff disc colored by the dominant `CreateParticleHook` particle's color (or by `WeenieType` fallback if hook traversal fails). Sphere extents from the Setup determine the disc size. Schema: `dats.xml:4044-4054`, `dats.xml:3069`. Tests: `PhysicsScriptTableTests.cs:60-74`, `PhysicsScriptTests.cs:64`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (extend `RenderBillboardAsDisc` callsites + add a non-degenerate path that overlays the puff on the textured sprite).

**Verification:** Holtburg portals + spell-cast plinths render with their actual particle color (e.g. cyan-green swirl for portals) rather than the WeenieType-fallback fill currently shown.

### 5. PalSet — palette swap variants for NPCs

**Preconditions:** Objective 3 (consumes the same key tuple).

**Acceptance:** When `ClothingSubPalEffects[paletteTemplate].CloSubPalettes[].PalSet` resolves, walk `PalSet.Palettes[]` and pick the one indexed by the WeenieIndex's `PaletteTemplate` field. Schema: `PalSetTests.cs:51-58`, `dats.xml:3817-3824`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (palette-resolution helper used by `DecodePaletted8`/`DecodePaletted16`).

**Verification:** Same NPC setup rendered with two different palette templates produces two different-colored sprites in the manifest.

### 6. Setup.DefaultScript / DefaultMotionTable / DefaultAnimation wiring (cleanup)

**Preconditions:** Objective 4 (DefaultScript already wired); MotionTable/Animation are pose-picking concerns and lower priority.

**Acceptance:** Document in `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` which `Setup.DefaultX` fields are intentionally ignored and why (top-down rendering doesn't require pose). Setup five fields are listed at `dats.xml:3679-3686`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs` (header comment near `TriangulateModel`).

**Verification:** Comment review.

### 7. GfxObjDegradeInfo — use LOD chain for low-zoom tiles

**Preconditions:** Objective 0 stable; perf-only, can run last.

**Acceptance:** When emitting tiles at `z ≤ 9`, the sprite-gen consults `GfxObjDegradeInfo.Degrades[]` to pick a lower-LOD GfxObj for triangulation. Sprite key includes the LOD level. Schema: `dats.xml:3837-3841`. Test: `GfxObjDegradeInfoTests.cs:74-85` shows 4-tier chains in retail.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:497-513` (TriangulateModel: substitute LOD GfxObj when caller passes a tier).

**Verification:** Atlas size for low-zoom regen drops without visible quality loss at the target zoom.

### 8. Audit `RenderSurface` PixelFormat coverage

**Preconditions:** Objective 0 stable.

**Acceptance:** Read `SurfaceDiag.unsupportedFormats` after a full regen. Add decoders for any high-count formats (`PFID_DXT2`, `PFID_DXT4`, `PFID_A1R5G5B5`, `PFID_X1R5G5B5`, `PFID_A8R3G3B2` are the candidates per `dats.xml` enum). Existing decoders are at `ObjectSpriteGenerator.cs:702-718`.

**Files:** `WorldBuilder.Terminal/ObjectSpriteGenerator.cs:702-820` (format switch + new `DecodeXxx` helpers).

**Verification:** `SurfaceDiag.unsupportedFormats` empty after the next full regen.

## Why

Each objective ties to a concrete user-visible outcome:

- **Objective 0** — without a clean regen, no other objective can be measured. The atlas runtime is currently the bottleneck.
- **Objectives 1–2** — every EoR-era piece of clothing, armor, and weapon currently flat-fills with the WeenieType fallback color. Two `else if` branches recover this. This is the highest impact-per-line change in the plan.
- **Objective 3** — 4,520 spawn rows currently collapse to 919 unique sprites. Adding ClothingTable variant rendering gives ~5x more visual diversity and is what makes NPC populations recognizable as "town guard / vendor / citizen" instead of a sea of identical figures.
- **Objective 4** — the user explicitly asked for portals to be visible; the billboard-disc workaround answered "show something" but not "show the right thing." This objective shows the actual particle effect.
- **Objective 5** — even with ClothingTable, NPCs of the same race+sex render in one fixed palette. PalSet unlocks the per-character color variation visible in the live game.
- **Objective 6** — leaving five `DefaultX` fields silently ignored invites future agents to repeat the same investigation. Document, don't implement.
- **Objective 7** — performance-only; emit-static-site regenerations of large regions will get faster and smaller.
- **Objective 8** — closes the long tail of texture-decoder gaps. Low individual impact, but cumulative.

The four EoR-era types missing from the surface chain (`0x15`, `0x16`, `0x17`, `0x18`) and ClothingTable together account for the majority of "object renders as wrong-color blob" symptoms in the current Holtburg tiles. The remaining objectives close the long tail.
