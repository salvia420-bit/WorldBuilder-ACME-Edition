using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// The queue on disk.
    ///
    /// Layout under <see cref="QueueDir"/>:
    ///   redline.jsonl         one <see cref="RedlineEntry"/> per line. APPEND-ONLY, written here.
    ///   redline-status.jsonl  one <see cref="RedlineStatusEvent"/> per line. Written by the
    ///                         PIPELINE, only ever READ here (see <see cref="StatusReader"/>).
    ///   shots/                screenshot attachments, referenced from entries as "shots/&lt;name&gt;".
    ///
    /// Append-only is a contract, not a style choice: the pipeline tails redline.jsonl, so a
    /// rewrite would either replay entries or lose them. This class never opens redline.jsonl
    /// for anything but <see cref="FileMode.Append"/>, and never truncates.
    /// </summary>
    public sealed class QueueWriter {
        public const string QueueFileName = "redline.jsonl";
        public const string StatusFileName = "redline-status.jsonl";
        public const string ShotsDirName = "shots";

        private readonly ILogger _log;
        private readonly object _appendLock = new();

        /// <summary>Absolute path to the queue directory.</summary>
        public string QueueDir { get; }

        /// <summary>Absolute path to redline.jsonl.</summary>
        public string QueueFile => Path.Combine(QueueDir, QueueFileName);

        /// <summary>Absolute path to redline-status.jsonl (read-only from this side).</summary>
        public string StatusFile => Path.Combine(QueueDir, StatusFileName);

        /// <summary>Absolute path to the attachments directory.</summary>
        public string ShotsDir => Path.Combine(QueueDir, ShotsDirName);

        /// <summary>
        /// Resolve the queue directory. <paramref name="configuredDir"/> wins when non-empty;
        /// otherwise the default is &lt;plugin data directory&gt;/redline, i.e.
        /// &lt;IPluginManager.StorageDirectory&gt;/AcmeRedline/redline - "next to the plugin" in the
        /// only sense Chorizite gives a plugin a writable home
        /// (external/chorizite/Chorizite/Chorizite.Core/Plugins/AssemblyLoader/IPluginCore.cs,
        /// DataDirectory).
        /// </summary>
        public static string ResolveQueueDir(string configuredDir, string pluginDataDirectory) =>
            string.IsNullOrWhiteSpace(configuredDir)
                ? Path.Combine(pluginDataDirectory, "redline")
                : Path.GetFullPath(configuredDir);

        public QueueWriter(string queueDir, ILogger log) {
            QueueDir = queueDir;
            _log = log;
        }

        /// <summary>Create the queue directory and shots/ if they are missing. Safe to call repeatedly.</summary>
        public void EnsureDirectories() {
            Directory.CreateDirectory(QueueDir);
            Directory.CreateDirectory(ShotsDir);
        }

        /// <summary>
        /// Mint an entry id: rl-&lt;utc yyyymmdd-hhmmss&gt;-&lt;4 hex&gt;.
        /// The 4 hex chars keep two reports inside the same second distinct.
        /// </summary>
        public static string NewId(DateTime utcNow) {
            Span<byte> rnd = stackalloc byte[2];
            System.Security.Cryptography.RandomNumberGenerator.Fill(rnd);
            return $"rl-{utcNow:yyyyMMdd-HHmmss}-{rnd[0]:x2}{rnd[1]:x2}";
        }

        /// <summary>ISO8601 UTC, the form the schema's createdAt uses.</summary>
        public static string Iso8601(DateTime utcNow) =>
            utcNow.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",
                System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>
        /// Append one entry. Returns false and logs on failure - a redline that cannot be written
        /// must not take the client down.
        ///
        /// The write is a single UTF-8 line plus '\n', under a process lock, opened
        /// FileMode.Append / FileShare.ReadWrite so a pipeline reader tailing the file is never
        /// locked out.
        /// </summary>
        public bool Append(RedlineEntry entry) {
            try {
                EnsureDirectories();
                string line = RedlineJson.ToLine(entry);
                if (line.Contains('\n') || line.Contains('\r')) {
                    // Defensive: a raw newline would split one entry across two JSONL records.
                    line = line.Replace("\r", "").Replace("\n", "");
                }

                lock (_appendLock) {
                    using var fs = new FileStream(QueueFile, FileMode.Append, FileAccess.Write,
                                                  FileShare.ReadWrite);
                    using var w = new StreamWriter(fs, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                    w.Write(line);
                    w.Write('\n');
                    w.Flush();
                }
                _log.LogInformation("redline: queued {Id} -> {File}", entry.Id, QueueFile);
                return true;
            }
            catch (Exception ex) {
                _log.LogError(ex, "redline: failed to append entry {Id} to {File}", entry.Id, QueueFile);
                return false;
            }
        }

        /// <summary>
        /// Read back the entries this install has written, newest last. Used by the panel's
        /// "my reports" list. Malformed lines are skipped rather than fatal - the pipeline may be
        /// mid-append when we read.
        /// </summary>
        public List<RedlineEntry> ReadOwnEntries(int max = 200) {
            var result = new List<RedlineEntry>();
            try {
                if (!File.Exists(QueueFile)) return result;
                using var fs = new FileStream(QueueFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var r = new StreamReader(fs, Encoding.UTF8);
                string? line;
                while ((line = r.ReadLine()) is not null) {
                    if (line.Length == 0) continue;
                    try {
                        var e = System.Text.Json.JsonSerializer.Deserialize(
                            line, RedlineJsonContext.Default.RedlineEntry);
                        if (e is not null) result.Add(e);
                    }
                    catch (System.Text.Json.JsonException) {
                        // partial trailing write, or a line from a newer schema; ignore
                    }
                }
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: could not read {File}", QueueFile);
            }

            if (result.Count > max) result.RemoveRange(0, result.Count - max);
            return result;
        }

        /// <summary>
        /// Copy an already-written image into shots/ under a queue-stable name, and return the
        /// queue-relative path the entry should carry (e.g. "shots/rl-...-view.png").
        /// Returns null if the source is missing or the copy fails.
        /// </summary>
        public string? AdoptAttachment(string sourcePath, string entryId, string suffix) {
            try {
                if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath)) return null;
                EnsureDirectories();
                string ext = Path.GetExtension(sourcePath);
                if (string.IsNullOrEmpty(ext)) ext = ".png";
                string name = $"{entryId}-{suffix}{ext}";
                File.Copy(sourcePath, Path.Combine(ShotsDir, name), overwrite: false);
                return $"{ShotsDirName}/{name}";
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: could not adopt attachment {Src}", sourcePath);
                return null;
            }
        }

        /// <summary>Write raw bytes into shots/ and return the queue-relative path, or null.</summary>
        public string? WriteAttachment(byte[] bytes, string entryId, string suffix, string ext = ".png") {
            try {
                EnsureDirectories();
                string name = $"{entryId}-{suffix}{ext}";
                File.WriteAllBytes(Path.Combine(ShotsDir, name), bytes);
                return $"{ShotsDirName}/{name}";
            }
            catch (Exception ex) {
                _log.LogWarning(ex, "redline: could not write attachment {Id}-{Suffix}", entryId, suffix);
                return null;
            }
        }
    }
}
