# Living Atlas — code review

Review the `describe-landblock` pipeline (the "Living Atlas") as a load-bearing
API surface. Goal: certify which fields downstream consumers can rely on, fix
the silent-bug class that's accumulated, and freeze a versioned schema.

## Why this exists

The Living Atlas is the structured, gazetteer-aware description of any
landblock. It composes ontology + region/town gazetteer + Acpedia +
LSD spawnMap + biome inference + per-LB validation into a single
`LandblockDescriptionResult` and emits it via the JSON `describe-landblock`
command.

It is now **load-bearing for three independent products**:

1. **V6 placer atlas-conditioning** — `pipeline_data/reference/atlas_describe_v1.jsonl`
   was bulk-cached from describe-landblock and ingested into training
   tensors. The trainer's 156-d V6 context vector pulls 8 categorical ids,
   5 scalars, and 48 multi-hot bits directly from the describer's output.
   If describe-landblock's schema drifts, V6 silently retrains on stale
   conditioning.
2. **The upcoming verbal+visual WB.Terminal atlas product** (per memory
   `project_atlas_vision.md`) — derives a per-LB CLI search surface entirely
   from describe-landblock output. The verbal block, knownPois, and
   gazetteerNotes feed user-visible text.
3. **Per-LB explainability and validation overlays** — the validation
   diagnostics (~45 codes across DNG/LBK/TRN/BSH/BLD) are the only
   structured per-LB correctness signal in the codebase.

The V6 atlas dump on 2026-04-29 surfaced two silent-bug patterns that
together justify a full review:

- **Documented field, never emitted**: `settlementHint` was in the schema
  and consumed downstream, but always emitted as null. Root cause: stdin
  mode bypasses `CommandEngine.Load()`, so the ontology cache never
  restored, no objects got tagged `Category="Structure"`, `structureBlocks`
  was always empty, `settlementHint` (derived from `structureBlocks.Count`)
  was always null. Required a one-line lazy-load fix in `DescribeLandblockFromDocs`.
- **Documented field, always-constant value**: `body.structures[*].architecture`
  is null on every emitted structure entry across the entire 38,255-LB dump
  (3,517 structure entries, 100% null architecture). Same for
  `materialTags` (empty everywhere). Root cause not in the describer —
  somewhere in the scan-ontology / enrich-unified pipeline, Structure-category
  entries don't get an Architecture field set. Not yet fixed.

These are not isolated bugs. They are symptoms of a system whose documented
schema has drifted from what it actually emits, and whose stdin-mode
behavior diverges from interactive-mode behavior in ways that are only
caught when downstream consumers do bulk dumps. Without a certification
pass, every new consumer hits the same trap.

---

## Context — what exists in the repo

Read these before touching anything.

### Composer

- **`WorldBuilder.Terminal/LandblockDescriber.cs`** — the composer. The
  `Describe(...)` entry point is at line 18; the actual composition runs
  ~270-540 (terrain summarization, structure aggregation, loose-object
  classification, interior block, settlement inference, gazetteer overlay).
  - `structureSeeds` build at line 304 — gates on `Entry?.Category == "Structure"`,
    so a missing ontology silently zeros out structures.
  - `settlementHint` derivation at line 445 — derived from
    `structureBlocks.Count`. Single root cause shared with structureCount.
  - `dominantArchitecture` derivation at line 439 — pulls from structure
    architectures with fallback to `townContext.Culture` then
    `regionContext.Culture`. The structure-architecture path is the one
    silently broken in the V6 dump.

### Wire format

- **`WorldBuilder.Terminal/JsonCommandProcessor.cs:619`** — `CmdDescribeLandblock`
  serializes the LandblockDescriptionResult into the JSON the agents see.
  Lines 619-720 are the canonical output schema.
- **`WorldBuilder.Terminal/JsonCommandProcessor.cs:159`** — `["describe-landblock"]
  = CmdDescribeLandblock` registration.

### Project + service initialization

- **`WorldBuilder.Terminal/Program.cs:80-107`** — stdin mode entry point.
  Calls `projectManager.LoadProject` directly at line 91 — this is the bug
  that caused both the structureCount and settlementHint silent failures.
  It bypasses `CommandEngine.Load()` (line 111 in CommandEngine.cs), where
  ontology cache, building pairings, and town gazetteer auto-load.
- **`WorldBuilder.Terminal/CommandEngine.cs:111-155`** — `Load()` does
  the eager auto-restore for project-set commands. The auto-loaders here are
  the source of truth for "what the project directory contains and how it
  binds to the live services."
- **`WorldBuilder.Terminal/CommandEngine.cs:680-770`** — `DescribeLandblockFromDocs`,
  the actual entry point that JSON dispatching hits. Has now accumulated
  **5 lazy-load blocks** (ontology + 4 gazetteers) because each was found
  silently broken in stdin mode and patched separately. This pattern is
  fragile — the next downstream consumer that hits a different field will
  surface the next "documented but unpopulated" failure.

### Project-side data sources

- `ontology_cache.jsonl` — 21,253 entries; 523 tagged Structure; auto-loaded by
  `OntologyService.LoadFromCache` (now stderr-only after the V6 fix).
- `town_gazetteer.json` — 58 towns with `lb_x`, `lb_y`, `culture`, `notes`.
- `poi_gazetteer.json` — POIs for 2,044 LBs.
- `region_gazetteer.json` — 13 regions, 58 anchor points.
- `spawn_gazetteer.json` — Spawns for 1,061 LBs.
- `wcid_acpedia_join.jsonl` — Acpedia matches for 14,915 wcids.
- `building_pairings.json` — Auto-loaded in CommandEngine.Load() but **not**
  lazy-loaded in the describer; check whether describe-landblock uses it.

### Ground-truth empirical schema

- **`pipeline_data/reference/atlas_describe_v1.jsonl`** — 38,255 LBs of
  describe-landblock output produced 2026-04-29 against `RetailSmoke.wbproj`.
  This is the empirical schema. Every audit in this review should compare
  the documented schema against this file's actual contents, not the
  C# code's documented intent.
- Per-field null/zero rates from the dump:
  - `regionName` 0% missing across all 38,255 (load-bearing, gazetteer-resolved)
  - `townName`, `culture`, `gazetteerNotes` ~99.85% missing (only 58 towns)
  - `biome`, `dominantArchitecture`, `biomeConfidence`, `hasRoad` 100% populated
  - `structureCount > 0` on 1,662 LBs (4.3%) — towns + the rare wilderness cluster
  - `body.structures[*].architecture` 100% null across 3,517 entries — the bug
  - `body.structures[*].materialTags` 100% empty across 3,517 entries — the bug
  - `body.structures[*].roofShape` 4 distinct values (`pitched`, `tapered`,
    `flat`, `spire`) — works
  - `knownPois[*].categories` 167 distinct categories
  - `dominantTerrainTypes` 100% populated, ~25 distinct terrain names

### V6 trainer pipeline (downstream consumer)

- **`scripts/PopulationPipeline/OutdoorML/dump_atlas_jsonl.py`** —
  drives WorldBuilder.Terminal in JSON-stdin mode and writes the JSONL above.
- **`scripts/PopulationPipeline/OutdoorML/build_atlas_context.py`** —
  vocab build + tensor augmentation. The `CATEGORICAL_FIELDS` tuple at the
  top of this file is the V6 schema-as-consumed and shows which describer
  fields actually reach training.
- **`scripts/PopulationPipeline/OutdoorML/train_scene_placer.py:484-540`** —
  `ContextProjection` + `AtlasContextEncoder` define the model surface that
  ingests describer output. This is the last load-bearing reader.

---

## Intent

Treat the Living Atlas as a versioned API. After this review:

- Every field in the documented schema is either **populated reliably** or
  **explicitly tagged best-effort / experimental / deprecated**.
- The stdin-mode parity gap is closed at the structural level — not by
  patching the next bug as it surfaces, but by ensuring all session-scoped
  initialization runs through one path that any command can invoke.
- The two known data-fidelity bugs (`structures[*].architecture` and
  `structures[*].materialTags`) are root-caused and either fixed or
  documented as known-broken with a removal plan.
- Downstream consumers (V6 trainer, the verbal+visual atlas product) can
  pin against a versioned schema document and detect silently-broken fields
  in CI rather than via 38,255-LB bulk dumps.

This is **not** a refactor. The describer's structure stays. The JSON output
schema stays compatible (V6 is mid-training against it as of this review).
The work is auditing, root-causing, and pinning.

---

## Objectives

### O1. Schema completeness audit

For every field in the JSON output of `describe-landblock`, produce a table
with: documented vs. emitted, null-rate across the empirical dump, distinct
value count, and a tag from the set `{load-bearing, best-effort, experimental,
broken, deprecated}`.

- **Inputs**: `pipeline_data/reference/atlas_describe_v1.jsonl` (empirical),
  `JsonCommandProcessor.cs:619-720` (documented), `LandblockDescriber.cs:18-540`
  (intent).
- **Output**: a docs/living_atlas_schema.md table. One row per field.
- **Bug bar**: every field tagged `broken` must come with a separate
  bug-tracking entry (root cause + fix plan + estimated work).
- The `settlementHint` pattern (documented + present in C# struct + always
  null in dump) is the canonical example of a `broken` tag pre-V6 fix.

### O2. stdin-mode parity audit

`Program.cs:91` calls `projectManager.LoadProject` directly, bypassing
`CommandEngine.Load()`. The ontology cache, building pairings, and at
least four gazetteers all auto-load in `Load()` and silently miss in stdin
mode. The current describer mitigates with five lazy-load blocks; this is
fragile and only catches what the describer happens to consume.

- Enumerate every initializer in `CommandEngine.Load()` (lines 111-155).
- For each, check whether stdin-mode commands that depend on it have a
  lazy-load fallback. `building_pairings.json` is loaded in `Load()` but no
  lazy-load is visible in the describer; verify whether describe consumes it.
- Recommend a structural fix: either (a) move the auto-loaders out of
  `Load()` into a session-init that runs from `Program.cs:91`'s LoadProject
  path, or (b) gate every stdin-mode JSON command through a single
  `EnsureProjectInitialized()` call that runs the auto-loaders idempotently.
- The structural fix must keep the interactive REPL behavior identical.

### O3. Data fidelity — `structures[*].architecture` and `materialTags`

Root-cause and fix the architecture/materialTags emptiness across 3,517
structure entries.

- The describer reads `entry.Architecture` and `entry.MaterialTags` at
  `LandblockDescriber.cs:392-399` from the ontology entry of each Structure-
  category object.
- The ontology cache has 523 Structure-category entries; check directly:
  do any have an `architecture` field set in `ontology_cache.jsonl`?
  (Empirical: a quick grep showed `"architecture":"Neutral"` on a Tower
  Shield entry — so the field exists at least sometimes.)
- The likely path is `scan-ontology` → `enrich-unified` (the architecture
  classifier). Either it never runs on Structure entries, or it runs and
  always resolves to null.
- Trace the architecture-setter for Structure entries and either fix the
  classifier or remove the `architecture`/`materialTags` slots from the
  describer's output (and from the V6 atlas schema in build_atlas_context.py).

### O4. stdout hygiene

`OntologyService.LoadFromCache` was found writing `Console.WriteLine` to
stdout, polluting the JSON stream. Fixed in this branch but the same
pattern likely exists elsewhere.

- Grep for `Console.WriteLine` across `WorldBuilder.Shared/` and
  `WorldBuilder.Terminal/` outside of `Program.cs`'s pre-stdin branches.
- For each hit: if the call site is reachable from a JSON command's
  execution path, either route to `Console.Error.WriteLine` or gate
  behind an injected `ILogger` whose default suppresses to stderr in
  stdin mode.
- The CommandEngine's existing `Console.Error.WriteLine` calls (gazetteer
  lazy-load logs) are the right pattern.

### O5. Performance characterization

The V6 dump throughput varied 39-156 LB/s — a 4× spread. Average ~92 LB/s.

- Profile a representative sample: 50 wilderness LBs (no structures), 50
  town LBs (high structure density), 10 dungeon-adjacent LBs (high cell
  count). Measure per-call wall and per-component time (terrain summary,
  ontology lookup, footprint extraction, shape analysis, gazetteer joins,
  validation overlay).
- Identify which component drives the variance.
  Hypothesis: `AnalyzeShape` (vertex Z-histogram extraction from the GfxObj)
  and `FootprintExtractor` per-structure run-on-demand are the main cost
  drivers on town LBs.
- If true, a per-session structure-shape cache (keyed on model id) would
  amortize across dumps and lift the floor closer to 150 LB/s.
- Optional — performance is acceptable today, but a 4× variance on bulk
  dumps means downstream consumers who bulk-process a full world hit
  unpredictable wall-clocks.

### O6. Failure modes — "Could not load landblock"

10 LBs of 38,265 (0.026%) failed in the V6 dump with `Could not load
landblock 0xXXXX`. The list is in `/tmp/atlas_dump.stderr` from the
2026-04-29 dump.

- For each failed LB, check the dat directly: does `LandBlock 0xXXXX`
  exist in the cell.dat? Is the corresponding Region entry present?
  Is `LandblockDocument` raising or returning null?
- Categorize: dat-corruption, edge-of-world (no LB at this coordinate),
  loader-bug, transient I/O.
- Each category implies different action — corruption is a data fix,
  edge-of-world is a graceful skip, loader-bug is a code fix.

### O7. API stability declaration

Output a `docs/living_atlas_schema.md` with:

- **Schema version** (start at v1, bump on any non-additive change).
- **Per-field guarantee**: one of `load-bearing` (always present + non-null
  for valid LBs), `best-effort` (present when source data exists),
  `experimental` (subject to change), `deprecated` (will be removed).
- **Field origin**: what gazetteer / ontology / dat object provides each
  field, so downstream debugging knows where to look.
- **Validation rules**: invariants the consumer can rely on (e.g.,
  `biomeConfidence ∈ [0, 1]`, `structureCount >= 0`, `townName non-null
  iff lb_key in town_gazetteer`).

Anything not in this doc must not appear in the JSON output.

---

## Notes on what *not* to do

- **Don't break the JSON output schema.** V6 atlas tensors and the
  matching vocab are pinned to the current shape; a non-additive change
  invalidates `pipeline_data/reference/component_linked_unified_v5_atlas_*.{npz,json}`
  and forces a re-dump + re-train.
- **Don't refactor `LandblockDescriber.cs` into smaller files.** The
  composition is already long but linear; splitting it would obscure
  the one-pass-over-the-LB structure that makes the describer fast.
- **Don't add new fields.** This review is about pinning what exists,
  not extending the surface.
- **Don't fix the stdin-mode pattern by removing the existing lazy-load
  blocks** before O2 lands the structural fix. They are load-bearing
  scaffolding right now.
- **Don't verbally rewrite `Verbal` text.** The verbal generator is a
  separate concern; only audit it for null-safety on fields O1 finds
  unpopulated.

---

## Sequence of work

1. **O1 schema audit** (~2h, data-driven from the JSONL). Produces the
   table that scopes everything else.
2. **O3 architecture/materialTags root cause** (~2-4h, may surface a
   deeper ontology classifier bug). Highest single-field fidelity gain.
3. **O4 stdout hygiene grep** (~30 min). Cheap and prevents a class of
   future stdin-mode breakage.
4. **O2 stdin-mode parity** (~1-2h). Land the structural fix, then remove
   the lazy-load blocks in the describer (they become dead code).
5. **O5 performance profile** (~2h, optional). Useful for the verbal+visual
   atlas product if it ever needs to dump full worlds in the user-facing
   path; not blocking V6.
6. **O6 failure modes** (~1h, optional). 0.026% miss rate is acceptable;
   only worth doing if the categorization reveals a fixable loader bug.
7. **O7 schema declaration** (~1h). Final deliverable; pins the result of
   O1 + O3 fixes into a versioned doc.

Total: 8-13 hours for the full review with optional sections; 5-9 hours
for the load-bearing core (O1 + O3 + O4 + O2 + O7).

---

## Files this review will create / modify

- `docs/living_atlas_schema.md` (new — the O7 deliverable)
- `WorldBuilder.Terminal/CommandEngine.cs` (O2 structural fix — consolidate
  the auto-loaders into a session-init guard)
- `WorldBuilder.Terminal/Program.cs` (O2 — call the session-init from the
  stdin-mode LoadProject path)
- `WorldBuilder.Shared/Services/OntologyService.cs` (O3 — fix the architecture
  classifier for Structure entries, IF that's where the bug lives)
- Possibly `scripts/PopulationPipeline/Ontology/scan_ontology.py` or
  `enrich_unified.py` (O3 — depending on where architecture-on-Structure
  is supposed to be set)
- Targeted edits in any C# file that O4 finds writing to stdout

## Files this review will NOT touch

- The describe-landblock JSON wire format (frozen by V6).
- `LandblockDescriber.cs` composition logic — only field-presence asserts
  and possibly removal of fields O1 marks `deprecated`.
- The verbal text generator (`LandblockDescriber.cs` lines ~1090-1140) —
  separate concern.
- V6 trainer code — atlas vocab and tensor schema are downstream of this
  review and should not be regenerated mid-V6 training.
