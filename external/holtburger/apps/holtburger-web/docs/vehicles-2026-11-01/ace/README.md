# ACE server side of the vehicles work (patches)

ACE is not part of this repo, so the server half of the vehicles work lives here as `git format-patch` output on
upstream ACE (`https://github.com/ACEmulator/ACE.git`, master at **`a8ff29f`** "[ci skip] Updating
ServerBuildInfo_Dynamic.cs"). The client half (protocol, wasm, JS) is in this repo; both must come from the same
revision, because they share the HBV1 wire format, its byte fixtures and the flight model the parity tests pin.

| Patch | What |
|---|---|
| `0001-ACE.Database-points-of-interest-cache-…` | A small local change the live server already ran before the vehicles work (`@telepoi` name trimming, no cached misses). Not vehicle-related. |
| `0002-Vehicles-holtburger-fork-…` | The vehicles server: HBV1 messages + capability handshake, `VehicleManager` (flight model, board / exit / bail-out, gun, derelicts, retail chat), fast-flight streaming, diagnostics, `ACE.Server.Tests/Vehicles`. 45 files with 0001, +5,270 lines. |
| `0003-Vehicles-holtburger-fork-1070-fixes-…` | Session 2 (2026-11-01 evening): the seat and gun muzzle in the stand-in balloon's basket; the M3 world-loop residual — bring-up / load-origin / single-threaded diagnostics, vehicle-only marking on the physics / heartbeat / relocation load paths, link children's weenies prefetched, physics GfxObjs warmed off-thread, GC-first stall classification. 7 files. |
| `0004-Vehicles-holtburger-fork-the-high-band-…` | Flight experience Phase 4 and the film shoot (2026-11-01 late → 11-02; committed in `~/ace-server` on the owner's "commit and push", 2026-11-02; vehicle tests 9/9). Spawn-time `vehicle_ceiling_agl` / `vehicle_climb_max`; `vehicle_derelict_high_agl` (an empty vehicle high up despawns after 30 s); `vehicle_high_band_agl` (a pilot above it sees by 3D distance, `ObjectMaint.Sight3D`, and skips `CheckMonsters`); the world edge `FlightModel.WorldMax` 256 → 255 landblocks (0xFF does not exist; the client's flight / fall models match). Plus the bail-out animation work: `vehicle_fall_motion` (default off; the bailed body is broadcast in retail's Falling motion 0x40000015 and back to Ready at every end, never on a corpse) and, unconditionally, a teleport during a fall sends the faller a placement-less Touchdown so its client releases the body at once. 5 files. Apply after 0003 with `git apply`. Design: `../../flight-experience-2026-11-01/HIGH-BAND.md` §5. Plus the film shoot (2026-11-02, the owner's Hellcat video): `vehicle_gun_players` (bool, default off — the gun also hits players on foot through `Player.TakeDamage`'s own path: lifestone protection, death, corpse; never the pilot, a seated or a falling player; PK status not checked), `vehicle_observer_sight_radius` (double, default 0 — a capable client on foot gets this first-sight radius, landmarks only beyond 112.5 m, two rings max), and a crash fix: `Unseat` clamps the body's placement to landblocks 1-253 (a pilot logging out from a Hellcat drifted into the map's north-east corner took the world thread down in `LandblockManager.GetLandblock`, IndexOutOfRange, 03:23 NST). Both properties were set for the shoot and set back to their defaults afterwards. |
| `0005-Vehicles-holtburger-fork-teleport-unseat-…` | 2026-11-02 (after the film reshoot's code review). A pilot unseated IN THE AIR by a teleport (portal, recall, death, admin) got only the seat release; the client took it for the first half of a bail (the bail hand-off) and held the body on the empty aircraft's seat over the teleport's destination. `VehicleManager.OnPlayerTeleport` now also sends that pilot a placement-less Touchdown (cell 0, value -1) right after the seat release, as `VehicleBailout.Cancel` does for a faller; the wasm releases any seat lock on it. The client also ends the hand-off on PlayerTeleport itself (`scene3d/vehicle/index.js` `onTeleport`, called from `app/client_events.js` kind 33), so either side alone covers the common case. 1 file. Apply after 0004. Deployed on the live ACE 2026-11-02 12:00 NST (nobody online; rollback copy kept). |
| `0006-Vehicles-holtburger-fork-Hellcat-from-AC-items-armam…` | Session 3 (2026-11-02; DESIGN decisions 62-73; committed in `~/ace-server` as `a04bad6` on the owner's "commit and push", 2026-11-02; vehicle tests 12/12). The Hellcat built from AC items (`VehicleProfile`: 55 parts + roles; the retail stand-in is now the 2x Bucket, the seat in the tub); HBV1 v2 (`VehicleWire`, tests + fixtures); the armament: six crossbow guns (one salvo per step, harmonized 110 m, hits on arrival), six rails launching real Lightning Bolt spell projectiles (the vehicle as the launcher, `ItemSpellcraft` 400), one 2,000 lb + two 1,000 lb bombs (`VehicleOrdnance`: ballistic twin, blast damage, a retail fireball, the Explosion event), the landing rearm, `@vehicle rearm`; review fixes (positions in landblocks 0-254, the login snap for characters saved in the sky, pilot / faller deaths on the world thread, combat / spells / Use / recall refused while seated or falling, no boarding while falling, idle parked vehicles despawn, the pilot-only sight budget, concurrent `seated` / `falls`, reused broadcast buffers, the armament warm-up off the world thread); the GC fixes (`vehicle_defer_dungeons`, `vehicle_shared_cellstructs` + `CellStructCache`, the promoted-MB stall line); the villa / mansion basement link costs (decision 73: `House` / `HousePortal.SetLinkProperties`, the house-portal + outdoor-house query warm-up, the root landblock in the spawn warm-up) and the `[HEAVYADD]` per-parent split / `[VEHICLE][INBOUND]` diagnostics (`InboundMessageManager`). Plus `run-ace-live.sh` (the laptop's launch line with the GC settings: gen0 + gen1 budgets 16 MB per heap, DATAS off, 2 heaps). 41 files. Deployed on the live ACE 2026-11-02 (rollback `/mnt/wbterminal2/ace-rollback/net10.0-20261102-pre-hellcat-v2/`). |

On this laptop the same commits are on the local branch `vehicles-2026-11-01` of `~/ace-server` (its `origin` is
upstream ACE, so they are not pushed anywhere else).

## Apply

```sh
git clone https://github.com/ACEmulator/ACE.git ace-server
cd ace-server
git checkout -b vehicles-2026-11-01 a8ff29f
git am /path/to/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/ace/*.patch
```

Verified 2026-11-01 (again after 0003): the patches apply to `a8ff29f` and reproduce the branch tree exactly. All four regenerated 2026-11-02 after 0004; 0005 added the same day; the whole series regenerated after 0006 (2026-11-02 evening): `git am` of 0001-0006 on `a8ff29f` gives the branch's tree exactly (`c41716c`).

## Build, deploy, enable

- Build: `capped-build dotnet build Source/ACE.Server/ACE.Server.csproj -c Release -o <side dir>` — not into the live
  `bin/Release/net10.0`.
- Deploy: stop ACE, copy `ACE.Server.dll` + `.pdb` **and** `ACE.DatLoader.dll` + `.pdb` (0002 adds a diagnostic counter
  to `DatDatabase`), restart. Recipe and rollback copy: `../HANDOFF.md`.
- Every feature is behind a server property that defaults off (with all off, ACE behaves as upstream):
  `vehicles_enabled`, `landblock_wake_on_entry`, `vehicle_preload`, `vehicle_preload_offthread`,
  `vehicle_short_retention`, `vehicle_landblock_budget`, `vehicle_retail_chat` (bools; console `modifybool <name> true`),
  `vehicle_speed_cap` (69 → 111 for 400 km/h), `vehicle_sight_radius` (112.5 → 350), and with 0004
  `vehicle_ceiling_agl` (0 = profile 450; 5000 = the high band), `vehicle_climb_max` (0 = profile 20; 40),
  `vehicle_derelict_high_agl` (0 = off; 600), `vehicle_high_band_agl` (0 = off; 600) (`modifydouble <name> <value>`), and
  `vehicle_fall_motion` (bool, default off; `modifybool vehicle_fall_motion true`), `vehicle_gun_players` (bool, default off)
  and `vehicle_observer_sight_radius` (double, default 0; 380 for the film); with 0006 `vehicle_defer_dungeons` and
  `vehicle_shared_cellstructs` (bools, default off; ON on the live server since 2026-11-02 — the GC fixes).
- Tests: `capped-build dotnet test Source/ACE.Server.Tests/ACE.Server.Tests.csproj -c Debug --filter FullyQualifiedName~Vehicles`
  (Debug only: a Release test build writes into the live directory).

## After changing the server code

1. Commit in `~/ace-server` on `vehicles-2026-11-01`.
2. If the wire fixtures or the flight golden changed, run `../protocol/sync-ace-fixtures.sh` first (it copies them into
   `ACE.Server.Tests/Vehicles/`), and commit those too.
3. Regenerate the patches here (delete the old ones first):
   `rm -f *.patch && git -C ~/ace-server format-patch a8ff29f..vehicles-2026-11-01 -o .`
4. Commit the new patches together with the client change that needs them.

## Moving to a newer upstream ACE

In `~/ace-server`: `git fetch origin && git rebase origin/master` (resolve, build, run the tests), then regenerate the
patches with the new base (`format-patch origin/master..vehicles-2026-11-01`) and update the base commit at the top of
this file.
