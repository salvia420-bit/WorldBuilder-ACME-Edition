# Pass 08 — Frame loop and scheduling: phase order, worker topology & message contracts, upload budgets, stall-prevention, tail targets

Pass 8 of 12. Governed by `TRACKING.md`'s protocol header. This pass fixes the frame:
the normative phase order that hosts every prior pass's per-frame obligations
(pass 6's grid events and drains, pass 7's feeds and flips, pass 5's uploads and
transcode results, pass 3's fetch completions); the complete worker census with every
message kind, payload, transferable and backpressure rule; the GPU upload scheduler
(when `texSubImage`/`bufferData`-class work may run, with per-class byte/ms budgets);
the stall-prevention integration (boot class-census prewarm including the CSM
depth-variant warm that `renderer.compile` cannot reach); and the tail (p99) design
ledger — for each ranked stall class, the mechanism that bounds it and the residual
worst case with arithmetic. Source classes per R7: **[M]** measured (doc named),
**[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; F/M-series,
  D-01.5 derivation prohibition, D-01.8 non-goals, S3 priority).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; D-03.3/D-03.5,
  S1.1 controller API, S2 scheduler).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; D-04.5 bundle ABI,
  H-04.4 upload handoff, S1 size caps).
- `docs/reengineering/pass-05-texture-spec.md` — lines 1–768 (all; D-05.4 worker + S3
  contract, D-05.6 array policy, H-05.3 upload handoff).
- `docs/reengineering/pass-06-residency-architecture.md` — lines 1–686 (all; D-06.3
  state machine, D-06.6 ladder, D-06.8 topology + leases, H-06.2 phase-order handoff).
- `docs/reengineering/pass-07-scene-and-draw-architecture.md` — lines 1–795 (all; D-07.4
  early-out, D-07.5 feed contract, D-07.9 closed class set, S2 transition table, H-07.1).
- `docs/2026-08-06-p99-stall-attribution.md` — lines 1–431 (all): ranked causes #1–#7,
  probe method, fix sketches (incl. the depth-variant warm sketch at 379–389).
- `scene3d/index.js` — lines 2180–2600: `scheduleNext` pacer (2180–2196), `syncTickHop`
  (2203–2241), async `tick` (2251–2600): dt clamp/recovery (2259–2276), awaited hop
  (2280–2283), `frameTime` stamp (2291–2295), `tickPerFrame` call (2297), moons/audio
  (2304–2353), LRU `tickEviction` + spawn-flush + lodRebake + entity reaper
  (2359–2391), ambient (2398–2408), composer render + cloud pre/post + `recordRenderDiag`
  (2440–2469), `scheduleNext` placement (2467, 2490), `nullRender` skip (2485–2492),
  direct-path split + F4 re-arm invariant (2521–2578).
- `scene3d/loop.js` — lines 2150–2305 (RP3 header: budget 9 ms default at 2196, deferHz
  10 at 2197, `RP3_MAX_DEFER_FRAMES = 3` at 2202, groups PVS/SKY/NAME 2253–2255, gate
  algorithm 2275–2295), 2306–2908 (`tickPerFrame` complete: CRITICAL #0 net pump
  2307–2345, RP3 clock discipline 2346–2364, #1 cell visibility 2373–2384, #1.5 frustum
  cull 2385–2396, DEFERRABLE #2 PVS + compaction ticks + farRing 2397–2438, uTime/VFX
  clocks 2443–2499, SKY group #4+#7–#12 2500–2707, CRITICAL #5 lighting 2525–2538,
  shadow-receive gate 2554–2571, CRITICAL #13 camera/input 2708–2724, CRITICAL
  #15/#16/#19 entity block 2740–2813, A11-S3 particle managers 2814–2845, DEFERRABLE
  #20 nameplates 2854–2885, selection brackets 2886–2907).
- `scene3d/shader_prewarm.js` — lines 1–252 (all): default-ON flip + measured A/B
  (65–90: MAX 2131 → 369 ms, n=1 caveat), `withWarmTarget` (117–143), 1×1 HalfFloat
  warm target (93–104), link probe (166–252).
- `scene3d/bake_prewarm.js` — lines 1–260 (all): `BAKE_PREWARM` default-ON (27–34),
  `guardedCompileAsync` (50–83), `prewarmSubtree` (95–106), archetype warm + park-never-
  dispose refcount rule (166–260).
- `scene3d/stall_probe.js` — lines 1–100 (method, bucket table, renderMs/outsideMs
  split, cost pricing).
- `scene3d/xu7_textures.js` — lines 94–183 (budget default-ON, 6 ms default at 125,
  stats fields), 244–256 (drain scheduling: rAF + hidden-tab guard timer), 300–365
  (`_drain`: budget bounds the batch not the item; always-run-one), 367–380.
- `scene3d/bc7_textures.js` — lines 330–398 (`makeBc7ArrayTexture` level-0-only,
  `writeBc7ArrayLayer` → `addLayerUpdate` → one `compressedTexSubImage3D`).
- `scene3d/terrain_bc7.js` — lines 444–510 (`buildTerrainBc7Array`: level-major
  assembly, `needsUpdate = true` at 500 — upload deferred to first bind in render).
- `scene3d/atmosphere_pipeline.js` — composer construction and pass chain (513–539
  HalfFloat + `multisampling`; 611–806 sky/world/cells RenderPasses + mask/depth-clear
  passes; 852–940 tone-mapping/dithering/bloom/vignette EffectPass) via targeted reads.
- Budget-family sites (each read at its line): `statics.js:2233, 3052`
  (`STATICS_BUILD_BUDGET_MS = 6`), `cells.js:917` (`ENVCELL_BUILD_BUDGET_MS = 6`),
  `buildings.js:178` (`BUILDINGS_RING_BUILD_BUDGET_MS = 6`), `landblock_lru.js:44, 356`
  (`SEALED_STEADY_BUDGET_MS = 6`, `PARK_DISPOSE_BUDGET_MS = 6`), `xu7_textures.js:125`.
- Worker census sources: `scene3d/bake_worker_client.js` (795 `new Worker`, 839 init
  request, 930/967 postMessage), `scene3d/bake_worker.js` (276–324 message switch:
  init / fetchModelMeshes / fetchSurfacesPixels / fetchEntitySurfacesPixels(+Batch) /
  datDecodeDiag / wasmMemCensus; replies 209–268), `scene3d/net_worker_client.js`
  (1–60: tx/rx/disconnect/error/ready protocol; **"Default: DISABLED. Enable per-session
  with `?netWorker=1`"** at line 20; the s15 decision comment "stays false — netWorker
  is NOT promoted" at 58–60), `scene3d/keepalive_worker_client.js` (1–43: default-ON
  timer worker), `scene3d/keepalive_worker.js:6` ("holds NO wasm and NO socket").
- three r184 (the pinned build, `index.html:969` importmap → three@0.184.0; fetched and
  read this session): `this.initTexture` (three.module.js:19465–19487 — explicitly
  handles `isCompressedArrayTexture` via `setTexture2DArray`), `this.compile` /
  `compileAsync` (17312, 17419 — scene materials only; no shadow-material walk),
  program-parameter `batching: IS_BATCHEDMESH` derived from the OBJECT (7497, 7578),
  `getDepthMaterial` per (object, material, light, type) (9454, 9569, 9583). Public
  renderer surface has NO buffer/geometry equivalent of `initTexture` (grep over the
  build: compile/compileAsync/initTexture only).

## Decisions

### D-08.1 — The frame keeps one async rAF driver; physics `syncTickHop` stays, awaited, as phase P0

The single-driver shape is kept: one `requestAnimationFrame` tick (with the
`?targetFps` pacer, index.js:2180–2196), re-armed only by `scheduleNext()` at every
exit (the F4 invariant, index.js:2543–2550), with the `?netDrainHz` interval and
`__renderOnce` as alternate drivers of `tickPerFrame` (bot modes). **`syncTickHop`
stays exactly as built** — enqueue `handle.tickMovement()`, hop one microtask so the
wasm integration + pose publish complete before this frame's pose reads
(index.js:2203–2241, awaited at 2280–2283).

**Scope statement (the charge's explicit question, answered honestly):** pass 1's
non-goals (D-01.8 N1–N8) do not name client physics; what puts it out of scope is the
charter's mission boundary itself — the re-engineering program is defined over
invariants I1–I5 and workstreams W1/W2 (survey §4–5), none of which touches the sim,
and no F/M/B/C budget prices physics. Moving wasm physics off-main would change the
one-microtask pose-coherence contract A1-O3 established and is a different program.
Its budget slot is P0 (S1), priced [A] pending pass 10's phase census.

**Alternate-driver discipline is normative:** every new per-frame system this pass
introduces (the work scheduler, upload stager) MUST use the live monotonic clock
pattern (`_rp3NowMs` shape, loop.js:2346–2364) and never `scene3d.frameTime.tsSec` —
frameTime freezes under `?renderOnDemand=1` and the net-drain driver, which is exactly
the starvation defect RP3's clock note documents. The net pump (CRITICAL #0,
loop.js:2307–2345) and its dt-independence guard are untouched.

*Rejected:* moving physics into a worker (out of scope, above); dropping the awaited
hop for a fire-and-forget enqueue (re-opens the pose-lag class A1-O3 closed;
re-entrancy safety currently rests on the loop re-arming only at tick end,
index.js:2242–2250).

### D-08.2 — Phase order: SIM → RESIDENCY → WORLD TICKS → RENDER → STREAM SLOT; all streaming/upload work moves into ONE post-render budgeted slot

Normative order in S1. The structural change versus today: the rAF task currently
ends with render submission after running LRU eviction inline (index.js:2359–2391,
outside any budget — the p99 doc's #3 placement note), while bake/feed/transcode work
runs in uncoordinated `setTimeout(0)`/rAF-scheduled tasks BETWEEN frames, each with
its own private 6 ms budget (the six read-verified sites in Inputs; today's worst case
is additive — five budget families can each spend 6 ms around one frame with no
shared accounting). The new frame:

1. **P0 SIM** — net/input pump + `syncTickHop` (never gated).
2. **P1 RESIDENCY** — pass 6 grid update: pose → anchor check → emit
   `onShift`/`onTeleport`/`onSlotState`; `controller.setPlayerTile()`; the 1 Hz
   ladder sampler (pass 6 S4.3) lives here. Event-driven: a settled frame does one
   anchor compare and exits (the `poolMutationsPerFrame = 0` invariant, pass 7 S2).
3. **P2 WORLD TICKS** — `tickPerFrame` essentially as built: CRITICAL phases
   unconditional (#0 pump, #1 cell visibility, #1.5 frustum cull, #5 lighting, #13
   camera/input, #15/#16/#19 entity block, A11-S3 particles), RP3-gated deferrables
   (PVS-successor, SKY, NAME) with today's constants (budget 9 ms, ~10 Hz, force-run
   at 3 skips — loop.js:2196–2202). Pass 7's band tick and PVS-renderSet flips run
   here as event/throttled items (they are scene-consistency work, not streaming).
4. **P3 RENDER** — composer render, unchanged shape (atmosphere pipeline: HalfFloat +
   MSAA composer, sky/world/cells RenderPasses + fx tail, atmosphere_pipeline.js:
   513–539, 611–806, 852+; direct path for the pre-bake window/`?wireframe`). All
   pending GPU uploads staged in earlier frames' P4 are consumed by the driver here.
5. **P4 STREAM SLOT** — the `FrameWorkScheduler` (D-08.3): pool feeds, staged GPU
   uploads, park/release drains, pressure-ladder actions, worker-result integration,
   legacy budget families during migration. ONE global budget (default 6 ms steady
   [A]); runs after `scheduleNext()`'s bookkeeping equivalent — i.e., inside the same
   rAF task, after render submission.

**Why post-render for P4** (the placement decision pass 6 H-06.2 asked for): (a) it
cannot add latency to input→photon — P0–P3 are done; (b) uploads staged in P4 are
consumed at next frame's P3, giving a clean "nothing drawn in the frame its bytes
were staged" rule (D-08.5); (c) the render submission's driver-side work overlaps the
slot's CPU work at zero design cost; (d) it makes the budget honest — P4 sees how
much of the frame P0–P3 actually spent and can shrink (S2 rule 4) instead of blindly
stacking on a heavy frame, which is precisely what today's between-frames tasks
cannot do. *Rejected:* pre-render slot (uploads staged then drawn same-frame forces
mid-frame driver validation; and a budget set before render cannot react to render
cost); keeping between-frames `setTimeout(0)` tasks as the home (invisible to any
frame budget — the additive-6 ms problem; also the netDrainHz driver has no
between-frames), splitting the slot across both ends (two accounting points, no
benefit named).

**What leaves the frame entirely:** LRU `tickEviction` + its inline scan
(index.js:2359–2391) — replaced by grid events (P1) + budgeted drains (P4), per
pass 6 S6; the PVS-group compaction ticks (`tickStatAtlasOptimize` /
`tickStatBatchXOptimize` / `tickTerrainBatchOptimize`, loop.js:2412–2421) — replaced
by the pool `optimize()` work class in P4 (pass 7 D-07.5). Retained P2-adjacent
smalls (moons, audio listener sync, ambient roller, spawn-flush compare) keep their
current homes — none has a measured cost worth moving.

### D-08.3 — `FrameWorkScheduler`: one budget, priority classes, always-run-one, per-class staleness ceilings; the additive 6 ms family collapses into it

New module `scene3d/frame_work.js`. It generalizes the two proven local shapes —
RP3's gate (throttle + budget + force-run-at-staleness, loop.js:2275–2295) and the
xu7 drain (budget bounds the BATCH not the item; always run one; re-schedule if work
remains, xu7_textures.js:320–365) — into one scheduler with work classes:

| class (priority order) | work items | largest single item (bound) |
|---|---|---|
| W1 URGENT | player-blocking: current-tile feed, interior feed on entry, teleport-seed feeds | one pool feed batch op (S2 rule 5) |
| W2 UPLOAD | staged GPU texture uploads (D-08.5): `initTexture` calls, chunked layer re-marks | one texture ≤ 5.6 MiB chain (2048², pass 5 S1.5) [D] |
| W3 FEED | STAGED→LIVE TilePlan feeds (pass 7 S2): geometry ensure + addInstance + matrices + membership records; LIVE flip last | one `addGeometry` copy ≤ 256 KiB payload (pass 4 S1 SHOULD-cap) |
| W4 RELEASE | park drains (≤1 tile), PARKED→EMPTY deletes, pool `optimize()` compaction, empty-bucket GC | one tile's deletes (amortized, pass 6/7) |
| W5 LADDER | pressure-ladder rung actions (demotes, budget shrinks) when engaged | one demote (texture re-point) |
| W6 LEGACY | migration-era families: legacy statics/cells/buildings build loops, xu7 main-thread fallback drain, legacy LRU drains | one 1024² fallback transcode ≈ 32 ms [M, xu7_textures.js:119] — fallback mode only |

Rules (normative, S2 spells them out): single global budget (default **6 ms** steady
[A] — the house figure, now global instead of per-family), checked BETWEEN items;
always-run-one per engaged class per its due-interval so nothing starves (the xu7
rule); per-class max-defer frames (RP3's 3-frame shape) forcing minimum service;
elevated modes — BOOT (pre-`in-world`: budget 50 ms/frame [A]), TELEPORT (first tick
after `onTeleport`: 250 ms one-shot burst — pass 6 D-06.10's R-12 lesson, adopted as
a scheduler mode instead of LRU-private code), EMERGENCY (ladder R4: W4/W5 budget
doubles, W2 full-tier uploads pause — pass 6 S4). The scheduler is the ONLY caller of
pool mutations and staged uploads (pass 7's anti-churn law gets its enforcement
point), and every class publishes `{ran, deferred, forcedRuns, maxItemMs, queueDepth}`
(S7).

During migration the legacy 6 ms families keep their own code but register as W6
clients so the GLOBAL cap holds — the one-line integration is each drain asking the
scheduler for permission-with-budget instead of free-running its private 6 ms. At
retirement (pass 9), W6 empties to the entity/legacy-lane residue.

*Rejected:* merging RP3 into the scheduler now (RP3 gates *scene ticks* pre-render
with different semantics — cheap, staleness-tolerant reads; collapsing them risks the
P2/P4 ordering contracts for zero measured win; recorded as a post-v1 open question);
a strict per-class fixed split of the 6 ms (starves bursty classes; priorities +
always-run-one is the RP3-proven alternative); running the slot only every N frames
(latency ladder for no accounting benefit).

### D-08.4 — Worker topology: FIVE page workers + the SW, each with a closed message vocabulary; wasm in exactly two

The unified census (contracts in S3). This composes pass 3 (fetch authority on main),
pass 4 (one-transferable bundle), pass 5 (texture worker), pass 6 (dual wasm, worker
de-stated):

| worker | wasm? | default | role (post-migration) |
|---|---|---|---|
| main thread | #1 | — | session/physics/render; PackFetchController (sole fetcher); PackStore; pool_registry; FrameWorkScheduler |
| bake worker | #2 | ON (`?bakeWorker=0` escape, as today) | TilePlan + GeometryBundle assembly per tile job (pass 6/7); entity-surface decode (legacy lane); sha256 fallback engine (pass 3 D-03.5) |
| texture worker | NO (wasm-free by design, pass 5 D-05.4) | ON (`?texWorkers=0` escape) | XU7→BC7 transcode, terrain array assembly, NRA derive |
| net worker | (own wasm relay) | **OFF** — read-verified: `?netWorker=1` opt-in, s15 decision "NOT promoted" (net_worker_client.js:20, 58–60) | transport relay when armed; MUST gain the census relay (pass 6 D-06.9.3) so M3 is scorable **when armed** |
| keepalive worker | NO (timer only, keepalive_worker.js:6) | ON (`?keepaliveWorker=0`) | fixed-cadence keepalive tick messages |
| service worker | — | ON (v3, pass 3 D-03.9) | CAS cache; NO postMessage vocabulary (the bake-identity gate messages die with v2) |

**Correction to the record (R4):** pass 6's M3 table lists the net worker as a
standing third instance (≤32 MiB). Read-verified this session: it is **default-OFF**
and was measured-and-declined for promotion (workDelta +17%, settle +24% — the s15
note, net_worker_client.js:56–60). This does not contradict pass 6's budget — M3 is a
summed ceiling and an absent instance sums 0 — but the census relay work item is
conditional on the flag being armed, and pass 10's default-URL M3 runs will see two
instances, not three. Flagged to pass 11.

**Backpressure model (uniform):** every worker runs at most ONE job in flight from
the main thread's perspective except the texture worker's FIFO (depth-capped;
`cancel` by seq on eviction — pass 5 S3). The bake worker's job concurrency is 1
(pass 6 D-06.8 lease mechanics); its input is the lease transfer (packs as
transferable ArrayBuffers, dispatched WITH the job message — no separate lease
round-trip); its output integrates on the main thread only through the scheduler
(W3), never in the `onmessage` handler beyond enqueueing. **No worker result may
mutate the scene or touch the GL context from its arrival callback** — arrival
enqueues, P4 executes. This one rule is what makes "worker results" invisible to the
tail: a burst of results is a queue, not a task.

*Rejected:* a fetch worker (pass 3 D-03.3 settled: controller stays on main with a
relocation escape); wasm in the texture worker (pass 5 settled); promoting the net
worker as part of this program (measured negative, above); merging keepalive into the
texture worker (keepalive's whole value is owning no work that can block its timer).

### D-08.5 — Upload scheduling: completions never upload; the stream slot stages via `renderer.initTexture`; buffers are budgeted at feed; per-class budgets

**The mechanism, read-verified rather than assumed:** three r184 uploads textures
synchronously inside `renderer.render` at first bind / on `needsUpdate` /
`layerUpdates` (the terrain array sets `needsUpdate = true` at construction and pays
at next bind, terrain_bc7.js:500; array layer writes mark `addLayerUpdate` →
one `compressedTexSubImage3D` at next bind, bc7_textures.js:381–398). The staged
alternative EXISTS as a public API: **`renderer.initTexture(texture)`**
(three.module.js:19465–19487, fetched this session) — and it explicitly routes
`isCompressedArrayTexture` through `setTexture2DArray`, so both singleton
CompressedTextures and the bucket/terrain arrays can be uploaded at a moment WE
choose, outside `renderer.render`. It has zero callers in the tree today (grep this
session) — its in-app behavior on our array + layerUpdates path is
**assumed-pending-verification** (Open Q2; one 1070 probe).

Normative rules:

1. **No upload from a completion callback.** Fetch/transcode/bake completions enqueue
   W2/W3 items only. The stream slot is the sole site that calls `initTexture`, sets
   `needsUpdate`, or marks layers. (Today's violation class: material-build swaps and
   atlas grows mark textures wherever the promise lands, and render pays at an
   uncontrolled moment.)
2. **A texture is staged (uploaded via `initTexture` in P4) BEFORE the frame that
   first samples it.** Pool LIVE flips and material re-points are ordered after their
   texture's staging item in the same or an earlier slot. Preview textures (born with
   the material, pass 5 S4) are staged in the feed batch that admits their tile —
   boot-mode budget covers the ring.
3. **Buffers have no staging API** (verified: the public renderer surface is
   compile/compileAsync/initTexture only) — so buffer upload cost is bounded
   UPSTREAM: the feed batch caps appended vertex+index bytes per frame, and the
   upload happens at next render of that pool (one `bufferData`/`bufferSubData`
   class cost proportional to the cap). BatchedMesh growth doublings are exclusive
   items (below).
4. **Per-class budgets (T1 steady state, all [A] with `?upBudget*` escapes; measured
   feedback = the stall probe's `texUploadMs`/`bufUploadMs` GL-wrap buckets, kept):**

| class | budget/frame | arithmetic anchor |
|---|---|---|
| U-TEX compressed uploads (previews, full-tier swaps, array layer writes) | ≤ 4 MiB staged bytes AND ≤ 2 items | 512² chain 0.35 MiB, 1024² 1.4 MiB [D, pass 5 S1.5]; a crossing column's preview set is ~0.06 MB mean [M, pass 2 S1.5] — steady state is far under budget; the budget exists for upgrade bursts |
| U-BUF pool feed bytes | ≤ 2 MiB appended | worst measured column ≈ 0.70 MB total pack bytes incl. GEOM [D, pass 4 S6.2]; unique-vertex content per sector ~0.5 MB class [M+D, pass 7 S5.1] |
| U-NRA RGBA8 nra planes | ≤ 2 MiB | half-res plane = ¼ albedo texels × 4 B [D, pass 5 D-05.5] |
| U-EXCL exclusive items (one per frame, only when no other class ran) | terrain t1024 pair swap (88 MiB [M, terrain_bc7.js:107–110 via pass 5]); a pool buffer growth doubling; atlas array allocation step | see tail ledger S6 — each is one indivisible driver call |

5. **Atlas/array grows amortize:** allocation at ×1.5 (pass 5 D-05.6.4) is the
   exclusive item; the re-upload of existing layers is CHUNKED — re-mark ≤ 2 layers
   per frame (≈ 2 × 1.4 MiB at 1024² [D]) until the prefix is re-homed, instead of
   today's whole-live-prefix re-mark in one frame (static_atlas.js grow path; the
   p99 doc #4's 20–250 ms model).
6. **Terrain tier swap is wholesale but schedulable:** the t128→t1024 swap (pass 5)
   stages the new arrays via `initTexture` in P4 (possibly across 2 frames: color,
   nra), then re-points the material — the assembly already moved off-thread
   (pass 5 D-05.4). The 88 MiB staging call is the largest single indivisible item in
   the design (S6.4).

*Rejected:* budgeting uploads purely in bytes (driver cost per call varies with
format/dims; the ms-denominated GL wrap is the feedback loop, bytes are the control —
both, per the p99 doc's counts-vs-ms rule); slicing texture uploads below one
texture/layer (no API for partial compressed level upload beyond per-layer; a layer
IS the quantum); a WebWorker + OffscreenCanvas second GL context for uploads (shared
resources across WebGL contexts don't exist; dead on arrival).

### D-08.6 — Stall prevention: boot class-census prewarm with an explicit CSM depth-variant WARM RENDER; per-spawn warm and archetype warm retained for the entity residue

Pass 7 hands this pass a boot-closed class census (D-07.9: the class set is fixed at
boot; `classesCreatedPostBoot = 0` gate). The prewarm spec (S5):

1. **Color variants:** for every class material in the census, `renderer.compile` of
   a warm scene containing one representative per class — executed through
   `withWarmTarget` (shader_prewarm.js:117–143) so the compiled key carries the
   composer's non-null-target variant (the 2131→369 ms mechanism, default-ON since
   08-06, read-verified at shader_prewarm.js:65–90). Uses `guardedCompileAsync`
   (bake_prewarm.js:50–83) for the ready-poll.
2. **CSM depth variants — the population `renderer.compile` CANNOT reach** (verified
   twice: r184 compile walks scene materials only, three.module.js:17312+; the p99
   doc #1 documents the consequence — 43 unwarmed depth programs at 172–849 ms/link
   [M]). Mechanism: **one off-screen shadow-pass render, not a compile.** The warm
   scene holds a real `BatchedMesh` per castShadow class (batching is a
   program-parameter axis derived from the OBJECT — three.module.js:7497/7578 — so a
   plain Mesh proxy would warm the WRONG depth variant), each with one 3-vertex
   instance, plus shadow-casting DirectionalLights matching the live CSM
   configuration (3 cascades at high/ultra). One `renderer.render` of this scene to
   the 1×1 HalfFloat warm target with `shadowMap.needsUpdate = true` forces
   `WebGLShadowMap` through `getDepthMaterial` per (object, material, light-type)
   (three.module.js:9454/9569/9583) and links every depth program off the critical
   path. This is the p99 doc's own fix sketch (:379–389) made concrete against the
   closed class set. VFX vertex-set classes keep the shadow_guard exemption (pass 7
   D-07.9) — their depth material carries no displacement, so one shared depth
   variant per state-combination covers them.
3. **When:** boot, after the class census settles (ring feed complete), before the
   `preview-complete` milestone is declared; cost is boot-time link work, bounded by
   class count (≤ ~48 classes × {color, depth} [A, pass 7 Q1]). Re-warm triggers:
   context restore (the warm scene persists — parked, never disposed, the program
   refcount rule bake_prewarm.js:166–170 established); a quality-preset change that
   flips `csm` (new depth population). NOT re-run on streaming — that is the point.
4. **Entity/legacy residue:** per-spawn `prewarmSubtree` + the archetype matrix stay
   as built (bake_prewarm.js:95–106, 171–260) — the entity program population is
   charter-kept outside pools and keeps its landed warm path.
5. **Transcode/assembly stalls:** structurally moved off-thread by pass 5 (worker);
   the main-thread FIFO fallback keeps its 6 ms batch budget as a W6 class. Boot
   transcoder load (the ~15 s class stall, xu7_textures.js:375–380 region) is
   avoided on the boot path by construction — previews are raw BC7 (pass 5 D-05.1).

*Rejected:* warming depth variants via `compileAsync` (cannot — verified above);
warming with tiny plain Meshes (wrong `batching` key axis — verified above);
prewarming per-tile at feed time (re-creates per-crossing link risk the closed set
exists to kill; feed-time warm is only the fallback if a post-boot class mint is ever
legitimate, which pass 7 defines as a bug).

### D-08.7 — Tail design targets: every ranked stall class gets a bounding mechanism and a residual worst case with arithmetic

Binding targets restated from pass 1: **F4** moving-mid p99 ≤ 60 ms; **F5**
moving-ultra p99 ≤ 150 ms AND `linkStatusMs = 0` over a 60 s walk (CSM depth variants
included); **F6** no frame > 250 ms attributable to streaming/crossing in steady
walk. Full ledger with arithmetic in S6. Headlines:

- **Links (#1):** bounded by the closed class set + D-08.6 warm. Residual worst case
  in steady walk: **0 links** — that is the F5 sub-target, and any nonzero
  `linkStatusMs` is attributable (census counter `classesCreatedPostBoot` or an
  entity-warm miss). The 369 ms post-prewarm MAX [M, n=1] is a today-figure; the
  design deletes the population, not just re-aims the warm.
- **Transcode (#2):** off-main (pass 5). Residual: worker-mode main-thread cost = one
  result integration under W2/W3 budget (enqueue + view reconstruction, sub-ms class
  [A]); fallback-mode worst = 32 ms single item [M] + 6 ms batch bound — inside F4
  only marginally, which is acceptable for a fallback arm and stated as such.
- **Governor churn (#3):** deleted structurally by pass 6 (floors never zeroed,
  count-governor gone); the frame-side residual is W4's ≤1-tile amortized drain under
  the global 6 ms budget. Teleport: 250 ms one-shot burst mode — F6 scopes to
  "steady walk"; the teleport blip is a design-accepted exception (pass 6 D-06.10,
  R-12 evidence) and is labeled in diag so pass 10 never mistakes it for a violation.
- **Atlas/array grow (#4):** ×1.5 step + chunked re-upload (≤2 layers/frame) + the
  NRA scalar fill deleted (worker-derived planes, pass 5 D-05.5). Residual worst =
  one allocation step + 2 layer uploads ≈ **one exclusive item + ~2.8 MiB** [D] —
  tens-of-ms class at worst, under F6 with margin; measured by `texAllocMs`.
- **Largest single indivisible task remaining in the design** (the charge's explicit
  ask): the **t1024 terrain pair staging** — 88 MiB of compressed bytes through
  `initTexture` in ≤2 calls [M bytes; upload ms unmeasured, Open Q3]. Why acceptable:
  once per session per tier transition (not per crossing), schedulable (P4 picks the
  frame; can defer to low-motion), and the modeled class (tens-to-low-hundreds of ms)
  sits under F6's 250 ms — with the honest caveat that no 1070 measurement of a
  single 88 MiB compressed upload exists; if it measures over 250 ms, the named
  fallback is per-array split (color frame N, nra frame N+1: 44 MiB each) which the
  all-or-nothing rule permits (it binds the SWAP, not the staging — the material
  re-point happens only after both stage).
- **GC / wasm grow (#7):** not directly schedulable; the design attacks its feed —
  pass 4/6 delete the copy-churn and unbounded stores; P4's slot never allocates
  proportionally to the ring. Residual: unbounded in principle, observed via the
  probe's heap-delta channel; stated as the honest un-designed remainder (R8).

### D-08.8 — What the frame exposes: the stall probe is KEPT; the scheduler and phases feed its counter vector

The stall probe (`scene3d/stall_probe.js`) is retained as the tail instrument — its
method (difference cumulative counters across a frame edge; renderMs/outsideMs split;
ms-denominated buckets only in `explainedMs`) survives this redesign unchanged, and
its GL wrap remains the upload budget's feedback meter. Pass 10 owns the validation
protocol; this pass owns what the frame publishes (normative in S7):

1. `__framePhase` — per-frame phase-cost vector `{p0,p1,p2,p3,p4}` in ms (5 paired
   `performance.now()` reads/frame; the probe samples it like any counter).
2. `__frameWork` — scheduler counters per class: `{ran, deferredFrames, forcedRuns,
   maxItemMs, itemsThisFrame, queueDepth, mode}` + `uploads: {stagedBytesByClass,
   initTextureCalls, exclusiveItems: [names]}` — cumulative, diffable.
3. The existing surfaces the probe reads stay contract-stable through migration
   (`__linkProbe`, `__xu7Stats`, `__atlasStats` → successors publish under the same
   names with the same monotone-cumulative semantics, or the probe's `_sample` is
   updated in the same commit — the doc-propagation wall applies to instrument
   wiring too).
4. One addition the p99 doc asked for and nothing yet provides: the teleport/boot
   mode flag is exported in `__frameWork.mode` so long frames in elevated modes are
   attributable without cross-referencing logs.

*Rejected:* replacing the probe with per-subsystem timers (the probe's own header
argues why not — wrapping detached continuations is a week of risk; subtraction
works, stall_probe.js:26–56); publishing phase marks via `performance.mark` (User
Timing has per-entry allocation cost and needs an observer; plain fields are cheaper
and probe-compatible).

## Spec

### S1 — Normative frame (T1 reference; per-phase budgets [A] pending pass 10's phase census)

```
rAF tick (async; alternate drivers: ?netDrainHz interval, __renderOnce — both run
P0–P2+P4, skip P3 under nullRender; live-clock discipline D-08.1 mandatory)

P0  SIM (~1.0 ms [A])           never gated
    net/input pump (CRITICAL #0, relocated 2D pump — loop.js:2307–2345, unchanged)
    syncTickHop: tickMovement enqueue + one-microtask hop (index.js:2203–2241)
    dt clamp + recovery bands (index.js:2259–2276, unchanged)

P1  RESIDENCY (~0.2 ms settled [A]; bursts execute in P4)
    grid.update(pose): anchor compare → onShift/onTeleport/onSlotState events
    controller.setPlayerTile (lane-R enqueues/dequeues — pass 3 S2.5)
    ladder sampler @1 Hz (heap/wasm/context-loss checks — pass 6 S4.3)
    events RECORD work items (W1–W4); they do not execute here

P2  WORLD TICKS (RP3 as built: 9 ms deferrable threshold, 10 Hz, 3-frame ceiling)
    CRITICAL:   #1 cell visibility → portal feeds → #1.5 frustum cull → clocks
                (uTime/VFX/weather-inputs) → #5 lighting → flame → shadow gate →
                #13 camera/input → #15/#16/#19 entity block → A11-S3 particles
                (loop.js:2373–2845, order unchanged)
    DEFERRABLE: PVS-successor group (pass 6/7 event consumers replace
                tickPvsLoadExpansion; compaction ticks retired → W4),
                SKY group, NAME group (loop.js:2500–2707, 2854–2885)
    pass 7 band tick (2 Hz) + PVS renderSet flips run here (event/throttled;
    overflow amortization → W1/W3 items if a flip exceeds its inline cap)

P3  RENDER
    composer path: preFrameSkySync → cloud preRender → composer.render →
    cloud overlay → recordRenderDiag (index.js:2440–2469); direct path with the
    F4 restore-and-re-arm invariant (index.js:2543–2578); nullRender skips
    (index.js:2485–2492). Driver consumes all previously staged uploads here.

P4  STREAM SLOT — FrameWorkScheduler.run(budget)
    budget: NORMAL 6 ms · BOOT 50 ms · TELEPORT first-tick 250 ms · EMERGENCY
    (ladder R4) W4/W5 ×2, W2 full-tier paused           [all A, ?workBudget=N]
    classes W1..W6 (D-08.3), between-item budget checks, always-run-one,
    per-class max-defer 3 frames
    shrink rule: effectiveBudget = max(2 ms, budget − max(0, elapsed(P0..P3) −
    targetPeriod)) — a heavy frame halves the slot rather than stacking on it
    [A; ?workShrink=off escape]

scheduleNext(): pacer + re-arm (index.js:2180–2196) — unchanged
```

Milestone gating: BOOT mode ends at `preview-complete`; the D-08.6 prewarm runs as a
BOOT-mode W2-priority item after the class census settles and gates the milestone
(a declared `preview-complete` implies warm-complete).

### S2 — FrameWorkScheduler rules (normative)

1. One instance, main thread. `enqueue(classId, item)` from event handlers and worker
   `onmessage` only; `run(budgetMs)` from P4 only. Items are closures with a declared
   `kind` and (for W2/W3) declared `bytes`.
2. Dequeue order W1 > W2 > W3 > W4 > W5 > W6; FIFO within class. Budget checked
   between items; the first item of the highest non-empty engaged class always runs
   (starvation guard). A class whose oldest item has waited ≥ 3 frames force-runs one
   item regardless of budget (RP3's ceiling, loop.js:2198–2202 shape).
3. W2/W3 additionally respect the D-08.5 byte caps per frame; W-EXCL exclusive items
   run only as the sole item of their frame's slot (after W1).
4. Ordering invariants: within one tile's feed, order = geometry appends → texture
   stages → matrices/instances → membership record → LIVE flip (epoch bump) — the
   flip is last, so P3 never draws a half-fed tile (pass 7 S2's one-epoch-bump rule,
   given its execution site). A texture stage item for rsId R always precedes any
   material re-point item for R.
5. Single-item overshoot is bounded by construction, per class: W3 ops are bounded by
   pass 4's 256 KiB SHOULD-cap per mesh payload; W2 by one texture's chain; W6 by one
   fallback transcode (32 ms [M]). The scheduler records `maxItemMs` per class so
   pass 10 can verify the bounds instead of trusting them.
6. Cancellation: items carry their tile/rsId; slot vacation (pass 6 EMPTY before
   fetch/bake) purges queued items for that tile; texture-worker jobs cancel by seq
   (pass 5 S3).

### S3 — Worker message contracts (normative, complete)

**Bake worker** (module worker, wasm instance #2; client owns lifecycle,
bake_worker_client.js:795+):

```
main → worker:
  {type:"init", id, wasmUrl?, manifest…, flags…}      (as today, bake_worker.js:277)
  {type:"job", id, kind:"tile-bake", tile, lbs:[u32],
     packs:[{hash16, bytes:ArrayBuffer}…],            // the LEASE — transfer all
     commonsRev:u32}                                  // worker-resident commons epoch
  {type:"job", id, kind:"entity-surfaces", …}         // legacy lane (today's
     // fetchEntitySurfacesPixels(+Batch) shapes, bake_worker.js:285–288, retained)
  {type:"job", id, kind:"sha256", bytes:ArrayBuffer}  // pass 3 verify fallback
     // (non-secure-context only) — transfer
  {type:"census", id}                                 // wasmMemCensus, as today
  {type:"cancel", id}                                 // tile vacated pre-run
worker → main:
  {type:"ready", id}                                   
  {type:"result", id, kind:"tile-bake",
     tilePlan: <pass 7 S1 TilePlan, structured clone>,
     bundle: ArrayBuffer}                             // pass 4 S3 — ONE transfer
  {type:"result", id, kind:"entity-surfaces", payload, audit}   (as today)
  {type:"result", id, kind:"sha256", digest:ArrayBuffer(32)}
  {type:"result", id, kind:"census", rows}
  {type:"error", id, message}
```

Concurrency 1 job (census/cancel exempt). Lease buffers transfer WITH the job (no
second copy; pass 6 D-06.8); the worker drops them at job end. Retired kinds:
`fetchModelMeshes`/`fetchSurfacesPixels` for world content (bake_worker.js:279–284)
die with the runtime-triangulation path (pass 4); the `__hbFetchConcurrency*` /
verify/budget init fields die with the split (pass 3 S10).

**Texture worker** — pass 5 S3 verbatim (init / job:xu7 / job:terrain-assemble /
cancel → result with one transferred payload buffer + optional nra plane). Pass-8
additions: results enqueue W2 items (never touch GL on arrival, D-08.4); FIFO depth
is observable (`queueDepth` in `__texStats`), and the scheduler may issue `cancel`
for evicted rsIds.

**Net worker** (when `?netWorker=1`): `{t:'tx'|'rx'|'disconnect'|'error'|'ready'}`
as built (net_worker_client.js:8–17) + NEW `{t:'census'}` → `{t:'censusResult',
rows}` (pass 6 D-06.9.3, conditional on the flag).

**Keepalive worker:** unidirectional tick messages, unchanged
(keepalive_worker_client.js:14–23). **Service worker:** no message vocabulary
(pass 3 D-03.9's v3 has nothing to gate).

Main-thread work remaining, enumerated (the charge's last clause): fetch issue +
verify dispatch (crypto.subtle is async native), pack admission (`insert_pack`),
TilePlan → pool feed execution, staged uploads, material/class cache, grid + ladder
+ scheduler bookkeeping, RP3 scene ticks, render submission, entity path (charter-
kept), audio/UI. Everything decode/transcode/assembly-shaped is worker-side.

### S4 — Upload scheduling summary (normative)

| upload | trigger site (ONLY) | mechanism | budget |
|---|---|---|---|
| preview/full singleton textures | P4 W2 | `initTexture` then material re-point item | U-TEX 4 MiB, 2 items |
| bucket-array layer writes | P4 W2 | `writeBc7ArrayLayer` (marks layer) + `initTexture` same item | U-TEX pooled |
| array/atlas allocation or growth | P4 exclusive | new array + `initTexture`; chunked prefix re-marks ≤2 layers/frame thereafter | 1 exclusive/frame |
| terrain tier arrays | P4 exclusive (BOOT: t128 inline) | `initTexture` per array (≤2 calls, may split across 2 frames); swap re-point after both | 1 exclusive/frame |
| pool geometry buffers | P4 W3 feed (upload at next P3 bind) | append under byte cap; growth doubling = exclusive | U-BUF 2 MiB |
| NRA RGBA8 planes | P4 W2 | DataTexture/array layer + `initTexture` | U-NRA 2 MiB |
| entity/legacy textures | unchanged (legacy path) | today's needsUpdate-at-build | W6/legacy |

Verification obligation (Open Q2): one 1070 probe confirming `initTexture` on a
`CompressedArrayTexture` with pending `layerUpdates` performs the subimage uploads
(reading r184's `setTexture2DArray` says yes; the in-app path is untested).

### S5 — Prewarm spec (boot sequence)

1. Build class census from pool_registry after ring feed settles (pass 7 S5.3).
2. Warm scene A (color): one 3-vert BatchedMesh instance per class, class material
   attached; `withWarmTarget(renderer, () => renderer.compile(sceneA, cam))` via
   `guardedCompileAsync` — programs carry the composer variant key
   (shader_prewarm.js:1–33 mechanism).
3. Warm scene B (depth): the castShadow subset of scene A's pools + N cascade
   `DirectionalLight`s (N = live CSM split count; 3 at high/ultra) with tiny shadow
   maps (64²); `shadowMap.needsUpdate = true`; ONE `renderer.render(sceneB, cam)` to
   the warm target. Forces `getDepthMaterial` + link per (BatchedMesh, class,
   light-type) — the population compile cannot reach (D-08.6, verified anchors).
4. Park both scenes for the session (never dispose — program refcount,
   bake_prewarm.js:166–170). Publish `__prewarmStats = {classes, colorPrograms,
   depthPrograms, msColor, msDepth}`.
5. Re-run triggers: context restore; CSM preset flip. Post-boot class mint = bug
   (pass 7 gate); entity residue keeps per-spawn warm + archetype matrix as built.

### S6 — Tail budget ledger (F4 ≤60 / F5 ≤150 + linkStatusMs=0 / F6 ≤250 streaming)

| stall class (p99 doc rank) | measured scale today | bounding mechanism | residual worst case (design) |
|---|---|---|---|
| #1 sync links (CSM depth) | 172–849 ms/link × 43 mid-walk [M]; post-prewarm MAX 369 [M, n=1] | closed class set (pass 7) + S5 boot warm incl. depth render | **0 links steady walk** (= F5 sub-target); misses are counted bugs (`classesCreatedPostBoot`, `linkStatusMs`) |
| #2 xu7 transcode bursts | ~32 ms/1024² [M]; modeled bursts 150–1,600 ms | worker (pass 5); results integrate via W2 | worker mode: sub-ms integration [A]; fallback mode: 32 ms item + 6 ms batch [M] — fallback only |
| #3 governor/park churn | 332 adds/329 removes per 30 s class [M via p99 #3] | pass 6 deletion (floors, grid); W4 amortized ≤1 tile under global 6 ms | 6 ms class steady; TELEPORT 250 ms one-shot (mode-labeled, outside F6's steady-walk scope) |
| #4 atlas grow | modeled 20–250 ms/grow [p99 #4] | ×1.5 step + chunked ≤2-layer re-upload + NRA fill deleted | 1 exclusive alloc + ~2.8 MiB uploads ≈ tens of ms [A/D] |
| terrain assembly (pass 5's addition) | 88 MiB alloc+memcpy sync task [M, survey §2] | assembly worker-side; staging via ≤2 exclusive `initTexture` calls, splittable to 44 MiB halves | largest indivisible item in the design; once per tier transition; modeled < 250 ms, **unmeasured** (Q3) |
| #6 context loss | 7/session at ultra [M] | M5 target 0 (pass 5/6 VRAM budgets); warm scenes survive restore | recovery cost unchanged; counted, not designed away here |
| #7 GC / wasm grow | unmeasurable today | churn deleted upstream (passes 4/6); P4 allocates O(budget) not O(ring) | honest residual: unbounded in principle, probe-observed (heap Δ channel) |

Arithmetic cross-check against F4 (moving-mid p99 ≤ 60 ms): steady moving frame =
P0–P3 (p50-class, target ≤16.7 by F1's program) + P4 ≤ 6 + at most one bounded
overshoot item (≤ ~5 ms W2/W3 class [A]) — the designed frame has no single
scheduled task ≥ 32 ms outside exclusive/fallback/mode-labeled items, so p99 breaches
of 60 ms must come from the unscheduled residue (#6/#7) or a design violation, which
is exactly what makes F4 attributable. No ms prediction is made for p50 (walls;
charter D-01.5) — this is a bound structure, not a forecast.

### S7 — Frame observability contract (pass 10 consumes)

- `__framePhase` (per-frame, plain object): `{p0, p1, p2, p3, p4}` ms.
- `__frameWork` (cumulative): per-class `{ran, deferredFrames, forcedRuns, maxItemMs,
  queueDepth}`, `mode` (NORMAL/BOOT/TELEPORT/EMERGENCY), `uploads` per S4 classes
  (bytes + calls), `exclusive: [{name, ms, frame}]` ring (last 16).
- Stall probe kept: renderMs/outsideMs split + ms-buckets + GL wrap; its `_sample`
  vector gains `__framePhase` + `__frameWork` fields in the same commit that lands
  them (instrument wiring is doc-propagation duty, walls).
- Prewarm: `__prewarmStats` (S5.4). Scheduler violations (`mutation outside P4`,
  post-boot class mint) increment loud counters; pass 10 wires the CI gates
  (parked-frame `poolMutationsPerFrame = 0`, `linkStatusMs = 0` walk, phase-census
  re-classing of the [A] slot budgets).

### S8 — Deletion / retention ledger

| item | disposition | anchor |
|---|---|---|
| inline `lru.tickEviction` + sealed purge from the rAF tick | deleted (P1 events + W4/teleport mode) | index.js:2359–2391; pass 6 S6 |
| private 6 ms budget family (statics/cells/buildings/sealed/park/xu7) as free-running tasks | collapsed into W3/W4/W6 under one global budget | the six sites in Inputs |
| compaction ticks in the PVS deferrable | → W4 `optimize()` items | loop.js:2412–2421 |
| upload-at-completion (needsUpdate/layerUpdate wherever a promise lands) | forbidden; P4-only staging | D-08.5 rule 1 |
| bake worker world-decode kinds (`fetchModelMeshes`, `fetchSurfacesPixels`) | retired with runtime triangulation | bake_worker.js:279–284; pass 4 |
| RP3 (9 ms, 3 groups), net pump, syncTickHop, dt clamp, pacer, composer chain, stall probe, shader/bake/entity/archetype warms | **retained as built** | anchors in Inputs |
| netWorker promotion | not pursued (measured negative, s15) | net_worker_client.js:56–60 |

## Handoffs to later passes

- **H-08.1 (→ pass 9):** Migration staging: the scheduler ships behind `?frameWork`
  (default-OFF until the battery, then default-ON with `=off` escape — house rule);
  its OFF arm is today's task placement, so kill criteria are one-flag. W6
  registration of the legacy families is the first stage (global cap over unchanged
  code); P4 relocation of eviction/feeds is the second; upload staging third (it
  rides `?drawPools`' timeline since pools are its main client). Doc-propagation
  duty: the p99 doc's "SHADER_PREWARM default OFF" claim is stale (flipped 08-06,
  shader_prewarm.js:65) — correct it when this pass's changes land, plus url-flags
  rows for `?frameWork`/`?workBudget`/`?upBudget*`.
- **H-08.2 (→ pass 10):** Measurements owed: (a) phase census re-classing S1's [A]
  slot costs; (b) the Q2 `initTexture`+layerUpdates probe; (c) the Q3 88 MiB upload
  timing; (d) scheduler tuning (6 ms global, shrink rule, max-defer 3); (e) the F5
  `linkStatusMs = 0` walk with `__prewarmStats` cross-check; (f) boot-time cost of
  the S5 warm (charter's shaderPrewarm boot-cost caveat inherited); (g) fallback-arm
  (worker-dead) tail run. The stall probe + S7 surfaces are the instrument set;
  successor design is pass 10's if buckets misattribute.
- **H-08.3 (→ pass 11):** Attack surface flagged: the post-render slot placement
  (argued, not A/B'd); the 6 ms global budget vs today's additive budgets (could
  UNDER-serve streaming on fast lines — the always-run-one + BOOT/TELEPORT modes are
  the counter, unproven); the netWorker census-relay conditionality vs pass 6's M3
  wording; S6's F4 cross-check depends on pass 7's unmeasured class census; the
  depth-warm's coverage of light-TYPE variants (directional-only assumed — spot/point
  shadow casters would add `getDepthMaterial` types; the client's shadow casters are
  directional/CSM today, unverified for the future entity-light population).
- **H-08.4 (→ pass 12):** The frame phase table (S1) + scheduler contract (S2) are
  the integration skeleton for the build order: W1/W2 packs and pools can land
  independently, but P4 relocation and upload staging must land TOGETHER with pools'
  feed path (they share the LIVE-flip ordering invariant, S2.4).

## Self-check

- **Walls — draws×µs / draw-count proxy / derivation prohibition:** no frame-time
  prediction anywhere; S6 is a bound ledger with residuals, and the F4 cross-check
  explicitly disclaims p50 forecasting. PASS.
- **Walls — parked-vs-moving:** tail mechanisms are argued per stall class from the
  p99 doc's moving measurements; no parked figure is projected onto moving. The
  shaderPrewarm A/B's n=1 caveat is carried verbatim. PASS.
- **Walls — scale confusion / allocated≠used:** upload budgets state bytes-staged vs
  items vs driver-ms as distinct quantities; worker census states which instances
  exist by default vs by flag. PASS.
- **Walls — boot variance:** no boot timing claimed; prewarm boot cost is an owed
  measurement (H-08.2f). PASS.
- **Walls — flag-bit≠predicate:** new flags (`?frameWork`, `?workBudget`,
  `?upBudget*`, `?workShrink`) spec'd with explicit-value semantics and escapes;
  the stale-doc correction (prewarm default) is assigned a propagation duty. PASS.
- **Walls — GPU theories on a CPU-bound frame:** upload budgets are justified on
  tail/attribution grounds, not fps; the one GPU-cost unknown (88 MiB upload) is
  flagged for measurement, not assumed cheap. PASS.
- **R1:** read order followed. No prior decision contradicted: D-08.2 discharges
  pass 6 H-06.2 and pass 7 H-07.1; D-08.5 discharges pass 4 H-04.4 and pass 5
  H-05.3; the netWorker finding (D-08.4) is a factual precision of pass 6's M3
  wording, not a supersede — M3's summed ceiling stands, the relay work item becomes
  flag-conditional, flagged to pass 11. PASS.
- **R2:** migration staging (9), bench/tuning (10) deferred with proposed defaults;
  no pool/texture/residency internals redesigned. PASS.
- **R3:** writes = this file + own TRACKING.md row. The three r184 build was fetched
  to the session scratchpad for verification, not into the repo. PASS.
- **R4:** every current-code claim carries file:line opened THIS session, including
  the three r184 claims (fetched build read directly: initTexture 19465–19487,
  compile 17312, batching 7497/7578, getDepthMaterial 9454); the two stale-record
  traps caught this session are stated (prewarm default flipped vs the p99 doc;
  netWorker default-OFF vs the pass 6 table). The wasm-crate trap not triggered (no
  `crates/holtburger-web` claims). PASS.
- **R6:** six sections in order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete phase table, scheduler rules, complete message vocabularies,
  numeric budgets with [M]/[D]/[A] classes and escapes. PASS.
- **R8:** unmeasured load-bearers declared: phase slot costs, initTexture in-app
  behavior, 88 MiB upload ms, global-budget sufficiency, depth-warm light-type
  coverage, prewarm boot cost. PASS.

## Open questions

- **Q1 — Phase slot costs are [A].** P0/P1/P2 have never been measured as slots
  (only end-to-end and render-split figures exist). One instrumented session with
  `__framePhase` re-classes S1's numbers. [Owner: pass 10, first scheduler spike.]
- **Q2 — `initTexture` + `CompressedArrayTexture.layerUpdates` in-app.** The r184
  source routes it correctly (verified); no code in this tree has ever called it.
  One 1070 probe (stage a layer-marked array via initTexture, confirm zero
  `texUploadMs` inside the next render) settles it. If it fails, the fallback is
  needsUpdate-marking inside P4 with the upload still landing in next P3 —
  budget-accountable via the GL wrap, slightly worse attribution. [Owner: pass 10.]
- **Q3 — The 88 MiB terrain staging cost on the 1070.** Largest indivisible item in
  the design; modeled under F6, unmeasured. If > 250 ms even split 44/44, the next
  lever is per-level staging (the arrays are level-major; initTexture uploads whole
  textures, so per-level staging would need needsUpdate-phasing — design sketch
  only). [Owner: pass 10, same session as Q2.]
- **Q4 — Global 6 ms vs additive budgets on fast lines.** On localhost/fast CDN the
  old additive families could move ~30 ms of streaming work per frame; the unified
  cap intentionally trades peak throughput for tail bounds, with BOOT/TELEPORT modes
  as the pressure valves. If pass 10's boot-time or crossing-settle benches regress
  vs baseline, the named lever is a third elevated mode (CROSSING: budget 12 ms while
  any W1/W3 queue is nonempty and the frame is under 80% of target period).
  [Owner: pass 10.]
- **Q5 — Depth-warm light-type coverage.** S5 warms directional/CSM depth variants
  (the measured population). If entity-adjacent point/spot shadow casters ever ship,
  `getDepthMaterial`'s distance-material arm adds a second variant family — extend
  scene B then. [Owner: whoever ships such lights; noted for pass 11.]
- **Q6 — RP3/scheduler unification.** Two budget systems remain by design (D-08.3
  rejection). Post-v1, folding RP3's groups into the scheduler as P2-phase classes
  would give one accounting surface; not worth the ordering risk now. [Owner:
  post-v1 cleanup, pass 12 may note as tracked debt.]
