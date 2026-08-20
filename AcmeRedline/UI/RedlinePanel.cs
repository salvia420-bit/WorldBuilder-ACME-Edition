using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using AcmeRedline.Services;
using Microsoft.Extensions.Logging;
using RmlUi;
using RmlUi.Lib;
using RmlUiNet;

namespace AcmeRedline.UI {
    /// <summary>
    /// The in-game panel.
    ///
    /// UI SYSTEM - verified, not assumed. Chorizite's UI for plugins is RmlUi (HTML/CSS-like
    /// RML/RCSS documents, optionally Lua-scripted), provided by the RmlUi plugin:
    ///   external/chorizite/RmlUiPlugin/RmlUiPlugin.cs:182  Panel? CreatePanel(string name, string rmlFilePath, Action&lt;UIDocument&gt;? init = null)
    ///   external/chorizite/RmlUiPlugin/Lib/Panel.cs:17     class Panel : UIDocument
    ///   external/chorizite/RmlUiPlugin/Lib/UIDocument.cs:181  Element? GetElementById(string)
    ///   external/chorizite/RmlUiPlugin/Lib/UIDocument.cs:197/206  Hide() / Show()
    /// A plugin gets the RmlUiPlugin instance by constructor injection, exactly as
    /// external/chorizite/ACPlugin/ACPlugin.cs does.
    ///
    /// FRAMEWORK LIMITATION - reading form values. RmlUi.Net exposes GetValue()/SetValue() only on
    /// the concrete ElementFormControlInput type, and that type has no public constructor and no
    /// downcast helper from the RmlUiNet.Element handle that GetElementById returns (verified by
    /// reflecting over RmlUi.Net 1.0.1). So this panel reads and writes control state through
    /// Element.GetAttribute("value") / SetAttribute("value") plus the "change" event, whose
    /// Event.Parameters["value"] carries the new value. That is RmlUi's own convention and needs
    /// no cast; it is a deliberate choice, not an oversight.
    /// </summary>
    public sealed class RedlinePanel : IDisposable {
        /// <summary>The quick tags offered in the panel, in display order.</summary>
        public static readonly string[] QuickTags = [
            "too-blurry", "wrong-material", "seam", "silhouette", "remove-detail", "recolor", "other"
        ];

        private readonly RmlUiPlugin _rmlUi;
        private readonly SelectionService _selection;
        private readonly StatusReader _status;
        private readonly QueueWriter _queue;
        private readonly KitMeta _kit;
        private readonly RedlineSettings _settings;
        private readonly ILogger _log;
        private readonly string _rmlPath;

        private Panel? _panel;
        private readonly HashSet<string> _activeTags = [];
        private int _severity;
        private string _prompt = "";

        /// <summary>Raised when the user hits submit. The plugin owns what happens next.</summary>
        public event EventHandler<SubmitRequestedEventArgs>? OnSubmitRequested;

        /// <summary>Raised when the user toggles the status-tint overlay.</summary>
        public event EventHandler<bool>? OnStatusOverlayToggled;

        private readonly Func<string?> _authorProvider;

        public RedlinePanel(RmlUiPlugin rmlUi, SelectionService selection, StatusReader status,
                            QueueWriter queue, KitMeta kit, RedlineSettings settings,
                            string rmlPath, Func<string?> authorProvider, ILogger log) {
            _rmlUi = rmlUi;
            _selection = selection;
            _status = status;
            _queue = queue;
            _kit = kit;
            _settings = settings;
            _rmlPath = rmlPath;
            _authorProvider = authorProvider;
            _log = log;
            _severity = Math.Clamp(settings.DefaultSeverity, 1, 3);
        }

        /// <summary>Create (or re-show) the panel.</summary>
        public void Show() {
            if (_panel is null) {
                if (!File.Exists(_rmlPath)) {
                    _log.LogError("redline: panel RML missing at {Path}", _rmlPath);
                    return;
                }
                _panel = _rmlUi.CreatePanel("AcmeRedline.Panel", _rmlPath);
                if (_panel is null) {
                    _log.LogError("redline: RmlUi refused to create the panel from {Path}", _rmlPath);
                    return;
                }
                Wire(_panel);
            }
            _panel.Show();
            RefreshAll();
        }

        /// <summary>Hide the panel without destroying it.</summary>
        public void Hide() => _panel?.Hide();

        /// <summary>Show if hidden, hide if shown.</summary>
        public void Toggle() {
            if (_panel is not null && _panel.IsVisible) Hide();
            else Show();
        }

        public void Dispose() {
            _panel?.Dispose();
            _panel = null;
        }

        // ------------------------------------------------------------------
        // Wiring
        // ------------------------------------------------------------------

        private void Wire(Panel panel) {
            // Free-text prompt. RmlUi fires "change" on every edit with the new text in
            // Event.Parameters["value"].
            panel.GetElementById("prompt")?.AddEventListener("change", ev => {
                _prompt = ParamString(ev, "value") ?? "";
            });

            foreach (var tag in QuickTags) {
                var el = panel.GetElementById($"tag-{tag}");
                if (el is null) {
                    _log.LogDebug("redline: panel has no element for tag {Tag}", tag);
                    continue;
                }
                string captured = tag;
                el.AddEventListener("click", _ => {
                    if (!_activeTags.Remove(captured)) _activeTags.Add(captured);
                    RefreshTagUi();
                });
            }

            for (int s = 1; s <= 3; s++) {
                var el = panel.GetElementById($"sev-{s}");
                if (el is null) continue;
                int captured = s;
                el.AddEventListener("click", _ => {
                    _severity = captured;
                    RefreshSeverityUi();
                });
            }

            panel.GetElementById("submit")?.AddEventListener("click", _ => HandleSubmit());

            panel.GetElementById("clear-selection")?.AddEventListener("click", _ => {
                _selection.Clear();
                RefreshSelectionUi();
            });

            panel.GetElementById("tex-in-view")?.AddEventListener("click", _ => {
                // Expand the current single-texture pick to every in-view instance of that RS.
                var surfaces = _selection.Current.Surfaces;
                if (surfaces.Count == 1) {
                    uint rs = 0;
                    foreach (var k in surfaces.Keys) { rs = k; break; }
                    if (rs != 0) _selection.SelectAllInstancesOfTexture(rs);
                }
                else {
                    SetText("guard-warning", "Pick exactly one texture first, then expand it to all in-view instances.");
                    SetVisible("guard-warning", true);
                }
                RefreshSelectionUi();
            });

            panel.GetElementById("toggle-status")?.AddEventListener("click", _ => {
                _settings.StatusOverlayEnabled = !_settings.StatusOverlayEnabled;
                OnStatusOverlayToggled?.Invoke(this, _settings.StatusOverlayEnabled);
                RefreshFooter();
            });

            _selection.OnChanged += (_, _) => RefreshSelectionUi();
        }

        private static string? ParamString(Event ev, string key) {
            try {
                var p = ev.Parameters;
                if (p is not null && p.TryGetValue(key, out var v)) return v?.ToString();
            }
            catch (Exception) {
                // Parameters marshalling can throw for event types that carry none.
            }
            return null;
        }

        // ------------------------------------------------------------------
        // Submit
        // ------------------------------------------------------------------

        private void HandleSubmit() {
            // Belt and braces: the "change" event may not have fired if the user typed and
            // clicked submit without the control losing focus.
            var promptEl = _panel?.GetElementById("prompt");
            var attr = promptEl?.GetAttribute("value");
            if (!string.IsNullOrEmpty(attr)) _prompt = attr!;

            if (string.IsNullOrWhiteSpace(_prompt)) {
                SetText("guard-warning", "Say what is wrong before submitting.");
                SetVisible("guard-warning", true);
                return;
            }

            var args = new SubmitRequestedEventArgs(
                prompt: _prompt.Trim(),
                tags: _activeTags.OrderBy(t => Array.IndexOf(QuickTags, t)).ToList(),
                severity: Math.Clamp(_severity, 1, 3));

            OnSubmitRequested?.Invoke(this, args);

            if (args.Accepted) {
                _prompt = "";
                promptEl?.SetAttribute("value", "");
                _activeTags.Clear();
                SetVisible("guard-warning", false);
                RefreshAll();
            }
            else if (!string.IsNullOrEmpty(args.RejectReason)) {
                SetText("guard-warning", args.RejectReason!);
                SetVisible("guard-warning", true);
            }
        }

        // ------------------------------------------------------------------
        // Rendering the panel state
        // ------------------------------------------------------------------

        /// <summary>Refresh every part of the panel. Cheap; called on show and after a submit.</summary>
        public void RefreshAll() {
            RefreshSelectionUi();
            RefreshTagUi();
            RefreshSeverityUi();
            RefreshReports();
            RefreshFooter();
        }

        /// <summary>Summarise the live selection and surface the kit guard warning.</summary>
        public void RefreshSelectionUi() {
            if (_panel is null) return;
            var sel = _selection.Current;

            if (sel.IsEmpty) {
                SetText("selection-summary", "nothing selected");
            }
            else {
                // Header line: kind + counts. Detail lines: the actual target ids the entry will
                // carry, so the reporter can confirm they picked the right thing before submitting.
                var sb = new StringBuilder();
                sb.Append($"<b>{Escape(sel.Kind)}</b> &mdash; ")
                  .Append($"{sel.Objects.Count} obj, {sel.Surfaces.Count} tex, ")
                  .Append($"{sel.PickedPolygonKeys.Count} poly");
                if (sel.LassoPoints.Count > 0) sb.Append($", lasso {sel.LassoPoints.Count}pt");

                foreach (var o in sel.Objects.Values.Take(4)) {
                    sb.Append("<br/>obj ").Append(Escape(Hex.U32(o.ObjectId)));
                    if (o.GfxObjId != 0) sb.Append(" gfx ").Append(Escape(Hex.U32(o.GfxObjId)));
                    if (o.SetupId != 0) sb.Append(" setup ").Append(Escape(Hex.U32(o.SetupId)));
                }
                if (sel.Objects.Count > 4) sb.Append($"<br/>… +{sel.Objects.Count - 4} more objects");

                foreach (var s in sel.Surfaces.Values.Take(4)) {
                    sb.Append("<br/>rs ").Append(Escape(Hex.U32(s.RenderSurfaceId)));
                    if (s.SurfaceId != 0) sb.Append(" surf ").Append(Escape(Hex.U32(s.SurfaceId)));
                }
                if (sel.Surfaces.Count > 4) sb.Append($"<br/>… +{sel.Surfaces.Count - 4} more textures");

                if (sel.TriangleGfxObjId != 0 && sel.PickedPolygonKeys.Count > 0) {
                    sb.Append("<br/>tri gfx ").Append(Escape(Hex.U32(sel.TriangleGfxObjId)))
                      .Append($" ({sel.PickedPolygonKeys.Count} src poly)");
                }

                if (_selection.LastTextureInViewCount > 0) {
                    sb.Append($"<br/>texture on {_selection.LastTextureInViewCount} model(s) in view");
                }

                _panel.GetElementById("selection-summary")?.SetInnerRml(sb.ToString());
            }

            var warning = _kit.WarningFor(sel);
            SetText("guard-warning", warning ?? "");
            SetVisible("guard-warning", warning is not null);
        }

        private void RefreshTagUi() {
            if (_panel is null) return;
            foreach (var tag in QuickTags) {
                var el = _panel.GetElementById($"tag-{tag}");
                if (el is null) continue;
                if (_activeTags.Contains(tag)) el.AddClass("on");
                else el.RemoveClass("on");
            }
        }

        private void RefreshSeverityUi() {
            if (_panel is null) return;
            for (int s = 1; s <= 3; s++) {
                var el = _panel.GetElementById($"sev-{s}");
                if (el is null) continue;
                if (s == _severity) el.AddClass("on");
                else el.RemoveClass("on");
            }
        }

        /// <summary>
        /// "My reports": the local queue, annotated with whatever redline-status.jsonl says.
        /// The status column is READ-ONLY - the plugin never writes a status event.
        /// </summary>
        public void RefreshReports() {
            if (_panel is null) return;
            _status.Refresh();

            string? me = _authorProvider();
            var entries = _queue.ReadOwnEntries(max: 200);
            // "My reports": this account only. If the account name isn't known (not logged in),
            // show everything rather than an empty list.
            if (me is not null) {
                entries = entries.Where(e => string.Equals(e.Author, me, StringComparison.Ordinal)).ToList();
            }
            entries.Reverse(); // newest first
            if (entries.Count > 50) entries = entries.GetRange(0, 50);

            var sb = new StringBuilder();
            foreach (var e in entries) {
                string state = _status.StateFor(e.Id);
                string colour = OverlayRenderer.CssForState(state);
                string prompt = Truncate(e.Prompt, 54);
                sb.Append("<div class=\"report\">")
                  .Append($"<span class=\"dot\" style=\"background-color: {colour};\"></span>")
                  .Append(Escape(prompt))
                  .Append($" <span class=\"when\">[{Escape(state)}]</span>")
                  .Append("</div>");
            }
            if (entries.Count == 0) sb.Append("<div class=\"muted\">no reports yet</div>");

            _panel.GetElementById("reports")?.SetInnerRml(sb.ToString());
        }

        private void RefreshFooter() {
            string kit = _kit.Meta?.KitTag ?? "no kit meta";
            string overlay = _settings.StatusOverlayEnabled ? "status overlay ON" : "status overlay off";
            SetText("footer", $"{kit} - queue {_queue.QueueDir} - {overlay}");
        }

        private void SetText(string id, string text) =>
            _panel?.GetElementById(id)?.SetInnerRml(Escape(text));

        private void SetVisible(string id, bool visible) {
            var el = _panel?.GetElementById(id);
            if (el is null) return;
            if (visible) el.AddClass("visible");
            else el.RemoveClass("visible");
        }

        private static string Truncate(string? s, int n) {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= n ? s : s[..(n - 1)] + "…";
        }

        /// <summary>Minimal RML escaping. User prompts go straight into the reports list.</summary>
        private static string Escape(string? s) =>
            (s ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
    }

    /// <summary>What the panel collected when the user hit submit.</summary>
    public sealed class SubmitRequestedEventArgs : EventArgs {
        public string Prompt { get; }
        public IReadOnlyList<string> Tags { get; }
        public int Severity { get; }

        /// <summary>Set true by the handler when the entry was actually queued; clears the form.</summary>
        public bool Accepted { get; set; }

        /// <summary>Set by the handler when it declines to queue, so the panel can tell the user why.</summary>
        public string? RejectReason { get; set; }

        public SubmitRequestedEventArgs(string prompt, IReadOnlyList<string> tags, int severity) {
            Prompt = prompt;
            Tags = tags;
            Severity = severity;
        }
    }
}
