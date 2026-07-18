# Handoff — playtester soak, session 10 (THE movement fix lands + residency watchdog; seam-transit is the last wall)

Continues `HANDOFF-playtester-soak-8.md` / `-9.md`. This session root-caused and
**fixed soak-9 §3** (the wasm MoveTo wedge), survived a MariaDB OOM outage,
proved the vendor pipeline end-to-end from inside a shop room, shipped a
cell-residency watchdog, and characterized the ONE remaining movement wall —
cell-seam transit — down to a specific reproducible location. Soak v6.5.4 was
ended by operator instruction at 16:15Z to prioritize this investigation
(artifacts archived as `*.v654.txt`).

## 1. THE moveTo fix (soak-9 §3 candidate #1) — LANDED, live-proven

Two wasm bugs, both fixed in `holtburger-core` (uncommitted→this commit):

1. **TurnRight infinite wedge.** The T2 autonomous integrator
   (`simulation.rs::advance_local_player_via_transition`) applied the MoveTo
   driver's node heading as an EXACT snap each slice. The driver's turn-arrival
   test is retail `heading_greater` (acclient.c:344715/:345739) — a strict
   OVERSHOOT test; retail rotates kinematically and snaps only after the body
   PASSES the node (:345746). On exact equality TurnLeft's fold accepts
   (`le`), **TurnRight rejects (`!le`) → the driver turned in place forever**:
   zero translation, `pursuitStatus` stuck 1, no failure latch. This single
   asymmetry produced BOTH soak symptoms (indoor targets needing TurnRight
   wedged; outdoor TurnLeft targets "worked").
2. **Unscaled walk delta.** The Walk steer's UNIT direction was consumed
   verbatim per solve slice (~1 m/slice ≈ 13 m/s live-measured — 3× retail).

Fix shape (retail parity, no hardcoded speeds):
- `current_local_drive_control` autonomous arm now scales the steer direction
  by the **authored MotionTable gait speed × dt** (same speed source as the
  manual lane) and threads the **authored turn omega**
  (`LocalDriveControl.turn_omega_rad_s`, new field).
- T2 realizes turns kinematically: full `omega·dt` steps through TurnToHeading
  nodes (crossing the node like the retail turn animation → the driver's
  overshoot test fires → retail snap), clamped-at-bearing during walk-phase
  aux-turns. Projection arm unchanged (`None` = instant snap).
- Tests updated (capability seeding + scaled expectations). Suites at exact
  pre-existing baseline: holtburger-core 577 pass / 10 pre-existing stale
  failures (handoff-7 §5 list, untouched), holtburger-world 551/551.

**Live proof**: soak session 5 — Torval WALKED INTO a shop building
(0xa9b4016e) for the first time in soak history; `open_vendor` legs now report
`walk:settled` (never again `walk:no-walk` while grounded+resident). Release
wasm with the fix is live in `pkg/` (also `pkg-fix/`; pre-fix backup in the
07-18 scratchpad).

## 2. Cell-residency watchdog (index.html) — LANDED, live-proven

**Load-trigger deadlock found**: every EnvCell fetch trigger rode a SERVER
position update, but the indoor pipeline refuses motion until cell physics
lands (`transition.rs` pre-bake gate) — so a player ARRIVING in an interior
cell of an unfetched LB (teleport / bot-relaunch spawn / LB re-entry after LRU
eviction — s13 additionally gated the legacy ensure to `renderer=2d`) froze
forever: frozen ⇒ no position updates ⇒ fetch never retriggers. Retail keys
residency off the POSE during transit (`LScape::update_block`), not network
events.

Fix: 500 ms watchdog in index.html (after `ensureCellContainersForLandblock`):
fires ONLY when the local pose sits in an interior cell (suffix ≥ 0x100) of an
LB absent from `cellContainersPopulatedLbs` — outdoors the normal path keeps
sole ownership (no s13 double-decode regression). Live-proven
(`[cell-watchdog] … triggering EnvCell fetch` → 123 placements → movement).

## 3. Vendor pipeline: PROVEN end-to-end in range

`door_repro2.cjs`: teleport inside the grocer's main room (0xA9B4016A) next to
Fispur Ansel → in-room walking works → `useObject(0x7A9B4024)` →
**`vendorState: Fispur Ansel the Grocer, 7 items`**. With seam transit fixed
(§4) the whole economy arc unblocks: walk in → approach → buy.

## 4. THE remaining wall: cell-seam transit (next session candidate #1)

**Symptom**: crossing EnvCell seams fails — vestibule↔room, room↔outside,
and "through an open door" (ticket uhf1nw; Torval's 16:05–16:12Z loop at the
grocer door: `use_object Door ok` → `goto route-failed/no-walk` ×3).

**Characterized location**: Holtburg grocer = env 840, five structs sharing
frame origin (79.5,37.5,94) rot −45°: 0x16A main room (24 statics, Fispur),
0x16B back room, 0x16C/D/E entry vestibules (portal→0xFFFF outside + portal→
0x16A). Standing at (81,33,94) — ON the 0x16E/0x16A portal-4 seam —
**movement refuses in ALL FOUR directions** (0.00 m) with ALL cell data
resident (123 cells: physics tris, env BSPs, static BSPs, membership,
portal edges — verified in-console), and `isOnGround` decays true→false while
turning in place (ground resolve can't settle on the seam either).
`current_cell` flaps 0x16E↔0x16A across runs at that spot. In-ROOM movement
in 0x16A works (N 1.5 m, W 2.06 m; E/S legitimately blocked by counter
statics).

**Facts for the next session**:
- The DOOR machinery itself works: `DoorStateChanged 0x7A9B401F → Open`,
  ethereal, exclusion AABB added at local (81.7,33.6) ([phase6.E] wasm arm).
- BUT `open_door_exclusion_aabbs` is consulted ONLY by the legacy triangle
  chain (`clamp_delta_against_cell_walls_with_exclusions`); the FAITHFUL
  driver (default-on: `USE_FAITHFUL_TRANSITION=true`) never reads it — zero
  refs in faithful_bridge.rs/collision.rs. 0x16E has NO statics and the env
  BSP shouldn't contain the door panel, so this may not be the seam blocker —
  but it's a real gap for dungeon doors whose panel is baked into cell meshes.
- Suspect machinery: `find_cell_list` / `find_transit_cells`
  (holtburger-dat/src/transition/objcell.rs:323+) + the SceneWorld
  `build_cell_inner` neighbour resolution (faithful_bridge.rs:528) +
  membership re-seating (`point_in_cell`). The refusal shape (everything
  refused when ON a seam; fine mid-room) smells like end-position cell
  resolution failing on/near portal planes → treated as wall.
- ⚠ USER CONSTRAINT: the portal/cell graph is SHARED with exterior→interior
  visibility (PView/GetVisibleCells). Fix must stay in the physics/transit
  consumption side — do not mutate the shared graph.
- **RULED OUT (this session, via WBT DAT parse)**: "portal polygon collided
  as solid". Environment 840 struct 4 (the 0x16E vestibule): physics polys =
  {0..3}, portal polys = {4,5} — DISJOINT (struct 0 likewise: 0..30 vs
  31..34). Doorways are genuine holes in the physics data; the DAT is clean.
- **PRIME SUSPECT — cur_cell continuity**: retail carries `CPhysicsObj::
  cur_cell` as CONTINUOUS state, updated only through the transit walk
  (`remove_from_cell`/`insert_into_cell`, find_cell_list re-seat); it never
  globally re-derives "which cell am I in" from the pose. Our dispatch
  re-derives per slice (`begin_cell = scene.current_cell(&input.begin)`,
  faithful_bridge.rs:959) — ambiguous exactly ON portal planes where both
  membership BSPs meet (observed live: current_cell flaps 0x16E↔0x16A at
  (81,33)). A wrong begin_cell makes every sweep start outside/embedded in
  the wrong cell's BSP → all-directions refusal, and the ground resolve
  flaps too (the observed g true→false decay). Fix shape: thread the
  transition outcome's settled `curr.objcell_id` back into player state as
  the authoritative cur_cell and use it (not re-derivation) as begin_cell
  next slice; graph-safe (no shared portal-graph mutation). Cross-ref decomp
  `CPhysicsObj::set_cell`/`insert_into_cell` + `SPHEREPATH::check_cell`.
- Approach recommendation: native Rust integration test loading REAL env-840
  cells from client_cell_1.dat (fixture pattern: HOLTBURGER_PORTAL_DAT-gated
  tests in holtburger-dat/src/physics.rs:1769) reproducing the (81,33) seam
  refusal offline; then debug against decomp `find_cell_list`
  (acclient.c:348110 area), `check_cell`, `find_transit_cells`.
- Note: `USE_UNIFIED_TRANSITION`/`USE_FAITHFUL_TRANSITION` consts are `true`
  and OR'd with runtime flags — NO URL escape. A/B requires a const flip +
  rebuild.

## 5. Ops log (2026-07-18 afternoon)

- **MariaDB OOM outage 14:52–15:58Z**: earlyoom SIGTERM'd mariadbd during
  swap exhaustion (swap 0.08% free); ACE auth queries hung → every login
  timed out unauthenticated ("Account: , Reason: N" @17 s) → soak boot-dead
  ~1 h. Diagnosis chain: client `connecting→error` + ACE "Login Request →
  Creating session → drop" with NO AuthenticationHandler line + wsbridge logs
  clean (bridge restarted anyway, was fine, now logs to soak scratchpad).
  Restarted via `sudo service mariadb start` (user-supplied password in
  terminal). NOTE: `mysqladmin ping` without creds now returns
  "Access denied" — that means the server is UP (auth-reject ≠ down).
- **Idle-session sweep (user-directed)**: 7 multi-day idle `claude` sessions
  (2–17 days, ~630 MB + children) SIGTERM'd cleanly after verifying none
  ancestored serve.py / soak runner / wsbridge / ACE / my own session.
  Available memory ~1.5 G → ~3.3 G. Daemon + bg-pty spares left alone.
- Soak v6.5.4 final: ended 16:15Z by operator. Torval lvl 7, 30 credits,
  0 kills, 5000 coins (the §5.1 stat-wipe did NOT recur on session-5 relog —
  lvl/credits read correctly; the missing-5000-pyreals half remains). Runner
  survived 4 relaunches incl. the DB outage (relaunch loop + monitor both
  worked as designed).
- Repro scripts (all in `/mnt/wbterminal2/holtburger-scratch/soak-v65/
  repro-2026-07-18/`): `moveto_wedge_diag` (two-venue moveTo), `moveto_flag_ab`
  (indoor flag A/B + diag capture), `bake_race_probe` (residency race),
  `door_repro`/`door_repro2` (grocer seam + in-room vendor proof),
  `boot_probe` (login diagnosis).

## 6. Next-session candidates

1. **Seam transit fix (§4)** — unblocks doors, room-to-room, building exit;
   then rerun `vendor_fix_live.cjs` (both arms should pass) and relaunch the
   soak (v6.5.5) for the economy arc.
2. Faithful-driver open-door exclusions (§4 bullet 2) — dungeon-door parity.
3. Varek/Torval pyreal-stream mystery (soak-8 §7.2, unchanged).
4. Content follow-ups (soak-8 §7.5) + the 10 stale movement tests
   (handoff-7 §5; NOT worsened by this session's changes).
