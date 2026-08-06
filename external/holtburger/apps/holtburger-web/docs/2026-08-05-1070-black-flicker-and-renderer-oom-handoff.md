# 1070 black flicker + renderer OOM — handoff (2026-08-05)

Session ran on the 1070 (GTX 1070, ANGLE/D3D11, Chrome 150, offscreen profile
`C:\Temp\cdpwb-leak`) against the live laptop ACE + `serve.py --port 8770 --bind 0.0.0.0`.
Two user-visible faults were reported: **the screen flickering black**, and **statics
being culled and repeatedly replaced at the edge of view**. They turned out to be three
unrelated problems. Two are fixed; the one that actually crashes the tab is not.

---

## 1. LANDED — terrain shader over-subscribed the GPU's texture units

**Symptom:** intermittent full-screen black frames.

`MAX_TEXTURE_IMAGE_UNITS` is **16** on this GPU under ANGLE/D3D11. The terrain program
declared **18 active sampler uniforms**. When three.js can't allocate a unit it warns and
falls back to unit 0, so terrain samples the *wrong* texture — and terrain fills most of
the frame. Which samplers lose the race varies per frame; that is the flicker.

Confirmed by hooking `renderBufferDirect` — **138 overflow warnings in 5 s, all from one
material**:

```
"terrain-batch | terrain-batch-x | 16" × 69
"terrain-batch | terrain-batch-x | 17" × 69
```

Four of the 18 were declared but bound to nothing: `uSnowTrailMap` and
`uCsmShadowMap0/1/2` (shadows and CSM both off at quality `mid`). They were declared
*and referenced* unconditionally, so GLSL kept them ACTIVE and no URL flag could turn
them off — `?cloudShadow=off` only drops one, leaving 17.

**Fix:** `scene3d/terrain.js` gates those declarations behind `HB_TERRAIN_TRAIL_MAP` /
`HB_TERRAIN_CSM`, set from the same conditions the features are built from
(`terrainTrailEnabled()` and `scene3d?.csmState`). A live feature compiles byte-identically
to the pre-fix program. `scene3d/terrain_batch.js::_buildBatchMaterial` copied uniforms and
`fog` but **not `defines`** — same omission class as the `fog` bug documented right above
it — so the batched material (the one that actually draws terrain) would have compiled the
wrong variant. Fixed too.

**Verified on the real GPU:** samplers 18 → **14**; texture-unit warnings 138-in-5s →
**0 in 20 s**; canvas grabs rendering 1-of-3 → **8-of-8** (86–96 % non-black).

> ⚠ Trap for the next editor: the fragment GLSL lives in a JS template literal.
> **Backticks in a GLSL comment terminate the string.** I hit this on the first pass;
> TS diagnostics caught it immediately. (This is the standing house rule.)

---

## 2. LANDED — `?matBudgetMB` default armed at 384 MB

`MaterialCache`'s four per-DID maps were documented as *"a monotone retainer over distinct
surface DIDs ever seen, i.e. a function of ROUTE LENGTH, not of boot"* — and the budget
LRU built for it in 2026-07-25 was **default-unbounded**. Now armed at 384 MB
(`MAT_BUDGET_DEFAULT_MB`), ~3× the measured ~115–130 MB town working set (~760 DIDs).

Grammar change: **absent or unparseable ⇒ the default**; only explicit `off`/`0` disarm.
A typo must not silently uncap memory (same class as the `!== "off"` footgun this flag's
own tests warn about). `?matBudgetMB=off` restores the never-evicted maps bit-for-bit.

**Verified live** over Holtburg → Arwic → Yaraq → Sawato → Shoushi → Nanto:

```
Yaraq   matCache 490 DIDs / 383MB  evicted=107  greyFallback=0/6083
Nanto   matCache 502 DIDs / 386MB  evicted=253  greyFallback=0/4465
```

Pinned at the cap, 253 evictions, **zero grey fallback surfaces** — the documented
FOOTGUN did not fire.

> ⚠ STILL OWED: the ABAB settle-within-noise interleave `?surfaceBudgetMB` got before it
> was armed (`RESULTS-abab-surface-budget-2026-07-26.md`). This arming rests on a crash
> plus a heap snapshot, not on an A/B.

**Also fixed:** `test_mat_budget_lru.mjs` threw `bc7TextureBytes is not defined` —
the `bc7_textures.js` import is stripped by the harness's module loader and was never
stubbed, killing the suite before sections 6 and 7. **Reproduced on an unmodified
checkout, so it predates this work.** Suite is now **123 passed / 0 failed**.

---

## 3. NOT FIXED — the actual renderer OOM: wasm linear memory

Arming the material budget **did not stop the crash.** Heap over the same route with the
cap active: 138 → 1,271 → 1,610 → 1,978 → 2,162 → 2,717 → **2,808 MB**, against Chrome's
**4,192 MB** renderer cap. Tab OOM-crashes (black screen, auto-reload, `navigation.type ===
"reload"`, uptime resets, any live sky pin lost) — observed 3+ times this session.

**`window.__hbWasmMemory`: 58 MB at boot → 700 MB after the route.**

`WebAssembly.Memory` can only grow — it never shrinks, never gives memory back. Every
spike permanently raises the floor, and the bake worker holds a *second* instance with its
own linear memory. `?surfaceBudgetMB` already caps the wasm surface-pixel cache at 24:64 MB,
so the growth is elsewhere.

> ⚠ **The cache list this section originally named was wrong. See §7.** It read the
> `thread_local!` declarations and assumed unbounded; three of the four hold trivial
> amounts and the triangulation memo has been byte-budgeted since S14. §7 replaces it
> with a verified audit and an instrument that measures instead of guessing.

---

## 4. NOT FIXED — geometry disposal (GPU-side, unbounded VRAM)

`renderer.info.memory.geometries` climbs **monotonically and never decrements**: 65 →
15,081 over a 4-hop route, while scene-reachable fell to ~2,000. A `BufferGeometry` that is
GC'd without `dispose()` leaves its `WebGLBuffer` allocated in the GL context forever.

Created-vs-disposed by caller (4 hops):

```
   live   created  disposed  caller
   6797      6797         0  animation.js:687   <- adapter.js:981
   5320      5320         0  statics.js:4001    <- adapter.js:981
   4910      5119       209  statics.js:841     <- adapter.js:981
    857       857         0  static_batch_x.js:377
    697       697         0  cells.js:1043
    296       296         0  cells.js:1424
    286       286         0  entities.js:12656
    195       195         0  cells.js:833
    193       193         0  terrain_batch.js:803
```

Flagship is `animation.js:420-432`, whose comment states the wrong model outright:

> *"Eviction just drops the cache entry … dispose happens via normal GC when the last
> entity using a geometry despawns."*

GC frees the JS object; it does **not** free the GPU buffer. The cache defers to entities,
`EntityInstance.dispose`'s FU3 guard defers to the cache (`__disposable` / `__cacheOwned`),
so nobody disposes. A refcount (increment in `registerGeometry`, decrement in entity
dispose, dispose at zero *and* evicted) is the shape of the fix.

**This is VRAM, not RAM — it will not move the OOM.**

---

## 5. Dead ends — do not re-derive these

- **"702 MB of leaked geometry" is WRONG.** Counting bytes at `setAttribute` and
  subtracting at `dispose` overcounts massively: `BatchedMesh.setGeometrySize` *replaces*
  attribute arrays on every growth doubling, and the superseded arrays are GC'd normally.
  A WeakRef census is the honest instrument: of 71,318 traced geometries **59,981 were
  GC'd**; only **28 MB** is orphaned-and-alive. Geometry is a rounding error in the heap
  (`BufferAttribute` holds 40 MB in the snapshot).
- **"Textures are ~1.2 GB CPU-side" is WRONG.** That conflated a `w*h*4*layers` GPU-size
  *estimate* with CPU retention. Actual `image.data` for in-scene textures is **314 MB**.
- **Black canvas screenshots are NOT always a capture artifact.** I dismissed the first
  ones as such; they were the real bug (§1). `renderer.info` reading `calls:1, tris:1` at
  grab time is `autoReset` firing mid-frame, not proof the scene stopped drawing.

---

## 6. Recipes

**Single-login race (cost 2 runs):** reconnecting as the same account while ACE still holds
the old session in-world boots BOTH (`Account In Use` in `ACE_Log.txt`) and the client dies
with `no CharacterList within 30s`. Navigate to `about:blank`, wait **90 s**, and reconnect
on the spare account (`phase4demo`), not `tailnet1`.

**Heap attribution (the one that worked):**
```js
cdp.send('HeapProfiler.takeHeapSnapshot')      // ~284 MB streamed to /mnt/wbterminal2
```
Then walk retainers level by level, claiming each target once to avoid double-counting
views (several typed-array views share one buffer; wasm-bindgen keeps `Uint8Array` /
`Uint32Array` / `DataView` views over the wasm heap, so level-2 numbers lie). Result:
`system / JSArrayBufferData` **2,021 MB of a 2,184 MB heap**, resolving at level 5 to
`DataArrayTexture` 398 MB / `DataTexture` 115 MB / `CompressedArrayTexture` 82 MB /
`CompressedTexture` 74 MB, plus a `WebAssembly.Instance` at 423 MB.

**Quality preset auto-detects to `mid` on a 1070**, and frame budget was median 61.5 ms
(~16 fps), p95 89 ms, worst 279 ms, at 1,058–1,598 draw calls, `?renderScale=1&adaptiveRes=off`.

**LB residency churn** (the "culled and replaced at the edge" report): 332 adds / 329
removes in 30 s, resident oscillating 29↔39. NOT the count cap (`maxResident` is 203) —
it is the memory-pressure governor parking landblocks that the streamer immediately
re-adopts, and our path re-decodes each one on the way back. Downstream of §3.

---

## 7. LANDED — the wasm memory census (`__diag.wasmMem`), and what §3 got wrong

§3 named five caches from their `thread_local!` declarations and recommended a byte-budget
LRU over them. Reading each one against the code first:

| §3's claim | verified | notes |
|---|---|---|
| triangulation memo unbounded | **WRONG** | `MODEL_TRI_CACHE` has been a `ByteBudgetLru` at **64 MiB** since S14 (`MODEL_TRI_CACHE_BUDGET_BYTES`, `src/lib.rs:8849`). Its own doc-comment says the entry-COUNT bound it replaced was root-caused as this exact RSS-growth class. |
| anim cache `:3747` unbounded | true but **irrelevant** | `HashMap<u32,u32>` — 8 bytes of payload per distinct scenic model. Tens of KB for all of Dereth. |
| scenery record cache `:3118` unbounded | true, **small** | `CachedRecord` is 15 scalars; a whole town's LBs are single-digit MB. |
| suite caches `:3488`/`:3495` unbounded | true, **size unknown** | Raw sidecar bytes. Live via `scene3d/suite_assets.js` (texchan). Worth a row, not worth a guess. |
| surface pixel cache | already capped | 24:64 MB, armed 2026-07-26. |

What §3 **missed** — both found by auditing every store, not just the `thread_local!`s:

* **The DAT-record shard cache is default-UNBOUNDED.** `configured_shard_budget_bytes()`
  (`crates/holtburger-resource-http/src/manifest_source.rs:133`) returns `usize::MAX`
  unless the page sets `__hbShardBudgetBytes`, and `?shardBudgetMB` ships **unset**. The
  LRU exists and is unarmed — the *same* "built, measured, never armed" shape as
  `matBudgetMB` in §2. `url-flags.md` already records it ratcheting ~58 MB main + ~21 MB
  worker over four hops and calls it "the dominant tracked RSS ratchet". It also records
  that arming it at **24 MB thrashed** (~280 MB of evicted-and-refetched churn), so the
  number matters and cannot be picked blind.
* **`?decodeAdmission` is also unset ⇒ unbounded**, i.e. nothing bounds concurrent
  in-flight decode bytes. That is the *other* mechanism entirely: transient peaks grow
  `WebAssembly.Memory`, which never shrinks, so a peak that lasts 200 ms raises the floor
  permanently. No cache budget can undo it.
* **`SURFACE_HEIGHT` (`src/lib.rs:105`) is unbounded and would be the largest store of
  all if it ever ran** — `Vec<f32>` at 4 B/px per distinct surface DID, i.e. ~4 MB for a
  single 1024² surface, with no budget and no eviction. It is inert today because
  `prime_surface_heights` no-ops unless `?gfxRelief=on` (strict opt-in, default off), so
  it is NOT the 08-05 OOM. It is a row in the census anyway: "off by default" is a claim
  worth measuring rather than assuming, and it is a landmine for whoever ships relief.

**Those two candidates have opposite fixes, and `wasmMemoryBytes` reads identically under
both.** That is why this session built an instrument instead of arming a budget.

### The instrument

`hb_mem_census()` (`src/lib.rs`, wasm export) + `__diag.wasmMem()` (page-side roll-up over
BOTH wasm instances, `scene3d/mem_census.js`). Needs a **wasm rebuild** (`--release`).

```js
await window.__diag.wasmMem()
// { main, worker, page:{memoryBytes, allocLive, allocPeak, storeBytes,
//                       unattributed, slackBytes, stores:{...}, top:[...]},
//   missing:[], verdict:"..." }
```

A `#[global_allocator]` wrapper counts live/peak/total allocated bytes — the load-bearing
half, because nothing else in the runtime exposes it (dlmalloc has no stats hook) and it is
the only way to split the two candidates apart:

| reading | means | fix |
|---|---|---|
| `allocLive` climbs across the route | RETENTION | budget the store `top` names |
| `slackBytes` large, `allocLive` flat | HIGH-WATER from transient peaks | bound the decode (`?decodeAdmission`); check `decodePeakLiveBytes` |
| `unattributed` is most of `allocLive` | the census is incomplete | a store has no row yet — add one before concluding anything |

`page` sums the two instances deliberately: they are independent linear memories against
ONE 4,192 MB renderer cap, so a row that is 200 MB on each half costs the tab 400 MB. A
half whose `pkg/` predates the export is named in `missing`, never counted as zero — the
standing staleness trap.

Eleven store rows, including the ones known to be tiny. The value of the residual is
exactly that `unattributed` means "none of these", so a store left out silently reappears
as a mystery.

**Cost:** two relaxed atomics per allocation, uncontended on single-threaded wasm. Not
flag-gated on purpose — an instrument that must be armed before the leak is the instrument
that is off when the crash happens.

### QUEUED — the measurement run this is built for (owner-run)

Not self-initiated (2026-07-31 halt / 2026-08-02 carve-out). Everything below is one
route on the 1070; ~10 minutes.

1. Rebuild `pkg/` **`--release`** first (this session's release build is **6.2 MB**; a
   ~18 MB `.wasm` is a `--dev` build and pays ~4× the decode tax) and use `?nosw=1`, or
   the run measures a stale bundle.
2. Boot headless, in-world, defaults otherwise — **no** `?shardBudgetMB`, **no**
   `?decodeAdmission`. The point is to measure the shipping configuration.
3. `const t0 = await __diag.wasmMem()` at spawn.
4. `@telepoi` the SAME six-town route §2 used: Holtburg → Arwic → Yaraq → Sawato →
   Shoushi → Nanto, `await __diag.wasmMem()` after each, and record `verdict` +
   `page.top` + `page.allocLive` + `page.slackBytes` + `page.unattributed` per hop.
5. Record `page.stores.shardRecords.bytes` explicitly at every hop — it is the leading
   retention hypothesis and it has never actually been read on this route.

**Decision rule, written before the data:**
* `allocLive` tracks the memory growth and `shardRecords` is the top row ⇒ arm
  `?shardBudgetMB` — at ~3× the observed per-hop working set, **not** at 24 (that number is
  already known to thrash), and owe the ABAB interleave.
* `allocLive` stays flat while `memoryBytes` climbs ⇒ the fix is `?decodeAdmission`, and
  every cache budget in the backlog is the wrong tree; `allocPeak` and
  `decodePeakLiveBytes` size the bound.
* `unattributed` dominates ⇒ stop and add the missing row. Do not arm anything.

### Also still owed from §2 / §3

* the ABAB settle-within-noise interleave `matBudgetMB` was armed without;
* geometry disposal (§4) — VRAM, still unfixed, still will not move the OOM.

### Verification for this section's changes

| gate | result |
|---|---|
| `cargo test -p holtburger-web --lib` | 226 passed / **1 pre-existing failure** |
| `cargo test -p holtburger-dat --lib scratch` | 10 passed / 0 failed (incl. the new `idle_bytes` case) |
| `node test_mem_census.mjs` | 29 passed / 0 failed |
| `node test_mat_budget_lru.mjs` | 123 / 0 |
| `node test_surface_budget_flags.mjs` | 38 / 0 |
| `node test_decode_admission_flags.mjs` | 61 / 0 |
| `node test_first_bake_batch_flags.mjs` | 84 / 0 |
| `node test_bake_worker_client_queue.mjs` | 34 / 0 |
| `wasm-pack build --release` | clean; `hb_mem_census` present in `pkg/holtburger_web.js` |
| `lint-url-flags`, `audit-flag-defaults` | clean (0 undocumented readers) |

The one failure, `tests_substitution::resolve_static_placement_frame_orders`,
**reproduces on an unmodified checkout** (`git stash`, same assert, `left: 0 right: 101`) —
it predates this work, exactly like the `bc7TextureBytes` breakage §2 found. So does
`lint-harness-params`' `kickDance` DEAD-PARAM failure. Both verified stashed, not assumed.

**Not verified: anything live.** No client session was run — the census has never executed
in a browser. Its Rust half compiles for wasm32 and its arithmetic is tested natively; the
first real reading is the queued run above.
