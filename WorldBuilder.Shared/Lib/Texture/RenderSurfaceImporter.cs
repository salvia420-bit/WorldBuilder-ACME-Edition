using System;
using System.IO;
using System.Linq;
using DatReaderWriter;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatPixelFormat = DatReaderWriter.Enums.PixelFormat;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Shared.Lib.Texture {
    /// <summary>
    /// Pure render-surface import + DAT-write helpers shared by the Avalonia GUI
    /// (`TextureImportService`) and headless `import-render-surface` command.
    /// All methods are stateless; persistence is owned by the caller (CustomTextureStore
    /// or PortalDatDocument).
    /// </summary>
    public static class RenderSurfaceImporter {
        /// <summary>True for full DAT ids in the RenderSurface portal range (0x06……).</summary>
        public static bool IsRenderSurfaceDatId(uint id) => (id & 0xFF000000) == 0x06000000;

        /// <summary>
        /// Loads an image and converts to BGRA byte data for RenderSurface PFID_A8R8G8B8 format.
        /// </summary>
        public static byte[] LoadImageAsBgra(string imagePath, int targetWidth = 512, int targetHeight = 512) {
            using var img = Image.Load<Rgba32>(imagePath);
            if (img.Width != targetWidth || img.Height != targetHeight) {
                img.Mutate(x => x.Resize(targetWidth, targetHeight));
            }
            var bgra = new byte[targetWidth * targetHeight * 4];
            for (int y = 0; y < targetHeight; y++) {
                for (int x = 0; x < targetWidth; x++) {
                    var pixel = img[x, y];
                    int idx = (y * targetWidth + x) * 4;
                    bgra[idx + 0] = pixel.B;
                    bgra[idx + 1] = pixel.G;
                    bgra[idx + 2] = pixel.R;
                    bgra[idx + 3] = pixel.A;
                }
            }
            return bgra;
        }

        public static RenderSurface CreateRenderSurface(uint gid, byte[] bgraData, int width, int height) {
            return new RenderSurface {
                Id = gid,
                Width = width,
                Height = height,
                Format = DatPixelFormat.PFID_A8R8G8B8,
                SourceData = bgraData
            };
        }

        /// <summary>Preserves portal fields from the original RenderSurface; only replaces SourceData.</summary>
        public static RenderSurface RenderSurfaceWithReplacedPixels(RenderSurface existing, byte[] bgraData) {
            return new RenderSurface {
                Id = existing.Id,
                Width = existing.Width,
                Height = existing.Height,
                Format = existing.Format,
                DefaultPaletteId = existing.DefaultPaletteId,
                SourceData = bgraData
            };
        }

        public static SurfaceTexture CreateSurfaceTexture(uint gid, uint renderSurfaceGid) {
            var st = new SurfaceTexture {
                Id = gid,
                Type = TextureType.Texture2D
            };
            st.Textures.Add(renderSurfaceGid);
            return st;
        }

        public static Surface CreateSurface(uint gid, uint surfaceTextureGid) {
            return new Surface {
                Id = gid,
                Type = SurfaceType.Base1Image,
                OrigTextureId = surfaceTextureGid,
                OrigPaletteId = 0,
                Translucency = 0f,
                Luminosity = 0f,
                Diffuse = 1f
            };
        }

        // ─────────────────────────────────────────────────────────────────
        //  Validation + import (drives CustomTextureStore for persistence)
        // ─────────────────────────────────────────────────────────────────

        /// <summary>
        /// Validates and registers a RenderSurface replacement in the project's CustomTextureStore.
        /// The actual DAT write happens later via <see cref="WriteCustomTexturesToDats"/> during export.
        /// </summary>
        public static bool TryImportRenderSurfaceReplacement(
            IDatReaderWriter dats, CustomTextureStore store,
            string imagePath, uint renderSurfaceId, string name,
            out string error) {
            error = "";

            if (!File.Exists(imagePath)) {
                error = "Image file not found.";
                return false;
            }
            if (dats == null) {
                error = "DAT files not loaded.";
                return false;
            }

            if (!dats.TryGet<RenderSurface>(renderSurfaceId, out var existing) || existing == null) {
                error = $"RenderSurface 0x{renderSurfaceId:X8} not found in DAT files.";
                return false;
            }

            if (existing.Width <= 0 || existing.Height <= 0) {
                error = $"RenderSurface 0x{renderSurfaceId:X8} has invalid dimensions {existing.Width}x{existing.Height}.";
                return false;
            }

            if (existing.Format != DatPixelFormat.PFID_A8R8G8B8) {
                error = $"RenderSurface 0x{renderSurfaceId:X8} uses {existing.Format} format. Only PFID_A8R8G8B8 (uncompressed BGRA) can be replaced. Original is likely DXT-compressed.";
                return false;
            }

            var existingEntry = store.GetRenderSurfaceReplacement(renderSurfaceId);
            if (existingEntry != null) {
                store.Remove(existingEntry.Id);
            }

            var entry = store.Import(imagePath, name, CustomTextureUsage.RenderSurfaceReplace);
            entry.ReplacesRenderSurfaceId = renderSurfaceId;
            entry.Width = existing.Width;
            entry.Height = existing.Height;
            store.Save();

            // stderr, not stdout: in stdin JSON mode Console.Out is the one-JSON-object-per-line protocol stream.
            Console.Error.WriteLine($"[TextureImport] Imported RenderSurface replacement '{name}' for 0x{renderSurfaceId:X8} ({existing.Width}x{existing.Height}, {existing.Format})");
            return true;
        }

        /// <summary>
        /// Replaces pixel data for an existing RenderSurface (same width/height as the DAT entry)
        /// and stores the result in the <paramref name="portalDoc"/> for deferred export.
        /// </summary>
        public static bool TryOverwriteUiRenderSurface(
            IDatReaderWriter dats, PortalDatDocument portalDoc,
            string imagePath, uint renderSurfaceId,
            out string error) {
            error = "";

            if (!File.Exists(imagePath)) {
                error = "Image file not found.";
                return false;
            }
            if (dats == null) {
                error = "DAT files not loaded.";
                return false;
            }

            try {
                if (!dats.TryGet<RenderSurface>(renderSurfaceId, out var existing) || existing == null) {
                    error = $"No RenderSurface at 0x{renderSurfaceId:X8} (TryGet failed).";
                    return false;
                }

                int w = existing.Width, h = existing.Height;
                if (w <= 0 || h <= 0) {
                    error = $"Invalid size {w}x{h} for 0x{renderSurfaceId:X8}.";
                    return false;
                }

                if (existing.Format != DatPixelFormat.PFID_A8R8G8B8) {
                    error = $"0x{renderSurfaceId:X8} uses {existing.Format}; only PFID_A8R8G8B8 (raw BGRA) can be replaced from an image.";
                    return false;
                }

                byte[] bgra;
                try { bgra = LoadImageAsBgra(imagePath, w, h); }
                catch (Exception ex) {
                    error = $"could not load/resize image: {ex.Message}";
                    return false;
                }

                if (bgra.Length < (long)w * h * 4) {
                    error = $"decoded buffer too small for {w}x{h} A8R8G8B8.";
                    return false;
                }

                var rs = RenderSurfaceWithReplacedPixels(existing, bgra);
                portalDoc.SetEntry<RenderSurface>(renderSurfaceId, rs);

                // stderr, not stdout: in stdin JSON mode Console.Out is the one-JSON-object-per-line protocol stream.
                Console.Error.WriteLine($"[TextureImport] Replace UI texture: stored 0x{renderSurfaceId:X8} ({w}x{h}) — will be written to DAT on export.");
                return true;
            }
            catch (Exception ex) {
                error = $"{ex.GetType().Name}: {ex.Message}";
                return false;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        //  Export-time DAT writes (driven by Project.OnExportCustomTextures
        //  on both GUI and headless surfaces).
        // ─────────────────────────────────────────────────────────────────

        public static void WriteCustomTexturesToDats(IDatReaderWriter writer, CustomTextureStore store, int? iteration = 0) {
            WriteTerrainReplacementsToDats(writer, store, iteration);
            WriteRenderSurfaceReplacementsToDats(writer, store, iteration);
            WriteDungeonSurfacesToDats(writer, store, iteration);
        }

        public static void WriteRenderSurfaceReplacementsToDats(IDatReaderWriter writer, CustomTextureStore store, int? iteration) {
            var replacements = store.GetRenderSurfaceReplacements().ToList();
            if (replacements.Count == 0) return;

            foreach (var entry in replacements) {
                var targetRsId = entry.ReplacesRenderSurfaceId;
                if (targetRsId == 0) continue;

                var imagePath = store.GetImagePath(entry);
                if (!File.Exists(imagePath)) continue;

                try {
                    if (!writer.TryGet<RenderSurface>(targetRsId, out var originalRs) || originalRs == null) {
                        Console.WriteLine($"[TextureImport] Failed to read RenderSurface 0x{targetRsId:X8} for '{entry.Name}'");
                        continue;
                    }
                    if (originalRs.Format != DatPixelFormat.PFID_A8R8G8B8) {
                        Console.WriteLine($"[TextureImport] Cannot replace '{entry.Name}': RenderSurface 0x{targetRsId:X8} uses {originalRs.Format}, only PFID_A8R8G8B8 can be replaced.");
                        continue;
                    }
                    if (originalRs.Width != entry.Width || originalRs.Height != entry.Height) {
                        Console.WriteLine($"[TextureImport] Resizing '{entry.Name}' from {entry.Width}x{entry.Height} to {originalRs.Width}x{originalRs.Height}.");
                        entry.Width = originalRs.Width;
                        entry.Height = originalRs.Height;
                    }

                    var bgraData = LoadImageAsBgra(imagePath, entry.Width, entry.Height);
                    var rs = RenderSurfaceWithReplacedPixels(originalRs, bgraData);
                    writer.TrySave(rs, iteration);

                    Console.WriteLine($"[TextureImport] Replaced RenderSurface '{entry.Name}' at 0x{targetRsId:X8} ({originalRs.Width}x{originalRs.Height}, {originalRs.Format})");
                }
                catch (Exception ex) {
                    Console.WriteLine($"[TextureImport] Failed to replace RenderSurface '{entry.Name}': {ex.Message}");
                }
            }
        }

        public static void WriteTerrainReplacementsToDats(IDatReaderWriter writer, CustomTextureStore store, int? iteration) {
            var terrainReplacements = store.GetTerrainReplacements().ToList();
            if (terrainReplacements.Count == 0) return;

            if (!writer.TryGet<Region>(0x13000000, out var region)) {
                Console.WriteLine("[TextureImport] Failed to load Region for terrain replacement");
                return;
            }

            foreach (var entry in terrainReplacements) {
                if (entry.ReplacesTerrainType == null) continue;
                var targetType = (TerrainTextureType)entry.ReplacesTerrainType.Value;

                var imagePath = store.GetImagePath(entry);
                if (!File.Exists(imagePath)) continue;

                var desc = region.TerrainInfo.LandSurfaces.TexMerge.TerrainDesc
                    .FirstOrDefault(d => d.TerrainType == targetType);
                if (desc == null) {
                    Console.WriteLine($"[TextureImport] No TerrainDesc found for {targetType}");
                    continue;
                }

                var originalStId = desc.TerrainTex.TextureId;
                if (!writer.TryGet<SurfaceTexture>(originalStId, out var originalSt) || originalSt.Textures.Count == 0) {
                    Console.WriteLine($"[TextureImport] Failed to read SurfaceTexture 0x{originalStId:X8} for {targetType}");
                    continue;
                }

                var originalRsId = originalSt.Textures[^1];

                try {
                    if (!writer.TryGet<RenderSurface>(originalRsId, out var originalRs) || originalRs == null) {
                        Console.WriteLine($"[TextureImport] Failed to read original RenderSurface 0x{originalRsId:X8} for terrain '{entry.Name}'");
                        continue;
                    }
                    if (originalRs.Format != DatPixelFormat.PFID_A8R8G8B8) {
                        Console.WriteLine($"[TextureImport] Cannot replace terrain '{entry.Name}': uses {originalRs.Format}, only PFID_A8R8G8B8 can be replaced.");
                        continue;
                    }
                    if (originalRs.Width != entry.Width || originalRs.Height != entry.Height) {
                        Console.WriteLine($"[TextureImport] Resizing terrain '{entry.Name}' to {originalRs.Width}x{originalRs.Height}.");
                        entry.Width = originalRs.Width;
                        entry.Height = originalRs.Height;
                    }

                    var bgraData = LoadImageAsBgra(imagePath, entry.Width, entry.Height);
                    var rs = RenderSurfaceWithReplacedPixels(originalRs, bgraData);
                    writer.TrySave(rs, iteration);

                    Console.WriteLine($"[TextureImport] Replaced terrain '{entry.Name}' by overwriting RS=0x{originalRsId:X8} ({originalRs.Width}x{originalRs.Height}, {originalRs.Format})");
                }
                catch (Exception ex) {
                    Console.WriteLine($"[TextureImport] Failed to replace terrain '{entry.Name}': {ex.Message}");
                }
            }
        }

        public static void WriteDungeonSurfacesToDats(IDatReaderWriter writer, CustomTextureStore store, int? iteration) {
            foreach (var entry in store.Entries.Where(e => e.Usage == CustomTextureUsage.DungeonSurface)) {
                var imagePath = store.GetImagePath(entry);
                if (!File.Exists(imagePath)) continue;

                try {
                    if (entry.Width <= 0 || entry.Height <= 0 || entry.Width > 4096 || entry.Height > 4096) {
                        Console.WriteLine($"[TextureImport] Invalid dimensions {entry.Width}x{entry.Height} for dungeon surface '{entry.Name}'");
                        continue;
                    }

                    var bgraData = LoadImageAsBgra(imagePath, entry.Width, entry.Height);
                    int expectedSize = entry.Width * entry.Height * 4;
                    if (bgraData.Length != expectedSize) {
                        Console.WriteLine($"[TextureImport] Buffer size mismatch for '{entry.Name}': expected {expectedSize}, got {bgraData.Length}");
                        continue;
                    }

                    var rs = CreateRenderSurface(entry.RenderSurfaceGid, bgraData, entry.Width, entry.Height);
                    writer.TrySave(rs, iteration);

                    var st = CreateSurfaceTexture(entry.SurfaceTextureGid, entry.RenderSurfaceGid);
                    writer.TrySave(st, iteration);

                    if (entry.SurfaceGid != 0) {
                        var surf = CreateSurface(entry.SurfaceGid, entry.SurfaceTextureGid);
                        writer.TrySave(surf, iteration);
                    }

                    Console.WriteLine($"[TextureImport] Exported dungeon surface '{entry.Name}' (RS=0x{entry.RenderSurfaceGid:X8}, ST=0x{entry.SurfaceTextureGid:X8}, Surf=0x{entry.SurfaceGid:X8}, {entry.Width}x{entry.Height}, PFID_A8R8G8B8)");
                }
                catch (Exception ex) {
                    Console.WriteLine($"[TextureImport] Failed to write dungeon surface '{entry.Name}': {ex.Message}");
                }
            }
        }
    }
}
