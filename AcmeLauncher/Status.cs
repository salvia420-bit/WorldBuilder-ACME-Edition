using System;
using System.IO;
using System.Text.RegularExpressions;

namespace AcmeLauncher {
    /// <summary>
    /// Reads a client's per-PID plugin log (<c>log-&lt;pid&gt;.txt</c>) into a
    /// one-glance health summary — the "green light". Grammar comes from the
    /// plugins' own lines: <c>hook installed</c>, <c>memgov probe OK</c> /
    /// <c>diet probe OK</c>, <c>diet mode=… cum=N/MMB</c>, and
    /// <c>FAULT — self-disabled</c>.
    /// </summary>
    internal static class Status {
        public enum Light { Grey, Green, Amber, Red }

        public sealed class Health {
            public Light Light = Light.Grey;
            public int HooksInstalled;
            public bool GovernorProbed;
            public bool DietProbed;
            public bool Fault;
            public int FreedMb;         // cumulative mirror MB freed by the diet
            public string Summary = "not injected";
        }

        private static readonly Regex ReDietCum = new(@"diet mode=.*cum=\d+/(\d+)MB", RegexOptions.Compiled);

        /// <summary>Resolve the Chorizite data\logs dir from the configured
        /// Chorizite folder, falling back to the reference location.</summary>
        public static string LogDir(Settings s) {
            if (!string.IsNullOrEmpty(s.ChoriziteDir)) {
                var d = Path.Combine(s.ChoriziteDir!, "data", "logs");
                if (Directory.Exists(d)) return d;
            }
            return @"C:\Games\Chorizite\data\logs";
        }

        public static string LogPath(Settings s, int pid) => Path.Combine(LogDir(s), $"log-{pid}.txt");

        /// <summary>Parse a client's log into a Health. <paramref name="injected"/>
        /// is the backbone's view (module scan); the log refines it. Reads the
        /// file share-safely (the client has it open for append).</summary>
        public static Health Read(Settings s, int pid, bool? injected) {
            var h = new Health();
            if (injected == null) { h.Light = Light.Amber; h.Summary = "running · state unknown"; return h; }
            if (injected == false) { h.Light = Light.Grey; h.Summary = "running · not injected"; return h; }

            string path = LogPath(s, pid);
            string text;
            try {
                if (!File.Exists(path)) { h.Light = Light.Amber; h.Summary = "injected · no log yet"; return h; }
                using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var sr = new StreamReader(fs);
                text = sr.ReadToEnd();
            }
            catch (Exception ex) { h.Light = Light.Amber; h.Summary = "log unreadable (" + ex.GetType().Name + ")"; return h; }

            foreach (var raw in text.Split('\n')) {
                var line = raw;
                if (line.Contains("hook installed")) h.HooksInstalled++;
                if (line.Contains("memgov probe OK")) h.GovernorProbed = true;
                if (line.Contains("diet probe OK")) h.DietProbed = true;
                if (line.Contains("FAULT")) h.Fault = true;   // "… FAULT — self-disabled"
                var m = ReDietCum.Match(line);
                if (m.Success && int.TryParse(m.Groups[1].Value, out int mb)) h.FreedMb = mb;  // last wins = latest
            }

            if (h.Fault) { h.Light = Light.Red; h.Summary = $"FAULT — a service self-disabled (hooks:{h.HooksInstalled})"; return h; }
            if (h.HooksInstalled == 0) { h.Light = Light.Amber; h.Summary = "injected · initializing…"; return h; }

            h.Light = Light.Green;
            var extra = h.FreedMb > 0 ? $" · diet freed {h.FreedMb}MB" : "";
            h.Summary = $"active · {h.HooksInstalled} hooks" +
                        (h.GovernorProbed ? " · gov" : "") + (h.DietProbed ? " · diet" : "") + extra;
            return h;
        }
    }
}
