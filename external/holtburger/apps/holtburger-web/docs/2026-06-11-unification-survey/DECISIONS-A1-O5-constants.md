# A1-O5 — Physics-constants decision record (MAX_QUANTUM / dt-clamp / MIN_QUANTUM / HitGround)

**Status: FINAL** (decisions a, b, d; c1/c2/c4) / **DEFERRED** (c3 remediation).
Executed per spec `w3plus-specs/S16-a1-o5-constants-decision-record.md` (S16, W3+ wave).

- **read-HEAD: 08ad6563** ("holtburger: A2-P3 sticky manager incl. local player"),
  master, 2026-06-12 — i.e. AFTER the full W2 wave (048573d0) and the 9-commit W3
  wave (9568fc0a..08ad6563). All our-side `file:line` cites below were re-resolved
  by anchor string at this HEAD (the spec's cites were pinned at 61bea82f and have
  drifted; symbol anchors are given alongside lines).
- Finalizes **RULINGS.md item 3** (§7.5 MAX_QUANTUM ruling — this record is the
  final sign-off that ruling left pending inside A1-O5).
- Context: survey A1 §3 rows 6/8/10, ROADMAP §7.5 / §8 (A1 row 10), DESIGN.md
  (2026-06-11-unified-movement-pipeline) "HitGround / LeaveGround fan-out" block.
- Scope: decision DOCUMENT + comment-pointer consolidation only. The two code
  halves sketched in A1 §4 Stage O5 (per-object update clocks; `?physics30hz`)
  are OUT OF SCOPE — status + reopen triggers recorded under (c3)/§Deferred.
  Zero behavior change; no flag; no manifest bump (stays 4).

## Current-state map (at 08ad6563)

Four quantum-law surfaces + one JS clamp law:

1. **Movement-crate constants (canonical)** —
   `crates/holtburger-core/src/client/movement/common.rs`:
   `MIN_QUANTUM = 1.0/30.0` (common.rs:599, doc 595–598 cites ACE
   `PhysicsGlobals.MinQuantum`, `PhysicsObj.cs:4182`); `MAX_QUANTUM = 0.1`
   (common.rs:606, doc 601–605: ACE `PhysicsGlobals.MaxQuantum = 0.1f`);
   `HUGE_QUANTUM = 2.0` (common.rs:615); `MAX_VELOCITY = 50.0` (common.rs:622).
   Block rationale comment common.rs:580–594 ("We intentionally do NOT reach
   into ACE for these values").
2. **Manual-drive integrator** (wasm local player) — `quantum_slices()`
   system.rs:637–650 (HUGE drop → `MAX_QUANTUM` slices → remainder kept only
   `> MIN_QUANTUM`), consumed by `advance_local_pose_for_manual_drive`
   system.rs:1698–1741 with the sub-MIN_QUANTUM accumulator
   `physics_time_accumulator` (holtburger-world/src/player/types.rs:1519). This
   path HAS a 30 Hz-shaped gate (accumulate-until-MIN_QUANTUM).
3. **Solver tick** (native always; browser under `?unifiedTick=on`) —
   client/simulation.rs:80–107: slices at `MAX_QUANTUM`, drops `> HUGE_QUANTUM`,
   deliberately NO MIN_QUANTUM accumulator (simulation.rs:94–96: "small frames
   pass through rather than floor-to-empty").
4. **Spatial `physics_globals`** — holtburger-world/src/spatial/collision.rs:77/79/81
   declares MIN/MAX/HUGE_QUANTUM (1/30, 0.1, 2.0). **Re-audited at 08ad6563:
   still ZERO non-test consumers of the quantum trio** (the live
   `physics_globals` consumers are `LANDING_Z` — system.rs:2858/3170 via A7-R3 —
   and `EPSILON`; neither is a quantum constant). Pinned only by the constants
   test collision.rs:699–701; they exist for the INERT BSP-M4 placement-context
   port (block comment collision.rs:~94). **Declared-but-dormant — do not cite
   them as live law.**
5. **JS dt-clamp** — apps/holtburger-web/scene3d/index.js:
   `DT_RECOVERY_RAW_THRESHOLD_S = 0.5` / `DT_RECOVERY_FRAMES = 10`
   (index.js:1449–1450; rationale "A3 (2026-05-18)" 1438–1448); cadence-scaled
   `_dtRecoveryThresholdS = renderOnDemand ? Infinity : max(0.5, frameInterval×1.5)`
   (index.js:1475–1477; rationale "#14" 1465–1474); tick body: first-frame
   dt=0.016, freeze band → `dt=0` ×10 frames, else `dt = Math.min(rawDt, 0.1)`
   (index.js:1560–1583).
   **Clock independence (load-bearing):** the clamped JS `dt` feeds ONLY JS
   consumers (`tickPerFrame`, mixers, eases). The Rust spine measures its OWN
   wall-clock dt: `TickSpineHandle::tick_frame` tick_spine.rs:200–211
   (`saturating_duration_since(last_tick_at)`, first call 16 ms). The JS clamp
   does NOT bound Rust integration; two clamp laws, two independent clocks.
6. **Cadence** — native `PHYSICS_TICK_MS = 30` (client/mod.rs:48; interval
   runtime.rs:65) ≈ 33.3 Hz; browser TickMovement runs at rAF rate (S1/A1-O3
   `?syncPhysicsTick` phase #0 in scene3d/index.js, legacy index.html enqueue
   behind the `__syncTickOwned` watchdog), no global 30 Hz gate (A1 §3 row 8).
7. **HitGround surfaces** — airborne frozen-launch arm (frozen planar store,
   comment system.rs:3307); grounded per-tick re-derive
   (`USE_INTERPRETED_VELOCITY`, system.rs:1791/1869); landing snap
   `world.player.land()` (system.rs:2876, 3178, 3252, 3265, 3632); wasm
   touchdown synthetic event (`was_airborne_pre_tick`,
   apps/holtburger-web/src/lib.rs:40192/40383); DESIGN.md "HitGround /
   LeaveGround fan-out" block (DESIGN.md:473–488).

### Retail truth (dual-cite anchors, /home/wbterminal/ac-headers — unchanged since spec)

- `MIN_QUANTUM = 1/30`, `MAX_QUANTUM = 1/5 = 0.2` —
  acclient_2013.bndb_pseudo_c.txt:717927, 717935 (repeated static-module copies
  at 718091/718099, 719156/719164, 722295/722303, 722718/722726, ALL 1/30 and
  1/5; IDA names `MIN_QUANTUM_93`/`MIN_QUANTUM_97`/`MAX_QUANTUM_97`,
  acclient.c:54557, 54658–54659).
- Global 30 Hz pass gate: `CPhysics::UseTime` acclient.c:311350–311352
  (`quantum >= MIN_QUANTUM_93` or the whole physics world does nothing).
- Per-object clock: `CPhysicsObj::update_object` acclient.c:323120–323159 —
  skip threshold `v6 > 0.00019999999` (0.2 ms, NOT 1/30; :323124); drop `> 2.0`
  (:323126); a frame `<= MAX_QUANTUM_97` integrates IN FULL with no MIN floor
  (:323127–323129); only the post-slicing remainder is floored at
  `MIN_QUANTUM_97` (:323139–323141).
- HitGround fan-out: contact/transition sites (acclient.c:318526–318536,
  319040, 320563, 322612, 322688) → `MovementManager::HitGround`
  (:339369–339383) → `CMotionInterp::HitGround` (:344429–344455: gravity-state
  gate, `RemoveLinkAnimations`, `apply_current_movement` re-derive) +
  `MoveToManager::HitGround` (:345570). `LeaveGround` :344457–344490 stamps
  `get_leave_ground_velocity` (:343806–343843) and clears `standing_longjump`.

---

## Decision (a) — MAX_QUANTUM = 0.1 (ACE pin); retail 0.2 REJECTED. **FINAL.**

- Retail value 0.2: bndb_pseudo_c.txt:717935; used acclient.c:323127–323135.
- Our value 0.1: common.rs:606; consumers system.rs:643–645 (`quantum_slices`)
  and simulation.rs:104–106; declared-dormant copy collision.rs:79; pinned by
  tests collision.rs:700 and the slice-schedule tests in
  movement/system/tests.rs (0.25 s → two 0.1 slices + 0.05 remainder).
- **Rationale (RULINGS item 3, verbatim intent):** client prediction must
  substep at the granularity of the LIVE ACE server it syncs against
  (`PhysicsGlobals.MaxQuantum = 0.1f`, ACE PhysicsObj.cs:4175–4180 per
  common.rs:601–605); retail's 0.2 matters only for a dead client.
- Divergence envelope: identical integration laws per slice; a long frame takes
  ~2× retail's slice count; steady-state ≤33 ms frames are single-slice under
  BOTH laws — byte-identical there.
- **This record IS the final sign-off RULINGS item 3 left pending.**

## Decision (b) — JS dt-clamp regime: KEEP, deliberate EXTRA. **FINAL.**

- Retail's only clamp law is the per-object clock (skip 0.2 ms / drop 2.0 s /
  slice 0.2 s — acclient.c:323120–323159); retail has NO freeze-recovery band.
- Ours: index.js:1560–1583 (cap `min(rawDt, 0.1)`; freeze band
  `rawDt > max(0.5, cadence×1.5)` → dt=0 ×10 frames; renderOnDemand disables
  via Infinity, index.js:1475–1477).
- Rationale: (i) the two laws run on INDEPENDENT clocks — the Rust spine
  self-measures dt (tick_spine.rs:207–211), so removing the JS clamp would not
  change Rust physics, and keeping it cannot double-clamp Rust; (ii) the freeze
  band covers the 0.5–2.0 s gap where retail would integrate 3–10 catch-up
  slices (visible snap) and where HUGE_QUANTUM does not yet drop — strictly
  conservative; (iii) the JS 0.1 cap numerically equals MAX_QUANTUM **by
  coincidence** — it is NOT the same constant and must not be "unified" into
  common.rs.
- **Reopen-trigger check (performed at this HEAD):** A1-O3 LANDED in W3
  (db0b436e, `?syncPhysicsTick`) — but as a JS-side microtask-flush *ordering*
  fix, NOT the rejected shared-clock `tickPhysicsSync` export. The Rust spine
  still self-measures dt (tick_spine.rs:207–211 unchanged), so clock
  independence holds and the trigger has NOT fired. The trigger remains live:
  any future change that makes the JS dt and the Rust dt the same measurement
  MUST revisit this decision first (the freeze band would then starve Rust
  physics too).

## Decision (c) — MIN_QUANTUM / 30 Hz audit. Three sub-decisions + housekeeping.

Inventory (the audit):

| surface | law | cite |
|---|---|---|
| retail global gate | whole-world no-op below 1/30 | acclient.c:311352 |
| retail per-object | skip 0.2 ms; full-frame integrate ≤0.2 s; remainder-only floor | acclient.c:323124–323141 |
| ACE | remainder floor 1/30 | PhysicsObj.cs:4175–4186 (per common.rs:595–598) |
| our manual drive | accumulator + floor (ACE-shaped) | system.rs:647, 1711–1740; types.rs:1519 |
| our solver | NO floor (pass-through) | simulation.rs:94–96 |
| dormant copy | declared, zero non-test consumers | collision.rs:77–81 |
| native cadence | 30 ms interval (33.3 Hz) | mod.rs:48; runtime.rs:65 |
| browser cadence | rAF rate, no 30 Hz gate | scene3d/index.js phase #0 / index.html legacy enqueue |

- **(c1) KEEP the manual-drive accumulator law** (ACE-shaped, not retail-shaped
  — same pin philosophy as (a)). Pinned behavior: the sub-MIN_QUANTUM-frame and
  slice-schedule tests in movement/system/tests.rs.
- **(c2) KEEP the solver's no-MIN_QUANTUM pass-through** (simulation.rs:94–96):
  flooring there would stall the 30 ms native cadence (every 30 ms frame
  < 33.3 ms floor → zero integration until accumulation → added jitter).
  Recorded as **ACCEPTED-DEVIATION** from both retail (global gate) and ACE
  (remainder floor).
- **(c3) Browser has NO 30 Hz gate** (A1 §3 row 8: tick counts scale with
  monitor Hz; heartbeat scheduling slots double at 144 Hz). Status:
  **KNOWN-DIVERGENCE**; remediation = the `?physics30hz` flag sketched in A1 §4
  Stage O5 — **deferred, not decided here**; gated on the `?unifiedTick`
  default-flip + 1070 eye-test (W6). Also recorded: native
  `PHYSICS_TICK_MS = 30` ms is a cadence (33.3 Hz) slightly faster than
  retail's ≥33.3 ms gate (30 Hz) — **KEEP** (it is an interval, not a gate;
  the quantum laws bound integration regardless).
- **(c4, housekeeping)** `physics_globals` MIN/MAX/HUGE_QUANTUM
  (collision.rs:77–81) are **declared-dormant** for the inert BSP-M4 placement
  port — recorded so nobody cites them as live law; do NOT delete (the M5
  placement loop will consume them). Re-grepped at 08ad6563 after the W2 A7
  spatial work and the S7 transition.rs landing: still zero non-test consumers
  of the quantum trio.

## Decision (d) — HitGround event-omission: CONFIRMED DELIBERATE, with reopen trigger and two carve-outs.

- Retail contract: contact transitions fan `MovementManager::HitGround`
  (acclient.c:318536, 339369–339383) → `CMotionInterp::HitGround`
  (:344429–344455): `RemoveLinkAnimations` + `apply_current_movement` re-derive
  at the landing EVENT; plus `MoveToManager::HitGround` (:345570).
- Our equivalents: (i) per-tick re-derive — every grounded tick recomputes
  target velocity (system.rs:1791/1869, `USE_INTERPRETED_VELOCITY`), so the
  first post-touchdown tick re-derives ≤ one tick later than retail's event;
  (ii) landing detection + snap (`world.player.land()`, system.rs:2876 et al.);
  (iii) rig-side touchdown signalling in the wasm arm
  (lib.rs:40192/40383, `was_airborne_pre_tick` → touchdown clip).
- **Decision** (DESIGN.md:475–479, quoted): "our per-tick re-derive … may
  behaviorally subsume this; do NOT add an event-driven HitGround unless A1's
  ordering audit shows a late-by-one-frame landing artifact … — spec'd here so
  **the omission is a decision, not a hole**." Reopen trigger: the A1
  1070-gated ordering/feel audit showing a late-by-one-frame landing artifact.
- **Carve-out 1 — `RemoveLinkAnimations`:** no per-tick equivalent; its retail
  role (kill link/one-shot anims on landing) belongs to the A4-Q1/A4-Q2/A5-P1
  completion layer. **Owner now EXISTS, default-off** (updated from the spec's
  "unowned": W2 landed `USE_MOTION_TABLE_QUEUE` (3172c03e) and W3/S5 landed the
  AnimationDone boundary `?hookDrain=`/`?mtQueue=` (8e0ed7eb)). NOT covered by
  the omission decision; owned there.
- **Carve-out 2 — `LeaveGround`:** NOT part of this omission. The legacy
  walk-off-ledge launch freezes the UNCLAMPED planar store (system.rs:3307
  region) vs retail's clamped `get_leave_ground_velocity`
  (acclient.c:344477–344484, 343806–343843, run_rate×4.0 clamp) — a REAL
  divergence. **Owner update vs spec:** W3/S6 (9568fc0a, D3-5) landed
  `USE_LEAVE_GROUND_VELOCITY` (default-off, movement/system.rs) — the clamped
  stamp at all three begin_fall ledge sites with the retail 0.0002-epsilon
  integrator fallback. This record cross-references it and decides nothing;
  the default-flip rides the normal flag campaign (R5).

## Deferred remediations (record-only; owner = A1-O5 code-half / W6)

- `?physics30hz` browser gate (decision c3).
- Per-object update clocks for tracked bodies (A1 §4 Stage O5).

## Open questions carried from the spec (not decided here)

1. Retail `MIN_QUANTUM_97` numeric value is inferred (all eight bndb
   initializers are 1/30; the `_97` copy is unmapped to a specific address).
   The record needs only "ACE floors at 1/30", which IS dual-cited.
2. A1 §3 row 6's "§2.6 precedent" doc was not located; RULINGS item 3 +
   common.rs/simulation.rs comments are cited instead.
3. JS first-frame default dt = 0.016 (index.js:1567/1569) and the Rust
   first-tick 16 ms default (tick_spine.rs:207–211) are a matched pair by
   convention only — no retail analog; listed, not decided.

## Pointer consolidation (Stage 2, comment-only — shipped with this record)

One-line pointers to this record were added at: simulation.rs (0.1-vs-0.2
parenthetical collapsed → (a)/(c2)), common.rs block comment (→ record),
scene3d/index.js A3 + tick-body comments (→ (b)), collision.rs quantum trio
(declared-dormant → (c4)), DESIGN.md HitGround block (→ (d)). Per-constant
docstrings and their ACE line cites were left untouched. Zero behavior delta;
no flag; manifest stays 4.
