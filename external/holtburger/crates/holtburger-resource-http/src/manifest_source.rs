//! Phase 5.0 — `ManifestResourceSource` contract (audit-first stub).
//!
//! This file lands in advance of the implementation (Phase 5.0
//! objective 4). Objective 1 of the Phase 5.0 brief
//! (`docs/thorough.md`) is to audit the existing
//! `HttpResourceSource` + every wasm-bindgen `fetch_*` export and
//! pin down the contract a manifest-backed source has to honour.
//! Those findings live here, at the top of the new module, so the
//! implementation can be checked against them.
//!
//! # Audit findings (commit boundary 1 of Phase 5.0)
//!
//! ## (a) The `ResourceSource` trait surface is sync
//!
//! `holtburger_dat::ResourceSource` is defined at
//! `crates/holtburger-dat/src/lib.rs:138` as:
//!
//! ```ignore
//! pub trait ResourceSource: Send + Sync {
//!     fn get_file_by_key(&self, key: ResourceKey<'_>) -> Result<Vec<u8>>;
//!     fn get_metadata_by_key(&self, key: ResourceKey<'_>) -> Option<FileMetadata>;
//!     fn has_namespace(&self, namespace: &str) -> bool;
//!     fn exists_by_key(&self, key: ResourceKey<'_>) -> bool { ... }
//! }
//! ```
//!
//! No `.await`. Used from `&dyn ResourceSource` slots in
//! `holtburger-content` (`ContentRepository::read_asset`),
//! `holtburger-world`, `holtburger-core`. Async-trait-ifying the
//! trait would propagate `.await` through ~6 call sites in 4 crates
//! plus a `?Send` cfg-split mirror of the `Transport` work in
//! Phase 2 §8 step 2. Phase 5.0 keeps the trait sync; all *fetching*
//! moves to a new explicit `prefetch(&[ResourceKey]) -> impl Future`
//! method called from each wasm-bindgen export before any
//! `get_file_by_key`.
//!
//! ## (b) Per-call construction pattern
//!
//! Every wasm-bindgen export in `apps/holtburger-web/src/lib.rs`
//! creates its own `HttpResourceSource::connect(&asset_url)` per
//! invocation:
//!
//! - `try_http_resource_source_smoke` (single record by
//!   `(namespace, file_id)`) — `:108`
//! - `fetch_landblock_heightmaps` + singular alias — N ×
//!   `eor/cell:cell_id` — `:307`, `:279`
//! - `fetch_landblock_objects` — N × `eor/cell:id` — `:487`
//! - `fetch_terrain_textures` — 33 × the `eor/portal:surf_id` →
//!   SurfaceTexture → Texture → Palette chain — `:562`
//! - `fetch_object_colours` — per-id GfxObj / SetupModel / Surface
//!   walk against `eor/portal` — `:867`
//! - `fetch_surface_pixels` (+ plural) — `eor/portal:surface_did`
//!   → `surf_tex_id` → render-surface-id → palette — `:1316`,
//!   `:1331`
//! - `fetch_model_mesh` (+ plural) — `eor/portal:setup_id` →
//!   per-part Model records — `:1354`, `:1373`
//! - `start_session` (when `asset_url` non-empty, runs as a
//!   `wasm_bindgen_futures::spawn_local` background task) →
//!   `load_character_gen_catalog` (`:2112`) → CharGen
//!   (`0x0E000002`) + SkillTable
//!
//! That's ≥10 distinct `connect(asset_url)` callsites. With the
//! existing 605 MB HBA bundle this works only because the browser
//! HTTP cache deduplicates the body across sibling fetches; on a
//! cold cache each one would re-pull the bundle. Phase 5.0
//! objective 5 hoists the resource source to a thread-local
//! `Rc`/`RefCell` so all callsites share a single instance and a
//! single in-memory shard cache.
//!
//! ## (c) Records are addressed by `(namespace, file_id)`
//!
//! Every callsite constructs a `ResourceKey::new(namespace,
//! file_id)` (lib.rs:128) where `namespace` is one of the
//! constants from `holtburger-dat`:
//!
//! - `eor/portal` — `holtburger_dat::EOR_PORTAL_NAMESPACE` —
//!   covers Texture, SurfaceTexture, Surface, Palette, GfxObj,
//!   SetupModel, MotionTable, CharGen, SkillTable, SpellTable,
//!   XpTable, MotionKinematics, ChatPoseTable, SoulEmoteCatalog,
//!   …
//! - `eor/cell` — covers CellLandblock and LandblockInfo (the
//!   high-bytes-of-id-hex `XXYYFFFF` and `XXYYFFFE` records
//!   respectively).
//! - (`eor/local` exists in retail dat output but is not currently
//!   read by any wasm-bindgen export.)
//!
//! `(namespace, file_id)` is the manifest key. Hashing scheme is
//! `sha256(record_bytes)`; two records with byte-identical contents
//! collapse to one shard URL. The manifest's `shards` map is keyed
//! by the `(namespace, file_id)` tuple (rendered as
//! `"<namespace>:0x{file_id:08X}"` in JSON for human readability),
//! not by hash, so the resource source can look up a record's URL
//! straight from the `ResourceKey` without walking the manifest.
//!
//! ## Implications for the implementation (objective 4)
//!
//! 1. `connect(manifest_url)` is the new construction surface.
//!    Fetches `manifest.json` + the boot pack referenced from
//!    it. Holds the boot pack's HBA in memory plus an empty
//!    `Rc<RefCell<HashMap<OwnedKey, Vec<u8>>>>` shard cache.
//! 2. `prefetch(&[ResourceKey<'_>]) -> impl Future<Output = Result<()>>`
//!    walks the keys, skips those served from the boot pack or
//!    already cached, looks up shard URLs in the manifest, fetches
//!    in parallel via `futures::future::try_join_all`, verifies
//!    sha256, and inserts into the cache.
//! 3. `get_file_by_key(&self, key)` (sync) tries (a) the boot
//!    pack, (b) the shard cache, (c) errors `RecordNotPrefetched`.
//!    No HTTP I/O on this path.
//! 4. The per-call construction pattern in `apps/holtburger-web`
//!    becomes an `init_resource_source(manifest_url)` call once
//!    at page-init time (objective 5 hoist) plus a `prefetch`
//!    call at the top of each `fetch_*` for the records that
//!    function will read. Each `fetch_*` becomes a thin wrapper
//!    around an unchanged-shape inner function that takes
//!    `&dyn ResourceSource`.

#![cfg(target_arch = "wasm32")]

// Implementation lands in objective 4. The struct, its `connect`
// constructor, the `prefetch` method, and the `ResourceSource` impl
// are all defined there. This stub holds the audit-derived contract
// the implementation has to honour.
