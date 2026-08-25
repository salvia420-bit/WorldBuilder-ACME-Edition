# Per-Landblock Faithful World — EXECUTION RUNBOOK (2026-06-26)

Companion to [`per-landblock-faithful-world-method-2026-06-26.md`](per-landblock-faithful-world-method-2026-06-26.md)
(read it first — diagnosis, contract, fix-set, verify). This is the ordered, copy-pasteable
runbook. Each step ends with a **GATE** that must pass before the next. Heavy bakes run on the
**buildbox** (18 cores); the laptop OOMs on workspace builds.

## Progress log (live)

- **2026-06-26 — Fix 1 (generators) + Fix 2 (orientation): SHIPPED + LIVE.**
  - Code: `CommandEngine.SiteIngest.cs:268` now passes generator dicts into
    `BuildFromAceLandblockInstances` (mirrors the encounter path); `SpawnRecord` now emits
    flat `qw/qx/qy/qz` scalars (System.Numerics.Quaternion only serialized `IsIdentity`,
    silently dropping rotation — the 2026-06 orientation regression). WBT builds clean.
  - Data: re-ingested `ace_spawn_records.jsonl` (390,807 spawns w/ 25,624 generator children +
    orientation) + appended encounters (334,209) = 725,016 records; staged world-wide →
    `dist/spawns` (722,176 records / 38,152 LBs / `wcid_to_setup` 43,911 full-index).
  - Verified LIVE: dungeon `0x00B4` **0 → 810 visible monsters**; Holtburg `0xA9B4` 106 → 119;
    portals oriented (`Portal to Town Network` qw=0.658662; `Destroyed Portal to Redspire`
    qw=-0.793566 = exact match to the known-good Jun-14 backup).
  - Rollback: `dist/spawns.bak-pre-genfix-2026-06-26` (+ the identical `spawns.wildernessfill-2026-06-17`);
    source backup `ace_spawn_records.jsonl.bak-pre-genfix-2026-06-26`.
  - NB: the project's `ace_spawn_records.jsonl` is now generator+orientation-expanded, so the WBT
    oracle (`dump-lb-expectations`) reflects generators too — closing the bake-vs-oracle blindness (D1).
- **2026-06-26 — Step 6 (oracle half): interior-complete oracle SHIPPED.**
  `dump-lb-expectations.interior` now emits per-cell `cells[]` with `portals[]`
  (otherCellId+polygonId) and `stabs[]` (id+xyz) via `GetDungeonInfo` reuse
  (`JsonCommandProcessor.cs` CmdDumpLbExpectations). Verified `0x00B4`: 2160 cells, 1766 stabs,
  npcs=1315 (oracle now reflects generator-expanded roster → closes D1 oracle blindness). This is
  the DAT-side independent ground truth the render-vs-oracle verify will diff against. Remaining
  for Step 6: the headless render-walk + ACE-DB-truth comparison + classified matrix.json.
- **2026-06-26 — Fix 3 (world event bake): SHIPPED + LIVE.** `event-bake` (prebuilt binary,
  current) over the 40,197 content LBs (`--landblocks @<scenery-derived list>`) → 244,674 events
  (ambient 194,406 + particle 50,155 + sky 82 + anim_sound 31). **~35s local single-thread** — the
  buildbox/`--parallel` were NOT needed (the ~15s DAT pre-flight dominates; per-LB bake is
  sub-ms). Swapped into `dist/events` (40,197 files, was 169-ring/340); rollback
  `events.bak-169ring-2026-06-26`; `_health.json` updated. NB: `anim_sound≈0` is the
  known-deferred AnimationHook channel (F.B.5 wcid→MotionTableDataId staging), same as the ring
  era — a separate workstream, not a regression.
- **2026-06-26 — Fix 4 (depth-clear) RE-SCOPED (correction).** Code-read of
  `atmosphere_pipeline.js:394-415` shows the depth-clear disable was a *reasoned* switch to
  single-shared-depth (more correct; the destructive clear was the Holtburg hack). Do NOT blindly
  re-enable. GPU-gated: validate on the 1070; targeted polygonOffset only if Z-fight observed.
- **2026-06-26 — Validation (1070 real-GPU + laptop software-GL/`__diag`): render pipeline HEALTHY.**
  Interiors load completely (cellContainers3d = oracle cellCount exactly: Holtburg 123, arena
  `0x00B4` 2160, Holtburg Dungeon `0x01F6` 429), 25k statics + 12 buildings + 49 town NPCs/portals,
  near-zero MeshBasicMaterial, zero console errors. **Refutes** "interior walls missing", barren,
  and white-box. Two independent renderers agree. See `docs/eyetest-genfix-2026-06-26/FINDINGS.md`.
- **2026-06-26 — Render-polish assessment (after validation): mostly NO-ACTION ("if it's not broke…").**
  - **Fix 4 (depth-clear):** NO ACTION. Single-shared-depth is the correct approach; no Z-fighting
    observed. Do not re-enable the destructive clear.
  - **Fix 5 (LRU):** NO ACTION. LRU-by-LB eviction is correct given AC's data model — interior
    EnvCells cannot reference other landblocks (gmriggs); multi-LB dungeons link via swirly-portal
    *teleports*, not contiguous cell traversal, so the old LB evicts correctly after the teleport.
    Within-LB dungeons (the common case) load fully (validation: 2160 / 429 cells resident).
  - **Fix 6 (cold-load shader freeze):** THE one real open render item — but NOT a safe blind edit.
    First composer render synchronously ANGLE-compiles the big terrain shader (~24s cold); **8
    surgical fixes already tried + reverted** (`2026-06-20-busted-world-load-freeze-handoff.md`);
    already mitigated for daily use (Chrome GPU cache → once-per-config). Real fix = a dedicated
    rendering-perf project (program-binary cache via custom `WebGLRenderer` plumbing — highest value;
    or shader-split with a first-paint pop), GPU-validation-required. Deferred to a scoped session.
  - white-box / barren (the original C1/C2 catastrophe fears): do NOT reproduce on this build — no
    action.
- **Net:** the per-landblock-faithful restoration is DONE and validated at the data+bake+render
  layers. The only remaining render work is the (pre-existing, mitigated) cold-load freeze, which is
  a standalone perf project — not part of restoring the lost world.

---

**Constants** (from MEMORY):
```bash
REPO=/home/wbterminal/WorldBuilder-ACME-Edition
WBT=$REPO/WorldBuilder.Terminal
DLL=$WBT/bin/Release/net8.0/WorldBuilder.Terminal.dll
RUN(){ DOTNET_ROLL_FORWARD=LatestMajor dotnet "$DLL" --stdin; }
DIST=/mnt/wbterminal2/holtburger-dist            # `dist` symlinks here; NOT git
HOLT=$REPO/external/holtburger
STAGER=$HOLT/scripts/world-completeness/stage-ring-spawns.py
ORIENTED=/home/wbterminal/projects/RetailSmoke/ace_spawn_records_oriented.jsonl   # 313,134 quats
BASEDATS=~/ac_base_dats                          # base DATs only (bake pre-flight)
```

> **Discipline:** base DATs only for bakes (reject `0x__FFxxxx`). Re-staging the world rewrites
> `$DIST/{spawns,events}` — back up the current dir first (the graveyard pattern is already in
> use: `spawns.bak-*`). Keep `spawns.bak-2026-06-17` (the only oriented snapshot) until Fix 2 ships.

---

## STEP 0 — Live baseline capture (DO THIS FIRST; it is the control)

Convert "code says it works / user says broken" into evidence. Capture the rendered scene at
three non-Holtburg spots on the **real GPU** (1070), per the MEMORY 1070 runbook. Use off-screen
headless; never `browser.close()` a live session.

```bash
# Pick targets (census, not ring):
#   (a) dense inland town  — e.g. Cragstone / Arwic (look up center LB via DerethMaps coords.json)
#   (b) a dungeon interior — e.g. 0x00B4 (94.6%-generator dungeon) via @teleloc into an interior cell
#   (c) combat area 0xAB94 (the white-box-monster site)
# On the 1070 (MODE3 on-box headless Playwright-chromium = real GPU via ANGLE):
ssh <user>@<gpu-box-ip> 'node C:\Temp\cloud-ab-1070.mjs'   # adapt target LB + teleport
# capture: window.__diag walk of cellsGroup/entitiesGroup/staticsGroup + a screenshot per site.
```
Also read the scene-graph (works even on the no-GPU laptop via SwiftShader + serve.py, scene
graph only):
```bash
$HOLT/scripts/serve.py    # :8765 ; open index.html?nullRender=1&renderOnDemand=1&netDrainHz=30
# in console: liveScene3d.{cellsGroup,entitiesGroup,staticsGroup}.children.length per target LB
```
**GATE 0:** you have, on disk, the pre-fix state of interiors/NPCs/portals at 3 non-Holtburg
sites (expected: barren / white-box / lifeless dungeons per the ledger). This is the A/B control.

---

## STEP 1 — Stage generator children + orientation for ALL landblocks (Fix 1 + Fix 2)

**1a. Code change (Fix 1)** — `WorldBuilder.Terminal/CommandEngine.SiteIngest.cs`,
`IngestAceSpawnsAsync` (~:243-286). Mirror `IngestAceEncountersAsync` (:306-313, :332-334):
fetch the generator dicts and pass them to `BuildFromAceLandblockInstances` at :268.
```csharp
// build childWeenieTypes alongside weenieDescriptors, then:
var generatorProfiles   = await connector.GetAllGeneratorProfilesAsync();
var generatorRadii      = await connector.GetGeneratorRadiiAsync();
var generatorMaxObjects = await connector.GetGeneratorMaxObjectsAsync();
var spawnsByLb = SpawnGazetteerBuilder.BuildFromAceLandblockInstances(
    rows, weenieDescriptors,
    generatorProfiles, generatorRadii, generatorMaxObjects, childWeenieTypes);
// delete the "Do NOT pass generator dicts here" comment.
```
Build WBT (single project — memory-safe): `DOTNET_ROLL_FORWARD=LatestMajor dotnet build $WBT -c Release`.

**1b. Re-dump + stage with orientation (Fix 2 folded in).** Connect ACE DB, re-run the
spawn ingest (now generator-expanding), then stage the **oriented** source world-wide:
```bash
printf '%s\n' \
 '{"command":"ace-db-connect","host":"127.0.0.1","database":"ace_world","user":"ace","password":"ace"}' \
 '{"command":"ace-db-ingest-spawns","out":"'"$ORIENTED"'"}' \
 | RUN
# (ensure the ingest writes qw/qx/qy/qz from landblock_instance.angles_*; the oriented file is the target)

cp -a $DIST/spawns $DIST/spawns.bak-pre-genfix-2026-06-26     # backup
python3 $STAGER --all-world --source "$ORIENTED" --out $DIST/spawns/
```
**GATE 1:** verify the gap is closed on the dungeon that proved it, plus Holtburg + orientation:
```bash
# 0x00B4 should now have ~810+ visible monsters (was 331 invisible anchors):
jq -c 'select(.weenieType!=1)' $DIST/spawns/0x00B4.spawns.jsonl | wc -l        # >> 0
echo '{"command":"dump-lb-expectations","lbX":169,"lbY":180}' | RUN | tail -1 \
 | jq '.counts.npcs'                                                            # 119 (was 106)
jq -c 'select(.qw!=null and (.qw!=1 or .qx!=0))' $DIST/spawns/0xA9B4.spawns.jsonl | head -1
                                                                               # non-identity quat present
```

---

## STEP 2 — World-bake events (Fix 3)

`event-bake` currently covers only the 169-ring (`$DIST/events` = 340 files). Bake the world.
Needs the `--parallel N` flag (proposed in `ring-expansion-method.md` §6; ~50 LOC) to use the
buildbox cores — add it if absent.
```bash
cp -a $DIST/events $DIST/events.bak-169ring-2026-06-26
export PATH=$HOME/.cargo/bin:$PATH
cargo run -p holtburger-tools --release --bin event-bake -- \
  --dat-dir $BASEDATS \
  --landblocks 0x0000..0xFFFF \
  --spawns-dir $DIST/spawns/ \
  --setup-table-path $DIST/spawns/wcid_to_setup.json \
  --out $DIST/events/ --sky --parallel 16
```
**GATE 2:** `ls $DIST/events/*.events.jsonl | wc -l` ≈ tens of thousands (was 170); a sampled
non-ring town LB has ambient + anim-hook events; `event-bake-source.sha256` matches base DATs.

---

## STEP 3 — Restore conditional depth-clear + dungeon-aware LRU (Fix 4 + Fix 5)

**3a. Depth-clear (Fix 4 — RE-SCOPED, GPU-gated)** — do NOT blindly re-enable the depth-clear.
The current single-shared-depth pass (`atmosphere_pipeline.js:394-415`) is a reasoned,
more-correct replacement for the destructive Phase-5 clear (re-enabling it re-introduces the
Holtburg see-through). On the 1070, verify interiors render correctly under single-shared-depth;
add a **targeted `polygonOffset` on the cell floor** ONLY if cottage-floor Z-fighting is observed.
```bash
capped-build wasm-pack build --target web --out-dir pkg --release   # only if wasm side touched
# laptop scene-graph + 1070 eye-test: indoor cottage floor wins; outdoor render byte-identical.
```
**3b. LRU (Fix 5, confirm first)** — `landblock_lru.js:260-271`: do not evict an EnvCell
container while reachable in `cell_portal_graph` / while the player is inside a multi-LB dungeon;
or raise `lbCap`. Confirm on a real multi-LB dungeon before changing policy.

**GATE 3:** off-trace byte-identical for the outdoor case (extend the existing off-trace harness);
a cottage interior renders its floor over terrain when indoors; a multi-LB dungeon keeps all its
cells while traversed.

---

## STEP 4 — Land + prove the June render regressions (Fix 6 = C1 + C2)

```bash
git -C $REPO log --oneline 5957fd55 -1     # barren-poison fix — confirm present + effective
```
- **C1 barren-poison:** confirm a baker throw no longer permanently strips an LB (re-bake
  recovers). Fix the ~24 s cold-load shader-compile freeze (async/pre-warm) so entity spawns
  aren't starved — this is the cause of intermittent "scene graph full but render empty."
- **C2 white-box / particle:** resolve the luminous flat-emissive material (white-box monsters)
  and the "effect enqueued for not-yet-spawned guid" portal-glow/particle attach
  (`docs/.../2026-06-20-white-box-monsters-particle-effects-handoff.md` — settle the PENDING
  DECISION first; intersects the Phase-4 visual-suite bake migration).

**GATE 4:** 1070 capture at `0xAB94`: monsters render with real materials (no white boxes),
portals show their swirly glow, no permanent-barren LBs after a forced boot-load throw.

---

## STEP 5 — Prove player-centered streaming live (Fix 7 / B1)

`d5dda216` is shipped + default-on; validate it away from Holtburg.
```bash
# 1070, roam a DENSE inland town + wilderness:
#   default (pvsRingRadius=5) → filled horizon ~960 m
#   ?pvsRingRadius=1          → old barren 3×3 control
# watch frame-time; if it stutters, dial radius or ?agentic=low.
```
**GATE 5:** dense inland LB fills to ~960 m and matches retail density; A/B vs `pvsRingRadius=1`
shows the difference.

---

## STEP 6 — Build the new independent-truth, interior-complete verify (§7 of the method)

Replace the interior-blind/self-consistent verify. Compare **render** vs **two independent
truths** (DAT + ACE-DB-with-generators). Build over a **census cohort** (towns + dungeons +
wilderness + coast), not a ring.

**6a. Extend the oracle** — add `stabs[]` + `portals[]` to `dump-lb-expectations.interior`
(data already available via `get-dungeon-info` / DungeonDocument; JsonCommandProcessor.cs:2206).

**6b. New verify** (extend `verify-sweep.mjs` / `validate_landblock_completeness.cjs`):
- DAT truth: `get-dungeon-info <lb>` → per-cell stabs + portals + cell list;
  `fetch_landblock_objects` → outdoor statics/buildings; `fetch_landblock_scenery` → scenery.
- ACE-DB truth: `landblock_instance` **with `ExpandGeneratorChildren`** (the Fix-1 code) → full
  roster + orientation, per cell.
- Render truth: `__diag` walk of `staticsGroup` / `buildingsGroup` / `cellsGroup` (per-cell stabs)
  / `entitiesGroup` (per-cell spawns).
- Checks: outdoor placements ≡ DAT; **interior structure** (cell + stabs + portals) ≡ DAT;
  **interior+outdoor entities** ≡ ACE-DB (incl. portals + orientation tolerance); visibility
  (`getRenderSetWithPView ⊆ DAT VisibleCells`; SeenOutside cottages render from town square);
  render-health (no material/anim/mesh errors, no white-box, no orphan effects).

```bash
# example cohort selection (census, not ring): towns + N dungeons + wilderness + coast samples.
# run on the buildbox fleet; emit a per-LB PASS/DRIFT matrix.json with classified DRIFT.
```
**GATE 6:** `matrix.json` exists for the cohort and is green; DRIFT (if any) classified as
missing-stab / missing-portal / missing-entity / missing-generator-child / wrong-orientation /
cell-not-visible / render-error — each actionable.

---

## STEP 7 — Re-capture the Step-0 baseline + diff

Re-run STEP 0 at the same three sites. Diff against the pre-fix capture.
**FINAL GATE (= §9 acceptance):** interiors full of **walls + furniture (stabs)** + **oriented
NPCs + monsters** + **working portals**; dense wilderness/town horizons filled; no white-box /
barren / lifeless-dungeon symptoms; the per-LB matrix green; no Holtburg special-casing in
load/visibility/verify.

---

## Buildbox note

Per the MEMORY buildbox runbook: `gcloud compute instances start buildbox --zone us-central1-a`;
`git fetch origin && git reset --hard origin/master`; run the heavy bakes/verify there
(`scenery-bake`/`event-bake` need `--parallel N`); `setsid nohup ./driver.sh …`; gated poweroff
after the tarball + push succeed. The laptop drives the 1070 eye-tests + scene-graph reads.

## Quick reference — the proof points

| Regression | One-line proof it's fixed |
|---|---|
| A1 generators | `jq -c 'select(.weenieType!=1)' $DIST/spawns/0x00B4.spawns.jsonl | wc -l` >> 0 |
| A2 orientation | `0xA9B4.spawns.jsonl` records carry non-identity `qw/qx/qy/qz` |
| A3 events | `ls $DIST/events/*.events.jsonl | wc -l` ≫ 170 |
| B1 streaming | dense inland LB fills to ~960 m (A/B vs `pvsRingRadius=1`) |
| B2 depth-clear | RE-SCOPED: validate single-shared-depth on GPU; targeted polygonOffset only if Z-fight |
| C2 white-box | `0xAB94` monsters render with real materials + portal glow |
| D1 verify | a classified per-LB `matrix.json` exists + green over a census cohort |
