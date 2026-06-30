# Handoff — DAT rebake needed: the shipped bundle is a stale `pruned` bake that predates collision physics (you walk through buildings) — 2026-06-30

## TL;DR
The live data bundle (`/mnt/wbterminal2/holtburger-dist`, symlinked as `external/holtburger/dist`) was baked **2026-05-24 with `dat2hba --profile pruned`** (= `StripperManifest::logic_only()`) from the **base** DATs (iteration 0). That bake **predates essentially all of the last five weeks of physics + bake work**, so:

- **You walk through buildings.** Indoor **cell** physics BSP is present (live: `[bsp] drained N cell physics BSP trees`), but **outdoor static/building collision** (`resolve_static_bsp_pushout` + per-part `0x02 SetupModel` static BSP) needs the GfxObj/SetupModel **physics polygons**, which a `logic_only` bake made *before that code existed* almost certainly stripped or never emitted. Buildings keep their visual mesh (render fine) but have no collision geometry.
- Several **bake-emitted layers are stale or absent** relative to current tooling/code.

**Action:** re-bake from the base DATs with a profile that **keeps static/building physics geometry** (start with `--profile full`), re-shard into `dist/`, and refresh the derived layers (scenery / spawns / material-detail / windclips). Verify collision after.

## Current bundle state (measured 2026-06-30)
| Layer | Last baked | Notes |
|---|---|---|
| **shards** (core geometry/textures/surfaces) | **2026-05-24** | `manifest.json` v2, `generated_at 2026-05-24T07:25:55Z`, `source.*_dat_iteration = 0` (base DATs). Profile **pruned/`logic_only`**. |
| scenery (trees/rocks/foliage) | 2026-06-01 | |
| spawns (ACE creatures/objects) | 2026-06-26 | + a `spawns.wildernessfill-2026-06-17` variant dir |
| region events (sky/weather) | 2026-06-26 | |
| _health.json | 2026-06-29 | health stamp, not a bake |

Total ≈ **8.1 GB**. `dist` → `/mnt/wbterminal2/holtburger-dist` (external WD drive — see MEMORY for the thermal-shutdown/remount caveat).

## Why a rebake (what landed AFTER 2026-05-24)
Collision/physics + DAT-write + visual bakes, all post-bundle:
- Collision: Phase C/D/E2/E3 + the M2–M4 BSP series — `sphere_intersects_solid_poly`, `placement_insert`, outdoor `resolve_static_bsp_pushout`, cross-portal collision, cell-membership BSP (`USE_PHYSICS_BSP`/`USE_STATIC_BSP`, LIVE since 2026-06-16).
- **DAT-write tooling extended:** `5ba4686a` E12c DatPack writers (EnvCell / MotionKinematics / PhysicsScript wrap + Palette/SurfaceTexture/Surface) — the bake **emits more data types now** than the May 24 bundle has.
- Visual bakes: `windBake` (103-DID windclips), baked **aoMap** (cavity AO) + **roughnessMap**, Phase-5 material-detail.

## The bake
- **Tool:** `external/holtburger/apps/holtburger-tools/src/dat2hba.rs` (built: `external/holtburger/target/release/dat2hba`).
- **Profiles** (`ArchiveProfile` → `StripperManifest`):
  - `Full` → `None` (no stripping — keeps everything, incl. physics polys). **← start here for a collision-correct bundle.**
  - `Pruned` → `logic_only()` (what shipped; strips heavy geometry — the suspected cause of no building collision).
  - `Micro` → `micro()`, `Boot` → `boot(<lb>)`.
- **Inputs (base DATs, per MEMORY):** `~/ac_base_dats/client_portal.dat`, `~/ac_base_dats/client_cell_1.dat`, (+ local if used). Bake-source must emit a `bake-source.sha256` (MEMORY: `bake-base-dats-only`, reject `0x__FFxxxx`).
- **Pipeline:** base DATs → `dat2hba --profile full … assets.hba` → re-shard into `dist/shards/` + regenerate `manifest.json` → refresh derived layers (scenery / spawns / material-detail / windclip). The README §"Repack retail DAT files" has the canonical `dat2hba` invocation.
- **Venue:** buildbox-class. The laptop is memory-capped (see `capped-builds` in MEMORY — full Rust/wasm + an 8 GB bundle will OOM); run on the **buildbox** (GCE `buildbox`, 18 vCPU/47 GiB) or with the OOM-jail wrappers, writing output to `/mnt/wbterminal2/` scratch (system disk is ~85–96% full).

## Caveats (read before assuming the rebake fixes walk-through)
1. **Possibly partly code, not just data.** The handoff notes per-part `0x02 SetupModel` static BSP was a **deferred Tier-2** item — outdoor building collision may be code-incomplete, so a rebake might be necessary-but-not-sufficient. Verify, and if it still walks through with the physics polys present, the gap is the per-part static-BSP integrator.
2. **`full` is bigger than `pruned`.** If bundle size matters, the better long-term move is to **update the `pruned`/`logic_only` `StripperManifest` to KEEP SetupModel/GfxObj physics polygons** while still trimming pure-visual heavy data, then bake with that. (One-line-ish manifest change in the dat crate.)
3. Confirm the `shard_url_template` / `catalog_version` regenerate consistently so the web client's manifest fetch still resolves.

## Verification (after the rebake deploys to `dist/`)
- **Collision:** walk into a Holtburg building → you **stop** (no walk-through). Walk into outdoor scenery rocks → stop. Indoor cell solids still block.
- Bundle: `manifest.json` `generated_at` is today, `*_dat_iteration` reflects the source, `bake-source.sha256` present.
- Render unaffected: spawn-driven boot still streams terrain/buildings/statics/scenery (the 1070 e2e shows ~900 tree mats, full world). Re-run the 1070 drive to confirm 0 console errors.
- Spot-check the refreshed visual layers (AO/roughness/windclips) load.

## Unrelated note (not fixed by a rebake)
Remote testing over the trycloudflare/Tailscale tunnels intermittently drops the heavy concurrent fetch burst (and the WS-bridge entity stream), so from a constrained remote network the scene can render terrain-only (no NPCs/lifestone/trees). That's **transport**, not the bundle. The 1070-direct is the reliable test env. Current remote setup: serve via Tailscale Funnel (`https://wbterminal.tail1426c6.ts.net/go.html`, stable), bridge via an ephemeral cloudflared quick tunnel.
