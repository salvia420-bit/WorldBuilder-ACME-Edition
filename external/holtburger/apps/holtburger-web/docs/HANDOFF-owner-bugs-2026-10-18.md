# HANDOFF — owner bug batch, 2026-10-18 (downhill hop, floating spawns, melee range, sneak cue, motes / self shortcut / kits)

The owner reported seven issues after a play session. Five Opus 5.5 agents worked them in parallel, one per file-disjoint
lane, each in its own worktree (`/mnt/wbterminal1/wt/ob-<lane>`). Each consulted the retail decomp, ACE, WebAC and
OpenAC (one lane found no OpenAC checkout and relied on the decomp and WebAC). Agents ran targeted node tests only. The
orchestrator compiled and tested all Rust, one capped job at a time, merged the lanes in an integration worktree,
built the release wasm once and ran the gate once (§7). **Nothing here has been eye-tested**; the queue is in §6.

## 1. The owner's report (verbatim)

> there is still a bug in holtburger web where we will be running along, usually down a little hill or something, and
> we do a little jump. i also noticed while playing today that some monsters spawned up in the air while they were on
> a hill. another seperate issue for a 5.5 agent, when attacking monsters with a melee weapon, sometimes it will attack
> them when they are too far away to attack. another issue for another 5.5 agent, i see a sneak attack popup occur
> which should be moved into the combat HUD. also i tried to join two pyreal motes together in my inventory and
> couldn't, and i could drag my main pack from my inventory to the hotkey 1 (this is used to help you select yourself,
> so if you had a healing kit in hotkey 2 and your main inventory pack in hotkey 1, if you pressed 2 and then 1, you
> would heal yourself. i noticed that healing kits told me to select something but when i pressed them on my
> character, it didn't heal me. for each of these tasks it might be worthwhile to consult webac, openac, and the decomp

"i could drag my main pack…" was read as the retail behaviour wanted (our main pack could not be dragged).

## 2. Root causes and fixes

| Issue | Root cause (evidence) | Fix | Flag (default) |
|---|---|---|---|
| Little jump running downhill | **Trees/rocks on slopes.** Scenery is clamped in XY *after* the transition; `?clampAlongGround` then carried z along the transition's own contact plane, which is wrong across a terrain crease. With 0.2 s frames (hitches) the feet ended 18–36 cm in the ground or 5–17 cm above it for one frame, every hitch while pushing on a trunk; ~5 cm at 30 fps. No airborne frame, so no Falling clip — the body itself pops. Retail collides scenery inside the transition (`get_land_scenes` → `makeObject` → `add_obj_to_cell`, acclient.c:352707-352714); WebAC clamps first and then finds the floor. `terrain_hop_real_trees_on_hillsides` `=off`: 8 floated runs, 63 pops in 143 runs; ON: 0/0 in 1001 runs. | `replant_after_clamp` (holtburger-core `system.rs` `finish_manual_slice_via_transition`) re-runs the transition over the clamped offset; a body held in place stays planted; falls back to the old plane carry. | `clampReplant` (ON, wasm) |
| (same) shoreline edge | A step ending exactly on a shoreline cell's far edge read the near corner's wading depth (ACE's `% 24 >= 12`); retail compares against the cell centre (`CLandBlockStruct::calc_water_depth`, acclient.c:353646). Lifted 0.35 m for a frame, then dropped 0.8 m. | `SceneObjCell::get_water_depth` retail centre compare (holtburger-world `faithful_bridge.rs`). | `waterQuadrantRetail` (ON, wasm) |
| (same) diagnostics | Earlier round-2 "pops" on open terrain were measurement artefacts (1 cm depth probe). Seams, all Holtburg hillsides, 8–144 fps, hitches to 1.5 s, turning, server echoes and Holtburg buildings: 0 lift-offs. The 0.875 m fence-rail climb at 0xA9B4 is retail-legal (`step_up` 0.6 × 1.5, acclient.c:312794 / :359534) and left alone. | Always-on hop detector `__diag.hop` (holtburger-core `hop_diag.rs`, wasm `hopDiag*` exports, `scene3d/diag/hop.js`): every lift-off / pop with a cause (`noTerrain`, `leftGround`, `bounce`, `wade`, `resurface`, `object`, `unexplained`). | always on |
| Monsters floating on hills | **ACE really sends them in the air.** `Spawn_Scatter` (GeneratorProfile.cs:352-393) skips its ground snap when the ground is >10 m from the generator Z (`ScatterThreshold_Z`, PhysicsObj.cs:1393-1440) and never moves an idle creature. Live `ACE_Log.txt`: 1,222 skipped snaps, 771 floating 10–67 m (median 13.6 m), 210 creature names; e.g. 2026-10-17 Extas Lugian 0xA1200036 14.9 m up. Retail drops them (`enter_world` → `calc_acceleration` → `UpdatePhysicsInternal`, acclient.c:323441 / :317787 / :317701); OpenAC agrees, WebAC also floats them. Our remote body only stepped bodies that moved. | `SpatialScene::start_remote_settles`: an attackable, non-player GRAVITY creature placed without IS_GROUNDED, 0.3–100 m above the highest floor the scene holds, falls along the `remoteJumpArc` arc (Falling → landing). Outdoors only; waits for its landblock's terrain + buildings + statics (and a neighbour's within 24 m); a grounded UpdatePosition vetoes it. JS replays the landed pose at spawn commit. | `remoteSettle` (ON, wasm + JS) |
| (same) high terrain | Latent race: the Region `LandHeightTable` is `byte*2` only to index 200 (400 m), then 404 … 700. Both terrain fetchers could decode with the `byte*2` fallback on a Region cache miss — up to 47 m wrong (25.9 m low under a logged Magma Golem spawn at 0xA31F000E). | Both fetchers `ensure_region_resident` before decoding. | none (restores intended decode) |
| Melee swings from too far | ACE swings at once inside a 4 m cylinder gap (`Player_Melee.cs:174`) with StickToObject (`:420`) and no range check at damage; retail's StickyManager pulls the attacker in at `max_speed × 5` for ≤1 s (acclient.c:388519-388690). **(A)** ACE's autonomous echo of our own MoveToState (`Player_Networking.cs:365`) released the local sticky right after the swing — retail never processes its own autonomous echo (`CPhysics::SetObjectMovement`, acclient.c:311149). **(B)** every canvas click / movement key called `stopStick`; retail input paths carry no unstick. **(C)** the pull aimed at the last network pose, not the live body (acclient.c:388544-388547). OpenAC matches retail on all three; WebAC swings in place (same symptom). | (A) `local_motion_sticky_update` gate in the wasm UpdateMotion arm; (B) `cancelClientMove()` keeps the glue (teardown still releases); (C) `StickyManager::refresh_live_target`. | `retailUnstick` (ON, wasm + JS), `stickyLiveTarget` (ON, wasm) |
| Sneak Attack popup | `plugins/sneak-hud.js` floated a plaque at 30% screen height on a client facing *prediction*. Retail has no popup and no panel element — only the hit-line prefix (`attack_conditions & 4` "Sneak Attack! ", acclient.c:408415 / :409683). Our hit lines already matched retail exactly (`src/chat_format.rs`). | Plugin retired; `ui/ac_sneak_attack_cue.js`: a "Sneak Attack +10/+20" cue after "Recklessness" in the combat HUD row 2 — bright on a server-confirmed hit (AttackerNotification bit 0x4), dim while a swing from behind is in flight; a twin on the magic spell strip lights on ACE's "Sneak Attack! You …" Magic line. Also fixed `scene3d/diag/combat.js` `_sneakSubHandler` (read the event, not `.detail`). | none (HUD) |
| Pyreal motes won't join | The owner's motes (wcid 6353, CraftTool, MaxStackSize 1, ItemUseable 0x80008, TargetType 0x80) combine by recipe 790 (→ Pyreal Sliver), not a stack merge. While a target was awaited, a click in the inventory grid / paperdoll / packs only selected — only the hidden legacy `<ul>` lists and 3D picks resolved it. Retail: `UIElement_ItemList::HandleTargetedUseLeftClick` (acclient.c:272399) → `ItemHolder::TargetAcquired` (:433578). The drag path's `canUseWith` gate is true for these flags (3 Rust tests replay the owner's objects). | Target-mode clicks in every inventory view resolve the target (green/red outline, crosshair; the double-click's second press is swallowed). | `useTargetGrid` (ON, JS) |
| Main pack → hotkey | The main pack slot had no drag source. Retail's main pack UIItem is the player (acclient.c:222199); the toolbar takes it (`CreateShortcutToItem` :240523, `IsShortcutEligible` :239885); `UseShortcut` (:239995) tests target mode first. | Main pack drags (MIME `application/x-hb-self-guid`, hotbar slots only) to a shortcut to yourself (main-pack icon, AddShortCut(index, player), kept by the stale sweep; nothing pruned while no character is known). Pressing it: in target mode → targets you; otherwise opens the main pack (retail `UsingItem` :400434). Any item shortcut pressed in target mode targets its item. | `selfShortcut`, `shortcutTargetMode` (ON, JS) |
| Kit on your own body | 3D picking always skipped the local player. Retail's render pick includes the player (acclient.c:314614 / :380089); ACE accepts self as a kit target. | Your drawn body is pickable only while a target is awaited AND `canUseWith(item, you)` (a kit, not a key / lockpick); normal clicks still pass through your back (#18). | `useTargetSelfPick` (ON, JS) |

Every flag accepts `off` / `0` / `false`; `=off` restores the old path exactly. Rows: `docs/url-flags.md` §2026-10-18
(three sections) and the two `?clampReplant` / `?waterQuadrantRetail` rows after `?clampAlongGround`.

## 3. Files

- **hop:** `crates/holtburger-core/src/client/movement/{system.rs, handle.rs, mod.rs, terrain_hop_tests.rs, terrain_hop_real_tests.rs (new)}`, `crates/holtburger-core/src/{hop_diag.rs (new), lib.rs}`, `crates/holtburger-world/src/spatial/faithful_bridge.rs`, `apps/holtburger-web/src/lib.rs`, `scene3d/diag.js`, `scene3d/diag/hop.js (new)`, `index.html`, `tests/hop_diag.test.mjs (new)`.
- **spawnz:** `crates/holtburger-world/src/{spatial.rs, spatial/scene.rs, spatial/types.rs, spatial/remote_settle_tests.rs (new), state/remote_movement.rs}`, `apps/holtburger-web/src/{lib.rs, session/commands/movement.rs}`, `scene3d/entities.js`, `tests/remote_settle.test.mjs (new)`.
- **melee:** `crates/holtburger-world/src/{handlers/movement.rs, player/mutations.rs, player/tests.rs, spatial/position_manager.rs, spatial/scene.rs, spatial/tests.rs}`, `apps/holtburger-web/src/{lib.rs, session/mod.rs, session/messages/{position.rs, login.rs}, session/commands/lifecycle.rs}`, `scene3d/picking.js`, `tests/retail_unstick.test.mjs (new)`.
- **sneak:** `plugins/{combat-hud.js, combat-bar.js}`, `plugins/sneak-hud.js` + manifest **deleted**, `ui/ac_sneak_attack_cue.js (new)`, `app/plugin_bar.js`, `scene3d/diag/combat.js`, `scene3d/spell_shape_preview.js` (comment), `tests/sneak_attack_cue.test.mjs (new)`.
- **usetarget:** `plugins/{inventory.js, hotbar.js, item_drag.js, drop_item_flags.js}`, `scene3d/picking.js`, `crates/holtburger-world/src/{context.rs, state/tests.rs}` (tests only), `tests/{use_target_inventory, hotbar_self_shortcut, use_target_self_pick}.test.mjs (new)`.
- **shared (orchestrator):** `harness/run-js-headless.mjs` (7 registrations), `docs/url-flags.md`, `plugins/index.json` (51 → 50), `tests/plugin_loader.test.cjs` (51 → 50 pin), `index.html` modulepreload (+ `scene3d/diag/hop.js`, 434 modules), `harness/test_build_shell.mjs` (`NON_APP_PRELOADS` 412 → 413).

## 4. RynthSuite

`window.__useTargeting`, `window.__inventory`, `window.__hotbar` keep their shapes; `tests/rynth_vt_parity.test.mjs`
passes. Two notes: a user click no longer releases a rynth-installed stick (rynth calls its own StopStick; the stick
times out after 1 s anyway), and `objectPosition` still reports a settled creature's floating server Z until the server
moves it.

## 5. Ops

- Release wasm rebuilt; the previous pkg is kept at `apps/holtburger-web/pkg-prev-20261018-preownerbugs/`. Every
  checkout needs a release wasm build — pkg/ is gitignored.
- No `?v=wasmrev-…` stamp bump: serve.py serves `.js` / `.wasm` with `no-cache` (revalidated each load), the same as the
  2026-10-13 and 2026-10-17 rebuilds. Load with `?nosw=1` + reload, as always.
- The bridge and ACE are untouched.

## 6. Owner eye-test queue (batched; `?nosw=1`; bare URL first, then each `=off`)

1. **Downhill hop (trees).** Run down a wooded hillside west of Holtburg (0xA8B3 / 0xA8B4) into a tree with W held, then
   brush past trunks; repeat with `?targetFps=5` (0.2 s frames = the hitch case). Pass: feet stay on the ground at any
   frame rate; `__diag.hop.summary()` shows no `resurface` / `unexplained`. A/B `?clampReplant=off` (+ `targetFps=5`:
   the dip / pop comes back).
2. **Shoreline.** `@teleloc 0xAAB50009 31 21 28.76`, face north, run into the lake past local y = 48. Pass: a smooth
   wade-in (0.1 → 0.45 → 0.9 m). A/B `?waterQuadrantRetail=off` (a ~0.35 m pop; needs an exact edge landing).
3. **Whenever a hop is seen anywhere:** copy `__diag.hop.summary()`, `JSON.stringify(__diag.hop.tail(5))`,
   `__diag.hop.explain()` and `@loc`. `wade` and `object` (e.g. the 0.875 m fence rail at
   `@teleloc 0xA9B40027 112.9 150 66.01`, run north) are retail-expected.
4. **Floating spawns.** Steep Lugian hillsides (`midsouthmountainslugiangen`, 15 m radius):
   `@teleloc 0xA120002F 143.3 144.7 313.7` (look up-slope NE, ~36% of spawns float), `@teleloc 0xA11D000C 26.8 93.2 383.3`
   (~24%), `@teleloc 0xA31F0007 13.0 144.0 441.2` (~10%; above 400 m, also checks the height-table fix). Pass: creatures
   stand on the slope; console `[remoteSettle] …`; a fresh spawn in view plays a short fall + landing. A/B
   `?remoteSettle=off` (some hover 10–30 m up). Regression: nothing drops in Holtburg; NPCs / vendors on porches stay;
   corpses stay; remote jumps, chases and melee look as before.
5. **Melee range.** In melee stance stand 2–3 m from an idle monster, facing it, attack ~10 times; then 45–90° turned
   away. Pass: each swing starts with a quick slide (~0.1–0.2 s) and connects at arm's length — no swings at the air.
   Click the monster / tap W mid-swing: you stay glued (≤1 s), then move. A monster charging you / walking past: the
   slide ends at the monster as drawn. Charge from 10–15 m. Probe `window.__sessionHandle.localStickyTarget()`. A/B
   `?retailUnstick=off&stickyLiveTarget=off`.
6. **Sneak Attack cue** (Sneak Attack trained). Melee from behind: a dim "Sneak Attack +10" after "Recklessness" when the
   swing starts, bright with the chat line "Sneak Attack! You …"; from the front: off; an evade from behind: dim then
   gone; nothing mid-screen. Bow: same. Magic stance, war bolt from behind: the cue at the right end of the spell
   strip's tab row. HUD scale + drag both panels. Without a fight: `__sneakCue.attack.hit()` / `.behind()`,
   `__sneakCue.magic.hit()`.
7. **Motes / self shortcut / kits** (Tester, peace mode, below full health):
   1. F4, open the Sack with the two motes, double-click one → "Choose a target for Pyreal Mote"; hover the other
      (green), click it → "You combine the two motes into a larger sliver." and a Pyreal Sliver.
   2. Drag the main pack icon (top of the right column) onto empty slot 1 → backpack icon, tooltip "Tester"; pressing 1
      opens the main pack, nothing in chat.
   3. Kit on 2: press 2 then 1 → heal-self animation, health rises. Press 2, click your own character (third person) →
      heals; press 2, click the main pack icon → heals. With no kit pending, click a monster just behind you → selects
      the monster.
   4. Relog: slot 1 still shows the backpack; repeat 3.
   5. A/B `?useTargetGrid=off`, `?useTargetSelfPick=off`, `?selfShortcut=off`, `?shortcutTargetMode=off`.

## 7. Gate (integration worktree, one capped job at a time)

All on the merged tree, after the last change:
- **Rust** (`cargo test --lib`, per crate, capped): holtburger-world **1112 passed / 0 failed**; holtburger-core
  **671 passed / 0 failed** (+1 ignored); holtburger-web native **495 passed / 0 failed** (+6 ignored). The wasm32
  check before the hop merge was clean with the same 17 warnings as master; the release build below compiles the
  final tree for wasm32.
- **Release wasm**: built 2026-10-18 03:41, 7.59 MB (was 7.56 MB); new exports present (`hopDiag*`, the
  `remoteSettle` / `retailUnstick` / `stickyLiveTarget` / `clampReplant` / `waterQuadrantRetail` readers).
- **JS gate** (`node harness/run-js-headless.mjs`, capped, heavy lock): **765 passed / 0 failed / 0 skipped** of 765
  (7 new suites). NEEDS-TOOLCHAIN (5) and NEEDS-BROWSER (10) suites are listed, not run, as before.
- **RynthSuite** (`node rynth_test_all_node.cjs`): **68 passed / 0 failed / 32 skipped** — identical to baseline;
  `tests/rynth_vt_parity.test.mjs` passes.
- **Lints**: `lint-url-flags --strict` 0 undocumented (1030 documented); `audit-flag-defaults --mismatch` 0 polarity
  mismatches (the only new STALE row is `stickyLiveTarget`, read by the wasm only); `lint-event-consumers` 0
  findings; `gen-client-event-kinds --check` up to date (58); `gen-modulepreload --check` up to date (434);
  `plugins/gen-index.mjs` up to date (50); `run-js-headless --coverage` 0 unregistered.
- Per-lane runs before the merge (each lane's new Rust tests, full world / core suites, wasm32 checks) are in the
  lane reports; every one passed.
- Not run: `cargo fmt --check`, the browser smokes, any live session.

## 8. Open items

- **hop:** no live capture yet confirms trees as the owner's trigger — `__diag.hop` is there to do that. The retail
  end-state is scenery inside the transition (`obj_collision.rs` has cylinder code, off by default, entities only); then
  `?clampReplant` and `?clampAlongGround` can retire. The replant's fallback never fired in tests but is not proven
  impossible. `WorldState::water_depth_at` (heightfield fallback / detector depth) still uses ACE's rule. Running onto
  an unstreamed landblock can still lift off if the prefetch lags (named `noTerrain`).
- **spawnz:** floors the scene doesn't hold (weenie carts, scenery rocks) could be fallen through until the next grounded
  server update; outdoors only (dungeon scatter is untouched); settles run anywhere in the 3×3 collision ring (retail
  simulates 96 m) — visual only; the server Z is unchanged (range checks, rynth `objectPosition`); a big drop slides
  downhill a few metres; with `?remoteSpine=off` a TurnTo resets the body to the floating wire coordinates.
- **melee:** our client still sends mirrored MoveToState pulses during server-driven turns / MoveTos (retail sends none;
  `system.rs`); fix A removes their effect on the glue only. Unverified side risk for characters with UseChargeAttack
  off (ACE `GameActionMoveToState.cs:22-23` may cancel an approach chain on such a pulse). Pre-existing:
  `SERVER_SWING` in picking.js treats only `off` as off.
- **sneak:** "+N" is nominal (ACE scales it down below your attack skill / vs Assess Person); the magic cue reads ACE's
  chat text; no cue on a killing blow (ACE sends no AttackerNotification). Follow-up: retail sends attacker / defender
  hit lines as chat type 0x16 CombatSelf / 0x15 CombatEnemy (acclient.c:408437 / :409442); we send type 0 with the
  combat category, so attacker lines are dark red instead of retail's light red (needs Rust + chat colouring).
- **usetarget:** which mote path the owner tried is unknown (Use-then-click was definitely broken; the drag path checks
  out in tests). Self-selection by clicking your body is limited to target mode with a self-usable item (retail, WebAC
  and OpenAC allow it always — a separate, flagged decision). Not done: clicking the paperdoll figure as yourself,
  dragging your 3D character to the toolbar, target-mode clicks in chest / corpse windows, retail's toolbar
  no-duplicate rule, exact refusal wording. Found in passing: the Rust `ItemType` flags lack 0x01000000, so a
  TargetType of 0x7FFFFFFF (only the smelting pot in ace_world) never enters target mode.
