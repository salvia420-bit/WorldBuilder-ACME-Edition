# Pass 06 — Residency architecture: slot grid, refcounted Rust caches, park/evict, wasm topology, memory census

Pass 6 of 12. Governed by `TRACKING.md`'s protocol header. W2 core (charter D-01.7/I4:
"fixed player-centered slot grid + refcounted Rust resource caches with UseTime floors;
edge-only churn; the governor-drains-its-own-pool failure becomes structurally impossible,
not tuned away"). This pass fixes: the slot-grid geometry and shift semantics (reconciled
with pass 2's 2×2 tiles), the per-slot state machine, the retention-tier definitions that
give C3/C5 their meaning, the Rust cache inventory with keys/budgets/UseTime floors, the
pressure/degradation ladder (with floor-under-breach semantics spec'd explicitly), the
single-vs-dual wasm instance decision with per-instance ownership, and the memory-census
schema that makes all of it observable. Source classes per R7: **[M]** measured (doc
named), **[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

**A factual correction to the record, established by read-verification this session
(R4):** the 07-11 slot-grid plan was NOT "designed but never built" (survey §4 I4's
wording, repeated in this pass's briefing). Its S15b/S15c slices are live and default-ON
since the 2026-07-11 S16 flip with a 1070 sign-off: `scene3d/fixed_grid.js` implements a
player-centered shift-in-place `FixedSlotGrid` (fixed_grid.js:140–368) plus a
hysteresis-gated `EdgeParkScheduler` (fixed_grid.js:504–606) — but scoped to the TERRAIN
near-ring only, at radius 1 (`FIXED_GRID_TERRAIN_RADIUS = 1`, fixed_grid.js:55; W = 3×3),
wired as a fetch-driver in front of the same reactive LRU stack (url-flags.md:505–507).
What was never built is the plan's end state: the grid as the residency AUTHORITY for all
layers at the full ring, with the refcounted resource cache behind it. This pass specs
that end state, adopting the built artifact's proven mechanics (shift cross-check,
derived-view assert, park hysteresis, teleport-invalidate) rather than starting over.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; M-series,
  D-01.7 I4, H5).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; D-02.1 tiles,
  D-02.4 tiering, S1 byte stats, H-02.4).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; D-03.3 fetch
  authority + PackStore contract, D-03.8 lookahead, S7 quarantine, H-03.3, Q5).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; D-04.5 one-copy exit,
  D-04.8 substitution residue, H-04.2, S6.4).
- `docs/reengineering/pass-05-texture-spec.md` — lines 1–768 (all; D-05.7 mirror policy,
  D-05.8 demote-before-dispose, H-05.1).
- `docs/PLAN-fixed-slot-grid-residency-2026-07-11.md` (holtburger root docs/) — lines
  1–81 (all): L1/L2/L3 retail table (15–17), `?fixedGrid` design (26–49), landing order
  (75–81).
- `docs/2026-07-01-perf-rust-memo-and-residency-handoff.md` — lines 1–33 (all): root
  cause ("RE-DECODES per landblock and BULK-EVICTS", line 4), DBOCache/LScape anchors
  (28), slot-grid item (22).
- `docs/2026-08-06-p99-stall-attribution.md` — lines 1–431 (all): cause #3 governor
  pathology (134–170), fix sketch (401–406).
- `docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md` — §8–§12 (lines
  316–740): six-town census table (323–331), shard verdict + convergence (333–355), JS
  heap 753→2,508 MB (361), net-worker unsummed note (396–400), 1,332 MB live mirrors
  (§9), `statAtlasGrow` results (§12).
- `scene3d/landblock_lru.js` — lines 1–499, 1040–1499, 1959–2078 plus anchor greps:
  count-cap note "~203 … effectively never fires" (263–264), `MAX_LIVE_GEOM` 8000 on
  `renderer.info.memory.geometries` (266–289), park-storm bounds (296–351),
  `PARK_DISPOSE_BUDGET_MS` 6 (356–363), `PARK_USE_TIME_MS` 30,000 (382–396),
  warm-park default + 160 MB pool (237–257), sealedPark pin design (91–215),
  `tickEviction` (1040–1330), **`floorMs = overGeomAtEntry ? 0 : PARK_USE_TIME_MS`**
  (1373–1374), all-young fast path (1404–1447), `park()` per-layer detach (1959–2078).
- `scene3d/index.js` — lines 5920–6000 (lbCap formula: span 13 ⇒ 169+26+8 = **203**,
  5942–5943; LRU construction 5978–5989), 2356–2390 (`tickEviction` called from the rAF
  tick, 2373).
- `scene3d/residency.js` — lines 1–211 (all): `RESIDENCY_RADIUS_LB = 5` (51),
  `PVS_RING_RADIUS` default 5 = 11×11 (186–187), `LRU_SIZING_RADIUS` 6 (206–210),
  reaper +3 ⇒ 8 (61–79).
- `scene3d/cells.js` — lines 2739–2830: `tickPvsLoadExpansion` ring from
  `scene3d.pvsRingRadius` (2745–2751), indoor collapse (2752–2776), per-packet ring
  double-loop (2818–2819).
- `scene3d/fixed_grid.js` — lines 1–606 (all): radius-1 terrain scope (48–55),
  shift/teleport/seed (296–368), teleport predicate |d| ≥ W (339), shift cross-check +
  slot-desync detectors (271–288, 394–474), `EdgeParkScheduler` hysteresis 2,000 ms
  (504–606).
- `docs/url-flags.md` — lines 505–507: `fixedGrid`/`fixedGridPark`/`fixedGridSealedFreeze`
  default-ON rows, S16 flip evidence, 1070 sign-off.
- `apps/holtburger-web/src/lib.rs` (the wasm crate — NOT `crates/holtburger-web/`):
  3250–3320 (scenery cache: unbounded per-LB HashMap, `cache_bytes` 3278–3289),
  3595–3700 (SUITE_CACHE + SUITE_CACHE_BY_KEY: unbounded HashMaps), 3798–3810
  (ANIM_CACHE u32→u32, unbounded), 8995–9060 (`MODEL_TRI_CACHE` 64 MiB / entry cap
  8 MiB, 9001–9003), 10095–10100 (`MISSING_SURFACES` HashSet), 10285–10475
  (`ByteBudgetLru`: refcount-aware evict, "no evictable victim → run over" 10385–10402;
  `SURFACE_CACHE_BUDGET_BYTES` 96 MiB / 16 MiB entry cap, 10473–10475; advisory-budget
  note 10492–10496), 10531–10607 (SurfaceCacheKey enum, shared store), 11374–11593
  (census: `MemStoreRow.budget: Option<usize>` rendered −1 (11400–11457),
  `hb_mem_census` row inventory (11469–11593), two-instance relay note (11459–11463)).
- `crates/holtburger-resource-http/src/shard_cache.rs` — lines 1–399 (all): 58+21 MB
  two-instance ratchet (8–11), eviction soundness (20–53), round protection (57–69,
  143–207), `usize::MAX` default (81–83).
- `crates/holtburger-resource-http/src/manifest_source.rs` — lines 123–145
  (`configured_shard_budget_bytes` → `usize::MAX` when unset; per-instance).

## Decisions

### D-06.1 — Grid geometry: TILE-granular slots, W_T = R+1 = 6, ring-min anchor, shift-in-place

The residency grid is **tile-granular** (pass 2's 2×2-LB tiles are the fetch, park, and
release unit — adopting pass 2 H-02.4's proposed default) and player-centered by
**ring-min anchor**:

- Ring radius stays `RESIDENCY_RADIUS_LB = 5` LBs (residency.js:51) — an 11×11-LB
  horizon, unchanged player-visible behavior.
- Tile coordinate `t(x) = floor(x/2)`. The grid anchor is
  `A = (t(lb_x − R), t(lb_y − R))`; the grid is the `W_T × W_T` tile block from A, with
  **W_T = R + 1 = 6** (36 slots = 144 LBs of tile-aligned coverage).
- **Cover proof [D]:** the ring spans `[lb−R, lb+R]` = 2R+1 = 11 LBs; both endpoints have
  equal parity (their difference 2R is even), so `t(lb+R) − t(lb−R) = R` for either
  parity ⇒ exactly R+1 = 6 tiles per axis cover the ring, always. This is the same 36
  ring tile packs pass 2 S6.1 budgets for boot — the grid IS that set, held as slots.
- **Allocated vs used (wall discipline):** 36 tiles = 144 LBs allocated coverage vs
  121 LBs used by the ring — 19% alignment slack, bounded by construction, and free in
  bytes because fetch granularity is the whole tile pack regardless (pass 2 D-02.1).
  Every count below states tile vs LB scale.
- **Shift:** the anchor moves ±1 per axis exactly when `lb − R` crosses a tile boundary —
  once per 2 LBs of net movement. A shift admits one row/column of ≤6 tiles and vacates
  the opposite row/column of ≤6 tiles; the 24 interior slots (of 36) are pointer-copied,
  untouched — retail `LScape::update_block` semantics (plan §1 L1) at tile scale.
  Per-LB-column churn = 6 tiles / 2 columns = **3 tile packs per LB column — identical
  to pass 2's crossing arithmetic and pass 3 S8.2's C1 count** (no restatement needed).
- **Multi-step shift:** anchor delta 1..W_T−1 on an axis = a normal shift admitting that
  many columns (bounded work, amortized per D-06.6). Anchor delta ≥ W_T on either axis =
  **teleport**: no overlap, whole-grid invalidate (D-06.10) — the same predicate the
  built grid uses (`|dx| ≥ width`, fixed_grid.js:339).
- **Oscillation:** the anchor function quantizes movement to 2-LB steps, and a re-admitted
  tile that is still PARKED or pack-resident re-adopts by pointer (D-06.3) — plus the
  vacate side is hysteresis-gated (2 s, D-06.3) and floor-protected (30 s, D-06.5). Four
  independent layers make the zig-zag storm class (the s11 park↔unpark storm,
  landblock_lru.js:54–78) structurally cheap rather than specially-cased.
- **Interiors:** a tile slot owns its LBs' interior packs too (fetched lane R at
  admission, promoted lane U on entry — pass 3 S4). Interior residency state hangs off
  the owning slot; the sealed-dungeon special case is D-06.10.

*Rationale.* Tile granularity is forced by the fetch unit (fetching a tile pack and
holding residency per-LB would reintroduce partial-unit bookkeeping for zero byte
savings); W_T = 6 is the minimal tile cover of the settled 11×11 ring; ring-min
anchoring makes the shift trigger a pure function of position with built-in 2-LB
hysteresis. *Rejected:* LB-granular slots (4× slot churn bookkeeping; fights the pack
unit; pass 2 H-02.4 already proposed tiles); odd-width tile grid W_T = 7 centered on the
player's tile (49 tiles = 196 LBs — 27% more coverage than needed, and "centered" is
ill-defined on an even tile lattice); keeping the ring recomputed per position packet
(today's `tickPvsLoadExpansion` shape, cells.js:2818 — the reactive model I4 kills).

### D-06.2 — The grid lives in JS as the SOLE positional authority; Rust holds the bytes, JS holds the policy

One module — `scene3d/residency_grid.js`, generalizing the proven `FixedSlotGrid` core
(pure, injected-deps, unit-testable headless; adopt its shift cross-check and
slot-desync detectors verbatim, fixed_grid.js:271–288/394–474) — owns the WHAT of
residency. Every other component is a subscriber that owns a HOW:

| subscriber | reacts to grid events by |
|---|---|
| `PackFetchController` (pass 3) | enqueueing admitted tiles (lane R) + the 1-tile directional lookahead (D-03.8); dequeuing tiles that left before fetch |
| Rust `PackStore` (D-06.5) | `pack_pin(tile)` / `pack_unpin(tile)` — pin-counted residency of tile + REFS-listed shared packs |
| bake scheduler (pass 8) | bundle assembly jobs for admitted tiles |
| scene/pools (pass 7) | absorb on LIVE, deactivate on PARKED, release on RELEASED |
| texture tiers (pass 5) | full-tier fetch for LIVE tiles; demote/dispose per D-06.6 |

*Rationale.* The 07-11 plan's own scoping ("grid is a JS residency driver; no wasm ABI
change beyond batched calls", plan §3) proved out in the built S15b artifact; every
subscriber except PackStore is JS-side; and PackStore's mutations are already
JS-invoked (pass 3 S1.3 `insert_pack`). The MEMORY-rule "system caches belong in Rust"
is honored where it applies — the CACHES are Rust (D-06.5); the ~36-slot policy driver
is not a cache. *Rejected:* grid in Rust (every event crosses the boundary outward to
JS subscribers; the built JS grid already carries the hard-won correctness detectors);
two grids (terrain near-ring + residency ring) — the S15b radius-1 terrain grid is
SUBSUMED: its 3×3 fetch role becomes a derived view of the new grid's inner ring, and
`fixed_grid.js`'s driver wiring retires with it (pass 9 stages; deletion ledger S6).

### D-06.3 — Per-slot state machine (states, transitions, triggers)

Normative table in S2. Headlines:

- Six states: `EMPTY → FETCHING → STAGED → LIVE ⇄ PARKED → EMPTY`, plus `QUARANTINED`
  (fetch failure, mirrors pass 3 S7 — the controller's quarantine bookkeeping is the
  authority and is NEVER erased by residency transitions, honoring H-03.3).
- **Park is hysteresis-gated** (2,000 ms continuous-vacated dwell before detach — adopt
  `EdgeParkScheduler` semantics and its re-entry cancel, fixed_grid.js:516–561): a
  zig-zag never issues a park.
- **PARKED → LIVE is a pointer re-adopt**: re-attach containers / re-activate pool
  ranges; zero fetch, zero decode, zero upload. This is the retail freelist behavior the
  UseTime floor exists to protect.
- **PARKED → EMPTY (true release)** happens only via the pressure pass (D-06.6), the
  teleport drain (D-06.10), or session teardown — always amortized (≤1 tile
  true-release per tick under a 6 ms budget, adopting `PARK_DISPOSE_BUDGET_MS`'s
  measured discipline, landblock_lru.js:356–363), NEVER as an unbounded bulk evict
  (walls: bulk-evict GC spikes are the jank root cause).
- Rust-side release is `pack_unpin` at PARKED→EMPTY (not at LIVE→PARKED): a parked
  slot's pack bytes stay pin-free-but-resident under the PackStore's own UseTime floor
  (D-06.5), so even after a JS-side release, a fast return is T2 (re-bake without
  network) rather than T3.

### D-06.4 — Retention tiers: what "resident / parked / evicted" MEAN (C-series semantics)

| tier | where the content is | re-entry cost | bounded by |
|---|---|---|---|
| **T0 LIVE** | in-grid: scene-attached, pools active, full or preview textures | none (drawn) | grid size (36 tiles) + per-class VRAM budgets (pass 5 D-05.8) |
| **T1 PARKED** | out-of-grid, warm: containers detached / pool ranges deactivated, GPU buffers + heap retained | re-attach (pointer re-adopt) | park pool: ≤40 tiles AND ≤128 MiB [A], 30 s UseTime floor |
| **T2 PACK-RESIDENT** | Rust PackStore holds the verified pack bytes (unpinned, within budget + floor) | re-bake: decode-from-resident-bytes + upload; **zero network** | PackStore 96 MiB budget [A] |
| **T3 CACHED** | HTTP cache / SW CAS cache only (immutable, pass 3 D-03.6/D-03.9) | cache-hit fetch + verify + bake; **zero network bytes** (disk) | browser cache quota |
| **T4 COLD** | server only | full fetch | — |

**C3 ("crossing into cached territory = 0 network") binds at T3 or better**: content
addressing + immutable headers make the re-fetch a disk hit. **C5's no-stall-while-
walking binds at T2 or better for the trailing edge** — the floor windows are sized so a
reversal within ~30 s never touches the wire or the decoder. M2 (heap growth ≤150 MB
after 3rd town) is delivered by T0+T1 being position-bounded and T2 being byte-bounded —
heap is O(resident set) by construction, not O(route).

### D-06.5 — Rust cache architecture: one refcount discipline, every payload store budgeted, floors never zeroed

**The stores, post-migration (normative budget table in S3).** All byte-budget stores
use the existing refcount-aware LRU shape (`ByteBudgetLru`, lib.rs:10285–10467, or
`ShardCache`'s round-protected variant, shard_cache.rs) with its settled stance: **no
evictable victim ⇒ run over budget and record, never break a holder**
(lib.rs:10385–10402; shard_cache.rs:57–69). That stance IS the UseTime-floor semantics
generalized, and it is the anti-pathology rule: budgets are targets enforced against
eviction-eligible entries only; deferrals are counted, not forced.

1. **`PackStore` (NEW — answers "what does Rust still hold" after pass 3 moved fetch to
   JS).** Main-instance store of verified pack bytes. Key: pack `hash16`. Value:
   `Arc<[u8]>` + pin count + `last_unpin_tick`. Pinning: each grid slot pins its tile
   pack, its interior packs, and every REFS-listed shared pack (META/ENV/PVW regional);
   CORE + META-COMMONS + ENV-COMMONS + PVW-COMMONS carry a session pin. Eviction:
   unpinned entries only, LRU by last-unpin, **30 s UseTime floor from unpin**
   (retail DBOCache `GetIfUsing` shape, plan §1 L3), budget **96 MiB [A]**. Sizing
   sanity [D from pass 2/4 [M] stats]: pinned working set = 36 tile packs (p50 4 KB /
   p99 ~820 KB with GEOM) + commons ≈2.1 MB + regionals ≈1 MB + ENV ≈1.2 MB + capped
   PVW ring class ≈3–10 MB + interiors ⇒ ~15–45 MB pinned; 96 MiB leaves roughly one
   grid's worth of T2 warm headroom behind the floor.
   **PVW pin rule (pass 5 H-05.1's "permanently ring-resident" made precise):** a PVW
   pack is pinned while ANY slot in its supergrid region is LIVE or PARKED — which is
   exactly the population whose materials can demote to it. Demote-to-preview therefore
   always finds its bytes resident and synchronous; no cross-boundary refcount needed.
2. **`PackSections`** — decompressed-section cache (pass 3 S1.3's "lazily decompressed,
   refcounted" made concrete). Key `(hash16, section_kind)`; value `Arc<Vec<u8>>`;
   budget **32 MiB [A]**, no floor (a miss rebuilds from PackStore bytes at
   zstd-decompress speed — cheap, local, no network).
3. **`MODEL_TRI_CACHE`** — shrinks 64 → **16 MiB** at legacy-lane retirement (adopting
   pass 4 D-04.8/H-04.2's proposal; 64 MiB retained during migration). Post-migration
   population: runtime decodes only (admin-spawned content, legacy stragglers) — baked
   geometry never enters it.
4. **`SURFACE_PIXEL_CACHE`** — 96 MiB today (lib.rs:10473). Post-cutover population is
   the I3-kept residue: entity/palette-composed surfaces + the no-BPTC fallback tier
   (pass 5 D-05.5). Budget **48 MiB summed (16 main / 32 worker) [A]** at retirement;
   96 MiB during migration. The composed-key discipline (lib.rs:10551–10560) unchanged.
5. **`SUITE_CACHE`(+`_BY_KEY`)** — today unbounded HashMaps (lib.rs:3601–3690). texchan
   sidecars survive v1 (pass 2 D-02.9, pass 5 Q7) ⇒ convert to a **16 MiB [A]**
   `ByteBudgetLru`, keyed as today.
6. **Legacy shard cache** — stays UNBOUNDED during migration (its convergence is
   measured: +92, +76, +41, +6, +2, +9 MB over six towns to 307 MB — a working set, not
   a ratchet; arming a tight budget thrashes refetch, 08-05 §8:348–355). At legacy-lane
   retirement its population is equipment-sized (pass 3 D-03.10) ⇒ budget **32 MiB,
   main instance only [A]**. Round protection kept verbatim.
7. **Deleted outright with their feeds:** scenery per-LB record cache (lib.rs:3269–3289
   — placements ride tile packs, pass 2 D-02.9), spawns/events fetch caches (same), and
   the per-instance catalog residency (~19 MB ×2 [M, survey §2] — catalogs are gone,
   pass 3 D-03.1).
8. **Censused-unbounded (−1 allowed, D-06.9):** `ANIM_CACHE` (12 B/entry, bounded by
   distinct scenery setups — hundreds), `MISSING_SURFACES`, tex-swap aliases, scratch
   pool, decode-DID diag set — each KB-scale with a structural bound stated at the
   store. `SURFACE_HEIGHT` stays flag-gated (`?gfxRelief`) and censused.

**Floors are never zeroed.** No pressure signal of any kind may set a store's floor or
the park pool's floor to 0. The one existing zeroing site
(`floorMs = overGeomAtEntry ? 0 : PARK_USE_TIME_MS`, landblock_lru.js:1373–1374 — the
p99 doc's cause #3 engine) is deleted with its governor (D-06.6). Under breach, floors
hold and the ladder sheds OTHER tiers first; the emergency rung may LOWER a floor to a
stated minimum (5 s), never to zero, and every deferral/lowering increments a census
counter (S5).

*Rejected:* one giant unified cache for all Rust payloads (packs, sections, pixels, and
tris have different value units, different rebuild costs, and different floors; a single
budget would let texture pressure evict pack bytes — cross-class pathology by
construction); hard budgets that evict floored/pinned entries (breaks the retail
release≠free invariant and re-creates the governor pathology); keeping the scenery/suite
caches unbounded because they're "small" (the census's own row-for-every-store rationale,
lib.rs:11397–11399, argues the opposite).

### D-06.6 — Pressure model: byte-denominated, class-local, floor-honoring; the geometry-count governor is DELETED

**Deleted:** `MAX_LIVE_GEOM` (8000) triggering on `renderer.info.memory.geometries` —
the count includes geometry the LRU cannot free (entities/atlas), so the trigger is
unsatisfiable once that baseline crosses it, and its floor-bypass drains the warm pool
exactly when it is needed (read-verified: landblock_lru.js:281–320, 1366–1374; p99 doc
#3). Deleted with it: the geom-pressure park feed, its backlog/floor/hysteresis bounds
(GEOM_PRESSURE_*), and the count-cap `maxResident` (~203, "effectively never fires",
landblock_lru.js:263–264 + index.js:5941–5943) — the grid IS the resident-count bound.

**Replacing it, three class-local budget loops, each of which pressure CAN relieve:**

1. **Park pool (JS/GPU-adjacent):** ≤40 tiles AND ≤128 MiB [A], floor 30 s, dispose
   farthest-first oldest-tie, ≤1 tile per tick under a 6 ms budget. All-young pool +
   over-budget ⇒ run over, count deferrals (the existing all-young fast path's exact
   shape, landblock_lru.js:1404–1447, kept).
2. **Rust stores:** their own budgets per D-06.5, enforced at insert, floor/pin-honored.
3. **Texture classes:** pass 5 D-05.8's allocated-byte budgets with **demote-to-preview
   as the eviction primitive** (pressure costs sharpness, never correctness, never a
   refetch).

**The degradation ladder (S4, normative) when the page-level ceilings are threatened**
(JS heap ≥ 0.9 × M1 = 1.44 GB, sampled 1 Hz; or any context-loss event):

- R1: demote full-tier textures of PARKED slots to preview; terrain t1024→t128 demote
  (pass 5 tier ladder). Biggest bytes, zero refetch, invisible-or-soft.
- R2: park-pool release beyond the floor, budget halved for the emergency's duration.
- R3: PackStore/section budgets halved (floor still honored; T2 shrinks toward pinned).
- R4 (emergency only): park + PackStore floors lower 30 s → **5 s (never 0)**;
  lookahead prefetch suspended; lane T paused. Every R4 engagement is a loud census
  event — R4 firing in normal play is a bug by definition.
- **NEVER sheds, at any rung:** the player's current tile + 3×3 LB floor (the
  streamer's working set — the structural form of GEOM_PRESSURE_RESIDENT_MARGIN's
  lesson); pinned packs (CORE/commons/index, LIVE+PARKED-region PVW); preview textures
  of LIVE slots; visible entity rigs; controller quarantine bookkeeping.

*Rationale:* every trigger is denominated in the unit its relief valve moves (bytes shed
bytes; the old governor's count-trigger could not be relieved by parking — the file
says so itself, landblock_lru.js:309–319). M7 (geometry count returns to baseline)
becomes a pass-10 VALIDATION metric, not a control input. *Rejected:* keeping a
count-based governor with a better count (any count shared with unevictable populations
re-creates the unsatisfiable breach); pressure-driven floor zeroing (settled law — the
walls name this pathology explicitly).

### D-06.7 — Refcounts across the wasm boundary: THERE ARE NONE — by construction

Ownership is severed at the boundary, deliberately:

- **Rust owns Rust:** pack bytes (`Arc` + pin counts), sections (`Arc`), decode memos
  (`Arc` under `ByteBudgetLru`'s refcount predicate). No JS handle references any of it
  on the world path — pass 4's exit contract is one JS-owned `ArrayBuffer` per bundle,
  no wasm-bindgen handles, no `free()` (D-04.5).
- **JS owns JS:** scene containers, pool buffers (pass 7), textures + staging (pass 5's
  per-class registries; full-tier textures refcount by rsId across
  materials/clones/layers per H-05.1 — a JS-side count).
- **The only cross-boundary lifetime signals are the grid's explicit calls**
  (`pack_pin`/`pack_unpin`), which are idempotent, slot-scoped, and auditable in the
  census (pinned bytes = a census column, S5).
- The entity/legacy path keeps today's handle + FinalizationRegistry machinery for its
  own population only (pass 4 D-04.8) — the one place wasm-bindgen handles remain.

*Rationale:* a cross-boundary refcount (JS holding Rust `Arc`s or vice versa) is
unauditable from either side and was the shape of the `__cacheOwned` dispose-dance
failure the house rules already prohibit. Copy-at-exit costs one bounded memcpy (pass 4
priced it: 3.02× smaller than today's floor) and buys lifetime independence.
*Rejected:* zero-copy views into wasm linear memory (detach-on-grow; SAB
untransferability; pass 4 already rejected with the same evidence).

### D-06.8 — Wasm topology: TWO instances (main + bake worker), the worker de-stated; M3 split 384/96/32

**Decision (charter H5 discharged): keep the dual-instance topology, and settle the
duplication question by deleting the duplicated STATE, not the second instance.**

| | main instance | bake worker instance | (net worker) |
|---|---|---|---|
| role | session/physics/collision; sync `ResourceSource` reads; PackStore + PackSections; entity-residue decode | bundle assembly (GEOM → GeometryBundle incl. setup fusion + envcell slot-remap + vertex light bake), terrain subdiv, bake-feed surface decode (residue), equipment decode (legacy lane) | transport relay only |
| resident stores | PackStore 96 + sections 32 + tri 16 + surface 16 + suite 16 + legacy 32 | commons pin ≤8 MiB + per-job leases (dropped at job end) + surface 32 + tri (shared budget, small) | none |
| linear budget | **≤384 MiB** | **≤96 MiB** | **≤32 MiB [A — never measured, charter Q4]** |

Summed ≤512 MiB = M3 ✓, with the split chosen so the worker's census MUST read
`packBytes: 0` and `shardRecords: 0` — the ~58+21 MB two-cache ratchet
(shard_cache.rs:8–11) and the double catalogs (~19 MB ×2) end structurally: the worker
never fetches (pass 3 D-03.3), never holds packs beyond a lease, and its triangulation
role collapsed to memcpy-scale (pass 4 H-04.2).

**Why not one instance:** the jobs that remain worker-side are the ones with real,
partly-unmeasured CPU: the envcell vertex light bake (pass 4 Q3 — p90 639 cells/LB
class), terrain subdiv at ring scale, and equipment decode bursts (119-spawn class).
Putting them on the main thread buys ~96 MiB of M3 headroom at the price of the F5/F6
tail budgets — the wrong trade on a CPU-bound frame, and the bake worker's win is
measured history (−24% longtasks, −34..37% per-LB stalls, 07-01 handoff §Landed-1).
**Why not three+ wasm instances:** the texture worker is deliberately wasm-free
(pass 5 D-05.4); a second bake worker re-creates per-instance store duplication (the
Path-C rejection, lib.rs:9029–9037).

**Lease mechanics (completes pass 3 D-03.3):** `leaseForJob(hashes[])` serves from the
controller's transient JS-side buffer of recently-verified pack ArrayBuffers
(**≤16 MiB [A]**, drop-after-transfer) with re-read-from-HTTP-cache as the miss path —
never a second wasm-resident copy. Worker lease residency is bounded by job concurrency
(1) × job working set (~1 tile's packs + commons).

**Instance-cache ownership rule (normative):** a cache may exist in at most ONE
instance unless its row appears in BOTH census halves with a stated reason (currently
only `surfacePixels` and the tri memo qualify, both during migration; the census's
"duplication is itself a finding" doctrine, lib.rs:11459–11463, becomes a CI assertion —
S5).

### D-06.9 — Census integration: every payload row budgeted, −1 needs a stated bound, three instances summed, one JS aggregate

1. **Rust census (`hb_mem_census`) row changes:** add `packBytes` (budget 96 MiB;
   plus `pinnedBytes` in the row via the entries field pattern), `packSections`
   (32 MiB), `leaseBuffer` (worker; 16 MiB); `suiteArtifacts` gains a budget (16 MiB);
   `sceneryRecords` row is retired with its store; `shardRecords` keeps its row through
   migration (budget −1 → 32 MiB at retirement). The `budget: Option<usize>` → −1
   rendering convention (lib.rs:11405–11408, 11442–11445) is kept.
2. **The −1 policy:** a row may carry −1 ONLY if the store's definition states a
   structural bound (entry-size × bounded-population arithmetic in a comment at the
   store). CI gate (pass 10 wiring): **any row with budget −1 and bytes > 4 MiB fails
   the census check** — this is the mechanical form of "where unbounded is still
   allowed".
3. **Third instance:** the net worker gains the same census relay the bake worker has
   (its linear memory is currently UNSUMMED — 08-05 §8 instrument note:396–400; M3
   cannot be scored honestly without it — charter Q4 retired by this work item).
4. **JS aggregate — `__diag.residency()` (one object, poll-safe):**
   `{grid: {W, anchor, slots: {live, parked, fetching, staged, quarantined},
   shifts, teleports, shiftMismatches, slotDesyncs}, park: {tiles, bytes, floorMs,
   deferredCount, deferredBytes, reAdoptCancels}, ladder: {rung, r4Engagements,
   floorLowerings}, wasm: {perInstance census summaries, summed vs M3}, tex:
   (pass 5 __texStats byClass vs budgets), heap: usedJSHeapSize vs M1}` — the
   fixed vector pass 10's benches and the stall probe diff across frames.
5. **M-wiring:** M1/M2 read from `heap`; M3 from summed census; M4 from pass 5's mirror
   census; M6 from per-class allocated:used; M7 from `renderer.info.memory.geometries`
   as a VALIDATION series (baseline ±10% after the six-town route).

### D-06.10 — Teleports and sealed interiors: invalidate + amortized drain; sealed = grid freeze + pinned return core

- **Teleport** (anchor delta ≥ W_T): whole-grid invalidate. Old slots move to PARKED via
  an amortized drain (first tick gets a generous time budget ~250 ms, subsequent ticks
  6 ms — adopting the R-12 lesson that at teleport arrival frames are seconds apart and
  one accepted blip beats a staircase, landblock_lru.js:28–44); the park pool's normal
  budgets then age them out. No proactive network release; the arriving grid seeds
  exactly like boot (pass 3 S3 wave shape at lane R priority). Pending parks from before
  the teleport are dropped (scheduler `reset()`, fixed_grid.js:589–597).
- **Sealed interior** (no outdoor-facing portal — the existing detection stands): the
  grid FREEZES (no shifts, no fetches — adopting `fixedGridSealedFreeze` semantics,
  url-flags.md:507); all outdoor slots go PARKED with a **pinned return core** — the
  slots within Chebyshev 1 tile of the entry tile are exempt from all pressure rungs
  R1–R3 for the dwell (the sealedPark design's bounded-pin shape, landblock_lru.js:
  120–147, re-expressed at tile scale: ≤9 tiles, counted inside the park budget). On
  exit: grid re-seeds at the exit position; if the exit is the entry (the common hub
  round trip), the pinned core re-adopts pointer-cheap. R4 may shed the pinned core
  (emergency beats convenience) — loudly.
- **Portal-destination hint (pass 3 Q5 answered):** on portal-use the client usually
  knows the destination LB before arrival; the grid publishes
  `onTeleportPending(destLb)` so the controller can pre-enqueue the destination tile
  (lane U) one transit early. Best-effort: no hint ⇒ today's behavior.

## Spec

### S1 — Grid geometry and event vocabulary (normative)

```
Constants:  R_LB = RESIDENCY_RADIUS_LB = 5   (residency.js:51 — unchanged)
            W_T  = R_LB + 1 = 6              (tiles per axis; 36 slots)
Anchor:     A(lb) = (floor((lb_x − R_LB)/2), floor((lb_y − R_LB)/2))
Slots:      slots[r*W_T + c] = tile (A.x + c, A.y + r), world-edge-clamped (absent
            tiles = −1, the fixed_grid.js inMap discipline)
Shift:      on A change with max-axis delta < W_T: pointer-shift; admit/vacate the
            delta rows/columns.  Teleport: max-axis delta ≥ W_T.
Integrity:  positional shift cross-check + slot/record lockstep assert carried over
            verbatim (fixed_grid.js:271–288, 394–428); both counters MUST stay 0.
```

Events (the vocabulary pass 3 S4/H-03.3 and passes 7/8 subscribe to):

| event | payload | fired when |
|---|---|---|
| `onSeed` | `{anchor, tiles[36]}` | boot / post-teleport re-seed |
| `onShift` | `{anchor, admitted: tile[], vacated: tile[], heading}` | anchor change < W_T |
| `onTeleportPending` | `{destLb}` | portal use with known destination (best-effort) |
| `onTeleport` | `{fromAnchor, toAnchor}` | anchor change ≥ W_T |
| `onSlotState` | `{tile, from, to}` | every S2 transition |
| `onSealedEnter` / `onSealedExit` | `{keepLb, entryTile}` | sealed detection (existing) |
| `onLadder` | `{rung, engaged/released}` | D-06.6 ladder transitions |

### S2 — Per-slot state machine (normative)

| state | content held | entered by (trigger) | leaves to |
|---|---|---|---|
| `EMPTY` | nothing (T3/T4) | boot; true release | `FETCHING` on admit (grid shift / seed / lookahead promotion) |
| `FETCHING` | controller queue entry | admit event → controller lane R (U if player-blocking) | `STAGED` on verified receipt; `QUARANTINED` on S7-terminal failure; `EMPTY` if vacated before fetch (dequeued — never fetch-then-drop, pass 3 S2.5) |
| `STAGED` | pack bytes in PackStore (pinned); no scene presence | `insert_pack` + `pack_pin` (controller) | `LIVE` when bake completes (pass 8 schedules; bundle assembly + upload); `PARKED` skipped — an unbaked vacated slot goes straight to `EMPTY` (unpin; bytes ride the PackStore floor) |
| `LIVE` | scene-attached; pools active; textures preview-or-better | bake completion (bake scheduler) | vacate event → 2 s hysteresis → `PARKED`; re-entry during hysteresis cancels (no transition) |
| `PARKED` | detached containers / deactivated pool ranges; GPU+heap warm; pack pins HELD | hysteresis expiry (scheduler drain) | `LIVE` on re-admit (pointer re-adopt); `EMPTY` on pressure release (floor-gated, amortized) / teleport-drain ageout / dwell-end |
| `QUARANTINED` | controller failure record (authoritative, never erased by residency) | S7 terminal failure | `FETCHING` on timed re-eligibility or proximity retry (pass 3 S7) |

Transition executors: admits/fetch = controller; pin/unpin = grid; bake = pass 8
scheduler; park/release = the park scheduler + pressure pass (both amortized, both
running in the rAF tick's budgeted phase — phase order is pass 8's). Every transition
increments `onSlotState` counters (S5).

### S3 — Budget table (normative; per-instance ownership per D-06.8)

**Rust stores** (all refcount-aware LRU, run-over-and-record on no-victim):

| store | instance | key | budget (post-migration) | migration value | UseTime floor | class |
|---|---|---|---|---|---|---|
| PackStore | main | hash16 | **96 MiB** | 96 MiB | 30 s from unpin; pins exempt | [A] |
| PackSections | main | (hash16, kind) | **32 MiB** | 32 MiB | none | [A] |
| MODEL_TRI_CACHE | main (+worker during migration) | u32 | **16 MiB** | 64 MiB (today's, lib.rs:9001) | none (refcount) | [A, pass 4 concurs] |
| SURFACE_PIXEL_CACHE | 16 main / 32 worker | SurfaceCacheKey | **48 MiB summed** | 96 MiB (today's, lib.rs:10473) | none (refcount) | [A] |
| SUITE_CACHE(+BY_KEY) | main | (did/hash, type) | **16 MiB** (NEW bound) | 16 MiB | none | [A] |
| legacy shard cache | main only (post) | (ns, id) | **32 MiB** | **unbounded** (measured convergent at 307 MB, 08-05 §8) | round protection | [M migration / A post] |
| lease buffer | JS (controller) | hash16 | **16 MiB** | 16 MiB | none | [A] |
| ANIM / negCache / aliases / scratch / decodeDids | main | — | −1 with stated structural bound | — | — | censused |

**JS/GPU-adjacent:**

| pool | budget | floor | notes |
|---|---|---|---|
| park pool | **≤40 tiles AND ≤128 MiB** [A] | 30 s | byte accounting via the existing per-entry estimate machinery; sealed return core pinned ≤9 tiles inside this budget |
| texture classes | pass 5 D-05.8 verbatim (≈610 MiB allocated; mirrors ≤250 MB) | demote-first | demotion wired as ladder R1 |
| pool geometry (pass 7) | pass 7 owns; MUST publish allocated+used into `__diag.residency()` | — | M6 binds on it |

**Instance linear ceilings (M3 = 512 MiB summed):** main ≤384 · bake worker ≤96 ·
net worker ≤32 [A].

### S4 — Pressure & ladder rules (normative)

1. Class-local loops run every tick, amortized: park release ≤1 tile/tick under 6 ms;
   Rust budgets enforce at insert; texture budgets enforce per pass 5.
2. Floors: honored by all steady-state pressure. All-young + over-budget ⇒ run over,
   count `deferredCount/Bytes` (the landblock_lru.js:1426–1446 fast-path shape).
3. Ladder trigger: `usedJSHeapSize ≥ 1.44 GB` (0.9 × M1) sampled 1 Hz, or a
   context-loss event, or summed wasm ≥ 480 MiB (0.94 × M3). Engage R1 → R4 in order,
   each rung given ≥5 s to move the metric before the next engages; release in reverse
   at a 0.85 low-water hysteresis. All [A] — pass 10 tunes.
4. R4 floor-lowering: 30 s → 5 s, never lower, never 0; suspended lookahead and lane T
   resume on release. `r4Engagements` > 0 on a default-URL bench run is a FAIL.
5. NEVER-shed list (D-06.6) is absolute at R1–R3; R4 may shed the sealed return core
   only. Nothing at any rung sheds: current tile + 3×3 LB, pinned packs, LIVE-slot
   previews, the index, quarantine records.
6. No component other than this ladder may initiate cross-class shedding; no component
   may dispose park-pool content outside the pressure pass, the teleport drain, and
   teardown.

### S5 — Census & diag schema (normative deltas)

Rust rows after this pass (budget in parens; −1 = stated-bound unbounded):
`packBytes(96 MiB, +pinned split)`, `packSections(32 MiB)`, `modelTri(16/64 MiB)`,
`surfacePixels(as S3)`, `suiteArtifacts(16 MiB)`, `shardRecords(−1→32 MiB)`,
`surfaceHeight(−1, flag-gated)`, `sceneryAnim(−1)`, `negCache(−1)`,
`texSwapAliases(−1)`, `scratchPool(−1)`, `decodeDids(−1)`; `sceneryRecords` retired.
Worker census must read `packBytes: 0`, `shardRecords: 0` post-migration (D-06.8
ownership rule); net worker relay added.

New counters (all cumulative, all diffable by the stall probe): per-slot-state
transition counts, `parkDeferredCount/Bytes`, `floorLowerings`, `r4Engagements`,
`shiftMismatches`, `slotDesyncs`, `pinLeaks` (pins held by non-resident slots — MUST
stay 0), `leaseBytesPeak`.

CI/bench gates wired for pass 10: (a) −1 row with bytes > 4 MiB ⇒ FAIL; (b) census
`unattributed` growth > 32 MiB over the six-town route ⇒ FAIL (today's steady ~50 MB
[M, 08-05 §8]); (c) `pinLeaks`/`shiftMismatches`/`slotDesyncs` nonzero ⇒ FAIL;
(d) M3 summed check includes all three instances or the run is invalid.

### S6 — Deletion ledger (evidence anchors read this session)

| deleted | anchor | replaced by |
|---|---|---|
| `maxResident` count cap (~203, never fires) | index.js:5941–5943; landblock_lru.js:263–264 | grid = the resident bound |
| `MAX_LIVE_GEOM` geometry-count governor + geom-pressure feed + its three bounds | landblock_lru.js:281–351 | byte budgets per class (S3/S4) |
| **floor-zeroing under breach** | landblock_lru.js:1373–1374 | floors never 0 (D-06.5/S4.4) |
| `tickEviction` reactive victim scan + reclaim gate + hysteresis flags | landblock_lru.js:1040–1330, 421–472 | positional grid events |
| `tickPvsLoadExpansion` per-packet ring recompute | cells.js:2739–2830 | grid shift events (indoor collapse → sealed freeze) |
| S15b radius-1 terrain grid + driver wiring | fixed_grid.js:55; url-flags.md:505 | subsumed by the W_T=6 grid (core mechanics adopted) |
| sealedEvict/sealedKeepRing/sealedPark special-case lattice | landblock_lru.js:28–215 | D-06.10 freeze + pinned core (same bounds, one mechanism) |
| per-instance shard caches as world-content residency (58+21 MB ratchet) | shard_cache.rs:8–11 | PackStore (main-only) + leases |
| per-instance parsed catalogs (~19 MB ×2) | survey §2 [M]; pass 3 D-03.1 | HBSI1 index (~0.5 MB, once) |
| scenery/spawns/events fetch caches | lib.rs:3269–3289 (scenery shape) | tile-pack sections |

All deletions stage through pass 9 (the LRU module retires only after the grid soaks
the full battery — the S15 landing-order discipline, plan §5, applied again).

### S7 — Budget traceability

- **M1/M2:** T0+T1 position-bounded + T2 byte-bounded ⇒ heap is O(resident set); the
  route-growth mechanism (parked-forever + mirrors + unbounded stores) is deleted.
  Validation pass 10 (six-town route; M2 ≤150 MB after 3rd town).
- **M3:** S3 ceilings sum to 512; the 307 MB shardRecords line is superseded by
  PackStore ≤96 MiB; worker de-stating removes ~100+ MB class duplication [D].
  Requires the net-worker relay to score (S5 gate d).
- **M4/M5/M6:** pass 5's budgets adopted unchanged; this pass adds the demote hook
  (ladder R1) and the pin rule that keeps demotion sync-legal (D-06.5.1).
- **M7:** validation metric only (D-06.6); structural expectation: park dispose +
  pool release return counts to baseline ±10%.
- **C3/C5:** tier definitions D-06.4; the trailing-edge floor (30 s) + PackStore floor
  make ≤30 s reversals T1/T2 (zero wire, zero decode); C5's wire margin unchanged from
  pass 3 S8.2 (the grid admits exactly the tiles pass 3's arithmetic priced).
- **F5/F6 (tail):** no unbounded dispose path remains (S4.6); every residency work item
  is budgeted per tick; the two measured tail engines this pass touches (#3 governor
  churn feeding cold re-bakes; bulk evict spikes) are removed structurally. No fps
  prediction made (R5); pass 10 measures via the stall probe.
- **B-series:** boot = grid seed of 36 tiles = pass 2/3's budgeted boot exactly; no new
  requests or bytes introduced by this pass.

## Handoffs to later passes

- **H-06.1 (→ pass 7):** Slot-state → pool-membership mapping: LIVE = active
  ranges, PARKED = deactivated-but-resident ranges, EMPTY = released ranges; pools
  publish allocated+used bytes into `__diag.residency()` (M6 binds); the park pool's
  byte estimate should migrate from per-container guesses to pool-range arithmetic once
  pools own the geometry. Proposed default: pool release is deferred to slot `EMPTY`
  (park keeps ranges), making park GPU-free by construction.
- **H-06.2 (→ pass 8):** Phase order and budgets for: grid update → controller enqueue →
  bake jobs → upload → park scheduler drain → pressure pass (all currently rAF-tick
  work, index.js:2373's slot); the teleport drain's 250 ms first-burst placement; lease
  transfer scheduling; the 1 Hz ladder sampler's home.
- **H-06.3 (→ pass 9):** Migration staging: the grid ships behind `?slotGrid`
  (default-OFF until the battery + 1070 eye-test, then default-ON with `=off` escape —
  house rule); stage order mirrors S15's proven ladder (terrain-first is DONE; next:
  grid-as-authority for statics/buildings/cells behind the flag, LRU as derived-view
  assert, then deletion); doc-propagation duties: landblock_lru.js's header,
  url-flags.md rows 505–507, the survey §4 I4 "never built" correction (walls: verdicts
  must reach the files agents read).
- **H-06.4 (→ pass 10):** Measurements owed: park-pool byte-estimate fidelity vs heap
  census; envcell light-bake µs (pass 4 Q3 — sizes the worker decision's margin);
  net-worker linear (charter Q4); ladder thresholds + rung dwell tuning; the zig-zag
  bench (boundary oscillation — `reAdoptCancels` should absorb ~all of it) and the
  teleport-settle comparison vs today's battery baselines; the S5 CI gates.
- **H-06.5 (→ pass 11):** Attack surface flagged deliberately: the 96/32/128 MiB
  budgets are [A] sized from pass 2/4 byte stats, not measured occupancy; the
  dual-instance call rests on the unmeasured light-bake cost; the "never built"
  correction should be independently re-verified; the PVW pin rule's coverage of
  cross-region singleton demotions.

## Self-check

- **Walls — allocated ≠ used:** the grid's 144-vs-121 LB coverage slack is stated and
  priced (D-06.1); budgets are enforced on measured resident bytes with
  deferral-counting, and M6 binds on pool allocated:used (S3). PASS.
- **Walls — governor pathology:** the floor-under-breach semantics are spec'd
  explicitly (never zero; R4 lowers to 5 s, loudly, D-06.5/S4.4) and the count-trigger
  governor is deleted with its anchor cited (D-06.6). PASS.
- **Walls — bulk-evict GC spikes:** no unbounded dispose path survives (S4.6);
  teleport/sealed drains are time-budgeted with the R-12 evidence cited. PASS.
- **Walls — scale confusion:** tile vs LB vs slot counts labeled throughout; tiers
  T0–T4 name where bytes live; census rows name instances. PASS.
- **Walls — draws×µs / draw-count proxy / 70 ns glue / GPU-on-CPU-bound /
  parked-vs-moving / boot variance:** no frame-time or draw-count figure is predicted
  anywhere in this pass; F-series impact is stated structurally with measurement routed
  to pass 10 (S7). PASS (mostly N/A by scope).
- **Walls — flag-bit ≠ predicate:** `?slotGrid` is spec'd default-OFF-until-validated
  then default-ON with explicit `=off` escape (H-06.3), matching the house rule the
  S16 flip already exercised. PASS.
- **R1:** read order followed; no prior-pass decision contradicted. The one factual
  correction (07-11 plan partially built) contradicts the SURVEY's wording, not a pass
  decision — pass 1 D-01.7 ("the 07-11 plan is the designed shape; pass 6 owns") and
  this pass's adopt-and-generalize disposition are compatible; evidence cited
  (fixed_grid.js, url-flags.md:505–507). Handoffs H-02.4, H-03.3, H-04.2, H-05.1,
  charter H5, pass 3 Q5 are each explicitly discharged or adopted. PASS.
- **R2:** pool internals (7), phase order/upload budgets (8), migration staging (9),
  bench mechanics (10) deferred with proposed defaults. PASS.
- **R3:** writes = this file + own TRACKING.md row. PASS.
- **R4:** every current-code claim carries file:line opened THIS session (see Inputs
  read); the wasm-crate trap respected (`apps/holtburger-web/src/lib.rs` throughout);
  the "designed-but-never-built" briefing premise was read-verified FALSE rather than
  transcribed — the stale-premise trap this codebase's rules warn about. PASS.
- **R6:** six sections in required order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete geometry (anchor formula, W_T), a state machine table, numeric
  budgets with [M]/[D]/[A] classes, named modules and events, census schema deltas.
  PASS.
- **R8:** unmeasured items (budget sizings, light-bake cost, net-worker linear, ladder
  thresholds, park byte-estimate fidelity) declared in Open questions with owners, not
  presented as settled. PASS.

## Open questions

- **Q1 — Budget sizings are [A].** PackStore 96 / sections 32 / park 128 MiB / lease 16
  are derived from pass 2/4 byte statistics, not from measured occupancy of a running
  grid. First soak run must publish the census occupancy series so each budget is
  re-classed [M] or resized. [Owner: pass 10 protocol + first implementation soak.]
- **Q2 — Envcell light-bake cost is the dual-instance decision's load-bearing unknown**
  (pass 4 Q3). If measured trivial (<1 ms/cell-batch class), a single-instance topology
  becomes defensible and would return ~96 MiB of M3 headroom; the D-06.8 contract is
  deliberately lease-based so the collapse would be additive, not a redesign.
  [Owner: pass 10 on the 1070.]
- **Q3 — Park-pool byte accounting fidelity.** Today's per-entry `p.bytes` estimates
  drive the 128 MiB cap; nobody has validated them against the heap census. If they
  under-read, the pool ceiling is soft. Cross-check on the six-town route.
  [Owner: pass 10; H-06.1's pool-range arithmetic is the structural fix.]
- **Q4 — Net-worker linear memory** (inherited charter Q4): the ≤32 MiB line is a guess
  until the relay lands and one route run reads it. [Owner: census relay work item.]
- **Q5 — Ladder thresholds and rung dwell** (0.9×M1 trigger, 5 s per rung, 0.85
  release) are engineering guesses; a synthetic-pressure test (heap balloon) should
  exercise R1→R4 before the ladder is trusted on the 1070. [Owner: pass 10.]
- **Q6 — Entity residency stays OUT of the grid** (charter N7/I5-kept: reaper keep-zone
  radius 8 > grid horizon, residency.js:61–79). The seam is one-way: entity REAPING may
  consult grid state, the grid never manages entities. If pass 7's pool design pulls
  animated scenery deeper into pools, the boundary needs re-stating there.
  [Owner: pass 7.]
- **Q7 — Sealed-detection fidelity at tile scale.** Sealed logic today keys on the
  keep LB (landblock_lru.js:1059–1160); a tile can contain both a sealed hub's LB and
  ordinary outdoor LBs. The freeze/pin design (D-06.10) operates on tiles, so a
  worst-case tile pins ≤3 extra LBs of outdoor content — believed immaterial
  (~KB-to-low-MB class) but unexamined. [Owner: first implementation review.]
