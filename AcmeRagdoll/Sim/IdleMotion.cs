using System;

namespace AcmeRagdoll.Sim {
    /// <summary>Body archetype, exactly the Tier-0 vocabulary the Phase-B role data ships in the
    /// profile file's <c>"archetype"</c> field. <see cref="Unknown"/> covers a body with no profile
    /// (or an archetype string we do not recognise) and falls back to the structural heuristic.</summary>
    internal enum BodyArchetype : byte {
        Unknown = 0, Biped, Quadruped, Arthropod, Avian, Serpent, Floater, Blob, Prop, Mixed,
    }

    /// <summary>Per-part semantic role, the Tier-0 vocabulary of a profile part's <c>"role"</c>
    /// field. <see cref="Unknown"/> = the profile did not name this part.</summary>
    internal enum PartRole : byte {
        Unknown = 0, Core, Head, Limb, Wing, Tail, Cloak, Tentacle, Prop,
    }

    /// <summary>
    /// C4: IDLE MICRO-MOTION - the archetype-driven breathing/bob/pulse that rides the SAME per-part
    /// offset buffers, amplitude clamp and write path as the C2 hit springs.
    ///
    /// EVERYTHING IN HERE IS PURE: no pointers, no ACBindings, no state, no allocation past the two
    /// weight arrays built once per body. That is deliberate and load-bearing twice over -
    ///   * it is what lets the offline harness compile and drive THE SHIPPED SOURCE FILE rather than a
    ///     transcription of it (the C2 discipline: evidence has to be about the code that ships), and
    ///   * a pure static with no lazy type load is the only kind of code that is safe to call from the
    ///     native UpdateParts detour (the 0x80131509 rule).
    ///
    /// THE SHAPES, per archetype (<see cref="Build"/> turns roles into the two weight arrays and
    /// <see cref="Accumulate"/> turns those into this frame's offsets):
    ///   * BIPED / QUADRUPED / ARTHROPOD / AVIAN / SERPENT / MIXED - BREATHING. One vertical
    ///     (object-local Z) sine at <c>idlehz</c> shared by the whole body, weighted per part so the
    ///     core/chest carries it, the head follows at about half, and limbs are near-zero. A part
    ///     flagged <c>"ground": true</c> in the profile is PINNED (weight 0), so feet stay planted and
    ///     the body breathes against the floor instead of sliding along it.
    ///   * FLOATER - DRIFT/BOB. The whole body shares one vertical sine (every part at full weight, so
    ///     it translates rather than deforms) PLUS a much slower horizontal sway
    ///     (<see cref="SwayHzFrac"/> of <c>idlehz</c>) on cloak/tentacle parts only, each with its own
    ///     phase offset so a Wisp's streamers trail rather than march in step.
    ///   * BLOB - PULSE. Vertical, per part scaled by the body's own C2 LOOSENESS weight, so the
    ///     slack outer parts swell and the core barely moves: a radial-ish breath out of purely
    ///     vertical motion, which keeps this layer translation-only like C2.
    ///   * PROP - NOTHING. A hard skip: <see cref="Build"/> returns false, the body is never made
    ///     idle-eligible, it never lingers, and no idle offset is ever computed for it. Chests, doors,
    ///     lifestones and the other 221 prop bodies do not breathe.
    ///   * UNKNOWN (no profile) - breathing with <c>1 - looseness</c> as the weight, which is the same
    ///     "core moves, extremities do not" statement expressed through the structural heuristic.
    ///
    /// PHASE. Every body carries its own phase, seeded from its object id (<see cref="PhaseFor"/>) and
    /// ADVANCED PER FRAME by <see cref="AdvancePhase"/> rather than evaluated from a wall clock. The
    /// seed is what stops a camp of drudges breathing in unison; the advance is what lets
    /// <c>idlehz</c> be retuned live without the sine jumping (a clock-based phase would teleport the
    /// body the instant the frequency changed).
    /// </summary>
    internal static class IdleMotion {
        /// <summary>2*pi, the phase advance for one full cycle.</summary>
        public const float TwoPi = 6.2831853f;

        /// <summary>Floater sway frequency as a fraction of <c>idlehz</c>. 0.23 is a ~13 s sway under
        /// the default 0.35 Hz bob - slow enough to read as drifting rather than as a second
        /// oscillation.</summary>
        public const float SwayHzFrac = 0.23f;

        /// <summary>Sway amplitude as a fraction of the vertical amplitude, and the Y/X anisotropy
        /// that turns a circle into a shallow ellipse (a drift, not an orbit).</summary>
        public const float SwayAmpFrac = 0.8f;
        public const float SwayYFrac = 0.6f;

        /// <summary>Per-part phase step for the sway, radians. Irrational-ish so no two parts of a
        /// realistic body land in phase.</summary>
        public const float SwayPartPhaseStep = 1.13f;

        // ---- breathing weights by role (the "core breathes, limbs do not" table) ----
        private const float WCore = 1.00f;
        private const float WHead = 0.55f;
        private const float WCloak = 0.45f;
        private const float WTentacle = 0.45f;
        private const float WTail = 0.25f;
        private const float WWing = 0.20f;
        private const float WLimb = 0.10f;
        private const float WProp = 0.00f;

        /// <summary>Does this archetype produce idle motion at all? The one hard skip is
        /// <see cref="BodyArchetype.Prop"/>.</summary>
        public static bool Produces(BodyArchetype a) => a != BodyArchetype.Prop;

        /// <summary>
        /// Build a body's per-part idle weights once, from its archetype + Tier-0 roles + the C2
        /// looseness array. Returns false - with both arrays null - when the body must not idle at all
        /// (prop archetype, no parts, or a weight set that is entirely zero, e.g. a creature whose
        /// every part is ground-pinned). A false here is what keeps a body off the linger path
        /// entirely, so "prop writes nothing" costs nothing rather than costing a zeroed write loop.
        /// </summary>
        /// <param name="a">Body archetype from the profile.</param>
        /// <param name="roles">Per-part <see cref="PartRole"/> as bytes, or null when the body has no
        /// role data (then <paramref name="looseness"/> carries the whole judgement).</param>
        /// <param name="ground">Per-part "this part touches the floor in the rest pose" flags, or
        /// null. Ground parts are pinned for every archetype except <see cref="BodyArchetype.Floater"/>,
        /// which has no floor to stand on.</param>
        /// <param name="looseness">The C2 per-part looseness (0 core .. 1 extremity). Never null.</param>
        /// <param name="n">Part count; the arrays may be shorter and are read defensively.</param>
        /// <param name="vert">OUT: per-part vertical weight, 0..1, or null when the body cannot idle.</param>
        /// <param name="sway">OUT: per-part sway weight, or null for every archetype but floater.</param>
        public static bool Build(BodyArchetype a, byte[]? roles, bool[]? ground, float[] looseness, int n,
                                 out float[]? vert, out float[]? sway) {
            vert = null;
            sway = null;
            if (n <= 0 || looseness == null || looseness.Length < n) return false;
            if (!Produces(a)) return false;

            var v = new float[n];
            float[]? s = null;
            bool anyV = false;

            for (int i = 0; i < n; i++) {
                PartRole role = roles != null && i < roles.Length ? (PartRole)roles[i] : PartRole.Unknown;
                bool onGround = ground != null && i < ground.Length && ground[i];
                float w;

                switch (a) {
                    case BodyArchetype.Floater:
                        // whole-body bob: every part rides it, so the body translates instead of
                        // stretching. Only an authored prop part (a carried torch, a banner) sits out.
                        w = role == PartRole.Prop ? 0f : 1f;
                        if (role == PartRole.Cloak || role == PartRole.Tentacle) {
                            (s ??= new float[n])[i] = 1f;
                        }
                        break;

                    case BodyArchetype.Blob:
                        // pulse: the slack parts swell, the core holds - looseness IS the shape.
                        w = onGround ? 0f : Clamp01(looseness[i]);
                        break;

                    default:
                        // breathing (biped/quadruped/arthropod/avian/serpent/mixed and unknown)
                        w = onGround ? 0f : RoleBreathWeight(role, looseness[i]);
                        break;
                }

                if (!(w > 0f)) w = 0f;          // also rejects NaN
                else if (w > 1f) w = 1f;
                v[i] = w;
                if (w > 0f) anyV = true;
            }

            if (!anyV && s == null) return false;
            vert = v;
            sway = s;
            return true;
        }

        /// <summary>The breathing weight of one part: its authored role where it has one, else
        /// <c>1 - looseness</c> - the structural way of saying the same thing.</summary>
        private static float RoleBreathWeight(PartRole role, float looseness) => role switch {
            PartRole.Core => WCore,
            PartRole.Head => WHead,
            PartRole.Cloak => WCloak,
            PartRole.Tentacle => WTentacle,
            PartRole.Tail => WTail,
            PartRole.Wing => WWing,
            PartRole.Limb => WLimb,
            PartRole.Prop => WProp,
            _ => 1f - Clamp01(looseness),
        };

        /// <summary>
        /// Write this frame's idle offsets into <paramref name="dst"/> (3 floats per part, OVERWRITTEN
        /// not accumulated - the caller's spring offsets live in their own buffer and the two are
        /// summed at write time). Every part's idle vector is clamped to <paramref name="maxOff"/>,
        /// the SAME per-part amplitude clamp the springs obey, so no combination of amplitude knob and
        /// body radius can make idle motion bigger than a flinch.
        /// </summary>
        /// <param name="dst">Destination offset buffer, 3 floats per part.</param>
        /// <param name="n">Part count to fill.</param>
        /// <param name="vert">Per-part vertical weight from <see cref="Build"/>.</param>
        /// <param name="sway">Per-part sway weight from <see cref="Build"/>, or null.</param>
        /// <param name="amp">Idle amplitude in yards - <c>idleamp * bodyRadius</c>, already clamped by
        /// the caller to the body's own maximum offset.</param>
        /// <param name="maxOff">Per-part absolute clamp, yd (the C2 <c>MaxOffset</c>).</param>
        /// <param name="phase">Vertical phase, radians (see <see cref="AdvancePhase"/>).</param>
        /// <param name="swayPhase">Sway phase, radians. Unused when <paramref name="sway"/> is null.</param>
        public static void Accumulate(float[] dst, int n, float[] vert, float[]? sway,
                                      float amp, float maxOff, float phase, float swayPhase) {
            if (dst == null || vert == null || n <= 0) return;
            if (dst.Length < n * 3 || vert.Length < n) return;
            if (!(amp > 0f)) { Array.Clear(dst, 0, n * 3); return; }

            float sv = MathF.Sin(phase);        // one sine for the whole body's breath
            float max2 = maxOff * maxOff;

            for (int i = 0; i < n; i++) {
                int b = i * 3;
                float x = 0f, y = 0f;
                float z = amp * vert[i] * sv;

                if (sway != null && i < sway.Length && sway[i] > 0f) {
                    float p = swayPhase + i * SwayPartPhaseStep;
                    float sa = amp * sway[i] * SwayAmpFrac;
                    x = sa * MathF.Sin(p);
                    y = sa * MathF.Cos(p) * SwayYFrac;
                }

                float m2 = x * x + y * y + z * z;
                if (m2 > max2 && m2 > 0f) {
                    float k = maxOff / MathF.Sqrt(m2);
                    x *= k; y *= k; z *= k;
                }

                dst[b] = x; dst[b + 1] = y; dst[b + 2] = z;
            }
        }

        /// <summary>
        /// THE ONE COMBINE. Sums this part's spring offset (already scaled by the C2 visual gain) and
        /// its idle offset, clamps the SUM to the body's per-part amplitude clamp, and answers whether
        /// the result is worth a client write at all.
        ///
        /// BIT-IDENTITY, and the reason this is one function rather than two paths: with
        /// <paramref name="idleActive"/> false the body of this method is
        /// <c>offset * gain</c> followed by the pre-C4 epsilon compare, instruction for instruction -
        /// no add, no clamp, no rounding that could differ. So <c>idlemotion = 0</c> reproduces the C3
        /// write stream exactly, which is the property the harness pins.
        /// </summary>
        /// <returns>true when the caller should write this part.</returns>
        public static bool Combine(float sx, float sy, float sz, float gain,
                                   float ix, float iy, float iz, bool idleActive,
                                   float maxOff, float writeEpsilon,
                                   out float ox, out float oy, out float oz) {
            ox = sx * gain; oy = sy * gain; oz = sz * gain;

            if (idleActive) {
                ox += ix; oy += iy; oz += iz;
                float m2 = ox * ox + oy * oy + oz * oz;
                float max2 = maxOff * maxOff;
                if (m2 > max2 && m2 > 0f) {
                    float k = maxOff / MathF.Sqrt(m2);
                    ox *= k; oy *= k; oz *= k;
                }
            }

            return ox * ox + oy * oy + oz * oz >= writeEpsilon * writeEpsilon;
        }

        /// <summary>Advance a phase by one frame at <paramref name="hz"/>, wrapped to [0, 2pi). Phase
        /// is CARRIED, never recomputed from a clock, so retuning <c>idlehz</c> mid-breath changes the
        /// rate without moving the body.</summary>
        public static float AdvancePhase(float phase, float hz, float dt) {
            if (!(hz > 0f) || !(dt > 0f)) return phase;
            float p = phase + TwoPi * hz * dt;
            if (p >= TwoPi) p -= TwoPi * MathF.Floor(p / TwoPi);
            if (!(p >= 0f) || !(p < TwoPi)) return 0f;   // NaN/inf guard
            return p;
        }

        /// <summary>Per-body starting phase in [0, 2pi), hashed from the object id - which is what
        /// stops a camp of drudges breathing in unison. Deterministic: the same body always starts on
        /// the same beat, so a reload does not visibly resynchronise a camp either.</summary>
        public static float PhaseFor(uint objId) {
            // xorshift-style avalanche (the mulberry32 mixer's finaliser); the low bits of an AC object
            // id are sequential, so an unmixed id would put a whole spawn group in near-lockstep.
            uint h = objId;
            h ^= h >> 16; h *= 0x7FEB352Du;
            h ^= h >> 15; h *= 0x846CA68Bu;
            h ^= h >> 16;
            return (h & 0xFFFFFFu) * (TwoPi / 16777216f);
        }

        /// <summary>
        /// THE LINGER TEST - the whole of C4's answer to "how does idle motion get seen without
        /// arming the hot detour on every creature in the world".
        ///
        /// A body is only ever tracked because the HIT layer created an entry for it. Without this
        /// test that entry retires the instant its springs settle, so a creature would never be
        /// observed idling; with it, an entry whose springs have settled stays alive - and breathing -
        /// for <c>idlelingersec</c> after its LAST HIT, then retires normally. Retirement therefore
        /// needs quiet AND linger expiry.
        ///
        /// This is deliberately NOT world-wide ambient idle motion (see the README): keeping every
        /// creature breathing would mean keeping the UpdateParts detour armed permanently, which is a
        /// measured decision, not a coding one.
        /// </summary>
        public static bool Lingering(long now, long lastHitTick, bool idleEnabled, bool eligible,
                                     float lingerSec) {
            if (!idleEnabled || !eligible) return false;
            if (!(lingerSec > 0f)) return false;
            long window = (long)(lingerSec * 1000f);
            long since = now - lastHitTick;
            return since >= 0 && since < window;
        }

        // ------------------------------------------------------------------ profile vocabulary

        /// <summary>Profile <c>"archetype"</c> string -&gt; enum. Unrecognised (or missing) =
        /// <see cref="BodyArchetype.Unknown"/>, which breathes off the structural heuristic. Called at
        /// profile-load time on the managed thread only.</summary>
        public static BodyArchetype ParseArchetype(string? s) {
            if (string.IsNullOrEmpty(s)) return BodyArchetype.Unknown;
            switch (s.ToLowerInvariant()) {
                case "biped": return BodyArchetype.Biped;
                case "quadruped": return BodyArchetype.Quadruped;
                case "arthropod": return BodyArchetype.Arthropod;
                case "avian": return BodyArchetype.Avian;
                case "serpent": return BodyArchetype.Serpent;
                case "floater": return BodyArchetype.Floater;
                case "blob": return BodyArchetype.Blob;
                case "prop": return BodyArchetype.Prop;
                case "mixed": return BodyArchetype.Mixed;
                default: return BodyArchetype.Unknown;
            }
        }

        /// <summary>Profile part <c>"role"</c> string -&gt; enum. Unrecognised (or missing) =
        /// <see cref="PartRole.Unknown"/>, which falls back to looseness for that ONE part.</summary>
        public static PartRole ParseRole(string? s) {
            if (string.IsNullOrEmpty(s)) return PartRole.Unknown;
            switch (s.ToLowerInvariant()) {
                case "core": return PartRole.Core;
                case "head": return PartRole.Head;
                case "limb": return PartRole.Limb;
                case "wing": return PartRole.Wing;
                case "tail": return PartRole.Tail;
                case "cloak": return PartRole.Cloak;
                case "tentacle": return PartRole.Tentacle;
                case "prop": return PartRole.Prop;
                default: return PartRole.Unknown;
            }
        }

        private static float Clamp01(float v) {
            if (!(v > 0f)) return 0f;      // also rejects NaN
            return v > 1f ? 1f : v;
        }
    }
}
