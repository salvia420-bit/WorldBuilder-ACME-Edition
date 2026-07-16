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

Error taxonomy (batch-2 input hardening — all carry CORS headers, all JSON):
- **200 `{ok:false}`** — planning failures (unroutable, out-of-coverage) AND `from==to`
  now returns `{ok:true}` with a single zero-distance arrival leg.
- **400** — malformed/empty JSON, non-finite coords, out-of-`u32` lb, a bogus outdoor
  cell low-word, `ns/ew` outside the world (`~±102.8°`), or an **ambiguous `to`** that
  sends both `{lb,x,y}` and `{ns,ew}`.
- **413** — request body over 64 KB (Kestrel `MaxRequestBodySize`).
- **404 / 405** — unknown path / non-POST to `/route` (`use POST /route`).
An out-of-map goal returns a 400 in ~30 ms; it never spins the router (the deep
`DetourRouter.LoadCorridor` bbox clamp backstops any non-HTTP caller).

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

## Lifecycle (sysvinit laptop — no systemd; supersedes "Lifecycle is manual" below)

`scripts/rynthnav-sidecar-boot.sh` (repo `external/holtburger/scripts/`) owns process
lifecycle. It is idempotent — exits 0 immediately if `:8767` already answers
`/health` — so it is safe from cron, a watchdog, or by hand. Otherwise it launches
the exact serve command above (absolute paths, `setsid nohup`, console log appended
to `/mnt/wbterminal2/rynthnav_sidecar_console.log`) and fails non-zero unless
`/health` answers within 30 s. It refuses to double-start when something is
LISTENING on the port but failing `/health` (wedged sidecar / squatter). The check
is port-listen, deliberately not `pgrep -f`: any process quoting
"RynthNav.Sidecar.dll serve" in its cmdline (e.g. a Claude session carrying this
README in its prompt) is a pgrep false positive — proven on the buildbox fan-out.

Boot-time start is cron (`crontab -e` as the operator user):

```
@reboot /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/rynthnav-sidecar-boot.sh >> /mnt/wbterminal2/rynthnav_sidecar_boot.log 2>&1
```

cron `@reboot` can fire before local mounts settle, so the script waits (≤120 s)
for the console-log directory (`/mnt/wbterminal2`) before launching. Env overrides
for non-default layouts (all optional): `RYNTHNAV_HOME`, `RYNTHNAV_DOTNET`,
`RYNTHNAV_DIR`, `RYNTHNAV_NAV`, `RYNTHNAV_LISTEN`, `RYNTHNAV_LOG`.

Monitoring is a separate concern from spawning: `rynth/supervisor.cjs` polls
`$RYNTH_SIDECAR_URL/health` (opt-in env, default unset = off) alongside bot-page
health each cycle and logs loudly on down/up transitions — but it NEVER spawns the
sidecar. The boot script is the single spawn owner, so a supervisor crash/restart
can't double-start the sidecar and a sidecar restart never recycles healthy bot
pages. Restart after a rebake (loaded tiles are not hot-reloaded — step 3 above)
— kill BY PORT, not by `pkill -f` (same false-positive trap as above):

```
fuser -k 8767/tcp        # or: kill $(ss -ltnp | awk '/:8767 /{...pid...}')
scripts/rynthnav-sidecar-boot.sh
```

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
