# 3D Camera & Movement — Game-Feel Comprehensive Fix

**Authored:** 2026-05-11 (post-WASD-debug session).
**Audience:** team of parallel agents picking up the 3D port from Phase 7.5+. Each workstream below is sized for a single agent; dependencies are called out so independent streams can run concurrently.
**Status:** planning doc. No code changes here. The current `apps/holtburger-web/scene3d/*` tree contains uncommitted JS-only workarounds from the debug session — **read them before deleting**.

---

## Context

### What this project is

Holtburger is a browser-playable Asheron's Call client. The 3D viewport landed across Phases 7.0 → 7.7 (commits `357e8ed` → `5bbbf54`) behind the `?renderer=3d` URL flag. The 2D PIXI path remains the default while the 3D path closes the parity gap.

**This is meant to be a game.** Specifically, a third-person action RPG with the look-and-feel of retail AC: a player you can see running around a populated world, a camera that follows them smoothly at 60 FPS, standard mouse-look, and movement that responds within a frame of input. Right now the 3D viewport is closer to "tech demo with controls" than "game". The comprehensive fix below closes that gap.

### Load-bearing reference docs (read these first)

- **`docs/3d-port-state-2026-05-10.md`** — canonical entry point for the 3D port. Lists what works, what's stubbed, every capture, every smoke check. Use this as the ground-truth state document.
- **`docs/emit-dynamic-site.md`** — long-lived design intent + decision history for the dynamic-site / 3D port effort. This document is **partially stale** (last refresh 2026-05-09, predates the symptom set this prompt addresses), but its *intent* is still the load-bearing reference: this is a game, not a static viewer. Treat its goals as the success criteria; treat its implementation specifics as historical context unless cross-confirmed with the current code.
- **`external/holtburger/HANDOFF.md`** — most recent operational handoff (ACE / wsbridge / cloudflared topology, disk warnings, recent restart notes).
- **`external/holtburger/ARCHITECTURE.md`** plus per-crate ARCHITECTURE.md files — module-level structure.

### Where we are coming into this work

A long debugging session on 2026-05-11 resolved several layered regressions and uncovered one structural issue. The session left behind a working 3D viewport with the following state:

**Working today:**
- `init3D` runs cleanly under `?renderer=3d`.
- The 3D scene builds: terrain, buildings, statics, EnvCells, lights, nameplates.
- Server-side movement works: WASD reaches ACE, every `MoveToState` is accepted, wasm-side simulation advances the player's pose at the integrator tick rate.
- A three-tier fallback in `getLocalPlayerWorldPos()` keeps the follow camera tracking the player's *position* (3D entityMap → 2D entityMap → `window.__lastEntityWorldPos` populated by the shared-drain hook).
- Null-pointer guards in `materials.js:323` and `adapter.js:330` silence the wasm-bindgen spam that fired for every NPC spawn.

**Broken / not-touched:**
1. **Position updates feel ratchety (~1 Hz).** The wasm side simulates at high frequency but emits `KIND_POSITION` updates for the local player only at heartbeat cadence (~1 Hz). The 3D path has no client-side prediction, so the camera jumps in 1-second steps.
2. **WASD lost camera-relative semantics.** The Phase 7.5 design was: press W → walk in the direction the camera is pointing, regardless of stored player heading (with an auto-turn-to-align that rotates the player toward the camera over ~300 ms). The session deleted that math and reverted to raw player-local-frame WASD (matching the 2D path) because the auto-turn needed a real player heading and `getLocalPlayerHeading()` always returned `0`. Functional but the wrong design.
3. **No local-player rig in the 3D scene.** The wasm eager-WorldState path on `SelectCharacter` swallows `ClientEvent::PlayerSpawned` (kind=1) and the `EntityUpdate::Spawn` for the player. The 3D `EntityManager` never builds a rig; the player is invisible.
4. **Camera clips into hills.** Holtburg's terrain has 8+ m vertical relief inside a single landblock. The follow camera lifts a fixed 8 m and otherwise lands wherever the math puts it. No collision against terrain or building meshes.
5. **Wasm side never exposes player pose or heading directly.** `SessionHandle` exports `getCurrentCellId()` and `isCurrentCellIndoor()` but nothing for `(x, y, z, heading)`. Every JS-side workaround in the session exists because of this hole.

### Why the session ended where it did

The JS-only patches landed make the 3D path usable as a debug surface, but the *root* fixes live in `apps/holtburger-web/src/lib.rs` (the wasm bundle) and require a `wasm-pack build` cycle. That build is heavy on the small laptop the session ran from (7.6 GiB RAM with active swap pressure), so it was deferred to this team-agent push on the desktop.

---

## Intent

The 3D viewport should match retail AC's feel at the game-feel layer:

- **W moves the player forward in the camera's facing direction**, not in their stored heading. The player visibly turns to face where the camera is pointing as they walk.
- **A/D strafe** relative to camera-facing.
- **Q/E manually turn** the player (legacy AC convention; layered over the auto-turn).
- **Mouse-look is standard FPS:** mouse-right → look right, mouse-down → look down, no inverted axes by default.
- **The camera tracks the player at 60 FPS**, no perceptible per-frame steps, no lag.
- **The camera doesn't clip** into hills or building walls; it slides forward toward the player when blocked, just like every modern third-person game.
- **A visible local-player rig** runs/walks/idles in the frame, oriented correctly, animated by the existing entity-rig path.
- **Teleports are clean** — the camera reorients to the new pose and the local rig snaps to the new location without glitching.

The session's stopgap (raw WASD + heading-blind tracking) is acceptable for one bug-hunt; it is not the bar. The bar is the bulleted list above. When all bullets are true, the 3D viewport graduates from "tech preview" to "real third-person game client".

---

## Objectives & workstreams

Six workstreams. Recommended parallelism: **A, C, and F start immediately**. **B can start with a fallback estimator**. **D and E unblock once A lands.**

### Workstream A — Wasm: emit local-player ClientEvents and EntityUpdates on the eager-WorldState path

**Owner profile:** Rust + wasm-bindgen, comfortable reading `tokio` / `futures` async flow.

**Problem.** When the wasm bundle processes `SelectCharacter`, it constructs `WorldState` eagerly and merges the subsequent `PlayerCreate`, `PlayerDescription`, and `ObjectCreate` packets in place. Side-effects of that merge are suppressed:

- `ClientEvent::PlayerSpawned` (kind=1) is not enqueued, so the 2D `drainEvents` at `index.html:5729` never sets `spawnedPlayerGuid` and never calls `setLocalPlayerGuid`. (Mitigation today: a safety-net in the kind=7 handler at `index.html:5782` was added but didn't fire reliably — needs re-verification post-A.)
- `EntityUpdate::Spawn` (KIND_SPAWN) is not enqueued for the local player. The 3D `EntityManager` has no rig for the player GUID; the 2D `entityMap` likely also has no entry. Every downstream consumer (camera follow, prediction, nameplate suppression, animation rig) breaks.
- `EntityUpdate::Position` (KIND_POSITION) for the local player *does* fire but only at heartbeat cadence (~1 Hz). The wasm-side integrator simulates at the tick rate; the JS side should see updates at the tick rate too.

**Files to edit:**
- `apps/holtburger-web/src/lib.rs` — the `recv_loop` async function and the `WorldState` eager-construction branch. Search for `WorldState constructed eagerly on SelectCharacter` to anchor.
- `crates/holtburger-session/src/lib.rs` — `EntityUpdate` definitions and the queue producer used by `recv_loop`.
- `crates/holtburger-world/` — `WorldState` itself, particularly `player_position()` and adjacent pose/heading accessors.

**Suggested approach:**
1. On `SelectCharacter`'s eager merge, enqueue the same `ClientEvent::PlayerSpawned` + `EntityUpdate::Spawn` that the non-eager path emits. Idempotent — if the non-eager path later catches up, drop the duplicate.
2. In the per-tick `TickMovement` publisher (currently feeding `cell_scene_snapshot`), also enqueue an `EntityUpdate::Position` for the local player with the latest authoritative pose. Throttle to ≤ 30 Hz so the entity-update queue doesn't flood.
3. Add a new `SessionHandle` export: `getLocalPlayerPose() -> Option<{x, y, z, heading}>`, reading from `world.player_position()`. Anchor near `getCurrentCellId` at `lib.rs:~7964`. This is the dependency Workstream D needs.

**Verification (must all be true):**
1. Fresh session. After login + character select + EnteredWorld, in browser console:
   ```js
   window.getLocalPlayerGuid()        // returns a non-zero u32, NOT null
   window.entityMap.has(0x50000007)   // true (test character)
   window.liveScene3d.entityManager.entityMap.has(0x50000007)  // true
   ```
2. Walking forward for 3 seconds, observe `window.__lastEntityWorldPos.get(0x50000007)` from `setInterval(..., 100ms)` console logs. Should see the position field change at ≥ 10 distinct values per second.
3. `window.__sessionHandle.getLocalPlayerPose()` returns a pose object that matches the wasm-side heartbeat trace's `pose=(x, y, z)` within ±0.1 m.

**Why.** Every JS-side compensation patched in tonight (`scene3d/entities.js` GUID-prefix fallback, `scene3d/loop.js` position-map stash, `index.html` kind=7 safety-net) exists because one of the above signals is missing. Restoring them lets us delete the workarounds, unblocks the 2D path's prediction tick (which gates on `entityMap.get(spawnedPlayerGuid)?.sprite`), and unblocks Workstreams D and E.

**Dependencies:** none upstream. Blocks D and E.

---

### Workstream B — JS: client-side prediction in the 3D camera tick

**Owner profile:** comfortable with `three.js` r184 + integrator math + the existing 2D prediction block at `index.html:6144-6207`. Read that block first.

**Problem.** Even with Workstream A increasing KIND_POSITION to 30 Hz, network jitter + the wasm internal tick rate (60+ Hz) mean the camera still lags. The 2D path solves this with client-side prediction: every rAF it advances `localEntry.sprite.x/y` based on key state, then reconciles when a fresh authoritative pose arrives. The 3D path must do the same.

**Files to edit:**
- `apps/holtburger-web/scene3d/camera.js` — the `tick(dt)` and `positionCamera` methods.
- `apps/holtburger-web/scene3d/entities.js` — `getLocalPlayerWorldPos()` returns the *predicted* pose, not the stashed pose.
- `apps/holtburger-web/scene3d/loop.js` — add a timestamp to each entry in `__lastEntityWorldPos` so prediction can measure staleness.

**Fix shape:**
1. Maintain `predictedPlayerPos = { x, y, z, lastReconcileTs }` in `cameraSwitcher` (or hang it off `liveScene3d`).
2. In `tick(dt)`, if WASD is held, advance `predictedPlayerPos` along the current intent vector:
   - With heading available (post-A): use the player's facing direction.
   - Without heading (interim): estimate from the last two `__lastEntityWorldPos` samples — the displacement vector is the heading.
   - Speed: `FALLBACK_RUN_RATE_SCALAR` (run) or `WALK_FORWARD_SPEED` (walk / Shift held). Constants live in `index.html` around the 2D prediction block.
3. When a fresh `__lastEntityWorldPos` update arrives:
   - Compute `delta = serverPose - predictedPos`.
   - If `|delta| > 5 m`: snap (it's a teleport or large reconcile).
   - Else: lerp `predictedPos` toward `serverPose` over the next 100–300 ms (small drift correction).
4. `getLocalPlayerWorldPos()` returns `predictedPlayerPos`, not the stashed map value.

**Constants to reuse (copy from index.html, don't redefine):**
- `WALK_FORWARD_SPEED`
- `FALLBACK_RUN_RATE_SCALAR`
- `RUN_HELD_TURN_SPEED_RAD_PER_SEC`
- `NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC`
- `SPRITE_HEADING_OFFSET`

**Verification:**
1. Hold W for 2 s. Camera glides smoothly at 60 FPS, no per-frame steps.
2. Hold W for 10 s. Predicted vs auth pose agree within ±2 m at all times (compare `predictedPos` to `__sessionHandle.getLocalPlayerPose()` after A lands).
3. Teleport between cities. Camera snaps cleanly to the new pose without glitching.
4. Stop walking. Predicted pose stops advancing within one rAF tick.

**Why.** This is the single biggest game-feel fix. Without it, the viewport never feels like a game regardless of how good everything else is. Smooth 60 FPS player tracking is table-stakes for a third-person action RPG.

**Dependencies:** standalone with the interim heading estimator; much better post-A.

---

### Workstream C — Camera collision against terrain + buildings + statics

**Owner profile:** comfortable with `three.js` `Raycaster` / sphere-cast and the existing terrain mesh structure.

**Problem.** `positionCamera()` puts the camera at `(player.xy - followYaw_vector * horizDist, player.z + vertDist + 8)`. On flat ground this is fine; on Holtburg's hills the camera buries into a slope or wall. The user's report: "i seem to be under a hill, from a camera perspective".

**Fix shape:**
1. After computing the *ideal* camera position, raycast (or sphere-cast with ~0.3 m radius) from the player's head (`player.xy, player.z + 1.6`) toward the ideal position.
2. Test intersection against `liveScene3d.terrainGroup`, `liveScene3d.buildingsGroup`, `liveScene3d.staticsGroup`, and any currently-visible cell in `liveScene3d.cellsGroup`.
3. If hit, place the camera at `hitPoint - smallEpsilon * direction` (pull camera in by ~0.2 m so it doesn't z-fight with the wall).
4. If no hit, use the ideal position. No behavior change on flat ground.

**Files:**
- `apps/holtburger-web/scene3d/camera.js` — `positionCamera`. Needs the scene3d reference (currently it has `_safePlayerPos` but not the geometry groups). Pass `scene3d` through in the constructor, or expose the groups on the cameraSwitcher.

**Verification:**
1. Walk into a hillside. Camera does not clip into the geometry; pulls in toward the player.
2. Stand against a building wall facing it. Camera pulls in to ~1 m from player; you can still see your character.
3. Open terrain: no behavioral difference from today.
4. Walking up and down a slope: camera height tracks the player smoothly, no jitter from the cast hitting different polys frame-to-frame (use sphere-cast not point-cast to mitigate).

**Why.** Camera occlusion is table-stakes for third-person. Without it the user can't reliably see themselves or the world ahead.

**Dependencies:** none. Standalone.

---

### Workstream D — Restore camera-relative WASD + auto-turn-to-align

**Owner profile:** read Phase 7.5 commit `88ed71a` and `5bbbf54` in `git log`, plus the comments in `apps/holtburger-web/scene3d/camera.js` lines ~432-545 (pre-session edit; recover from git history with `git diff` against the pre-session HEAD).

**Problem.** Today the 3D path sends raw WASD in the player's local frame (matching the 2D path). That works but loses the Phase 7.5 design where W means "walk where the camera is pointing" regardless of stored heading. The Phase 7.5 design needs a real player heading; before Workstream A, `getLocalPlayerHeading()` always returned 0 and the auto-turn produced inverted-looking controls after any teleport.

**Fix shape:**
1. Wire `getLocalPlayerHeading()` to `__sessionHandle.getLocalPlayerPose().heading` (new export from Workstream A). Fall back to the existing 3D rig quaternion read if pose is null pre-spawn.
2. Re-enable `computeMovementFromKeys()`'s world-frame rotation:
   - `worldDx = inputForward * sin(followYaw) + inputStrafe * cos(followYaw)`
   - `worldDy = inputForward * cos(followYaw) - inputStrafe * sin(followYaw)`
3. Rotate `(worldDx, worldDy)` into the player's *local* frame using the new authoritative heading, so the (forward, strafe) values passed to `setMovementInput` make ACE move the player in the user-intended (camera-frame) direction even before auto-turn aligns the heading.
4. Re-enable the auto-turn-to-align: emit `turn = sign(followYaw - playerHeading)` while WASD is held; ACE rotates the player ~3.5 rad/s; within ~300 ms the heading aligns.

**Files:**
- `apps/holtburger-web/scene3d/camera.js` — `computeMovementFromKeys`. The session's revert at this commit replaces the math with raw WASD; the pre-session form had the right shape but read a heading that was always 0.

**Verification:**
1. Teleport to a location where the player spawns facing south. Press W.
   - The player visibly rotates to face north (camera direction) within ~300 ms.
   - The player then walks north (camera-forward).
2. Walking, pan the mouse to look 90° left. The player auto-turns to match within ~300 ms.
3. Mouse-right → look right. Mouse-down → look down. Standard FPS.
4. Hold Q while walking. Manual turn overrides auto-turn; player turns left.
5. After auto-turn has aligned, no further `turn` deltas fire (`headingError < TURN_DEAD_ZONE`).

**Why.** This is the design the 3D port was built around. Raw WASD is the stopgap. The Phase 7.5 commit history (`88ed71a`) documents the intent extensively in the camera.js header comment block; refer to that block as the spec.

**Dependencies:** Workstream A.

---

### Workstream E — Render the local-player rig in the 3D scene

**Owner profile:** familiar with `scene3d/entities.js` `_spawnImpl` and the SetupModel / rig animation flow. Probably the same agent as Workstream A (overlapping wasm + scene3d work).

**Problem.** After Workstream A emits `EntityUpdate::Spawn` for the local player, the rig should build via the existing shared-drain hook. But: the 3D path may currently have a "hide own nameplate" or "skip local player rig" code path that overshoots (because pre-A, the local player wasn't in the entity stream at all, so any guard against rendering them was untested). Audit and confirm.

**Files:**
- `apps/holtburger-web/scene3d/entities.js` — `_spawnImpl`, `spawn`, `setPose`, and the nameplate-skip logic.
- `apps/holtburger-web/scene3d/loop.js` — the shared-drain hook `dispatchOne`.
- `apps/holtburger-web/scene3d/hud.js` — nameplate layer (`scene3d.nameplateLayer.skipGuid` or similar).

**Verification:**
1. After spawn, the local-player rig appears in the 3D scene at the player's pose.
2. Hold W: the run-cycle animation plays; the rig is oriented correctly (facing direction of motion).
3. The local player's nameplate is NOT drawn above the rig (retail convention — see `Phase 4 step 6e` reference at `index.html:5734-5735`).
4. Combat-mode toggle (\`) cycles stance; the rig's stance animation updates.

**Why.** A game where you can't see your own character is jarring. Mandatory for parity with retail AC's third-person view and a precondition for animations / equipment / emotes to be visible.

**Dependencies:** Workstream A.

---

### Workstream F — End-to-end Playwright verification capture

**Owner profile:** familiar with `playwright`. Read `apps/holtburger-web/capture_phase7_*.cjs` first; the new capture follows the same pattern.

**Problem.** The existing `capture_phase7_5_camera.cjs` uses synthetic key-state pokes against a mocked `setMovementInput`. It cannot catch the regressions hit during this session (init3D throw, listener-not-installed, cache-served-stale-JS, etc.). The codebase needs at least one capture that drives a *real* end-to-end session and asserts game-feel invariants.

**File to create:** `apps/holtburger-web/capture_3d_movement_e2e.cjs`.

**The capture should:**
1. Boot Chromium with `?renderer=3d`.
2. Fill the login form using selector `input[name="server_host"]` (NOT `server_ip` — that selector was renamed in commit `3954289`).
3. Log in as a test character (PK on tailnet `100.116.47.66`; coordinate with whoever holds creds).
4. Wait for `window.getLocalPlayerGuid()` to return non-null (≤ 5 s after spawn).
5. Assert `window.liveScene3d.entityManager.entityMap.has(playerGuid) === true`.
6. Dispatch real `keydown` for W; hold for 3 seconds.
7. Sample `__lastEntityWorldPos.get(playerGuid)` every 100 ms. Assert ≥ 15 distinct samples over the 3 seconds (i.e., position is updating > 5 Hz).
8. Assert the active three.js camera's `position` tracks the player's predicted position within ±15 m at every sample.
9. Release W; assert position stops advancing within 200 ms.
10. Confirm no `null pointer passed to rust` error fired in the console over the entire session.
11. Capture a screenshot at the end for visual inspection.

**Verification:** capture is green on a clean ACE session (post-restart).

**Why.** The debug cycle during the 2026-05-11 session (user pastes console → agent reads → agent patches → repeat) is unsustainable and costs the user real time. A green capture gates every future commit and surfaces regressions before they ship. Per the memory entry `feedback_ground_in_real_wire_data`: "capture wire packets + parse real DAT bytes BEFORE shipping holtburger-web parser/networking fixes; don't pile speculative changes".

**Dependencies:** ideally A–E for a meaningful green; can be developed in parallel against the current stopgap state and tightened as workstreams land.

---

## Grounding & resources (don't re-discover)

### Files and well-known locations

- **Wasm exports:** `apps/holtburger-web/src/lib.rs` — `SessionHandle` impl block. Anchor new exports near `getCurrentCellId` (line 7964) and `isCurrentCellIndoor` (line 8005).
- **`cell_scene_snapshot` publisher:** `lib.rs:9194` `publish_cell_scene_snapshot` — currently writes `current_cell` + `is_indoor` + `render_set`. Add pose fields here; expose via new `SessionHandle` getter.
- **2D entity map (page-global):** `window.entityMap` (set at `index.html:2430`).
- **Local player GUID (page-global):** `window.getLocalPlayerGuid()` / `window.setLocalPlayerGuid(guid)` (`index.html:2470-2471`, backed by closure variable `localPlayerGuid`).
- **3D live scene (page-global):** `window.liveScene3d` (set at `apps/holtburger-web/scene3d/index.js:~533`). Includes `cameraSwitcher`, `entityManager`, `terrainGroup`, `buildingsGroup`, `staticsGroup`, `cellsGroup`, `nameplateLayer`.
- **3D entity-update fanout:** `apps/holtburger-web/scene3d/loop.js` `installSharedDrainHook` → `window.__scene3dEntityHook` — the 2D drainEvents at `index.html:6033` forwards each `pollEntityUpdates()` batch here.
- **3D position stash (session workaround):** `window.__lastEntityWorldPos` — `Map<guid_u32, {x, y, z}>` populated in `loop.js:dispatchOne`'s KIND_POSITION branch. Used as fallback in `getLocalPlayerWorldPos()`. Delete this when Workstream A makes it redundant.

### Convention facts

- **Test character:** GUID `0x50000007` on the live tailnet ACE (test character PK). Player-tier GUIDs are `0x5xxxxxxx`. NPC GUIDs are `0x8xxxxxxx`. World-static GUIDs are `0x7xxxxxxx`. The `getLocalPlayerWorldPos` fallback scans for `0x5` prefix to find the player when `getLocalPlayerGuid()` returns null — that hack can be removed post-A.
- **World coordinates:** AC uses X east, Y north, Z up. Landblock IDs are 16-bit `(lbX, lbY)` packed into the high 32 bits of a 32-bit ID. World metres = `lbX * 192 + cellLocalX`, same for Y. Holtburg centre ≈ `(0xA9 * 192 + 96, 0xB4 * 192 + 96, ~80)` = `(32544, 34656, 80)`.
- **Heading convention:** `followYaw` in cameraSwitcher is clockwise from +Y north. `yaw = 0` → camera looks +Y. `yaw = π/2` → camera looks +X. The wasm side uses a quaternion; conversion lives at `index.html:2757-2762` (`quaternionToYaw`) and `entities.js:~810-830` (`getLocalPlayerHeading`).

### Build & test commands

- **Rust + wasm-pack (release, ~15 min cold):** `wasm-pack build apps/holtburger-web --target web --release`. For iteration: `--dev` is ~3 s. Outputs to `apps/holtburger-web/pkg/`.
- **Workspace cargo tests:** `cargo test --workspace` from repo root. Bar: 1222/0 (per `docs/3d-port-state-2026-05-10.md`). Don't regress.
- **JS smoke:** `apps/holtburger-web/smoke_test.cjs`. Bar: 146/0/1 (the SKIP is the live `start_session` round-trip). `--fast` runs the static-only subset (~100 checks).
- **Phase 7 captures:** `node apps/holtburger-web/capture_phase7_*.cjs` — all should remain green.
- **New e2e capture (Workstream F):** add to the matrix that smoke runs (or as a separate gate).

### Live stack

- **ACE:** UDP 0.0.0.0:9000. Log: `/mnt/wbterminal1/ace.log`. Restart procedure in `HANDOFF.md`. Binary: `~/ace-server/Source/ACE.Server/bin/Release/net10.0/ACE.Server.dll`. `dotnet` is NOT on PATH; use `/home/wbterminal/.dotnet/dotnet` with `DOTNET_ROOT=/home/wbterminal/.dotnet`.
- **wsbridge:** `apps/holtburger-wsbridge` — `holtburger-wsbridge --listen 0.0.0.0:8080`. Forwards WS → UDP 127.0.0.1:9000.
- **cloudflared:** quick tunnel `--url http://127.0.0.1:7080`. URL changes per restart; pull current from `HANDOFF.md` or whoever last restarted.
- **Web app:** node proxy `/tmp/holtburger_proxy.cjs` listening on 127.0.0.1:7080; serves the static `apps/holtburger-web/` files from a `python3 -m http.server 8765` backend.
- **Tailscale direct:** `100.116.47.66` (tailnet1 / Developer-promoted). Bypasses cloudflared.

### Memory & feedback discipline (load-bearing — read before deviating)

The user maintains an auto-memory at `/home/wbterminal/.claude/projects/-home-wbterminal/memory/MEMORY.md`. Relevant entries:

- **`feedback_test_fixtures_real_data`** — for AC/Holtburger work, use real `portal.dat` from the installer, not synthetic fixtures.
- **`feedback_ground_in_real_wire_data`** — capture wire packets + parse real DAT bytes BEFORE shipping parser/networking fixes; don't pile speculative changes.
- **`feedback_no_partial_demos`** — push back when you can't validate the actual goal. Say "I can't fully demonstrate this without X" instead of building a partial demo that bypasses the load-bearing path.
- **`reference_worldbuilder_terminal`** — for DAT/dungeon bugs, use `WorldBuilder.Terminal` first; skill at `~/.claude/skills/worldbuilder-terminal/skill.md`.
- **`project_holtburger_bake_disk_trap`** — never bake to `/` or `/tmp`; symlink `dist/` to `/mnt/wbterminal{1,2}`.
- **`project_holtburger_login_form_picker`** — capture scripts using `input[name="server_ip"]` are stale; use `input[name="server_host"]` (changed in commit `3954289`).
- **`project_holtburger_godmode_falldamage`** — persistent fall-damage bug; workaround `/god` or `/godly` admin command in capture scripts.
- **`project_holtburger_academy_landblock`** — AC Training Academy is LB `0x8602`, not Holtburg. Some capture-script labels are stale.

---

## Anti-patterns & out of scope

### Don't

- **Don't delete the session's JS workaround patches before Workstream A lands.** They're load-bearing for the current 3D path to do anything at all. Verify A's wasm exports, then prune the JS hacks in one commit and update `docs/3d-port-state-2026-05-10.md`.
- **Don't bypass load-bearing paths in tests or demos.** If Workstream F's capture needs live ACE, run live ACE; don't fake the server.
- **Don't mock the database.** ACE + real wire packets + real DATs only (per `feedback_test_fixtures_real_data`).
- **Don't bake or write to `/tmp` or `/`.** Use `/mnt/wbterminal1` or `/mnt/wbterminal2`.
- **Don't skip a `wasm-pack` rebuild after wasm-side changes.** The browser loads `pkg/holtburger_web.js` + `holtburger_web_bg.wasm`; stale binaries cause "works on my disk, broken in browser" mismatches.
- **Don't pre-rotate `worldDx/worldDy` to player local in JS until A exposes a real heading.** That was the trap the session fell into.

### Out of scope for this push

- Combat, spells, chat, inventory wiring. Movement and camera only.
- Mobile / cellular phone-validation. PK has a separate pass.
- Other-player pose interpolation. Workstream B addresses *local* prediction only; multiplayer prediction is a follow-on.
- Lighting / weather. Phase 7.6 landed lighting; not part of game-feel work here.
- Replacing the 2D PIXI default with 3D as the new default. That's a separate cutover commit gated on this entire prompt being green.

---

## Coordination

- **Parallel start:** A, C, F immediately. B with the interim heading estimator can join from day one.
- **Sync points:**
  - When A lands: B refactors to use real heading; D and E unblock.
  - When all six are green on Workstream F's capture: handoff commit + update `docs/3d-port-state-2026-05-10.md` "Phases landed" line to include "+ game-feel pass".
- **Handoff doc:** the last agent writes a successor to `HANDOFF.md` with new capture line numbers, removed JS workaround paths, and any open follow-ons.

---

## Definition of done

A clean session against a fresh ACE where, on the live cloudflared tunnel:

1. Login via standard form succeeds.
2. Within 5 s of EnteredWorld, the local-player rig is visible in the 3D viewport, oriented forward, framed by the follow camera.
3. Hold W for 5 s: smooth 60 FPS forward motion, camera follows fluidly with no steps or stutters, the rig visibly rotates to face the camera direction within ~300 ms.
4. Pan the mouse: standard FPS feel; player auto-turns to track.
5. Walk into a hillside: camera doesn't clip.
6. `@telepoi Holtburg` then `@telepoi Yaraq` (or any cross-continent teleport): camera reorients cleanly, no glitch.
7. `smoke_test.cjs` green at ≥ today's bar.
8. `cargo test --workspace` green at ≥ today's bar.
9. `capture_3d_movement_e2e.cjs` (Workstream F) green.
10. `docs/3d-port-state-2026-05-10.md` updated to reflect the new state; this prompt doc archived or marked complete.

When all ten are true, the 3D viewport graduates from "tech preview" to "real third-person game client". That's the bar.
