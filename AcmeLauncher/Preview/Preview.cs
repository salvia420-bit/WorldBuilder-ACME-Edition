using System;
using System.Collections.Generic;
using System.Windows;

namespace AcmeLauncher.Preview {
    /// <summary>A live preview of one cfg's settings. The Tune tab pushes the full knob dict on
    /// every edit; the preview animates only while Start()ed and MUST drop to zero timers/CPU on
    /// Stop() (owner rule: "optional and lightweight").</summary>
    internal interface IKnobPreview {
        UIElement View { get; }
        void SetKnobs(IReadOnlyDictionary<string, string> raw);   // full cfg dict, re-pushed on any change
        void Start();   // begin animating (tab visible, pane expanded, window active)
        void Stop();    // stop all timers -> 0% CPU
    }

    /// <summary>Tiny float/bool reads from the raw cfg dict, clamped like the plugin would.</summary>
    internal static class KnobRead {
        public static float F(IReadOnlyDictionary<string, string> d, string key, float def) {
            if (d != null && d.TryGetValue(key, out var s) &&
                float.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v)) return v;
            return def;
        }
        public static bool B(IReadOnlyDictionary<string, string> d, string key, bool def) => F(d, key, def ? 1 : 0) >= 0.5f;
    }
}
