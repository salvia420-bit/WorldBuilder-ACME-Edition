//! WebSocket Transport for `holtburger-session` — wasm32-only.
//!
//! Plugs into [`holtburger_session::Session::new_with_transport`] so a
//! browser-hosted client can multiplex AC's two UDP ports
//! (login + world) over one upstream WebSocket to a
//! [`holtburger-wsbridge`](../../apps/holtburger-wsbridge). This is the
//! WASM mirror of the `holtburger-wsshim` binary in that crate — same
//! wire format, opposite end of the pipe.
//!
//! # Wire format
//!
//! Each AC packet rides one binary WS frame:
//!
//! ```text
//! [ port:u16 BE ][ ac_packet_bytes ... ]
//! ```
//!
//! Outbound (browser→bridge): `port` is the destination ACE port, taken
//! from the [`SocketAddr`] passed to [`send_to`]. Inbound (bridge→browser):
//! `port` is the source ACE port, used together with the configured
//! `server_ip` to synthesize the [`SocketAddr`] returned by [`recv_from`]
//! so the session's source-address allowlist (`server_source_addr` /
//! `pending_server_source_addr` in `holtburger-session`'s `receive.rs`)
//! still matches.
//!
//! # Threading
//!
//! Wasm32 is single-threaded; this crate's `Transport` impl uses the
//! `?Send` flavour of `#[async_trait]` and is therefore *not* compatible
//! with the native (Send + Sync) `Transport` trait. The whole crate is
//! `cfg(target_arch = "wasm32")`-gated so it's an empty rlib on native
//! targets — adding it to the workspace doesn't pull `web-sys` into
//! native builds.
//!
//! [`send_to`]: WsTransport
//! [`recv_from`]: WsTransport

#![cfg(target_arch = "wasm32")]

mod frame;
mod transport;

pub use transport::{ConnectError, WsTransport};
