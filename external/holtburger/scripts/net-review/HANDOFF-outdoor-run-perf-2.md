# HANDOFF — holtburger-web outdoor-run perf (continuation)

**Date:** 2026-07-14 · **Box:** wbterminal laptop (drives the 1070 GPU box over tailscale)
**Predecessor:** `/mnt/wbterminal2/tmp/HANDOFF-outdoor-run-perf.md` (the original 19-task plan) +
`/mnt/wbterminal2/tmp/AUDIT-task1-residency-eviction.md` (the audit). This doc supersedes them for
the *remaining* work. Self-contained — you do NOT need the originating conversation.

REPO = `/home/wbterminal/WorldBuilder-ACME-Edition` (single git repo, branch `master`; holtburger is a
plain subdir, NOT a submodule). HOLT = `$REPO/external/holtburger/apps/holtburger-web`.

---
## 0. TL;DR — what this session shipped & validated
A 19-task plan attacked a residency/eviction failure in holtburger-web's continuous-traversal path
(GPU geometry grew unbounded, a 22.6 s bulk-dispose stall, fps collapse). This session landed and
**1070-validated** the JS-only eviction fixes + the harness tooling. The **decode was already
memoized** (the audit's key correction), so the remaining big lever is GPU-geometry sharing (#4) and
bringing **untracked** entity/atlas geometry under budget (#11) — now the dominant heap bottleneck.

### DONE (committed this session)
- **#1 audit** — see AUDIT doc. Correction: `src/lib.rs:7949 MODEL_TRI_CACHE` already memoizes CPU
  triangulation cross-LB (64 MiB). So +2.5k geoms/POI is duplicate GPU `BufferGeometry`, not re-decode.
- **#6/#7/#8/#10 eviction cluster** (all in `scene3d/landblock_lru.js`, JS-only, live-on-reload):
  live-geometry governor on `renderer.info.memory.geometries` (`MAX_LIVE_GEOM` default **8000**,
  `?maxLiveGeom=N|off`); pool budget 256→160 MB (`?warmParkBudgetMb`); time-budgeted dispose
  (`?parkDisposeBudgetMs` default 6 ms, replaces flat 2/tick); one bucketed group-scan per tick; pool
  pressure now runs EVERY tick (pre-fix early-return skipped it under the count cap); the governor is a
  hard ceiling that bypasses the 30 s UseTime floor; eviction is oldest-first (protects visible content).
- **#9 verify** (partial): 1070 A/B (gov-off vs cap=8000, 8 towns continuous) — **stall eliminated**
  (OFF had a 34,106 ms freeze + 4541/2866 ms mid-run; ON's only >1 s frames were the first-POI cold
  shader), **fps 1.4-2.4× late-run** (Rithwic 13→32), resident LBs 200→35, 0 errors. **Eye-test passed**
  (Yaraq lru=45 renders complete distant terrain/ocean/scenery). **Heap only ~13% lower** → #11.
- **#15/#16/#17/#18 tooling** (`scripts/net-review/`): per-run samples filename
  `<label>-samples-<UTC>-<pid>.jsonl` (resume reuses via `summary.samplesPath`); per-POI `--out` flush
  + SIGINT/SIGTERM finalize (killed driver stays resumable); `--maxStops` default 3 + `--maxHeapMB`
  heap-adaptive recycle; wrapper→v3; README-outdoor-run.md documents the full cdp recipe incl. the
  critical `-R 8080` tunnel.

### Tests (all green)
`node test_landblock_lru_geom_governor.mjs` (21/21, incl. floor-bypass regression) + the 5 existing
`test_landblock_lru_*.mjs` (98/98, no regression). `node --check` on the driver.

---
## 1. REMAINING TASK LIST — recreate these in the task system (TaskCreate) and wire the deps
Dependency-ordered; keep the original IDs for continuity. **The whole task list is session-local — it
does NOT persist across `/clear`, so recreate it at the start of your session** exactly as below, then
work it. (This session recreated the full 19 from the original handoff the same way.)

**Biggest lever — GPU geometry sharing (blocked on a measurement first)**
- **#2 [measure]** Quantify the memo hit-rate + per-model GPU-geometry duplication factor on a live
  1070 slice (expect HIGH memo hits → low re-decode → #3 is small; the win is #4). *blockedBy: none now*
- **#3** Extend `src/lib.rs` `MODEL_TRI_CACHE` with a refcount (and optionally return packed mesh bytes)
  so a shared GPU geometry frees at refcount 0. Gate scope on #2. *blockedBy: 2*  (needs wasm rebuild)
- **#4 [TOP LEVER]** Share one `THREE.BufferGeometry` per model DID across placements/LBs in
  `scene3d/cells.js` (currently `new BufferGeometry()` per placement — cells.js:301/849 → N LBs = N
  geometries). Wire refcount into `landblockLru.track()/dispose()` (mirror the InstancedMesh
  `coversLbKeys` refcount at landblock_lru.js:957). *blockedBy: 3*
- **#5** Rebuild wasm --release + verify geometry growth flattens on a battery slice. *blockedBy: 4*

**Heap bound — the #9 heap-plateau target lives here (NOW the top heap bottleneck)**
- **#11 [heap]** Bring UNTRACKED resources under budget: entities (creature/NPC/item meshes — not LRU-
  tracked; `reapStaleEntities` is grace-gated) and `scene3d/static_atlas.js` BatchedMeshes (grow-never-
  shrink, static_atlas.js:334). The 1070 A/B showed `ri.geometries` floors ~19844 from these, so the
  geom governor can't plateau heap alone. *blockedBy: 1,4*

**Program-cache warm-up — kills the residual first-POI hitch**
- **#12** `compileAsync`-prewarm ~125 programs at boot (respect vfx firewall: no per-instance
  `customProgramCacheKey`). ON's only >1 s frames were this ~2.9 s cold-shader compile. *blockedBy: 1*
- **#13** Verify first-POI cold hitch gone. *blockedBy: 12*

**Telemetry**
- **#14** Wire LOD bandHits/bandMisses: they ARE incremented (diag/lod.js:76,89) but `onBandHit/
  onBandMiss` are never CALLED — emit them at the LOD band-selection site. *blockedBy: 1*

**Validation**
- **#19** Full post-fix battery + A/B vs the two baseline datasets; quantify each lever's payoff.
  *blockedBy: 5,11,13,14*

DONE (do not recreate as pending): #1, #6, #7, #8, #9(partial), #10, #15, #16, #17, #18.

---
## 2. Key findings / corrections carried forward
- **Decode already cached** (`MODEL_TRI_CACHE`) → #4 (GPU geometry share), not #3, is the lever.
- **Untracked geometry is the heap floor**: a single textured town is only ~434 `ri.geometries`
  (statics are instanced/atlased); the 48k runaway is per-LB terrain + accumulating **entities/atlas**
  the LRU doesn't own. The geom governor bounds the RESIDENT set (200→35 LBs) and killed the stall, but
  heap needs #11.
- **`ri.geometries` == `liveGeom`** (the governor's signal); it responds to dispose, not to park.
- **Governor default 8000 is safe**: one-area play stays ≪8000 (won't engage); only touring engages it;
  oldest-first eviction protects visible content (eye-test confirmed). `?maxLiveGeom=N|off` to tune.
- Residual first-POI ~2.9 s hitch = cold shader (#12), NOT eviction.

---
## 3. How to run / validate (hard-won recipe)
### 3a. Local stack (all were up this session; verify)
ACE `ss -ulpn | grep :900`; serve.py `:8765` (serves LIVE JS tree — JS edits need only `?nosw=1`, no
build; wasm needs `pkg/` prebuilt); ws-bridge `:8080`. JS-only changes are live on reload.

### 3b. 1070 real-GPU cdp (the authoritative arm) — full recipe in
`$REPO/external/holtburger/scripts/net-review/README-outdoor-run.md` (§"1070 CDP full setup"). Summary:
1. On the 1070 (`young@100.127.215.75`): `schtasks /create /tn cdpwb /tr C:\Temp\launch-wls.bat /sc once
   /st 00:00 /it /f && schtasks /run /tn cdpwb` (the bat + off-screen GPU Chrome already exist). Assert
   `UNMASKED_RENDERER` contains `GTX 1070 ... Direct3D11`.
2. Tunnels from laptop (detached): `ssh -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@…` and
   `ssh -fN -R 8080:127.0.0.1:8080 young@…`. ⚠ **`-R 8080` is REQUIRED** (else `ws handshake failed`).
3. Battery: `node battery-outdoor-run.mjs --mode cdp --cdp http://127.0.0.1:9333 --plans
   outdoor-run-plans.json --pois <subset> --runS N --maxStops 0 --label X --query "maxLiveGeom=..."
   --out X.json --samplesOut /mnt/wbterminal2/tmp [--shots dir]`.
### 3c. Account coordination (cost hours if ignored)
Single-login `tailnet1`. **Wait for ACE `[LOGOUT] Account tailnet1 exited` (after the last `[LOGIN]`)
before each re-login** — grep `$ACERT/ACE_Log.txt`. The cdp driver closes its page on exit (releases
the account); a `kill -9` skips that → close the 1070 page via CDP. `battery-outdoor-run-wrapper.sh`
automates the wait+recycle. A/B arms MUST be sequential (see `/mnt/wbterminal2/tmp/ab-runner.sh`).
### 3d. Laptop headless dev-loop (fast, no 1070)
`/tmp/.../scratchpad/governor-probe.mjs <cap|default> <poi> <runS>` — SwiftShader; use
`nullRender=0&nosw=1&wireframe=1` (nullRender=0 REQUIRED so render() populates `ri.geometries`). Good
for correctness + geometry/heap bounding; NOT fps.

### 3e. Analysis
`python3 /mnt/wbterminal2/tmp/ab-analyze.py` (reads gov-off.json/gov-on.json + their samples). Per-POI
trajectory recompute snippet in the original HANDOFF §4d.

---
## 4. Code map (re-verify line numbers — they drift)
- **Governor:** `scene3d/landblock_lru.js` — `MAX_LIVE_GEOM`/`PARK_DISPOSE_BUDGET_MS`/
  `GEOM_PRESSURE_PARK_PER_TICK` consts (~132-180); `_liveGeometries()`; `tickEviction` geom-pressure
  tail (~712-763); `_tickParkPoolPressure` floor-bypass + time budget (~795-835); `getStats` (governor
  fields). Per-frame driver: `scene3d/index.js:2133`.
- **Geometry share (#4):** `scene3d/cells.js:301,849` (`new BufferGeometry` per placement);
  fetch path `fetch_model_meshes→triangulate_model→pack_model_mesh`.
- **Rust memo (#3):** `apps/holtburger-web/src/lib.rs:7949` `MODEL_TRI_CACHE` (64 MiB `ByteBudgetLru`).
- **Untracked (#11):** `scene3d/static_atlas.js:303,334` (BatchedMesh grow-never-shrink); entities
  `scene3d/entities.js` (`reapStaleEntities`).
- **Program prewarm (#12):** `scene3d/static_atlas.js:130` shared `customProgramCacheKey`; use
  `renderer.compileAsync`.
- **LOD telemetry (#14):** `scene3d/diag/lod.js:73-94` (`onBandHit/onBandMiss` defined, never called).
- **Harness:** `scripts/net-review/battery-outdoor-run.mjs` (+wrapper, README-outdoor-run.md).
- **New test:** `apps/holtburger-web/test_landblock_lru_geom_governor.mjs`.

## 5. Artifacts (persistent, /mnt/wbterminal2/tmp/)
`AUDIT-task1-residency-eviction.md` · `gov-off.json`/`gov-on.json` + their `*-samples-*.jsonl` ·
`shots-gov8000/` (eye-test shots) · `ab-analyze.py` · `ab-runner.sh` · `governor-probe.mjs` (scratchpad).

## 6. Guiding principles (unchanged)
Systems work in Rust/wasm not JS · target retail residency · validated fixes ship default-on with
`?flag=off` (bar: loads+spawns+0 errors) · never edit vanilla ACE (`~/ace-server`) · verify agent leads
(they hallucinate file:line) · ship-RELEASE wasm before measuring · `?nosw=1` on every dev URL.
