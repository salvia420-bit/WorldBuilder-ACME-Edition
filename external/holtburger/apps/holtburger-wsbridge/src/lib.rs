//! WebSocket↔UDP bridging tooling for the holtburger AC client.
//!
//! Two binaries live in this crate, each one half of the round-trip described
//! in `ARCHITECTURE.md`:
//!
//! - `holtburger-wsbridge` (`src/main.rs`) — the **server-side** bridge. Runs in
//!   front of an ACE server. Accepts WebSocket connections (from a
//!   browser-hosted holtburger client, or from the shim below) and forwards
//!   each frame to ACE's UDP login/world ports.
//!
//! - `holtburger-wsshim`  (`src/bin/wsshim.rs`) — the **client-side** shim. Runs
//!   alongside an unmodified `holtburger-cli`. Listens on the same `(host,
//!   login_port)` / `(host, world_port)` pair the cli already dials, and
//!   forwards each datagram to a remote `holtburger-wsbridge` over WebSocket.
//!
//! Both speak the same wire format ([`frame`]): one binary WS frame per AC
//! packet, prefixed by a 2-byte big-endian port number identifying the ACE
//! port the packet is destined for (browser→bridge) or originated from
//! (bridge→browser).

pub mod bridge;
pub mod config;
pub mod frame;
pub mod handshake;
pub mod shim;

#[cfg(test)]
mod shim_smoke_test;
#[cfg(test)]
mod smoke_test;
