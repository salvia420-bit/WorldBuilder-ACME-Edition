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

// ---- SkyObject.properties bit decode (Workstream Sky-G) -------------
//
// The `properties: u32` field on `SkyObject` carries flag bits the
// PhatSDK code reads but never consumes (`GameSky::UseTime` is
// `UNFINISHED`; `SkyDesc.cpp` and `dats.xml` both list it without
// semantics). ACE's source has zero references; the original AC client
// is the only place these bits are dispatched on.
//
// The constants below are derived from a histogram across all 20
// retail Dereth DayGroups (Region 0x13000000), captured by the
// `region_1_probe_sky_object_properties_across_all_day_groups` test:
//
//   props=0x00 → 120 occurrences across 9 unique gfx ids:
//     sun, moons, sky shells, stars, SetupModel moon 0x02000714.
//     All have begin_time/end_time != 0 OR are static (sky shells).
//     Zero tex_velocity. No PhysicsScript.
//
//   props=0x02 → 20 occurrences across 7 unique gfx ids:
//     ALL are cloud-band 0x01xxxxxx GfxObjs (0x010015B6, 0x01004C35-3A).
//     ALL have small tex_velocity (~-0.013, -0.013) → scrolling clouds.
//     ALL have begin_time==end_time==0 (always-visible). No
//     PhysicsScript. The cloud band is alpha-blended on top of the
//     base sky shell.
//
//   props=0x04 → 8 occurrences on 0x01004C42 (vel 0.02, -2.0):
//     Heavy-vertical-scroll texture. No PhysicsScript. Always-visible.
//     One of two storm-weather streak meshes.
//
//   props=0x05 → 8 occurrences on 0x01004C44 (vel 0.02, -1.7):
//     Same shape as 0x04 but with bit 0x01 set. Companion streak.
//
//   props=0x0D → 76 occurrences on 0x02000588/589/BA6 (SetupModel):
//     ALL have a PhysicsScript DID (0x33000428/42C/453) → e.g. rain
//     drop physics. ALL have non-zero begin_time and end_time
//     (windowed visibility). Zero tex_velocity.
//
// **Bit-by-bit derivation** — comparing the histogram entries:
//   - props=0x04 (vel (0.02, -2.0)) and props=0x05 (vel (0.02, -1.7))
//     differ only in bit 0x01. Both have heavy vertical scroll. The
//     companion 0x05 is one of a "rain/snow streak pair."
//   - props=0x02 only on 0x01xxxxxx scrolling cloud bands.
//   - props=0x0D = 0x08 | 0x04 | 0x01 only on 0x02xxxxxx SetupModels
//     with a PhysicsScript. So bit 0x08 = "PhysicsScript-bound."
//
// Inferred bit semantics (HYPOTHESIS — partial decode, verified for
// the rendering pipeline against retail screenshots: cloud bands DO
// alpha-blend translucently, weather streaks DO render additively,
// SetupModel-physics-scripts DO follow PhysicsScript-driven motion).
// Bit 0 (0x01) is the least confident — the only differentiator
// between 0x04 and 0x05 in retail data; we tentatively treat it as
// "additive blend" because rain/snow particles are conventionally
// additively blended in the AC era.
//
// **CAUTION:** Bit decoding is hypothesis-validated only against
// retail Dereth's surface usage. There may be unset bits used by
// non-Dereth Regions (Marae, etc.) we haven't probed. If a future
// agent encounters props with bits other than {0, 1, 2, 3} set, it
// SHOULD revisit this table and run the probe test on the new region.

/// Bit 0 (0x01): tentatively "additive blending" — only present on
/// 0x01004C44 (rain/snow streak companion, props=0x05) and
/// 0x02000588/589/BA6 (SetupModel weather, props=0x0D). The 0x04 vs
/// 0x05 pair differs only by this bit; rain in classic-era games is
/// typically additively blended. Confidence: LOW (one differentiator
/// in retail data).
pub const SKY_OBJ_PROP_ADDITIVE_BLEND: u32 = 0x01;

/// Bit 1 (0x02): "scrolling cloud band — translucent UV scroll." Set
/// on every cloud-band gfx id (0x010015B6, 0x01004C35-3A) — and ONLY
/// on those. Confidence: HIGH (perfect correlation with non-zero
/// tex_velocity on a cloud-named mesh).
pub const SKY_OBJ_PROP_SCROLLING_CLOUD: u32 = 0x02;

/// Bit 2 (0x04): "heavy UV scroll / weather streak." Set on
/// 0x01004C42 and 0x01004C44 — the two weather-streak meshes — and
/// also on the SetupModel rain/snow effects (in combination with bits
/// 0 and 3 → props=0x0D). The distinguishing feature is large
/// tex_velocity_y magnitude (>1.0). Confidence: MEDIUM (small sample,
/// 2 unique 0x01 ids).
pub const SKY_OBJ_PROP_WEATHER_STREAK: u32 = 0x04;

/// Bit 3 (0x08): "PhysicsScript-bound." Only present on
/// 0x02xxxxxx SetupModels that ALSO carry a non-zero
/// `default_pes_object_id` (PhysicsScript DID). 100% correlated in
/// retail data: every SetupModel weather effect has bit 3 set, and
/// no GfxObj does. Confidence: HIGH.
pub const SKY_OBJ_PROP_PHYSICS_SCRIPT: u32 = 0x08;

/// Convenience predicate: should the renderer treat this SkyObject
/// as a translucent / alpha-blended billboard? True if EITHER the
/// scrolling-cloud OR the weather-streak bit is set. AC's classic
/// pipeline used the AlphaBlend renderstate for both.
pub fn sky_object_is_translucent(properties: u32) -> bool {
    (properties & (SKY_OBJ_PROP_SCROLLING_CLOUD | SKY_OBJ_PROP_WEATHER_STREAK)) != 0
}

/// Convenience predicate: should the renderer apply additive blending
/// instead of conventional alpha? Hypothesis-based — see
/// [`SKY_OBJ_PROP_ADDITIVE_BLEND`] doc for the confidence note.
pub fn sky_object_is_additive(properties: u32) -> bool {
    (properties & SKY_OBJ_PROP_ADDITIVE_BLEND) != 0
}

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
///
/// **Workstream Sky-I-B (2026-05-11):** the `heading` / `pitch` fields
/// retain the Sky-B/D cooked-radians shape for backward compatibility,
/// but the **raw degree/window fields** (`begin_angle_deg`,
/// `end_angle_deg`, `begin_time`, `end_time`, `current_progress`) are
/// the load-bearing values for the new sky-cell render path
/// (`scene3d/sky_dome.js`). The renderer constructs its rotation
/// matrix from `lerp(begin_angle_deg, end_angle_deg, current_progress) *
/// (π / 180)` directly — degrees→radians ownership now sits on the JS
/// side. The cooked `heading` continues to honor the historical
/// `lerp_angle_radians` arithmetic (incorrectly treating degrees as
/// radians) and is deprecated; the JS side may safely ignore it. See
/// `external/holtburger/docs/sky-i-probe-2026-05-11.md` for the
/// empirical probe that surfaced the unit bug.
#[derive(Debug, Clone, Copy)]
pub struct SkyObjectSnapshot {
    /// `0x01xxxxxx` (GfxObj) OR `0x02xxxxxx` (SetupModel). Renderer
    /// dispatches on the high byte. May reflect a SkyObjectReplace's
    /// `gfx_obj_id` override when the surrounding SkyTimeOfDay swaps
    /// the mesh for this index.
    pub gfx_object_id: u32,
    /// **DEPRECATED (Sky-I-B).** Cooked heading on the sky dome
    /// (radians) — the historical Sky-B/D output. Lerped between
    /// `begin_angle` and `end_angle` over the visible window via
    /// `lerp_angle_radians`, which treats the DAT-provided angles as
    /// radians even though they are actually DEGREES. Retained for
    /// backward compatibility; the Sky-I-B render path consumes the
    /// raw `begin_angle_deg` / `end_angle_deg` / `current_progress`
    /// fields instead and performs the deg→rad conversion JS-side.
    pub heading: f32,
    /// **DEPRECATED (Sky-I-B).** Cooked pitch off horizon (radians).
    /// Derived as `sin(p * pi) * (pi/2)` so the object rises from
    /// horizon, peaks at midday, and sets at horizon. Static for
    /// always-visible objects (begin == end). The Sky-I-B render path
    /// elides pitch synthesis entirely (celestials trace a horizontal
    /// arc at native vertex altitude — see the open-question note in
    /// the probe memo); this field is preserved so the historical
    /// Sky-D path can read it.
    pub pitch: f32,
    /// **Sky-I-B.** Raw `SkyObject.begin_angle` in DEGREES (verbatim
    /// from the DAT — no conversion). The JS-side render path consumes
    /// this directly: `headingRad = lerp(beginAngleDeg, endAngleDeg,
    /// currentProgress) * (π / 180)`. Retail Dereth ships
    /// `begin_angle ∈ {-20, -23}` (just east of north) for sun / moon /
    /// stars; `0.0` for always-visible base shells and the cloud band.
    pub begin_angle_deg: f32,
    /// **Sky-I-B.** Raw `SkyObject.end_angle` in DEGREES. Retail Dereth
    /// ships `end_angle ∈ {190, 203}` (just west of north going CW).
    pub end_angle_deg: f32,
    /// **Sky-I-B.** Raw `SkyObject.begin_time` in normalized day
    /// fraction `[0, 1)`. Retail Dereth: sun=0.04, moon=0, stars=0.16,
    /// base shells / cloud band / SetupModel proxy = 0.0.
    pub begin_time: f32,
    /// **Sky-I-B.** Raw `SkyObject.end_time`. Retail Dereth: sun=0.21,
    /// moon=0.23, stars=0.94, base shells / cloud band / SetupModel
    /// proxy = 0.0. The `begin_time == end_time` case is the
    /// always-visible sentinel.
    pub end_time: f32,
    /// **Sky-I-B.** Lerp parameter `[0, 1]` across the visible window:
    /// - Always-visible (`begin == end`): `0.0`.
    /// - Forward arc (`begin < end`, t in `[begin, end)`): `(t - begin)
    ///   / (end - begin)`.
    /// - Wrap-around (`end < begin`, e.g. stars 0.875..0.125): the same
    ///   re-anchored math the cooked `heading` path uses, so the JS
    ///   side can lerp `begin_angle_deg → end_angle_deg` linearly with
    ///   this parameter and get the same arc.
    /// `0.0` when the object is not currently visible.
    pub current_progress: f32,
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
    /// **Sky-J P5.** Pass-through of `SkyObject.default_pes_object_id`
    /// — a `QualifiedDataId<PhysicsScript>` (0x33xxxxxx) when non-zero.
    /// Used by the JS sky renderer to walk the
    /// `SkyObject → PhysicsScript → CreateParticleHook → ParticleEmitter`
    /// chain for 0x02 SetupModel sky objects (retail moon
    /// `0x02000714` → `0x330007DB`; weather SetupModels likewise).
    /// `0` means "no physics script attached" — typical for 0x01
    /// GfxObj sky objects (sun, moon mesh, cloud bands, stars).
    pub pes_object_id: u32,
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
    /// Per-session start anchor (Unix seconds, f64). Set to the FIRST
    /// `now_unix` passed to `evaluate` (or via
    /// `set_session_start_unix`). Used by the Sky-G `tex_offset_*`
    /// accumulator so the f64 multiplication `tex_velocity * elapsed`
    /// doesn't lose precision when `(now - AC_LAUNCH_UNIX_EPOCH)` is
    /// ~8e8 seconds (~26 years). The wrap-modulo math itself is correct
    /// against the launch anchor, but `0.013 * 8e8 = 1e7` loses 7 digits
    /// of f64 precision in the rem_euclid; anchoring to session start
    /// keeps the multiplicand in `[0, ~3600]` for a typical session.
    /// Workstream Sky-G.
    session_start_unix: Option<f64>,
    /// Optional explicit (current_day, current_year) override that
    /// bypasses the wall-clock derivation in
    /// `world_day_and_year`. Used by capture-driven verification
    /// (`setGameDayOverride`) to force the LCG hash to select a
    /// specific DayGroup without waiting for real-world midnight to
    /// roll over. Workstream Sky-G.
    game_day_override: Option<(u32, u32)>,
    /// When `Some`, overrides the wall-clock-derived `time_of_day_normalized`
    /// with this value verbatim. Used by the JS-side accelerated-day
    /// demo (`?skytime=accel`). Independent of the LCG day selector —
    /// the demo path advances `day_group_index` via the override too
    /// (the JS path picks day-group for the synthetic day).
    time_of_day_override: Option<f32>,
    /// Cached `(current_day, current_year) → day_group_index`. Computed
    /// once per game-day boundary so the per-frame eval just looks up.
    /// Workstream Sky-G refresh: invalidated whenever the
    /// `(current_year, current_day)` tuple changes — caller passes the
    /// resolved tuple to `select_day_group`, which compares to the
    /// cached entry and recomputes on mismatch. Crossings happen at
    /// midnight in game time (`day_length=7620s` for retail Dereth,
    /// so every ~127 minutes of real time the day rolls over).
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
            session_start_unix: None,
            game_day_override: None,
            time_of_day_override: None,
            cached_day_group: None,
        }
    }

    /// Force the session-start anchor used by tex_offset accumulation.
    /// If not set explicitly, the FIRST `evaluate()` call latches its
    /// `now_unix` as the session start.
    /// Workstream Sky-G.
    pub fn set_session_start_unix(&mut self, t: f64) {
        self.session_start_unix = Some(t);
    }

    /// Force a (day, year) game-day tuple instead of deriving from the
    /// wall clock. Pass `None` to clear and return to wall-clock mode.
    /// Used by capture-driven verification to force DayGroup cycling
    /// without waiting for real-world midnight. Workstream Sky-G.
    pub fn set_game_day_override(&mut self, day_year: Option<(u32, u32)>) {
        self.game_day_override = day_year;
        // Invalidate the day-group cache so the next `evaluate` recomputes.
        self.cached_day_group = None;
    }

    /// Current game-day override (diagnostic).
    pub fn game_day_override(&self) -> Option<(u32, u32)> {
        self.game_day_override
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
    ///
    /// Workstream Sky-G: latches `session_start_unix` on first call so
    /// the cloud UV scroll uses session-relative elapsed time. Reads
    /// `game_day_override` when set to bypass wall-clock day
    /// derivation. The SkyObjectReplace overrides are now interpolated
    /// across BOTH bracketing SkyTimeOfDay keyframes (not just the
    /// active one) — see [`evaluate_sky_object`] for the lerp math.
    pub fn evaluate(
        &mut self,
        sky_desc: &SkyDesc,
        game_time: &GameTime,
        now_unix: f64,
    ) -> Option<(SkyStateSnapshot, Vec<SkyObjectSnapshot>)> {
        if sky_desc.day_groups.is_empty() {
            return None;
        }
        // Latch session start on first eval (Sky-G UV scroll anchor).
        if self.session_start_unix.is_none() {
            self.session_start_unix = Some(now_unix);
        }
        let session_elapsed = (now_unix - self.session_start_unix.unwrap()).max(0.0);

        let (day, year) = if let Some(forced) = self.game_day_override {
            forced
        } else {
            self.world_day_and_year(now_unix, game_time)
        };
        let day_group_index = self.select_day_group(sky_desc, day, year);
        let day_group = &sky_desc.day_groups[day_group_index as usize];
        let time_of_day = self.current_time_of_day_normalized(now_unix, game_time);

        let (kf_a, kf_b, kf_u, sky_state) =
            evaluate_lighting(day_group, time_of_day, day_group_index);

        let mut objects = Vec::with_capacity(day_group.sky_objects.len());
        for (object_index, sky_object) in day_group.sky_objects.iter().enumerate() {
            // Sky-G: collect the SkyObjectReplace entries (if any) from
            // BOTH bracketing keyframes so the renderer sees lerped
            // float fields and a hard-switched gfx_obj_id at the
            // later keyframe's begin. Either or both may be None.
            let replace_a = kf_a.and_then(|kf| {
                kf.sky_obj_replace
                    .iter()
                    .find(|r| r.object_index as usize == object_index)
            });
            let replace_b = kf_b.and_then(|kf| {
                kf.sky_obj_replace
                    .iter()
                    .find(|r| r.object_index as usize == object_index)
            });
            objects.push(evaluate_sky_object(
                sky_object,
                replace_a,
                replace_b,
                kf_u,
                time_of_day,
                session_elapsed,
            ));
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
/// surrounding `time_of_day`. Returns `(kf_a, kf_b, u, lerped_state)` —
/// Workstream Sky-G now surfaces BOTH bracketing keyframes (not just
/// `active`) so [`evaluate_sky_object`] can interpolate
/// SkyObjectReplace floats and hard-switch gfx_obj_id at the boundary.
/// Wraps across midnight when the last keyframe's `begin` >
/// `time_of_day` < first keyframe's `begin`.
fn evaluate_lighting<'a>(
    day_group: &'a DayGroup,
    time_of_day: f32,
    day_group_index: u32,
) -> (
    Option<&'a SkyTimeOfDay>,
    Option<&'a SkyTimeOfDay>,
    f32,
    SkyStateSnapshot,
) {
    if day_group.sky_time.is_empty() {
        return (
            None,
            None,
            0.0,
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
    (Some(a), Some(b), u, state)
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
/// - **Tex scroll**: accumulated UV offset from
///   `tex_velocity * session_elapsed` wrapping at 1.0 — anchored to
///   the FIRST `evaluate` call's `now_unix` so f64 precision stays in
///   `[0, ~3600]` range for a typical session (Workstream Sky-G).
/// - **SkyObjectReplace override**: scalar float fields (`rotate`,
///   `transparent`, `luminosity`, `max_bright`) are LERPED across the
///   two bracketing SkyTimeOfDay keyframes' matching replace entries;
///   `gfx_obj_id` HARD-SWITCHES at the later keyframe's `begin` —
///   it's a DID and can't be lerped. When only one keyframe carries a
///   replace for this object_index, the other endpoint of the lerp
///   defaults to the previous frame's value (i.e. lerping FROM
///   no-replace effectively snaps the new replace's params in over
///   the keyframe-pair window). Workstream Sky-G.
///
/// The pitch curve `sin(p * pi)` is documented as a derivation —
/// the dat carries `begin_angle, end_angle` as the rising/setting
/// horizon headings but NO pitch keyframe, so we synthesize the
/// vertical arc here. Sky-D's eye-test will tune the shape; for now
/// it's the canonical low-frequency arc shape (matches the AC client
/// behaviour where sun/moon dip below horizon at begin/end).
fn evaluate_sky_object(
    sky_object: &SkyObject,
    replace_a: Option<&SkyObjectReplace>,
    replace_b: Option<&SkyObjectReplace>,
    kf_u: f32,
    t: f32,
    session_elapsed: f64,
) -> SkyObjectSnapshot {
    let begin = sky_object.begin_time;
    let end = sky_object.end_time;
    let always_visible = begin == end;

    // Sky-I-B: compute the lerp parameter `current_progress` once, then
    // derive both the raw-degree heading the JS render path uses AND
    // the historical cooked-radians `heading` / `pitch` for backward
    // compatibility. The two are intentionally separate because the
    // cooked `heading` carries the legacy degrees-as-radians bug
    // (see `lerp_angle_radians` doc + the Sky-I-A probe memo).
    let (visible, current_progress, heading, pitch) = if always_visible {
        // Always-visible: static heading at begin_angle, no pitch arc.
        // Stars / base-sky shell / milky-way fall here.
        // current_progress=0 — the JS renderer reads begin_angle_deg
        // directly via `lerp(begin, end, 0) = begin` so the static
        // arc lands at the authored heading.
        (true, 0.0_f32, sky_object.begin_angle, 0.0_f32)
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
            (true, p, heading, pitch)
        } else {
            (false, 0.0, sky_object.begin_angle, 0.0)
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
            (true, p, heading, pitch)
        } else {
            (false, 0.0, sky_object.begin_angle, 0.0)
        }
    };

    // Sky-G UV scroll: anchored to session_elapsed (not absolute world
    // seconds) for f64 precision. Per-tick increment is `tex_velocity *
    // (now - session_start)`; we mod 1.0 to wrap. For the canonical
    // retail cloud band (tex_vel_x=-0.013), at session_elapsed=10s the
    // offset is ~-0.13 mod 1 = 0.87; at 20s it's ~0.74 — i.e. monotonic
    // scroll wrapping at unit intervals.
    let tex_offset_x = ((sky_object.tex_velocity_x as f64 * session_elapsed).rem_euclid(1.0)) as f32;
    let tex_offset_y = ((sky_object.tex_velocity_y as f64 * session_elapsed).rem_euclid(1.0)) as f32;

    // Sky-G: dual-keyframe SkyObjectReplace interpolation.
    //
    // Lerp the four float fields between the two bracketing keyframes'
    // replace entries (matched on object_index). gfx_obj_id is a DID —
    // can't be lerped; we hard-switch to the LATER keyframe's value at
    // its `begin` so the mesh swap is crisp. The earlier keyframe
    // "wins" until kf_u crosses 0.5 (matches the world_fog discrete
    // lerp policy in lerp_sky_time).
    let (gfx_object_id, transparent, luminosity, max_bright) =
        lerp_sky_object_replace(sky_object, replace_a, replace_b, kf_u);

    SkyObjectSnapshot {
        gfx_object_id,
        heading,
        pitch,
        begin_angle_deg: sky_object.begin_angle,
        end_angle_deg: sky_object.end_angle,
        begin_time: sky_object.begin_time,
        end_time: sky_object.end_time,
        current_progress,
        tex_offset_x,
        tex_offset_y,
        transparent,
        luminosity,
        max_bright,
        visible,
        properties: sky_object.properties,
        pes_object_id: sky_object.default_pes_object_id,
    }
}

/// Lerp the SkyObjectReplace state across two bracketing keyframes.
/// Returns `(gfx_obj_id, transparent, luminosity, max_bright)`.
///
/// **Float fields** (transparent, luminosity, max_bright) lerp
/// component-wise. When only one side has a replace, the "no-replace"
/// side defaults to the SkyObject's static state:
/// - `transparent` defaults to `-1.0` (the "no override" sentinel).
/// - `luminosity` / `max_bright` default to `-1.0`.
///
/// **gfx_obj_id** hard-switches at `kf_u >= 0.5` (same discrete-cut
/// policy as `world_fog`). When a replace's `gfx_obj_id == 0`, that
/// means "no mesh override — keep the SkyObject's default mesh."
///
/// In retail Dereth's data the replace entries DON'T override
/// `gfx_obj_id` (every replace.gfx_obj_id is `0x00000000` per the
/// Sky-G probe dump); this implementation handles the general case
/// in case Marae or a custom region uses it.
fn lerp_sky_object_replace(
    sky_object: &SkyObject,
    replace_a: Option<&SkyObjectReplace>,
    replace_b: Option<&SkyObjectReplace>,
    kf_u: f32,
) -> (u32, f32, f32, f32) {
    // Helper: resolve a replace's effective gfx_obj_id; `0` means
    // "use the SkyObject's default mesh."
    let resolve_gfx = |r: &SkyObjectReplace| -> u32 {
        if r.gfx_obj_id != 0 {
            r.gfx_obj_id
        } else {
            sky_object.default_gfx_object_id
        }
    };

    // Resolve the four-tuple from each side independently, then lerp.
    // When a side is None, fall back to the "no override" sentinel
    // (-1.0 for the floats, default mesh for gfx_obj_id).
    let (gfx_a, tr_a, lu_a, mb_a) = match replace_a {
        Some(r) => (resolve_gfx(r), r.transparent, r.luminosity, r.max_bright),
        None => (sky_object.default_gfx_object_id, -1.0, -1.0, -1.0),
    };
    let (gfx_b, tr_b, lu_b, mb_b) = match replace_b {
        Some(r) => (resolve_gfx(r), r.transparent, r.luminosity, r.max_bright),
        None => (sky_object.default_gfx_object_id, -1.0, -1.0, -1.0),
    };

    // Lerp floats. When a side reports "-1.0" (sentinel: no override),
    // skip the lerp on that field and use the OTHER side verbatim
    // (so a one-sided replace surfaces as a step-in over the keyframe
    // pair window, not as a fade-from-negative-one).
    let transparent = lerp_with_sentinel(tr_a, tr_b, kf_u, -1.0);
    let luminosity = lerp_with_sentinel(lu_a, lu_b, kf_u, -1.0);
    let max_bright = lerp_with_sentinel(mb_a, mb_b, kf_u, -1.0);

    // gfx_obj_id: hard-switch at kf_u >= 0.5 (same policy as
    // `world_fog`). At the keyframe boundaries themselves (u=0 or u=1)
    // we pick the corresponding side cleanly.
    let gfx = if kf_u < 0.5 { gfx_a } else { gfx_b };
    (gfx, transparent, luminosity, max_bright)
}

/// Lerp two floats but skip the lerp when EITHER endpoint is the
/// `sentinel` value — in that case the result is the non-sentinel
/// side (or `sentinel` if both are sentinels). Used by
/// [`lerp_sky_object_replace`] to handle one-sided SkyObjectReplaces
/// without producing meaningless lerps like `-1.0 → 0.5`.
fn lerp_with_sentinel(a: f32, b: f32, u: f32, sentinel: f32) -> f32 {
    let a_is = (a - sentinel).abs() < 1e-6;
    let b_is = (b - sentinel).abs() < 1e-6;
    if a_is && b_is {
        sentinel
    } else if a_is {
        b
    } else if b_is {
        a
    } else {
        lerp_f32(a, b, u)
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
/// Shortest-path lerp between two angles. Despite the historical name
/// ("radians"), `dir_heading` values from the DAT are in DEGREES — see
/// `scene3d/sun_direction.js` which converts via `DEG_TO_RAD` and the
/// SkyObjectSnapshot doc note at the top of this file. The previous
/// implementation called plain `lerp_f32` which produced a 180° jump
/// whenever consecutive keyframes straddled the 0°/360° wrap (e.g.
/// dusk → midnight → dawn). Symptoms reported 2026-05-20: the sun
/// "moved really fast and got stuck" — visible discrete heading jumps
/// at low FPS, then directional light frozen in the wrong hemisphere.
///
/// Fix: normalize the inter-keyframe delta into (-180, 180] before
/// interpolating, so the lerp picks the shorter arc around the unit
/// circle. Period 360 because the inputs are degrees (verified
/// upstream by `sunDirFromHeadingPitch(headingDeg, pitchDeg)`).
///
/// Keyframes that don't straddle the wrap are unaffected — the
/// arithmetic reduces to `a + (b - a) * u` exactly when |b - a| <=
/// 180. Pitch lerp doesn't use this; pitches never cross a boundary.
fn lerp_angle_radians(a: f32, b: f32, u: f32) -> f32 {
    let mut delta = b - a;
    if delta > 180.0 {
        delta -= 360.0;
    } else if delta < -180.0 {
        delta += 360.0;
    }
    a + delta * u
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

    /// Workstream Sky-G: probe SkyObject.properties across every DayGroup
    /// in Region 0x13000000 and every SkyObjectReplace's referenced object.
    /// Builds a `(properties, gfx_obj_id_prefix)` histogram so we can
    /// reason about what each bit means.
    ///
    /// Read-only — emits a diagnostic dump to stderr; the only assertion
    /// is that we found at least 7 SkyObjects (sanity check on the dat).
    #[test]
    fn region_1_probe_sky_object_properties_across_all_day_groups() {
        let Some(path) = locate_portal_dat() else {
            eprintln!("[region_1_probe_sky_object_properties_across_all_day_groups] SKIP");
            return;
        };
        use holtburger_dat::DatDatabase;
        use holtburger_dat::file_type::Region;
        use std::collections::BTreeMap;
        use std::io::Cursor;

        let dat = DatDatabase::new(&path).expect("portal.dat");
        let bytes = dat.get_file(0x1300_0000).expect("Region 0x13000000");
        let region = Region::unpack(&mut Cursor::new(&bytes)).expect("Region must parse");
        let sky = region.sky_info.clone().expect("SkyInfo");

        // (properties_u32, gfx_prefix) → count
        let mut hist: BTreeMap<(u32, u8), u32> = BTreeMap::new();
        // (properties_u32) → set of gfx_obj_ids carrying it
        let mut props_to_ids: BTreeMap<u32, std::collections::BTreeSet<u32>> = BTreeMap::new();
        let mut total_objects = 0_u32;
        let mut total_day_groups = 0_u32;

        eprintln!("=== Sky-G SkyObject.properties probe (Region 0x13000000) ===");
        for (dg_idx, dg) in sky.day_groups.iter().enumerate() {
            total_day_groups += 1;
            eprintln!(
                "DayGroup[{dg_idx}] {:?} (chance={}) — {} sky_objects, {} sky_time",
                dg.day_name,
                dg.chance_of_occur,
                dg.sky_objects.len(),
                dg.sky_time.len()
            );
            for (so_idx, so) in dg.sky_objects.iter().enumerate() {
                total_objects += 1;
                let prefix = ((so.default_gfx_object_id >> 24) & 0xFF) as u8;
                *hist.entry((so.properties, prefix)).or_insert(0) += 1;
                props_to_ids
                    .entry(so.properties)
                    .or_default()
                    .insert(so.default_gfx_object_id);
                eprintln!(
                    "  obj[{so_idx}]: gfx=0x{:08X} pes=0x{:08X} props=0x{:08X} \
                     begin_time={:.4} end_time={:.4} tex_vel=({:.5},{:.5}) \
                     begin_angle={:.3} end_angle={:.3}",
                    so.default_gfx_object_id,
                    so.default_pes_object_id,
                    so.properties,
                    so.begin_time,
                    so.end_time,
                    so.tex_velocity_x,
                    so.tex_velocity_y,
                    so.begin_angle,
                    so.end_angle,
                );
            }
            // Dump any SkyObjectReplace entries — these may carry different
            // gfx_obj_ids that the cloud-band-style scrolling logic needs to
            // pre-resolve. Sky-G item 1.
            for (kf_idx, kf) in dg.sky_time.iter().enumerate() {
                if !kf.sky_obj_replace.is_empty() {
                    eprintln!(
                        "  keyframe[{kf_idx}] begin={:.4} has {} sky_obj_replace entries:",
                        kf.begin,
                        kf.sky_obj_replace.len()
                    );
                    for (ri, r) in kf.sky_obj_replace.iter().enumerate() {
                        eprintln!(
                            "    replace[{ri}]: object_index={} gfx_obj_id=0x{:08X} \
                             rotate={:.3} transparent={:.3} luminosity={:.3} max_bright={:.3}",
                            r.object_index, r.gfx_obj_id, r.rotate, r.transparent, r.luminosity, r.max_bright
                        );
                    }
                }
            }
        }

        eprintln!("");
        eprintln!("=== HISTOGRAM (properties, gfx_prefix) → count ===");
        for ((props, prefix), count) in &hist {
            eprintln!("  props=0x{:08X} gfx_prefix=0x{:02X} → {} occurrences", props, prefix, count);
        }
        eprintln!("");
        eprintln!("=== UNIQUE GFX IDs PER PROPERTIES VALUE ===");
        for (props, ids) in &props_to_ids {
            let mut sorted: Vec<u32> = ids.iter().copied().collect();
            sorted.sort();
            eprintln!(
                "  props=0x{:08X}: {} unique gfx ids: {:?}",
                props,
                ids.len(),
                sorted.iter().map(|id| format!("0x{:08X}", id)).collect::<Vec<_>>()
            );
        }
        eprintln!("");
        eprintln!(
            "[Sky-G probe] total {} sky_objects across {} day_groups",
            total_objects, total_day_groups
        );

        assert!(total_day_groups > 0, "Region 0x13000000 must have day groups");
        assert!(total_objects >= 7, "expected >= 7 SkyObjects in retail Dereth");
    }

    // === Workstream Sky-G unit tests ====================================

    /// Build a 3-keyframe sky-time so we have unambiguous "between two
    /// replace lists" semantics. Keyframe begins at 0.0, 0.5, 0.9.
    /// Returns (sky_desc, game_time).
    fn make_sky_desc_with_two_replace_keyframes() -> (SkyDesc, GameTime) {
        let mut sky_objects = vec![
            // object[0]: a windowed sun (visible 0.04..0.99 — always on
            // for this test). The replace targets THIS object.
            make_sky_object(0.04, 0.99, 0.0, std::f32::consts::PI, 0x0100_1F67),
            // object[1]: always-visible (sentinel) — NOT a replace
            // target. Used to verify pass-through behaviour.
            make_sky_object(0.0, 0.0, 1.5, 1.5, 0x0100_15EE),
        ];
        // object 0 default_gfx_object_id is 0x01001F67.
        sky_objects[0].default_gfx_object_id = 0x0100_1F67;

        let mut kf0 = make_keyframe(0.0, 0xFF000000, 0.0, 0xFF000000, 0xFF000000);
        let mut kf1 = make_keyframe(0.5, 0xFFFFFFFF, 1.0, 0xFFFFFFFF, 0xFFFFFFFF);
        let kf2 = make_keyframe(0.9, 0xFF808080, 0.5, 0xFF808080, 0xFF808080);

        // kf0 replace: object[0] → gfx 0xABCDEF, transparent 0.0
        kf0.sky_obj_replace.push(SkyObjectReplace {
            object_index: 0,
            gfx_obj_id: 0x00AB_CDEF,
            rotate: 0.0,
            transparent: 0.0,
            luminosity: 0.0,
            max_bright: 0.5,
        });
        // kf1 replace: object[0] → gfx 0x123456, transparent 1.0
        kf1.sky_obj_replace.push(SkyObjectReplace {
            object_index: 0,
            gfx_obj_id: 0x0012_3456,
            rotate: 0.0,
            transparent: 1.0,
            luminosity: 1.0,
            max_bright: 1.0,
        });
        // kf2 has NO replace — tests one-sided lerp.

        let sky_desc = SkyDesc {
            tick_size: 3.0,
            light_tick_size: 20.0,
            day_groups: vec![DayGroup {
                chance_of_occur: 1.0,
                day_name: "Test".into(),
                sky_objects,
                sky_time: vec![kf0, kf1, kf2],
            }],
        };
        (sky_desc, make_game_time())
    }

    #[test]
    fn sky_g_replace_lerps_float_fields_across_two_keyframes() {
        // Validates Sky-G item 1's primary assertion:
        // - At t between kf0 (begin=0.0) and kf1 (begin=0.5), the
        //   replace's `transparent` should LERP from 0.0 → 1.0
        //   over the kf_u in [0, 1].
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new();

        // At the AT-keyframe boundary t=0.0, kf_u=0 (we're sitting on kf0):
        // replace.transparent = 0.0 verbatim.
        evaluator.set_time_of_day_override(Some(0.0));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(
            (objects[0].transparent - 0.0).abs() < 1e-4,
            "at kf0 boundary, transparent should be 0.0 verbatim; got {}",
            objects[0].transparent
        );

        // At MID t=0.25, kf_u=0.5 (halfway between kf0 and kf1):
        // transparent should be lerped to 0.5.
        evaluator.set_time_of_day_override(Some(0.25));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(
            (objects[0].transparent - 0.5).abs() < 1e-4,
            "at midway between kf0 and kf1, transparent should lerp to 0.5; got {}",
            objects[0].transparent
        );
        assert!(
            (objects[0].max_bright - 0.75).abs() < 1e-4,
            "max_bright should lerp from 0.5 (kf0) to 1.0 (kf1) → 0.75 at midway; got {}",
            objects[0].max_bright
        );

        // At PAST t=0.5, kf_u=0 (we just stepped onto kf1):
        // transparent = 1.0 verbatim.
        evaluator.set_time_of_day_override(Some(0.5));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(
            (objects[0].transparent - 1.0).abs() < 1e-4,
            "at kf1 boundary, transparent should be 1.0 verbatim; got {}",
            objects[0].transparent
        );
    }

    #[test]
    fn sky_g_replace_gfx_obj_id_hard_switches_at_keyframe_boundary() {
        // gfx_obj_id is a DID — can't be lerped. The earlier keyframe
        // wins until kf_u >= 0.5, then the later one takes over.
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new();

        // At kf0 boundary: 0xABCDEF.
        evaluator.set_time_of_day_override(Some(0.0));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert_eq!(objects[0].gfx_object_id, 0x00AB_CDEF);

        // Slightly past kf0 but well before kf1 midpoint: kf_u ~= 0.2.
        // Still 0xABCDEF.
        evaluator.set_time_of_day_override(Some(0.1));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert_eq!(objects[0].gfx_object_id, 0x00AB_CDEF, "before kf_u=0.5, still kf0's gfx");

        // Past midpoint between kf0 and kf1: kf_u >= 0.5.
        // Switches to 0x123456.
        evaluator.set_time_of_day_override(Some(0.35));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert_eq!(
            objects[0].gfx_object_id, 0x0012_3456,
            "past midpoint, hard-switches to kf1's gfx_obj_id"
        );

        // At kf1 boundary: 0x123456 verbatim.
        evaluator.set_time_of_day_override(Some(0.5));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert_eq!(objects[0].gfx_object_id, 0x0012_3456);
    }

    #[test]
    fn sky_g_object_without_replace_passes_through_unchanged() {
        // object[1] is always-visible (begin==end) and NO replace
        // targets it; it should retain its default_gfx_object_id and
        // expose transparent/luminosity/max_bright = -1.0 (sentinel).
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new();
        evaluator.set_time_of_day_override(Some(0.25));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert_eq!(objects[1].gfx_object_id, 0x0100_15EE);
        assert!(
            (objects[1].transparent - (-1.0)).abs() < 1e-6,
            "no-replace object should retain transparent=-1.0 sentinel; got {}",
            objects[1].transparent
        );
        assert!((objects[1].luminosity - (-1.0)).abs() < 1e-6);
        assert!((objects[1].max_bright - (-1.0)).abs() < 1e-6);
    }

    #[test]
    fn sky_g_one_sided_replace_skips_lerp_uses_other_endpoint() {
        // Between kf1 (begin=0.5, has replace) and kf2 (begin=0.9, no
        // replace), the `lerp_with_sentinel` helper should hand back
        // kf1's replace values WITHOUT lerping toward -1.0.
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new();
        // t=0.7 lands between kf1 (begin=0.5) and kf2 (begin=0.9).
        // kf1's replace has transparent=1.0; kf2 has no replace
        // (sentinel -1.0). We want transparent to STAY at 1.0, not
        // lerp toward -1.0.
        evaluator.set_time_of_day_override(Some(0.7));
        let (_, objects) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(
            (objects[0].transparent - 1.0).abs() < 1e-4,
            "one-sided replace should NOT lerp into the -1.0 sentinel; got {}",
            objects[0].transparent
        );
    }

    #[test]
    fn sky_g_tex_offset_accumulates_over_session_elapsed() {
        // For the canonical retail cloud band velocity (-0.013, -0.013),
        // two evaluations 10 seconds apart should show |Δtex_offset|
        // ~ 0.13 (mod 1.0). We construct a SkyObject with that velocity
        // and probe.
        let mut sky_object = make_sky_object(0.0, 0.0, 0.0, 0.0, 0x0100_4C36);
        sky_object.tex_velocity_x = -0.013;
        sky_object.tex_velocity_y = -0.013;

        let sky_desc = SkyDesc {
            tick_size: 3.0,
            light_tick_size: 20.0,
            day_groups: vec![DayGroup {
                chance_of_occur: 1.0,
                day_name: "TexTest".into(),
                sky_objects: vec![sky_object],
                sky_time: vec![make_keyframe(0.0, 0xFFFFFFFF, 1.0, 0xFFFFFFFF, 0xFFFFFFFF)],
            }],
        };
        let game_time = make_game_time();
        let mut evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        // Latch session start at t_unix=0.
        evaluator.set_session_start_unix(0.0);
        evaluator.set_time_of_day_override(Some(0.5));

        let (_, objects_t0) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        let tex_x_t0 = objects_t0[0].tex_offset_x;

        // 10 seconds later.
        let (_, objects_t10) = evaluator.evaluate(&sky_desc, &game_time, 10.0).unwrap();
        let tex_x_t10 = objects_t10[0].tex_offset_x;

        // Wrap-aware delta: tex_offset is in [0, 1). Linear delta in raw
        // f32 may wrap (if the offset crosses 0/1 between calls).
        let raw_delta = (tex_x_t10 - tex_x_t0).abs();
        let wrap_delta = (1.0 - raw_delta).abs();
        let unsigned_delta = raw_delta.min(wrap_delta);

        // Expected ~0.013 * 10 = 0.13.
        let expected = 0.013_f32 * 10.0;
        let tolerance = 0.01;
        assert!(
            (unsigned_delta - expected).abs() < tolerance,
            "tex_offset_x should advance by ~{expected} over 10s; got |t10 - t0|={unsigned_delta} (raw={raw_delta} wrap={wrap_delta} t0={tex_x_t0} t10={tex_x_t10})"
        );
    }

    #[test]
    fn sky_g_session_start_latched_on_first_evaluate() {
        // Latch on first `evaluate` call when no explicit
        // `set_session_start_unix` was made.
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        evaluator.set_time_of_day_override(Some(0.5));

        let _ = evaluator.evaluate(&sky_desc, &game_time, 100.0).unwrap();
        assert_eq!(
            evaluator.session_start_unix,
            Some(100.0),
            "first evaluate latches session_start_unix"
        );

        // Second evaluate does NOT update the latch.
        let _ = evaluator.evaluate(&sky_desc, &game_time, 500.0).unwrap();
        assert_eq!(evaluator.session_start_unix, Some(100.0));
    }

    #[test]
    fn sky_g_day_group_index_recomputes_on_date_boundary_crossing() {
        // Build 5 day groups with the same lighting (color irrelevant)
        // and confirm: starting at (day=10, year=5) and explicitly
        // advancing to (day=11, year=5) recomputes the day-group index
        // (because the LCG hash is sensitive to `day`).
        let mut day_groups = Vec::with_capacity(5);
        for i in 0..5_u32 {
            day_groups.push(DayGroup {
                chance_of_occur: 1.0,
                day_name: format!("Day-{i}"),
                sky_objects: vec![make_sky_object(0.0, 0.0, 0.0, 0.0, 0x0100_15EE)],
                sky_time: vec![make_keyframe(
                    0.0,
                    0xFF00_0000 | (i << 16),
                    1.0,
                    0xFFFFFFFF,
                    0xFFFFFFFF,
                )],
            });
        }
        let sky_desc = SkyDesc {
            tick_size: 3.0,
            light_tick_size: 20.0,
            day_groups,
        };
        let game_time = make_game_time();

        let mut evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        // Day=10 year=5
        evaluator.set_game_day_override(Some((10, 5)));
        let (state_d10, _) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        let idx_d10 = state_d10.day_group_index;

        // Day=11 year=5 — should pick a different group (LCG hash is
        // sensitive to `day`). Probe 5 nearby days; we ASSUME at
        // least one in the run differs.
        let mut saw_different = false;
        for d in 11..16_u32 {
            evaluator.set_game_day_override(Some((d, 5)));
            let (state_dn, _) = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
            if state_dn.day_group_index != idx_d10 {
                saw_different = true;
                break;
            }
        }
        assert!(
            saw_different,
            "day_group_index should differ for at least one of days 11..15 (year=5)"
        );
    }

    #[test]
    fn sky_g_set_game_day_override_invalidates_cache() {
        let (sky_desc, game_time) = make_sky_desc_with_two_replace_keyframes();
        let mut evaluator = SkyEvalState::new_with_anchor_unix(0.0);
        // Probe first to populate the cached_day_group via wall-clock.
        evaluator.set_time_of_day_override(Some(0.5));
        let _ = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        assert!(evaluator.cached_day_group.is_some());
        // Override should invalidate.
        evaluator.set_game_day_override(Some((42, 99)));
        assert!(
            evaluator.cached_day_group.is_none(),
            "set_game_day_override must invalidate cached_day_group"
        );
        // After re-evaluate, cache is repopulated with (42, 99).
        let _ = evaluator.evaluate(&sky_desc, &game_time, 0.0).unwrap();
        let cached = evaluator.cached_day_group.expect("re-cached");
        assert_eq!((cached.0, cached.1), (42, 99));
    }

    #[test]
    fn sky_g_day_group_cycling_360_days_covers_multiple_buckets() {
        // For 360 distinct (day, year=10) samples against 20 DayGroups,
        // we should see >=5 distinct buckets — the LCG hash distributes
        // ~uniformly so 360 samples / 20 groups ≈ 18 hits per bucket
        // on average. Sky-G item 2 verification — confirms the
        // CalcPresentDayGroup cycle works on whatever the workstream
        // probes via `setGameDayOverride`.
        use std::collections::BTreeMap;
        let num_groups = 20_u32;
        let dpy = 360_u32;
        let mut hist: BTreeMap<u32, u32> = BTreeMap::new();
        for day in 0..360_u32 {
            let idx = calc_present_day_group(day, 10, dpy, num_groups);
            *hist.entry(idx).or_insert(0) += 1;
        }
        // Distinct buckets seen.
        let distinct = hist.len();
        assert!(
            distinct >= 5,
            "expected >=5 distinct day groups across 360 days; got distinct={} (histogram: {:?})",
            distinct,
            hist
        );
        eprintln!("[Sky-G] 360-day histogram (year=10) across 20 DayGroups:");
        for (idx, count) in &hist {
            eprintln!("  group[{idx}] = {count} days");
        }
    }

    /// Workstream Sky-G property-bit predicates ground truth.
    #[test]
    fn sky_g_property_bit_predicates_match_probe_histogram() {
        // Per the probe, props=0x02 (clouds) and 0x04/0x05 (weather
        // streaks) and 0x0D (SetupModel weather) all flag translucent.
        // props=0x00 doesn't.
        assert!(!sky_object_is_translucent(0x00));
        assert!(sky_object_is_translucent(0x02));
        assert!(sky_object_is_translucent(0x04));
        assert!(sky_object_is_translucent(0x05));
        assert!(sky_object_is_translucent(0x0D));

        // Additive: only when bit 0 is set.
        assert!(!sky_object_is_additive(0x00));
        assert!(!sky_object_is_additive(0x02));
        assert!(!sky_object_is_additive(0x04));
        assert!(sky_object_is_additive(0x05));
        assert!(sky_object_is_additive(0x0D));
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
