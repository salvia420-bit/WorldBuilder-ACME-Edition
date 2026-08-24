using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;

namespace AcmeLauncher.Preview {
    /// <summary>
    /// The shared preview pane (design §1.1): ONE pane docked beside the Tune knob list, hosting
    /// the active <see cref="IKnobPreview"/> for the cfg being tuned. Auto-follows the cfg of the
    /// last-touched knob (and the active inner cfg tab); a manual pick in the dropdown pins a
    /// domain until the next cross-cfg knob touch.
    ///
    /// Lifecycle (§1.1 rule 2): the active preview is Start()ed only while the Tune tab is loaded
    /// AND the pane is expanded AND the pause toggle is off AND the window is active; every other
    /// transition Stop()s it (previews guarantee 0 timers / 0 CPU on Stop, and both DrawingVisual
    /// and WriteableBitmap hold their last frame, so "stopped" reads as a freeze-frame, not a
    /// blank). Expanded/collapsed persists in <see cref="Settings.PreviewExpanded"/> and widens
    /// the window 720 → ~1080 (rule 5).
    /// </summary>
    internal sealed class PreviewHost {
        private readonly Settings _settings;
        private readonly Dictionary<string, IKnobPreview> _previews = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, string> _labels = new(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> _order = new();

        private readonly DockPanel _root = new();
        private readonly ComboBox _domainPick = new() { Width = 92, VerticalAlignment = VerticalAlignment.Center };
        private readonly ToggleButton _pause = new() { Content = "Pause", Padding = new Thickness(6, 1, 6, 1), Margin = new Thickness(4, 0, 0, 0) };
        private readonly ContentControl _content = new();
        private readonly TextBlock _placeholder = new() {
            TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DarkGray, Margin = new Thickness(8),
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, TextAlignment = TextAlignment.Center
        };

        private string _activeCfg = "";
        private bool _running;          // the active preview is Start()ed
        private bool _hostLoaded;       // Tune tab (our visual parent) is loaded
        private bool _windowActive = true;
        private bool _pinned;           // dropdown pick sticks until the next cross-cfg knob touch
        private bool _syncingPick;      // guard: programmatic dropdown updates must not re-enter

        /// <summary>The pane content (right Tune column). The expand/collapse strip is owned by
        /// Ui.BuildTune (it also has to resize the window and the grid column).</summary>
        public UIElement View => _root;

        /// <summary>The window whose Activated/Deactivated we subscribed on Loaded — cached so
        /// Unloaded can unsubscribe reliably (Window.GetWindow can already be null there, which
        /// would leak the handlers and keep this host alive).</summary>
        private Window? _win;

        public PreviewHost(Settings settings) {
            _settings = settings;
            var header = new DockPanel { Margin = new Thickness(2) };
            header.Children.Add(new TextBlock { Text = "Preview ", VerticalAlignment = VerticalAlignment.Center, FontWeight = FontWeights.Bold });
            header.Children.Add(_domainPick);
            header.Children.Add(_pause);
            DockPanel.SetDock(header, Dock.Top);
            _root.Children.Add(header);
            _root.Children.Add(_content);

            _domainPick.SelectionChanged += (_, __) => {
                if (_syncingPick) return;
                if (_domainPick.SelectedIndex >= 0 && _domainPick.SelectedIndex < _order.Count) {
                    _pinned = true;                          // manual pick pins…
                    Activate(_order[_domainPick.SelectedIndex]);
                }
            };
            _pause.Checked += (_, __) => Apply();
            _pause.Unchecked += (_, __) => Apply();

            _root.Loaded += (_, __) => {
                _hostLoaded = true;
                if (_win == null) {   // guard double-subscribe on repeated tab-switch Loadeds
                    _win = Window.GetWindow(_root);
                    if (_win != null) {   // §1.1 rule 2: window deactivation freezes the frame
                        _win.Activated += OnWinActivated;
                        _win.Deactivated += OnWinDeactivated;
                        _windowActive = _win.IsActive;
                    }
                }
                Apply();
            };
            _root.Unloaded += (_, __) => {
                _hostLoaded = false;
                if (_win != null) { _win.Activated -= OnWinActivated; _win.Deactivated -= OnWinDeactivated; _win = null; }
                Apply();
            };
        }

        private void OnWinActivated(object? s, EventArgs e) { _windowActive = true; Apply(); }
        private void OnWinDeactivated(object? s, EventArgs e) { _windowActive = false; Apply(); }

        /// <summary>Register a domain. Pass a null preview for a cfg whose preview does not exist
        /// yet — the pane shows <paramref name="placeholder"/> when that domain is active.</summary>
        public void Register(string cfg, string label, IKnobPreview? preview, string placeholder = "") {
            _order.Add(cfg);
            _labels[cfg] = placeholder;
            if (preview != null) _previews[cfg] = preview;
            _syncingPick = true;
            _domainPick.Items.Add(label);
            _syncingPick = false;
            if (_activeCfg.Length == 0) Activate(cfg);
        }

        /// <summary>The knob-edit funnel: Ui.WriteAndCache routes every edit here with the full
        /// dict of the edited cfg. Auto-follow (§1.1 rule 1): a touch on another cfg's knob
        /// switches the pane — and clears any manual pin.</summary>
        public void OnKnobTouched(string cfg, IReadOnlyDictionary<string, string> dict) {
            if (!string.Equals(cfg, _activeCfg, StringComparison.OrdinalIgnoreCase)) {
                _pinned = false;                            // …until the next cross-cfg touch
                Activate(cfg);
            }
            Push(cfg, dict);
        }

        /// <summary>The inner cfg tab changed. Follows unless the user pinned a domain.</summary>
        public void OnCfgTabSelected(string cfg) {
            if (_pinned) return;
            if (!string.Equals(cfg, _activeCfg, StringComparison.OrdinalIgnoreCase)) Activate(cfg);
        }

        /// <summary>Push a cfg dict to its preview (active or not — SetKnobs is a cheap state
        /// update + at most one redraw; previews animate only while Start()ed).</summary>
        public void Push(string cfg, IReadOnlyDictionary<string, string> dict) {
            if (_previews.TryGetValue(cfg, out var p)) p.SetKnobs(dict);
        }

        /// <summary>Called by Ui when the pane is expanded/collapsed (it owns the column + window
        /// sizing); collapsed == not visible == stopped.</summary>
        public void SetExpanded(bool expanded) {
            _settings.PreviewExpanded = expanded;
            _settings.Save();
            Apply();
        }

        private void Activate(string cfg) {
            if (string.Equals(cfg, _activeCfg, StringComparison.OrdinalIgnoreCase)) return;
            StopActive();
            _activeCfg = cfg;
            _syncingPick = true;
            _domainPick.SelectedIndex = _order.FindIndex(c => string.Equals(c, cfg, StringComparison.OrdinalIgnoreCase));
            _syncingPick = false;
            if (_previews.TryGetValue(cfg, out var p)) _content.Content = p.View;
            else { _placeholder.Text = _labels.TryGetValue(cfg, out var t) ? t : ""; _content.Content = _placeholder; }
            Apply();
        }

        /// <summary>The one lifecycle gate: reconcile "should the active preview animate" with
        /// whether it currently is. Every input change funnels here.</summary>
        private void Apply() {
            bool want = _hostLoaded && _settings.PreviewExpanded && _windowActive && _pause.IsChecked != true
                        && _previews.ContainsKey(_activeCfg);
            if (want == _running) return;
            if (_previews.TryGetValue(_activeCfg, out var p)) {
                if (want) p.Start(); else p.Stop();
                _running = want;
            }
            else _running = false;
        }

        private void StopActive() {
            if (_running && _previews.TryGetValue(_activeCfg, out var p)) p.Stop();
            _running = false;
        }
    }
}
