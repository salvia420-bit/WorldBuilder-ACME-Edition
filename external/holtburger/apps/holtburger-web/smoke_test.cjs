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

(async () => {
    // §8 step 4 round-trip: serve `dats/assets.hba` over HTTP from this
    // process, then have the wasm bundle's HttpResourceSource fetch +
    // parse it and return the byte length of one known entry. The
    // fixture is git-ignored (retail-derived asset bytes) so we degrade
    // gracefully if it's absent — the symbol-presence check above is
    // the floor.
    const fixturePath = path.resolve(__dirname, "../..", "dats", "assets.hba");
    if (!fs.existsSync(fixturePath)) {
        console.log(
            "  [SKIP] HttpResourceSource round-trip — dats/assets.hba missing.\n" +
            "         Generate it with `cargo run -p holtburger-tools --bin dat2hba` " +
            "(see dats/README.md)."
        );
    } else if (typeof fetch !== "function") {
        console.log(
            "  [SKIP] HttpResourceSource round-trip — Node ≥18 fetch() not " +
            "available."
        );
    } else {
        const fixtureBytes = fs.readFileSync(fixturePath);
        const server = http.createServer((req, res) => {
            // Single-purpose server: any path returns the fixture.
            res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": fixtureBytes.length,
            });
            res.end(fixtureBytes);
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        const url = `http://127.0.0.1:${port}/assets.hba`;
        try {
            // Pinned by `dat2hba --profile micro` against the canonical
            // ac_base_dats portal.dat — see the corresponding entry in
            // `dat-tool list dats/assets.hba`.
            const expectedNamespace = "eor/portal";
            const expectedFileId = 0x0E000004;
            const expectedSize = 5876;
            const got = await wasm.try_http_resource_source_smoke(
                url,
                expectedNamespace,
                expectedFileId
            );
            check(
                `HttpResourceSource fetches & parses assets.hba; ${expectedNamespace}:0x${expectedFileId.toString(16).padStart(8, "0")} length is ${expectedSize}`,
                got === expectedSize,
                `got ${got}, expected ${expectedSize}`
            );
        } catch (e) {
            check(
                "HttpResourceSource round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 1 round-trip: fetch the Holtburg-town-centre
        // CellLandblock (`eor/cell:0xA9B4FFFF`) and verify the mesh
        // shape. Requires `--profile pruned` (or fuller); `--profile
        // micro` excludes `eor/cell` and so this round-trip degrades to
        // a SKIP without failing the run. Visual rendering is
        // browser-only — Node has no canvas — so we check geometry
        // invariants here.
        try {
            const cellId = 0xa9b4ffff;
            const mesh = await wasm.fetch_landblock_heightmap(url, cellId);

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

            // Vertex (0,0) is at metric origin; vertex (8,8) is at
            // (192, 192). These are the corners of the 9×9 grid that
            // covers the full 192 m × 192 m landblock (vertex spacing
            // = METERS_PER_LANDBLOCK / 8 = 24 m).
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

            // Heights are u8 × 2.0, so range is [0, 510] metres.
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

            // Every triangle index must point at a real vertex.
            let maxIdx = 0;
            for (let i = 0; i < mesh.indices.length; i += 1) {
                if (mesh.indices[i] > maxIdx) maxIdx = mesh.indices[i];
            }
            check(
                "fetch_landblock_heightmap: max index < 81 (within 9×9 grid)",
                maxIdx === 80,
                `maxIdx=${maxIdx}`
            );

            // Phase 3 step 3: per-vertex terrain code stream is exposed
            // as `terrainCodes` (Uint8Array(81)). Each byte is one of
            // AC's 32 base terrain types — see TERRAIN_TYPES in
            // index.html or the upstream `TerrainTextureType` enum.
            const codes = mesh.terrainCodes;
            const codesShapeOk =
                codes instanceof Uint8Array && codes.length === 81;
            check(
                "fetch_landblock_heightmap: terrainCodes is Uint8Array of 81 (Phase 3 step 3)",
                codesShapeOk,
                `len=${codes?.length}, ctor=${codes?.constructor?.name}`
            );

            // All values must be in [0, 31] — terrain type bits are
            // 5 wide, so anything ≥ 32 means the bit-decode is leaking
            // road or scenery bits into the type field.
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

            // Holtburg town centre is known empirically to mix at
            // least 3 distinct terrain types (LushGrass + Grassland +
            // SemiBarrenRock at minimum; PatchyGrassland and others
            // also appear). A single-type result would mean the bit-
            // decode collapsed everything to BarrenRock (= 0).
            const distinct = new Set(codes).size;
            check(
                "fetch_landblock_heightmap: Holtburg centre has ≥3 distinct terrain types",
                distinct >= 3,
                `${distinct} distinct: [${[...new Set(codes)].sort((a, b) => a - b).join(", ")}]`
            );

            // Phase 3 step 5: per-vertex road code stream is exposed
            // alongside terrainCodes. Road bits are 2 wide (range 0..3)
            // and live at bits 0-1 of the same `terrain[]` u16. Holtburg
            // town centre is on AC's main east-west road network and
            // empirically has ≥10 vertices with road_code > 0.
            const roads = mesh.roadCodes;
            const roadShapeOk =
                roads instanceof Uint8Array && roads.length === 81;
            check(
                "fetch_landblock_heightmap: roadCodes is Uint8Array of 81 (Phase 3 step 5)",
                roadShapeOk,
                `len=${roads?.length}, ctor=${roads?.constructor?.name}`
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
            // Missing `eor/cell` namespace (micro-profile fixture) is
            // an environment skip, not a failure. Anything else is.
            const msg = String(e?.message ?? e);
            const missingCell =
                msg.includes("eor/cell") &&
                (msg.includes("not found") || msg.includes("missing namespace"));
            if (missingCell) {
                console.log(
                    "  [SKIP] fetch_landblock_heightmap round-trip — fixture has " +
                    "no eor/cell namespace.\n         Re-run dat2hba with " +
                    "--profile pruned to include cell content."
                );
            } else {
                check(
                    "fetch_landblock_heightmap round-trip succeeds",
                    false,
                    `threw: ${msg}`
                );
            }
        }

        // Phase 3 step 2 round-trip: the batch export reads the
        // 3×3 Holtburg-neighbourhood (0xA8B3FFFF..0xAAB5FFFF) in one
        // HBA open, returns 9 mesh entries in the same order as the
        // input id list. Same fixture-profile gating as the singular
        // path — a `--profile micro` fixture lacks `eor/cell` and
        // degrades to a SKIP.
        try {
            const HOLTBURG_NEIGHBOURHOOD = [
                0xa8b5ffff, 0xa9b5ffff, 0xaab5ffff,
                0xa8b4ffff, 0xa9b4ffff, 0xaab4ffff,
                0xa8b3ffff, 0xa9b3ffff, 0xaab3ffff,
            ];
            const meshes = await wasm.fetch_landblock_heightmaps(
                url,
                new Uint32Array(HOLTBURG_NEIGHBOURHOOD)
            );
            check(
                "fetch_landblock_heightmaps: returns 9 entries for 9 input ids",
                Array.isArray(meshes) && meshes.length === 9,
                `len=${meshes?.length}, isArray=${Array.isArray(meshes)}`
            );

            // Spot-check the first neighbour (NW = 0xA8B5FFFF). Sane
            // height range = finite, in [0, 510], min <= max.
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

            // Centre (index 4) must be Holtburg's terrain — same height
            // range as the singular round-trip established (30..96 m).
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
            const msg = String(e?.message ?? e);
            const missingCell =
                msg.includes("eor/cell") &&
                (msg.includes("not found") || msg.includes("missing namespace"));
            if (missingCell) {
                console.log(
                    "  [SKIP] fetch_landblock_heightmaps round-trip — fixture " +
                    "has no eor/cell namespace.\n         Re-run dat2hba with " +
                    "--profile pruned to include cell content."
                );
            } else {
                check(
                    "fetch_landblock_heightmaps round-trip succeeds",
                    false,
                    `threw: ${msg}`
                );
            }
        }

        // Phase 3 step 3.5 round-trip: fetch all 33 retail terrain
        // textures (BarrenRock..RoadType) and verify shape + RGBA8
        // length consistency. Requires `--profile full` (or any profile
        // that includes SurfaceTexture / Texture / Palette records);
        // `--profile pruned` excludes them and degrades to a SKIP.
        try {
            const t0 = Date.now();
            const textures = await wasm.fetch_terrain_textures(url);
            const elapsed = Date.now() - t0;

            check(
                `fetch_terrain_textures: returns 33 entries (Phase 3 step 3.5)`,
                Array.isArray(textures) && textures.length === 33,
                `len=${textures?.length}, ${elapsed} ms`
            );

            // Spot-check shape on every entry.
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
                if (!ok) {
                    allOk = false;
                    firstFail = { i, t };
                    break;
                }
            }
            check(
                "fetch_terrain_textures: every blob is RGBA8 with width*height*4 pixels",
                allOk,
                allOk
                    ? `all 33 OK; first ${textures[0].width}x${textures[0].height}`
                    : `failed at index ${firstFail?.i}: type=${firstFail?.t?.terrainType}, ${firstFail?.t?.width}x${firstFail?.t?.height}, px=${firstFail?.t?.pixels?.length}`
            );

            // The retail terrain textures are 512×512 in the source
            // mip-stack. Pin this so a future profile re-bake or atlas
            // resizer doesn't silently change the contract.
            check(
                "fetch_terrain_textures: BarrenRock (type 0) is 512x512",
                textures[0].terrainType === 0 &&
                    textures[0].width === 512 &&
                    textures[0].height === 512,
                `${textures[0].width}x${textures[0].height} type=${textures[0].terrainType}`
            );

            for (const t of textures) t.free();
        } catch (e) {
            const msg = String(e?.message ?? e);
            const missingTextures =
                msg.includes("SurfaceTexture") ||
                msg.includes("Texture") ||
                msg.includes("Palette") ||
                msg.includes("not found");
            if (missingTextures && msg.includes("not found")) {
                console.log(
                    "  [SKIP] fetch_terrain_textures round-trip — fixture lacks " +
                    "SurfaceTexture/Texture records.\n         Re-run dat2hba with " +
                    "--profile full to include the texture pipeline."
                );
            } else {
                check(
                    "fetch_terrain_textures round-trip succeeds",
                    false,
                    `threw: ${msg}`
                );
            }
        }

        // Phase 3 step 4 round-trip: fetch object placements for the
        // Holtburg LandblockInfo neighbourhood (XXYYFFFE suffix, not
        // XXYYFFFF which is the terrain CellLandblock). Each object
        // placement has model_id + (x, y, z) + rotation_z. Pin against
        // empirical Holtburg counts: the 3×3 neighbourhood holds ~239
        // placed objects total (inc. buildings) with ~120 at the centre
        // landblock. Loose threshold so future asset re-bakes don't
        // false-fail on minor variance.
        try {
            const HOLTBURG_LBI = [
                0xa8b5fffe, 0xa9b5fffe, 0xaab5fffe,
                0xa8b4fffe, 0xa9b4fffe, 0xaab4fffe,
                0xa8b3fffe, 0xa9b3fffe, 0xaab3fffe,
            ];
            const objects = await wasm.fetch_landblock_objects(
                url,
                new Uint32Array(HOLTBURG_LBI)
            );

            check(
                "fetch_landblock_objects: returns ≥100 placements for Holtburg 3×3 (Phase 3 step 4)",
                Array.isArray(objects) && objects.length >= 100,
                `len=${objects?.length}`
            );

            // Every placement must have a non-zero model_id and a
            // sane position (within the 192 m landblock bounds, plus
            // some slack for objects placed near edges).
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
                    : `failed at i=${firstFail?.i}: model=${firstFail?.o?.modelId}, pos=(${firstFail?.o?.x},${firstFail?.o?.y})`
            );

            // The Holtburg town centre landblock has the most density.
            const centreId = 0xa9b4fffe;
            const centreObjs = objects.filter((o) => o.landblockId === centreId);
            check(
                "fetch_landblock_objects: Holtburg centre has ≥50 objects (real town density)",
                centreObjs.length >= 50,
                `${centreObjs.length} at 0x${centreId.toString(16).toUpperCase()}`
            );

            // Phase 3 step 4.5 round-trip: feed the unique placement
            // model_ids into fetch_object_colours; expect one ARGB per
            // input, and a non-trivial fraction resolved (= non-zero).
            // The Surface walk only resolves the SOLID-colour path, so
            // the resolved fraction depends on how many of Holtburg's
            // models ship a `Base1Solid` Surface vs a `Base1Image` /
            // `Base1ClipMap` one. Empirically the threshold here is
            // conservative — a green run proves the walk works at
            // all. A future step 4.5b (textured-pixel-mean path) would
            // raise this materially.
            const uniqueModels = [...new Set(objects.map((o) => o.modelId))];
            const t0 = Date.now();
            const colours = await wasm.fetch_object_colours(
                url,
                new Uint32Array(uniqueModels)
            );
            const elapsedMs = Date.now() - t0;

            check(
                "fetch_object_colours: returns one ARGB per unique model_id (Phase 3 step 4.5)",
                Array.isArray(colours) || colours instanceof Uint32Array
                    ? colours.length === uniqueModels.length
                    : false,
                `len=${colours?.length}, uniqueModels=${uniqueModels.length}, ${elapsedMs} ms`
            );

            // Resolve ratio + colour-variety. "Resolved" means the walk
            // returned a non-zero ARGB. The variety check counts
            // distinct ARGB values among resolved models — pins that
            // we have meaningful per-model colour, not the 2-bucket
            // wash from step 4 (which would resolve to at most two
            // unique values).
            let resolved = 0;
            const distinctColours = new Set();
            for (let i = 0; i < colours.length; i += 1) {
                const argb = colours[i];
                if (argb === 0) continue;
                resolved += 1;
                distinctColours.add(argb);
            }
            const resolveRatio = resolved / uniqueModels.length;

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

            // Phase 3 step 6: fetch_model_mesh round-trip on a known
            // Holtburg house. Pin: tris > 0 (mesh has drawable
            // polygons), surfaces ≥ 1 (texture refs found), worldBounds
            // matches the atlas's pre-baked worldBounds for the same
            // model_id (sanity-check the bbox computation against the
            // static-site emitter's footprint).
            const HOUSE_ID = 0x01000827;
            const houseMesh = await wasm.fetch_model_mesh(url, HOUSE_ID);
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
            const msg = String(e?.message ?? e);
            const missingLbi =
                msg.includes("LandblockInfo") &&
                (msg.includes("not found") || msg.includes("missing namespace"));
            if (missingLbi) {
                console.log(
                    "  [SKIP] fetch_landblock_objects round-trip — fixture has " +
                    "no LandblockInfo records.\n         Re-run dat2hba with " +
                    "--profile pruned (or fuller) to include cell content."
                );
            } else {
                check(
                    "fetch_landblock_objects round-trip succeeds",
                    false,
                    `threw: ${msg}`
                );
            }
        }

        await new Promise((resolve) => server.close(resolve));
    }

    // Phase 4 step 1 error-path: start_session against a clearly-dead
    // bridge URL should reject with a stringified error rather than
    // panic. This pins the failure-mode contract regardless of whether
    // a `WebSocket` global is available in the host Node — without one
    // the rejection comes from the inner `web_sys::WebSocket::new` call
    // failing; with one (Node 21+ or a `ws` polyfill) it comes from the
    // OS-level connection refused. Either way the wasm boundary
    // surfaces a JsValue error string, not a panic.
    let didReject = false;
    let rejectMsg = "";
    try {
        await wasm.start_session(
            "ws://127.0.0.1:1/",
            "127.0.0.1",
            9000,
            "smoke-test-account",
            "smoke-test-password",
            "" // asset_url empty → catalog skipped, fast-fail on transport
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

    // Phase 4 step 1 round-trip is browser-only. A JS mock bridge that
    // can answer the AC LoginRequest with a synthetic CONNECT_REQUEST
    // → CharacterList sequence would need to re-implement chunks of
    // `holtburger-protocol` (PacketHeader, fragment encoding, ISAAC
    // checksum, GameMessage::CharacterList serialization) in JS — well
    // outside step 1's scope. Live-ACE coverage runs manually via
    // `docs/ace-local-setup.md` per the existing pattern.
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
