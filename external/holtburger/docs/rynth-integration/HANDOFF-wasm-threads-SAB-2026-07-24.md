# HANDOFF — wasm-threads (SAB) after the gate + experiment pass (2026-07-24)

> Supersedes the *status* of `HANDOFF-wasm-threads-SAB-2026-07-20.md`; that doc's §1 rationale
> still stands, its §2 blocker list is now largely resolved, and several of its §2.4/§2.5 claims
> were **disproven by measurement** — see below. Branch `perf/wasm-threads-sab`, merged to master.
> Every line-number citation in the 07-20 doc had already drifted; **anchor by symbol.**

## TL;DR for whoever picks this up

Path A's *gates* are cleared and cheaper than advertised. The *shortcut* was tried and failed.
Nothing user-visible has shipped. The binding constraint turned out not to be threading topology
but **total wasm footprint** (~900 MB on a ~4 GB-available rig), which the handoff's own interim
options (a)/(b) attack directly and which nobody has started.

## What is DONE (11 commits, `ce47c413..HEAD`)

| § | Item | Result |
|---|---|---|
| 2.4 | COOP/COEP cross-origin isolation | **PASSES.** `serve.py --coi`. SAB + shared `WebAssembly.Memory` confirmed. |
| 2.5 | Atomics toolchain / dep-graph compat | **LINKS**, zero source changes. nightly + `rust-src` installed. |
| 2.5b | wasm-bindgen threads post-processing | **PASSES**, but only with a full flag set. |
| 2.2 / 2.2b / 2.2c | Decode caches + diagnostics `thread_local!` → shared | Landed, behaviour-neutral. |
| 2.1a | `DecodeSource` pool-facing handle | Landed. Confinement made explicit; SAFETY comments rewritten. |
| 2.1b | `discovery_round` extracted as the poolable unit | Landed, pure refactor. |
| — | Are the 69 walk closures `Send`? | **Yes**, compiler-proven, negative-controlled. |
| — | threads-lite experiment | **NEGATIVE — do not ship.** See `EXPERIMENT-threads-lite-2026-07-24.md`. |

### Claims in the 07-20 handoff that measurement DISPROVED
- "Vendor the jsdelivr importmap or it fails under COEP" — false; all load HTTP 200.
- "Bump the SW `CONTENT_CACHE` v2→v3" — unnecessary; the SW never caches `index.html`.
- "`proxy.cjs` needs COOP/COEP added" — unnecessary; it forwards upstream headers.
- "Budget for a dependency that will not build with atomics" — none exists.
- Implicitly, "§2.1 is one XL": it is really S + M + L + L, and the L it scheduled *second*
  (§2.2 shared caches) is a **co-requisite** that must come first.

## What is TRUE NOW that was not known on 07-20

1. **The threaded build is free.** Atomics + `-Z build-std` + a 25 MB dev wasm lands within noise
   of the normal build (arm A vs arm C). Do not budget for build-size overhead.
2. **The published `wasm-bindgen-rayon` recipe silently produces a NON-threaded package** on
   rustc 1.99-nightly. It exits 0 and prints "Your wasm pkg is ready". **Never trust the exit
   code** — verify with `scripts/wasm-memcheck.py` + `rg 'shared:true' pkg/holtburger_web.js`.
   Working flag set is in `SCOPE-2.5b`.
3. **New blocker class: Web APIs reject SAB-backed views.** Fixed once, in
   `holtburger-transport-ws` `send_to` (WebSocket). **Audit `fetch` bodies and `postMessage`
   before the pool lands** — this class will recur.
4. **Sharing one memory is worse than two on this rig.** One never-shrinking memory takes both
   threads' cold-load peaks coincidentally; the high-water floor is set at hop 1 and OOM arrives
   ~4× sooner.
5. **Settle tracks cold-decode VOLUME, not session age.** Revisiting one town at hops 1/8/16
   settles 84.7 s → 9.3 s → 8.3 s while novel towns cap at 20–28 s. This supports decode
   throughput (the real pool) as the settle lever and weakens "(b)/(c) alone would fix settle".
   n=1, crude metric — worth re-running properly.
6. **Duplication is real but only visible under load:** both instances saturate their own 96 MiB
   surface budget → 201 MB where the design documents 96 MiB. A 30-second probe shows ~2 MB and
   misleads. **Session length is a hidden variable in every measurement here.**

## Known defects left ON PURPOSE (do these before more shared-memory work)

> **STATUS 2026-07-24 (later same day): defects 1–4 are FIXED.** The page's query string,
> `__hbVerifyShards` and the worker's fetch-concurrency share now ride the bake worker's `init`
> message (`bake_worker_client.js` → `bake_worker.js` `handleInit`, applied before `init()` /
> `init_resource_source`). The F1 budget is split in JS before either instance connects
> (`applyFetchConcurrencySplit()`, main 24 / worker 8 of 32) so the page cap is honest again.
> A new wasm export `url_flag_diag()` is logged by both instances at init — a live boot shows
> identical `search` and `verifyShards` with `fetchConcurrency` 24 (main) vs 8 (worker).
> **Behaviour change:** the worker now honours Rust-side URL flags it used to ignore.
> Defect 2's audit found the perf-league / baseline evidence chain CLEAN (no entry toggles a
> Rust-side flag); the audit verdict is annotated in those files. Defects 5–11 remain open.

1. **`seed_url_flag_search` is called from no JS.** So under shared memory the URL-flag
   `OnceLock`s race — first reader wins, and a worker reads `""`. One call in `bake_worker.js`
   `handleInit`, *before* any flag-gated work, fixes it. **It is a behaviour change** (the worker
   would start honouring cache flags), which is why it was left for a decision.
2. **The bake worker has ALWAYS ignored Rust-side URL flags** (`js_location_search()` returns
   `""` with no `window`). Any historical A/B toggling a Rust-side decode flag — e.g.
   `?surfaceCache=off` — measured a system that only half-honoured it. **Audit the perf-league /
   baseline evidence chain for tainted entries.**
3. **Under sharing, the worker still calls `init_resource_source`**, so one memory holds two
   `ManifestResourceSource`s → two shard caches, two boot readers, and (per `concurrency.rs`,
   whose doc says "one per page") **two `Semaphore(32)` → a real global fetch cap of 64**, half
   defeating the F1 stutter fix. True today, not only under threads.
4. **`__hbVerifyShards` / `__hbFetchConcurrency` are read via `js_sys::global()`**, which is a
   different object in a worker and is never set there. Setting `window.__hbVerifyShards = false`
   skips sha256 on main only; the worker keeps verifying. Corrupts that flag's own A/B.
5. **`lib.rs` still has 31 `thread_local!` blocks**; ~7 were converted, each discovered
   reactively. No exhaustive classification exists. Note the `Send` compile experiment does **not**
   cover this — touching a `thread_local!` is not a `Send` violation.
6. **`surface_neg_cache_remove` / `_clear` are wired to JS but reach only the main instance**
   (armed trap: no JS caller yet). The instance that poisons a DID is overwhelmingly the worker.
7. **`NEXT_SCENE_COLLISION_ID` + `CELL_HANDLE_CACHE`** (holtburger-world) must convert **together
   or neither** — the ID's uniqueness is explicitly per-thread and only sound because its consumer
   is thread-local too. `CELL_HANDLE_CACHE` holds `Rc<dyn CObjCell>`, so sharing it means
   `Rc`→`Arc` across 20+ signatures in `objcell.rs`.
8. **`AUTHORED_MOTION_LENGTHS`** (holtburger-core) is `thread_local!` with **no cfg gate**, and
   its doc cites "wasm is single-threaded, matches the triangulation memo precedent" — the exact
   premise §2.2 invalidated.
9. **13 JS drain queues** in `lib.rs` (`*_PENDING`, `SKY_SHADOW`) are producer-on-owner-thread and
   drained by JS. Safe only while bakes run on the owner thread; silent data loss if a bake moves
   to the pool. Tripwire for §2.1c.
10. **Pre-existing test failure**, unrelated and untouched:
    `triangulate_setup_model_with_substitutions_composes_part_and_texture` — composed part+texture
    swap yields `0xCCCCCCCC` where the swap target `0xDDDDDDDD` is expected. Fails identically on
    master before any of this work.
11. **`cargo test -p holtburger-web` (unfiltered) cannot build** the native non-test `lib` target
    — 20 pre-existing errors. Use `--lib` for a working signal.

## Recommended next moves, in order

1. **Start A15 (a) + (b): bound concurrent in-flight decode with backpressure, and reuse decode
   scratch buffers.** The binding constraint is total footprint and these attack it directly. (a)'s
   admission-control logic is also the prototype for the thread-pool's. Four days of preparation
   have produced nothing user-visible; this is the shortest path to something that is.
2. **Fix defects 1–4 above.** Cheap, and three of them corrupt measurement — which means any
   further A/B is untrustworthy until they land.
3. **Re-run the settle-vs-age test properly** with `portal-settle-probe.mjs` (pass
   `--query "nullRender=1"` — the rig leaves `nullRender` unset unless `--render 1`, so it runs
   full SwiftShader and will crash this laptop). If finding 5 holds, the pool's justification
   strengthens; if it inverts, Path A may not be worth an XL.
4. **Only then §2.1c** (dispatch `discovery_round` to a rayon pool). Its prerequisites are done:
   toolchain links, gate passes, closures are `Send`, caches shared, `DecodeSource` exists.
   Expect the SAB-view class (finding 3) to bite again.

## Measurement rules learned the hard way (please keep)

- **Verify artifacts, never exit codes.** wasm-pack exits 0 on a non-threaded package.
- **Instrument the crash before theorising about it.** Two reproductions were burned attributing a
  crash to build overhead; ten minutes of live console/`pageerror`/crash capture named it as
  renderer OOM and refuted two competing hypotheses at once.
- **`cargo check` cannot see `inline_js`.** A regex rename inside that attribute shipped a
  boot-breaking bug past 164 green tests. Boot the client.
- **Session length is a variable.** 30 s said "2 MB"; 24 hops said "201 MB".
- **Negative-control every new gate.** Re-break the property and confirm the test fails for the
  right reason; three tests in this branch were validated that way.
