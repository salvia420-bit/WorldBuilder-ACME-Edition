# HANDOFF — holtburger-web perf: buildings-batching SHIPPED + statics atlas-starvation lead

**Date:** 2026-07-14 · **Box:** wbterminal laptop → 1070 GPU (tailscale) · **Self-contained.**
Continues `HANDOFF-perf-next-fps-levers-2026-07-14.md` (L2 steady-frame). Reads on top of
`RESULTS-taskL2-steadyframe-2026-07-14.md`. REPO=`/home/wbterminal/WorldBuilder-ACME-Edition`,
HOLT=`$REPO/external/holtburger/apps/holtburger-web`, net-review=`$REPO/external/holtburger/scripts/net-review`.

---
## 0. TL;DR — where we are
The steady in-town frame is **draw-call bound** (~73-81% of CPU is three.js render submission;
`getParameters` is per-draw structural at ~24-32%, NOT fixable churn). The lever is **fewer draws**.
- **SHIPPED (master `27319804`):** `?buildingBatch` **default-ON** — feeds static building surfaces
  into the cross-LB static atlas. Buildings never articulate in 3D (door path retired 2026-06-18;
  doors are entities), so all building surfaces are static/batchable. Validated: 62-town walk clean
  (0 errors/crashes), churn-neutral settle A/B, renders correctly.
- **DIAGNOSED, NOT FIXED (the next lever):** ~1000 static singletons draw individually at a town.
  It is **NOT** atlas capacity — the atlas is **STARVED OF INPUT**. Root cause is in the statics
  bake→atlas routing, almost certainly the **bake-worker** path. This is the open lead below (§2).
- **Diagnostics landed** via PR (master `092785f4`): `window.__atlasStats()`, spin-averaged
  draw-call probe, statics exclusion census, `spin-verify.mjs`.

## 1. HARD-WON MEASUREMENT RULES (do not relearn these)
- **Facing does NOT change draws.** FCULL culls by *distance*, not view direction. Proven:
  `spin-verify.mjs` rotated the player 280° → draw delta ~4. `setMovementInput(0,0,1,false)` rotates
  in place (no translation); `getLocalPlayerPose().heading` confirms. Yaw-spin averaging is built into
  `steadyframe-sizing.mjs` but it only cancels yaw.
- **Camera MODE does change draws — CONTROL IT.** The `c` key cycles camera modes (top-down /
  distant third-person); distant/top-down modes pull far more landblocks into the distance cull →
  many more draws. This is a real, uncontrolled variable. Before comparing draw counts, pin the
  camera mode (and ideally distance/pitch). Watch `renderer.info.render.calls` while pressing `c`.
- **`renderer.info.autoReset` defaults TRUE** → `.render.calls`/`.triangles` read as ~1 (garbage).
  Set `autoReset=false`, read cumulative, diff ÷ frames. (Already handled in the probe.)
- **Draw counts swing 279↔1850 at the SAME POI** run-to-run. Two causes now understood: (a) camera
  mode (above), (b) atlas-consumption/residency state (how many singletons the atlas has batched at
  measure time — "entRoots-steady" is NOT "atlas-consumption-complete"). Any single absolute draw
  number is unreliable; compare only same-camera-mode + same-consumption-state, or measure structure
  (scene-graph counts) not draws.
- **`vfxGauge.tCpuMs` is per-frame instantaneous**, not an average — sample many frames + median.
- **1070 is the only real-GPU path.** SwiftShader (laptop) = geometry counts only, no fps/upload.
- **`?nosw=1` mandatory** on every dev URL. serve.py runs `--allow-missing` → 404s in console are
  expected partial-world noise, NOT errors (filter them; look for PAGEERROR/TypeError only).

## 2. ⭐ THE OPEN LEAD — statics atlas-starvation (the real draw lever)
**Ground truth (instrumented, `window.__atlasStats()`, Cragstone steady):**
- `atlased≈397  nodesIn≈504  ptLayerFull=0  atlasBakedLbs≈49`  · buckets=21, **full=0** (biggest
  128×128 at 36/256 layers) → **capacity is NOT the limit; the atlas is starved of input.**
- Meanwhile **~1000-1066 individual eligible statics** in `staticsGroup` (all unique geom+mat → 0
  instanceable, but BatchedMesh-able), and only **49 of ~121 resident LBs** ever feed the atlas.
- Caveat: `nodesIn` includes BUILDINGS now (`?buildingBatch` also calls `addSingletonsToCrossLbAtlas`).
  Re-run with `EXTRA_QUERY="buildingBatch=off"` to isolate the statics contribution.

**Why my first fix attempt failed (don't repeat it):** I added routing counters to
`statics.js` `bakeStaticsForLandblock` (~line 2210, the `for … staticsGroup.add(node)`) and
`bakeStaticsRing` (~line 2790, `ringSingletons.push`). At census they were **ALL ZERO** while
1059 individual statics existed and the atlas was fed. Conclusion: **the bake runs in the bake
worker**, which imports its OWN instance of the scene3d modules — my main-thread `_route` counters
and `window.__staticsRoute` never saw the worker's increments. (`window.__staticsRoute` existed →
module loaded on main; counters 0 → the code ran in the worker instance.) The revert is done; tree clean.

**NEXT STEP (scoped):** find where **main thread** receives worker-baked statics and adds them to
`staticsGroup`, and why those adds bypass `addSingletonsToCrossLbAtlas`.
- Start: `rg -n 'bake_worker|BakeWorkerClient|postMessage|onmessage|staticsGroup\.add' HOLT/scene3d/bake_worker_client.js HOLT/scene3d/statics.js` — trace the worker→main handoff for statics.
- The three routing systems (all default-on, all in `statics.js`): `?staticBatch` (per-LB,
  `consolidateStaticSingletons`, ≥2-per-material), `?statBatchChunk` (cross-LB,
  `consolidateStaticSingletonsCrossLb`), `?statAtlas` (`addSingletonsToCrossLbAtlas`). A lone-per-
  material singleton misses the ≥2 gates and *should* fall to `?statAtlas` — but only 49/121 LBs
  get there. Suspect: the `!hasAtlasLb(lbKey)` guard (`statics.js:2186`) skips re-baked LBs, and/or
  the worker-path add site doesn't call the atlas feed at all.
- **Instrument in the WORKER instance** (or wherever `staticsGroup.add` actually runs on main),
  not the main-thread copy. Confirm with a non-zero counter before trusting it.
- Fix pattern to mirror: `buildingBatch` (`buildings.js` `_feedBuildingGroupsToAtlas`) — flatten to
  staticsGroup-relative transform, stamp `userData.landblockId`, feed `addSingletonsToCrossLbAtlas`,
  passthrough → group. Ship behind a default-off flag; validate draw drop (same camera mode!) +
  62-town walk before flipping.
- Expected prize: ~1000 individual draws → a handful of bucket draws. Biggest lever found.

## 3. LEVERS ALREADY REFUTED/SIZED (don't rebuild)
- **Entity instancing (original handoff L1): ~0 town payoff.** 699 entity meshes, 0 collapsible by
  guid, 96 by wcid — towns are ~all unique NPCs. Content-only (monster fields). Dead for towns.
- **`getParameters` "churn": not churn.** Light-count churn=0; it's per-draw structural → shrinks
  only with fewer draws. Falls out for free once draw count drops.
- **Static `matrixWorldAutoUpdate=false`: ~1.4ms/frame** (measured Δ, sometimes noise). Tiny, cheap
  bolt-on; not a priority.
- **Atlas layer capacity (256/bucket): NOT the limit** (buckets near-empty). Do not raise it.

## 4. HARNESS (net-review/) — all committed on master
- `steadyframe-sizing.mjs` — the workhorse. `CENSUS_ONLY=1` (fast: spin-avg draws + statics
  exclusion census + `atlasStats` + screenshot + console errors). `EXTRA_QUERY="flag=on"` to toggle
  flags. Full mode adds CPU profile + matrix A/B. Spin-averages yaw (add camera-mode control next).
- `steadyframe-profile.mjs` — standalone CDP CPU profile (self-time by function).
- `spin-verify.mjs` — proves headless rotation works.
- `window.__atlasStats()` (static_atlas.js) — passthrough-reason counters + per-bucket fullness.
- 1070 bring-up: muted off-screen chrome via `schtasks /run` on `C:\Temp\launch-wls-sf.bat`
  (`--mute-audio`, `--user-data-dir=C:\Temp\cdpwb-wls`, `--window-position=-32000,-32000`); tunnels
  `-L 9333 -R 8765` to `young@100.127.215.75`. Cleanup: kill by `cdpwb-wls` cmdline match ONLY
  (PowerShell `Get-CimInstance Win32_Process | ? CommandLine -like '*cdpwb-wls*'`), NEVER
  `taskkill /IM chrome.exe`. `?buildingBatch` etc default-on so no flag needed for the shipped state.
- Raw data: `/mnt/wbterminal2/tmp/steadyframe-*.json`, `atlas-instr-cragstone.json`,
  `spin-on.json`, `steadyframe-val-bldbatch-{on,off}.json`, screenshots `*.png`.

## 5. OPS / GIT
- **Direct push to `origin/master` is BLOCKED server-side** (`remote: fatal error in commit_refs`) —
  appeared after the buildings push (`27319804`) succeeded, so a branch protection / push ruleset was
  likely enabled on the default branch. **Workaround that works: push a branch, open a PR, merge via
  GitHub** (PR #53 merged this way → `092785f4`). Investigate the repo's master ruleset to restore
  direct push, or keep using PRs.
- master timeline: `27319804` buildingBatch default-ON · `092785f4` perf diagnostics.
- **This handoff is UNCOMMITTED** — add it to the next PR (master direct-push blocked).

## 6. Quick-start for the next session
```
# bring up 1070 (see §4), then:
cd $REPO/external/holtburger/scripts/net-review
CENSUS_ONLY=1 EXTRA_QUERY="buildingBatch=off" POI=Cragstone node steadyframe-sizing.mjs /mnt/wbterminal2/tmp/statics-only.json
# read atlasStats (nodesIn/atlased/atlasBakedLbs) + staticsCollapse (individual/eligible).
# then trace bake_worker_client.js → statics worker→main add path (§2).
```
