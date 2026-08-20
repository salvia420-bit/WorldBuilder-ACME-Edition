using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// Read-only view of &lt;queueDir&gt;/redline-status.jsonl.
    ///
    /// The plugin NEVER writes this file. It is produced by the redline pipeline
    /// (tools/dat-patch/redline/, a separate agent's work) as it works the queue. The plugin folds
    /// it into the "my reports" list and the status-tint overlay mode.
    ///
    /// Semantics: append-only event log, last event per id wins. Read with
    /// FileShare.ReadWrite so a concurrent pipeline append is never blocked, and a partial
    /// trailing line is skipped rather than treated as corruption.
    /// </summary>
    public sealed class StatusReader {
        private readonly QueueWriter _queue;
        private readonly ILogger _log;

        private readonly Dictionary<string, RedlineStatusEvent> _latest = [];
        private DateTime _lastWriteUtc = DateTime.MinValue;
        private long _lastLength = -1;

        public StatusReader(QueueWriter queue, ILogger log) {
            _queue = queue;
            _log = log;
        }

        /// <summary>Latest known state for an entry id, or null when the pipeline has said nothing yet.</summary>
        public RedlineStatusEvent? For(string entryId) =>
            _latest.TryGetValue(entryId, out var e) ? e : null;

        /// <summary>Latest state string for an entry, defaulting to "queued".</summary>
        public string StateFor(string entryId) => For(entryId)?.State ?? RedlineStatus.Queued;

        /// <summary>All known states, keyed by entry id.</summary>
        public IReadOnlyDictionary<string, RedlineStatusEvent> All => _latest;

        /// <summary>How many entries sit in each state. Drives the overlay legend.</summary>
        public Dictionary<string, int> CountsByState() {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var e in _latest.Values) {
                string key = e.State;
                counts[key] = counts.TryGetValue(key, out var n) ? n + 1 : 1;
            }
            return counts;
        }

        /// <summary>
        /// Re-read the status file if it changed since last time. Cheap to call on a UI open or a
        /// timer; it stats the file first and only re-parses when length or mtime moved.
        /// </summary>
        public void Refresh(bool force = false) {
            try {
                var fi = new FileInfo(_queue.StatusFile);
                if (!fi.Exists) {
                    if (_latest.Count > 0) _latest.Clear();
                    return;
                }
                if (!force && fi.Length == _lastLength && fi.LastWriteTimeUtc == _lastWriteUtc) return;

                _lastLength = fi.Length;
                _lastWriteUtc = fi.LastWriteTimeUtc;
                _latest.Clear();

                using var fs = new FileStream(_queue.StatusFile, FileMode.Open, FileAccess.Read,
                                              FileShare.ReadWrite);
                using var r = new StreamReader(fs, Encoding.UTF8);
                string? line;
                while ((line = r.ReadLine()) is not null) {
                    if (line.Length == 0) continue;
                    var ev = RedlineJson.StatusFromLine(line);
                    if (ev is null || string.IsNullOrEmpty(ev.EntryId)) continue;
                    _latest[ev.EntryId] = ev;   // last one wins
                }
            }
            catch (Exception ex) {
                _log.LogDebug(ex, "redline: could not read {File}", _queue.StatusFile);
            }
        }
    }
}
