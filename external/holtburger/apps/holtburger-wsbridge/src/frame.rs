//! WebSocket frame ↔ UDP datagram codec.
//!
//! Wire format (see ARCHITECTURE.md):
//! ```text
//! [ port:u16 BE ][ ac_packet_bytes ... ]
//! ```
//!
//! Outbound (browser→bridge): `port` is the destination ACE port.
//! Inbound  (bridge→browser): `port` is the source ACE port.

use anyhow::{Result, anyhow};

pub const PORT_PREFIX_LEN: usize = 2;

/// Maximum AC packet size we'll relay. AC's wire MTU is well under 1500;
/// this cap keeps a misframed jumbo from chewing memory.
pub const MAX_PACKET_BYTES: usize = 4096;

/// Split a received WS binary frame into `(port, payload)`.
///
/// Returns an error if the frame is too short to carry a port, or if the
/// payload exceeds [`MAX_PACKET_BYTES`].
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

/// Write a WS binary frame `[port:u16 BE][payload]` into `out`, reusing its
/// existing allocation capacity when large enough.
pub fn encode_frame_into(port: u16, payload: &[u8], out: &mut Vec<u8>) -> Result<()> {
    if payload.len() > MAX_PACKET_BYTES {
        return Err(anyhow!(
            "udp datagram {} bytes exceeds MAX_PACKET_BYTES={}",
            payload.len(),
            MAX_PACKET_BYTES
        ));
    }
    out.clear();
    out.reserve(PORT_PREFIX_LEN + payload.len());
    out.extend_from_slice(&port.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(())
}

/// Build a WS binary frame from `(port, payload)`.
pub fn encode_frame(port: u16, payload: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(PORT_PREFIX_LEN + payload.len());
    encode_frame_into(port, payload, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_typical_packet() {
        let body = b"\x01\x02\x03ACE-PACKET-BODY";
        let frame = encode_frame(9001, body).unwrap();
        let (port, payload) = decode_frame(&frame).unwrap();
        assert_eq!(port, 9001);
        assert_eq!(payload, body);
    }

    #[test]
    fn round_trips_zero_length_payload() {
        // Holtburger's heartbeat-ish frames can be tiny. A zero-length AC packet
        // is unusual but the frame protocol shouldn't reject it — only the
        // peer's protocol layer decides if it's meaningful.
        let frame = encode_frame(9000, &[]).unwrap();
        let (port, payload) = decode_frame(&frame).unwrap();
        assert_eq!(port, 9000);
        assert!(payload.is_empty());
    }

    #[test]
    fn rejects_frame_too_short_for_port() {
        assert!(decode_frame(&[]).is_err());
        assert!(decode_frame(&[0x23]).is_err());
    }

    #[test]
    fn rejects_oversized_payload() {
        let huge = vec![0u8; MAX_PACKET_BYTES + 1];
        assert!(encode_frame(9000, &huge).is_err());

        let mut frame = vec![0u8, 0u8];
        frame.extend_from_slice(&huge);
        assert!(decode_frame(&frame).is_err());
    }

    #[test]
    fn port_is_big_endian() {
        // 9001 = 0x2329. Catches a bug where someone "helpfully" swaps to LE.
        let frame = encode_frame(9001, b"x").unwrap();
        assert_eq!(frame[0], 0x23);
        assert_eq!(frame[1], 0x29);
    }

    #[test]
    fn encode_frame_into_reuses_and_overwrites_vec() {
        let mut scratch = Vec::with_capacity(256);
        let init_cap = scratch.capacity();
        encode_frame_into(9001, b"first-packet", &mut scratch).unwrap();
        assert_eq!(decode_frame(&scratch).unwrap(), (9001, &b"first-packet"[..]));
        encode_frame_into(9000, b"xy", &mut scratch).unwrap();
        assert_eq!(decode_frame(&scratch).unwrap(), (9000, &b"xy"[..]));
        assert_eq!(scratch.capacity(), init_cap);
    }
}
