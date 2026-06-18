# FIX-LOOP HANDOFF — 2026-06-17

Status of the stitched empty-world + HUD fix-loop (`LOOP-RUNBOOK.md`). Merged to
**`origin/master`** (salvia420-bit) as a fast-forward: `4776f1da..84e8817a`
(7 commits). NOT pushed to `upstream` (Vanquish-6).

---

## TL;DR

- **PART I (empty-world fill): SHIPPED + runtime-verified.** Wilderness went
  **4,645 → 38,153 staged LBs**. The headless render probe passes (0xA9B4=106 /
  0xA9B2=31 injected, **0 placeholders**, 12 assertions). Live in the dist at
  `/mnt/wbterminal2/holtburger-dist/spawns` (old dir backed up to
  `spawns.bak-2026-06-17`).
- **PART II (HUD): 5 of 6 bands SHIPPED + verified** (A, C1, D, E, F).
- **DEFERRED: BAND-B** (skills-pane consolidation) + most of PART III. See below.

## Commits (origin/master)

| sha | what |
|-----|------|
| 54533a04 | PART I — empty-world fill (C# ingest + stager + fail-soft validators) |
| 20c39b52 | harness: instantiate wasm before init3D; probe wilderness 0xA9B2 |
| b87a2771 | HUD BAND-A — skills 6-tuple (marginal next-rank cost) |
| f4f04d24 | HUD BAND-C1 — registry-dispatch R2-R5 + R10 |
| 8a897e74 | HUD BAND-D+E — R6-R9, R11 |
| fa4f4ff3 | HUD BAND-F — salvage R12-R14 (createTinkeringTool wasm bridge) |
| 84e8817a | PART III — DOC-1 + PIPE-2 |

---

## OWNER DECISION baked into PART I

When A2.2 ("expand landblock_instance generators") collided with the
"Holtburg 0xA9B4 stays exactly 106" guardrail — Holtburg has **13 real town
generators** that would have grown it to ~119 — the owner chose **encounters-only**:
- `IngestAceSpawnsAsync` passes **no** generator dicts to
  `BuildFromAceLandblockInstances` → towns stay strictly 1:1 (0xA9B4 = 106).
- Only `BuildFromAceEncounters` expands generators → the wilderness fills.
- `ExpandGeneratorChildren` stays in the builder, dormant for towns. If the owner
  later wants town NPCs rendered, re-enable by passing the generator dicts in
  `CommandEngine.SiteIngest.cs:IngestAceSpawnsAsync` (the code already exists).

## Spec misconceptions corrected (don't re-trip these)

- `TerrainDeep.wbproj` **does not exist** → host project is
  `/home/wbterminal/e1-inworld/test.wbproj` (has client_portal.dat → Region
  0x13000000 → non-synthetic terrain Z).
- Active dist is **`/mnt/wbterminal2/holtburger-dist`** (serve.py DEFAULT_ROOT),
  not `/home/wbterminal/holtburger-dist`.
- Laptop dotnet = system `dotnet` (~/.local/bin, 10.0.203) + `DOTNET_ROLL_FORWARD=LatestMajor`, NOT buildbox `/opt/dotnet`.
- `~/out/harness-up.sh` doesn't exist; the stack was already up (ACE.Server.dll,
  wsbridge:8080, serve.py:8765).
- `validate_landblock_completeness.cjs` is at `apps/holtburger-web/`, not
  `scripts/world-completeness/`.
- WBT stdin protocol: one JSON object/line keyed `"command"` (not `"cmd"`).
- wasm cache-bust `holtburger_web.js?v=` lives at **3** sites in index.html
  (947/1251/1256). Currently `wave-k-bandF-2026-06-17`.
- `canonical_classify.js` → `plugins/world-objects/`; `xp_table.rs` →
  `holtburger-dat`.

## Known caveat (data, not code)

`~/ac_base_dats/client_cell_1.dat` is **332 MB — partial** (retail full ~750MB+).
~4,450 wilderness LBs (newbie/forest, e.g. lb 764) get terrain-miss **Z=0**; the
encounter ingest counts these (`zeroZRecords=27582`) and warns, but stages them
anyway. The probe targets (0xA9B2/0xA9B4) have valid Z. To eliminate the Z=0
tail, re-run the encounter ingest against a project with a full cell dat and
re-stage (deterministic — `diff -rq` clean on re-run).

---

## How to re-verify (the render probe — now WORKS)

The town/wilderness render probe was failing on a **pre-existing harness bug**
(commit 20c39b52 fixed it): `capture_phase_d_spawns.cjs` drove `init3D` without
first calling the wasm-bindgen default `init()` + `init_resource_source()`.

```sh
cd external/holtburger/apps/holtburger-web
export HOLTBURGER_DIST=/mnt/wbterminal2/holtburger-dist
export PLAYWRIGHT_CACHE=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules
node capture_phase_d_spawns.cjs        # 12 assertions, 0 FAIL; init ~30s, total ~2-3 min
```
Expect: `0xA9B4 = 106`, `0xA9B2 = 31`, `placeholderCount === 0`.

JS unit aggregator (stubs, no browser):
```sh
node harness/run-all.mjs --js
# 13 passed, 5 failed — the 5 fails are PRE-EXISTING (input/jump/particle/spawn),
# confirmed by stashing the band changes and re-running (identical split).
```

Re-stage PART I from scratch (deterministic):
```sh
# 1) WBT dll (laptop):
DOTNET_ROLL_FORWARD=LatestMajor dotnet build WorldBuilder.Terminal -c Release
# 2) ingest (one --stdin session; SCR=/mnt/wbterminal1/tmp/claude-scratch):
#    {"command":"load","path":"/home/wbterminal/e1-inworld/test.wbproj"}
#    {"command":"ace-db-connect","host":"127.0.0.1","database":"ace_world","user":"ace","password":"ace"}
#    {"command":"ace-db-ingest-weenie-index","out":"$SCR/weenie_index.jsonl"}
#    {"command":"ace-db-ingest-spawns","out":"$SCR/ace_spawn_records.jsonl"}
#    {"command":"ace-db-ingest-encounters","out":"$SCR/ace_spawn_records.jsonl","append":true}
# 3) stage:
ACE_SPAWN_SOURCE=$SCR/ace_spawn_records.jsonl ACE_WEENIE_INDEX=$SCR/weenie_index.jsonl \
  HOLTBURGER_DIST=/mnt/wbterminal2/holtburger-dist \
  python3 external/holtburger/scripts/world-completeness/stage-ring-spawns.py \
    --all-world --source $SCR/ace_spawn_records.jsonl \
    --weenie-index $SCR/weenie_index.jsonl --out /mnt/wbterminal2/holtburger-dist/spawns
```

wasm rebuild (laptop, OOM-jailed) — needed if you touch `src/lib.rs`:
```sh
cd external/holtburger/apps/holtburger-web
export PATH="$HOME/.cargo/bin:$PATH"
capped-build wasm-pack build --target web --out-dir pkg --dev   # ~70s incremental
# then bump ?v= at all 3 index.html sites
```

---

## REMAINING WORK

### BAND-B (S2/S4/S3) — skills-pane consolidation — DEFERRED
The headline HUD feature (owner's tabbed-pane architecture: gmStatManagementUI
improve-footer INSIDE the character pane's Skills+Attributes tabs; retire the
standalone train-skills view; repoint F11). **Deferred because** it's a ~150-line
click-to-improve UI refactor of the **PROTECTED** character pane whose interactive
flow (click skill → footer cost → Improve fires `raiseSkill`) **cannot be verified
headlessly** — the render probe only proves the page boots. Shipping it unverified
risked a regression in a working, protected pane.

**Not a regression to defer it:** the standalone `train-skills.js` view still works
(F11 opens it, has the raise UI). BAND-B is an architectural consolidation, not new
functionality.

To do BAND-B, you need an **in-world keystroke/click session** (the page must boot
past login so the HUD mounts, then drive `Shift+...`/clicks via Playwright + an
auto-login URL). Prereqs are all verified and ready:
- S1 (the marginal `next_rank_cost` 6th tuple field) is **already shipped** (BAND-A),
  so the footer's raise-cost preview has its data source.
- Pure helpers `{TRAINING, computeNextRaiseCost, decideTrainAction}` in
  `train-skills.js` are intact and tested (`test_train_skill.mjs` 17/17).
- Full spec + verified line numbers in `hud-SPEC.md` §S2/S3/S4. PROTECT the
  read-only Skills tiering (character-info.js:798-810) and the Attributes per-row
  raise buttons (additive footer only).
- S3 must NOT land without S2 (retiring the standalone view without the new footer
  would regress the raise capability — they're a unit).

### PART III — DEFERRED (lower priority / higher risk)
- PIPE-1 (reconstruct `worldsweep-driver.sh` from
  `FULL-WORLD-BAKE-VERIFY-HANDOFF.md:38-72`).
- RUNTIME-1/2/3 (scene3d streaming polish — JS; harder to verify, lower value).
- PREFETCH-1 + TERR-1 (Rust: resource-http sentinel mesh / dat-shard guard).
- SCEN-1 (scenery-bake `--manifest-out` for the parallel-bake manifest race;
  scenery is already correctly baked at 80,395 LBs, so this only matters on a
  parallel re-bake).
- INT-1 (verify-side: posweep already prefers `lb_numcells.json` — likely a no-op).

### Done in PART III
- DOC-1 (65,025-LB grid myth corrected; Leaflet tile-pixel refs left correct).
- PIPE-2 (`gen-oracles.mjs` env-overridable toolchain + existsSync guards).

---

## Files touched (36)

PART I C#: `WorldBuilder.Shared/Lib/AceDb/{EncounterRecord.cs(new),AceDbConnector.Roster.cs,SpawnRecord.cs}`,
`WorldBuilder.Shared/Lib/Spawn/SpawnGazetteerBuilder.cs`,
`WorldBuilder.Terminal/{CommandEngine.SiteIngest.cs,CommandResults.cs,JsonCommandProcessor.cs,TerminalRepl.cs}`.
PART I stager/validators: `scripts/world-completeness/stage-ring-spawns.py`, `scripts/serve.py`,
`apps/holtburger-web/{validate_landblock_completeness.cjs,capture_phase_d_spawns.cjs}`.
HUD: `src/lib.rs`, `plugins/{train-skills,character-info,combat-bar,emote-panel,social-panel,stance-toggle,main-panel,allegiance-panel,fellowship-panel,examine-floaty,salvage-panel,inventory}.js`,
`ui/{ac_damage_rating,ac_window_position}.js`, `index.html`, manifests, tests, `harness/run-js-headless.mjs`.
PART III: `docs/ring-expansion-method.md`, `docs/prompts/dereth_maps_enhanced.md`, `scripts/multi-agent/gen-oracles.mjs`.
