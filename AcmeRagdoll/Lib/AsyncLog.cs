using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace AcmeRagdoll.Lib {
    /// <summary>
    /// PACING (2026-08-23). An off-render-thread sink for the plugin's high-frequency diagnostics.
    ///
    /// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
    /// Chorizite's own ILogger (Chorizite.Core/Logging/ChoriziteLogger.cs) does ALL of this
    /// SYNCHRONOUSLY, per line, on whatever thread calls it — which for every diagnostic in this
    /// plugin is the render thread inside a native detour:
    ///     ChoriziteStatics.HandleLogMessage(...)         // string interpolation + event fan-out
    ///     Console.Write(msg)                             // a console write per line
    ///     Directory.Exists(LogDirectory)                 // a filesystem stat per line
    ///     File.AppendAllText(logPath, msg)               // OPEN + APPEND + FLUSH + CLOSE per line
    /// An open/append/close on Windows (with an AV filter in the path) is routinely 0.5-5 ms. The
    /// worst offenders here are per-EVENT rather than periodic: the `livemotion HIT` line is one
    /// file write per landed hit per body (a group @smite is a burst of them) and the ARM /
    /// CORPSE-handoff / YIELD lines are several more per death — i.e. the writes land exactly on
    /// the frames that already have the most work to do. At 100 fps, one 1 ms stall per second
    /// IS the 1% frame.
    ///
    /// ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────
    /// Post() takes a finished string, drops it in a bounded ring under a lock held for a handful
    /// of nanoseconds, and returns. A background thread drains the ring every <see cref="FlushMs"/>
    /// ms (or immediately when woken) and appends the whole batch to Chorizite's own log.txt in ONE
    /// open/append/close, so the owner's single-file workflow and the crash story are unchanged.
    /// A crash can lose at most the last flush interval; the sink flushes on Stop() too.
    ///
    /// If the log path cannot be resolved (non-Chorizite logger), <see cref="Ready"/> stays false
    /// and Post() falls back to the synchronous ILogger — correctness over pacing, and the callers
    /// all rate-limit themselves anyway.
    ///
    /// Thread-safety: many producers (render thread + managed init thread), one consumer. The lock
    /// is uncontended in practice — the drain thread holds it only to swap the pending list.
    /// </summary>
    internal static class AsyncLog {
        private const int FlushMs = 100;      // crash loses at most this much of the story
        private const int MaxPending = 2048;  // ring cap; overflow is counted, never grows unbounded

        private static readonly object _gate = new();
        private static List<string> _pending = new(256);
        private static List<string> _draining = new(256);
        private static AutoResetEvent? _wake;
        private static Thread? _thread;
        private static volatile bool _stop;
        private static string? _path;
        private static ILogger? _fallback;
        private static int _dropped;

        /// <summary>True when the async sink owns a real file path (Post is then off-thread).</summary>
        public static bool Ready { get; private set; }

        /// <summary>Prefix that makes our lines indistinguishable from ChoriziteLogger's own, so
        /// existing `rg 'ragdoll'` / `rg 'livemotion'` workflows over log.txt keep working.</summary>
        private const string LinePrefix = "[AcmeRagdoll:Information] ";

        /// <summary>Start the sink. MUST be called from the managed plugin thread (Initialize):
        /// it starts the writer thread and does the one reflective property read. Never throws.</summary>
        public static void Start(ILogger log) {
            _fallback = log;
            if (_thread != null) return;
            try {
                string? dir = ResolveLogDirectory(log);
                if (string.IsNullOrEmpty(dir)) return;      // Ready stays false -> ILogger fallback
                Directory.CreateDirectory(dir!);
                _path = Path.Combine(dir!, "log.txt");
                _wake = new AutoResetEvent(false);
                _stop = false;
                _thread = new Thread(DrainLoop) {
                    IsBackground = true,
                    Name = "acmeragdoll-log",
                    Priority = ThreadPriority.BelowNormal,
                };
                _thread.Start();
                Ready = true;
            }
            catch {
                Ready = false;
            }
        }

        /// <summary>Flush and stop (plugin unload). Never throws.</summary>
        public static void Stop() {
            try {
                _stop = true;
                _wake?.Set();
                _thread?.Join(500);
            }
            catch { }
            try { DrainOnce(); } catch { }
            Ready = false;
            _thread = null;
        }

        /// <summary>Queue one finished line. O(1), no I/O, no formatting — the CALLER decides
        /// whether the line is worth building, so a disabled diagnostic costs nothing at all.</summary>
        public static void Post(string line) {
            if (line == null) return;
            if (!Ready) { try { _fallback?.LogInformation("{Line}", line); } catch { } return; }
            bool overflow = false;
            lock (_gate) {
                if (_pending.Count >= MaxPending) { _dropped++; overflow = true; }
                else _pending.Add(line);
            }
            if (!overflow) _wake?.Set();
        }

        /// <summary>Queue a line AND flush it promptly — for the rare line that must survive a
        /// crash that happens in the next millisecond (warnings, state transitions).</summary>
        public static void PostUrgent(string line) {
            Post(line);
            _wake?.Set();
        }

        private static void DrainLoop() {
            var wake = _wake;
            while (!_stop) {
                try { wake?.WaitOne(FlushMs); } catch { }
                try { DrainOnce(); } catch { }
            }
            try { DrainOnce(); } catch { }
        }

        /// <summary>Single-flight. The writer thread is the only normal caller, but Stop() also
        /// drains after a Join that can time out, and two concurrent drains would both own the
        /// swapped-out list. A skipped drain loses nothing: the lines stay queued for the next one.</summary>
        private static int _draining01;

        private static void DrainOnce() {
            if (Interlocked.CompareExchange(ref _draining01, 1, 0) != 0) return;
            try { DrainOnceCore(); }
            finally { Volatile.Write(ref _draining01, 0); }
        }

        private static void DrainOnceCore() {
            List<string> batch;
            int dropped;
            lock (_gate) {
                if (_pending.Count == 0 && _dropped == 0) return;
                batch = _pending;
                _pending = _draining;
                _draining = batch;
                dropped = _dropped;
                _dropped = 0;
            }
            var sb = new StringBuilder(batch.Count * 128 + 64);
            for (int i = 0; i < batch.Count; i++) {
                sb.Append(LinePrefix).Append(batch[i]).Append('\n');
            }
            if (dropped > 0)
                sb.Append(LinePrefix).Append("ragdoll: log sink dropped ").Append(dropped)
                  .Append(" lines (ring full)\n");
            batch.Clear();
            Append(sb.ToString());
        }

        /// <summary>One open/append/close for the whole batch. ChoriziteLogger opens the same file
        /// with FileShare.Read, so a collision is possible in both directions; we hold the handle
        /// for microseconds and retry a few times rather than lose the batch.</summary>
        private static void Append(string text) {
            string? path = _path;
            if (path == null || text.Length == 0) return;
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            for (int attempt = 0; attempt < 4; attempt++) {
                try {
                    using var fs = new FileStream(path, FileMode.Append, FileAccess.Write,
                                                  FileShare.ReadWrite, 4096, FileOptions.None);
                    fs.Write(bytes, 0, bytes.Length);
                    fs.Flush();
                    return;
                }
                catch (IOException) { try { Thread.Sleep(2); } catch { } }
                catch { return; }
            }
        }

        /// <summary>ChoriziteLogger exposes its log directory as a public `LogDirectory` property.
        /// Read it reflectively so this file has no compile-time dependency on the logger type
        /// (plugins are built against the Chorizite SDK, not its internals).</summary>
        private static string? ResolveLogDirectory(ILogger log) {
            try {
                var p = log.GetType().GetProperty("LogDirectory");
                if (p != null && p.PropertyType == typeof(string))
                    return p.GetValue(log) as string;
            }
            catch { }
            return null;
        }
    }
}
