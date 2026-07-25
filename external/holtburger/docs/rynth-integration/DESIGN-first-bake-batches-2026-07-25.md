# DESIGN — first-bake batches: the cold-boot spike is a batch-SIZE problem (2026-07-25)

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

Per the S4 handoff's move 1, extend the relay's field list with `performance.memory` (JS heap)
before running: the S4 traps record that the cold-spike killer may not be wasm linear memory
at all, and this lever's whole claim is about wasm linear memory. If JS heap is what kills the
renderer, this lever will show a clean wasm-memory win and *no* crash-cadence improvement —
which is a legitimate, informative outcome, not a failure of measurement.

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

## 6. What changed

| file | symbol | change |
|---|---|---|
| `apps/holtburger-web/scene3d/bake_transfer.js` | `freeWasmHandles` (new); `serializeEntitySurfacesBatch` | extracted the existing free loop into a guarded, counted, exported helper |
| `apps/holtburger-web/scene3d/bake_worker.js` | `handleModelMeshes`, `handleSurfaces`, `handleEntitySurfaces` | release the wasm handles after serialize (unconditional defect fix) |
| `apps/holtburger-web/scene3d/bake_worker_client.js` | `parseBakeBatchMax`, `resolveBakeBatchMax`, `splitBatchWaves` (new); `BakeWorkerClient.constructor`/`configure`; `fetchSurfacesPixels`/`_fetchSurfacesPixelsOnce`; `fetchModelMeshes`/`_fetchModelMeshesOnce`; `__diag.bakeWorkerStats` | the `?bakeBatchMax=N` wave split |
| `apps/holtburger-web/test_bake_transfer.mjs` | — | 4 `freeWasmHandles` assertions (39 → 43) |
| `apps/holtburger-web/test_first_bake_batch_flags.mjs` | — | new: 45 assertions (grammar, wave tiling, negative control, order + audit merge) |
| `apps/holtburger-web/docs/url-flags.md` | `bakeBatchMax` row | — |

No Rust source was touched (see §3 for why a Rust cap cannot work).
