using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DatReaderWriter.DBObjs;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using WorldBuilder.Editors.Landscape;
using WorldBuilder.Editors.Landscape.ViewModels;
using WorldBuilder.Lib;
using WorldBuilder.Lib.Converters;
using WorldBuilder.Shared.Lib;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Dungeon {
    /// <summary>
    /// Object browser for the Dungeon Editor. Browses Setup/GfxObj objects
    /// from the DAT files for placement as static objects inside dungeon cells.
    /// Adapted from the landscape ObjectBrowserViewModel without terrain context dependencies.
    /// </summary>
    public partial class DungeonObjectBrowserViewModel : ViewModelBase {
        private readonly IDatReaderWriter _dats;
        private readonly ObjectTagIndex _tagIndex = new();
        private readonly Func<ThumbnailRenderService?> _getThumbnailService;
        private readonly ThumbnailCache _thumbnailCache;
        private bool _thumbnailsReady;
        private bool _subscribedToThumbnailReady;
        private uint[] _allSetupIds = Array.Empty<uint>();
        private uint[] _allGfxObjIds = Array.Empty<uint>();

        private readonly Dictionary<uint, ObjectBrowserItem> _itemLookup = new();

        [ObservableProperty] private ObservableCollection<ObjectBrowserItem> _filteredItems = new();
        [ObservableProperty] private string _searchText = "";
        [ObservableProperty] private string _status = "Search by name or hex ID";
        [ObservableProperty] private bool _showSetups = true;
        [ObservableProperty] private bool _showGfxObjs = true;

        public ObjectTagIndex TagIndex => _tagIndex;

        public event EventHandler<ObjectBrowserItem>? PlacementRequested;

        public DungeonObjectBrowserViewModel(IDatReaderWriter dats,
            Func<ThumbnailRenderService?>? getThumbnailService = null,
            ThumbnailCache? thumbnailCache = null) {
            _dats = dats;
            _getThumbnailService = getThumbnailService ?? (() => null);
            _thumbnailCache = thumbnailCache ?? new ThumbnailCache();

            _tagIndex.LoadFromEmbeddedResource();
            ObjectIdToTagsConverter.TagIndex = _tagIndex;

            try {
                _allSetupIds = _dats.Dats.Portal.GetAllIdsOfType<Setup>().OrderBy(id => id).ToArray();
                _allGfxObjIds = _dats.Dats.Portal.GetAllIdsOfType<GfxObj>().OrderBy(id => id).ToArray();
            }
            catch (Exception ex) {
                Console.WriteLine($"[DungeonObjectBrowser] Error loading object IDs: {ex.Message}");
            }

            ApplyFilter();

            _ = Task.Run(async () => {
                await Task.Delay(2000);
                for (int i = 0; i < 30; i++) {
                    if (_getThumbnailService() != null) break;
                    await Task.Delay(500);
                }
                _thumbnailsReady = true;
                Dispatcher.UIThread.Post(() => RequestThumbnails(FilteredItems));
            });
        }

        private void OnThumbnailReady(uint objectId, byte[] rgbaPixels) {
            _thumbnailCache.SaveAsync(objectId, rgbaPixels, ThumbnailRenderService.ThumbnailSize, ThumbnailRenderService.ThumbnailSize);
            var bitmap = ThumbnailCache.CreateBitmapFromRgba(rgbaPixels,
                ThumbnailRenderService.ThumbnailSize, ThumbnailRenderService.ThumbnailSize);
            Dispatcher.UIThread.Post(() => {
                if (_itemLookup.TryGetValue(objectId, out var item)) {
                    item.Thumbnail = bitmap;
                }
            });
        }

        partial void OnSearchTextChanged(string value) => ApplyFilter();
        partial void OnShowSetupsChanged(bool value) => ApplyFilter();
        partial void OnShowGfxObjsChanged(bool value) => ApplyFilter();

        private static bool IsHexSearch(string text, out string normalizedHex) {
            normalizedHex = text.TrimStart('0', 'x', 'X').ToUpperInvariant();
            return uint.TryParse(normalizedHex, System.Globalization.NumberStyles.HexNumber, null, out _);
        }

        private (IEnumerable<uint> setups, IEnumerable<uint> gfxObjs) ApplySearchFilter(
            IEnumerable<uint> setups, IEnumerable<uint> gfxObjs, out string? statusSuffix) {
            statusSuffix = null;
            if (string.IsNullOrWhiteSpace(SearchText)) return (setups, gfxObjs);

            if (IsHexSearch(SearchText, out var hexSearch)) {
                return (
                    setups.Where(id => id.ToString("X8").Contains(hexSearch)),
                    gfxObjs.Where(id => id.ToString("X8").Contains(hexSearch))
                );
            }

            if (!_tagIndex.IsLoaded) {
                statusSuffix = "(keyword index not loaded)";
                return (Array.Empty<uint>(), Array.Empty<uint>());
            }

            var matchedIds = _tagIndex.Search(SearchText);
            if (matchedIds.Count == 0) {
                statusSuffix = $"No results for \"{SearchText}\"";
                return (Array.Empty<uint>(), Array.Empty<uint>());
            }

            statusSuffix = $"Found {matchedIds.Count} matches for \"{SearchText}\"";
            return (
                setups.Where(id => matchedIds.Contains(id)),
                gfxObjs.Where(id => matchedIds.Contains(id))
            );
        }

        private ObservableCollection<ObjectBrowserItem> BuildItems(uint[] setups, uint[] gfxObjs) {
            var items = new ObservableCollection<ObjectBrowserItem>();
            _itemLookup.Clear();

            foreach (var id in setups) {
                var tags = _tagIndex.IsLoaded ? _tagIndex.GetTagString(id) : null;
                var item = new ObjectBrowserItem(id, isSetup: true, tags);
                items.Add(item);
                _itemLookup[id] = item;
            }
            foreach (var id in gfxObjs) {
                var tags = _tagIndex.IsLoaded ? _tagIndex.GetTagString(id) : null;
                var item = new ObjectBrowserItem(id, isSetup: false, tags);
                items.Add(item);
                _itemLookup[id] = item;
            }

            if (_thumbnailsReady) {
                RequestThumbnails(items);
            }

            return items;
        }

        private void RequestThumbnails(ObservableCollection<ObjectBrowserItem> items) {
            var service = _getThumbnailService();

            if (service != null && !_subscribedToThumbnailReady) {
                service.ThumbnailReady += OnThumbnailReady;
                _subscribedToThumbnailReady = true;
            }

            foreach (var item in items) {
                if (item.Thumbnail != null) continue;

                var cachedBitmap = _thumbnailCache.TryLoadCached(item.Id);
                if (cachedBitmap != null) {
                    item.Thumbnail = cachedBitmap;
                    continue;
                }

                service?.RequestThumbnail(item.Id, item.IsSetup);
            }
        }

        private void ApplyFilter() {
            IEnumerable<uint> setups = ShowSetups ? _allSetupIds : Array.Empty<uint>();
            IEnumerable<uint> gfxObjs = ShowGfxObjs ? _allGfxObjIds : Array.Empty<uint>();

            var (fSetups, fGfx) = ApplySearchFilter(setups, gfxObjs, out var statusSuffix);
            var setupResult = fSetups.Take(100).ToArray();
            var gfxResult = fGfx.Take(100).ToArray();
            FilteredItems = BuildItems(setupResult, gfxResult);
            Status = statusSuffix ?? $"Showing {setupResult.Length} Setups, {gfxResult.Length} GfxObjs";
        }

        [RelayCommand]
        private void SelectForPlacement(ObjectBrowserItem item) {
            Status = $"Placing 0x{item.Id:X8} - click in cell to place, Escape to cancel";
            PlacementRequested?.Invoke(this, item);
        }
    }
}
