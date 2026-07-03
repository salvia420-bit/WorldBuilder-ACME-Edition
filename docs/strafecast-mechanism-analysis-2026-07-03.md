# Strafecast reverse-engineering — the caster's instructions × the retail decomp (2026-07-03)

Triangulation exercise: corner 1 = first-hand instructions from a top retail-era PvP
caster (verbatim text from the user, sequences normalized in §1); corner 2 = the
client decomp that player was running. Derive corner 3: the mechanisms.

Decomp sites available (the four): `$DECOMP/acclient.c` (final-client Hex-Rays C,
line-cited below), `acclient.h` (typed structs), `acclient.txt` (raw PDB dump),
`acclient_2013.bndb_pseudo_c.txt` (2013 client, Binary-Ninja, SYMBOLIZED vtables).
**Primary pick: `acclient.c`** — the era matches endgame play and every function
below is recoverable there; the 2013 dump was used exactly twice, where the 2005
Hex-Rays output hides vtable dispatch (§3.4, §3.5 — it resolves `vfptr[6]` =
`HandleNewForwardMovement` and its body = `SetAutoRun(0,1)`).

## §1 The instructions, normalized

Key → command: `c`=SideStepRight `0x6500000F`, `z`=SideStepLeft `0x65000010`,
right/left arrow = TurnRight/Left `0x6500000D/E`, `x`=WalkBackwards `0x45000006`,
forward arrow = (Run/Walk)Forward `0x44000007/0x45000005`. Wire/list class facts:
turn + sidestep have their own CommandLists; forward-axis commands
(`0x40000000|0x4000000` bits) share the SubstateList (`WhichList`, acclient.c:717402).

| # | Name | HOLD in exact order | then TAP |
|---|------|---------------------|----------|
| A | starting slide right | c, →, x, ↑ | → (turn right) |
| B | return slide left | z, →, x, ↑ | ↑ (forward) |
| C | starting slide left | z, ←, x, ↑ | ← (turn left) |
| D | return slide right | c, ←, x, ↑ | ↑ (forward) |
| E | chain wiggle (post-cast) | — | ←/→ taps, free-form |
| F | anim-break (from D) | release all but c; then hold →, then x/↓ | — (hold through the gesture window, path must be STRAIGHT) |
| F′| anim-break (from B) | release all but z; then hold ←, then x/↓ | — |

Invariants worth noticing before any code: every variant holds ONE sidestep + ONE
turn + BOTH forward-axis keys with forward pressed LAST (stack head = forward,
backward UNDERNEATH); "starting" slides tap the turn key, "return" slides tap
forward; the anim-break drops to a three-key held set with **no forward key** and
demands a straight path exactly during the gesture-apply window.

## §2 The machine (established facts, all cited)

1. **Per-axis command stacks.** Press → `CommandInterpreter::AddCommand` (:717429)
   pushes onto that axis's list (head = newest); release → `NukeCommand` (:717458)
   pops, and if another key remains on the SAME axis it **re-dispatches the new
   head as a fresh press** (head-wins pop-through); empty → a stop dispatch.
   A held key never re-fires on its own.
2. **Single-axis dispatch.** Each edge routes ONE motion:
   `MovePlayer` (:717800) → `CPhysicsObj::DoMotion`/`StopMotion` (:317325/:317364),
   both of which set `last_move_was_autonomous = 1` (the autonomy latch) and apply
   only that motion's axis slot (`InterpretedMotionState::ApplyMotion` :332759 —
   forward-slot commands evict whatever owns the forward slot, incl. a cast
   gesture; turn/sidestep never touch it).
3. **The cast animation is SERVER-sent, even on retail.**
   `ClientMagicSystem::FreeHandsAndCastSpell` (:403775) only sends
   `CM_Magic::Event_Cast(Un)TargetedSpell` + bumps a UI busy count — the client
   starts NO local gesture. The windup/cast gestures arrive as non-autonomous
   General UpdateMotion for yourself.
4. **Every gesture stomp kills held movement, unconditionally.**
   `CPhysics::SetObjectMovement` (:311185-311193): for the player-controlled
   object only non-autonomous messages unpack, and the latch is stamped from the
   message flag (=0) immediately before `unpack_movement` →
   `move_to_interpreted_state` (:344372), which copies the axes
   (`copy_movement_from` — gesture into the forward slot, sidestep/turn as sent;
   retail's server, per ACE's pcap-derived comment on `persist_movement`
   PropertyManager.cs:575, did NOT carry your held strafe) and then calls
   `apply_current_movement(1, motion_allows_jump(old_fwd))` (:344394) — latch is
   freshly LOW, so it routes `apply_interpreted_movement` and your held keys die
   right there. **Taps cannot defuse the stomp itself.**
5. **`MotionDone` revives nothing** (:343641 — pops the pending node, action-class
   pops unstick + RemoveAction; no re-apply). The windup-end boundary is NOT a
   free revival event. (This kills the naive "held keys resume between windups"
   model.)
6. **The revival levers that DO exist:**
   - **`TakeControlFromServer` (:716934) — THE ENGINE.** Fires on a fresh command
     while `controlled_by_server`: sets `controlled_by_server=0`,
     `last_move_was_autonomous=1`, `StopCompletely`, **`StopInterpolating`**
     (drops the server position leash), then re-asserts hold_run and calls the
     interpreter-level `ApplyCurrentMovement` (:717027) which **re-dispatches the
     HEADS OF ALL THREE COMMAND LISTS** — every held key revives at once.
   - `SetHoldKey`/`set_hold_run` (:344497+) — a SHIFT edge re-applies the current
     movement with the current latch.
   - `SetHoldSidestep` (:717023) — the strafe-modifier toggle clears TurnList and
     re-applies all heads.
   - `HitGround`/`LeaveGround` (:344449/:344484) — landing/jump re-apply with the
     current latch ("jump resets the movement lock").
7. **Releases go silent under server control.** `HandleKeyboardCommand`
   (:717243): while `controlled_by_server`, a RELEASE is bookkept
   (list pop) but never dispatched — no stop, no latch raise. Presses fall
   through (and trigger TakeControlFromServer). Release behavior therefore
   DEPENDS on cast-machinery timing — a large part of why the technique feels
   arcane and timing-sensitive.
8. **`transient_state`** (AddCommand :717429 else-arm / NukeCommand /
   ApplyCurrentMovement): a non-list substate command wedges the forward axis —
   Ready-stops are suppressed and releases refuse to pop until a FORWARD-AXIS
   press clears it. (Another reason the forward keys are special.)
9. `controlled_by_server` is set by the cast/position machinery
   (`LoseControlToServer` :716832 — MoveTo/TurnTo directives incl. the cast's
   turn-to-face, and interpolation engagement), and starts =1 at login
   (constructor :717720 area).

## §3 Per-key trace at press time — and why the player presses it exactly then

**Setup holds (order c → turn → x → ↑), pressed BEFORE the cast lands:**
- `c` first: DoMotion(SideStepRight) → SidestepList head + sidestep slot drives.
  The slide's velocity source, engaged while the forward slot is still yours.
- turn second: TurnList head + turn slot — the curve (the dodge arc), and the
  axis the cast's turn-to-face will fight; keeping it stacked means every
  revival re-asserts YOUR heading intent.
- `x` third, `↑` last: the forward STACK becomes [x under ↑]. Forward drives for
  now. The stack shape is the payload: any later ↑-tap release POPS-THROUGH to a
  fresh x PRESS (:717458) — the forward axis never empties mid-dance, each flap
  is a fresh forward-slot owner (gesture eviction), and fwd/back alternation
  nets ~zero displacement — movement pressure without positional commitment.
- All four are in place before the first windup stomp so that every subsequent
  full revival (TakeControlFromServer's three-head re-apply) re-fires the WHOLE
  pattern with zero additional finger work.

**The cast begins (server-side): windup stomps + control grabs interleave.**
Each stomp (§2.4) kills all held movement and re-roots the forward slot with the
gesture. Each turn-to/interp engagement sets `controlled_by_server`.

**The taps ("after all four are held, start tapping…"):**
- Any tap = press+release edges = fresh DoMotions → latch HIGH (:317325) — and,
  decisively, whenever the cast machinery currently holds control, the press
  triggers **TakeControlFromServer → StopInterpolating + all-three-heads
  re-apply** → the ENTIRE four-key pattern revives in one frame. The tap is not
  "movement input"; it is a CONTROL-RECLAIM TRIGGER with the held keys as its
  payload. Tap cadence ≈ stomp/control-grab cadence — hence "start tapping" and
  hence war (more windups, more grabs) being harder than life.
- Why tap the TURN key on starting slides (A/C): a turn tap's own axis effect
  is a harmless dup push/pop on TurnList — it never touches the forward slot, so
  the windup animation you're inside keeps playing (the cast stays visually
  intact) while still working as the reclaim trigger. The dup-tap is the purest
  trigger available.
- Why tap FORWARD on return slides (B/D): the press evicts the gesture from the
  forward slot (:332759 — the anim visibly cuts: fastcast pressure), clears any
  `transient_state` wedge (§2.8), and the release pops-through to x — backward
  presses keep re-owning the slot. The return leg is the aggressive half: same
  reclaim trigger PLUS forward-slot denial. (Choosing which of the two per leg
  is, as the caster says, feel/timing — both are latch/control metronomes;
  their difference is only the tapped axis's side effect.)
- The end-of-cast "wiggle" (E): free-form taps to re-raise autonomy after the
  final gesture/FinishCast stomps, so the next cast starts from player-owned
  movement — "you can do whatever you want at the end".

**Why observers see jumping/rubberbanding:** every reclaim runs
`StopInterpolating` + `StopCompletely` — your local trajectory repeatedly snaps
out of the server-leashed path the moment you reclaim, while observers only get
your autonomous position packs + the full gesture broadcast (their client roots
your avatar for the cast, then position packs contradict it). The discrepancy IS
the "jump around other players' screens" — mechanically explained by the exact
two calls in TakeControlFromServer's body.

**The invisible animation break (F/F′):**
- "There is a set time when the animation of a spell will begin" = the CAST
  gesture's stomp arrival (§2.4), distinct from the windups.
- Releasing everything but the strafe DURING server control is SILENT (§2.7) —
  the lists empty without dispatching stops, so your sidestep keeps driving on
  its last-applied state while your finger load drops to one key.
- Then hold turn, then back "in that order": the turn press fires the reclaim
  (TakeControlFromServer) and the back press takes the forward slot — a
  player-authored backward now owns the slot at the moment the cast gesture
  would land; the re-applied heads are now ONLY strafe+turn+back (no forward
  key held) — a constant-velocity, non-committal drift.
- "Your slide must be locked in a straight line — you cannot curve it":
  best-supported reading — the gesture window's facing machinery. A changing
  heading re-engages the cast's turn-to directive (`LoseControlToServer` — a
  fresh control grab + re-leash + the gesture re-applied), and the break fails;
  a settled straight path keeps the facing error inside the turn-to's engage
  threshold so no new grab happens, and the locally-evicted gesture never gets
  re-asserted. The server, which never validates the client's animation
  timeline ("server cant detect animation break"), completes the cast; only
  your screen — and only because your forward slot stayed player-owned through
  the window — omits it. CONFIDENCE: the eviction + silent-release + reclaim
  parts are code-proven; the exact straight-line gate is the one inference
  (candidate #2: the velocity composition keeps you inside the server's
  `Windup_MaxMove` fizzle circle longer; both may be true — his "experiment
  with a friend watching" timing note is exactly what a threshold-race smells
  like from the inside).

## §4 What this changes for holtburger (follow-ups, not yet implemented)

- **FU-A (retail-faithful reclaim): port TakeControlFromServer's re-apply tail.**
  Our FU5 `consume_pending_take_control` does control-return + StopInterpolating
  but NOT the "re-dispatch all held axes" tail (:716953 → :717027). Retail edges
  are per-axis (our castMove Fix A is right) EXCEPT when the edge reclaims
  control from the server — then it's a full-pattern revival. Adding that makes
  the four-key+tap technique work literally as on retail.
- **Design note:** today's `?slideCast` (held sidestep/turn ride THROUGH stomps)
  is deliberately SMOOTHER than retail's burst reality (stomp-kill → tap-revive).
  With FU-A in place, `?slideCast=off` + FU-A ≈ the authentic burst feel;
  `?slideCast=on` = the modernized continuous feel. 1070 A/B both arms.
- **FU-B:** shift-edge and jump as revival levers already exist retail-side
  (§2.6) — verify our SetHoldKey/landing paths re-apply with the latch the same
  way (the "vtank speedbuff = down-key spam" lore likely lives in this family:
  a second forward-axis key under the stack + rapid pops = constant fresh
  forward presses).
- **FU-C:** the anim-break's silent-release rule (§2.7) — our client currently
  dispatches releases regardless of server control. For byte-level input parity
  the release path should check the server-control state.

## §5 Open ends / how to close them

- No retail-server pcaps exist locally (archive pcaps are 2019+ = emulator era),
  so retail wire content rests on ACE's own pcap-derived comments. If a 2012-17
  caster-session pcap ever surfaces: check the self UpdateMotion axes during a
  cast (settles §2.4's "no persist" for good) and the presence/cadence of
  self-directed TurnTo during casts (settles the straight-line gate).
- The 2013 pseudo-C cross-checks used here were vtable resolutions only; a full
  2013-vs-2005 diff of `CommandInterpreter`/`CMotionInterp` might reveal era
  drift in the control rules (the caster's prime era vs the final client).
- The tap-TIMING itself (his "subjective" part) is not recoverable from code:
  it's the human phase-lock onto the stomp/grab cadence, which varies with spell
  formula, latency, and the turn-to's engagement — exactly the parts he says
  need a friend watching.
