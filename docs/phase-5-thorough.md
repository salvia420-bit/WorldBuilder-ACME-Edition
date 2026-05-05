# Phase 5.0 — production-grade asset delivery (as-built)

> Companion to [`thorough.md`](thorough.md) (the framing brief).
> This file is the as-built record: what landed, what didn't,
> and where to look in the code.

## Status

| Sub-step | Status | Commits |
|---|---|---|
| 5.0 obj 1 — HttpResourceSource audit | ✅ landed | `0578cb7` |
| 5.0 obj 2 — `holtburger-manifest` crate | ✅ landed | `9521109` |
| 5.0 obj 3 — `dat-shard` tool | ✅ landed (minimum-viable boot policy) | `0d81554` |
| 5.0 obj 4 — `ManifestResourceSource` | ✅ landed | `f760981` |
| 5.0 obj 5 — Thread-local + `init_resource_source` | ✅ infrastructure | `5dc6551` |
| 5.0 obj 6 — `index.html` manifest-mode wiring | ✅ opt-in initial; manifest-only after 5.0b | `4f4c806` |
| 5.0 obj 7 — Service worker shard cache | ✅ landed | `78c6924` |
| 5.0 obj 8 — `dat2hba --profile boot` | ✅ landed (minimum-viable + transitive walk in 5.1) | `2a23a74` |
| 5.0 obj 9 — Smoke 48 → 55 | ✅ landed (→ 56 after 5.0b) | `688550d` |
| 5.0 obj 10 — Native + wasm gate green | ✅ verified | (verification pass — no commit) |
| 5.0 obj 11 — Live-ACE manual validation | ⚠️ pending — needs the 600 kbps phone over Tailscale | (user-driven) |
| 5.0 obj 12 — Documentation | ✅ this file | `4c9d9fa` |
| **5.0b — per-export refactor** | ✅ landed (drops `asset_url` from every fetch_*; smoke fixture rewrite; manifest mode is now the only path) | `8afb423` |
| **5.1a — `holtburger-dat::walk` extraction** | ✅ landed (`collect_model_dependencies` + `read_gfx_obj_surfaces` public) | `7224359` |
| **5.1b — Transitive boot pack walk** | ✅ landed (635 covers / 1.86 MB on real `dats/assets.hba` from Holtburg) | `5fb0919` |

## What landed

### 1. The schema (`crates/holtburger-manifest`)

Pure data crate shared by the producer (`dat-shard`) and consumer
(`ManifestResourceSource`) of the manifest+shards delivery
format. Compiles native + wasm32; no I/O. Wire shape v1:

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
    "covers": ["eor/portal:0x0E000002", "eor/cell:0xA9B4FFFF"]
  },
  "shards": {
    "eor/portal:0x01000827": {
      "sha256": "9f10…",
      "size": 4129,
      "url": "shards/9f10…ef.bin"
    }
  }
}
```

Shard keys are `<namespace>:0x{file_id:08X}`. Hash is sha256 of
the raw record bytes — content-addressable, so byte-identical
records collapse to one shard URL.

### 2. The producer (`dat-shard`)

`apps/holtburger-tools/src/bin/dat-shard.rs` (CLI) +
`src/dat_shard.rs` (library). Reads either an existing HBA
(`--input`) or a triple of canonical retail DATs (`--eor-portal`
+ `--eor-cell` + `--eor-local`) and emits:

- `<output>/manifest.json`
- `<output>/shards/{sha256-hex}.bin` — one file per unique
  record; sha256 dedupes byte-identical records to one shard.
- `<output>/boot.hba` — precompiled HBA covering the records the
  browser needs to reach the Selection screen + render the
  spawn landblock without any shard fetches.

Boot policy (Phase 5.0 obj 3 minimum-viable):

- Catalog tables: CharGen, ChatPoseTable, SkillTable, SpellTable,
  XpTable, MotionKinematics.
- Spawn-area 9-cell neighborhood: each cell's CellLandblock
  (`0xXXYYFFFF`) and LandblockInfo (`0xXXYYFFFE`).
- Clamps at world-edge (top-left has only 4 in-bounds neighbors).

The transitive
GfxObj/SetupModel/Surface/SurfaceTexture/Texture/Palette walk
through the boot landblock's object placements is deferred to
Phase 5.1 — the walk helpers currently live as private functions
in `apps/holtburger-web/src/lib.rs` (`walk_gfx_obj`,
`walk_setup_model`, `read_gfx_obj_surfaces`); factoring them into
shared `holtburger-dat` utilities is a separate refactor that
unblocks both `dat-shard`'s boot pack and the matching
`dat2hba --profile boot` mode producing a "5 MB target" rather
than the current "essentials + spawn cells only."

CLI shape:

```bash
dat-shard \
    --eor-portal $HOME/ac_base_dats/client_portal.dat \
    --eor-cell $HOME/ac_base_dats/client_cell_1.dat \
    --eor-local $HOME/ac_base_dats/client_local_English.dat \
    --boot-landblock 0xA9B4 \
    --output dist/

# Or from an existing bundled HBA (fast path for fixture tests):
dat-shard --input dats/assets.hba --output dist/
```

### 3. The consumer (`ManifestResourceSource`)

`crates/holtburger-resource-http/src/manifest_source.rs`. wasm32-
only. Pipeline:

```text
init_resource_source(manifest_url)
  ├─→ fetch manifest.json
  ├─→ parse Manifest
  ├─→ fetch boot_pack.url (HBA bytes)
  ├─→ verify boot_pack.sha256
  └─→ HbaReader::from_bytes(boot_bytes)

each fetch_*  (post obj-5b refactor)
  ├─→ source.prefetch(&[ResourceKey])
  │     └─→ futures::try_join_all of shard fetches
  │           (skip boot-covered + already-cached)
  ├─→ for each key: source.get_file_by_key(key)
  │     ├─→ try boot pack  (sync)
  │     ├─→ try shard cache (sync)
  │     └─→ error RecordNotPrefetched
  └─→ existing parse + tessellate logic
```

Trait surface stays sync (`ResourceSource: Send + Sync`); all
fetching moves to the new explicit `prefetch(&[ResourceKey<'_>])`
async method. Same approach as the spike doc §8 step 4 "default
to (b) for the spike if the choice isn't obvious."

Shard cache is `Arc<Mutex<HashMap<OwnedKey, Vec<u8>>>>` — the
trait bound forbids `Rc<RefCell>`, and wasm32 is single-threaded
so the mutex never contends.

### 4. The page-init wiring

`apps/holtburger-web/src/global_source.rs` holds a thread-local
`Option<Rc<ManifestResourceSource>>` populated by
`init_resource_source(manifest_url)` (a new wasm-bindgen export).
JS calls it once at page-init time before any `fetch_*` runs.
`has_resource_source()` and `cached_shard_count()` are
introspection exports the smoke tests use.

`apps/holtburger-web/index.html` calls
`init_resource_source("../../dist/manifest.json")` after `await
init()`; fail-soft (page logs and continues with legacy HBA mode
if `dist/` isn't pre-baked).

### 5. The service worker

`apps/holtburger-web/service-worker.js` (~80 LOC). Intercepts
`fetch` events for any URL containing `/shards/`, serves them
from Cache Storage when present, stashes successful network
responses for next time. Activates on install, takes control of
clients on activate, garbage-collects old cache versions when
`SHARD_CACHE` bumps.

Why Cache Storage rather than IndexedDB directly: same durability
guarantee, but `Request`-keyed and serves `Response` natively.

### 6. The `dat2hba --profile boot` mode

`crates/holtburger-dat/src/manifest.rs::StripperManifest::boot`
holds the canonical boot inclusion rules — used by both
`dat2hba --profile boot` and `dat-shard`'s embedded boot pack
generation. `dat2hba --profile boot --boot-landblock 0xA9B4 ...
boot.hba` produces a standalone HBA the same shape as
`dat-shard`'s `dist/boot.hba`.

### 7. Smoke gate (48 → 55)

`apps/holtburger-web/smoke_test.cjs` grows 7 new assertions:

1. Symbol-presence: `init_resource_source()`, `has_resource_source()`,
   `cached_shard_count()` are all exported.
2. Pre-init invariant: `has_resource_source()` returns false,
   `cached_shard_count()` returns 0 before init.
3. End-to-end round-trip: `dat-shard --input dats/assets.hba
   --output <tempdir>` produces a manifest+shards+boot tree;
   `wasm.init_resource_source(<tempdir>/manifest.json)` resolves
   against it; `has_resource_source()` flips true and the boot
   pack is hot in-memory (cached_shard_count stays 0; boot
   records are served from the in-memory HBA, not the shard
   cache).

The end-to-end check degrades to a SKIP if either
`dats/assets.hba` is missing or the dat-shard release binary
hasn't been built. Other 5 checks are gate-green without any
fixture.

## What didn't land (deferred)

### Phase 6 — CDN deployment

The brief explicitly leaves CDN choice (CloudFront vs.
Cloudflare R2 vs. Fastly vs. self-hosted nginx) for a separate
Phase 6 hosting brief. Phase 5.0 delivers the artifact + the
client code; ops chooses the hosting.

### Live-ACE manual validation (obj 11)

Deferred until someone runs `dat-shard` against the canonical
retail DATs to bake `dist/`, opens `index.html` over Tailscale
on a 600 kbps phone, and screenshots the DevTools Network tab
proving the shard fetches are <100 KB each. With 5.0b + 5.1b
landed, the bandwidth cliff is fully closed at the code level:
first paint fetches `manifest.json` (~few KB) + `boot.hba`
(~1.86 MB on Holtburg-baked dist) plus protocol round-trip;
panning to non-boot landblocks adds shard fetches at 5-100 KB
per record.

## Files this work touches

| File | Role |
|---|---|
| `external/holtburger/crates/holtburger-manifest/{Cargo.toml,src/lib.rs}` | Schema + sha256 helper |
| `external/holtburger/apps/holtburger-tools/src/dat_shard.rs` | dat-shard library |
| `external/holtburger/apps/holtburger-tools/src/bin/dat-shard.rs` | dat-shard CLI |
| `external/holtburger/apps/holtburger-tools/tests/sharding.rs` | dat-shard integration tests |
| `external/holtburger/apps/holtburger-tools/src/bin/dat2hba.rs` | --profile boot CLI flag |
| `external/holtburger/apps/holtburger-tools/src/dat2hba.rs` | boot profile wiring |
| `external/holtburger/crates/holtburger-dat/src/manifest.rs` | `StripperManifest::boot` |
| `external/holtburger/crates/holtburger-resource-http/src/{http,source,manifest_source}.rs` | `ManifestResourceSource` |
| `external/holtburger/apps/holtburger-web/src/global_source.rs` | Thread-local + init export |
| `external/holtburger/apps/holtburger-web/index.html` | init_resource_source + SW registration |
| `external/holtburger/apps/holtburger-web/service-worker.js` | IndexedDB-backed shard cache |
| `external/holtburger/apps/holtburger-web/smoke_test.cjs` | 48 → 55 |

## Verification snapshot at Phase 5.0 close

- `cargo test --workspace --lib`: 1116 passed, 0 failed.
- `cargo check --target wasm32-unknown-unknown`: clean for
  `holtburger-{dat,session,transport-ws,resource-http,web,
  content,core,manifest}`.
- `wasm-pack build --target {nodejs,web}`: both green.
- `node smoke_test.cjs`: 55/55 PASS.
