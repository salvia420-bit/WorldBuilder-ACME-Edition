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
- ~~**"Textures are ~1.2 GB CPU-side" is WRONG.** That conflated a `w*h*4*layers` GPU-size
  *estimate* with CPU retention. Actual `image.data` for in-scene textures is **314 MB**.~~
  **THIS RETRACTION IS ITSELF WITHDRAWN — see §9.** The 314 MB came from a materials-and-
  uniforms walk that cannot see the statics atlas's 644 MB of `DataArrayTexture` (handed
  over through an `onBeforeCompile` closure). The WeakRef census measures **1,332 MB** of
  live CPU-side texture data, and that is where the heap goes.
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
* **`SURFACE_HEIGHT` (`src/lib.rs:105`) is unbounded** — `Vec<f32>` at 4 B/px per distinct
  surface DID, no budget, no eviction. ~~Inert unless `?gfxRelief=on`~~ — **WRONG, and §8's
  live run caught it**: `resolveGfxRelief` takes the QUALITY PRESET when the URL is silent,
  and relief is on at mid/high/ultra, which is every real session. It ran the whole route
  (839 entries / 12.6 MB — small here only because town surfaces are small). This is
  exactly why the census carries rows for stores believed inert: "off by default" is a
  claim worth measuring rather than assuming.

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

---

## 8. RESULT — the census ran the route. It is the shard cache in wasm, and it is NOT the crash.

1070, GTX 1070 / ANGLE D3D11 confirmed at the page, release wasm, `?nosw=1`, defaults
otherwise (no `?shardBudgetMB`, no `?decodeAdmission`), six `@telepoi` hops with ~50 s
settle each. **Zero console errors, zero page errors, no OOM this run.** Page totals (main
+ bake worker summed):

| hop | linear | allocLive | allocPeak | shardRecords | (entries) | surfacePixels | unattributed | JS heap |
|---|---|---|---|---|---|---|---|---|
| spawn    | 540 MB | 225 MB | 511 MB |  81 MB | 2,198 | 88 MB | 47 MB |   753 MB |
| Holtburg | 575 MB | 320 MB | 552 MB | 173 MB | 4,163 | 87 MB | 46 MB |   829 MB |
| Arwic    | 612 MB | 406 MB | 579 MB | 249 MB | 6,546 | 88 MB | 49 MB | 1,424 MB |
| Yaraq    | 613 MB | 451 MB | 582 MB | 290 MB | 7,955 | 88 MB | 51 MB | 2,035 MB |
| Sawato   | 613 MB | 459 MB | 584 MB | 296 MB | 8,383 | 87 MB | 52 MB | 2,126 MB |
| Shoushi  | 630 MB | 462 MB | 584 MB | 298 MB | 8,630 | 88 MB | 52 MB | 2,469 MB |
| Nanto    | 630 MB | 473 MB | 588 MB | 307 MB | 8,992 | 88 MB | 53 MB | 2,508 MB |

**Verdict: RETENTION, and it is `shardRecords`.** `allocLive` grew +248 MB over the route
and the shard cache grew **+226 MB of it — 91 %**. Budget reads `-1` (unbounded) on both
instances, as `?shardBudgetMB` unset promises. Split at Nanto: main 234 MB / worker 73 MB.

Everything else behaved:
* `surfacePixels` **pinned at 24 MB main / 64 MB worker** — the 2026-07-26 arming works
  exactly as advertised, flat across all seven samples.
* `unattributed` sat at **47→53 MB and did not grow**. The census is essentially complete:
  no unnamed store is doing the leaking. (The steady ~50 MB is container slack, the
  wasm shadow stack and statics — expected, and it is a constant, not a leak.)
* `modelTri` 0.2 → 3.6 MB against its 64 MB budget; `decodePeakLiveBytes` 2 MB main /
  18 MB worker, i.e. the unbounded `?decodeAdmission` never came close to mattering here.
  The HIGH-WATER hypothesis is **dead**: `slackBytes` FELL over the route (315 → 157 MB) —
  the allocator was filling pages it already had.

### The decision rule fired — and I am not pulling the trigger. Here is why.

§7 said: shardRecords top + rising allocLive ⇒ arm `?shardBudgetMB` at ~3× the per-hop
working set. The data says the rule was too coarse, because **the store converges**:
increments run +92, +76, +41, +6, +2, +9 MB. Six towns share most of their records, so
307 MB *is* the working set, not a ratchet toward infinity. Arming at "3× per-hop" would
either be inert (≈300 MB) or would evict records that get refetched — and 24 MB is already
on record as thrashing ~280 MB of refetch churn.

And the size is wrong for the disease. **307 MB is 7 % of the 4,192 MB renderer cap.**

### What actually kills the tab: the JS heap, which the census does not cover

`usedJSHeapSize` went **753 → 2,508 MB against the 4,192 MB cap, still climbing at Nanto
with no sign of a plateau**, while wasm linear memory rose 540 → 630 MB and flattened.
Last session crashed at 2,808 MB on this same route; this run stopped one hop short of it.
A follow-up probe in-world:

```
glTextures 4,146   scene-reachable 1,504    reachable CPU-side image data 539 MB
glGeometries 7,366 scene-reachable 4,088
```

539 MB of CPU-side texture bytes are held by textures the scene can still reach — measured
directly, not inferred — and the JS heap is 4× the entire wasm side. This is the SAME
metric §5 records as **314 MB** on a 4-hop route; six hops later it is 539 MB, so that
number is not a ceiling, it is a point on a curve. §4's "**this is VRAM, not RAM — it will
not move the OOM**" is a claim about geometry that has since been generalised to textures,
and for textures the numbers do not support it.

⚠ What the counts above do NOT prove: `renderer.info.memory.*` only ever decrements on
`dispose()`, so `gl − reachable` means "never disposed", NOT "still alive" — a texture
GC'd without dispose leaves the count high and the memory freed. §5's dead-end list
already warns about exactly this class of over-count. The honest instrument is a WeakRef
census (the one that reduced "702 MB of leaked geometry" to 28 MB), and it has never been
pointed at TEXTURES.

### Next move

1. **WeakRef census over textures**, mirroring the geometry one: how much of that 539 MB
   (plus whatever the 2,642 non-reachable textures hold) is orphaned-and-alive? That
   number decides whether the OOM fix is disposal or residency.
2. Only then arm anything. `?shardBudgetMB` remains the one large unbounded wasm store and
   is worth ~200 MB, but it is a tidy-up, not the crash fix — and it still owes the ABAB
   interleave `matBudgetMB` also owes.
3. The census is now permanent instrumentation: `await __diag.wasmMem()` any time.

### Instrument notes from the first live use

* The census sums main + bake worker. `?agent=1` (and bot contexts) auto-enable the NET
  WORKER, a **third** wasm instance whose linear memory nothing sums today. It carries the
  transport only, so it is small — but the number is currently unknown, and this run was
  made with it enabled. Adding a third relay is the obvious follow-up.
* `page.top` ranking made the answer visible in the first sample, before any hop.
* Boot blocker worth writing down: **MariaDB was down**, and the symptom was not a database
  error anywhere. ACE logged `Login Request` + `Creating new session`, then dropped the
  session at 17 s with `Account: , Reason: Network Timeout`, and the client reported
  `connect failed after 1 attempts: timeout`. The tell is a MISSING line — a healthy login
  logs `AuthenticationHandler) new client connected: <acct>` ~1 ms after the session is
  created. `service mariadb start` fixed it outright. Probable cause: earlyoom taking
  mysqld during a `wasm-pack --release` build on the 8 GB laptop — do not run release
  builds and a live session at the same time.

---

## 9. RESULT — textures are not leaking. The heap is 1.3 GB of LIVE texture data.

`?texCensus=on`, same six-town route, forced CDP GC before every reading
(`RESULTS-texture-census-2026-08-05.json`). Page totals:

| hop | traced | GC'd | alive | **alive MB** | **orphaned MB** | bc7 records (independent) | JS heap |
|---|---|---|---|---|---|---|---|
| spawn    |    611 |    87 |   524 |   310 |  62 |  1 MB |   493 MB |
| Holtburg |  3,311 |   687 | 2,624 | 1,145 |  72 | 11 MB | 1,523 MB |
| Arwic    |  5,718 | 1,353 | 4,365 | 1,365 | 107 | 14 MB | 2,103 MB |
| Yaraq    |  7,375 | 2,312 | 5,063 | 1,378 | 135 | 24 MB | 2,272 MB |
| Sawato   |  8,810 | 3,025 | 5,785 | 1,292 | 199 | 34 MB | 2,500 MB |
| Shoushi  | 10,752 | 3,350 | 7,402 | 1,498 | 159 | 33 MB | 3,050 MB |
| Nanto    | 11,689 | 5,306 | 6,383 | 1,332 | 164 | 60 MB | 2,715 MB |

**The disposal theory is dead as the OOM cause.** Orphaned-and-alive textures hold
**164 MB** and do not ratchet — 62 → 72 → 107 → 135 → 199 → 159 → 164, i.e. churn that
rises and falls. 5,306 of 11,689 traced textures were collected and `dispose()` was called
5,833 times: disposal is happening. §4 predicted the geometry/texture disposal gap "will
not move the OOM" and was right, for a reason it did not give — the leak is small because
the GC is doing the work `dispose()` isn't.

**What the heap actually is: live textures.** 1,332 MB alive at Nanto against a 2,715 MB
heap — roughly half — and every byte of it reachable from the scene:

| kind | alive | alive MB | of which orphaned |
|---|---|---|---|
| `DataArrayTexture` | 46 | 643.8 | 20.0 |
| `CompressedTexture` | 510 | 237.3 | 40.2 |
| `DataTexture` | 5,728 | 213.9 | 71.7 |
| `CompressedArrayTexture` | 25 | 205.4 | 0.0 |
| `Data3DTexture` | 4 | 32.0 | 32.0 |

Those are CPU-side copies of pixels **that are already on the GPU**. three keeps
`image.data` (and `mipmaps[].data`) alive for the life of the texture; nothing in the
upload path releases them. 46 `DataArrayTexture`s carrying 644 MB are the statics-atlas
and terrain arrays; 5,728 `DataTexture`s carrying 214 MB are the per-surface albedo /
normal / height planes.

**So the lever is residency, not disposal** — and it is the largest one found in this
whole investigation: bigger than `?shardBudgetMB` (307 MB, §8), bigger than
`?matBudgetMB`, bigger than the orphan population by 8×.

### Two things the census got wrong first, both worth knowing

1. **It reported 451 MB of live statics atlas as "orphaned and alive".** The atlas hands
   its arrays to the material through an `onBeforeCompile` CLOSURE
   (`static_atlas.js:473-475`), so no walk over materials and their `uniforms` can see
   them. three parks the resolved bag at `renderer.properties.get(material).uniforms`
   (three.module.js:18153) — the census now reads that, plus BatchedMesh's own
   `_matricesTexture`/`_indirectTexture`/`_colorsTexture`, plus `scene.background` /
   `.environment`. Orphan bytes fell 820 → 164 MB. **This is the third time in this
   document that an instrument's first answer was an over-count**; the only reason it was
   caught is that 451 MB in 23 objects looked wrong and got read against the code.
2. **The BC7 record cache first read 297 MB.** `makeBc7Texture` passes `parsed.levels`
   through with no copy, so a record and the texture built from it SHARE one ArrayBuffer.
   Charged against the census's own dedupe set, the cache's INDEPENDENT hold — payload no
   live texture is already accounted for — is **60 MB**. Still unbounded, still growing
   (1 → 60 MB over the route), but a twentieth of the naive figure.

### §5's second dead-end entry is itself wrong, and this run overturns it

§5 retracts *"textures are ~1.2 GB CPU-side"* with *"actual `image.data` for in-scene
textures is **314 MB**"*. That correction was measured with a walk over materials and
their `uniforms` — the same walk this census started with, and the same one that could not
see the 644 MB of `DataArrayTexture` the statics atlas hands over through an
`onBeforeCompile` closure. The 314 MB figure under-counted for a structural reason, on a
shorter route.

**Live CPU-side texture bytes are 1,332 MB at Nanto.** The original "~1.2 GB" instinct was
closer to the truth than the retraction that replaced it. Treat §5's texture bullet as
withdrawn; the geometry bullet above it still stands (28 MB, and this run agrees that
geometry is not where the heap goes).

### Next move, in order

1. ~~**Release CPU-side pixel data after upload** for textures that never re-upload. This is
   the 1.3 GB. `Texture.onUpload` is three's hook; the per-surface `DataTexture`s
   (adapter.js:1122/1180/1238) and the BC7 singletons are the safe class.~~
   **WITHDRAWN — see §10. The honest win from this is ~0 MB, and two of the three sentences
   above are wrong.**
2. **Bound `Bc7RecordSource._cache`/`_preCache`** (`bc7_textures.js:457/459`). 60 MB
   independent and climbing; the LRU shape is already used three times in this codebase.
3. `?shardBudgetMB` (§8) stays worth ~200 MB but stays a tidy-up.

### Instrument caveats to carry forward

* `traced` is a FLOOR. The tracer installs at module import; anything uploaded before that
  never re-registers.
* Textures whose bytes are 0 (canvas-backed nameplates, speech bubbles, sky, render
  targets — 70 at Nanto) are real GPU objects and correctly contribute nothing here.
* 1,380 pooled per-LB planes (`__rp4Pooled`) live forever by design and are tagged, not
  counted as a leak.
* The census is `?texCensus=on` only and holds one record per texture — never leave it on
  while measuring something else.

---

## 10. WITHDRAWN — "release the CPU copy after upload" cannot ship, and §9 named the wrong classes

§9 closed by proposing that the 1,332 MB of live CPU-side texture data be released after
upload. An audit against the code kills it on three independent grounds, two of which are
corrections to §9 itself.

**§9 got the hook name wrong.** three r184 has no `Texture.onUpload`. The post-upload
callback is `texture.onUpdate`, fired at the end of `uploadTexture`
(three.module.js:12378) — and it is per-SOURCE, not per-texture, so a `.clone()` (which
shares `source`) never fires it and nulling one clone's data nulls it for all. Three clone
sites exist (`entities.js:12750/12771/16579`), sharing the image by design.

**§9 named the least safe classes as the safe ones.** The per-surface `DataTexture`s and
the BC7 singletons are precisely what the statics atlas re-reads:

* the diffuse layer write reads `img.data` per LB feed (`static_atlas.js:1203-1205`);
* `packNraLayer` → `_texChannel` reads the normal / roughness / AO / height planes
  (`static_atlas.js:297-341`), draining asynchronously up to `_NRA_PENDING_TRIES` later;
* the BC7 layer write reads `tex.mipmaps[0].data` (`static_atlas.js:1189-1192`).

And "uploaded first, atlased later" is routine, not theoretical: LRU evict → re-enter frees
the layer and drops the dedup entry while the texture SURVIVES (LB eviction skips
`__cacheOwned`, `landblock_lru.js:1730`), so re-entry re-reads the pixels. BC7 deferral,
layer-pool overflow and geometry-fail passthrough all produce the same ordering.

**A second-order failure §9 did not consider:** both atlas feed gates test the buffer's
existence — `... && (img.data || isBc7AtlasTexture(t)) && ...` (`statics.js:2379`,
`static_atlas.js:1121`). A released texture with no BC7 twin does not merely render a black
layer; it routes the node to `passthrough` and is added **unbatched**, i.e. straight back
toward the ~5,400-draw-call wall the atlas exists to remove. That is a frame-rate
regression an eye-test for blackness would never catch.

**The blocker that ends the discussion regardless: context loss.**
`scene3d/webgl_context_recovery.js` exists, is installed at `scene3d/index.js:4928`, and
calls `e.preventDefault()` — *"the defining call: tell the browser we want a restore.
Without preventDefault the context is unrecoverable"* (`:95-97`). Three's own restore path
clears `WebGLProperties` (`three.module.js:16382` via `:17055`) so **every texture
re-uploads from `image.data`**. Its header records the motivating incident: context loss
*"observed 7× on 1070"* under VRAM pressure — the exact hardware and exact pressure this
investigation is about. Releasing the CPU copy converts a currently-recovered event into a
permanently black world with no re-upload source. This applies to every class, including
the ones that are otherwise safe.

**One more correction, to §9's own citation.** The `buildDiffuseArray` staging loop
(`static_atlas.js:225-229`) is DEAD CODE — its only caller
`consolidateSingletonsViaTexArray` has no callers (`docs/2026-08-03-random-review-fixes.md:133`),
and the live allocator passes an empty list (`static_atlas.js:1000-1002`). The re-read is
real, but at `:1203` and in `packNraLayer`, not there.

### What replaces it: the atlas is over-allocated

The 644 MB of `DataArrayTexture` is dominated by statics-atlas buckets whose capacity is
fixed at creation — up to 128 layers under `?statNra` (`static_atlas.js:830`) — while the
module's own measurement says: *"Measured live working set at Holtburg is 28–47 layers
across all buckets"* (`static_atlas.js:827-828`). Capacity is chosen once and never
right-sized; the unused layers are allocated, zero-filled and uploaded.

That is a residency win with **no context-loss exposure, no de-batching risk, and no
eye-test gate** — the opposite risk profile to the withdrawn proposal. It needs one number
first: the split of the 644 MB (and of the 205 MB `CompressedArrayTexture`) between
statics-atlas buckets and the terrain one-shot arrays, which the census can report per
creation site.

### Revised order

1. Measure the array split per creation site (`__diag.textures().aliveByOrigin`).
2. Right-size / grow-on-demand the atlas bucket capacity — the real lever in the 644 MB.
3. ~~Bound `Bc7RecordSource._cache`/`_preCache`~~ — **LANDED**, armed at 256 MB
   (`?bc7RecordsMB`); live over the route it pinned at the cap with 541 evictions / 49 MB
   evicted, zero parse or transcode errors, against 297 MB unbounded.
4. `?shardBudgetMB` (§8) — still a ~200 MB tidy-up, still owed an ABAB.
5. The 32 MB of `Data3DTexture` is 100 % ORPHANED, not resident — that is a dropped
   reference (`cloud_overlay.js`), a different bug from everything above.

---

## 11. MEASURED — the single biggest item in the heap is 428 MB of atlas layers nothing uses

§10 said the array split had to be measured before chasing the atlas. It is measured now.
`__diag.textures().aliveByOrigin` attributes every LIVE texture to its creation site
(`RESULTS-texture-census-2026-08-05.json`); at Nanto, of 1,366 MB alive:

| creation site | MB | objects | kind |
|---|---|---|---|
| **`static_atlas.js:271` (NRA arrays)** | **551.1** | 29 | `DataArrayTexture` |
| `bc7_textures.js:307` (BC7 singletons) | 264.9 | 573 | `CompressedTexture` |
| `bc7_textures.js:348` (BC7 atlas buckets) | 125.7 | 25 | `CompressedArrayTexture` |
| `terrain_bc7.js:500` (terrain BC7 array) | 88.0 | 2 | `CompressedArrayTexture` |
| `materials.js:5117` (per-surface planes) | 77.5 | 586 | `DataTexture` |
| `entities.js:4423` (entity textures) | 67.9 | 298 | `DataTexture` |

The diffuse side of the atlas is BC7-compressed and costs 125.7 MB. **The NRA
(normal/roughness/AO) side is uncompressed RGBA8 and costs 551.1 MB — 4.4× the diffuse
side, and the largest single item in the entire heap.**

Then the occupancy, straight from `__atlasStats()` (`RESULTS-atlas-occupancy-2026-08-05.json`):

```
29 buckets   1,941 layers ALLOCATED   112 layers USED
             551.1 MB allocated       123 MB occupied
```

**428 MB of zero-filled NRA layers that nothing has ever written to** — 16 % of the
2,445 MB heap, on a page that OOM-crashes at ~2,800 MB. Individual buckets show the shape:
`256x256 cap=102 used=14`, `512x512 cap=25 used=1`, `1024x1024 cap=6 used=1`.

This is exactly what `static_atlas.js:827-828` predicted in its own comment — *"measured
live working set at Holtburg is 28–47 layers across all buckets"* — against a capacity
chosen once at bucket creation and never revisited. The comment was right about the working
set and wrong about the consequence: it concluded the smaller ceiling "costs nothing real",
which is true of the CEILING and not of the ALLOCATION underneath it.

### Why this is the right next fix

* **428 MB, measured, not estimated.** Bigger than `shardBudgetMB` (307 MB), bigger than
  the BC7 record cache (60 MB independent), 2.6× the entire orphaned-texture population.
* **No context-loss exposure** — unlike §10's withdrawn proposal, nothing here releases a
  re-upload source.
* **No de-batching risk** — the `img.data` feed gates are untouched.
* **No eye-test gate** — a right-sized bucket renders identically; layers that were never
  written cannot change a pixel.

### The shape of the fix

Capacity is fixed at `texStorage3D` allocation time, so "grow on demand" means allocating a
larger array and re-uploading the live layers into it. Two options, in increasing order of
work:

1. **Right-size the initial capacity** from the measured working set (`_layerCapacityFor`,
   `static_atlas.js:954-984`) — cheapest, but a bucket that overflows falls back to
   unbatched singletons (`ptLayerFull`), i.e. it trades memory for draw calls at the tail.
2. **Grow-on-demand with doubling** — start small, reallocate at 2× when full and re-upload
   live layers. Bounded copies (log₂ of final capacity), no overflow cliff. The BC7 buckets
   would need the same treatment via `makeBc7ArrayTexture`.

Either way `?statNra`'s halved ceiling (`_ATLAS_NRA_MAX_LAYERS = 128`) stops being the
governing number, and the NRA array stops being 4.4× its own diffuse twin.

**Not attempted this session** — it is a live render-path change and wants its own careful
pass with the A/B the other three budgets already owe.

---

## 12. LANDED — the four-task residency plan, measured on the 1070

§11 ended with a plan; all four parts are implemented, and the atlas one is a
large, unambiguous win. Same 1070, same four-hop route (Holtburg → Arwic →
Yaraq → Nanto), same driver.

### Task 1 — atlas buckets grow on demand (`?statAtlasGrow`, default ON)

| at Nanto | before | after |
|---|---|---|
| layers ALLOCATED | 1,941 | **160** |
| layers USED | 112 | **112** — identical |
| NRA arrays (`aliveByOrigin`) | 551.1 MB | **150.9 MB** |
| live texture bytes | 1,366 MB | **863 MB** |
| JS heap | 2,445 MB | **2,003 MB** |
| grow failures / `ptLayerFull` from growth | — | **0** / 0 |

Used-layer count landing on exactly 112 both times is the confirmation that
matters: the same work is being done, against a twelfth of the allocation.
Buckets start at 4 layers (byte-capped at 2 MiB) and double, CLAMPED to the old
`_layerCapacityFor` — so no bucket ever holds more than HEAD allocated on day
one, and there is no overflow cliff traded in exchange. 20 reallocations over
the route, zero failures.

The correctness detail this hinged on, verified against three r184 rather than
assumed: after `texStorage3D` the array contents are UNDEFINED, and when
`layerUpdates` is non-empty three uploads ONLY those layers
(three.module.js:12172-12186). Growth therefore re-marks every already-live
layer before swapping arrays. If that were wrong the symptom would be a prop
rendering garbage the moment a LATER prop triggers a grow — `?statAtlasGrow=off`
is the one-flag check.

### Tasks 2 + 3 — the seam and the way back

`scene3d/surface_planes.js` gives the atlas a pixel source that is not the
texture's CPU copy (texture bytes → wasm decode memo → honest miss), and both
batching gates now ask `canSupplyPlanes` rather than testing `img.data`.
`scene3d/texture_rehydrate.js` re-supplies released pixels on
`webglcontextrestored`, holding the frame pump until the pass settles — verified
against `tick`'s `!running` guard (`index.js:2236`). It is a strict no-op while
nothing is released: the handler keeps its original synchronous shape at
`releasedTextureCount() === 0`.

### Task 4 — `?texFreeCpu`, built, measured, and still OFF

One paired run at Nanto, `texCensus=on` in both arms:

| | control | `texFreeCpu=on` |
|---|---|---|
| live texture bytes | 863 MB | **756 MB** |
| JS heap | 2,003 MB | **1,797 MB** |
| draws per `render()` call ⚠ | 55.4 | **47.8** |
| textures registered for re-hydration | — | 578 |
| re-hydration failures | — | **0** |

Real, and in the right direction on every axis including draw calls (the
unbatching regression did not happen).

> ⚠ That draw figure is per `render()` CALL, not per displayed frame:
> `info.render.frame` is bumped inside `renderer.render()` (three.module.js:17631)
> and this client makes several calls per frame (shadow map, sky, atmosphere,
> composer). The A/B ratio holds — same instrument both arms — but 47.8 is not a
> per-frame draw count and must not be quoted as one. See
> `2026-08-06-next-gains-speculation.md` §0. But it is **one paired run**, and this
workload's run-to-run variance is large — the two control runs 10 minutes apart
differed by 40 % in bucket count (21 vs 29) and 400 MB in heap. I misread the
release arm as a regression on the first pass for exactly that reason: I compared
it against a control with different streaming state. That is why the house rule
is an ABAB interleave, and why this flag stays off until it gets one.

It is also worth being precise about the ceiling: the classes task 4 can safely
release are a slice, not the 1.3 GB. BC7 singletons (261 MB), the atlas arrays
(140 MB) and the terrain BC7 array (88 MB) are all excluded by construction —
the first two because the atlas re-reads them, all three because releasing a
plane nothing can re-supply is a black texture on a timer.

### Owed

* An ABAB interleave for `?texFreeCpu` before it is ever armed — the same debt
  `?matBudgetMB`, `?surfaceBudgetMB` and `?bc7RecordsMB` already carry.
* `_ATLAS_NRA_MAX_LAYERS = 128` was halved purely as a memory bound. With
  allocation now following use, raising the CEILING costs nothing until used, and
  `ptLayerFull` is non-zero at Nanto in BOTH arms (15–19) — meaning some props
  are already spilling to unbatched singletons. That is now a cheap win and it
  wants its own measurement.
* `test_stat_geom_dedup.mjs` fails 2/40 on this tree. Verified pre-existing by
  stashing the entire working tree — untouched by any of this work.
