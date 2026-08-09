# Pass 11 — Adversarial review: findings and required fixes

Pass 11 of 12. Governed by `TRACKING.md`'s protocol header. This pass attacks passes 1–10
as a hostile reviewer: ledgers rebuilt from the final stated numbers, topology traced
end-to-end, riskiest implementability claims read-verified against code opened THIS
session, migration OFF-arms traced through later stages, and the debt→test map diffed
against its sources. Findings are numbered F-11.N, severity-ranked
(**BLOCKER** = spec cannot ship as written / **MAJOR** = redesign of a section /
**MINOR** = correction), each with evidence and a REQUIRED FIX stated so pass 12 can
apply it mechanically. Per R2 this pass changes nothing — it only finds.

## Inputs read

Spec corpus, complete, in order: `TRACKING.md` 1–103;
`../2026-08-08-pipeline-reengineering-survey.md` 1–153; `pass-01` 1–401; `pass-02` 1–600;
`pass-03` 1–646; `pass-04` 1–607; `pass-05` 1–768; `pass-06` 1–686; `pass-07` 1–795;
`pass-08` 1–745; `pass-09` 1–783; `pass-10` 1–931.

Code/data opened THIS session for verification (R4):

- **three r184 pinned build** — fetched `three@0.184.0/build/three.module.js` (19,552
  lines) + `three.core.js` (59,732 lines, `REVISION = '184'`) from the exact importmap
  URLs (`index.html:969–970`; three is CDN-pinned, NOT vendored). Read:
  `BatchedMesh.onBeforeRender` early-out (three.core.js:27218 — condition verbatim as
  pass 7 quoted), multidraw build loop's `visible && active` filter (27275/27333 region),
  `_visibilityChanged` reset at 27366, `onBeforeShadow` → `onBeforeRender` (27370–27374),
  `setVisibleAt` idempotence + `_visibilityChanged` (26858–26869), `deleteGeometry` 26521,
  `deleteInstance` 26556, `optimize` 26574, `painterSortStable` material.id ordering
  (three.module.js:8107–8130, applied at 8270), `initTexture` incl.
  `isCompressedArrayTexture → setTexture2DArray` (three.module.js:19465–19487),
  `compile`/`compileAsync` scene-walk shape (17312+, 17419).
- `apps/holtburger-web/index.html` — importmap block 954–985; **266 `modulepreload`
  links counted**; `scene3d/*.js` = **127 modules** (ls count).
- `scene3d/three_batchedmesh_colortexture_fix.js` — 1–103 (upstream r184 bug #34054:
  per-frame `getProgram` on every BatchedMesh; app-side prototype fix, measured
  −3.35 ms renderCPU).
- `scene3d/terrain_bc7.js` — 100–130 (t1024 = bare default, 81 MB wire, by user
  direction 2026-08-05; t512 = 20 MB pin-only), 285–333 (`loadTerrainBc7Manifest` +
  `_fetchPayload`: 1 manifest + one fetch **per distinct payload per channel**).
- `scene3d/service-worker.js` — 1–60, 300–330 (fetch handler exits for non-cacheable
  URLs — HTML/JS/manifest.json flow through; pass 3's narrowing of the `?nosw` trap is
  CORRECT and MEMORY.md's broader wording is the stale one).
- `crates/holtburger-resource-http/src/manifest_source.rs` 339–366 (UnsupportedVersion on
  version ∉ {1,2} — pass 9's SUPERSEDES verified); `crates/holtburger-manifest/src/v2.rs`
  186–196 (no `deny_unknown_fields` — additive-fields routing verified).
- `scene3d/net_worker_client.js` 15–25, 55–61 (default DISABLED; s15 not-promoted —
  pass 8's correction of pass 6 verified).
- `scene3d/fixed_grid.js` 48–56 (`FIXED_GRID_TERRAIN_RADIUS = 1` — pass 6's
  survey-correction verified).
- `scene3d/static_batch_x.js` 344–356 (the early-out quote + pOFC/sort unreachability —
  matches the fetched three source); `scene3d/static_atlas.js` 479–500 (`_stateKeyOf`
  axes as pass 7 claims); `scene3d/bc7_textures.js` 57–66 (SwiftShader BPTC present),
  346–374 (level-0-only allocator as pass 5 claims); `scene3d/xu7_textures.js` 17–26
  (1.04 MB transcoder, ~32 ms/1024²); `scene3d/bake_worker.js` 276–290 (message switch
  as pass 8's census states).
- Live dist (`ls` this session): `manifest/eor-cell.bin` 15,352,534 B; `eor-portal.bin`
  1,499,312 B; tex catalogs 57–80 KB; `boot.hba` 2,007,132 B; `manifest.json` 648 B —
  pass 1/2 byte facts confirmed.
- `/home/wbterminal/.claude/projects/-home-wbterminal/memory/fleet-runbooks.md` (tunnel
  recipe): the 1070 loads the app through `-R 8765:127.0.0.1:8765` — i.e. from
  `http://127.0.0.1:8765`, a **secure context**.

Arithmetic rebuilt by hand this session: B1 component table (sums check), B2/B5 request
counts (fail — F-11.2), B4 converged ledger (fail — F-11.1), q75 base-correction
(134 × 0.382 ≈ 51 ✓), chain-size table (chain(128²) = 21,892 B ✓ recomputed), t128 slice
(29 × 21,892 ≈ 0.63 MB ✓; t128 = t1024 mip level 3 ✓), HBSI1 size (≈489 KB ✓), W_T = 6
cover proof (✓ both parities), M3 split (384+96+32 = 512 ✓), VRAM classes
(96+256+192+64 = 608 ✓), pass 4 coefficient chain (24×1.13+6 ≈ 33 B/tri; 3.0× ✓),
budget-ID count (**25**, not 24 — F-11.9).

## Decisions

### D-11.1 — Verification scope: re-verify everything load-bearing that a pass marked read-verified in ITS session, from scratch, in THIS session

Rationale: R4 makes prior-session citations hypotheses, and the record shows agents
citing stale premises. Everything in "Inputs read" above was opened fresh; where a
pass's claim survived (most did), that is stated explicitly in the register so pass 12
can treat those claims as double-checked rather than merely asserted. *Rejected:*
sampling only the claims that "looked risky" (the survey's own history shows the wrong
claims look safe).

### D-11.2 — Ledgers are rebuilt from the FINAL stated numbers only

After pass 5's two SUPERSEDES blocks and pass 9's sentinel SUPERSEDES, the binding
versions are: B1 per pass 5 D-05.2; B4 per pass 5 D-05.3; manifest routing per pass 9
D-09.1. All ledger findings below are computed against those, not against the earlier
superseded forms. *Rejected:* re-litigating superseded arithmetic (noise).

### D-11.3 — Severity calibration

BLOCKER = a budget/claim pass 12 would carry into SPEC.md that is factually false or
unachievable as written (A1/A2/A5 acceptance would fail on it). MAJOR = a section's
mechanism has a hole requiring new decisions or work items, but the surrounding
architecture stands. MINOR = correction applicable in one place. *Rejected:* severity
by effort-to-fix (a one-line budget restatement can still be a BLOCKER if shipping it
un-restated falsifies the spec).

## Spec

### Findings register

---

**F-11.1 — BLOCKER — B4's converged ledger omits the terrain full tier (81 MB at bare
default); the ST6 owner decision is premised on a number wrong by ~2.3×.**
*Implicated:* pass 5 D-05.3/S6 (B4 restatement), pass 2 S6.1 (B4 line — already
superseded but same omission), pass 9 ST6 card + Q1, pass 10 S7 B4 row + BOOT-666.
*Evidence:* Charter D-01.2 defines `converged` = "full texture tier resident for the
current ring", and D-01.3's CURRENT-state B4 (~110 MB) explicitly includes "terrain
first visit 81 MB". Pass 5's own D-05.2 tier ladder streams the **t1024 full pair on
lane T** after preview-complete — that IS converged-wave work — and t1024 is the bare
default (read-verified this session, terrain_bc7.js:102–116: "t1024 FIRST … 81 MB
wire"; t512 = 20 MB is pin-only). Yet pass 5's B4 restatement is `12 + 51 ≈ 63 MB
(q75)` with **no terrain row** — the exact omission class pass 5 itself corrected in
pass 2's B1 (its first SUPERSEDES). True B4 at bare default: q75 ≈ **144 MB**, rdo ≈
**123 MB**, lossless ≈ **176 MB**. Consequence: pass 5's "two retirement paths" (rdo
⇒ B4 ✓ at 42) is arithmetically false — no arm meets ≤45; the ST6 owner decision
("relax to ~65 or rdo") is framed against the wrong number; BOOT-666's "lane-T settle
≤ 20 min throttled" is unreachable (144 MB ≈ 29 min at 83 KB/s).
*REQUIRED FIX (pass 12):* (a) add the terrain row to B4 with the bare-default tier
stated; (b) put a converged-terrain-tier decision in SPEC.md with the three honest
options priced: t512 as the converged tier (q75 total ≈ 83 MB / rdo ≈ 62 MB — still
> 45), t1024 excluded from `converged` (redefine the milestone: terrain converges at
t128, t1024 is an explicitly non-budgeted idle enhancement fetched only after
`converged` — then B4 ≈ 63/42 stands but the milestone definition changes and D-01.2
must be amended with a SUPERSEDES), or B4 relaxed with the REAL number in front of the
owner; (c) re-premise pass 9 Q1's owner-decision text and pass 10's B4 row + BOOT-666
settle window on whichever option is taken.

---

**F-11.2 — BLOCKER — The app shell is ~270 unbundled module requests on a no-cache
tier: B2's "~10 code/wasm" is off by ~27×, and B5's "1 request ✓" is off by ~two
orders. Three passes carried the same hole.**
*Implicated:* charter D-01.3 (B2/B3/B5 arithmetic), pass 2 S6.1 (B2 ≈ 53 ✓), pass 3
S8.1 (B2 ≈ 54 ✓, B5 = 1 req ✓) + S6.1 header table, pass 10 S7 B2/B5 rows.
*Evidence:* read-verified this session — `index.html` carries **266 modulepreload
links** (the generated block at :1176+), `scene3d/` alone is **127 ES modules**, there
is no bundler (pass 3 Q3 itself defers "hashed-filename app shell" as a build-system
change; serve.py serves the live tree). Charter S2 is explicit: "Requests counted at
the network layer, not the app layer." So a cold boot is ≈ 270+ code requests before
any world data — B2 ≤ 64 TOTAL is unachievable as specced, and the "✓" marks in
pass 2 S6.1 and pass 3 S8.1 are false. Warm boot: the app shell rides the `no-cache`
revalidate tier **per pass 3's own S6.1 header table** (and serve.py:617–632), so
every warm boot issues ~270 conditional requests (304s are network-layer requests) —
B5 "≤ 5 requests, met with margin" is false. Pass 3 half-knew: its Q3 notes a hashed
shell would make "B5 → 0 requests", which is only meaningful if the shell currently
costs requests — yet S8.1 counted only the manifest. (B1 *bytes* are unaffected —
the 4.8 MB gzip code figure is measured wire bytes; B3 depth is only marginally
affected since modulepreload flattens the import graph.)
*REQUIRED FIX (pass 12):* pick one, explicitly: (a) **bundle + content-hash the app
shell** as a required work item (promotes pass 3 Q3 / pass 9 Q2 from deferred to a
stage task — natural home: ST1/ST2 era since the SW v3 and header tables are being
touched anyway); shell becomes immutable-CAS → cold ≈ a few shell requests, warm ≈ 0,
and B2/B5 stand as written; or (b) restate B2/B5 as split budgets — world-data
requests ≤ 64 / app-shell requests budgeted separately at a measured N — with charter
S2's network-layer rule amended by SUPERSEDES. Either way: BOOT-666/BOOT-WARM must
score the shell component explicitly (`__hbFetch.byComponent.code` is already specced
— wire it to the network log, not to controller-issued fetches only, or module
requests will silently escape the count).

---

**F-11.3 — MAJOR — Missing flag-dependency edges: `?drawPools` structurally requires
`?packSource` + `?geomBundles` + `?texCompressedOnly`, and pass 9's "W2 proceeds on
the LEGACY fetch stack" is false for ST9; the reverse trace (killing ST5 after ST9)
strands pools with no texture substrate.**
*Implicated:* pass 9 D-09.2 (composition rules + track parallelism), S1 stage graph,
S4 flag table; pass 7 D-07.5/D-07.7/D-07.10.
*Evidence:* pass 7's pool feed consumes a **TilePlan built by the bake worker from
resident PACK records** ("class resolution runs off-thread against the pack's
records… The main thread never derives a class", D-07.5), geometry from **HBG1
bundles** (pass 4), and the class key's `textureArrayId` axis from **TEXREF dims**
(D-07.2), with array policy = pass 5 D-05.6 verbatim (BC7 arrays, preview-commit).
None of that exists on the legacy fetch stack; no legacy-side TilePlan producer is
designed anywhere. Yet pass 9's D-09.2 asserts "W2 proceeds on the LEGACY fetch
stack" and S4 lists `?drawPools` as requiring only `?slotGrid`. Reverse direction:
after ST9 retires static_atlas (pass 7 S6 ledger), a K2 kill of ST5
(`?texCompressedOnly=off` → "today's RGBA8-first double-build") has no array feed —
the RGBA8 atlas machinery pools replaced is the thing ST9 deleted; the combination
(drawPools ON, texCompressedOnly OFF) is a designed-nowhere state.
*REQUIRED FIX (pass 12):* (a) add edges: `?drawPools` requires `?slotGrid` +
`?packSource` + `?geomBundles` + `?texCompressedOnly` (pass 9's existing rule "flag
armed without prerequisite logs loudly and behaves OFF" then covers the forward
direction); (b) add the **cascade rule**: disabling any prerequisite (K2 on ST2/ST3/
ST5) forces dependents OFF loudly in the same session — a kill of ST5 post-ST9 is by
construction a kill of ST9 too, and the kill tables should say so; (c) correct
D-09.2's parallelism claim to "ST7/ST8 proceed on the legacy stack; ST9 requires the
W1 track through ST5" and redraw S1's graph with the edge ST5 → ST9.

---

**F-11.4 — MAJOR — ST7's grid→legacy-LRU adapter layer is load-bearing and designed
nowhere.**
*Implicated:* pass 9 ST7 card; pass 6 D-06.2/H-06.3; pass 7 D-07.10.
*Evidence:* pass 6's spec makes the grid the authority over **PackStore pins and pool
membership** — both pack-era constructs. ST7 ships the grid "on the legacy fetch
stack… legacy-LRU adapters (when off)" (ST7 card), i.e. grid events must drive
today's reactive machinery: per-LB fetch/decode kickoff (the `tickPvsLoadExpansion`
population it deletes), statics/cells/buildings feeds, landblock_lru park/dispose.
That adapter contract — what an `onShift` admit does with no PackStore, what
`pack_pin` means, how legacy eviction maps to `PARKED→EMPTY`, how quarantine
interacts with the legacy 404-silent-skip convention — appears in no pass. The
S15b/S16 precedent (terrain radius-1) proved a much smaller adapter; pass 9 H-09.2d
itself flags the transfer risk.
*REQUIRED FIX (pass 12):* either re-order — ST7 requires `?packSource` (grid drives
PackStore from day one; simpler, one adapter never built) and the stage graph gains
the edge ST2 → ST7 — or add an explicitly-scoped adapter task to ST7's card: the
event→legacy-call mapping table (admit → ring-driver fetch kickoff; vacate → LRU park
request; EMPTY → LRU dispose eligibility; QUARANTINED semantics on the legacy lane),
with the derived-view-assert (legacy LRU running as assert-only) as its acceptance
criterion. Name which of the two in SPEC.md; do not leave it implied.

---

**F-11.5 — MAJOR — The closure walk-widening (MotionTable/PhysicsScript/SoundTable
edges) is load-bearing for ST10's retirement criterion but no stage ships it.**
*Implicated:* pass 2 Q5 (proposed default "widen before v1 ships" — never decided),
pass 4 H-04.7 (folded ONLY the did_degrade edge), pass 3 D-03.10, pass 9 D-09.8/ST10,
pass 10 DT-04.
*Evidence:* animated scenery's MotionTables, PhysicsScripts and sounds are WORLD
content currently fetched per-record; pass 3 D-03.10 parks them on the legacy lane
"until pass 2 Q5's walk-widening lands". ST10 fires only when "the legacy per-record
lane served ZERO world-content records (equipment/entity records excepted)" — with
the widening unowned, that counter can never reach zero, ST10 never executes, and the
four deletion ledgers (and the eor-portal catalog dependency) persist indefinitely.
DT-04 only *measures* coverage; no ST card *ships* the edges.
*REQUIRED FIX (pass 12):* assign the walk-widening to the bake scope of ST1 (emit) +
ST2 (consume), sized by the same K-tier machinery (pass 2 Q5's own proposal; sounds
likely commons-tier — 52.4 MB corpus, heavily shared, so the boot/commons byte impact
must be added to the B-ledger when sized); OR explicitly amend ST10's criterion to
exempt those namespaces permanently and state the residue (walk loop + eor-portal
catalog remain live forever at a small population). Either is shippable; unowned is
not.

---

**F-11.6 — MAJOR — The t128 terrain boot slice's request count is unaccounted: B2 was
never restated after pass 5 added the component, and today's tier-directory shape is
~30 fetches.**
*Implicated:* pass 5 D-05.2/S2 (terrain slice "same manifest schema"), pass 3 S8.1
(B2 ≈ 54 — computed before the terrain component existed), pass 10 BOOT-666.
*Evidence:* read-verified this session — the terrain tier shape is 1 `manifest.json`
+ one fetch per distinct payload per channel (`loadTerrainBc7Manifest` +
`_fetchPayload`, terrain_bc7.js:285–333); the t128 color slice = 29 unique rsIds ⇒
~30 requests at boot (nra slice adds ~29 more immediately after preview-complete).
Pass 5 moved the fetches under the pass 3 controller but kept the per-payload CAS
granularity; nobody added a request row. 54 + 30 = 84 > B2's 64 even before F-11.2's
shell counts.
*REQUIRED FIX (pass 12):* spec the t128 slice as **one CAS file** (a PVW-style pack
section or a single concatenated HBC7 container per channel — 0.63 MB is far below
the whole-pack-fetch rationale of pass 3 D-03.2), add its row (+1 or +2 requests) to
the S6.1/S8.1 boot tables, and note the t1024 full pair keeps per-payload granularity
on lane T (fine — it is converged-wave, not boot).

---

**F-11.7 — MAJOR — No budget×stage binding map: the absolute B-budgets bind only at
the ST2+ST3+ST5 composite, and nothing says so.**
*Implicated:* pass 9 S2 stage cards + pass 10 S7; charter A1.
*Evidence:* during ST2–ST4 the texture path is still RGBA8-first: raw 0x06 records
are deliberately NOT packed (pass 5 D-05.5), so material builds ride the legacy
per-record lane — per-record texture GETs, the eor-portal catalog, the walk loop, and
the bc7/xu7 `_begin` chain all still run. A ST2-era boot therefore cannot meet B1/B2
in absolute terms (hundreds of texture-record requests remain); the passes' "✓" marks
describe the end state. Pass 9's gates are comparative (vs legacy arm — valid), but
pass 10's S7 rows imply absolute scoring per stage, and SPEC.md's A1 traceability
will be wrong-footed the first time GATE-WIRE-BOOT is run at ST2 and B2 "fails".
*REQUIRED FIX (pass 12):* add a budget×stage table to SPEC.md: for each of the 25
budget IDs, the earliest stage at which the absolute target binds (B1/B2/B3: ST5 with
ST2+ST3 landed; B4: ST6 + the F-11.1 decision; B5: F-11.2's decision point; C-series:
ST2 for requests, ST5 for the preview-tier byte definition; F-series: ST9; M-series:
ST5/ST7 as pass 10 already splits them). Gates before that stage score the comparative
form only.

---

**F-11.8 — MINOR — Pass 3's crypto.subtle premise for the 1070 is inverted: the rig's
canonical origin IS a secure context.**
*Implicated:* pass 3 D-03.5/Q1, pass 9 S3.5, pass 10 P-SUBTLE.
*Evidence:* fleet-runbooks (read this session): the 1070 reaches the app through the
reverse tunnel `-R 8765:127.0.0.1:8765` — the page origin is `http://127.0.0.1:8765`,
and loopback origins are secure contexts by spec, so `crypto.subtle` exists there.
Pass 3's "the 1070 driven over plain `http://` on a tailnet IP does NOT [qualify]" is
wrong for the rig as actually driven (it is right only for direct tailnet-IP access,
which the runbook does not use for page loads).
*REQUIRED FIX (pass 12):* keep the worker-wasm sha fallback (still wanted for any
non-loopback origin), but correct the premise where quoted; P-SUBTLE demotes from
"decides the verify engine" to a confirmation probe (it stays in Batch A at near-zero
cost).

---

**F-11.9 — MINOR — The budget-ID count is 25, not 24.**
*Implicated:* TRACKING.md pass 1 row summary; pass 10 charge/summary ("all 24 budget
IDs").
*Evidence:* B1–B5 (5) + C1–C5 (5) + F1–F6 (6) + M1–M9 (9) = **25**. Pass 10's S7
table actually contains all 25 rows — coverage is complete; only the count label is
wrong.
*REQUIRED FIX (pass 12):* say 25 in SPEC.md's A1 mapping. (TRACKING summaries are the
orchestrator's; no pass edits them.)

---

**F-11.10 — MINOR — P4's eager `initTexture` breaks nullRender's zero-upload
economics on T2.**
*Implicated:* pass 8 D-08.5/S1 (alternate drivers "run P0–P2+P4, skip P3"), charter
M9, pass 10 T2-BOT.
*Evidence:* today a nullRender bot never pays texture upload (uploads happen at first
bind inside render, which never runs). Under pass 8, W2 items CALL `initTexture` in
P4 — uploads now execute even when P3 is skipped, on SwiftShader, on every stage's
M9 gate run. A silent CPU regression vector for the ≤120 s boot gate.
*REQUIRED FIX (pass 12):* one rule in D-08.5: under `?nullRender=1`, W2 stages by
marking only (`needsUpdate`/layer marks, no `initTexture` call) — the upload correctly
never happens because nothing binds. Wire counters unaffected.

---

**F-11.11 — MINOR — Pass 9 ST2 modifies pass 3's SW v3 intercept scope (adds legacy
`shards/` to the CAS allowlist) without a SUPERSEDES.**
*Implicated:* pass 3 D-03.9 ("Intercepts ONLY: packs/, index/, texture CAS,
/scene3d/assets/"), pass 9 ST2 card + Q6.
*Evidence:* both texts are individually reasonable (migration-era vs end-state), but
they specify different v3 allowlists and pass 9 did not mark the delta.
*REQUIRED FIX (pass 12):* one v3 spec with a migration clause: `shards/` in the
allowlist until ST10, dropped with the sentinel flip; note pass 9 Q6's quota lever.

---

**F-11.12 — MINOR — Instance-count validity wording conflict for M3 runs.**
*Implicated:* pass 6 S5 gate (d) ("includes all three instances or the run is
invalid") vs pass 8 D-08.4 / pass 10 D-10.4.1 (two instances valid at default —
netWorker is default-OFF, read-verified again this session).
*REQUIRED FIX (pass 12):* restate gate (d) as "includes every instance that EXISTS in
the run's configuration" (pass 8's precision wins); pass 6's wording is superseded.

---

**F-11.13 — MINOR — CENSUS-CLASS is scheduled too late for its purpose.**
*Implicated:* pass 7 Q1 ("one census run … re-classes this [M] **before
implementation sizes anything**"), pass 10 DT-31/GATE-POOLS (census sits inside the
ST9 gate).
*Evidence:* class cardinality is pass 7's single most load-bearing [A] (the closed-set
prewarm, the switch-rate attack, and the O(pools) node budget all lean on it); it is
CI-runnable over TODAY'S materials (pass 10 Q5) and needs nothing from ST2–ST8.
*REQUIRED FIX (pass 12):* schedule CENSUS-CLASS's CI arm as a pre-implementation spike
in the build order (ST2 era at latest), keeping the 1070 confirm arm at GATE-POOLS.

---

**F-11.14 — MINOR — The 4–7 m/s run-speed assumption under C5 has no owning
measurement; the owning bench bakes the assumption in.**
*Implicated:* charter D-01.4 (C5 coherence check, "[A, assumed — retail-varying]"),
pass 3 D-03.8 (≥4× margin), pass 4 S6.2 (≥3.2×), pass 10 CROSS-COL (hops at
"1 LB / 27 s walk cadence" — the same 27 s the assumption produces).
*Evidence:* every C5 margin divides by traversal time ≥ 27 s/column derived from
≤ 7 m/s; a buffed sustained speed materially above that shrinks the worst-case margin
(0.70 MB column at 83 KB/s = 8.4 s transfer — margin hits 1× near 26 m/s, so the
design is safe against any plausible speed, but the MEASURED margin claimed is the
assumption restated). CROSS-COL cannot falsify it because its cadence is the
assumption.
*REQUIRED FIX (pass 12):* add a one-shot measurement row (max sustained buffed run
speed on live ACE, minutes of work) to the debt register; CROSS-COL's cadence
parameter derives from it; the named escape (velocity-adaptive lookahead, pass 3
D-03.8's rejected-for-now arm) stays the fallback.

---

**F-11.15 — MINOR — Debt-map gaps: two source items have no S8 row.**
*Implicated:* pass 10 S8 completeness claim (D-10.9).
*Evidence:* diffed S8 against every source pass's Open questions this session. Missing:
**P5 Q7** (texchan sidecars — 5,475 files, fold-into-nra-corpus decision) and **P3
Q4** (production hosting shape: h2 availability, CDN, origin split — an owner-call
class item like DT-54's entries). Everything else has a row (54 rows verified against
sources).
*REQUIRED FIX (pass 12):* add both to the tracked-risk register (owner-call class; no
bench needed).

---

**F-11.16 — MINOR — B1's ring-preview row is measured against the CURRENT preview
corpus; the coverage invariant adds uncounted bytes.**
*Implicated:* pass 5 D-05.2 (ring previews 1.6 MB), D-05.5.4 (every TEXREF'd rsId MUST
have a PVW row; ~1,100 rsIds currently preview-less).
*Evidence:* the 9.20 MB ring measurement (pass 2 S1.2) could only count previews that
exist (2,893 of 3,985 full-tier rsIds). Ring textures among the ~1,100 preview-less
rsIds will ADD capped previews (≤21.9 KB each) the 1.6 MB figure never saw. Expected
small (tens of textures ⇒ sub-MB) but B1's slack is ±0.4 MB.
*REQUIRED FIX (pass 12):* extend DT-02's BAKE-CI ring re-score to run against the
POST-coverage preview corpus (one sentence in the bench card); no budget change until
that number lands.

---

**F-11.17 — MINOR — ST5 implements the preview-commit/re-home mechanism on
static_atlas, which ST9 then deletes — planned throwaway work, currently unstated.**
*Implicated:* pass 5 D-05.6.3 (atlasRefeed on the atlas), pass 7 D-07.7 (pools subsume
the atlas; refeed becomes a pool transfer), pass 9 ST5/ST9 ordering.
*REQUIRED FIX (pass 12):* acknowledge in the build order (a conscious line item:
"ST5's atlas re-home is migration-era code retired at ST9"), and keep the refeed HOOK
(the `atlasRefeed(rsId)` seam) producer-agnostic so ST9 swaps the implementation, not
the call sites.

---

**F-11.18 — MINOR (observation) — Pass 7/8's settled-frame cost model silently depends
on the app-side fix for three r184 bug #34054 staying applied.**
*Evidence:* `three_batchedmesh_colortexture_fix.js` (read this session) patches an
upstream r184 defect that otherwise forces `getProgram` + a cache-key string build on
EVERY BatchedMesh EVERY frame (measured −3.35 ms renderCPU when fixed; still present
in r185.1 per the header). Pools multiply BatchedMesh count (~up to 300); the
prototype patch covers them, but no pass mentions the dependency.
*REQUIRED FIX (pass 12):* one line in the pools task: the fix module is load-bearing
for pool-scale BatchedMesh populations; its retirement condition (three bump past the
upstream fix) joins pass 9's S7.3 register.

---

**F-11.19 — MINOR — Bake-job dispatch has no named owner in the scheduler.**
*Implicated:* pass 6 S2 ("LIVE when bake completes (pass 8 schedules)"), pass 8
D-08.3/S2 (W1–W6 cover feeds/uploads/results, not job DISPATCH), D-08.4 (concurrency
1 stated, ordering not).
*Evidence:* the STAGED→(worker job) step — which tile bakes next, in what order
(distance? lane U parity?), dispatched from which phase — is implied everywhere and
specified nowhere.
*REQUIRED FIX (pass 12):* one sentence in the scheduler spec: P1-recorded admits
enqueue bake-job dispatch items (player-tile/interior first, then Chebyshev distance —
mirroring pass 3's lane ordering); dispatch happens in P4 as a zero-cost class (post
a message; concurrency 1), cancellation on vacate reuses the S2.6 purge rule.

---

### Walls audit (attack surface 4)

**No violations found.** Explicitly checked: no pass prices a frame win from
draws-removed × µs/draw (pass 7's S4 is term-denominated; F1 is BR/A with a
derivation prohibition); no resident-scale number is quoted as submitted (pass 6's
144-vs-121 and pass 7's census rules carry labels); the one parked figure near a
moving claim (statBatchMemo −4.00 ms) is quoted as term scale with the
moving-unmeasured caveat restated (pass 7 D-07.4); no pass relies on a pixel-diff
gate (pass 10 PR-8 makes them inadmissible at the 16.9% floor). Two borderline items
were checked and pass: pass 5's "79% held out" is a correctness argument, not a
priced win; pass 8's F4 cross-check is a bound structure with an explicit
no-forecast disclaimer.

### Read-verification results (attack surface 3 — what survived)

All of the following pass-side claims were re-verified TRUE against code opened this
session (details in Inputs read): three r184 BatchedMesh early-out condition
(three.core.js:27218, verbatim), setVisibleAt/_visibilityChanged semantics + the
build loop's `visible && active` filter (park-as-visibility is sound and
camera-independent — the CSM/memo-thrash argument holds; `onBeforeShadow` routes
through `onBeforeRender`), `deleteInstance`/`deleteGeometry`/`optimize` all present
in r184, opaque sort adjacency by `material.id` (painterSortStable),
`renderer.initTexture` handling `isCompressedArrayTexture` (three.module.js:
19465–19487; the layerUpdates interaction remains pass 8 Q2's owed probe),
`compile`'s scene-materials-only walk, pass 4's transfer contract (a `Vec<u8>`-return
export yields a JS-owned, transferable ArrayBuffer — the one-copy exit is
implementable as written), pass 9's UnsupportedVersion SUPERSEDES
(manifest_source.rs:364) and additive-fields routing (v2.rs: no
`deny_unknown_fields`), pass 8's netWorker default-OFF correction, pass 6's
fixed_grid partially-built correction (radius 1, default-ON), pass 3's SW-trap
narrowing (the current worker does NOT intercept HTML/JS — MEMORY.md's wording is
the stale one; pass 9's D-09.9.3 owner-notification duty should include that
pointer), pass 5's SwiftShader-BPTC, 32 ms/1024², 1.04 MB transcoder, level-0-only
allocator, and chain-size arithmetic, and pass 2's dist byte facts (catalog/boot.hba
sizes match `ls` exactly).

### Load-bearing [A]/[D] ranking (attack surface 2 — redesign-if-false, with owners)

1. **Class cardinality closed set** (pass 7 Q1) — owned (CENSUS-CLASS) but
   mis-scheduled → F-11.13.
2. **B1 code-size stability through migration** (charter D-01.3 "assumed roughly
   stable" while dual stacks ship) — owned only implicitly via
   `__hbFetch.byComponent.code`; F-11.2's fix makes it explicit.
3. **Envcell light-bake cost** (pass 6's dual-instance keystone) — owned
   (P-LIGHTBAKE, Batch A). Adequate.
4. **88 MiB terrain staging vs F6** — owned (P-88MIB). Adequate.
5. **HBG1 zstd ≥ 0.7** (B1 slack) — owned (BAKE-CI). Adequate.
6. **Run speed 4–7 m/s under C5** — unowned → F-11.14.
7. **Global 6 ms budget sufficiency** — owned (BENCH-CROSS-SETTLE). Adequate.
8. **Full-tier commons-domination** (B4 radius argument) — owned (DT-26); partially
   mooted by F-11.1.
9. **Sector-cull tri inflation** — owned (DT-33 + boundedness re-check). Adequate.
10. **initTexture+layerUpdates in-app** — owned (P-INITTEX). Adequate.

### Migration holes audit (attack surface 5 — beyond F-11.3/4/7)

Traced and SOUND: bad-bake rollback (CAS + N−1 retention + pinned sessions — a bad
bake's packs are simply never referenced after the manifest repoint; SW v3 caches by
CAS name so poisoned entries are unreachable, K4 covers a poisoned CACHE); the
manifest field-presence routing (verified both directions); dual-emit single-tree
mechanics against serve.py's symlink behavior; ST9's one-flag revert to the full
legacy producer stack (OFF arm intact until ST10); SW story through the transition
(v2's bake-identity gate → v3 CAS-only, with F-11.11's allowlist harmonization).

### Completeness audit (attack surface 6)

Survey §4 invariants: all five have named implementing structures. Survey §7 leads:
all ten dispositioned by some pass (verified item-by-item). Entities/VFX/particles/
sky: pass 7's D-07.6 walker table gives each a real home (the VFX-attach path reads
the TilePlan while it is alive at feed — consistent with the drop-after-feed rule);
water has no dedicated system in the current tree and no pass touches one. SwiftShader
tier: functional-only status preserved EXCEPT F-11.10's upload regression vector.
Inherited handoffs: pass 9 S0's 21-row inventory checks out against sources; pass 10
S8's 54 rows check out minus F-11.15's two gaps. The one unowned SHIPPING item found
is the walk-widening (F-11.5).

## Handoffs to later passes

- **H-11.1 (→ pass 12):** the register above is the disposition list charter A5
  requires SPEC.md to handle line-by-line. Blockers F-11.1/F-11.2 change budget
  arithmetic and add one decision each (converged-terrain tier; app-shell
  disposition) — resolve them IN SPEC.md, not as tracked risks. Majors F-11.3–F-11.7
  are stage-graph/scope edits pass 12 applies mechanically. Minors are one-place
  corrections; F-11.14/15/16 may land as tracked-risk register rows.
- **H-11.2 (→ pass 12):** items verified TRUE here (the read-verification list) may be
  cited by SPEC.md as double-checked without re-derivation; everything else inherits
  its original pass's evidence class.

## Self-check

- **R1:** full read order followed (survey + all ten passes complete, in order); no
  finding contradicts a settled wall — each finding cites the passes' own final
  numbers or code read this session. This pass supersedes nothing; it directs pass 12
  to supersede (F-11.1 option b would require a D-01.2 SUPERSEDES, stated as such).
  PASS.
- **R2:** findings and required fixes only; no spec rewritten, no budgets restated in
  place — restatements are specified as pass 12 actions. PASS.
- **R3:** writes = this file + own TRACKING.md row. The three build was fetched to the
  session scratchpad, not the repo. PASS.
- **R4:** every code claim in this pass carries file:line from a file opened THIS
  session (Inputs read); the wasm-crate trap not triggered; `dist` symlink facts
  re-checked by `ls`; the two claims this review OVERTURNS (crypto.subtle on the 1070;
  "~10 code/wasm") are both anchored in artifacts read this session
  (fleet-runbooks tunnel line; index.html modulepreload count). PASS.
- **R5 (walls):** the walls audit section is explicit; no finding proposes a mechanism
  the walls forbid; F-11.14 is careful to note the design remains safe at plausible
  speeds — the finding is about ownership, not a predicted failure. PASS.
- **R6:** six sections in order; the `## Spec` section is the findings register as the
  charge requires. PASS.
- **R7:** every REQUIRED FIX names the concrete edit, table, edge, or decision point;
  rebuilt arithmetic is shown inline. PASS.
- **R8:** honest negatives stated (no walls violations found; most read-verifications
  passed); where this pass could not verify (in-app layerUpdates behavior, real run
  speed, post-coverage ring bytes), it says so and routes to the owning probe rather
  than guessing. PASS.

## Open questions

- **Q1 — Severity of F-11.2's option (a) cost.** Bundling an importmap-era,
  no-package.json tree (harness rule: bare node, no npm) may be more work than the
  passes' "build-system change" phrasing implies; if the owner rejects bundling,
  option (b)'s split-budget restatement is fully specified above and B2/B5 relax
  honestly. Owner call at pass 12.
- **Q2 — F-11.1's milestone-redefinition arm.** Excluding t1024 from `converged`
  preserves the 45 MB target but weakens the milestone's meaning ("full tier" would
  no longer include terrain's top tier). Whether the owner prefers an honest bigger
  number or a redefined milestone is a taste call this pass cannot make.
- **Q3 — Whether any OTHER per-payload static-asset track exists** besides terrain
  (the F-11.6 class). This session verified terrain; a sweep for private `fetch()`
  callers outside the controller during ST2 implementation (`rg "fetch\(" scene3d/`)
  is cheap insurance and could ride DT-49's sweep. Proposed for the ST2 task list.
