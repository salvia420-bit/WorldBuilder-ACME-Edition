# HANDOFF — A15 (a)+(b) landed, measured, and re-aimed (2026-07-25)

> Supersedes the *status* of `HANDOFF-wasm-threads-SAB-2026-07-24.md`. Its recommended moves
> 1–3 are DONE; §2.1c (the pool) remains open and its justification changed — see the verdicts.
> Design: `DESIGN-A15-ab-2026-07-24.md`. SAB audit: `AUDIT-sab-views-2026-07-24.md`.
> Settle re-run: `RESULTS-settle-vs-age-2026-07-25.md`. Anchor by symbol; lines drift.

## What landed (all default-neutral; every gate host-supplied, none Rust-read URL flags)

| commit | slice | content |
|---|---|---|
| 63938b48 | S0 | Defects 1–4: worker gets `locationSearch`/`__hbVerifyShards`/fetch-concurrency via init message; `seed_url_flag_search` called; fetch cap honest 32/page (main 24 / worker 8); `url_flag_diag()` export. Perf-league audit: **no tainted entries** (all runs were compiled-default single-arms). |
| f28adebe | S3a/b | `crates/holtburger-dat/src/scratch.rs` (ScratchPool/ScratchBuf/ScratchLease, no thread_local!) + fused `normal_and_height_from_luminance` (blur-once, byte-identical, 20-fixture equality gate). dat tests 609→621. |
| f476167f | audit | SAB-view audit: 0 live breaks, 14 invariant-dependent sites, 4 must-fixes. |
| 3e630a22 | audit fixes | `pushBuffer` SAB guard (returns the array — callers must use the return), 3 `adapter.js` ImageData copies, `audio_manager.js` decodeAudioData copy, House rules appended to the audit. |
| 90fa3d12 | S1 | `decode_admission.rs` (DecodeAdmission/DecodeLease, Semaphore-shaped, urgent lane, `revise()`); leases at `fetch_surfaces_pixels`(per-16-chunk)/`fetch_model_meshes`/`fetch_building_placement`/entity twins; diag `decodeAdmission.*` + `shardCacheBytes`. Neutrality: queued=0 across 23,955 admits. |
| 726daa39 | S2 | `ResourceSource::get_file_shared → Arc<Vec<u8>>`; `V2Source.shards` values Arc'd; explicit forwards (DecodeSource/MissCountingSource/RecordingSource) with a negative-controlled gate test; hot read sites converted. `RecordingSource` moved to `recording.rs` (target-agnostic). |
| f62e3d32 | S3 wiring | Both surface-decode call sites use the fused pass over one `LazyLock<ScratchPool>` (cap 4); both sites used strength 1.0. |
| ffb77acd | shards LRU | `shard_cache.rs`: byte-budget LRU on `V2Source.shards`, default unbounded, `?shardBudgetMB=N` host-supplied to both instances; eviction-soundness invariant documented in-code (walk re-fetches; Arc readers safe; `begin_round`/`end_round` protects a round's own inserts). Diag via `globalThis.__hbShardCache`. |
| 750cb1ec | S4 | Gate armable: `?decodeAdmission[Main|Worker]=<jobs>x<MB>[+reserve]` (worker verbatim, main half; `+` and space both accepted — URLSearchParams decodes typed `+` as space). Absent = bit-for-bit unbounded. |
| 009b09e8 | measure | Settle-vs-age re-run on release wasm (16 hops, per-hop driver re-hosting the probe's metric). |
| 369f5983 (merge of 86351c5d) | S5 | Pressure hysteresis: `?decodePressure=<t1MB>[:<t2MB>]` → monotone level 0/1/2, effective caps ÷2/÷4 (min 1), urgent reserve never scaled, 250 ms sampler in `decode_admit`. Diag `effectiveMaxJobs/effectiveMaxBytes` + real `pressureLevel`. **Live time-to-OOM soak NOT run.** |

Tests: holtburger-dat 621 · holtburger-resource-http 17 · holtburger-web --lib 185 (+1 pre-existing
substitution failure, untouched) · JS flag suite 61 assertions. Every new gate negative-controlled.

## What measurement did to the theory (each verdict changed the plan)

1. **The transient decode peak is small.** S1: ~18.5 MB page-wide (worker 18 MB, main 0.5 MB)
   vs an ~80 MB two-instance shards ratchet. The unbounded `shards` map — which the 07-24 handoff
   never named — is the dominant *tracked* ratchet. Hence `ffb77acd`.
2. **The churn hypothesis failed.** S2's Arc conversion (design §1 site A, "60–120 MB churn per
   cold LB") produced **no wasmMemoryBytes improvement above noise** (n=2/arm). Reason: main's
   high-water is set during the FIRST cold-bake spike and never moves again (689–717 MB at hop 1,
   flat for 15 more hops, dev and release identical to within 1 MB). Removing steady-state churn
   cannot lower a high-water already set. S2 still stands (real copies removed, byte-identical).
3. **The gate gates; the memory win is unproven.** S4 smoke (n=1/arm): too-tight arm regresses
   hard (maxQueueMs 29.1 s vs 0 unbounded; peakLiveJobs == cap). Arm B showed a 44% first-hop
   high-water drop (402 vs 713 MB) **but Arm T bounds harder and matched unbounded at 717 MB** —
   if concurrency drove the peak, T would be lowest. Do not bank the 44% until the full ≥20-min
   battery repeats it.
4. **Finding 5 holds directionally, magnitude refuted** (`RESULTS-settle-vs-age-2026-07-25.md`):
   revisit 2.4 s vs novel band 9.8–16.6 s; but the 84.7 s cold and 20–28 s novel cap were
   dev-wasm artifacts, and the anchor's THIRD visit climbs back to 9.2 s (likely LRU re-decode).
   **Path A's XL now argues against a ~16 s ceiling, not ~85 s.**
5. **Release wasm buys zero heap headroom** (module 16.3→4.88 MB; heap unchanged), and both
   instances pin ~96 MB `surfaceCacheBytes` from hop 1 — finding 6's duplication is immediate,
   not load-dependent. `shardCacheBytes` is the only true slow ratchet (70→109 MB over 16 hops).
6. **24 MB/instance shard budget thrashes** (~280 MB refetch churn over 3 hops — below one
   round's working set). A production number looks like **48–64 MB/instance**; now measurable.

## Recommended next moves, in order

1. **Full S4 battery** (design §4 S4: 3 arms, ≥20 min, fresh profile per arm, release wasm,
   `battery-telepoi.mjs`/`battery-outdoor-run.mjs`) to settle whether the bound truly cuts the
   first-spike high-water. If the 44% repeats, S4's default should be armed after a settle-cost
   check; if not, the first-spike peak needs a different lever (e.g. smaller first-bake batches).
2. **S5 soak** — the ~30-min roam crash, artifact = time-to-first-renderer-OOM, arms: inert vs
   `?decodePressure=` at thresholds informed by the 689 MB flat line (e.g. 512:768). Combine with
   `?shardBudgetMB=48` (or 64) — the two levers attack the two ratchets that actually showed up.
3. **Only then re-scope §2.1c** (rayon pool) against the ~16 s settle ceiling and the
   must-fix-before-pool list in `AUDIT-sab-views-2026-07-24.md` (item 1 `pushBuffer` guard is
   DONE in 3e630a22; item 2 build-gate checklist is written but must be RUN per threaded build).
4. **Surface-cache duplication** (~96 MB × 2 pinned from hop 1) is now the largest addressable
   resident block after the first-spike mystery — worth a design pass (shared vs split budget)
   independent of threads.

## Traps added/confirmed this pass (keep)

- Subagent worktrees: vendored `external/chorizite` is gitignored → Rust builds in a fresh
  worktree panic on `protocol.xml`; symlink it from the main checkout. Worktrees may also branch
  from a stale base — fast-forward to HEAD first.
- `URLSearchParams` decodes a typed `+` as a space — flag grammars must accept both.
- The shipped `portal-settle-probe.mjs` computes ONE settle per process; within-session claims
  need its recorder re-hosted in a per-hop driver.
- ACE holds an abruptly-closed session ~60 s ("Account In Use") — wait 70 s between arms; your
  own lingering probe browser is the usual culprit.
- The parked character's town silently enters routes as a pre-warmed "novel" hop — check
  `@loc` before designing a route, park somewhere off-route after.
- `pkg/` now holds the RELEASE build (4.88 MB). Dev iterating: rebuild --dev or boot fails stale.
