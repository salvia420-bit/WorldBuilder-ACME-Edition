# ORCHESTRATOR HANDOFF — implementation phase, 2026-08-09 ~03:30

For the next orchestrator session. Governing docs: `IMPLEMENTATION.md` (binding header —
you enforce it, max 2 agents, disjoint scopes) and `SPEC.md` (authoritative spec).
Read both before acting. This file is the volatile state those don't carry.

## 0. BAKE SETTLED — FULL-WORLD PACK LAYER IS LIVE (2026-08-09 15:41)

RUN2-FIXED completed 15:35 rc=0: 17,682 packs / 255.2 MB, 16,384 tiles / 1,153
interiors / 65,025 LBs, missingPvw=0, closure_verified=TRUE, determinism_verified=TRUE
(147m40s with the memoized verifier `7d44572b`). Cross-run byte-compare vs the 07:06
emission: 0 content diffs, 0 new-only files (the 11,201 "only in old" lines are stale
RUN1-era CAS names — the old dir held RUN1∪RUN2 = 28,883 files). DEPLOYED additively
into the canonical dist via deploy-packs-to-dist.sh: CAS sha-verify 17,682/17,682,
world_index verified, additive-only manifest merge (world_index + pack_url_template),
provenance at dist/bake-source-packs.sha256, serve.py --check OK (index=1, packs=256).
`?packSource` now has the full world. T12's deferred comparative arms are runnable.
CLEANUP owed (rm permission-blocked for the orchestrator; safe to delete anytime):
world-packs-CONTAMINATED-double-launch-DELETE-ME, world-packs-crashed-run1,
world-packs-run2-unverified (superseded), driver2-firstattempt.log.
Section 1 below is HISTORICAL (kept for the incident record).

## 1. HISTORICAL: the full-world packs-only bake (orchestrator-owned)

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
- DIAGNOSIS ~12:30: RUN2's emission + INLINE determinism check PASSED by 07:06 (write
  path is emission-time; the artifacts prove it). Since 07:06 the process is inside
  `verify_closure` (pack_bake.rs:1735): state R, ~97% single-core CPU, RSS 795 MB
  stable, ZERO I/O — read-verified the loop re-parses + re-decompresses the ENTIRE
  target pack for EVERY REFS edge (`HbpReader::parse(&pack_bytes[*target])` +
  `record_stream` per record edge). O(edges × pack-parse), finite but unbounded-slow at
  full-world scale (hot targets = the big commons packs). No progress output exists.
- DEADLINE EXECUTED ~12:40: pass 1 ended (11 min) with the verifier still grinding
  (5.6 h in verify_closure) → killed RUN2, landed the memoized fix (`7d44572b` —
  per-pack key sets, O(packs) parses; bake_ci_bounded_region GREEN with both verify
  flags, 160 s). 12:49 relaunch DOUBLE-STARTED by accident (two instances shared the
  OUT dir ~70 s) — both killed, contaminated dir quarantined as
  `world-packs-CONTAMINATED-double-launch-DELETE-ME` (safe to delete anytime; rm was
  permission-blocked for the orchestrator).
- RUN2-FIXED launched CLEAN 13:03:12 (single instance, bin sha a3ed14123bb90a58,
  log `driver2.log`): verified emission only (RUN1+derive results stand; pvw-extra
  populated). Ends with a byte-compare vs `world-packs-run2-unverified/` (the intact
  07:06 emission — emission code untouched by the verifier fix, so packs must be
  byte-identical; a diff = STOP). ETA ≈2.5 h (~15:30). Deploy gate now reads
  driver2.log. USER DIRECTIVE ~12:45: let it bake properly — NO agents until the bake
  is DONE (passes 2/3 wait).
- MEMORY-STALE (notify owner, do not edit MEMORY.md): `kickDance=1` in the
  §chrome-testing headless-login recipe has NO reader on HEAD (removed s13);
  `kickWaitMs` is the real knob — T30's queue prep read-verified this.
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

## 3b. SESSION PLAN 2026-08-09 (user-authorized ~08:45): after the bake is managed
(RUN2 green → deploy script → push), run THREE passes of TWO Fable agents each on the
spec queue, then PAUSE. Pairings honor the slot policy (≤1 wasm-touching per pass):
- REORDERED ~12:30 (bake verify overrunning; docs-only work is the only R-MEM1-safe
  class while it grinds):
- Pass 1 (LAUNCHED ~12:35): T30 Batch-A queue prep + T31/T32 Batch-B/C queue prep —
  both docs-only, disjoint outputs, no builds/browsers.
- Pass 2 (launched ~15:45): T20-finish — DONE and ORCHESTRATOR-VERIFIED ~17:10
  (suites re-run 394/394 + 25/25, lint clean, release wasm 6.34 MB shipped, report I8
  complete; commits 5575c55f/107baf22/39907c14 pushed). Live arm: ALL zero-tolerance
  counters 0, 0 console errors; three live-only integration bugs found+fixed (export
  bag, STAGED refire, T12 keep-set — recorded deviations). Its D4 (R4 stays engaged in
  migration era) propagated into batch-C E5's checklist same-day (59152c69). E5 eye +
  M1/M2 + scored benches remain Batch C. NOTE: the T20 agent RESTARTED local ACE —
  ACE is UP again (unblocks T00). T16 q75 encode still running on the buildbox
  (statics tranche 2,931/2,931 clean; tranche1 in flight).
- T16: DONE (encode) and ORCHESTRATOR-VERIFIED ~18:00 — q75 corpus 3,985/3,985 records
  sha-verified at /mnt/wbterminal2/xubc7-corpus-q75 (1.6 GB + provenance), 36 E4 sheets
  staged, buildbox powered off after; E4 eye + the two ST6 decisions stay OWNER-gated
  (redmi, Batch B). New [M] evidence for the B4a election: corpus q75/lossless = 0.690
  → ≈69.6 MB, OVER the ≤65 gate. Commit e6a0dcad pushed.
- Pass 3 COMPLETE + VERIFIED ~19:30. T00: census RAN (both scenes survived, no
  earlyoom kill) — VERDICT RE-EXAMINE: 122 classes / 352 projected pools at Nanto
  (80/274 TN) vs ≤48/≤300 bounds; texDims is the sole big fragmenter (+92; without it
  30/26 = inside the class bound). T22 sizing stays GATED on a pass-7 tex-axis re-key;
  candidate keys evaluable OFFLINE via --reduce over /mnt/wbterminal2/reeng/T00/
  snapshots (no browser run needed). Commit effde7dc. T15: landed as an honest staged
  subset behind ?texCompressedOnly DEFAULT OFF (5 bisectable commits 3c49c17d…b22c1781;
  84/84 new battery + all neighbor suites green; OFF arm proven; S7.3 ST5 doc duties
  discharged; release wasm 6.33 MB shipped). T15 REMAINDER queued: terrain tier-ladder
  (?terrainT1024), rehydrate-v3 completion, H-05.1 demote-into-pressure-ladder wiring
  (orchestrator-sequenced).

## SESSION CLOSED 2026-08-09 ~19:35 — PAUSED per user authorization (3×2 passes spent)

State at pause: T00 T01 T02 T10 T11 T12 T14 T16(encode) T20 T21 DONE · T15 DONE-staged
(remainder above) · T30/T31/T32 queues PREPARED (owner-gated 1070 batches; batch-B E4
carries redmi's two in-writing decisions; B4a evidence: q75 projects ≈69.6 MB, OVER the
≤65 gate) · T13 queued (geom bundles; last wasm-lane task before T22) · T22 gated on
T13 + the census tex-axis re-key · T40 far. Everything pushed through b22c1781. ACE is
UP. Buildbox is OFF. No bake running. Next orchestrator: T13 launch + the tex-axis
re-key are the critical path; then Batch A/B/C owner sessions.
Deploy tooling ready: /mnt/wbterminal2/reeng/orch-bake/deploy-packs-to-dist.sh
(CAS sha-verify → additive-only manifest check → rsync packs/+index/ → merge
world_index/pack_url_template → provenance copy → serve.py --check). Supports --dry-run.
- D4 (T11 plugin-lane) ORCHESTRATOR CALL, recorded: option (a) — accept the plugin
  dynamic-import lane as a per-file class for v1; record it in the B2 ledger when the
  T30 comparative arms run; revisit (b) --splitting / (c) loader-map post-v1. Rationale:
  (a) is the only no-code-change reversible option and the shell component itself still
  meets ≈8.

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
