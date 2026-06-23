I have all the grounding I need. Key discoveries: the GfxObj parser exposes both vertices **and** polygon connectivity, the SetupModel part structure already does most of the segmentation, and the existing `scenery-bake.rs` provides a complete reusable offline-tool template. Note this box has 47Gi RAM (it's the buildbox, not the 8GB laptop), and `cargo run --example` builds only the `holtburger-dat` crate (OOM-safe even on the laptop). Here is my deliverable.

---

## Assignment (Task 07)

Design the **offline skeletonize + segment** step that turns a tree GfxObj (or multi-part SetupModel) into a **bone hierarchy with branch/tip detection**, plus a per-vertex bone assignment/weights output format that feeds the harmonic sim (task 08), the AC-native authoring (task 09), and the shader/VAT routes (tasks 04/05/06). Specify input acquisition, recommend skeletor (Python) vs a lightweight in-Rust approach, and say where it runs.

## Findings (file:line)

**Vertex + connectivity are both already parsed in-Rust — no new wasm export needed.**
- `GfxObj` carries `vertex_array: CVertexArray` *and* `polygons: HashMap<u16, Polygon>` — `external/holtburger/crates/holtburger-dat/src/file_type/gfx_obj.rs:13-24` (`:17` vertex_array, `:21` polygons).
- `CVertexArray.vertices: HashMap<u16, SWVertex>`, each `SWVertex{origin: Vector3, normal, uvs}` — `external/holtburger/crates/holtburger-dat/src/graphics.rs:36-39`, `:19-25`. Vertex IDs are `u16`, read only when `vertex_type==1` (`graphics.rs:83-89`).
- **Connectivity is free:** `Polygon.vertex_ids: Vec<i16>` (`graphics.rs:124-134`). Each polygon is a vertex loop → consecutive pairs are mesh edges → a vertex adjacency graph with zero extra parsing. This is what makes the in-Rust connectivity approach cheap.

**Segmentation is already half-done by the part structure.**
- `SetupModel{ parts: Vec<u32>, parent_index: Vec<u32>, default_scale, placement_frames, default_animation, ... }` — `external/holtburger/crates/holtburger-dat/src/file_type/setup_model.rs:327-351` (`:331` parts, `:332` parent_index, `:336` placement_frames, `:346` default_animation). Per established facts, parts already split into trunk / branch-detail / canopy GfxObjs (`0x02000258` → `0x0100379F` trunk, `0x010037A1` branch, `0x010037A2` canopy).

**Part-index ↔ animation-frame alignment (critical handoff to tasks 08/09).**
- `Animation{ num_parts, num_frames, part_frames: Vec<AnimationFrame> }` — `external/holtburger/crates/holtburger-dat/src/file_type/animation.rs:16-22`. Each `AnimationFrame.frames: Vec<Frame>` holds one `Frame` per part, in `SetupModel.parts` order — `setup_model.rs:277-296`. **Therefore my emitted `bones[]` order MUST be the synthetic `parts[]` order: `bone_index == part_index`.** The sim emits one absolute `Frame` per bone per frame.

**Reusable offline-tool template already exists.**
- `gfx_local_mesh(portal, gfx_id)` reads vertex origins — `external/holtburger/apps/holtburger-tools/src/bin/scenery-bake.rs:419-433`; `setup_local_mesh` concats all parts — `:441-458`; `compute_local_mesh` dispatches on `0x01`/`0x02` top byte — `:409-416`. (Note: it discards polygons and per-part identity — my tool must keep both.)
- Output convention: per-key file + `.sha256` sidecar + top-level `bake-source.sha256` manifest — `scenery-bake.rs:971-1008`, `sha256_file` `:357`, `main` `:1053-1175`. Deterministic, no Date/Random.
- `DatDatabase::new(path).get_file(id)` then `GfxObj::unpack` / `SetupModel::read` — pattern shown in `external/holtburger/crates/holtburger-dat/examples/probe_anim_dist.rs:52-55`; `get_file` at `crates/holtburger-dat/src/lib.rs:313`.

**dat-tool extract is NOT the right input path.** `Commands::Extract` for `0x01` just dumps the raw AC-custom `.bin` with no parsing — `dat-tool.rs:560-569`. Use the library (`GfxObj::unpack`) instead.

**Toolchain reality (verified on this box):** `python3` 3.11.2 present, but `numpy`/`scipy`/`networkx` are **not all installed** (skeletor's hard deps, plus `trimesh`). RAM here = 47Gi (buildbox). `cargo run --example` builds only `holtburger-dat` + deps — far under the laptop's 8GB `--workspace` OOM ceiling.

## Recommendation: lightweight in-Rust, skeletor optional for hero trees

**Primary path = in-Rust height-slice + polygon-connectivity skeletonizer.** Justification:
1. AC trees are tiny (3–11 parts; canopy parts of 16–195 verts per established facts). Mesh-contraction skeletons (skeletor's strength) are designed for dense organic scans and are noisy/overkill on this poly budget.
2. The expensive segmentation step is largely **pre-done by `SetupModel.parts`** — trunk/branch/canopy are already separate GfxObjs. We mostly need to *classify* parts and optionally subdivide tall single parts.
3. Zero new dependencies: reuse `holtburger-dat`. Builds as a single crate (`cargo run --example` / a bin in `holtburger-tools`), OOM-safe, deterministic.
4. skeletor needs a Python venv with numpy/scipy/networkx/trimesh (not installed) **plus** an OBJ export/import round-trip and an AC-Z-up→trimesh-Y-up axis bridge — high interop cost for marginal quality on 11-part trees.

**Keep skeletor as an OPTIONAL `--quality=skeletor` path for hero/near-field trees only**, run on the buildbox in a venv or `blender --background --python`. Use it when a part is a single high-poly blob that the height-slice under-segments.

Cited algorithms: **height/level-set skeleton** = Verroust & Lazarus, *"Extracting skeletal curves from 3D scattered data"* (level sets of a function over the mesh); **mean-curvature/contraction skeleton** = Au et al. 2008 *"Skeleton Extraction by Mesh Contraction"* (SIGGRAPH) — this is what `skeletor.skeletonize.by_wavefront`/`by_teasar` and CGAL's mean-curvature-flow skeleton implement; **auto-weights** = Baran & Popović 2007 *"Automatic Rigging and Animation of 3D Characters"* (Pinocchio), and Blender's bone-heat. SpeedTree's hierarchy (trunk→branch→leaf amplitude/phase) and Crytek GPU Gems 3 ch.16 two-band bending are the motion references consumed downstream by task 08.

## Concrete coding steps

All steps below are **OFFLINE-BAKE** (in-Rust, run on buildbox; no laptop wasm rebuild). They produce sidecars the laptop fetches read-only.

---

**Step 1 — New offline tool skeleton. `[OFFLINE-BAKE]`**
File to create: `external/holtburger/crates/holtburger-dat/examples/tree-skeletonize.rs` for fast iteration (single-crate build), promoted later into `apps/holtburger-tools/src/bin/tree-wind-bake.rs` as a subcommand (task 10).

Edit sketch (mirror `probe_anim_dist.rs:52-55` + `scenery-bake.rs` output convention):
```rust
// args: --dat-dir, --dids 0x02001063,0x020007A2,... , --slices K, --out dist/treewind
let dat = DatDatabase::new(&portal_path)?;
for did in tree_dids {
    let setup = load_setup_or_synthetic(&dat, did)?;        // 0x02 -> SetupModel; 0x01 -> wrap as 1-part
    let parts = load_parts_with_connectivity(&dat, &setup)?; // see Step 2
    let skel  = skeletonize(&parts, slices);                 // Step 3-5
    let json  = serde_json::to_string_pretty(&skel)?;
    let p = out.join(format!("{did:#010X}.treeskel.json"));  // 0x02000258.treeskel.json
    fs::write(&p, &json)?;
    fs::write(p.with_extension("json.sha256"), sha256_hex(&json))?; // mirror scenery-bake.rs:992-1007
}
```

**Step 2 — Load parts WITH vertices + connectivity (don't reuse the lossy `setup_local_mesh`). `[OFFLINE-BAKE]`**
`setup_local_mesh` (`scenery-bake.rs:441-458`) flattens and drops part identity + polygons. Write a richer loader:
```rust
struct PartMesh { src_part: usize, verts: Vec<(u16,Vector3)>, edges: Vec<(u16,u16)> }
fn load_parts_with_connectivity(dat, setup) -> Vec<PartMesh> {
    setup.parts.iter().enumerate().map(|(i, gid)| {
        let gfx = GfxObj::unpack(&mut Cursor::new(dat.get_file(*gid)?))?;   // gfx_obj.rs:27
        let verts = gfx.vertex_array.vertices.iter()
                       .map(|(id,v)| (*id, v.origin)).collect();            // graphics.rs:36-39
        let mut edges = vec![];
        for poly in gfx.polygons.values() {                                 // gfx_obj.rs:21
            let vids = &poly.vertex_ids;                                    // graphics.rs:131
            for w in 0..vids.len() {                                        // loop edges
                let (a,b) = (vids[w], vids[(w+1)%vids.len()]);
                if a>=0 && b>=0 { edges.push((a as u16, b as u16)); }
            }
        }
        PartMesh{ src_part:i, verts, edges }
    }).collect()
}
```

**Step 3 — Per-part bbox classification (Level A, the cheap rig; also feeds task 03). `[OFFLINE-BAKE]`**
For each part compute `zmin, zmax, centroid_xy, xy_extent` over `verts`. Classify (Z is up — established fact):
- `trunk` = narrow XY extent **and** spans full height (`zmin≈model_zmin`, `zmax≈model_zmax`) → root bone, depth 0, low sway_weight.
- `canopy` = high `zmin`, broad XY extent → leaf bone, high sway_weight.
- `foliage_clump` = low, small → leaf bone, medium sway_weight.
`sway_weight = clamp((zmax - model_zmin)/model_height, 0, 1) * width_factor` with width_factor penalizing narrow trunk-like parts. **Pivot = `(centroid_xy, zmin)`** — the part's base, NOT model origin (this is the co-located-origin shear gotcha from established facts). This alone is enough for the Phase-1b rig (task 03) with no graph at all.

**Step 4 — Within-part height-slice + connectivity skeleton (Level B, for smooth bending/VAT). `[OFFLINE-BAKE]`**
Only for parts the dev opts to subdivide (tall trunks, single-part trees like `0x02000406`). Algorithm (Verroust-Lazarus level sets over the connectivity graph):
```
1. Build vertex adjacency from PartMesh.edges (union-find / HashMap<u16, Vec<u16>>).
2. Slice [zmin,zmax] into K bands (default K = max(2, round(height_m / 1.5))).
3. Per band: take vertices with z in band; find connected components within the band
   using ONLY edges whose both endpoints are in the band  -> each component = one skeleton node
   at its centroid (cx,cy,cz=band-mid). (Reeb-graph-by-height.)
4. Link a node to the nearest-centroid node in the band BELOW that shares >=1 connectivity-graph edge.
   That lower node is its parent. Root = the single lowest node (global zmin).
5. depth = graph distance from root.
```
Fallback if a part has no/garbage polygons (connectivity empty): degrade to **pure height-slice by Z bands** (no components) — one chain of nodes, robust on any vertex cloud. Log the fallback (no silent caps).

**Step 5 — Branch/tip detection. `[OFFLINE-BAKE]`**
- Level B: **tip = degree-1 node with `z > root.z`** (degree counted in the bone graph; excludes the bottom root which is also degree-1). These are branch ends → max sway in the sim.
- Level A (no subdivision): tip = part whose `zmin` is highest (canopy) or any leaf in the trivial flat part-graph. Mirrors skeletor's `skel.leafs` (degree-1 nodes).

**Step 6 — Per-vertex bone assignment + weights. `[OFFLINE-BAKE]`**
Emit BOTH forms so all downstream routes are served:
- **HARD (AC-native rigid, task 09):** `vertex_bone[vid] = argmax` bone = the skeleton node owning the vertex's connected component (or nearest node by 3D distance for fallback). Used to **split the GfxObj into one new GfxObj per bone** → synthetic multi-part SetupModel where `parts[i]` is bone `i`'s geometry. AC has zero skinning (established fact), so rigid hard-split is mandatory for the DAT path.
- **SOFT (skinning/VAT/shader, tasks 04/05/06):** per-vertex `(bone, weight)` to its bone + parent, weight = normalized inverse bind-distance falloff (Baran-Popović/Blender bone-heat). For the shader-only route (tasks 04/05) the cheap scalar `windWeight = clamp((vz - bone.pivot_z)/(model_zmax - model_zmin), 0, 1)` is sufficient and is exactly the per-vertex attribute task 04 writes.

**Step 7 — Output JSON schema + sha sidecar. `[OFFLINE-BAKE]`**
File: `dist/treewind/0x0200XXXX.treeskel.json` (+ `.json.sha256`), symlinked to `/mnt/wbterminal2/holtburger-dist` like the scenery bakes; client fetches via a `init_treewind_base_url` mirroring `init_scenery_base_url` (task 10/11 wiring). Schema:
```json
{
  "did": "0x02000258", "up_axis": "z",
  "model_bbox": {"min":[x,y,z], "max":[x,y,z]}, "model_height": 22.9,
  "bones": [
    {"index":0, "parent":-1, "depth":0, "is_tip":false, "src_part":0,
     "pivot":[cx,cy,zmin], "head":[..], "tail":[..],
     "height_span":[zmin,zmax], "sway_weight":0.05, "axis_len_m":21.2}
  ],
  "tips": [3,4,5],
  "vertex_bones": {
    "0": { "hard":[0,0,1,...], "soft":[[[0,0.8],[1,0.2]], ...] }
  },
  "wind_weight": { "0":[0.0, 0.0, 0.3, ...] }
}
```
**Invariant to assert in the tool:** `bones[i].index == i` and `bones[].len()` = synthetic SetupModel part count, so task 08's per-frame `Frame[i]` and task 09's `parts[i]` line up 1:1 with `part_frames[*].frames[i]` (`animation.rs:19-22`, `setup_model.rs:283-287`).

**Step 8 — (Optional) skeletor quality path for hero trees. `[OFFLINE-BAKE, buildbox-only]`**
A sibling script `tools/skeletor_tree.py` (run in a venv: `pip install skeletor trimesh numpy scipy networkx`). Export the part to OBJ (swap AC Z-up → trimesh Y-up), run `skel = sk.skeletonize.by_wavefront(mesh, ...)` (robust on low-poly per assignment), map `skel.swc`/`skel.leafs` back to the same JSON schema as Step 7 (re-swap axes), so the runtime is path-agnostic. Gate behind `--quality=skeletor`; default stays in-Rust.

## Risks & open questions

- **Co-located-origin pivot shear (highest risk).** Every part shares model origin `(0,0,0)` with `parent_index = -1` (established fact). If a bone's pivot is left at origin, a high canopy bone swings through a huge arc. **Mitigation:** pivot is always `(centroid_xy, vertex_zmin)` of the bone's own geometry (Step 3); the tool must assert `pivot.z` is finite and within `model_bbox`. Task 08 rotates about this pivot, not origin.
- **Empty/garbage polygon connectivity.** Some GfxObjs may have sparse drawing polys → empty edge set → degenerate graph. **Mitigation:** Step 4 fallback to pure Z-band chaining; emit a `"connectivity":"polygon"|"zband-fallback"` field and `log()` it so coverage is auditable (no silent degradation).
- **Hard-split joint cracking (AC-native path).** Rigid per-bone GfxObjs crack at segment boundaries when rotated. **Mitigation:** keep boundary bands' shared vertices weighted toward the parent bone (reduce relative motion at the seam), keep per-frame angles small; and steer fidelity-critical near-field trees to the **soft-weight VAT route** (task 06) instead of the rigid DAT path. This is the residual stiffness that motivates Phase 2.
- **Part-index ordering drift.** If task 09 reorders `parts[]` (e.g. by surface) the `bone_index==part_index` invariant breaks and animation frames map to the wrong geometry. **Mitigation:** the skeleton JSON is the single source of truth for part order; task 09 must consume `bones[]` order verbatim. Assert count equality at pack time.
- **Determinism.** HashMap iteration order over vertices/polygons is nondeterministic. **Mitigation:** sort vertex IDs and polygon keys before building graphs (the packers already sort keys, e.g. `graphics.rs:112-114`); seed any per-branch phase from a hash of `(did, bone_index)` not `Math.random` (established constraint, consumed by task 08).
- **skeletor dependency cost.** numpy/scipy/networkx/trimesh not installed; axis-convention + OBJ round-trip interop. **Mitigation:** in-Rust is primary; skeletor is opt-in buildbox-only for hero trees. Open question: is the marginal topology quality worth it for any AC tree, or only for the densest canopy parts? Recommend deferring skeletor until an in-Rust eye-test shows under-segmentation.
- **Open question — slice count K heuristic.** `K ~ height/1.5m` is a guess; the right K depends on how many bend segments read well in the 1070 eye-test. Expose `--slices` and tune in the batched eye-test session (task 14), don't hard-code.
- **Where it runs:** buildbox (47Gi) or laptop via `cargo run --example tree-skeletonize -p holtburger-dat` (single-crate, OOM-safe). Never `--workspace`. skeletor variant: buildbox venv / `blender --background` only.
