# PIPELINE RE-ENGINEERING — IMPLEMENTATION TRACKING (BINDING PROTOCOL)

<!-- ============================================================ -->
<!-- HEADER — NORMATIVE. EVERY IMPLEMENTATION AGENT IS BOUND BY IT. -->
<!-- ============================================================ -->

## PROTOCOL HEADER — READ FIRST, ADHERE COMPLETELY

This document governs the implementation of `SPEC.md` (this folder — the authoritative
architecture + implementation spec produced by the 12-pass effort; `TRACKING.md` and the
pass files are its design history). One agent implements one task at a time; at most two
agents run concurrently, with disjoint file scopes. An orchestrator session enforces
this header; agents do not modify it.

**RULES — violations invalidate the task:**

I1. **Read order is mandatory.** (1) This file top to bottom; (2) `SPEC.md` §0–§2 plus
    your task's entry in §3 and its row's cited findings; (3) the pass files your task's
    SPEC entry cites (for full-fidelity design detail); (4) the current code you will
    touch. SPEC.md is authoritative; pass files are rationale; where they disagree,
    SPEC.md wins.

I2. **Scope is your task only.** Your assignment lists your file scope. Files outside it
    may be READ freely but edited only when unavoidable for your task, minimally, and
    recorded in your report. Never touch another in-flight task's scope (listed in the
    table below as ACTIVE).

I3. **Deviations need evidence.** If implementation reveals SPEC.md is wrong or
    unimplementable as written, do the minimal sound thing and record a
    `DEVIATION: <spec §> because <read-verified evidence>` block in your report. Never
    silently drift. Never edit SPEC.md (the orchestrator propagates accepted deviations).

I4. **Read-verify before you assert or alter.** file:line claims come from files opened
    this session. Traps: the wasm crate is `apps/holtburger-web/src/lib.rs`
    (`crates/holtburger-web/` does not exist); `pkg/` is gitignored build output; URL
    flags share `flagIsOff` — trust `*Enabled()` functions; `dist` is a symlink to
    `/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`; never pass `-rln` to rg.

I5. **Build rules — this is an 8 GB laptop that OOMs.** Before any Rust build:
    `kill $(pgrep -f rust-analyzer)`. Rust builds ONLY via
    `env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build cargo build -p <one-package> --release`
    — single package, NEVER `--workspace`, never bare cargo. wasm ONLY via capped-build
    wasm-pack with `--out-dir pkg-<task>/` then `rsync -a --delete pkg-<task>/ pkg/`
    (parallel builds clobber pkg/; back up pkg/*.wasm first; release before any
    measurement — ~4.5 MB = release, ~18 MB = dev). JS/node tests run direct. At most
    ONE headless chromium per agent; prefer node-based tests. Big artifacts (bakes,
    corpora, captures) go to `/mnt/wbterminal2/reeng/<task>/` — the system disk is
    85–96% full; never bake into the source tree. Bakes read `~/ac_base_dats/` only
    and emit `bake-source.sha256`.

I6. **Commit discipline.** Work directly in the holtburger repo. Stage ONLY your scope's
    files (`git add <paths>`, never `-A`). Commit style matches the repo: one summary
    line `holtburger: <what>` + a body that records what was measured/decided (read
    `git log` for the house voice). Multiple commits are encouraged where SPEC asks for
    bisectable landings. If `index.lock` contention occurs, wait 5 s and retry (another
    agent may be committing). NEVER push, never rebase/rewrite, never commit files you
    don't own — if unrelated dirty files exist, leave them staged-out and say so in
    your report.

I7. **Flag lifecycle.** New behavior lands behind its SPEC-named flag, DEFAULT-OFF.
    Implementation agents never flip defaults — default flips are migration events
    (SPEC §3 serialization policy) executed by the orchestrator after gates pass.
    The OFF arm must remain byte-identical legacy behavior (that is the kill path).

I8. **Output contract.** Exactly one report: `impl/task-TNN-report.md` in this folder,
    sections in order: `## Shipped` (files + commit hashes) · `## Spec conformance`
    (every acceptance bullet from your SPEC §3 entry: MET / DEFERRED-TO-BATCH /
    FAILED, each with evidence) · `## Deviations` (or "none") · `## Tests run`
    (command + result, @scale tags where the measurement protocol applies) ·
    `## Handoffs & risks`. Then update YOUR ROW ONLY in the status table below
    (status → DONE or BLOCKED, date, report file, ≤2-line summary). Touch nothing
    else in this file.

I9. **Honesty over completeness.** Failing tests are reported failing. Gates needing
    the 1070 or an owner eye are marked DEFERRED-TO-BATCH, never simulated. A task
    that cannot meet its acceptance gate reports BLOCKED with the evidence — that is
    a compliant outcome; a papered-over gate is not.

**ORCHESTRATOR DUTIES:** at most 2 agents in flight (hard cap); disjoint scopes
enforced at launch; verify each report against I8 and the SPEC gate before marking a
task done; sequence default flips and doc propagation; keep the user advised of which
tasks are active.

<!-- ============================================================ -->
<!-- END NORMATIVE HEADER                                          -->
<!-- ============================================================ -->

## Task status

Charges are abbreviations — SPEC.md §3 is the authoritative statement of each task.

| Task | Stage | Charge (abbrev.) | Size | Status | Date | Report | Summary |
|------|-------|------------------|------|--------|------|--------|---------|
| T00 | spike | class-cardinality census over today's materials | S | BLOCKED | 2026-08-09 | impl/task-T00-report.md | Harness+35-check test landed (0ad7e151): S3 classifier, pool projection, axis analysis, RESULTS-v2. Live census BLOCKED: earlyoom killed the renderer in the Nanto burst on both permitted attempts (~1.2 GiB RSS, swap 0 free; retry had lbCap=64). R-03 stays OPEN — T22 must not size until the census runs (command in report). |
| T01 | found. | diag-schema registry, RESULTS-v2 writer, console allowlist | S | DONE | 2026-08-08 | impl/task-T01-report.md | 4 commits (e1349f13…85c9d497): registry (20 surfaces) + lint, @scale-enforcing writer, QuickEmote-seeded allowlist, moving-bench→v2. Tests 60/39/20 green + cam-bench 38/38; run-all --js RED is pre-existing (17 unregistered app-root suites, none T01's). |
| T02 | found. | manifest/fetch caller sweeps → T12 inputs | S | DONE | 2026-08-08 | impl/task-T02-report.md | Findings in impl/task-T02-findings.md: 0 strict dist-manifest parsers (additive v2+ fields safe repo-wide); F-11.6 class = terrain + 6 more world-data tracks (scenery/spawns/events JSONL, suite bins, vfx catalog, wcid_to_setup) incl. wasm-side direct fetch_bytes callers (F-C) + suite lane gap (F-A) + external stars.bin (F-B). |
| T10 | ST1 | dual-emit bake (HBP1/HBSI1, walk-widening, previews, t128, manifest fields), serve rules, BAKE-CI | L | DONE | 2026-08-09 | impl/task-T10-report.md | 3 commits (1a02e73e, ebc47f56, b298d976): widened walk + additive manifest fields; HBP1/HBSI1 emitter (`--emit-packs --legacy-layers`) + xu7 preview deriver; serve.py pack tier + BAKE-CI. Bounded-region GATE-BAKE green (closure/missingPvw=0/determinism/differ 2022 models+3365 cells); legacy A/B byte-identical ex generated_at. Full-world bake = buildbox (report Handoffs); 5 recorded deviations D1–D5. |
| T11 | ST-SHELL | esbuild bundle + content-hashed shell | M | DONE | 2026-08-09 | impl/task-T11-report.md | 3 commits (85a50065, 14cb0671, +deploy/tests): build-shell.mjs (esbuild 0.28.2 standalone, main + 4 verified workers, deterministic sha256-8 shell/, generated index-bundled.html loader; index.html byte-untouched = kill path) + serve.py immutable-identity shell tier + deploy CAS staging + 56-check suite. Cold shell 7–9 req (≈8 ✓) vs 267 unbundled; warm 0 immutable refetches. T2-BOT/1070 floor + comparative browser run DEFERRED (RAM/shared-chromium death); D4 plugin-lane finding (~95 arms-invariant requests + double-instancing) needs an orchestrator call. ORCHESTRATOR-VERIFIED per I8 2026-08-09: report complete, tests re-run green (build-shell 56/56, diag-schema 65/65; url-flags lint clean of T11 rows — the in-flight slotGrid row is now documented). |
| T12 | ST2 | pack client (PackFetchController, PackSource, SW v3) `?packSource` | L | DONE | 2026-08-09 | impl/task-T12-report.md | 5 commits (5e284731…156ecd40): controller (lanes/promotion/latch/quarantine/sha-on-receipt) + PackSource/CompositeSource seam + SW v3 dormant + wiring, all DEFAULT-OFF. Local battery green over T10's region: 0 mismatch / 0 terminal quarantines, 7,228 records byte-identical to base DATs. Comparative arms + T2-BOT DEFERRED (need full-world dual bake / RAM); 5 deviations D1–D5 (incl. T02's F-2/3/5/6 exceptions + Blob-worker sha fallback). |
| T13 | ST3 | HBG1 geometry bundles + consumer swap `?geomBundles` | L | TODO | | | |
| T14 | ST4 | texture worker `?texWorkers` | M | DONE | 2026-08-08 | impl/task-T14-report.md | 2 commits (d8cfd82e, 23383e2a): worker (transcode+terrain-assemble+NRA, results-enqueue-only) + `?texWorkers` DEFAULT-OFF routing with the FIFO arm verbatim and counted-never-silent fallbacks. Node suites 118/118 new + all texture-family regressions green; byte-identity proven vs Rust goldens AND real transcoder/corpus. GATE-TEXWORKER 1070 arms DEFERRED-TO-BATCH. |
| T15 | ST5 | compressed-only texture path `?texCompressedOnly` | L | TODO | | | |
| T16 | ST6 | q75 corpus + owner decisions (bake-side) | M | TODO | | | |
| T20 | ST7 | slot grid residency authority `?slotGrid` | L | DONE | 2026-08-09 | impl/task-T20-report.md | 5 commits (432e8791/4a07e021/b98d315c inherited+verified; 5575c55f S7.3 docs; 107baf22 live-arm fixes: init3D export bag, STAGED refire, EMPTY readmit, controller keep-set). Release wasm shipped (6.34 MB). LIVE arm on the full-world pack dist: 14 crossings + zigzag + teleport ended gridLruDivergence=pinLeaks=shiftMismatches=slotDesyncs=0, verify 126/0, 0 quarantines, 0 console errors; suites 394+25 + all neighbors green. E5/M1-M2/BENCH-*/TAIL-ULTRA DEFERRED-TO-BATCH (T32 unblocked); D4 flags R4-vs-migration-era-M3 for the orchestrator. |
| T21 | ST8 | FrameWorkScheduler stage A `?frameWork` | M | DONE | 2026-08-09 | impl/task-T21-report.md | 4 commits (7731250a…80761d45): scheduler core (W1..W6, modes, shrink, CROSSING lever) + all six 6 ms families and inline tickEviction as W6 clients (code unchanged, OFF byte-identical) + `__framePhase`/`__frameWork` landed in registry + census reducer. 144+25 new checks, all touched-family suites green. GATE-PHASE census run + BENCH-CROSS-SETTLE DEFERRED (memory / 1070 batch). |
| T22 | ST9 | draw pools + scheduler B/C + closed-class prewarm `?drawPools` | L | TODO | | | |
| T30 | batch A | 1070 queue batch A (E1 + probes) — queue-file prep | S | PREPARED (execution owner-gated) | 2026-08-09 | impl/task-T30-report.md | Queue at queue-1070/batch-A-2026-08-09.json (hb-1070-queue-v1, 10 items): E1 + 5 probes (SPEC card) + T11 shell arms (D4 recorded: plugin lane accepted, ~95 reqs → B2 ledger) + T14 texWorker arms + cadence-optional MOVE-FIX baseline. E1/P-ASSEMBLE carry T13-TODO prerequisites; all flags/surfaces read-verified (kickDance stale, geomBundles absent on HEAD). |
| T31 | batch B | 1070 queue batch B (E2–E4) — queue-file prep | S | PREPARED (execution owner-gated) | 2026-08-09 | impl/task-T31-report.md | queue-1070/batch-B-2026-08-09.json: E2+E3+E4 (owner redmi; T16's two in-writing decisions carried) + T11-D5 bundled-shell eye item (deviation: pass-10 assigns it no batch) + 2 GATE-TEX bench riders (cmd null until T15). E2/E3 prereq T15 landed; E5 stays Batch C with a D-09.5 pull-in note. |
| T32 | batch C | 1070 queue batch C (E5–E6) — queue-file prep | S | PREPARED (execution owner-gated) | 2026-08-09 | impl/task-T32-report.md | queue-1070/batch-C-2026-08-09.json: E5 against the landed `?slotGrid` arm (prereq: T20 stage-4 report green; integrity-counter checklist) + E6 (prereq T22; full F-11.3 flag chain, ClipMap/depth-bias/shadowed-town/baked-light vantages) + MOVE-FIX-ST9 rider + GATE-GRID bench-set placeholder. |
| T40 | ST10 | legacy retirement (fires on SPEC §3 conditions only) | M | TODO | | | |

## Log (orchestrator only)

- 2026-08-08: Implementation phase opened. Slot policy: 1 critical-path + 1 independent, max 2. T10 + T01 launched.
- 2026-08-09: OOM incident (hard reboot ~03:10) killed T20 mid-task + the full-world bake; T11 finished just prior. Root cause + now-binding scheduling rules (R-MEM1..4), in-flight bake state, and full orchestrator state → `ORCHESTRATOR-HANDOFF.md` (keep that file current; it is the successor session's first read).
