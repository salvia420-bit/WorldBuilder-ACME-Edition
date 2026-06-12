# S13 — A5-P3: root-motion metadata export (wasm) + JS consumer

Execution-grade spec. Source survey: `agents/A5-sequence-playback.md` §4 Stage P3 (divergence
table row 2). All repo paths relative to
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger` unless absolute.
Retail truth: `/home/wbterminal/ac-headers/acclient.c` / `acclient.h`.

---

## 1. read-HEAD + W2 assumptions

- **Read started at HEAD `61bea82f`** (`holtburger: W2/Batch-R2 buildbox dispatch manifest`).
- **HEAD moved mid-read to `3172c03e`** (`A4-Q1 retail MotionTableManager pending-animation
  queue core`) — the W2 wave is landing live. All file:line cites below were taken at
  `61bea82f`; lib.rs / entities.js lines may drift a few lines as W2/R2 items land.
  Re-grep anchors (function names) are given for every load-bearing cite.

W2 in-flight items this spec interacts with:

| item | state at read | dependency for this spec |
|---|---|---|
| A4-Q1 (MotionTableManager queue) | LANDED mid-read (3172c03e) | none direct; A4-Q2's `notifyAnimationDone` export shares wasm batch R4 with our metadata getter — one manifest bump for the batch |
| A3-D1/D2 (motion_interp completion) | in flight | none direct (completion-time apply here is JS-side; see §3 seam notes) |
| A2-P1 (`spatial/position_manager.rs`) | NOT landed at read HEAD (`spatial/` still has `force_position_interp.rs` only) | required ONLY for the deferred local-player half (P3-L, §3 stage 3 — design note, not implemented here) |
| A7-R1/R2/R3/R6, A9-Stage1 | in flight | none |
| A5-P1 (`?hookDrain`, W3) | NOT landed (no `hookDrain`/`_hookFireQueue` hits in entities.js) | ordering seam only — §3 stage 2 step 6 |

This spec **assumes** the in-flight W2 batch R2 changes do not touch
`build_concatenated_motion_frames` / `EntityAnimationData` / `_tryPlayLink` (they are
movement-crate + queue items; the animation bake path is A5-only per ROADMAP §3 conflict
matrix — "Small getter-only additions (A10-M3a, A11-S4, A5-P3 metadata) can batch together
independently", ROADMAP.md:138).

---

## 2. Current-state map (post-W0/W1)

### 2.1 Retail truth — what root motion does to the OBJECT

Per physics update of one object (`CPhysicsObj::UpdatePositionInternal`):

1. An identity `offset_frame` is built; `CPartArray::Update(quantum, &offset_frame)` runs the
   sequence, which for every crossed integer frame combines that frame's `pos_frames` AFrame
   into the accumulator: `Frame::combine(retval, retval, pos_frame)` —
   acclient.c:340717-340720 (inside `CSequence::update_internal`; `Frame::combine` body at
   acclient.c:340420-340457).
2. Back in `UpdatePositionInternal` (acclient.c:320009-320035): **if `transient_state & 2`
   the offset TRANSLATION is scaled by `m_scale`; otherwise the translation is multiplied by
   0.0 — but ONLY `m_fOrigin.x/y/z` is zeroed; the quaternion part of `offset_frame` is
   never touched** (acclient.c:320014-320026, verified verbatim).
3. **Bit identity (resolves A5 §6 open question #3): `transient_state & 2` is
   `ON_WALKABLE_TS`, NOT contact.** `enum TransientState { CONTACT_TS = 0x1,
   ON_WALKABLE_TS = 0x2, ... }` — acclient.h:3688-3699. Corroborated in code:
   `prev_on_walkable = this->transient_state & 2;` — acclient.c:322532. (Our own shipped
   comment already reads retail "on_ground" as `transient_state & 3 == 3` — lib.rs:23579-23583.)
4. The (possibly zero-translation) offset goes through
   `PositionManager::adjust_offset(offset_frame, quantum)` (acclient.c:320028-320030), then
   `Frame::combine(o_newFrame, &m_position.frame, &offset_frame)` composes it **in the
   object's local frame** into the new object frame (acclient.c:320031), physics resolves
   (`UpdatePhysicsInternal`, acclient.c:320033-320034), and only then
   `CPhysicsObj::process_hooks` drains queued anim hooks (acclient.c:320035).

So retail root motion: (a) moves the OBJECT frame, per crossed frame, (b) translation gated
on ON_WALKABLE + scaled by `m_scale`, (c) rotation unconditional, (d) composed object-local.

### 2.2 Ours — root motion is purely visual, folded into part keyframes

Rust (wasm bake), `apps/holtburger-web/src/lib.rs`:

- `build_concatenated_motion_frames` (lib.rs:5770-5962) bakes a whole resolved MotionData
  into flat keyframes. It already maintains EXACTLY the accumulators P3 needs:
  - `pos_accum: [f32; 3]` (lib.rs:5804) and `ori_accum: Quaternion` (lib.rs:5809), advanced
    per frame by `advance_root_motion` (lib.rs:5724-5743 — `T += R·origin;
    R = (R·orientation).normalize()`, reverse de-accumulates with the conjugate), mirroring
    retail `Frame::combine` accumulation (acclient.c:340420-340457, 340717-340720).
  - With `DIM5_2_ROOT_ORIENT = true` (const, lib.rs:5713) the rigid frame `(R_n, T_n)` is
    folded into every part keyframe (`fold_root_motion_into_parts`, lib.rs:5753-5765) and the
    additive `pos` channel is zeroed (lib.rs:5882-5884). Legacy path emits the cumulative sum
    into `pos` (lib.rs:5885-5907). **In both paths the final `(pos_accum, ori_accum)` pair at
    end-of-bake IS the clip's net rigid root displacement — currently discarded** (return
    tuple lib.rs:5961 returns only `(frames, times, pos, t)`).
- Pass-through plumbing: `try_resolve_cycle_frames` (lib.rs:5150-5152),
  `try_resolve_link_frames` (lib.rs:5660-5667) → `build_entity_animation_data_inner_v2`
  (lib.rs:15419-15513) → `EntityAnimationKeyframesInner` (`pos_frames` field lib.rs:15293) →
  `inner_to_wasm_animation_data` (lib.rs:15703-15730) → `EntityAnimationData` (`pos_frames`
  lib.rs:15053; getter `posFrames` lib.rs:15159-15162) and the batch wrapper
  `fetchEntityAnimationKeyframesBatch` (lib.rs:15779+, builds via the same inner converter).

JS (scene3d):

- `buildAnimationClip` adds `posFrames[3i]` to every part's position keyframe
  (animation.js:136-161) — the lunge/door translation moves the RIG, never the anchor
  (vs retail acclient.c:320031). The clip cache snapshots `posFrames` fail-soft at
  animation.js:577-581 and returns a POJO cache entry at animation.js:730+.
- One-shots play via `_tryPlayLink` (entities.js:7484-7622): `LoopOnce`,
  `clampWhenFinished = false` (entities.js:7539-7540), `action.reset(); action.play()`
  (entities.js:7571-7572) — at clip end the rig POPS back to the anchor pose; the anchor
  (`inst.root.position` / `inst.root.quaternion`) was never moved. Next server
  KIND_POSITION (loop.js:2038-2106 → `em.setPose`, entities.js:3605-3700) then snaps it.
  This is divergence A5 §3 row 2 (DIFF-ALGO): retail moves the object
  (acclient.c:340717-340720 + 320014-320031); ours moves only part keyframes
  (lib.rs:5762-5819 ≈ current 5753-5907; animation.js:143-161).
- Per-overlay `finished` listener pattern already exists:
  `_suppressBaseCycleForOverlay`'s `onFinished` (entities.js:7632-7661).
- Anchor-adjacent state we will reuse: `inst._baseScale` from `meta.objScale`
  (entities.js:2940-2942) — the `m_scale` analog (acclient.c:320014-320020);
  `inst._isAirborne` / `inst.airborneTilt` (entities.js:1789-1793, 3631-3632) — nearest
  per-entity analog of `ON_WALKABLE_TS`; dead-reckon ease target `inst._serverTargetPos`
  (entities.js:3653-3662) and heading-ease target `inst._serverTargetQuat`
  (entities.js:3635-3647); per-guid server-pose timestamp slot
  `window.__lastEntityWorldPos.get(g).ts` stamped on every KIND_POSITION
  (loop.js:2062-2071); AC→three quat reorder `acQuatToThree` (adapter.js:1035-1037,
  pure w-reorder, no axis remap — scene is AC Z-up throughout).
- Local player: KIND_POSITION snap is already skipped (loop.js:2079); the rig pose is
  overwritten every rAF from the wasm integrator — a JS-side anchor apply for the local
  player would be a no-op/fight, so it is excluded (see stage 3).

Post-W0/W1 spine context (unchanged by this spec, listed for orientation): canonical
`tick_spine.rs` exists (`crates/holtburger-core/src/client/tick_spine.rs`); gates
`?worldLifecycle` / `?unifiedTick` / `?posePublishPostTick` / `?wireStatePacks=stage1` /
`?maintPrune` are live (docs/url-flags.md:394-418). Manifest handshake: lib.rs:445
`WASM_EXPORT_MANIFEST_VERSION = 2`; index.html:1804 `EXPECTED_WASM_MANIFEST_VERSION = 1`
(F18-2 contract, index.html:1794-1801).

---

## 3. Staged implementation plan

Scope ruling carried from A5 §4: per-frame object root motion (true retail) is DEFERRED;
completion-time application removes the visible snap at a fraction of the risk. Do NOT
port CSequence (ROADMAP §8 do-not-do).

### Stage P3-W — wasm metadata export (wasm-rebuild, batch R4)

Files: `apps/holtburger-web/src/lib.rs`, `apps/holtburger-web/index.html` (manifest const).

1. **Return the accumulators from the bake.** Change
   `build_concatenated_motion_frames` (lib.rs:5770) to additionally return the end-of-bake
   `(pos_accum, ori_accum)`. Concrete shape — replace the 4-tuple with a named struct to
   stop tuple churn:

   ```rust
   #[cfg(any(target_arch = "wasm32", test))]
   pub(crate) struct ConcatenatedMotionBake {
       pub frames: Vec<holtburger_dat::file_type::setup_model::AnimationFrame>,
       pub frame_times: Vec<f32>,
       pub pos_frames: Vec<f32>,
       pub duration: f32,
       /// A5-P3: net rigid root displacement of the whole clip — the final
       /// (pos_accum, ori_accum) pair. Model-space, relative to clip start.
       /// Retail equivalent: the sum of per-frame Frame::combine(pos_frame)
       /// offsets a full playthrough feeds CPhysicsObj::UpdatePositionInternal
       /// (acclient.c:340717-340720 -> 320014-320031).
       pub net_translation: [f32; 3],
       pub net_orientation: holtburger_common::Quaternion,
   }
   ```

   The values already exist: return `pos_accum` / `ori_accum` (lib.rs:5804, 5809) at the
   `Some(...)` (lib.rs:5961). NOTE both paths are covered with zero math changes: the
   `DIM5_2_ROOT_ORIENT=true` path maintains both accumulators
   (`advance_root_motion`, lib.rs:5871-5878); the legacy path maintains `pos_accum` and
   leaves `ori_accum` identity (lib.rs:5893-5903) — identical to its visual semantics.
   Call sites to mechanically update: lib.rs:5150 (`try_resolve_cycle_frames`), lib.rs:5665
   (`try_resolve_link_frames`), tests lib.rs:42604, 42617, 42649, 42679 (destructure or
   `..`-ignore).

2. **Plumb through the resolvers.** `try_resolve_cycle_frames` (lib.rs:5090-5153) and
   `try_resolve_link_frames` (lib.rs:5630-5668) extend their `Option` payload with the two
   net fields (or return the struct + `resolved_stance`). The unrelated caller at
   lib.rs:14366 (`fetch_entity_cycle_frames`, 2D path) ignores the new fields — do NOT
   extend `EntityCycleSet`.

3. **`EntityAnimationKeyframesInner`** (lib.rs:15276-15299): add
   `pub root_motion_net: Vec<f32>` — **layout `[tx, ty, tz, qw, qx, qy, qz]`, length 7**
   (AC w-first quat order, same convention as `part_frames`, lib.rs:15036-15038).
   Fill in `build_entity_animation_data_inner_v2` success path (lib.rs:15500-15513);
   `Vec::new()` (empty) in the three no-cycle fallbacks (raw-GfxObj lib.rs:15369-15382,
   cycle-miss lib.rs:15437-15450) — empty = "no clip / unknown", a resolved clip with no
   pos_frames yields the identity 7-vec `[0,0,0,1,0,0,0]` naturally from the accumulators.

4. **`EntityAnimationData`** (lib.rs:15030-15082): add field + getter:

   ```rust
   /// A5-P3 root-motion metadata: net rigid root displacement of the
   /// whole baked clip, [tx,ty,tz, qw,qx,qy,qz] (AC w-first), model
   /// space relative to clip start. Empty when no cycle resolved.
   /// Identity ([0,0,0,1,0,0,0]) for clips without POS_FRAMES.
   #[wasm_bindgen(getter, js_name = rootMotionNet)]
   pub fn root_motion_net(&self) -> Vec<f32> { self.root_motion_net.clone() }
   ```

   Wire through `EntityAnimationData::empty` (lib.rs:15210-15238 — `Vec::new()`) and
   `inner_to_wasm_animation_data` (lib.rs:15703-15730 — field pass-through). The batch
   wrapper (lib.rs:15779+) builds through the same converter — no extra work.

5. **Manifest bump (F18-2).** Bump `WASM_EXPORT_MANIFEST_VERSION` (lib.rs:445; 2 at read
   HEAD → land-time current + 1) and `EXPECTED_WASM_MANIFEST_VERSION` (index.html:1804) to
   the SAME value in the SAME change-set as the JS consumer (contract comment
   index.html:1794-1801). Per ROADMAP §3 (ROADMAP.md:138) and §5 batch R4, this getter
   batches with A10-M3a `hasPalette`, A11-S4 degradeDistance, A2-P2 remote-pose export,
   A4-Q2 `notifyAnimationDone` — **one manifest bump for the whole R4 batch**; coordinate
   with the R4 batch owner rather than bumping solo.

6. **No Rust flag.** The metadata is inert data; the default-off behavior gate lives in JS
   (stage P3-J). Classification: **wasm-rebuild** (rides batch R4; lib.rs edits are
   staged-inert until the buildbox rebuild — never wasm-pack from a spec/impl session,
   DESIGN.md §5 build rules).

### Stage P3-J — JS consumer: apply-on-completion to the entity anchor (JS-live, `?rootMotionObject=1`, default OFF)

Files: `apps/holtburger-web/scene3d/animation.js`, `apps/holtburger-web/scene3d/entities.js`,
`apps/holtburger-web/docs/url-flags.md` (+ the flag-parse site, same pattern as
`?deadReckon`/`?headingSnap` — grep `_deadReckonOn` in entities.js for the registration
pattern).

1. **Cache snapshot** (animation.js, inside `AnimationCache.get`'s build closure, beside
   the `posFrames` snapshot at animation.js:577-581): snapshot BEFORE the wasm handle is
   freed, fail-soft for older wasm bundles:

   ```js
   const rootMotionNet =
       animData.rootMotionNet && typeof animData.rootMotionNet.length === "number" &&
       animData.rootMotionNet.length === 7
           ? Float32Array.from(animData.rootMotionNet)
           : null;
   ```

   Add `rootMotionNet` to the returned cache-entry POJO (animation.js:730+, beside `clip`,
   `hooks`). Significance predicate (shared helper, exported for tests):
   `hasRootMotion(net) = net && (hypot(net[0..2]) > 1e-4 || 2*acos(min(1,|net[3]|)) > 1e-3)`.

2. **Flag**: `?rootMotionObject=1`, default OFF, read once in the `EntityManager`
   constructor into `this._rootMotionObjectOn` (mirror `this._headingEaseOn` /
   `this._deadReckonOn` pattern, entities.js:3626-3627/3674). Register a row in
   `docs/url-flags.md` (format per the table at url-flags.md:394-418) with the eye-test +
   acceptance columns from §4 below.

3. **Arm on play** — in `_tryPlayLink` immediately after `action.reset(); action.play()`
   (entities.js:7571-7572):

   ```js
   if (this._rootMotionObjectOn && hasRootMotion(entry.rootMotionNet) &&
       !this._isLocalPlayerGuid(inst.guid >>> 0)) {
     this._armRootMotionOnFinish(inst, action, entry.rootMotionNet);
   }
   ```

   `_armRootMotionOnFinish` registers a one-shot `mixer.addEventListener("finished", ...)`
   exactly per the `_suppressBaseCycleForOverlay` pattern (entities.js:7632-7661):
   same-action guard via `inst._pendingRootMotion === action` (re-arm refreshes the captured
   `poseTs` instead of stacking listeners — spam-replay safe, mirrors entities.js:7635);
   captures `poseTs = window.__lastEntityWorldPos?.get(inst.guid >>> 0)?.ts ?? 0` at play
   time.

4. **Apply on finished** — `_applyRootMotionToAnchor(inst, net, poseTsAtPlay)`:

   - Bail: entity disposed (`!this.entityMap.has(guid)`), or flag off.
   - **Freshness gate (double-apply protection):** if
     `window.__lastEntityWorldPos?.get(guid)?.ts !== poseTsAtPlay` → a server
     KIND_POSITION landed mid-clip (stamped at loop.js:2067-2071) → SKIP entirely. The
     server's authoritative pose already includes whatever the server thinks the anim did;
     adding our net on top would double-apply.
   - **Walkable gate (translation only):** skip the TRANSLATION when
     `inst._isAirborne || inst.airborneTilt` (entities.js:3631-3632) — the JS analog of
     retail zeroing `offset_frame.m_fOrigin` when `!(transient_state & ON_WALKABLE_TS)`
     (acclient.c:320020-320026; acclient.h:3691). **Rotation applies regardless** — retail
     never zeroes the offset quaternion (acclient.c:320014-320026 scales/zeroes only
     `m_fOrigin.x/y/z`).
   - **Translation** (object-local composition, mirroring
     `Frame::combine(o_newFrame, &m_position.frame, &offset_frame)` acclient.c:320031, with
     `m_scale` scaling acclient.c:320014-320020):

     ```js
     const s = inst.root.scale.x || 1.0;   // live m_scale analog: objScale base
                                           // (entities.js:2940-2942) as mutated by
                                           // ScaleHook tweens (entities.js:10515-10535)
     const d = new THREE.Vector3(net[0], net[1], net[2])
         .multiplyScalar(s)
         .applyQuaternion(inst.root.quaternion);
     inst.root.position.add(d);
     if (inst._serverTargetPos) inst._serverTargetPos.add(d);   // entities.js:3653-3662 —
         // keep the dead-reckon ease target coherent so tick() doesn't pull the rig back
     ```

   - **Rotation** (object-local post-multiply; AC w-first → three via `acQuatToThree`,
     adapter.js:1035-1037):

     ```js
     const rq = acQuatToThree(net[3], net[4], net[5], net[6]);
     inst.root.quaternion.multiply(rq);
     if (inst._serverTargetQuat) inst._serverTargetQuat.multiply(rq); // entities.js:3635-3647
     ```

   - **Ledger + reconcile:** accumulate into `inst._appliedRootMotion` (diag only) and
     CLEAR it in `setPose` (entities.js:3605+) — any fresh authoritative KIND_POSITION
     replaces the anchor wholesale, making the ledger moot (the existing
     `DEAD_RECKON_TELEPORT_SNAP_SQ` guard at entities.js:3659 already snaps large deltas).
   - Diag hook: `window.__diag?.motion?.onRootMotionApplied?.({ guid, dx, dy, dz, angle })`
     (pattern of `onMotionLinkPlayed`, entities.js:7606-7618).

5. **Interrupted overlays apply NOTHING.** A crossfade-out/motion-change before `finished`
   means no apply (retail would have applied the partial per-frame sum,
   acclient.c:340713-340727 — accepted approximation gap per A5 §4 P3; recorded in §5).

6. **A5-P1 seam (W3, may land in the same wave):** P1 introduces a per-entity hook queue
   drained AFTER pose application (retail `process_hooks` placement, acclient.c:320035).
   Root-motion apply is part of the POSITION step, which retail runs BEFORE the hook drain
   (acclient.c:320031 before :320035). Rule: if `_hookFireQueue` exists when this lands,
   run `_applyRootMotionToAnchor` in the entity tick at the queue-drain site, ORDERED
   BEFORE that entity's hook drain for the frame; otherwise the standalone `finished`
   listener above stands. Either owner is correct w.r.t. the flag; do not implement both.

### Stage P3-L — local player object root motion (DEFERRED — design note only, do not implement)

The local player's anchor is the wasm integrator (KIND_POSITION skip loop.js:2079; per-rAF
overwrite via `applyLocalPlayerPoseFromIntegrator`). The retail-true home for its root
motion is the Rust position owner: per-frame offset → `position_manager.adjust_offset` →
frame combine (acclient.c:320028-320031), i.e. A2-P1's
`crates/holtburger-world/src/spatial/position_manager.rs` (NOT landed at read HEAD) plus
the DESIGN.md Stage-2 interpreted-rig tie. Blocked on: A2-P1 landed + A2-P2 + Stage-1
eye-test PASS (ROADMAP §2 global gate explicitly lists A5-P3 acceptance under that gate,
ROADMAP.md:90-92). Re-open as its own item; the metadata exported in P3-W is already
sufficient input for it.

---

## 4. Test plan

### Headless-now (buildbox, no 1070, no GPU)

Rust (`build_concatenated_motion_frames` is `cfg(any(wasm32, test))` — native-testable;
extend the existing suites at lib.rs:42595-42700 and `dim5_root_motion_tests`
lib.rs:5256-5345, which already build synthetic `ResourceSource` fixtures):

1. Translating multi-segment MotionData (synthetic, identity orientations): exported
   `net_translation` == last entry of the cumulative `pos_frames` channel (legacy-path
   identity, lib.rs:5905-5907) == sum of raw per-frame deltas; `net_orientation` identity.
2. Reverse segment: forward-then-reverse of the same anim nets to ~zero (the
   `advance_root_motion` conjugate path, lib.rs:5732-5736).
3. DIM5-2 yaw case (reuse `forward_then_yaw_curves_translation` fixture, lib.rs:5289-5304):
   net == the curved (1,1,0)/yaw-180 accumulator pair, while the `pos` channel is all-zero
   (fold path) — proves the metadata survives the fold that zeroes the visual channel.
4. No-POS_FRAMES cycle: net == identity 7-vec; no-cycle fallback: `root_motion_net` empty.
5. Pass-through: `build_entity_animation_data_inner_v2` surfaces the same 7 floats for a
   link resolve (`from_motion_command != 0`, lib.rs:15419-15431) and a cycle resolve.

JS (node harness, pattern of the existing `test_phase7_4*` composite-source harnesses;
plus `node --check` on entities.js/animation.js):

6. Cache snapshot: fake `animData` POJO with/without `rootMotionNet` → entry carries
   `Float32Array(7)` / `null`; `hasRootMotion` predicate truth table (zero, tiny-eps,
   translation-only, rotation-only).
7. Apply unit (fake `inst` with root Object3D, fake `__lastEntityWorldPos`):
   - applies `d = R_root·(s·T)` and post-multiplies the quat on finished;
   - SKIPS entirely when `poseTs` changed (freshness gate);
   - skips translation but applies rotation when `_isAirborne` set;
   - co-moves `_serverTargetPos`/`_serverTargetQuat` when present;
   - spam re-arm (reset/play twice) applies exactly once per completed play;
   - local-player guid never armed.

### 1070-gated (Lane B — acceptance; landing flag-off is NOT gated, per ROADMAP §2)

- Lunge/knockback eye-test (A5 §4 P3): creature one-shot that translates ends with the rig
  staying where the anim left it (flag on) vs the pop-back/snap (flag off); subsequent
  server KIND_POSITION agrees within normal dead-reckon ease (no fight, no double-step).
- Door/lever: open→close round trip returns the anchor to start (close net is the open
  net's inverse by construction — reverse-segment de-accumulation lib.rs:5732-5736);
  10-cycle soak shows no cumulative drift.
- Soak on a position-streaming creature: freshness gate causes skips, no drift vs flag-off.
- `?rootMotionObject` row in url-flags.md gets its eye-test/acceptance columns from the
  above; on PASS promote per the passed-flag policy.

---

## 5. Risks + rollback

- **Rollback:** flag off = byte-identical JS behavior; the wasm metadata is pure
  additional data (getter unread). Wasm side has no behavior change at all.
- **Double-apply vs server authority.** If ACE moves the object server-side for a given
  anim (knockbacks do arrive as position updates), our apply + the server update could
  double-step. Mitigated by the freshness gate (skip if any KIND_POSITION landed
  mid-clip) + ledger-clear on `setPose`; residual window = server update arriving AFTER
  `finished` but reflecting the same move — bounded by the dead-reckon teleport-snap guard
  (entities.js:3659) and corrected by the very next authoritative pose. Acceptance
  includes the no-drift soak.
- **Entities the server never re-positions (doors/levers).** An applied offset has no
  authoritative correction. Open/close nets cancel by construction; an INTERRUPTED close
  can leave residue until the next setPose (possibly never, for a door). Fallback ruling
  if the 1070 eye-test shows door drift: restrict the apply to
  `classifyMotionCommand(toCmd) ∈ {attack, cast, emote}` classes (classifier already used
  at entities.js:7518-7521) — a one-line gate, keep doors visual-only.
- **Interrupted overlays apply nothing** while retail applies partials per crossed frame
  (acclient.c:340713-340727). Accepted scope cut (A5 §4 P3: "completion-time application
  removes the visible snap at a fraction of the risk").
- **Walkable-gate fidelity.** Retail gates on the object's own `ON_WALKABLE_TS`
  (acclient.h:3691); our remote-entity proxy is the jump-driven `_isAirborne`/
  `airborneTilt` pair (entities.js:3631-3632) — a falling (non-jumping) creature would
  still get translation applied. No wire bit exists for remote walkable state; recorded in
  §6.
- **Tuple→struct churn** in `build_concatenated_motion_frames` touches the T3/T4 test
  sites (lib.rs:42604-42700) — mechanical, compile-checked
  (`capped-build cargo check -p holtburger-web --target wasm32-unknown-unknown`, single
  `-p`, never `--workspace`; actual rebuild is the R4 batch owner's).
- **Line drift:** W2 is committing to lib.rs/entities.js right now; every edit above is
  anchored to function names, not bare line numbers.

---

## 6. OPEN QUESTIONS

1. **Remote walkable state** — retail's per-object `ON_WALKABLE_TS` gate
   (acclient.h:3691; acclient.c:320020-320026) has no per-remote-entity equivalent in our
   JS (only the jump-driven `_isAirborne`/`airborneTilt`). Is a wire-derivable proxy
   (PhysicsState bits on ObjectCreate?) worth plumbing, or is the jump proxy acceptable?
   Single-sided (no our-side cite for a remote walkable bit) — cannot dual-cite a fix.
2. **Does ACE actually translate the object server-side for the anims we'd apply?**
   (Knockback/lunge → likely yes via position broadcasts; door open → unknown.) The ACE
   server tree is not in this checkout to cite. Determines whether the freshness gate
   makes the apply rare in practice (which would be fine — it then only fills the
   no-broadcast gap) and whether the door class should be excluded up front.
3. **`m_scale` source** — spec picks live `inst.root.scale.x` (objScale base
   entities.js:2940-2942 as mutated by ScaleHook tweens entities.js:10515-10535) over the
   static `_baseScale`. Retail uses live `m_scale` (acclient.c:320016-320019), which
   ScaleHook also mutates — believed correct, but the ScaleHook-during-one-shot overlap is
   untested in retail terms (no acclient cite chased for ScaleHook's write target being
   the same `m_scale` field read at 320016).
4. **Base locomotion cycles with POS_FRAMES** — `setMotion`'s LoopRepeat cycle path also
   builds clips through the same cache; a CYCLIC clip with nonzero net would, under a
   future extension, need per-loop application (retail integrates continuously). This spec
   arms ONLY `_tryPlayLink` one-shots; the 2026-05-29 audit found locomotion cycles carry
   no pos_frames (lib.rs:5784-5791 comment, verified human idle pos_frames_len==0), so
   nothing is lost — but no exhaustive DAT survey proves NO cyclic cycle anywhere has
   pos_frames. If one exists, it stays visual-only (status quo).
5. **P3-L ownership** (local player): position_manager (A2-P1) vs MovementSystem intent —
   defer to the A2/A3 seam owners; the exported metadata shape here is the agreed input
   either way.
6. **Manifest bump coordination** — which R4 item carries the single
   `WASM_EXPORT_MANIFEST_VERSION` bump for the batch (this spec assumes the batch owner
   does; if A5-P3 lands alone, it bumps).
