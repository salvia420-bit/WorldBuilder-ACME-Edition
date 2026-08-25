using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// The whole state machine behind the Texture Picker panel — worklist cursor, candidate
    /// selection, retail/candidate A-B toggle, repeat-factor stepper, and pick/skip persistence.
    ///
    /// Deliberately Avalonia-free so it can be unit-tested from WorldBuilder.Tests (which
    /// references WorldBuilder.Shared but not the GUI project). The ViewModel is a thin
    /// observable wrapper: it owns Bitmaps and PropertyChanged, this owns the decisions.
    /// </summary>
    public class TexturePickerSession {
        /// <summary>
        /// Canonical picker data directory for the X-track, resolved at run time by
        /// <see cref="TexturePickerPaths.PickerDirectory"/>. Deliberately NOT a <c>const</c>:
        /// a const path is baked into every consuming assembly's string heap and shipped to users.
        /// </summary>
        public static string DefaultPickerDirectory => TexturePickerPaths.PickerDirectory;
        public const string RecommendationsFileName = "picker-recommendations.json";
        public const string PicksFileName = "picker-picks.json";

        /// <summary>How many candidates the sidebar shows / the 1-5 hotkeys address.</summary>
        public const int SidebarCandidateCount = 5;

        private readonly List<PickerRow> _rows;
        private int _currentIndex;
        private int _selectedCandidateIndex = -1;
        private double? _repeatX = 1;
        private double? _repeatY = 1;

        public PickerRecommendations Recommendations { get; }
        public PickerPicksFile Picks { get; }
        public CandidateImageResolver Resolver { get; }

        /// <summary>Absolute path the picks file saves to. Null disables persistence (tests/design-time).</summary>
        public string? PicksPath { get; set; }

        /// <summary>Rows in worklist order (ascending x2Rank).</summary>
        public IReadOnlyList<PickerRow> Rows => _rows;

        public TexturePickerSession(
            PickerRecommendations recommendations,
            PickerPicksFile? picks = null,
            CandidateImageResolver? resolver = null) {
            Recommendations = recommendations ?? throw new ArgumentNullException(nameof(recommendations));
            Picks = picks ?? new PickerPicksFile();
            Resolver = resolver ?? new CandidateImageResolver();
            _rows = recommendations.RowsInWorklistOrder().ToList();
            SyncToRow();
        }

        /// <summary>Loads recommendations + picks from a picker directory. Null when no recommendations file.</summary>
        public static TexturePickerSession? LoadFromDirectory(string directory, CandidateImageResolver? resolver = null) {
            var recPath = System.IO.Path.Combine(directory, RecommendationsFileName);
            var recs = PickerRecommendations.Load(recPath);
            if (recs == null) return null;
            var picksPath = System.IO.Path.Combine(directory, PicksFileName);
            return new TexturePickerSession(recs, PickerPicksFile.Load(picksPath), resolver) {
                PicksPath = picksPath
            };
        }

        // ---- worklist cursor -------------------------------------------------------------

        public int CurrentIndex {
            get => _currentIndex;
            set {
                if (_rows.Count == 0) { _currentIndex = 0; return; }
                var clamped = Math.Clamp(value, 0, _rows.Count - 1);
                if (clamped == _currentIndex) return;
                _currentIndex = clamped;
                SyncToRow();
            }
        }

        public PickerRow? CurrentRow => _rows.Count == 0 ? null : _rows[_currentIndex];

        /// <summary>
        /// Resets per-row state when the cursor moves: top-ranked candidate selected, preview back
        /// on the candidate side, repeat reseeded. Callers that want to restore a previous decision
        /// (the ViewModel does) overwrite <see cref="SelectedCandidateIndex"/> afterwards.
        /// </summary>
        private void SyncToRow() {
            _selectedCandidateIndex = SidebarCandidates.Count > 0 ? 0 : -1;
            ShowRetail = false;
            SeedRepeatFromSelection();
        }

        public bool Next() {
            if (_currentIndex >= _rows.Count - 1) return false;
            CurrentIndex = _currentIndex + 1;
            return true;
        }

        public bool Prev() {
            if (_currentIndex <= 0) return false;
            CurrentIndex = _currentIndex - 1;
            return true;
        }

        /// <summary>Moves to the next row that has no decision yet. False when every row is decided.</summary>
        public bool NextUndecided() {
            for (int i = _currentIndex + 1; i < _rows.Count; i++) {
                if (!Picks.Picks.ContainsKey(_rows[i].RsId)) { CurrentIndex = i; return true; }
            }
            for (int i = 0; i <= _currentIndex && i < _rows.Count; i++) {
                if (!Picks.Picks.ContainsKey(_rows[i].RsId)) { CurrentIndex = i; return true; }
            }
            return false;
        }

        // ---- candidate selection ---------------------------------------------------------

        /// <summary>The top-N candidates the sidebar renders.</summary>
        public IReadOnlyList<PickerCandidate> SidebarCandidates =>
            CurrentRow?.Candidates.Take(SidebarCandidateCount).ToList()
            ?? (IReadOnlyList<PickerCandidate>)Array.Empty<PickerCandidate>();

        /// <summary>0-based index into <see cref="SidebarCandidates"/>; -1 when nothing is selected.</summary>
        public int SelectedCandidateIndex {
            get => _selectedCandidateIndex;
            set {
                var count = SidebarCandidates.Count;
                var clamped = (count == 0 || value < 0) ? -1 : Math.Min(value, count - 1);
                if (clamped == _selectedCandidateIndex) return;
                _selectedCandidateIndex = clamped;
                SeedRepeatFromSelection();
            }
        }

        public PickerCandidate? SelectedCandidate =>
            _selectedCandidateIndex >= 0 && _selectedCandidateIndex < SidebarCandidates.Count
                ? SidebarCandidates[_selectedCandidateIndex]
                : null;

        /// <summary>Selects by 1-based hotkey number (keys 1-5).</summary>
        public void SelectCandidateByHotkey(int oneBased) => SelectedCandidateIndex = oneBased - 1;

        // ---- preview ---------------------------------------------------------------------

        /// <summary>True while the preview shows the RETAIL texture (the A side of the A/B toggle).</summary>
        public bool ShowRetail { get; set; }

        public void ToggleRetail() => ShowRetail = !ShowRetail;

        /// <summary>Absolute path of the image the preview should tile right now, or null.</summary>
        public string? PreviewImagePath {
            get {
                if (ShowRetail) {
                    var retail = CurrentRow?.RetailPng;
                    return (!string.IsNullOrWhiteSpace(retail) && System.IO.File.Exists(retail)) ? retail : null;
                }
                return Resolver.ResolvePreview(SelectedCandidate);
            }
        }

        /// <summary>
        /// "Retail" / "Candidate (full-res)" / "Candidate (flat preview)" / "Candidate (sphere thumb!)"
        /// — surfaced in the panel header. The sphere-thumb case is called out because it is the one
        /// image a tiling judgement CANNOT be made from.
        /// </summary>
        public string PreviewSourceLabel {
            get {
                if (ShowRetail) return "Retail";
                var candidate = SelectedCandidate;
                if (candidate == null) return "No candidate";
                return Resolver.PreviewKind(candidate) switch {
                    CandidateImageKind.FullResolution => "Candidate (full-res)",
                    CandidateImageKind.FlatPreview => "Candidate (flat preview)",
                    CandidateImageKind.SphereThumb => "Candidate (sphere thumb!)",
                    _ => "Candidate (no image on disk)",
                };
            }
        }

        /// <summary>
        /// Export availability of the selected candidate, for the status line. Empty when it is
        /// shippable; otherwise "set not downloaded — …", which is exactly the set of picks
        /// <see cref="BuildExportEntries"/> leaves out of the bundle.
        /// </summary>
        public string SelectedAvailabilityText {
            get {
                var candidate = SelectedCandidate;
                if (candidate == null) return "";
                var blocked = Resolver.ExportBlockedReason(candidate);
                return blocked == null ? "" : blocked + " (pick is recorded, but excluded from export)";
            }
        }

        // ---- repeat stepper --------------------------------------------------------------

        public const double MinRepeat = 0.25;
        public const double MaxRepeat = 64.0;
        public const double RepeatStep = 0.25;

        /// <summary>
        /// Repeat on X, or NULL when the ranking pipeline declined to estimate this axis.
        /// A null axis is rendered "n/a", its stepper is disabled, and it persists as null — it is
        /// never coerced to 1.0, which would silently invent a tiling decision.
        /// </summary>
        public double? RepeatX {
            get => _repeatX;
            set => _repeatX = ClampRepeat(value);
        }

        public double? RepeatY {
            get => _repeatY;
            set => _repeatY = ClampRepeat(value);
        }

        /// <summary>False when the axis is n/a — the panel disables that stepper.</summary>
        public bool HasRepeatX => _repeatX.HasValue;
        public bool HasRepeatY => _repeatY.HasValue;

        /// <summary>What the preview should actually tile at; a null axis renders untiled (1×).</summary>
        public double EffectiveRepeatX => _repeatX ?? 1.0;
        public double EffectiveRepeatY => _repeatY ?? 1.0;

        public static double? ClampRepeat(double? v) {
            if (v == null) return null;
            if (!double.IsFinite(v.Value) || v.Value <= 0) return 1.0;
            return Math.Clamp(Math.Round(v.Value, 3), MinRepeat, MaxRepeat);
        }

        /// <summary>Stepping an n/a axis is a no-op — there is nothing to step from.</summary>
        public void StepRepeatX(double delta) { if (_repeatX.HasValue) RepeatX = _repeatX + delta; }
        public void StepRepeatY(double delta) { if (_repeatY.HasValue) RepeatY = _repeatY + delta; }

        /// <summary>
        /// Reseeds the stepper: an existing pick wins, then the selected candidate's repeatFactor,
        /// then the row's periodEstimate, then 1x1.
        ///
        /// Precedence is per-OBJECT, not per-axis: when a candidate carries a repeatFactor with a
        /// null axis, that null is the pipeline's answer for the axis and does NOT fall through to
        /// the row's periodEstimate.
        /// </summary>
        public void SeedRepeatFromSelection() {
            var row = CurrentRow;
            if (row == null) { _repeatX = _repeatY = 1; return; }

            if (Picks.Picks.TryGetValue(row.RsId, out var existing)
                && existing.RepeatFactor != null
                && (SelectedCandidate == null
                    || string.Equals(existing.AssetId, SelectedCandidate.AssetId, StringComparison.OrdinalIgnoreCase))) {
                _repeatX = ClampRepeat(existing.RepeatFactor.X);
                _repeatY = ClampRepeat(existing.RepeatFactor.Y);
                return;
            }

            var seed = SelectedCandidate?.RepeatFactor ?? row.PeriodEstimate;
            if (seed == null) { _repeatX = _repeatY = 1; return; }
            _repeatX = ClampRepeat(seed.X);
            _repeatY = ClampRepeat(seed.Y);
        }

        // ---- gain / tint -----------------------------------------------------------------

        /// <summary>Bake-time brightness gain bounds for the panel's numeric-up-down.</summary>
        public const double MinGain = 0.10;
        public const double MaxGain = 2.00;
        public const double GainStep = 0.05;

        /// <summary>
        /// Clamps a gain to the UI range and snaps it to the step, or passes null through
        /// (null = "leave the texture's brightness alone").
        /// </summary>
        public static double? ClampGain(double? gain) {
            if (gain == null) return null;
            if (!double.IsFinite(gain.Value)) return null;
            var snapped = Math.Round(gain.Value / GainStep) * GainStep;
            return Math.Round(Math.Clamp(snapped, MinGain, MaxGain), 4);
        }

        /// <summary>
        /// The seed the panel offers for gain: retail mean luminance / candidate mean luminance, so
        /// the replacement lands at the retail texture's overall brightness. Null when either
        /// luminance is unknown — the panel never invents a gain from an image it did not measure.
        /// </summary>
        public static double? SuggestGain(double? retailMeanLuminance, double? candidateMeanLuminance) {
            if (retailMeanLuminance == null || candidateMeanLuminance == null) return null;
            if (!(candidateMeanLuminance.Value > 1e-4)) return null;
            if (!(retailMeanLuminance.Value >= 0)) return null;
            return ClampGain(retailMeanLuminance.Value / candidateMeanLuminance.Value);
        }

        // ---- decisions -------------------------------------------------------------------

        /// <summary>
        /// Records a pick for the current row using the selected candidate + current repeat factor,
        /// then persists. Returns false when there is no row or no selected candidate.
        /// </summary>
        public bool PickCurrent(string? note = null, double? gain = null, double[]? tint = null) {
            var row = CurrentRow;
            var candidate = SelectedCandidate;
            if (row == null || candidate == null) return false;

            Picks.Picks[row.RsId] = new PickerPick {
                AssetId = candidate.AssetId,
                // A null axis persists as null: the bake must be able to tell "1× on purpose" from
                // "nobody ever decided this axis".
                RepeatFactor = new PickerVec2(_repeatX, _repeatY),
                Gain = ClampGain(gain),
                Tint = tint,
                Note = note,
                DecidedAt = PickerPick.NowStamp(),
                Skipped = false,
            };
            SavePicks();
            return true;
        }

        /// <summary>Records a skip for the current row and persists.</summary>
        public bool SkipCurrent(string? note = null) {
            var row = CurrentRow;
            if (row == null) return false;

            Picks.Picks[row.RsId] = new PickerPick {
                AssetId = null,
                RepeatFactor = null,
                Gain = null,
                Tint = null,
                Note = note,
                DecidedAt = PickerPick.NowStamp(),
                Skipped = true,
            };
            SavePicks();
            return true;
        }

        /// <summary>Removes any decision for the current row and persists.</summary>
        public bool ClearCurrent() {
            var row = CurrentRow;
            if (row == null || !Picks.Picks.Remove(row.RsId)) return false;
            SavePicks();
            return true;
        }

        public PickerPick? DecisionFor(PickerRow? row) =>
            row != null && Picks.Picks.TryGetValue(row.RsId, out var p) ? p : null;

        public PickerPick? CurrentDecision => DecisionFor(CurrentRow);

        public void SavePicks() {
            if (string.IsNullOrWhiteSpace(PicksPath)) return;
            Picks.Save(PicksPath!);
        }

        // ---- progress --------------------------------------------------------------------

        private HashSet<string> RowIds() =>
            new(_rows.Select(r => r.RsId), StringComparer.OrdinalIgnoreCase);

        public int PickedCount {
            get { var ids = RowIds(); return Picks.Picks.Count(kv => ids.Contains(kv.Key) && !kv.Value.Skipped); }
        }

        public int SkippedCount {
            get { var ids = RowIds(); return Picks.Picks.Count(kv => ids.Contains(kv.Key) && kv.Value.Skipped); }
        }

        public int RemainingCount => Math.Max(0, _rows.Count - PickedCount - SkippedCount);

        public string ProgressText =>
            string.Format(CultureInfo.InvariantCulture, "{0} picked · {1} skipped · {2} remaining ({3} rows)",
                PickedCount, SkippedCount, RemainingCount, _rows.Count);

        // ---- export ----------------------------------------------------------------------

        /// <summary>
        /// Materializes the picked rows into export entries (did -&gt; full-res diffuse path).
        ///
        /// Excludes every pick with no locally available full-res set — v0 never downloads, and
        /// PolyHaven sets were never downloaded at all. A flat preview or a sphere thumb is NOT a
        /// shippable diffuse: shipping one would look like a bake regression, so those picks are
        /// reported in <paramref name="unavailable"/> ("set not downloaded — …") and left out.
        /// </summary>
        public IReadOnlyList<TexOverrideEntry> BuildExportEntries(out IReadOnlyList<string> unavailable) {
            var entries = new List<TexOverrideEntry>();
            var missing = new List<string>();
            foreach (var row in _rows) {
                if (!Picks.Picks.TryGetValue(row.RsId, out var pick)) continue;
                if (pick.Skipped || string.IsNullOrWhiteSpace(pick.AssetId)) continue;

                // Resolve through the candidate when we can, so the resolver knows the SOURCE and can
                // short-circuit polyhaven instead of probing the ambientCG sets root with an id that
                // was never a set directory name.
                var candidate = row.Candidates.FirstOrDefault(
                    c => string.Equals(c.AssetId, pick.AssetId, StringComparison.OrdinalIgnoreCase));

                var src = candidate != null
                    ? Resolver.ResolveFullResolution(candidate)
                    : Resolver.ResolveFullResolution(pick.AssetId);
                if (src == null) {
                    var reason = candidate != null
                        ? Resolver.ExportBlockedReason(candidate)
                        : "set not downloaded — no local full-res set";
                    missing.Add($"{row.RsId} -> {pick.AssetId} ({reason})");
                    continue;
                }
                entries.Add(new TexOverrideEntry(row.RsId, src));
            }
            unavailable = missing;
            return entries;
        }
    }
}
