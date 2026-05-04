// Phase 5.0 obj 7 — IndexedDB-backed shard cache.
//
// Intercepts `fetch` events for any URL containing `/shards/`,
// tries the persistent Cache Storage first, falls through to
// network on miss, stashes successful responses for next time.
//
// # Why a service worker
//
// The HTTP browser cache is volatile — Chrome caps total cache at
// roughly 50% of free disk and evicts on pressure. Cache Storage
// (the API service workers use) is durable across sessions and has
// higher quotas (typically ~60% of total disk on Chrome). It also
// works offline, which matters for the "playing on a flaky
// connection" use case the Phase 5.0 brief targets.
//
// # Why Cache Storage rather than IndexedDB directly
//
// Cache Storage is the right primitive: it is keyed by `Request`
// (URL + method + Vary headers), serves `Response` objects natively,
// and is what every PWA tutorial uses. IndexedDB would require us
// to manage URL→bytes mapping by hand and re-construct `Response`
// objects on read. The brief calls out IndexedDB for the durability
// guarantee — Cache Storage gets the same guarantee.
//
// # Fail-soft
//
// If the browser doesn't support service workers (very old
// versions), `index.html`'s registration code logs and continues —
// shard fetches go through the network + HTTP cache as before.
// Never block the page on SW availability.
//
// # Scope
//
// Only intercepts URLs containing `/shards/`. The boot pack itself
// (`boot.hba`), the manifest (`manifest.json`), the wasm bundle,
// the page HTML, and the WebSocket bridge URL all flow through
// untouched. Manifest re-fetches are intentional — the manifest is
// the version pointer, and a fresh fetch on each page load is what
// lets WorldBuilder edits propagate.

const SHARD_CACHE = "holtburger-shards-v1";

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
      // Garbage-collect old cache versions if a future commit bumps
      // SHARD_CACHE.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("holtburger-shards-") && key !== SHARD_CACHE)
          .map((key) => caches.delete(key))
      );
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!url.pathname.includes("/shards/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHARD_CACHE);
      const cached = await cache.match(event.request);
      if (cached) {
        return cached;
      }
      const network = await fetch(event.request);
      // Only cache successful, basic-type responses. Opaque
      // (cross-origin, no-CORS) responses can't be inspected for
      // status and would fill the cache with phantom entries on
      // failure. Same-origin shards always come back as `basic`.
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
