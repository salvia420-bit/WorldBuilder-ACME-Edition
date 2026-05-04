//! Browser-loadable WASM bundle — Phase 2 smoke test for the wasm32
//! cross-compile floor.
//!
//! This crate is the smallest possible consumer of the floor laid in
//! commits `50003ae`..`868c3ac`. It pulls in `holtburger-protocol` and
//! `holtburger-session` as dependencies (verifying both still compile
//! when bundled into a `cdylib`) and exposes a few wasm-bindgen
//! functions so a plain `index.html` can prove the bundle loads and
//! executes.
//!
//! Constructing a `Session` is exercised here as of the
//! `web_time::Instant` swap (spike doc §8 step 3). The
//! `try_ws_handshake_smoke` export added with §8 step 2 wires
//! `holtburger-transport-ws::WsTransport` into
//! `Session::new_with_transport` so the dependency graph is exercised
//! at build time; a real round-trip against a live `holtburger-wsbridge`
//! is the next browser-side validation.

use holtburger_protocol::crypto::Hash32;
use holtburger_session::Session;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use std::net::{IpAddr, SocketAddr};

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

/// Constructs a `Session::new_test` and returns its initial
/// `packet_sequence` (always 1). End-to-end smoke test that the
/// `web_time::Instant` swap (§8 step 3) lets `Session::new_with_transport`
/// run on wasm32 without panicking — every previous attempt at this
/// function would have tripped `std::time::Instant::now()`.
#[wasm_bindgen]
pub fn session_smoke_test_packet_sequence() -> u32 {
    Session::new_test().packet_sequence
}

/// Open a `WsTransport` against `bridge_url`, plug it into a fresh
/// `Session::new_with_transport`, and return the session's initial
/// `packet_sequence` (always 0). On the success path this proves the
/// §8-step-2 wiring works end-to-end; on any failure path the JS
/// caller gets the error string back via the rejected Promise.
///
/// Used by browser-side validation against a live `holtburger-wsbridge`.
/// `server_ip` should be the IP literal that ACE answers on (e.g.
/// `"127.0.0.1"`), so the resulting session's source-address allowlist
/// matches what the bridge will tag inbound frames with.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn try_ws_handshake_smoke(
    bridge_url: String,
    server_ip: String,
    server_port: u16,
) -> Result<u32, JsValue> {
    let ip: IpAddr = server_ip
        .parse()
        .map_err(|e| JsValue::from_str(&format!("server_ip: {e}")))?;
    let transport = holtburger_transport_ws::WsTransport::connect(&bridge_url, ip)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let session = Session::new_with_transport(Box::new(transport), SocketAddr::new(ip, server_port));
    Ok(session.packet_sequence)
}

/// Fetch an HBA bundle from `asset_url`, parse it, and return the
/// length of the named entry. End-to-end smoke for the §8-step-4
/// `HttpResourceSource` wiring: a green run proves
/// `fetch()` → `Vec<u8>` → `HbaReader::<Vec<u8>>::from_bytes` →
/// `ResourceSource::get_file_by_key` works inside the wasm bundle.
///
/// Returns the length (in decompressed bytes) of the named entry. The
/// caller checks that against the known fixture content (e.g.
/// `dats/assets.hba`'s `eor/portal:0x0E000004` is 5876 bytes when
/// produced by `dat2hba --profile micro` from the canonical
/// portal.dat). Any failure path — fetch, HTTP status, parse, missing
/// key — surfaces as a rejected Promise with the error string.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn try_http_resource_source_smoke(
    asset_url: String,
    namespace: String,
    file_id: u32,
) -> Result<u32, JsValue> {
    use holtburger_dat::{ResourceKey, ResourceSource};
    let source = holtburger_resource_http::HttpResourceSource::connect(&asset_url)
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bytes = source
        .get_file_by_key(ResourceKey::new(&namespace, file_id))
        .map_err(|e| JsValue::from_str(&format!("get_file_by_key: {e}")))?;
    Ok(bytes.len() as u32)
}
