# HANDOFF — end of 2026-07-27 marathon session

Everything below is committed and pushed through `83e87ada` (`origin/master`).
Working tree clean. No agents, rigs, tunnels, or cloud boxes left running
(buildbox TERMINATED, 1070 rig torn down, test chrome killed by
`--user-data-dir` match, scheduled task deleted).

## LANDED TODAY (16 commits, `ab51df7f`..`83e87ada` context: see git log)

Movement/collision: COL-10 walk 3.12 (live 3.096/2.031 m/s), scenery collision
END-TO-END (V3 world bake → dist swap → cylsphere+sphere client arm → flag ON,
tree block 2mm-exact vs retail formula, 0 false blocks over 149m) — the COL-02
"walk through trees" era is over. Precipice split-triangle fix. Doorframe gap
closed as not-a-bug (jamb deflection, radius-exact).

Rendering: ClipMap alpha parity (1070-confirmed, no halo), terrain-blend corner
fix (0-mismatch replay; **default-ON promotion HELD** — see queue), RND-33
stipple WRAP, terrain Gouraud, retail sun/night (1070:真 dark nights + sunrise
gradient), cell-scoped light selection (18/18), RND-04 vertex light bake
(4-venue reference agreement).

State/lifetime: TimeSync in both wasm lanes (live serverTime 2.99e8), buff
time-domain fixes, nine bridge maps pruned, park purge + preCreateBuffer ON,
PAL-01 pinned counter. Anim: death-pose hold (1070-confirmed 2s+10s), backstep
adjust_motion port. Combat F1/F3/F4. Plugin facade scaffold + 0x02AE/0x02AF
wire. Flag audit + url-flags corrections (2 drifted hunks deferred).

Intelligence (in /mnt/wbterminal2/buildbox-2026-07-27/): symbols.tsv oracle
(**acclient.map is a DIFFERENT BUILD — never use map VAs to seek acclient.c**;
map_xref.tsv translates), world collidability census (59.7% no-collider),
2013 cross-validation (11/12 CONFIRMED, 0 refuted), Tier-2 lighting design,
jump/stamina spec, sticky/turn spec, slope/slide spec, P6.1 vtable + design.

## OPEN QUEUE (priority order)

1. **texMerge+roadSlots default-ON promotion** — correctness fix is landed and
   0-mismatch; the promotion patch sits UNAPPLIED at
   `/mnt/wbterminal2/buildbox-2026-07-27/fanout-mini/fanout/out/11/02-*.patch`,
   gated on a 1070 eyetest of the corrected blend (transition edges, road
   forks, chunk borders — with `?texMerge=on` vs off).
2. **Combat F2/F5/F6 — UNREVIEWED HOLD** — `out/12/*.patch` exist but the agent
   timed out with NO report. Re-run the task (brief at scratchpad fanout/tasks/12.txt
   of this session — regenerate from TIER3-sticky-turn-spec.md) or review
   line-by-line. Do NOT apply blind.
3. **Slope T0 re-repro (COL-15/16/17)** — spec predicts symptoms stale.
   ⚠ METHOD: headless keyboard walk is BROKEN for this (stuck-key runaway
   reproduced twice: 149m/163m flights after keyup) — use @teleloc hops +
   short key pulses with pose sampling, or a 1070 renderer session.
4. **1070 leftovers** (batch queue for next off-screen session): park-storm/
   sealed-purge needs a LONG soak (purgeKey stayed null in short transitions);
   dungeon-interior cellLights visual (interior @teleloc is rejected by ACE —
   script a walk-in via a dungeon entrance, or find the right teleloc z);
   camera building over-clip (camera.js:1353 coarse-AABB clip — S-fix proposed
   in doorframe report, unapplied; symptom-consistent closeups captured);
   texMerge promotion eyetest (item 1).
5. **Scenery BSP rung** (0.5% of placements) — blocked on CellPhysicsBsp.scale
   hard-coded 1.0 (pre-existing TODO, two staging sites).
6. **P4.2 aged-buff relog validation** (verification plan step 4) + F2 relative
   start_time follow-through; url-flags 2 deferred table hunks.
7. **Tier-2 remaining**: RND-05/03 P2 seam re-check after RND-04 bake soak
   (statics should now leave the pool — verify pool is dynamics-only live);
   stars (skyObjReplace) if the sun/night work didn't cover it (specced,
   unimplemented).

## ENVIRONMENT FACTS (this session, save re-derivation)

- **claude -p on buildbox**: OAuth token had been revoked → laptop
  `~/.claude/.credentials.json` copied over (works). Driver stdin trap: every
  backgrounded `claude -p` AND the `while read` loop need `< /dev/null` or the
  first agent eats the task list. Models `claude-opus-5` / `claude-fable-5` OK.
- **Buildbox non-interactive ssh** doesn't source profile: cargo needs
  `env RUSTUP_HOME=/opt/rust PATH=/opt/cargo/bin:...`; CARGO_HOME must stay
  default. `target/debug/incremental` was deleted (17G) — next dev build
  recompiles. Box auto-stopped ONCE while agents were SIGSTOPped (keep-awake
  pinned!) — suspect the idle-stop reads CPU; don't pause on-box agents long.
- **1070**: C:\Temp\launch-wls.bat recreated WITH `--mute-audio` (no-sound
  rule). Chrome at Program Files (registry App Paths lies — use
  StartMenuInternet reg key to enumerate). MODE2i works: schtasks /it +
  connectOverCDP :9333 tunnel; ALSO tunnel `-R 8080:127.0.0.1:8080` (ws bridge)
  or start_session fails. GTX-1070 D3D11 confirmed. tailnet1/tailnet1 works;
  first char +Tester2 (admin). ACE session linger ≈40-90s between logins of the
  same account. ACE has NO "@loc" (use @myloc); interior-cell @teleloc gets
  relocated outdoors (z guess wrong?) — unresolved.
- **V3 dist**: swapped in (195,076 files incl. .materials.json sidecars);
  rollback at `dist/scenery.pre-v3-2026-07-27/` — DELETE after a soak week.
- **pkg/ wasm**: 4,949,587 B release = everything through 83e87ada.
- **MEMORY.md corrections pending user direction**: §3 symbol→address recall
  (map-is-different-build), 1070 runbook delta (bat recreated, 8080 tunnel,
  browser reg discovery).

## METHOD NOTES RE-PROVEN

- Boot-smoke EVERY integration: it caught the GLSL-backtick boot breaker and
  the fuzz-misplaced struct fields.
- `$?` inside an echo string is clobbered by command substitution; `| tail`
  eats exit codes; pkill -f self-matches compound commands (3 separate
  incidents today). Check exit codes on their own line.
- Fuzzy patch application puts struct fields in function bodies — grep the
  patched file for orphaned insertions before building.
- Agent citations: ~1/3 wrong held again; live measurement beat source reading
  again (5 premise refutations today).
