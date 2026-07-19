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
the **Arwic Town Network portal hub**; the approach crosses the town's
fortification wall line.

**The blocker is literally Arwic's stone city wall.** Identification
(follow-up research pass, same day — supersedes the first-draft "crop plot"
guess): the blocking models `0x01002D21`/`0x01002D23` belong to the
`0x01002D20–2F` family, a modular wall kit near-unique to Arwic:

- `2D20/2D21` — 24m-wide wall segments, 7.2m tall, 46 physics polys.
- `2D22` — 24m-wide, **30.9m tall** (wall-with-tower piece), 189 polys.
- `2D23` — 24m-wide segment, 10.2m tall.
- `2D24/2D25` — 24m segments with the opposite y-band offset (other face).
- `2D26` — small post (2×0.3×2.7m).
- `2D27–2D2F` — **zero physics polys**: the `HasDIDDegrade` distance-LOD
  doubles of the above. Do not carve these.
- Raw byte-scan of client_cell_1.dat: ~36 total placements world-wide,
  concentrated at C6A9 — this is an Arwic-specific structure, matching
  acpedia's Arwic entry (town at 33.6N 56.8E: rebuilt after the Shadow
  Spire destruction as "a fortified city surrounded by sturdy, stone
  walls"). The soak-14 "Arwic wall" name was literal.
- No Setup wraps them (`asset-used-by` in portal.dat: 0 referrers) — they
  are placed as **bare GfxObjs directly in the landblock**, and ontology
  buckets them as Structure/maxDimension 24.

**Mechanism (second research pass, same day — SUPERSEDES the paragraph
above's "statics never reach the bake" claim, which was wrong):** the wall
pieces sit in `LandBlockInfo.Buildings` (not `.Objects`), GeomExtract
extracts them (as `building` + `seal` entries, from **physics** polys —
correct per the render-vs-physics rule), and the bake **does carve them**:
a fresh local 3×3 extract+bake around C6A9
(`GeomExtract --tiled C5,C7,A8,AA` → `Sidecar bake --geom`) reproduces the
LIVE tiles' routing behavior exactly. The real defect chain, proven by
`/route` probes against both the live :8767 tiles and the fresh local bake:

1. **The wall ring seals Arwic's compound into a disconnected mesh
   island.** GeomExtract's seal-skirt pass (`sealBuildings`, default on —
   built to close building *doorways*, which lead to interior EnvCells the
   outdoor bake doesn't contain) seals **every** `lbi.Buildings` entry —
   including the wall/gatehouse pieces. A city *gate* is a pass-through
   archway, not a doorway; sealing it (2D22's seal skirt alone is 88 tris
   — a complex footprint with openings, i.e. the gatehouse) leaves the
   compound with no on-mesh entrance.
2. **Partial Detour paths are returned as `ok:true`.** Probe
   (84,90)→(84,108) across the E-W wall band (y≈96–102): single leg ending
   at (84,95.5) — the wall's edge, 12.5m short of the goal — yet
   `ok:true, coverage:"detour"`, estUnits = the full requested distance.
   Same on live and fresh tiles.
3. **The out-of-coverage straight-line fallback stitches THROUGH carved
   obstacles.** Probe outside→inside the compound: 11 legs correctly
   detour around the ring to (54,16) just outside the south wall, then the
   final `"walk"` leg goes straight through the wall to the goal
   (`coverage:"mixed"`). This is exactly how the acceptance plan produced
   adjacent waypoints (84,104) → (84,82) on opposite sides of the north
   wall: the sim (correctly, per DAT physics) collides with what the
   planner stitched through, replans are deterministic → retries
   exhausted.

The client has no portal-avoidance route option (`POST /route` body is bare
`{from,to}`), so every Holtburg goto from Arwic re-enters the blocked
portal-hub approach. (Also verified en route: my first "route crosses the
wall" probe at y=96 actually skirted the wall's south edge — the placement
math in GeomExtract is correct; WBT placement origins + model y-band
offsets and the extracted tri bboxes agree.)

~~Secondary observation: leg timeouts elapse in <100ms / movement leaps~~ —
**RETRACTED** (same day). Timestamped console capture proved the router walks
in real time (~4 m/s, legs seconds apart, watchdogs genuinely 30s wall
clock). The "instant" appearance was a measurement artifact: on the busy
kiosk, CDP `Runtime.evaluate` **responses** starve for tens of seconds while
the page works, so a driver that anchors t0 on the issue-call's response sees
the whole walk "already finished". Console events stream fine — timestamp
those, not evaluate round-trips.

## Incident (2026-07-19): overnight OpenRouter drain

User-reported credit burn all night. Root cause: the index.html conn-fix
auto-reboot (session takeover) builds a fresh bot from URL params on every
reconnect — auto-starting a NEW AI director (`botModel=z-ai/glm-5.2,
botInterval=1` → up to 70 calls/h) even though the operator had stopped the
old one; `rynthAI.stop()` did not survive reconnects. ACE log shows the
04:24 reconnect; the director then ran ~11h against Vendbot locked in the
academy (the journal's "Academy Exit Token" escape attempts). Mitigated
immediately (`&botAi=off` on the kiosk URL — bot without director, immune to
reconnect reboots) and fixed properly by the localStorage
`rynthAiOperatorStop` latch (`rynth/ai/operator_stop.js`): stop() latches,
start() clears, the auto-boot path forces `cfg.ai=false` while latched.

## Fixes LANDED same day (all on origin/master, live-deployed)

Team: Fable lead + 2 Opus implementers (worktrees). All verified, merged:
1. **Seal rule** (`d8975656`): seal skirts only for buildings with
   `BuildingInfo.Portals` (interior links). Arwic 3×3: 21 sealed, 16
   skipped; compound connectivity RESTORED on-mesh; 0x01002D22 (the real
   gatehouse) keeps its legitimate seal.
2. **Sidecar contract v2** (`6a296c4c`): per-leg `"stitch":true`, top-level
   `stitchedLegs`/`partial`; TerminalGapM 15m silent swallow → 4m threshold
   with flagged closing stitch; any stitch forces ≥"mixed". Sidecar tests
   37/37 (two old tests were asserting the swallow-bug and got corrected).
3. **Client fail-fast** (`b025bc39`): stitch legs get a 10s watchdog;
   blocked stitch skips deterministic replans, error "blocked stitch leg" +
   blockedLeg coords for the W3 journal. navsim 31/31.
4. **Operator-stop latch** (`c1a826e8`): see incident above. 24/24 files.
5. **Corridor re-bake + live deploy**: Arwic 3×3 re-extracted/re-baked with
   the fixed toolchain, live tiles swapped (backup:
   `rynthnav-data.tile-backup-pre-sealfix-20260719/`), sidecar rebuilt on
   contract v2 and restarted. Live probes: compound entry AND wall crossing
   both `coverage:"detour", partial:false, stitchedLegs:0`, goals reached.
   Full-map re-bake on buildbox still pending (other towns may have sealed
   compounds until then — but they now FLAG as stitches instead of lying).

## Still blocked / next (fix list, in dependency order)

1. **Seal rule fix (GeomExtract):** don't seal non-enterable pass-throughs.
   Principled rule: a building's seal skirt should close only doorways that
   lead to interior EnvCells (BuildInfo portal records); a gatehouse archway
   with no interior link must stay open. Regression probe: on-mesh route
   into the Arwic compound (e.g. (84,108)→(50,50)) must succeed with
   `coverage:"detour"` and no straight-line stitches.
2. **Partial-path honesty (DetourRouter):** a DT partial result must not
   come back `ok:true` with silently-truncated legs — either fail with the
   reachable frontier in the payload, or mark the gap leg explicitly.
3. **Fallback stitch honesty (route assembly):** straight-line
   out-of-coverage segments must be flagged per-leg (the flat `label`
   field is available), so router.js can sweep-probe/fail fast instead of
   grinding MoveToPosition into a wall; better still, refuse to stitch
   straight through carved (known-obstacle) regions.
4. **Re-bake** the corridor (locally, minutes) after 1–3, then the full
   map on buildbox at leisure; then re-run Phase-2 acceptance
   (Arwic→Holtburg goto → arrival → auto-record → follow_route) —
   everything else already passes. LLM soak window rides behind it.

## Interiors — can we navigate buildings and dungeons? (assessment)

Asked 2026-07-19. Short answer: **the sim yes, the planner partially — the
pieces exist but goto cannot cross an outdoor↔indoor boundary today.**

- **Movement/physics (holtburger-world): full indoor support.** EnvCell
  entry/exit flips the runtime pose indoors (`walked_in_envcell_*` tests),
  collision is the cell's physics polys/BSP (separate from render — the
  same render-vs-physics split that applies to GfxObjs), and live proof:
  agent C's LLM sessions walked the academy interior with `routed(N)`
  walks; MoveToPosition takes full 32-bit EnvCell objCellIds.
- **Outdoor bake contains no interiors by design** (report 09 §1b);
  building doorways are seal-skirted precisely because their interiors are
  off-mesh. Indoor navmesh bake (DungeonLOS → layered tiles) was never
  built, even upstream in RynthSuite (Phase-3 pending).
- **Indoor routing exists as `rynth/indoor_router.js`:** a pure port of
  RynthSuite DungeonPathfinder's A* over the EnvCell **portal-record**
  graph (real doorways, not visible-cell adjacency), built live from wasm
  (`buildGraphFromWasm` ← `fetchEnvCellsInLandblock`; the client already
  BFSes this exact graph for rendering). Emits router.js-shaped legs.
  Known limitation: all drop/jump edges pruned (no jump primitive), so
  drop-gated dungeon areas are unreachable by design.
- **But it is wired only as an ADVISOR** (`ai/tools/dungeon_nav.js` —
  `dungeon_suggest` returns legs as advice; the director may follow up).
  `bot.goto`/GlobalRouter never consult it: the sidecar plans outdoor
  tiles + portal Dijkstra only. There is no composed
  outdoor→door→indoor→goal (or dungeon-interior goto) route today.
- **Integration path** (post fix-list): teach `doGoto` to detect
  indoor-from/indoor-to (`isCurrentCellIndoor`), plan the indoor segment
  with `indoor_router`, and splice at the doorway; the seal-rule fix (#1)
  is a prerequisite so outdoor legs can END at a real doorway instead of
  being sealed away from it.

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

## FINAL (late 2026-07-19): Phase-2 acceptance ACHIEVED (one carve-out)

Acceptance v16, full stack: **`__bot.goto({ns:42.1,ew:33.6})` from Arwic
resolved `ok:true, state:"DONE"` with the char at 0xA9B40019 (42.09N,
33.60E) — Arwic→Holtburg via the Town Network, ~3.5 min** — walk to the
exact portal → hold-and-nudge hop → in-network indoor A* with doorway
pre-approach (240s perf-tolerant legs) → walk-in exit hop → outdoor replan →
arrival. Auto-record fired (19-leg route in the atlas, journal note,
metrics), zero NULL-cell pose reads in every one of the day's 16 runs.
Sixteen live iterations root-caused, in order: sealed compound (seal rule),
portal coordinate error (tsv precision), proximity-advance past portal legs
(portal-hold), negative EnvCell locals (frame normalization), network perf
crawl (leg budgets), the offset doorway wedge (C# pre-approach port),
walk-in-hop mislabel + threshold, wrong-portal hops (re-entrant
composition), and the recorder living in the AI layer (config, not code).

Carve-out: reversed followRoute of the recorded route fails by design —
portal hops are one-way; portal-aware forward replay is filed as follow-up.
The follow_route mechanism itself was live-proven twice today on recorded
routes. Full-map re-bake (38,690 tiles, seal-fixed toolchain) is live on
:8767 with all probes green.

## Addendum: portal-aware route reuse (task 17) — LANDED + LIVE-PROVEN

Same day, two-implementer parallel build on a shared format-v2 contract:
recorder side (fmt:2, portal-departure + indoor flags, 4m indoor densify, 3m
de-noise, atlas/mirror round-trip, .nav export still byte-identical on the 3
real VTank fixtures) and replay side (flag derivation for legacy routes,
portal-aware followRoute via the router's native portal-hold + touch assist,
one bounded indoor re-path, reverse-replay of portal routes refused with a
clear error). The real v16-recorded route is committed as
rynth/testdata/v16_arwic_holtburg_route.json and drives the tests.

Live closing proof: forward followRoute of that route from Arwic —
`{ok:true, state:"DONE", legsWalked:17}`, char at 0xA9B40019 (42.08N,
33.60E), ~2.7 min, both portal hops replayed. The travel economy can now
record a cross-map portal route once and replay it without the sidecar.
