// Phase 5.0 obj 7 + Phase 5.2 obj 7 — IndexedDB-backed cache for
// bake-time-immutable v2 content (`/shards/...` + per-namespace
// `/manifest/<namespace>.bin` catalog binaries). Tries Cache
// Storage first, falls through to network, stashes 2xx-basic
// responses for next time.
//
// Cache Storage gives the durability guarantee the brief asks for
// (typically ~60% of total disk on Chrome, persistent across
// sessions, works offline). The top-level `/manifest.json`, boot
// pack, wasm bundle, page HTML, and WS bridge flow through
// untouched — fresh manifest fetch each load is intentional so
// WorldBuilder edits propagate. Fail-soft: if SW unavailable,
// `index.html` registration code logs and continues; nothing
// blocks on SW availability.

const CONTENT_CACHE = "holtburger-content-v1";

// `holtburger-shards-` matches the Phase 5.0 cache name (renamed
// to `holtburger-content-` in Phase 5.2 obj 7); the activate-step
// GC sweeps both prefixes so old versions don't accumulate.
const CACHE_NAME_PREFIXES = ["holtburger-shards-", "holtburger-content-"];

self.addEventListener("install", (event) => {
  // Activate immediately so the very first page load sees the
  // worker (rather than waiting for all clients to navigate away).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Take control of any in-flight clients on activation.
      await self.clients.claim();
      // Garbage-collect old cache versions. Matches both the
      // legacy Phase 5.0 prefix and the current Phase 5.2 prefix.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              CACHE_NAME_PREFIXES.some((p) => key.startsWith(p)) &&
              key !== CONTENT_CACHE
          )
          .map((key) => caches.delete(key))
      );
    })()
  );
});

function isCacheable(url) {
  // Shards: any URL whose path contains `/shards/`. Matches both
  // content-addressable (`shards/{prefix2}/{trunc32}.bin`) and
  // convention-URL (`shards/{namespace_slug}/{file_id_hex}.bin`)
  // layouts the v2 emitter ships.
  if (url.pathname.includes("/shards/")) return true;
  // V2 per-namespace catalogs at `/manifest/<namespace>.bin`.
  // Specifically NOT `/manifest.json` (the top-level pointer
  // re-fetched each load to detect bake updates).
  if (url.pathname.includes("/manifest/") && url.pathname.endsWith(".bin")) {
    return true;
  }
  return false;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!isCacheable(url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CONTENT_CACHE);
      const cached = await cache.match(event.request);
      if (cached) {
        return cached;
      }
      const network = await fetch(event.request);
      // Only cache successful, basic-type responses. Opaque
      // (cross-origin, no-CORS) responses can't be inspected for
      // status and would fill the cache with phantom entries on
      // failure. Same-origin assets always come back as `basic`.
      if (network.ok && network.type === "basic") {
        // `Response` bodies can only be read once; clone before
        // caching so the page still sees the body downstream.
        cache.put(event.request, network.clone()).catch((e) => {
          console.warn("[holtburger-sw] cache.put failed:", e);
        });
      }
      return network;
    })()
  );
});
