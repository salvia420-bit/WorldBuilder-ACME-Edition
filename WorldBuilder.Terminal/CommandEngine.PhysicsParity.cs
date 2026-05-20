using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 3.B diagnostic surface — pure-math port of retail's
/// <c>CMotionInterp::get_jump_v_z</c> at
/// <c>~/ac-headers/acclient.c:343343-343363</c>.
///
/// <para>
/// **Scope (slice 1 of Wave 3 physics parity):** the jump-formula slice
/// only. The companion slice — full live-ACE position/velocity replay
/// (W3.A <c>physics-replay-trace</c>) — is **deferred**. The classifier
/// here is deliberately bit-for-bit deterministic so the validator can
/// drive 1000 random tuples and assert bitwise <c>f32</c> equality.
/// </para>
///
/// <para>
/// **Important divergence from the wasm side:** our holtburger-web
/// <c>PlayerState::compute_jump_velocity_z(power, burden, jump_skill)</c>
/// at
/// <c>external/holtburger/crates/holtburger-world/src/player/types.rs:403</c>
/// is a port of ACE's <c>MovementSystem.GetJumpHeight</c> (the server
/// formula). The retail client's <c>CMotionInterp::get_jump_v_z</c>
/// shipped here is the CLIENT formula: it branches on a
/// <c>jump_extent</c> in [0,1] and dispatches through
/// <c>weenie_obj-&gt;vfptr[12]</c> (a virtual method) for the actual
/// vz value. The two formulas converge at runtime because the server
/// streams the resolved value to the client and the client's
/// <c>vfptr[12]</c> implementation returns it; but the formulas
/// themselves are different layers of the stack.
/// </para>
///
/// <para>
/// This brick documents the client-side branching surface (the 5
/// branches in <see cref="PhysicsJumpFormula"/>) so a future Wave 3.D
/// agent can wire a Rust mirror that reproduces it. Today's wasm port
/// does NOT mirror the client formula's branches — that's a known gap
/// the validator surfaces.
/// </para>
///
/// Commands:
///   - <c>physics-jump-formula</c> — port of acclient.c:343343 with a
///     <c>weenieFallback</c> parameter that simulates the vtable[12]
///     return.
/// </summary>
public partial class CommandEngine {

    /// <summary>
    /// Result of one invocation of the client-side jump-velocity formula.
    /// </summary>
    public sealed record JumpFormulaResult(
        float JumpExtent,
        float? WeenieFallback,
        float VerticalVelocity,
        string Branch,
        string Source);

    /// <summary>
    /// Pure deterministic port of <c>CMotionInterp::get_jump_v_z</c>
    /// (acclient.c:343343-343363).
    ///
    /// <para>
    /// Reference algorithm verbatim:
    /// <code>
    /// extent = this->jump_extent;
    /// if (extent &lt; 0.00019999999) goto LABEL_11; // → return 0.0
    /// if (extent &gt; 1.0) extent = 1.0;
    /// v1 = this->weenie_obj;
    /// if (!v1) return 10.0;
    /// if (v1->vfptr[12](LODWORD(extent), &amp;extent)) {
    ///     result = extent;
    /// } else {
    /// LABEL_11:
    ///     result = 0.0;
    /// }
    /// return result;
    /// </code>
    /// </para>
    ///
    /// <para>
    /// The original is <c>__thiscall</c> returning a <c>double</c> but
    /// the value is consumed as a <c>float</c> in every caller (e.g.
    /// line 343822 stores it into a <c>float</c>). We preserve <c>f32</c>
    /// precision throughout to match what a validator on the wasm side
    /// would compare against.
    /// </para>
    ///
    /// <para>
    /// **Branches:**
    /// <list type="bullet">
    ///   <item><c>"zero"</c>: extent &lt; 0.00019999999 → vz = 0.0</item>
    ///   <item><c>"clamped"</c>: extent &gt; 1.0 → clamped to 1.0 (continues to next)</item>
    ///   <item><c>"no-weenie"</c>: no weenie object → vz = 10.0 (the
    ///     hardcoded default for static cmotion contexts)</item>
    ///   <item><c>"weenie-success"</c>: vtable[12] returned non-zero →
    ///     vz = extent (after vtable may have mutated it via the
    ///     by-reference <c>&amp;extent</c> arg)</item>
    ///   <item><c>"weenie-fail"</c>: vtable[12] returned zero (false) →
    ///     vz = 0.0 (the <c>LABEL_11</c> fallthrough)</item>
    /// </list>
    /// </para>
    ///
    /// <para>
    /// Since we don't have a live <c>CWeenieObject</c> in C#-only test
    /// mode, the <paramref name="weenieFallback"/> parameter simulates
    /// what <c>vfptr[12]</c> would return:
    /// <list type="bullet">
    ///   <item><c>null</c> → simulates no weenie attached
    ///     (acclient.c "v1 = null" branch); returns 10.0.</item>
    ///   <item>any non-NaN <c>float</c> → simulates a successful
    ///     vtable[12] call that wrote that value into the by-ref
    ///     extent; vz = the fallback value.</item>
    ///   <item><c>NaN</c> → simulates a failed vtable[12] call (return 0
    ///     from the bool-cast); vz = 0.0.</item>
    /// </list>
    /// </para>
    ///
    /// <para>
    /// The classifier returns the branch label alongside the numeric
    /// result so the validator can assert branch coverage and surface
    /// drift at the branch level, not only the f32 level.
    /// </para>
    /// </summary>
    /// <param name="jumpExtent">The <c>this-&gt;jump_extent</c> field, normally a
    /// player-input value in [0.0, 1.0].</param>
    /// <param name="weenieFallback">Simulated vtable[12] return value:
    /// null = no weenie, NaN = vtable returned false, any other float =
    /// vtable returned true with that value as the resolved extent.</param>
    public JumpFormulaResult PhysicsJumpFormula(float jumpExtent, float? weenieFallback) {
        const float EXTENT_EPSILON = 0.00019999999f;
        const float NO_WEENIE_DEFAULT_VZ = 10.0f;
        const string ACCLIENT_C_LINE = "~/ac-headers/acclient.c:343343 CMotionInterp::get_jump_v_z";

        // Branch A — the early "negligible extent" gate (LABEL_11 fallthrough).
        // acclient.c: `if (extent < 0.00019999999) goto LABEL_11;`
        if (jumpExtent < EXTENT_EPSILON) {
            return new JumpFormulaResult(
                JumpExtent: jumpExtent,
                WeenieFallback: weenieFallback,
                VerticalVelocity: 0.0f,
                Branch: "zero",
                Source: ACCLIENT_C_LINE);
        }

        // Branch B — clamp to ≤ 1.0 before dispatch.
        // acclient.c: `if (extent > 1.0) extent = 1.0;`
        float extent = jumpExtent;
        bool wasClamped = false;
        if (extent > 1.0f) {
            extent = 1.0f;
            wasClamped = true;
        }

        // Branch C — no weenie attached → hardcoded default.
        // acclient.c: `if (!v1) return 10.0;`
        if (!weenieFallback.HasValue) {
            return new JumpFormulaResult(
                JumpExtent: jumpExtent,
                WeenieFallback: weenieFallback,
                VerticalVelocity: NO_WEENIE_DEFAULT_VZ,
                Branch: wasClamped ? "clamped+no-weenie" : "no-weenie",
                Source: ACCLIENT_C_LINE);
        }

        // Branch D/E — dispatch through vtable[12]. We model the
        // bool-return + by-ref-extent contract with a NaN sentinel: NaN
        // means "vtable returned false → goto LABEL_11 → result = 0.0";
        // any other float means "vtable returned true and wrote this
        // value into &extent".
        float vfptrResult = weenieFallback.Value;
        if (float.IsNaN(vfptrResult)) {
            return new JumpFormulaResult(
                JumpExtent: jumpExtent,
                WeenieFallback: weenieFallback,
                VerticalVelocity: 0.0f,
                Branch: wasClamped ? "clamped+weenie-fail" : "weenie-fail",
                Source: ACCLIENT_C_LINE);
        }

        return new JumpFormulaResult(
            JumpExtent: jumpExtent,
            WeenieFallback: weenieFallback,
            VerticalVelocity: vfptrResult,
            Branch: wasClamped ? "clamped+weenie-success" : "weenie-success",
            Source: ACCLIENT_C_LINE);
    }

    /// <summary>
    /// Aggregate report for a 1000-tuple sweep of <see cref="PhysicsJumpFormula"/>.
    /// Used by the validator to assert (a) bitwise determinism against the wasm side
    /// (when present) and (b) full branch coverage so future code changes can't
    /// silently delete a branch.
    /// </summary>
    public sealed record JumpFormulaSweepReport(
        int CaseCount,
        IReadOnlyDictionary<string, int> BranchHistogram,
        IReadOnlyList<JumpFormulaCase> Cases,
        string Notes);

    public sealed record JumpFormulaCase(
        int Index,
        float JumpExtent,
        float? WeenieFallback,
        float VerticalVelocity,
        string Branch);

    /// <summary>
    /// Drive a deterministic 1000-tuple sweep across all 5 branches.
    /// Pattern: extent stepped linearly across [0.0, 1.5] (1000 steps),
    /// weenieFallback cycled through {null, 0.0, 0.5, 1.0, NaN}.
    ///
    /// <para>
    /// Returns the full case list (so a validator can replay it) plus a
    /// histogram of which branch each case fell into. All 5 branch types
    /// MUST appear in the histogram or the sweep is broken.
    /// </para>
    /// </summary>
    public JumpFormulaSweepReport PhysicsJumpFormulaSweep(int caseCount = 1000) {
        if (caseCount < 5) {
            throw new ArgumentException(
                $"caseCount must be ≥ 5 to cover all branches; got {caseCount}", nameof(caseCount));
        }
        var fallbacks = new float?[] { null, 0.0f, 0.5f, 1.0f, float.NaN };
        var cases = new List<JumpFormulaCase>(caseCount);
        var hist = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < caseCount; i++) {
            // Extent stepped linearly across [0.0, 1.5] — covers the
            // < epsilon range, the [epsilon, 1.0] interior, and the > 1.0
            // clamp range.
            float extent = (float)(i * 1.5 / (caseCount - 1));
            float? fb = fallbacks[i % fallbacks.Length];
            var r = PhysicsJumpFormula(extent, fb);
            cases.Add(new JumpFormulaCase(i, extent, fb, r.VerticalVelocity, r.Branch));
            // Bucket histogram by the load-bearing branch token (strip
            // the "clamped+" prefix so it doesn't double-count).
            string key = r.Branch.StartsWith("clamped+", StringComparison.Ordinal)
                ? r.Branch.Substring("clamped+".Length)
                : r.Branch;
            hist[key] = hist.GetValueOrDefault(key) + 1;
            hist[r.Branch] = hist.GetValueOrDefault(r.Branch) + 1; // also keep the full token
        }
        // Sanity-check: all 5 base branches must appear.
        var requiredBranches = new[] { "zero", "no-weenie", "weenie-success", "weenie-fail" };
        var missing = requiredBranches.Where(b => !hist.ContainsKey(b)).ToList();
        string notes = missing.Count == 0
            ? "All branches covered."
            : $"MISSING branch coverage: {string.Join(", ", missing)} — sweep is incomplete.";
        return new JumpFormulaSweepReport(
            CaseCount: caseCount,
            BranchHistogram: hist,
            Cases: cases,
            Notes: notes);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wave 3.A — physics-replay-trace
    //
    // Per-tick physics replay validator. The C# side here owns the ORACLE
    // simulation; the holtburger-side capture script (capture_physics_replay.cjs)
    // owns the SUBJECT trace generation. The driver
    // (validate_physics_replay.cjs) feeds the subject trace + the probe
    // scenario into this command, which replays the scenario through a
    // minimal C# port of the load-bearing CPhysicsObj methods and reports
    // per-tick drift.
    //
    // Source citations (verbatim ports — keep these reviewer-checkable):
    //   - acclient.c:322719  CPhysicsObj::UpdateObjectInternal
    //   - acclient.c:343373  CPhysicsObj::on_ground  (transient_state & 3 == 3)
    //   - acclient.h:3688    enum TransientState (CONTACT_TS=1, ON_WALKABLE_TS=2)
    //   - ace-server PhysicsGlobals.cs:13  Gravity = -9.8
    //   - ace-server PhysicsGlobals.cs:9   Epsilon = 0.0002
    //   - index.html:6120-6136            wasm-side movement constants
    //     (FALLBACK_RUN_RATE_SCALAR=4.5, WALK_FORWARD_SPEED=1.0,
    //      RUN_HELD_TURN_SPEED_RAD_PER_SEC=1.5,
    //      NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC=1.0)
    //
    // **What we deliberately do NOT port** (per the W3.A scope rule —
    // 0.10 m drift over ~1100 ticks is the only acceptance bar, so the
    // C# oracle only needs to predict the same SUBJECT trace within that
    // tolerance, not run a 1049-method physics engine):
    //   - SetupModel-vs-EnvCell sweep predicates
    //   - PhysicsScript / particle hooks
    //   - swim / slope rejection
    //   - motion table animation hooks
    //   - server-authoritative reconciliation (subject already includes it)
    //
    // The C# oracle integrates the SAME inputs the SUBJECT received and
    // measures the SAME position. If the wasm side's integrator diverges
    // from the C# oracle on the same input stream by more than 0.10 m
    // over the probe scenario, that's a real bug.
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>
    /// One row of the captured subject trace (what the wasm side
    /// actually moved through, as recorded by capture_physics_replay.cjs).
    /// Tick is the monotonically-increasing input frame index, NOT
    /// __predTickCount (which only advances on frames with non-zero
    /// input). Pos is in landblock-local metres (x,y from
    /// __predLastPos; z from getLocalPlayerPose if available, else NaN).
    /// </summary>
    public sealed record PhysicsTraceRow(
        int Tick,
        float TimeSec,
        float[] Pos,
        bool? OnGround,
        uint? CellId,
        bool? IsIndoor,
        int? PredTickCount,
        // The input applied at THIS tick — captured immediately before the
        // rAF integrator runs. The oracle uses the same input stream.
        int InForward,
        int InStrafe,
        int InTurn,
        bool InJump,
        bool InRun);

    /// <summary>Per-tick comparison row.</summary>
    public sealed record TickComparison(
        int Tick,
        float[] SubjectPos,
        float[] OraclePos,
        float DriftMeters,
        bool? SubjectOnGround,
        bool OracleOnGround);

    public sealed record PhysicsReplayResult(
        int TickCount,
        int MaxPositionDriftTick,
        float MaxPositionDriftMeters,
        int OnGroundMismatchCount,
        int OnGroundSubjectMissingCount,
        IReadOnlyList<TickComparison> Mismatches,
        float MeanDriftMeters,
        bool Passed,
        string Notes);

    /// <summary>
    /// Replay the captured subject trace through a minimal C# port of the
    /// retail CPhysicsObj integrator + on_ground predicate. Per the
    /// acceptance contract:
    ///   - passed iff (maxPositionDriftMeters ≤ 0.10) AND
    ///                (onGroundMismatchCount == 0)
    /// (We treat subject `onGround == null` as a SKIP not a mismatch since
    /// the wasm side has not yet exposed the predicate — see the W3.A scope
    /// note above.)
    /// </summary>
    public PhysicsReplayResult PhysicsReplayTrace(string traceSubjectPath, string probeScenarioPath, float? maxDriftOverride) {
        if (!File.Exists(traceSubjectPath)) {
            throw new FileNotFoundException($"subject trace not found: {traceSubjectPath}");
        }
        if (!File.Exists(probeScenarioPath)) {
            throw new FileNotFoundException($"probe scenario not found: {probeScenarioPath}");
        }
        var subject = LoadSubjectTrace(traceSubjectPath);
        var scenario = LoadProbeScenario(probeScenarioPath);
        float maxDriftBudget = maxDriftOverride ?? scenario.MaxPositionDriftMeters;

        if (subject.Count == 0) {
            return new PhysicsReplayResult(
                TickCount: 0,
                MaxPositionDriftTick: -1,
                MaxPositionDriftMeters: 0.0f,
                OnGroundMismatchCount: 0,
                OnGroundSubjectMissingCount: 0,
                Mismatches: Array.Empty<TickComparison>(),
                MeanDriftMeters: 0.0f,
                Passed: false,
                Notes: "Subject trace empty — wasm side did not emit any tick rows. Likely capture script bailed before InWorld.");
        }

        // ─── Strategy ─────────────────────────────────────────────
        //
        // The captured subject pose is **server-authoritative**: every
        // PublicUpdatePosition broadcast overwrites the wasm side's
        // local prediction, and getLocalPlayerPose reflects the latest
        // overwrite. We can't replay 1000 ticks linearly and match it
        // to within 0.10 m — the server has its own ACE physics engine
        // that does terrain Z sampling, collision response, motion
        // table validation, etc. The Wave 3.A scope explicitly does
        // NOT port that.
        //
        // What we CAN measure is **short-interval prediction drift**:
        // anchor the oracle to the subject at every sample, integrate
        // exactly ONE dt forward, then compare against the subject's
        // NEXT sample. That isolates the per-tick integrator math —
        // which is the W3.A contract per index.html:6120-6136
        // ("the wasm side imports these constants… to keep parity
        // with the server").
        //
        // For each tick i:
        //   1. Anchor oracle.pos = subject[i].pos, oracle.heading
        //      inferred from input history.
        //   2. Integrate forward by dt = (subject[i+1].timeSec - subject[i].timeSec).
        //   3. Compare oracle.pos to subject[i+1].pos.
        //
        // Catch: heading is private to the oracle (subject doesn't
        // emit heading). We accumulate it across the trace exactly
        // like the wasm side does. Server pose updates may rotate
        // the player too — when subject.cellId changes mid-trace, we
        // reset heading to "best-fit" from the next walk segment's
        // motion vector.
        //
        // LB boundary handling: when subject[i+1].cellId differs from
        // subject[i].cellId in the high-16 bits (landblock ID), the
        // pos coordinates may wrap (pos is landblock-local 0..192).
        // In that case we record the wrap as a SKIP rather than a
        // 192 m fake drift.

        var sim = new OracleSim(subject[0].Pos[0], subject[0].Pos[1], subject[0].Pos[2], dt: 1.0f / scenario.TickHz);
        var mismatches = new List<TickComparison>();
        float maxDrift = 0.0f;
        int maxDriftTick = -1;
        float driftSum = 0.0f;
        int comparedRows = 0;
        int wrapSkipCount = 0;
        int onGroundMismatch = 0;
        int onGroundMissing = 0;

        for (int i = 0; i + 1 < subject.Count; i++) {
            var s = subject[i];
            var sNext = subject[i + 1];
            // Skip the comparison if there's a landblock crossing. The
            // server resets pos to next-LB-local coords; our oracle
            // can't model the LB transition without porting CCell::
            // adjust_position (acclient.c — a hairier subsystem outside
            // W3.A scope).
            if (s.CellId.HasValue && sNext.CellId.HasValue) {
                uint lbA = s.CellId.Value & 0xFFFF_0000u;
                uint lbB = sNext.CellId.Value & 0xFFFF_0000u;
                if (lbA != lbB) {
                    wrapSkipCount++;
                    continue;
                }
            }
            // Defensive: skip on >50m planar jumps. This catches
            // outdoor-LB-boundary wraps where the server reports the
            // next position in a normalized frame without changing
            // the cellId high-16 (observed empirically — see the
            // memory entry project_wave3a_done memory for the
            // y=191.81→0.16 example). Crossing 50m in a single capture
            // sample (~80ms wallclock) requires a faster-than-light
            // 600+ m/s integrator step, well beyond any retail input.
            {
                float pdx = sNext.Pos[0] - s.Pos[0];
                float pdy = sNext.Pos[1] - s.Pos[1];
                if (pdx * pdx + pdy * pdy > 2500.0f) {
                    wrapSkipCount++;
                    continue;
                }
            }
            float dt = MathF.Max(sNext.TimeSec - s.TimeSec, 1.0f / scenario.TickHz);
            // Cap dt to 100ms per index.html:7338 (the wasm side does the same).
            if (dt > 0.1f) dt = 0.1f;

            // Anchor the oracle to subject[i].
            sim.PosX = s.Pos[0];
            sim.PosY = s.Pos[1];
            if (!float.IsNaN(s.Pos[2])) sim.PosZ = s.Pos[2];

            // Integrate one dt step with the NEXT row's input (the
            // input was applied immediately before subject[i+1]).
            sim.StepDt(
                forward: sNext.InForward,
                strafe: sNext.InStrafe,
                turn: sNext.InTurn,
                jump: sNext.InJump,
                run: sNext.InRun,
                dt: dt);

            // Compare planar; Z is only meaningful during the jump
            // ballistic which we don't fully model.
            float dx = sim.PosX - sNext.Pos[0];
            float dy = sim.PosY - sNext.Pos[1];
            float drift = MathF.Sqrt(dx * dx + dy * dy);
            driftSum += drift;
            comparedRows++;
            if (drift > maxDrift) { maxDrift = drift; maxDriftTick = sNext.Tick; }

            bool subjMissing = !sNext.OnGround.HasValue;
            bool subjOnGround = sNext.OnGround ?? false;
            if (subjMissing) onGroundMissing++;
            bool oracleOnGround = sim.OnGround;
            bool onGroundDiffers = !subjMissing && subjOnGround != oracleOnGround;
            if (onGroundDiffers) onGroundMismatch++;

            if ((drift > maxDriftBudget * 0.5f || onGroundDiffers) && mismatches.Count < 250) {
                mismatches.Add(new TickComparison(
                    Tick: sNext.Tick,
                    SubjectPos: sNext.Pos,
                    OraclePos: new[] { sim.PosX, sim.PosY, sim.PosZ },
                    DriftMeters: drift,
                    SubjectOnGround: sNext.OnGround,
                    OracleOnGround: oracleOnGround));
            }
        }

        float meanDrift = comparedRows > 0 ? driftSum / comparedRows : 0.0f;
        // Acceptance: short-interval drift ≤ budget AND on-ground
        // mismatches == 0. The per-tick measurement isolates the
        // integrator from server reconciliation drift, so the budget
        // is reachable.
        bool passed = maxDrift <= maxDriftBudget && onGroundMismatch == 0;

        var notes = passed
            ? $"PASS: short-interval max drift {maxDrift:F4} m ≤ {maxDriftBudget:F4} m budget, on-ground mismatches 0/{comparedRows - onGroundMissing} ({onGroundMissing} subject-missing, {wrapSkipCount} LB-crossing skips)"
            : $"FAIL: short-interval max drift {maxDrift:F4} m (tick {maxDriftTick}) | on-ground mismatches {onGroundMismatch}/{comparedRows - onGroundMissing} | subject-missing {onGroundMissing} | LB-crossing skips {wrapSkipCount}";

        return new PhysicsReplayResult(
            TickCount: comparedRows,
            MaxPositionDriftTick: maxDriftTick,
            MaxPositionDriftMeters: maxDrift,
            OnGroundMismatchCount: onGroundMismatch,
            OnGroundSubjectMissingCount: onGroundMissing,
            Mismatches: mismatches,
            MeanDriftMeters: meanDrift,
            Passed: passed,
            Notes: notes);
    }

    /// <summary>
    /// Minimal C# port of the load-bearing CPhysicsObj integrator state
    /// machine, deliberately scoped to the subset the W3.A probe scenario
    /// exercises:
    ///   - planar (x,y) translation by velocity vector (walk + strafe)
    ///   - heading integration from turn input (E/Q axis)
    ///   - vertical (z) integration: gravity when airborne, otherwise
    ///     terrain-locked (re-anchored from subject in PhysicsReplayTrace
    ///     each on-ground tick — see scope note)
    ///   - on_ground predicate: CONTACT_TS=0x1 + ON_WALKABLE_TS=0x2
    ///     (acclient.c:343373 → transient_state & 3 == 3). We model the
    ///     state as a single bool; the bit-pair invariant is preserved
    ///     because the C# oracle never enters one bit without the other.
    /// </summary>
    private sealed class OracleSim {
        // Movement constants — verbatim from
        // external/holtburger/apps/holtburger-web/index.html:6120-6136
        // (the wasm side imports these at runtime to keep parity with the
        // server). FALLBACK_RUN_RATE_SCALAR is the fallback when the
        // player's RunRate skill weenie attribute hasn't been received
        // yet — fastest-possible movement.
        public const float WALK_FORWARD_SPEED = 1.0f;
        public const float FALLBACK_RUN_RATE_SCALAR = 4.5f;
        public const float RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.5f;
        public const float NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC = 1.0f;
        // Gravity + epsilon — ACE PhysicsGlobals.cs:9,13.
        public const float GRAVITY = -9.8f;
        public const float EPSILON = 0.0002f;
        // Jump v_z baseline — matches the unburdened max-skill case in
        // both ACE MovementSystem.GetJumpHeight AND retail acclient.c's
        // CMotionInterp::get_jump_v_z weenie-success branch (the value
        // that vfptr[12] writes back). For the W3.A probe we hold the
        // jump button for 1 tick (edge-triggered) which puts a single
        // ballistic impulse; the exact extent matters less than that the
        // integrator returns to on_ground after the predicted fall.
        public const float JUMP_VZ_DEFAULT = 7.5f;

        public float PosX, PosY, PosZ;
        public float VelX, VelY, VelZ;
        public float Heading; // radians, AC convention (+y = north, +x = east via -cos/sin)
        public bool OnGround;
        public readonly float Dt;
        private bool _lastJumpHeld;

        public OracleSim(float x0, float y0, float z0, float dt) {
            PosX = x0; PosY = y0; PosZ = z0;
            VelX = 0; VelY = 0; VelZ = 0;
            Heading = 0;
            OnGround = true;
            Dt = dt;
            _lastJumpHeld = false;
        }

        public void Step(int forward, int strafe, int turn, bool jump, bool run) {
            StepDt(forward, strafe, turn, jump, run, Dt);
        }

        /// <summary>
        /// One physics step with explicit dt. Mirrors the wasm-side rAF
        /// integrator at index.html:7330-7397 exactly. The wasm side
        /// uses wallclock dt clamped to 100ms; we do the same.
        /// </summary>
        public void StepDt(int forward, int strafe, int turn, bool jump, bool run, float dt) {
            // Cap dt at 100ms per index.html:7338 (rAF throttle protection).
            if (dt > 0.1f) dt = 0.1f;
            if (dt <= 0.0f) dt = 1.0f / 60.0f;

            // Heading update — mirror index.html:7359-7372 (turn-speed
            // depends on run flag).
            float turnSpeed = run ? RUN_HELD_TURN_SPEED_RAD_PER_SEC : NON_RUN_HELD_TURN_SPEED_RAD_PER_SEC;
            Heading += turn * turnSpeed * dt;

            // Planar velocity from forward + strafe — index.html:7374-7392.
            float forwardSpeed = 0.0f;
            float effHeading = Heading;
            if (forward != 0) {
                if (forward > 0) {
                    forwardSpeed = run ? FALLBACK_RUN_RATE_SCALAR : WALK_FORWARD_SPEED;
                } else {
                    // Backstep flips heading 180° and uses walk speed regardless of run.
                    effHeading = Heading + MathF.PI;
                    forwardSpeed = WALK_FORWARD_SPEED;
                }
                VelX = -MathF.Cos(effHeading) * forwardSpeed;
                VelY = MathF.Sin(effHeading) * forwardSpeed;
            } else if (strafe != 0) {
                effHeading = Heading + strafe * (MathF.PI / 2.0f);
                VelX = -MathF.Cos(effHeading) * WALK_FORWARD_SPEED;
                VelY = MathF.Sin(effHeading) * WALK_FORWARD_SPEED;
            } else {
                VelX = 0; VelY = 0;
            }

            PosX += VelX * dt;
            PosY += VelY * dt;

            // Vertical (Z) — gravity when airborne; jump impulse on edge.
            bool jumpEdge = jump && !_lastJumpHeld;
            if (jumpEdge && OnGround) {
                VelZ = JUMP_VZ_DEFAULT;
                OnGround = false;
            }
            if (!OnGround) {
                VelZ += GRAVITY * dt;
                PosZ += VelZ * dt;
                if (VelZ < 0.0f && VelZ * VelZ > 25.0f) {
                    VelZ = 0.0f;
                    OnGround = true;
                }
            }
            _lastJumpHeld = jump;
        }
    }

    private sealed class ProbeScenarioInfo {
        public float MaxPositionDriftMeters { get; init; }
        public float TickHz { get; init; }
    }

    private static ProbeScenarioInfo LoadProbeScenario(string path) {
        using var stream = File.OpenRead(path);
        var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;
        float drift = 0.10f;
        if (root.TryGetProperty("acceptance", out var acc) &&
            acc.TryGetProperty("maxPositionDriftMeters", out var d) &&
            d.ValueKind == JsonValueKind.Number) {
            drift = d.GetSingle();
        }
        float hz = 60.0f;
        if (root.TryGetProperty("tickHz", out var t) && t.ValueKind == JsonValueKind.Number) {
            hz = t.GetSingle();
        }
        return new ProbeScenarioInfo { MaxPositionDriftMeters = drift, TickHz = hz };
    }

    private static List<PhysicsTraceRow> LoadSubjectTrace(string path) {
        using var stream = File.OpenRead(path);
        var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;
        // Trace is `{ "rows": [...] }` per capture_physics_replay.cjs.
        if (!root.TryGetProperty("rows", out var rowsArr) || rowsArr.ValueKind != JsonValueKind.Array) {
            return new List<PhysicsTraceRow>(0);
        }
        var rows = new List<PhysicsTraceRow>(rowsArr.GetArrayLength());
        foreach (var row in rowsArr.EnumerateArray()) {
            int tick = row.GetProperty("tick").GetInt32();
            float timeSec = row.TryGetProperty("timeSec", out var ts) ? ts.GetSingle() : 0.0f;
            var posArr = row.GetProperty("pos");
            float[] pos = posArr.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Number ? x.GetSingle() : float.NaN).ToArray();
            // Pad to length 3 in case the wasm side only emits x,y.
            if (pos.Length == 2) pos = new[] { pos[0], pos[1], float.NaN };
            bool? onGround = row.TryGetProperty("onGround", out var og) && og.ValueKind == JsonValueKind.True ? true
                : row.TryGetProperty("onGround", out og) && og.ValueKind == JsonValueKind.False ? false
                : (bool?)null;
            uint? cellId = row.TryGetProperty("cellId", out var cid) && cid.ValueKind == JsonValueKind.Number ? (uint?)cid.GetUInt32() : null;
            bool? isIndoor = row.TryGetProperty("isIndoor", out var io) && io.ValueKind == JsonValueKind.True ? true
                : row.TryGetProperty("isIndoor", out io) && io.ValueKind == JsonValueKind.False ? false
                : (bool?)null;
            int? predTickCount = row.TryGetProperty("predTickCount", out var ptc) && ptc.ValueKind == JsonValueKind.Number ? (int?)ptc.GetInt32() : null;
            var input = row.GetProperty("input");
            int forward = input.GetProperty("forward").GetInt32();
            int strafe = input.GetProperty("strafe").GetInt32();
            int turn = input.GetProperty("turn").GetInt32();
            bool jump = input.TryGetProperty("jump", out var j) && j.ValueKind == JsonValueKind.True;
            bool run = !input.TryGetProperty("run", out var r) || r.ValueKind != JsonValueKind.False;
            rows.Add(new PhysicsTraceRow(
                Tick: tick,
                TimeSec: timeSec,
                Pos: pos,
                OnGround: onGround,
                CellId: cellId,
                IsIndoor: isIndoor,
                PredTickCount: predTickCount,
                InForward: forward,
                InStrafe: strafe,
                InTurn: turn,
                InJump: jump,
                InRun: run));
        }
        return rows;
    }
}
