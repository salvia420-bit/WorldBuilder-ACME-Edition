using Microsoft.Extensions.Logging;
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace WorldBuilder.Shared.Lib.Logging {

    [ProviderAlias("File")]
    public sealed class FileLoggerProvider : ILoggerProvider {
        private readonly ConcurrentDictionary<string, FileLogger> _loggers = new(StringComparer.OrdinalIgnoreCase);
        private readonly FileLogSink _sink;

        public FileLoggerProvider(string logDirectory, long maxFileBytes = 5 * 1024 * 1024, string? appVersion = null) {
            LogDirectory = logDirectory;
            _sink = new FileLogSink(logDirectory, maxFileBytes);
            WriteSessionHeader(appVersion);
        }

        public string LogDirectory { get; }
        public string LogFilePath => Path.Combine(LogDirectory, "worldbuilder.log");
        internal Func<LogLevel> GetMinLevel { get; set; } = () => LogLevel.Information;
        internal Func<bool> GetEnabled { get; set; } = () => true;

        public Func<LogLevel> MinLevelProvider {
            get => GetMinLevel;
            set => GetMinLevel = value ?? throw new ArgumentNullException(nameof(value));
        }

        public Func<bool> EnabledProvider {
            get => GetEnabled;
            set => GetEnabled = value ?? throw new ArgumentNullException(nameof(value));
        }

        public ILogger CreateLogger(string categoryName) =>
            _loggers.GetOrAdd(categoryName, name => new FileLogger(name, this, _sink));

        public void Dispose() {
            _loggers.Clear();
            _sink.Dispose();
        }

        private void WriteSessionHeader(string? appVersion) {
            var version = !string.IsNullOrWhiteSpace(appVersion)
                ? appVersion
                : Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "unknown";
            var os = RuntimeInformation.OSDescription;
            var runtime = RuntimeInformation.FrameworkDescription;

            _sink.WriteLine("");
            _sink.WriteLine("========================================");
            _sink.WriteLine($"  ACME WorldBuilder v{version}");
            _sink.WriteLine($"  {DateTime.Now:yyyy-MM-dd HH:mm:ss}  |  {os}  |  {runtime}");
            _sink.WriteLine("========================================");
        }
    }

    internal sealed class FileLogger(string name, FileLoggerProvider provider, FileLogSink sink) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => default!;

        public bool IsEnabled(LogLevel logLevel) =>
            provider.GetEnabled() && logLevel != LogLevel.None && logLevel >= provider.GetMinLevel();

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) {

            if (!IsEnabled(logLevel)) return;

            string message = formatter(state, exception);
            string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
            string levelTag = logLevel switch {
                LogLevel.Trace => "TRC",
                LogLevel.Debug => "DBG",
                LogLevel.Information => "INF",
                LogLevel.Warning => "WRN",
                LogLevel.Error => "ERR",
                LogLevel.Critical => "CRT",
                _ => "???"
            };

            var sb = new StringBuilder();
            sb.Append('[').Append(timestamp).Append("] [").Append(levelTag).Append("] ");
            sb.Append(name).Append(" - ").Append(message);

            if (exception != null) {
                sb.AppendLine();
                sb.Append("  Exception: ").Append(exception);
            }

            sink.WriteLine(sb.ToString());
        }
    }

    /// <summary>
    /// Thread-safe file writer with single-file rotation. When the active log
    /// exceeds maxBytes the current file is renamed to .old.log (replacing any
    /// previous backup) and a fresh file starts. Worst-case disk usage ~2x maxBytes.
    /// </summary>
    internal sealed class FileLogSink : IDisposable {
        private readonly object _lock = new();
        private readonly string _logPath;
        private readonly string _oldLogPath;
        private readonly long _maxBytes;
        private StreamWriter? _writer;
        private long _currentSize;

        public FileLogSink(string logDirectory, long maxBytes) {
            _maxBytes = maxBytes;
            Directory.CreateDirectory(logDirectory);

            _logPath = Path.Combine(logDirectory, "worldbuilder.log");
            _oldLogPath = Path.Combine(logDirectory, "worldbuilder.old.log");

            OpenWriter(append: true);
        }

        public void WriteLine(string line) {
            lock (_lock) {
                try {
                    if (_writer == null) return;

                    _writer.WriteLine(line);
                    _writer.Flush();
                    _currentSize += Encoding.UTF8.GetByteCount(line) + Environment.NewLine.Length;

                    if (_currentSize >= _maxBytes) {
                        Rotate();
                    }
                }
                catch {
                    // Never let a logging failure crash the app
                }
            }
        }

        private void Rotate() {
            try {
                _writer?.Dispose();
                _writer = null;

                if (File.Exists(_oldLogPath))
                    File.Delete(_oldLogPath);

                File.Move(_logPath, _oldLogPath);
            }
            catch {
                try { File.Delete(_logPath); } catch { }
            }
            finally {
                OpenWriter(append: false);
            }
        }

        private void OpenWriter(bool append) {
            try {
                var stream = new FileStream(_logPath, append ? FileMode.Append : FileMode.Create,
                    FileAccess.Write, FileShare.Read);
                _writer = new StreamWriter(stream, Encoding.UTF8) { AutoFlush = false };
                _currentSize = stream.Length;
            }
            catch {
                _writer = null;
                _currentSize = 0;
            }
        }

        public void Dispose() {
            lock (_lock) {
                _writer?.Dispose();
                _writer = null;
            }
        }
    }
}
