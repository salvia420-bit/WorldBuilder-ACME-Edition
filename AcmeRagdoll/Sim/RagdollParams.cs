namespace AcmeRagdoll.Sim {
    /// <summary>
    /// Per-body ragdoll tuning: the parameters that make a Golem drop like dead weight and a Wisp
    /// fold inward. One instance is chosen per creature body (Setup DataID) at seed time by
    /// <see cref="AcmeRagdoll.Lib.RagdollProfiles"/>; bodies with no profile get
    /// <see cref="Default"/>, whose values are EXACTLY the constants <see cref="RagdollSim"/>
    /// shipped with, so an unprofiled death is bit-for-bit the old behaviour.
    ///
    /// PURE VALUE DATA - immutable, no client pointers, no lazily-loaded types. That is what makes
    /// it safe to (a) hold inside a <c>HandoffRecord</c> that outlives the creature object it came
    /// from, and (b) read from inside a native detour, where a lazy assembly/type load would fail
    /// with 0x80131509 (see AcmeRagdollPlugin.WarmupAcBindings).
    ///
    /// The envelopes each parameter is authored within live in
    /// /mnt/wbterminal2/ragdoll-individualize/RUNBOOK.md; nothing is clamped here - the profile
    /// generator's validator owns that.
    /// </summary>
    internal sealed class RagdollParams {
        // ---- the shipped defaults (were the private consts in RagdollSim) ----
        public const float DefaultImpulse = 2.2f;
        public const float DefaultToppleGain = 1.0f;
        public const float DefaultToppleRateCap = 0.6f;
        public const float DefaultTwist = 2.2f;
        public const float DefaultDirJitter = 0.9f;
        public const float DefaultLinearFrac = 0.25f;
        public const float DefaultJitter = 0.12f;
        public const float DefaultBounceMax = 0.35f;
        public const float DefaultMaxSpeed = 8.0f;
        public const float DefaultMaxUpSpeed = 3.0f;
        public const float DefaultDamping = 0.985f;
        public const float DefaultFloorFriction = 0.55f;
        public const float DefaultGiveMin = 0.30f;
        public const float DefaultGiveSpan = 0.95f;
        public const float DefaultGiveRamp = 0.45f;
        public const float DefaultCoreBias = 0.55f;
        /// <summary>3 s at 30 fps - well past settle for a creature-scale body.</summary>
        public const int DefaultFallFrames = 90;
        public const float DefaultDirBiasStrength = 0.0f;

        /// <summary>Death-hit shove strength.</summary>
        public readonly float Impulse;
        /// <summary>Directional topple torque gain.</summary>
        public readonly float ToppleGain;
        /// <summary>Topple angular-rate cap (in units of sqrt(g/height)).</summary>
        public readonly float ToppleRateCap;
        /// <summary>Body twist about the vertical during the fall.</summary>
        public readonly float Twist;
        /// <summary>Randomness (radians, peak-to-peak) added to the topple direction.</summary>
        public readonly float DirJitter;
        /// <summary>Share of the impulse spent as a linear shove rather than rotation.</summary>
        public readonly float LinearFrac;
        /// <summary>Per-node velocity noise.</summary>
        public readonly float Jitter;
        /// <summary>Ground bounce (restitution) cap.</summary>
        public readonly float BounceMax;
        /// <summary>Per-node speed cap, yd/s (anti-fly; never authored above the default).</summary>
        public readonly float MaxSpeed;
        /// <summary>Per-node UPWARD speed cap, yd/s (anti-fly; never authored above the default).</summary>
        public readonly float MaxUpSpeed;
        /// <summary>Verlet velocity retention per substep (lower = settles faster).</summary>
        public readonly float Damping;
        /// <summary>Tangential velocity retention on ground contact (lower = less slide).</summary>
        public readonly float FloorFriction;
        /// <summary>Joint give schedule: earliest release time (low = limp).</summary>
        public readonly float GiveMin;
        /// <summary>Joint give schedule: randomized spread of release times.</summary>
        public readonly float GiveSpan;
        /// <summary>Joint give schedule: ramp-in duration once a joint starts releasing.</summary>
        public readonly float GiveRamp;
        /// <summary>How much a joint's give time follows spine-vs-limb depth rather than chance.</summary>
        public readonly float CoreBias;
        /// <summary>Rendered frames of active simulation before the pose is held.</summary>
        public readonly int FallFrames;
        /// <summary>Preferred fall direction in MODEL space, degrees, 0 = +Y (forward); null = no
        /// bias (the seed-derived direction is used unchanged).</summary>
        public readonly float? DirBiasDeg;
        /// <summary>How strongly the seed-derived direction is pulled toward
        /// <see cref="DirBiasDeg"/> (0 = not at all, 1 = exactly onto it).</summary>
        public readonly float DirBiasStrength;

        /// <summary>The shipped behaviour: every value equals the constant RagdollSim used before
        /// per-body parameterization, so a body with no profile falls exactly as it did.</summary>
        public static readonly RagdollParams Default = new RagdollParams();

        /// <summary>Every argument defaults to the shipped constant, so a caller sets only what a
        /// profile actually moves off default.</summary>
        public RagdollParams(
            float impulse = DefaultImpulse,
            float toppleGain = DefaultToppleGain,
            float toppleRateCap = DefaultToppleRateCap,
            float twist = DefaultTwist,
            float dirJitter = DefaultDirJitter,
            float linearFrac = DefaultLinearFrac,
            float jitter = DefaultJitter,
            float bounceMax = DefaultBounceMax,
            float maxSpeed = DefaultMaxSpeed,
            float maxUpSpeed = DefaultMaxUpSpeed,
            float damping = DefaultDamping,
            float floorFriction = DefaultFloorFriction,
            float giveMin = DefaultGiveMin,
            float giveSpan = DefaultGiveSpan,
            float giveRamp = DefaultGiveRamp,
            float coreBias = DefaultCoreBias,
            int fallFrames = DefaultFallFrames,
            float? dirBiasDeg = null,
            float dirBiasStrength = DefaultDirBiasStrength) {
            Impulse = impulse;
            ToppleGain = toppleGain;
            ToppleRateCap = toppleRateCap;
            Twist = twist;
            DirJitter = dirJitter;
            LinearFrac = linearFrac;
            Jitter = jitter;
            BounceMax = bounceMax;
            MaxSpeed = maxSpeed;
            MaxUpSpeed = maxUpSpeed;
            Damping = damping;
            FloorFriction = floorFriction;
            GiveMin = giveMin;
            GiveSpan = giveSpan;
            GiveRamp = giveRamp;
            CoreBias = coreBias;
            FallFrames = fallFrames;
            DirBiasDeg = dirBiasDeg;
            DirBiasStrength = dirBiasStrength;
        }
    }
}
