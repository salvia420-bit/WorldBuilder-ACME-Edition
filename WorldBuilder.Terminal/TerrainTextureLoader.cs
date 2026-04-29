using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using SkiaSharp;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Loads and caches the actual Asheron's Call terrain textures from Region
/// (0x13000000) → TerrainInfo → LandSurfaces → TexMerge → TerrainDesc[i] →
/// TerrainTex.TextureId → SurfaceTexture (0x05) → last Texture (0x06).
///
/// Each terrain type byte (TerrainTextureType, 0..32) maps to a tileable
/// RGBA byte[] suitable for sampling during the per-pixel terrain raster.
/// Cached process-wide because the tiles are immutable per AC release.
/// </summary>
public sealed class TerrainTextureLoader {

    public sealed class Tile {
        public required byte[] Rgba;     // length = Width * Height * 4
        public required int Width;
        public required int Height;
    }

    private readonly Dictionary<byte, Tile?> _byType = new();

    public bool TryGetTile(byte terrainType, out Tile? tile) =>
        _byType.TryGetValue(terrainType, out tile);

    /// <summary>
    /// Build a loader for the given dat archive. Walks the TexMerge terrain
    /// descriptor list and decodes each tile. Failures (DXT format, missing
    /// chain links, etc.) leave that terrain type absent so the caller can
    /// fall back to the procedural palette.
    /// </summary>
    public static TerrainTextureLoader Load(IDatReaderWriter dats) {
        var result = new TerrainTextureLoader();
        if (!SafeTryGet<Region>(dats, 0x13000000, out var region)) {
            Console.Error.WriteLine("[TerrainTex] Region 0x13000000 missing — palette fallback only.");
            return result;
        }
        var landSurfaces = region.TerrainInfo?.LandSurfaces;
        var terrainDesc = landSurfaces?.TexMerge?.TerrainDesc;
        if (terrainDesc == null) {
            Console.Error.WriteLine("[TerrainTex] TerrainInfo.LandSurfaces.TexMerge.TerrainDesc null — palette fallback only.");
            return result;
        }

        int ok = 0, fail = 0;
        string? firstFailNote = null;
        foreach (var td in terrainDesc) {
            byte typeByte = (byte)td.TerrainType;
            uint texId = td.TerrainTex.TextureId.DataId;
            var tile = DecodeChain(dats, texId);
            result._byType[typeByte] = tile;
            if (tile != null) ok++;
            else {
                fail++;
                if (firstFailNote == null)
                    firstFailNote = $"type={td.TerrainType} tex=0x{texId:X8}";
            }
        }
        Console.Error.WriteLine($"[TerrainTex] Loaded {ok} tiles, {fail} failed" +
            (firstFailNote != null ? $" (first miss: {firstFailNote})" : ""));
        return result;
    }

    private static Tile? DecodeChain(IDatReaderWriter dats, uint texRef) {
        // Reuse the same logical chain as ObjectSpriteGenerator: SurfaceTexture
        // (0x05) → last Texture (RenderSurface 0x06) → bitmap. Some chains can
        // start at a Surface (0x08) wrapper instead; handle both.
        uint kind = texRef >> 24;
        uint renderSurfaceDid = texRef;
        if (kind == 0x05) {
            if (!SafeTryGet<SurfaceTexture>(dats, texRef, out var st)) return null;
            if (st.Textures == null || st.Textures.Count == 0) return null;
            // ACViewer's Mapper uses Textures.Last() — the "main" mip / detail
            // tile. Mirror that.
            renderSurfaceDid = st.Textures[st.Textures.Count - 1].DataId;
        } else if (kind == 0x08) {
            if (!SafeTryGet<Surface>(dats, texRef, out var surf)) return null;
            uint inner = surf.OrigTextureId.DataId;
            uint innerKind = inner >> 24;
            if (innerKind == 0x05) {
                if (!SafeTryGet<SurfaceTexture>(dats, inner, out var st)) return null;
                if (st.Textures == null || st.Textures.Count == 0) return null;
                renderSurfaceDid = st.Textures[st.Textures.Count - 1].DataId;
            } else if (innerKind == 0x06) {
                renderSurfaceDid = inner;
            } else return null;
        } else if (kind != 0x06) {
            return null;
        }

        if (!SafeTryGet<RenderSurface>(dats, renderSurfaceDid, out var rs)) return null;
        if (rs.SourceData == null || rs.SourceData.Length == 0) return null;
        return rs.Format switch {
            PixelFormat.PFID_CUSTOM_RAW_JPEG => FromJpeg(rs),
            PixelFormat.PFID_R8G8B8 => FromBgr(rs),
            PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8 => FromRgb(rs),
            PixelFormat.PFID_A8R8G8B8 => FromBgra(rs),
            PixelFormat.PFID_R5G6B5 => From565(rs),
            PixelFormat.PFID_INDEX16 => FromPaletted16(rs, dats),
            PixelFormat.PFID_P8 => FromPaletted8(rs, dats),
            _ => null,
        };
    }

    // ────────────────────────────────────────────────────────────────────
    //  Pixel-format decoders (subset shared with ObjectSpriteGenerator;
    //  here we emit raw RGBA byte[] rather than SKBitmap so the per-pixel
    //  terrain sampler in RenderPreviewRenderer can index into them
    //  without any Skia dispatch on the hot loop).
    // ────────────────────────────────────────────────────────────────────

    private static Tile? FromJpeg(RenderSurface rs) {
        using var bmp = SKBitmap.Decode(rs.SourceData);
        if (bmp == null) return null;
        // Re-encode pixels as straight RGBA8888.
        var info = new SKImageInfo(bmp.Width, bmp.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        using var dst = bmp.Copy(info.ColorType);
        if (dst == null) return null;
        var rgba = new byte[bmp.Width * bmp.Height * 4];
        System.Runtime.InteropServices.Marshal.Copy(dst.GetPixels(), rgba, 0, rgba.Length);
        return new Tile { Rgba = rgba, Width = bmp.Width, Height = bmp.Height };
    }

    private static Tile? FromBgr(RenderSurface rs) {
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h * 3) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 3 + 2];
            dst[i * 4 + 1] = src[i * 3 + 1];
            dst[i * 4 + 2] = src[i * 3 + 0];
            dst[i * 4 + 3] = 255;
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static Tile? FromRgb(RenderSurface rs) {
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h * 3) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 3 + 0];
            dst[i * 4 + 1] = src[i * 3 + 1];
            dst[i * 4 + 2] = src[i * 3 + 2];
            dst[i * 4 + 3] = 255;
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static Tile? FromBgra(RenderSurface rs) {
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h * 4) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 4 + 2];
            dst[i * 4 + 1] = src[i * 4 + 1];
            dst[i * 4 + 2] = src[i * 4 + 0];
            dst[i * 4 + 3] = src[i * 4 + 3];
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static Tile? From565(RenderSurface rs) {
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h * 2) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            ushort v = BitConverter.ToUInt16(src, i * 2);
            dst[i * 4 + 0] = (byte)(((v >> 11) & 0x1F) << 3);
            dst[i * 4 + 1] = (byte)(((v >> 5) & 0x3F) << 2);
            dst[i * 4 + 2] = (byte)((v & 0x1F) << 3);
            dst[i * 4 + 3] = 255;
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static Tile? FromPaletted8(RenderSurface rs, IDatReaderWriter dats) {
        if (!SafeTryGet<Palette>(dats, rs.DefaultPaletteId, out var pal)) return null;
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            int pi = src[i]; if (pi >= pal.Colors.Count) pi = 0;
            var c = pal.Colors[pi];
            dst[i * 4 + 0] = c.Red; dst[i * 4 + 1] = c.Green; dst[i * 4 + 2] = c.Blue; dst[i * 4 + 3] = c.Alpha;
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static Tile? FromPaletted16(RenderSurface rs, IDatReaderWriter dats) {
        if (!SafeTryGet<Palette>(dats, rs.DefaultPaletteId, out var pal)) return null;
        int w = rs.Width, h = rs.Height; var src = rs.SourceData;
        if (src.Length < w * h * 2) return null;
        var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            int pi = BitConverter.ToInt16(src, i * 2);
            if (pi < 0 || pi >= pal.Colors.Count) pi = 0;
            var c = pal.Colors[pi];
            dst[i * 4 + 0] = c.Red; dst[i * 4 + 1] = c.Green; dst[i * 4 + 2] = c.Blue; dst[i * 4 + 3] = c.Alpha;
        }
        return new Tile { Rgba = dst, Width = w, Height = h };
    }

    private static bool SafeTryGet<T>(IDatReaderWriter dats, uint id, out T value)
            where T : class, DatReaderWriter.Lib.IO.IDBObj, new() {
        try { return dats.TryGet<T>(id, out value!); }
        catch { value = null!; return false; }
    }
}
