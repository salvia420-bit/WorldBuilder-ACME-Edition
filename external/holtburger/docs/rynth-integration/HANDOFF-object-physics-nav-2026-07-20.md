# HANDOFF — object-physics & navigation fidelity (stabs, GfxObjs, PhysObjs, EnvCell physics, flawless navigation)

2026-07-20, end of the soak-11-closeout + movement-pressure session. This
handoff frames the NEXT major arc: make the client's understanding of
PHYSICAL OBJECTS — interior stabs, GfxObj physics geometry, dynamic
PhysObjs and their scripts, outdoor statics — faithful enough that a bot
navigates around all of them flawlessly, indoors (dungeons, apartments,
shop interiors, upper floors) and around buildings outside.

## 0. Why now / where this session left the ball

Today's session (commits `0d54b3e7..72adb3ec`, all on origin/master):
- **Entity-collision arm LANDED, default-OFF** (`2c3e80f7`):
  `USE_FAITHFUL_ENTITY_COLLISION` + `?faithfulEntityCollision=on`. Before it,
  the live faithful driver collided ONLY cell env-BSP + baked cell statics —
  doors/monsters/players never blocked the player. It is ON right now on the
  stream rig URL and has had hours of incidental live exposure, zero observed
  regressions — but NO dedicated eye-test yet. Promotion to default-ON is
  gated on the bar in §6.
- **Seam/arrival work finished end-to-end** (43cf331c → `089e3624` latch →
  `b3d07e87` frame lift): teleport arrivals de-embed and ground at the grocer.
  ⚠ BUT task #13 (below) casts doubt on the frame convention the Layer-2 fix
  assumed — read it before trusting `faithful_find_placement_position` for
  REAL server-authored arrivals.
- **Movement pressure + honest action tools** (`f54985b2`, `3b696859`,
  `72adb3ec`): goto_object actually walks (MoveToPosition, distance-scaled
  budget, arrival-measured ok); interactions refuse to fire >5m after a failed
  walk; `?explorePressure=1` ambient sweep (unvisited indoor cells / outdoor
  doors) — measured 0/11 → 8/23 moving intervals, 33m/2min with zero LLM calls.
- Varek pyreal mystery CLOSED (`c6040ae0` + `bd11626e`); 10 stale core tests
  fixed (`61c3c29a`, core 594/0/1); world suite 570/0 (env840 6/6 w/ DATs).

Live rig at handoff: stream chromium CDP :9223 (vendortest/+Vendbot,
accessLevel **4** — granted in ace_auth for @teleloc unpinning; revert if
unwanted), ffmpeg → YouTube, GLM director (1280-token cap + streamlake pin),
explorePressure on. serve.py :8765, sidecar :8767 (38,690 tiles), ACE
:9000/9001, wsbridge supervised.

## 1. Track A — building-interior STABS (the cell's placed objects)

The EnvCell's `stab_list` places DAT objects (0x01 GfxObj / 0x02 Setup ids)
inside interior cells. Our ingest: `apps/holtburger-web/src/lib.rs:17978-18060`
stages stabs into `CELL_STATIC_BSP_PENDING` → baked IMMUTABLY into
`cell_static_physics_bsp`; the faithful sweep collides them via
`find_obj_collisions` (`crates/holtburger-world/src/spatial/faithful_bridge.rs:454-489`,
mirrors retail `CObjCell::find_obj_collisions` acclient.c:347142).

INVESTIGATE:
1. **Coverage**: are ALL stab types with physics polys actually baked?
   (Setup-wrapped stabs recurse Stab→Setup→GfxObj? The navatlas soak-15 W2
   carry-forward says indoor-furniture BSP population "needs the
   Stab→Setup→GfxObj recursion (hook wired, recursion deferred)" — that gap
   means FURNITURE MAY BE MISSING from collision indoors → bot clips through
   tables/counters it should navigate around. Find the wired-but-deferred hook
   and finish it.)
   [CORRECTION 2026-07-20: the live wasm recursion landed 2026-06-28
   (46a1e697/ba7ed2a8) — `walk_setup_parts_with_geom_and_bsp` +
   `StaticPartBsp` in apps/holtburger-web/src/lib.rs, feeding
   CELL_STATIC_BSP_PENDING from the 0x02 SetupModel arm of the stab ingest at
   lines 17978-18060 above. The "deferred" note this item quotes referred
   only to the offline `route_validate.rs` stub's `populate_cell_furniture`
   hook, not the live client. Remaining gap = offline-harness coverage (now
   partially closed by native unit tests in
   `apps/holtburger-web/src/lib.rs::tests_stab_bsp_recursion`).]
2. **Toggleable stabs**: retail instantiates every stab as a shadow
   CPhysicsObj (ACE `EnvCell.StaticObjects: List<PhysicsObj>`, EnvCell.cs:26)
   — so a stab that is a DOOR can go ETHEREAL. Our bake is immutable: a
   dungeon door baked as a stab stays solid when opened. Options ranked in the
   task-#2 research (this session): (a) skip door-classified stabs from the
   bake and rely on the dynamic-entity arm; (b) per-stab `ethereal: bool` on
   `CellPhysicsBsp` toggled by DoorStateChanged — the true retail model at the
   collision layer. `open_door_exclusion_aabbs` (scene.rs:552) is DEAD CODE on
   non-live paths — do not extend it; remove it once (b) lands.
3. **Enumerate ground truth** per building type with WBT:
   `{"command":"chorizite-parse-dat-record","datPath":".../client_cell_1.dat","idHex":"0x<cell>","typeName":"EnvCell"}`
   → stab list; cross-ref `asset-refs`/`asset-used-by` for the Setup/GfxObj
   chain. The Holtburg grocer (0xA9B4016A, 24 statics) and academy
   (0x8602xxxx) are mapped test venues.

## 2. Track B — GfxObj physics geometry (render vs physics split)

Every collision question bottoms out in GfxObj **physics polys** (distinct
from render polys — the render-vs-physics rule proven for the Arwic wall in
RESULTS-navatlas-soak-15).

INVESTIGATE:
1. Our decode path: holtburger-dat GfxObj parsing — verify physics polys /
   physics BSP / drawing BSP are separated exactly per `$D` (DatReaderWriter
   dats.xml `<type name="GfxObj">`) and ACE's `ACE.DatLoader/FileTypes/GfxObj.cs`
   (preferred truth per house rule; DRW mislabels widths — acclient.c wins:
   CGfxObj fieldlist typeid 0x11fbf via the PDB dump recall).
2. Sort-order/flags: GfxObj `Flags` bit for physics presence; degenerate
   `HasDIDDegrade` LOD doubles have ZERO physics polys (0x01002D27-2F Arwic
   lesson) — ensure the bake NEVER carves LOD doubles and ALWAYS carves the
   real piece.
3. The wasm's triangulation memo (thread_local decode-once) — confirm physics
   triangulation is byte-identical between the bake worker and main thread.

## 3. Track C — dynamic PhysObjs + their scripts

Dynamic entities (doors, chests, NPCs, monsters, players, elevators?) are
server-spawned weenies with Setup/MotionTable/PhysicsScript state.

INVESTIGATE:
1. **Collision shape**: our entity colliders are XY cylinders
   (`entity_collision.rs:101`, radius from ObjectDescription). Retail collides
   the full CPhysicsObj (sphere set from CSetup, fieldlist 15827). Where does
   the cylinder approximation break navigation? (Long counters, carts, wide
   NPCs.) Candidate: per-setup sphere sets for large statics-as-weenies.
2. **State fidelity**: `Entity::is_collidable()` (entity.rs:1202) honors
   ETHEREAL|IGNORE_COLLISIONS — verify DoorStateChanged actually flips the
   entity's physics-state bits on the wire for BOTH surface doors and dungeon
   doors (capture with `__diag.wire`); the grocer behaves, dungeon doors are
   unverified.
3. **Scripts**: PhysicsScript/DefaultScript (PScriptType enum 0x4c05 in the
   PDB dump) drive door swings/platform motion visually. Do any scripts MOVE
   collision (elevators, drawbridges)? If yes the entity collider must track
   scripted position — find retail's authority (`CPhysicsObj::motions_pending`
   / update_object_movement area) before assuming static.
4. PursueObject now translates (live-measured 9.7m/6s walk-speed straight
   line — comment updated in world.js). Check whether run-speed pursuit
   exists (retail runs when RunRate set) — bot walks everywhere currently.

## 4. Track D — outdoor physical objects & buildings

Outdoor collision today: terrain + building AABBs + statics AABBs
(`building_aabbs_near_pose`/`statics_aabbs_near_pose`, transition.rs:369-371)
+ (flag-on) entity cylinders. Buildings' real physics = `LandBlockInfo.Buildings`
entries with GfxObj physics polys (Arwic wall analysis).

INVESTIGATE:
1. AABB vs real polys: an AABB over an L-shaped or arched building blocks
   valid paths (gate arches!) and misses diagonal walls. The faithful outdoor
   driver's static grounding (roofGrounding etc.) already reads real geometry
   somewhere — unify: collide outdoor building/static PHYSICS POLYS (BSP) not
   AABBs, matching indoor fidelity. This is likely THE "navigate around
   buildings flawlessly" item: today the bot brushes walls because collision
   and navmesh disagree near facades.
2. Nav-vs-physics agreement: the sidecar carves buildings from physics polys
   (GeomExtract; seal rule fixed `d8975656`). Any residual mismatch (bot
   collides where planner routes) → capture pose + leg and diff against the
   tile mesh. The task-14 goto_object rewrite removed the blind straight-line
   walker, but `coverage:"straight"` stitch legs still walk blind — flagged
   per soak-15 contract v2; consider refusing straight legs through carved
   regions client-side.
3. Scenery (anim + static): instanced anim-scenery landed 07-02; scenery is
   non-collidable in retail EXCEPT specific classes — verify ours matches
   (bot should never dodge grass, never clip a well).

## 5. Track E — EnvCell physics: dungeons, apartments, verticality

OPEN BUGS (tasks #12/#13 in the task list, both filed with evidence today):
1. **#12 dungeon-login movement pin**: fresh login indoors (academy
   0x860201AD, pose y=-26) → raw `setMovementInput` realizes 0.000m, but
   `MoveToPosition` legs DO move (explore-pressure swept academy cells
   live). That asymmetry is the best clue: the manual-drive lane vs the
   moveTo driver diverge on the indoor login pose — suspect the manual
   slice's begin-cell/frame resolution vs the driver's. Repro is
   deterministic (vendortest/+Vendbot saved in academy).
2. **#13 frame-convention audit**: is the indoor server pose CELL-local or
   LANDBLOCK(dungeon)-frame? Task #11's placement lift assumed cell-local but
   was calibrated against synthetic `@teleloc 4.243 -2.121` input we authored
   ourselves. Real ACE saves look dungeon-frame (y=-26 spans cells; DB portal
   row 0x7203021F origin 50,-56). Decide from ACE source (Position authoring)
   + one live A/B (`@teleloc 0xA9B4016E 81 33 94.35` lb-frame vs cell-frame —
   which de-embeds?). The answer decides whether `b3d07e87`'s lift stays,
   inverts, or normalizes-by-heuristic. EVERYTHING in placement and possibly
   #12 hangs off this.
3. **Verticality**: stairs = the E1 faithful step-up (2f181a96) + env BSP
   walkable polys. The building-explorer persona demands 2nd/3rd floors —
   nobody has ever verified multi-floor stair climbs indoors (the step-up
   tests are curb-scale). Venue: Holtburg buildings with upper floors; verify
   `getLocalPlayerPose().z` climbs and `current_cell` follows floor cells.
   Apartments (0x7200-73FF-style complexes) and dungeon z-stacks are the
   stress cases; `indoor_router` prunes drop/jump edges by design — stairs
   must NOT be pruned (they're walk edges).

## 6. Track F — flawless navigation: the composed goal

The bar, concretely: the explorer bot enters every Holtburg building incl.
upper floors, circles interior furniture without clipping or wedging, exits,
rounds building exteriors without wall-brushing, and does a dungeon lap —
all with `?faithfulEntityCollision=on`, zero operator rescues, on stream.

Pieces + state:
- Entity arm ON (stream) — needs the closed-door-blocks / open-door-passes
  eye-test then default-ON promotion (escape stays `?faithfulEntityCollision`).
- goto_object mover fixed (f54985b2); interactions walk-gated; followLegs
  deadline > router watchdog; `dungeon_suggest` graph priming fixed.
- explorePressure sweeps (72adb3ec: attempt-time visited marking). Tuning
  knobs now: 12s idle, 15s cooldown, 6-hop stand-down (bot.js ~:704-737).
- Indoor router: portal-record graph per LB; surface-building association
  worked live (grocer routed(4)); dungeon-scale + multi-floor UNTESTED.
- Sidecar: outdoor-only by design; indoor navmesh (DungeonLOS) never built —
  the composed outdoor→door→indoor goto exists since v16 for the Town
  Network; generalize it to arbitrary buildings (seal-rule fix is in).
- LLM cadence: GLM 1280-token cap + provider pin (8089b83c) — check-ins were
  50-80s before; verify they now land <20s and `next_check_minutes` honors
  the faster loop.

## 7. Tools, oracles, recipes

- Offline harness pattern: `crates/holtburger-world/src/spatial/env840_seam_tests.rs`
  (real DATs via HOLTBURGER_PORTAL_DAT/HOLTBURGER_CELL_DAT env vars) — clone
  it for any new venue (upper-floor cell, dungeon room, furniture-heavy cell).
- Retail decomp: `CObjCell::find_obj_collisions` acclient.c:347142;
  `CPhysicsObj::FindObjCollisions` ~316185 (ETHEREAL short-circuit :316196,
  :316288-316299); ETHEREAL_PS=0x4/IGNORE_COLLISIONS_PS=0x10 acclient.h:2819/21;
  `set_ethereal` :319047. ACE ports: ObjCell.cs:150, PhysicsObj.cs:385-397,
  EnvCell.cs:26.
- WBT: `chorizite-parse-dat-record` (EnvCell/GfxObj/Setup/Environment),
  `asset-refs`/`asset-used-by`, `pvs-visibility-snapshot`. DAT truth order:
  acclient.c > ACE DatLoader > DRW.
- Live: stream_drive.mjs (this session's scratchpad; recreate trivially — CDP
  :9223 eval/reload). Statue metric: 12-24 pose samples @5s, count >0.5m
  intervals. `__diag.wire.summary()`, `arrivalPlacementDiag` (engaged<<0|failed<<16).
- Boot dance: every relaunch collides with its own corpse (~60s ACE reap; no
  wire logout — soak-12 §5.1 still open); reload-retry, readiness by pose.

## 8. Suggested attack order

1. Task #13 frame audit (small, decides #12 and placement correctness).
2. Task #12 dungeon-login pin (raw-input vs MoveToPosition asymmetry).
3. Track A furniture recursion (Stab→Setup→GfxObj) — biggest interior-collision
   hole; then the dungeon-door toggleable-stab design.
   [CORRECTION 2026-07-20: this recursion is already live in the wasm client
   (landed 2026-06-28, 46a1e697/ba7ed2a8; see the §1 INVESTIGATE item 1
   correction above). Remaining work here is offline-harness parity
   (route_validate.rs) and the coverage/toggleable-stab questions in §1,
   not the recursion itself.]
4. Entity-arm eye-test → default-ON.
5. Track D outdoor building polys-vs-AABB unification.
6. Multi-floor stair verification (Track E3) with the explorer persona live.
7. Dungeon lap (composed indoor nav at scale).

Suites at handoff: world 570/0 (env840 6/6 with DATs), core 594/0/1,
holtburger-web native 150/151 (1 pre-existing triangulation failure,
untouched), rynth node 35/0. Release wasm in pkg/ = master @ `b3d07e87`-era
build + nothing wasm-side since (JS-only after). MEMORY.md trim was declined
by operator — do not touch memory/.
