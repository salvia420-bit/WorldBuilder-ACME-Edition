using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using WorldBuilder.Lib;
using WorldBuilder.Lib.Settings;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;
using WorldBuilder.Shared.Models;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Monster {

    /// <summary>One texture slot on a specific body part — maps to one weenie_properties_texture_map row.</summary>
    public partial class SurfaceOverrideVm : ObservableObject {
        public byte PartIndex { get; init; }
        /// <summary>SurfaceTexture DID (0x05...) — goes in old_Id column.</summary>
        public uint OriginalTextureId { get; init; }
        public string OriginalLabel => "0x" + OriginalTextureId.ToString("X8", CultureInfo.InvariantCulture);

        [ObservableProperty] private WriteableBitmap? _originalThumbnail;
        [ObservableProperty] private string _replacementHex = "";
        [ObservableProperty] private WriteableBitmap? _replacementThumbnail;
        [ObservableProperty] private bool _isActive;
        public string Comment { get; set; } = "";

        public bool HasReplacement =>
            !string.IsNullOrWhiteSpace(ReplacementHex) && TryParseUInt(ReplacementHex, out _);

        static bool TryParseUInt(string s, out uint v) {
            s = s.Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return uint.TryParse(s.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
            return uint.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
        }
    }

    /// <summary>One part card — groups all surface texture slots for a single part index.</summary>
    public partial class PartGroupVm : ObservableObject {
        public byte PartIndex { get; init; }
        public uint GfxObjId { get; init; }
        public string PartLabel => $"Part {PartIndex}";
        public string GfxObjLabel => "0x" + GfxObjId.ToString("X8", CultureInfo.InvariantCulture);

        [ObservableProperty] private bool _isRemoved;
        /// <summary>
        /// When set, replaces this part's GfxObj with the given DID (mix-and-match donor part).
        /// Generates a weenie_properties_anim_part row.
        /// </summary>
        [ObservableProperty] private string _donorGfxObjHex = "";
        [ObservableProperty] private string _donorLabel = "";

        public ObservableCollection<SurfaceOverrideVm> Surfaces { get; } = new();

        public bool HasAnyOverride => IsRemoved || !string.IsNullOrWhiteSpace(DonorGfxObjHex) || Surfaces.Any(s => s.HasReplacement);
    }

    /// <summary>One item in the SurfaceTexture browser panel (0x05... IDs).</summary>
    public partial class SurfaceTextureItem : ObservableObject {
        public uint FullId { get; }
        public string DisplayId => "0x" + FullId.ToString("X8", CultureInfo.InvariantCulture);
        [ObservableProperty] private WriteableBitmap? _thumbnail;
        public SurfaceTextureItem(uint id) => FullId = id;
    }

    /// <summary>Creature list entry for the Monster Creator picker.</summary>
    public partial class MonsterListEntryVm : ObservableObject {
        public uint ClassId { get; }
        public string Name { get; }
        public uint SetupId { get; }
        public string Subtitle => $"WCID {ClassId}  •  Setup 0x{SetupId:X8}";
        public MonsterListEntryVm(uint classId, string name, uint setupId) {
            ClassId = classId; Name = name; SetupId = setupId;
        }
    }

    /// <summary>
    /// Monster Creator editor: browse creatures, see their body parts as visual cards with
    /// texture thumbnails, pick replacement textures from the inline browser, and apply/export SQL.
    /// The 3D preview re-renders live with overrides applied.
    /// </summary>
    public partial class MonsterEditorViewModel : ViewModelBase {
        private Project? _project;
        private IDatReaderWriter? _dats;

        private uint[] _allTextureIds = Array.Empty<uint>();
        private int _browserDisplayCount = 300;

        public WorldBuilderSettings Settings { get; }

        public MonsterEditorViewModel(WorldBuilderSettings settings) {
            Settings = settings;
        }

        // Creature picker
        [ObservableProperty] private string _statusText = "Configure ACE database in Settings, then search for a base creature.";
        [ObservableProperty] private string _searchText = "";
        [ObservableProperty] private bool _isBusy;
        [ObservableProperty] private ObservableCollection<MonsterListEntryVm> _weenies = new();
        [ObservableProperty] private MonsterListEntryVm? _selectedWeenie;
        [ObservableProperty] private string _targetObjectId = "";

        // Part cards
        [ObservableProperty] private ObservableCollection<PartGroupVm> _partGroups = new();
        [ObservableProperty] private string _datPartsStatus = "Select a creature to load its body parts.";
        [ObservableProperty] private bool _isDatLoading;

        // Live preview
        [ObservableProperty] private uint _previewSetupDid;
        [ObservableProperty] private Dictionary<uint, uint>? _previewTextureOverrides;
        [ObservableProperty] private HashSet<int>? _previewHiddenParts;
        [ObservableProperty] private Dictionary<int, uint>? _previewGfxObjRemapping;

        // Donor creature (mix & match parts)
        [ObservableProperty] private string _donorSearchText = "";
        [ObservableProperty] private bool _isDonorBusy;
        [ObservableProperty] private ObservableCollection<MonsterListEntryVm> _donorWeenies = new();
        [ObservableProperty] private MonsterListEntryVm? _selectedDonorWeenie;
        [ObservableProperty] private ObservableCollection<PartGroupVm> _donorPartGroups = new();
        [ObservableProperty] private string _donorPartsStatus = "Search a creature above to browse its parts.";
        [ObservableProperty] private bool _isDonorDatLoading;
        [ObservableProperty] private PartGroupVm? _selectedDonorPart;
        [ObservableProperty] private string _selectedDonorLabel = "Select a donor part, then click 'Apply' on a target part above";

        // SQL
        [ObservableProperty] private string _sqlOutput = "";

        // Active slot (target for browser picks)
        [ObservableProperty] private SurfaceOverrideVm? _activeSlot;
        [ObservableProperty] private string _activeSlotLabel = "Select a part slot to target texture browser";

        // Texture browser
        [ObservableProperty] private string _browserSearchText = "";
        [ObservableProperty] private ObservableCollection<SurfaceTextureItem> _browserItems = new();
        [ObservableProperty] private string _browserStatus = "Loading textures…";
        [ObservableProperty] private bool _canLoadMoreBrowser;

        internal void Init(Project project) {
            _project = project;
            _dats = project.DatReaderWriter;
            _ = LoadBrowserItemsAsync();
        }

        partial void OnBrowserSearchTextChanged(string _) => ApplyBrowserFilter();

        partial void OnActiveSlotChanged(SurfaceOverrideVm? value) {
            ActiveSlotLabel = value == null
                ? "Select a part slot to target texture browser"
                : $"Targeting: Part {value.PartIndex}  ·  {value.OriginalLabel}";
        }

        // ─── Creature Search ────────────────────────────────────────────────────

        [RelayCommand]
        private async Task SearchWeeniesAsync() {
            if (Settings?.AceDbConnection == null) { StatusText = "Configure ACE Database in Settings first."; return; }

            IsBusy = true;
            StatusText = "Loading weenie list…";
            Weenies.Clear();
            SelectedWeenie = null;
            ClearDetail();

            try {
                var aceSettings = Settings.AceDbConnection.ToAceDbSettings();
                using var connector = new AceDbConnector(aceSettings);
                var search = string.IsNullOrWhiteSpace(SearchText) ? null : SearchText.Trim();
                var list = await connector.GetWeenieNamesAsync(search, limit: 2500);
                foreach (var e in list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                    Weenies.Add(new MonsterListEntryVm(e.ClassId, e.Name, e.SetupId));
                StatusText = list.Count == 0 ? "No weenies matched." : $"{list.Count} weenies. Select one to load its parts.";
            }
            catch (Exception ex) { StatusText = "Error: " + ex.Message; }
            finally { IsBusy = false; }
        }

        partial void OnSelectedWeenieChanged(MonsterListEntryVm? value) {
            if (value == null) return;
            TargetObjectId = value.ClassId.ToString(CultureInfo.InvariantCulture);
            PreviewSetupDid = value.SetupId;
            _ = LoadCreatureAsync(value);
        }

        async Task LoadCreatureAsync(MonsterListEntryVm entry) {
            ClearDetail();
            PreviewSetupDid = entry.SetupId;

            // Load DB overrides first so we can match them when DAT parts arrive
            List<AceTextureMapRow>? dbTexRows = null;
            List<AceAnimPartRow>? dbAnimRows = null;

            if (Settings?.AceDbConnection != null) {
                StatusText = $"Loading overrides for WCID {entry.ClassId}…";
                try {
                    var aceSettings = Settings.AceDbConnection.ToAceDbSettings();
                    using var connector = new AceDbConnector(aceSettings);
                    var overrides = await connector.LoadCreatureOverridesAsync(entry.ClassId);
                    dbTexRows = overrides.TextureMap;
                    dbAnimRows = overrides.AnimParts;
                    StatusText = $"{entry.Name} — WCID {entry.ClassId}";
                }
                catch (Exception ex) { StatusText = "DB load failed: " + ex.Message; }
            }

            await LoadDatPartsAsync(entry.SetupId, dbTexRows, dbAnimRows);
            RegenerateSql();
        }

        // ─── DAT Parts Loading ────────────────────────────────────────────────

        async Task LoadDatPartsAsync(uint setupDid,
            List<AceTextureMapRow>? dbTexRows,
            List<AceAnimPartRow>? dbAnimRows) {

            if (setupDid == 0) { DatPartsStatus = "No Setup DID — this weenie has no 3D model."; return; }
            if (_dats == null) { DatPartsStatus = "DAT files not loaded. Open a project first."; return; }

            IsDatLoading = true;
            DatPartsStatus = "Reading Setup from DAT…";
            var dats = _dats;

            var result = await Task.Run(() => {
                var groups = new List<PartGroupVm>();
                if (!dats.TryGet<Setup>(setupDid, out var setup) || setup?.Parts == null)
                    return (null, $"Setup 0x{setupDid:X8} not found in DAT.");

                for (int i = 0; i < setup.Parts.Count; i++) {
                    uint gfxObjId = setup.Parts[i];
                    if (!dats.TryGet<GfxObj>(gfxObjId, out var gfxObj) || gfxObj?.Polygons == null) continue;

                    var group = new PartGroupVm { PartIndex = (byte)i, GfxObjId = gfxObjId };
                    var seen = new HashSet<uint>();

                    foreach (var poly in gfxObj.Polygons.Values) {
                        if (poly.Stippling == StipplingType.NoPos) continue;
                        int si = poly.PosSurface;
                        if (si < 0 || si >= gfxObj.Surfaces.Count) continue;

                        uint surfaceId = gfxObj.Surfaces[si]; // 0x08...
                        if (!seen.Add(surfaceId)) continue;

                        if (!dats.TryGet<Surface>(surfaceId, out var surface) || surface == null) continue;
                        if (surface.Type.HasFlag(SurfaceType.Base1Solid)) continue;

                        uint texId = surface.OrigTextureId; // 0x05... — this is old_Id in texture_map
                        if (texId == 0) continue;

                        group.Surfaces.Add(new SurfaceOverrideVm {
                            PartIndex = (byte)i,
                            OriginalTextureId = texId,
                        });
                    }

                    if (group.Surfaces.Count > 0)
                        groups.Add(group);
                }

                var status = $"{setup.Parts.Count} part(s), {groups.Sum(g => g.Surfaces.Count)} surface slot(s) loaded.";
                return (groups, status);
            });

            IsDatLoading = false;

            if (result.Item1 == null) {
                DatPartsStatus = result.Item2;
                return;
            }

            foreach (var group in result.Item1) {
                // Apply matching DB anim_part overrides
                if (dbAnimRows?.Any(r => r.Index == group.PartIndex && r.AnimationId == 0x010001EC) == true)
                    group.IsRemoved = true;

                // Apply matching DB texture overrides
                foreach (var surf in group.Surfaces) {
                    var match = dbTexRows?.FirstOrDefault(r => r.Index == surf.PartIndex && r.OldId == surf.OriginalTextureId);
                    if (match != null) {
                        surf.ReplacementHex = "0x" + match.NewId.ToString("X8", CultureInfo.InvariantCulture);
                        surf.Comment = match.Comment;
                    }
                    SubscribeSurface(surf);
                }

                PartGroups.Add(group);
            }

            DatPartsStatus = result.Item2;
            _ = LoadOriginalThumbnailsAsync();
            _ = LoadReplacementThumbnailsForExistingAsync();
            RebuildPreviewOverrides();
        }

        void SubscribeSurface(SurfaceOverrideVm surf) {
            surf.PropertyChanged += (_, e) => {
                if (e.PropertyName == nameof(SurfaceOverrideVm.ReplacementHex)) {
                    _ = LoadReplacementThumbnailAsync(surf);
                    RebuildPreviewOverrides();
                    RegenerateSql();
                }
            };
        }

        async Task LoadOriginalThumbnailsAsync() {
            var dats = _dats;
            if (dats == null) return;
            foreach (var group in PartGroups.ToArray()) {
                foreach (var surf in group.Surfaces.ToArray()) {
                    if (surf.OriginalThumbnail != null) continue;
                    var id = surf.OriginalTextureId;
                    var bmp = await Task.Run(() => DatIconLoader.LoadSurfaceTextureIcon(dats, id, 64));
                    surf.OriginalThumbnail = bmp;
                }
            }
        }

        async Task LoadReplacementThumbnailsForExistingAsync() {
            foreach (var group in PartGroups.ToArray())
                foreach (var surf in group.Surfaces.ToArray())
                    if (surf.HasReplacement)
                        await LoadReplacementThumbnailAsync(surf);
        }

        async Task LoadReplacementThumbnailAsync(SurfaceOverrideVm surf) {
            if (!TryParseUInt(surf.ReplacementHex, out var id)) {
                surf.ReplacementThumbnail = null;
                return;
            }
            var dats = _dats;
            if (dats == null) return;
            var bmp = await Task.Run(() => DatIconLoader.LoadSurfaceTextureIcon(dats, id, 64));
            surf.ReplacementThumbnail = bmp;
        }

        // ─── Part/Slot Commands ───────────────────────────────────────────────

        [RelayCommand]
        private void ActivatePart(PartGroupVm? group) {
            if (group == null) return;
            var first = group.Surfaces.FirstOrDefault();
            if (first != null) ActivateSlot(first);
        }

        [RelayCommand]
        private void ActivateSlot(SurfaceOverrideVm? slot) {
            if (ActiveSlot != null) ActiveSlot.IsActive = false;
            ActiveSlot = slot;
            if (slot != null) slot.IsActive = true;
        }

        [RelayCommand]
        private void PickTexture(SurfaceTextureItem? item) {
            if (item == null || ActiveSlot == null) return;
            ActiveSlot.ReplacementHex = item.DisplayId;
            if (item.Thumbnail != null) ActiveSlot.ReplacementThumbnail = item.Thumbnail;
            else _ = LoadReplacementThumbnailAsync(ActiveSlot);
        }

        [RelayCommand]
        private void ClearSlot(SurfaceOverrideVm? slot) {
            if (slot == null) return;
            slot.ReplacementHex = "";
            slot.ReplacementThumbnail = null;
        }

        [RelayCommand]
        private void ToggleRemovePart(PartGroupVm? group) {
            if (group == null) return;
            group.IsRemoved = !group.IsRemoved;
            if (group.IsRemoved) group.DonorGfxObjHex = ""; // clear donor when hiding
            RebuildPreviewOverrides();
            RegenerateSql();
        }

        // ─── Donor / Mix & Match ─────────────────────────────────────────

        [RelayCommand]
        private async Task SearchDonorWeeniesAsync() {
            if (Settings?.AceDbConnection == null) { DonorPartsStatus = "Configure ACE Database in Settings first."; return; }
            IsDonorBusy = true;
            DonorWeenies.Clear();
            DonorPartGroups.Clear();
            SelectedDonorWeenie = null;
            DonorPartsStatus = "Searching…";
            try {
                var aceSettings = Settings.AceDbConnection.ToAceDbSettings();
                using var connector = new AceDbConnector(aceSettings);
                var search = string.IsNullOrWhiteSpace(DonorSearchText) ? null : DonorSearchText.Trim();
                var list = await connector.GetWeenieNamesAsync(search, limit: 1000);
                foreach (var e in list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
                    DonorWeenies.Add(new MonsterListEntryVm(e.ClassId, e.Name, e.SetupId));
                DonorPartsStatus = list.Count == 0 ? "No matches." : $"{list.Count} creatures found.";
            }
            catch (Exception ex) { DonorPartsStatus = "Error: " + ex.Message; }
            finally { IsDonorBusy = false; }
        }

        partial void OnSelectedDonorWeenieChanged(MonsterListEntryVm? value) {
            SelectedDonorPart = null;
            if (value == null) return;
            _ = LoadDonorPartsAsync(value);
        }

        async Task LoadDonorPartsAsync(MonsterListEntryVm donor) {
            DonorPartGroups.Clear();
            if (donor.SetupId == 0) { DonorPartsStatus = $"{donor.Name} has no 3D model."; return; }
            if (_dats == null) return;

            IsDonorDatLoading = true;
            DonorPartsStatus = $"Loading parts for {donor.Name}…";
            var dats = _dats;

            var result = await Task.Run(() => {
                var groups = new List<PartGroupVm>();
                if (!dats.TryGet<Setup>(donor.SetupId, out var setup) || setup?.Parts == null)
                    return (null, $"Setup 0x{donor.SetupId:X8} not found.");
                for (int i = 0; i < setup.Parts.Count; i++) {
                    uint gfxObjId = setup.Parts[i];
                    if (!dats.TryGet<GfxObj>(gfxObjId, out var gfxObj) || gfxObj?.Polygons == null) continue;
                    var group = new PartGroupVm { PartIndex = (byte)i, GfxObjId = gfxObjId };
                    var seen = new HashSet<uint>();
                    foreach (var poly in gfxObj.Polygons.Values) {
                        if (poly.Stippling == StipplingType.NoPos) continue;
                        int si = poly.PosSurface;
                        if (si < 0 || si >= gfxObj.Surfaces.Count) continue;
                        uint surfaceId = gfxObj.Surfaces[si];
                        if (!seen.Add(surfaceId)) continue;
                        if (!dats.TryGet<Surface>(surfaceId, out var surface) || surface == null) continue;
                        if (surface.Type.HasFlag(SurfaceType.Base1Solid)) continue;
                        uint texId = surface.OrigTextureId;
                        if (texId == 0) continue;
                        group.Surfaces.Add(new SurfaceOverrideVm { PartIndex = (byte)i, OriginalTextureId = texId });
                    }
                    if (group.Surfaces.Count > 0) groups.Add(group);
                }
                return (groups, $"{setup.Parts.Count} part(s) from {donor.Name}. Click a part to swap it onto the current creature.");
            });

            IsDonorDatLoading = false;
            if (result.Item1 == null) { DonorPartsStatus = result.Item2; return; }
            foreach (var g in result.Item1) DonorPartGroups.Add(g);
            DonorPartsStatus = result.Item2;

            // Load donor thumbnails in background
            _ = LoadDonorThumbnailsAsync(result.Item1);
        }

        async Task LoadDonorThumbnailsAsync(List<PartGroupVm> groups) {
            var dats = _dats;
            if (dats == null) return;
            foreach (var group in groups) {
                foreach (var surf in group.Surfaces.ToArray()) {
                    if (surf.OriginalThumbnail != null) continue;
                    var id = surf.OriginalTextureId;
                    var bmp = await Task.Run(() => DatIconLoader.LoadSurfaceTextureIcon(dats, id, 56));
                    surf.OriginalThumbnail = bmp;
                }
            }
        }

        /// <summary>
        /// Marks a donor part as the active selection for cross-index swapping.
        /// After calling this, the user can click "Apply" on any target part card.
        /// </summary>
        [RelayCommand]
        private void SelectDonorPart(PartGroupVm? donorPart) {
            SelectedDonorPart = donorPart;
            SelectedDonorLabel = donorPart == null
                ? "Select a donor part, then click 'Apply' on a target part above"
                : $"Selected: Part {donorPart.PartIndex} · {donorPart.GfxObjLabel}  from {SelectedDonorWeenie?.Name ?? "?"} — click 'Apply' on any part card";
        }

        /// <summary>
        /// Applies the currently selected donor part's GfxObj to the given target part
        /// — regardless of part index. This is what enables cross-index mixing.
        /// </summary>
        [RelayCommand]
        private void ApplySelectedDonorToPart(PartGroupVm? targetGroup) {
            if (targetGroup == null || SelectedDonorPart == null) return;
            targetGroup.IsRemoved = false;
            targetGroup.DonorGfxObjHex = SelectedDonorPart.GfxObjLabel;
            targetGroup.DonorLabel = $"Part {SelectedDonorPart.PartIndex} from {SelectedDonorWeenie?.Name ?? "donor"}";
            RebuildPreviewOverrides();
            RegenerateSql();
            StatusText = $"Applied {SelectedDonorWeenie?.Name} Part {SelectedDonorPart.PartIndex} ({SelectedDonorPart.GfxObjLabel}) → Part {targetGroup.PartIndex}";
        }

        [RelayCommand]
        private void ClearDonorPart(PartGroupVm? group) {
            if (group == null) return;
            group.DonorGfxObjHex = "";
            group.DonorLabel = "";
            RebuildPreviewOverrides();
            RegenerateSql();
        }

        // ─── Preview / SQL ────────────────────────────────────────────────────

        void RebuildPreviewOverrides() {
            var texMap = new Dictionary<uint, uint>();
            var hidden = new HashSet<int>();
            var gfxMap = new Dictionary<int, uint>();

            foreach (var group in PartGroups) {
                if (group.IsRemoved) {
                    hidden.Add(group.PartIndex);
                    continue;
                }
                if (!string.IsNullOrWhiteSpace(group.DonorGfxObjHex) && TryParseUInt(group.DonorGfxObjHex, out var gfxId))
                    gfxMap[group.PartIndex] = gfxId;

                foreach (var surf in group.Surfaces) {
                    if (!surf.HasReplacement) continue;
                    if (!TryParseUInt(surf.ReplacementHex, out var newId)) continue;
                    if (newId != surf.OriginalTextureId)
                        texMap[surf.OriginalTextureId] = newId;
                }
            }

            PreviewTextureOverrides = texMap.Count > 0 ? texMap : null;
            PreviewHiddenParts = hidden.Count > 0 ? hidden : null;
            PreviewGfxObjRemapping = gfxMap.Count > 0 ? gfxMap : null;
        }

        [RelayCommand]
        private void RegenerateSqlManual() => RegenerateSql();

        void RegenerateSql() {
            if (!TryBuildOverrides(out var overrides, out var err)) {
                SqlOutput = $"-- Validation error: {err}";
                return;
            }
            SqlOutput = AceDbConnector.GenerateCreatureOverridesSql(overrides);
        }

        [RelayCommand]
        private async Task SaveToDbAsync() {
            if (Settings?.AceDbConnection == null) { StatusText = "Configure ACE Database in Settings first."; return; }
            if (!TryBuildOverrides(out var overrides, out var err)) { StatusText = err; return; }
            if (overrides.ObjectId == 0) { StatusText = "Enter a Target WCID before saving."; return; }

            IsBusy = true;
            StatusText = "Saving overrides…";
            try {
                var aceSettings = Settings.AceDbConnection.ToAceDbSettings();
                using var connector = new AceDbConnector(aceSettings);
                var ok = await connector.SaveCreatureOverridesAsync(overrides);
                StatusText = ok
                    ? $"Saved WCID {overrides.ObjectId}: {overrides.TextureMap.Count} texture override(s), {overrides.AnimParts.Count} anim part override(s)."
                    : "Save failed — check DB permissions and that the weenie exists.";
            }
            catch (Exception ex) { StatusText = "Save error: " + ex.Message; }
            finally { IsBusy = false; }
        }

        [RelayCommand]
        private async Task CopyToClipboardAsync() {
            try {
                if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop
                    && desktop.MainWindow != null) {
                    var clipboard = TopLevel.GetTopLevel(desktop.MainWindow)?.Clipboard;
                    if (clipboard != null) {
                        RegenerateSql();
                        await clipboard.SetTextAsync(SqlOutput);
                        StatusText = "SQL copied to clipboard.";
                        return;
                    }
                }
                StatusText = "Could not access clipboard.";
            }
            catch (Exception ex) { StatusText = "Copy failed: " + ex.Message; }
        }

        [RelayCommand]
        private async Task ReloadOverridesAsync() {
            if (SelectedWeenie != null) await LoadCreatureAsync(SelectedWeenie);
        }

        [RelayCommand]
        private void ClearAllOverrides() {
            foreach (var group in PartGroups) {
                group.IsRemoved = false;
                foreach (var surf in group.Surfaces) {
                    surf.ReplacementHex = "";
                    surf.ReplacementThumbnail = null;
                }
            }
            RebuildPreviewOverrides();
            RegenerateSql();
            StatusText = "All overrides cleared.";
        }

        bool TryBuildOverrides(out AceCreatureOverrides overrides, out string error) {
            error = "";
            overrides = new AceCreatureOverrides();

            uint objectId = 0;
            if (!string.IsNullOrWhiteSpace(TargetObjectId)) {
                if (!TryParseUInt(TargetObjectId, out objectId)) {
                    error = "Target WCID must be a valid unsigned integer.";
                    return false;
                }
            }
            else if (SelectedWeenie != null) {
                objectId = SelectedWeenie.ClassId;
            }
            overrides.ObjectId = objectId;

            foreach (var group in PartGroups) {
                if (group.IsRemoved)
                    overrides.AnimParts.Add(new AceAnimPartRow { Index = group.PartIndex, AnimationId = 0x010001EC, Comment = $"Hide part {group.PartIndex}" });
                else if (!string.IsNullOrWhiteSpace(group.DonorGfxObjHex) && TryParseUInt(group.DonorGfxObjHex, out var gfxId))
                    overrides.AnimParts.Add(new AceAnimPartRow { Index = group.PartIndex, AnimationId = gfxId, Comment = group.DonorLabel });

                foreach (var surf in group.Surfaces.Where(s => s.HasReplacement)) {
                    if (!TryParseUInt(surf.ReplacementHex, out var newId)) continue;
                    overrides.TextureMap.Add(new AceTextureMapRow {
                        Index = surf.PartIndex,
                        OldId = surf.OriginalTextureId,
                        NewId = newId,
                        Comment = $"Part {surf.PartIndex}",
                    });
                }
            }
            return true;
        }

        void ClearDetail() {
            ActiveSlot = null;
            PreviewSetupDid = 0;
            PreviewTextureOverrides = null;
            PreviewHiddenParts = null;
            PreviewGfxObjRemapping = null;
            PartGroups.Clear();
            DatPartsStatus = "Select a creature to load its body parts.";
            SqlOutput = "";
        }

        // ─── Texture Browser ─────────────────────────────────────────────────

        async Task LoadBrowserItemsAsync() {
            if (_dats == null) return;
            BrowserStatus = "Loading SurfaceTextures from DAT…";
            var dats = _dats;

            var ids = await Task.Run(() => {
                try {
                    return dats.Dats.Portal.GetAllIdsOfType<SurfaceTexture>().OrderBy(id => id).ToArray();
                }
                catch { return Array.Empty<uint>(); }
            });

            _allTextureIds = ids;
            BrowserStatus = $"{ids.Length} textures loaded.";
            ApplyBrowserFilter();
        }

        void ApplyBrowserFilter() {
            IEnumerable<uint> source = _allTextureIds;

            if (!string.IsNullOrWhiteSpace(BrowserSearchText)) {
                var hex = BrowserSearchText.TrimStart('0', 'x', 'X').ToUpperInvariant();
                source = source.Where(id => id.ToString("X8").Contains(hex));
            }

            var all = source.ToArray();
            var shown = all.Take(_browserDisplayCount).ToArray();
            CanLoadMoreBrowser = shown.Length < all.Length;

            var items = shown.Select(id => new SurfaceTextureItem(id)).ToList();
            BrowserItems = new ObservableCollection<SurfaceTextureItem>(items);
            BrowserStatus = shown.Length < all.Length
                ? $"Showing {shown.Length} of {all.Length} textures"
                : $"{shown.Length} textures";

            _ = GenerateBrowserThumbnailsAsync(items);
        }

        async Task GenerateBrowserThumbnailsAsync(IEnumerable<SurfaceTextureItem> items) {
            var dats = _dats;
            if (dats == null) return;
            foreach (var item in items.ToArray()) {
                if (item.Thumbnail != null) continue;
                var id = item.FullId;
                var bmp = await Task.Run(() => DatIconLoader.LoadSurfaceTextureIcon(dats, id, 56));
                item.Thumbnail = bmp;
            }
        }

        [RelayCommand]
        private void LoadMoreBrowser() {
            _browserDisplayCount += 300;
            ApplyBrowserFilter();
        }

        // ─── Helpers ─────────────────────────────────────────────────────────

        static bool TryParseUInt(string s, out uint v) {
            s = s.Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return uint.TryParse(s.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
            return uint.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
        }
    }
}
