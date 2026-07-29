using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib.TexturePicker;

namespace WorldBuilder.ViewModels {
    /// <summary>
    /// The human-taste instrument for the X-track: walk the ranked worklist of retail
    /// RenderSurfaces, A/B the retail texture against CC0 candidates at a chosen repeat factor,
    /// and record picks.
    ///
    /// v0 preview is 2D — an Avalonia tiled <c>ImageBrush</c> — deliberately, not
    /// <see cref="WorldBuilder.Views.Base3DView"/>: Base3DView needs an OpenGL RenderTarget, a
    /// GameScene and per-viewport input wiring owned by an editor, which a docked side panel has
    /// no business standing up. A tiled brush gives an instant, allocation-free A/B toggle, which
    /// is what the taste judgement actually needs. In-world camera panning is explicitly out of
    /// scope for v0.
    ///
    /// All decision logic lives in <see cref="TexturePickerSession"/> (WorldBuilder.Shared, no
    /// Avalonia dependency) so it is unit-testable; this class owns only Bitmaps and notification.
    /// </summary>
    public partial class TexturePickerPanelViewModel : ViewModelBase {
        private readonly Dictionary<string, Bitmap> _bitmapCache = new(StringComparer.Ordinal);

        private TexturePickerSession? _session;

        /// <summary>The pure-logic session. Null until a recommendations file loads.</summary>
        public TexturePickerSession? Session => _session;

        [ObservableProperty]
        private ObservableCollection<TexturePickerRowItem> _rows = new();

        [ObservableProperty]
        private ObservableCollection<TexturePickerCandidateItem> _candidates = new();

        [ObservableProperty]
        private TexturePickerRowItem? _selectedRow;

        [ObservableProperty]
        private TexturePickerCandidateItem? _selectedCandidate;

        [ObservableProperty]
        private Bitmap? _previewBitmap;

        [ObservableProperty]
        private string _previewSourceLabel = "";

        [ObservableProperty]
        private string _progressText = "";

        [ObservableProperty]
        private string _statusText = "";

        [ObservableProperty]
        private string _pickerDirectory = TexturePickerSession.DefaultPickerDirectory;

        [ObservableProperty]
        private bool _isLoaded;

        [ObservableProperty]
        private bool _showRetail;

        /// <summary>Repeat on X, or null when the ranking pipeline left the axis n/a.</summary>
        [ObservableProperty]
        private double? _repeatX = 1;

        [ObservableProperty]
        private double? _repeatY = 1;

        /// <summary>Bake-time brightness gain for the current pick. Null = leave the texture alone.</summary>
        [ObservableProperty]
        private decimal? _gain;

        /// <summary>Tint entry text — "#8fa0b4", "0.9,0.95,1" or "0.9". Empty = untouched.</summary>
        [ObservableProperty]
        private string _tintText = "";

        /// <summary>Export availability of the selected candidate ("set not downloaded — …").</summary>
        [ObservableProperty]
        private string _availabilityText = "";

        /// <summary>False while the tint box holds something unparseable — the panel tints the border.</summary>
        public bool IsTintValid => PickerTint.TryParse(TintText, out _);

        /// <summary>Swatch colour for the tint entry; white when the tint is empty.</summary>
        public string TintSwatchHex =>
            PickerTint.TryParse(TintText, out var t) ? PickerTint.ToHex(t) : "#FFFFFF";

        public IBrush TintSwatchBrush =>
            new SolidColorBrush(Color.Parse(TintSwatchHex));

        /// <summary>Steppers are dead on an n/a axis — there is no value to step from.</summary>
        public bool HasRepeatX => RepeatX.HasValue;
        public bool HasRepeatY => RepeatY.HasValue;

        /// <summary>
        /// Tile rect for the preview <c>ImageBrush</c>: width/height are 1/repeat in relative units,
        /// so repeat 4 renders 4 tiles across. An n/a axis renders untiled (1×) — a display
        /// fallback only; nothing writes 1.0 back into the decision.
        /// </summary>
        public RelativeRect PreviewTileRect =>
            new(0, 0, 1.0 / Math.Max(TexturePickerSession.MinRepeat, RepeatX ?? 1.0),
                      1.0 / Math.Max(TexturePickerSession.MinRepeat, RepeatY ?? 1.0), RelativeUnit.Relative);

        public string RepeatText =>
            string.Format(CultureInfo.InvariantCulture, "{0} × {1}", AxisText(RepeatX), AxisText(RepeatY));

        /// <summary>"n/a" for a null axis — never "1", which would read as a real tiling decision.</summary>
        private static string AxisText(double? v) =>
            v == null ? "n/a" : v.Value.ToString("0.##", CultureInfo.InvariantCulture);

        public TexturePickerPanelViewModel() {
            TryLoad(PickerDirectory);
        }

        // ---- loading ---------------------------------------------------------------------

        /// <summary>
        /// Loads picker-recommendations.json + picker-picks.json from <paramref name="directory"/>.
        /// Falls back to the hand-written design-time sample when the ranking pipeline has not run
        /// yet, so the panel is always reviewable.
        /// </summary>
        public void TryLoad(string directory) {
            try {
                var session = TexturePickerSession.LoadFromDirectory(directory);
                if (session == null) {
                    _session = new TexturePickerSession(TexturePickerSampleData.Build());
                    IsLoaded = false;
                    StatusText = $"No {TexturePickerSession.RecommendationsFileName} in {directory} — showing sample data (picks are NOT saved).";
                }
                else {
                    _session = session;
                    IsLoaded = true;
                    StatusText = $"Loaded {session.Rows.Count} rows from {directory}.";
                }
            }
            catch (Exception ex) {
                _session = new TexturePickerSession(TexturePickerSampleData.Build());
                IsLoaded = false;
                StatusText = $"Failed to load picker data: {ex.Message}";
            }

            PickerDirectory = directory;
            RebuildRows();
            SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void Reload() => TryLoad(PickerDirectory);

        private void RebuildRows() {
            Rows.Clear();
            if (_session == null) return;
            for (int i = 0; i < _session.Rows.Count; i++) {
                Rows.Add(new TexturePickerRowItem(this, i, _session.Rows[i]));
            }
        }

        // ---- worklist navigation ---------------------------------------------------------

        [RelayCommand]
        public void NextRow() {
            if (_session == null || !_session.Next()) return;
            SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void PrevRow() {
            if (_session == null || !_session.Prev()) return;
            SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void NextUndecidedRow() {
            if (_session == null) return;
            if (!_session.NextUndecided()) {
                StatusText = "Every row in the worklist has a decision.";
                return;
            }
            SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void GoToRow(TexturePickerRowItem? item) {
            if (_session == null || item == null) return;
            // Guard re-entrancy: SyncFromSession writes SelectedRow, which re-raises the list's
            // SelectionChanged. Without this the candidate selection would be reset on every sync.
            if (item.Index == _session.CurrentIndex) return;
            _session.CurrentIndex = item.Index;
            SyncFromSession(reloadCandidates: true);
        }

        // ---- candidate selection ---------------------------------------------------------

        [RelayCommand]
        public void SelectCandidate(TexturePickerCandidateItem? item) {
            if (_session == null || item == null) return;
            _session.SelectedCandidateIndex = item.Index;
            _session.ShowRetail = false;
            SyncFromSession(reloadCandidates: false);
        }

        /// <summary>Keys 1-5. Selecting a candidate also flips the preview off retail.</summary>
        public void SelectCandidateByHotkey(int oneBased) {
            if (_session == null) return;
            _session.SelectCandidateByHotkey(oneBased);
            _session.ShowRetail = false;
            SyncFromSession(reloadCandidates: false);
        }

        // ---- A/B toggle ------------------------------------------------------------------

        [RelayCommand]
        public void ToggleRetail() {
            if (_session == null) return;
            _session.ToggleRetail();
            SyncFromSession(reloadCandidates: false);
        }

        // ---- repeat stepper --------------------------------------------------------------

        [RelayCommand]
        public void StepRepeatX(object? delta) {
            if (_session == null) return;
            _session.StepRepeatX(ParseDelta(delta));
            SyncFromSession(reloadCandidates: false);
        }

        [RelayCommand]
        public void StepRepeatY(object? delta) {
            if (_session == null) return;
            _session.StepRepeatY(ParseDelta(delta));
            SyncFromSession(reloadCandidates: false);
        }

        [RelayCommand]
        public void StepRepeatBoth(object? delta) {
            if (_session == null) return;
            var d = ParseDelta(delta);
            _session.StepRepeatX(d);
            _session.StepRepeatY(d);
            SyncFromSession(reloadCandidates: false);
        }

        [RelayCommand]
        public void ResetRepeat() {
            if (_session == null) return;
            _session.SeedRepeatFromSelection();
            SyncFromSession(reloadCandidates: false);
        }

        private static double ParseDelta(object? delta) => delta switch {
            double d => d,
            int i => i,
            string s when double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) => p,
            _ => TexturePickerSession.RepeatStep,
        };

        partial void OnRepeatXChanged(double? value) {
            if (_session != null && !SameAxis(_session.RepeatX, value)) {
                _session.RepeatX = value;
                if (!SameAxis(_session.RepeatX, value)) RepeatX = _session.RepeatX;
            }
            OnPropertyChanged(nameof(PreviewTileRect));
            OnPropertyChanged(nameof(RepeatText));
            OnPropertyChanged(nameof(HasRepeatX));
        }

        partial void OnRepeatYChanged(double? value) {
            if (_session != null && !SameAxis(_session.RepeatY, value)) {
                _session.RepeatY = value;
                if (!SameAxis(_session.RepeatY, value)) RepeatY = _session.RepeatY;
            }
            OnPropertyChanged(nameof(PreviewTileRect));
            OnPropertyChanged(nameof(RepeatText));
            OnPropertyChanged(nameof(HasRepeatY));
        }

        private static bool SameAxis(double? a, double? b) =>
            a == null || b == null ? a == null && b == null : Math.Abs(a.Value - b.Value) <= 1e-6;

        partial void OnTintTextChanged(string value) {
            OnPropertyChanged(nameof(IsTintValid));
            OnPropertyChanged(nameof(TintSwatchHex));
            OnPropertyChanged(nameof(TintSwatchBrush));
        }

        // ---- decisions -------------------------------------------------------------------

        [RelayCommand]
        public void PickCurrent() {
            if (_session == null) return;
            if (!PickerTint.TryParse(TintText, out var tint)) {
                StatusText = $"Tint '{TintText}' is not a #rrggbb colour or an r,g,b multiplier triple.";
                return;
            }
            var gain = Gain == null ? (double?)null : decimal.ToDouble(Gain.Value);
            if (!_session.PickCurrent(gain: gain, tint: tint)) {
                StatusText = "Pick needs a selected candidate (press 1-5).";
                return;
            }
            var row = _session.CurrentRow;
            var blocked = _session.SelectedAvailabilityText;
            StatusText = $"Picked {_session.SelectedCandidate?.AssetId} for {row?.RsId} @ {RepeatText}"
                       + (gain == null ? "" : $", gain {gain.Value.ToString("0.##", CultureInfo.InvariantCulture)}")
                       + (tint == null ? "" : $", tint {PickerTint.Format(tint)}")
                       + "."
                       + (string.IsNullOrEmpty(blocked) ? "" : " " + blocked);
            RefreshRowDecorations();
            if (!_session.Next()) SyncFromSession(reloadCandidates: false);
            else SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void SkipCurrent() {
            if (_session == null || !_session.SkipCurrent()) return;
            StatusText = $"Skipped {_session.CurrentRow?.RsId}.";
            RefreshRowDecorations();
            if (!_session.Next()) SyncFromSession(reloadCandidates: false);
            else SyncFromSession(reloadCandidates: true);
        }

        [RelayCommand]
        public void ClearCurrentDecision() {
            if (_session == null || !_session.ClearCurrent()) return;
            StatusText = $"Cleared decision for {_session.CurrentRow?.RsId}.";
            RefreshRowDecorations();
            SyncFromSession(reloadCandidates: false);
        }

        // ---- export ----------------------------------------------------------------------

        /// <summary>
        /// Writes a holtburger statTexOverride bundle (manifest.json + picked diffuse PNGs) to a
        /// directory the user chooses. Diffuse only — the exported note carries the
        /// normal/rough TODO.
        /// </summary>
        [RelayCommand]
        public async Task ExportOverrides() {
            if (_session == null) return;

            var entries = _session.BuildExportEntries(out var unavailable);
            if (entries.Count == 0) {
                StatusText = unavailable.Count > 0
                    ? $"Nothing exportable — {unavailable.Count} pick(s) have no local full-res set."
                    : "Nothing to export — no picks yet.";
                return;
            }

            var topLevel = GetTopLevel();
            if (topLevel == null) {
                StatusText = "Export needs a window (no TopLevel available).";
                return;
            }

            var folders = await topLevel.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions {
                Title = "Export statTexOverride bundle to…",
                AllowMultiple = false,
            });
            if (folders.Count == 0) return;
            var destination = folders[0].TryGetLocalPath();
            if (destination == null) {
                StatusText = "Export destination is not a local path.";
                return;
            }

            try {
                var note = $"WorldBuilder Texture Picker export — {entries.Count} CC0 diffuse override(s), pool: {_session.Recommendations.Pool ?? "unknown"}.";
                var result = TexOverrideExporter.Export(entries, destination, note);
                StatusText = unavailable.Count == 0
                    ? $"Exported {result.OverrideCount} override(s) to {result.Directory}."
                    : $"Exported {result.OverrideCount} override(s) to {result.Directory}; skipped {unavailable.Count} with no local full-res set.";
            }
            catch (Exception ex) {
                StatusText = $"Export failed: {ex.Message}";
            }
        }

        private static TopLevel? GetTopLevel() {
            if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
                return desktop.MainWindow;
            if (Application.Current?.ApplicationLifetime is ISingleViewApplicationLifetime singleView)
                return TopLevel.GetTopLevel(singleView.MainView);
            return null;
        }

        // ---- session -> observable sync ---------------------------------------------------

        private void SyncFromSession(bool reloadCandidates) {
            if (_session == null) return;

            if (reloadCandidates) {
                Candidates.Clear();
                var sidebar = _session.SidebarCandidates;
                for (int i = 0; i < sidebar.Count; i++) {
                    Candidates.Add(new TexturePickerCandidateItem(this, i, sidebar[i], _session.Resolver));
                }
                // Restore the previous decision's asset if there is one, otherwise take the top rank.
                var decision = _session.CurrentDecision;
                var restored = decision?.AssetId == null
                    ? -1
                    : sidebar.ToList().FindIndex(c => string.Equals(c.AssetId, decision!.AssetId, StringComparison.OrdinalIgnoreCase));
                _session.SelectedCandidateIndex = restored >= 0 ? restored : (sidebar.Count > 0 ? 0 : -1);
                _session.SeedRepeatFromSelection();
            }

            SelectedRow = _session.Rows.Count == 0 || _session.CurrentIndex >= Rows.Count
                ? null : Rows[_session.CurrentIndex];

            foreach (var c in Candidates) c.IsSelected = c.Index == _session.SelectedCandidateIndex;
            SelectedCandidate = Candidates.FirstOrDefault(c => c.IsSelected);

            ShowRetail = _session.ShowRetail;
            RepeatX = _session.RepeatX;
            RepeatY = _session.RepeatY;
            OnPropertyChanged(nameof(PreviewTileRect));
            OnPropertyChanged(nameof(RepeatText));

            PreviewSourceLabel = _session.PreviewSourceLabel;
            PreviewBitmap = LoadBitmap(_session.PreviewImagePath);
            ProgressText = _session.ProgressText;
            AvailabilityText = _session.SelectedAvailabilityText;
            SyncGainAndTint();
        }

        // ---- gain / tint -------------------------------------------------------------------

        /// <summary>
        /// Restores gain/tint from an existing decision, or seeds a gain suggestion for a fresh one.
        /// Never overwrites a value the human typed for the row they are still on.
        /// </summary>
        private void SyncGainAndTint() {
            if (_session == null) return;
            var decision = _session.CurrentDecision;
            var key = (_session.CurrentRow?.RsId ?? "") + "|" + (_session.SelectedCandidate?.AssetId ?? "");
            if (key == _gainTintKey) return;
            _gainTintKey = key;

            if (decision != null && !decision.Skipped
                && string.Equals(decision.AssetId, _session.SelectedCandidate?.AssetId, StringComparison.OrdinalIgnoreCase)) {
                Gain = decision.Gain == null ? null : (decimal)decision.Gain.Value;
                TintText = PickerTint.Format(decision.Tint);
                return;
            }

            TintText = "";
            var suggested = SuggestGainForSelection();
            Gain = suggested == null ? null : (decimal)suggested.Value;
        }

        private string _gainTintKey = " ";

        /// <summary>
        /// retailMeanLuminance / candidateMeanLuminance, both measured off a 32-px decode of images
        /// that are already on disk and memoized per path. That is a couple of milliseconds once per
        /// image — deliberately NOT a full-resolution pass.
        /// </summary>
        private double? SuggestGainForSelection() {
            if (_session == null) return null;
            var retail = MeanLuminance(_session.CurrentRow?.RetailPng);
            var candidate = MeanLuminance(_session.Resolver.ResolvePreview(_session.SelectedCandidate));
            return TexturePickerSession.SuggestGain(retail, candidate);
        }

        [RelayCommand]
        public void SuggestGain() {
            var suggested = SuggestGainForSelection();
            if (suggested == null) {
                StatusText = "No gain suggestion — one of the two images could not be measured.";
                return;
            }
            Gain = (decimal)suggested.Value;
            StatusText = $"Gain seeded from mean luminance ratio: {suggested.Value.ToString("0.##", CultureInfo.InvariantCulture)}.";
        }

        [RelayCommand]
        public void ClearGainAndTint() {
            Gain = null;
            TintText = "";
        }

        private readonly Dictionary<string, double?> _luminanceCache = new(StringComparer.Ordinal);

        /// <summary>
        /// Mean of the R/G/B channels over a 32-px-wide decode. Channel MEAN, not a weighted luma,
        /// so the answer does not depend on whether the decoded buffer came back BGRA or RGBA — for
        /// a brightness ratio that is the honest measure anyway. Null when it cannot be measured.
        /// </summary>
        private double? MeanLuminance(string? path) {
            if (string.IsNullOrWhiteSpace(path)) return null;
            if (_luminanceCache.TryGetValue(path!, out var cached)) return cached;

            double? result = null;
            try {
                if (File.Exists(path!)) {
                    using var stream = File.OpenRead(path!);
                    using var small = Bitmap.DecodeToWidth(stream, 32);
                    var w = small.PixelSize.Width;
                    var h = small.PixelSize.Height;
                    if (w > 0 && h > 0) {
                        var stride = w * 4;
                        var size = stride * h;
                        var buffer = Marshal.AllocHGlobal(size);
                        try {
                            small.CopyPixels(new PixelRect(0, 0, w, h), buffer, size, stride);
                            var bytes = new byte[size];
                            Marshal.Copy(buffer, bytes, 0, size);
                            double sum = 0;
                            for (int i = 0; i < size; i += 4) sum += (bytes[i] + bytes[i + 1] + bytes[i + 2]) / 3.0;
                            result = sum / (w * h) / 255.0;
                        }
                        finally { Marshal.FreeHGlobal(buffer); }
                    }
                }
            }
            catch (Exception) {
                result = null;   // an unmeasurable image is "no suggestion", never a crash
            }

            _luminanceCache[path!] = result;
            return result;
        }

        private void RefreshRowDecorations() {
            if (_session == null) return;
            foreach (var row in Rows) row.RefreshDecision(_session.DecisionFor(row.Model));
        }

        /// <summary>
        /// Bitmaps are cached by absolute path so the retail/candidate toggle is instant — a
        /// full-res 1K PNG decode on every space-bar press would defeat the whole point of the tool.
        /// </summary>
        private Bitmap? LoadBitmap(string? path) {
            if (string.IsNullOrWhiteSpace(path)) return null;
            if (_bitmapCache.TryGetValue(path!, out var cached)) return cached;
            try {
                var bitmap = new Bitmap(path!);
                // Bound the cache: the worklist can be hundreds of rows deep and each full-res
                // 1K RGBA decode is ~4 MB on an 8 GB box.
                if (_bitmapCache.Count >= 24) {
                    var evict = _bitmapCache.Keys.First();
                    _bitmapCache[evict].Dispose();
                    _bitmapCache.Remove(evict);
                }
                _bitmapCache[path!] = bitmap;
                return bitmap;
            }
            catch (Exception ex) {
                StatusText = $"Could not load image {Path.GetFileName(path)}: {ex.Message}";
                return null;
            }
        }
    }

    /// <summary>One worklist entry in the navigator list.</summary>
    public partial class TexturePickerRowItem : ObservableObject {
        public TexturePickerPanelViewModel Owner { get; }
        public PickerRow Model { get; }
        public int Index { get; }

        public string RsId => Model.RsId;
        public int X2Rank => Model.X2Rank;
        public string PlacementsText => Model.Placements.ToString("N0", CultureInfo.InvariantCulture);
        public string WrapAxes => string.IsNullOrWhiteSpace(Model.WrapAxes) ? "-" : Model.WrapAxes!;

        [ObservableProperty]
        private string _decisionGlyph = "";

        [ObservableProperty]
        private string _decisionDetail = "";

        public TexturePickerRowItem(TexturePickerPanelViewModel owner, int index, PickerRow model) {
            Owner = owner;
            Index = index;
            Model = model;
            RefreshDecision(owner.Session?.DecisionFor(model));
        }

        public void RefreshDecision(PickerPick? pick) {
            if (pick == null) { DecisionGlyph = ""; DecisionDetail = ""; return; }
            if (pick.Skipped) { DecisionGlyph = "—"; DecisionDetail = "skipped"; return; }
            DecisionGlyph = "✓";
            DecisionDetail = pick.AssetId ?? "";
        }
    }

    /// <summary>One sidebar candidate tile.</summary>
    public partial class TexturePickerCandidateItem : ObservableObject {
        public TexturePickerPanelViewModel Owner { get; }
        public PickerCandidate Model { get; }
        public int Index { get; }

        /// <summary>1-based hotkey number shown on the tile.</summary>
        public int Hotkey => Index + 1;

        public string AssetId => Model.AssetId;

        /// <summary>Catalogue display name when there is one, else the raw id.</summary>
        public string Label => Model.Label;

        public string CategoryText => string.IsNullOrWhiteSpace(Model.Category) ? "" : Model.Category!;
        public string SourceText => string.IsNullOrWhiteSpace(Model.Source) ? "" : Model.Source!;
        public string ScoreText => Model.Score.ToString("0.000", CultureInfo.InvariantCulture);

        public string SubScoreText => Model.Sub == null
            ? ""
            : string.Format(CultureInfo.InvariantCulture,
                "hue {0:0.00} · orient {1:0.00} · period {2:0.00} · busy {3:0.00}",
                Model.Sub.Hue, Model.Sub.Orient, Model.Sub.Period, Model.Sub.Busy);

        public string RepeatText => Model.RepeatFactor == null
            ? ""
            : string.Format(CultureInfo.InvariantCulture, "{0}×{1}",
                Axis(Model.RepeatFactor.X), Axis(Model.RepeatFactor.Y));

        private static string Axis(double? v) =>
            v == null ? "n/a" : v.Value.ToString("0.##", CultureInfo.InvariantCulture);

        /// <summary>Everything the tile cannot fit, shown on hover.</summary>
        public string TooltipText {
            get {
                var lines = new List<string> { Label };
                if (!string.Equals(Label, AssetId, StringComparison.Ordinal)) lines.Add(AssetId);
                var meta = string.Join(" · ", new[] { SourceText, CategoryText }.Where(s => s.Length > 0));
                if (Model.CategoryTier > 0) meta += (meta.Length > 0 ? " · " : "") + $"tier {Model.CategoryTier} (penalised)";
                if (meta.Length > 0) lines.Add(meta);
                lines.Add($"score {ScoreText}");
                if (SubScoreText.Length > 0) lines.Add(SubScoreText);
                if (RepeatText.Length > 0) lines.Add("repeat " + RepeatText);
                if (!string.IsNullOrWhiteSpace(Model.Link)) lines.Add(Model.Link!);
                if (!HasFullResolution) lines.Add(ExportBlockedReason);
                return string.Join("\n", lines);
            }
        }

        /// <summary>False when no local full-res set exists — the export cannot ship this.</summary>
        public bool HasFullResolution { get; }

        /// <summary>"set not downloaded — …", or "" when the candidate is shippable.</summary>
        public string ExportBlockedReason { get; }

        /// <summary>Short badge for the tile corner: "polyhaven" / "no set".</summary>
        public string AvailabilityBadge =>
            HasFullResolution ? ""
            : CandidateImageResolver.SupportsLocalSets(Model.Source) ? "no set" : SourceText;

        [ObservableProperty]
        private Bitmap? _thumbnail;

        [ObservableProperty]
        private bool _isSelected;

        public TexturePickerCandidateItem(
            TexturePickerPanelViewModel owner, int index, PickerCandidate model, CandidateImageResolver resolver) {
            Owner = owner;
            Index = index;
            Model = model;
            HasFullResolution = resolver.HasFullResolution(model);
            ExportBlockedReason = resolver.ExportBlockedReason(model) ?? "";

            // The FLAT COLOUR MAP, not the catalogue thumb: both catalogues render their thumbs on a
            // lit sphere, which tells a human nothing about how the texture tiles.
            var tile = resolver.ResolveTile(model);
            if (tile != null) {
                try { Thumbnail = new Bitmap(tile); }
                catch { Thumbnail = null; }
            }
        }
    }
}
