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
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
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
