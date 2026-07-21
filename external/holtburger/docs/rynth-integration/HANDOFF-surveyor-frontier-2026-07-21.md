# HANDOFF — the Surveyor: deterministic coverage/frontier/loop nav re-engineering (2026-07-21, session 5)

Follow-on to `HANDOFF-metanav-2026-07-21.md`. This session re-engineered the rynth
explorer harness so the **harness** owns "where am I / where have I been / where to
go", instead of trusting the LLM's fragile note/scratchpad memory. Motivated by a live
failure: the phi-4 explorer wedged in one Holtburg shop, repeatedly "looking up
Qalaba'r" (a town at the opposite corner of the map) and re-poking the same NPCs, while
the ExplorePressure sweep revisited the same cells forever with no escape.

Design spec: `DESIGN-surveyor-frontier-2026-07-21.md` (read its VALIDATION COROLLARY —
it overrides the body). Suite: `node rynth_test_all_node.cjs` from `apps/holtburger-web`
→ **39 passed / 0 failed / 2 skipped** (was 37/0/2; +2 new test files, 105 assertions
in `rynth_explore_memory_test.cjs`).

## What landed

**1. `rynth/ai/explore_memory.js` (NEW) — the coverage/frontier/loop core.** A pure-JS
`ExploreMemory` fed the pose every tick + every check-in. Quantizes world pos to a tile
grid (`TILE_M=12`, z-band `floor(z/6)` so upper floors are distinct tiles). Public API:
`observe(pose)`, `current/previous/here/was`, `variation()` (revisit count = the
"redundancy"), `frontier()` (nearest UNVISITED tile = the "deviation" that drives the
planner), `loopVerdict()` (severity 1/2/3 ladder: revisit≥3 / ≥5 or A↔B oscillation /
≥8 or stalled-in-landblock), `coverage()`, `townFrontier()`. Replaced the four scattered
`_visitedCells` trackers. `observe()` de-dupes consecutive same-tile calls (dual-driver:
director check-in AND ~5-15s pressure tick share one instance at
`bot.ai.extensions.exploreMemory`).

**2. `rynth/ai/extensions.js` — the LOCATION block.** Collapsed `loopWarning` +
`coverageLines` + `stallLine` into ONE authoritative deterministic block injected first
in `observe()`: `Here / already tried here / Was / Covered / Frontier / CORRECTION`.
CORRECTION only fires on `loopVerdict().looping`, escalating by severity.

**3. `rynth/bot.js` ExplorePressureController — frontier-directed escalation ladder.**
local frontier hop → exit-building (`dungeonNav.exitRoute` + `bot.travel`) → adjacent-
landblock hop → on-foot directed walk toward the nearest unvisited-town **bearing**.
**No telepoi / teleport anywhere** (operator constraint — teleport-cheating defeats
autonomous nav). Graceful fallback to the legacy revisit-sweep if `ExploreMemory` is
absent. 58/58 tests.

**4. `rynth/ai/director.js` EXPLORER_SYSTEM_PROMPT + Surveyor personality.**
LOCATION-is-ground-truth, an anti-far-place-fixation rule (kills the Qalaba'r class
generally), memory recast (harness owns position; `note` = findings/color only), and the
deadpan "Surveyor" voice baked into the prompt (the `cfg.ai.persona` object slot is
unusable under `botPersona=explorer` — key collision).

## Cell taxonomy fix (operator briefing — the real root of "Qalaba'r")

AC cells are three kinds and the harness must not conflate them:
- **Outdoor LandCell** (objCellId low16 `0x01..0xFF`): 24×24 terrain, walkable.
- **Building-interior EnvCell**: an interior cell inside a town's OWN landblock, so its
  world coords sit right on the town (~0.4 units away).
- **Dungeon/apartment EnvCell**: parked in the ocean regions (a vertical bar in the left
  ocean, two horizontal bars in the south ocean, a square in the interior ocean),
  deliberately unreachable overland (portal-only) to prevent proximity-fellowship /
  level-gate exploits. Its landblock coords are a PARKING SLOT, not a real location.

The "Qalaba'r" mislabel was the town resolver naming a **south-ocean parked env cell**
(the training academy, lb `0x8602`, ns≈−102) after the nearest surface town 31 units
away — and the model wrote that into its scratchpad goal. Fix (`explore_memory.js`):
`townNameAt` now applies a `TOWN_AT_DEG=4` threshold (parked env cells are always tens
of units from every town; building interiors ~0.4). New `classifyPlace(cell,wx,wy)` →
`{kind:'outdoor'|'building'|'dungeon', town, lb}`; the LOCATION Here line renders it
truthfully — e.g. "inside a dungeon/apartment (env cell 0x…, landblock 0x8602) —
portal-only, NOT reachable overland; there is no surface town here." **Verified live.**

## Academy cell-0 / death-respawn bug (diagnosed, harness hardened)

Live symptom: after the character DIED and returned to the training academy,
`getLocalPlayerPose()` returned `objCellId=0x0` persistently, and both client and harness
collapsed cell-0 into "outdoors" (only EnvCell-or-outdoor branches exist). Diagnosis: a
known/mostly-fixed class (death-teleport into an EnvCell leaving objCellId 0) — four
2026-07-19/20 commits in `crates/holtburger-world/src/state/mutations.rs:212-259,858-932`
+ `spatial/scene.rs:3027-3053` heal it, with a passing regression test
(`state/tests.rs:1893-1954`); on-disk wasm postdates them. Leading remaining suspicion:
a death-specific gap (ACE sends a "fake" destination `UpdatePosition` then reverts
`Location`, `Player_Location.cs:690-694`; if the client sequence-gate drops it, no pose
layer heals → persistent 0). Confirm via packet capture around a death.
**Harness hardened regardless:** `ExploreMemory.observe()` no-ops on cell-0 (holds last
good tile); LOCATION renders "position unknown (respawn/streaming gap)"; and a distinct
"unresolved" branch (not "outdoors") added in `indoor_router.js` (`isUnresolvedCellId`),
`dungeon_nav.js:310` exitRoute, `actions.js` goto gate.

## Stream-rig incident + ops notes (cost real time — record so it doesn't recur)

- Driving the live kiosk via the `chrome-devtools` CLI daemon: **cycling
  `stop`/`start --browserUrl :9223` during a boot gap makes the daemon give up on
  attach and launch its OWN "Chrome for Testing"** (`~/.cache/chrome-devtools-mcp-cli/
  chrome-profile`, a Playwright chrome). That windowed browser then sits on `:0` over the
  kiosk and shows on stream, and double-logs the account. Recovery: kill it
  (`pkill -f chrome-devtools-mcp-cli` / `-f ms-playwright`), `chrome-devtools stop`, then
  a clean `launch.sh` relaunch. **Rule: attach ONCE when :9223 is stable; never cycle the
  daemon mid-boot. Verify via X11 `scrot`/`wmctrl`, not by re-attaching.**
- **A fresh `launch.sh` relaunch loads HTTP-cached (stale) JS** — nosw=1 does not bust the
  HTTP cache. To deploy edited harness JS, clear `profile-game/Default/{Cache,Code Cache,
  GPUCache}` before relaunch (script: `scratchpad/relaunch_clean.sh`). It does NOT clear
  Local Storage (the OpenRouter key + the AI scratchpad live there) — so **a stale
  scratchpad survives a relaunch** and can re-anchor the model on an old goal; wipe it via
  `localStorage.removeItem('holtburger_ai_scratchpad_v1')` + `state._scratchpad=''` (state
  at `bot.ai.extensions.state`) when the grounding changes.
- `navigate_page --type reload` on the kiosk left it `about:blank`; `--type url <full
  URL>` reliably re-lands the game. Corpse-collide error-boot on relaunch is normal —
  reload once after the ~60s ACE reap.
- ffmpeg push (`go_live.sh`) is independent of chromium; killing/relaunching the game does
  NOT roll the YouTube URL as long as ffmpeg stays continuous (it ran continuously ~2h
  through this session).

## Open items / next steps

1. **Bot is stuck in the starter training academy** (portal-only dungeon) after the
   death respawn. The harness now correctly SEES this (WEDGED CORRECTION, "portal-only")
   and tries `exit_building`, but the academy exits via a PORTAL, not terrain — verify the
   director finds/uses the exit portal (`use_object`) over the next check-ins; it may need
   a one-time operator nudge out to resume town exploration.
2. **Nav must not route overland toward ocean-parked env cells** ("can't get there without
   a portal" blocker). `frontier()`/landblock-hop currently trust world-coord adjacency;
   add awareness that parked-env-cell landblocks are portal-only (not walkable neighbors).
3. Confirm the death-path cell-0 gap with a packet capture (item under "Academy bug").
4. Re-verify the Qalaba'r class is gone over a clean soak now that the scratchpad is wiped
   and the LOCATION block is corrected.
