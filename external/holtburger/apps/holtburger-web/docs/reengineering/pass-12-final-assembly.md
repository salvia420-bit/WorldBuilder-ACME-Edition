# Pass 12 — Final assembly: pass-11 resolutions and the integration record behind SPEC.md

Pass 12 of 12. Governed by `TRACKING.md`'s protocol header. This pass integrates pass 11's
required fixes into the unified spec and produces **`SPEC.md`** (same folder) — the single
architecture + implementation document for the whole effort. This file records HOW each
pass-11 finding was resolved (the disposition list charter A5 requires), what changed from
the pass 1–10 specs during assembly, and the residual-risk posture. SPEC.md is the
deliverable; this file is its assembly record. Source classes per R7: **[M]** measured
(doc named), **[D]** derived (arithmetic shown), **[A]** assumed-pending-measurement.

## Inputs read

Opened in THIS session, complete, in order:

- `docs/reengineering/TRACKING.md` — lines 1–103 (all).
- `docs/2026-08-08-pipeline-reengineering-survey.md` — lines 1–153 (all).
- `docs/reengineering/pass-01-requirements-charter.md` — 1–401 (all).
- `docs/reengineering/pass-02-world-pack-format.md` — 1–600 (all).
- `docs/reengineering/pass-03-wire-and-fetch.md` — 1–646 (all).
- `docs/reengineering/pass-04-geometry-spec.md` — 1–607 (all).
- `docs/reengineering/pass-05-texture-spec.md` — 1–768 (all).
- `docs/reengineering/pass-06-residency-architecture.md` — 1–686 (all).
- `docs/reengineering/pass-07-scene-and-draw-architecture.md` — 1–795 (all).
- `docs/reengineering/pass-08-frame-loop-and-scheduling.md` — 1–745 (all).
- `docs/reengineering/pass-09-migration-plan.md` — 1–783 (all).
- `docs/reengineering/pass-10-instrumentation-and-validation.md` — 1–931 (all).
- `docs/reengineering/pass-11-adversarial-review.md` — 1–563 (all; the findings register
  F-11.1–F-11.19, the walls audit, the read-verification list H-11.2 authorizes SPEC.md
  to cite as double-checked).
- Code read-verified THIS session for facts newly relied on (R4):
  `apps/holtburger-web/index.html` — 266 modulepreload links counted (`grep -c`), SW
  registration `./service-worker.js` (index.html:2607); `scene3d/` = 127 modules (`ls`);
  worker entry points are bundler-splittable `new Worker(new URL("./x.js",
  import.meta.url))` — keepalive_worker_client.js:66, net_worker_client.js:136 (module
  worker), bake_worker_client.js:795. These four anchors shape D-12.2's bundling
  mechanics (per-entry chunks are possible; the SW must remain a separate stable-name
  file at the scope root).

All other code claims in SPEC.md inherit their source pass's citations; where pass 11
re-verified a claim in ITS session (its read-verification list), SPEC.md cites it as
double-checked per H-11.2 rather than re-deriving.

## Decisions

Numbered by the finding each resolves. B = blocker, M = major; the 12 minors are
dispositioned in D-12.8.

### D-12.1 — [B, F-11.1] Converged terrain: ladder stays t128 → t1024; t1024 moves AFTER the `converged` milestone; B4 split into a gated B4a and a reported B4b; formal SUPERSEDES of charter D-01.2/D-01.3

**Resolution.** The tier ladder's end state is: **t128 at boot (inside B1) → `converged`
stamps with terrain at t128 → the t1024 full pair streams post-converged on an idle
lane-T tail, default-ON, explicitly non-budgeted.** No t512 middle tier is inserted
(it would add 20 MB [M, terrain_bc7.js:107–110 via pass 5] of wire that the t1024 pair
then replaces — pure waste on every line). The budget splits:

- **B4a (gated):** bytes to `converged` with terrain at t128 = B1 + full-tier statics
  ring ≈ 12 + 51 ≈ **63 MB at q75** [D: ring raw-BC7-equiv 134 MB × 0.382, pass 5
  D-05.3's corrected base, re-verified by pass 11] · ≈ 42 MB at q30+rdo50 · ≈ 95 MB
  lossless. Target: **≤ 65 MB** (q75 arm); the rdo arm meets the charter's old 45.
- **B4b (reported, never gated):** the t1024 end state = B4a + 81 MB [M] ≈ **144 MB at
  q75** (123 rdo / 176 lossless). Diag stamps `terrainT1024CompleteMs`; BOOT-666 reports
  it; nothing passes or fails on it.

> **SUPERSEDES pass-01 D-01.2 (definition of `converged`) and D-01.3/S1 (B4 ≤ 45 MB)
> because** pass 11 F-11.1 proved by arithmetic that no arm meets ≤ 45 MB once the
> ledger honestly includes the bare-default t1024 terrain tier (81 MB wire [M,
> terrain_bc7.js:102–116, read-verified by pass 11]): true converged-with-t1024 is
> ≈ 144 MB at q75, ≈ 123 MB at rdo — the charter target was set against a ledger
> missing its largest single component. The amended definition: `converged` = full
> texture tier resident for the current ring, **where terrain's converged tier is t128
> (the boot slice); the t1024 pair is a post-converged enhancement, non-budgeted**.
> B4 ≤ 45 MB is replaced by B4a ≤ 65 MB (q75) + B4b reported.

**The 2026-08-05 user direction ("t1024 FIRST", bare default) is preserved in intent:**
every session still converges to t1024 by default; only its position in the T3 fetch
order changes (after the milestone, on idle bandwidth — on the 1070's fast local line
the re-sequencing is invisible, seconds apart). **Owner escape (named, recorded in
writing at ST6 per pass 9's Q1 row, now re-premised on these numbers):** at GATE-Q75 the
owner may instead (i) accept the default above; (ii) direct t1024-in-converged — then
B4a is restated to the real ≈ 144/123 MB and the milestone definition reverts; or
(iii) adopt the rdo corpus (B4a ≈ 42). A session escape `?terrainT1024=eager|defer|off`
(default `defer`) makes the arm testable either way.

*Rejected:* t512 as the converged tier (83 MB q75 — still misses every target while
adding a wasted 20 MB tier step); gating B4b (would re-institutionalize the 22-minute
class of boot-blocking downloads the whole program exists to kill); silently keeping
"≤ 45" with the terrain row absent (the exact papering-over the mandate forbids).

### D-12.2 — [B, F-11.2] App shell: bundle + content-hash as a required stage (ST-SHELL); B2/B5 stand; split-budget restatement is the pre-specified fallback

**Resolution: option (a) — a bundling stage is added to the migration plan.** The
~270-module no-cache shell (266 modulepreload links, 127 scene3d modules [M, this
session]) is replaced, for the DEPLOYED/BENCHED artifact only, by a content-hashed
few-file shell on the immutable-CAS header tier (pass 3 S6.1's row, extended):

- **Mechanics:** `esbuild` (single static binary — no npm/package.json, honoring the
  harness's bare-node rule) with entry points: main app, `bake_worker.js`,
  `net_worker.js`, `texture_worker.js`, `keepalive_worker.js`. The `new Worker(new
  URL("./x.js", import.meta.url))` pattern at all three current sites (read-verified
  this session: bake_worker_client.js:795, net_worker_client.js:136,
  keepalive_worker_client.js:66) is exactly the shape esbuild splits into per-entry
  chunks with rewritten URLs. Output: `app-<hash>.js`, `<worker>-<hash>.js`,
  `holtburger_web-<hash>.wasm` + glue, all under `shell/` with
  `immutable + no-transform` identity headers; `index.html` stays a small `no-cache`
  loader; `service-worker.js` stays a separate stable-name file at the scope root
  (SW scope rules; it is already tiny and `no-cache`).
- **Request arithmetic [D]:** cold shell ≈ 8 requests (html + app + wasm + glue +
  4 worker/SW entries) vs ~270; B2 recount ≈ 8 shell + 2 manifest/index + ~5
  CORE/META/PVW + 36 tiles + 1 terrain slice (D-12.6) ≈ **52 ≤ 64** ✓. Warm boot =
  index.html revalidate (1) + manifest revalidate (1) ≈ **2 requests ≤ 5** ✓ — B5's "met
  with margin" becomes true instead of false. B1 bytes unchanged (4.8 MB gzip is a
  measured wire figure; bundling does not grow it materially — tree-shaking may shrink
  it, unbudgeted).
- **Dev loop unaffected:** serve.py continues serving the live unbundled tree for daily
  development; bundling is a dist-build step (rides the ST1-era bake/deploy tooling).
  Budgets bind on the deployed shape (charter S2 bare-default rule — the deployed
  artifact IS the bare default players get).
- **Wire contract consistency (pass 3):** the shell joins the immutable-CAS class;
  `manifest.json` remains the only mutable data URL; SW v3 still never intercepts the
  shell (immutable HTTP cache covers warm; offline app-start remains out of scope —
  pass 3 D-03.9's stance unchanged). `__hbFetch.byComponent.code` is wired to the CDP
  network log, not controller-issued fetches, so shell requests can never silently
  escape the count again (pass 11's fix wording, adopted).
- **Fallback (owner escape, pre-specified):** if bundling is rejected or proves
  intractable (pass 11 Q1's cost concern), the split-budget restatement lands instead:
  B2 = world-data requests ≤ 64 with shell requests budgeted separately at a measured N,
  B5 likewise, with a SUPERSEDES of charter S2's network-layer wording. That text is
  ready in SPEC.md's risk register (R-02) so the fallback is a decision, not a redesign.

*Rejected:* accepting ~270 requests and restating B2 ≈ 340 (a T3 cold boot would spend
minutes on module RTTs; and every warm boot would issue ~270 conditional requests —
falsifying the "revisits near-free" property B5 exists to guarantee); SW-caching the
unbundled shell (reintroduces the stale-app-shell trap class pass 3 eliminated).

### D-12.3 — [M, F-11.3] Flag-dependency edges completed; kill-cascade rule added; track-parallelism claim corrected

Adopted mechanically as pass 11 specifies: (a) `?drawPools` requires `?slotGrid` +
`?packSource` + `?geomBundles` + `?texCompressedOnly` (TilePlans are built from pack
records; geometry from HBG1 bundles; the class key's texture axis from TEXREF dims —
none exists on the legacy stack, and no legacy TilePlan producer is designed anywhere);
(b) **cascade rule:** disabling any prerequisite forces its dependents OFF loudly in the
same session — a K2 kill of ST5 after ST9 is by construction a kill of ST9 too, and the
kill tables say so; (c) the stage-graph claim becomes "ST7/ST8 proceed on the legacy
PRODUCER stack; ST9 requires the W1 track through ST5", with the edge ST5 → ST9 drawn.
*Rejected:* designing a legacy-side TilePlan producer to keep ST9 independent of W1
(a large throwaway artifact serving only scheduling flexibility the plan doesn't need —
ST9 is last among structural stages anyway).

### D-12.4 — [M, F-11.4] ST7 re-ordered to require `?packSource` (edge ST2 → ST7); the residual grid→legacy-PRODUCER adapter is spec'd at source-pass fidelity

Pass 11 offered re-order OR adapter. **Both halves are needed, split correctly:** the
grid→legacy-FETCH adapter (what `pack_pin` means with no PackStore, admit→ring-driver
kickoff, quarantine vs 404-silent-skip) is **eliminated by re-ordering** — ST7 requires
`?packSource`, so PackStore, pins, loud-skew quarantine, and the tier model exist from
the grid's first day. The grid→legacy-PRODUCER adapter (grid events driving today's
statics/cells/buildings feeds and landblock_lru park/dispose while `?drawPools` is still
OFF) **cannot be eliminated** — it is the ST7-without-ST9 state — and is now spec'd
(SPEC §1.4 carries the normative table): admit(tile) → per-LB build kickoff through the
existing feed seams (the population `tickPvsLoadExpansion` computed reactively, now
event-driven), reads served by CompositeSource; vacate → 2 s hysteresis →
`landblock_lru.park(lb)` per LB; PARKED→EMPTY (pressure pass) → existing LRU dispose
path under the same amortized budget + `pack_unpin(tile)`; QUARANTINED → LBs never fed
(pack content is loud-skew by pass 3; legacy-lane record misses keep catalog-gated
silent-absent semantics); teleport → grid drain replaces the LRU purge paths. During
soak the legacy LRU runs **assert-only**: it computes its victim set and diffs it
against grid state without acting; `gridLruDivergence` MUST read 0 over the battery
(the S15 derived-view-assert discipline, pass 6 H-06.3, given its concrete counter).
The adapter retires at ST9 for pooled populations and at ST10 for the rest.
*Rejected:* shipping ST7 fully independent of ST2 with a fetch adapter (an unspecced,
load-bearing, definitely-throwaway layer — pass 11's finding); deferring the producer
adapter to "implementation detail" (it is the entire ST7 promotion surface).

### D-12.5 — [M, F-11.5] Walk-widening (MotionTable / PhysicsScript / SoundTable closure edges) assigned: ST1 emits, ST2 consumes; B-ledger impact task attached

The bake-walk gains the Setup→MotionTable/PhysicsScript/SoundTable edges (pass 2 Q5's
proposed default, now decided) alongside the already-assigned GfxObj→did_degrade edge
(pass 4 H-04.7), sized by the same K-tier machinery — sounds expected commons-tier
(52.4 MB corpus, heavily shared [M, pass 2]). ST1's BAKE-CI reports the sized bytes per
tier; **the boot/commons rows of the B-ledger update from that report before ST2's
GATE-WIRE-BOOT scores absolutes** (a widened commons that blows B1's margin is a
tiering-parameter bug caught at bake, not a surprise at the gate). ST10's retirement
criterion ("legacy lane served ZERO world-content records") is now reachable: after
ST2, animated-scenery support records ride packs; the legacy lane's permanent
population is equipment/entity + no-BPTC fallback only, exactly as pass 3 D-03.10
scoped. *Rejected:* permanently exempting these namespaces from retirement (keeps the
walk loop + eor-portal catalog alive forever for content that is fully bakeable —
the worse trade unless the sizing report surprises; that reversal path is noted on the
risk row).

### D-12.6 — [M, F-11.6] The t128 terrain boot slice ships as ONE CAS file per channel (+2 boot requests, accounted); t1024 keeps per-payload granularity on lane T

The t128 slice (29 unique rsIds, 0.63 MB color / 0.64 MB nra [D, pass 5]) is emitted as
a single concatenated HBC7 container per channel (`terrain-t128-color` /
`terrain-t128-nra`, CAS-named, listed in the HBSI1 shared directory) — 0.63 MB is far
below the whole-pack-fetch rationale of pass 3 D-03.2, and ~30 per-payload requests at
boot would have consumed half of B2 (pass 11's arithmetic: 54 + 30 = 84 > 64). Boot
tables gain the row: +1 request at lane-B tail (color), +1 immediately post-milestone
(nra). The t1024 pair keeps today's per-payload CAS granularity on lane T (converged-
wave work; request count is not a post-boot budget). This supersedes pass 5 S2's "same
manifest schema, `tier: t128` directory" wording for the boot slice only — the tier
directory remains the bake-side source the single file is assembled from.

### D-12.7 — [M, F-11.7] Budget×stage binding map added (SPEC §2.2)

Every budget ID now names the earliest stage at which its ABSOLUTE target binds; gates
before that stage score the comparative form (vs same-session legacy arm) only.
Headlines: B1/B2/B3 bind at ST5 with {ST2, ST3, ST-SHELL} landed; B4a at ST6 (with the
D-12.1 decision recorded); B5 at ST-SHELL+ST2; C1/C3 at ST2, C2/C4 at ST5, C5 at ST7;
F-series at ST9; M1/M2/M7 at ST7, M4/M5/M6 at ST5, M3 at ST7 (instance-config wording
per D-12.8/F-11.12); M8/M9 at every stage. This is the table GATE-WIRE-BOOT would have
been wrong-footed without (a ST2-era boot still rides the RGBA8-first texture path with
per-record texture GETs — absolute B1/B2 CANNOT pass there, by design).

### D-12.8 — The 12 minors: 9 applied inline in SPEC.md, 3 carried as tracked risks with owners

| finding | disposition |
|---|---|
| F-11.8 crypto.subtle premise inverted | **Applied.** SPEC states the corrected premise (the 1070's canonical origin `http://127.0.0.1:8765` via the reverse tunnel IS a secure context); worker-wasm sha fallback kept for non-loopback origins; P-SUBTLE demoted to a confirmation probe. |
| F-11.9 budget count 25 not 24 | **Applied.** SPEC's A1 mapping says 25 throughout. |
| F-11.10 nullRender upload economics | **Applied.** Frame rule added: under `?nullRender=1`, W2 stages by marking only (`needsUpdate`/layer marks; no `initTexture` call) — nothing binds, nothing uploads; wire counters unaffected. |
| F-11.11 SW v3 allowlist conflict | **Applied.** One v3 spec with a migration clause: legacy `shards/` in the CAS allowlist until ST10, dropped with the sentinel flip; pass 9 Q6's quota lever noted. Supersedes the pass 3/pass 9 divergence by unifying them. |
| F-11.12 M3 instance wording | **Applied.** Gate (d) restated: "the census sums every instance that EXISTS in the run's configuration, or the run is invalid" (pass 8's precision wins; pass 6 S5(d)'s wording superseded). |
| F-11.13 CENSUS-CLASS too late | **Applied.** Its CI arm is task T00 — a pre-implementation spike, first item in the build order; the 1070 confirm arm stays at GATE-POOLS. |
| F-11.14 run-speed assumption unowned | **Tracked risk R-06** (owner: one-shot live-ACE measurement of max sustained buffed run speed; CROSS-COL's cadence parameter derives from it; velocity-adaptive lookahead remains the named escape). |
| F-11.15 debt-map gaps (P5 Q7 texchan, P3 Q4 hosting) | **Applied + tracked.** Both added to the risk register as owner-call rows (R-09, R-10). |
| F-11.16 post-coverage ring preview bytes | **Applied.** DT-02's BAKE-CI ring re-score runs against the POST-coverage preview corpus (one sentence in the bench card); B1's ±0.4 MB slack risk carried on R-01. |
| F-11.17 ST5 atlas re-home throwaway | **Applied.** Build-order line item: "ST5's atlas re-home implementation is migration-era code retired at ST9"; the `atlasRefeed(rsId)` seam is producer-agnostic so ST9 swaps the implementation, not the call sites. |
| F-11.18 three #34054 fix dependency | **Applied + tracked.** Pools task carries the line: `three_batchedmesh_colortexture_fix.js` is load-bearing at pool-scale BatchedMesh populations; its retirement condition (three bump past the upstream fix) joins the doc-propagation register (R-11). |
| F-11.19 bake-job dispatch unowned | **Applied.** Scheduler spec sentence: P1-recorded admits enqueue bake-job dispatch items (player tile/interior first, then Chebyshev distance — mirroring lane ordering); dispatch executes in P4 as a zero-cost item (post a message, concurrency 1); cancellation on vacate reuses the queue-purge rule. |

### D-12.9 — SPEC.md authority and shape

SPEC.md wins over the pass files wherever they differ; pass files are design history and
rationale archives (each SPEC section cites its source pass for the full argument). The
findings register is dispositioned line-by-line in SPEC §0.3 (satisfying charter A5's
"in SPEC.md" clause) with this file holding the rationale. Eye-verdict authority (pass
10 Q6): the **1070 queue file** is authoritative for eye verdicts, **RESULTS files** for
measurements; url-flags §0 mirrors, never originates. *Rejected:* making SPEC.md a
concatenation of the passes (unreadable as an onboarding document — the mandate's
readability requirement is the binding constraint on length).

## Spec

### Integration report — what changed from the pass 1–10 specs during assembly

1. **Budget arithmetic (pass 1/2/3/5/10):** B4 split into B4a ≤ 65 MB (q75, gated) +
   B4b ≈ 144 MB (reported) with a formal SUPERSEDES of charter D-01.2/D-01.3 — the
   `converged` milestone now excludes the t1024 pair (D-12.1). B2 recounted at ≈ 52
   after the shell bundling stage and the +1 terrain-slice row (D-12.2, D-12.6); B5
   recounted at ≈ 2 requests. The 25 (not 24) budget IDs all appear in SPEC §2 with
   owning test + binding stage (D-12.7). BOOT-666's converged settle window re-premised
   on B4a (≈ 10 min throttled, not the unreachable 20-min-at-144 MB).
2. **Stage graph (pass 9):** one NEW stage (ST-SHELL, W1 track, no dependencies);
   new edges ST2 → ST7 and ST5 → ST9; the flag table gains `?drawPools`'s three missing
   prerequisites and the kill-cascade rule; ST1's scope grows by the walk-widening emit,
   the t128 single-file slice, and the shell-build tooling hook; ST7's card gains the
   producer-adapter scope + `gridLruDivergence = 0` acceptance; the "W2 fully parallel"
   claim is corrected (ST7/ST8 parallel on the producer side only; ST9 needs W1 through
   ST5). Task count: 17 tasks over 11 stages (was 10).
3. **Mechanism corrections applied in place:** crypto.subtle premise (F-11.8), SW v3
   unified allowlist (F-11.11), M3 instance wording (F-11.12), nullRender staging rule
   (F-11.10), bake-dispatch ownership (F-11.19), t128 slice shape (F-11.6),
   `byComponent.code` wired to the network log (F-11.2 tail).
4. **Nothing else moved.** The architecture of passes 2–8 survives assembly intact —
   pass 11 found zero walls violations and its read-verification list confirmed every
   core mechanism (three r184 early-out/setVisibleAt/initTexture, the one-copy transfer
   contract, manifest field-presence routing, the fixed-grid partial-build correction).
   SPEC §1 is a condensation, not a redesign.

### Residual-risk register (summary — full table with owners/resolve-by in SPEC §5)

Top of the register, in rank order: (1) class cardinality / closed-class-set [A] —
pass 7's single most load-bearing assumption, now front-loaded as spike T00;
(2) the ST6 owner decisions (q75 eye + the D-12.1 terrain/B4a election) — the plan's
only unpriced human gate besides batch cadence; (3) ST-SHELL feasibility (bundling an
importmap-era tree; fallback pre-specified); (4) the [A] noise floors, cap numbers, and
per-class budgets throughout — every one has an owning measurement and a resolve-by
stage in SPEC §5; (5) the honest un-designed remainder: GC/wasm-grow tail residue
(probe-observed only) and the no-BPTC population (field-counted only).

## Handoffs to later passes

None — this is pass 12. Handoffs to IMPLEMENTATION are what SPEC.md is; its §3 tasks,
§5 risk owners, and §6 doc-propagation obligations are the complete outbound surface.
One orchestrator note: TRACKING.md row 12 + the Log line are updated per the sanctioned
write; the queue directory (`queue-1070/`) is created at first batch, not now.

## Self-check

- **Walls:** No figure in this file or SPEC.md is produced by draws×µs arithmetic,
  count-as-proxy ranking, resident-priced-as-submitted, allocated-priced-as-used, or a
  cross-boot single shot; every count carries a D-01.2/S1 scale label; the B4
  restatement quotes bandwidth arithmetic [D] and measured wire bytes [M] only. The two
  new stages introduce no frame-time predictions. PASS.
- **R1:** Full read order followed (survey + passes 1–11 complete, in order). Two
  contradictions of prior recorded decisions carry explicit SUPERSEDES blocks with
  evidence (charter D-01.2/D-01.3 via F-11.1's arithmetic; pass 6 S5(d) wording via
  F-11.12 — both directed by pass 11). D-12.6 supersedes pass 5 S2's boot-slice
  delivery wording with the finding cited. All other changes discharge pass 11's
  REQUIRED FIX texts, which is the mechanism H-11.1 defined. PASS.
- **R2:** Scope = final assembly only: resolutions, SPEC.md, TRACKING row 12 + one Log
  line. No new architecture invented beyond what findings required (the ST7 adapter is
  spec'd because the mandate says "spec it now at the same fidelity as the source
  passes"). PASS.
- **R3:** Writes = this file, SPEC.md, TRACKING.md row 12 + the one sanctioned Log
  line. Nothing else touched. PASS.
- **R4:** New code claims this session: modulepreload count, module count, worker
  entry-point shapes, SW registration path — all opened/verified this session with
  file:line. Everything else cites its source pass, or pass 11's re-verification list
  where H-11.2 authorizes it. The wasm-crate trap not triggered. PASS.
- **R5:** Walls cited by name where decisions are shaped by one (B4's bandwidth
  arithmetic, the no-prediction stance on both new stages). PASS.
- **R6:** Six sections in order; decisions numbered with rationale and rejected
  alternatives; SPEC.md carries the two-file output contract's second half. PASS.
- **R7:** Every resolution names concrete mechanics (esbuild entries, single-file HBC7
  containers, adapter event table, cascade rule, budget numbers with classes). PASS.
- **R8:** The unresolvable items are owner calls and measurements, carried as named
  risks with owners — not guessed. B4's miss against the original charter target is
  stated in a SUPERSEDES, not massaged. PASS.
- **Charter A1–A7 (SPEC.md acceptance):** A1 — §2 maps all 25 IDs to design elements +
  owning tests + binding stages. A2 — every [D]/[A] target carries shown arithmetic or
  a §5 risk row with measurement + owner. A3 — §1.0's invariant table restates I1–I5
  kept-degrees verbatim with named implementing structures. A4 — §3/§4 keep a bootable
  client at every stage with per-task kill criteria and the house flag policy. A5 —
  §0.3 dispositions all 19 findings line-by-line; scale labels throughout. A6 — §5 is
  the tracked-risk register with retirement plans. A7 — §3's tasks each carry an
  acceptance gate scoreable without re-reading the corpus. PASS (self-assessed; the
  orchestrator verifies).

## Open questions

- **Q1 — The ST6 owner election (D-12.1).** The spec'd default (t1024 post-converged)
  is committed, but the owner may prefer arm (ii) or (iii); the decision is recorded in
  writing at ST6 either way. [Owner: redmi, Batch B era.]
- **Q2 — ST-SHELL cost.** Bundling effort is estimated M with a pre-specified fallback
  (D-12.2); if the fallback fires, B2/B5 are restated per the ready text in SPEC §5
  R-02. [Owner: ST-SHELL task lead + owner call.]
- **Q3 — Walk-widening sizing.** If the ST1 sizing report shows the widened commons
  breaking B1's margin, the tiering parameters (K, commons threshold) are the first
  lever and the permanent-exemption reversal (D-12.5's rejected arm) is the second.
  [Owner: ST1 bake task; resolves at GATE-BAKE.]
