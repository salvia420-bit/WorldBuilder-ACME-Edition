# HANDOFF — the explorer-mode performance loop (2026-07-19)

How to turn the new EXPLORER soak mode into a self-feeding performance-
improvement loop. Written at the close of the soak-15-pickup session (see
`RESULTS-navatlas-soak-15-pickup-2026-07-19.md` for everything that landed
today). The explorer soak is LIVE right now (phase4demo/WasmDemou8wvi3,
kiosk CDP :9223, YouTube stream up).

## Why the explorer is a perf instrument

The grind soak parked in one hunting spot; the EXPLORER'S WHOLE JOB is to
keep entering content it has never seen — novel landblocks (cold-load
streaming stress), towns (static/scenery density), dungeon and portal
transitions (EnvCell graph builds, the historically perf-hostile Town
Network interior). It autonomously FINDS the places where the client
hurts, and its journal + pos trace is a map of where. Two roles, cleanly
split:

- **DISCOVERY (LLM, streamed, cheap-ish):** the explorer roams; a sampler
  alongside bins perf by landblock. Output: a ranked league table of the
  worst content.
- **MEASUREMENT (deterministic, no LLM):** record a named "perf tour"
  route through the top offenders (+ a healthy control stretch) and
  REPLAY it per build. Task 17 (portal-aware record/replay, fmt v2) is
  the enabler: a tour can now cross portals and dungeon interiors and
  replays like-for-like — same path, same content, every iteration.
  `rynth/testdata/v16_arwic_holtburg_route.json` is the first such route
  (Arwic → Town Network → Holtburg) and already covers the worst known
  offender.

## The loop

1. **SOAK** (hours, explorer persona): kiosk URL
   `…&bot=1&botModel=z-ai/glm-5.2&botInterval=1&botPersona=explorer&botKernel=off`
   — kernel OFF (no combat/vitals noise in the profile), indestructible
   prompt (never heals — an admin char). Run the perf sampler alongside
   (design below). Stream to YouTube if wanted — but see rails.
2. **RANK:** aggregate sampler output per landblock/transition; append to
   a league-table doc in the repo (create
   `docs/rynth-integration/perf-league.md` on first run). Seed entries
   that need no soak to know: Town Network interior (sim crawls 0.1–1 m/s
   — survived many directed sessions; now deterministically reachable via
   the v16 route), the 5,400-singleton anim-scenery wall
   (memory/holtburger-perf.md — instanced anim-scenery is the NEXT
   roadmap item there), marketplace freeze (historical WIP d702fb7a,
   unmerged).
3. **TOUR:** extend/record a named atlas route `perf-tour-vN` visiting
   the current top offenders. Record by driving the explorer (or a
   scripted goto chain) through them once; `name_route` it; the atlas
   mirror persists it on disk.
4. **FIX:** top offender only, one at a time. Rust-first
   (perf-maintainability rule: system work in Rust, not JS); the
   residency roadmap in memory/holtburger-perf.md is the standing
   direction (instanced anim-scenery → DBOCache → slot grid → park).
   Keep 2 Opus implementers on fixes in worktrees while the lead owns
   measurement + merges — the pattern that shipped 17 tasks today.
5. **MEASURE:** replay `perf-tour-vN` on OLD vs NEW wasm, sampler
   attached, and diff the percentiles. Rules: fresh `--user-data-dir`
   per arm (shader cache warms arm 2); `--release` wasm ONLY (`ls -la
   pkg/*.wasm`, ~4.5MB, dev is a 4× tax); ffmpeg/stream OFF during
   measurement arms (x11grab+encode costs CPU); laptop SwiftShader arm
   measures the CPU/submission side, the 1070 measures the GPU side
   (batched, per fleet rules; off-screen only).
6. Loop. A `/loop` or cron cadence works: soak overnight (drain caps ON —
   see rails), rank+fix+measure by day.

## Sampler design (the traps are the design)

Collect IN-PAGE, emit via console lines, timestamp on arrival — a CDP
driver must NEVER time anything by evaluate round-trips (retraction in the
RESULTS doc: evaluate RESPONSES starve for tens of seconds on a busy
renderer; console events stream fine). Sketch:

- An injected rAF-adjacent collector: frame-time ring buffer (p50/p95/p99
  + worst), `performance.memory.usedJSHeapSize`, draw/triangle counts
  (`renderer.info` with `autoReset=false`, read cumulative, diff ÷
  frames), `terrainBakedLbs.size` (streaming progress; stalls = cold-load
  cost), current pose landblock (bin key). Emit one `[perfsample]` JSON
  console line every ~10s; the driver appends to a JSONL on disk.
- `window.liveScene3d` is a one-time snapshot set ~35s after in-world —
  poll not-null before touching it; late-stamped subsystems read null
  forever.
- `wireframe=1` SKIPS sky/composer/CSM/shadows — a wireframe soak
  profiles the statics/geometry/submission path only. Run discovery in
  wireframe (stream-friendly, cheap) but run at least one measurement arm
  in DEFAULT render so shading regressions aren't invisible.
- The kiosk targetFps=20 caps the ceiling; for measurement arms prefer
  uncapped or a higher cap so improvements are visible above the cap.

## Cost & safety rails (all live-proven today)

- Drain protection: `rynthAiOperatorStop` localStorage latch — set by
  `rynthAI.stop()`, honored by every (re)boot; `?botAi=off` = bot with no
  LLM at all. The measurement half of the loop needs NO LLM: replay is
  `followRoute`, not the director.
- `?botKernel=off` keeps grind loops from ever starting (and goto/
  followRoute keep it off — wasRunning).
- Account-In-Use: after any relaunch, ACE's server-side logout takes
  ~40s+; park 75s before re-login (soak_launch.cjs pattern in the session
  scratchpad — re-create from this doc: clear latch [+ wipe
  `holtburger_ai_journal_v1`/`holtburger_ai_scratchpad_v1` for a fresh
  mind], park, navigate, verify `__bot`+`rynthAI`, leave director on).
- The chrome-devtools MCP plugin auto-launches an about:blank Chrome that
  lands INSIDE the x11grab frame — kill by
  `pgrep -f 'chrome-devtools-mc[p]/chrome-profile'` (bracket!) if the
  stream shows a blank overlay; drive the kiosk with playwright-core
  (`~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`) instead.
- Stream stop: `touch /mnt/wbterminal2/stream/STOP` +
  `pkill -f 'ffmpeg.*rtmp[s]'`. Soak stop: `rynthAI.stop()` +
  `__bot.stop()`.

## First concrete iteration (recommended)

The Town Network is the highest-value target and needs no discovery pass:
1. Sampler + replay of the v16 route (laptop, wireframe arm + default
   arm) → baseline JSONL committed.
2. Fix candidate: profile WHY the interior crawls (suspects: EnvCell
   render-set BFS churn per frame, the un-instanced statics path indoors,
   physics BSP hot loop). The doorway-wedge data (RESULTS doc) shows sim
   speed collapsing indoors specifically.
3. Re-measure the same replay; if the sim speed rises, the acceptance
   route gets faster for free — visible end-to-end metric (route wall
   time is itself the headline number: v16 did Arwic→Holtburg in ~3.5
   min; v10's transit alone burned 11).

## State at handoff

Everything on origin/master through `5b78006f`; working tree clean (the
`external/holtburger/target` symlink to /mnt/wbterminal2 is intentionally
untracked). Live: explorer soak (phase4demo), YouTube stream, full-map
seal-fixed tiles on :8767, ACE/serve/wsbridge/MySQL, 15-min health
monitor. Buildbox stopped. All 17 session tasks complete.
