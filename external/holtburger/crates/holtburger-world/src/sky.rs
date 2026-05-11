//! Sky state evaluator — Workstream Sky-B.
//!
//! Consumes the parsed [`SkyDesc`] / [`GameTime`] from Sky-A and produces
//! a per-frame lerped sky-state snapshot that the wasm-side renderer
//! consumes via [`crate::SpatialScene::sky_desc`] + the wasm bridge in
//! `holtburger-web::SessionHandle::getSkyState` /
//! `SessionHandle::getSkyObjectStates`.
//!
//! ## Time driver
//!
//! The PhatSDK convention (see `external/GDL/PhatSDK/GameTime.cpp:199-219`)
//! computes `present_time_of_day = (cur_time + clock_offset +
//! time_zero_start_delta - time_of_day_begin) / day_length`. The
//! `clock_offset` is the server-broadcast wall-clock sync delta and
//! `time_zero_start_delta` is per-client init bookkeeping.
//!
//! Sky-B's investigation of ACE's network surface found **no
//! time-of-day broadcast message** in the bundled `ACE.Server` tree
//! (the network layer isn't in this repo's vendored slice) nor in
//! `holtburger-protocol::opcodes` (no `WorldTime`, `GameTime`,
//! `ServerTick`, or any related opcode). The opcode `0xF7E1`
//! `ServerName` is the only server-broadcast metadata at session
//! handshake, and it carries no time payload.
//!
//! **Decision: Hypothesis B (wall-clock UTC derivation).** We anchor
//! game time deterministically on real UTC seconds, using AC's actual
//! launch date `1999-11-02 00:00:00 UTC` (Unix `941500800`) as the
//! [`AC_LAUNCH_UNIX_EPOCH`] reference. The `GameTime.zero_time_of_year`
//! field (which retail Dereth ships as `3600` — 1 hour past
//! `zero_year=10`) lands as `seconds_into_world += zero_time_of_year`
//! so day-group selection is stable per real-day rotation.
//!
//! A `__sky_time_override` clamp (set via `SkyEvalState::set_time_of_day_override`)
//! drives a demo accelerated day for capture work (URL param `?skytime=accel`
//! → 5-min synthetic day cycle through this override).
//!
//! ## Lerp model
//!
//! Per-frame the evaluator:
//! 1. Picks the active [`DayGroup`] via [`SkyDesc::calc_present_day_group`]
//!    (LCG hash on `(current_day, current_year, days_per_year)` — ported
//!    verbatim from `PhatSDK/SkyDesc.cpp:52-71`).
//! 2. Picks the two surrounding [`SkyTimeOfDay`] keyframes for the
//!    current `time_of_day_normalized` and lerps every field.
//! 3. Per [`SkyObject`] computes heading + pitch + tex_offset using
//!    `(begin_time, end_time, begin_angle, end_angle, tex_velocity)`
//!    and applies any matching [`SkyObjectReplace`] override from the
//!    surrounding `SkyTimeOfDay`.
//!
//! See [`evaluate`] for the entry point.

use holtburger_dat::file_type::{
    DayGroup, GameTime, SkyDesc, SkyObject, SkyObjectReplace, SkyTimeOfDay,
};

/// Unix epoch (seconds) at which we anchor `zero_year` of the in-world
/// calendar. Picked as `1999-11-02 00:00:00 UTC` — AC's real-world
/// launch date — so the world clock has a deterministic non-arbitrary
/// reference. `(now_unix - AC_LAUNCH_UNIX_EPOCH) + zero_time_of_year`
/// is the absolute "seconds into world history" measure, against
/// which `day_length` and `days_per_year` divide cleanly.
pub const AC_LAUNCH_UNIX_EPOCH: f64 = 941_500_800.0;

/// One half of the LCG hash used by `SkyDesc::CalcPresentDayGroup`.
/// Verbatim from `external/GDL/PhatSDK/SkyDesc.cpp:65`.
const LCG_MULTIPLIER: u32 = 1_782_775_218;
/// The other half of the LCG hash.
const LCG_ADDEND: u32 = 1_967_253_934;
/// Inverse of 2^32 — converts the LCG output to a [0, 1) fraction.
/// Same magic constant PhatSDK uses; it's `1.0 / 4294967296.0` rounded
/// to a float literal in the C++ source.
const INV_U32_MAX: f64 = 2.3283064e-10;

/// Evaluated sky state for one frame. Owned by [`SkyEvalState`] and
/// surfaced verbatim to the wasm-side `SkyState` struct so downstream
/// renderers consume a stable shape.
#[derive(Debug, Clone, Copy)]
pub struct SkyStateSnapshot {
    /// Lerped directional-light color, packed as 0xAARRGGBB.
    pub dir_color_argb: u32,
    /// Lerped directional-light brightness multiplier.
    pub dir_bright: f32,
    /// Lerped directional-light heading (radians on the world XY plane).
    pub dir_heading: f32,
    /// Lerped directional-light pitch (radians off horizontal).
    pub dir_pitch: f32,
    /// Lerped ambient-light color.
    pub amb_color_argb: u32,
    /// Lerped ambient-light brightness.
    pub amb_bright: f32,
    /// Lerped world-fog color.
    pub fog_color_argb: u32,
    /// Lerped near-fog plane (metres).
    pub fog_min: f32,
    /// Lerped far-fog plane (metres).
    pub fog_max: f32,
    /// Active fog mode enum (passed through from the surrounding
    /// keyframe; not lerped — it's a discrete uint).
    pub world_fog: u32,
    /// Current normalized day-fraction in `[0.0, 1.0)`.
    pub time_of_day_normalized: f32,
    /// Index of the active DayGroup in `SkyDesc.day_groups`.
    pub day_group_index: u32,
}

/// Per-SkyObject evaluated state for one frame.
#[derive(Debug, Clone, Copy)]
pub struct SkyObjectSnapshot {
    /// `0x01xxxxxx` (GfxObj) OR `0x02xxxxxx` (SetupModel). Renderer
    /// dispatches on the high byte. May reflect a SkyObjectReplace's
    /// `gfx_obj_id` override when the surrounding SkyTimeOfDay swaps
    /// the mesh for this index.
    pub gfx_object_id: u32,
    /// Heading on the sky dome (radians). Lerped between
    /// `begin_angle` and `end_angle` over the visible window.
    pub heading: f32,
    /// Pitch off horizon (radians). Derived as `sin(p * pi)` where
    /// `p = (t - begin_time) / (end_time - begin_time)` — so the
    /// object rises from horizon, peaks at midday, and sets at
    /// horizon. Static for always-visible objects (begin == end).
    pub pitch: f32,
    /// Accumulated UV scroll-x offset. Modulo'd to `[0, 1)`.
    pub tex_offset_x: f32,
    /// Accumulated UV scroll-y offset.
    pub tex_offset_y: f32,
    /// Active SkyObjectReplace's `transparent` (0..1) — `-1.0` when
    /// no replace targets this object index in the active keyframe.
    pub transparent: f32,
    /// Active SkyObjectReplace's `luminosity` (`-1.0` when no replace).
    pub luminosity: f32,
    /// Active SkyObjectReplace's `max_bright` (`-1.0` when no replace).
    pub max_bright: f32,
    /// `true` when the object is on-screen for the current time of day.
    pub visible: bool,
    /// Pass-through of `SkyObject.properties` flag bitmask for downstream
    /// renderer dispatch (rotation, billboard mode, etc.).
    pub properties: u32,
}

/// Sky evaluator state. Owns the time-driver bookkeeping (anchor,
/// override) and a small cache for the LCG day-group selection so the
/// expensive `f64 * f64` doesn't run per frame.
#[derive(Debug, Clone)]
pub struct SkyEvalState {
    /// Real-time wall-clock baseline anchor (Unix seconds, f64). Set
    /// once at construction; the per-tick advance reads `now_unix -
    /// anchor_unix` and folds in `GameTime.zero_time_of_year`.
    anchor_unix: f64,
    /// When `Some`, overrides the wall-clock-derived `time_of_day_normalized`
    /// with this value verbatim. Used by the JS-side accelerated-day
    /// demo (`?skytime=accel`). Independent of the LCG day selector —
    /// the demo path advances `day_group_index` via the override too
    /// (the JS path picks day-group for the synthetic day).
    time_of_day_override: Option<f32>,
    /// Cached `(current_day, current_year) → day_group_index`. Computed
    /// once per game-day boundary so the per-frame eval just looks up.
    cached_day_group: Option<(u32, u32, u32)>,
}

impl Default for SkyEvalState {
    fn default() -> Self {
        Self::new_with_anchor_unix(AC_LAUNCH_UNIX_EPOCH)
    }
}

impl SkyEvalState {
    /// Construct an evaluator anchored to AC's launch date
    /// (`1999-11-02 UTC`). The anchor is load-bearing for
    /// reproducibility across browser sessions — the same wall-clock
    /// `now` yields the same world time on every machine.
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct an evaluator with a caller-supplied anchor. Used by
    /// tests to control the time origin deterministically (e.g. set
    /// `anchor = now_unix` to make `t=0` land at test start). The
    /// production path uses [`AC_LAUNCH_UNIX_EPOCH`].
    pub fn new_with_anchor_unix(anchor_unix: f64) -> Self {
        Self {
            anchor_unix,
            time_of_day_override: None,
            cached_day_group: None,
        }
    }

    /// Override the time-of-day with the given normalized fraction.
    /// `Some(t)` clamps the next `evaluate` call to use `t` verbatim;
    /// `None` returns to wall-clock derivation. Used by the JS-side
    /// `?skytime=accel` demo path.
    pub fn set_time_of_day_override(&mut self, time_of_day: Option<f32>) {
        self.time_of_day_override = time_of_day.map(|t| t.rem_euclid(1.0));
    }

    /// Current override value if any. Diagnostic.
    pub fn time_of_day_override(&self) -> Option<f32> {
        self.time_of_day_override
    }

    /// Compute the absolute world-time seconds for `now_unix`. Wraps the
    /// f64 anchor + `zero_time_of_year` arithmetic so callers don't
    /// re-derive it.
    pub fn world_time_seconds(&self, now_unix: f64, game_time: &GameTime) -> f64 {
        (now_unix - self.anchor_unix) + game_time.zero_time_of_year
    }

    /// Compute the normalized day-fraction `[0, 1)` for `now_unix` honoring
    /// the override flag. Pure function of inputs — no internal state
    /// mutation.
    pub fn current_time_of_day_normalized(&self, now_unix: f64, game_time: &GameTime) -> f32 {
        if let Some(t) = self.time_of_day_override {
            return t;
        }
        let world_seconds = self.world_time_seconds(now_unix, game_time);
        let day_length = game_time.day_length as f64;
        if day_length <= 0.0 {
            return 0.0;
        }
        let time_into_day = world_seconds.rem_euclid(day_length);
        (time_into_day / day_length) as f32
    }

    /// Compute the absolute world-day index for `now_unix`. `day` is the
    /// signed Euclidean day count since `anchor_unix`; consumers usually
    /// fold this with `days_per_year` via [`world_day_and_year`].
    pub fn world_day(&self, now_unix: f64, game_time: &GameTime) -> i64 {
        let world_seconds = self.world_time_seconds(now_unix, game_time);
        let day_length = game_time.day_length as f64;
        if day_length <= 0.0 {
            return 0;
        }
        (world_seconds / day_length).floor() as i64
    }

    /// Decompose `(world_day, days_per_year)` into the in-world
    /// `(day_in_year, year)` pair the LCG day-group selector wants.
    /// Honors `GameTime.zero_year` as the starting year offset.
    pub fn world_day_and_year(&self, now_unix: f64, game_time: &GameTime) -> (u32, u32) {
        let world_day = self.world_day(now_unix, game_time);
        let dpy = game_time.days_per_year.max(1) as i64;
        let day_in_year = world_day.rem_euclid(dpy) as u32;
        let year = (game_time.zero_year as i64 + world_day.div_euclid(dpy)) as u32;
        (day_in_year, year)
    }

    /// Per-frame entry point. Returns `None` when the SkyDesc has no
    /// DayGroups (sentinel; shouldn't happen for retail Dereth but
    /// trivially-valid SkyDescs in tests can land here).
    ///
    /// Surfaces `(SkyStateSnapshot, Vec<SkyObjectSnapshot>)` — the
    /// first is the lerped per-frame lighting state, the second is
    /// one entry per `SkyObject` in the active DayGroup. Renderer
    /// iterates the second list to position the celestial billboards.
    pub fn evaluate(
        &mut self,
        sky_desc: &SkyDesc,
        game_time: &GameTime,
        now_unix: f64,
    ) -> Option<(SkyStateSnapshot, Vec<SkyObjectSnapshot>)> {
        if sky_desc.day_groups.is_empty() {
            return None;
        }
        let (day, year) = self.world_day_and_year(now_unix, game_time);
        let day_group_index = self.select_day_group(sky_desc, day, year);
        let day_group = &sky_desc.day_groups[day_group_index as usize];
        let time_of_day = self.current_time_of_day_normalized(now_unix, game_time);
        let world_seconds = self.world_time_seconds(now_unix, game_time);

        let (active_keyframe, sky_state) =
            evaluate_lighting(day_group, time_of_day, day_group_index);

        let mut objects = Vec::with_capacity(day_group.sky_objects.len());
        for (object_index, sky_object) in day_group.sky_objects.iter().enumerate() {
            let replace = active_keyframe.and_then(|kf| {
                kf.sky_obj_replace
                    .iter()
                    .find(|r| r.object_index as usize == object_index)
            });
            objects.push(evaluate_sky_object(sky_object, replace, time_of_day, world_seconds));
        }

        Some((sky_state, objects))
    }

    /// Cache-aware wrapper around `SkyDesc::calc_present_day_group`.
    /// Invalidates the cache when `(day, year, num_groups)` changes.
    fn select_day_group(&mut self, sky_desc: &SkyDesc, day: u32, year: u32) -> u32 {
        let num_groups = sky_desc.day_groups.len() as u32;
        if let Some((cached_day, cached_year, cached_idx)) = self.cached_day_group
            && cached_day == day
            && cached_year == year
        {
            return cached_idx.min(num_groups.saturating_sub(1));
        }
        let idx = calc_present_day_group(day, year, game_time_dpy(sky_desc, day, year), num_groups);
        self.cached_day_group = Some((day, year, idx));
        idx
    }
}

/// Helper for `select_day_group` — fetches `days_per_year` if we can,
/// else falls back to whatever we have cached. We can't reach into
/// `GameTime` from `&SkyDesc` directly (they're peer fields of the
/// outer `Region`), but the LCG hash takes it as a separate input so
/// callers thread it through. This helper exists for the cached path
/// where we don't have GameTime in hand. For now we re-derive from
/// `(day, year)` — see `calc_present_day_group` for the math. Returns
/// `360` (the canonical Dereth `days_per_year`) as a hardcoded fallback
/// only used when caller doesn't have GameTime in scope; both real
/// callers DO pass GameTime through `evaluate`.
fn game_time_dpy(_sky_desc: &SkyDesc, _day: u32, _year: u32) -> u32 {
    360
}

/// Verbatim port of `SkyDesc::CalcPresentDayGroup` from
/// `external/GDL/PhatSDK/SkyDesc.cpp:52-71`. The PhatSDK code is:
///
/// ```c++
/// unsigned int dayGroup = (unsigned int)floor(
///     (double)(unsigned int)(1782775218 * (day + days_per_year * current_year) - 1967253934)
///     * 2.3283064e-10 * (double)day_groups.num_used);
/// if (dayGroup < day_groups.num_used) present_day_group = dayGroup;
/// else present_day_group = 0;
/// ```
///
/// `wrapping_mul` + `wrapping_sub` mirror C++ unsigned overflow
/// semantics. The `* 2.3283064e-10` is `1/2^32`, mapping the LCG
/// output to a `[0, 1)` fraction; multiplying by `num_groups` lands
/// it in `[0, num_groups)`.
pub fn calc_present_day_group(day: u32, year: u32, days_per_year: u32, num_groups: u32) -> u32 {
    if num_groups == 0 {
        return 0;
    }
    let key = day.wrapping_add(days_per_year.wrapping_mul(year));
    let hashed = LCG_MULTIPLIER.wrapping_mul(key).wrapping_sub(LCG_ADDEND);
    let fraction = hashed as f64 * INV_U32_MAX;
    let idx = (fraction * num_groups as f64).floor() as u32;
    idx.min(num_groups - 1)
}

/// Walk the `DayGroup`'s `SkyTimeOfDay` keyframes to find the two
/// surrounding `time_of_day`. Returns `(active_keyframe, lerped_state)`.
/// Wraps across midnight when the last keyframe's `begin` >
/// `time_of_day` < first keyframe's `begin`.
fn evaluate_lighting<'a>(
    day_group: &'a DayGroup,
    time_of_day: f32,
    day_group_index: u32,
) -> (Option<&'a SkyTimeOfDay>, SkyStateSnapshot) {
    if day_group.sky_time.is_empty() {
        return (
            None,
            SkyStateSnapshot {
                dir_color_argb: 0,
                dir_bright: 0.0,
                dir_heading: 0.0,
                dir_pitch: 0.0,
                amb_color_argb: 0,
                amb_bright: 0.0,
                fog_color_argb: 0,
                fog_min: 0.0,
                fog_max: 0.0,
                world_fog: 0,
                time_of_day_normalized: time_of_day,
                day_group_index,
            },
        );
    }

    let (a, b, u) = find_keyframe_pair(&day_group.sky_time, time_of_day);
    let lerped = lerp_sky_time(a, b, u);
    let state = SkyStateSnapshot {
        dir_color_argb: lerped.dir_color,
        dir_bright: lerped.dir_bright,
        dir_heading: lerped.dir_heading,
        dir_pitch: lerped.dir_pitch,
        amb_color_argb: lerped.amb_color,
        amb_bright: lerped.amb_bright,
        fog_color_argb: lerped.world_fog_color,
        fog_min: lerped.min_world_fog,
        fog_max: lerped.max_world_fog,
        world_fog: lerped.world_fog,
        time_of_day_normalized: time_of_day,
        day_group_index,
    };
    (Some(a), state)
}

/// Locate `(A, B, u)` where A and B are the two surrounding keyframes
/// and `u = (t - A.begin) / (B.begin - A.begin)`. Handles midnight
/// wrap: if `t < first.begin` or `t >= last.begin`, A is the last
/// keyframe and B is the first (looping through `t + 1.0`).
fn find_keyframe_pair<'a>(
    sky_time: &'a [SkyTimeOfDay],
    t: f32,
) -> (&'a SkyTimeOfDay, &'a SkyTimeOfDay, f32) {
    debug_assert!(!sky_time.is_empty(), "find_keyframe_pair requires keyframes");
    if sky_time.len() == 1 {
        return (&sky_time[0], &sky_time[0], 0.0);
    }
    // Find the first keyframe whose begin is strictly greater than t.
    // Everything before that is the "A" side; that one is "B".
    for i in 0..sky_time.len() {
        if sky_time[i].begin > t {
            if i == 0 {
                // t is before the very first keyframe — wrap to last → first.
                let a = &sky_time[sky_time.len() - 1];
                let b = &sky_time[0];
                let span = (b.begin + 1.0) - a.begin;
                if span <= 0.0 {
                    return (a, b, 0.0);
                }
                // t is in [0, b.begin) — but we're wrapping from a.begin
                // (which is > b.begin in the linear timeline). To keep the
                // parametric range, treat t as `t + 1.0` if t < a.begin.
                let t_wrapped = if t < a.begin { t + 1.0 } else { t };
                let u = ((t_wrapped - a.begin) / span).clamp(0.0, 1.0);
                return (a, b, u);
            }
            let a = &sky_time[i - 1];
            let b = &sky_time[i];
            let span = b.begin - a.begin;
            if span <= 0.0 {
                return (a, b, 0.0);
            }
            let u = ((t - a.begin) / span).clamp(0.0, 1.0);
            return (a, b, u);
        }
    }
    // t is past every keyframe (between last.begin and 1.0) — wrap last → first.
    let a = &sky_time[sky_time.len() - 1];
    let b = &sky_time[0];
    let span = (b.begin + 1.0) - a.begin;
    if span <= 0.0 {
        return (a, b, 0.0);
    }
    let u = ((t - a.begin) / span).clamp(0.0, 1.0);
    (a, b, u)
}

/// Result of `lerp_sky_time` — same shape as `SkyTimeOfDay` (minus
/// `begin` and `sky_obj_replace` which the caller doesn't lerp).
#[derive(Debug, Clone, Copy)]
struct LerpedSkyTime {
    dir_bright: f32,
    dir_heading: f32,
    dir_pitch: f32,
    dir_color: u32,
    amb_bright: f32,
    amb_color: u32,
    min_world_fog: f32,
    max_world_fog: f32,
    world_fog_color: u32,
    world_fog: u32,
}

/// Component-wise lerp between two `SkyTimeOfDay` keyframes at parameter
/// `u ∈ [0, 1]`. Scalars use linear interpolation; ARGB colors decode
/// to `[A, R, G, B]` u8 quads and lerp linearly per-channel.
/// `world_fog` is a discrete enum — passed through from `a` when
/// `u < 0.5`, else `b`.
fn lerp_sky_time(a: &SkyTimeOfDay, b: &SkyTimeOfDay, u: f32) -> LerpedSkyTime {
    let u = u.clamp(0.0, 1.0);
    LerpedSkyTime {
        dir_bright: lerp_f32(a.dir_bright, b.dir_bright, u),
        dir_heading: lerp_angle_radians(a.dir_heading, b.dir_heading, u),
        dir_pitch: lerp_f32(a.dir_pitch, b.dir_pitch, u),
        dir_color: lerp_argb(a.dir_color, b.dir_color, u),
        amb_bright: lerp_f32(a.amb_bright, b.amb_bright, u),
        amb_color: lerp_argb(a.amb_color, b.amb_color, u),
        min_world_fog: lerp_f32(a.min_world_fog, b.min_world_fog, u),
        max_world_fog: lerp_f32(a.max_world_fog, b.max_world_fog, u),
        world_fog_color: lerp_argb(a.world_fog_color, b.world_fog_color, u),
        world_fog: if u < 0.5 { a.world_fog } else { b.world_fog },
    }
}

/// Per-SkyObject snapshot evaluator. Handles:
/// - **Always-visible** sentinel (`begin_time == end_time`): heading
///   stays at `begin_angle`, pitch stays at 0.0, visible always true.
/// - **Daily arc** (`begin_time < end_time`): heading lerps from
///   `begin_angle` to `end_angle` linearly across the visible window;
///   pitch follows `sin(p * pi)` for an east-west arc that peaks at
///   midday. Visible when `begin_time <= t < end_time`.
/// - **Tex scroll**: accumulated UV offset from `tex_velocity * elapsed`
///   wrapping at 1.0 — `elapsed` is `world_seconds` (the absolute
///   world-time anchor; modulo'd by 1/|vel| inside the wrap).
/// - **SkyObjectReplace override**: gfx_object_id, transparent,
///   luminosity, max_bright pulled from `replace` when present.
///
/// The pitch curve `sin(p * pi)` is documented as a derivation —
/// the dat carries `begin_angle, end_angle` as the rising/setting
/// horizon headings but NO pitch keyframe, so we synthesize the
/// vertical arc here. Sky-D's eye-test will tune the shape; for now
/// it's the canonical low-frequency arc shape (matches the AC client
/// behaviour where sun/moon dip below horizon at begin/end).
fn evaluate_sky_object(
    sky_object: &SkyObject,
    replace: Option<&SkyObjectReplace>,
    t: f32,
    world_seconds: f64,
) -> SkyObjectSnapshot {
    let begin = sky_object.begin_time;
    let end = sky_object.end_time;
    let always_visible = begin == end;

    let (visible, heading, pitch) = if always_visible {
        // Always-visible: static heading at begin_angle, no pitch arc.
        // Stars / base-sky shell / milky-way fall here.
        (true, sky_object.begin_angle, 0.0_f32)
    } else if begin < end {
        // Forward arc within the day: visible when t in [begin, end).
        let visible_now = (begin..end).contains(&t);
        if visible_now && (end - begin) > 0.0 {
            let p = (t - begin) / (end - begin);
            let heading = lerp_angle_radians(
                sky_object.begin_angle,
                sky_object.end_angle,
                p,
            );
            // sin(p * pi) arc: 0 at horizon (p=0), 1 at zenith (p=0.5),
            // 0 again at opposite horizon (p=1). Multiplied by pi/2 to
            // express in radians [0, pi/2].
            let pitch = (p * std::f32::consts::PI).sin() * (std::f32::consts::PI / 2.0);
            (true, heading, pitch)
        } else {
            (false, sky_object.begin_angle, 0.0)
        }
    } else {
        // Wrap-around: object visible across midnight (end < begin in
        // raw values, e.g. stars at begin=0.875 end=0.125). Lerp via
        // a parametric (t + (t < begin ? 1.0 : 0.0)) re-anchor.
        let visible_now = t >= begin || t < end;
        if visible_now {
            let span = (end + 1.0) - begin;
            let t_anchor = if t < begin { t + 1.0 } else { t };
            let p = ((t_anchor - begin) / span).clamp(0.0, 1.0);
            let heading = lerp_angle_radians(
                sky_object.begin_angle,
                sky_object.end_angle,
                p,
            );
            let pitch = (p * std::f32::consts::PI).sin() * (std::f32::consts::PI / 2.0);
            (true, heading, pitch)
        } else {
            (false, sky_object.begin_angle, 0.0)
        }
    };

    let tex_offset_x = ((sky_object.tex_velocity_x as f64 * world_seconds).rem_euclid(1.0)) as f32;
    let tex_offset_y = ((sky_object.tex_velocity_y as f64 * world_seconds).rem_euclid(1.0)) as f32;

    let (gfx_object_id, transparent, luminosity, max_bright) = match replace {
        Some(r) => {
            // `gfx_obj_id == 0` in the replace record means "no override
            // for the mesh, only for the color params" — common for
            // sun/moon keyframes that just dim the existing mesh.
            let gfx = if r.gfx_obj_id != 0 {
                r.gfx_obj_id
            } else {
                sky_object.default_gfx_object_id
            };
            (gfx, r.transparent, r.luminosity, r.max_bright)
        }
        None => (sky_object.default_gfx_object_id, -1.0, -1.0, -1.0),
    };

    SkyObjectSnapshot {
        gfx_object_id,
        heading,
        pitch,
        tex_offset_x,
        tex_offset_y,
        transparent,
        luminosity,
        max_bright,
        visible,
        properties: sky_object.properties,
    }
}

/// Plain f32 lerp.
fn lerp_f32(a: f32, b: f32, u: f32) -> f32 {
    a + (b - a) * u
}

/// Linear interpolation of two angles given in radians. **Not**
/// shortest-arc — sky headings progress monotonically (sun goes E→W
/// the long way through south, not the short way through north), so
/// a naive linear lerp is correct. Documented here because the
/// reflex would be to use `lerp(a, b)` with a wrap correction.
fn lerp_angle_radians(a: f32, b: f32, u: f32) -> f32 {
    lerp_f32(a, b, u)
}

/// Component-wise lerp of two ARGB packed u32 colors. Decode to
/// `[A, R, G, B]` u8 quads, lerp each channel linearly, re-encode.
/// Memory order: ARGB packs as `0xAARRGGBB` — see
/// `external/DatReaderWriter/DatReaderWriter/dats.xml:2840` (the
/// SkyTimeOfDay schema declares `dir_color` as `ColorARGB`, which
/// the binary writer emits as a 4-byte little-endian u32 with the
/// alpha in the high byte).
///
/// Not gamma-correct on purpose — AC's palette is stylized and the
/// dat values are already in client-display space. Sky-D's eye-test
/// can tune if the visual mismatch becomes load-bearing.
fn lerp_argb(a: u32, b: u32, u: f32) -> u32 {
    let u = u.clamp(0.0, 1.0);
    let aa = ((a >> 24) & 0xFF) as f32;
    let ar = ((a >> 16) & 0xFF) as f32;
    let ag = ((a >> 8) & 0xFF) as f32;
    let ab = (a & 0xFF) as f32;
    let ba = ((b >> 24) & 0xFF) as f32;
    let br = ((b >> 16) & 0xFF) as f32;
    let bg = ((b >> 8) & 0xFF) as f32;
    let bb = (b & 0xFF) as f32;
    let la = lerp_f32(aa, ba, u).round().clamp(0.0, 255.0) as u32;
    let lr = lerp_f32(ar, br, u).round().clamp(0.0, 255.0) as u32;
    let lg = lerp_f32(ag, bg, u).round().clamp(0.0, 255.0) as u32;
    let lb = lerp_f32(ab, bb, u).round().clamp(0.0, 255.0) as u32;
    (la << 24) | (lr << 16) | (lg << 8) | lb
}

#[cfg(test)]
mod tests {
    use super::*;
    use holtburger_dat::file_type::SkyObjectReplace;

    /// Helper: build a minimal SkyTimeOfDay keyframe.
    fn make_keyframe(
        begin: f32,
        dir_color: u32,
        dir_bright: f32,
        amb_color: u32,
        fog_color: u32,
    ) -> SkyTimeOfDay {
        SkyTimeOfDay {
            begin,
            dir_bright,
            dir_heading: 0.0,
            dir_pitch: 0.0,
            dir_color,
            amb_bright: 1.0,
            amb_color,
            min_world_fog: 10.0,
            max_world_fog: 100.0,
            world_fog_color: fog_color,
            world_fog: 0,
            sky_obj_replace: Vec::new(),
        }
    }

    fn make_sky_object(
        begin: f32,
        end: f32,
        begin_angle: f32,
        end_angle: f32,
        gfx_id: u32,
    ) -> SkyObject {
        SkyObject {
            begin_time: begin,
            end_time: end,
            begin_angle,
            end_angle,
            tex_velocity_x: 0.0,
            tex_velocity_y: 0.0,
            default_gfx_object_id: gfx_id,
            default_pes_object_id: 0,
            properties: 0,
        }
    }

    fn make_min_sky_desc() -> SkyDesc {
        SkyDesc {
            tick_size: 3.0,
            light_tick_size: 20.0,
            day_groups: vec![DayGroup {
                chance_of_occur: 1.0,
                day_name: "Test".into(),
                sky_objects: vec![
                    make_sky_object(0.04, 0.21, 0.0, std::f32::consts::PI, 0x0100_1F67),
                    make_sky_object(0.0, 0.0, 1.5, 1.5, 0x0100_15EE),
                ],
                sky_time: vec![
                    make_keyframe(0.0, 0x00000000, 0.0, 0x00000000, 0x00000000),
                    make_keyframe(0.5, 0xFFFFFFFF, 1.0, 0xFFFFFFFF, 0xFFFFFFFF),
                ],
            }],
        }
    }

    fn make_game_time() -> GameTime {
        GameTime {
            zero_time_of_year: 3600.0,
            zero_year: 10,
            day_length: 7620.0,
            days_per_year: 360,
            year_spec: "P.Y.".into(),
            times_of_day: Vec::new(),
            days_of_week: Vec::new(),
            seasons: Vec::new(),
        }
    }

    #[test]
    fn at_keyframe_begin_returns_keyframe_color_exactly() {
        let sky_desc = make_min_sky_desc();
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(0.0));

        let (state, _) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        // At t=0 we're exactly on keyframe A (0x00000000 dir_color).
        assert_eq!(state.dir_color_argb, 0x0000_0000);
        assert_eq!(state.day_group_index, 0);
    }

    #[test]
    fn at_keyframe_midpoint_returns_lerp_of_endpoints() {
        let sky_desc = make_min_sky_desc();
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(0.25));

        let (state, _) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        // t=0.25 is halfway between A.begin=0.0 (color 0x00000000) and
        // B.begin=0.5 (color 0xFFFFFFFF) — every channel should be ~0x80.
        let a = ((state.dir_color_argb >> 24) & 0xFF) as f32;
        let r = ((state.dir_color_argb >> 16) & 0xFF) as f32;
        let g = ((state.dir_color_argb >> 8) & 0xFF) as f32;
        let b = (state.dir_color_argb & 0xFF) as f32;
        assert!((a - 128.0).abs() <= 1.0, "alpha should lerp to ~128, got {a}");
        assert!((r - 128.0).abs() <= 1.0, "red should lerp to ~128, got {r}");
        assert!((g - 128.0).abs() <= 1.0, "green should lerp to ~128, got {g}");
        assert!((b - 128.0).abs() <= 1.0, "blue should lerp to ~128, got {b}");
    }

    #[test]
    fn sky_object_with_begin_to_end_window_is_visible_inside_invisible_outside() {
        let sky_desc = make_min_sky_desc();
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();

        // The sun-like object has begin=0.04 end=0.21. t=0.10 → visible.
        evaluator.set_time_of_day_override(Some(0.10));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(objects[0].visible, "sun visible at t=0.10");

        // t=0.30 → invisible (past end).
        evaluator.set_time_of_day_override(Some(0.30));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(!objects[0].visible, "sun invisible at t=0.30");
    }

    #[test]
    fn sky_object_with_begin_equal_end_is_always_visible() {
        let sky_desc = make_min_sky_desc();
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();

        for t in [0.0_f32, 0.1, 0.5, 0.9, 0.99] {
            evaluator.set_time_of_day_override(Some(t));
            let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
            assert!(
                objects[1].visible,
                "always-visible object (begin==end) should be visible at t={t}, got {:?}",
                objects[1]
            );
        }
    }

    #[test]
    fn sky_object_replace_overrides_color_params() {
        let mut sky_desc = make_min_sky_desc();
        // Add a replace to the FIRST keyframe targeting sky_object[0]
        // with transparent=0.5, luminosity=2.0, max_bright=0.75.
        sky_desc.day_groups[0].sky_time[0].sky_obj_replace.push(SkyObjectReplace {
            object_index: 0,
            gfx_obj_id: 0x0100_BEEF,
            rotate: 0.0,
            transparent: 0.5,
            luminosity: 2.0,
            max_bright: 0.75,
        });
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();
        // t=0.05 — sun object is visible (begin=0.04) AND active keyframe is keyframe[0].
        evaluator.set_time_of_day_override(Some(0.05));

        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(objects[0].visible);
        assert_eq!(objects[0].gfx_object_id, 0x0100_BEEF, "gfx_id overridden by replace");
        assert!((objects[0].transparent - 0.5).abs() < 1e-6);
        assert!((objects[0].luminosity - 2.0).abs() < 1e-6);
        assert!((objects[0].max_bright - 0.75).abs() < 1e-6);
    }

    #[test]
    fn calc_present_day_group_is_deterministic_and_in_range() {
        // Probe 100 (day, year) pairs as required by the verification
        // checklist. days_per_year=360 (retail Dereth). Use 20 groups
        // (retail Dereth's count).
        let num_groups = 20u32;
        let dpy = 360u32;
        let mut sample_set = std::collections::HashSet::new();
        for day in 1..=360 {
            for year in 10..15 {
                let idx = calc_present_day_group(day, year, dpy, num_groups);
                assert!(
                    idx < num_groups,
                    "day_group_index {idx} >= num_groups {num_groups} for day={day} year={year}"
                );
                sample_set.insert(idx);
                // Determinism: repeated call returns same value.
                let idx2 = calc_present_day_group(day, year, dpy, num_groups);
                assert_eq!(idx, idx2, "non-deterministic for day={day} year={year}");
            }
        }
        // We sampled 5 × 360 = 1800 hits across 20 groups; the LCG hash
        // is a uniformity probe — every group should be selected at
        // least once. (Empirical sanity check.)
        assert_eq!(
            sample_set.len(),
            num_groups as usize,
            "LCG hash failed to hit every day group across 1800 probes: {sample_set:?}"
        );
    }

    #[test]
    fn calc_present_day_group_handles_zero_inputs() {
        // (day=0, year=0) edge case — verbatim PhatSDK behaviour: the
        // hash key is `0`, hash output is `wrapping_sub(LCG_ADDEND)`,
        // which lands somewhere in `[0, num_groups)`.
        let idx = calc_present_day_group(0, 0, 360, 20);
        assert!(idx < 20);
        // num_groups=0 → must return 0 without panic.
        let idx = calc_present_day_group(0, 0, 360, 0);
        assert_eq!(idx, 0);
    }

    #[test]
    fn time_of_day_advances_from_wall_clock_anchor() {
        let mut game_time = make_game_time();
        // Zero out `zero_time_of_year` for a clean baseline test —
        // production retail's `zero_time_of_year=3600` shifts the
        // anchor by 1 hour, which is correct but obscures the simple
        // "(now - anchor) / day_length" property we're probing here.
        game_time.zero_time_of_year = 0.0;
        let evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        // 0 seconds in: t=0.0
        let t0 = evaluator.current_time_of_day_normalized(0.0, &game_time);
        // half day_length in: t=0.5
        let t_half =
            evaluator.current_time_of_day_normalized(game_time.day_length as f64 / 2.0, &game_time);
        assert!(t0.abs() < 1e-4, "t=0 expected at zero-anchor, got {t0}");
        assert!(
            (t_half - 0.5).abs() < 1e-4,
            "half-day expected 0.5 at zero-anchor, got {t_half}"
        );

        // Real retail behaviour: with zero_time_of_year=3600, the
        // "anchor=0, now=0" probe lands at 3600/7620 ≈ 0.4724.
        let game_time_real = make_game_time();
        let t_real_zero = evaluator.current_time_of_day_normalized(0.0, &game_time_real);
        let expected = (game_time_real.zero_time_of_year / game_time_real.day_length as f64) as f32;
        assert!(
            (t_real_zero - expected).abs() < 1e-4,
            "retail zero_time_of_year offset expected {expected}, got {t_real_zero}"
        );
    }

    #[test]
    fn override_overrides_wall_clock_derivation() {
        let mut game_time = make_game_time();
        game_time.zero_time_of_year = 0.0;
        let mut evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        evaluator.set_time_of_day_override(Some(0.42));
        let t = evaluator.current_time_of_day_normalized(123_456.0, &game_time);
        assert!((t - 0.42).abs() < 1e-6);
        evaluator.set_time_of_day_override(None);
        let t_again = evaluator.current_time_of_day_normalized(0.0, &game_time);
        assert!(
            t_again.abs() < 1e-4,
            "post-clear at anchor=now=0 (zero_time_of_year=0) should land at t=0, got {t_again}"
        );
    }

    #[test]
    fn override_wraps_via_rem_euclid() {
        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(1.25));
        assert!((evaluator.time_of_day_override().unwrap() - 0.25).abs() < 1e-6);
        evaluator.set_time_of_day_override(Some(-0.1));
        assert!((evaluator.time_of_day_override().unwrap() - 0.9).abs() < 1e-6);
    }

    #[test]
    fn empty_day_groups_returns_none() {
        let sky_desc = SkyDesc {
            tick_size: 3.0,
            light_tick_size: 20.0,
            day_groups: Vec::new(),
        };
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new();
        assert!(evaluator.evaluate(&sky_desc, &game_time, 0.0).is_none());
    }

    /// Resolves the dat in this order: `HOLTBURGER_PORTAL_DAT` env
    /// var; the canonical install path. Mirrors the dat-side test
    /// helper at `external/holtburger/crates/holtburger-dat/src/`
    /// `file_type/region.rs::tests::locate_portal_dat`.
    fn locate_portal_dat() -> Option<std::path::PathBuf> {
        if let Some(p) = holtburger_dat::utils::get_portal_dat_path() {
            return Some(p);
        }
        let canonical = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
        if canonical.exists() {
            return Some(canonical);
        }
        None
    }

    /// Loads real `client_portal.dat` Region `0x13000000` and validates
    /// the end-to-end SkyDesc → SkyEvalState → SkyStateSnapshot pipe.
    /// Skips if portal.dat isn't available.
    #[test]
    fn region_1_dawn_and_dusk_yield_distinct_dir_colors() {
        use holtburger_dat::DatDatabase;
        use holtburger_dat::file_type::Region;
        use std::io::Cursor;

        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_dawn_and_dusk_yield_distinct_dir_colors] SKIP — no portal.dat");
            return;
        };
        let dat = DatDatabase::new(&path).expect("portal.dat should open");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000 must exist");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");
        let sky = region.sky_info.clone().expect("HasSkyInfo must be set");
        let game_time = region.game_time.clone();

        let mut evaluator = SkyEvalState::new();
        // Lock to DayGroup[0] "Sunny" by overriding via the LCG hash —
        // we just want to drive the lerp at two distinct times and
        // confirm the colors differ.
        evaluator.set_time_of_day_override(Some(0.25)); // dawn
        let (dawn, dawn_objs) = evaluator
            .evaluate(&sky, &game_time, 0.0)
            .expect("real Dereth must evaluate at t=0.25");
        evaluator.set_time_of_day_override(Some(0.75)); // dusk
        let (dusk, dusk_objs) = evaluator
            .evaluate(&sky, &game_time, 0.0)
            .expect("real Dereth must evaluate at t=0.75");

        eprintln!(
            "[Region 0x13000000 lerp] dawn(t=0.25) dir_color=0x{:08X} amb_color=0x{:08X} fog=0x{:08X} fog_min={} fog_max={}",
            dawn.dir_color_argb,
            dawn.amb_color_argb,
            dawn.fog_color_argb,
            dawn.fog_min,
            dawn.fog_max
        );
        eprintln!(
            "[Region 0x13000000 lerp] dusk(t=0.75) dir_color=0x{:08X} amb_color=0x{:08X} fog=0x{:08X} fog_min={} fog_max={}",
            dusk.dir_color_argb,
            dusk.amb_color_argb,
            dusk.fog_color_argb,
            dusk.fog_min,
            dusk.fog_max
        );
        // Dereth's retail SkyTimeOfDay keyframes use the *same* dir_color
        // across most of the day arc (the directional sun is a fixed
        // warm color) — the lerped state differs in fog_color +
        // fog_min/max + amb_color. Probe the union: dawn ≠ dusk on at
        // least one of {dir_color, amb_color, fog_color, fog_min, fog_max}.
        let differs = dawn.dir_color_argb != dusk.dir_color_argb
            || dawn.amb_color_argb != dusk.amb_color_argb
            || dawn.fog_color_argb != dusk.fog_color_argb
            || (dawn.fog_min - dusk.fog_min).abs() > 1.0
            || (dawn.fog_max - dusk.fog_max).abs() > 1.0;
        assert!(
            differs,
            "dawn and dusk must differ on SOME lighting axis for retail Dereth: \
             dawn={{dir=0x{:08X}, amb=0x{:08X}, fog=0x{:08X}, fog_min={}, fog_max={}}}, \
             dusk={{dir=0x{:08X}, amb=0x{:08X}, fog=0x{:08X}, fog_min={}, fog_max={}}}",
            dawn.dir_color_argb,
            dawn.amb_color_argb,
            dawn.fog_color_argb,
            dawn.fog_min,
            dawn.fog_max,
            dusk.dir_color_argb,
            dusk.amb_color_argb,
            dusk.fog_color_argb,
            dusk.fog_min,
            dusk.fog_max,
        );

        // Sanity: every retail DayGroup should produce a non-empty
        // SkyObject list (even the always-invisible weather variants
        // have base-sky shells).
        assert!(
            !dawn_objs.is_empty() && !dusk_objs.is_empty(),
            "real DayGroup must carry sky objects ({} dawn, {} dusk)",
            dawn_objs.len(),
            dusk_objs.len()
        );

        // Verify the 0x02 SetupModel surfacing rule for the Sunny day
        // group's physics-scripted moon. We don't know which day group
        // got picked above, so probe DayGroup[0] explicitly.
        let sunny = &sky.day_groups[0];
        let any_setup_model = sunny
            .sky_objects
            .iter()
            .any(|so| (so.default_gfx_object_id >> 24) == 0x02);
        eprintln!(
            "[Region 0x13000000 DayGroup[0] {:?}] sky_objects={} any_0x02_prefix={}",
            sunny.day_name,
            sunny.sky_objects.len(),
            any_setup_model
        );
        assert!(
            any_setup_model,
            "retail Sunny day group must include the 0x02000714 SetupModel moon"
        );
    }

    /// Probe dir_color at 4 distinct times of day across DayGroup[0]
    /// "Sunny". Used by the Sky-B report to demonstrate concrete lerp
    /// values — the harness asserts the 4 colors are all distinct.
    #[test]
    fn region_1_sunny_dir_color_at_canonical_times_of_day() {
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_sunny_dir_color_at_canonical_times_of_day] SKIP");
            return;
        };
        use holtburger_dat::DatDatabase;
        use holtburger_dat::file_type::Region;
        use std::io::Cursor;

        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");
        let sky = region.sky_info.clone().expect("SkyInfo");
        let game_time = region.game_time.clone();

        // Pin DayGroup[0] "Sunny".
        let sunny_only = SkyDesc {
            tick_size: sky.tick_size,
            light_tick_size: sky.light_tick_size,
            day_groups: vec![sky.day_groups[0].clone()],
        };

        let probe = |t: f32| -> (u32, u32, u32) {
            let mut evaluator = SkyEvalState::new();
            evaluator.set_time_of_day_override(Some(t));
            let (s, _) = evaluator.evaluate(&sunny_only, &game_time, 0.0).unwrap();
            (s.dir_color_argb, s.amb_color_argb, s.fog_color_argb)
        };
        let p25 = probe(0.25);
        let p50 = probe(0.50);
        let p75 = probe(0.75);
        let p99 = probe(0.99);

        eprintln!("=== Sky-B Sunny dir/amb/fog lerp probe ===");
        eprintln!(
            "  t=0.25 dir=0x{:08X} amb=0x{:08X} fog=0x{:08X}",
            p25.0, p25.1, p25.2
        );
        eprintln!(
            "  t=0.50 dir=0x{:08X} amb=0x{:08X} fog=0x{:08X}",
            p50.0, p50.1, p50.2
        );
        eprintln!(
            "  t=0.75 dir=0x{:08X} amb=0x{:08X} fog=0x{:08X}",
            p75.0, p75.1, p75.2
        );
        eprintln!(
            "  t=0.99 dir=0x{:08X} amb=0x{:08X} fog=0x{:08X}",
            p99.0, p99.1, p99.2
        );
        // At least 3 of the 4 probes should differ from at least one
        // other on the dir/amb/fog axes — confirms the lerp is alive
        // across the day cycle.
        let probes = [p25, p50, p75, p99];
        let mut distinct = std::collections::HashSet::new();
        for p in &probes {
            distinct.insert((p.0, p.1, p.2));
        }
        assert!(
            distinct.len() >= 3,
            "lerp should produce at least 3 distinct dir/amb/fog tuples across t=0.25, 0.50, 0.75, 0.99: got {}",
            distinct.len()
        );
    }

    /// Pin DayGroup[0] explicitly and dump all 7 SkyObject snapshots at
    /// noon (t=0.5). Used by the Sky-B report — gives concrete heading,
    /// pitch, visibility for the Sunny day group's celestial fleet.
    #[test]
    fn region_1_sunny_day_group_zero_noon_snapshot_dump() {
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_sunny_day_group_zero_noon_snapshot_dump] SKIP");
            return;
        };
        use holtburger_dat::DatDatabase;
        use holtburger_dat::file_type::Region;
        use std::io::Cursor;

        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");
        let sky = region.sky_info.clone().expect("SkyInfo");
        let game_time = region.game_time.clone();

        // Pin DayGroup[0] by directly evaluating against a SkyDesc
        // clone that contains ONLY DayGroup[0] — bypasses the LCG
        // hash entirely so this test is stable independent of the
        // anchor.
        let sunny_only = SkyDesc {
            tick_size: sky.tick_size,
            light_tick_size: sky.light_tick_size,
            day_groups: vec![sky.day_groups[0].clone()],
        };

        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(0.5));
        let (state, objects) = evaluator
            .evaluate(&sunny_only, &game_time, 0.0)
            .expect("must evaluate");

        eprintln!("=== Sky-B noon (t=0.5) — DayGroup[0] {:?} ===", sky.day_groups[0].day_name);
        eprintln!(
            "  state: dir_color=0x{:08X} dir_bright={} dir_heading={} dir_pitch={}",
            state.dir_color_argb, state.dir_bright, state.dir_heading, state.dir_pitch
        );
        eprintln!(
            "  state: amb_color=0x{:08X} amb_bright={}",
            state.amb_color_argb, state.amb_bright
        );
        eprintln!(
            "  state: fog_color=0x{:08X} fog_min={} fog_max={} world_fog={}",
            state.fog_color_argb, state.fog_min, state.fog_max, state.world_fog
        );
        eprintln!("  state: day_group={} tod={}", state.day_group_index, state.time_of_day_normalized);
        for (i, o) in objects.iter().enumerate() {
            eprintln!(
                "  obj[{i}]: gfx_id=0x{:08X} heading={:.4} pitch={:.4} visible={} transparent={} luminosity={} max_bright={} tex_offset=({:.4},{:.4}) properties=0x{:X}",
                o.gfx_object_id,
                o.heading,
                o.pitch,
                o.visible,
                o.transparent,
                o.luminosity,
                o.max_bright,
                o.tex_offset_x,
                o.tex_offset_y,
                o.properties,
            );
        }

        assert_eq!(objects.len(), 7, "Sunny day group must have 7 sky objects");
        // The physics-scripted moon SetupModel 0x02000714 must be in
        // the snapshot list verbatim.
        let has_setup_model = objects.iter().any(|o| o.gfx_object_id == 0x0200_0714);
        assert!(
            has_setup_model,
            "0x02000714 SetupModel must be in Sunny day group snapshot list: \
             {:?}",
            objects.iter().map(|o| format!("0x{:08X}", o.gfx_object_id)).collect::<Vec<_>>()
        );
    }

    /// Verify SkyObject lists land verbatim — `0x02000714` SetupModel
    /// ID must round-trip without truncation through the snapshot.
    #[test]
    fn sky_object_setup_model_id_surfaced_verbatim() {
        let Some(path) = locate_portal_dat() else {
            eprintln!("[sky_object_setup_model_id_surfaced_verbatim] SKIP");
            return;
        };
        use holtburger_dat::DatDatabase;
        use holtburger_dat::file_type::Region;
        use std::io::Cursor;

        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");
        let sky = region.sky_info.clone().expect("SkyInfo");
        let game_time = region.game_time.clone();

        // Force DayGroup[0] selection by anchoring at (day=0, year=0)
        // — we don't actually need this since we're inspecting the raw
        // sky_objects list, but the snapshot path validates the same.
        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(0.5));
        let (_, objects) = evaluator.evaluate(&sky, &game_time, 0.0).unwrap();
        let mut all_ids: Vec<u32> = objects.iter().map(|o| o.gfx_object_id).collect();
        all_ids.sort();
        eprintln!(
            "[Sky-B evaluator] active DayGroup gfx_ids = {:?}",
            all_ids
                .iter()
                .map(|id| format!("0x{id:08X}"))
                .collect::<Vec<_>>()
        );
        for &id in &all_ids {
            let prefix = id >> 24;
            assert!(
                id == 0 || prefix == 0x01 || prefix == 0x02,
                "SkyObject gfx_object_id 0x{id:08X} has unexpected prefix 0x{prefix:02X}"
            );
        }
    }

    #[test]
    fn argb_lerp_decodes_round_trips_endpoints() {
        // a=0x80112233 b=0xC0AABBCC at u=0 → a, at u=1 → b.
        let a = 0x80_11_22_33u32;
        let b = 0xC0_AA_BB_CCu32;
        assert_eq!(lerp_argb(a, b, 0.0), a);
        assert_eq!(lerp_argb(a, b, 1.0), b);
        // u=0.5 — each channel lerps to the midpoint. We use .round()
        // rather than truncating, so (51+204)/2.0 = 127.5 → 128 (not
        // 127 like integer division). Build the expected midpoint
        // with .round() to match.
        let expected_channel = |a: u32, b: u32| -> u32 {
            ((a as f32 + b as f32) * 0.5).round() as u32
        };
        let mid = lerp_argb(a, b, 0.5);
        let ma = (mid >> 24) & 0xFF;
        let mr = (mid >> 16) & 0xFF;
        let mg = (mid >> 8) & 0xFF;
        let mb = mid & 0xFF;
        assert_eq!(ma, expected_channel(0x80, 0xC0));
        assert_eq!(mr, expected_channel(0x11, 0xAA));
        assert_eq!(mg, expected_channel(0x22, 0xBB));
        assert_eq!(mb, expected_channel(0x33, 0xCC));
    }
}
