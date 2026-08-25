# Bug A — the casting snapback: live-capture evidence + root cause (2026-07-03)

Two instrumented captures from the USER'S OWN 1070 session (visible chrome,
CDP :9334, passive 8 Hz pose tap + wire-kind counters + wasm diag exports),
targeted Flame Bolt VI at a training drudge, strafing on a hillside.
Driver/analysis: `~/.claude/jobs/333ff13e/tmp/snaptap-*.mjs`, dumps
`snaptap-dump.json` (round 2) + `postflip-legs.leg3good.json` era files.

## Round-1 facts (pre-diag build)

- 14 standstill yanks of 3.7-6.9 m, clustered 1.7-5.7 s after cast start,
  ping-ponging TOWARD and AWAY from the cast origin (both directions —
  two position streams alternating ownership).
- EVERY yank carries a −0.5..−1.1 m z-dip (server-z vs client-z mismatch —
  amplified on slopes; user reproduced on a hill).
- 42 control flips in ~4 min (`__cmdInterpReclaims` 2→44) — targeted
  casting engages ACE's TurnTo machinery (plus `CheckTurn` →
  `PhysicsObj.StopCompletely(false)`, Player_Magic.cs:1361 — the server
  anchors at the turn/cast point).
- `[Use failed] YoureTooBusy` chat spam + USE_FAILED events precede yanks
  (re-cast attempts bouncing off the busy MagicState — churn, not cause).
- Casting-circle fizzle EXONERATED: no PK property on the biota → ACE
  defaults NPK (`WorldObject_Properties.cs:2698`) and both Windup_MaxMove
  checks are NPK-exempt (`Player_Magic.cs:874/:1342`) — the circle cannot
  fire on this server for this char.

## Round-2 verdict (carrier counters live, fresh wasm 4,703,179 B)

19 big jumps (≥2.5 m) in the session, and:

- `localPoseSnapDiag` carrier 1 (`apply_public_position_update` local arm,
  the suspected unconditional wire apply): **0 hits**.
- Carrier 2 (forced teleport/force_position sequence snaps): **0 hits**.
- Reclaims: 33 edge (user taps), **1 use_time auto-reclaim** — the
  post-flip auto-reclaim is NOT driving the ping-pong.

**Both wire-position carriers innocent → the yank is generated inside our
own client.**

## Root cause (located, one counter short of convicted)

`WorldState::apply_entity_position_sync` (mutations.rs:448+) processes
server position packs for ANY guid — including OUR OWN broadcast echoes —
and routes them through `reconcile_authoritative_body_with_remote`
(mutations.rs:77) into
`Scene::reconcile_authoritative_body_with_remote` (scene.rs:2694). For the
local player that function is normally ledger-only, BUT
(scene.rs:2770-2787):

```rust
if self.local_server_controlled && has_contact {
    body.position_manager.remote_interpolate_to(body.pose, pose, true, blip);
}
```

**While the control mirror is up — exactly the TurnTo windows that
targeted casting opens — our leash starts consuming our own position
echoes and drags the RUNTIME body toward ACE's anchored, hill-z-offset
position.** Beyond-blip gaps queue with `node_fail_counter = 4` and the
next drain BLIPS (hard snap, acclient.c:389140-389172 port) — the 4-7 m
yanks. A tap then reclaims control (`stop_interpolating` leash drop), the
client drive re-owns the pose, and the next TurnTo window snaps it back:
the observed ping-pong, entirely consistent with zero hits on both wire
carriers (this lane never passes through `set_player_position`).

Why casts feel special: vanilla ACE sends TurnTo directives + repeated
`StopCompletely` anchoring during targeted casts (retail servers did
neither — the caster's gestures AND facing were client-authored, which is
also why godmoding was possible until the server-side circle). ACE's
anchor + our leash-during-control = the snapback.

## Fix directions (next session; study before landing)

(a) Don't raise `local_server_controlled` on cast-flow TurnTo — fragile,
    the wire shape is indistinguishable from real directives.
(b) Leash consumes only directive-consistent positions during control.
(c) **Retail-shaped (recommended): apply `CommandInterpreter::
    UsePositionFromServer` (autonomy != 2 — acclient.c:717529, already
    ported) at the reconcile leash arm** — a fully-autonomous player
    ignores broadcast position echoes even while the mirror is up, unless
    teleport/force sequences advance. Study SmartBox::HandlePositionEvent
    + CPositionManager semantics in the decomp first (the fleet packet).
    Confirm with a round-3 counter on the leash arm before/after.

## Bug C (located, for the same fleet run)

`picking.js:820-900`: entity click with an armed spell in magic stance
fires `castTargetedSpell` directly (mis-modeled as "retail's arm spell,
click target" — retail click was SELECT-only) and the F8-5
turn-to-face-before-cast block below it turns the caster (user reports
consistently RIGHT — heading-math sign suspect); the same facing math
serves the melee/missile click branches. One targeting-family review.

## Capture traps (bot-lore, do not re-hit)

- The user's chrome had NO CDP; relaunch via `C:\Temp\launch-capture.bat`
  (schtasks /it) — visible, `--remote-debugging-port=9334`, profile
  `wb-eyetest`; tunnel `ssh -fN -L 9334:127.0.0.1:9334 <user>@...`.
- Gate tap installs on the NEW build being loaded
  (`window.__hbWasm.localPoseSnapDiag` present), not just page presence —
  an F5 that hasn't happened yet leaves the old tap answering.
- `__diag.wire.summary()` byKind counters are CUMULATIVE (windowMs is a
  red herring); diff snapshots.
