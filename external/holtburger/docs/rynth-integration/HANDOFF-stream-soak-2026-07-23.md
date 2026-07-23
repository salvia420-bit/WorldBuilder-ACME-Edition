# HANDOFF — stream-soak session 2026-07-23: 5 fixes landed, 1 P0 open (wasm freeze)

A long live-stream soak session on the Dell rig (`/mnt/wbterminal2/stream`, YouTube). Five
bot-behavior/physics fixes shipped and committed; a built monitoring toolkit diagnosed each in
real time. One P0 remains OPEN and blocks a clean live run: a recurring **main-thread WASM
freeze**, now diagnosed to root cause but not yet fixed. The soak is STOPPED (ACE left running).

## Commits this session (all on master, pushed)
```
2a8578e5 docs/STREAM-RIG-OPS: bakeWorker 0->1 (fix recurring main-thread freeze)   [did NOT fix it — see P0]
f88ca140 rynth: frontier-cruise — fill director idle with distance-sized continuous exploration
7dc0a28b rynth: reliable multi-door building egress (obstruction-aware, door-opening retry ladder)
e29531aa rynth/stream: minimax-family director gets 8192 maxTokens (was globally forced 1280)
69abf0d7 core+world+rynth: settle-land FINDING remediation — reachable + faithful EPS gate, entry-descending guard
```
All JS/doc fixes activate on the next `?nosw=1` page reload; the physics fix is in the release wasm
(pkg/, rebuilt 4.62MB this session). All test-validated: node suite 55/0/32, holtburger-core
612/0/1-ignored, holtburger-world 579/0.

### What each fix does (problems seen live, then fixed)
- **settle-land (69abf0d7)** — FINDING #1+#2 remediation: the 8cm EPS hover-touchdown gate was
  ported into the REACHABLE `resolve_floor_for_step` (transition.rs) + the faithful driver
  (faithful_bridge.rs), gated on new `TransitionGates::settle_land`; an adversarial review caught
  that the band must gate on `entry_descending` (vz≤0 at TRUE slice entry) not post-gravity
  `descending`, else a slow riser is force-landed — fixed + regression-tested.
- **director maxTokens (e29531aa)** — `minimax-m3` (reasoning model) burned its entire 1280 budget
  (and the 2560 retry) on hidden reasoning → empty completion → 5 consecutive errors → director
  auto-DISABLED → bot idled with no AI. Model-aware: minimax family → 8192, GLM/gpt-oss keep 1280.
- **egress (7dc0a28b)** — bot could path INTO a building but not OUT (wedged 30+ min in the
  Holtburg tavern, cell 0xA9B40155). The graph/planner were fine; the failure was execution: legs
  interpolate cell centers with no obstruction awareness, ACE auto-closed the doors, `exit_building`
  was fire-and-forget (journaled a fake PLAN-DONE while wedged), and an indoor-start refusal trapped
  the director. Fix: bounded egress retry ladder (re-plan to next mouth on wedge, OPEN the blocking
  door, exclude stalled edges, honest outcome) + `bot.egress()` mission + refusal removed.
- **frontier-cruise (f88ca140)** — a live moving% metric showed the bot MOVING only ~14% of time,
  ~84% idle (director think-time between ~51-116s check-ins). Fill the gap with distance-sized
  continuous exploration: `budgetM = min(220m, clamp(gapMs,20-150s) × walkSpeed)` (~206m drive vs
  the old ~9m hop), yields to the director on the first in-flight tick (last-command-wins), doesn't
  chain on FAILED drives. ⚠ SEE P0 — this fix is the freeze TRIGGER.

## ⛔ P0 OPEN — recurring main-thread WASM freeze (blocks a clean live run)

### Symptom
Every ~20-30 min at first, then **~every 2 min** once the cruise fix shipped: the renderer main
thread hot-loops at ~90% CPU, blocks CDP entirely (evals + screenshots time out), no JS exception,
frozen display. Happened 6+ times this session. The comprehension monitor's `AUTO-RECOVER`
(SIGKILL game chromium + relaunch) heals each in ~43s, but at 2-min frequency (and v2's 5-min
recover cooldown) the stream is unwatchable, and rapid recoveries can cascade into a scene-ready
boot-loop.

### Diagnosis (definitive — caught with a CDP CPU profiler)
Built `freeze-profiler.cjs` (samples the renderer continuously; on freeze it `Profiler.stop`s and
dumps the hot stack before auto-recover kills the browser). Two clean catches:
- Catch 1 (26,725 samples): pure wasm — `wasm-function[765,970,1626,904,277,2082,1956,1471,315,…]`
  all in `pkg/holtburger_web_bg.wasm`.
- Catch 2 (76,256 samples): the tell — **`fetch` (2990) + `__wbg_fetch` (pkg/holtburger_web.js:17985,
  1136)** are hot alongside the same wasm functions, plus `getClientRects`.

**Root cause: a WASM resource-streaming / fetch storm.** The wasm's main-thread landblock/asset
loader spins issuing network fetches faster than it can drain. **Trigger: the cruise fix's long
routes** — a live sample showed a **27-leg** cruise route; driving far/fast streams a huge span of
landblocks at once. That's why freeze frequency jumped ~10-15× exactly when cruise turned on.
**Compounded by a bad spawn:** the bot was at `lb=0x0007, z=0.0` (a far map-corner — the
`vendortest` character's position got corrupted by the session's deaths/recalls), so the long route
ran into mostly empty/missing landblocks → an even worse fetch storm. **NOT the settle-land physics
change** (the hot path is I/O/streaming, no physics) and **NOT the main-thread bake** — flipping
`bakeWorker=0→1` did NOT fix it (froze again ~2 min in with the worker confirmed active).

### The fix direction (JS-tunable; no wasm-bug hunt needed)
Throttle so movement can't outrun the main-thread streamer:
1. **Cap the cruise route span** — 220m → ~60m (`CRUISE_MAX_M`/`CRUISE_MAX_LEG_M` in `rynth/bot.js`),
   and/or rate-limit how many legs/landblocks stream concurrently.
2. **Rate-limit landblock streaming** in the wasm resource path if the JS cap isn't enough (would
   need a wasm change → `capped-build wasm-pack --release`).
3. **Spawn/teleport the bot to a real populated area** (Holtburg), never the 0x0007 corner — the
   corner spawn makes it far worse. (Consider resetting the `vendortest` character's saved
   position server-side.)
Then validate: relaunch, watch the `🏃 MOVING%` + freeze cadence; the profiler stays armed to
confirm the fetch storm is gone.

### Artifacts for the next session
- `/mnt/wbterminal2/stream/freeze-profile.json` (3.3MB) — the caught freeze CPU profile (release
  wasm indices, symbol-stripped).
- `apps/holtburger-web/pkg-prof/` (5.77MB `--profiling` wasm, names KEPT) — to get the EXACT Rust
  function names: deploy pkg-prof into pkg/ (back up pkg first), reload, re-arm `freeze-profiler.cjs`,
  catch a freeze → named functions (release + profiling builds have DIFFERENT function indices, so
  the existing freeze-profile.json indices can't be mapped with pkg-prof — must re-profile).
- No wasm symbolication tools installed (wasm-objdump/wasm-tools/twiggy absent) — install wabt or
  use the profiling build.

## Monitoring toolkit (out-of-repo, `/mnt/wbterminal2/stream/`) — built this session
Companions to the repo's `scripts/stream-rig-watchdog.cjs`; consider version-controlling under
`scripts/`:
- `comprehension-monitor-v2.cjs` — connects into the live page over CDP; classifies each director
  plan's outcome (PLAN-DONE/PARTIAL/FAIL/STUCK-FRONTIER/MISSION-FAIL) with WHEN/WHY/HOW/WHERE +
  rolling metrics; detects FROZEN (auto-recovers via `recover-stream-game.sh`), NOT-MOVING,
  DIRECTOR-STALL/DISABLED, DISCONNECTED, STREAM-DOWN.
- `jitter-catcher.cjs` — 5Hz outdoor-goto jitter detector (path≫net / heading reversals) + the
  **moving% utilization metric** (`🏃 MOVING X% — idle Y% / wedged Z%`).
- `freeze-profiler.cjs` — the CDP CPU-profiler freeze-catcher (above).
- `recover-stream-game.sh` — clean SIGKILL-game-chromium + cache-clear + relaunch (used by v2's
  auto-recover; clears HTTP cache so JS/URL edits take effect on reboot).
- `stop-soak.sh` + a director-disable watcher — auto-stop the whole soak if the director hits its
  5-consecutive-error disable (operator: "stop, don't switch to expensive glm-5.2").

## Other open (lower priority)
- **Outdoor wall-collision jitter** (~2% wedged) — the bot walks into exterior walls during outdoor
  gotos (route legs lack building-footprint avoidance). `jitter-catcher.cjs` is armed to trace it;
  the cruise waypoint routing may already reduce it. Fix = building-AABB-aware outdoor leg pathing.
- **moving% baseline** — was ~14% pre-cruise. Cruise should lift it substantially ONCE the freeze
  is fixed (couldn't measure a stable post-cruise number — the freezes reset the window).
- **bakeWorker=1** — kept (it's the default-intended path and offloads decode; just didn't fix the
  freeze, which is fetch-bound not decode-bound). launch.sh + STREAM-RIG-OPS updated.

## Next-session checklist
1. Implement the cruise/streaming throttle (fix direction above) + a good spawn.
2. (Optional) deploy pkg-prof + re-profile for the exact wasm function names if the throttle alone
   doesn't resolve it.
3. Relaunch: `bash /mnt/wbterminal2/stream/launch.sh` (bakeWorker=1, all fixes auto-deploy on a
   fresh boot) → `go_live.sh &` → bring up the monitors → watch moving% + freeze cadence.
4. Live services this session were all UP on the laptop (ACE UDP 9000/9001, serve.py :8765,
   wsbridge :8080, rynthnav :8767).
