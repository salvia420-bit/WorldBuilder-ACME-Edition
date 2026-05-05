# Manifest scale fix — production-grade index for `emit-dynamic-site` Phase 5.2

> Use this prompt to brief the next agent picking up the
> **manifest scale** rail of `emit-dynamic-site`. Phase 5.0
> closed the original bandwidth cliff (605 MB single-bundle
> HBA → ≈5 MB target via manifest+shards delivery), and
> Phase 5.1 expanded the boot pack to render the spawn area
> without any shard fetches. But baking `dist/` from a real
> 605 MB `dats/assets.hba` produces a `manifest.json` of
> **203 MB** — the manifest itself is the new cliff. This
> brief lays out the rewrite that takes `manifest.json` to
> ≈2 KB and per-namespace catalog cost to a few MB
> (lazy, optional), suitable for cellular delivery.
>
> Structure: **Context → Intent → Objectives → Why → Specs.**
> Read in order. Don't start coding before you've finished
> §Why. The "Decisions to NOT re-litigate" section in §Specs
> lists commitments that were made in Phase 5.0 / 5.0b / 5.1
> — do not reopen them without explicit ask.
>
> This brief is a strict superset extension of `thorough.md`.
> Phase 5.2 changes the manifest *format* and the
> `ManifestResourceSource` *protocol*; it does not touch the
> shard storage layer (sha256-keyed content-addressable
> blobs are unchanged), the service worker, or the
> wasm-bindgen surface every `fetch_*` export depends on.

---

## Context

`emit-dynamic-site` is the `WorldBuilder-ACME-Edition` project to
run an Asheron's Call client in the browser, top-down view, against
a live ACE server. As of 2026-05-05 commit `0cd19c7` the project
sits at:

- **Phase 5.0** — content-addressable manifest + per-record shard
  delivery + IndexedDB-backed service worker
  (`docs/phase-5-thorough.md`).
- **Phase 5.0b** — every wasm-bindgen `fetch_*` export drops
  `asset_url`, routes through global `ManifestResourceSource` +
  explicit `prefetch()` (`8afb423`).
- **Phase 5.1a/b** — `holtburger_dat::walk::collect_model_dependencies`
  expands the boot pack to the transitive closure of every
  record reachable from spawn-area object placements
  (`5fb0919`). Real-world bake from `dats/assets.hba` produces
  a 1.86 MB `boot.hba` covering 635 records.

Native lib gate is **1121 / 0**. wasm32 check is clean across
all 9 workspace crates. `wasm-pack build --target {nodejs,web}`
both green. `node smoke_test.cjs` reports **56 / 56** PASS.

Live-ACE manual validation (Phase 5 obj 11) remains the only
open verification gate from the original `thorough.md` brief.

### The new wall

A real-world bake against `dats/assets.hba` (605 MB,
`--profile full`) produces:

| Artifact | Size | Records |
|---|---|---|
| `dist/manifest.json` | **203 MB** | 885,043 entries |
| `dist/boot.hba` | 1.86 MB | 635 covers (Holtburg) |
| `dist/shards/*.bin` (885k files) | ~1 GB content / ~4.5 GB on-disk | one per unique sha256 |

Per-namespace breakdown of the manifest's `shards` map (from
`jq -r '.shards | keys[]' /tmp/holtburger-dist2/manifest.json |
awk -F: '{print $1}' | sort | uniq -c`):

| Namespace | Records | Share |
|---|---|---|
| `eor/cell` | 805,348 | 90.9% |
| `eor/portal` | 79,694 | 9.0% |
| `holtburger/core` | 1 | 0.0% |

The `eor/cell` count is dominated by interior `EnvCell`
records (XXYYHHHH for HHHH ∈ envcells) — building interiors
the top-down outdoor renderer ignores. Of the 805k cells:

- ~65k are terrain (`XXYYFFFF`)
- ~65k are LandblockInfo (`XXYYFFFE`)
- ~675k are interior EnvCells (~80% of the entire manifest)

Each manifest entry costs ~230 bytes of JSON:

```json
"eor/cell:0xA9B4FFFF": {
  "sha256": "1c6042d84b9429ddef35732a3f98eca66b52cd3b39ae198d712fb0c539c429f8",
  "size": 252,
  "url": "shards/1c6042d84b9429ddef35732a3f98eca66b52cd3b39ae198d712fb0c539c429f8.bin"
}
```

885k × 230 bytes ≈ 203 MB raw JSON. At 600 kbps that's
**46 minutes** — worse than the original HBA cliff. Even at
home-WiFi-over-Tailscale speeds (~50 Mbps) the manifest fetch
takes ~30 sec and consumes 200 MB of phone data on first
visit.

The 5.0 brief explicitly anticipated this in its
"Decisions still legitimately open after Phase 5.0":

> **Manifest delta updates.** A new manifest = full re-fetch
> of the manifest JSON (~5 MB if there are many shards).
> Patch / append-only delta encoding could shrink this. Worth
> considering once N players hit it.

But the estimate was off by ~40×. Reality: 203 MB. The brief's
"~5 MB" assumed a stripped HBA (`--profile pruned` ≈ 100 MB);
the live-ACE rail uses `--profile full` (605 MB), and the
`eor/cell` envcell explosion wasn't on the radar.

### Why the obvious fixes are incomplete

Several first-pass fixes shave the size but don't reach a
sustainable target:

1. **`Content-Encoding: gzip`** at the HTTP layer. JSON
   compresses ~10×. 203 MB → ~25-30 MB. Still 6-7 minutes on
   600 kbps cellular. Not enough.
2. **Drop the `url` field** (derive from sha256 by convention).
   ~30 bytes/entry × 885k = ~25 MB savings. Manifest → 178 MB.
   Not enough.
3. **Drop the `size` field** (HTTP `Content-Length` provides
   it). ~10-15 bytes/entry. ~10 MB savings. Manifest → 168 MB.
   Not enough.
4. **Truncate sha256 to 128 bits** (still cryptographically
   meaningful for non-adversarial CDN-served content). ~32
   bytes/entry. ~28 MB savings. Manifest → 140 MB. Not enough.
5. **Prune to "renderable closure"** — only list records the
   renderer can reach via cell → object → model → texture
   walks. Empirically reduces `eor/cell` by 6× (drops 675k
   EnvCells). Total → ~33 MB raw, ~5-7 MB gzipped. Closer to
   the target but still slow on cellular.

A combination of (1) + (5) gets to 5-7 MB gzipped, just under
the brief's original "~5 MB" anticipation. But:

- (5) requires running the transitive walk over EVERY cell,
  not just the spawn area. That's ~hours of CPU per bake on
  full Dereth.
- The "renderable" definition is fragile — adding a new
  rendering feature (interior cells, sounds, animations) means
  the manifest needs to be re-baked.
- The "active set" still grows linearly with world content. A
  custom WorldBuilder world with twice the cells doubles the
  manifest. The architecture has no headroom.

### The architectural fix

The fundamental issue: a manifest that **lists every shard**
scales linearly with world content. The fix is to **NOT list
every shard** — make the manifest carry only what's
indispensable, and let the shard URL be derived from the key
by convention.

If the page can compute a shard's URL from its
`(namespace, file_id)` without consulting the manifest, the
manifest can be ≈2 KB regardless of world size. Fetch
strategy becomes:

- Try the convention URL.
- If 200 → cache + serve.
- If 404 → record doesn't exist (matches today's
  best-effort `prefetch` semantics for ocean-cell LBI).

Sha256 verification, when desired, comes from a response
header (`X-Content-SHA256`) rather than a manifest lookup.

### What's already in place

- `crates/holtburger-manifest/src/lib.rs` — v1 schema. Pure
  data + `serde_json` derive + `sha256_hex` helper. ~190 LOC.
  Compiles native + wasm32. Phase 5.0 obj 2 / `9521109`.
- `crates/holtburger-resource-http/src/manifest_source.rs` —
  `ManifestResourceSource::connect(manifest_url)` fetches +
  parses + verifies boot pack. `prefetch(&[ResourceKey<'_>])`
  walks shards via the JSON `shards` map (line 215+:
  `manifest.shards.get(&key_for_resource(*key))`). Phase 5.0
  obj 4 / `f760981`.
- `apps/holtburger-tools/src/dat_shard.rs` — bake-time
  manifest writer. `shard_bundle()` calls
  `serde_json::to_string_pretty(&manifest)` and writes
  `dist/manifest.json` directly. Phase 5.0 obj 3 / `0d81554`,
  expanded by Phase 5.1b / `5fb0919`.
- `apps/holtburger-web/src/global_source.rs` —
  `init_resource_source(manifest_url)` thread-local. Phase 5.0
  obj 5 / `5dc6551`.
- `apps/holtburger-web/src/prefetch.rs` — iterative discovery
  driver via `RecordingSource`. Phase 5.0b / `8afb423`. The
  driver is format-agnostic and survives this rewrite
  unchanged.

### Where this brief lands

Phase 5 in the design doc (`docs/emit-dynamic-site.md` §8)
ships its first sub-step at Phase 5.0. This brief turns its
follow-on into a concrete sub-phase **Phase 5.2 — manifest
scale fix**, gated only on Phase 5.0b/5.1 (which have shipped).

Phase 5.2 is parallel-safe with the open obj 11 phone test:
the test can run against the existing v1 dist/ (just slowly)
or against a freshly-baked v2 dist/ (fast). Both paths land
the player at Holtburg.

The previously-noted incremental options (gzip,
truncate-sha256, drop-url-and-size, renderable-prune) are all
**partial rewrites of the same code paths** this brief
touches in one pass — pursuing them sequentially before this
brief would be double work.

---

## Intent

Take the `emit-dynamic-site` browser bundle's manifest fetch
cost from **203 MB → ≈2 KB** and per-namespace catalog cost
(when needed) from **n/a → a few MB lazy + gzipped**, by
moving from a single-monolithic-`shards`-map model to a
**top-level-pointer + convention-URL + optional-binary-
catalog** model.

What "done" looks like at the end of this work:

1. **First page visit** on a 600 kbps connection lands the
   user at Holtburg with a spawned `+PhaseyTwoSix` in
   **<60 s** total (page + 2 KB top-level manifest +
   1.86 MB boot pack + protocol + 9 Holtburg landblocks).
   Same target as Phase 5.0 obj 11; now achievable.
2. **Second page visit** on the same browser boots from
   cache in **<3 s**, fetching only the manifest delta
   (≈2 KB if no content changed; just a freshness check).
3. **Crossing a landblock boundary** in the renderer
   triggers an HTTP fetch for the new landblock's records
   via convention URLs (each shard ≤100 KB); CDN-edge cache
   hit means <50 ms latency.
4. **Walking a model's surface chain** triggers a small
   batch of shard fetches via the existing `prefetch()`
   driver; missing records (e.g. ocean LBIs) are silent
   skips, matching today's best-effort semantics.
5. The wasm bundle's `ManifestResourceSource` handles
   `version: 2` manifests. v1 manifests stay supported for
   one release cycle to cover any in-flight CDN deployment.
6. `dat-shard` defaults to v2 emission. A v1 fallback flag
   (`--manifest-version=1`) stays available for one release
   cycle. dist/ disk usage drops materially (no per-shard
   `url` strings).
7. A new compact binary format for per-namespace catalogs
   (`manifest/<namespace>.bin`), each ~few MB gzipped.
   Catalogs are **optional** — the page works without them
   via convention URLs; catalogs exist for callers that
   want batch-prefetch with sha256 verification.
8. Smoke checks grow from 56 → ~62 to cover the new
   manifest version, the convention URL path, and the
   binary catalog format.
9. `cargo test --workspace --lib` stays at ≥1121 / 0 across
   every commit boundary.
10. The auto-memory and `phase-5-thorough.md` get a
    "Phase 5.2" section pointing at this work; the design
    doc's §8 step ledger gets a Phase 5.2 entry.

What this work deliberately does NOT do:

- **No new gameplay features.** No movement input, no NPC
  rendering, no chat panel. Step 2b / 3 / 4 stay independent.
- **No CDN deployment.** Phase 6's hosting brief (still
  open) picks the CDN, sets DNS, configures cache headers
  including `X-Content-SHA256` if integrity verification is
  enabled. This brief delivers the *artifact* (a
  directory of v2 manifest + per-namespace catalogs +
  shards) and the *client code* that consumes it.
- **No shard storage rework.** Shards stay
  sha256-content-addressable, one file per unique content.
  Phase 5.2 changes only the index + URL convention.
- **No new dat parsers.** Same as Phase 5.0: the parsers
  exist; this brief is plumbing.
- **No backwards-compat with v1 forever.** v1 stays one
  release cycle; deprecate via a warning log, then remove.
- **No re-litigation of Phase 0–5.1 decisions.** WS bridge
  over patch-ACE, PixiJS, wasm-pack, sync `ResourceSource`,
  `prefetch()` async surface, `RecordingSource` iterative
  discovery, transitive boot walk via
  `holtburger_dat::walk::collect_model_dependencies`, etc.
  are settled. See "Decisions to NOT re-litigate" in §Specs.
- **No boot-pack adaptive sizing.** Phase 5.1b's
  transitive walk is "expand to everything reachable from
  spawn placements." Adapting the boot pack to dense areas
  (e.g. Mountain Sea) so first-paint stays under
  bandwidth target is a Phase 5.3 follow-up. This brief
  closes the manifest scale; the boot-pack scaling problem
  surfaces second.
- **No real-CDN content-integrity headers.** Sha256
  verification on convention-URL fetches is gated behind a
  config flag and defaulted off; Phase 6 enables it during
  CDN config.

---

## Objectives

In rough dependency order. Each objective ships its own
commit; do not batch.

1. **Audit the v1 wire shape + identify v2 invariants.**
   Read `crates/holtburger-manifest/src/lib.rs` end-to-end
   (~190 LOC) and `crates/holtburger-resource-http/src/manifest_source.rs`
   (entire file, ~330 LOC). Write a comment block at the
   top of a new `crates/holtburger-manifest/src/v2.rs` stub
   capturing (a) what fields v1 has, (b) which are
   load-bearing across the v1 callers (boot_pack metadata,
   source provenance, the shards map's
   `(namespace, file_id) → (sha256, url)` mapping), (c) which
   v2 simplifies away (the verbose per-shard `url`/`size`
   fields). The audit is the contract for objectives 2-4.

   **Verification:** the comment captures (a)/(b)/(c)
   correctly per the file:line citations in §Specs. Stub
   compiles native + wasm32. No new tests.

2. **Define `holtburger_manifest::v2::Manifest` + helpers.**
   Add to the existing `holtburger-manifest` crate a v2
   module with:

   ```rust
   pub const MANIFEST_V2_VERSION: u32 = 2;

   #[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
   pub struct ManifestV2 {
       pub version: u32, // == MANIFEST_V2_VERSION
       pub generated_at: String,
       pub source: SourceMeta,
       pub boot_pack: BootPack,
       pub catalog_version: u32,
       pub namespaces: Vec<String>,
       pub shard_url_template: String, // default: "shards/{sha256}.bin"
       pub catalog_url_template: Option<String>, // default: "manifest/{namespace_slug}.bin"
   }

   pub fn namespace_slug(namespace: &str) -> String {
       // "eor/portal" -> "eor-portal"; replace '/' with '-'.
       namespace.replace('/', "-")
   }

   pub fn render_shard_url(template: &str, sha256_hex: &str) -> String {
       template.replace("{sha256}", sha256_hex)
   }

   pub fn render_catalog_url(template: &str, namespace: &str) -> String {
       template.replace("{namespace_slug}", &namespace_slug(namespace))
   }
   ```

   **Verification:** 4 unit tests in
   `crates/holtburger-manifest/src/v2.rs::tests`:
   (a) parse a canonical v2 fixture, (b) round-trip
   write/parse, (c) `namespace_slug` round-trip
   (`"eor/portal"` ↔ `"eor-portal"`),
   (d) URL template rendering. Total native lib gate
   1121 → 1125.

3. **Define the `NamespaceCatalog` binary format + codec.**
   New file `crates/holtburger-manifest/src/catalog.rs`.
   Compact binary format (full layout in §Specs "Format
   spec — per-namespace catalog binary"):

   - 16-byte header: magic `b"HBNS"` + version `u8` + flags
     `u8` + reserved + entry count `u32` + reserved.
   - Entry stream: each entry is `[varint file_id_delta]
     [16-byte truncated sha256][varint size]`.
   - 8-byte footer: 4-byte CRC32 over header + entries +
     trailing magic `b"SNBH"`.

   Public API:

   ```rust
   pub struct NamespaceCatalog {
       pub namespace: String,
       pub entries: Vec<CatalogEntry>,
   }
   pub struct CatalogEntry {
       pub file_id: u32,
       pub sha256_truncated: [u8; 16],
       pub size: u64,
   }
   impl NamespaceCatalog {
       pub fn write_to(&self, out: &mut impl io::Write) -> io::Result<()>;
       pub fn read_from(bytes: &[u8]) -> Result<Self, CatalogError>;
       pub fn lookup(&self, file_id: u32) -> Option<&CatalogEntry>;
   }
   ```

   Internally entries are stored sorted by file_id (delta
   encoding requires it). `lookup` does binary search.

   **Verification:** 5 unit tests:
   (a) write/read round-trip on a synthetic 100-entry
   catalog, (b) lookup hits + misses, (c) bad-magic detection
   on read, (d) CRC mismatch detection, (e) varint
   round-trip across the 1/2/4-byte width boundaries.
   `holtburger-manifest` lib gate 1125 → 1130.

4. **Implement v2 in `ManifestResourceSource`.** Replace
   `manifest_source.rs::connect`'s JSON-parse-then-fetch-
   boot path with version-detection. v1 path stays in
   `manifest_source_v1.rs` as a deprecated module
   (`#[deprecated(since = "0.1.1", note = "use v2")]`).

   New v2 struct shape:

   ```rust
   pub struct ManifestResourceSource {
       manifest: ManifestV2,
       boot: HbaReader<Vec<u8>>,
       catalogs: Arc<Mutex<HashMap<String, NamespaceCatalog>>>,
       shards: Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>,
       base_url: String,
   }
   ```

   `connect(manifest_url)` parses the JSON, sniffs the
   `version` field. If 1, log a deprecation warning and use
   the v1 path. If 2, parse as `ManifestV2`. Catalogs map
   starts empty.

   `prefetch(&[ResourceKey<'_>])` — for each key:
   1. If served by boot pack, skip.
   2. If in shard cache, skip.
   3. If the key's namespace catalog isn't loaded *and* the
      manifest declares a `catalog_url_template`, lazily
      fetch + parse the catalog. Cache it.
   4. Look up the entry. If catalog is present and entry is
      missing, the record doesn't exist — silent skip.
   5. If no catalog (or `catalog_url_template` is absent),
      derive the shard URL from the convention template
      using `(namespace, file_id)` directly: e.g.
      `shards/eor-portal/0xXXXXXXXX.bin`. (See `shard_url_template`
      semantics in objective 2 — the template supports
      `{sha256}` for content-addressable lookup AND
      `{namespace_slug}` + `{file_id_hex}` for convention
      lookup; choose at bake time.)
   6. Fetch the shard via `try_join_all`. Verify sha256 if
      we have a catalog entry; otherwise fetch as-is.
   7. Insert into the shard cache.

   New error variants on `PrefetchError`:
   - `CatalogFetch { namespace: String, source: HttpError }`
   - `CatalogParse { namespace: String, message: String }`

   **Verification:** new unit tests in
   `holtburger-resource-http`: `connect()` against a v2
   manifest fixture; `prefetch()` against a v2 manifest
   that lists a catalog; `prefetch()` against a v2 manifest
   that uses convention URLs only. The Node smoke harness
   (objective 8) drives the end-to-end version. wasm32
   check clean for `holtburger-resource-http`.

5. **Implement v2 emission in `dat-shard`.** Update
   `apps/holtburger-tools/src/dat_shard.rs::shard_bundle`
   to default to v2 emission. Add `--manifest-version=1|2`
   CLI flag. v2 emission writes:

   - `dist/manifest.json` — `ManifestV2` JSON, ≈2 KB.
     Lists boot pack + namespaces + URL templates +
     catalog_version (default 1; bumps on republish).
   - `dist/manifest/eor-portal.bin`,
     `dist/manifest/eor-cell.bin`, etc. — one binary
     catalog per namespace. Sorted by file_id, delta-
     encoded, truncated-sha256, gzipped via the bake-time
     wrapper. (HTTP `Content-Encoding: gzip` is the
     deployment-time concern; bake-time pre-gzip is
     optional. Default: emit raw `.bin`; the dev http.server
     doesn't gzip, but a CDN will.)
   - `dist/shards/{first-2-sha256-hex}/{rest-sha256-hex}.bin`
     — content-addressable, 2-level dir to avoid
     1-dir-with-885k-files. (v1 used `shards/{full-sha256}.bin`;
     v2 introduces the prefix split.)

   The convention URL — for callers using
   `shard_url_template = "shards/{namespace_slug}/{file_id_hex}.bin"`
   instead of `"shards/{sha256}.bin"` — is implemented via
   bake-time symlinks: `dist/shards/eor-portal/0x01000827.bin`
   symlinks to the canonical sha256-keyed file. Both URLs
   serve the same bytes. Page chooses which to use via
   `shard_url_template`.

   **Verification:** integration test in
   `apps/holtburger-tools/tests/sharding.rs` builds a v2
   manifest from the synthetic fixture, asserts (a) top-level
   manifest is <5 KB, (b) per-namespace catalogs exist for
   every namespace in the bundle, (c) catalog round-trips
   via `NamespaceCatalog::read_from`, (d) convention URL
   symlinks point at sha256-keyed shards, (e) every
   `(namespace, file_id)` from the source HBA is reachable
   via the v2 manifest.

6. **Update `apps/holtburger-web/index.html` for v2.**
   No code change strictly necessary — `init_resource_source`
   already takes a manifest URL agnostic to version; v2
   detection happens server-side in `connect()`. Ensure
   the page's "manifest-mode init failed" diagnostic
   includes a hint to bake with v2.

   **Verification:** load `index.html` in Chromium against
   a v2-baked dist/, confirm Holtburg renders. No regression
   on smoke-test count.

7. **Update the service worker's cache scope.** The v2
   layout introduces `manifest/<namespace>.bin` files in
   addition to `/shards/*.bin`. Update
   `apps/holtburger-web/service-worker.js` to also intercept
   `/manifest/*.bin` (per-namespace catalogs) for the same
   IndexedDB durability guarantee. Scope: any URL containing
   `/shards/` OR `/manifest/<namespace>.bin`.

   **Verification:** Playwright capture script (still
   skipped in Node smoke). Manual: open page, reload, check
   DevTools Application → Cache Storage shows manifest
   catalogs alongside shards. Service-worker LOC stays ≤120
   after the change.

8. **Smoke test additions (56 → ~62).** Per-objective:
   - Symbol-presence: `MANIFEST_V2_VERSION` is exported.
   - Round-trip: parse a v2 fixture, look up a record,
     assert byte equality with the source.
   - v1 → v2 migration smoke: connect against a v1
     fixture, assert the deprecation log fires, assert
     records still resolve.
   - Catalog lazy-fetch: prefetch a record in
     `eor/portal`, assert exactly one catalog HTTP
     request fired.
   - Convention URL fallback: bake a manifest with
     `catalog_url_template = null`; assert prefetch still
     resolves via convention URLs.
   - Top-level manifest size invariant: assert
     `manifest.json` is <5 KB after bake.

9. **Native invariant + workspace check.** `cargo test
   --workspace --lib` ≥ 1130 / 0. `cargo check
   --target wasm32-unknown-unknown` clean for
   `holtburger-{dat,session,transport-ws,resource-http,
   web,content,core,manifest}`. `wasm-pack build
   --target {nodejs,web}` both green. `node smoke_test.cjs`
   ≥ 62 / 62 PASS.

10. **Live-ACE manual validation.** Same recipe as Phase 5
    obj 11 (now achievable). Pre-bake v2 dist/ via:

    ```bash
    cd external/holtburger
    cargo run -p holtburger-tools --bin dat-shard --release -- \
        --eor-portal $HOME/ac_base_dats/client_portal.dat \
        --eor-cell $HOME/ac_base_dats/client_cell_1.dat \
        --eor-local $HOME/ac_base_dats/client_local_English.dat \
        --boot-landblock 0xA9B4 \
        --output dist/
    ```

    Serve `dist/` via `python -m http.server` from
    `external/holtburger/`. Open `index.html` over
    Tailscale on a 600 kbps phone. Expect page to first
    paint in <30 s, login + spawn + Teleport in
    <60 s total. Re-load: <5 s.

    Capture screenshot at
    `docs/images/phase-5.2-manifest-fix.png` showing:
    DevTools Network tab proving the manifest fetch is
    <5 KB, the boot.hba fetch is <2 MB, and the renderer
    fully painted.

11. **Document.** Update `docs/phase-5-thorough.md` with a
    "Phase 5.2 manifest fix" pointer. Create
    `docs/phase-5.2-manifest-fix.md` as the as-built
    reference. Update `docs/emit-dynamic-site.md` §8 with
    a Phase 5.2 step ledger entry. Bump auto-memory
    `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
    with a Phase 5.2 paragraph mirroring the Phase 5.0
    step entries. Bump the `MEMORY.md` index headline.

---

## Why

Each objective answers a "why now" — not just "why eventually."

- **Why audit v1 first (objective 1)?** Same reason the
  Phase 5.0 obj-1 audit was useful: pin the contract before
  building against it. v1's `shards: BTreeMap<String,
  ShardEntry>` is the load-bearing datum every consumer
  reads from. v2's design hinges on what we can drop
  (per-shard verbose URL/size) and what we must preserve
  (boot pack metadata, source provenance, the
  `(namespace, file_id) → bytes` lookup contract). Writing
  the audit pins the migration's blast radius.

- **Why a separate v2 module rather than an in-place
  rewrite?** Because the v1 → v2 migration is not a
  no-downtime deploy — there's an in-flight CDN window
  where some clients are running v1 and some v2. A v1
  deprecation cycle (one release) gives operators time to
  bake v2 dist/, deploy, and let v1 clients drain. Same
  pattern as ACE's protocol versioning. After one cycle,
  v1 module + the `--manifest-version=1` flag are removed
  in a follow-up commit.

- **Why a binary catalog format for namespaces (objective 3)?**
  Because the savings are dramatic and the cost is small.
  Per-entry overhead drops from ~230 bytes (verbose JSON)
  to ~19 bytes (delta-encoded, truncated sha256, varint
  size). For `eor/cell`'s 805k entries: 19 MB raw,
  ~6-8 MB gzipped. For `eor/portal`'s 80k: 1.8 MB raw,
  <1 MB gzipped. **The catalogs are optional** — page
  works without them via convention URLs — so callers
  who don't want batch-prefetch with sha256 verification
  pay nothing.

- **Why convention URLs (objective 5) rather than only
  catalogs?** Because catalogs still scale with world
  content. A custom WorldBuilder world with 10× the
  cells produces 10× larger catalogs. Convention URLs are
  O(1) per record fetch — no central index. The page just
  asks the CDN "do you have this?" and gets a yes-with-
  bytes or no. The catalog optimization layers on top:
  when present, batch sha256 verification + dedupe +
  metadata. When absent, the page still works.

- **Why truncated 128-bit sha256 in the catalog (objective
  3)?** Cryptographic full-hash sha256 is 256 bits =
  collision-resistant to 2^128. Truncating to 128 bits
  reduces collision resistance to 2^64 — about 18
  quintillion. For non-adversarial CDN content (we trust
  our own bake), 2^64 is overkill. The shard URL itself
  uses the full hash (in the convention's
  `shard_url_template = "shards/{sha256}.bin"` mode); the
  catalog's truncated hash is only used for batch
  verification post-fetch. If a future deployment needs
  full-hash verification, the catalog format has 1 byte
  of `flags` to opt into it (set bit 0 → full 32-byte hash
  per entry, doubling catalog size).

- **Why preserve sha256-keyed shard storage (objective 5)?**
  Because content-addressable storage is the foundation of
  Phase 5.0's "first visit pays; subsequent visits reuse
  cache" guarantee. WorldBuilder edits change the bytes →
  change the hash → change the URL → CDN cache miss →
  fetch new bytes. Replacing this with mutable URLs
  (e.g. `shards/eor-portal/0x01000827.bin` always points
  at "the current version") would require cache-busting
  via query strings or version prefixes, defeating the
  CDN immutability win. Phase 5.2 adds a *parallel*
  convention-URL surface (via symlinks) so callers can
  pick; the canonical storage stays content-addressable.

- **Why 2-level shard directory split (objective 5)?**
  Because 885k files in one directory is bad for every
  filesystem. ext4 limits = 65k entries before
  `htree`-indexed lookups become inefficient. Splitting
  by 2-hex prefix gives 256 first-level dirs with ~3.5k
  files each — well within healthy bounds. The CDN doesn't
  care, but bake-time disk operations (rsync, tar) and
  developer ls-ing the shards dir do.

- **Why update the service worker (objective 7)?** Because
  per-namespace catalogs are also durable assets — they're
  immutable per `catalog_version`, and reloads should serve
  them from the SW cache. Adding `/manifest/*.bin` to the
  SW interception list mirrors what the existing
  `/shards/*.bin` interception does. Keep the LOC budget
  ≤120 for the SW; if the change pushes past that,
  refactor instead of bloating.

- **Why keep gzip out of the bake-time emission (objective
  5)?** Because the CDN handles gzip at the HTTP layer.
  Bake-time pre-gzip would either lock us into one
  compression algorithm (gzip vs Brotli vs zstd, each with
  different CPU/size trade-offs the CDN's hosting choice
  drives) or require per-CDN bake variants. The dev
  http.server doesn't gzip but the per-namespace catalogs
  are small enough raw (~20 MB total) for local testing.

- **Why expand smoke checks (objective 8)?** Same reason as
  every previous step — the smoke gate has caught real
  bugs at every commit boundary. Adding v2-format symbol-
  presence + round-trip + convention-URL + manifest size
  invariant keeps the new architecture observable from
  `node smoke_test.cjs` without needing live ACE.

- **Why preserve the native invariant (1121+/0)?** Same as
  Phase 5.0/5.1: the gate has caught real bugs at every
  prior step. Keep it green at every commit boundary.
  This work adds ~9 unit tests (4 manifest-v2 + 5
  catalog) → 1121 → 1130 expected.

- **Why is now the right time?** Because Phase 5.0/5.0b/5.1
  closed the bandwidth-cliff loop except for the
  manifest itself. The deferred obj 11 phone test is
  blocked on manifest fix (without it, the page over
  600 kbps cellular still chokes on the 203 MB index).
  Closing this rail unblocks the gameplay loop's
  bandwidth-on-cellular goal — which is who the project's
  stated audience is.

---

## Specs

### Read these files first (in order)

1. [`docs/thorough.md`](thorough.md) — the long-lived
   Phase 5.0 brief. §Context establishes the bandwidth-cliff
   framing this brief inherits. §Specs "Decisions still
   legitimately open after Phase 5.0" calls out manifest
   delta updates as the open follow-on this brief
   addresses.
2. [`docs/phase-5-thorough.md`](phase-5-thorough.md) — the
   as-built reference for Phase 5.0 obj 1-12 + 5.0b + 5.1.
3. [`docs/emit-dynamic-site.md`](emit-dynamic-site.md) §8
   step ledger — "Phase 5 — Hardening" section's Phase 5.0
   entry; this brief adds Phase 5.2 to the same ledger.
4. `~/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
   — auto-loaded into Claude's context; verify it matches
   the current state.
5. [`crates/holtburger-manifest/src/lib.rs`](../external/holtburger/crates/holtburger-manifest/src/lib.rs)
   end-to-end (~190 LOC). v1 schema + sha256 helper.
   Particularly:
   - `:53-MANIFEST_VERSION` — version constant (currently 1).
   - `:67-Manifest` — top-level struct.
   - `:88-BootPack` — boot pack metadata; v2 reuses verbatim.
   - `:103-ShardEntry` — the verbose per-shard entry that
     v2 eliminates from the top-level manifest.
   - `:165-sha256_hex` — utility, kept by v2.
6. [`crates/holtburger-resource-http/src/manifest_source.rs`](../external/holtburger/crates/holtburger-resource-http/src/manifest_source.rs)
   end-to-end (~330 LOC). v1 source impl. Particularly:
   - `:159-ManifestResourceSource` — the struct v2 reshapes.
   - `:172-connect` — JSON parse + boot pack fetch + verify.
     v2 detects `version` here.
   - `:215-prefetch` — the iterative-fetch path. v2 adds
     namespace-catalog lazy-fetch here.
   - `:280-RecordingSource` — Phase 5.0b iterative-discovery
     wrapper, format-agnostic, survives v2.
7. [`apps/holtburger-tools/src/dat_shard.rs`](../external/holtburger/apps/holtburger-tools/src/dat_shard.rs)
   end-to-end (~470 LOC). bake-time logic. Particularly:
   - `:shard_bundle` — top-level orchestration. v2
     reshapes its manifest emission.
   - `:write_shards` — content-addressable shard writer.
     v2 adds 2-level prefix split + convention-URL
     symlinks.
   - `:write_boot_pack` — Phase 5.1b transitive walk.
     Unchanged in v2.
8. [`apps/holtburger-tools/tests/sharding.rs`](../external/holtburger/apps/holtburger-tools/tests/sharding.rs)
   — integration test against the synthetic HBA fixture.
   v2 grows tests here.
9. [`apps/holtburger-web/src/global_source.rs`](../external/holtburger/apps/holtburger-web/src/global_source.rs)
   — `init_resource_source` thread-local. Unchanged in v2
   (the API is version-agnostic).
10. [`apps/holtburger-web/src/prefetch.rs`](../external/holtburger/apps/holtburger-web/src/prefetch.rs)
    — Phase 5.0b iterative-discovery driver. Unchanged in
    v2 (works against any `ResourceSource`).
11. [`apps/holtburger-web/index.html`](../external/holtburger/apps/holtburger-web/index.html)
    `init_resource_source(MANIFEST_URL)` block. Unchanged
    in v2 except the diagnostic message.
12. [`apps/holtburger-web/service-worker.js`](../external/holtburger/apps/holtburger-web/service-worker.js)
    — Phase 5.0 obj 7 SW. v2 extends interception scope.
13. [`apps/holtburger-web/smoke_test.cjs`](../external/holtburger/apps/holtburger-web/smoke_test.cjs)
    — Phase 5.0b smoke gate (56 checks). v2 adds ~6 more.

### Format spec — top-level v2 manifest (JSON)

```json
{
  "version": 2,
  "generated_at": "2026-05-05T12:00:00Z",
  "source": {
    "portal_dat_iteration": 2072,
    "cell_dat_iteration": 982,
    "local_dat_iteration": 994
  },
  "boot_pack": {
    "url": "boot.hba",
    "size": 1861361,
    "sha256": "1dcb277bb9dd67bfbd0a3634f451ce714f1347e75b050acfd2cc3ce33febb395",
    "covers": ["eor/cell:0xA9B4FFFF", "..."]
  },
  "catalog_version": 1,
  "namespaces": ["eor/portal", "eor/cell", "eor/local", "holtburger/core"],
  "shard_url_template": "shards/{sha256}.bin",
  "catalog_url_template": "manifest/{namespace_slug}.bin"
}
```

Field semantics:

- `version`: 2 (consumers route on this).
- `generated_at`: ISO 8601 UTC timestamp; informational.
- `source`: provenance from canonical retail DAT iterations
  (or zeros when baked from an HBA). Same as v1.
- `boot_pack`: identical layout to v1. `covers` is a
  list of `<namespace>:0xXXXXXXXX` keys served by the boot
  pack — lets the resource source short-circuit prefetches
  without parsing the boot HBA.
- `catalog_version`: integer, bumps when any per-namespace
  catalog changes. Page checks this on subsequent visits
  to decide whether cached catalogs are stale.
- `namespaces`: list of namespace strings present in the
  bundle.
- `shard_url_template`: URL template for individual shard
  fetches. Tokens `{sha256}` and `{namespace_slug}` and
  `{file_id_hex}` are substituted at fetch time. Default
  for content-addressable mode: `"shards/{sha256}.bin"`.
- `catalog_url_template`: optional. URL template for
  per-namespace catalogs. Token `{namespace_slug}` is
  substituted. Absent or `null` → no catalogs available
  (page falls through to convention-URL mode without
  sha256 verification).

Total size: ≈ 800 bytes – 2 KB (depending on
`boot_pack.covers` length).

### Format spec — per-namespace catalog (binary)

Magic identifier: `b"HBNS"` (Holtburger Namespace).

```
Header (16 bytes, little-endian):
  Offset  Size  Field
  ------  ----  -----
  0       4     magic            = b"HBNS"
  4       1     version          = 1
  5       1     flags            (bit 0: full-32-byte sha256;
                                  bits 1-7 reserved, must be 0)
  6       2     reserved         = 0
  8       4     entry_count      (u32 LE)
  12      4     reserved2        = 0

Entry stream (variable, repeats entry_count times):
  - varint file_id_delta: ULEB128. Delta from previous
    entry's file_id (first entry's "previous" is 0).
  - 16 bytes (or 32 if flags bit 0 set): truncated or full
    sha256 of the record bytes.
  - varint size: ULEB128. Record size in bytes.

Footer (8 bytes, little-endian):
  - 4 bytes: CRC32 (poly 0xEDB88320, init 0xFFFFFFFF) over
    header + entry stream (NOT including footer itself).
  - 4 bytes: trailing magic = b"SNBH" (HBNS reversed).
```

ULEB128 varint: each byte's high bit signals continuation.
1-7 bits of value per byte. file_id_delta is small (typical
2-byte for `eor/cell`, 1-byte for densely-packed
`eor/portal`). size is also typically small (most records
<100 KB → 3 varint bytes).

Empirical per-entry cost on a real bake:
- file_id_delta: ~1.2 bytes avg (sorted, sparse u32)
- sha256_truncated: 16 bytes
- size: ~2 bytes avg (record sizes 1-1000 KB)
- **Total: ~19 bytes per entry**

For `eor/cell` 805k entries: 19 MB raw, ~6-8 MB gzipped.
For `eor/portal` 80k entries: 1.5 MB raw, <1 MB gzipped.
For `eor/local` 30k entries (estimate): 600 KB raw,
~250 KB gzipped.

The catalog is sorted by file_id ascending. Lookup is
binary search (after parsing into `Vec<CatalogEntry>`).

### Format spec — convention shard URL

Page derives shard URL from `(namespace, file_id, sha256_hex)`
via `shard_url_template`. Token substitution:

| Token | Substitution |
|---|---|
| `{sha256}` | full lowercase hex sha256 of the record bytes |
| `{namespace_slug}` | `namespace.replace('/', '-')` (e.g. `"eor-portal"`) |
| `{file_id_hex}` | `0x{file_id:08X}` uppercase hex |

Default `shard_url_template`:

- Content-addressable: `"shards/{sha256}.bin"`
- 2-level prefix split: `"shards/{sha256:0:2}/{sha256}.bin"`
  (token form: see `Token::Sha256Prefix(N)` in objective 2)
- Convention: `"shards/{namespace_slug}/{file_id_hex}.bin"`

The bake-time choice (objective 5) emits BOTH the
content-addressable canonical files and the
convention-URL symlinks pointing at them. The manifest's
`shard_url_template` selects which the page uses. Both
serve identical bytes.

### Sketch — `holtburger_manifest::v2`

```rust
// crates/holtburger-manifest/src/v2.rs

use std::collections::BTreeMap;
use serde::{Serialize, Deserialize};

pub const MANIFEST_V2_VERSION: u32 = 2;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ManifestV2 {
    pub version: u32,
    pub generated_at: String,
    pub source: crate::SourceMeta,
    pub boot_pack: crate::BootPack,
    pub catalog_version: u32,
    pub namespaces: Vec<String>,
    pub shard_url_template: String,
    pub catalog_url_template: Option<String>,
}

impl ManifestV2 {
    pub fn render_shard_url(&self, key: ResourceKey<'_>, sha256_hex: &str) -> String {
        self.shard_url_template
            .replace("{sha256}", sha256_hex)
            .replace("{namespace_slug}", &namespace_slug(key.namespace))
            .replace("{file_id_hex}", &format!("0x{:08X}", key.file_id))
    }
    pub fn render_catalog_url(&self, namespace: &str) -> Option<String> {
        self.catalog_url_template.as_ref().map(|t|
            t.replace("{namespace_slug}", &namespace_slug(namespace))
        )
    }
}

pub fn namespace_slug(namespace: &str) -> String {
    namespace.replace('/', "-")
}
```

### Sketch — `holtburger_manifest::catalog`

```rust
// crates/holtburger-manifest/src/catalog.rs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamespaceCatalog {
    pub namespace: String,
    pub flags: u8,
    pub entries: Vec<CatalogEntry>, // sorted by file_id ascending
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub file_id: u32,
    pub sha256_truncated: [u8; 16],
    pub size: u64,
}

pub const CATALOG_MAGIC: [u8; 4] = *b"HBNS";
pub const CATALOG_TRAILING_MAGIC: [u8; 4] = *b"SNBH";
pub const CATALOG_FORMAT_VERSION: u8 = 1;

#[derive(thiserror::Error, Debug)]
pub enum CatalogError {
    #[error("bad magic")]   BadMagic,
    #[error("bad trailing magic")] BadTrailingMagic,
    #[error("unsupported version {0}")] UnsupportedVersion(u8),
    #[error("crc mismatch: expected {expected:08x}, got {got:08x}")]
    CrcMismatch { expected: u32, got: u32 },
    #[error("entry count overflow")] EntryCountOverflow,
    #[error("truncated input")] Truncated,
}

impl NamespaceCatalog {
    pub fn write_to(&self, out: &mut impl std::io::Write) -> std::io::Result<()> { /* ... */ }
    pub fn read_from(bytes: &[u8]) -> Result<Self, CatalogError> { /* ... */ }
    pub fn lookup(&self, file_id: u32) -> Option<&CatalogEntry> {
        self.entries.binary_search_by_key(&file_id, |e| e.file_id).ok()
            .map(|i| &self.entries[i])
    }
}

fn write_uleb128(value: u64, out: &mut impl std::io::Write) -> std::io::Result<()> { /* ... */ }
fn read_uleb128(bytes: &[u8], offset: &mut usize) -> Option<u64> { /* ... */ }
```

### Sketch — `ManifestResourceSource` v2 connect path

```rust
pub async fn connect(manifest_url: &str) -> Result<Self, ManifestConnectError> {
    let manifest_bytes = fetch_bytes(manifest_url).await?;
    // Sniff the version field without parsing the whole struct.
    let version: ManifestVersionProbe = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;

    match version.version {
        1 => connect_v1(manifest_url, manifest_bytes).await,
        2 => connect_v2(manifest_url, manifest_bytes).await,
        other => Err(ManifestConnectError::UnsupportedVersion(other)),
    }
}

#[derive(Deserialize)]
struct ManifestVersionProbe { version: u32 }

async fn connect_v2(
    manifest_url: &str,
    manifest_bytes: Vec<u8>,
) -> Result<ManifestResourceSource, ManifestConnectError> {
    let manifest: ManifestV2 = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| ManifestConnectError::ManifestParse(e.to_string()))?;
    // ... fetch + verify boot pack same as v1 ...
    Ok(ManifestResourceSource {
        manifest,
        boot,
        catalogs: Arc::new(Mutex::new(HashMap::new())),
        shards: Arc::new(Mutex::new(HashMap::new())),
        base_url,
    })
}
```

### Sketch — `ManifestResourceSource` v2 prefetch path

```rust
pub async fn prefetch(&self, keys: &[ResourceKey<'_>]) -> Result<(), PrefetchError> {
    // 1. Filter out boot-served + already-cached keys.
    // 2. For each key's namespace, lazily fetch the catalog
    //    (if catalog_url_template set + not yet loaded).
    // 3. Look up sha256 in the catalog (when available).
    // 4. Compute shard URL via shard_url_template.
    // 5. fetch_bytes in parallel.
    // 6. (Optional) verify sha256_truncated against fetched bytes.
    // 7. Insert into cache.

    let mut needed_namespaces: HashSet<String> = HashSet::new();
    for key in keys {
        if !self.boot_serves(*key) && !self.is_cached(*key) {
            needed_namespaces.insert(key.namespace.to_owned());
        }
    }
    self.ensure_catalogs(&needed_namespaces).await?;

    // ... rest of prefetch as v1 ...
}

async fn ensure_catalogs(&self, namespaces: &HashSet<String>) -> Result<(), PrefetchError> {
    let needed: Vec<String> = {
        let cached = self.catalogs.lock().unwrap();
        namespaces.iter()
            .filter(|ns| !cached.contains_key(*ns))
            .cloned().collect()
    };
    if needed.is_empty() { return Ok(()); }
    let Some(template) = self.manifest.catalog_url_template.as_ref() else {
        return Ok(()); // no-catalog mode; convention URLs only
    };
    let fetches = needed.iter().map(|ns| {
        let url = self.manifest.render_catalog_url(ns).unwrap();
        let url = join_url(&self.base_url_with_slash(), &url);
        async move { (ns.clone(), fetch_bytes(&url).await) }
    });
    let results = futures::future::join_all(fetches).await;
    let mut cache = self.catalogs.lock().unwrap();
    for (ns, res) in results {
        let bytes = res.map_err(|e| PrefetchError::CatalogFetch { namespace: ns.clone(), source: e })?;
        let cat = NamespaceCatalog::read_from(&bytes)
            .map_err(|e| PrefetchError::CatalogParse { namespace: ns.clone(), message: e.to_string() })?;
        cache.insert(ns, cat);
    }
    Ok(())
}
```

### Sketch — `dat-shard` v2 emission

```rust
fn write_v2_artifacts(opts: &DatShardOptions, bundle: &LoadedBundle, boot_pack: BootPack)
    -> Result<()>
{
    // Per-namespace catalogs.
    let ns_groups: HashMap<String, Vec<&((String, u32), Vec<u8>)>> = /* group bundle.records by namespace */;
    let manifest_dir = opts.output_dir.join("manifest");
    std::fs::create_dir_all(&manifest_dir)?;
    for (ns, entries) in &ns_groups {
        let mut sorted: Vec<_> = entries.clone();
        sorted.sort_by_key(|((_, file_id), _)| *file_id);
        let cat = NamespaceCatalog {
            namespace: ns.clone(),
            flags: 0,
            entries: sorted.iter().map(|((_, file_id), bytes)| {
                let hash = compute_sha256(bytes);
                CatalogEntry {
                    file_id: *file_id,
                    sha256_truncated: hash[..16].try_into().unwrap(),
                    size: bytes.len() as u64,
                }
            }).collect(),
        };
        let cat_path = manifest_dir.join(format!("{}.bin", namespace_slug(ns)));
        let mut file = std::fs::File::create(&cat_path)?;
        cat.write_to(&mut file)?;
    }

    // 2-level shard dirs + convention symlinks.
    write_shards_v2(bundle, &opts.output_dir)?;

    // Top-level manifest.
    let manifest = ManifestV2 {
        version: MANIFEST_V2_VERSION,
        generated_at: iso_8601_now(),
        source: bundle.source_meta.clone(),
        boot_pack,
        catalog_version: 1,
        namespaces: ns_groups.keys().cloned().collect(),
        shard_url_template: "shards/{sha256:0:2}/{sha256}.bin".into(),
        catalog_url_template: Some("manifest/{namespace_slug}.bin".into()),
    };
    let json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(opts.output_dir.join("manifest.json"), json)?;
    Ok(())
}
```

### Verification checklist (per commit boundary)

- [ ] `cargo test --workspace --lib` from `external/holtburger/`
      — ≥ 1130 passed / 0 failed at end-state.
- [ ] `cargo check --target wasm32-unknown-unknown` clean for
      `holtburger-{dat,session,transport-ws,resource-http,
      web,content,core,manifest}`.
- [ ] `wasm-pack build --target {nodejs,web}` both green.
- [ ] `node smoke_test.cjs` from `apps/holtburger-web/` —
      ≥ 62/62 PASS after objective 8 lands.
- [ ] **Live-ACE manual validation.** Pre-bake `dist/` with
      v2 dat-shard. Open `index.html` in Chromium / Firefox;
      verify (a) initial page load fetches `manifest.json`
      <5 KB + `boot.hba` <2 MB + (lazily, when navigating
      out of Holtburg) per-namespace catalog .bin files,
      (b) Selection screen and Holtburg renderer paint
      without per-record shard fetches (boot pack covers
      Holtburg), (c) panning to a non-boot landblock
      triggers a small shard fetch (visible in DevTools
      Network), (d) reload page and confirm boot pack +
      shards + catalogs all serve from service worker /
      IndexedDB cache (Network tab "from service worker"
      indicator).
- [ ] Save screenshot at
      `docs/images/phase-5.2-manifest-fix.png` showing
      DevTools Network tab proving the manifest.json fetch
      is <5 KB.

### Decisions to NOT re-litigate

These have been settled in Phase 5.0/5.0b/5.1. Do not
re-open without explicit ask from the user:

- **WASM-port over server-side per-player rendering.**
- **External WS proxy over ACE patch.**
- **PixiJS-only renderer (no Leaflet).**
- **`wasm-pack` over `trunk` for the build pipeline.**
- **WS frame protocol `[port:u16 BE][ac_packet]`.**
- **Sync `ResourceSource` (not async-trait).**
- **`Transport` trait cfg-split: `Send + Sync` on native,
  `?Send` on wasm32.**
- **Direct-DAT terrain rendering, not Leaflet basemap reuse.**
- **Real retail textures via Texture (0x06) parser.**
- **AGPL-3.0 license.**
- **Real `~/ac_base_dats/` dats over synthetic fixtures.**
- **CDN PixiJS via importmap, no JS bundler.**
- **`gloo-timers` over `tokio::time` on wasm32.**
- **`PlayerCreate` triggers InWorld + sends `LoginComplete`.**
- **Account auto-create at level 0; manual SQL promote to
  Developer for admin commands.**
- **Content-addressable shards (sha256-keyed).**
- **`Arc<Mutex<HashMap>>` for shard / catalog caches**
  (Phase 5.0 obj 4 trait bound; wasm32 single-threaded).
- **`prefetch()` async surface + sync `get_file_by_key`
  on `ResourceSource`.**
- **`RecordingSource` iterative discovery for
  unbounded-depth walks** (Phase 5.0b).
- **Transitive boot pack walk via
  `holtburger_dat::walk::collect_model_dependencies`**
  (Phase 5.1a/b).

### Decisions still legitimately open after Phase 5.2

- **Boot pack adaptive sizing.** Phase 5.1b's transitive
  walk is "include everything reachable from spawn
  placements." For dense areas (Mountain Sea, Yaraq,
  capital cities) the boot pack may exceed the bandwidth
  target. Phase 5.3 — adaptive boot policy: smaller
  surround radius for high-density areas, or
  "essential rendering" heuristic that drops some surface
  chains in favor of category-tint fallback. Cell-density
  histogram per landblock could drive a per-area
  policy.
- **CDN deployment with content-integrity headers.**
  Phase 6 hosting brief. CloudFront / Cloudflare R2 /
  Fastly / self-hosted nginx. Brotli vs gzip vs zstd.
  `X-Content-SHA256` header configuration. Page-side
  config flag to enable verification.
- **Manifest signing.** For untrusted CDNs, sign the
  top-level manifest with a server-held key + verify in
  the wasm bundle. Out of scope; assumes
  operator-controlled CDN.
- **Service worker scope.** Currently scopes to the page's
  origin. For multi-project deploys (different worlds at
  different paths), a per-world service worker scope
  would let cache eviction land per-world.
- **Manifest delta updates beyond `catalog_version`.**
  A new `catalog_version` causes the page to re-fetch the
  full namespace catalog on first miss after revisit.
  Patch / append-only delta encoding could shrink that
  re-fetch. Worth considering once N players hit it.
- **Authentication on shards.** For paid / private worlds,
  shard URLs would need session-bound signed URLs. Same
  as manifest signing — out of scope.
- **WebRTC data channel for live game state.** Currently
  the WS transport carries everything. Splitting live
  (movement, chat) over WebRTC + static (assets) over
  HTTP-cached shards is a Phase 7 optimization for
  ultra-low-latency play.
- **v1 manifest removal.** This brief deprecates v1 with
  one release cycle. After cycle ends, a follow-up
  commit removes the v1 path, the `--manifest-version=1`
  CLI flag, and the v1 module. Two commits + one
  release-cycle wait.

### Commit conventions (match prior phases)

- `feat(emit-dynamic-site): Phase 5.2 obj N — <subject>`
  for v2 schema crate, `NamespaceCatalog` codec,
  `ManifestResourceSource` v2 path, `dat-shard` v2 emission,
  service worker scope expansion.
- `test(emit-dynamic-site): Phase 5.2 obj N — <subject>`
  for smoke-test additions in objective 8.
- `docs(emit-dynamic-site): Phase 5.2 — <subject>` for
  the as-built doc + design doc + memory updates.
- Commit body: section-headed paragraphs explaining
  **what** + **why**, with verification stats (test
  counts, smoke-check counts, real-world bake size
  numbers). See `0578cb7`, `0d81554`, `f760981`,
  `8afb423`, `5fb0919` for format examples.
- Co-author trailer:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Memory update at the end: edit
  `/home/wbterminal/.claude/projects/-home-wbterminal/memory/project_emit_dynamic_site.md`
  to add a "**Phase 5.2 manifest scale fix landed**"
  paragraph in the same style as the existing Phase 5.0/
  5.0b/5.1 entries, and bump the `MEMORY.md` index line.

### Tooling assumed installed

- `cargo` + `rustc` (in `~/.cargo/bin`, source
  `~/.cargo/env` if needed).
- `wasm-pack 0.14.0`.
- `wasm32-unknown-unknown` rustup target.
- `node` ≥ 18.
- `python3` for serving the bundle locally.
- Real browser (Chrome / Firefox) for manual validation.
- `~/ac_base_dats/` — canonical retail DAT files.
- MariaDB 11.8 + ACE provisioned per
  `docs/ace-local-setup.md` for the live-validation step.
- `~/ace-server/` — full upstream ACE clone.
- (No new tooling vs Phase 5.0; this brief uses the same
  stack.)

### What done looks like

- A 600 kbps phone connection lands at the Holtburg
  renderer with a spawned character in **<60 s** total —
  Phase 5 obj 11's deferred verification, now achievable.
- Reload of the same page on the same browser boots in
  **<3 s** (top-level manifest re-fetch is ≈2 KB; boot
  pack + shards + catalogs from SW cache).
- Crossing a landblock boundary in the renderer adds
  **<2 s** to first paint of the new cell on cold cache,
  **<100 ms** on warm cache. (Identical to Phase 5.0
  target.)
- WorldBuilder edits a model, republishes the manifest +
  shards (with `catalog_version` bumped). Other clients
  on the same world see the new model on their next
  visit, fetching only the changed shard
  (≈ 100 KB) + the changed catalog
  (≈ 5-10 MB, gzipped).
- A custom WorldBuilder world with 10× the Dereth
  cells produces a top-level `manifest.json` of the same
  ≈2 KB. Per-namespace catalogs scale with content but
  load lazily.
- `node smoke_test.cjs` reports ≥ 62/62 PASS.
- All ≥ 1130 workspace lib tests pass.
- New screenshot at
  `docs/images/phase-5.2-manifest-fix.png` is committed
  showing DevTools proving the manifest fetch is <5 KB.
- The next session can either (a) tackle Phase 5.3 (boot
  pack adaptive sizing for dense areas), (b) ship Phase 4
  step 2b (`UpdatePosition` → PIXI entity buffer), (c)
  deploy to a real CDN as Phase 6. Phase 5.2 closes the
  manifest-scale rail without blocking any of these.
