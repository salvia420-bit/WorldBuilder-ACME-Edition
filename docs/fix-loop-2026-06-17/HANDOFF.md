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
- **PART II (HUD): ALL 6 bands SHIPPED + verified** (A, B, C1, D, E, F). **BAND-B
  landed 2026-06-18** (`3d8a4a6d`): the headline skills-pane consolidation, now
  in-world verified (Playwright auto-login vs live ACE — F11→Skills tab, footer
  raise/train cost, real raiseSkill dispatch). JS-only, no wasm rebuild.
- **PART III: PIPE-1 + PIPE-2 + DOC-1 shipped; INT-1 confirmed no-op.** PIPE-1
  landed 2026-06-18 (`97306a3f`). Still DEFERRED: TERR-1, SCEN-1 (native-tool
  Rust — workspace build is OOM-jailed on the 8GB laptop, low value), RUNTIME-1/2/3
  (render-path JS — unverifiable in the local swiftshader env which crashes on
  repeat in-world runs), PREFETCH-1 (Rust crate + wasm rebuild, diagnostics-only).
  Best tackled on the buildbox (Rust) / 1070 (render). See below.

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

## RESOLVED non-issue — Z=0 is correct coastal terrain (not a dat/lookup problem)

> **RESOLVED 2026-06-18 (was twice-misdiagnosed).** Earlier claims — "partial cell
> dat (retail full ~750MB+)" then "terrain-lookup miss / default-0" — are BOTH wrong.
> 1. `client_cell_1.dat` = **348,127,232 B (332 MB) is the normal complete size**
>    (the ~884 MB file is `client_portal.dat`); it's the canonical dat the host
>    ingest project symlinks (`e1-inworld/dats/base/... -> ~/ac_base_dats/...`).
> 2. The `zeroZRecords=27582` (~4.7%) records are NOT a miss — **Z=0 is the real
>    ground height** at those positions. WB.Terminal (the DAT terrain oracle) returns
>    the SAME heights the ingest stored: e.g. LB 0xEE6C is **Tusker Island** (a low
>    beach, terrain-info heightMin=0/heightMax=7); its "Uber Beach"/"AD Camp"
>    encounters sit on the lowest terrain step (`get-region` height table index 0 =
>    0.0 = sea level) → `get-height` = 0 there, = 3.92/4.0 a few metres inland, and
>    = 66 at Holtburg — all matching the staged Z exactly.

No action needed: the wilderness fill placed coastal/low-island encounters correctly
at sea-level terrain. The `zeroZRecords` warning is a **mislabelled counter** (it
counts "Z came out 0", which is legitimate for beach/coast, as if it were a failure)
— cosmetic only; harmless. Verified via `WB.Terminal get-height` on the worst-offender
LBs (0xEE6C beach z=0 vs z=3.9 inland, Holtburg z=66 baseline). The probe targets
0xA9B2/0xA9B4 also have valid Z.

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

### BAND-B (S2/S4/S3) — skills-pane consolidation — SHIPPED 2026-06-18 (`3d8a4a6d`)
The headline HUD feature (gmStatManagementUI improve-footer INSIDE the character
pane's Skills+Attributes tabs; standalone train-skills view retired; F11 repointed).
JS-only (BAND-A had already shipped the Rust 6-tuple) — **no wasm rebuild**.
- **S2** (`character-info.js`, +294): selectable skill/attribute/vital rows +
  `.hb-ci-improve` footer band (body bottom 18→82px on Skills+Attributes only);
  3 retail states (default / "Cost to Train … credits" / "Cost to Raise … XP" via
  S1's MARGINAL `computeNextRaiseCost`); Improve lifts `decideTrainAction`. FORK-D:
  KEEP the Attributes per-row buttons AND add the footer. `statIndex` keyed by
  composite `${kind}:${id}` (skill 6 / attr 6, attr 1 / vital 1 collide on bare id).
- **S4** (`train-skills.js`): fixed the now-dead `renderBody` tier order to
  Specialized→Trained→Untrained→Unusable (R15). character-info tierOrder already OK.
- **S3** (`index.html`): removed the standalone `registerView`; KEPT import/plugin-map/
  modulepreload (pure helpers still imported); F11 → `showView('character',{tab:'skills'})`.
- **In-world verified** (Playwright auto-login `<test-account>` vs live ACE/wsbridge/serve,
  driver at `/mnt/wbterminal1/tmp/claude-scratch/bandb-verify/`): F11→Skills tab;
  default footer credits+disabled; Arcane Lore (Trained)→"Cost to Raise: 178 XP";
  Untrained→"Train"/"Cost to Train: 10 credits"; Attributes keeps 9 per-row buttons +
  footer; attribute→"Cost to Raise: 110 XP"; Titles hides band. The Improve dispatch
  fired the real `raiseSkill` end-to-end (server raise confirmed, cost 178→204).
  Unit: `test_train_skill.mjs` 17/17, `run-all --js` 13/5 (same pre-existing). **Caveat:**
  the local swiftshader renderer crashes ("Target crashed") on repeat in-world runs
  (1.6G /dev/shm + 8GB box) — the FIRST cold run completes; reset chromium between runs.

### PART III — DONE this pass
- **PIPE-1** SHIPPED 2026-06-18 (`97306a3f`): `worldsweep-driver.sh` reconstructed
  (env-default + path-guarded + `--dry-run`; HOLTBURGER_DIST → /mnt/wbterminal2).
  `bash -n` clean; `--dry-run` exits 0 with all paths resolving.
- **INT-1** confirmed a no-op: `posweep.mjs:71` already prefers `lb_numcells.json`.
- (Prior) DOC-1 (`84e8817a`) + PIPE-2 (`84e8817a`).

### PART III — STILL DEFERRED (env-blocked here; do on buildbox / 1070)
- RUNTIME-1/2/3 (scene3d streaming polish — render-path JS; the local swiftshader env
  crashes on repeat in-world runs, so a render regression can't be eye-tested here.
  Do on the 1070).
- PREFETCH-1 + TERR-1 + SCEN-1 (Rust: resource-http sentinel mesh / dat-shard guard /
  scenery-bake `--manifest-out`). Native/wasm builds are OOM-jailed on the 8GB laptop
  (memory rule: never workspace-build locally). Low current value (TERR-1/PREFETCH-1 =
  diagnostics; SCEN-1 only matters on a parallel re-bake — scenery is already correctly
  baked at 80,395 LBs). Do on the buildbox.

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
