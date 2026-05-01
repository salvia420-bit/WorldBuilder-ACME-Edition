using Avalonia.Media.Imaging;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatPixelFormat = DatReaderWriter.Enums.PixelFormat;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Texture;
using WorldBuilder.Shared.Models;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Services {

    /// <summary>
    /// GUI-side wrapper around <see cref="RenderSurfaceImporter"/>.
    /// Owns the per-project <see cref="CustomTextureStore"/> and produces the
    /// Avalonia <see cref="WriteableBitmap"/> previews/thumbnails the editor needs.
    /// </summary>
    public class TextureImportService {
        private readonly CustomTextureStore _store;
        private readonly Project _project;

        public CustomTextureStore Store => _store;

        public TextureImportService(CustomTextureStore store, Project project) {
            _store = store;
            _project = project;
            EnsureGidsAllocated();
        }

        private void EnsureGidsAllocated() {
            bool changed = false;
            foreach (var entry in _store.Entries) {
                if (entry.Usage == CustomTextureUsage.UiRenderSurface) {
                    Console.WriteLine($"[TextureImport] Ignoring deprecated UiRenderSurface entry '{entry.Name}' — remove it from custom_textures.json.");
                    continue;
                }

                if (entry.RenderSurfaceGid == 0) {
                    AllocateGidsForEntry(entry);
                    changed = true;
                }
            }
            if (changed) _store.Save();
        }

        private void AllocateGidsForEntry(CustomTextureEntry entry) {
            var existingRs = GetExistingRenderSurfaceIds();
            var existingSt = GetExistingSurfaceTextureIds();
            var allocatedRs = _store.Entries.Select(e => e.RenderSurfaceGid).Where(id => id != 0);
            var allocatedSt = _store.Entries.Select(e => e.SurfaceTextureGid).Where(id => id != 0);

            entry.RenderSurfaceGid = CustomTextureStore.AllocateGid(0x06000000, existingRs.Concat(allocatedRs));
            entry.SurfaceTextureGid = CustomTextureStore.AllocateGid(0x05000000, existingSt.Concat(allocatedSt));

            if (entry.Usage == CustomTextureUsage.DungeonSurface) {
                var existingSurf = GetExistingSurfaceIds();
                var allocatedSurf = _store.Entries.Select(e => e.SurfaceGid).Where(id => id != 0);
                entry.SurfaceGid = CustomTextureStore.AllocateSurfaceGid(existingSurf.Concat(allocatedSurf));
            }
        }

        private uint[] GetExistingRenderSurfaceIds() {
            try { return _project.DatReaderWriter.Dats.Portal.GetAllIdsOfType<RenderSurface>().ToArray(); }
            catch { return Array.Empty<uint>(); }
        }

        private uint[] GetExistingSurfaceTextureIds() {
            try { return _project.DatReaderWriter.Dats.Portal.GetAllIdsOfType<SurfaceTexture>().ToArray(); }
            catch { return Array.Empty<uint>(); }
        }

        private uint[] GetExistingSurfaceIds() {
            try { return _project.DatReaderWriter.Dats.Portal.GetAllIdsOfType<Surface>().ToArray(); }
            catch { return Array.Empty<uint>(); }
        }

        public CustomTextureEntry ImportDungeonSurface(string imagePath, string name) {
            var entry = _store.Import(imagePath, name, CustomTextureUsage.DungeonSurface);
            AllocateGidsForEntry(entry);

            var storedPath = _store.GetImagePath(entry);
            using var img = Image.Load<Rgba32>(storedPath);
            entry.Width = img.Width;
            entry.Height = img.Height;

            _store.Save();
            return entry;
        }

        public CustomTextureEntry ImportTerrainReplacement(string imagePath, string name, TerrainTextureType terrainType) {
            var existing = _store.GetTerrainReplacement((int)terrainType);
            if (existing != null) {
                _store.Remove(existing.Id);
            }

            var entry = _store.Import(imagePath, name, CustomTextureUsage.TerrainReplace, (int)terrainType);
            AllocateGidsForEntry(entry);
            entry.Width = 512;
            entry.Height = 512;
            _store.Save();
            return entry;
        }

        public bool TryImportRenderSurfaceReplacement(string imagePath, uint renderSurfaceId, string name, out string error) {
            return RenderSurfaceImporter.TryImportRenderSurfaceReplacement(
                _project.DatReaderWriter, _store, imagePath, renderSurfaceId, name, out error);
        }

        public static byte[] LoadImageAsBgra(string imagePath, int targetWidth = 512, int targetHeight = 512)
            => RenderSurfaceImporter.LoadImageAsBgra(imagePath, targetWidth, targetHeight);

        public static bool IsRenderSurfaceDatId(uint id) => RenderSurfaceImporter.IsRenderSurfaceDatId(id);

        public bool TryOverwriteUiRenderSurface(string imagePath, uint renderSurfaceId, PortalDatDocument portalDoc) {
            var dats = _project.DocumentManager?.Dats;
            if (dats == null) {
                Console.WriteLine("[TextureImport] Replace UI texture: DocumentManager.Dats is null.");
                return false;
            }
            var ok = RenderSurfaceImporter.TryOverwriteUiRenderSurface(
                dats, portalDoc, imagePath, renderSurfaceId, out var error);
            if (!ok) Console.WriteLine($"[TextureImport] Replace UI texture: {error}");
            return ok;
        }

        /// <summary>CPU preview for layout panel after a disk replace (same proportional sizing as DAT decode).</summary>
        public static WriteableBitmap? TryCreateWriteableBitmapPreview(string imagePath, int maxEdge) {
            if (!File.Exists(imagePath) || maxEdge < 1) return null;
            try {
                using var img = Image.Load<Rgba32>(imagePath);
                int w = img.Width, h = img.Height;
                int dw = maxEdge, dh = maxEdge;
                if (w > h)
                    dh = Math.Max(1, h * maxEdge / w);
                else if (h > w)
                    dw = Math.Max(1, w * maxEdge / h);
                if (w != dw || h != dh)
                    img.Mutate(x => x.Resize(dw, dh));

                var rgba = new byte[dw * dh * 4];
                for (int y = 0; y < dh; y++) {
                    for (int x = 0; x < dw; x++) {
                        var pixel = img[x, y];
                        int idx = (y * dw + x) * 4;
                        rgba[idx + 0] = pixel.R;
                        rgba[idx + 1] = pixel.G;
                        rgba[idx + 2] = pixel.B;
                        rgba[idx + 3] = pixel.A;
                    }
                }

                var bitmap = new WriteableBitmap(
                    new Avalonia.PixelSize(dw, dh),
                    new Avalonia.Vector(96, 96),
                    Avalonia.Platform.PixelFormat.Rgba8888,
                    Avalonia.Platform.AlphaFormat.Premul);
                using (var fb = bitmap.Lock())
                    Marshal.Copy(rgba, 0, fb.Address, rgba.Length);
                return bitmap;
            }
            catch (Exception ex) {
                Console.WriteLine($"[TextureImport] Preview from file failed: {ex.Message}");
                return null;
            }
        }

        public static RenderSurface CreateRenderSurface(uint gid, byte[] bgraData, int width, int height)
            => RenderSurfaceImporter.CreateRenderSurface(gid, bgraData, width, height);

        public static RenderSurface RenderSurfaceWithReplacedPixels(RenderSurface existing, byte[] bgraData)
            => RenderSurfaceImporter.RenderSurfaceWithReplacedPixels(existing, bgraData);

        public static SurfaceTexture CreateSurfaceTexture(uint gid, uint renderSurfaceGid)
            => RenderSurfaceImporter.CreateSurfaceTexture(gid, renderSurfaceGid);

        public static Surface CreateSurface(uint gid, uint surfaceTextureGid)
            => RenderSurfaceImporter.CreateSurface(gid, surfaceTextureGid);

        /// <summary>
        /// Writes all custom textures to DATs during export. Delegates to the Shared importer.
        /// </summary>
        public void WriteToDats(IDatReaderWriter writer, int? iteration = 0)
            => RenderSurfaceImporter.WriteCustomTexturesToDats(writer, _store, iteration);

        /// <summary>
        /// Updates the Region's TerrainDesc for terrain replacements during export.
        /// No longer needed since we overwrite existing entries in-place; kept for back-compat.
        /// </summary>
        public void UpdateRegionForTerrainReplacements(IDatReaderWriter writer, int? iteration = 0) {
        }

        /// <summary>
        /// Generates an Avalonia thumbnail bitmap from a custom texture entry.
        /// </summary>
        public WriteableBitmap? GenerateThumbnail(CustomTextureEntry entry, int size = 64) {
            var imagePath = _store.GetImagePath(entry);
            if (!File.Exists(imagePath)) return null;

            try {
                using var img = Image.Load<Rgba32>(imagePath);
                if (img.Width != size || img.Height != size) {
                    img.Mutate(x => x.Resize(size, size));
                }

                var rgba = new byte[size * size * 4];
                for (int y = 0; y < size; y++) {
                    for (int x = 0; x < size; x++) {
                        var pixel = img[x, y];
                        int idx = (y * size + x) * 4;
                        rgba[idx + 0] = pixel.R;
                        rgba[idx + 1] = pixel.G;
                        rgba[idx + 2] = pixel.B;
                        rgba[idx + 3] = pixel.A;
                    }
                }

                var bitmap = new WriteableBitmap(
                    new Avalonia.PixelSize(size, size),
                    new Avalonia.Vector(96, 96),
                    Avalonia.Platform.PixelFormat.Rgba8888,
                    Avalonia.Platform.AlphaFormat.Premul);

                using (var fb = bitmap.Lock()) {
                    Marshal.Copy(rgba, 0, fb.Address, rgba.Length);
                }

                return bitmap;
            }
            catch {
                return null;
            }
        }

        /// <summary>
        /// Loads full-size RGBA data for a custom texture (for terrain atlas injection).
        /// </summary>
        public byte[]? LoadTextureRgba(CustomTextureEntry entry, int width = 512, int height = 512) {
            var imagePath = _store.GetImagePath(entry);
            if (!File.Exists(imagePath)) return null;

            try {
                using var img = Image.Load<Rgba32>(imagePath);
                if (img.Width != width || img.Height != height) {
                    img.Mutate(x => x.Resize(width, height));
                }

                var rgba = new byte[width * height * 4];
                for (int y = 0; y < height; y++) {
                    for (int x = 0; x < width; x++) {
                        var pixel = img[x, y];
                        int idx = (y * width + x) * 4;
                        rgba[idx + 0] = pixel.R;
                        rgba[idx + 1] = pixel.G;
                        rgba[idx + 2] = pixel.B;
                        rgba[idx + 3] = pixel.A;
                    }
                }
                return rgba;
            }
            catch {
                return null;
            }
        }
    }
}
