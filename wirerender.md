# wirerender — A Curated Visual Atlas: `render-preview` × Living Atlas

> **Format:** Context · Intent · Why · Objectives · Deliverables · Validation
>
> **Scope:** A single round of work that turns the manual ten-PNG demo gallery
> served at `/tmp/dereth-gallery/` into a first-class headless deliverable.
> Pairs `render-preview` (high-resolution top-down PNGs of any LB region) with
> `describe-landblock` (the Living Atlas factual channel) into a single
> Tailwind-served viewer. Closes the loop opened by the 2026-05-01 spin wave
> (`spin.md`) by making the ACE-grounded data immediately viewable, not just
> queryable.
>
> Scope addendum: creatures + NPCs render as their actual textured 3D meshes,
> not red glyphs. Lift the post-66b80ff "building setups only" filter for the
> wcid set the spawn gazetteer references, so the existing sprite generator
> rasterizes creature setups with full GfxObj geometry + DAT textures.

---

## 1. Context

### 1.1 What landed in the spin wave

The 2026-05-01 sync (`spin.md`, commit `e27e95d`) put a real ACE world DB
behind the static-site emitter:

- `ace-db ingest-{creatures,npcs,housing,spawns}` pull canonical rosters
  from a local MariaDB fixture (`scripts/spin-up-mariadb.sh`,
  `baltic`/`baltic`/`baltic`).
- `_spawnGazetteer` is now a `Dictionary<ushort, List<SpawnRecord>>` sourced
  from either the LSD-Partial JSON dump or the ACE `landblock_instance`
  table, with category + generator + `IsSynthetic` resolved at gazetteer
  build time.
- `meta.js` carries a `coordSystem` block; `app.js` asserts it on boot.
- Per-LB `desc/<lbHex>.js` files now publish the full SpawnRecord array.
- Static site emits `creatures` / `npcs` / `housing` / `diagnostics`
  overlays with empty-stub fallback so missing source files no longer
  silently 404.

Verified live numbers against the fixture: 7,830 creatures, 975 NPCs,
650 houses / 861 portals, 113,555 deduplicated spawns across 2,259 LBs in
the merged `spawn_gazetteer.json`.

### 1.2 The proof-of-concept that says "more, please"

The session that landed the spin wave also produced a manual gallery at
`/tmp/dereth-gallery/`:

- 10 hand-picked LBs (5 famous towns + 5 spawn-dense creature/NPC zones).
- Each rendered via `render-preview` at `radius=1, resolution=1536,
  useSprites=true, overlay=true` → 1536×1536 PNG, ~5MB.
- Wrapped in a single-page Tailwind layout (CDN, no build step).
- Served via `python3 -m http.server 8090` over Tailscale to a remote
  laptop.

That gallery proved the value of a curated visual+factual view, but every
piece of it was hand-crafted:

- LB picks were SQL queries the user typed, then I hard-coded the lbX/lbY
  pairs into a JSON-stdin script.
- The Tailwind page hand-listed each tile's title, lb hex, and one-line
  note (sourced from the user's domain knowledge, not the codebase).
- Describe-landblock data is **absent from the gallery** — the panels
  just have my hand-written notes. The Living Atlas channel exists, was
  ingested, and was visible on the Leaflet map, but never landed in the
  showcase view.
- Nothing in the repo can reproduce the artifact; it lives only in `/tmp`
  and one scratch render-cmds.json.

### 1.3 Why creatures still render as red dots

Per `RenderPreviewRenderer.cs:631–672`, a spawn-glyph render path resolves
`wcid → setupId` (via `input.WcidToSetup`), then looks up the setupId in
the sprite atlas (`input.Sprites`). When the lookup misses, the spawn falls
back to a category glyph (red diamond for Creature, yellow for NPC).

Commit `66b80ff` (May 1 2026) restricts the sprite atlas to setupIds
matching `(id >> 24) == 0x01` (building-class). The commit message is
honest about why: door/sign/prop weenies (also 0x02xxxxxx) projected
poorly through the top-down camera because their geometry is mostly
*flat vertical planes* — a door's mesh is a polygon-thick rectangle.

But that filter is overbroad. AC creatures (Drudge, Mosswart, Banderling,
the human NPCs) are full 3D meshes — head/torso/limbs/armour with proper
volume. Top-down rasterization sees the back of the head, the shoulder
silhouette, the weapon — exactly what a player's overhead camera sees in
the live game. The flat-plane projection problem applies to props, not
creatures. The 66b80ff filter swept creatures up by setupId range, not
by actual geometry shape.

### 1.4 What's available we haven't used yet

- **Spawn gazetteer wcids**: 113,555 spawn records reference a finite set
  of unique creature/NPC wcids (probably ~1000-3000 distinct setups once
  deduped). That's a tractable number to rasterize into the sprite atlas.
- **`WcidToSetup` resolver** is already in `CommandEngine` (per
  `66d381d`); it maps each ACE wcid to the DAT setupId.
- **`generate-object-sprites`** already does the rasterization work —
  the only change is which setupId set it accepts.
- **`describe-landblock` JSON** carries everything the gallery panel
  wants: region, town, biome, structure list, named POIs, spawn roster
  with category/generator/wcid/positions, validation diagnostics, verbal
  paragraph. Currently consumed only by the static-site Leaflet panel.
- **Tailwind via CDN** is the correct stack — proven over Tailscale, no
  build step, works from `file://` and HTTP equally.

---

## 2. Intent

Produce a **headless, repeatable, in-repo command** — `emit-atlas-gallery`
— that bundles `render-preview` PNGs and `describe-landblock` JSON for a
curated set of landblocks into a single self-contained Tailwind-served
viewer, and lift the sprite-atlas building filter for creature/NPC
setups so the rendered LBs show actual textured meshes instead of red
glyphs.

Specifically:

1. **Lift the creature-setup filter** so the sprite atlas covers every
   wcid the project's spawn gazetteer references, not just buildings.
2. **Curate landblock picks programmatically** from the data the spin
   wave already brought online: town gazetteer for settlements, spawn
   density for creature zones, dungeon document set for interior
   showcases, region anchors for geographical variety.
3. **Bundle render + describe per LB** into a deliverable directory:
   `<out>/renders/<slug>.png` + `<out>/desc/<slug>.json` + `<out>/index.html`.
4. **Tailwind viewer** that:
   - Renders the gallery as filterable cards (by category: town /
     creature zone / dungeon / wilderness; by region; by spawn count).
   - Click a card → side panel shows the describe-landblock data
     (verbal, structure list, spawn roster grouped by category, named
     POIs, validation diagnostics).
   - Spawn-roster entries link to a "creature card" subpanel that
     shows a high-res render of the creature's textured mesh in
     isolation (cropped from the sprite atlas) plus the
     `creature_gazetteer.json` row for context.
5. **Serve over Tailscale**: include a thin `serve-atlas` REPL command
   that wraps `python3 -m http.server` with the right bind address,
   logs the Tailscale URL.

Intent is **not** to fork the static site or add a new map projection.
The Leaflet view in `emit-static-site` remains the comprehensive
"explore the whole world" surface; `emit-atlas-gallery` is the curated
showcase view — what you'd put on a project README or share with someone
who wants to see "what does this world look like" without zooming around
49,152 landblocks.

---

## 3. Why

### 3.1 The Living Atlas is invisible without a viewer for it

`describe-landblock` produces rich factual JSON for every populated LB:
biome, town context, structure list, spawn roster, validation, verbal
summary. The static site does surface this in the right-side panel, but
only on hover/click within the Leaflet map. There is no curated
"here are 10–50 LBs that exemplify this world" view — and that is
exactly what a project owner wants to share, what an ML agent wants to
sample, and what a code reviewer wants to glance at to grade output.

The manual gallery built during the spin-wave session proved the value
visually but had hand-written panel text. Wiring describe-landblock data
into the same surface is a small, mechanical change that makes the
factual channel visible alongside the visual one.

### 3.2 Creatures-as-red-dots is misleading on the showcase view

The Leaflet map's tile pyramid currently renders creature spawns as red
glyphs because the sprite atlas excludes their setupIds. On the
"explore everything" Leaflet surface that's tolerable — at low zoom
glyphs read clearly, and the panel data has the wcid+name. But on a
**curated showcase**, a Drudge spawn rendered as a generic red diamond
fails the showcase's only job: showing what's actually in this world.

The 66b80ff filter was a reasonable safety net when the building/prop
distinction was the immediate problem. With the spawn gazetteer now
giving us a precise wcid set (113k records, ~ a few thousand distinct
setups), we can be specific: include the creature/NPC setups, leave the
flat-plane props out by setup-shape detection (not just setupId range).

### 3.3 The auto-curation primitives already exist

The spin wave brought online every input the curator needs:

- `town_gazetteer.json` (60 named towns with lb_key) → settlement picks.
- `_spawnGazetteer` per-LB counts → creature-zone picks (top-N by
  outdoor spawn count, deduped across visually similar neighbours).
- Dungeon documents (38,670 in RetailSmoke) → interior picks (top-N
  by cell count + floor count).
- `_regions` / `_regionAnchors` → one anchor per region for geographical
  diversity.

The curator just composes these: 5 towns from town_gazetteer, 5 creature
zones from spawn density, 5 dungeons by complexity, 5 region anchors
for geographical variety = 20 picks default, configurable.

### 3.4 The Tailscale serving step is one command

The proof-of-concept demonstrated that `python3 -m http.server 8090`
binding `0.0.0.0` on this machine is reachable from any tailnet member
via `http://100.116.47.66:8090`. That's the entire deployment story for
internal sharing — no DNS, no TLS, no cloud. A `serve-atlas` REPL
helper that wraps the same command + prints the URL is one screenful
of code.

### 3.5 The deferred work fences itself

This wireprompt explicitly **does not** touch:

- The sprite-generator camera (top-down stays top-down — see §1.3 for
  why creatures work fine under it).
- The sprite atlas's pack algorithm (current single-pass packer handles
  the projected scale of ~3000 setups; if it OOMs we'll address then).
- The static-site emitter (`emit-static-site` and the Leaflet bundle
  remain unchanged; this is a parallel deliverable).
- The DAT files or any write path (`emit-atlas-gallery` is read-only).
- Any creature-render polish like animation frames or pose selection
  (single-frame rest-pose top-down render is enough for the showcase).

---

## 4. Objectives

### O1. Lift the creature-setup filter in `generate-object-sprites`

**Data flow:** `CommandEngine.GenerateObjectSprites` (around line 11176)
currently filters `CollectPlacedModelIds` results to `(id >> 24) == 0x01`.
Replace with a two-pass selection:

1. Always include building setups (`(id >> 24) == 0x01`).
2. Additionally include any setupId reached via `WcidToSetup(wcid)` for
   wcids in `_spawnGazetteer` whose `Category ∈ {"Creature", "Npc"}`.
3. **Skip** setups whose GfxObj bounding box has one dimension
   < 0.05 × max(otherDim) — that's the flat-plane signature (doors,
   signs, banners). This catch-all keeps the 66b80ff fix in spirit
   without throwing out 3D creatures by setupId range.

**Files:** `WorldBuilder.Terminal/CommandEngine.cs:11176+`,
`SpriteAtlasLoader.cs` (relax `OnlyBuildings` runtime filter to match —
or honour the atlas's own contents, since #3 above is now the
filtering mechanism).

**Acceptance:** after re-running `generate-object-sprites` on
RetailSmoke, the atlas manifest contains ≥ 500 creature setupIds (a
sample of which renders as a recognizable Drudge / Banderling / Mosswart
when dumped as a 256×256 PNG, not a flat black slab).

### O2. Auto-curate landblock picks

**API to expose:**

- `WorldBuilder.Terminal/AtlasCurator.cs` (new) — static class with one
  method:
  ```csharp
  public static List<AtlasPick> Curate(
      CommandEngine engine,
      int towns, int creatureZones, int dungeons, int regionAnchors);
  ```
- `AtlasPick` record: `(ushort LbKey, string Title, string Category,
  string Note, int? SpawnCount, int? CellCount)`.

**Picker rules:**

- **Towns** (default 5): pull from `_townGazetteer`; pick by name fame
  (Holtburg, Yaraq, Cragstone, Arwic, Sanamar) or fall back to first-N
  by gazetteer order. Title = town name, Category = "town", Note =
  culture + "(LB 0xHHHH)".
- **Creature zones** (default 5): query `_spawnGazetteer` for top-N
  outdoor (cell ≤ 0x40) LBs by `Category=="Creature"` count, deduped
  by Chebyshev distance ≥ 4 LBs to avoid picking 5 adjacent dungeons.
  Title = top weenie name (e.g. "Withered Banderling Camp"), Note =
  "N spawns, K distinct wcids".
- **Dungeons** (default 5): from `_dungeonDocs` (or
  `engine.GetDungeonFloorCount` over all known dungeon LBs), top-N by
  `cellCount × floorCount`. Title = dungeon document's `Description`
  field if present, else "Dungeon 0xHHHH". Category = "dungeon".
- **Region anchors** (default 5): one anchor LB per region from
  `_regionAnchors`, picked by region name diversity (one Aluvian, one
  Sho, one Gharu'ndim, etc.). Category = "region".

**Acceptance:** running with defaults produces 20 picks; running with
`towns=10, creatureZones=10, dungeons=0, regionAnchors=0` produces 20
picks all weighted to the populated areas.

### O3. `emit-atlas-gallery` headless command

**API to expose** on `CommandEngine` (new partial
`CommandEngine.AtlasGallery.cs`):

```csharp
public AtlasGalleryResult EmitAtlasGallery(
    string outDir,
    IReadOnlyList<ushort>? lbFilter = null,    // explicit override; null → curate
    int autoTowns = 5, int autoZones = 5,
    int autoDungeons = 5, int autoRegions = 5,
    int radius = 1,                            // 1 = 3×3 LB region, ~576wu
    int resolution = 1536,                     // px per side
    bool useSprites = true,
    bool overlay = true);
```

**Pipeline per pick:**

1. `RenderPreview(lbX, lbY, radius, resolution, overlay, sprites)` →
   write PNG to `<outDir>/renders/<slug>.png`.
   - `slug` = `<##>_<sanitized title>` (e.g. `01_holtburg`,
     `06_creeping_blight`).
2. `DescribeLandblock(lbX, lbY)` → write JSON to
   `<outDir>/desc/<slug>.json`. Strip the `objectIndex` array if it
   exceeds 500 entries (panel doesn't use it; saves bytes).
3. Append a row to `<outDir>/manifest.json`:
   ```json
   {
     "slug": "01_holtburg",
     "title": "Holtburg",
     "category": "town",
     "lb": "0xA9B4", "lbX": 169, "lbY": 180,
     "render": "renders/01_holtburg.png",
     "desc": "desc/01_holtburg.json",
     "spawnCount": 47,
     "renderObjectCount": 239,
     "note": "Aluvian starter — town hall, marketplace, vendor row"
   }
   ```

**Output structure:**

```
<outDir>/
├── index.html             ← Tailwind viewer (O4)
├── manifest.json          ← gallery picks + metadata
├── renders/<slug>.png     ← one per pick
└── desc/<slug>.json       ← describe-landblock per pick
```

**Acceptance:** `emit-atlas-gallery <outDir>` produces a directory that
serves cleanly via `python3 -m http.server` and shows N picks where
N = sum of the auto-N args (default 20).

### O4. Tailwind viewer template

**Deliverable:** `WorldBuilder.Terminal/AtlasGallery/index.html` (new) —
copied verbatim into `<outDir>/index.html` by the emitter. Single-file
Tailwind CDN page, no build step, follows the same
no-`fetch()`-needed pattern as the static site (loads `manifest.json`
via a small inline JSON-loading helper so it works from `file://`).

**UI layout:**

- **Header**: title, project name, generation timestamp, total picks
  count, link to the Leaflet view (`../static-site/index.html`) if
  emitted alongside.
- **Filter bar**: chips for category (`all` / `town` / `creature zone` /
  `dungeon` / `region`), free-text search box (matches title + note +
  spawn-roster names).
- **Card grid** (1/2/3 columns responsive):
  - Each card: render PNG, title, lb hex, category badge, spawn count.
  - Hover: scale 1.03 + amber border (matches the proof-of-concept).
- **Side panel** (slides in on card click, half-screen on desktop):
  - Top: high-res render (linked to PNG for full-size).
  - "Living Atlas" section: verbal paragraph + structured fields
    (biome, region, town, structureCount).
  - "Spawn roster" section: grouped by category, each row clickable →
    "creature card" subpanel.
  - "Validation" section: diagnostics by severity (errors red,
    warnings amber, info dim).
- **Creature card subpanel** (deeper drill-down):
  - Cropped sprite from the atlas (rendered by extracting the
    sprite's bounds from `sprites/atlas.png`).
  - Wcid, class name, weenie type, AcpediaTitle if matched.
  - Counts: "appears in N landblocks across this gallery".

**Acceptance:** filter chips + search box + card click + spawn-row
click all work without page reloads. Desktop and mobile layouts both
render correctly (Tailwind responsive classes do most of the work).

### O5. `serve-atlas` REPL helper

**Headless command:** `serve-atlas <outDir> [--port 8090] [--bind 0.0.0.0]`
wraps `python3 -m http.server` (or a minimal C# `HttpListener` if we
want zero Python dependency — pick whichever is shorter and works
from the dotnet binary).

**Output:** prints the bind URL plus, when running on a Tailscale node,
the Tailscale IP form (`http://100.116.47.66:<port>`) so the URL works
from any tailnet member without DNS lookup.

**Acceptance:** `serve-atlas /tmp/atlas-gallery` from one machine,
`curl http://<tailscale-ip>:8090/manifest.json` from another tailnet
member returns the manifest.

### O6. Integrate with `emit-static-site` (optional but cheap)

Add a `--gallery` flag to `emit-static-site` that, after the Leaflet
bundle is composed, also runs `emit-atlas-gallery` into
`<outDir>/gallery/`. The Leaflet viewer's header gets a "Gallery view"
link, and the gallery's header gets a "Map view" link. Single
deliverable, two complementary surfaces.

**Acceptance:** `emit-static-site --gallery` produces both
`projects/<slug>/` (Leaflet) and `gallery/` (Tailwind cards) under one
`outDir`; the cross-links work without hand-editing.

### O7. Catalog + protocol documentation + test

For O3, O5, O6:

1. Append rows to `docs/agent_api_reference.md` under a new
   "Sync Wave 2026-05-XX — Visual Atlas Gallery" section.
2. Update `docs/agent_api_schema.json` so `emit-atlas-gallery` and
   `serve-atlas` validate.
3. Add the human REPL spelling to `docs/terminal_repl_commands.md`
   under a new "Visual Atlas Gallery" subsection.
4. Add a Python test class `TestVisualAtlasGallery` to
   `tests/test_agent_protocol.py`:
   - `emit-atlas-gallery` to a temp dir produces non-empty
     `manifest.json`, `index.html`, ≥ 1 PNG, ≥ 1 desc JSON.
   - `serve-atlas` smoke: bind, curl, kill — pure shape test.
5. Bump the README's command count, add a paragraph to the
   "DerethMaps Enhanced" section about the gallery view (with a link
   to a deployed demo if/when one exists).

---

## 5. Deliverables

| # | Deliverable | Files touched (primary) | LOC est. |
|---|---|---|---|
| D1 | Lift building-only sprite filter for creature setups + flat-plane bbox detection | `CommandEngine.cs:11176+`, `SpriteAtlasLoader.cs` | ~80 |
| D2 | `AtlasCurator` static class | `WorldBuilder.Terminal/AtlasCurator.cs` (new) | ~250 |
| D3 | `emit-atlas-gallery` engine method + result type + JSON handler + REPL handler | `CommandEngine.AtlasGallery.cs` (new), `CommandResults.cs`, `JsonCommandProcessor.cs`, `TerminalRepl.cs` | ~250 |
| D4 | Tailwind viewer single-file template + asset copy | `WorldBuilder.Terminal/AtlasGallery/index.html` (new), `CommandEngine.AtlasGallery.cs` (copy step) | ~350 |
| D5 | `serve-atlas` REPL helper | `CommandEngine.cs` or `TerminalRepl.cs` | ~80 |
| D6 | `--gallery` flag on `emit-static-site` + cross-links | `CommandEngine.cs:11372+`, `StaticSite/app.js`, `AtlasGallery/index.html` | ~60 |
| D7 | Docs + tests | `docs/agent_api_reference.md`, `docs/agent_api_schema.json`, `docs/terminal_repl_commands.md`, `tests/test_agent_protocol.py`, `README.md` | ~250 |

**Total:** ~1,320 LOC across roughly 7 new/extended files. About a fifth
is the Tailwind template (which is mostly CSS classes + small JS), about
a fifth is docs/tests.

**Result-type pattern:** continue to add records to
`WorldBuilder.Terminal/CommandResults.cs`. New record:
`AtlasGalleryResult(bool Success, int PicksRendered, int LbsCovered,
int TotalSpawnCount, string OutDir, string IndexPath, string? Error)`.

**Partial-class pattern:** `CommandEngine.AtlasGallery.cs` holds the
emit method (matching the `CommandEngine.SiteIngest.cs` precedent
established in the spin wave).

---

## 6. Validation

For each cluster O1..O6:

1. **Build clean:** `dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj`
   zero new warnings; `dotnet test WorldBuilder.Tests/` all pre-existing
   green tests stay green.
2. **Sprite atlas creature coverage:** after re-running
   `generate-object-sprites` on RetailSmoke, dump the manifest with
   `jq` and assert ≥ 500 entries with `(setupId >> 24) != 0x01`.
   Sample-render 5 of them as standalone 256×256 PNGs and eye-verify
   they show recognizable creature silhouettes (not flat slabs).
3. **Auto-curation distribution:** run `AtlasCurator.Curate(5,5,5,5)`
   and assert the result has 5 town picks, 5 creature-zone picks
   (none within 4 LBs of each other), 5 dungeon picks (≥ 4 cells
   each), 5 region picks (5 distinct region names).
4. **`emit-atlas-gallery` end-to-end:** emit to a temp dir, assert
   directory layout matches §4 O3, every PNG file is a valid PNG (decode
   header check), every desc JSON parses, manifest.json has the right
   pick count.
5. **Tailwind viewer:** load the emitted `index.html` in headless
   Chrome (`scripts/qa-static-site.sh` if it exists, else manual
   checklist in `docs/atlas-gallery-qa.md`); zero red-banner errors,
   filter chips work, card click opens panel, search filters cards.
6. **Tailscale serve:** `serve-atlas /tmp/atlas-gallery --port 8091`
   on this machine, `curl http://100.116.47.66:8091/manifest.json` from
   another tailnet member returns 200 with the manifest body.
7. **Cross-deliverable link from Leaflet:** if O6 lands, the Leaflet
   viewer's header has a "Gallery view" link that resolves to
   `../gallery/index.html` and opens correctly.
8. **Docs are not optional:** PR rejected if
   `docs/agent_api_reference.md` is not updated.

---

## 7. Out of scope

- Any change to `render-preview`'s rendering math, sprite-generator
  camera angle, or atlas pack algorithm. The existing top-down camera
  works for creature meshes (per §1.3); we only change which setupIds
  feed into it.
- Animation/pose selection for creature renders — single rest-pose
  top-down is enough for the showcase. If a creature renders
  uninterestingly because it's curled up, that's a follow-up.
- Per-creature isolated render endpoint or "creature explorer"
  separate viewer — the creature-card subpanel inside the gallery is
  the only creature-isolation surface this wave delivers.
- Public hosting (Cloudflare Pages, GitHub Pages, etc.) — Tailscale
  serving covers internal-team review, which is the only audience the
  showcase has.
- Mobile-app native viewer — the responsive Tailwind layout is enough.
- DAT writes of any kind — `emit-atlas-gallery` is a read-only
  observation channel like `emit-static-site`.
- ML/agent integration: no auto-grading of "did the gallery look
  good"; the human reviews it. (The factual `describe-landblock` data
  in the side panel IS what an LLM agent reads — but the gallery
  isn't itself an ML surface.)

---

## 8. Quick reference — file map

```
WorldBuilder.Terminal/
├── AtlasCurator.cs                        (NEW — picker for towns/zones/dungeons/regions)
├── CommandEngine.AtlasGallery.cs          (NEW partial — emit-atlas-gallery + serve-atlas)
├── CommandEngine.cs:11176+                (lift building-only sprite filter)
├── CommandEngine.cs:11372+                (--gallery flag on emit-static-site)
├── CommandResults.cs                      (extend with AtlasGalleryResult)
├── JsonCommandProcessor.cs                (extend BuildCommandHandlers + cmd handlers)
├── TerminalRepl.cs                        (extend dispatch with emit-atlas-gallery, serve-atlas)
└── AtlasGallery/
    └── index.html                         (NEW — Tailwind single-file viewer template)

WorldBuilder.Shared/Lib/Sprites/
└── SpriteAtlasLoader.cs                   (relax OnlyBuildings runtime filter)

docs/
├── agent_api_reference.md                 (Sync Wave 2026-05-XX section)
├── agent_api_schema.json                  (new command entries)
├── terminal_repl_commands.md              (visual atlas gallery subsection)
└── atlas-gallery-qa.md                    (NEW — manual viewer QA checklist)

tests/
└── test_agent_protocol.py                 (TestVisualAtlasGallery class)

README.md                                  (DerethMaps Enhanced subsection updated)
```

---

## 9. References

- `spin.md` — preceding sync wave; established the SpawnRecord schema
  and brought the ACE DB online.
- `wireprompt.md` — earlier sync wave; established the partial-class /
  Shared-promotion / docs-not-optional pattern.
- `66b80ff` — commit that filtered sprites to building class only;
  this wave selectively lifts that filter for creature setups.
- `66d381d` — commit that wired `wcid → setupId` resolver into the
  spawn-glyph render path; this wave makes that path land on actual
  textured sprites instead of glyph fallbacks.
- `/tmp/dereth-gallery/` — the manual proof-of-concept this spec
  formalizes. Will be deleted once `emit-atlas-gallery` is in.

---

## 10. One-paragraph TL;DR

The 2026-05-01 spin wave landed a real ACE DB behind the static-site
emitter; a manual proof-of-concept gallery served 10 hand-picked LB
renders to a remote laptop over Tailscale. This spec turns that into a
first-class headless command — `emit-atlas-gallery` — that auto-curates
N landblocks (5 towns + 5 creature zones + 5 dungeons + 5 region
anchors by default) from data the spin wave already exposed, runs
`render-preview` and `describe-landblock` for each, and bundles the
PNGs + JSON + a Tailwind single-file viewer into one self-contained
output directory. Side panel renders the Living Atlas factual data
(verbal, spawn roster, validation) inline; clicking a spawn row drills
into a "creature card" subpanel showing the actual textured creature
sprite. To make those creature sprites real (instead of red glyphs),
this wave also lifts the post-66b80ff "building setups only" sprite
filter for the wcid set the spawn gazetteer references — the current
top-down camera handles AC's full 3D LightWave creature meshes just
fine; the 66b80ff filter was only needed to keep flat-plane *prop*
weenies (doors, signs) out, and we replace its setupId-range heuristic
with a per-setup bbox flatness check that catches actual flat planes
without sweeping creatures up. A small `serve-atlas` helper wraps
`python3 -m http.server` with the right bind address so the deliverable
streams over Tailscale by default. Seven objectives, seven deliverables
(~1,320 LOC, mostly mechanical wiring + ~250 LOC docs/tests). No new
projection, no DAT writes, no fork of the Leaflet viewer — only data
plumbing on paths the spin wave already opened, plus one targeted
filter relaxation that makes the Living Atlas's creature data actually
visible on the showcase.
