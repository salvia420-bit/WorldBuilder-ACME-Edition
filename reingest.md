# Re-ingest + Re-emit Runbook — Activate Static-Site Scene-Quality Deltas

## Context

`static_site_scene_quality.md` (Objs 0–9) shipped as code only. The pipeline
on disk still reads the *previous* `weenie_index.jsonl` (no
`ClothingBaseDid` / `PaletteTemplate` / `Inscription` fields), the LOD-N
sprite atlases don't exist, the night atlas doesn't exist, and the
existing static-site dist predates `dungeons.js` / `search_index.js` /
`zones.js` / the multi-LOD object pyramid / WebP tiles.

Until a re-ingest + re-emit runs, the visible changes from Objs 0/4/5/6/7/8/9
won't appear on the rendered tiles or the served frontend. Obj 1 (idle
poses) and Obj 2 (scene decorations) activate the moment sprite-gen
re-runs against the new `WeenieIndex`.

This is the operational follow-up the prior code commit (`494928b`)
intentionally left to the user.

## Preconditions

- ACE world DB reachable from `WorldBuilder.Terminal` (connection string
  configured via the project's `ace_db_settings.json` or the equivalent).
- The dat archive paths the project points at are still mounted.
- The release build is current: from the repo root,
  `dotnet build WorldBuilder.Terminal/WorldBuilder.Terminal.csproj -c Release`.
  PATH must include `/home/wbterminal/.dotnet/`.

## Steps

Run each step in order. The Terminal binary is invoked either through its
REPL (`dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll`)
or with JSON commands on stdin. The examples below use the REPL form;
swap to JSON if a script driver is wrapping this.

### 1. Load the project

```
project load <path-to-project-directory>
```

Verify with `project status`. If a project isn't loaded, every subsequent
command will refuse to run.

### 2. Re-ingest WeenieIndex (mandatory — gates Objs 0, 4)

```
ace-db ingest-weenie-index
```

Reads the ACE world DB, joins each weenie row to its property side-tables
(now including `PropertyDataId.ClothingBase`, `PropertyInt.PaletteTemplate`,
and `PropertyString.Inscription`), and writes
`<projectDir>/weenie_index.jsonl`. The in-memory copy is stamped immediately
— no project reload needed.

**Expected output line:**
`Ingested N weenies (M with setup, P server-managed)` where N is roughly the
DB's `weenie` row count.

**Verification:** spot-check one row carries the new fields:

```
weenie 30070            # any wcid known to be a sign or NPC variant
```

The output should now include `Inscription` (when set on a sign) and
`ClothingBase` / `PaletteTemplate` (on NPC variants like Royal Guard).

### 3. Regenerate the LOD-0 sprite atlas (mandatory — picks up Obj 1, 2 deltas)

```
generate-object-sprites force=true
```

This drives `ObjectSpriteGenerator.Run` over every model id referenced by
the project's LBs + the new scene-decoration model ids (Obj 2) + the new
ClothingTable variant tuples ingested above. Look for two log lines:

- `[Sprites] Added <N> ClothingTable variant tuples (from <M> WeenieIndex entries)` — N must be > 0 if Obj 0 succeeded.
- `[Sprites] Added <K> scene-decoration model ids (Region.SceneInfo).` — K confirms Obj 2's Scene set ingested.

This pass takes hours for a full RetailSmoke-class project (~5k setups).
Use a project filtered to Holtburg + neighbours when iterating.

### 4. Regenerate LOD-1 + LOD-2 sprite atlases (optional — gates Obj 5)

Two more sprite-gen passes, one per LOD bucket:

```
generate-object-sprites force=true lodLevel=1
generate-object-sprites force=true lodLevel=2
```

Each produces `atlas_lodN.png` + `manifest_lodN.jsonl` in the project's
`sprites/` dir. `multiLodEmit` (Step 6) needs both pairs present;
without them the LOD-1/2 buckets fall back to LOD-0 transparently.

**Verification:** total sprites/ size for LOD-2 should be < 50% of the
LOD-0 atlas — the GfxObjDegradeInfo substitutions cut detail meaningfully.

### 5. Regenerate the night atlas (optional — gates Obj 8 high-fidelity path)

```
generate-object-sprites force=true nightMode=true
```

Writes `atlas_night.png` + `manifest_night.jsonl`. The on-tile renderer
won't pick this up automatically until the static-site frontend toggles
URLs to `_night` tile dirs (currently the day/night button just CSS-tints
the day tiles). Until that wiring lands, this atlas is reference-only —
inspect a single sprite PNG to confirm the dim + glow overlays render.

### 6. Re-emit the static site (mandatory — picks up Objs 3, 4, 6, 7, 9)

```
emit-static-site projectSlug=<slug> outDir=<dist-root> maxZoom=12 minZoom=3 \
    emitObject=true emitFloor=true tileFormat=webp
```

Drop `tileFormat=webp` if you want to keep PNG tiles. WebP shrinks the
pyramid ~35% with no visible degradation at z >= 11.

For Obj 5's per-LOD object tier, run with the JSON-only `multiLodEmit=true`
flag (REPL doesn't surface this yet — drop into JSON mode and send:

```json
{"command":"emit-tile-pyramid","outDir":"<dist>/projects/<slug>/tiles",
 "maxZoom":12,"minZoom":3,"emitObjectLayer":true,"multiLodEmit":true}
```

then re-run `emit-static-site` without re-emitting the pyramid). Note:
this path renders each LB three times — figure on ~3× the wall clock vs.
the single-pass emit.

**Verification (frontend):**

- Open the dist's `index.html`. Boot diagnostics should report no
  `coordSystem` mismatches, and `dungeons.js`, `search_index.js`,
  `zones.js` should all load (visible in the network panel).
- At z=7, the zones overlay should show labelled regions (Direlands,
  Aerlinthe, Ispar). Zoom to z=11 — the layer fades.
- Click an indoor LB (e.g. 0xA9B4 Holtburg Catacombs). Floor selector
  should appear with per-floor cell counts in button tooltips.
- Click "NPCs" tab. Table loads. Type a known NPC name; the table
  filters. Click a row — map deep-links to the spawn coord.
- Hover a sign-bearing spawn at z=11+. Tooltip shows the inscription;
  the on-tile label paints the same text in italic.
- Click the day/night button (☀ → ☾). The map dims to a cool blue tint.

### 7. Smoke-test the multi-LOD object size win (optional)

If Obj 5's full pipeline ran:

```
du -sh <dist-root>/projects/<slug>/tiles/object/{8,9,10,11,12}
```

LOD-2 buckets (z<=9) should shrink ≥ 35% vs. an LOD-0-only baseline.

## Recovery

Re-running any step is safe. The emit pipeline is non-destructive across
runs against the same dist root — `manifest.js` merges, per-project files
overwrite. If a step fails partway, re-run it; the `.heartbeat` sidecar
in `sprites/` points at the last attempted setup id when sprite-gen
crashes.

## Time budget

- Step 2: low single-digit minutes against a local DB.
- Step 3: ~hours for a full Dereth project; ~minutes for Holtburg + neighbours.
- Step 4: similar to Step 3 per LOD pass; LOD-2 is fastest because the
  degraded meshes have ~10× fewer triangles.
- Step 5: similar to Step 3.
- Step 6: ~tens of minutes single-LOD, ~hours with multiLodEmit.

## Reference

- Plan: `static_site_scene_quality.md`
- Code commit: `494928b feat(static-site): execute scene-quality plan (Objs 0–9)`
- Schemas referenced: `dats.xml:3570-3711` (Setup/Animation/MotionTable),
  `dats.xml:3842-3877` (Scene/Region), ACE
  `PropertyString.Inscription = 16`.
