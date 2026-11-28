//! ace-loadtest — real-protocol multi-player capacity & landblock-loading harness.
//!
//! Spawns N concurrent Asheron's Call client sessions over WebSocket (`holtburger-wsbridge`
//! -> `ACE.Server`) or direct UDP (`--direct-udp`), using the real `holtburger-session` +
//! `holtburger-protocol` stack:
//!   1. Auto-creates / logs into distinct accounts (`<prefix>0001..`).
//!   2. Creates a valid Aluvian character (using `CharGen` + `SkillTable` from
//!      `client_portal.dat`) if the account has no character yet.
//!   3. Enters the world, runs `@god`, `@neversaydie on`, `@attackable off`, and
//!      `@teleloc` OUT of the Training Hall onto verified dry outdoor Dereth terrain
//!      loaded from `client_cell_1.dat`.
//!   4. Sends `LoginComplete` after teleport arrival so ACE clears `Teleporting`,
//!      verifies `!pos.is_indoors()`, and continuously runs across landblocks sending
//!      retail `MoveToState` + 1 Hz `AutonomousPosition` updates with exact terrain Z.
//!   5. Measures application-level ACE `PingRequest`/`PingResponse` RTT, landblock
//!      crossings, unique landblocks visited, S2C `ObjectCreate` streaming rates,
//!      bandwidth, deaths (must stay 0), and disconnects/rejections.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::Cursor;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use binrw::BinRead;
use clap::{Parser, ValueEnum};
use futures_util::{SinkExt, StreamExt};
use holtburger_common::position::{METERS_PER_LANDBLOCK, WorldPosition};
use holtburger_common::{Guid, Quaternion, Vector3};
use holtburger_content::CharacterGenCatalog;
use holtburger_dat::DatDatabase;
use holtburger_dat::file_type::region::Region;
use holtburger_dat::file_type::{CharGen, SkillTable};
use holtburger_dat::landblock::{CellLandblock, decode_land_height};
use holtburger_protocol::messages::chat::actions::TalkActionData;
use holtburger_protocol::messages::misc::actions::PingRequestActionData;
use holtburger_protocol::messages::movement::types::{
    HoldKey, MotionStance, RawMotionFlags, RawMotionState,
};
use holtburger_protocol::messages::{
    AutonomousPositionActionData, CharacterCreateAppearanceData, CharacterCreateRequestData,
    CharacterEnterWorldData, CharacterEnterWorldRequestData,
    CharacterGenerationVerificationResponse, GameAction, GameEvent, GameMessage,
    LoginCompleteActionData, MoveToStateActionData, SkillAdvancementClass,
};
use holtburger_protocol::traits::ProtocolUnpack;
use holtburger_session::{Session, SessionEvent, Transport};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const WATER_MIN: u8 = 0x10;
const WATER_MAX: u8 = 0x14;
const WALK_FORWARD_MOTION_COMMAND: u32 = 0x4500_0005;
const REGION_FILE_ID: u32 = 0x1300_0000;

/// ACE `CharacterError` enum values (`ACE.Server/Network/Enum/CharacterError.cs`).
const CHAR_ERR_LOGON_SERVER_FULL: u32 = 0x0000_0015;

fn classify_character_error(error_id: u32) -> (&'static str, bool) {
    match error_id {
        0x0000_0001 => ("LogonDuplicate", false),
        0x0000_0003 => ("AccountLogin", false),
        0x0000_0004 | 0x0000_0008 => ("ServerCrash", false),
        0x0000_000D => ("EnterGameCharacterInWorld", false),
        0x0000_000E => ("EnterGamePlayerAccountMissing", false),
        0x0000_0010 => ("EnterGameCharacterInWorldServer", false),
        0x0000_0014 => ("EnterGameCouldntPlaceCharacter", false),
        CHAR_ERR_LOGON_SERVER_FULL => ("LogonServerFull", true),
        0x0000_0017 => ("EnterGameCharacterLocked", false),
        _ => ("Other", false),
    }
}

fn is_ws_capacity_error(msg: &str) -> bool {
    let low = msg.to_lowercase();
    low.contains("503")
        || low.contains("max_conns")
        || low.contains("too many")
        || low.contains("capacity")
        || low.contains("service unavailable")
        || low.contains("rejected")
}

fn gcd(mut a: usize, mut b: usize) -> usize {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// Golden-ratio stride guaranteed coprime to `len` so modular iteration visits every index once.
fn coprime_step(len: usize) -> usize {
    if len <= 1 {
        return 1;
    }
    let mut step = (len * 618 / 1000).max(1);
    while step < len && gcd(step, len) != 1 {
        step += 1;
    }
    if step >= len { 1 } else { step }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
enum Mode {
    /// Spread players across distinct dry 3x3 outdoor regions of Dereth to maximize
    /// ACE landblock activation, creature spawning, and multi-landblock ticking.
    Dispersed,
    /// Cluster players on concentric running loops around `--center-lb` (default Holtburg
    /// 0xA9B4) to stress visible-player rendering & broadcast sync on a live holtburger-web client.
    Crowd,
    /// Put `--crowd-count` players around `--center-lb` and disperse the rest across Dereth.
    Mixed,
}

#[derive(Parser, Debug, Clone)]
#[command(about = "Real-protocol AC load tester through holtburger-wsbridge -> ACE.Server")]
struct Args {
    /// WebSocket URL of holtburger-wsbridge.
    #[arg(long, default_value = "ws://127.0.0.1:8080/")]
    bridge_url: String,

    /// Upstream ACE host announced to wsbridge (or dialed directly with --direct-udp).
    #[arg(long, default_value = "127.0.0.1")]
    ace_host: String,

    /// ACE login UDP port (world port is login_port + 1).
    #[arg(long, default_value_t = 9000)]
    ace_port: u16,

    /// Bypass wsbridge and dial ACE directly over UDP (useful for isolating bridge overhead).
    #[arg(long, default_value_t = false)]
    direct_udp: bool,

    /// Directory containing client_cell_1.dat and client_portal.dat.
    #[arg(long, default_value = "/workspace/wb/ace-dats-local")]
    dat_dir: PathBuf,

    /// Spatial distribution mode.
    #[arg(long, value_enum, default_value_t = Mode::Dispersed)]
    mode: Mode,

    /// Number of players for Crowd portion in `--mode mixed`.
    #[arg(long, default_value_t = 20)]
    crowd_count: usize,

    /// Center landblock hex (e.g. A9B4 for Holtburg) for Crowd / Mixed mode.
    #[arg(long, default_value = "A9B4")]
    center_lb: String,

    /// Center local X inside `--center-lb` (0..192). Default Holtburg courtyard.
    #[arg(long, default_value_t = 84.0)]
    center_x: f32,

    /// Center local Y inside `--center-lb` (0..192). Default Holtburg courtyard.
    #[arg(long, default_value_t = 96.0)]
    center_y: f32,

    /// Total number of players (ignored if `--steps` is provided).
    #[arg(long, default_value_t = 10)]
    players: usize,

    /// Comma-separated stepped player counts, e.g. `10,25,50,75,100,125`.
    #[arg(long)]
    steps: Option<String>,

    /// Seconds to hold each step (or total hold duration when `--steps` is omitted).
    #[arg(long, default_value_t = 40)]
    hold_secs: u64,

    /// Milliseconds between launching consecutive player sessions during ramp-up.
    #[arg(long, default_value_t = 150)]
    ramp_interval_ms: u64,

    /// Running speed in meters/second (AC run speed is ~10-14 m/s).
    #[arg(long, default_value_t = 12.0)]
    speed: f32,

    /// Account/character prefix (accounts: `<prefix>0001`, characters: `<Prefix>0001`).
    #[arg(long, default_value = "loadbot")]
    account_prefix: String,

    /// Starting 1-based index for account numbering.
    #[arg(long, default_value_t = 1)]
    start_index: usize,

    /// Optional path to write 1-second JSONL telemetry snapshots.
    #[arg(long)]
    json_log: Option<PathBuf>,

    /// Optional path to write a file containing the current step number (for external orchestrators).
    #[arg(long)]
    phase_file: Option<PathBuf>,

    /// Minimum landblock Chebyshev separation for dispersed spawns.
    #[arg(long, default_value_t = 5)]
    min_lb_sep: usize,

    /// Minimum orbit radius (meters) for Crowd / Mixed mode.
    #[arg(long, default_value_t = 8.0)]
    crowd_radius_min: f32,

    /// Maximum orbit radius (meters) for Crowd / Mixed mode.
    #[arg(long, default_value_t = 30.0)]
    crowd_radius_max: f32,

    /// Per-bot deadline (seconds) to authenticate and enter world before timing out.
    #[arg(long, default_value_t = 60)]
    login_timeout_secs: u64,

    /// Print candidate flat, dry, building-free outdoor landblocks and exit.
    #[arg(long, default_value_t = false)]
    find_flat_arena: bool,

    /// Only ensure accounts + characters exist (never enter world), then disconnect and exit.
    #[arg(long, default_value_t = false)]
    provision_only: bool,
}

// ============================================================================
// Native WebSocket Transport implementing holtburger_session::Transport
// ============================================================================

#[derive(Serialize)]
struct ClientHello<'a> {
    v: u32,
    host: &'a str,
    login_port: u16,
    world_port: Option<u16>,
}

#[derive(Deserialize)]
struct ServerHello {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

struct NativeWsTransport {
    tx: mpsc::UnboundedSender<WsMessage>,
    rx: Mutex<mpsc::UnboundedReceiver<Result<(Vec<u8>, SocketAddr)>>>,
    _server_ip: IpAddr,
}

impl NativeWsTransport {
    async fn connect(
        bridge_url: &str,
        ace_host: &str,
        login_port: u16,
        world_port: u16,
    ) -> Result<(Self, IpAddr)> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(bridge_url)
            .await
            .with_context(|| format!("ws connect to {bridge_url}"))?;
        let (mut write, mut read) = ws_stream.split();

        let hello = serde_json::to_string(&ClientHello {
            v: 1,
            host: ace_host,
            login_port,
            world_port: Some(world_port),
        })?;
        write
            .send(WsMessage::Text(hello))
            .await
            .context("send wsbridge ClientHello")?;

        let server_ip: IpAddr = loop {
            match read.next().await {
                Some(Ok(WsMessage::Text(txt))) => {
                    let sh: ServerHello =
                        serde_json::from_str(&txt).context("parse ServerHello")?;
                    if !sh.ok {
                        return Err(anyhow!(
                            "wsbridge rejected handshake: {}",
                            sh.error.unwrap_or_else(|| "unknown error".into())
                        ));
                    }
                    let ip_str = sh.ip.ok_or_else(|| anyhow!("ServerHello missing ip"))?;
                    break ip_str.parse().context("parse ServerHello ip")?;
                }
                Some(Ok(WsMessage::Ping(d))) => {
                    let _ = write.send(WsMessage::Pong(d)).await;
                }
                Some(Ok(WsMessage::Close(c))) => {
                    return Err(anyhow!("wsbridge closed during handshake: {c:?}"));
                }
                Some(Err(e)) => return Err(anyhow!("wsbridge handshake err: {e}")),
                None => return Err(anyhow!("wsbridge EOF during handshake")),
                _ => {}
            }
        };

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsMessage>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<Result<(Vec<u8>, SocketAddr)>>();
        let pong_tx = out_tx.clone();

        tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if write.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = write.close().await;
        });

        tokio::spawn(async move {
            while let Some(item) = read.next().await {
                match item {
                    Ok(WsMessage::Binary(buf)) => {
                        if buf.len() < 2 {
                            let _ = in_tx.send(Err(anyhow!("short ws binary frame")));
                            break;
                        }
                        let port = u16::from_be_bytes([buf[0], buf[1]]);
                        let payload = buf[2..].to_vec();
                        if in_tx
                            .send(Ok((payload, SocketAddr::new(server_ip, port))))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(WsMessage::Ping(d)) => {
                        let _ = pong_tx.send(WsMessage::Pong(d));
                    }
                    Ok(WsMessage::Pong(_)) => {}
                    Ok(WsMessage::Close(c)) => {
                        let _ = in_tx.send(Err(anyhow!("ws closed: {c:?}")));
                        break;
                    }
                    Ok(WsMessage::Text(t)) => {
                        let _ = in_tx.send(Err(anyhow!("unexpected ws text frame: {t}")));
                        break;
                    }
                    Ok(WsMessage::Frame(_)) => {}
                    Err(e) => {
                        let _ = in_tx.send(Err(anyhow!("ws read err: {e}")));
                        break;
                    }
                }
            }
        });

        Ok((
            Self {
                tx: out_tx,
                rx: Mutex::new(in_rx),
                _server_ip: server_ip,
            },
            server_ip,
        ))
    }
}

#[async_trait]
impl Transport for NativeWsTransport {
    async fn send_to(&self, buf: &[u8], addr: SocketAddr) -> Result<usize> {
        let mut frame = Vec::with_capacity(2 + buf.len());
        frame.extend_from_slice(&addr.port().to_be_bytes());
        frame.extend_from_slice(buf);
        self.tx
            .send(WsMessage::Binary(frame))
            .map_err(|_| anyhow!("ws writer closed"))?;
        Ok(buf.len())
    }

    async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        let mut rx = self.rx.lock().await;
        match rx.recv().await {
            Some(Ok((payload, addr))) => {
                let n = payload.len().min(buf.len());
                buf[..n].copy_from_slice(&payload[..n]);
                Ok((n, addr))
            }
            Some(Err(e)) => Err(e),
            None => Err(anyhow!("ws reader closed")),
        }
    }
}

// ============================================================================
// Terrain Atlas from client_cell_1.dat + CharGen skill table from portal.dat
// ============================================================================

struct TerrainAtlas {
    heights: HashMap<u16, [u8; 81]>,
    dry_walkable: Vec<bool>, // indexed by ((lb_x as usize) << 8) | (lb_y as usize)
    has_objects: Vec<bool>,
    land_height_table: Option<Vec<f32>>,
}

impl TerrainAtlas {
    fn load(dat_dir: &Path) -> Result<Self> {
        let land_height_table = load_region_height_table(dat_dir);
        let cell_dat = dat_dir.join("client_cell_1.dat");
        let db = DatDatabase::new(&cell_dat)
            .map_err(|e| anyhow!("open {}: {e}", cell_dat.display()))?;

        let mut envcell_lbs = BTreeSet::<u16>::new();
        let mut lb_ids = Vec::new();
        for &id in db.files.keys() {
            let low = (id & 0xFFFF) as u16;
            let lb = (id >> 16) as u16;
            if low == 0xFFFF {
                lb_ids.push(id);
            } else if (0x0100..=0xFFFD).contains(&low) {
                envcell_lbs.insert(lb);
            }
        }

        let mut heights = HashMap::with_capacity(lb_ids.len());
        let mut dry_walkable = vec![false; 65536];
        let mut has_objects = vec![false; 65536];

        for id in lb_ids {
            let lb = (id >> 16) as u16;
            let lb_x = (lb >> 8) as usize;
            let lb_y = (lb & 0xFF) as usize;
            let Ok(bytes) = db.get_file(id) else {
                continue;
            };
            let Ok(clb) = CellLandblock::unpack(&bytes) else {
                continue;
            };
            let mut h_arr = [0u8; 81];
            h_arr.copy_from_slice(&clb.height[..81]);
            heights.insert(lb, h_arr);
            has_objects[lb as usize] = clb.has_objects != 0 || envcell_lbs.contains(&lb);

            // Check completely dry and walkable (no water vertices, no shear cliffs,
            // away from extreme map borders).
            let any_water = (0usize..9).any(|x| {
                (0usize..9).any(|y| (WATER_MIN..=WATER_MAX).contains(&clb.terrain_type(x, y)))
            });
            let mut min_h = f32::INFINITY;
            let mut max_h = f32::NEG_INFINITY;
            for &b in &h_arr {
                let z = decode_land_height(b, land_height_table.as_deref());
                min_h = min_h.min(z);
                max_h = max_h.max(z);
            }
            let is_interior_only = envcell_lbs.contains(&lb) && max_h == 0.0 && min_h == 0.0;
            // Exclude Dericost/extreme edges and shear mountains (> 64m delta inside 192m)
            if !any_water
                && !is_interior_only
                && (max_h - min_h) <= 64.0
                && (8..=247).contains(&lb_x)
                && (8..=247).contains(&lb_y)
            {
                dry_walkable[lb as usize] = true;
            }
        }

        Ok(Self {
            heights,
            dry_walkable,
            has_objects,
            land_height_table,
        })
    }

    fn is_dry(&self, lb_x: u8, lb_y: u8) -> bool {
        let lb = ((lb_x as usize) << 8) | (lb_y as usize);
        self.dry_walkable.get(lb).copied().unwrap_or(false)
    }

    fn is_dry_neighborhood(&self, lb_x: u8, lb_y: u8, radius: i32) -> bool {
        for dx in -radius..=radius {
            for dy in -radius..=radius {
                let nx = lb_x as i32 + dx;
                let ny = lb_y as i32 + dy;
                if !(0..=255).contains(&nx) || !(0..=255).contains(&ny) {
                    return false;
                }
                if !self.is_dry(nx as u8, ny as u8) {
                    return false;
                }
            }
        }
        true
    }

    /// Bilinear terrain height at global coordinates (meters), decoded via `Region::land_height_table`.
    fn sample_height(&self, gx: f32, gy: f32) -> f32 {
        let lb_x = (gx / METERS_PER_LANDBLOCK).floor().clamp(0.0, 255.0) as u8;
        let lb_y = (gy / METERS_PER_LANDBLOCK).floor().clamp(0.0, 255.0) as u8;
        let lx = (gx - lb_x as f32 * METERS_PER_LANDBLOCK).clamp(0.0, METERS_PER_LANDBLOCK - 0.01);
        let ly = (gy - lb_y as f32 * METERS_PER_LANDBLOCK).clamp(0.0, METERS_PER_LANDBLOCK - 0.01);
        let lb = ((lb_x as u16) << 8) | (lb_y as u16);
        let Some(h) = self.heights.get(&lb) else {
            return 0.0;
        };
        let tbl = self.land_height_table.as_deref();
        let fx = lx / 24.0;
        let fy = ly / 24.0;
        let ix = (fx.floor() as usize).min(7);
        let iy = (fy.floor() as usize).min(7);
        let tx = (fx - ix as f32).clamp(0.0, 1.0);
        let ty = (fy - iy as f32).clamp(0.0, 1.0);
        let h00 = decode_land_height(h[ix * 9 + iy], tbl);
        let h10 = decode_land_height(h[(ix + 1) * 9 + iy], tbl);
        let h01 = decode_land_height(h[ix * 9 + (iy + 1)], tbl);
        let h11 = decode_land_height(h[(ix + 1) * 9 + (iy + 1)], tbl);
        let hx0 = h00 * (1.0 - tx) + h10 * tx;
        let hx1 = h01 * (1.0 - tx) + h11 * tx;
        hx0 * (1.0 - ty) + hx1 * ty
    }

    fn world_pos_at(&self, gx: f32, gy: f32, wire_heading_deg: f32) -> WorldPosition {
        let lb_x = (gx / METERS_PER_LANDBLOCK).floor().clamp(0.0, 255.0) as u8;
        let lb_y = (gy / METERS_PER_LANDBLOCK).floor().clamp(0.0, 255.0) as u8;
        let lx = (gx - lb_x as f32 * METERS_PER_LANDBLOCK).clamp(0.01, METERS_PER_LANDBLOCK - 0.01);
        let ly = (gy - lb_y as f32 * METERS_PER_LANDBLOCK).clamp(0.01, METERS_PER_LANDBLOCK - 0.01);
        let z = self.sample_height(gx, gy) + 0.05;
        let base_lb = ((lb_x as u32) << 24) | ((lb_y as u32) << 16) | 1;
        WorldPosition {
            landblock_id: Guid(base_lb),
            coords: Vector3::new(lx, ly, z),
            rotation: Quaternion::from_wire_heading(wire_heading_deg),
        }
        .normalize_outdoor_cell()
    }

    /// Find flat, completely dry, building/object-free outdoor landblocks ideal for
    /// unobstructed crowd-rendering benchmarks.
    fn find_flat_open_arenas(&self, limit: usize) -> Vec<(u16, f32, f32)> {
        let tbl = self.land_height_table.as_deref();
        let mut out = Vec::new();
        for lb_x in 20u8..=235 {
            for lb_y in 20u8..=235 {
                let lb = ((lb_x as u16) << 8) | (lb_y as u16);
                if !self.is_dry_neighborhood(lb_x, lb_y, 1) || self.has_objects[lb as usize] {
                    continue;
                }
                let Some(h) = self.heights.get(&lb) else {
                    continue;
                };
                let mut min_h = f32::INFINITY;
                let mut max_h = f32::NEG_INFINITY;
                for &b in h {
                    let z = decode_land_height(b, tbl);
                    min_h = min_h.min(z);
                    max_h = max_h.max(z);
                }
                let delta = max_h - min_h;
                if delta <= 4.0 && min_h >= 2.0 {
                    out.push((lb, delta, (min_h + max_h) * 0.5));
                }
            }
        }
        // Prefer flattest blocks near central Osteth (around Holtburg 0xA9B4 = 169,180)
        out.sort_by(|a, b| {
            let da = ((a.0 >> 8) as i32 - 0xA9).abs() + ((a.0 & 0xFF) as i32 - 0xB4).abs();
            let db = ((b.0 >> 8) as i32 - 0xA9).abs() + ((b.0 & 0xFF) as i32 - 0xB4).abs();
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| da.cmp(&db))
        });
        out.truncate(limit);
        out
    }

    /// Select up to `count` dispersed starting outdoor landblocks, maximizing separation
    /// so players wake distinct landblock clusters.
    fn pick_dispersed_spawns(&self, count: usize, min_sep: usize) -> Vec<(u8, u8)> {
        // Collect candidates that have a dry 3x3 neighborhood first, then fallback to dry 1x1.
        let mut tier1 = Vec::new();
        let mut tier2 = Vec::new();
        for lb_x in 12u8..=243 {
            for lb_y in 12u8..=243 {
                if self.is_dry_neighborhood(lb_x, lb_y, 1) {
                    tier1.push((lb_x, lb_y));
                } else if self.is_dry(lb_x, lb_y) {
                    tier2.push((lb_x, lb_y));
                }
            }
        }
        // Deterministically interleave across the map via coprime golden-ratio permutation
        let mut chosen: Vec<(u8, u8)> = Vec::with_capacity(count);
        for sep in (1..=min_sep).rev() {
            for pool in [&tier1, &tier2] {
                if pool.is_empty() {
                    continue;
                }
                let step = coprime_step(pool.len());
                let mut idx = 0usize;
                for _ in 0..pool.len() {
                    let cand = pool[idx % pool.len()];
                    idx = idx.wrapping_add(step);
                    let far_enough = chosen.iter().all(|&(cx, cy)| {
                        let dx = (cx as i32 - cand.0 as i32).unsigned_abs() as usize;
                        let dy = (cy as i32 - cand.1 as i32).unsigned_abs() as usize;
                        dx.max(dy) >= sep
                    });
                    if far_enough {
                        chosen.push(cand);
                        if chosen.len() >= count {
                            return chosen;
                        }
                    }
                }
            }
        }
        // If we somehow need more than all dry blocks, wrap deterministically
        while chosen.len() < count && !tier1.is_empty() {
            chosen.push(tier1[chosen.len() % tier1.len()]);
        }
        chosen
    }
}

fn load_region_height_table(dat_dir: &Path) -> Option<Vec<f32>> {
    let portal_dat = dat_dir.join("client_portal.dat");
    let db = DatDatabase::new(&portal_dat).ok()?;
    let bytes = db.get_file(REGION_FILE_ID).ok()?;
    let region = Region::unpack(&mut Cursor::new(&bytes)).ok()?;
    if region.land_defs.land_height_table.len() == 256 {
        Some(region.land_defs.land_height_table)
    } else {
        None
    }
}

fn load_valid_aluvian_skills(dat_dir: &Path) -> Result<Vec<SkillAdvancementClass>> {
    let portal_dat = dat_dir.join("client_portal.dat");
    let db = DatDatabase::new(&portal_dat)
        .map_err(|e| anyhow!("open {}: {e}", portal_dat.display()))?;
    let cg_bytes = db
        .get_file(CharGen::FILE_ID)
        .map_err(|e| anyhow!("read CharGen: {e}"))?;
    let st_bytes = db
        .get_file(SkillTable::FILE_ID)
        .map_err(|e| anyhow!("read SkillTable: {e}"))?;
    let char_gen = CharGen::read(&mut Cursor::new(&cg_bytes))
        .map_err(|e| anyhow!("parse CharGen: {e}"))?;
    let skill_table = SkillTable::read(&mut Cursor::new(&st_bytes))
        .map_err(|e| anyhow!("parse SkillTable: {e}"))?;
    let catalog = CharacterGenCatalog::from_assets(&char_gen, &skill_table);

    // ACE PlayerFactory.Create requires SkillAdvancementClasses.Count == 55.
    let mut classes = vec![SkillAdvancementClass::Inactive; 55];
    for (&skill_id, def) in &catalog.skill_definitions {
        let idx = skill_id as usize;
        if idx == 0 || idx >= classes.len() || def.retired {
            continue;
        }
        let Some(costs) = catalog.skill_costs_for_heritage(1, skill_id) else {
            continue;
        };
        classes[idx] = if costs.trained_cost < 0 || costs.specialized_cost < 0 {
            SkillAdvancementClass::Inactive
        } else if costs.trained_cost <= 0 {
            if costs.specialized_cost <= 0 {
                SkillAdvancementClass::Specialized
            } else {
                SkillAdvancementClass::Trained
            }
        } else {
            SkillAdvancementClass::Untrained
        };
    }
    Ok(classes)
}

fn build_char_create_request(
    account_name: String,
    char_name: String,
    skills: &[SkillAdvancementClass],
) -> CharacterCreateRequestData {
    CharacterCreateRequestData {
        account_name,
        unknown_constant: 1,
        heritage: 1, // Aluvian
        gender: 1,   // Male
        appearance: CharacterCreateAppearanceData {
            eyes: 0,
            nose: 0,
            mouth: 0,
            hair_color: 0,
            eye_color: 0,
            hair_style: 0,
            headgear_style: u32::MAX, // no headgear
            headgear_color: 0,
            shirt_style: 0,
            shirt_color: 0,
            pants_style: 0,
            pants_color: 0,
            footwear_style: 0,
            footwear_color: 0,
            skin_hue: 0.0,
            hair_hue: 0.0,
            headgear_hue: 0.0,
            shirt_hue: 0.0,
            pants_hue: 0.0,
            footwear_hue: 0.0,
        },
        template_option: 0, // Custom
        strength_ability: 60,
        endurance_ability: 60,
        coordination_ability: 60,
        quickness_ability: 60,
        focus_ability: 50,
        self_ability: 40, // sum = 330
        character_slot: 0,
        class_id: 1,
        skill_advancement_classes: skills.to_vec(),
        name: char_name,
        start_area: 0,
        is_admin: false,
        is_sentinel: false,
    }
}

// ============================================================================
// Global Shared Metrics
// ============================================================================

struct Metrics {
    target_players: AtomicUsize,
    connecting: AtomicUsize,
    connected: AtomicUsize,
    in_world: AtomicUsize,
    god_ok: AtomicUsize,
    immortal_ok: AtomicUsize,
    unattackable_ok: AtomicUsize,
    outdoor_ok: AtomicUsize,
    moving: AtomicUsize,

    login_failures: AtomicU64,
    disconnects: AtomicU64,
    char_errors: AtomicU64,
    booted: AtomicU64,
    rejected_full: AtomicU64,
    deaths: AtomicU64,
    monster_damage_events: AtomicU64,

    total_lb_crossings: AtomicU64,
    total_confirmed_moves: AtomicU64,
    total_reconciliations: AtomicU64,
    total_obj_creates: AtomicU64,
    total_s2c_msgs: AtomicU64,
    total_c2s_pos_sent: AtomicU64,
    total_bytes_in: AtomicU64,
    total_bytes_out: AtomicU64,
    ping_timeouts: AtomicU64,

    unique_lbs: Mutex<BTreeSet<u16>>,
    recent_rtts_ms: Mutex<VecDeque<f64>>,
    error_samples: Mutex<BTreeMap<String, u64>>,
    bot_lbs: Mutex<HashMap<usize, u16>>,
}

impl Metrics {
    fn new() -> Self {
        Self {
            target_players: AtomicUsize::new(0),
            connecting: AtomicUsize::new(0),
            connected: AtomicUsize::new(0),
            in_world: AtomicUsize::new(0),
            god_ok: AtomicUsize::new(0),
            immortal_ok: AtomicUsize::new(0),
            unattackable_ok: AtomicUsize::new(0),
            outdoor_ok: AtomicUsize::new(0),
            moving: AtomicUsize::new(0),
            login_failures: AtomicU64::new(0),
            disconnects: AtomicU64::new(0),
            char_errors: AtomicU64::new(0),
            booted: AtomicU64::new(0),
            rejected_full: AtomicU64::new(0),
            deaths: AtomicU64::new(0),
            monster_damage_events: AtomicU64::new(0),
            total_lb_crossings: AtomicU64::new(0),
            total_confirmed_moves: AtomicU64::new(0),
            total_reconciliations: AtomicU64::new(0),
            total_obj_creates: AtomicU64::new(0),
            total_s2c_msgs: AtomicU64::new(0),
            total_c2s_pos_sent: AtomicU64::new(0),
            total_bytes_in: AtomicU64::new(0),
            total_bytes_out: AtomicU64::new(0),
            ping_timeouts: AtomicU64::new(0),
            unique_lbs: Mutex::new(BTreeSet::new()),
            recent_rtts_ms: Mutex::new(VecDeque::with_capacity(4096)),
            error_samples: Mutex::new(BTreeMap::new()),
            bot_lbs: Mutex::new(HashMap::new()),
        }
    }

    async fn record_error(&self, reason: String) {
        let mut map = self.error_samples.lock().await;
        let key = reason.chars().take(90).collect::<String>();
        *map.entry(key).or_insert(0) += 1;
    }

    async fn record_rtt(&self, ms: f64) {
        let mut q = self.recent_rtts_ms.lock().await;
        if q.len() >= 2048 {
            q.pop_front();
        }
        q.push_back(ms);
    }

    async fn snapshot(&self, elapsed_s: f64, step: usize) -> MetricsSnapshot {
        let rtts: Vec<f64> = {
            let q = self.recent_rtts_ms.lock().await;
            let mut v: Vec<f64> = q.iter().copied().collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            v
        };
        let pct = |p: f64| -> f64 {
            if rtts.is_empty() {
                0.0
            } else {
                let idx = ((rtts.len() as f64 - 1.0) * p).round() as usize;
                rtts[idx.min(rtts.len() - 1)]
            }
        };
        let unique_lbs = self.unique_lbs.lock().await.len();
        let active_distinct_lbs = {
            let m = self.bot_lbs.lock().await;
            m.values().copied().collect::<BTreeSet<u16>>().len()
        };
        let errors = self.error_samples.lock().await.clone();

        MetricsSnapshot {
            ts_unix: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            elapsed_s,
            step,
            target: self.target_players.load(Ordering::Relaxed),
            connecting: self.connecting.load(Ordering::Relaxed),
            connected: self.connected.load(Ordering::Relaxed),
            in_world: self.in_world.load(Ordering::Relaxed),
            god_ok: self.god_ok.load(Ordering::Relaxed),
            immortal_ok: self.immortal_ok.load(Ordering::Relaxed),
            unattackable_ok: self.unattackable_ok.load(Ordering::Relaxed),
            outdoor_ok: self.outdoor_ok.load(Ordering::Relaxed),
            moving: self.moving.load(Ordering::Relaxed),
            login_failures: self.login_failures.load(Ordering::Relaxed),
            disconnects: self.disconnects.load(Ordering::Relaxed),
            char_errors: self.char_errors.load(Ordering::Relaxed),
            booted: self.booted.load(Ordering::Relaxed),
            rejected_full: self.rejected_full.load(Ordering::Relaxed),
            deaths: self.deaths.load(Ordering::Relaxed),
            monster_damage_events: self.monster_damage_events.load(Ordering::Relaxed),
            total_lb_crossings: self.total_lb_crossings.load(Ordering::Relaxed),
            total_confirmed_moves: self.total_confirmed_moves.load(Ordering::Relaxed),
            total_reconciliations: self.total_reconciliations.load(Ordering::Relaxed),
            unique_lbs_visited: unique_lbs,
            active_distinct_lbs,
            total_obj_creates: self.total_obj_creates.load(Ordering::Relaxed),
            total_s2c_msgs: self.total_s2c_msgs.load(Ordering::Relaxed),
            total_c2s_pos_sent: self.total_c2s_pos_sent.load(Ordering::Relaxed),
            total_bytes_in: self.total_bytes_in.load(Ordering::Relaxed),
            total_bytes_out: self.total_bytes_out.load(Ordering::Relaxed),
            ping_samples: rtts.len(),
            ping_p50_ms: (pct(0.50) * 100.0).round() / 100.0,
            ping_p95_ms: (pct(0.95) * 100.0).round() / 100.0,
            ping_p99_ms: (pct(0.99) * 100.0).round() / 100.0,
            ping_max_ms: (pct(1.00) * 100.0).round() / 100.0,
            ping_timeouts: self.ping_timeouts.load(Ordering::Relaxed),
            errors,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
struct MetricsSnapshot {
    ts_unix: f64,
    elapsed_s: f64,
    step: usize,
    target: usize,
    connecting: usize,
    connected: usize,
    in_world: usize,
    god_ok: usize,
    immortal_ok: usize,
    unattackable_ok: usize,
    outdoor_ok: usize,
    moving: usize,
    login_failures: u64,
    disconnects: u64,
    char_errors: u64,
    booted: u64,
    rejected_full: u64,
    deaths: u64,
    monster_damage_events: u64,
    total_lb_crossings: u64,
    total_confirmed_moves: u64,
    total_reconciliations: u64,
    unique_lbs_visited: usize,
    active_distinct_lbs: usize,
    total_obj_creates: u64,
    total_s2c_msgs: u64,
    total_c2s_pos_sent: u64,
    total_bytes_in: u64,
    total_bytes_out: u64,
    ping_samples: usize,
    ping_p50_ms: f64,
    ping_p95_ms: f64,
    ping_p99_ms: f64,
    ping_max_ms: f64,
    ping_timeouts: u64,
    errors: BTreeMap<String, u64>,
}

// ============================================================================
// Individual Player Bot Task
// ============================================================================

#[derive(Clone, Debug)]
enum MovementPlan {
    Dispersed {
        start_gx: f32,
        start_gy: f32,
        heading_deg: f32,
    },
    CrowdOrbit {
        center_gx: f32,
        center_gy: f32,
        radius_m: f32,
        radius_min: f32,
        radius_max: f32,
        angle_rad: f32,
        cw: bool,
    },
}

/// Advance a crowd-orbit bot one step; if `blocked`, reverse orbit direction and nudge radius
/// inward/outward within `[r_min, r_max]` from the last server-confirmed angle.
#[allow(clippy::too_many_arguments)]
fn advance_crowd_orbit(
    center_gx: f32,
    center_gy: f32,
    radius_m: &mut f32,
    r_min: f32,
    r_max: f32,
    orbit_angle: &mut f32,
    cw: &mut bool,
    step_m: f32,
    blocked: bool,
    server_gx: f32,
    server_gy: f32,
) -> (f32, f32, f32) {
    if blocked {
        *cw = !*cw;
        let span = (r_max - r_min).max(1.0);
        *radius_m = r_min + ((*radius_m - r_min + span * 0.37) % span);
        let dx = server_gx - center_gx;
        let dy = server_gy - center_gy;
        if dx.hypot(dy) > 1.0 {
            *orbit_angle = dy.atan2(dx);
        }
    }
    let dtheta = (step_m / (*radius_m).max(6.0)).min(0.6);
    if *cw {
        *orbit_angle -= dtheta;
    } else {
        *orbit_angle += dtheta;
    }
    let gx = center_gx + *radius_m * orbit_angle.cos();
    let gy = center_gy + *radius_m * orbit_angle.sin();
    let tangent = if *cw {
        *orbit_angle - std::f32::consts::FRAC_PI_2
    } else {
        *orbit_angle + std::f32::consts::FRAC_PI_2
    };
    let heading_deg = tangent.cos().atan2(tangent.sin()).to_degrees().rem_euclid(360.0);
    (gx, gy, heading_deg)
}

struct BotGuards<'a> {
    m: &'a Metrics,
    id: usize,
    connecting: bool,
    connected: bool,
    in_world: bool,
    god: bool,
    immortal: bool,
    unattackable: bool,
    outdoor: bool,
    moving: bool,
}

impl<'a> BotGuards<'a> {
    fn new(m: &'a Metrics, id: usize) -> Self {
        m.connecting.fetch_add(1, Ordering::Relaxed);
        Self {
            m,
            id,
            connecting: true,
            connected: false,
            in_world: false,
            god: false,
            immortal: false,
            unattackable: false,
            outdoor: false,
            moving: false,
        }
    }
    fn set_connected(&mut self) {
        if self.connecting {
            self.connecting = false;
            self.m.connecting.fetch_sub(1, Ordering::Relaxed);
        }
        if !self.connected {
            self.connected = true;
            self.m.connected.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_in_world(&mut self) {
        if !self.in_world {
            self.in_world = true;
            self.m.in_world.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_god(&mut self) {
        if !self.god {
            self.god = true;
            self.m.god_ok.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_immortal(&mut self) {
        if !self.immortal {
            self.immortal = true;
            self.m.immortal_ok.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_unattackable(&mut self) {
        if !self.unattackable {
            self.unattackable = true;
            self.m.unattackable_ok.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_outdoor(&mut self) {
        if !self.outdoor {
            self.outdoor = true;
            self.m.outdoor_ok.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn set_moving(&mut self) {
        if !self.moving {
            self.moving = true;
            self.m.moving.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for BotGuards<'_> {
    fn drop(&mut self) {
        if self.connecting {
            self.m.connecting.fetch_sub(1, Ordering::Relaxed);
        }
        if self.connected {
            self.m.connected.fetch_sub(1, Ordering::Relaxed);
        }
        if self.in_world {
            self.m.in_world.fetch_sub(1, Ordering::Relaxed);
        }
        if self.god {
            self.m.god_ok.fetch_sub(1, Ordering::Relaxed);
        }
        if self.immortal {
            self.m.immortal_ok.fetch_sub(1, Ordering::Relaxed);
        }
        if self.unattackable {
            self.m.unattackable_ok.fetch_sub(1, Ordering::Relaxed);
        }
        if self.outdoor {
            self.m.outdoor_ok.fetch_sub(1, Ordering::Relaxed);
        }
        if self.moving {
            self.m.moving.fetch_sub(1, Ordering::Relaxed);
        }
        let _ = self.id;
    }
}

fn make_run_motion_state() -> RawMotionState {
    RawMotionState {
        flags: RawMotionFlags::CURRENT_HOLD_KEY
            | RawMotionFlags::CURRENT_STYLE
            | RawMotionFlags::FORWARD_COMMAND
            | RawMotionFlags::FORWARD_HOLD_KEY
            | RawMotionFlags::FORWARD_SPEED,
        current_hold_key: Some(HoldKey::Run as u32),
        current_style: Some(MotionStance::NonCombat as u32),
        forward_command: Some(WALK_FORWARD_MOTION_COMMAND),
        forward_hold_key: Some(HoldKey::Run as u32),
        forward_speed: Some(1.0),
        ..Default::default()
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_bot(
    bot_id: usize,
    account: String,
    char_name: String,
    args: Arc<Args>,
    atlas: Arc<TerrainAtlas>,
    skills: Arc<Vec<SkillAdvancementClass>>,
    plan: MovementPlan,
    metrics: Arc<Metrics>,
    shutdown_rx: watch::Receiver<bool>,
) {
    run_bot_inner(
        bot_id,
        account,
        char_name,
        args,
        atlas,
        skills,
        plan,
        metrics.clone(),
        shutdown_rx,
    )
    .await;
    // Always remove this bot's landblock entry on every exit path.
    metrics.bot_lbs.lock().await.remove(&bot_id);
}

#[allow(clippy::too_many_arguments)]
async fn run_bot_inner(
    bot_id: usize,
    account: String,
    char_name: String,
    args: Arc<Args>,
    atlas: Arc<TerrainAtlas>,
    skills: Arc<Vec<SkillAdvancementClass>>,
    plan: MovementPlan,
    metrics: Arc<Metrics>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut g = BotGuards::new(&metrics, bot_id);

    // 1. Open transport & Session
    let mut session = if args.direct_udp {
        let addr: SocketAddr = match format!("{}:{}", args.ace_host, args.ace_port).parse() {
            Ok(a) => a,
            Err(e) => {
                metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                metrics.record_error(format!("bad ace addr: {e}")).await;
                return;
            }
        };
        match Session::new(addr).await {
            Ok(s) => s,
            Err(e) => {
                metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                metrics.record_error(format!("udp bind: {e}")).await;
                return;
            }
        }
    } else {
        match tokio::time::timeout(
            Duration::from_secs(15),
            NativeWsTransport::connect(
                &args.bridge_url,
                &args.ace_host,
                args.ace_port,
                args.ace_port + 1,
            ),
        )
        .await
        {
            Ok(Ok((transport, server_ip))) => {
                let server_addr = SocketAddr::new(server_ip, args.ace_port);
                Session::new_with_transport(Box::new(transport), server_addr)
            }
            Ok(Err(e)) => {
                let msg = format!("{e:#}");
                metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                if is_ws_capacity_error(&msg) {
                    metrics.rejected_full.fetch_add(1, Ordering::Relaxed);
                }
                metrics.record_error(format!("ws connect: {msg}")).await;
                return;
            }
            Err(_) => {
                metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                metrics
                    .record_error("ws connect timeout (15s)".into())
                    .await;
                return;
            }
        }
    };

    if let Err(e) = session.send_login_request(&account, &account).await {
        metrics.login_failures.fetch_add(1, Ordering::Relaxed);
        metrics.record_error(format!("send_login_request: {e}")).await;
        return;
    }

    // Per-bot state
    let mut self_guid: Option<Guid> = None;
    let mut char_created_requested = false;
    let mut enter_requested = false;
    let mut setup_sent = false;
    let mut tele_sent = false;
    let mut last_setup_retry_at: Option<Instant> = None;
    let mut awaiting_tp_pos = false;
    let mut in_world_at: Option<Instant> = None;
    let mut tele_sent_at: Option<Instant> = None;

    let (init_gx, init_gy, mut heading_deg) = match &plan {
        MovementPlan::Dispersed {
            start_gx,
            start_gy,
            heading_deg,
        } => (*start_gx, *start_gy, *heading_deg),
        MovementPlan::CrowdOrbit {
            center_gx,
            center_gy,
            radius_m,
            angle_rad,
            cw,
            ..
        } => {
            let x = center_gx + radius_m * angle_rad.cos();
            let y = center_gy + radius_m * angle_rad.sin();
            let tangent = if *cw {
                angle_rad - std::f32::consts::FRAC_PI_2
            } else {
                angle_rad + std::f32::consts::FRAC_PI_2
            };
            let wd = tangent.cos().atan2(tangent.sin()).to_degrees().rem_euclid(360.0);
            (x, y, wd)
        }
    };
    let mut cur_gx = init_gx;
    let mut cur_gy = init_gy;
    let mut server_gx = init_gx;
    let mut server_gy = init_gy;
    let mut unacked_move_ticks: u32 = 0;
    let (mut orbit_radius_m, mut orbit_angle, mut orbit_cw) = match &plan {
        MovementPlan::CrowdOrbit {
            radius_m,
            angle_rad,
            cw,
            ..
        } => (*radius_m, *angle_rad, *cw),
        _ => (0.0, 0.0, false),
    };
    let mut current_lb: Option<u16> = None;
    let mut instance_seq: u16 = 0;
    let server_control_seq: u16 = 0;
    let mut teleport_seq: u16 = 0;
    let mut force_pos_seq: u16 = 0;
    let mut move_started = false;
    let mut last_sent_heading_deg: f32 = heading_deg;

    let mut ping_in_flight: Option<Instant> = None;
    let mut last_bytes_in: u64 = 0;
    let mut last_bytes_out: u64 = 0;

    let login_deadline = Instant::now() + Duration::from_secs(args.login_timeout_secs);
    let mut tick_interval = tokio::time::interval(Duration::from_millis(250));
    tick_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut next_move_at = Instant::now() + Duration::from_millis((bot_id as u64 % 10) * 100);
    let mut next_ping_at = Instant::now() + Duration::from_secs(3) + Duration::from_millis((bot_id as u64 % 25) * 180);

    loop {
        if *shutdown_rx.borrow() {
            let _ = session.send_disconnect().await;
            break;
        }

        // Sync byte deltas to global counters
        let bi = session.bytes_in;
        let bo = session.bytes_out;
        if bi > last_bytes_in {
            metrics
                .total_bytes_in
                .fetch_add(bi - last_bytes_in, Ordering::Relaxed);
            last_bytes_in = bi;
        }
        if bo > last_bytes_out {
            metrics
                .total_bytes_out
                .fetch_add(bo - last_bytes_out, Ordering::Relaxed);
            last_bytes_out = bo;
        }

        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    let _ = session.send_disconnect().await;
                    break;
                }
            }
            recv_res = session.recv_message() => {
                match recv_res {
                    Ok(events) => {
                        for ev in events {
                            let SessionEvent::Message(raw) = ev else { continue };
                            metrics.total_s2c_msgs.fetch_add(1, Ordering::Relaxed);
                            let mut off = 0;
                            let Some(msg) = GameMessage::unpack(&raw, &mut off) else {
                                continue;
                            };
                            match msg {
                                GameMessage::CharacterList(list) => {
                                    g.set_connected();
                                    if let Some(first) = list.characters.first() {
                                        self_guid = Some(first.guid);
                                        if args.provision_only {
                                            let _ = session.send_disconnect().await;
                                            return;
                                        }
                                        if !enter_requested {
                                            enter_requested = true;
                                            let req = GameMessage::CharacterEnterWorldRequest(Box::new(
                                                CharacterEnterWorldRequestData { guid: first.guid },
                                            ));
                                            if let Err(e) = session.send_message(&req).await {
                                                metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                                metrics.record_error(format!("enter req: {e}")).await;
                                                return;
                                            }
                                        }
                                    } else if !char_created_requested {
                                        char_created_requested = true;
                                        let req = build_char_create_request(
                                            list.account_name.clone(),
                                            char_name.clone(),
                                            &skills,
                                        );
                                        if let Err(e) = session.send_message(&GameMessage::CharacterCreate(Box::new(req))).await {
                                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                            metrics.record_error(format!("char create send: {e}")).await;
                                            return;
                                        }
                                    }
                                }
                                GameMessage::CharacterCreateResponse(resp) => {
                                    if resp.response == CharacterGenerationVerificationResponse::Ok {
                                        if args.provision_only {
                                            let _ = session.send_disconnect().await;
                                            return;
                                        }
                                        if let Some(guid) = resp.guid {
                                            self_guid = Some(guid);
                                            if !enter_requested {
                                                enter_requested = true;
                                                let req = GameMessage::CharacterEnterWorldRequest(Box::new(
                                                    CharacterEnterWorldRequestData { guid },
                                                ));
                                                if let Err(e) = session.send_message(&req).await {
                                                    metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                                    metrics.record_error(format!("enter after create: {e}")).await;
                                                    return;
                                                }
                                            }
                                        }
                                    } else {
                                        metrics.char_errors.fetch_add(1, Ordering::Relaxed);
                                        metrics.record_error(format!("CharacterCreateResponse::{:?}", resp.response)).await;
                                        let _ = session.send_disconnect().await;
                                        return;
                                    }
                                }
                                GameMessage::CharacterEnterWorldServerReady => {
                                    if let Some(guid) = self_guid {
                                        let msg = GameMessage::CharacterEnterWorld(Box::new(
                                            CharacterEnterWorldData {
                                                guid,
                                                account: account.clone(),
                                            },
                                        ));
                                        if let Err(e) = session.send_message(&msg).await {
                                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                            metrics.record_error(format!("enter world: {e}")).await;
                                            return;
                                        }
                                    }
                                }
                                GameMessage::PlayerCreate(pc) => {
                                    self_guid = Some(pc.guid);
                                    g.set_connected();
                                    g.set_in_world();
                                    in_world_at = Some(Instant::now());
                                    if let Err(e) = session.send_action(GameAction::LoginComplete(Box::new(LoginCompleteActionData))).await {
                                        metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                        metrics.record_error(format!("LoginComplete: {e}")).await;
                                        return;
                                    }
                                }
                                GameMessage::PlayerTeleport(tp) => {
                                    teleport_seq = tp.teleport_sequence;
                                    awaiting_tp_pos = true;
                                    // Mirror holtburger-web: clear Teleporting flag via LoginComplete
                                    let _ = session.send_action(GameAction::LoginComplete(Box::new(LoginCompleteActionData))).await;
                                }
                                GameMessage::UpdatePosition(up) => {
                                    if Some(up.guid) == self_guid {
                                        instance_seq = up.pos.instance_sequence;
                                        teleport_seq = up.pos.teleport_sequence;
                                        force_pos_seq = up.pos.force_position_sequence;
                                        if !up.pos.pos.is_indoors() {
                                            let gc = up.pos.pos.global_coords();
                                            server_gx = gc.x;
                                            server_gy = gc.y;
                                            unacked_move_ticks = 0;
                                            let lb = (up.pos.pos.landblock_id.0 >> 16) as u16;
                                            if awaiting_tp_pos {
                                                awaiting_tp_pos = false;
                                                // Send LoginComplete once more after destination UpdatePosition
                                                // arrives so ACE definitely clears Teleporting.
                                                let _ = session.send_action(GameAction::LoginComplete(Box::new(LoginCompleteActionData))).await;
                                                cur_gx = gc.x;
                                                cur_gy = gc.y;
                                                current_lb = Some(lb);
                                                metrics.unique_lbs.lock().await.insert(lb);
                                                metrics.bot_lbs.lock().await.insert(bot_id, lb);
                                                g.set_outdoor();
                                            } else if g.outdoor {
                                                metrics.total_confirmed_moves.fetch_add(1, Ordering::Relaxed);
                                                // Record landblock crossings ONLY on server-authoritative UpdatePosition
                                                if current_lb != Some(lb) {
                                                    if current_lb.is_some() {
                                                        metrics.total_lb_crossings.fetch_add(1, Ordering::Relaxed);
                                                    }
                                                    current_lb = Some(lb);
                                                    metrics.unique_lbs.lock().await.insert(lb);
                                                    metrics.bot_lbs.lock().await.insert(bot_id, lb);
                                                }
                                                // Reconcile if server bounced us off an obstacle or stall
                                                let err_dist = (cur_gx - server_gx).hypot(cur_gy - server_gy);
                                                if err_dist > 36.0 {
                                                    metrics.total_reconciliations.fetch_add(1, Ordering::Relaxed);
                                                    cur_gx = server_gx;
                                                    cur_gy = server_gy;
                                                    heading_deg = (heading_deg + 115.0) % 360.0;
                                                }
                                            }
                                        }
                                    }
                                }
                                GameMessage::ServerMessage(sm) => {
                                    let t = sm.message.as_str();
                                    if t.contains("You are now a god") || t.contains("You are already a god") {
                                        g.set_god();
                                    } else if t.contains("You are now immortal") {
                                        g.set_immortal();
                                    } else if t.contains("Monsters will only attack you") {
                                        g.set_unattackable();
                                    } else if t.contains("points of damage") && t.contains("you") {
                                        metrics.monster_damage_events.fetch_add(1, Ordering::Relaxed);
                                    }
                                }
                                GameMessage::ObjectCreate(_) => {
                                    metrics.total_obj_creates.fetch_add(1, Ordering::Relaxed);
                                }
                                GameMessage::PlayerKilled(pk) => {
                                    if Some(pk.victim_id) == self_guid {
                                        metrics.deaths.fetch_add(1, Ordering::Relaxed);
                                        metrics.record_error(format!("player died: {}", pk.death_message)).await;
                                    }
                                }
                                GameMessage::CharacterError(ce) => {
                                    metrics.char_errors.fetch_add(1, Ordering::Relaxed);
                                    let (label, is_full) = classify_character_error(ce.error_id);
                                    if is_full {
                                        metrics.rejected_full.fetch_add(1, Ordering::Relaxed);
                                    }
                                    metrics
                                        .record_error(format!("CharacterError::{label}(0x{:08X})", ce.error_id))
                                        .await;
                                    let _ = session.send_disconnect().await;
                                    return;
                                }
                                GameMessage::AccountBoot(boot) => {
                                    metrics.booted.fetch_add(1, Ordering::Relaxed);
                                    let reason = boot.reason.unwrap_or_else(|| "none".into());
                                    if reason.to_lowercase().contains("full") || reason.to_lowercase().contains("limit") {
                                        metrics.rejected_full.fetch_add(1, Ordering::Relaxed);
                                    }
                                    metrics.record_error(format!("AccountBoot: {reason}")).await;
                                    return;
                                }
                                GameMessage::GameEvent(ev_msg) => {
                                    match ev_msg.event {
                                        GameEvent::PingResponse(_) => {
                                            if let Some(sent_at) = ping_in_flight.take() {
                                                let ms = sent_at.elapsed().as_secs_f64() * 1000.0;
                                                metrics.record_rtt(ms).await;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!("{e:#}");
                        if !g.connected {
                            metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                        } else {
                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                        }
                        if is_ws_capacity_error(&msg) {
                            metrics.rejected_full.fetch_add(1, Ordering::Relaxed);
                        }
                        metrics.record_error(format!("recv err: {msg}")).await;
                        return;
                    }
                }
            }
            _ = tick_interval.tick() => {
                let now = Instant::now();
                // Login timeout guard
                if !g.in_world && now > login_deadline {
                    metrics.login_failures.fetch_add(1, Ordering::Relaxed);
                    metrics.record_error(format!("login/enter-world timeout (connected={})", g.connected)).await;
                    let _ = session.send_disconnect().await;
                    return;
                }

                // Step A: Once in world for >= 350ms, run @god, @neversaydie on, @attackable off
                if let Some(iw) = in_world_at {
                    if !setup_sent && iw.elapsed() >= Duration::from_millis(350) {
                        setup_sent = true;
                        last_setup_retry_at = Some(now);
                        for cmd in ["@god", "@neversaydie on", "@attackable off"] {
                            if let Err(e) = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                                message: cmd.to_string(),
                            }))).await {
                                metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                                metrics.record_error(format!("send {cmd}: {e}")).await;
                                return;
                            }
                        }
                    }

                    // Retry any unconfirmed setup command (@god / @neversaydie / @attackable) every 2.5s
                    if setup_sent && !(g.god && g.immortal && g.unattackable) {
                        if last_setup_retry_at.map_or(true, |t| t.elapsed() >= Duration::from_millis(2500)) {
                            last_setup_retry_at = Some(now);
                            if !g.god {
                                let _ = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                                    message: "@god".to_string(),
                                }))).await;
                            }
                            if !g.immortal {
                                let _ = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                                    message: "@neversaydie on".to_string(),
                                }))).await;
                            }
                            if !g.unattackable {
                                let _ = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                                    message: "@attackable off".to_string(),
                                }))).await;
                            }
                        }
                    }

                    // Step B: Teleport OUT of Training Hall ONLY once god+immortal+unattackable are
                    // confirmed (or after 12s fallback under severe load).
                    if setup_sent
                        && !tele_sent
                        && ((g.god && g.immortal && g.unattackable) || iw.elapsed() >= Duration::from_secs(12))
                    {
                        tele_sent = true;
                        tele_sent_at = Some(now);
                        let target_pos = atlas.world_pos_at(init_gx, init_gy, heading_deg);
                        let tele_cmd = format!(
                            "@teleloc 0x{:08X} {:.2} {:.2} {:.2}",
                            target_pos.landblock_id.0,
                            target_pos.coords.x,
                            target_pos.coords.y,
                            target_pos.coords.z,
                        );
                        if let Err(e) = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                            message: tele_cmd,
                        }))).await {
                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                            metrics.record_error(format!("send @teleloc: {e}")).await;
                            return;
                        }
                    }

                    // Retry teleport if still indoor after 6s
                    if tele_sent && !g.outdoor {
                        if let Some(ts) = tele_sent_at {
                            if ts.elapsed() >= Duration::from_secs(6) {
                                tele_sent_at = Some(now);
                                let target_pos = atlas.world_pos_at(init_gx, init_gy, heading_deg);
                                let tele_cmd = format!(
                                    "@teleloc 0x{:08X} {:.2} {:.2} {:.2}",
                                    target_pos.landblock_id.0,
                                    target_pos.coords.x,
                                    target_pos.coords.y,
                                    target_pos.coords.z,
                                );
                                let _ = session.send_action(GameAction::Talk(Box::new(TalkActionData {
                                    message: tele_cmd,
                                }))).await;
                            }
                        }
                    }
                }

                // Step C: Continuous overland movement (1 Hz AutonomousPosition + MoveToState on turns)
                if g.outdoor && !awaiting_tp_pos && now >= next_move_at {
                    next_move_at = now + Duration::from_secs(1);
                    let dt = 1.0f32;
                    let step_m = args.speed * dt;
                    let mut heading_changed = false;

                    let blocked = unacked_move_ticks >= 3;
                    if blocked {
                        metrics.total_reconciliations.fetch_add(1, Ordering::Relaxed);
                        unacked_move_ticks = 0;
                    }
                    unacked_move_ticks = unacked_move_ticks.saturating_add(1);

                    match &plan {
                        MovementPlan::Dispersed { .. } => {
                            // Never drift > 1 landblock ahead of ACE's authoritative position (avoids
                            // MOVEMENT SPEED rejection during stalls or obstacle collisions).
                            if blocked {
                                cur_gx = server_gx;
                                cur_gy = server_gy;
                                heading_deg = (heading_deg + 105.0) % 360.0;
                                heading_changed = true;
                            }
                            // Try stepping forward; if approaching non-dry landblock, turn until clear
                            let mut found = false;
                            for turn_try in 0..8 {
                                if turn_try > 0 {
                                    heading_deg = (heading_deg + 115.0 + (bot_id as f32 * 7.0) % 40.0) % 360.0;
                                    heading_changed = true;
                                }
                                let rad = heading_deg.to_radians();
                                // Wire compass: 0=North (+Y), 90=East (+X)
                                let dx = rad.sin() * step_m;
                                let dy = rad.cos() * step_m;
                                let nx = cur_gx + dx;
                                let ny = cur_gy + dy;
                                // Look ahead 24m as well so we stay safely on dry terrain
                                let lx = cur_gx + rad.sin() * (step_m + 24.0);
                                let ly = cur_gy + rad.cos() * (step_m + 24.0);
                                let nlb_x = (nx / METERS_PER_LANDBLOCK).floor() as i32;
                                let nlb_y = (ny / METERS_PER_LANDBLOCK).floor() as i32;
                                let llb_x = (lx / METERS_PER_LANDBLOCK).floor() as i32;
                                let llb_y = (ly / METERS_PER_LANDBLOCK).floor() as i32;
                                if (8..=247).contains(&nlb_x)
                                    && (8..=247).contains(&nlb_y)
                                    && (8..=247).contains(&llb_x)
                                    && (8..=247).contains(&llb_y)
                                    && atlas.is_dry(nlb_x as u8, nlb_y as u8)
                                    && atlas.is_dry(llb_x as u8, llb_y as u8)
                                {
                                    cur_gx = nx;
                                    cur_gy = ny;
                                    found = true;
                                    break;
                                }
                            }
                            if !found {
                                // Gentle fallback turn in place
                                heading_deg = (heading_deg + 180.0) % 360.0;
                                heading_changed = true;
                            }
                        }
                        MovementPlan::CrowdOrbit {
                            center_gx,
                            center_gy,
                            radius_min,
                            radius_max,
                            ..
                        } => {
                            let (nx, ny, hd) = advance_crowd_orbit(
                                *center_gx,
                                *center_gy,
                                &mut orbit_radius_m,
                                *radius_min,
                                *radius_max,
                                &mut orbit_angle,
                                &mut orbit_cw,
                                step_m,
                                blocked,
                                server_gx,
                                server_gy,
                            );
                            cur_gx = nx;
                            cur_gy = ny;
                            heading_deg = hd;
                            let diff = (heading_deg - last_sent_heading_deg + 540.0) % 360.0 - 180.0;
                            if blocked || diff.abs() >= 22.0 {
                                heading_changed = true;
                            }
                        }
                    }

                    let pos = atlas.world_pos_at(cur_gx, cur_gy, heading_deg);

                    if !move_started || heading_changed {
                        move_started = true;
                        last_sent_heading_deg = heading_deg;
                        let mts = MoveToStateActionData {
                            raw_motion_state: make_run_motion_state(),
                            position: pos,
                            instance_sequence: instance_seq,
                            server_control_sequence: server_control_seq,
                            teleport_sequence: teleport_seq,
                            force_position_sequence: force_pos_seq,
                            contact_long_jump: 1,
                        };
                        if let Err(e) = session.send_action(GameAction::MoveToState(Box::new(mts))).await {
                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                            metrics.record_error(format!("MoveToState: {e}")).await;
                            return;
                        }
                    }

                    let ap = AutonomousPositionActionData {
                        position: pos,
                        instance_sequence: instance_seq,
                        server_control_sequence: server_control_seq,
                        teleport_sequence: teleport_seq,
                        force_position_sequence: force_pos_seq,
                        last_contact: 1,
                    };
                    if let Err(e) = session.send_action(GameAction::AutonomousPosition(Box::new(ap))).await {
                        metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                        metrics.record_error(format!("AutoPos: {e}")).await;
                        return;
                    }
                    metrics.total_c2s_pos_sent.fetch_add(1, Ordering::Relaxed);
                    g.set_moving();
                }

                // Step D: Periodic 5-second PingRequest for real ACE RTT measurement
                if g.in_world && now >= next_ping_at {
                    next_ping_at = now + Duration::from_secs(5);
                    if let Some(prev) = ping_in_flight {
                        if prev.elapsed() >= Duration::from_secs(10) {
                            metrics.ping_timeouts.fetch_add(1, Ordering::Relaxed);
                            ping_in_flight = None;
                        }
                    }
                    if ping_in_flight.is_none() {
                        ping_in_flight = Some(now);
                        if let Err(e) = session.send_action(GameAction::PingRequest(Box::new(PingRequestActionData))).await {
                            metrics.disconnects.fetch_add(1, Ordering::Relaxed);
                            metrics.record_error(format!("PingRequest: {e}")).await;
                            return;
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// Main Orchestrator
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let args = Arc::new(Args::parse());

    let steps: Vec<usize> = if let Some(ref s) = args.steps {
        s.split(',')
            .filter(|x| !x.trim().is_empty())
            .map(|x| x.trim().parse::<usize>())
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("parse --steps")?
    } else {
        vec![args.players]
    };
    let max_players = steps.iter().copied().max().unwrap_or(0);
    if max_players == 0 {
        return Err(anyhow!("must request at least 1 player"));
    }

    let center_lb = u16::from_str_radix(args.center_lb.trim_start_matches("0x"), 16)
        .with_context(|| format!("invalid --center-lb '{}'", args.center_lb))?;
    let center_lb_x = (center_lb >> 8) as f32;
    let center_lb_y = (center_lb & 0xFF) as f32;
    let center_gx = center_lb_x * METERS_PER_LANDBLOCK + args.center_x;
    let center_gy = center_lb_y * METERS_PER_LANDBLOCK + args.center_y;

    eprintln!(
        "[ace-loadtest] loading terrain & chargen tables from {}...",
        args.dat_dir.display()
    );
    let t_load = Instant::now();
    let atlas = Arc::new(TerrainAtlas::load(&args.dat_dir)?);
    if args.find_flat_arena {
        let arenas = atlas.find_flat_open_arenas(15);
        for (lb, delta, avg_z) in arenas {
            let lbx = (lb >> 8) as f32;
            let lby = (lb & 0xFF) as f32;
            let center_z = atlas.sample_height(lbx * METERS_PER_LANDBLOCK + 96.0, lby * METERS_PER_LANDBLOCK + 96.0);
            println!(
                "lb=0x{:04X} cell=0x{:04X}0024 local=(96,96) z={:.2} avg_z={:.2} delta_z={:.2}",
                lb, lb, center_z, avg_z, delta
            );
        }
        return Ok(());
    }
    let skills = Arc::new(load_valid_aluvian_skills(&args.dat_dir)?);
    let dry_count = atlas.dry_walkable.iter().filter(|&&b| b).count();
    eprintln!(
        "[ace-loadtest] loaded {} landblocks ({} dry walkable) + {} skills in {:.2}s",
        atlas.heights.len(),
        dry_count,
        skills.len(),
        t_load.elapsed().as_secs_f64()
    );

    let dispersed_needed = match args.mode {
        Mode::Dispersed => max_players,
        Mode::Crowd => 0,
        Mode::Mixed => max_players.saturating_sub(args.crowd_count),
    };
    let dispersed_lbs = if dispersed_needed > 0 {
        atlas.pick_dispersed_spawns(dispersed_needed, args.min_lb_sep)
    } else {
        Vec::new()
    };
    if dispersed_needed > 0 {
        eprintln!(
            "[ace-loadtest] selected {} dispersed outdoor starting landblocks (min_sep={})",
            dispersed_lbs.len(),
            args.min_lb_sep
        );
    }

    let metrics = Arc::new(Metrics::new());
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let shutdown_tx = shutdown_tx.clone();
        let stop_flag = stop_flag.clone();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("[ace-loadtest] Ctrl-C received, disconnecting bots cleanly...");
            stop_flag.store(true, Ordering::SeqCst);
            let _ = shutdown_tx.send(true);
        });
    }

    let start_time = Instant::now();
    let current_step = Arc::new(AtomicUsize::new(0));

    // Telemetry printer / JSONL writer
    let log_file = if let Some(ref p) = args.json_log {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Some(Arc::new(Mutex::new(
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(p)
                .with_context(|| format!("open json log {}", p.display()))?,
        )))
    } else {
        None
    };

    let reporter_metrics = metrics.clone();
    let reporter_step = current_step.clone();
    let reporter_log = log_file.clone();
    let mut reporter_shutdown = shutdown_rx.clone();
    let reporter_handle = tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(2));
        let mut prev_obj = 0u64;
        let mut prev_cross = 0u64;
        let mut prev_t = Instant::now();
        loop {
            tokio::select! {
                _ = reporter_shutdown.changed() => {
                    if *reporter_shutdown.borrow() { break; }
                }
                _ = iv.tick() => {
                    let now = Instant::now();
                    let dt = now.duration_since(prev_t).as_secs_f64().max(0.1);
                    prev_t = now;
                    let snap = reporter_metrics.snapshot(start_time.elapsed().as_secs_f64(), reporter_step.load(Ordering::Relaxed)).await;
                    let obj_rate = (snap.total_obj_creates.saturating_sub(prev_obj)) as f64 / dt;
                    let cross_rate = (snap.total_lb_crossings.saturating_sub(prev_cross)) as f64 / dt;
                    prev_obj = snap.total_obj_creates;
                    prev_cross = snap.total_lb_crossings;
                    eprintln!(
                        "[t={:5.1}s step={:3}] target={:3} conn={:3} inw={:3} god={:3} unatt={:3} out={:3} mov={:3} | lbs_act={:3} lbs_vis={:4} cross/s={:4.1} obj/s={:6.0} | rtt p50={:5.1} p95={:5.1} p99={:5.1} max={:5.1}ms | fail={} disc={} full={} death={}",
                        snap.elapsed_s, snap.step, snap.target, snap.connected, snap.in_world,
                        snap.god_ok, snap.unattackable_ok, snap.outdoor_ok, snap.moving,
                        snap.active_distinct_lbs, snap.unique_lbs_visited, cross_rate, obj_rate,
                        snap.ping_p50_ms, snap.ping_p95_ms, snap.ping_p99_ms, snap.ping_max_ms,
                        snap.login_failures, snap.disconnects, snap.rejected_full, snap.deaths
                    );
                    if let Some(ref f) = reporter_log {
                        use std::io::Write;
                        if let Ok(line) = serde_json::to_string(&snap) {
                            let mut guard = f.lock().await;
                            let _ = writeln!(guard, "{line}");
                            let _ = guard.flush();
                        }
                    }
                }
            }
        }
    });

    let mut handles = Vec::with_capacity(max_players);
    let mut spawned = 0usize;
    let mut dispersed_cursor = 0usize;
    let mut step_summaries = Vec::new();

    for &step_target in &steps {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        current_step.store(step_target, Ordering::Relaxed);
        metrics.target_players.store(step_target, Ordering::Relaxed);
        if let Some(ref pf) = args.phase_file {
            let _ = std::fs::write(pf, format!("ramping:{step_target}\n"));
        }
        eprintln!("=== RAMPING TO {step_target} PLAYERS ===");

        while spawned < step_target && !stop_flag.load(Ordering::SeqCst) {
            let bot_idx = args.start_index + spawned;
            let account = format!("{}{:04}", args.account_prefix, bot_idx);
            let mut prefix_cap = args.account_prefix.clone();
            if let Some(first) = prefix_cap.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            let char_name = format!("{}{:04}", prefix_cap, bot_idx);

            let is_crowd = match args.mode {
                Mode::Crowd => true,
                Mode::Dispersed => false,
                Mode::Mixed => spawned < args.crowd_count,
            };

            let plan = if is_crowd {
                let r_min = args.crowd_radius_min.max(4.0);
                let r_max = args.crowd_radius_max.max(r_min + 2.0);
                let rings = 6usize;
                let ring = (spawned % rings) as f32;
                let radius_m = r_min + (ring / (rings - 1) as f32) * (r_max - r_min);
                let angle_rad = (spawned as f32 * 2.399_963_2) % std::f32::consts::TAU;
                MovementPlan::CrowdOrbit {
                    center_gx,
                    center_gy,
                    radius_m,
                    radius_min: r_min,
                    radius_max: r_max,
                    angle_rad,
                    cw: spawned % 2 == 0,
                }
            } else {
                let (lb_x, lb_y) = dispersed_lbs[dispersed_cursor % dispersed_lbs.len()];
                dispersed_cursor += 1;
                let heading_deg = ((spawned * 137) % 360) as f32;
                MovementPlan::Dispersed {
                    start_gx: lb_x as f32 * METERS_PER_LANDBLOCK + 96.0,
                    start_gy: lb_y as f32 * METERS_PER_LANDBLOCK + 96.0,
                    heading_deg,
                }
            };

            let h = tokio::spawn(run_bot(
                bot_idx,
                account,
                char_name,
                args.clone(),
                atlas.clone(),
                skills.clone(),
                plan,
                metrics.clone(),
                shutdown_rx.clone(),
            ));
            handles.push(h);
            spawned += 1;

            if args.ramp_interval_ms > 0 {
                tokio::time::sleep(Duration::from_millis(args.ramp_interval_ms)).await;
            }
        }

        if args.provision_only {
            let _ = tokio::time::timeout(
                Duration::from_secs(args.login_timeout_secs),
                async {
                    for h in handles.drain(..) {
                        let _ = h.await;
                    }
                },
            )
            .await;
            let snap = metrics
                .snapshot(start_time.elapsed().as_secs_f64(), step_target)
                .await;
            step_summaries.push(snap);
            continue;
        }

        // Wait up to min(login_timeout_secs, 35s) for newly spawned bots to reach moving/outdoor state
        let settle_deadline = Instant::now() + Duration::from_secs(args.login_timeout_secs.min(35));
        while Instant::now() < settle_deadline && !stop_flag.load(Ordering::SeqCst) {
            let mov = metrics.moving.load(Ordering::Relaxed);
            let fail = metrics.login_failures.load(Ordering::Relaxed) as usize
                + metrics.disconnects.load(Ordering::Relaxed) as usize
                + metrics.char_errors.load(Ordering::Relaxed) as usize
                + metrics.booted.load(Ordering::Relaxed) as usize;
            if mov + fail >= step_target {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Reset rolling RTT window for clean steady-state measurement of this step
        metrics.recent_rtts_ms.lock().await.clear();

        if let Some(ref pf) = args.phase_file {
            let _ = std::fs::write(pf, format!("hold:{step_target}\n"));
        }
        eprintln!(
            "=== HOLDING AT {step_target} PLAYERS FOR {}s (currently moving={}) ===",
            args.hold_secs,
            metrics.moving.load(Ordering::Relaxed)
        );
        let hold_end = Instant::now() + Duration::from_secs(args.hold_secs);
        while Instant::now() < hold_end && !stop_flag.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        let snap = metrics
            .snapshot(start_time.elapsed().as_secs_f64(), step_target)
            .await;
        step_summaries.push(snap);
    }

    if let Some(ref pf) = args.phase_file {
        let _ = std::fs::write(pf, "stopping:0\n");
    }
    eprintln!("[ace-loadtest] shutting down {} bots cleanly...", handles.len());
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(6), async {
        for h in handles {
            let _ = h.await;
        }
    })
    .await;
    let _ = reporter_handle.await;

    println!("{}", serde_json::to_string_pretty(&step_summaries)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_full_character_error_is_0x15_only() {
        assert_eq!(classify_character_error(0x0000_0015), ("LogonServerFull", true));
        assert_eq!(classify_character_error(0x0000_0001), ("LogonDuplicate", false));
        assert_eq!(
            classify_character_error(0x0000_000E),
            ("EnterGamePlayerAccountMissing", false)
        );
        assert_eq!(classify_character_error(0x0000_0014), ("EnterGameCouldntPlaceCharacter", false));
        assert!(is_ws_capacity_error("ws connect to ws://127.0.0.1:8080/: HTTP error: 503 Service Unavailable"));
        assert!(is_ws_capacity_error("wsbridge rejected handshake: max_conns reached"));
        assert!(!is_ws_capacity_error("connection refused"));
    }

    #[test]
    fn coprime_step_visits_every_index_once() {
        for len in [1, 2, 3, 4, 6, 10, 12, 100, 1000, 19967, 20000] {
            let step = coprime_step(len);
            assert_eq!(gcd(step, len), 1, "step={step} must be coprime to len={len}");
            let mut seen = vec![false; len];
            let mut idx = 0usize;
            for _ in 0..len {
                let slot = idx % len;
                assert!(!seen[slot], "duplicate visit at len={len} slot={slot}");
                seen[slot] = true;
                idx = idx.wrapping_add(step);
            }
            assert!(seen.into_iter().all(|b| b));
        }
    }

    #[test]
    fn terrain_sample_height_uses_height_table_and_bilinear_interp() {
        let mut heights = HashMap::new();
        let mut h = [0u8; 81];
        // Cell (0,0) corners: (0,0)=10, (1,0)=20, (0,1)=30, (1,1)=40
        h[0] = 10;
        h[9] = 20;
        h[1] = 30;
        h[10] = 40;
        heights.insert(0x1010, h);

        let mut custom_table = vec![0.0f32; 256];
        for (i, slot) in custom_table.iter_mut().enumerate() {
            *slot = i as f32 * 3.0 + 1.0; // non-linear/shifted table
        }
        let atlas = TerrainAtlas {
            heights,
            dry_walkable: vec![false; 65536],
            has_objects: vec![false; 65536],
            land_height_table: Some(custom_table),
        };
        let gx = 0x10 as f32 * METERS_PER_LANDBLOCK + 12.0; // tx = 0.5
        let gy = 0x10 as f32 * METERS_PER_LANDBLOCK + 12.0; // ty = 0.5
        // Average of (31, 61, 91, 121) = 76.0
        let z = atlas.sample_height(gx, gy);
        assert!((z - 76.0).abs() < 1e-4, "expected 76.0, got {z}");
    }

    #[test]
    fn dispersed_spawns_respect_chebyshev_separation() {
        let mut dry = vec![false; 65536];
        for x in 20usize..=60 {
            for y in 20usize..=60 {
                dry[(x << 8) | y] = true;
            }
        }
        let atlas = TerrainAtlas {
            heights: HashMap::new(),
            dry_walkable: dry,
            has_objects: vec![false; 65536],
            land_height_table: None,
        };
        let picks = atlas.pick_dispersed_spawns(16, 5);
        assert_eq!(picks.len(), 16);
        for i in 0..picks.len() {
            for j in (i + 1)..picks.len() {
                let dx = (picks[i].0 as i32 - picks[j].0 as i32).unsigned_abs() as usize;
                let dy = (picks[i].1 as i32 - picks[j].1 as i32).unsigned_abs() as usize;
                assert!(
                    dx.max(dy) >= 5,
                    "spawns {:?} and {:?} violated min_sep=5",
                    picks[i],
                    picks[j]
                );
            }
        }
    }

    #[test]
    fn crowd_orbit_reverses_and_stays_in_radius_bounds_when_blocked() {
        let mut r = 12.0;
        let mut ang = 0.0;
        let mut cw = true;
        let (gx1, gy1, hd1) =
            advance_crowd_orbit(1000.0, 2000.0, &mut r, 8.0, 28.0, &mut ang, &mut cw, 12.0, false, 1012.0, 2000.0);
        assert!(cw);
        assert!((gx1 - 1000.0).hypot(gy1 - 2000.0) - 12.0 < 1e-3);
        assert!((0.0..360.0).contains(&hd1));

        let prev_r = r;
        let (gx2, gy2, _hd2) =
            advance_crowd_orbit(1000.0, 2000.0, &mut r, 8.0, 28.0, &mut ang, &mut cw, 12.0, true, 1010.0, 2005.0);
        assert!(!cw, "blocked orbit must reverse direction");
        assert!((8.0..=28.0).contains(&r), "radius {r} escaped [8, 28]");
        assert!((r - prev_r).abs() > 1.0, "blocked orbit must shift radius");
        let dist = (gx2 - 1000.0).hypot(gy2 - 2000.0);
        assert!((dist - r).abs() < 1e-3);
    }
}
