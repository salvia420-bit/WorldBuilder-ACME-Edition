# Task T31 report — Batch B 1070 validation queue (prep only)

## Shipped

| file | what | commit |
|---|---|---|
| `docs/reengineering/queue-1070/batch-B-2026-08-09.json` | Batch-B queue file (schema `hb-1070-queue-v1`, pass-10 S10 format): eye items E2, E3, E4 + the T11-D5 bundled-shell eye item + 2 GATE-TEX bench-rider placeholders; normative session preamble (D-10.8) restated inline; every URL/flag/diag surface read-verified against HEAD | (this commit) |
| `docs/reengineering/impl/task-T31-report.md` | this report | (this commit) |
| `IMPLEMENTATION.md` | T31 row only | (this commit) |

Status is **queue PREPARED** — nothing here is executed; the batch is owner-gated
(SPEC §3 validation milestones, R-05). No 1070 contact, no browsers, no builds were
made this task.

## Spec conformance

SPEC §3 **T31 — Batch B** *(S)*: "E2 + E3 + E4 (+ E5 if ST7 ready). All items
prepared as queue-file entries (URL pairs, vantages, checklists); off-screen/headless;
verdicts written back to the queue file."

- **E2 queued** — MET (as prep). URL pair (`?packSource=on&texWorkers=on&texCompressedOnly=on`
  vs bare legacy), 3 vantages (boot sequence, Nanto props for the 79%-held-out class,
  wide terrain for the t128→t1024 seam), 5-line checklist verbatim from the pass-9
  D-09.5 register row, verdict field null.
- **E3 queued** — MET (as prep). Side-by-side same-pose stone/wood/metal vantages,
  no-flattening checklist per register row, verdict null.
- **E4 queued** — MET (as prep). Owner **redmi** named on the item; sheets path
  `/mnt/wbterminal2/xubc7-proto/results/sheets/` + in-world painted/emblem pass; the
  TWO in-writing decisions carried with SPEC §3 T16's exact framing: (1) the q75
  verdict (DIRTY ⇒ stay lossless, classifier-mixed is the follow-up), (2) the B4a
  election (§0.2.1: accept default / t1024-in-converged with B4a restated ≈ 144 /
  rdo arm ≈ 42). Decision slots null for the owner.
- **E5 if ST7 ready** — NOT pulled in: ST7 stage 4 (live arm) was still queued at prep
  time. Both queue files carry the D-09.5 pull-in rule (E5 may move from batch-C to
  the Batch-B session UNCHANGED if T20 stage-4 goes green first).
- **Off-screen/headless + verdict write-back** — MET (as prep): the D-10.8 session
  preamble is restated as `sessionRulesText` (off-screen `--window-position`,
  `--mute-audio`, CDP :9333, `--user-data-dir` as the only cleanup handle, never
  `browser.close()`, `?nosw=1` everywhere, three-forward tunnel line, fresh
  user-data-dir per BENCH arm / shared session for eye items, `__bootState`
  ready|in-world gate, terrainBakedLbs plateau); verdict/decision fields are in-file.

Execution of the batch itself: **DEFERRED-TO-BATCH by construction** (owner-gated;
that is this task's charge, not a gap).

## Deviations

- **DEVIATION: pass-10 (no batch assignment for T11's D5) because** impl/task-T11-report.md
  D5 (query-forked duplicate module instances collapse on the bundled arm — statics.js /
  buildings.js / scene3d-index loaded twice on HEAD via `?v=phase7-par` forks, merged to
  one instance by esbuild) is "flagged for the E-item eye pass" but postdates pass-10,
  which therefore assigns it no batch. Queued in **Batch B** as item `D5-SHELL-EYE` per
  the T31 task direction, marked non-gate (it validates the shell repoint / B2 ledger,
  not a stage gate).
- **Prep-precedes-implementation note (not a drift):** E2/E3 URLs carry
  `?texCompressedOnly`, which is SPEC-named but has NO reader at HEAD 2026-08-09
  (T15 is TODO; verified: zero hits in scene3d/, index.html, src/lib.rs). The items and
  the batch prerequisites say so explicitly and require re-verifying the reader + URL
  spelling against T15's url-flags row at go-time. This is inherent to the queue order
  (T31 gates T15's promotion; the batch runs after T15 lands).
- The two GATE-TEX 1070 bench riders (MEM-ROUTE-ST5, ULTRA-SOAK-30-ST5) are queued
  with `cmd: null` — the harness entry points are T15's to land; a null cmd is marked
  NOT executable. Piggybacking benches on an eye batch is pass-9 sanctioned (open
  item 5) and pass-10's own S10 example includes a bench item.
- Queue-file location: pass-10 S10/D-10.8 names
  `docs/reengineering/queue-1070/batch-<id>-<yyyy-mm-dd>.json` — used as written; the
  task brief's fallback location was NOT needed.

## Tests run

Docs-only task; no builds, no browsers (per the hard constraints). Verification was
read-verification (I4), all against HEAD this session:

- `python3 json.load` on both queue files — parse clean, item ids as designed.
- Flags in Batch-B URLs: `packSource` (pack_fetch_controller.js:62 `packSourceEnabled`,
  EXACT-MATCH on/1/true/yes), `texWorkers` (xu7_textures.js:657 `texWorkersEnabled`),
  `nosw`/`autoLogin`/`account`/`password`/`autoSpawn` (index.html bootParams; url-flags
  contract-param row), `camDebug` (camera.js:417 `=== "on"`; installs `window.__cam`
  with `.player(dist,az,el)` — the vantage `cam` fields map to it directly).
- `kickDance` EXCLUDED on purpose: url-flags.md:566 — REMOVED s13, no reader, L3 lint
  fails re-emitters (the older headless recipe is stale on this point).
- `texCompressedOnly`/`geomBundles`/`drawPools` confirmed ABSENT at HEAD (rg over
  scene3d/, index.html, src/lib.rs; only a T22-scope comment in frame_work.js:22).
- E4 sheets dir exists (`/mnt/wbterminal2/xubc7-proto/results/sheets/` — currently the
  proto q20/ab pairs; the batch prerequisite requires T16's q75 regeneration).
- `@telepoi n` / `@telepoi Holtburg` / `@telepoi Town Network` usage read-verified in
  harness/census-class.mjs, harness/moving-bench.mjs, and the fleet runbook.
- T11 D5 text read from impl/task-T11-report.md:105–111 this session.

## Handoffs & risks

- **Owner session (redmi):** batch-B-2026-08-09.json is self-contained — preamble,
  URL pairs, `__cam.player` poses, checklists, null verdict/decision slots. Verdicts
  go back into the file AND url-flags §0 rows (D-10.8).
- **T15 agent:** fill the two rider `cmd` fields when the route/soak harnesses land;
  re-verify the `texCompressedOnly` spelling in the E2/E3 URLs against your reader.
- **T16 agent:** E4's decision slots are the in-writing record R-04 points at — write
  the q75 verdict and B4a election there (plus your report).
- **Risk:** if T15/T16 rename a flag or the sheets path, the queue file must be
  amended BEFORE the session — the file is the owner's only derivation source by
  design.
- Sibling T30 (batch A) was in flight concurrently; this task touched only its own
  three files (T30's batch-A file/report untouched).
