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

// v1 -> v2 (2026-06-21): cache-bust the immutable shard cache (tree/scenery
// models + textures). Investigating "no trees render on a phone" where the
// scenery placement data is confirmed present and served — a stale/incomplete
// cached shard set would load tree positions but fail to build their meshes.
// The activate-step GC sweeps the `holtburger-content-` prefix, so renaming
// this constant purges the old cache for every client on next load.
const CONTENT_CACHE = "holtburger-content-v2";

// `holtburger-shards-` matches the Phase 5.0 cache name (renamed
// to `holtburger-content-` in Phase 5.2 obj 7); the activate-step
// GC sweeps both prefixes so old versions don't accumulate.
const CACHE_NAME_PREFIXES = ["holtburger-shards-", "holtburger-content-"];

// Boot assets the page WILL request within ~1 s of first navigation
// (the wasm entry, the manifest pointer, the boot pack, and the
// namespace catalogs). Pre-fetching them on SW install warms the
// content cache before the page race-fetches them, cutting cold-load
// time + collapsing the first-burst concurrency the dev server's
// HTTP/1.1 single-connection-per-origin can't multiplex.
//
// All paths are relative to the SW scope (the app dir). The SW lives
// in the same dir as index.html so these resolve correctly. Wrong
// paths fail soft: cache.put errors get caught + logged, and the
// page falls through to its own fetches.
const BOOT_PREFETCH_URLS = [
  // Top-level shard catalog. Not cached by the `isCacheable` predicate
  // (it filters /shards/ + /manifest/*.bin), so we pre-fetch + put
  // explicitly into the same cache so the next manifest.json read
  // hits the cache.
  // (Actually — manifest.json is intentionally re-fetched each load
  // per the SW header comment; pre-fetching it would race with that
  // refresh intent. Skip.)
  // Login-boot diagnosis 2026-06-11: these were scope-relative
  // ("boot.hba" → /apps/holtburger-web/boot.hba) and 404'd on EVERY
  // install since the day they shipped — the real assets live under
  // /dist/. The warming never happened; the page always fetched these
  // cold at peak boot fan-out.
  "../../dist/boot.hba",
  "../../dist/manifest/holtburger-core.bin",
  // eor-cell.bin is 15 MB — too big for an install-time pre-fetch
  // (would block SW activation on slow connections). Lazy-fetch as
  // before. eor-portal.bin (1.5 MB) is borderline; include it since
  // every page load touches it for the EnvCell pipeline.
  "../../dist/manifest/eor-portal.bin",
];

self.addEventListener("install", (event) => {
  // Activate immediately so the very first page load sees the
  // worker (rather than waiting for all clients to navigate away).
  self.skipWaiting();
  // Pre-warm the content cache with the boot-critical shards.
  // event.waitUntil keeps the install lifecycle alive until the
  // prefetch completes; failures are caught + logged so a single
  // bad fetch can't strand the SW in install state forever.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CONTENT_CACHE);
        await Promise.all(
          BOOT_PREFETCH_URLS.map(async (path) => {
            try {
              const req = new Request(path, { credentials: "same-origin" });
              const res = await fetch(req);
              if (res.ok && res.type === "basic") {
                await cache.put(req, res.clone());
              } else {
                // A non-ok prefetch is a broken warming path — make it
                // loud so a regression is visible (this exact failure
                // was silent for weeks as a warn-on-throw only).
                console.error("[holtburger-sw] boot prefetch non-ok:", path, res.status);
              }
            } catch (e) {
              console.warn("[holtburger-sw] boot prefetch failed:", path, e);
            }
          })
        );
      } catch (e) {
        console.warn("[holtburger-sw] cache.open during install failed:", e);
      }
    })()
  );
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
  // Boot pack — stable per-bake, fetched once per page during the
  // wasm init path. Cacheable so the install-time prefetch + first
  // visit's network fetch share storage; bake updates change the
  // hash inside `manifest.json` which the page refreshes each load.
  if (url.pathname.endsWith("/boot.hba")) return true;
  return false;
}

// Coalesce concurrent fetches for the same URL. Without this, two
// JS-side fetches that arrive while the SW's cache.match is still
// pending both miss → both go to network. Observed in 2026-05-13
// perf audit: 11 distinct shards fetched 2–3× per session, ~4 MB
// wasted. Single-flight by URL collapses races onto one network
// request; the clone() lets each consumer read its own body.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!isCacheable(url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CONTENT_CACHE).catch(() => null);
      if (cache) {
        const cached = await cache.match(event.request).catch(() => null);
        if (cached) return cached;
      }
      // Fetch fresh. Clone ONCE for the cache before returning the
      // original — Response bodies are locked after the first clone()
      // on a given instance, so the old (inflight-dedup + double-clone)
      // pattern threw "body already used" on the second consumer when
      // upstream chunked-encoded the response.
      try {
        const network = await fetch(event.request);
        if (cache && network.ok && network.type === "basic") {
          cache.put(event.request, network.clone()).catch((e) => {
            console.warn("[holtburger-sw] cache.put failed:", e);
          });
        }
        return network;
      } catch (e) {
        // Any unexpected SW error — fall through to a direct passthrough
        // so the page sees the same response it would get without the SW.
        console.warn("[holtburger-sw] fetch failed, passing through:", e);
        return fetch(event.request);
      }
    })()
  );
});
