//! End the ACE session when the bridge drops a connection (net-transport-2,
//! 2026-10-13).
//!
//! ACE routes a client packet by its header Id and accepts it only from the
//! session's C2S endpoint (`NetworkManager.ProcessPacket`:
//! `session.EndPointC2S.Equals(endPoint)`). For a bridged client that
//! endpoint is the bridge's per-connection UDP socket, so once the WebSocket
//! is gone nothing else can end the session. When a connection ends for any
//! reason (WS close, a crashed or killed tab, a lost browser-to-bridge link,
//! a liveness reap) the bridge sends ACE one cleartext DISCONNECT (0x8000)
//! packet from that socket. Without it ACE keeps the session until its 60 s
//! network timeout: the character stays in the world, and a relogin inside
//! that window boots the old session and is itself rejected
//! (`AuthenticationHandler`, `account_login_boots_in_use`). The client sends
//! its own Disconnect when it can (holtburger-session `send_disconnect`); a
//! second one for a session ACE has already ended matches no live session and
//! is only logged.
//!
//! The session id comes from the S2C ConnectRequest that set the session up:
//! `CConnectHeader.NetID`, 16 bytes into its body, whose low word retail keeps
//! as the connection's id (acclient.c `ClientNet::HandleConnectionRequest`,
//! `LOWORD(pConnectHeader->m_Data.NetID)`). C2S header Ids cannot stand in for
//! it: ACE numbers sessions from 0 (`NetworkManager.FindOrCreateSession`), and
//! the LoginRequest and holtburger's ConnectResponse also carry Id 0, so a C2S
//! Id of 0 does not say whether a session exists. S2C header Ids are ACE's
//! ServerId, not the session id. A later ConnectRequest on the same socket (a
//! fresh handshake) replaces the id.
//!
//! The packet is the one holtburger-session's `send_disconnect` builds and the
//! one WebAC's bridge sends on close (after WebAC
//! services/ws-tcp-bridge/src/bridgeUtil.ts `buildDisconnectPacket`,
//! AGPL-3.0): a 20-byte header with no body, flags DISCONNECT, and checksum =
//! Hash32 of the header with 0xBADD70DD in the checksum field. ACE checks that
//! checksum and terminates on DISCONNECT before it orders packets
//! (`NetworkSession.ProcessPacket`), so sequence, time and iteration are 0. It
//! goes to the LOGIN port: ACE's world-port listener accepts only
//! ConnectResponse and CICMD.
//!
//! Like the capture's LoginRequest redaction, this reads AC header bytes but
//! never changes a relayed datagram.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

/// AC packet header size (holtburger-protocol `transport::HEADER_SIZE`),
/// restated here because the bridge does not depend on the protocol crate.
pub const AC_PACKET_HEADER_LEN: usize = 20;
/// `packet_flags::DISCONNECT`.
pub const AC_FLAG_DISCONNECT: u32 = 0x0000_8000;
/// `packet_flags::CONNECT_REQUEST`.
pub const AC_FLAG_CONNECT_REQUEST: u32 = 0x0004_0000;
/// The optional headers that come before a ConnectRequest body when present
/// (SERVER_SWITCH, REQUEST_RETRANSMIT, REJECT_RETRANSMIT, ACK_SEQUENCE, in
/// the order holtburger-session's `OptionalHeaderCursor` walks them). ACE
/// sends its ConnectRequest with none of them, so a packet carrying one is
/// not read.
pub const AC_FLAGS_BEFORE_CONNECT_REQUEST: u32 =
    0x0000_0100 | 0x0000_1000 | 0x0000_2000 | 0x0000_4000;
/// `transport::CONNECT_REQUEST_SIZE`: ServerTime f64, Cookie u64, NetID u32,
/// OutgoingSeed u32, IncomingSeed u32, padding u32.
pub const CONNECT_REQUEST_LEN: usize = 32;
/// Offset of `NetID` in the ConnectRequest body.
const CONNECT_REQUEST_NET_ID_OFFSET: usize = 16;
/// The checksum field's value while a header is hashed (`CHECKSUM_SEED`).
pub const AC_CHECKSUM_SEED: u32 = 0xBADD_70DD;
/// Bound on the single Disconnect send. A UDP send does not normally block;
/// this only keeps a wedged socket from holding the connection task.
pub const DISCONNECT_SEND_TIMEOUT: Duration = Duration::from_millis(500);

/// AC `Hash32` (holtburger-protocol `crypto::Hash32::compute`, ACE
/// `Hash32.Calculate`): the length shifted left 16, plus every whole
/// little-endian u32, plus the 1 to 3 trailing bytes placed from the top byte
/// down, all wrapping.
pub fn hash32(data: &[u8]) -> u32 {
    let mut checksum = (data.len() as u32) << 16;
    let mut words = data.chunks_exact(4);
    for w in &mut words {
        checksum = checksum.wrapping_add(u32::from_le_bytes([w[0], w[1], w[2], w[3]]));
    }
    let mut shift: u32 = 24;
    for &b in words.remainder() {
        checksum = checksum.wrapping_add(u32::from(b) << shift);
        shift -= 8;
    }
    checksum
}

/// The session id an S2C datagram assigns, when it is ACE's ConnectRequest:
/// the low word of `CConnectHeader.NetID`. `None` for every other datagram.
pub fn connect_request_session_id(datagram: &[u8]) -> Option<u16> {
    if datagram.len() < AC_PACKET_HEADER_LEN + CONNECT_REQUEST_LEN {
        return None;
    }
    let flags = u32::from_le_bytes([datagram[4], datagram[5], datagram[6], datagram[7]]);
    if flags & AC_FLAG_CONNECT_REQUEST == 0 || flags & AC_FLAGS_BEFORE_CONNECT_REQUEST != 0 {
        return None;
    }
    // The header's `size` covers everything after the header.
    let size = usize::from(u16::from_le_bytes([datagram[16], datagram[17]]));
    if size < CONNECT_REQUEST_LEN {
        return None;
    }
    let at = AC_PACKET_HEADER_LEN + CONNECT_REQUEST_NET_ID_OFFSET;
    let net_id = u32::from_le_bytes([
        datagram[at],
        datagram[at + 1],
        datagram[at + 2],
        datagram[at + 3],
    ]);
    Some(net_id as u16)
}

/// The 20-byte cleartext DISCONNECT packet for `session_id`: sequence 0,
/// flags DISCONNECT, time/size/iteration 0, checksum = Hash32 of the header
/// with [`AC_CHECKSUM_SEED`] in the checksum field (no body, so nothing is
/// added for it).
pub fn disconnect_packet(session_id: u16) -> [u8; AC_PACKET_HEADER_LEN] {
    let mut packet = [0u8; AC_PACKET_HEADER_LEN];
    packet[4..8].copy_from_slice(&AC_FLAG_DISCONNECT.to_le_bytes());
    packet[8..12].copy_from_slice(&AC_CHECKSUM_SEED.to_le_bytes());
    packet[12..14].copy_from_slice(&session_id.to_le_bytes());
    let checksum = hash32(&packet);
    packet[8..12].copy_from_slice(&checksum.to_le_bytes());
    packet
}

/// The ACE session id one connection has learned, shared by its two pumps.
#[derive(Debug)]
pub struct SessionIdSlot(AtomicU32);

impl SessionIdSlot {
    /// Stored until a ConnectRequest arrives (outside the u16 id range).
    const NONE: u32 = u32::MAX;

    pub fn new() -> Self {
        Self(AtomicU32::new(Self::NONE))
    }

    /// Note the id when `datagram` (accepted from ACE) is a ConnectRequest;
    /// the newest one wins.
    pub fn observe_s2c(&self, datagram: &[u8]) {
        if let Some(id) = connect_request_session_id(datagram) {
            self.0.store(u32::from(id), Ordering::Relaxed);
        }
    }

    /// The session id, or `None` when no ConnectRequest has been seen.
    pub fn get(&self) -> Option<u16> {
        let id = self.0.load(Ordering::Relaxed);
        if id == Self::NONE {
            None
        } else {
            Some(id as u16)
        }
    }
}

impl Default for SessionIdSlot {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge;
    use crate::config::Config;
    use crate::frame;
    use crate::handshake::{ClientHello, HANDSHAKE_VERSION, ServerHello};
    use anyhow::{Result, anyhow};
    use futures_util::{SinkExt, StreamExt};
    use holtburger_protocol::crypto::Hash32;
    use holtburger_protocol::messages::transport::{
        self, CHECKSUM_SEED, ConnectRequestData, PacketHeader, packet_flags,
    };
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
    use std::net::SocketAddr;
    use tokio::net::{TcpListener, UdpSocket};
    use tokio_tungstenite::tungstenite::Message;

    /// `packet_flags::LOGIN_REQUEST` / `BLOB_FRAGMENTS`, for the fake client.
    const AC_FLAG_LOGIN_REQUEST: u32 = 0x0001_0000;
    const AC_FLAG_BLOB_FRAGMENTS: u32 = 0x0000_0004;
    /// How long a test waits for a datagram it expects.
    const WAIT: Duration = Duration::from_secs(2);

    /// An S2C ConnectRequest (ACE `PacketOutboundConnectRequest`) assigning
    /// `net_id`. Its header Id is ACE's ServerId (0x0B here), which must not
    /// be mistaken for the session id.
    fn connect_request(net_id: u32) -> Vec<u8> {
        let mut d = vec![0u8; AC_PACKET_HEADER_LEN + CONNECT_REQUEST_LEN];
        d[4..8].copy_from_slice(&AC_FLAG_CONNECT_REQUEST.to_le_bytes());
        d[12..14].copy_from_slice(&0x000B_u16.to_le_bytes());
        d[16..18].copy_from_slice(&(CONNECT_REQUEST_LEN as u16).to_le_bytes());
        let body = AC_PACKET_HEADER_LEN;
        d[body..body + 8].copy_from_slice(&1234.5_f64.to_le_bytes()); // ServerTime
        d[body + 8..body + 16].copy_from_slice(&0x1122_3344_5566_7788_u64.to_le_bytes()); // Cookie
        d[body + 16..body + 20].copy_from_slice(&net_id.to_le_bytes()); // NetID
        d[body + 20..body + 24].copy_from_slice(&0xAAAA_AAAA_u32.to_le_bytes()); // OutgoingSeed
        d[body + 24..body + 28].copy_from_slice(&0xBBBB_BBBB_u32.to_le_bytes()); // IncomingSeed
        d
    }

    /// A C2S datagram: a 20-byte header with `flags` and header `id`, then
    /// `body`.
    fn c2s(flags: u32, id: u16, body: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; AC_PACKET_HEADER_LEN];
        d[0..4].copy_from_slice(&2_u32.to_le_bytes()); // sequence
        d[4..8].copy_from_slice(&flags.to_le_bytes());
        d[12..14].copy_from_slice(&id.to_le_bytes());
        d[16..18].copy_from_slice(&(body.len() as u16).to_le_bytes());
        d.extend_from_slice(body);
        d
    }

    #[test]
    fn constants_match_the_protocol_crate() {
        assert_eq!(AC_PACKET_HEADER_LEN, transport::HEADER_SIZE);
        assert_eq!(AC_FLAG_DISCONNECT, packet_flags::DISCONNECT);
        assert_eq!(AC_FLAG_CONNECT_REQUEST, packet_flags::CONNECT_REQUEST);
        assert_eq!(
            AC_FLAGS_BEFORE_CONNECT_REQUEST,
            packet_flags::SERVER_SWITCH
                | packet_flags::REQUEST_RETRANSMIT
                | packet_flags::REJECT_RETRANSMIT
                | packet_flags::ACK_SEQUENCE
        );
        assert_eq!(CONNECT_REQUEST_LEN, transport::CONNECT_REQUEST_SIZE);
        assert_eq!(AC_CHECKSUM_SEED, CHECKSUM_SEED);
        assert_eq!(AC_FLAG_LOGIN_REQUEST, packet_flags::LOGIN_REQUEST);
        assert_eq!(AC_FLAG_BLOB_FRAGMENTS, packet_flags::BLOB_FRAGMENTS);
    }

    #[test]
    fn hash32_matches_known_values_and_the_protocol_crate() {
        assert_eq!(hash32(&[]), 0);
        // 5 << 16, plus the word 0x04030201, plus the trailing 0x05 in the top byte.
        assert_eq!(hash32(&[1, 2, 3, 4, 5]), 0x0908_0201);
        // Three trailing bytes, and the sum wraps past u32::MAX.
        assert_eq!(hash32(&[0xFF, 0xFE, 0xFD]), 0x0001_FD00);
        for len in 0..=41_usize {
            let data: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(hash32(&data), Hash32::compute(&data), "len {len}");
        }
    }

    #[test]
    fn disconnect_packet_matches_the_clients_packet() {
        // Golden bytes for session id 7: header sum 0xBADD70DD + 0x8000 +
        // (20 << 16) + 7 = 0xBAF1F0E4.
        assert_eq!(
            disconnect_packet(7),
            [
                0, 0, 0, 0, 0x00, 0x80, 0, 0, 0xE4, 0xF0, 0xF1, 0xBA, 7, 0, 0, 0, 0, 0, 0, 0
            ]
        );
        for id in [0_u16, 7, 0x1234, u16::MAX] {
            let ours = disconnect_packet(id);
            let mut header = PacketHeader {
                flags: packet_flags::DISCONNECT,
                id,
                ..Default::default()
            };
            header.checksum = header.calculate_checksum();
            let mut theirs = Vec::new();
            header.pack(&mut theirs);
            assert_eq!(ours.as_slice(), theirs.as_slice(), "session id {id}");
        }
    }

    #[test]
    fn connect_request_session_id_reads_the_net_id() {
        assert_eq!(connect_request_session_id(&connect_request(7)), Some(7));
        assert_eq!(connect_request_session_id(&connect_request(0)), Some(0));
        // Retail keeps the low word.
        assert_eq!(connect_request_session_id(&connect_request(0x0001_0005)), Some(5));
        // Same field the client's own parser reads.
        let dg = connect_request(0x0123);
        let mut offset = AC_PACKET_HEADER_LEN;
        let parsed = ConnectRequestData::unpack(&dg, &mut offset).expect("unpack");
        assert_eq!(connect_request_session_id(&dg), Some(parsed.client_id));

        // Too short.
        let dg = connect_request(7);
        assert_eq!(connect_request_session_id(&dg[..dg.len() - 1]), None);
        // Not a ConnectRequest.
        let mut other = connect_request(7);
        other[4..8].copy_from_slice(&AC_FLAG_BLOB_FRAGMENTS.to_le_bytes());
        assert_eq!(connect_request_session_id(&other), None);
        // An optional header ahead of the body would move the NetID.
        let mut acked = connect_request(7);
        acked[4..8].copy_from_slice(
            &(AC_FLAG_CONNECT_REQUEST | packet_flags::ACK_SEQUENCE).to_le_bytes(),
        );
        assert_eq!(connect_request_session_id(&acked), None);
        // The header says the body is shorter than a ConnectRequest.
        let mut small = connect_request(7);
        small[16..18].copy_from_slice(&8_u16.to_le_bytes());
        assert_eq!(connect_request_session_id(&small), None);
        // A client LoginRequest is never one.
        let login = c2s(AC_FLAG_LOGIN_REQUEST, 0, &[0x55; 64]);
        assert_eq!(connect_request_session_id(&login), None);
    }

    #[test]
    fn session_id_slot_keeps_the_newest_connect_request() {
        let slot = SessionIdSlot::new();
        assert_eq!(slot.get(), None);
        slot.observe_s2c(&c2s(AC_FLAG_BLOB_FRAGMENTS, 0x000B, &[0; 40]));
        assert_eq!(slot.get(), None, "a game packet is not a ConnectRequest");
        slot.observe_s2c(&connect_request(7));
        assert_eq!(slot.get(), Some(7));
        slot.observe_s2c(&connect_request(0));
        assert_eq!(slot.get(), Some(0), "a new handshake replaces the id, 0 included");
        slot.observe_s2c(&c2s(AC_FLAG_BLOB_FRAGMENTS, 0x000B, &[0; 40]));
        assert_eq!(slot.get(), Some(0));
    }

    // ── end to end through the bridge ────────────────────────────────────

    type Ws = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// How the WS client goes away.
    #[derive(Clone, Copy, Debug)]
    enum Leave {
        /// A WebSocket Close frame (a page that shuts down cleanly).
        Close,
        /// The TCP connection just drops (a crashed or killed tab).
        Drop,
    }

    /// What the fake ACE saw once the client had gone.
    struct AfterLeave {
        /// The bridge's UDP socket, as ACE saw it on the LoginRequest.
        client: SocketAddr,
        /// The next datagram the login port got after the client left.
        login: Option<(Vec<u8>, SocketAddr)>,
        /// Any datagram the world port got.
        world: Option<(Vec<u8>, SocketAddr)>,
    }

    async fn start_bridge() -> Result<SocketAddr> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let cfg = Config {
            listen: addr,
            default_world_port_offset: 1,
            ws_ping_interval: None,
        };
        tokio::spawn(async move {
            let _ = bridge::accept_loop(cfg, listener).await;
        });
        Ok(addr)
    }

    async fn open_ws(bridge_addr: SocketAddr, login_port: u16, world_port: u16) -> Result<Ws> {
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{bridge_addr}/")).await?;
        let hello = ClientHello {
            v: HANDSHAKE_VERSION,
            host: "127.0.0.1".into(),
            login_port,
            world_port: Some(world_port),
        };
        ws.send(Message::Text(serde_json::to_string(&hello)?.into()))
            .await?;
        let reply = tokio::time::timeout(WAIT, ws.next())
            .await?
            .ok_or_else(|| anyhow!("ws closed before handshake reply"))??;
        let text = match reply {
            Message::Text(t) => t,
            other => anyhow::bail!("expected text handshake reply, got {other:?}"),
        };
        let server_hello: ServerHello = serde_json::from_str(&text)?;
        anyhow::ensure!(server_hello.ok, "handshake rejected: {:?}", server_hello.error);
        Ok(ws)
    }

    /// The next datagram on `sock`, or `None` after `wait`.
    async fn recv_within(sock: &UdpSocket, wait: Duration) -> Option<(Vec<u8>, SocketAddr)> {
        let mut buf = [0u8; 2048];
        match tokio::time::timeout(wait, sock.recv_from(&mut buf)).await {
            Ok(Ok((len, src))) => Some((buf[..len].to_vec(), src)),
            _ => None,
        }
    }

    /// One bridged session against a fake ACE (separate login and world
    /// sockets): the client sends a LoginRequest; when `net_id` is `Some`,
    /// ACE answers with a ConnectRequest assigning it and the client sends
    /// one game packet under that id. Then the client leaves as `leave` says,
    /// and the login port is watched for `login_wait`.
    async fn bridged_session_then_leave(
        net_id: Option<u32>,
        leave: Leave,
        login_wait: Duration,
    ) -> Result<AfterLeave> {
        let login = UdpSocket::bind("127.0.0.1:0").await?;
        let world = UdpSocket::bind("127.0.0.1:0").await?;
        let login_port = login.local_addr()?.port();
        let world_port = world.local_addr()?.port();
        let bridge_addr = start_bridge().await?;
        let mut ws = open_ws(bridge_addr, login_port, world_port).await?;

        let login_request = c2s(AC_FLAG_LOGIN_REQUEST, 0, b"account+password");
        ws.send(Message::Binary(frame::encode_frame(login_port, &login_request)?.into()))
            .await?;
        let (got, client) = recv_within(&login, WAIT)
            .await
            .ok_or_else(|| anyhow!("the LoginRequest never reached ACE"))?;
        assert_eq!(got, login_request);

        if let Some(net_id) = net_id {
            let request = connect_request(net_id);
            login.send_to(&request, client).await?;
            // The ConnectRequest reaching the client proves the bridge saw it.
            let relayed = tokio::time::timeout(WAIT, ws.next())
                .await?
                .ok_or_else(|| anyhow!("ws closed before the ConnectRequest"))??;
            let bytes = match relayed {
                Message::Binary(b) => b,
                other => anyhow::bail!("expected the binary ConnectRequest, got {other:?}"),
            };
            let (src_port, payload) = frame::decode_frame(&bytes)?;
            assert_eq!(src_port, login_port);
            assert_eq!(payload, request.as_slice());

            let game = c2s(AC_FLAG_BLOB_FRAGMENTS, net_id as u16, &[0x42; 16]);
            ws.send(Message::Binary(frame::encode_frame(login_port, &game)?.into()))
                .await?;
            let (got, _) = recv_within(&login, WAIT)
                .await
                .ok_or_else(|| anyhow!("the game packet never reached ACE"))?;
            assert_eq!(got, game);
        }

        match leave {
            Leave::Close => {
                let _ = ws.close(None).await;
            }
            Leave::Drop => drop(ws),
        }

        let login_after = recv_within(&login, login_wait).await;
        let world_after = recv_within(&world, Duration::from_millis(200)).await;
        Ok(AfterLeave {
            client,
            login: login_after,
            world: world_after,
        })
    }

    /// `packet` is the 20-byte cleartext Disconnect for session `id`.
    fn assert_disconnect(packet: &[u8], id: u16) {
        assert_eq!(packet.len(), AC_PACKET_HEADER_LEN, "header only");
        let u32_at = |o: usize| {
            u32::from_le_bytes([packet[o], packet[o + 1], packet[o + 2], packet[o + 3]])
        };
        let u16_at = |o: usize| u16::from_le_bytes([packet[o], packet[o + 1]]);
        assert_eq!(u32_at(0), 0, "sequence");
        assert_eq!(u32_at(4), packet_flags::DISCONNECT, "flags");
        assert_eq!(u16_at(12), id, "session id");
        assert_eq!((u16_at(14), u16_at(16), u16_at(18)), (0, 0, 0), "time, size, iteration");
        let mut seeded = packet.to_vec();
        seeded[8..12].copy_from_slice(&CHECKSUM_SEED.to_le_bytes());
        assert_eq!(u32_at(8), Hash32::compute(&seeded), "Hash32 over the seeded header");
        let header = PacketHeader {
            flags: packet_flags::DISCONNECT,
            id,
            ..Default::default()
        };
        assert_eq!(u32_at(8), header.calculate_checksum(), "the client's own checksum");
    }

    #[tokio::test]
    async fn bridge_disconnects_the_ace_session_when_the_client_goes() -> Result<()> {
        for leave in [Leave::Close, Leave::Drop] {
            let after = bridged_session_then_leave(Some(7), leave, WAIT).await?;
            let (packet, src) = after
                .login
                .ok_or_else(|| anyhow!("{leave:?}: ACE's login port got no Disconnect"))?;
            assert_eq!(src, after.client, "{leave:?}: sent from the session's own socket");
            assert_disconnect(&packet, 7);
            assert!(
                after.world.is_none(),
                "{leave:?}: nothing goes to the world port: {:?}",
                after.world
            );
        }
        Ok(())
    }

    /// ACE numbers sessions from 0, so the first session after an ACE start
    /// has id 0 and must still be ended.
    #[tokio::test]
    async fn bridge_disconnects_session_id_zero() -> Result<()> {
        let after = bridged_session_then_leave(Some(0), Leave::Close, WAIT).await?;
        let (packet, src) = after
            .login
            .ok_or_else(|| anyhow!("ACE's login port got no Disconnect for session 0"))?;
        assert_eq!(src, after.client);
        assert_disconnect(&packet, 0);
        Ok(())
    }

    #[tokio::test]
    async fn bridge_sends_nothing_before_a_connect_request() -> Result<()> {
        let after =
            bridged_session_then_leave(None, Leave::Close, Duration::from_millis(500)).await?;
        assert!(
            after.login.is_none(),
            "no session id was assigned, so no Disconnect: {:?}",
            after.login
        );
        assert!(after.world.is_none(), "{:?}", after.world);
        Ok(())
    }
}
