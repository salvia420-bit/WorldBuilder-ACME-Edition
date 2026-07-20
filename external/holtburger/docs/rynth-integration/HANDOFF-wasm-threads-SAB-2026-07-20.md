# HANDOFF — wasm-threads (SharedArrayBuffer) — the real fix for main-thread decode starvation (2026-07-20)

> Branch: `perf/explorer-loop` (tonight's work committed + pushed).
> Effort class: **multi-week XL** (1118 §5, 1120-appendix §A14). NOT autonomous-loop scope.
> This handoff starts the effort. Every claim below is cited `doc §section` and/or `file:line`,
> and every code citation was re-read against the tree on this branch (line numbers had drifted
> from the older docs — the **current** lines are given here).

---

## 1. Why wasm-threads (SAB) is the real fix

Tonight's re-aim (`perf-loop-reaim-2026-07-19.md`) established that the bottleneck is **CPU-side
decode/bake/residency on the main thread**, not GPU draw submission:

- Render cost is ≈ nothing: the harness runs `nullRender=1` (skips `render()`) and **every**
  symptom — settle time, the 30 s freezes, the RSS crash — still reproduces
  (`perf-loop-reaim-2026-07-19.md` "The bottleneck is CPU-side…", citing 1125 §2 / 1121 §5b / 1124 §7).
- `bakeWorker=0` makes chatReady **32× worse** (163 ms → 5,241 ms) — the whole gap is main-thread
  decode volume (`perf-loop-reaim` §, citing 1125 §2).
- The wasm net loop is `spawn_local` **on the main thread** (verified `apps/holtburger-web/src/lib.rs:35352`,
  the `recv_loop(…)` task; login is deferred behind `requestIdleCallback({timeout: 20000})`,
  `apps/holtburger-web/index.html:10182-10183`). Per 1120 §3: "most of the ~60-77 s headless boot is
  SwiftShader main-thread starvation, not protocol; on a real GPU it should collapse." The main
  thread is the single scarce resource — net recv, decode, and bake all contend for it.

This one root cause drives **both** headline pains measured tonight:

- **Settle-time pain** — `perf-baseline-2026-07-20.md`: 58/62 POIs landed, settle median **21.3 s**,
  and **26/58 POIs never settle within 25 s**. Those caps are the main thread saturated by cold
  decode; a POI with 354 cells (Shoushi) or 904 (Outpost) simply cannot drain on one thread in time.
- **RSS growth → the ~2.8 GB crash** — `A15-rss-decision-2026-07-20.md`: the wasm main instance
  climbs to **587 MB** across the single-session battery, and the real crash is a
  **`WebAssembly.Memory` high-water-mark** problem — the *peak concurrent decode/bake working set*
  sets a permanent RSS floor (memory only grows, never returns pages). Peak concurrency is unbounded
  today precisely because there is nothing to bound it against on a single thread.

**Why SAB fixes both:** SharedArrayBuffer + a real worker **thread pool** (wasm-bindgen-rayon) moves
decode/bake off the main thread onto N worker threads sharing one linear memory. That (a) unblocks
the main thread so net recv / input / frame submission stop starving → settle collapses, and (b) makes
a **bounded** concurrent-decode pool the natural unit of work, which caps the peak working set → caps
the RSS high-water floor. Threads also **eliminate the per-instance manifest/shard/cache duplication**
that a second *worker* (separate wasm instance) would add (1120-appendix §A14), because all threads
share one memory and one cache.

### Why a/b/c (from A15) are only stopgaps

`A15-rss-decision-2026-07-20.md` lists three interim options; each is worth doing as **relief before
threads land**, but none removes the single-thread ceiling:

- **(a) Bound concurrent in-flight decode + wasm-memory-sampler backpressure** — shrinks the peak
  working set → lower RSS floor. Interim-worth: it's the cheapest RSS relief and its bounding logic
  is a **prototype of the thread-pool admission control** threads will need anyway. Stopgap because
  it *slows* decode on one thread (changes settle timing; needs battery A/B) — it trades the crash
  for slower settle, exactly the tension threads dissolve.
- **(b) Reduce per-bake transient allocation in Rust (reuse decode scratch buffers)** — the most
  principled single-thread fix; lowers the floor without slowing decode. Interim-worth: scratch-buffer
  reuse is **required regardless** and pays off under threads too (per-thread scratch pools). Stopgap
  only because it still leaves all decode on one thread.
- **(c) Periodically tear down + recreate the wasm instance at quiet points** — reclaims the
  high-water directly. Interim-worth: a genuinely simple crash-avoider for long soaks *today*.
  Stopgap because it's coarse (risks a hitch at teardown) and does nothing for settle time.

Recommended sequencing: land **(a)** and/or **(b)** as near-term crash relief while the multi-week
threads work proceeds; keep **(c)** in the pocket for the long YouTube soak. None of them is the fix.

---

## 2. Scope / concrete blockers (verified against the branch)

### 2.1 `unsafe impl Send/Sync` over JS-fetch futures — the XL correctness core
The prefetch/inflight dedup maps assert `Send + Sync` **only because wasm32 is single-threaded today**;
real threads make them silently unsound (the compiler will not catch it):

- `crates/holtburger-resource-http/src/inflight.rs:116` `unsafe impl<E> Send for InflightInner<E>` and
  `:118` `unsafe impl<E> Sync …` — SAFETY comment at `:110-115` literally reads "wasm32 is
  single-threaded … no actual cross-thread access happens." (Rationale docstring `:40`, `:82`.)
- `apps/holtburger-web/src/walk_dedup.rs:63` `unsafe impl Send for WalkDedupMapT` and `:65`
  `unsafe impl Sync …` — comment `:57-62` says it "mirrors `inflight::InflightMap`'s recipe."
- `apps/holtburger-web/src/prefetch.rs:74` documents the same wrapper pattern.

**Requires (XL — the fetch/decode boundary split, per 1118 §5):** pin all `web_sys::fetch` /
`JsFuture` / `Promise` work to **one owner thread** (the JS futures are genuinely `!Send`), and
message-pass decoded `Vec<u8>` to the worker pool. The dedup maps then hold only `Send` data and the
`unsafe impl`s can be removed (or made real). Pre-shaped ≈60% already (1118 §5): the shard cache is
`Arc<Mutex<HashMap<_, Vec<u8>>>>`, `Semaphore` is thread-safe, `ResourceSource: Send + Sync`, and
decode fns already take the source as a param.

### 2.2 `TEX_SWAP_ALIASES` shared-id redesign — the L correctness redesign
Wire texture-swaps mint synthetic alias DIDs in a reserved slice of the 0x08 Surface space, in a
**per-wasm-instance** `thread_local` registry:

- `apps/holtburger-web/src/lib.rs:5919` `const TEX_SWAP_ALIAS_BASE: u32 = 0x08F0_0000;`
- `:5926` `thread_local! { static TEX_SWAP_ALIASES: RefCell<(HashMap<u32,(u32,u32)>, HashMap<(u32,u32),u32>)> }`
- `tex_swap_alias_for` `:5936`, `resolve_tex_swap_alias` `:5952`. The design comment `:5907-5924`
  states aliases are minted on the main thread but pixel decode may run in the **bake worker's
  SEPARATE wasm instance whose registry never minted them**; today the client splits alias DIDs back
  to the main-thread wasm and the negative cache refuses the alias block so an unresolvable alias is
  "never memoised as absent."

**Requires:** the disjoint per-instance ID spaces are deliberate today (1118 §5 / §A14 call it a
"correctness redesign"). Under one shared memory the alias registry must become a **single shared
registry** (`Arc<RwLock<…>>`), which removes the main-thread split-back dance — but it is a semantic
redesign, not a mechanical port. Do this together with converting the **B1 surface cache** and
**`MODEL_TRI_CACHE`** to shared `Arc<RwLock<…>>` containers in the same threads session (§A14).

### 2.3 The `spawn_local` main-thread net loop
`apps/holtburger-web/src/lib.rs:35352` `spawn_local` runs the `recv_loop(…)` on the main event-loop
thread (also `:2765` and the login-connect tasks `:35429/:35452`). Under threads the recv/decode
pipeline should hand raw packets to the worker pool so protocol progress never blocks on decode and
vice-versa. (1120 §3 confirms the ~60-77 s boot is main-thread starvation, not protocol.)

### 2.4 Cross-origin isolation (COOP/COEP) — infra, currently ABSENT
`SharedArrayBuffer` requires the document be cross-origin isolated
(`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). **Neither
is set today:**

- `scripts/serve.py` `end_headers()` (`:293-318`) sets only `Cache-Control`/`Pragma`/`Expires` — no
  `Cross-Origin-*`. `rg -i 'Cross-Origin|Embedder|Opener'` over `scripts/` returns nothing.
- `scripts/proxy.cjs` (the prod precedent) sets no COOP/COEP either.

**Requires (CHEAP per 1118 §5):** add the two headers in `serve.py end_headers()` and `proxy.cjs`;
all workers are same-origin URL workers (`bake_worker_client.js:181` `new Worker(new URL("./bake_worker.js", import.meta.url))`);
the WS bridge is COEP-exempt. Two follow-ons under `require-corp`:
- **Vendor the jsdelivr importmap** — `index.html:948-960` pins `three@0.184.0`,
  `postprocessing@6.39.1`, `tiny-invariant@1.3.3` from `cdn.jsdelivr.net`; cross-origin subresources
  need CORP/`crossorigin` or must be self-hosted (`@takram` is already vendored). Under COEP they
  will otherwise fail to load.
- **Bump the service worker cache** — `service-worker.js:22` `CONTENT_CACHE = "holtburger-content-v2"`
  → **v3**. Pre-header cached shards/index.html would otherwise be replayed WITHOUT the isolation
  headers and silently break `crossOriginIsolated` (an empty-world-class failure; see MEMORY
  staleness rules — SW caches across restarts, only `?nosw=1` clears).

### 2.5 Toolchain bring-up (L, per 1118 §5)
- Rust **nightly** + `-Z build-std` (core/alloc/std rebuilt with atomics).
- Target features `+atomics,+bulk-memory,+mutable-globals`; shared-memory link flags
  (`--shared-memory`, `--import-memory`, max-memory sizing).
- **`wasm-bindgen-rayon`** worker-pool glue + the pool-init JS wasm-pack does not emit.
- Dep-graph atomics compat is **unverified until it links** — treat first successful link as a
  milestone. `pkg/` is gitignored → rebuild discipline unchanged (§MEMORY: release wasm ~4.5 MB, dev
  ~18 MB = 4× tax; measure release only).
- **Both** the main-thread import and the bake worker import `pkg/holtburger_web.js` — the threaded
  build must satisfy both entry points.

---

## 3. Validation plan

Use the EXISTING rig (`perf-loop-reaim-2026-07-19.md` "Measure with the EXISTING rig" — do not
reinvent). All scripts verified present.

- **Settle battery** — `scripts/net-review/battery-telepoi.mjs` (the 62-POI A/B rig that produced
  `perf-baseline-2026-07-20.md`). Headline metric: **settle median** and **count-capped-at-25s**
  (26/58 today). Threads should collapse both.
- **Responsiveness** — `scripts/net-review/portal-settle-probe.mjs` (chatReadyMs + input-lag p95 via
  50 ms setTimeout-chain drift + long-tasks >100/>500 ms). This is the metric that directly reflects
  main-thread unblocking.
- **RSS canary** — `wasmMemoryBytes` via `__diag.datDecode` (JS shim `scene3d/index.js:3576`, Rust
  `wasm_memory_bytes()` `apps/holtburger-web/src/lib.rs:9205`, emitted in `dat_decode_diag`
  `:9345/:9369`). **The main instance's `wasmMemoryBytes` is the crash proxy** (climbs to 587 MB
  today while JS heap stays flat ~93 MB — `A15` / `perf-loop-reaim` §). The bake worker's instance
  reports through the worker relay; **under threads there is one shared memory** — validate the
  high-water floor is bounded and that per-thread scratch does not re-inflate it.
- **`decodeAmp = total/distinct`** must stay 1.00 (B1 surface cache invariant) after the cache is
  converted to a shared `Arc<RwLock<…>>` — a shared cache must not re-introduce double-decode.

### The SwiftShader-vs-1070 caveat (do not skip)
The **30 s freeze class does NOT reproduce on a quiet 1070 — it needs CPU pressure**
(`perf-loop-reaim` §, 1125 §2). The laptop SwiftShader arm measures **CPU/submission**; the 1070
measures **GPU** (`perf/README.md` measurement rules). Threads target the CPU/main-thread axis, so the
**laptop is the primary validation plane** for this work — but tag which plane every verdict came
from, and confirm on the 1070 (batched, off-screen, per fleet rules) that moving decode to threads
does not regress the GPU path.

### A/B discipline (the confound is load-bearing)
`perf-baseline-2026-07-20.md` CONFOUND: the baseline was **single-session**, so residency
accumulates (lru→203, wasm→587 MB) and later stops starve — settle-cap is the residency-accumulation
signal, not clean per-POI cost. For threads A/B: **fixed-length sessions** (`--maxStops`),
**session-age-matched medians** (`settleMedBySession`), 65 s inter-arm quiet-gap (ACE 60 s reap),
paired per-POI deltas. Fresh throwaway browser profile per run (arm-2 shader cache must not warm from
arm-1 — `perf/README.md`). Renderer deaths fragment sessions and make `settleMed` lie (1121 §2 /
1123 §2).

---

## 4. Risks + effort

**Effort: multi-week XL** — 1118 §5 sizes it **1 XL + 2 L + several S/M**; §A14 keeps "threads (SAB)"
as the only lever that fixes main-thread starvation and eliminates per-instance duplication.
≈60% is pre-shaped (shard cache Arc-Mutex, thread-safe Semaphore, `ResourceSource: Send + Sync`).

**Correctness risks (the reason this is XL, not just plumbing):**
- **Data races if the `Send/Sync` asserts are wrong.** The `unsafe impl Send/Sync` at
  `inflight.rs:116/118` and `walk_dedup.rs:63/65` are sound ONLY single-threaded; enabling threads
  **without** first pinning fetch to one owner thread makes them **silently unsound — the compiler
  will not catch it** (1118 §5). This is the single highest-risk item; land the fetch/decode boundary
  split BEFORE turning on the thread pool.
- **`TEX_SWAP_ALIASES` identity collisions.** Two threads minting into disjoint-by-assumption ID
  spaces will collide under a naive shared registry; the shared-id redesign
  (`lib.rs:5919/5926/5936`) must be a real registry with proper locking, not a mechanical port —
  wrong here = corrupted textures / wrong-pixel decode, not a crash.
- **Isolation regressions from stale caches.** Forgetting the SW cache bump (`service-worker.js:22`
  → v3) replays pre-header content and silently drops `crossOriginIsolated` → SAB unavailable →
  empty-world / silent fallback. The COEP importmap vendoring (`index.html:948-960`) has the same
  failure mode for three/postprocessing.
- **Toolchain non-linkage.** Dep-graph atomics compat is unverified until it links (1118 §5); budget
  for a dependency that will not build with atomics.
- **Deadlock/contention** from converting B1 + `MODEL_TRI_CACHE` to `Arc<RwLock<…>>` (§A14) — shared
  caches under a write-heavy cold-load can serialize; validate `decodeAmp` stays 1.00 and settle
  does not regress vs the single-thread cache.

Mitigation ordering (from §A14 / §5): fetch/decode boundary split (XL) → toolchain link (L) →
TEX_SWAP shared registry (L) → shared cache containers → thread-pool admission bounding (this is where
A15 option (a)'s bounding logic is reused) → battery + RSS validation.

---

## 5. Pointers

**Tonight's artifacts (this branch, `perf/explorer-loop`):**
- `docs/rynth-integration/perf-loop-reaim-2026-07-19.md` — the re-aim (decode/bake/residency is the
  lever; draw calls ruled out).
- `docs/rynth-integration/perf-baseline-2026-07-20.md` — 62-POI settle baseline (58/62 landed, median
  21.3 s, 26/58 capped, wasm main 587 MB).
- `docs/rynth-integration/A15-rss-decision-2026-07-20.md` — the RSS high-water decision (options a/b/c;
  sealed-terrain gap neutralized).
- `docs/rynth-integration/perf-league.md` / `perf-league.json` — the decode-axis league.
- `git log --oneline origin/master..perf/explorer-loop` — the RE-AIM + baseline + A15 + league commits.

**Perf toolkit** (`apps/holtburger-web/perf/`, README documents the loop):
- `soak_launch.cjs` (headless explorer + coverage floor), `perf_loop.cjs` (soak/rank/measure/gate),
  `perf_aggregate.cjs` (pure rank/gate), `perf_sampler.cjs` (in-page collector).
- Probes: `scripts/net-review/battery-telepoi.mjs`, `scripts/net-review/portal-settle-probe.mjs`.

**Prior-work docs** (`/home/wbterminal/WorldBuilder-ACME-Edition/docs/`, sessions 3–17, 2026-07-10/11):
- **1118.md §5** — wasm-threads (SAB) ballpark, 2-agent read-verified inventory (1 XL + 2 L + S/M;
  the ~60% pre-shaped list; the named blockers).
- **1120.md §3** — the `spawn_local` main-thread net-loop diagnosis ("SwiftShader main-thread
  starvation, not protocol; on a real GPU it should collapse").
- **1120-appendix.md §A14** — threads endgame reorder (threads = the only lever that fixes A1
  main-thread starvation; convert B1 + `MODEL_TRI_CACHE` to shared containers in the threads session)
  and **§A15** — residency roadmap (fixed-slot grid / park retention).
- **1111.md–1125.md** — the full prior perf effort (B1/B3/EnvCell real-bug fixes, sealedKeepRing,
  fixedGrid, instanced scenery, the battery-driver evolution and confound analysis).

**Key code sites** (branch `perf/explorer-loop`):
- `apps/holtburger-web/src/lib.rs:35352` — main-thread net `recv_loop` `spawn_local`.
- `crates/holtburger-resource-http/src/inflight.rs:116,118` — `unsafe impl Send/Sync`.
- `apps/holtburger-web/src/walk_dedup.rs:63,65` — `unsafe impl Send/Sync`.
- `apps/holtburger-web/src/prefetch.rs:74` — wrapper-map pattern doc.
- `apps/holtburger-web/src/lib.rs:5919/5926/5936/5952` — `TEX_SWAP_ALIASES` per-instance registry.
- `apps/holtburger-web/src/lib.rs:9205` `wasm_memory_bytes()`; `scene3d/index.js:3576` `__diag.datDecode`.
- `scripts/serve.py:293-318` (`end_headers`, no COOP/COEP) + `scripts/proxy.cjs` (same) — add headers.
- `apps/holtburger-web/index.html:948-960` — jsdelivr importmap to vendor under COEP.
- `apps/holtburger-web/service-worker.js:22` — `CONTENT_CACHE = "holtburger-content-v2"` → bump v3.
- `apps/holtburger-web/scene3d/bake_worker_client.js:181` (worker spawn) / `:577` (`terminate()`) /
  main-thread-fallback warnings — where bake/decode runs off the main thread today.
