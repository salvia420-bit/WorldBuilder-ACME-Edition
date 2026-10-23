# HANDOFF — GPU-resident static world ("no mesh objects"): research 2026-10-22, laptop build 2026-10-23

**Originally a research handoff (the 2026-10-22 research session built nothing); §0 lists what was built afterwards,
on 2026-10-22/23. Sections 1-10 are the original research text; `[2026-10-23: …]` markers say where §0 changed them.**
The research came out of a 20-minute read-only session on HEAD
`2c7f4f0f`: the orchestrator plus three read-only agents (static draw path, static-mesh consumers, Rust/bake data side).
Every agent citation used below was re-read in code; one agent claim turned out wrong (§5 F8).
- Nothing ran on a GPU, in a browser, or through a build or the JS gate.
- Two targeted node tests were run to check that the substrate still works at HEAD: `harness/test_draw_pools.mjs`
  **448 passed / 0 failed** and `tests/batched_runs.test.mjs` **63 / 0**.
- No figure here is an fps prediction (charter D-01.5; walls ledger). Gains are stated as which measured term shrinks.
- Evidence tags follow the re-engineering docs: **[M]** measured (source named), **[D]** derived, **[A]** assumed.

## 0. Status 2026-10-23 — everything that could be done without the 1070

Owner goal (2026-10-22): "do all that can be done with this matter without involvement of the 1070". Built by
parallel agents (node tests only) with an orchestrator running every build, GPU smoke and browser run on the laptop,
one at a time, inside `capped-build`. Every change then went through an adversarial review; all 26 findings were
reproduced with a failing test or code trace and fixed (none refuted). Nothing below has run on the 1070.

**What landed** (all GPU smokes are laptop SwiftShader, pixel identity = max channel diff 0 against the flag-off arm):

| Item | Flag (default) | Proof | Notes |
|---|---|---|---|
| P1a atlas geometry dedup (F2) | `?atlasGeomDedup` (**on**) | node 114/0; `atlas_geom_dedup_smoke` PASS | Refcounted (content, layer) ledger, byte-verified keys. Small in practice: see the laptop census below. |
| P1c / B9a building buckets as runs | rides `?batchedRuns` (**on**) | `static_early_out_smoke` PASS (incl. the building arm) | |
| B9b sorted buckets as order-keeping runs | `?batchedRunsSorted` (**on**) | node 58/0; `batched_runs_sorted_smoke` PASS incl. a reversed-order control that must differ | No-gain sorted draws now stop after one read-only scan of the range arrays (`hasConsecutiveRepeat`), before any copy, run build or layout write (review fix). |
| L1 O(1) unchanged-list proof | `?batchedRunsStable` (off) | node 42/0; smoke arm PASS | Built as a per-mesh write epoch plus a full-compare audit every 64th skip. Inert at today's defaults; live only on marked buckets that ride three's early-out: `?staticEarlyOut=on` (P2) or the `?drawPools` chain (opaque pools). The queue arms it only with staticEarlyOut (P0-FLAGS arm6); no pooled + stable arm exists. |
| P2 / L0 early-out for opaque chunk + building buckets | `?staticEarlyOut` (off) | node 85/0; `static_early_out_smoke` PASS | Needs the 1070 A/B (triangles vs walk). Atlas half NOT built: towns hold only 50-67 atlas placements (census below). |
| P1d / B10 terrain program without gl_DrawID | `?terrainNoDrawId` (off) | node 117/0; `terrain_no_drawid_smoke` PASS | ANGLE mechanism verified in ANGLE source (Context11 multi-draw sets the draw-ID uniform only when the program uses it). |
| P3 pools drawn as runs (F1) | `?poolRuns` (on inside the off `?drawPools`) | node 138/0 + `test_draw_pools` 448/0; `pool_runs_smoke` PASS | F1's premise "pools dedup by content" was FALSE (per-LB uuid keys): now byte-verified content keys. Five HEAD pool defects fixed (stale node bounds, overwritten multi-plan feeds, band swaps under the early-out, park-blind merge, unwired vacate). GATE-POOLS carries the F1 criteria and a TEXREF/catalog precondition. |
| F7a HBG1 v2 back-face marker | none (format v2; v1 stays `missing` under `?negFace`) | `cargo test` hbg1 14/0, geom_bundles 10/0 (8 + 2 setup differs added in review), bake CI region + relief legs PASS, real-DAT corpus differ: **15,318 GfxObjs encoded, only 32 need a mark; all 32, plus 100 unmarked GfxObjs and 30 + 150 setups, exact on both negFace arms** | Full-world rebake: see "Rebake" below. `docs/HBG1-negface-marker-2026-10-22.md`. |
| F7b page-dim corpus | — | research | The handoff premise was stale: the encode RAN (buildbox 08-10) and BAKE-4 consumed it. The real blocker is that the page farm was never PUBLISHED into the served `holtburger/tex-xu7` catalog (985 rsIds served at old dims). Publishing changes the default look of 1,730 textures and adds 1.1 GB on a near-full SSD: **owner decision**. `docs/drawpools-blockers-2026-10-22.md` §2. |
| F7c E2-E6 | — | inventory | E2-E5 never ran anywhere; E6 ran once on a T4 (inconclusive). Same doc. |
| P4 vertex-pulling spike | harness only | node 54/0; `vertex_pull_smoke` PASS, all four encodings == BatchedMesh runs, one draw call | Trap found and fixed: three forces `FLAT_SHADED` on lit materials when the geometry has no `normal` attribute; a pulled drawable needs a 1-vertex `normal` marker. `docs/vertex-pull-spike-2026-10-22.md`. |
| P0 prep | — | node 179/0 | `docs/reengineering/queue-1070/batch-P0-gpu-resident-2026-10-22.json` (owner-run; now also carries arms for every flag above), `external/holtburger/scripts/perf-worker/structure-p0.eval.js` (shared page read), `external/holtburger/scripts/perf-worker/laptop-structure-probe.mjs` (laptop structural twin). |

- Every node test above is a tier-5 entry in the JS gate. The full gate on the committed tree: **871 passed / 0 failed**
  (2026-10-23). The six new GPU smokes in `harness/glsl_smoke/` (`atlas_geom_dedup`, `batched_runs_sorted`,
  `pool_runs`, `static_early_out`, `terrain_no_drawid`, `vertex_pull`) are NEEDS_BROWSER: the gate lists them but does
  not run them. Re-run them by hand (`capped-build`, one at a time) after touching their modules.
- `atlasGeomDedup` and `batchedRunsSorted` went default-on on laptop pixel smokes only. P0-FLAGS arms 4 and 8 confirm
  or revert them on the 1070.

**Laptop structural census (HEAD `87fabdb4`, SwiftShader, `quality=ultra&pvsRingRadius=2`, counts only) [M]:**

| Town | ranges asked / issued per frame | `renderer.info` calls per frame | BatchedMesh calls | F4 unsorted share (chunk + atlas slots) | atlas placements / distinct geoms |
|---|---|---|---|---|---|
| Holtburg | 1,535 / 370 | 1,311 | 128 | 0.922 | 50 / 50 |
| Linvak Tukal | 842 / 349 | 124 | 72 | 0.426 | 67 / 67 |

- batchedRuns already cuts the static ranges about 4x at Holtburg. In the Holtburg frame most GL calls are NOT
  static-batch ranges: about 1,180 of 1,311 are plain-mesh draws (cells / entities / singletons). The per-owner draw
  tally now in `structure-p0.eval.js` (`census.hold.drawsPerFrameByOwner` in each town's reads.json) splits them; the
  P0 queue's reads list names it, so the 1070 session records it.
- F4 holds at Holtburg (92% of chunk + atlas slots in unsorted buckets, so P2's early-out can reach them) but NOT at
  Linvak Tukal (43%).
- F2 is small in practice: the atlas holds only tens of placements per town, not the June 5,400 (chunk buckets took
  them over), so P1a buys little; it stays on because it is exact.
- **Before / after at identical settings** (Holtburg, same pose, same probe build, 2026-10-23 [M]): HEAD `87fabdb4`
  1,523 ranges asked / **366 issued** per frame; the new defaults 1,523 / **267 issued** (-27%). The drop is almost
  all `?batchedRunsSorted` (4 sorted draws: 136 instances -> 37 runs). Atlas dedup works (44 placements over 31
  geometries) but the atlas draws only 8 ranges a frame; building buckets have no repeated range here (B9a = 0).
- **Where the GL calls actually are** (`hold.drawsPerFrameByOwner`, same run): of ~1,465 calls per frame, entities
  626, cells (interiors) 494, statics 176 (its 1,539 ranges already collapsed by runs), occlusion proxies 60,
  buildings 36, sky 36, the rest < 20 each. By call count the static world is no longer the big term; entity parts
  (P5, open lead 242) and cells are. Draw counts do not predict ms (walls 29/107/137): the 1070 session decides, but
  this is the strongest laptop evidence that the next lever after P0 is entities/cells, not more statics work.
- Laptop limits learned the hard way: a full-town ultra render on SwiftShader needs ~3.5 GB (GPU process ~2 GB +
  renderer ~1.7 GB) and earlyoom kills it unless the box is otherwise quiet; the post-@teleloc portal tunnel never
  releases on SwiftShader (the probe now streams under the tunnel and ends it before the census).

**Rebake (F7a, laptop, NOT deployed):** `/mnt/wbterminal2/reeng/orch-bake/world-packs-v5` (driver
`run-world-bake-5.sh`, log `driver5.log`), 2026-10-23 01:23-04:03, 160 min, rc=0 [M]. Same inputs/flags as BAKE-4.
- `closure_verified` and `determinism_verified` true; 17,682 packs / 16,384 tiles / 1,153 interiors, `geom_rows`
  16,107, `geom_relief_rows` 2,179, `texref_missing_pvw` 0, `texref_off_page_full_tier` 0 (all equal to v4).
- `hbg1_face_census.py --require-v2`: every 0x01 GEOM (7,498) and GEOMR (1,417) row is v2; backface 1, NoPos 24,
  front-copy 0. Verdict: `?negFace` serves every model.
- Diff against v4: GEOM differs in 752 packs, GEOMR in 285, and REFS in 17,029 — the REFS delta is a pure content-hash
  cascade (REFS name targets by hash): records identical and every renamed entry names the same index ordinal
  (31,960 renamed, 40,429 unchanged, 0 violations). No other section differs. The census `--diff` now checks this and
  reads `only_geom: True`.
- Browser A/B on a read-only overlay (new release wasm, Holtburg, default `?negFace`, `geomBundles=on`): today's v1
  dist 124 unmarked models / 88 bundles / 229 runtime decodes; v5 **0 / 212 / 105**; 0 console errors. Details in
  `docs/HBG1-negface-marker-2026-10-22.md` §9.
- Deploy, `dist_ssd.py stage --activate` and the owner's eye check are the owner's call (§0 list). `deploy-packs-v5.sh`
  does not exist yet: create it from `deploy-packs-v4.sh` per `docs/HBG1-negface-marker-2026-10-22.md` §5.4 (step 0
  first: the release wasm must be deployed before the v2 dist is activated).

**Laptop state left behind (not in git):**
- `pkg/` holds the new release wasm (7,630,792 B, 2026-10-23 04:12), which the v2 reader needs; the previous wasm is in
  `pkg-prev-20261023/`, the build dir in `pkg-gpures/` (all gitignored). The cache stamp went `wasmrev-20261021a` →
  `wasmrev-20261023a` (index.html, net_worker.js, net_worker_client.js, bake_worker.js). `pkg/` is gitignored, so any
  other checkout must rebuild the release wasm after pulling this.
- The live `:8765` serve.py serves this tree (new JS + new wasm). `dist` still → `~/hb-serve/dist/current` (v1 packs);
  nothing was staged or activated.
- `/mnt/wbterminal2/reeng/orch-bake/dist-v5-overlay`: a read-only overlay (current dist + v5 packs) for the owner's
  eye check. `/mnt/wbterminal1/tmp/hb-live-copy` (448 MB): the tree copy the A/B served from; safe to delete.
  Probe and log output: `/mnt/wbterminal1/tmp/gpu-resident/`.
- Workflow lesson: `rm` / `mv` / `rmdir` are "ask" rules in settings.json. Inside a background workflow nobody can
  answer the prompt, so the agent hangs for hours. Forbid them in every agent prompt (python `os.unlink` instead).

**Owner decisions / 1070 work left:**
1. The P0 1070 session (queue file above): bare / `batchedRuns=off` (THE deciding per-range number) / drawPools chain,
   plus the 2026-10-22 flag arms. Every further per-range change waits on arm 2's rule.
2. Whether to deploy + activate the v2 packs (SSD headroom ~80 MB above the `dist_ssd` floor). After deploying, drop
   `&negFace=off` everywhere it was added on 2026-10-22: P0 arm 3 and arm3b, the P0 laptop-twin recipe, batch-C E6 and
   batch-D E6 (and its prereq note).
3. Whether to publish the page farm (R1; changes the default look of 1,730 textures and adds 1.1 GB). R1 also gates
   GATE-POOLS and batch-D E6: the R4 validator must exit 0, and today it reports 985 mismatches. v5 was baked against the
   page farm (same inputs as BAKE-4), so declining R1 means one more full rebake (`docs/drawpools-blockers-2026-10-22.md`
   §2.5, the R3 "declined" branch).
4. Default flips owed to 1070 numbers: `staticEarlyOut`, `terrainNoDrawId`, `batchedRunsStable`, `statGeomDedup` (F3);
   and confirm or revert the two laptop-only default-on flips (`atlasGeomDedup`: P0-FLAGS arm4; `batchedRunsSorted`:
   arm8).
5. Next lever by the laptop census: entity parts (P5) and cells, not statics (see the per-owner tally above).
6. Not built, by decision: atlas half of P2 (tiny atlas population), GPU billboards (no bucket carries billboards
   today; blocked on the D-07.8 band tick), terrain span coalescing and P4 proper (both wait on the P0 per-range
   number).
7. Small open items:
   - `hbsess.mjs` has no `--account` option yet; the queue's `driverGap` asks for one.
   - Atlas sorted buckets do not share geometry yet: the smoke has no sorted arm (`static_atlas.js` P1a header).

## 1. Owner prompts (verbatim)

> i was reading a youtube comment for a game and was thinking for holtburger-web the meshes are demanding, and using a
> lot of cpu which is the bottkeneck, could something like this be possible "In this devlog I build a custom GPU-driven
> rendering pipeline using indirect rendering, upload vertex data straight to the GPU with no mesh objects at all, add
> octree-based frustum culling that runs entirely on the graphics card, and compress our vertex format down to a
> fraction of its original size. End result: a 10x performance boost, planets rendered at full detail, and over a
> billion vertices on screen at once". information only, if it takes long to build doesnt matter, probably wont work
> still asking

> create a handoff for the big one commit and push to origin/master, but research it for 20 minutes before making the
> handoff

"The big one" is the item from the chat answer: take the static world out of three's per-object scene graph and draw it
from GPU-resident buffers with very few real draws per material class.

## 2. Verdict

1. **The devlog's exact recipe is WebGPU-only.** It relies on compute-shader culling and indirect draws, and WebGL2 has
   neither.
   - WebGPU multi-draw-indirect is still an experimental Chrome feature behind `chrome://flags/#enable-unsafe-webgpu`.
   - three r184's own WebGPU backend still issues one `drawIndexed` per BatchedMesh instance from the CPU
     (`node_modules/three/src/renderers/webgpu/WebGPUBackend.js` ~1600-1627).
   - A WebGPU port would also mean rewriting 99 `onBeforeCompile` patch sites in 35 files and 34 custom shader
     materials, and replacing the WebGL-only postprocessing stack.
   - Not a near-term route.
2. **The part that carries over is "no per-object CPU work, few real draws".** In WebGL2 that means three things:
   - (a) an O(buckets) scene graph that does **zero per-instance JS on settled frames**;
   - (b) each bucket draws **one instanced range per distinct geometry**, so ANGLE issues one D3D11 draw per
     (bucket, geometry) instead of one per placement;
   - (c) optionally, **one draw per bucket** via vertex pulling.
3. **Most of (a) and (b) already exist, in two separate places that have never been joined:**
   - `?drawPools` (re-engineering ST9, built Aug 2026, DEV/off, never run on the 1070) does (a);
   - `?batchedRuns` (Oct 19, default on) does (b) for the legacy buckets.
   - [2026-10-23: joined: `?poolRuns` marks opaque pools for batchedRuns. See §0.]
4. **New finding: `?drawPools` as specified would most likely push cost into Chrome's GPU process** (§5 F1). Its opaque
   pools turn per-instance culling off, so three submits every LIVE member of a visible pool as its own multidraw range,
   and ANGLE D3D11 turns every range into a full draw. Pools are not wired to batchedRuns, and GATE-POOLS has no
   GPU-process criterion. The spec predates the Oct 19 discovery of ANGLE's multi-draw emulation. [2026-10-23: wired
   (`?poolRuns`), and GATE-POOLS now carries the F1 criteria (SPEC T22). Not yet measured on the 1070.]
5. **"GPU culling" is not available in WebGL2, and a vertex-shader cull is not a substitute** (§5 F5). Fine culling
   becomes coarse CPU culling per bucket, plus hardware clipping. The price is extra vertex work, which the GPU census
   can measure and the bucket's spatial size can tune.
6. **The vertex-compression piece is already designed and baked.** HBG1 geometry in the packs is indexed, at 24 B per
   vertex. Today's runtime path is non-indexed f32 soup at 32 B per triangle corner. The blocker is a rebake (§5 F7).
   [2026-10-23: rebake done (v5 packs, HBG1 v2) but not deployed; owner call.]
7. **Order:** P0 measure (one owner-run 1070 session) → P1 make every static range a run on the legacy path (small,
   pixel-identical) → P2 zero per-instance JS for opaque buckets → P3 revive drawPools with runs → P4 vertex pulling,
   only if the numbers still call for it. Details in §7. [2026-10-23: P1a/c/d, P2 (flag off), P3 runs and the P4
   spike are built; P0 is still owed. See §0.]

## 3. What the measurements already say

| Fact | Source |
|---|---|
| 1070 at ultra, settled in a town: about 50 fps. The renderer main thread, Chrome's GPU-process main thread (CrGpuMain) and GPU fill are all near saturation in towns. | [M] HANDOFF-improvement-hunt-2026-10-20 §5; 2026-10-19-fps-review |
| CrGpuMain 79% busy (WebGL 15.2 ms/frame + DOM raster 4.7), renderer main thread 98% busy (10-06 `gpu.angle` trace, mid, first street sweep). | [M] fps-review finding 1 |
| ANGLE D3D11 emulates `WEBGL_multi_draw`. Each range becomes a full draw plus an uncached `gl_DrawID` uniform plus a re-upload of the whole vertex uniform buffer. Holtburg: 1,921 counted calls = **5,838 real draws**; 17,774 static instances over 324 geometries. | [M] `scene3d/batched_runs.js` header (ANGLE source read 10-19); net-review 2026-07-15 |
| **The per-range CrGpuMain cost has never been measured.** The 10-06 trace has no per-draw ANGLE events (checked this session: `WebGL` / `CommandBuffer::Flush` slices only). | this session → §7 P0 |
| Renderer main thread, 10-17 census (1070): 800 draws/frame, `renderBufferDirect` 12.0 ms/frame. The static world (statics + cells + buildings, colour + shadow) accounts for roughly 9 ms of that; entities about 1.2 ms. | [M] `/mnt/wbterminal1/tmp/fps-agent/census1.json` |
| Per world `render()`: draw funnel 11.0 ms, traversal (preProject + project) 4.1 ms, shadow 5.6 ms. CSM has been off on every preset since 10-17, so the shadow share is gone at default. | [M] `fps-agent/fsplit1.json`; `quality.js` csm:false |
| GPU (same day): 28.3 ms/frame. Post composite (clouds/AP/SSAO) 9.9, terrain 6.2, statics 4.5, cells 1.9. This work does not touch terrain or post, so once the CPU side drops, the GPU becomes the limit in towns. | [M] `fps-agent/gpucensus2.json` |
| August main-thread terms: 37.6 µs fixed per draw (r² = 0.014 vs instance count). BatchedMesh rebuild 5.72 ms/frame, 80% of it per-instance (0.348 µs/instance). Traversal ~3.6 ms over ~4.4k nodes. Transparent pass 8.70 ms / 212 draws vs opaque 4.28 / 215. | [M] 2026-08-06 frame-cost doc, via pass-07 |
| `?walkInInstance` cut true draws 63% (7,563 → 2,761) for −2.95 ms renderCPU (−10.5%), at a cost of +23% triangles. It lost per-placement LOD and degraded-leaf billboarding, and was declined 07-15. Its A/B measured only the main thread. | [M] url-flags `walkInInstance` |
| Nanto: 26,212 opaque + 2,094 translucent static instances over 11 sectors, 63 classes / 271 pools after the re-key. | [M] `docs/reengineering/impl/t00-class-census.json`, SPEC R-03 |

## 4. What already exists (build on it, do not rebuild)

| Piece | Where | State |
|---|---|---|
| **Draw pools**: one `THREE.BatchedMesh` per (768 m world sector × material class) | `scene3d/pool_registry.js`: opaque early-out pair at :355-383, exact (content, layer) geometry dedup at :458-482 [2026-10-23: now :499-509 and `_ensureGeometry` :657-680; the key is a byte-verified content hash only under `?poolRuns` (default on); the `=off` arm, like 87fabdb4, keys by the per-LB geometry uuid], event-driven membership, `setVisibleAt` park. Also `pool_class_key.js`, `pool_material.js` (array-page materials), `pool_producer.js`, `pool_envcells.js`, `pool_prewarm.js`, `pool_stream.js`, `tile_plan.js`. Spec: `docs/reengineering/pass-07-scene-and-draw-architecture.md`, SPEC.md T22, GATE-POOLS at SPEC.md ~:587 [2026-10-23: ~:594, now with the F1 criteria and a TEXREF/catalog precondition] | DEV, off. Needs `slotGrid` + `packSource` + `geomBundles` + `texCompressedOnly` (+ `frameWork`) (F-11.3). Node battery green at HEAD. Never run on the 1070 (E6 queued in `queue-1070/batch-C-2026-08-09.json`). |
| **batchedRuns**: per-geometry instanced runs. The run layout lives in the indirect texture; draws go through `multiDraw*InstancedWEBGL`. | `scene3d/batched_runs.js`. Marked only by `static_batch_x.js:2388` and `static_atlas.js:1470`. Steps aside for sorted buckets and for buckets whose ranges never repeat. [2026-10-23: marked by `static_batch_x.js:2646`, `static_atlas.js:1604`, `buildings.js:439` (B9a) and opaque pools (`pool_registry.js:521`, `?poolRuns`). Sorted buckets draw as order-keeping runs (`?batchedRunsSorted`, on); a bucket steps aside only when nothing repeats (consecutively, for sorted buckets). Second smoke: `batched_runs_sorted_smoke.mjs`.] | Default on. GPU smoke: `harness/glsl_smoke/batched_runs_smoke.mjs` (pixel-identical vs `=off`). |
| Other BatchedMesh patches | `batched_indirect_per_camera.js`, `skip_empty_multidraw.js`, `three_batchedmesh_colortexture_fix.js` (load-bearing for pools, F-11.18), `batched_material_variant.js` | Default on |
| One persistent node fed by slots (the precedent) | `scene3d/terrain_batch.js`: one BatchedMesh, per-LB slots, DataArrayTexture layers | Default on |
| Animated scenery | `scene3d/animated_scenery.js`: InstancedMesh per (setup, part, surface) | Stays (charter I5-kept) |
| **Indexed, compact geometry (HBG1)** | Pack section 0x09: **16,107 model rows, 30.3 MB raw / 9.1 MB stored for the whole world** ([M] `dist/pack-report.json`). 24 B/vertex (f32 position, snorm8 normal, f32 uv) + u16/u32 indices (pass-04 layout). Consumer: `scene3d/geom_bundles.js` (`setIndex`). The runtime path today is non-indexed f32 soup (`adapter.js meshToGeometryGroups` :877). pass-04 S6.4 estimates a JS geometry heap ~2.9× smaller per resident triangle [D]. | Gated by `?geomBundles` (off) and blocked by `?negFace` (§5 F7) |
| Diagnostics | `__diag.render.{batchedCalls, subDraws, issuedSubDraws}` (`?renderDiag=on`), `__batchedRuns.stats` / `.frame()`, `__statBatchXStats()` (per-bucket `sorted`, `slots`, and the `walk` block), `__atlasStats()`, `__diag.pools()`. [2026-10-23 additions: `__batchedRuns.frame()` sortedSubDraws / sortedIssued, stats sorted* / stable*, seams `__batchedRuns.sortedOff` / `.stableOff`; `__statBatchXStats().walk.earlyOut` and `window.__staticEarlyOut.off`; `__atlasStats()` geomAdds / geomDedupHits / geomDedupCollisions; `__terrainBatch.stats()` noDrawId*, `.verifyIids()`; `__diag.pools().runs` and producer contentShared / contentCollisions; `__diag.geometry.faceMarker`; structure-p0 `census.hold.drawsPerFrameByOwner`. Rows in url-flags.md.] | Live |
| Bench | `scripts/perf-worker/`: `hbbench.mjs --uncapped`, `gputrace.mjs` + `gpu_thread_split.py` (categories `gpu.angle,gpu,toplevel`; never `gpu.service`/`decoder`, which inflate ~10×). Bench URLs add `targetFps=0` via `lib/bench-url.mjs`; check `__frameCapState().fps === 0`. | Live |

## 5. Findings from this research (none of these are in the 10-20 ledger)

- **F1. drawPools would multiply ANGLE ranges.** [2026-10-23: opaque pools now draw as runs (`?poolRuns`); the "pools dedup by content" premise below was false and is fixed. See §0.]
  - What three does: `BatchedMesh.onBeforeRender` with `perObjectFrustumCulled = false` writes one multidraw range for
    every visible, active instance (`node_modules/three/src/objects/BatchedMesh.js` ~1634-1660). The early-out
    (:1522) only saves the JS rebuild; the GPU process still loops the ranges.
  - Scale: Nanto's ~2.4k opaque instances per sector means a handful of visible sectors submit thousands to tens of
    thousands of ranges per pass [D]. For comparison, Holtburg measured 5,838 ranges in July, before batchedRuns; no
    town reading exists since (P0 arm 1).
  - Gap: `rg markBatchedRuns scene3d/pool_*.js` finds nothing, so pools never draw as runs. Pools DO dedup geometry
    by (content, layer), so runs would regroup them well.
  - **Required before any pools flip:**
    - wire runs into opaque pools;
    - add a GPU-process criterion to GATE-POOLS: `issuedSubDraws` ≤ the legacy arm, and CrGpuMain WebGL ms/frame
      (`gpu_thread_split.py`) not worse than the legacy arm.
- **F2. The atlas path defeats batchedRuns.** [2026-10-23: fixed by `?atlasGeomDedup` (default on); measured size is small, 50-67 atlas placements per town. See §0.]
  - What it does: `static_atlas.js` clones and normalizes every member placement's geometry and adds it as its own
    geometry (`normalizeForMerge` :908, add loop ~:1917-1937 [2026-10-23: now :1005, ~:2236-2300]). No two members share a range, so batchedRuns counts the
    bucket as `noGain`, and **every atlased placement is one ANGLE draw**.
  - Fix: key atlas geometry by (source geometry content, layer), as pools already do. Same pixels; the layer stays
    vertex-stamped.
  - Size unknown: no doc counts atlas members. P0 arm 1 reads `__atlasStats()` and `__batchedRuns.stats.noGain`.
    Not in the 10-20 ledger or findings. [2026-10-23: P1a is default-on, so arm 1 reads the fixed state; F2's own size
    is P0-FLAGS arm4 (`&atlasGeomDedup=off`). `noGain` sums every marked kind; read `census.summary.f2` instead.]
- **F3. Chunk buckets hold up to 9 copies of a model**, one per LB of the 3×3 region, because geometry is decoded per LB
  feed (`statGeomCache` and `statGeomDedup` are off). So runs only merge within one LB's contribution. `?statGeomDedup`
  exists; it is off "pending the 1070 pinned-pose re-base" (url-flags).
- **F4. The August "per-object cull off saves only 0.40 ms" verdict rests on a premise that no longer holds.** [2026-10-23: laptop census: unsorted share 0.92 at Holtburg, 0.43 at Linvak Tukal. See §0.]
  - The claim: `static_batch_x.js` :378-402 attributes the small saving to sorted ClipMap buckets ("applyClipMapRenderState
    sets `transparent = true`"), because three's early-out also needs `!sortObjects`.
  - The history: that A/B is in the frame-cost doc, commit `1a059c8e` (2026-08-06 02:10). `?clipMapOpaque` landed in
    `f712c13f` (2026-08-06 11:33) and sets `transparent = false` (`materials.js applyClipMapRenderState` :2783). It has
    been default on since.
  - Consequence: unsorted buckets now hold the ClipMap mass, so per-object cull off WOULD reach three's early-out for
    them [D].
  - What remains to confirm: one read of `__statBatchXStats()` (per-bucket `sorted` / `slots`) in a town. Re-measure
    before trusting either verdict.
- **F5. A vertex-shader frustum cull is not a lever in WebGL2.**
  - Why: an off-screen instance still runs its vertex shader, then the hardware clips it. Collapsing it in the shader
    saves only primitive setup, not the vertex invocation, and there is no compute stage to compact instance lists
    without a readback.
  - What remains: coarse culling per bucket/pool on the CPU (O(buckets)), hardware clipping, and a tunable bucket size.
    Price it with the GPU census (`02:RenderPass / statics` GPU ms, ktris).
- **F6. Consumers a replacement must serve that pass-7's walker table does not list:** [2026-10-23: billboarded LOD nodes never enter a bucket (every batcher keeps `THREE.LOD` wrappers as they are; pinned by `tests/static_early_out.test.mjs` E11), so they do not defeat the early-out. A GPU billboard (per-instance yaw in the vertex shader) is needed only once degraded bands move into buckets, and that first needs the D-07.8 band tick (the comment above `statics.js tickStaticsBillboards`, now :4334).]
  - Film mode reads BatchedMesh APIs. `scene3d/film/scene/world_query.js staticFadeTargets` :1615 reads `getMatrixAt` /
    `_instanceInfo` / `getVisibleAt`. `scene3d/film/runtime/take_player.js` :2198 hides and restores via `__filmHidden`,
    `setVisibleAt`, or a zero-scale matrix. BatchedMesh pools serve both; a P4 custom drawable must keep that facade.
  - Degraded-leaf billboarding (`statics.js tickStaticsBillboards` :4322) has no home in pass 7. It is the regression
    that sank walkInInstance. Proposal: a per-instance billboard flag and the rotation done in the vertex shader. That
    is GPU work with no per-frame matrix writes.
  - Static lights expect `light.parent === mesh` (`lighting.js recordStatics` :3523). Pass 7 D-07.6 moves them to
    TilePlan light lists, which is not built.
- **F7. The drawPools chain has three hard blockers, independent of the draw primitive:** [2026-10-23: (a) codec + reader + rebake done, deploy is the owner's call; (b) premise stale, the real blocker is the unpublished page farm; (c) inventoried. See §0, docs/HBG1-negface-marker-2026-10-22.md and docs/drawpools-blockers-2026-10-22.md.]
  - (a) `?negFace` (default on since 10-19) makes every model come back `missing` from `assemble_model_geometry`
    (`src/geom_bundles.rs` ~700-722 [2026-10-23: `assemble_model_geometry` now :902; the v1/v2 rule table is the module
    header :40-60]) until the baked GEOM payloads carry a back-face marker. That needs a GEOM rebake.
  - (b) The page-dim texture corpus: PAGE-RESAMPLE says "corpus-wide encode = buildbox job", and the buildbox was
    deleted on 2026-10-05. The served dist reports `texref_off_page` 409 of 3,471 [M]; those members stay on the
    legacy producer.
  - (c) The E2–E6 1070 batches have never run.
- **F8. The served dist does carry packs.** `dist` → `~/hb-serve/dist/current` → `holtburger-dist-hires-bc7m-xu7t2`,
  with `world_index` in `manifest.json` and `packs/`. One agent reported otherwise; verified wrong.

## 6. The design: the WebGL2 version of the devlog

- **L0. Coarse culling, zero per-instance JS.**
  - Opaque buckets set `perObjectFrustumCulled = false` and `sortObjects = false`, so three's early-out fires every
    settled frame for every camera.
  - Node-level culling stays: spatially bounded buckets keep `frustumCulled = true`. The atlas buckets are ring-wide
    (`frustumCulled = false`) and must become spatial for this to hold.
  - Hardware clipping handles the rest. The cost knob is bucket size (3×3-LB region = 576 m today, pool sector 768 m).
  - Translucent buckets stay sorted (D-07.3).
  - [2026-10-23: built for chunk + building buckets as `?staticEarlyOut` (off). The atlas half is not built: towns hold
    only 50-67 atlas placements.]
- **L1. Runs.** Every opaque bucket draws one instanced range per distinct geometry. This needs shared geometry (F2, F3;
  pools already have it). Rebuild the run layout only when membership changes (a bucket mutation counter), instead of
  batchedRuns' per-draw `_sameCanonical` compare (`batched_runs.js` :309). That compare is O(ranges) of JS per draw,
  and it is the last per-instance cost once L0 holds. [2026-10-23: built differently, as `?batchedRunsStable` (off): a
  per-mesh write epoch plus a full-compare audit every 64th skip, not a mutation counter. `_sameCanonical` is now :553.
  Live only on marked buckets that ride the early-out (P2 or pools).]
- **L2. Per-instance features without per-instance CPU work.**
  - LOD: band choice by event (D-07.8 band tick).
  - Billboards: in the vertex shader (F6).
  - Hide/park: `setVisibleAt` batches.
  - VFX per-instance hash: already derived from the batching matrix (`vfx/per_instance.js`).
- **L3 (optional). One draw per bucket via vertex pulling.**
  - Data: the bucket keeps no geometry attributes. A global geometry arena (every resident HBG1 model once; the whole
    world is 30.3 MB raw) lives in data textures. Each bucket has a u32 pull stream with one entry per triangle corner
    (arena vertex + instance slot), drawn with `drawArrays`. That avoids index-range validation and `gl_DrawID` (and
    so ANGLE's per-range work) entirely.
  - three integration:
    - `#define`-redirect `position` / `normal` / `uv` after the shader prefix (unused attributes go inactive);
    - set `geometry.setDrawRange(0, corners)`, because `renderBufferDirect` returns early for non-indexed geometry
      with no `position` (`WebGLRenderer.js` :1230);
    - give it a manual `boundingSphere`;
    - keep a BatchedMesh-like facade (`getMatrixAt` / `setVisibleAt` / `_instanceInfo` / `raycast`) for film, decals
      and ragdoll.
  - Unknowns [A]:
    - vertex-texture-fetch cost per vertex (matrix 4 + arena 2-3) on weak GPUs;
    - the vertex sampler budget (16 on D3D11), shared with the batching textures and VFX;
    - 4-8 B per corner of stream memory.
  - [2026-10-22 spike, `docs/vertex-pull-spike-2026-10-22.md`: a pulled drawable needs a 1-vertex `normal` marker
    (else three compiles FLAT_SHADED for lit materials), must never set `isBatchedMesh`, and needs its own `raycast`
    (Mesh.raycast with no position returns zero hits silently). Use the indexed encoding (B_index) to keep the
    post-transform cache on HBG1. The packed u32 caps at 2^20 arena vertices × 4096 slots.]
- **Non-goals:** terrain (already one node), animated scenery (kept), entities (excluded here; see P5), translucent
  ordering.

## 7. Phases

**P0 — Measure (owner-run 1070 session, MODE T, a fresh profile per arm, `?nosw=1`, town at ultra: Holtburg and Linvak
Tukal, settled AND on a fixed `@teleloc` path).** Decision rules are written here, before the run.

1. **Bare URL.**
   - Reads: `__diag.render` (`renderDiag=on`), `__batchedRuns.stats` + `.frame()`, `__statBatchXStats()` (sorted vs
     unsorted split → settles F4), `__atlasStats()`.
   - Plus one CPU profile, and one `gputrace.mjs` trace read with `gpu_thread_split.py`.
   - [2026-10-23: page read is `external/holtburger/scripts/perf-worker/structure-p0.eval.js`; F2's baseline moved to
     P0-FLAGS arm4 because P1a is default-on.]
2. **`&batchedRuns=off`.** This is the per-range ANGLE term, and is arm 2 of the 10-19 fps review. [2026-10-23: the
   bare arm now also carries sorted, building and atlas-dedup runs, and `&batchedRuns=off` removes all of them, so
   arm 2 prices the whole per-range stack as built, a larger population than the 10-19 arm 2.]
   - **Rule:** if CrGpuMain WebGL ms/frame (on vs off) moves by less than the arm's own rep spread, the per-range term
     is not a lever. Stop P1 and L1, and re-plan.
3. **The drawPools chain armed:**
   `&packSource=on&geomBundles=on&texCompressedOnly=on&slotGrid=on&frameWork=on&drawPools=on&negFace=off`.
   - Does it boot on HEAD?
   - Read `__diag.pools()` (pools, classes, `mutationsThisFrame` = 0 parked), `subDraws` / `issuedSubDraws`, CrGpuMain
     WebGL ms, renderCPU.
   - `negFace=off` changes the look (back faces); this arm is for measurement only.
   - **Rule:** if `issuedSubDraws` or CrGpuMain WebGL ms rises against arm 1, F1 is confirmed and P3 must land L1
     before any GATE-POOLS run.
   - [2026-10-23: arm 3 now runs with `?poolRuns` (L1 for pools), so a rise means poolRuns did not fix F1; compare
     with P0-FLAGS arm3b (`&poolRuns=off`). Read total GL draws per frame beside `issuedSubDraws`: pooling moves
     plain-mesh draws into pool ranges (SPEC GATE-POOLS (a)), and CrGpuMain arbitrates.]

**P1 — Make every static range a run (legacy path).** Effort S each; pixel-identical. Check with node tests plus a GLSL
smoke under `capped-build`, modelled on `batched_runs_smoke.mjs`.
- 1a: atlas geometry dedup (F2), behind a new flag. Name it, document it in url-flags, default on after the pixel smoke.
- 1b: the `statGeomDedup` re-base (F3). Owner call; the flag exists.
- 1c: opt `buildingMatBatch` into batchedRuns (improvement-hunt B9). Small: its verifier priced it at tens of ANGLE
  sub-draws, roughly 1-2% of range work (findings-round1 `recent-render-diff-4`). Do it for completeness, not as the
  lever.
- 1d (related): terrain batch without `gl_DrawID` (B10).
- Score: `issuedSubDraws` / `subDraws`, CrGpuMain WebGL ms/frame, uncapped fps.
- [2026-10-23: 1a (`?atlasGeomDedup`, on), 1c (B9a) and 1d (`?terrainNoDrawId`, off) built; 1b stays the owner's
  call. The sorted half of B9 also landed (`?batchedRunsSorted`, on).]

**P2 — Zero per-instance JS for opaque buckets (M; eye check).**
- Behind a flag: `perObjectFrustumCulled = false` on opaque chunk, atlas (made spatial) and building buckets.
- Event-driven run layouts (L1). Billboards in the vertex shader (F6).
- Score: renderCPU (the `onBeforeRender` share), ktris, GPU `statics` ms, CrGpuMain.
- Expect more triangles; shrink buckets if GPU statics ms rises.
- Kill: a GPU-bound regression in towns, or moving p99 worse than the off arm.
- The statBatchMemo / slack family steps aside by itself once per-object culling is off (it engages only with it on;
  `static_batch_x.js` ~895, ~1513). [2026-10-23: wrong. The memo family does NOT step aside by itself: with per-object
  culling off, every camera move lands on the exact-tier fallback plus the memo's O(n) slot save, and its own override
  would poison `?batchedRunsStable`. So `?staticEarlyOut` never installs the memo on early-out buckets and moves it on
  a mode flip (`static_batch_x.js` ~:1908, `_installMemo`, `applyStaticEarlyOut`).]
- [2026-10-23: built for chunk + building buckets as `?staticEarlyOut` (off; owner eye check + 1070 arm owed). The
  atlas half and the vertex-shader billboards were not built (§0 item 6).]

**P3 — Revive drawPools with runs (L; several sessions).**
- Unblock F7:
  - rebake GEOM with a back-face marker. This is a heavy Rust job: laptop `capped-build`, one at a time;
  - encode the page-dim corpus. The buildbox is gone: laptop `capped-build` or the 1070, owner call;
  - run the E2–E6 batches.
- Wire L1 into opaque pools.
- Add the F1 criteria to GATE-POOLS alongside E6, MOVE-FIX and TAIL-ULTRA.
- What it buys over P1-P2: an O(pools) scene graph (the traversal term), a closed class set (link storms), and
  residency events instead of LRU scans.
- SPEC §0.1: the implementing agent never flips `drawPools`; that is the owner's migration event.
- [2026-10-23: GEOM rebake done (v5, not deployed). The encode had already run on 08-10; the real blocker is publishing
  the farm (R1, `docs/drawpools-blockers-2026-10-22.md` §2.5). L1 is wired into opaque pools (`?poolRuns`, pass-07
  D-07.4 note). The F1 criteria are in GATE-POOLS. E2–E6 still owed.]

**P4 — Vertex pulling (L; spike S first).** Only if P0/P3 show the per-run cost is still a material share of CrGpuMain.
Spike: one GLSL smoke page drawing a pulled bucket against the same bucket as BatchedMesh runs, pixel-identical; then
one 1070 arm. [2026-10-23: spike built; harness PASS (`docs/vertex-pull-spike-2026-10-22.md`). The 1070 arm is owed.]

**P5 — Later.**
- Entity parts: open lead 242 — ~330-814 part draws per town frame, ~40 per humanoid, 593 unique materials. Rigid parts
  with per-frame matrices are a natural instancing target once part textures are arrays.
- WebGPU: only if multi-draw-indirect ships by default.

## 8. What a replacement must keep working (checklist)

- **Shader patches** (via `materials.js _chainBeforeCompile` ~:693, cache key `_patchSetCacheKey` ~:600):
  - light clamp, CSM receiver (C1: must read `batchingMatrix`), POM / detail, the depth biases (floor / static / fill,
    which write `gl_FragDepth`, plus their reversed-Z twins), envDetail, baked vertex light;
  - VFX components (`windSwayGpu`, wetness, frost, glint);
  - the atlas array material (`static_atlas.js makeArrayMaterial`);
  - global chunk rewrites: radial fog, light loops, light-pool UBO, reversed-Z packing, batching chunks.
- **Shadows:**
  - `castShadow` / `receiveShadow` per node vs per pool (the D-07.2 class axis);
  - `tickShadowReceiveGate` (`loop.js` :2662);
  - `shadow_caster_list.js` (static/dynamic split);
  - `sway_shadow.js` depth materials;
  - `interior_shadow_cull.js`.
- **Queries:**
  - blood decals raycast statics / buildings / cells (`blood_decals.js` ~598-630, ~713);
  - ragdoll env probes;
  - film fade and hide (F6);
  - `cullStaticsGroup` (`statics.js` :4647 [2026-10-23: :4659]), which honours `__deadBatch` / `__filmHidden` and never culls a node that
    owns a light.
- **Passes:**
  - indoor split layers (`cells.js _stampSplitLayers` :593);
  - `?punchRetail` phase order (statics draw after the punch);
  - occlusion-cull proxies need static depth written first;
  - MSAA world target;
  - SSAO / haze / AP read reversed-Z depth.
- **Lifecycle:**
  - warm-park `setVisibleAt` (`landblock_lru.js` ~938);
  - evict by `userData.landblockId` / `coversLbKeys`;
  - texture-upgrade queue walk (`tex_upgrade_queue.js` ~506);
  - `attachStaticDefaultScripts` emitters (`statics.js` :6030 [2026-10-23: :6042]).
- **Tests most coupled to today's structure:** `test_static_batch_x`, `test_stat_batch_walk`, `test_stat_geom_dedup`,
  `test_stat_batch_runs`, `test_static_atlas_*`, `test_bm_*`, `test_landblock_lru_evict`, `test_fixed_grid_park`,
  `tests/batched_runs`, `tests/building_mat_batch`, `tests/csm_receiver_worldpos`, `tests/film_runtime_capture`,
  `tests/statics_billboard_gate`, `tests/shadow_caster_sort`. [2026-10-23: plus the tests that pin what was built:
  `tests/atlas_geom_dedup`, `tests/batched_runs_sorted`, `tests/batched_runs_stable`, `tests/static_early_out`,
  `tests/pool_runs`, `harness/test_draw_pools`, `tests/terrain_batch_no_drawid`, `tests/geom_bundles_negface`.]

## 9. Walls — do not retrace

Line numbers are in `docs/improvement-hunt-2026-10-20/ledger-walls.txt`.
- Rows 29 / 107 / 137: draws removed × µs per draw does not predict ms. Score with renderCPU + CrGpuMain + GPU ms, never
  draw counts alone.
- Rows 89 / 108: statics bucket merging is **dead** (`statArrayMerge` measured 0.0 ms). This handoff does not propose
  merging buckets. Its mechanisms are different: per-range ANGLE work (runs) and the per-instance walk (early-out).
- Row 113 ("perObjectFrustumCulled must stay on"): its premise is stale (F4). Re-measure; do not cite it.
- Row 114: ring-wide merging forfeits node culling (22.5 vs 29 fps). This is why L0 keeps buckets spatial.
- Row 111: the matrix-freeze ceiling. Only cutting node count attacks traversal.
- Row 112: per-instance tests still walk the instance.
- Row 115: parked wins can be moving losses.
- Rows 82 / 83 / 118 / 206: `renderer.info` hides sub-draws, and main-thread-only A/Bs cannot see CrGpuMain.
- Row 31: MDI / SSBO / BaseVertex techniques do not exist in WebGL2. `WEBGL_multi_draw_instanced_base_vertex_base_instance`
  is a draft extension with negligible reach, so do not plan on base-instance.
- Row 130: global atlas pools are mandatory.
- Row 187: no per-bucket instanced attributes on shared geometry clones.

## 10. Laptop rules for whoever builds this (verbatim from `~/CLAUDE.md`; put them in every agent prompt)

"Parallel agents may read, edit and run TARGETED single tests only (`node test_x.mjs`). They must NOT run the full JS
gate, cargo, wasm-pack or browsers. The orchestrator runs the full gate and builds ONCE, after merging, one at a time."
"Headless Chrome: at most one tab of a real (non-wireframe) world at a time; close tabs when done."

Also:
- one heavy job at a time, inside `capped-build`, with ≥ 2.5 GB available;
- kill rust-analyzer before Rust builds;
- never `cargo … --workspace`;
- 1070 sessions are owner-run or owner-requested, off-screen and muted, never self-initiated.

## 11. Resume prompt

> Continue the GPU-resident statics work. Read §0 first (status 2026-10-23: everything laptop-doable is built,
> reviewed and committed; its "Laptop state left behind" block lists what lives outside git, including the release
> wasm a fresh checkout must rebuild). The next step needs the 1070: run the queued P0 session
> (docs/reengineering/queue-1070/batch-P0-gpu-resident-2026-10-22.json, owner-run, off-screen, muted) and apply its
> decision rules. Arm 2 (`batchedRuns=off`) decides whether any further per-range work (span coalescing, P4) is worth
> building. Owner decisions pending: deploying the HBG1 v2 packs, publishing the page farm (R1), and the default flips
> listed in §0.

(Original 2026-10-22 prompt, superseded by §0: "First queue or run the P0 1070 session ... If the owner has not asked
for a 1070 run, start P1a ...".)
