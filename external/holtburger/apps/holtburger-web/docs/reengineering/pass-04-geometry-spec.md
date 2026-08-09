# Pass 04 — Geometry spec: offline triangulation bake, indexed buffer layouts, wasm→JS transfer contract, runtime-decode residue

Pass 4 of 12. Governed by `TRACKING.md`'s protocol header. This pass fixes I2's break
(charter D-01.7: "BROKEN for static world geometry; KEPT for substitution-bearing models"):
the offline pre-triangulated **indexed** geometry payload format that fills pass 2's GEOM
slots (encoding 0x0001), the vertex format and quantization, per-model-vs-per-pack placement,
LOD policy, the wasm→JS transfer contract that replaces per-getter clones and the Tri
pipeline, the explicit render-vs-collision boundary, the terrain decision, and the retained
runtime path for equipment substitutions. Source classes per R7: **[M]** measured this
session, **[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

The load-bearing new measurement: **1,131 real GfxObj records** parsed this session (via
WorldBuilder.Terminal against `~/ac_base_dats/client_portal.dat`, id scan `0x01000001 + 13k`,
1,131 hits of 1,500 probes) with triangulation-corner arithmetic mirroring the runtime
triangulator: corpus-weighted **R = 1.13 indexed vertices per triangle**, mean 59 tris /
66 indexed verts per model, max 1,498 verts (u16 indices always sufficient in sample), and
**indexed payload = 0.33× the current de-indexed boundary bytes** (3.02× reduction).

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; D-01.7 I2/I5
  dispositions, H3, N3).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; D-02.7 GEOM/TEXREF
  framing, S1.4 pack size model, H-02.2, Q2).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; D-03.3 single fetch
  authority + PackStore, S1.3/S1.4, H-03.1 "resident and verified when decode runs").
- `apps/holtburger-web/src/lib.rs` (the wasm crate — NOT `crates/holtburger-web/`, which
  does not exist):
  - 2035–2120 `SubdividedLandblockMesh` (already-indexed terrain output; `indices` getter
    2082, per-getter clones 2052–2118); 2129–2232 `fetch_subdivided_landblocks` (9×9 →
    subdiv; "collision path stays on the 9×9 grid via populateTerrain", 2133–2134).
  - 5941–6038 `ModelMesh` struct (de-indexed 9+6+9 floats/tri fields + per-tri metadata);
    6042–6098 wasm-bindgen getters, every one `self.x.clone()`.
  - 8968–8992 `triangulate_model` / `triangulate_model_with_substitutions`.
  - 8995–9060 `MODEL_TRI_CACHE` (64 MiB `ByteBudgetLru`, entry cap 8 MiB); 9287–9293
    subst-free gate + **deep-copy on hit** (`return Some((*cached).clone())`, 9290–9292);
    9328–9341 completeness-gated insert; 9062–9118 `MissCountingSource`.
  - 9367–9427 `resolve_did_degrade` (re-fetch + re-parse of records the triangulation just
    parsed; multi-part setups return 0, 9394–9402); called per model at 14898 and 15020.
  - 9434–9528 `pack_model_mesh` (de-index flatten: 9 pos + 6 uv + 9 normal floats/tri +
    surface_indices/sides_types/polygon_ids/side_kinds per tri; bbox fold).
  - 14885–14900 `fetch_model_mesh`; 14945–15024 `fetch_model_meshes` (walk + per-id
    starvation retry 14990–15005 + `decode_misses` stamp + `resolve_did_degrade` post-fill).
  - 15053–15085 `BuildingPlacement` (per-part meshes + hinge frames + decode_misses).
  - 16623–16779 collision staging: `CELL_BSP_PENDING` ("REUSES the already-parsed
    physics_bsp tree", 16631–16633), `CELL_MEMBERSHIP_PENDING` (`CellStruct.cell_bsp`),
    `STATIC_AABB_PENDING`, `STATIC_BSP_PENDING` (`GfxObj.physics_bsp` framed to world),
    `SCENERY_COLLIDER_PENDING`, `CELL_STATIC_BSP_PENDING`, outdoor/indoor overlap bakes.
  - 19405–19514 `append_environment_tris` (selects ONE cellstruct per EnvCell via
    `cell_structure`; polygon `pos_surface`/`neg_surface` are **slot indices** into the
    per-cell `surfaces: &[u32]` list, 19447–19476).
  - 21160–21208 EnvCell vertex-light bake site (`select_cell_pool` + `bake_vertex_colors`
    over the de-indexed positions/normals, per cell, `MAX_STATIC_LIGHTS` cap warning).
  - 21861–21944 `fetch_entity_model_render` (flat substitution args; collision-radius
    re-parse of the Setup, 21928–21937).
- `apps/holtburger-web/src/vertex_bake.rs` — lines 1–80: dependency-free port of retail
  `SetStaticLightingVertexColors`; inputs = plain local-frame `[f32;3]`; `MAX_STATIC_LIGHTS
  = 40` (line 35); deterministic in (positions, normals, lights).
- `crates/holtburger-dat/src/walk.rs` — lines 30–140: `collect_model_dependencies` walks
  GfxObj→surfaces and Setup→parts only; **no `did_degrade` edge exists** (confirmed by
  reading the full `walk_model` body 46–84 and an `rg did_degrade` over the file: 0 hits).
- `crates/holtburger-dat/src/file_type/gfx_obj.rs` — lines 1–101: `physics_polygons` +
  `physics_bsp` (HAS_PHYSICS, 39–47), `polygons` + `drawing_bsp` (HAS_DRAWING, 54–62),
  `did_degrade` (HAS_DID_DEGRADE, 64–67) — all in one record.
- `crates/holtburger-dat/src/physics.rs` — lines 1–60: `BspNode`/`BspLeaf`/`BspPortal`
  shapes, retail `PHYSICS_EPSILON`.
- `apps/holtburger-web/scene3d/adapter.js` — lines 800–1024 `meshToGeometryGroups`:
  snapshot of every getter (848–854), scalar re-bucketing by surfaceIndex (909–923),
  per-corner copy loop into fresh group arrays (949–978), **no `setIndex` anywhere on the
  model path** (non-indexed `BufferGeometry`, 980–1004), `acBakedLight` u8-normalized
  attribute install (998–1003), source-order winding per the 2026-07-02 forge fix (931–947).
- `apps/holtburger-web/scene3d/bake_transfer.js` — lines 1–490 (all): `serializeModelMesh`
  reads 7 getters → 7 ArrayBuffers per mesh (132–164); SAB guard (51–83);
  `freeWasmHandles` + FinalizationRegistry rationale (85–122); reconstruct derives
  `triCount`/`worldBounds` (198–221).
- `apps/holtburger-web/scene3d/statics.js` — lines 736–865 (`fetchPrimaryGeometries`:
  one `fetch_model_meshes` batch, per-model `meshToGeometryGroups`, didDegrade snapshot
  839–842, degraded fetch is "a SECOND fetch_model_meshes round trip" 759–761, starvation
  bookkeeping 768–831); 1820–1889 (`consolidateStaticSingletons`: BatchedMesh sized by
  `maxVerts`/`maxIdx` incl. `geometry.index.count` 1854–1858 — indexed geometry is already
  accommodated; `addGeometry`/`addInstance` copies member geometry).
- `apps/holtburger-web/scene3d/buildings.js` — lines 330–410 (`bakeBuildingPlacement`:
  drains `BuildingPlacement` parts + hinges to JS-owned data, `meshToGeometryGroups` per
  part, incomplete bakes barred from the cross-LB `bakeCache`).
- `apps/holtburger-web/scene3d/animated_scenery.js` — lines 480–590: instanced path decodes
  each setup ONCE via `fetchBuildingPlacement` (521), shares per-part geometry across all
  placements, one `InstancedMesh` per (setupId, part, surface group) (568).
- `apps/holtburger-web/scene3d/cells.js` — lines 1025–1085: per-cell `takeMesh()` →
  `meshToGeometryGroups`, per-cell static snapshots.
- Measurement artifacts: 1,131-record GfxObj parse battery (scripts + outputs in session
  scratchpad, method in S5; WBT `chorizite-parse-dat-record`, read-only against base dats).

## Decisions

### D-04.1 — GEOM encoding 0x0001 = `HBG1`: per-part indexed streams, subset-partitioned, upload-ready

The pass 2 GEOM section row (`[model_id u32][encoding u16][reserved u16][offset u32]
[size u32]`, pass 2 D-02.7) with `encoding = 0x0001` frames an **HBG1 payload** (normative
layout S1). Headlines:

- **Indexed.** Vertices are deduplicated at bake over the triangulation-corner tuple
  `(vertex_id, uv_index, side)` — exactly the identity the runtime triangulator expands
  today (adapter.js corners; `append_gfx_tris` semantics). Measured on 1,131 real GfxObjs:
  R = 1.13 verts/tri corpus-weighted (med 1.06, p90 2.00) [M, S5].
- **Vertex format, 24 B/vertex** (28 with baked light): position f32×3 (12 B) + normal
  snorm8×3+pad (4 B) + uv f32×2 (8 B) [+ baked-light u8×3+pad (4 B), envcell payloads
  only]. Non-interleaved planar streams, each 4-byte aligned, little-endian.
- **Index format: u16** (padded to 4 B), with a flags bit for u32 fallback; the bake fails
  loud if a part exceeds 65,535 verts without the flag. Sample max was 1,498 verts [M];
  u32 exists for pathological envcell structs, not models.
- **Subsets replace per-tri metadata.** Triangles are pre-sorted at bake by
  (surface, sidedness); each subset row is `{surface_ref, flags, first_index,
  index_count}`. This deletes `surface_indices`/`sides_types` per-tri arrays AND the JS
  scalar re-bucketing loop (adapter.js:909–978) — a subset IS the geometry group.
  Subset flags carry the RND-33 stipple bits and the doubleSided bit with today's
  semantics (ModelMesh `subset_stippled` doc, lib.rs:6019–6037).
- **Winding = source order** (front order), each side's tris emitted in that side's
  correct order with negated normals for the back side — the invariant the 2026-07-02
  forge fix established (adapter.js:931–947). No runtime reversal exists to apply.
- **Per-payload bbox** (f32×6) satisfies pass 2 H-02.2's per-model bounds requirement
  (PLACEMENTS dropped baked AABBs); placement transform × bbox reproduces scenery AABBs.
- **Dropped from the baked format:** `polygon_ids`/`side_kinds` (E8 provenance — a
  diagnostic/ML surface; the runtime decode path retains it for tooling) and
  `decode_misses` (meaningless by construction: `--verify-closure` guarantees the bake
  decoded from a complete record set; a missing GEOM row at runtime is a loud pass-3
  deploy-skew error, never a silent partial mesh).

*Quantization rationale/rejections.* Positions stay f32: models are metres-scale with
sub-mm authored detail; f32 is what three/BatchedMesh consume with zero patching, and a
snorm16-normalized-to-bbox encoding would require per-model scale/offset uniforms or a
decode pass — no longer "upload as-is" (pass 7 may revisit inside its pool design).
Normals snorm8 are safe because three's lit materials renormalize the interpolated normal
in the fragment shader; 1/127 precision is far below shading-visible for these low-poly
models. UVs stay f32 in v1: AC uses wrap coordinates well beyond [0,1] (measured u=12.28
on the first sampled record) where f16's ~2⁻⁶ absolute step at magnitude 8–16 risks texel
swim; a flags bit reserves f16 UVs for a measured later pass. Interleaving rejected:
three r184 uploads planar attributes fine, `BatchedMesh.addGeometry` copies into its own
storage regardless (statics.js:1860–1867), and planar streams compress better per-stream
under the section zstd.

### D-04.2 — Storage is per-GfxObj-part; setups are directory rows; placement follows pass 2's K-tier assignment

- **Mesh payloads exist per 0x01 GfxObj** (payload kind PART, S1). One copy of each part's
  geometry, content-shared exactly as its record is: the GEOM row lives in the SAME pack
  tier (inline ≤4 tiles / META-REGIONAL / META-COMMONS) that pass 2 D-02.4 assigns the
  GfxObj record. Co-location rule of pass 2 D-02.7 honored.
- **0x02 SetupModels get a DIRECTORY payload** (kind SETUP): part DID list, per-part
  default placement frames (the pose `triangulate_setup_model_at_frame(..., None)`
  produces today), per-part hinge frames (the `BuildingPlacement` contract,
  lib.rs:15053–15085), fused bbox, `did_degrade`. No vertex data — fusing at bake would
  duplicate part geometry into every setup that shares it.
- **Fusion for the statics path happens at load in Rust**: transform each part's verts by
  its frame into one fused buffer (mean 66 verts/part [M] — memcpy-scale, orders below
  the deleted triangulation). Consumers that want parts addressable (buildings' doors,
  animated scenery instancing — buildings.js:369–403, animated_scenery.js:514–559) read
  parts directly; the directory serves both shapes.
- **EnvCell environments (0x0D) get kind ENV payloads**: one GEOM row per environment DID,
  payload = per-cellstruct directory of indexed meshes whose subset `surface_ref` is the
  **slot index** into the consuming EnvCell's surface list (read-verified semantics:
  `poly.pos_surface` indexes `surfaces[]`, lib.rs:19447–19476). Placed in the ENV packs /
  interior packs per pass 2's env tiering. Per-cell work at load: slot→DID remap
  (per-subset, bytes) + world framing + vertex light bake (D-04.7).

*Rationale.* Dedup is the measured governing force (pass 2: 194.7× naive inline dup;
734,977 EnvCells drawing from 769 environments). Per-part storage is the only shape that
serves statics (fused), buildings (per-part + hinges), and animated scenery (per-part
instanced) from one copy. *Rejected:* fused per-setup payloads (duplicates shared parts;
breaks the per-part consumers); per-cell envcell payloads (≈1,000× duplication class);
per-pack geometry megablobs spanning models (kills CAS sharing across tiers and the
record↔geometry co-location that keeps REFS resolution one-hop).

### D-04.3 — Terrain geometry is NOT baked; it stays runtime-generated from the 252 B records

Arithmetic [D, from read-verified shapes]: one `CellLandblock` record is **252 B** fixed
(pass 2 S1.1 [M]). The runtime product at the default mid subdiv factor 4 is a 33×33 grid
(lib.rs:2133): 1,089 verts × (pos 12 + normal 12 + acLightNormal 12 + codes 2) ≈ 41.4 KB
+ 2,048 tris × 12 B u32 indices ≈ 24.6 KB + ~1.5 KB merge data ≈ **~67 KB/LB ≈ 265× the
wire record**. An 11×11 ring: 30.5 KB of records [M, pass 2 S1.2] vs ~8.1 MB baked — the
whole B1 budget for data the client derives in a few ms of Catmull-Rom. Baking would also
freeze the subdiv factor (a per-quality client knob: 1/2/4/8) and break neighbor-edge
stitching, which is resident-ring-dependent (lib.rs:2197–2205). The terrain path is
already indexed (`SubdividedLandblockMesh.indices`, lib.rs:2041, 2082) and already grid-
generated; its only I2-class defect is per-getter clones, which D-04.5's exit contract
fixes by adding a bundle-form export. **Decision: TERRAIN section stays the 4×252 B
records (pass 2 kind 0x01); terrain meshes are runtime products.** *Rejected:* baked
terrain meshes (265× wire bytes for zero decode savings worth naming).

### D-04.4 — Baked geometry is RENDER-ONLY; collision stays record-based, and records stay in packs

Read-verified collision inventory: walk/collision consumes **parsed record structures,
never the render triangulation** — `GfxObj.physics_bsp` trees framed to world
(STATIC_BSP_PENDING, lib.rs:16700–16711; CELL_STATIC_BSP_PENDING 16730–16741),
`physics_polygons` fan-triangulated for building interiors (BUILDING_PHYSICS_PENDING
16666–16680), EnvCell physics + `CellStruct.cell_bsp` membership (16627–16652), setup
collision radii re-parsed from the Setup record (21928–21937), scenery colliders
(16713–16728), and terrain collision on the 9×9 grid via `populateTerrain`
(lib.rs:2133–2134). None of it crosses the JS boundary; none of it is the measured cost
this program attacks. **Decision: HBG1 carries no collision data; RECORDS/ENVCELLS
sections retain the full records for every model, and the collision pipeline is untouched
by this pass.** Consequence for pack sizing: GEOM is additive to record bytes (+0.33–0.37×
of model-record bytes, S6), not a replacement. *Rejected:* baked collision soup (discards
BSP solidity/portal semantics the faithful driver consumes); stripping drawing data from
packed records to offset GEOM bytes (breaks CAS hash=bytes and the runtime-decode
fallback/migration path).

### D-04.5 — Exit contract: one descriptor + ONE transferable ArrayBuffer per bake unit; wasm-bindgen handles leave the static path

The wasm→JS boundary for baked geometry is a **GeometryBundle**: exactly one JS-owned
`ArrayBuffer` containing the upload-ready streams for the unit (one model, or one
tile-bake batch), plus a compact descriptor (S3) of offsets/counts/subsets. Contract
rules:

1. **One copy, ever.** Rust assembles the unit (decompressed GEOM payload → setup fusion /
   env remap+light-bake as needed) into one contiguous allocation and hands it out through
   a single `Uint8Array`-returning export (one wasm→JS copy). All JS consumption is typed-
   array **views** into that buffer (`BufferAttribute` accepts offset views; three keys
   VBOs by attribute object, so subsets sharing vertex streams share uploads).
2. **No views into wasm linear memory.** Rejected deliberately: `memory.grow` detaches
   them; under a threaded build they'd be SAB-backed and untransferable (the exact guard
   bake_transfer.js:51–83 exists for); and pass 3's topology has consumers on the other
   side of a postMessage from the decoding instance. The single-copy exit is the floor,
   and it is 3.02× smaller than today's floor because the format shrank [M, S5].
3. **Transferable by construction.** Worker → main crossing transfers ONE ArrayBuffer per
   unit (vs 7 per mesh today, serializeModelMesh bake_transfer.js:138–144), descriptor via
   structured clone (small). Same bundle shape on either topology — this contract is
   neutral to pass 6's single-vs-dual wasm decision (charter H5).
4. **No wasm-bindgen handles, no `free()`, no FinalizationRegistry pressure** on the baked
   path: the bundle is plain JS data. The freeWasmHandles/first-bake-spike machinery
   (bake_transfer.js:85–122) remains only where handles remain — the entity path (D-04.8).
5. **Consumer adapter:** a new `bundleToGeometryGroups(descriptor, buffer)` returns the
   same `{groups: [{geometry, surfaceDid, doubleSided, subsetStippled}], surfaceDids}`
   shape `meshToGeometryGroups` returns today (adapter.js:824–830), with geometries built
   as shared-vertex-stream + per-subset index views, `setIndex` finally present. Statics,
   buildings, animated-scenery, and cells consumers keep their call shapes (pass 9 stages
   the swap; pool integration is pass 7's).

What this deletes on the static path (with today's cost anchors): per-getter clones
(6044–6098; 7 buffers/mesh), `pack_model_mesh` de-index flatten (9434–9528), the
`Vec<Tri>` intermediate + deep-copy-on-memo-hit (9290–9292), JS re-bucketing copy
(adapter.js:949–978), `resolve_did_degrade` double-parse (9367–9427 at 15020 — D-04.6
moves it to bake), and the geom-audit starvation retry/decodeMisses plumbing
(14983–15017; statics.js:768–831) — replaced by pass 3's loud skew errors. Boundary
bytes: ~100 B/tri × ≥2 copies (wasm exit + JS regroup) today → ~33 B/tri × 1 copy
[M+D, S5] ≈ **6× fewer bytes moved per static triangle**.

### D-04.6 — LOD policy: keep the two-level did_degrade LOD, resolve it at bake; no decimation

The existing policy is preserved exactly — `THREE.LOD` at the ~100 m slot, single-part
setups only (the multi-part guard, lib.rs:9394–9402) — but the chain is resolved at
**bake time**: each PART/SETUP directory row carries `did_degrade` (read straight off the
parsed record, gfx_obj.rs:64–67), and the degrade target's GEOM payload + records are
included in the same pack tier by widening the bake walk with a GfxObj→did_degrade edge
— **walk.rs has no such edge today** (read-verified, walk.rs:46–84), so pass 2's closure
misses degrade models; this is a required bake-walk change, folded into pass 2 Q5's
walk-widening work item. Deleted at runtime: the per-model `resolve_did_degrade` record
re-fetch+re-parse (9367–9427) and statics.js's SECOND `fetch_model_meshes` round trip for
degraded geometry (statics.js:759–761) — degraded meshes are just another bundle entry.
**No new LOD tiers, no mesh decimation** (charter N3): the frame is CPU-bound at draw/
node scale (survey §2; walls: GPU theories on a CPU-bound frame), so vertex-count LOD
buys nothing measurable today, and the record's own authored degrade chain is the only
mechanically-safe source.

### D-04.7 — EnvCell per-cell work stays runtime: slot remap + vertex light bake from records

Per-cell geometry = shared ENV payload (D-04.2) + per-cell overlay computed at load in
Rust: (a) subset slot→DID remap from the EnvCell record's surface list; (b) baked static
lighting via the existing `vertex_bake::bake_vertex_colors` port (vertex_bake.rs:1–35 —
deterministic, dependency-free, `MAX_STATIC_LIGHTS = 40`), now run over **indexed**
vertices: 1.13 verts/tri instead of 3 corners/tri ⇒ the same bake at ~0.38× today's
arithmetic [D]. The light pool comes from the same EnvCell/Setup records the packs
already carry (own cell + `visible_cells` closure, lib.rs:21166–21184).

*Rejected:* baking per-cell light streams offline — 3 B/vert × p90 639 cells/LB is a
hundreds-of-KB-per-interior-LB class [D] of pack bytes for data derivable from records
already shipped, and it would freeze light edits into geometry payloads (blast radius:
every cell of every LB the light reaches, vs pass 2's one-pack rule). Baking offline
remains open as a measured option if pass 10 ever attributes interior-load jank to the
light bake (Open question Q3).

### D-04.8 — Equipment/substitution residue (charter H3): the current path stays, unmemoized, behind the legacy lane; a bounded cache is designed but NOT enabled

The kept-I2 population — anything reaching `triangulate_model_with_substitutions_and_
mtable` with non-empty substitutions (`fetch_entity_model_render`, lib.rs:21861–21944) —
keeps today's path bit-for-bit: records via pass 3's legacy per-record lane (D-03.10),
runtime triangulation with the `subst_free` gate ensuring these decodes **never enter
`MODEL_TRI_CACHE`** (9287–9293: memo checked only when `model_changes`, `texture_changes`,
and `mtable_override` are all empty; insert gated the same at 9333), `pack_model_mesh` →
`ModelMesh` handles → `meshToGeometryGroups` → bake_transfer serializers. These modules
are retained for this population only.

Boundary contract (normative): the entity path is the ONLY producer of wasm-bindgen mesh
handles after migration; its records ride the legacy lane's concurrency share (8 under
the global cap, pass 3 D-03.10); its decode transients stay under the existing
`decode_admit` lease machinery (lib.rs:14957–14965). Budget: `MODEL_TRI_CACHE` (which
post-migration serves only residual non-substitution runtime decodes: admin-spawned
content, legacy-lane stragglers) shrinks 64 → 16 MiB at legacy-lane retirement
[A, proposed — pass 6 owns cache budgets and may restate].

**No substitution memo ships in v1.** No measured figure exists for substitution decode
cost or re-decode churn (searched the docs corpus this session — none found; honest gap
per R8). The known burst shape is the 119-spawn equipment class (pass 3 Q6). Designed-
but-dormant: a `ByteBudgetLru` keyed by `hash64(setup_id, model_changes, texture_changes,
mtable_override)` with a 16 MiB budget, same completeness gate as the static memo —
enable only if pass 10's instrumentation (a decode counter + duration accumulator on the
entity path, S7) shows repeated identical decodes above noise. *Rationale:* shipping an
unmeasured cache re-runs this week's coherent-design-measuring-0.0 failure mode; the
per-character variability argument that kept I2 partially alive (charter D-01.7) equally
predicts low hit rates. *Rejected:* baking common gear combos offline (per-character
state, unbakeable — settled by charter I2); memoizing under the existing model_id key
(wrong key — poisons static lookups with substituted geometry).

### D-04.9 — Reconciliation with pass 2's slots and budgets (H-02.2 answered)

Measured coefficient [M, S5→S6]: HBG1 raw ≈ **0.33× the current de-indexed boundary
bytes** and ≈ **0.37× the source GfxObj record bytes** (mean 1,946 B payload vs 5,322 B
mean record). Applied to pass 2's tables (S6.2): worst measured crossing column 0.56 →
~0.70 MB ≤ C2 1.5 MB (margin 2.7× → **2.1×**); p99 tile pack ~600 KB → ~820 KB, under
the 2 MB restatement trigger pass 2 H-02.2 set — **no restatement of S1.4/C2 required**.
Boot adds ~+1.0 MB (ring meta + commons GEOM class, S6.3): B1' 18 MB holds with margin;
the conditional 12 MB path becomes ~11.9 MB [D] — still delivered by pass 5's 128²
preview tier, now with essentially zero slack; flagged to pass 5 and pass 11 (S6.3).

## Spec

### S1 — `HBG1` payload layout (normative; fills GEOM section rows, encoding 0x0001)

Little-endian. All offsets are from payload start and 4-byte aligned. The payload sits
inside the pack's GEOM section (section-level zstd per pass 2 D-02.2 — HBG1 itself is
uncompressed).

```
PayloadHeader (16 B):
  0  4  magic        = "HBG1"
  4  1  kind         (0 = PART mesh, 1 = SETUP directory, 2 = ENV directory)
  5  1  version      = 1
  6  2  flags        bit0 = has baked-light stream (ENV cellstruct meshes)
                     bit1 = uv stream is f16 (RESERVED, must be 0 in v1)
                     bit2 = indices are u32 (else u16)
                     bit3 = did_degrade present in trailer
  8  4  reserved
  12 4  trailer_off  (kind-specific trailer, 0 = none)
```

**kind 0 — PART mesh** (one per 0x01 GfxObj; also each entry inside kind-2 payloads):

```
MeshHeader (44 B):
  vertex_count u32 | index_count u32 | subset_count u16 | reserved u16 |
  bbox_min f32×3 | bbox_max f32×3 | stream_off u32   (start of stream block)

Stream block (planar, in this order, each 4-B aligned):
  positions  f32×3 × vertex_count                      (12 B/vert)
  normals    snorm8×3 + pad8 × vertex_count            (4 B/vert)
  uvs        f32×2 × vertex_count                      (8 B/vert)
  [baked]    u8×3 + pad8 × vertex_count                (4 B/vert, flags bit0; PART
             meshes inside ENV payloads only — model PART payloads never carry it)
  indices    u16 × index_count (pad to 4)              (u32 iff flags bit2)

Subset table (subset_count × 12 B), ascending first_index, ranges disjoint+complete:
  surface_ref u32   PART payloads: surface DID (0 = fallback/no-surface bucket)
                    ENV cellstruct meshes: SLOT index into the consuming EnvCell's
                    surface list (remapped per cell at load, D-04.7)
  flags u8          bit0 doubleSided; bit1 stipple-wrap (RND-33 bit0 semantics);
                    bit2 stipple-side (RND-33 bit1 semantics)
  reserved u8×3
  first_index u32 | index_count u32

Trailer (flags bit3): did_degrade u32.
```

Determinism (pass 2 D-02.6 applies): vertices ordered by first use in index order;
triangles sorted by (subset, source polygon id); subsets by first-seen surface order —
re-bakes are byte-identical.

**kind 1 — SETUP directory** (one per 0x02 SetupModel; no vertex data):

```
part_count u16 | flags u16 (bit0 = single-part) | fused bbox f32×6
part_count × 40 B: part_did u32 | frame: pos f32×3, quat f32×4 (default placement
                   pose) | hinge: implicit = frame (the BuildingPlacement contract:
                   placement_frames[0] slot, lib.rs:15076-15085)
Trailer: did_degrade u32 (single-part setups: the part's chain per lib.rs:9386-9421
         resolution semantics, computed AT BAKE; multi-part: 0)
```

**kind 2 — ENV directory** (one per 0x0D Environment DID):

```
cellstruct_count u16 | reserved u16
cellstruct_count × 8 B: cellstruct_id u32 | mesh_off u32
then cellstruct_count × kind-0 mesh blocks (flags bit0 set: baked-light stream
present, filled at BAKE with zeros — the per-cell light bake overwrites at load,
keeping stream layout fixed so per-cell assembly is pure overlay, never resize)
```

Size caps: a PART/cellstruct mesh SHOULD be ≤ 256 KiB, MUST be ≤ 4 MiB; bake fails loud
beyond (aligned with pass 2's pack SHOULD ≤ 8 MiB).

### S2 — What the bake emits per model class

| class | GEOM rows | per-cell/per-placement runtime residue |
|---|---|---|
| 0x01 GfxObj (statics, scenery, building parts) | kind 0 | none — upload as-is |
| 0x02 Setup (statics/scenery) | kind 1 (+ kind 0 rows for parts, deduped) | fuse parts at load (Rust, memcpy+transform, mean 66 verts/part [M]) |
| 0x02 Setup (buildings, animated scenery) | same rows | consume per-part + hinge frames (buildings.js:369–403; animated_scenery.js:514–559 shapes) |
| 0x0D Environment (EnvCells) | kind 2 in ENV/interior packs | slot→DID remap + light bake + world frame per cell (D-04.7) |
| degrade targets | own kind-0/1 rows, same tier (D-04.6 walk edge) | none |
| terrain | NONE (D-04.3) | subdiv from 252 B records, unchanged path |
| equipment/entities | NONE (D-04.8) | full runtime decode, legacy lane |

### S3 — GeometryBundle descriptor (the wasm→JS ABI)

One bundle per bake unit. Exports (wasm): `assemble_model_geometry(model_ids: &[u32]) ->
GeometryBundle` and `assemble_envcell_geometry(lb: u32, cell_ids: &[u32]) ->
GeometryBundle`, both synchronous over resident packs (pass 3 S1.4 guarantees residency
before decode). `GeometryBundle` crosses as:

```
buffer: Uint8Array          — ONE JS-owned allocation, transferable
descriptor (structured-clone JSON-shaped):
  models: [{ id, bbox: [6], didDegrade,
             parts: [{ partIndex, hinge: [7],
                       vtx: {off, count},         // byte offset of position stream;
                                                  // normal/uv/[baked] offsets derived
                                                  // from count by the fixed S1 layout
                       idx: {off, count, width},
                       subsets: [{ surfaceDid|slot, flags, firstIndex, indexCount }] }],
             fused: (same shape as one part) | null }]
```

Rules: every `off` is 4-B aligned into `buffer`; `bundleToGeometryGroups` builds one set
of shared `BufferAttribute`s per part/fused mesh + per-subset index views + `setIndex`;
the `acBakedLight` attribute installs u8-normalized exactly as today (adapter.js:993–1003).
The bundle is inert data: no `free()`, no handle lifecycle. Worker transfer = `[buffer]`
in the transfer list, nothing else.

### S4 — Consumer contract deltas (read-verified feed points; pool design stays pass 7's)

| consumer | today (verified) | with bundles |
|---|---|---|
| statics.js `fetchPrimaryGeometries` (763–861) | `fetch_model_meshes` → per-model `meshToGeometryGroups`, second round trip for LOD (759–761), starvation bookkeeping (768–831) | one `assemble_model_geometry` per LB batch → `bundleToGeometryGroups`; degraded meshes in-bundle; starvation classes structurally gone |
| statics BatchedMesh (1854–1867) | sizes `maxVerts`/`maxIdx` incl. `geometry.index.count`; `addGeometry` copies | unchanged API — indexed members shrink the copied bytes ~3× [M]; pool succession is pass 7 |
| buildings.js `bakeBuildingPlacement` (334–410) | `fetchBuildingPlacement` handles + hinge snapshot + per-part groups | parts + hinges straight from descriptor; `bakeCache` keeps its shape (caches built groups) |
| animated_scenery.js `_getSharedSetupGeom` (514–559) | decode-once per setup via `fetchBuildingPlacement` | same decode-once, now memcpy-scale; shared bucket geometry unchanged (568–576) |
| cells.js (1038–1045) | per-cell `takeMesh()` → groups | per-LB `assemble_envcell_geometry` bundle; per-cell entries carry remapped subsets + baked light |
| terrain | `SubdividedLandblockMesh` getters (2052–2118, per-getter clones) | same generation; add a bundle-form export to retire its getter clones (same S3 ABI, no pack payload) |

### S5 — Measurement: the indexed-format coefficient (method + results)

Method [M, this session]: 1,500 GfxObj ids probed (`0x01000001 + 13k`), 1,131 parsed OK
via WBT `chorizite-parse-dat-record` (DatReaderWriter GfxObj parse) against
`~/ac_base_dats/client_portal.dat`. Per model: tris = Σ(nverts−2) per polygon, doubled
where a distinct negative surface forces a second emission (mirroring
`append_gfx_tris`' two-sided split, adapter.js:808–819 contract); indexed verts = unique
`(vertex_id, uv_index, side)` corner tuples — the exact identity the runtime expands.
Caveat: sample is id-stride uniform over the GfxObj namespace, not placement-weighted;
Setup fusion concatenates part meshes so part coefficients carry [stated limitation].

| quantity | value |
|---|---|
| tris/model | mean 59, med 32, p90 128, p99 391, max 1,498 |
| indexed verts/model | mean 66, med 28; **max 1,498 → u16 always sufficed** |
| R (verts/tri), corpus-weighted | **1.13** (med 1.06, p10 0.58, p90 2.00) |
| HBG1 bytes/model (24 B/vert + 6 B/tri) | mean **1,946 B**, med 888 B |
| current boundary bytes/model (~100 B/tri: 96 B streams + ~4 B/tri metadata, lib.rs:5941–5993) | mean 5,873 B, med 3,200 B |
| ratio de-indexed : indexed | **3.02×** (corpus-summed) |
| projected full 15,318-GfxObj corpus, HBG1 raw | ~29.8 MB (vs 81.5 MB records [M, pass 2]) → coefficient ≈ **0.37× record bytes** |

Per-tri GPU/heap arithmetic [D]: today's non-indexed group geometry ≈ 96 B/tri resident;
indexed ≈ 24×1.13 + 6 ≈ 33 B/tri ⇒ ~2.9× smaller geometry residency for the same
content, plus the GPU post-transform vertex cache becomes usable (no fps claim — walls:
GPU theories on a CPU-bound frame; this is a bytes claim only).

### S6 — Budget traceability (charter + pass 2 arithmetic)

**S6.1 What moves offline** (I2 ledger): triangulation walk/decode per model per LB;
de-index expansion; memo deep-copies (9290–9292); degrade double-parse; per-getter clone
suite; JS re-bucket copy; 7-buffer worker transfers → 1. Boundary bytes/static tri:
~100×2+ copies → ~33×1 [M+D].

**S6.2 Crossing/tile impact** [D from S5 coefficient on pass 2's [M] figures]: worst
measured column 0.56 MB → ~0.70 MB (models dominate the meta bytes; +0.37× bound applied
to the whole meta component = conservative) ≤ C2 1.5 MB, margin 2.1×; C5's worst-case
transfer 6.7 s → ~8.4 s vs ≥27 s/column travel, margin ≥3.2× ✓. p99 tile ~600 KB →
~820 KB < the 2 MB H-02.2 trigger ⇒ pass 2 S1.4 stands, no restatement. C1 unchanged
(GEOM rides existing packs — zero new requests).

**S6.3 Boot** [D]: ring tile meta 1.28 MB + commons 2.10 MB + regional ~0.5 MB class →
GEOM adds ≤ 0.37 × ~3.9 ≈ **+1.4 MB raw, ~+1.0 MB at pass 2's 0.41 meta compression
[A: zstd on f32 streams assumed ≥0.7 — NOT the 0.41 record ratio; arithmetic uses 0.7]**:
B1' ≈ 17.6 + 1.0 ≈ 18.6 → within the ≤18 MB bound only at the assumed compression;
honest statement: **B1' becomes ≤19 MB worst-case raw-ish, ~18 typical; the conditional
B1 ≤12 path becomes ≈11.9–12.3 MB** — pass 5's 128² preview decision now carries zero
slack and pass 11 should attack this line. (Levers if it breaks: boot ring fetches SETUP
directories + defers non-spawn-tile PART payloads one wave — geometry has a runtime
fallback by construction, encoding 0x0000.)

**S6.4 Memory** (M-series): wasm no longer holds `Vec<Tri>` intermediates or the fused
copies for static content; `MODEL_TRI_CACHE` 64 MiB budget becomes entity-residue-only
(16 MiB proposed at retirement [A], pass 6 owns). JS-side geometry heap for statics ~2.9×
smaller per resident tri [D] (feeds M1/M2; pass 6 prices residency).

### S7 — Instrumentation hooks this pass requires (full spec is pass 10's)

`__diag.geometry` additions: `bundles: {assembled, bytesOut, msAssemble}` (baked path),
`entityDecode: {count, msTotal, substKeyDupes}` (the D-04.8 enable-gate measurement),
`geomFallback: {modelsServedByRuntimeDecode}` (migration health — must trend to
entity-only). The existing decode-starvation surfaces stay wired to the entity path only.

## Handoffs to later passes

- **H-04.1 (→ pass 5):** TEXREF/PVW unchanged by this pass. Flag: S6.3 — the B1 ≤12 MB
  conditional now has ~zero slack after GEOM bytes; pass 5's 128² boot-tier decision
  should re-run pass 2's ring script WITH the GEOM coefficient applied.
- **H-04.2 (→ pass 6):** Cache budgets: decompressed-GEOM/assembled-bundle caching policy
  (proposed: assembled fused buffers are transient — build, hand off, drop; the pack
  bytes are the resident tier); `MODEL_TRI_CACHE` shrink to 16 MiB at legacy retirement;
  the dormant substitution-LRU design (D-04.8) if pass 10's numbers justify it. Also:
  with triangulation gone, the bake worker's geometry role collapses to memcpy-scale —
  input to the single-vs-dual instance call (charter H5).
- **H-04.3 (→ pass 7):** Draw-ready guarantees delivered: fixed 24 B vertex layout,
  shared vertex streams + per-subset index views, subset flags carrying sidedness/stipple,
  deterministic subset order. Pool/material-key design over these is pass 7's, including
  whether pools consume subsets directly (bypassing per-model BufferGeometry entirely)
  and any revisit of position quantization inside pool-owned buffers.
- **H-04.4 (→ pass 8):** Upload scheduling of bundle buffers (when bufferData may run);
  worker message contract slots the S3 bundle as one transferable per job.
- **H-04.5 (→ pass 9):** Migration: encoding 0x0000 → runtime decode via RECORDS is the
  fallback state (pass 2 D-02.7); consumer swap `meshToGeometryGroups` →
  `bundleToGeometryGroups` per consumer behind the pack-source flag; first pack-served
  world needs the eye-test gate (structural render change — winding/normal-quantization
  classes are exactly the flag-bit≠predicate wall's territory); doc-propagation duty for
  the deleted geom-audit machinery.
- **H-04.6 (→ pass 10):** Validate: (a) HBG1 zstd ratio on real payloads (S6.3's 0.7
  assumption); (b) bundle-assembly µs/model on the 1070 (asserted memcpy-scale, unproven);
  (c) the entity-decode counters (D-04.8 gate); (d) a byte-identity differ — bundle
  geometry vs runtime-decoded geometry for N sample models (bake correctness gate, the
  "Rust cache = byte-identical, no eye-test gate" principle — though the FIRST switch-on
  still takes H-04.5's eye-test for the consumer-swap seam).
- **H-04.7 (→ pass 2 owner / bake implementation):** Required bake-walk change: add the
  GfxObj→`did_degrade` closure edge (D-04.6); fold into the pass 2 Q5 walk-widening item
  (MotionTable/PhysicsScript/Sound edges) so one walk revision covers both.

## Self-check

- **Walls — scale confusion:** every byte figure states its population (per-tri vs
  per-model vs per-column vs corpus; boundary bytes vs resident bytes vs wire bytes
  distinguished in S5/S6). PASS.
- **Walls — draws×µs / draw-count proxy:** no draw-count or frame-time prediction appears;
  the one GPU-adjacent claim (post-transform cache) is explicitly bytes-only with the
  wall cited (S5). PASS.
- **Walls — parked-vs-moving / boot variance:** no frame or boot timings claimed measured;
  assembly cost is [A] with a 1070 validation handoff (H-04.6). PASS.
- **Walls — allocated≠used:** geometry residency figures are per-resident-tri derivations,
  not allocation claims; pool allocation behavior deferred to pass 7. PASS.
- **Walls — flag-bit≠predicate:** the consumer swap is named a structural render change
  requiring an eye-test gate (H-04.5), not a metrics-validated one. PASS.
- **R1:** read order followed; no prior decision contradicted. D-04.9 answers pass 2
  H-02.2/Q2 with the measured coefficient instead of restating S1.4 (under the 2 MB
  trigger); B1 arithmetic extended, not superseded — the delta is flagged, and pass 2's
  conditional structure is preserved. Charter D-01.7's kept-degrees restated verbatim in
  D-04.8 (substitutions unbakeable, runtime path retained). PASS.
- **R2:** pool/draw architecture (pass 7), texture tiers (pass 5), cache budgets/topology
  (pass 6), upload scheduling (pass 8), migration staging (pass 9) all deferred with
  proposed defaults. The bake-walk change is recorded as a handoff to the bake work item,
  not designed beyond the edge definition. PASS.
- **R3:** writes = this file + own TRACKING.md row. Measurement scripts live in the
  session scratchpad; no source/docs touched. PASS.
- **R4:** every current-code claim carries file:line opened this session (lib.rs regions
  incl. all prompt-named anchors; adapter.js; bake_transfer.js; statics.js; buildings.js;
  animated_scenery.js; cells.js; walk.rs; gfx_obj.rs; physics.rs; vertex_bake.rs). The
  wasm-crate trap respected (`apps/holtburger-web/src/lib.rs` throughout). The
  did_degrade-walk claim was verified by reading the walk body, not just grep. PASS.
- **R6:** six sections in required order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** byte-exact layouts (S1), a concrete ABI (S3), numeric coefficients with [M]/[D]/
  [A] classes and shown arithmetic (S5/S6), named module/consumer seams (S4). PASS.
- **R8:** unmeasured items declared: substitution decode cost (no cache shipped on it),
  HBG1 compression ratio, assembly µs, the B1 slack erosion, sample-weighting caveat.
  PASS.

## Open questions

- **Q1 — HBG1 zstd ratio.** S6.3 assumes ≥0.7 on f32-heavy streams [A]. One bake
  prototype over the Holtburg ring pins it; if it lands near the record ratio (0.41), B1
  slack returns and this line closes favorably. [Owner: first bake implementation task;
  same run as pass 2 Q1.]
- **Q2 — Setup/EnvCell vertex-count tail.** The 1,131-model sample covers 0x01 GfxObjs;
  fused multi-part setups and large envcell structs could exceed u16 in rare cases — the
  u32 flags bit covers it, but the bake should log the census on first full run so the
  SHOULD-cap (256 KiB) is validated against reality. [Owner: bake first-run report.]
- **Q3 — EnvCell light-bake load cost.** Kept runtime on a derivation (0.38× today's
  arithmetic, indexed) but never measured as a load-time line item. If pass 10 attributes
  interior-entry jank to it, the offline-bake alternative (D-04.7's rejected arm) is the
  designed escape, with its stated pack-byte and blast-radius price. [Owner: pass 10.]
- **Q4 — Entity-path substitution churn.** The D-04.8 cache gate needs the S7 counters
  live on a crowded-server session before the enable/discard call can be made. No number
  exists today; the 119-spawn burst class is the scenario to instrument. [Owner: pass 10
  protocol + an owner call on the threshold.]
- **Q5 — Float16 UVs.** Reserved (flags bit1) pending a texel-swim eye-test at AC's
  wrap-coordinate magnitudes; would save 4 B/vert (~17% of vertex bytes). Not worth
  gating v1 on. [Owner: post-v1, 1070 eye-test batch.]
