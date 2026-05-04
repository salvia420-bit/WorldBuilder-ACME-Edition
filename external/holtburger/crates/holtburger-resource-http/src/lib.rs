//! HTTP-backed `ResourceSource` for `holtburger-dat` — wasm32-only.
//!
//! Plugs into [`holtburger_dat::LayeredResourceResolver`] (or any
//! `Arc<dyn ResourceSource>` slot) so a browser-hosted client can read
//! AC asset bytes that were originally packed by `dat2hba` and are now
//! served as a static HBA file from any HTTP origin.
//!
//! # Why pre-load instead of an async trait
//!
//! `holtburger_dat::ResourceSource` is synchronous (`fn get_file_by_key
//! -> Result<Vec<u8>>`) and `: Send + Sync`. Browsers can't
//! synchronously block on `fetch()` from the main thread, so the two
//! viable shapes for a wasm32 implementation are: (a) make the trait
//! async (refactors ~6 call sites across `holtburger-content`,
//! `holtburger-world`, `holtburger-core`); or (b) `await` the bytes
//! once at construction time and serve them sync from in-memory state.
//!
//! This crate picks (b) — same reasoning as the spike doc §8 step 4
//! "default to (b) for the spike if the choice isn't obvious." The
//! HTTP fetch happens in [`HttpResourceSource::connect`]; once the
//! `Vec<u8>` is in hand, the file is parsed by
//! `HbaReader::<Vec<u8>>::from_bytes` (the generic bytes-backed
//! reader landed in the previous commit) and served by a thin wrapper
//! that forwards every `ResourceSource` call to the inner reader.
//!
//! # Format
//!
//! HBA-of-HBAs (single file). The browser fetches one HBA bundle
//! produced by `dat2hba` from a real `portal.dat` (and optional
//! `cell_1.dat`) — the same format the native client already consumes.
//! Multi-file shard formats are a future optimization once the spike
//! proves the pre-load approach hits its memory limit.
//!
//! # Threading
//!
//! Wasm32 is single-threaded; `HttpResourceSource` wraps an
//! `HbaReader<Vec<u8>>` which is `Send + Sync`, so the wrapper
//! satisfies `ResourceSource: Send + Sync` cleanly without splitting
//! the trait. The whole crate is `cfg(target_arch = "wasm32")`-gated
//! so it's an empty rlib on native — adding it to the workspace
//! doesn't pull `web-sys` into native builds.

#![cfg(target_arch = "wasm32")]

mod manifest_source;
mod source;

pub use source::{ConnectError, HttpResourceSource};
