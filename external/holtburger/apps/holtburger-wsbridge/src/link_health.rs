//! Link health of the browser↔bridge hop (net-health, 2026-10-23).
//!
//! The bridge's ACE side is UDP to an ACE that, in this deployment, runs on
//! the same machine; the hop that can go bad is the WebSocket's TCP
//! connection to the browser. When it does, the game shows it as late
//! self-position echoes. On 2026-10-21 the 1070's "pulsing run" was the
//! retail leash (it scales the run once the player is 10 m past the last
//! echoed position outdoors) starved by AutonomousPosition→echo times of
//! p50 0.3-0.7 s and p90 0.9-2.9 s while the ACE host sat on -74 dBm Wi-Fi.
//! Finding that took a WebSocket capture in the page and `ss -tin` typed by
//! hand during play.
//!
//! The bridge now measures the hop itself, per connection:
//!
//! - **WebSocket round trip.** Every `--ws-ping-ms` (default 1 s) the bridge
//!   sends a Ping carrying its send time. Browsers answer from their network
//!   stack, and tungstenite (the shim) answers on its next read, so the round
//!   trip is the path's latency including any head-of-line stall, without the
//!   page's main thread in it. A Pong is not client activity: it does not
//!   refresh the WS-idle reaper's clock.
//! - **The kernel's view of the TCP connection** (`TCP_INFO`, Linux only):
//!   the minimum RTT (the path's floor), retransmits and how many of them the
//!   peer already had (`dsack`: the original was late, not lost), and the
//!   retransmission timeouts with the time spent recovering from them (the
//!   head-of-line stalls of a thin stream). The smoothed RTT is logged too,
//!   but it is measured data→ACK, and a Windows peer delays its ACK by up to
//!   200 ms when it has nothing to send, so it overstates the path.
//! - Frames and bytes relayed each way.
//!
//! A `link:` line is logged once a minute while the connection is up and a
//! `link summary` line when it ends, so every session leaves a record of how
//! its link behaved. A wired LAN reads a ws rtt of about a millisecond and no
//! retransmits. At ACE's 18 m/s run cap the 10 m leash start is 0.56 s of
//! echo staleness, so a ws rtt p90 in the hundreds of milliseconds is felt.

use std::fmt;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

/// Round-trip samples kept for a connection's session summary: a day of
/// pings at the default 1 s. Past it the summary covers the first day; the
/// per-minute lines keep working.
pub const MAX_SESSION_RTT_SAMPLES: usize = 86_400;

/// A Ping's payload, echoed back in the Pong: the 8-byte big-endian send
/// time in microseconds since the connection's epoch.
pub const PING_PAYLOAD_LEN: usize = 8;

/// The longest round trip a Pong may report; above it the peer is echoing
/// something other than our payload.
const MAX_PLAUSIBLE_RTT_US: u64 = 120_000_000;

pub fn ping_payload(sent_us: u64) -> [u8; PING_PAYLOAD_LEN] {
    sent_us.to_be_bytes()
}

/// The round trip (µs) a Pong reports, or `None` when its payload is not one
/// of ours (wrong length, a send time in the future, or implausibly old).
pub fn rtt_from_pong(payload: &[u8], now_us: u64) -> Option<u32> {
    let sent_us = u64::from_be_bytes(payload.try_into().ok()?);
    let rtt_us = now_us.checked_sub(sent_us)?;
    if rtt_us > MAX_PLAUSIBLE_RTT_US {
        return None;
    }
    u32::try_from(rtt_us).ok()
}

/// Percentiles of a set of round trips (nearest rank).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RttSummary {
    pub n: usize,
    pub p50_us: u32,
    pub p90_us: u32,
    pub p99_us: u32,
    pub max_us: u32,
}

impl RttSummary {
    /// Summarise `samples`, sorting them in place.
    pub fn of(samples: &mut [u32]) -> Self {
        if samples.is_empty() {
            return Self::default();
        }
        samples.sort_unstable();
        let n = samples.len();
        // Rank ceil(per_mille * n / 1000), 1-based, in integers.
        let rank = |per_mille: usize| samples[(per_mille * n).div_ceil(1000).clamp(1, n) - 1];
        Self {
            n,
            p50_us: rank(500),
            p90_us: rank(900),
            p99_us: rank(990),
            max_us: samples[n - 1],
        }
    }
}

/// The round trips of one connection's pings: those since the last `link:`
/// line, and (up to [`MAX_SESSION_RTT_SAMPLES`]) the whole session.
#[derive(Debug, Default)]
pub struct RttStats {
    window: Vec<u32>,
    window_pings: u64,
    session: Vec<u32>,
    session_pings: u64,
}

impl RttStats {
    pub fn ping_sent(&mut self) {
        self.window_pings += 1;
        self.session_pings += 1;
    }

    pub fn record(&mut self, rtt_us: u32) {
        self.window.push(rtt_us);
        if self.session.len() < MAX_SESSION_RTT_SAMPLES {
            self.session.push(rtt_us);
        }
    }

    /// The round trips since the last call and the pings sent meanwhile;
    /// starts the next window.
    pub fn take_window(&mut self) -> (RttSummary, u64) {
        let summary = RttSummary::of(&mut self.window);
        self.window.clear();
        (summary, std::mem::take(&mut self.window_pings))
    }

    /// The whole session's round trips and pings sent.
    pub fn session(&mut self) -> (RttSummary, u64) {
        (RttSummary::of(&mut self.session), self.session_pings)
    }
}

/// Frames and payload bytes one pump relayed.
#[derive(Debug, Default)]
pub struct Traffic {
    frames: AtomicU64,
    bytes: AtomicU64,
}

impl Traffic {
    pub fn record(&self, bytes: usize) {
        self.frames.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn frames(&self) -> u64 {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
}

/// The `TCP_INFO` fields the link lines use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TcpSample {
    /// `tcpi_rto`: the current retransmission timeout (µs).
    pub rto_us: u32,
    /// `tcpi_unacked`: segments in flight.
    pub unacked: u32,
    /// `tcpi_lost`: segments currently presumed lost.
    pub lost: u32,
    /// `tcpi_rtt` / `tcpi_rttvar`: the smoothed RTT and its variation (µs).
    pub srtt_us: u32,
    pub rttvar_us: u32,
    /// `tcpi_total_retrans`: segments retransmitted over the connection.
    pub total_retrans: u32,
    /// `tcpi_min_rtt` (µs).
    pub min_rtt_us: Option<u32>,
    /// `tcpi_dsack_dups`: retransmitted segments the peer reported it
    /// already had.
    pub dsack_dups: Option<u32>,
    /// `tcpi_total_rto` / `tcpi_total_rto_time`: retransmission timeouts and
    /// the milliseconds spent recovering from them.
    pub total_rto: Option<u16>,
    pub total_rto_time_ms: Option<u32>,
}

/// Byte offsets in `struct tcp_info` (include/uapi/linux/tcp.h, checked
/// against the 6.18 header with `offsetof`). The struct only grows; the
/// kernel fills as much of it as it has, so a field past the filled length
/// (an older kernel) reads as `None`.
mod tcp_info_offset {
    pub const RTO: usize = 8;
    pub const UNACKED: usize = 24;
    pub const LOST: usize = 32;
    pub const RTT: usize = 68;
    pub const RTTVAR: usize = 72;
    pub const TOTAL_RETRANS: usize = 100;
    pub const MIN_RTT: usize = 148;
    pub const DSACK_DUPS: usize = 216;
    pub const TOTAL_RTO: usize = 240;
    pub const TOTAL_RTO_TIME: usize = 244;
}

impl TcpSample {
    /// Read the fields out of the bytes `getsockopt(TCP_INFO)` filled.
    /// `None` when even the original fields (through `tcpi_total_retrans`)
    /// are missing.
    pub fn parse(info: &[u8]) -> Option<Self> {
        use tcp_info_offset as off;
        let u32_at = |at: usize| {
            info.get(at..at + 4)
                .and_then(|b| <[u8; 4]>::try_from(b).ok())
                .map(u32::from_ne_bytes)
        };
        let u16_at = |at: usize| {
            info.get(at..at + 2)
                .and_then(|b| <[u8; 2]>::try_from(b).ok())
                .map(u16::from_ne_bytes)
        };
        Some(Self {
            rto_us: u32_at(off::RTO)?,
            unacked: u32_at(off::UNACKED)?,
            lost: u32_at(off::LOST)?,
            srtt_us: u32_at(off::RTT)?,
            rttvar_us: u32_at(off::RTTVAR)?,
            total_retrans: u32_at(off::TOTAL_RETRANS)?,
            min_rtt_us: u32_at(off::MIN_RTT),
            dsack_dups: u32_at(off::DSACK_DUPS),
            total_rto: u16_at(off::TOTAL_RTO),
            total_rto_time_ms: u32_at(off::TOTAL_RTO_TIME),
        })
    }
}

/// Reads `TCP_INFO` for one connection. It holds a duplicate of the socket's
/// descriptor, so a sample taken after the WebSocket halves are dropped
/// still reads this connection and never a reused descriptor. The kernel
/// sends the FIN only once the duplicate is closed too, so the bridge drops
/// the probe right after the final sample.
pub struct TcpProbe {
    #[cfg(target_os = "linux")]
    sock: socket2::Socket,
    peak_srtt_us: AtomicU32,
}

impl TcpProbe {
    /// `None` off Linux, or when the descriptor cannot be duplicated or
    /// `TCP_INFO` cannot be read.
    pub fn new(tcp: &tokio::net::TcpStream) -> Option<Self> {
        #[cfg(target_os = "linux")]
        {
            let sock = socket2::SockRef::from(tcp).try_clone().ok()?;
            let probe = Self {
                sock,
                peak_srtt_us: AtomicU32::new(0),
            };
            probe.sample()?;
            Some(probe)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = tcp;
            None
        }
    }

    /// The connection's `TCP_INFO` now; its srtt also feeds the peak.
    pub fn sample(&self) -> Option<TcpSample> {
        #[cfg(target_os = "linux")]
        {
            let sample = read_tcp_info(&self.sock)?;
            self.peak_srtt_us.fetch_max(sample.srtt_us, Ordering::Relaxed);
            Some(sample)
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }

    /// The highest srtt any sample has seen.
    pub fn peak_srtt_us(&self) -> u32 {
        self.peak_srtt_us.load(Ordering::Relaxed)
    }
}

#[cfg(target_os = "linux")]
fn read_tcp_info(sock: &socket2::Socket) -> Option<TcpSample> {
    use std::os::fd::AsRawFd;
    // Larger than any kernel's struct tcp_info so far (280 bytes on 6.18).
    let mut buf = [0u8; 512];
    let mut len = buf.len() as libc::socklen_t;
    // SAFETY: `buf` is valid for writes of `len` bytes for the whole call;
    // the kernel writes at most `len` bytes and stores how many it wrote in
    // `len`.
    let rc = unsafe {
        libc::getsockopt(
            sock.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_INFO,
            buf.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return None;
    }
    TcpSample::parse(&buf[..(len as usize).min(buf.len())])
}

/// One `link:` or `link summary` line.
pub struct Report<'a> {
    pub rtt: RttSummary,
    /// Pings sent over the same span as `rtt`; 0 with pings off.
    pub pings: u64,
    pub tcp: Option<&'a TcpSample>,
    /// The session's highest sampled srtt (summary only).
    pub peak_srtt_us: Option<u32>,
    pub to_ace: &'a Traffic,
    pub to_ws: &'a Traffic,
}

impl fmt::Display for Report<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let rtt = &self.rtt;
        if rtt.n > 0 {
            write!(
                f,
                "ws rtt p50 {} p90 {} p99 {} max {} ({}/{} pings)",
                ms(rtt.p50_us),
                ms(rtt.p90_us),
                ms(rtt.p99_us),
                ms(rtt.max_us),
                rtt.n,
                self.pings
            )?;
        } else if self.pings > 0 {
            write!(f, "ws rtt n/a (0/{} pings answered)", self.pings)?;
        } else {
            write!(f, "ws rtt off")?;
        }
        if let Some(tcp) = self.tcp {
            write!(f, " · tcp")?;
            if let Some(min) = tcp.min_rtt_us {
                write!(f, " min_rtt {}", ms(min))?;
            }
            write!(f, " srtt {} (var {}", ms(tcp.srtt_us), ms(tcp.rttvar_us))?;
            if let Some(peak) = self.peak_srtt_us {
                write!(f, ", peak {}", ms(peak))?;
            }
            write!(f, ") rto {} retrans {}", ms(tcp.rto_us), tcp.total_retrans)?;
            if let Some(dsack) = tcp.dsack_dups {
                write!(f, " (dsack {dsack})")?;
            }
            if let Some(rtos) = tcp.total_rto {
                write!(f, " timeouts {rtos}")?;
                if let Some(recovering_ms) = tcp.total_rto_time_ms {
                    write!(f, " ({recovering_ms} ms)")?;
                }
            }
            if tcp.lost > 0 || tcp.unacked > 1 {
                write!(f, " lost {} unacked {}", tcp.lost, tcp.unacked)?;
            }
        }
        write!(
            f,
            " · browser→ACE {} frames/{} · ACE→browser {} frames/{}",
            self.to_ace.frames(),
            bytes(self.to_ace.bytes()),
            self.to_ws.frames(),
            bytes(self.to_ws.bytes())
        )
    }
}

fn ms(us: u32) -> String {
    if us < 10_000 {
        format!("{:.1} ms", f64::from(us) / 1000.0)
    } else {
        format!("{} ms", us / 1000)
    }
}

fn bytes(n: u64) -> String {
    if n < 10_000 {
        format!("{n} B")
    } else if n < 10_000_000 {
        format!("{} KB", n / 1000)
    } else {
        format!("{:.1} MB", n as f64 / 1e6)
    }
}

/// `12m05s`, or `3h07m` past an hour.
pub fn fmt_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}h{:02}m", s / 3600, s % 3600 / 60)
    } else {
        format!("{}m{:02}s", s / 60, s % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_u32(buf: &mut [u8], at: usize, v: u32) {
        buf[at..at + 4].copy_from_slice(&v.to_ne_bytes());
    }

    #[test]
    fn parse_reads_the_tcp_info_offsets() {
        use tcp_info_offset as off;
        let mut info = vec![0u8; 280];
        put_u32(&mut info, off::RTO, 394_000);
        put_u32(&mut info, off::UNACKED, 3);
        put_u32(&mut info, off::LOST, 1);
        put_u32(&mut info, off::RTT, 132_000);
        put_u32(&mut info, off::RTTVAR, 65_000);
        put_u32(&mut info, off::TOTAL_RETRANS, 20);
        put_u32(&mut info, off::MIN_RTT, 4_000);
        put_u32(&mut info, off::DSACK_DUPS, 19);
        info[off::TOTAL_RTO..off::TOTAL_RTO + 2].copy_from_slice(&7u16.to_ne_bytes());
        put_u32(&mut info, off::TOTAL_RTO_TIME, 1_890);

        let s = TcpSample::parse(&info).unwrap();
        assert_eq!(
            s,
            TcpSample {
                rto_us: 394_000,
                unacked: 3,
                lost: 1,
                srtt_us: 132_000,
                rttvar_us: 65_000,
                total_retrans: 20,
                min_rtt_us: Some(4_000),
                dsack_dups: Some(19),
                total_rto: Some(7),
                total_rto_time_ms: Some(1_890),
            }
        );

        // An older kernel's shorter struct: the later fields are absent.
        let old = TcpSample::parse(&info[..off::MIN_RTT + 4]).unwrap();
        assert_eq!(old.min_rtt_us, Some(4_000));
        assert_eq!(old.dsack_dups, None);
        assert_eq!(old.total_rto, None);
        assert_eq!(old.total_rto_time_ms, None);
        // Not even the original fields: no sample.
        assert!(TcpSample::parse(&info[..off::TOTAL_RETRANS]).is_none());
    }

    #[test]
    fn pong_payload_round_trips_and_rejects_strangers() {
        let sent = 5_000_000;
        assert_eq!(rtt_from_pong(&ping_payload(sent), sent + 1_234), Some(1_234));
        assert_eq!(rtt_from_pong(&ping_payload(sent), sent), Some(0));
        // A send time in the future, a short payload, an implausible age.
        assert_eq!(rtt_from_pong(&ping_payload(sent + 1), sent), None);
        assert_eq!(rtt_from_pong(b"ping", sent), None);
        assert_eq!(rtt_from_pong(&ping_payload(0), MAX_PLAUSIBLE_RTT_US + 1), None);
    }

    #[test]
    fn summary_uses_nearest_rank_percentiles() {
        let mut samples: Vec<u32> = (1..=100).rev().collect();
        let s = RttSummary::of(&mut samples);
        assert_eq!((s.n, s.p50_us, s.p90_us, s.p99_us, s.max_us), (100, 50, 90, 99, 100));
        let one = RttSummary::of(&mut [7]);
        assert_eq!((one.p50_us, one.p90_us, one.max_us), (7, 7, 7));
        assert_eq!(RttSummary::of(&mut []), RttSummary::default());
    }

    #[test]
    fn windows_reset_but_the_session_accumulates() {
        let mut stats = RttStats::default();
        for rtt in [1_000, 3_000] {
            stats.ping_sent();
            stats.record(rtt);
        }
        stats.ping_sent();
        let (window, pings) = stats.take_window();
        assert_eq!((window.n, window.max_us, pings), (2, 3_000, 3));
        assert_eq!(stats.take_window(), (RttSummary::default(), 0));
        stats.ping_sent();
        stats.record(500_000);
        let (session, pings) = stats.session();
        assert_eq!((session.n, session.max_us, pings), (3, 500_000, 4));
    }

    #[test]
    fn report_reads_like_the_log_line() {
        let to_ace = Traffic::default();
        let to_ws = Traffic::default();
        to_ace.record(120);
        to_ws.record(30_000);
        let tcp = TcpSample {
            rto_us: 201_000,
            srtt_us: 1_500,
            rttvar_us: 700,
            min_rtt_us: Some(400),
            dsack_dups: Some(0),
            total_rto: Some(0),
            total_rto_time_ms: Some(0),
            ..TcpSample::default()
        };
        let line = Report {
            rtt: RttSummary::of(&mut [900, 1_100, 1_300]),
            pings: 3,
            tcp: Some(&tcp),
            peak_srtt_us: Some(2_500),
            to_ace: &to_ace,
            to_ws: &to_ws,
        }
        .to_string();
        assert_eq!(
            line,
            "ws rtt p50 1.1 ms p90 1.3 ms p99 1.3 ms max 1.3 ms (3/3 pings) · tcp min_rtt 0.4 ms \
             srtt 1.5 ms (var 0.7 ms, peak 2.5 ms) rto 201 ms retrans 0 (dsack 0) timeouts 0 (0 ms) \
             · browser→ACE 1 frames/120 B · ACE→browser 1 frames/30 KB"
        );
        let quiet = Report {
            rtt: RttSummary::default(),
            pings: 0,
            tcp: None,
            peak_srtt_us: None,
            to_ace: &to_ace,
            to_ws: &to_ws,
        };
        assert!(quiet.to_string().starts_with("ws rtt off · browser→ACE"));
        assert_eq!(fmt_duration(Duration::from_secs(725)), "12m05s");
        assert_eq!(fmt_duration(Duration::from_secs(11_220)), "3h07m");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn probe_reads_a_live_loopback_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        let probe = TcpProbe::new(&server).expect("TCP_INFO on Linux");

        // Some data each way, so the server side has RTT samples of its own.
        let mut buf = [0u8; 4];
        for _ in 0..3 {
            server.write_all(b"ping").await.unwrap();
            client.read_exact(&mut buf).await.unwrap();
            client.write_all(b"pong").await.unwrap();
            server.read_exact(&mut buf).await.unwrap();
        }
        let s = probe.sample().unwrap();
        assert!(s.srtt_us > 0, "{s:?}");
        assert!(s.min_rtt_us.is_some(), "{s:?}");
        assert_eq!(s.total_retrans, 0);
        assert!(probe.peak_srtt_us() >= s.srtt_us);

        // The probe's duplicate descriptor keeps reading this connection
        // after the stream itself is gone.
        drop(server);
        assert!(probe.sample().is_some());
    }
}
