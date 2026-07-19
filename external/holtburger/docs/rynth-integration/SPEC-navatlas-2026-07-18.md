# SPEC — NavAtlas: perception-grounded navigation for the AI playtester (soak-15)

**For the next session: Fable inline (lead) + 2× Opus 4.8 agents.**
Continues `HANDOFF-playtester-soak-12.md` + the soak-13/14 fix commits
(`72f905b4`, `9814ccec`, `1065b385`). Investigation base: rynthsuite upstream
(`/mnt/wbterminal1/ac-refs/rynthsuite`, esp. `Docs/MeshNav_DeepDive_2026-06-04.md`
and `Docs/Nav_DeepDive_2026-06-15.md`), the Discord archive (`mesh-nav`,
`rynthsuite`, `metaf` channels), the rynthnav sidecar (`apps/rynthnav-sidecar`),
and the holtburger rynth JS suite.

---

## 0. The contract (what "no cheating" means here)

The bot plays with a player's epistemic budget:

- **Allowed — perception:** everything the retail client legitimately holds or
  streams: DAT geometry (terrain, buildings, scenery physics), the entity
  table it can see, its own pose/vitals/skills, chat it hears. A navmesh baked
  from client geometry is *perception*, not cheating — it is the same data the
  player's eyes render, machine-readable.
- **Allowed — player-tier knowledge:** what a player could read on a wiki or
  collect by playing: acpedia corpus, GoArrow portals.tsv (player-collected
  retail data), town names on a map, VTank-style nav files a player community
  authored.
- **Allowed — experience:** anything the bot itself did: routes it walked,
  portals it used, vendors it opened, deaths it died. Recording and reusing
  its own experience is the *point*.
- **NOT allowed — server internals as live knowledge:** ACE DB queries feeding
  the director (vendor inventories it never opened, spawn tables, quest
  internals), server-side positions of entities it has not seen. (Offline
  *validation* of player-tier data against the DB — e.g. sanity-checking
  portals.tsv — is fine; the director never sees the raw DB.)
- **The goal is a system, not perfection:** routes carry *estimates*; fights,
  lag, vendor dwell time, and death are expected disruptions the system
  absorbs (resume/replan/re-ETA), not failures to engineer away.

## 1. Critical analysis — why the current loop underperforms in practice

Honest audit of soak-13/14, including this session's own mistakes:

1. **Every capability gap becomes LLM burn.** When travel primitives fail
   (nav unconfigured, indoor egress missing, straight-line fallback into
   Arwic's wall), the director flails at ~$0.05–0.10/hr producing
   goto_object chains and door-spam. We patched gaps reactively mid-soak;
   each was a structural capability the harness should have owned. The
   director should choose *destinations and goals*; the harness must own
   *getting there*.
2. **The cadence is wrong-shaped.** Fixed 1-minute check-ins burn calls while
   the bot is mid-walk with nothing to decide, then arrive mid-action with
   stale context. Most check-ins during soak-14's Arwic leg were "still
   walking" noise. Check-ins should be **event-driven**: route arrived /
   route failed / interrupted by combat / vendor opened / died / idle-N-min
   heartbeat. Each prompt then carries an actual decision. (The plumbing
   exists: director `maybeEarlyCheck` already fires on tells.)
3. **We ignored machine-readable truth we already had.** The sidecar's route
   response carries `coverage: "detour"|"straight"|"mixed"` — "straight"
   means *blind fallback through unbaked terrain* (that is what walked the
   bot into Arwic's wall). Neither the bot layer nor the director nor the
   operator (me) surfaced it. Lesson generalized in §3-W1: fallbacks must be
   loud, and route quality must reach the decision layer.
4. **Stateless re-derivation wastes the budget.** The model re-learns "where
   am I, what was I doing" every check-in from a journal tail; long-horizon
   intents ("buy a wand") survive only if the model re-writes them into a
   1500-char scratchpad every cycle. Routes/goals need first-class harness
   state the observation *reports* ("route: arwic-vendor-run, leg 3/7,
   ETA 40s, interrupted-by: mosswart") rather than model-memory.
5. **Perception grounding worked when we did it.** The fixes that moved the
   needle (nav ONLINE line, area/nearest-town line, arrival notes, retrieval
   fallback) were all "tell the model what the client already knows." The
   Arwic run then *worked*: it walked there, saw the Scrivener, appraised its
   gem correctly. Continue in that direction; §2 inventories what remains
   unexposed.

## 2. Asset inventory (verified this session, with citations)

**Nav execution (holtburger JS, live today):**
- `rynth/router.js` — leg follower `[{lb,x,y,z,portal?}]`, WALK/PORTAL states,
  `MoveToPosition` mover, 3 m arrive, 30 s/leg watchdog, 3 s re-issue,
  portal-hop detect ≥30 m jump + 4 s settle + nearest-remaining-leg resume.
- `rynth/global_router.js` — sidecar `POST /route`, stall detect (45 s),
  replan ×2 from current pose, one-goto-at-a-time.
- `rynth/indoor_router.js` — EnvCell portal-graph A* (DungeonPathfinder port)
  + soak-13/14 additions: `findExitPath`, mesh-bbox cell anchors,
  `exit_building`, enter/leave boundary legs in `tools/world.js`.

**Nav planning (sidecar, live today):** `apps/rynthnav-sidecar` — Recast/
Detour bake + query + GoArrow portal Dijkstra (817 portals). **Obstacle-aware
when baked with `--geom`** (LandBlockInfo statics/buildings physics polys +
scenery; trap: scenery Setups have no physics polys — retail collides their
CylSphere list, emitted as 8-sided prisms). **Coverage: only A7–AB × B2–B6**
(25 landblocks around Holtburg). Everywhere else: silent straight-line
fallback (`coverage:"straight"`). Bake CLI + GeomExtract recipes in its
README (~lines 92–143); provenance via `bake-source.sha256`.

**Upstream C# (NOT ported, available as reference at
`/mnt/wbterminal1/ac-refs/rynthsuite`):**
- `NavRouteParser.cs` + `AfFileParser.cs` — uTank2 NAV 1.2 / `.af` / `.met`
  parser, **fixed + validated 934/934 real VTank routes round-trip**
  (Nav_DeepDive §0b). Format: 5-line prologue (Type/EW/NS/Z/flag) +
  per-type trailers `{Recall:1, Pause:1, Chat:1, OpenVendor:2, Portal(6):6,
  Npc(7):6}` via a shared `TrailerLineCount` table.
- `NavigationEngine.cs` — waypoint follower with portal/recall FSM (its
  deficiencies are catalogued in Nav_DeepDive §§2–7; do not re-inherit them).
- Auto-nav prior art (Discord, Shooter McGavin): "makes its own nav route and
  follows it", dungeon auto-routes traversing main hallways, patrol mode as
  the daily-driver nav method.

**Knowledge/perception layer (holtburger JS, soak-14):** 24,488-entry acpedia
corpus + partial-match retrieval; 57-town gazetteer (`tools/towns.js`);
observation lines: pos/nav/area/advancement(+hydration guard)/nearby/
inventory/threat/portals.

**Speed math (retail, for ETA):** `MovementSystem::GetRunRate(load, runskill,
scaling) = (LoadMod(load) · (skill/(skill+200)·11) + 4) / scaling / 4`
(acclient.c:713790); jump height :713807. Charge/burden via
`EncumbranceSystem::LoadMod`.

**Physics validation surface (holtburger wasm/crates — Appendix B, spot-verified):**
- `SpatialScene` (`crates/holtburger-world/src/spatial/scene.rs:432`) holds
  terrain heights + water codes, building AABBs + precise triangles, EnvCell
  physics BSPs, and outdoor static BSPs — the one structure the faithful
  CTransition walker collides against.
- **Offline harness proven**: `env840_seam_tests.rs` builds the scene from
  real DATs and drives `faithful_find_transitional_position` in a per-frame
  simulated RUN loop (30 fps, gravity, stationary-fall carry) — a
  copy-from template for route validation by simulated walking.
- **Wasm sweep queries already exported and UNUSED by rynth**:
  `sweepSphereAgainstStatics` / `sweepSphereAgainstBuildingMesh` /
  `sweepSphereAgainstCellMesh` + `terrainHeightAt` (d.ts:5691 etc.), all
  against a live clone of the movement scene — perception-pure obstacle
  probes available to JS today.
- **Run speed directly queryable**: `playerRunRate` export; ground speed =
  MotionTable RunForward anim speed x run_rate scalar
  (`run_rate_from_skill_and_burden`, context.rs:130-153 — same formula as
  retail GetRunRate incl. the ==800 -> 4.5 plateau). No calibration
  constant needed for ETA.
- **Known live gap (holtburger-web core, NOT ours to fix this session):**
  indoor furniture precise collision (`cell_static_physics_bsp`,
  scene.rs:504-508) has no live wasm populate path — live walkers do not
  collide indoor tables/chairs. The offline harness CAN populate it; indoor
  route pre-validation should, and live indoor legs should keep generous
  clearances around cell anchors.

## 3. The system — three workstreams

### W1 — Coverage: bake the world the bot walks (Opus agent A)

The bot may go anywhere; the mesh must not be a 25-block island.

1. **Full-map obstacle-aware bake** on buildbox (the CAP-16 fan-out box —
   read `memory/fleet-runbooks.md` first): `GeomExtract` then
   `bake --tiled 00,FF,00,FF --geom` sharded into region jobs. Sidecar knobs
   `RYNTHNAV_MAX_TILES`/`TILE_HIGH_WATER` already exist for the tile-count
   jump; verify LRU eviction under a full-map dir. Deliverable: full-map
   `/mnt/wbterminal2/rynthnav-data` + `bake-params.json` provenance +
   spot-route tests in 3 far-apart regions (Arwic C6A9 included — the
   soak-14 wall repro becomes the regression test).
2. **Loud fallback:** `global_router.js` surfaces `coverage` into the goto
   result + journal note ("route is STRAIGHT-LINE (unbaked region) — expect
   obstacles"); observation nav line appends per-route quality. The director
   may still choose to try — but knowingly.
3. **Water rule check:** mesh-nav Discord lore — a landblock texture cell
   with all 4 corners water is unwalkable; confirm the baker's
   TerrainSampler honors it (bake a river crossing; route must detour to a
   bridge/ford).
4. *(stretch)* **Portal-arrival re-validation** against our ACE world
   (offline check of portals.tsv rows near baked regions; player-tier data
   in, player-tier data out).

### W2 — Route atlas: record, name, reuse, estimate (Opus agent B)

The experience loop — the bot earns a route library by walking.

1. **Route recorder** (`rynth/route_recorder.js`, new): sample the pose
   during any successful `goto`/`exit_building`/manual walk (breadcrumbs at
   ≥8 m spacing or cell change; portal hops annotated from router PORTAL
   transitions — Alastor's landcell-recording insight). On completion,
   simplify (RDP on legs) and persist.
2. **Atlas store** (localStorage + JSON export mirrored to
   `/mnt/wbterminal2/holtburger-scratch/atlas/`): named routes
  `{name, from:{lb,x,y,z}, to, legs, portalsUsed, estUnits, walkedMs,
  runSkillAtRecord, successCount, lastResult}`. Routes are *experience*:
  only recorded from walks that actually completed.
3. **ETA model:** speed comes straight from the client:
  `playerRunRate()` x base run anim speed (== the wasm integrator's own
  cap, run_rate x 4.0 m/s at rate 1) — no calibration constant. ETA =
  route legs length / current speed, + fixed dwell allowances per waypoint
  type (portal settle 4 s, vendor open ~10 s). Report ETA + actual on
  every route; persistent >2x overruns mark the route suspect
  (lag/blocked) in the atlas.
4. **.af/.met interop:** port the *fixed* upstream trailer-table parser to
  JS (`rynth/nav_file.js`; the TrailerLineCount table is ~40 lines — port
  the table + reader/writer, NOT NavigationEngine). Import: VTank
  `.nav`/embedded `.af` navs → atlas routes. Export: atlas routes → `.nav`
  so humans can inspect/edit them in VTank tooling. This is the
  "already coded" asset made native.
5. **Local obstacle probe (cheap, live):** before walking any
  straight-fallback leg (W1.2) — and during stuck recovery — probe the
  segment with `sweepSphereAgainstStatics`/`...BuildingMesh` +
  `terrainHeightAt` from JS. A hit turns a blind 30 s wall-grind into an
  instant "blocked at 12 m by static 0x..." journal fact the director (or
  a simple sidestep heuristic) can act on. rynth has never used these
  exports; this is the single cheapest perception upgrade found.
6. **Physics pre-validation** (uses the wasm surface from the appendix):
  before an atlas route is trusted for autonomous reuse, walk it in the
  offline SpatialScene sim (headless, no server): every leg must ground-
  walk without STALLED. Recorded-from-life routes usually pass trivially;
  imported/authored routes get caught here. No live-bot minutes wasted on
  bad routes, no cheating — it is the client's own physics.

### W3 — Director economy: strategy in, mechanics out (Fable inline)

1. **Route-level actions:** `follow_route {name}`, `record_route {name}`
  (arms recorder on next travel), `list_routes` (atlas summaries into the
  journal). goto remains for novel destinations; arriving somewhere new via
  goto auto-offers "record this?" — no, simpler: successful novel gotos are
  ALWAYS recorded under an auto-name; the director may `name_route` ones
  worth keeping. Keep the action surface small.
2. **Event-driven check-ins:** trigger a check-in on route-done, route-
  failed(+reason incl. coverage), combat-interrupt-ended, vendor-profile-
  arrived, death; idle heartbeat falls back to 3–5 min (config). Remove the
  1-minute metronome during travel. Expected spend cut: >50% at equal or
  better reactivity.
3. **Observation: mission line.** First-class harness state, not model
  memory: `mission: <current route/goal> | leg 3/7 | ETA 40s (est 92s
  total) | interrupts: 1 (mosswart, resolved)`. Amended by route events.
  The scratchpad returns to being *beliefs*, not a program counter.
4. **Prompt tune:** fold W1's coverage honesty + W2's atlas into DIVISION
  OF LABOR ("the harness walks routes and records them; you pick where and
  why"). Keep total prompt growth ≤ ~150 tokens; we are paying per minute.
5. **Metrics for "is it working":** per-hour — distance covered, unique
  landblocks, atlas routes recorded/reused, kills, deaths, LLM calls,
  $-spend. The soak journal prints an hourly summary line; drawing-board
  discussions get numbers instead of vibes.

## 4. Session plan (Fable + 2 Opus agents)

- **Phase 0 (Fable, 30 min):** read this spec + verify the appendix physics
  citations still hold; re-run the soak-14 Arwic wall repro against the
  sidecar to freeze it as W1's regression test; write the three tracked
  tasks.
- **Phase 1 (parallel):** Agent A = W1 (buildbox bake is long-running —
  start it FIRST, it bakes while everything else proceeds). Agent B = W2
  items 1–3 (recorder + atlas + ETA; .af/.met interop second). Fable = W3
  items 1–3 against the existing test suites, wiring W2's surfaces as they
  land (SendMessage coordination; do not let agents touch
  scene3d/index.html render paths — AI layer only).
- **Phase 2 (integration):** one live soak window (stream optional) with
  metrics on; acceptance = the Arwic scenario end-to-end: spawn Holtburg →
  decide Arwic → route (detour coverage) → arrive → enter shop → vendor
  opens — with ≤8 LLM calls and zero wall-pins; the run's walks land in the
  atlas and a repeat run reuses them with fewer calls.
- **Rules:** no holtburger-web render/regression surface changes; every
  edit lands with its suite green (`node rynth_*_test.cjs`); staleness traps
  apply (`?nosw=1`, module cache → reload after JS edits, wasm rebuild via
  capped-build if the physics surface needs new exports — buildbox for
  anything heavy); commit per workstream with the say-vs-do evidence in the
  message.

## 5. Risks / opens

- **Full-map bake wall-clock** unknown (25 blocks were fast; 65k landblocks
  is a real fan-out job — hence buildbox + start-first). Mitigation if it
  overruns: bake the soak corridor (Holtburg↔Arwic↔neighboring towns) first;
  full map continues in background.
- **Detour maxTiles/eviction** at full map — knobs exist, untested at scale.
- **ETA constant** (anim-rate → world m/s) needs one calibration measurement;
  the offline sim can provide it deterministically.
- **Event-driven check-ins** change director timing semantics — the
  maxCallsPerHour budget and maybeEarlyCheck interplay need a test pass
  (suite exists: rynth_ai_director_test.cjs).
- **Atlas trust:** replayed routes can rot (world edits, seasonal content).
  lastResult/successCount + ETA-overrun flags demote rotten routes to
  re-record; physics pre-validation catches geometry rot offline.
- **.met binary variant:** upstream parser handles text `.af`+`.nav`; binary
  `.met` metas embed navs in the Virindi Table format (Eskarina's PDF doc,
  metaf channel 2022-11-20) — import can start with `.nav`/`.af` only.

## Appendix A — rynthsuite nav machinery report (Explore agent, 2026-07-18)

(See `docs/rynth-integration/appendix-navatlas-A-navmachinery.md`)

## Appendix B — holtburger physics/collision surface report (Explore agent, 2026-07-18)

(See `docs/rynth-integration/appendix-navatlas-B-physics.md`)
