using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using Chorizite.OpenGLSDLBackend.Lib;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using WorldBuilder.Lib;
using WorldBuilder.Services;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Services;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Editors.Dungeon {

    public partial class SurfaceBrowserItem : ObservableObject {
        public uint Id { get; }
        public ushort UnqualifiedId { get; }
        public string DisplayId { get; }

        [ObservableProperty]
        private WriteableBitmap? _thumbnail;

        public SurfaceBrowserItem(uint id) {
            Id = id;
            UnqualifiedId = (ushort)(id & 0xFFFF);
            DisplayId = $"0x{id:X8}";
        }
    }

    /// <summary>
    /// Browses DAT surfaces (0x08000000 range) for assignment to dungeon cells.
    /// Generates CPU-side thumbnails from texture data.
    /// Has a "Dungeon Surfaces" mode that scans actual dungeon EnvCells to show only
    /// surfaces that are used in existing dungeons (walls, floors, ceilings).
    /// </summary>
    public partial class SurfaceBrowserViewModel : ViewModelBase {
        private const int ThumbSize = 64;

        private readonly IDatReaderWriter _dats;
        private readonly TextureImportService? _textureImport;
        private uint[] _allSurfaceIds = Array.Empty<uint>();
        private uint[] _dungeonSurfaceIds = Array.Empty<uint>();
        private uint[] _currentCellSurfaceIds = Array.Empty<uint>();
        private uint[] _customSurfaceIds = Array.Empty<uint>();
        private bool _dungeonSurfacesScanned;

        [ObservableProperty] private ObservableCollection<SurfaceBrowserItem> _filteredItems = new();
        [ObservableProperty] private string _searchText = "";
        [ObservableProperty] private string _status = "Loading surfaces...";
        [ObservableProperty] private bool _showDungeonOnly = true;
        [ObservableProperty] private bool _showCurrentCellOnly;
        [ObservableProperty] private bool _showCustomOnly;

        public event EventHandler<ushort>? SurfaceSelected;

        public SurfaceBrowserViewModel(IDatReaderWriter dats, TextureImportService? textureImport = null) {
            _dats = dats;
            _textureImport = textureImport;
            LoadCustomSurfaceIds();
            _ = LoadSurfacesAsync();
        }

        private static TopLevel? GetTopLevel() {
            if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
                return desktop.MainWindow;
            return null;
        }

        private void LoadCustomSurfaceIds() {
            if (_textureImport == null) return;
            _customSurfaceIds = _textureImport.Store.GetDungeonSurfaces()
                .Where(e => e.SurfaceGid != 0)
                .Select(e => e.SurfaceGid)
                .ToArray();
        }

        private async Task LoadSurfacesAsync() {
            var ids = await Task.Run(() => {
                try {
                    return _dats.Dats.Portal.GetAllIdsOfType<Surface>().OrderBy(id => id).ToArray();
                }
                catch (Exception ex) {
                    Console.WriteLine($"[SurfaceBrowser] Error loading surface IDs: {ex.Message}");
                    return Array.Empty<uint>();
                }
            });

            _allSurfaceIds = ids;
            Status = $"{ids.Length} surfaces loaded";

            _ = ScanDungeonSurfacesAsync();
        }

        /// <summary>
        /// Scans all dungeon landblocks in cell.dat to find surface IDs actually used
        /// by dungeon EnvCells. This filters thousands of surfaces down to the ~100-200
        /// that are relevant for dungeon wall/floor/ceiling textures.
        /// </summary>
        private async Task ScanDungeonSurfacesAsync() {
            var dungeonSurfaces = await Task.Run(() => {
                var surfaceSet = new HashSet<uint>();
                try {
                    var lbiIds = _dats.Dats.GetAllIdsOfType<LandBlockInfo>().ToArray();
                    if (lbiIds.Length == 0) lbiIds = _dats.Dats.Cell.GetAllIdsOfType<LandBlockInfo>().ToArray();
                    foreach (var lbiId in lbiIds) {
                        if (!_dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0)
                            continue;

                        // Only scan landblocks that have dungeon cells not accounted for by buildings
                        uint lbId = lbiId >> 16;
                        int buildingCellCount = 0;
                        foreach (var b in lbi.Buildings) {
                            buildingCellCount += b.Portals.Count > 0 ? b.Portals.Count * 4 : 2;
                        }
                        // Heuristic: if NumCells greatly exceeds what buildings account for, it's a dungeon
                        if (lbi.NumCells <= (uint)buildingCellCount && lbi.Buildings.Count > 0)
                            continue;

                        for (uint i = 0; i < lbi.NumCells; i++) {
                            uint cellId = (lbId << 16) | (0x0100 + i);
                            if (_dats.TryGet<EnvCell>(cellId, out var envCell)) {
                                foreach (var surfId in envCell.Surfaces) {
                                    surfaceSet.Add((uint)(surfId | 0x08000000));
                                }
                            }
                        }
                    }
                }
                catch (Exception ex) {
                    Console.WriteLine($"[SurfaceBrowser] Error scanning dungeon surfaces: {ex.Message}");
                }
                return surfaceSet.OrderBy(id => id).ToArray();
            });

            _dungeonSurfaceIds = dungeonSurfaces;
            _dungeonSurfacesScanned = true;
            Console.WriteLine($"[SurfaceBrowser] Found {_dungeonSurfaceIds.Length} unique dungeon surfaces from DAT scan");

            Dispatcher.UIThread.Post(ApplyFilter);
        }

        /// <summary>
        /// Called by the editor when a cell is selected to update the "current cell" surface filter.
        /// </summary>
        public void SetCurrentCellSurfaces(IReadOnlyList<ushort>? surfaces) {
            if (surfaces == null || surfaces.Count == 0) {
                _currentCellSurfaceIds = Array.Empty<uint>();
            }
            else {
                _currentCellSurfaceIds = surfaces.Select(s => (uint)(s | 0x08000000)).Distinct().ToArray();
            }

            if (ShowCurrentCellOnly) {
                ApplyFilter();
            }
        }

        partial void OnSearchTextChanged(string value) => ApplyFilter();
        partial void OnShowDungeonOnlyChanged(bool value) {
            if (value) { ShowCurrentCellOnly = false; ShowCustomOnly = false; }
            ApplyFilter();
        }
        partial void OnShowCurrentCellOnlyChanged(bool value) {
            if (value) { ShowDungeonOnly = false; ShowCustomOnly = false; }
            ApplyFilter();
        }
        partial void OnShowCustomOnlyChanged(bool value) {
            if (value) { ShowDungeonOnly = false; ShowCurrentCellOnly = false; }
            ApplyFilter();
        }

        [RelayCommand]
        private async Task ImportSurface() {
            var topLevel = GetTopLevel();
            if (topLevel == null || _textureImport == null) return;

            var files = await topLevel.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions {
                Title = "Import Surface Texture",
                AllowMultiple = false,
                FileTypeFilter = new[] {
                    new FilePickerFileType("Image Files") {
                        Patterns = new[] { "*.png", "*.jpg", "*.jpeg", "*.bmp" }
                    }
                }
            });

            if (files.Count == 0) return;
            var localPath = files[0].TryGetLocalPath();
            if (localPath == null) return;

            try {
                var name = Path.GetFileNameWithoutExtension(localPath);
                var entry = _textureImport.ImportDungeonSurface(localPath, name);

                LoadCustomSurfaceIds();
                _allSurfaceIds = _allSurfaceIds.Concat(_customSurfaceIds).Distinct().OrderBy(id => id).ToArray();
                ApplyFilter();

                Console.WriteLine($"[SurfaceBrowser] Imported custom surface: {name} (0x{entry.SurfaceGid:X8})");
            }
            catch (Exception ex) {
                Console.WriteLine($"[SurfaceBrowser] Failed to import surface: {ex.Message}");
            }
        }

        private void ApplyFilter() {
            IEnumerable<uint> surfaces;

            if (ShowCustomOnly && _customSurfaceIds.Length > 0) {
                surfaces = _customSurfaceIds;
            }
            else if (ShowCurrentCellOnly && _currentCellSurfaceIds.Length > 0) {
                surfaces = _currentCellSurfaceIds;
            }
            else if (ShowDungeonOnly && _dungeonSurfacesScanned) {
                surfaces = _dungeonSurfaceIds;
            }
            else {
                surfaces = _allSurfaceIds;
            }

            if (!string.IsNullOrWhiteSpace(SearchText)) {
                var hex = SearchText.TrimStart('0', 'x', 'X').ToUpperInvariant();
                if (uint.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out _)) {
                    surfaces = surfaces.Where(id => id.ToString("X8").Contains(hex));
                }
            }

            var result = surfaces.Take(200).ToArray();
            var items = new ObservableCollection<SurfaceBrowserItem>();
            foreach (var id in result) {
                items.Add(new SurfaceBrowserItem(id));
            }
            FilteredItems = items;

            string filterLabel = ShowCustomOnly ? "custom" :
                                 ShowCurrentCellOnly ? "cell" :
                                 ShowDungeonOnly ? "dungeon" : "all";
            Status = $"Showing {result.Length} surfaces ({filterLabel})";

            _ = GenerateThumbnailsAsync(items);
        }

        private async Task GenerateThumbnailsAsync(ObservableCollection<SurfaceBrowserItem> items) {
            var snapshot = items.ToArray();
            foreach (var item in snapshot) {
                var bitmap = await Task.Run(() => {
                    var customEntry = _textureImport?.Store.GetDungeonSurfaces()
                        .FirstOrDefault(e => e.SurfaceGid == item.Id);
                    if (customEntry != null) {
                        return _textureImport!.GenerateThumbnail(customEntry, ThumbSize);
                    }
                    return RenderSurfaceThumbnail(item.Id);
                });
                if (bitmap != null) {
                    Dispatcher.UIThread.Post(() => item.Thumbnail = bitmap);
                }
            }
        }

        private WriteableBitmap? RenderSurfaceThumbnail(uint surfaceId) {
            try {
                if (!_dats.TryGet<Surface>(surfaceId, out var surface)) return null;

                bool isSolid = surface.Type.HasFlag(SurfaceType.Base1Solid);
                if (isSolid) {
                    var solidData = TextureHelpers.CreateSolidColorTexture(surface.ColorValue, ThumbSize, ThumbSize);
                    return CreateBitmap(solidData, ThumbSize, ThumbSize);
                }

                if (!_dats.TryGet<SurfaceTexture>(surface.OrigTextureId, out var surfaceTexture) ||
                    surfaceTexture.Textures?.Any() != true) {
                    return null;
                }

                var renderSurfaceId = surfaceTexture.Textures.Last();
                if (!_dats.TryGet<RenderSurface>(renderSurfaceId, out var renderSurface)) return null;

                int w = renderSurface.Width, h = renderSurface.Height;
                byte[]? rgba = null;

                switch (renderSurface.Format) {
                    case DatReaderWriter.Enums.PixelFormat.PFID_A8R8G8B8:
                        rgba = DatIconLoader.SwizzleBgraToRgba(renderSurface.SourceData, w * h);
                        break;

                    case DatReaderWriter.Enums.PixelFormat.PFID_R8G8B8:
                        rgba = new byte[w * h * 4];
                        for (int i = 0; i < w * h; i++) {
                            rgba[i * 4 + 0] = renderSurface.SourceData[i * 3 + 2];
                            rgba[i * 4 + 1] = renderSurface.SourceData[i * 3 + 1];
                            rgba[i * 4 + 2] = renderSurface.SourceData[i * 3 + 0];
                            rgba[i * 4 + 3] = 255;
                        }
                        break;

                    case DatReaderWriter.Enums.PixelFormat.PFID_INDEX16:
                        if (!_dats.TryGet<Palette>(renderSurface.DefaultPaletteId, out var palette)) return null;
                        rgba = new byte[w * h * 4];
                        TextureHelpers.FillIndex16(renderSurface.SourceData, palette, rgba.AsSpan(), w, h);
                        break;

                    case DatReaderWriter.Enums.PixelFormat.PFID_DXT1:
                        rgba = DecompressDxt1(renderSurface.SourceData, w, h);
                        break;

                    case DatReaderWriter.Enums.PixelFormat.PFID_DXT3:
                    case DatReaderWriter.Enums.PixelFormat.PFID_DXT5:
                        rgba = DecompressDxt5(renderSurface.SourceData, w, h,
                            renderSurface.Format == DatReaderWriter.Enums.PixelFormat.PFID_DXT3);
                        break;

                    default:
                        return null;
                }

                if (rgba == null) return null;
                if (w != ThumbSize || h != ThumbSize) {
                    rgba = DownsampleNearest(rgba, w, h, ThumbSize, ThumbSize);
                }
                return CreateBitmap(rgba, ThumbSize, ThumbSize);
            }
            catch (Exception ex) {
                Console.WriteLine($"[SurfaceBrowser] Error generating thumbnail for 0x{surfaceId:X8}: {ex.Message}");
                return null;
            }
        }

        internal static WriteableBitmap CreateBitmap(byte[] rgba, int width, int height) {
            var bitmap = new WriteableBitmap(
                new PixelSize(width, height),
                new Vector(96, 96),
                Avalonia.Platform.PixelFormat.Rgba8888);
            using (var fb = bitmap.Lock()) {
                Marshal.Copy(rgba, 0, fb.Address, Math.Min(rgba.Length, fb.RowBytes * height));
            }
            return bitmap;
        }

        internal static byte[] DownsampleNearest(byte[] src, int srcW, int srcH, int dstW, int dstH) {
            var dst = new byte[dstW * dstH * 4];
            for (int y = 0; y < dstH; y++) {
                int srcY = y * srcH / dstH;
                for (int x = 0; x < dstW; x++) {
                    int srcX = x * srcW / dstW;
                    int si = (srcY * srcW + srcX) * 4;
                    int di = (y * dstW + x) * 4;
                    dst[di] = src[si]; dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
                }
            }
            return dst;
        }

        private static byte[] DecompressDxt1(byte[] data, int width, int height) {
            var rgba = new byte[width * height * 4];
            int blocksW = Math.Max(1, (width + 3) / 4);
            int blocksH = Math.Max(1, (height + 3) / 4);
            int offset = 0;

            for (int by = 0; by < blocksH; by++) {
                for (int bx = 0; bx < blocksW; bx++) {
                    if (offset + 8 > data.Length) break;
                    ushort c0 = (ushort)(data[offset] | (data[offset + 1] << 8));
                    ushort c1 = (ushort)(data[offset + 2] | (data[offset + 3] << 8));
                    uint lookupTable = (uint)(data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24));
                    offset += 8;

                    var colors = new byte[4][];
                    colors[0] = TextureHelpers.Color565ToRgba(c0);
                    colors[1] = TextureHelpers.Color565ToRgba(c1);

                    if (c0 > c1) {
                        colors[2] = new byte[] { (byte)((2 * colors[0][0] + colors[1][0] + 1) / 3), (byte)((2 * colors[0][1] + colors[1][1] + 1) / 3), (byte)((2 * colors[0][2] + colors[1][2] + 1) / 3), 255 };
                        colors[3] = new byte[] { (byte)((colors[0][0] + 2 * colors[1][0] + 1) / 3), (byte)((colors[0][1] + 2 * colors[1][1] + 1) / 3), (byte)((colors[0][2] + 2 * colors[1][2] + 1) / 3), 255 };
                    }
                    else {
                        colors[2] = new byte[] { (byte)((colors[0][0] + colors[1][0]) / 2), (byte)((colors[0][1] + colors[1][1]) / 2), (byte)((colors[0][2] + colors[1][2]) / 2), 255 };
                        colors[3] = new byte[] { 0, 0, 0, 0 };
                    }

                    for (int row = 0; row < 4; row++) {
                        for (int col = 0; col < 4; col++) {
                            int px = bx * 4 + col, py = by * 4 + row;
                            if (px >= width || py >= height) { lookupTable >>= 2; continue; }
                            int idx = (int)(lookupTable & 3);
                            lookupTable >>= 2;
                            int di = (py * width + px) * 4;
                            rgba[di] = colors[idx][0]; rgba[di + 1] = colors[idx][1];
                            rgba[di + 2] = colors[idx][2]; rgba[di + 3] = colors[idx][3];
                        }
                    }
                }
            }
            return rgba;
        }

        private static byte[] DecompressDxt5(byte[] data, int width, int height, bool isDxt3) {
            var rgba = new byte[width * height * 4];
            int blocksW = Math.Max(1, (width + 3) / 4);
            int blocksH = Math.Max(1, (height + 3) / 4);
            int offset = 0;

            for (int by = 0; by < blocksH; by++) {
                for (int bx = 0; bx < blocksW; bx++) {
                    if (offset + 16 > data.Length) break;

                    byte[] alphas = new byte[16];
                    if (isDxt3) {
                        for (int i = 0; i < 4; i++) {
                            ushort row = (ushort)(data[offset + i * 2] | (data[offset + i * 2 + 1] << 8));
                            for (int j = 0; j < 4; j++) {
                                alphas[i * 4 + j] = (byte)(((row >> (j * 4)) & 0xF) * 17);
                            }
                        }
                    }
                    else {
                        byte a0 = data[offset], a1 = data[offset + 1];
                        byte[] aLut = new byte[8];
                        aLut[0] = a0; aLut[1] = a1;
                        if (a0 > a1) {
                            for (int i = 1; i <= 6; i++) aLut[i + 1] = (byte)(((7 - i) * a0 + i * a1 + 3) / 7);
                        }
                        else {
                            for (int i = 1; i <= 4; i++) aLut[i + 1] = (byte)(((5 - i) * a0 + i * a1 + 2) / 5);
                            aLut[6] = 0; aLut[7] = 255;
                        }
                        ulong bits = 0;
                        for (int i = 0; i < 6; i++) bits |= (ulong)data[offset + 2 + i] << (8 * i);
                        for (int i = 0; i < 16; i++) {
                            alphas[i] = aLut[(bits >> (3 * i)) & 7];
                        }
                    }
                    offset += 8;

                    ushort c0 = (ushort)(data[offset] | (data[offset + 1] << 8));
                    ushort c1 = (ushort)(data[offset + 2] | (data[offset + 3] << 8));
                    uint lookupTable = (uint)(data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24));
                    offset += 8;

                    var colors = new byte[4][];
                    colors[0] = TextureHelpers.Color565ToRgba(c0);
                    colors[1] = TextureHelpers.Color565ToRgba(c1);
                    colors[2] = new byte[] { (byte)((2 * colors[0][0] + colors[1][0] + 1) / 3), (byte)((2 * colors[0][1] + colors[1][1] + 1) / 3), (byte)((2 * colors[0][2] + colors[1][2] + 1) / 3), 255 };
                    colors[3] = new byte[] { (byte)((colors[0][0] + 2 * colors[1][0] + 1) / 3), (byte)((colors[0][1] + 2 * colors[1][1] + 1) / 3), (byte)((colors[0][2] + 2 * colors[1][2] + 1) / 3), 255 };

                    for (int row = 0; row < 4; row++) {
                        for (int col = 0; col < 4; col++) {
                            int px = bx * 4 + col, py = by * 4 + row;
                            if (px >= width || py >= height) { lookupTable >>= 2; continue; }
                            int idx = (int)(lookupTable & 3);
                            lookupTable >>= 2;
                            int di = (py * width + px) * 4;
                            rgba[di] = colors[idx][0]; rgba[di + 1] = colors[idx][1];
                            rgba[di + 2] = colors[idx][2]; rgba[di + 3] = alphas[row * 4 + col];
                        }
                    }
                }
            }
            return rgba;
        }

        [RelayCommand]
        private void SelectSurface(SurfaceBrowserItem item) {
            SurfaceSelected?.Invoke(this, item.UnqualifiedId);
        }
    }
}
