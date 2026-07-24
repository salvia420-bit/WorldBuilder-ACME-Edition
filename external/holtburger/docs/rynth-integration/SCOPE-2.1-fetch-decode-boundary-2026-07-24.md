# SCOPE — §2.1 fetch/decode boundary split (2026-07-24)

> Branch: `perf/wasm-threads-sab` (off `master` @ `ce47c413`; `perf/explorer-loop` is fully
> merged — 0 commits ahead of master, 45 behind, so it is a stale pointer, not a live branch).
> Scopes `HANDOFF-wasm-threads-SAB-2026-07-20.md` §2.1, the mandatory-first item of Path A.
> Every citation re-read against THIS tree — the handoff's line numbers had drifted again
> (e.g. `TEX_SWAP_ALIASES` 5926 → **5966**). Anchor by symbol, not line.

**Prerequisite status:** §2.4 (COOP/COEP) is **cleared** — see
`SCOPE-2.4-coi-gate-2026-07-24.md`. Path A is not blocked at the infra layer.

---

## 1. Headline: the seam already exists — but the handoff describes the wrong data flow

The handoff frames §2.1 as: *"pin all `web_sys::fetch`/`JsFuture` work to one owner thread, and
message-pass decoded `Vec<u8>` to the worker pool."*

The first half is right and is **cheaper than advertised**. The second half **does not match the
pipeline** and would not work as written.

### 1a. What's already clean (good news)

`ResourceSource` is already split along exactly the axis threads need:

| Surface | Sync/async | Thread-safety | Sites |
|---|---|---|---|
| `prefetch` / `prefetch_urgent` / `connect` | `async`, `!Send` | owner-thread only | `manifest_source.rs:320/337/289` |
| `get_file_by_key` / `get_metadata_by_key` / `has_namespace` | **sync** | genuinely `Send + Sync` | `manifest_source.rs:374-394`, v2 impl `:776-813` |

The sync accessor reads only `boot: HbaReader<Vec<u8>>` and
`shards: Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>` (`manifest_source.rs:260-262`) — plain owned
bytes behind a real `Mutex`. **Decode never awaits.** `prefetch.rs:9-10` states the invariant
outright: *"The walk is sync; the prefetch is async."*

`RecordingSource` (`manifest_source.rs:889-892`) is likewise already thread-safe —
`misses: Mutex<HashSet<(String, u32)>>`, not a `RefCell`.

### 1b. What the handoff got wrong: it is decode-as-**discovery**, not fetch-then-decode

You cannot compute the byte set up front and hand it to a pool, because **decode is what
discovers the fetch list.** `run_walk_loop` (`prefetch.rs:301`) ping-pongs:

```
prefetch(initial_keys).await            // async, !Send   — owner thread
for round in 0..8 {
    walk(&recorder)                     // SYNC decode    — poolable
    misses = recorder.take_misses()     // round N's decode misses ...
    if misses.is_empty() { break }
    prefetch(misses).await              // ... are round N+1's fetch list
}                                       // + PREFETCH_ROUND_TRIES = 3 retries/round
```

Round N's decode **misses** are round N+1's prefetch list (`prefetch.rs:12-16`). A miss is not an
error — it is the normal record-finding mechanism, which is why decode impls suppress warnings
while `in_discovery_walk()` is true (`prefetch.rs:104-115`).

So the boundary is not a one-shot handoff. It is a **per-round round-trip that crosses the thread
boundary up to 8 times per call**, and every crossing is a pool→owner→pool hop. That is the real
design problem in §2.1, and it is not what the handoff scoped. Latency per hop now matters:
today these rounds are free function calls.

### 1c. The `unsafe impl`s need **confinement**, not removal

`inflight.rs:116/118` and `walk_dedup.rs:63/65` assert `Send + Sync` over maps holding
**futures** (`Shared<LocalBoxFuture>`), not over data. Those maps are touched *only* by the async
driver. If the pool runs only walk closures + sync accessors, **the pool never touches them at
all.**

That reframes the highest-risk item: the job is not "make these safe to share" (they can't be —
`JsFuture` is genuinely `!Send`), it is "**prove the pool cannot reach them.**" Confinement is
enforceable by construction — keep `ManifestResourceSource` off the pool entirely and give pool
threads a narrower `Arc<dyn ResourceSource + Send + Sync>` handle exposing only the sync trio.
The `unsafe impl`s can then keep their current SAFETY comment, amended from "wasm32 is
single-threaded" to "owner-thread-confined."

---

## 2. The actual blocker §2.1 inherits: `thread_local` decode caches

**This is why §2.1 and §2.2 cannot be sequenced independently.**

The walk closures call `triangulate_model` (`lib.rs:7944`), which reads
`MODEL_TRI_CACHE` — a `thread_local!` (`lib.rs:8000`). Under a rayon pool, `thread_local` means
**per-pool-thread**, so an N-thread pool yields **N copies** of every decode cache:

| Cache | Site | Budget | Under N threads |
|---|---|---|---|
| `MODEL_TRI_CACHE` | `lib.rs:8000` | 64 MiB | N × 64 MiB |
| `SURFACE_PIXEL_CACHE` | `lib.rs:8933` | 96 MiB | N × 96 MiB |
| `TEX_SWAP_ALIASES` | `lib.rs:5966` | — | N disjoint ID registries → **alias collisions** |

`lib.rs` has **27** `thread_local!` blocks total; the three above are the decode-path ones.

Consequences if §2.1 lands alone:
- **RSS goes UP, not down** — reintroducing precisely the per-instance cache duplication that
  motivated rejecting Path C (a second independent worker). The whole RSS argument for threads
  inverts.
- **`decodeAmp` breaks the 1.00 invariant** — a DID decoded on thread A is not cached on thread B,
  so the same record decodes N times. That is the handoff's own §3 validation gate.

**Therefore:** the §2.2 shared-cache conversion (`Arc<RwLock<…>>`) is not a follow-on to §2.1 —
it is a **co-requisite**. Shipping §2.1 first produces a strictly worse client.

---

## 3. Proposed decomposition (revised from the handoff's single XL)

| Step | Work | Size | Ships alone? |
|---|---|---|---|
| **2.1a** | Narrow pool-facing handle: `Arc<dyn ResourceSource + Send + Sync>` exposing only the sync trio; assert `ManifestResourceSource` never crosses. Amend the two SAFETY comments to "owner-thread-confined". | **S** | ✅ no behaviour change, single-threaded-safe |
| **2.1b** | Restructure `run_walk_loop` so the sync `walk` is a *relocatable unit*: walk + `take_misses` behind one call the driver invokes, initially in-place. Makes the round-trip explicit before any thread exists. | **M** | ✅ pure refactor, A/B-able today |
| **2.2** | `MODEL_TRI_CACHE` **(done)** + `SURFACE_PIXEL_CACHE` → shared `LazyLock<RwLock<…>>`; `TEX_SWAP_ALIASES` → single locked registry. | **L** | ✅ ships safely alone, but buys nothing on its own — see §4 |
| **2.1c** | Actually dispatch the walk to the pool; per-round results marshalled back. Needs the toolchain (§2.5) linked first. | **L** | ❌ requires 2.1a+2.1b+2.2 |
| **2.3** | Move the `spawn_local` net `recv_loop` off the main thread. | **M** | independent |

Net: the handoff's "1 XL" is really **S + M + L + L**, and the L that must come first (2.2) is the
one it scheduled *second*.

## 4. Why §2.2 goes first — and what it does NOT buy

**Correction (2026-07-24, same day):** an earlier draft of this section claimed §2.2 "pays off
without threads" because the bake worker is a second wasm instance with its own `thread_local`
copies. The premise is true; **the conclusion was wrong.** The bake worker has a separate wasm
*linear memory*, and an `Arc<RwLock<…>>` cannot span two linear memories any more than a
`thread_local` can. Cross-instance duplication is fixed by threads *replacing* the bake worker,
not by the container swap. Do not justify §2.2 on a standalone RSS win — there isn't one.

What §2.2 actually is: **behaviour-neutral preparation.** Single-threaded, one wasm instance has
exactly one thread, so `thread_local` and a process-global container are functionally identical —
same entries, same eviction order, same `decodeAmp`. The reason to land it first is ordering, not
payoff:

- It is a **co-requisite** of 2.1c (§2, above): the pool is strictly worse without it.
- It is **mechanically independent** of the toolchain and of the boundary work, so it can land and
  soak on the normal single-threaded client with no thread-related risk.
- Its regression gate is testable **today** on native threads, before any wasm pool exists
  (`model_tri_cache_is_shared_across_threads`) — the property is locked in early rather than
  discovered during the XL.

Costs to watch, since there is no upside to offset them: one lock acquisition per cache op, and
`RwLock` poisoning as a new failure mode.

## 5. Risks specific to this scope

- **Per-round hop latency** (§1b) — 69 call sites of `ensure_walk_prefetched*` (46 plain,
  15 `_keyed`, 5 `_keyed_urgent`, 3 `_urgent`) all inherit the round-trip. The urgent lane
  (`prefetch_urgent`, added because FIFO semaphore queuing starved interior loads for *minutes*,
  `manifest_source.rs:327-336`) must keep its priority across the boundary or that regression
  returns.
- **`RwLock` write-heavy cold load** — cold boot is nearly all cache *writes*; a naive single
  `RwLock` may serialize worse than N `thread_local`s. Validate `decodeAmp == 1.00` **and** settle
  before/after; consider sharding the cache by DID prefix.
- **Confinement is not compiler-checked.** Nothing stops a future edit handing
  `ManifestResourceSource` to the pool and silently arming `inflight.rs:116`. Mitigate with a
  wrapper type whose only pool-visible constructor yields the narrow handle.

## 6. Immediate next actions

1. **§2.2 in progress.** `MODEL_TRI_CACHE` converted (`lib.rs` — `LazyLock<RwLock<ModelTriLru>>`,
   `Rc` → `Arc`, single `model_tri_cache()` write-guard accessor). wasm32 checks clean; both cache
   tests pass; the new cross-thread gate was negative-controlled (made the accessor per-thread
   again → it FAILS with the eviction test still passing, so the gate is specific, not decorative).
   Remaining: `SURFACE_PIXEL_CACHE` (7 sites), `TEX_SWAP_ALIASES` (2 sites + the alias-collision
   redesign, which is the only genuinely semantic piece).
2. Land **2.1a** alongside it — S-sized, no behaviour change, makes confinement explicit.
3. Defer 2.1c until the §2.5 toolchain links; treat first successful atomics link as the milestone
   gate before any further Rust restructuring.
4. Before ANY measurement: rebuild `pkg/` — `serve.py` reports the current wasm **predates the
   last Rust-touching commit**.
