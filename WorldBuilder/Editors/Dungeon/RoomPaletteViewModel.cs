using Avalonia;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Dungeon {

    public partial class RoomEntry : ObservableObject {
        public uint EnvironmentFileId { get; set; }
        public ushort EnvironmentId { get; set; }
        public ushort CellStructureIndex { get; set; }
        public int PortalCount { get; set; }
        public int VertexCount { get; set; }
        public int PolygonCount { get; set; }
        public List<ushort> PortalPolygonIds { get; set; } = new();
        public List<ushort> DefaultSurfaces { get; set; } = new();

        [ObservableProperty]
        private WriteableBitmap? _thumbnail;

        [ObservableProperty]
        private bool _isFavorite;

        /// <summary>When set by preset loader, shows a friendly name instead of the raw ID.</summary>
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(DisplayName))]
        private string? _presetDisplayName;

        public string DisplayName => !string.IsNullOrEmpty(PresetDisplayName) ? PresetDisplayName : $"Room ({PortalCount} door{(PortalCount != 1 ? "s" : "")})";
        public string DetailText => $"{PortalCount} door{(PortalCount != 1 ? "s" : "")}, {PolygonCount} faces";
    }

    public partial class RoomPaletteViewModel : ViewModelBase {
        private readonly IDatReaderWriter _dats;
        private List<RoomEntry> _allRooms = new();
        private readonly HashSet<(uint envFileId, ushort cellStructIdx)> _favoriteKeys = new();

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private ObservableCollection<RoomEntry> _filteredRooms = new();
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private ObservableCollection<RoomEntry> _starterRooms = new();
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private ObservableCollection<RoomEntry> _favoriteRooms = new();
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private bool _showStarterMode;
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private bool _showFavoritesMode;
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        [NotifyPropertyChangedFor(nameof(ShowPrefabList))]
        private bool _showPrefabsMode;
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private bool _showCatalogMode = true;

        partial void OnShowStarterModeChanged(bool value) {
            if (value) { ShowCatalogMode = false; ShowFavoritesMode = false; ShowPrefabsMode = false; ShowFavoritePrefabsMode = false; }
        }
        partial void OnShowFavoritesModeChanged(bool value) {
            if (value) { ShowCatalogMode = false; ShowStarterMode = false; ShowPrefabsMode = false; ShowFavoritePrefabsMode = false; }
        }
        partial void OnShowPrefabsModeChanged(bool value) {
            if (value) { ShowCatalogMode = false; ShowStarterMode = false; ShowFavoritesMode = false; ShowFavoritePrefabsMode = false; }
        }
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private ObservableCollection<RoomEntry> _catalogRooms = new();
        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private string _catalogCategory = "All";

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        private ObservableCollection<PrefabListEntry> _prefabEntries = new();

        [ObservableProperty]
        private PrefabListEntry? _selectedPrefab;

        /// <summary>True when the catalog (prefab) list should be shown instead of the room list.</summary>
        public bool ShowPrefabList => (ShowCatalogMode && PrefabEntries.Count > 0) || (ShowPrefabsMode && PrefabEntries.Count > 0) || ShowFavoritePrefabsMode;

        public event EventHandler<DungeonPrefab>? PrefabSelected;
        public event EventHandler<DungeonPrefab?>? PrefabHoverChanged;

        public PortalCompatibilityIndex? PortalIndex { get; set; }

        private List<(ushort envId, ushort cs, ushort polyId)> _activeOpenPortals = new();

        /// <summary>
        /// Set by the editor when the dungeon has open portals. When non-empty, the palette
        /// filters prefabs to show only those with proven connections to these portal faces.
        /// </summary>
        public void SetActiveOpenPortals(List<(ushort envId, ushort cs, ushort polyId)> portals) {
            _activeOpenPortals = portals ?? new();
            ApplyPrefabFilter();
        }

        public IEnumerable<RoomEntry> RoomsToShow =>
            ShowCatalogMode ? Enumerable.Empty<RoomEntry>() :
            ShowPrefabsMode ? Enumerable.Empty<RoomEntry>() :
            ShowFavoritePrefabsMode ? Enumerable.Empty<RoomEntry>() :
            ShowFavoritesMode && FavoriteRooms.Count > 0 ? FavoriteRooms :
            ShowStarterMode && StarterRooms.Count > 0 ? StarterRooms :
            FilteredRooms;

        public List<string> CatalogCategories { get; } = new() {
            "All", "Hallway", "Corner", "T-Junction", "Hub", "Dead End", "Chamber", "Full Dungeon"
        };
        [ObservableProperty] private bool _showCompatibleOnly;
        [ObservableProperty] private RoomEntry? _selectedRoom;
        [ObservableProperty] private string _searchText = "";
        [ObservableProperty] private string _statusText = "Loading...";
        [ObservableProperty] private bool _isLoaded;
        [ObservableProperty] private bool _isBuildingKnowledgeBase;
        [ObservableProperty] private string _buildingMessage = "";
        [ObservableProperty] private int _minPortals;
        [ObservableProperty] private int _maxPortals = 99;

        public event EventHandler<RoomEntry>? RoomSelected;

        public RoomPaletteViewModel(IDatReaderWriter dats) {
            _dats = dats;
        }

        /// <summary>
        /// Load all Environment objects and their CellStructs from portal.dat.
        /// Should be called once on a background thread.
        /// </summary>
        public async Task LoadRoomsAsync() {
            var rooms = await Task.Run(() => {
                var result = new List<RoomEntry>();
                var envIds = _dats.Dats.Portal
                    .GetAllIdsOfType<DatReaderWriter.DBObjs.Environment>()
                    .OrderBy(id => id)
                    .ToArray();

                foreach (var envFileId in envIds) {
                    if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env))
                        continue;

                    ushort envId = (ushort)(envFileId & 0x0000FFFF);

                    foreach (var kvp in env.Cells) {
                        var cellStruct = kvp.Value;
                        var portalIds = PortalSnapper.GetPortalPolygonIds(cellStruct);

                        result.Add(new RoomEntry {
                            EnvironmentFileId = envFileId,
                            EnvironmentId = envId,
                            CellStructureIndex = (ushort)kvp.Key,
                            PortalCount = portalIds.Count,
                            PortalPolygonIds = portalIds,
                            VertexCount = cellStruct.VertexArray?.Vertices?.Count ?? 0,
                            PolygonCount = cellStruct.Polygons?.Count ?? 0,
                        });
                    }
                }

                return result;
            });

            _allRooms = rooms;
            IsLoaded = true;
            StatusText = $"{_allRooms.Count} rooms loaded";
            ApplyFilter();

            LoadFavorites();
            ApplyFavoritesToRooms();

            _ = Task.Run(() => PopulateDefaultSurfaces(rooms));
            _ = GenerateThumbnailsAsync();
            LoadStarterPresets(rooms);
            LoadPrefabEntries();
            LoadCatalogRooms();

            _ = AutoAnalyzeIfNeeded(rooms);
        }

        /// <summary>
        /// If no analysis file exists yet, run room analysis in the background
        /// so starter presets are available on first launch without manual action.
        /// </summary>
        private async Task AutoAnalyzeIfNeeded(List<RoomEntry> rooms) {
            try {
                var appDir = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder");
                var analysisPath = Path.Combine(appDir, "dungeon_room_analysis.json");
                var kbPath = Path.Combine(appDir, "dungeon_knowledge.json");

                // Run room analysis if it hasn't been done yet
                if (!File.Exists(analysisPath)) {
                    Console.WriteLine("[RoomPalette] No analysis file found — running auto-analysis...");
                    await Dispatcher.UIThread.InvokeAsync(() => StatusText = $"{_allRooms.Count} rooms loaded — analyzing...");

                    var report = await Task.Run(() => DungeonRoomAnalyzer.Run(_dats));
                    DungeonRoomAnalyzer.SaveReport(report, Path.Combine(appDir, "dungeon_room_analysis"));

                    Console.WriteLine($"[RoomPalette] Auto-analysis complete: {report.TotalCellsScanned} cells, {report.UniqueRoomTypes} room types");
                }

                bool needsKbRebuild = !DungeonKnowledgeBuilder.IsCachedValid();
                if (needsKbRebuild) {
                    Console.WriteLine("[RoomPalette] Building knowledge base (expanded prefabs)...");
                    await Dispatcher.UIThread.InvokeAsync(() => {
                        IsBuildingKnowledgeBase = true;
                        BuildingMessage = "Scanning 3400+ dungeons to build piece catalog...\nThis only happens once.";
                        StatusText = "Building prefab catalog...";
                    });
                    await Task.Run(() => DungeonKnowledgeBuilder.Build(_dats));
                    Console.WriteLine("[RoomPalette] Knowledge base built.");

                    await Dispatcher.UIThread.InvokeAsync(() => {
                        IsBuildingKnowledgeBase = false;
                        BuildingMessage = "";
                        LoadPrefabEntries();
                        LoadCatalogRooms();
                    });
                }

                await Dispatcher.UIThread.InvokeAsync(() => {
                    LoadStarterPresets(rooms);
                    StatusText = _allPrefabs.Count > 0
                        ? $"{_allPrefabs.Count} pieces ready"
                        : $"{_allRooms.Count} rooms loaded";
                });
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] Auto-analysis failed (non-fatal): {ex.Message}");
            }
        }

        private void LoadStarterPresets(List<RoomEntry> allRooms) {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_room_analysis.json");
                if (!File.Exists(path)) return;

                var json = File.ReadAllText(path);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("topStarterCandidates", out var arr)) return;

                var roomLookup = allRooms.ToDictionary(r => (r.EnvironmentFileId, r.CellStructureIndex));
                var starters = new List<RoomEntry>();
                var names = new[] { "Dead End", "Corridor", "T-Junction", "Crossing", "Complex" };

                foreach (var item in arr.EnumerateArray()) {
                    if (!item.TryGetProperty("envFileId", out var e) || !item.TryGetProperty("cellStructIndex", out var c)) continue;
                    var envFileId = e.GetUInt32();
                    var cellStructIndex = (ushort)c.GetUInt16();
                    var portalCount = item.TryGetProperty("portalCount", out var pc) ? pc.GetInt32() : 0;
                    var usageCount = item.TryGetProperty("usageCount", out var uc) ? uc.GetInt32() : 0;

                    if (!roomLookup.TryGetValue((envFileId, cellStructIndex), out var room)) continue;

                    var typeName = portalCount >= 1 && portalCount <= names.Length ? names[portalCount - 1] : (portalCount == 0 ? "Room" : "Complex");
                    var used = usageCount >= 1000 ? $"{usageCount / 1000}k" : usageCount.ToString();
                    var baseName = $"{typeName} ({portalCount}P, used {used})";

                    // Add sample dungeon names if available (e.g. "from A Red Rat Lair")
                    var dungeonNames = new List<string>();
                    if (item.TryGetProperty("sampleDungeonNames", out var dArr)) {
                        foreach (var d in dArr.EnumerateArray())
                            dungeonNames.Add(d.GetString() ?? "");
                    }
                    var fromPart = dungeonNames.Count > 0
                        ? $" — e.g. {string.Join(", ", dungeonNames.Where(x => !string.IsNullOrEmpty(x)).Take(2))}"
                        : "";
                    room.PresetDisplayName = baseName + fromPart;

                    starters.Add(room);
                }

                StarterRooms = new ObservableCollection<RoomEntry>(starters);
                if (starters.Count > 0)
                    StatusText = $"{_allRooms.Count} rooms, {starters.Count} recommended";
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadStarterPresets: {ex.Message}");
            }
        }

        /// <summary>
        /// Reload starter presets from dungeon_room_analysis.json (e.g. after Analyze Rooms).
        /// Call this when the analysis file has been updated.
        /// </summary>
        public void ReloadStarterPresets() {
            if (_allRooms.Count == 0) return;
            LoadStarterPresets(_allRooms);
            LoadPrefabEntries();
        }

        public void LoadCatalogRooms() {
            try {
                var kb = DungeonKnowledgeBuilder.LoadCached();
                if (kb == null || kb.Catalog.Count == 0) return;

                var roomLookup = _allRooms.ToDictionary(r => (r.EnvironmentFileId, r.CellStructureIndex), r => r);

                foreach (var cr in kb.Catalog) {
                    uint envFileId = (uint)(cr.EnvId | 0x0D000000);
                    if (roomLookup.TryGetValue((envFileId, cr.CellStruct), out var room)) {
                        room.PresetDisplayName = cr.DisplayName;
                    }
                }

                ApplyCatalogFilter();
                Console.WriteLine($"[RoomPalette] Loaded {kb.Catalog.Count} catalog rooms");
                if (ShowCatalogMode) _ = GenerateThumbnailsForCatalogAsync();
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadCatalogRooms: {ex.Message}");
            }
        }

        private void ApplyCatalogFilter() {
            var kb = DungeonKnowledgeBuilder.LoadCached();
            if (kb == null) return;

            var roomLookup = _allRooms.ToDictionary(r => (r.EnvironmentFileId, r.CellStructureIndex), r => r);
            var query = SearchText?.Trim() ?? "";

            var filtered = kb.Catalog.AsEnumerable();

            if (CatalogCategory != "All") {
                filtered = filtered.Where(cr => cr.Category == CatalogCategory);
            }

            if (!string.IsNullOrEmpty(query)) {
                filtered = filtered.Where(cr =>
                    cr.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    cr.Style.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    cr.SourceDungeons.Any(d => d.Contains(query, StringComparison.OrdinalIgnoreCase)));
            }

            var result = new List<RoomEntry>();
            foreach (var cr in filtered.Take(200)) {
                uint envFileId = (uint)(cr.EnvId | 0x0D000000);
                if (roomLookup.TryGetValue((envFileId, cr.CellStruct), out var room)) {
                    if (string.IsNullOrEmpty(room.PresetDisplayName))
                        room.PresetDisplayName = cr.DisplayName;
                    result.Add(room);
                }
            }

            CatalogRooms = new ObservableCollection<RoomEntry>(result);
        }

        partial void OnShowCompatibleOnlyChanged(bool value) {
            ApplyPrefabFilter();
        }

        partial void OnCatalogCategoryChanged(string value) {
            if (ShowCatalogMode || ShowPrefabsMode) ApplyPrefabFilter();
        }

        partial void OnShowCatalogModeChanged(bool value) {
            if (value) {
                ShowStarterMode = false; ShowFavoritesMode = false; ShowPrefabsMode = false; ShowFavoritePrefabsMode = false;
                ApplyPrefabFilter();
                _ = GeneratePrefabThumbnailsAsync();
            }
        }

        private async Task GenerateThumbnailsForCatalogAsync() {
            await Task.Delay(100);
            var snapshot = CatalogRooms.ToArray();
            foreach (var room in snapshot) {
                if (room.Thumbnail != null) continue;
                var thumb = await Task.Run(() => RenderRoomThumbnail(room));
                if (thumb != null) {
                    Dispatcher.UIThread.Post(() => room.Thumbnail = thumb);
                }
            }
        }

        private List<DungeonPrefab> _allPrefabs = new();
        private readonly HashSet<string> _favoritePrefabSignatures = new();
        private List<DungeonPrefab> _customPrefabs = new();

        [ObservableProperty]
        [NotifyPropertyChangedFor(nameof(RoomsToShow))]
        [NotifyPropertyChangedFor(nameof(ShowPrefabList))]
        private bool _showFavoritePrefabsMode;

        partial void OnShowFavoritePrefabsModeChanged(bool value) {
            if (value) {
                ShowCatalogMode = false; ShowStarterMode = false; ShowFavoritesMode = false; ShowPrefabsMode = false;
                ApplyPrefabFilter();
                _ = GeneratePrefabThumbnailsAsync();
            }
        }

        public bool IsPrefabFavorite(DungeonPrefab prefab) =>
            _favoritePrefabSignatures.Contains(prefab.Signature);

        public void TogglePrefabFavorite(PrefabListEntry entry) {
            var sig = entry.Prefab.Signature;
            if (_favoritePrefabSignatures.Contains(sig)) {
                _favoritePrefabSignatures.Remove(sig);
                entry.IsFavorite = false;
                Console.WriteLine($"[RoomPalette] Unfavorited prefab: {entry.DisplayName} (sig={sig.Substring(0, Math.Min(30, sig.Length))}...)");
            }
            else {
                _favoritePrefabSignatures.Add(sig);
                entry.IsFavorite = true;
                Console.WriteLine($"[RoomPalette] Favorited prefab: {entry.DisplayName} (sig={sig.Substring(0, Math.Min(30, sig.Length))}...) — total favorites: {_favoritePrefabSignatures.Count}");
            }
            SavePrefabFavorites();
            ApplyPrefabFilter();
        }

        public void AddCustomPrefab(DungeonPrefab prefab) {
            _customPrefabs.Add(prefab);
            _allPrefabs.Add(prefab);
            _favoritePrefabSignatures.Add(prefab.Signature);
            SaveCustomPrefabs();
            SavePrefabFavorites();
            ApplyPrefabFilter();
            _ = GeneratePrefabThumbnailsAsync();
        }

        public void LoadPrefabEntries() {
            try {
                var kb = DungeonKnowledgeBuilder.LoadCached();
                if (kb == null || kb.Prefabs.Count == 0) return;

                if (kb.Prefabs.Any(p => string.IsNullOrEmpty(p.DisplayName))) {
                    Console.WriteLine($"[RoomPalette] Naming {kb.Prefabs.Count} prefabs from cached KB...");
                    PrefabNamer.NameAll(kb.Prefabs, kb.Catalog);
                }

                AnalyzeRoofStatus(kb.Prefabs);

                _allPrefabs = new List<DungeonPrefab>(kb.Prefabs);

                LoadCustomPrefabs();
                foreach (var cp in _customPrefabs) {
                    if (!_allPrefabs.Any(p => p.Signature == cp.Signature))
                        _allPrefabs.Add(cp);
                }

                LoadPrefabFavorites();
                ApplyPrefabFilter();
                Console.WriteLine($"[RoomPalette] Loaded {_allPrefabs.Count} prefab entries ({_customPrefabs.Count} custom, {_favoritePrefabSignatures.Count} favorites)");
                _ = GeneratePrefabThumbnailsAsync();
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadPrefabEntries: {ex.Message}");
            }
        }

        /// <summary>
        /// Analyze ceiling/roof status for each cell in each prefab by checking the actual
        /// polygon normals in the DAT geometry.
        /// </summary>
        private void AnalyzeRoofStatus(List<DungeonPrefab> prefabs) {
            int analyzed = 0, noRoof = 0, partial = 0;
            foreach (var prefab in prefabs) {
                bool anyMissing = false, allMissing = true;
                foreach (var cell in prefab.Cells) {
                    cell.HasCeiling = CellHasCeiling(cell.EnvId, cell.CellStruct);
                    if (!cell.HasCeiling) anyMissing = true;
                    else allMissing = false;
                }
                prefab.HasNoRoof = prefab.Cells.Count > 0 && allMissing;
                prefab.HasPartialRoof = anyMissing && !allMissing;
                prefab.HasFullRoof = !anyMissing;

                if (prefab.HasNoRoof) noRoof++;
                else if (prefab.HasPartialRoof) partial++;
                analyzed++;
            }
            Console.WriteLine($"[RoomPalette] Roof analysis: {analyzed} prefabs — {noRoof} no-roof, {partial} partial-roof");
        }

        private bool CellHasCeiling(ushort envId, ushort cellStruct) {
            try {
                uint envFileId = (uint)(envId | 0x0D000000);
                if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) return true;
                if (!env.Cells.TryGetValue(cellStruct, out var cs)) return true;
                if (cs.VertexArray?.Vertices == null || cs.Polygons == null) return true;

                var portalIds = cs.Portals != null ? new HashSet<ushort>(cs.Portals) : new HashSet<ushort>();

                foreach (var kvp in cs.Polygons) {
                    if (portalIds.Contains(kvp.Key)) continue;
                    var poly = kvp.Value;
                    if (poly.VertexIds.Count < 3) continue;

                    var verts = cs.VertexArray.Vertices;
                    if (!verts.TryGetValue((ushort)poly.VertexIds[0], out var v0) ||
                        !verts.TryGetValue((ushort)poly.VertexIds[1], out var v1) ||
                        !verts.TryGetValue((ushort)poly.VertexIds[2], out var v2)) continue;

                    var edge1 = v1.Origin - v0.Origin;
                    var edge2 = v2.Origin - v0.Origin;
                    var normal = Vector3.Normalize(Vector3.Cross(edge1, edge2));

                    if (normal.Z < -0.7f) return true;
                }
                return false;
            }
            catch { return true; }
        }

        private void ApplyPrefabFilter() {
            var query = SearchText?.Trim() ?? "";
            var category = CatalogCategory;

            HashSet<(ushort, ushort)>? compatibleRoomTypes = null;
            if (_activeOpenPortals.Count > 0 && PortalIndex != null) {
                compatibleRoomTypes = PortalIndex.GetCompatibleRoomTypesForAny(_activeOpenPortals);
            }

            IEnumerable<DungeonPrefab> filtered;
            if (ShowFavoritePrefabsMode) {
                filtered = _allPrefabs.Where(p => _favoritePrefabSignatures.Contains(p.Signature));
            }
            else {
                filtered = _allPrefabs.AsEnumerable();
            }

            if (category != "All" && !ShowFavoritePrefabsMode) {
                filtered = filtered.Where(p => p.Category.Equals(category, StringComparison.OrdinalIgnoreCase));
            }

            if (!string.IsNullOrEmpty(query)) {
                filtered = filtered.Where(p =>
                    p.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    p.Style.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    p.SourceDungeonName.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    p.Tags.Any(t => t.Contains(query, StringComparison.OrdinalIgnoreCase)));
            }

            var entries = new List<PrefabListEntry>();

            if (compatibleRoomTypes != null && compatibleRoomTypes.Count > 0 && !ShowFavoritePrefabsMode) {
                var compatible = new List<DungeonPrefab>();
                var others = new List<DungeonPrefab>();
                foreach (var prefab in filtered) {
                    bool isCompat = prefab.OpenFaces.Any(of =>
                        compatibleRoomTypes.Contains((of.EnvId, of.CellStruct)));
                    if (isCompat) compatible.Add(prefab);
                    else others.Add(prefab);
                }

                foreach (var prefab in compatible.Take(100))
                    entries.Add(BuildPrefabEntry(prefab, isCompatible: true));
                if (!ShowCompatibleOnly) {
                    foreach (var prefab in others.Take(100))
                        entries.Add(BuildPrefabEntry(prefab, isCompatible: false));
                }
            }
            else {
                foreach (var prefab in filtered.Take(200))
                    entries.Add(BuildPrefabEntry(prefab, isCompatible: false));
            }

            // Apply favorite state to entries
            foreach (var entry in entries)
                entry.IsFavorite = _favoritePrefabSignatures.Contains(entry.Prefab.Signature);

            PrefabEntries = new ObservableCollection<PrefabListEntry>(entries);
        }

        private static PrefabListEntry BuildPrefabEntry(DungeonPrefab prefab, bool isCompatible) {
            var name = !string.IsNullOrEmpty(prefab.DisplayName) ? prefab.DisplayName : $"Prefab ({prefab.Cells.Count} rooms)";

            var cellWord = prefab.Cells.Count != 1 ? "cells" : "cell";
            var doorWord = prefab.OpenFaces.Count != 1 ? "doors" : "door";
            var dirSummary = prefab.ConnectionDirectionSummary;
            var dirPart = !string.IsNullOrEmpty(dirSummary) ? $"  [{dirSummary}]" : "";
            var compatMark = isCompatible ? "\u2713 " : "";

            var detail = $"{compatMark}{prefab.Cells.Count} {cellWord}, {prefab.OpenFaces.Count} open {doorWord}{dirPart}";

            return new PrefabListEntry(prefab, name) {
                DetailOverride = detail,
                IsCompatible = isCompatible
            };
        }

        partial void OnSelectedPrefabChanged(PrefabListEntry? value) {
            if (value != null) {
                PrefabSelected?.Invoke(this, value.Prefab);
            }
        }

        public void NotifyPrefabHover(DungeonPrefab? prefab) {
            PrefabHoverChanged?.Invoke(this, prefab);
        }

        private async Task GeneratePrefabThumbnailsAsync() {
            await Task.Delay(200);
            var snapshot = PrefabEntries.ToArray();
            foreach (var entry in snapshot) {
                if (entry.Thumbnail != null) continue;
                var thumb = await Task.Run(() => RenderPrefabThumbnail(entry.Prefab));
                if (thumb != null) {
                    Dispatcher.UIThread.Post(() => entry.Thumbnail = thumb);
                }
            }
        }

        private WriteableBitmap? RenderPrefabThumbnail(DungeonPrefab prefab) {
            const int size = 96;
            try {
                var allVerts = new List<(Vector3 pos, int cellIdx)>();
                var allPolys = new List<(List<(int x, int y)> pts, int cellIdx, bool isPortal)>();

                const float cosA = 0.866f;
                const float sinA = 0.5f;
                Vector2 ProjectIso(Vector3 p) => new Vector2((p.X - p.Y) * cosA, (p.X + p.Y) * sinA - p.Z);

                float sMinX = float.MaxValue, sMaxX = float.MinValue;
                float sMinY = float.MaxValue, sMaxY = float.MinValue;

                for (int ci = 0; ci < prefab.Cells.Count; ci++) {
                    var cell = prefab.Cells[ci];
                    uint envFileId = (uint)(cell.EnvId | 0x0D000000);
                    if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                    if (!env.Cells.TryGetValue(cell.CellStruct, out var cs)) continue;
                    if (cs.VertexArray?.Vertices == null || cs.Polygons == null) continue;

                    var cellRot = new Quaternion(cell.RotX, cell.RotY, cell.RotZ, cell.RotW);
                    if (cellRot.LengthSquared() < 0.01f) cellRot = Quaternion.Identity;
                    cellRot = Quaternion.Normalize(cellRot);
                    var cellOffset = new Vector3(cell.OffsetX, cell.OffsetY, cell.OffsetZ);

                    var portalIds = cs.Portals != null ? new HashSet<ushort>(cs.Portals) : new HashSet<ushort>();

                    foreach (var kvp in cs.Polygons) {
                        var poly = kvp.Value;
                        if (poly.VertexIds.Count < 3) continue;
                        bool isPortal = portalIds.Contains(kvp.Key);

                        var screenPts = new List<(int x, int y)>();
                        bool valid = true;
                        foreach (var vid in poly.VertexIds) {
                            if (!cs.VertexArray.Vertices.TryGetValue((ushort)vid, out var vtx)) { valid = false; break; }
                            var worldPos = Vector3.Transform(vtx.Origin, cellRot) + cellOffset;
                            var sp = ProjectIso(worldPos);
                            if (sp.X < sMinX) sMinX = sp.X; if (sp.X > sMaxX) sMaxX = sp.X;
                            if (sp.Y < sMinY) sMinY = sp.Y; if (sp.Y > sMaxY) sMaxY = sp.Y;
                            screenPts.Add((0, 0));
                        }
                        if (!valid || screenPts.Count < 3) continue;
                        allPolys.Add((screenPts, ci, isPortal));
                    }
                }

                float rangeX = sMaxX - sMinX;
                float rangeY = sMaxY - sMinY;
                if (rangeX < 0.1f && rangeY < 0.1f) return null;
                float range = MathF.Max(rangeX, rangeY) * 1.1f;
                float centerSX = (sMinX + sMaxX) * 0.5f;
                float centerSY = (sMinY + sMaxY) * 0.5f;
                int margin = 3;
                float scale = (size - margin * 2) / range;

                int ToPixX(float sx) => Math.Clamp((int)((sx - centerSX) * scale + size * 0.5f), 0, size - 1);
                int ToPixY(float sy) => Math.Clamp((int)((sy - centerSY) * scale + size * 0.5f), 0, size - 1);

                // Re-compute screen positions with proper scaling
                allPolys.Clear();
                for (int ci = 0; ci < prefab.Cells.Count; ci++) {
                    var cell = prefab.Cells[ci];
                    uint envFileId = (uint)(cell.EnvId | 0x0D000000);
                    if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                    if (!env.Cells.TryGetValue(cell.CellStruct, out var cs)) continue;
                    if (cs.VertexArray?.Vertices == null || cs.Polygons == null) continue;

                    var cellRot = new Quaternion(cell.RotX, cell.RotY, cell.RotZ, cell.RotW);
                    if (cellRot.LengthSquared() < 0.01f) cellRot = Quaternion.Identity;
                    cellRot = Quaternion.Normalize(cellRot);
                    var cellOffset = new Vector3(cell.OffsetX, cell.OffsetY, cell.OffsetZ);
                    var portalIds = cs.Portals != null ? new HashSet<ushort>(cs.Portals) : new HashSet<ushort>();

                    foreach (var kvp in cs.Polygons) {
                        var poly = kvp.Value;
                        if (poly.VertexIds.Count < 3) continue;
                        bool isPortal = portalIds.Contains(kvp.Key);

                        var screenPts = new List<(int x, int y)>();
                        bool valid = true;
                        foreach (var vid in poly.VertexIds) {
                            if (!cs.VertexArray.Vertices.TryGetValue((ushort)vid, out var vtx)) { valid = false; break; }
                            var worldPos = Vector3.Transform(vtx.Origin, cellRot) + cellOffset;
                            var sp = ProjectIso(worldPos);
                            screenPts.Add((ToPixX(sp.X), ToPixY(sp.Y)));
                        }
                        if (!valid || screenPts.Count < 3) continue;
                        allPolys.Add((screenPts, ci, isPortal));
                    }
                }

                var pixels = new byte[size * size * 4];
                for (int i = 0; i < pixels.Length; i += 4) {
                    pixels[i] = 14; pixels[i + 1] = 10; pixels[i + 2] = 22; pixels[i + 3] = 255;
                }

                byte[][] cellColors = {
                    new byte[] { 60, 40, 90 },
                    new byte[] { 40, 70, 80 },
                    new byte[] { 70, 50, 50 },
                    new byte[] { 50, 60, 40 },
                    new byte[] { 60, 50, 70 },
                };

                foreach (var (pts, cellIdx, isPortal) in allPolys) {
                    if (isPortal) {
                        DrawPolyOutline(pixels, size, pts, 80, 255, 100);
                    }
                    else {
                        var cc = cellColors[cellIdx % cellColors.Length];
                        FillPolygon(pixels, size, pts, (byte)(cc[0] / 2), (byte)(cc[1] / 2), (byte)(cc[2] / 2));
                        DrawPolyOutline(pixels, size, pts, cc[0], cc[1], cc[2]);
                    }
                }

                DrawOpenFaceArrows(pixels, size, prefab, scale, centerSX, centerSY);

                var bitmap = new WriteableBitmap(new PixelSize(size, size), new Avalonia.Vector(96, 96), Avalonia.Platform.PixelFormat.Rgba8888);
                using (var fb = bitmap.Lock()) {
                    System.Runtime.InteropServices.Marshal.Copy(pixels, 0, fb.Address, Math.Min(pixels.Length, fb.RowBytes * size));
                }
                return bitmap;
            }
            catch { return null; }
        }

        /// <summary>
        /// Draw small arrow indicators at each open face portal centroid,
        /// pointing outward in the portal normal direction. Helps users
        /// visually see where connection points are on the thumbnail.
        /// </summary>
        private void DrawOpenFaceArrows(byte[] pixels, int size, DungeonPrefab prefab,
            float scale, float centerSX, float centerSY) {
            const float cosA = 0.866f;
            const float sinA = 0.5f;
            Vector2 ProjectIso(Vector3 p) => new Vector2((p.X - p.Y) * cosA, (p.X + p.Y) * sinA - p.Z);
            int ToPixX(float sx) => Math.Clamp((int)((sx - centerSX) * scale + size * 0.5f), 0, size - 1);
            int ToPixY(float sy) => Math.Clamp((int)((sy - centerSY) * scale + size * 0.5f), 0, size - 1);

            foreach (var of in prefab.OpenFaces) {
                if (of.CellIndex >= prefab.Cells.Count) continue;
                var cell = prefab.Cells[of.CellIndex];

                uint envFileId = (uint)(cell.EnvId | 0x0D000000);
                if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                if (!env.Cells.TryGetValue(cell.CellStruct, out var cs)) continue;
                if (cs.VertexArray?.Vertices == null || cs.Polygons == null) continue;
                if (!cs.Polygons.TryGetValue(of.PolyId, out var poly)) continue;

                var cellRot = new Quaternion(cell.RotX, cell.RotY, cell.RotZ, cell.RotW);
                if (cellRot.LengthSquared() < 0.01f) cellRot = Quaternion.Identity;
                cellRot = Quaternion.Normalize(cellRot);
                var cellOffset = new Vector3(cell.OffsetX, cell.OffsetY, cell.OffsetZ);

                var centroid3d = Vector3.Zero;
                int validCount = 0;
                foreach (var vid in poly.VertexIds) {
                    if (cs.VertexArray.Vertices.TryGetValue((ushort)vid, out var vtx)) {
                        centroid3d += Vector3.Transform(vtx.Origin, cellRot) + cellOffset;
                        validCount++;
                    }
                }
                if (validCount == 0) continue;
                centroid3d /= validCount;

                var normal3d = new Vector3(of.NormalX, of.NormalY, of.NormalZ);
                normal3d = Vector3.Transform(normal3d, cellRot);
                if (normal3d.LengthSquared() > 0.01f) normal3d = Vector3.Normalize(normal3d);

                var tip3d = centroid3d + normal3d * 2.5f;
                var centroidS = ProjectIso(centroid3d);
                var tipS = ProjectIso(tip3d);

                int cx = ToPixX(centroidS.X), cy = ToPixY(centroidS.Y);
                int tx = ToPixX(tipS.X), ty = ToPixY(tipS.Y);

                DrawLine(pixels, size, cx, cy, tx, ty, 255, 200, 80);

                float dx = tx - cx, dy = ty - cy;
                float len = MathF.Sqrt(dx * dx + dy * dy);
                if (len > 2f) {
                    dx /= len; dy /= len;
                    int a1x = tx - (int)(dx * 4 + dy * 3);
                    int a1y = ty - (int)(dy * 4 - dx * 3);
                    int a2x = tx - (int)(dx * 4 - dy * 3);
                    int a2y = ty - (int)(dy * 4 + dx * 3);
                    DrawLine(pixels, size, tx, ty, a1x, a1y, 255, 200, 80);
                    DrawLine(pixels, size, tx, ty, a2x, a2y, 255, 200, 80);
                }
            }
        }

        private async Task GenerateThumbnailsAsync() {
            await Task.Delay(500);
            var snapshot = FilteredRooms.ToArray();
            foreach (var room in snapshot) {
                if (room.Thumbnail != null) continue;
                var thumb = await Task.Run(() => RenderRoomThumbnail(room));
                if (thumb != null) {
                    Dispatcher.UIThread.Post(() => room.Thumbnail = thumb);
                }
            }
        }

        private WriteableBitmap? RenderRoomThumbnail(RoomEntry room) {
            const int size = 96;
            try {
                uint envFileId = room.EnvironmentFileId;
                if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) return null;
                if (!env.Cells.TryGetValue(room.CellStructureIndex, out var cellStruct)) return null;

                if (cellStruct.VertexArray?.Vertices == null || cellStruct.Polygons == null)
                    return null;

                var verts = cellStruct.VertexArray.Vertices;
                if (verts.Count < 3) return null;

                // Isometric projection: 30 deg elevation, 45 deg azimuth
                const float cosA = 0.866f; // cos(30)
                const float sinA = 0.5f;   // sin(30)

                Vector2 ProjectIso(Vector3 p) => new Vector2(
                    (p.X - p.Y) * cosA,
                    (p.X + p.Y) * sinA - p.Z
                );

                // Compute projected bounds for fitting
                float sMinX = float.MaxValue, sMaxX = float.MinValue;
                float sMinY = float.MaxValue, sMaxY = float.MinValue;
                foreach (var v in verts.Values) {
                    var s = ProjectIso(v.Origin);
                    if (s.X < sMinX) sMinX = s.X;
                    if (s.X > sMaxX) sMaxX = s.X;
                    if (s.Y < sMinY) sMinY = s.Y;
                    if (s.Y > sMaxY) sMaxY = s.Y;
                }

                float rangeX = sMaxX - sMinX;
                float rangeY = sMaxY - sMinY;
                if (rangeX < 0.1f && rangeY < 0.1f) return null;
                float range = MathF.Max(rangeX, rangeY) * 1.1f;
                float centerSX = (sMinX + sMaxX) * 0.5f;
                float centerSY = (sMinY + sMaxY) * 0.5f;
                int margin = 3;
                float scale = (size - margin * 2) / range;

                int ToPixX(float sx) => Math.Clamp((int)((sx - centerSX) * scale + size * 0.5f), 0, size - 1);
                int ToPixY(float sy) => Math.Clamp((int)((sy - centerSY) * scale + size * 0.5f), 0, size - 1);

                var pixels = new byte[size * size * 4];
                for (int i = 0; i < pixels.Length; i += 4) {
                    pixels[i] = 14; pixels[i + 1] = 10; pixels[i + 2] = 22; pixels[i + 3] = 255;
                }

                // Build polygon render list with depth sorting
                var polyList = new List<(int key, float depth, bool isPortal, bool isFloor, bool isCeiling,
                    List<(int x, int y)> screenPts, Vector3 normal)>();

                var portalIds = cellStruct.Portals != null ? new HashSet<ushort>(cellStruct.Portals) : new HashSet<ushort>();

                foreach (var kvp in cellStruct.Polygons) {
                    var poly = kvp.Value;
                    if (poly.VertexIds.Count < 3) continue;

                    bool isPortal = portalIds.Contains(kvp.Key);

                    var pts3d = new List<Vector3>();
                    var screenPts = new List<(int x, int y)>();
                    foreach (var vid in poly.VertexIds) {
                        if (!verts.TryGetValue((ushort)vid, out var vtx)) break;
                        pts3d.Add(vtx.Origin);
                        var sp = ProjectIso(vtx.Origin);
                        screenPts.Add((ToPixX(sp.X), ToPixY(sp.Y)));
                    }
                    if (pts3d.Count < 3 || screenPts.Count != poly.VertexIds.Count) continue;

                    // Compute polygon normal from first 3 verts
                    var edge1 = pts3d[1] - pts3d[0];
                    var edge2 = pts3d[2] - pts3d[0];
                    var normal = Vector3.Normalize(Vector3.Cross(edge1, edge2));

                    bool isFloor = !isPortal && normal.Z > 0.7f;
                    bool isCeiling = !isPortal && normal.Z < -0.7f;

                    // Depth = average of projected Y (higher Y = further back in isometric)
                    float centroidX = 0, centroidY = 0, centroidZ = 0;
                    foreach (var p in pts3d) { centroidX += p.X; centroidY += p.Y; centroidZ += p.Z; }
                    centroidX /= pts3d.Count; centroidY /= pts3d.Count; centroidZ /= pts3d.Count;
                    float depth = (centroidX + centroidY) * sinA - centroidZ;

                    polyList.Add((kvp.Key, depth, isPortal, isFloor, isCeiling, screenPts, normal));
                }

                // Sort back-to-front (largest depth first = furthest away drawn first)
                polyList.Sort((a, b) => b.depth.CompareTo(a.depth));

                // Draw polygons
                foreach (var (key, depth, isPortal, isFloor, isCeiling, screenPts, normal) in polyList) {
                    if (isPortal) {
                        // Portal: bright green semi-transparent fill + outline
                        FillPolygon(pixels, size, screenPts, 40, 180, 60);
                        DrawPolyOutline(pixels, size, screenPts, 80, 255, 100);
                    }
                    else if (isFloor) {
                        // Floor: dark tinted fill + subtle outline
                        FillPolygon(pixels, size, screenPts, 28, 22, 40);
                        DrawPolyOutline(pixels, size, screenPts, 60, 50, 80);
                    }
                    else if (isCeiling) {
                        // Ceiling: slightly lighter outline only
                        DrawPolyOutline(pixels, size, screenPts, 50, 45, 70);
                    }
                    else {
                        // Wall: shaded based on facing direction for depth cue
                        float shade = MathF.Abs(normal.X * 0.6f + normal.Y * 0.3f) + 0.4f;
                        shade = MathF.Min(shade, 1f);
                        byte wr = (byte)(90 * shade);
                        byte wg = (byte)(80 * shade);
                        byte wb = (byte)(120 * shade);
                        FillPolygon(pixels, size, screenPts, (byte)(wr / 2), (byte)(wg / 2), (byte)(wb / 2));
                        DrawPolyOutline(pixels, size, screenPts, wr, wg, wb);
                    }
                }

                var bitmap = new WriteableBitmap(new PixelSize(size, size), new Avalonia.Vector(96, 96),
                    Avalonia.Platform.PixelFormat.Rgba8888);
                using (var fb = bitmap.Lock()) {
                    Marshal.Copy(pixels, 0, fb.Address, Math.Min(pixels.Length, fb.RowBytes * size));
                }
                return bitmap;
            }
            catch { return null; }
        }

        private static void DrawPolyOutline(byte[] pixels, int size, List<(int x, int y)> pts, byte r, byte g, byte b) {
            for (int i = 0; i < pts.Count; i++) {
                int next = (i + 1) % pts.Count;
                DrawLine(pixels, size, pts[i].x, pts[i].y, pts[next].x, pts[next].y, r, g, b);
            }
        }

        private static void FillPolygon(byte[] pixels, int size, List<(int x, int y)> pts, byte r, byte g, byte b) {
            if (pts.Count < 3) return;
            // Fan triangulation from first vertex (works for convex polygons)
            for (int i = 1; i < pts.Count - 1; i++) {
                FillTriangle(pixels, size, pts[0].x, pts[0].y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r, g, b);
            }
        }

        private static void FillTriangle(byte[] pixels, int size,
            int x0, int y0, int x1, int y1, int x2, int y2, byte r, byte g, byte b) {
            // Sort vertices by Y
            if (y0 > y1) { (x0, y0, x1, y1) = (x1, y1, x0, y0); }
            if (y0 > y2) { (x0, y0, x2, y2) = (x2, y2, x0, y0); }
            if (y1 > y2) { (x1, y1, x2, y2) = (x2, y2, x1, y1); }

            int minY = Math.Max(y0, 0);
            int maxY = Math.Min(y2, size - 1);

            for (int y = minY; y <= maxY; y++) {
                float xLeft, xRight;
                if (y < y1) {
                    if (y1 == y0) { xLeft = Math.Min(x0, x1); xRight = Math.Max(x0, x1); }
                    else {
                        float t01 = (float)(y - y0) / (y1 - y0);
                        float t02 = (y2 == y0) ? 0 : (float)(y - y0) / (y2 - y0);
                        xLeft = x0 + t01 * (x1 - x0);
                        xRight = x0 + t02 * (x2 - x0);
                    }
                }
                else {
                    if (y2 == y1) { xLeft = Math.Min(x1, x2); xRight = Math.Max(x1, x2); }
                    else {
                        float t12 = (float)(y - y1) / (y2 - y1);
                        float t02 = (y2 == y0) ? 1 : (float)(y - y0) / (y2 - y0);
                        xLeft = x1 + t12 * (x2 - x1);
                        xRight = x0 + t02 * (x2 - x0);
                    }
                }

                if (xLeft > xRight) (xLeft, xRight) = (xRight, xLeft);
                int startX = Math.Max((int)xLeft, 0);
                int endX = Math.Min((int)xRight, size - 1);

                for (int x = startX; x <= endX; x++) {
                    int idx = (y * size + x) * 4;
                    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
                }
            }
        }

        private static void DrawLine(byte[] pixels, int size, int x0, int y0, int x1, int y1, byte r, byte g, byte b) {
            int dx = Math.Abs(x1 - x0), dy = Math.Abs(y1 - y0);
            int sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
            int err = dx - dy;
            int steps = Math.Max(dx, dy) + 1;
            for (int i = 0; i < steps; i++) {
                if (x0 >= 0 && x0 < size && y0 >= 0 && y0 < size) {
                    int idx = (y0 * size + x0) * 4;
                    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
                }
                if (x0 == x1 && y0 == y1) break;
                int e2 = 2 * err;
                if (e2 > -dy) { err -= dy; x0 += sx; }
                if (e2 < dx) { err += dx; y0 += sy; }
            }
        }

        /// <summary>
        /// Determines how many surface slots a room needs by inspecting its CellStruct polygons.
        /// Used as a fallback when no existing EnvCell reference can be found in the DAT.
        /// </summary>
        private int CountRequiredSurfaceSlots(RoomEntry room) {
            try {
                uint envFileId = room.EnvironmentFileId;
                if (!_dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) return 0;
                if (!env.Cells.TryGetValue(room.CellStructureIndex, out var cellStruct)) return 0;

                var portalIds = cellStruct.Portals != null ? new HashSet<ushort>(cellStruct.Portals) : new HashSet<ushort>();
                int maxIndex = -1;
                foreach (var kvp in cellStruct.Polygons) {
                    if (portalIds.Contains(kvp.Key)) continue;
                    if (kvp.Value.PosSurface > maxIndex) maxIndex = kvp.Value.PosSurface;
                }
                return maxIndex + 1;
            }
            catch { return 0; }
        }

        /// <summary>
        /// Scans existing dungeon EnvCells to find default surface lists for each Environment+CellStruct.
        /// Rooms without surfaces render as invisible, so this is critical for placing new cells.
        /// </summary>
        private void PopulateDefaultSurfaces(List<RoomEntry> rooms) {
            try {
                var lookup = new Dictionary<(ushort envId, ushort cellStruct), List<ushort>>();
                var lbiIds = _dats.Dats.GetAllIdsOfType<DatReaderWriter.DBObjs.LandBlockInfo>().ToArray();
                if (lbiIds.Length == 0) lbiIds = _dats.Dats.Cell.GetAllIdsOfType<DatReaderWriter.DBObjs.LandBlockInfo>().ToArray();
                Console.WriteLine($"[RoomPalette] Scanning {lbiIds.Length} LandBlockInfo entries for default surfaces");

                foreach (var lbiId in lbiIds) {
                    if (!_dats.TryGet<DatReaderWriter.DBObjs.LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0) continue;
                    uint lbId = lbiId >> 16;

                    for (uint i = 0; i < lbi.NumCells; i++) {
                        uint cellId = (lbId << 16) | (0x0100 + i);
                        if (!_dats.TryGet<DatReaderWriter.DBObjs.EnvCell>(cellId, out var envCell)) continue;
                        if (envCell.Surfaces.Count == 0) continue;

                        var key = (envCell.EnvironmentId, envCell.CellStructure);
                        if (!lookup.ContainsKey(key)) {
                            lookup[key] = new List<ushort>(envCell.Surfaces);
                        }
                    }

                    if (lookup.Count > 5000) break;
                }

                int populated = 0;
                foreach (var room in rooms) {
                    if (room.DefaultSurfaces.Count > 0) continue;
                    var key = (room.EnvironmentId, room.CellStructureIndex);
                    if (lookup.TryGetValue(key, out var surfaces)) {
                        room.DefaultSurfaces = new List<ushort>(surfaces);
                        populated++;
                    }
                }

                int fallbackCount = 0;
                foreach (var room in rooms) {
                    if (room.DefaultSurfaces.Count > 0) continue;
                    int slotCount = CountRequiredSurfaceSlots(room);
                    if (slotCount > 0) {
                        room.DefaultSurfaces = Enumerable.Repeat((ushort)0x032A, slotCount).ToList();
                        fallbackCount++;
                    }
                }

                Console.WriteLine($"[RoomPalette] Populated default surfaces for {populated}/{rooms.Count} rooms from {lookup.Count} unique EnvCell entries, {fallbackCount} filled with fallback");

                // Diagnostic: dump a sample dungeon's cells and check if they match room palette entries
                uint sampleLbId = 0x01D9;
                uint sampleLbiId = (sampleLbId << 16) | 0xFFFE;
                if (_dats.TryGet<DatReaderWriter.DBObjs.LandBlockInfo>(sampleLbiId, out var sampleLbi) && sampleLbi.NumCells > 0) {
                    Console.WriteLine($"[RoomPalette] === Sample dungeon 0x{sampleLbId:X4}: {sampleLbi.NumCells} cells ===");
                    var roomLookup = new HashSet<(ushort, ushort)>();
                    foreach (var r in rooms) roomLookup.Add((r.EnvironmentId, r.CellStructureIndex));

                    for (uint ci = 0; ci < Math.Min(sampleLbi.NumCells, 5); ci++) {
                        uint cellId = (sampleLbId << 16) | (0x0100 + ci);
                        if (_dats.TryGet<DatReaderWriter.DBObjs.EnvCell>(cellId, out var ec)) {
                            bool inPalette = roomLookup.Contains((ec.EnvironmentId, ec.CellStructure));
                            Console.WriteLine($"  Cell 0x{cellId:X8}: Env=0x{ec.EnvironmentId:X4} CellStruct={ec.CellStructure} " +
                                $"Surfaces={ec.Surfaces.Count} InPalette={inPalette}");
                        }
                    }
                }
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] Error populating default surfaces: {ex.Message}");
            }
        }

        partial void OnSearchTextChanged(string value) {
            ApplyFilter();
            if (ShowCatalogMode || ShowPrefabsMode || ShowFavoritePrefabsMode) ApplyPrefabFilter();
        }
        partial void OnMinPortalsChanged(int value) => ApplyFilter();
        partial void OnMaxPortalsChanged(int value) => ApplyFilter();

        private void ApplyFilter() {
            var query = SearchText?.Trim() ?? "";
            var filtered = _allRooms.AsEnumerable();

            filtered = filtered.Where(r => r.PortalCount >= MinPortals && r.PortalCount <= MaxPortals);

            if (!string.IsNullOrEmpty(query)) {
                if (uint.TryParse(query, System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var hexVal)) {
                    filtered = filtered.Where(r =>
                        r.EnvironmentFileId == hexVal ||
                        r.EnvironmentId == (ushort)hexVal ||
                        r.EnvironmentFileId.ToString("X8").Contains(query, StringComparison.OrdinalIgnoreCase));
                }
                else {
                    filtered = filtered.Where(r =>
                        r.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase));
                }
            }

            FilteredRooms = new ObservableCollection<RoomEntry>(filtered.Take(200));
            _ = GenerateThumbnailsAsync();
        }

        partial void OnSelectedRoomChanged(RoomEntry? value) {
            if (value != null) {
                RoomSelected?.Invoke(this, value);
            }
        }

        /// <summary>
        /// Returns a friendly display name for a room (e.g. "Corridor (2P, used 17k)") given env file id and cell struct.
        /// Returns null if not found in the room list.
        /// </summary>
        public List<RoomEntry> GetAllRooms() => _allRooms;

        public bool IsFavorite(RoomEntry room) =>
            _favoriteKeys.Contains((room.EnvironmentFileId, room.CellStructureIndex));

        public void ToggleFavorite(RoomEntry room) {
            var key = (room.EnvironmentFileId, room.CellStructureIndex);
            if (_favoriteKeys.Contains(key)) {
                _favoriteKeys.Remove(key);
                FavoriteRooms.Remove(room);
            }
            else {
                _favoriteKeys.Add(key);
                FavoriteRooms.Add(room);
            }
            room.IsFavorite = _favoriteKeys.Contains(key);
            SaveFavorites();
            OnPropertyChanged(nameof(RoomsToShow));
        }

        private void LoadFavorites() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_room_favorites.json");
                if (!File.Exists(path)) return;

                var json = File.ReadAllText(path);
                using var doc = JsonDocument.Parse(json);
                foreach (var item in doc.RootElement.EnumerateArray()) {
                    if (item.TryGetProperty("e", out var e) && item.TryGetProperty("c", out var c))
                        _favoriteKeys.Add((e.GetUInt32(), (ushort)c.GetUInt16()));
                }
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadFavorites: {ex.Message}");
            }
        }

        private void SaveFavorites() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_room_favorites.json");
                var dir = Path.GetDirectoryName(path);
                if (dir != null) Directory.CreateDirectory(dir);

                var entries = _favoriteKeys.Select(k => $"{{\"e\":{k.envFileId},\"c\":{k.cellStructIdx}}}");
                File.WriteAllText(path, $"[{string.Join(",", entries)}]");
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] SaveFavorites: {ex.Message}");
            }
        }

        private void ApplyFavoritesToRooms() {
            FavoriteRooms.Clear();
            foreach (var room in _allRooms) {
                var key = (room.EnvironmentFileId, room.CellStructureIndex);
                room.IsFavorite = _favoriteKeys.Contains(key);
                if (room.IsFavorite)
                    FavoriteRooms.Add(room);
            }
        }

        private void LoadPrefabFavorites() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_prefab_favorites.json");
                if (!File.Exists(path)) return;

                var json = File.ReadAllText(path);
                using var doc = JsonDocument.Parse(json);
                foreach (var item in doc.RootElement.EnumerateArray()) {
                    var sig = item.GetString();
                    if (!string.IsNullOrEmpty(sig))
                        _favoritePrefabSignatures.Add(sig);
                }
                Console.WriteLine($"[RoomPalette] Loaded {_favoritePrefabSignatures.Count} prefab favorites");
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadPrefabFavorites: {ex.Message}");
            }
        }

        private void SavePrefabFavorites() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_prefab_favorites.json");
                var dir = Path.GetDirectoryName(path);
                if (dir != null) Directory.CreateDirectory(dir);

                var json = JsonSerializer.Serialize(_favoritePrefabSignatures.ToList());
                File.WriteAllText(path, json);
                Console.WriteLine($"[RoomPalette] Saved {_favoritePrefabSignatures.Count} prefab favorites");
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] SavePrefabFavorites: {ex.Message}");
            }
        }

        private void LoadCustomPrefabs() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_custom_prefabs.json");
                if (!File.Exists(path)) return;

                var json = File.ReadAllText(path);
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var prefabs = JsonSerializer.Deserialize<List<DungeonPrefab>>(json, options);
                if (prefabs != null) {
                    _customPrefabs = prefabs;
                    Console.WriteLine($"[RoomPalette] Loaded {_customPrefabs.Count} custom prefabs");
                }
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] LoadCustomPrefabs: {ex.Message}");
            }
        }

        private void SaveCustomPrefabs() {
            try {
                var path = Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),
                    "ACME WorldBuilder", "dungeon_custom_prefabs.json");
                var dir = Path.GetDirectoryName(path);
                if (dir != null) Directory.CreateDirectory(dir);

                var options = new JsonSerializerOptions { WriteIndented = true };
                File.WriteAllText(path, JsonSerializer.Serialize(_customPrefabs, options));
            }
            catch (Exception ex) {
                Console.WriteLine($"[RoomPalette] SaveCustomPrefabs: {ex.Message}");
            }
        }

        public string? GetRoomDisplayName(uint envFileId, ushort cellStructIndex) {
            var room = _allRooms.FirstOrDefault(r => r.EnvironmentFileId == envFileId && r.CellStructureIndex == cellStructIndex);
            return room?.DisplayName;
        }

        /// <summary>
        /// Get the default surfaces for a room from an existing EnvCell that uses the same Environment.
        /// Falls back to empty list if no reference can be found.
        /// </summary>
        public List<ushort> GetDefaultSurfaces(RoomEntry room) {
            if (room.DefaultSurfaces.Count > 0) return room.DefaultSurfaces;

            int slotCount = CountRequiredSurfaceSlots(room);
            if (slotCount > 0) {
                room.DefaultSurfaces = Enumerable.Repeat((ushort)0x032A, slotCount).ToList();
                return room.DefaultSurfaces;
            }

            return new List<ushort>();
        }
    }
}
