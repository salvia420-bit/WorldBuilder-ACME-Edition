use super::types::{
    CONNECT_RESPONSE_RESEND_INTERVAL, ConnectResponseResend, DEFAULT_LOGIN_PROTOCOL_VERSION,
    Session,
};
use anyhow::{Result, anyhow};
use holtburger_protocol::crypto::Isaac;
use holtburger_protocol::messages::transport::{self, packet_flags};
use holtburger_protocol::messages::utils::build_login_payload;
use holtburger_protocol::messages::*;
use std::time::Duration;
use web_time::Instant;

impl Session {
    /// Sends the LoginRequest exactly once, on purpose. net-transport-3
    /// (2026-10-13): retail re-sends it every 2 s, up to 20 times, until the
    /// ConnectRequest arrives (`ClientNet::LogonUseTime`, acclient.c:372262).
    /// Against ACE a second LoginRequest while the first DoLogin is still
    /// running ends in a bad-handshake abort or boots the session itself
    /// (AuthenticationHandler.cs DoLogin, NetworkManager.cs "Bad handshake"),
    /// and a slow server is exactly when it would fire. A login that is lost
    /// outright is recovered with a fresh session (the JS auto-login
    /// `connectTimeout`).
    pub async fn send_login_request(&mut self, account_name: &str, password: &str) -> Result<()> {
        self.send_login_request_with_version(account_name, password, DEFAULT_LOGIN_PROTOCOL_VERSION)
            .await
    }

    pub async fn send_login_request_with_version(
        &mut self,
        account_name: &str,
        password: &str,
        client_version: &str,
    ) -> Result<()> {
        log::debug!(">>> Sending Login Request for account {}", account_name);
        let sequence = self.packet_sequence;
        let header = PacketHeader {
            flags: packet_flags::LOGIN_REQUEST,
            sequence,
            ..Default::default()
        };
        let payload = build_login_payload(account_name, password, sequence, client_version);
        self.packet_sequence += 1;
        self.send_packet(header, &payload).await
    }

    /// Handle the server's ConnectRequest: key both ISAAC streams and queue
    /// the ConnectResponse. Returns the server time the request carries, or
    /// `None` for an ignored duplicate.
    pub fn handle_handshake_request(&mut self, crd: ConnectRequestData) -> Result<Option<f64>> {
        log::debug!("<<< Handshake Request (Incoming): {:?}", crd);
        // net-transport-3 (2026-10-13): a second copy of the ConnectRequest
        // that keyed this session (a duplicated datagram) used to re-key both
        // ISAAC streams and reset `packet_sequence` to 2 mid-session, which
        // desynchronised every later packet. ACE gives the ConnectRequest
        // sequence 0, so ordering never filters it out. Retail drops a
        // ConnectRequest whose iteration matches the live connection
        // (`ClientNet::HandleConnectionRequest`); WebAC compares the cookie,
        // as here. A new cookie is still handled as a fresh handshake.
        if self.isaac_c2s.is_some() && crd.cookie == self.connection_cookie {
            log::debug!(
                "Ignoring duplicate ConnectRequest (cookie {:016X}): session already keyed",
                crd.cookie
            );
            return Ok(None);
        }

        self.connection_cookie = crd.cookie;
        self.client_id = crd.client_id;
        self.isaac_c2s = Some(Isaac::new(crd.client_seed));
        self.isaac_s2c = Some(Isaac::new(crd.server_seed));
        self.packet_sequence = 2;

        let activation_port =
            self.server_addr.port().checked_add(1).ok_or_else(|| {
                anyhow!("server activation port overflow for {}", self.server_addr)
            })?;
        let mut activation_addr = self.server_addr;
        activation_addr.set_port(activation_port);
        self.pending_server_source_addr = Some(activation_addr);

        let resp_header = PacketHeader {
            flags: packet_flags::CONNECT_RESPONSE,
            sequence: 1,
            id: 0,
            size: transport::CONNECT_RESPONSE_SIZE as u16,
            ..Default::default()
        };
        let payload = self.connection_cookie.to_le_bytes();
        let first_send_at =
            Instant::now() + Duration::from_millis(transport::ACE_HANDSHAKE_RACE_DELAY_MS);

        self.queue_packet_to_addr(
            resp_header.clone(),
            &payload,
            activation_addr,
            first_send_at,
        )?;

        // net-transport-3: the 200 ms first send is only a guess at how long
        // ACE's DoLogin takes, and a ConnectResponse that beats it is lost.
        // Keep it for the timer-driven re-send until the server answers.
        self.connect_response_resend = Some(ConnectResponseResend {
            header: resp_header,
            cookie: self.connection_cookie,
            addr: activation_addr,
            next_resend_at: first_send_at + CONNECT_RESPONSE_RESEND_INTERVAL,
        });

        Ok(Some(crd.time))
    }

    /// net-transport-3: when the next ConnectResponse re-send is due; `None`
    /// before the handshake and once the server has answered it.
    pub(crate) fn next_handshake_deadline(&self) -> Option<Instant> {
        self.connect_response_resend
            .as_ref()
            .map(|resend| resend.next_resend_at)
    }

    /// net-transport-3 (2026-10-13): queue the ConnectResponse again when it
    /// is due, as retail does every 1/3 s while in `cs_ConnectionRequestAcked`
    /// (`ClientNet::ProcessConnection`, acclient.c:372867). ACE matches a
    /// ConnectResponse only once DoLogin has set `AuthConnectResponse`
    /// (NetworkManager.cs:61-79) and silently drops an earlier one, and
    /// DoLogin runs BCrypt and a synchronous `UpdateLastLogin` before that,
    /// so the 200 ms first send can lose the race on a slow server. A copy
    /// that lands after ACE has connected matches no session and is dropped,
    /// so the extra sends are harmless. `Ok(true)` when one was queued.
    pub(crate) fn resend_connect_response_if_due(&mut self) -> Result<bool> {
        let Some(resend) = self.connect_response_resend.as_ref() else {
            return Ok(false);
        };
        let now = Instant::now();
        if now < resend.next_resend_at {
            return Ok(false);
        }
        let header = resend.header.clone();
        let payload = resend.cookie.to_le_bytes();
        let addr = resend.addr;

        log::debug!(
            ">>> Re-sending ConnectResponse to {}: no server packet since the handshake",
            addr
        );
        self.queue_packet_to_addr(header, &payload, addr, now)?;
        // The flush re-stamps this from the real send time
        // (`note_connect_response_sent`); pushing it out here keeps the timer
        // from firing again before then.
        if let Some(resend) = self.connect_response_resend.as_mut() {
            resend.next_resend_at = now + CONNECT_RESPONSE_RESEND_INTERVAL;
        }
        Ok(true)
    }

    /// net-transport-3: retail stamps `lastSentHandshake_` inside
    /// `ClientNet::SendConnectAck` (acclient.c:371747), so each re-send is
    /// timed from the previous real send. Called by the control-packet flush.
    pub(crate) fn note_connect_response_sent(&mut self) {
        if let Some(resend) = self.connect_response_resend.as_mut() {
            resend.next_resend_at = Instant::now() + CONNECT_RESPONSE_RESEND_INTERVAL;
        }
    }

    /// net-transport-3: retail leaves `cs_ConnectionRequestAcked` for
    /// `cs_Connected`, which ends the ConnectResponse re-sends, on the first
    /// validated packet without the ConnectRequest flag
    /// (`ClientNet::ProcessPacket`, acclient.c:372673 `if (!(header_ &
    /// 0x40000))`). One ACE exception: a bare cleartext ACK does not count.
    /// ACE sends one ~2 s after the LoginRequest in every session state
    /// (NetworkSession.cs `nextAck`, flushed by `Session.TickOutbound`), so it
    /// can arrive while DoLogin is still running, before any ConnectResponse
    /// could have matched. ACE's first packets after a match are an encrypted
    /// TimeSync (`sendResync`) and the character list.
    pub(crate) fn note_server_packet_for_handshake(&mut self, header: &PacketHeader) {
        if self.connect_response_resend.is_none()
            || header.flags & packet_flags::CONNECT_REQUEST != 0
            || header.flags == packet_flags::ACK_SEQUENCE
        {
            return;
        }
        log::debug!(
            "<<< Seq={} Flags={:X} answers the handshake; stopping ConnectResponse re-sends",
            header.sequence,
            header.flags
        );
        self.connect_response_resend = None;
    }

    pub fn handle_handshake_response(&mut self, cookie: u64, client_id: u16) {
        log::debug!(
            "<<< Handshake Response: Cookie={:016X} NetID={:04X}",
            cookie,
            client_id
        );
        self.connection_cookie = cookie;
        self.client_id = client_id;
    }
}
