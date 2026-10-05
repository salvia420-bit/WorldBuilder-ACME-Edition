# HANDOFF — stream-soak session 2026-07-23: 5 fixes landed, 1 P0 ROOT-CAUSED (BSP-clone storm)

A long live-stream soak session on the Dell rig (`/mnt/wbterminal2/stream`, YouTube). Five
bot-behavior/physics fixes shipped and committed; a built monitoring toolkit diagnosed each in
real time. One P0 remains code-OPEN but is now **root-caused to the exact Rust function** — and the
original diagnosis in this doc was WRONG. See **§P0 CORRECTION (2026-07-23 follow-up)** below; the
stale "fetch-storm" theory is struck through. The soak is STOPPED (ACE left running).

> **⚠ READ §P0 CORRECTION FIRST.** The P0 is NOT a fetch storm and NOT triggered by the cruise fix.
> It is a main-thread **`BspNode` collision-BSP deep-clone storm** in
> `holtburger-world/.../faithful_bridge.rs::build_cell_inner`, triggered by the bot being stuck in a
> **dungeon** (the "Night Club", landblock `0x0007`). Proven headless, stationary, with **0 network
> requests**, via the named profiling wasm. The fixes the old P0 proposed (cruise-span cap, fetch
> rate-limit, bakeWorker) do NOT address it.

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
  chain on FAILED drives. ~~⚠ SEE P0 — this fix is the freeze TRIGGER.~~ **CORRECTION (2026-07-23
  follow-up): the cruise fix is NOT the freeze trigger** — the freeze reproduces headless with the
  bot stationary and 0 network activity. Cruise correlated only because it drove the bot toward the
  dungeon faster. See §P0 CORRECTION.

## ⛔ P0 — main-thread WASM freeze — ROOT-CAUSED (BspNode-clone storm in a dungeon)

### §P0 CORRECTION (2026-07-23 follow-up) — the real root cause
A follow-up session profiled the freeze with the **named profiling wasm** (`pkg-prof`) and caught
the exact Rust functions. The original "fetch-storm" theory below is **WRONG**.

**Root cause: a per-transition collision-BSP deep-clone storm.** In
`crates/holtburger-world/src/spatial/faithful_bridge.rs`, `SceneWorld::build_cell_inner` (~line 536)
does `self.scene.cell_physics_bsp(cell_id).cloned()` — a **deep clone of the cell's collision-BSP
tree** (line 520 comment: *"the handle owns a CLONE of the cell's physics BSP"*) — and recurses into
portal-neighbour cells `MAX_PORTAL_HOPS` deep, cloning each of their BSP trees too. `SceneWorld`'s
cache (`RefCell<HashMap<u32, …>>`, line 507) is **per-transition** (line 112 comment: *"once per
distinct cell per transition"*) — a fresh empty cache is built each physics transition, so every
transition re-floods and re-clones the BSP forest.

- **Outdoors** cells have ~no BSP and no portal neighbours → the clone is trivial → no freeze.
- **Inside a dungeon** (205-cell portal-interconnected "Night Club", landblock `0x0007`) each cell
  carries heavy BSP and the neighbour flood is deep → a large recursive deep-copy, **repeated every
  transition**. The stuck bot spams `failed transition` (ACE physics log) → the flood-clone runs many
  times/sec → the main thread saturates → freeze.

**Named CPU profile (bot stationary in the Night Club, profiling wasm):**
```
~18%  hashbrown::RawTable::clone            (HashMap deep-copy inside build_cell_inner)
~16%  dlmalloc malloc/free/insert_large_chunk (allocation churn)
~15%+ holtburger_dat::physics::BspNode::clone (BSP tree deep-copy — dozens of frames)
      caller: holtburger_world::spatial::faithful_bridge::SceneWorld::build_cell_inner
```
Captured **headless, stationary, with 0 network requests/sec** — there is **no fetch storm**. The
release-wasm indices in the old "Catch 1" (`wasm-function[970,1626,1956,904,315,765,277,…]`)
reproduced exactly and map to the functions above. The old "Catch 2" `__wbg_fetch` was incidental
(healthy ~5 req/s landblock streaming), not the hot path.

**Control test (proves the dungeon is the trigger):** teleport/spawn the bot to Holtburg
(`0xA9B40019`) → hot-loop vanishes, main-thread eval RTT drops from **>8000 ms (frozen)** to
**~5 ms (responsive)**, top wasm self-time frame falls to 0.4%, CPU returns to normal streaming.

**Why every prior remedy failed:** `bakeWorker=0→1` (offloads *decode*, wrong subsystem), cruise-span
cap and fetch rate-limit (there is no fetch storm) — all address the wrong bottleneck.

### The spawn was NOT corruption — it's a real dungeon (and the bot can't egress)
The bot's saved `Location` (`0x00070178 [121, -70, 0]`) was NOT out-of-bounds garbage. `0x00070178`
is a **valid EnvCell** (cell.dat: `environmentId 101`, defined origin `[120,-70,0]` — the `-70`/`0`
are the dungeon's correct local coords). LandBlockInfo `0x0007FFFE` = **205-cell dungeon**, outdoor
terrain all `WaterDeepSea` → a **portal-only dungeon**; weenie `30542` in it is named **"Night Club"**.
The bot portaled in and can't get out (the egress bug). Login is faithful — `Login_SendEnterWorld`
carries only CharacterId+Account, so the *server* placed it there from its stored Location; NOT a
client login/spawn bug.

### Fix directions (Rust — the old JS-throttle directions do NOT apply)
1. **Cheap, high-impact:** make `cell_physics_bsp()` hand out `Rc<…Bsp>` so `build_cell_inner`'s
   `.cloned()` is an O(1) refcount bump instead of a deep BSP tree copy — kills the dominant
   `BspNode::clone` + `dlmalloc` cost. (`capped-build wasm-pack --release` after.)
2. **Proper (retail-residency):** persist the built-cell cache **across** transitions per landblock
   instead of a fresh `SceneWorld`+empty cache each tick — the refcounted DBOCache pattern, same idea
   as the already-landed thread_local triangulation memo for meshes.
3. **Separately:** keep the explorer from pathing back into the un-egressable Night Club (egress /
   explorePressure), and reset the `Vendbot` saved Location to Holtburg (see spawn-fix procedure).

### Spawn-fix + ACE-restart procedure (verified this session)
The saved `Location` (shard DB `biota_properties_position`, `object_Id=1342177603`, `position_Type=1`)
must be edited **while ACE is DOWN** — a running ACE serves a *cached* biota on re-login and re-saves
the live position on every logout, defeating a DB-only edit. Steps:
1. Kill the client (Vendbot logs out). 2. `echo exit > ~/ace_stdin.fifo` (graceful shutdown; `exit`
= `ShutdownServerNow`). 3. Wait for UDP 9000/9001 to close. 4. `UPDATE biota_properties_position`
set `position_Type=1` row := the `position_Type=4` (Sanctuary = Holtburg `0xA9B40019 [84,7.1,94]`)
row. 5. Restart ACE cold: `mkfifo ~/ace_stdin.fifo; setsid tail -f /dev/null > ~/ace_stdin.fifo &;
cd $ACERT && setsid nohup dotnet ACE.Server.dll < ~/ace_stdin.fifo &`. 6. Relaunch client → cold
cache reads Holtburg from DB. Helper scripts left in `/mnt/wbterminal2/stream/`: `start-ace.sh`,
`launch-headless.sh`, `recover-headless.sh`, `probe.cjs`, `netrate.cjs`, `cpuprof.cjs`, `console.cjs`;
corrupt-row backup in `spawn-fix/`.

### Artifacts
- `apps/holtburger-web/pkg-prof/` (`--profiling` wasm, names KEPT) — deploy into `pkg/` (back up
  `pkg/` first; a copy of the release build is at `/mnt/wbterminal2/stream/pkg-release-backup/`),
  clear the game profile HTTP cache, reload, then `node cpuprof.cjs` (5s CDP CPU profile → named
  self-time frames; works even while the page main thread is frozen). **Restore the release wasm
  after** — the profiling build is ~6MB and boots slowly under SwiftShader.
- `/mnt/wbterminal2/stream/cpuprof.cjs` — the reusable named-profile catcher (supersedes the
  index-only `freeze-profiler.cjs` once `pkg-prof` is deployed).

<details><summary>ORIGINAL (INCORRECT) diagnosis — retained for history</summary>

> ~~**Root cause: a WASM resource-streaming / fetch storm.** Trigger: the cruise fix's long routes;
> compounded by a "corrupted" corner spawn `lb=0x0007`.~~ Struck: the freeze reproduces headless,
> stationary, 0 req/s; `0x0007` is a valid dungeon, not corruption; the cruise fix is not the trigger.
> ~~Fix direction: cap cruise route span 220m→60m, rate-limit landblock streaming, spawn to a
> populated area.~~ Only the "move the bot out of the dungeon" part was directionally right (for a
> different reason — it removes the BSP-clone load, not a fetch storm).
</details>

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
  freeze, which is **BSP-clone-bound on the main thread**, not decode- or fetch-bound). launch.sh +
  STREAM-RIG-OPS updated.

## Next-session checklist
1. **Fix the P0 (§P0 CORRECTION):** `Rc<Bsp>` in `cell_physics_bsp`/`build_cell_inner` (kills the
   `BspNode::clone` storm) and/or persist the built-cell cache across transitions. `capped-build
   wasm-pack --release`, then re-verify in the Night Club with `cpuprof.cjs` (hot-loop gone) and a
   Holtburg control (eval RTT ~5 ms). The old cruise/streaming throttle is NOT the fix — skip it.
2. **Reset the spawn** to Holtburg via the spawn-fix + ACE-restart procedure (§P0), and stop the
   explorer pathing back into the Night Club (egress / explorePressure).
3. Relaunch: `bash /mnt/wbterminal2/stream/launch.sh` (bakeWorker=1, all fixes auto-deploy on a
   fresh boot) → `go_live.sh &` → bring up the monitors → watch moving% + freeze cadence.
4. Live services this session were all UP on the laptop (ACE UDP 9000/9001, serve.py :8765,
   wsbridge :8080, rynthnav :8767).
