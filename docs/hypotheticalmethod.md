# hypotheticalmethod.md

A grounding doc for the renderer-completeness work. Status: **historical — superseded by [`world-completeness-method.md`](world-completeness-method.md) once the method shipped end-to-end on 2026-05-14.** This file is retained as the original planning record; the canonical reference for what the method actually does + how to use it lives in the as-shipped doc.

## The problem

In retail AC the client and server **both** compute scenery (trees, rocks, bushes, grass tufts) procedurally from a shared algorithm fed by the per-vertex `scenery` byte in the DAT. As long as both sides run the same algorithm with the same inputs, they agree on where each tree is. **This is fragile:**

- Any second implementation (a new client, a derivative server, a tooling pass) has to match the algorithm bit-exact or scenery drifts between players. Tree at (4, 7, 53) on my screen, no tree there on yours — collision, occlusion, ranged-cast targeting all break.
- Procedural placement has no addressable identity. You can't say "edit that specific tree", you can't say "the lifestone is behind THAT rock". The world is a noise function, not a database.
- Server-side decisions (cover, line-of-sight, monster pathing) that depend on scenery need to redo the procedural pass on the server, or run client-driven, or pretend scenery doesn't exist for gameplay.

For a renderer that ships to Coldeve (ACE-derivative) and is supposed to play with retail-equivalent clients on the same server, **drift on one tree breaks compatibility**. We can't ship procedural-on-client.

## The principle

**Every renderable thing in a landblock comes from an explicit, addressable, version-controlled placement list.** No procedural generation in the client. No procedural generation in the server. One bake, two consumers.

The renderer is a pure consumer of placement data. It does no random choices. It does no noise lookups. It does no "compute trees from terrain code" passes. If a tree should be there, it's because the manifest says so.

## The manifest

For each landblock there is exactly one **completeness manifest** — the union of three explicit placement lists:

| Source | Origin | What it contains | When it's computed |
|---|---|---|---|
| **DAT explicit** | `LandblockInfo.objects` in the AC `cell.dat` | Buildings, signs, named POI props, hand-placed statics | At retail bake time (1999); read by our parser today |
| **DAT baked** | Rust port of `ACE.Server.Entity.Scenery.Load()` | Trees, rocks, bushes, foliage, grass tufts | Computed **once** by our offline bake tool; serialized to JSONL alongside the DAT |
| **ACE explicit** | `landblock_instance` rows in the ACE world DB | NPCs, monsters, portals, lifestones, chests, generators | At server startup; pushed to the client over the wire on entity-create events |

The first two are **DAT-determined** — same for every server using the same DAT. The third is **server-determined** — varies per server (Coldeve has its own NPC/monster mix; retail had its own).

## The bake

The middle row of the table — the bake — is the novel piece. It turns AC's procedural scenery channel into an explicit one.

### Algorithm

Verbatim port of `~/ace-server/Source/ACE.Server/Entity/Scenery.cs` to Rust. It's 198 lines, no live DB dependency, fully deterministic. Inputs:

- The landblock's per-vertex 16-bit terrain word (we have this; lives in `CellLandblock.terrain[81]`). Decodes as: `road = word & 0x3`, `terrain_type = (word >> 2) & 0x1F`, `scene_type = word >> 11`.
- Region 0x13's `TerrainInfo.TerrainTypes[i].scene_types: Vec<u32>` — maps `(terrain_type, scene_type)` → scene-info index.
- Region 0x13's `SceneInfo.scene_types: Vec<SceneType>` where `SceneType { stb_index: i32, scenes: Vec<u32> }` — list of Scene file IDs for each scene-info slot.
- `Scene` files (DAT prefix `0x12`) — each is just `{ id: u32, objects: Vec<ObjectDesc> }`.
- `ObjectDesc` — `{ obj_id, base_loc: Frame, freq, displace_x, displace_y, min_scale, max_scale, max_rotation, min_slope, max_slope, align, orient, weenie_obj }`.

Per LB the algorithm walks each of the 81 vertices and, for the scene the vertex maps to, decides per-object placement using deterministic noise from global `(cell_x, cell_y)`. Output per vertex is zero or more `{ obj_id, position, rotation, scale }` records.

Objects with non-zero `weenie_obj` are skipped — those are server-managed entities, not procedural scenery.

### Output

One JSONL per landblock at `<bake-dir>/<lb_hex>.scenery.jsonl`. Each line:

```json
{"obj_id": 33555015, "x": 123.4, "y": 56.7, "z": 53.2, "qw": 1.0, "qx": 0, "qy": 0, "qz": 0, "scale": 1.0, "source_cell_x": 5, "source_cell_y": 2, "source_obj_idx": 1}
```

The `source_*` fields make every placement debuggable back to "this tree exists because vertex (5, 2) had scene_type N, which mapped to scene 0xNNNNNNNN, ObjectDesc index 1 hit at noise=0.NNN".

### Determinism contract

Run the bake twice on the same DAT, get byte-identical JSONL. Run it on two different machines, byte-identical. This is the load-bearing property — if it ever wavers, the whole pretence of "explicit placement" breaks.

### Base DATs only — never custom

The bake MUST run against the canonical retail base DATs (`client_portal.dat` + `client_cell_1.dat` + `client_local_English.dat`) and NEVER against a project iteration that has had WorldBuilder edits applied. Local paths today:

- **Canonical retail install:** `~/ac_base_dats/{client_portal.dat, client_cell_1.dat, client_local_English.dat}` — the unmodified install, this is the source.
- **Project mirror (acceptable):** `/home/wbterminal/projects/RetailSmoke/dats/base/` — 1.2 GB byte-mirror of the above, used by the WB.Terminal project. Acceptable because no custom edits have been applied to `dats/base/`.
- **Custom iterations (FORBIDDEN for the bake):** anything under `dats/iter-*/`, anything that exists alongside a populated `custom_textures/` directory, anything emitted by `export` with `apply:true` after `import-texture` / `import-render-surface` / `obj-import` / `add-object` calls. These contain modder-allocated IDs (`0x01FF…`, `0x02FF…`) and replaced retail records that would corrupt the bake's identity-of-result.

**Why this matters:** if Server A bakes against retail-base and Server B bakes against a modder's variant, their manifests disagree on tree placement for any LB the modder touched. The whole point of the manifest is universal agreement; baking on a fork breaks that.

The bake CLI must:
1. Take an explicit `--dat-dir` argument (no default to the project DAT).
2. Refuse to run if the directory contains any `0x01FF…` / `0x02FF…` records (cheap pre-flight check).
3. Refuse to run if there's a sibling `custom_textures/` directory with content.
4. Emit a `bake-source.sha256` next to the JSONL output, hashing the three input DATs so reproducibility is auditable.

A server (Coldeve, retail emulator, etc.) that wants to consume the bake reads the `bake-source.sha256` and verifies it matches its own base DATs. Mismatched hash → reject the bake, fall back to "no scenery" rather than render unauthorised placements.

## The renderer's view

The renderer never knows or cares that some placements came from `LandblockInfo` and others from the bake. It calls one of two wasm helpers per LB:

```js
// existing
const explicit = await wasm.fetch_landblock_objects([lbCellId]);  // LandblockInfo

// new (Phase C)
const scenic = await wasm.fetch_landblock_scenery([lbCellId]);    // baked JSONL

// merge
for (const p of [...explicit, ...scenic]) {
  addPlacement(scene3d, p);
}
```

ACE entity spawns arrive separately over the wire and go through the existing `entities.js` spawn channel. Same renderer API surface — just a third stream of placements, all of which are explicit.

## The validation contract

For any LB at any time:

```
rendered_placements ≡ {
  ∀ p ∈ LandblockInfo.objects      (DAT)
  ∪ ∀ p ∈ scenery_bake[lb]         (baked)
  ∪ ∀ p ∈ landblock_instance[lb]   (ACE, server-pushed)
}
```

A validator (Phase E) walks the live `scene3d.{terrain,buildings,statics,cells,entities}Group.children`, builds the rendered set, and diffs against the manifest. Any mismatch is a bug worth fixing — there's no slack, no tolerance, no "good enough". The manifest IS the world.

## Phase ledger

| Phase | What | Status | Notes |
|---|---|---|---|
| **A** Investigate | What's in the DAT scenery info? ACE algorithm? ACE-DB? | ✅ done 2026-05-14 | 365k spawn records local; algorithm at ACE Scenery.cs:1-198; Region parser already covers SceneInfo + TerrainInfo; Scene + ObjectDesc parsers don't exist yet (~50 LoC to add); base DATs identified at `~/ac_base_dats/` + project mirror at `dats/base/`; sample LBs queried for per-vertex scenery codes (non-zero across all sampled types except SemiBarrenRock) |
| **B** Scenery bake tool | Rust port of `Scenery.Load`, Scene + ObjectDesc parsers, per-LB JSONL, `--dat-dir` hardening | next | new crate `holtburger-scenery-bake`; ~500 LoC; must pre-flight base-DAT integrity (reject `0x01FF…` / `0x02FF…` IDs, reject sibling `custom_textures/` dirs) |
| **C** Wire the renderer | `fetch_landblock_scenery` wasm export; `bakeStaticsForLandblock` second pass; bake source-hash verified at boot | after B | green Holtburg with trees + rocks |
| **D** Entity channel | Verify ACE-DB entity spawns arrive at radius=6 over the wire | after C | needs live Coldeve OR synthetic spawn |
| **E** Validation gate | `validate-landblock-completeness` tool + CI per-LB | after D | the production check |

After E the loop is closed: any new LB the world expands to (new region, new town) goes through the same A-E sequence. The whole 65,536-LB map of Dereth is reachable by running the bake over more LBs and the entity ingest over more of ACE-DB.

## Why this is novel

Two-decade-old AC clients (retail, Decal, Phat, etc.) all carry their own procedural-scenery implementations and quietly diverge. ACE servers that depend on scenery (cover queries, line-of-sight on monsters that hide behind trees) typically rebuild the procedural pass server-side. **Nobody has the bake.** Or if they do, it's not shared, not tooled, not validated.

The bake is the artefact this whole project has been chasing without saying it out loud. Once it ships:

- Any new AC-derivative server (Coldeve, etc.) can adopt it as the single placement source and have client/server agreement by construction.
- Tools (WorldBuilder, modders, lore-editors) can `worldbuilder-terminal scenery-add lbX lbY x y z obj_id` and edit individual trees the way they edit individual buildings.
- "Pixel-perfect retail" claims become testable: bake retail DATs, render, diff against retail screenshots, score per-LB.
- The renderer's correctness story is a one-liner: "does the rendered set equal the manifest?"

## What "production grade" requires of us

Five things we don't yet have but the method demands:

1. **The bake is byte-deterministic.** Test: run twice, assert byte-identical JSONL across all 169 LBs in the smoke ring. Then across 1000+ random retail LBs. Then across all 65k.
2. **The bake matches retail behaviour.** Validation route TBD — possible: render in ACE itself with logging, dump scenery list, compare; OR generate a top-down `render-preview` of one bake-tree-only LB and overlay on a retail screenshot.
3. **The renderer renders 100% of the manifest, 100% of the time.** No skipped placements due to wasm fetch errors. No drop-on-replay. The validation gate (Phase E) is what proves this.
4. **The ACE entity channel is robust.** Spawn events should arrive for every LB the player has loaded, in order, without backpressure issues at radius=6 or larger.
5. **The whole pipeline scales linearly.** Baking radius=6 today, radius=20 next, all of Dereth eventually. The same CLI, the same JSONL shape, the same validator — just run it over more LBs.

## Open questions to settle during execution

- **Where does the bake live on disk?** Probably alongside the dat-shard manifest at `/mnt/wbterminal1/holtburger-dist-v2/scenery/{prefix2}/{lb_hex}.scenery.jsonl`. Fetched lazily like the rest of the manifest.
- **Versioning.** If we re-run the bake (algorithm fix, retail DAT update), how do we invalidate caches? `manifest.json.scenery_bake_version` plus a content hash. Renderer rejects stale.
- **Collision rejection.** ACE's algorithm rejects scenery placements that collide with buildings. We need to do that too — and the building data isn't available during the bake unless we feed it in. Probably: bake collision is a two-pass — generate all candidates, then walk the LandblockInfo.objects bounding boxes and drop intersections.
- **Slope rejection.** ACE checks `min_slope ≤ slope ≤ max_slope`. We need the LB's heightmap to compute slope at each candidate position. Feed it in.
- **Z snapping.** Position Z comes from `LandblockMesh.GetZ(x, y)` — bilinear sample of the heightmap. Same as the renderer already does for player movement.

## What I want to verify before committing to Phase B

These are the load-bearing assumptions in the plan. If any is wrong, the rest needs rework:

1. **The ACE algorithm is deterministic with no hidden state.** Read of Scenery.cs:1-198 says yes (only inputs are DAT + global cell coords). Confirm by running the C# code against retail DATs in isolation and observing same output across two runs.
2. **The per-vertex 16-bit `terrain` field is what WB.Terminal calls `(terrainType, scenery)` decomposed.** Confirm by reading the same vertex through both paths and reassembling.
3. **No live ACE DB needed for the bake.** Confirmed — Scenery.Load takes only `Landblock` (which is DAT-derived).
4. **`Scene` + `ObjectDesc` parsers are tiny.** Confirmed — Scene.cs is 24 lines, ObjectDesc.cs is ~50 lines.
5. **Region 0x13's TerrainInfo.TerrainTypes[i].scene_types and SceneInfo.scene_types are already parsed by our Rust code.** Confirmed — `holtburger-dat/src/file_type/region.rs:617, :444`.

All five hold up under read-through. Phase B is unblocked.

---

**Sign-off line for the user:** if this doc accurately captures the method and the plan, mark it verified; I'll start Phase B. If anything looks wrong — especially the determinism contract, the manifest definition, or the validation contract — flag it before I write code, because those are the load-bearing pieces and changing them later means redoing Phase B.
