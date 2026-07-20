# perf-loop re-aim — the lever is decode/bake/residency, NOT draw calls (2026-07-19)

Written after reading the prior perf effort (`docs/1111.md`–`1125.md` +
`docs/1120-appendix.md`, sessions 3–17, 2026-07-10/11). The autonomous perf loop
was initially ranking landblocks by **draw calls** and **frame-time p95**. Both
are wrong axes. This doc records the correct target so the loop (and future
sessions) don't re-chase a dead lever. Every claim below is cited `doc §section`
and was code-verified.

## The bottleneck is CPU-side decode/bake/residency, not GPU draw submission

- Render cost is ~nothing: **"Render side ≈ nothing on the 1070 (+2 programs,
  nullRender Δ~40 ms chatReady)"** (1125 §2). The measurement harness runs
  `nullRender=1` — `render()` skipped entirely — and every symptom (settle time,
  30 s freezes, the RSS crash) still reproduces (1121 §5b, 1124 §7). If draw
  calls drove the pain, a no-render harness couldn't reproduce it.
- The pain is main-thread **decode volume**: "cold entries settle 4.0–5.1 s … the
  whole gap is decode volume (bakeSeq +128–137 cold vs +13 warm)" (1125 §2).
  `bakeWorker=0` → chatReady **32× worse** (163 ms → 5,241 ms) (1125 §2).
- The renderer-RSS crash (~2.8 GB, still open) is **wasm linear memory +
  geometry ArrayBuffers, JS heap FLAT at 93 MB** (1121 §5b) — a residency-memory
  problem, not a GPU one. NOTE: our sampler read `performance.memory`
  (JS heap) — the wrong memory; it must read wasm memory growth.

## Draw calls: explicitly the lowest-priority, GPU-gated, dormant lever

The only "draw" item is the **`static_batch_x` cross-LB batcher** — "built but
dormant", ranked opportunistic PERF, needs a 1070 eye-test nobody could run, and
explicitly below decode/residency (1120-appendix §A13c, 1124 §5.2). Our Holtburg
2258 / TN 1354 draws/f map to this dormant idea, not the responsiveness driver.
**Do not rank or optimize by draw calls or frame-time p95.**

## Measure with the EXISTING rig (do not reinvent)

- `external/holtburger/scripts/net-review/battery-telepoi.mjs` — teleports all 62
  `@telepoi` POIs, times land + stream-settle per stop. The A/B rig.
- `external/holtburger/scripts/net-review/portal-settle-probe.mjs` — chatReadyMs +
  input-lag proxy (50 ms setTimeout-chain drift) + long-tasks >100/>500 ms. The
  *responsiveness* metric.
- `__diag.bakeWorkerStats()` — `queue.posted` (decode volume; diff snapshots),
  `queue.byLane[].maxQueueMs` (pre-admission starvation), `byType[].totalMs`
  (decode time). `__diag.bakeWait()` — guard-level waits. `__diag.datDecode`.
- Canaries: `decodeAmp = total/distinct` (target **1.00**, already achieved by the
  B1 surface cache), `wasmMemoryBytes` growth.
- **Honest settlement** (1125 §1) = a 3 s window with: no long task >100 ms,
  input-lag p95 <50 ms, cell growth 0 + envInFlight 0, bakeSeq flat, entities
  flat, park+unpark+evict deltas 0. "Settle-stability is NOT completeness — a
  streaming-starved page 'settles' fast" (1113 §1).
- A/B discipline: fixed-length sessions (`--maxStops`), 65 s inter-arm quiet-gap
  (ACE 60 s reap), paired per-POI deltas; renderer deaths fragment sessions and
  make `settleMed` lie (1121 §2, 1123 §2).
- The 30 s freeze class does NOT reproduce on a quiet 1070 — it needs CPU
  pressure (1125 §2). It's CPU-bound and hardware-dependent.

## Already LANDED default-on — do NOT redo

warmPark, reclaimGate + park hysteresis, **sealedKeepRing**, TN dual-state storm
fix, **park UseTime 30 s floor**, **fixedGrid** (+ S15c EdgeParkScheduler),
server-LB urgent lane + urgent collision fetch, **bake-worker urgent-first
dispatch queue** (`bakeQueueCap` 4), entity-surface urgent ABI, decode
batch-split, **B1 surface positive cache** (decodeAmp proven 1.00),
MODEL_TRI_CACHE LRU, S16 palette-composed surface cache, A5 indoor double-decode
gate, terrain-ring batch (9× N+1 fix), bake-worker prewarm, A7 cold-path
parallelism, A12 LOD batch, **instanced animated scenery** (2026-07-02),
**sealedStaticsSkip** (portal-entry 30 s freeze → 107 ms; committed, live in
`scene3d/statics.js`).

## Open / next (the actual roadmap)

1. **62-POI settle re-baseline** under the new defaults (owed) — SAFE, high-value,
   the loop's best near-term job. Run `battery-telepoi.mjs` + `portal-settle-probe`.
2. **A15 residency continuation** — extend `fixedGrid` to buildings/statics/
   scenery; `fixedGrid` block-fetch has **no sealed-awareness** (outdoor ring
   terrain persists while sealed) — 1125 §5.2. Also the fix for the
   **renderer-RSS-crash class** (~2.8 GB, still recurs). Substantial Rust/wasm.
3. **Underground/Storage** spot-checks (~989 cell containers, ~5× TN) — decode
   capacity, not more skipping (1125 §5.1).
4. **Wasm-threads (SAB)** — the only real fix for main-thread starvation; multi-week
   XL (unsafe Send/Sync in `inflight.rs`/`walk_dedup.rs`). NOT autonomous-loop
   scope — surface for the user (1118 §5, 1120-appendix §A14).
5. Decode-wave capacity / 2nd worker — ONLY for weak-hardware cold pipe, after
   re-measuring; closed post-B1 for normal hw (1123 §1, 1125 §5.3).
6. `static_batch_x` draw batcher, anim-scenery GPU rigid-part — GPU-gated,
   need the 1070, lowest priority (1124 §5.2).

## Do NOT (dead ends already hit)

- Don't rank/optimize by draw calls or render — render ≈ nothing (1125 §2).
- `ringFloor=ringMax` — NEGATIVE, worsened churn (1113 §1).
- Don't build a 2nd decode worker blind — value pre-captured by B1 (1122 §5.2).
- Don't revive `bakeTerrainRing` wholesale — no guard/LRU, regresses (appendix §C2).
- Don't ship naive unpark-on-track — duplicates content, z-fight (1114 §2b).
- Don't promote netWorker — +24 % cold-load tax (1123 §1).
- `perPolyCull` reverted — real-GPU poly-drop regression (1124 §7).
- User steer (1120 §3): don't over-optimize with net-workers etc. and stop
  finding real bugs — the big wins were real 2–3× re-decode bugs (B1/B3/EnvCell).

## Net for the loop

Rank by **cold-entry chatReady / input-lag p95 / long-tasks under CPU pressure**
(portal-settle-probe style) and attribute cost to **bake/decode volume + residency
churn** (bakeSeq/queue.posted deltas, reclaimΣ, decodeAmp, wasm-mem growth) — never
draws. Realistic autonomous value now: the **62-POI re-baseline + regression watch**,
and possibly the **A15 residency continuation / RSS-crash** as the one substantive
fix — the easy wins are already banked. Surface wasm-threads for the user.
