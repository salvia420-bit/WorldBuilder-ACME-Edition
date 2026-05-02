# spin — A Real Map of Dereth: Data-Driven `emit-static-site` Hardening

> **Format:** Context · Intent · Why · Objectives · Deliverables · Validation
>
> **Scope:** A single round of work that closes the gap between what `emit-static-site`
> *ships* (a sparse Leaflet map with red-dot spawn markers and silently-missing
> overlays) and what it *promises* (a full atlas of Dereth — terrain, structures,
> creatures, NPCs, housing, dungeons — pixel-aligned, click-through, ground-truthed
> against a real ACE world database). Builds on the headless-parity wave the
> 2026-04-30 sync just landed (see `wireprompt.md`).

---

## 1. Context

### 1.1 Where the static-site emitter is right now

`emit-static-site` orchestrates six headless commands into a single self-contained
Leaflet map under `{outDir}/projects/{projectSlug}/`:

| Step | Command | Output |
|---|---|---|
| 1 | `extract-cell-footprints` | `cell_footprints.jsonl` (dungeon cell polygons) |
| 2 | `generate-object-sprites` | `sprites/atlas.png` + `sprites/manifest.jsonl` |
| 3 | `render-dungeon` (per LB+floor) | floor PNGs at LB world bounds |
| 4 | `emit-tile-pyramid` | `tiles/terrain/`, `tiles/objects/` (glyphs), `tiles/object/` (sprites), `tiles/floor/` |
| 5 | `describe-floor` (per LB+floor) | per-floor verbal summaries → `dungeons/<lbHex>.js` |
| 6 | (orchestrator-only) | `meta.js` + `manifest.js` + frontend bundle |

Source files (verified line numbers, post-sync wave):
- `WorldBuilder.Terminal/CommandEngine.cs:11372–11549` — orchestrator + tile pyramid emit
- `WorldBuilder.Terminal/StaticSiteEmitter.cs` — overlay copy + manifest writer
- `WorldBuilder.Terminal/RenderPreviewRenderer.cs` — terrain + object + spawn-glyph rendering (single source of truth for what a tile looks like)
- `WorldBuilder.Terminal/StaticSite/{index.html,app.js,app.css,leaflet/}` — the frontend
- `WorldBuilder.Terminal/CommandEngine.cs:67–70` + `:1061+` — `_spawnGazetteer`
  (`Dictionary<ushort, List<LandblockDescriber.SpawnEntry>>`) loaded from
  `{projectDir}/spawnmap_summary.jsonl`

**The frontend's coordinate contract** (`StaticSite/app.js:106–109`):

```
pxPerWuAtZ0 = 256 / 49152    // one Leaflet tile at z=0 spans the whole 49,152wu world
LbPx@maxZoom = 256 * 2^(maxZoom - 8)    // pixels per landblock at the deepest zoom
```

This must agree exactly with the emitter's tile-slicing math, but **nothing in the
generated bundle asserts the agreement at runtime** — drift between the two is the
single most common alignment failure mode and goes unnoticed until a sprite lands
in the wrong landblock.

### 1.2 Empirical gap test

Read `docs/sample-dist/projects/vanilla/`:

- 9 landblocks emitted (out of ~49 152 land blocks → 0.02% world coverage).
- 4 dungeons (out of ~179 retail dungeons).
- `overlays/spawns.js` exists but contains a **flat array of 3 entries** truncated
  mid-record. Every per-LB `desc/<lbHex>.js` file shows `"spawns": []` despite the
  overlay containing real entries.
- `overlays/housing.js` referenced by `app.js:205` but **not generated** by
  `StaticSiteEmitter.EmitOverlays()` (no `housing_gazetteer.json` consumer).
- `overlays/diagnostics.js` referenced by frontend but not produced.
- `tiles/floor/` directory absent — sample emitter run did not request floor tier.

### 1.3 What the README promises (line 263–325)

> *"Five visual tiers auto-switch by zoom level… Glyphs (Structure brown, Scenery
> green, **Creature red**, **NPC yellow**, Interactive teal, Sign orange)…
> Toggle overlays (towns, **housing**, **NPC spawns**, POIs, landblock grid,
> validation)… Click any sprite or glyph; panel narrows to that placement."*

What's actually rendered:

- Creatures and NPCs do **not** appear as glyphs on the `objects/` tier. They
  exist *only* as red `L.circleMarker` overlay markers — a different rendering
  path that doesn't use the category palette and doesn't land on the same pixels
  the rest of the world does.
- Click-on-spawn surfaces a tooltip, not the per-placement panel that
  click-on-sprite gets — so spawn metadata (wcid, weenie type, ACPedia tier)
  never reaches the right-side description pane.
- Housing and validation overlays are **silent no-ops** — the loader requests
  them via JSONP `<script>` injection, the file 404s, no error surfaces.
- Synthetic 24u AABB cell footprints (the fallback for missing `EnvCell` DAT
  records, `CellFootprintExtractor` line ~11173) render identically to real
  ones — there's no visual marker that you're looking at a guess.

### 1.4 What the spawn data actually contains

`external/LSD-Partial-2025-02-23_16-15/spawnMaps/` holds **per-landblock JSON
files** (one per LB, named like `10027008 - 10027008(0099) - Black Totem Temple.json`).
Each file contains the full server-spawn roster for that LB: weenie class IDs,
positions within the LB, cell numbers, generator types, link counts.

`ingest-spawn-maps` (`CommandEngine.cs:3348`) currently extracts only the **summary**
(WCIDs + counts) into `spawnmap_summary.jsonl`. It throws away the per-spawn
position data. `_spawnGazetteer` is built from this summary file, so it contains
positions only because the summary writer happens to keep them — but the summary
schema is lossy and brittle.

**The right primitive** is a per-LB `SpawnRecord` that preserves: wcid, world
position (X/Y/Z), cell number, generator hint (Static/Linkable/Respawn),
and ontology category (Creature/Npc/Object/Surface). That primitive is what
glyph rendering, overlay markers, and per-LB descriptions all need to share.

### 1.5 What's available we haven't used yet

- **`ace_world_release/ACE-World-Database-v0.9.292.sql`** — the full ACE world
  dump (155 MB). Contains every authoritative weenie row, every official
  `landblock_instance` placement, every NPC dialogue, every housing entry, every
  creature stat block.
- **`MySqlConnector` (already a `WorldBuilder.Shared` package reference)** — the
  same client we use for `ace-db connect`/`reposition`. We can hit a local
  MariaDB the same way we'd hit a remote one.
- **The sync wave just shipped `creature-get`, `weenie-list-property-keys`,
  `placement-list/export-sql`** (per `wireprompt.md`). These are the headless
  CRUD primitives. What's missing is the **bulk-ingest direction** — pulling
  the entire ACE creature roster, NPC roster, and housing index into the
  project's `_spawnGazetteer` / overlays.

### 1.6 The MariaDB step

There is no MariaDB *server* in this environment yet — only the client library
(`libmariadb3`) and the SQL dump. To ground-truth the static site against a real
ACE world we need a one-shot local server install + database load. The user has
specified credentials `baltic` / `baltic` for both the user and the database
(matching the convention used by ACEmulator's reference `Database.config.js`).
This is a fixture, not a production deployment — it lives on `127.0.0.1:3306`,
serves one project, and gets torn down with the working tree.

---

## 2. Intent

Make `emit-static-site` produce a **complete, pixel-aligned, ground-truthed atlas
of Dereth** by:

1. **Closing the spawn-rendering gap** — wire `_spawnGazetteer` through to the
   tile pyramid so creatures, NPCs, and server-managed objects render as
   first-class glyphs/sprites at the same pixel coordinates as the rest of the
   world (not as separate overlay markers that float above the alignment grid).
2. **Locking down tile alignment** — emit a `coordSystem` block in `meta.js` and
   have the frontend assert it against its CRS transform on boot. Drift between
   the two systems becomes a load-time error, not a silently-misplaced sprite.
3. **Bringing in real ACE data** — bootstrap a local MariaDB (`baltic`/`baltic`)
   loaded from `ace_world_release/ACE-World-Database-v0.9.292.sql`, then add
   bulk-ingest commands that pull the canonical creature, NPC, and housing
   rosters into project-side gazetteer JSON files. The static site then renders
   *what an ACE world actually is*, not just what the LSD partial dump remembers.
4. **Filling missing overlays** — `housing`, `diagnostics`, and the ACE-grounded
   `creatures`/`npcs` overlays the frontend already loads but the emitter never
   produced.
5. **Marking uncertainty visually** — synthetic cell-footprint AABBs render
   dashed; missing-DAT spawns render with a `?` overlay; orphaned overlay loads
   surface in the diagnostics panel instead of failing silently.

The intent is **not** to add new editor surfaces, change the protocol, or fork
the frontend toolchain. It's to wire the headless CRUD that already exists to
the data sources that already exist, and to assert what the frontend has always
silently assumed.

---

## 3. Why

### 3.1 The Living Atlas premise depends on completeness

The README sells `describe-landblock` and the static-site description panel as
the **factual** observation channel — the one an LLM agent uses to ground its
reasoning about Dereth. Right now that channel reports `"spawns": []` for every
landblock in the sample, so the agent sees a world with no monsters. An ML loop
that reads describe output and decides "this LB is empty, place a creature here"
double-spawns on top of existing server creatures. **The factual channel must be
factual.**

### 3.2 Compare-to-retail loses half its surface area without spawn data

`compare-to-retail` (one of the three observation channels) currently compares
terrain density and building counts. With creature/NPC rosters ingested from
ACE DB it can compare:

- Generated creature distribution vs. retail
- Generated spell pool vs. retail spell table
- Custom server's `landblock_instance` table vs. canonical retail layout
- `weenie_class_Id` histograms (custom content always lands ≥ 100 000 per
  `InsertWeenieAsync`; retail lives below — easy diff)

This is the validation surface the ML pipeline needs to grade itself, and it's
unlocked by exactly one MariaDB instance + a few `SELECT *` ingest commands.

### 3.3 Tile alignment is the silent-killer bug

Sprites + glyphs + spawns + dungeons all draw to the same pixel grid. If the
frontend's `pxPerWuAtZ0` and the emitter's `LbPx` formula drift by even one
power of two (easy to do during a refactor of either side), the entire map
shifts and nobody notices until a user reports "Holtburg is in the ocean now".
A boot-time assertion costs ~5 lines of code and turns "silent geographic
catastrophe" into "load-time error message". Cheap insurance.

### 3.4 The overlays the frontend silently expects

`app.js:205` requests `housing`, `diagnostics`, `validation` overlay files via
script-tag injection. JSONP failures are silent (script tag fails to load → no
event fires → no UI hint). Users see "no housing" and assume the world has no
housing, when really the emitter just didn't write the file. Either the
emitter writes empty stub files (so the loader sees `LOAD_OVERLAY('housing', [])`)
or the frontend must surface missing overlays in the diagnostics panel — both
are trivial; doing neither is the worst of both worlds.

### 3.5 The MariaDB fixture pays for itself

Once we have a real ACE world database locally, every other observation/validation
channel benefits:

- `placement-export-sql --apply` round-trips through a real DB, verifying the SQL
  generation against MariaDB's actual schema, not a hand-rolled assumption.
- `weenie-insert` against the live DB tests the auto-class-id allocation under
  real `class_Id ≥ 100000` collision conditions.
- `spell-list --from-db` returns ground-truth spell rows we can diff against the
  DAT-side `SpellTable`.
- The integration-test harness (`tests/test_agent_protocol.py`) gains a real DB
  to point its `creature-save`/`spell-save` tests at, instead of skipping them
  on "no ace-db configured".

The fixture is one shell script and one `mysql < dump.sql` invocation. The
return is a self-validating engine.

### 3.6 The deferred work fences itself

This wireprompt explicitly **excludes** the dungeon-editor v2/v3 refactor chain
(still deferred from `UPSTREAM_SYNC_NOTES.md` Cluster A) and any DAT-write
changes. It also excludes any frontend framework migration (no React, no Vue,
no build step). The plain-ES6 + vendored Leaflet contract holds.

---

## 4. Objectives

Each objective names: the data flow being closed, the headless command(s)
involved, the on-disk artifact produced, and the visible-on-the-map outcome.

### O1. Lock the tile-coordinate contract via manifest assertion

**Data flow:** `meta.js` gains a `coordSystem` block:

```json
{
  "worldExtentWu": 49152,
  "tilePx": 256,
  "lbWu": 192,
  "pxPerWuAtZ0": 0.005208333333333333,
  "lbPxAtMaxZoom": "computed: 256 * 2^(maxZoom-8)",
  "projectionVersion": 1
}
```

`StaticSiteEmitter.WriteMeta()` writes it; `StaticSite/app.js:47+` reads it on
boot and asserts each value against its own constants. Mismatch → red banner
+ `console.error` with both values shown.

**Files:** `WorldBuilder.Terminal/StaticSiteEmitter.cs` (extend `WriteMeta`),
`WorldBuilder.Terminal/StaticSite/app.js` (add `assertCoordSystem()` after
manifest load, before any layer construction).

**Acceptance:** swap `pxPerWuAtZ0 = 256/49152` for `512/49152` in app.js; the
page must show the red banner immediately, never render a tile.

### O2. Promote the spawn-record schema and rebuild the gazetteer

**API to expose:**

- `WorldBuilder.Shared/Lib/AceDb/SpawnRecord.cs` (new) — record type:
  ```csharp
  public sealed record SpawnRecord(
      int Wcid, string Name, string Category,   // "Creature"|"Npc"|"Object"|"Surface"
      string Generator,                          // "Static"|"Linkable"|"Respawn"|"Unknown"
      ushort LandblockId, int Cell,
      float X, float Y, float Z,
      int? WeenieType, string? AcpediaTitle, string? AcpediaTier,
      bool IsSynthetic);                         // true when reconstructed from incomplete data
  ```
- `WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs` (new) — static
  builder taking either a per-LB JSON file (LSD format) **or** a MySQL
  connection (ACE `landblock_instance` rows) and producing a
  `Dictionary<ushort, List<SpawnRecord>>`.

**Move:** `LandblockDescriber.SpawnEntry` (currently in
`WorldBuilder.Terminal/LandblockDescriber.cs:65–74`) becomes a thin alias on
top of `SpawnRecord` — keep the alias for one cycle so existing call sites
compile, then delete it in the next sync wave.

**Headless commands:**

- `ingest-spawn-maps` (existing, `CommandEngine.cs:3348`) gains an
  `--emit-records <path>` flag that writes the **full per-spawn** records as
  JSONL, not just the wcid/count summary.
- `ingest-ace-spawns --from-db` (new) — reads `ace_world.landblock_instance`
  joined with `weenie` for class names + types; writes `ace_spawn_records.jsonl`
  in the same shape as `--emit-records`. Routes through `AceDbConnector`.

**Acceptance:** `_spawnGazetteer` for landblock 0x0099 (Black Totem Temple)
populated from either source produces an identical per-spawn record count,
±0 entries.

### O3. Wire spawn glyphs into the tile pyramid

**API to expose:** `RenderPreviewRenderer.Input` already has a `Spawns`
dictionary (lines 78–82) and glyph-rendering code (lines 631–672). They are
**not** populated by `EmitTilePyramid` (`CommandEngine.cs:11389+`) — that
method reads only landblock + dungeon docs. Fix this.

**Implementation:**

- `EmitTilePyramid` injects `_spawnGazetteer` into each per-LB
  `RenderPreviewInput.Spawns` before calling the renderer.
- Spawn glyphs **filter by Z**: spawns with `Z` below the local terrain surface
  (interior, dungeon, or generator-spawned) are excluded from surface tile
  layers and routed instead into the floor PNG renderer.
- Surface glyph palette per the README claim: Creature = red, Npc = yellow,
  Object = teal, Surface = brown. Same palette as static-object glyphs so the
  category dispatch is one shared switch.

**Frontend:**

- `app.js` overlay-spawn renderer (currently lines 231–265) becomes a
  *secondary* layer used only when the user toggles "show all spawns regardless
  of zoom" — the default rendering is via the tile pyramid, which already
  zooms / hides correctly.
- Click-on-glyph dispatches into the per-placement panel by looking up the
  spawn in `meta.js`'s spawn-record index (added in O2). Same panel as
  click-on-sprite — one code path.

**Files:** `WorldBuilder.Terminal/CommandEngine.cs:11389–11549`,
`WorldBuilder.Terminal/RenderPreviewRenderer.cs:631–672`,
`WorldBuilder.Terminal/StaticSite/app.js:231–341`.

**Acceptance:** the sample dist's 0x0099 landblock shows a red Creature glyph
at the world position the LSD spawnMap records (cell 482, X=110, Y=-210.63),
not a red circle floating above an empty pixel.

### O4. Populate per-LB descriptions with spawn rosters

**Implementation:** `LandblockDescriber.DescribeLandblock` (and its floor variant)
read from `_spawnGazetteer` and populate `LandblockBody.Spawns` with
`SpawnRecord[]` filtered to that LB.

**Acceptance:** `desc/0x0099.js` for a project with the Black Totem Temple LB
ingested shows a non-empty `spawns:[…]` array including Wretched, Surface, and
Black Totem entries with positions and Acpedia tiers.

### O5. Fixture: bootable local MariaDB with ACE world loaded

**Deliverable:** `scripts/spin-up-mariadb.sh` (new, idempotent):

```bash
#!/usr/bin/env bash
set -euo pipefail
sudo apt-get install -y mariadb-server     # idempotent
sudo systemctl start mariadb
sudo mariadb <<SQL
CREATE DATABASE IF NOT EXISTS baltic CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'baltic'@'localhost' IDENTIFIED BY 'baltic';
GRANT ALL PRIVILEGES ON baltic.* TO 'baltic'@'localhost';
FLUSH PRIVILEGES;
SQL
[ -f ace_world_release/ACE-World-Database-v0.9.292.sql ] || \
    unzip ACE-World-Database-v0.9.292.sql.zip -d ace_world_release/
mysql -u baltic -pbaltic baltic < ace_world_release/ACE-World-Database-v0.9.292.sql
mysql -u baltic -pbaltic -e "SELECT COUNT(*) AS weenies FROM baltic.weenie;
                              SELECT COUNT(*) AS spawns FROM baltic.landblock_instance;"
```

**Companion teardown:** `scripts/spin-down-mariadb.sh` drops the database +
user, leaves the server running.

**Companion docs:** one paragraph in `README.md` under a new "Local ACE Fixture"
subsection of "Headless Terminal & Agent API", explaining the credentials and
that this is a developer fixture, not a production deployment.

**Acceptance:** running `./scripts/spin-up-mariadb.sh` from a fresh checkout
produces a database where `SELECT COUNT(*) FROM landblock_instance` returns
≥ 100 000 rows, and `dotnet run --project WorldBuilder.Terminal -- --stdin`
followed by `{"command":"ace-db","subcommand":"connect","host":"127.0.0.1",
"user":"baltic","password":"baltic","database":"baltic"}` succeeds.

### O6. ACE-grounded creature + NPC + housing ingest

**API to expose** on `AceDbConnector` (`WorldBuilder.Shared/Lib/AceDb/`):

- `IngestCreatureRosterAsync(CancellationToken ct)` →
  `Dictionary<int, CreatureRecord>` keyed by wcid. Joins `weenie`
  (class_Id, class_Name) ⨝ `weenie_properties_int` (CreatureType, AttackHeight,
  CombatTactic) ⨝ `weenie_properties_string` (Name override).
- `IngestNpcRosterAsync(ct)` → `Dictionary<int, NpcRecord>` for `WeenieType=20`
  (Vendor) and `WeenieType=4` (Creature with TalkInteractionType set).
- `IngestHousingRosterAsync(ct)` → `Dictionary<uint, HouseRecord>` from `house`
  + `house_list` tables.

**Headless commands** (under existing `ace-db` REPL family + JSON):

- `ace-db ingest-creatures [--out <path>]` → writes `creature_gazetteer.json` to
  project root. Default path: `{projectDir}/creature_gazetteer.json`.
- `ace-db ingest-npcs [--out <path>]` → `npc_gazetteer.json`.
- `ace-db ingest-housing [--out <path>]` → `housing_gazetteer.json`.

**Static-site overlay integration:**

- `StaticSiteEmitter.EmitOverlays()` (line 166–185) gains four new overlay
  copies: `creatures`, `npcs`, `housing`, and the previously-promised
  `diagnostics`. Missing-source files write empty `LOAD_OVERLAY('name', [])`
  stubs (no silent 404).

**Acceptance:** with the local MariaDB loaded, running
`ace-db ingest-creatures` produces a `creature_gazetteer.json` containing
≥ 5 000 entries; subsequent `emit-static-site` writes
`projects/{slug}/overlays/creatures.js` and the frontend toggles a "Creatures"
layer that shows them on the map.

### O7. Surface synthetic / uncertain data visually

**Implementation:**

- `CellFootprintExtractor` already has the synthetic-fallback path. Add an
  `IsSynthetic: true` field to the emitted record. Frontend renders synthetic
  footprints with dashed stroke + 50% opacity.
- `SpawnRecord.IsSynthetic = true` for entries reconstructed without a DAT
  position (rare). Frontend renders these with a `?` glyph overlay at the
  best-guess position.
- `StaticSiteEmitter` writes a `diagnostics.js` overlay listing every overlay
  source that failed to materialize, every synthetic record count, and every
  manifest assertion mismatch logged at boot. Frontend "Diagnostics" panel
  (already in `app.js` but currently empty) reads this.

**Acceptance:** a project with no `housing_gazetteer.json` shows
"housing: 0 records (source file missing)" in the diagnostics panel, not a
silently-empty toggle.

### O8. Compare-to-retail with the real ACE roster

**API to expose** on `CommandEngine` (extend `compare-to-retail`):

- New JSON shape returned: `{ creatures: { generated: 0, retail: N,
  jaccard: 0.0, novelInLb: [], missingInLb: [] }, npcs: {...}, housing: {...} }`.
- Compares the project's `_spawnGazetteer` against the
  `creature_gazetteer.json` / `npc_gazetteer.json` ingested by O6.
- New JSON command `compare-creatures-to-retail` that returns *only* the
  creature dimensions (cheaper to call from the ML loop than full
  compare-to-retail).

**Acceptance:** for the sample 9-LB Holtburg region, `compare-creatures-to-retail`
returns a `jaccard` value (Holtburg in retail has known creatures: Drudge,
Mosswart, Mattekar; if the project doesn't include them, jaccard = 0).

### O9. Frontend correctness — bounded, asserted, observable

**Implementation:**

- `app.js` boot: `assertCoordSystem()` (O1), then `assertOverlayManifest()`
  (verifies all listed overlays loaded), then `assertSpawnIndex()` (every
  spawn record's `landblockId` exists in `meta.js`'s lbList).
- Diagnostics panel always renders, even when empty — header shows
  "Diagnostics: 0 issues" so the user knows it's working.
- Click-on-glyph (any layer) routes through one shared
  `openPlacementPanel(record)` function. Spawn click and sprite click → same UI.

**Acceptance:** run the existing `playwright`/integration suite (or a new
manual checklist in `docs/static-site-qa.md`) against the sample dist, observe
zero red-banner errors and a populated diagnostics panel.

### O10. Catalog + protocol documentation

For every command added in O2–O8:

1. Append a row to `docs/agent_api_reference.md` under a new
   "Sync Wave 2026-05-XX — Real Map of Dereth" section.
2. Update `docs/agent_api_schema.json` so the JSON schema validates the new
   commands.
3. Add the human REPL spelling to `docs/terminal_repl_commands.md` under
   "ACE Database Editing" + a new "Static Site Diagnostics" subsection.
4. Add a Python test per command in `tests/test_agent_protocol.py` exercising
   the happy path (when MariaDB fixture is available) and the no-DB error path
   (always).
5. Bump the README's command counts (currently "58 documented commands") and
   add a paragraph to the DerethMaps Enhanced section about the
   creature/NPC/housing layers + alignment assertion.

---

## 5. Deliverables

| # | Deliverable | Files touched (primary) | LOC est. |
|---|---|---|---|
| D1 | Coord-system manifest + assertion | `StaticSiteEmitter.cs`, `StaticSite/app.js` | ~80 |
| D2 | `SpawnRecord` + `SpawnGazetteerBuilder` | `WorldBuilder.Shared/Lib/AceDb/SpawnRecord.cs` (new), `WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs` (new), `LandblockDescriber.cs` shim | ~250 |
| D3 | `--emit-records` on `ingest-spawn-maps` + new `ingest-ace-spawns --from-db` | `CommandEngine.cs:3348+`, `CommandEngine.AceDb.cs` (new partial or extend), `AceDbConnector.cs` | ~200 |
| D4 | Spawn glyphs into tile pyramid | `CommandEngine.cs:11389–11549`, `RenderPreviewRenderer.cs`, `app.js:231–341` | ~180 |
| D5 | `LandblockBody.Spawns` populated | `LandblockDescriber.cs` | ~60 |
| D6 | MariaDB fixture scripts | `scripts/spin-up-mariadb.sh` (new), `scripts/spin-down-mariadb.sh` (new), `README.md` paragraph | ~80 |
| D7 | Creature/NPC/Housing ingest | `AceDbConnector.cs` (3 new methods), `CommandEngine.AceDb.cs` (3 new commands), JSON+REPL handlers | ~400 |
| D8 | Overlays: creatures/npcs/housing/diagnostics | `StaticSiteEmitter.cs:166–185`, `app.js:205+` | ~200 |
| D9 | Synthetic-marker visuals | `CellFootprintExtractor.cs`, `SpawnRecord.cs`, `app.js` (dashed stroke + `?` glyph) | ~120 |
| D10 | `compare-to-retail` with creature dims | `CommandEngine.cs` (extend), `CommandResults.cs` | ~250 |
| D11 | Frontend boot-time assertions + diagnostics panel | `app.js:1–200`, `app.css` | ~150 |
| D12 | Docs + tests | `docs/agent_api_reference.md`, `docs/agent_api_schema.json`, `docs/terminal_repl_commands.md`, `docs/static-site-qa.md` (new), `tests/test_agent_protocol.py` | ~400 |

**Total:** ~2 370 LOC across roughly 12 new/extended files. About a fifth is
docs and tests; about a quarter is the MariaDB ingest pipeline.

**Result-type pattern:** continue to add records to
`WorldBuilder.Terminal/CommandResults.cs` (now 1 369 LOC after the sync wave).

**Partial-class pattern:** the sync wave established
`CommandEngine.{Spell,Weenie,Creature,Layout,Placements,Texture,WorldGen}.cs`.
Add `CommandEngine.SiteIngest.cs` for O6 and `CommandEngine.SpawnIngest.cs`
for O3 (or fold both into the existing `CommandEngine.AceDb.cs`-style placement
partial — the line is fuzzy but consistency matters more than perfect taxonomy).

---

## 6. Validation

For each cluster O1..O8:

1. **Build clean:** `dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`
   zero new warnings; `dotnet build WorldBuilder/WorldBuilder.csproj` zero new
   warnings; `dotnet test WorldBuilder.Tests/` all pre-existing green tests
   stay green.
2. **MariaDB fixture round-trip:** `./scripts/spin-up-mariadb.sh` succeeds on a
   fresh checkout; `ace-db connect host=127.0.0.1 user=baltic password=baltic
   database=baltic` returns `success:true`; `ingest-creatures` writes a
   `creature_gazetteer.json` with ≥ 5 000 rows.
3. **Static-site coverage test:** generate a Holtburg-region static site
   (LBs 0xA8B3..0xAAB5) with the LSD spawnMap for those LBs ingested; assert:
   - Every `desc/<lbHex>.js` has non-empty `spawns:[…]` (or empty + `"reason":
     "no spawns in this LB"` so empty is *intentional*, not silent).
   - `overlays/creatures.js`, `overlays/npcs.js`, `overlays/housing.js`,
     `overlays/diagnostics.js` all exist (even if empty).
   - `meta.js` has the `coordSystem` block.
4. **Frontend assertion test:** load the generated site in headless Chrome
   (`scripts/qa-static-site.sh` — new, optional but recommended); zero red
   banner; diagnostics panel says "0 issues".
5. **Spawn alignment test:** for at least 5 known-position spawns (e.g.
   Holtburg town crier WCID at known coords), assert the rendered glyph pixel
   coordinate falls within ± 1 LB-pixel of the expected position at maxZoom.
6. **JSON protocol test:** new `TestSpinWave2026_XX_XX` class in
   `tests/test_agent_protocol.py` covers happy + error paths for every command
   added in O2/O3/O6/O8.
7. **README counts updated:** new command total reflected; new fixture documented.
8. **Docs are not optional:** PR rejected if `docs/agent_api_reference.md` is
   not updated.

---

## 7. Out of scope

- The dungeon-editor v2/v3 refactor chain (still deferred from `UPSTREAM_SYNC_NOTES.md`
  Cluster A — sequentially-dependent, needs in-game testing).
- Any DAT-write changes (`emit-static-site` is a read-only observation channel).
- Frontend framework migration (no React / no Vue / no build step). The
  plain-ES6 + vendored Leaflet contract holds.
- Server-side hosting / deployment automation. The MariaDB fixture is
  developer-local only — no Docker / Kubernetes / cloud configuration.
- Asset re-encoding (sprite atlas format, tile compression). Out of scope.
- ACEmulator integration (running an actual game server bound to the loaded
  database). The DB is for *data ingest only* in this wave.
- `SetupId`-driven creature pose/animation rendering — sprite atlas already
  uses `SetupId` for creatures via existing `wcid → setupId` resolver
  (per `feat(terminal): spawn-glyph sprite path via wcid → setupId resolver`,
  commit `66d381d`); no further work needed in this wave.

---

## 8. Quick reference — file map

```
WorldBuilder.Shared/
├── Lib/AceDb/
│   ├── SpawnRecord.cs                 (NEW — single source of truth for spawn data)
│   ├── CreatureRecord.cs              (NEW — ACE DB creature roster row)
│   ├── NpcRecord.cs                   (NEW — ACE DB NPC roster row)
│   ├── HouseRecord.cs                 (NEW — ACE DB housing row)
│   └── AceDbConnector.cs              (extend with IngestCreatureRosterAsync,
│                                       IngestNpcRosterAsync, IngestHousingRosterAsync)
└── Lib/Spawn/
    └── SpawnGazetteerBuilder.cs       (NEW — builds Dictionary<ushort, List<SpawnRecord>>
                                        from either LSD JSON or ACE MySQL)

WorldBuilder.Terminal/
├── CommandEngine.cs                   (existing 11 577+ LOC — leave alone)
├── CommandEngine.SiteIngest.cs        (NEW partial — ingest-creatures, ingest-npcs,
│                                       ingest-housing, ingest-ace-spawns)
├── CommandEngine.cs:3348+             (extend ingest-spawn-maps with --emit-records)
├── CommandEngine.cs:11389–11549       (wire spawn glyphs into EmitTilePyramid)
├── CommandResults.cs                  (extend with SpawnIngestResult,
│                                       CreatureIngestResult, NpcIngestResult,
│                                       HouseIngestResult, CompareCreaturesResult)
├── JsonCommandProcessor.cs            (extend BuildCommandHandlers + cmd handlers)
├── TerminalRepl.cs                    (extend ace-db dispatch with ingest- subcommands)
├── LandblockDescriber.cs              (extend DescribeLandblock to populate
│                                       LandblockBody.Spawns from gazetteer)
├── RenderPreviewRenderer.cs           (extend Z-filter for spawn glyphs)
├── StaticSiteEmitter.cs               (write coordSystem to meta.js, emit
│                                       housing/creatures/npcs/diagnostics overlays)
├── CellFootprintExtractor.cs          (mark synthetic AABBs)
└── StaticSite/
    ├── app.js                         (assertCoordSystem, openPlacementPanel,
    │                                   diagnostics panel, synthetic visuals)
    └── app.css                        (dashed stroke for synthetic, ? glyph)

scripts/
├── spin-up-mariadb.sh                 (NEW — install + load + verify)
├── spin-down-mariadb.sh               (NEW — drop database + user)
└── qa-static-site.sh                  (NEW, optional — headless Chrome assertion)

docs/
├── agent_api_reference.md             (Sync Wave 2026-05-XX section)
├── agent_api_schema.json              (new command entries)
├── terminal_repl_commands.md          (ace-db ingest- subcommands)
└── static-site-qa.md                  (NEW — manual frontend QA checklist)

tests/
└── test_agent_protocol.py             (TestSpinWave2026_XX_XX class)
```

---

## 9. References

- `wireprompt.md` — preceding sync wave; established the partial-class /
  Shared-promotion / docs-not-optional pattern this spec extends.
- `UPSTREAM_SYNC_NOTES.md` — Cluster A deferred work (still excluded).
- `README.md:107–325` — DerethMaps Enhanced section (the contract this spec
  delivers on).
- `docs/agent_api_reference.md` — current command catalog (now 58 commands
  post-sync-wave).
- `docs/sample-dist/` — current emitted static site for inspection.
- `external/LSD-Partial-2025-02-23_16-15/spawnMaps/` — per-LB spawn data
  (input to `ingest-spawn-maps`).
- `ace_world_release/ACE-World-Database-v0.9.292.sql` — the ACE world dump
  loaded by the MariaDB fixture.

---

## 10. One-paragraph TL;DR

`emit-static-site` is the README's "Living Atlas" feature, but ships incomplete:
spawns render as floating red dots instead of category-colored glyphs on the
tile pyramid, half the promised overlays (housing, diagnostics, creatures,
NPCs) silently 404, the per-LB description channel reports `"spawns": []` for
every landblock despite the spawn data existing in `_spawnGazetteer`, and
nothing asserts that the emitter's pixel-to-world math agrees with the
frontend's CRS transform — so a refactor of either side breaks geographic
alignment with no error. **None of the data needed to fix this is missing.**
The LSD partial dump has per-LB spawn records (`external/LSD-Partial-…/spawnMaps/`),
the ACE world database dump is sitting in `ace_world_release/`, and the
sync-wave just shipped (`wireprompt.md`) gave us `placement-list/export-sql`,
`creature-get`, `weenie-list-property-keys`, and the `OnExportCustomTextures`
wiring for headless DAT writes. This spec wires those pieces together: bootstrap
a local MariaDB (`baltic`/`baltic`) with the ACE world loaded, add three bulk-
ingest commands that pull the canonical creature / NPC / housing rosters into
project gazetteer JSON files, promote `_spawnGazetteer` to a real `SpawnRecord`
schema sourced from either the LSD JSON or the live MariaDB, wire spawn glyphs
into `RenderPreviewRenderer`'s tile-pyramid path so they render at the same
pixels as everything else, populate `LandblockBody.Spawns` so the description
channel is factual again, write `coordSystem` to `meta.js` and assert it in
`app.js` so alignment drift is a load-time error, mark synthetic cell footprints
visually so guesses don't masquerade as facts, and emit diagnostics so silent
404s become visible. Ten objectives, twelve deliverables (~2 400 LOC, mostly
mechanical wiring + ~400 LOC docs/tests), eight validation steps. No editor
redesign, no protocol changes, no DAT writes — only data plumbing through paths
the sync wave already opened.
