# Handoff — playtester soak, session 5 (indoor door-waypoint legs)

Continues `HANDOFF-playtester-soak-4.md`. This session executed §5.1 of that
handoff — the indoor-router leg wiring for cross-room pursue/use, the last
mobility wall (§0.4) — and found two more load-bearing bugs under it, each
live-diagnosed against a soak boot. Three commits; a v6.2 run is live as of
this handoff.

## 0. What shipped (commits, in order)

1. **`6b23851a` — indoor door-waypoint routing in the pursuit path**
   (`rynth/ai/tools/world.js`). `use_object` / `give_item` / `goto_object`
   detect a cross-cell indoor target (both endpoints EnvCells of the same
   landblock, different cells), A* the EnvCell portal graph
   (`rynth/indoor_router.js` — already fully built, this was the deferred
   wiring), and walk doorway-midpoint + cell-centre legs via
   `bot.router.follow()` with the kernel paused exactly like `bot.goto()`.
   Final leg = the target's own position; the trailing PursueObject +
   pose-settle watch is unchanged. Walk tags: `routed(N)+settled`,
   `route-failed(w/N)`, `route-timeout(w/N)`, `route-cancelled(w/N)`.
   Degrades to straight pursuit on every edge (outdoors, same cell,
   cross-landblock, no router, goto active, drop-gated path, any error).
   Doorway midpoints ON from day one (`toLegs {midpoints:true}` — the C#
   anti-corner-cut waypoints; wall-clipping was the failure mode).
   Graph cached per landblock; `bot.indoorGraph` injection wins (tests).

2. **`bd35f250` (half 1) — router phantom-arrival fix** (`rynth/router.js`).
   The `ps.last === 2` secondary arrival signal read the webhost snapshot
   latch, which is NEVER reset by a new movement command — after any first
   arrival it says "arrived" forever. Academy cells are 10m; midpoint legs
   sit 2.5–5m apart, inside `arriveM*2` — so every leg phantom-advanced
   with ZERO movement (v6.0 live: `routed(4)` to a next-room NPC, pose
   unchanged, then the straight pursue wedged on the wall exactly as
   pre-routing). Now uses `ps.now` — read-clear, nonzero exactly on the
   completion tick. v6.1 live: same routes walk with real pose deltas.

3. **`bd35f250` (half 2) — position-derived route cells** (`world.js`).
   The pose objCellId LOW WORD FREEZES while x/y keep streaming — live
   evidence: `pos=` read cell 0x01AD across 60m of v5.9 wandering, so the
   A* from-cell was wrong whenever the bot had left the hub. Endpoint
   cells now derive from live positions via `nearestCell` (z-banded);
   the ids are only a degenerate-graph fallback. (The pose-cell freeze
   itself is an UNFIXED wasm/client issue — see §3.)

Tests: +13 checks in `rynth_ai_world_test.cjs` (46 total); all 19 AI
suites green (~940 checks) + navsim 28 + indoorsim 22 +
`rynth_router_smoke` live PASS. NOTE: `rynth_test_all.cjs` (the browser
battery) needs `NODE_PATH=<playwright>` or every browser suite FAILs in
0s — that's module resolution, not regressions.

## 1. Live verification (v6.0 → v6.2 boots, world-DB + DAT grounded)

- Academy geometry (WBT `get-dungeon-info` lbX=134 lbY=2, 568 cells): hub
  0x01AD origin (10,−30); 0x01B0 (Jonathan) and 0x01B6 two portal hops
  away, ~10–15m. Rooms are TINY — `routed(8)` completing in ~10s is
  genuine jogging, not phantom (post-latch-fix).
- v6.1 first check-in: `routed(4)` to the VIEW CONTROLS sign with a real
  8m pose delta (v6.0 same-shape route: zero delta). Honest failures now
  surface too (`route-failed(0/8)` seen once).
- Cross-room uses now land in range: the bot HEARD Samuel's
  armor-collection task speech within 3 minutes of boot — v5.9 got zero
  quest dialogue in 47 minutes (its uses were all silently OutOfRange).
- Shard-DB ground truth: only `CallingStoneGiven` stamped so far. The
  "Leather Cap/Gauntlets/Leggings" objects the bot keeps using are the
  training DUMMIES (creatures) — the real armor pickups are the
  linkitemgen children in 0x01B0/0x01B6 (handoff-4 §2). Cognitive gap,
  not mobility: it walks there fine now.

## 2. The live run — v6.2 (LEAVE IT RUNNING)

Same runner (session-681edab7 scratchpad `soak_run_v5.cjs`), same v5.9
config (nemotron-3-ultra-550b, 1-min cadence, maxTokens 16000,
maxActions 8), marker `bot start (v6.2 pos-cell`. Persistent Monitor
streams plans/results/tickets/INVENTORY CHANGE/EXIT TOKEN/level-ups.

### Ops learned this session
- Restarting the runner <60s after killing it races ACE's session reap:
  the new EnterWorld lands while the old character is still in world →
  client sits at char-select forever (no pose, bot files a "not placed"
  ticket). Wait for `dropped. Account: playtest_soak` in ACE_Log + 15s
  grace before relaunch.
- The runner node ignores SIGTERM (playwright cleanup) — SIGKILL by
  exact node pid (readlink /proc/$p/exe ends in node).
- Monitor boot-grep must baseline PAST the previous boot's marker lines
  (line-count offset) or bump the marker per iteration.

## 3. Next session candidates (rough value order)

1. **Watch v6.2 for the exit**: Jonathan (0x01B0) use → QuestFailure
   branch → Exit Token 29335 → give back → Holtburg teleport. All the
   mobility now exists; this is bot cognition + time.
2. **Pose-cell freeze root cause** (wasm/client): pose.objCellId low word
   sticks at the login cell while x/y stream. Breaks any consumer that
   trusts the cell id (status `pos=`, landblock-change detection in
   monitors, dungeon_nav describeSurroundings' current-cell line).
3. Doors: legs route THROUGH doorways but a closed door can still block
   the mover mid-leg (academy doors the bot opens stay open long enough;
   elsewhere may need an open-door leg action).
4. Golem → corpse → Academy Token → Training Master slow path (combat
   kernel + the new routed approach).
5. Persist scratchpad across restarts (every restart re-learns the
   academy from zero — v6.0/v6.1/v6.2 each re-did greeter+Samuel).
6. rynthnav `goto` HTTP 400 spam when indoors — route indoor goto
   requests to the indoor router (or a clear "you're in a dungeon, use
   goto_object" error) instead of the outdoor sidecar.
7. Event-driven early check-ins; corpus-from-world knowledge bake (both
   carried from handoff-4).
