// Tiny reverse proxy: combines the holtburger HTTP server (8765) and
// wsbridge (8080) under one origin so a Cloudflare quick tunnel can
// expose both to the public internet through one URL.
//
//   /wsbridge → WebSocket upgrade → 127.0.0.1:8080
//   /*        → HTTP forward       → 127.0.0.1:8765
//
// Listens on 127.0.0.1:7080 (no public binding; cloudflared connects
// outbound to Cloudflare and forwards inbound back to this port).
//
// Run with: `node scripts/proxy.cjs` from the holtburger repo root
// (or `node external/holtburger/scripts/proxy.cjs` from the
// WorldBuilder-ACME-Edition root). Survives reboots when launched
// from this canonical location; the previous deployment lived under
// /tmp/holtburger_proxy.cjs and was lost on reboot.

const http = require("http");
const net = require("net");
const url = require("url");

const PROXY_PORT = 7080;
const HTTP_BACKEND = { host: "127.0.0.1", port: 8765 };
const WS_BACKEND = { host: "127.0.0.1", port: 8080 };

// Login-boot diagnosis 2026-06-11: the default global agent opens an
// unbounded number of parallel upstream sockets (maxSockets=Infinity),
// which overflowed serve.py's accept queue during the boot fan-out.
// A bounded keep-alive pool caps upstream concurrency at a level the
// listener absorbs and reuses sockets now that serve.py speaks HTTP/1.1.
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 });

function proxyHttp(clientReq, clientRes) {
  // Strip /wsbridge prefix if it ever shows up as a regular HTTP request
  // (it shouldn't — that path is only for upgrade requests — but be safe).
  let targetPath = clientReq.url;
  if (targetPath.startsWith("/wsbridge")) {
    // Plain HTTP at /wsbridge probably came from a misclick; serve the
    // base server's response (404 or whatever) by stripping the prefix.
    targetPath = targetPath.replace(/^\/wsbridge\/?/, "/");
  }

  // Cache-Control for content-addressable assets. /dist/shards/{prefix}/
  // {sha256}.bin URLs are immutable by construction — once the SHA matches,
  // the bytes never change, so a year-long max-age with `immutable` lets the
  // browser skip even the revalidation round-trip. Leaves manifest.json,
  // boot.hba (which re-points each bake), index.html, wasm bundle (regen on
  // every wasm-pack), and atlas.{js,png} (non-hash-named) revalidating as
  // before so a fresh bake propagates immediately.
  const isImmutable = /^\/dist\/shards\/[0-9a-f]{2}\/[0-9a-f]+\.bin/i.test(targetPath);

  const proxyReq = http.request(
    {
      host: HTTP_BACKEND.host,
      port: HTTP_BACKEND.port,
      agent: upstreamAgent,
      method: clientReq.method,
      path: targetPath,
      headers: { ...clientReq.headers, host: `${HTTP_BACKEND.host}:${HTTP_BACKEND.port}` },
    },
    (proxyRes) => {
      const outHeaders = { ...proxyRes.headers };
      if (isImmutable && proxyRes.statusCode === 200) {
        outHeaders["cache-control"] = "public, max-age=31536000, immutable";
      }
      clientRes.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(clientRes);
    }
  );
  proxyReq.on("error", (err) => {
    console.error(`[http] backend error: ${err.message}`);
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`bad gateway: ${err.message}`);
  });
  clientReq.pipe(proxyReq);
}

function proxyUpgrade(clientReq, clientSocket, head) {
  const requestedPath = clientReq.url || "/";
  // Only /wsbridge* routes are accepted for WS upgrade. Anything else
  // (e.g. a misrouted upgrade attempt) gets rejected.
  if (!requestedPath.startsWith("/wsbridge")) {
    clientSocket.write(
      "HTTP/1.1 404 Not Found\r\n" +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n\r\n"
    );
    clientSocket.destroy();
    return;
  }

  // Forward to wsbridge with the prefix stripped (wsbridge expects /).
  const upstreamPath = requestedPath.replace(/^\/wsbridge\/?/, "/") || "/";

  const upstream = net.connect(WS_BACKEND.port, WS_BACKEND.host, () => {
    // Re-issue the HTTP upgrade request to the wsbridge with our chosen
    // path. Headers carried through (including Sec-WebSocket-Key etc.)
    // so the upstream completes the upgrade correctly.
    const headerLines = Object.entries(clientReq.headers).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`
    );
    const req =
      `GET ${upstreamPath} HTTP/1.1\r\n` +
      headerLines.join("\r\n") +
      "\r\n\r\n";
    upstream.write(req);
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  upstream.on("error", (err) => {
    console.error(`[ws] wsbridge connect error: ${err.message}`);
    try {
      clientSocket.write(
        "HTTP/1.1 502 Bad Gateway\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n\r\n"
      );
    } catch {}
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on("upgrade", proxyUpgrade);
// 2026-06-09 — bind all interfaces so the app + /wsbridge are reachable
// over Tailscale (e.g. http://100.x:7080) directly, without a cloudflared
// quick-tunnel (which kept resetting long-lived game WebSockets). Tailscale
// is WireGuard, so this is only reachable by tailnet peers + the LAN; the
// game UDP bridge it fronts (wsbridge :8080) already binds 0.0.0.0.
server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(
    `proxy listening on 0.0.0.0:${PROXY_PORT}` +
      `; HTTP→${HTTP_BACKEND.host}:${HTTP_BACKEND.port}` +
      `; WS /wsbridge→${WS_BACKEND.host}:${WS_BACKEND.port}`
  );
});
