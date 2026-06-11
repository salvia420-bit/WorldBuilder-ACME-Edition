# W2 / Batch R2 wave — buildbox ultracode dispatch (PROMPT)

Date: 2026-06-11 · Host: **buildbox** (18-core, NO laptop limits) · Model: Fable 5, effort medium
Repo: `~/WorldBuilder-ACME-Edition` (holtburger at `external/holtburger`), start from `origin/master`
(W1/Batch-R1 head `b4e87213` or later — `git pull --ff-only origin master` first).
Survey context: this dir (`ROADMAP.md` §1/§2/§3/§5, `RULINGS.md`, `agents/*.md`). W0+W1 are LANDED
(commits `2f50b269..b4e87213`): the canonical tick spine (`tick_spine.rs`), lifecycle routing,
recv-arm routing, and the A3-D1 DESIGN amendment (`a916d12e`) all exist — anchors in the survey
reports have drifted; grep symbols, don't trust line numbers.

## Mission

Execute ROADMAP **wave W2** (gate: headless): `A4-Q1 · A3-D2 · A2-P1 · A7-R1/R2/R3/R6 · A9-Stage1`.
One commit per item, pushed to **origin master** (salvia420-bit; NEVER `box`/`upstream` remotes).
Everything behavior-changing lands behind a default-off gate; 1070 eye-tests stay Lane-B parked.

## Ground rules (buildbox edition)

1. Full cores are the point: plain `cargo test --workspace -j18`, `wasm-pack build --release` are
   ALLOWED here (no capped-build, no per-package restriction). But cargo locks the shared `target/`
   dir — so only ONE agent may run cargo at a time (the workflow structure below guarantees this).
2. VERIFY THE GAP STILL EXISTS before editing (W0/W1 drift). Read your survey report §4 stage IN
   FULL first, plus ROADMAP §2 seam notes and §3 conflict-matrix row for your files.
3. Default-off gates for behavior changes: const gates in core/world (USE_* pattern) or URL flags in
   lib.rs/JS (+ row in `apps/holtburger-web/docs/url-flags.md`). Pure extractions proven identical
   by tests need no gate. Load-bearing wasm export changes → bump WASM_EXPORT_MANIFEST_VERSION in
   lib.rs AND the JS consumer together (F18-2 rule).
4. Retail truth `~/ac-headers/acclient.c`(+.h); server cross-ref `external/ACE` C#. Dual-citation
   discipline in code comments for behavior constants. No PhatAC/PhatSDK.
5. Commit message prefix `holtburger: `, body cites the survey item id + key citations, ends with
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Stage only files you touched.
   Push origin master; on rejection pull --rebase and re-push.

## Items, in this exact serialized order (conflict matrix: movement chain → position → spatial chain → bridge)

1. **A4-Q1** (`agents/A4-motion-table-queue.md` §4 Q1): the pending-animation queue core — the
   faithful MotionTableManager port (pending_animations, add_to_queue, truncate,
   CheckForCompletedMotions skeleton). Implement per the **A3-D1 DESIGN amendment** (commit
   `a916d12e`, `docs/2026-06-11-unified-movement-pipeline/DESIGN.md` "STAGE 2 AMENDMENT") — the
   queue is specced ONCE there; do not re-spec. Queue-order table tests (Lane A).
2. **A3-D2** (`agents/A3-movement-stack-gap.md` §4 D2, the R2 "D2(a)" slice): the MotionDone/
   exhaustion consumer half that builds on Q1, per the DESIGN amendment. FIFO/exhaustion unit lanes.
3. **A2-P1** (`agents/A2-position-manager-trio.md` §4 P1): interpolation-node queue generalization
   (≤20-node queue, tail dedupe, velocity/snap node types, node_fail_counter>3 → blipto recovery
   shape) generalizing today's single-target force_position_interp. ROADMAP §2: P1 is "anytime";
   keep the A2/A3 seam — do NOT touch MoveTo/sticky (P3 is W5).
4. **A7-R1** then 5. **A7-R2** then 6. **A7-R3** then 7. **A7-R6**
   (`agents/A7-collision-resolution.md` §4, one stage per item, same serialized chain — they share
   spatial/physics.rs+collision.rs): the pure contact-resolution helper functions A6-T1 will
   consume later. Headless unit tests per stage; flags per the report. A6 stages are NOT in scope.
8. **A9-Stage1** (`agents/A9-part-array-setup.md` §4 Stage 1): the wire placement-id plumb —
   server frame_id → SetPlacementFrame analog with retail's default 0x65 (Resting) and fallback 0
   (report §3 row 1: chests/corpses/levers render in Default(0) pose). Touches lib.rs (+ JS
   consumer if the report says so) — manifest bump rule applies if exports change.

## Workflow shape (author this as a Workflow-tool script; ~16 agents)

- **Phase Fix** — the 8 items above, STRICTLY SEQUENTIAL (one git tree, one cargo at a time), one
  agent each. An agent that finds its gap already closed (or unsafe headless) makes NO edits and
  reports skipped+reason; later items must respect earlier skips if they depend on them
  (A3-D2 depends on A4-Q1).
- **Phase TestGate** — ONE agent, the only full-battery run:
  `cargo test --workspace` (full cores), `cargo check -p holtburger-web --target
  wasm32-unknown-unknown`, `wasm-pack build --target web --release` in apps/holtburger-web
  (pkg/ is gitignored — never commit it), `node --check` on every JS file the wave touched.
- **Phase Verify** — parallel adversarial reviewers, one per landed commit, READ-ONLY (no cargo —
  the gate owns builds; git show / file reads / acclient.c cross-reads only). Lenses: report-stage
  fidelity vs the cited retail bodies; default-off byte-identity; native-vs-wasm dual-site
  regression; W0/W1 interaction (esp. tick_spine.rs and the A3-D1 DESIGN amendment); manifest rule.
- **Phase Fixup** — sequential repairs of confirmed issues, re-running only the relevant tests.
- **Final agent** — write `W2-RESULTS.md` into THIS dir (per-item: commit, gate/flag, tests,
  skips, verify verdicts, what's 1070-parked), commit it (`holtburger: W2 wave results`), push.

Acceptance: every landed item green in the TestGate, pushed to origin master, and summarized in
W2-RESULTS.md. The laptop pulls everything back via git — nothing may live only in ~/out or /tmp.
