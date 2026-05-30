// Hand-run smoke test for Phase C.2 `fetch_landblock_scenery` wasm
// export. Spins up a tiny static HTTP server in front of the staged
// bake at `/mnt/wbterminal2/holtburger-dist/scenery/`, calls
// `init_scenery_base_url(...)` + `fetch_landblock_scenery([...])`
// against the freshly built nodejs wasm bundle, and asserts at least
// one placement comes back for an LB known to have scenery.
//
// Run:
//   node smoke_scenery_fetch.cjs
//   PKG_DIR=/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/c12/pkg-nodejs node smoke_scenery_fetch.cjs
//   SCENERY_DIR=/path/to/scenery node smoke_scenery_fetch.cjs

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PKG_DIR =
    process.env.PKG_DIR ||
    "/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/c12/pkg-nodejs";
const SCENERY_DIR =
    process.env.SCENERY_DIR || "/mnt/wbterminal2/holtburger-dist/scenery";

let failed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

console.log("Phase C.1+C.2 fetch_landblock_scenery hand-smoke");
console.log("=================================================");

// Sanity: dist + pkg paths exist.
if (!fs.existsSync(path.join(PKG_DIR, "holtburger_web.js"))) {
    console.error(`FATAL: PKG_DIR ${PKG_DIR} doesn't contain holtburger_web.js`);
    process.exit(2);
}
if (!fs.existsSync(path.join(SCENERY_DIR, "bake-source.sha256"))) {
    console.error(
        `FATAL: SCENERY_DIR ${SCENERY_DIR} doesn't contain bake-source.sha256`,
    );
    process.exit(2);
}

const wasm = require(path.join(PKG_DIR, "holtburger_web.js"));

// Symbol-presence smoke (mirrors smoke_test.cjs's gate; we re-check
// here so this script is self-contained against arbitrary PKG_DIRs).
check(
    "fetch_landblock_scenery is exported",
    typeof wasm.fetch_landblock_scenery === "function",
    `typeof ${typeof wasm.fetch_landblock_scenery}`,
);
check(
    "init_scenery_base_url is exported",
    typeof wasm.init_scenery_base_url === "function",
    `typeof ${typeof wasm.init_scenery_base_url}`,
);
check(
    "scenery_cache_size is exported",
    typeof wasm.scenery_cache_size === "function",
    `typeof ${typeof wasm.scenery_cache_size}`,
);
check(
    "ScenicPlacementJs class is exported",
    typeof wasm.ScenicPlacementJs === "function",
    `typeof ${typeof wasm.ScenicPlacementJs}`,
);

// Mini HTTP server that serves `SCENERY_DIR/*` under `/scenery/*`.
// Mirrors the dev server's `/dist/...` path mapping (Phase 5.2
// production stack — see capture_world_expand_e2e.cjs:189-204).
function makeServer() {
    return http.createServer((req, res) => {
        let url;
        try {
            url = decodeURIComponent(req.url.split("?")[0]);
        } catch (e) {
            res.writeHead(400).end();
            return;
        }
        const stripped = url.replace(/^\/+/, "");
        if (!stripped.startsWith("scenery/")) {
            res.writeHead(404).end();
            return;
        }
        const filePath = path.join(SCENERY_DIR, stripped.slice("scenery/".length));
        if (!filePath.startsWith(SCENERY_DIR)) {
            res.writeHead(403).end();
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader("Connection", "close");
            res.writeHead(200, {
                "content-type": "application/jsonl; charset=utf-8",
                "content-length": data.length,
            });
            res.end(data);
        });
    });
}

(async () => {
    const server = makeServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/scenery/`;
    console.log(`  serving ${SCENERY_DIR} at ${baseUrl}`);

    try {
        wasm.init_scenery_base_url(baseUrl);
        check(
            "scenery_cache_size starts at 0",
            wasm.scenery_cache_size() === 0,
            `got ${wasm.scenery_cache_size()}`,
        );

        // LB 0xA8B0 has 68 placements per the ace-compat bake (B.4
        // parity report). The cell_id we pass is 0xA8B0FFFE (the
        // LandblockInfo cell suffix), matching the fetch_landblock_objects
        // call shape.
        const cellId = 0xa8b0fffe;
        const placements = await wasm.fetch_landblock_scenery(
            new Uint32Array([cellId]),
        );
        check(
            "fetch_landblock_scenery returns >= 1 placement for LB 0xA8B0",
            placements.length >= 1,
            `got ${placements.length} placement(s)`,
        );

        // Sample assertions on the first placement — verify the
        // wasm-bindgen field plumbing produces sane values.
        if (placements.length >= 1) {
            const p = placements[0];
            check(
                "first placement has 0x02-prefixed obj_id (SetupModel)",
                (p.objId >>> 24) === 0x02,
                `objId=0x${p.objId.toString(16).padStart(8, "0")}`,
            );
            check(
                "first placement has LB-local x in [0, 192]",
                p.x >= 0 && p.x <= 192,
                `x=${p.x}`,
            );
            check(
                "first placement has LB-local y in [0, 192]",
                p.y >= 0 && p.y <= 192,
                `y=${p.y}`,
            );
            check(
                "first placement has scale > 0",
                p.scale > 0,
                `scale=${p.scale}`,
            );
            check(
                "first placement has landblockId = cell_id & 0xFFFF_0000",
                p.landblockId === (cellId & 0xffff0000) >>> 0,
                `landblockId=0x${p.landblockId.toString(16)}`,
            );
            check(
                "first placement has source_cell_x in [0, 8]",
                p.sourceCellX <= 8,
                `sourceCellX=${p.sourceCellX}`,
            );
        }

        check(
            "scenery_cache_size = 1 after first fetch",
            wasm.scenery_cache_size() === 1,
            `got ${wasm.scenery_cache_size()}`,
        );

        // Second call same LB → cache hit, count unchanged.
        const placements2 = await wasm.fetch_landblock_scenery(
            new Uint32Array([cellId]),
        );
        check(
            "second fetch returns same count (cache hit)",
            placements2.length === placements.length,
            `${placements2.length} vs ${placements.length}`,
        );
        check(
            "scenery_cache_size still 1 after cache hit",
            wasm.scenery_cache_size() === 1,
            `got ${wasm.scenery_cache_size()}`,
        );

        // Empty-bake LB: 0xA9B4 (Holtburg town centre) is the only LB
        // in the 13×13 ring with 0 placements — every procedural-
        // scenery candidate gets knocked out by collision against
        // the town's buildings. Verify empty-body returns zero, no
        // error.
        const emptyCellId = 0xa9b4fffe;
        const emptyPlacements = await wasm.fetch_landblock_scenery(
            new Uint32Array([emptyCellId]),
        );
        check(
            "empty-baked LB 0xA9B4 (Holtburg) returns 0 placements",
            emptyPlacements.length === 0,
            `got ${emptyPlacements.length}`,
        );
        check(
            "scenery_cache_size = 2 after empty-LB fetch",
            wasm.scenery_cache_size() === 2,
            `got ${wasm.scenery_cache_size()}`,
        );

        // Unbaked LB (404): 0xB000 is outside the 13×13 ring.
        const unbakedCellId = 0xb000fffe;
        const unbakedPlacements = await wasm.fetch_landblock_scenery(
            new Uint32Array([unbakedCellId]),
        );
        check(
            "unbaked LB 0xB000 returns 0 placements (404 soft-pass)",
            unbakedPlacements.length === 0,
            `got ${unbakedPlacements.length}`,
        );

        // Multi-LB call: two LBs in one go, returns union.
        wasm.clear_scenery_cache();
        check(
            "scenery_cache_size reset to 0 after clear",
            wasm.scenery_cache_size() === 0,
        );
        // Use two non-empty LBs (Holtburg 0xA9B4 is empty due to
        // building-collision rejection; pick its outdoor neighbours).
        const union = await wasm.fetch_landblock_scenery(
            new Uint32Array([0xa8b0fffe, 0xa9b3fffe]),
        );
        check(
            "multi-LB fetch returns union (LBs 0xA8B0 + 0xA9B3)",
            union.length >= 2,
            `got ${union.length}`,
        );
        // Verify both LBs are represented.
        const lbIds = new Set(union.map((p) => p.landblockId));
        check(
            "union contains placements from both LBs",
            lbIds.has(0xa8b00000 >>> 0) && lbIds.has(0xa9b30000 >>> 0),
            `LB ids: ${[...lbIds].map((id) => "0x" + id.toString(16)).join(", ")}`,
        );
        check(
            "scenery_cache_size = 2 after multi-LB fetch",
            wasm.scenery_cache_size() === 2,
            `got ${wasm.scenery_cache_size()}`,
        );
    } finally {
        server.close();
    }

    console.log("=================================================");
    console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
});
