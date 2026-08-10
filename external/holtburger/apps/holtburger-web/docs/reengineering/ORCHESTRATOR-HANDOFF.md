# ORCHESTRATOR HANDOFF — implementation phase, 2026-08-09 ~03:30

For the next orchestrator session. Governing docs: `IMPLEMENTATION.md` (binding header —
you enforce it, max 2 agents, disjoint scopes) and `SPEC.md` (authoritative spec).
Read both before acting. This file is the volatile state those don't carry.

## -5. PASS 3 (2026-08-10 late) — pooled world exists; resample in flight

- T22-PRODUCER LANDED+VERIFIED (battery 396/396 re-run; live SwiftShader arm on
  the deployed dist: 51 pools / 17 classes sealed post-boot, parked mutations 0,
  36/36 grid slots LIVE, all integrity counters 0, census bounds MET, F-11.18
  applied at pool scale, 0 console errors). E6 IS NOW RUNNABLE (first time).
  ORCHESTRATOR RULINGS on its deviations: D3 envcell swap deferral ACCEPTED —
  the three read-verified blockers (layer-1 attachment, cellSetChanged unwired,
  portal ticks walk containers) make it a queued task (its designed shape is in
  the T22P report); do not ship it un-eyed. D4 noted: 17/51 pooled is a FLOOR —
  666/815 nodes still route legacy (bc7Pending 363 / deformed 218 /
  needsResample 85) — the resample + rsId-marker items shrink that. OFF-arm live
  boot not run (one-browser budget; suites+diff argument accepted per I9) — a
  quick OFF boot rides the next orchestrator session for belt-and-braces.
- ROUTED NUMBERS: pool geometry alloc:used 55x (22.3 vs 0.4 MiB) — POOL_INIT_*
  [A]s want re-classing or a lazy first grow BEFORE M6 scores; 17 class pages =
  127.8 MiB — M4 rider once envcells + resample residue join.
- QUEUED (new): ENVCELL-POOL-SWAP (T22P D3 designed shape) · bc7Pending rsId
  marker look (ST5 owner) · worker-side record→axis ladder (T22 D1, now a
  relocation with a live differ target).
- PAGE-RESAMPLE agent still in flight.

## -4. AGENT-PASS ERA (2026-08-10 evening) — orchestrator + Opus implementation agents

Owner directive: Opus agents implement; orchestrator researches/verifies/pushes.
- PASS 1 LANDED+VERIFIED+PUSHED: T15R (rehydrate-v3 full-tier mirror seam +
  demote rung; default-arm fullSwaps=0 scare resolved as counter-naming — legacy
  full-res ran 306 upgrades in the same capture; E1 softness suspect is now the
  untracked atlas hold-out class C1, third-arm tco probe queued for next 1070
  session) + MOVEFIX-HARNESS (renderOnDemand exonerated — boot stalls were
  stale-ACE-session refusals hidden by scalar-only gates; classifyBoot+relogin
  landed; MOVE-FIX baseline UNBLOCKED; never default --account=tailnet1 on the
  1070).
- PASS 2: T22 LANDED+VERIFIED (staged subset, battery 333/333 re-run by the
  orchestrator; substrate complete, PRODUCER SWAP is the D1 remainder). Its
  flags, all propagated: D2 — page-tier key needs bake/transcode RESAMPLE to
  page dims before drawPools may allocate (texture-pipeline task, predicate
  pageDimsOf/needsResample); E6 prereq corrected in batch-C queue (substrate
  alone is not eye-testable); D-07.6 [A] "world-static nodes ≤~250" measures 271
  (+8% — flagged, not absorbed); D4 — FrameWorkScheduler items must NOT
  re-enqueue into their own class (drain-until-budget spins; continuation =
  once-per-frame re-armed flag). T15R-TERRAIN LANDED+VERIFIED (battery 105/105 re-run;
  boot converges at t128 from the lane-B slice packs, wholesale in-place
  promotion staged one array/frame per P-88MIB, 22 MiB mirrors freed live,
  OFF=absent legacy-identical). Its flags: D5 — initTexture staging is a
  CORRECTNESS requirement (live boots showed swapped arrays un-uploaded 150 s
  post-promotion without it; renderer must come off liveScene3d.renderer, not
  the snapshot); D4 — terrain mirrors ride texture_rehydrate.js directly (the
  T15R record-budget seam would re-adopt terrain into the 128 MB record budget
  SPEC keeps it out of); D1 — flag grammar: ABSENT=legacy kill path, off=pins
  t128 (3-value grammar completes at the default flip); D6 doc-debt — pass-05's
  "~0.9 MiB GPU" for the t128 pair is really 1.38 MiB (dedup saves wire bytes,
  not texStorage3D layers). GATE-TEX gains a terrain leg (1070/owner): t1024
  staging vs F6 in-app, mirrorRestoreFailed=0 across a forced context loss, and
  an owner eye on the t128 interim state (never yet seen by a human) — chain it
  with the E1 third-arm tco probe next 1070 session per the report.
- RELIEF-IN-BAKE LANDED+VERIFIED (battery 78/78 + neighbors re-run; release
  wasm 6,423,996 B shipped): HBG1 GEOMR variants bake the relief that ACTUALLY
  ships (D1 read-verification: at preset subdivLevel 0 the live relief is
  gfx_remodel's OP1/OP3 additive RAILS — gfx_subdiv's displacement has no
  runtime caller; acceptance restated as identical-subsets+appended-triangles,
  differ-pinned against the runtime's own relief output, strictly stronger).
  Default GEOM unchanged (1,927 rows byte-identical to T13); GEOMR 125 rows /
  +7,760 tris / 1.32 MB on the CI region; consumer behind ?reliefBundles
  DEFAULT-OFF. REMAINDER D2: interior/ENV variants not baked (per-CELL palette
  makes material boundaries a cell fact, not a cellstruct fact) — relief arm
  rails exteriors only. ⚠ EYE-ARM TRAP for the next 1070 queue: the DEPLOYED
  dist has NO GEOMR rows (needs a --geom-relief re-bake) — a naive arm renders
  flat and false-CLEANs; assert __diag.geometry.relief.variantRowsResident>0
  before judging. Original queued brief: — bake gfxRelief into HBG1 GEOM
  variants so the pack pipeline stops force-disabling relief. Full turnkey brief:
  docs/reengineering/queued/RELIEF-IN-BAKE-brief.md. Launch when a pass-2 slot
  frees and its scope no longer collides.

## -3. 1070 BATCH-A EXECUTION 2026-08-10 (afternoon; owner-directed) — in flight

BATCH COMPLETE (evening): 9 of 10 items executed and recorded in the queue file —
P-SUBTLE, E1 (CLEAN; orchestrator-eye after the same-day fusion fix; texture-tier
finding filed to T15), P-ASSEMBLE (28 µs/model p50 — GATE-GEOM sanity PASS),
P-LIGHTBAKE (30/55 µs/cell p50/p90 — main-side light bake viable), P-INITTEX
(initTexture stages 8 MiB in ~2 ms outside render — GATE-POOLS can rely on it),
P-88MIB (whole 88 MiB = 87-96 ms, split 44/44 = ~44 ms/frame — both under F6 250 ms),
BOOT-666 (bundle collapses cold JS fan-out ~5×; world-data lane dominates — ST2
territory), TEXWORKER-TAIL (worker tail ~3× better than FIFO, kill-row clear),
TEXWORKER-BOOTWARM (64-deep burst high-water, drains clean — the texWorkers=2
datum). MOVE-FIX-BASELINE was BLOCKED at run time; root cause CORRECTED and harness
FIXED same evening (see the corrected queue row + the renderOnDemand correction
below) — the judged baseline is runnable next 1070 session. CLEANUP DONE: test chrome killed (cdpwb-* only), WLS2
task deleted, 1070 ssh tunnel + all three cloudflared quick tunnels closed
(R9 290 session links now dead by design); serve.py/wsbridge/ACE left running.
GATE-TEXWORKER: both legs now green (an interleaved PC-7-strict re-run would
harden TAIL before the default flip — orchestrator's call per D-09.3.3).
Operational notes for successors:
- schtasks launch: per-profile bats C:\Temp\launch-<tag>.bat (arg-passing to a
  shared bat via schtasks /tr proved unreliable); cycle via scratchpad
  b1070/cycle-chrome.sh <tag> (kills cdpwb-* only, CIM query — no $_ quoting trap).
- ssh tunnel needs ServerAliveInterval (a stale -L forward looked like "Chrome
  died" mid-run once; box-side Test-NetConnection disambiguates).
- ⚠ ACE CRASHED mid-batch (~11:00): LandblockManager.Tick unhandled exception —
  plausibly poked by westward @teleloc hop-cadence walks (z mid-air over new LBs;
  the §ace-admin memory note warns). RESTARTED with the ace-live.md recipe + ONE
  REQUIRED FIX: the console FIFO needs a PERSISTENT WRITER or dotnet blocks on
  open() before starting — `setsid bash -c 'exec sleep infinity > ~/ace_stdin.fifo' &`
  first, then the setsid nohup dotnet line. (ace-live.md marks the recipe UNTESTED —
  it is now tested-with-fix; owner: consider updating that memory file.)
- CORRECTED (same day, MOVEFIX-HARNESS agent): renderOnDemand=1 does NOT stall
  boot — the observed stalls were STALE-ACE-SESSION login refusals hidden by
  scalar-only __bootState gates (autoLogin maxRetries=0 is terminal on first
  refusal; ready/in-world share one scalar so a late watchdog error can mask a
  good session). Harness fixed (2d49aa26): history-based classifyBoot +
  __runAutonomousLogin retries + reason-printing. MOVE-FIX baseline UNBLOCKED
  for the next 1070 session; never default --account=tailnet1 there.

## -2. R9 290 REMOTE EYE SESSION 2026-08-10 — E1 DIRTY (envcell fracture) + boot-time complaint

Owner ran the Batch-A eye legs remotely (cloudflared tunnels: serve.py :8765 +
wsbridge :8080; `bridge_url` URL param carries the wss tunnel; auto-login URLs in the
session artifact). Release wasm REBUILT+verified 6,404,273 B (clears §-1's staleness
warning — same byte size as T13's, mtime was a false alarm). ⚠ AUTOMATION RULE learned:
headless probes must NOT log in as tailnet1 while the owner is testing (one account =
one session; use agentp07 "Funnel Probe" etc.).
- **E1 verdict DIRTY** (recorded in queue-1070/batch-A-2026-08-09.json): ON arm
  envcells FRACTURED in dungeons (Holtburg Redoubt) + outdoor building interiors —
  missing triangle chunks + giant stretched shards; models/statics/NPCs in the same
  cells CORRECT. Screenshots in the session scratchpad (fracture-dungeon.png /
  fracture-interior.png).
- **NEW native differ** `differ_real_dats_envcells` (geom_bundles.rs, #[ignore],
  needs ~/ac_base_dats): all 178 envcells of LB 0x0163 assemble EXACT vs the runtime
  triangulator — T13's assembly code + hbg1 encoder are byte-perfect against real
  DATs. Suspicion therefore moves to the DEPLOYED v3 pack GEOM/cell payloads or a
  live-only path. 3-arm SwiftShader repro (A=packs+bundles, B=packs-only, C=legacy at
  the redoubt) staged as scratchpad/redoubt_repro.cjs — B fracturing ⇒ T12/pack-data;
  only-A fracturing ⇒ T13 live path.
- **Boot time**: owner reports >10 min cold outdoor load through the tunnel (retail
  <10 s local-disk). Byte census (headless, localhost, Arm-A flags) in flight;
  hypothesis: tunnel-uplink bandwidth-bound, not client-bound. NOTE serve.py has no
  zstd (Python 3.13; gzip fallback) and `?nosw=1` defeats warm-boot caching by design.
- GATE-GEOM consequence: geomBundles stays DEFAULT-OFF; ST3 promotion blocked until
  the fracture is root-caused + fixed + a re-run E1 comes back CLEAN (D-09.5).
- **ROOT CAUSE FOUND + FIXED same day (~10:30):** cells.js `buildFusedMesh` (the
  default `?envcellFusion` path, pre-T13) assumed NON-indexed surface groups; T13's
  bundle cells are INDEXED over shared whole-cell streams → fusion drew the raw
  vertex stream as triangle soup. Isolation chain: real-DAT differ 178/178 exact
  (assembly innocent) → deployed-pack differ 769/769 byte-identical (bake innocent)
  → SwiftShader arms A dirty / B,C clean (geomBundles-only) → arm D
  (`envcellFusion=off`) CLEAN (fusion pinned). FIX: fusion extracted to
  scene3d/cell_fusion.js (`fuseSurfaceGroups`): indexed buckets fuse by index-concat
  over the shared streams (groups in INDEX units, no de-index blowup), legacy slabs
  byte-identical, defensive mixed-bucket de-index. Tests: harness/test_cell_fusion.mjs
  (20) + test_geom_bundles.mjs 54/54 green; two new #[ignore] Rust differs
  (`differ_real_dats_envcells`, `differ_deployed_pack_geom_env`) in geom_bundles.rs.
  Docs propagated (url-flags geomBundles §0 row + envcellFusion row + batch-A queue
  verdict). E1 re-run on a REAL GPU still owed before CLEAN.
- **Boot census (corrected — the first run silently truncated at the 250-entry
  resource-timing buffer):** cold Arm-A outdoor boot = 1,510 requests / 159.2 MB
  encoded (94.7 MB texture tier, 30.4 MB legacy shards over 887 requests, 9.3 MB
  packs, 2.4 MB wasm); network-quiet at ~84 s on localhost. The owner's >10 min =
  159 MB through the laptop-uplink tunnel (~2-4 Mbps effective) + 887-request RTT
  tax + `?nosw=1` re-paying it every reload — bandwidth arithmetic, not a client
  defect. Mitigation = dist placement near the player (mirror/CDN), not client work.
- **DRIVER INVESTIGATION (owner-requested, ~11:30) — wifi/driver CLEARED, serve-side
  fixed:** iwlwifi 8265 healthy (5 GHz ch44/80 MHz, power-save off, 0 firmware
  errors; NSS1 @ -72 dBm is rate adaptation, not a defect); measured 16.6 MB/s
  (~133 Mbps) raw upload laptop→CF edge. Real cold-boot costs: (a) on-the-fly gzip
  ~17 MB/s input vs 1.6 GB/s identity — and the 96 MB compress-LRU was smaller than
  the ~160 MB boot working set, so it THRASHED (every boot re-compressed); (b) the
  quick tunnel adds ~200 ms/request × 1,510 requests at app-capped concurrency;
  (c) the remote player's own edge route (unmeasured from here). LANDED `4c5cbfe0`:
  serve.py `--compress-cache-mb` (running instance restarted at 256 MB — warm wasm
  re-serve 0.39 s → 0.036 s; serve log now at session scratchpad serve8765-new.log).
  zstd codec still owed: `sudo apt install python3-zstandard` (no pip/sudo in this
  session). NOTE serve.py's wasm-stale WARNING now false-positives: commit 864bc140
  touches geom_bundles.rs but only #[cfg(test)] code — shipped wasm unaffected.

## -1. BAKE-3 DONE + DEPLOYED (2026-08-10 05:20) — v3 pack layer is the live one

driver3.log: === DONE rc=0 at 23:05:34 (152m38s). 17,682 packs / 265.0 MB (+453.8 KB
index), 16,384 tiles / 1,153 interiors / 65,025 LBs, missingPvw=0,
closure_verified=TRUE, determinism_verified=TRUE. texref 3,471 rows, pvw 45.06 MB
(pre 2893 / full 106 / extra 88, unsliceable 0). This run carries the 593 fixed
Remacri textures + refreshed previews + T13's HBG1 GEOM sections in one verified pass.
DEPLOYED 2026-08-10 05:20 via deploy-packs-v3.sh: CAS sha-verify 17,682/17,682,
world_index verified (index c80e43ab…, 464,666 bytes), manifest merge clean
(only world_index changed — expected; pack_url_template identical; no other deltas),
provenance + pack-report copied, serve.py --check OK (index=1, packs=256).
NOTE: the script's step-3 gate was patched for the re-deploy case (the original
asserted world_index was ABSENT from dist — true only for the first deploy; it now
allows exactly world_index to change and nothing else).
⚠ serve.py --check warns pkg/ wasm (mtime 08-09 20:12) predates the last
Rust-touching commit — REBUILD (capped-build wasm-pack --release) before trusting any
measurement or GPU-batch arm.
CLEANUP from §0 executed 2026-08-10: world-packs-CONTAMINATED-double-launch-DELETE-ME,
world-packs-crashed-run1, world-packs-run2-unverified, driver2-firstattempt.log all
deleted. Remaining next steps: GPU session (1070 or R9 290 tunnel) runs FULL batch A —
E1/P-ASSEMBLE unblocked; T15 remainder + T22 sizing per §Pass-3/TEX-RE-KEY notes below.

## 0. HISTORICAL: BAKE SETTLED — FULL-WORLD PACK LAYER WAS LIVE (2026-08-09 15:41; superseded by -1)

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

## REOPENED 2026-08-09 ~22:50 (user-authorized): proceed with the critical path while
the 1070 is down (it may return tomorrow; ALSO offered for tomorrow: an R9 290 over a
cloudflare tunnel — usable for eye-item correctness legs; benches stay 1070-bound
since prior baselines are 1070-GPU-specific). Batch-A session is preflight-complete
and armed (see queue-1070/batch-A sessionLog); E4 sheets v2 are on redmi's device.
- Corpus repair landed this evening (impl/texfix-fringe-2026-08-09.md, b03bf204):
  593 Remacri textures fixed + promoted through lossless/ingest/q75; propagation
  debts recorded there — the pack re-bake is DELIBERATELY sequenced AFTER T13 lands
  (one overnight bake then carries fixed textures + refreshed previews + T13's HBG1
  emission together; T13's agent owns holtburger-tools until it lands, R-MEM1 keeps
  the bake exclusive afterwards).
- T13: DONE + ORCHESTRATOR-VERIFIED ~20:25 (10 commits 9d6f5205..53c1251a pushed):
  HBG1 end-to-end behind ?geomBundles DEFAULT-OFF, 4 consumer swaps bisectable,
  BAKE-CI re-run green by the orchestrator (HBG1 differ 1,927 rows byte-identical,
  187 s), 54/54 JS suite, both assemble exports in release wasm 6.40 MB. gfxRelief
  parity note propagated into batch-A E1 (OFF arm URL now carries gfxRelief=off).
  E1/P-ASSEMBLE/parked-p50 deferred to the GPU batch.
- TEX-RE-KEY: DONE + APPLIED ~20:00 (proposal b1832ea1; amendments 24de3936):
  tex axis → array-page tier; R-03 CLOSED-as-measured; T22 sizing unblocked
  (GATE-POOLS 1070 confirm arm still owed).
- Preview tier refreshed for all 593 repaired ids (47b234a3) — pre>full>extra
  priority read-verified; 511 pre + 7 extra replaced, 75 added.
- BAKE-3 LAUNCHED 20:32:55 (run-world-bake-3.sh → world-packs-v3/, log driver3.log,
  detached setsid, alone in the jail, fresh dat-shard bin 9649a166 WITH the T13
  emitter): fixed textures + refreshed previews + GEOM sections in one verified pass.
  On DONE rc=0: deploy-packs-v3.sh (gates on driver3.log; CAS verify → additive
  rsync → manifest merge → serve.py --check). Then tomorrow's GPU session (1070 or
  the R9 290 over cloudflare) runs the FULL batch A — E1/P-ASSEMBLE now unblocked.

## SESSION CLOSED 2026-08-09 ~19:35 (superseded by the REOPENED block above) — original
pause state kept for the record:

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
