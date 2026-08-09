# Pass 10 — Instrumentation and validation: diag schema, census protocol, bench suite, acceptance gates, 1070 queue

Pass 10 of 12. Governed by `TRACKING.md`'s protocol header. This pass exists because of
the measurement walls: a week of coherent designs measured 0.0 ms, four ~2× scale errors
landed in one day, and three research cycles were lost to stale verdicts. Its charge:
(1) the metrics/diagnostics spec for the NEW architecture — the `__diag` surfaces and
their successors, the memory census, the stall-probe successor; (2) the benchmark
protocol — fixed-pose bench, interleaved boot arms, ABAB rules, scale labeling — with
each wall encoded as a RULE with a concrete procedure, not advice; (3) per-metric
acceptance tests wired to pass 1's 24 budget IDs (every ID gets ≥1 owning test);
(4) the acceptance-gate names pass 9's stage cards reference, with the numeric noise
floors H-09.2c said the kills are unenforceable without; (5) the 1070 validation-queue
format; and (6) a CI-runnable / 1070-only / owner-eye-only classification for every
test, plus the complete debt→test mapping for every measurement debt passes 1–9 left.
Source classes per R7: **[M]** measured (doc/file named), **[D]** derived, **[A]**
assumed-pending-measurement.

## Inputs read

Opened in THIS session (file:line cited where load-bearing):

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all; §6 walls ledger).
- `docs/reengineering/pass-01-requirements-charter.md` — lines 1–401 (all; D-01.2 scale
  labels, S1 budget table B1–B5/C1–C5/F1–F6/M1–M9, S2 binding conditions, H6, Q2/Q4/Q5/Q6).
- `docs/reengineering/pass-02-world-pack-format.md` — lines 1–600 (all; H-02.6, Q1, Q3, Q5).
- `docs/reengineering/pass-03-wire-and-fetch.md` — lines 1–646 (all; S9 diag stub, H-03.5,
  Q1, Q2, Q6).
- `docs/reengineering/pass-04-geometry-spec.md` — lines 1–607 (all; S7 diag stub, H-04.6,
  Q2–Q5).
- `docs/reengineering/pass-05-texture-spec.md` — lines 1–768 (all; S8 diag stub, H-05.5,
  Q1–Q7).
- `docs/reengineering/pass-06-residency-architecture.md` — lines 1–686 (all; D-06.9 census
  deltas, S5 CI gates, H-06.4, Q1–Q7).
- `docs/reengineering/pass-07-scene-and-draw-architecture.md` — lines 1–795 (all; S5.3
  census gates, S7 diag stub, H-07.3, Q1–Q7).
- `docs/reengineering/pass-08-frame-loop-and-scheduling.md` — lines 1–745 (all; S7
  observability contract, H-08.2, Q1–Q6).
- `docs/reengineering/pass-09-migration-plan.md` — lines 1–783 (all; S2 stage cards' named
  measurements, D-09.5 batches, S6 kill table, H-09.1/H-09.2, Q1–Q6).
- `scene3d/stall_probe.js` — lines 1–771 (all): counter-differencing method (26–56),
  renderMs/outsideMs split (59–76), self-cost pricing (79–93, 717–735), GL wrap groups
  (179–223), `_sample` vector (251–384) incl. the `renderer.info.autoReset` per-frame trap
  note (295–299), `_LEVEL_KEYS` (389–394), `_MS_KEYS` = the only fields allowed into
  `explainedMs` (396–399), threshold 100 ms / ring 64 (133–137), wasm-grow blind spot
  (115–119), `liveScene3d`-snapshot caveat (430–435), disarm-keeps-ring (631–633),
  window surface `__stallArm/Disarm/Reset/Report/Samples` (757–770).
- `harness/moving-bench.mjs` — lines 1–297 (all): the 6.10 ms-delta-inside-6.60 ms-spread
  failure it replaces (10–18), frame-indexed pose table + frame-count run length + pinned
  anchor + warm lap (19–33), does-not-own-Chrome + 2.44× note (34–37), required page flags
  (56–62), `judge()` reject semantics (143–170), ondemand drive flags (130), cumulative-
  counter delta rule (271–279).
- `harness/flag-census/bootab.mjs` — lines 1–139 (all): interleaved A,B,A,B boot arms with
  Chrome relaunch between runs, 2.44×/100 min rationale (1–8), fresh-Chrome recipe via
  schtasks+tunnel (39–48), in-page sampler sets `info.autoReset = false` (50–63),
  draws-stability settle loop <3% before sampling (95–101), account release gate against
  the ACE log (34–35).
- `harness/flag-census/README.md` — lines 1–80: cross-boot p50 untrustworthy at small
  effects (25.2/25.8/31.4/32.3 ms across sessions, 23–27), measured-not-assumed noise band
  via time-bracketing interleaved baselines (44–50), `INSUFFICIENT-BASELINE` guard + the
  animSceneryInstanced +1,353-draw positive control (52–75).
- `harness/README.md` — lines 1–95: three-tier harness (Tier 1 host-JS headless / Tier 2
  cargo / Tier 3 Playwright in-browser), no npm/package.json — bare `node <file>` with
  exit codes (20–24), `run-all.mjs` single entry, moving-bench section (66–95).
- `harness/vistest-1070-round1-7.mjs` — lines 1–40: 1070 preconditions block (interactive-
  session Chrome, `--mute-audio`, off-screen window position, `--user-data-dir` as the only
  safe cleanup handle, `:9333`, tunnel with `-R 8080` wsbridge), never-closes-browser rule
  (22–24), `?nosw=1` mandatory note (38–39).
- `/home/wbterminal/from-vm/probe1070.cjs` — lines 1–213 (all): never `browser.close()`
  (2), attach-to-existing-page pattern (6–11), `draws` mode toggling `info.autoReset`
  (56–75), `bootpoll` mode reading `__bootState` + `terrainBakedLbs.size` (180–186),
  base64 `eval` mode (203–211).
- `apps/holtburger-web/src/lib.rs` — 11469–11593 (`hb_mem_census` full row inventory:
  surfacePixels/modelTri/shardRecords/surfaceHeight/sceneryRecords/suiteArtifacts/
  sceneryAnim/negCache/texSwapAliases/scratchPool/decodeDids + wasm_memory_bytes +
  hb_alloc LIVE/PEAK/TOTAL + decode-admission peak), 11411 (`mem_census_json` split note).
- `scene3d/index.js` — 4655–4700 (`__diag.wasmMem` sums main + bake-worker census with
  `missing`/`verdict`; `__diag.textures` gated on `texCensusEnabled`), 531/694/4180+
  (render/vfxGauge/particles diag registrations, grep-verified list), 68 (stall-probe
  import note).
- `scene3d/texture_census.js` — lines 1–60: WeakRef census rationale, `info.memory.textures`
  decrements only on dispose, the 702 MB→28 MB geometry retraction, FORCE-A-GC-FIRST rule
  (driver sends CDP `HeapProfiler.collectGarbage`), strict `?texCensus=on` opt-in that must
  never be armed inside a measurement of something else (34–46).
- `scene3d/diag.js` — 36 (`attachWire` import), 628–668 (`runAll(lbId)`: PASS/DRIFT/
  NO-ORACLE/INFRA verdict mapping + `missingSurfaces` honesty rule); `scene3d/diag/wire.js`
  — 11–34, 100, 134 (`summary()` shape).
- Registration sites (each read at its line): `__bc7Stats`/`__xu7Stats`
  (bc7_textures.js:812–813), `__terrainBc7Stats` (terrain.js:3965), `__atlasStats`
  (static_atlas.js:1003), `__linkProbe` (shader_prewarm.js:245), `__hbWasmMemory`
  (index.html:2269, 2291).
- `docs/2026-08-06-frame-cost-structure-measured.md` — 440–460 (in-session −1.2 ms vs
  interleaved-boot agreement; n=1 caveat style), 570–615 (measurement notes: in-session
  interleaving rationale, settle-on-draws, **pixel-diff 20.1% across arms vs 16.9%
  same-arm noise floor**, six-boot interleaved end-to-end: same-arm spreads 0.7/1.3 ms,
  7.40 ms delta ≈ 6× control spread, Chrome relaunched between every arm).
- `docs/RESULTS-statArrayMerge-AB-2026-08-06.json` — head (the rows/arm/verdict/errors/
  n/p50/p95/draws + per-instrument-object result shape this pass's RESULTS v2 supersedes).

## Decisions

### D-10.1 — Scale-tag vocabulary: every reported figure carries `@scale`, enforced at three points

The charter made scale labels normative prose (D-01.2); this pass makes them mechanical.
**Vocabulary (S1) is closed** — population scales (`resident`, `parked`, `staged`,
`drawn`, `submitted`, `wire`, `cached`, `allocated`, `used`, `pinned`, `leased`), boot
milestones (`in-world`, `preview-complete`, `converged`), motion regimes (`parked`,
`moving`), memory homes (`heap`, `wasmLinear`, `cpuMirror`, `vramEst`), and mandatory
statistic labels (`p50`/`p95`/`p99`/`mean`/`max`; a bare number is a p50 claim and is
forbidden).

**Enforcement points:**
1. **RESULTS v2 schema (S12):** every key in a `metrics` object is `<name>@<scale>`
   (e.g. `draws@submitted`, `instances@resident`, `bytes@wire`); the shared report writer
   (`harness/lib/report.mjs`, new) throws on an unsuffixed key. This is where four ~2×
   errors would have been caught — a figure cannot enter a report without declaring its
   population.
2. **Diag registry (S3):** every surface field is declared with kind
   (`counter`|`level`), unit (`Ms`|`Bytes`|count), and scale; a Tier-1 headless test
   (`harness/test_diag_schema.mjs`, new) lints the registry, and a Tier-3 conformance
   probe asserts the live page's surfaces match it. Units ride the field NAME (`*Ms`,
   `*Bytes`) — the stall probe's `_MS_KEYS` discipline (stall_probe.js:396–399)
   generalized: **only ms-denominated fields may ever be summed into an attribution;
   counts are never priced** (the "six 2×+ overestimates" lesson, same lines).
3. **Doc convention:** spec/report prose quotes figures with the tag inline (the pass 2–9
   practice, now required).

*Rejected:* per-figure free-text labels (unlintable); a runtime type system on diag
objects (cost without a failure mode the registry lint doesn't already catch).

### D-10.2 — Protocol classes: each wall becomes a numbered rule with a procedure; effect size selects the protocol

Normative rules PR-1..PR-14 and protocol classes PC-1..PC-8 in S2. The core table —
**which protocol a claimed effect size requires** — is grounded in this session's
read-verified numbers:

| effect size (frame-time class) | required protocol | measured basis |
|---|---|---|
| < 0.4 ms | not resolvable — do not claim; argue structurally or improve the instrument | pOFC 0.40 ms was at the floor of in-session resolution [M, frame-cost §3d via pass 7] |
| 0.4–1.5 ms | PC-1 in-session ABAB (≥3 interleaved pairs, settle-gated) | in-session −1.2 ms clipMap read clean; two boot-arm methods agreed only in direction [M, frame-cost:440–450] |
| ≥ 1.5 ms | PC-2 interleaved boot arms (fresh Chrome per arm) also acceptable | same-arm boot spreads 0.7–1.3 ms; 7.40 ms delta = 6× spread [M, frame-cost:590–612] |
| any moving figure | PC-3 fixed-pose bench only | 6.10 ms delta inside 6.60 ms control spread killed the live-pose rig [M, moving-bench.mjs:10–18] |
| any tail (p95+/hitch) figure | PC-7 stall-probe walk; never from a mean | p99 1,630 ms invisible to every p50 instrument [M, stall_probe.js:5–23] |
| cross-boot single shot | **valid for nothing** | session p50s 25.2/25.8/31.4/32.3 ms on identical config [M, flag-census README:23–27] |

Wire bytes/requests are deterministic and exempt from frame-noise rules (PC-4 applies its
own tolerances); memory routes are observational soaks (PC-5); census gates are
zero-tolerance integers (PC-6); structural render changes take PC-8 (owner eye) — no
metric protocol substitutes, and **pixel-diffs are inadmissible as evidence** at the
measured 16.9% same-arm animation noise floor (PR-8).

*Rejected:* a single universal protocol (over-pays for wire tests, under-powers tail
tests); statistical significance machinery (the flag-census bracketing-baseline approach
— measure the night's noise, compare against it — is proven and simpler; a fixed "5% is
significant" rule "would manufacture dozens of findings" [flag-census README:44–50]).

### D-10.3 — Diagnostic architecture: one registry, counters-vs-levels discipline, same-name successors, guarded reads

The new architecture's surfaces were stubbed by their owning passes (pass 3 S9 `__hbFetch`,
pass 4 S7 `__diag.geometry`, pass 5 S8 `__texStats`, pass 6 D-06.9 `__diag.residency`,
pass 7 S7 `__diag.pools`, pass 8 S7 `__framePhase`/`__frameWork`/`__prewarmStats`). This
pass fixes the FULL schemas (S3) and the contract rules:

1. **Counter or level, declared.** Every field is either a monotone session-cumulative
   accumulator (diffable across frame edges — the stall-probe method) or a level
   (absolute; differencing is meaningless or misleading). The stall probe's `_LEVEL_KEYS`
   /`_MS_KEYS` split (stall_probe.js:389–399) is the proven shape; the registry makes it
   per-surface data instead of probe-private knowledge.
2. **Same-name successor rule (adopted from pass 8 S7.3, made binding):** when a legacy
   surface retires (`__atlasStats` at ST9, `__landblockLru.getStats` at ST7), its
   successor publishes under a NAME the probe already samples with the SAME
   monotone-cumulative semantics, or the probe's `_sample` is updated in the same commit.
   An instrument reading zeros from a renamed surface is a silent-wrong-path trap of the
   bake-worker class.
3. **Guarded reads, absence ≠ zero claims.** Every cross-surface read is individually
   try-guarded and degrades to 0 (the `_sample` discipline, stall_probe.js:245–250), but
   reports list ABSENT surfaces by name (the probe's `linkProbe: "ABSENT — linkStatusMs
   will read 0"` pattern, stall_probe.js:735, and `runAll`'s `missingSurfaces` rule,
   diag.js:660–664). A gate scored while its instrument was absent is INVALID, not PASS.
4. **Install-timing ledger.** Late-stamped surfaces are listed in the registry with their
   availability milestone (`__landblockLru` ~35 s post-in-world [M, stall_probe.js:246];
   `__cam`/`__set*` post-in-world [M, frame-cost:583–585]; `liveScene3d` is a one-time
   init snapshot — late-stamped subsystems read null forever [stall_probe.js:430–435]).
   Benches poll for presence; they never assume.
5. **Diag namespace:** new benchmark-facing surfaces live flat on `globalThis`
   (`__hbFetch`, `__framePhase`, `__frameWork`, `__texStats`) or under `window.__diag`
   (`residency()`, `pools()`, `geometry`, `wasmMem()`) exactly as their owning passes
   named them — this pass does NOT rename; it completes fields. The oracle-diff family
   (`__diag.runAll`, `.wire.summary()`) is orthogonal correctness tooling and is retained
   untouched.

*Rejected:* one mega-`__diag.all()` aggregator (a single throw poisons every consumer;
per-surface guarded reads are the proven shape); `performance.mark`-based phases
(per-entry allocation + observer cost — pass 8 already rejected; plain fields are
probe-compatible).

### D-10.4 — Memory census protocol: forced-GC WeakRef discipline, three-instance summation, allocated+used everywhere

1. **Wasm side:** `hb_mem_census` with pass 6 D-06.9's row deltas (packBytes+pinned,
   packSections, leaseBuffer, suiteArtifacts budget, net-worker relay when armed). The
   `budget: −1 ⇒ stated structural bound` policy and the two CI gates (−1-row bytes
   > 4 MiB fails; `unattributed` growth > 32 MiB over the route fails) are adopted
   verbatim and wired in CENSUS-CI (S6). **M3 scoring rule:** a run whose census summed
   fewer instances than exist is INVALID (pass 6 S5 gate d); with `?netWorker` unset the
   sum is two instances and the run is valid at default config (pass 8's D-08.4
   precision adopted).
2. **JS heap:** `performance.memory.usedJSHeapSize` sampled as a level (Chrome-only;
   recorded per PR-12's instrument-pricing rule). Heap DROP across a long frame is GC
   evidence, not proof (stall_probe.js:120–122, kept as a reporting caveat).
3. **Instruments over-count on first contact — the rule (PR-11):** any census that
   claims "live/leaked/orphaned" bytes MUST (a) hold traced objects only via WeakRef,
   (b) force GC from the driver (CDP `HeapProfiler.collectGarbage`, ≥2 calls, ≥500 ms
   settle) before reading, and (c) report the un-GC'd first-poll figure as invalid. This
   is texture_census.js's contract (lines 29–46) elevated to a protocol rule — the same
   reasoning error uncorrected produced "702 MB of leaked geometry" that a WeakRef census
   corrected to 28 MB [M, texture_census.js:23–27].
4. **Tracer flags never ride measurements of something else.** `?texCensus=on` retains
   one record per texture for the life of the page — it is itself retention
   (texture_census.js:34–38). Census runs are DEDICATED runs; their taint field lists the
   tracer. Generalized: any diagnostic that retains or throttles (texCensus, stall probe
   armed, `?linkProbe`) is declared in the RESULTS `taint` list, and a budget may only be
   SCORED from a run whose taint list is empty or whose entries are certified
   non-perturbing for that metric (the stall probe prices itself for exactly this reason
   — PR-12).
5. **Allocated + used, always:** every pool/array/store row publishes both (pass 5 D-05.8,
   pass 6 S3, pass 7 S5.2 adopted); `used` is used-extent, never `position.count`
   [frame-cost §5c via pass 7]. M6 (allocated ≤ 1.5× used) is scored per class from these
   rows.
6. **Cadence on routes:** census snapshot at each town arrival + every 60 s, series into
   RESULTS; peak and end-state both reported (M1 binds on peak, M7 on end-state).

### D-10.5 — The stall probe is the tail instrument, retained; its sample vector is extended, not replaced

The probe's method — difference already-cumulative counters across one frame edge;
renderMs/outsideMs as the first discriminator; only ms-denominated buckets in
`explainedMs`; residual always reported; self-cost priced (`nowCostNs`, sampler p50,
GL-wrap overhead arithmetic) — survives the re-architecture unchanged
(stall_probe.js:26–93). Pass 8 D-08.8 already decided retention; this pass owns the
successor spec (S5):

- **Vector additions (same commit as the surfaces land):** `__framePhase` cumulative
  sums (refinement of pass 8 S7: phases publish BOTH last-frame values and cumulative
  `p0Ms..p4Ms` + `frames` — a per-frame-only vector cannot be differenced, which is the
  probe's entire method; reported under a separate `phases` section, NOT summed into
  `explainedMs` since they overlap the GL buckets); `__frameWork` per-class
  `{ran, deferredFrames, forcedRuns, maxItemMs, queueDepth}` + `mode` (mode is a level —
  TELEPORT/BOOT-labeled long frames are design-accepted, pass 8 S6); `__texStats.worker`
  `{jobs, msTranscode, queueDepth}`; `__hbFetch` failure/verify counters;
  `__diag.residency()` transition counters; `__diag.pools()` `mutationsThisFrame`/
  `events` counters.
- **New level: `wasmMemMB`** — `window.__hbWasmMemory.buffer.byteLength` (published at
  index.html:2269/2291; cheap property read). This closes the probe's own stated blind
  spot: a `memory.grow` copies linear memory and lands in `residualMs` unattributed
  (stall_probe.js:115–119). A `wasmMemMBΔ > 0` across a long frame is grow evidence.
- **Successor swaps:** `__atlasStats` reads → `__diag.pools()` fields at ST9;
  `__landblockLru.getStats` reads → `__diag.residency()` fields at ST7 (same-name-or-
  same-commit rule, D-10.3.2).
- **Instrument validation is a first-class run:** charter Q5 recorded that no completed
  1070 probe run exists in the record (the probe header's 1070 numbers,
  stall_probe.js:5–14, motivate it but do not prove the ring/bucket machinery ran to
  report). The FIRST TAIL-ULTRA run (S6) doubles as instrument validation: PASS requires
  `explainedMs + residualMs ≈ Σ intervalMs` (arithmetic identity), residual share
  reported, and the probe's self-cost < 1% of frame time. If buckets misattribute
  (large stable residual with a known cause), the successor instrument is a new bucket,
  not a new method.

### D-10.6 — The benchmark suite: eleven named benches + five named probes, each with a driver, platform, and protocol class

Full cards in S6; roster:

| bench | protocol | platform | drives | primary budgets |
|---|---|---|---|---|
| BOOT-666 | PC-4 wire | T2 CI (nullRender bot) | CDP-throttled cold boot, per-component attribution | B1 B2 B3 B4 |
| BOOT-WARM | PC-4 wire | T2 CI / 1070 (worker-throughput arm) | 2nd boot, warm cache | B5 (+DT-19 queue depth) |
| CROSS-COL | PC-4 wire | T2 CI | @teleloc westward hops at walk cadence, throttled | C1 C2 C3 C5 |
| DUNGEON | PC-4 wire | T2 CI | portal entry, cold + warm | C4 |
| PARKED-REF | PC-2 boot arms | 1070 | bootab-style, Nanto reference condition | F1 F2 |
| MOVE-FIX | PC-3 fixed-pose | 1070 | moving-bench orbit + hop modes, mid | F3 F4 (creates the baselines — charter Q2) |
| TAIL-ULTRA | PC-7 stall walk | 1070 | 60 s+ ultra walk, probe armed | F5 F6 |
| MEM-ROUTE | PC-5 soak | 1070 (binding) / T2 (smoke) | six-town route, census series | M1 M2 M3 M4 M7 |
| ULTRA-SOAK-30 | PC-5 soak | 1070 | 30-min ultra session | M5 M6 |
| T2-BOT | PC-6 gate | T2 CI | `?nullRender=1` boot + route | M8 M9 |
| CENSUS-CI | PC-6 gate | T2 CI | census/integrity gates headless | supports M3 M6 + stage gates |
| BAKE-CI | PC-6 gate | CI (no browser) | closure, determinism, differ, ratios, preview re-score | supports B1 C2 + ST1 |
| probes: P-SUBTLE, P-INITTEX, P-88MIB, P-ASSEMBLE, P-LIGHTBAKE | one-shot | 1070 (Batch A piggyback) | see S8 | — |

**Run-validity (taint) model, uniform across the suite:** every run records
`{commit, distGeneratedAt, url, taint[], wasmProfile}` and every bench inherits
moving-bench's **judge/reject semantics** (moving-bench.mjs:143–170): a run outside its
own repeatability budget is REJECTED with named reasons and never averaged in (PR-10).
Two new validity gates:
- **Release-wasm gate (PR-13):** the bench fetches `pkg/holtburger_web_bg.wasm`'s
  `Content-Length`; > 8 MB ⇒ verdict `DEV-WASM`, run invalid for any budget (release
  ≈ 4.5 MB vs dev ≈ 18 MB ≈ 4× decode tax — the ship-RELEASE rule, charter N6, made
  mechanical). A `hb_build_profile()` wasm export is the clean successor (open Q4).
- **Bare-default gate:** a budget is SCORED only from a run whose URL carries no tuning
  flags beyond the harness contract set (`nosw`, `autoLogin`-family, `agent`,
  `nullRender`/`renderOnDemand`/`netDrainHz` for bot modes, `renderDiag`/`camDebug`/
  `vfxGauge` instrumentation — the flag-census EXCLUDE precedent); anything else lands in
  `taint` and demotes the run to exploratory (charter S2's binding rule, enforced).

*Rejected:* building a new bench framework (moving-bench + bootab + flag-census are
proven; the suite standardizes their report format and generalizes their validity rules);
running F-benches on T2 (SwiftShader carries no frame targets, charter D-01.1).

### D-10.7 — Acceptance gates named for pass 9, with numeric noise floors and a mechanical console-error definition (H-09.1/H-09.2c discharged)

Pass 9's stage cards name their measurements descriptively; S9 fixes the gate IDs
(GATE-BAKE, GATE-WIRE-BOOT, GATE-GEOM, GATE-TEXWORKER, GATE-TEX, GATE-Q75, GATE-GRID,
GATE-SCHED, GATE-POOLS, GATE-RETIRE) so stage cards, kill rows, and SPEC.md reference
one vocabulary. The noise-floor rule that makes kills enforceable:

> **A "regression vs same-session arm" kill fires iff the delta exceeds
> `max(2 × measured same-arm control spread, protocol floor)`** — where the control
> spread is measured WITHIN the deciding run (bootab reports per-arm run lists;
> PC-1 requires ≥3 interleaved pairs; flag-census brackets baselines in time), and the
> protocol floor is 0.4 ms (PC-1), 1.0 ms (PC-2), 1.0 ms on p50 / 20% on p99 (PC-3/PC-7),
> ±2% bytes / +0 requests (PC-4, retries reported separately and a retry-inflated run is
> re-run), max(10%, 100 MB) on peaks (PC-5), 0 (PC-6). A kill argued from a delta inside
> the band is invalid; a spread wider than 2× the floor invalidates the RUN, not the
> stage (re-run, don't average — PR-10).

**Console-error harness (the promotion bar's "0 console errors", mechanical form):**
collect `page.on("pageerror")` + console messages of type `error` from navigation start
to scenario end; PASS iff zero after subtracting the allowlist
(`harness/lib/console_allowlist.mjs`, new — each entry `{pattern, evidence, added}`;
seed entry: the benign "no MotionTable link for attack 0x13xxxxxx" QuickEmote class).
Warnings are recorded in the RESULTS file and triaged, never gating. An allowlist entry
without an evidence citation fails the Tier-1 lint.

### D-10.8 — 1070 validation-queue format: one JSON file per batch, verdicts written back, sessions quantized

Format in S10. Files live at `docs/reengineering/queue-1070/batch-<A|B|C|…>-<date>.json`
(inside this pass's writable tree; created at first use, not now). Each item is fully
prepared — URL pair, vantage list (telepoi/teleloc + camera pose), checklist, artifact
list — so the owner's cost per item is minutes (pass 9 S5.2's requirement given a
format). Session rules ride the file as a normative preamble block and restate the fleet
constraints read-verified this session (vistest-1070:1–27, probe1070.cjs:2): off-screen/
headless only, `--mute-audio`, CDP `:9333` attach to the existing interactive-session
Chrome, match test Chrome by `--user-data-dir` only, NEVER `browser.close()`, `?nosw=1`
on every URL, fresh `--user-data-dir` per bench ARM (PR-3) while eye items may share one
session, `-R 8080` wsbridge tunnel or logins die. Verdicts (`CLEAN`/`DIRTY` for eye
items; result JSON for probes/benches) are written back into the SAME file plus the
url-flags §0 row (pass 9 S5.4). Screenshots are captured for the owner's eye and archived
in RESULTS; they are never pixel-diffed as evidence (PR-8).

*Rejected:* a tracking-doc table instead of JSON (verdicts must be machine-joinable to
stage gates and RESULTS); ad-hoc session scheduling (the batching rule exists because
ad-hoc sessions on a person's machine are the failure mode).

### D-10.9 — Classification and completeness: every test is CI / 1070 / OWNER-EYE, and every prior-pass debt has a row

S11 classifies every named test. The split principle: **wire and census tests are
CI-runnable** (bytes/requests/counters are deterministic and GPU-free — BOOT/CROSS/
DUNGEON run as T2 nullRender bots; BAKE-CI needs no browser); **frame, tail, and
binding-memory tests are 1070-only** (T1 is the perf reference, charter D-01.1);
**structural render verdicts are owner-eye-only** (PR-8). CI cadence: BAKE-CI + CENSUS-CI
+ T2-BOT + Tier-1 lints on every stage landing; wire benches per stage gate; 1070 benches
quantized to the pass 9 batches.

**Completeness rule (the charge's compliance bar):** S8 maps EVERY measurement debt from
passes 1–9's Open questions and pass-10-directed handoffs to an owning test/probe/gate or
an explicit non-measurement disposition (owner call / pass 11 / post-v1 register). A debt
without a row is a compliance failure of THIS pass; pass 11 is invited to diff S8 against
the sources.

## Spec

### S1 — Scale-tag vocabulary (normative, closed)

| axis | tags | notes |
|---|---|---|
| population | `resident` · `parked` · `staged` · `drawn` · `submitted` · `wire` · `cached` · `allocated` · `used` · `pinned` · `leased` | `drawn` = survived culling; `submitted` = draw calls issued. resident ≠ drawn ≠ submitted is the founding wall. |
| boot milestone | `in-world` · `preview-complete` · `converged` | charter D-01.2 definitions verbatim; `__hbFetch.milestones` stamps them (S3). |
| motion regime | `parked` · `moving` | never comparable populations (wall). |
| memory home | `heap` · `wasmLinear` · `cpuMirror` · `vramEst` | `vramEst` = allocated-byte estimate, no direct instrument exists (charter D-01.6). |
| statistic | `p50` · `p95` · `p99` · `mean` · `max` | mandatory on every latency/frame figure; a bare number is invalid. |
| unit (field-name suffix) | `*Ms` · `*Bytes` · unsuffixed = count | only `*Ms` fields may enter attribution sums (D-10.1). |

RESULTS metric keys: `<name>@<scale>`; multi-axis where needed
(`bytes@wire@preview-complete`). The report writer rejects unsuffixed keys.

### S2 — Protocol rules (the walls as procedures) and protocol classes

**PR-1 (scale tags).** Every figure carries S1 tags; enforcement per D-10.1. *Wall:
resident≠drawn≠submitted; allocated≠used.*

**PR-2 (effect-size → protocol).** Per the D-10.2 table. A claim made under a weaker
protocol than its effect size requires is not evidence. *Wall: boot variance swamps
< 1 ms.*

**PR-3 (fresh Chrome per arm).** No Chrome process is reused across boot arms; measured
2.44× degradation over ~100 min [M, bootab.mjs:3–6]. Procedure: bootab's kill → relaunch
(schtasks task) → tunnel re-establish → CDP poll (bootab.mjs:39–48). Fresh
`--user-data-dir` per A/B arm additionally defeats shader-cache warming (memory-trap d).
In-session (PC-1) arms share a page BY DESIGN — that is the point of in-session toggles.

**PR-4 (moving figures → fixed-pose bench).** Any moving frame-time figure comes from
moving-bench.mjs or a bench with its four properties: frame-indexed pose table,
frame-count run length, pinned anchor, warm lap + identical measure lap
(moving-bench.mjs:19–33). Runs self-reject on path-checksum divergence, streaming churn
(orbit mode), draw-spread > 5%, short frames, or gauge gaps (judge(), :143–170).

**PR-5 (tail by counter-differencing).** Tail figures come from the armed stall probe:
p50/p95/p99 from the SAME clock that fills the ring (stall_probe.js:671–699); long
frames attributed via ms-buckets + renderMs/outsideMs; residual always reported. Averages
cannot see the tail; a mean is never quoted as a hitch claim.

**PR-6 (allocated ≠ used).** Census rows and pool surfaces publish both; `used` =
used-extent; M6 scored from the pair. Never `position.count`, never GL texture counts as
liveness (texture_census.js:12–22).

**PR-7 (autoReset trap).** Any draws/tris sampling sets `renderer.info.autoReset = false`,
resets, reads cumulative, divides by frames, restores prior state (bootab sampler
:50–63; probe1070 `draws` mode :56–75). Differencing a per-frame counter is meaningless
(stall_probe.js:295–299 carries them as levels for this reason).

**PR-8 (flag-bit ≠ predicate; eyes for structure).** Structural render changes (pass
membership, keying, winding, quantization, tier classes) take an owner eye-test; every
recorded metric read clean through the ClipMap failure. Pixel-diffs are inadmissible: the
same-arm animation noise floor is 16.9% of pixels vs 20.1% across arms on a real change
[M, frame-cost:577–580]. Flag state is read via `*Enabled()` functions, never doc
comments (R4 trap; pass 7's live catch of statics.js:2435).

**PR-9 (never derive frame wins from draw arithmetic).** draws-removed × µs/draw does not
predict (statArrayMerge −23 draws = 0.0 ms); draw count is a poor proxy (−12.1% draws =
−2.8% frame). Benches report draw/switch counts as diagnostics, never as priced wins.
Charter D-01.5's derivation prohibition applies to every report this suite emits.

**PR-10 (reject, never average).** Every bench defines reject criteria and emits
USABLE/REJECT + reasons (the judge pattern); rejected runs are excluded whole. The
2.44×-drifted overnight census (42 unusable runs) is the anchor [M, moving-bench.mjs:32].

**PR-11 (census after forced GC, WeakRef held).** Per D-10.4.3. First-contact figures
over-count and are invalid.

**PR-12 (price the instrument).** Probes report their own cost (nowCostNs, sampler
percentiles, wrap-overhead arithmetic — stall_probe.js:717–735) and retaining/throttling
diagnostics ride the taint list (D-10.4.4). A bucket is never quoted without its
population (stall_probe.js:93).

**PR-13 (release wasm, bare default).** Per D-10.6's validity gates. A pipeline that hits
targets only under opt-in flags has not hit them (charter S2).

**PR-14 (settle and presence gates).** Frame sampling starts only after draws/frame
stabilizes (< 3% across two 4 s windows — bootab :95–101); boot polls accept
`ready` OR `in-world` (the ~350 ms transition trap, frame-cost:583–585); streaming
progress is confirmed via `terrainBakedLbs.size` plateau, never `pose.landblockId`
(can freeze — memory trap; probe1070 bootpoll :180–186); late-stamped surfaces are
polled per the D-10.3.4 ledger.

**Protocol classes:**

| class | procedure (driver) | resolves | scope |
|---|---|---|---|
| PC-1 in-session ABAB | live-toggle flag, ≥3 interleaved pairs, PR-14 settle between arms, one page | ≥ 0.4 ms | flags toggleable without reboot |
| PC-2 interleaved boot arms | A,B,A,B…, PR-3 fresh Chrome, ≥2 boots/arm (REPS≥2), per-arm run lists reported | ≥ 1.5 ms (≥ 1.0 ms floor) | boot-coupled flags (bootab.mjs) |
| PC-3 fixed-pose moving | moving-bench orbit (settled) / hop (streaming-on-purpose) modes, PR-4 | ≥ 1.0 ms p50; p99 claims need ≥ 1,800 frames or PC-7 | moving F-budgets |
| PC-4 wire | CDP `Network.emulateNetworkConditions` ≈ 666 kbps (83 KB/s down, 80 ms RTT [A latency]); requests + `encodedDataLength` from CDP Network events (network layer, charter S2); component classification via manifest+index URL map; cold = fresh profile, warm = second boot same profile, stated | bytes ±2%, requests exact | B/C budgets |
| PC-5 route soak | six-town route (Holtburg→Arwic→Yaraq→Sawato→Shoushi→Nanto) or 30-min ultra; census cadence D-10.4.6; observational — decisions still need PC-1/2/3 arms | peaks/growth per D-10.7 floors | M budgets |
| PC-6 census/CI gate | headless read of counters; integer zero-tolerance | exact | integrity/coverage gates |
| PC-7 stall walk | stall probe armed (threshold 100 ms, ring 64 defaults), 60 s+ walk or route leg, report + ring archived | tail attribution | F5/F6, stage tail arms |
| PC-8 owner eye | 1070 queue item, prepared URL pair + vantages + checklist, CLEAN/DIRTY | structural correctness | E-register items |

### S3 — Diagnostic surface registry (normative; kind C=counter, L=level; scale tags per S1)

**`globalThis.__hbFetch`** (pass 3 S9, completed here; owner: PackFetchController):

```
lanes.{U,B,R,T}: {queued L, inflight L, done C, failed C, bytes C@wire}
verify: {engine L("subtle"|"wasm"), ok C, mismatch C, msTotal C}
retries C · quarantined L[tileIds] · pinnedIndex L(hash16)
milestones: {inWorldMs L, previewCompleteMs L, convergedMs L}      # NEW: converged stamp
byComponent: {code, manifestIndex, core, meta, tiles, interior, pvw,
              terrainTier, texFull}: {requests C, bytes C@wire}     # NEW: B1-component attribution
wireWaitEvents C   # NEW: frames where lane-U content the player occupies was not
                   # resident at need — THE C5 instrument (0 = pass)
taint L[]
```

**`window.__diag.residency()`** (pass 6 D-06.9.4 verbatim + additions):

```
grid: {W L, anchor L, slots {live,parked,fetching,staged,quarantined} L@resident,
       shifts C, teleports C, shiftMismatches C, slotDesyncs C}
park: {tiles L@parked, bytes L@allocated, usedBytes L@used,   # NEW used pair (PR-6)
       floorMs L, deferredCount C, deferredBytes C, reAdoptCancels C}
ladder: {rung L, r4Engagements C, floorLowerings C}
wasm: {perInstance census summaries L, summedBytes L@wasmLinear, instancesSummed L}
tex: (__texStats byClass vs budgets)
heap: usedJSHeapSize L@heap
pinLeaks C · leaseBytesPeak L
```

**`window.__diag.pools()`** (pass 7 S7 verbatim + M6 pair):

```
pools: {count L, byClass L, byPass L}
classes: {count L, createdPostBoot C}
nodes: {scene L, worldStatic L, entity L}
geometry: {allocatedBytes L@allocated, usedBytes L@used, dedupHits C}
events: {feeds C, parks C, adopts C, releases C, bandSwaps C, cellFlips C,
         mutationsThisFrame L}
draws: {submitted L@submitted, switchRate L, programSwitches L}   # PR-7 sampling rules
```

**`globalThis.__framePhase`** (pass 8 S7, refined per D-10.5): `{p0..p4 L(last-frame ms),
p0Ms..p4Ms C, frames C}` — cumulative sums added so the probe can difference.

**`globalThis.__frameWork`** (pass 8 S7 verbatim): per-class W1–W6
`{ran C, deferredFrames C, forcedRuns C, maxItemMs L, queueDepth L}`, `mode L`,
`uploads: {stagedBytesByClass C@staged, initTextureCalls C, exclusive L[ring 16]}`.

**`globalThis.__texStats()`** (pass 5 S8 verbatim): `{tiers: {pvwHits C, fullSwaps C,
demotions C}, worker: {jobs C, msTranscode C, queueDepth L, maxQueueDepth L,
fallbackArm L}, mirrors: {byClass L@cpuMirror}, arrays: {alloc L@allocated,
used L@used, mipBytes L}, rehydrate, coverage: {texrefMissingPvw L — MUST stay 0}}`.

**`window.__diag.geometry`** (pass 4 S7 verbatim): `{bundles: {assembled C, bytesOut C,
msAssemble C}, entityDecode: {count C, msTotal C, substKeyDupes C},
geomFallback: {modelsServedByRuntimeDecode C}}`.

**`window.__prewarmStats`** (pass 8 S5.4): `{classes L, colorPrograms L, depthPrograms L,
msColor L, msDepth L}`.

**Retained legacy surfaces** (until their ST retirement, same-name successor rule):
`__bc7Stats()`/`__xu7Stats()` (bc7_textures.js:812–813), `__terrainBc7Stats()`
(terrain.js:3965), `__atlasStats()` (static_atlas.js:1003) → `__diag.pools()` at ST9,
`__landblockLru.getStats()` → `__diag.residency()` at ST7, `__linkProbe`
(shader_prewarm.js:245), `__diag.wasmMem()`/`__diag.textures()` (index.js:4667/4697),
`__diag.render`/`vfxGauge`, the oracle-diff family (`__diag.runAll`, `wire.summary()` —
diag.js:638, wire.js:134), `__hbWasmMemory` (index.html:2269).

**Registry artifact:** `harness/lib/diag_schema.mjs` (new) declares every surface/field/
kind/unit/scale + availability milestone; `harness/test_diag_schema.mjs` (Tier 1) lints
it; a Tier-3 descriptor asserts live conformance. Registry lands with ST2 (first new
surface) and grows per stage.

### S4 — Memory census protocol (normative)

1. Poll `__diag.wasmMem()` (main + bake worker summed; `missing` names any half that
   cannot answer — index.js:4667–4681); net-worker relay added when `?netWorker=1`
   (pass 8 S3). Row inventory = lib.rs:11469–11593 today + pass 6 D-06.9 deltas.
2. Heap level from `performance.memory`; texture-mirror census via texture_census under
   PR-11 (dedicated run, forced GC, WeakRef).
3. Route cadence per D-10.4.6; RESULTS carries the full series + peak + end-state.
4. CENSUS-CI gates (all PC-6, zero-tolerance): −1-row bytes > 4 MiB; `unattributed`
   growth > 32 MiB/route; `pinLeaks`/`shiftMismatches`/`slotDesyncs` ≠ 0;
   `texrefMissingPvw` ≠ 0; parked-frame `poolMutationsPerFrame` ≠ 0;
   `classesCreatedPostBoot` ≠ 0 after ring settle; worker census `packBytes`/
   `shardRecords` ≠ 0 post-migration; M3 sum missing an existing instance ⇒ run INVALID.

### S5 — Tail instrument successor spec (stall probe v2)

Changes to `scene3d/stall_probe.js` (landed with the surfaces they read, ST7–ST9):
extend `_sample` with the D-10.5 vector additions (guarded reads, ABSENT-reported);
add `wasmMemMB` to `_LEVEL_KEYS` with Δ reporting; swap retiring surfaces per the
successor rule; keep `_MS_KEYS` as the only attribution fields, adding
`msTranscode` (worker — reported but NOT summed into `explainedMs`: worker time is
off-thread and only its integration cost lands in a frame; summing it would re-create
the count-pricing error in ms clothing); keep arm/disarm/reset/report contracts,
thresholds, and the no-URL-flag zero-cost-until-armed contract (stall_probe.js:96–105).
Validation-run acceptance per D-10.5. The probe remains the ONLY sanctioned tail
attribution instrument; per-subsystem wall-clock timers are rejected for the reasons its
header states (wrapping detached continuations, stall_probe.js:28–34).

### S6 — Bench cards (normative)

Common: RESULTS v2 output (S12); PR-10 judge with per-bench reject criteria; PR-13
validity gates; instrument presence per PR-14.

**BOOT-666** — cold boot to `converged`, emulated 666 kbps (PC-4). Driver: fresh
profile, T2 bot flags (`?nullRender=1&renderOnDemand=1&netDrainHz=30&nosw=1` + autologin),
CDP network domain enabled BEFORE navigation; throttle 83 KB/s / 80 ms. Metrics:
`bytes@wire@in-world`, `bytes@wire@preview-complete` (B1 ≤ 12 MB),
`requests@preview-complete` (B2 ≤ 64), serial depth (B3 ≤ 4 — computed from the
`__hbFetch` waterfall: each request records its triggering cause; depth = longest
dependency chain), `bytes@wire@converged` (B4 ≤ 45 MB, lane-T settle ≤ 20 min throttled),
per-component table vs pass 2 S6.1/pass 5 D-05.2 (attribution mandatory — H-02.6/H-03.5),
milestone timestamps, console-error gate. Reject: any hash-mismatch retry storm
(> 3 retries), taint, DEV-WASM. Arms: packs vs legacy interleaved for ST2's kill row —
byte/request comparisons are deterministic, so REPS=2 suffices.

**BOOT-WARM** — second boot, same profile (PC-4). B5: ≤ 1 MB / ≤ 5 requests network
(HTTP-cache hits excluded at the network layer — CDP reports served-from-cache
separately). 1070 arm variant reads `__texStats.worker.maxQueueDepth` for DT-19.

**CROSS-COL** — crossing wire + residency (PC-4). Driver: T2 bot; westward `@teleloc`
LB-hops at walk cadence (1 LB / 27 s — the headless walk substitute, memory §ace-admin;
hop-mode precedent moving-bench.mjs:53–55), 20 columns, throttled. Metrics: per-column
`requests` (C1 ≤ 12), `bytes@wire` mean/max (C2 ≤ 1.5 MB), warm-arm re-crossing
`bytes@wire` (C3 = 0), `__hbFetch.wireWaitEvents` (C5 = 0), lookahead-hit rate.
Streaming confirmed via `terrainBakedLbs.size` growth (PR-14).

**DUNGEON** — portal entry (PC-4): first-ever (`bytes@wire@preview-complete` ≤ 2 MB,
C4) and revisit arms; interior-promotion latency (lane-U promote → resident) reported.

**PARKED-REF** — F1/F2 (PC-2, 1070). bootab.mjs shape at the charter's reference
condition (quality mid, ~1200×1013, renderScale 1, adaptiveRes off, settled Nanto,
Chrome relaunch per arm, PR-14 settle, ≥ 9 s sample after stability). Metrics:
`frameMs@parked` p50 (F1 ≤ 16.7) / p95 (F2 ≤ 22), `draws@submitted`, ktris — PR-7
sampling. Scoring runs are single-arm (target vs absolute); kill rows use two-arm
interleave.

**MOVE-FIX** — F3/F4 (PC-3, 1070). moving-bench.mjs verbatim: orbit mode (settled,
churnMax 0) for F3 (`p50@moving ≤ 1.25× same-session parked p50` — the parked reference
sampled in the SAME session before the rig installs), hop mode for streaming-loaded
moving; ≥ 1,800 frames when p99 (F4 ≤ 60 ms) is scored, else F4 defers to TAIL-ULTRA's
mid-quality variant. First accepted run CREATES the F3/F4 baselines (charter Q2 retired).

**TAIL-ULTRA** — F5/F6 (PC-7, 1070). Ultra + clouds + wxMap per the probe's reference
header; arm probe; 60 s+ walk (hop-cadence path); report + ring archived. Pass: F5
p99 ≤ 150 ms AND `linkStatusMs` delta = 0 across the walk with `__prewarmStats`
cross-check (DT-48); F6: no frame > 250 ms attributed to streaming buckets while
`__frameWork.mode = NORMAL` (TELEPORT/BOOT-labeled frames excluded by design, pass 8
S6). Mid-quality variant scores F4. Worker-dead arm (`?texWorkers=0`) per DT-50.

**MEM-ROUTE** — M1/M2/M3/M4/M7 (PC-5, 1070 binding). Six-town route via telepoi hops,
census cadence per D-10.4.6. Pass: heap peak ≤ 1.6 GB (M1), growth after 3rd town
≤ 150 MB (M2), summed wasm ≤ 512 MiB with instance-validity rule (M3), mirror census
≤ 250 MB by class (M4 — dedicated texCensus arm under PR-11), geometries end-state
baseline ±10% (M7). Store-occupancy series re-classes pass 6's [A] budgets (DT-27).

**ULTRA-SOAK-30** — M5/M6 (PC-5, 1070). 30-min ultra session; 0 context losses (M5);
per-class allocated:used ≤ 1.5 (M6) from the S3 pairs.

**T2-BOT** — M8/M9 (PC-6, CI). `?nullRender=1` boot ≤ 120 s, 0 page errors (M9);
heap ≤ 1.2 GB over the bot route (M8 — first run re-classes charter Q6). Runs per
stage landing.

**CENSUS-CI** — S4.4 gates headless (PC-6, CI). Runs per stage landing + nightly.

**BAKE-CI** — no-browser gates (PC-6, CI): `--verify-closure` (incl. TEXREF-PVW
coverage), `--verify-deterministic`, byte-identity differ (bundle ≡ runtime decode,
N ≥ 50 models + 10 envcells), zstd ratio report (pins pass 2 Q1 / pass 4 Q1 → re-scores
B1 slack), ring preview re-score with the 128² cap (retires pass 5 Q1 / DT-02), ring
full-tier commons-domination check (DT-26), vertex-count tail census (DT-14).

**Probes** (one-shot, Batch A piggyback per pass 9 D-09.5): **P-SUBTLE**
(`crypto.subtle` presence + SHA-256 throughput at pack sizes on the plain-http tailnet
origin; decides the verify engine, pass 3 Q1); **P-INITTEX** (`renderer.initTexture` on a
`CompressedArrayTexture` with pending `layerUpdates`: stage in P4-equivalent, assert next
render's `texUploadMs` ≈ 0 via the probe's GL wrap — pass 8 Q2); **P-88MIB** (t1024 pair
staging ms, whole and 44/44 split, vs the 250 ms F6 line — pass 8 Q3); **P-ASSEMBLE**
(bundle assembly µs/model over a ring's models — pass 4 H-04.6b); **P-LIGHTBAKE**
(envcell light-bake µs/cell over p50/p90 interiors — the pass 6 dual-instance
load-bearing unknown, Q2).

### S7 — Budget → test coverage (every pass 1 budget ID; scale + pass condition)

| ID | owning test | metric@scale | pass condition | class |
|---|---|---|---|---|
| B1 | BOOT-666 | bytes@wire@preview-complete | ≤ 12 MB (per-component table attached) | CI |
| B2 | BOOT-666 | requests@preview-complete | ≤ 64 | CI |
| B3 | BOOT-666 | serial depth (waterfall) | ≤ 4 | CI |
| B4 | BOOT-666 (converged tail) | bytes@wire@converged | ≤ 45 MB (tracked risk per pass 5 D-05.3 until ST6 decision) | CI |
| B5 | BOOT-WARM | requests + bytes@wire | ≤ 5 req / ≤ 1 MB | CI |
| C1 | CROSS-COL | requests/column | ≤ 12 | CI |
| C2 | CROSS-COL | bytes@wire/column | ≤ 1.5 MB max measured column | CI |
| C3 | CROSS-COL warm arm | bytes@wire | 0 | CI |
| C4 | DUNGEON | bytes@wire@preview-complete | ≤ 2 MB | CI |
| C5 | CROSS-COL throttled | __hbFetch.wireWaitEvents | 0 over 20 columns | CI |
| F1 | PARKED-REF | frameMs@parked p50 | ≤ 16.7 ms | 1070 |
| F2 | PARKED-REF | frameMs@parked p95 | ≤ 22 ms | 1070 |
| F3 | MOVE-FIX orbit | frameMs@moving p50 | ≤ 1.25× same-session parked p50 | 1070 |
| F4 | MOVE-FIX (≥1800 fr) / TAIL-ULTRA mid | frameMs@moving p99 | ≤ 60 ms | 1070 |
| F5 | TAIL-ULTRA | p99 + linkStatusMs delta | ≤ 150 ms AND 0 links | 1070 |
| F6 | TAIL-ULTRA | attributed hitches, mode=NORMAL | no streaming-attributed frame > 250 ms | 1070 |
| M1 | MEM-ROUTE | heap peak L@heap | ≤ 1.6 GB | 1070 |
| M2 | MEM-ROUTE | heap growth after 3rd town | ≤ 150 MB | 1070 |
| M3 | MEM-ROUTE | Σ wasmLinear (instance-valid) | ≤ 512 MiB; ≤ 64 MiB warm growth | 1070 |
| M4 | MEM-ROUTE texCensus arm | cpuMirror bytes by class | ≤ 250 MB + re-supply paths registered | 1070 |
| M5 | ULTRA-SOAK-30 | context losses | 0 | 1070 |
| M6 | ULTRA-SOAK-30 + CENSUS-CI | allocated:used per class | ≤ 1.5× | 1070/CI |
| M7 | MEM-ROUTE | geometries end-state | baseline ±10% | 1070 |
| M8 | T2-BOT | heap@heap on 8 GB box | ≤ 1.2 GB | CI |
| M9 | T2-BOT | boot wall-clock + page errors | ≤ 120 s, 0 errors | CI |

### S8 — Debt → test mapping (complete inventory, passes 1–9)

| DT | source | debt | disposition |
|---|---|---|---|
| 01 | P2 Q1 / P4 Q1 | zstd-19 section + HBG1 ratios | BAKE-CI ratio report (ST1) |
| 02 | P2 Q3 / P5 Q1 / H-05.5a | ring preview re-score @128² cap (B1 spread) | BAKE-CI preview re-score (ST1) |
| 03 | P2 H-02.6 / P3 H-03.5 | boot bench per-component attribution + determinism CI | BOOT-666 + BAKE-CI |
| 04 | P2 Q5 / P4 H-04.7 | walk-widening closure completeness (MotionTable/sound/degrade edges) | BAKE-CI closure gate (bake work item measures coverage) |
| 05 | P3 Q1 / H-03.5 | crypto.subtle on the 1070 origin | P-SUBTLE (Batch A) |
| 06 | P3 Q2 / H-03.5 | fetch-cap tuning (12/4/4 [A]) | BOOT-666 cap-sweep arms (exploratory, tainted) |
| 07 | P3 H-03.5 | controller main-thread residual | GATE-PHASE census + TAIL-ULTRA buckets |
| 08 | P3 Q6 / P9 Q4 | legacy-lane starvation, 119-spawn bursts | CROWD-BURST probe: crowded-server session, `__diag.geometry.entityDecode` + lane counters; 1070 or T2 bot vs live ACE |
| 09 | P3 H-03.5 | full `__hbFetch` spec | DISCHARGED — S3 |
| 10 | P4 H-04.6b | bundle assembly µs/model on 1070 | P-ASSEMBLE (Batch A) |
| 11 | P4 H-04.6c / Q4 | entity-decode counters → substitution-cache gate | S3 `entityDecode` + CROWD-BURST; enable-threshold = owner call on its data |
| 12 | P4 H-04.6d | byte-identity differ | BAKE-CI (ST1 gate 3) |
| 13 | P4 Q2 | setup/envcell vertex-count tail | BAKE-CI first-run census |
| 14 | P4 Q3 / P6 Q2 / H-06.4 | envcell light-bake cost (dual-wasm load-bearing unknown) | P-LIGHTBAKE (Batch A) |
| 15 | P4 Q5 | f16-UV texel swim | E8 (queue register, post-v1) |
| 16 | P5 H-05.5b / Q4 | worker transcode throughput + warm queue depth | BOOT-WARM 1070 arm |
| 17 | P5 H-05.5c | M4/M5 census vs class budgets | MEM-ROUTE + ULTRA-SOAK-30 |
| 18 | P5 H-05.5d / Q6 | texrefMissingPvw = 0 coverage | BAKE-CI + CENSUS-CI |
| 19 | P5 H-05.5e / Q3 | NRA half-res parity | E3 (Batch B) |
| 20 | P5 Q2 / P9 Q1 | q75 eye + B4 owner decision | E4 (Batch B) + owner decision recorded at ST6 |
| 21 | P5 Q5 | no-BPTC population | not benchable here — field counter (`bc7Available()=false` boots counted on diag) + owner call; honest gap |
| 22 | P5 H-05.6 | full-tier commons-domination assumption | BAKE-CI ring full-tier script (DT-26 in S6) |
| 23 | P6 Q1 / H-06.4 | store-budget occupancy re-classing | MEM-ROUTE census series |
| 24 | P6 Q3 / H-06.4 | park-pool byte-estimate fidelity | MEM-ROUTE cross-check vs heap census |
| 25 | P6 Q4 / P1 Q4 | net-worker linear | census relay + one MEM-ROUTE arm with `?netWorker=1` (flag-conditional, pass 8 D-08.4) |
| 26 | P6 Q5 / H-06.4 | ladder thresholds, synthetic pressure R1→R4 | P-LADDER probe (heap balloon; T2-runnable, 1070 confirm) |
| 27 | P6 H-06.4 | zig-zag oscillation (`reAdoptCancels` absorbing) | BENCH-ZIGZAG: boundary-oscillation hop script, CI (headless residency logic) |
| 28 | P6 H-06.4 | teleport-settle vs battery baselines | BENCH-TELEPORT: telepoi settle timing, CI + 1070 |
| 29 | P6 H-06.4 / S5 | census CI gates wired | DISCHARGED — CENSUS-CI (S4.4) |
| 30 | P6 Q7 | sealed-tile pin cost | implementation-review row (not a measurement); first ST7 review |
| 31 | P7 Q1 / H-07.3 | class cardinality census (Nanto + Town Network) | CENSUS-CLASS probe: classifier over live materials, CI-runnable + 1070 confirm; gates pools ≤ 300, classes vs [A] ≤ 48 |
| 32 | P7 Q2 | translucent-residue population | CENSUS-CLASS (same run) |
| 33 | P7 Q3 / H-07.3 | sector-cull tri inflation + GPU-boundedness re-check | PARKED-REF + MOVE-FIX ktris arms; boundedness via renderScale sweep re-run when ktris regress (charter D-01.5 duty) |
| 34 | P7 Q5 | envcell range-flip cost at dense hubs | P-HUBFLIP: Town Network renderSet-delta timing (1070) |
| 35 | P7 Q6 | band-tick params (`bandSwaps`) | MOVE-FIX counters |
| 36 | P7 H-07.3 | switch-rate/programSwitches vs 71%/160 | PARKED-REF + MOVE-FIX diagnostics (PR-9: reported, never priced) |
| 37 | P7 H-07.3 | parked `mutationsThisFrame = 0` | CENSUS-CI parked gate |
| 38 | P7 Q7 / P9 E6 | receiveShadow generalization vantage | E6 checklist line (Batch C) |
| 39 | P7 D-07.5 | pool-feed cost per tile (W3 item bounds) | `__frameWork.maxItemMs[W3]` during CROSS-COL/GATE-PHASE |
| 40 | P8 Q1 / H-08.2a | phase census re-classing S1 [A] budgets | GATE-PHASE: one instrumented 1070 session with `__framePhase` |
| 41 | P8 Q2 / H-08.2b | initTexture + layerUpdates in-app | P-INITTEX (Batch A) |
| 42 | P8 Q3 / H-08.2c | 88 MiB terrain staging ms | P-88MIB (Batch A) |
| 43 | P8 H-08.2d / Q4 | scheduler tuning + fast-line under-serving | BENCH-CROSS-SETTLE: crossing-settle wall-clock, fast line AND 666, interleaved `?frameWork` arms; starvation via `deferredFrames`/`forcedRuns` |
| 44 | P8 H-08.2e | F5 walk + prewarm cross-check | TAIL-ULTRA |
| 45 | P8 H-08.2f | prewarm boot cost | BOOT-666/PARKED-REF read `__prewarmStats.msColor/msDepth` |
| 46 | P8 H-08.2g | worker-dead fallback tail | TAIL-ULTRA `?texWorkers=0` arm |
| 47 | P8 Q5 | depth-warm light-type coverage | conditional register (fires only if point/spot shadow casters ship); pass 11 note |
| 48 | P9 H-09.1 | stage protocols + queue format + console-error definition + noise floors | DISCHARGED — S9/S10/D-10.7 |
| 49 | P9 Q3 | non-client manifest-reader sweep | ST1 task: `rg manifest.json` over harness/tools/proxy (CI, one-shot) |
| 50 | P9 Q6 | SW quota pressure on 8 GB | T2-BOT soak counter (Cache Storage usage row) |
| 51 | P1 Q2 | moving-mid baseline absent | MOVE-FIX first accepted run creates it |
| 52 | P1 Q5 | stall probe never validated on 1070 | TAIL-ULTRA first run = instrument validation (D-10.5) |
| 53 | P1 Q6 | T2 heap ceiling unmeasured | T2-BOT first route run re-classes M8 |
| 54 | P9 Q1/Q2/Q5 + P5 Q2 | owner calls (B4 relax-or-rdo, hashed app shell, 1070 cadence) | owner-decision register; recorded in writing at their stages — not measurements |

### S9 — Stage acceptance gates (the names pass 9's cards bind to)

| gate | stage(s) | composition (tests per S6/S7) |
|---|---|---|
| GATE-BAKE | ST1, every bake | BAKE-CI (closure, determinism, differ, ratios, re-scores) + serve `--check` + T2 boot smoke |
| GATE-WIRE-BOOT | ST2 | BOOT-666 interleaved packs-vs-legacy + BOOT-WARM + T2-BOT + console gate; kill floor per D-10.7 (PC-4 tolerances) |
| GATE-GEOM | ST3 | E1 + BAKE-CI differ + P-ASSEMBLE + PARKED-REF interleaved `?geomBundles` arms (PC-2 floor) |
| GATE-TEXWORKER | ST4 | TAIL-ULTRA worker-vs-FIFO arms (PC-7) + BOOT-WARM queue depth |
| GATE-TEX | ST5 | E2 + E3 + MEM-ROUTE (M4) + ULTRA-SOAK-30 (M5/M6) + BOOT-666 re-score + DUNGEON (C4) + frame-1-white zero-tolerance console/diag gate |
| GATE-Q75 | ST6 | E4 only + B4 arithmetic re-score + owner decision recorded |
| GATE-GRID | ST7 | E5 + CENSUS-CI integrity + MEM-ROUTE (M1/M2) + TAIL-ULTRA governor bucket + BENCH-ZIGZAG + BENCH-TELEPORT |
| GATE-PHASE | ST8 | `__framePhase` census session + BENCH-CROSS-SETTLE (fast + 666) |
| GATE-POOLS | ST9 | E6 + CENSUS-CLASS + MOVE-FIX (creates F3/F4, scores the kill) + TAIL-ULTRA (F5) + ktris/boundedness re-check + CENSUS-CI parked gate |
| GATE-RETIRE | ST10 | legacy-lane worldload counter = 0 over {BOOT-666, CROSS-COL, DUNGEON, MEM-ROUTE} + census retirement shape + soak criteria (pass 9 D-09.8) |

Noise floors and the console-error harness per D-10.7. Every gate's deciding comparisons
are same-session/interleaved per PR-2/PR-3; soaks are observational (pass 9 D-09.3.3
adopted).

### S10 — 1070 validation-queue file format (normative)

`docs/reengineering/queue-1070/batch-<id>-<yyyy-mm-dd>.json`:

```jsonc
{
  "schema": "hb-1070-queue-v1",
  "batch": "A",                       // pass 9 D-09.5 batches A/B/C/…
  "created": "<iso>", "owner": "redmi",
  "sessionRules": "vistest-preamble-v1",   // pointer to the normative rules block:
    // off-screen (--window-position=-32000,-32000), --mute-audio, interactive-session
    // Chrome only, --user-data-dir=C:\Temp\cdpwb-* as the ONLY cleanup handle,
    // CDP :9333, tunnel incl. -R 8080 wsbridge, NEVER browser.close(),
    // ?nosw=1 on every URL, fresh --user-data-dir per BENCH arm, __bootState
    // gate accepts ready|in-world, streaming via terrainBakedLbs plateau
  "items": [
    { "id": "E1", "kind": "eye", "stage": "ST3", "gate": "GATE-GEOM",
      "urls": { "on": "<full URL>", "off": "<full URL>" },
      "vantages": [ { "name": "holtburg-hill", "tele": "@telepoi Holtburg",
                      "cam": { "dist": 26, "az": 35, "el": 18 } } ],
      "checklist": [ "winding: no inside-out props", "…" ],   // §5f shape
      "artifacts": [ "screenshot per vantage per arm" ],
      "verdict": null },                // → {result:"CLEAN"|"DIRTY", notes, ts, by}
    { "id": "P-SUBTLE", "kind": "probe", "script": "harness/probes/subtle_probe.mjs",
      "expects": "engine + MB/s at 1 MB and 8 MB payloads", "result": null },
    { "id": "MOVE-FIX-ST9", "kind": "bench",
      "cmd": "node harness/moving-bench.mjs --cdp=… --anchor=… --frames=1800 --arm=…",
      "arms": ["drawPools=on", "drawPools=off"], "out": ["mb-on.json","mb-off.json"],
      "result": null }
  ]
}
```

Lifecycle: prepared in advance by the stage owner; executed in one session; verdicts and
result pointers written back into the same file; eye verdicts additionally recorded in
url-flags §0 (pass 9 S5.4); a DIRTY verdict blocks the stage per pass 9 D-09.5. Items
missing a batch wait for the next one (promotion quantized — pass 9's accepted cost).
Screenshots are owner-eye artifacts only, never diffed (PR-8).

### S11 — Classification (every named test)

| class | tests |
|---|---|
| **CI** (laptop headless / no browser) | BAKE-CI, CENSUS-CI, T2-BOT, BOOT-666, BOOT-WARM, CROSS-COL, DUNGEON, BENCH-ZIGZAG, BENCH-TELEPORT (T2 arm), CENSUS-CLASS (probe arm), Tier-1 lints (diag schema, console allowlist, url-flags lint/audit), DT-49 sweep |
| **1070-only** (headless, off-screen, batched) | PARKED-REF, MOVE-FIX, TAIL-ULTRA, MEM-ROUTE, ULTRA-SOAK-30, GATE-PHASE session, BOOT-WARM worker arm, P-SUBTLE, P-INITTEX, P-88MIB, P-ASSEMBLE, P-LIGHTBAKE, P-HUBFLIP, BENCH-CROSS-SETTLE, CROWD-BURST, P-LADDER (confirm arm) |
| **OWNER-EYE-only** | E1–E8 register items (queue batches A/B/C), the ST6 sheets review |

CI cadence: on every stage landing + nightly for CENSUS-CI/T2-BOT; BAKE-CI on every
bake. 1070 cadence: quantized to queue batches. The `run-all.mjs` Tier-1/2/3 harness
(harness/README.md:28–35) remains the correctness gate alongside; this suite is the
performance/validation layer, same bare-`node`, exit-code conventions.

### S12 — RESULTS v2 schema (normative; supersedes the ad-hoc RESULTS-*.json shapes)

```jsonc
{ "schema": "hb-results-v2",
  "bench": "MOVE-FIX", "gate": "GATE-POOLS", "protocol": "PC-3",
  "ts": "<iso>", "commit": "<git sha>", "distGeneratedAt": "<manifest field>",
  "platform": { "box": "1070", "renderer": "<UNMASKED_RENDERER_WEBGL>" },
  "url": "<full URL>", "taint": [], "wasmProfile": "release|DEV-WASM",
  "arms": [ { "arm": "drawPools=on", "verdict": "USABLE|REJECT",
              "rejectReasons": [],
              "metrics": { "frameMs@moving": {"p50": 0, "p95": 0, "p99": 0, "mean": 0, "n": 0},
                           "draws@submitted": {}, "ktris@submitted": {},
                           "instances@resident": 0 },
              "series": { "optional": "raw arrays" } } ],
  "controlSpread": { "metric": "frameMs@moving.p50", "value": 0.9 },
  "delta": {}, "verdict": "PASS|FAIL|EXPLORATORY|INVALID", "notes": "" }
```

Rules: metric keys carry `@scale` (D-10.1); percentiles are objects, never bare numbers;
`controlSpread` is mandatory for any comparative verdict (D-10.7); `INVALID` runs are
kept on disk (evidence), never scored. Writer: `harness/lib/report.mjs` (new); existing
harnesses adopt it as they are touched — moving-bench's report is already ~this shape
and converts first.

## Handoffs to later passes

- **H-10.1 (→ pass 11):** Attack surface flagged deliberately: (a) the noise-floor
  constants in D-10.7 (0.4/1.0/1.5 ms, ±2% bytes) are anchored in this week's measured
  spreads but are [A] as universal floors — first gate runs must confirm the session's
  own spread against them; (b) the PC-4 latency figure (80 ms RTT) is [A] — the 666 kbps
  figure is documented, its RTT is not; (c) the `wireWaitEvents` C5 instrument is a NEW
  definition — hostile review of whether it can under-count (e.g., preview-resident but
  full-tier-absent is NOT a wire wait by design — is that the right line?); (d) S8's
  claim of completeness vs the source passes; (e) the D-10.5 refinement of pass 8's
  `__framePhase` (cumulative sums) should be checked against pass 8's intent;
  (f) msTranscode excluded from `explainedMs` (S5) — verify the integration-cost-only
  argument.
- **H-10.2 (→ pass 12):** A1 traceability inputs ready-made: S7 is the budget→test map
  the charter's A1 requires; S9's gate names slot into pass 9's stage cards; S8 is the
  tracked-risk register's measurement column. Build-order note: the diag registry +
  report writer + console allowlist (Tier-1 items) land with ST2; each surface lands
  with its owning stage; TAIL-ULTRA's instrument-validation run should precede any
  F5/F6 scoring; MOVE-FIX baselines must exist before ST9's kill row is enforceable
  (schedule its first run in Batch A or B, not C, if cadence allows).

## Self-check

- **Walls — scale confusion:** D-10.1/S1 make tags mechanical with three enforcement
  points; S7 carries `@scale` on every budget metric. PASS.
- **Walls — boot variance / interleave / Chrome reuse:** PR-2/PR-3 with measured anchors
  (0.7–1.3 ms same-arm spreads, 2.44× reuse drift, 25.2→32.3 cross-session); the
  effect-size table forbids under-powered protocols; D-10.7's floors make kills
  enforceable. PASS.
- **Walls — parked-vs-moving / fixed-pose:** PR-4 mandates the moving-bench mechanism
  and its reject semantics; F3 compares only same-session parked. PASS.
- **Walls — averages vs tail:** PR-5; F4/F5/F6 scored only from the probe's own clock;
  mean-quoting forbidden for hitch claims. PASS.
- **Walls — allocated≠used:** PR-6; S3 adds used-pairs to park pool and pools; M6 scored
  from pairs. PASS.
- **Walls — over-count on first contact:** PR-11 (forced-GC WeakRef) with the 702→28 MB
  anchor; tracer flags tainted (D-10.4.4). PASS.
- **Walls — flag-bit≠predicate / pixel-diffs:** PR-8 with the 16.9% floor cited; eye
  gates named per stage; screenshots never diffed. PASS.
- **Walls — draws×µs / count-pricing:** PR-9; only `*Ms` fields sum into attributions
  (D-10.1); draw/switch counters are diagnostics. PASS.
- **Walls — GPU-on-CPU-bound:** DT-33 wires the boundedness re-measure duty into
  GATE-POOLS. PASS.
- **R1:** read order followed; no prior decision contradicted. Two refinements are
  flagged as refinements, not supersedes: `__framePhase` cumulative sums (pass 8 S7
  said "sampled like any counter" — cumulative is what makes that true) and the
  netWorker-conditional M3 validity (adopts pass 8 D-08.4's precision). All pass-10-
  directed handoffs (P1 H6, P2 H-02.6, P3 H-03.5, P4 H-04.6, P5 H-05.5, P6 H-06.4,
  P7 H-07.3, P8 H-08.2, P9 H-09.1/H-09.2c) are discharged in S6–S10. PASS.
- **R2:** no migration staging, no pool/texture/residency design changed; the two new
  client-side instruments specified (wireWaitEvents, wasmMemMB level) are diag fields,
  not behavior. Implementation of harness files is named, not performed. PASS.
- **R3:** writes = this file + own TRACKING.md row; the queue directory is specified,
  not created. PASS.
- **R4:** every current-code claim carries file:line opened THIS session (stall_probe,
  moving-bench, bootab, flag-census README, harness README, vistest, probe1070, lib.rs
  census, index.js diag, texture_census, diag.js/wire.js, registration sites,
  frame-cost measurement notes). The wasm-crate trap respected (`apps/holtburger-web/
  src/lib.rs`). Charter Q5's "probe never ran" was checked against the probe's own
  header (1070 numbers present but ring-run completion unconfirmed) and handled as
  instrument-validation rather than assumed either way. PASS.
- **R6:** six sections in order; decisions numbered with rationale + rejected
  alternatives. PASS.
- **R7:** concrete schemas (S3, S10, S12), numeric floors (D-10.7), named files and
  drivers, full coverage tables (S7 24/24 IDs, S8 54 rows). PASS.
- **R8:** honest gaps: no-BPTC population not benchable (DT-21), PC-4 RTT assumed,
  noise floors pending first-run confirmation, wireWaitEvents definitional risk flagged
  to pass 11, `hb_build_profile()` export not yet existing (size heuristic interim).
  PASS.

## Open questions

- **Q1 — Noise-floor confirmation.** The D-10.7 floors are anchored in this week's
  measured spreads on ONE box in one era of the codebase. The first run of each gate
  must publish its own same-arm spread; if a protocol's floor is routinely exceeded by
  its spread, the floor moves UP (never down) and the affected kills re-run. [Owner:
  first gate executions; the floors re-class from [A] then.]
- **Q2 — PC-4 throttle fidelity.** CDP `emulateNetworkConditions` shapes throughput but
  models latency crudely (fixed RTT, no jitter); B3's serial-depth budget is
  latency-sensitive. If depth measurements look implausible, the fallback is a tc/netem
  shaping on the serve host. [Owner: first BOOT-666 implementation.]
- **Q3 — C5's `wireWaitEvents` definition.** Preview-resident-but-soft is defined as NOT
  a wire wait (C5 binds at preview tier per the charter). If the owner experiences soft
  textures as "stalls", the metric needs a companion (`fullTierLagMs`). Flagged to
  pass 11 (H-10.1c) and the owner. 
- **Q4 — `hb_build_profile()` export.** The DEV-WASM gate uses a size heuristic until a
  one-line wasm export states the build profile. [Owner: first implementation task
  touching lib.rs; trivial.]
- **Q5 — CENSUS-CLASS on T2 fidelity.** Class cardinality counted over a SwiftShader
  boot assumes material construction is GPU-independent (it is, structurally — materials
  are built before any GPU work), but VFX config tokens could differ by quality preset;
  the CI arm runs at `mid` to match the 1070 reference, and the 1070 confirm arm is
  retained. [Owner: DT-31 execution.]
- **Q6 — Queue-verdict authority.** The queue file records verdicts, url-flags §0
  records flip evidence, RESULTS records runs — three places. The join key is the gate
  ID + item ID; if drift appears between them, SPEC.md (pass 12) should name ONE as
  authoritative (proposed: the queue file for eye verdicts, RESULTS for measurements).
  [Owner: pass 12.]
