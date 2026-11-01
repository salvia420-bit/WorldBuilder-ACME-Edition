# ACE server side of the vehicles work (patches)

ACE is not part of this repo, so the server half of the vehicles work lives here as `git format-patch` output on
upstream ACE (`https://github.com/ACEmulator/ACE.git`, master at **`a8ff29f`** "[ci skip] Updating
ServerBuildInfo_Dynamic.cs"). The client half (protocol, wasm, JS) is in this repo; both must come from the same
revision, because they share the HBV1 wire format, its byte fixtures and the flight model the parity tests pin.

| Patch | What |
|---|---|
| `0001-ACE.Database-points-of-interest-cache-…` | A small local change the live server already ran before the vehicles work (`@telepoi` name trimming, no cached misses). Not vehicle-related. |
| `0002-Vehicles-holtburger-fork-…` | The vehicles server: HBV1 messages + capability handshake, `VehicleManager` (flight model, board / exit / bail-out, gun, derelicts, retail chat), fast-flight streaming, diagnostics, `ACE.Server.Tests/Vehicles`. 45 files with 0001, +5,270 lines. |

On this laptop the same two commits are on the local branch `vehicles-2026-11-01` of `~/ace-server` (its `origin` is
upstream ACE, so they are not pushed anywhere else).

## Apply

```sh
git clone https://github.com/ACEmulator/ACE.git ace-server
cd ace-server
git checkout -b vehicles-2026-11-01 a8ff29f
git am /path/to/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/docs/vehicles-2026-11-01/ace/*.patch
```

Verified 2026-11-01: both patches apply to `a8ff29f` and reproduce the branch tree exactly.

## Build, deploy, enable

- Build: `capped-build dotnet build Source/ACE.Server/ACE.Server.csproj -c Release -o <side dir>` — not into the live
  `bin/Release/net10.0`.
- Deploy: stop ACE, copy `ACE.Server.dll` + `.pdb` **and** `ACE.DatLoader.dll` + `.pdb` (0002 adds a diagnostic counter
  to `DatDatabase`), restart. Recipe and rollback copy: `../HANDOFF.md`.
- Every feature is behind a server property that defaults off (with all off, ACE behaves as upstream):
  `vehicles_enabled`, `landblock_wake_on_entry`, `vehicle_preload`, `vehicle_preload_offthread`,
  `vehicle_short_retention`, `vehicle_landblock_budget`, `vehicle_retail_chat` (bools; console `modifybool <name> true`),
  `vehicle_speed_cap` (69 → 111 for 400 km/h), `vehicle_sight_radius` (112.5 → 350) (`modifydouble <name> <value>`).
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
