# DESIGN — first-bake batches: the cold-boot spike is a batch-SIZE problem (2026-07-25)

> **STATUS (2026-07-25, post-validation-battery): cold-spike claim REFUTED — §5 criterion 3
> fired.** `bakeBatchMax=16` left per-session cold-boot maxMain in the same 678–934 MB
> lottery range as unbatched arms and cost settle (12.2 s vs 9.8 s). The handle-release fix
> (§2) is the part that survived — scored positive on worker wasm high-water (234 MB over a
> full 62-stop session, zero renderer deaths). The flag stays armable-but-off for
> submission-size experiments. See `RESULTS-validation-battery-2026-07-25.md` verdicts 2/4.
> §6's MaterialCache hypothesis was CONFIRMED (verdict 1) and is being landed as its own
> slice.

Executes move 2 of `HANDOFF-s4-battery-s5-preview-2026-07-25.md` ("admission is the wrong
tool (proven); try smaller first-bake batches") against the numbers in
`RESULTS-s4-battery-2026-07-25.md` and `HANDOFF-A15-landed-2026-07-25.md` verdict 2.

Every file:symbol below was opened and read in this worktree. Nothing is carried over from
another agent's doc without re-verification; two claims that *were* carried over turned out
to need correction and are flagged inline. **Anchor by symbol — line numbers drift.**

---

## 1. What the pipeline actually bounds (and what it does not)

Cold boot fans out over the PVS ring — `PVS_RING_RADIUS` defaults to 5, i.e. 11×11 = 121
landblocks (`scene3d/index.js` `PVS_RING_RADIUS`). Four independent gates pace that fan-out,
and **every one of them bounds concurrency**:

| gate | symbol | bounds |
|---|---|---|
| LB bakes in flight | `scene3d/cells.js` `PVS_STREAM_QUEUE` → `stream_bake_guard.js` `STREAM_BAKE_DEFAULT_MAX_IN_FLIGHT = 6` | how many landblock bakes run at once |
| worker messages in flight | `scene3d/bake_worker_client.js` `_pump` / `DEFAULT_BAKE_QUEUE_CAP = 4` | how many requests are posted at once |
| decode leases | `src/decode_admission.rs` via `decode_admit` | how many decodes run at once (S4) |
| HTTP fetches | `concurrency.rs` `DEFAULT_FETCH_CONCURRENCY` split 24/8 by `applyFetchConcurrencySplit` | how many shard fetches run at once |

**Nothing bounds how large a single submission is**, and the batched wasm exports materialise
their entire decoded output before returning:

- **`fetch_surfaces_pixels`** (`apps/holtburger-web/src/lib.rs`) builds
  `results: Vec<Option<SurfacePixels>>` sized to the input DID list, fills it across the
  `batch_split_ranges(uncached.len(), chunk)` loop, and only then converts to the returned
  `js_sys::Array`. `SURFACE_BATCH_SPLIT_CHUNK = 16` chunks the *walk* and the decode lease —
  `let mut _lease = decode_admit(...)` and `let mut decoded_bytes = 0usize;` are both **inside**
  the chunk loop, so the lease (and its `revise`d byte figure) is dropped and re-taken every 16
  DIDs while `results` keeps growing. The batch's accumulated decoded footprint is therefore
  **invisible to the decode gate by construction**.
- **`fetch_model_meshes`** (same file) takes **one** lease for the whole call —
  `decode_admit(estimate_record_bytes(source.as_ref(), &model_ids), urgent)` — and never
  `revise`s it, so the byte guard sees *wire* bytes while `out: Vec<ModelMesh>` accumulates
  every *packed* mesh. The in-code comment states the consequence outright: *"the peak this
  bounds is the whole `out` vector of packed meshes, not any single triangulation."*
- **`fetch_building_placement`** (same file) is per-model — one lease, all parts of one setup.

### The submitters have no size cap either

- `scene3d/materials.js` `MaterialCache.preload` filters to `need`, then issues exactly one
  call: `const ids = new Uint32Array(need); const sharedFetch = fetchSurfacesPixels(ids);`.
- `scene3d/statics.js` `fetchPrimaryGeometries` issues exactly one call:
  `meshes = await fetchModelMeshes(new Uint32Array(uniqueModelIds))`.
- `scene3d/buildings.js` ring Stage 3 fans out
  `Promise.all(toBake.map((id) => bakeBuildingPlacement(id, wasmExports.fetchBuildingPlacement)))`
  — unbounded parallelism, and on the **main** wasm instance (this call site is the raw
  `wasmExports` export, not a worker-routed fetcher). Stage 4 then issues one ring-wide
  `materialCache.preload([...allSurfaceDidsSet], surfacePixelsFetcher(wasmExports))`.

**Correction to a premise worth recording:** the ring drivers (`bakeStaticsRing`,
`bakeBuildingsRing`, `bakeTerrainRing`) are *not* the live cold-boot path —
`scene3d/index.js` records "HOLTBURG_RING_RADIUS retired (spawn-driven-boot): the eager boot
ring is gone", and `statics.js` / `buildings.js` note the ring exports remain only "for any
explicit-centre caller (tests/captures)". The live path is per-LB
(`bakeStaticsForLandblock` → `materialCache.preload([...primary.allSurfaceDids], spFetch)`),
paced at 6 LBs in flight. So a cold boot is **not** one 121-LB submission; it is a burst of
up to 6 concurrent per-LB submissions, sustained until the ring drains. That still makes cold
boot the largest simultaneous decode set the process ever holds — steady-state hops re-enter
the same code against warm `MaterialCache`/memo state and submit deltas — which is exactly
`HANDOFF-A15-landed-2026-07-25.md` verdict 2's "high-water set at hop 1, never moves again".

### Why this explains the S4 refutation mechanically

`RESULTS-s4-battery-2026-07-25.md` finding 3: the *tightest* arm (armT, `1x16+1`) matched
unbounded's peak; armB's session-0 max (985 MB) was the battery's worst. A concurrency gate
cannot shrink a single submission — **one call is one lease** — so at cap = 1 the same
ring-sized batch still runs; it just runs alone, and its backlog grows behind it. The gate's
byte guard cannot compensate either, because for meshes it is never revised off the wire-byte
estimate and for surfaces it only ever sees one 16-DID chunk. **Admission was measuring and
bounding the wrong axis.** The remaining axis is batch size, and only the submitter owns it.

---

## 2. The other half of the mechanism: the worker never released what it copied out

This is the finding that changes the shape of the lever, and it was found by reading, not
inferred:

- `scene3d/bake_worker.js` `handleSurfaces` / `handleModelMeshes` / `handleEntitySurfaces`
  called `serializeSurfacePixelsBatch` / `serializeModelMeshes` (`scene3d/bake_transfer.js`)
  and posted the result. **Neither handler called `.free()` on the wasm handles.**
- `scene3d/bake_transfer.js` `serializeEntitySurfacesBatch` — the F.41 batch sibling — *does*
  free ("Pixels are copied out; the wasm handles can go now"). So this was an inconsistency,
  not a design decision.
- The only other reclaim path is wasm-bindgen's finaliser: `pkg/holtburger_web.js`
  `const SurfacePixelsFinalization = … new FinalizationRegistry(ptr => wasm.__wbg_surfacepixels_free(ptr >>> 0, 1))`
  (and the `ModelMesh` twin). That is **GC-timed**.
- The main thread was already fine: `scene3d/materials.js` `_installFromPixels` frees the
  handle on its install, already-installed and zero-dim exits. (The getter-throw exit does
  not, but that path is entered precisely when the handle is *already* freed — the F4
  double-consume guard — so there is nothing to release.)

Consequence: in the bake worker, every completed batch's decoded planes (~8 B/px for a
surface: `pixels` RGBA8 + `normal_pixels` RGB8 + `height_pixels` R8) stayed resident in that
instance's linear memory until a GC — during a cold-boot decode burst, precisely the moment
the runtime is least likely to run one. And because `WebAssembly.Memory` never shrinks (the
same property `?decodePressure`'s doc calls out), one deferred sweep sets that instance's
high-water permanently.

**This is why batch-splitting alone would have failed.** Splitting a 300-DID request into
waves of 48 does not lower the peak if the previous waves' handles are still live; the corpses
accumulate to exactly the same footprint as one big batch. The two parts are one lever.

Freeing after serialize is safe, and this was verified rather than assumed:
`SurfacePixels::pixels` / `normal_pixels` / `height_pixels` and every `ModelMesh` getter are
`self.<field>.clone()` in `src/lib.rs`, i.e. wasm-bindgen copies out of linear memory into a
fresh JS typed array; `serialize*` reads each getter exactly once (`pushBuffer` doc); the
call-level audit is `extractSurfaceAudit(surfaces)` on the **Array** (plain stamped props, not
handle-backed) and is extracted inside `serialize*` before the free; duplicate DIDs get
distinct objects (`fetch_surfaces_pixels` uses `clone_surface_pixels` for repeat positions),
so there is no double-free; and `free()` self-`unregister`s from the FinalizationRegistry.

### What this fix does NOT address: the late-session 3.6 GB JS-heap kill

A battery soak finished after this branch was written: on the 62-POI route the renderer's
`performance.memory` JS heap sat at ~98 MB for ~40 stops of a long session, then jumped to
**~3.6 GB** from stop *Timaru* onward, and the renderer died a few stops later — while wasm
main memory stayed flat at 384–440 MB throughout. **The handle release above is not the fix
for that**, and it is worth being explicit about why rather than claiming an adjacent win:

- `FinalizationRegistry.register(obj, ptr, obj)` holds its **target weakly**. A deferred
  `free()` therefore retains no JS-heap bytes — it retains the Rust `Box` in **wasm linear
  memory**. `performance.memory` reports the JS heap only; `WebAssembly.Memory` is accounted
  separately in Chrome.
- The gap was in the **bake worker**, which is a separate V8 isolate. A main-thread
  `performance.memory` sample never saw it in the first place.
- The soak's own numbers say the same thing from the other side: wasm main was *flat* while
  the heap went 37×. Two different arenas, and this fix is aimed at the one that did not move.

So 259dbd5a stands on its own evidence (worker wasm linear memory, §2) and must be measured on
its own metric (per-session max **worker** `wasmMemoryBytes` — §4 armF, §5 criterion 1). It
predicts **nothing** about `jsHeapPeakMB`, and an arm that shows no JS-heap change is not
evidence against it. The 3.6 GB observation is carried as an open item in §6.

### Noted, not taken: option (E), the 2× clone transient

`DESIGN-surface-budget-2026-07-25.md` option (E) is real and read-verified —
`surface_memo_insert` does `Arc::new(clone_surface_pixels(sp))` *while the caller keeps the
original*, so a cold decode transiently holds 2× the entry. It is a **per-entry constant
multiplier**, not a per-batch accumulator: it multiplies whatever the batch peak is rather
than setting it. Fixing it is worth ~1× of one entry (≤ 2 MiB for a 512²) at any instant;
fixing the accumulation is worth N× that. Out of scope here, still worth doing after.

---

## 3. The lever: `?bakeBatchMax=N`

**One host-supplied flag, default-neutral, page-side.**

| | |
|---|---|
| flag | `?bakeBatchMax=N` (integer ≥ 1; `off`/`0`/garbage/absent ⇒ uncapped) |
| parse | `scene3d/bake_worker_client.js` `parseBakeBatchMax` / `resolveBakeBatchMax` |
| split | `splitBatchWaves(len, cap)` — returns one whole-batch range when `cap ≤ 0` **or** `len ≤ cap`; mirrors the Rust `batch_split_ranges` shape |
| applied at | `BakeWorkerClient.fetchSurfacesPixels` and `.fetchModelMeshes` (the two worker-routed funnels every LB bake goes through) |
| pre-flag body | preserved verbatim as `_fetchSurfacesPixelsOnce` / `_fetchModelMeshesOnce` |
| observability | `__diag.bakeWorkerStats().batchMax` (+ the existing per-type `count`, which multiplies by the wave factor when armed) |

Armed and exceeded, a request splits into `ceil(len/N)` **sequential** waves (`await` between
them — concurrent waves would rebuild the very peak being cut), results concatenate in input
order (every consumer binds by index into the DID list it passed — `materials.js::preload`
does `need.indexOf(d)`, `fetchPrimaryGeometries` does `meshes[i]`), and the call-level decode
audit merges across waves the same way `_stitchSplit` merges the two alias legs: `decodeMisses`
sums, `provenAbsent` unions. Legs without an audit (legacy wasm) leave the stitched result
legacy-shaped, so `materials.js::surfaceResultProvenAbsent` never poisons its negative cache.

### Why page-side and not Rust-side

A Rust cap cannot help: the export's contract is to return the *whole* batch, so
`fetch_surfaces_pixels` must hold all N decoded entries at return regardless of how it chunks
internally — which is exactly what `SURFACE_BATCH_SPLIT_CHUNK` already demonstrates. **The
only place a batch can actually be made smaller is the submitter.** Hence: no Rust change, no
worker `init` plumbing (the worker simply receives smaller messages), and no Rust-side URL
flag — consistent with the A15 house rule that every gate is host-supplied.

### Neutrality (pinned by test, not by inspection)

- `cap = 0` **or** `len ≤ cap` ⇒ one round trip that receives the caller's **original**
  argument object, not a copy (`calls[0] === DIDS` in the suite).
- `!this.active` (`?bakeWorker=0`, no `Worker`) ⇒ straight to the raw wasm export, untouched —
  the `modelMeshFetcher` reference contract is not disturbed.
- Entity-surface paths (`fetchEntitySurfacesPixels`, `fetchEntitySurfacesPixelsBatch`) are
  deliberately left alone: they are per-entity / per-LB shaped and carry palette state whose
  group encoding makes a wave split disproportionate (the same reason the alias split routes a
  whole entity batch to main).

### What ships unconditionally

The worker handle release (`freeWasmHandles` in `bake_transfer.js`, called from the three
worker handlers) is **not** behind the flag. It is a defect fix — it restores the behaviour
`serializeEntitySurfacesBatch` already had — and gating it would make the flag do two things
and make the waves useless when the flag is off. It must therefore be measured on its own arm
(§4 armF) before the flag arms, or the two effects get conflated.

---

## 4. How to A/B it on the 62-POI battery

Rig unchanged from `RESULTS-s4-battery-2026-07-25.md`: `battery-telepoi.mjs --mode local`,
full `telepoi-list-2026-07-10.txt`, `--dwellMax 45`, **release** wasm, `nullRender=1&nosw=1`,
local ACE, fresh Playwright profile per session, exit 3 ⇒ relaunch with `--resume`,
≥ 70 s between arms (ACE "Account In Use").

| arm | build | query | asks |
|---|---|---|---|
| **armM** | master (`c847c848`) | (none) | baseline; re-establishes the boot-town-matched high-water |
| **armF** | this branch | (none) | does the handle release alone move the worker high-water? |
| **armC** | this branch | `bakeBatchMax=48` | the candidate production arm |
| **armD** | this branch | `bakeBatchMax=16` | deliberately tight — must move the peak further than armC, or the mechanism is wrong |
| **armN** | this branch | `bakeBatchMax=off` | negative control; must reproduce armF within noise |

**Primary artifacts, per session, matched on boot town** (the battery's own trap — session
boot town swings maxMain 383↔681 MB on its own):

1. **per-session max `wasmMemoryBytes` for BOTH instances.** The battery currently relays
   `{main, worker}`; the worker number is the one this lever most directly predicts, and the
   S4 write-up leads with main. Report both, always, side by side.
2. **time-to-first-renderer-death** in stops (S4 baseline: unbounded crashed at stops
   ~7/32/53; armB s0 died 3 stops in).
3. **`settleMed(work)`** — the cost check. armT's +4.4–7 s is the shape to avoid.
4. **`__diag.bakeWorkerStats()`**: `batchMax` (arm proof) and
   `byType.fetchSurfacesPixels.count` / `byType.fetchModelMeshes.count` (wave proof — armed
   counts must exceed armN's; equal counts mean the flag never bound and the arm is void).

**Fields to add to the relay before running** (the JS-heap one is now known to be load-bearing
— see §6):

- `performance.memory.usedJSHeapSize` → `jsHeapPeakMB` per stop. **This lever predicts nothing
  about it.** It is relayed so §6's separate leak stays visible, not as an artifact of this arm.
- `materialCache.materials.size` / `.textures.size` — the §6 discriminator. There is no diag
  for these today (`diag/assets.js` exposes only `materialCache.pendingFetches.size`), so this
  is a small new field, and it is the single most valuable addition to the relay right now.
- `decodeAdmission.*` and `shardCacheBytes` per the S4 handoff's move 1.

If the JS heap is what kills the renderer, this lever will show a clean **worker** wasm-memory
win and *no* crash-cadence improvement — a legitimate, informative outcome, not a failure of
measurement.

---

## 5. Refutation criteria (what result kills this)

State them before running.

1. **Mechanism refuted for the worker.** If armD (`=16`) does not reduce per-session max
   worker `wasmMemoryBytes` by ≥ 15 % vs armF on a boot-town-matched session, batch size is
   not what sets that instance's high-water. The lever is dead as shipped; keep only the
   handle release.
2. **Monotonicity refuted.** If armD is not ≤ armC on worker max, the split is not acting like
   a size bound (suspect the wave loop re-entering through the alias-split path, or the memo
   cache dominating). Either way the model is wrong.
3. **Main's spike is elsewhere.** If worker max drops as predicted but main's 681–985 MB
   cold-boot high-water is unchanged, then **main's spike is not decode-batch driven** — the
   lever is real but aimed at the smaller instance, and the next investigation must target
   main-only allocators: `fetchBuildingPlacement`'s unbounded `Promise.all` fan-out
   (`buildings.js` Stage 3), the terrain atlas (`fetch_terrain_textures` /
   `fetch_terrain_alpha_masks`, explicitly not offloaded), the alias residue
   (`partitionTexSwapAliasDids`), or the session/physics state that lives in main's wasm.
   *This is the outcome I consider most likely, and the arms are designed to distinguish it.*
4. **Cost too high.** If armC regresses `settleMed(work)` by > 2 s median vs armF, the flag
   stays a host-supplied diagnostic and is never defaulted — the armT shape.
5. **Neutrality broken.** If armN differs from armF beyond noise on any artifact, the "absent
   ⇒ bit-for-bit" claim is false and the change must be reverted, tests notwithstanding.
6. **Release fix regression.** If armF shows *more* renderer deaths or higher worker max than
   armM, the unconditional free is harmful (unexpected live reader after serialize) and must be
   reverted before anything else is interpreted.

A result that would *confirm* the model: armF < armM on worker max (deferred-GC residue
removed), armD < armC < armF (size bound acting), and time-to-first-renderer-death increasing
monotonically across that same order at flat settle.

---

## 6. OPEN ITEM — the late-session 3.6 GB JS-heap kill (not this lever)

**Observation** (62-POI battery, per-500 ms `performance.memory` poll): JS heap flat at ~98 MB
for ~40 stops, step to ~3.6 GB from *Timaru* onward, renderer death a few stops later; wasm
main flat 384–440 MB throughout. 3.6 GB is right against Chrome's typical ~4 GB
`jsHeapSizeLimit`, so this is a straightforward renderer OOM, and it is **late-session and
route-length-dependent** — the opposite shape to the cold-boot spike this branch targets.

### Best-evidence hypothesis (read-verified this session, `scene3d/`)

`MaterialCache` is an **unbounded, monotone, never-evicted JS-heap retainer keyed on distinct
surface DIDs ever seen** — precisely a quantity that grows with route length and not with boot:

- `materials.js` declares `this.materials` / `this.textures` / `this.normalTextures` /
  `this.heightTextures` as plain `Map`s. A grep for `.delete(` / `.clear()` on any of the four
  returns **zero hits** — only `palettedMaterials` / `vfxPalettedVariants` are capped
  (`PALETTED_CACHE_CAP = 256`), and only page-teardown `dispose()` frees anything.
- `adapter.js` `surfacePixelsToTexture` **always copies**: *"Always copy: the wasm side can
  re-allocate linear memory between this call and the GPU upload, detaching the original
  buffer."* The copy becomes `THREE.DataTexture.image.data` and is retained by the Map above.
  So each cached DID pins ~8 B/px of JS heap (RGBA8 + RGB8 normal + R8 height) — ~2 MiB for a
  512² surface. **~1,800 distinct surface DIDs ≈ 3.6 GB**, which a 40+ town roam reaches
  comfortably.
- The battery runs `?nullRender=1`, which skips `render()` — so these DataTextures are never
  uploaded and never GPU-disposed. In this rig the retention is a **pure JS-heap** accumulator,
  which is exactly the arena that died.
- Note also that the always-copy rationale is **stale for the default path**: worker-routed
  pixels arrive as *transferred*, non-wasm-backed `ArrayBuffer`s (`bake_transfer.js`
  `pushBuffer`), so there is no linear memory to be detached and the copy is pure waste —
  a cheap, independent follow-on.

The step shape (flat, then 37× in a few stops) is the one part a monotone retainer does not
explain on its own — but **the soak's own trap list already resolves it**:
`RESULTS-s5-soak-2026-07-25.md` records *"`performance.memory.usedJSHeapSize` is coarsely
quantized (identical readings for ~40 stops, then a jump) — treat it as a step detector, not a
gauge."* A step detector over a monotone retainer produces exactly the observed trace. That
makes H1 the leading reading, but it is still worth discriminating, and one field does it:

| | reading | what `materialCache.materials.size` per stop does |
|---|---|---|
| **H1** (leading) | real monotone retention, invisible until the quantized sampler stepped | grows ~**linearly from stop 1**, long before the heap number moves ⇒ H1, and the fix is an LRU + `dispose()` on `MaterialCache` (a different lever from this branch) |
| **H2** | genuine late regime change — one stop introduces a new allocation class (EnvCell/dungeon-dense town, a retry storm, a per-frame allocation that only starts under some condition) | roughly **flat across the jump** ⇒ H1 refuted; bisect the route on the Timaru boundary |

**Confirming signal for a future fix**: `jsHeapPeakMB` per stop staying flat across the whole
62-POI route (no step, no monotone climb), with `materialCache.materials.size` bounded by
whatever cap the fix installs — and time-to-first-renderer-death extending past the full route.

### ⚠ Disagreement to settle before the next battery is interpreted

`RESULTS-s5-soak-2026-07-25.md` disposition item 2 nominates **259dbd5a as "the primary lever
against BOTH the age collapse and late deaths"**, with the falsifier *"after the handle-release
fix, `jsHeapPeakMB` stays flat over a 40-stop session"*. **On the code, that falsifier will
fire, and it should not be read as the fix being worthless.** The reasoning (§2 addendum):

- a deferred `free()` retains the Rust `Box` in **wasm linear memory**, which
  `performance.memory` does not count in any implementation; the JS wrapper is held **weakly**
  by the FinalizationRegistry and was always collectible;
- the gap was in the **bake worker**, whose wasm high-water the soak measured at 247–301 MB
  (`maxWkr`) — three orders off 3.6 GB;
- the soak's own s1 row says wasm-side *nothing moved* while the heap went 37×. A wasm-side fix
  cannot explain a metric that moved while wasm did not.

What 259dbd5a **does** predict, and how to score it fairly:

| prediction | metric |
|---|---|
| lower worker wasm high-water | per-session max **worker** `wasmMemoryBytes` (§4 armF vs armM) |
| less GC/finaliser work in the worker isolate — thousands of pending FinalizationRegistry entries per burst become zero | worker-side settle contribution / the age-collapse curve; this is the *only* channel by which it could touch the age collapse, and it is indirect |
| **nothing** about main-thread `jsHeapPeakMB` | — |

So: keep 259dbd5a in the validation battery, but score it on worker wasm memory, and keep the
`MaterialCache` retention (H1) as the separate, still-unlanded candidate for the 3.6 GB kill.
Bundling them would make both unfalsifiable.

This is a **separate lever from `?bakeBatchMax`** and should not be bundled with it: batching
bounds a transient in wasm linear memory; this is a retained set in the JS heap. Recommend it
as the next slice, ahead of the surface-budget work — `DESIGN-surface-budget-2026-07-25.md`
already found the same cache from the other direction ("main has an unbounded JS cache in front
of it") but scoped its recommendation to the *wasm* budget, which this soak now shows is not
where the process dies.

---

## 7. What changed

| file | symbol | change |
|---|---|---|
| `apps/holtburger-web/scene3d/bake_transfer.js` | `freeWasmHandles` (new); `serializeEntitySurfacesBatch` | extracted the existing free loop into a guarded, counted, exported helper |
| `apps/holtburger-web/scene3d/bake_worker.js` | `handleModelMeshes`, `handleSurfaces`, `handleEntitySurfaces` | release the wasm handles after serialize (unconditional defect fix) |
| `apps/holtburger-web/scene3d/bake_worker_client.js` | `parseBakeBatchMax`, `resolveBakeBatchMax`, `splitBatchWaves` (new); `BakeWorkerClient.constructor`/`configure`; `fetchSurfacesPixels`/`_fetchSurfacesPixelsOnce`; `fetchModelMeshes`/`_fetchModelMeshesOnce`; `__diag.bakeWorkerStats` | the `?bakeBatchMax=N` wave split |
| `apps/holtburger-web/test_bake_transfer.mjs` | — | 4 `freeWasmHandles` assertions (39 → 43) |
| `apps/holtburger-web/test_first_bake_batch_flags.mjs` | — | new: 45 assertions (grammar, wave tiling, negative control, order + audit merge) |
| `apps/holtburger-web/docs/url-flags.md` | `bakeBatchMax` row | — |

No Rust source was touched (see §3 for why a Rust cap cannot work).
