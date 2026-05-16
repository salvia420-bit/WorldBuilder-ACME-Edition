# World Completeness Method

Production-grade method for rendering an Asheron's Call landblock such that the client's view is byte-equivalent to what any AC-derivative server (ACE, Coldeve, retail emulator) believes is in that landblock. No procedural generation on the client. Every visible thing comes from an explicit, addressable, version-controlled placement list.

Status: **shipped end-to-end against a 13×13 ring around Holtburg** (2026-05-14). The artifacts live on `origin/master` from commit `4eae2fc` through `ad26b39`. This doc replaces `hypotheticalmethod.md` as the canonical reference, now that the method is verified.

## The contract

For any landblock `lb` at any time:

```
rendered_placements(lb) ≡ {
    ∀ p ∈ LandblockInfo.objects[lb]        (DAT explicit)
  ∪ ∀ p ∈ scenery_bake[lb]                  (DAT baked)
  ∪ ∀ p ∈ landblock_instance[lb]            (ACE explicit, server-pushed)
}
```

No fourth source. No procedural fallback. No "approximately equal" — every renderer output must match the manifest. A validator (Phase E) enforces this.

## Why this method exists

Two-decade-old AC clients each carry their own procedural-scenery implementations and quietly diverge. ACE servers that need scenery for gameplay (cover queries, line-of-sight) rebuild the procedural pass server-side. Multiple actors, each computing the world independently from a noise function — fragile and unverifiable.

The method replaces all of that with a **bake**: compute scenery once from the canonical algorithm + canonical DAT inputs, serialize as explicit placements, ship the artifact to anyone who needs to agree on the world. Client renders it. Server uses it for cover. Tooling can edit individual trees. Diff tools compare any two consumers and report drift.

Procedural-on-client is the bug. Explicit-everywhere is the fix.

## The three placement sources

### 1. DAT explicit — `LandblockInfo.objects`

Hand-placed in the 1999 retail bake: buildings, signs, named POI props, specific landmarks. Stored in `client_cell_1.dat` at file id `(lbX << 24) | (lbY << 16) | 0xFFFE` per LB.

**Reader:** `holtburger_dat::landblock::LandblockInfo` (existing).
**Wasm export:** `fetch_landblock_objects(cell_ids) -> Vec<ObjectPlacement>` (existing) + `fetch_landblock_objects_soa(cell_ids) -> LandblockObjectsSoa` (commit `8d4794a` — bulk variant for validator throughput).
**Per-ring count (13×13):** 766 placements (47 buildings + 720 statics by `isBuilding` flag).
**Renderer:** `bakeStaticsForLandblock` + `bakeBuildingsForLandblock` (commits `11eb8f6` / `9ea1601`).

### 2. DAT baked — `scenery_bake[lb]`

Computed by a deterministic Rust port of `~/ace-server/Source/ACE.Server/Entity/Scenery.cs` (198 LoC). Inputs: the LB's `CellLandblock.terrain[81]` 16-bit terrain words + the canonical Region 0x13's `TerrainInfo.TerrainTypes[i].scene_types` + `SceneInfo.scene_types[i].scenes` + the Scene files (`0x12…`) referenced from there. Output: a Vec of `{obj_id, x, y, z, qw, qx, qy, qz, scale, source_cell_x, source_cell_y, source_obj_idx}` per LB.

**Crate:** `holtburger-scenery-bake` (commit `dcf3676`). Public API:

```rust
pub fn bake_landblock(
    region: &Region,
    landblock: &CellLandblock,
    landblock_id: u32,
    fetch_scene: impl FnMut(u32) -> Option<Scene>,
    fetch_obj_bounds: impl FnMut(u32) -> Option<LocalBounds>,
    building_aabbs: &[Aabb2D],
    mode: BakeMode,
) -> Vec<ScenicPlacement>;
```

**Modes** (commit `3340fb6`):
- `BakeMode::AceCompat` (default) — bit-equivalent to vanilla `ACE.Server.Entity.Scenery.Load()`. Use this when interoperating with an ACE-derivative server.
- `BakeMode::Strict` — adds slope rejection (which ACE has as a TODO) + bilinear Z (renderer-friendly). Use only when not interoperating with ACE.

**CLI:** `scenery-bake` binary at `apps/holtburger-tools/src/bin/scenery-bake.rs` (commit `068ea9a`). Required arg: `--dat-dir <PATH>`. Pre-flight rejects modder-allocated `0x__FFxxxx` records and sibling `custom_textures/` / `iter-*/` / `*.wbproj` markers. Emits per-LB `<lbHex>.scenery.jsonl` + `bake-source.sha256`.

**Parity with retail:** **100.000 % match** vs C# `Scenery.Load` at strict tolerance (`|Δxyz| < 1e-4`, `|Δscale| < 1e-5`, `quat·quat' > 0.9999`) across **16,700** placements in the 13×13 ring. See `docs/scenery-bake-b5-collision-parity-report.md` (current — covers the full algorithm including ACE's Collision() filter) and `docs/scenery-bake-b4-parity-report.md` (predecessor — collision-disabled upper bound).

The B.5 gate proves the bake is a 1:1 substitute for what an ACE server's `Scenery.Load` would compute on the same DATs. Two divergences from earlier revisions had to be fixed:
- **`info.objects` was treated as a collision-blocker.** ACE's `Landblock.init_buildings` populates the field that `Scenery.Load` tests against from `Info.Buildings` only, not `Info.Objects`. Fix: walk `info.buildings` exclusively in `scenery-bake::collect_building_aabbs`.
- **The bake used 4-corner rotation of the mesh-local AABB.** ACE's `BoundingBox.BuildBox` walks each mesh vertex through the placement transform individually. The corner-form is strictly looser, causing over-rejection on rotated objects. Fix: replace `LocalBounds` + `transform_local_aabb` with `transform_mesh_to_aabb` (vertex-by-vertex). The bake's closure API now takes `compute_world_aabb(PlacementXform) -> Option<Aabb2D>`, putting mesh-loading in the caller (`MeshCache` in `scenery-bake.rs`).

**Wasm export:** `fetch_landblock_scenery(cell_ids) -> Vec<ScenicPlacementJs>` + `fetch_landblock_scenery_soa(...)` (commits `65c11a1` + `8d4794a`).

**Per-ring count (13×13, ace-compat):** **16,700** placements across 168 of 169 LBs (post-B.5). Holtburg 0xA9B4 itself is the only zero-placement LB in the ring — the town's CellLandblock decodes to scene_info buckets that are deliberately empty in retail.

### 3. ACE explicit — `landblock_instance`

NPCs, monsters, portals, lifestones, chests, generators. Stored in the ACE world database, not the DAT. Pushed to the client at runtime via entity-spawn wire events.

**Source:** ACE-DB or `ace_spawn_records.jsonl` (existing snapshot at `/home/wbterminal/projects/RetailSmoke/`, 365,183 rows world-wide, 4520 LBs covered).
**Synthetic injector:** `scene3d/spawns.js` (commit `5d162a4`). Replays JSONL through `window.handleEntitySpawn` + `window.__scene3dEntityHook` — the same entry points a live ACE server uses. No bypass.
**Wasm export:** `fetch_landblock_spawns(cell_ids) -> Vec<EntitySpawnJs>` + `_soa` variant.
**Per-ring count (13×13):** 427 spawns across 44 of 169 LBs (Holtburg alone has 106).

The renderer's existing `entities.js` rig-construction pipeline handles the spawns. Whether the source is a live ACE wire frame or the synthetic JSONL replay is invisible to it.

## The bake's determinism contract

This is the load-bearing property. If it ever wavers, the whole pretence of "explicit placement" breaks:

- Run the bake twice on the same DAT, get **byte-identical JSONL**.
- Run on two different machines, byte-identical.
- Verify continuously via `apps/holtburger-tools/src/bin/scenery-bake-determinism.rs` (commit `3340fb6` — 100-iteration stress loop).

What makes this hard: AC's deterministic-noise math relies on C# integer-arithmetic overflow semantics. Mixed `int`/`uint` expressions promote to `long`; pure-`uint` expressions wrap at `2^32`; the algorithm intentionally exploits both. The Rust port uses explicit `u32::wrapping_*` for all u32 operations and `i32::wrapping_*` for the (rare) signed paths — verified bit-equivalent against the C# code via a small Python diff harness during the B.2 port.

## Base DATs only — never custom

The bake **must** run against retail base DATs. Never against project iterations with WorldBuilder edits.

Acceptable:
- `~/ac_base_dats/{client_portal.dat, client_cell_1.dat, client_local_English.dat}` (canonical install)
- `/home/wbterminal/projects/RetailSmoke/dats/base/` (1.2 GB byte-mirror)

Forbidden:
- Anything under `dats/iter-*/`
- Anything alongside a non-empty `custom_textures/`
- Anything emitted by WorldBuilder's `export apply:true` after `import-texture` / `import-render-surface` / `obj-import` / `add-object`

The bake CLI pre-flights by scanning the master directory for any file id with bits `0xFF` in the second-byte position (the modder-allocated range `0x__FFxxxx`). If any are present, the bake refuses to run. The `bake-source.sha256` sidecar lets consuming servers verify their DATs match before honouring the bake.

## The renderer's view

The renderer doesn't know or care which of the three sources produced a placement. Per-LB lazy:

```js
async function bakeStaticsForLandblock(scene3d, lbX, lbY, opts, wasmExports) {
  const cellId = ((lbX << 24) | (lbY << 16) | 0xFFFE) >>> 0;
  const [explicit, scenic] = await Promise.all([
    wasmExports.fetch_landblock_objects(new Uint32Array([cellId])),
    wasmExports.fetch_landblock_scenery(new Uint32Array([cellId])),
  ]);
  for (const p of [...explicit, ...scenic]) {
    addPlacement(scene3d, p);
  }
}
```

ACE entity spawns arrive separately through `entities.js`'s `spawn(meta)` path. Same renderer API surface — just a third stream of placements, all of which are explicit, all idempotent (already-baked / already-spawned LBs short-circuit).

### Cross-LB InstancedMesh collapse

Placements that share `obj_id` across the ring (e.g. one grass-tuft model with 921 placements) collapse to a single `THREE.InstancedMesh` with N instance matrices. The validator (next section) handles this — it walks `getMatrixAt(i)` and decomposes each transform.

The renderer doesn't know about per-LB visibility budgets; the InstancedMesh draw is one call regardless of where the player is. Distance culling is on three.js's default frustum cull.

## The validator (Phase E)

`apps/holtburger-web/validate_landblock_completeness.cjs` (commit `1242f25`). For a target LB ring it:

1. Builds the expected manifest from `fetch_landblock_{objects,scenery,spawns}_soa` (one bulk call per source per LB; 169 LBs × 3 sources = 507 cross-boundary fetches).
2. Walks the rendered scene's `staticsGroup`, `buildingsGroup`, `entitiesGroup`:
   - `Mesh` → emit one placement at `obj.position / quaternion / scale`
   - `InstancedMesh` → emit `obj.count` placements via `getMatrixAt(i).decompose(pos, quat, scale)`
   - `LOD` → walk index-0 child (highest detail)
   - `Group` → recurse
3. Matches by `(model_id, lb_x, lb_y, x ± 0.05m, y ± 0.05m, z ± 0.10m)`.
4. Reports missing-render (in expected, not rendered — placements the renderer dropped) and invented placements (in rendered, not expected — renderer making things up; worse).

The validator IS the source of truth. If it finds drift, the renderer is wrong — don't change the validator to make it pass.

### World-frame convention (important)

The renderer puts `terrainGroup`, `staticsGroup`, `buildingsGroup`, `entitiesGroup` directly under `worldRoot`, which has `rotation.x = -π/2`. So per-Mesh / per-instance `(position.x, position.y, position.z)` are in **AC world frame** — no `acToThree` inverse needed at validator time. `lbX = floor(pos.x / 192)`, `lbY = floor(pos.y / 192)`.

## Reproducible production loop

Given canonical retail DATs at `~/ac_base_dats/`, an ACE world DB (or `ace_spawn_records.jsonl` snapshot), and a renderer at the latest tip:

```bash
# 1. Bake scenery for the target region (one-time per DAT release).
cargo run -p holtburger-tools --bin scenery-bake --release -- \
  --dat-dir ~/ac_base_dats \
  --landblocks 0x0000..0xFEFE \
  --out /mnt/$DEV/holtburger-scenery-bake-prod/ \
  --mode ace-compat

# 2. Stage the bake into the renderer's dist tree.
rsync -a /mnt/$DEV/holtburger-scenery-bake-prod/ \
  /mnt/$DEV/holtburger-dist-v2/scenery/

# 3. Dump ACE entity spawns to the same dist tree (filtered per region).
python3 scripts/world-completeness/stage-ring-spawns.py \
  --jsonl /path/to/ace_spawn_records.jsonl \
  --ring 0x0000..0xFEFE \
  --out /mnt/$DEV/holtburger-dist-v2/spawns/

# 4. Bake `bake-source.sha256` and stage it.
#    (the scenery-bake CLI already emits this; staging step copies it through.)

# 5. Renderer boots, lazy-fetches /scenery/<lb>.scenery.jsonl and /spawns/<lb>.spawns.jsonl
#    per LB as the player walks. Idempotent per-LB Set guards prevent re-fetch.

# 6. Validator runs as a CI gate before any deploy.
node external/holtburger/apps/holtburger-web/validate_landblock_completeness.cjs \
  --ring 0x0000..0xFEFE --strict
```

To scale from a 13×13 region to whole Dereth (256×256 = 65,536 LBs), the same loop runs — just over more LBs. The artifacts that result:

- ~1.5 GB of scenery JSONL (extrapolated from the 13×13 ring's 3.1 MB at 14k placements)
- ~25 MB of spawn JSONL (already pre-staged for ~5% of LBs from the 102 MB world-wide snapshot)
- Per-LB validator runs as cheap CI per shipped change

## Open follow-ons

Tracked + non-blocking for the method's correctness:

1. **F.35 — URL-level fetch dedup in `ManifestResourceSource::prefetch`.** Root cause of the entity rig race surfaced in Phase E + D-polish. 13 concurrent spawns currently fire ~78 redundant HTTP GETs because the per-LB cache doesn't dedupe in-flight URL fetches. Fix: `Mutex<HashMap<String, Shared<JsFuture>>>` per URL. Estimated 13-in-<5s, 119-in-<15s after fix. One-file change in `crates/holtburger-resource-http/src/manifest_source.rs`.

2. **Demo screenshot regen after F.35.** Hudriffa is intermittently absent from `01-hudriffa-shopkeeper.png` because of the same race. F.35 should fix this automatically.

3. **Whole-Dereth bake performance.** Baking 65,536 LBs in serial is ~hours. Parallelize over LBs (independent: no shared state in `bake_landblock`). Future tool work.

4. **Live-ACE entity channel verification.** Phase D.1 used synthetic JSONL replay; the wire-frame path through `handleEntitySpawn` / `__scene3dEntityHook` was exercised but not against a live ACE socket. When connecting to Coldeve, verify the channel keeps up at radius=6 under real network conditions.

## What this method does NOT solve

- **Procedural particles / emitters.** Smoke, water spray, magical effects — these are still time-driven on the client. The method's contract is for *placement*, not animation.
- **Per-player visibility filtering.** A player who can't see invisible objects shouldn't get them in `landblock_instance` for their session — that's a server-side scoping decision, orthogonal to the method.
- **Procedural day-night cycle.** The skybox lerp from Region 0x13 is wall-clock-anchored deterministic (per `crates/holtburger-world/src/sky.rs`) but that's a separate determinism contract — not coupled to placement.
- **Modder content.** A server running custom DATs has its own bake. The `bake-source.sha256` distinguishes "this bake is compatible with these DATs" vs "this bake is for some other DAT iteration".

## Glossary

- **LB** — landblock. 192 m × 192 m square. Identified by hex `0xXXYY` where `XX` is column 0-FF, `YY` is row 0-FF. World is 256 × 256 LBs.
- **Region 0x13** — Dereth. Carries the scenery palette + day-night cycle + sound + sky descriptions.
- **Scenery byte** — top 5 bits of the per-vertex 16-bit terrain word in `CellLandblock.terrain[i]`. Indexes into `TerrainInfo.TerrainTypes[terrain_type].scene_types[scene_type]`.
- **ObjectDesc** — the per-object entry in a Scene file (DAT 0x12). 76 bytes packed. Includes obj_id, BaseLoc Frame, Freq (placement probability), Displace/Min/MaxScale/MaxRotation (deterministic-noise parameters), Slope envelope, WeenieObj (non-zero = server-managed, scenery rejects it).
- **PCG** — procedural content generation. The thing this method explicitly rejects on the client.
- **PRNG** — pseudo-random number generator. The bake uses a deterministic-noise PRNG seeded by global cell coordinates; same input → same output forever.

## Provenance

The method as shipped:

| Phase | Commits | What landed |
|---|---|---|
| A | (no commits, investigation only) | ACE source located, gazetteers verified, oracle baselines captured |
| B.1 | `6138f3a` | Scene + ObjectDesc DAT parsers |
| B.2 | `dcf3676` | Rust port of `Scenery.Load` (deterministic, 100% C# parity) |
| B.3 | `068ea9a` | `scenery-bake` CLI with base-DAT integrity pre-flight |
| B.4 | `3340fb6` + `5261ff0` | ACE-compat mode + C# cross-check probe + parity report |
| C.1+C.2 | `65c11a1` | Stage bake under `holtburger-dist-v2/scenery/`; `fetch_landblock_scenery` wasm export |
| C.3+C.4 | `9125211` | Renderer consumes the bake (729 → 15,252 placements at spawn); 10 demo PNGs re-shot |
| D.1 | `5d162a4` | Synthetic ACE spawn injector through real wire path (119 entities at Holtburg-spawn) |
| E | `1242f25` | `validate_landblock_completeness.cjs` (1474 LoC) — the production gate |
| D-polish | `da92461` | 6 close-up NPC demo shots |
| F.30 | `8d4794a` | SoA bulk wasm exports for validator throughput |
| F.31 | (none — diagnosed wasm-side; tracked as F.35) | Spawn pipeline serialization root cause analysis |
| F.33+34 | `ad26b39` | Nameplate text-truncation fix + dedupe-by-guid |
| Method doc | (initial commit) | Canonical reference |
| B.5 | 2026-05-16 | **Collision-parity gate.** Closed the divergence between Rust bake and ACE `Scenery.Load` Collision(): `info.objects` no longer counted as collision-blocker; `transform_local_aabb` (4-corner approximation) replaced by `transform_mesh_to_aabb` (per-vertex, matches ACE `BoundingBox.BuildBox`); `scenery-cross-check --with-collision` ports ACE's BoundingBox + Intersect2D as the C# oracle. Result: 16,700 placements, 100.000 % strict-tolerance match, 0 missing / 0 extra. Report: `docs/scenery-bake-b5-collision-parity-report.md`. **This is the gate that unblocks whole-Dereth `generate-world`.** |

---

**Use this doc as the contract.** Anything the renderer renders that isn't traceable to one of the three sources is a bug. Anything in a source that the renderer doesn't render is a bug. The validator at Phase E proves the contract holds; the bake's `bake-source.sha256` proves the inputs are canonical; the ACE-compat C# parity proves the algorithm matches the server.
