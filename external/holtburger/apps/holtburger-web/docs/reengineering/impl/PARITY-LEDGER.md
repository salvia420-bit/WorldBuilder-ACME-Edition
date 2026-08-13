# PARITY LEDGER — movement / casting / combat 1:1 with retail

Opened 2026-08-12. **Purpose: stop the ping-pong.** This file is the single place a
conclusion is allowed to live. Everything else (agent reports, chat, commit messages) is
working material.

## RULES OF EVIDENCE (binding on everyone who edits this file)

A statement may sit in **L1 VERIFIED** only if BOTH hold:
1. it reduces to a **deterministic artifact** — a named `acclient.c`/`acclient.h` line, a DAT
   byte, an ACE source line, a wire capture, or a server log line; AND
2. the orchestrator (not only an agent) has **read that artifact directly**.

Anything else goes in **L3 OPEN** with a confidence label. Agent citations are *hypotheses
until re-read* — this project has repeatedly been misled by confident, stale file:line.

When something moves L3 -> L1, record who verified it and against what. When something is
overturned, it moves to **L2 REFUTED** and **never silently disappears** — the whole point is
that a future session can see the claim was already tried and killed.

---

## L1 — VERIFIED FACTS

### A. Animation authority in retail (verified by orchestrator against ~/ac-headers/acclient.c)

* **A1. Retail's client plays NO cast animation of its own.** `ClientMagicSystem::
  FreeHandsAndCastSpell` (`acclient.c:403775`) is nine lines: `MaybeStopCompletely`, the
  `CM_Magic::Event_Cast{Targeted,Untargeted}Spell` send, `IncrementBusyCount`. No motion call.
* **A2. The animation funnel is singular.** `CPartArray::DoInterpretedMotion` has ONE caller
  (`315761`, in `CPhysicsObj::DoInterpretedMotion`), which has ONE caller (`343993`, in
  `CMotionInterp::DoInterpretedMotion`). `MotionTableManager::PerformMovement`'s only three
  call sites (`326043/326079/326113`) are all inside `CPartArray`. `CPhysicsObj::DoMotion`
  — the sole autonomous entry — has exactly ONE call site in 31 MB: `717999`, inside
  `CommandInterpreter::MovePlayer`.
* **A3. Local player, server actions: applied iff non-autonomous.**
  `CPhysics::SetObjectMovement:311188` -> `if (autonomous == 0 || !IsThePlayer())`.
  `CMotionInterp::move_to_interpreted_state:344410` -> `(!IsThePlayer()) || action.autonomous == 0`.
* **A4. Retail's locomotion IS client-predicted.** `MovePlayer` -> `DoMotion` sets
  `last_move_was_autonomous = 1` (`317325`) and plays immediately; the server echo is dropped
  by A3; the client enforces its own refusal rules locally (`344639-344647`).
  `autonomy_level` defaults to 2 (`44837`, `717749`).
* **A5. Retail NEVER changes combat mode as part of casting.** Every caller of
  `ClientCombatSystem::SetCombatMode`: `CPlayerSystem::LogOnCharacter` (`397931`),
  `OnQualityChanged` (`409011`), `UseTime` (`409090`), `ToggleCombatMode` (`409422/409426`),
  `OnAction` (`410088/410093`). Nothing on the cast path.
  `gmSpellcastingUI::Cast` (`247796`) -> `ClientMagicSystem::CastSpell` (`404671`) does a
  client-side component check then sends the event. **Consequence: auto-switching to Magic on
  cast would be a NON-retail invention. Do not do it.**

### B. What vanilla ACE actually does (verified by orchestrator against ~/ace-server/Source)

* **B1. ACE broadcasts every cast windup to the caster themselves.**
  `Player_Magic.cs:605 DoWindupGestures` -> `EnqueueMotionMagic(chain, gesture, CastSpeed)`;
  `WorldObject_Networking.cs:1078-1092` builds `new Motion(Magic, cmd, speed)`, computes
  `GetAnimationLength(..., speed)`, `EnqueueBroadcastMotion(motion)`, then delays by exactly
  that length. `EnqueueBroadcast` (`:1376-1385`) does `self.Session.Network.EnqueueSend(msg)`
  FIRST.
* **B2. Cast motions are NON-autonomous; locomotion echoes ARE autonomous.**
  `MovementData(wo, Motion)` copies `IsAutonomous` from the Motion; `Motion(stance, cmd, speed)`
  (`Motion.cs:103`) never sets it -> false. The player-locomotion echo ctor
  `MovementData(Creature, MoveToState)` hardcodes `IsAutonomous = true` (`MovementData.cs:162`,
  under a comment calling it "a hack"). **This divides on exactly the same line as A3/A4 —
  three independent sources agreeing without being fitted to each other.**
* **B3. `CastSpeed = 2.0f`** — `Player_Magic.cs:603`, comment "from retail pcaps". Passed as the
  `speed` arg for windups AND the cast gesture (`:636, :645, :683, :685`).
  **`entities.js:1343 CAST_SPEED = 2.0` is therefore CORRECT. That constant is not the bug.**
* **B4. Slidecast distance is a SERVER rule.** `Player_Magic.cs:373-374`
  `Windup_MaxMove = 6.0f` (+ squared), enforced at `:874` with a `PlayerKillerStatus != NPK`
  exemption.
* **B5. ACE requires a wielded caster to enter Magic mode.** `Player_Combat.cs:872-882`:
  `CombatMode.Magic` with `caster == null` -> `SetCombatMode(NonCombat); return;`.
* **B6. ACE rejects a cast made out of Magic mode, silently.** `Player_Magic.cs:83-94`:
  `CombatMode != Magic && LastCombatMode != Magic` -> `SendUseDoneEvent(); return;` — a bare
  `UseDone`, WeenieError **None**, no text, no motion. It logs a WARN server-side.

### C. Our client's actual state (verified by orchestrator reading the repo)

* **C1. CASTING IS BROKEN — every cast is rejected by ACE.** Our client never enters Magic
  combat mode on the cast path. Evidence, three independent ways:
  (a) agent wire capture, 5 runs / 479 packets: **zero** `UpdateMotion` to the caster's own
  guid; reply is one `UseDone` (GameEvent 0x01C7) at 87-120 ms, error 0;
  (b) B6 above;
  (c) **the laptop's `ACE_Log.txt`** — 15 `CombatMode mismatch NonCombat` WARNs for
  `+Probe 3650` / spell 1998, at exactly the agent's run wall-clock times. Orchestrator read
  the log directly; the agent never had access to it.
  Earliest such warning: **2026-08-02**, and on a second character (`+Tester2`) — so this is
  not new and not character-specific.
* **C2. The local prediction masks the failure.** `playCastSequence` runs to completion and
  reports `outcome: "complete"` for a cast the server refused.
* **C3. Two independent echo-suppressors exist, both default-ON**, whose only purpose is to
  stop the server's authoritative motions overriding our fabricated ones:
  windups via `noteLocalSwingPrediction` (`entities.js:8812`) + the swallow at
  `loop.js:3481` (`dispatchParity`); the final cast gesture (low16 `0x2B..0x39`) via
  `castGestureParity` (`loop.js:272-297`).
* **C4. The retail-faithful path already exists and is already wired to the wire speed.**
  `loop.js:3492` calls `em.setMotion(guid, cmd, stance, upd.motionSpeed)`, and
  `ENTITY_UPDATE_KIND_MOTION_ACTION` carries `motion_stance = UpdateMotion.current_style`
  (`lib.rs:26892`) — so the server-driven path gets the correct Magic stance FROM THE WIRE,
  which is structurally more robust than the prediction (WS01 had to patch exactly that
  failure — a stale `inst.currentStance` of NonCombat carries zero magic gestures).
* **C5. The multi-action queue drops the wire speed.** `motion_action_queue_rows`
  (`lib.rs:42190-42200`) emits `[guid, command, packed_sequence, stance]` — 4×u32, the f32
  `MotionItem.speed` is dropped. `drainMotionActions` then calls
  `em.setMotion(guid, cmdLow, stance, 1.0)` **hardcoded** (`loop.js:515`).
  `MULTI_ACTION_ON` is default-ON. Local guid is skipped (`loop.js:507`), so this bites
  REMOTE casters: gestures 2..N of a windup list play at 1.0 where the server said 2.0 — a
  2x duration error. **LIVE only if ACE ever packs >1 action into one UpdateMotion — see O3.**
  **FIXED 2026-08-13 (DEC-13): the row is now 5 u32 and carries `MotionItem.speed`.**
* **C6. `get_suggested_combat_mode()` is correct** — `context.rs:993-1007` returns `Magic`
  iff something wielded intersects `EquipMask::CASTER`. The mode machinery exists
  (`setCombatMode`, `toggleCombatMode`, `combatMode`); nothing on the cast path uses it.
* **C7. `UNIFIED_LOCO` is the only motion class still on the legacy three.js mixer.**
  attack/cast/death/door/missile default to the Rust `MotionSequence` authority
  (`entities.js:1006-1038`, `UNIFIED_MODE === "default"`); locomotion requires explicit
  `?unifiedMotion=locomotion|on`, gated on the B-1 movement-integrator claim (see O5).

* **C8. THE SAME ROOT CAUSE BREAKS MELEE AND MISSILE, NOT JUST CASTING.** ACE rejects an
  action whose combat mode does not match, identically in all three:
  `Player_Magic.cs:83-94` (Magic), `Player_Melee.cs:55-66` (Melee, `OnAttackDone(); return;`),
  `Player_Missile.cs` `HandleActionTargetedMissileAttack` (Missile, same shape). Each logs a
  WARN and returns silently. **STATUS 2026-08-13: melee + missile were already gated
  client-side with visible feedback (K4); the CAST lane was not, and was reachable from
  the hotbar (K5) — fixed by DEC-12.** **`ACE_Log.txt` already contains a real melee
  instance:**
  `2026-08-02 16:41:59 +Tester2.HandleActionTargetedMeleeAttack(80002A65, 2, 1) - CombatMode
  mismatch NonCombat, LastCombatMode NonCombat`. So one precondition bug accounts for three of
  the four parity asks (casting, melee, missile).
* **C9. (was O7) The action path fakes `is_autonomous` but DOES carry speed.** `lib.rs:47423`
  hardcodes `is_autonomous: false` on the `KIND_MOTION_ACTION` EntityUpdate rather than
  threading `MotionItem.packed_sequence` bit 15 — any logic keying off `!isAutonomous` reads a
  constant. BUT `motion_speed: action_speed` on the same struct (`:47421`) is the REAL wire
  speed. So the main path is faithful on speed; only the queued tail (C5) is not.
  Verified by orchestrator 2026-08-12.
* **C10. A reachability probe for O3 already exists in the code.** `lib.rs:47448-47454` logs
  `[multi-action] guid=0x%08X commands=N (>=2 reachable)` whenever a single UpdateMotion
  carries >=2 actions — gated on `DIAG_VERBOSE`. Watching the console for that string settles
  O3 without any new instrumentation.

### D. Instrument capability (settled — stop re-litigating this)

* **D1. The retail-client-under-Wine oracle CANNOT resolve animation timing.** Its channel is
  a ~1 Hz c2s heartbeat (`WINE-RIG.md §7`: min 145 ms / median 1058 ms / max 1874 ms). Steady
  speed is measurable; accel ramps, jump arcs and gesture timing are not. This is Nyquist, not
  technique — more captures cannot recover it.
* **D2. For cast/melee/missile, a retail capture adds ~ZERO information**, because by A1-A3
  the animation is a pure function of the server broadcast, and retail and we are driven by
  the SAME vanilla ACE. **The queued "retail driver for cast/stance" should be dropped, not
  built.** Retail's remaining unique value is locomotion prediction timing (A4) and the
  slide-during-gesture composite.
* **D3. Animation timing is closed-form** from MotionTable + Animation DAT +
  `CSequence::update_internal` + `AnimSequenceNode::multiply_framerate`. A derivation oracle
  beats any capture on precision and is cargo-testable.

### E. Round-3 measurement — a cast ACE accepts (agent-measured, orchestrator-verified where noted)

* **E1. The server sends the COMPLETE windup chain to the caster, in order, correctly spaced.**
  4 gestures + a return-to-Ready, ONE `UpdateMotion` each, `movement_seq` strictly monotonic
  (7->11), identity/order matching the client's cast table exactly, 3/3 casts.
* **E2. On-wire speed is 2.0** on every windup and the cast gesture, 3/3 casts. **It rides
  `InterpretedMotionState.forward_speed`, NOT `MotionItem.speed`.**
* **E3. `FastTick` is OFF on this ACE** — one message per gesture; `commands[]` empty in 15/15
  messages. Source: `FastTick => IsPKType`, and our probe is NPK. **So C5's hardcoded 1.0 and
  the `drainMotionActions` local-guid skip are DORMANT for us — but both go live for a PK
  caster. Latent landmines, not current bugs.**
* **E4. `is_autonomous` is NOT faked on the main path** (C9's worry, withdrawn): `loop.js:224-238`
  surfaces the real wire bit, `FORCE_MOTION_LOCAL_ON` is unconditionally true (1070 eye-test
  2026-06-10), and `is_autonomous=false` was measured on all 15 messages — correct per ACE
  semantics. Residual: the `commands[]` branch still does not thread per-item bit 15.
* **E5. THE LIVE DEFECT — the cast gesture double-plays, 3/3 casts.**
  `noteLocalSwingPrediction` stamps a **500 ms** wall-clock window; the cast gesture's echo
  lands **+584 / +756 ms** after the local prediction (or, when the prediction lags, BEFORE the
  note exists). The dedup misses, `loop.js:3413` falls through "fail-open", `forceLocal`
  re-issues `setMotion`, and the clip restarts. The agent modelled the client's own dedup in
  40 lines and reproduced the shipped counters **exactly, 3/3**.
* **E6. ACE emits the caster VFX itself.** `WorldObject_Magic.cs:358-359` —
  `caster.EnqueueBroadcast(new GameMessageScript(caster.Guid, spell.CasterEffect,
  spell.Formula.Scale))`, and `EnqueueBroadcast` sends to self first. **Verified by
  orchestrator.** This kills round-2's objection that removing prediction loses the VFX.
* **E7. The combat-mode failure was a HARNESS GAP, not a product bug.** Wield a caster +
  `setCombatMode(8)` reaches Magic first try. C1 stands as "casting was broken *for the probe*";
  it is NOT a shipping defect for a player who wields a wand and toggles.
* **E8. Round 2's wield failure explained (an ACE bug, not ours).** `@comps` creates ~76 items
  and fills the pack; a later `@ci` then fails `TryAddToInventory`, but `HandleCI`
  (`AdminCommands.cs:2565-2567`) **ignores the return value** and broadcasts
  "has created X (0xGUID) in their inventory" unconditionally. The guid never existed.
  ("You can't wield that!" is OUR client's string; "Item not found!" is ACE's.)
* **E9. Trap: gesture SHAPE != target CATEGORY.** A spell with `shape:"Self"` (=
  `MagicSelfHead`, a gesture) may have `flags.selfTargeted: false`. Round 3's untargeted casts
  animated fully, returned `UseDone(None)`, and applied nothing.
* **E10. RESOLVED 2026-08-13 — see K7 / DEC-14.** Data gap (was unchased): `data/spells-catalog.json` has `duration: 0` for **all 6266**
  entries while the DAT carries the real value (e.g. 60 for spell 2639).

### F. Round-4 verification of DEC-6 (agent-measured, orchestrator-verified)

* **F1. DEC-6 does what it intended and survived an adversarial check.** All four gestures still
  animate, each **exactly once**, and their starts now track the server's `UpdateMotion`
  arrivals to ~20 ms instead of `playCastSequence`'s local schedule. Dedup inert (`noted: 0`),
  proven against a positive control showing the counter can still move. The agent verified the
  page was running the post-change file (`hasServerDrivenGesture: true`,
  `hasCastSetSwingMotion: false`, `hasCastNote: false`) before any cast, and that
  `picking.js` was byte-identical (so melee's note path was untouched).
* **F2. IT ALSO EXPOSED A REAL PRE-EXISTING DEFECT — the unified one-shot ignored motion speed.**
  `entities.js` `_unifiedSeq` advanced at raw `dt`, while its `_unifiedLoco` sibling scaled
  correctly (and its comment even says it is applying "the same math the mixer path applied via
  setEffectiveTimeScale"). So every one-shot played at 1.0x regardless of the wire.
  Measured: wire `forward_speed = 2.0` on 14/14 gesture messages, `inst._motionSpeed` read `2`,
  and the one gesture that ran to completion took **0.796-0.847 s against an authored 0.7917 s
  (0.93-0.99x)** in 5/5 runs. The agent explicitly flagged that the preempted windups' apparent
  "2.02x" is a CIRCULAR measurement (their wall time is just the server's inter-gesture gap,
  which is authored/2 by construction) — only the completed gesture is honest.
  **This governs melee / missile / death / door one-shots too, not just casts.**
  Pre-DEC-6 the mixer applied speed at play time, so casts started at 2.0x and only fell to
  1.0x once the echo's `_unifiedSeq` took over — i.e. DEC-6 turned an intermittent bug into an
  unconditional one, which is how it surfaced.
* **F3. Retail anchor for the fix.** `AnimSequenceNode::multiply_framerate`
  (`acclient.c:340968-340979`) is `framerate = multiplier * framerate` (and swaps low/high for a
  negative multiplier). With a fixed-dt playhead that is `advance(dt * speed)`.
  **Verified by orchestrator.**

### G. THE ROOT CAUSE — `anims.first()` (local latency-analysis agent + orchestrator-verified)

**This is the most load-bearing finding of 2026-08-12. It replaces E5's explanation.**

* **G1. `src/lib.rs:8811` reported only the FIRST AnimData segment of a motion link.**
  A magic windup link carries **TWO** segments — a forward raise and a REVERSE-framerate lower.
  ACE's authoritative `MotionTable.GetAnimationLength(stance, motion, currentMotion)`
  (`ACE.DatLoader/FileTypes/MotionTable.cs:151-160`) SUMS every segment, each as
  `(highFrame - LowFrame) / Math.Abs(anim.Framerate)`. **Verified by orchestrator, both sides.**
  Three separate errors in one expression:
  1. first segment only (should be all) — the dominant term;
  2. INCLUSIVE `(high - low + 1)` (ACE is exclusive) — ~1 frame long per segment;
  3. `framerate > 0.0` guard (ACE uses `abs`) — scored every reverse segment as 0.0, and
     ~22% of retail AnimData are reverse-framerate.
* **G2. IT WAS A HALF-APPLIED FIX.** `src/lib.rs:8245-8250` (`build_concatenated_motion_frames`,
  T4 2026-05-28) already concatenates ALL segments, and its comment literally reads
  "(was `anims.first()`)". The same fix was never applied to the DURATION path, so the baked
  CLIP and the reported DURATION have disagreed with each other since 2026-05-28.
  **Verified by orchestrator.** The stale docstring at `:8776-8782` asserted "always `Anims[0]`
  … every link has exactly 1 anim" on a 5,455-entry validation — that validation covered MELEE
  SWING links, and was quietly false for magic.
* **G3. CLOSED-FORM PREDICTION MATCHED MEASUREMENT.** Client sleeps `firstSegInclusive/2`;
  server delays `GAL/2`. Drift per Iron-scarab windup = **+206.4 ms**. Over three windups the
  predicted total is **619.3 ms**; Cast B measured **619 ms**. Mean measured drift across
  6 increments: +188 ms/gesture.
* **G4. THE DOUBLE-PLAY IS NOT LATENCY-INDUCED — it happens at RTT = 0.** Decomposition of the
  E5 deltas: the CONSTANT term (first-gesture delta, mean 101 ms) is the WAN round trip and
  matches the 85 ms ICMP floor; everything after is the G1 accumulation. Derived over
  `data/spell-cast-sequence.json`: **3,145 of 6,256 spells (50.3%) breach the 500 ms dedup
  window on a zero-latency link** (median drift 567 ms, p90 1,205 ms, max 3,404 ms).
  1-windup 1,767/3,287 miss; 2-windup 805/807; 3+ windup 573/573.
  **O9 is hereby ANSWERED: ~85% real defect, ~15% rig.** Total rig-only quantization budget
  (netDrainHz 30 -> 33 ms quantum, renderOnDemand, netWorker) is ~17 ms mean / ~33 ms worst
  case absent a stall — it cannot explain 188 ms/gesture.
* **G5. The shipped wasm DOES match `src/lib.rs`** (no `.rs` newer than the 13:42 rebuild), which
  was the analysis agent's own self-declared "single check I'd run first". Its constants stand.

* **G6. THE TWO-SEGMENT MODEL IS CONFIRMED TO 8 SIGNIFICANT FIGURES, FIVE TIMES.**
  Orchestrator computed `N/24 + N/F` (raise @24 fps + reverse lower @ F fps) and compared it
  against `data/spell-cast-sequence.json`'s own `durationS`:
  `0x10000070` 1.0795455 vs 1.0795455 · `0x10000072` 2.0192308 vs 2.0192308 ·
  `0x10000074` 2.8750000 vs 2.875 · `0x10000076` 3.6764705 vs 3.6764706 ·
  `0x10000078` 4.4407897 vs 4.4407895. Five 8-digit matches are not coincidence.
  Drift/2 reproduces exactly: 206.4 / 363.8 / 479.2 / 567.4 / 637.1 ms.
* **G7. THE PROJECT ALREADY KNEW THIS, IN WRITING, FOR A MONTH.**
  `tests/test_ws11_cast_gesture_timing_parity.mjs` (2026-07-12) states in its header:
  "a windup MotionData is a raise+reverse-framerate lower round-trip = **2 anims**".
  Meanwhile `src/lib.rs:8776-8782` asserted "every link has exactly 1 anim". Two parts of the
  codebase held contradictory beliefs about the same DAT structure for a month. The test could
  not catch it because it validates the JSON against its OWN DAT-dumped GAL table and never
  exercises the wasm. **Lesson for the ledger: a test that re-derives ground truth instead of
  calling the shipped code proves nothing about the shipped code.**
* **G8. THE REAL MECHANISM — a correct value was overridden with a wrong one.**
  WS11's own invariant #1 is `GAL == durationS` for WINDUPS, i.e. our JSON was ALREADY right.
  `CAST_GESTURE_LEN` (`?castGestureLen`, DEFAULT-ON) then replaces `durationS` with the wasm
  link duration (`entities.js:8856-8859`) — which G1 made half-length. WS11 introduced that
  override because for the CAST GESTURE `durationS` (talisman `_time`) is 1.7-3x too long; it
  was correct there and harmful for every windup. **DEC-10 does not require reverting WS11 — it
  makes the value WS11 reaches for correct for BOTH gesture kinds.**
* **G9. A THIRD site carries the same single-anim assumption:** WorldBuilder.Terminal's
  `motion-classify-swing` (`JsonCommandProcessor.cs:1206-1228`) returns ONE
  `lowFrame/highFrame/framerate`, so the DAT oracle cannot express a multi-segment link either.
  Not chased; recorded so the next person does not trust it for durations.
  (Related tooling gap, agent-reported: DatReaderWriter's JSON serialization collapses every
  inner `MotionData` map to a single entry — 318 outer keys all reporting 1 inner, while
  `motion-classify-swing` reports the true `innerLinkCount = 54`.)

### H. OWNER DOMAIN KNOWLEDGE — SLIDECASTING, FASTCAST, AND THE INVISIBLE ANIMATION BREAK
*(Given by the owner 2026-08-12. This is PLAYER knowledge that cannot be derived from the
decomp or the DATs. Treat it as a primary source — it is a description of retail behaviour by
someone who performed it. Reference video: https://www.youtube.com/watch?v=YdZEnm3rtbo)*

**Owner's framing:** "people playing it will view this, well integrated, as the bar for
success." Also: fastcasting "might work on retail but not holtburger-web". Presumes a HIGH
LEVEL character.

**H1. Keys are RETAIL bindings** (see WINE-RIG.md §6): `c` = right sidestep, `z` = left
sidestep, `x` = walk backward, arrow keys = TURN left/right. In holtburger's layout the
emitter remap is `s->x, a->z, d->c, q->a, e->d`.

**H2. THE BASE CAST (a 4-key held chord; ORDER OF PRESS MATTERS).**
| phase | hold in THIS order | then repeatedly tap |
|---|---|---|
| start slide RIGHT | `c` (right strafe) · right arrow · `x` (back) · forward arrow | right arrow |
| return slide LEFT | `z` (left strafe) · right arrow · `x` · forward arrow | forward arrow |
| start slide LEFT | `z` (left strafe) · left arrow · `x` · forward arrow | left arrow |
| return slide RIGHT | `c` (right strafe) · left arrow · `x` · forward arrow | forward arrow |
All four keys are held SIMULTANEOUSLY before the tapping begins.

**H3. WHY IT MATTERS IN PLAY.** Dodges arcs and bolts. Makes the caster "appear to jump around
other players' screens and rubberband" — a large PvP advantage. Note this is a NETWORK-visible
effect, i.e. it emerges from the interaction between client-predicted autonomous movement and
what observers extrapolate; it is not purely local.

**H4. THE INVISIBLE ANIMATION BREAK — cancels the cast animation ON YOUR OWN SCREEN while it
stays VISIBLE TO OTHERS.** Method: during the window in which the cast animation would appear,
you must hold a STRAIGHT-LINE strafe.
* Worked example (mid return-slide RIGHT, i.e. holding `c` + left arrow + forward arrow + `x`,
  tapping forward): about halfway through, almost at casting position, RELEASE EVERYTHING BUT
  `c`; still holding `c`, hold right arrow then back arrow (IN THAT ORDER).
* Mirror (returning LEFT — `z` + right arrow + `x` + forward arrow, tapping forward): release
  all but `z`, then hold left arrow and back arrow.
* **The slide must be LOCKED STRAIGHT during the windup — curving it breaks the effect.** After
  the windup window passes you may curve freely.
* Harder with war magic than life magic, but achievable; timing is the whole skill.

**H5. WHY THIS SHOULD WORK AT ALL — it exploits exactly the A1/A4/A7 partition.** The local
player's LOCOMOTION is client-predicted (A4/Q7) while the CAST GESTURE is server-driven (A1).
So a locally-issued locomotion motion can displace the gesture on YOUR screen, while other
players still receive the server's broadcast of it. **The animation break is a direct
behavioural consequence of the authority split this ledger already established** — which is
strong independent corroboration of §A.

**H6. ⚠ OUR CLIENT ALMOST CERTAINLY CANNOT DO IT TODAY.** `entities.js` tick is
`if (inst._unifiedSeq) {…} else if (inst._unifiedLoco) {…}` — the one-shot wins
UNCONDITIONALLY ("single playhead"), so a strafe during a windup cannot displace the gesture.
Retail instead composes: `GetObjectSequence`'s action branch (`acclient.c:337842-337857`) does
`clear_physics` + `remove_cyclic_anims`, adds the action, then **re-appends the current
locomotion cycle LAST**; and `CSequence::remove_link_animations` exists to drop pending link
anims. **OPEN: the exact predicate that makes a STRAIGHT-LINE strafe cancel the local action
where a curving one does not.** That is the implementable core of H4 and it is not yet known.

**H7. BETTER TEST SPELLS (owner-supplied; replaces Repulsion 2639 as the baseline).**
`4451` Incantation of Lightning Bolt (windup `0x10000132`, cast `0x40000033`) ·
`4484` Incantation of Lightning Vulnerability Self (cast `0x40000039`, untargeted) ·
`2344` Stamina to Mana Other VII (cast `0x40000035`).
All THREE are single-windup `0x10000132` = MagicPowerUp08Purple, whose pre-fix drift is
**+567.4 ms** — i.e. each breaches the 500 ms dedup window on ONE windup (the
"1,767 of 3,287 single-windup spells miss" case in G4). PowerUp08Purple is NOT one of the four
over-declaring links, so it tests DEC-10 cleanly, free of the clamp confound.

### I. THE 1070 CAST RIG — reproducible recipe (stood up 2026-08-12, worked first try)

Replaces the buildbox for cast work: real GPU, **~4.7 ms RTT floor** vs the buildbox's 85 ms,
and it cannot be preempted. A person uses this box — off-screen + `--mute-audio` ONLY.

1. **Launcher** (write locally with CRLF, `scp` it — here-strings through ssh->cmd->powershell
   break). `C:\Temp\launch-hb.bat`:
   `start "" "C:\Program Files\Google\Chrome\Application\chrome.exe"
   --remote-debugging-port=9333 --remote-allow-origins=* --use-angle=d3d11
   --ignore-gpu-blocklist --mute-audio --disable-features=CalculateNativeWinOcclusion
   --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   --user-data-dir=C:\Temp\cdpwb-hb --window-position=-32000,-32000 about:blank`
   ⚠ the three occlusion/backgrounding flags matter: an off-screen window is otherwise treated
   as occluded and throttled, which would corrupt every timing measurement.
2. **Launch in the INTERACTIVE session** (needs the owner logged in — check
   `(Get-Process explorer).Count == 1`):
   `schtasks /create /tn hbchrome /tr C:\Temp\launch-hb.bat /sc once /st 00:00 /it /f & schtasks /run /tn hbchrome`
3. **Three tunnels, one command, NO `timeout` wrapper** (breaks `-f`, exit 144):
   `ssh -o ExitOnForwardFailure=yes -fN -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 young@100.127.215.75`
4. **Prove the GPU INSIDE the page** — string alone is not proof. Draw a scissored clear and
   `readPixels`. Expect `ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 (0x00001BE1) Direct3D11 …)`
   and the pixel you wrote (`[51,153,229,255]` for `(0.2,0.6,0.9)`).
5. **Drive with playwright-core `connectOverCDP`** — it lives ONLY in
   `~/.npm/_npx/e41f203b7505f1fb/node_modules`; ESM needs a `node_modules` SYMLINK next to the
   script, and the script must `process.exit()` or it hangs.
6. **Caster setup** (round 3's recipe, reproduced first try): `@addallspells` · `@comps` ·
   `@safecomps on` · `@ci 12748` · read the guid from **`sessionHandle.playerInventory()`**
   (NEVER from chat — ACE's `HandleCI` reports success even when the pack is full) ·
   `setWielded(guid, validLocations & 0x01000000)` · `setCombatMode(8)`.
   Gates: wand in inventory -> `entityEquippedWeapon()` non-zero -> `combatMode() === 8`.
   Then **`@god`** — a fresh character fizzles constantly and runs out of mana.
7. **Cast with `castTargetedSpell(guid, spellId)`**, NOT `castSpell()` — the untargeted form
   animates fully and applies nothing (E9).

**I1. Observation point that actually works:** poll `inst._unifiedSeq` per `requestAnimationFrame`
and record start/end transitions. `__diag.motion.onMotionLinkPlayed` does NOT fire for this path
(`coverage.cast` stayed 0 while gestures visibly played) — an empty recorder is a broken
instrument, not a passing test.

**I2. RESULTS ON THE REAL GPU (6 landing casts of Repulsion 2639 + 2 of Incantation 4484).**
* Every gesture starts **exactly once** — DEC-6 confirmed at the playhead, not by counter.
* `speed = 2.0` on every one-shot — DEC-9 confirmed (was 1.0x).
* Iron windup gaps mean **549.7 ms** vs ACE's 540 ms (+10 ms = the ACE tick) — DEC-10 confirmed.
* **Incantation of Lightning Vulnerability Self (4484): windup 1823 / 1831 ms vs ACE's
  1838.2 ms — 15 ms and 7 ms.** Pre-fix that windup would have paced at 1270.8 ms, a
  **-567 ms** error on a SINGLE windup.
* **Pyreal windup gap 1790 ms mean vs clamped 1776 ms (+14) — the UNCLAMPED value would be
  2220 ms.** A 444 ms separation, far outside the ~30 ms run-to-run noise: ACE definitively
  paces on the clamped length. Independently, the baked clip for Pyreal is **120 frames = 2x60**
  (the animation's real length) where its AnimData declares 0-75; Iron bakes 32 = 2x16 exactly
  as declared. **Our bake path already clamps; our duration path still does not.**

**I3. Spells our catalogue advertises that ACE cannot cast.** `2344` Stamina to Mana Other VII
-> `[Use failed] MagicInvalidSpellType`, the same "spell not implemented, yet!" branch
(`Player_Magic.cs:397-399`) that r3 hit with `1998`. Our DAT-derived table is a superset of
ACE's implemented set; a cast failing this way is a DATA mismatch, not a client bug.

### J. THE ANIMATION BREAK — MECHANISM FOUND (R6 decomp; orchestrator-verified)

* **J1. ⚠ A MAGIC CAST GESTURE IS A PURE CYCLE, NOT AN ACTION.** `Motion_MagicSelfHead =
  0x4000002C`, `Motion_MagicBlast = 0x4000002B`, `Motion_CastSpell = 0x400000D3` — all carry
  `0x40000000` and NOT `0x10000000`. Melee `Motion_AttackMed1 = 0x10000063` IS an action.
  **The WINDUPS (`0x100000xx`) are actions; the CAST GESTURE is a cycle.** Our own
  `castGestureParity` comment (`loop.js:272-297`) already said this — it is why the cast gesture
  needed a SECOND dedup on the KIND_MOTION path. Corrects the loose reading of §A that treated
  the whole cast chain as "actions".
* **J2. THE CANCEL PATH.** Every performed motion is appended to
  `MotionTableManager::pending_animations` as `{motion, num_anims}` (`add_to_queue:330149`),
  which then calls `remove_redundant_links:330078`. That walks BACKWARD from the newest node
  looking for an older node with the same motion id — **but only if the newest is a PURE CYCLE**
  (`v3 & 0x40000000 && !(v3 & 0x20000000)`, `:330099`). On a match,
  `truncate_animation_list:329842` sums the `num_anims` queued after it and calls
  `CSequence::remove_link_animations(seq, sum)` (`:329855`), **deleting those one-shots out of
  the local CSequence** and snapping the playhead onto the locomotion cycle (`:339975-339981`).
  **Verified by orchestrator at 330095-330120 and 329842-329860.**
* **J3. WHY STRAIGHT-LINE IS REQUIRED — the walk aborts on a MODIFIER node that has anims.**
  `:330112`: the walk continues only while a node has no anims OR lacks
  `0xB0000000` (STYLE|MODIFIER|ACTION); otherwise it returns. `Motion_SideStepRight/Left =
  0x6500000F/0x65000010` and `Motion_TurnRight/Left = 0x6500000D/0x6500000E` all carry the
  MODIFIER bit `0x20000000`. A **held** strafe re-issues through the no-op early-out
  (`:337773`) yielding `num_anims == 0` → invisible to the walk. A strafe that is re-acquired,
  reversed, or displaced out of its substate slot **by a turn** emits a fresh MODIFIER node WITH
  anims → the walk dies on it. **Straight = every intervening node is 0-anim or pure-cycle.
  Curved = a MODIFIER node with anims blocks it.** This is exactly the owner's H4 rule, derived
  independently from the binary.
* **J4. Observers are untouched** — they replay the server broadcast via
  `apply_interpreted_movement:344147` + the action loop at `:344396`, and never see the caster's
  local `pending_animations` queue. Hence "invisible to you, visible to them" (H4/H5).
* **J5. WHAT OUR CLIENT WOULD NEED.** Today the tick is
  `if (_unifiedSeq) {…} else if (_unifiedLoco) {…}` — one-shot wins unconditionally, so no
  locomotion input can displace a gesture (H6). Retail has no such precedence: it keeps a
  QUEUE of `{motion, num_anims}` and prunes it. Reproducing H4 needs that queue plus the
  same-motion backward walk with the `0xB0000000`-with-anims abort — NOT a special case for
  strafing. **Design note: this is a real feature, not a bug to paper over; it is a PvP
  technique players will judge us on.**
  **UPDATE 2026-08-13 (PARITY-D) — the queue is LANDED; see DEC-17.** The precedence
  described above is gone: a one-shot no longer clobbers an in-flight one-shot. What remains
  open is the CMotionInterp side of H4 (the walk that snaps the playhead back onto the
  locomotion cycle), not the queue structure.

### K. Round-7 (PARITY-B, combat lane, 2026-08-13) — verified against re-read artifacts

* **K1. R9's netWorker premise is FALSE — the side-channel thread_locals live on the
  MAIN thread in BOTH modes.** `src/net_worker.rs`'s own module doc (`:18-28`): the worker
  owns ONLY the raw wire I/O — `WsTransport` + the `holtburger_session::Session` state
  machine (ISAAC crypto, packet/fragment sequencing, reassembly, ACK, keepalive ping) —
  and "Everything else stays exactly where it is on the main thread: the recv loop, the
  entire `GameMessage` dispatch `match`, …"; `:86-88` "`SessionCommand` / `ClientEvent` /
  `EntityUpdate` never cross — they stay main-thread". Inbound crosses as RAW decrypted
  game-message payload bytes (`RX_KIND_MESSAGE`, `scene3d/net_worker.js:52`) which
  `net_proxy_push_inbound` (`net_worker.rs:256`) pushes into the MAIN-thread recv loop.
  The `UpdateMotion` parse that fills `MOTION_ACTIONS` / `MOTION_AXES` therefore runs in
  THIS page's wasm instance. **The `?netWorker=1` caveat at `scene3d/loop.js` (the
  DRAIN-WIRING FIX block) was simply wrong, and it was the stated blocker on judging
  DEC-6.** Comment corrected in place. Read directly by PARITY-B.
* **K2. ACE puts the per-item `Speed` on the wire for EVERY MotionItem, at CastSpeed.**
  `Network/Motion/MotionItem.cs` — the class carries `public float Speed`, its wire reader
  does `Speed = reader.ReadSingle()` and `PackedCommandExtensions.Write` does
  `writer.Write(mc.Speed)` as the third field after command + packed sequence.
  `WorldObject_Networking.cs:1230-1237` `EnqueueMotionAction` passes its `speed` argument
  to `InterpretedMotionState.AddCommand(this, motionCommand, speed)` for EVERY command in
  the list, and `AddCommand` (`Network/Motion/InterpretedMotionState.cs:110-116`) builds
  `new MotionItem(worldObject, motionCommand, speed)`. `DoWindupGestures` calls it with
  `CastSpeed = 2.0f`. **So C5's hardcoded `1.0` was a real 2x duration error on gestures
  2..N of a PK/FastTick caster's windup, not a cosmetic one.** Read directly by PARITY-B.
* **K3. `MotionItem` bit 15 IS the autonomy flag, and it already rides the side-channel.**
  `MotionItem.cs`: `PackedSequence` — "write: `(motionSequence & 0x7FFF) | (autonomous & 0x1
  << 15)`", `IsAutonomous = (PackedSequence >> 15) == 1`. Our row already carries the FULL
  `packed_sequence` (the JS drain masks `& 0x7fff` for the stamp), so E4's residual is a
  CONSUMER gap, not a transport gap — nothing downstream of `drainMotionActions` keys off
  autonomy. Pinned by a native test rather than papered over with an invented consumer.
* **K4. C8 IS ALREADY CLOSED FOR MELEE AND MISSILE, from a normal player's controls.**
  `scene3d/picking.js` `fireAttackOnSelectedTarget` gates on the server-confirmed stance
  (`isInMeleeStance` / `isInRangedStance`) and, on a miss, logs and calls
  `emitActionRejected("You are not in melee or missile combat mode.")` →
  `clientActionRejected` → `plugins/rejection_feedback.js:331`, which renders it on the
  shared toast surface. The gate is STRICTER than ACE's (ACE also accepts via
  `LastCombatMode`), so it can never let a silently-eaten attack through. **E7's downgrade
  holds for melee and missile.** Read directly by PARITY-B.
* **K5. C8 WAS STILL OPEN FOR CASTING, and it was reachable from a normal control.**
  `ui/ac_cast_spell.js` `castSpellViaHandle` had NO combat-mode gate, and
  `plugins/hotbar.js:739/754` fires a hotbar spell at ANY stance (unlike the spell strip,
  which `plugins/combat-bar.js` only displays when `__getCurrentStanceLow() === 0x49`).
  A hotbar cast in Peace mode therefore vanished with zero feedback: ACE
  `Player_Magic.cs:83-94` (targeted) / `:275-283` (untargeted) log a WARN and
  `SendUseDoneEvent()` — WeenieError None, no text, no motion. **Fixed (DEC-12).**
* **K6. ACE's `LastCombatMode` is stamped at REQUEST time, so `CombatMode` alone is NOT a
  safe client-side predicate.** `Player_Combat.cs:762` `LastCombatMode = newCombatMode;`
  runs inside `HandleActionChangeCombatMode` BEFORE `HandleActionChangeCombatMode_Inner`,
  which is itself deferred behind `NextUseTime` on an ActionChain when the player is inside
  the use-time window. All three lanes then read
  `if (LastCombatMode == <mode>) CombatMode = <mode>;` as an escape hatch. **There is a real
  window in which ACE accepts a cast that `CombatMode` says should fail — precisely the
  "toggle to Magic then immediately cast" pattern in §H.** A naive `combatMode() !== 8`
  gate would have EATEN those casts, i.e. traded one silent no-op for a worse one.
  Read directly by PARITY-B.
* **K7. E10 CONFIRMED AND FIXED — and the DAT says only 4,374 of the 6,266 should be
  non-zero.** `ACE.DatLoader/Entity/SpellBase.cs:78-84` reads `Duration = reader.ReadDouble()`
  for `SpellType.Enchantment` and `SpellType.FellowEnchantment` ONLY; every other
  MetaSpellType has no duration field in the record at all (PortalSummon's `PortalLifetime`
  is a different field and is NOT a duration). LSD carries the value at
  `meta_spell.spell.duration`: spell 2639 Repulsion = **60.0**, exactly E10's figure.
  Trap avoided: LSD ALSO reports a duration on 19 of the 21 `EnchantmentProjectile` (15)
  rows, which the DAT reader does not read — gating on presence instead of on `sp_type`
  would have shipped 19 values the retail record does not contain. **Fixed (DEC-14).**


### L. Round-8 (PARITY-C, melee/missile lane, 2026-08-13) — verified against re-read artifacts

* **L1-1. VERIFIED — retail CMT `0x30000000` is keyed on SINGLE-BIT `AttackType` only.**
  All 102 maneuvers dumped directly from `~/ac_base_dats/client_portal.dat` by a new
  example, `crates/holtburger-dat/examples/dump_cmt_attack_types.rs`:
  `0x0001`x11 `0x0002`x12 `0x0004`x21 `0x0008`x3 `0x0010`x7 `0x0020`x9 `0x0040`x9
  `0x0080`x6 `0x0100`x6 `0x0200`..`0x4000`x3 each — **zero multi-bit rows.**
  SwordCombat rows for `Thrust|Slash = 0x06`: **0** (for `0x02`: 3, for `0x04`: 6).
  And the lookup is an exact dictionary match, not a flag test —
  `ACE.DatLoader/FileTypes/CombatManeuverTable.cs:75`
  (`attackTypes.Table.TryGetValue(attackType, out var maneuvers)`), read directly.
* **L1-2. VERIFIED — our melee swing prediction MISSED the CMT for most weapons in the game.**
  `ui/ac_attack_type_for_weapon.js::inferAttackTypeForWeapon` returns the wire
  `W_AttackType` **verbatim** ("Don't mask, don't AND"), which is multi-bit on most real
  weapons (`Thrust|Slash = 0x06` swords, `DoubleSlash|DoubleThrust = 0xA0` daggers), and
  `ui/ac_combat_maneuver.js::getCombatManeuver` keys the tree with an exact
  `typeMap.get(attackType)`. By L1-1 that can never hit a row -> `motionCmd === null` ->
  `picking.js` fell through to `em.setSwingPose(localGuid)`, the canned "vibe pose" arm
  tween, instead of the real SlashMed/BackhandMed/ThrustLow clip. **Fixed (DEC-16).**
* **L1-3. REFUTED IN PLACE — the in-file claim that `getCombatManeuver` resolves multi-bit
  values "via the IsThrustSlash branch" was FALSE.** There is no such branch: `opts.isThrustSlash`
  only picks `subdivision` (0.33 vs 0.66) AFTER the lookup has already succeeded, and
  `picking.js` never passed `opts` at all, so `subdivision` was **always 0.33** even for
  thrust/slash weapons where ACE uses 0.66 (`Player_Melee.cs:457-458`). Two stale comments
  corrected in place. See L2/R12.
* **L1-4. VERIFIED — ACE's server-side collapse is `WorldObject_Weapon.cs:1050-1161`
  `GetAttackType(stance, powerLevel, offhand)`** with `ThrustThreshold = 0.33f`
  (same file, line 1033), called from `Player_Melee.cs:456` inside `GetSwingAnimation()`,
  which is the function whose result ACE broadcasts as the swing motion
  (`Player_Melee.cs:406-424`). Read directly. Ported to JS (DEC-16).
* **L1-5. VERIFIED — the missile aim-level ladder is already faithful.** ACE
  `Creature_Missile.cs:435-465 GetAimLevel` computes `zAngle = normalize(velocity).Z * 90`
  and buckets at `>=82.5 / 67.5 / 52.5 / 37.5 / 22.5 / 7.5`, then `> -7.5 / -22.5 / -37.5 /
  -52.5 / -67.5 / -82.5`. `ui/ac_aim_level_for_velocity.js:129-147` matches term for term
  INCLUDING the inclusive/exclusive asymmetry at the AimLevel band. No defect found;
  nothing changed here. Also re-confirmed L1-1's corollary: the CMT has zero ranged-stance
  rows, so the missile branch's CMT call is diag-only by design and its miss is not a bug.


---

### M. Round-9 (PARITY-D, animation core, 2026-08-13) — verified against re-read artifacts

* **M1. O11 WAS ALREADY LANDED — the ledger's L3 entry was STALE.** The frame clamp is
  implemented at BOTH frame-resolution sites and committed:
  (a) the DURATION path, `classify_motion_link_for_swing` (`src/lib.rs:8806`, clamp block at
  `:8955-8969`: substitute on `high == -1`, then `if high > num_frames { high = num_frames }`,
  `(high - low).max(0) / abs(framerate)` summed over ALL segments), with the resolver
  `anim_frames` supplied for real by `SessionHandle::lookup_motion_link_for_swing`
  (`src/lib.rs:39346`, closure at `:39376-39386`, reading `Animation::read(...).num_frames`
  out of the same `eor/portal` source);
  (b) the BAKE path, `build_concatenated_motion_frames` (`src/lib.rs:8388`, clamp at
  `:8452-8462`). Commit `6dc18041` ("...plus O11 frame clamp"). **O11 is RESOLVED**; nothing
  was left to do but say so.
* **M2. RETAIL'S CLAMP, re-read directly (L1).** `AnimSequenceNode::set_animation_id`,
  `acclient.c:341085`, body at `:341110-341123`:
  `if (high_frame < 0) high_frame = num_frames - 1; if (low_frame >= num_frames) low_frame =
  num_frames - 1; if (high_frame >= num_frames) high_frame = num_frames - 1; if (low_frame >
  high_frame) high_frame = low_frame;`. **Retail clamps to `num_frames - 1` INCLUSIVE**; ACE
  clamps to `num_frames` EXCLUSIVE and subtracts. Both name the same last playable frame — the
  off-by-one is the inclusive/exclusive convention, not a disagreement. Our bake path follows
  retail (inclusive `.min(last)`), our duration path follows ACE (exclusive), which is correct
  because ACE is what paces the server we are driven by.
* **M3. RETAIL'S `pending_animations`, re-read directly (L1).** `MotionTableManager` owns
  `DLList<AnimNode> pending_animations` (`acclient.h:31103`); `AnimNode : DLListData
  { unsigned motion; unsigned num_anims; }` (`acclient.h:57614-57618`). Four methods:
  `add_to_queue(motion, num_anims, seq)` (`acclient.c:330149`) appends then ALWAYS calls
  `remove_redundant_links`; `AnimationDone(success)` (`:329873`) `++animation_counter` then
  pops every head whose `num_anims <= counter`, firing `CPhysicsObj::MotionDone` and
  subtracting — so a `num_anims == 0` node retires WITHOUT EVER PLAYING;
  `remove_redundant_links(seq)` (`:330079`) is the collapse; `truncate_animation_list(node,
  seq)` (`:329842`) sums `num_anims` from the tail down to (excluding) `node`, ZEROES each
  node's `num_anims` in place (the nodes stay, and still fire their MotionDone) and calls
  `CSequence::remove_link_animations(seq, total)`.
* **M4. THE COLLAPSE'S ACTUAL SELECTOR (corrects a J3-adjacent assumption).**
  `remove_redundant_links` picks the tail node with `num_anims != 0` and branches on its
  motion `m`: `if ((m & 0x40000000) && !(m & 0x20000000))` walk back to an earlier node with
  the SAME motion and `num_anims != 0`, aborting on any anim-bearing node matching
  `0xB0000000`; `else if (m & 0x80000000)` walk back to the same motion (num_anims ignored),
  aborting on `0x70000000`; **otherwise no collapse at all.** `Motion_SideStepRight`
  `0x6500000F` sets BOTH `0x40000000` and `0x20000000`, so a strafe is ineligible for THIS
  collapse in both branches. J2/J3's "same-motion backward walk" is the walk inside
  `CMotionInterp`, a DIFFERENT walk — the two were being conflated.

## L2 — REFUTED / CORRECTED (do not resurrect without new evidence)

* **R12. "Multi-bit `W_AttackType` is handled downstream by `getCombatManeuver`'s
  IsThrustSlash branch."** FALSE — asserted in two comments in
  `ui/ac_attack_type_for_weapon.js` (the `inferAttackTypeForWeapon` docstring and the
  Wave-6 wire-path comment) since 2026-05-26. `getCombatManeuver` has no such branch;
  it does an exact `typeMap.get(attackType)`, and `opts.isThrustSlash` only selects the
  post-lookup power subdivision — and `picking.js` never passed `opts`. Refuted by
  reading both functions plus the 102-row CMT dump (L1-1/L1-2). Both comments corrected
  in place; the real collapse now lives in `resolveAttackTypeForStance` (DEC-16).

* **R1. "`contact_allows_move` blocks casting."** FALSE. It is `vfptr[11] = IsCreature`, an
  AIRBORNE check (gravity + CONTACT_TS + ON_WALKABLE_TS). Claimed confidently by an earlier
  agent. Slidecast is permitted and EMERGENT: `CSequence` carries one global velocity that
  `add_motion` overwrites, and the action branch (`337851`) re-appends the locomotion cycle
  LAST. Caveat: cast initiation DOES call StopCompletely — you stop on the keypress, then may
  move again for the rest of the windup.
* **R2. "Our `CAST_SPEED = 2.0` is a tuned magic number."** FALSE — it matches ACE's
  `CastSpeed = 2.0f` exactly (B3). Four rounds of cast-timing corrections (F8-1, F6-2, WS11,
  WS01) were tuning the animation of a cast that never happened (C1). There was no server
  behaviour to converge on, which is why nothing settled.
* **R3. FLAG-DEFAULT FOOTGUN — three live instances found 2026-08-12.** The `!== "off"` reader
  idiom returns TRUE when the parameter is absent. Comments claiming "default-off" are wrong:
  - `dispatchParity` — `loop.js:362` says DEFAULT-ON (correct); `loop.js:3475` says
    "default-off" (WRONG).
  - `multiAction` — default-ON; the 2026-06-18 handoff calls it "default-OFF, pending
    eye-test" (STALE).
  - `castGestureParity` — default-ON.
  **Never trust a default from a comment or a doc. Read the reader.**
* **R4. "`?unifiedMotion` defaults to off."** Half-true and dangerous: `entities.js`'s
  `UNIFIED_MODE` defaults to `"default"` = every class EXCEPT locomotion. But
  `motion/motion_sequence.js::unifiedMotionMode()` returns `"off"` when absent — two readers,
  two answers. `entities.js` is the one that governs playback.
* **R5. Orchestrator's own initial leaning — "delete the prediction layer" — was WRONG as a
  first move**, and the round-2 agent killed it: on today's build the server-driven path
  produces literally nothing, so deleting prediction ships a caster who stands still.
  Order matters: fix the precondition, re-measure, then consider the deletion.
* **R5b. Orchestrator error 2026-08-12: "the `.d.ts` says 3=Missile, 4=Magic".** FALSE — I
  fabricated that while paraphrasing a truncated grep. The real docstring
  (`pkg/holtburger_web.d.ts:5696-5697` and `lib.rs:37620-37627`) correctly says
  **4=Missile, 8=Magic**, matching BOTH ACE's `[Flags]` enum and retail's `eCombatMode`
  (`acclient.h:4966-4973`). I nearly "fixed" correct code off my own error. Callers
  (`target-bar.js:73-74`) only use 1 and 2, which are safe under either reading.
* **R7. `tests/test_ws03_cast_overlay_guard.mjs` PART 2 fails on clean master** — 20 passed /
  3 failed, identical before and after the 2026-08-12 edit (verified by A/B against a backup).
  It greps for `CAST_OVERLAY_GUARD` in `entities.js`, which a teardown removed. **Stale test,
  nobody's regression.** Do not attribute it to a change you are making.
* **R8. E5's explanation of the double-play is SUPERSEDED by G1.** E5 correctly measured
  *that* the echo misses the 500 ms window; it wrongly implied the window was the problem.
  The window is fine; the client's per-gesture duration was ~half the truth. **Do not "fix"
  this by widening the 500 ms constant** — that treats the symptom and would still leave the
  client's busy-window / CasterEffect / spellCastResolved firing ~600 ms early.
* **R9. Orchestrator's DEC-6 rationale was partly wrong.** Removing the prediction was NOT the
  fix for the double-play (G1 is), and DEC-6 introduces a real regression: a **PK/FastTick**
  caster under `?agent=1` loses windups 2..N, because ACE packs the whole windup list into one
  `UpdateMotion.commands` vector and the `pollMotionActions` side-channel that carries them is
  DEAD in the net worker (`loop.js:456` — the thread_local lives in the worker's wasm
  instance). With a local prediction that player still saw their windups. **DEC-6's
  ARCHITECTURAL basis (A1/A2) is untouched; its symptom justification is withdrawn.**
  **R9's netWorker HALF IS ITSELF REFUTED (2026-08-13, K1): the `pollMotionActions`
  thread_local lives on the MAIN thread in worker mode too — `src/net_worker.rs:18-28`
  and `:86-88` — so the side-channel was never dead under `?agent=1`. The stale
  `loop.js` caveat that asserted otherwise has been corrected. What REMAINS true in R9
  is only that the PK/FastTick windup tail rides that side-channel; it now also rides it
  at the correct speed (DEC-13). With the channel proven live and its speed fixed, R9's
  objection to DEC-6 is answered — see DEC-11/DEC-15.**
* **R6. Brief errors worth remembering.** `@safecomps off` ENABLES consumption (the message is
  inverted from intuition); `?agent=1` silently forces `netWorker` ON
  (`net_worker_client.js:133`), moving the socket into a worker target;
  `window.scene3d` does not exist (`window.liveScene3d`); `castUntargetedSpell` has zero call
  sites — the faithful path is `__pluginClient.player.castSpell(id)`; the first cast after
  login never predicts (`spell-cast-sequence.json` loads lazily) so a warm-up cast is
  mandatory; `loop.js`'s netWorker caveat near `:456` is stale.

---

## L3 — OPEN QUESTIONS (with what would settle each)

* **O10. Cast on ANOTHER PLAYER is untested.** Owner notes Incantation of Lightning
  Vulnerability is meant for a second player; today's runs were self-cast, which exercises the
  animation path but not `TargetEffect` VFX, remote-observer rendering, or the PvP-visible
  rubberband of §H3. **Next: stand up a second god character (laptop-side headless client is
  cheapest) as the target.**
* **O11. RESOLVED 2026-08-13 (PARITY-D) — the clamp was already landed; this entry was
  stale.** See M1/M2 for the two implementing sites and the retail/ACE inclusive-vs-exclusive
  reconciliation. No code change was needed. Kept here (rather than deleted) because two
  successive agents deferred it as outstanding work that did not exist.

* **O1. Does a properly set-up cast (wand wielded, Magic mode) succeed, and what does the
  server's chain look like?** -> ROUND 3, in flight.
* **O2. Per-action `speed` on the wire — is it 2.0 in practice?** -> Round 3. Never yet
  observed, only inferred from ACE source.
* **O3. RESOLVED (E3 answered it; DEC-13 fixed the consequence 2026-08-13).**
  Is ACE's `FastTick` on? Decides whether all windups arrive in ONE `commands` list
  (making C5's speed bug LIVE and the `drainMotionActions` local-guid skip load-bearing) or
  one message per gesture (C5 latent). -> Round 3. **Also settleable from the console string in C10.**
* **O4. Was the combat-mode failure a PRODUCT bug or a HARNESS gap?** i.e. can a normal player
  wielding a wand and pressing the combat-mode toggle cast fine? -> Round 3. Changes what gets
  fixed.
* **O9. ⚠ THE ROUND-3 TIMING NUMBERS ARE LATENCY-CONTAMINATED — RAISED BY THE OWNER 2026-08-12.**
  The probe rig puts a WIDE-AREA NETWORK inside the measurement. **The wsbridge is on the
  LAPTOP (Newfoundland), colocated with ACE** — `holtburger-wsbridge --listen 0.0.0.0:8080`,
  pid 2345 — and the browser runs on the buildbox in **us-central1 (Iowa)**, reaching it over
  the orchestrator's `-R 8080` reverse SSH tunnel. So EVERY client<->server message crosses
  ~2,800 km. **Measured raw ICMP RTT laptop<->box = 85.090 ms avg (min 84.468 / max 86.132 /
  mdev 0.498)**; HTTP round-trips over the same tunnel were 208-386 ms.
  Therefore the E5 deltas (+76/+260/+379/+584 etc.) mix at least: (a) WAN latency,
  (b) `netDrainHz=30` -> a 33 ms drain quantum, (c) headless `renderOnDemand` scheduling
  jitter, (d) any genuine client-vs-ACE per-gesture duration mismatch.
  **A constant offset is latency (rig artifact); an ACCUMULATING term is a real defect.**
  Cast A's deltas grow rather than staying flat, so something does accumulate — but the split
  is not yet established. A local read-only agent is decomposing it.
  **Until that lands, treat E5's magnitudes as UNTRUSTWORTHY and DEC-6's justification as
  resting on the ARCHITECTURAL argument (A1/A2/E1/E2/E6), not on the 584-756 ms figure.**
  Cast C's deltas are negative and non-monotonic (+89, -370, -566, -253), which latency alone
  cannot produce — a second mechanism is present in that run.

* **O5. Does B-1 still reproduce?** The 2026-06-18 claim that the movement integrator
  "overshoots the run target (25 m/s vs 4.5 m/s) and oscillates Walk->Stop->Walk sub-second"
  when the crossfade band-aids are bypassed. It is the sole blocker on `UNIFIED_LOCO` (C7) and
  it PREDATES MOVE-F2/F3/F6 and MOVE-RUNRATE-105. **Treat as STALE until re-measured.**
  Settleable at 60 Hz with `?moveTelemetry=1` + `?nullRender=1`, no GPU.
* **O6. strafe-diagonal is 1.3% slow** (retail 8.468, holt 8.362 — the only FAIL in the
  third parity report). Orchestrator's closed-form from `common.rs` constants
  (`RUN_ANIM_SPEED*run_rate`, `SIDESTEP_ANIM_SPEED 1.25`, `SIDESTEP_ADJUST_FACTOR 1.248`,
  `MAX_SIDESTEP_ANIM_RATE 3.0`) predicts ~8.463 for our own run_rate — i.e. **our measured
  value is ~1.2% below our OWN formula**, which points at plumbing, not the formula.
  Settleable by a cargo test calling `local_velocity_for_state` directly (separates "formula
  wrong" from "capabilities wrong" — the exact fix-A-masks-fix-B trap that already bit
  ORACLE #1).
* **O7. RESOLVED 2026-08-12 -> promoted to C9.**
* **O8. ORACLE #1 fix is unmerged** — branch `orch/s13-oracle`, 6 commits; augmentation
  doesn't reach the movement lane. Needs a compile check + suites before merge.

---

## L4 — DECISIONS

* **DEC-1 (2026-08-12).** Do NOT build a retail driver for cast/stance. Superseded by D2.
* **DEC-2 (2026-08-12).** Do NOT auto-switch combat mode on cast. Non-retail (A5).
* **DEC-3 (2026-08-12). SUPERSEDED by DEC-13 (2026-08-13).** Do not touch C5's speed drop until O3 answers whether it is live. — O3 is answered (E3: FastTick => IsPKType, dormant for our NPK probe, live for a PK caster) and the fix landed on ACE-source evidence rather than a probe.
* **DEC-4 (2026-08-12).** No new URL flags (owner directive). Flipping an existing default is
  not a new flag; adding one is.
* **DEC-6 (2026-08-12). LANDED: the local cast prediction no longer ANIMATES.**
  `entities.js` `playCastSequence` — removed `setSwingMotion` + `noteLocalSwingPrediction`
  from the per-gesture step; kept classification, WS11 duration, sleeps, busy window,
  CasterEffect, diag. Justified by A1/A2 (retail predicts nothing), E1/E2 (the server sends the
  whole chain at 2.0) and E5 (the dedup window cannot be made to work by tuning). **Chose
  deletion over widening the 500 ms constant deliberately — retuning it would be the
  ping-pong move.** Cast suite 6/7 pass, the 7th is R7 (pre-existing). Round 4 verifying.
* **DEC-7 (2026-08-12). LANDED: corrected the stale "default-off" comment** at `loop.js:3476`
  for `?dispatchParity`, which is DEFAULT-ON. It had already cost two sessions a misdiagnosis.
* **DEC-8 (2026-08-12).** C5 (hardcoded `1.0` speed on the multi-action drain) stays UNFIXED
  for now — E3 proves it is dormant for NPK and I will not land an unverifiable change. It
  becomes real for PK casters; fix it WITH a PK probe that exercises the branch.
  **RESOLVED 2026-08-13 by DEC-13, WITHOUT a PK probe.** The premise — that the change is
  unverifiable without one — was wrong: the branch's input is `MotionItem.Speed`, whose
  value ACE fixes at the source (K2), so a native test over a synthetic multi-item list
  pins the transport exactly. A PK probe would have re-observed a constant we can read.
* **DEC-9 (2026-08-12). LANDED: one-shot playback now honours motion speed.**
  `entities.js` — new `_unifiedOneShotSpeed(inst)` helper; the three `_unifiedSeq` creation
  sites capture `speed`; the tick advances `dt * (ua.speed ?? 1)`.
  **Captured at BUILD time, not read per tick** — the mixer path it replaces read
  `_motionSpeed` once when the action started, so a per-tick read would let a LATER locomotion
  broadcast retempo a swing already in flight. Assignment order makes this safe: `_motionSpeed`
  is set at `:9960`, `_tryPlayLink` runs after (`:10262/10302/10386`). Verified by orchestrator.
* **DEC-10 (2026-08-12). LANDED: `classify_motion_link_for_swing` sums ALL segments.**
  `src/lib.rs` — all segments, exclusive `(high - low)`, `abs(framerate)`; a link containing
  any `high_frame == -1` segment still reports 0.0 (we do not parse the Animation DID here, so
  it is unpriceable) preserving the caller's `> 0` fallback contract. Justified by G1-G4.
  **This is the actual defect. It is correct under BOTH architectures** (with prediction, it
  fixes the animation cadence; without, it fixes the busy-window / CasterEffect clock).
* **DEC-11 (2026-08-12). DEC-6 IS ON PROBATION, NOT REVERTED.** It is uncommitted. Re-judge it
  AFTER DEC-10 is measured, and only once the PK/netWorker windup gap in R9 is closed.
  Reverting reflexively would be its own ping-pong; so would defending it reflexively.
* **DEC-12 (2026-08-13). LANDED: the cast path no longer sends a cast ACE will silently
  eat.** New `ui/ac_combat_mode_intent.js` mirrors ACE's `LastCombatMode` (stamped at
  request time at every client site that sends a combat-mode change:
  `plugins/combat-bar.js`, `plugins/target-bar.js`, `plugins/api.js` — an untyped
  `toggleCombatMode()` records "unknown"), and `ui/ac_cast_spell.js` `castSpellViaHandle`
  blocks + emits `clientActionRejected("You are not in magic combat mode.")` ONLY when
  the confirmed combat mode, the confirmed stance, AND the last requested mode are all
  positively non-Magic. **Fail-open everywhere else** (K6 — a stale `combatMode()` must
  never cost a fastcaster a cast). **DEC-2 COMPLIANT: it never changes combat mode**;
  there is an explicit negative-control test for that. Closes C8 for the magic lane;
  K4 shows melee/missile were already closed. 10/10 new tests
  (`tests/test_c8_cast_combat_mode_gate.mjs`, registered tier 5).
* **DEC-13 (2026-08-13). LANDED: the multi-action side-channel carries the wire speed.**
  Supersedes DEC-3/DEC-8's "wait for a PK probe". `motion_action_queue_rows`
  (`src/lib.rs`) now emits **5** u32 per action —
  `[guid, command_low, packed_sequence, stance, speed_f32_bits]` — and
  `drainMotionActions` (`scene3d/loop.js`) reinterprets the bits through a shared
  4-byte ArrayBuffer and passes the real speed to `em.setMotion` instead of a hardcoded
  `1.0`, falling back to 1.0 only on a non-finite/non-positive float. **Justified by K2,
  a re-read of ACE's own wire writer, not by a probe run** — the branch's INPUT is fully
  determined by `MotionItem.Speed`, so a native test over a synthetic multi-item list
  pins it exactly as a PK capture would, without needing a PK character. DEC-8 asked for
  a probe because the fix was believed unverifiable; it is verifiable at the source.
  4/4 `tests_windup_action_order` green, including a new mixed-speed/mixed-autonomy case.
* **DEC-14 (2026-08-13). LANDED: E10 — spell durations are real.**
  `scripts/build_spells_catalog.py` pulls `meta_spell.spell.duration` gated on
  MetaSpellType Enchantment(1) / FellowEnchantment(12), mirroring
  `ACE.DatLoader/Entity/SpellBase.cs:78-84`. Regenerated: **4,374 of 6,266** entries now
  carry a real duration (was 0/6266); Repulsion 2639 = 60.0 s, matching E10's predicted
  value; Lightning Bolt 4451 (a Projectile) correctly stays 0. Harness unchanged at
  242 passed.
* **DEC-15 (2026-08-13). DEC-6 IS COMMITTED, not reverted — DEC-11 resolved.** The two
  conditions DEC-11 set are both met: DEC-10 has been measured (I2 — Iron windup gaps
  549.7 ms vs ACE 540; Incantation 4484 windup 1823/1831 ms vs ACE 1838.2; every gesture
  starting exactly once at the playhead, not by counter), and the R9 gap is closed —
  its netWorker half was never real (K1) and its remaining half, the PK windup tail, now
  plays at the correct wire speed (DEC-13). The architectural basis was never in doubt
  (A1/A2/E1/E2/E6, F1 adversarially). Reverting would reintroduce the fabricated-animation
  layer plus the dedup window that G4 shows breaches on 50.3% of spells at ZERO latency.
  **Judged by PARITY-B on the evidence, per DEC-11's instruction not to leave it hanging.**
* **DEC-16 (2026-08-13). LANDED: the melee CMT lookup collapses `W_AttackType` first.**
  New `resolveAttackTypeForStance(rawAttackType, stance, powerLevel)` +
  `isThrustSlashAttackType(raw)` in `ui/ac_attack_type_for_weapon.js` — a line-for-line
  port of ACE `WorldObject_Weapon.cs:1050-1161` (DualWieldCombat / SwordShieldCombat /
  SwordCombat branches, the Offhand-bit strip at 1057-1061, and the universal
  `Thrust|Slash` collapse at 1154-1160, `ThrustThreshold = 0.33`). `scene3d/picking.js`'s
  melee branch now calls it before `getCombatManeuver`, and passes
  `{ isThrustSlash }` so `subdivision` is **0.66** for thrust/slash weapons per
  `Player_Melee.cs:457-458` instead of always 0.33. Justified by L1-1..L1-4.
  **Deliberately NOT ported: `GetOffhandAttackType`** (`WorldObject_Weapon.cs:1104+`),
  which needs the per-swing `DualWieldAlternate` toggle (`Player_Melee.cs:442-445`) that
  the client does not track — an offhand main-hand guess would predict a swing the server
  did not choose. **Deliberately NOT invented: any client-only reduction for masks ACE
  itself leaves multi-bit** (e.g. `Slash|DoubleSlash` in SwordShieldCombat) — the port
  reproduces the miss, because a prediction the server would not make is worse than none.
  DEC-2 compliant (no combat-mode change); DEC-4 compliant (no new URL flag).
  Tests: `tests/cmt_attack_type_collapse.test.mjs` — 11/11 pass, transcribing the ACE
  branches case by case; the DAT evidence is `crates/holtburger-dat/examples/dump_cmt_attack_types.rs`.
* **DEC-5 (2026-08-12).** Fix order for casting: precondition (C1) -> re-measure -> only then
  reconsider the prediction layer (R5).

---

* **DEC-17 (2026-08-13). LANDED: the retail `pending_animations` queue (J5).**
  New `scene3d/motion_queue.js` transcribes `MotionTableManager`'s queue verbatim from the
  decomp (line refs in M3/M4 and in the file header) as pure functions over an array;
  `scene3d/entities.js` wires it BEHIND the existing single playhead — `inst._unifiedSeq` is
  still the only thing that advances, `inst._unifiedQueue` only orders what follows it. **No
  second advance loop exists**, which was the explicit non-negotiable (a queue racing the
  playhead would be worse than the gap). Sites: the attack/cast one-shot build now calls
  `_enqueueUnifiedOneShot(inst, toCmd, segmentCounts.length, rec)` instead of assigning
  `_unifiedSeq`; the tick's completion arm calls `_unifiedOneShotFinished` (retail
  `AnimationDone`) then promotes the next head; death, despawn, the door/missile direct
  one-shot, and any new locomotion/stance command drain the pending tail
  (`_clearUnifiedQueue`, retail `HandleExitWorld`/`Destroy`).
  **TWO DELIBERATE DEVIATIONS, both documented in code:**
  1. Retail's `truncate_animation_list` can retract frames from the LIVE sequence
     (`CSequence::remove_link_animations`). We retract only PENDING entries; when the collapse
     target is the in-flight head we drop the newcomer and let the head run. Same observable
     outcome for a re-issue (it is invisible), NOT the same for a mid-link retraction.
  2. Retail's queue is unbounded; ours caps pending entries at 3 (`_UNIFIED_QUEUE_MAX`),
     dropping the OLDEST pending — never the head — past that, so a wire storm degrades into a
     dropped gesture instead of unbounded animation lag.
  **Verification:** `tests/motion_pending_queue.test.mjs`, 9 cases transcribed from the decomp
  branches (append order; 0-anim node retires immediately; a 2-anim node needs 2
  AnimationDones; ACTION-class re-issue collapses; `0xB0000000`-with-anims aborts the collapse;
  a 0-anim node is transparent to the walk; strafe `0x6500000F` ineligible in both branches;
  no target -> plain queue; the in-flight head is never spliced). 9/9 pass. Whole
  `node --test tests/` suite: **63/63 pass** (`combat_bar_skill_stride` was failing in the
  shared tree when this work started — A/B'd with `git stash` and confirmed pre-existing and
  unrelated; another agent fixed it during the session). **Browser eye-test NOT done** — this
  changes when a queued gesture plays, and the visible consequence (a second swing arriving
  mid-swing now finishes the first) wants a live look before anyone calls it validated.
  Branch `parity-d-animation-20260813`, commit `45f4a32d`.

## L4b — REGRESSION BASELINE (established 2026-08-12, A/B against pristine files)

Do NOT attribute these to a change you are making. Re-measure with `git checkout --` before
blaming yourself; that A/B is cheap and this project has misattributed before.

* `harness/run-js-headless.mjs` — **242 passed, 12 failed, 1 missing (of 257)**, byte-identical
  with and without the DEC-6/DEC-7/DEC-9 edits.
* `tests/test_ws03_cast_overlay_guard.mjs` — **20 passed, 3 failed** on clean master (R7).
* `cargo test -p holtburger-web --lib` — **230 passed, 1 failed, 4 ignored**;
  `tests_substitution::resolve_static_placement_frame_orders` fails identically on pristine
  `lib.rs` (A/B'd 2026-08-12). Pre-existing, unrelated to motion.
* `cargo test -p holtburger-dat` — 694/1, `terrain_subdiv::triangle_corner_ring_matches_
  height_sampler` fails identically on clean master (pre-existing, per the 08-11 handoff).

## L5 — RIG STATE (2026-08-12)

Laptop + buildbox both at `9747971d`. Release wasm rebuilt 6,665,975 B (was STALE — `lib.rs`
and 5 crate files were newer than `pkg/`). `serve.py` restarted (it had been up 2 days with a
256 MB compress cache warmed against the old wasm) and `--check` passes.
ACE alive on :9000/:9001. Buildbox is in **us-central1-b** (SPOT n1-standard-4 + T4);
`memory/fleet-runbooks.md` still says `us-central1-a` and is read-only to the orchestrator —
**owner must fix.** Reverse tunnels laptop->box: `-R 8765` (serve.py), `-R 8080` (wsbridge).
Bot accounts `agentp07..10` are all accessLevel 4 (Developer); `tailnet1` is the owner's, never use it.
