# HANDOFF — holtburger-web outdoor-run perf work

**Date:** 2026-07-14 · **Box:** wbterminal laptop (drives the 1070 GPU box over tailscale)
**Purpose:** implement the client perf improvements identified from a 47-POI sustained-RUN
stress battery run on the 1070 (real GPU). This doc is self-contained — you do NOT need the
originating conversation.

---
## 0. TL;DR
A 5-min-RUN-per-POI battery (`battery-outdoor-run.mjs`) was run across all 47 usable outdoor
POIs on the 1070 real GPU. It exposed a **residency/eviction failure in the continuous-traversal
path**: three.js GPU resources grow unbounded, eviction fires far too late and then all at once
(a 22.6 s bulk-dispose stall), and fps collapses from ~30 → <1 by ~POI 13. Full analysis below.
A 19-item task list (§5) implements the fixes. **Start at task #1 (audit).**

---
## 1. Artifacts (all persistent, on the laptop under `/mnt/wbterminal2/tmp/`)
| File | What |
|------|------|
| `outdoor-1070.json` | Final battery results — 50 POIs (47 run + 3 skip). Rows 1-14 (arm A) reconstructed from log; rows 15-47 (arm B) native. |
| `1070-samples.continuous.jsonl` | 2 s perf samples, **arm A** = continuous single-session run (the collapse curve). ~1852 samples. |
| `1070-samples.jsonl` | 2 s perf samples, **arm B** = recycling run (5 POIs/session). NOTE: arm A's samples are ALSO prepended here (append bug — task #15). Use `.continuous.jsonl` for the clean arm-A set. |
| `outdoor-1070-shots/` | 47 per-POI screenshots (real-GPU textured). |
| `outdoor-1070-wrapper.log` / `…continuous.log` | Per-POI summary lines + recycle events. |
| `outdoor-run-wrapper.sh` | The recycling wrapper (v2) — account-free-wait + maxStops. Reusable. |
| `diag-boot.mjs` | Standalone playwright boot-diagnostic (connect CDP, dump console + bootState + GPU). |

Sample schema (one JSON obj/line): `t, boot, heapMB, frame{n,meanMs,p50,p95,max,fps},
ri{cumCalls,cumTris,programs,geometries,textures}, mesh{total,visChain}, wire{...byCategory},
pvsVis, lod{loaded,cached,failures,bandHits,bandMisses,spawnAttempts,spawnSubstitutions},
pose{lb,x,y,z,heading,ground}, ltLen, terr, stat, cells, lru, parked, parkedTotal,
unparkedTotal, evicted, work, phase, poi`.

---
## 2. Findings from the data (the evidence behind the tasks)
1. **GPU resources accumulate unbounded.** `ri.geometries` 6.5k → 48.6k over 15 POIs (~+2.5k/POI);
   textures 1.1k → 13.2k; programs bounded ~75-125. Fresh page resets geoms → ~100-500, so it's
   retained scene resources, not fixed cost.
2. **LRU caps the wrong thing.** `lru` pinned ~200 (a landblock/container count) the whole run while
   geometries hit 48k. The byte-budget only bites near ~4.9 GB heap.
3. **Eviction fires late then all at once.** `evicted` = 0 until heap ≈4.9 GB (POI 8); 0 for the
   ENTIRE recycling arm. The single worst frame — **Cragstone 22,599 ms** — coincides with a one-window
   dispose of **−34,651 geometries / −16,907 textures**. `landblock_lru.js` comments confirm the
   non-pressure dispose paths (evict-on-teleport whole-LB invalidation, flushParked, dispose()) are
   explicitly NOT amortized → synchronous bulk dispose = the stall.
4. **Perf correlates** (recycling run, n=6356): fps vs `mesh.total` r=−0.51 (strongest), vs `heapMB`
   −0.47, vs `geometries` −0.37.
5. **Dead telemetry:** `lod.bandHits`/`bandMisses` always 0 (increment path broken). `spawnSubstitutions`
   peaks 820. `lod.failures` = 0 (decode healthy). First POI/session eats ~3.6 s cold-shader hitch.
6. **Within recycling sessions, POI 4-5 already degrade** (Timaru: 32k geoms → 2.4 fps) — maxStops=5 too high.

### Baseline numbers to beat (targets for task #19)
| Metric | Continuous (arm A) | Recycling (arm B) | Target after fixes |
|---|---|---|---|
| fps mean/median | 15.2 / 16.1 | 23.9 / 24.0 | flat vs POI count |
| fps min | 0.62 (Fiun) | 9.7 (Timaru) | no collapse |
| worst frame max | 22,599 ms | 3,316 ms | **< 1 s** |
| heap end median/max | 4487 / 7055 MB | 2704 / 4583 MB | bounded ~2 GB |
| ri.geometries slope | +2.5k/POI | +2.5k/POI (resets) | ~flat after warm |

---
## 3. Code map (verified file locations — re-verify line numbers, they drift)
REPO = `/home/wbterminal/WorldBuilder-ACME-Edition`
HOLT = `$REPO/external/holtburger/apps/holtburger-web`
- **Eviction/park/LRU:** `$HOLT/scene3d/landblock_lru.js` — byte-budget warm-park pool, `WARM_PARK_MAX_DISPOSE_PER_TICK=2`, ~30 s UseTime floor, `track()/park()/unpark()/dispose()/flushParked`, `getStats()` (emits parkedTotal/unparkedTotal/evicted/resident). Read the header comments (Phase 9a, S15a, R-12) first.
- **Geometry creation + dispose registration + program prewarm:** `$HOLT/scene3d/cells.js` (hands BufferGeometry/material/texture to `landblockLru.track()`; uses `renderer.compileAsync` per-subtree).
- **Town statics + shared program:** `$HOLT/scene3d/static_atlas.js` (`customProgramCacheKey = "statAtlasArrayMatV2"`).
- **wasm decode path (refcount target):** `$HOLT/src/lib.rs` — `fetch_model_meshes → triangulate_model → pack_model_mesh`, plus the existing thread_local triangulation memo. (⚠ the wasm crate is `apps/holtburger-web/` itself, NOT `crates/holtburger-web/` — that path is a hallucination.)
- **LOD telemetry:** `$HOLT/scene3d/diag/lod.js` (bandHits/bandMisses defined + emitted but never incremented in practice).
- **Debug overlay (reads lruStats):** `$HOLT/plugins/debug-overlay.js:227,239-240`.
- **Battery driver:** `$REPO/external/holtburger/scripts/net-review/battery-outdoor-run.mjs` (tasks #15/#16/#17). Row schema at ~line 631; exit codes at ~665 (3=resume, 0=all landed, 1=misses, 2=boot/GPU fail). No per-POI flush, no signal handler.
- **Plan file:** `$REPO/external/holtburger/scripts/net-review/outdoor-run-plans.json` (50 POIs; 3 non-usable: Ahurenga, Freehold, Linvak Tukal).

---
## 4. How to run / verify (hard-won operational recipe)
### 4a. Rebuild wasm (OOM-jail on the laptop — never bare wasm-pack)
```
cd $HOLT
env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
  capped-build wasm-pack build --target web --out-dir pkg --release
```
`pkg/` is gitignored → ALWAYS rebuild after a pull. Release = ~4.5 MB, dev = ~18 MB (`ls -la pkg/*.wasm`).
After a wasm change: `?nosw=1` on the URL and terminate the bake worker (holds its own wasm copy).

### 4b. 1070 real-GPU battery (cdp mode) — the full setup
Prereqs on laptop (all were running; verify): ACE server (`ss -ulpn | grep :900`), serve.py on :8765,
ws-bridge `holtburger-wsbr` on :8080. Then:
1. **Launch off-screen real-GPU Chrome on the 1070** via an INTERACTIVE-session scheduled task (SSH
   session-0 gives NO GL context). `C:\Temp\launch-wls.bat` runs:
   `chrome --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist --user-data-dir=C:\Temp\cdpwb-wls --window-position=-32000,-32000 about:blank`
   then `schtasks /create /tn cdpwb /tr C:\Temp\launch-wls.bat /sc once /st 00:00 /it /f & schtasks /run /tn cdpwb`.
   Assert `UNMASKED_RENDERER` contains `NVIDIA ... GTX 1070 ... Direct3D11`.
2. **Three tunnels from the laptop** (detached, survive session):
   `ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75`
   `ssh -o ExitOnForwardFailure=yes -fN -R 8080:127.0.0.1:8080 young@100.127.215.75`
   ⚠ **:8080 reverse tunnel (ws→UDP bridge to ACE) is REQUIRED** — without it boot fails
   `WsTransport::connect: ws handshake failed`. (This is undocumented; add via task #18.)
3. **Run the recycling wrapper** (detached): `setsid nohup /mnt/wbterminal2/tmp/outdoor-run-wrapper.sh >/dev/null 2>&1 &`
   It runs the driver `--mode cdp --cdp http://127.0.0.1:9333 --plans ... --runS 300 --maxStops 5 --resume`,
   loops on exit 3, and **waits for ACE to release the single-login account** (polls ACE_Log.txt for
   `[LOGOUT] Account tailnet1 exited`) before each re-login (~70 s natural link-dead timeout; FREE_CAP 220 s).

### 4c. CRITICAL gotchas (cost hours this run)
- **Account In Use / single-login:** only ONE `tailnet1` session at a time. Overlapping logins → ACE
  boots the old AND rejects the new → bootState=error. Always wait for the ACE `[LOGOUT]` before re-login.
- **Killing the driver leaves its page OPEN on the 1070 Chrome**, and its keepalive worker keeps the
  ACE session alive forever → all future logins collide. You MUST close that page via CDP after a kill
  (connect playwright `connectOverCDP`, close pages whose url matches `holtburger-web`; `browser.close()`
  only detaches CDP, does NOT kill Chrome).
- **1070 is a person's machine.** Off-screen/headless only, isolated `cdpwb-wls` user-data-dir. NEVER
  `taskkill /IM chrome.exe`; only Stop-Process by CommandLine match on `*cdpwb-wls*`. Box has 16 GB RAM /
  ~5.6 GB free — do not let a tab grow unbounded (the whole point of the fix).
- **`pgrep -f <pat>` / `pkill -f <pat>` self-kill (exit 144):** if `<pat>` appears in your own bash
  command line it matches your shell. Kill by explicit PID.
- **serve.py runs with `--allow-missing`** (silently serves partial world). World was fully baked this
  run (scenery=80395 spawns=38153); if placements read 0, check dist mount.

### 4d. Analysis snippet (recompute any metric)
```python
import json
def load(p): return [json.loads(l) for l in open(p) if l.strip()]
cont = load('/mnt/wbterminal2/tmp/1070-samples.continuous.jsonl')
runs = [s for s in cont if s.get('phase')=='run']
# e.g. per-POI last geometries: {s['poi']: s['ri']['geometries'] for s in runs}
```

---
## 5. TASK LIST (created in the task system; IDs are authoritative there)
Dependency-ordered. **#1 blocks all impl tasks.** Tooling #15-#18 are independent (start anytime).

**Grounding**
- **#1 [audit]** Map landblock_lru.js / cells.js / static_atlas.js / src/lib.rs decode / diag/lod.js;
  record exact byte-cap, dispose rate, what's un-tracked, where the ~4.9 GB trigger comes from. *(blocks 2,3,4,6,7,8,10,11,12,14)*
- **#2 [measure]** Quantify re-decode rate (how many +2.5k geoms/POI are re-decodes of an already-seen
  model DID) + per-resource byte footprint. *(blocked by 1)*

**#1 Refcounted geometry/texture cache — biggest lever**
- **#3** Refcounted decoded-mesh DBOCache in Rust/wasm keyed by model DID (extend the thread_local memo;
  acquire/release refcount; byte-identical output). *(blocked by 1)*
- **#4** Share one BufferGeometry/Texture per model DID across placements in cells.js; wire refcount into
  track()/dispose() so shares free only at refcount 0. *(blocked by 1,3)*
- **#5** Rebuild wasm --release + verify geometry growth flattens on a battery slice. *(blocked by 4)*

**#2 Incremental eviction — kills 22.6 s stall + 7 GB heap**
- **#6** Amortize the synchronous bulk-dispose paths (evict-on-teleport whole-LB invalidation, flushParked)
  behind a per-frame time/count budget. *(blocked by 1)*
- **#7** Lower steady-state byte budget so heap holds ~1.5-2 GB; add ?flag override. *(blocked by 1)*
- **#8** Make dispose rate keep up with allocation (time-budget / adaptive per-tick vs the ~2.5k/POI inflow). *(blocked by 1)*
- **#9** Verify: no frame >~1 s, heap plateaus, fps no longer decays with POI count. *(blocked by 6,7,8)*

**#3 Budget the right quantity**
- **#10** Account geometry+texture BYTES in the budget; fix lru/resident stat to report real bytes. *(blocked by 1)*
- **#11** Bring untracked resources (static_atlas statics, cross-LB shares, cells) under budget. *(blocked by 1,4)*

**#4 Program-cache warm-up — kills 3.6 s first-POI hitch**
- **#12** compileAsync-prewarm ~125 programs at boot (respect vfx firewall: no per-instance customProgramCacheKey). *(blocked by 1)*
- **#13** Verify first-POI cold hitch gone. *(blocked by 12)*

**#5 Telemetry**
- **#14** Wire up LOD bandHits/bandMisses (defined+emitted but never incremented). *(blocked by 1)*

**Tooling (independent)**
- **#15** Per-run samples filename (timestamp/label) so runs don't concatenate.
- **#16** Per-POI out.json flush + SIGTERM/SIGINT finalize (so --resume works without log reconstruction).
- **#17** Recycle tuning: maxStops default 3 / heap-adaptive recycle.
- **#18** Document the cdp recipe (:8080 tunnel + account-free recycling wrapper) into net-review/README + ship the wrapper into repo scripts.

**Validation**
- **#19** Full post-fix battery + A/B vs the two baseline datasets; quantify each improvement's payoff. *(blocked by 5,9,11,13,14,15,16)*

---
## 6. Guiding principles (project conventions)
- Systems work (caches/residency/decode) belongs in **Rust/wasm**, not JS (a JS shared-geom cache is an
  unvalidatable dispose dance; Rust cache = byte-identical, no eye-test gate).
- Target = **retail residency**: refcounted DBOCache + fixed slot grid + UseTime-floored park (release ≠ free).
- Validated fixes ship **default-on** with a `?flag=off` escape; bar = bare-default loads+spawns+0 errors.
- Never edit vanilla ACE (`~/ace-server`). Verify agent leads (they hallucinate file:line + cite stale premises).
- Measurement traps: ship-RELEASE wasm before measuring; `renderer.info.autoReset` defaults true (zeroes per
  frame); `window.liveScene3d` is a one-time snapshot set ~35 s after in-world (poll not-null first).
