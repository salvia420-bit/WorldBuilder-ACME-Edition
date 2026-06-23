I now have the full export surface and the JS consumption contract verified. Writing the assignment output.

---

## Assignment

**Task 11 — wasm exports & rebuild gating.** Audit `apps/holtburger-web/src/lib.rs` for the wind-relevant exports (`fetch_model_meshes` ~9665, `fetch_building_placement` ~9818, `fetchAnimation` ~43127, plus any per-part / raw-vertex surface). Determine the EXACT new wasm exports each phase needs, and classify every phase as **JS-ONLY** (no rebuild — preferred under the 8 GB OOM constraint), **NEEDS-WASM-REBUILD** (gated), or **OFFLINE-BAKE**. The headline finding the synthesis needs: *which work can ship without ever invoking the OOM-prone build.*

## Findings (file:line)

**The three named exports and their exact contracts:**

- `fetch_model_meshes(model_ids: Vec<u32>) -> Result<Vec<ModelMesh>, JsValue>` — `lib.rs:9665`. Fused single-mesh-per-model (the forest BatchedMesh path). Per-id failure pushes an empty mesh (`tri_count==0`), never fails the batch (`lib.rs:9681`). Sibling `fetch_model_mesh(model_id)` at `lib.rs:9605`.
- `ModelMesh` struct `lib.rs:4553`. Fields: `positions` (non-indexed, `tri_count*9` f32, `lib.rs:4555`), `uvs` (`*6`), `normals` (per-vertex, `*9`, `lib.rs:4560`), `surface_indices` (u8/tri), `sides_types`, `surfaces` (unique DIDs), `bbox_min`/`bbox_max` (`lib.rs:4574`), `did_degrade`, `polygon_ids`/`side_kinds`. Getters: `positions` `lib.rs:4612`, `normals` `4616`, **`bbox` → flat `[minXYZ, maxXYZ]` `lib.rs:4631`**, `worldBounds` `4639`, `triCount` `4624`.
- **Per-part bbox is real and per-part.** `pack_model_mesh` (`lib.rs:7006`) recomputes `bbox_min/max` over only the triangles it is handed (`lib.rs:7022-7061`). Because `fetch_building_placement` packs each part separately (`lib.rs:9839` `parts_tris.into_iter().map(pack_model_mesh)`), **each per-part `ModelMesh.bbox[2]` (Zmin) is that part's vertex base** — exactly the Phase-1b sway pivot, already surfaced JS-side.
- `fetch_building_placement(model_id) -> Result<BuildingPlacement, JsValue>` — `lib.rs:9818`. Returns `BuildingPlacement` (`lib.rs:9720`): `setupId` getter `9770`, `partCount` `9778`, `takePartMeshes() -> Vec<ModelMesh>` (one-shot move) `9785`, `takePartHingeFrames() -> Vec<HingeFrame>` `9797`. `HingeFrame` `lib.rs:9737` = `{x,y,z, qw,qx,qy,qz}` getters `9749-9764`, sourced from `setup.placement_frames[0].anim_frame.frames[i]` (`compute_hinge_frames` `lib.rs:9856`, frame read `9887-9896`; raw `0x01` GfxObj → identity frame `9867-9869`). Dispatch: `triangulate_model_per_part_buckets` (`lib.rs:10578`) routes `0x01`→single part, `0x02`→`triangulate_setup_model_per_part`.
- `fetchAnimation(did) -> Result<AnimationJs, JsValue>` — `lib.rs:43127`. `AnimationJs` `lib.rs:43094` = `{num_parts, num_frames, flags, frames: Vec<f32>}`; getters `numParts` `43104`, `numFrames` `43108`, `flags` `43112`, **`frames` `43117`** = flat **frame-major then part-major, 7 floats/(frame,part): `[ox,oy,oz, qw,qx,qy,qz]`** (push order `lib.rs:43146-43152`, **quat stored wxyz**).

**Raw-vertex surface — does NOT exist as an export.** Grep for any `CVertexArray`/`vertices` export: every hit (`lib.rs:10695`, `43921`, and the `45xxx` block) is internal triangulation or `#[cfg(test)]` fixtures — there is **no** `fetch_gfx_vertices`-style export. The only object-space vertex data crossing the boundary today is the **triangulated, non-indexed** `ModelMesh.positions` from `fetch_model_meshes`/`fetch_building_placement`. Raw `CVertexArray` (with original vertex ids) is reachable only offline via `holtburger_dat::file_type::GfxObj::unpack` or `dat-tool extract` (type `0x01` → raw `.bin`, `dat-tool.rs:560`).

**JS consumption contract (proves Phase 1a/1b need no export):**
- `buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps)` (`animated_scenery.js:125`) is a **pure function of a flat `frames` Float32Array** — it never touches wasm. It slices the same 7-float/(frame,part) wxyz layout into THREE tracks (`:133-153`).
- `fetchAnimation` is called in exactly **one** place: `getOrCreateDidGroup` (`animated_scenery.js:204`, call at `:209`). `fetchBuildingPlacement` is consumed at `animated_scenery.js:255`, `takePartMeshes()` `:262`, `takePartHingeFrames()` `:263`.

**Rebuild-gating surface.** Any load-bearing export addition must bump the **F18-2 manifest version** (`lib.rs:591-612`) AND the matching `EXPECTED_WASM_MANIFEST_VERSION` in `index.html`, AND rebuild `pkg/` via `wasm-pack` — the build that OOMs on 8 GB. `global_source.rs` shows the source is a `ManifestResourceSource` fed by HBA bundles through `init_resource_source` (`lib.rs:569`); there is no "inject extra record" export, so an AC-native overlay would either pack into the HBA bundle (offline) or need a new init export.

## Concrete coding steps (ordered; each tagged JS-ONLY / NEEDS-WASM-REBUILD / OFFLINE-BAKE)

**Step 1 — Phase 1a synthetic rustle clip → JS-ONLY, zero new exports.**
Do not touch `lib.rs`. In `animated_scenery.js`, add a sibling to `getOrCreateDidGroup` that takes a synthetic `frames` array instead of fetching:
```
// animated_scenery.js (new, mirrors getOrCreateDidGroup:204)
function getOrCreateSyntheticDidGroup(synthKey, framesFlat, numParts, numFrames) {
  const existing = _didGroups.get(synthKey); if (existing) return existing;
  const clip = buildSceneryAnimationClip(THREE, framesFlat, numParts, numFrames, animSceneryFps());
  // ...identical template/mixer/parts construction as :221-235...
}
```
The DID-group key generalizes from a u32 anim DID to a string id (e.g. `"wind:rustle:0x02001063"`); `_didGroups` is already a `Map`, so a string key shares one mixer across instances exactly as the numeric path does. The procedural `framesFlat` is generated by task-08's JS rustle function. **No `fetchAnimation`, no wasm.**

**Step 2 — Phase 1b bbox base-pivot rig → JS-ONLY, zero new exports.**
`fetch_building_placement` already surfaces everything: call it once per tree DID, `takePartMeshes()`, and read `part.bbox` (`lib.rs:4631`) → `Zmin = bbox[2]`, height span `= bbox[5]-bbox[2]`, width `= max(bbox[3]-bbox[0], bbox[4]-bbox[1])`. Centroid XY from `bbox` (or true centroid by averaging `part.positions`, also JS-only). Hinge frames from `takePartHingeFrames()` give the per-part rest origin. The "rotate about part base, not model origin" transform (task-03 math) is computed in JS and baked into the synthetic `framesFlat` consumed by Step 1. **No new export.**

**Step 3 — Phase 2 offline skeletonize + sim → OFFLINE-BAKE, zero new exports.**
Skeletonization reads vertices **offline**, not in-browser: a new `apps/holtburger-tools/src/bin/tree-wind-bake.rs` (home alongside `scenery-bake.rs`) calls `holtburger_dat::GfxObj::unpack` directly for raw `CVertexArray` vertices (original ids, not triangulated). This runs on the buildbox — sidesteps both the missing raw-vertex export AND the laptop OOM. `dat-tool extract` (`dat-tool.rs:560`) is the manual fallback. **No wasm export needed for skeletonization.**

**Step 4 — Phase 2 VAT runtime → JS-ONLY shader + OFFLINE-BAKE texture; zero new exports IF order-aligned.**
The VAT texture is fetched as a sidecar (mirror `init_scenery_base_url` `lib.rs:2131`), decoded in a JS vertex shader (task 06). `ModelMesh.bbox` already supplies the per-model decode min/max — **no VAT-meta export needed.** The one alignment constraint: VAT row `vertexId` must match the client's draw-order vertices. Resolve it the JS-only way — compute the per-vertex `windWeight` in the **client** at build time from the very `ModelMesh.positions` stream it renders (task 04 JS-post-pass), so there is no cross-process order to reconcile for the procedural/shader route. The VAT texture itself, baked offline, must reproduce that same triangulation order (see Risks).

**Step 5 — Phase 2 AC-native dense Animation 0x03 → OFFLINE-BAKE, reuses `fetchAnimation`, zero new exports.**
The offline bake emits dense Animation `0x03` records (task 09). Two delivery options, both export-free:
- (a) **Sidecar JSON** with the same `{numParts, numFrames, frames[]}` shape `AnimationJs` exposes — parse in JS, hand straight to `buildSceneryAnimationClip`. Cleanest; no DAT, no overlay.
- (b) Pack into the HBA bundle the client already loads → the synthetic DID is reachable through `global_source`, and the **existing `fetchAnimation` (`lib.rs:43127`) plays it unchanged** because it is just an Animation `0x03`.
Avoid a runtime overlay-DAT-injection export (would be NEEDS-WASM-REBUILD).

**Step 6 — OPTIONAL exports (only if a future decision forces them) — NEEDS-WASM-REBUILD, gated to buildbox.**
Specify but do **not** build on the critical path:
- `fetch_gfx_vertices(model_id) -> GfxVerticesJs` — wraps `holtburger_dat::graphics::CVertexArray`/`SWVertex` (`GfxObj.vertex_array.vertices: HashMap<u16,SWVertex>`, each `SWVertex.origin: Vector3`). Returns flat `positions: Vec<f32>` + `vertex_ids: Vec<u16>` (+ per-part split for `0x02`). **~50–70 LOC** (struct + getters + fetch fn mirroring `fetch_animation` `lib.rs:43127`). Only needed if skeletonization must run in-browser — **it should not**; Step 3 makes this unnecessary.
- `fetch_canonical_wind_mesh(model_id) -> WindMeshJs` — emits the SAME non-indexed stream as `fetch_model_meshes` plus per-vertex `windWeight` (Zmin-normalized over model bbox) and `vertexId`, wrapping `triangulate_model` (`lib.rs:6856`) + a Z-normalize pass. **~60–90 LOC.** Only needed if we want a *guaranteed* client↔offline vertex-order contract without factoring triangulation into a shared crate. Step 4's JS-post-pass avoids it.
- `fetchTreeWindClip` / VAT-meta exports — **NOT NEEDED**; `fetchAnimation` and `ModelMesh.bbox` already cover them.

Any Step-6 export also requires bumping the F18-2 manifest version (`lib.rs:591`) + `EXPECTED_WASM_MANIFEST_VERSION` in `index.html`.

## Phase → build-class summary

| Phase | Work | Class | New export? |
|---|---|---|---|
| 1a synthetic rustle | JS clip via existing player | **JS-ONLY** | none |
| 1b bbox base-pivot rig | reads `ModelMesh.bbox` + hinges (already surfaced) | **JS-ONLY** | none |
| 2 skeletonize + harmonic sim | offline tools bin via `holtburger_dat` | **OFFLINE-BAKE** | none |
| 2 VAT runtime | JS shader + sidecar; `bbox` is the meta | **JS-ONLY + OFFLINE-BAKE** | none (order caveat) |
| 2 AC-native dense anim | sidecar JSON → `buildSceneryAnimationClip`, or HBA → existing `fetchAnimation` | **OFFLINE-BAKE** | none |
| (contingency) in-browser skeleton / canonical wind mesh | new wasm export | **NEEDS-WASM-REBUILD** | optional only |

**Bottom line: every shipping phase is JS-ONLY or OFFLINE-BAKE with zero new wasm exports.** A gated rebuild is required only for the contingency exports in Step 6, which the recommended designs (Steps 3–5) make unnecessary. Front-load Steps 1–2 for first-visible-motion with no build at all.

## Risks & open questions

- **VAT vertex-order alignment (the one real export-vs-not fork).** The offline VAT bake (Step 4) must reproduce the exact non-indexed triangle order the wasm triangulator emits. The triangulation helpers (`triangulate_model` `lib.rs:6856`, `append_gfx_tris`, `triangulate_setup_model_per_part`) live **inside the wasm crate `apps/holtburger-web/src/lib.rs`**, not a shared crate — so the offline tool either (i) duplicates triangulation (drift risk), (ii) gets triangulation factored into a shared crate (an OFFLINE-BAKE refactor, still no new export), or (iii) the client computes `windWeight` itself JS-only and the VAT carries only displacement deltas keyed by the client's own order. **Mitigation: prefer (iii)/JS-post-pass; escalate to `fetch_canonical_wind_mesh` (Step 6) only if a pure-VAT route needs hard alignment.** Flag-off → frozen forest, no rollback exposure.
- **Manifest-version trap.** If anyone does add a Step-6 export, forgetting to bump both `lib.rs:591` and `index.html`'s EXPECTED triggers the loud boot mismatch (the F18-2 guard's whole purpose). Call this out in the rebuild checklist.
- **8 GB OOM on the gated build.** Established facts say `cargo build/test --workspace` OOMs. Open question I could not test (read-only): does a single-crate `wasm-pack build -p holtburger-web` (not `--workspace`) fit in 8 GB? Until verified, treat **every** wasm rebuild as buildbox-only and keep all Step-6 exports off the first-motion critical path.
- **Per-part bbox = base pivot assumes parts are spatially split, not material-only.** True for the tall trees per established facts (`0x02000258` trunk/branch/canopy), but `fetch_building_placement` happily returns parts that are material/cluster splits co-located full-height. The bbox rig (Step 2) should fall back to whole-model rustle when a part's Z-span ≈ model Z-span (can't distinguish trunk from canopy) — purely a JS guard, no export impact.
- **Open question for synthesis:** confirm with task 09/10 whether AC-native ships as sidecar JSON (Step 5a, simplest, zero export) or HBA-packed (Step 5b). Both are export-free; 5a is lower-infra and avoids any `global_source` change.
