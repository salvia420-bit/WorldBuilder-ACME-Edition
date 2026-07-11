# 1120-appendix — s12 handoff synthesis (16-agent Opus 4.8 buildbox fan-out, 2026-07-11)

Provenance: 16 parallel `claude -p` agents on buildbox @ b2fbea93 (T01-T16:
specs/audits per docs/1120.md §4), on-box synthesis, tarball sha256-verified.
Per-agent parts: /mnt/wbterminal2/holtburger-scratch/wb-handoff-s12/parts/.
Coordinator spot-verified key NEW claims: lib.rs:8880 neg-cache-disabled-in-
discovery ✓; ensureCellContainersForLandblock (index.html:3418, appendix says
3437) ✓; insert_cell_triangle append = crates/holtburger-world/src/spatial/
scene.rs:1396 ✓ (appendix abbreviates as scene.rs). B1/B2/B3/A3 were already
read-verified in-session (docs/1120.md §3). Treat remaining unspot-checked
file:line cites as hypotheses per house rule.


# WorldBuilder / holtburger — Session-12 Handoff Appendix

## Executive Summary (read first)

- Sixteen parallel agents audited the s12 cold-load / decode / harness surface. The unifying thesis, adversarially verified by **T12**: *bytes are cached, computed outputs are not* — surfaces (**B1**), heightmaps (**B3**), and indoor EnvCells (**T08**) each re-decode 2–3× cold. `MODEL_TRI_CACHE` is the lone positive compute cache.
- **T12 refuted NONE of B1/B2/B3/A3 — all four survive.** It *bounded* B1 to a hard floor of 2× (killing the naïve "8×" reading), found two paths where B1/B3 cost is slightly *worse* than stated, and flagged that the boot-stall *flake* causal claim (B2) is a runtime/ledger fact it cannot confirm from source (T04 independently sharpens this).
- **T09 refuted its own task premise:** instanced animated scenery already shipped default-ON (2026-07-02, 2× live-proven). Do **not** re-land it; its real next lever is GPU rigid-part vertex animation and the dormant `static_batch_x` cross-LB batcher.
- **Top unblocker (JS, cheap):** B2 `kickDance` is a dead URL param, but per **T04** deleting it fixes nothing at runtime — the flake fix is an **inter-arm quiet-gap** that waits out ACE's ~25 s session grace. Ship removal + quiet-gap **together**, or the first resume boots mid-grace and stalls.
- **Biggest cold-decode win:** B1 surface positive cache (`fetchSurfacesPixels` avgMs **6745** at TN). Build it **once** as a refcounted, LRU-evicted DBOCache-style cache (**T13/T14**), Arc-valued behind accessors so threads reuse it — **not** a throwaway memo.
- **Measurement is currently blind:** boot-stalls write no JSON row (**T10**), and `settleMedBySession` cannot age-match arms with different session structures (**T10** refines 1119 §2). Fix the driver before trusting any A/B.
- **netWorker promotion rests on a stale number** (**T05**): the satMed-19.2 s tail predates the s11 settle-guard and the disambiguating read has never been run. Action is *run the Tier-1 A/B*, not "write a spec" (adjusts T16).
- **Execution shape:** JS/harness + measurement fixes → **one** wasm rebuild {B1 + decode-batch-split + indoor/LOD wasm + CI canaries} → definitive cap sweep. The **2nd decode worker is demoted** (T14): its value is largely pre-captured by B1 and its duplication cost *grows* post-B1 — re-measure before building.

---

## 0. What T12 Refuted or Weakened (adversarial verification — flagged per request)

**Headline: T12 overturned nothing. B1, B2, B3, A3 are all CONFIRMED and should be treated as ground truth for s13.** What it *refuted* were counter-hypotheses (strengthening the findings); what it *weakened* were magnitude framings. Downstream specs must honor these bounds:

| Item | T12 verdict | Refuted counter-hypothesis | Weakened / bounded claim |
|---|---|---|---|
| **B1** surfaces 2–3× | **CONFIRMED** | "discovery walk is gated/cheaper" — **inverted**: `in_discovery_walk()` gates only warns/diag/neg-cache and even *disables* the neg-cache short-circuit (lib.rs:8880), so discovery does **≥** the final walk's work | "2–3×" is a **hard floor of 2×**, *not* 8×. The 8× reading (8 rounds) is wrong — early rounds short-circuit on missing records; full decode concentrates on the zero-miss terminating round + the final loop. Two paths make it *slightly worse* than PRE: neg-cache disabled in discovery; concurrent keyed-dedup still pays per-call final decode |
| **B2** kickDance dead | **CONFIRMED** | "a dynamic/arbitrary-param read revives it" — **none exists**; `bootParams` only read via named `.get()` | The boot-stall **flake** itself is a runtime claim T12 **cannot confirm from source** (only the dead-param mechanism). → **T04** supplies the real mechanism (grace collision) |
| **B3** terrain N+1 | **CONFIRMED** | "`terrainBakedLbs` dedupe makes 9 solo calls cheap" — only for **steady-state re-entry**, never the cold ring, and it **cannot** dedupe vs the collision path (disjoint sets) | The "built twice" cost is **CPU (unpack + build_mesh + subdiv), not bytes** — shards are shared; no double network. Subdiv has *no* collision twin (pure un-batched visual cost) |
| **A3** worker init cost | **CONFIRMED** | "worker is pre-warmed off critical path" — **no prewarm exists** (only unrelated `prewarmSubtree`) | Alias-split makes worker/main caches **disjoint** (different DID sets) → byte-duplication is *bounded/"less than feared"*, but the 2nd `init()` wasm-compile + manifest fetch are **not** avoidable as written |

**Cross-agent corollary (T14, not T12):** because A3's caches are disjoint and surfaces are currently *un*-cached, a future 2nd worker duplicates only shard bytes today — but **B1 makes surface outputs a new, largest duplication axis**, so the 2nd worker's cost *rises* post-B1 while its value falls.

---

## 1. Deduped, Ranked Action List

Ranked by (unblock value → cold-load ms → risk/cost). Label = BUG | TUNING | INHERENT. "WASM" items batch into one rebuild (house rule).

### A1 — Harness kickDance cleanup + inter-arm quiet-gap  · **BUG-adjacent / TUNING** · JS
**Sources:** T04 (primary), T10, T11, T12, T15, T16
**Spec:** `kickDance` is read by **zero** consumers (dead in 46 files/57 hits); its removal is a behavioral no-op. The *actual* flake fix is an inter-arm quiet-gap in `boot.mjs` (`HARNESS_INTER_ARM_GAP_MS`, default 25000 = the ACE grace `boot.mjs:56` cites): `close()` stamps `lastSessionEndAt`; `launchAndEnter` awaits the remainder before `page.goto`. Raise under-sized shell sleeps (`networker-ab.sh:20` 5 s → ~25 s). Keep `?maxRetries=1` as an **env-gated, default-OFF** fallback (`HARNESS_STALE_RECOVERY=1`) — do not re-arm the destructive self-race by default. Fix stale comments (index.html:9769 `default (3)`→`(0)`); remove the `kickDance` waiver at `lint-url-flags.mjs:44`.
**Gate:** N≥10 green `ci-smoke --full` boots; flake-rate ~6/hr → <1/hr. Ship removal + quiet-gap **atomically** (T10).

### A2 — Battery driver v2 (boot rows, land poll, quiet-gap, fixed-length sessions)  · **BUG / TUNING** · JS
**Sources:** T10 (primary), T04, T05
**Spec:** Boot-stalls currently `process.exit(2)` before the only JSON write (T10) → invisible. Add timed `kind:"boot"` rows (bootMs + outcome) every session, flush on the stall path; make summary counts kind-aware (all additive/back-compat). Land poll 250→100 ms via `--landPollMs` (halves landMs quantization bias vs 260–880 ms true land; cdp/tunnel stays round-trip-limited). Move the quiet-gap into the driver (`--quietGapMs`, RESUME-only). Add `--maxStops K` **fixed-length sessions** so `settleMedBySession[j]` is age-matched by construction (tonight cap2 fragmented n=4/26/23 vs default n=58). Optional Tier-2 `--settleMode workplateau` (= 1114 §2.5) for netWorker disambiguation.
**Gate:** back-compat contract preserved (settleGuard/sessionIdx untouched); enables the meaningful 62-POI re-read + cap sweep.

### A3 — B1 surface positive cache (refcounted DBOCache)  · **BUG** (fix is TUNING) · **WASM**
**Sources:** T01 (primary spec), T02 (alt approach), T12 (confirm), T13, T14, T15, T16
**Spec:** No positive `SurfacePixels` cache exists (only negative `MISSING_SURFACES` lib.rs:8451). Add a positive cache keyed on the **original requested DID** (lane-omitted), `Arc<SurfacePixels>`-valued behind `surface_memo_get/insert` accessors (T14 threads-seam), with **refcount-aware LRU** eviction on a **byte-budget** (≈9 B/px incl. normal+height; ~96 MiB budget + per-entry cap, T01) — and upgrade `MODEL_TRI_CACHE`'s clear-on-overflow (lib.rs:8005) to the same discipline (T13). Completeness gate = insert only on a **miss-free** decode (`DecodeAuditSource` misses==0) `&& width>0 && !magenta-sentinel` and only `!in_discovery_walk()`, mirroring the `MODEL_TRI_CACHE` poison guard (T01/T14). A per-call memo captures the discovery decode and reuses it at the final loop (removes the guaranteed +1 and the 2–8× walk re-decodes). Clear on `init_resource_source`; expose `surface_cache_hits/misses` in `dat_decode_diag()`.
**Gate:** host unit test proving byte-identical two-source decode + `audit.misses()` identical with/without cache; ci-smoke S5 `decodeMissesTotal` DROPS, `parseFail=decodeFail=0`; `?surfaceCache=off`; battery `fetchSurfacesPixels` avgMs ≪ 6745; 1070 eye-test for wrong/white textures.

### A4 — B3 terrain ring batch (`loadTerrainRing` facade)  · **BUG** · JS
**Sources:** T03 (primary spec), T07-F5, T12, T13, T16
**Spec:** `world_stream.js:135-142` fires 9 solo `loadTerrainForLandblock` → 9 single-elem `fetch_landblock_heightmaps` + 9 solo subdiv, while the collision path already batches the same 9 (index.html:3638) and a batched `bakeTerrainRing` sits **dead**. **Do not revive `bakeTerrainRing` wholesale** (it lacks the guard/LRU/warm-park the solo path grew — see Conflict C2). Add a new facade `loadTerrainRing(ringLbs)` fed by a collect-then-handoff edit in world_stream; factor only the **fetch half** (`fetchTerrainRingMeshes`) and fan out per-LB through the existing `_guardedStreamBake` + `landblockLru.track` + warm-park path. **Must-fix (F1):** batched `fetch_landblock_heightmaps` is all-or-nothing (lib.rs:1406 `?`) — wrap in try/catch → fall back to 9 solo so one bad shard can't blank the ring. Ownership: free base always; free subdiv only for guard-skipped LBs (`ran[]` flag). This also subsumes T07-F5 (within-bake heightmap∥subdiv serialization).
**Gate:** `?terrainRingBatch=off`; **`test_a15_q4_renderer_neutral_core.mjs` REQUIRES UPDATE** (assert 1 ring call not 9, + a flag-off arm re-proving 9-solo); evict/warmpark/sealed suites stay green; new `test_terrain_ring_batch.mjs`; ci-smoke S3 no white terrain.

### A5 — Indoor EnvCell double-decode + Environment re-parse  · **BUG** · JS gate (now) + **WASM** (memo)
**Sources:** T08 (primary; NEW — unrecorded in ledgers)
**Spec:** `fetchEnvCellsInLandblock` runs **twice** per cold indoor LB — `ensureCellContainersForLandblock` (index.html:3437) and `buildEnvCellsForLandblock` (cells.js:455) use independent dedup namespaces; in 3D mode the first is pure waste (discards placements at the `!app` gate). **JS fix (S13):** gate `ensureCellContainers` on `renderer==2d` (or unify the sets) — halves indoor cold decode. **WASM fix (S14):** (i) the double-fetch **doubles `cell_physics_index`** because `insert_cell_triangle` *appends* (scene.rs:1396) while all sibling inserts are idempotent — inflates every per-tick `scene.clone()`; (ii) per-cell `Environment::unpack` re-parse (lib.rs:16806, self-documented waste) → extend `env_mesh_cache` to memoize the parsed Environment. No indoor B3 (fetch layer already batches — REFUTE). Explains indoor 25 s = settle CAP, not a settle.
**Gate:** probe log at index.html:3437 (expect 2 cold); `cell_triangles` total = 1× not 2×; A/B disable-ensureCellContainers-in-3d settle delta; ci-smoke indoor POI 0 errors.

### A6 — Bake-worker prewarm (A3)  · **TUNING** · JS (~15 lines)
**Sources:** T06 (primary), T12, T14, T16
**Spec:** Worker lazy-spawns on first bake; its `init` does wasm-compile + re-fetch/sha256 of `boot.hba` (**~1.9 MB**, not just the 543 B manifest) on the player-blocking critical path. Fire a guarded fire-and-forget `getBakeWorkerClient()._ensureWorker()` right after `configureBakeWorker` (index.html:2235). **Mandatory `active` gate** (`_ensureWorker` does *not* self-check `active` → would spawn under `?bakeWorker=0`); idempotent `_ensureWorker` + `_failAll` reset already guarantee fail-soft (just swallow the rejection). Do **not** dedup via postMessage (parsed manifest lives in wasm linear memory; needs a new export + 1.9 MB copy to replace a warm cache hit — negative ROI). Placement per T06, not T12's post-idle framing (Conflict C6).
**Gate:** `?bakeWorkerPrewarm=off`; ci-smoke `bakeWorkerStats().byType.init.count===1`; `?bakeWorker=0` spawns no worker; forced-init-failure → no unhandled reject + bake still renders; **N-boot settle/renderer-death regression on the 2-core box** (worker compile now earlier — watch A1 bake starvation; fallback = defer behind rIC).

### A7 — JS cold-path serialization: statics/buildings/spawns  · **BUG (F1) / TUNING (F2,F4)** · JS
**Sources:** T07 (primary; NEW)
**Spec:** **F1 (BUG):** `fetch_landblock_objects` runs in full **twice** per cold LB (buildings.js:693 + statics.js:1766, separate dedup sets), each discarding the other's half; wasm re-does `LandblockInfo::unpack` + `SetupModel::unpack` setup-resolution on the urgent lane. Fix: shared per-cellId drained-placement cache, filter twice. **F2 (TUNING, top cold-ms):** statics `fetchDegradedGeometries` (statics.js:1927) and `materialCache.preload` (1938) depend only on `primary`, not each other → `Promise.all` to hide the LOD-mesh batch under the surface decode. **F4:** spawns first-LB `loadWcidToSetupMap` before `fetch_landblock_spawns` are independent → `Promise.all`. Investigate (do NOT do blind): objects→scenery overlap needs wasm-reentrancy verification.
**Gate:** ci-smoke + cold-LB walk capture; F1/F2 land together (same statics/buildings path); owed per-LB cold-bake trace to quantify before ordering vs the ~15 s residual.

### A8 — netWorker promotion: run Tier-1 A/B + invert off-escape  · **BUG-blocker + TUNING** · JS (spec-gated)
**Sources:** T05 (primary), T11, T16
**Spec:** The block rests on a **stale number** (satMed 19.2 s predates the s11 guard; the disambiguating read has never run). Tooling exists (`networker-ab.mjs`, s11-guarded battery). **Action = run it**, not write a spec (adjusts T16): run the guarded 62-POI battery as netWorker=0/1, compare the existing **`workDelta` median** — equal workDelta + longer settleMs ⇒ scene-count-churn artifact ⇒ PROMOTE. **BUG-blocker:** `netWorkerEnabled()` (net_worker_client.js:62) has no off-escape — invert to `v!=="0"&&v!=="off"&&v!=="false"` before flipping default. Expectation-setter: netWorker is resilience+throughput (session survives freeze), **not** a fix for the ~15 s cold first-hop (recv_loop/dispatch/bake stay main-thread).
**Gate:** Tier-1 workDelta read + `networker-ab.mjs` (N≥8, freeze-survival, movement in noise, 0 net-new errors); add `?netWorker=1` boot-parity + `?netWorker=off` fallback legs to ci-smoke; complete owed functional parity (chat/useObject/inventory/trade). One-line JS rollback.

### A9 — Login-defer revisit (land dormant, netWorker-gated)  · **TUNING** · JS
**Sources:** T11 (primary), T05
**Spec:** The 20 s idle-defer (index.html:9793) exists only because direct-path `send_login_request` is main-thread-starved. Under `?netWorker=1` login runs in the worker → Connect can fire at ~2 s idle (`short`). Gate the trigger on `netWorkerEnabled()`; add `?loginDefer=short|formshown|idle20|<ms>`. **Bare default (netWorker OFF) unchanged** → ships **dormant**, auto-activates when A8 promotes. Keep `spawnTimeoutMs=20000` (spawn/PVS burst is main-thread, unaffected). A/B login-defer × netWorker as a **2×2** (T05) — each masks the other otherwise.
**Gate:** new ci-smoke leg `?netWorker=1&loginDefer=idle20` vs `…=short`, N≥5, candidate `inWorldMs`≤control, `t_charlist` not regressed, **assert absence of** `"recv loop exited before CharacterList"`.

### A10 — CI gates: 4 fail-loud tripwires  · **BUG-catchers** · G1/G4 JS (now), G2/G3 **WASM**
**Sources:** T15 (primary), T04, T12
**Spec:** **G1 (JS now):** `lint-harness-params.mjs` sweeps emitted URL keys vs the app reader-set, FAILs on any unconsumed (would have caught `kickDance`); delete the launder-ing waiver at lint-url-flags.mjs:44. **G2 (WASM):** decode-once canary — add `surface_decode_total`/`surface_decode_dids` to `DecodeDiag`, bump in the `Ok(pixels)` arm **unconditionally** (counts walk waste), S5b `decodeAmp = total/distinct` FAIL >1.15 (today ~2–3×). **G3 (WASM):** batch-shape canary — thread-local `HM_BATCH_HIST` at `fetch_landblock_heightmaps` entry, FAIL if `hist[1]/total>0.25` (catches the 9-solo storm). **G4 (JS now):** return `inWorldMs` from `launchAndEnter`, emit `boot=PASS(${ms}ms)` with `CI_BOOT_BUDGET_MS` WARN.
**Gate:** G1/G4 ship this session; G2/G3 auto-SKIP on legacy pkg (mirror ci-smoke.sh:82) until the wasm rebuild.

### A11 — Decode batch-splitting (owed since 1117 §4)  · **TUNING** · **WASM**
**Sources:** T14, T16
**Spec:** Pipeline the fetch-surfaces batch so first pixels land sooner (latency-to-first-render), orthogonal to B1's work-dedup. wasm signature change → co-lands in the B1 rebuild.
**Gate:** `?batchSplit=off`; Rust split-boundary test; S5 `decodeFail=0` + urgent preempt.

### A12 — Per-entity LOD degrade batch export (F3)  · **TUNING** · **WASM ABI**
**Sources:** T07
**Spec:** `_spawnImpl` does a per-entity `await fetch_entity_degrade_for_distance` (entities.js:3146) escaping the F.40/F.41 spawns batch (camera-only → visual-mode). Add `fetch_entity_degrade_for_distance_batch((setupId,distance)[])`; pre-warm in spawns.js. Ranks below F1/F2 (warm-fast).
**Gate:** rides the wasm session; battery visual-mode spawn trace.

### A13 — Scenery follow-ons  · **TUNING** · JS/GLSL
**Sources:** T09 (premise-refuting)
**Spec:** (a) The advisory freeze-hash sidecar adds a **blocking extra HTTP GET per cold LB** on the player-blocking path (lib.rs:2714) — gate behind a debug flag or fire-and-forget. (b) Real next anim-scenery lever = **GPU rigid-part vertex animation** (`?animSceneryGpu`, default-OFF) — upload `nodeMat` once as instance attr, drive `partMat[]` as per-DID uniforms; reuse the `treeWindGpu` MECH-B precedent; kills per-frame CPU pose-write. (c) **Higher ROI:** the draw wall is ~3,008 per-LB static `BatchedMesh` nodes — the cross-LB batcher `static_batch_x.js` is **built but dormant**; land + 1070-validate it. Note the dead wasm ring-batch (`join_all`) never fires in steady state — don't tune it.
**Gate:** `?animSceneryInstanced=on/off` perf A/B leg added to `battery-telepoi.mjs` to regression-lock the shipped 2×; GPU/batcher work needs real-GPU eye-test (SwiftShader can't adjudicate BatchedMesh GLSL).

### A14 — Threads endgame reorder (planning)  · **INHERENT** · planning
**Sources:** T14 (primary), T12
**Spec:** Updated lever order: **(1) B1 surface memo** (was unlisted in 1118 §5 — recovers 2–3× within-instance, no new worker/RAM), **(2) batch-split**, **(3) 2nd decode worker DEMOTED + gated on post-B1 re-measure** (value pre-captured by B1; duplication *grows* post-B1), **(4) threads (SAB)** unchanged — the only lever that fixes A1 main-thread starvation and eliminates per-instance manifest/shard duplication (multi-week XL: `inflight.rs`/`walk_dedup.rs` `unsafe Send/Sync` + `TEX_SWAP_ALIASES` shared-id redesign; still HELD behind netWorker). Convert B1 + `MODEL_TRI_CACHE` to shared `Arc<RwLock<…>>` containers together in the threads session.
**Gate:** planning artifact; re-measure decode-boundness after B1 before building the 2nd worker.

### A15 — Residency roadmap: fixed-slot grid + park time-retention (planning)  · **TUNING** · planning + JS
**Sources:** T13 (primary)
**Spec:** Retail reuses across an adjacent walk via (L1) pointer-shifted `land_blocks[mid_width²]` grid, (L2) LOD/seam-gated geometry keep, (L3) refcounted 30 s DBOCache freelist. B1's cache is the L3-surface slice. Next: **fixed-slot grid** (`?fixedGrid`, L port, design-doc now / build later) retires the whole B3 class — the A4 ring-batch is its cheap 80% on-ramp. **Park→DBOCache time-retention** (30 s `UseTime` floor, generalize sealedKeepRing) — but slot it **after** B1 (parking containers still cold-re-decodes source until the resource cache exists).
**Gate:** owed full 62-POI re-read under B1: park/unpark stays 18/0·6/0·0/0, reclaimMed ≤~300, cold first-hop drops; new `surface_cache_hits/misses` counters, hit-rate >60%.

---

## 2. Inter-Agent Conflicts & Resolutions

**C1 — B1 fix shape: positive cache (T01/T13/T14) vs discovery decode-skip (T02).**
T02 proposes skipping the heavy decode entirely during discovery (the `fetch_dye_preview_pixels` forced-`Err` idiom). T01/T13/T14 propose memoizing successful decodes. **Resolution: adopt the positive refcounted cache as primary** (A3) — it eliminates the discovery re-decodes *and* the final decode *and* cross-LB/cross-call re-decodes, and it is the residency-aligned DBOCache design T13/T14 both endorse; T01's per-call memo already captures the completed discovery decode and reuses it at final, so T02's forced-`Err` idiom is redundant for the *complete* case. **Keep T02's decode-skip as a secondary lever** only for surfaces whose discovery rounds never reach a miss-free decode (where a full decode is pure waste) — apply behind the same `in_discovery_walk()` gate if a post-B1 trace shows residual discovery-decode cost. Do **not** ship T01 as a throwaway memo then redo it as a cache (T13/T14 warning) — build the cache once.

**C2 — B3: adopt `bakeTerrainRing` wholesale (T13, T16) vs new `loadTerrainRing` facade (T03).**
T13/T16 say "route world_stream through the already-written `bakeTerrainRing`." **T03 is correct and wins:** it read the machinery `bakeTerrainRing` *lacks* (`_guardedStreamBake`, `landblockLru.track`, warm-park unpark) and shows a wholesale revival **regresses evict/guard/warmpark/sealed**. Adopt T03's Design B (new facade reusing only the fetch half + existing guard/LRU/warm-park), including the all-or-nothing fallback must-fix and the `test_a15_q4` update. T16/T13 are right about *effort class* (JS-only, this session) but wrong about *mechanism*.

**C3 — netWorker: spec-gated (T16, T11) vs stale-number/run-the-experiment (T05).**
**T05 wins on actionability:** the hold is a measurement that was never taken, not an unwritten definition. The S13 deliverable is *run the Tier-1 netWorker A/B and read `workDelta`* (+ the off-escape inversion), not "write the settle-criterion spec." T16's "spec" collapses into T05's Tier-1 experiment; T11's 2×2 with login-defer rides the same campaign.

**C4 — A3 prewarm placement: inline at :2235 (T06) vs post-idle alongside login (T12).**
**T06 wins** (more detailed): the win is finishing the worker's compile+verify *concurrently with the rest of boot's I/O*, not "during the login idle window." Keep T12's post-idle defer only as T06's own documented fallback knob if the N-boot regression shows worsened bake starvation on 2 cores.

**C5 — `settleMedBySession` auto-age-matches arms (1119 §2) vs it cannot (T10).**
Agent-vs-ledger, not agent-vs-agent. **T10 refines correctly:** tonight's n=4/26/23 vs n=58 proves `settleMedBySession` *segments* but cannot *align* arms with different session structures. **Fixed-length sessions (A2, `--maxStops`) are the actual fix** and a prerequisite for a trustworthy cap sweep.

**C6 — T09 task-premise refutation (not a between-agent conflict, surfaced for visibility).**
T09's brief ("land instanced anim-scenery, 2× proven 07-02") describes **already-shipped, default-ON** work. No action to "land"; pivot to A13. Flagged so no session re-does completed work.

**No other contradictions.** T12 could not break any core finding; T13/T14 add refinements (MODEL_TRI_CACHE is a *degenerate* DBOCache — upgrade its eviction, don't sit beside it) rather than conflicts.

---

## 3. Merged Session 13→15 Execution Order (T16, adjusted by all agents)

**Wasm-batching rule** partitions everything: the **single wasm rebuild** = {A3 B1 cache, A5-wasm Environment memo + physics-idempotency, A11 batch-split, A12 LOD batch export, A10 G2/G3 canaries, A13a freeze-hash gate}. Everything else is JS/harness and ships any time.

### Session 13 — JS/harness + clean baseline (NO rebuild)
Front-load the measurement-unblockers so every later number is trustworthy.
1. **A1 kickDance removal + inter-arm quiet-gap** — *first; unblocks all measurement.* (T04/T10/T16) Ship the two atomically.
2. **A2 battery driver v2** — boot rows, `--landPollMs`, `--quietGapMs`, `--maxStops` fixed-length sessions. (T10) Makes flakes visible + de-confounds the coming cap sweep.
3. **A4 B3 terrain ring batch** via the T03 `loadTerrainRing` facade (not a `bakeTerrainRing` revival). (T03/T16)
4. **A5 (JS half)** gate `ensureCellContainers` on `renderer==2d` — halves indoor cold decode. (T08)
5. **A6 bake-worker prewarm** (JS, ~15 lines, fail-soft). (T06)
6. **A7 F1/F2/F4** statics/buildings/spawns Promise.all + shared placement cache. (T07)
7. **A8 netWorker** — invert the off-escape + **run the Tier-1 A/B** (replaces T16's "write a spec"). (T05)
8. **A9 login-defer** — land **dormant** behind `netWorkerEnabled()`; auto-activates on promotion. (T11)
9. **A10 G1 + G4** CI gates (harness-param lint + boot-time budget) — pure JS/bash. (T15)
10. **A15 (design-doc)** fixed-slot grid; note park-retention deferred until B1. (T13)
11. **Clean 62-POI battery RE-READ** on the now-reliable harness → confirm sealedKeepRing, bank the **pre-wasm baseline**. **Defer the bakeQueueCap sweep to S15.**

### Session 14 — ONE wasm rebuild (batch all wasm-touchers)
1. **A3 B1 surface cache** — land/validate **first** (most isolated); built as the refcounted DBOCache (Arc + accessors, LRU, MODEL_TRI_CACHE eviction upgrade). (T01/T13/T14)
2. **A5 (wasm half)** Environment re-parse memo + `insert_cell_triangle` idempotency (kill doubled `cell_physics_index`). (T08)
3. **A11 decode batch-splitting** (owed since 1117 §4). (T14/T16)
4. **A12 per-entity LOD batch export**. (T07-F3)
5. **A10 G2/G3** decode-once + batch-shape canaries. (T15)
6. **A13a** freeze-hash sidecar gating. (T09)
7. **Post-rebuild 62-POI re-read** vs the S13 baseline → quantify the surface-cache win.
> **Adjustment vs T16:** the 2nd decode worker does **NOT** co-land here. Per T14 it is demoted and gated on the post-B1 re-measure — build it in S15 only if the pipe is still decode-bound.

### Session 15 — Definitive campaign + validation
1. **bakeQueueCap SWEEP** (cap2/default/cap8) — now meaningful (per-bake cost from B1 + per-ring cost from B3 both settled + fixed-length age-matched arms). De-confound the cap2 renderer-death signal: interleaved randomized arms, matched session age, one battery at a time.
2. **2nd decode worker** — build **only if** the post-B1 battery still shows a decode-bound cold pipe (A14 gate).
3. **netWorker=1 promotion decision** (from the S13 A/B) + login-defer 2×2 confirmation.
4. **A15** fixed-slot grid build (`?fixedGrid`) + park→DBOCache time-retention.
5. **A13b/c** GPU rigid-part anim + revive `static_batch_x` — dedicated **1070 eye-tests** (surface-cache visual sign-off + the batched visual-suite backlog).

**Invariants across all sessions:** every new flag ships validated → default-ON + `?flag=off`, registered in `url-flags.md` or L1 lint fails; keep the coordinator's 8/8 unit suites green; bar = bare-default boot+spawn+0 console errors.

**Top risks (merged):** (1) wasm single-rebuild bottleneck → per-flag escapes so any one item disables without a re-rebuild; (2) surface-cache wrong/white textures → S3 + 1070 eye-test + exact `(surfaceDid,PFID)` keying; (3) cap sweep stays confounded → fixed-length + interleaved arms; (4) B2 "fixed" but the stall is deeper (ACE ghost-session) → gate on measured flake-rate, not the diff; (5) 2nd worker built before the B1 re-measure proves it's needed.
