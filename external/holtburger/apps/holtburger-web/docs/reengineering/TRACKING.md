# PIPELINE RE-ENGINEERING SPEC — TRACKING DOC (BINDING PROTOCOL)

<!-- ============================================================ -->
<!-- HEADER — NORMATIVE. EVERY AGENT WORKING A PASS IS BOUND BY IT. -->
<!-- ============================================================ -->

## PROTOCOL HEADER — READ FIRST, ADHERE COMPLETELY

This document governs a 12-pass effort to produce the **architecture and implementation
spec** for re-engineering the holtburger-web rendering/streaming pipeline (bake → wire →
Rust/wasm → JS → three.js → frame). One agent executes one pass, alone, with fresh context.
An orchestrator session enforces this header; agents do not modify it.

**RULES — violations invalidate the pass:**

R1. **Read order is mandatory.** Before any other work: (1) this file, top to bottom;
    (2) `../2026-08-08-pipeline-reengineering-survey.md` (the grounding survey — the
    five invariants I1–I5, the two workstreams W1/W2, and the walls ledger in its §6);
    (3) every prior pass output listed COMPLETE in the table below, in pass order.
    A pass that contradicts a prior pass's recorded decision without an explicit
    "SUPERSEDES pass-NN §X because <evidence>" block is invalid.

R2. **Scope is the assigned pass only.** Do not do the next pass's work. Where your pass
    genuinely needs a decision that belongs to a later pass, record it under
    "HANDOFFS TO LATER PASSES" with a proposed default, and move on.

R3. **No source-tree changes.** Passes produce spec documents only. The only writable
    location is this folder (`docs/reengineering/`). Never edit code, never edit other
    docs, never edit the survey. (Updating your own row in the table below is required,
    see R6.)

R4. **Code claims must be read-verified.** Any statement about current code behavior must
    cite `file:line` from a file you opened in THIS session. Prior-session citations,
    grep-only hits, and memory are hypotheses. Known traps: the wasm crate is
    `apps/holtburger-web/src/lib.rs` (`crates/holtburger-web/` does NOT exist);
    `pkg/` is gitignored build output; URL flags share the `flagIsOff` predicate —
    trust `*Enabled()` functions, not doc comments; `dist` is a symlink to
    `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`; never pass `-rln` to rg.

R5. **The walls are settled law.** The dead ends in survey §6 (scale confusion,
    draws-removed×µs/draw non-prediction, parked-vs-moving, 70 ns glue, allocated≠used,
    boot variance, flag-bit≠predicate, GPU theories on a CPU-bound frame) are NOT to be
    re-derived, re-tested, or contradicted without new measured evidence. Cite them by
    name when a design choice is shaped by one.

R6. **Output contract.** Exactly one file: `pass-NN-<slug>.md` in this folder (NN =
    zero-padded pass number, slug from the table). Required sections, in order:
    `## Inputs read` (files + line ranges actually opened) · `## Decisions` (numbered
    D-NN.1, D-NN.2, … — each with rationale and the alternatives rejected) ·
    `## Spec` (the pass's substantive content) · `## Handoffs to later passes` ·
    `## Self-check` (each decision checked against the walls ledger and R1–R8, stated
    pass/fail) · `## Open questions`. Then update YOUR ROW ONLY in the status table:
    status → `DONE`, date, output filename, ≤3-line summary. Touch nothing else in
    this file.

R7. **Decisions must be implementable.** Every "Decisions" entry names concrete formats,
    data structures, module boundaries, or numeric budgets — not aspirations. Numbers
    carry their scale and source (measured / derived / assumed-pending-measurement).

R8. **Honesty over completeness.** If the pass cannot settle something (missing
    measurement, needs the 1070, needs an owner call), say so explicitly in Open
    questions rather than papering over it. An honest gap is compliant; a confident
    guess is not.

**ORCHESTRATOR DUTIES** (the session driving the passes): launch exactly one agent per
pass, sequentially; verify each output file exists and satisfies R6 before advancing;
keep the user advised of the current pass number; never perform pass work itself.

<!-- ============================================================ -->
<!-- END NORMATIVE HEADER                                          -->
<!-- ============================================================ -->

## Mission (context for every pass)

The current pipeline is at the local optimum of its shape; five invariants (survey §4)
carry the remaining costs. Targets, all metrics: FPS mean AND tail, cold-boot download,
per-crossing download, heap/VRAM residency. Strategy: W1 (bake owns the world — closure
packs, pre-triangulated indexed geometry, progressive textures) and W2 (client owns
residency — slot grid, refcounted Rust caches, persistent draw pools, compressed-only
textures). The spec must be additive/migratable — the live client keeps working
throughout (survey §5 sequencing note).

## Pass plan and status

| # | Slug | Charge | Status | Date | Output | Summary |
|---|------|--------|--------|------|--------|---------|
| 1 | requirements-charter | Metric targets & budgets (boot bytes/RTTs, crossing bytes, p50/p99 frame, heap/VRAM ceilings) per platform tier (1070 / SwiftShader laptop / 666 kbps line); which invariants I1–I5 are broken vs kept; non-goals; acceptance criteria the final spec must meet. | DONE | 2026-08-08 | pass-01-requirements-charter.md | 3 tiers (1070 perf / SwiftShader functional / 666 kbps wire); 24 budget IDs B1–B5, C1–C5, F1–F6, M1–M9 (headline: boot ≤12 MB/≤64 req vs ~110 MB/~1,700; parked mid p50 ≤16.7 ms vs 20.2; heap ≤1.6 GB vs 2.7 peak), each classed M/D/BR/A. I1,I3,I4 broken fully; I2,I5 broken with kept residue (substitution models, entities). 8 non-goals; 7 acceptance criteria A1–A7 for pass 12; 6 open questions. |
| 2 | world-pack-format | W1 core: per-landblock/tile closure pack binary format — record layout, spatial index, shared-asset packs, content addressing, dedup strategy, versioning/patching. Uses real dist byte statistics (survey §2, downward-map numbers). | DONE | 2026-08-08 | pass-02-world-pack-format.md | HBP1 sectioned packs: 2×2-LB tiles + interior/shared/preview/env kinds; ~0.5 MB HBSI1 index replaces 16.9 MB catalogs; pack-level sha16 CAS (record-level dedup measured 0.00 MB). Measured full-world closure: 194.7× inline dup ⇒ K=4 inline + regional/commons tiers. C-budgets met with margin; B1 restated 18 MB now, ≤12 MB conditional on pass-5 128² boot preview tier (ring previews measured radius-invariant, commons-dominated). |
| 3 | wire-and-fetch | Manifest/index scheme replacing catalogs; fetch strategy (granularity, ranges, priorities, prefetch radius); integrity model replacing per-shard sha256; CDN/cache headers; progressive delivery ordering (preview-first); offline/SW story. | DONE | 2026-08-08 | pass-03-wire-and-fetch.md | Single main-thread PackFetchController (4 lanes U/B/R/T, cap 12+4 urgent, promotion not bypass) replaces the 24/8 two-instance split; whole-pack fetch, hash-on-receipt via crypto.subtle off-thread (per-shard sha256 deleted); manifest=only mutable URL, sessions pin the index; immutable+no-transform CAS headers; SW v3 caches CAS-only (bake-identity gate deleted structurally). B2≈54 ✓, B3=3(4) ✓, B5=1 req ✓, C1≈9 ✓, C5 ≥4× margin with 1-tile directional lookahead. |
| 4 | geometry-spec | Offline triangulation bake: indexed buffer layouts, per-model vs per-pack geometry, LOD policy (if any), the wasm→JS transfer contract (transferables, zero-copy), what remains runtime-decoded (equipment substitutions) and its path. | DONE | 2026-08-08 | pass-04-geometry-spec.md | HBG1 indexed payloads (24 B/vert, u16 idx, subset ranges replace per-tri metadata): measured R=1.13 verts/tri over 1,131 real GfxObjs ⇒ 3.02× smaller than the de-indexed boundary, 0.37× record bytes — pass 2 budgets stand (C2 margin 2.7→2.1×). Per-part storage + setup/env directories; terrain stays runtime (baked ≈265× its 252 B record); collision stays record-based (render-only bake). Exit = one transferable ArrayBuffer + descriptor (handles/free()/deep-copies deleted); did_degrade LOD resolved at bake (walk needs the missing degrade edge); equipment keeps today's path, substitution cache designed but dormant pending measurement. |
| 5 | texture-spec | Compressed-only runtime path: tier policy (preview/full/lossy decision incl. the P3 q75-vs-rdo call as a spec'd default), transcode placement (worker/offline/wire-BC7 trade), atlas & mip policy (fixing level-0-only), CPU-mirror elimination, VRAM budget mechanics. | DONE | 2026-08-08 | pass-05-texture-spec.md | XUBC7 = sole full-tier codec (0.623× measured), previews raw HBC7 capped 128² (corpus 157.5→47.7 MB), tex-bc7 wire-retired; transcode + terrain assembly + NRA derive move to one dedicated worker (FIFO = fallback). B1 restated 11.6/12.6 MB WITH terrain t128 slice (SUPERSEDES pass-2 omission); P3 default = q75 behind the pass-9 eye-gate, B4 base-slip corrected (q75 ⇒ ~63 MB, ≤45 only via rdo arm). Arrays get full chains+aniso; __bc7Pending fixed by preview-commit + atlasRefeed re-home; mirrors freed via source-keyed rehydrate v3; per-class VRAM budgets ≈610 MiB with evict-as-demote-to-preview. |
| 6 | residency-architecture | W2 core: slot-grid design (dims, shift semantics, edge churn), refcounted resource caches in Rust (keys, budgets, UseTime floors), eviction/park/unpark, single-vs-dual wasm instance decision, memory census integration. | DONE | 2026-08-08 | pass-06-residency-architecture.md | Tile-granular 6×6 slot grid (ring-min anchor, shift-in-place, 3 tile packs/LB-column) as sole JS positional authority; Rust holds refcounted budgeted stores (PackStore 96 MiB pinned+30 s floor, sections 32, park pool ≤40 tiles/128 MiB) — floors NEVER zeroed, count-governor deleted, ladder R1–R4 (demote→release→shrink→5 s-floor emergency). Dual wasm kept but worker de-stated (M3 split 384/96/32); census: every payload row budgeted, −1 needs stated bound, net-worker relay required. Read-verified correction: the 07-11 grid WAS partially built (fixedGrid default-ON, terrain radius-1) — adopted and generalized, not restarted. |
| 7 | scene-and-draw-architecture | Persistent material-class draw pools over the resident set; material key unification (target the 71% switch rate); node-count design (O(pools) scene graph); how entities/animated scenery/envcells/terrain integrate; interaction with the slot grid. | DONE | 2026-08-08 | pass-07-scene-and-draw-architecture.md | Persistent BatchedMesh pools per (world-sector 2×2-tile, material-class); unified class key = _stateKeyOf ∪ _patchSetCacheKey ∪ side/dims/shadow (row-31 clones distinct by construction); opaque pools drop pOFC+sort ⇒ three's early-out kills the 5.72 ms rebuild term for all cameras — statBatchMemo family OBSOLETE; atlas subsumed, terrain/anim-scenery kept, entities excluded. Feed/release = event-driven slot-transition table (park = setVisibleAt, GPU-free); scene graph O(pools)+entities with every node-walker re-homed; class set CLOSED at boot ⇒ p99 link-storm population deleted (pass 8 prewarms the census). All F-claims term-denominated; class cardinality is the flagged [A]. |
| 8 | frame-loop-and-scheduling | The frame's phase order; worker topology & message contracts; upload scheduling (GPU upload budgets, when texSubImage/bufferData may run); stall-prevention integration (shader prewarm incl. CSM depth variants, transcode budgets); tail-frame (p99) design targets. | DONE | 2026-08-08 | pass-08-frame-loop-and-scheduling.md | Frame = SIM→RESIDENCY→WORLD-TICKS(RP3 kept)→RENDER→post-render STREAM SLOT: one FrameWorkScheduler (6 ms global, W1–W6, always-run-one, BOOT/TELEPORT/EMERGENCY modes) replaces the additive 6 ms family + inline tickEviction; uploads ONLY from the slot via read-verified r184 `initTexture` (compressed-array capable), buffers capped at feed. 5-worker census with closed message vocabularies (netWorker read-verified default-OFF — precision on pass 6's M3 row); CSM depth variants warmed by an off-screen shadow RENDER over per-class BatchedMesh proxies (compile can't reach them — verified). Tail ledger: 0 links steady walk (F5), largest indivisible item = 88 MiB terrain staging (once/tier, splittable 44/44, unmeasured → Q3); syncTickHop stays (physics outside I1–I5 scope). |
| 9 | migration-plan | Additive rollout: dual-dist coexistence, flag strategy & defaults policy (house rules: validated gates ship default-ON with escape), fallback paths, eye-test gates for structural render changes, kill criteria per stage, doc-propagation duties (wall: verdicts must reach the files agents read). | DONE | 2026-08-08 | pass-09-migration-plan.md | 10 stages ST1–ST10 in two parallel tracks, each one master flag whose OFF arm is today's code (kill = one-flag revert; K1–K4 revert classes, every kill names scale+protocol). Dual-dist = ONE tree + additive layers; manifest stays version:2 with additive v3 fields routed by field presence (SUPERSEDES pass-2 S7 sentinel timing — read-verified UnsupportedVersion on version≠1,2). 21-row inherited-handoff inventory all discharged; 8 eye-gate items in 3 batched 1070 sessions; same-day doc-propagation checklists + 11-row stale-wording register. |
| 10 | instrumentation-and-validation | Metrics & diagnostics spec (__diag surfaces, mem census, stall probe successors); the benchmark protocol (fixed-pose bench, interleaved boot arms, ABAB rules, scale labeling); per-metric acceptance tests wired to Pass 1 targets; 1070 validation queue format. | DONE | 2026-08-08 | pass-10-instrumentation-and-validation.md | Walls → 14 protocol rules PR-1–14 + 8 protocol classes with measured effect-size floors (in-session ≥0.4 ms, boot arms ≥1.5 ms, cross-boot = nothing; pixel-diffs inadmissible at 16.9% floor); `@scale`-tagged RESULTS v2 + diag registry (counters-vs-levels, same-name successors); 13-bench suite covers all 24 budget IDs (S7) + 54-row debt→test map (S8); gates GATE-BAKE…GATE-RETIRE with numeric kill floors + console-error harness (H-09.1/H-09.2c discharged); 1070 queue JSON v1; stall probe kept, vector extended (wasmMemMB grow evidence). |
| 11 | adversarial-review | Attack passes 1–10 as a hostile reviewer armed with the walls ledger and the attempt history: contradictions, unmeasured load-bearing assumptions, scale errors, migration holes, spec-vs-code impossibilities (read-verify). Output: numbered findings + required fixes, severity-ranked. | DONE | 2026-08-08 | pass-11-adversarial-review.md | 19 findings: 2 BLOCKER (B4 ledger omits the 81 MB bare-default t1024 terrain tier — real q75 ≈144 MB; app shell = ~270 unbundled no-cache module requests ⇒ B2 "~10 code" off ~27×, B5 "1 req ✓" false), 5 MAJOR (missing drawPools⇒packSource/geomBundles/texCompressedOnly edges + revert cascade; ST7 grid→legacy adapter designed nowhere; walk-widening unowned yet load-bearing for ST10; t128 slice ≈30 unaccounted boot requests; no budget×stage binding map), 12 MINOR. Walls: zero violations. Core mechanisms read-verified TRUE (three r184 early-out/setVisibleAt/initTexture, transfer contract, manifest routing); crypto.subtle premise inverted (1070 loads via loopback = secure context). Verdict: sound for pass 12 assembly iff both blockers resolved in SPEC.md. |
| 12 | final-assembly | Integrate pass 11's required fixes; produce `SPEC.md` in this folder — the unified architecture + implementation spec with build order, task breakdown, dependency graph between tasks, and per-task acceptance criteria. Marks any residual open questions as tracked risks. | DONE | 2026-08-08 | pass-12-final-assembly.md + SPEC.md | Both blockers resolved with SUPERSEDES: B4 split B4a ≤65 MB gated (terrain converges at t128; t1024 post-converged non-budgeted, default-ON) + B4b ≈144 MB reported; app shell gets a new ST-SHELL bundling stage (esbuild, content-hashed CAS shell ⇒ B2 ≈52 ✓ / B5 ≈2 ✓, fallback pre-specified). All 5 MAJORs applied (flag edges + kill cascade, ST7-requires-packSource + producer-adapter spec'd with gridLruDivergence=0, walk-widening owned by ST1/ST2, t128 = 1 CAS file/channel, budget×stage map for all 25 IDs); 9 minors inline, 3 as tracked risks. SPEC.md: 17 tasks / 11 stages, 16-row risk register, 19-finding disposition table, doc-propagation register incl. survey I4/fixedGrid corrections. |

## Log (orchestrator only)

- 2026-08-08: Folder created, protocol written. Pass 1 launching.
- 2026-08-08: Pass 12 complete — SPEC.md delivered; both pass-11 blockers resolved in-spec (B4a/B4b split with charter SUPERSEDES; ST-SHELL bundling stage); all majors/minors dispositioned. **12-pass effort COMPLETE.** SPEC.md is authoritative; pass files are design history.
