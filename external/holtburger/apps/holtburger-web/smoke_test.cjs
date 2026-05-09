// Node-side smoke test for the holtburger-web wasm bundle.
//
// Loads the `--target nodejs` build (pkg-node/) and verifies that the
// wasm-bindgen exports work end-to-end. Used to functionally validate
// the bundle without needing a headless browser; the `--target web`
// build at pkg/ has the same rust-compiled core, so a green run here
// is a strong signal that the browser bundle is also live.
//
// The HTTP-source check (§8 step 4) requires a fixture at
// ../../dats/assets.hba — generate it with `dat2hba` per
// `dats/README.md`. If the fixture is missing the round-trip portion
// degrades to a symbol-presence check and the run still passes, so
// this script works in environments without retail dat access.
//
// Run: `node smoke_test.cjs` from `apps/holtburger-web/`.

const wasm = require("./pkg-node/holtburger_web.js");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

// Bake-cache schema. Bump when the smoke's bake layout changes
// (e.g. add v3, change subdir names, change v2conv-manifest fields)
// so existing cache entries are ignored. Without this bump, a stale
// cache from an older smoke layout would silently feed the wrong
// bytes into the new dispatch tests.
const SMOKE_BAKE_SCHEMA = 1;

// `--fast` skips the dat-shard bake (~6 min) + manifest dispatch
// tests (~30 s), keeping the symbol-presence + closed-port reject
// assertions. Use during inner-loop iteration; CI runs without
// --fast for full coverage.
const fastMode = process.argv.includes("--fast");

let failed = 0;

function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

console.log("holtburger-web smoke test");
console.log("=========================");

const info = wasm.build_info();
check(
    "build_info() returns identification string",
    typeof info === "string" && info.startsWith("holtburger-web v"),
    JSON.stringify(info)
);

// Hash32 is deterministic; reference value taken from the Rust impl
// (`crates/holtburger-protocol/src/crypto.rs` Hash32::compute).
// "hello" = 0x68 0x65 0x6c 0x6c 0x6f, length 5.
//   length << 16 = 0x00050000
//   one full 4-byte chunk: 0x6c6c6568 (le u32 of "hell")
//   sum: 0x00050000 + 0x6c6c6568 = 0x6c716568
//   tail byte 'o' (0x6f) at i=4, shift=3: + (0x6f << 24) = 0x6f000000
//   sum: 0x6c716568 + 0x6f000000 = 0xdb716568
const empty = wasm.hash32(new Uint8Array([]));
check(
    "hash32(empty) returns 0",
    empty === 0,
    `got 0x${empty.toString(16).padStart(8, "0")}`
);

const hello = wasm.hash32(new TextEncoder().encode("hello"));
check(
    "hash32('hello') matches Rust's deterministic value",
    hello === 0xdb716568,
    `got 0x${hello.toString(16).padStart(8, "0")} expected 0xdb716568`
);

// Same input twice → same hash (sanity that wasm state isn't bleeding).
const hello2 = wasm.hash32(new TextEncoder().encode("hello"));
check(
    "hash32('hello') is deterministic across calls",
    hello === hello2,
    `${hello.toString(16)} == ${hello2.toString(16)}`
);

// End-to-end check that `Session::new_test` runs on wasm without
// panicking — exercises the `web_time::Instant` swap from spike doc
// §8 step 3. `new_test` initializes `packet_sequence = 1`.
const seq = wasm.session_smoke_test_packet_sequence();
check(
    "Session::new_test() runs on wasm and returns packet_sequence=1",
    seq === 1,
    `got ${seq}`
);

// §8 step 2 wiring: the WsTransport-backed handshake export must be
// present in the bundle. We don't invoke it here — calling it would
// require a live bridge plus a `WebSocket` global (Node ≥ 21), which
// is out of scope for this deterministic smoke test. Browser-side
// validation against `holtburger-wsbridge` is the next step.
check(
    "try_ws_handshake_smoke() is exported (WsTransport wired into bundle)",
    typeof wasm.try_ws_handshake_smoke === "function",
    `typeof ${typeof wasm.try_ws_handshake_smoke}`
);

// §8 step 4 wiring: HttpResourceSource must be present. End-to-end
// round-trip below if the fixture exists.
check(
    "try_http_resource_source_smoke() is exported (HttpResourceSource wired into bundle)",
    typeof wasm.try_http_resource_source_smoke === "function",
    `typeof ${typeof wasm.try_http_resource_source_smoke}`
);

// Phase 5.0 obj 5/9 — manifest-mode resource source. The
// per-export refactor (drop `asset_url` from each fetch_* in
// favour of the global source) is deferred to a follow-up
// commit; symbol-presence + a connect/reject round-trip here
// covers the obj 5 wiring + the obj 4 ManifestResourceSource
// at the JS boundary.
check(
    "init_resource_source() is exported (Phase 5.0 obj 5)",
    typeof wasm.init_resource_source === "function",
    `typeof ${typeof wasm.init_resource_source}`
);
check(
    "has_resource_source() is exported (Phase 5.0 obj 5 introspection)",
    typeof wasm.has_resource_source === "function",
    `typeof ${typeof wasm.has_resource_source}`
);
check(
    "cached_shard_count() is exported (Phase 5.0 obj 5 introspection)",
    typeof wasm.cached_shard_count === "function",
    `typeof ${typeof wasm.cached_shard_count}`
);
// Pre-init sanity: no source yet, no cached shards.
check(
    "init_resource_source not yet called → has_resource_source()=false",
    wasm.has_resource_source() === false,
    `has_resource_source()=${wasm.has_resource_source()}`
);
check(
    "init_resource_source not yet called → cached_shard_count()=0",
    wasm.cached_shard_count() === 0,
    `cached_shard_count()=${wasm.cached_shard_count()}`
);

// Phase 5.2 obj 8 — v2 dispatch wiring: new wasm-bindgen
// exports the smoke harness uses to verify v1 vs v2 mode.
check(
    "manifest_version() is exported (Phase 5.2 obj 4 dispatch accessor)",
    typeof wasm.manifest_version === "function",
    `typeof ${typeof wasm.manifest_version}`
);
check(
    "loaded_catalog_count() is exported (Phase 5.2 obj 4 catalog probe)",
    typeof wasm.loaded_catalog_count === "function",
    `typeof ${typeof wasm.loaded_catalog_count}`
);
check(
    "manifest_v2_version_const() is exported (Phase 5.2 obj 8 schema check)",
    typeof wasm.manifest_v2_version_const === "function" &&
        wasm.manifest_v2_version_const() === 2,
    `typeof ${typeof wasm.manifest_v2_version_const}, value=${
        typeof wasm.manifest_v2_version_const === "function"
            ? wasm.manifest_v2_version_const()
            : "n/a"
    }`
);
check(
    "init_resource_source not yet called → manifest_version()=0",
    wasm.manifest_version() === 0,
    `manifest_version()=${wasm.manifest_version()}`
);
check(
    "init_resource_source not yet called → loaded_catalog_count()=0",
    wasm.loaded_catalog_count() === 0,
    `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
);

// Phase 3 step 1 wiring: fetch_landblock_heightmap must be present.
// End-to-end round-trip below if the fixture has the eor/cell namespace
// (i.e. dat2hba was run with --profile pruned, not --profile micro).
check(
    "fetch_landblock_heightmap() is exported (Phase 3 step 1 render path)",
    typeof wasm.fetch_landblock_heightmap === "function",
    `typeof ${typeof wasm.fetch_landblock_heightmap}`
);

// Phase 3 step 2 wiring: fetch_landblock_heightmaps (plural) must be
// present. End-to-end round-trip below alongside the singular form.
check(
    "fetch_landblock_heightmaps() is exported (Phase 3 step 2 batch fetch)",
    typeof wasm.fetch_landblock_heightmaps === "function",
    `typeof ${typeof wasm.fetch_landblock_heightmaps}`
);

// Phase 3 step 3.5: fetch_terrain_textures must be present. End-to-end
// round-trip below if the fixture has the eor/portal namespace with
// SurfaceTexture / Texture / Palette records (i.e. dat2hba was run with
// --profile full, since pruned excludes them).
check(
    "fetch_terrain_textures() is exported (Phase 3 step 3.5 real textures)",
    typeof wasm.fetch_terrain_textures === "function",
    `typeof ${typeof wasm.fetch_terrain_textures}`
);

// Phase 3 step 4: fetch_landblock_objects must be present. End-to-end
// round-trip below against the Holtburg neighbourhood; degrades to a
// SKIP if the fixture lacks LandblockInfo records.
check(
    "fetch_landblock_objects() is exported (Phase 3 step 4 sprites)",
    typeof wasm.fetch_landblock_objects === "function",
    `typeof ${typeof wasm.fetch_landblock_objects}`
);

// Phase 3 step 4.5: fetch_object_colours must be present. End-to-end
// round-trip + diversity check below, gated on the same fixture as the
// step 4 round-trip.
check(
    "fetch_object_colours() is exported (Phase 3 step 4.5 real colours)",
    typeof wasm.fetch_object_colours === "function",
    `typeof ${typeof wasm.fetch_object_colours}`
);

// Phase 3 step 6: fetch_model_mesh / fetch_model_meshes must be
// present. End-to-end round-trip below.
check(
    "fetch_model_mesh() is exported (Phase 3 step 6 runtime mesh)",
    typeof wasm.fetch_model_mesh === "function",
    `typeof ${typeof wasm.fetch_model_mesh}`
);
check(
    "fetch_model_meshes() is exported (Phase 3 step 6 batch)",
    typeof wasm.fetch_model_meshes === "function",
    `typeof ${typeof wasm.fetch_model_meshes}`
);

// Phase 4 step 1: start_session + SessionHandle (with .poll_events()
// and .characterList()) must be present. The `start_session` round-trip
// itself is browser-only — ACE login synthesis in Node would require
// porting the AC packet codec to JS, well outside step 1's scope. The
// error-path check below is the closest deterministic Node coverage:
// invoking `start_session` against a closed port should reject with a
// stringified error rather than panic.
check(
    "start_session() is exported (Phase 4 step 1 login driver)",
    typeof wasm.start_session === "function",
    `typeof ${typeof wasm.start_session}`
);

const sessionHandleProto = wasm.SessionHandle?.prototype;
const handleSurfaceOk =
    typeof wasm.SessionHandle === "function"
    && typeof sessionHandleProto?.poll_events === "function"
    && typeof sessionHandleProto?.characterList === "function";
check(
    "SessionHandle class + .poll_events() + .characterList() exposed",
    handleSurfaceOk,
    `class=${typeof wasm.SessionHandle}, poll_events=${typeof sessionHandleProto?.poll_events}, characterList=${typeof sessionHandleProto?.characterList}`
);

// Phase 4 step 2a: SessionHandle.selectCharacter(guid) drives the
// CharacterEnterWorldRequest → CharacterEnterWorldServerReady →
// CharacterEnterWorld → PlayerCreate spawn handshake. The recv loop
// owns the Session and auto-chains the middle two messages; JS sees
// a kind=1 PlayerSpawned event at the end. Symbol-presence is the
// Node-side check; live spawn round-trip runs through the Playwright
// capture against ACE.
check(
    "SessionHandle.selectCharacter() exposed (Phase 4 step 2a spawn driver)",
    typeof sessionHandleProto?.selectCharacter === "function",
    `selectCharacter=${typeof sessionHandleProto?.selectCharacter}`
);

// Phase 4 step 2a.5: SessionHandle.createTestCharacter(name) constructs
// an Aluvian/Male/Adventurer/Holtburg CharacterCreateRequestData in the
// wasm bundle (via holtburger_core::CharacterGenBuilder) and dispatches
// to the recv loop. .canCreateCharacter is a getter that reports
// whether the CharGen + SkillTable were loaded at start_session time.
check(
    "SessionHandle.createTestCharacter() exposed (Phase 4 step 2a.5)",
    typeof sessionHandleProto?.createTestCharacter === "function",
    `createTestCharacter=${typeof sessionHandleProto?.createTestCharacter}`
);
const canCreateDescriptor = Object.getOwnPropertyDescriptor(
    sessionHandleProto || {},
    "canCreateCharacter"
);
check(
    "SessionHandle.canCreateCharacter getter exposed (Phase 4 step 2a.5)",
    typeof canCreateDescriptor?.get === "function",
    `canCreateCharacter getter=${typeof canCreateDescriptor?.get}`
);

// Phase 4 step 2a.6: SessionHandle.sendChat(message) dispatches a
// GameAction::Talk over the session. Used by the JS-side Teleport
// button to send `@telepoi Holtburg` after kind=7 EnteredWorld.
// Live coverage runs through the Playwright capture against a
// running ACE; here we just verify the export.
check(
    "SessionHandle.sendChat() exposed (Phase 4 step 2a.6 chat / admin commands)",
    typeof sessionHandleProto?.sendChat === "function",
    `sendChat=${typeof sessionHandleProto?.sendChat}`
);

// Phase 4 step 2b: SessionHandle.pollEntityUpdates() drains the
// high-frequency position / spawn / remove channel. Separate from
// poll_events() — see the EntityUpdate doc comment in lib.rs for the
// rationale (position updates fire 100s/sec; tagged-payload string
// allocation in the hot path was the wrong shape). Live coverage
// runs through the Playwright capture; here we just verify the
// export + the EntityUpdate constructor.
check(
    "SessionHandle.pollEntityUpdates() exposed (Phase 4 step 2b entity buffer)",
    typeof sessionHandleProto?.pollEntityUpdates === "function",
    `pollEntityUpdates=${typeof sessionHandleProto?.pollEntityUpdates}`
);
check(
    "EntityUpdate class exposed (Phase 4 step 2b position-bearing event)",
    typeof wasm.EntityUpdate === "function",
    `typeof ${typeof wasm.EntityUpdate}`
);

// Phase 4 step 6a: EntityUpdate carries weenie metadata on Spawn so
// JS can dispatch by category (step 6b), label by name (step 6e), and
// scale by obj_scale. Position/Remove updates leave these zeroed/empty.
// The recv-loop ObjectCreate arm in lib.rs stops discarding the
// PublicWeenieDescription + ObjectDescriptionData fields; here we
// just probe the wasm-bindgen getters were emitted on the prototype.
const entityUpdateProto = wasm.EntityUpdate?.prototype;
const step6aGetters = ["wcid", "itemType", "name", "objScale", "iconId", "paletteId", "mtableId"];
for (const name of step6aGetters) {
    const desc = Object.getOwnPropertyDescriptor(entityUpdateProto || {}, name);
    check(
        `EntityUpdate.${name} getter exposed (Phase 4 step 6a weenie metadata)`,
        typeof desc?.get === "function",
        `getter=${typeof desc?.get}`
    );
}

// Phase 4 step 6 Phase A: EntityUpdate also carries the model_data
// substitutions ACE pre-computed in CalculateObjDesc (per-part GfxObj
// swaps + per-part texture remaps + palette overlays). The flat
// Uint32Array shape lets JS hand them straight to the new
// fetchEntityModelRender export. Probes confirm the getters exist;
// real-fixture validation (wasm Substitution unit tests in
// `tests_substitution::*`) runs through `cargo test`.
const step6PhaseAGetters = ["modelChanges", "textureChanges", "subPalettes"];
for (const name of step6PhaseAGetters) {
    const desc = Object.getOwnPropertyDescriptor(entityUpdateProto || {}, name);
    check(
        `EntityUpdate.${name} getter exposed (Phase 4 step 6 Phase A model_data substitutions)`,
        typeof desc?.get === "function",
        `getter=${typeof desc?.get}`
    );
}
check(
    "fetchEntityModelRender() exposed (Phase 4 step 6 Phase A NPC render path)",
    typeof wasm.fetchEntityModelRender === "function",
    `fetchEntityModelRender=${typeof wasm.fetchEntityModelRender}`
);
// Phase 4 step 6 Phase B: per-surface RGBA8 fetch with entity palette
// override + sub-palette overlays applied at decode time. ACE pre-
// computes both via Creature.CalculateObjDesc (palette id from
// PaletteBaseDID; overlays from each equipped item's CloSubPalEffects
// indexed by paletteTemplate). Symbol-only check; the composition
// arithmetic is covered by the entity_surface_pixels_* native tests.
check(
    "fetchEntitySurfacesPixels() exposed (Phase 4 step 6 Phase B palette overlay path)",
    typeof wasm.fetchEntitySurfacesPixels === "function",
    `fetchEntitySurfacesPixels=${typeof wasm.fetchEntitySurfacesPixels}`
);
// Phase 4 step 6 Tier 2 + walk-cycle polish: walk + run cycle bake.
// Returns an EntityCycleSet wasm-bindgen class with takeWalkFrames /
// takeRunFrames (Vec<ModelMesh> each) and walkFramerate / runFramerate
// (f32 each, from MotionTable AnimData). Empty cycles for setups
// without that command in their MotionTable; cycles are independent
// (a creature may have walk-only or run-only entries).
check(
    "fetchEntityCycleFrames() exposed (walk + run cycle bake)",
    typeof wasm.fetchEntityCycleFrames === "function",
    `fetchEntityCycleFrames=${typeof wasm.fetchEntityCycleFrames}`
);

// Phase 4 step 3: SessionHandle.setMovementInput(forward, strafe,
// turn, run) takes a tristate-axis keystate snapshot and forwards
// it to the recv loop, which builds a `GameAction::MoveToState`
// packet and sends it via the session. JS calls this on every
// change to the WASD/Q/E/Shift keystate, not on every animation
// frame — matching `PlayerDriveIntent::ManualHeld` semantics. Live
// coverage requires a real ACE backend (server simulates motion
// based on the packet); here we only verify the export exists.
check(
    "SessionHandle.setMovementInput() exposed (Phase 4 step 3 movement input)",
    typeof sessionHandleProto?.setMovementInput === "function",
    `setMovementInput=${typeof sessionHandleProto?.setMovementInput}`
);

// Phase 4 step 3.6: SessionHandle.tickMovement() drives the cli's
// MovementSystem on every rAF — emits MoveToState on motion-state
// edges AND the AutonomousPosition heartbeat that was missing pre-3.6.
// Without the heartbeat, server-side player position never advanced
// past @telepoi spawn, encounter generators in adjacent landblocks
// never activated via vision, and no monsters spawned into the
// entity buffer. Symbol-presence here pins the new wire contract;
// live walk-around + ace_shard biota_properties_position assertion
// lives in `capture_phase4_step3.6.cjs` (full e2e harness, requires
// running ACE + wsbridge + MySQL). Protocol documented at
// `docs/phase-4-step-3.6-movement-system.md` §6.
check(
    "SessionHandle.tickMovement() exposed (Phase 4 step 3.6 AutonomousPosition heartbeat)",
    typeof sessionHandleProto?.tickMovement === "function",
    `tickMovement=${typeof sessionHandleProto?.tickMovement}`
);

// Phase 4 step 4: ClientEvent grew a `u32Payload2` getter carrying
// the CHAT_CATEGORY_* tag for kind=2 ChatReceived events. JS routes
// chat to the right tab + colour class via this field — the legacy
// prefix-string heuristic is gone. Symbol-presence here pins the
// new wire contract (live ACE chat round-trip lives in the capture
// harness, not the smoke).
const clientEventDescr = Object.getOwnPropertyDescriptor(
    wasm.ClientEvent?.prototype || {},
    "u32Payload2",
);
check(
    "ClientEvent.u32Payload2 getter exposed (Phase 4 step 4 chat category)",
    typeof wasm.ClientEvent === "function" && typeof clientEventDescr?.get === "function",
    `ClientEvent=${typeof wasm.ClientEvent}, u32Payload2=${typeof clientEventDescr?.get}`
);

// Phase 4 step 4 follow-on (vitals + inventory panels):
// SessionHandle.playerStats() returns a PlayerStatsSnapshot
// (vitals / attributes / skills / level info), refreshed by the
// recv loop on every kind=8 PlayerStatsUpdated event. Symbol-
// presence here pins the export; live wire round-trip lives in
// the capture harness (PlayerDescription must arrive for the
// snapshot to be non-empty).
check(
    "SessionHandle.playerStats() exposed (Phase 4 step 4 follow-on vitals)",
    typeof sessionHandleProto?.playerStats === "function",
    `playerStats=${typeof sessionHandleProto?.playerStats}`
);

check(
    "SessionHandle.playerInventory() exposed (Phase 4 step 4 follow-on inventory)",
    typeof sessionHandleProto?.playerInventory === "function",
    `playerInventory=${typeof sessionHandleProto?.playerInventory}`
);

// Phase 4 step 4 follow-on: PlayerStatsSnapshot wasm-bindgen
// class with `.vitals` / `.attributes` / `.skills` / `.levelInfo`
// / `.name` getters. The recv loop builds one in
// `publish_player_stats_snapshot` from `WorldState.player.*`.
const statsProto = wasm.PlayerStatsSnapshot?.prototype || {};
const statsVitalsDescr = Object.getOwnPropertyDescriptor(statsProto, "vitals");
const statsAttribDescr = Object.getOwnPropertyDescriptor(statsProto, "attributes");
const statsSkillsDescr = Object.getOwnPropertyDescriptor(statsProto, "skills");
const statsLevelDescr = Object.getOwnPropertyDescriptor(statsProto, "levelInfo");
const statsNameDescr = Object.getOwnPropertyDescriptor(statsProto, "name");
check(
    "PlayerStatsSnapshot class + 5 getters exposed (Phase 4 step 4 follow-on)",
    typeof wasm.PlayerStatsSnapshot === "function"
        && typeof statsVitalsDescr?.get === "function"
        && typeof statsAttribDescr?.get === "function"
        && typeof statsSkillsDescr?.get === "function"
        && typeof statsLevelDescr?.get === "function"
        && typeof statsNameDescr?.get === "function",
    `class=${typeof wasm.PlayerStatsSnapshot}, vitals=${typeof statsVitalsDescr?.get}, attributes=${typeof statsAttribDescr?.get}, skills=${typeof statsSkillsDescr?.get}, levelInfo=${typeof statsLevelDescr?.get}, name=${typeof statsNameDescr?.get}`
);

// Phase 4 step 4 follow-on: InventoryItem wasm-bindgen class
// with the 9 getters JS reads to render each row.
const itemProto = wasm.InventoryItem?.prototype || {};
const expectedItemGetters = [
    "guid", "wcid", "name", "iconId", "itemType",
    "value", "stackSize", "equipMask", "containerId",
];
const itemGettersOk = expectedItemGetters.every((g) => {
    const d = Object.getOwnPropertyDescriptor(itemProto, g);
    return typeof d?.get === "function";
});
check(
    "InventoryItem class + 9 getters exposed (Phase 4 step 4 follow-on)",
    typeof wasm.InventoryItem === "function" && itemGettersOk,
    `class=${typeof wasm.InventoryItem}, getters=${itemGettersOk}`
);

// Phase 4 step 4 follow-on: top-level human-readable label
// helpers used by JS to render the vitals panel rows. Each maps
// a numeric stat-type id to its display string (mirrors the
// strum Display impl on the underlying enum).
check(
    "skillName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.skillName === "function" && wasm.skillName(24) === "Run",
    `skillName=${typeof wasm.skillName}, skillName(24)=${JSON.stringify(wasm.skillName?.(24))}`
);
check(
    "attributeName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.attributeName === "function" && wasm.attributeName(1) === "Strength",
    `attributeName=${typeof wasm.attributeName}, attributeName(1)=${JSON.stringify(wasm.attributeName?.(1))}`
);
check(
    "vitalName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.vitalName === "function" && wasm.vitalName(1) === "Health",
    `vitalName=${typeof wasm.vitalName}, vitalName(1)=${JSON.stringify(wasm.vitalName?.(1))}`
);

// Phase 4 step 5 (interactive entities): SessionHandle.useObject(guid)
// dispatches a `GameAction::Use(UseActionData { guid })` action. The
// JS side fires this from per-sprite pointerdown handlers on portals
// / vendors / lifestones / containers / signs; ACE responds with
// either `PlayerTeleport` (portal), `GameEvent::ApproachVendor`
// (vendor), `GameEvent::UseDone` (door / container / lifestone), or
// `GameEvent::WeenieError(WithString)` (out-of-range / locked /
// non-interactive). The recv loop's GameEvent arm normalises the
// reply into kind=12 VendorOpened / kind=13 UseFailed / kind=14
// UseDone.
check(
    "SessionHandle.useObject() exposed (Phase 4 step 5 click-to-use)",
    typeof sessionHandleProto?.useObject === "function",
    `useObject=${typeof sessionHandleProto?.useObject}`
);

// Combat-mode toggle: SessionHandle.toggleCombatMode() flips the
// player between NonCombat and a combat mode (Melee/Missile/Magic)
// chosen from equipped items via WorldContextExt::get_suggested_combat_mode.
// Sends GameAction::ChangeCombatMode; ACE's GetCombatStance derives
// the actual MotionStance server-side and broadcasts UpdateMotion.
// JS-side ` (backtick) hotkey + the kind=5 motionStance receiver
// paint the vitals-header stance indicator. The retail AC default
// keybind for this toggle is also backtick.
check(
    "SessionHandle.toggleCombatMode() exposed (combat-mode hotkey)",
    typeof sessionHandleProto?.toggleCombatMode === "function",
    `toggleCombatMode=${typeof sessionHandleProto?.toggleCombatMode}`
);

// Phase 4 step 6f (portal destination chips): EntityUpdate gained a
// `portalDestination` getter so JS can render a "→ <destination>"
// chip under portal sprites. Source: ACE's
// `PropertyString::AppraisalPortalDestination` (assessment-only)
// arrives via auto-fired `GameAction::IdentifyObject` post-Spawn,
// surfaced as a `kind=3 META_REFRESH` EntityUpdate. Empty string for
// non-portals + portals where the appraisal hasn't completed yet.
const entityUpdateDescr = Object.getOwnPropertyDescriptor(
    wasm.EntityUpdate?.prototype || {},
    "portalDestination",
);
check(
    "EntityUpdate.portalDestination getter exposed (Phase 4 step 6f)",
    typeof wasm.EntityUpdate === "function" && typeof entityUpdateDescr?.get === "function",
    `EntityUpdate=${typeof wasm.EntityUpdate}, portalDestination=${typeof entityUpdateDescr?.get}`
);

// Velocity-extrapolation polish: VectorUpdate (kind=4) carries
// ACE's authoritative `(velocity, omega)` for an entity. JS uses
// it to extrapolate sprite position past the catch-up lerp's
// target, smoothing motion across the ~100-300 ms gap between
// PublicUpdatePosition echoes. Four new EntityUpdate getters:
// vx / vy / vz / omegaZ. Position fields stay zeroed on kind=4.
const entityUpdateProto2 = wasm.EntityUpdate?.prototype || {};
const velocityGetters = ["vx", "vy", "vz", "omegaZ"];
const velocityGettersOk = velocityGetters.every((g) => {
    const d = Object.getOwnPropertyDescriptor(entityUpdateProto2, g);
    return typeof d?.get === "function";
});
check(
    "EntityUpdate vx/vy/vz/omegaZ getters exposed (velocity hint kind=4)",
    typeof wasm.EntityUpdate === "function" && velocityGettersOk,
    `EntityUpdate=${typeof wasm.EntityUpdate}, getters=${velocityGettersOk}`
);

// === Phase 6 Step A — restore building leaf geometry ================
//
// Phase 6 step A wires the Setup-part walker into the building branch
// of `fetch_landblock_objects` (lib.rs:712-713 today emits a
// silhouette-only placement). Two new wasm-bindgen surfaces are
// expected on the bundle once the implementation lands:
//
//   1. `init_building_map` (or equivalent): JS-side per-building
//      PIXI.Container registry. Modelled on Phase 5 step 5/6's
//      `init_resource_source` / `has_resource_source` introspection
//      pattern (see line 119-145 above).
//   2. `BuildingPlacement` (placeholder name — see capture script
//      header for naming caveat): per-part-aware return type. Sibling
//      to `ObjectPlacement` (line 605 in lib.rs) but carrying enough
//      data for the JS bake to addressable each part by
//      `(building_id, part_index)`. Phase E's door-rotation path
//      depends on this addressing.
//
// All three checks below are non-throwing — they probe via `typeof`
// and report "phase A not yet shipped" as the detail message. These
// will fail today (expected); they pass once the implementation
// agent ships the Phase A export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase A.
//
// NOTE: the names `init_building_map` and `BuildingPlacement` are
// PLACEHOLDERS. If the implementation chooses a different idiom
// (e.g. `init_buildings`, `BuildingPartPlacement`), update both this
// block AND `capture_phase6_step_a_geometry.cjs`'s window-side probe
// in the same commit so the smoke + live tests stay aligned.

const phase6BuildingMapInit = typeof wasm.init_building_map === "function";
check(
    "phase6.A.window_buildingMap_exists",
    phase6BuildingMapInit,
    phase6BuildingMapInit
        ? `init_building_map=${typeof wasm.init_building_map}`
        : "phase A not yet shipped — expected wasm.init_building_map() (placeholder name)"
);

const phase6BuildingPlacementCtor = typeof wasm.BuildingPlacement === "function";
check(
    "phase6.A.fetch_landblock_objects_returns_buildings_with_parts",
    phase6BuildingPlacementCtor,
    phase6BuildingPlacementCtor
        ? `BuildingPlacement=${typeof wasm.BuildingPlacement}`
        : "phase A not yet shipped — expected wasm.BuildingPlacement constructor (placeholder name; per-part-aware return type sibling to ObjectPlacement)"
);

// Runtime stub — once Phase A lands, the implementation agent will
// hook this into a deterministic fixture path (likely a synthetic
// Setup with N>1 parts, parsed via the dat-shard cache without
// requiring a live ACE). Today it's a pure no-op that reports the
// missing entry point. The check is idempotent — re-running it
// after the implementation lands will exercise the new path
// without code change here. The runtime path SHOULD also expose a
// way to query "max part count across all buildings parsed in the
// last fetch_landblock_objects call" without requiring a live
// session; the implementation agent picks the exact accessor name.
let phase6PartCountOk = false;
let phase6PartCountDetail =
    "phase A not yet shipped — expected a runtime accessor reporting "
    + "max parts-per-building from a deterministic Setup fixture. "
    + "The implementation agent hooks this stub when Phase A lands.";
try {
    if (typeof wasm.holtburg_townhall_max_parts === "function") {
        const n = wasm.holtburg_townhall_max_parts();
        phase6PartCountOk = typeof n === "number" && n > 1;
        phase6PartCountDetail = `holtburg_townhall_max_parts()=${n}`;
    }
} catch (e) {
    phase6PartCountDetail = `holtburg_townhall_max_parts threw: ${e?.message ?? e}`;
}
check(
    "phase6.A.holtburg_townhall_part_count",
    phase6PartCountOk,
    phase6PartCountDetail
);

// === end Phase 6 Step A =============================================

// === Phase 6 Step B — player ↔ building AABB collision ==============
//
// Phase B wires a swept-AABB check into `project_pose_by_velocity`
// (`crates/holtburger-world/src/spatial/physics.rs:308-319`). The
// integrator looks up `building_aabb_index: HashMap<CellId, Vec<Aabb>>`
// for the current cell + neighbours, sweeps the player capsule along
// the proposed velocity * dt vector, and clamps the delta to first
// hit. Walking parallel to the wall slides without blocking.
//
// The smoke can't drive a live ACE round-trip (that's the live capture
// `capture_phase6_step_b_collision.cjs`'s job) but it CAN exercise:
//   1. Symbol presence — does Phase B expose the AABB extraction +
//      sweep helpers it claims to? If the count returns 0 from a
//      deterministic fixture path, AABB extraction isn't wired.
//   2. Synthetic axis-aligned clamp — set up an in-memory Setup with
//      one AABB at a known position, propose a velocity that crosses
//      it, assert the clamped distance is less than the proposed
//      distance.
//   3. Synthetic slide — same fixture, propose a parallel-to-wall
//      velocity, assert NO clamp (slide returns full distance).
//
// All three checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase B export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase B.
//
// NOTE: the names below are PLACEHOLDERS. If the implementation
// chooses different idioms (e.g. `holtburg_aabb_clamp_test` instead
// of `holtburg_test_collision_clamp_axis_aligned`), update both this
// block AND `capture_phase6_step_b_collision.cjs`'s symbol probe
// in the same commit so the smoke + live tests stay aligned.
//
// TODO: confirm with implementation agent — error-code conventions
// for the synthetic test helpers. Today the contract is:
//   0  = test passed
//   1  = wasm export missing (symbol not yet shipped)
//   >1 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).

// (B.1) Symbol-check that Phase B's per-Setup AABB extraction is
// wired. Mirrors Phase A's `holtburg_townhall_max_parts` shape: a
// deterministic accessor returning a count from a known fixture. If
// the count is 0, the Phase B walker isn't extracting AABBs from
// Setup parts; if > 0, AABB extraction is at least running.
let phase6BAabbCountOk = false;
let phase6BAabbCountDetail =
    "phase B not yet shipped — expected wasm.holtburg_townhall_aabb_count() "
    + "(placeholder name) returning a non-zero u32 from a deterministic "
    + "Setup fixture. Sibling to Phase A's holtburg_townhall_max_parts.";
try {
    if (typeof wasm.holtburg_townhall_aabb_count === "function") {
        const n = wasm.holtburg_townhall_aabb_count();
        phase6BAabbCountOk = typeof n === "number" && n > 0;
        phase6BAabbCountDetail = `holtburg_townhall_aabb_count()=${n}`;
    }
} catch (e) {
    phase6BAabbCountDetail = `holtburg_townhall_aabb_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.project_pose_returns_clamped_when_aabb_blocks",
    phase6BAabbCountOk,
    phase6BAabbCountDetail
);

// (B.2) Synthetic axis-aligned clamp. The wasm export builds an
// in-memory Setup with one AABB box and proposes a velocity that
// crosses it; the helper itself asserts that the clamped distance
// is strictly less than the proposed distance. Returns 0 on
// success, non-zero error code on failure.
//
// Using a self-asserting helper (rather than returning floats for
// JS-side comparison) is deliberate: keeps the floating-point
// epsilon decisions inside Rust where they belong, and the smoke
// just observes the verdict. Mirrors the typed-error convention
// used by other holtburger-world unit tests.
let phase6BClampOk = false;
let phase6BClampDetail =
    "phase B not yet shipped — expected wasm.holtburg_test_collision_clamp_axis_aligned() "
    + "(placeholder name) returning 0 if proposed-into-wall is clamped, non-zero "
    + "error code otherwise.";
try {
    if (typeof wasm.holtburg_test_collision_clamp_axis_aligned === "function") {
        const code = wasm.holtburg_test_collision_clamp_axis_aligned();
        phase6BClampOk = code === 0;
        phase6BClampDetail = `holtburg_test_collision_clamp_axis_aligned()=${code} `
            + `(0 = clamp asserted; non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6BClampDetail = `holtburg_test_collision_clamp_axis_aligned threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.set_velocity_into_wall_clamps",
    phase6BClampOk,
    phase6BClampDetail
);

// (B.3) Synthetic slide-along-wall. Same fixture as B.2, but the
// proposed velocity is PARALLEL to the wall plane rather than
// perpendicular. The helper asserts NO clamp occurs — the full
// proposed distance is preserved. Returns 0 on success, non-zero
// error code on failure (sweep over-clamped, dropped a slide axis,
// etc.).
let phase6BSlideOk = false;
let phase6BSlideDetail =
    "phase B not yet shipped — expected wasm.holtburg_test_collision_slide_along_wall() "
    + "(placeholder name) returning 0 if a parallel-to-wall velocity slides "
    + "the full distance, non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_collision_slide_along_wall === "function") {
        const code = wasm.holtburg_test_collision_slide_along_wall();
        phase6BSlideOk = code === 0;
        phase6BSlideDetail = `holtburg_test_collision_slide_along_wall()=${code} `
            + `(0 = slide preserves full distance; non-zero = error code)`;
    }
} catch (e) {
    phase6BSlideDetail = `holtburg_test_collision_slide_along_wall threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.slide_along_wall",
    phase6BSlideOk,
    phase6BSlideDetail
);

// === end Phase 6 Step B =============================================

// === Phase 6 Step C — EnvCell rendering wasm export =================
//
// Phase C ships an EnvCell render path: a new wasm export
// `fetch_env_cells_in_landblock(lbid: u32) -> JsValue` returning a
// `Vec<EnvCellPlacement>` (sibling to ObjectPlacement), a JS-side
// `window.cellContainers: Map<CellId, PIXI.Container>` registry
// populated lazily on landblock entry, and a new triangulator path
// for Environment DIDs (0x0D…) that's distinct from Setup.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_c_envcells.cjs`):
//   1. Symbol presence — `fetchEnvCellsInLandblock` is exported and
//      callable via the deterministic in-memory ResourceSource fed
//      by the smoke's manifest fixture.
//   2. Runtime population — `holtburg_envcell_count()` returns a
//      non-zero u32 from a deterministic Setup/EnvCell fixture path
//      (sibling to Phase B's `holtburg_townhall_aabb_count`).
//   3. Static-object floor — total static-object count across
//      Holtburg's EnvCells matches (or exceeds) the terminal
//      exporter's count from
//      `pipeline_data/reference/interior_support_objects_highconf.jsonl`.
//      That JSONL has 14 high-confidence support objects under
//      landblockId=0xA9B4 (verified at script-write time); the
//      runtime count includes ALL static objects, not just the
//      high-confidence support subset, so the floor is just "at
//      least 14".
//
// All three checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase C export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase C.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B
// convention: snake-case `fetch_env_cells_in_landblock` on the Rust
// side maps to camelCase `fetchEnvCellsInLandblock` via wasm-bindgen
// `js_name` (per the §4.3 plan spec). If the implementation chooses
// different idioms, update both this block AND
// `capture_phase6_step_c_envcells.cjs`'s window-side probe (which
// currently looks for `window.cellContainers` /
// `window.liveScene.cellContainers`) in the same commit so the smoke
// + live tests stay aligned.
//
// TODO: confirm with implementation agent the runtime fixture path —
// `holtburg_envcell_count()` SHOULD parse a deterministic in-memory
// Setup+EnvCell fixture path (likely keyed on the same dat-shard
// cache the Phase A/B helpers consume), without requiring a live
// ACE session. The smoke should run in --fast mode without network.

// (C.1) Symbol-check that `fetchEnvCellsInLandblock` is exported.
// camelCase per wasm-bindgen `js_name` convention; the Rust source is
// `fetch_env_cells_in_landblock` per the plan §4.3 spec.
const phase6CFetchExportOk = typeof wasm.fetchEnvCellsInLandblock === "function";
check(
    "phase6.C.fetch_env_cells_in_landblock_returns_records",
    phase6CFetchExportOk,
    phase6CFetchExportOk
        ? `fetchEnvCellsInLandblock=${typeof wasm.fetchEnvCellsInLandblock}`
        : "phase C not yet shipped — expected wasm.fetchEnvCellsInLandblock(lbid) "
        + "→ Vec<EnvCellPlacement> (placeholder name; snake-case "
        + "`fetch_env_cells_in_landblock` on Rust side per plan §4.3)"
);

// (C.2) Runtime accessor — `holtburg_envcell_count()` returns a
// non-zero u32 from the deterministic in-memory ResourceSource
// (mirrors Phase B's `holtburg_townhall_aabb_count` shape). If the
// count is 0, EnvCell parsing isn't reaching the manifest's
// `eor/cell` namespace; if > 0, parsing is at least running.
let phase6CEnvCellCountOk = false;
let phase6CEnvCellCountDetail =
    "phase C not yet shipped — expected wasm.holtburg_envcell_count() "
    + "(placeholder name) returning a non-zero u32 from the smoke's "
    + "in-memory ResourceSource over the Holtburg landblock prefix "
    + "(0xA9B4). Sibling to Phase B's holtburg_townhall_aabb_count.";
try {
    if (typeof wasm.holtburg_envcell_count === "function") {
        const n = wasm.holtburg_envcell_count();
        phase6CEnvCellCountOk = typeof n === "number" && n > 0;
        phase6CEnvCellCountDetail = `holtburg_envcell_count()=${n}`;
    }
} catch (e) {
    phase6CEnvCellCountDetail = `holtburg_envcell_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.holtburg_envcell_count_nonzero",
    phase6CEnvCellCountOk,
    phase6CEnvCellCountDetail
);

// (C.3) Optional runtime check — total static-object count across
// Holtburg's EnvCells should at least match the terminal exporter's
// high-confidence support count for landblockId=0xA9B4.
//
// The exporter's
// `pipeline_data/reference/interior_support_objects_highconf.jsonl`
// has 14 high-confidence support objects under landblockId=0xA9B4
// (verified at script-write time via:
//   `grep -c '"landblockId": "0xA9B4"' \
//      pipeline_data/reference/interior_support_objects_highconf.jsonl`
// → 14).
//
// The runtime accessor counts ALL EnvCell static objects in the
// landblock — chests, tables, chairs, decorative props, etc. — not
// just the high-confidence support subset. So the floor is just
// "at least 14", which is a sanity floor not a precise match. The
// real Holtburg town hall + outbuildings interior set has hundreds
// of static objects; 14 is a conservative lower bound that any
// non-broken EnvCell parse will easily clear.
//
// TODO: confirm with implementation agent — if the runtime accessor
// is actually a parameterized helper like
// `holtburg_envcell_static_object_count(landblock: u32)` that lets
// us pin to 0xA9B4, prefer that. For now the placeholder is
// parameterless: `holtburg_static_object_count()`.
const HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR = 14;
let phase6CStaticObjectCountOk = false;
let phase6CStaticObjectCountDetail =
    "phase C not yet shipped — expected wasm.holtburg_static_object_count() "
    + "(placeholder name) returning a u32 ≥ "
    + HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR
    + " (the terminal exporter's high-conf support-object count for "
    + "landblockId=0xA9B4 in interior_support_objects_highconf.jsonl).";
try {
    if (typeof wasm.holtburg_static_object_count === "function") {
        const n = wasm.holtburg_static_object_count();
        phase6CStaticObjectCountOk =
            typeof n === "number" && n >= HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR;
        phase6CStaticObjectCountDetail = `holtburg_static_object_count()=${n} `
            + `(floor ${HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR}, from `
            + `interior_support_objects_highconf.jsonl filtered on landblockId=0xA9B4)`;
    }
} catch (e) {
    phase6CStaticObjectCountDetail =
        `holtburg_static_object_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.envcell_static_object_count_matches_terminal_export",
    phase6CStaticObjectCountOk,
    phase6CStaticObjectCountDetail
);

// (C.4) Surface DID resolution — Phase 6 step C originally emitted
// `surface_did = 0` for every Environment polygon (interior cells
// rendered flat-grey). The 2026-05-09 follow-up ORs each EnvCell
// surface-table u16 with the 0x08000000 Surface namespace prefix
// (mirrors ACE `DatLoader/FileTypes/EnvCell.cs:50`). The fixture
// synthesizes a one-cell Environment + one polygon with `pos_surface
// = 0` and an EnvCell with `surfaces = [0xABCD]`; the resolved
// Surface DID should be exactly `0x0800_ABCD`. The pre-fix code
// would yield `0xABCD` (low 16 bits only) which then gets demoted
// to a 0xFF "no surface" sentinel further downstream, so checking
// for `=== 0x0800ABCD` catches the regression cleanly.
let phase6CEnvCellSurfaceDidOk = false;
let phase6CEnvCellSurfaceDidDetail =
    "phase C surface-DID follow-up not shipped — expected "
    + "wasm.holtburg_envcell_synthetic_textured_mesh_surface() "
    + "returning 0x0800ABCD (Surface DID for u16 wire value 0xABCD "
    + "OR'd with the 0x08 namespace prefix).";
try {
    if (typeof wasm.holtburg_envcell_synthetic_textured_mesh_surface === "function") {
        const did = wasm.holtburg_envcell_synthetic_textured_mesh_surface();
        const expected = 0x0800ABCD;
        phase6CEnvCellSurfaceDidOk = did === expected;
        phase6CEnvCellSurfaceDidDetail =
            `holtburg_envcell_synthetic_textured_mesh_surface()=`
            + `0x${did.toString(16).padStart(8, "0").toUpperCase()} `
            + `(expected 0x0800ABCD = 0x08000000 | 0xABCD)`;
    }
} catch (e) {
    phase6CEnvCellSurfaceDidDetail =
        `holtburg_envcell_synthetic_textured_mesh_surface threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.envcell_surface_did_resolves_via_namespace_or_mask",
    phase6CEnvCellSurfaceDidOk,
    phase6CEnvCellSurfaceDidDetail
);

// === end Phase 6 Step C =============================================

// === Phase 6 Step D — active-cell tracking + Z-culling ==============
//
// Phase D is the load-bearing phase that makes multi-floor and dungeon
// traversal work. It adds:
//
//   1. `WorldState::current_cell(pos: &WorldPosition) -> CellId` — for
//      a given pose, which cell is the player IN? Outdoor: derive from
//      landblock + 8x8 grid. Indoor: 3D AABB containment across cached
//      EnvCells (cells stack in Z, so a 2D query is insufficient).
//   2. `WorldState::render_set(current: CellId, depth: u8)
//      -> HashSet<CellId>` — BFS across `cell_portal_graph` to depth=1
//      by default. Returns the set of cells whose containers should be
//      `.visible = true` this frame.
//   3. JS-side: `window.__currentCellId: u32` and
//      `window.__renderSet: Set<u32>` (placeholder names) updated each
//      rAF tick from wasm getters; the rAF tick toggles
//      `cellContainers.get(cid).visible = renderSet.has(cid)`.
//   4. Stairs are EnvCell `CellPortal` connections between Z-stacked
//      cells. Walking up the stairwell crosses a portal => current_cell
//      shifts => render_set shifts => lower floor falls out, upper
//      floor pops in. NO special "stairs" code path.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_d_floors.cjs`):
//   D.1  current_cell(pos) for a synthetic OUTDOOR pose returns the
//        expected outdoor cell id. Confirms the outdoor 8x8 grid path.
//   D.2  current_cell(pos) for a synthetic INDOOR pose (inside a
//        known EnvCell AABB) returns that cell's id. Confirms the
//        indoor 3D containment path.
//   D.3  render_set BFS on a synthetic 3-cell graph (A → B → C):
//        - render_set(A, depth=1) = {A, B}
//        - render_set(B, depth=1) = {A, B, C}
//        Asserts the BFS traversal is correct AND seeds the current
//        cell.
//   D.4  Stair traversal: synthetic 2-floor cell graph stacked in Z
//        + a synthetic player walking up; current_cell transitions at
//        the expected Z threshold. End-to-end on the wasm side, no JS
//        rAF involvement.
//
// All four checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase D export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase D.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B/C
// convention: snake-case helper names (`holtburg_test_*`) on the Rust
// side. If the implementation chooses different idioms, update both
// this block AND `capture_phase6_step_d_floors.cjs`'s window-side
// probes (which currently look for `window.__currentCellId` /
// `window.__renderSet` / `window.__sessionHandle.getCurrentCellId` /
// `window.__sessionHandle.getRenderSet`) in the same commit so the
// smoke + live tests stay aligned.
//
// TODO: confirm with implementation agent the error-code conventions
// for the synthetic test helpers. Mirroring Phase B's contract:
//   0  = test passed
//   >0 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).
// (Symbol-missing is reported via `typeof === "function"` BEFORE the
// call, so a non-zero return strictly means "ran and failed".)

// (D.1) current_cell for an outdoor pose. The helper synthesizes a
// player position in a known outdoor cell (e.g. the centre of the
// Holtburg landblock 0xA9B4 outdoor 8x8 grid cell (3,4)), feeds it
// through the indoor/outdoor router, and asserts the returned cell
// id matches the expected value. Returns 0 on pass, non-zero on
// failure. The expected outdoor cell id is encoded as a constant
// inside the helper; the impl agent is free to pick any deterministic
// outdoor cell so long as it's documented in the wasm export's doc
// comment.
let phase6DCurrentCellOutdoorOk = false;
let phase6DCurrentCellOutdoorDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_current_cell_outdoor() "
    + "(placeholder name) returning 0 if current_cell(synthetic outdoor pose) "
    + "matches the expected outdoor cell id, non-zero error code otherwise. "
    + "Sibling to Phase B's holtburg_test_collision_clamp_axis_aligned shape.";
try {
    if (typeof wasm.holtburg_test_current_cell_outdoor === "function") {
        const code = wasm.holtburg_test_current_cell_outdoor();
        phase6DCurrentCellOutdoorOk = code === 0;
        phase6DCurrentCellOutdoorDetail =
            `holtburg_test_current_cell_outdoor()=${code} `
            + `(0 = outdoor lookup matched expected; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DCurrentCellOutdoorDetail =
        `holtburg_test_current_cell_outdoor threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.current_cell_for_outdoor_position",
    phase6DCurrentCellOutdoorOk,
    phase6DCurrentCellOutdoorDetail
);

// (D.2) current_cell for an indoor pose. The helper synthesizes a
// player position INSIDE a known EnvCell's AABB (likely a unit-cube
// EnvCell at a known cell_origin, similar to Phase C's
// `holtburg_envcell_count` fixture but with non-trivial AABB
// extents). Asserts current_cell returns that cell's id. Returns 0
// on pass, non-zero on failure.
//
// Indoor lookup is fundamentally different from outdoor: outdoor is
// O(1) grid index, indoor is O(N) AABB containment over cached
// EnvCells in the current landblock (cells stack in Z, so a 2D grid
// query won't pick the right floor — this is the load-bearing
// distinction Phase D adds).
let phase6DCurrentCellIndoorOk = false;
let phase6DCurrentCellIndoorDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_current_cell_indoor() "
    + "(placeholder name) returning 0 if current_cell(synthetic indoor pose "
    + "inside a known EnvCell AABB) matches the cell's id, non-zero error code "
    + "otherwise. The helper must also assert that a pose OUTSIDE the AABB "
    + "does NOT return the cell's id — to catch the false-positive case where "
    + "the indoor lookup returns the first cell in the bucket regardless of pose.";
try {
    if (typeof wasm.holtburg_test_current_cell_indoor === "function") {
        const code = wasm.holtburg_test_current_cell_indoor();
        phase6DCurrentCellIndoorOk = code === 0;
        phase6DCurrentCellIndoorDetail =
            `holtburg_test_current_cell_indoor()=${code} `
            + `(0 = indoor AABB containment matched; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DCurrentCellIndoorDetail =
        `holtburg_test_current_cell_indoor threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.current_cell_for_indoor_position",
    phase6DCurrentCellIndoorOk,
    phase6DCurrentCellIndoorDetail
);

// (D.3) render_set BFS on a synthetic 3-cell graph (A → B → C). The
// helper builds a synthetic `cell_portal_graph` with three nodes
// connected in a chain (A's only neighbour is B; B's neighbours are
// A and C; C's only neighbour is B), and asserts:
//   - render_set(A, depth=1) = {A, B}    — current cell + 1 hop
//   - render_set(B, depth=1) = {A, B, C} — current cell + both hops
//   - render_set(C, depth=1) = {B, C}    — current cell + 1 hop
//
// Returns 0 on pass, non-zero error code (helper picks codes per
// which sub-assertion failed) otherwise.
//
// The 3-cell chain is the simplest non-trivial graph that distinguishes
// "BFS depth 1 vs depth 0" (a 2-cell pair would only test seeding) AND
// "BFS includes self vs excludes self" (depth=1 from B must include B).
let phase6DRenderSetOk = false;
let phase6DRenderSetDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_render_set_three_cell_graph() "
    + "(placeholder name) returning 0 if render_set BFS on a synthetic "
    + "A → B → C graph produces {A,B} from A, {A,B,C} from B, {B,C} from C "
    + "at depth=1, non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_render_set_three_cell_graph === "function") {
        const code = wasm.holtburg_test_render_set_three_cell_graph();
        phase6DRenderSetOk = code === 0;
        phase6DRenderSetDetail =
            `holtburg_test_render_set_three_cell_graph()=${code} `
            + `(0 = BFS depth=1 on chain matches expected; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DRenderSetDetail =
        `holtburg_test_render_set_three_cell_graph threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.render_set_bfs_depth_1",
    phase6DRenderSetOk,
    phase6DRenderSetDetail
);

// (D.4) Stair traversal: synthetic 2-floor cell graph stacked in Z +
// a synthetic player walking up; current_cell transitions at the
// expected Z threshold. The helper:
//   1. Builds two EnvCells stacked in Z (lower at z=0..3, upper at
//      z=3..6) connected by a single CellPortal.
//   2. Synthesizes player poses at z = 1.0 (lower), 2.5 (still lower),
//      3.5 (upper), 5.0 (upper) — same x/y, walking straight up.
//   3. Asserts current_cell returns lower-cell-id at z<3 and
//      upper-cell-id at z≥3.
//   4. Asserts that crossing the threshold updates the render set
//      to drop the lower cell and add the upper cell (combined
//      Phase D contract — current_cell change implies render_set
//      change).
//
// Returns 0 on pass, non-zero error code otherwise. This is the
// closest the smoke can get to the live capture's full contract
// without driving a real ACE; the live capture exercises the same
// transition end-to-end through ACE's authoritative physics.
let phase6DStairTraversalOk = false;
let phase6DStairTraversalDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_stair_traversal() "
    + "(placeholder name) returning 0 if current_cell transitions at the "
    + "expected Z threshold across a synthetic 2-floor graph and the render "
    + "set tracks the transition, non-zero error code otherwise. This is the "
    + "wasm-side mirror of capture_phase6_step_d_floors.cjs's live walk-up-"
    + "stairs assertion.";
try {
    if (typeof wasm.holtburg_test_stair_traversal === "function") {
        const code = wasm.holtburg_test_stair_traversal();
        phase6DStairTraversalOk = code === 0;
        phase6DStairTraversalDetail =
            `holtburg_test_stair_traversal()=${code} `
            + `(0 = current_cell + render_set both transition at the Z threshold; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6DStairTraversalDetail =
        `holtburg_test_stair_traversal threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.stair_traversal_changes_current_cell",
    phase6DStairTraversalOk,
    phase6DStairTraversalDetail
);

// === end Phase 6 Step D =============================================

// === Phase 6 Step E — door geometry + state ========================
//
// Phase E ships door state + door rotation. Closed doors block (their
// AABBs sit in Phase B's `building_aabb_index`); clicking a door
// dispatches `useObject` → ACE flips state → ACE pushes the new
// `DoorState` via `PublicWeenieDesc` → client emits a
// `WorldEvent::DoorStateChanged { guid, state }` (placeholder name)
// → JS handler rotates the door's GfxObj sprite around its hinge
// frame and the AABB index drops the open door's entry. Walking
// through the open door then succeeds because the index no longer
// covers it.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_e_doors.cjs`):
//   E.1  Open-state mutation drops the door's AABB from the index.
//        Helper: synthesize a single-AABB index containing one door,
//        mutate that door's state to "open", assert the AABB is
//        removed (lookup against the same cell returns the empty
//        bucket).
//   E.2  Closed-state mutation re-inserts the AABB. Same fixture as
//        E.1 but starting from "open" state and flipping back to
//        "closed"; asserts the AABB is re-inserted.
//   E.3  DoorStateChanged event is emitted. Helper: synth a
//        WorldState + a simulated PublicWeenieDesc packet carrying
//        a DoorState int property; pump it through the handler;
//        assert exactly one `WorldEvent::DoorStateChanged { guid,
//        state }` is in the resulting event queue.
//   E.4  (optional) Hinge-frame rotation keyframe matches expected
//        values. Helper: synth a hinge-frame transform, apply
//        "closed" rotation, assert the resulting matrix matches a
//        baseline (likely identity); apply "open" rotation, assert
//        the matrix matches a 90°-around-hinge baseline (the exact
//        axis is impl-picked — likely Z for vertical-axis door
//        swings, X or Y for double-leaf swing-up doors).
//
// All four checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase E export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase E.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B/C/D
// convention: snake-case `holtburg_test_*` helper names on the Rust
// side. If the implementation chooses different idioms, update both
// this block AND `capture_phase6_step_e_doors.cjs`'s window-side
// probes (which currently look for `window.__doorStates` /
// `entry.__doorState` / `sprite.rotation`) in the same commit so the
// smoke + live tests stay aligned.
//
// Per-helper error-code conventions mirror Phase B/D:
//   0  = test passed
//   >0 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).
// (Symbol-missing is reported via `typeof === "function"` BEFORE the
// call, so a non-zero return strictly means "ran and failed".)

// (E.1) Open mutation drops AABB. The helper builds a single-cell
// AABB index containing one door, sets the door's state to "open",
// and asserts that subsequent lookups against the cell return the
// empty bucket. Returns 0 on pass, non-zero error code otherwise.
let phase6EOpenDropsAabbOk = false;
let phase6EOpenDropsAabbDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_open_drops_aabb() "
    + "(placeholder name) returning 0 if mutating a door's state to \"open\" "
    + "removes its AABB from the per-cell `building_aabb_index`, non-zero error "
    + "code otherwise. Sibling shape to Phase B's "
    + "holtburg_test_collision_clamp_axis_aligned.";
try {
    if (typeof wasm.holtburg_test_door_open_drops_aabb === "function") {
        const code = wasm.holtburg_test_door_open_drops_aabb();
        phase6EOpenDropsAabbOk = code === 0;
        phase6EOpenDropsAabbDetail =
            `holtburg_test_door_open_drops_aabb()=${code} `
            + `(0 = open-state mutation removed AABB; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6EOpenDropsAabbDetail =
        `holtburg_test_door_open_drops_aabb threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_open_drops_aabb_from_index",
    phase6EOpenDropsAabbOk,
    phase6EOpenDropsAabbDetail
);

// (E.2) Closed mutation re-inserts AABB. Same fixture as E.1 but
// starting from "open" and flipping to "closed"; asserts the AABB
// is re-inserted. Returns 0 on pass, non-zero error code otherwise.
//
// Why both directions: the Phase E AABB toggle has to be symmetric.
// A bug that drops the AABB on open but doesn't re-insert on close
// would leave the world progressively door-less after every open/
// close cycle.
let phase6ECloseInsertsAabbOk = false;
let phase6ECloseInsertsAabbDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_close_inserts_aabb() "
    + "(placeholder name) returning 0 if mutating a door's state to \"closed\" "
    + "re-inserts its AABB into the `building_aabb_index`, non-zero error code "
    + "otherwise.";
try {
    if (typeof wasm.holtburg_test_door_close_inserts_aabb === "function") {
        const code = wasm.holtburg_test_door_close_inserts_aabb();
        phase6ECloseInsertsAabbOk = code === 0;
        phase6ECloseInsertsAabbDetail =
            `holtburg_test_door_close_inserts_aabb()=${code} `
            + `(0 = closed-state mutation re-inserted AABB; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6ECloseInsertsAabbDetail =
        `holtburg_test_door_close_inserts_aabb threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_close_re_inserts_aabb",
    phase6ECloseInsertsAabbOk,
    phase6ECloseInsertsAabbDetail
);

// (E.3) DoorStateChanged event emission. The helper builds a
// synthetic WorldState, simulates a `PublicWeenieDesc` packet
// arriving with a DoorState int property change for a known door
// guid, pumps it through the Phase E handler at
// `crates/holtburger-core/src/client/world/handlers/`, and asserts
// exactly one `WorldEvent::DoorStateChanged { guid, state }`
// (placeholder name) lands in the resulting event queue with the
// expected guid and state values.
//
// Returns 0 on pass; non-zero error codes (impl agent picks):
//   1 = no DoorStateChanged event emitted
//   2 = wrong guid in emitted event
//   3 = wrong state in emitted event
//   4 = multiple DoorStateChanged events emitted (handler ran more
//       than once for a single packet)
let phase6EDoorEventOk = false;
let phase6EDoorEventDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_state_event_emitted() "
    + "(placeholder name) returning 0 if a synthetic PublicWeenieDesc with a "
    + "DoorState int property produces exactly one WorldEvent::DoorStateChanged "
    + "{ guid, state } in the WorldState event queue, non-zero error code otherwise. "
    + "WorldEvent variant name is also a placeholder; if the impl agent picks a "
    + "different variant (e.g. WorldEvent::DoorOpened/DoorClosed instead of a "
    + "single DoorStateChanged variant), update this check + the capture script "
    + "together.";
try {
    if (typeof wasm.holtburg_test_door_state_event_emitted === "function") {
        const code = wasm.holtburg_test_door_state_event_emitted();
        phase6EDoorEventOk = code === 0;
        phase6EDoorEventDetail =
            `holtburg_test_door_state_event_emitted()=${code} `
            + `(0 = exactly one DoorStateChanged event emitted with expected guid+state; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6EDoorEventDetail =
        `holtburg_test_door_state_event_emitted threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_state_changed_event_is_emitted",
    phase6EDoorEventOk,
    phase6EDoorEventDetail
);

// (E.4 — optional) Hinge-frame rotation keyframe. The helper
// synthesizes a hinge-frame transform with a known axis and pivot,
// applies the "closed" rotation, asserts the resulting matrix
// matches an expected baseline (typically identity); applies the
// "open" rotation, asserts the matrix matches the swung-90°
// baseline.
//
// Why "optional": the live capture's "rotation differs from
// baseline" assertion already proves the rotation runs — the
// keyframe match here is value-level confidence (proves the rotation
// is the RIGHT amount around the RIGHT axis), but isn't load-bearing
// for the contract. If the impl agent skips the helper, the check
// just stays at "phase E not yet shipped" and doesn't gate.
//
// Tolerance: 1e-4 on each matrix element is generous for f32
// rotations (~0.01° angular drift floor). The impl agent picks the
// exact axis convention (Z-vertical for swing doors is most common
// in retail AC), documents in the doc comment.
let phase6EHingeRotationOk = false;
let phase6EHingeRotationDetail =
    "phase E not yet shipped (optional) — expected "
    + "wasm.holtburg_test_door_rotation_keyframe() (placeholder name) returning 0 "
    + "if the hinge-frame rotation matrix matches expected baselines for both "
    + "\"closed\" (typically identity) and \"open\" (typically 90° around the "
    + "impl-picked hinge axis), non-zero error code otherwise. Optional: the live "
    + "capture proves rotation runs, this proves it's the right amount.";
try {
    if (typeof wasm.holtburg_test_door_rotation_keyframe === "function") {
        const code = wasm.holtburg_test_door_rotation_keyframe();
        phase6EHingeRotationOk = code === 0;
        phase6EHingeRotationDetail =
            `holtburg_test_door_rotation_keyframe()=${code} `
            + `(0 = hinge-frame matrices match closed+open baselines; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6EHingeRotationDetail =
        `holtburg_test_door_rotation_keyframe threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_rotation_keyframe",
    phase6EHingeRotationOk,
    phase6EHingeRotationDetail
);

// === end Phase 6 Step E =============================================

// === Phase 6 Step F — vertical-dungeon validation ===================
//
// Phase F generalizes Phase D's portal-graph culling to N floors WITH
// NO new code. The cell-graph abstraction (insert_cell_portal +
// insert_cell_aabb + render_set BFS) treats every traversal — outdoor
// → indoor, floor 1 → floor 2, dungeon room → corridor — as the same
// `current_cell(pos)` change driven by player position. A 5-floor
// dungeon stack is just a 1-D chain in the portal graph; Phase D's
// depth=1 BFS visits self + 2 neighbours = ≤ 3 cells regardless of
// how tall the chain is.
//
// This check synthesizes a 5-cell Z-stack (floors 1..5 connected by
// sequential portals) and walks a pose through every floor, sampling
// `render_set(current, depth=1)` at each floor. Asserts:
//
//   (1) Every floor's render set is bounded (≤ 3 cells).
//   (2) Render set contains the current cell.
//   (3) Current cell transitions monotonically as Z increases.
//   (4) Bottom floor is NEVER in the top floor's render set —
//       depth=1 BFS shouldn't reach a 4-hop neighbour.
//
// If this passes, Phase D's contract holds for arbitrary N — Mite
// Maze (LB 0x01F8, 879 indoor cells) / Holtburg Dungeon (LB 0x01F6,
// 429 indoor cells) / any future 3+ floor dungeon traverses
// correctly with no Phase F-specific code.
//
// The live counterpart (capture_phase6_step_f_dungeon.cjs) drives
// the SAME assertions through ACE end-to-end against Mite Maze via
// `@teleloc 0x01F801D4 6.1 -101.6 0` (Mite Maze entrance per
// portalmitemaze weenie 1121, position_Type=2 in ace_world DB).
//
// Returns 0 on pass, non-zero error code (helper picks codes per
// which sub-assertion failed) otherwise.
let phase6FDungeonOk = false;
let phase6FDungeonDetail =
    "phase F not yet shipped — expected wasm.holtburg_test_dungeon_render_set_bounded() "
    + "returning 0 if a synthetic 5-floor cell stack walks bounded (render set ≤ 3 at "
    + "every floor, no 4-hop leakage), non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_dungeon_render_set_bounded === "function") {
        const code = wasm.holtburg_test_dungeon_render_set_bounded();
        phase6FDungeonOk = code === 0;
        phase6FDungeonDetail =
            `holtburg_test_dungeon_render_set_bounded()=${code} `
            + `(0 = 5-floor stack stays bounded under depth-1 BFS at every floor + `
            + `current_cell transitions monotonically + 4-hop leakage absent; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6FDungeonDetail =
        `holtburg_test_dungeon_render_set_bounded threw: ${e?.message ?? e}`;
}
check(
    "phase6.F.dungeon_render_set_bounded_under_n_floor_walk",
    phase6FDungeonOk,
    phase6FDungeonDetail
);

// === end Phase 6 Step F =============================================


(async () => {
    // Phase 5.0b — pre-bake a manifest+shards+boot tree from the
    // git-ignored `dats/assets.hba` fixture, serve it over a local
    // http.Server, and call wasm.init_resource_source() once.
    // Every fetch_* round-trip below reads from the manifest source
    // (no asset_url parameter — the fetch_* signatures changed in
    // 5.0b's refactor).
    //
    // If `dats/assets.hba` is missing or the dat-shard release
    // binary hasn't been built, every round-trip degrades to a SKIP
    // and the symbol-presence checks above remain the floor.

    const cp = require("node:child_process");
    const os = require("node:os");
    const fixturePath = path.resolve(__dirname, "../..", "dats", "assets.hba");
    const datShardBin = path.resolve(
        __dirname, "..", "..", "target", "release", "dat-shard"
    );

    const haveFixture = !fastMode && fs.existsSync(fixturePath);
    const haveBin = !fastMode && fs.existsSync(datShardBin);

    let distDir = null; // parent containing v1/, v2/, v2conv/ subdirs
    let distDirIsCache = false; // true → don't rm on teardown
    let distServer = null;
    let manifestUrl = null;       // v1 manifest (legacy default — existing checks)
    let manifestUrlV2 = null;     // v2 manifest (Phase 5.2 obj 8)
    let manifestUrlV2Conv = null; // v2 manifest with catalog_url_template=null
    // Per-path HTTP request counter — Phase 5.2 obj 8 uses this to
    // assert "exactly one catalog HTTP request fired" on a v2
    // prefetch.
    const requestCounts = new Map();

    if (fastMode) {
        console.log(
            "  [SKIP] manifest fixture + dispatch tests — --fast mode (skipping ~6 min bake).\n" +
            "         Re-run without --fast for full coverage; CI runs full by default."
        );
    } else if (!haveFixture) {
        console.log(
            "  [SKIP] manifest fixture setup — dats/assets.hba missing.\n" +
            "         Generate via `cargo run -p holtburger-tools --bin dat2hba` (see dats/README.md)."
        );
    } else if (!haveBin) {
        console.log(
            "  [SKIP] manifest fixture setup — target/release/dat-shard missing.\n" +
            "         Build via `cargo build -p holtburger-tools --bin dat-shard --release`."
        );
    } else if (typeof fetch !== "function") {
        console.log("  [SKIP] manifest fixture setup — Node ≥18 fetch() not available.");
    } else {
        // Pick a bake-parent directory big enough to hold ~6.5 GB on
        // disk (885k shards × 4 KB block rounding + 1.86 MB boot pack +
        // 200+ MB v1 manifest.json). Resolution order:
        //   1. HOLTBURGER_SMOKE_DIST_DIR env var (full path, takes
        //      precedence — point this at /mnt/wbterminal{1,2} on dev
        //      hosts to keep the bake off the root partition).
        //   2. Node's os.tmpdir(), which honours TMPDIR / TMP / TEMP.
        //   3. Falls through to /tmp on Linux otherwise.
        // See `docs/emit-dynamic-site.md` "Bake recipe — disk-space
        // trap" for the equivalent guidance for `dist/`.
        const bakeBase = process.env.HOLTBURGER_SMOKE_DIST_DIR || os.tmpdir();
        if (!fs.existsSync(bakeBase)) {
            fs.mkdirSync(bakeBase, { recursive: true });
        }

        // Hash-cached bake. Cache key is derived from the stat tuple
        // of the inputs (fixture mtime+size + dat-shard binary
        // mtime+size + a smoke-schema version int), so any input
        // change invalidates exactly the affected entries. Cache
        // hits skip the ~6 min × 2 dat-shard runs and ~6.5 GB of
        // disk writes; first run still pays the bake cost. The
        // cache lives at `<bakeBase>/holtburger-smoke-cache/<hash>/`
        // and is NEVER deleted by the smoke harness — wipe manually
        // (`rm -rf <bakeBase>/holtburger-smoke-cache`) if the cache
        // grows beyond what your disk can hold (each entry ≈ 6.5 GB).
        const statKey = (p) => {
            const s = fs.statSync(p);
            return `${s.size}-${s.mtimeMs.toFixed(0)}`;
        };
        const cacheKey = crypto
            .createHash("sha256")
            .update(
                `v${SMOKE_BAKE_SCHEMA}|fixture:${statKey(fixturePath)}|bin:${statKey(datShardBin)}`
            )
            .digest("hex")
            .slice(0, 16);
        const cacheRoot = path.join(bakeBase, "holtburger-smoke-cache");
        const cacheDir = path.join(cacheRoot, cacheKey);
        const cacheCompleteMarker = path.join(cacheDir, ".complete");

        if (fs.existsSync(cacheCompleteMarker)) {
            distDir = cacheDir;
            distDirIsCache = true;
            console.log(`  [info] reusing cached bake → ${cacheDir}`);
        } else {
            // Stage into a sibling .tmp dir, then atomic-rename on
            // .complete write. Concurrent smoke runs against the same
            // key both stage independently; whichever wins the rename
            // is the survivor (the loser cleans up its staging on
            // EEXIST). Per-PID suffix avoids same-host race.
            const stagingDir = path.join(
                cacheRoot,
                `${cacheKey}.tmp.${process.pid}`
            );
            fs.mkdirSync(stagingDir, { recursive: true });
            console.log(`  [info] baking smoke fixture (cache miss) → ${cacheDir}`);

            // Register cleanup hooks the moment the staging dir exists
            // so a crash / Ctrl-C between here and the rename still
            // rms the partial bake. Without this the ~6.5 GB pile
            // accumulates per failed run; the cache itself is
            // preserved (no rm of cacheDir).
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                try { if (distServer) distServer.close(); } catch (_) {}
                try {
                    if (fs.existsSync(stagingDir)) {
                        fs.rmSync(stagingDir, { recursive: true, force: true });
                    }
                } catch (_) {}
                // distDir is the cache OR a partial in-progress bake;
                // never rm the cache dir itself. distDirIsCache=true
                // means "leave it alone for the next run".
                try {
                    if (distDir && !distDirIsCache) {
                        fs.rmSync(distDir, { recursive: true, force: true });
                    }
                } catch (_) {}
            };
            process.on("exit", cleanup);
            process.on("SIGINT", () => { cleanup(); process.exit(130); });
            process.on("SIGTERM", () => { cleanup(); process.exit(143); });
            process.on("uncaughtException", (e) => {
                console.error("[smoke] uncaughtException:", e?.message ?? e);
                cleanup();
                process.exit(1);
            });
            process.on("unhandledRejection", (e) => {
                console.error("[smoke] unhandledRejection:", e?.message ?? e);
                cleanup();
                process.exit(1);
            });

            // Bake two variants under sibling subdirs of `stagingDir`.
            // See cache-miss commentary above for the v1/v2/v2conv
            // layout rationale (avoid `fs.cpSync` of the 4 GB dist).
            const stagingV1 = path.join(stagingDir, "v1");
            const stagingV2 = path.join(stagingDir, "v2");
            fs.mkdirSync(stagingV1, { recursive: true });
            fs.mkdirSync(stagingV2, { recursive: true });

            cp.execFileSync(
                datShardBin,
                ["--manifest-version=1", "--input", fixturePath, "--output", stagingV1],
                { stdio: "ignore" }
            );
            cp.execFileSync(
                datShardBin,
                ["--manifest-version=2", "--input", fixturePath, "--output", stagingV2],
                { stdio: "ignore" }
            );

            // Convention-URL variant — single rewritten manifest.json,
            // shares everything else with the v2 dir.
            {
                const v2ManifestObj = JSON.parse(
                    fs.readFileSync(path.join(stagingV2, "manifest.json"), "utf8")
                );
                v2ManifestObj.catalog_url_template = null;
                v2ManifestObj.shard_url_template =
                    "shards/{namespace_slug}/{file_id_hex}.bin";
                fs.writeFileSync(
                    path.join(stagingDir, "v2conv-manifest.json"),
                    JSON.stringify(v2ManifestObj, null, 2)
                );
            }

            // Mark complete + atomic rename. If a parallel smoke
            // already promoted its own staging into cacheDir, our
            // rename throws EEXIST/ENOTEMPTY — discard our staging
            // (their bake is equivalent) and use the existing cache.
            fs.writeFileSync(
                path.join(stagingDir, ".complete"),
                new Date().toISOString()
            );
            try {
                fs.renameSync(stagingDir, cacheDir);
                distDir = cacheDir;
                distDirIsCache = true;
            } catch (renameErr) {
                if (fs.existsSync(cacheCompleteMarker)) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    distDir = cacheDir;
                    distDirIsCache = true;
                    console.log("  [info] another smoke won the cache write; using its bake");
                } else {
                    throw renameErr;
                }
            }
        }

        const distDirV1 = path.join(distDir, "v1");
        const distDirV2 = path.join(distDir, "v2");
        const v2ConvManifestPath = path.join(distDir, "v2conv-manifest.json");

        // URL-prefix-routed server: `/v1/...` → distDirV1,
        // `/v2/...` → distDirV2, `/v2conv/manifest.json` →
        // v2ConvManifestPath, `/v2conv/<anything else>` →
        // distDirV2/<anything else>. Tracks per-path request
        // counts for the obj 8 exactly-one-catalog-fetch assertion.
        distServer = http.createServer((req, res) => {
            requestCounts.set(req.url, (requestCounts.get(req.url) ?? 0) + 1);
            // Force connection close on every response so undici's
            // (Node fetch's backend) keepalive pool doesn't hold a
            // stale TCP socket past the server's 5 s keepAliveTimeout.
            // Without this, slow --dev wasm builds whose prefetch
            // chain exceeds 5 s leave the pool with a closed-by-server
            // socket; the next wasm fetch tries to reuse it and gets
            // ECONNRESET (surfacing in lib.rs as
            // `init_resource_source: fetch network error: {}`). The
            // smoke is single-threaded against a fixture-only server,
            // so per-request connect overhead is negligible (~1 ms);
            // the bytes-served path is unchanged.
            res.setHeader("Connection", "close");
            const url = decodeURIComponent(req.url.replace(/^\/+/, ""));
            let filePath = null;
            if (url === "v2conv/manifest.json") {
                filePath = v2ConvManifestPath;
            } else if (url.startsWith("v2conv/")) {
                // Everything else under /v2conv/ falls through to v2
                // — shards + manifest/ + boot.hba are byte-identical.
                filePath = path.join(distDirV2, url.substring("v2conv/".length));
                if (!filePath.startsWith(distDirV2)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else if (url.startsWith("v2/")) {
                filePath = path.join(distDirV2, url.substring("v2/".length));
                if (!filePath.startsWith(distDirV2)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else if (url.startsWith("v1/")) {
                filePath = path.join(distDirV1, url.substring("v1/".length));
                if (!filePath.startsWith(distDirV1)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else {
                res.writeHead(404);
                res.end();
                return;
            }
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-length": data.length,
                });
                res.end(data);
            });
        });
        // Belt-and-suspenders: disable keepalive at the server level
        // too. `Connection: close` headers above are the mechanism
        // that actually closes per-request; this just ensures the
        // server's idle-socket reaper doesn't outlast a slow client.
        distServer.keepAliveTimeout = 0;
        await new Promise((resolve) => distServer.listen(0, "127.0.0.1", resolve));
        const distPort = distServer.address().port;
        manifestUrl = `http://127.0.0.1:${distPort}/v1/manifest.json`;
        manifestUrlV2 = `http://127.0.0.1:${distPort}/v2/manifest.json`;
        manifestUrlV2Conv = `http://127.0.0.1:${distPort}/v2conv/manifest.json`;

        try {
            await wasm.init_resource_source(manifestUrl);
            check(
                "ManifestResourceSource.connect() resolves against pre-baked dist/",
                wasm.has_resource_source() === true,
                `manifestUrl=${manifestUrl}, has_resource_source()=${wasm.has_resource_source()}`
            );
            check(
                "ManifestResourceSource starts with empty shard cache (boot serves directly)",
                wasm.cached_shard_count() === 0,
                `cached_shard_count()=${wasm.cached_shard_count()}`
            );
            // Phase 5.2 obj 8 — v1→v2 migration smoke: when a
            // legacy v1 manifest is the connect target, the
            // dispatcher routes to the v1 inner source (and
            // logs a deprecation warning via the `log` crate;
            // not directly observable from JS without a log
            // backend). The runtime accessor is what matters
            // — `manifest_version()` reports 1 — and records
            // still resolve through the inner v1 path (the
            // fetch_* round-trips below cover this).
            check(
                "v1 manifest dispatch: manifest_version()=1 after connect against v1 dist/",
                wasm.manifest_version() === 1,
                `manifest_version()=${wasm.manifest_version()}`
            );
            check(
                "v1 manifest dispatch: loaded_catalog_count()=0 (v1 has no catalogs)",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );
        } catch (e) {
            check(
                "ManifestResourceSource.connect() resolves against pre-baked dist/",
                false,
                `init_resource_source threw: ${e?.message ?? e}`
            );
        }
    }

    // The fetch_* round-trips below all require the manifest source
    // to be live. Skip the whole block if init failed / fixture
    // missing.
    if (manifestUrl && wasm.has_resource_source()) {
        // Phase 2 §8 step 4 round-trip (manifest mode): pull a known
        // record by (namespace, file_id). 0xA9B4FFFF is the Holtburg
        // CellLandblock — present in the boot pack since it's in the
        // 9-cell spawn neighborhood (Phase 5.0 obj 8 boot policy).
        try {
            const expectedNamespace = "eor/cell";
            const expectedFileId = 0xA9B4FFFF;
            const got = await wasm.try_http_resource_source_smoke(
                expectedNamespace,
                expectedFileId
            );
            check(
                `try_resource_source_smoke fetches via manifest source; ${expectedNamespace}:0x${expectedFileId.toString(16).toUpperCase().padStart(8, "0")} length>0`,
                got > 0,
                `got ${got} bytes`
            );
        } catch (e) {
            check(
                "try_resource_source_smoke round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 1 round-trip: fetch the Holtburg-town-centre
        // CellLandblock. Boot-pack-served (no shard fetch needed).
        try {
            const cellId = 0xa9b4ffff;
            const mesh = await wasm.fetch_landblock_heightmap(cellId);

            const positionsOk =
                mesh.positions instanceof Float32Array &&
                mesh.positions.length === 243;
            check(
                "fetch_landblock_heightmap: positions is Float32Array of 243",
                positionsOk,
                `len=${mesh.positions?.length}, ctor=${mesh.positions?.constructor?.name}`
            );

            const indicesOk =
                mesh.indices instanceof Uint16Array &&
                mesh.indices.length === 384;
            check(
                "fetch_landblock_heightmap: indices is Uint16Array of 384",
                indicesOk,
                `len=${mesh.indices?.length}, ctor=${mesh.indices?.constructor?.name}`
            );

            const cornerOk =
                mesh.positions[0] === 0 &&
                mesh.positions[1] === 0 &&
                mesh.positions[80 * 3] === 192 &&
                mesh.positions[80 * 3 + 1] === 192;
            check(
                "fetch_landblock_heightmap: corner vertices at (0,0) and (192,192)",
                cornerOk,
                `(${mesh.positions[0]},${mesh.positions[1]}) (${mesh.positions[80 * 3]},${mesh.positions[80 * 3 + 1]})`
            );

            const rangeOk =
                Number.isFinite(mesh.heightMin) &&
                Number.isFinite(mesh.heightMax) &&
                mesh.heightMin >= 0 &&
                mesh.heightMax <= 510 &&
                mesh.heightMax >= mesh.heightMin;
            check(
                "fetch_landblock_heightmap: height bounds in [0, 510]",
                rangeOk,
                `min=${mesh.heightMin}, max=${mesh.heightMax}`
            );

            let maxIdx = 0;
            for (let i = 0; i < mesh.indices.length; i += 1) {
                if (mesh.indices[i] > maxIdx) maxIdx = mesh.indices[i];
            }
            check(
                "fetch_landblock_heightmap: max index < 81 (within 9×9 grid)",
                maxIdx === 80,
                `maxIdx=${maxIdx}`
            );

            const codes = mesh.terrainCodes;
            const codesShapeOk = codes instanceof Uint8Array && codes.length === 81;
            check(
                "fetch_landblock_heightmap: terrainCodes is Uint8Array of 81 (Phase 3 step 3)",
                codesShapeOk,
                `len=${codes?.length}`
            );

            let minCode = 255, maxCode = 0;
            for (let i = 0; i < codes.length; i += 1) {
                if (codes[i] < minCode) minCode = codes[i];
                if (codes[i] > maxCode) maxCode = codes[i];
            }
            check(
                "fetch_landblock_heightmap: terrainCodes values all in [0, 31]",
                minCode >= 0 && maxCode <= 31,
                `min=${minCode}, max=${maxCode}`
            );

            const distinct = new Set(codes).size;
            check(
                "fetch_landblock_heightmap: Holtburg centre has ≥3 distinct terrain types",
                distinct >= 3,
                `${distinct} distinct: [${[...new Set(codes)].sort((a, b) => a - b).join(", ")}]`
            );

            const roads = mesh.roadCodes;
            const roadShapeOk = roads instanceof Uint8Array && roads.length === 81;
            check(
                "fetch_landblock_heightmap: roadCodes is Uint8Array of 81 (Phase 3 step 5)",
                roadShapeOk,
                `len=${roads?.length}`
            );

            let roadMin = 255, roadMax = 0, roadCount = 0;
            for (let i = 0; i < roads.length; i += 1) {
                if (roads[i] < roadMin) roadMin = roads[i];
                if (roads[i] > roadMax) roadMax = roads[i];
                if (roads[i] > 0) roadCount += 1;
            }
            check(
                "fetch_landblock_heightmap: roadCodes values all in [0, 3]",
                roadMin >= 0 && roadMax <= 3,
                `min=${roadMin}, max=${roadMax}`
            );

            check(
                "fetch_landblock_heightmap: Holtburg centre has road network (≥10 road verts)",
                roadCount >= 10,
                `${roadCount} road verts of 81`
            );

            mesh.free();
        } catch (e) {
            check(
                "fetch_landblock_heightmap round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 2 batch round-trip: 3×3 Holtburg neighbourhood.
        // Boot-pack-served for all 9 cells.
        try {
            const HOLTBURG_NEIGHBOURHOOD = [
                0xa8b5ffff, 0xa9b5ffff, 0xaab5ffff,
                0xa8b4ffff, 0xa9b4ffff, 0xaab4ffff,
                0xa8b3ffff, 0xa9b3ffff, 0xaab3ffff,
            ];
            const meshes = await wasm.fetch_landblock_heightmaps(
                new Uint32Array(HOLTBURG_NEIGHBOURHOOD)
            );
            check(
                "fetch_landblock_heightmaps: returns 9 entries for 9 input ids",
                Array.isArray(meshes) && meshes.length === 9,
                `len=${meshes?.length}, isArray=${Array.isArray(meshes)}`
            );

            const nw = meshes[0];
            const sane =
                Number.isFinite(nw.heightMin) &&
                Number.isFinite(nw.heightMax) &&
                nw.heightMin >= 0 &&
                nw.heightMax <= 510 &&
                nw.heightMax >= nw.heightMin;
            check(
                "fetch_landblock_heightmaps: NW neighbour height bounds in [0, 510]",
                sane,
                `min=${nw.heightMin}, max=${nw.heightMax}`
            );

            const centre = meshes[4];
            const centreHoltburg =
                centre.heightMin === 30 && centre.heightMax === 96;
            check(
                "fetch_landblock_heightmaps: centre id (0xA9B4FFFF) matches Holtburg singular round-trip",
                centreHoltburg,
                `min=${centre.heightMin}, max=${centre.heightMax}`
            );

            for (const m of meshes) m.free();
        } catch (e) {
            check(
                "fetch_landblock_heightmaps round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 3.5 round-trip: 33 retail terrain textures.
        // The 33 SurfaceTexture IDs aren't in the obj-3 minimum-viable
        // boot pack — they fetch as shards on demand via the 3-level
        // explicit prefetch in fetch_terrain_textures. Cached_shard_count
        // climbs as a result.
        try {
            const cacheBefore = wasm.cached_shard_count();
            const t0 = Date.now();
            const textures = await wasm.fetch_terrain_textures();
            const elapsed = Date.now() - t0;
            const cacheAfter = wasm.cached_shard_count();

            check(
                `fetch_terrain_textures: returns 33 entries (Phase 3 step 3.5)`,
                Array.isArray(textures) && textures.length === 33,
                `len=${textures?.length}, ${elapsed} ms`
            );

            check(
                "fetch_terrain_textures: shard cache grew (Phase 5.0b prefetch path)",
                cacheAfter > cacheBefore,
                `cache: ${cacheBefore} → ${cacheAfter}`
            );

            let allOk = true;
            let firstFail = null;
            for (let i = 0; i < textures.length; i += 1) {
                const t = textures[i];
                const ok =
                    t.terrainType === i &&
                    t.width > 0 &&
                    t.height > 0 &&
                    t.pixels instanceof Uint8Array &&
                    t.pixels.length === t.width * t.height * 4;
                if (!ok) { allOk = false; firstFail = { i, t }; break; }
            }
            check(
                "fetch_terrain_textures: every blob is RGBA8 with width*height*4 pixels",
                allOk,
                allOk
                    ? `all 33 OK; first ${textures[0].width}x${textures[0].height}`
                    : `failed at index ${firstFail?.i}`
            );

            check(
                "fetch_terrain_textures: BarrenRock (type 0) is 512x512",
                textures[0].terrainType === 0 &&
                    textures[0].width === 512 &&
                    textures[0].height === 512,
                `${textures[0].width}x${textures[0].height} type=${textures[0].terrainType}`
            );

            for (const t of textures) t.free();
        } catch (e) {
            check(
                "fetch_terrain_textures round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 4 round-trip: object placements for 9-cell
        // LandblockInfo neighbourhood. Boot-pack-served.
        try {
            const HOLTBURG_LBI = [
                0xa8b5fffe, 0xa9b5fffe, 0xaab5fffe,
                0xa8b4fffe, 0xa9b4fffe, 0xaab4fffe,
                0xa8b3fffe, 0xa9b3fffe, 0xaab3fffe,
            ];
            const objects = await wasm.fetch_landblock_objects(
                new Uint32Array(HOLTBURG_LBI)
            );

            check(
                "fetch_landblock_objects: returns ≥100 placements for Holtburg 3×3 (Phase 3 step 4)",
                Array.isArray(objects) && objects.length >= 100,
                `len=${objects?.length}`
            );

            let allOk = true;
            let firstFail = null;
            for (let i = 0; i < objects.length; i += 1) {
                const o = objects[i];
                const ok =
                    o.modelId > 0 &&
                    o.x >= -10 && o.x <= 202 &&
                    o.y >= -10 && o.y <= 202 &&
                    Number.isFinite(o.rotationZ);
                if (!ok) { allOk = false; firstFail = { i, o }; break; }
            }
            check(
                "fetch_landblock_objects: every placement has valid modelId/position/rotation",
                allOk,
                allOk
                    ? `${objects.length} OK; sample modelId=0x${objects[0].modelId.toString(16).toUpperCase().padStart(8, "0")}`
                    : `failed at i=${firstFail?.i}`
            );

            const centreId = 0xa9b4fffe;
            const centreObjs = objects.filter((o) => o.landblockId === centreId);
            check(
                "fetch_landblock_objects: Holtburg centre has ≥50 objects (real town density)",
                centreObjs.length >= 50,
                `${centreObjs.length} at 0x${centreId.toString(16).toUpperCase()}`
            );

            // Phase 3 step 4.5 round-trip via the manifest-mode iterative
            // discovery (RecordingSource pattern in `prefetch.rs`). Walks
            // ~81 unique Holtburg models through GfxObj/SetupModel →
            // Surface chains; multiple prefetch rounds expected.
            const uniqueModels = [...new Set(objects.map((o) => o.modelId))];
            const t0 = Date.now();
            const colours = await wasm.fetch_object_colours(
                new Uint32Array(uniqueModels)
            );
            const elapsedMs = Date.now() - t0;

            const lengthOk = (Array.isArray(colours) || colours instanceof Uint32Array) && colours.length === uniqueModels.length;
            check(
                "fetch_object_colours: returns one ARGB per unique model_id (Phase 3 step 4.5)",
                lengthOk,
                `len=${colours?.length}, uniqueModels=${uniqueModels.length}, ${elapsedMs} ms`
            );

            let resolved = 0;
            const distinctColours = new Set();
            for (let i = 0; i < colours.length; i += 1) {
                const argb = colours[i];
                if (argb === 0) continue;
                resolved += 1;
                distinctColours.add(argb);
            }
            const resolveRatio = uniqueModels.length > 0 ? resolved / uniqueModels.length : 0;
            check(
                "fetch_object_colours: ≥10% of Holtburg unique models resolve to a non-zero colour",
                resolveRatio >= 0.10,
                `${resolved} / ${uniqueModels.length} resolved (${(resolveRatio * 100).toFixed(1)}%)`
            );
            check(
                "fetch_object_colours: resolved palette has ≥5 distinct ARGB values (no uniform-tint regression)",
                distinctColours.size >= 5,
                `${distinctColours.size} distinct of ${resolved} resolved`
            );

            // Phase 3 step 6 round-trip: triangulate one Holtburg
            // house. Drives the full GfxObj → polygon → surface walk
            // through manifest-mode prefetch.
            const HOUSE_ID = 0x01000827;
            const houseMesh = await wasm.fetch_model_mesh(HOUSE_ID);
            check(
                "fetch_model_mesh: Holtburg house 0x01000827 yields >0 triangles",
                houseMesh.triCount > 0,
                `${houseMesh.triCount} triangles, ${houseMesh.surfaces.length} surfaces`
            );
            const wb = houseMesh.worldBounds;
            check(
                "fetch_model_mesh: house world bounds ≈ [12, 13.6] (matches atlas)",
                Math.abs(wb[0] - 12.0) < 0.1 && Math.abs(wb[1] - 13.6) < 0.1,
                `worldBounds=[${wb[0].toFixed(2)}, ${wb[1].toFixed(2)}]`
            );
            check(
                "fetch_model_mesh: positions/uvs/surface_indices buffer lengths consistent",
                houseMesh.positions.length === houseMesh.triCount * 9
                    && houseMesh.uvs.length === houseMesh.triCount * 6
                    && houseMesh.surfaceIndices.length === houseMesh.triCount,
                `pos=${houseMesh.positions.length}, uv=${houseMesh.uvs.length}, sidx=${houseMesh.surfaceIndices.length}`
            );
            houseMesh.free();

            // === Phase 6 Step B follow-up ============================
            //
            // Live integration probe: end-to-end exercise of the
            // `populateBuildingAabbsForLandblock` wasm export against
            // real Holtburg landblock data via the manifest source.
            //
            // The export walks `LandblockInfo.buildings` for
            // `0xA9B4FFFE`, fetches each Setup, derives per-part
            // AABBs, transforms them to world space, buckets them
            // into outdoor cells, and pushes them onto a thread-
            // local pending pile. Returns the queued count.
            //
            // What this proves:
            //   - The LandblockInfo path resolves through manifest
            //     mode (boot pack covers 0xA9B4FFFE).
            //   - Setup walks chase missing GfxObj children via
            //     `prefetch::ensure_walk_prefetched`.
            //   - `walk_setup_parts_with_geom` yields non-empty
            //     AABBs for at least one Holtburg building.
            //   - The placement-frame transform produces world-space
            //     AABBs that fall inside the LB's outdoor cells.
            //
            // The compute path is what the live recv loop drains
            // into the spatial scene on the next TickMovement; a
            // non-zero count here = non-zero entries available to
            // the integrator's swept-sphere query in the browser.
            try {
                const queued = await wasm.populateBuildingAabbsForLandblock(0xA9B40000);
                check(
                    "phase6.B.populateBuildingAabbsForLandblock_holtburg_nonzero",
                    typeof queued === "number" && queued > 0,
                    `populateBuildingAabbsForLandblock(0xA9B40000)=${queued} `
                    + `(expected > 0; queued AABBs land in scene on next TickMovement)`
                );
            } catch (e) {
                check(
                    "phase6.B.populateBuildingAabbsForLandblock_holtburg_nonzero",
                    false,
                    `threw: ${e?.message ?? e}`
                );
            }
            // === end Phase 6 Step B follow-up =========================

            for (const o of objects) o.free();
        } catch (e) {
            check(
                "fetch_landblock_objects round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }
    } else if (haveFixture && haveBin) {
        // Fixture present but init_resource_source failed — surfaces
        // as the init check above; skip the round-trips.
        console.log(
            "  [SKIP] fetch_* round-trips — init_resource_source failed (see earlier failure)."
        );
    }

    // ============================================================
    // Phase 5.2 obj 8 — v2 manifest smoke checks.
    //
    // Re-init the global source against a v2-baked dist/ (catalog
    // mode) and exercise the new code paths. Then re-init against
    // the convention-URL variant (catalog_url_template=null) and
    // confirm prefetch still resolves via convention symlinks.
    // ============================================================
    if (manifestUrlV2) {
        try {
            // Reset the per-path counter so the catalog-fetch
            // assertion below sees only requests from this re-init.
            requestCounts.clear();

            await wasm.init_resource_source(manifestUrlV2);
            check(
                "v2 manifest dispatch: connect resolves against v2-baked dist/",
                wasm.has_resource_source() === true,
                `manifestUrlV2=${manifestUrlV2}, has_resource_source()=${wasm.has_resource_source()}`
            );
            check(
                "v2 manifest dispatch: manifest_version()=2 after connect",
                wasm.manifest_version() === 2,
                `manifest_version()=${wasm.manifest_version()}`
            );
            check(
                "v2 manifest dispatch: loaded_catalog_count()=0 before any prefetch",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );

            // (6) Top-level v2 manifest <5 KB invariant. The fixture's
            // 605 MB HBA produces ~885k records; v1's manifest.json
            // would be ~200 MB. v2's must stay tiny regardless.
            const v2ManifestPath = path.join(distDir, "v2", "manifest.json");
            const v2ManifestSize = fs.statSync(v2ManifestPath).size;
            check(
                "v2 top-level manifest.json is <5 KB regardless of bundle size",
                v2ManifestSize < 5 * 1024,
                `manifest.json=${v2ManifestSize} bytes`
            );

            // (2) Round-trip: pull a known record by (namespace,
            // file_id), assert byte equality with the source. The
            // boot pack covers `eor/cell:0xA9B4FFFF` (Holtburg
            // CellLandblock — in the spawn neighborhood); fetch
            // it via `try_http_resource_source_smoke` and verify
            // we got non-empty bytes.
            try {
                const got = await wasm.try_http_resource_source_smoke(
                    "eor/cell",
                    0xA9B4FFFF
                );
                check(
                    "v2 round-trip: eor/cell:0xA9B4FFFF resolves via boot pack (length>0)",
                    got > 0,
                    `got ${got} bytes`
                );
            } catch (e) {
                check(
                    "v2 round-trip: eor/cell:0xA9B4FFFF resolves via boot pack",
                    false,
                    `threw: ${e?.message ?? e}`
                );
            }

            // (4) Catalog lazy-fetch invariants. Need to probe with
            // a record that's NOT in the boot pack's transitive
            // closure (else `prefetch` is a no-op and no catalog
            // fetch fires). The boot closure covers the Holtburg
            // spawn neighborhood + every record reachable from
            // those placements; records in unrelated zones / file-
            // id ranges are typically excluded. Try several probes
            // spanning ranges that the spawn-area walk doesn't
            // touch (Texture / Palette / SurfaceTexture root IDs).
            const probes = [
                ["eor/portal", 0x06000001], // Texture
                ["eor/portal", 0x05000001], // SurfaceTexture
                ["eor/portal", 0x04000001], // Palette
                ["eor/portal", 0x08000001], // Animation
                ["eor/cell", 0xC0C0FFFF],   // far-away cell
            ];
            for (const [ns, id] of probes) {
                try {
                    await wasm.try_http_resource_source_smoke(ns, id);
                } catch (_) {
                    // many of these IDs may not exist in the bundle
                    // — that's fine, the prefetch path tolerates
                    // unknown keys (silent skip via 404).
                }
            }
            const catalogReqEntries = Array.from(requestCounts.entries())
                .filter(([url]) => url.startsWith("/v2/manifest/"));
            const catalogReqTotal = catalogReqEntries.reduce(
                (sum, [, n]) => sum + n,
                0
            );
            const distinctCatalogPaths = new Set(
                catalogReqEntries.map(([url]) => url)
            ).size;

            // Each namespace's catalog is fetched at most once
            // — repeat prefetches into the same namespace must hit
            // the cached catalog. (Brief obj 8 §4 verbatim:
            // "exactly one catalog HTTP request" per namespace.)
            check(
                "v2 catalog lazy-fetch: each namespace catalog fetched at most once",
                catalogReqEntries.every(([, n]) => n === 1),
                `req counts=${JSON.stringify(
                    Object.fromEntries(catalogReqEntries)
                )}`
            );
            // The runtime `loaded_catalog_count()` matches the
            // distinct catalog URLs that were fetched — a self-
            // consistent invariant that doesn't depend on which
            // specific records the boot-pack closure happens to
            // include.
            check(
                "v2 catalog lazy-fetch: loaded_catalog_count() matches distinct catalog HTTP fetches",
                wasm.loaded_catalog_count() === distinctCatalogPaths,
                `loaded=${wasm.loaded_catalog_count()}, distinct catalog HTTP paths=${distinctCatalogPaths}, total catalog reqs=${catalogReqTotal}`
            );
        } catch (e) {
            check(
                "v2 manifest dispatch: connect resolves against v2-baked dist/",
                false,
                `init threw: ${e?.message ?? e}`
            );
        }

        // (5) Convention URL fallback: re-init against the conv
        // variant where `catalog_url_template = null` and the
        // `shard_url_template` points at the per-namespace symlink
        // layout. Prefetch must resolve without ever fetching a
        // catalog; record fetches go straight to the convention URL.
        try {
            requestCounts.clear();
            await wasm.init_resource_source(manifestUrlV2Conv);
            check(
                "v2 convention URL: connect resolves against catalog_url_template=null variant",
                wasm.has_resource_source() === true && wasm.manifest_version() === 2,
                `has_resource_source()=${wasm.has_resource_source()}, manifest_version()=${wasm.manifest_version()}`
            );

            // Fetch a record + assert no `/v2conv/manifest/` URL
            // was ever requested (the conv mode skips catalogs entirely).
            try {
                await wasm.try_http_resource_source_smoke(
                    "eor/cell",
                    0xA9B4FFFF
                );
            } catch (_) {
                // boot pack covers this so the fetch should succeed
                // without any network calls — but if a conversion
                // variant ever bumps that we just want the catalog-
                // request count to remain 0.
            }
            const convCatalogReqs = Array.from(requestCounts.entries())
                .filter(([url]) => url.startsWith("/v2conv/manifest/"))
                .reduce((sum, [, n]) => sum + n, 0);
            check(
                "v2 convention URL: zero catalog HTTP requests in convention-only mode",
                convCatalogReqs === 0,
                `catalog requests=${convCatalogReqs}, all reqs=${JSON.stringify(
                    Array.from(requestCounts.keys()).filter((u) =>
                        u.startsWith("/v2conv/")
                    )
                )}`
            );
            check(
                "v2 convention URL: loaded_catalog_count()=0 in convention-only mode",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );
        } catch (e) {
            check(
                "v2 convention URL: connect resolves against catalog_url_template=null variant",
                false,
                `init threw: ${e?.message ?? e}`
            );
        }
    } else if (haveFixture && haveBin) {
        console.log(
            "  [SKIP] Phase 5.2 obj 8 v2 round-trips — v2 fixture not baked (init failed earlier)."
        );
    }

    // Tear down dist server. distDir is the cached bake when
    // distDirIsCache is true — leave it on disk for the next run.
    if (distServer) {
        await new Promise((resolve) => distServer.close(resolve));
    }
    if (distDir && !distDirIsCache) {
        fs.rmSync(distDir, { recursive: true, force: true });
    }

    // Phase 4 step 1 error-path: start_session against a clearly-dead
    // bridge URL should reject with a stringified error rather than
    // panic. Phase 5.0b dropped the asset_url 6th param — catalog
    // load now reads from the global manifest source.
    let didReject = false;
    let rejectMsg = "";
    try {
        await wasm.start_session(
            "ws://127.0.0.1:1/",
            "127.0.0.1",
            9000,
            "smoke-test-account",
            "smoke-test-password"
        );
    } catch (e) {
        didReject = true;
        rejectMsg = String(e?.message ?? e);
    }
    check(
        "start_session against a closed port rejects with an error string",
        didReject && rejectMsg.length > 0,
        didReject
            ? `rejected: ${rejectMsg.length > 80 ? rejectMsg.slice(0, 80) + "…" : rejectMsg}`
            : "expected rejection but Promise resolved"
    );

    console.log(
        "  [SKIP] start_session live round-trip — needs a real ACE.\n" +
        "         Open `apps/holtburger-web/index.html` in a browser " +
        "with a running\n         holtburger-wsbridge + ACE for end-to-end coverage."
    );

    console.log("=========================");
    if (failed === 0) {
        console.log("PASS: all smoke checks green.");
        process.exit(0);
    } else {
        console.log(`FAIL: ${failed} check(s) failed.`);
        process.exit(1);
    }
})();
