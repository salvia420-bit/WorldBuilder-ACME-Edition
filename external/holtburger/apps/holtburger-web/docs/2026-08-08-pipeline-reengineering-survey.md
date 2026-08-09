# Pipeline re-engineering survey — 2026-08-08

Full-pipeline map (bake → wire → Rust → JS → three.js → frame) plus the verdict on whether
the current pipeline is already at its ceiling. Compiled from two very-thorough code explorations
anchored at the wasm↔JS boundary (one walking up to the screen, one down to disk) and a complete
mining of the 2026-08-01→08-08 commit record and every perf handoff doc. Load-bearing claims
spot-verified in code on HEAD `a6ccc278`. Companion reading: `2026-08-06-frame-cost-structure-measured.md`
(the frame), `2026-08-06-p99-stall-attribution.md` (the tail), `2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md`
(memory), and the attempt ledger embedded in §6 below.

## 1. The question asked

After remacri (t1024 terrain BC7 + the 2,931-static XUBC7 corpus, landed 08-04/05), performance
fell. Days of agent sessions tried to claw metrics back inside the existing pipeline; most attempts
came back marginal, inert, or killed. Is the pipeline already the best that can exist, or is there
a re-engineering with real headroom?

**Verdict: the existing *shape* is at (or within ~10-15% of) its local optimum — the record proves
it — but the shape itself leaves multiples on the table in every metric.** Every remaining large
gain requires breaking one of five architectural invariants, none of which is load-bearing for
correctness. They were each chosen for incremental shippability, and each now has a measured cost
that no flag-level change can reclaim. The evidence is the attempt record itself: 45+ attempts in
one week, and every one that respected the invariants topped out at ≤4 ms or 0, while the ones
that shipped real wins (bake worker, release wasm, animSceneryInstanced, atlas grow-on-demand,
shaderPrewarm) each broke a structural assumption.

## 2. The pipeline as built (condensed, verified)

### Offline (bake)
`apps/holtburger-tools` `dat-shard`: DATs + HBA → **894,966 content-addressed per-record shards**
(6.46 GB dist), truncated-sha16 names, per-namespace binary catalogs, a 2.0 MB `boot.hba`
(transitive dep walk of the spawn neighborhood — the bake CAN walk dependencies offline, it just
only does it for boot), plus three **parallel full-corpus texture tracks** keyed by rsId:
tex-bc7 2,518 MB / tex-xu7 2,353 MB / tex-bc7-pre 157 MB (6.3% previews). Terrain BC7 is a
separate static-asset track (t1024 = 78 MB, 29 rsIds × color+nra, 11-level HBC7 v2).
Side-trees per LB: scenery/spawns/events JSONL + suite bins (3-4 more GETs per LB key).

### Wire
- One `manifest.json` (648 B) → `boot.hba` (2.0 MB, whole-pack sha256) → namespace catalogs on
  first touch. **`eor-cell.bin` = 15.35 MB, gzip ratio 0.955** (16 B raw sha per entry ≈
  incompressible), fetched blocking, all-or-nothing, before the first landblock record.
- **Strictly one HTTP GET per record.** No batching, no ranges, no LB bundles.
  `eor/cell` = 805k records averaging 261 B; Surface = 24 B, SurfaceTexture = 19 B, each a full
  round trip. A default ring (11×11 LBs) is ≥363 tiny cell GETs before any model. Cold boot ≈
  1,700 requests; per-shard sha256 verify default-ON (measured 71% of main-thread in one
  large-ring probe — redundant next to catalog CRC + immutable content addressing).
- Dependency discovery is **decode-as-discovery**: `run_walk_loop` re-runs the full decode per
  wave (≤8 waves, typical 2-4), so Surface→SurfaceTexture→Texture→Palette costs ≥4 serialized
  RTT waves to move ~55 KB.
- Two wasm instances (main + bake worker) each hold their own catalogs (~19 MB parsed for
  eor/cell alone), shard cache (unbounded by default; ~58+21 MB after four towns), and fetch pools.

### Rust decode
`triangulate_model` → `pack_model_mesh`: 64 MiB completeness-gated tri memo whose **hits deep-copy
the whole `Vec<Tri>`** (lib.rs:9291); substitution-bearing models (all equipment) never memoize;
`resolve_did_degrade` re-parses the same records a second time; output is **de-indexed**
(9+6+9 floats/tri) and every bindgen getter clones. Terrain neighbor-ring stitching touches each
252 B terrain record up to 5×; `fetch_terrain_textures` re-resolves the fixed Region→33-surface
mapping on every call.

### JS texture path (the remacri-era cost center)
- **Two-codec double-build:** every surface is decoded RGBA8 → uploaded with driver mipgen →
  then re-fetched as BC7/XU7 → transcoded → re-uploaded → RGBA8 discarded (fail-soft frame-1).
  ~1.3 GB of live CPU-side texture mirrors is the direct consequence (heap OOM near 2.8 GB).
- **All compressed-texture work is main-thread by construction** — the bake worker has zero
  bc7/xu7 code. XU7 transcode ≈32 ms/1024², indivisible; `?xu7Budget` spreads bursts but cannot
  split an item. The 1.04 MB basis transcoder loads per JS context.
- Terrain t1024: 88 MiB alloc+memcpy assembled synchronously in one task at ring-resolve.
- Cross-LB atlas: level-0-only arrays (no mips/aniso — singletons of the same surface get the
  full chain + aniso 16); `__bc7Pending` deferral held **79% of props out** with no re-feed hook.

### Scene / frame (1070, quality mid, parked Nanto — post-08-06 defaults)
~20.2 ms p50 / 49.5 fps, ~436 draws. **CPU-bound and not close** (renderScale 8.2× sweep moved
p50 25.8→26.3 ms). Structure of the reference 24.22 ms frame: draw funnel 12.78 ms at
**37.6 µs fixed/draw, r²=0.014 vs instance count**, 71% of draws switch material;
BatchedMesh multidraw rebuild 5.72 ms over ~13k instances (now memoized parked, −4.00 ms;
moving case unmeasured); traversal remainder ~3.6 ms over ~4.4k nodes (340-450 ns/node,
ignores `visible`; matrix freeze ceiling measured 0.48 ms). Tail: was p99 1,630 ms; sync shader
links (172-849 ms each) fixed by shaderPrewarm (MAX 2131→369 ms); remaining tail = transcode
bursts (budgeted, unproven live), park-pool governor draining its own cache, atlas grows.

## 3. Why "remacri killed FPS" is the wrong frame

Measured (`1a059c8e`): the frame is CPU-bound; remacri's GPU-side costs (t1024, MSAA 2x,
aniso 16) do not price into mean frame time. Remacri is heavy in **wire** (terrain 81 vs 20 MB
first visit; corpus +2.35 GB), **heap** (fatter CPU mirrors on an already RGBA8-heavy path),
**VRAM pressure** (7 context losses/session), and **tail stalls** (main-thread transcodes it
made default-on). The mean-frame regression window was substantially stalls dragging averages
plus session variance. Any re-engineering brief that says "make remacri fast" should read:
**make the wire cheap, the decode off-thread/off-line, and the memory resident-by-construction.**

## 4. The five invariants and what each costs

| # | Invariant (as-built) | Measured cost | What breaking it buys |
|---|---|---|---|
| I1 | **Per-record HTTP addressing + runtime decode-as-discovery** | 15.35 MB blocking catalog; 1,700-request boots; ≥4 RTT waves per material chain; 8-round walk loops re-decoding each round; sha256/shard at 71% main-thread in probes | LB-closure bundles baked offline (the boot.hba walk generalized): cold town in dozens of requests, catalogs shrink to bundle indexes, discovery loop deleted, verify amortized per-bundle |
| I2 | **Runtime triangulation, de-indexed, clone-across-boundary** | decode-once was worth 25× longtask reduction when memoized; hits still deep-copy; unindexed = 3× vertex bytes, no post-transform cache; JS re-buckets scalar-wise; degrade DID re-parse | Offline pre-triangulated, **indexed**, GPU-ready buffers per model (the 07-01 roadmap endpoint); wasm hands transferable views; JS uploads without reshaping |
| I3 | **RGBA8-first, compressed-second (fail-soft double-build)** | 2× decode + 2× upload per surface; ~1.3 GB CPU mirrors; 32 ms main-thread transcodes; atlas format bifurcation + 79% deferral | Compressed-only runtime path: preview tier (already baked, 6.3%) is the frame-1 fallback instead of RGBA8; transcode in a worker or ship BC7 wire; CPU mirrors become 8 bpp or freed (texFreeCpu seam already built) |
| I4 | **Per-LB rebuild residency (stream→bake→bulk-evict)** | re-decode + re-bake churn on every crossing; governor drains its own warm pool; geometry counter never decrements; bucket fragmentation feeds the 37.6 µs/draw wall | Retail shape (designed `PLAN-fixed-slot-grid-residency-2026-07-11`, never built): fixed player-centered slot grid, edge-only churn, refcounted Rust resource cache with UseTime floor — memory bounded by construction, draws stable across moves |
| I5 | **Per-(LB,surface)/per-bucket draw granularity + per-placement scene nodes** | 37.6 µs *fixed* per draw (r²=0.014); 71% material switches; ~3.6 ms traversal of ~4.4k mostly-inert nodes; merging resident-culled buckets measured 0.0 ms | Persistent material-class multidraw pools over the resident set (not per-LB), unified material keys, and a scene graph with O(pools) nodes instead of O(placements) |

## 5. Re-engineering shape (two workstreams, one bake)

**W1 — the bake owns the world (kills I1, I2, feeds I3).** One offline pass already walks
dependency closures; generalize it: per-landblock (or 2×2 tile) packs containing the closure's
records — pre-triangulated indexed geometry, scenery/spawns/events folded in, texture *references*
into shared corpus packs, preview mips inline. Client fetch = manifest + spatial index + N packs.
Deletes: walk loop, catalogs-as-blocking-cost, per-record GETs, per-shard sha, most of the Rust
discovery machinery. Download metric moves from ~1,700 requests / ~25 MB floor + 81 MB terrain
to a handful of range-friendly packs; previews make first-pixel a fraction of that.

**W2 — the client owns residency, not landblocks (kills I4, I5, finishes I3).** Slot-grid
residency in Rust (retail LScape shape) + refcounted decoded-resource cache; persistent
per-material-class GPU pools that absorb/release at grid edges instead of per-LB
build/evict; compressed-only textures with worker-side transcode and atlas arrays carrying
full mip chains. Frame metric attacks the two real walls at their scale: fixed per-draw cost
(fewer, stable, submitted draws) and traversal (node count), which no in-shape flag reached.

Sequencing note: W1 is pure-additive (new dist format beside the old; client gains a pack-aware
resource source behind the existing `ResourceSource` trait) and de-risks W2. W2's slot grid was
already fully designed on 07-11.

## 6. What not to redo (the walls, so the next session doesn't re-run them)

Full attempt ledger with verdicts is in the 08-08 session record; headlines that MUST constrain
any new design:
- Resident ≠ drawn ≠ submitted — four ~2× scale errors in one day; every figure states its scale.
- draws-removed × µs/draw does NOT predict wins; removable draws are the cheap ones
  (`?statArrayMerge`: −23 draws = 0.0 ms, DONE AND DEAD — reopen only on a new mechanism).
- Draw *count* is a poor proxy (−12.1% draws = −2.8% frame; −63% draws = −10.5% CPU).
- Parked wins can be moving losses (statBatchMemo exact tier); moving numbers need the
  fixed-pose bench (`e0448f1f`).
- three's per-object glue is 70.7 ns — framework-overhead theories are dead; costs live at
  instance scale and per-draw state validation.
- Matrix freezing ceilings at 0.48 ms; only node-count reduction attacks traversal.
- GPU-side theories die on a CPU-bound frame — re-check boundedness after any big change.
- Allocated ≠ used (1,941 vs 112 atlas layers; BatchedMesh position.count phantom).
- Boot-to-boot variance swamps <1 ms effects; interleave arms within a session; never reuse
  a Chrome process across arms (2.44× drift).
- Flag bits are not predicates (ClipMap eye-test failure was invisible to every metric);
  structural render changes need eye-tests.
- Propagate verdicts to the docs agents read, same day — three full research cycles were
  spent this window re-deriving already-dead leads.

## 7. Open in-shape leads (cheap, still worth taking regardless of re-engineering)

Ranked by the record: statBatchMemo moving A/B on the fixed-pose bench; xu7Budget 1070
validation (or removal); BC7 array mip fix (render-visible, both sites documented);
NRA→BC5/BC7 bake (~113 MB); texFreeCpu ABAB then arm; CSM depth-variant explicit warm;
park-pool governor floor fix; ptBc7Deferred re-feed (correctness, ~0.6 ms only);
XUBC7 lossy tier decision (q75 = 38% of raw — the remaining big wire lever inside the
current shape); node-count reduction survey.
