# Marketplace-freeze-fix A/B on the GTX-1070 — KEEP/REVERT recipe (S3)

Decides: does branch `marketplace-freeze-fix` (= master + d702fb7a, JS-only:
program_warm.js + portal_space/loop/cells/entities edits) beat master
@ 8e686c8c, or confirm the "performs worse" field report?

## Arms & serving
d702fb7a touches ONLY scene3d JS (no src/lib.rs) → NO wasm rebuild; serve
straight from the checked-out tree on the laptop:
    cd ~/WorldBuilder-ACME-Edition/external/holtburger
    git stash --include-untracked        # keep the review tree clean
    git checkout <ARM>                   # master | origin/marketplace-freeze-fix
    python3 scripts/serve.py             # binds 127.0.0.1:8765
Tunnel (from the laptop; drive-perf.sh conventions, app reachable on the 1070
as localhost:7080): ssh -fN -R 7080:127.0.0.1:8765 -L 9333:127.0.0.1:9333 <1070-host>
Run arm A fully (all 3 stops), then flip the checkout and run arm B.
Record `git rev-parse HEAD` into each run's meta.json (drive-perf.sh provenance rule).

## 1070 browser rules (per-arm)
- Launch Chrome on the box FRESH per arm:
  chrome.exe --remote-debugging-port=9333 --user-data-dir=C:\tmp\ab-<arm>-<ts> --no-first-run
  (fresh dir = cold shader/program + HTTP cache — mandatory: program-warm is
  exactly what d702fb7a changes; a warm cache invalidates the whole A/B)
- Drive via playwright-core: `const b = await chromium.connectOverCDP("http://127.0.0.1:9333")`.
  NEVER `browser.close()` — end scripts with `process.exit(0)`.
- URL (real render, NOT nullRender):
  http://localhost:7080/apps/holtburger-web/index.html?nosw=1&renderer=3d&quality=low&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&renderDiag=on
- Gate: __bootState 'in-world' in __bootStateHistory AND getLocalPlayerPose()!=null
  (never gate on 'ready'). Then poll window.liveScene3d non-null.

## Route (one session per arm; 10s idle between stops)
1. Spawn → settle 20s (warm baseline).
2. `__sessionHandle.sendChat("@telepoi Marketplace")` → record 60s.
3. `sendChat("@telepoi Town Network")` → record 60s.   (fallback: "@telepoi TN")
4. `sendChat("@telepoi Holtburg")` → record 60s (outdoor-town control).

## Recorder (install BEFORE each teleport, in-page via CDP evaluate)
Reuse Artifact 2's `installRecorder` verbatim (rAF deltas + longtasks + 500ms
buckets). It flips `renderer.info.autoReset=false` and diffs — REQUIRED, per
scripts/perf-worker/lib/install-recorder.js. On this rig renderer counters are
LIVE (no nullRender), so `programs`/`dCalls` are meaningful. Restore autoReset
after each stop (stopRecorder does).

## The 3 deciding metrics (per stop, from the bucket timeline)
| metric | definition | source |
|---|---|---|
| M1 post-teleport p95 frame time | p95 of rAF deltas in the first 30s after `landed` | rec.frames slice |
| M2 programs compiled | `renderer.info.programs.length` (last bucket of stop) − (bucket at teleport-send) | buckets[].programs |
| M3 steady-state fps | 1000 / mean rAF delta over 30–60s post-land | rec.frames slice |

## Pass/fail (branch vs master, same stop)
- **KEEP** iff at Marketplace: M1 improves ≥20% AND M2 does not increase,
  AND at TN + Holtburg: M1/M3 regress <10% and M2 increase ≤5 programs.
- **REVERT** if ANY stop shows M1 ≥20% worse, or M3 ≥15% worse, or M2 grows
  >20 programs (program_warm compiling programs the route never uses — the
  prime suspect mechanism for "worse than master"; cross-ref A09/A10).
- Anything between: rerun both arms once (N=2) before deciding; report medians.

## Artifacts to save per arm (drive-perf.sh layout)
out/<arm>-<ts>/{meta.json, stop-{marketplace,tn,holtburg}.json, console.txt,
before/after screenshots via CDP Page.captureScreenshot}. Compare with a
diff-perf.sh-style side-by-side (A vs B, Δ, Δ%).
