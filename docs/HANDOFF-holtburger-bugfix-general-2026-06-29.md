# Holtburger-web — general bug-fix handoff (2026-06-29)

**Purpose:** onboard an agent to bug-fix **holtburger-web** (a faithful 3D Asheron's Call
web client: Rust/wasm physics + JS/three.js render) without a cold start. Read this, then
the rapidgrep index in `~/.claude/.../memory/MEMORY.md` for deep recipes.

**Prime directive:** be FAITHFUL to the retail AC client. The decomp `acclient.c` WINS;
ACE (`~/ace-server`) is **reference-only** (never put server/DB data into the client);
no PhatAC/PhatSDK. Ground parser/physics/net fixes in **real DAT/wire data** before coding.

---

## 0. Current state (as of 2026-06-29)

- **Repo:** `/home/wbterminal/WorldBuilder-ACME-Edition` IS the git repo (remote `origin` =
  `github.com/salvia420-bit/WorldBuilder-ACME-Edition`). `external/holtburger/` is a **tracked
  subdir, NOT a submodule**. Run `git` from anywhere inside.
- **Branch:** `master` is canonical, at `7538a63a`, pushed to origin. Tree clean.
- **Shipped (Phase D + E):** faithful outdoor terrain collision + Option-C off-center-building
  fix (`69a782b8`); vertical-lip step-up (`2f181a96`); cross-portal collision depth-1
  (`7af9273b`) + multi-hop/sphere-gate (`f6377ed3`); per-step SLERP (`4d6328f5`); outdoor
  water type/depth on the faithful path (`7538a63a`).
- **Last investigation (river crossing):** RESOLVED — water crossing **works** (rivers are
  PartiallyWater cells → wadeable); the reported "can't cross" block was a **fence** (correct
  static collision). NOT a water bug. See §3.

---

## 1. THE most important thing: which code actually runs (live vs faithful)

There are **two** collision systems. Know which one you're debugging.

### A. LIVE local-player path (DEFAULT — this is what the player experiences)
`SessionHandle.tickMovement()` (apps/holtburger-web/src/lib.rs) →
`MovementSystemHandle::tick` → **`advance_local_pose_for_manual_drive[_slice]`** in
**`crates/holtburger-core/src/client/movement/system.rs`** (the legacy/approximate integrator).
The player pose comes from `getLocalPlayerPose()` (x,y landblock-local, z world, heading, isOnGround).

Inside `advance_local_pose_for_manual_drive_slice` (~line 2713+), per slice:
- terrain-follow z-snap from `WorldState::terrain_height_at`
- **gates that REVERT the lateral move** (the usual "invisible wall" suspects):
  - `USE_WATER_COLLISION` (const, true) — **cell-level** `is_entirely_water_cell_at` (~3851)
  - `USE_TERRAIN_WALKABLE_GATE` (const, true) — steep-slope refuse (z>cur & normal.z<FLOOR_Z, ~3864)
- **lateral clamps (outdoor):** building AABBs (`clamp_delta_against_buildings_with_normal`,
  ~3213), outdoor static AABBs (`sweep_sphere_against_static_aabbs`, ~3316), static-BSP
  push-out (`resolve_static_bsp_pushout`, ~3393), then the **entity-collision pass** (~3489+).
- **indoor** uses cell-mesh triangle sweep (`clamp_delta_against_cell_walls_dispatch`) + AABB containment.

→ **When debugging player movement/collision, instrument HERE (system.rs), not the faithful driver.**
Const gates `USE_*` (system.rs ~660-700) are compile-time, no URL override.

### B. FAITHFUL CTransition driver (default-OFF for the player; `?faithfulTransition=on`)
`crates/holtburger-world/src/spatial/`:
- `transition.rs` — `find_transitional_position[_dispatch]`, `resolve_floor_for_step`
  (the env-water gate `gates.water_collision` lives here, default FALSE), `TransitionEnv`.
- `faithful_bridge.rs` — `SceneObjCell` (the per-cell `CObjCell`), `find_collisions`,
  `find_terrain_collisions`, `water_type`/`get_water_depth`/`classify_cell_water`,
  cross-portal flood (`find_transit_cells`, `build_cell_inner`, `MAX_PORTAL_HOPS`).
- `driver_validate.rs` — `frame_orient_interp` (the per-step SLERP, `acclient.c:357258`),
  `validate_walkable`.
- `scene.rs` — `SpatialScene` (per-cell BSP, AABB, membership, terrain heights + water codes).
This path is exercised by the **drift test harness** (`mod drift` in faithful_bridge.rs) and is
the porting target. It's `holtburger-dat::transition::*` for the driver internals.

### Shared world data
`crates/holtburger-world/src/state/types.rs` — `WorldState`: `terrain_height_at`,
`terrain_normal_at`, `water_depth_at`, `is_entirely_water_cell_at`, `is_water_terrain_code`,
`populate_terrain_heights`/`populate_terrain_water`. Fed from lib.rs on landblock load.

---

## 2. Build / test (laptop OOMs — discipline matters)

- **Toolchain by full path:** `~/.cargo/bin` (rust/wasm), `~/.local/bin` (dotnet).
- **Wasm:** `capped-build wasm-pack build --target web --out-dir pkg --dev` (~30-50s; `--release`
  ~4-5min). `pkg/` is **gitignored** → rebuild after any pull touching holtburger-web (stale →
  silent boot fail). `capped-build` is an OOM-jail wrapper (live: `cat $(which capped-build)`).
- **NEVER** run `cargo build/test --workspace` or bare `wasm-pack` locally (OOM). For big
  fan-out use the **buildbox** GCE VM (see MEMORY.md §1 buildbox runbook).
- **Rust tests:** `capped-build cargo test -p <crate> --lib [filter]`. Key crates/suites:
  `holtburger-world` lib (~506 + your additions), `holtburger-dat` `transition::` (258),
  `holtburger-common` (71), the `drift` module in faithful_bridge.rs.
- **Single-project dotnet** (WorldBuilder.Terminal) is memory-safe: `DOTNET_ROLL_FORWARD=LatestMajor dotnet build WorldBuilder.Terminal -c Release`.
- LSP/rust-analyzer spews false `lib.rs` errors for the wasm app crate (cfg-gated modules);
  **cargo/wasm-pack is the authority**, not the IDE diagnostics.

---

## 3. Recent findings (don't re-investigate these)

- **Live player uses the legacy integrator (system.rs), not the faithful driver.** The faithful
  BSP driver is `?faithfulTransition=on` (default OFF); `?faithfulOutdoor` gates its outdoor branch.
- **Water:** terrain types **16-20** = water (`WaterRunning`/`WaterStandingFresh`/`WaterShallowSea`/
  `WaterShallowStillSea`/`WaterDeepSea`), from `(terrain>>2)&0x1F` matched vs the client
  `TERRAIN_SURF_CHAR[32]` table (acclient.c:41303). A 24m cell is EntirelyWater iff all 4 corner
  vertices are water types, else Partially/Not. **Real rivers = PartiallyWater cells → wadeable**
  (only deep ocean is EntirelyWater). Retail's HARD water block is **block-level** (`get_block_water_type`
  == ENTIRELY = full-ocean landblock); per-cell uses depth (0.9 entirely → no walkable contact;
  0.45/0.1 partial). The live integrator's water gate is **cell-level** (`is_entirely_water_cell_at`)
  — slightly over-blocks vs retail but rivers (partial) still cross fine.
- **Latent wart (harmless):** `WorldState::is_water_terrain_code` counts codes **22/23**
  (`FauxWaterRunning`/`SeaSlime`) as water, but retail `TERRAIN_SURF_CHAR` + ACE `SurfChar` mark
  them SOLID. Codes 21/22/23 **never appear in real DAT data** (scanned 130+ landblocks), so it's
  inert. The faithful path (`classify_cell_water` in faithful_bridge.rs) correctly uses 16-20 only.
- Buildings/fences/statics block via the lateral clamps (§1.A) — that's correct collision.

---

## 4. Live testing — vistest & headless repro

### Dev server + game bridge (both must run)
- **serve.py** = the ONLY dev server: `external/holtburger/scripts/serve.py` (:8765, serves live
  JS + `pkg/` from disk; fail-loud on missing baked layers, `--allow-missing` to bypass).
- **holtburger-wsbridge** on **:8080** = the game-server proxy (client → bridge → ACE). Required
  for login. WS-only (closes non-WS connections).
- **Account:** `phase4demo` / `phase4demo`. **SINGLE-LOGIN** — one session at a time; a 2nd login
  within ~25s = "Account In Use" boots both. Stay off it while a human is testing.

### Remote vistest via cloudflared (CURRENTLY UP — user asked to keep these running)
- Serve tunnel: `https://valley-duty-coordination-discrete.trycloudflare.com`
- Bridge tunnel: `https://condo-nova-candle-ash.trycloudflare.com` (use as `wss://…`)
- **Short link** (redirect at serve root, `external/holtburger/go.html`):
  `valley-duty-coordination-discrete.trycloudflare.com/go.html` → autoLogin + bridge_url + `quality=low`.
- These are **ephemeral** trycloudflare URLs (die when `cloudflared` stops; new URLs on restart —
  then update `go.html`). Restart: `cloudflared tunnel --url http://127.0.0.1:8765` (and `:8080`).
- curl can't test WS-over-cloudflare (HTTP/2); use a node `WebSocket` client (`node --experimental-websocket`).

### Useful URL flags (full list: `external/holtburger/apps/holtburger-web/docs/url-flags.md`)
`?quality=low|mid|high|ultra` (default auto-by-GPU → **force `low` on weak GPUs / Firefox to avoid
WebGL context loss**), `?bridge_url=wss://…`, `?autoLogin=1&account=X&password=X&autoSpawn=first`,
`?nosw=1` (MANDATORY under any tunnel — SW caches index.html), `?agent=1`, `?faithfulTransition=on`,
`?wireframe=1`, `?nullRender=1`, `?renderOnDemand=1`, `?netDrainHz=N`.

### Headless repro pattern (playwright-core over CDP)
Playwright-core lives at `~/.npm/_npx/*/node_modules/playwright-core` (CommonJS: `import pkg from …; const {chromium}=pkg`).
No local chromium → drive a real browser via the **1070 box** (MODE2i runbook in MEMORY.md §1;
a person uses it — off-screen only, kill test chrome by `--user-data-dir` match, NEVER
`browser.close()`/`taskkill /IM chrome.exe`). Connect: `chromium.connectOverCDP('http://127.0.0.1:9333')`
(through an SSH tunnel). Key `SessionHandle` methods for a movement repro:
```
getLocalPlayerPose() -> {x,y,z,heading,isOnGround}   getCurrentCellId() -> u32 (landblock = id & 0xFFFF0000)
isCurrentCellIndoor()   setMovementInput(forward,strafe,turn,run)   turnToHeading(rad)   setAutoRun(on)
tickMovement()   jump(power)   sendChat('@telepoi <town>')   sweepSphereAgainstCellMesh(...)
```
Drive: `setMovementInput(1,0,0,true)` + hold (the live tick integrates) + sample `getLocalPlayerPose()`.
Calibrate "north" empirically (the heading→world-XY convention is non-obvious; pick the heading that
maximizes +y). Single-login cooldown: park on about:blank, wait ~40-50s, then goto. Boot: poll
`window.__bootState === 'in-world'` (helpers attach AFTER 'in-world'). `__diag` has ~16 surfaces.

---

## 5. The oracles (truth sources)

- **Decomp** `~/ac-headers/`: `acclient.c` (31M, the crown jewel), `acclient.h` (structs),
  `acclient.txt` (82M PDB dump — `rg -a`; awk-by-typeid dumps any enum/struct). Faithfulness wins here.
- **WB.Terminal** (the DAT/world oracle, 211 commands): `WorldBuilder.Terminal`; run
  `DOTNET_ROLL_FORWARD=LatestMajor dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin`,
  one JSON obj per line. Terrain: `get-terrain-data`/`terrain-info`/`get-heightmap`/`describe-landblock`
  (args `lbX,lbY`); objects: `list-objects`/`query-radius`; `chorizite-parse-dat-record`,
  `region-export-json`. Base dats: `~/ac_base_dats/client_portal.dat`, `client_cell_1.dat`.
- **ACE** `~/ace-server/Source` — clean C# reference (DatLoader parsers, Physics). REFERENCE ONLY.
- **MEMORY.md** (`~/.claude/projects/-home-wbterminal/memory/MEMORY.md`) — the rapidgrep index:
  runbooks (buildbox, 1070, capped-builds, chrome-testing), one-line rules, and copy-paste grep
  recipes for decomp/dats/WB.Terminal/chorizite/discord. **Grep this first** for any deep lookup.
- **Discord archive** (dev-community gotchas): sqlite FTS at `/mnt/wbterminal2/ac-discord-archive/_indextest/ac.db`
  (gold channels: worldbuilder, decalinfo, chorizite, metaf, sourcecode). See MEMORY.md §4.

---

## 6. Workflow discipline

- Commit locally; **confirm before push/deploy** (outward-facing). `master` push on 2026-06-29 was
  explicitly requested. End commit messages with the Co-Authored-By trailer; no backticks in `git -m`.
- For a bug: reproduce first (headless or 1070 vistest) → instrument the LIVE path (system.rs) with
  temporary `log::warn!` → identify → fix → revert probes → rebuild clean → re-verify. Ground claims in
  real data (DAT parse / live console), don't theorize.
- Validated render/physics/movement changes ship **default-ON** with a `?flag=off` escape; HUD/UI
  bug-fixes apply direct. Keep the drift/transition test suites green.
- Use external drives for scratch (system disk is ~85-96% full): `/mnt/wbterminal{1,2}/`.
