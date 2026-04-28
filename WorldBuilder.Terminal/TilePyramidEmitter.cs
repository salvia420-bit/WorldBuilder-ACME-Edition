using SkiaSharp;

namespace WorldBuilder.Terminal;

/// <summary>
/// Slices full-LB renders into 256×256 Leaflet tiles and builds the
/// downsample pyramid (z=maxZoom..minZoom) by 2×2 averaging.
///
/// Why not re-render per zoom: at z=12 a single LB is 16×16 tiles (4096px
/// total); re-rendering each lower zoom would 4× the cost for visually
/// identical output. Render once at the deepest zoom, downsample everything
/// else.
///
/// Tile coordinates follow standard Leaflet z/x/y. The world's +Y axis (north)
/// is up; tile +y is down. Y flip is applied here when computing tile rows.
/// </summary>
internal static class TilePyramidEmitter {

    public const int TilePx = 256;

    /// <summary>
    /// Slice a single rendered landblock at the deepest zoom into tiles
    /// and write them to <paramref name="layerDir"/>/{maxZoom}/{x}/{y}.png.
    /// Tiles entirely outside the bitmap (e.g. when an LB straddles the
    /// world edge in some hypothetical future) are skipped.
    /// </summary>
    public static int SliceLbRender(SKBitmap render, ushort lbKey, int maxZoom, string layerDir) {
        int tilesPerLbSide = 1 << (maxZoom - 8);   // z=8 → 1, z=9 → 2, …, z=12 → 16
        if (tilesPerLbSide < 1) tilesPerLbSide = 1;

        int expectedPx = TilePx * tilesPerLbSide;
        if (render.Width != expectedPx || render.Height != expectedPx) {
            throw new ArgumentException(
                $"LB render must be {expectedPx}×{expectedPx} for z={maxZoom}; " +
                $"got {render.Width}×{render.Height}.");
        }

        int lbX = (lbKey >> 8) & 0xFF;
        int lbY = lbKey & 0xFF;
        int totalLbsPerSide = 256;
        int tileBaseX = lbX * tilesPerLbSide;
        // Y flip: world's lbY=0 (south) goes to tile y = (255 - 0) * tilesPerLbSide.
        int tileBaseY = (totalLbsPerSide - 1 - lbY) * tilesPerLbSide;

        int written = 0;
        for (int ty = 0; ty < tilesPerLbSide; ty++) {
            for (int tx = 0; tx < tilesPerLbSide; tx++) {
                int srcX = tx * TilePx;
                int srcY = ty * TilePx;
                int outTileX = tileBaseX + tx;
                int outTileY = tileBaseY + ty;
                using var sub = ExtractSubBitmap(render, srcX, srcY, TilePx, TilePx);
                if (IsBlankTile(sub)) continue;
                var dir = Path.Combine(layerDir, maxZoom.ToString(), outTileX.ToString());
                Directory.CreateDirectory(dir);
                using var img = SKImage.FromBitmap(sub);
                using var data = img.Encode(SKEncodedImageFormat.Png, 90);
                File.WriteAllBytes(Path.Combine(dir, $"{outTileY}.png"), data.ToArray());
                written++;
            }
        }
        return written;
    }

    /// <summary>
    /// Build the pyramid from <paramref name="srcZoom"/> down to <paramref name="minZoom"/>
    /// by 2×2 averaging at each step. Reads tiles from <paramref name="layerDir"/>/{z}/...
    /// and writes the next level in place. Missing source tiles are treated
    /// as fully transparent — the output tile is omitted if all four sources
    /// are missing.
    /// </summary>
    public static int Downsample(string layerDir, int srcZoom, int minZoom) {
        int written = 0;
        for (int z = srcZoom; z > minZoom; z--) {
            int srcSide = 1 << z;          // tiles per world side at z
            int dstZ = z - 1;
            int dstSide = 1 << dstZ;
            for (int dy = 0; dy < dstSide; dy++) {
                for (int dx = 0; dx < dstSide; dx++) {
                    var paths = new[] {
                        TilePath(layerDir, z, dx * 2,     dy * 2),
                        TilePath(layerDir, z, dx * 2 + 1, dy * 2),
                        TilePath(layerDir, z, dx * 2,     dy * 2 + 1),
                        TilePath(layerDir, z, dx * 2 + 1, dy * 2 + 1),
                    };
                    if (!paths.Any(File.Exists)) continue;
                    var quad = new SKBitmap?[4];
                    for (int i = 0; i < 4; i++) {
                        quad[i] = File.Exists(paths[i]) ? SKBitmap.Decode(paths[i]) : null;
                    }
                    using var dst = ComposeAndDownsample(quad);
                    var dir = Path.Combine(layerDir, dstZ.ToString(), dx.ToString());
                    Directory.CreateDirectory(dir);
                    using var img = SKImage.FromBitmap(dst);
                    using var data = img.Encode(SKEncodedImageFormat.Png, 90);
                    File.WriteAllBytes(Path.Combine(dir, $"{dy}.png"), data.ToArray());
                    written++;
                    foreach (var b in quad) b?.Dispose();
                }
            }
        }
        return written;
    }

    public static void WriteFloorTile(SKBitmap render, ushort lbKey, int floor, string floorRoot, int zoom) {
        // Floor tiles aren't a Leaflet pyramid — one image per floor per LB
        // anchored to the LB's tile-coord origin at the chosen zoom. Saved as
        // floor/{lbHex}/{zoom}/{x}/{y}/{floor}.png so the frontend can
        // overlay them on the exterior tiles when a dungeon LB is in view.
        int tilesPerLbSide = 1 << (zoom - 8);
        if (tilesPerLbSide < 1) tilesPerLbSide = 1;
        int lbX = (lbKey >> 8) & 0xFF;
        int lbY = lbKey & 0xFF;
        int tileBaseX = lbX * tilesPerLbSide;
        int tileBaseY = (256 - 1 - lbY) * tilesPerLbSide;
        // For a single per-LB image we just save under (tileBaseX, tileBaseY)
        // rather than slicing — the frontend renders it as a single image
        // overlay sized to the LB's footprint.
        var dir = Path.Combine(floorRoot, $"0x{lbKey:X4}", zoom.ToString(),
            tileBaseX.ToString(), tileBaseY.ToString());
        Directory.CreateDirectory(dir);
        using var img = SKImage.FromBitmap(render);
        using var data = img.Encode(SKEncodedImageFormat.Png, 90);
        File.WriteAllBytes(Path.Combine(dir, $"{floor}.png"), data.ToArray());
    }

    // ────────────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────────────

    private static string TilePath(string layerDir, int z, int x, int y) =>
        Path.Combine(layerDir, z.ToString(), x.ToString(), $"{y}.png");

    private static SKBitmap ExtractSubBitmap(SKBitmap src, int x, int y, int w, int h) {
        var info = new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Premul);
        var sub = new SKBitmap(info);
        using var canvas = new SKCanvas(sub);
        canvas.DrawBitmap(src, new SKRect(x, y, x + w, y + h), new SKRect(0, 0, w, h));
        return sub;
    }

    private static SKBitmap ComposeAndDownsample(SKBitmap?[] quad) {
        // Quadrant order: TL, TR, BL, BR (matches Leaflet's xy convention).
        var info = new SKImageInfo(TilePx, TilePx, SKColorType.Rgba8888, SKAlphaType.Premul);
        var dst = new SKBitmap(info);
        using var canvas = new SKCanvas(dst);
        canvas.Clear(SKColors.Transparent);
        // Why: high-quality 2× → 1× resample for each input, then place the
        // four 128×128 pieces into a 256×256 output. SKPaint with high filter
        // quality gives Mitchell-class output without the newer SamplingOptions
        // API (which is only on bleeding-edge SkiaSharp builds).
        using var paint = new SKPaint { FilterQuality = SKFilterQuality.High, IsAntialias = true };
        var halfDst = new[] {
            new SKRect(0, 0, TilePx / 2, TilePx / 2),
            new SKRect(TilePx / 2, 0, TilePx, TilePx / 2),
            new SKRect(0, TilePx / 2, TilePx / 2, TilePx),
            new SKRect(TilePx / 2, TilePx / 2, TilePx, TilePx),
        };
        for (int i = 0; i < 4; i++) {
            if (quad[i] == null) continue;
            canvas.DrawBitmap(quad[i]!, halfDst[i], paint);
        }
        return dst;
    }

    private static bool IsBlankTile(SKBitmap bmp) {
        // Why: skip tiles that are entirely transparent or solid-background.
        // These accumulate at deep zooms over LBs that have no terrain or
        // objects in that quadrant; storing them as files just inflates the
        // dist. Frontend's tile layer can be configured with errorTileUrl
        // or a transparent fallback instead.
        var pixels = bmp.GetPixelSpan();
        if (pixels.Length == 0) return true;
        byte firstA = pixels[3];
        if (firstA == 0) {
            // Quick check: if the first pixel is transparent, scan a few more.
            for (int i = 7; i < Math.Min(pixels.Length, 256 * 4); i += 4 * 32) {
                if (pixels[i] != 0) return false;
            }
            return true;
        }
        return false;
    }
}
