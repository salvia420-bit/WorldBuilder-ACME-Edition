# Laptop re-grep verdict — 2026-06-11

ROADMAP §6 caveat resolved: the buildbox was missing
`~/out/bughunt86-combat-render-loop-items-2026-06-09.md` and `~/out/grind-loop-2026-06-11.md`,
so A2/A6/A9/A13/A14/A15 flagged that their "untracked" rows might be double-counting.
Re-grepped both docs (plus `~/out/remaining.md`, the F-item ledger the grind-loop doc
references) against every row those six reports marked untracked.

**Verdict: ALL "untracked" rows stand.** No row in any of the six reports is covered by
either doc. The hits found are adjacent-but-distinct items; the distinctions worth recording:

| report row | nearest backlog item | why it does NOT cover the row |
|---|---|---|
| A2 §3 row 7 / plan P2 (remote driver) | remaining.md **F3-2** (remote MoveTo prediction, deliberately deferred MED) | Already linked — ROADMAP §6 leverage table says "F3-2 (P2 IS the deferred remote driver)". Not double-counted; P2 is the designated re-home. |
| A6 §3 row 8 (missile collision) | **F3-1 / G-4** (projectile gravity arc, DONE 4f390cbe) | Covers flight *visuals* (ballistic arc) only — exactly as A6's own tracked? note says. In-flight collision vs walls/terrain remains untracked. |
| A6 §3 rows 2–3 (projection/remote collision coverage) | **F6-5** (server melee charge dropped), **F17-4** (open-door exclusion AABB) | F6-5 is about MoveToObject never being executed client-side; F17-4 is a specific door-adjacent collision hole. Neither tracks the structural buildings-only solver gap or remote-entity no-collision. |
| A9 §3 row 1 (placement-id rest pose) | **F13-4** (yaw-only static orientation) | F13-4 is bake-time static placement orientation; A9's row is wire/init placement-frame (0x65 Resting / frame_id) on live entities. Distinct. |
| A13 §3 row 1 (C2S TurnToEvent 0xF649 never sent) | **F7-3** (S2C TurnToObject dropped; shipped 2026-06-10) | Opposite wire direction. F7-3 fixed receiving/executing TurnTo; sending 0xF649 remains absent (and stays design-gated per ROADMAP §8 — ACE handler existence unresolved). |
| A14 §3 row 2 (charge-end stomps held WASD) | **F6-6** (charge-pursuit lockout race; shipped in bughunt-86 grind) | F6-6 is the attackInProgress lockout race; the (0,0,0) input stomp is a different bug in the same picking.js region. A14-I2 fixes the stomp — implementer must not regress the shipped F6-6 fix. |
| A14 §3 row 6 (jump-charge refusal gating) | remaining.md **F1-5** (+ follow-on note: 0.8 s combat charge variant, JumpCharging overlay) and **F1-6/G-7** (long-jump charge, DONE cf1b6edb) | F1-5 = power curve; its follow-ons = charge *animation* styling; F1-6 = standing long-jump mechanic. None implement retail's refusal codes (load→73, crouch band→72, in-air→36) + scroll text. |
| A15 §3 rows 3–4 (two unbounded-buffer leaks) | **F16-2** (container ObjectCreate rig leak at world origin; shipped) | Different leak entirely (3D rigs vs cloned EntityUpdate buffers). A15's deferredSpawns / __scene3dEntityBacklog leaks appear in no backlog doc. |

Everything else (A2 rows 4–5; A6 rows 1, 5–7; A9 row 6; A13 rows 3–4, 6–9; A14 rows 1, 3–5, 9;
A15 rows 1–2, 6–7): zero hits in all three docs, including fuzzy/paraphrase passes
(constraint, blipto/node_fail, smoothing, projection, insert/validate state machine, scale,
server_control/quartet, autonomy, keystate/funnel, autorun, backlog/clone schema, streaming).

Method note: greps run with correct ERE alternation over headings AND bodies of all three
docs; first pass used `\|` in `-E` patterns (matches nothing) and was redone.

Consequence for the ROADMAP: the W0 "start today" items (A15-Q1/Q2, A11-S0/S1, A14-I1,
A10-M1/M2) are confirmed net-new work, and the leverage table's "untracked" counts need no
downward revision.
