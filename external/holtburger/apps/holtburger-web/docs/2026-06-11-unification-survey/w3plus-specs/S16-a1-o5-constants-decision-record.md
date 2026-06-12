# S16 — A1-O5 constants-decision record bundle (EXECUTION SPEC)

Item: **A1-O5** (decision-record half). ROADMAP: §7.5 contradiction, §8 last bullet
(A1 row 10 "revisit only inside O5"), §9 "needs a human" row (now resolved by RULINGS
item 3), Lane A (A1-O5 headless), wave W6 listing. RULINGS.md item 3 is the human
input this record finalizes.

Scope ruling for the implementer: this item is the **decision DOCUMENT plus
comment-pointer consolidation**. The two *code* halves sketched in A1 §4 Stage O5
(per-object update clocks for tracked bodies; `?physics30hz` gate) are explicitly
OUT OF SCOPE here — this record only states their status and reopen triggers.

---

## 1. read-HEAD + W2 assumptions

- Read at HEAD **61bea82f** ("holtburger: W2/Batch-R2 buildbox dispatch manifest"),
  branch master, 2026-06-11. W0/W1 are fully landed (`tick_spine.rs`,
  `?unifiedTick`, `?posePublishPostTick`, `?worldLifecycle`, `?maintPrune`,
  `?wireStatePacks=stage1` all exist in-tree — verified by symbol grep, not assumed).
- A W2 wave (Batch R2: **A4-Q1, A3-D1, A3-D2(a), A2-P1, A7-R1/R2/R3/R6, A9-Stage1**)
  is committing to this repo concurrently. Batch R2 touches
  `crates/holtburger-core/src/client/movement/{system.rs,common.rs}` — the two files
  this record cites most. **All `our-file:line` cites below are pinned at 61bea82f**;
  the implementing agent MUST re-resolve by symbol (anchor strings are given) before
  writing the record, and MUST re-pin its own read-HEAD in the record's header.
- Specific W2 deltas that change the *content* (not just lines) of this record:
  - **A3-D2(a)** (exhaustion run-rate) — does not touch any of the four decisions;
    ignore.
  - **A3-D1 / A4-Q1** (completion layer / motion-table queue): if the queue core
    lands, decision (d)'s "RemoveLinkAnimations has no equivalent yet" caveat gains
    a partial owner (`USE_MOTION_TABLE_QUEUE`, default-off). The record should then
    say "owner exists, default-off" instead of "unowned". Check
    `git log --oneline -- crates/holtburger-core/src/client/movement/` at write time.
  - No W2 item touches MAX_QUANTUM / MIN_QUANTUM / HUGE_QUANTUM values or the JS
    dt-clamp (verified: Batch R2 manifest scope per ROADMAP §5; none of those items
    lists the quantum constants).

## 2. Current-state map (post-W0/W1)

Four quantum-law surfaces + one JS clamp law exist today:

1. **Movement-crate constants** (the canonical set):
   `crates/holtburger-core/src/client/movement/common.rs`
   - `MIN_QUANTUM = 1.0/30.0` — common.rs:574 (doc 570–573 cites ACE
     `PhysicsGlobals.MinQuantum`, `PhysicsObj.cs:4182`).
   - `MAX_QUANTUM = 0.1` — common.rs:581 (doc 576–580: "ACE PhysicsGlobals.MaxQuantum
     = 0.1f"). **This is the ACE pin RULINGS item 3 keeps.**
   - `HUGE_QUANTUM = 2.0` — common.rs:590; `MAX_VELOCITY = 50.0` — common.rs:598.
   - Block rationale comment at common.rs:560–569 ("We intentionally do NOT reach
     into ACE for these values") — scattered-site #1.
2. **Manual-drive integrator** (wasm local player, flag-off path; also under
   `?unifiedTick=on` the spine skips its pre-integration):
   `quantum_slices()` system.rs:471–485 (HUGE drop → `MAX_QUANTUM` slices →
   remainder kept only `> MIN_QUANTUM`), consumed by
   `advance_local_pose_for_manual_drive` system.rs:1231–1272 with the
   sub-MIN_QUANTUM **accumulator** `physics_time_accumulator`
   (holtburger-world/src/player/types.rs:1501–1514). This path HAS a 30 Hz-shaped
   gate (accumulate-until-MIN_QUANTUM).
3. **Solver tick** (native always; browser under `?unifiedTick=on` via
   `TickSpineHandle`): simulation.rs:69–113. Slices at `MAX_QUANTUM`, drops
   `> HUGE_QUANTUM`, and **deliberately has NO MIN_QUANTUM accumulator**
   (simulation.rs:93–95 comment: "small frames pass through rather than
   floor-to-empty"). The 0.1-vs-0.2 rationale comment at simulation.rs:85–93 —
   scattered-site #2.
4. **Spatial `physics_globals`**: holtburger-world/src/spatial/collision.rs:77–81
   declares MIN/MAX/HUGE_QUANTUM (1/30, 0.1, 2.0). **Audit finding: zero non-test
   consumers** (grep `physics_globals::(MIN|MAX|HUGE)_QUANTUM` outside tests = no
   hits at 61bea82f); pinned only by the constants test collision.rs:699–701. They
   exist for the INERT BSP-M4 placement-context port (collision.rs block comment
   ~94–101). Declared-but-dormant — the record must say so, so a future consumer
   doesn't assume they are live law.
5. **JS dt-clamp** (scattered-site #3): scene3d/index.js
   - `DT_RECOVERY_RAW_THRESHOLD_S = 0.5` / `DT_RECOVERY_FRAMES = 10` —
     index.js:1391–1393 (rationale comment 1381–1390, "A3 (2026-05-18)").
   - cadence-scaled threshold `_dtRecoveryThresholdS = renderOnDemand ? Infinity :
     max(0.5, frameInterval×1.5)` — index.js:1417–1419 (rationale 1407–1416, "#14").
   - the tick body: first-frame dt=0.016; `rawDt > threshold` → freeze `dt=0` for
     10 frames; else `dt = Math.min(rawDt, 0.1)` — index.js:1458–1480.
   - **Clock independence (load-bearing fact):** this clamped `dt` feeds ONLY JS
     consumers (`tickPerFrame`, mixers, eases). The Rust side measures its OWN
     wall-clock dt: `TickSpineHandle::tick_frame` tick_spine.rs:200–212
     (`saturating_duration_since(last_tick_at)`, first call 16 ms). So the JS clamp
     does NOT bound Rust integration; the two clamp laws run on two independent
     clocks. (A1 §3 row 10 called this "a second, independent clamp law" — the
     record must state the independence explicitly.)
6. **Cadence**: native `PHYSICS_TICK_MS = 30` (client/mod.rs:45; interval at
   runtime.rs:65) ≈ 33.3 Hz; browser TickMovement is enqueued at rAF rate
   (index.html:10770 `handle.tickMovement()`), no global 30 Hz gate (A1 §3 row 8).
7. **HitGround surfaces** (decision d): airborne frozen-launch arm
   system.rs:1371–1392 (`is_airborne` → frozen `current_planar_velocity`); grounded
   per-tick re-derive arms system.rs:1393–1473 (`USE_INTERPRETED_VELOCITY`
   direct-set, stamp at 1473) and legacy friction arm ending at stamp 1582;
   wasm-side touchdown synthetic event lib.rs:39515–39530+
   (`was_airborne_pre_tick && !w.player.is_airborne` → touchdown clip signalling);
   DESIGN.md HitGround omission block (unified-movement-pipeline/DESIGN.md, "HitGround /
   LeaveGround fan-out" section, lines ~473–489).

### Retail truth (dual-cite anchors, verified at /home/wbterminal/ac-headers)

- `MIN_QUANTUM = 1/30`, `MAX_QUANTUM = 1/5 = 0.2` — acclient_2013.bndb_pseudo_c.txt:717927,
  717935 (repeated initializers at 718091/718099, 719156/719164, 722295/722303,
  722718/722726 — multiple static-module copies, ALL 1/30 and 1/5; the IDA decomp
  names them `MIN_QUANTUM_93`/`MIN_QUANTUM_97`/`MAX_QUANTUM_97`, acclient.c:54557,
  54658–54659).
- Global 30 Hz pass gate: `CPhysics::UseTime` acclient.c:311350–311352
  (`quantum >= MIN_QUANTUM_93` or the whole physics world does nothing).
- Per-object clock: `CPhysicsObj::update_object` acclient.c:323120–323159 — skip
  threshold is `v6 > 0.00019999999` (323124, i.e. 0.2 ms, NOT 1/30); drop `> 2.0`
  (323126); a frame `<= MAX_QUANTUM_97` integrates IN FULL with no MIN floor
  (323127–323129 `goto LABEL_21`); only the post-slicing remainder is floored at
  `MIN_QUANTUM_97` (323139–323141).
- HitGround fan-out: transition/contact sites call `MovementManager::HitGround/
  LeaveGround` (acclient.c:318526–318536, 319040, 320563, 322612, 322688);
  `MovementManager::HitGround` acclient.c:339369–339383 fans to
  `CMotionInterp::HitGround` (344429–344455: gravity-state gate `BYTE1(state)&4`,
  `RemoveLinkAnimations`, `apply_current_movement` re-derive) and
  `MoveToManager::HitGround` (345570). `LeaveGround` 344457–344490 stamps
  `get_leave_ground_velocity` (343806–343843) and clears `standing_longjump`.

## 3. Staged implementation plan

**Classification: docs + comment-pointer edits only. No behavior change, no flag,
no wasm export change → NO manifest bump (`WASM_EXPORT_MANIFEST_VERSION` untouched).
Stage 1 is pure-docs (no rebuild of any kind). Stage 2 edits comments in .rs/.js
files — still zero behavior delta; it merely rides whatever wasm rebuild happens
next (do NOT trigger one for it).**

### Stage 1 — author the decision record (the deliverable)

New file:
`external/holtburger/apps/holtburger-web/docs/2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md`
(same directory as RULINGS.md, which it finalizes; do not create a new subdir).

Required structure (exact section list; every constant dual-cited per the anchors
in §2 above):

**Header:** read-HEAD pin, pointer to RULINGS.md item 3, A1 §3 rows 6/8/10,
ROADMAP §7.5/§8, DESIGN.md HitGround block.

**Decision (a) — MAX_QUANTUM = 0.1 (ACE pin), retail 0.2 REJECTED. FINAL.**
- Retail value 0.2: bndb_pseudo_c.txt:717935; used acclient.c:323127–323135.
- Our value 0.1: common.rs:581; consumers system.rs:476–478, simulation.rs:103–105;
  declared-dormant copy collision.rs:79; pinned by tests collision.rs:700 and
  system/tests.rs:2520–2546 (0.25 s → two 0.1 slices + 0.05 remainder).
- Rationale (verbatim intent from RULINGS item 3): client prediction must substep
  at the granularity of the LIVE ACE server it syncs against
  (`PhysicsGlobals.MaxQuantum = 0.1f`, ACE PhysicsObj.cs:4175–4180 per
  common.rs:576–580); retail's 0.2 matters only for a dead client. Divergence
  envelope: identical integration laws per slice; a long frame takes ~2× retail's
  slice count; steady-state ≤33 ms frames are single-slice on both laws —
  byte-identical there.
- This record IS the final sign-off RULINGS item 3 left pending. State that.

**Decision (b) — JS dt-clamp regime: KEEP, deliberate EXTRA. FINAL.**
- Retail's only clamp law is the per-object clock (skip 0.2 ms / drop 2.0 s /
  slice 0.2 s — acclient.c:323120–323159); retail has NO freeze-recovery band.
- Ours: index.js:1458–1480 (cap `min(rawDt, 0.1)`; freeze band
  `rawDt > max(0.5, cadence×1.5)` → dt=0 ×10 frames; renderOnDemand disables via
  Infinity, index.js:1417–1419).
- Rationale to record: (i) the two laws are on INDEPENDENT clocks — the Rust spine
  self-measures dt (tick_spine.rs:207–210), so removing the JS clamp would not
  change Rust physics, and keeping it cannot double-clamp Rust; (ii) the freeze
  band covers the 0.5–2.0 s gap where retail would integrate 3–10 slices of
  catch-up (visible snap) and where HUGE_QUANTUM does not yet drop; strictly
  conservative; (iii) the JS 0.1 cap numerically equals MAX_QUANTUM by
  coincidence — record that it is NOT the same constant and must not be "unified"
  into common.rs.
- Reopen trigger: A1-O3 `?syncPhysicsTick` (W5) makes the JS dt and Rust dt the
  same measurement; when O3 lands, this decision MUST be revisited (the freeze
  band would then starve Rust physics too). Put this in the record as a hard
  pre-condition on O3's spec.

**Decision (c) — MIN_QUANTUM / 30 Hz audit. Three sub-decisions.**
- Inventory table (the audit): retail global gate 1/30 (acclient.c:311352) vs
  per-object floor semantics (full-frame integrate ≤0.2 s, remainder-only floor,
  skip 0.2 ms — acclient.c:323124–323141); ACE remainder-floor 1/30
  (PhysicsObj.cs:4175–4186 per common.rs:570–573); our manual-drive
  accumulator+floor (system.rs:480, 1242–1272, types.rs:1501–1514); our solver
  no-floor (simulation.rs:93–95); dormant physics_globals copy (collision.rs:77,
  zero non-test consumers); native 30 ms cadence (mod.rs:45) vs browser rAF-rate
  (index.html:10770).
- (c1) KEEP manual-drive accumulator law (ACE-shaped, not retail-shaped — same
  pin philosophy as (a); cite system/tests.rs:1958–1962, 2548–2560 as the pinned
  behavior).
- (c2) KEEP solver no-MIN_QUANTUM (documented at simulation.rs:93–95): flooring
  there would stall the 30 ms native cadence (every 30 ms frame < 33.3 ms floor →
  zero integration until accumulation, adding jitter). Record as
  ACCEPTED-DEVIATION from both retail (global gate) and ACE (remainder floor),
  with the stall rationale.
- (c3) Browser has NO 30 Hz gate (A1 §3 row 8: tick counts scale with monitor Hz;
  heartbeat scheduling slots double at 144 Hz). Status: KNOWN-DIVERGENCE,
  remediation = the `?physics30hz` flag sketched in A1 §4 Stage O5 — **deferred,
  not decided here**; gated on `?unifiedTick` default-flip + 1070 eye-test (W6).
  Also record: native `PHYSICS_TICK_MS = 30` ms is a cadence (33.3 Hz) slightly
  faster than retail's ≥33.3 ms gate (30 Hz) — KEEP (it is an interval, not a
  gate; quantum laws bound integration regardless).
- (c4, housekeeping) physics_globals MIN/MAX/HUGE_QUANTUM in collision.rs:77–81
  are declared-dormant for the inert placement port — record so nobody cites them
  as live law; do NOT delete (the M5 placement loop will consume them).

**Decision (d) — HitGround event-omission: CONFIRMED DELIBERATE, with reopen
trigger and two carve-outs.**
- Retail contract: contact transitions fan `MovementManager::HitGround`
  (acclient.c:318536, 339369–339383) → `CMotionInterp::HitGround`
  (344429–344455): RemoveLinkAnimations + `apply_current_movement` re-derive at
  the landing EVENT; plus `MoveToManager::HitGround` (345570).
- Our equivalents: (i) per-tick re-derive — every grounded tick recomputes target
  velocity (system.rs:1393–1473), so the first post-touchdown tick re-derives ≤
  one tick later than retail's event; (ii) landing detection + snap
  (`world.player.land()` in the floor-snap region, system.rs ~2326–2341); (iii)
  rig-side touchdown signalling in the wasm arm (lib.rs:39515+,
  `was_airborne_pre_tick` transition → touchdown clip).
- Decision (per DESIGN.md:473–478, quoted verbatim in the record): do NOT add an
  event-driven HitGround; "the omission is a decision, not a hole." Reopen
  trigger: A1's ordering audit (the A1-O3 1070-gated latency/feel pass) showing a
  late-by-one-frame landing artifact.
- Carve-out 1: `RemoveLinkAnimations` has NO per-tick equivalent — its retail
  role (kill link/one-shot anims on landing) belongs to the A4-Q1/A4-Q2/A5-P1
  completion layer (DESIGN.md motion_table_manager block); the record must state
  this is NOT covered by the omission decision and is owned elsewhere.
- Carve-out 2: `LeaveGround` is NOT part of this omission. Our walk-off-ledge
  launch freezes the UNCLAMPED planar store (airborne arm system.rs:1371–1392
  reading the stamp from 1473/1582) vs retail's clamped
  `get_leave_ground_velocity` (acclient.c:344477–344484, 343806–343843,
  run_rate×4.0 clamp). That is a REAL divergence owned by the A3 Stage-2
  amendment (DESIGN.md:481–489, survey A3 §3 row 6) — the record cross-references
  it and decides nothing.

### Stage 2 — comment-pointer consolidation (kill the three-site scatter)

Replace the duplicated rationale prose with one-line pointers to the record
(KEEP the constant docstrings and ACE cites; remove only the duplicated
*decision* rationale):

1. simulation.rs:85–93 — collapse the "(Slice = ACE PhysicsGlobals.MaxQuantum
   0.1s; acclient.c MAX_QUANTUM_97 is 0.2s — kept consistent…)" parenthetical to:
   `// 0.1-vs-0.2: see docs/2026-06-11-unification-survey/DECISIONS-A1-O5-constants.md (a).`
2. common.rs:560–569 block comment — append one pointer line; leave per-const
   docstrings (570–598) untouched (they carry the ACE line cites tests rely on
   reviewers checking).
3. scene3d/index.js:1381–1390 (A3 comment) and 1460–1463 (tick-body comment) —
   append `// decision record: DECISIONS-A1-O5-constants.md (b)`.
4. collision.rs:76–81 — annotate the three quantum consts:
   `// declared-dormant (placement port M5); live law lives in movement/common.rs — see DECISIONS-A1-O5-constants.md (c4).`
5. DESIGN.md HitGround block (~473–478) — append one line: "Decision recorded:
   DECISIONS-A1-O5-constants.md (d)." (single-line append; DESIGN.md is
   A3-owned — coordinate if an A3 stage is mid-flight, see §5.)

No new symbols, no flags (default-off rule vacuously satisfied), no module shapes.

### Stage 3 — explicitly deferred (record-only mentions)

`?physics30hz` gate and per-object update clocks (A1 §4 O5 code half): NOT in
this item. The record lists them under "deferred remediations" with owner A1-O5
code-half / W6.

## 4. Test plan

Headless-now (no cargo, no npm — pure text verification):
- Citation-resolution check: for every `file:line` in the record, `sed -n` the
  line and confirm the anchor string matches (the implementer should script this
  one-shot; both repo files and /home/wbterminal/ac-headers are readable).
- Confirm zero behavior delta: `git diff` after Stage 2 touches ONLY comment
  lines (every hunk line starts with `//`, `///`, `*`, or markdown) — reviewable
  by inspection.
- Existing pin-tests stay the executable contract (do NOT add new ones for a docs
  item): collision.rs:699–701 (constants), system/tests.rs:2520–2546 (slice
  schedule), :2548–2560 (sub-MIN_QUANTUM frame), :2561–2580 (HUGE drop +
  boundary). The W2/W3 waves run them; this item must not require a build.

1070-gated: nothing for the record itself. The record's reopen triggers are
1070-items by construction: (b)'s O3 revisit, (c3)'s `?physics30hz` eye-test,
(d)'s landing-artifact audit.

## 5. Risks + rollback

- **Line drift (HIGH likelihood, LOW impact):** Batch R2 is rewriting
  movement/system.rs + common.rs RIGHT NOW. Mitigation is mandatory: re-resolve
  every our-side cite by anchor string at write time, pin the record to its own
  read-HEAD, and prefer symbol+line ("`quantum_slices`, system.rs:471 @ <sha>")
  over bare lines.
- **DESIGN.md append collision:** DESIGN.md is the A3-D1 living document; if an
  A3 stage commit is mid-flight, the single-line append in Stage 2 item 5 may
  conflict. Mitigation: it is one independent line; rebase trivially, or drop it
  and leave the pointer only in the record (acceptable degraded form).
- **Stale-comment risk inverted:** after Stage 2, future edits to the rationale
  happen in ONE file. The residual risk is someone editing a constant without
  updating the record — mitigated by the pointer comments sitting directly above
  each constant.
- **No behavior risk:** zero executable change; rollback = `git revert` of the
  doc + comment commit. No flag, no manifest, no rebuild.

## 6. OPEN QUESTIONS

1. **MIN_QUANTUM_97's numeric value** is inferred, not directly proven: all eight
   `MIN_QUANTUM` static initializers in the bndb pseudo-C are 1/30 (717927,
   718091, 719156, 722295, 722718, …) and the IDA names `MIN_QUANTUM_93/_97` are
   two module-local copies (acclient.c:54557, 54658), so both are almost
   certainly 1/30 — but I could not map the `_97` copy to a specific initializer
   address. If an implementer needs the exact remainder-floor value, confirm via
   the bndb address map before citing "remainder floor = 1/30 in retail" as fact;
   the record currently needs only "ACE floors at 1/30", which IS dual-cited.
2. **A1 §3 row 6's "§2.6 precedent"** for the ACE-pin documentation: I could not
   locate which doc's §2.6 this refers to (likely the physics deep-dive
   2026-06-01, not present under docs/ by that name at this HEAD). The record
   should cite RULINGS item 3 + common.rs/simulation.rs comments instead; if the
   deep-dive doc is found, add it as historical context.
3. **Does any LIVE consumer read `physics_globals::MIN_QUANTUM` transitively**
   (e.g. via re-export) that grep missed? Grep at 61bea82f says no non-test
   consumers, but a W2 item (A7-R1/R2/R3/R6 touch spatial/) could add one
   mid-flight — re-grep at write time; if A7 added a consumer, (c4) changes from
   "dormant" to "live, audit the value source".
4. **Record placement**: spec chooses the survey dir next to RULINGS.md. If the
   project later establishes a dedicated decisions/ convention, move then; not
   worth inventing a new convention for one file now (judgment call made here so
   the implementer doesn't have to).
5. **JS first-frame default dt = 0.016** (index.js:1466) and the Rust first-tick
   16 ms default (tick_spine.rs:210) are a matched pair by convention only — no
   retail analog exists (retail's first frame measures from `last_update` init).
   Single-cited on our side; listed here rather than decided in the record.
