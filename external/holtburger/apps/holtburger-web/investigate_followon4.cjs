// Follow-on #4 investigation script.
//
// Reproduces the "fetchEntityAnimationKeyframes returns 0 parts" issue
// for the Phase 7.4b capture's three test setups + the known-working
// humanoid baseline. Spins up an HTTP server backed by the existing
// `dist/` (v2 manifest) and calls each setup directly from Node.
//
// Run from `apps/holtburger-web/`:
//   node investigate_followon4.cjs
//
// Optional env:
//   HOLTBURGER_DIST_DIR — override dist path (default: ../../dist)

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const distDir = process.env.HOLTBURGER_DIST_DIR
  || path.resolve(__dirname, "../../dist");

if (!fs.existsSync(path.join(distDir, "manifest.json"))) {
  console.error(`FAIL: dist not found at ${distDir}`);
  process.exit(2);
}

// HTTP server serving dist/ at the root.
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.replace(/^\/+/, ""));
  const filePath = path.join(distDir, url);
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader("Connection", "close");
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
server.keepAliveTimeout = 0;

const SETUPS = [
  {
    setupId: 0x02000001,
    mtableId: 0x09000001,
    label: "Holtburger human (KNOWN GOOD)",
    expectedPartsHint: ">= 30",
  },
  // Phase 7.4b capture's stale labels:
  {
    setupId: 0x02000099,
    mtableId: 0x09000001,
    label: "0x02000099 (capture's 'SparringGolem' — VERIFY)",
  },
  {
    setupId: 0x020001ed,
    mtableId: 0x09000001,
    label: "0x020001ED (capture's 'Mite' — VERIFY)",
  },
  {
    setupId: 0x0200013d,
    mtableId: 0x09000001,
    label: "0x0200013D (capture's 'Drudge' — VERIFY)",
  },
  // Real setup/mtable IDs from the LSD weenie JSONs:
  // wcid 12698 Sparring Golem
  {
    setupId: 0x020007cc,
    mtableId: 0x09000081,
    label: "REAL Sparring Golem (wcid 12698) didStats key1=0x020007CC, key2=0x09000081",
  },
  // wcid 945 Mite Sentry
  {
    setupId: 0x02001080,
    mtableId: 0x0900000b,
    label: "REAL Mite Sentry (wcid 945) didStats key1=0x02001080, key2=0x0900000B",
  },
  // Mite Sentry with stance override — see if any combat stance has WALK
  {
    setupId: 0x02001080,
    mtableId: 0x0900000b,
    label: "Mite Sentry RUN cmd (0x44000007) instead of WALK",
    cmd: 0x44000007,
  },
  // Other mite candidates that share setup 0x02001080
  {
    setupId: 0x02001080,
    mtableId: 0x0900000b,
    label: "Mite Sentry TURN_LEFT (0x6500000E)",
    cmd: 0x6500000E,
  },
  // wcid 30649 Drudge Toiler
  {
    setupId: 0x020007dd,
    mtableId: 0x09000008,
    label: "REAL Drudge Toiler (wcid 30649) didStats key1=0x020007DD, key2=0x09000008",
  },
  // wcid 42853 Drudge — only setupId in didStats, no mtable
  {
    setupId: 0x020019a4,
    mtableId: 0,
    label: "REAL Drudge (wcid 42853) didStats key1=0x020019A4, no mtable",
  },
];

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const manifestUrl = `http://127.0.0.1:${port}/manifest.json`;
  console.log(`server listening on http://127.0.0.1:${port}`);

  const wasm = require("./pkg-node/holtburger_web.js");
  await wasm.init_resource_source(manifestUrl);
  console.log(`init_resource_source ok; has_resource_source=${wasm.has_resource_source()}, manifest_version=${wasm.manifest_version()}`);

  const WALK = 0x45000005;
  const results = [];

  for (const s of SETUPS) {
    process.stdout.write(`\n--- ${s.label}\n    setup=0x${s.setupId.toString(16).padStart(8, "0")} mtable=0x${s.mtableId.toString(16).padStart(8, "0")}\n`);
    try {
      const t0 = Date.now();
      const cmd = s.cmd ?? WALK;
      const anim = await wasm.fetchEntityAnimationKeyframes(
        s.setupId,
        new Uint32Array(0),
        new Uint32Array(0),
        0,
        new Uint32Array(0),
        s.mtableId,
        cmd,
        0,
      );
      const took = Date.now() - t0;
      const result = {
        label: s.label,
        setupId: s.setupId,
        mtableId: s.mtableId,
        partCount: anim.partCount,
        numFrames: anim.numFrames,
        framerate: anim.framerate,
        resolvedStance: "0x" + anim.resolvedStance.toString(16).padStart(8, "0"),
        partFramesLen: anim.partFrames?.length ?? 0,
        meshPartsLen: anim.takePartMeshes()?.length ?? 0,
        took,
      };
      console.log(`    partCount=${result.partCount}, numFrames=${result.numFrames}, framerate=${result.framerate}, resolvedStance=${result.resolvedStance}, partFramesLen=${result.partFramesLen}, meshPartsLen=${result.meshPartsLen}, took=${result.took}ms`);
      results.push(result);
    } catch (e) {
      console.log(`    THREW: ${String(e).slice(0, 200)}`);
      results.push({
        label: s.label,
        setupId: s.setupId,
        mtableId: s.mtableId,
        error: String(e),
      });
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    if (r.error) {
      console.log(`  THREW  0x${r.setupId.toString(16).padStart(8, "0")} ${r.label} :: ${r.error.slice(0, 90)}`);
    } else {
      console.log(`  parts=${r.partCount} frames=${r.numFrames} fps=${r.framerate.toFixed(1)} stance=${r.resolvedStance} :: 0x${r.setupId.toString(16).padStart(8, "0")} ${r.label}`);
    }
  }

  server.close();
})().catch((err) => {
  console.error("FATAL:", err);
  server.close();
  process.exit(1);
});
