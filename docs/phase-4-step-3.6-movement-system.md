# Phase 4 Step 3.6 — Wire `MovementSystem` into the wasm bundle

> Status: planned — execution starts after sign-off on this doc.
> Created: 2026-05-07. Author: Claude.
> Sibling docs: `emit-dynamic-site.md` (overall project), `phase-4-renderer.md` (steps 1–4 as-built).

## 1. Problem

The wasm bundle's "WASD → server-side movement" loop is incomplete. The web client sends `MoveToState` on every keystate change but **never sends `AutonomousPosition`** — the heartbeat packet that carries the player's actual coordinates between motion-intent transitions. In retail AC, the *client* is authoritative for position; the server only knows where you are because you keep telling it via `AutonomousPosition` pulses.

Symptoms validated 2026-05-07:
- Every saved character in `ace_shard.biota_properties_position` (`position_Type=1`, "Location") sits at the exact `@telepoi Holtburg` landing point `0xA9B40019, (84.0, 7.1, 94.0)` — 18+ test characters across 9–10 minute sessions, none moved server-side.
- No monsters / combat / death messages, because encounter generators in `0xA8B3` (7 enc), `0xA9B3` (3), `0xAAB3` (6) etc. only activate when *server*-you enters those landblocks via vision range.
- ~30 s `Network Timeout` disconnects in `/tmp/ace.log` — without periodic outbound pulses ACE drops the session.
- JS-side rAF prediction (`index.html:3404–3457`) advances `localEntry.sprite.x/y` so the screen looks fine, but it's a lie.

Diagnosis confirmed in `lib.rs` and the cli's `crates/holtburger-core/src/client/movement/system.rs`:
- Web sends `MoveToState` on input change at `lib.rs:5002–5026` (gated by `sig !== lastInputSig` at `index.html:3472`).
- Web has **zero** references to `AutonomousPosition`.
- Cli has full heartbeat machinery: `arm/refresh/maybe_send_autonomous_position_heartbeat`, `AUTONOMOUS_POSITION_HEARTBEAT_INTERVAL` at `system.rs:132, 242, 250, 493, 858–911`.

## 2. Goal

Replace the web bundle's hand-rolled movement send path with the cli's `MovementSystem`, ticked from a wasm-driven loop. Outcome:

- Browser holding W → continuous outbound `MoveToState` + `AutonomousPosition` packets → ACE updates server-side player position → adjacent landblocks load via vision → encounter generators fire → `ObjectCreate(Creature)` packets stream back → entity buffer renders monsters → walking into a creature triggers combat → chat panel shows damage / death lines.

Single source of truth for movement in cli + web. Phase 4 step 3 actually complete.

## 3. Architecture decisions

Picked **option (a)** over option (b) (port a stripped-down heartbeat into `lib.rs`). Rationale: option (b) is 0.5–1 day to make monsters appear but duplicates a chunk of cli logic. Option (a) is 6–7 days to do it right with one shared movement system.

Four sub-decisions confirmed by user 2026-05-07:

1. **Bootstrap path: Path 4-B (real assets via `ContentRepository`).** Bring up the real `WorldBootstrap` in 3.6 itself — load the 5 game-data tables from existing wasm-clean `ResourceSource` mounts (HTTP from Phase 2 + dat shards from Phase 3). Adds ~1 d to step 4 over the synthetic alternative but ships fully-correct movement physics in one step instead of conflating with a 3.7 follow-on.
2. **API exposure: `MovementSystemHandle` shim.** Cli's `MovementSystem` stays `pub(crate)`. Add a curated facade at `crates/holtburger-core/src/client/movement/handle.rs` that wraps a `MovementSystem` and exposes only the four methods the web needs. Cleaner boundary; cli internals can evolve without breaking the web.
3. **Smoke harness: extend `smoke_test.cjs`.** Add a movement e2e step that drives the §6 protocol against a live ACE so regressions surface automatically.
4. **Memory note: acknowledge step 3 was incomplete.** Update `project_emit_dynamic_site.md` to record that Phase 4 step 3 shipped without the AutonomousPosition heartbeat and that 3.6 is the corrective step. Future sessions get the diagnostic context.

Wasm32-cleanliness verification 2026-05-07: `ContentRepository::from_mounts(Vec<Arc<dyn ResourceSource>>)` (`crates/holtburger-content/src/repository.rs:75`) is wasm-clean. The blocking constructors `from_hba_path` / `from_hba_dir` (`repository.rs:30, 57`) use `std::fs` but we don't need them — `from_mounts` accepts our existing `HttpResourceSource` and shard-based sources directly.

## 4. Surface inventory (from explore-agent audit)

### 4.1 `MovementSystem` API

`crates/holtburger-core/src/client/movement/system.rs:121` — `pub(crate) struct MovementSystem`. Critical methods:

| Method | Signature | Async | Notes |
|---|---|---|---|
| `new()` | `fn() -> Self` | no | `system.rs:207` |
| `enqueue_drive_intent` | `fn(&mut self, PlayerDriveIntent, Instant)` | no | `system.rs:255` — appends to `queued_drive_commands` |
| `arm_autonomous_position_heartbeat_schedule` | `fn(&mut self, Instant, &WorldState)` | no | `system.rs:242` — primes the heartbeat timer; call once on EnteredWorld |
| `tick` | `async fn(&mut self, Instant, &mut WorldState, &mut Session) -> Result<Vec<WorldEvent>>` | yes | `system.rs:382–502` — runs the full reconcile / drive / pulse cycle and awaits sends |

`PlayerDriveIntent::ManualHeld(MotionState)` is the WASD held variant (`movement_types.rs:152–166`). `MotionState` is the high-level enum (`gait` + optional `locomotion` + optional `turn`); cli uses a builder pattern (e.g. `MotionState::builder().run().forward().build()`). The web's `build_raw_motion_state_for_input(forward, strafe, turn, run)` at `lib.rs:3964–4031` produces `RawMotionState` (wire format) — a **conversion gap** the plan addresses.

### 4.2 `WorldState` shape and construction

`crates/holtburger-world/src/state/types.rs:46–62`. Movement reads:
- `world.player.{guid, instance_sequence, server_control_sequence, teleport_sequence, force_position_sequence, last_server_motion_style, last_server_grounded}` — direct field access.
- `world.local_player_runtime_pose()` / `set_local_player_runtime_pose(pose)` — spatial body queries.
- `world.scene.body(SpatialBodyId::LocalPlayer(guid))` — kinematics.
- `world.player_run_rate()`, `world.resolve_self_movement_capabilities()` — tables.
- `world.runtime_body_view(...)` — contact state.

Untouched by movement (can be `None` / empty): `vendor`, `fellowship`, `trade`, `open_containers`, `entity_lifecycle`, `self_movement_capabilities_override`.

Constructors:
- `WorldState::new(Arc<WorldBootstrap>) -> Self` — `types.rs:372`. Public.
- `WorldState::new_with_spatial_physics(Arc<WorldBootstrap>, Arc<dyn SpatialPhysics>) -> Self` — `types.rs:376`. Public.
- `WorldBootstrap::synthetic()` exists but is `#[cfg(test)]`-gated — needs `feature = "test-support"` to expose to web (or a public wrapper).

`WorldBootstrap::new(skill_table, spell_table, xp_table, motion_kinematics, soul_emote_catalog)` (`crates/holtburger-world/src/bootstrap.rs:7–15`) takes 5 parsed assets. Cli loads them via `ContentRepository::read_asset(...)` (`crates/holtburger-core/src/client/builder.rs:54–80`). The wasm bundle has dat access via `holtburger-dat` + `HttpResourceSource` from Phase 2/3, but does not yet bring up a `ContentRepository`.

### 4.3 Inbound packet routing (cli reference)

`crates/holtburger-world/src/handlers/movement.rs:27–117` — the dispatcher matched in `routing.rs:21` from `WorldState::handle_message(&GameMessage)` (called by `client/messages.rs:137`).

| Packet | Cli handler call | Mutates |
|---|---|---|
| `UpdatePosition` | `state.set_player_position(pos)` (player) or `state.apply_entity_position_pack(guid, pos, events)` (other) | All 4 sequences via `entity.apply_server_position_update` (`entity.rs:337–376`) |
| `PrivateUpdatePosition` | `state.apply_private_position_update(position_type, pos, events)` (`mutations.rs:545`) | Player position when `PositionType::Location`; non-Location → overlay |
| `PublicUpdatePosition` | `state.apply_public_position_update(guid, position_type, pos, events)` (`mutations.rs:706`) | Position only; no sequence updates |
| `AutonomousPosition` | `state.apply_player_autonomous_position(data)` (`mutations.rs:698–701`) | All 4 sequences direct field writes |

Web today (`lib.rs:4295–4415`) handles `UpdatePosition`/`Private`/`Public` inline into a thin `LocalPlayerSnapshot` struct (`lib.rs:4052–4071`). It **does not track `position_sequence` or `server_control_sequence`** — gap to fix.

Race story: cli's `tokio::select!` (`runtime.rs:140–204`) is single-threaded; recv-message arm fully completes before physics-tick arm runs. Web must replicate this ordering.

### 4.4 Web bundle integration points

| Concern | Location | Today | Plan |
|---|---|---|---|
| `LocalPlayerSnapshot` | `lib.rs:4052–4071` | inline struct in recv loop | replace with `WorldState` |
| Recv loop | `lib.rs:4074–5032` | `tokio::select!` over `session.recv_message()` + `cmd_rx.next()` | route inbound through `WorldState::handle_message`; add tick arm |
| `SessionCommand` | `lib.rs:2749–2810` | 4 variants: SelectCharacter, CreateCharacter, SendChat, SetMovementInput | `SetMovementInput` becomes a `MovementSystem::enqueue_drive_intent` call |
| Position handlers | `lib.rs:4295–4415` | manual into LocalPlayerSnapshot + push EntityUpdate | call `world.handle_message(...)`; emit EntityUpdate from WorldEvent stream |
| `build_raw_motion_state_for_input` | `lib.rs:3964–4031` | produces wire format directly | replace with `MotionState::builder()...`; cli's `build_motion_state_raw_motion_state` is invoked inside `MovementSystem::tick` |
| JS rAF tick | `index.html:3227–3487` (`drainEvents`) | drains events, runs JS prediction, sends input on change | add `handle.tickMovement(performance.now())` after housekeeping (line 3379), keep prediction |
| `web_time::Instant` | `holtburger-session` (already), `holtburger-core` (partial) | `Session::last_send_time/last_recv_time` already adopted | extend to MovementSystem + WorldState hot fields |

### 4.5 Time-shim landscape

| Crate | `std::time::Instant` sites | Notes |
|---|---|---|
| `holtburger-core/src/client/movement/system.rs` | 14+ (lines 21, 132, 162, 166, 244, 250, 255, 283, 312, 384, 685, 699, 730, 770, 804, 827, 860, 897) | All hot path |
| `holtburger-core/src/client/runtime.rs` | several, but already compares with `web_time::Instant` via `.elapsed()` (lines 11–13, 118–120) | Pattern established |
| `holtburger-world/src/state/types.rs` | lines 26 (ServerTimeSync field), 267 (param) | Hot path for movement |
| `holtburger-world/src/state/mutations.rs` | lines 15, 53 (`Instant::now()`), 260 | Hot path |
| `holtburger-world/src/spatial/scene.rs` | lines 11, 79, 162, 173, 218, 245, 274, 344, 352 | Spatial bookkeeping |
| `holtburger-world/src/spatial/types.rs` | lines 4, 73, 74, 152, 161, 165 | SpatialBody / SpatialSamplingState fields |
| `holtburger-session` | already on `web_time::Instant` | No work |

`web-time = "1"` is in workspace deps (used by `holtburger-session`); migration is a type-swap, not a behavior change. `Instant::now()` → `web_time::Instant::now()`. `.elapsed()` works on both. `duration_since(other)` requires both sides to be the same type.

## 5. Plan, in order

Each step is a discrete commit. Run `cargo check --target wasm32-unknown-unknown -p holtburger-web` and `cargo test -p holtburger-world -p holtburger-core` after each.

### Step 1 — `MovementSystemHandle` shim in `holtburger-core`
**Cost:** 0.5 d. **Risk:** low.

Create `crates/holtburger-core/src/client/movement/handle.rs` with a `pub struct MovementSystemHandle` that wraps an internal `MovementSystem`. The shim is the only thing the web bundle imports from the movement module — `MovementSystem` itself stays `pub(crate)`.

```
pub struct MovementSystemHandle { inner: MovementSystem }

impl MovementSystemHandle {
    pub fn new() -> Self
    pub fn enqueue_drive_intent(&mut self, intent: PlayerDriveIntent, now: web_time::Instant)
    pub fn arm_heartbeat_schedule(&mut self, now: web_time::Instant, world: &WorldState)
    pub async fn tick(&mut self, now: web_time::Instant, world: &mut WorldState, session: &mut Session) -> Result<Vec<WorldEvent>>
}
```

Add `pub mod handle;` and `pub use handle::MovementSystemHandle;` in `client/movement/mod.rs`. Cli internals (`current_local_drive_control`, `note_server_controlled_movement_started`, the simulation-side `pub(crate)` API) stay private. The cli's existing call sites continue to use `MovementSystem` directly — no churn there.

**Gate:** `cargo check -p holtburger-core --target wasm32-unknown-unknown` passes; cli still compiles unchanged (`cargo build -p holtburger-cli`).

### Step 2 — Add `web-time` to `holtburger-web`
**Cost:** 0.25 d. **Risk:** none.

- Add `web-time = { workspace = true }` to `apps/holtburger-web/Cargo.toml` `[dependencies]`.
- No code changes yet — preparing for Step 3.

### Step 3 — Migrate `Instant` → `web_time::Instant` in the hot path
**Cost:** 1 d. **Risk:** medium (compile-error cascade, easy to chase).

Approach: bottom-up, one crate at a time. Each substep ends green on `cargo check --target wasm32-unknown-unknown`.

1. `holtburger-world/src/spatial/types.rs` — `SpatialBody.{last_authoritative_update, last_derived_at}` fields, all `new*` constructors. 6 sites.
2. `holtburger-world/src/spatial/scene.rs` — every `now: Instant` parameter becomes `web_time::Instant`. 9 sites.
3. `holtburger-world/src/state/types.rs` — `ServerTimeSync.local_time`, `set_server_time_sync` parameter. 2 sites.
4. `holtburger-world/src/state/mutations.rs` — `Instant::now()` calls + propagation. 3 sites.
5. `holtburger-core/src/client/movement/system.rs` — every `Instant` reference. 14+ sites.
6. `holtburger-core/src/client/movement/common.rs` — verify nothing leaks.
7. `holtburger-core/src/client/runtime.rs` — `physics_tick` uses `tokio::time::interval` which is already `web_time` compatible per the existing comment; spot-check.
8. `holtburger-core/src/client/runtime_body_view_cache.rs` and `simulation.rs` — anywhere `Instant` is passed to/from `MovementSystem`.

**Gate:** `cargo check -p holtburger-world -p holtburger-core --target wasm32-unknown-unknown` passes; existing native test suite (`cargo test -p holtburger-core -p holtburger-world`) passes unchanged (`web_time::Instant` on native is a `std::time::Instant` re-export).

### Step 4 — Real `WorldBootstrap` via `ContentRepository::from_mounts` (Path 4-B)
**Cost:** 2 d. **Risk:** medium.

The wasm-clean entry point is `ContentRepository::from_mounts(Vec<Arc<dyn ResourceSource>>)` (`crates/holtburger-content/src/repository.rs:75`). Skip `from_hba_path` / `from_hba_dir` — they use `std::fs` and aren't reachable on wasm32.

Substeps:

1. **Resource source inventory.** The web bundle has two `ResourceSource` impls today: `HttpResourceSource` (Phase 2, fetches over HTTPS) and the dat-shard backed source (Phase 3 step 6). Confirm both implement `ResourceSource` cleanly and either can satisfy the 5 asset reads. Most likely a single mount (the existing one in `lib.rs` for Holtburg rendering) will already serve them.

2. **Asset key audit.** The 5 assets are `SkillTable`, `SpellTable`, `XpTable`, `MotionKinematics`, `ChatPoseTable` (which `read_soul_emote_catalog` parses internally). Each has a `StaticResourceKey` impl in `holtburger-dat`. Confirm the keys map to file IDs that exist in `client_portal.dat` and are present in our Phase 3 shards.

3. **Add deps to `apps/holtburger-web/Cargo.toml`:** `holtburger-content = { workspace = true }` and `holtburger-world = { workspace = true }`.

4. **Wasm-bindgen export `boot_world_state(...)` on the session handle.** Inside `lib.rs`: build a `ContentRepository::from_mounts(vec![Arc::clone(&self.resource_source)])`; mirror cli's `ClientRuntimeBuilder::load_assets` (`crates/holtburger-core/src/client/builder.rs:54–80`) to load the 5 assets; construct `Arc::new(WorldBootstrap::new(skill, spell, xp, motion, soul_emote))`; then `WorldState::new(bootstrap)`. Returns once on `EnteredWorld`.

5. **Plumb through the recv-loop borrow.** WorldState lives in the recv loop's stack frame (added in Step 5); the boot fn mutates it once at the EnteredWorld arm.

**Gate:** browser console: `[boot] WorldState constructed: skill_table_size=N spell_table_size=M motion_kinematics_size=K`. No panics. wasm32 build clean.

**Fallback if a specific asset isn't reachable in our shards:** log which one, fall back to `WorldBootstrap::synthetic()` for that field only via a thin local builder. Don't block 3.6 on a single missing resource — surface it as a 3.7 ticket. (Synthetic is `#[cfg(any(test, feature = "test-support"))]`-gated; enable `holtburger-world/test-support` on the web's dep line if we hit this case.)

### Step 5 — Wire `WorldState` into `lib.rs` recv loop
**Cost:** 1 d. **Risk:** medium.

- Replace `LocalPlayerSnapshot` field of `recv_loop` with `world: WorldState`.
- On `kind=7 EnteredWorld`: set `world.player.guid = player_guid`, `world.add_entity(Entity::new(player_guid, name, spawn_pose))`, `world.set_local_player_runtime_pose(spawn_pose)`. Then `movement.arm_autonomous_position_heartbeat_schedule(now, &world)`.
- Replace inline position handlers at `lib.rs:4295–4415` with `let events = world.handle_message(&msg).await?; for ev in events { … emit EntityUpdate / ClientEvent as needed }`. The existing `EntityUpdate` JS-bound payload remains the rendering contract; build it from `WorldEvent::EntityVectorUpdated` etc.
- Add `position_sequence` and `server_control_sequence` to outbound `MoveToState` reads — they already exist on `world.player`.

**Subtle:** the web's existing position handlers also push EntityUpdate for *other* entities (not just local player). When porting, route those via `world.handle_message` too (the cli already does — `apply_entity_position_pack` etc. emit `WorldEvent::EntityVectorUpdated`).

**Gate:** smoke `entityMap` still renders the local player + NPCs at the correct world coords after spawn. No regression on the chat panel.

### Step 6 — Replace `SetMovementInput` handler with `enqueue_drive_intent`
**Cost:** 0.5 d. **Risk:** low.

- `lib.rs:4964–5027` currently builds `MoveToStateActionData` directly. Replace with: convert `(forward, strafe, turn, run)` → `MotionState` via `MotionState::builder()...build()` → `movement.enqueue_drive_intent(PlayerDriveIntent::ManualHeld(state), now)`.
- Delete `build_raw_motion_state_for_input` (`lib.rs:3964–4031`). The cli's `build_motion_state_raw_motion_state` (called inside `MovementSystem::tick`) replaces it.
- Keep the `enteredWorld` gate (`lib.rs:4994`) — drop early keystrokes.

**Gate:** pressing W still produces a `[step3-trace] MoveToState send_action OK` console line (or its equivalent under the new path).

### Step 7 — Add the tick driver
**Cost:** 0.5 d. **Risk:** medium (timing semantics).

- Add `SessionCommand::TickMovement { now: web_time::Instant }` variant.
- Recv loop arm: `Some(SessionCommand::TickMovement { now }) => { let _events = movement.tick(now, &mut world, &mut session).await?; … }`.
- Wasm-bindgen export: `pub fn tick_movement(&self) { let now = web_time::Instant::now(); self.cmd_tx.unbounded_send(SessionCommand::TickMovement { now }).ok(); }` on the Session handle.
- `index.html:3380` (after `tickEntityAnimations()`, before the prediction block) add `try { handle.tickMovement(); } catch (_) {}`. rAF cadence (~16 ms) is well under the cli's 50 ms physics tick — fine.

**Why through the cmd channel:** keeps the `&mut world` and `&mut session` exclusivity that `MovementSystem::tick` needs. Direct call from JS into the wasm-bindgen handle would race with the recv loop's own borrow.

**Gate:** browser console shows continuous `[heartbeat]` log lines (add a `log::trace!` inside `maybe_send_autonomous_position_heartbeat`) every ~250 ms while W is held. UDP packet counters (`/proc/net/snmp` `OutDatagrams`) climb visibly.

### Step 8 — JS prediction reconciliation
**Cost:** 0.25 d. **Risk:** low.

The JS rAF prediction at `index.html:3404–3457` is independent of `MovementSystem` and continues to run. After Step 7, `PrivateUpdatePosition` packets start flowing back from the server with corrected positions, and the existing reconciliation path (`handlePositionUpdate(upd)` snapping `localEntry.sprite.x/y`) takes over rubber-banding. Nothing to change — but verify visually that prediction + reconciliation feel smooth.

**Gate:** holding W in the browser produces visibly continuous motion (no rubber-band jumps > 1 m/s) for 30 s.

### Step 9 — Validation: walk into wilderness, observe encounters; smoke harness extension
**Cost:** 1 d (was 0.5 d before smoke extension). **Risk:** none — this is the proof.

The test the user already articulated: "if I really am running, I should eventually die." Concrete protocol:

1. From browser, log in, spawn, `@telepoi Holtburg`.
2. Press and hold W (or S — south is `0xA9B3` with 3 encounters; SW is `0xA8B3` with 7).
3. Watch:
   - **Server-side proof:** `mysql ace_shard "SELECT origin_X, origin_Y, obj_Cell_Id FROM biota_properties_position WHERE object_Id = <player_guid> AND position_Type = 1"` — coordinates change away from `(84.0, 7.1, 94.0)`, cell changes to `0xA9B3*` or `0xA8B3*`.
   - **Encounter spawn:** `/tmp/ace.log` shows `Loading landblock 0xA8B3FFFE…` (or similar) followed by `WorldObjectFactory.CreateNewWorldObject` for creature weenies.
   - **Client receives them:** browser console / chat panel shows `ObjectCreate` events for creatures; sprites appear in the entity map.
   - **Combat:** if the creature is hostile (most outdoor mobs are), chat panel "Combat" tab shows damage lines; eventually a "death" line.
4. Bonus: session no longer drops at 30 s — heartbeats keep ACE happy.

**Smoke harness extension.** Add a new step to `external/holtburger/smoke_test.cjs`:
- Boot wsbridge + ACE (existing harness setup).
- Drive the wasm bundle through login → spawn → `@telepoi Holtburg`.
- Hold W (simulated via `handle.setMovementInput(1, 0, 0, true)`) for 30 s while ticking.
- Poll `mysql ace_shard biota_properties_position` for the player's GUID; assert `origin_X` or `origin_Y` differs from the spawn point by > 5 m, OR `obj_Cell_Id` differs from `0xA9B40019`.
- Assert at least one `ObjectCreate(weenie_class_Id ∈ creature_class_ids)` was observed in the entity buffer.
- Pass if both assertions hold.

This step is the regression guard for any future refactor of recv-loop, prediction, or movement-system internals.

If any in-browser assertion fails, the wire is still wrong; debug before declaring 3.6 done.

## 6. Validation criteria

| # | Test | How |
|---|---|---|
| 6.1 | Server-side position changes | shard DB query (§9.3 above) |
| 6.2 | `AutonomousPosition` packets visible on the wire | tcpdump-equivalent: `ss -unp` shows UDP traffic on 9001; `OutDatagrams` in `/proc/net/snmp` climbs |
| 6.3 | Encounter creatures spawn into entity buffer | browser entity map shows new sprites with `wcid` matching `ace_world.encounter.weenie_class_Id` for the entered landblock |
| 6.4 | Combat / death messages | chat panel "Combat" tab populates; player dies; `kind=4 Disconnected` does NOT fire (death ≠ network drop) |
| 6.5 | Session lifetime > 5 min | wsbridge log shows long-lived connections, not 30-s `Network Timeout` cycles |
| 6.6 | Native test suite green | `cargo test -p holtburger-core -p holtburger-world -p holtburger-web` |
| 6.7 | Smoke harness green | smoke 61/61 (current count per memory) → smoke 62+/62+ with a new movement e2e step |
| 6.8 | wasm32 build + wasm-pack | `cargo check --target wasm32-unknown-unknown -p holtburger-web`, `wasm-pack build --target nodejs|web` clean |

## 7. Risks

### 7.1 An asset key isn't reachable from existing wasm-side `ResourceSource` mounts
Path 4-B reads 5 assets via `ContentRepository::from_mounts`. If one of them (likely `MotionKinematics` or `ChatPoseTable`) isn't in the resources our Phase 3 pipeline shards, asset load fails.

Mitigation: surface the failing key, fall back to `WorldBootstrap::synthetic()` for that field only (enabling `holtburger-world/test-support` on the web's dep line), and open a 3.7 ticket to extend the shard pipeline. The fallback preserves the wire-level fix (which is the actual point of 3.6) at the cost of approximate physics for the affected subsystem.

### 7.2 `Instant` migration cascades into types we haven't surveyed
Mitigation: do Step 3 bottom-up (world → core); each substep is its own commit. If a hidden consumer breaks, revert that substep only.

### 7.3 Wasm bundle size jumps from importing more of `holtburger-world`
Mitigation: profile post-port. The world crate is already in the dep graph transitively; we're just exercising more of it. If size becomes a problem, defer to Phase 5.2 (manifest scale fix already on the docket).

### 7.4 Tick borrow contention (Step 7)
The `tick()` method needs `&mut WorldState` and `&mut Session`. The recv loop also holds these. Routing the tick through the same `cmd_tx` channel as other commands serializes access — that's the design. Risk if I try to expose `tick_movement` directly as a wasm-bindgen export with internal locking.

### 7.5 JS prediction divergence post-port
The existing prediction in `index.html:3435–3452` uses planar kinematics that may not match the cli's `local_velocity_for_state` once `MotionKinematics` is real (Path 4-B). Under synthetic, divergence is fine — prediction is just a smoothing layer over server reconciliation.

### 7.6 `MotionState` builder output not byte-identical to current `RawMotionState`
The cli's `build_motion_state_raw_motion_state` output may differ from `build_raw_motion_state_for_input`'s output. Spot-check the wire bytes for "press W, no run" before/after Step 6 — diff the `RawMotionState` value. If different, decide whether the cli's version is correct (likely yes) or whether ACE accepts both.

## 8. Out of scope for 3.6

- Combat damage simulation (server-authoritative; only the *display* of combat lines is in scope here).
- Dying / lifestone respawn behavior in the JS layer (the wire side will work; UI may need a follow-on).
- Generalized non-player entity prediction (cli's `simulation.rs` work).
- Server-controlled motion (`MovementSystem::set_server_controlled_projection`) — cli has it for portal animations etc., out of scope for 3.6.
- Pipeline work to extend dat-shard coverage if §7.1 fallback trips (becomes 3.7).

## 9. Decisions log (resolved 2026-05-07)

| # | Question | Decision |
|---|---|---|
| 1 | Bootstrap path | **Path 4-B: real assets via `ContentRepository::from_mounts`** in 3.6 itself. Adds ~1 d but ships fully-correct movement physics in one step. Fallback to per-asset synthetic (§7.1) if shard coverage is incomplete. |
| 2 | API exposure | **`MovementSystemHandle` shim** in `holtburger-core::client::movement::handle`. `MovementSystem` stays `pub(crate)`; web sees a curated facade with 4 methods. |
| 3 | Smoke harness | **Extend `smoke_test.cjs`** with a movement e2e step (§5 step 9). Locks in regression protection. |
| 4 | Memory update | **Update `project_emit_dynamic_site.md`** to note that step 3 shipped without `AutonomousPosition` heartbeat and 3.6 is the corrective step. Done as part of 3.6 sign-off. |

## 10. Effort summary

| Step | Cost |
|---|---|
| 1 — `MovementSystemHandle` shim | 0.5 d |
| 2 — `web-time` dep on `holtburger-web` | 0.25 d |
| 3 — `Instant` → `web_time::Instant` migration | 1 d |
| 4 — `WorldBootstrap` via `ContentRepository::from_mounts` (Path 4-B) | 2 d |
| 5 — Wire `WorldState` into recv loop | 1 d |
| 6 — Replace `SetMovementInput` with `enqueue_drive_intent` | 0.5 d |
| 7 — Tick driver via `cmd_tx` | 0.5 d |
| 8 — Prediction reconciliation verification | 0.25 d |
| 9 — Validation + smoke harness extension | 1 d |
| **Total** | **~7 d** |
