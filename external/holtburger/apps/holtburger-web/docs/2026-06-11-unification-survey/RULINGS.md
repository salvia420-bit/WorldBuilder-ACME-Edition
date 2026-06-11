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

4. **§7.7 local-player sticky** — RULED (user, authoritative): retail melee sticky DOES
   lock the local player to its attack target (player or creature). Our local-player
   exclusion (loop.js:1855) is therefore a real divergence, not a deliberate
   modernization. A2-P3's design must include the local player; the ACE-side
   single-citation gap is resolved by user testimony.

All §7 human rulings are now closed.
