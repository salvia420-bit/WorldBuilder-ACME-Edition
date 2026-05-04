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

        await new Promise((resolve) => server.close(resolve));
    }

    console.log("=========================");
    if (failed === 0) {
        console.log("PASS: all smoke checks green.");
        process.exit(0);
    } else {
        console.log(`FAIL: ${failed} check(s) failed.`);
        process.exit(1);
    }
})();
