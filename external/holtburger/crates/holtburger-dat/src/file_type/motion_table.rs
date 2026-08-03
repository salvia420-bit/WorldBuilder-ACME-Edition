use crate::graphics::Frame;
use binrw::{
    BinRead, BinResult,
    io::{Read, Seek},
};
use holtburger_common::Vector3;
use std::collections::HashMap;

// T8: 24-bit substate/cycle mask matching retail/ACE (MotionTable.cs:71,134)
// and holtburger's own idle path (lib.rs:5225). Was 0x000F_FFFF (20-bit), a
// latent footgun — harmless on retail data (max low-24 command = 0x19b) but
// inconsistent within the codebase and unsafe for new/private-server data.
// NOTE: this mask applies ONLY to the cycles/modifiers/links OUTER key
// (style<<16 | command). The Links INNER key is the FULL 32-bit MotionCommand
// and is never masked (see motion_data_for_link).
const MOTION_KEY_MASK: u32 = 0x00FF_FFFF;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MotionTable {
    pub id: u32,
    pub default_style: u32,
    pub style_defaults: HashMap<u32, u32>,
    pub cycles: HashMap<u32, MotionData>,
    /// A2 (waves-2, surveyed + DEFERRED 2026-05-29 — parsed, NOT consumed).
    /// Survey of real client_portal.dat: 300/436 tables (68.8%) carry
    /// modifiers, but ALL 1222 entries are anim-free (0 anims) — they are
    /// pure velocity/omega kinematic overlays keyed to the turn commands
    /// (0x0D/0x0E/0x0F/0x10) under each stance, gated by the Modifier command
    /// class 0x20000000. Retail applies them via `combine_motion`
    /// (acclient.c:337477; ACE MotionTable.cs:381) — which adds Velocity*speed
    /// + Omega*speed and NO animation — re-applied after every cycle/link
    /// switch by `re_modify` (acclient.c:337286) so a turn keeps its angular
    /// velocity through a walk→run transition. NOTE: the waves-2 doc's framing
    /// of this as "secondary/overlay motions → a second concurrent mixer
    /// action" is WRONG; there is no second clip. The correct fix lives in
    /// entity movement/physics integration (gated on 0x20000000, with a
    /// per-entity persistent modifier list mirroring MotionState.Modifiers),
    /// NOT the Three.js animation mixer. Deferred because holtburger renders
    /// entities from server position updates and does not integrate
    /// motion-table velocity/omega client-side.
    /// UPDATE 2026-05-29 — the VISUAL goal these modifiers serve (a creature
    /// sweeping smoothly through a turn instead of stepping its facing) shipped
    /// as "Path A": bounded heading interpolation on remote entities in
    /// `entities.js` (`setPose`/`tick`, default-on, `?headingSnap=on` to revert,
    /// `?headingEaseK=` to tune). That smooths the rendered heading toward the
    /// server-authoritative quaternion WITHOUT consuming this field — server
    /// stays authoritative, no prediction/reconciliation. FULL kinematic
    /// integration of these modifiers (per-entity MotionState + `combine_motion`
    /// + `re_modify` + dual-source reconciliation = "Path B") remains deferred:
    /// high upheaval, rubberband risk, and low marginal payoff over Path A
    /// because the server already transmits heading ~30 Hz.
    pub modifiers: HashMap<u32, MotionData>,
    pub links: HashMap<u32, HashMap<u32, MotionData>>,
}

impl MotionTable {
    pub const WALK_FORWARD_COMMAND: u32 = 0x4500_0005;
    pub const RUN_FORWARD_COMMAND: u32 = 0x4400_0007;
    pub const TURN_RIGHT_COMMAND: u32 = 0x6500_000D;
    pub const TURN_LEFT_COMMAND: u32 = 0x6500_000E;

    pub fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let id = u32::read_le(reader)?;
        let default_style = u32::read_le(reader)?;
        let style_defaults = parse_u32_map(reader)?;
        let cycles = parse_motion_data_map(reader)?;
        let modifiers = parse_motion_data_map(reader)?;
        let links = parse_nested_motion_data_map(reader)?;

        Ok(Self {
            id,
            default_style,
            style_defaults,
            cycles,
            modifiers,
            links,
        })
    }

    pub fn motion_data_for_cycle(&self, stance: u32, command: u32) -> Option<&MotionData> {
        self.cycles.get(&cycle_key(stance, command))
    }

    /// T1-base-speed: resolve `stance == 0` to the table's `default_style`,
    /// mirroring `motion_cycle_base_speed`'s stance handling so callers don't
    /// duplicate it.
    pub fn resolve_stance(&self, stance: u32) -> u32 {
        if stance == 0 {
            self.default_style
        } else {
            stance
        }
    }

    /// T1-base-speed: the *velocity-source* half of the authored-speed fallback
    /// chain for a `(stance, command)` cycle. Returns `Some(|velocity|)` when
    /// the cycle has `HAS_VELOCITY` and `|v| > 1e-4` (chain step 1), else
    /// `None` so the caller can try the next source. `stance == 0` →
    /// `default_style`.
    ///
    /// Step 2 of the chain (the separate `MotionKinematics.cycle_kinematics`
    /// asset) lives in a different DAT catalog, so it is interleaved by the
    /// wasm caller (lib.rs) between this and `cycle_anim_dist_base_speed`.
    pub fn cycle_velocity_base_speed(&self, stance: u32, command: u32) -> Option<f32> {
        let resolved_stance = self.resolve_stance(stance);
        let md = self.motion_data_for_cycle(resolved_stance, command)?;
        let v = md.velocity?;
        let mag = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
        if mag > 1e-4 { Some(mag) } else { None }
    }

    /// T1-base-speed: the *GetAnimDist* half of the authored-speed fallback
    /// chain (chain step 3 — last resort). Resolves the `(stance, command)`
    /// cycle and runs ACE `GetAnimDist` over `pos_frames` (the cycle's PosFrames
    /// concatenated across all of its anims, in order — resolved by the caller
    /// because the Animation assets live in a different catalog). Returns
    /// `Some(speed)` when the cycle resolves and yields a positive distance,
    /// else `None`. `stance == 0` → `default_style`.
    pub fn cycle_anim_dist_base_speed(
        &self,
        stance: u32,
        command: u32,
        pos_frames: &[Frame],
    ) -> Option<f32> {
        let resolved_stance = self.resolve_stance(stance);
        let md = self.motion_data_for_cycle(resolved_stance, command)?;
        let dist = md.get_anim_dist(pos_frames);
        if dist > 1e-4 { Some(dist) } else { None }
    }

    /// Lookup the transition (link) clip for `(stance, from_cmd) →
    /// to_cmd`. The links table is a nested HashMap whose outer key
    /// is encoded with `cycle_key(stance, from_cmd)` and whose inner
    /// key is the FULL 32-bit `to_cmd`. Used by the client to play a
    /// one-shot transition animation between two cycles (e.g.
    /// WalkForward → Ready plays a deceleration flourish).
    ///
    /// **W2.E fix 2026-05-20**: previously this helper masked
    /// `to_cmd & MOTION_KEY_MASK` (0x000F_FFFF), which stripped the
    /// 0x10/0x40/0x44/0x45 classifier prefix and silently failed every
    /// retail-data link lookup. The inner dict stores raw `u32` keys
    /// matching the full MotionCommand (e.g. `SlashHigh = 0x1000005B`)
    /// per `external/DatReaderWriter/DatReaderWriter/dats.xml:3746-3748`
    /// where the inner `genericKey` is declared as `int` — DRW reads
    /// it as raw little-endian u32. Validated by W3.E, whose direct
    /// `mt.links.get(outer)?.get(&command)` call works correctly. See
    /// `apps/holtburger-web/src/lib.rs:3989-4002` for the historic
    /// note about the bug.
    ///
    /// Matches the schema in
    /// `external/DatReaderWriter/DatReaderWriter/dats.xml:3746-3748`
    /// ("style << 16 | from substate → sub-dict (to substate →
    /// transition MotionData)"). NOTE: the docstring's "to substate"
    /// language is a doc artifact — empirically the inner key is the
    /// full command, not just the LOW-16 substate.
    pub fn motion_data_for_link(
        &self,
        stance: u32,
        from_cmd: u32,
        to_cmd: u32,
    ) -> Option<&MotionData> {
        let from_key = cycle_key(stance, from_cmd);
        self.links.get(&from_key)?.get(&to_cmd)
    }

    /// A4-Q4 (2026-06-12, unification survey) — the faithful retail
    /// `CMotionTable::get_link` TWO-HOP resolver (`acclient.c:337585-337639`;
    /// ACE `Physics/Animation/MotionTable.cs::get_link`, line-for-line),
    /// closing motion-dispatch C2 / A4 divergence #6: the shipped
    /// [`Self::motion_data_for_link`] is hop 1 ONLY, so any transition the
    /// table authors through its second hop (the `style_defaults` bridge /
    /// the style-level `(style << 16 | 0)` group) hard-cuts instead of
    /// playing its flourish.
    ///
    /// Speed-direction split (verbatim from both sources — `speed < 0 ||
    /// substate_speed < 0` selects the REVERSED lookups, since a
    /// backward-playing cycle takes the reverse link):
    ///
    /// - **forward** (`both speeds >= 0`):
    ///   1. `links[(style << 16) | (substate & 0xFFFFFF)][motion]`
    ///   2. `links[style << 16][motion]` — the style-level group whose
    ///      from-substate field is 0 (acclient.c:337631-337636 looks up
    ///      `v8 = style << 16` with NO low bits OR-ed in; ACE mirrors).
    /// - **backward** (either speed `< 0`):
    ///   1. `links[(style << 16) | (motion & 0xFFFFFF)][substate]`
    ///      (from/to swapped — the reverse transition)
    ///   2. `style_defaults[style] = default` ⇒
    ///      `links[(style << 16) | (substate & 0xFFFFFF)][default]`
    ///      (the style_defaults bridge, acclient.c:337616-337629).
    ///
    /// Outer keys are built with the same `cycle_key` encoding the parser's
    /// consumers use (byte-identical to the raw on-disk
    /// `(style << 16) | (substate & 0xFFFFFF)` for every retail command —
    /// see the `cycle_key` doc). Inner keys are the FULL 32-bit
    /// MotionCommand, never masked (the W2.E invariant; the bare low-16
    /// `0x0003` can't match `0x41000003`, callers pass full commands).
    pub fn get_link(
        &self,
        style: u32,
        substate: u32,
        substate_speed: f32,
        motion: u32,
        speed: f32,
    ) -> Option<&MotionData> {
        let backward = speed < 0.0 || substate_speed < 0.0;
        if backward {
            // Hop 1 (reversed): links[style | motion] → [substate].
            if let Some(link) = self
                .links
                .get(&cycle_key(style, motion))
                .and_then(|inner| inner.get(&substate))
            {
                return Some(link);
            }
            // Hop 2: the style_defaults bridge —
            // links[style | substate] → [StyleDefaults[style]].
            let default_motion = self.style_defaults.get(&style)?;
            self.links
                .get(&cycle_key(style, substate))
                .and_then(|inner| inner.get(default_motion))
        } else {
            // Hop 1: links[style | substate] → [motion].
            if let Some(link) = self
                .links
                .get(&cycle_key(style, substate))
                .and_then(|inner| inner.get(&motion))
            {
                return Some(link);
            }
            // Hop 2: the style-level group links[style << 16] → [motion]
            // (retail looks up the outer key with NO substate bits).
            self.links
                .get(&cycle_key(style, 0))
                .and_then(|inner| inner.get(&motion))
        }
    }

    pub fn movement_profile_for_stance(&self, stance: u32) -> MotionTableMovementProfile {
        MotionTableMovementProfile {
            motion_table_id: self.id,
            stance,
            walk_forward: self
                .motion_data_for_cycle(stance, Self::WALK_FORWARD_COMMAND)
                .map(MotionCommandKinematics::from_motion_data),
            run_forward: self
                .motion_data_for_cycle(stance, Self::RUN_FORWARD_COMMAND)
                .map(MotionCommandKinematics::from_motion_data),
            turn_left: self
                .motion_data_for_cycle(stance, Self::TURN_LEFT_COMMAND)
                .map(MotionCommandKinematics::from_motion_data),
            turn_right: self
                .motion_data_for_cycle(stance, Self::TURN_RIGHT_COMMAND)
                .map(MotionCommandKinematics::from_motion_data),
        }
    }

    pub fn default_movement_profile(&self) -> MotionTableMovementProfile {
        self.movement_profile_for_stance(self.default_style)
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MotionTableMovementProfile {
    pub motion_table_id: u32,
    pub stance: u32,
    pub walk_forward: Option<MotionCommandKinematics>,
    pub run_forward: Option<MotionCommandKinematics>,
    pub turn_left: Option<MotionCommandKinematics>,
    pub turn_right: Option<MotionCommandKinematics>,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct MotionCommandKinematics {
    pub velocity: Option<Vector3>,
    pub omega: Option<Vector3>,
}

impl MotionCommandKinematics {
    fn from_motion_data(data: &MotionData) -> Self {
        Self {
            velocity: data.velocity,
            omega: data.omega,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MotionData {
    pub bitfield: u8,
    pub flags: MotionDataFlags,
    pub anims: Vec<AnimData>,
    pub velocity: Option<Vector3>,
    pub omega: Option<Vector3>,
}

impl MotionData {
    /// T7: bit0 (`bitfield & 1`) — a cycle that *clears modifiers on entry*.
    /// Retail `set_cycle`/`do_motion` consult this to drop the persistent
    /// modifier list when entering the cycle (`acclient.c:337763-337841`;
    /// ACE `MotionTable.cs:238`). 50/436 retail tables (11.5%) set it.
    /// A clears-modifiers cycle also *refuses* new modifiers in the modifier
    /// branch (`acclient.c:337876`).
    pub fn clears_modifiers(&self) -> bool {
        self.bitfield & 0x01 != 0
    }

    /// T7: bit1 (`bitfield & 2`) — the `is_allowed` style-restriction gate.
    /// When set, the cycle is only enterable from the style's default substate
    /// (or by re-entering itself): retail `is_allowed` returns true iff
    /// `(bitfield & 2) == 0 || motion == Substate ||
    /// StyleDefaults[Style] == Substate` (`acclient.c:337560-337582`;
    /// ACE `MotionTable.cs:428-438`). This accessor exposes *only* the raw bit;
    /// the full gate (which also depends on live MotionState) lives where the
    /// state machine consumes it.
    pub fn is_allowed_gate(&self) -> bool {
        self.bitfield & 0x02 != 0
    }

    /// T1-base-speed: ACE `MotionTable.GetAnimDist` (`MotionTable.cs:572-589`)
    /// — the authored ground speed (m/s) of this cycle derived from root-motion
    /// PosFrame travel, used as the last-resort `baseSpeed` source when neither
    /// `MotionData.velocity` nor `MotionKinematics.cycle_kinematics` is
    /// populated (the T11 blocker: a player RunForward cycle may carry
    /// `|velocity| == 0`).
    ///
    /// `pos_frames` is the cycle's PosFrames **concatenated across ALL of this
    /// MotionData's anims, in order** (each `AnimData.anim_id` → that
    /// Animation's `pos_frames`). The caller resolves the Animation assets and
    /// concatenates because those assets live in a different catalog than this
    /// crate parses; here we only do the (pure) math.
    ///
    /// CRITICAL — vector-sum-then-magnitude, NOT sum-of-per-frame-magnitudes:
    /// accumulate `offset += frame.origin` over EVERY PosFrame while counting
    /// `total_frames`, and take `offset.length()` **after** the loop
    /// (`MotionTable.cs:582` sum, `:586` `.Length()`). For a curved root-motion
    /// path these differ; the vector-sum form is load-bearing for A/B parity.
    /// Returns `dist / total_frames * anims[0].framerate`, or `0.0` if the
    /// cycle has no anims / no PosFrames.
    pub fn get_anim_dist(&self, pos_frames: &[Frame]) -> f32 {
        if self.anims.is_empty() || pos_frames.is_empty() {
            return 0.0;
        }

        let mut offset = Vector3::zero();
        let mut total_frames: u32 = 0;
        for frame in pos_frames {
            // += frame.Origin (vector sum; magnitude taken AFTER the loop)
            offset = offset + frame.origin;
            total_frames += 1;
        }

        if total_frames == 0 {
            return 0.0;
        }

        let dist = offset.length();
        dist / (total_frames as f32) * self.anims[0].framerate
    }

    fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        let num_anims = u8::read(reader)? as usize;
        let bitfield = u8::read(reader)?;
        let flags = MotionDataFlags::from_bits_truncate(u8::read(reader)?);
        crate::utils::align_boundary(reader, 4)?;

        let mut anims = Vec::with_capacity(num_anims);
        for _ in 0..num_anims {
            anims.push(AnimData::read(reader)?);
        }

        let velocity = flags
            .contains(MotionDataFlags::HAS_VELOCITY)
            .then(|| Vector3::read_le(reader))
            .transpose()?;
        let omega = flags
            .contains(MotionDataFlags::HAS_OMEGA)
            .then(|| Vector3::read_le(reader))
            .transpose()?;

        Ok(Self {
            bitfield,
            flags,
            anims,
            velocity,
            omega,
        })
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AnimData {
    pub anim_id: u32,
    pub low_frame: i32,
    pub high_frame: i32,
    pub framerate: f32,
}

impl AnimData {
    fn read<R: Read + Seek>(reader: &mut R) -> BinResult<Self> {
        Ok(Self {
            anim_id: u32::read_le(reader)?,
            low_frame: i32::read_le(reader)?,
            high_frame: i32::read_le(reader)?,
            framerate: f32::read_le(reader)?,
        })
    }
}

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
    pub struct MotionDataFlags: u8 {
        const HAS_VELOCITY = 0x01;
        const HAS_OMEGA = 0x02;
    }
}

fn cycle_key(stance: u32, command: u32) -> u32 {
    // T8 KEY-COLLISION FIX: ACE builds the cycle key as
    // `(style << 16) | (substate & 0xFFFFFF)` (physics MotionTable.cs:85,125,191).
    // That layout OVERLAPS the style's low 16 bits (key bits 16-31) with the
    // substate's bits 16-23 — so the `command & 0x00F0_0000` HIGH NIBBLE is
    // OR-folded straight into the style byte and silently dropped/aliased. On
    // retail data this never bites (max low-24 substate = 0x19b, so command
    // bits 8-23 are always zero), but two synthetic commands differing ONLY in
    // the 0x00F0_0000 nibble collide to the same key.
    //
    // We keep the FULL 24-bit command (per MOTION_KEY_MASK) by relocating its
    // high byte (command bits 16-23) into key bits 24-31, leaving the style
    // byte (key bits 16-23) and command's low 16 bits (key bits 0-15) exactly
    // where ACE/lib.rs put them. Real entries (command high byte == 0)
    // therefore produce a BYTE-IDENTICAL key to the raw on-disk ACE encoding —
    // so retail-table lookups and the direct
    // `(default_style << 16) | (substate & 0xFFFFFF)` construction in
    // `apps/holtburger-web/src/lib.rs` still match — while a non-zero high
    // nibble now survives the intra-command fold.
    //
    // LIMITATION — this is NOT collision-free in the general case. The relocated
    // command high byte (key bits 24-31) SHARES those bits with the style: ACE's
    // `(style & 0xFFFF) << 16` also writes the style's bits 8-15 into key bits
    // 24-31. So the de-aliasing holds ONLY when the style's bits 8-15 are zero
    // (`stance & 0xFF00 == 0`). It does for every retail MotionCommand style
    // (NonCombat 0x8000003D, the weapon stances 0x8000003C..0x80000049, …,
    // all low-byte-only) — BUT NOT for AtlatlCombat (0x8000013B) /
    // ThrownShieldCombat (0x8000013C), whose bit 8 is set. For those a synthetic
    // high-nibble command can still alias across stances, e.g.
    // cycle_key(0x8000013B, 0x00000005) == cycle_key(0x8000003B, 0x00010005).
    // A 16-bit style + a full 24-bit command cannot be packed collision-free
    // into a single u32 (style needs bits 16-31, the low substate needs 0-15,
    // leaving no room for a non-zero command high byte), and retail's on-disk
    // u32 key format cannot encode such a command anyway — so a fully faithful
    // single-u32 key is impossible and this is the closest faithful encoding.
    // The debug_assert below pins the exact invariant (it can only ever trip on
    // synthetic in-code data, never on a parsed retail table).
    let cmd = command & MOTION_KEY_MASK;
    let cmd_high = cmd & 0x00FF_0000; // bits 16-23
    let cmd_low = cmd & 0x0000_FFFF; // bits 0-15
    debug_assert!(
        cmd_high == 0 || (stance & 0xFF00) == 0,
        "cycle_key collision risk: a non-zero command high byte (0x{:06X}) \
         aliases a style whose bits 8-15 are set (0x{:08X}); a 16-bit style + \
         24-bit command cannot pack collision-free into u32",
        cmd,
        stance
    );
    (cmd_high << 8) | ((stance & 0xFFFF) << 16) | cmd_low
}

fn parse_u32_map<R: Read + Seek>(reader: &mut R) -> BinResult<HashMap<u32, u32>> {
    // Rust review 2026-08-03 (F6): `with_capacity(count)` reserved straight off
    // an unvalidated u32 read 8 bytes into the file — a 12-byte MotionTable
    // ending in 0xFFFFFFFF asked for ~40 GB of buckets and aborted before the
    // first (fallible) element read could fail. 8 bytes minimum per entry.
    let count = u32::read_le(reader)? as usize;
    let mut values = HashMap::with_capacity(crate::utils::safe_capacity(reader, count, 8)?);
    for _ in 0..count {
        values.insert(u32::read_le(reader)?, u32::read_le(reader)?);
    }
    Ok(values)
}

fn parse_motion_data_map<R: Read + Seek>(reader: &mut R) -> BinResult<HashMap<u32, MotionData>> {
    // F6: see `parse_u32_map`. Key (4) + a MotionData that is itself at least
    // 4 bytes ⇒ 8 bytes minimum per entry.
    let count = u32::read_le(reader)? as usize;
    let mut values = HashMap::with_capacity(crate::utils::safe_capacity(reader, count, 8)?);
    for _ in 0..count {
        let key = u32::read_le(reader)?;
        values.insert(key, MotionData::read(reader)?);
    }
    Ok(values)
}

fn parse_nested_motion_data_map<R: Read + Seek>(
    reader: &mut R,
) -> BinResult<HashMap<u32, HashMap<u32, MotionData>>> {
    // F6: see `parse_u32_map`. Key (4) + a nested map that is itself at least
    // its own 4-byte count ⇒ 8 bytes minimum per entry.
    let count = u32::read_le(reader)? as usize;
    let mut values = HashMap::with_capacity(crate::utils::safe_capacity(reader, count, 8)?);
    for _ in 0..count {
        let key = u32::read_le(reader)?;
        values.insert(key, parse_motion_data_map(reader)?);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn push_motion_data(
        bytes: &mut Vec<u8>,
        flags: u8,
        velocity: Option<Vector3>,
        omega: Option<Vector3>,
    ) {
        bytes.push(0); // num_anims
        bytes.push(0); // bitfield
        bytes.push(flags);
        bytes.push(0); // align to 4-byte boundary

        if let Some(velocity) = velocity {
            bytes.extend_from_slice(&velocity.x.to_le_bytes());
            bytes.extend_from_slice(&velocity.y.to_le_bytes());
            bytes.extend_from_slice(&velocity.z.to_le_bytes());
        }

        if let Some(omega) = omega {
            bytes.extend_from_slice(&omega.x.to_le_bytes());
            bytes.extend_from_slice(&omega.y.to_le_bytes());
            bytes.extend_from_slice(&omega.z.to_le_bytes());
        }
    }

    #[test]
    fn parses_motion_table_and_extracts_default_profile() {
        let default_stance = 0x8000_003D;
        let walk_key = cycle_key(default_stance, MotionTable::WALK_FORWARD_COMMAND);
        let run_key = cycle_key(default_stance, MotionTable::RUN_FORWARD_COMMAND);
        let turn_left_key = cycle_key(default_stance, MotionTable::TURN_LEFT_COMMAND);
        let turn_right_key = cycle_key(default_stance, MotionTable::TURN_RIGHT_COMMAND);

        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0900_0001u32.to_le_bytes());
        bytes.extend_from_slice(&default_stance.to_le_bytes());

        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&default_stance.to_le_bytes());
        bytes.extend_from_slice(&MotionTable::WALK_FORWARD_COMMAND.to_le_bytes());

        bytes.extend_from_slice(&4u32.to_le_bytes());

        bytes.extend_from_slice(&walk_key.to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_VELOCITY.bits(),
            Some(Vector3::new(1.0, 0.0, 0.0)),
            None,
        );

        bytes.extend_from_slice(&run_key.to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_VELOCITY.bits(),
            Some(Vector3::new(2.5, 0.0, 0.0)),
            None,
        );

        bytes.extend_from_slice(&turn_left_key.to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_OMEGA.bits(),
            None,
            Some(Vector3::new(0.0, 0.0, -1.5)),
        );

        bytes.extend_from_slice(&turn_right_key.to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_OMEGA.bits(),
            None,
            Some(Vector3::new(0.0, 0.0, 1.5)),
        );

        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());

        let table = MotionTable::read(&mut Cursor::new(bytes)).expect("motion table should parse");
        let profile = table.default_movement_profile();

        assert_eq!(table.default_style, default_stance);
        assert_eq!(
            table.style_defaults.get(&default_stance),
            Some(&MotionTable::WALK_FORWARD_COMMAND)
        );
        assert_eq!(profile.motion_table_id, 0x0900_0001);
        assert_eq!(profile.stance, default_stance);
        assert_eq!(
            profile.walk_forward.and_then(|entry| entry.velocity),
            Some(Vector3::new(1.0, 0.0, 0.0))
        );
        assert_eq!(
            profile.run_forward.and_then(|entry| entry.velocity),
            Some(Vector3::new(2.5, 0.0, 0.0))
        );
        assert_eq!(
            profile.turn_left.and_then(|entry| entry.omega),
            Some(Vector3::new(0.0, 0.0, -1.5))
        );
        assert_eq!(
            profile.turn_right.and_then(|entry| entry.omega),
            Some(Vector3::new(0.0, 0.0, 1.5))
        );
    }

    // ---- T8: mask is 24-bit, not 20-bit ----

    /// T8: a synthetic command whose low-24 bits exceed `0x0F_FFFF` (i.e. a bit
    /// is set in the 0x00F0_0000 nibble that the OLD 20-bit mask would have
    /// stripped) must still round-trip through `cycle_key` and resolve. Under
    /// the old `0x000F_FFFF` mask the insert key and the lookup key would BOTH
    /// be masked identically, so a naive round-trip would *falsely* pass — the
    /// real regression is that two DISTINCT low-24 commands differing only in
    /// the 0x00F0_0000 nibble must NOT collide. We assert both: the high-nibble
    /// command resolves, and it does not alias a low-nibble sibling.
    #[test]
    fn t8_high_low24_substate_resolves_and_does_not_alias() {
        let stance = 0x8000_003Du32;
        // command with a bit set in the 0x00F0_0000 nibble — masked away by the
        // old 20-bit mask, preserved by the new 24-bit mask.
        let high_cmd = 0x0010_0001u32; // low-24 = 0x100001 > 0x0F_FFFF
        let low_cmd = 0x0000_0001u32; // low-24 = 0x000001 (differs only in nibble)

        // With a 24-bit mask these two produce DIFFERENT cycle keys.
        assert_ne!(
            cycle_key(stance, high_cmd),
            cycle_key(stance, low_cmd),
            "24-bit mask must keep the 0x00F0_0000 nibble — keys must not collide"
        );

        // Build a MotionTable carrying only the high-nibble command and assert
        // it resolves via the normal accessor.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0900_0099u32.to_le_bytes()); // id
        bytes.extend_from_slice(&stance.to_le_bytes()); // default_style
        bytes.extend_from_slice(&0u32.to_le_bytes()); // style_defaults count
        bytes.extend_from_slice(&1u32.to_le_bytes()); // cycles count
        bytes.extend_from_slice(&cycle_key(stance, high_cmd).to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_VELOCITY.bits(),
            Some(Vector3::new(3.0, 0.0, 0.0)),
            None,
        );
        bytes.extend_from_slice(&0u32.to_le_bytes()); // modifiers count
        bytes.extend_from_slice(&0u32.to_le_bytes()); // links count

        let table = MotionTable::read(&mut Cursor::new(bytes)).expect("table parses");
        assert!(
            table.motion_data_for_cycle(stance, high_cmd).is_some(),
            "high-nibble low-24 command (0x{:06X}) must resolve under 24-bit mask",
            high_cmd & 0x00FF_FFFF
        );
        assert!(
            table.motion_data_for_cycle(stance, low_cmd).is_none(),
            "the high-nibble command must NOT alias the low-nibble sibling"
        );
        assert_eq!(MOTION_KEY_MASK, 0x00FF_FFFF, "mask must be 24-bit");
    }

    /// T8 (limitation made explicit): `cycle_key` packs a 16-bit style and a
    /// 24-bit command into a single u32, which is *impossible* to do
    /// collision-free — key bits 24-31 carry BOTH the relocated command high
    /// byte AND the style's bits 8-15. The de-aliasing therefore holds only
    /// when `stance & 0xFF00 == 0`. This test pins the safe-vs-unsafe boundary
    /// so the limitation is documented rather than latent:
    ///   1. For EVERY retail (stance, command) pair — including the only retail
    ///      styles whose bits 8-15 are set, AtlatlCombat (0x8000013B) and
    ///      ThrownShieldCombat (0x8000013C) — `cycle_key` is BYTE-IDENTICAL to
    ///      the raw on-disk ACE key `(style << 16) | (substate & 0xFFFFFF)`, so
    ///      there is NO retail regression (retail substates are <= 0x19B, hence
    ///      command high byte == 0).
    ///   2. The cross-stance collision the encoding cannot avoid is provable:
    ///      cycle_key(0x8000013B, 0x00000005) would equal
    ///      cycle_key(0x8000003B, 0x00010005). The second call carries a
    ///      non-zero command high byte on a style with bits 8-15 == 0, which the
    ///      `debug_assert!` invariant rejects — so the collision can only be
    ///      reached by feeding synthetic high-nibble commands to BOTH stances,
    ///      i.e. exactly the non-retail data the assert is there to catch.
    #[test]
    fn t8_cross_stance_collision_boundary_is_documented() {
        // Raw on-disk ACE encoding (what parse_motion_data_map reads verbatim).
        let ace_key = |style: u32, cmd: u32| (style << 16) | (cmd & 0x00FF_FFFF);

        // Retail-equivalence (cmd high byte == 0) holds even for the two retail
        // styles whose bits 8-15 are set — no regression for AtlatlCombat /
        // ThrownShieldCombat.
        for &style in &[0x8000_003Du32, 0x8000_013Bu32, 0x8000_013Cu32] {
            for &cmd in &[0x0000_0001u32, 0x0000_019Bu32, 0x4500_0005u32, 0x6500_000Du32] {
                assert_eq!(
                    cycle_key(style, cmd),
                    ace_key(style, cmd),
                    "retail (cmd high byte == 0) key must be byte-identical to \
                     on-disk ACE encoding for style 0x{style:08X} cmd 0x{cmd:08X}"
                );
            }
        }

        // The unavoidable cross-stance collision, computed WITHOUT tripping the
        // debug_assert (we replicate the bit-packing inline). cmd_high of the
        // second pair (0x01 nibble) lands in key bits 24-31, exactly where
        // style 0x...013B's bit 8 lands — so they collapse to the same key.
        let pack = |style: u32, cmd: u32| {
            let c = cmd & MOTION_KEY_MASK;
            ((c & 0x00FF_0000) << 8) | ((style & 0xFFFF) << 16) | (c & 0x0000_FFFF)
        };
        assert_eq!(
            pack(0x8000_013B, 0x0000_0005),
            pack(0x8000_003B, 0x0001_0005),
            "the single-u32 key cannot avoid this cross-stance collision; it is \
             unreachable on retail data and guarded by cycle_key's debug_assert"
        );

        // And the safe case (stance bits 8-15 == 0) genuinely de-aliases the
        // intra-command high nibble, which is the bug the fix actually targets.
        assert_ne!(
            cycle_key(0x8000_003D, 0x0010_0001),
            cycle_key(0x8000_003D, 0x0000_0001),
            "intra-command high-nibble de-aliasing must hold for low-byte styles"
        );
    }

    // ---- T7: MotionData bitfield accessors ----

    /// T7: `clears_modifiers()` reads bit0, `is_allowed_gate()` reads bit1, and
    /// the two bits are independent within one `u8`. (We assert the accessor
    /// LOGIC against synthetic bitfields, not the DAT distribution — the
    /// "50/436 tables set bit0" figure needs a build/sweep to verify and is
    /// covered by `sweep_all_retail_motion_tables`'s `tables_with_bitfield_bit_0`
    /// stat.)
    #[test]
    fn t7_bitfield_accessors_decode_independent_bits() {
        let make = |bitfield: u8| MotionData {
            bitfield,
            flags: MotionDataFlags::empty(),
            anims: Vec::new(),
            velocity: None,
            omega: None,
        };

        // bit0 only
        let md = make(0x01);
        assert!(md.clears_modifiers());
        assert!(!md.is_allowed_gate());

        // bit1 only
        let md = make(0x02);
        assert!(!md.clears_modifiers());
        assert!(md.is_allowed_gate());

        // both bits
        let md = make(0x03);
        assert!(md.clears_modifiers());
        assert!(md.is_allowed_gate());

        // neither bit (other high bits set must not leak into either accessor)
        let md = make(0xFC);
        assert!(!md.clears_modifiers());
        assert!(!md.is_allowed_gate());
    }

    // ---- A4-Q4: get_link two-hop resolver ----

    /// Marker-carrying MotionData so each table slot is distinguishable.
    fn marked(marker: u8) -> MotionData {
        MotionData {
            bitfield: marker,
            flags: MotionDataFlags::empty(),
            anims: Vec::new(),
            velocity: None,
            omega: None,
        }
    }

    const Q4_STYLE: u32 = 0x8000_003D; // NonCombat
    const Q4_READY: u32 = 0x4100_0003;
    const Q4_WALK: u32 = 0x4500_0005;
    const Q4_SLASH: u32 = 0x1000_005B;

    /// Synthetic table exercising every `get_link` arm:
    /// - `links[style|Ready][Walk]`   = marker 1 (forward hop 1)
    /// - `links[style<<16|0][Slash]`  = marker 2 (forward hop 2,
    ///   style-level group)
    /// - `links[style|Walk][Ready]`   = marker 3 (backward hop 1 for
    ///   (substate=Ready, motion=Walk))
    /// - `links[style|Slash][Ready]`  = marker 4 (backward hop 2 bridge:
    ///   StyleDefaults[style] = Ready)
    fn q4_table() -> MotionTable {
        let mut links: HashMap<u32, HashMap<u32, MotionData>> = HashMap::new();
        links
            .entry(cycle_key(Q4_STYLE, Q4_READY))
            .or_default()
            .insert(Q4_WALK, marked(1));
        links
            .entry(cycle_key(Q4_STYLE, 0))
            .or_default()
            .insert(Q4_SLASH, marked(2));
        links
            .entry(cycle_key(Q4_STYLE, Q4_WALK))
            .or_default()
            .insert(Q4_READY, marked(3));
        links
            .entry(cycle_key(Q4_STYLE, Q4_SLASH))
            .or_default()
            .insert(Q4_READY, marked(4));
        let mut style_defaults = HashMap::new();
        style_defaults.insert(Q4_STYLE, Q4_READY);
        MotionTable {
            id: 0x0900_0101,
            default_style: Q4_STYLE,
            style_defaults,
            cycles: HashMap::new(),
            modifiers: HashMap::new(),
            links,
        }
    }

    /// Forward hop 1: the exact `(style|substate) → motion` entry wins.
    #[test]
    fn q4_get_link_forward_hop1_exact() {
        let t = q4_table();
        let md = t.get_link(Q4_STYLE, Q4_READY, 1.0, Q4_WALK, 1.0).unwrap();
        assert_eq!(md.bitfield, 1);
    }

    /// Forward hop 2: no exact entry for `(style|Walk) → Slash`, but the
    /// style-level group `(style << 16 | 0)` carries Slash — retail's
    /// second lookup (acclient.c:337631-337636) finds it; the shipped
    /// single-hop `motion_data_for_link` does NOT (the C2 hard-cut).
    #[test]
    fn q4_get_link_forward_hop2_style_level_group() {
        let t = q4_table();
        let md = t.get_link(Q4_STYLE, Q4_WALK, 1.0, Q4_SLASH, 1.0).unwrap();
        assert_eq!(md.bitfield, 2);
        // The pre-Q4 helper misses this transition entirely.
        assert!(t.motion_data_for_link(Q4_STYLE, Q4_WALK, Q4_SLASH).is_none());
    }

    /// Backward hop 1: a negative speed swaps from/to —
    /// `links[style|motion][substate]` (the reverse transition plays).
    #[test]
    fn q4_get_link_backward_hop1_reversed() {
        let t = q4_table();
        let md = t.get_link(Q4_STYLE, Q4_READY, 1.0, Q4_WALK, -1.0).unwrap();
        // links[style|Walk][Ready] = marker 3 (NOT the forward marker 1).
        assert_eq!(md.bitfield, 3);
        // substate_speed < 0 selects the same arm (retail `speed < 0 ||
        // substate_speed < 0`).
        let md2 = t.get_link(Q4_STYLE, Q4_READY, -1.0, Q4_WALK, 1.0).unwrap();
        assert_eq!(md2.bitfield, 3);
    }

    /// Backward hop 2: reversed hop 1 misses ⇒ the style_defaults
    /// bridge — `links[style|substate][StyleDefaults[style]]`
    /// (acclient.c:337616-337629).
    #[test]
    fn q4_get_link_backward_hop2_style_defaults_bridge() {
        let t = q4_table();
        // (substate=Slash, motion=Walk, backward): hop 1 looks up
        // links[style|Walk][Slash] — absent. Hop 2: StyleDefaults = Ready
        // ⇒ links[style|Slash][Ready] = marker 4.
        let md = t.get_link(Q4_STYLE, Q4_SLASH, 1.0, Q4_WALK, -1.0).unwrap();
        assert_eq!(md.bitfield, 4);
    }

    /// Both hops miss ⇒ None (caller keeps its crossfade fallback).
    #[test]
    fn q4_get_link_full_miss_is_none() {
        let t = q4_table();
        assert!(t.get_link(Q4_STYLE, Q4_SLASH, 1.0, Q4_WALK, 1.0).is_none());
        // Unknown style misses everything (incl. the defaults bridge).
        assert!(t.get_link(0x8000_0040, Q4_READY, 1.0, Q4_WALK, -1.0).is_none());
    }

    /// Key-width split (the W2.E invariant): the INNER key is the FULL
    /// 32-bit MotionCommand — a bare low-16 `0x0005` must NOT match the
    /// `0x45000005` inner entry — while the OUTER from-substate is
    /// masked to its low 24 bits by the on-disk
    /// `(style << 16) | (substate & 0xFFFFFF)` encoding, so the bare
    /// `0x0003` DOES select the same outer group as `0x41000003`
    /// (retail masks identically, acclient.c:337596/:337607).
    #[test]
    fn q4_get_link_inner_key_is_full_command() {
        let t = q4_table();
        // Inner: low-16 alias must miss.
        assert!(t.get_link(Q4_STYLE, Q4_READY, 1.0, 0x0005, 1.0).is_none());
        // Outer: low-24 alias selects the same group (retail parity).
        let md = t.get_link(Q4_STYLE, 0x0003, 1.0, Q4_WALK, 1.0).unwrap();
        assert_eq!(md.bitfield, 1);
    }

    // ---- T1-base-speed: GetAnimDist (vector-sum-then-magnitude) ----

    fn anim_with_framerate(framerate: f32) -> AnimData {
        AnimData {
            anim_id: 0x0300_0001,
            low_frame: 0,
            high_frame: 0,
            framerate,
        }
    }

    fn motion_data_with_anim(framerate: f32) -> MotionData {
        MotionData {
            bitfield: 0,
            flags: MotionDataFlags::empty(),
            anims: vec![anim_with_framerate(framerate)],
            velocity: None,
            omega: None,
        }
    }

    fn frame_at(x: f32, y: f32, z: f32) -> Frame {
        Frame {
            origin: Vector3::new(x, y, z),
            orientation: holtburger_common::Quaternion {
                w: 1.0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
        }
    }

    /// T1-base-speed: straight-line root motion. Four PosFrames each advancing
    /// +0.5 on X → summed offset = (2.0, 0, 0), |offset| = 2.0, total_frames =
    /// 4, framerate = 30 → 2.0 / 4 * 30 = 15.0 m/s. Hand-computed.
    #[test]
    fn t1_get_anim_dist_straight_line() {
        let md = motion_data_with_anim(30.0);
        let frames = [
            frame_at(0.5, 0.0, 0.0),
            frame_at(0.5, 0.0, 0.0),
            frame_at(0.5, 0.0, 0.0),
            frame_at(0.5, 0.0, 0.0),
        ];
        let dist = md.get_anim_dist(&frames);
        assert!(
            (dist - 15.0).abs() < 1e-5,
            "expected 15.0, got {dist} (|sum|/n*framerate = 2.0/4*30)"
        );
    }

    /// T1-base-speed: the load-bearing distinction — vector-sum-then-magnitude,
    /// NOT sum-of-per-frame-magnitudes. A curved/back-and-forth path: frames
    /// (+1,0,0) then (-1,0,0). Sum-of-magnitudes would be 2.0; the correct
    /// magnitude-of-the-vector-sum is |(0,0,0)| = 0.0. With framerate 30 the
    /// result MUST be 0.0, proving we sum first then take the length.
    #[test]
    fn t1_get_anim_dist_is_vector_sum_then_magnitude_not_sum_of_magnitudes() {
        let md = motion_data_with_anim(30.0);
        let frames = [frame_at(1.0, 0.0, 0.0), frame_at(-1.0, 0.0, 0.0)];
        let dist = md.get_anim_dist(&frames);
        assert!(
            dist.abs() < 1e-6,
            "vector-sum-then-magnitude of (+1,0,0)+(-1,0,0) is 0.0, not 2.0; got {dist}"
        );
    }

    /// T1-base-speed: a genuinely curved path where the two measures differ by
    /// a known amount. Frames (3,0,0) and (0,4,0): sum = (3,4,0), |sum| = 5.0
    /// (3-4-5 triangle), total_frames = 2, framerate = 20 → 5.0 / 2 * 20 =
    /// 50.0. Sum-of-magnitudes would be (3+4)/2*20 = 70.0 — wrong.
    #[test]
    fn t1_get_anim_dist_curved_three_four_five() {
        let md = motion_data_with_anim(20.0);
        let frames = [frame_at(3.0, 0.0, 0.0), frame_at(0.0, 4.0, 0.0)];
        let dist = md.get_anim_dist(&frames);
        assert!(
            (dist - 50.0).abs() < 1e-4,
            "expected 50.0 (|(3,4,0)|/2*20), got {dist}"
        );
    }

    /// T1-base-speed: empty anims OR empty pos_frames → 0.0 (the fallback chain
    /// treats this as "no authored speed from this source").
    #[test]
    fn t1_get_anim_dist_empty_returns_zero() {
        let md = motion_data_with_anim(30.0);
        assert_eq!(md.get_anim_dist(&[]), 0.0, "no pos_frames → 0.0");

        let md_no_anims = MotionData {
            bitfield: 0,
            flags: MotionDataFlags::empty(),
            anims: Vec::new(),
            velocity: None,
            omega: None,
        };
        assert_eq!(
            md_no_anims.get_anim_dist(&[frame_at(1.0, 0.0, 0.0)]),
            0.0,
            "no anims → 0.0 (no framerate)"
        );
    }

    /// T1-base-speed: the MotionTable-level resolver halves of the fallback
    /// chain. `cycle_velocity_base_speed` returns `Some(|velocity|)` only when
    /// `|v| > 1e-4`, and `cycle_anim_dist_base_speed` falls back to GetAnimDist.
    #[test]
    fn t1_cycle_base_speed_resolver_halves() {
        let stance = 0x8000_003Du32;
        let walk = MotionTable::WALK_FORWARD_COMMAND;
        let run = MotionTable::RUN_FORWARD_COMMAND;

        // Build a table: walk cycle carries a real velocity (3.12 m/s), run
        // cycle carries a near-zero velocity (the T11 player-RunForward case).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x0900_00AAu32.to_le_bytes()); // id
        bytes.extend_from_slice(&stance.to_le_bytes()); // default_style
        bytes.extend_from_slice(&0u32.to_le_bytes()); // style_defaults
        bytes.extend_from_slice(&2u32.to_le_bytes()); // cycles count

        bytes.extend_from_slice(&cycle_key(stance, walk).to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_VELOCITY.bits(),
            Some(Vector3::new(3.12, 0.0, 0.0)),
            None,
        );
        bytes.extend_from_slice(&cycle_key(stance, run).to_le_bytes());
        push_motion_data(
            &mut bytes,
            MotionDataFlags::HAS_VELOCITY.bits(),
            Some(Vector3::new(0.0, 0.0, 0.0)), // |v| == 0 → must NOT win
            None,
        );

        bytes.extend_from_slice(&0u32.to_le_bytes()); // modifiers
        bytes.extend_from_slice(&0u32.to_le_bytes()); // links

        let table = MotionTable::read(&mut Cursor::new(bytes)).expect("table parses");

        // walk: velocity source wins.
        let walk_v = table.cycle_velocity_base_speed(stance, walk);
        assert!(
            walk_v.map(|s| (s - 3.12).abs() < 1e-4).unwrap_or(false),
            "walk |velocity| should resolve to 3.12, got {walk_v:?}"
        );

        // run: velocity is ~0 → resolver returns None so the caller falls
        // through to MotionKinematics / GetAnimDist.
        assert_eq!(
            table.cycle_velocity_base_speed(stance, run),
            None,
            "near-zero run velocity must NOT win the chain (|v| <= 1e-4)"
        );

        // GetAnimDist fallback for the run cycle: the run MotionData has anims?
        // No — push_motion_data writes 0 anims, so get_anim_dist returns 0.0 and
        // the resolver returns None (no authored speed from this source either).
        let run_anim = table.cycle_anim_dist_base_speed(
            stance,
            run,
            &[frame_at(1.0, 0.0, 0.0), frame_at(1.0, 0.0, 0.0)],
        );
        assert_eq!(
            run_anim, None,
            "run cycle has 0 anims → GetAnimDist 0.0 → None"
        );

        // stance == 0 resolves to default_style (which IS `stance` here).
        assert_eq!(
            table.resolve_stance(0),
            stance,
            "stance 0 must resolve to default_style"
        );
    }

    fn retail_portal_dat_path() -> Option<std::path::PathBuf> {
        if let Some(p) = crate::utils::get_portal_dat_path() {
            return Some(p);
        }
        let c = std::path::PathBuf::from("/home/wbterminal/ac_base_dats/client_portal.dat");
        c.exists().then_some(c)
    }

    /// Cross-reference parity test against the C# DatReaderWriter EOR
    /// suite (`DatReaderWriter.Tests/DBObjs/MotionTableTests.cs::CanReadEORMotionTables`),
    /// which asserts exactly these four facts about portal asset
    /// `0x09000202`:
    ///   - id == 0x09000202
    ///   - default_style == MotionCommand.NonCombat (0x8000003D)
    ///   - style_defaults.len() == 1
    ///   - style_defaults[NonCombat] == MotionCommand.Off (0x4000000C)
    ///
    /// If this passes, our parser agrees field-for-field with the
    /// upstream C# parser on a non-trivial real motion table. If it
    /// fails, either our parser has a wire-format bug or the C# test
    /// is asserting against a different DAT build.
    #[test]
    fn probe_retail_motion_table_0x09000202_matches_csharp_eor_test() {
        use crate::DatDatabase;
        let path = match retail_portal_dat_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "[probe_retail_motion_table_0x09000202] SKIP — no client_portal.dat available"
                );
                return;
            }
        };
        let dat = DatDatabase::new(&path).expect("open client_portal.dat");
        let bytes = dat.get_file(0x09000202).expect("motion table 0x09000202 must exist in retail portal");
        let mtable = MotionTable::read(&mut std::io::Cursor::new(bytes))
            .expect("MotionTable::read should succeed on retail 0x09000202");

        assert_eq!(mtable.id, 0x09000202);
        assert_eq!(mtable.default_style, 0x8000003D, "default_style must be MotionCommand.NonCombat");
        assert_eq!(mtable.style_defaults.len(), 1, "EOR test asserts exactly one StyleDefaults entry");
        assert_eq!(
            mtable.style_defaults.get(&0x8000003D),
            Some(&0x4000000C),
            "StyleDefaults[NonCombat] must be MotionCommand.Off"
        );

        eprintln!(
            "[probe_retail_motion_table_0x09000202] PASS — id=0x{:08X} default_style=0x{:08X} \
             style_defaults={} cycles={} modifiers={} links={}",
            mtable.id,
            mtable.default_style,
            mtable.style_defaults.len(),
            mtable.cycles.len(),
            mtable.modifiers.len(),
            mtable.links.len()
        );
    }

    /// Sweep every motion table in the retail portal DAT (asset range
    /// 0x09000000..=0x0900FFFF, per DatReaderWriter's
    /// `[DBObjType(... 0x09000000, 0x0900FFFF, 0x09000000)]`) and assert
    /// that `MotionTable::read` succeeds on each one. Also reports
    /// aggregate stats so we can eyeball whether the parsed shape is
    /// plausible.
    ///
    /// If any table fails, the parser has a wire-format bug that the
    /// synthetic test doesn't exercise. If 100% pass, the parser is
    /// validated across the full retail motion-table universe.
    #[test]
    fn sweep_all_retail_motion_tables_parse_successfully() {
        use crate::DatDatabase;
        let path = match retail_portal_dat_path() {
            Some(p) => p,
            None => {
                eprintln!(
                    "[sweep_all_retail_motion_tables] SKIP — no client_portal.dat available"
                );
                return;
            }
        };
        let dat = DatDatabase::new(&path).expect("open client_portal.dat");

        let mut motion_table_ids: Vec<u32> = dat
            .files
            .keys()
            .copied()
            .filter(|id| (0x09000000..=0x0900FFFF).contains(id))
            .collect();
        motion_table_ids.sort();

        assert!(
            !motion_table_ids.is_empty(),
            "retail portal.dat should contain motion tables in 0x09000000..=0x0900FFFF"
        );

        let mut parsed = 0usize;
        let mut failures: Vec<(u32, String)> = Vec::new();
        let mut total_cycles = 0usize;
        let mut total_modifiers = 0usize;
        let mut total_link_groups = 0usize;
        let mut total_link_destinations = 0usize;
        let mut total_anims_in_cycles = 0usize;
        let mut tables_with_velocity = 0usize;
        let mut tables_with_omega = 0usize;
        let mut tables_with_bitfield_bit_0 = 0usize;
        let mut max_cycles_in_table: (u32, usize) = (0, 0);
        let mut max_links_in_table: (u32, usize) = (0, 0);

        for &id in &motion_table_ids {
            let bytes = match dat.get_file(id) {
                Ok(b) => b,
                Err(e) => {
                    failures.push((id, format!("get_file: {}", e)));
                    continue;
                }
            };
            match MotionTable::read(&mut std::io::Cursor::new(bytes)) {
                Ok(mt) => {
                    parsed += 1;
                    assert_eq!(mt.id, id, "parsed id must equal DAT entry id");
                    total_cycles += mt.cycles.len();
                    total_modifiers += mt.modifiers.len();
                    total_link_groups += mt.links.len();
                    for inner in mt.links.values() {
                        total_link_destinations += inner.len();
                    }
                    if mt.cycles.len() > max_cycles_in_table.1 {
                        max_cycles_in_table = (id, mt.cycles.len());
                    }
                    let link_dest_total: usize = mt.links.values().map(|m| m.len()).sum();
                    if link_dest_total > max_links_in_table.1 {
                        max_links_in_table = (id, link_dest_total);
                    }
                    let mut had_velocity = false;
                    let mut had_omega = false;
                    let mut had_bitfield_bit_0 = false;
                    for md in mt.cycles.values().chain(mt.modifiers.values()) {
                        total_anims_in_cycles += md.anims.len();
                        if md.velocity.is_some() {
                            had_velocity = true;
                        }
                        if md.omega.is_some() {
                            had_omega = true;
                        }
                        if md.bitfield & 0x01 != 0 {
                            had_bitfield_bit_0 = true;
                        }
                    }
                    if had_velocity {
                        tables_with_velocity += 1;
                    }
                    if had_omega {
                        tables_with_omega += 1;
                    }
                    if had_bitfield_bit_0 {
                        tables_with_bitfield_bit_0 += 1;
                    }
                }
                Err(e) => failures.push((id, e.to_string())),
            }
        }

        eprintln!(
            "[sweep_all_retail_motion_tables] {}/{} parsed; \
             total_cycles={} total_modifiers={} link_groups={} link_destinations={} anims={} \
             tables_with_velocity={} tables_with_omega={} tables_with_bitfield_bit_0={} \
             biggest_cycles=0x{:08X}({}) biggest_links=0x{:08X}({})",
            parsed,
            motion_table_ids.len(),
            total_cycles,
            total_modifiers,
            total_link_groups,
            total_link_destinations,
            total_anims_in_cycles,
            tables_with_velocity,
            tables_with_omega,
            tables_with_bitfield_bit_0,
            max_cycles_in_table.0,
            max_cycles_in_table.1,
            max_links_in_table.0,
            max_links_in_table.1,
        );
        if !failures.is_empty() {
            for (id, err) in failures.iter().take(10) {
                eprintln!("  FAIL 0x{:08X}: {}", id, err);
            }
        }
        assert!(
            failures.is_empty(),
            "{} motion tables failed to parse (showing first 10 above)",
            failures.len()
        );
    }
}
