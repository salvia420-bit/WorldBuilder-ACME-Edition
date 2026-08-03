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
        // Stamp the bake identity these just-fetched bytes belong to.
        // Without it the first real request would see "stored id: null",
        // purge, and re-fetch everything the prefetch just warmed.
        try {
          const bootUrl = new URL("../../dist/boot.hba", self.location.href);
          const id = await currentBakeId(bootUrl);
          if (id) await writeStoredBakeId(cache, id);
        } catch (e) {
          console.warn("[holtburger-sw] bake-id stamp during install failed:", e);
        }
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

// ── THE CACHE-KEY INVARIANT (2026-08-03 review, finding F1) ────────────────
//
// Cache-first is sound for exactly ONE class of URL: **content-addressed**
// ones, where the bytes are a function of the path, so "same URL" implies
// "same bytes" and a re-bake necessarily writes a NEW path.
//
// `/shards/` qualifies — `dist/manifest.json` ships
// `shard_url_template: "shards/{sha256_prefix2}/{sha256}.bin"`.
//
// `boot.hba` and the per-namespace catalogs do NOT. They keep the SAME
// URL across bakes (`boot_pack.url: "boot.hba"`,
// `catalog_url_template: "manifest/{namespace_slug}.bin"`) and change
// their BYTES. Cache-first on them was a shipped-stale-content bug, and
// the comment that used to sit here — "bake updates change the hash
// inside `manifest.json` which the page refreshes each load" — was the
// reason it looked safe. A fresh `manifest.json` cannot invalidate a
// cache keyed by URL. What actually happened after a re-bake:
//   - boot.hba: the wasm hard-verifies it against the FRESH manifest
//     (`crates/holtburger-resource-http/src/manifest_source.rs:497-503`)
//     and raises `boot.hba hash mismatch` — a returning client with a warm
//     cache could not boot at all until `?nosw=1`.
//   - catalogs: a stale catalog indexes shard hashes the new bake no
//     longer emits → per-LB 404s → the silent "0 placements" empty world.
//
// So they are cached under a BAKE-IDENTITY GATE instead: the identity is
// read from the very manifest the page refreshes each load, and any change
// purges every non-content-addressed entry before it can be served. That
// keeps the cold-load win these entries exist for (they are the boot
// fan-out) without ever handing back another bake's bytes. If the identity
// cannot be established, the gate FAILS SAFE to network-first — an
// unknown bake is never allowed to serve from cache.

/** Content-addressed: path ⇒ bytes. Safe to serve cache-first forever. */
function isContentAddressed(url) {
  return url.pathname.includes("/shards/");
}

/**
 * Bake-immutable but NOT content-addressed: same URL every bake, different
 * bytes. Cacheable only behind the bake-identity gate below.
 * Specifically NOT `/manifest.json` — that is the top-level pointer the
 * page re-fetches each load, and it is what the gate reads.
 */
function isBakeVersioned(url) {
  if (url.pathname.endsWith("/boot.hba")) return true;
  if (url.pathname.includes("/manifest/") && url.pathname.endsWith(".bin")) {
    return true;
  }
  return false;
}

function isCacheable(url) {
  return isContentAddressed(url) || isBakeVersioned(url);
}

// Synthetic cache key holding the bake identity the cached
// non-content-addressed entries belong to. Never served to the page.
const BAKE_ID_KEY = "/__holtburger_bake_id";
// SINGLE-FLIGHT, deliberately NOT time-memoised. The boot fan-out
// (boot.hba + N catalogs) is concurrent, so one shared in-flight read
// collapses it to a single ~1 KB manifest fetch — but every request that
// arrives after that read SETTLES re-reads. A TTL here would re-open the
// exact hole this gate closes: a SW instance that survives a re-bake would
// keep serving the previous bake's boot.hba for the length of the TTL, and
// that is the unbootable-client failure, not a slow one.
const _bakeIdInflight = new Map(); // manifestUrl → Promise<string|null>

/**
 * The manifest that governs a given asset, derived from the REQUEST path
 * rather than a hardcoded `/dist/` — this is the inverse of the wasm's
 * `join_url(manifest_url, boot_pack.url)`, so it stays correct under any
 * dist base (tunnel, sub-path deploy, capture harness).
 */
function manifestUrlFor(url) {
  const p = url.pathname;
  if (p.endsWith("/boot.hba")) {
    return new URL(p.slice(0, p.length - "boot.hba".length) + "manifest.json", url.origin).href;
  }
  const i = p.lastIndexOf("/manifest/");
  if (i >= 0) {
    return new URL(p.slice(0, i + 1) + "manifest.json", url.origin).href;
  }
  return null;
}

/** Current bake identity, or null when it cannot be established. */
async function currentBakeId(url) {
  const manifestUrl = manifestUrlFor(url);
  if (!manifestUrl) return null;
  const pending = _bakeIdInflight.get(manifestUrl);
  if (pending) return pending;
  const p = (async () => {
    try {
      // `no-store`: the gate must never read the HTTP cache's copy of the
      // pointer it exists to check.
      const res = await fetch(manifestUrl, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return null;
      const m = await res.json();
      const sha = m?.boot_pack?.sha256 ?? "";
      const cat = m?.catalog_version ?? "";
      const gen = m?.generated_at ?? "";
      if (!sha && !cat && !gen) return null;
      return `${sha}:${cat}:${gen}`;
    } catch (_) {
      return null;
    }
  })();
  _bakeIdInflight.set(manifestUrl, p);
  try {
    return await p;
  } finally {
    _bakeIdInflight.delete(manifestUrl);
  }
}

async function readStoredBakeId(cache) {
  try {
    const r = await cache.match(BAKE_ID_KEY);
    return r ? await r.text() : null;
  } catch (_) {
    return null;
  }
}

async function writeStoredBakeId(cache, id) {
  try {
    await cache.put(BAKE_ID_KEY, new Response(id, { headers: { "content-type": "text/plain" } }));
  } catch (_) { /* best-effort — a failed write just re-purges next time */ }
}

/**
 * Drop every non-content-addressed entry. Shards are left alone: they are
 * content-addressed, so surviving ones are still valid bytes for their URL.
 */
async function purgeBakeVersioned(cache) {
  try {
    const keys = await cache.keys();
    await Promise.all(
      keys.map(async (req) => {
        try {
          if (isBakeVersioned(new URL(req.url))) await cache.delete(req);
        } catch (_) { /* skip unparseable keys */ }
      })
    );
  } catch (_) { /* best-effort */ }
}

/**
 * Reconcile the cache against the live bake identity.
 * @returns {boolean} true when cached bake-versioned entries may be served.
 */
async function bakeGateAllowsCache(cache, url) {
  const id = await currentBakeId(url);
  // Unknown identity ⇒ never serve a possibly-stale copy.
  if (id == null) return false;
  const stored = await readStoredBakeId(cache);
  if (stored !== id) {
    await purgeBakeVersioned(cache);
    await writeStoredBakeId(cache, id);
  }
  return true;
}

// Load-regression fix 2026-08-03: static scene3d imagery (terrain_macro's
// 9 MB PNG set, ui_brackets, pbr/bc7 sets) was never SW-cached, so every
// page load re-crossed the network for it — brutal over a tunnel. Unlike
// shards these URLs are NOT content-addressed, so plain cache-first would
// pin stale art forever; they get STALE-WHILE-REVALIDATE instead — cached
// bytes serve instantly, a background refetch updates the cache for the
// NEXT load. (`?nosw=1` remains the hard bypass, as everywhere.)
function isSwrCacheable(url) {
  return url.pathname.includes("/scene3d/assets/");
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
  const swr = isSwrCacheable(url);
  if (!isCacheable(url) && !swr) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CONTENT_CACHE).catch(() => null);
      // Bake-identity gate (see the invariant block above). Runs BEFORE the
      // cache read so a re-baked asset can never be served from a previous
      // bake, and returns false when the identity is unknown — in which case
      // this request is network-first with the cache as an offline fallback.
      let mayServeCached = true;
      if (cache && isBakeVersioned(url)) {
        mayServeCached = await bakeGateAllowsCache(cache, url);
      }
      if (cache && mayServeCached) {
        const cached = await cache.match(event.request).catch(() => null);
        if (cached) {
          if (swr) {
            // Serve stale now, refresh in the background for next load.
            event.waitUntil(
              fetch(event.request)
                .then((network) => {
                  if (network.ok && network.type === "basic") {
                    return cache.put(event.request, network);
                  }
                })
                .catch(() => {})
            );
          }
          return cached;
        }
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
        // Network failed. When the bake gate withheld the cache (unknown
        // identity, i.e. manifest.json unreachable — which is ALSO what an
        // offline load looks like), the cached copy is the best answer left:
        // being one bake behind beats no world at all, and the wasm's own
        // hash check is still the backstop if it is genuinely stale.
        if (cache && !mayServeCached) {
          const stale = await cache.match(event.request).catch(() => null);
          if (stale) {
            console.warn("[holtburger-sw] offline — serving unverified cached copy:", url.pathname);
            return stale;
          }
        }
        // Otherwise fall through to a direct passthrough so the page sees
        // the same response it would get without the SW.
        console.warn("[holtburger-sw] fetch failed, passing through:", e);
        return fetch(event.request);
      }
    })()
  );
});
