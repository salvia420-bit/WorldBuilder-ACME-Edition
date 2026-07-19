# Appendix A — RynthSuite Navigation Machinery (Explore-agent report, 2026-07-18, citations spot-verified)

Root: `external/holtburger`. Two-tier split from report 09: a **C# HTTP sidecar** owns global/offline navmesh routing (Recast bake + Detour query + portal Dijkstra); an **in-page JS layer** owns leg-walking and indoor cell-graph A*.

## 1. Route-following layer — `apps/holtburger-web/rynth/router.js`

- Route = `[{ lb, x, y, z, portal? }, ...]`; `lb` full u32 objCellId, x/y/z landblock-local AC Z-up metres (router.js:9,:74).
- States: `IDLE | WALK | PORTAL | DONE | FAILED` (:62,:79,:89).
- Mover: `host.MoveToPosition(l.lb, l.x, l.y, l.z, true)` (:113, re-issued :219); `StopCompletely()` on arrival/cancel/fail; pose via `TryGetPlayerPose()`; secondary arrival: `GetPursuitStatus().now === 2` (:211-215).
- Constants: `ARRIVE_M=3.0`, `LEG_TIMEOUT_MS=30_000`, `REISSUE_MS=3000` (re-issue if not closing ≥0.2 m), `PORTAL_SETTLE_MS=4000`, `SEAM_JUMP_M=30` (:38-42).
- Portal legs: detected by world-frame jump ≥30 m (NOT lb-word change — small-jump lb change = on-foot seam, :189-192); PORTAL → stop → 4 s settle → resume at remaining leg nearest the new pose; `{portal:true}` leg consumed by the hop; stale pre-hop legs skipped (:236-273).
- Watchdogs: per-leg 30 s → FAILED; null-pose ticks still run the watchdog (dead pose source FAILs, not stalls) (:154-163,:224-228). `status = {state, leg, legs, walked}`.

## 2. RynthNav sidecar — `apps/rynthnav-sidecar/` (C#/.NET 10)

- Serves baked Detour tiles (`nav_{lb:X4}.tile`) from `/mnt/wbterminal2/rynthnav-data` + `data/portals.tsv` (817 rows, 5 cols `SrcNs SrcEw DstNs DstEw Name` — retail GoArrow data, ~0.1° rounded). Runtime needs no DATs.
- Endpoints: `GET /health` → `{ok,tiles,portals}`; `POST /route {from:{lb,x,y,z}, to:{lb,x,y,z}|{ns,ew}}` → `{ok, legs[], estUnits, portalsUsed, coverage}`; `coverage ∈ "detour"|"straight"|"mixed"` (DetourRouter.cs:56,:274). Planning failures = HTTP 200 `{ok:false}`; `from==to` = single zero-distance arrival leg.
- Route composition (DetourRouter.cs:239): `PortalRoute.Plan` (Dijkstra, /loc degrees) → per-walk-segment Detour corridor (`FindNearestPoly`/`FindPath[512]`/`FindStraightPath[512]`, ≤40 m strides); **no tile coverage → straight-line legs split at landblock seams** (:335,:377). LRU tile eviction knobs: env `RYNTHNAV_MAX_TILES` / `RYNTHNAV_TILE_HIGH_WATER`.
- Bake: `RynthNav.Sidecar bake --ac <dats> --out <dir> --tiled <minX,maxX,minY,maxY hex> [--geom]` — Recast cellSize 0.5, tileSize 384 (=192 m, 1 tile/landblock), WATERSHED. Terrain via TerrainSampler (9×9 grid). **`--geom` = obstacle-aware**: `tools/GeomExtract` emits `geom_{LB:X4}.jsonl` from cell.dat LandBlockInfo Objects+Buildings (GfxObj **physics** polys, retail winding) + dist scenery jsonl; **scenery Setups carry no physics polys — retail collides their CylSphere list, emitted as 8-sided prisms** (README.md:120). Terrain-only tiles are a proven failure (MoveTo grinds on Holtburg walls). Provenance: `bake-source.sha256` + `bake-params.json`.
- **Coverage today: only A7–AB × B2–B6** (README.md:141-143); indoor/dungeon walls deliberately NOT baked (handed to indoor_router cell-graph A*).
- Lifecycle: `scripts/rynthnav-sidecar-boot.sh` (idempotent, port-listen health gate, cron `@reboot`).

## 3. .af / .met / VTank nav files — NOT in the port

No parsers/converters exist in holtburger. `indoor_router.js:40,:446` explicitly note upstream `NavRouteParser` (RynthSuite `DungeonPathfinder.cs:353-431`) was NOT ported. `loot_loop.js` builds a VTank-style *loot* profile only. Upstream (see `/mnt/wbterminal1/ac-refs/rynthsuite`): the parser was FIXED and validated against 934 real VTank routes (934/934 round-trip, 37,851 waypoints) — trailer table `{Recall:1, Pause:1, Chat:1, OpenVendor:2, Portal(6):6, Npc(7):6}` after a 5-line prologue (`Type,EW,NS,Z,flag`), header `"uTank2 NAV 1.2"`, RouteType `{Circular=1, Linear=2, Follow=3, Once=4}` (Nav_DeepDive_2026-06-15 §0b).

## 4. global_router.js / indoor_router.js contracts

- `GlobalRouter.goto(router, to, opts)`: one-at-a-time latch; `_goto` opts `{retries=2, pollMs=500, poseTimeoutMs=15_000, stallMs=45_000}`; stall = status signature `state:leg:walked` unchanged for 45 s → cancel + `{ok:false, state:"STALLED"}`; external-cancel detection; replan = FRESH route from current pose ×2. Resolves `{ok, state, legsWalked, replans}`.
- `indoor_router.js` exports: `isEnvCellId, isDropEdge, nearestCell, findPath, findExitPath, toLegs, getMainRouteNodes, buildPatrolRoute, buildGraphFromWasm, buildStitchedGraphFromWasm` — pure DungeonPathfinder A* port over the wasm EnvCell portal-record graph; legs feed `router.follow()` directly.

## 5. Route recording / persistence

**None exists.** No breadcrumb capture, no learned-route store, no route files; the only persisted nav artifacts are operator-baked `.tile` files + `portals.tsv`. Routes are computed per-goto and discarded. (The only rynth localStorage keys are the AI API key and the AI scratchpad.)
