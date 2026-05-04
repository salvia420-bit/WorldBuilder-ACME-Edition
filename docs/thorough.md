# Thorough — production-grade asset delivery for `emit-dynamic-site`

> Use this prompt to brief the next agent picking up the
> **bandwidth / accessibility** rail of `emit-dynamic-site`. The
> current architecture forces every browser client to fetch the full
> ~605 MB asset HBA before it can render terrain or validate
> character creation. That's a hard wall for "people play this
> seriously" — a 600 kbps mobile connection takes >2 hours to pull
> the bundle, and a corporate firewall typically times out before
> then. This brief lays out the rewrite that takes initial-load to
> ≈5 MB and per-landblock cost to a few KB, suitable for cellular
> and CDN-backed delivery.
>
> Structure: **Context → Intent → Objectives → Why → Specs.** Read
> in order. Don't start coding before you've finished §Why. The
> "Decisions to NOT re-litigate" section in §Specs lists commitments
> that were made in earlier phases — do not reopen them without
> explicit ask.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to
run an Asheron's Call client in the browser, top-down view, against
a live ACE server. As of 2026-05-04 commit `33bc191` the project
sits at:

- **Phase 3** (renderer) — fully landed: 3×3 Holtburg neighbourhood
  with real retail terrain textures + stone roads + 239 placed
  objects rendered in-browser at runtime via per-poly UV-mapped
  textures (`docs/phase-3-renderer.md`).
- **Phase 4 step 1** — wasm-driven AC login → CharacterList in
  browser via `WsTransport` + `holtburger-wsbridge`.
- **Phase 4 step 2a** — `selectCharacter()` → spawn handshake →
  `kind=1 PlayerSpawned` event.
- **Phase 4 step 2a.5** — in-browser CharacterCreate via the
  `CharGen` (`0x0E000002`) DAT record + `CharacterGenBuilder`.
- **Phase 4 step 2a.6** — `sendChat()` + `LoginComplete` ack on
  `PlayerCreate` + JS Teleport-to-Holtburg button (`@telepoi`).

Everything from Phase 1 through 4 step 2a.6 ships at
`docs/phase-4-renderer.md`. Live ACE manual validation works at
`http://100.116.47.66:8765/apps/holtburger-web/index.html` over
Tailscale (UFW port 8765 + 8080 opened) with `tailnet1` /
`tailnet1` (Developer-promoted in `ace_auth.account`).

### The wall

A live ACE manual validation against a Brave Android client on
2026-05-04 surfaced the accessibility cliff: the wasm bundle's
boot path requires the full asset HBA bundle for two purposes —
the character-creation catalog (`CharGen` + `SkillTable` parsed by
`start_session`) and the renderer's per-landblock terrain /
texture / mesh fetches (`fetch_landblock_heightmaps`,
`fetch_terrain_textures`, `fetch_landblock_objects`,
`fetch_object_colours`, `fetch_model_meshes`,
`fetch_surfaces_pixels`). Each of those exports calls
`HttpResourceSource::connect(asset_url)` which fetches the entire
HBA into memory before serving any record.

The HBA bundle at `--profile full` is 605 MB. At 600 kbps:

| Fetch | Size | Time on 600 kbps |
|---|---|---|
| index.html + JS + wasm + PixiJS | ~2 MB | ~30 s |
| Login protocol round-trip | ~5 KB | <1 s |
| Spawn handshake | ~1 KB | <1 s |
| **HBA bundle (catalog + renderer share, hits HTTP cache after first)** | **~605 MB** | **~2.2 hours** |

Step 2a.6 commit `33bc191` detached the catalog fetch from
`start_session` (background spawn_local), which gets the
**login → spawn → teleport** path working in ≈30 s on the slow
phone. But the renderer still tries to pull the full HBA on its own
first invocation, so the canvas stays black on cellular — and any
character-creation form has to wait through the catalog fetch
(also still 605 MB).

### What's already in place

- `crates/holtburger-resource-http/` — wasm32-only
  `HttpResourceSource` that fetches a URL into memory and serves it
  through the `holtburger-dat::ResourceSource` trait. **Currently
  fetches the entire byte stream up-front.** The trait surface is
  sync (`get_file_by_key(&self, key) -> Result<Vec<u8>>`),
  so any switch to lazy / byte-range fetch has to either (a) keep
  the sync trait and prefetch a subset at `connect()` time, or
  (b) async-trait the trait and propagate `.await` through ~6 call
  sites in 4 crates plus a `?Send` cfg-split mirroring `Transport`.
- `crates/holtburger-dat/` — full HBA reader + every parser
  (`CellLandblock`, `LandblockInfo`, `CharGen`, `SkillTable`,
  `Palette`, `SurfaceTexture`, `Texture`, `Surface`, `GfxObj`,
  `SetupModel`, `MotionTable`, ...). All cross-compile to wasm32.
- `apps/holtburger-tools/dat-tool` — already produces multiple
  HBA profiles (`micro`, `pruned`, `full`) via `dat2hba --profile
  <name>`. Profile filtering is centralized in
  `holtburger_dat::file_type::is_essential()`.
- `apps/holtburger-web/` — current consumer. Hardcodes
  `ASSET_URL = "../../dats/assets.hba"` in `index.html`. Each
  wasm-bindgen export creates its own `HttpResourceSource` per
  call (no caching across calls — every `fetch_landblock_*`
  pulls the bundle fresh, but HTTP-layer caching deduplicates
  most of the time).

### Where this brief lands

Phase 5 in the design doc is a placeholder titled "Hardening".
This brief turns it into a concrete sub-phase **Phase 5.0 —
production-grade asset delivery**, gated only on Phase 4 step
2a.6 (which has shipped) — i.e. ready to start now. Step 2b
(position rendering / multi-entity buffer) is independent of this
work and can land in parallel; both rails converge when step 2b
needs `fetch_landblock_heightmaps` for the player's spawn cell and
benefits immediately from the smaller per-record fetch cost.

The previously-noted incremental options (byte-range single-fetch,
streaming landblock prefetch, renderer-profile bake) are all
**partial rewrites of the same code paths** this brief touches in
one pass — pursuing them sequentially before this brief would be
double work.

---

## Intent

Take the wasm bundle's first-paint cost from **605 MB → ≈5 MB** and
its per-landblock cost from **a-fresh-605MB-fetch → a few KB**, by
moving from a single-monolithic-HBA-per-page model to a
content-addressable manifest + per-record shard model with a small
precompiled bootstrap pack and an IndexedDB-backed service worker
cache.

What "done" looks like at the end of this work:

1. First page visit on a 600 kbps connection lands the user in the
   Holtburg renderer with a spawned `+PhaseyTwoSix` in **<60 s**
   total (page + bootstrap + protocol + 9 Holtburg landblocks).
2. Second page visit on the same browser boots from cache in
   **<3 s**, fetching only the manifest delta (≈5 KB if no content
   changed).
3. WorldBuilder edits a model → republishes → other clients see
   the new model on next visit, fetching only the changed
   record(s) (≈10-100 KB depending on the model's complexity).
4. The renderer pans / zooms across the world. Crossing a
   landblock boundary triggers an HTTP fetch for the new
   landblock's records (a few KB each); CDN-edge cache hit means
   <50 ms latency in most regions.
5. The wasm bundle's `HttpResourceSource` is replaced by a new
   `ManifestResourceSource` that reads a manifest, hashes record
   keys to URLs, fetches lazily, and dedups by hash through the
   service worker.
6. `dat2hba` grows a `--profile boot` flavour that produces a ≈5
   MB precompiled HBA with the records every client needs to reach
   the Selection screen + render Holtburg town centre — used as
   the page's bootstrap fetch before the manifest takes over.
7. A new `dat-shard` tool slices the canonical retail DAT bundle
   into per-record content-addressable `*.bin` files plus a
   `manifest.json`, suitable for CDN deployment.
8. Smoke checks grow from 48 → ~55 to cover the new resource
   source shape, the manifest format, and the boot pack contents.
9. `cargo test --workspace --lib` stays at ≥1106 / 0 across every
   commit boundary.
10. The auto-memory and `phase-4-renderer.md` get a "Phase 5.0"
    section pointing at this work; the design doc's §8 step
    ledger gets a Phase 5 entry.

What this work deliberately does NOT do:

- **No new gameplay features.** No movement input, no NPC
  rendering, no chat panel. Step 2b / 3 / 4 stay independent.
- **No CDN deployment.** This brief delivers the *artifact* (a
  directory of manifest + shards) and the *client code* that
  consumes it. Picking a CDN (CloudFront / Cloudflare R2 / Fastly)
  and configuring DNS / cache headers is operations work for the
  separate Phase 6 hosting brief.
- **No DAT compression rework.** Each record is already
  individually compressed inside the HBA. Shards inherit the
  per-record compression; we don't re-compress at the shard
  layer.
- **No new dat parsers.** Every DAT type the client renders is
  already parsed in `holtburger-dat`. This brief is plumbing.
- **No backwards-compat with the legacy HBA flow.** Once
  `ManifestResourceSource` lands, `HttpResourceSource` stays
  available for native callers / the smoke fixture, but the
  browser path goes manifest-only. No dual-mode.
- **No re-litigation of Phase 0-4 decisions.** WS bridge over
  patch-ACE, PixiJS over Leaflet, wasm-pack over trunk, sync
  ResourceSource over async-trait, real retail textures, etc.
  are settled. See "Decisions to NOT re-litigate" in §Specs.
- **No partial / progressive rendering of landblocks.** A
  landblock either renders fully (terrain + objects + textures)
  or shows a placeholder. Per-record streaming inside a
  landblock is not in scope.

---

## Objectives

In rough dependency order. Each objective ships its own commit; do
not batch.

1. **Audit `HttpResourceSource` + every wasm-bindgen export's
   resource-source instantiation pattern.** Read
   `crates/holtburger-resource-http/src/source.rs` end-to-end. Read
   every `fetch_*` in `apps/holtburger-web/src/lib.rs` to catalogue
   how each constructs a `HttpResourceSource` and which records it
   reads. Write the findings as a comment block at the top of the
   new `ManifestResourceSource` — this is the contract Phase 5.0
   honours.

   **Verification:** the comment captures (a) the sync trait
   surface (no `.await` in `get_file_by_key`), (b) the per-call
   construction pattern (each `fetch_*` calls
   `HttpResourceSource::connect` fresh), (c) the assumption that
   the bundle's records are accessed by `(namespace, file_id)`
   keys.

2. **Define the `manifest.json` format + hash scheme.** Add a new
   crate `crates/holtburger-manifest/` that holds the schema
   types. JSON shape:

   ```json
   {
     "version": 1,
     "generated_at": "2026-05-04T19:00:00Z",
     "source": {
       "portal_dat_iteration": 2072,
       "cell_dat_iteration": 982,
       "local_dat_iteration": 994
     },
     "boot_pack": {
       "url": "boot.hba",
       "size": 5120000,
       "sha256": "abcd…",
       "covers": ["eor/portal:0x0E000002", "eor/cell:0xA9B4FFFF", "..."]
     },
     "shards": {
       "eor/portal:0x01000827": {
         "sha256": "9f10…",
         "size": 4129,
         "url": "shards/9f10…ef.bin"
       },
       "eor/cell:0xA8B3FFFF": { ... },
       ...
     }
   }
   ```

   Hash scheme: `sha256(record_bytes)` — content-addressable. Two
   records with the same bytes share one shard URL (deduplication
   at the source). The URL is `shards/{hex}.bin` by convention but
   can be any URL the manifest writer chooses (allows CDN-prefix
   per-deployment).

   The manifest itself is content-addressable too: the
   `index.html` page links to `manifest-{hash}.json`, served with
   `Cache-Control: immutable`. A new manifest-hash means the JS
   refetches; existing shard hashes stay cached. This is how
   WorldBuilder edits propagate without invalidating the world.

   **Verification:** `holtburger-manifest` crate compiles native +
   wasm32. `serde::{Serialize,Deserialize}` derive lands. 4 unit
   tests pin parse + writeback round-trip + hash determinism +
   cross-platform JSON compatibility (one fixture from each
   platform's serde output).

3. **Add `dat-shard` tool to `holtburger-tools`.** Reads the
   canonical retail DATs (or an existing HBA) and emits:
   - `shards/{sha256-hex}.bin` — one file per unique record, raw
     compressed bytes.
   - `manifest.json` — the manifest defined in objective 2.
   - `boot.hba` — a precompiled HBA with the records
     `is_boot_essential()` returns true for. This stays as an HBA
     (not a shard collection) so the boot path is one-fetch — see
     objective 4.

   CLI shape:
   ```bash
   dat-shard \
       --eor-portal /path/to/client_portal.dat \
       --eor-cell /path/to/client_cell_1.dat \
       --eor-local /path/to/client_local_English.dat \
       --boot-landblock 0xA9B4 \
       --output dist/
   ```

   `--boot-landblock` selects the spawn-area landblock (default
   Holtburg `0xA9B4`). The boot pack includes that landblock's 9
   `eor/cell` records (one terrain + one LandblockInfo + the 7
   surrounding cells) plus their referenced models / textures /
   palettes (transitively — chase the GfxObj / SetupModel /
   Surface chain).

   **Verification:** smoke check in
   `apps/holtburger-tools/tests/sharding.rs` builds a manifest
   from the repo's `dats/assets.hba` and asserts (a) every record
   in the source HBA appears in the manifest, (b) the boot pack
   contains all records reachable from the spawn-area landblock,
   (c) duplicate records (same bytes) collapse to one shard URL.

4. **Implement `ManifestResourceSource` in
   `holtburger-resource-http`.** New struct alongside the existing
   `HttpResourceSource`. Construction:

   ```rust
   pub struct ManifestResourceSource {
       manifest: Manifest,
       boot: HbaReader<Vec<u8>>,           // pre-fetched at connect()
       shards: Rc<RefCell<HashMap<ResourceKey, Vec<u8>>>>,  // lazy cache
       base_url: String,
   }

   impl ManifestResourceSource {
       pub async fn connect(manifest_url: &str) -> Result<Self, ConnectError> {
           // Fetch manifest.json, parse, fetch boot.hba referenced from
           // it, store both in memory.
       }
   }

   impl ResourceSource for ManifestResourceSource {
       fn get_file_by_key(&self, key: ResourceKey) -> Result<Vec<u8>> {
           // 1. If `key` is in `boot`, serve from there.
           // 2. If `key` is in `shards` cache, serve from there.
           // 3. Otherwise: synchronous fail with `RecordNotPrefetched(key)`.
           //    The wasm caller is expected to call
           //    `prefetch(keys: &[ResourceKey])` first — see below.
       }

       fn prefetch(&self, keys: &[ResourceKey]) -> impl Future<Output = Result<()>> {
           // Async: walk `keys`, look up shard URLs in manifest,
           // fetch each that's not cached, await all.
       }
   }
   ```

   The trait surface stays sync — all *fetching* moves to
   `prefetch()` (a new method we add). Each `fetch_*` wasm-bindgen
   export becomes:

   ```rust
   pub async fn fetch_landblock_heightmaps(...) {
       let source = global_resource_source().await;  // see obj. 5
       source.prefetch(&landblock_keys_for(cell_ids)).await?;
       // ... existing parse + tessellate logic ...
   }
   ```

   **Verification:** new unit tests in
   `holtburger-resource-http`: round-trip via
   `ManifestResourceSource::connect` + `prefetch` + `get_file_by_key`
   serving back identical bytes to direct file access. Compatible
   with native (Node-side smoke) via the same Node `http.createServer`
   harness already in `apps/holtburger-web/smoke_test.cjs`.

5. **Hoist the resource source to a module-global Rc.** Today every
   `fetch_*` call constructs its own
   `HttpResourceSource::connect(asset_url)` — re-fetching the bundle
   each time. With manifest mode, the source carries an in-memory
   shard cache that we want to share across all `fetch_*` calls.
   Add a `thread_local! { static SOURCE: RefCell<Option<...>> }`
   (or equivalent) that the page initializes once at startup and
   every `fetch_*` borrows.

   New wasm-bindgen export:

   ```rust
   #[wasm_bindgen]
   pub async fn init_resource_source(manifest_url: String) -> Result<(), JsValue>;
   ```

   JS calls this on page load before any `fetch_*` or
   `start_session` (the catalog load also reads from the global
   source now).

   **Verification:** `apps/holtburger-web/smoke_test.cjs` calls
   `init_resource_source` once + every existing round-trip test
   continues to pass. `start_session` and the renderer share the
   one source.

6. **Update `apps/holtburger-web/index.html` to manifest mode.**
   Replace `ASSET_URL = "../../dats/assets.hba"` with
   `MANIFEST_URL = "../../dist/manifest.json"`. Call
   `init_resource_source(MANIFEST_URL)` in the page's startup
   block (same place that imports + initializes wasm). The
   `start_session(..., asset_url)` parameter is replaced with
   nothing — the global source has the catalog records.

   **Verification:** the renderer + login flow on a fresh page
   load fetches only `manifest.json` + `boot.hba` (≈5 MB total)
   plus the protocol round-trip. Pan to a non-boot landblock →
   triggers a fresh shard fetch.

7. **Add a service worker for IndexedDB-backed shard caching.**
   New file `apps/holtburger-web/service-worker.js`. Registers
   on first page load. Intercepts `fetch` events for any
   `/shards/*.bin` URL: tries IndexedDB first, falls through to
   network on miss, stashes successful responses to IndexedDB.
   The HTTP cache + the service worker cache form a 2-tier
   strategy — HTTP cache is per-origin volatile (limited size,
   evicted), IndexedDB is durable across sessions.

   The service worker only needs to be ~100 LOC. Fail-soft —
   if the browser doesn't support service workers (very old
   versions), the shard fetches just go through the network +
   HTTP cache as today.

   **Verification:** Playwright capture script reload-test:
   first visit fetches the shards via network, second visit
   fetches them via IndexedDB (verify by intercepting fetches
   in Playwright and asserting the second-visit count is 0).

8. **Add `--profile boot` to `dat2hba`.** Extends the existing
   `--profile <name>` filter set with a profile that selects:
   - The `holtburger-core`-required asset records (`SkillTable`,
     `SpellTable`, `XpTable`, `MotionKinematics`,
     `ChatPoseTable`, `SoulEmoteCatalog`).
   - `CharGen` (`0x0E000002`) — for character creation client-
     side.
   - For each `--boot-landblock` (default `0xA9B4` Holtburg):
     - Its `eor/cell:XXYYFFFF` (terrain) record.
     - Its `eor/cell:XXYYFFFE` (LandblockInfo) record.
     - The 8 surrounding landblocks' equivalents.
     - Every `Surface` / `SurfaceTexture` / `Texture` / `Palette`
       / `GfxObj` / `SetupModel` / `MotionTable` reachable from
       those landblocks' object placements (transitive walk).
   - Region (`0x13000000`) for the terrain palette mapping —
     OR a hardcoded `RETAIL_TERRAIN_SURFACE_TEXTURES: [u32; 33]`
     constant in the wasm bundle (already exists from Phase 3
     step 3.5; reuse).

   Empirically aim for ≤ 5 MB. If overshoot, the
   `--boot-landblock` selection includes too much; either prune
   the surround radius or accept the cost up to ~10 MB.

   **Verification:** `dat2hba --profile boot --boot-landblock
   0xA9B4 ... boot.hba` produces a file ≤ 10 MB. The page boots
   to playable Holtburg using only `boot.hba` (no shard
   fetches) — capture script test that intercepts and counts
   shard fetches; asserts 0 during initial Holtburg render.

9. **Smoke test additions (48 → ~55).** Per-objective:
   - Symbol-presence for `init_resource_source` +
     `ManifestResourceSource` + `prefetch`.
   - Manifest round-trip: parse a fixture manifest, look up a
     boot record, look up a shard record (via the test http
     server), assert byte equality with the source DAT.
   - Boot-pack content: `dat2hba --profile boot` produces a file
     containing every record `is_boot_essential` returns true
     for; nothing more.
   - Service-worker hit-count: second-visit shard fetches go
     through cache (Playwright-asserted; skipped without
     Playwright).
   - Manifest-versioning: a manifest with a different
     `boot_pack.sha256` than the cached one re-fetches the boot
     pack but reuses unchanged shard hashes.

10. **Native invariant + workspace check.** `cargo test
    --workspace --lib` must remain ≥ 1106 / 0. `cargo check
    --target wasm32-unknown-unknown` clean for
    `holtburger-{dat,web,session,transport-ws,resource-http,
    content,core,manifest}`. `wasm-pack build --target
    {nodejs,web}` both green.

11. **Live-ACE manual validation.** Same recipe as Phase 4 step
    2a.6. Pre-bake a manifest + shards + boot.hba via:

    ```bash
    cd external/holtburger
    cargo run -p holtburger-tools --bin dat-shard --release -- \
        --eor-portal $HOME/ac_base_dats/client_portal.dat \
        --eor-cell $HOME/ac_base_dats/client_cell_1.dat \
        --eor-local $HOME/ac_base_dats/client_local_English.dat \
        --boot-landblock 0xA9B4 \
        --output dist/
    ```

    Serve `dist/` via the existing python http.server. Open
    `index.html` over Tailscale on a 600 kbps phone. Expect
    page to first paint in <30 s, login + spawn + Teleport in
    <60 s total. Re-load: <5 s.

    Capture screenshot at
    `docs/images/phase-5.0-thorough-manifest.png` showing:
    DevTools Network tab proving the shard fetches are <100 KB
    each, the boot.hba fetch is <10 MB, and the renderer
    fully painted.

12. **Document.** Update `docs/phase-4-renderer.md` with a
    "Phase 5.0 thorough" pointer. Create
    `docs/phase-5-thorough.md` as the as-built reference. Update
    `docs/emit-dynamic-site.md` §8 with a Phase 5 step ledger
    (Phase 5.0 ✅, future 5.1 etc. open). Bump auto-memory
    `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
    with a Phase 5.0 paragraph mirroring the Phase 4 step
    entries.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why audit `HttpResourceSource` first (objective 1)?** Because
  the existing `fetch_*` exports each construct a fresh resource
  source per call, with no cross-call sharing. A naive lift-and-
  swap to `ManifestResourceSource` would reproduce that pattern —
  paying the manifest-parse cost N times. The audit makes the
  hoist-to-global decision deliberate.

- **Why content-addressable shards (objective 2)?** Because
  immutability is the only way to land at "first visit pays;
  every subsequent visit is free." A path like
  `landblocks/0xA9B4FFFF.bin` looks reasonable, but if the model
  inside changes (WorldBuilder edit), the URL has to either
  invalidate (forcing every player to refetch) or stay stale
  (every player gets the old version). Content-addressable
  (sha256 of bytes) gets the right of both: if the record didn't
  change, the hash didn't change, and every browser + CDN cache
  hit serves immediately.

- **Why a separate `dat-shard` tool (objective 3) rather than
  extending `dat2hba`?** Because the artifact shape is
  fundamentally different. `dat2hba` produces a single archive;
  `dat-shard` produces a directory of N files plus a manifest.
  Conflating them in one CLI invites a "what mode am I in"
  flag soup. The shared parsing / record-iteration code lives in
  `holtburger-dat` already; both tools are thin CLIs on top.

- **Why keep the `ResourceSource` trait sync (objective 4)?**
  Because async-trait over wasm32 needs a `?Send` cfg-split mirror
  (the same one we did for `Transport` in Phase 2 §8 step 2),
  which propagates `.await` through 6+ call sites and 4 crates.
  The pre-fetch-then-serve-sync pattern lets us keep the existing
  parsers (which take `&dyn ResourceSource`) untouched. The
  `prefetch()` method is the new async surface, called explicitly
  from `fetch_*` exports — narrow blast radius.

- **Why thread-local resource source (objective 5)?** Because
  `wasm_bindgen_futures::spawn_local`-spawned tasks (the recv loop,
  the catalog fetch, future tasks) need to access the cached
  shards too. Passing the source around as a parameter ties every
  callsite to a refactor; thread-local is module-scoped and
  zero-overhead on wasm32 (single-threaded).

- **Why update `index.html` last (objective 6)?** Because the
  manifest format + sharder + resource source need to be
  validated independently first. Wiring the page to use them
  before the bottom layers are stable means every page reload
  re-tests everything. Bottom-up keeps the iteration cycle
  short.

- **Why a service worker (objective 7)?** Because the HTTP
  browser cache is volatile — Chrome caps total cache at ~50%
  of free disk and evicts on pressure. IndexedDB has higher
  quotas (typically 60% of total disk on Chrome) and is more
  resistant to eviction. A service worker can also serve
  cached content even when offline, which matters for the
  "playing on a flaky connection" use case.

- **Why a `--profile boot` (objective 8)?** Because the manifest
  alone doesn't solve the cold-start latency: even at 5 KB per
  shard, fetching 50 records sequentially over a 200 ms RTT is
  10 seconds. The boot pack collapses 50 fetches into 1, getting
  the page to playable in a single round-trip. Once the user is
  in-world, subsequent landblocks fetch in parallel and the
  per-record latency is invisible.

- **Why expand smoke checks (objective 9)?** Same reason as
  every previous step — the smoke gate has caught real bugs at
  every commit boundary. Adding manifest + shard + service-worker
  symbol-presence and round-trip checks keeps the new architecture
  observable from `node smoke_test.cjs` without needing live
  ACE.

- **Why preserve the native invariant?** Same as before — the
  1106-test gate has caught real bugs at every prior step. Keep
  it green at every commit boundary. This work adds the
  `holtburger-manifest` crate and grows test coverage there;
  expect 1106 → ~1115 across the work.

- **Why is now the right time?** Because Phase 4 step 2a.6
  closed the wasm-driven AC interaction loop. Step 2b
  (position rendering) needs the renderer to actually work for
  end-users; without bandwidth fixes, only desktop-on-LAN works.
  Step 3 (movement input) is gated on step 2b, which is gated
  on this. Closing this rail now unblocks the gameplay loop
  for low-bandwidth users — which is who the project's stated
  audience is.

---

## Specs

### Read these files first (in order)

1. [`docs/emit-dynamic-site.md`](emit-dynamic-site.md) — the
   long-lived design intent. §3.1 + §6 + §7.5 + §8 are the load-
   bearing parts for this work. §7.2 (DAT delivery sharding
   format) is the open question this brief closes.
2. [`docs/phase-4-renderer.md`](phase-4-renderer.md) — the as-built
   reference for steps 1, 2a, 2a.5, 2a.6. The "Phase 4 step 2a.5"
   section's "byte-range HBA fetch optimization" follow-up is
   what this brief operationalizes.
3. [`docs/phase-3-renderer.md`](phase-3-renderer.md) — every
   `fetch_*` wasm export documented, with the records each
   reads. Step 6 (live runtime per-model rendering) is the
   biggest per-record fetcher; its needs drive the boot pack
   contents.
4. [`docs/phase-2-wasm-spike.md`](phase-2-wasm-spike.md) — the
   `HttpResourceSource` design discussion (option a vs option b
   from §8 step 4) is the precedent for the sync-trait + async-
   prefetch shape proposed here.
5. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches the
   current state.
6. [`crates/holtburger-resource-http/src/source.rs`](../external/holtburger/crates/holtburger-resource-http/src/source.rs)
   — current `HttpResourceSource`. Mirror its shape for
   `ManifestResourceSource`.
7. [`crates/holtburger-dat/src/file_type/mod.rs`](../external/holtburger/crates/holtburger-dat/src/file_type/mod.rs)
   — `is_essential()` filter is the model for `is_boot_essential()`.
8. [`apps/holtburger-tools/src/bin/dat2hba.rs`](../external/holtburger/apps/holtburger-tools/src/bin/dat2hba.rs)
   — clap-driven shape to mirror in `dat-shard`.
9. [`apps/holtburger-web/src/lib.rs`](../external/holtburger/apps/holtburger-web/src/lib.rs)
   — every `fetch_*` and `start_session` reads from a fresh
   `HttpResourceSource::connect`. All become global-source-
   borrowing in objective 5.
10. [`apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
    — current `ASSET_URL` const + every place it's threaded into
    `start_session(...)`, `fetch_landblock_heightmaps(...)`, etc.

### Sketch — `Manifest` shape

```rust
// crates/holtburger-manifest/src/lib.rs

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Manifest {
    pub version: u32,
    pub generated_at: String, // ISO 8601
    pub source: SourceMeta,
    pub boot_pack: BootPack,
    pub shards: BTreeMap<ResourceKey, ShardEntry>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SourceMeta {
    pub portal_dat_iteration: u32,
    pub cell_dat_iteration: u32,
    pub local_dat_iteration: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BootPack {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub covers: Vec<ResourceKey>, // for prefetch dedupe
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShardEntry {
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

// `ResourceKey` is `holtburger_dat::ResourceKey` (already
// serializable via serde-derive-on-its-fields).
```

### Sketch — `ManifestResourceSource` shape

```rust
// crates/holtburger-resource-http/src/manifest_source.rs

#[cfg(target_arch = "wasm32")]
pub struct ManifestResourceSource {
    manifest: Manifest,
    boot: HbaReader<Vec<u8>>,
    shards: std::rc::Rc<std::cell::RefCell<HashMap<ResourceKey, Vec<u8>>>>,
    base_url: String,
}

#[cfg(target_arch = "wasm32")]
impl ManifestResourceSource {
    pub async fn connect(manifest_url: &str) -> Result<Self, ConnectError> {
        let manifest_bytes = http_fetch(manifest_url).await?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;

        let base_url = url_dirname(manifest_url);
        let boot_url = join_url(&base_url, &manifest.boot_pack.url);
        let boot_bytes = http_fetch(&boot_url).await?;
        // Verify hash.
        let boot = HbaReader::<Vec<u8>>::from_bytes(boot_bytes)?;

        Ok(Self {
            manifest,
            boot,
            shards: Rc::new(RefCell::new(HashMap::new())),
            base_url,
        })
    }

    pub async fn prefetch(&self, keys: &[ResourceKey]) -> Result<()> {
        let to_fetch: Vec<_> = keys.iter()
            .filter(|k| !self.boot.contains_key(*k))
            .filter(|k| !self.shards.borrow().contains_key(*k))
            .filter_map(|k| self.manifest.shards.get(k).map(|s| (k.clone(), s.clone())))
            .collect();

        // Fetch in parallel via futures::future::try_join_all.
        let fetches = to_fetch.iter().map(|(_, shard)| {
            let url = join_url(&self.base_url, &shard.url);
            http_fetch(&url)
        });
        let bytes_vec = futures::future::try_join_all(fetches).await?;

        let mut shards = self.shards.borrow_mut();
        for ((key, _shard), bytes) in to_fetch.into_iter().zip(bytes_vec) {
            // Verify hash.
            shards.insert(key, bytes);
        }
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
impl ResourceSource for ManifestResourceSource {
    fn get_file_by_key(&self, key: ResourceKey) -> Result<Vec<u8>> {
        if let Ok(b) = self.boot.get_file_by_key(key.clone()) {
            return Ok(b);
        }
        if let Some(b) = self.shards.borrow().get(&key) {
            return Ok(b.clone());
        }
        Err(anyhow!("record not prefetched: {:?}; call prefetch() first", key))
    }
}
```

### Sketch — `service-worker.js` shape

```js
// apps/holtburger-web/service-worker.js

const SHARD_CACHE = "holtburger-shards-v1";

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.includes("/shards/")) return;

    event.respondWith((async () => {
        const cache = await caches.open(SHARD_CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const network = await fetch(event.request);
        if (network.ok) cache.put(event.request, network.clone());
        return network;
    })());
});
```

Registered in `index.html` via `navigator.serviceWorker.register(
"./service-worker.js")` at page-init time.

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/` —
      ≥ 1106 passed / 0 failed.
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,session,transport-ws,resource-http,
      web,content,core,manifest}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` — ≥ 55/55
      PASS after objective 9 lands.
- [ ] **Live-ACE manual validation.** Pre-bake `dist/` with
      `dat-shard`. Open `index.html` in Chromium / Firefox;
      verify (a) initial page load fetches manifest +
      `boot.hba` only (~5 MB total), (b) Selection screen and
      Holtburg renderer paint without additional shard fetches,
      (c) panning to a non-boot landblock triggers a small
      shard fetch (visible in DevTools Network), (d) reload
      page and confirm boot pack + shards both serve from
      service worker / IndexedDB cache (Network tab "from
      service worker" indicator).
- [ ] Save screenshot at
      `docs/images/phase-5.0-thorough-manifest.png` showing
      DevTools Network tab + the rendered Holtburg + the
      "from service worker" annotation.

### Decisions to NOT re-litigate

These have been settled in prior phases. Do not re-open without
explicit ask from the user:

- **WASM-port over server-side per-player rendering.**
- **External WS proxy over ACE patch.**
- **PixiJS-only renderer (no Leaflet).**
- **`wasm-pack` over `trunk` for the build pipeline.**
- **WS frame protocol `[port:u16 BE][ac_packet]`.**
- **Sync `ResourceSource` (not async-trait)** — Phase 5.0
  preserves this; new `prefetch()` method is the async surface.
- **`Transport` trait cfg-split: `Send + Sync` on native, `?Send`
  on wasm32.**
- **Direct-DAT terrain rendering, not Leaflet basemap reuse.**
- **Real retail textures via Texture (0x06) parser.**
- **Sprite atlas reuse via static-site `atlas.{png,js}`** — for
  the fallback dot path. Phase 3 step 6's per-poly live render
  is the canonical sprite path going forward.
- **AGPL-3.0 license.**
- **Real `~/ac_base_dats/` dats over synthetic fixtures.**
- **CDN PixiJS via importmap, no JS bundler.**
- **`gloo-timers` over `tokio::time` on wasm32** (Phase 4 step 1
  fix).
- **`PlayerCreate` triggers InWorld + sends `LoginComplete`**
  (Phase 4 step 2a.6 fix; mirrors cli's
  `messages.rs:464`).
- **Account auto-create at level 0; manual SQL promote to
  Developer for admin commands** (step 2a.6 dev recipe).

### Decisions still legitimately open after Phase 5.0

- **CDN choice.** Phase 6 hosting brief — CloudFront vs
  Cloudflare R2 vs Fastly vs self-hosted nginx. Affects only
  ops, not code.
- **Manifest signing.** For untrusted CDNs, sign the manifest
  with a server-held key + verify in the wasm bundle. Out of
  scope here; assumes operator-controlled CDN.
- **Service worker scope.** Currently scopes to the page's
  origin. For multi-project deploys (different worlds at
  different paths), a per-world service worker scope would
  let cache eviction land per-world.
- **Manifest delta updates.** A new manifest = full re-fetch
  of the manifest JSON (~5 MB if there are many shards).
  Patch / append-only delta encoding could shrink this.
  Worth considering once N players hit it.
- **Authentication on shards.** For paid / private worlds,
  shard URLs would need session-bound signed URLs. Same as
  manifest signing — out of Phase 5.0 scope.
- **WebRTC data channel for live game state.** Currently the
  WS transport carries everything. Splitting live (movement,
  chat) over WebRTC + static (assets) over HTTP-cached shards
  is a Phase 7 optimization for ultra-low-latency play.

### Commit conventions (match prior phases)

- `feat(emit-dynamic-site): <subject>` for the
  `holtburger-manifest` crate, the `ManifestResourceSource`,
  the `init_resource_source` export, the service worker, the
  `--profile boot` extension.
- `feat(emit-dynamic-site): <subject>` for the `dat-shard`
  binary.
- `test(emit-dynamic-site): <subject>` for smoke-test
  additions in objective 9.
- `docs(emit-dynamic-site): <subject>` for renderer-doc /
  spike-doc updates and the new screenshot.
- Commit body: section-headed paragraphs explaining **what** +
  **why**, with verification stats (test counts, smoke-check
  counts). See `33bc191`, `3e7c231`, `00d14b9` for format
  examples.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 5.0 thorough — manifest + shards + boot
  pack landed**" paragraph in the same style as the existing
  step-2a.6 entry, and bump the `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source `~/.cargo/env`
  if needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- Real browser (Chrome / Firefox) for manual validation, or
  `npx playwright install chromium` for scripted screenshots.
- `~/ac_base_dats/` — canonical retail DAT files
  (`client_portal.dat`, `client_cell_1.dat`,
  `client_local_English.dat`).
- MariaDB 11.8 + ACE provisioned per `docs/ace-local-setup.md`
  for the live-validation step.
- `~/ace-server/` — full upstream ACE clone.

### What done looks like

- A 600 kbps phone connection lands at the Holtburg renderer
  with a spawned character in **<60 s** total.
- Reload of the same page on the same browser boots in **<3 s**.
- Crossing a landblock boundary in the renderer adds **<2 s**
  to first paint of the new cell on cold cache, **<100 ms**
  on warm cache.
- WorldBuilder edits a model, republishes the manifest +
  shards. Other clients on the same world see the new model
  on their next visit, fetching only the changed shard
  (≈ 100 KB).
- `node smoke_test.cjs` reports ≥ 55/55 PASS.
- All ≥ 1106 workspace lib tests still pass.
- New screenshot at
  `docs/images/phase-5.0-thorough-manifest.png` is committed
  showing DevTools proving the shard architecture.
- The next session can either (a) tackle Phase 4 step 2b
  (`UpdatePosition` → PIXI entity buffer — built on top of
  the new resource source), (b) ship Phase 4 step 4 (DOM chat
  panel) in parallel, (c) deploy to a real CDN as Phase 6.
  Phase 5.0 closes one specific accessibility gap without
  blocking any of these.
