//! The net_worker's outbound dispatch: what the worker does with each
//! `{t:'tx', kind, bytes}` item the main-thread `RemoteSessionProxy` posts
//! (see net_worker.rs). Kept out of the wasm32-only `net_worker` module, with
//! the same `wasm32 OR test` gate as `session_liveness`, so it is unit-tested
//! natively against a real `Session`
//! (`cargo test -p holtburger-web --lib net_worker_outbound`).
//!
//! net-transport-2 (2026-10-13): adds [`TX_KIND_DISCONNECT`]. In proxy mode
//! (`?netWorker`, automatic for `?bot=1` / `?agent=1`) the worker owns the
//! transport, so `LoopSession::send_disconnect` used to send nothing and ACE
//! held the session for its 60 s timeout. It now posts this kind and the
//! worker sends the retail DISCONNECT (0x8000) on its own `Session`.

use anyhow::Result;
use holtburger_protocol::messages::GameMessage;
use holtburger_protocol::traits::ProtocolUnpack;
use holtburger_session::Session;

// ── outbound (main → worker) "kind" tags, second arg of the outbound sink ──
/// bytes = `ProtocolPack` of `GameMessage::GameAction(GameActionMessage{0, action})`.
/// Worker unpacks, extracts `.action`, calls `session.send_action` (re-sequences).
pub const TX_KIND_ACTION: u8 = 0;
/// bytes = `ProtocolPack` of a plain `GameMessage`. Worker calls `session.send_message`.
pub const TX_KIND_MESSAGE: u8 = 1;
/// bytes = none. Worker calls `session.send_disconnect` (the retail DISCONNECT
/// teardown) and then ends its wire loop, as direct mode's recv loop exits
/// after `SessionCommand::Disconnect`.
pub const TX_KIND_DISCONNECT: u8 = 2;

/// What [`apply_outbound`] did with one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundOutcome {
    /// Sent on the session; the wire loop carries on.
    Sent,
    /// The bytes did not unpack as a `GameMessage`; nothing was sent.
    Dropped,
    /// The DISCONNECT went out; the wire loop must stop.
    Disconnected,
}

/// Run one outbound item on the worker's `session`. An `Err` is a failed
/// send; for [`TX_KIND_DISCONNECT`] the caller ends the wire loop either way.
pub async fn apply_outbound(
    session: &mut Session,
    kind: u8,
    bytes: &[u8],
) -> Result<OutboundOutcome> {
    if kind == TX_KIND_DISCONNECT {
        session.send_disconnect().await?;
        return Ok(OutboundOutcome::Disconnected);
    }
    let mut offset = 0;
    let Some(message) = GameMessage::unpack(bytes, &mut offset) else {
        return Ok(OutboundOutcome::Dropped);
    };
    if kind == TX_KIND_ACTION {
        match message {
            GameMessage::GameAction(gam) => session.send_action(gam.action).await?,
            // Shouldn't happen (action kind always packs a GameAction),
            // but send it verbatim rather than silently dropping.
            other => session.send_message(&other).await?,
        }
    } else {
        session.send_message(&message).await?;
    }
    Ok(OutboundOutcome::Sent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_protocol::messages::GameAction;
    use holtburger_protocol::messages::game_action::GameActionMessage;
    use holtburger_protocol::messages::misc::actions::PingRequestActionData;
    use holtburger_protocol::messages::transport::{HEADER_SIZE, PacketHeader, packet_flags};
    use holtburger_protocol::traits::{ProtocolPack, ProtocolUnpack};
    use holtburger_session::Transport;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    type Sent = Arc<Mutex<Vec<(SocketAddr, Vec<u8>)>>>;

    /// Records every datagram the session sends (the send half of
    /// holtburger-session's test `ScriptedTransport`).
    struct RecordingTransport {
        sent: Sent,
    }

    #[async_trait::async_trait]
    impl Transport for RecordingTransport {
        async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> anyhow::Result<usize> {
            self.sent.lock().unwrap().push((addr, buf.to_vec()));
            Ok(buf.len())
        }

        async fn recv_from(&self, _buf: &mut [u8]) -> anyhow::Result<(usize, SocketAddr)> {
            Err(anyhow::anyhow!("RecordingTransport never receives"))
        }
    }

    fn server() -> SocketAddr {
        "127.0.0.1:9000".parse().unwrap()
    }

    /// A worker-side session that has completed the handshake as session id
    /// `client_id` (cleartext: no ISAAC keyed, which a DISCONNECT never uses).
    fn session_with(client_id: u16) -> (Session, Sent) {
        let sent: Sent = Arc::new(Mutex::new(Vec::new()));
        let transport = RecordingTransport {
            sent: Arc::clone(&sent),
        };
        let mut session = Session::new_with_transport(Box::new(transport), server());
        session.client_id = client_id;
        session.packet_sequence = 5;
        (session, sent)
    }

    fn header_of(packet: &[u8]) -> PacketHeader {
        let mut offset = 0;
        PacketHeader::unpack(packet, &mut offset).expect("packet header")
    }

    #[tokio::test]
    async fn disconnect_kind_sends_the_retail_disconnect() {
        let (mut session, sent) = session_with(0x0007);
        let outcome = apply_outbound(&mut session, TX_KIND_DISCONNECT, &[])
            .await
            .expect("send_disconnect");
        assert_eq!(outcome, OutboundOutcome::Disconnected);

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "exactly one packet");
        let (addr, packet) = &sent[0];
        assert_eq!(*addr, server());
        assert_eq!(packet.len(), HEADER_SIZE, "header only");
        let header = header_of(packet);
        assert_eq!(header.flags, packet_flags::DISCONNECT);
        assert_eq!(header.id, 0x0007, "the session's own id");
        assert_eq!(header.size, 0);
        assert_eq!(
            header.checksum,
            header.calculate_checksum(),
            "cleartext checksum: Hash32 of the seeded header"
        );
    }

    #[tokio::test]
    async fn disconnect_kind_ignores_any_bytes() {
        // The proxy posts none; stray bytes must not turn it into a message.
        let (mut session, sent) = session_with(0x0002);
        let outcome = apply_outbound(&mut session, TX_KIND_DISCONNECT, &[1, 2, 3, 4])
            .await
            .expect("send_disconnect");
        assert_eq!(outcome, OutboundOutcome::Disconnected);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(header_of(&sent[0].1).flags, packet_flags::DISCONNECT);
    }

    #[tokio::test]
    async fn action_kind_still_resequences_and_sends() {
        let (mut session, sent) = session_with(0x0007);
        let mut bytes = Vec::new();
        ProtocolPack::pack(
            &GameMessage::GameAction(Box::new(GameActionMessage {
                sequence: 0,
                action: GameAction::PingRequest(Box::new(PingRequestActionData)),
            })),
            &mut bytes,
        );
        let outcome = apply_outbound(&mut session, TX_KIND_ACTION, &bytes)
            .await
            .expect("send_action");
        assert_eq!(outcome, OutboundOutcome::Sent);
        assert_eq!(session.game_action_sequence, 1, "the worker's session re-sequences");

        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        let header = header_of(&sent[0].1);
        assert_ne!(header.flags & packet_flags::BLOB_FRAGMENTS, 0);
        assert_eq!(header.flags & packet_flags::DISCONNECT, 0);
        assert_eq!(header.id, 0x0007);
    }

    #[tokio::test]
    async fn message_kind_drops_bytes_that_do_not_unpack() {
        let (mut session, sent) = session_with(0x0007);
        let outcome = apply_outbound(&mut session, TX_KIND_MESSAGE, &[])
            .await
            .expect("no send attempted");
        assert_eq!(outcome, OutboundOutcome::Dropped);
        assert!(sent.lock().unwrap().is_empty());
    }

    #[test]
    fn kinds_are_distinct() {
        assert_ne!(TX_KIND_DISCONNECT, TX_KIND_ACTION);
        assert_ne!(TX_KIND_DISCONNECT, TX_KIND_MESSAGE);
        assert_ne!(TX_KIND_ACTION, TX_KIND_MESSAGE);
    }
}
