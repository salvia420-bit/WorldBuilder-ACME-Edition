# T30 — Batch A: 1070 validation-queue file prep: implementation report

Agent: T30. Date: 2026-08-09. Docs-only task: prepare the Batch-A queue file per
pass-10 S10's format. No builds, no browsers, no 1070 contact — execution is
owner-gated (SPEC §5 R-05). Scope: the queue file, this report, the T30 row.

## Shipped

| file | what |
|---|---|
| `docs/reengineering/queue-1070/batch-A-2026-08-09.json` | Batch-A queue, schema `hb-1070-queue-v1` per pass-10 S10 (S10 names the directory `docs/reengineering/queue-1070/`, "created at first use" — this is first use; the task-brief fallback path `queues/` was NOT needed). 10 items, each with URLs+flags, box/mode, checklist/recipe, artifact list, blank verdict/result fields, plus the vistest-preamble session rules inlined and the fleet runbook referenced (not reproduced). |
| `docs/reengineering/impl/task-T30-report.md` | this report |
| IMPLEMENTATION.md T30 row | status → PREPARED (execution owner-gated) |

**Queue contents** (suggested session order in the file):

1. **E1** (eye, GATE-GEOM) — SPEC T30 card. URL pair `?packSource=on&geomBundles=on`
   vs bare; 4 vantages (town overview / street / dungeon / ~100 m LOD band); D-09.5
   checklist (winding, snorm8 shading parity, stipple/two-sided, LOD band) + console
   gate. Carries an explicit prerequisite: **T13 is TODO and `?geomBundles` does not
   exist on HEAD** — the item instructs re-verifying the flag reader at T13's landing.
2. **P-SUBTLE** (confirm), **P-INITTEX**, **P-88MIB**, **P-ASSEMBLE**, **P-LIGHTBAKE**
   — SPEC T30 card / pass-10 S6 probe definitions, each with a concrete inline recipe
   (no probe scripts exist on HEAD; recorded per-item), instruments named, expects
   fields per S10. P-ASSEMBLE carries the same T13 prerequisite (no `assemble_*`
   exports in pkg/holtburger_web.d.ts on HEAD). P-LIGHTBAKE names the HEAD bake path
   (lib.rs:20953, :21252–21274) and requires labeling whether decode-total or isolated
   light-bake was measured.
3. **BOOT-666-SHELL** (T11 handoff, queued per task directive) — index.html vs
   index-bundled.html comparative arms, same bot flags, cold/warm × bundled/unbundled,
   CDP network log classified by test_build_shell.mjs part-P5's recipe, RESULTS-v2.
   The item records the **orchestrator D4 decision**: plugin dynamic-import lane
   ACCEPTED as a per-file class for v1; the ~95 arms-invariant plugin/manifest
   requests get RECORDED in the B2 ledger, not fixed. Also carries T11's D5
   (query-fork singleton collapse) as a watch item and the shell rebuild-staleness
   prerequisite. Doubles as T11's deferred bundled-arm in-world 0-console-errors floor.
4. **TEXWORKER-TAIL** + **TEXWORKER-BOOTWARM** (T14 handoff — its Handoffs section
   names these "1070 batch (T30-class)", so they are queued): `?texWorkers=on` vs `=0`
   TAIL-ULTRA transcode-bucket arms with the armed stall probe (noted as partial
   instrument validation per D-10.5 — first armed 1070 probe completion in the
   record), and the warm-boot `maxQueueDepth` read (DT-16 / pass-05 Q4).
5. **MOVE-FIX-BASELINE** (SPEC T30 card "+ MOVE-FIX first baseline if cadence
   allows"; H-10.2 says Batch A or B) — marked `cadenceOptional`, last in order,
   verified moving-bench invocation, PC-3/PR-10/PR-13 discipline in the item.

## Spec conformance

SPEC §3 T30: *"Batch A: E1 + probes P-SUBTLE (confirm), P-INITTEX, P-88MIB,
P-ASSEMBLE, P-LIGHTBAKE (+ MOVE-FIX first baseline run if cadence allows). All items
prepared as queue-file entries (URL pairs, vantages, checklists); off-screen/headless;
verdicts written back to the queue file."*

- **E1 + all five probes queued** — MET (items 1–6 above; format per S10: URL pairs,
  vantages with tele+cam, checklists, artifacts, verdict fields blank).
- **MOVE-FIX first baseline** — MET as a cadence-optional item per the card's own
  conditional.
- **Off-screen/headless + session rules** — MET: vistest-preamble-v1 inlined
  (off-screen window position, --mute-audio, CDP :9333 attach, --user-data-dir-only
  cleanup, never browser.close(), ?nosw=1 everywhere, fresh profile per bench arm,
  __bootState ready|in-world, terrainBakedLbs plateau), fleet runbook referenced as
  the binding first read without reproducing it.
- **Verdicts written back to the queue file** — MET structurally: every item carries a
  null `verdict`/`result` field; the preamble states the write-back contract + the
  url-flags §0 echo for eye verdicts (pass-9 S5.4) and the pass-10 Q6 authority split.
- **Execution** — NOT PERFORMED, by design: status is PREPARED; nothing requiring the
  1070 is marked done.

## Deviations

- **None against pass-10 S10.** The task brief offered
  `docs/reengineering/queues/batch-A-2026-08-09.md` as a fallback location "if
  pass-10 does not name a directory" — pass-10 S10 DOES name one
  (`docs/reengineering/queue-1070/batch-<id>-<date>.json`, "created at first use,
  not now"; SPEC §1.7 confirms "1070 queue = JSON batch files (`queue-1070/`)"), so
  the named location and JSON format were used and the fallback was not.
- **Recorded honesty notes (not deviations):** (a) S10's example uses JSONC comments;
  the file is strict JSON (machine-joinable, parses with `json.load`) with the
  comment content carried in named fields (`sessionRulesInline`, `context`, `notes`).
  (b) Probe scripts named in S10's example (`harness/probes/*.mjs`) do not exist on
  HEAD; items say so and carry executable inline recipes instead of fabricated paths.
  (c) Two items (E1, P-ASSEMBLE) are structurally blocked on T13 (TODO) — queued with
  explicit prerequisites rather than omitted, since T30 gates T13's promotion (SPEC
  §4) and the batch is prepared in advance by design.
- **Memory-trap correction applied (I4):** the auto-memory autologin recipe includes
  `kickDance=1` — that flag does not exist on HEAD (0 hits in index.html/scene3d;
  the real knob is `kickWaitMs`, url-flags.md:571). Queue URLs use only read-verified
  flags: `nosw` (index.html:1812), `autoLogin/account/password/autoSpawn`
  (index.html:6027/11123), `agent` (index.html:556), `nullRender`/`renderOnDemand`/
  `netDrainHz` (url-flags rows), `packSource` (pack_fetch_controller.js:62),
  `texWorkers` (xu7_textures.js:657–675, `=0` explicit OFF), `geomBundles`
  (does-not-exist, flagged as such).

## Tests run

Docs-only task — no builds or browsers (hard constraint). Verification performed:

```
python3 json.load on the queue file        valid JSON, 10 items
I4 read-verification sweep (this session, HEAD 05908db4):
  pass-10 S10 format + S6 probe defs + S2 PC classes + D-10.8   read in full
  pass-09 D-09.5 (E1 row, batching), SPEC §3 T30 card + §1.7 + §5 eye register
  T10/T11/T12/T14/T21 report handoff sections
  flags: url-flags.md rows + *Enabled() readers (packSource :62, texWorkers :657,
         frameWork frame_work.js:130 [not queued], nosw/agent/autoLogin readers)
  surfaces: __hbFetch (pack_fetch_controller.js:817), __texWorkerStats
         (xu7_textures.js:729, maxQueueDepth :209/:356), __stallArm/__stallReport
         (stall_probe.js:102/104, texUpload group :181/:285/:432), __bootState
         (index.html:6033), __sessionHandle (index.html:1616), terrainBakedLbs
         (scene3d/index.js:3469)
  harness: moving-bench.mjs args (:41–54), test_build_shell.mjs present,
         harness/lib/report.mjs + console_allowlist.mjs present
  absences confirmed: kickDance (0 hits), geomBundles (no row/reader),
         assemble_* exports (no d.ts hits); serve.py port 8765 (:33/:736),
         shell/ + index-bundled.html present as gitignored build output
  admin cmds: @telepoi (AdminCommands.cs:875) / @teledungeon
         (DeveloperCommands.cs:2068) via memory/ace-live.md (read-only)
```

## Handoffs & risks

- **Owner (batch execution):** the file's `suggestedOrder` front-loads the
  T13-independent items — if T13 has not landed by session time, E1 + P-ASSEMBLE
  slip to Batch B (quantized-promotion rule, D-09.5) and the rest of the batch is
  still worth a session (P-SUBTLE/P-INITTEX/P-88MIB/P-LIGHTBAKE are
  stage-independent R-12 closers; the shell + texWorker arms are already runnable).
- **Pre-session re-verification duty (recorded in the items):** `?geomBundles`
  spelling/reader and the `assemble_*` export names against T13's landing commit;
  the serving origin substitution per the fleet runbook; `@telepoi list` before
  trusting named vantages.
- **BOOT-666-SHELL needs a rebuilt shell** on the serving tree (gitignored artifact
  — T11's staleness trap, restated in the item).
- **TEXWORKER-TAIL doubles as the stall probe's first 1070 completion** — if the
  arithmetic identity check fails there, F5/F6 scoring in later batches inherits an
  instrument problem (D-10.5); flag it to the orchestrator immediately.
- **Not queued, with reasons:** T12's BOOT-666 packs-vs-legacy + BOOT-WARM
  comparative arms (structurally blocked on the full-world DUAL dist — buildbox
  bake job, and they are CI/T2-class per S11, not 1070 items; T12's handoff names
  them "1070/T3 batch items" generically, not Batch A), CROWD-BURST (needs a
  crowded live-ACE session, not named to a batch), T2-BOT ON+OFF (CI-class),
  T21's BENCH-CROSS-SETTLE + GATE-PHASE census session (named "1070 batch cadence"
  but tied to ST8's gate, not Batch A; MOVE-FIX already carries this batch's
  cadence-optional slot per H-10.2). The orchestrator may promote any of these into
  a later batch file.
- **Unrelated dirty state:** untracked orchestrator/HUD files and sibling-agent
  edits left untouched; only the three T30 files were deliberately staged
  (IMPLEMENTATION.md staged row-only via `git hash-object` + `update-index
  --cacheinfo` so the sibling's on-disk T31/T32 row edits were NOT committed
  by T30).
- **Commit-race disclosure (I6 honesty):** commit `08bfdff5` unintentionally
  swept in 4 sibling files (impl/task-T31-report.md, impl/task-T32-report.md,
  queue-1070/batch-B-2026-08-09.json, batch-C-2026-08-09.json) — the T31/T32
  agent ran `git add` into the shared index between T30's staging check and
  commit. Content is theirs and unmodified; the sibling's own commit `548ffcf7`
  followed immediately with their IMPLEMENTATION.md rows, so history is
  consistent and nothing was lost — only commit attribution mixed. No rewrite
  attempted (their commit already built on mine).
