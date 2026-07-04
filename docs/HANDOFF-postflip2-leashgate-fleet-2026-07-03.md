# HANDOFF — post-flip session 2 work order: leash echo gate (bug-A fix) → ADJ-8 flip → fleet briefs (2026-07-03)

Session 6 of the movement-port arc. Session 5 (job 333ff13e) landed
post-flip item 3 AND root-caused the casting snapback from live captures of
the user's own 1070 session. READ FIRST, in order:

1. `docs/BUGA-snapback-capture-2026-07-03.md` — the bug-A evidence chain +
   root cause + fix directions (+ bug-C location, bug-B closure, capture
   traps). THE document this work order executes against.
2. `docs/HANDOFF-cmdinterp-postflip-animdone-2026-07-03.md` — what the
   AnimationDone route landed and why (queue enqueue + completion-clock
   shim + seam swap), its live-leg numbers, and the remaining post-flip
   menu.
3. `docs/HANDOFF-cmdinterp-step5-landed-2026-07-03.md` §"Post-flip work
   order" — arc context only; items 1-3 there are DONE or superseded.

Everything is pushed through `45938937`. Floor at HEAD: core 568/10
(failing-set md5 `693c4c01…` — the SAME pre-existing 10), world 540/0, web
125/1 pre-existing, rust_pose 13/0, wasm32 check clean; release wasm
4,703,179 B (has all diag exports).

## Session-5 state you must not re-derive

- **Bug A root cause (one counter short of formal conviction):** during
  TurnTo control windows (every vanilla-ACE targeted cast), the leash arm
  `scene.rs:2770` (`if self.local_server_controlled && has_contact →
  remote_interpolate_to`) consumes OUR OWN ~20 Hz broadcast position
  echoes arriving via `apply_entity_position_sync` →
  `reconcile_authoritative_body_with_remote` (mutations.rs:77 →
  scene.rs:2694) and drags the local runtime body to ACE's anchored,
  z-offset position (hard blip snap beyond the radius). Round-2 counters
  proved the two OTHER carriers innocent (0 hits on
  `apply_public_position_update` local arm and on forced-sequence snaps
  across 19 yanks) and cleared the post-drain auto-reclaim (1 firing all
  session). ACE's anchor comes from TurnTo directives +
  `PhysicsObj.StopCompletely` in the cast flow (`Player_Magic.cs:1361`).
- **Bug B (casting circle) CLOSED as research:** server-side only, never
  in the retail client (godmoding-era evidence + decomp: only the 0x402
  fizzle TOAST exists client-side, acclient.c:416002). Only extant
  implementation: ACE `Windup_MaxMove = 6.0` from `StartPos`
  (`Player_Magic.cs:373/:874/:1342`), **NPK-exempt** — inert for Tester2
  (no PK property on the biota; NPK default,
  `WorldObject_Properties.cs:2698`). A client-side circle
  (predict/render the radius) is a small FEATURE, not a hunt.
- **Bug C located:** `picking.js:820-900` — entity click with an armed
  spell fires `castTargetedSpell` directly (mis-modeled "arm spell, click
  target"; retail click = SELECT only) + the F8-5 turn-to-face block
  (user reports a consistent RIGHT turn — heading-sign suspect); same
  facing math serves the melee/missile click branches.
- **ADJ-8 ruling (user, verbatim): "slideCast=off feels more authentic
  however there are some catches"** — i.e. flip the default to the
  authentic burst ONCE bug A is fixed. Do not flip before.
- Diag surface shipped (all rides v6, no manifest bump):
  `movementPendingMotionsDiag` (registry queue depth),
  `localPoseSnapDiag()` → "pubSnaps,forcedSnaps,lastDeltaCm,carrier",
  `reclaimCauseDiag()` → lo16 edge / hi16 use_time reclaims — all on the
  curated `window.__hbWasm`.

## Work order (value order)

### 1. The leash echo gate — kill bug A

Retail-shaped lever, recommended in the BUGA doc as option (c): a fully
autonomous player ignores broadcast position echoes even while the control
mirror is up (`CommandInterpreter::UsePositionFromServer`, autonomy != 2,
acclient.c:717529 — the predicate is ALREADY PORTED, autonomy pinned 2 per
ADJ-6).

- **The clean seam already exists**: the reconcile callers pass
  `AuthoritativeBodySync::Snapshot` for routine Moved-class syncs and
  `::Reset` for sequence-FORCED corrections (mutations.rs:461/:481).
  First candidate shape: the scene.rs:2770 leash arm engages only for
  Reset-class/forced syncs (and real directive corrections), never for
  Snapshot-class echoes. Verify what sync class the yank-window echoes
  actually carry before coding (add a tiny counter on the leash arm
  first — `leashEchoDiag` — the "round-3 counter" the BUGA doc names;
  convict, then gate, then confirm the counter goes quiet).
- Flag-gate per house style (suggest `?leashEchoGate`, native const
  `USE_LEASH_ECHO_GATE`), land flag-on only after the 1070 confirm — the
  validation IS the user's 2-minute capture (see infrastructure below).
  Success = snapback gone during targeted casting on the hill, leash
  still works for real directives (@telepoi/MoveTo directive legs), floor
  intact.
- Watch interactions: the retailLeash budget rows, FU-C
  `stop_interpolating`, and menu item 5 (wire-side control migration)
  touch the same mirror — do NOT start item 5 in the same commit.

### 2. ADJ-8 flip (after 1 is confirmed)

`slidecast_persist`/`USE_SLIDE_CAST` default → OFF (authentic burst),
`?slideCast=on` becomes the modern opt-in. Update both url-flags rows +
the config seeding comments; quote the user's ruling verbatim in the
commit. Bar: the burst arm's floor legs (harness/postflip-legs.mjs leg 3)
stay green with the flip.

### 3. Fleet packet briefs (user-approved 16-wide on the buildbox; write briefs, USER launches)

Read `memory/fleet-runbooks.md` §buildbox BEFORE driving anything. CAP 16
(`claude -p --model claude-opus-4-8`), stdout = deliverable, synthesis
reads parts/*.md from disk, `setsid nohup` driver, SENTINEL + tgz + sha256.
House rule: agent citations are HYPOTHESES — the integrator read-verifies
every file:line before use.

Scope: 10-12 packets, decomp-first, each brief carrying the exclusion
list. **Familiar ground — DO NOT re-derive:** CommandInterpreter /
CommandList / HKC / M1 (this arc's 16-wide), CMotionInterp /
MotionTableManager / MoveToManager (wave 1), the AnimationDone route +
completion shim (session 5).

Packet list (novel ground, bug-A/C-sharpened):
1. `CPositionManager` internals — InterpolationManager node/blip/fail
   semantics (acclient.c:389140 region), StickyManager, ConstraintManager
   (leash start/max), who installs/clears what and WHEN.
2. `SmartBox::HandlePositionEvent` + the position sequence spaces
   (instance/force/teleport/server-control) — the full retail
   arbitration: which incoming position classes touch the local player
   at which autonomy levels.
3. `CommandInterpreter::UsePositionFromServer` consumers — every read
   site, the autonomy lattice, and what "forced" means to retail.
4. `CPhysicsObj::SetPosition` / ForcePosition / transition-failure snap
   semantics (the client side of "failed transition").
5. `transient_state` movement locks during casting/actions — what retail
   locks client-side during gestures (nothing? something?).
6. Retail client cast-flow map: `SpellcastingUI::Cast` → wire request →
   WHO plays the windup gestures client-side (the client-authored gesture
   chain that made godmoding possible) — settles how a retail-faithful
   client should treat ACE's TurnTo+stomp cast flow.
7. Retail targeting/selection semantics (bug C): click = select vs cast,
   the selection ring, and facing/turn conventions (heading sign,
   MoveToState turn direction) shared by melee/missile/magic.
8. TurnTo directive handling end-to-end in retail (MoveToManager TurnTo
   vs the interpreter's turn commands — who owns heading during a
   directive, and what position data a TurnTo may legally carry/apply).
9. Stance/"initial position" display family (user: character shows
   standing/peace pose wrongly) — retail's stance echo → pose pipeline.
10. `PositionManager::adjust_to_object` / stick-to during combat — how
    retail kept meleers glued without rubberbanding (context for the
    leash gate's directive-consistency arm).

Deliverable per packet: symbol-anchored citations + a "what our port does
differently" diff against the named files (scene.rs / position_manager.rs
/ move_to.rs / picking.js), NO code changes.

### 4. Bug C fix (can ride fleet packet 7, or go direct if obvious)

Click = select-only behind a flag (`?clickCast=off` default TBD by the
user — ASK before changing their play feel), and audit the F8-5 facing
math sign against packet 7's findings.

### 5. Leftover post-flip menu (unchanged priorities)

Wire-side control migration (#5 — now doubly load-bearing, interacts with
the leash gate), real authored lengths for the completion shim, camera
lane (user-confirm first), M3/M4/M7, legacy deletion after soak.

## Infrastructure (all live as of session end)

- **Capture stack** (preserved in `external/holtburger/apps/holtburger-web/harness/`,
  untracked by convention): `launch-capture.bat` (push to box
  `C:\Temp\`, launch via `schtasks /create /tn WBCAP /tr
  C:\Temp\launch-capture.bat /sc once /st 00:00 /it /f & schtasks /run
  /tn WBCAP` — visible chrome, CDP :9334, profile wb-eyetest,
  `?slideCast=off` URL), `snaptap-install.mjs` (attach + install the 8 Hz
  pose/diag tap; GATED on the fresh build being loaded),
  `snaptap-dump.mjs`, `postflip-legs.mjs` (the local zero-GPU A/B legs,
  Bug-11-gated boot + 200 s ghost waits + stance toggle before casts).
  Round-2 evidence dump: `harness/snaptap-round2-2026-07-03.json`.
- Tunnels: `ssh -fN -L 9334:127.0.0.1:9334 young@100.127.215.75` (their
  capture chrome); 9333 = the off-screen test chrome; reverse 18765 →
  laptop serve.py :8765 was already live.
- serve.py running on :8765 (`--allow-missing`); ACE alive (see
  memory/ace-live.md).

## Traps from session 5 (on top of the two prior handoffs' lists)

- **Boot gates**: scan `window.__bootStateHistory` for 'in-world' (the
  90 ms in-world→ready race, index.html:9284) — never sample
  `__bootState` alone.
- **Ghost clock anchors on ACE's LOGOUT line** (~60 s AFTER a page
  drop — the UDP session lingers), then +95 s. Driver-side: 200 s
  between legs, or grep the log.
- Headless casts REQUIRE `toggleCombatMode()` + ~1.8 s first (ACE
  stance-rejects otherwise, `Player_Magic.cs:84`); step-5's "casts
  worked" relied on prior session stance state.
- `__diag.wire.summary()` byKind counters are CUMULATIVE; windowMs is a
  red herring — diff snapshots.
- Tap installs must gate on the NEW wasm being loaded
  (`__hbWasm.localPoseSnapDiag` present), or you re-arm the stale page.
- `rg -rn` is still the --replace footgun; python/sed edits still
  invalidate the Edit tool's read tracking (re-Read before Edit).
- Diag exports: free fns need a curated `window.__hbWasm` namespace-rider
  in index.html (`__hbWasmNs` is module-scoped, NOT on window).
