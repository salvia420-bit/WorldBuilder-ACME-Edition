# The p99 1,630 ms stall — ranked causes, and the instrument to settle it

2026-08-06. Companion to `2026-08-06-frame-cost-structure-measured.md` (which
splits the *mean* frame) and `2026-08-06-frame-remainder-probe.md` (which splits
the *mean* render call). This one is about the frames those two cannot see.

## The number

One arm on the 1070, settled Nanto, `?quality=ultra&clouds=on&wxMap=nasa`,
Remacri textures live, 0 page errors:

```
PARKED   p50 30.5 ms   mean 35.4   p95 64.8                  552 draws  381 ktris
MOVING   p50 47.5 ms   mean 84.0   p95 78.0   p99 1630 ms    847 draws  677 ktris
```

Environment: `terrainBc7` t1024 aniso 16 / 33 layers; `xu7` 178 decodes,
transcoderLoads 1, 0 decodeErrors; `bc7` 183 hits / 202 fetches / 0 parse
errors; canvas 1200x1013.

Three facts constrain every hypothesis, and any candidate that fails one of them
is out:

1. **It is motion-gated.** PARKED has no p99 spike. Whatever it is, it is fed by
   the streamer.
2. **It is preset-gated.** The same client at `mid` parked runs 20.2 ms with p95
   26.5. Whatever it is, `ultra` enables it and `mid` does not.
3. **It is rare.** mean is 1.8x p50, so a handful of frames carry it. No average
   can find it — which is why the first deliverable here is an instrument, not
   a patch.

Everything below was established by reading the tree. Where a number is
modelled rather than measured it is given as a **range** and labelled.

---

## Ranked causes

### #1 — Synchronous shader program link inside `renderer.render` (CSM depth variants)

**Confidence: high. This is the only candidate with a direct prior measurement
of the same symptom on the same box.**

`scene3d/shader_prewarm.js`'s header already records it:

> The 07-16 walk-stall profile (`/mnt/wbterminal2/tmp/walk-stall-attrib.json`,
> 1070) shows the result: **43 programs force-linking mid-walk at 172-849 ms
> each**, getProgramParameter = 32.9 % of in-stall self-time — the warms had
> "done" their job on the wrong variant.

Two 849 ms links in one frame is 1.7 s. That is not a model; it is a measurement
of this workload, on this hardware, taken three weeks ago and never closed out.

Three mechanisms stack:

- **The prewarm aims at the wrong program variant.** `SHADER_PREWARM_ON` is an
  exact-match `=on` opt-in and is **default OFF**, so `withWarmTarget` degrades
  to a bare `fn()` at every site. Every `renderer.compile` therefore runs with
  the **canvas** bound, while the world renders through the pmndrs composer into
  a HalfFloat `inputBuffer` — a **non-null** target. In three r184's
  `WebGLPrograms.getParameters`, both `toneMapping` and `outputColorSpace` are
  taken from the renderer only when `currentRenderTarget === null`. Two
  program-cache-key axes flip. Warmed ≠ live, for every prewarmed program in the
  client: `bake_prewarm.js::guardedCompileAsync` (and therefore `prewarmSubtree`,
  the per-spawn rig warm and the archetype matrix), the two boot passes in
  `index.js`, and the envcell warm in `cells.js`.

- **`ultra` manufactures a program population that nothing warms at all.**
  `scene3d/quality.js` flips `csm: false` -> `csm: true` between `mid` and
  `high`/`ultra`. `scene3d/csm.js::setupCsm` builds **3** cascade
  `DirectionalLight`s (`DEFAULT_CSM_SPLITS = [30, 100, 300]`), each
  `castShadow`. `renderer.compile` in r184 calls `prepareMaterial` on **scene**
  materials only — it never touches the shadow pass's depth/distance materials.
  So at `ultra` every newly streamed material's **depth** program is unwarmed by
  construction, and force-links inside `shadowMap.render()`. At `mid` that
  population does not exist. This is constraint (2), exactly.

- **Motion is the feed.** New landblock -> new statics/buildings materials ->
  first-sight programs. Parked streams nothing and links nothing. That is
  constraint (1), exactly.

Where the stall physically lands: `frame_split.js` already establishes that
`WebGLRenderer.renderBufferDirect` opens with
`const program = setProgram(camera, scene, geometry, material, object)`, and
`setProgram` is where `getProgram` lives. On a cache miss three constructs a
`WebGLProgram`; `getUniforms()`/`getAttributes()` then lazily call `onFirstUse`,
which reaches `gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)` — a
synchronous driver-link wait. **Inside the rAF render call.** So this cause
predicts a stall in `renderMs`, not `outsideMs`.

**Scale statement.** The population is programs *newly reached by a draw or a
shadow pass in that frame* — not resident materials, not resident landblocks.
The 172–849 ms per link is the **measured** driver cost from 07-16, not derived
from a count.

### #2 — XUBC7 transcode bursts on the main thread

**Confidence: high that the mechanism is real and unbudgeted. Medium that it
reaches 1.6 s in one task.**

`transcodeXu7` (`scene3d/xu7_textures.js`) runs its per-mip `transcodeImage`
loop **synchronously**, on the calling thread. The module header used to say
"the bake worker absorbs atlas feeds, singletons hitch at most once per
surface". **That was wrong on both halves and is now tombstoned in the file:**

- `scene3d/bake_worker.js`'s complete import graph is `pkg/holtburger_web.js`,
  `tex_overrides.js`, `gfx_relief.js` -> `quality.js`, `bake_transfer.js`. There
  is no bc7/xu7 symbol in any of it; it produces RGBA8 `SurfacePixels` and
  stops. `transcodeXu7` has exactly **one** caller in the tree —
  `Bc7RecordSource._begin` in `bc7_textures.js` — and that source is constructed
  once, on the main thread, from index.html's boot arm, against the
  **main-thread** wasm namespace. Every XUBC7 transcode this client has ever run
  was on the window thread.
- "once per surface" is true per surface and irrelevant per **frame**. `xu7_blocks`
  is an `async fn` in Rust, but after its `prefetch` the bytes come from the
  in-memory source, so N sibling `getAsync` calls from one landblock's material
  set settle in the **same microtask drain** and their N transcodes run
  back-to-back in **one task**, with no yield and no budget between them.

Motion-gated (parked asks for no new surfaces). `ultra` + Remacri gated (more
unique surfaces, and more of them in the 1024² class).

**Scale statement, honestly ranged.** The only measured figure is the file's own
~32 ms per 1024² with mips. Session total was 178 decodes. A landblock crossing
that bursts 20–50 records spans roughly **150 ms (20 small records) to 1.6 s
(50 at 1024²)** — a 10x range, which is exactly why this is #2 and not #1.
**But `_stats.decodeMs` already exists**, so this range collapses to a fact the
moment anyone reads `__xu7Stats().decodeMs / decodes`, and the probe's
per-interval delta gives the burst directly. Do not quote the range once the
probe has run.

This cause predicts the stall in `outsideMs`, not `renderMs`.

### #3 — Landblock churn: the geometry-pressure governor drains the warm pool it needs

**Confidence: high that this is the ENGINE. Low that it is itself the 1.6 s.**

`MAX_LIVE_GEOM` (default 8000, `?maxLiveGeom`) in `scene3d/landblock_lru.js`
triggers on `renderer.info.memory.geometries` — a **count**, which includes
geometry the LRU does not own (entities, atlas). Under pressure,
`_tickParkPoolPressure` does:

```js
const overGeomAtEntry = this._geomPressure();
const floorMs = overGeomAtEntry ? 0 : PARK_USE_TIME_MS;
```

i.e. a geometry breach **bypasses the 30 s park UseTime floor entirely**, so the
warm park pool — the thing that makes re-adoption a pure re-attach — is drained
to empty exactly when pressure is on. Re-adoption then misses the loaders' fast
path (`staticsBakedLbs.has(...)`) and pays a **full cold bake**: fetch + decode +
geometry build + `prewarmSubtree` compile + attach, plus an unbudgeted
whole-scene `attachSetupModelLights` rescan. That is the 08-05 handoff's
332 adds / 329 removes in 30 s: park is bounded at `MAX_PARKS_PER_TICK = 8` and
the geom trigger cannot be relieved by parking (only dispose moves
`memory.geometries`), while unpark is unbounded and fires from the loaders on
every position packet.

`tickEviction` / `evict` / `disposeParked` all run **inside the rAF task**
(called from `index.js::tick` after `tickPerFrame` returns), outside RP3's
budget accounting. `evict` per LB is one unchunked synchronous body.

The sealed purge has an explicit `SEALED_FIRST_BURST_MS = 250` budget, checked
*post-hoc* so it overshoots by one LB — a deliberate quarter-second hitch, and
worth knowing about, but 250 ms is not 1,630 ms.

**The most likely truth is that #3 is not the stall — it is what FEEDS #1 and
#2.** Cold re-bakes are precisely what manufacture first-sight materials
(-> #1's links) and first-sight surfaces (-> #2's transcodes). If the probe shows
#1 or #2 carrying the milliseconds, #3 is still where the durable fix lives.

### #4 — Statics atlas array growth — real, but sub-second on this box

`_growBucketLayers` (`scene3d/static_atlas.js`) re-marks every handed-out layer
dirty (`addLayerUpdate(i)` for `i < nextLayer`, on both the diffuse and NRA
arrays), so the next `renderer.render` re-uploads the whole live prefix. The
worse half is CPU: `buildNraArray` is a **scalar per-texel JS fill** over the
entire new array before the prefix memcpy.

At t1024 with `statNra` + `texBc7` both on: 1 MiB diffuse + 4 MiB NRA = 5 MiB
per layer, `_ATLAS_LAYER_BUDGET_BYTES` 32 MiB -> capacity 6, ladder 1->2->4->6.
Worst grow allocates and fills 6x4 MiB of NRA (6.3 M loop iterations) and
re-uploads 4 layers x 5 MiB. `docs/RESULTS-atlas-occupancy-2026-08-05.json`
puts the whole session at 29 buckets / 112 used layers / 123 MB used.
**Modelled range: 20–250 ms per grow, session traffic bounded by ~123 MB.**
Real hitch class, wrong order of magnitude for 1,630 ms. Ranked down, not out —
the probe prices it in ms via `texAllocMs` / `texUploadMs`, so it stops being a
model.

`?statArrayMerge` is default-OFF, so `static_array_pool.js`'s twin grow path is
inert unless the repro carries the flag.

**One latent bug found on the way past, not the stall but worth a ticket:**
`_layerCapacityFor`'s BC7 arm has a byte-aware floor
(`Math.min(nra ? 16 : 32, Math.max(4, c))`, commented "the trap the RGBA8 path
never hit"); the RGBA8 arm below it does **not** — it is a bare
`if (c < floor) c = floor`. A t2048 RGBA8+NRA bucket therefore gets capacity 16
at 32 MiB/layer = **512 MiB**, and `_atlasGrowTargetFor` doubles with no byte
clamp. That final grow *is* a 1.6 s candidate — but only on a machine without
BPTC, which the 1070 is not. Out of scope here; flagged so it is not lost.

### #5 — `?statBatchMemo=slack` — RULED OUT as the stall, but dead weight at ultra

It replaces work measured at **5.72 ms/frame**. A 100 %-miss frame is
`_memoBuildSlack` (a transcription of three's own non-sorted branch over the
same instances) plus ~48 float compares per bucket. A 280x blowup to 1.6 s is
not reachable by this code. **Tombstoned as a p99 cause.**

It is, however, **worth ~nothing at ultra**, and the file says so itself:
`onBeforeShadow` routes through `onBeforeRender` with the *shadow* camera, and
the memo has a single state slot. At ultra there are 4 cameras (main + 3
cascades) alternating into it, so `_memoDecide`'s
`if (st.camera !== camera || st.material !== material) return 0;` fires on
essentially every call -> hit rate ~0 -> every bucket pays a full rebuild 4x per
frame **plus** the memo's bookkeeping. The 5.72 ms it earned was measured at
`mid`, where `csm: false`. Run `?statBatchMemo=off` as a **median** control;
expect a few ms on p50 at ultra and **nothing** on p99.

### #6 — WebGL context loss — check it, do not assume it

`webgl_context_recovery.js`'s own header names `quality=ultra` + cloud RTs + CSM
as the loss trigger and records 7x/session. But a loss/restore emits two
`console.warn`s and pauses the pump — it would not present as a *silent* 1.6 s.
`__webglContextRecoveryHistory()` is a 16-entry ring with `downMs` per restore;
the probe samples its length every frame, so this costs nothing to rule in or
out. **Expect `[]`. If it is non-empty, that is a different bug and it wins.**

### #7 — GC / wasm memory growth — currently unmeasurable, and said so

No instrument exists. The probe samples `performance.memory.usedJSHeapSize`
(Chrome-only, non-standard) per frame: a **drop** across a long frame is GC
*evidence*, not GC proof. wasm linear-memory growth is **not** sampled —
`__hbWasmNs` is module-scoped inside `index.html` and never published on
`window`. A `memory.grow` copies the whole linear memory and would land in
`outsideMs` inside `residualMs`. **If the residual is large and nothing else
moves, exposing the wasm memory object is the next step.**

---

## The instrument: `scene3d/stall_probe.js`

`frame_split.js` splits the *average* render call fourteen timestamps deep. A
hitch that fires once in several hundred frames is a rounding error in its p50
and is not even in its p95. `__linkProbe.summary()` gives session totals with a
`worstMs` but no notion of which frame paid them. `__atlasStats()`,
`__landblockLru.getStats()`, `__xu7Stats()` are monotonic session counters.
Every one holds a piece and none can say *"these 1,630 ms, right here, were
spent on THAT"*.

### Method: difference already-cumulative counters across one frame edge

The probe does not time subsystems. The suspected work does not live in one
place — the transcode is in a detached `.then()`, the statics bake is behind
`setTimeout(0)` yields, the link is five call frames below anything we own.
Wrapping all of that is a week of risk for a question answerable by subtraction.

Instead: sample a fixed vector of counters once per `renderer.render` call, at
the same phase every frame, and when the interval between two samples exceeds a
threshold, push the **delta** into a ring buffer. The ring survives the stall.

This works because four buckets are already denominated in **milliseconds**:

| bucket | source | what it costs |
| --- | --- | --- |
| `linkStatusMs` | `__linkProbe.stats.linkStatus.ms` | synchronous driver link (#1) |
| `xu7DecodeMs` | `__xu7Stats().decodeMs` | XUBC7 -> BC7 transcode (#2) |
| `texAllocMs` / `texUploadMs` / `bufUploadMs` | this file's GL wrap | atlas grow, cold re-bake (#3, #4) |
| `syncMs` | this file's GL wrap | `readPixels` / `finish` pipeline flush |

So a long frame comes back as *"1,412 ms of LINK_STATUS, 187 ms of xu7 decode,
22 ms of texture upload, 9 ms unexplained"* — not as "7 decodes and 2 grows
happened". **Counts are carried in the per-frame `d` and are deliberately NOT
priced**; only ms-denominated buckets enter `explainedMs`. That is the rule this
investigation's six overestimates paid for.

### The one split that discriminates before any counter is read

`renderer.render` is wrapped as an own instance property (the `frame_split.js`
idiom), giving two timestamps per frame and therefore:

```
intervalMs = t0(n) - t0(n-1)       the frame period
renderMs   = t1(n-1) - t0(n-1)     inside renderer.render
outsideMs  = intervalMs - renderMs
```

That alone separates the top two suspects:

- **#1 shader link** is inside `setProgram` inside `renderBufferDirect` inside
  `renderer.render` -> **`renderMs`**.
- **#2 xu7 transcode** is a promise continuation between frames; **#3's bake**
  is behind `setTimeout(0)`; `tickEviction` is called from the rAF tick *after*
  `tickPerFrame` returns -> all **`outsideMs`**.

If a 1,630 ms frame is 1,600 ms of `outsideMs`, the whole shader story is dead
on arrival — a conclusion available in one run, before reading a bucket.

### What it costs, priced rather than assumed

Per render call: 2 `performance.now()` + one `_sample()` (~40 property reads
plus `__atlasStats()` walking ~29 buckets and `__landblockLru.getStats()`
building one object). Arm time measures the `now()` unit cost **and** the
sampler's own cost; `__stallReport().probe` carries both. The GL wrap adds
2 `now()` per texture/buffer upload and per sync point — tens of calls per frame,
not thousands — and the call **counts** are reported so the wrap can be priced
at `calls x 2 x nowCostNs` (`probe.glWrapOverheadMs`) rather than taken on
promise. If that number is a meaningful share of any bucket above it, say so out
loud instead of quoting the bucket.

No URL flag: zero frame time until armed, the contract `frame_split.js` and
`window.__statMergeProjection` established.

### How to invoke it

On the 1070, once in-world and settled at Nanto:

```js
// 1. arm. Defaults: threshold 100 ms, ring 64 long frames, GL wrap on,
//    link probe force-installed (no &linkProbe=on needed).
window.__stallArm()
// -> { armed: true, thresholdMs: 100, ring: 64, glWrapped: true,
//      linkWrapped: true, longtaskObserver: true, nowCostNs: ... }

// 2. MOVE for >= 60 s. @teleloc hops or a real walk — the stall is
//    motion-gated, and a parked arm will produce an empty ring.

// 3. read it.
window.__stallReport()
```

`__stallReport()` returns:

- `intervalMs.{p50,p95,p99,max,mean}` — from the **same clock** that filled the
  ring, so "p99 1630" and "the ring's worst entry" are the same frame by
  construction rather than by cross-referencing two harnesses.
- `long.{count, insideRenderMs, outsideRenderMs, totalMs, dropped}` — the
  discriminator, aggregated.
- `rankedMs` — `[bucket, ms, % of all long-frame time]`, sorted desc.
- `explainedMs` / `residualMs` — always both. A probe that cannot be wrong is
  not measuring anything.
- `probe.{nowCostNs, sampleMs, glCalls, glWrapOverheadMs, linkProbe}` — the
  instrument's own price.
- `ring` — every long frame, each with `intervalMs` / `renderMs` / `outsideMs`,
  its `d` (differenced accumulators), its `at` (levels: resident, liveGeom,
  programs, jsHeapMB and their trends), its `by` ranking, and any
  `PerformanceObserver` longtask entries overlapping the window.

Dump the raw evidence with
`JSON.stringify(window.__stallSamples())`. `__stallDisarm()` restores every slot
and **keeps** the ring; `__stallReset()` clears it.

Other knobs: `__stallArm({ thresholdMs: 200, ring: 128 })`,
`{ gl: false }` (drop the GL wrap if its overhead reads high),
`{ link: false }` (leave the link probe alone).

`frame_split.js` may be armed at the same time — both wrap `renderer.render`
and nest correctly. **Disarm in reverse arm order.**

### How to read the result

| what the report shows | conclusion |
| --- | --- |
| `outsideRenderMs` ≈ `totalMs`, `xu7DecodeMs` dominant | **#2.** Fix: budget the transcode, or move it into the bake worker. |
| `insideRenderMs` ≈ `totalMs`, `linkStatusMs` dominant | **#1.** First A/B: `?shaderPrewarm=on`. |
| `insideRenderMs` dominant, `linkStatusMs` small, `texAllocMs`/`texUploadMs` large | **#4.** Fix: chunk the grow / drop `buildNraArray`'s scalar fill. |
| `outsideRenderMs` dominant, all ms buckets small, `residualMs` ≈ `totalMs`, `d.lruEvicted`/`d.lruUnparked` large | **#3.** The cost is in the cold re-bake's un-instrumented CPU work. Next step is the `_reclaim`/`unpark`/`evict` accumulators. |
| `outsideRenderMs` dominant, `residualMs` ≈ `totalMs`, `at.jsHeapMBΔ` strongly negative | **#7 (GC)** — or wasm `memory.grow`, which we cannot yet see. Expose `__hbWasmNs.memory`. |
| `at.ctxEventsΔ > 0` | **#6.** Different bug, and it wins. |

---

## What a fix looks like

Deliberately **not** written yet — the brief asks for cause first, and a
well-argued cause with evidence beats a speculative patch. Sketches, in the
order the probe would justify them:

**If #1.** The A/B `shader_prewarm.js` was built for and which has apparently
**never been run**: `?quality=ultra&shaderPrewarm=on` vs off, scored on
`__stallReport().rankedMs.linkStatusMs`. The flag already exists, is already
default-OFF, and is already byte-identical when off. If it does not close the
gap, the reason is named in `shader_prewarm.js` and is structural: `renderer.compile`
only walks **scene** materials, so the CSM depth-material programs stay unwarmed
no matter what target is bound. The fix for that is a new default-OFF flag that
warms the depth variants explicitly (bind the warm target, set
`shadowMap.needsUpdate`, render one off-screen shadow pass over the newly baked
subtree at the end of `prewarmSubtree`) — cost paid once per LB in the bake
continuation, where a `setTimeout(0)` yield already exists, instead of once per
LB in the frame that first draws it.

**If #2.** A per-frame ms budget on the transcode, the shape
`statics.js STATICS_BUILD_BUDGET_MS = 6` already uses: `_begin`'s xu7 arm pushes
onto a FIFO, a drain function pulls under a `?xu7BudgetMs` cap (default-OFF, so
`off` is byte-identical) and yields with `setTimeout(0)`. Records not yet
transcoded keep taking the existing hbc7 route — the fallback contract already
covers that case and costs only bandwidth. The stronger fix is moving the decode
into `bake_worker.js` for real, which the file's comment already (wrongly)
claimed; that is a bigger change because the worker would need its own
transcoder instance and a transfer path for the BC7 levels.

**If #3.** Make the geometry-pressure governor stop destroying the cache it
depends on: keep the `PARK_USE_TIME_MS` floor under pressure for slots inside
the keep-ring, and let pressure only reach slots the streamer is not about to
re-adopt. Independently, `MAX_LIVE_GEOM` counts geometry the LRU cannot free,
so the trigger is unsatisfiable by construction once the non-LRU baseline
crosses it — the file's own comment says so. Both behind a default-OFF flag.

**Regardless of outcome**, two things should land because they are cheap and
already justified by reading:

- **Add an unpark-per-tick counter** to mirror `_parksPerTickMax`. Park is
  bounded and counted; unpark is unbounded and only cumulative, which is why the
  332/329 churn was visible only in aggregate.
- **Run `?statBatchMemo=off` as a median control at ultra.** Its 5.72 ms was
  earned at `mid` with `csm: false`; at ultra the single-slot memo cannot hit
  against 4 alternating cameras.

## Ruled out, tombstoned

- **`?statBatchMemo=slack` as a p99 cause.** Ceiling is single-digit ms; it
  replaces work measured at 5.72 ms/frame. (Its ultra hit-rate problem is real
  and separate — see #5.)
- **"the bake worker absorbs the xu7 decode".** It does not. There is no bc7/xu7
  symbol anywhere in `bake_worker.js`'s import graph. Comment corrected in
  `scene3d/xu7_textures.js`.
- **`?statArrayMerge`'s grow path** as a contributor on a default URL — the flag
  is default-OFF and the module is inert.
- **`shader_prewarm.js`'s `?linkProbe=on` being required** to price the link
  bucket. `installLinkProbe` now takes `{ force: true }` and `__stallArm()`
  passes it, so a 1070 session that forgot the flag is not wasted.
