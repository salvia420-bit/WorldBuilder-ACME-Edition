//! HTTP-backed `ResourceSource` for `holtburger-dat` — wasm32-only.
//!
//! Two implementations live here:
//!
//! - [`HttpResourceSource`] — Phase 2 spike path. Pre-fetches an
//!   entire HBA bundle into memory at construction time and serves
//!   the existing sync `ResourceSource` trait from it. Still used
//!   by native callers / smoke fixtures.
//! - [`ManifestResourceSource`] — Phase 5.0 obj 4 (v1) +
//!   Phase 5.2 obj 4 (v2) path. Reads either a
//!   [`holtburger_manifest::Manifest`] (v1) or
//!   [`holtburger_manifest::v2::ManifestV2`] (v2) over HTTP based
//!   on a `version` field sniff at connect time, fetches a small
//!   pre-compiled boot pack at construction time, and lazily
//!   fetches individual shards on demand via an explicit
//!   `prefetch()` async surface. v2 also lazy-fetches per-namespace
//!   binary catalogs (`manifest/<namespace_slug>.bin`) the first
//!   time a record from that namespace is requested. The browser's
//!   bandwidth cliff (605 MB → ≈5 MB on first paint) is closed by
//!   switching the page to this source; v2's manifest scale fix
//!   (203 MB → ≈2 KB top-level JSON) closes the second cliff.
//!
//! # Why pre-fetch then sync rather than async-trait
//!
//! `holtburger_dat::ResourceSource` is sync (`fn get_file_by_key
//! -> Result<Vec<u8>>`). Async-trait-ifying the trait would
//! propagate `.await` through ~6 call sites in 4 crates plus a
//! `?Send` cfg-split mirror of the `Transport` work in Phase 2 §8
//! step 2. Both implementations here keep the trait sync and move
//! all *fetching* to async constructors / new explicit `prefetch`
//! methods — same approach as the spike doc §8 step 4 "default to
//! (b) for the spike if the choice isn't obvious."

#![cfg(target_arch = "wasm32")]

pub(crate) mod http;
mod manifest_source;
mod manifest_source_v1;
mod source;

pub use http::{HttpError, fetch_bytes, join_url};
pub use manifest_source::{
    ManifestConnectError, ManifestResourceSource, PrefetchError, RecordingSource,
};
pub use source::{ConnectError, HttpResourceSource};
