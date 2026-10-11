//! SLOW-RUN (2026-10-11) — the always-on slow-run detector.
//!
//! Owner report: "sometimes when moving in a certain direction it seems theres
//! a server induced lag or something that happens sporadically and makes the
//! character a little bit slower until i stop the movement and restart the
//! movement again."
//!
//! Several mechanisms can hold a held-key run below its own speed until the next
//! fresh press, and only a live session can tell them apart. This module
//! measures every local manual-drive slice (`MovementSystem::
//! advance_manual_slice_via_transition`) against the speed the HELD keys should
//! produce, and records an incident when the realized planar speed stays more
//! than 10 % under it for more than 0.5 s of grounded running. The slice loss
//! is split into four stages, and the incident names the stage that lost the
//! most:
//!
//! 1. **rate**: the capability run rate (the server-published `my_run_rate`
//!    under `?serverRunRate`) against the local composition (probed once per
//!    second of running);
//! 2. **drive**: the drive the slice actually used against the held keys. It
//!    loses when the server's interpreted state drives (latch low or server
//!    control), when the `?castHoldReclaim` lock killed a held W, or when the
//!    gait differs;
//! 3. **leash**: the retail `PositionManager::adjust_offset` chain
//!    (acclient.c:388287). It loses when `ConstraintManager::adjust_offset`
//!    (:389478) scales the run because no self-position echo re-armed
//!    `ConstrainTo` (:145209) in time, or when interpolation or sticky replace
//!    the offset;
//! 4. **transition**: collision, terrain and slope clamping.
//!
//! Each incident carries a context snapshot of every cause candidate (control
//! flag, autonomy latch, MoveTo/projection/interp/sticky, leash budget, echo /
//! AP / MoveToState / server-motion ages, run-rate sources, held keys and
//! drive), goes into a 16-entry ring and prints one rate-limited
//! `[slow-run]` console line (WARN, the level the wasm console logger routes).
//!
//! Read from devtools: `__diag.slowRun.tail()` / `.summary()` (JS surface
//! `scene3d/diag/slow_run.js`, through the wasm `slowRunDiag` export).
//!
//! Cost: one `Cell` read-modify-write and a handful of float ops per slice.
//! The context snapshot, the ring write and the log line only happen on an
//! incident (at 0.5 s into a slow episode, then once per second while it
//! lasts). Nothing allocates in the steady state; the JSON is built on read.
//! Diagnostics only — nothing here changes movement.

use std::cell::{Cell, RefCell};
use std::fmt::Write as _;

use web_time::Instant;

/// A slice is slow when it realizes less than this fraction of the speed the
/// held keys should produce.
pub const SLOW_RUN_RATIO: f32 = 0.9;
/// An episode becomes an incident once its slow slices add up to this long
/// (grounded, keys held, no fast slice in between).
pub const SLOW_RUN_HOLD_SECS: f32 = 0.5;
/// While an episode lasts, another incident (over the slices since the last
/// one) every this many seconds, so a slowdown whose cause changes mid-run
/// (a cast echo, then a dead W) shows both.
pub const SLOW_RUN_REPEAT_SECS: f32 = 1.0;
/// Ignore crawls (walk-backstep turns, a near-zero intent).
pub const SLOW_RUN_MIN_EXPECTED_MPS: f32 = 1.0;
/// The run-rate probe cadence (the composition walks the burden inputs, so it
/// is not read every slice).
pub const SLOW_RUN_RATE_PROBE_SECS: f32 = 1.0;
/// Incident ring capacity.
pub const SLOW_RUN_RING_CAP: usize = 16;
/// At most one `[slow-run]` console line per this many seconds (the ring
/// still records every incident).
const SLOW_RUN_LOG_GAP_SECS: f32 = 5.0;

/// One manual-drive slice, as the movement system measured it. Speeds are
/// planar m/s.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlowRunSlice {
    pub dt: f32,
    /// The held keys carry locomotion (forward/backstep/sidestep or auto-run).
    pub locomotion_held: bool,
    /// Grounded at slice entry AND exit (jumps and falls are not runs).
    pub grounded: bool,
    /// What the HELD keys produce at the capability run rate.
    pub expected_mps: f32,
    /// What the slice's drive asked for (after the interpreted-state swap).
    pub intended_mps: f32,
    /// After the PositionManager chain (interp → sticky → leash).
    pub leash_mps: f32,
    /// What the transition realized.
    pub realized_mps: f32,
    /// `capability rate / composed rate` when probed this slice
    /// ([`SlowRunMonitor::rate_probe_due`]); `NaN` = not probed.
    pub rate_ratio: f32,
}

/// The stage (and, inside it, the carrier) that lost the most speed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SlowRunCause {
    /// The capability run rate (server latch) sits below the local
    /// composition.
    RunRate,
    /// The server's interpreted state drives the body (autonomy latch low or
    /// `controlled_by_server` up), not the held keys.
    ServerControl,
    /// The `?castHoldReclaim` lock killed a held W/S and nothing revived it.
    CastForwardLock,
    /// The drive differs from the held keys for another reason (gait, axes).
    DriveMismatch,
    /// `ConstraintManager::adjust_offset` scaled the run (the retail
    /// "lag slowdown": no self-position echo re-armed the leash in time).
    Leash,
    /// `InterpolationManager` replaced the offset.
    Interpolation,
    /// `StickyManager` replaced the offset.
    Sticky,
    /// The transition clamped the move (walls, objects, slope).
    Collision,
    #[default]
    Unknown,
}

impl SlowRunCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunRate => "runRate",
            Self::ServerControl => "serverControl",
            Self::CastForwardLock => "castForwardLock",
            Self::DriveMismatch => "driveMismatch",
            Self::Leash => "leash",
            Self::Interpolation => "interpolation",
            Self::Sticky => "sticky",
            Self::Collision => "collision",
            Self::Unknown => "unknown",
        }
    }
}

/// Every cause candidate at incident time. Ages are seconds (`NaN` = never).
/// Axes are −1/0/+1 (forward: backstep/idle/forward; side: left/idle/right;
/// turn: left/idle/right).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlowRunContext {
    /// The scene's `controlled_by_server` mirror.
    pub server_controlled: bool,
    /// `last_move_was_autonomous` (true = the held keys drive).
    pub latch_autonomous: bool,
    /// The interpreted (server) state drives this slice.
    pub interpreted_drive: bool,
    /// Local registry minterp pending completion nodes.
    pub pending_motions: u32,
    pub moveto_active: bool,
    pub projection_active: bool,
    pub interpolating: bool,
    pub sticky_active: bool,
    /// `?castHoldReclaim` scope is open (cast window or cast request in flight).
    pub cast_lock_active: bool,
    /// The last reclaim under that lock left a held W/S dead.
    pub forward_killed_by_cast_lock: bool,
    pub leash_armed: bool,
    /// `ConstraintManager::constraint_pos_offset` — the travel budget since the
    /// last `ConstrainTo` (start 10 m / max 50 m outdoors, 5 / 20 indoors).
    pub leash_budget_m: f32,
    pub indoor: bool,
    /// Since the last accepted self UpdatePosition (the leash re-arm).
    pub echo_age_s: f32,
    /// Since our last AutonomousPosition.
    pub ap_age_s: f32,
    /// Since our last MoveToState.
    pub move_to_state_age_s: f32,
    /// Since the last non-autonomous self UpdateMotion.
    pub server_motion_age_s: f32,
    /// That motion's RunForward rate (`NaN` = not a run / none seen).
    pub server_motion_rate: f32,
    /// Retail `SendPositionEvent` can send right now (contact + walkable).
    pub position_event_ready: bool,
    pub heartbeats_sent: u32,
    /// The run rate the slice used (`SelfMovementCapabilities`).
    pub capability_rate: f32,
    /// `PlayerState::server_run_rate` (`NaN` = none latched).
    pub server_run_rate: f32,
    /// The local skill + burden composition (`NaN` = unavailable).
    pub composed_run_rate: f32,
    pub held_forward: i8,
    pub held_side: i8,
    pub held_turn: i8,
    pub held_run: bool,
    pub drive_forward: i8,
    pub drive_side: i8,
    pub drive_turn: i8,
    pub drive_run: bool,
}

/// One recorded slow episode. Speeds are averages over the episode.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlowRunIncident {
    /// 1-based incident number (per thread / wasm instance).
    pub seq: u32,
    /// Milliseconds since the first incident-capable observation.
    pub at_ms: f64,
    pub slow_secs: f32,
    pub expected_mps: f32,
    /// `expected` raised to the composed rate when the capability rate is lower.
    pub reference_mps: f32,
    pub intended_mps: f32,
    pub leash_mps: f32,
    pub realized_mps: f32,
    pub rate_ratio: f32,
    pub drive_ratio: f32,
    pub leash_ratio: f32,
    pub transition_ratio: f32,
    pub cause: SlowRunCause,
    pub ctx: SlowRunContext,
}

#[derive(Clone, Copy, Debug)]
struct SlowRunWindow {
    /// Slow time in this episode.
    slow_secs: f32,
    /// The episode records its next incident at this much slow time.
    next_record_secs: f32,
    /// Sums since the episode start or the last incident (speed · dt).
    sum_dt: f32,
    sum_expected: f32,
    sum_reference: f32,
    sum_intended: f32,
    sum_leash: f32,
    sum_realized: f32,
    /// Eligible running since the last rate probe.
    rate_probe_secs: f32,
    /// The last probed `capability / composed` ratio (1.0 until probed).
    rate_ratio: f32,
}

impl Default for SlowRunWindow {
    fn default() -> Self {
        Self {
            slow_secs: 0.0,
            next_record_secs: SLOW_RUN_HOLD_SECS,
            sum_dt: 0.0,
            sum_expected: 0.0,
            sum_reference: 0.0,
            sum_intended: 0.0,
            sum_leash: 0.0,
            sum_realized: 0.0,
            // The first eligible slice probes.
            rate_probe_secs: SLOW_RUN_RATE_PROBE_SECS,
            rate_ratio: 1.0,
        }
    }
}

impl SlowRunWindow {
    /// Drop the episode, keep the rate-probe bookkeeping.
    fn reset_episode(&mut self) {
        *self = Self {
            rate_probe_secs: self.rate_probe_secs,
            rate_ratio: self.rate_ratio,
            ..Self::default()
        };
    }

    /// Start the next incident's sums (the episode goes on).
    fn reset_sums(&mut self) {
        self.sum_dt = 0.0;
        self.sum_expected = 0.0;
        self.sum_reference = 0.0;
        self.sum_intended = 0.0;
        self.sum_leash = 0.0;
        self.sum_realized = 0.0;
    }
}

/// Per-`MovementSystem` episode tracker. `Cell`-based because the manual slice
/// runs under `&self` (the `fu3_diag_tick` precedent).
#[derive(Debug, Default)]
pub struct SlowRunMonitor {
    window: Cell<SlowRunWindow>,
    /// The slice's post-chain planar offset (m), noted by the transition tail
    /// and consumed by the observer of the same slice.
    leash_offset_m: Cell<Option<f32>>,
    last: Cell<Option<SlowRunIncident>>,
    recorded: Cell<u32>,
}

impl SlowRunMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The transition tail notes the slice's post-chain planar offset.
    pub fn note_leash_offset(&self, planar_m: f32) {
        self.leash_offset_m.set(Some(planar_m));
    }

    /// Consume the offset [`Self::note_leash_offset`] stored for this slice.
    pub fn take_leash_offset(&self) -> Option<f32> {
        self.leash_offset_m.take()
    }

    /// `true` once per [`SLOW_RUN_RATE_PROBE_SECS`] of eligible running: the
    /// caller then fills [`SlowRunSlice::rate_ratio`].
    pub fn rate_probe_due(&self) -> bool {
        self.window.get().rate_probe_secs >= SLOW_RUN_RATE_PROBE_SECS
    }

    /// The last incident this monitor recorded.
    pub fn last_incident(&self) -> Option<SlowRunIncident> {
        self.last.get()
    }

    /// Incidents this monitor recorded.
    pub fn incidents_recorded(&self) -> u32 {
        self.recorded.get()
    }

    /// Fold one slice in. Returns an incident when this slice takes a slow
    /// episode to [`SLOW_RUN_HOLD_SECS`], then every [`SLOW_RUN_REPEAT_SECS`]
    /// while it lasts; `context` is only called then.
    pub fn observe(
        &self,
        slice: SlowRunSlice,
        context: impl FnOnce() -> SlowRunContext,
    ) -> Option<SlowRunIncident> {
        let mut w = self.window.get();
        if slice.rate_ratio.is_finite() {
            w.rate_ratio = slice.rate_ratio;
            w.rate_probe_secs = 0.0;
        }
        let eligible = slice.locomotion_held
            && slice.grounded
            && slice.dt > 0.0
            && slice.expected_mps >= SLOW_RUN_MIN_EXPECTED_MPS;
        if !eligible {
            w.reset_episode();
            self.window.set(w);
            return None;
        }
        if !slice.rate_ratio.is_finite() {
            w.rate_probe_secs += slice.dt;
        }
        // A server-latched rate below the composition lowers the body's own
        // expectation; measure against the composed rate instead.
        let reference_mps = if w.rate_ratio > 1e-3 && w.rate_ratio < 1.0 {
            slice.expected_mps / w.rate_ratio
        } else {
            slice.expected_mps
        };
        if slice.realized_mps >= SLOW_RUN_RATIO * reference_mps {
            w.reset_episode();
            self.window.set(w);
            return None;
        }
        w.slow_secs += slice.dt;
        w.sum_dt += slice.dt;
        w.sum_expected += slice.expected_mps * slice.dt;
        w.sum_reference += reference_mps * slice.dt;
        w.sum_intended += slice.intended_mps * slice.dt;
        w.sum_leash += slice.leash_mps * slice.dt;
        w.sum_realized += slice.realized_mps * slice.dt;
        if w.slow_secs < w.next_record_secs {
            self.window.set(w);
            return None;
        }
        let sums = w;
        w.next_record_secs = w.slow_secs + SLOW_RUN_REPEAT_SECS;
        w.reset_sums();
        self.window.set(w);

        let inv = 1.0 / sums.sum_dt.max(1e-6);
        let mut incident = SlowRunIncident {
            seq: 0,
            at_ms: 0.0,
            slow_secs: sums.slow_secs,
            expected_mps: sums.sum_expected * inv,
            reference_mps: sums.sum_reference * inv,
            intended_mps: sums.sum_intended * inv,
            leash_mps: sums.sum_leash * inv,
            realized_mps: sums.sum_realized * inv,
            rate_ratio: sums.rate_ratio,
            drive_ratio: ratio(sums.sum_intended, sums.sum_expected),
            leash_ratio: ratio(sums.sum_leash, sums.sum_intended),
            transition_ratio: ratio(sums.sum_realized, sums.sum_leash),
            cause: SlowRunCause::Unknown,
            ctx: context(),
        };
        incident.cause = attribute(&incident);
        let incident = record(incident);
        self.last.set(Some(incident));
        self.recorded.set(self.recorded.get().saturating_add(1));
        Some(incident)
    }
}

fn ratio(num: f32, den: f32) -> f32 {
    if den > 1e-6 { num / den } else { 1.0 }
}

/// The stage that lost the most, refined by the context flags.
pub fn attribute(incident: &SlowRunIncident) -> SlowRunCause {
    let ctx = &incident.ctx;
    let stages = [
        (incident.rate_ratio, 0u8),
        (incident.drive_ratio, 1),
        (incident.leash_ratio, 2),
        (incident.transition_ratio, 3),
    ];
    let mut worst = (f32::INFINITY, u8::MAX);
    for (value, stage) in stages {
        if value.is_finite() && value < worst.0 {
            worst = (value, stage);
        }
    }
    if worst.0 >= SLOW_RUN_RATIO {
        return SlowRunCause::Unknown;
    }
    match worst.1 {
        0 => SlowRunCause::RunRate,
        1 => {
            if ctx.forward_killed_by_cast_lock {
                SlowRunCause::CastForwardLock
            } else if ctx.server_controlled || ctx.interpreted_drive {
                SlowRunCause::ServerControl
            } else {
                SlowRunCause::DriveMismatch
            }
        }
        2 => {
            if ctx.interpolating {
                SlowRunCause::Interpolation
            } else if ctx.sticky_active {
                SlowRunCause::Sticky
            } else {
                SlowRunCause::Leash
            }
        }
        3 => SlowRunCause::Collision,
        _ => SlowRunCause::Unknown,
    }
}

struct SlowRunRing {
    buf: [SlowRunIncident; SLOW_RUN_RING_CAP],
    /// Next write slot.
    head: usize,
    len: usize,
    total: u32,
    epoch: Option<Instant>,
    last_log: Option<Instant>,
}

impl SlowRunRing {
    fn new() -> Self {
        Self {
            buf: [SlowRunIncident::default(); SLOW_RUN_RING_CAP],
            head: 0,
            len: 0,
            total: 0,
            epoch: None,
            last_log: None,
        }
    }
}

thread_local! {
    static RING: RefCell<SlowRunRing> = RefCell::new(SlowRunRing::new());
}

/// Stamp, store and (rate-limited) log one incident. Two kinds are recorded
/// without a console line: inside an open `?castHoldReclaim` window a dead
/// forward is the cast lock doing its job, and a run held against a wall
/// (`collision`) is not a slowdown.
fn record(mut incident: SlowRunIncident) -> SlowRunIncident {
    let now = Instant::now();
    let log_line = RING.with(|ring| {
        let mut ring = ring.borrow_mut();
        let epoch = *ring.epoch.get_or_insert(now);
        ring.total = ring.total.saturating_add(1);
        incident.seq = ring.total;
        incident.at_ms = now.saturating_duration_since(epoch).as_secs_f64() * 1000.0;
        let head = ring.head;
        ring.buf[head] = incident;
        ring.head = (head + 1) % SLOW_RUN_RING_CAP;
        ring.len = (ring.len + 1).min(SLOW_RUN_RING_CAP);
        let due = !incident.ctx.cast_lock_active
            && incident.cause != SlowRunCause::Collision
            && ring.last_log.is_none_or(|at| {
                now.saturating_duration_since(at).as_secs_f32() >= SLOW_RUN_LOG_GAP_SECS
            });
        if due {
            ring.last_log = Some(now);
        }
        due
    });
    if log_line {
        log::warn!("{}", summary_line(&incident));
    }
    incident
}

/// The one-line console summary.
pub fn summary_line(i: &SlowRunIncident) -> String {
    let c = &i.ctx;
    format!(
        "[slow-run] #{} cause={} realized {:.2}/{:.2} m/s over {:.2}s | stage ratios: rate {:.2} drive {:.2} leash {:.2} transition {:.2} | leash budget {:.1} m armed={} echo {}s AP {}s MTS {}s ago | ctl={} latch={} srvDrive={} moveTo={} proj={} lerp={} sticky={} castLock={}/{} pending={} | rate cap {:.3} server {} composed {} | held f{} s{} t{} run={} drive f{} s{} t{} run={} — __diag.slowRun.tail()",
        i.seq,
        i.cause.as_str(),
        i.realized_mps,
        i.reference_mps,
        i.slow_secs,
        i.rate_ratio,
        i.drive_ratio,
        i.leash_ratio,
        i.transition_ratio,
        c.leash_budget_m,
        u8::from(c.leash_armed),
        fmt_age(c.echo_age_s),
        fmt_age(c.ap_age_s),
        fmt_age(c.move_to_state_age_s),
        u8::from(c.server_controlled),
        u8::from(c.latch_autonomous),
        u8::from(c.interpreted_drive),
        u8::from(c.moveto_active),
        u8::from(c.projection_active),
        u8::from(c.interpolating),
        u8::from(c.sticky_active),
        u8::from(c.cast_lock_active),
        u8::from(c.forward_killed_by_cast_lock),
        c.pending_motions,
        c.capability_rate,
        fmt_age(c.server_run_rate),
        fmt_age(c.composed_run_rate),
        c.held_forward,
        c.held_side,
        c.held_turn,
        u8::from(c.held_run),
        c.drive_forward,
        c.drive_side,
        c.drive_turn,
        u8::from(c.drive_run),
    )
}

fn fmt_age(v: f32) -> String {
    if v.is_finite() {
        format!("{v:.2}")
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
    RING.with(|ring| *ring.borrow_mut() = SlowRunRing::new());
}

/// The ring, oldest first, as JSON: `{"count":N,"incidents":[…]}`.
pub fn read_json() -> String {
    RING.with(|ring| {
        let ring = ring.borrow();
        let mut out = String::with_capacity(256 + ring.len * 900);
        let _ = write!(out, "{{\"count\":{},\"incidents\":[", ring.total);
        let start = (ring.head + SLOW_RUN_RING_CAP - ring.len) % SLOW_RUN_RING_CAP;
        for k in 0..ring.len {
            if k > 0 {
                out.push(',');
            }
            push_incident(&mut out, &ring.buf[(start + k) % SLOW_RUN_RING_CAP]);
        }
        out.push_str("]}");
        out
    })
}

fn push_num(out: &mut String, key: &str, v: f32) {
    if v.is_finite() {
        let _ = write!(out, "\"{key}\":{v},");
    } else {
        let _ = write!(out, "\"{key}\":null,");
    }
}

fn push_bool(out: &mut String, key: &str, v: bool) {
    let _ = write!(out, "\"{key}\":{v},");
}

fn push_int(out: &mut String, key: &str, v: i64) {
    let _ = write!(out, "\"{key}\":{v},");
}

fn push_incident(out: &mut String, i: &SlowRunIncident) {
    let c = &i.ctx;
    out.push('{');
    push_int(out, "seq", i64::from(i.seq));
    let _ = write!(out, "\"atMs\":{:.1},", i.at_ms);
    let _ = write!(out, "\"cause\":\"{}\",", i.cause.as_str());
    push_num(out, "slowSecs", i.slow_secs);
    push_num(out, "expectedMps", i.expected_mps);
    push_num(out, "referenceMps", i.reference_mps);
    push_num(out, "intendedMps", i.intended_mps);
    push_num(out, "leashMps", i.leash_mps);
    push_num(out, "realizedMps", i.realized_mps);
    push_num(out, "rateRatio", i.rate_ratio);
    push_num(out, "driveRatio", i.drive_ratio);
    push_num(out, "leashRatio", i.leash_ratio);
    push_num(out, "transitionRatio", i.transition_ratio);
    push_bool(out, "serverControlled", c.server_controlled);
    push_bool(out, "latchAutonomous", c.latch_autonomous);
    push_bool(out, "interpretedDrive", c.interpreted_drive);
    push_int(out, "pendingMotions", i64::from(c.pending_motions));
    push_bool(out, "moveToActive", c.moveto_active);
    push_bool(out, "projectionActive", c.projection_active);
    push_bool(out, "interpolating", c.interpolating);
    push_bool(out, "stickyActive", c.sticky_active);
    push_bool(out, "castLockActive", c.cast_lock_active);
    push_bool(out, "forwardKilledByCastLock", c.forward_killed_by_cast_lock);
    push_bool(out, "leashArmed", c.leash_armed);
    push_num(out, "leashBudgetM", c.leash_budget_m);
    push_bool(out, "indoor", c.indoor);
    push_num(out, "echoAgeS", c.echo_age_s);
    push_num(out, "apAgeS", c.ap_age_s);
    push_num(out, "moveToStateAgeS", c.move_to_state_age_s);
    push_num(out, "serverMotionAgeS", c.server_motion_age_s);
    push_num(out, "serverMotionRate", c.server_motion_rate);
    push_bool(out, "positionEventReady", c.position_event_ready);
    push_int(out, "heartbeatsSent", i64::from(c.heartbeats_sent));
    push_num(out, "capabilityRate", c.capability_rate);
    push_num(out, "serverRunRate", c.server_run_rate);
    push_num(out, "composedRunRate", c.composed_run_rate);
    let _ = write!(
        out,
        "\"held\":[{},{},{},{}],\"drive\":[{},{},{},{}]",
        c.held_forward,
        c.held_side,
        c.held_turn,
        u8::from(c.held_run),
        c.drive_forward,
        c.drive_side,
        c.drive_turn,
        u8::from(c.drive_run),
    );
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slice(expected: f32, intended: f32, leash: f32, realized: f32) -> SlowRunSlice {
        SlowRunSlice {
            dt: 0.1,
            locomotion_held: true,
            grounded: true,
            expected_mps: expected,
            intended_mps: intended,
            leash_mps: leash,
            realized_mps: realized,
            rate_ratio: f32::NAN,
        }
    }

    #[test]
    fn full_speed_running_never_records() {
        let m = SlowRunMonitor::new();
        for _ in 0..50 {
            assert!(m.observe(slice(10.0, 10.0, 10.0, 9.95), SlowRunContext::default).is_none());
        }
        assert_eq!(m.incidents_recorded(), 0);
    }

    #[test]
    fn a_sustained_leash_loss_records_at_half_a_second_then_every_second() {
        let m = SlowRunMonitor::new();
        let mut incidents = Vec::new();
        for _ in 0..20 {
            if let Some(i) = m.observe(slice(10.0, 10.0, 7.0, 7.0), || SlowRunContext {
                leash_armed: true,
                leash_budget_m: 22.0,
                ..SlowRunContext::default()
            }) {
                incidents.push(i);
            }
        }
        assert_eq!(incidents.len(), 2, "2.0 s slow: at 0.5 s and at 1.5 s");
        let i = incidents[0];
        assert_eq!(i.cause, SlowRunCause::Leash);
        assert!(i.slow_secs >= SLOW_RUN_HOLD_SECS && i.slow_secs < 0.65);
        assert!(incidents[1].slow_secs >= 1.45 && incidents[1].slow_secs < 1.65);
        assert!((i.leash_ratio - 0.7).abs() < 1e-4);
        assert!((i.drive_ratio - 1.0).abs() < 1e-4);
        assert!((incidents[1].leash_ratio - 0.7).abs() < 1e-4, "per-incident sums");
        assert!(read_json().contains("\"cause\":\"leash\""));

        // A fast slice ends the episode; the next slow episode records again.
        assert!(m.observe(slice(10.0, 10.0, 10.0, 10.0), SlowRunContext::default).is_none());
        let again = (0..10)
            .filter_map(|_| m.observe(slice(10.0, 10.0, 7.0, 7.0), SlowRunContext::default))
            .count();
        assert_eq!(again, 1);
        assert_eq!(m.incidents_recorded(), 3);
    }

    #[test]
    fn a_cause_change_inside_one_episode_shows_in_the_next_incident() {
        let m = SlowRunMonitor::new();
        // 0.6 s of a server-driven stop, then a dead forward with the lock
        // flag: one slow episode, two causes.
        let mut causes = Vec::new();
        for k in 0..20 {
            let killed = k >= 6;
            if let Some(i) = m.observe(slice(4.0, 0.0, 0.0, 0.0), || SlowRunContext {
                interpreted_drive: !killed,
                forward_killed_by_cast_lock: killed,
                ..SlowRunContext::default()
            }) {
                causes.push(i.cause);
            }
        }
        assert_eq!(
            causes,
            vec![SlowRunCause::ServerControl, SlowRunCause::CastForwardLock]
        );
    }

    #[test]
    fn a_short_dip_or_an_airborne_slice_is_not_an_incident() {
        let m = SlowRunMonitor::new();
        for _ in 0..4 {
            assert!(m.observe(slice(10.0, 10.0, 6.0, 6.0), SlowRunContext::default).is_none());
        }
        // Airborne: the episode resets.
        let mut air = slice(10.0, 10.0, 6.0, 6.0);
        air.grounded = false;
        assert!(m.observe(air, SlowRunContext::default).is_none());
        for _ in 0..4 {
            assert!(m.observe(slice(10.0, 10.0, 6.0, 6.0), SlowRunContext::default).is_none());
        }
        assert_eq!(m.incidents_recorded(), 0);
    }

    #[test]
    fn drive_loss_names_the_carrier() {
        let base = SlowRunIncident {
            rate_ratio: 1.0,
            drive_ratio: 0.3,
            leash_ratio: 1.0,
            transition_ratio: 1.0,
            ..SlowRunIncident::default()
        };
        let mut i = base;
        i.ctx.forward_killed_by_cast_lock = true;
        assert_eq!(attribute(&i), SlowRunCause::CastForwardLock);
        let mut i = base;
        i.ctx.interpreted_drive = true;
        assert_eq!(attribute(&i), SlowRunCause::ServerControl);
        assert_eq!(attribute(&base), SlowRunCause::DriveMismatch);
        let mut i = base;
        i.drive_ratio = 1.0;
        i.transition_ratio = 0.5;
        assert_eq!(attribute(&i), SlowRunCause::Collision);
        let mut i = base;
        i.drive_ratio = 1.0;
        i.leash_ratio = 0.6;
        i.ctx.interpolating = true;
        assert_eq!(attribute(&i), SlowRunCause::Interpolation);
    }

    #[test]
    fn a_low_server_rate_is_measured_against_the_composition() {
        let m = SlowRunMonitor::new();
        assert!(m.rate_probe_due(), "the first eligible slice probes");
        let mut first = slice(8.0, 8.0, 8.0, 8.0);
        first.rate_ratio = 0.8; // server latch 20 % under the composition
        assert!(m.observe(first, SlowRunContext::default).is_none());
        assert!(!m.rate_probe_due());
        let recorded = (0..10)
            .filter_map(|_| m.observe(slice(8.0, 8.0, 8.0, 8.0), SlowRunContext::default))
            .next()
            .expect("the body runs at the latched rate, 20 % under the composition");
        assert_eq!(recorded.cause, SlowRunCause::RunRate);
        assert!((recorded.reference_mps - 10.0).abs() < 1e-3);
    }

    #[test]
    fn json_lists_the_ring_oldest_first_and_clear_resets() {
        clear();
        let m = SlowRunMonitor::new();
        let never_echoed = || SlowRunContext {
            echo_age_s: f32::NAN,
            ..SlowRunContext::default()
        };
        for _ in 0..(SLOW_RUN_RING_CAP + 3) {
            let _ = (0..6)
                .filter_map(|_| m.observe(slice(10.0, 10.0, 5.0, 5.0), never_echoed))
                .count();
            let _ = m.observe(slice(10.0, 10.0, 10.0, 10.0), SlowRunContext::default);
        }
        assert_eq!(count(), (SLOW_RUN_RING_CAP + 3) as u32);
        let json = read_json();
        assert!(json.starts_with(&format!("{{\"count\":{}", SLOW_RUN_RING_CAP + 3)));
        assert_eq!(json.matches("\"seq\":").count(), SLOW_RUN_RING_CAP);
        assert!(json.contains("\"seq\":4,"), "the oldest kept is #4: {json}");
        assert!(!json.contains("\"seq\":3,"));
        assert!(json.contains("\"echoAgeS\":null"), "unknown ages are null");
        clear();
        assert_eq!(count(), 0);
        assert_eq!(read_json(), "{\"count\":0,\"incidents\":[]}");
    }
}
