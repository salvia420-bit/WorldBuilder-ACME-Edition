# Human rulings on ROADMAP §7 / §9 open items — 2026-06-11

Recorded from the user session following the laptop re-grep (see LAPTOP-REGREP.md).

1. **§7.1 camera (A6-T4 vs A12)** — RULED: keep the modern controller with collision
   sweeps (A12 row 10 EXTRA-keep); **A6-T4 stays parked / do-not-do**. Note: the user's
   phrasing referenced camera perspective height — clarified that the contradiction is
   about collision handling, not height; both options are the same chase camera. If a
   camera-height/angle tuning request emerges later, it is a separate item, not A6-T4.
2. **A15 "is 2D still used?"** — RULED: **2D stays supported.** Consequences:
   - A15-Q4 quarantine-plus-shared-core is confirmed (deletion permanently off the table).
   - A15-Q1 (2D-session `__scene3dEntityBacklog` unbounded clone leak) upgrades to a real
     user-facing leak — keep it in W0.
   - A15 §3 row 5 (2D silently drops EntityUpdate kinds 6–9: re-skins, wielded attach,
     one-shot motions, TurnTo) is now a known feature gap of a supported mode; document it
     in the quarantine policy rather than treating 2D as abandonware.
3. **§7.5 / A1-O5 MAX_QUANTUM 0.1 (ACE) vs 0.2 (retail)** — RECOMMENDED (pending final
   sign-off inside A1-O5): keep **0.1** — client prediction should substep at the same
   granularity as the live ACE server it syncs against; retail's 0.2 matters only for a
   dead client. A1-O5's deliverable is to collapse the three scattered doc sites into this
   one decision record.
   *(2026-06-12 update: FINALIZED — the A1-O5 decision record landed as
   `DECISIONS-A1-O5-constants.md` (S16, this dir); decision (a) is the final sign-off.)*

4. **§7.7 local-player sticky** — RULED (user, authoritative): retail melee sticky DOES
   lock the local player to its attack target (player or creature). Our local-player
   exclusion (loop.js:1855) is therefore a real divergence, not a deliberate
   modernization. A2-P3's design must include the local player; the ACE-side
   single-citation gap is resolved by user testimony.
   *(2026-06-12 update: code-CONFIRMED on the live server source — ACE self-sticky on
   melee swing at `Player_Melee.cs:419-427`, the `sendSelf` StickToObject broadcast at
   `WorldObject_Networking.cs:1418-1431`, and the MovementInvalid swing-echo path at
   `MovementInvalid.cs:44-46`. The user-testimony gap is closed; A2-P3 shipped as W3/S9
   commit 08ad6563 (`USE_STICKY_MANAGER`, default-off). NOTE for future server cites:
   `external/ACE` is a sparse checkout (`blob:none`, no Network tree) — server citations
   must use `~/ace-server` (same commit a8ff29f).)*

5. **A13-W4 TurnToEvent 0xF649 send gate** — CLOSED: **NO-GO for sending.** Structural
   proof against the live server source (`~/ace-server`, commit a8ff29f): ACE's inbound
   [GameAction] dispatch table is reflection-built (`InboundMessageManager.cs:66-87`) and
   registers 149 handlers — **no handler exists for TurnToEvent 0xF649**;
   `GameActionType.cs:157` carries the enum value as dead weight only. Sending 0xF649
   would be silently dropped server-side. Heading instead flows via the already-shipped
   lanes: `MoveToState` 0xF61C + `AutonomousPosition` 0xF753. Consequence applied in
   W3/S6 (9568fc0a): `move_to.rs` MoveToManager keeps the TurnToEvent emit as a
   comment-only hook, no send. (Spec: `w3plus-specs/S15-a13-w4-turntoevent-design-gate.md`.)

All §7 human rulings are now closed; A13-W4 (item 5) is closed NO-GO per the S15
structural proof.
