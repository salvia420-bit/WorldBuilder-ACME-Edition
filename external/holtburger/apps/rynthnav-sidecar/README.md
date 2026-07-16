# rynthnav-sidecar — the RynthNav GLOBAL router (report 09, Option A)

The route-producing half of report 09's nav split: offline navmesh bake (Recast) +
runtime Detour query + portal-graph Dijkstra, served over HTTP to the in-page leg
executor (`apps/holtburger-web/rynth/router.js`, which walks `[{lb,x,y,z,portal?}]`
legs via `moveToPosition`). The JS client is `rynth/global_router.js` (`GlobalRouter`,
plan→walk→replan); `bot.goto(to)` and the control-channel `goto <ns> <ew>` ride it.

A holtburger-web **user needs no DAT files** — DATs are touched only at bake time by
the operator. At runtime the sidecar reads baked `.tile` files + `portals.tsv`, the
same static-artifact pattern as the dist shards.

## HTTP contract (mirrored in `rynth/global_router.js` — keep in sync)

```
GET  /health -> {"ok":true,"tiles":25,"portals":817}
POST /route  {"from":{"lb":<u32 objCellId>,"x":f,"y":f,"z":f},
              "to":{"lb":u32,"x":f,"y":f,"z":f} | {"ns":<deg>,"ew":<deg>}}
  -> {"ok":true,"legs":[{"lb":u32,"x":f,"y":f,"z":f,"portal":bool,"label":s}],
      "estUnits":f,"portalsUsed":n,"coverage":"detour"|"straight"|"mixed"}
  -> {"ok":false,"error":"..."}   (planning failure is still HTTP 200)
```

Legs are emitted in router.js's frame: full 32-bit objCellId with correct outdoor
cell low-word (`1 + floor(x/24)*8 + floor(y/24)`), landblock-local AC Z-up metres,
≤ ~40 m strides. CORS (`Access-Control-Allow-Origin: *` + OPTIONS preflight) is on
every response — pages on :8765 fetch cross-origin; serve.py cannot proxy.

## Run (all commands from this directory)

```
# build (single-project dotnet is memory-safe on the laptop)
DOTNET_ROLL_FORWARD=LatestMajor ~/.local/bin/dotnet build -c Release

# serve (leave running; convention: setsid nohup + /mnt log, dies on reboot)
setsid nohup ~/.local/bin/dotnet bin/Release/net10.0/RynthNav.Sidecar.dll serve \
  --nav /mnt/wbterminal2/rynthnav-data --portals data/portals.tsv \
  --listen 127.0.0.1:8767 >> /mnt/wbterminal2/rynthnav_sidecar_console.log 2>&1 &
```

Smokes: `rynth_sidecar_smoke.cjs` (node-only contract test, FAST set) and
`rynth_globalroute_smoke.cjs` (live end-to-end walk, FULL set) in `apps/holtburger-web/`.

## Bake pipeline (operator-only; DATs + dist scenery required)

```
# 1. extract collision geometry (buildings/statics from cell.dat LandBlockInfo,
#    scenery from the dist bake's per-LB jsonl) -> geom_{LB:X4}.jsonl
~/.local/bin/dotnet build tools/GeomExtract -c Release
~/.local/bin/dotnet tools/GeomExtract/bin/Release/net10.0/GeomExtract.dll \
  --ac ~/ac_base_dats --scenery /mnt/wbterminal2/holtburger-dist/scenery \
  --out /mnt/wbterminal2/rynthnav-data/geom --tiled A7,AB,B2,B6

# 2. bake tiles (hex lbX-min,max,lbY-min,max). --geom optional but WITHOUT it the
#    tiles are TERRAIN-ONLY and routes cut straight through buildings (live-proven
#    failure mode: the MoveTo servo grinds on walls forever, pursuitStatus stays 1).
~/.local/bin/dotnet bin/Release/net10.0/RynthNav.Sidecar.dll bake \
  --ac ~/ac_base_dats --out /mnt/wbterminal2/rynthnav-data \
  --tiled A7,AB,B2,B6 --geom /mnt/wbterminal2/rynthnav-data/geom

# 3. RESTART serve after rebaking existing tiles (already-loaded tiles are not
#    refreshed; /health tile count alone updating does not mean the mesh reloaded).
```

Bake provenance lands in `--out`: `bake-source.sha256`, `bake-params.json`
(records `"geometry":"statics+scenery"` when --geom was used). Big artifacts
(.tile, geom, logs) live on `/mnt/wbterminal2` only — the root disk is ~94% full.

## Traps (each cost real time)

- **Scenery Setups have NO physics polygons** — retail collides trees/rocks via the
  Setup's CylSphere/Sphere list. GeomExtract emits those as 8-sided prisms when a
  Setup's parts yield no physics tris; ~116 GfxObjs region-wide legitimately have
  no collision (grass). A "0 scenery tris" extraction means you hit this, not "done".
- **Decimal objCellId**: JS must send `lb >>> 0`. A wrong decimal id from an unbaked
  LB still returns a plausible-looking `coverage:"straight"` route — sanity-check
  `coverage=="detour"` inside baked regions.
- **maxTiles=256** in DetourRouter, no eviction — raise it before serving a region
  larger than 256 tiles.
- **DtNavMeshQuery must be reconstructed after any tile add/remove** (upstream
  RynthNavPlugin.cs rule; already encoded in DetourRouter).
- Vendored C# under `vendor/rynthsuite/` mirrors upstream at rev bf1fb52 with
  provenance headers — sync manually, upstream is a read-only reference checkout.
  `tools/GeomExtract` uses NuGet `Chorizite.DatReaderWriter 2.1.2` (the local
  `external/DatReaderWriter` checkout doesn't build standalone — missing
  SourceGenerator project).

## Known limits / follow-ups

- **Indoor routing**: dungeon walls aren't baked (upstream Phase-3 gap carried over);
  indoor legs need the cell-graph A* path (report 09 §1b), not Detour.
- **Portal arrival coords** are retail GoArrow data (~0.1° rounded) — re-validate
  per-portal against our ACE before trusting `portal:true` legs far from Holtburg.
- **Coverage**: only the 5×5 Holtburg region (A7–AB × B2–B6) is baked; elsewhere the
  planner falls back to straight-line legs. Full-map bake is a buildbox fan-out job.
- Lifecycle is manual (`setsid nohup`, dies on reboot) — cron `@reboot` or a
  supervisor.cjs spawn block are the candidate owners.
