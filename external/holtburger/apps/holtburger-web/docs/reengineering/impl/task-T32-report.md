# Task T32 report — Batch C 1070 validation queue (prep only)

## Shipped

| file | what | commit |
|---|---|---|
| `docs/reengineering/queue-1070/batch-C-2026-08-09.json` | Batch-C queue file (schema `hb-1070-queue-v1`, pass-10 S10 format): eye items E5, E6 + the MOVE-FIX-ST9 bench rider (pass-10's own S10 example item) + a GATE-GRID bench-set placeholder; normative D-10.8 session preamble restated inline; flags/diag surfaces read-verified against HEAD | (this commit) |
| `docs/reengineering/impl/task-T32-report.md` | this report | (this commit) |
| `IMPLEMENTATION.md` | T32 row only | (this commit) |

Status is **queue PREPARED** — nothing executed; the batch is owner-gated. No 1070
contact, no browsers, no builds this task.

## Spec conformance

SPEC §3 **T32 — Batch C** *(S)*: "E5 + E6. All items prepared as queue-file entries
(URL pairs, vantages, checklists); off-screen/headless; verdicts written back to the
queue file."

- **E5 queued** — MET (as prep). Written against the LANDED `?slotGrid` arm
  (T20 stages 1–3: 432e8791 grid core, 4a07e021 PackStore Rust half, b98d315c
  adapter + assert-only LRU — all verified in `git log` at HEAD), with prerequisite
  **"T20 stage-4 report green"** carried on both the item and the batch preamble
  (stage 4 = the live arm, queued this session). URL pair
  `?packSource=on&slotGrid=on` vs bare legacy; the slotGrid row's D-12.4 requirement
  (`?packSource` mandatory or the grid disarms loudly) is restated in `urlNotes`.
  Vantages map the register row exactly: shift-boundary walk (≥ 6 LBs = ≥ 3 shifts at
  the ±1-anchor-per-2-LB rule), teleport-arrival completeness sweep at Nanto, sealed-hub
  enter/exit at Town Network. Checklist adds the GATE-GRID zero-tolerance diag reads
  (`__diag.residency()` pinLeaks/shiftMismatches/slotDesyncs = 0;
  `__landblockLru.getStats().gridLruDivergence === 0`; `r4Engagements === 0` on a
  default-pressure run) — all read-verified (index.js:6527–6531, the url-flags
  slotGrid row, residency_grid.js).
- **E6 queued** — MET (as prep). Register row mapped to 4 vantages: town pass-membership
  (known translucents STILL translucent — the ClipMap item itself), depth-bias floors,
  the shadowed-town receiveShadow vantage (pass-10 debt row 38), Town Network for
  dense-hub membership + envcell baked-light parity. ON-arm URL carries the full
  F-11.3 requirement chain (`packSource, geomBundles, texCompressedOnly, slotGrid,
  frameWork, drawPools`); prerequisite T22 landed.
- **Off-screen/headless + verdict write-back** — MET (as prep): same normative
  D-10.8 preamble as Batch B; verdict fields null in-file; url-flags §0 write-back
  stated.

Execution: **DEFERRED-TO-BATCH by construction** (owner-gated; the charge is prep).

## Deviations

none — with three prep-precedes-implementation notes (recorded, not drift):

- E6's `?drawPools`, `?geomBundles`, `?texCompressedOnly` are SPEC-named but have NO
  readers at HEAD 2026-08-09 (T22/T13/T15 TODO; verified by rg over scene3d/,
  index.html, src/lib.rs — the only hit is a T22-scope comment at frame_work.js:22).
  The item and batch prerequisites say so and require re-verifying all three readers +
  spellings at go-time. Inherent to the queue order (T32 gates T20/T22 promotion; the
  batch runs after they land).
- E5's prerequisite is a REPORT (T20 stage-4 green), not a commit — stage 4 was
  in-flight when this queue was prepared; the item must not run before it.
- `GATE-GRID-BENCH-SET` rider ships `cmd: null` (harness entry points are T20
  stage-4 / orchestrator fills; a null cmd is marked NOT executable).
  `MOVE-FIX-ST9`'s cmd cites the real `harness/moving-bench.mjs` (exists at HEAD)
  with anchor/pose-table args deferred to the harness header at go-time.

T12's handoff names ST7 CONSUMPTION seams (quarantine state, `notePlayerLandblock`,
pack leases, PackStore budgets) — implementation inputs to T20, not batch items;
nothing in the T12/T14 handoffs defers an item to Batch C by name (their 1070 riders
are "T30-class"/next-batch = Batch A cadence). T11's D5 eye item was assigned to
Batch B (see task-T31-report.md deviations).

## Tests run

Docs-only task; no builds, no browsers. Read-verification (I4), all against HEAD this
session:

- `python3 json.load` on batch-C-2026-08-09.json — parse clean, items E5/E6/
  MOVE-FIX-ST9/GATE-GRID-BENCH-SET.
- `slotGrid` reader: residency_grid.js:67 `slotGridEnabled`, EXACT-MATCH on/1/true/yes;
  disarm-without-packSource behavior + assert-only LRU + integrity counters from the
  url-flags slotGrid row (2026-08-09) and residency_grid.js.
- `packSource` reader: pack_fetch_controller.js:62; `frameWork` reader:
  scene3d/frame_work.js (`frameWorkEnabled`, url-flags row 647).
- `__diag.residency()` install site: scene3d/index.js:6527–6531.
- T20 commits present at HEAD: `git log --oneline` shows 432e8791 / 4a07e021 /
  b98d315c with the T20 subjects quoted in the queue file.
- `@telepoi n` / `Holtburg` / `Town Network` + `__cam.player` + login contract params:
  same verifications as T31 (harness/census-class.mjs, harness/moving-bench.mjs,
  camera.js:417/1220, index.html bootParams); `kickDance` excluded (removed s13,
  no reader — url-flags.md:566).
- moving-bench.mjs exists at HEAD (harness/moving-bench.mjs; PC-3 fixed-pose
  discipline per pass-10).

## Handoffs & risks

- **T20 stage-4 agent:** your report is E5's gate-open signal; also fill/confirm the
  `GATE-GRID-BENCH-SET` cmd fields and re-check the E5 checklist diag names against
  what stage 4 actually wires.
- **T22 agent:** re-verify E6's ON-arm flag spellings against your url-flags rows;
  add the class-census diag artifact name if you land one
  (`classesCreatedPostBoot`/pools count).
- **Owner session (redmi):** batch-C-2026-08-09.json is self-contained; verdicts back
  into the file + url-flags §0. The E5 pull-in option (to Batch B, unchanged) is
  recorded in both files per D-09.5.
- **Risk:** E6's shadowed-town comparison needs the SAME time-of-day both arms — the
  vantage note says so; ignoring it makes the receiveShadow read unjudgeable.
- Sibling T30 (batch A) in flight concurrently; this task touched only its own three
  files.
