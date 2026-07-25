# IMPL — `?surfaceBudgetMB=` surface-cache budget (2026-07-25)

Implements slices **S1 + S2 + S3** of `DESIGN-surface-budget-2026-07-25.md`
(options **A + B**). Branch `feat/surface-budget-mb`.

**Default-neutral by construction:** with the flag absent both wasm instances
resolve `(SURFACE_CACHE_BUDGET_BYTES, SURFACE_CACHE_ENTRY_CAP_BYTES)` =
`(96 MiB, 16 MiB)` — the exact pre-flag constants. The only unconditional
behaviour change is one extra field in the `dat_decode_diag` JSON
(`surfaceCacheBudget`) and one extra console line at boot.

S0 (measure-before-coding) and S4 (measure and choose a default) are **not** in
this branch — the flag ships armable-but-off, like `shardBudgetMB` and
`decodeAdmission`.

---

## What landed

### S1 — Rust (`apps/holtburger-web/src/lib.rs`)

| symbol | change |
|---|---|
| `fn surface_budget_from_raw(Option<f64>) -> (usize, usize)` | **new.** The whole resolution table: `Some(n) if n >= 1.0 → n`, everything else → `SURFACE_CACHE_BUDGET_BYTES`; entry cap clamped to `min(SURFACE_CACHE_ENTRY_CAP_BYTES, budget/4)`. Pure, `cfg(any(wasm32, test))`, so the native tests exercise the same function wasm does. |
| `fn configured_surface_budget_bytes()` | **new.** Two cfg arms. wasm32: `js_sys::Reflect::get(global, "__hbSurfaceBudgetBytes")` → `as_f64()` → `surface_budget_from_raw`. native-test: `surface_budget_from_raw(None)` (no JS global exists), which *is* the unauthored path. |
| `static SURFACE_PIXEL_CACHE` | the `LazyLock` init now calls `configured_surface_budget_bytes()` instead of naming the two constants. |
| `fn dat_decode_diag` | see S3. |

In-code documentation added at `surface_budget_from_raw` (constraint-stating,
matching the surrounding style):

- the budget is **advisory, not a hard cap** — `ByteBudgetLru::insert` only
  evicts entries whose `Arc::strong_count == 1` and runs *over* budget rather
  than break a live holder, the same stance `shard_cache.rs` documents for its
  round protection. `surfaceCacheBytes` is the residency truth.
- the budget is resolved **once**; `surface_pixel_cache_clear_all()` (called by
  the `init_resource_source` re-init hook) clears entries but does **not**
  resize, so setting the global after boot is a silent no-op.
- the entry-cap clamp is **inert at the default**: `min(16 MiB, 24 MiB)` = 16 MiB.

### S2 — JS host plumbing

| file | symbol | change |
|---|---|---|
| `apps/holtburger-web/scene3d/bake_worker_client.js` | `SURFACE_BUDGET_RE`, `parseSurfaceBudgetSpec`, `resolveSurfaceBudget`, `applySurfaceBudget` | **new**, sited immediately after `applyShardBudget`. Grammar `N` (both instances) or `N:M` (main:worker). Sets `__hbSurfaceBudgetBytes` (this instance) and stashes `__hbSurfaceBudgetBytesWorker` for the worker's init message; unauthored ⇒ **both deleted**. |
| `apps/holtburger-web/scene3d/bake_worker_client.js` | the `_request("init", …)` body | forwards `surfaceBudgetBytes: globalThis.__hbSurfaceBudgetBytesWorker`. |
| `apps/holtburger-web/scene3d/bake_worker.js` | `handleInit` | sets `self.__hbSurfaceBudgetBytes` from `msg.surfaceBudgetBytes`, placed with the other host globals **before `init()`**. |
| `apps/holtburger-web/index.html` | import block + the pre-`init_resource_source` setup section | imports `applySurfaceBudget`, calls it right after the `applyShardBudget` block, logs one readback line (`[surfaceBudget] main=… worker=…` / `[surfaceBudget] default (96 MiB/instance)`). |

Grammar decisions worth knowing:

- A lone `N` gives **both** instances `N`. It deliberately does **not** halve
  the main share the way `?decodeAdmission`'s shorthand does — a silent halving
  would make `=48` mean 48+24, which reads as a page total of 96 and is exactly
  the confusion this flag exists to end. Asymmetry must be authored (`24:64`).
- `:` survives `URLSearchParams` untouched, so there is none of
  `?decodeAdmission`'s `+`→space footgun; a space separator is accepted anyway
  for the same-shaped mistake.
- Sub-byte budgets floor to 1 byte, never 0 — a 0 would be indistinguishable
  from "unset" in the worker forward's `>= 1` guard.

### S3 — diag

`dat_decode_diag()` gains **`surfaceCacheBudget`** (inserted after
`surfaceCachePalEntries`; every other field keeps its name and position).
`-1` = the compile-time default, mirroring `shardCacheBudget`'s `-1 = unbounded
default` — verified against `manifest_source.rs` (`set("shardCacheBudget", if
budget == usize::MAX { -1.0 } else { … })`), so JS can test "unauthored" with
one cheap comparison on either field.

`scripts/net-review/battery-telepoi.mjs` was **not** touched — its relay
extension is owned outside this branch.

### Docs

- `apps/holtburger-web/docs/url-flags.md` — new `surfaceBudgetMB` row directly
  after `shardBudgetMB`, matching the table's 5-column format. Records
  default-neutrality, the `N:M` grammar, the ~24 MB practical floor (the
  load-bearing working set is one `SURFACE_BATCH_SPLIT_CHUNK` = 16-DID walk
  chunk), the entry-cap clamp, the advisory-not-hard-cap semantics, and the
  boot-time-only footgun. `node scripts/lint-url-flags.mjs` goes 374 → 375
  documented flags with undocumented readers 6 → 5.

---

## Tests

| suite | command | result |
|---|---|---|
| Rust lib | `cargo test -p holtburger-web --lib` | **189 passed, 1 failed** (the pre-existing `tests_substitution::triangulate_setup_model_with_substitutions_composes_part_and_texture`, unchanged from the 185+1 baseline measured on `master` before any edit — not touched) |
| JS host flags | `node apps/holtburger-web/test_surface_budget_flags.mjs` | **33 passed, 0 failed** (new file) |
| JS host flags (regression) | `node apps/holtburger-web/test_decode_admission_flags.mjs` | **61 passed, 0 failed** (unchanged) |
| url-flag lint | `node scripts/lint-url-flags.mjs` | passes |
| wasm | `capped-build wasm-pack build --target web --out-dir pkg --dev` | succeeds |

The four new Rust tests live in `tests_surface_cache`:

- `surface_budget_default_identity` — the negative control. Unset ⇒ the exact
  compile-time pair; `0` / `-1` / `0.5` / `NaN` / `-inf` all fall back to the
  default rather than to a 0 budget (a 0 budget would be a silent
  `?surfaceCache=off` that no flag readback would show); and the **live**
  process store is asserted to carry those constants.
- `surface_budget_entry_cap_clamps_to_a_quarter` — the clamp table (inert at
  96 MiB and at the 64 MiB break-even, `32 MB → 8 MiB`, `24 MB → 6 MiB`) plus
  the behaviour it buys: an over-cap entry is refused and stays non-resident,
  an exactly-at-cap entry is admitted.
- `surface_budget_evicts_down_to_a_small_budget` — 16 × 512 KiB into a 4 MiB
  budget: `total_bytes <= budget`, `evictions > 0`, store not flushed, and the
  most recent key survives (recency, not insertion order).
- `surface_budget_runs_over_when_nothing_is_evictable` — the advisory-cap
  proof. With every entry held by a live consumer, nothing evicts and the store
  runs over budget; dropping the holders and inserting once reclaims to budget,
  so the over-run is transient rather than a permanent loss of the bound.

The 33 JS assertions cover the grammar (`N`, `N:M`, fractional MB, whitespace,
space separator, either-direction asymmetry), 12 garbage inputs, resolution
(including that `:` needs no `%3A`), and the globals contract — with the
absent ⇒ **both globals deleted** negative control asserted three ways (no
param, unrelated param, garbage value).

---

## How to run the S0 / S4 measurement arms

Per design §3. Prerequisites, all of them load-bearing:

- **Release wasm.** `capped-build wasm-pack build --target web --out-dir pkg
  --release` on the buildbox (`--release` is a buildbox job on the 8 GB laptop);
  verify `ls -la apps/holtburger-web/pkg/*.wasm` ≈ 4.9 MB, **not** ~18 MB (dev
  wasm is a ~4× tax and invalidates any timing).
- `?nosw=1` on every URL (the service worker caches `index.html` across
  restarts), `?nullRender=1`, a **fresh `--user-data-dir` per arm** (shader
  cache warms arm 2), ≥70 s between arms for ACE's "Account In Use", park
  off-route between runs, 16-hop route with a repeated anchor.

Arms:

1. **default** — no `surfaceBudgetMB`. Baseline. `surfaceCacheBudget` must read
   `-1` on both instances; if it doesn't, the arm is contaminated.
2. **`?surfaceCache=off`** — the zero-code bracket (max saving, max re-decode).
3. **`?surfaceBudgetMB=24:64`** — the design's recommendation.
4. **`?surfaceBudgetMB=8:8`** — deliberate too-tight negative control. It must
   show `decodeAmp` rising and settle regressing; if it doesn't, the knob isn't
   gating and arm 3 proves nothing (the S4 "prove the gate gates" lesson).

Read per hop, per instance, from `__diag.datDecode()` → `{main, worker}`:
`surfaceCacheBudget`, `surfaceCacheBytes`, `surfaceCacheEntries`,
`surfaceCacheHits/Misses/Inserts/Evictions`, `surfaceDecodeTotal`,
`surfaceDecodeDids`, `shardCacheBytes`, `wasmMemoryBytes`.

**Ship criterion for arming a non-default default:** `decodeAmp =
surfaceDecodeTotal / surfaceDecodeDids` ≤ 1.15 on **both** instances (the
ci-smoke S5b gate), settle median within noise of baseline (n ≥ 2 routes), and
`surfaceCacheBytes` provably ≤ budget on both. Note `surfaceCacheHits` cannot
distinguish intra-call walk hits from cross-call hits, so a high hit count is
**not** evidence the budget is earning its keep — `decodeAmp` is the honest
consequence metric.

---

## Deviations from the design doc, and corrections to it

1. **`configured_surface_budget_bytes()` returns a pair, not a `usize`.** The
   design describes the budget read and the entry-cap clamp as separate steps.
   Returning `(budget, entry_cap)` from one function keeps the clamp
   un-bypassable at the single call site and makes the whole resolution table
   testable natively through `surface_budget_from_raw`.

2. **The design's trap note "url-flags.md rows 413/414 still say *the bake
   worker has no URL and stays on*" is STALE.** `rg 'has no URL'` over
   `url-flags.md` returns zero hits at this HEAD; both the `surfaceCache` and
   `palSurfaceCache` rows already carry the corrected post-`seed_url_flag_search`
   (63938b48) wording. Nothing to fix — do not "correct" it again.

3. **`?shardBudgetMB` has NO flag-suite assertions**, contrary to the brief's
   "mirror the precedent end-to-end … its url-flags.md row + flag-suite
   assertions". The only host-flag suite in the tree is
   `test_decode_admission_flags.mjs`, and `applyShardBudget` appears in no test
   file (`rg -l applyShardBudget` hits only `bake_worker_client.js`,
   `index.html`, `lib.rs`, `url-flags.md`, and design docs). The surface budget
   therefore gets a **new** sibling suite, `test_surface_budget_flags.mjs`,
   written in the decode-admission suite's style (self-contained, node-runnable,
   `passed/failed` tally + non-zero exit). There is no test aggregator to
   register it with — `ci-smoke.sh` and `run-all-validators.cjs` reference
   neither suite.

4. **A worker global name the design does not mention:** the worker's half is
   stashed page-side as `__hbSurfaceBudgetBytesWorker` and delivered as the
   `surfaceBudgetBytes` init field, so the *worker's* own global is plain
   `__hbSurfaceBudgetBytes` — i.e. Rust reads one name in both instances, which
   is what makes `configured_surface_budget_bytes()` instance-agnostic.

Design claims re-verified at the sites touched, all **confirmed**:
`SURFACE_CACHE_BUDGET_BYTES` / `SURFACE_CACHE_ENTRY_CAP_BYTES` / `ByteBudgetLru`
/ `SURFACE_PIXEL_CACHE` / `SurfaceCacheKey` / `surface_pixels_bytes` /
`surface_cache_stats` all at the quoted symbols; `crates/holtburger-web` does
not exist (the wasm crate is `apps/holtburger-web`); `SURFACE_BATCH_SPLIT_CHUNK
= 16`; the `>1.15` `decodeAmp` gate; and `MaterialCache` really never deletes
or clears (`rg 'this.materials.delete|this.materials.clear'` over `scene3d/`
returns zero hits) — the finding that makes main's persistent surface cache the
weaker of the two.
