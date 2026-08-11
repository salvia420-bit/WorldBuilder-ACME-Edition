using System;
using System.Globalization;
using System.IO;
using System.Text;
using Chorizite.Core.Backend;
using Chorizite.Core.Backend.Client;
using Chorizite.Core.Net;
using Chorizite.Core.Plugins;
using Chorizite.Core.Plugins.AssemblyLoader;
using Microsoft.Extensions.Logging;

namespace MoveOracle;

/// <summary>
/// MoveOracle — per-frame retail movement telemetry for the holtburger parity
/// oracle.
///
/// <para>WHY THIS EXISTS. The pcap oracle (`pcap2jsonl`) already gives retail
/// ground truth, but only at the rate the client chooses to talk: the c2s
/// AutonomousPosition heartbeat measures at a median interval of ~1058 ms.
/// That is enough to pin a steady-state speed (retail run measured at
/// 7.40 m/s) and nothing else — a ~1 s jump arc falls entirely between two
/// samples, and every reported z is ground level, so `jump_apex` reads 0.00.
/// Accel ramps have the same problem. The only way to resolve those is to
/// sample inside the client process, once per frame, which is what this
/// does.</para>
///
/// <para>WHAT IT READS. Everything comes straight off retail's own structures
/// through ACBindings, so there is no reinterpretation layer to be wrong:
/// <list type="bullet">
/// <item><c>CPhysicsObj.player_object</c> (static at 0x00844D68) — position,
/// <c>m_velocityVector</c>, <c>m_omegaVector</c>, state flags.</item>
/// <item><c>movement_manager->motion_interpreter</c> (<c>CMotionInterp</c>) —
/// <c>raw_state</c> (hold keys), <c>interpreted_state</c>,
/// <c>my_run_rate</c>, <c>current_speed_factor</c>,
/// <c>standing_longjump</c>, <c>jump_extent</c>.</item>
/// <item><c>script_manager</c> / <c>physics_script_table</c> — the emitter
/// census on PlayScript, which answers "which emitters are actually alive on
/// the caster".</item>
/// </list></para>
///
/// <para>OUTPUT. One JSON object per line, in the same shape
/// `pcap2jsonl` emits and `harness/oracle-diff.mjs` consumes, tagged
/// <c>"source":"retail-plugin"</c> so the differ can tell the two retail
/// sources apart. Written to <c>%TEMP%\moveoracle\</c> by default; override
/// with the <c>MOVEORACLE_OUT</c> environment variable.</para>
///
/// <para>STATUS. Builds against Chorizite's net8.0 plugin contract. Whether it
/// can be INJECTED under Wine is a separate question from whether it is
/// correct — see docs/reengineering/impl/task-ORACLE-report.md for the
/// injection status. The plugin is written to be useful the day it runs on a
/// Windows host regardless.</para>
/// </summary>
public class MoveOraclePlugin : IPluginCore
{
    private readonly IClientBackend _client;
    private readonly IChoriziteBackend _backend;
    private readonly ILogger _log;

    private StreamWriter? _writer;
    private string? _outPath;
    private long _frame;
    private double _epochMs;
    private bool _sampling;

    /// <summary>
    /// Sample every Nth frame. 1 = every frame (~60 Hz). Even 1 is cheap
    /// relative to the render pass, and undersampling is exactly the defect
    /// this plugin exists to remove, so the default is 1.
    /// </summary>
    private int _decimate = 1;

    /// <remarks>
    /// Chorizite resolves constructor parameters from its Autofac container
    /// and sorts constructors longest-first. Per <see cref="IPluginCore"/>'s
    /// own contract, initialization belongs in <see cref="Initialize"/> — at
    /// construction time the plugin's state/settings/views are not ready yet.
    /// </remarks>
    protected MoveOraclePlugin(
        AssemblyPluginManifest manifest,
        IChoriziteBackend backend,
        IClientBackend client,
        ILogger log)
        : base(manifest)
    {
        _backend = backend;
        _client = client;
        _log = log;
    }

    protected override void Initialize()
    {
        var dir = Environment.GetEnvironmentVariable("MOVEORACLE_OUT")
                  ?? Path.Combine(Path.GetTempPath(), "moveoracle");
        Directory.CreateDirectory(dir);
        _outPath = Path.Combine(dir, $"retail-{DateTime.UtcNow:yyyyMMdd-HHmmss}.jsonl");
        // AutoFlush: a capture run is routinely ended by killing the client
        // (or by the client crashing), and a buffered tail would take the most
        // interesting part of the run with it.
        _writer = new StreamWriter(_outPath, append: false) { AutoFlush = true };
        _log.LogInformation("MoveOracle writing {path}", _outPath);

        if (_backend.Renderer is not null)
        {
            _backend.Renderer.OnRender3D += OnFrame;
        }
        else
        {
            _log.LogWarning("MoveOracle: no renderer; per-frame sampling disabled");
        }

        _client.OnC2SData += OnC2S;
        _client.OnS2CData += OnS2C;
    }

    protected override void Dispose()
    {
        if (_backend.Renderer is not null) _backend.Renderer.OnRender3D -= OnFrame;
        _client.OnC2SData -= OnC2S;
        _client.OnS2CData -= OnS2C;
        _writer?.Flush();
        _writer?.Dispose();
        _writer = null;
    }

    // ----------------------------------------------------------------------

    private double NowMs()
    {
        // Monotonic; the differ re-bases to the first-motion edge, so only the
        // deltas matter and a wall-clock adjustment mid-capture cannot skew it.
        var ms = (double)System.Diagnostics.Stopwatch.GetTimestamp()
                 / System.Diagnostics.Stopwatch.Frequency * 1000.0;
        if (_epochMs == 0) _epochMs = ms;
        return ms - _epochMs;
    }

    private unsafe void OnFrame(object? sender, EventArgs e)
    {
        _frame++;
        if (_decimate > 1 && (_frame % _decimate) != 0) return;

        try
        {
            var player = *ACBindings.Internal.CPhysicsObj.player_object;
            if (player == null) return; // not in world yet

            var pos = player->m_position;
            var vel = player->m_velocityVector;
            var omega = player->m_omegaVector;

            var sb = new StringBuilder(512);
            sb.Append('{');
            Field(sb, "source", "retail-plugin");
            sb.Append(',');
            Num(sb, "t", NowMs());
            sb.Append(',');
            Num(sb, "frame", _frame);
            sb.Append(',');

            // Position: retail's Position is objcell_id + a Frame whose
            // m_origin is landblock-local, which is exactly what the wire
            // carries, so the two retail sources agree without conversion.
            sb.Append("\"pos\":{");
            sb.Append("\"lb\":\"0x").Append(pos.objcell_id.ToString("X8")).Append("\",");
            Num(sb, "x", pos.frame.m_fOrigin.BaseClass_Vector3.x);
            sb.Append(',');
            Num(sb, "y", pos.frame.m_fOrigin.BaseClass_Vector3.y);
            sb.Append(',');
            Num(sb, "z", pos.frame.m_fOrigin.BaseClass_Vector3.z);
            sb.Append(',');
            Num(sb, "heading_deg", HeadingDeg(pos.frame));
            sb.Append("},");

            sb.Append("\"vel\":{");
            Num(sb, "x", vel.BaseClass_Vector3.x);
            sb.Append(',');
            Num(sb, "y", vel.BaseClass_Vector3.y);
            sb.Append(',');
            Num(sb, "z", vel.BaseClass_Vector3.z);
            sb.Append("},");
            Num(sb, "speed", Math.Sqrt(vel.BaseClass_Vector3.x * vel.BaseClass_Vector3.x + vel.BaseClass_Vector3.y * vel.BaseClass_Vector3.y));
            sb.Append(',');
            sb.Append("\"omega\":{");
            Num(sb, "x", omega.BaseClass_Vector3.x);
            sb.Append(',');
            Num(sb, "y", omega.BaseClass_Vector3.y);
            sb.Append(',');
            Num(sb, "z", omega.BaseClass_Vector3.z);
            sb.Append("},");

            // PhysicsState bit 0x1 is GRAVITY; contact/airborne live in
            // transient_state. Emit both raw so the differ never has to guess
            // which bit meant what.
            Num(sb, "state", player->state);
            sb.Append(',');
            Num(sb, "transient_state", player->transient_state);

            var mm = player->movement_manager;
            if (mm != null && mm->motion_interpreter != null)
            {
                var mi = mm->motion_interpreter;
                sb.Append(",\"movement\":{");
                Num(sb, "run_rate", mi->my_run_rate);
                sb.Append(',');
                Num(sb, "speed_factor", mi->current_speed_factor);
                sb.Append(',');
                Num(sb, "standing_longjump", mi->standing_longjump);
                sb.Append(',');
                Num(sb, "jump_extent", mi->jump_extent);
                sb.Append(',');
                Num(sb, "server_action_stamp", mi->server_action_stamp);
                sb.Append(',');

                // raw_state: the hold-key truth. This is the field MOVE-F2 was
                // about, and the whole reason a per-frame retail sample is
                // worth having — the wire never carries it continuously.
                var raw = mi->raw_state;
                sb.Append("\"raw\":{");
                Num(sb, "current_holdkey", (uint)raw.current_holdkey);
                sb.Append(',');
                Num(sb, "forward_command", raw.forward_command);
                sb.Append(',');
                Num(sb, "forward_speed", raw.forward_speed);
                sb.Append(',');
                Num(sb, "forward_holdkey", (uint)raw.forward_holdkey);
                sb.Append(',');
                Num(sb, "sidestep_command", raw.sidestep_command);
                sb.Append(',');
                Num(sb, "sidestep_speed", raw.sidestep_speed);
                sb.Append(',');
                Num(sb, "turn_command", raw.turn_command);
                sb.Append(',');
                Num(sb, "turn_speed", raw.turn_speed);
                sb.Append("},");

                var interp = mi->interpreted_state;
                sb.Append("\"interpreted\":{");
                Num(sb, "current_style", interp.current_style);
                sb.Append(',');
                Num(sb, "forward_command", interp.forward_command);
                sb.Append(',');
                Num(sb, "forward_speed", interp.forward_speed);
                sb.Append(',');
                Num(sb, "sidestep_command", interp.sidestep_command);
                sb.Append(',');
                Num(sb, "sidestep_speed", interp.sidestep_speed);
                sb.Append(',');
                Num(sb, "turn_command", interp.turn_command);
                sb.Append(',');
                Num(sb, "turn_speed", interp.turn_speed);
                sb.Append('}');
                sb.Append('}');
            }

            // Emitter census: how many scripts/emitters are actually live on
            // the player. Cheap enough per frame and it is the direct answer
            // to "which emitters are alive on the caster".
            sb.Append(",\"fx\":{");
            Num(sb, "script_manager", player->script_manager != null ? 1 : 0);
            sb.Append(',');
            Num(sb, "default_script", (uint)player->default_script);
            sb.Append(',');
            Num(sb, "default_script_intensity", player->default_script_intensity);
            sb.Append('}');

            sb.Append('}');
            _writer?.WriteLine(sb.ToString());
            _sampling = true;
        }
        catch (Exception ex)
        {
            // A telemetry plugin must never take the client down. Log once and
            // disable rather than throwing every frame.
            _log.LogError(ex, "MoveOracle frame sample failed; disabling per-frame sampling");
            if (_backend.Renderer is not null) _backend.Renderer.OnRender3D -= OnFrame;
        }
    }

    private static float HeadingDeg(ACBindings.Internal.Frame frame)
    {
        // Retail's heading convention: 0 = north, increasing clockwise, taken
        // from the quaternion's z/w terms. Mirrors Quaternion::to_heading on
        // the holtburger side so the two are directly comparable.
        // Frame stores the orientation as loose quaternion components
        // (qw,qx,qy,qz), not a nested vector type.
        var rad = 2.0 * Math.Atan2(frame.qz, frame.qw);
        var deg = rad * 180.0 / Math.PI;
        deg = (450.0 - deg) % 360.0;
        if (deg < 0) deg += 360.0;
        return (float)deg;
    }

    private void OnC2S(object? sender, PacketDataEventArgs e) => LogWire("c2s", e);

    private void OnS2C(object? sender, PacketDataEventArgs e) => LogWire("s2c", e);

    /// <summary>
    /// Wire tap. Deliberately records only the opcode + length + direction:
    /// the full decode already exists in `pcap2jsonl`, and duplicating it
    /// here would be a second implementation to keep in sync. What this adds
    /// is the CORRELATION — the wire event stamped on the same monotonic
    /// clock as the per-frame samples, so a PlayScript can be located exactly
    /// within the movement curve.
    /// </summary>
    private void LogWire(string dir, PacketDataEventArgs e)
    {
        try
        {
            var data = e.Data;
            if (data is null || data.Length < 4) return;
            uint opcode = BitConverter.ToUInt32(data, 0);
            var sb = new StringBuilder(160);
            sb.Append('{');
            Field(sb, "source", "retail-plugin");
            sb.Append(',');
            Field(sb, "kind", "wire");
            sb.Append(',');
            Field(sb, "dir", dir);
            sb.Append(',');
            Num(sb, "t", NowMs());
            sb.Append(',');
            sb.Append("\"opcode\":\"0x").Append(opcode.ToString("X4")).Append("\",");
            Num(sb, "len", data.Length);
            sb.Append('}');
            _writer?.WriteLine(sb.ToString());
        }
        catch
        {
            // Never let a malformed packet kill the tap.
        }
    }

    // Invariant-culture writers: a de-DE host would otherwise emit "1,25" and
    // produce a JSONL file that parses into silent nonsense.
    private static void Num(StringBuilder sb, string k, double v)
    {
        sb.Append('"').Append(k).Append("\":");
        if (double.IsNaN(v) || double.IsInfinity(v)) sb.Append("null");
        else sb.Append(v.ToString("R", CultureInfo.InvariantCulture));
    }

    private static void Field(StringBuilder sb, string k, string v)
        => sb.Append('"').Append(k).Append("\":\"").Append(v).Append('"');
}
