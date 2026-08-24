using System;

namespace AcmeRagdoll.Sim {
    /// <summary>
    /// C2: THE HIT-REACTION SPRING MATH - the PD spring integrator, the energy pool
    /// (decay + smoothstep visual gain) and the per-impulse shaping, extracted verbatim from
    /// <c>Services/LiveMotionRegistry.cs</c> (2026-08-24, owner-decided refactor; see
    /// docs/install/PREVIEW-DESIGN-2026-08-24.md §2.3).
    ///
    /// EVERYTHING IN HERE IS PURE: no pointers, no ACBindings, no state, no allocation. That is
    /// deliberate and load-bearing twice over -
    ///   * it is what lets the offline harness AND the z-z patcher knob preview compile and drive
    ///     THE SHIPPED SOURCE FILE rather than a transcription of it (the C2 discipline: evidence
    ///     has to be about the code that ships), and
    ///   * a pure static with no lazy type load is the only kind of code that is safe to call from
    ///     the native UpdateParts detour (the 0x80131509 rule).
    ///
    /// BIT-IDENTITY IS THE CONTRACT of the extraction: every method body below is the registry's
    /// original, instruction for instruction - same float operations, same order, same early-outs.
    /// The registry (and the preview) supply the buffers and the <see cref="Tuning"/> scalars; the
    /// impure halves (logging, entry lifetime, part writes) stayed behind in the registry.
    /// </summary>
    internal static class SpringMotion {
        /// <summary>Integrator substep cap, seconds. The explicit-position/implicit-velocity pair used
        /// here is stable for dt &lt; 2/omega_n; the stiffest part we author is omega_n ~ 26.5 rad/s
        /// (dt &lt; 75 ms), so 1/60 s substeps leave a 4.5x margin at any client frame rate.</summary>
        public const float SubstepMaxSec = 1f / 60f;

        /// <summary>Energy floor: the pool snaps to exactly zero below this, so a body that is left
        /// alone ends at a clean 0 rather than an ever-shrinking denormal. It is NOT the retirement
        /// threshold - retirement asks whether the pool can still produce a visible offset (see
        /// <c>LiveMotionRegistry.OnUpdateParts</c>), which is the same question expressed in yards.</summary>
        public const float PoolEpsilon = 0.005f;

        /// <summary>
        /// The spring/energy/crit/shaping scalars of one <c>LiveMotionTuning</c> snapshot, as a plain
        /// stack struct so this file depends only on System (the plugin's LiveMotionTuning lives in
        /// Lib/ and pulls Microsoft.Extensions.Logging, which the launcher must never link). The
        /// registry fills one per frame from the frame's immutable snapshot; the preview fills one
        /// from the raw knob dict. Field meanings and defaults: <c>Lib/LiveMotionConfig.cs</c>.
        /// </summary>
        public readonly struct Tuning {
            public readonly float SpringK;
            public readonly float SpringDamp;
            public readonly float CoreStiffMul;
            public readonly float EdgeStiffMul;
            public readonly float CoreImpulseFrac;
            public readonly float EnergyPerDamagePercent;
            public readonly float ImpulseVelPerEnergy;
            public readonly float PoolHalfLifeSec;
            public readonly float PoolGainKnee;
            public readonly float CritImpulseMult;
            public readonly long CritRefractoryMillis;
            public readonly float SettleDown;
            public readonly float HeightBias;
            public readonly float AttackAttenuation;

            public Tuning(float springK, float springDamp, float coreStiffMul, float edgeStiffMul,
                          float coreImpulseFrac, float energyPerDamagePercent, float impulseVelPerEnergy,
                          float poolHalfLifeSec, float poolGainKnee, float critImpulseMult,
                          long critRefractoryMillis, float settleDown, float heightBias,
                          float attackAttenuation) {
                SpringK = springK; SpringDamp = springDamp;
                CoreStiffMul = coreStiffMul; EdgeStiffMul = edgeStiffMul;
                CoreImpulseFrac = coreImpulseFrac;
                EnergyPerDamagePercent = energyPerDamagePercent;
                ImpulseVelPerEnergy = impulseVelPerEnergy;
                PoolHalfLifeSec = poolHalfLifeSec; PoolGainKnee = poolGainKnee;
                CritImpulseMult = critImpulseMult; CritRefractoryMillis = critRefractoryMillis;
                SettleDown = settleDown; HeightBias = heightBias;
                AttackAttenuation = attackAttenuation;
            }
        }

        /// <summary>What <see cref="ApplyHit"/> computed, for the caller's diagnostics (the registry's
        /// one "livemotion HIT" log line). Pure value data; meaningless unless ApplyHit returned true.</summary>
        public struct HitResult {
            /// <summary>Normalised impulse direction (away from the attacker, sagging by SettleDown).</summary>
            public float Dx, Dy, Dz;
            /// <summary>Sanitised damage fraction actually used.</summary>
            public float DamagePercent;
            /// <summary>Crit multiplier applied (1 when not a crit, or inside the refractory).</summary>
            public float Mul;
            /// <summary>Pool energy this hit contributed (pre-cap).</summary>
            public float Energy;
            /// <summary>Peak per-part velocity kick, yd/s.</summary>
            public float V0;
        }

        /// <summary>
        /// Wall-clock exponential decay of the reaction energy, half-life <see cref="Tuning.PoolHalfLifeSec"/>.
        /// Driven off <paramref name="poolDecayTick"/> rather than the frame dt so energy parked
        /// between frames (impulses arrive on the net path, not this one) decays by the right amount,
        /// and so a frame-rate change never changes the settle time.
        /// </summary>
        public static void DecayPool(ref float pool, ref long poolDecayTick, long now, in Tuning t) {
            long dms = now - poolDecayTick;
            poolDecayTick = now;
            if (dms <= 0 || pool <= 0f) return;
            // 0.6931472 = ln 2; pool *= 2^(-dt/halfLife).
            float k = (dms * 0.001f) * (0.6931472f / t.PoolHalfLifeSec);
            pool *= MathF.Exp(-k);
            if (pool < PoolEpsilon) pool = 0f;
        }

        /// <summary>
        /// Turn ONE hit into pool energy and per-part velocity - the pure whole of the registry's
        /// per-impulse pass (its drain loop calls this once per pending impulse and logs the result).
        ///
        /// ENERGY: <c>e = EnergyPerDamagePercent * DamagePercent * critMul</c>, added to the pool and
        /// HARD CAPPED. A hit that arrives at a full pool therefore adds no energy but still refreshes
        /// the decay (<see cref="DecayPool"/> restarts from this instant at the cap) and still lands
        /// its own velocity kick - "refresh, don't grow", which is what makes a 10-attacker swarm
        /// saturate instead of explode.
        ///
        /// CRIT: the multiplier is applied to the whole impulse, but only ONCE per
        /// <see cref="Tuning.CritRefractoryMillis"/> per body. A crit inside the refractory still delivers
        /// its full BASE impulse - the refractory gates the extra, never the hit.
        ///
        /// DIRECTION: the caller's decoded quadrant (object-local, already "away from the attacker")
        /// plus a small downward settle, normalised. A degenerate direction bails AFTER the pool add,
        /// exactly as the registry always did: the energy is banked, the kick is not.
        ///
        /// KICK: extremities take the whole v0, the core takes CoreImpulseFrac of it, and parts near
        /// the struck height band take more of it than the far rows (HeightBias, floored at 0).
        /// </summary>
        /// <returns>true when the hit landed a kick (the registry's log line fires exactly then).</returns>
        public static bool ApplyHit(float damagePercent, bool critical, long now, ref long lastCritTick,
                                    ref float pool, float poolCap, ref long poolDecayTick,
                                    float dirX, float dirY, byte height,
                                    float[] vel, float[] looseness, float[] normHeight, int n,
                                    in Tuning t, out HitResult r) {
            r = default;

            float dp = damagePercent;
            if (!(dp > 0f)) dp = 0f;             // also rejects NaN
            if (dp > 1f) dp = 1f;

            float mul = 1f;
            if (critical && now - lastCritTick >= t.CritRefractoryMillis) {
                mul = t.CritImpulseMult;
                lastCritTick = now;
            }

            float energy = t.EnergyPerDamagePercent * dp * mul;
            if (energy <= 0f) return false;

            pool += energy;
            if (pool > poolCap) pool = poolCap;
            poolDecayTick = now;                 // the "refresh" half of refresh-don't-grow

            // Unit impulse direction: away from the attacker, sagging slightly downward.
            float dx = dirX, dy = dirY, dz = -t.SettleDown;
            float len = MathF.Sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-6f) return false;
            float inv = 1f / len;
            dx *= inv; dy *= inv; dz *= inv;

            float v0 = t.ImpulseVelPerEnergy * energy;
            float band = HeightBandCenter(height);

            for (int i = 0; i < n; i++) {
                // extremities take the whole kick, the core takes coreImpulseFrac of it
                float w = t.CoreImpulseFrac + (1f - t.CoreImpulseFrac) * looseness[i];
                // ...and parts near the struck height take more of it than the far rows
                float hw = 1f - t.HeightBias * MathF.Abs(normHeight[i] - band);
                if (hw < 0f) hw = 0f;
                float s = v0 * w * hw;
                int b = i * 3;
                vel[b] += dx * s;
                vel[b + 1] += dy * s;
                vel[b + 2] += dz * s;
            }

            r.Dx = dx; r.Dy = dy; r.Dz = dz;
            r.DamagePercent = dp; r.Mul = mul; r.Energy = energy; r.V0 = v0;
            return true;
        }

        /// <summary>Normalised body height a splatter band refers to: 0 = the body's lowest part,
        /// 1 = its highest. Low/Mid/Up are the attacker's AttackHeight (C0 report §4.3).</summary>
        public static float HeightBandCenter(byte height) => height switch {
            0 => 0.20f,   // Low
            2 => 0.85f,   // Up
            _ => 0.50f,   // Mid (and any value we do not recognise)
        };

        /// <summary>
        /// The PD spring, per part, per axis, exactly as specified:
        /// <c>offset += vel*dt; vel += (-k*offset - c*vel)*dt</c> (position first, so the velocity
        /// update sees the NEW offset - the semi-implicit form, which is stable for
        /// <c>dt &lt; 2/omega_n</c> instead of unconditionally divergent).
        ///
        /// Substepped at <see cref="SubstepMaxSec"/> (a compiled-in stability limit, not a knob) so a
        /// 15 fps client and a 144 fps client integrate
        /// the same trajectory, and the stiffest authored part keeps a 4.5x stability margin.
        /// Per-part stiffness comes from looseness (core stiff, extremity loose) and the damping is
        /// scaled by sqrt(kScale) so every part keeps the SAME damping ratio - a limb rings longer
        /// because it is softer, not because it is less damped.
        ///
        /// The offset is clamped to <paramref name="maxOffset"/> inside the loop, not just at
        /// write time, so no amount of stacked impulses can leave the state itself unbounded; a
        /// clamped part also loses half its velocity, which is what stops it from sitting pinned
        /// against the clamp.
        /// </summary>
        public static void Integrate(float[] off, float[] vel, float[] looseness, int n,
                                     float dt, float maxOffset, in Tuning t) {
            int steps = (int)MathF.Ceiling(dt / SubstepMaxSec);
            if (steps < 1) steps = 1;
            float h = dt / steps;

            float[] loose = looseness;
            float maxOff = maxOffset;
            float maxOff2 = maxOff * maxOff;

            for (int i = 0; i < n; i++) {
                float kScale = t.CoreStiffMul + (t.EdgeStiffMul - t.CoreStiffMul) * loose[i];
                float k = t.SpringK * kScale;
                float c = t.SpringDamp * MathF.Sqrt(kScale);
                int b = i * 3;
                float ox = off[b], oy = off[b + 1], oz = off[b + 2];
                float vx = vel[b], vy = vel[b + 1], vz = vel[b + 2];

                for (int s = 0; s < steps; s++) {
                    ox += vx * h; oy += vy * h; oz += vz * h;
                    vx += (-k * ox - c * vx) * h;
                    vy += (-k * oy - c * vy) * h;
                    vz += (-k * oz - c * vz) * h;

                    float m2 = ox * ox + oy * oy + oz * oz;
                    if (m2 > maxOff2) {
                        float scale = maxOff / MathF.Sqrt(m2);
                        ox *= scale; oy *= scale; oz *= scale;
                        vx *= 0.5f; vy *= 0.5f; vz *= 0.5f;
                    }
                }

                off[b] = ox; off[b + 1] = oy; off[b + 2] = oz;
                vel[b] = vx; vel[b + 1] = vy; vel[b + 2] = vz;
            }
        }

        /// <summary>
        /// The visible amplitude multiplier: a smoothstep of the reaction energy, times the
        /// attack-motion attenuation. Smoothstep (not a linear ramp) so the tail of a reaction eases
        /// out instead of stopping, and the knee is well below the cap so an ordinary hit is shown at
        /// full authored amplitude rather than being double-attenuated for being small.
        /// </summary>
        public static float VisualGain(float pool, float poolCap, bool attenuateAttack, in Tuning t) =>
            attenuateAttack ? PoolGain(pool, poolCap, in t) * t.AttackAttenuation
                            : PoolGain(pool, poolCap, in t);

        /// <summary>The energy half of <see cref="VisualGain"/>, without the attack attenuation.
        /// Retirement tests THIS: an entry must not retire early merely because the body happens to be
        /// mid-swing, and it must not be kept alive by an attenuation that will lift next motion.</summary>
        public static float PoolGain(float pool, float poolCap, in Tuning t) {
            float cap = poolCap * t.PoolGainKnee;
            if (cap <= 0f) return 0f;
            float x = pool / cap;        // smoothstep parameter
            if (x <= 0f) return 0f;
            if (x > 1f) x = 1f;
            return x * x * (3f - 2f * x);
        }
    }
}
