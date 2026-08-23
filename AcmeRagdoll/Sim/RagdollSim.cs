using System;
using System.Collections.Generic;

namespace AcmeRagdoll.Sim {
    /// <summary>
    /// The validated verlet ragdoll, ported to C# from tools/dat-patch/ragdoll_bake.py
    /// (the offline baker), which is itself a faithful port of the web client's
    /// external/holtburger/apps/holtburger-web/scene3d/ragdoll.js (default-ON since 2026-08-02).
    ///
    /// WHAT IS PORTED (the CORE the brief asked for):
    ///   * one verlet particle per Setup part;
    ///   * distance constraints along the parent + grandparent links of the Setup's
    ///     ParentIndex graph (bone + bend), plus offline-style orphan "weld" links so a
    ///     multi-root skeleton (e.g. the Drudge's two free hip chains) does not free-fall apart;
    ///   * per-joint randomized "give" schedule + spanning-anchor rigidity braces;
    ///   * seeded directional topple impulse (omega x r) + twist + shove + jitter;
    ///   * model-space gravity (-Z), a flat ground plane at foot level;
    ///   * the penetration-tracking contact pass + per-node speed / up-speed caps
    ///     (this is where ragdoll.js's "fly-away" was actually fixed);
    ///   * the bone-swing orientation derivation (restDir -&gt; currentBoneDir, leaves inherit
    ///     the parent's swing).
    ///
    /// DELIBERATELY DROPPED for the live v1 (per the brief): wall/env collision, the
    /// mechanical-energy governor's ratcheting cap, and (unlike the offline baker) the shared
    /// sprawl blend + variant fan - the live plugin runs ONE physics fall per death then holds
    /// the settled pose.
    ///
    /// SPACE.  Everything here is MODEL space (the space of the Setup part AFrame origins):
    /// +Z up, unscaled. The caller seeds it from live part poses converted to model space and
    /// converts each stepped frame back to world space (see RagdollRegistry / NativeHooks).
    ///
    /// No allocation happens per step - all buffers are sized once in the constructor - so a
    /// Step()/DeriveQuats() pair is safe to run inside the UpdateParts native detour.
    /// </summary>
    internal sealed class RagdollSim {
        // ---- sim tunables that are NOT per-body (structural, carried over from ragdoll_bake.py) ----
        private const float GRAVITY = 9.8f;
        private const float NODE_RADIUS = 0.06f;
        private const int ITERATIONS = 3;
        private const int ITERATIONS_RIGID = 5;
        private const float BEND_RIGID = 1.0f;
        private const float PIVOT_LEAD = 0.18f;
        private const float BRACE_STIFF = 1.0f;

        // ---- orientation commit (see the ctor's ORIENTATION COMMIT block) ----
        //   * ORIENT_FALL_K    - the topple window, in units of sqrt(hCoM/g): how long the fall has to
        //                        run before the body is on the ground. 2.5 puts a drudge's window at
        //                        ~0.62 s, which is what its fall actually measures. Raise it and the
        //                        correction assumes a longer fall, so it grows; safe range ~2..3.
        //   * ORIENT_NAT_CAP   - hard ceiling on the seeded topple rate in units of sqrt(g/height) (the
        //                        natural pole-topple rate). 1.25 => a body can never be seeded to rotate
        //                        90 deg faster than ~0.45 s: the fall still READS. Safe range ~1..1.5.
        //   * ORIENT_SPEED_FRAC- the same ceiling expressed against the anti-fly cap: the fastest node's
        //                        seeded speed stays below this fraction of the body's own MaxSpeed. The
        //                        two ceilings are min()ed, so BOTH hold. Safe range ~0.4..0.6; never
        //                        raise it to 1 (that would hand the whole anti-fly budget to the seed).
        private const float ORIENT_FALL_K = 2.5f;
        private const float ORIENT_NAT_CAP = 1.25f;
        private const float ORIENT_SPEED_FRAC = 0.55f;
        /// <summary>Upper bound on the caller's commit scalar - a mistyped cfg cannot make the
        /// correction arbitrarily large (the rate ceilings above bound the OUTCOME regardless).</summary>
        private const float ORIENT_COMMIT_MAX = 6.0f;

        // Everything else (impulse, topple, twist, give schedule, caps, damping, friction, fall
        // length, direction bias) is PER BODY and lives in RagdollParams, chosen at seed time from
        // the creature's Setup DataID. RagdollParams.Default holds the exact values those consts
        // had, so a body with no profile falls bit-for-bit as it did before parameterization.
        private readonly RagdollParams _p;

        /// <summary>The bias angle convention: <see cref="RagdollParams.DirBiasDeg"/> is documented
        /// as model-space degrees measured FROM +Y (forward) TOWARD +X (atan2(dx, dy) — the same
        /// convention the anim-metrics extractor used), while this sim's topple angle is a standard
        /// atan2 angle in the model XY plane (0 = +X, CCW, cos/sin below). Conversion is therefore
        /// theta = DIR_BIAS_ZERO - radians(dirBiasDeg): 0° maps to +Y, 90° to +X, 180° to -Y.</summary>
        private const float DIR_BIAS_ZERO = (float)(System.Math.PI / 2.0);
        private const float DEG_TO_RAD = (float)(System.Math.PI / 180.0);

        public const float FPS = 30.0f;
        public const int SUBSTEPS = 4;                 // sim substeps per rendered frame (dt = 1/120 s)
        private const float DT = 1.0f / (FPS * SUBSTEPS);

        private const uint ROOT = 0xFFFFFFFF;

        private const byte KIND_BONE = 0, KIND_BEND = 1, KIND_WELD = 2;

        private struct Con { public int A, B; public float Rest, Stiff, T0, T1; public byte Kind; }
        private struct Brace { public int A, B; public float Rest, T0, T1; }

        private readonly int _n;
        private readonly uint[] _parent;
        private readonly float[] _pos;      // n*3, live positions (model space)
        private readonly float[] _prev;     // n*3, previous positions (verlet)
        private readonly float[] _push;     // n, per-iteration floor penetration accumulator
        private readonly Con[] _cons;
        private readonly Brace[] _braces;
        private readonly int[] _boneChild;  // n, deepest child per part
        private readonly float[] _restDir;  // n*3, rest bone direction (NaN-x marks "none")
        private readonly Quat[] _q0;        // n, rest quats (model space)
        private readonly Quat[] _swing;     // n, scratch for DeriveQuats
        private readonly bool[] _hasSwing;

        private readonly float _floorZ;
        private readonly float _braceEnd;
        private readonly float _bounce;
        private float _t;

        /// <summary>How many rendered frames of active fall a ragdoll simulates before it holds its
        /// settled pose, for a body with NO profile. The value actually used by this instance is
        /// <see cref="FallFramesParam"/> (its profile's), which the registry reads at seed time.</summary>
        public const int FallFrames = RagdollParams.DefaultFallFrames;

        /// <summary>This body's active-fall length in rendered frames (its profile's fallFrames).</summary>
        public int FallFramesParam => _p.FallFrames;

        /// <summary>Compat overload: the shipped (unprofiled) parameters.</summary>
        public RagdollSim(uint[] parent, float[] startPos, Quat[] startQuats,
                          uint seed, float direction, float floorZ)
            : this(parent, startPos, startQuats, seed, direction, floorZ, RagdollParams.Default) { }

        /// <param name="parent">Setup.ParentIndex, one entry per part (0xFFFFFFFF = root).</param>
        /// <param name="startPos">n*3 model-space part origins at the moment of death.</param>
        /// <param name="startQuats">n model-space part orientations at the moment of death.</param>
        /// <param name="seed">Deterministic per-death seed (e.g. the object id ^ a salt).</param>
        /// <param name="direction">Topple direction in the model XY plane, radians.</param>
        /// <param name="floorZ">Model-space Z of the foot/ground plane.</param>
        /// <param name="prm">This body's tuning (null =&gt; <see cref="RagdollParams.Default"/>).</param>
        /// <param name="orientCommit">How hard this death commits to <paramref name="direction"/>
        /// against its own center-of-mass bias (0 = not at all, the shipped behaviour; ~1 = the
        /// measured bias is cancelled once). Per-death, from <see cref="DeathVariety"/>; MUST be
        /// carried through the corpse handoff alongside <paramref name="direction"/>.</param>
        public RagdollSim(uint[] parent, float[] startPos, Quat[] startQuats,
                          uint seed, float direction, float floorZ, RagdollParams prm,
                          float orientCommit = 0f) {
            _p = prm ?? RagdollParams.Default;
            _n = parent.Length;
            _parent = parent;
            _pos = (float[])startPos.Clone();
            _prev = new float[_n * 3];
            _push = new float[_n];
            _q0 = (Quat[])startQuats.Clone();
            _swing = new Quat[_n];
            _hasSwing = new bool[_n];
            _floorZ = floorZ;

            // Per-body direction bias: pull the seed-derived topple direction CIRCULARLY toward the
            // profile's preferred fall direction (a body whose retail death animation always slumps
            // backward keeps doing so, while the seed still supplies the per-corpse variation).
            // Strength 0 = untouched, 1 = exactly on the bias. No PRNG draw happens here, and the
            // whole block is skipped when DirBiasDeg is null (always so for RagdollParams.Default),
            // which is what keeps the default path bit-identical to the shipped behaviour.
            if (_p.DirBiasDeg.HasValue) {
                float target = DIR_BIAS_ZERO - _p.DirBiasDeg.Value * DEG_TO_RAD;
                direction += _p.DirBiasStrength * ShortestAngleDelta(direction, target);
            }

            var rand = Mulberry32(seed);

            // rest bone dirs + deepest child (from the START pose) — used by DeriveQuats.
            _boneChild = BuildBoneChildren(_pos);
            _restDir = BuildRestDirs(_pos, _boneChild);

            // ---- seed velocities: topple (omega x r) + twist + shove + jitter ----
            float zmin = float.MaxValue, zmax = float.MinValue, cx = 0, cy = 0, cz = 0;
            for (int i = 0; i < _n; i++) {
                float z = _pos[i * 3 + 2];
                if (z < zmin) zmin = z;
                if (z > zmax) zmax = z;
                cx += _pos[i * 3]; cy += _pos[i * 3 + 1]; cz += z;
            }
            cx /= _n; cy /= _n; cz /= _n;
            float height = Math.Max(0.25f, zmax - zmin);

            float ang = direction + ((float)rand() - 0.5f) * _p.DirJitter;
            float dx = (float)Math.Cos(ang), dy = (float)Math.Sin(ang);
            float rate = Math.Min((_p.Impulse / height) * _p.ToppleGain,
                                  _p.ToppleRateCap * (float)Math.Sqrt(GRAVITY / height))
                         * (0.7f + 0.6f * (float)rand());
            float twist = _p.Twist * (rand() < 0.5 ? -1f : 1f) * (0.35f + 0.65f * (float)rand());

            // pivot: centroid of the lowest quarter (the FOOT pivot; the lead nudge comes after the
            // orientation commit below, which may turn the fall direction).
            float lowBand = zmin + 0.25f * height;
            float px = 0, py = 0; int nsel = 0;
            for (int i = 0; i < _n; i++) {
                if (_pos[i * 3 + 2] <= lowBand) { px += _pos[i * 3]; py += _pos[i * 3 + 1]; nsel++; }
            }
            if (nsel > 0) { px /= nsel; py /= nsel; } else { px = cx; py = cy; }
            float pz = zmin;

            // ================================ ORIENTATION COMMIT ================================
            // WHY. The seeded topple already points the body's top at `direction`, and `direction` is
            // already an even azimuth - yet a FRONT-HEAVY body (drudge: hunched, arms hung forward) lands
            // prone every single time. The cause is a bias the seed never accounts for: its center of
            // mass sits AHEAD of its feet, so from frame 0 gravity applies a constant forward torque
            // about the foot contact. Over the ~0.6 s the fall lasts that torque accumulates more
            // rotation than the seeded impulse does, so every heading collapses into the same face-plant.
            //
            // WHAT. Measure that bias from THIS death pose (foot pivot -> CoM, horizontal), work out how
            // much rotation gravity will steal over the fall window, and add the OPPOSITE rotation to the
            // seed as a feed-forward correction. Everything here is angular VELOCITY - the body still
            // starts standing and rotates over ~0.5-1 s, so the fall reads as a fall (this is the whole
            // difference from the rejected pre-lean, which tipped the POSE past its balance point and
            // snapped the body flat in two frames).
            //
            // HOW. Work in "topple-direction space", where a horizontal vector IS the topple (its
            // direction = where the top goes, its length = the rate; the omega vector is the same thing
            // turned 90 deg, which is exactly how ox/oy are built below):
            //     topple = rate * heading  -  wCancel * overhangDir
            // then never let the heading component drop BELOW the base rate (so a fall already headed the
            // way the body leans keeps its natural speed instead of being braked, and an opposed fall
            // gets the whole correction added). The result is capped by two independent ceilings and its
            // pivot-lead uplift is compensated out, so it cannot launch the body.
            //
            // Falls out for free: overhang ~ 0 (a balanced skeleton) => wCancel ~ 0 => untouched; commit
            // 0 (deathvariety off) => the entire block is skipped and the death is bit-for-bit the old
            // one. NO rand() DRAWS HAPPEN HERE - the give schedule below keeps its exact sequence.
            float upliftFix = 0f;
            if (orientCommit > 0f) {
                float commit = orientCommit > ORIENT_COMMIT_MAX ? ORIENT_COMMIT_MAX : orientCommit;
                float ex = cx - px, ey = cy - py;                 // foot pivot -> CoM, horizontal
                float overhang = (float)Math.Sqrt(ex * ex + ey * ey);
                float hcom = Math.Max(0.05f, cz - pz);
                if (overhang > 1e-4f) {
                    float ux = ex / overhang, uy = ey / overhang;  // the direction the body leans
                    float axx = -uy, axy = ux;                     // horizontal axis it topples about
                    // Inertia about that axis through the foot pivot, and the farthest node from the
                    // pivot (unit mass per part - the same uniform-mass model the centroid above uses).
                    float inertia = 0f, rTopSq = 0f;
                    for (int i = 0; i < _n; i++) {
                        float rx = _pos[i * 3] - px, ry = _pos[i * 3 + 1] - py, rz = _pos[i * 3 + 2] - pz;
                        float adr = axx * rx + axy * ry;
                        float rr = rx * rx + ry * ry + rz * rz;
                        inertia += rr - adr * adr;                 // |r perpendicular to the axis|^2
                        if (rr > rTopSq) rTopSq = rr;
                    }
                    if (inertia > 1e-6f) {
                        // Angular acceleration gravity applies about that axis (torque n*g*overhang).
                        float aPar = _n * GRAVITY * overhang / inertia;
                        // How long the fall has to run, and how much rotation the seed still has left
                        // after the verlet damping has eaten at it for that long: velocity is retained
                        // by Damping per SUBSTEP, i.e. e^(-beta t) per second, so a unit seeded rate
                        // buys (1 - e^(-beta*t))/beta radians of travel over the window.
                        float tFall = ORIENT_FALL_K * (float)Math.Sqrt(hcom / GRAVITY);
                        float damp = _p.Damping;
                        if (damp > 0.999999f) damp = 0.999999f; else if (damp < 1e-6f) damp = 1e-6f;
                        float beta = -(float)Math.Log(damp) * (FPS * SUBSTEPS);
                        float travel = beta > 1e-4f
                            ? (1f - (float)Math.Exp(-beta * tFall)) / beta
                            : tFall;
                        // Rotation gravity will steal over the window, converted back into the seed rate
                        // that would have produced it, times the commit scalar.
                        float wCancel = commit * (0.5f * aPar * tFall * tFall) / Math.Max(1e-4f, travel);

                        float tx = dx * rate - ux * wCancel;
                        float ty = dy * rate - uy * wCancel;
                        float along = tx * dx + ty * dy;
                        if (along < rate) { tx += (rate - along) * dx; ty += (rate - along) * dy; }

                        float mag = (float)Math.Sqrt(tx * tx + ty * ty);
                        float rTop = (float)Math.Sqrt(rTopSq);
                        // TWO ceilings, both live: the fall must stay readable (natural topple rate) and
                        // the fastest node's seeded speed must stay well inside the body's anti-fly cap.
                        float cap = Math.Min(ORIENT_NAT_CAP * (float)Math.Sqrt(GRAVITY / height),
                                             ORIENT_SPEED_FRAC * _p.MaxSpeed / Math.Max(0.2f, rTop));
                        // ...but never BELOW the rate this death would have had anyway. On a big body
                        // with a low MaxSpeed the speed ceiling can land under the profile's own topple
                        // rate; clamping to it there would make the fall slower than the shipped one,
                        // which is a regression, not a safety property. The correction may only ever add.
                        if (cap < rate) cap = rate;
                        if (mag > cap) { float sc = cap / mag; tx *= sc; ty *= sc; mag = cap; }
                        if (mag > 1e-6f) {
                            dx = tx / mag; dy = ty / mag;
                            // A faster topple about a pivot that has been nudged FORWARD lifts the whole
                            // body (the lead turns rotation into a hop of rate*PIVOT_LEAD*height). Take
                            // the increment straight back out of every node's vertical velocity so the
                            // correction buys rotation only, never altitude.
                            upliftFix = (mag - rate) * PIVOT_LEAD * height;
                            rate = mag;
                        }
                    }
                }
            }
            // ============================== end ORIENTATION COMMIT ==============================

            float ox = -dy * rate, oy = dx * rate;
            px += dx * PIVOT_LEAD * height;
            py += dy * PIVOT_LEAD * height;

            float shove = _p.LinearFrac * _p.Impulse;
            float jitter = _p.Jitter * (0.3f + _p.Impulse / _p.Impulse);
            for (int i = 0; i < _n; i++) {
                int i3 = i * 3;
                float rx = _pos[i3] - px, ry = _pos[i3 + 1] - py, rz = _pos[i3 + 2] - pz;
                float vx = oy * rz;
                float vy = -ox * rz;
                float vz = ox * ry - oy * rx;
                vx -= twist * (_pos[i3 + 1] - cy);
                vy += twist * (_pos[i3] - cx);
                vx += dx * shove + ((float)rand() - 0.5f) * jitter;
                vy += dy * shove + ((float)rand() - 0.5f) * jitter;
                vz += ((float)rand() - 0.5f) * jitter;
                vz -= upliftFix;               // 0 unless the orientation commit raised the rate
                _prev[i3] = _pos[i3] - vx * DT;
                _prev[i3 + 1] = _pos[i3 + 1] - vy * DT;
                _prev[i3 + 2] = _pos[i3 + 2] - vz * DT;
            }

            // ---- constraints + braces with the give schedule ----
            int[] depth = BuildDepths();
            int maxDepth = 1;
            for (int i = 0; i < _n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];

            _cons = BuildConstraints();
            for (int ci = 0; ci < _cons.Length; ci++) {
                ref Con c = ref _cons[ci];
                c.Rest = Dist(c.A, c.B);
                if (c.Kind == KIND_BEND) {
                    float coreness = 1.0f - (float)depth[c.A] / maxDepth;
                    c.T0 = _p.GiveMin + _p.GiveSpan * (_p.CoreBias * coreness + (1 - _p.CoreBias) * (float)rand());
                    c.T1 = c.T0 + _p.GiveRamp * (0.6f + 0.8f * (float)rand());
                }
            }
            _braces = BuildBraces(rand, depth, maxDepth);

            float end = 0f;
            for (int i = 0; i < _braces.Length; i++) if (_braces[i].T1 > end) end = _braces[i].T1;
            for (int i = 0; i < _cons.Length; i++) if (_cons[i].T1 > end) end = _cons[i].T1;
            _braceEnd = end;
            _bounce = _p.BounceMax * (float)rand() * (float)rand();
            _t = 0f;
        }

        /// <summary>Advance the simulation by one rendered frame (SUBSTEPS verlet substeps).</summary>
        public void StepFrame() {
            for (int s = 0; s < SUBSTEPS; s++) StepSub();
        }

        private void StepSub() {
            _t += DT;
            float t = _t;
            float g = GRAVITY * DT * DT;

            for (int i = 0; i < _n; i++) {
                int ix = i * 3;
                float x = _pos[ix], y = _pos[ix + 1], z = _pos[ix + 2];
                float vx = (x - _prev[ix]) * _p.Damping;
                float vy = (y - _prev[ix + 1]) * _p.Damping;
                float vz = (z - _prev[ix + 2]) * _p.Damping;
                _prev[ix] = x; _prev[ix + 1] = y; _prev[ix + 2] = z;
                _pos[ix] = x + vx;
                _pos[ix + 1] = y + vy;
                _pos[ix + 2] = z + vz - g;
                _push[i] = 0f;
            }

            bool rigid = t < _braceEnd;
            float floorMin = _floorZ + NODE_RADIUS;
            int iters = rigid ? ITERATIONS_RIGID : ITERATIONS;

            for (int it = 0; it < iters; it++) {
                for (int ci = 0; ci < _cons.Length; ci++) {
                    ref Con c = ref _cons[ci];
                    float keff = c.T1 > 0f
                        ? c.Stiff + (BEND_RIGID - c.Stiff) * GiveGain(t, c.T0, c.T1)
                        : c.Stiff;
                    SolveLink(c.A, c.B, c.Rest, keff);
                }
                if (rigid) {
                    for (int bi = 0; bi < _braces.Length; bi++) {
                        ref Brace b = ref _braces[bi];
                        float kb = BRACE_STIFF * GiveGain(t, b.T0, b.T1);
                        if (kb <= 0f) continue;
                        SolveLink(b.A, b.B, b.Rest, kb);
                    }
                }
                for (int i = 0; i < _n; i++) {
                    int iz = i * 3 + 2;
                    if (_pos[iz] < floorMin) { _push[i] += floorMin - _pos[iz]; _pos[iz] = floorMin; }
                }
            }

            // contact: friction + seeded restitution, penetration-depth corrected.
            for (int i = 0; i < _n; i++) {
                int ix = i * 3;
                if (_push[i] <= 0f && _pos[ix + 2] > floorMin + 1e-6f) continue;
                _prev[ix] = _pos[ix] - (_pos[ix] - _prev[ix]) * _p.FloorFriction;
                _prev[ix + 1] = _pos[ix + 1] - (_pos[ix + 1] - _prev[ix + 1]) * _p.FloorFriction;
                float vz = _pos[ix + 2] - _prev[ix + 2] - _push[i];
                _prev[ix + 2] = _pos[ix + 2] - (vz < 0f ? -vz * _bounce : vz);
            }

            // per-node speed / up-speed caps (the fly-away fix) + NaN scrub.
            float maxStep = _p.MaxSpeed * DT;
            float maxUp = _p.MaxUpSpeed * DT;
            for (int i = 0; i < _n; i++) {
                int ix = i * 3;
                float vx = _pos[ix] - _prev[ix];
                float vy = _pos[ix + 1] - _prev[ix + 1];
                float vz = _pos[ix + 2] - _prev[ix + 2];
                if (vz > maxUp) vz = maxUp;
                float sp = (float)Math.Sqrt(vx * vx + vy * vy + vz * vz);
                if (sp > maxStep) { float sc = maxStep / sp; vx *= sc; vy *= sc; vz *= sc; }
                _prev[ix] = _pos[ix] - vx;
                _prev[ix + 1] = _pos[ix + 1] - vy;
                _prev[ix + 2] = _pos[ix + 2] - vz;
                for (int k = 0; k < 3; k++) {
                    if (!IsFinite(_pos[ix + k])) _pos[ix + k] = IsFinite(_prev[ix + k]) ? _prev[ix + k] : 0f;
                    if (!IsFinite(_prev[ix + k])) _prev[ix + k] = _pos[ix + k];
                }
            }
        }

        private void SolveLink(int a, int b, float rest, float k) {
            int ax = a * 3, bx = b * 3;
            float dx = _pos[ax] - _pos[bx];
            float dy = _pos[ax + 1] - _pos[bx + 1];
            float dz = _pos[ax + 2] - _pos[bx + 2];
            float ln = (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
            if (ln < 1e-9f) ln = 1e-9f;
            float kk = ((ln - rest) / ln) * 0.5f * k;
            dx *= kk; dy *= kk; dz *= kk;
            _pos[ax] -= dx; _pos[ax + 1] -= dy; _pos[ax + 2] -= dz;
            _pos[bx] += dx; _pos[bx + 1] += dy; _pos[bx + 2] += dz;
        }

        /// <summary>
        /// applyRagdoll's orientation pass: each part's rest bone direction is swung to its current
        /// bone direction and that swing is composed onto the rest quat; leaves with no child of their
        /// own inherit their parent's swing. Results are written into <paramref name="outQuats"/>.
        /// </summary>
        public void DeriveQuats(Quat[] outQuats) {
            for (int i = 0; i < _n; i++) {
                _hasSwing[i] = false;
                float d0x = _restDir[i * 3];
                int c = _boneChild[i];
                if (float.IsNaN(d0x) || c < 0) continue;
                float bx = _pos[c * 3] - _pos[i * 3];
                float by = _pos[c * 3 + 1] - _pos[i * 3 + 1];
                float bz = _pos[c * 3 + 2] - _pos[i * 3 + 2];
                float l = (float)Math.Sqrt(bx * bx + by * by + bz * bz);
                if (l <= 1e-4f) continue;
                _swing[i] = QMath.FromUnitVectors(d0x, _restDir[i * 3 + 1], _restDir[i * 3 + 2],
                                                  bx / l, by / l, bz / l);
                _hasSwing[i] = true;
            }
            for (int i = 0; i < _n; i++) {
                bool has = _hasSwing[i];
                Quat s = _swing[i];
                if (!has) {
                    uint p = _parent[i];
                    if (ValidParent(p) && _hasSwing[p]) { s = _swing[p]; has = true; }
                }
                outQuats[i] = has ? QMath.Norm(QMath.Mul(s, _q0[i])) : QMath.Norm(_q0[i]);
            }
        }

        /// <summary>Current model-space origin of part <paramref name="i"/> (x,y,z into the output).</summary>
        public void GetPos(int i, out float x, out float y, out float z) {
            x = _pos[i * 3]; y = _pos[i * 3 + 1]; z = _pos[i * 3 + 2];
        }

        public int PartCount => _n;

        // ---------------------------------------------------------------- state transfer (handoff)
        //
        // The corpse-continuation handoff (RagdollRegistry) needs the EVOLVED verlet state - the live
        // positions, the previous positions (which carry velocity), and the accumulated sim time - so a
        // fresh sim built from the SAME construction inputs (parent/startPos/startQuats/seed/direction/
        // floorZ, which regenerate identical constraints + braces + give schedule) can be advanced to
        // the exact instant the creature's ragdoll had reached, then continue or hold from there. Both
        // copy in/out so neither side aliases the other's buffers across frames.

        /// <summary>Copy the live verlet state (positions, previous positions, sim clock) OUT into
        /// caller-owned buffers of length <see cref="PartCount"/>*3 (and *3). No-op-safe if a buffer is
        /// too small.</summary>
        public void ExportState(float[] posOut, float[] prevOut, out float t) {
            t = _t;
            int len = _n * 3;
            if (posOut != null && posOut.Length >= len) Array.Copy(_pos, posOut, len);
            if (prevOut != null && prevOut.Length >= len) Array.Copy(_prev, prevOut, len);
        }

        /// <summary>Overwrite this sim's live verlet state from caller buffers (the inverse of
        /// <see cref="ExportState"/>). The constraints/braces were already rebuilt identically by the
        /// constructor; this just fast-forwards the evolving state to the recorded instant.</summary>
        public void RestoreState(float[] posIn, float[] prevIn, float t) {
            int len = _n * 3;
            if (posIn != null && posIn.Length >= len) Array.Copy(posIn, _pos, len);
            if (prevIn != null && prevIn.Length >= len) Array.Copy(prevIn, _prev, len);
            _t = t;
        }

        // ------------------------------------------------------------------ builders

        private bool ValidParent(uint p) => p != ROOT && p < (uint)_n;

        private int[] BuildDepths() {
            int[] depth = new int[_n];
            for (int i = 0; i < _n; i++) {
                int cur = i, d = 0;
                for (int step = 0; step < _n; step++) {
                    uint p = _parent[cur];
                    if (!ValidParent(p) || p == (uint)cur) break;
                    cur = (int)p; d++;
                }
                depth[i] = d;
            }
            return depth;
        }

        private Con[] BuildConstraints() {
            var list = new List<Con>(_n * 2);
            for (int i = 0; i < _n; i++) {
                uint p = _parent[i];
                if (!ValidParent(p)) {
                    // orphan weld: tie a non-primary root to its nearest part in the start pose.
                    if (i != 0) {
                        int near = -1; float best = float.MaxValue;
                        for (int j = 0; j < _n; j++) {
                            if (j == i) continue;
                            float dd = Dist(i, j);
                            if (dd > 1e-4f && dd < best) { best = dd; near = j; }
                        }
                        if (near >= 0)
                            list.Add(new Con { A = i, B = near, Rest = 0, Stiff = 1f, Kind = KIND_WELD });
                    }
                    continue;
                }
                list.Add(new Con { A = i, B = (int)p, Rest = 0, Stiff = 1f, Kind = KIND_BONE });
                uint gp = _parent[p];
                if (ValidParent(gp))
                    list.Add(new Con { A = i, B = (int)gp, Rest = 0, Stiff = 0.5f, Kind = KIND_BEND });
            }
            return list.ToArray();
        }

        private Brace[] BuildBraces(Func<double> rand, int[] depth, int maxDepth) {
            var list = new List<Brace>();
            if (_n < 4) return list.ToArray();

            // a1 = lowest part; a2 = farthest from a1; a3 = most perpendicular to a1->a2.
            int a1 = 0; float zmin = float.MaxValue;
            for (int i = 0; i < _n; i++) { float z = _pos[i * 3 + 2]; if (z < zmin) { zmin = z; a1 = i; } }
            int a2 = -1; float bestLen = 0f;
            for (int i = 0; i < _n; i++) { if (i == a1) continue; float l = Dist(i, a1); if (l > bestLen) { bestLen = l; a2 = i; } }
            if (a2 < 0 || bestLen < 1e-4f) return list.ToArray();
            float vx = (_pos[a2 * 3] - _pos[a1 * 3]) / bestLen;
            float vy = (_pos[a2 * 3 + 1] - _pos[a1 * 3 + 1]) / bestLen;
            float vz = (_pos[a2 * 3 + 2] - _pos[a1 * 3 + 2]) / bestLen;
            int a3 = -1; float bestPerp = 0f;
            for (int i = 0; i < _n; i++) {
                if (i == a1 || i == a2) continue;
                float wx = _pos[i * 3] - _pos[a1 * 3];
                float wy = _pos[i * 3 + 1] - _pos[a1 * 3 + 1];
                float wz = _pos[i * 3 + 2] - _pos[a1 * 3 + 2];
                float dp = wx * vx + wy * vy + wz * vz;
                float ex = wx - dp * vx, ey = wy - dp * vy, ez = wz - dp * vz;
                float perp = (float)Math.Sqrt(ex * ex + ey * ey + ez * ez);
                if (perp > bestPerp) { bestPerp = perp; a3 = i; }
            }
            int[] anchors = (a3 >= 0 && bestPerp > 1e-3f * bestLen)
                ? new[] { a1, a2, a3 } : new[] { a1, a2 };

            for (int i = 0; i < _n; i++) {
                if (Array.IndexOf(anchors, i) >= 0) continue;
                float coreness = 1.0f - (float)depth[i] / maxDepth;
                foreach (int a in anchors) {
                    float rest = Dist(i, a);
                    if (rest <= 1e-4f) continue;
                    Window(rand, coreness, 0f, out float t0, out float t1);
                    list.Add(new Brace { A = i, B = a, Rest = rest, T0 = t0, T1 = t1 });
                }
            }
            for (int i = 0; i < anchors.Length; i++)
                for (int j = i + 1; j < anchors.Length; j++) {
                    float rest = Dist(anchors[i], anchors[j]);
                    if (rest <= 1e-4f) continue;
                    Window(rand, 1.0f, _p.GiveSpan * 0.25f, out float t0, out float t1);
                    list.Add(new Brace { A = anchors[i], B = anchors[j], Rest = rest, T0 = t0, T1 = t1 });
                }
            return list.ToArray();
        }

        private void Window(Func<double> rand, float coreness, float extraHold,
                            out float t0, out float t1) {
            t0 = _p.GiveMin + _p.GiveSpan * (_p.CoreBias * coreness + (1 - _p.CoreBias) * (float)rand()) + extraHold;
            t1 = t0 + _p.GiveRamp * (0.6f + 0.8f * (float)rand());
        }

        private int[] BuildBoneChildren(float[] pos) {
            int[] child = new int[_n];
            float[] best = new float[_n];
            for (int i = 0; i < _n; i++) child[i] = -1;
            for (int i = 0; i < _n; i++) {
                uint p = _parent[i];
                if (!ValidParent(p)) continue;
                float l = Dist(pos, i, (int)p);
                if (l > best[p]) { best[p] = l; child[p] = i; }
            }
            return child;
        }

        private float[] BuildRestDirs(float[] pos, int[] boneChild) {
            float[] rest = new float[_n * 3];
            for (int i = 0; i < _n; i++) {
                rest[i * 3] = float.NaN;   // NaN-x marks "no rest dir"
                int c = boneChild[i];
                if (c < 0) continue;
                float bx = pos[c * 3] - pos[i * 3];
                float by = pos[c * 3 + 1] - pos[i * 3 + 1];
                float bz = pos[c * 3 + 2] - pos[i * 3 + 2];
                float l = (float)Math.Sqrt(bx * bx + by * by + bz * bz);
                if (l > 1e-4f) { rest[i * 3] = bx / l; rest[i * 3 + 1] = by / l; rest[i * 3 + 2] = bz / l; }
            }
            return rest;
        }

        private static float GiveGain(float t, float t0, float t1) {
            if (!(t1 > t0)) return 0f;
            if (t <= t0) return 1f;
            if (t >= t1) return 0f;
            float u = (t1 - t) / (t1 - t0);
            return u * u * (3f - 2f * u);
        }

        private float Dist(int i, int j) => Dist(_pos, i, j);

        private static float Dist(float[] pos, int i, int j) {
            float dx = pos[i * 3] - pos[j * 3];
            float dy = pos[i * 3 + 1] - pos[j * 3 + 1];
            float dz = pos[i * 3 + 2] - pos[j * 3 + 2];
            return (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private static bool IsFinite(float v) => !float.IsNaN(v) && !float.IsInfinity(v);

        /// <summary>Signed shortest angular distance from <paramref name="from"/> to
        /// <paramref name="to"/>, wrapped into (-pi, pi] - so blending toward a bias never takes the
        /// long way round the circle.</summary>
        private static float ShortestAngleDelta(float from, float to) {
            const double TwoPi = 2.0 * Math.PI;
            double d = (double)to - from;
            d -= Math.Floor((d + Math.PI) / TwoPi) * TwoPi;
            return (float)d;
        }

        /// <summary>mulberry32, matching ragdoll_bake.py / ragdoll.js bit-for-bit.</summary>
        private static Func<double> Mulberry32(uint seed) {
            uint a = seed != 0 ? seed : 0x9E3779B9;
            return () => {
                a += 0x6D2B79F5u;
                uint t = a;
                t = (t ^ (t >> 15)) * (t | 1u);
                t ^= t + (t ^ (t >> 7)) * (t | 61u);
                return ((t ^ (t >> 14)) & 0xFFFFFFFFu) / 4294967296.0;
            };
        }
    }
}
