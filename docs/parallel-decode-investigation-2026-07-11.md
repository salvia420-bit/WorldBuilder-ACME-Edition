# Parallel-decode program investigation (2026-07-11, read-only session)

Firming the 1118 §5 wasm-threads ballpark ("batch splitting → second
worker (~2× ceiling) → threads endgame") into a verified, sequenced
program. Every §5 claim was read-verified inline this session (no
agents). Target residual per 1119 §4: the **~15 s first-hop cold pipe**
(decode CPU + worker init); ordering is fully solved (s9 queue + s10
entity-urgent ABI: urgent dispatch 147 ms under a TN storm).

## 1. Claim-by-claim verification of 1118 §5

| §5 claim | Verdict | Evidence |
|---|---|---|
| shard cache already `Arc<Mutex<HashMap>>` | ✅ | `manifest_source.rs:261-262`, `manifest_source_v1.rs:39` |
| `Semaphore` thread-safe, multi-thread-tested | ✅ | `concurrency.rs:46-59` (std Mutex + futures oneshot); `#[tokio::test(flavor="multi_thread", worker_threads=4)]` at `concurrency.rs:116` |
| `ResourceSource: Send + Sync` static bound | ✅ | `holtburger-dat/src/lib.rs:149` |
| XL: unsafe Send/Sync over JS fetch futures | ✅ | `inflight.rs:115-118` (cfg wasm32, `LocalBoxFuture` + `Shared`); `walk_dedup.rs:63-65` (apps/holtburger-web/src/, generic over ALL K/T/E — broader than inflight's). **Third user site**: `prefetch.rs` reuses `WalkDedupMap` (doc block :60-80) — covered by the walk_dedup fix but must be audited when pinning fetch to one owner thread |
| L: `TEX_SWAP_ALIASES` per-instance mint | ✅ | `lib.rs:5886-5915` — thread_local two-way map, IDs minted `0x08F00000 + len` per instance, deliberately never memoised cross-instance |
| ~4 of ~60 thread_local slots decode-path | ✅ (~5) | decode-path set: `MODEL_TRI_CACHE` (lib.rs:7923 — holds `Rc<Vec<Tri>>`, needs `Arc` under real threads), `SURFACE_PIXEL_CACHE` (:8856), `COMPOSED_CACHE_COUNTERS` (:8862), `DECODE_DIAG` (:9211), `TEX_SWAP_ALIASES` (:5888). 36 `thread_local!` blocks total across the wasm crate + deps |
| Toolchain L: nightly + build-std needed | ✅ and CONFIRMED ABSENT | `rustup toolchain list` = stable 1.95.0 only; wasm-pack 0.14.0 (no thread-pool glue emission). Cold build-std builds likely exceed the 8 GB laptop jail → buildbox job |
| Infra cheap: COOP/COEP two headers | ✅ | `scripts/serve.py` `end_headers()` (:293) has NO Cross-Origin headers today; `scripts/proxy.cjs` likewise |
| SW v2→v3 bump | ✅ | `service-worker.js:22` `holtburger-content-v2` |
| vendor 4 jsdelivr importmap entries | ✅ | `index.html:951-960` (three, three/addons/, postprocessing, tiny-invariant) |
| dep-graph atomics compat unverified | ✅ stands | wasm32 tree carries tokio 1.50, rand 0.10, getrandom 0.4.2, once_cell 1.21 — compiles single-threaded today; +atomics link is the only real test |

## 2. NEW finding — hardware caps the endgame payoff

**This laptop has 4 cores** (`nproc` = 4). Main thread + compositor +
bake worker already occupy most of them. A SAB thread pool could run
~2–3 decode threads before contending with the render/main threads —
i.e. the multi-week threads endgame buys **~1.5× over the M-sized
second worker** on the primary dev box. The 2× second-worker ceiling
and the threads ceiling nearly coincide on this hardware. The endgame's
ROI case therefore rests on future hosting/hardware (1070-class or
served-to-public boxes), not on the current dev loop.

## 3. Second-worker complications, sized (from code read)

- **Alias routing is NOT a new problem**: the R-1 alias split
  (`bake_worker_client.js:17-58`) already routes alias DIDs
  (`0x08F00000`-slice) to the main-thread leg and stitches in input
  order. With 2 workers, aliases still go to main; the "3-way split"
  is just the existing splitter gaining a shard step for non-alias DIDs.
- **Shard the non-alias DIDs by hash** (e.g. `did % 2`) so each
  worker's thread_local decode caches (tri memo, surface pixel LRU)
  stay coherent per shard — round-robin would halve every cache's
  hit rate; hash-sharding keeps decode-once semantics per instance.
- **Fetch semaphore doubles** (per-source-instance,
  `manifest_source.rs:435`): 32→64 outstanding permits. Harmless —
  the browser's 6-per-host HTTP cap is the real gate, and the SW cache
  is shared across workers.
- **Memory is the gating measurement**: duplicated wasm instance
  (4.8 MB code + heap) + duplicated caches on the 8 GB box. Prototype
  behind `?bakeWorkers=2` default-OFF; measure heap + cold-pipe delta
  before any default-ON conversation.
- **Init doubles at boot** — prewarm worker 2 during boot (before
  first teleport) so it never lands on the cold-pipe path.

## 4. Recommended sequence (revised ladder)

1. **Batch splitting (S, JS-only, next session)** — chunk large DID
   batches client-side so lane-0 urgent work preempts mid-batch.
   No wasm change, improves urgent latency under storm, and is a
   prerequisite anyway for spreading a batch across 2 workers.
2. **Second decode worker (M, JS-only)** — `?bakeWorkers=2` flag,
   DID-hash shard, aliases stay on the main leg, boot prewarm.
   Expected ~1.5–1.8× on the decode-bound fraction of the cold pipe;
   gate default-ON on the heap measurement.
3. **Threads endgame: HOLD.** Re-open when target hardware/hosting has
   >4 cores or when the second worker measurably saturates. The cheap
   infra prerequisites (COOP/COEP headers, SW v3 bump, vendoring the 4
   importmap entries, nightly+build-std on buildbox) are a checklist to
   keep, not work to start — COOP/COEP in particular changes
   cross-origin behavior and should not land ahead of need.

Unresolved before step 2 ships: actual per-instance heap numbers (live
measurement, next capture session) and the `?bakeQueueCap` 2/4/8 sweep
(still owed from 1117 §4) — cap interacts with worker count.
