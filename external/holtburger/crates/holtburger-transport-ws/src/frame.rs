//! WS frame ↔ AC datagram codec (browser side).
//!
//! Duplicated from
//! [`holtburger-wsbridge::frame`](../../../../apps/holtburger-wsbridge/src/frame.rs)
//! rather than depended on, because that crate is native-only (pulls
//! `tokio` with the `net` feature) and dragging it into the wasm32
//! build would re-introduce the `mio` blocker the Phase 2 floor work
//! split out. Keep this file in sync with that one — they are the two
//! ends of the same pipe.

use anyhow::{Result, anyhow};

pub const PORT_PREFIX_LEN: usize = 2;

/// Maximum AC packet size we'll relay. AC's wire MTU is well under 1500;
/// this cap keeps a misframed jumbo from chewing memory.
pub const MAX_PACKET_BYTES: usize = 4096;

pub fn decode_frame(buf: &[u8]) -> Result<(u16, &[u8])> {
    if buf.len() < PORT_PREFIX_LEN {
        return Err(anyhow!(
            "ws frame too short: {} bytes (need at least {} for port prefix)",
            buf.len(),
            PORT_PREFIX_LEN
        ));
    }
    let port = u16::from_be_bytes([buf[0], buf[1]]);
    let payload = &buf[PORT_PREFIX_LEN..];
    if payload.len() > MAX_PACKET_BYTES {
        return Err(anyhow!(
            "ws frame payload {} bytes exceeds MAX_PACKET_BYTES={}",
            payload.len(),
            MAX_PACKET_BYTES
        ));
    }
    Ok((port, payload))
}

pub fn encode_frame(port: u16, payload: &[u8]) -> Result<Vec<u8>> {
    if payload.len() > MAX_PACKET_BYTES {
        return Err(anyhow!(
            "udp datagram {} bytes exceeds MAX_PACKET_BYTES={}",
            payload.len(),
            MAX_PACKET_BYTES
        ));
    }
    let mut out = Vec::with_capacity(PORT_PREFIX_LEN + payload.len());
    out.extend_from_slice(&port.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}
