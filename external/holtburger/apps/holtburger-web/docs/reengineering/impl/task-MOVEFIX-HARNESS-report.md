# task MOVEFIX-HARNESS — moving-bench BOOT-FAIL (harness maintenance)

Charge: fix the moving-bench harness boot failure so the MOVE-FIX baseline can
run. No SPEC task number; scope is `harness/` (plus this report).

## Shipped

| File | What | Commit |
|------|------|--------|
| `apps/holtburger-web/harness/moving-bench.mjs` | boot gate rewritten: history-aware success, relogin-on-pre-in-world-error, diagnostic failure output, login-phase error partition (`classifyBoot` / `formatBootHistory` / `splitBootErrors`, all exported) + the investigation recorded in the header | `2d49aa26` |
| `apps/holtburger-web/harness/test_moving_bench_boot.mjs` | new pure-node suite, 39 checks, both real failure shapes encoded | `2d49aa26` |
| `apps/holtburger-web/harness/README.md` | boot-gate section + suite listing | `2d49aa26` |

`index.html` was **not** touched (see Deviations — it did not need to be).

## Spec conformance (vs the brief)

1. **Root-cause the stall — MET, with a correction.** `?renderOnDemand=1` does
   not stall the boot orchestrator. Read-verified + live-disproved (below).
   The real defect is in the harness's boot gate.
2. **Fix minimally, harness-side — MET.** The fix is entirely in
   `harness/moving-bench.mjs`; no runtime setter and no boot-orchestrator
   change were needed, because the flag was never the blocker. The URL still
   carries `renderOnDemand=1` (the rig needs `__renderOnce`).
3. **Prove it — MET.**
   (a) `node harness/test_moving_bench_boot.mjs` → 39/39.
   (b) One headless SwiftShader chromium on this laptop: moving-bench reached
   in-world, installed the rig and ran warm + measure laps, twice, including
   one run that recovered from the exact refusal that killed the 1070 attempt.
4. **Report + handoff — this file.**

### The root cause, read-verified

The 1070 log (`/tmp/…/bsfxvfwdb.output`, 548 bytes, read in full) contains
exactly one diagnostic line: `[moving-bench] BOOT-FAIL`. That branch was
`if (s === "error")` on a bare `window.__bootState` poll — it printed no
reason, so three contexts inferred the cause from the URL rather than from the
page, and the flag in the URL got the blame.

**`?renderOnDemand=1` is innocent.** The exact URL `buildUrl()` produces
(account swapped to `agentp07`) booted to `__bootState === "ready"` in 8.4 s:

```
[boot-state] form-shown → connecting → char-list-ready → spawning
           → in-world: guid=0x50000176
           → ready: scene fully loaded (atmosphere load 1817.2ms)
```

`ready` is fired from `scene3d/index.js:5856` inside
`atmosphereRuntime.whenReady()`, which is driven by the microtask rIC shim
(`scene3d/_ric_shim.js:58-98`), not by rAF — so the rAF short-circuit at
`scene3d/index.js:2227` (`scheduleNext: if (renderOnDemand) return;`) cannot
starve it. `?netDrainHz=30` (which the harness always pairs with the flag)
keeps `tickPerFrame` running while rAF idles, and `singleDriverOn` is
explicitly computed to exclude only the `renderOnDemand`-without-`netDrainHz`
combination (`scene3d/index.js:951`). Nothing on the boot path awaits a
rendered frame.

**What actually fails.** Two shapes, both observed live today:

* **A — stale ACE session (this is what killed the 1070 run).** With the page
  from a previous arm still closing, ACE refuses the connect:
  `[rust-WARN] [character-error] code=0x1 name=Logon` → 25 s later
  `[boot-state] error: connect failed after 1 attempts: timeout`.
  index.html's autoLogin defaults to `maxRetries = 0` on purpose (index.html
  :11251-11263 — the old retry-dance was destructive), so the FIRST refusal is
  terminal for the page, and the harness quit on it. Two bench arms on one
  account IS this situation; the 1070 command line also inherits
  `--account` default `tailnet1`, the human's Developer account on a box a
  person uses.
* **B — post-in-world ready-watchdog.** index.html :11626-11647 latches
  `error: in-world reached but scene-ready signal did not fire within
  90000ms`, and `ready`/`in-world` share one scalar (:6122-6131). A gate that
  polls the scalar alone can read a terminal `error` on a session that is
  in-world and fine. (Reproduced here when a first, mis-launched chromium had
  no WebGL: `THREE.WebGLRenderer: Error creating WebGL context` → init3D threw
  → the watchdog latched `error` 90 s after a healthy `in-world`.)

### The fix

`harness/moving-bench.mjs` only:

* `classifyBoot(snap, {attempt, maxAttempts})` — pure verdict over
  `{state, history, sceneReadyEverFired, inFlight}`: `go` if in-world/ready was
  EVER reached (shape B can no longer abort), `wait` on transients and on an
  error still holding the in-flight claim, `relogin` on a pre-in-world error
  with budget left, `fatal` otherwise — carrying the page's own message.
* on `relogin`: 9 s cooldown (past ACE's ~5–10 s character logout, the same
  bound index.html sizes `charInWorldWaitMs` at) then
  `window.__runAutonomousLogin({autoSpawn:"first", maxRetries:1})` — the
  documented agent retry entry point (index.html :11218, :11681). Budget
  `--loginRetries` (default 2); `--loginRetries=0` is the old behaviour.
  Each retry adds `--loginRetryBudgetMs` (60 s) to the boot deadline.
* every failure now prints the reason plus the full boot-state history.
* `splitBootErrors()` — console errors logged before the gate passed are
  reported as `bootErrors` + `reloginAttempts` (also in the RESULTS-v2 arm) and
  excluded from `judge()`. Without this a recovered run REJECTs itself on the
  refusal it survived (observed: run 2 below, `errors: 1`).

## Deviations

**DEVIATION vs the brief's premise** — the brief states that a page booted with
`renderOnDemand=1` stalls before login and asks for either a runtime arming
hook or a boot-orchestrator fix. Live evidence above shows boot completes to
`ready` under that flag on HEAD, so both proposed fix shapes would have been
changes with no defect behind them. **Rejected alternatives:**

* *Boot without the flag, arm on-demand at runtime.* Would need a new runtime
  setter: `renderOnDemand` is a `const` captured at `init3D` time
  (`scene3d/index.js:892`) and read by `scheduleNext` (:2227) and the dt-recovery
  threshold (:2167). That is a live-code change to the render loop to work
  around a harness bug — larger and riskier than the gate fix, and it would not
  have fixed the actual failure (the stale session) at all.
* *Fix the boot orchestrator to drive `__renderOnce` itself.* Same objection,
  plus it would touch index.html, which another agent's task also touches.

`index.html` was read extensively but not modified.

## Tests run

```
node harness/test_moving_bench_boot.mjs      39 passed, 0 failed   MOVING-BENCH-BOOT ✅   (new)
node test_cam_moving_bench.mjs               38 passed, 0 failed                          (neighbour)
node harness/test_report_v2.mjs              39 passed, 0 failed   REPORT-V2 ✅           (neighbour; imports toResultsV2)
node harness/test_diag_schema.mjs            67 passed, 0 failed   DIAG-SCHEMA ✅
```

**Live, one headless chromium** (`/usr/bin/chromium --headless=new
--remote-debugging-port=9333 --use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader --disable-gpu-sandbox --mute-audio`, own
`--user-data-dir`, killed at the end), against local `serve.py` :8765 + live
ACE, account `agentp07`:

| run | boot | outcome |
|-----|------|---------|
| repro (pre-fix code) | `renderOnDemand=1` URL | **`ready` in 8.4 s** — the flag exonerated |
| repro 2 (pre-fix) | same URL, immediately after | `error: connect failed after 1 attempts: timeout` (shape A reproduced) |
| run 1 (post-fix, 30 frames) | clean | in-world → `rig installed … warm lap` → warm lap crashed the SwiftShader renderer ("Execution context was destroyed") after ~4 min of software rendering — environmental, see risks |
| run 2 (post-fix, 4 frames) | **1 relogin** | `boot error: connect failed after 1 attempts: timeout` → relogin 1/2 → in-world → rig installed → warm + measure laps → RESULTS-v2 written |
| run 3 (post-fix, 4 frames) | clean, 0 relogins | full run, `errors 0` |
| run 4 (post-fix, 4 frames) | **1 relogin** | full run, `errors: 0`, `boot: 1 relogin(s), 1 login-phase error(s) (reported, not judged)` |

Runs 2–4 are judged `REJECT / DIVERGED-WORKLOAD` — expected and correct: 4
frames at ~8 s/frame on SwiftShader is not a baseline. **@scale note: no figure
from these runs is a measurement**; they exist to prove the gate. The 1800-frame
judged baseline is the 1070's job (DEFERRED-TO-BATCH).

## Handoffs & risks

* **MOVE-FIX-BASELINE can be un-blocked.** `docs/reengineering/queue-1070/batch-A-2026-08-09.json`
  → item `MOVE-FIX-BASELINE`: its `result.status` ("ATTEMPTED — BLOCKED by a
  harness defect") and `result.defect` / `result.fixShape` (both of which name
  `?renderOnDemand=1` as the cause) are now wrong and should be updated by the
  orchestrator. I did not edit the queue file — not my scope.
* **Command line for the re-run.** The invocation changes only by an account
  and (optionally) a retry budget; the flag stays:
  ```
  node harness/moving-bench.mjs --cdp=http://127.0.0.1:9333 \
       --anchor=25171,20344,42.0 --mode=orbit --frames=1800 --laps=1 \
       --arm=default --account=<bot account, NOT tailnet1>
  ```
  `--loginRetries=2` is the default; pass `--loginRetries=0` to get the old
  fail-fast behaviour. Between interleaved arms, keep the existing inter-arm
  quiet gap — the relogin path is a safety net, not a licence to hammer ACE.
* **Baseline hygiene:** if the accepted baseline run reports
  `boot: N relogin(s)` with N > 0, the run is still valid (the relogin happens
  before the settle and the warm lap), but record N alongside it — a run that
  needed a relogin started from a slightly hotter ACE.
* **Risk — untested on the 1070.** Both failure shapes and the fix were
  reproduced on this laptop against local ACE. The 1070's +RTT link makes the
  25 s connect timeout tighter; if the baseline still fails there, the gate now
  prints the page's own message and history, which is the diagnosis the last
  attempt lacked.
* **Risk — SwiftShader crash under long laps** (run 1): the renderer process
  died mid-warm-lap at 30 frames × ~8 s. Not investigated (this laptop has no
  GPU and 8 GB); it does not reproduce at 4 frames and is not a boot-gate path.
* Unrelated dirty files left staged-out: `docs/reengineering/IMPLEMENTATION.md`
  (modified by another in-flight agent) and `impl/task-T15R-report.md`
  (untracked, another agent's). I have no status-table row to update.
