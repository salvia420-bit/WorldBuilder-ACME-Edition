//! TERRAIN-HOP (2026-10-18) — the always-on hop detector (`__diag.hop`).
//!
//! Owner report: "there is still a bug in holtburger web where we will be
//! running along, usually down a little hill or something, and we do a little
//! jump."
//!
//! The JS rig plays the Falling take-off link on every local leave-ground edge
//! and the landing link on touchdown (entities.js `setAirborne`, fed by the
//! wasm TickMovement arm's airborne edges), so ONE airborne slice of a running
//! body reads as a little jump, and a body lifted onto something reads as one
//! without any airborne slice. The faithful outdoor driver keeps a runner on
//! walkable terrain over the retail terrain around Holtburg — seams, every
//! hillside, frame hitches, the spine with echoes (terrain_hop_real_tests.rs,
//! 0 lift-offs). What did move a runner off the ground there was a tree: the
//! post-transition scenery clamp with `?clampAlongGround`'s one-plane z carry
//! left the feet up to 0.36 m in the ground or 0.17 m above it across a
//! terrain crease (fixed by `?clampReplant`, system.rs `USE_CLAMP_REPLANT`).
//! This module records whatever else does it live. Per local manual-drive slice
//! (`MovementSystem::finish_manual_slice_via_transition`, the manual and the
//! sticky-idle lanes):
//!
//! * `liftOff` — a grounded slice ended airborne (`begin_fall`);
//! * `bounceLiftOff` — the landing bounce's lift-off quantum (the tail of an
//!   earlier airborne arc, `?landingBounce`), recorded apart;
//! * `pop` — a grounded slice whose feet rose more than [`HOP_POP_M`] against
//!   the drawn terrain under them — what the eye sees.
//!
//! Each incident carries a [`HopCause`]: a lift-off over no terrain (an
//! unstreamed landblock) or over streamed terrain; a pop explained by a
//! shallower wading depth (retail's shoreline steps), by a body an earlier
//! correction left in the ground, by a static object on the landcell — or
//! `unexplained`, the one to chase.
//!
//! Round 3: the pop measure is the feet against the drawn terrain, not against
//! the wading rest. The rest needs the wading depth, and within 1 cm of a depth
//! boundary the shallowest-depth probe can pick the other side's depth while
//! the physics rests on this side's — a rest "rise" with no movement at all
//! (terrain_hop_real_tests.rs replays the old rule as `REST-POP` beside the
//! detector's incidents).
//!
//! Each incident snapshots the slice: dt, begin/end pose, the offset it asked
//! for, the transition outcome (ok/moved/grounded, final contact plane, wall
//! normal, stationary-fall counter), the plane it entered on, the terrain
//! normal and wading depth at both ends, the static BSPs registered on both
//! landcells and how far the post-transition XY corrections (scenery, entity
//! cylinders) moved the body. 16-entry ring; at most one `[hop]` WARN line per
//! [`HOP_LOG_GAP_SECS`], for lift-offs and unexplained pops only.
//!
//! Cost: a few terrain-grid lookups per slice; the snapshot, ring write and log
//! line only on an incident. Diagnostics only — nothing here changes movement.

use std::cell::RefCell;
use std::fmt::Write as _;

use holtburger_common::Vector3;
use holtburger_common::position::WorldPosition;
use holtburger_world::WorldState;
use holtburger_world::spatial::transition::{TransitionInput, TransitionOutcome};
use web_time::Instant;

/// A grounded slice whose feet rose more than this against the drawn terrain
/// is a [`HopKind::Pop`].
pub const HOP_POP_M: f32 = 0.05;
/// A pop is a [`HopCause::Wade`] when the wading depth shrank by at least its
/// rise less this.
const WADE_SLACK_M: f32 = 0.02;
/// A pop is a [`HopCause::Resurface`] when the slice began with the feet more
/// than this under the deepest wading rest touching them.
const RESURFACE_M: f32 = 0.02;
/// Incident ring capacity.
pub const HOP_RING_CAP: usize = 16;
/// At most one `[hop]` console line per this many seconds (the ring still
/// records every incident).
const HOP_LOG_GAP_SECS: f32 = 2.0;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HopKind {
    /// A grounded slice ended airborne (`begin_fall`).
    #[default]
    LiftOff,
    /// The landing bounce lifted off (`?landingBounce`'s lift-off quantum).
    BounceLiftOff,
    /// A grounded slice whose feet rose more than [`HOP_POP_M`] against the
    /// drawn terrain under them.
    Pop,
}

impl HopKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LiftOff => "liftOff",
            Self::BounceLiftOff => "bounceLiftOff",
            Self::Pop => "pop",
        }
    }
}

/// What the slice shows about why a hop happened ([`cause`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HopCause {
    #[default]
    Unknown,
    /// liftOff with no terrain under the end pose: the landblock it ran onto
    /// is not streamed in.
    NoTerrain,
    /// liftOff over streamed terrain: the transition ended without a contact.
    LeftGround,
    /// bounceLiftOff: the landing bounce (`?landingBounce`).
    Bounce,
    /// pop: the wading depth shrank by the rise — a shoreline cell's wet
    /// quadrant to its dry one, or water to land (retail
    /// `CLandBlockStruct::calc_water_depth` steps 0.9 / 0.45 / 0.1 / 0).
    Wade,
    /// pop: the slice began with the feet under the deepest wading rest
    /// touching them, and the transition lifted them back out
    /// (`validate_walkable`): an earlier correction left the body in the
    /// ground.
    Resurface,
    /// pop: a static object (building, prop) is registered on the landcell —
    /// a step-up onto it.
    Object,
    /// pop: none of the above, on bare terrain.
    Unexplained,
}

impl HopCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::NoTerrain => "noTerrain",
            Self::LeftGround => "leftGround",
            Self::Bounce => "bounce",
            Self::Wade => "wade",
            Self::Resurface => "resurface",
            Self::Object => "object",
            Self::Unexplained => "unexplained",
        }
    }
}

/// One manual-drive slice as the movement system saw it. Poses are
/// landblock-local `[x, y, z]`; `NaN` = not applicable (indoors, no terrain,
/// no plane).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HopSlice {
    pub dt: f32,
    pub was_airborne: bool,
    pub is_airborne: bool,
    /// This slice was the landing bounce's lift-off quantum.
    pub bounce_lift: bool,
    pub begin_cell: u32,
    pub begin: [f32; 3],
    pub end_cell: u32,
    pub end: [f32; 3],
    /// The offset the transition was asked for (after the PositionManager
    /// chain), world-frame metres.
    pub offset: [f32; 3],
    /// Feet above the drawn outdoor terrain under them, metres (wading in a
    /// shoreline cell reads about `−depth`). `NaN` indoors / no terrain.
    pub excess_begin: f32,
    pub excess_end: f32,
    pub transition_ok: bool,
    pub moved: bool,
    pub grounded: bool,
    /// The transition's final contact plane normal z, and its cell.
    pub contact_nz: f32,
    pub contact_cell: u32,
    /// The plane the slice entered on (`PlayerState::last_contact_plane`).
    pub entry_nz: f32,
    /// The last-known contact (wall) plane normal z.
    pub wall_nz: f32,
    pub terrain_nz_begin: f32,
    pub terrain_nz_end: f32,
    /// The shallowest wading depth touching the begin / end point (a point on
    /// a 24 m cell edge or a shoreline quadrant line touches both sides).
    pub depth_begin: f32,
    pub depth_end: f32,
    /// The deepest wading depth touching the begin point.
    pub depth_begin_deep: f32,
    /// Static BSPs (buildings, props) registered on the begin / end landcell.
    pub statics_begin: u32,
    pub statics_end: u32,
    /// How far (XY, metres) the post-transition corrections — the scenery
    /// clamp and push-out, the entity-cylinder clamp — moved the body off the
    /// transition's result.
    pub clamp_m: f32,
    pub frames_stationary_fall: u8,
    /// Vertical velocity after the slice (m/s).
    pub vz: f32,
}

impl HopSlice {
    /// The feet's rise against the drawn terrain over the slice.
    pub fn rise(&self) -> f32 {
        self.excess_end - self.excess_begin
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HopIncident {
    pub seq: u32,
    pub at_ms: f64,
    pub kind: HopKind,
    pub cause: HopCause,
    pub slice: HopSlice,
}

/// What, if anything, a slice is.
pub fn classify(s: &HopSlice) -> Option<HopKind> {
    if s.was_airborne {
        return None;
    }
    if s.is_airborne {
        return Some(if s.bounce_lift {
            HopKind::BounceLiftOff
        } else {
            HopKind::LiftOff
        });
    }
    // NaN (indoors / no terrain) compares false: no pop.
    if s.rise() > HOP_POP_M {
        return Some(HopKind::Pop);
    }
    None
}

/// Why a hop of `kind` happened, as far as the slice shows.
pub fn cause(kind: HopKind, s: &HopSlice) -> HopCause {
    // Landcells are 1..=64; EnvCells (indoors) start at 0x100.
    let end_outdoors = (s.end_cell & 0xFFFF) < 0x100;
    match kind {
        HopKind::LiftOff if s.excess_end.is_nan() && end_outdoors => HopCause::NoTerrain,
        HopKind::LiftOff => HopCause::LeftGround,
        HopKind::BounceLiftOff => HopCause::Bounce,
        HopKind::Pop => {
            let shallower = s.depth_begin_deep - s.depth_end;
            if shallower > 0.0 && shallower >= s.rise() - WADE_SLACK_M {
                HopCause::Wade
            } else if s.excess_begin + s.depth_begin_deep < -RESURFACE_M {
                HopCause::Resurface
            } else if s.statics_begin + s.statics_end > 0 {
                HopCause::Object
            } else {
                HopCause::Unexplained
            }
        }
    }
}

/// The shallowest and the deepest wading depth touching world `(x, y)`: on a
/// 24 m cell edge (or a shoreline quadrant line) the point belongs to both
/// sides and either side's rest is legitimate (the world-frame driver lands
/// steps exactly on edges).
fn depth_range(world: &WorldState, x: f32, y: f32) -> (f32, f32) {
    const E: f32 = 0.01;
    [(0.0, 0.0), (E, 0.0), (-E, 0.0), (0.0, E), (0.0, -E)]
        .iter()
        .map(|&(dx, dy)| world.water_depth_at(x + dx, y + dy))
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), d| {
            (lo.min(d), hi.max(d))
        })
}

/// One end of a slice on the outdoor terrain; `NaN`s indoors / no terrain.
#[derive(Clone, Copy)]
struct TerrainSample {
    /// Feet above the drawn terrain.
    excess: f32,
    depth: f32,
    depth_deep: f32,
    nz: f32,
}

impl TerrainSample {
    const NONE: Self = Self {
        excess: f32::NAN,
        depth: f32::NAN,
        depth_deep: f32::NAN,
        nz: f32::NAN,
    };
}

fn terrain_sample(world: &WorldState, pose: &WorldPosition) -> TerrainSample {
    if pose.is_indoors() {
        return TerrainSample::NONE;
    }
    let g = pose.global_coords();
    let Some(ground) = world.terrain_height_at(g.x, g.y) else {
        return TerrainSample::NONE;
    };
    let (depth, depth_deep) = depth_range(world, g.x, g.y);
    let nz = world
        .terrain_normal_at(g.x, g.y)
        .map(|n| n.z)
        .unwrap_or(f32::NAN);
    TerrainSample {
        excess: g.z - ground,
        depth,
        depth_deep,
        nz,
    }
}

fn statics_on(world: &WorldState, pose: &WorldPosition) -> u32 {
    let cell = world.scene.current_cell(pose);
    world.scene.cell_static_physics_bsp(cell).len() as u32
}

fn xyz(v: Vector3) -> [f32; 3] {
    [v.x, v.y, v.z]
}

/// Build the slice record from the manual slice's pieces (system.rs calls this
/// once per slice, after the pose is final and before it is written back).
/// `clamp_m` is how far the post-transition XY corrections moved the body off
/// the transition's result (measured before `?clampReplant` re-runs it).
#[allow(clippy::too_many_arguments)]
pub fn slice_from(
    world: &WorldState,
    input: &TransitionInput,
    outcome: &TransitionOutcome,
    end: &WorldPosition,
    offset: Vector3,
    dt: f32,
    was_airborne: bool,
    bounce_lift: bool,
    transition_ok: bool,
    moved: bool,
    clamp_m: f32,
) -> HopSlice {
    let begin = terrain_sample(world, &input.begin);
    let finish = terrain_sample(world, end);
    let (contact_nz, contact_cell) = outcome
        .contact_plane
        .map(|(p, c)| (p.normal.z, c))
        .unwrap_or((f32::NAN, 0));
    HopSlice {
        dt,
        was_airborne,
        is_airborne: world.player.is_airborne,
        bounce_lift,
        begin_cell: input.begin.landblock_id.0,
        begin: xyz(input.begin.coords),
        end_cell: end.landblock_id.0,
        end: xyz(end.coords),
        offset: xyz(offset),
        excess_begin: begin.excess,
        excess_end: finish.excess,
        transition_ok,
        moved,
        grounded: outcome.grounded,
        contact_nz,
        contact_cell,
        entry_nz: input
            .last_contact_plane
            .map(|(p, _)| p.normal.z)
            .unwrap_or(f32::NAN),
        wall_nz: outcome.wall_normal.map(|n| n.z).unwrap_or(f32::NAN),
        terrain_nz_begin: begin.nz,
        terrain_nz_end: finish.nz,
        depth_begin: begin.depth,
        depth_end: finish.depth,
        depth_begin_deep: begin.depth_deep,
        statics_begin: statics_on(world, &input.begin),
        statics_end: statics_on(world, end),
        clamp_m,
        frames_stationary_fall: outcome.frames_stationary_fall,
        vz: world.player.vertical_velocity,
    }
}

struct HopRing {
    buf: [HopIncident; HOP_RING_CAP],
    head: usize,
    len: usize,
    total: u32,
    epoch: Option<Instant>,
    last_log: Option<Instant>,
}

impl HopRing {
    fn new() -> Self {
        Self {
            buf: [HopIncident::default(); HOP_RING_CAP],
            head: 0,
            len: 0,
            total: 0,
            epoch: None,
            last_log: None,
        }
    }
}

thread_local! {
    static RING: RefCell<HopRing> = RefCell::new(HopRing::new());
}

/// Whether an incident of this cause gets a console line: the explained ones
/// (a wading step, a step-up onto an object, the landing bounce) stay in the
/// ring only.
pub fn needs_a_look(cause: HopCause) -> bool {
    !matches!(cause, HopCause::Wade | HopCause::Object | HopCause::Bounce)
}

/// Classify one slice and, when it is a hop, stamp and store it, and log the
/// ones that [`needs_a_look`] (rate-limited). Returns the incident.
pub fn observe(slice: HopSlice) -> Option<HopIncident> {
    let kind = classify(&slice)?;
    let now = Instant::now();
    let mut incident = HopIncident {
        seq: 0,
        at_ms: 0.0,
        kind,
        cause: cause(kind, &slice),
        slice,
    };
    let log_line = RING.with(|ring| {
        let mut ring = ring.borrow_mut();
        let epoch = *ring.epoch.get_or_insert(now);
        ring.total = ring.total.saturating_add(1);
        incident.seq = ring.total;
        incident.at_ms = now.saturating_duration_since(epoch).as_secs_f64() * 1000.0;
        let head = ring.head;
        ring.buf[head] = incident;
        ring.head = (head + 1) % HOP_RING_CAP;
        ring.len = (ring.len + 1).min(HOP_RING_CAP);
        let due = needs_a_look(incident.cause)
            && ring.last_log.is_none_or(|at| {
                now.saturating_duration_since(at).as_secs_f32() >= HOP_LOG_GAP_SECS
            });
        if due {
            ring.last_log = Some(now);
        }
        due
    });
    if log_line {
        log::warn!("{}", summary_line(&incident));
    }
    Some(incident)
}

/// The one-line console summary.
pub fn summary_line(i: &HopIncident) -> String {
    let s = &i.slice;
    format!(
        "[hop] #{} {} ({}) cell 0x{:08X}->0x{:08X} rise {} feet {}->{} dt {:.1}ms ok={} moved={} grounded={} contact nz {} entry nz {} terrain nz {}->{} depth {}->{} statics {}/{} clamp {} — __diag.hop.tail()",
        i.seq,
        i.kind.as_str(),
        i.cause.as_str(),
        s.begin_cell,
        s.end_cell,
        fmt_num(s.rise(), 3),
        fmt_num(s.excess_begin, 3),
        fmt_num(s.excess_end, 3),
        s.dt * 1000.0,
        u8::from(s.transition_ok),
        u8::from(s.moved),
        u8::from(s.grounded),
        fmt_num(s.contact_nz, 3),
        fmt_num(s.entry_nz, 3),
        fmt_num(s.terrain_nz_begin, 3),
        fmt_num(s.terrain_nz_end, 3),
        fmt_num(s.depth_begin, 2),
        fmt_num(s.depth_end, 2),
        s.statics_begin,
        s.statics_end,
        fmt_num(s.clamp_m, 3),
    )
}

fn fmt_num(v: f32, digits: usize) -> String {
    if v.is_finite() {
        format!("{v:+.digits$}")
    } else {
        "-".to_string()
    }
}

/// Incidents recorded on this thread (the wasm instance in the browser).
pub fn count() -> u32 {
    RING.with(|ring| ring.borrow().total)
}

/// Forget every incident (the count restarts too).
pub fn clear() {
    RING.with(|ring| *ring.borrow_mut() = HopRing::new());
}

/// The kept incidents, oldest first.
pub fn incidents() -> Vec<HopIncident> {
    RING.with(|ring| {
        let ring = ring.borrow();
        let start = (ring.head + HOP_RING_CAP - ring.len) % HOP_RING_CAP;
        (0..ring.len)
            .map(|k| ring.buf[(start + k) % HOP_RING_CAP])
            .collect()
    })
}

/// The ring, oldest first, as JSON: `{"count":N,"incidents":[…]}`.
pub fn read_json() -> String {
    let count = count();
    let kept = incidents();
    let mut out = String::with_capacity(64 + kept.len() * 700);
    let _ = write!(out, "{{\"count\":{count},\"incidents\":[");
    for (k, i) in kept.iter().enumerate() {
        if k > 0 {
            out.push(',');
        }
        push_incident(&mut out, i);
    }
    out.push_str("]}");
    out
}

fn push_num(out: &mut String, key: &str, v: f32) {
    if v.is_finite() {
        let _ = write!(out, "\"{key}\":{v},");
    } else {
        let _ = write!(out, "\"{key}\":null,");
    }
}

fn push_vec(out: &mut String, key: &str, v: [f32; 3]) {
    let f = |x: f32| {
        if x.is_finite() {
            format!("{x}")
        } else {
            "null".to_string()
        }
    };
    let _ = write!(out, "\"{key}\":[{},{},{}],", f(v[0]), f(v[1]), f(v[2]));
}

fn push_bool(out: &mut String, key: &str, v: bool) {
    let _ = write!(out, "\"{key}\":{v},");
}

fn push_int(out: &mut String, key: &str, v: i64) {
    let _ = write!(out, "\"{key}\":{v},");
}

fn push_incident(out: &mut String, i: &HopIncident) {
    let s = &i.slice;
    out.push('{');
    push_int(out, "seq", i64::from(i.seq));
    let _ = write!(out, "\"atMs\":{:.1},", i.at_ms);
    let _ = write!(out, "\"kind\":\"{}\",", i.kind.as_str());
    let _ = write!(out, "\"cause\":\"{}\",", i.cause.as_str());
    push_num(out, "dtMs", s.dt * 1000.0);
    push_num(out, "rise", s.rise());
    push_int(out, "beginCell", i64::from(s.begin_cell));
    push_vec(out, "begin", s.begin);
    push_int(out, "endCell", i64::from(s.end_cell));
    push_vec(out, "end", s.end);
    push_vec(out, "offset", s.offset);
    push_num(out, "excessBegin", s.excess_begin);
    push_num(out, "excessEnd", s.excess_end);
    push_bool(out, "transitionOk", s.transition_ok);
    push_bool(out, "moved", s.moved);
    push_bool(out, "grounded", s.grounded);
    push_num(out, "contactNz", s.contact_nz);
    push_int(out, "contactCell", i64::from(s.contact_cell));
    push_num(out, "entryNz", s.entry_nz);
    push_num(out, "wallNz", s.wall_nz);
    push_num(out, "terrainNzBegin", s.terrain_nz_begin);
    push_num(out, "terrainNzEnd", s.terrain_nz_end);
    push_num(out, "depthBegin", s.depth_begin);
    push_num(out, "depthEnd", s.depth_end);
    push_num(out, "depthBeginDeep", s.depth_begin_deep);
    push_int(out, "staticsBegin", i64::from(s.statics_begin));
    push_int(out, "staticsEnd", i64::from(s.statics_end));
    push_num(out, "clampM", s.clamp_m);
    push_int(
        out,
        "framesStationaryFall",
        i64::from(s.frames_stationary_fall),
    );
    push_bool(out, "bounceLift", s.bounce_lift);
    // Last field without the trailing comma.
    if s.vz.is_finite() {
        let _ = write!(out, "\"vz\":{}", s.vz);
    } else {
        out.push_str("\"vz\":null");
    }
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grounded_slice() -> HopSlice {
        HopSlice {
            dt: 1.0 / 60.0,
            begin_cell: 0xA9B4_0019,
            end_cell: 0xA9B4_0019,
            begin: [84.0, 12.0, 94.005],
            end: [84.0, 12.3, 94.005],
            excess_begin: 0.005,
            excess_end: 0.005,
            transition_ok: true,
            moved: true,
            grounded: true,
            contact_nz: 1.0,
            contact_cell: 0xA9B4_0019,
            entry_nz: 1.0,
            wall_nz: f32::NAN,
            terrain_nz_begin: 1.0,
            terrain_nz_end: 1.0,
            depth_begin: 0.0,
            depth_end: 0.0,
            ..HopSlice::default()
        }
    }

    #[test]
    fn classify_names_lift_offs_bounces_and_pops() {
        let ground = grounded_slice();
        assert_eq!(classify(&ground), None, "a planted run is not a hop");

        let lift = HopSlice {
            is_airborne: true,
            grounded: false,
            ..ground
        };
        assert_eq!(classify(&lift), Some(HopKind::LiftOff));
        let bounce = HopSlice {
            bounce_lift: true,
            ..lift
        };
        assert_eq!(classify(&bounce), Some(HopKind::BounceLiftOff));

        let pop = HopSlice {
            excess_end: 0.005 + HOP_POP_M + 0.01,
            ..ground
        };
        assert_eq!(classify(&pop), Some(HopKind::Pop));
        let small = HopSlice {
            excess_end: 0.005 + HOP_POP_M - 0.01,
            ..ground
        };
        assert_eq!(classify(&small), None, "under the pop threshold");
        let sink = HopSlice {
            excess_end: -0.4,
            ..ground
        };
        assert_eq!(classify(&sink), None, "a drop is not a hop");

        let indoors = HopSlice {
            excess_begin: f32::NAN,
            excess_end: f32::NAN,
            ..ground
        };
        assert_eq!(classify(&indoors), None, "no terrain rest indoors");

        let flying = HopSlice {
            was_airborne: true,
            is_airborne: true,
            ..ground
        };
        assert_eq!(classify(&flying), None, "already airborne");
    }

    #[test]
    fn cause_names_what_the_slice_shows() {
        let ground = grounded_slice();
        let lift = HopSlice {
            is_airborne: true,
            grounded: false,
            ..ground
        };
        assert_eq!(cause(HopKind::LiftOff, &lift), HopCause::LeftGround);
        let off_the_map = HopSlice {
            excess_end: f32::NAN,
            end_cell: 0xAAB4_0003,
            ..lift
        };
        assert_eq!(cause(HopKind::LiftOff, &off_the_map), HopCause::NoTerrain);
        let indoors = HopSlice {
            end_cell: 0xA9B4_0105,
            ..off_the_map
        };
        assert_eq!(
            cause(HopKind::LiftOff, &indoors),
            HopCause::LeftGround,
            "no terrain indoors is not an unstreamed landblock"
        );
        assert_eq!(cause(HopKind::BounceLiftOff, &lift), HopCause::Bounce);

        // Wet quadrant (0.45) to dry quadrant (0.1): the feet rise 0.35 m.
        let wade = HopSlice {
            excess_begin: -0.445,
            excess_end: -0.095,
            depth_begin: 0.45,
            depth_begin_deep: 0.45,
            depth_end: 0.1,
            ..ground
        };
        assert_eq!(cause(HopKind::Pop, &wade), HopCause::Wade);
        // Deep water to the shore, the begin on the cell edge (0.9 | 0.45).
        let edge = HopSlice {
            excess_begin: -0.895,
            excess_end: -0.445,
            depth_begin: 0.45,
            depth_begin_deep: 0.9,
            depth_end: 0.45,
            ..ground
        };
        assert_eq!(cause(HopKind::Pop, &edge), HopCause::Wade);
        // Dry ground, the feet 8 cm in it: lifted back out.
        let resurface = HopSlice {
            excess_begin: -0.08,
            ..ground
        };
        assert_eq!(cause(HopKind::Pop, &resurface), HopCause::Resurface);
        // A 0.875 m step-up next to 31 props.
        let object = HopSlice {
            excess_end: 0.88,
            statics_begin: 31,
            statics_end: 31,
            ..ground
        };
        assert_eq!(cause(HopKind::Pop, &object), HopCause::Object);
        // The round-1 far-edge wrap: the rest jumped from the wet corner's
        // 0.45 to the dry corner's 0.1 with no depth change at the probe.
        let wrap = HopSlice {
            excess_begin: -0.445,
            excess_end: -0.095,
            depth_begin: 0.45,
            depth_begin_deep: 0.45,
            depth_end: 0.45,
            ..ground
        };
        assert_eq!(cause(HopKind::Pop, &wrap), HopCause::Unexplained);

        // Console lines only for the ones that need a look.
        for c in [
            HopCause::NoTerrain,
            HopCause::LeftGround,
            HopCause::Resurface,
            HopCause::Unexplained,
        ] {
            assert!(needs_a_look(c), "{c:?} logs");
        }
        for c in [HopCause::Wade, HopCause::Object, HopCause::Bounce] {
            assert!(!needs_a_look(c), "{c:?} stays in the ring");
        }
    }

    #[test]
    fn the_ring_keeps_the_last_incidents_and_reads_back_as_json() {
        clear();
        assert_eq!(count(), 0);
        assert!(observe(grounded_slice()).is_none(), "nothing to record");
        assert_eq!(count(), 0);

        let lift = HopSlice {
            is_airborne: true,
            grounded: false,
            contact_nz: f32::NAN,
            ..grounded_slice()
        };
        for _ in 0..(HOP_RING_CAP + 3) {
            observe(lift);
        }
        let pop = HopSlice {
            excess_end: 0.4,
            ..grounded_slice()
        };
        let last = observe(pop).expect("a pop");
        assert_eq!(last.kind, HopKind::Pop);
        assert_eq!(last.cause, HopCause::Unexplained);
        assert_eq!(count() as usize, HOP_RING_CAP + 4);
        let kept = incidents();
        assert_eq!(kept.len(), HOP_RING_CAP);
        assert_eq!(kept.last().map(|i| i.seq), Some(last.seq));
        assert!(
            kept.windows(2).all(|w| w[0].seq + 1 == w[1].seq),
            "oldest first"
        );

        let json = read_json();
        assert!(json.starts_with(&format!("{{\"count\":{},\"incidents\":[", HOP_RING_CAP + 4)));
        assert!(json.ends_with("]}"));
        assert!(json.contains("\"kind\":\"liftOff\",\"cause\":\"leftGround\""));
        assert!(json.contains("\"kind\":\"pop\",\"cause\":\"unexplained\""));
        assert!(json.contains("\"clampM\":0,"));
        assert!(json.contains("\"contactNz\":null"), "NaN reads as null");
        assert!(json.contains("\"wallNz\":null"));
        assert!(
            !json.contains("NaN") && !json.contains(",}"),
            "valid JSON: {json}"
        );
        assert!(summary_line(&last).starts_with(&format!("[hop] #{} pop (unexplained)", last.seq)));

        clear();
        assert_eq!(count(), 0);
        assert_eq!(read_json(), "{\"count\":0,\"incidents\":[]}");
    }
}
