//! Opt-in pcap capture of the datagrams the bridge relays (test-tooling-4).
//!
//! `holtburger-wsbridge --capture <FILE.pcap>` (or [`CAPTURE_ENV`]
//! `HB_BRIDGE_CAPTURE=<FILE.pcap>`; the flag wins) appends every UDP datagram
//! the bridge exchanges with ACE — client→server as it is sent, server→client
//! as it is accepted — to a classic pcap file. It is the sudo-free
//! counterpart of `tcpdump -i lo 'udp port 9000 or udp port 9001'` (the idea
//! behind WebAC's `BRIDGE_CAPTURE`): the bridge already sits on the UDP leg,
//! so a protocol replay corpus can be recorded from any session it carries,
//! browser or shim.
//!
//! Format: classic pcap (magic `a1b2c3d4`, microsecond timestamps, written
//! little-endian), `LINKTYPE_RAW` (101). Each record is a synthetic IPv4 +
//! UDP header carrying the real addresses and ports, then the AC datagram
//! verbatim, so `holtburger-tools`' `pcap2jsonl` (`oracle_pcap`) and
//! Wireshark read it unchanged. The client side of a record is the bridge's
//! own per-connection UDP socket — the address ACE sees (its IP is `0.0.0.0`
//! when that socket is bound unspecified) — so concurrent connections are
//! told apart by their ephemeral port.
//!
//! Credentials: an AC `LoginRequest` packet carries the account name and
//! password in clear. Apart from this redaction, the bridge reads AC headers
//! only to learn the session id for its teardown Disconnect (`disconnect.rs`),
//! and it never alters a relayed datagram. Before
//! writing a client→server datagram whose packet-header flags carry
//! `LOGIN_REQUEST` it zeroes everything after the 20-byte packet header
//! (length kept). That packet holds no message fragments, so a replay decode
//! loses nothing. Everything else (character names, chat) is recorded as
//! sent — use a throwaway account for a capture meant to be committed.
//!
//! Default OFF: without the flag or env var the bridge never constructs a
//! [`PcapCapture`] and relays exactly as before. A write failure is logged
//! once and disables the capture; it never affects relaying.

use std::borrow::Cow;
use std::ffi::OsString;
use std::fs::File;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Environment-variable equivalent of `--capture <FILE.pcap>`.
pub const CAPTURE_ENV: &str = "HB_BRIDGE_CAPTURE";

/// Classic-pcap magic for microsecond timestamps (written little-endian).
pub const PCAP_MAGIC_US: u32 = 0xa1b2_c3d4;
/// `LINKTYPE_RAW`: every record is a bare IPv4 packet, no link header.
pub const LINKTYPE_RAW: u32 = 101;
/// Global-header snaplen. Records are never truncated (AC datagrams are far
/// below it, and the bridge caps them at `frame::MAX_PACKET_BYTES`).
const SNAPLEN: u32 = 65_535;
pub const PCAP_GLOBAL_HEADER_LEN: usize = 24;
pub const PCAP_RECORD_HEADER_LEN: usize = 16;
pub const IPV4_HEADER_LEN: usize = 20;
pub const UDP_HEADER_LEN: usize = 8;

/// AC packet header size and the `LOGIN_REQUEST` flag in its u32 `flags`
/// (bytes 4..8, little-endian) — holtburger-protocol `transport::HEADER_SIZE`
/// / `packet_flags::LOGIN_REQUEST`, restated here because the bridge does not
/// depend on the protocol crate.
const AC_PACKET_HEADER_LEN: usize = 20;
const AC_FLAG_LOGIN_REQUEST: u32 = 0x0001_0000;

/// Which way a captured datagram travelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Browser/shim → bridge → ACE (the bridge's `send_to`).
    ToServer,
    /// ACE → bridge → browser/shim (the bridge's accepted `recv_from`).
    ToClient,
}

/// The capture path from `--capture` and the [`CAPTURE_ENV`] value: the flag
/// wins, an empty env value counts as unset, neither means no capture.
pub fn resolve_capture_path(flag: Option<PathBuf>, env: Option<OsString>) -> Option<PathBuf> {
    flag.or_else(|| env.filter(|v| !v.is_empty()).map(PathBuf::from))
}

/// The 24-byte classic-pcap global header (LE, microseconds, `LINKTYPE_RAW`).
pub fn global_header() -> [u8; PCAP_GLOBAL_HEADER_LEN] {
    let mut h = [0u8; PCAP_GLOBAL_HEADER_LEN];
    h[0..4].copy_from_slice(&PCAP_MAGIC_US.to_le_bytes());
    h[4..6].copy_from_slice(&2u16.to_le_bytes()); // version major
    h[6..8].copy_from_slice(&4u16.to_le_bytes()); // version minor
    // thiszone (i32) and sigfigs (u32) stay 0.
    h[16..20].copy_from_slice(&SNAPLEN.to_le_bytes());
    h[20..24].copy_from_slice(&LINKTYPE_RAW.to_le_bytes());
    h
}

/// IPv4 address for the synthetic header. ACE speaks IPv4 and the handshake
/// resolver prefers it; an IPv6 peer is written as its mapped IPv4 address,
/// else `0.0.0.0` (the ports, which the replay keys on, stay real).
fn ipv4_of(ip: IpAddr) -> Ipv4Addr {
    match ip {
        IpAddr::V4(v4) => v4,
        IpAddr::V6(v6) => v6.to_ipv4_mapped().unwrap_or(Ipv4Addr::UNSPECIFIED),
    }
}

/// RFC 791 header checksum (one's-complement sum of 16-bit words, with the
/// checksum field zero while summing).
fn ipv4_checksum(header: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    for pair in header.chunks(2) {
        let word = u16::from_be_bytes([pair[0], *pair.get(1).unwrap_or(&0)]);
        sum += u32::from(word);
    }
    while sum > 0xFFFF {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

/// `payload` with a client→server `LoginRequest` packet's body zeroed (see
/// the module note); every other datagram is borrowed unchanged.
pub fn redact_for_capture(direction: Direction, payload: &[u8]) -> Cow<'_, [u8]> {
    if direction != Direction::ToServer || payload.len() <= AC_PACKET_HEADER_LEN {
        return Cow::Borrowed(payload);
    }
    let flags = u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
    if flags & AC_FLAG_LOGIN_REQUEST == 0 {
        return Cow::Borrowed(payload);
    }
    let mut out = payload.to_vec();
    out[AC_PACKET_HEADER_LEN..].fill(0);
    Cow::Owned(out)
}

/// One pcap record (16-byte record header + IPv4 + UDP + payload) for a
/// datagram from `src` to `dst` at `ts`, or `None` when the payload cannot
/// fit one IPv4 packet.
pub fn encode_record(
    ts: SystemTime,
    src: SocketAddr,
    dst: SocketAddr,
    payload: &[u8],
) -> Option<Vec<u8>> {
    let udp_len = UDP_HEADER_LEN + payload.len();
    let ip_len = IPV4_HEADER_LEN + udp_len;
    let ip_len_u16 = u16::try_from(ip_len).ok()?;
    let udp_len_u16 = u16::try_from(udp_len).ok()?;
    let since = ts.duration_since(UNIX_EPOCH).unwrap_or_default();

    let mut rec = Vec::with_capacity(PCAP_RECORD_HEADER_LEN + ip_len);
    rec.extend_from_slice(&(since.as_secs() as u32).to_le_bytes());
    rec.extend_from_slice(&since.subsec_micros().to_le_bytes());
    rec.extend_from_slice(&(ip_len as u32).to_le_bytes()); // incl_len
    rec.extend_from_slice(&(ip_len as u32).to_le_bytes()); // orig_len

    let mut ip = [0u8; IPV4_HEADER_LEN];
    ip[0] = 0x45; // version 4, IHL 5 (no options)
    ip[2..4].copy_from_slice(&ip_len_u16.to_be_bytes());
    // id 0, flags/fragment offset 0: never fragmented.
    ip[8] = 64; // TTL
    ip[9] = 17; // UDP
    ip[12..16].copy_from_slice(&ipv4_of(src.ip()).octets());
    ip[16..20].copy_from_slice(&ipv4_of(dst.ip()).octets());
    let csum = ipv4_checksum(&ip);
    ip[10..12].copy_from_slice(&csum.to_be_bytes());
    rec.extend_from_slice(&ip);

    rec.extend_from_slice(&src.port().to_be_bytes());
    rec.extend_from_slice(&dst.port().to_be_bytes());
    rec.extend_from_slice(&udp_len_u16.to_be_bytes());
    rec.extend_from_slice(&0u16.to_be_bytes()); // UDP checksum: none (legal over IPv4)
    rec.extend_from_slice(payload);
    Some(rec)
}

/// An open capture file shared by every connection's two pumps.
///
/// Each record is built in memory and written with one `write_all` under the
/// lock (unbuffered, so the file is valid at every record boundary even if
/// the bridge is killed). These are small blocking writes on the async pumps;
/// acceptable for an opt-in diagnostics path.
#[derive(Debug)]
pub struct PcapCapture {
    path: PathBuf,
    file: Mutex<File>,
    failed: AtomicBool,
    records: AtomicU64,
}

impl PcapCapture {
    /// Create (truncate) `path` and write the global header.
    pub fn create(path: &Path) -> std::io::Result<Self> {
        let mut file = File::create(path)?;
        file.write_all(&global_header())?;
        Ok(Self {
            path: path.to_path_buf(),
            file: Mutex::new(file),
            failed: AtomicBool::new(false),
            records: AtomicU64::new(0),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records written so far.
    pub fn records(&self) -> u64 {
        self.records.load(Ordering::Relaxed)
    }

    /// Append one relayed datagram. Never fails the caller: an error is
    /// logged once and switches the capture off.
    pub fn record(&self, direction: Direction, src: SocketAddr, dst: SocketAddr, payload: &[u8]) {
        if self.failed.load(Ordering::Relaxed) {
            return;
        }
        let payload = redact_for_capture(direction, payload);
        let Some(rec) = encode_record(SystemTime::now(), src, dst, &payload) else {
            log::debug!(
                "capture: skipping a {}-byte datagram {src} -> {dst} (exceeds one IPv4 packet)",
                payload.len()
            );
            return;
        };
        let res = {
            let mut file = self.file.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            file.write_all(&rec)
        };
        match res {
            Ok(()) => {
                self.records.fetch_add(1, Ordering::Relaxed);
            }
            Err(err) => {
                if !self.failed.swap(true, Ordering::Relaxed) {
                    log::warn!(
                        "capture: write to {} failed; capture disabled, relaying continues: {err}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One record read back from a capture file, parsed the way
    /// holtburger-tools' `oracle_pcap` (`PcapReader` + `parse_udp` on
    /// `DLT_RAW`) reads it.
    #[derive(Debug)]
    struct ReadBack {
        src: SocketAddr,
        dst: SocketAddr,
        payload: Vec<u8>,
    }

    /// Minimal classic-pcap reader for the round-trip tests: checks the
    /// global header, then each record's IPv4/UDP framing and checksum.
    fn read_capture(bytes: &[u8]) -> Vec<ReadBack> {
        assert!(bytes.len() >= PCAP_GLOBAL_HEADER_LEN, "global header present");
        let u32_le = |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
        assert_eq!(u32_le(bytes, 0), PCAP_MAGIC_US, "LE microsecond magic");
        assert_eq!(u32_le(bytes, 20), LINKTYPE_RAW, "LINKTYPE_RAW");
        let mut out = Vec::new();
        let mut off = PCAP_GLOBAL_HEADER_LEN;
        while off < bytes.len() {
            assert!(off + PCAP_RECORD_HEADER_LEN <= bytes.len(), "whole record header");
            let incl = u32_le(bytes, off + 8) as usize;
            assert_eq!(incl, u32_le(bytes, off + 12) as usize, "never truncated");
            let data = &bytes[off + PCAP_RECORD_HEADER_LEN..off + PCAP_RECORD_HEADER_LEN + incl];
            off += PCAP_RECORD_HEADER_LEN + incl;

            assert_eq!(data[0], 0x45, "IPv4, IHL 5");
            assert_eq!(data[9], 17, "UDP");
            assert_eq!(u16::from_be_bytes([data[6], data[7]]) & 0x1fff, 0, "not fragmented");
            assert_eq!(u16::from_be_bytes([data[2], data[3]]) as usize, incl, "IP total length");
            assert_eq!(ipv4_checksum(&data[..IPV4_HEADER_LEN]), 0, "IPv4 checksum verifies");
            let src_ip = Ipv4Addr::new(data[12], data[13], data[14], data[15]);
            let dst_ip = Ipv4Addr::new(data[16], data[17], data[18], data[19]);
            let udp = &data[IPV4_HEADER_LEN..];
            let src_port = u16::from_be_bytes([udp[0], udp[1]]);
            let dst_port = u16::from_be_bytes([udp[2], udp[3]]);
            let udp_len = u16::from_be_bytes([udp[4], udp[5]]) as usize;
            assert_eq!(udp_len, udp.len(), "UDP length");
            out.push(ReadBack {
                src: SocketAddr::new(IpAddr::V4(src_ip), src_port),
                dst: SocketAddr::new(IpAddr::V4(dst_ip), dst_port),
                payload: udp[UDP_HEADER_LEN..].to_vec(),
            });
        }
        out
    }

    fn temp_capture_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hb-wsbridge-capture-{tag}-{}-{}.pcap",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    /// A fake AC datagram: 20-byte packet header with `flags`, then `body`.
    fn ac_datagram(flags: u32, body: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; AC_PACKET_HEADER_LEN];
        d[0..4].copy_from_slice(&7u32.to_le_bytes()); // sequence
        d[4..8].copy_from_slice(&flags.to_le_bytes());
        d[16..18].copy_from_slice(&(body.len() as u16).to_le_bytes()); // size
        d.extend_from_slice(body);
        d
    }

    #[test]
    fn capture_round_trips_two_datagrams() {
        let path = temp_capture_path("roundtrip");
        let client: SocketAddr = "0.0.0.0:50123".parse().unwrap();
        let login: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        let world: SocketAddr = "127.0.0.1:9001".parse().unwrap();
        // BLOB_FRAGMENTS (0x4) — an ordinary game packet each way.
        let up = ac_datagram(0x0000_0004, b"client->server bytes");
        let down = ac_datagram(0x0000_0004, &[0xAB; 300]);
        {
            let cap = PcapCapture::create(&path).expect("create capture");
            cap.record(Direction::ToServer, client, login, &up);
            cap.record(Direction::ToClient, world, client, &down);
            assert_eq!(cap.records(), 2);
            assert_eq!(cap.path(), path.as_path());
        }
        let bytes = std::fs::read(&path).expect("read capture back");
        let _ = std::fs::remove_file(&path);

        let recs = read_capture(&bytes);
        assert_eq!(recs.len(), 2);
        assert_eq!((recs[0].src, recs[0].dst), (client, login));
        assert_eq!(recs[0].payload, up, "client->server bytes verbatim");
        assert_eq!((recs[1].src, recs[1].dst), (world, client));
        assert_eq!(recs[1].payload, down, "server->client bytes verbatim");
    }

    #[test]
    fn capture_redacts_login_request_body_only_client_to_server() {
        let secret = b"\x07\x00account\x08\x00hunter22";
        let login = ac_datagram(AC_FLAG_LOGIN_REQUEST, secret);
        let redacted = redact_for_capture(Direction::ToServer, &login);
        assert_eq!(redacted.len(), login.len(), "length kept");
        assert_eq!(&redacted[..AC_PACKET_HEADER_LEN], &login[..AC_PACKET_HEADER_LEN], "header kept");
        assert!(redacted[AC_PACKET_HEADER_LEN..].iter().all(|&b| b == 0), "body zeroed");
        // Other packets, and the server->client direction, pass through.
        let game = ac_datagram(0x0000_0004, secret);
        assert!(matches!(redact_for_capture(Direction::ToServer, &game), Cow::Borrowed(_)));
        assert!(matches!(redact_for_capture(Direction::ToClient, &login), Cow::Borrowed(_)));
        // A runt shorter than a packet header is left alone.
        assert!(matches!(redact_for_capture(Direction::ToServer, &[1, 2, 3]), Cow::Borrowed(_)));

        // ...and the redaction is what lands in the file.
        let path = temp_capture_path("redact");
        let client: SocketAddr = "0.0.0.0:50124".parse().unwrap();
        let server: SocketAddr = "127.0.0.1:9000".parse().unwrap();
        {
            let cap = PcapCapture::create(&path).expect("create capture");
            cap.record(Direction::ToServer, client, server, &login);
        }
        let bytes = std::fs::read(&path).expect("read capture back");
        let _ = std::fs::remove_file(&path);
        let recs = read_capture(&bytes);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].payload, redacted.into_owned());
        assert!(
            !bytes.windows(8).any(|w| w == b"hunter22"),
            "the password never reaches the file"
        );
    }

    #[test]
    fn capture_path_flag_wins_and_empty_env_is_unset() {
        let flag = Some(PathBuf::from("flag.pcap"));
        let env = Some(OsString::from("env.pcap"));
        assert_eq!(resolve_capture_path(flag.clone(), env.clone()), flag);
        assert_eq!(resolve_capture_path(None, env), Some(PathBuf::from("env.pcap")));
        assert_eq!(resolve_capture_path(None, Some(OsString::new())), None);
        assert_eq!(resolve_capture_path(None, None), None);
    }

    #[test]
    fn encode_record_rejects_oversized_and_maps_ipv6() {
        let a: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert!(encode_record(UNIX_EPOCH, a, a, &vec![0u8; 70_000]).is_none());
        let v6: SocketAddr = "[::ffff:10.0.0.7]:9000".parse().unwrap();
        let rec = encode_record(UNIX_EPOCH, v6, a, b"x").unwrap();
        let ip = &rec[PCAP_RECORD_HEADER_LEN..];
        assert_eq!(&ip[12..16], &[10, 0, 0, 7]);
    }

    /// End to end: a WS client's datagram relayed to a fake ACE port and its
    /// echo relayed back both land in the capture, in wire order, with the
    /// real ports and bytes.
    #[tokio::test]
    async fn bridge_captures_relayed_datagrams() -> anyhow::Result<()> {
        use crate::bridge;
        use crate::config::Config;
        use crate::frame;
        use crate::handshake::{ClientHello, HANDSHAKE_VERSION, ServerHello};
        use futures_util::{SinkExt, StreamExt};
        use std::sync::Arc;
        use std::time::Duration;
        use tokio::net::{TcpListener, UdpSocket};
        use tokio_tungstenite::tungstenite::Message;

        // Fake ACE login port: echoes each datagram back behind a 0xAA tag.
        let ace = UdpSocket::bind("127.0.0.1:0").await?;
        let login_port = ace.local_addr()?.port();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            while let Ok((len, src)) = ace.recv_from(&mut buf).await {
                let mut reply = vec![0xAA];
                reply.extend_from_slice(&buf[..len]);
                if ace.send_to(&reply, src).await.is_err() {
                    return;
                }
            }
        });

        let path = temp_capture_path("bridge");
        let capture = Arc::new(PcapCapture::create(&path)?);
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let bridge_addr = listener.local_addr()?;
        let cfg = Config {
            listen: bridge_addr,
            default_world_port_offset: 1,
            ws_ping_interval: None,
        };
        let bridge_capture = Some(Arc::clone(&capture));
        tokio::spawn(async move {
            let _ = bridge::accept_loop_with_capture(cfg, listener, bridge_capture).await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{bridge_addr}/")).await?;
        let hello = ClientHello {
            v: HANDSHAKE_VERSION,
            host: "127.0.0.1".into(),
            login_port,
            // Any port other than login_port; nothing is sent there.
            world_port: Some(login_port ^ 1),
        };
        ws.send(Message::Text(serde_json::to_string(&hello)?.into()))
            .await?;
        let reply = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("ws closed before handshake reply"))??;
        let text = match reply {
            Message::Text(t) => t,
            other => anyhow::bail!("expected text handshake reply, got {other:?}"),
        };
        let server_hello: ServerHello = serde_json::from_str(&text)?;
        assert!(server_hello.ok, "handshake rejected: {:?}", server_hello.error);

        let up = ac_datagram(0x0000_0004, b"capture-e2e");
        ws.send(Message::Binary(frame::encode_frame(login_port, &up)?.into()))
            .await?;
        let echoed = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("ws closed before echo"))??;
        let bytes = match echoed {
            Message::Binary(b) => b,
            other => anyhow::bail!("expected binary echo, got {other:?}"),
        };
        let (src_port, down) = frame::decode_frame(&bytes)?;
        assert_eq!(src_port, login_port);
        let down = down.to_vec();
        ws.close(None).await.ok();

        // The client->server leg is recorded before `send_to` and the
        // server->client leg before the WS send, so both are on disk by now.
        let file = std::fs::read(&path)?;
        let _ = std::fs::remove_file(&path);
        let recs = read_capture(&file);
        assert_eq!(recs.len(), 2, "one datagram each way");
        assert_eq!(capture.records(), 2);
        let ace_addr = SocketAddr::from(([127, 0, 0, 1], login_port));
        assert_eq!(recs[0].dst, ace_addr);
        assert_eq!(recs[0].payload, up);
        assert_eq!(recs[1].src, ace_addr);
        assert_eq!(recs[1].payload, down);
        // The client side is the bridge's per-connection UDP socket on both legs.
        assert_eq!(recs[0].src, recs[1].dst);
        assert_ne!(recs[0].src.port(), 0);
        Ok(())
    }
}
