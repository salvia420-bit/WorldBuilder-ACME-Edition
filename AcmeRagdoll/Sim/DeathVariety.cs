using System;
using System.Threading;

namespace AcmeRagdoll.Sim {
    /// <summary>
    /// Per-death parameter variety — the single "death manifold" sampler. Each death of a body is a
    /// low-discrepancy (blue-noise) draw along the top-4 principal components of the 693-profile
    /// parameter distribution (baked in <see cref="DeathVarietyModel"/>), added to that body's own
    /// profile. Because the draw moves along the PRINCIPAL axes the varied params stay correlated and
    /// in-character (no limp-but-violent nonsense that independent per-param noise would produce), and
    /// because the R4 additive-recurrence sequence is quasi-random the successive corpses in view are
    /// evenly spread and non-repeating rather than RNG-clumpy. The same draw sets the "killing-blow"
    /// topple azimuth, so the chaotic verlet sim amplifies it into a physically distinct fall.
    ///
    /// One algorithm, all 693 bodies: the manifold is universal (built from every profile); a body only
    /// contributes its own center point (its profile) and inherits the shared spread (the eigenvalues).
    ///
    /// HANDOFF: the varied params + direction + orientation commit produced here are stored verbatim in
    /// the creature's <c>HandoffRecord</c> (Params/Direction/OrientCommit) and the corpse rebuilds from
    /// those, so the corpse continues the EXACT same sampled death — the counter advances per death, not
    /// per corpse. DISABLED (cfg <c>deathvariety=0</c>, the default): <see cref="Perturb"/> returns the
    /// base profile and leaves the direction untouched, so behaviour is byte-for-byte the prior death.
    /// </summary>
    internal static class DeathVariety {
        /// <summary>Master switch, pushed from ragdoll.cfg by the config poller. Default OFF.</summary>
        internal static volatile bool Enabled;
        /// <summary>How far a death may wander along the manifold, in eigen-sigmas (cfg
        /// <c>deathvarietystrength</c>). 0 = none; ~0.6 = tasteful; &gt;1 = wild. Clamped [0,1.5].</summary>
        internal static float Strength = 0.6f;
        /// <summary>Gain on the orientation commit (cfg <c>deathorientgain</c>), the correction that
        /// stops a front-heavy body from face-planting whatever heading it drew — see
        /// <see cref="OrientBase"/> and RagdollSim's ORIENTATION COMMIT block. Multiplied by
        /// <see cref="Strength"/>, so the owner can tune the fall variety with one knob and the
        /// orientation lever with the other. Clamped [0,4] by the config reader.</summary>
        internal static float OrientGain = 1.4f;

        // Global monotone draw index. A death samples the next quasi-random point; the result flows to
        // the corpse via the handoff record, so only NEW creature deaths advance it.
        private static long _counter;

        // Per-param envelope [min,max] in the DeathVarietyModel canonical order. Same bounds the offline
        // validator enforced; maxSpeed/maxUpSpeed max == default so variety can never push them ABOVE
        // default (the anti-fly guarantee holds).
        private static readonly float[] Min = {
            1.2f, 0.6f, 0.35f, 0.6f, 0.3f, 0.10f, 0.05f, 0.10f, 4f, 1.5f,
            0.975f, 0.35f, 0.15f, 0.50f, 0.25f, 0.30f, 45f, 0f };
        private static readonly float[] Max = {
            3.2f, 1.5f, 0.8f, 3.0f, 1.5f, 0.40f, 0.25f, 0.50f, 8f, 3.0f,
            0.992f, 0.75f, 0.50f, 1.20f, 0.70f, 0.75f, 150f, 0.7f };

        // Coherent per-corpse micro-dither (fraction of each param's envelope range) so two deaths that
        // land near each other on the manifold still differ in the fine detail. Seeded by object id.
        private const float MicroFrac = 0.04f;

        // R4 sequence's 5th additive constant (frac(phi^-5), phi^5 = phi+1) for the killing-blow azimuth.
        private const double Alpha5 = 0.4614027427763899;

        /// <summary>Per-death dither on the orientation commit, as a fraction of it: a death commits
        /// somewhere in [1-OrientDither, 1+OrientDither] times the nominal amount, coherently from the
        /// object id. Keeps a crowd of simultaneous deaths from all committing identically (a few still
        /// face-plant, which is what a real pile looks like) without changing the average.</summary>
        private const float OrientDither = 0.2f;

        /// <summary>Nominal orientation commit at strength 1 and gain 1: exactly ONE cancellation of the
        /// body's measured center-of-mass bias over the fall window. Everything about how much rotation
        /// that actually is is measured per death pose inside RagdollSim; this is only the scalar.</summary>
        private const float OrientBase = 1.0f;

        /// <summary>Return this death's varied parameters, set <paramref name="direction"/> to the
        /// per-death topple azimuth, and output <paramref name="orientCommit"/> — how hard the sim
        /// should fight this body's own center-of-mass bias to actually fall along
        /// <paramref name="direction"/> (the prone/supine/on-side lever; see RagdollSim's ORIENTATION
        /// COMMIT block). When disabled, returns <paramref name="baseP"/>, leaves direction unchanged
        /// and outputs orientCommit=0 (bit-identical default, and the sim skips the block entirely).
        /// Allocation-free (stack spans); safe on the native detour thread.</summary>
        public static RagdollParams Perturb(RagdollParams baseP, uint objId, ref float direction, out float orientCommit) {
            orientCommit = 0f;
            if (!Enabled) return baseP;

            int K = DeathVarietyModel.K, P = DeathVarietyModel.P;
            long n = Interlocked.Increment(ref _counter);
            float strength = Strength < 0f ? 0f : (Strength > 1.5f ? 1.5f : Strength);

            // Latent offset along each principal component: invNorm of a low-discrepancy uniform,
            // scaled by that axis's sigma (sqrt eigenvalue) and the global strength.
            Span<float> delta = stackalloc float[DeathVarietyModel.K];
            for (int k = 0; k < K; k++) {
                float u = (float)Frac(0.5 + n * DeathVarietyModel.Alpha[k]);
                delta[k] = InvNorm(u) * MathF.Sqrt(DeathVarietyModel.Eigen[k]) * strength;
            }

            // Decode to raw-unit param deltas: dParam_j = std_j * sum_k Basis[j,k] * delta_k, added to
            // this body's own profile, plus the coherent micro-dither, then clamped to the envelope.
            Span<float> p = stackalloc float[DeathVarietyModel.P];
            baseP.ToVarietyVector(p);
            for (int j = 0; j < P; j++) {
                float sd = 0f;
                for (int k = 0; k < K; k++) sd += DeathVarietyModel.Basis[j * K + k] * delta[k];
                p[j] += DeathVarietyModel.Std[j] * sd;
                p[j] += (Hash01(objId, (uint)j) - 0.5f) * MicroFrac * (Max[j] - Min[j]);
                if (p[j] < Min[j]) p[j] = Min[j]; else if (p[j] > Max[j]) p[j] = Max[j];
            }

            // Killing-blow azimuth from a 5th low-discrepancy dimension (0..2pi).
            direction = (float)(2.0 * Math.PI * Frac(0.5 + n * Alpha5));

            // ORIENTATION COMMIT (2026-08-23, replaces the rejected pre-lean). A sampled azimuth is
            // worthless on a front-heavy body: gravity's own forward torque out-rotates the seeded
            // topple and it face-plants anyway. This scalar tells the sim how hard to cancel that bias
            // with ANGULAR VELOCITY, which keeps the fall an actual visible fall — unlike the pre-lean,
            // which tipped the pose past its balance point and snapped the body flat in two frames
            // (owner-rejected; RagdollSim.ApplyDeathLean is gone with it). 1.0 = cancel the measured
            // bias exactly once over the fall window; the sim caps what that can become so it can never
            // launch the body. Dithered per-corpse so a pile is not uniform.
            orientCommit = strength * OrientGain * OrientBase
                           * (1f + (Hash01(objId, 0xB1A5u) - 0.5f) * 2f * OrientDither);
            if (orientCommit < 0f) orientCommit = 0f;

            return RagdollParams.FromVarietyVector(p, baseP.DirBiasDeg);
        }

        private static double Frac(double x) => x - Math.Floor(x);

        /// <summary>Cheap deterministic 32-bit hash of (a,b) to [0,1) for the coherent micro-dither.</summary>
        private static float Hash01(uint a, uint b) {
            uint h = a * 2654435761u ^ (b + 0x9E3779B9u + (a << 6) + (a >> 2));
            h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
            return (h & 0xFFFFFFu) / 16777216f;
        }

        /// <summary>Acklam's rational approximation of the inverse standard-normal CDF (|err| &lt; 1.15e-9).
        /// Maps a low-discrepancy uniform in (0,1) to a Gaussian latent coordinate.</summary>
        private static float InvNorm(float pf) {
            double p = pf < 1e-6f ? 1e-6 : (pf > 1f - 1e-6f ? 1f - 1e-6 : pf);
            const double a1 = -3.969683028665376e+01, a2 = 2.209460984245205e+02,
                         a3 = -2.759285104469687e+02, a4 = 1.383577518672690e+02,
                         a5 = -3.066479806614716e+01, a6 = 2.506628277459239e+00;
            const double b1 = -5.447609879822406e+01, b2 = 1.615858368580409e+02,
                         b3 = -1.556989798598866e+02, b4 = 6.680131188771972e+01, b5 = -1.328068155288572e+01;
            const double c1 = -7.784894002430293e-03, c2 = -3.223964580411365e-01,
                         c3 = -2.400758277161838e+00, c4 = -2.549732539343734e+00,
                         c5 = 4.374664141464968e+00, c6 = 2.938163982698783e+00;
            const double d1 = 7.784695709041462e-03, d2 = 3.224671290700398e-01,
                         d3 = 2.445134137142996e+00, d4 = 3.754408661907416e+00;
            const double plow = 0.02425, phigh = 1 - 0.02425;
            double q, r, x;
            if (p < plow) {
                q = Math.Sqrt(-2 * Math.Log(p));
                x = (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
                    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
            } else if (p <= phigh) {
                q = p - 0.5; r = q * q;
                x = (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
                    (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
            } else {
                q = Math.Sqrt(-2 * Math.Log(1 - p));
                x = -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
                    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
            }
            return (float)x;
        }
    }
}
