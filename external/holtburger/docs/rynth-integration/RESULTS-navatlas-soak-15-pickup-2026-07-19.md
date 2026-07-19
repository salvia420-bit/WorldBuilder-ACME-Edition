# RESULTS — soak-15 pickup session, 2026-07-19

Executes the PICKUP list of `HANDOFF-navatlas-soak-15.md`. Fable solo (no
subagents). TL;DR: pose fix round 2 is merged, built, and **live-proven** —
the NULL-cell bug is dead. Phase-2 acceptance is **still blocked**, but by a
different, now fully root-caused defect: the Arwic wall is real geometry the
nav bake fails to carve (crop-plot lattice in C6A9). Everything provable
without the cross-map route passed.

## Done

1. **Full suite on round-2 branch** (`57dc89c5`): 564/564 in 7.17s.
   (First run SIGBUS'd the linker — root disk was 100% full; fixed by moving
   the 39G main `external/holtburger/target` to
   `/mnt/wbterminal2/holtburger-scratch/target-main` with a symlink back.
   Incremental caches preserved; root now ~65%.)
2. **Merged to master** as `a6fb9b26`, pushed. Release wasm rebuilt
   (4.8MB, wasm-opt) in the live tree; pre-round2 pkg wasm backed up to
   `/mnt/wbterminal2/holtburger-scratch/pkg-backup-pre-round2.wasm`.
3. **Rig verification — PASS.** Kiosk chromium CDP :9223 (survived from
   soak-15). Note: first reload hit the known "Account In Use" boot-both
   race (ACE log 15:14:55) — wait for the server-side logout, reload again.
   - vendortest/+Vendbot: 30 idle pose reads over ~45s, cell `0x860201AD`
     from read #0, never 0, exactly matches the shard DB's saved Location.
     (Handoff's "parked ~C6A9 (78,18)" was stale — Vendbot is saved in the
     academy now.)
   - navatlas15/+Navatlas (the deterministic seed-race repro account):
     fresh verified login 15:23:13, same result — never 0 from the first
     frames, idle, no inbound heals needed. **The round-2 read-chokepoint
     heal works.**
   - Movement: `@telepoi Arwic` outdoors, then short `__bot.goto` hops
     (±0.2 ns): DONE, arrival within 2.6m, zero NULL cells throughout,
     repeatable. No grind, no x-oscillation.
4. **Acceptance components proven on the fixed client:** goto → arrival →
   auto-record journal note ("route recorded: …") → route in
   `window.__atlas` → `followRoute` reuse of a recorded route (reversed,
   after teleporting to its endpoint): `{ok:true,state:"DONE",legsWalked:2}`.
   `_metrics`: distanceM 308, routesRecorded 2.

## The Arwic wall — recurs on the fixed client, root cause found

The handoff's warning was right: C6A9 mesh-fidelity conclusions were
pose-bug-contaminated and needed re-test. Re-tested: **the wall is real and
it is not the pose bug** (zero NULL cells in every failing run).

`__bot.goto({ns:42.1,ew:33.6})` (Arwic→Holtburg) fails every time:
`retries exhausted`, 3 identical replans of a 32-leg / ~2240u / portals=4 /
coverage=mixed plan. Console: leg 1 → C6A9 (84,104) arrives; leg 2 →
(84,82) times out without progress; replan from the same pose reproduces the
same plan. The plan heads EAST from Arwic center because it routes through
the **Arwic Town Network portal hub**; the approach threads the farm belt.

Evidence (WB.Terminal, RetailSmoke project):
- Terrain along x=84, y=82..104 is flat (height 42) — no cliff.
- The farm is a regular ~24m-pitch grid of crop-plot objects
  (`0x01002D21`/`0x01002D23` GfxObjs + Setup `0x02000322` posts); render
  `scratchpad/c6a9.png` shows the lattice. Leg 2's line (local x=84) passes
  directly through grid objects at world (38100,32532) and (38100,32556);
  the leg target (38100,32530) is essentially inside one.
- `0x01002D23`'s physics vertices span ±6.8–7.2m — each plot is a **~14m
  solid collider**, leaving ~10m gaps in the lattice. The movement sim
  (correctly, per DAT collision) refuses the straight line; the nav tiles
  mark the field walkable, so the planner never routes around, and replans
  are deterministic → retries exhausted.

**Conclusion: W1 bake gap — landblock-static crop-plot objects (and likely
their whole object class) are not carved into the obstacle tiles at C6A9
(and presumably other farm towns).** The client has no portal-avoidance
route option (`POST /route` body is bare `{from,to}`), so every Holtburg
goto from Arwic re-enters the blocked portal-hub approach.

Secondary observation (separate, lower priority): under the kiosk flags the
rynth router's "30s" leg timeouts and full 3-attempt replan cycles elapse in
<100ms wall clock, and walk legs complete as large-dt leaps. Timeouts appear
to run on the host tick clock, not wall time — worth a look at whether
watchdogs should use wall clock, but it only compresses the failure, it
doesn't cause it.

## Still blocked / next

1. **Carve the C6A9 (and same-class) crop-plot objects into the nav bake**
   (agent-A territory; the sweep/fullmap verify machinery from W1/W3 is the
   place to add a regression probe), OR teach the sidecar a portal-avoid /
   replan-with-blacklist option so a failed leg poisons its tile.
2. Re-run Phase-2 acceptance (Arwic→Holtburg goto → arrival → auto-record →
   follow_route) — everything else already passes.
3. LLM soak window — blocked behind the same route.

## Environment at close

ACE (:9000/9001), serve.py :8765, sidecar :8767, MySQL, kiosk chromium
CDP :9223 all still up. Director STOPPED. navatlas15/+Navatlas is the
logged-in char, parked ~C6A9 (14.9,50.4) [cell 0xC6A90003]; vendortest
logged out (saved in academy 0x860201AD). Main-repo cargo target now lives
at /mnt/wbterminal2/holtburger-scratch/target-main (symlinked). CDP driver
scripts for this session are in the session scratchpad (rig_verify /
rig_move* / rig_accept*.cjs) — they re-create in minutes from this doc if
wiped; playwright-core at ~/.npm/_npx/e41f203b7505f1fb works fine over
:9223 (Runtime.evaluate did NOT starve this session; paused-eval fallback
unused).
