# ORCHESTRATOR HANDOFF — implementation phase, 2026-08-09 ~03:30

For the next orchestrator session. Governing docs: `IMPLEMENTATION.md` (binding header —
you enforce it, max 2 agents, disjoint scopes) and `SPEC.md` (authoritative spec).
Read both before acting. This file is the volatile state those don't carry.

## 1. IN FLIGHT RIGHT NOW: the full-world packs-only bake (orchestrator-owned)

- Detached driver: `/mnt/wbterminal2/reeng/orch-bake/run-world-bake.sh`
  (setsid nohup — survives session exits), log `driver.log`, memory curve `mem.log`
  (30 s cadence), output `world-packs/`. Started 03:19:56. Phases: RUN1 bake →
  pvw harvest → node derive of missing previews → RUN2 with
  `--verify-closure --verify-deterministic`.
- Guardrails: alone in the 3.5G `oom.group` builds cgroup (`/sys/fs/cgroup/dev/builds`),
  `RAYON_NUM_THREADS=4`, fresh swap. If it dies at the cap: the verdict is
  "full-world bake = buildbox job" — mem.log's peak is the evidence; do NOT re-run
  locally with a bigger cap.
- On success: packs/index/manifest land in `world-packs/`. Next steps: sha-verify,
  then rsync `packs/` + `index/` + the two additive manifest keys into the canonical
  dist (`/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`) as the additive layer
  (pass-9 ONE-tree coexistence; legacy files untouched). Then T12's deferred
  comparative arms (GATE-WIRE-BOOT cold-boot bytes/requests vs legacy) become runnable.
- ETA estimated 3.5–6.5 h from start (uncalibrated; RUN1 wall time is the calibration).
- PROGRESS 2026-08-09 ~08:00: RUN1 finished clean in 84m20s (17,682 packs / 253.7 MB,
  16,384 tiles / 1,153 interiors / 65,025 LBs; 74 missing previews). DERIVE: 74/74
  derived. RUN2 (verified) started 04:44:19; emission artifacts (index/, manifest.json,
  bake-source.sha256) landed 07:06; verify phase in flight, cgroup steady ~3.44G of the
  3.5G cap, swap 0 used.
- The emitter's rayon patch is commit `4d24594c` — byte-identity proven vs the
  sequential baseline on bounded BAKE-CI (see commit body).
- `world-packs-crashed-run1/` is the pre-incident partial output — delete when the
  new run succeeds.

## 2. INCIDENT LEARNINGS (2026-08-09 ~03:10 hard reboot) — now BINDING scheduling rules

Box died: swap chronically exhausted (other sessions' tsservers ~2.1 GB) + bake (3.5G
jail, shared) + T20 rust/wasm builds (SAME shared jail) + T11 node tests (bare node =
UNCAPPED) stacked; earlyoom could not select a victim ("could not find a process to
kill" — avoid-list protects claude) → freeze → reboot. Rules going forward:
- R-MEM1: the full-world bake (or any multi-GB job) runs ALONE — no concurrent agent
  builds, no browsers.
- R-MEM2: at most ONE test chromium on the box TOTAL across all agents (already in
  briefs), and check `free -m` ≥1.7 GB before launch.
- R-MEM3: bare `node`/`esbuild` is uncapped — treat heavy node work like a build
  (schedule it, don't stack it).
- R-MEM4: `swapon --show` USED% is a pre-flight check before launching anything heavy;
  swap near-full = the box is already overcommitted, stop stacking.
- Post-reboot facts: ACE server is DOWN (dies on reboot; restart runbook =
  memory/ace-live.md) — needed for any census/login test, NOT for the bake.

## 3. AGENT STATUS (previous session's agents were killed by the reboot; their
transcripts are dead to a new session — verify from committed state, do not SendMessage)

- T11 (shell bundle): committed through `a451e81c` "T11 deploy + tests + report
  (ST-SHELL DONE)" INCLUDING its report + row update. VERIFIED per I8 2026-08-09 ~08:15:
  report sections complete, tests re-run green (build-shell 56/56, diag-schema 65/65;
  url-flags lint shows only the 2 known pre-existing presence-guard rows — T20's
  slotGrid row is now documented). Browser floor remains deferred (RAM), rides T30
  batch prep. D4 plugin-lane orchestrator call still OPEN.
- T20 (slot grid): KILLED MID-TASK. Landed: `4a07e021` (PackStore Rust half),
  `b98d315c` (grid→legacy adapter + assert-only LRU). Missing (vs its brief): the
  residency_grid.js core commit?? (check git log for scene3d/residency_grid.js),
  ladder/census work, tests, report, row update. Recovery: inspect committed + dirty
  state, then launch a FRESH T20 agent briefed to (a) read IMPLEMENTATION.md + SPEC §3
  T20 + pass-06 + the two landed commits + any dirty files, (b) verify/absorb what
  exists, (c) complete the remainder per the original acceptance. Original brief text
  is in this session's history; the essentials are in SPEC §3 T20 + §1.4.
  Verified 2026-08-09 ~03:45: NO uncommitted T20 WIP — its work is entirely in the
  two landed commits.
- PUSHED: as of `8c6d1920` everything (34 commits: all task work + this docs corpus)
  is on origin/master (github.com/salvia420-bit/WorldBuilder-ACME-Edition). The
  buildbox syncs from that origin — a buildbox agent fan-out needs NO git bundle,
  just `git fetch && git reset --hard origin/master` on the box per the fleet
  runbook. Keep pushing after each verified landing so the box stays current.
- T00: BLOCKED (census tooling done; live run needs RAM headroom + ACE up). Rerun is
  one command (see impl/task-T00-report.md) when the box is quiet and ACE restarted.

## 4. TASK QUEUE (after the bake settles)

Done: T01 T02 T10 T12 T14 T21 (+T11 pending verification). Blocked: T00 (RAM/ACE).
Remaining: T13 (geom bundles — NOTE: touches apps/holtburger-tools for HBG1 emission;
the orchestrator's bake-infra lane also lives there — sequence, don't overlap),
T15 (compressed-only tex), T20 (finish), T22 (needs T13+T15+T20+T21 + T00's census —
R-03: do NOT size pools against an assumed census), T16 (bake-side, buildbox-scale
encode + owner eye), T30/T31/T32 (1070 queue prep), T40 (retirement — conditions in
SPEC §3).
Slot policy: max 2, one critical-path + one independent, at most one wasm-touching
task at a time, and NOTHING heavy concurrent with a bake (R-MEM1).

## 5. STANDING ORCHESTRATOR DUTIES

- Default flips are YOURS, not agents' (I7): every stage flag is DEFAULT-OFF; flips
  happen per SPEC §3 serialization (one at a time, gates green, soak between) — none
  are due yet.
- Doc-propagation debts (pass 9's register + accumulating): CLEARED 2026-08-09 ~08:20 —
  the survey's stale I4/fixedGrid wording (§4 I4 row + §5 sequencing note) now carries
  pass-06's R4 correction, and the statics.js:2444 "?statBatchChunk default OFF" comment
  (S7.3's standalone-same-day row) now reads default-ON-since-07-03. Still bound to
  their stages: the PLAN-fixed-slot-grid plan-doc banner (ST7/T20 landing) + the rest of
  S7.3. Each landed stage and each verdict must reach url-flags.md / the frame-cost doc /
  SPEC's risk register same-day.
- 1070 batches A/B/C are owner-gated; queue files per pass 10's format. Nothing has
  gone to the 1070 yet.
- User communication habit: report which tasks are ACTIVE by number, verify every
  agent report against its gate before marking DONE, launches are user-gated —
  ask before starting new agents unless told otherwise.

## 6. COST NOTE (why this file exists)

Resuming a long session replays its context each turn. A fresh session + this file +
IMPLEMENTATION.md + SPEC.md is the cheap path: everything an orchestrator needs is on
disk; nothing requires the old conversation. Update this file whenever orchestrator
state changes (bake finished, agent verified, flip executed) — it is the successor's
first read.
