# W3+ Spec Index — ~/out/w3plus-specs-2026-06-11/

Written 2026-06-12. Read-only summary of the 16 specs S1..S16; no code was changed.

## Header: two read-HEAD vintages

- **2026-06-11 vintage (HEAD 61bea82f)** — S2, S3, S4, S5, S6, S7, S8, S11, S12, S13, S14, S16. Written while the W2 wave was still landing (A4-Q1 / 3172c03e landed mid-read for several of them).
- **2026-06-12 vintage (HEAD 048573d0, W2 fully landed)** — S1, S9, S10, S15 (the four re-specced this morning).

**Line-number rot warning:** every `file:line` cite in the 2026-06-11 specs predates the W2 wave landing — **8 commits, 3172c03e..048573d0** — touching movement/system.rs, interp_state.rs, position_manager.rs, lib.rs, entities.js, etc. Symbol-level claims are expected to hold (every 06-11 spec anchors cites to function/const names); **bare line numbers are rotted and must be re-resolved by symbol grep before implementation.** The 06-12 specs (S1/S9/S10/S15) are cite-fresh at 048573d0.

Manifest baseline at 048573d0: `WASM_EXPORT_MANIFEST_VERSION = 3` (index.html EXPECTED stays 1 by convention). See STALENESS for specs still citing "2 → 3".

---

## Per-spec table

Ready-for-wave is given **as of HEAD 048573d0** (W2 landed); where this upgrades the spec's own stated status, see STALENESS.

| ID | Item | Flag(s) | Ready? | wasm rebuild? | Manifest bump? | Open Qs | Gist |
|----|------|---------|--------|---------------|----------------|---------|------|
| S1 | A1-O3 sync physics tick | `?syncPhysicsTick=on` | READY | no (JS-only) | no | 5 | Same-frame physics via JS microtask hop in 3D driver + 2D watchdog; Rust sync-export path explicitly rejected. |
| S2 | A1-O4 single frame driver | `?singleDriver=on` (needs `?renderer=3d`) | BLOCKED-ON-A15-Q4 + A8-M3 (transitively A15-Q3) | no | no | 5 | Extract 2D `drainEvents` pump to `pumpNetFrame`, run as tickPerFrame phase #0; 2D watchdog self-heals. |
| S3 | A15-Q4 renderer-neutral core | `?unifiedDispatch=on` | BLOCKED-ON-A15-Q3 | no | no | 6 | Extract world-streaming → `world_stream.js` + entity-kind dispatch → `entity_dispatch.js` with per-renderer backends; 2D frozen at kinds 0-5 per RULINGS #2. |
| S4 | A8-M3 kind-17 visibility re-home | `?unifiedEntityDispatch=on` | BLOCKED-ON-A15-Q3 (READY-AFTER, no textual collision) | no | no | 4 | Move kind-17 visibility handler from 2D drain arm into scene3d-owned `client_event_dispatch.js` hook. |
| S5 | A4-Q2 + A5-P1 AnimationDone + hook-drain | `?hookDrain=on`, `?mtQueue=on` | READY (A4-Q1 landed) | yes (Stage C; A/B/D JS-live) | yes (next = 3→4, R4-coordinated) | 6 | `notifyAnimationDone(guid,success)` wasm export → SessionCommand → motion_table_manager.animation_done; JS hook-fire-queue + LoopOnce finish-drain. One change-set across entities.js. |
| S6 | A3-D3 unpack_movement Stage-3 | `USE_UNPACK_MOVEMENT_SEMANTICS`, `USE_LEAVE_GROUND_VELOCITY` (+ url-flag rows) | READY (was BLOCKED-ON-A3-D2/A7-R1/R2/R3, all landed; D3-0 = verify-or-implement vs landed shape) | yes | no | 6 | Retail DoMotion lattice + MovementManager facade + `move_to.rs` skeleton + leave-ground velocity clamp; consumes A7 helpers. |
| S7 | A6-T1+T2 transition pipeline | `?unifiedTransition=on` + `USE_UNIFIED_TRANSITION` | READY (was BLOCKED-ON-A7-R1/R2/R3, landed); serialize after S6 in system.rs | yes | no | 7 | Pure `spatial/transition.rs` (TransitionEnv trait) consumed by both manual-drive path (T1) and canonical spine (T2); kills P2b walk-through-everything hole. |
| S8 | A2-P2 remote-pose driver (F3-2 re-home) | `?remoteInterp=on` (composite: needs `?unifiedTick` + `?wireStatePacks=stage1`) | READY (was BLOCKED-ON-A2-P1, landed e871fca8) | yes (R4) | yes (3→4, after A9-Stage1 — landed, so P2 takes 4 / rides R4 bump) | 9 | Retail remote MoveOrTeleport lattice → per-entity InterpolateTo/ConstrainTo in position_manager; per-frame sparse remote-pose export; JS ease re-home. |
| S9 | A2-P3 sticky incl. local player | `USE_STICKY_MANAGER` (Rust), `?stickyRetail=on` (JS) | BLOCKED-ON-A3-D3 (S6); stage R2 additionally BLOCKED-ON-A2-P2 (S8) | yes (R1/L1/L3; J1 JS-live) | no (diagnostic export, F18-2 exempt) | 6 | Retail StickyManager for local + remote, staged (R1)→(L1+L3)→(J1)→(R2); fixes loop.js:1887 local-guid sticky exclusion per RULINGS item 4. |
| S10 | A14-I2 pursuit / turn-to intents | `?wasmPursuit=on` | BLOCKED-ON-A3-D3 (`move_to.rs` must exist — "blocked, stop and report" if absent) | yes (Stages A+B one rebuild; C JS-after) | yes (3→4) | 6 | Route charge/turn-to through wasm MoveToManager; fixes charge-end stomp of held WASD; must not regress F6-5/F6-6. |
| S11 | A14-I4 jump charge clock + send boundary | `?jumpParity=on` | READY (soft-deps A4-Q1+A3-D1 landed; was DESIGN-GATE per ROADMAP §9, spec demotes to mechanical); serialize system.rs after S10/S7 | yes (R4) | yes (spec says 2→3; reality next = 3→4, R4-coordinated) | 8 | Move jump charge clock JS→Rust (`jump_charge.rs`), single Jump pack builder in common.rs (A13 builder), restore retail refusal text. |
| S12 | A11-S3 particle/script clock | `?particleClock=off\|loop\|sim` | BLOCKED-ON-A1-O4 (S2) — hard, `=sim` needs exactly one driver | no (JS-only) | no | 5 | One retail-parity clock for entity + static particle/script managers; kills statics' private rAF; phase inserted in loop.js CRITICAL tail. |
| S13 | A5-P3 root-motion metadata | `?rootMotionObject=1` | READY (P3-W + P3-J; P3-L explicitly deferred → needs A2-P2 + Stage-1 eye-test) | P3-W yes (R4); P3-J no | yes (rides single R4 batch bump) | 6 | Export end-of-bake root-motion accumulators from wasm; JS applies to anchor on `finished` only when no fresh KIND_POSITION and walkable gate allows. |
| S14 | A10-M3 surface parity v2 | `?surfaceParityV2` (inert without `?surfaceUnified=on`) | READY (M3b JS-live first; M3a wasm R4) | M3a yes; M3b no | no (graceful `undefined`→0.5 fallback) | 6 | `hasPalette` getter; ClipMap alphaTest 100/255 vs 200/255; additive fog exemption; true InvAlpha blend arm. |
| S15 | A13-W4 TurnToEvent design gate | none | DESIGN-GATE — **RESOLVED: NO-GO** (closed) | no | no | 4 | ACE has no 0xF649 handler; close W4 wire-parity-blocked; S9/S10/A3-Stage-3 re-point at *internal* turn-to event. |
| S16 | A1-O5 constants decision record | none now (`?physics30hz` deferred to W6 code-half) | DECISION-RECORD — READY (docs + comment pointers, zero behavior) | no | no | 5 | Records 4 quantum-law decisions (MAX_QUANTUM=0.1 ACE-pin FINAL; JS dt-clamp KEEP; MIN_QUANTUM/30Hz sub-decisions; HitGround omission deliberate w/ 2 carve-outs). Finalizes RULINGS item 3. |

**Unspecced blocker:** **A15-Q3** (dead-arm retirement in loop.js) is the root of the loop.js chain (S4→S3→S2→S12) but has **no spec in this set** — it must be specced/executed first or the entire JS-seam lane stays blocked.

---

## DISPATCH ORDER

### Dependency lattice (from the specs' own sequencing)

```
loop.js / index.html chain (ROADMAP §3, strict):
  A15-Q3 (UNSPECCED) → A8-M3 (S4) → A15-Q4 (S3) → A1-O4 (S2) → A11-S3 (S12)

movement system.rs chain (ROADMAP §3 row):
  A3-D3 (S6, D3-0..D3-4) → A6-T1/T2 (S7) → A14-I2 (S10) → A14-I4 (S11)
  (S6 D3-5 system.rs slice serializes against S7; S10 hard-needs S6's move_to.rs)

A2/sticky chain:
  A3-D3 (S6) → A2-P3 stages R1/L1/L3/J1 (S9); A2-P2 (S8) → A2-P3 stage R2 (S9)

design gates feeding others:
  S15 (resolved NO-GO) → S9/S10 turn-to handled INTERNALLY, no 0xF649 codec; closes A13-W4
  S16 → decision (b) reopen trigger fires when S1 (A1-O3) lands; record first

independent: S1, S5, S13, S14
```

### File-conflict serialization (must be respected inside any wave)

- **scene3d/loop.js**: A15-Q3 → S4 → S3 → S2 → S12 (each restructures the dispatch the next edits). S1 and S8(P2.d.5) also touch loop.js lightly — rebase after whichever chain member is in flight.
- **movement/system.rs**: S6 → S7 → S10 → S11 (plus S9 L1/L3 touches :1172/:2983 — land after S6).
- **wasm lib.rs (hottest file, ROADMAP §3:138)**: additive edits from S5(Stage C), S8(P2.c), S10(Stage B), S11(I4-c), S13(P3-W), S14(M3a), S9(L1/L3/R2) — serialize commits, **ONE coordinated R4 manifest bump 3→4** carried by the batch owner (S13 Q6 / S8 / S5 / S11 all want it; do not bump per-item).
- **entities.js**: S5 (hook drain, one change-set) → S13 P3-J → S8 P2.d → S9 R2 — serialize.
- **index.html**: S2/S3/S4 chain order; S1 Stage B/C and S11 I4-d rebase around it.
- **Flag-name seam (S3 Q1)**: S3 prescribes `?unifiedDispatch`, S4 prescribes `?unifiedEntityDispatch` — needs orchestrator ruling before S4 lands (S3 recommends M3 rides `?unifiedDispatch`).

### Proposed waves

**W3 — everything unblocked now (three parallel lanes + records):**
- **Lane R (Rust movement, serialized in system.rs):** S6 (A3-D3, D3-0 verify-or-implement first) → S7 (A6-T1/T2).
- **Lane X (wasm exports / Batch R4, serialized in lib.rs, ONE manifest bump 3→4):** S5 (A4-Q2+A5-P1) → S13 P3-W → S14 M3a → S8 (A2-P2). Single batched wasm rebuild at end of wave.
- **Lane J (JS-live, no conflicts with above):** S1 (A1-O3), S14 M3b, S13 P3-J (after P3-W getter shape is fixed in-spec, JS typeof-guards anyway).
- **Records:** S16 decision record (also closes RULINGS item 3); S15 closure paperwork (tombstone comment in opcodes.rs + mark A13-W4 closed).
- **Prep:** spec + execute **A15-Q3** (the unspecced loop.js blocker) so W4's JS seam can open.

**W4 — opened by W3:**
- **JS seam (serialized in loop.js/index.html):** S4 (A8-M3) → S3 (A15-Q4) → S2 (A1-O4).
- **Movement consumers of S6 (serialized in system.rs):** S10 (A14-I2) → S11 (A14-I4); S9 stages R1 → L1+L3 → J1 (sticky core + local player).
- Second batched wasm rebuild for S10/S11/S9 if not folded into the R4 rebuild.

**W5 — tail:**
- S12 (A11-S3) after S2 lands.
- S9 stage R2 (remote sticky parity) after S8 has landed and rebuilt.

**W6 (pre-existing, unchanged):** 1070-gated flag-flips / eye-test batch; S16's `?physics30hz` code-half; default-flips per the passed-flag→always-on rule.

---

## STALENESS — W2 in-flight assumptions now landed facts

W2 (8 commits 3172c03e..048573d0) landed: A4-Q1, A3-D1, A3-D2(a), A2-P1 (e871fca8), A7-R1/R2/R3/R6, A9-Stage1 (plus A14-I1 56bc7bd7, A13-W3 6ce48bc9 from the same window per S10/S11).

Per-spec status changes and checks (each 06-11 spec's own W2-assumption section was reviewed; **no spec is structurally invalidated** — every one pre-verified that W2 wouldn't touch its files beyond line drift):

- **S5**: assumed A4-Q1 "on disk, uncommitted" — now landed; Rust half unblocked as fact. Manifest "2→3" is stale (already 3); next bump is 3→4.
- **S6**: stated BLOCKED-ON A3-D2 + A7-R1/R2/R3 — **all landed → upgrade to READY**, but D3-0 is a mandatory verify-or-implement audit against what D2 actually shipped (spec was written to absorb any answer).
- **S7**: stated BLOCKED-ON A7-R1/R2/R3 — **landed → READY**; must confirm R2's `step_down_resolve` landed as the single backend (hard structural assumption).
- **S8**: stated BLOCKED-ON A2-P1 — **landed (e871fca8, confirmed by S9's 06-12 read) → READY**; every `position_manager.*` symbol must be re-anchored to P1's landed shape. A9-Stage1 manifest-coordination question resolved: baseline is 3, P2 rides the R4 bump to 4.
- **S11**: soft-dep A4-Q1+A3-D1 landed → the Q1-slip fallback (§3 I4-b step 3) is dead code, implement the queue-HEAD path directly. Manifest "2→3" stale → 3→4.
- **S16**: decision (d) carve-out 1 must be reworded — RemoveLinkAnimations owner now "exists, default-off" (`USE_MOTION_TABLE_QUEUE`), not "unowned". Implementer must re-pin read-HEAD in the record header.
- **S13**: A4-Q1 landed mid-read (noted in spec); no dependency for the metadata getter; lib.rs/entities.js line cites rotted.
- **S14**: M3a's "rebase behind W2 lib.rs lands" is now simply "rebase onto 048573d0".
- **S2/S3/S4/S12**: verified W2 touched no JS frame-driver/dispatch files — assumption held; they remain blocked only on the **unlanded** A15-Q3 chain, not on W2.
- **S1/S9/S10/S15** (06-12 vintage): already written against 048573d0; cite-fresh, treat W2 facts as current state.

---

## KEY VERDICTS

- **S15 / A13-W4: NO-GO — ACE handler for 0xF649 ABSENT.** ACE (~/ace-server @ a8ff29f, full tree) has `GameActionType.TurnTo = 0xF649` as a dead enum entry with zero `[GameAction]` handler; InboundMessageManager.cs:126-149 reflection-dispatch drops it with `log.Warn`. Heading already flows server-ward via **MoveToState 0xF61C** (GameActionMoveToState → SetRequestedLocation, full Position incl. heading) and **AutonomousPosition 0xF753** (~1 Hz). Close A13-W4 wire-parity-blocked per its own pre-declared contingency; S9/S10/A3-Stage-3 re-point turn-to at an internal event/queue. Reopen only if upstream ACE adds the handler.
- **S15 bonus / RULINGS item 4 CONFIRMED with ACE cites:** Player_Melee.cs:419-427 sets `MotionFlags.StickToObject` + TargetGuid, runs server-side `stick_to_object` under FastTick, **and** EnqueueBroadcastMotion sends to self (sendSelf=true; MovementInvalid.cs:26-27/:44-46 serializes the sticky guid; StickyManager.cs:71-133 = 0.3f radius / 1.0s / 5× pull). Our loop.js:1887 local-player sticky exclusion is a genuine divergence on both retail and ACE axes — S9 must include the local player.
- **S15 infrastructure finding:** `external/ACE` is a **sparse checkout missing the Network/GameAction tree** — all future server-side cites must use **~/ace-server** (the live server, authoritative).
- **S1 / A1-O3:** verdict — do **NOT** implement as a Rust `tickPhysicsSync(dtMs)` export; JS microtask design wins (zero Rust change, graceful degradation).
- **S16 / A1-O5:** MAX_QUANTUM = 0.1 **ACE-pin FINAL** (retail 0.2 rejected — client must substep at the live server's granularity); JS dt-clamp KEEP as deliberate extra (reopen mandatory when S1 lands); browser 30 Hz gate = KNOWN-DIVERGENCE deferred to `?physics30hz` (W6); HitGround omission deliberate with two carve-outs (RemoveLinkAnimations → A4/A5 completion layer; LeaveGround velocity clamp → S6's `USE_LEAVE_GROUND_VELOCITY`). This record IS the final sign-off for RULINGS item 3.
- **S5 parity finding:** A4-Q1's queue semantics are already at retail parity in-tree (FIFO/num_anims/truncation pinned vs acclient.c:329842-330260) — S5 adds **no** queue-semantics work; num_anims=1-per-realized-motion convention resolves A4 §6's provenance question.
- **S12 already-parity finding:** particles→scripts manager order and CRITICAL-block placement already match retail; only the three-clocks divergence remains.
- **S8 GO ruling:** A2-P2 is the cited, non-speculative remote driver that F3-2's deliberate deferral was waiting for (DESIGN.md:539-541).
- **S7 ruling honored:** A6-T4 (camera transition) PARKED per RULINGS §1 — do not do.
