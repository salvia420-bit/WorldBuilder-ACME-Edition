# HANDOFF — physics parity + mage-PvP mechanics (2026-07-03)

## 2026-07-03 (session 2) — STRAFECAST landed (uncommitted work tree)

User report: "staffcasting/strafecasting still not there" — the retail mage dance
(locked into the cast, sliding left↔right). Root-caused + fixed + live-validated;
tree left UNCOMMITTED (no commit instruction given).

**Root cause (three layers, all now closed):**
1. **ACE self-stomp** — ACE echoes every cast gesture back to the CASTER as a
   non-autonomous General UpdateMotion with EMPTY sidestep/turn (NPK: one per
   windup via `EnqueueMotionMagic` WorldObject_Networking.cs:1078 — it IGNORES
   the `persist_movement` server dial; PK/FastTick: windup-start stomp via
   `EnqueueMotionAction` :1231 + the cast-gesture stomp). Each stomp killed a
   held strafe → the community's "slidecasting is completely fixable that ACE
   refuses to". Retail servers never re-stomped the caster (the caster's cast
   anim was CLIENT-authored — proven by the "invisible animation break" which
   only works if nothing re-asserts the gesture).
2. **Full-state edge install** (ours) — any input edge installed the ENTIRE
   held manual state, so a strafe tap resurrected a held W. Retail
   CommandInterpreter is per-axis lists w/ single-axis dispatch (`AddCommand`
   :717429, `NukeCommand` :717458 head-wins pop-through; full raw re-apply
   happens ONLY at event boundaries, `apply_raw_movement` :344259).
3. **No local anim-break** — the JS cast chain ignored movement taps.

**What landed (all default-ON, `=off` escapes; wasm rebuilt --release 4.68MB):**
- **`?slideCast`** (NEW, `USE_SLIDE_CAST`) — held sidestep/turn re-applied onto
  the interpreted axes after a General (case-0) self-stomp
  (`MovementManager::persist_held_manual_axes`, called from the
  `SelfServerControlledMotion` registry lane). EXACTLY ACE's own
  `Motion.Persist` axis set (Motion.cs:162-166 — sidestep+turn, NEVER forward;
  held W stays dead until a forward edge = the castMove core). MoveTo/TurnTo
  directives untouched.
- **castMove per-axis edges** — `MovementSystem::merge_manual_edge`: an edge
  overlays only the CHANGED axes; unchanged axes carry the current effective
  drive (interpreted mapping while latch low, else previous manual effective).
  Jump-standstill root now reads the RAW held keys (`jump_charge_commence`).
- **JS anim-break** (index.html W3.1 block) — a forward-axis PRESS edge
  mid-cast cuts the LOCAL cast chain (`em.cancelCastSequence`, F8-4
  busy-window-guarded, castMove-gated). Local-only — observers/server
  unaffected ("server cant detect animation break").

**Live validation (headless zero-GPU bot vs live ACE, char +Tester2):**
- Held-strafe self cast (Wedding Bliss 1708 = 3 windups): fix ON → continuous
  14.96 m @ ~1.54 m/s, ZERO dead windows; `?slideCast=off` → slide died 100 ms
  after cast start (first windup stomp), 0.05 m total. Perfect A/B.
- Fix A: held-W cast → 0 m (forward dead vs a REAL cast, not just a stance
  echo); A-tap while W held → 0.907 m PURE lateral (forward component 0.001);
  A-release with W held → still 0 m.
- Targeted war cast (Flame Bolt VI 85 at a `@create 24888` pyreal target
  drudge): held strafe slid 7.74 m through the whole cast, no dead windows
  (brief turn-to hitch at cast start only). Backstep mid-windup moved 1.175 m.
- Tests: core 432/10/1 (+2 new: `cast_move_edge_merges_per_axis_…`,
  `slide_cast_persists_held_strafe_…`; the 10 = the SAME pre-existing list),
  world 540/0, web 124/1 (pre-existing), rust_pose 13/0.

**User's retail technique → our binds** (they cast with z/c strafe, x back,
arrows turn/fwd): strafe=A/D, back=S, forward=W, turn=Q/E. Their tap-per-windup
metronome maps unchanged (each tap = edge = latch raise). NOTE: held FORWARD
mid-cast stays dead on ACE cadence by design (retail's between-windup forward
pulses came from MotionDone raw re-apply; ACE's zero-gap windup chain has no
such boundary — even retail clients on ACE live this).

**Session-ops notes (bot lore, was hard-won tonight):**
- autoSpawn needs the ADMIN PREFIX: `autoSpawn=%2BTester2` ("+Tester2").
- Ghost-wait ORDER: drop the session FIRST (about:blank), THEN wait ~100 s,
  THEN log in. Waiting before the drop does nothing.
- MCP/background-tab sessions die ~2m50s after login (Network Timeout) if you
  leave gaps between evaluate calls — background throttling starves the
  net-drain keepalive. Run each leg as ONE continuous evaluate.
- Tester2 (tailnet1) is now a parked mage kit at the LIGHT academy LB
  (A9B40024): @god'd, Wand wielded, knows 1708 + 85. The Rithwic wall char
  (Tester, autoSpawn=first) was NEVER touched — use Tester2 for mage smokes.
- `@create 24888` = pyreal target drudge, 10k hp (user-provided target wcid);
  two are parked at the academy spot.
- Wedding Bliss (1708, 3 windups) / Flame Bolt VI (85, 1 windup) = good
  multi-windup test spells; level I-VI self buffs are lead-only (NO windups).

**Pending from this session:** (a) 1070 eye-test — the strafe DANCE feel
(alternating held A/D through a war chain), the anim-break VISUAL (needs the
real spell-bar UI — headless castTargetedSpell bypasses the JS chain, so the
cut is only unit-plumbed, not end-to-end-verified), rig look during slide (cast
anim + glide vs strafe-legs — the JS sidestep overlay may fight the cast
overlay visually; if it does, suppress `setSidestepLayer` while `_castBusyUntilMs`
is live); (b) observer-side fidelity of a slidecaster (remote clients see the
gesture + position flow — the "jumping around screens" look) — untested;
(c) consider `persist_movement=true` on the live server anyway for melee-swing
strafe parity (ACE covers melee/missile via Persist, just not magic).

Three-commit arc on master: `6197dd38` (dossier A+B parity implementation), `4aeea4dc` (retail
movement-autonomy latch — the real slidecast/fastcast mechanism), and this commit (follow-ups
FU1-FU9 + F10 offset chain + F17 rustPose + default flips). Specs that drove it:
`~/from-vm/physics-parity-A-integration-20260703.md` and `-B-actions-20260703.md` (retail decomp
`~/ac-headers/acclient.c` is ground truth; every change carries inline `acclient.c:NNNNNN` cites).

## What is live (all DEFAULT-ON, each with an `=off` URL escape)

- **Ungated semantic fixes** (no flag): constraint budget ACCUMULATES (`+=`, :389506 — ACE's
  replace-semantics disabled every leash), EPSILON 0.0002, interp first-window BIG_DISTANCE +
  <0.2 near-complete arm (queue AND legacy) + step-then-drain order, sledding gate un-inverted
  (glide on steep, not flat), retail airborne micro-order (entry clamp → stop check → pos → vel),
  friction on grounded residual only, SetObjectMovement dual gate (equal server-control ACCEPTED,
  autonomous echoes never write style/substate), 15-bit action-stamp 0x4000 edge, echo-skip on the
  static player-controlled property, zero-stamina jump fold + PK stamina window, GetAdjustedMaxSpeed
  (interp cap), forward slots store REAL substate ids (wire cast gestures feed motion_allows_jump,
  :344003), last-pressed-wins per-axis input resolution (W+S no longer cancels to a freeze).
- **`?castMove`** — retail `last_move_was_autonomous` LATCH: lowered by the wire autonomous flag
  at UpdateMotion ingest (:311185-311193), raised by every input EDGE (press AND release;
  held keys never re-fire, :717102/:717429) and jump (:408146, LeaveGround re-apply :344457).
  Latch low → INTERPRETED state drives: gesture owns the single forward slot, sidestep/turn slots
  independent → slidecast; a movement tap evicts the gesture → fastcast anim-break; server only
  rate-checks. Live-verified: held-W froze 0.000 m during a stance echo; edge re-press restored.
- **`?retailLeash`** — the retail local position lattice: every-echo ConstrainTo re-arm, routine
  echoes route through the leash reconcile (replaces the authoritative-only rubberband guard),
  InterpolateTo gated on server-control (row-64 transitions wired: MoveTo/TurnTo directives set
  control, input edges TakeControl + StopInterpolating-with-leash-surviving) + contact,
  beyond-blip queue+blip, teleport = constrain+zero-vel, force = OWN-heading blip no-constrain
  (ForceBlip sync variant), persistent leash, one-frame interp heading snap, IsFullyConstrained →
  jump refusal 71, and the **F10 full offset chain**: interp-REPLACE → sticky-REPLACE (decomp
  correction: sticky replaces the origin, does NOT add — :388531-388591; dossier rows 42/51 are
  wrong on this) → constraint scale+accumulate-ONCE on the composed offset, fed the whole manual
  slice delta pre-transition (double-accumulate edge removed and pinned by test).
- **`?retailQuantum`** — retail update_object schedule (0.0002 consume-skip, direct sub-0.2 entry,
  0.2 slices + 1/30-carried remainder) in BOTH integrator shapes. A1-O5 DISCHARGED: the
  closed-loop turn regression (`move_to::quantum_turn_tests`) converges with ZERO oscillation at
  0.2 s slices — ACE's stated reason for 0.1 (its own port bug) does not reproduce here.
  CARRIER SPLIT: browser rides the flag (default-on); native `USE_RETAIL_QUANTUM` const stays
  false so tests/goldens keep the ACE baseline.
- **`?rustPose`** — rendered local pose straight from `getLocalPlayerPose()` each frame
  (`scene3d/rust_pose.js`), bypassing the residual JS smoothing (the 150 ms predictor was already
  dead code since 2026-06-29 — F17 drift report; residual was the RIG_Z 70 ms ease + a mirror).
  Legacy layers NOT deleted (deletion waits for the 1070 A/B; `tests/rust_pose.test.cjs` pins that).

## Test/validation state

- `cargo test -p holtburger-world --lib` → **540/0**. `-p holtburger-core --lib` → **430 pass /
  10 fail / 1 ignored** — the 10 are PRE-EXISTING (all `client::movement::system::tests`:
  cancel_pursuit…, handle_exit_world…, held_manual_drive…, notify_animation_done…,
  pursuit_active…, step_up_within_step_height…, stop_command_cancels…, test_movement_manager_
  registry…, test_precipice_slide…, unified_transition_spine_manual_collision_matrix).
  `-p holtburger-web --lib` → 124 pass / 1 PRE-EXISTING fail (tests_substitution::triangulate_…,
  fails on clean base too). `node tests/rust_pose.test.cjs` → 13/0. Golden fixed-dt harness in
  `system/tests.rs` (regen: `cargo test -p holtburger-core --lib golden::regen -- --ignored
  --nocapture`).
- Release wasm (4.68 MB) built + swapped into `pkg/` (gitignored — other checkouts must rebuild:
  `env PATH="$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build
  --target web --out-dir pkg --release` from apps/holtburger-web; NEVER bare wasm-pack on this box).
- Headless smokes vs live ACE (serve.py :8765, wsbridge :8080, zero-GPU bot
  `?nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&autoLogin=1&account=tailnet1&…`):
  defaults arm = in-world, @telepoi teleport through the leash arm, 41.6 m walk, 0 console
  errors; escape arm + all-on-incl-rustPose arm = in-world, streaming healthy, 0 errors (walk
  probes blocked by the Rithwic town decode wall — see gotchas).

## Pending (in priority order)

1. **1070 eye-test batch** (recipes in `apps/holtburger-web/docs/url-flags.md`, section
   "2026-07-03 — physics parity" + the ?castMove row): retailLeash feel A/B, retailQuantum hitch
   behavior, castMove mage recipe (hold-W cast / tap-per-windup / strafe dance / tap-S anim break
   / jump reset / server-pose takeover), rustPose jitter watch (if 5-10 Hz X/Y jitter appears the
   F14 reconcile fix is incomplete — `=off` and report, do NOT delete legacy layers). Pre-existing
   pending: remoteInterp composite, retailGround.
2. **F13 anim-root-motion ground locomotion** — design ready at the session scratchpad
   `F13-DESIGN.md` (content mirrored below): PosFrames per-frame root deltas (parse EXISTS —
   `holtburger-dat motion_table.rs get_anim_dist`), RootMotionCursor playback, manual-slice seam
   behind `?animLocomotion`, 2-agent split. Unlocks F7 omega + byte-identical grounded traces.
3. **Post-A/B deletion wave** (after rustPose passes): delete predictedPlayerPos/RIG_Z + update
   smoke_test.cjs static pins + root test_workstream_*.mjs harnesses + flip the rust_pose.test.cjs
   "not deleted" check.
4. **Decisions**: x87 byte-vs-retail-capture emulation (L, permanent cost — only if byte-identity
   to retail captures becomes a requirement); RETAIL_RUNRATE_EDGE stays off while on ACE.
5. **Small**: F15 remote heading/max_speed + JS deadReckon retirement (1070-gated); rows 61/62
   autonomous-position cadence ACE-isms (the observer-side fastcast-appearance dial); wire packing
   from widened slots (waits for A3 registry as wire source); F16 cached_velocity (needs a
   collision-report consumer).

## Gotchas for the next session

- **ACE ghost sessions**: closing a connected tab ghosts the account ~60-90 s → next login gets
  `[character-error] Logon (0x1)`. Schedule relogins +95 s. ACE runs on THIS laptop (dies on
  reboot — restart recipe in memory/ace-live.md).
- **The demo char (+WasmDemou8wvi3, account tailnet1) now lives in RITHWIC** — a town landblock
  whose decode pegs the main thread for many minutes under SwiftShader/nullRender, blocking
  evaluate probes after spawn. Park the char somewhere light (@telepoi to a wilderness POI) to
  speed future headless smokes.
- Build rules (8 GB laptop): single-crate `capped-build cargo test -p …` only; never --workspace;
  never bare wasm-pack; kill rust-analyzer first (`pkill -f 'rust[-]analyzer'` — note the bracket
  trick; a plain pgrep -f self-matches your own shell).
- Stray untracked `pkg-*` build dirs under apps/holtburger-web (pkg-parity/pkg-latch/pkg-fu/
  pkg-final) — rm is permission-blocked for the agent; clean manually if they bother you.
- Dossier staleness found while implementing (the dossiers are NOT self-correcting): sticky
  REPLACES the offset origin (rows 42/51); row 42's flag-off JS description predates the
  2026-06-05/06-29 predictor collapse; row 38's zero-stamina fold already existed; the MoveTo
  error routing already existed. Read the code first.
- Mechanism provenance for the mage-PvP work: Discord archive (fastcast = movement-tap anim
  break, vtank speedbuff = down-key spam, "server cant detect animation break", "slidecasting is
  something that's completely fixable that ACE refuses to") + decomp trace (per-axis
  CommandLists, forward-slot eviction, the autonomy latch write at :311190). The famous "janky
  character controller / multiple forward and backward movement inputs" quote is NOT in the
  archive — its content maps to the per-axis command stacks (multi-source head-wins).

## F13 design (mirror)

1. DAT: per-frame root deltas from Animation PosFrames (dats.xml:3651; parse exists) +
   framerate → RootMotionCurve {deltas, angular, fps}; unit-test sum(|deltas|) == get_anim_dist
   on real portal.dat fixtures.
2. Core: RootMotionCursor {curve, phase, rate} — keyframe-exact advance(dt × speed mod),
   heading-rotated, cycle-wrapped.
3. Seam: grounded direct-set site in the manual slice behind `?animLocomotion` (default OFF);
   airborne/jump/knockback stay velocity-driven (F8).
4. Stage 2: angular root motion for turn anims → unlocks F7 omega-zeroing.
5. Renderer phase slaving = stage 2; stage 1 accepts independent clip phase.
6. Split: agent A = dat+cursor; agent B = seam+flag+goldens+docs.
