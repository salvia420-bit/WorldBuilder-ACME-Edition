// Phase 5.0 obj 7 + Phase 5.2 obj 7 — IndexedDB-backed cache for
// bake-time-immutable v2 content (`/shards/...` + per-namespace
// `/manifest/<namespace>.bin` catalog binaries). Tries Cache
// Storage first, falls through to network, stashes 2xx-basic
// responses for next time (content-addressed ones only once their
// sha256 matches the name — see CAS VERIFY-BEFORE-PERSIST below).
//
// Cache Storage gives the durability guarantee the brief asks for
// (typically ~60% of total disk on Chrome, persistent across
// sessions, works offline). The top-level `/manifest.json`, boot
// pack, wasm bundle, page HTML, and WS bridge flow through
// untouched — fresh manifest fetch each load is intentional so
// WorldBuilder edits propagate. Fail-soft: if SW unavailable,
// `index.html` registration code logs and continues; nothing
// blocks on SW availability.

// ── SW v3 (T12 / ST2, SPEC §1.1 as unified by F-11.11) — LANDED DORMANT ────
//
// `SW_V3 = false` ships the CURRENT worker byte-for-byte in behavior. The
// ORCHESTRATOR flips this constant to `true` together with the `?packSource`
// default flip (a migration event; implementation agents never flip it).
//
// What `true` changes:
//   * cache renames to `holtburger-content-v3` (the activate-step prefix GC
//     purges v2 on every client's next load);
//   * the SW intercepts ONLY content-addressed paths — `packs/`, `index/`,
//     plus legacy `shards/` (which is ALSO the full-tier texture CAS today)
//     until ST10 drops it — and keeps the `/scene3d/assets/` SWR class.
//     Cache-first-forever is sound for exactly this class: path ⇒ bytes;
//   * `boot.hba` + `manifest/*.bin` are NO LONGER intercepted (network +
//     HTTP cache), so the whole bake-identity gate below is unreachable —
//     v3 has no bake-versioned URLs left to gate. The gate machinery is
//     DELETED (not ported) at ST10's ledger, not here;
//   * the install-time boot prefetch is skipped (its URLs are exactly the
//     bake-versioned class v3 stops intercepting);
//   * `manifest.json` / HTML / JS / wasm stay un-intercepted in BOTH modes;
//     offline manifest fallback is the PackFetchController's job (a
//     controller-stashed last-known manifest), never the SW's.
const SW_V3 = false;

// v1 -> v2 (2026-06-21): cache-bust the immutable shard cache (tree/scenery
// models + textures). Investigating "no trees render on a phone" where the
// scenery placement data is confirmed present and served — a stale/incomplete
// cached shard set would load tree positions but fail to build their meshes.
// The activate-step GC sweeps the `holtburger-content-` prefix, so renaming
// this constant purges the old cache for every client on next load.
const CONTENT_CACHE = SW_V3 ? "holtburger-content-v3" : "holtburger-content-v2";

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
  // v3: no install-time warming — the prefetch list is the bake-versioned
  // class v3 no longer intercepts, and pack CAS warming is the
  // PackFetchController's boot-wave job, not the SW's.
  if (SW_V3) return;
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

/**
 * Content-addressed: path ⇒ bytes. Safe to serve cache-first forever.
 * v3 adds `packs/` + `index/` (HBP1 packs + HBSI1 index, CAS-named) and
 * keeps `shards/` allowlisted until ST10 (F-11.11) — today it is ALSO the
 * full-tier texture CAS. `/index/` (with both slashes) cannot match
 * `index.html`.
 */
function isContentAddressed(url) {
  const p = url.pathname;
  if (SW_V3) {
    return p.includes("/shards/") || p.includes("/packs/") || p.includes("/index/");
  }
  return p.includes("/shards/");
}

/**
 * Bake-immutable but NOT content-addressed: same URL every bake, different
 * bytes. Cacheable only behind the bake-identity gate below.
 * Specifically NOT `/manifest.json` — that is the top-level pointer the
 * page re-fetches each load, and it is what the gate reads.
 * v3: ALWAYS false — the class is no longer intercepted at all (the
 * structural fix; the gate below becomes unreachable and is deleted at
 * ST10's ledger).
 */
function isBakeVersioned(url) {
  if (SW_V3) return false;
  if (url.pathname.endsWith("/boot.hba")) return true;
  if (url.pathname.includes("/manifest/") && url.pathname.endsWith(".bin")) {
    return true;
  }
  return false;
}

function isCacheable(url) {
  return isContentAddressed(url) || isBakeVersioned(url);
}

// ── CAS VERIFY-BEFORE-PERSIST (2026-10-13, WebAC comparison streaming-residency-4)
//
// Cache-first-forever is sound only while what went INTO the cache really is
// the bytes the path names. Every consumer sha-verifies its bodies (the shard
// fetch worker + wasm Step E for `shards/`, the PackFetchController for
// `packs/` + `index/`) and fails a mismatched key, but this worker used to
// persist every 200 unverified and answer every retry from Cache Storage — so
// one bad body (a file served mid-write during a re-stage, disk corruption, a
// proxy's 200 error page) failed that key in this session and every later one.
// For content-addressed paths only:
//   * verify before persisting — the page gets the network response at once;
//     a clone is hashed under waitUntil and `cache.put` runs only when its
//     sha256 prefix equals the hash in the name. A name that does not parse
//     (or no digest engine) keeps the old unverified put;
//   * honour a cache-bypass request — `cache: "reload"` / `"no-store"` skips
//     `cache.match`, goes to the network (past the immutable HTTP cache too)
//     and a verified 200 overwrites the entry. The consumers send `reload` on
//     the retry after a verify failure (scene3d/shard_fetch_worker.js, the
//     wasm direct path in holtburger-resource-http http.rs, and
//     pack_fetch_controller.js D-03.5), so a bad entry heals on its next retry.
// (WebAC does the same: packages/renderer/src/dat/streaming/DatStore.ts
// `fetchAndVerify` puts only after `inflateChecked` passes.)

/**
 * The truncated sha256 (lowercase hex) a content-addressed path names, or
 * null when the name does not parse. Each CAS name is the sha256 of the
 * file's bytes, truncated to 32 hex: `shards/{sha256_prefix2}/{sha256}.bin`
 * (manifest `shard_url_template`), `packs/{sha256_prefix2}/{sha256}.hbp`
 * (`pack_url_template`), `index/{sha256_16}.bin` (`world_index.url`).
 */
function casHashFromPath(pathname) {
  const m = /\/(?:shards|packs|index)\/(?:[0-9a-f]{2}\/)?([0-9a-f]{32,64})\.(?:bin|hbp)$/i.exec(pathname);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Lowercase hex sha256 of `buf`, or null when there is no digest engine. A
 * service worker only runs in a secure context, so `crypto.subtle` is always
 * there; null means a test sandbox, which then keeps the old put.
 */
async function sha256HexOf(buf) {
  const subtle = typeof crypto !== "undefined" && crypto ? crypto.subtle : null;
  if (!subtle || typeof subtle.digest !== "function") return null;
  const u = new Uint8Array(await subtle.digest("SHA-256", buf));
  let hex = "";
  for (let i = 0; i < u.length; i++) hex += u[i].toString(16).padStart(2, "0");
  return hex;
}

/** The request asked to skip the caches (`cache: "reload"` / `"no-store"`). */
function cacheBypassRequested(request) {
  const mode = request ? request.cache : undefined;
  return mode === "reload" || mode === "no-store";
}

/**
 * Persist a content-addressed 200 only when its bytes hash to its name.
 * `network` itself goes to the page untouched: two clones are taken before
 * it is returned — one hashed, one stored — and the work runs under
 * waitUntil. A body that cannot be read in full is never stored.
 */
function putContentAddressed(event, cache, url, network) {
  const want = casHashFromPath(url.pathname);
  if (!want) {
    cache.put(event.request, network.clone()).catch((e) => {
      console.warn("[holtburger-sw] cache.put failed:", e);
    });
    return;
  }
  const forHash = network.clone();
  const forCache = network.clone();
  const discard = () => {
    try {
      if (forCache.body) forCache.body.cancel().catch(() => {});
    } catch (_) { /* nothing left to release */ }
  };
  event.waitUntil(
    (async () => {
      let got;
      try {
        got = await sha256HexOf(await forHash.arrayBuffer());
      } catch (_) {
        discard();
        return;
      }
      if (got !== null && got.slice(0, want.length) !== want) {
        console.warn("[holtburger-sw] content hash mismatch, not cached:", url.pathname, `got ${got.slice(0, want.length)}`);
        discard();
        return;
      }
      try {
        await cache.put(event.request, forCache);
      } catch (e) {
        console.warn("[holtburger-sw] cache.put failed:", e);
      }
    })()
  );
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

// 2026-10-20 (improvement hunt boot-cache-1): the SWR refresh is CONDITIONAL.
// It used to be a plain `fetch(event.request)` + `cache.put` on every hit. For
// the terrain BC7 tiers (scene3d/assets/terrain_bc7/*.hbc7, ~79 MB per warm
// high-tier boot), which serve.py sent `no-store`, that re-transferred every
// body on every warm boot and rewrote it into Cache Storage. Even for the
// revalidating PNG/EXR sets, the HTTP cache turned its own 304 into a full 200
// for this worker, which then re-put the whole body. Now the refresh asks the
// origin with the cached copy's validator under `cache: "no-store"`. That skips
// the HTTP cache: the 304 has to reach this code, Cache Storage is the copy
// that matters, and a second HTTP-cache copy of the same bytes buys nothing. A
// 304 costs one header round trip and NO put. A changed asset still comes back
// 200 and is put as before. An entry with no validator keeps the old
// unconditional `fetch(event.request)` exactly.
//
// The validator: Last-Modified -> If-Modified-Since. If-None-Match is sent ONLY
// when the entry has an ETag and no Last-Modified. serve.py (stdlib
// SimpleHTTPRequestHandler, and its own compressed path) never emits an ETag
// and IGNORES If-Modified-Since whenever If-None-Match is present. So if
// anything in front ever added an ETag, sending both would turn every 304 into
// a 200 again. No CONTENT_CACHE bump: the keys and cached bytes are unchanged,
// and the byte-changed script is what makes clients install this worker.
// Caveat (the same one the HTTP cache's own revalidation of the JS/PNG tier
// already has): serve.py answers 304 whenever the file's mtime is not NEWER
// than the validator. So a file replaced by one with an OLDER mtime (`rsync -a`
// or `cp -p` of an older copy) keeps the cached bytes until it is touched or
// the page loads with `?nosw=1`.
function swrConditionalHeaders(cached) {
  const h = cached && cached.headers;
  if (!h || typeof h.get !== "function") return null;
  const lastModified = h.get("last-modified");
  if (lastModified) return { "If-Modified-Since": lastModified };
  const etag = h.get("etag");
  if (etag) return { "If-None-Match": etag };
  return null;
}

/** The background refresh for an SWR hit (runs under waitUntil). */
function swrRefresh(event, cache, cached) {
  const conditional = swrConditionalHeaders(cached);
  // A fresh same-origin request rather than `new Request(event.request, …)`:
  // a `no-cors` page request (a CSS image) would silently drop the
  // non-safelisted conditional headers, and a cors fetch of our own origin is
  // still a "basic" response.
  const pending = conditional
    ? fetch(event.request.url, { cache: "no-store", credentials: "same-origin", headers: conditional })
    : fetch(event.request);
  return pending
    .then((network) => {
      if (network.status === 304) {
        // Unchanged: keep the cached entry as is. Release the empty body.
        try {
          if (network.body) network.body.cancel().catch(() => {});
        } catch (_) { /* nothing to release */ }
        return undefined;
      }
      if (network.ok && network.type === "basic") {
        return cache.put(event.request, network);
      }
      return undefined;
    })
    .catch(() => {});
}

// Test hooks (harness/test_service_worker_v3.mjs vm-loads this file and
// asserts the v2/v3 predicate split; worker-scope only, inert in production).
self.__swTestHooks = {
  SW_V3, CONTENT_CACHE, isContentAddressed, isBakeVersioned, isSwrCacheable, isCacheable,
  casHashFromPath, cacheBypassRequested, swrConditionalHeaders,
};

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
  // Content-addressed: verified before persisting, and a cache-bypass request
  // skips the cached copy (the CAS verify block above).
  const cas = isContentAddressed(url);
  const bypass = cas && cacheBypassRequested(event.request);

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
      if (cache && mayServeCached && !bypass) {
        const cached = await cache.match(event.request).catch(() => null);
        if (cached) {
          if (swr) {
            // Serve stale now, refresh in the background for next load
            // (conditionally: a 304 skips the put, see swrRefresh).
            event.waitUntil(swrRefresh(event, cache, cached));
          }
          return cached;
        }
      }
      // Fetch fresh. Clone ONCE for the cache before returning the
      // original — Response bodies are locked after the first clone()
      // on a given instance, so the old (inflight-dedup + double-clone)
      // pattern threw "body already used" on the second consumer when
      // upstream chunked-encoded the response. (A content-addressed path
      // takes its two clones — hash + store — here too, from the unread
      // original, before it is returned.)
      try {
        const network = await fetch(event.request);
        if (cache && network.ok && network.type === "basic") {
          if (cas) {
            putContentAddressed(event, cache, url, network);
          } else {
            cache.put(event.request, network.clone()).catch((e) => {
              console.warn("[holtburger-sw] cache.put failed:", e);
            });
          }
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
