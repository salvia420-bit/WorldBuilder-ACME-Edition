# Outdoor-run stress battery

A 5-minute sustained **RUN** stress battery for holtburger-web, sibling to
`battery-telepoi.mjs` (which only teleports + sits to time land/settle). This
one drives the **continuous-traversal** streaming path: for every outdoor POI it
teleports in, settles, hops the avatar to a precomputed obstacle-free "clear
start" away from town buildings, then **holds `w` to run** for `--runS` seconds
while streaming perf metrics. Continuous running exercises cold terrain fill,
LOD churn, PVS updates and residency eviction that a teleport-and-sit battery
never hits.

## Pieces

| File | Role |
|------|------|
| `poi-destinations.json` | 62 POIs from `ace_world` (`points_of_interest` ⨝ `weenie_properties_position`); `outdoor:true` = `(cell & 0xFFFF) < 0x100`. Generator input. |
| `gen-outdoor-run-plans.py` | Ray-scores 32 compass headings per outdoor POI against terrain (water 16–20, grade > 0.85 = wall, map edge) + placed statics (`list-objects`), picks the best corridor + a clear-start ≥40 m out with no static within 25 m. Emits `outdoor-run-plans.json`. Drives WBT as a JSON-per-line subprocess. |
| `outdoor-run-plans.json` | 50 outdoor POIs, 47 usable (Ahurenga / Freehold / Linvak Tukal have no ≥250 m obstacle-free corridor — islands / mountain fortress). |
| `battery-outdoor-run.mjs` | The driver. |

## Generating plans

```bash
cd external/holtburger/scripts/net-review
python3 gen-outdoor-run-plans.py --pois-json poi-destinations.json --out outdoor-run-plans.json
# iterate on a subset first:
python3 gen-outdoor-run-plans.py --pois-json poi-destinations.json --out /tmp/x.json --only Holtburg,Yaraq,Bluespire
```

Needs the WBT DLL built (`WorldBuilder.Terminal/bin/Release/net8.0/…dll`) and a
project (`-p`, default `RetailSmoke.wbproj`). Terrain is fetched per-LANDBLOCK
(`get-terrain-data`, 81 vertices/call, cached across POIs) and sampled locally
with an exact replica of `CommandEngine.GetHeight` (triangle-interpolated
height incl. the retail `IsSWtoNEcut` split magic; nearest-vertex
terrainType/road): **~12k WBT calls, ~11 s for the full 50** (was ~250k
per-point `get-height` calls / ~10 min; regenerated plans matched to float
dust). `list-objects` gives per-LB placed statics **in world coords** (not
landblock-local — do not re-add `lbX*192`).

## Running the battery

```bash
# laptop smoke (no-GPU → wireframe REQUIRED so held-W actually moves):
node battery-outdoor-run.mjs --plans outdoor-run-plans.json \
  --pois smoke-pois.txt --runS 45 --label smoke --query "wireframe=1" \
  --out /mnt/wbterminal2/tmp/outdoor-run-smoke.json

# full arm (laptop):
node battery-outdoor-run.mjs --plans outdoor-run-plans.json \
  --runS 300 --label armA --query "wireframe=1" --maxStops 8 \
  --out /mnt/wbterminal2/tmp/outdoor-armA.json
# ...then re-invoke with --resume until exit != 3 (see below).

# 1070 (real GPU, textured — no wireframe):
node battery-outdoor-run.mjs --mode cdp --cdp http://127.0.0.1:9333 \
  --plans outdoor-run-plans.json --runS 300 --label 1070 \
  --out out.json --shots shots/
```

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--mode` | `local` | `local` = boot.mjs launchAndEnter (laptop headless). `cdp` = attach to a running off-screen Chrome (1070 :9333); keeps the real-GPU assert, never closes the browser. |
| `--plans` | `./outdoor-run-plans.json` | Plan file. |
| `--pois` | — | Optional name-subset file (one POI name per line). |
| `--query` | — | Extra URL query, e.g. `wireframe=1`. `nosw=1` is always added. |
| `--runS` | `300` | Run-phase seconds per POI. |
| `--sampleMs` | `2000` | Perf-sample interval. |
| `--dwellMax` | `25` | Max settle seconds per stop. |
| `--label` / `--out` | | Arm label / results JSON. |
| `--samplesOut` | dir of `--out` | Dir for the samples file. Filename is `<label>-samples-<UTC-stamp>-<pid>.jsonl`, **unique per run** so a re-run never concatenates onto a prior arm (the old fixed `<label>-samples.jsonl` mixed arms). A `--resume` session reuses the first session's exact file (read back from the prior `--out`'s `summary.samplesPath`), so one arm = one samples file across all its sessions. |
| `--maxStops` | `3` | Fixed-length sessions: after K run-stops close + exit 3 for relaunch. Lowered from 0/unlimited — POI 4-5 already degrade within a session. |
| `--maxHeapMB` | `0` (off) | Heap-adaptive recycle: after a run-stop whose `heapEndMB` exceeds this, close + exit 3 for relaunch — fires *before* the 256 MB park-pool cliff turns into a bulk-dispose stall. |
| `--resume` | off | Continue an aborted arm; keeps prior rows, skips already-recorded POIs, reuses the samples file. |
| `--shots` | — | Screenshot dir (per-POI, post-run). |
| `--landPollMs` `--quietGapMs` | `100` / `65000` | Land-poll granularity / inter-session resume gap. |
| `--settleWorkMin` `--settleFloorMs` | `5` / `3000` | Settle-guard knobs (verbatim from battery-telepoi). |
| `--cdp` `--account` | `:9333` / `tailnet1` | cdp attach point / login account. |

### Per-POI flow

1. `@telepoi <name>` → land-wait (12 s window) → settle (scene-count stability
   guard, `settleStep` from battery-telepoi).
2. `@teleloc <clearStart>` with the plan quat → verify pose within 15 m of the
   clear-start (`teleOk`) + record `headingErrDeg`.
3. **RUN** `--runS` s: hold `w` (re-asserted every ~2 s). Track distance along
   the corridor; **ping-pong** 180° in place at `corridorEnd − 40 m`; **stuck
   guard** — <4 m over 6 s → sidestep (d/a) 1.2 s, and after 3 stalls `@teleloc`
   ~30 m ahead at `pose.z + 2`.
4. Row `{kind:"run", poi, landed, teleOk, headingErrDeg, distanceM, avgSpeedMps,
   flips, stuckEvents, nudges, fpsMean/P50/P95, worstFrameMs, ltCount+buckets,
   heapStart/EndMB, workDelta, reclaimDelta, wasmMem*, endStats}`. Non-usable
   plans → `{kind:"skip", reason}`.

### Exit codes / resume

`0` all landed · `1` some misses · `2` boot stall / not-real-GPU · `3`
renderer-death abort **or** clean `--maxStops`/`--maxHeapMB` cap with POIs
remaining → wrapper should relaunch with `--resume` (same `--out`) until exit ≠ 3.

`--out` is **flushed after every POI** (run or skip), and a `SIGINT`/`SIGTERM`
finalizes + writes `--out` + exits 3 (resumable). So killing the driver — the
common recycle/abort path — leaves a complete, resumable `--out` with no
log-reconstruction needed (the original arm A had to be rebuilt from the log
because only the end-of-run wrote `--out`).

## Laptop vs 1070

- **Laptop (this box, SwiftShader, 8 GB)**: `--query "wireframe=1"` is
  **mandatory** for the run phase — textured SwiftShader runs <1 fps and
  per-frame movement input starves so the avatar never moves; wireframe ~5 fps
  is enough for held-W to advance (walk-west-proven). Absolute fps is NOT
  representative of the 1070, but draw-call / mesh / bake-cadence / longtask /
  heap / wire / wasm-mem counts ARE. Keep ≤3 headless chromium (~1.5 GB each).
- **1070 (real GPU)**: `--mode cdp`, textured (no wireframe), real fps. Never
  closes the person's browser — only our page. Run off-screen / headless.

### 1070 CDP full setup — tunnels + recycling wrapper

The 1070 (`young@100.127.215.75`, tailscale) is a person's Windows box with the
fleet's only real GPU. Run **off-screen / headless only**, in an isolated
`cdpwb-wls` user-data-dir; never `taskkill /IM chrome.exe`.

1. **Off-screen real-GPU Chrome via an INTERACTIVE-session scheduled task** (an
   SSH session-0 launch has NO GL context). `C:\Temp\launch-wls.bat`:
   ```
   chrome --remote-debugging-port=9333 --use-angle=d3d11 --ignore-gpu-blocklist \
     --user-data-dir=C:\Temp\cdpwb-wls --window-position=-32000,-32000 about:blank
   ```
   then `schtasks /create /tn cdpwb /tr C:\Temp\launch-wls.bat /sc once /st 00:00 /it /f && schtasks /run /tn cdpwb`.
   Assert `UNMASKED_RENDERER` contains `NVIDIA ... GTX 1070 ... Direct3D11` (the
   driver's real-GPU gate; a SwiftShader attach exits 2).

2. **Three tunnels from the laptop** (detached, survive the session):
   ```
   ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 young@100.127.215.75
   ssh -o ExitOnForwardFailure=yes -fN -R 8080:127.0.0.1:8080 young@100.127.215.75
   ```
   - `-L 9333` = CDP control · `-R 8765` = serve.py (the client) ·
   - ⚠ **`-R 8080` (ws→UDP bridge `holtburger-wsbr` → ACE) is REQUIRED** — without
     it boot fails `WsTransport::connect: ws handshake failed`. This one is easy
     to forget; it cost hours.

3. **Run the recycling wrapper** (detached):
   ```
   setsid nohup ./battery-outdoor-run-wrapper.sh >/dev/null 2>&1 &
   ```
   It loops on exit 3, and — crucially — **waits for ACE to RELEASE the
   single-login `tailnet1` account** (polls `ACE_Log.txt` for `[LOGOUT] Account
   tailnet1 exited` after the last `[LOGIN]`) before each re-login, so the
   recycle never hits "Account In Use". Tune `MAXSTOPS` / `MAXHEAP` at the top.

**Kill/cleanup gotchas:**
- Killing the driver leaves its page **open** on the 1070 Chrome, and its
  keepalive worker holds the ACE session alive forever → all later logins
  collide. After a kill you MUST close that page via CDP (playwright
  `connectOverCDP`, close pages whose url matches `holtburger-web`;
  `browser.close()` only detaches CDP, does not kill Chrome). The
  SIGTERM-finalize path (above) exits cleanly, but a `kill -9` skips it.
- Only Stop-Process the 1070 Chrome by CommandLine match on `*cdpwb-wls*`.
- `pgrep -f <pat>` / `pkill -f <pat>` self-kill (exit 144) if `<pat>` is in your
  own command line — kill by explicit PID.

## Notes / gotchas

- `pose.heading` readback is **mirrored** relative to the @teleloc quat: a stop
  teleported to face compass heading θ reports `pose.heading ≈ 360 − θ`, so
  `headingErrDeg` is logged as a non-fatal warning even when the avatar runs
  correctly *along* the cleared corridor (movement direction is validated
  empirically, not from the readback — see the driver header / the generator's
  ACE `Position.Rotate` derivation). The warning does not abort a stop and the
  perf data is valid.
- Wireframe skips sky/composer/CSM/shadows, so the run-phase fps is the
  streaming+JS+draw-submit cost, not the full pipeline.
- `getLocalPlayerPose()` returns a wasm-owned struct — the driver `.free()`s it
  after every read.
