using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DatReaderWriter.DBObjs;
using System;
using System.Collections.ObjectModel;
using System.Linq;
using WorldBuilder.Lib.Settings;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Models;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Experience {
    public partial class XpRow : ObservableObject {
        [ObservableProperty] private int _index;
        [ObservableProperty] private string _value = "0";

        public XpRow(int index, string value) {
            _index = index;
            _value = value;
        }
    }

    public partial class LevelRow : ObservableObject {
        [ObservableProperty] private int _level;
        [ObservableProperty] private string _xpRequired = "0";
        [ObservableProperty] private string _skillCredits = "0";

        public LevelRow(int level, string xp, string credits) {
            _level = level;
            _xpRequired = xp;
            _skillCredits = credits;
        }
    }

    public partial class ExperienceEditorViewModel : ViewModelBase {
        private IDatReaderWriter? _dats;
        private Project? _project;
        private PortalDatDocument? _portalDoc;
        private ExperienceTable? _table;
        private const uint ExperienceTableId = 0x0E000018;

        [ObservableProperty] private string _statusText = "No experience table loaded";
        [ObservableProperty] private int _selectedTabIndex;
        [ObservableProperty] private bool _isAutoScaleOpen;

        [ObservableProperty] private ObservableCollection<LevelRow> _levels = new();
        [ObservableProperty] private ObservableCollection<XpRow> _attributes = new();
        [ObservableProperty] private ObservableCollection<XpRow> _vitals = new();
        [ObservableProperty] private ObservableCollection<XpRow> _trainedSkills = new();
        [ObservableProperty] private ObservableCollection<XpRow> _specializedSkills = new();

        [ObservableProperty] private string _autoScaleTotalLevels = "275";
        [ObservableProperty] private string _autoScaleBaseXp = "1000";
        [ObservableProperty] private string _autoScaleGrowthRate = "2.5";
        [ObservableProperty] private string _autoScaleCreditsEveryN = "5";
        [ObservableProperty] private string _autoScaleAttributeRanks = "190";
        [ObservableProperty] private string _autoScaleVitalRanks = "196";
        [ObservableProperty] private string _autoScaleSkillRanks = "226";

        partial void OnAutoScaleTotalLevelsChanged(string value) {
            if (!int.TryParse(value, out int levels) || levels < 1) return;
            double scale = (double)levels / 275.0;
            AutoScaleAttributeRanks = Math.Max(10, (int)(190 * scale)).ToString();
            AutoScaleVitalRanks = Math.Max(10, (int)(196 * scale)).ToString();
            AutoScaleSkillRanks = Math.Max(10, (int)(226 * scale)).ToString();
        }

        public WorldBuilderSettings Settings { get; }

        public ExperienceEditorViewModel(WorldBuilderSettings settings) {
            Settings = settings;
        }

        internal void Init(Project project) {
            _project = project;
            _dats = project.DocumentManager.Dats;
            _portalDoc = project.DocumentManager.GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId).Result;
            LoadTable();
        }

        private void LoadTable() {
            if (_dats == null) return;

            if (_portalDoc != null && _portalDoc.TryGetEntry<ExperienceTable>(ExperienceTableId, out var docTable) && docTable != null) {
                _table = docTable;
            }
            else if (!_dats.TryGet<ExperienceTable>(ExperienceTableId, out var datTable)) {
                StatusText = "Failed to load ExperienceTable (0x0E000018) from DAT";
                return;
            }
            else {
                _table = datTable;
            }

            PopulateCollections();
            StatusText = $"Loaded: {_table.Levels.Length} levels, {_table.Attributes.Length} attribute ranks, " +
                         $"{_table.Vitals.Length} vital ranks, {_table.TrainedSkills.Length} trained, " +
                         $"{_table.SpecializedSkills.Length} specialized";
        }

        private void PopulateCollections() {
            if (_table == null) return;

            Levels.Clear();
            int levelCount = _table.Levels.Length;
            int creditCount = _table.SkillCredits.Length;
            for (int i = 0; i < levelCount; i++) {
                var credits = i < creditCount ? _table.SkillCredits[i].ToString() : "0";
                Levels.Add(new LevelRow(i, _table.Levels[i].ToString(), credits));
            }

            Attributes.Clear();
            for (int i = 0; i < _table.Attributes.Length; i++)
                Attributes.Add(new XpRow(i, _table.Attributes[i].ToString()));

            Vitals.Clear();
            for (int i = 0; i < _table.Vitals.Length; i++)
                Vitals.Add(new XpRow(i, _table.Vitals[i].ToString()));

            TrainedSkills.Clear();
            for (int i = 0; i < _table.TrainedSkills.Length; i++)
                TrainedSkills.Add(new XpRow(i, _table.TrainedSkills[i].ToString()));

            SpecializedSkills.Clear();
            for (int i = 0; i < _table.SpecializedSkills.Length; i++)
                SpecializedSkills.Add(new XpRow(i, _table.SpecializedSkills[i].ToString()));
        }

        [RelayCommand]
        private void AddLevel() {
            int nextLevel = Levels.Count;
            Levels.Add(new LevelRow(nextLevel, "0", "0"));
            StatusText = $"Added level {nextLevel} (total: {Levels.Count})";
        }

        [RelayCommand]
        private void RemoveLevel() {
            if (Levels.Count <= 1) {
                StatusText = "Cannot remove the last level";
                return;
            }
            int removed = Levels.Count - 1;
            Levels.RemoveAt(removed);
            StatusText = $"Removed level {removed} (total: {Levels.Count})";
        }

        [RelayCommand]
        private void AddRank() {
            ObservableCollection<XpRow>? collection = GetActiveRankCollection();
            if (collection == null) {
                StatusText = "Select a rank tab (Attributes, Vitals, Trained, or Specialized)";
                return;
            }
            int nextIndex = collection.Count;
            collection.Add(new XpRow(nextIndex, "0"));
            StatusText = $"Added rank {nextIndex} to {GetActiveTabName()}";
        }

        [RelayCommand]
        private void RemoveRank() {
            ObservableCollection<XpRow>? collection = GetActiveRankCollection();
            if (collection == null) {
                StatusText = "Select a rank tab (Attributes, Vitals, Trained, or Specialized)";
                return;
            }
            if (collection.Count <= 1) {
                StatusText = $"Cannot remove the last rank from {GetActiveTabName()}";
                return;
            }
            int removed = collection.Count - 1;
            collection.RemoveAt(removed);
            StatusText = $"Removed rank {removed} from {GetActiveTabName()}";
        }

        [RelayCommand]
        private void ToggleAutoScale() {
            IsAutoScaleOpen = !IsAutoScaleOpen;
        }

        private static ulong SafePow(double baseVal, double exp, int i) {
            if (i == 0) return 0;
            double val = baseVal * Math.Pow(i, exp);
            return val > (double)ulong.MaxValue ? ulong.MaxValue : (ulong)val;
        }

        private static uint SafePowUint(double baseVal, double exp, int i) {
            if (i == 0) return 0;
            double val = baseVal * Math.Pow(i, exp);
            return val > uint.MaxValue ? uint.MaxValue : (uint)val;
        }

        [RelayCommand]
        private void GenerateAutoScale() {
            if (!int.TryParse(AutoScaleTotalLevels, out int totalLevels) || totalLevels < 1) {
                StatusText = "Invalid total levels"; return;
            }
            if (!double.TryParse(AutoScaleBaseXp, out double baseXp) || baseXp < 1) {
                StatusText = "Invalid base XP"; return;
            }
            if (!double.TryParse(AutoScaleGrowthRate, out double exponent) || exponent < 1.0) {
                StatusText = "Exponent must be >= 1.0"; return;
            }
            if (!int.TryParse(AutoScaleCreditsEveryN, out int creditsEveryN) || creditsEveryN < 1) {
                StatusText = "Credits-every-N must be >= 1"; return;
            }

            // Levels + Skill Credits
            Levels.Clear();
            for (int i = 0; i < totalLevels; i++) {
                ulong xp = SafePow(baseXp, exponent, i);
                uint credits = (i > 0 && i % creditsEveryN == 0) ? 1u : 0u;
                Levels.Add(new LevelRow(i, xp.ToString(), credits.ToString()));
            }

            // Attribute, Vital, Skill rank tables
            int attrRanks = 190, vitalRanks = 196, skillRanks = 226;
            int.TryParse(AutoScaleAttributeRanks, out attrRanks);
            int.TryParse(AutoScaleVitalRanks, out vitalRanks);
            int.TryParse(AutoScaleSkillRanks, out skillRanks);
            if (attrRanks < 1) attrRanks = 190;
            if (vitalRanks < 1) vitalRanks = 196;
            if (skillRanks < 1) skillRanks = 226;

            double attrBase = baseXp * 0.25;
            var newAttrs = new ObservableCollection<XpRow>();
            for (int i = 0; i < attrRanks; i++)
                newAttrs.Add(new XpRow(i, SafePowUint(attrBase, exponent, i).ToString()));
            Attributes = newAttrs;

            double vitalBase = baseXp * 0.2;
            var newVitals = new ObservableCollection<XpRow>();
            for (int i = 0; i < vitalRanks; i++)
                newVitals.Add(new XpRow(i, SafePowUint(vitalBase, exponent, i).ToString()));
            Vitals = newVitals;

            double trainedBase = baseXp * 0.33;
            var newTrained = new ObservableCollection<XpRow>();
            for (int i = 0; i < skillRanks; i++)
                newTrained.Add(new XpRow(i, SafePowUint(trainedBase, exponent, i).ToString()));
            TrainedSkills = newTrained;

            double specBase = baseXp * 0.2;
            var newSpec = new ObservableCollection<XpRow>();
            for (int i = 0; i < skillRanks; i++)
                newSpec.Add(new XpRow(i, SafePowUint(specBase, exponent, i).ToString()));
            SpecializedSkills = newSpec;

            StatusText = $"Generated all: {totalLevels} levels, {attrRanks} attr, {vitalRanks} vital, {skillRanks} skill ranks";
        }

        private ObservableCollection<XpRow>? GetActiveRankCollection() {
            return SelectedTabIndex switch {
                1 => Attributes,
                2 => Vitals,
                3 => TrainedSkills,
                4 => SpecializedSkills,
                _ => null
            };
        }

        private string GetActiveTabName() {
            return SelectedTabIndex switch {
                1 => "Attributes",
                2 => "Vitals",
                3 => "Trained Skills",
                4 => "Specialized Skills",
                _ => "Unknown"
            };
        }

        [RelayCommand]
        private void Save() {
            if (_table == null || _portalDoc == null) {
                StatusText = "Nothing to save";
                return;
            }

            try {
                _table.Levels = new ulong[Levels.Count];
                _table.SkillCredits = new uint[Levels.Count];
                for (int i = 0; i < Levels.Count; i++) {
                    _table.Levels[i] = ulong.TryParse(Levels[i].XpRequired, out var xp) ? xp : 0;
                    _table.SkillCredits[i] = uint.TryParse(Levels[i].SkillCredits, out var sc) ? sc : 0;
                }

                _table.Attributes = new uint[Attributes.Count];
                for (int i = 0; i < Attributes.Count; i++)
                    _table.Attributes[i] = uint.TryParse(Attributes[i].Value, out var v) ? v : 0;

                _table.Vitals = new uint[Vitals.Count];
                for (int i = 0; i < Vitals.Count; i++)
                    _table.Vitals[i] = uint.TryParse(Vitals[i].Value, out var v) ? v : 0;

                _table.TrainedSkills = new uint[TrainedSkills.Count];
                for (int i = 0; i < TrainedSkills.Count; i++)
                    _table.TrainedSkills[i] = uint.TryParse(TrainedSkills[i].Value, out var v) ? v : 0;

                _table.SpecializedSkills = new uint[SpecializedSkills.Count];
                for (int i = 0; i < SpecializedSkills.Count; i++)
                    _table.SpecializedSkills[i] = uint.TryParse(SpecializedSkills[i].Value, out var v) ? v : 0;

                _portalDoc.SetEntry(ExperienceTableId, _table);
                StatusText = $"Saved: {Levels.Count} levels, {Attributes.Count} attr, " +
                             $"{Vitals.Count} vital, {TrainedSkills.Count} trained, " +
                             $"{SpecializedSkills.Count} specialized. Use File > Export to write DATs.";
            }
            catch (Exception ex) {
                StatusText = $"Save error: {ex.Message}";
            }
        }
    }
}
