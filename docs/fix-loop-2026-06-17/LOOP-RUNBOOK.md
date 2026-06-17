# STITCHED FIX-LOOP RUNBOOK — 2026-06-17

One ordered sequence merging the **empty-world spawn fill** and the **HUD fixes** into a single
laptop fix-loop. Companions in this dir: `spawn-SPEC.md` / `hud-SPEC.md` (full per-step specs),
`spawn-specs.json` / `hud-specs.json` (machine indexes). Step IDs match those specs verbatim.

- Repo: `…/WorldBuilder-ACME-Edition` · Web root: `external/holtburger/apps/holtburger-web` · Dist: `…/holtburger-dist`
- Buildbox toolchain: `/opt/dotnet/dotnet` + `DOTNET_ROOT=/opt/dotnet` + `DOTNET_ROLL_FORWARD=LatestMajor`; cargo needs `RUSTUP_HOME=/opt/rust` + `/opt/cargo/bin` on PATH. **Laptop toolchain: DEFAULT paths** (`~/.cargo/bin`, system dotnet) — do NOT copy buildbox `/opt/*` paths.
- WBT dll: `WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll`.

## Why this order
PART I (world fill) is **pure C#/Python/data — touches NO wasm**, and it's the headline "world is empty"
fix, so it runs first and verifies independently. PART II (HUD) holds the only Rust→wasm edits; they're
batched into bands so wasm rebuilds **once per band**. PART III is independent polish. The two parts share
no source files except that both eventually rebuild the wasm pkg — which is exactly why they run in one
serial loop, not two parallel ones.

## WASM REBUILD MAP (rebuild the holtburger-web pkg ONLY at these points — never mid-band)
- **R0 / post-pull prelude** — rebuild pkg once after the laptop pulls (harness requirement). Laptop = `capped-build wasm-pack build --target web --out-dir pkg --dev`; buildbox = `--release`.
- **RW-1 — end of BAND-A** (after S1.rust + all 5 JS stride consumers edited): one rebuild + bump `?v=`.
- **RW-2 — end of BAND-F** (R14 createTinkeringTool). **Optimization:** edit PREFETCH-1 (PART III) in the same tree and let RW-2 cover both → saves one rebuild.
- PART I needs NO rebuild of its own (C#/data only); it runs on the R0 pkg.
- C#/native-tool builds (PART I `dotnet build`, SCEN-1 `scenery-bake.rs`, TERR-1 `dat-shard`) are separate native builds, **not** wasm rebuilds.

## FORKS — recommended defaults the loop assumes (confirm/override before running)
Spawn: **F1** expansion at INGEST · **F3** generator cardinality = weighted-random *pick-ONE* (MANDATORY — per-profile = millions of phantom fauna) · **F5** encounters `append:true` into the single spawns file (spawns→encounters order) · **F6** full 43,911 wcid→setup map under `--all-world` · **F7** encounter emits anchor-creature + selected children.
HUD: **A** cost is MARGINAL (`next_rank_xp − spent_xp`) · **B** Rust 6-tuple (not JS xp-tables) · **C** F11→`showView('character',{tab:'skills'})` not toggle · **D** keep Attributes per-row buttons + add footer · **E** R13 full-finish salvage (`IT_TINKERING_TOOL=0x20000000`) · **F** R5 add `iconSprite:"0x06004D1C"` · **G** Improve-x10 DEFERRED · **H** R3 add symmetric `__toggleSocialPanel`.

---

## EXECUTION ORDER (global)
PART I world-fill: 1 ENV-DB · 2 ENV-HARNESS · 3 WEENIE-A4.1 · 4 ENC-A1.1 · 5 GEN-A2.1 · 6 GEN-A2.3 · 7 GEN-A2.2/A2.4 · 8 ENC-A1.2 · 9 ENC-A1.3 · 10 ENC-A1.4 · 11 ENC-A1.5 · 12 BUILD(C#) · 13 TEST · 14 WEENIE-IDX · 15 SPAWN+ENC · 16 SANITY · 17 PIPE-4 · 18 WEENIE-A4.2 · 19 WEENIE-A4.3 · 20 DEDUP-B1 · 21 PROV-C1 · 22 STAGE · 23 DIST-1 · 24 PIPE-3 · 25 SCEN-1 · 26 HARNESS-FIX · 27 PROBE-TOWN · 28 PROBE-WILD · 29 PARITY(opt).
PART II HUD: 30 S1.rust · 31 S1.js.train-skills · 32 S1.js.character-info · 33 S1.js.combat-bar · 34 S1.js.ac-damage-rating · 35 **RW-1** S1.build(+commit BAND-A) · 36 R2 · 37 R3 · 38 R4 · 39 R5 · 40 R10 · 41 S2 · 42 S4 · 43 S3(+commit BAND-B+C) · 44 R6 · 45 R7a+R7b · 46 R8 · 47 R9 · 48 R11(+commit BAND-D+E) · 49 R12 · 50 R13 · 51 R14 **RW-2**(+commit BAND-F).
PART III polish: 52 PIPE-1 · 53 PIPE-2 · 54 RUNTIME-1 · 55 RUNTIME-2 · 56 RUNTIME-3 · 57 PREFETCH-1(fold into RW-2) · 58 TERR-1 · 59 INT-1 · 60 DOC-1.

---

## PART I — WORLD FILL (spawn; no wasm)  → see `spawn-SPEC.md`

**Phase 0 — env (no code)**
- **1 ENV-DB** — `mysql -h127.0.0.1 -uace -pace -e "SHOW DATABASES;"` confirm `ace_world`; `…ace_world -N -e "SELECT COUNT(*) FROM landblock_instance;"` ≈365183. Do NOT trust `TerrainDeep.wbproj` (persists wrong `ace_shard`). gate: MariaDB up. verify: count in hundred-thousands.
- **2 ENV-HARNESS** — `bash ~/out/harness-up.sh`; await `World is now open`; `ss -tlnp|grep -E ':(8080|8765)'`. gate: 1. verify: ports listening.

**Phase 1 — ingest code (C#); land before artifacts** *(native `dotnet`, no wasm)*
- **3 WEENIE-A4.1** — verify `ace-db-ingest-weenie-index` already registered (`JsonCommandProcessor.cs:227`). verify: present.
- **4 ENC-A1.1** — new `WorldBuilder.Shared/Lib/AceDb/EncounterRecord.cs`; `GetAllEncountersAsync()` in `AceDbConnector.Roster.cs` after :76; `landblock` as `(ushort)GetInt32`; `CommandTimeout=600`. verify: `dotnet build WorldBuilder.Shared` OK.
- **5 GEN-A2.1** — add `GetAllGeneratorProfilesAsync` (SQL=`CommandEngine.cs:6309-6315`), `GetGeneratorRadiiAsync` (float type=43), `GetGeneratorMaxObjectsAsync` (int type=81) to Roster.cs. verify: build OK.
- **6 GEN-A2.3** — `ExpandGeneratorChildren` in `SpawnGazetteerBuilder.cs`: Treasure-bit FIRST (`&0x40`), then FULL `where_Create` switch (no `&0x0F`); FNV-seeded weighted-random single pick capped at MaxGeneratedObjects; `nChildren=(InitCreate==-1||MaxCreate==-1)?1:InitCreate`; Category via `TryGetValue`; skip {1,4,3648}. gate: 5. verify: unit owner 1966→1 child; Contain/Treasure→0 fauna; non-gen→1:1.
- **7 GEN-A2.2/A2.4** — extend `BuildFromAceLandblockInstances` (null-default params; statics 1:1; `Respawn` tag); wire profiles/radii/max/childWeenieTypes through `IngestAceSpawnsAsync` (SiteIngest.cs:250-263); add `GeneratorChildren` to `IngestAceSpawnsResult`+ctors. gate: 6. verify: build OK; `BuildFromLsdJson` callers unaffected.
- **8 ENC-A1.2** — `BuildFromAceEncounters(...,Func<ushort,float,float,float> surfaceZ,...)`: LB-LOCAL coords; `Cell=1`; emit encounter wcid as Creature (F7) then `ExpandGeneratorChildren`; clamp `cell*24` to [0.5,191.5]; `Orientation=Identity`. gate: 6. verify: unit cellX 0→0.5, 7→168, 8→191.5; x NOT 32256+.
- **9 ENC-A1.3** — `IngestAceEncountersResult`(+`ZeroZRecords`) + `IngestAceEncountersAsync(out?,append=false)` in `CommandEngine.SiteIngest.cs`; SurfaceZ from `_terrainService`; FAIL-LOUD if `HeightTableIsSynthetic`; `StreamWriter(append)` + WARN if append & absent. gate: 8. verify: build OK.
- **10 ENC-A1.4** — wire `ace-db-ingest-encounters` into `JsonCommandProcessor.cs` (:226, :2530, :2947 read out+append) and `TerminalRepl.cs` (:4322/:4339/:4343/:4398). gate: 9. verify: build OK.
- **11 ENC-A1.5** — add `"Encounter"` to `SpawnRecord.cs:19-23` Generator doc set. verify: build OK.
- **12 BUILD(C#)** — `DOTNET_ROOT=/opt/dotnet /opt/dotnet/dotnet build WorldBuilder.Terminal -c Release`. gate: 4-11. verify: Release build OK; dll newer than Jun-14.
- **13 TEST** — `dotnet test` new `EnrichedPlacementTests.cs`. gate: 12. verify: green; determinism+classifier asserts pass.

**Phase 2 — produce artifacts** *(project + correct WORLD DB)*
- **14 WEENIE-IDX** — `--stdin`: `ace-db-connect` to **ace_world** (ace/ace) FIRST, then `ace-db-ingest-weenie-index out=/tmp/weenie_index.jsonl`. gate: 12 + connect `success:true`. verify: `withSetupDid==43911`, `serverManaged≈19154`; `grep -c setupDid == 43911`.
- **15 SPAWN+ENC** — one `--stdin` session: connect ace_world; `ace-db-ingest-spawns out=/tmp/ace_spawn_records.jsonl`; then `ace-db-ingest-encounters out=same append=true` (F5 order). gate: 14. verify: spawns `recordsWritten≈365183` (0⇒wrong DB HARD-FAIL); `generatorChildren>0`; encounters ≈165465/35634; `zeroZRecords==0`.
- **16 SANITY** — `grep -c '"generator":"Encounter"'` ≈165465; sample line x/y∈[0.5,191.5], z plausible vs raw_world_facts. gate: 15. verify: LB-local coords; non-zero Z.

**Phase 3 — stager + provenance**
- **17 PIPE-4** — `stage-ring-spawns.py:48,58` env fallbacks `ACE_SPAWN_SOURCE`/`ACE_WEENIE_INDEX`. verify: `--help` env-aware.
- **18 WEENIE-A4.2** — loud WARN + `--require-weenie-index`; skip `wcid_to_setup.json` on missing_input AND empty out_map (no `{}` stub). gate: 17. verify: missing index→WARN no file; `--require-weenie-index`→exit 1.
- **19 WEENIE-A4.3** — `--full-wcid-map` (default ON with `--all-world`): all 43911 setup-bearing entries. gate: 18. verify: flag present.
- **20 DEDUP-B1** — per-LB dedup `(cell,round(x,3),round(y,3),wcid)` BEFORE `.sort()` at :136 (prefer non-Encounter); setup-DID drop gate for invisible markers. gate: 18. verify: unit no dup in overlap LB.
- **21 PROV-C1** — extend `source.sha256` writer (:339-351): `wcid-to-setup-scope`, `weenie-index-sha256`, `weenie-index-name`. gate: 19. verify: keys present.
- **22 STAGE** — `HOLTBURGER_DIST=… ACE_SPAWN_SOURCE=… ACE_WEENIE_INDEX=… stage-ring-spawns.py --all-world --full-wcid-map --source … --weenie-index … --out …/holtburger-dist/spawns`. gate: 16-21. verify: `*.spawns.jsonl|wc -l ≈38152`; `0xA9B4`=106 lines; `source.sha256` scope=world, populated-lbs≈38152, wcid-to-setup-entries=43911; `wcid_to_setup.json` >>3 bytes; re-run `diff -rq` identical.

**Phase 4 — fail-soft + validators**
- **23 DIST-1** — `serve.py build_health` content-aware (`.spawns.jsonl` count + `source.sha256`) → `_health.json`; `index.html:2079-2085` spawns check `files<100`. gate: 22. verify: `serve.py --check` FAILED before, PASSES after.
- **24 PIPE-3** — `validate_landblock_completeness.cjs` `--skip-spawns` (soften :172-177; keep scenery :178-183 hard); document `HOLTBURGER_DIST`. verify: `--skip-spawns` reaches `[stage 1]`.
- **25 SCEN-1** — `scenery-bake.rs` `--manifest-out`/`--no-manifest` to fix the parallel manifest race (native tool build). verify: parallel bake → `bake-source.sha256` reads `40197 baked`.

**Phase 5 — runtime headless verification (the gate)**
- **26 HARNESS-FIX** — convert diag-only placeholder `console.log` in `capture_phase_d_spawns.cjs` (~:615-621) to a real `check(placeholderCount===0)`. verify: harness gates on placeholders.
- **27 PROBE-TOWN** — drive `index.html?renderer=3d&quality=high`, inject `0xA9B4` via `loadSpawnsForLandblock`. gate: 22,26 + R0 pkg + harness up. verify: `injectedCount>0`; `LB 0xA9B4: 106 record(s)`; `placeholderCount===0`.
- **28 PROBE-WILD** — inject wilderness `0xA9B2` (=43442; encounter wcid 5150 → children 2566/24937). gate: 27. verify: before fix 404→`injectedCount==0`; after `injectedCount>0` SMALL ~1-3/cell NOT tens; `placeholderCount==0`; `record.wcid` is CHILD not bare generator wcid.
- **29 PARITY (optional, open-q4)** — with a live wire, same LBs show same-or-superset creatures. gate: 28. verify: parity holds.

---

## PART II — HUD  → see `hud-SPEC.md`  (the only wasm-touching edits)

**BAND-A — skills-raise Rust 6-tuple (ATOMIC, ONE COMMIT; rebuild RW-1 at the end)**
- **30 S1.rust** — gate: `cargo test -p holtburger-world --lib` green on clean tree. lib.rs:30714 skills builder `*5`→`*6`, push MARGINAL `next_rank_xp.saturating_sub(spent_xp)` (None→0); fix doc-comments 30688/19400-19404/19447. verify: `cargo build -p holtburger-web` compiles; world lib tests green.
- **31 S1.js.train-skills** — gate: 30. `mergeSkillRows` :230 stride `i+=6`; :251 `entry.xp=tupleArrayAt(...,i+5)??0`; fix stale comments. verify: `node test_train_skill.mjs` green (1-arg `computeNextRaiseCost` untouched).
- **32 S1.js.character-info** — gate: 30. renderSkills :788 stride `i+=6`; add `xpByLine` from i+5; fix doc :777-782 + stale `skills[i*5+3]` :413. verify: parses; no other stride-5 skill loop.
- **33 S1.js.combat-bar** — gate: 30. combat-bar.js:509 stride `i+=6`; value stays `skills[i+4]`; update :508 comment. verify: Recklessness value index unchanged (i+4).
- **34 S1.js.ac-damage-rating** — gate: 30. `ui/ac_damage_rating.js:105` stride `i+=6` (value i+4 :107); **UPDATE `test_ac_damage_rating.mjs` stub :66-80 to push a 6th element/skill** (else the test is false-green — mandatory). verify: `node test_ac_damage_rating.mjs` green.
- **35 S1.build — RW-1** — gate: 31-34 ALL edited (no partial). `wasm-pack build --target web --out-dir pkg --dev` (laptop capped) + bump `?v=`. verify: `run-all.mjs --js` green; drive.mjs `skills.length%6===0`, fresh Trained shows SMALL positive cost (not cumulative), combat-bar+DR unchanged. **COMMIT BAND-A.**

**BAND-C (part 1) — registry-dispatch (must land before S3)**
- **36 R2** — gate: BAND-A committed. index.html `import emotePanelPlugin` after :1311 + `registerView("emote",…)` after :1735; emote-panel.js reshape bare view :411-466 to `{name,nameFor,mount}` AND add `let cachedTaxonomy=null;` after :42. verify: drive.mjs Shift+F2 renders, no mount/registered error, toggles.
- **37 R3** — index.html:1784 `"social-panel":()=>window.__toggleSocialPanel?.()`; manifest Shift+F3; social-panel.js add `__toggleSocialPanel` before :974. verify: Shift+F3 toggles #social; Escape closes.
- **38 R4** — index.html:1784 `"house-panel":()=>window.__toggleHousePanel?.()`. verify: Shift+F6 toggles #hb-house-panel.
- **39 R5** — index.html `import stanceTogglePlugin` ~:1311 + post-login mount({client})+`__stanceBarMounted` guard after :8257; stance-toggle.js:160 selector `[data-plugin-id=combat-bar]`; combat-bar.manifest.json:11 `iconSprite 0x06004D1C`. verify: toggle combat mode → combat-bar `<img>` warms/cools live x2; no double-mount on relog.
- **40 R10** — gate: 36-39. main-panel.js:292-302 replace unregistered-view clobber with warn-and-return; leave :266-276 untouched. verify: `showView(unregistered)` keeps current + single warn; Shift+F2/F3/F6 still open.

**BAND-B — skills-pane consolidation (after BAND-A + R10)**
- **41 S2** — gate: BAND-A. character-info.js: selection state + `.hb-ci-improve` footer (Skills+Attributes; body-bottom shift gated on activeTab∈{skills,attributes}); selectable Skills rows (no per-row btn); `renderImproveFooter` 3 states; Improve via lifted `decideTrainAction`; KEEP Attributes per-row buttons + footer (F-D); reset selection on tab switch; import pure helpers from train-skills.js. verify: Skills tab footer credits/XP; Trained→numeric Cost+Improve fires raiseSkill; Untrained→Train fires trainSkill; max=Max disabled; `test_train_skill.mjs` green.
- **42 S4** — gate: 41. confirm character-info.js:804-810 tierOrder Specialized→Trained→Untrained→Unusable not reordered; if train-skills renderBody survives, fix :507. verify: headers in order.
- **43 S3** — gate: 40(R10)+41/42. index.html remove `registerView` train-skills :1735 (+comment :1729-1735); KEEP import :1311 / plugin-map :1472 / modulepreload :968; add F11 dispatch `'train-skills':()=>window.__mainPanel?.showView?.('character',{tab:'skills'})` (F-C showView NOT toggle). verify: F11 opens/swaps character pane to Skills tab even when open on Attributes (no close); no `no view registered`; exactly ONE Skills view. **COMMIT BAND-B+C.**

**BAND-D — parity-wiring**
- **44 R6** — character-info.js token-replace `sendDisplayTitle`→`setTitle` (5×: :948/:959/:960/:962/:965). verify: `grep -c sendDisplayTitle`→0; stub asserts captured===selectedId; do NOT touch main-panel.js:346.
- **45 R7a+R7b** — gate: land together. allegiance-panel.js seed+`setCharacterOption(0x01)` ordinal; fellowship-panel.js `FELLOW_OPT_IDX{ignore:0x02,autoAccept:0x12,shareXp:0x0F,shareLoot:0x11}` seed after :954 + round-trip + Ignore↔AutoAccept mutual-exclusion. verify: allegiance click→`[[1,false]]`; fellowship AutoAccept then Ignore→`[[0x12,false],[0x02,true]]`; re-open options-panel reflects bit.

**BAND-E — examine + window**
- **46 R8** — index.html:7666-7673 replace console.log stub with `__showExamineFor(guid,{name,fromInventory:true})` + pushView fallback. verify: select item→Examine→populated; Use button + setSelectedItem unchanged.
- **47 R9** — examine-floaty.js:302 id-scoped close-before-open guard (`currentViewId()==='examine'`→`closeView()`). verify: push main-panel examine then floaty→only floaty; inventory→examine does NOT close inventory.
- **48 R11** — `ac_window_position.js` add `persistPosition()` read-modify-merge ~:81; swap `writePersisted(storageKey,state)`→`persistPosition()` at :101/:176/:194/:200; leave :88 + :262-272 + persistWindowSize.persist unchanged. verify: NEW `test_ac_window_position_merge.mjs` width/height survive drag; `run-all.mjs --js` green. **COMMIT BAND-D+E.**

**BAND-F — scaffolds**
- **49 R12** — salvage-panel.js split `fireSalvage`→request + `commitSalvage(tool,itemGuids)` (drop guard :449-451, keep send-ladder :452-489 verbatim); awaitingConfirm-guarded `hb:salvage-confirm-result` listener + teardown. verify: fire→confirm modal + 0 sends; Cancel→0; confirm→exactly ONE send.
- **50 R13** — gate: 49. inventory.js guarded pre-return before useObject :1845 routing `isSalvageTool(item)` (mask `0x20000000`)→`window.__openSalvagePanel(guid)`. verify: tool 0x20000000→panel once, useObject 0; melee 0x00000001→existing path, panel 0.
- **51 R14 (Rust; atomic) — RW-2** — gate: BAND-A committed. lib.rs add `SessionCommand::SalvageItemsWith` + `#[wasm_bindgen(js_name=createTinkeringTool)]` export + recv arm (mirror UseWithTarget); NO protocol/core/JS change. `wasm-pack build … --dev` + bump `?v=`. verify: `cargo test -p holtburger-protocol --lib test_salvage_items_with_parity` green; d.ts has `createTinkeringTool`; in-world ONE 0x027D + ONE kind-52 result. **COMMIT BAND-F.**

---

## PART III — POLISH (independent; lower priority)  → see `spawn-SPEC.md`
- **52 PIPE-1** — reconstruct + commit `worldsweep-driver.sh` (env defaults, guards, `--dry-run`).
- **53 PIPE-2** — de-hardcode `gen-oracles.mjs` (DOTNET/WBT/PROJ env + existsSync guard + stdout capture).
- **54 RUNTIME-1** — defer ring bakers to first spawn lbId (`scene3d/index.js:1196-1201`). *(JS only)*
- **55 RUNTIME-2** — raise lbCap floor / cache heightmaps off `terrainBakedLbs` (`index.js:3534-3545`). *(JS only)*
- **56 RUNTIME-3** — 2D deferredSpawns → spawn-preserving compaction (`index.html:6942-6950`). *(JS only)*
- **57 PREFETCH-1** — terrain catalog-miss → debug log + flat sentinel mesh (`manifest_source.rs:500-516`). *(Rust crate — fold rebuild into RW-2)*
- **58 TERR-1** — dat-shard CellLandblock-count guard `<60000`→warn. *(native tool)*
- **59 INT-1** — use `lb_numcells.json` for posweep interior ground truth (verify-side only).
- **60 DOC-1** — replace `256x256=65,536` with `255x255=65,025` in `docs/ring-expansion-method.md` + `docs/prompts/dereth_maps_enhanced.md`.

---

## REGRESSION GUARDRAILS (must hold)
- Holtburg `0xA9B4` stays exactly **106** records (SPAWN-1 1:1; generator expansion null-gated).
- Re-stage byte-identical (`diff -rq` clean) — FNV-seeded scatter + deterministic sort/dedup.
- Wilderness `injectedCount` SMALL (~1-3/cell) NOT tens — proves F3 weighted-random landed.
- `ace-db-ingest-spawns recordsWritten==0` ⇒ wrong DB ⇒ HARD-FAIL before staging.
- BAND-A is one atomic commit — never ship a half-migrated stride tree; the `test_ac_damage_rating.mjs` stub update is the real gate.

## PROTECT — never regress (HUD)
combat-bar.js:509 (value i+4), character-info read-only Skills tiering, `computeNextRaiseCost` 1-arg (snap.xp MARGINAL),
raise*/train* dispatch, renderAttributes raise wiring, options-panel setCharacterOption, main-panel.js:346 setTitle,
examine-floaty.mount + examine registerView + __showExamineFor, persistWindowSize.persist merge template,
pushView/closeView, salvage-confirm bus, tradeskill confirm, vitae-detail self-wire, LANDED F11-stance-revert
(inventory_helpers.js:217-226 + inventory.js:1337-1338), SalvageItemsWithActionData/0x027D pack order, UseWithTarget arm,
**train-skills.js pure exports — do NOT delete the file; do NOT keep it as a separate panel.**

## NOTES FOR THE LOOP
- Rust steps (30, 51, 57) need `cargo`/`wasm-pack`; on the laptop use `capped-build … --dev` (8GB OOM jail), `--release` only on buildbox. Pre-rebuild classifies these rebuild-pending, not fail.
- Keystroke/DOM verify = `harness/playwright/drive.mjs`; `run-all.mjs --js` = unit aggregator (jsdom-lite + localStorage stub, NOT npm jsdom).
- Flip the harness on per `holtburger-headless-harness` memory (ACE + wsbridge + serve.py; rebuild pkg after pull; `--enable-unsafe-swiftshader`; `createTestCharacter` for 0-char accounts).
