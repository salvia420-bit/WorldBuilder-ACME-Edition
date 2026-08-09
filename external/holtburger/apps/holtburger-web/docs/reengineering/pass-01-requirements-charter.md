# Pass 01 — Requirements charter: targets, budgets, invariant disposition, non-goals, acceptance criteria

Pass 1 of 12. Governed by `TRACKING.md`'s protocol header. This charter sets the numbers the
re-engineered pipeline must hit, per platform tier; states which of the five invariants I1–I5
are broken versus kept and to what degree; fixes explicit non-goals; and defines the acceptance
criteria the final spec (pass 12) must satisfy. Every number carries its source class per R7:
**[M]** measured, **[D]** derived (arithmetic shown), **[BR]** benchmarked-relative to a measured
current figure, **[A]** aspirational-pending-measurement.

## Inputs read

Opened top-to-bottom in this session unless a line range is given:

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all): invariants I1–I5 (§4),
  workstreams W1/W2 (§5), walls ledger (§6), current-state pipeline map (§2–3).
- `docs/2026-08-06-frame-cost-structure-measured.md` — lines 1–629 (all): frame split, CPU-bound
  verdict, 37.6 µs fixed/draw, end-to-end 20.2 ms p50 parked mid (§7).
- `docs/2026-08-05-1070-black-flicker-and-renderer-oom-handoff.md` — lines 1–741 (all): heap OOM
  near 2.8 GB, wasm/texture censuses (§8–§9), atlas grow result (§12), context-loss constraint (§10).
- `docs/2026-08-06-p99-stall-attribution.md` — lines 1–431 (all): p99 1,630 ms moving/ultra, ranked
  causes, stall probe.
- `docs/2026-08-04-xubc7-progressive-texture-plan.md` — lines 1–111 (all): the 666 kbps player-line
  figure (line 4), gzip cold-boot code+data 4.8 MB (line 16), XU7 tier ratios (lines 25–30).
- `docs/url-flags.md` — excerpt around lines 35–66 (SwiftShader eye-shot waiver context; harness
  contract params `nullRender`/`agent`/`nosw` are opt-in by contract).
- `crates/holtburger-resource-http/src/manifest_source.rs` — targeted line reads via `rg -n` with
  content displayed: lines 93–115 (`shard_verify_enabled`, unset ⇒ verify, comment prices boot
  verify at "sha256 over ~25 MB across ~2 k shards"), 123–143 (`configured_shard_budget_bytes`
  default `usize::MAX`), 310–312, 500–527 (boot-pack sha256, per-shard verify path).
- Live dist (symlink target `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`), `ls` this
  session: `manifest/eor-cell.bin` = 15,352,534 B; `manifest/eor-portal.bin` = 1,499,109 B;
  `boot.hba` = 1,972,841 B; `manifest.json` = 648 B; `shards/` = 8.9 GB on-disk (`du`; the survey's
  6.46 GB is the logical corpus figure — the delta is block-overhead across ~895k small files).

Prior pass outputs: none exist (this is pass 1); the status table confirms all rows TODO.

## Decisions

### D-01.1 — Platform tiers: three tiers, two of them perf-binding, one functional

**T1 — GTX 1070 daily driver (the perf reference).** Chrome ~150, ANGLE/D3D11,
`MAX_TEXTURE_IMAGE_UNITS = 16`, renderer heap cap 4,192 MB, quality auto-detects `mid`
(all [M], 08-05 handoff §1/§3/§6). All frame-time and memory-ceiling targets bind here, at the
reference condition of the 08-06 end-to-end measurement: quality `mid`, canvas ~1200×1013,
`renderScale=1`, `adaptiveRes=off`, settled Nanto (frame-cost doc §7). Ultra-specific tail
targets bind at `ultra` on the same box.

**T2 — SwiftShader no-GPU 8 GB laptop (the functional/dev tier).** No frame-rate targets bind
here — SwiftShader "lies about" GPU claims (url-flags.md farRing note) and headless walking is
sub-1 fps by prior operational record. What binds: boot correctness, bot-mode operation
(`?nullRender=1` sim/drain), and a tighter heap ceiling (8 GB machine under earlyoom).

**T3 — the 666 kbps line (the wire tier).** ~666 kbps ≈ 83 KB/s ≈ 5 MB/min [M as the documented
player-bandwidth figure, xubc7 plan line 4]. All download/RTT budgets bind at T3. T3 is
orthogonal to T1/T2: the canonical player is T1 hardware on a T3 line.

*Rationale:* these are the three platforms every perf doc in this tree already measures against;
inventing a fourth (e.g. mid-range mobile) would add unmeasurable targets (R8).
*Rejected:* a single blended tier (hides the fact that wire and frame ceilings bind on different
hardware); a WebGPU tier (non-goal N7).

### D-01.2 — Metric definitions and mandatory scale labels

Every figure in passes 2–12 must carry one of these defined scales; the walls ledger's
"resident ≠ drawn ≠ submitted" and "allocated ≠ used" errors are the motivation.

- **Boot milestones:** `in-world` (spawned, input live) → `preview-complete` (every visible
  surface textured at preview tier or better, terrain included) → `converged` (full texture tier
  resident for the current ring). Bytes/RTT budgets state which milestone they gate.
- **Frame scales:** `parked` vs `moving` are different populations and never comparable
  (wall: parked-vs-moving); every count states `resident` / `drawn` / `submitted`; memory states
  `allocated` vs `used`.
- **Request/RTT:** "requests" = HTTP GETs; "serial RTT depth" = longest chain of fetches where
  each cannot be issued before the previous resolves (today's decode-as-discovery walk is depth
  ≥4 per material chain [M, survey §2]).
- **Memory:** JS heap = `usedJSHeapSize`; wasm linear = summed across ALL instances (main +
  bake worker + net worker — the third instance is currently unsummed, 08-05 handoff §8
  instrument notes); CPU texture mirrors = live `image.data`/`mipmaps[].data` bytes per the
  WeakRef census; VRAM has no direct WebGL2 instrument, so VRAM targets bind on proxies
  (context-loss count, allocated-texture byte estimates, `renderer.info.memory` deltas).

*Rejected:* free-form metrics per pass (this is precisely how four ~2× scale errors happened in
one day, walls ledger).

### D-01.3 — Cold-boot budgets (T3 line, T1 hardware)

Current state, all [M]: ~1,700 requests; code+data 4.8 MB gzipped (wasm 1.9 + JS 2.8, xubc7 plan
line 16); blocking data floor ≈ 25 MB (eor-cell.bin 15.35 MB verified this session + boot.hba
1.97 MB verified + eor-portal 1.5 MB + per-shard fetches that the sha-verify comment prices at
"~25 MB across ~2 k shards", manifest_source.rs:99); terrain first visit 81 MB at t1024 (survey
§3; full t1024 static corpus 78 MB, survey §2). Total to a fully-textured spawn ≈ 110 MB
≈ **22 min at 666 kbps** [D: 110 MB ÷ 5 MB/min].

| Budget | Target | Source class |
|---|---|---|
| B1 — bytes to `in-world` + `preview-complete` | **≤ 12 MB** (≈ 2.4 min at T3 [D: 12 ÷ 5 MB/min]) | [D] below |
| B2 — requests, cold boot to `preview-complete` | **≤ 64** | [D] below |
| B3 — serial RTT depth to first render work | **≤ 4** (login excluded) | [D] |
| B4 — bytes to `converged` spawn ring | **≤ 45 MB** (≈ 9 min at T3) | [A] — hangs on pass 5's lossy-tier call |
| B5 — warm boot (2nd visit, valid cache) | **≤ 1 MB network, ≤ 5 requests** (revalidation only) | [D] |

B1 arithmetic: code ~5 MB (today's 4.8 MB [M], assumed roughly stable) + spatial index ≤ 1 MB
(replaces the 15.35 + 1.5 MB eor catalogs — a pack index is per-pack, not per-record; pass 2
owns the format, pass 3 the wire shape) + boot closure pack(s) ≤ 6 MB at preview tier (today's
boot.hba record set is 1.97 MB [M]; pre-triangulated indexed geometry adds bytes — I2's
de-indexed 3× penalty moves offline, indexing claws most back; previews are ~6% of texture
bytes [M, survey §2]; terrain preview ≤ 2 MB vs 78 MB full [A component]). Components marked
assumed are re-derived by pass 2 from real byte statistics; B1 is binding unless pass 2's
measured pack overhead pushes it, in which case pass 2 must state the new number and why
(handoff H1).

B2 arithmetic: 1 manifest + 1 spatial index + ~10 code/wasm + ≤ 50 packs (survey W1: "a handful
of range-friendly packs"; 121-LB default ring at ≥1 LB-pack per 2×2 tile ≈ 36 + shared-asset
packs). B3: manifest → index → packs (parallel) → shared-asset misses (parallel) = 4
generations; today's walk loop alone is ≥4 serialized waves per chain [M].

B5 rationale: packs are content-addressed and immutable, so a correct cache story (pass 3,
including the SW whose staleness behavior is a documented trap) makes revisits near-free.

*Rejected:* budgeting "requests" alone (compression and coalescing can game it; bytes and RTT
depth are what a 666 kbps line feels); budgeting against the fast-line 1,700-request boot only
(T3 is where the current design is unusable: 22 min).

### D-01.4 — Per-crossing budgets (streaming while moving)

Current state [M, survey §2]: a default ring rebuild is ≥363 tiny cell GETs before any model;
per-LB side trees add 3–4 GETs each; material chains cost ≥4 serial RTT waves; a fresh dungeon
is ~33 MB of tex-bc7 ≈ 6.5 min at T3 (xubc7 plan lines 4–6).

| Budget | Target | Source class |
|---|---|---|
| C1 — requests per new-LB column entering the ring (11-LB front), unvisited | **≤ 12** | [D: ≤1 pack per LB-or-tile + shared-asset misses] |
| C2 — bytes per column to `preview-complete`, unvisited | **≤ 1.5 MB** | [A — pass 2 byte stats confirm] |
| C3 — bytes/requests per crossing, previously visited (cache valid) | **0 network** | [D: content-addressed immutable packs + C5 residency] |
| C4 — fresh dungeon to `preview-complete` | **≤ 2 MB ≈ 25 s at T3** | [BR: today "texturally complete but soft at ~2 MB" is the P1 preview design's own number, xubc7 plan §P1] |
| C5 — sustained walk at T3, preview tier | streaming keeps up: no stall waiting on wire at continuous run speed | [D] below |

C5 coherence check [D]: one LB column = 192 m; assumed run speed 4–7 m/s [A, assumed —
retail-varying] ⇒ ≥ 27 s per column; C2's 1.5 MB needs ~18 s at 83 KB/s ⇒ ≥ 1.5× margin. If
pass 2's real bytes break this, C2 tightens or the prefetch radius (pass 3) compensates —
but C5 is the invariant the player feels and it wins.

*Rejected:* a per-LB budget instead of per-column (movement admits LBs a column at a time;
per-LB numbers invite the resident-vs-drawn class of scale error).

### D-01.5 — Frame budgets (T1)

Current state, all [M]: parked mid Nanto p50 20.2 ms / p95 26.5 (frame-cost doc §7, the
end-to-end interleaved measurement — the number to quote); moving ultra p50 47.5 / mean 84 /
p99 1,630 ms pre-shaderPrewarm (p99 doc); shaderPrewarm shipped, MAX 2131 → 369 ms (survey §2);
reference frame structure: draw funnel 12.78 ms at 37.6 µs fixed/draw (r²=0.014 vs instances),
BatchedMesh rebuild 5.72 ms, traversal ~3.6 ms over ~4.4k nodes (frame-cost doc §2/§5a);
**no trustworthy moving-mid figure exists** (frame-cost doc §7: the moving rig self-noised at a
6.6 ms control spread).

| Budget | Target | Source class |
|---|---|---|
| F1 — parked p50, mid, Nanto reference condition | **≤ 16.7 ms** (60 fps) | [BR/A: −17% vs 20.2 [M]] |
| F2 — parked p95, mid | **≤ 22 ms** | [BR: vs 26.5 [M]] |
| F3 — moving p50, mid | **≤ 1.25× same-session parked p50** | [A — baseline must first exist via pass 10's fixed-pose bench] |
| F4 — moving p99, mid | **≤ 60 ms** | [A] |
| F5 — moving p99, ultra | **≤ 150 ms**, and stall-probe `linkStatusMs` = 0 over a 60 s walk (no in-frame shader links, CSM depth variants included) | [BR: vs 1,630 [M] pre-prewarm / MAX 369 [M] post; probe per p99 doc] |
| F6 — hitch ceiling | no frame > 250 ms attributable to streaming/crossing work in steady walk | [A — attribution via the stall probe's ranked buckets] |

**Derivation prohibition (R5):** F1/F2 are deliberately NOT derived from draw-count arithmetic.
The walls forbid it twice over: draws-removed × µs/draw does not predict wins (statArrayMerge:
−23 draws = 0.0 ms), and draw count is a poor proxy (−12.1% draws = −2.8% frame). The
qualitative case for F1 is that I5's break attacks the frame's three measured structural blocks
(funnel fixed cost, rebuild, traversal) at their own scale — submitted-draw population and node
count — which is the only lever class the record shows moving multiple ms. F1 is a target to be
validated by pass 10's protocol, not a prediction. If the frame stops being CPU-bound along the
way, boundedness must be re-measured before any GPU work (wall: GPU theories on a CPU-bound
frame).

*Rejected:* a 30 fps floor for ultra-moving as the only tail metric (mean-blind; the 1,630 ms
history shows the tail is the lived experience); deriving F1 as
`(437−N submitted draws) × 37.6 µs` (walls, twice).

### D-01.6 — Memory budgets (T1 unless stated; T2 where stated)

Current state, all [M, 08-05 handoff]: tab OOM at ~2,808 MB against the 4,192 MB cap (§3); JS
heap 2,715 MB peak on the six-town route pre-fix (§9), 2,003 MB post-`statAtlasGrow` (§12);
live CPU texture mirrors 1,332 MB pre-fix (§9) → 863 MB post (§12); wasm linear summed
540 → 630 MB over the route with shardRecords +226 MB of the +248 MB `allocLive` growth, budget
unbounded by default (§8; default `usize::MAX` verified this session,
`manifest_source.rs:133-143`); `renderer.info.memory.geometries` monotone 65 → 15,081 (§4);
context losses 7/session at ultra (§10); atlas allocated-vs-used was 1,941 vs 112 layers
pre-fix (§11).

| Budget | Target | Source class |
|---|---|---|
| M1 — JS heap, any point of the six-town route | **≤ 1.6 GB** (≥ 2.5 GB headroom to the 4,192 MB cap) | [BR: ~59% of the 2,715 MB peak; ~80% of post-fix 2,003] |
| M2 — JS heap route growth after 3rd town | **≤ 150 MB** (heap is O(resident set), not O(route)) | [D from I4's break: bounded-by-construction residency] |
| M3 — wasm linear, summed over ALL instances incl. net worker | **≤ 512 MB total; ≤ 64 MB growth after warm** | [D: the 307 MB shard-record store is deleted by I1's break — packs are the residency unit; decode transients bounded by admission] |
| M4 — live CPU-side texture mirrors | **≤ 250 MB**, with re-supply guaranteed | [D from I3: compressed bytes stay compressed (BC7 ≈ ¼ of RGBA8); mirrors freed where a pack/wasm re-decode path can re-supply. HARD CONSTRAINT carried from 08-05 §10: context-loss recovery re-uploads from CPU data — releasing a mirror without a re-supply path is a permanently black world. The design owes re-supply, not retention.] |
| M5 — VRAM proxy: context losses | **0 per 30-min ultra session** (vs 7 [M]) | [BR] |
| M6 — VRAM proxy: allocated vs used | allocated ≤ **1.5×** used on every array/pool (vs 17× pre-fix atlas [M]) | [BR; wall: allocated ≠ used] |
| M7 — geometry lifecycle | `renderer.info.memory.geometries` returns to ±10% of post-boot baseline after the route (vs monotone +15k [M]) | [BR] |
| M8 — T2 heap ceiling | **≤ 1.2 GB** JS heap on the 8 GB laptop, bot modes | [A — earlyoom margin; never measured as a ceiling] |
| M9 — T2 boot | `?nullRender=1` boot to `in-world` with 0 page errors on localhost serve, ≤ 120 s wall clock | [BR: currently achievable per operational record; codifies it as a gate] |

*Rejected:* a direct VRAM byte ceiling (no WebGL2 instrument exists — an unmeasurable target
violates R7/R8); "fix disposal" as the memory strategy (measured dead: orphaned textures are
164 MB and non-ratcheting, disposal is not the OOM, 08-05 §9 — residency is).

### D-01.7 — Invariant disposition: I1–I5 broken vs kept, and to what degree

| Inv | Disposition | Degree and boundary |
|---|---|---|
| I1 — per-record HTTP + decode-as-discovery | **BROKEN** (W1) | Fully broken for world content: closure packs + spatial index replace per-record GETs, the walk loop, blocking catalogs, and per-shard sha256 (integrity moves to per-pack — pass 3). A per-record fallback MAY remain for rare/dynamic assets (equipment on other players, admin-spawned content); pass 3 decides its shape. The old dist stays servable during migration (pass 9). |
| I2 — runtime triangulation, de-indexed, clone-across-boundary | **BROKEN for static world geometry; KEPT for substitution-bearing models** | Offline pre-triangulated **indexed** buffers for terrain/statics/envcells/buildings; wasm→JS via transferables (pass 4 owns the contract). Equipment/clothing substitution (the never-memoized class, survey §2) stays runtime-decoded — its variability is per-character and unbakeable. Pass 4 owns the exact boundary and the runtime path's cost budget. |
| I3 — RGBA8-first, compressed-second double-build | **BROKEN** | Compressed-only runtime path: preview tier is the frame-1 fallback (already baked, ~6% [M]); no RGBA8 double-build, no driver-mipgen first pass. Residual RGBA8 decode is permitted ONLY as the fallback for GPUs without the required compressed formats — whether SwiftShader/T2 needs it is unverified (open question Q3; pass 5 owns). CPU mirrors → M4. |
| I4 — per-LB rebuild residency | **BROKEN** (W2) | Fixed player-centered slot grid + refcounted Rust resource caches with UseTime floors (the 07-11 plan is the designed shape; pass 6 owns). Edge-only churn; eviction leaves the keep-ring alone (the governor-drains-its-own-pool failure, p99 doc #3, becomes structurally impossible, not tuned away). |
| I5 — per-(LB,surface) draw granularity + per-placement scene nodes | **BROKEN for statics/terrain/envcells; KEPT for entities** | Persistent material-class multidraw pools over the resident set; O(pools) scene graph (pass 7 owns, including the 71% material-switch rate target). Entities (animated rigs) keep per-entity meshes — their draw population (~27 draws at 12.7 µs [M, frame-cost §2]) is not where the cost is, and rig animation is per-instance by nature. Animated scenery stays on the landed instanced path. |

*Rationale:* the survey's verdict is that every remaining multiple-scale gain requires breaking
one of these; the kept-degrees above are the places where the record shows the cost does NOT
live (entities) or where baking is impossible (per-character substitution).
*Rejected:* breaking I5 for entities too (no measured payoff; adds rig-batching risk to the
critical path); keeping I3's RGBA8 path as a permanent parallel default (it IS the double-build;
keeping it default forfeits M4).

### D-01.8 — Non-goals

N1. **No visual-fidelity regression as a perf trade without an eye-test gate.** Structural
    render changes are invisible to every harness metric (wall: flag-bit ≠ predicate / ClipMap);
    pass 9 owns the gate mechanics. Lossy texture tiers are a quality decision taken by eye
    (pass 5), not silently by this charter.
N2. **No server/protocol changes.** ACE stays vanilla; the wire being re-engineered is the
    static-content wire, not the game protocol.
N3. **No artist-facing LOD/authoring tooling.** Pass 4 may spec a mechanical LOD policy; a
    content-authoring system is out of scope.
N4. **No WebGPU port, no mobile tier.** WebGL2 + three r184 remain the substrate.
N5. **Dist disk size is not a metric.** Wire bytes are budgeted; the 6.46 GB (8.9 GB on-disk)
    corpus may grow or shrink as a side effect of packing/dedup — hosting disk is not the
    constrained resource. (Per-file block overhead — ~2.4 GB of the on-disk figure — does
    disappear with packs, but as a side effect, not a target.)
N6. **No dev-build performance work.** All perf targets bind on `--release` wasm only
    (ship-RELEASE rule; a ~18 MB wasm is a dev build and pays ~4× decode tax).
N7. **No entity/combat-scale gameplay perf program.** Entity work is in scope only where
    entities touch the pools/residency seams (D-01.7).
N8. **Not zero-downtime for developers mid-migration.** The live client must keep working at
    every migration stage (mission statement), but dual-dist coexistence may cost disk and bake
    time; minimizing that is pass 9's problem, not a charter constraint.

### D-01.9 — Acceptance criteria for the final spec (pass 12)

Pass 12's `SPEC.md` is acceptable iff:

A1. **Traceability.** Every budget ID here (B1–B5, C1–C5, F1–F6, M1–M9) appears in SPEC.md
    mapped to (a) the design element(s) that deliver it and (b) the pass-10 benchmark that
    validates it, with the reference condition stated (D-01.1/D-01.2 scales).
A2. **Arithmetic or risk, never neither.** Each [D]/[A] target is either re-derived from
    pass 2–8's concrete formats with the arithmetic shown, or carried as a tracked risk with a
    named measurement plan and owner. No target silently dropped.
A3. **Invariant coverage.** Each of I1–I5 has named module boundaries, formats, or data
    structures implementing its break, and the kept-degrees of D-01.7 are restated verbatim or
    explicitly superseded with evidence (R1 supersede rule).
A4. **Migratability.** The build order keeps a bootable, playable client at every stage;
    each stage names its kill criteria and fallback; flag policy follows house rules
    (validated gates default-ON with `=off` escape); every eye-test-gated stage names its gate.
A5. **Walls compliance.** No figure in SPEC.md is produced by a mechanism the walls forbid
    (draws × µs/draw prediction, count-as-proxy ranking, resident-priced-as-submitted,
    allocated-priced-as-used, cross-boot single-shot comparisons); every count carries a
    D-01.2 scale label. Pass 11 attacks exactly this and its findings must be dispositioned
    line-by-line in SPEC.md.
A6. **Honest residue.** Open questions surviving to SPEC.md are enumerated as tracked risks —
    each with the measurement or owner call that retires it — not papered over (R8).
A7. **Task granularity.** The task breakdown gives per-task acceptance criteria such that an
    implementing agent can verify completion without re-reading the whole spec corpus.

*Rejected:* accepting SPEC.md on design coherence alone (this week's record shows coherent
designs measuring 0.0 ms; only the A1/A5 wiring to measurement makes the spec falsifiable).

## Spec

### S1. Budget summary (normative table)

| ID | Metric | Current [M] | Target | Class |
|---|---|---|---|---|
| B1 | Cold boot bytes → in-world + preview-complete (T3) | ~110 MB ≈ 22 min | ≤ 12 MB ≈ 2.4 min | D |
| B2 | Cold boot requests | ~1,700 | ≤ 64 | D |
| B3 | Serial RTT depth to first render work | ~6–10 (walk waves ≥4/chain) | ≤ 4 | D |
| B4 | Cold boot bytes → converged spawn ring | ~110 MB | ≤ 45 MB | A |
| B5 | Warm boot network | ~(re-fetch-heavy; SW-dependent) | ≤ 1 MB / ≤ 5 req | D |
| C1 | Requests per new-LB column, unvisited | order 100+ | ≤ 12 | D |
| C2 | Bytes per column → preview-complete, unvisited | (unmeasured; ring rebuild ≥363 GETs) | ≤ 1.5 MB | A |
| C3 | Crossing into cached territory | non-zero | 0 network | D |
| C4 | Fresh dungeon → preview-complete | ~33 MB ≈ 6.5 min | ≤ 2 MB ≈ 25 s | BR |
| C5 | Sustained walk at T3, preview tier | fails (22-min boot class) | no wire-wait stalls | D |
| F1 | Parked p50, mid, Nanto ref | 20.2 ms | ≤ 16.7 ms | BR/A |
| F2 | Parked p95, mid | 26.5 ms | ≤ 22 ms | BR |
| F3 | Moving p50, mid | no trustworthy figure | ≤ 1.25× parked | A |
| F4 | Moving p99, mid | (unmeasured at mid) | ≤ 60 ms | A |
| F5 | Moving p99, ultra | 1,630 ms pre-prewarm; MAX 369 post | ≤ 150 ms; linkStatusMs = 0 | BR |
| F6 | Streaming hitch ceiling | 250 ms deliberate hitches exist (sealed purge) | no frame > 250 ms from streaming | A |
| M1 | JS heap peak, six-town route | 2,715 pre / 2,003 post-fix MB | ≤ 1.6 GB | BR |
| M2 | JS heap growth after 3rd town | +~500 MB class | ≤ 150 MB | D |
| M3 | wasm linear, all instances | 630 MB, +226 MB unbounded store | ≤ 512 MB; ≤ 64 MB growth | D |
| M4 | CPU texture mirrors | 1,332 pre / 863 post MB | ≤ 250 MB + guaranteed re-supply | D |
| M5 | Context losses, 30-min ultra | 7/session | 0 | BR |
| M6 | Allocated:used, arrays/pools | 17× (atlas, pre-fix) | ≤ 1.5× | BR |
| M7 | Geometry count after route | monotone +15k | baseline ±10% | BR |
| M8 | T2 JS heap | (unmeasured ceiling) | ≤ 1.2 GB | A |
| M9 | T2 nullRender boot | works per ops record | 0 errors, ≤ 120 s, codified gate | BR |

### S2. Binding conditions

- Frame targets bind at the D-01.1 T1 reference condition; pass 10 must define exactly two
  bench scenes — settled-parked Nanto and a fixed-pose moving route — and all F-targets are
  scored there and only there. A target "missed" anywhere else is data, not failure.
- Memory targets bind on the six-town route (Holtburg → Arwic → Yaraq → Sawato → Shoushi →
  Nanto) — the route every census in the record already uses.
- Wire targets bind on emulated 666 kbps (throttled), cold cache for B1–B4/C1–C2, warm cache
  for B5/C3. Requests counted at the network layer, not the app layer.
- All targets bind on `--release` wasm and a bare-default URL (no tuning flags), per the
  default-ON house rule: a pipeline that hits targets only under opt-in flags has not hit them.

### S3. Priority among targets when they conflict

1. Correctness/fidelity gates (N1) — never traded silently.
2. C5 (no wire-wait while walking) and F5/F6 (tail) — the lived experience.
3. M1/M3/M5 (don't crash the tab).
4. B1/B2 (first-session experience).
5. F1 (mean frame) — last, deliberately: the record shows means move when structure moves,
   and chasing the mean first produced this week's 0.0 ms results.

## Handoffs to later passes

- **H1 (→ pass 2):** Real pack byte-overhead and dedup statistics. B1/C2 assume pack overhead
  ≤ ~15% over summed record bytes and a ≤ 1 MB global spatial index. Proposed default: if
  measured overhead exceeds this, pass 2 restates B1/C2 with arithmetic and flags the delta;
  the 12 MB/1.5 MB figures are otherwise binding.
- **H2 (→ pass 3):** Integrity granularity replacing per-shard sha256 (per-pack hash proposed);
  the warm-cache story (B5/C3) including the SW, whose current cache-across-restarts behavior
  is a documented trap; the per-record fallback path's existence and shape (D-01.7/I1).
- **H3 (→ pass 4):** The exact static-vs-substitution boundary for I2, and a cost budget for
  the retained runtime decode path.
- **H4 (→ pass 5):** The q75-vs-rdo lossy call (owner eye decision; sheets exist) — B4 carries
  both arms until then (lossless 59.3% ⇒ ~46 MB terrain+statics class; q75 38.2% ⇒ ~30 MB).
  Also Q3's no-BPTC fallback decision.
- **H5 (→ pass 6):** Single-vs-dual wasm instance. M3 is stated as a summed budget on purpose
  so the split is free to move; proposed default: keep the bake worker, M3 splits ~384/128.
- **H6 (→ pass 10):** The fixed-pose moving bench (F3/F4 baselines do not exist until it runs);
  emulated-666 kbps boot protocol; stall-probe integration for F5/F6 attribution.
- **H7 (→ pass 9):** Flag/defaults policy application to each migration stage; eye-test gate
  scheduling into 1070 batches (1070-eyetests-batched house rule).

## Self-check

Checked each decision against the walls ledger and R1–R8:

- **Scale confusion:** D-01.2 makes scale labels normative; S1 states each current figure's
  provenance. PASS.
- **draws×µs/draw non-prediction:** D-01.5 contains an explicit derivation prohibition and F1
  is classed BR/A, not D. No target anywhere is priced by draw arithmetic. PASS.
- **Parked-vs-moving:** F3/F4 are gated on pass 10's bench existing first; the charter states
  no moving-mid baseline exists rather than inventing one. PASS.
- **70 ns glue:** no target assumes framework-overhead wins; frame targets point at instance
  scale and per-draw state (survey's own wording). PASS.
- **Allocated≠used:** M6 is the target form of this wall; D-01.2 requires the label. PASS.
- **Boot variance:** S2 pins bench scenes/routes; pass 10 owns interleaving rules (walls
  require it; charter defers mechanics, which is scope-correct per R2). PASS.
- **Flag-bit≠predicate:** N1 requires eye-test gates for structural render changes; S2 requires
  bare-default measurement. PASS.
- **GPU-theories-on-CPU-bound:** D-01.5 requires re-measuring boundedness after structural
  change before any GPU-side work. PASS.
- **R2 (scope):** no pack formats, no cache designs, no bench mechanics designed here — all
  handed off with proposed defaults. PASS.
- **R3:** one file written in `docs/reengineering/` + own TRACKING.md row. PASS.
- **R4:** code-behavior claims made directly (shard budget default, sha-verify default, dist
  byte sizes) were read/verified this session with file:line or `ls` evidence; all other
  current-state figures are attributed to their measurement docs, read in full this session.
  PASS.
- **R7:** every target is numeric with class labels; derivations shown inline. PASS.
- **R8:** unsettleable items (moving baselines, T2 ceilings, no-BPTC fallback, bandwidth
  representativeness) are declared in Open questions, not guessed. PASS.

## Open questions

- **Q1 — Is 666 kbps representative?** It is the one documented player-bandwidth figure
  (xubc7 plan line 4). If the real audience is faster, B4's aspirational class could relax;
  needs an owner call. Proposed default: keep 666 kbps binding (targets that survive it
  survive anything plausible).
- **Q2 — Moving-mid frame baseline does not exist** (frame-cost doc §7: the moving rig
  self-noised). F3/F4 cannot be scored until pass 10's fixed-pose bench runs on the 1070.
- **Q3 — SwiftShader/no-BPTC compressed-texture support is unverified.** Whether T2 (and any
  real GPU lacking BPTC) can consume the compressed-only path or needs a retained RGBA8
  decode fallback is a pass-5 decision needing a 5-minute capability probe
  (`EXT_texture_compression_bptc` presence under SwiftShader). I3's "fully broken" stands
  either way; only the fallback's existence is open.
- **Q4 — Net-worker wasm linear memory has never been measured** (08-05 §8 instrument notes:
  the census sums two of three instances). M3 is stated over ALL instances; the third relay
  must be added before M3 can be scored honestly.
- **Q5 — The stall probe (p99 doc) may never have been run on the 1070** — F5/F6's
  attribution mechanism exists in the tree but the record shows no completed run. If its
  buckets misattribute, pass 10 owns the successor instrument.
- **Q6 — T2 heap ceiling (M8) has never been measured as a ceiling**; 1.2 GB is a margin
  guess on an 8 GB earlyoom box and needs one bot-route run to be re-classed from A to BR.
