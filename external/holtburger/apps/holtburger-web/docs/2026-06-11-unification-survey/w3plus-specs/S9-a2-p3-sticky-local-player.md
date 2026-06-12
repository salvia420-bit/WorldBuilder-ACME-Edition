# S9 — A2-P3 StickyManager parity, INCLUDING the local player (RULINGS item 4)

W3+ deep-spec sweep, 2026-06-12. Read-only spec; no code was changed.

Ruling honored: **RULINGS.md:23-27** — "retail melee sticky DOES lock the local player
to its attack target (player or creature). Our local-player exclusion (loop.js:1855
[now loop.js:1887 post-W2]) is therefore a real divergence … A2-P3's design must
include the local player; the ACE-side single-citation gap is resolved by user
testimony." This spec ALSO closes the ACE-side citation gap with code cites (§2.3) —
the ruling is now dual-cited, not testimony-only.

---

## 1. Read-HEAD + landed-W2 facts this spec builds on

`git log --oneline -1` at spec time: **048573d0** "holtburger: W2 wave results"
(matches the expected W2-complete HEAD; all 8 W2 items on master).

Landed facts treated as CURRENT STATE:

| fact | where |
|---|---|
| A2-P1 PositionManager node queue (e871fca8) | `crates/holtburger-world/src/spatial/position_manager.rs` — facade `PositionManager { legacy, interpolation, constraint }` (position_manager.rs:542-546), gate `USE_POSITION_MANAGER_QUEUE: bool = false` (:37). **No sticky slice exists** — the module doc says so explicitly (:4, :21 "sticky is P3"). |
| Facade step/install API | `install_force_position` (position_manager.rs:593-617), `step_force_position` (:624-656) — interp `use_time` drain + interp→constraint chain. Stepped from `system.rs:3006-3020` via `scene.step_force_position_interpolation` (scene.rs:2133); installed at scene.rs:2058-2102. |
| A3-D2 unstick hook EXISTS and is a documented no-op | `crates/holtburger-core/src/client/movement/system.rs:1165-1178` — "The unstick hook bubbles to A2's sticky owner once that lane lands (A2-P3, W5); until then a fired hook is a no-op by construction": `let _unstick = self.local_motion_interp.motion_done(success);`. Producer: `motion_interp.rs:510-530` `motion_done` returns `true` when the one-shot action bit (0x10000000) demands unstick (acclient.c:343641-343676, unstick at :343659). |
| A4-Q1 queue pump | system.rs:1171-1178 under `USE_MOTION_TABLE_QUEUE` — the only place `motion_done` fires today. |
| A13-W1 shared self-movement consumption | `movement/system.rs:3203-3233` `apply_self_movement_world_events`, called from native `client/messages.rs:61` AND wasm `apps/holtburger-web/src/lib.rs:31552` (gated `?wireStatePacks=stage1`). Native-only follow-on `simulation.handle_server_controlled_movement` stays at `messages.rs:66-78`. |
| Manifest state | `WASM_EXPORT_MANIFEST_VERSION: u32 = 3` (lib.rs:478); `EXPECTED_WASM_MANIFEST_VERSION = 1` (index.html:1803). 6 W2 flags already await one batched wasm rebuild + 1070. |
| Wave gate | ROADMAP.md:110-112 — "A2-P3 (sticky) strictly AFTER DESIGN Stage 3 / A3-D3 lands (target-update plumbing)"; A2-P3 is W5 (ROADMAP.md:129), A3-D3 + A2-P2 are W4 (:128). **Neither A3-D3 nor A2-P2 has landed at 048573d0.** §3 Stage ordering below respects this. |

---

## 2. Current-state map

### 2.1 What ships today (F3-4 point fix — REMOTE-only, JS)

- Trigger: sticky target guid rides `model_id` of the KIND_MOTION EntityUpdate.
  Extraction in wasm: lib.rs:34045-34055 — two wire sources, the `Invalid` (case-0)
  `sticky_object` and a `MoveToObject` whose `MovementParams` carry the sticky bit
  0x80 (`moveto_is_sticky`, lib.rs:5296). `0` clears.
- JS consume: `loop.js:1887-1889` and `loop.js:2158-2159` — **both arms gate on
  `!isLocalPlayerGuid(motionGuid)`. This is THE divergence RULINGS item 4 condemns.**
- Glue: `entities.js:9198-9219` — fixed `ENTITY_STICKY_STANDOFF_M = 1.3`
  (entities.js:211), exponential damp toward target XY, `z = target z`, NO heading,
  NO timeout. Clear sites: `setStickyTarget(guid, 0)` (entities.js:6575-6580) and
  resumed KIND_POSITION (entities.js:3629-3635).
- Wire decode: `crates/holtburger-protocol/src/messages/movement/messages/motion.rs:161-178`
  (`MovementInvalid.sticky_object`, flag bit `STICK_TO_OBJECT: u8 = 0x01`,
  types.rs:27). Parsing is COMPLETE; only consumption is partial.

### 2.2 Retail truth (all line-verified this session)

- **One funnel**: `PositionManager::adjust_offset` chains interpolation → **sticky**
  → constraint (acclient.c:388287-388304, sticky call :388300; ACE
  `Physics/Managers/PositionManager.cs:19-28` identical order).
  `PositionManager::UseTime` drains interp then `StickyManager::UseTime`
  (acclient.c:388267-388284, sticky at :388283).
- **StickyManager::adjust_offset** (acclient.c:388519-388601): offset = vector to
  target (live object pose if resolvable, else stashed `target_position`), re-based
  local, **z zeroed** (:388557); standoff `mag = cylinder_distance_no_z(my_radius,
  target_radius) − 0.3` (:388559-388560); speed = `CMotionInterp::get_max_speed() *
  5.0`, floor `15.0` (:388569-388579); step `delta = speed * quantum`, capped at
  `mag` (:388580-388591); **heading offset set toward target**, negative wrapped
  `+360` (:388593-388600). **No contact requirement** (contrast interp :389199,
  constraint :389478). ACE 1:1 port: `StickyManager.cs` `adjust_offset` (external/ACE,
  whole file read — constants `StickyRadius = 0.3f`, `StickyTime = 1.0f`).
- **StickTo** (acclient.c:388665-388690): timeout `cur_time + 1.0` (:388688),
  `set_target(0, id, 0.5, 0.5)`; target pose arrives via TargetManager →
  `PositionManager::HandleUpdateTarget` → `StickyManager::HandleUpdateTarget`
  (:388691-388720 — status OK stashes pose + `initialized=true`, else ClearTarget).
  `UseTime` (:388605-388620) clears on timeout; ACE `ClearTarget` additionally calls
  `clear_target()` + `cancel_moveto()` (StickyManager.cs:33-41).
- **Entry has NO local-player exclusion**: `CPhysicsObj::stick_to_object`
  (acclient.c:319725-319763 — radius/height from the target's `CPartArray`, else
  `0.0`); wire-side `MovementManager::unpack_movement` (:339492) case-0 reads the
  sticky bit (`pack_word_1 & 1`) and guid, then `stick_to_object` unconditionally
  (:339546-339560), after the per-unpack preamble `cancel_moveto` +
  `unstick_from_object` (:339518-339519). This runs for WHATEVER object the message
  addresses — including the local player.
- **Interp sticky exemption**: `InterpolationManager::adjust_offset`'s 5-frame
  progress test is bypassed while `get_sticky_object_id(...)` is non-zero
  (acclient.c:389243-389245) — local sticky and local force-position coexist.
- **Unstick sites**: `CMotionInterp::MotionDone` one-shot pop (:343659 — our A3-D2
  hook's other half), `MoveToManager::PerformMovement` (:346126), unpack preamble
  (:339519), sticky timeout (:388605-388620).

### 2.3 ACE server side — the ruling's citation gap, now closed

- **Player melee swing**: `external/ACE/Source/ACE.Server/WorldObjects/Player_Melee.cs:420-427`
  — the player's own swing motion gets `motion.MotionFlags |= MotionFlags.StickToObject`
  + `motion.TargetGuid = target.Guid`, then `EnqueueBroadcastMotion(motion)`, and (if
  `FastTick`) server-side `PhysicsObj.stick_to_object(target.Guid.Full)`. **Identical
  in the LIVE server checkout** `~/ace-server/Source/ACE.Server/WorldObjects/Player_Melee.cs:420-427`.
- **The echo reaches the local client**: `EnqueueBroadcastMotion`
  (WorldObject_Networking.cs:1306-1321) → `EnqueueBroadcast(msg)` → the
  `sendSelf = true` overload sends to `self.Session` (WorldObject_Networking.cs:1418-1432).
- **Sticky guid is serialized on that echo**: live server
  `~/ace-server/Source/ACE.Server/Network/Motion/MovementInvalid.cs:27-28` (capture)
  and `:45-46` (write `StickyObject` when `MotionFlags & StickToObject`).
- Monster arm (the F3-4 case, for contrast): `Monster_Melee.cs:71` (`stick_to_object`)
  and `:374-376` (flag + TargetGuid).

Conclusion: **the wire signal for LOCAL-player melee-lock already arrives today and
is already parsed** (motion.rs:163-178) **and already extracted in wasm**
(lib.rs:34045-34055). It is dropped in exactly two places: the JS local-guid gate
(loop.js:1887, :2158 — correct to keep, see §3 Stage L2) and the native
`handle_server_controlled_movement` `Invalid` arm, which clears the projection but
ignores `inv.sticky_object` (`crates/holtburger-core/src/client/simulation.rs:245-252`).
The local player has NO sticky consumer on either target.

### 2.4 Load-bearing platform gap (drives the design)

In the **wasm** target, remote-entity positions are NOT mirrored into Rust world/scene
state: the `PublicUpdatePosition` recv arm only emits a JS EntityUpdate
(lib.rs:32700-32745) and is deliberately un-routed ("their world-side entity mutation
is A8-M2/A1-O1 follow-on territory", lib.rs:22184-22187). Native target: scene keeps
`entity_poses: HashMap<Guid, WorldPosition>` (scene.rs:359, `update_entity`
scene.rs:2329-2338). So the sticky TARGET's live pose must be fed explicitly on wasm —
which is retail-shaped anyway: retail sticky is fed poses by TargetManager updates and
no-ops while `!initialized` (acclient.c:388691-388720). §3 Stage L2 builds exactly
that minimal feed; full TargetManager plumbing remains A3-D3/Stage-3 property.

---

## 3. Staged implementation plan

Flag (one name, two halves): Rust const **`USE_STICKY_MANAGER: bool = false`** in
`position_manager.rs` (same pattern as `USE_POSITION_MANAGER_QUEUE`, :37) gating ALL
Rust stages; URL flag **`?stickyRetail=on`** gating the JS remote-handoff stage only.
Default-off everywhere; flag-off must be byte-identical (assert like
position_manager.rs:858).

Wave-order note: ROADMAP.md:110-112 serializes A2-P3 AFTER A3-D3 (W4) because of the
`movement/system.rs` conflict column (ROADMAP §3). Stages R1/L1/L2/L3 below are
self-contained (they bring their own minimal target feed), so the dependency is
file-serialization, not functional; Stage R2 (remote) additionally hard-requires
A2-P2's remote bodies. Execute after W4 lands or rebase over it.

### Stage R1 — StickyManager core in `position_manager.rs` (wasm-rebuild)

File: `crates/holtburger-world/src/spatial/position_manager.rs` (only file).

1. New `pub struct StickyManager` — fields mirroring ACE `StickyManager.cs`:
   `target_id: Option<Guid>`, `target_radius: f32`, `target_position:
   Option<WorldPosition>` (None ⇔ ACE `Initialized == false`), `sticky_timeout_time:
   f64`. Constants `STICKY_RADIUS: f32 = 0.3` and `STICKY_TIME: f64 = 1.0`
   (StickyManager.cs:20-22; acclient.c:388560, :388688).
2. Methods, 1:1 with ACE/retail:
   - `stick_to(&mut self, target: Guid, target_radius: f32, now: f64)` — replace any
     prior target, `target_position = None`, `sticky_timeout_time = now + STICKY_TIME`
     (acclient.c:388665-388690; StickyManager.cs:71-81). The retail `set_target`
     registration is REPLACED by the explicit pose feed (§3 Stage L2) — record this
     deviation in the doc comment.
   - `handle_update_target(&mut self, target: Guid, pose: WorldPosition)` — guid
     match → stash + initialized (acclient.c:388691-388720; StickyManager.cs:53-64).
     A failed/stale status maps to `clear_target` (caller decides).
   - `use_time(&mut self, now: f64) -> bool` — returns `true` (cleared) when
     `now > sticky_timeout_time` (acclient.c:388605-388620; StickyManager.cs:83-87).
   - `clear_target(&mut self)` (acclient.c via ACE ClearTarget StickyManager.cs:33-41;
     the `cancel_moveto` side effect is surfaced as the bool/event return so the
     OWNER clears the server-controlled projection — see Stage L1 step 4).
   - `adjust_offset(&mut self, current: &WorldPosition, my_radius: f32, max_speed:
     f32, quantum: f32) -> Option<(Vector3 /*xy step, z=0*/, f32 /*abs heading
     deg*/)>` — port acclient.c:388519-388601 exactly: `None` unless target set AND
     `target_position` stashed; offset = vector to target, z zeroed; `mag =
     cylinder_distance_no_z(my_radius, current, target_radius, target_pose) −
     STICKY_RADIUS`; `speed = max_speed * 5.0`, `if speed < EPSILON { speed = 15.0 }`;
     `delta = speed * quantum`, `if delta >= |mag| { delta = mag }`; heading =
     `current.heading_to(target)` normalized to [0,360) (returns the ABSOLUTE target
     heading — our pose adopt path applies absolutes; retail's delta+`Frame::combine`
     [:388593-388600] composes to the same heading; record as a documented
     equivalence). Reuse/port `cylinder_distance_no_z` per ACE
     `Position.CylinderDistanceNoZ` (already mirrored elsewhere in spatial code per
     the B.5 ACE-parity work — locate before writing a new one).
3. Facade integration (`PositionManager`): add `sticky: StickyManager` field; add
   `stick_to`, `unstick` (= clear), `sticky_object_id()`, `handle_update_target`,
   `sticky_use_time`. ALL behind `USE_STICKY_MANAGER` (off → field inert, facade
   byte-identical).
4. Interp sticky exemption: thread `sticky_active: bool` into the queue path's
   progress test (`InterpolationManager::step_position_head`) — skip the 5-frame
   fail-counter abort while sticky is active (acclient.c:389243-389245). Legacy
   single-node path: leave untouched (it has no fail counter to exempt — verify; if
   it does, mirror).
5. Chain order: sticky between interp and constraint (acclient.c:388287-388304; ACE
   PositionManager.cs:19-28). Implemented in `step_force_position`'s successor (Stage
   L3) — keep `step_force_position`'s signature unchanged for existing callers.

Rebuild class: **wasm-rebuild** (Rust, but inert until flag flip — batches with the 6
pending W2 flags). No JS yet. No manifest bump (no new JS-facing export).

### Stage L1 — local-player install/unstick wiring, dual-site (wasm-rebuild)

The F2-3 lesson applies: wire BOTH the native runtime and the wasm bridge.

1. **Native install**: `crates/holtburger-core/src/client/simulation.rs:245-252`
   (`MovementTypeData::Invalid` arm of `handle_server_controlled_movement`): when
   `USE_STICKY_MANAGER` && `inv.sticky_object == Some(guid)` → resolve best-known
   target pose + radius (`world.get_visible_entity(guid)` / scene `entity_poses`,
   scene.rs:359; radius fallback `0.0` per acclient.c:319756-319763) → new scene API
   `scene.stick_local_player_to(guid, radius, now)` + immediate
   `handle_update_target` if a pose was resolvable. When `sticky_object == None` →
   `scene.unstick_local_player()` (retail per-unpack preamble subset,
   acclient.c:339518-339519 — every fresh local motion without the bit unsticks).
   Note the arm ALREADY clears the projection on `Invalid` — keep that; sticky is
   additive.
   - Reachability check (verified): the swing echo arrives as `UpdateMotion` for the
     local guid; `handlers/player.rs:96-105` emits `SelfServerControlledMotion` when
     `!data.is_autonomous`; ACE's swing `Motion` leaves `IsAutonomous` at its `false`
     default (~/ace-server `Entity/Motion.cs:17-18` field + Player_Melee.cs:414 ctor
     never sets it) → the arm fires. If a capture shows otherwise, see OPEN Q4.
2. **Wasm install**: `apps/holtburger-web/src/lib.rs` — the KIND_MOTION builder
   already computes `sticky_target` for every guid (lib.rs:34045-34055). Add, beside
   it: if `USE_STICKY_MANAGER` && guid == local player guid → call the same scene
   `stick_local_player_to` / `unstick_local_player` (sticky_target 0 ⇒ unstick).
   This runs on the DEFAULT wasm path (not `?wireStatePacks`-gated), mirroring how
   the JS arm consumes the same field. Keep the JS local-guid exclusion at
   loop.js:1887/:2158 — the local rig must NOT be JS-glued; its pose comes from the
   wasm pose getters (feedback_verify_threejs_not_2d_path).
3. **Unstick hooks** (all in `crates/holtburger-core/src/client/movement/system.rs`):
   - system.rs:1172-1177: replace `let _unstick = …` with: if `unstick` &&
     `USE_STICKY_MANAGER` → `world.scene.unstick_local_player()`
     (acclient.c:343659 — closes the documented A3-D2 no-op).
   - Timeout: call `sticky_use_time(now)` in the per-tick step (Stage L3); on clear,
     also `movement.clear_server_controlled_projection()` (ACE ClearTarget →
     `cancel_moveto`, StickyManager.cs:38-40).
4. **Target pose feed** (the minimal TargetManager subset):
   - Native: in the handler that already calls `scene.update_entity`
     (scene.rs:2329-2338 callers), add: if guid == local sticky target →
     `position_manager.handle_update_target(guid, pose)`.
   - Wasm: one stash in the `GameMessage::PublicUpdatePosition` arm
     (lib.rs:32700-32745): if guid == local sticky target → same call. Until the
     first feed arrives, sticky no-ops (`target_position == None`) — retail-accurate
     `Initialized` semantics (acclient.c:388691-388720).

Rebuild class: **wasm-rebuild** (also touches native crates; native CLI tests run
under capped-build).

### Stage L3 — per-frame local adjust (wasm-rebuild, same change-set as L1)

Site: `crates/holtburger-core/src/client/movement/system.rs:2983-3020` (the
force-position step) + `scene.step_force_position_interpolation` (scene.rs:2133).

1. Extend the scene step (or add `step_local_sticky` called right after it) to apply
   the sticky offset to the tick's working pose, AFTER interp, BEFORE the runtime
   write-back: `pose.xy += sticky_step.xy; pose.rotation =
   Quaternion::from_heading(sticky_heading)`. Z untouched (retail zeroes the sticky
   z component, acclient.c:388557 — the grounded floor-snap carve-out at
   system.rs:2986-2995 is automatically preserved).
2. Contact gate: NONE for sticky (retail has none, acclient.c:388519-388601;
   interp's `transient_state & 1` check is interp-only :389199). Apply in BOTH the
   on-contact and airborne arms — the airborne arm's integrator-freeze hazard
   (system.rs:2996-3007) does not apply because sticky reads the CURRENT working
   pose passed in, not the stale `body.pose`; thread the pose as a parameter, do
   not re-read the body. Flag the airborne arm for the eye-test list anyway (OPEN Q5).
3. Speed input: `capabilities.resolved_manual_run_speed()` raw (NOT the `* 2.0`
   interp value at system.rs:2985) — sticky applies its own `* 5.0` floor `15.0`
   inside `adjust_offset`.
4. Tick the timeout here: `if scene.sticky_use_time(now_s) { …clear projection… }`
   (mirrors retail PositionManager::UseTime running sticky's UseTime each frame,
   acclient.c:388283).
5. Wasm spine: the same step must run wherever the wasm drives the local integrator
   tick (the `?unifiedTick=on` spine `tick_spine.rs` and the legacy manual-drive
   path both funnel through this system fn — verify call reachability under both
   gates before shipping; A1-O1 landed the shared spine in W1).

### Stage J1 — JS/docs half (reload-live, no rebuild)

1. `apps/holtburger-web/docs/url-flags.md`: add `?stickyRetail=` row (pattern:
   url-flags.md:276 A2-P1 row): documents that the Rust const must be flipped + pkg
   rebuilt, per the W2 flag convention.
2. NO JS behavior change for the local player (exclusion at loop.js:1887/:2158
   STAYS — rationale in Stage L1 step 2).
3. Optional diag: a `local_sticky_target() -> u32` wasm getter for the wire-agent
   assertion script. Diagnostic-only ⇒ **no `WASM_EXPORT_MANIFEST_VERSION` bump**
   (F18-2 policy: bump only for load-bearing exports). Manifest stays **3**;
   index.html `EXPECTED` stays **1** (index.html:1795-1803).

### Stage R2 — remote sticky parity (CONDITIONAL — only after A2-P2 lands)

Scope per A2 §4 P3: move the REMOTE glue into the same manager — radii-aware
standoff replacing the fixed 1.3 m (entities.js:211), heading turn, 1 s timeout
(closes A2 §3 row 3: "big mobs clip, small mobs float off; glued mob never times out
if the clear signal is missed; no facing").

- Hard dependency: A2-P2 `?remoteInterp=` remote bodies + per-frame remote pose
  export (W4, NOT landed at 048573d0). Without remote bodies there is nowhere
  Rust-side to run remote sticky on the wasm target (§2.4).
- Under `?stickyRetail=on`: loop.js routes the sticky target into the wasm remote
  body instead of `em.setStickyTarget`; entities.js glue (9198-9219) becomes the
  flag-off legacy path, UNTOUCHED otherwise (DESIGN.md:541 "F3-4 must not regress").
- Trigger stays the KIND_MOTION model_id ride-along until A13 provides a cleaner
  wire signal (A2 §4 P3 seam note).
- If A2-P3 is executed before P2 for the local-player ruling's sake, ship R1+L1+L3+J1
  and leave R2 as the recorded remainder — parity for the remote half is NOT lost
  (F3-4 keeps covering it).

Suggested commit slices: (R1) manager+tests → (L1+L3) wiring+tests → (J1) docs →
(R2) later. Commits hunk-selective per standing rule.

---

## 4. Test plan

### Headless-now (written with the change; run later under `capped-build`)

Unit — `position_manager.rs` tests module (extend the A2-P1 suite, world crate):
1. `adjust_offset` standoff math: radii-aware `cyl_dist_no_z − 0.3`; overshoot caps
   to `mag` (both signs — already-inside-standoff gives NEGATIVE mag → backs off;
   assert retail's `delta >= fabs(mag) → delta = mag` branch, acclient.c:388581-388588).
2. Speed model: `max_speed*5`, zero/absent → floor 15.0 (acclient.c:388569-388579).
3. Z always 0 in the returned step (:388557).
4. Heading: absolute heading toward target, negative-delta wrap equivalence to
   retail's `+360` (:388597-388600).
5. Timeout: `use_time` clears strictly after 1.0 s; `stick_to` re-arms it (:388688).
6. `handle_update_target`: guid mismatch ignored; pose stash flips initialized;
   no-op `adjust_offset` while uninitialized (:388691-388720).
7. Facade chain order interp→sticky→constraint and `USE_STICKY_MANAGER=false`
   byte-identical inertness (compile-time assert pattern, position_manager.rs:858).
8. Interp progress-test sticky exemption (:389243-389245): fail counter does not
   advance while sticky active.

Unit — `movement/system.rs` tests (extend the harness at system/tests.rs:3858+):
9. `SelfServerControlledMotion` Invalid with `sticky_object=Some` installs; `None`
   unsticks; non-Invalid movement types unstick (preamble subset).
10. `motion_done` one-shot → scene unstick fires (the A3-D2 hook, no longer no-op).
11. Step integration: with a stashed target pose, local pose converges to standoff
    and adopts the target heading within N ticks; airborne arm applies offset to the
    integrated pose (no jump-arc freeze).

`cargo check --target wasm32-unknown-unknown` via capped-build; `node --check` for
loop.js/entities.js only if R2 ships.

Wire-agent (laptop, no GPU — `?nullRender=1` MANDATORY, playwright chromium →
127.0.0.1:8765, pose getters read INSIDE page.evaluate per
reference_cloudflare_wire_agent_validation): after the batched wasm rebuild with the
const flipped on a scratch build — autoLogin → attack a training-academy target →
assert `local_sticky_target()` non-zero during the swing window and the local pose
getter's XY converges toward the target while heading faces it; then flag-off run →
pose trace byte-identical to pre-change capture.

### 1070-gated (→ the batched pending eye-test list; NOT a per-item step)

- Local melee-lock: player glues to the target during the swing, faces it, releases
  ≤1 s after the swing ends or on a fresh movement command; no rubberband against
  the server force-position heartbeat.
- F3-4 regression gate: remote kited melee mob still tracks (DESIGN.md:541, :588).
- Airborne-swing edge (OPEN Q5 verdict).
Run invisibly per the 1070 hard rule (off-screen/headless `:9333`).

---

## 5. Risks + rollback

| risk | why | mitigation |
|---|---|---|
| Client/server double-glue oscillation | ACE FastTick ALSO runs server-side sticky for the player (Player_Melee.cs:427) and force-position heartbeats may fight the client pull | Both gluing toward the same target should converge; the interp sticky exemption (R1 step 4) is retail's own anti-fight device. Eye-test gate; OPEN Q1/Q2. |
| Input fight during swing | sticky pulls XY while the player strafes; our integrator keeps consuming input | Retail-identical: sticky is an additive per-quantum offset capped at `mag`, not a position lock; 1 s timeout bounds it. Worst case = retail feel (that's the point). |
| Unstick clears a live MoveTo projection | ACE ClearTarget → `cancel_moveto` | Only clear the projection when sticky was actually active (Stage L1 step 3); covered by test 9. |
| Dual-site drift (native vs wasm) | the exact F2-3 failure class | Both installs specified (L1 steps 1-2); wasm install on the DEFAULT path, not gated by `?wireStatePacks`. |
| `system.rs` conflict with A3-D3/W4 | ROADMAP §3 conflict matrix | execute post-W4 or rebase; the spec touches system.rs in 2 bounded places (:1172, :2983-3020). |
| Z regression on slopes | none expected — sticky z is zeroed by construction (:388557) | unit test 3. |

Rollback: `USE_STICKY_MANAGER = false` (+ rebuild) restores byte-identical behavior;
`?stickyRetail` off restores the JS F3-4 glue for R2. F3-4 itself is never edited
until R2, and even then only behind the flag.

---

## 6. OPEN QUESTIONS

1. **Does ACE withhold the local player's UpdatePosition while the player is sticky**
   (the monster-side `Monster_Tick.UpdatePosition(false)` analog is cited for mobs,
   lib.rs:5291-5295 comment; no player-side citation found)? Determines heartbeat
   oscillation exposure. Resolve by wire capture on `~/ace-server`.
2. **FastTick value for players on our live server** (Player_Melee.cs:426 gates the
   server-side stick) — grep `~/ace-server` config/PropertyManager at execution time;
   affects whether the server pose moves with us or stays put.
3. **Client-side physics radius source** for `my_radius`/`target_radius`: retail uses
   `CPartArray::GetRadius` (setup-derived, scale-adjusted, acclient.c:319751-319760).
   Our best analog (setup sphere radius × obj_scale?) is uncited in our tree — locate
   or accept the cited `0.0` fallback (degrades standoff toward `−0.3`-clamped
   behavior; functional but not size-aware). The F3-4 fixed 1.3 m suggests no
   per-entity radius was readily available JS-side.
4. **`is_autonomous` on the player's own swing echo**: inferred `false` from the ACE
   `Motion` field default (~/ace-server Entity/Motion.cs:17-18; ctor never sets it),
   which makes the native install arm reachable (handlers/player.rs:100). Not
   single-stepped/captured. If a capture shows `true`, the native install must move
   to the message-level arm (the wasm install in L1 step 2 is unaffected either way).
5. **Airborne sticky**: retail applies sticky with no contact gate
   (acclient.c:388519-388601) but our airborne arm deliberately freezes interp
   adoption (system.rs:2996-3007 rationale). Spec says apply (threading the live
   pose); eye-test verdict may demote to grounded-only.
6. **Retail heading application equivalence**: retail writes a heading DELTA into the
   offset frame combined by `Frame::combine` (acclient.c:388593-388600, :320031); we
   adopt the absolute target heading. Mathematically identical for a single
   corrector, but constraint runs AFTER sticky in the chain and retail's constraint
   scales the whole offset frame (:389478-389512) — whether constraint scaling was
   ever meant to damp the sticky heading too is undecidable from the decomp (our
   plan: constraint scales XY only, heading adopted unscaled; flag for review).
