# Aggressive anim code session — log (2026-06-05)

Follow-on to `RECON.md` / `ATTACK-LIST.md`. Code-only (no 1070 eye-test available).
Workflow phases: Phase-1 probe+specs → main-loop implementation → Phase-3 adversarial review.

## SHIPPED this session (working tree, uncommitted)

### DIM5-2 — root-motion ORIENTATION channel — IMPLEMENTED, default-OFF
- **Gate result (DAT probe):** new example `crates/holtburger-dat/examples/dump_posframe_orientation.rs` scanned all 436 MotionTables (18451 cycles + 1222 modifiers + 42537 links). **Both player tables (0x09000001 / 0x09000202) carry ZERO non-identity orientation** — player root motion is pure translation, so DIM5-2 is a strict no-op for the local player rig. Non-identity orientation (pure **yaw**, up to **27.46°** on **MT 0x090001D5 cmd 0x0011**) exists ONLY on creature tables (117 reachable cycles >1°). Best eye-test target: MT `0x090001D5` cmd `0x0011`.
- **Design (simpler than the recon's 18-edit spec):** the rigid root-motion frame `(R_n, T_n)` is composed per melt `MotionTable.cs:225-231` and **folded directly into each part of `part_frames`** inside `build_concatenated_motion_frames` — `world = R_n·partLocal + T_n`, `quat = R_n·partQuat` — and the separate additive `pos` channel is zeroed. This means **no tuple/struct/getter/JS/caller changes** (the recon spec wrongly added a parallel `ori` channel + a THREE.js quaternion track + 18 edits; that approach also had an `R_n·T_n` parity bug because translation stays per-part while rotation would be group-level).
- **Why default-OFF:** for identity-orientation cycles the fold is byte-identical to the shipped translation-only path (R=I ⇒ R·v == v), so flipping changes ONLY creature root motion — which cannot be validated code-only (no GPU). Gate: `const DIM5_2_ROOT_ORIENT: bool = false` (`lib.rs`, near `build_concatenated_motion_frames`). Flip + eye-test MT 0x090001D5 to accept.
- **Files:** `crates/holtburger-common/src/math.rs` (Quaternion `multiply`/`normalize`/`conjugate` + 5 unit tests); `apps/holtburger-web/src/lib.rs` (gate const, `advance_root_motion` + `fold_root_motion_into_parts` helpers, gated fold in the `push_frame` closure, `dim5_root_motion_tests` ×5).
- **Validation:** `holtburger-common` 60 tests pass (incl. 5 new quaternion tests); `holtburger-web` lib **87 tests pass, 0 fail** — 5 new DIM5-2 tests cover the accumulator (identity==legacy, forward-then-yaw curves to (1,1,0)@180°, reverse-identity==negation) AND the fold helper (identity==pure-translate, yaw rotates part about origin) so the gated path is guarded against rot even while default-off; **host AND wasm32 both compile clean** (only pre-existing warnings).
- **Adversarial review:** 4-lens workflow (quaternion math / rigid-fold parity / no-regression gate / DIM3-4 clamp+completeness) → **SHIP, zero findings**. The fold-helper test was added in response to the one actionable should-consider (guard the gated path).

### DIM3-4 — "-2" AnimHookDir sentinel — CLOSED (defensive clamp + docs)
- The reverse-segment hook-direction negation (`lib.rs build_concatenated_motion_frames`) changed from blanket `h.direction = -h.direction` to `match { 1 => -1, -1 => 1, other => other }`, so a stray `UNKNOWN(-2)` can never become out-of-enum `+2`. The JS `_fireHook` gate (`entities.js`) already fail-soft handles -2 (treated as Both/fire) — documented.
- Doc comments added: `setup_model.rs` `AnimationHook.direction` (the -2 sentinel is a ctor default overwritten on `UnPackHook`, never serialized; 0 found in portal.dat survey) and `entities.js` gate. No behavioral change.

## HELD this session (with rationale — both were rated optimistically in RECON)

### W5.1 — per-part LOD — HOLD (bigger + riskier than "remove one guard")
The traced reality (Phase-1 `w51-spec`): fixing the `setup.parts.len() != 1` short-circuit at `lib.rs ~5606` requires changing `resolve_did_degrade` from `u32 → Vec<u32>`, rippling through **~9 call sites** (`fetch_model_mesh`, `fetch_model_did_degrades` prefetch, `fetch_entity_degrade_for_distance`, `fetchBuildingPlacement`, `fetchEntityAnimationKeyframes`) plus `ModelMesh` / `EntityAnimationData` struct + getter changes and **`statics.js` / `entities.js`** consumer changes (`statics.js:480 m.didDegrade` reads a scalar). Crucially, the spec also found that **gameplay entities legitimately use whole-rig distance substitution** (`fetch_entity_degrade_for_distance` is correct as-is) — the real defect is multi-part **statics** (buildings) never LOD-ing, which needs a renderer-side per-part mesh swap **and a perf eye-test** to land safely. Not a code-only, no-regression change. Full spec captured in the Phase-1 `w51-spec` output.

### H-3 — multi-action queue drain — HOLD (matches handoff NO-GO)
Confirmed: protocol fully parses `Vec<MotionItem>` (`movement/types.rs:316-322,525-526`) but the web consumer reads only `forward_command` (`lib.rs ~30215-30249`), dropping chained actions. Landing the drain touches the **hot path for ALL entity motion** (every remote player/NPC), with unresolved semantics (queue location wasm-vs-JS, autonomous-flag bit15 gating, AnimationDone(4) firing cadence, single-command byte-identity). The handoff is explicit: **NO-GO until a live ≥2-action packet capture proves the collapse**. No such capture is possible code-only. Full FIFO-drain spec (mirror ACE `MotionTable.cs:189-233` 6-deep, advance on AnimationDone hook 4) captured in the Phase-1 `h3-spec` output for a future session.

## NEXT
1. Flip `DIM5_2_ROOT_ORIENT` and eye-test creature **MT 0x090001D5 cmd 0x0011** (27° yaw) on the 1070 to accept DIM5-2's runtime behavior.
2. W5.1: dedicated session — per-part statics LOD renderer path + perf eye-test.
3. H-3: capture a live ≥2-action motion packet first, then land the client FIFO.
