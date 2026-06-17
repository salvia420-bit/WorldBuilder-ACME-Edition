# Empty-World Fix — Implementation SPEC (Wave-3 synthesis)

Repo: `/home/wbterminal/WorldBuilder-ACME-Edition`
Active dist: `/home/wbterminal/holtburger-dist`
Source backlog (Wave-2): `/home/wbterminal/out/empty-world-audit-opus-2026-06-17/findings.json`
Author model: Opus 4.8 (1M). Date: 2026-06-17.

This document folds every adversarial HARDEN `requiredCorrection` into the component specs.
Each spec is precise enough to apply with NO further research: exact `file:line`, diff/pseudo-code
sketches, exact ingest commands, data-contract schemas, and per-item verification with a
headless-harness wilderness-LB probe. The ordered apply sequence is in the sibling
`RUNBOOK.md`. The machine-readable index is `specs.json`.

ALL load-bearing facts below were re-verified this session against the live `ace_world`
MariaDB (127.0.0.1, user `ace`/`ace`), the decompiled GDL/ACE sources, and the repo code.

---

## FORKS — owner must confirm these up front

| # | Fork | Options | RECOMMENDATION | Why |
|---|------|---------|----------------|-----|
| F1 | **Where expansion runs** (governing decision) | A: expand at INGEST (C#, fatter byte-stable JSONL); B: expand at FETCH in `scene3d/spawns.js` | **A (INGEST)** | B is *impossible AND non-deterministic*: the renderer fetch path has no `encounter`/`weenie_properties_generator` tables, and its only Z source (`terrain_heights_shadow`, lib.rs) is populated ONLY by the live-wire recv-loop → empty in the offline path. ACE scatter uses `ThreadSafeRandom` (WorldObject_Generators.cs:120) → non-deterministic per fetch. A reuses already-correct C# at `CommandEngine.cs:6187-6347`. |
| F2 | **Encounter placement fidelity** | A: bare `cell*24` clamp (no jitter); B: + seeded in-cell jitter | **A** | GDL active path `WorldLandBlock.cpp:150-151` is `24.0f*cell`, NO +12. The jitter block (105-117) is COMMENTED-OUT dead code. The retail spread comes from the generator's own Scatter (R=GeneratorRadius), not encounter-cell jitter. |
| F3 | **Generator snapshot cardinality** | A: retail weighted-random "pick ONE" per laddered table + always-emit `prob==-1`; B: emit every profile's children | **A (MANDATORY — B is broken)** | Verified: wcid 1966 has **64 profiles, all `init_Create=1`, probability ladder 0.0159→1.0**. `SelectAProfile` (WorldObject_Generators.cs:120-170) rolls `ThreadSafeRandom.Next(0,GetTotalProbability())` ONCE and picks the first profile whose cumulative prob exceeds the roll, then BREAKS. B would emit ~64 creatures/cell × 33,632 wilderness LBs = millions of phantom fauna. |
| F4 | **Generator scatter RNG** | A: deterministic FNV-seeded snapshot; B: live `Random` per spawn | **A** | B breaks `source.sha256` reproducibility every bake and destroys posweep/oracle ground-truth parity. A pins a fixed seed (ingest-side C#, no JS/C# byte-parity needed). |
| F5 | **Merge encounters into spawn JSONL** | A: `append:true` into the single `ace_spawn_records.jsonl` (ordered: spawns truncate → encounters append); B: sibling `ace_encounter_records.jsonl` + teach stager to accept multiple `--source` | **A** with enforced ordering + an `IngestAceEncountersAsync` WARN when `append=true` and the target file is absent | Keeps the fix entirely in C#, no stager change, one `source.sha256` covers the whole snapshot. The ordering contract is enforced in the RUNBOOK (single `--stdin` session: spawns truncates, encounters appends). |
| F6 | **wcid_to_setup map scope** | A: FULL setup-bearing index (43,911 entries, ~1.2 MB); B: only staged wcids | **A when `--all-world`** | Future-proofs SPAWN-2 / GEN-1 child + encounter wcids (which `landblock_instance` never placed) without a re-stage. ~1.2 MB gzips to ~0.3 MB, cached per page. Keep B for legacy ring mode. |
| F7 | **Encounter expansion emit shape** | children-only; anchor+children | **anchor-as-creature + selected children** | GDL `WorldLandBlock.cpp:163` spawns the encounter wcid ITSELF at the cell, which then runs its own generator. Children-only discards the visible creature. (Net per cell with F3: the encounter creature + at most ~1 generated child, NOT 64.) |

---

## VERIFIED GROUND TRUTH (re-reproduced this session)

```
weenie_properties_d_i_d type=1 (Setup) tuples ......... 43,911   (NOT 43,910)
distinct weenie_Class_Id in landblock_instance ........ 19,154   (this is `serverManaged`, NOT 4,520 LBs)
landblock_instance rows ............................... 365,183  / 4,520 distinct LBs
encounter rows ........................................ 165,465  / 35,634 LBs / 212 wcids; MAX cell_X/Y = 8
generator where_Create distribution: 2(Scatter)=13,486  4(Specific)=5,552  8(Contain)=1,439
  1(OnTop)=620  72(ContainTreasure)=495  64(Treasure)=41  32(Shop)=16  68(SpecificTreasure)=5
wcid 1966 (top encounter, 11,360 rows): 64 profiles, all where_Create=2/Scatter, init_Create=1,
  probability ladder 0.015873 → 1.0   ⇒ retail spawns exactly ONE creature, not 64.
RegenLocationType is a [Flags] enum (uint): Undef=0 OnTop=1 Scatter=2 Specific=4 Contain=8
  Wield=0x10 Shop=0x20 Treasure=0x40; composites: ScatterTreasure=66 SpecificTreasure=68 ContainTreasure=72 ...
spawns.js summary fields: aggregate = scene3d.spawnsSummary.placeholderCount (SINGULAR, line 761);
  per-LB return object = placeholdersCount (PLURAL, line 776). Probe the SINGULAR aggregate.
GazetteerJsonOpts (CommandEngine.SiteIngest.cs:17): CamelCase + WhenWritingNull, NO IncludeFields.
  ⇒ SpawnRecord.Orientation (System.Numerics.Quaternion) serializes ONLY {isIdentity:bool}; angles_* are DROPPED.
IngestAceSpawnsAsync writes append:false (CommandEngine.SiteIngest.cs:269).
stage-ring-spawns.py:136 = .sort() only; there is NO dedup logic (new work).
TerrainDeep.wbproj persists Database="ace_shard" User="ace"  ⇒ WRONG DB for landblock_instance/weenie/encounter.
Live MariaDB databases: ace_auth, ace_shard, ace_world  ⇒ the WORLD DB is `ace_world` (creds ace/ace per Config.js).
Toolchain: /opt/dotnet/dotnet (DOTNET_ROOT=/opt/dotnet, DOTNET_ROLL_FORWARD=LatestMajor);
  WBT dll = WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll (dated Jun-14 — predates the
  new ingest code; MUST rebuild -c Release before running encounter/generator commands).
```

---

# GROUP A — INGEST (encounters / generators / landblock-instance / weenie)

## A0. CANONICAL ALGORITHM (decision doc; grounds everything below)

The offline static-snapshot algorithm, retail-faithful, three-layer.

**Layer A — encounter (table-driven).** The ACE `encounter` table is the server-side
pre-resolved equivalent of the client terrain-byte lookup. UNIQUE(landblock,cell_X,cell_Y)
⇒ exactly ONE wcid per occupied cell; there is **NO per-cell spawn-count RNG and NO position
jitter** on the encounter layer. For each row:

```
localX = Clamp(cell_X * 24.0f, 0.5f, 191.5f)   // EXACT; GDL WorldLandBlock.cpp:150-151 (active path), NO +12
localY = Clamp(cell_Y * 24.0f, 0.5f, 191.5f)
cell   = 1                                       // GDL:154 objcell_id = (lb<<16)|1 (outdoor cell 1)
Z      = terrain surface at (worldX,worldY)      // GDL:158 CalcSurfaceZ; ingest = _terrainService.GetHeightAtWorldPosition
```
MAX cell index in the data is 8 (11 real rows at cell 8 → `24*8=192` clamps to 191.5). This is REAL
data, not malformed: the clamp ceiling is load-bearing. GDL would `adjust_to_outside()` and re-cell those
11 rows into the neighbor LB; the ACE clamp keeps them in-LB — a deliberate ~11-row parity divergence,
acceptable for off-wire render. (GDL skip-wcids W_HUMAN=1/W_ADMIN=4/W_SENTINEL=3648 are NOT present in
this DB; the filter is harmless to omit.)

**Layer B — generator-child expansion (each encounter wcid AND ~4.9% of landblock_instance rows is a
generator).** Resolve the spawned creature so the rendered entity is the child, not the invisible
generator. Authoritative placement = GDL `CWeenieObject::CreateGeneratorSpawn` (WeenieObject.cpp:2678,
switch 2706-2761) cross-checked with ACE `WorldObject_Generators.cs` (`GetSpawnObjectsForProfile`:281-314,
`SelectAProfile`:108-170, `GetTotalProbability`:184-214, Treasure handling:138). **Do NOT cite a
`GeneratorProfile.cs` / `GeneratorProfile.Spawn` — no such file/type exists in `external/ACE`.**

Per generator anchor with owner wcid `W`:

```
profiles = weenie_properties_generator WHERE object_Id = W      // reuse CommandEngine.cs:6309-6347 SQL text
maxGen   = weenie_properties_int WHERE object_Id=W AND type=81  // MaxGeneratedObjects (PropertyInt 81); absent => sum(initCreate)

// --- F3 weighted-random "pick ONE", deterministically seeded ---
// (1) ALWAYS emit every profile with Probability == -1 (unconditional; SelectAProfile:157 `rng<prob || prob==-1`).
// (2) Among profiles with Probability != -1 do ONE deterministic weighted pick:
totalProb = GetTotalProbability(profiles)            // mirror WorldObject_Generators.cs:184-214 cumulative-diff ladder
roll      = (Fnv1a32(objCellId, W, 0) / 2^32) * totalProb
pick      = first profile p where running-cumulative GetAdjustedProbability(p) >= roll   // then STOP
// (3) cap grand total per owner at maxGen.

for each emitted profile p:
  if ((p.where_Create & 0x40 /*Treasure*/) != 0): emit GENERATOR MARKER ONLY, no deterministic child (loot)  // GDL outer overload 2802-2820; ACE :138 HasFlag(Treasure)
  else switch on FULL p.where_Create value (NO &0x0F mask):
     Contain(0x08) | Wield(0x10) | Shop(0x20):  DROP (inventory; GDL 2708-2718)
     Specific(0x04): if obj_Cell_Id null/0 && origin set → child = anchor + (origin_X,origin_Y,origin_Z)   // localtoglobal; GDL 2720-2727
                     elif obj_Cell_Id set → child at that cell + origin
                     else → child at anchor
     Scatter(0x02):  child = anchor + ScatterOffset(...)  (F4 deterministic; GDL 2729-2755), clamp x,y >= 0.5; Z = anchor Z
     OnTop(0x01) | Undef(0) | default: child at anchor pose                                                  // GDL 2758-2760
  nChildren = GetSpawnObjectsForProfile(p) = (p.InitCreate == -1 || p.MaxCreate == -1) ? 1 : p.InitCreate    // WorldObject_Generators.cs:288-295
  emit nChildren child SpawnRecords (Wcid = p.weenie_Class_Id; Category from CHILD wcid's WeenieType)
keep the generator anchor marker ONLY if W has a visible setupDid (else drop the invisible spawner; see WEENIE-1 — gate at STAGE time where wcid_to_setup exists)
```

**Layer C — deterministic scatter (F4 snapshot contract).** Self-contained ingest-side FNV1a32 over
`(objectId, profileSlot, childIndex, landblock, cell_X, cell_Y)`, FNV offset `0x811C9DC5`, prime
`0x01000193`. Determinism only requires a fixed seed (expansion is C#-only; no JS↔C# byte-parity needed —
do NOT "mirror spawns.js:271-282", whose inputs/output differ).

```
seed = Fnv1a32(objectId, profileSlot, childIndex, landblock, cell_X, cell_Y)
u1   = (seed >>> 8) / 0x1000000           // [0,1)
u2   = (Fnv1a32(seed) >>> 8) / 0x1000000  // [0,1)
R    = GeneratorRadius (weenie_properties_float type=43 on owner W; 0 when absent → coincident)
dx   = (u1*2 - 1) * R ;  dy = (u2*2 - 1) * R
```

---

## A1. ENC — encounter ingest (SPAWN-2)  [CORRECTED]

Folds: encounter-algorithm HARDEN (defects 1-5) + encounter-ingest HARDEN (defects 1-6).

### A1.1 `EncounterRecord` + bulk read
- NEW: `/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Shared/Lib/AceDb/EncounterRecord.cs`
  — `{ ushort Landblock; uint WeenieClassId; int CellX; int CellY; }`.
- EDIT: `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Roster.cs` (after `GetAllInstancesAsync`, closes line 76):
  add `GetAllEncountersAsync()`. SQL: `SELECT \`landblock\`,\`weenie_Class_Id\`,\`cell_X\`,\`cell_Y\` FROM \`encounter\``
  (whole-world; drop the range predicate from the canonical query at `CommandEngine.cs:6187-6192`). `CommandTimeout = 600`.
  Read `landblock` as **`(ushort)reader.GetInt32("landblock")`** (the column is signed `int(5)`; all values < 65,536 — verified MAX 0xFB80).

### A1.2 `BuildFromAceEncounters` (GDL placement, LB-LOCAL coords)
- EDIT: `WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs` (after `BuildFromAceLandblockInstances`, closes line 194).
- **LOAD-BEARING DIVERGENCE from `CommandEngine.cs:6204-6209`:** store **LB-LOCAL** `localX/localY` ONLY.
  That code adds the LB world origin into `worldX` because `RawFactObjectInfo.Position` is world-space.
  `SpawnRecord.X/Y` are LB-local (renderer re-adds `lbX*192`: lib.rs entities world-frame derivation). Adding
  the origin here double-offsets every encounter into the next LB.
- **surfaceZ delegate MUST be float-faithful** (encounter HARDEN defect 1): signature
  `Func<ushort,float,float,float>` and call `surfaceZ(lbId, localX, localY)` with the **un-truncated** floats
  (NOT `(int)localX`), so Z is byte-identical to the canonical `GetHeightAtWorldPosition` path.
- `Cell = 1`; `Category = "Creature"` on weenie-index miss (wilderness fauna, not "Object").
- `Orientation = Quaternion.Identity` (encounter table carries no angles). Emit the encounter wcid itself as
  a creature record (F7), then hand off to the shared generator expander (A2.3) — do NOT emit children-only.

### A1.3 `IngestAceEncountersAsync` + result record
- EDIT: `WorldBuilder.Terminal/CommandResults.cs` (after `IngestAceSpawnsResult`, line ~1484): add
  `IngestAceEncountersResult(bool Success, int LandblocksTouched, int RecordsWritten, int SyntheticRecords,
  int ZeroZRecords, string? OutputPath, string? Error=null)`.
- EDIT: `WorldBuilder.Terminal/CommandEngine.SiteIngest.cs` (after `IngestAceSpawnsAsync`, ends line 282):
  add `IngestAceEncountersAsync(string? outPath=null, bool append=false)`. Mirror `IngestAceSpawnsAsync`;
  build the terrain `SurfaceZ` closure from the existing `_terrainService.GetHeightAtWorldPosition` +
  `GetTerrainDoc().GetLandblockInternal` + `GetHeightTable()` (the same triple used at `CommandEngine.cs:6208-6209`).
- **FAIL-LOUD on synthetic terrain** (encounter HARDEN defect 2): `GetHeightAtWorldPosition` returns `0f`
  (NOT throws) when the LB terrain is absent, and `GetHeightTable()` silently substitutes a synthetic `i*2`
  ramp (CommandEngine.cs:10792-10808) when Region `0x13000000` is missing. After obtaining `heightTable`:
  `if (HeightTableIsSynthetic) return IngestAceEncountersResult(false,...,"Region 0x13000000 absent — refusing
  to stage encounters with synthetic terrain Z");`. Count `Z==0` records into `ZeroZRecords`; warn if > 0.
- Write via the same `GazetteerJsonOpts` stream. **F5:** open `StreamWriter(targetPath, append:append)`;
  if `append==true` and the file is absent, log a WARN (the spawns layer must land first).

### A1.4 Command wiring
- EDIT: `WorldBuilder.Terminal/JsonCommandProcessor.cs`: table line 226 add
  `["ace-db-ingest-encounters"] = CmdAceDbIngestEncounters,`; manifest after the line-2530 `ace-db-ingest-spawns`
  row add an `ace-db-ingest-encounters` entry (`args = "out? append?"`); handler after `CmdAceDbIngestSpawns`
  (line ~2947): read `node["out"]` + `node["append"]?.GetValue<bool>() ?? false`, call the engine, serialize
  `{success, command, landblocksTouched, recordsWritten, syntheticRecords, zeroZRecords, outputPath, error}`.
- EDIT: `WorldBuilder.Terminal/TerminalRepl.cs`: add the `ingest-encounters` REPL verb (dispatch ~:4339,
  help ~:4322, Available list ~:4343, handler after `HandleAceDbIngestSpawns` ~:4398).

### A1.5 SpawnRecord Generator value
- EDIT: `WorldBuilder.Shared/Lib/AceDb/SpawnRecord.cs:19-23` XML doc — add `"Encounter"` to the documented
  Generator value set (`"Static" | "Linkable" | "Respawn" | "Encounter" | "Unknown"`). Free-form string; the
  renderer ignores `Generator`; the stager drops it (it is ingest-side provenance + a dedup discriminator).

### Data contract (encounter child → SpawnRecord; existing shape)
```
{ wcid:<encounter wcid or CHILD wcid>, name, category:"Creature", generator:"Encounter",
  landblockId:<ushort lb>, cell:1,
  x:Clamp(cellX*24,0.5,191.5)[+scatter], y:Clamp(cellY*24,0.5,191.5)[+scatter], z:<terrain surface, float-faithful>,
  weenieType:<from child WeenieType>, isSynthetic:<index-miss>, isServerManaged:true,
  orientation:{isIdentity:true} }    // NOTE: NOT x/y/z/w — GazetteerJsonOpts has no IncludeFields
```

### Verification
- C#: `{cmd:"help"}` (the manifest emitter is `CmdHelp`, registered JsonCommandProcessor.cs:378 — there is
  NO `list-commands` command) lists `ace-db-ingest-encounters`.
- Result: `recordsWritten ≈ 165,465`, `landblocksTouched ≈ 35,634`, `zeroZRecords == 0`,
  `HeightTableIsSynthetic == false`.
- `grep -c '"generator":"Encounter"' /tmp/ace_spawn_records.jsonl ≈ 165,465`; a sample line has x/y ∈ [0.5,191.5]
  (LB-local, NOT 30000+) and a plausible non-zero Z cross-checked against `raw_world_facts.jsonl` for the same
  lb/cell (NOT merely `Z != 0`).
- Headless probe (see GROUP H): wilderness LB `0xA9B2` (=43442; 4 encounter rows wcid 5150 at cells
  (4,1)(4,5)(7,0)(7,2)) → after fix `spawnsSummary.injectedCount > 0`.

---

## A2. GEN — generator expansion (GEN-1)  [CORRECTED]

Folds: generator-expansion HARDEN (D1-D7) + encounter-algorithm HARDEN.

### A2.1 Bulk profile / radius / max reads
- EDIT: `WorldBuilder.Shared/Lib/AceDb/AceDbConnector.Roster.cs` (alongside `GetAllInstancesAsync`):
  - `GetAllGeneratorProfilesAsync()` → `Dictionary<uint,List<PlacementGenerator>>` keyed by `object_Id`.
    SQL = exact text at `CommandEngine.cs:6309-6315` (all 19 columns). Map into the existing
    `WorldBuilder.Shared/Models/PlacementGenerator.cs` (every column has a field; `palette_Id` → `PaletteTemplate`).
  - `GetGeneratorRadiiAsync()` → `Dictionary<uint,float>`: `SELECT object_Id,value FROM weenie_properties_float WHERE type=43`.
  - `GetGeneratorMaxObjectsAsync()` → `Dictionary<uint,int>`: `SELECT object_Id,value FROM weenie_properties_int WHERE type=81`
    (MaxGeneratedObjects — the per-owner grand-total cap for F3c).
  - `CommandTimeout = 600` on each.

### A2.2 Extend `BuildFromAceLandblockInstances` (keep statics 1:1)
- EDIT: `WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs:129-194`. New optional params (null defaults
  preserve current 1:1 behaviour, DROP-2 invariant — the 95.1% direct rows stay byte-identical):
  ```
  IReadOnlyDictionary<uint,List<PlacementGenerator>>? generatorProfiles = null,
  IReadOnlyDictionary<uint,float>? generatorRadii = null,
  IReadOnlyDictionary<uint,int>? generatorMaxObjects = null,
  IReadOnlyDictionary<int,int>? childWeenieTypes = null      // NON-nullable int (D3); built from _weenieIndex.Entries
  ```
- Keep the existing per-row anchor emission (lines 178-191) EXCEPT compute its `Generator` tag: `"Respawn"` when
  the wcid owns profiles, else keep `"Static"`. Do NOT drop the anchor (99.6% carry own coords).
- When `generatorProfiles.TryGetValue((uint)wcid, out var profiles)`, call the shared expander (A2.3) tagging
  children `"Respawn"`. Touches only the ~4.9% generator-owner rows.

### A2.3 Shared expander (used by statics AND encounters)
- ADD: `public static IEnumerable<SpawnRecord> ExpandGeneratorChildren(int ownerWcid, ushort lbId, int cell,
  float anchorX, float anchorY, float anchorZ, generatorProfiles, generatorRadii, generatorMaxObjects,
  weenieIndex, childWeenieTypes, string tag)`.
- Implement A0 Layer B + C verbatim with the corrected classifier:
  - **D2 FIX:** test `(p.WhereCreate & 0x40) != 0` FIRST → Treasure/loot → marker only, no child. Then switch
    on the **FULL** `p.WhereCreate` (NO `& 0x0F`): `0x08|0x10|0x20 → continue` (inventory); `0x04 → Specific`;
    `0x02 → Scatter`; `0x01|0x00|default → anchor pose`.
  - **D1/F3 FIX:** weighted-random single pick (A0 Layer B) — NOT per-profile-all.
  - **D5 FIX:** `nChildren = (InitCreate==-1 || MaxCreate==-1) ? 1 : InitCreate`.
  - **D3 FIX:** child Category = `childWeenieTypes.TryGetValue(childWcid, out var ct) ? ResolveCategory(null, ct) : "Object"`
    — never the `[]` indexer.
  - Skip child wcids in {1,4,3648} (W_HUMAN/W_ADMIN/W_SENTINEL).
- **D6:** narrative leads with Scatter (64% of profiles) as the dominant case; Specific is secondary.

### A2.4 Wire through `IngestAceSpawnsAsync` (reject EnrichmentSql reuse)
- EDIT: `WorldBuilder.Terminal/CommandEngine.SiteIngest.cs:250-263`: after `GetAllInstancesAsync` +
  `EnsureWeenieIndexLoadedAsync`, load `generatorProfiles`/`generatorRadii`/`generatorMaxObjects` (A2.1) and
  `childWeenieTypes = _weenieIndex.Entries.ToDictionary(e=>e.Wcid, e=>e.WeenieType)` (Dictionary<int,int>), then
  pass all into `BuildFromAceLandblockInstances`.
- **D7:** extend `IngestAceSpawnsResult` (CommandResults.cs:1478) with an `int GeneratorChildren` field; update
  both construction sites (CommandEngine.SiteIngest.cs:276,278).
- **FORK rejected:** do NOT reuse the EnrichmentSql round-trip (`EnrichmentSqlExporter.cs`) — it is the OPPOSITE
  direction (placements → per-class SQL, collapsing identical enrichments) and needs a corpus we don't have.
  Reuse only the SQL TEXT of `allGeneratorSql`.

### A2.5 Setup-DID drop gate at STAGE time (D9/gap)
- The "keep generator marker only if W has a visible setupDid" gate has NO data source in the builder
  (`AceWeenieDescriptor` carries Wcid/DisplayName/WeenieType only). Resolve it at STAGE time where
  `wcid_to_setup.json` (WEENIE-1) exists — see A4 / the dedup pass in B0.

### Verification
- A 64-profile laddered owner (wcid 1966) emits **1** child, NOT 64. An all-`prob==-1` owner emits all profiles.
- A `Contain(0x08)` profile → 0 children; a `Treasure(0x40)` / `72` / `68` profile → marker only, no fauna.
- A non-generator row → exactly 1 record (1:1 invariant). Holtburg 0xA9B4 stays 106 records.
- Re-ingest twice → byte-identical (FNV seed).
- Headless: at a wilderness LB `injectedCount` goes from 0 to a SMALL number (order ~1-3/cell), NOT tens.

---

## A3. SPAWN-1 — landblock_instance ingest (operational, no happy-path code)  [CORRECTED]

Folds: landblock-instance-ingest HARDEN (defects 1-6). The happy path needs NO code change and NO recompile
*for landblock_instance only* — but the box must rebuild `-c Release` anyway because A1/A2 add new commands.

### A3.1 Connect to the correct WORLD DB (BLOCKER — defect 1)
- The only persisted setting (`TerrainDeep.wbproj`) is `ace_shard`/`ace`/`ace` — the **WRONG DB**. The world
  tables live in **`ace_world`** (verified `SHOW DATABASES`; creds `ace`/`ace` per Config.js).
- **ALWAYS pass `ace-db-connect` explicitly as the first stdin line** with the verified world DB; assert
  `success:true`. **DELETE** the "drop the password and rely on persisted settings" recommendation — persisted
  `ace_shard` would pass `RequireAceDbConnector`'s Host-only guard (Creature.cs:17) and silently connect to the
  wrong DB.
- **Post-connect sanity gate (defect 2):** if `ace-db-ingest-spawns` returns `recordsWritten == 0` with
  `success:true`, the loop connected to a shard/empty DB → HARD-FAIL, do not stage.

### A3.2 Produce the two artifacts (exact `--out` to /tmp — FORK A)
Project-load + ace-db-connect are prerequisites (both commands call `RequireProject` + `RequireAceDbConnector`).
Use `TerrainDeep.wbproj` as the host project (carries connection settings + terrain doc; spawn ingest does not
mutate terrain). Write to **/tmp** (not the project dir) so auto-loaders don't re-read 365k-row artifacts and
`source.sha256` records an ephemeral path. See RUNBOOK for the exact heredoc.

### A3.3 Data-contract corrections
- **Orientation (defect 3):** `ace_spawn_records.jsonl` `orientation` is `{"isIdentity":bool}` — NOT
  `{x,y,z,w}`. `System.Numerics.Quaternion` serializes only its `IsIdentity` property under `GazetteerJsonOpts`
  (no `IncludeFields`). The `angles_*` read in Roster.cs:67-72 are DROPPED at serialization; all staged spawns
  render at identity rotation (pre-existing limitation, non-blocking — the parser defaults qw=1).
- **Paths (defect 4):** all `file:line` references are absolute under `/home/wbterminal/WorldBuilder-ACME-Edition/`;
  SpawnRecord lives at `WorldBuilder.Shared/Lib/AceDb/SpawnRecord.cs`, the builder at
  `WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs`.
- **Verification thresholds (defect 5):** treat `≈ 365,183` rows / `≈ 4,520` LBs as APPROXIMATE; the source of
  truth is the `recordsWritten`/`landblocksTouched` the command reports. Cross-check `source.sha256`
  `total-records`/`populated-lbs` against those reported counts, not against the SQL-dump constants.

### Verification
- `ls -l .../WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll` (rebuilt this run).
- `grep -c '' /tmp/ace_spawn_records.jsonl ≈ 365,183`; distinct `landblockId ≈ 4,520`; Holtburg `0xA9B4` has 106.
- A sample line has the camelCase keys `wcid landblockId cell x y z isServerManaged` (what
  `stage-ring-spawns.py:100-112` and the wasm `EntitySpawnJsonRaw` parser consume — NO field drift).

---

## A4. WEENIE — wcid→setupDid map (WEENIE-1)  [CORRECTED]

Folds: weenie-index HARDEN (defects 1-6). The producer ALREADY EXISTS (`ace-db-ingest-weenie-index`); the gap
is operational + the stager's silent fail-soft.

### A4.1 Produce `weenie_index.jsonl`
- Run `ace-db-ingest-weenie-index --out /tmp/weenie_index.jsonl` (project + ace-db-connect prereqs).
- **Acceptance numbers (defects 1-2):** `withSetupDid == 43,911` (verified `weenie_properties_d_i_d type=1`),
  NOT 43,910; `serverManaged ≈ 19,154` (= distinct `weenie_Class_Id` in landblock_instance — a PER-WCID count,
  NOT the 4,520 LB count). Pin `== 43911` only against this DB (v0.9.292); otherwise assert `>= 43900`.
- Data contract: JSONL, camelCase, null-omitted, wcid-ordered; load-bearing field `setupDid` (uint). wcid 1125
  → `setupDid 33554867` (0x020001B3).

### A4.2 Env var + loud WARN in the stager (defect 3 causal fix)
- EDIT: `external/holtburger/scripts/world-completeness/stage-ring-spawns.py`:
  - line 58: `DEFAULT_WEENIE_INDEX = os.environ.get('ACE_WEENIE_INDEX') or '<laptop default>'` (mirror the
    HOLTBURGER_DIST env pattern at :52-56; keep symmetric with PIPE-4's `ACE_SPAWN_SOURCE`).
  - `write_wcid_to_setup`: today a MISSING index returns early at :227 (writes no file); the deployed 3-byte
    `{}` actually comes from the **index-present-but-empty-`out_map`** path at :252-254. So guard the write so it
    is skipped on BOTH `missing_input` AND empty `out_map` (`if not out_map: return`) — neither path ships a
    misleading `{}`. On missing index print a loud WARN naming `ACE_WEENIE_INDEX` and the placeholder
    `0x0200016F` consequence; add `--require-weenie-index` to hard-fail.

### A4.3 FORK F1/F6 — keep the renderer-side sidecar; build over the FULL index when `--all-world`
- Keep `wcid_to_setup.json` as a shared sidecar (do NOT bake setupDid into `EntitySpawnJsonRaw` — that would
  repeat it per record and couple per-LB `.sha256` to the mutable weenie→setup map, breaking determinism; the
  live wire also resolves setup at consume via `csetup_id` at lib.rs:35515).
- Add `--full-wcid-map` (default ON with `--all-world`): emit EVERY weenie_index entry with a non-null setupDid
  (43,911) — covers encounter/generator-child wcids landblock_instance never placed. Use compact `json.dumps`
  (no indent) for the full map.

### A4.4 Provenance schema in `source.sha256`
- EXTEND `stage-ring-spawns.py:339-351` (it already emits `wcid-to-setup-entries`/`-missing`): add
  `wcid-to-setup-scope` (`full-index`|`staged-wcids`), `weenie-index-sha256` (or `MISSING`), `weenie-index-name`.
  Consumers (serve.py DIST-1, validate_landblock_completeness.cjs PIPE-3, the browser banner) read these keys to
  assert WEENIE-1 actually landed (not the `{}` stub). Consumers must parse BY KEY, tolerant of new lines.

### Verification
- `wc -c $HOLTBURGER_DIST/spawns/wcid_to_setup.json` >> 3; entry count `== 43911` (full) or `==` unique staged
  setup-bearing wcids; `source.sha256` shows `wcid-to-setup-entries 43911`, `wcid-to-setup-scope full-index`, a
  64-hex `weenie-index-sha256`.
- Headless (defect 4/5): the existing `capture_phase_d_spawns.cjs` placeholder split at lines ~615-621 is a
  DIAG-only `console.log` and does NOT gate (exit stays 0 even at 100% placeholders). **Add a real
  `check("placeholderCount == 0 after WEENIE-1", summary.placeholderCount === 0, ...)`** — a one-line harness
  edit (flag it as required code change). Probe the SINGULAR aggregate `spawnsSummary.placeholderCount`. The
  harness `PAGE_URL` is `index.html?renderer=3d&quality=high` and drives injection via a direct
  `loadSpawnsForLandblock` call — there is NO `?spawns=force` gate; drop that guidance.

---

# GROUP B — DETERMINISM FORK (F1) + STAGE DEDUP

## B0. F1 decision record + the determinism contract  [governing]

**Expansion runs at INGEST (C#).** B (renderer-side) is impossible (no encounter/generator tables in the wasm
bundle; offline `terrain_heights_shadow` is empty) and non-deterministic (`ThreadSafeRandom`). The renderer
stays a dumb flat-JSONL replayer; `scene3d/spawns.js`, `EntitySpawnJsonRaw`, `fetch_one_lb`, and the stager
need NO schema change for the dominant path — fatter JSONL flows through byte-stable.

**Determinism contract (the invariant the loop holds):** the bytes of every
`dist/spawns/0xXXXX.spawns.jsonl` are a pure function of `(ace_world snapshot, weenie_index snapshot, terrain
DAT, pinned generator seed)`. No wall-clock, no per-run RNG, no insertion-order dependence. `stage-ring-spawns.py:136`
sorts by `(cell,x,y,z,wcid)` and `json.dumps(sort_keys=True)`; expansion adds MORE records with concrete
positions, still totally ordered by that key.

## B1. STAGE-DEDUP — new dedup before the sort (encounter HARDEN defect 6; GEN double-count)

- EDIT: `external/holtburger/scripts/world-completeness/stage-ring-spawns.py` — there is currently NO dedup
  (only `.sort()` at :136). Add a dedup on `(cell, round(x,3), round(y,3), wcid)` per LB BEFORE the sort, so the
  2,002 LBs that carry BOTH encounters and landblock_instance generators don't render duplicate creatures. The
  distinct `Generator` tags (`Static`/`Respawn`/`Encounter`) make the chosen survivor auditable (prefer the
  non-`Encounter` tag on a tie so named statics win over wilderness fauna).
- This is the home of the A2.5 setup-DID drop gate: drop a generator marker whose wcid is absent from
  `wcid_to_setup.json` (invisible spawner), so it doesn't add placeholder noise across the wilderness.

---

# GROUP C — PROVENANCE (source.sha256 / bake-source.sha256)

## C1. `source.sha256` canonical schema (open-question #6)
TSV `key\tvalue`, emitted at `stage-ring-spawns.py:339-351`:
```
<source filename>\t<sha256>
bake-tool-version\tstage-ring-spawns.py/0.2.0
scope\tworld | ring
lb-count\t<N>
populated-lbs\t<N>
empty-lbs\t<N>
total-records\t<N>
unique-wcids\t<N>
wcid-to-setup-entries\t<N>          # WEENIE-1
wcid-to-setup-missing\t<N>          # WEENIE-1
wcid-to-setup-scope\tfull-index|staged-wcids   # A4.4
weenie-index-sha256\t<64hex>|MISSING            # A4.4
weenie-index-name\t<filename>                    # A4.4
# ring mode only: ring-x-range / ring-y-range (absent in world mode)
```
Load-bearing keys = `scope`, `populated-lbs`, `total-records`, `wcid-to-setup-entries`, `weenie-index-sha256`.
This is the single source of truth DIST-1 (serve.py) and PIPE-3 (validate_landblock_completeness.cjs) read.

## C2. SCEN-1 — parallel scenery-bake manifest race
- EDIT: `external/holtburger/apps/holtburger-tools/src/bin/scenery-bake.rs` (Cli ~:74-132, write ~:1143-1155):
  add `--manifest-out <PATH>` (default `<out>/bake-source.sha256`) so parallel shards write per-shard manifests
  the orchestrator merges post-run; OR `--no-manifest` + a single post-run emit. Today parallel shards sharing
  `--out` race to overwrite the single hardcoded `bake-source.sha256`, leaving the last shard's local count
  (~3,349 not the world total 40,197).
- Verify: after a parallel bake, `grep landblocks $HOLTBURGER_DIST/scenery/bake-source.sha256` reads
  `40197 baked, 0 skipped`.

---

# GROUP D — FAIL-SOFT (serve.py / validators)

## D1. DIST-1 — content-blind false-green
- EDIT: `external/holtburger/scripts/serve.py` `build_health` (~:81-93,135-141): replace `dir_nonempty`/
  `count_files` for spawns with a content-aware check:
  `jsonl = sum(1 for e in os.scandir(d) if e.name.endswith('.spawns.jsonl'))`;
  `present = jsonl > 0 and (d/'source.sha256').is_file()`; parse `scope`/`populated-lbs` from `source.sha256`
  into `_health.json`. `README.md` + `wcid_to_setup.json` must NOT make spawns report `present:true,files:2`.
- EDIT: `index.html:2079-2085`: change the spawns banner check from `files === 0` to `files < 100`.
- Verify: `python3 serve.py --check` FAILS before staging, PASSES after a world stage; `_health.json` shows
  `populated-lbs`.

## D2. PIPE-3 — validator hard-exit before terrain/scenery
- EDIT: `external/holtburger/scripts/world-completeness/validate_landblock_completeness.cjs`: add `--skip-spawns`
  in parseArgs (~:84-105). The spawns guard at :172-177 (exit 176) becomes: `if (!spawnsPresent &&
  args.skipSpawns) console.warn('WARN: spawns not staged — entity validation skipped'); else if (!spawnsPresent)
  process.exit(2);`. Thread `args.skipSpawns` into the entity diff. KEEP the scenery guard at :178-183 hard.
  Document `HOLTBURGER_DIST=/home/wbterminal/holtburger-dist` (DIST_V2 at :162 defaults to the unmounted
  `/mnt/wbterminal2`).
- Verify: `HOLTBURGER_DIST=... node validate_landblock_completeness.cjs --skip-spawns` reaches `[stage 1]`
  instead of `FAIL: spawns dir missing`.

## D3. lib.rs fetch fail-soft (informational — DO NOT change for SPAWN-1)
- `fetch_one_lb` (lib.rs:2666) returns `Ok(empty)` on 404 (`:2682-2684`) and empty-body (`:2692-2694`); errors
  only on malformed JSON. An encounter-only wilderness LB legitimately 404s to zero spawns AFTER SPAWN-1 — that
  is EXPECTED (SPAWN-2's gap), not a SPAWN-1 failure. Probe a town LB to prove SPAWN-1; a wilderness LB to
  demonstrate the residual until SPAWN-2 lands.

---

# GROUP E — DE-HARDCODE (PIPE-1 / PIPE-2 / PIPE-4)

## E1. PIPE-4 — stager env vars + ring default
- EDIT: `stage-ring-spawns.py:48,58`: `DEFAULT_SOURCE = os.environ.get('ACE_SPAWN_SOURCE') or '<laptop default>'`;
  `DEFAULT_WEENIE_INDEX = os.environ.get('ACE_WEENIE_INDEX') or '<laptop default>'`. Keep ring as the
  determinism contract; document `--all-world` as the prod invocation. (A4.2 already softens the silent
  weenie-index no-op.)
- Verify: `--help` shows env-aware defaults; `ACE_SPAWN_SOURCE=/tmp/s.jsonl ACE_WEENIE_INDEX=/tmp/w.jsonl
  python3 stage-ring-spawns.py --all-world --out /tmp/t` exits 0 with `>> 169` files.

## E2. PIPE-2 — gen-oracles.mjs laptop paths
- EDIT: `gen-oracles.mjs:15-17,59,62-64`: `DOTNET = process.env.DOTNET ?? (process.env.DOTNET_ROOT ?
  path.join(DOTNET_ROOT,'dotnet') : null) ?? (existsSync('/opt/dotnet/dotnet') ? '/opt/dotnet/dotnet' :
  'dotnet')`; `WBT = process.env.WBT_DLL ?? path.join(HERE,'../../../../WorldBuilder.Terminal/bin/Release/
  net8.0/WorldBuilder.Terminal.dll')`; `PROJ = process.env.RETAILSMOKE_PROJ ?? <laptop default>`. Add an
  `existsSync` guard + `process.exit(2)` before the spawn; `stdio ['pipe','pipe','inherit']` + log on non-zero;
  assert `written > 0`.
- Verify: `RETAILSMOKE_PROJ=<real.wbproj> node gen-oracles.mjs --lbs=0xA9B4 --out=/tmp/oracle-test` produces
  `/tmp/oracle-test/0xA9B4.json`, exit 0; with PROJ absent exits 2.

## E3. PIPE-1 — reconstruct + commit worldsweep-driver.sh
- CREATE `external/holtburger/scripts/multi-agent/worldsweep-driver.sh` from `FULL-WORLD-BAKE-VERIFY-HANDOFF.md:38-72`
  with env defaults: `ACE_DIR`, `DOTNET=${DOTNET:-${DOTNET_ROOT:+$DOTNET_ROOT/dotnet}}` → `command -v dotnet`,
  `SWEEPDIR=${SWEEPDIR:-/tmp/worldsweep}`, `HOLTBURGER_DIST=${HOLTBURGER_DIST:-/home/wbterminal/holtburger-dist}`,
  `AGENTS=${AGENTS:-4}`, `CHUNK_SECS=${CHUNK_SECS:-1800}`. Guard each path with `[ -e ] || exit 2`; add
  `--dry-run`; reference `verify-sweep.mjs` repo-relative. Commit it. (ACE is net10.0, WBT is net8.0 —
  cross-runtime; use `DOTNET_ROLL_FORWARD=LatestMajor`.)
- Verify: `git log --oneline -- .../worldsweep-driver.sh` shows a commit; `bash worldsweep-driver.sh --dry-run`
  exits 0 printing resolved paths.

---

# GROUP F — SCENERY MANIFEST
Covered by **C2 (SCEN-1)** above (provenance + manifest race are the same edit surface).

---

# GROUP G — RUNTIME STREAMING (post-population polish; lower priority)

## G1. RUNTIME-1 — initial ring centred on Holtburg, not spawn LB
- EDIT: `scene3d/index.js:1196-1201,1180-1182` (+ buildings/statics ring bakers :1332,:1357): defer
  `bakeTerrainRing` until the first non-zero spawn `lbId` via `handlePositionUpdate`; set `playerLbKey` to the
  spawn LB first, then bake around it; fall back to Holtburg if no position. (Transient ~1s blank-under-feet.)

## G2. RUNTIME-2 — LRU re-bake thrash on long roams
- EDIT: `scene3d/index.js:3534-3545` / `landblock_lru.js:389`: raise the `lbCap` floor for roaming OR cache the
  parsed CellLandblock heightmap in a structure NOT cleared by `terrainBakedLbs.delete`. Document `?lbCap=500`.

## G3. RUNTIME-3 — 2D deferredSpawns oldest-first eviction
- EDIT: `index.html:6942-6950`: replace with the O(n) spawn-preserving 3-pass compaction at `:4775-4820`.
  (Latent: only legacy `?renderer=2d&quality=ultra` with 512+ entities before liveScene resolves.)

## G4. PREFETCH-1 — terrain catalog-miss aborts whole ring
- EDIT: `holtburger-resource-http/src/manifest_source.rs:500-516,647-650` + `lib.rs:1000-1006`: `log::debug!`
  on eor/cell catalog-miss; push a flat 0-height sentinel mesh per-id miss instead of aborting the batch.
  (Diagnostics only; manifests only with a corrupt/partial bake.)

## G5. TERR-1 — boot-profile HBA silent terrain drop guard
- EDIT: `holtburger-tools/src/bin/dat-shard.rs`: post-ingest guard counting eor/cell records with
  `(file_id & 0xFFFF)==0xFFFF`; if `< 60000` print a warning to add `--eor-cell <client_cell_1.dat>`.

## G6. INT-1 — interior ground-truth artifact (verify-side only, no client change)
- Use `/home/wbterminal/out/lb_numcells.json` (5,346 / 3,405 non-zero) as interior ground truth for posweep
  (posweep.mjs:71 already prefers it). NEVER use `lb_expected.json` for cell counts (overcounts 38 LBs).

## G7. DOC-1 — 65,536 myth
- EDIT: `docs/ring-expansion-method.md:3,75,210-211,225` + `docs/prompts/dereth_maps_enhanced.md:33-34`:
  replace `256x256 = 65,536` with `255x255 = 65,025`. Verify `grep -nE '65536|256.*256'` returns zero.

---

# GROUP H — HEADLESS-HARNESS VERIFICATION (the runtime gate)

Bring the stack up with `/home/wbterminal/out/harness-up.sh` (ACE net10.0 + wsbridge:8080 + serve.py:8765,
`HOLTBURGER_DIST=/home/wbterminal/holtburger-dist`). **After any pull touching holtburger-web, rebuild the wasm
pkg first** (`wasm-pack build --target web --out-dir pkg --release`) or the page silently blanks.

- **Town probe (proves SPAWN-1+WEENIE-1):** drive the page (`probe_holtburg.mjs`-style; PAGE_URL
  `index.html?renderer=3d&quality=high`), inject Holtburg `0xA9B4` via `loadSpawnsForLandblock`, then
  `window.liveScene3d.spawnsSummary.injectedCount > 0`, console `[scene3d.spawns] LB 0xA9B4: 106 record(s)`, and
  the SINGULAR aggregate `window.liveScene3d.spawnsSummary.placeholderCount === 0`.
- **Wilderness probe (proves SPAWN-2+GEN-1):** target `0xA9B2` (=43442; encounter rows wcid 5150 → two Scatter
  child wcids 2566 & 24937, each `init_Create=1`). Before fix: `0xA9B2` 404s → `injectedCount==0`. After fix:
  `injectedCount > 0` with `placeholderCount==0`, and the rendered `record.wcid` is the generator's child wcid,
  NOT the bare encounter generator wcid (GEN-1 acceptance). Order of magnitude SMALL (~1-3/cell), NOT tens (F3).
- **Live-ACE parity (open-question #4):** with a live wire the same LB shows the SAME or a superset of creatures
  (the server's SpawnEncounters delivers them); matching off-wire ⇒ the gap was purely staging.
- **Harness assertion fix:** convert the diag-only placeholder `console.log` in `capture_phase_d_spawns.cjs`
  (~:615-621) into a real `check()` so the harness actually gates (see A4 defect 4).
