# DESIGN (DRAFT) — surface-cache duplication: shared vs split budget (2026-07-25)

Answers recommended move 4 of `HANDOFF-A15-landed-2026-07-25.md`: *"Surface-cache duplication
(~96 MB × 2 pinned from hop 1) is now the largest addressable resident block after the
first-spike mystery — worth a design pass (shared vs split budget) independent of threads."*

Read-only pass. Every file:symbol below was opened and read; nothing is carried over from
another agent's doc without verification. Line numbers are current-HEAD (`2b7075c0`) and will
drift — anchor by symbol.

---

## 1. Where the surface cache actually is

Everything lives in **`apps/holtburger-web/src/lib.rs`** (the wasm crate; `crates/holtburger-web`
does not exist). The DAT crate has no surface cache — `crates/holtburger-dat/src/` contains
`scratch.rs`, `normal_gen.rs`, `surface_classify.rs` etc., and the shard LRU is in
**`crates/holtburger-resource-http/src/shard_cache.rs`** (not `holtburger-dat`, as the task
brief guessed).

| symbol (`apps/holtburger-web/src/lib.rs`) | what it is |
|---|---|
| `SURFACE_PIXEL_CACHE: LazyLock<RwLock<SurfaceLru>>` (~:9246) | the store. Process-global per wasm instance (was `thread_local!`, de-thread-localised in §2.2 so a future rayon pool wouldn't mint N copies). |
| `type SurfaceLru = ByteBudgetLru<SurfaceCacheKey, Arc<SurfacePixels>>` (~:9243) | key → refcounted value |
| `enum SurfaceCacheKey` (~:9206) | `PaletteFree(u32 did)` \| `Composed{surface_did, base_palette_id, sub_palettes: Vec<(u32,u8,u8)>}` — exact tuple, no hash class. |
| `const SURFACE_CACHE_BUDGET_BYTES = 96 * 1024 * 1024` (:9180) | **the whole 96 MB story — a compile-time constant, per instance.** |
| `const SURFACE_CACHE_ENTRY_CAP_BYTES = 16 * 1024 * 1024` (:9182) | single entry refused above this |
| `struct ByteBudgetLru` (~:9075) | generic byte-budget LRU with an `evictable(&V)` predicate; the surface store passes `\|v\| Arc::strong_count(v) == 1`. Shared with `MODEL_TRI_CACHE`. |
| `fn surface_pixels_bytes` (:9311) | `pixels.len() + normal_pixels.len() + height_pixels.len() + 64` — **this is exactly what `surfaceCacheBytes` reports** |
| `fn surface_cache_stats` (:9481) | the diag tuple → `surfaceCacheHits/Misses/Inserts/Evictions/Bytes/Entries` + `surfaceCachePal*` |
| `fn surface_memo_get / _insert / _contains` (:9333/:9355/:9345) | palette-free accessors; insert is completeness-gated (`decode_misses == 0 && width > 0 && !magenta_sentinel`) |
| `fn surface_memo_get_composed / _insert_composed` (:9377/:9406) | dyed-entity class, same store, same budget |
| `fn fetch_surface_pixels_cached` (:9504) / `fetch_entity_surface_pixels_cached` (:9529) | the only two producers |

**Value shape.** `SurfacePixels` (`pub struct` :8625) holds three owned `Vec<u8>` planes:
`pixels` (RGBA8, 4 B/px), `normal_pixels` (RGB8, 3 B/px), `height_pixels` (R8, 1 B/px) — so a
cached entry is **~8 B/px, and exactly half of it is *derived*, not decoded**: `normal`+`height`
come from `normal_and_height_pixels` (:~10140) → `holtburger_dat::normal_gen::
normal_and_height_from_luminance` (a blur + Sobel over the RGBA, no DAT reads), over the
`NORMAL_HEIGHT_SCRATCH` pool landed in S3.

**Cost of a hit and of an insert is a full deep copy.** `clone_surface_pixels` (:9292) deep-clones
all three planes. `surface_memo_get` → `.map(|arc| clone_surface_pixels(&arc))`; `surface_memo_insert`
→ `Arc::new(clone_surface_pixels(sp))` *while the caller keeps the original*. So a cold decode
transiently holds 2× the entry, and every hit allocates a fresh full copy. (The wasm-bindgen
getters clone again: `pub fn pixels(&self) -> Vec<u8> { self.pixels.clone() }` :8706.)

### Why both instances hold ~96 MB

Because 96 MiB is the **budget**, not an observation of demand: `RESULTS-settle-vs-age-2026-07-25.md`
shows main 92→96 and worker 96 flat for 16 hops. Both stores are *saturated and evicting from
hop 1*. The page total is `2 × SURFACE_CACHE_BUDGET_BYTES` **by construction**, ≈192 MiB of a
~930 MB page (~21%). It is not a leak and not load-dependent — it is a constant, doubled.

### Who populates which instance (verified call paths)

- **Worker** (`scene3d/bake_worker.js` — its own `init()` + `init_resource_source`, its own linear
  memory, hence its own `SURFACE_PIXEL_CACHE`): `handleSurfaces` → `fetch_surfaces_pixels`,
  `handleEntitySurfaces(Batch)` → `fetchEntitySurfacesPixels(Batch)`. It carries the **bulk** of
  statics/buildings/cells/scenery/entity surface decode, then serialises results to transferables
  (`bake_transfer.js`) and frees the handles. Note it is a *decoder offload*, not a "baker" — no
  geometry baking happens there.
- **Main**: everything that is *not* routed to the worker —
  1. **tex-swap alias DIDs (`0x08F0xxxx`)**, the R-1 `aliasSplit` (`bake_worker_client.js`
     `partitionTexSwapAliasDids` / `fetchSurfacesPixels`): alias→(base,tex) resolution lives in a
     per-instance append-only registry that only the main instance has, so alias legs are decoded
     on main and stitched back by input index. The `surfaceCache` flag doc records
     `mainAmp 4.66` from this path before aliases were admitted to the cache — i.e. **the alias
     residue is a genuinely large decode load, and is the prime suspect for main's 96 MB.**
  2. any batch containing an alias in the *entity-batch* path (whole batch goes to main),
  3. `?bakeWorker=0` and every worker-error fallback (`[bake_worker_client] … main-thread fallback`),
  4. `portal_space.js:141` (`wasm.fetch_surfaces_pixels` raw), UI/icon paths, `?netWorker=1`'s
     third wasm instance decodes **no** surfaces (`scene3d/net_worker.js` imports only the three
     `net_worker_*` exports) — so it contributes 0 here.

### The finding that reframes the whole problem: main has an unbounded JS cache in front of it

`scene3d/materials.js` `MaterialCache`:
- `preload()` (:3181) skips a DID when `this.materials.has(d)`; `get()` (:3012) returns
  `this.materials.get(did)` before any wasm call.
- `this.materials` / `this.textures` / `this.normalTextures` / `this.heightTextures` are **never
  deleted or cleared** — a grep for `this.materials.delete` / `.clear()` across `scene3d/` returns
  **zero** hits. Only `palettedMaterials` / `vfxPalettedVariants` are capped
  (`PALETTED_CACHE_CAP = 256`, :122), and only page-teardown `dispose()` frees anything.

**Consequence:** once a surface DID has a material, *no bake ever asks wasm for it again* — on
either instance (the worker is only ever reached through the same JS fetchers). The wasm surface
cache's cross-call value is therefore restricted to:

- **(i) intra-call walk dedupe** — the real, load-bearing one: `fetch_surfaces_pixels` runs a
  discovery walk closure that calls `fetch_surface_pixels_cached` per DID, then decodes the chunk
  again in the final loop. The memo is what turns the documented 2–8× walk re-decode into
  `decodeAmp ≈ 1.0`. Working-set requirement: **one chunk** (`SURFACE_BATCH_SPLIT_CHUNK = 16`, :9579),
  not a town.
- **(ii) composed (dyed) re-requests** after the JS `PALETTED_CACHE_CAP = 256` LRU evicts an
  outfit signature — a real but bounded source, and it lands in the **worker**.
- **(iii)** re-init/`?bakeWorker=0`/fallback churn.

So the 96 MiB constant is sized for a "town's working set" (its own comment: "roughly 11 M cached
pixels") that the JS layer already dedupes. **This is over-provisioning, twice.**

---

## 2. Options

Ranked by value/cost. Savings are page-resident wasm linear memory against the measured
~930 MB / 192 MiB-of-surface-cache baseline.

### (A) Host-supplied per-instance byte budget — `?surfaceBudgetMB=` (the `shard_cache.rs` precedent)

Make `SURFACE_CACHE_BUDGET_BYTES` the *default* of a `configured_surface_budget_bytes()` read of a
JS global at the `LazyLock` init, exactly as `configured_shard_budget_bytes()`
(`crates/holtburger-resource-http/src/manifest_source.rs:~120`) reads `__hbShardBudgetBytes` for
`?shardBudgetMB=`, forwarded to the worker in its `init` message (`bake_worker.js handleInit`,
the defect-4 pattern).

- **Saving:** linear, `192 MiB − (main + worker budgets)`. `16:64` → **~112 MB**; `32:32` → ~128 MB.
- **Settle risk:** the only mechanism by which a smaller budget can cost time is re-decode, and
  `RESULTS-settle-vs-age` establishes settle tracks decode volume. Bounded by construction if the
  budget comfortably exceeds one chunk's decoded footprint (16 DIDs; typical 256² surface ≈ 0.33 MB
  with derived planes, worst-case 1024² ≈ 6 MB → a chunk is ~5 MB typical, ~96 MB pathological).
  **Floor: budget ≥ 4 × `SURFACE_CACHE_ENTRY_CAP_BYTES` = 64 MB is over-cautious; ≥ 24 MB is the
  practical floor** and below that the walk-window invariant is at risk.
  The `?shardBudgetMB=24` lesson ("~280 MB refetch churn — below one round's working set") is the
  cautionary precedent, but note the working set here is a *chunk of 16*, not a *prefetch round*.
- **Implementation cost:** LOW — ~40 lines Rust + ~30 JS + worker init field + flag-suite
  assertions + url-flags row. No new data structure: `ByteBudgetLru` already evicts, and **both
  stores already evict every session** (they are saturated), so a smaller budget is quantitatively
  more of an already-exercised path, not a new failure class.
- **A/B:** see §3.

### (B) Role-based caps (same mechanism as A, different defaults — *this is the actual finding*)

A is the knob; B is what to set it to. Given §1's JS-dedupe finding, **main's persistent surface
cache is close to dead weight**: its cross-call hit sources are alias re-requests that the JS
`materials` map already suppresses. Main plausibly needs only the intra-call chunk window
(**16–24 MB**), while the worker keeps a real budget (**48–64 MB**) for the composed class and for
the batch/concurrency overlap.

- **Saving:** `192 − (24 + 64)` ≈ **~104 MB**, most of it from main.
- **Settle risk:** lower than a symmetric cut, because it removes budget where hits are rarest.
- **Cost:** zero beyond A (it is a default choice, plus the `N:M` grammar).
- Stronger variant — *"drop after round"* on the worker (lease the cache for the duration of one
  bake round, then clear) — is **not recommended**: `surface_pixel_cache_clear_all()` already
  exists, but a round has no clean boundary on the worker (requests arrive per-message, overlapped),
  and an LRU with a small budget achieves the same residency with strictly better behaviour and no
  new lifecycle to get wrong.

### (C) Shared cache across the two instances — **blocked on threads; de-prioritise**

The store is a Rust `RwLock<HashMap>` living in wasm linear memory. Two instances = two linear
memories; sharing it means **one shared memory**, i.e. the atomics/`SharedArrayBuffer` build
(`SCOPE-2.5-atomics-toolchain`, `SCOPE-2.5b-wasm-bindgen-threads-gate`) plus the COI gate — exactly
the work the handoff defers, and gated behind `AUDIT-sab-views-2026-07-24.md`'s must-fix list
(item 1 `pushBuffer` DONE in 3e630a22; item 2 the per-threaded-build checklist is written but has
never been RUN). Also note the audit's ground truth 1: the whole page is safe today *because*
wasm-bindgen copies owned `Vec`s out; a shared-memory build re-opens 14 invariant-dependent sites.

A **non-threaded** "shared" variant (hoist the store to JS as one page-level map of transferable
pixel buffers) is worse than it sounds: every worker→main hit becomes a postMessage round trip or
a structured-clone copy, it moves system work from Rust to JS against the standing
`system-work-in-RUST-not-JS` rule, and the pixels would still be copied into DataTextures anyway.
**Do not pursue.** Best case it duplicates option D's saving at 10× the cost and risk.

### (D) Drop the derived planes from the cached value — the best *content-side* lever

`normal_pixels` (3 B/px) + `height_pixels` (1 B/px) are **exactly half** of a cached entry and are
pure functions of `pixels` via one already-pooled, byte-identity-tested pass
(`normal_and_height_from_luminance`, fixture-gated by `fused_matches_originals_byte_for_byte`).
Cache the RGBA plane only; re-derive on a hit.

- **Saving:** ~50% of resident surface-cache bytes at any budget — **~96 MB at today's budgets**,
  or (better) it doubles the content held per MB when combined with A/B.
- **Settle risk:** *no extra DAT reads, no re-decode* — `decodeAmp` is untouched by construction.
  The cost is CPU on hits only (one blur+Sobel), and hits are already rare on main. Risk is a long
  task on a burst of hits; measurable directly as `ltMax`/settle.
- **Cost:** MEDIUM — a `CachedSurface { pixels, meta }` value type, re-derive in the two
  `surface_memo_get*` paths, plus preserving the load-bearing empty-`height_pixels` semantics
  ("constant luminance → JS skips POM") — that flag must be memoised alongside, not re-inferred.
- Note the interaction with `normalMapsEnabled` (quality preset, materials.js:3056): when normal
  maps are off, JS discards the derived planes entirely, yet Rust computes *and caches* them today.
  Under D that waste disappears for free on hits.

### (E) Bonus, transient-not-resident: `Arc` the `SurfacePixels` planes

`clone_surface_pixels` is called on every insert *and* every hit. Changing the three planes to
`Arc<Vec<u8>>` makes both O(1) and removes the 2× transient at cold-decode time. This attacks the
**first-spike high-water** (handoff recommendation 1's open mystery: main's 689 MB set at hop 1 and
never moving) rather than steady-state residency, so it is complementary, not competing.
Cost: LOW-MEDIUM, touches a `wasm_bindgen` struct and its getters (which can keep returning
`Vec<u8>`; JS sees no change). Worth a separate slice if the S4 battery fails to explain the spike.

---

## 3. How to measure — with the rigs that already exist

**Zero-code upper bound, available today.** `?surfaceCache=off` (master escape,
`parse_surface_cache_flag` :8974) disables get+insert in **both** classes. Since S0's
`seed_url_flag_search` landed (63938b48), the worker honours page flags — so
`DESIGN-A15-ab-2026-07-24.md`'s tainted-measurement item 1 ("the whole `?surfaceCache=off` chain")
is **retired**, and this flag is now a valid instrument. It brackets every option below: it buys
the full ~192 MB and pays the full re-decode bill. Run it first; it costs one route.

**Instruments (all already exposed per instance via `__diag.datDecode()` → `{main, worker}`):**

| metric | field | reads on |
|---|---|---|
| residency | `surfaceCacheBytes`, `surfaceCacheEntries` | both |
| cache economics | `surfaceCacheHits/Misses/Inserts/Evictions` (+ `surfaceCachePal*`) | both |
| **re-decode alarm** | `decodeAmp = surfaceDecodeTotal / surfaceDecodeDids` — the ci-smoke S5b canary, **>1.15 FAILs** (:9708) | both |
| page memory | `wasmMemoryBytes` (monotone high-water — never read as occupancy) | both |
| the other ratchet | `shardCacheBytes` | both |

Caveat to state in any write-up: **`surfaceCacheHits` cannot distinguish intra-call walk hits from
cross-call hits**, so a high hit count is not evidence the 96 MiB is earning its keep. The budget
arm is what decides it — `decodeAmp` is the honest consequence metric.

**Rig.** `scripts/net-review/battery-telepoi.mjs` currently pulls **only** `wasmMemoryBytes` from
the relay (its `evaluate` at ~:363-366). One-line-ish extension: return `surfaceCacheBytes`,
`surfaceCacheEntries`, `surfaceCacheHits/Misses/Evictions`, `surfaceDecodeTotal`,
`surfaceDecodeDids`, `shardCacheBytes` for both instances. For **settle**, reuse the per-hop driver
described in `RESULTS-settle-vs-age-2026-07-25.md` (the shipped `portal-settle-probe.mjs` computes
one settle per process and cannot express a within-session claim).

**Arms** (release wasm — verify `ls -la pkg/*.wasm` ≈ 4.9 MB, not ~18 MB dev; `?nullRender=1`,
`?nosw=1`, fresh `--user-data-dir` per arm, ≥70 s between arms for ACE's "Account In Use", park
off-route between runs, 16-hop route with a repeated anchor):

1. **default** (unset ⇒ 96 MiB × 2) — baseline
2. **`?surfaceCache=off`** — the bracket (max saving, max re-decode)
3. **`?surfaceBudgetMB=24:64`** (main:worker) — the recommendation
4. **`?surfaceBudgetMB=8:8`** — deliberate too-tight negative control; must show `decodeAmp` rising
   and settle regressing, or the knob isn't gating (the S4 lesson: prove the gate gates)

**Ship criterion for a non-default arm:** `decodeAmp ≤ 1.15` on both instances, settle median
within noise of baseline (n≥2 routes), and `surfaceCacheBytes` provably ≤ budget on both.

---

## 4. Recommendation

**Land (A)+(B): one host-supplied, per-instance, role-asymmetric surface-cache budget
`?surfaceBudgetMB=`, default-neutral (unset ⇒ today's 96 MiB constant, bit-for-bit). Then measure,
and only then consider (D) as the follow-on that halves whatever budget you settle on.**

Rationale: it is the cheapest change with the largest addressable block (~100–110 MB expected),
it reuses a precedent landed three days ago (`shardBudgetMB`) end to end, it requires **no new
eviction machinery** (the LRU already evicts in production every session), and it is completely
independent of threads/SAB. Option C is thread-blocked and de-prioritised; option D is strictly
better *per byte* but costs a value-type refactor and should ride on top of a measured budget, not
replace it; option E belongs to the first-spike investigation, not this one.

### Slice plan

- **S0 — measure before coding (no code).** Route battery, arms 1 + 2 above. Deliverable: what the
  surface cache is *worth* page-wide (settle delta and `decodeAmp` delta at `surfaceCache=off`) and
  the exact resident block it costs. If arm 2's settle is within noise of baseline, the whole
  96 MiB × 2 is refuted and the recommendation simplifies to a much smaller default.
- **S1 — Rust, default-identity.** `configured_surface_budget_bytes()` (mirror
  `configured_shard_budget_bytes`) read at the `SURFACE_PIXEL_CACHE` `LazyLock` init from
  `globalThis.__hbSurfaceBudgetBytes`; absent/<1 ⇒ `SURFACE_CACHE_BUDGET_BYTES`. Clamp
  `entry_cap = min(SURFACE_CACHE_ENTRY_CAP_BYTES, budget / 4)` so one 16 MB entry cannot dominate a
  small budget. Tests: default-identity (negative control — unset must produce byte-identical
  behaviour), evict-to-budget, entry-cap clamp, "nothing evictable → runs over budget" (the
  `Arc::strong_count == 1` predicate means the budget is **advisory, not a hard cap** — document
  that in-code, as `shard_cache.rs` documents its round protection).
- **S2 — JS host plumbing.** `applySurfaceBudget()` next to `applyShardBudget()` in
  `scene3d/bake_worker_client.js`; grammar `?surfaceBudgetMB=N` (both) or `N:M` (main:worker);
  called from `index.html` **before `init_resource_source`** (same ordering note as shardBudget —
  here the requirement is "before the first surface decode", which that guarantees); forwarded as
  `surfaceBudgetBytes` in the worker `init` message and set on `self.` in `bake_worker.js
  handleInit` **before `init()`**. One console readback line. Flag-suite assertions incl. the
  absent-⇒-unset negative control.
- **S3 — diag + rig.** Add `surfaceCacheBudget` (−1 = default/unbounded semantics, mirroring
  `shardCacheBudget`) to `dat_decode_diag`; extend `battery-telepoi.mjs`'s relay read to the field
  list in §3.
- **S4 — measure and choose a default.** Arms 3 + 4 (+ repeat 1). Arm a default only against the
  ship criterion above; otherwise the flag ships armable-but-off, exactly like `shardBudgetMB` and
  `decodeAdmission`.
- **S5 (separate, conditional) — option D**, if S4 shows the budget cut costs settle: halve the
  bytes instead of the content.

### Traps / notes for the implementer

- `surface_pixel_cache_clear_all()` runs on `init_resource_source` re-init and clears entries but
  does **not** resize; the budget is fixed at `LazyLock` init. Setting the global after boot is a
  silent no-op — same footgun as `__hbShardBudgetBytes`.
- `apps/holtburger-web/docs/url-flags.md` rows 413/414 still say *"the bake worker has no URL and
  stays on"* for `surfaceCache`/`palSurfaceCache`. That is **stale** post-`seed_url_flag_search`
  (63938b48) and should be corrected in the same pass — it is exactly the claim that made the
  earlier `?surfaceCache=off` arms untrustworthy.
- Do not conflate this with `?shardBudgetMB`: shards are *wire records* (the slow ratchet, 70→109 MB
  over 16 hops), surfaces are *decoded pixels* (a flat 192 MiB from hop 1). They are separate
  budgets on separate ratchets and should be measured in separate arms before being combined.
- `rg -rn` is `--replace n`; use `rg -n`. (Cost me one confusing grep in this pass.)
