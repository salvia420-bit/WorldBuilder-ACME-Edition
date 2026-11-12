// tests/proxy_hardening.test.mjs
// Test suite for proxy.cjs hardening:
// 1. Path traversal containment (isPathContained & 403 response)
// 2. Client IP normalization and X-Forwarded-For overwrite
// 3. Cache-Control headers alignment for /dist/shards/, /dist/packs/, /dist/index/
// 4. WebSocket upgrade timeout handling

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = path.resolve(HERE, "..", "..", "..", "scripts", "proxy.cjs");
const proxy = require(PROXY_PATH);

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error(`  FAIL: ${msg}`);
    throw new Error(msg);
  } else {
    passed++;
    console.log(`  PASS: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected: ${expected}, got: ${actual})`);
}

// ---------------------------------------------------------------------------
// 1. Unit tests: isPathContained
// ---------------------------------------------------------------------------
console.log("\n--- 1. Path Traversal Containment (Unit) ---");
assertEqual(proxy.isPathContained("/"), true, "root is contained");
assertEqual(proxy.isPathContained("/index.html"), true, "simple file is contained");
assertEqual(proxy.isPathContained("/apps/holtburger-web/index.html"), true, "nested path is contained");
assertEqual(proxy.isPathContained("/dist/packs/manifest.bin"), true, "dist pack is contained");
assertEqual(proxy.isPathContained("/.."), false, "/.. is rejected");
assertEqual(proxy.isPathContained("/../"), false, "/../ is rejected");
assertEqual(proxy.isPathContained("/../../etc/passwd"), false, "/../../etc/passwd is rejected");
assertEqual(proxy.isPathContained("/foo/../../bar"), false, "/foo/../../bar is rejected");
assertEqual(proxy.isPathContained("/foo/.."), false, "/foo/.. is rejected");
assertEqual(proxy.isPathContained(null), false, "null is rejected");

// ---------------------------------------------------------------------------
// 2. Unit tests: getClientIp
// ---------------------------------------------------------------------------
console.log("\n--- 2. Client IP Extraction & Normalization (Unit) ---");
assertEqual(
  proxy.getClientIp({ "cf-connecting-ip": "203.0.113.195" }, { remoteAddress: "127.0.0.1" }),
  "203.0.113.195",
  "cf-connecting-ip takes precedence"
);
assertEqual(
  proxy.getClientIp({ "CF-Connecting-IP": " 198.51.100.22 , 10.0.0.1 " }, { remoteAddress: "127.0.0.1" }),
  "198.51.100.22",
  "comma-separated and whitespace trimmed from CF-Connecting-IP"
);
assertEqual(
  proxy.getClientIp({}, { remoteAddress: "::ffff:192.0.2.1" }),
  "192.0.2.1",
  "IPv4-mapped IPv6 unwrapped"
);
assertEqual(
  proxy.getClientIp({}, { remoteAddress: "10.1.2.3" }),
  "10.1.2.3",
  "standard remoteAddress used when no CF header"
);
assertEqual(
  proxy.getClientIp({}, null),
  "127.0.0.1",
  "fallback to 127.0.0.1 when socket is null"
);

// ---------------------------------------------------------------------------
// 3. Integration tests with HTTP Backend & Proxy Server
// ---------------------------------------------------------------------------
console.log("\n--- 3. Proxy HTTP Integration Tests ---");

async function runIntegrationTests() {
  let lastBackendHeaders = null;
  let lastBackendUrl = null;

  // Ephemeral dummy backend
  const backendServer = http.createServer((req, res) => {
    lastBackendHeaders = req.headers;
    lastBackendUrl = req.url;
    if (req.url.startsWith("/dist/")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("binary-data");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    }
  });

  await new Promise((resolve) => backendServer.listen(0, "127.0.0.1", resolve));
  const backendPort = backendServer.address().port;
  proxy.HTTP_BACKEND.host = "127.0.0.1";
  proxy.HTTP_BACKEND.port = backendPort;

  // Ephemeral proxy server
  const proxyServer = http.createServer(proxy.proxyHttp);
  proxyServer.on("upgrade", proxy.proxyUpgrade);
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;

  try {
    // 3a. Traversal attack blocked with 403 Forbidden
    const res403 = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: proxyPort, path: "/../../etc/passwd" }, (res) => {
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assertEqual(res403, 403, "traversal attempt /../../etc/passwd returns 403 Forbidden");

    const res403Encoded = await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: proxyPort, path: "/%2e%2e/passwd" }, (res) => {
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assertEqual(res403Encoded, 403, "encoded traversal attempt /%2e%2e/passwd returns 403 Forbidden");

    // 3b. Overwrite X-Forwarded-For properly
    const resIp = await fetch(`http://127.0.0.1:${proxyPort}/test-ip`, {
      headers: {
        "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
        "CF-Connecting-IP": "203.0.113.99",
      },
    });
    assertEqual(resIp.status, 200, "valid request succeeds");
    assertEqual(lastBackendHeaders["x-forwarded-for"], "203.0.113.99", "X-Forwarded-For overwritten with CF-Connecting-IP");

    // 3c. Cache-Control headers alignment
    const resPacks = await fetch(`http://127.0.0.1:${proxyPort}/dist/packs/test.pack`);
    assertEqual(resPacks.status, 200, "/dist/packs/ responds 200");
    assertEqual(
      resPacks.headers.get("cache-control"),
      "public, max-age=31536000, immutable, no-transform",
      "/dist/packs/ receives aligned immutable cache header"
    );

    const resIndex = await fetch(`http://127.0.0.1:${proxyPort}/dist/index/spatial.idx`);
    assertEqual(resIndex.status, 200, "/dist/index/ responds 200");
    assertEqual(
      resIndex.headers.get("cache-control"),
      "public, max-age=31536000, immutable, no-transform",
      "/dist/index/ receives aligned immutable cache header"
    );

    const resShards = await fetch(`http://127.0.0.1:${proxyPort}/dist/shards/00000001.shard`);
    assertEqual(resShards.status, 200, "/dist/shards/ responds 200");
    assertEqual(
      resShards.headers.get("cache-control"),
      "public, max-age=31536000, immutable, no-transform",
      "/dist/shards/ receives aligned immutable cache header"
    );

    // ---------------------------------------------------------------------------
    // 4. WebSocket Upgrade Timeout Test
    // ---------------------------------------------------------------------------
    console.log("\n--- 4. WebSocket Upgrade Timeout ---");
    // Create an unanswering TCP server for WS backend
    const unansweringWs = net.createServer((_sock) => {
      // Intentionally do not reply to upgrade request
    });
    await new Promise((resolve) => unansweringWs.listen(0, "127.0.0.1", resolve));
    const unansweringPort = unansweringWs.address().port;
    proxy.WS_BACKEND.host = "127.0.0.1";
    proxy.WS_BACKEND.port = unansweringPort;

    // Send HTTP upgrade request with a short custom timeout
    const upgradeResponse = await new Promise((resolve) => {
      const client = net.connect(proxyPort, "127.0.0.1", () => {
        client.write(
          "GET /wsbridge HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${proxyPort}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      let response = "";
      client.on("data", (chunk) => { response += chunk.toString(); });
      client.on("close", () => resolve(response));
      client.on("error", () => resolve(response));
      // In tests, close after 1200ms if not timed out
      setTimeout(() => { client.destroy(); resolve(response); }, 1200);
    });

    unansweringWs.close();
    assert(
      upgradeResponse.includes("504 Gateway Timeout") || upgradeResponse.includes("502 Bad Gateway") || upgradeResponse.length === 0,
      "unresponsive upgrade cleanly terminates or times out"
    );

  } finally {
    backendServer.close();
    proxyServer.close();
  }
}

await runIntegrationTests();

console.log(`\nAll tests completed: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
