using System;
using System.Diagnostics;
using AcmeLights.Lib;

namespace AcmeLights.Services {
    /// <summary>
    /// Frame-time telemetry for the hitch gate (HANDOFF-2026-08-24-rgba-mirror-diet.md): the
    /// governor's Tier-3 crit-hold disables freelisting, so every evicted DAT object reloads from
    /// disk on next use — a plausible 1%-low / hitch regression, and 1% lows are the owner's #1
    /// gate. The rendering callback already fires every in-world frame; this records the interval
    /// between firings and emits a 5 s stats line so the 14-town gauntlet can be scored A/B
    /// (`memgov=1` vs `memgov=0`) from the log alone.
    ///
    /// Frame path cost: one QPC read, one histogram bump, a handful of compares — no allocation.
    /// The histogram is 1 ms buckets to 511 ms (512+ clamps into the top bucket); p99 is read off
    /// the histogram at emission time. An interval > 5 s is a discontinuity (portal loading screen,
    /// alt-tab pause, SmartBox::Reset re-install) — counted as a gap, never as a frame.
    ///
    /// Gated by `framelog` (default ON, independent of memgov/memlog so BOTH A/B arms report).
    /// The line carries the player's landblock so hitches attribute to towns post-hoc.
    /// </summary>
    internal static unsafe class FrameStats {
        private const int Buckets = 512;            // 1 ms buckets; top bucket = >=511 ms
        private const double GapMs = 5000.0;        // longer = discontinuity, not a frame
        private const int EmitMs = 5000;            // stats line cadence

        // SmartBox::player (CPhysicsObj*) @248; m_position.objcell_id @76 (same anchors GlowLights
        // uses, read-verified there).
        private const int SbPlayer = 248;
        private const int ObjPosCellId = 76;

        private static readonly int[] _hist = new int[Buckets];
        private static long _prevTs;                // Stopwatch.GetTimestamp of the previous frame
        private static long _lastEmitMs;

        // Current window.
        private static int _frames;
        private static double _sumMs, _maxMs;
        private static int _over33, _over100, _gaps;

        // Cumulative since boot (per-town diffs come from subtracting successive lines).
        private static long _cumFrames;
        private static long _cumOver33, _cumOver100, _cumGaps;
        private static double _cumMaxMs;

        /// <summary>Per-frame entry (rendering callback, render thread). Never throws.</summary>
        public static void OnFrame(LightsConfig cfg) {
            try {
                if (cfg.FrameLog <= 0.5f) { _prevTs = 0; return; }   // off: don't record the off-time as a gap
                long ts = Stopwatch.GetTimestamp();
                long prev = _prevTs;
                _prevTs = ts;
                if (prev != 0) {
                    double dtMs = (ts - prev) * 1000.0 / Stopwatch.Frequency;
                    if (dtMs >= GapMs) {
                        _gaps++;
                    }
                    else {
                        int b = (int)dtMs;
                        _hist[b < Buckets ? b : Buckets - 1]++;
                        _frames++;
                        _sumMs += dtMs;
                        if (dtMs > _maxMs) _maxMs = dtMs;
                        if (dtMs > 100.0) { _over100++; _over33++; }
                        else if (dtMs > 100.0 / 3.0) _over33++;
                    }
                }

                long now = Environment.TickCount64;
                if (_lastEmitMs == 0) _lastEmitMs = now;
                if (now - _lastEmitMs < EmitMs) return;
                _lastEmitMs = now;
                if (_frames > 0 || _gaps > 0) Emit();
            }
            catch { /* never unwind into the client */ }
        }

        private static void Emit() {
            int p99 = Percentile(99);
            _cumFrames += _frames;
            _cumOver33 += _over33;
            _cumOver100 += _over100;
            _cumGaps += _gaps;
            if (_maxMs > _cumMaxMs) _cumMaxMs = _maxMs;
            double avg = _frames > 0 ? _sumMs / _frames : 0.0;

            var sb = new System.Text.StringBuilder(200);
            sb.Append("acmelights: frametime lb=0x").Append((CurrentCellId() >> 16).ToString("X4"))
              .Append(" n=").Append(_frames)
              .Append(" avg=").Append(avg.ToString("F1")).Append("ms")
              .Append(" p99=").Append(p99).Append("ms")
              .Append(" max=").Append(_maxMs.ToString("F1")).Append("ms")
              .Append(" >33ms=").Append(_over33)
              .Append(" >100ms=").Append(_over100);
            if (_gaps > 0) sb.Append(" gaps=").Append(_gaps);
            sb.Append(" | cum n=").Append(_cumFrames)
              .Append(" >33ms=").Append(_cumOver33)
              .Append(" >100ms=").Append(_cumOver100)
              .Append(" worst=").Append(_cumMaxMs.ToString("F0")).Append("ms");
            if (_cumGaps > 0) sb.Append(" gaps=").Append(_cumGaps);
            // Off-render-thread sink — the synchronous ChoriziteLogger's per-line open/append/close
            // would inject the exact hitch class this line exists to measure.
            AsyncLog.Post(sb.ToString());

            Array.Clear(_hist, 0, Buckets);
            _frames = 0; _sumMs = 0; _maxMs = 0;
            _over33 = 0; _over100 = 0; _gaps = 0;
        }

        /// <summary>Smallest bucket (ms) whose cumulative count covers p% of the window's frames.</summary>
        private static int Percentile(int p) {
            if (_frames == 0) return 0;
            long target = (_frames * (long)p + 99) / 100;
            long acc = 0;
            for (int i = 0; i < Buckets; i++) {
                acc += _hist[i];
                if (acc >= target) return i;
            }
            return Buckets - 1;
        }

        private static uint CurrentCellId() {
            try {
                ACBindings.Internal.SmartBox** pp = ACBindings.Internal.SmartBox.smartbox;
                if (pp == null || *pp == null) return 0;
                byte* player = *(byte**)((byte*)(*pp) + SbPlayer);
                return player != null ? *(uint*)(player + ObjPosCellId) : 0u;
            }
            catch { return 0; }
        }
    }
}
