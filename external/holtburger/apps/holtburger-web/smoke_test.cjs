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
// Phase 4 step 6 Tier 2: walk-cycle frame bake. Returns Vec<ModelMesh>
// — one per cycle frame, applying the same model_changes/texture_changes
// as fetchEntityModelRender but with each frame's per-part transforms
// from the WALK_FORWARD MotionTable cycle. JS swaps sprite.texture by
// velocity-driven frame index. Empty Vec for setups without a walk
// cycle (props, doors, signs).
check(
    "fetchEntityWalkFrames() exposed (Phase 4 step 6 Tier 2 walk-cycle bake)",
    typeof wasm.fetchEntityWalkFrames === "function",
    `fetchEntityWalkFrames=${typeof wasm.fetchEntityWalkFrames}`
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

    const haveFixture = fs.existsSync(fixturePath);
    const haveBin = fs.existsSync(datShardBin);

    let distDir = null;
    let distServer = null;
    let manifestUrl = null;

    if (!haveFixture) {
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
        // Pick a bake-parent directory big enough to hold ~4 GB on
        // disk (885k shards × 4 KB block rounding + 1.86 MB boot pack +
        // 200+ MB v1 manifest.json). Each smoke run creates a fresh
        // mkdtemp under this base. Resolution order:
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
        distDir = fs.mkdtempSync(path.join(bakeBase, "holtburger-smoke-dist-"));
        console.log(`  [info] smoke bake → ${distDir}`);

        // Register cleanup hooks the moment the directory exists, so a
        // crash / unhandled rejection / Ctrl-C between here and the
        // explicit teardown below still rms the bake. Without this the
        // ~4 GB pile accumulates per failed run; on this host's 117 GB
        // root that's 5-6 runs to fill the disk and break SSH.
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            try { if (distServer) distServer.close(); } catch (_) {}
            try { if (distDir) fs.rmSync(distDir, { recursive: true, force: true }); } catch (_) {}
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

        cp.execFileSync(
            datShardBin,
            ["--input", fixturePath, "--output", distDir],
            { stdio: "ignore" }
        );
        distServer = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.replace(/^\/+/, ""));
            const filePath = path.join(distDir, rel);
            if (!filePath.startsWith(distDir)) {
                res.writeHead(403);
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
        await new Promise((resolve) => distServer.listen(0, "127.0.0.1", resolve));
        const distPort = distServer.address().port;
        manifestUrl = `http://127.0.0.1:${distPort}/manifest.json`;

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

    // Tear down dist server.
    if (distServer) {
        await new Promise((resolve) => distServer.close(resolve));
    }
    if (distDir) {
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
