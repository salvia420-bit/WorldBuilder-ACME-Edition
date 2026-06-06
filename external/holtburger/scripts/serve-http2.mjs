#!/usr/bin/env node
// serve-http2.mjs — optional HTTP/2 dev server for the Holtburger web client.
//
// WHY THIS EXISTS
// ---------------
// The wasm resource layer already fires shard fetches up to 32-concurrent
// (manifest_source.rs `try_join_all` + a 32-permit semaphore). But the default
// dev server (`scripts/serve.py`) is HTTP/1.1, and browsers cap HTTP/1.1 at ~6
// connections per origin — so that 32-way concurrency is throttled down to 6 at
// the transport, and a cold load issues its ~1500 requests in ~6-wide waves.
//
// HTTP/2 multiplexes every request over ONE connection with no 6-stream cap, so
// the browser can actually issue the concurrency the client already asks for.
// Combined with the `<link rel="modulepreload">` graph in index.html, the whole
// boot fan-out (modules + DAT shards) lands in parallel instead of serialized.
//
// Browsers only speak HTTP/2 over TLS (ALPN `h2`), so this server runs HTTPS
// with a self-signed cert it generates on first run. You'll get a one-time
// "not secure" interstitial on localhost — accept it (or `--ignore-certificate-
// errors` for headless Chrome). `allowHTTP1: true` keeps plain HTTP/1.1 clients
// working too.
//
// This is a SUPPLEMENT to serve.py, not a replacement: it runs on a different
// port (8766) so you can keep serve.py on 8765. It does NOT do serve.py's
// baked-layer validation / dist-symlink repair — run `scripts/serve.py --check`
// once first (or just start serve.py) to ensure `dist` is bound.
//
// USAGE
//   node scripts/serve-http2.mjs                 # https://127.0.0.1:8766/apps/holtburger-web/index.html
//   node scripts/serve-http2.mjs --port 9443
//   PORT=9443 node scripts/serve-http2.mjs
//   node scripts/serve-http2.mjs --bind 0.0.0.0  # expose on LAN / tunnel

import http2 from "node:http2";
import { createReadStream, existsSync, statSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname, normalize, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLT_ROOT = resolve(HERE, ".."); // external/holtburger — same tree serve.py serves
const CERT_DIR = resolve(HERE, ".http2-cert");
const KEY_PATH = join(CERT_DIR, "dev-key.pem");
const CRT_PATH = join(CERT_DIR, "dev-cert.pem");

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = parseInt(argVal("--port", process.env.PORT || "8766"), 10);
const BIND = argVal("--bind", "127.0.0.1");

// --- self-signed cert (generated once) --------------------------------------
function ensureCert() {
  if (existsSync(KEY_PATH) && existsSync(CRT_PATH)) return;
  mkdirSync(CERT_DIR, { recursive: true });
  // SAN covers localhost + loopback so Chrome doesn't reject the name outright.
  const subj = "/CN=holtburger-dev";
  const ext = "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1";
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY_PATH, "-out", CRT_PATH,
        "-days", "3650", "-subj", subj, "-addext", ext,
      ],
      { stdio: "pipe" }
    );
    console.error(`[serve-http2] generated self-signed cert in ${CERT_DIR}`);
  } catch (e) {
    console.error("[serve-http2] FAILED to generate cert via openssl:", e.message);
    console.error("[serve-http2] install openssl, or drop your own dev-key.pem/dev-cert.pem into", CERT_DIR);
    process.exit(1);
  }
}

// --- MIME (mirror what the page needs; .wasm is the load-bearing one) --------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bin": "application/octet-stream",
  ".hba": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
const mimeFor = (p) => MIME[extname(p).toLowerCase()] || "application/octet-stream";

// Same cache policy as serve.py: content-addressed shards are immutable; every
// other (stable-named, re-pointed-per-bake) asset stays no-cache for dev.
function cacheHeaders(urlPath, status) {
  if (urlPath.startsWith("/dist/shards/") && status >= 200 && status < 300) {
    return { "cache-control": "public, max-age=31536000, immutable" };
  }
  return {
    "cache-control": "no-cache, no-store, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  };
}

function resolveSafe(urlPath) {
  // Strip query/hash, decode, normalise, and confine to HOLT_ROOT.
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = normalize(clean).replace(/^(\.\.[/\\])+/, "");
  const abs = resolve(HOLT_ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
  if (abs !== HOLT_ROOT && !abs.startsWith(HOLT_ROOT + "/")) return null; // traversal guard
  return abs;
}

ensureCert();

const server = http2.createSecureServer({
  key: readFileSync(KEY_PATH),
  cert: readFileSync(CRT_PATH),
  allowHTTP1: true, // HTTP/1.1 clients still work
});

server.on("stream", (stream, headers) => {
  const urlPath = headers[":path"] || "/";
  const abs = resolveSafe(urlPath);
  const fail = (code) => {
    stream.respond({ ":status": code, ...cacheHeaders(urlPath, code) });
    stream.end(code === 404 ? "Not Found" : "Error");
  };
  if (!abs) return fail(403);

  let st;
  try {
    st = statSync(abs);
  } catch {
    return fail(404);
  }
  const file = st.isDirectory() ? join(abs, "index.html") : abs;
  if (!existsSync(file)) return fail(404);

  let size;
  try {
    size = statSync(file).size;
  } catch {
    return fail(404);
  }

  stream.respond({
    ":status": 200,
    "content-type": mimeFor(file),
    "content-length": size,
    ...cacheHeaders(urlPath, 200),
  });
  const rs = createReadStream(file);
  rs.on("error", () => {
    if (!stream.headersSent) fail(500);
    else stream.end();
  });
  rs.pipe(stream);
});

server.on("error", (e) => {
  console.error("[serve-http2] server error:", e.message);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  console.error(`[serve-http2] HTTP/2 (TLS, self-signed) serving ${HOLT_ROOT}`);
  console.error(`[serve-http2] open https://${BIND}:${PORT}/apps/holtburger-web/index.html`);
  console.error(`[serve-http2] (accept the one-time cert warning; headless Chrome: --ignore-certificate-errors)`);
});
