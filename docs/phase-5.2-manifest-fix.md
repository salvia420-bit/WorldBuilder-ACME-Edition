# Phase 5.2 — manifest scale fix (as-built)

> Companion to [`manifest.md`](manifest.md) (the framing brief).
> This file is the as-built record: what landed, what didn't,
> and where to look in the code.

## Status

| Sub-step | Status | Commits |
|---|---|---|
| 5.2 obj 1 — HttpResourceSource v1 audit | ✅ landed | (audit pass — no commit) |
| 5.2 obj 2 — `holtburger-manifest::v2` schema | ✅ landed (1121 → 1130) | (early Phase 5.2) |
| 5.2 obj 3 — `holtburger-manifest::catalog` (NamespaceCatalog binary codec) | ✅ landed (ULEB128 + CRC32 IEEE + magic/version/flags) | (early Phase 5.2) |
| 5.2 obj 4 — `ManifestResourceSource` v2 dispatch | ✅ landed 2026-05-08 | (Phase 5.2 obj 4 batch) |
| 5.2 obj 5 — `dat-shard` v2 emission + `--manifest-version=1\|2` flag | ✅ landed 2026-05-08 (1179/0 native) | (Phase 5.2 obj 5 batch) |
| 5.2 obj 6 — `index.html` page hint update | ✅ landed 2026-05-08 | (Phase 5.2 obj 6 batch) |
| 5.2 obj 7 — Service worker scope extension | ✅ landed 2026-05-08 (SW LOC 92 ≤ 120) | (Phase 5.2 obj 7 batch) |
| 5.2 obj 8 — Smoke harness v2 fixture + checks | ✅ landed 2026-05-08 (100/100 + 1 SKIP) | (Phase 5.2 obj 8 batch) |
| 5.2 obj 9 — Workspace native + wasm gate | ✅ closed implicitly by Phase 6 gate runs (smoke 121/0 + 1 SKIP, wasm-pack {nodejs,web} clean) | (Phase 6 baseline) |
| **5.2 obj 10 — production v2 bake + symlink swap** | ✅ landed 2026-05-09 — `dist/manifest.json` 195 MB → 541 bytes | (this commit) |
| 5.2 obj 10 (live-ACE phone validation) | ⚠️ pending — PK with phone on cellular | (user-driven) |
| 5.2 obj 11 — Documentation | ✅ this file + ledger bumps | (this commit) |

## What landed

### Headline number

**`dist/manifest.json` shrank from 195 MB to 541 bytes** —
**361,000× smaller** — by moving the per-shard `{sha256, size, url}`
rows out of the top-level pointer and into per-namespace binary
catalogs lazy-fetched on demand. First-page-init time on the
local loop dropped to **603 ms** (page-load → all in-page smoke
checks PASS), with a single 541-byte manifest fetch and zero
catalog fetches needed for the boot path (the boot pack covers
all initial reads).

### 1. The v2 schema (`crates/holtburger-manifest/src/v2.rs`)

Pure data crate addition. New `ManifestV2` struct + JSON wire
format:

```json
{
  "version": 2,
  "generated_at": "2026-05-10T00:00:53Z",
  "source": { "portal_dat_iteration": 0, "cell_dat_iteration": 0, "local_dat_iteration": 0 },
  "boot_pack": {
    "url": "boot.hba",
    "size": 1861361,
    "sha256": "1dcb277bb9dd67bfbd0a3634f451ce714f1347e75b050acfd2cc3ce33febb395"
  },
  "catalog_version": 1,
  "namespaces": ["eor/cell", "eor/portal", "holtburger/core"],
  "shard_url_template": "shards/{sha256_prefix2}/{sha256}.bin",
  "catalog_url_template": "manifest/{namespace_slug}.bin"
}
```

Key differences from v1:
- No `shards: { ... }` map. Per-shard rows live in the binary
  catalogs (obj 3) — fetched lazily.
- `boot_pack` shrinks: `BootPackV2` drops the 19 KB `covers:
  Vec<String>` field (635 entries × ~30 bytes). Boot-pack
  hit-tests now go through `HbaReader::exists_by_key`
  (already O(1) over hash-mapped namespace spans, same
  semantics).
- New `shard_url_template` + `catalog_url_template` for
  convention URL synthesis.

### 2. The catalog codec (`crates/holtburger-manifest/src/catalog.rs`)

Binary format for per-namespace catalogs at
`manifest/<namespace_slug>.bin`. Layout:

```
magic    "HBNS" (4 bytes)
version  u8 (= CATALOG_FORMAT_VERSION = 1)
flags    u8 (CATALOG_FLAG_FULL_SHA256 = 0x01)
namespace_len  ULEB128
namespace      <namespace_len> bytes
entry_count    ULEB128
entries:
  file_id  ULEB128
  size     ULEB128
  sha256   32 bytes (when CATALOG_FLAG_FULL_SHA256 set)
crc32_ieee  u32 LE  (over all preceding bytes)
trailer  "SNBH" (4 bytes)
```

ULEB128 + truncated-when-flagged gives ~19 bytes/entry on
average. Real-world bake produces:
- `eor-cell.bin`: **15 MB** (885k cell records dominate)
- `eor-portal.bin`: **1.5 MB**
- `holtburger-core.bin`: **48 bytes**

Catalogs are **optional** — the page works without them via
convention URLs (`shards/{namespace_slug}/0x{file_id_hex}.bin`
symlinks); catalogs exist for callers that want batch-prefetch
with sha256 verification.

### 3. ManifestResourceSource v2 dispatch (`crates/holtburger-resource-http/src/manifest_source.rs`)

`ManifestResourceSource::connect(url)` fetches the manifest
bytes once, sniffs the `version` field via
`ManifestVersionProbe`, and dispatches:
- v1 → `ManifestResourceSourceV1` (moved to `manifest_source_v1.rs`)
- v2 → new `V2Source` (in this file)

Both halves implement `ResourceSource` so callers don't care
which wire format is loaded. `manifest_version()` +
`loaded_catalog_count()` accessors expose the variant for
JS-side telemetry.

v2 `prefetch()` walks the requested keys, skips records
already in the boot pack (via `exists_by_key`) or the per-
session cache, and lazy-fetches the per-namespace catalog
once per namespace touched. After catalog load, individual
shard URLs synthesize from `shard_url_template` +
`{sha256_prefix2}` + `{sha256}`.

### 4. dat-shard v2 emission (`apps/holtburger-tools/src/dat_shard.rs`)

New `--manifest-version=1|2` clap flag with default 2.
`shard_bundle_dispatch()` routes to v1 OR v2; new
`shard_bundle_v2()` orchestrator calls:
- `write_shards_v2`: 2-level prefix dir keyed by truncated
  16-byte sha256 at `shards/{first2}/{trunc32}.bin`. Dedupe
  by truncated path; collision rate at 16 bytes is
  negligible (universe of 885k shards << 2^64 keyspace).
- `write_namespace_catalogs`: per-namespace
  `NamespaceCatalog::write_to` → `manifest/{namespace_slug}.bin`.
- `write_convention_symlinks`: unix symlinks at
  `shards/{namespace_slug}/0x{file_id:08X}.bin` →
  `../{prefix2}/{trunc32}.bin`. Lets v1-style URLs keep
  working (catalog-less convention path).
- Reuses Phase 5.1's `write_boot_pack` unchanged.
- Writes a ≈541-byte `ManifestV2` JSON top-level.

`BakeOutput { V1(Manifest), V2(V2BakeResult) }` enum +
`V2BakeResult { manifest, total_records, unique_shard_count,
catalog_count, boot_covers_count }` for callers / smoke /
binary main() to inspect what was emitted.

### 5. Service worker (`apps/holtburger-web/service-worker.js`)

Cache scope extended from `/shards/*` to `/shards/* OR
/manifest/<namespace>.bin` via a new `isCacheable(url)` helper.
**Specifically excludes `/manifest.json`** so the top-level
pointer re-fetches each load (catches version changes). Cache
renamed `holtburger-shards-v1` → `holtburger-content-v1`;
activate-step GC sweeps both `holtburger-shards-` and
`holtburger-content-` prefixes so legacy v0 caches don't
accumulate. SW LOC 92 (under brief's ≤120 target).

### 6. Smoke harness (`apps/holtburger-web/smoke_test.cjs`)

The non-`--fast` smoke now bakes both v1 and v2 variants of
`dats/assets.hba` into sibling subdirs of the smoke dist
tree, plus a third "convention-URL" variant that reuses v2's
shards/boot/manifest tree but ships a rewritten top-level
`manifest.json` with `catalog_url_template = null` +
`shard_url_template = "shards/{namespace_slug}/{file_id_hex}.bin"`.
This avoids a 4 GB `cpSync` of the 885k shard files by
URL-prefix routing.

Single `http.Server` with prefix routing (`/v1/...`,
`/v2/...`, `/v2conv/...`) tracks per-path request counts for
the catalog-fetch invariants. New wasm-bindgen exports
`manifest_version()`, `loaded_catalog_count()`,
`manifest_v2_version_const()` let JS verify the dispatch
decisions.

Smoke 83 → 100 checks at obj 8 close: 5 symbol-presence
(3 export + 2 pre-init=0 sanity), 2 v1 dispatch, 7 v2 catalog
mode, 3 v2 conv mode. Post-Phase-6 baseline: **121 / 0 + 1
SKIP**.

### 7. Production migration (this commit)

The infrastructure was complete after obj 8 (2026-05-08), but
the live `dist/` symlink still pointed at `/mnt/wbterminal1/
holtburger-dist`, baked May 6 from the pre-Phase-5.2 v1 path.
Today (2026-05-09) the production bake landed:

```
./target/release/dat-shard \
  --input dats/assets.hba \
  --output /mnt/wbterminal1/holtburger-dist-v2
```

v2 default; runs in ~5 minutes; produces:
- `manifest.json`: **541 bytes**
- `boot.hba`: 1.8 MB (unchanged)
- `manifest/`: 17 MB total (eor-cell 15 MB, eor-portal 1.5 MB,
  holtburger-core 48 bytes)
- `shards/`: 4.3 GB across 256 prefix dirs
- 885,037 unique shards, 635 boot covers

Atomic swap via:
```
ln -sfn /mnt/wbterminal1/holtburger-dist-v2 dist
```

Old v1 dist preserved at `/mnt/wbterminal1/holtburger-dist`
for rollback. Disk has 6.8 TB free on `/mnt/wbterminal1`.

### Live verification

After swap, ran the verification probe via Playwright:
- `manifestVersion`: 2 ✓
- `v2VersionConst`: 2 ✓
- `hasResourceSource`: true ✓
- Page-init → all in-page smoke PASS: **603 ms** on local loop
- Single 541-byte `manifest.json` fetch
- **0 catalog fetches** for the boot path (boot pack covers
  the smoke checks; catalogs lazy-fetch on first non-boot
  shard request)

Re-ran `capture_phase6_step_a_geometry.cjs` against the new
v2 dist: **PASS** with identical building counts (16
buildings, same model IDs, same triangles) — semantic
identity confirmed across the wire-format swap.

## What didn't land (deferred)

### obj 10 — live-ACE phone validation

Still pending. Requires PK with a tailnet phone on real
cellular (or a 600 kbps throttle). Targets:
- **First page visit** lands player at Holtburg with a spawned
  character in **<60 s** total.
- **Second page visit** boots from cache in **<3 s**.
- Crossing a landblock boundary triggers per-shard fetches via
  convention URLs (≤100 KB each); CDN-edge cache hit means
  <50 ms latency.

The 603 ms local-loop result is well under target, but
cellular adds RTT + bandwidth limits the boot-pack download
to ~25 s for 1.86 MB. Manual measurement is the only signal.

### CDN deployment

Out of scope per the brief — Phase 7 picks the CDN
(CloudFront / Cloudflare R2 / Fastly / self-hosted nginx),
sets DNS, configures cache headers including
`X-Content-SHA256` if integrity verification is enabled.
Phase 5.2 delivers the *artifact* (a directory of v2
manifest + per-namespace catalogs + shards) and the *client
code* that consumes it.

## Files this work touches

| File | Role |
|---|---|
| `crates/holtburger-manifest/src/v2.rs` | New ManifestV2 schema + URL-template renderers |
| `crates/holtburger-manifest/src/catalog.rs` | New NamespaceCatalog binary codec |
| `crates/holtburger-resource-http/src/manifest_source.rs` | V2 dispatch + V2Source + lazy catalog fetch |
| `crates/holtburger-resource-http/src/manifest_source_v1.rs` | V1 path moved here for one-release-cycle drain |
| `apps/holtburger-tools/src/dat_shard.rs` | `--manifest-version` flag + `shard_bundle_v2` + `write_namespace_catalogs` + `write_shards_v2` + `write_convention_symlinks` |
| `apps/holtburger-tools/src/bin/dat-shard.rs` | CLI clap derive for `--manifest-version` |
| `apps/holtburger-web/index.html` | Page-init hint update for v2 |
| `apps/holtburger-web/service-worker.js` | Cache scope extension to `/manifest/*.bin` |
| `apps/holtburger-web/smoke_test.cjs` | v1 / v2 / v2conv triple-bake harness + 17 new checks |
| `apps/holtburger-web/src/lib.rs` | `manifest_version()` / `loaded_catalog_count()` / `manifest_v2_version_const()` wasm exports |

## Verification snapshot at Phase 5.2 close

- Native: `cargo test --workspace --lib` 1179 / 0 across 18
  crates (post obj 5).
- WASM: `wasm-pack build --target {nodejs,web}` clean.
- Smoke `--fast`: 121 / 0 + 1 SKIP (post Phase 6 baseline).
- Live verification: page-init → PASS 603 ms, manifestVersion=2,
  Phase 6A capture PASS against v2 dist.

## Decisions still legitimately open after Phase 5.2

- **Phase 5.3 — boot pack adaptive sizing.** 5.1b's transitive
  walk includes everything reachable from spawn placements
  (1.86 MB for Holtburg). Dense areas (Mountain Sea, Yaraq,
  capital cities) may exceed the bandwidth target. 5.3 would
  add an adaptive policy: smaller surround radius for
  high-density areas, or an "essential rendering" heuristic
  that drops some surface chains in favour of category-tint
  fallback. Cell-density histogram per landblock could drive
  the policy. Not blocking; surfaces if/when validation
  against dense areas on real cellular shows the pack is too
  big.
- **v1 deprecation.** v1 stays available via
  `--manifest-version=1` for one release cycle to drain
  in-flight CDN deploys. Removing the v1 emission path is a
  future cleanup commit (estimated 2026-06-09 — one month
  after v2 default landed).
