# holtburger-web Movement-Protocol Retail-Parity Workflow Brief

**Generated:** 2026-06-04 from laptop pre-flight research (4 general-purpose agents over the `movement-protocol-deep-2026-06-04` deep-dive + acclient decomp + ACE server + chorizite + holtburger Rust/JS, every locus re-confirmed against HEAD `190cf184`).
**Source of truth:** `~/from-vm/movement-protocol-deep-2026-06-04/` (the deep-dive: `FIX-PLAN.md` is the primary deliverable; `DIVERGENCES.md` / `FINDINGS.md` / `RETAIL-MODEL.md` / `WIRE-EVIDENCE.md` / `OPEN-QUESTIONS.md` are the evidence). On the buildbox these live wherever `pull-from-box`/`mirror` placed them — carry this PROMPT.md with you.
**Target machine:** cloud `buildbox` (GCE us-central1-a, 18 vCPU / 96 GB) — full unrestricted `cargo`. The 8 GB laptop must NOT `cargo build/test --workspace`.
**Required model:** `claude-opus-4-7` (or current Opus). **Effort:** `/effort max`.
**Working tree:** `~/WorldBuilder-ACME-Edition/external/holtburger/` (repo root; the web app is `apps/holtburger-web/`). All paths below are repo-root-relative.
**Branch:** create `feat/movement-protocol-parity-2026-06-04` off `master`. Per-item commits. Code authored on the box comes back via **git** (commit branch on box → `git pull` on laptop), never rsync.

---

## Mission

The movement **wire format is already byte-faithful to retail** (419 cargo + 43 validator pass; the only round-trip failures are *Chorizite's* own bugs, where our Rust is the retail-correct side). **Every remaining gap is client-side behavior** — reconcile / predict / dead-reckon — not bytes. This workflow implements the **safe, self-verifying, parallelizable tier** of `FIX-PLAN.md` (Phase A below) autonomously and leaves the wide-blast wasm refactors (Phase B) for an interactive human-in-the-loop session that has 1070 eye-test access.

### Hard constraints (do NOT violate — these are adversarially-settled)

- **REFUTED — never implement:**
  - **RECON-2** "drifted pose fed back forever / standoff" — `constrain_local_pose_toward` already converges sub-blip (`scene.rs:110-164`); the `tests.rs:700` snapshot test PASSES (`new_gap < start_gap`). Do not add a "break the feedback loop" fix.
  - **ACE-VELZERO-1** "zero velocity on a force-stamp advance" — retail's force path is `BlipPlayer → SetPositionSimple` with **NO** velocity-zero (acclient.c:145242-145249). Velocity-zero is the **teleport** path only (145196-145206). Zeroing on a force advance would *diverge* from retail.
  - **PRED-3** terminal-velocity clamp — absent in retail (acclient.c, confirmed) AND ours. Adding one introduces a divergence.
- **Do NOT touch the wire:**
  - **JUMP +8 (object_guid+spell_id)** stays — ACE's `Player.HandleActionJump`/reader expects 32 B; removing it breaks ACE. (Retail JumpPack actually carries a *Position* block neither side has; fixtures are synthesized; this is documentation-only.)
  - **POS-1 velocity-before-placement** is retail-correct (acclient.c:323620 before :323631). Do NOT reorder to match ACE's `Position.cs` (placement-first is an off-wire server serializer).
- **Validator is broken off-buildbox:** `apps/holtburger-web/validate_wire_conformance.cjs` hardcodes `REPORT_DIR=/mnt/wbterminal1/...` (line 49) and spawns `dotnet` without `DOTNET_ROLL_FORWARD` (line ~1001). On the buildbox (.NET present) it's fine; elsewhere copy to /tmp + redirect REPORT_DIR + `export DOTNET_ROLL_FORWARD=Major`. Do NOT edit the committed script as part of a movement fix (separate cleanup).

---

## Source ground truth (all re-confirmed at HEAD 190cf184)

- **Retail decomp (most authoritative):** `~/ac-headers/acclient.c` (938,010 lines — grep/offset only, never full-read), `acclient.h`. **Zero drift** — all cited movement lines exact.
- **ACE server (canonical wire + reconcile):** `external/ACE/Source/` — sparse but key files present: `ACE.Server/WorldObjects/Player_Tick.cs`, `Player_Networking.cs`, `WorldObject_Networking.cs`, `Player.cs` (HandleActionJump @866), `ACE.Entity/Position.cs`, `ACE.Server/WorldObjects/SpellProjectile.cs`, `ACE.Server/Physics/Managers/MoveToManager.cs`. `GameActionJump.cs` and the `JumpPack` type are NOT checked out.
- **Chorizite oracle (portable wire codegen):** `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/` — `Types/*.generated.cs`, `protocol.xml` (0xF619 def at :8239-8243; JumpPack at :6391-6399), `ACBindings/Generated/InterpolationManager.cs`. **Chorizite has real bugs** (RawMotionState u16 fields + `(Flags>>11)&0xF8` count; InterpretedMotionState `(Flags>>7)&0x7F` count vs acclient's `&0x1F`; zero-tail trim). When porting masks, port from **acclient**, not chorizite.

---

## Build / test / validate (buildbox commands)

```sh
# per-crate cargo (crate names: holtburger-common, holtburger-protocol, holtburger-core, holtburger-world)
cargo test -p holtburger-protocol         # codec round-trips + generated_parity + opcode_parity
cargo test -p holtburger-common           # sequence helpers
cargo test -p holtburger-core             # movement system
cargo test -p holtburger-world            # reconcile / handlers / mutations
# on the buildbox the full gate is fine:
cargo test --workspace --all-targets --all-features
cargo fmt --all --check && cargo clippy --workspace --all-targets --all-features -- -D warnings   # CI gate

# wasm (ONLY needed to make a Rust change take effect in the browser — NOT needed for cargo verification):
wasm-pack build apps/holtburger-web --target web --out-dir pkg --release    # ~50-90s wasm-opt; --release only (--dev crashes Chromium)
#   then bump the cache-bust query at index.html:1086 (?v=...) or Firefox serves the stale ES module
# Node validators need the nodejs bundle: wasm-pack build apps/holtburger-web --target nodejs --out-dir pkg-nodejs --release
scripts/serve.py            # serve :8765 (validates baked layers; --allow-missing for code-only)
```

**Flag-gate convention:** crate-private compile-time `const USE_<NAME>: bool = …;` at module top, guarded by `if USE_X { }` / `if !USE_X { return; }`, toggled by editing the literal + recompiling (NOT Cargo features/env). New behavior that needs a live eye-test ships **DEFAULT-OFF** behind such a flag. Existing flags: `system.rs` has `USE_QUANTUM_SUBDIVIDED_INTEGRATION`(:41 true), `USE_AUTONOMOUS_POSITION_CHANGE_GATE`(:167 true), etc.; `scene.rs` has `USE_LOCAL_FORCE_POSITION_CONSTRAINT`(:31 true), `USE_RETAIL_INTERPOLATE`(:65 false).

---

# PHASE A — code-only workflow (autonomous; cargo-verified; no wasm rebuild; no eye-test)

Each item: implement → `cargo test -p <crate>` (+ `cargo fmt`/`clippy`) → per-item commit. These are independent except where noted; safe to pipeline. Loci below are CONFIRMED at 190cf184 (corrections from the deep-dive's stale anchors are inline).

### A1 — `is_newer_u16` 0x8000 boundary hardening (QW4 / RECON-3 / SEQ-4)  [LOW risk]
- **Locus:** `crates/holtburger-common/src/sequence.rs:6-9` and test `:39-43`.
  ```rust
  // current:
  pub fn is_newer_u16(candidate: u16, current: u16) -> bool {
      let delta = candidate.wrapping_sub(current);
      delta != 0 && delta < 0x8000
  }
  ```
- **Change:** strict retail parity at exactly delta==0x8000 (acclient.c:143002-143013 uses signed `abs(new-old) > 0x7FFF`, base-dependent at the half-range):
  ```rust
  let delta = candidate.wrapping_sub(current);
  delta != 0 && (delta < 0x8000 || (delta == 0x8000 && candidate < current))
  ```
  Update the test `u16_half_range_is_not_newer` (which currently asserts the divergent convention) to assert the retail boundary.
- **Why:** shared primitive for both accept gates (`player/mutations.rs`, `entity.rs`). Inert for monotonic counters (deltas ~1); only the pathological exactly-half-range case changes.
- **Validate:** `cargo test -p holtburger-common` + `-p holtburger-world`. Do this FIRST if any later item reuses the helper.

### A2 — command-count masks (IR2 / RAWMOTION-2 + INTERP-2)  [VERY LOW risk]
- **Loci:** `crates/holtburger-protocol/src/messages/movement/types.rs`:
  - `:467` `let command_list_length = (packed_flags >> 11) as u16;` → `((packed_flags & 0xFFFF) >> 11) as u16;` (acclient.c:333240 casts to u16 before shift → 5-bit count from bits 11-15).
  - `:248` `let num_commands = (raw_flags >> 7) as usize;` → `((raw_flags >> 7) & 0x1F) as usize;` (acclient.c:333542 `(v4>>7)&0x1F`).
  - **Mask source = acclient** (`&0x1F`), NOT chorizite (which uses `&0x7F` at InterpertedMotionState.generated.cs:28 — itself non-canonical).
- **Why:** defensive against malformed/oversized flags; behaviorally inert for all valid frames (bits 0-15 only). 
- **Validate:** `cargo test -p holtburger-protocol` (round-trip suite must stay green).

### A3 — VectorUpdate misnamed sequence field + vector_sequence gate (OQ-1)  [LOW–MED; gate DEFAULT-OFF]
- **Bug 1 (unconditional fix):** `crates/holtburger-world/src/player/mutations.rs:329-331` — `update_vector_sequence(instance_sequence)` writes `self.instance_sequence` (misnamed, wrong field). The self VectorUpdate handler `crates/holtburger-world/src/handlers/player.rs:62-69` calls it with `data.instance_sequence`. Decide intent: VectorUpdate carries `instance_sequence` + `vector_sequence` (vector.rs:14/36); retail `DoVectorUpdate` gates on the **vector** stamp (`update_times[3]`, acclient.c:143459-143480). Add a real `vector_sequence` field to player state + a correctly-named setter; keep instance handling separate. Quote/verify against `ServerAutonomousPositionData`/`VectorUpdateData` field set before renaming.
- **Bug 2 (gate, DEFAULT-OFF flag):** both `handlers/movement.rs:109-116` and `handlers/player.rs:62-69` apply `set_player_vector` / `update_entity_velocity` **unconditionally**. Add `is_newer_u16(incoming.vector_sequence, stored)` (reuse A1) before applying + advancing, mirroring acclient.c:143464-143471. **Flag-gate default-off** (`USE_VECTOR_SEQUENCE_GATE`) — OPEN-QUESTIONS OQ-1 requires a 1070 capture to confirm ACE increments `ObjectVector` per broadcast before enabling.
- **Also dedup:** VectorUpdate is handled in TWO files (player.rs self-only + movement.rs both) — note the fragmentation; consolidating is optional.
- **Validate:** `cargo test -p holtburger-world` + add a unit test for the gate (stale vector_sequence rejected).

### A4 — 0xF619 PositionAndMovementEvent codec + handler (IR4 / OPC-1)  [LOW risk; purely additive; the meatiest item]
- **What:** add the S2C combined materialize frame (lifestone/portal recall). Retail dispatches it (acclient.c:392762: `v7-63001` case 0 → `UnpackPositionEvent` (same as 0xF748) → `SetObjectMovement`). Chorizite `protocol.xml:8239-8243`: payload = **ObjectId u32 + PositionPack + MovementData**. ACE does not currently emit it → forward-compat/robustness (no ACE round-trip, no eye-test).
- **6-site template** (traced from `VectorUpdate`; **paths corrected** — opcodes live in `src/opcodes.rs`, not `game_message/opcodes.rs`):
  1. `crates/holtburger-protocol/src/opcodes.rs:59-61` — uncomment `PositionAndMovement = 0xF619` into the live `GameOpcode` enum (NOTE the file-head policy at opcodes.rs:2-3: no uncommenting an opcode without complete unit tests).
  2. `crates/holtburger-protocol/src/messages/game_message/mod.rs:64-70` — add `PositionAndMovementEvent(Box<…>)` variant.
  3. `crates/holtburger-protocol/src/messages/game_message/unpack.rs:147-164` — add the dispatch arm.
  4. Payload struct + `ProtocolUnpack`: `ObjectId via Guid::unpack` → `PositionPack::unpack` (position.rs:131) → the MovementData body. **CAUTION:** `MovementEventData::unpack` (motion.rs:22) reads its OWN leading guid; the 0xF619 "MovementData" is the guid-less movement body — factor out a guid-less reader or reuse the inner `MovementTypeData`/header path. **Validate byte layout against the oracle (`typeName=Movement_PositionAndMovementEvent`) BEFORE shipping.**
  5. `ProtocolPack` impl + the inverse arm in `game_message/pack.rs` (pack/unpack parity is asserted by tests).
  6. World handler arm in `crates/holtburger-world/src/handlers/movement.rs` applying BOTH the position pack (UpdatePosition path, movement.rs:33-39) AND the motion snapshot (UpdateMotion path, movement.rs:56-108). The `_ => false` catch-all at :117 means a missing arm silently no-ops — add the explicit arm.
- **Validate:** add a fixture-style round-trip test (synthesize bytes per protocol.xml order); `cargo test -p holtburger-protocol` + `-p holtburger-world`.

### A5 — MOVEDATA-1 (IR1): VERIFY-THEN-DECIDE  [verify first — likely DROP]
- The deep-dive said `motion.rs:86-93` routes MovementType 1-5 to InterpretedMotionState. **At 190cf184 the match (motion.rs:73-94) routes by named enum variant** — types 0-5 → `MovementTypeData::Invalid(MovementInvalid::unpack_ext(...))`, only 6-9 → MoveTo/Turn. **Read `MovementInvalid::unpack_ext`**: if it unconditionally parses an InterpretedMotionState payload for types 1-5 (RawCommand/Stop*), it over-reads frames retail treats as no-ops (acclient.c:339616 default no-op). These frames are NEVER emitted by retail/ACE/chorizite → latent-only (LOW). If `unpack_ext` is payload-safe for 1-5, **DROP this item** (already correct). If not, add a guard so only `Invalid(0)` reads the payload. Document the verdict either way.
- **Validate:** `cargo test -p holtburger-protocol`.

### A6 — doc-only corrections (QW1, JUMP-1, POS-* baseline)  [no code]
- Emit a short `docs/2026-06-04-movement-protocol-workflow/RESULTS.md` recording: (a) D1 "unconditional heartbeat" is **CHANGED** (change-gate shipped, system.rs:167); (b) JUMP +8 kept deliberately (ACE reader); (c) POS-1/SEQ-* confirmed retail-correct, no change. No source edits.

> **Phase A items NOT included** (down-ranked by FIX-PLAN): QW3 (PositionPack velocity → EntityUpdate) needs a wasm rebuild and is low-value vs ACE (ACE ships 0 velocity, REMOTE-4) → fold into Phase B with QW2. POS-6 (GetPackSize flag derivation) only matters if we originate frames server-side → defer. REMUST-5 queue → Phase B/defer.

---

# PHASE B — straight-coding with the user (wasm rebuild + live 1070 eye-test; sequenced; HITL)

Do NOT attempt these autonomously — they carry real UX-regression risk and require a 1070 eye-test (perf-worker → firefox-driver :9224, or local chromium → :8765 with `?nullRender=1`). Listed in dependency order.

### B1 — D3-SNAP: force-position SNAP of the local working pose (RECON-1 + RECON-4 + RECON-5)  [HIGH risk; the central fix; GATES B2]
- **Mechanism (corrected, simpler than the deep-dive framed):** `AuthoritativeBodySync` = `{Snapshot, Reset}` (types.rs:146; NO `Suspended` variant). In `reconcile_authoritative_body` (scene.rs:1679-1762): `Reset` → `SpatialSampleMode::Suspended` (:1690), and when NOT `preserve_local_runtime_pose` the body is **hard-set** `body.pose = pose` (:1760). The hard-snap machinery already exists — the local player just never reaches it (`set_player_position` hardcodes `Snapshot` at `state/mutations.rs:618`, and the preserve gate at scene.rs:1698-1703 keeps the working pose for any over-blip gap).
- **The fix:** thread the accepted force/teleport sequence-advance (from `player.apply_position_from_server` / `should_accept_server_position_sequences`, player/mutations.rs:226-242) through `set_player_position` (state/mutations.rs:591-628) so it selects `AuthoritativeBodySync::Reset` when **force_position_sequence OR teleport_sequence advanced**, else `Snapshot`. Mirror `entity.rs:393-403`'s `reset_required` discriminant onto the local path. **NO velocity-zero on the force path** (ACE-VELZERO-1 REFUTED — only the teleport path zeroes). Keep `PlayerTeleport` suspend (player.rs:84-92) for cross-LB.
- **Blast:** `set_player_position` signature + callers; scene reconcile local branch; the JS no-snap policy at `index.html:5933-5988` (currently only snaps on LB-high crossing — must also honor a same-LB force-position snap); lib.rs UpdatePosition arm (:28547, snap diag at :28684). `wasm rebuild` + live 1070.
- **Gate the snap on force_position_sequence ADVANCE**, not every UpdatePosition (else low-Run-skill "rubberband to spawn" returns — the 2026-05-10 academy fix). ACE-FORCE-1 CONFIRMED: ACE bumps ObjectForcePosition only on the z-hack (Player_Tick.cs:488) + PKLite (Player.cs:1148) — verify via a 1070 capture before shipping.
- **Reuse A1's hardened `is_newer_u16`.**

### B2 — D1-POLL: continuous-poll + window-split send gate (SEND-3)  [MED; MUST land AFTER B1]
- `system.rs:2465-2535` (heartbeat) + `:2418-2456` (`autonomous_pose_changed`). Poll the change test every movement tick (not only the 1s boundary at :2480); split into retail's two branches (acclient.c:718121-718132): past-window → cell|origin|heading(Frame); in-window → cell|contact-plane. Keep epsilons (0.05 m / 0.0035 rad). Gate behind the existing `USE_AUTONOMOUS_POSITION_CHANGE_GATE`-style flag; A/B it. **Ordering constraint:** continuous-poll re-asserts a drifted pose more often → land B1 (so the pose converges) first.

### B3 — D6: single-predictor collapse / skill-derived JS speed (PRED-1)  [HIGH; do not co-test with B1]
- **Fallback (no wasm rebuild):** replace the hardcoded `FALLBACK_RUN_RATE_SCALAR` (4.5) at `index.html:10072` with the live `playerRunRate()` export (imported at index.html:1024; free export at lib.rs:25931). Magnitude gap is ~1.8× (run_rate ~1.9 vs 4.5), not 4.5×.
- **Preferred (wasm rebuild):** stop integrating `localEntry.sprite.x/.y` in the JS rAF predictor (index.html:10027-10097) and render the local sprite off the wasm-owned `local_player_runtime_pose` (already integrates at skill-derived rate via `advance_local_pose_for_manual_drive`, system.rs:1012). Switch the render source atomically — the no-snap rubberband fix (index.html:5933-5988) was built around JS owning the sprite.

### B4 — D8: quantum subdivision — VERIFY then extend (PRED-2)  [LOW at steady state; flag default-OFF]
- **Partially DONE:** `USE_QUANTUM_SUBDIVIDED_INTEGRATION` (system.rs:41, default TRUE) already wraps the wasm manual-drive integrator (`advance_local_pose_for_manual_drive` :1012 → `quantum_slices(total)` + `physics_time_accumulator`). **VERIFY `quantum_slices` implements retail's 0.2 s MAX_QUANTUM_97 / 2.0 s HugeQuantum skip / 1/30 s MIN remainder** (acclient.c:323120-323154; consts :784235=0.2, :784229=1/30 — slice is 0.2 s NOT 0.1 s).
- **Residual gap:** the physics-solver path (`solve_self_player_local_drive` → `advance_body_kinematics` physics.rs:1841, used for airborne/grounded direct drive) is a single flat Euler step, and `runtime.rs:172-174` dt has only `.max(0.0)` (no upper clamp / HugeQuantum skip) before it reaches the solver. Apply the same quantum loop there if the verification shows it's exposed. Optionally mirror in the JS predictor (index.html:10032 dt cap is 0.1 — should be 0.2 slice / 2.0 skip).

### B5 — QW2: VectorUpdate velocity → 3D remote tick (REMOTE-3 + REMOTE-1)  [MED value; JS-only, no wasm rebuild; biggest perceived-stutter win]
- `scene3d/entities.js`: `setVelocity` stashes `inst.lastVel` (:5017-5026) but `tick()` (:6929-6936) never reads it (dead store). After the `_serverTargetPos` critical-damp, when `lastVel` is fresh (mirror the 2D path's `ENTITY_VELOCITY_STALE_MS=500`, index.html:6196/6219-6225), advance the target by `lastVel*dt`; snap-correct on each KIND_POSITION; clamp the horizon. **Do NOT merely flip `?deadReckon` on** — the existing block is lerp-to-stale-pose, not velocity integration; retail's parity behavior is `set_velocity`-driven (acclient.c:143476). Tune `DEAD_RECKON_TELEPORT_SNAP_M=8.0`(entities.js:157) / `DEAD_RECKON_DAMP_K=12.0`(:147) against live capture. **Projectiles (OQ-2) are the live exerciser** — ACE SpellProjectile.cs:237-238 ships motion via VectorUpdate only; without B5 a bolt sits at spawn.
- **Pairs with QW3 (REMOTE-2, wasm rebuild):** lib.rs sets vx/vy/vz=0 at 3 arms (`:28750` UpdatePosition, `:28885` PrivateUpdatePosition, `:28935` PublicUpdatePosition) — copy `pos.velocity.unwrap_or_default()`. Low value vs ACE (REMOTE-4: ACE writes literal 0f, never sets HasVelocity) → defensive/replay only; prefer the VectorUpdate path.

### B6 — IR3: position_sequence newer-gate (SEQ-5)  [MED; flag DEFAULT-OFF]
- `player/mutations.rs:226-242` + `:192-220` (unconditional position_sequence overwrite at :201) and `entity.rs:344-363` / `:365-404`. Add `is_newer_u16(incoming.position_sequence, stored)` per retail acclient.c:145167 — but follow the decomp boolean (remote entities always reach the position gate; local player takes Blip/heading-only only when BOTH force AND teleport newer). **Flag-gate default-off** until a 1070 capture confirms ACE advances position_sequence on every broadcast.

### B7 — D4: remote interpolation queue (REMOTE-5)  [DEFER — over-engineering at ACE cadence]
- Bounded (≤20) per-entity target queue keyed by position sequence (entities.js). Defer unless the B5 eye-test shows queue artifacts.

---

## Workflow shape (Phase A)

Pipeline the 6 Phase-A items: per item → implement → `cargo test -p <crate>` (+ fmt/clippy) → commit on `feat/movement-protocol-parity-2026-06-04`. A1 first (shared helper), A4 is the largest (oracle-validate byte layout before committing), A5 is verify-then-decide, A6 is doc-only. Run `cargo test --workspace` once at the end on the buildbox as the final gate. Emit a `RESULTS.md` mapping each item → commit SHA + verdict + the deep-dive finding it closes.

## Open questions carried into Phase B (need a 1070 capture / ACE round-trip — see OPEN-QUESTIONS.md)
- OQ-1 ACE increments `ObjectVector` per broadcast? (gates A3's gate flag)
- OQ-9 ACE advances `position_sequence` per broadcast? (gates B6)
- OQ-5/OQ-6 z-hack ForcePosition reproduction (gates B1's snap-gate confidence)
- CALIBRATION MAGNITUDE: real retail run-speed (run ~1.9 vs ~7.6) — timed-traverse capture (gates B3 magnitude)
