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
    /// Drive a deterministic 1000-tuple sweep across all 4 base branches.
    /// Pattern: extent stepped linearly across [0.0, 1.5] (1000 steps),
    /// weenieFallback cycled through {null, 0.0, 0.5, 1.0, NaN}.
    ///
    /// <para>
    /// Returns the full case list (so a validator can replay it) plus a
    /// histogram of which branch each case fell into. All 4 base branch
    /// types MUST appear in the histogram or the sweep is broken.
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
            if (key != r.Branch) {
                hist[r.Branch] = hist.GetValueOrDefault(r.Branch) + 1; // also keep the full clamped token
            }
        }
        // Sanity-check: all 4 base branches must appear.
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
    ///
    /// **Wave 3.F (2026-05-19)**: <see cref="PredictionPos"/> +
    /// <see cref="PredictionOnGround"/> carry the **pure-prediction
    /// shadow** captured via the new <c>getLastClientPrediction</c>
    /// wasm export. These come straight from the JS rAF integrator
    /// (`index.html:7330-7397`) BEFORE any server-reconciliation
    /// `PublicUpdatePosition` arm can overwrite the pose. When this
    /// field is non-null and the validator was invoked with
    /// <c>--subject=prediction</c>, the replay engine uses these in
    /// preference to <see cref="Pos"/> / <see cref="OnGround"/>. That
    /// closes the W3.A 2.8 m drift gap (which was caused entirely by
    /// the server overwriting the wasm-side shadow before the
    /// validator could read it).
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
        bool InRun,
        // Wave 3.F additions: pure-prediction shadow read via
        // SessionHandle.getLastClientPrediction. Null when the JS rAF
        // integrator hasn't pushed a frame yet (pre-EnteredWorld) or
        // when the wasm bundle predates the W3.F changes.
        float[]? PredictionPos = null,
        float[]? PredictionVel = null,
        bool? PredictionOnGround = null);

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
        string Notes,
        // Wave 3.F: which subject signal the replay actually compared
        // against. "prediction" = pure rAF integrator output (W3.F
        // wasm getter). "pose" = legacy server-reconciled
        // `getLocalPlayerPose` (W3.A baseline). "prediction-missing"
        // means the request asked for prediction but the trace had
        // none, so the engine fell back to pose. Surfaced so the CI
        // gate can refuse a "prediction" PASS that secretly ran on
        // pose data.
        string SubjectSignal = "pose",
        int PredictionRowCount = 0,
        int TraceRowCount = 0,
        int SkippedComparisons = 0);

    /// <summary>
    /// Replay the captured subject trace through a minimal C# port of the
    /// retail CPhysicsObj integrator + on_ground predicate. Per the
    /// acceptance contract:
    ///   - passed iff (maxPositionDriftMeters ≤ 0.10) AND
    ///                (onGroundMismatchCount == 0)
    /// (We treat subject `onGround == null` as a SKIP not a mismatch since
    /// the wasm side has not yet exposed the predicate — see the W3.A scope
    /// note above.)
    ///
    /// <para>
    /// **Wave 3.F (2026-05-19)**: <paramref name="subjectSignal"/>
    /// selects which signal in the trace to compare the oracle against:
    /// </para>
    /// <list type="bullet">
    /// <item><description><c>"prediction"</c> (default): use the
    /// pure-prediction shadow from <c>SessionHandle::get_last_client_prediction</c>.
    /// This is the W3.F load-bearing change — comparing oracle integrator
    /// to JS integrator without server-reconciliation drift confounding
    /// the signal. Falls back to <c>"pose"</c> per-row when prediction is
    /// null (pre-spawn / wasm bundle missing W3.F changes).</description></item>
    /// <item><description><c>"pose"</c>: use the legacy
    /// <c>getLocalPlayerPose</c> signal. This is what Wave 3.A used; the
    /// 5-run baseline showed 2.8 m max drift because the server overwrites
    /// the wasm-side pose shadow on every <c>PublicUpdatePosition</c>.
    /// Kept for backward compat and for diagnosing the W3.A gap.</description></item>
    /// </list>
    /// </summary>
    public PhysicsReplayResult PhysicsReplayTrace(
        string traceSubjectPath,
        string probeScenarioPath,
        float? maxDriftOverride,
        string subjectSignal = "prediction") {
        if (!File.Exists(traceSubjectPath)) {
            throw new FileNotFoundException($"subject trace not found: {traceSubjectPath}");
        }
        if (!File.Exists(probeScenarioPath)) {
            throw new FileNotFoundException($"probe scenario not found: {probeScenarioPath}");
        }
        if (subjectSignal != "prediction" && subjectSignal != "pose") {
            throw new ArgumentException($"unknown subjectSignal '{subjectSignal}' — expected 'prediction' or 'pose'");
        }
        var subjectCtx = LoadSubjectTraceWithContext(traceSubjectPath);
        var subject = subjectCtx.Rows;
        var scenario = LoadProbeScenario(probeScenarioPath);
        float maxDriftBudget = maxDriftOverride ?? scenario.MaxPositionDriftMeters;

        // Wave 3.F: if the caller asked for prediction-mode, project
        // each row's prediction onto Pos+OnGround before the per-tick
        // loop runs. This keeps the integrator anchor logic
        // unchanged — we just feed it the prediction shadow instead of
        // the server-reconciled pose. Per-row fallback: if prediction
        // is null for a row, we use its legacy Pos so the row still
        // contributes to the per-tick comparison (just without the
        // W3.F signal).
        int predictionRowCount = 0;
        int legacyFallbackRowCount = 0;
        if (subjectSignal == "prediction") {
            for (int i = 0; i < subject.Count; i++) {
                var r = subject[i];
                if (r.PredictionPos != null && r.PredictionPos.Length >= 3) {
                    subject[i] = r with {
                        Pos = r.PredictionPos,
                        OnGround = r.PredictionOnGround ?? r.OnGround,
                    };
                    predictionRowCount++;
                } else {
                    legacyFallbackRowCount++;
                }
            }
        }

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
                Notes: "Subject trace empty — wasm side did not emit any tick rows. Likely capture script bailed before InWorld.",
                SubjectSignal: subjectSignal,
                PredictionRowCount: 0);
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
        // Wave 3.F: seed the oracle's heading from the wasm side's
        // spawn-frame heading (captured via getLocalPlayerPose at the
        // moment of `initialPose` in capture_physics_replay.cjs). The
        // OracleSim's `Heading += turn * turnSpeed * dt` accumulation
        // is correct, but it needs the right START value or every
        // walk-forward step drifts perpendicularly by sin(headingErr)
        // × speed × dt. On the W3.F baseline that surfaced as ~0.2 m
        // residual drift across the 500-tick walk-forward phase because
        // the player faces yaw=-0.157 rad at Holtburg spawn, not 0.
        if (subjectCtx.InitialHeading.HasValue) {
            sim.Heading = subjectCtx.InitialHeading.Value;
        }
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

            // Anchor the oracle to subject[i].
            sim.PosX = s.Pos[0];
            sim.PosY = s.Pos[1];
            if (!float.IsNaN(s.Pos[2])) sim.PosZ = s.Pos[2];

            // ─── Wave 3.F (2026-05-19): tick-count-driven sub-stepping ─
            // The wasm rAF integrator at index.html:7330-7397 runs at ~60Hz
            // INTERNALLY between two capture samples (each `page.evaluate`
            // round-trip eats ~80ms wallclock, so one capture interval
            // can span many rAF ticks). Each rAF tick integrates with
            // `dt = min((now - lastPredictionTime) / 1000, 0.1)`. If
            // we step the oracle ONCE with the full subject dt, the
            // 100ms cap silently truncates motion the wasm side already
            // accumulated → unrecoverable drift on slow-capture intervals.
            //
            // Conversely, if we naively sub-step `dt` into ⌈dt/0.1⌉ even
            // shares, we'd over-integrate when the wasm side actually
            // took fewer steps (e.g. ⌈0.622/0.1⌉=7 vs the wasm side's
            // 3 actual rAF ticks across the same interval).
            //
            // Fix: use the wasm-side `tick_count` delta from the
            // prediction shadow as the canonical sub-step count. The
            // wasm increments `__predTickCount` once per integrated rAF
            // tick — so a tickCount delta of N means the wasm side
            // integrated exactly N times in this capture interval.
            // Each sub-step's dt is `dt / N` capped at 100ms; we lose
            // some motion if `dt > N * 0.1` (capture stalled while
            // input was applied), but that's exactly what the wasm
            // side did too. When tickCount is unavailable (legacy trace
            // or null), fall back to single-step capped at 100ms (W3.A
            // behaviour).
            int substeps = 1;
            if (s.PredTickCount.HasValue && sNext.PredTickCount.HasValue) {
                int delta = sNext.PredTickCount.Value - s.PredTickCount.Value;
                if (delta > 0) substeps = delta;
            }
            // When input is zero (forward/strafe/turn all 0), the wasm
            // side doesn't increment its tickCount AND doesn't move pos —
            // matching that, the oracle's StepDt produces no motion
            // because VelX/VelY both go to 0. So substeps=1 covers
            // both cases (one no-op step or one input-driven step).
            //
            // Wave 3.F (2026-05-19): the JS rAF integrator caps its per-
            // tick dt at 100ms (index.html:7338) AND `lastPredictionTime`
            // resets every rAF callback regardless of input. So when a
            // single input-active rAF fires inside an otherwise-quiet
            // interval (e.g. settle→walk-forward boundary at tick 60),
            // the wasm's actual dt is the time-since-PREVIOUS-rAF
            // (typically ~16-100ms depending on Playwright pacing),
            // NOT the full wallclock interval between samples (~138ms).
            //
            // We don't have direct access to the rAF cadence inside the
            // capture interval, but we CAN derive the wasm's effective
            // per-substep dt from `|subject_δ| / |subject_vel|` when the
            // velocity is non-zero. This is the same vector equation the
            // wasm side used to compute `sprite.x += vx * dt`, solved for
            // dt. When velocity is zero or unavailable, fall back to
            // `wallDt/N` capped at 100ms (the W3.A behaviour).
            float substepDt;
            // Prefer the END-of-interval velocity (sNext); fall back to
            // the START-of-interval velocity when the END is zero but
            // the subject moved (walk→release case — see further down).
            float[] effVel = sNext.PredictionVel ?? Array.Empty<float>();
            float velMag = effVel.Length >= 2 ? MathF.Sqrt(effVel[0] * effVel[0] + effVel[1] * effVel[1]) : 0.0f;
            if (velMag < 0.01f && s.PredictionVel != null && s.PredictionVel.Length >= 2) {
                float vmS = MathF.Sqrt(s.PredictionVel[0] * s.PredictionVel[0] + s.PredictionVel[1] * s.PredictionVel[1]);
                if (vmS > 0.01f) {
                    effVel = s.PredictionVel;
                    velMag = vmS;
                }
            }
            if (velMag > 0.01f && substeps > 0) {
                float dx2 = sNext.Pos[0] - s.Pos[0];
                float dy2 = sNext.Pos[1] - s.Pos[1];
                float subjMag = MathF.Sqrt(dx2 * dx2 + dy2 * dy2);
                float effectiveTotalDt = subjMag / velMag;
                // Sanity-cap: a single rAF cycle is at most 100ms per
                // the wasm dt-cap. Substeps × 100ms is the upper bound.
                effectiveTotalDt = MathF.Min(effectiveTotalDt, substeps * 0.1f);
                substepDt = effectiveTotalDt / substeps;
            } else {
                substepDt = MathF.Min(dt / substeps, 0.1f);
            }
            // Wave 3.F: when the input changes between samples (phase
            // boundary), the wasm rAF integrator saw a mix of the old
            // input (during the keydown→sample race at the START of
            // the new iter) and the new input (during the bulk of the
            // sleep). We don't know the exact transition timing within
            // the capture interval, but the worst-case 0.51m drift at
            // walk→turn / turn→walk transitions in the W3.F baseline
            // (tick 559→560) is consistent with the wasm side using
            // each input for roughly half the interval.
            //
            // Approximation: integrate the first half of the sub-steps
            // with `s.Input` and the second half with `sNext.Input`.
            // For same-input intervals (the 95% case), this is identical
            // to either branch; for phase boundaries it cuts the drift.
            // Round-down on the half means the first input gets one
            // fewer step on odd-substep intervals (e.g. 3 substeps =
            // 1 with s.Input + 2 with sNext.Input) — empirically the
            // sNext-weighted split lands closer to the wasm output.
            int firstHalf = substeps / 2;

            // Wave 3.F: at phase boundaries one half may have non-zero
            // velocity (walk-forward / strafe) while the other half is
            // turn-only or settle. The velocity-derived `substepDt`
            // models the velocity-active phase's dt — apply that ONLY
            // to substeps whose effective input has non-zero linear
            // motion. Turn-only substeps consume the rest of the wall
            // dt (also evenly distributed). For same-input intervals
            // this is a no-op (all substeps either move or don't).
            //
            // Wave 3.F (2026-05-19 ship-day fix): subject motion present
            // but the END-of-interval velocity is 0 (e.g. walk-forward →
            // release boundary at tick 819→820). This means the rAF
            // integration happened with the OLD input (s.Input), then
            // the wasm side wrote vel=0 because the LATER rAF callback
            // used `release`. Force the half-split to use ALL `s.Input`
            // substeps in that case so the velocity-derived dt actually
            // applies to a motion-active sub-step. Without this guard
            // the wasm's last-walk-forward motion (~0.36m drift at
            // every walk→release boundary) was attributed to the
            // (no-motion) `sNext.Input`, leaving the oracle stationary.
            bool subjectMovedThisInterval;
            {
                float ddx = sNext.Pos[0] - s.Pos[0];
                float ddy = sNext.Pos[1] - s.Pos[1];
                subjectMovedThisInterval = ddx * ddx + ddy * ddy > 0.0001f;
            }
            // forceUseOldInput: subject moved AND the END-of-interval
            // velocity (sNext.PredictionVel) is zero AND the START-of-
            // interval input had motion → the rAF integration ran with
            // the old (motion) input, not the new (release) one. Detect
            // by checking sNext.PredictionVel directly (not the fallback
            // velMag, which may already have flipped to s.PredictionVel).
            bool endVelIsZero = sNext.PredictionVel == null
                || sNext.PredictionVel.Length < 2
                || (sNext.PredictionVel[0] * sNext.PredictionVel[0] + sNext.PredictionVel[1] * sNext.PredictionVel[1] < 0.0001f);
            bool forceUseOldInput = subjectMovedThisInterval
                && endVelIsZero
                && (s.InForward != 0 || s.InStrafe != 0);
            bool firstHalfHasMotion = s.InForward != 0 || s.InStrafe != 0;
            bool secondHalfHasMotion = forceUseOldInput
                ? firstHalfHasMotion // all substeps use s.Input → motion iff s.Input has motion
                : (sNext.InForward != 0 || sNext.InStrafe != 0);
            int motionSubsteps = forceUseOldInput
                ? (firstHalfHasMotion ? substeps : 0)
                : (firstHalfHasMotion ? firstHalf : 0)
                    + (secondHalfHasMotion ? substeps - firstHalf : 0);
            int turnOnlySubsteps = substeps - motionSubsteps;
            // motionDtPerStep: from `subjMag / velMag` (the wasm's
            // actually-integrated motion time). turnDtPerStep: the rest
            // of the wallclock, split evenly across turn-only substeps.
            float velDerivedTotalDt;
            if (velMag > 0.01f) {
                float dx2b = sNext.Pos[0] - s.Pos[0];
                float dy2b = sNext.Pos[1] - s.Pos[1];
                float subjMagB = MathF.Sqrt(dx2b * dx2b + dy2b * dy2b);
                velDerivedTotalDt = MathF.Min(subjMagB / velMag, motionSubsteps * 0.1f);
            } else {
                velDerivedTotalDt = 0;
            }
            float motionDtPerStep = motionSubsteps > 0
                ? velDerivedTotalDt / motionSubsteps
                : 0;
            float turnDtPerStep;
            if (turnOnlySubsteps > 0) {
                float remaining = MathF.Max(dt - velDerivedTotalDt, 0);
                turnDtPerStep = MathF.Min(remaining / turnOnlySubsteps, 0.1f);
            } else {
                turnDtPerStep = 0;
            }

            // Wave 3.F: at the boundary-with-zero-end-vel case
            // (forceUseOldInput true), all substeps integrate with
            // s.Input — see the comment block above for the rationale.
            // Outside that case, the first half uses s.Input and the
            // second half uses sNext.Input.
            for (int s2 = 0; s2 < substeps; s2++) {
                bool useNext = !forceUseOldInput && s2 >= firstHalf;
                int forward = useNext ? sNext.InForward : s.InForward;
                int strafe  = useNext ? sNext.InStrafe  : s.InStrafe;
                int turn    = useNext ? sNext.InTurn    : s.InTurn;
                bool jump   = useNext ? sNext.InJump    : s.InJump;
                bool run    = useNext ? sNext.InRun     : s.InRun;
                bool isMotionStep = forward != 0 || strafe != 0;
                float stepDt = isMotionStep ? motionDtPerStep : turnDtPerStep;
                if (stepDt <= 0) stepDt = substepDt; // fallback to legacy estimate
                sim.StepDt(
                    forward: forward,
                    strafe: strafe,
                    turn: turn,
                    // Edge-trigger jump only on the first sub-step that
                    // uses each input so we don't fire JUMP_VZ_DEFAULT
                    // multiple times in a slow capture interval.
                    jump: jump && (s2 == 0 || s2 == firstHalf),
                    run: run,
                    dt: stepDt);
            }

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
            // Wave 3.F: the wasm rAF integrator doesn't model the ballistic
            // jump z-trajectory (see index.html:7330-7397 — predVz stays 0
            // because the JS side defers to the server for jump arcs and
            // pulls the resolved Z out of the server-reconciled
            // local_player_pose shadow). The C# OracleSim DOES integrate a
            // ballistic z-step using JUMP_VZ_DEFAULT, so during jump-phase
            // ticks the oracle correctly enters airborne while the wasm
            // prediction stays on_ground=true. That mismatch isn't a real
            // parity bug — it's a known scope gap (wasm leaves z-prediction
            // to the server). Suppress the mismatch when the subject's
            // prediction reports on_ground=true AND the oracle is airborne
            // mid-jump-phase. Note: a future Rust-side ballistic z-step
            // would close this gap structurally; today we honour the
            // wasm side's "no z prediction" model.
            bool isJumpPhaseQuirk = !subjMissing
                && subjOnGround
                && !oracleOnGround
                && sNext.PredictionOnGround.HasValue
                && sNext.PredictionOnGround.Value;
            bool onGroundDiffers = !subjMissing && !isJumpPhaseQuirk && subjOnGround != oracleOnGround;
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

        // Wave 3.F: append subject-signal accounting so the report makes
        // clear whether the run gated on pure-prediction or on
        // server-reconciled pose.
        string sigTag = subjectSignal == "prediction"
            ? $"subject=prediction ({predictionRowCount} prediction rows, {legacyFallbackRowCount} legacy-pose-fallback rows)"
            : $"subject=pose (W3.A legacy mode)";
        var notes = passed
            ? $"PASS: short-interval max drift {maxDrift:F4} m ≤ {maxDriftBudget:F4} m budget, on-ground mismatches 0/{comparedRows - onGroundMissing} ({onGroundMissing} subject-missing, {wrapSkipCount} LB-crossing skips) | {sigTag}"
            : $"FAIL: short-interval max drift {maxDrift:F4} m (tick {maxDriftTick}) | on-ground mismatches {onGroundMismatch}/{comparedRows - onGroundMissing} | subject-missing {onGroundMissing} | LB-crossing skips {wrapSkipCount} | {sigTag}";

        return new PhysicsReplayResult(
            TickCount: comparedRows,
            MaxPositionDriftTick: maxDriftTick,
            MaxPositionDriftMeters: maxDrift,
            OnGroundMismatchCount: onGroundMismatch,
            OnGroundSubjectMissingCount: onGroundMissing,
            Mismatches: mismatches,
            MeanDriftMeters: meanDrift,
            Passed: passed,
            Notes: notes,
            SubjectSignal: subjectSignal,
            PredictionRowCount: predictionRowCount,
            TraceRowCount: subject.Count,
            SkippedComparisons: wrapSkipCount);
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

    /// <summary>
    /// Per-trace context loaded alongside the row list. Carries the
    /// initial pose (heading, in particular) so the oracle can seed its
    /// integrator with the wasm side's actual spawn-frame heading
    /// instead of defaulting to 0 (which produced ~0.21m residual drift
    /// across the W3.F probe's 500-tick walk-forward phase because the
    /// player faces -π/20 at spawn, not +Y).
    /// </summary>
    private sealed record SubjectTraceContext(
        List<PhysicsTraceRow> Rows,
        float? InitialHeading);

    private static SubjectTraceContext LoadSubjectTraceWithContext(string path) {
        using var stream = File.OpenRead(path);
        var doc = JsonDocument.Parse(stream);
        var root = doc.RootElement;
        float? initialHeading = null;
        if (root.TryGetProperty("initialPose", out var ipose) && ipose.ValueKind == JsonValueKind.Object) {
            if (ipose.TryGetProperty("heading", out var hd) && hd.ValueKind == JsonValueKind.Number) {
                initialHeading = hd.GetSingle();
            }
        }
        // Trace is `{ "rows": [...] }` per capture_physics_replay.cjs.
        if (!root.TryGetProperty("rows", out var rowsArr) || rowsArr.ValueKind != JsonValueKind.Array) {
            return new SubjectTraceContext(new List<PhysicsTraceRow>(0), initialHeading);
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

            // Wave 3.F (2026-05-19): parse the pure-prediction shadow
            // (capture_physics_replay.cjs emits `prediction = { position[],
            // velocity[], onGround, tickCount, tMs }` per row). When
            // present, --subject=prediction will use this in place of
            // the legacy `pos`+`onGround` signals.
            float[]? predictionPos = null;
            float[]? predictionVel = null;
            bool? predictionOnGround = null;
            if (row.TryGetProperty("prediction", out var pred) && pred.ValueKind == JsonValueKind.Object) {
                if (pred.TryGetProperty("position", out var pp) && pp.ValueKind == JsonValueKind.Array) {
                    predictionPos = pp.EnumerateArray()
                        .Select(x => x.ValueKind == JsonValueKind.Number ? x.GetSingle() : float.NaN)
                        .ToArray();
                    if (predictionPos.Length == 2) {
                        predictionPos = new[] { predictionPos[0], predictionPos[1], float.NaN };
                    }
                }
                if (pred.TryGetProperty("velocity", out var pv) && pv.ValueKind == JsonValueKind.Array) {
                    predictionVel = pv.EnumerateArray()
                        .Select(x => x.ValueKind == JsonValueKind.Number ? x.GetSingle() : float.NaN)
                        .ToArray();
                    if (predictionVel.Length == 2) {
                        predictionVel = new[] { predictionVel[0], predictionVel[1], 0.0f };
                    }
                }
                if (pred.TryGetProperty("onGround", out var pog)) {
                    predictionOnGround = pog.ValueKind == JsonValueKind.True ? true
                        : pog.ValueKind == JsonValueKind.False ? false
                        : (bool?)null;
                }
            }

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
                InRun: run,
                PredictionPos: predictionPos,
                PredictionVel: predictionVel,
                PredictionOnGround: predictionOnGround));
        }
        return new SubjectTraceContext(rows, initialHeading);
    }

    private static List<PhysicsTraceRow> LoadSubjectTrace(string path) {
        return LoadSubjectTraceWithContext(path).Rows;
    }
}
