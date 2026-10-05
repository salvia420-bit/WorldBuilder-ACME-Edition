# Handoff — playtester soak, session 9 (v6.5.3 readout + THE movement root cause)

Continues `HANDOFF-playtester-soak-8.md`. This session read v6.5.3 to its end
(§1), root-caused the `open_vendor` ticket into something much bigger — **local
player translation is broken at the wasm layer, three movers deep** (§3, the
real §7.3 of soak-8) — shipped the JS-side fixes that were shippable (§4),
annotated+archived all 7 tickets, and relaunched as v6.5.4 with crash
auto-relog + the streaming monitor actually running (§5).

## 1. v6.5.3 readout (Torval, GLM 5.2, 04:50–07:40 local, killed by tab crash)

- **Academy exit: SUCCESS at t+66m** — pos 0x8602 → **0xA9B40019** with a level
  burst 1→5 (tutorial XP payout, 56 credits), later lvl 7. It exited via the
  walk-out "Exit to Holtburg" (29338, never broken) — **the two repaired
  courtyard portals (31061/29334 → 0x7203) were never touched and stay
  live-unproven.**
- Academy Exit Token survived (no CONSUMED). The consumption-verdict feature
  worked in the field: Facility Hub Portal Gem journaled "still in inventory
  after use". Torval's 10,000 coins read fine all run (Varek mystery stays
  Varek-specific).
- After exiting: ~50–84 min softlocked in the Pathwarden building (indoor
  routing produced legs, the player never moved — §3), escaped via the Meeting
  Hall Portal (portals work), explored the Meeting Hall (0x0125), portaled
  back, wandered outdoors to 0xa1a4, ended unarmed at 28 HP fleeing a Wild
  Monouga. 0 kills, 30 credits unspent, no weapon — every economy path was
  gated on the vendor bug (§2).
- **Death**: `FATAL page.evaluate: Target crashed` at t+168m (07:40 local,
  10:10Z) — tab crash on the 5.2G-swap box; runner exited (no retry — fixed in
  v6.5.4, §5) and the run sat dead ~3h because the monitor was never started.
- 90 LLM calls, ~490k prompt / 169k completion, 2×60s-timeouts. GLM+pinned-fp8
  providers behaving well.

## 2. open_vendor (ticket w5h20c) — root-caused, JS side fixed

Live A/B (throwaway Developer account `vendortest`, char `+Vendbot` — note the
ACE admin "+" prefix breaks `autoSpawn=<name>`; use `autoSpawn=first`):

- Same room, ~2.6m from Barkeeper Wilomine (0x7A9B4022, tavern cell
  0xA9B40155): `useObject` → **ApproachVendor, 13 items, instantly**. The whole
  wire+wasm+webhost vendor pipeline is FINE.
- Outside the tavern (the bot's spot, outdoor cell 0xA9B40022): ACE sends
  `UseDone (success)` and **no profile** — the success-shaped silence that
  fooled the bot all run.
- **All 15 Holtburg vendors stand in indoor shop cells** (cell suffix ≥ 0x100;
  ace_world query in this session's transcript). The bot tried every one from
  outdoors or from inside a *different* building. It also tried two genuine
  vendors (Wilomine 710, Contract Broker 44186) — weenie type 12 — so "not a
  vendor" was never the issue: it was ALWAYS range.

Fixes shipped (JS, live on reload with `?nosw=1`):
- `economy.js open_vendor`: approach-walks the vendor first (shared
  `approach()` from world.js, now exported) and the failure text teaches the
  range rule ("vendors only answer in conversational range … get into the
  vendor's own room first") instead of "is it a vendor?".
- `open_vendor` desc tells the LLM vendors stand INSIDE shop buildings.
- Mock suite still 45/45 (`rynth_ai_economy_test.cjs`).

**But vendors stay unreachable until §3 lands** — the client cannot currently
walk the player into a shop room at all.

## 3. THE movement root cause (= soak-8 §7.3 + all 5 router/door tickets)

Live-diagnosed in the Holtburg tavern; repro scripts:
`/mnt/wbterminal2/holtburger-scratch/soak-v65/repro-2026-07-18/`. All three
movers the bot can reach are broken at (or below) the wasm boundary:

1. **`pursueEntity` (approach()'s old mover)**: only TURNS the local player,
   never translates — already documented DEFUNCT in url-flags.md (2026-07-06
   combat rewrite). Every soak `walk:no-walk` was this. Worse: `pursuitStatus`
   stays `active` forever (no fail edge).
2. **`stickToEntity`** (the melee run-up mover): only steps inside an active
   manual-drive slice (`advance_local_pose_for_manual_drive_slice` early-outs
   without `ActiveDriveIntent::Manual`). From standstill: target latches, pose
   frozen, even the 1s sticky timeout never ticks (proof the slice never ran).
   It works in combat only because combat holds drives.
3. **`moveToPosition`** (the router keystone): OUTDOORS translates ~2m in
   ~0.7s then stalls, `pursuitStatus` stuck 0x1 (never arrives/fails at 8m
   targets) — `global_router`'s 3s REISSUE_MS loop is the only reason outdoor
   goto "works" (0.7s of motion per re-issue ⇒ the observed crawl).
   **INDOORS (outdoor-LB building interiors, e.g. tavern 0xA9B40155): ZERO
   translation.** This is the Pathwarden softlock (tickets hg2jz8/2qtear/
   qtpzsb), the "router says DONE but pos unchanged" journal line, and door
   ticket uhf1nw's "can't walk through an opened door".
4. Manual `setMovementInput(fwd,strafe,turn,run)` (4 args!) from JS: a single
   dispatch nudges ~0.1m; re-dispatched at 100ms it crawls (~0.26 m/s
   indoors); a heading-aware bang-bang walk (repro `walk_truth.cjs`) moved
   **0.00m in 25s** in the tavern and the server-truth `useObject` after it
   still got no profile. rAF runs at 29fps in these pages; `__diag.physics`
   shows predicted==applied==server, drift 0 — the stall is inside the wasm
   movement system, not the network or the frame loop.
5. Cross-check: soak-7/8 walked ROUTES inside the ACADEMY (0x8602, a dungeon
   LB) — so indoor stepping is not uniformly dead; the dead zone observed so
   far is *building interiors in outdoor LBs* (and the outdoor stall-after-
   0.7s). Suspects for the next Rust session: the indoor
   `cell_physics_bsp_solid` solid-gate vs EnvCell physics residency for
   outdoor-LB interiors (`ensureCellContainersForLandblock` → fetchEnvCells →
   `cell_physics_index`), and whatever kills the MoveTo driver after ~20
   frames outdoors (CheckProgressMade windows? drive-intent arbitration
   stomp?).

**This is next-session candidate #1 by a mile**: one wasm fix unblocks
vendors (economy soak), indoor navigation, doors, chests, lifestones — five of
the seven tickets, and the "stuck 50–84 min" failure mode that has eaten every
run since v6.4.

approach() (world.js) now: routeToward legs → `MoveToPosition(target pos)` →
settle-watch → `StopCompletely` on timeout; falls back to pursue (turn-only)
when position/mover missing. Correct shape, inert until the wasm mover works.

## 4. Also shipped

- Ticket hygiene: all 7 v6.5.3 tickets annotated with the root cause above
  (`resolution`/`status` fields) and archived to
  `/mnt/wbterminal2/playtest-tickets/resolved-2026-07-18/`; tracker emptied
  for v6.5.4.
- Memory/process cleanup: 3 stale chrome-devtools-mcp stacks + orphaned
  playwright chrome killed (~1.6G swap back). Six idle multi-day `claude`
  sessions remain the biggest RAM holders (~2G) — user's call.
- `vendortest`/`vendortest` (Developer, account 366) + char `+Vendbot`
  (0x50000143) exist for live wasm work — teleport + vendor repro ready.

## 5. v6.5.4 (LIVE at handoff)

- Runner rewritten (`soak_run_v6_5.cjs`): whole session (boot → bot → monitor
  loop) inside a relaunch loop — on ANY throw (tab crash included): close
  browser, 20s (the ACE dropped+15s rule), relaunch, re-seed scratchpad from
  the mirror file, restart bot; cap 24 relaunches; deadline-based t+ math.
  Key now read from `$SP/.orkey` (durable copy).
- `monitor_v65.sh`: FATAL is no longer terminal (reports each new
  FATAL+relaunch); terminal = soak complete / giving up / runner death. Runs
  under the Claude Monitor tool this time.
- v6.5.3 artifacts archived as `*.v653.txt`; status/stdout truncated.
- Torval carries his scratchpad (it correctly believes open_vendor was bugged;
  the new error text will re-teach the range rule if he retries).

## 5.1 v6.5.4 first-ticks watch item (observed live at handoff)

Torval's relog after the crash reads `lvl=1 cred=0 coins=5000 inv=16` from
t+1m through t+3m (was lvl=7, 30 credits, 10,000 coins, inv=18 at crash),
while his VITALS are the leveled pool (HP 27/28, not the lvl-1 15/15). So the
entity is fine but `playerStats().levelInfo`/skill credits read empty and half
the pyreal stacks (5,000 of 10,000) never streamed — **this generalizes the
"Varek coin mystery" (soak-8 §7.2) to any relog of a crash-saved character,
and it looks like a THIRD level-wipe path the §1.5 fix doesn't cover (fresh
wasm instance ⇒ the PlayerDescription stash is empty; the TotalExperience
fallback didn't fire either).** The bot is otherwise functional and moving.
Fold into candidate #4 below — it's now reproducible on demand (relog Torval).

## 6. Next-session candidates

1. **The wasm movement fix (§3)** — start from the repro scripts; fix indoor
   translation + the outdoor 0.7s stall; then rerun `vendor_fix_live.cjs`
   (expects walk:settled + 13-item profile from across the tavern) and the
   soak's economy arc is unblocked.
2. Read v6.5.4 to its end (did auto-relog fire? token intact? outdoor hunting
   viable unarmed→armed once vendors work?).
3. Exercise the repaired courtyard portals (31061/29334 → 0x7203) — still
   unproven; a control char + `@teleloc` into the academy courtyard would do.
4. Varek pyreal-stream mystery (unchanged, soak-8 §7.2).
5. Content follow-ups (unchanged, soak-8 §7.5): export the §2 SQL patches;
   decide on the other 472 consume-on-use gems.
6. holtburger-core: the 10 stale movement tests (handoff-7 §5) — likely
   TOUCHES the same movement system as §3; do them together.
