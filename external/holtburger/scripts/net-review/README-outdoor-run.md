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
| `--samplesOut` | dir of `--out` | Dir for `<label>-samples.jsonl`. |
| `--maxStops` | `0` | Fixed-length sessions: after K run-stops close + exit 3 for relaunch. |
| `--resume` | off | Continue an aborted arm; keeps prior rows, skips already-recorded POIs. |
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
renderer-death abort **or** clean `--maxStops` cap with POIs remaining → wrapper
should relaunch with `--resume` (same `--out`) until exit ≠ 3. Partial JSON is
always written on abort.

## Laptop vs 1070

- **Laptop (this box, SwiftShader, 8 GB)**: `--query "wireframe=1"` is
  **mandatory** for the run phase — textured SwiftShader runs <1 fps and
  per-frame movement input starves so the avatar never moves; wireframe ~5 fps
  is enough for held-W to advance (walk-west-proven). Absolute fps is NOT
  representative of the 1070, but draw-call / mesh / bake-cadence / longtask /
  heap / wire / wasm-mem counts ARE. Keep ≤3 headless chromium (~1.5 GB each).
- **1070 (real GPU)**: `--mode cdp`, textured (no wireframe), real fps. Never
  closes the person's browser — only our page. Run off-screen / headless.

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
