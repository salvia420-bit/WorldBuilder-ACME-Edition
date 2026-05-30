// Hand-run smoke test for Phase D.1 `fetch_landblock_spawns` wasm
// export. Mirrors `smoke_scenery_fetch.cjs`'s shape. Spins up a
// tiny static HTTP server in front of the staged spawn dir at
// `/mnt/wbterminal2/holtburger-dist/spawns/`, calls
// `init_spawns_base_url(...)` + `fetch_landblock_spawns([...])`
// against the freshly built nodejs wasm bundle, and asserts at
// least one record comes back for Holtburg (LB 0xA9B4 has 106
// records per the staging stats).
//
// Run:
//   node smoke_spawns_fetch.cjs
//   PKG_DIR=/path/to/pkg-nodejs SPAWNS_DIR=/path/to/spawns \
//       node smoke_spawns_fetch.cjs

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PKG_DIR =
    process.env.PKG_DIR ||
    path.join(__dirname, "pkg-node");
const SPAWNS_DIR =
    process.env.SPAWNS_DIR || "/mnt/wbterminal2/holtburger-dist/spawns";

let failed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

console.log("Phase D.1 fetch_landblock_spawns hand-smoke");
console.log("===========================================");

if (!fs.existsSync(path.join(PKG_DIR, "holtburger_web.js"))) {
    console.error(`FATAL: PKG_DIR ${PKG_DIR} doesn't contain holtburger_web.js`);
    process.exit(2);
}
if (!fs.existsSync(path.join(SPAWNS_DIR, "source.sha256"))) {
    console.error(
        `FATAL: SPAWNS_DIR ${SPAWNS_DIR} doesn't contain source.sha256`,
    );
    process.exit(2);
}

const wasm = require(path.join(PKG_DIR, "holtburger_web.js"));

check(
    "fetch_landblock_spawns is exported",
    typeof wasm.fetch_landblock_spawns === "function",
    `typeof ${typeof wasm.fetch_landblock_spawns}`,
);
check(
    "init_spawns_base_url is exported",
    typeof wasm.init_spawns_base_url === "function",
    `typeof ${typeof wasm.init_spawns_base_url}`,
);
check(
    "spawns_cache_size is exported",
    typeof wasm.spawns_cache_size === "function",
    `typeof ${typeof wasm.spawns_cache_size}`,
);
check(
    "EntitySpawnJs class is exported",
    typeof wasm.EntitySpawnJs === "function",
    `typeof ${typeof wasm.EntitySpawnJs}`,
);

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
        if (!stripped.startsWith("spawns/")) {
            res.writeHead(404).end();
            return;
        }
        const filePath = path.join(SPAWNS_DIR, stripped.slice("spawns/".length));
        if (!filePath.startsWith(SPAWNS_DIR)) {
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
                "content-type": filePath.endsWith(".json")
                    ? "application/json; charset=utf-8"
                    : "application/jsonl; charset=utf-8",
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
    const baseUrl = `http://127.0.0.1:${port}/spawns/`;
    console.log(`  serving ${SPAWNS_DIR} at ${baseUrl}`);

    try {
        wasm.init_spawns_base_url(baseUrl);
        check(
            "spawns_cache_size starts at 0",
            wasm.spawns_cache_size() === 0,
            `got ${wasm.spawns_cache_size()}`,
        );

        // Holtburg (0xA9B4) has 106 records per the staging log.
        const cellId = 0xa9b4fffe;
        const records = await wasm.fetch_landblock_spawns(
            new Uint32Array([cellId]),
        );
        check(
            "fetch_landblock_spawns returns >= 100 records for Holtburg LB 0xA9B4",
            records.length >= 100,
            `got ${records.length} record(s)`,
        );

        if (records.length >= 1) {
            const r = records[0];
            check(
                "first record has non-zero wcid",
                (r.wcid >>> 0) !== 0,
                `wcid=${r.wcid}`,
            );
            check(
                "first record has LB-local x in [0, 192]",
                r.x >= 0 && r.x <= 192,
                `x=${r.x}`,
            );
            check(
                "first record has LB-local y in [0, 192]",
                r.y >= 0 && r.y <= 192,
                `y=${r.y}`,
            );
            check(
                "first record has landblockId = cellId & 0xFFFF_0000",
                r.landblockId === (cellId & 0xffff0000) >>> 0,
                `landblockId=0x${r.landblockId.toString(16)}`,
            );
            check(
                "first record has identity quat (qw=1, others 0)",
                r.qw === 1 && r.qx === 0 && r.qy === 0 && r.qz === 0,
                `quat=(${r.qw}, ${r.qx}, ${r.qy}, ${r.qz})`,
            );
            // Free + collect the records (wasm-bindgen will GC them later
            // but we free explicitly to mirror production usage).
            for (const rec of records) {
                if (typeof rec.free === "function") rec.free();
            }
        }

        check(
            "spawns_cache_size = 1 after Holtburg fetch",
            wasm.spawns_cache_size() === 1,
            `got ${wasm.spawns_cache_size()}`,
        );

        // Cache hit — second fetch same LB returns same count.
        const records2 = await wasm.fetch_landblock_spawns(
            new Uint32Array([cellId]),
        );
        check(
            "second fetch returns same count (cache hit)",
            records2.length === records.length,
            `${records2.length} vs ${records.length}`,
        );
        for (const rec of records2) {
            if (typeof rec.free === "function") rec.free();
        }

        // Empty LB: 0xA3AF is in the ring with 0 spawns (one of the
        // 125 wilderness LBs without any ACE-DB placements). Empty
        // body returns 0 records, no error — distinguishes "queried,
        // zero spawns" from "404 not staged".
        const emptyCellId = 0xa3affffe;
        const emptyRecords = await wasm.fetch_landblock_spawns(
            new Uint32Array([emptyCellId]),
        );
        check(
            "empty-staged LB 0xA3AF returns 0 records",
            emptyRecords.length === 0,
            `got ${emptyRecords.length}`,
        );

        // Unstaged LB (404): 0xB000 is outside the 13×13 ring.
        const unstagedCellId = 0xb000fffe;
        const unstagedRecords = await wasm.fetch_landblock_spawns(
            new Uint32Array([unstagedCellId]),
        );
        check(
            "unstaged LB 0xB000 returns 0 records (404 soft-pass)",
            unstagedRecords.length === 0,
            `got ${unstagedRecords.length}`,
        );

        // Clear + re-fetch — cache resets.
        wasm.clear_spawns_cache();
        check(
            "spawns_cache_size reset to 0 after clear",
            wasm.spawns_cache_size() === 0,
        );
    } finally {
        server.close();
    }

    console.log("===========================================");
    console.log(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
});
