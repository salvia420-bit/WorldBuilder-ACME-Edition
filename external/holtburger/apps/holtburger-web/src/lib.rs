//! Browser-loadable WASM bundle — Phase 2 smoke test for the wasm32
//! cross-compile floor.
//!
//! This crate is the smallest possible consumer of the floor laid in
//! commits `50003ae`..`868c3ac`. It pulls in `holtburger-protocol` and
//! `holtburger-session` as dependencies (verifying both still compile
//! when bundled into a `cdylib`) and exposes three wasm-bindgen
//! functions so a plain `index.html` can prove the bundle loads and
//! executes.
//!
//! What it does **not** do, intentionally:
//!
//! - Construct a `Session`. `Session::new_with_transport` initializes
//!   `last_recv_time`/`last_send_time` from `std::time::Instant::now()`,
//!   which panics on `wasm32-unknown-unknown` (see `phase-2-wasm-spike.md`
//!   §6 / §8 step 3). The `WsTransport` work in §8 step 2 lives behind
//!   that fix.
//! - Use the WS or HTTP transports. `WsTransport` is §8 step 2;
//!   `HttpResourceSource` is §8 step 4.
//!
//! The compile-time `_assert_transport_reachable` stub below makes
//! `holtburger_session::Transport` show up in this crate's dependency
//! graph so the bundle proves the session crate cross-compiles in a
//! cdylib context, not just in a standalone `cargo check`.

use holtburger_protocol::crypto::Hash32;
use holtburger_session::Transport;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// Returns a static identification string. Smoke-tests wasm-bindgen
/// string interop and confirms the bundle was built from this crate.
#[wasm_bindgen]
pub fn build_info() -> String {
    format!(
        "holtburger-web v{} (proto + session over wasm-bindgen)",
        env!("CARGO_PKG_VERSION")
    )
}

/// AC's stateless 32-bit packet header checksum, exposed for callers
/// that want to verify the protocol crate's deterministic output from
/// JS. Smoke-tests passing a `&[u8]` from JS into wasm and a `u32`
/// back.
#[wasm_bindgen]
pub fn hash32(data: &[u8]) -> u32 {
    Hash32::compute(data)
}

// `holtburger-session::Transport` is the seam `WsTransport` will plug
// into (see §8 step 2). Force it into the bundle's symbol graph so the
// floor is verified end-to-end, not just at the dependency-graph level.
#[allow(dead_code)]
fn _assert_transport_reachable() {
    fn _check(_: &dyn Transport) {}
}
