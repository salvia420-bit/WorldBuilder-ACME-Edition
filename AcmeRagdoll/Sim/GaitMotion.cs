using System;

namespace AcmeRagdoll.Sim {
    /// <summary>
    /// C5 (PROTOTYPE, first-to-cut): PROCEDURAL TRIPOD GAIT for ONE hexapod body.
    ///
    /// WHAT IT IS. A third, tiny oscillation riding the SAME per-part offset buffers, the SAME
    /// amplitude clamp and the SAME single write path as the C2 hit springs and the C4 breath. While
    /// the body's own motion is LOCOMOTION-class, the six leg chains get an alternating-tripod
    /// lift/sweep cycle laid ON TOP of whatever the retail walk animation is already doing. It is a
    /// TEXTURE, not a replacement: the amplitude is a couple of percent of the body's own radius, the
    /// retail animation still owns the pose, and with <c>gait = 0</c> (the default) not one float of
    /// this file is ever evaluated.
    ///
    /// EVERYTHING IN HERE IS PURE, for the two reasons <see cref="IdleMotion"/> gives: the offline
    /// harness compiles and drives THE SHIPPED FILE rather than a transcription of it, and a pure
    /// static with no lazy type load is the only kind of code that is safe to call from the native
    /// UpdateParts detour (the 0x80131509 rule).
    ///
    /// THE BODY. <see cref="TargetSetupDid"/> (0x02000F95, the Olthoi Piercer/Lacerator/Needler rig)
    /// is HARD-CODED, deliberately, because this stage is proving that the overlay READS WELL - not
    /// building the table format. It is the textbook AC hexapod: six three-part leg chains all built
    /// from the same femur gfxobj (0x01002F77) with the 0x01002F75 tarsus tip, and its Tier-0 tagging
    /// (run DB <c>out/roles_merged.json</c>, batch R002) gives every part a chain and a side.
    ///
    /// HOW TO GENERALIZE (the next lane, not this one). The only body-specific data here is
    /// <see cref="LegParts"/> - 18 part indices in tripod order. That table is MECHANICALLY derivable
    /// from the Tier-0 role data the run already produced: take a body whose archetype is
    /// <see cref="BodyArchetype.Arthropod"/>, group its parts by <c>chain == "leg"</c>, order each
    /// chain root-to-tip through the Setup's ParentIndex graph, sort the chains by rest Y (front to
    /// back) alternating <c>side</c> l/r, and you have this array for any hexapod. Doing that needs
    /// two fields the SHIPPED profile JSON does not currently carry - <c>chain</c> and <c>side</c> are
    /// present in <c>roles_merged.json</c> but are dropped by the profile writer, so
    /// <see cref="AcmeRagdoll.Lib.RagdollProfiles"/> exposes only role/ground. Widening the profile
    /// schema to carry them (and a per-archetype gait table beside it) is the generalization; nothing
    /// in the math below changes when it lands, only where <see cref="LegParts"/> comes from.
    ///
    /// THE GAIT. Two alternating tripods, which is what a real insect walks with: front-right,
    /// middle-left and rear-right swing together while front-left, middle-right and rear-left carry
    /// the body, then they trade. <see cref="LegParts"/> is ordered so that alternating table index
    /// IS alternating tripod (legs 1,3,5 vs 2,4,6 in one-based terms), so a leg's phase is simply
    /// <c>phase + (legIndex &amp; 1) * pi</c> - the phase opposition is structural, not a lookup.
    ///
    /// Per leg, per frame, TRANSLATION ONLY (the quaternion is never touched, exactly as in C2/C4):
    ///   * LIFT, object-local +Z: <c>amp * LiftFrac * max(0, sin(p))</c>. The half-wave is the point -
    ///     a leg is either in SWING (lifted, the positive half) or in STANCE (flat on the ground, the
    ///     clamped-to-zero half). A full sine would push the feet THROUGH the floor for half the cycle.
    ///   * SWEEP, object-local +Y (the model faces +Y - its head sits at rest y ~ +1.03 and its
    ///     abdomen tip at ~ -1.23): <c>amp * SweepFrac * -cos(p)</c>. At p = 0 the foot is at its
    ///     rearmost and lifts; by p = pi it has been carried fully forward and plants; the stance half
    ///     drags it back. That is protraction/retraction in the right order and in the right phase
    ///     relative to the lift.
    ///   * PER-PART: the chain's three parts are weighted <see cref="ChainWeights"/> (proximal barely
    ///     moves, the tarsus tip carries the whole cycle), so the leg articulates instead of
    ///     translating rigidly.
    /// Every part's vector is clamped to the body's own <c>MaxOffset</c> - the C2 amplitude limit -
    /// exactly as <see cref="IdleMotion.Accumulate"/> clamps the breath, and the SUM of springs +
    /// breath + gait is clamped once more at write time. No combination of knobs can make this bigger
    /// than a flinch.
    ///
    /// CADENCE. <see cref="CadenceHz"/> scales the frequency by the body's measured GROUND SPEED
    /// (position delta between frames, out of <c>m_position</c>, which the caller samples) so a
    /// running Olthoi steps faster than a walking one. The scale is clamped to a sane band, and when
    /// no speed sample is available - the first frame, or the frame an object crosses a cell boundary,
    /// where the cell-local origin makes the delta meaningless - the cadence falls back EXACTLY to the
    /// <c>gaitcadence</c> knob. There is no other speed source: the client's velocity vector was not
    /// verified for this stage, and an unverified native read is not worth a nicer cadence.
    /// </summary>
    internal static class GaitMotion {
        /// <summary>
        /// The ONE body this prototype applies to: Setup DataID 0x02000F95 - Olthoi Piercer /
        /// Lacerator / Needler, the textbook AC hexapod (Tier-0 batch R002). Rig siblings that would
        /// work with the identical table, listed here so the generalization lane has them: the
        /// Paradox-touched Olthoi 0x020016FC and the PK Template Olthoi Spitter 0x02001A20. They are
        /// deliberately NOT enabled - one body, one eye-test, one thing to judge.
        /// </summary>
        public const uint TargetSetupDid = 0x02000F95u;

        /// <summary>Legs per tripod gait, and parts per leg chain. Both are properties of the shape
        /// (a hexapod, three-segment legs), not knobs.</summary>
        public const int LegCount = 6;
        public const int ChainLength = 3;

        /// <summary>The target rig's part count. <see cref="Applies"/> refuses a body whose live part
        /// array is shorter, so a morphed/mismatched instance can never index past its own array.</summary>
        public const int MinPartCount = 31;

        /// <summary>
        /// THE ONLY BODY-SPECIFIC DATA IN THIS FILE: 0x02000F95's six leg chains, proximal to distal,
        /// baked from the run DB's part features + Tier-0 chain/side tags
        /// (<c>/mnt/wbterminal2/livemotion/out/roles_merged.json</c>, batch R002).
        ///
        /// ORDERED SO THAT ALTERNATING INDEX IS ALTERNATING TRIPOD. Reading the rest pose, x &gt; 0 is
        /// the body's right and y decreases front to back:
        /// <code>
        ///   leg 0  front-right   p14 -> p15 -> p13    rest (x, y) = (+0.70, +0.57)   tripod A
        ///   leg 1  front-left    p16 -> p17 -> p18          (-0.70, +0.57)           tripod B
        ///   leg 2  middle-left   p22 -> p24 -> p23          (-0.76, +0.06)           tripod A
        ///   leg 3  middle-right  p19 -> p20 -> p21          (+0.76, +0.06)           tripod B
        ///   leg 4  rear-right    p28 -> p29 -> p30          (+0.59, -0.56)           tripod A
        ///   leg 5  rear-left     p25 -> p26 -> p27          (-0.59, -0.56)           tripod B
        /// </code>
        /// Tripod A = {front-right, middle-left, rear-right} and tripod B = {front-left, middle-right,
        /// rear-left} - the two stable triangles an insect actually alternates. The MIDDLE part of
        /// each chain is the one the Tier-0 pass flagged <c>"ground": true</c> (rest z ~ 1.03, the
        /// lowest point of the rig; the tarsus tips angle back UP to z ~ 1.48), which is why the
        /// middle weight in <see cref="ChainWeights"/> is not the smallest of the three.
        /// </summary>
        private static readonly byte[] LegParts = {
            14, 15, 13,   // 0  front-right   (tripod A)
            16, 17, 18,   // 1  front-left    (tripod B)
            22, 24, 23,   // 2  middle-left   (tripod A)
            19, 20, 21,   // 3  middle-right  (tripod B)
            28, 29, 30,   // 4  rear-right    (tripod A)
            25, 26, 27,   // 5  rear-left     (tripod B)
        };

        /// <summary>Share of the cycle each part of a leg chain carries, proximal -&gt; mid -&gt;
        /// distal. The coxa/femur root barely moves (it is bolted to the thorax), the ground-contact
        /// mid joint takes most of it, and the tarsus tip takes all of it - which is what makes the
        /// leg look articulated rather than slid sideways as a rigid unit.</summary>
        private static readonly float[] ChainWeights = { 0.30f, 0.65f, 1.00f };

        /// <summary>Vertical lift as a fraction of the gait amplitude. The full budget: the lift is
        /// the readable half of a step.</summary>
        public const float LiftFrac = 1.00f;

        /// <summary>Fore/aft sweep as a fraction of the gait amplitude. Deliberately smaller than the
        /// lift - the retail walk animation already carries the leg forward, and this layer is only
        /// adding the punctuation.</summary>
        public const float SweepFrac = 0.60f;

        /// <summary>Ground speed, yd/s, at which <c>gaitcadence</c> is taken at face value. ~3 yd/s is
        /// an ordinary creature run on the ACE server we test against; slower bodies step slower and
        /// faster ones faster, within the scale band below.</summary>
        public const float RefSpeedYdS = 3.0f;

        /// <summary>Bounds on the speed-&gt;cadence scale. The floor stops a nearly-stationary body
        /// from freezing mid-step (a frozen sine is a constant offset, i.e. a limp, not a stop); the
        /// ceiling stops a teleport, a knockback or a bad sample from turning the legs into a blur.</summary>
        public const float MinSpeedScale = 0.35f;
        public const float MaxSpeedScale = 2.50f;

        /// <summary>EMA weight for the per-frame ground-speed samples. A single frame's position delta
        /// is noisy (server position updates arrive at their own rate, not the render rate), so the
        /// cadence follows a smoothed speed - ~4 frames to most of a step change.</summary>
        public const float SpeedEmaAlpha = 0.25f;

        /// <summary>Absolute sanity bound on one speed sample, yd/s. A teleport, a cell handoff we
        /// failed to notice or a stalled clock must clamp, never propagate an absurd cadence.</summary>
        public const float MaxSampleYdS = 30f;

        /// <summary>
        /// Does the C5 prototype apply to this body at all? Setup DataID match plus a part-array
        /// length check, so a morphed or mismatched instance of the same setup can never make
        /// <see cref="Accumulate"/> index past its own buffers. Resolved ONCE per entry, with the rest
        /// of the one-time body metrics.
        /// </summary>
        public static bool Applies(uint setupDid, int partCount) =>
            setupDid == TargetSetupDid && partCount >= MinPartCount;

        /// <summary>
        /// Write this frame's gait offsets into <paramref name="dst"/> (3 floats per part, in the same
        /// object-local space as the spring and idle buffers). The buffer is fully CLEARED first and
        /// only the 18 leg parts are then written, so every non-leg part is exactly 0 and contributes
        /// nothing to the write-time sum - the harness pins that, and it is what keeps the gait a leg
        /// animation rather than a whole-body wobble.
        /// </summary>
        /// <param name="dst">Destination offset buffer, 3 floats per part.</param>
        /// <param name="n">Part count; must be at least <see cref="MinPartCount"/>.</param>
        /// <param name="amp">Gait amplitude in yards (<c>gaitamp * bodyRadius</c>, already clamped by
        /// the caller to the body's own maximum offset).</param>
        /// <param name="maxOff">Per-part absolute clamp, yd (the C2 <c>MaxOffset</c>).</param>
        /// <param name="phase">Tripod-A phase, radians (see <see cref="IdleMotion.AdvancePhase"/>);
        /// tripod B runs at <c>phase + pi</c>.</param>
        public static void Accumulate(float[] dst, int n, float amp, float maxOff, float phase) {
            if (dst == null || n < MinPartCount || dst.Length < n * 3) return;
            Array.Clear(dst, 0, n * 3);
            if (!(amp > 0f)) return;              // also rejects NaN: a cleared buffer writes nothing

            float max2 = maxOff * maxOff;

            for (int leg = 0; leg < LegCount; leg++) {
                // The phase opposition is structural: even table index = tripod A, odd = tripod B.
                float p = (leg & 1) == 0 ? phase : phase + MathF.PI;
                float sin = MathF.Sin(p);
                float lift = sin > 0f ? amp * LiftFrac * sin : 0f;   // swing half only; stance is flat
                float sweep = amp * SweepFrac * -MathF.Cos(p);

                for (int j = 0; j < ChainLength; j++) {
                    int part = LegParts[leg * ChainLength + j];
                    if (part >= n) continue;                          // shape guard (Applies bounds it)
                    float w = ChainWeights[j];
                    float y = sweep * w;
                    float z = lift * w;

                    float m2 = y * y + z * z;
                    if (m2 > max2 && m2 > 0f) {
                        float k = maxOff / MathF.Sqrt(m2);
                        y *= k; z *= k;
                    }

                    int b = part * 3;
                    dst[b] = 0f;                                      // no lateral component
                    dst[b + 1] = y;
                    dst[b + 2] = z;
                }
            }
        }

        /// <summary>
        /// This frame's step frequency: the <c>gaitcadence</c> knob scaled by how fast the body is
        /// actually moving. With no usable speed sample (<paramref name="speedValid"/> false - the
        /// first frame, or a cell handoff) the knob is returned UNCHANGED, which is the documented
        /// fixed-cadence fallback.
        /// </summary>
        /// <param name="cadenceHz">The <c>gaitcadence</c> knob, Hz.</param>
        /// <param name="speedYdS">Smoothed ground speed, yd/s (see <see cref="UpdateSpeed"/>).</param>
        /// <param name="speedValid">Whether <paramref name="speedYdS"/> came from a real sample.</param>
        public static float CadenceHz(float cadenceHz, float speedYdS, bool speedValid) {
            if (!(cadenceHz > 0f)) return 0f;                 // also rejects NaN
            if (!speedValid || !(speedYdS > 0f)) return cadenceHz;
            float scale = speedYdS / RefSpeedYdS;
            if (!(scale > MinSpeedScale)) scale = MinSpeedScale;   // also rejects NaN
            else if (scale > MaxSpeedScale) scale = MaxSpeedScale;
            return cadenceHz * scale;
        }

        /// <summary>
        /// Fold one frame's horizontal position delta into the smoothed ground speed. The caller owns
        /// reading <c>m_position</c> and owns the CELL CHECK - an AC object origin is cell-local, so a
        /// delta taken across a cell handoff is nonsense and the caller must reseed instead of calling
        /// this. Everything here is bounded: a bad dt, a NaN or a teleport-sized sample keeps the
        /// previous value rather than propagating.
        /// </summary>
        /// <param name="prev">The entry's current smoothed speed, yd/s.</param>
        /// <param name="dx">Position delta since the last frame, object-space X, yd.</param>
        /// <param name="dy">Position delta since the last frame, object-space Y, yd.</param>
        /// <param name="dt">Frame time, seconds.</param>
        public static float UpdateSpeed(float prev, float dx, float dy, float dt) {
            if (!(dt > 0f)) return prev;
            float d2 = dx * dx + dy * dy;
            if (!(d2 >= 0f)) return prev;                     // NaN
            float s = MathF.Sqrt(d2) / dt;
            if (!(s >= 0f)) return prev;                      // NaN
            if (s > MaxSampleYdS) s = MaxSampleYdS;
            float v = prev + SpeedEmaAlpha * (s - prev);
            return v >= 0f && v <= MaxSampleYdS ? v : prev;
        }
    }
}
