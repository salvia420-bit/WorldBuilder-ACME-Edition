# perf-worker — A/B smoothness/hitch testing for holtburger-web

Drives the Playwright Firefox on the 1070 Ti through a fixed 60-second WASD
scenario while a page-side recorder captures per-rAF frame intervals,
hitch counts, draw calls, mesh/texture/geometry deltas, and player path
length. Output is one directory per run with JSON + screenshots; a
companion `diff-perf.sh` prints a side-by-side delta between any two runs.

Designed for "low" iteration: defaults to `?quality=low&agentic=low`
(no clouds, no aurora — "low" means low everything) so the change → measure
loop stays tight. ~16s boot, ~70 fps steady state, still surfaces real
PVS-streaming hitches as you walk into uncached LBs.

## Pre-flight

```bash
# driver tunnel must be alive (see ~/handoff-firefox-driver-2026-05-20.md)
curl -sS http://127.0.0.1:9224/status
# if it times out, rebuild the tunnel:
pkill -f 'ssh.*100.127.215.75' ; sleep 1
ssh -o ExitOnForwardFailure=yes -fN \
  -R 7080:127.0.0.1:8765 -R 8080:127.0.0.1:8080 \
  -L 9223:127.0.0.1:9222 -L 9224:127.0.0.1:9224 \
  young@100.127.215.75
```

## One-shot run

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
./scripts/perf-worker/drive-perf.sh --label baseline_A
```

Total wall-clock: ~90 seconds (50s boot + 10s warm-up + 60s run + ~5s teardown).

Output (under `/mnt/wbterminal1/tmp/claude-scratch/perf/<label>-<UTC>/`):

| file                     | what                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `summary.json`           | aggregate metrics (fps, hitch buckets, p95/p99, path len)  |
| `frames.json`            | raw per-frame intervals + renderer/pose snapshots          |
| `console.txt`            | last 500 console lines (post-run)                          |
| `before.png` / `after.png` | pre-run + post-run scene screenshots                     |
| `meta.json`              | label, git head, URL, pattern version                      |

## A/B workflow

```bash
# Run A on the current code:
./scripts/perf-worker/drive-perf.sh --label before_fix

# … make code change, wasm-pack rebuild if needed …

# Run B with the same default URL & movement pattern:
./scripts/perf-worker/drive-perf.sh --label after_fix

# Side-by-side delta with verdict line:
./scripts/perf-worker/diff-perf.sh \
  /mnt/wbterminal1/tmp/claude-scratch/perf/before_fix-*/ \
  /mnt/wbterminal1/tmp/claude-scratch/perf/after_fix-*/
```

## What it measures

- **avgFps** — wall-time average over the 60s window.
- **p50 / p95 / p99 / max frame time (ms)** — distribution of rAF intervals.
- **hitch buckets** — count of frames ≥50/100/250/500/1000 ms.
- **hitch time** — total wall ms spent in each hitch bucket (catches "many small hitches" vs "one big freeze").
- **secondsBuckets** — visible-fps per 1-second wall window (drop into a graph).
- **draws/frame, tris/frame** — averaged across the snapshot window (handles `info.autoReset` correctly by toggling it off for the duration of the run).
- **meshes / textures / geometries / programs** — scene complexity drift across the run; rising = PVS streaming, leaks, or eager-loads.
- **pose path length (m)** — sanity-check the character actually moved.

## Movement pattern (movement-pattern-v4)

Cardinal traversal: 4 long forward legs at run speed (W alone — NO
Shift; Shift is the WALK modifier in AC's retail-convention input
handling) with 90° right-yaw turns between legs. ~125s total. Each
leg covers ~200m+ at full run, deliberately overshooting Holtburg's
192m LB boundary so each leg enters a new LB — maximum EnvCell bake
+ PVS stream + shader/texture upload stress.

| t (s)         | keys held       | label                   |
| ------------- | --------------- | ----------------------- |
| 0–30          | `w`             | run-leg-1-north         |
| 30–31.5       | `w` `e`         | turn-right-1            |
| 31.5–61.5     | `w`             | run-leg-2-east          |
| 61.5–63.0     | `w` `e`         | turn-right-2            |
| 63.0–93.0     | `w`             | run-leg-3-south         |
| 93.0–94.5     | `w` `e`         | turn-right-3            |
| 94.5–124.5    | `w`             | run-leg-4-west          |

Prior versions:
- v1: 60s cardinal cycle (w/a/s/d/diagonals/sprint/idle) — covered
  ~115m, stayed mostly in spawn LB
- v2: 60s W+Shift sustained — covered ~60m (ran into hill, stopped)
- v3: 120s W+Shift with periodic 45° turns — covered ~118m (Shift =
  walk modifier, not sprint)

Goal of v4: cross multiple LB boundaries per run so EnvCell + PVS
streaming hitches reproduce reliably.

## Options

```
--label NAME           run identifier (used in output dir)              [required]
--quality PRESET       renderer preset low|mid|high|ultra               [low]
--warmup-sec N         idle after boot 'ready' before recording starts  [10]
--ready-timeout-sec N  max wait for __bootState='ready'                 [120]
--full-ring            disable ?agentic=low (full 13×13, ~48s boot)
--account NAME         autoLogin account                                [tailnet1]
--password PW                                                           [tailnet1]
--spawn NAME|first|0   autoSpawn param                                  [first]
--extra-flags STR      appended to URL                                  [''  → pass 'clouds=on&aurora=on' to opt in]
--no-clear-cache       skip /clear-cache before navigate
--reload-only          /reload instead of full nav (preserves session)
--out-root DIR                                                          [/mnt/wbterminal1/tmp/claude-scratch/perf]
```

## Safety notes

- All instrumentation is page-side, namespaced under `window.__perfRec` and `window.__moveLoop`, and explicitly removed on teardown. No edits to holtburger source files.
- Synthetic keys are dispatched as `KeyboardEvent` on `document` — same path real WASD takes through `scene3d/camera.js:1247`. The script blurs any focused input first so the camera handler's `isTypingInForm()` guard doesn't swallow them.
- The bash script traps `EXIT`/`INT`/`TERM` and fires a cleanup call so a Ctrl-C mid-run doesn't leave the browser holding `W`+`Shift`.
- `renderer.info.autoReset` is flipped to `false` for the duration of the run (so per-window draw-call deltas are real, not just the final composite pass) and restored on teardown.
- Default URL uses `quality=low&agentic=low` (no clouds/aurora) — "low-agentic worker" means low everything. Opt up with `--quality ultra --extra-flags 'clouds=on&aurora=on'`.

## Caveats

- **First-run vs warm-cache delta is large.** Cold boot fills the texture/shader caches; first measured run after a clear-cache will have more `>=500ms` hitches than the second. For meaningful A/B, either: (a) compare same-cache-state runs (re-run B right after A), or (b) average 2–3 runs per side.
- **Playwright window must be foreground.** rAF is throttled when occluded; if `avgFps` drops to 1–5, check the firefox window isn't hidden behind something on the 1070.
- **`longTask` count is Firefox-only** (Chrome would surface them via PerformanceObserver too, but our driver runs Firefox). On Firefox the entry currently fires but is sometimes empty depending on prefs — treat as supplementary.
- The 9-LB initial ring (`?agentic=low`) means the test exercises PVS streaming hitches as you walk into uncached LBs. That's a *feature* for this test, not a bug — those are real user-visible hitches.

## Related

- Original Firefox driver setup: `~/handoff-firefox-driver-2026-05-20.md`
- `?agentic=low`: `reference_agentic_low_mode.md` in memory
- Prior stutter diagnosis: `project_holtburger_stutter_fixes_2026-05-21.md` in memory
