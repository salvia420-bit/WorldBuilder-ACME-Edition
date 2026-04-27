using SkiaSharp;

namespace WorldBuilder.Terminal;

/// <summary>
/// Produces atlas tiles by wrapping render-preview and re-encoding as JPEG.
///
/// Three zoom levels:
///   LB     — single landblock at 512×512, ~80KB JPEG
///   Region — 13 named regions (from region_gazetteer) at 1024×1024
///   World  — full world at 2048×2048
///
/// Render-preview is called with appropriate radius/resolution; the resulting
/// PNG is decoded, downsampled to the tile's target size, and re-encoded as
/// JPEG at the configured quality. SkiaSharp throughout — no GPU.
/// </summary>
public class TileGenerator {
    public const int LbTilePixels = TileCache.LbTilePixels;          // 512
    public const int RegionTilePixels = 1024;
    public const int WorldTilePixels = 2048;
    public const int JpegQuality = TileCache.JpegQuality;            // 85

    private readonly CommandEngine _engine;
    private readonly TileCache _cache;
    // region name → (centerLbX, centerLbY, radius). Computed once from the
    // region gazetteer's anchor points; the radius is the maximum distance
    // from center to any member town's LB position.
    private Dictionary<string, (uint centerX, uint centerY, int radius, List<(uint x, uint y)> anchors)>? _regionBoxes;

    public TileGenerator(CommandEngine engine, TileCache cache) {
        _engine = engine;
        _cache = cache;
    }

    // ── LB tile ────────────────────────────────────────────────

    public byte[] GenerateLbTile(uint lbX, uint lbY) {
        // Ask render-preview for a single-LB image at 1024px (the renderer's
        // native good size); we'll downsample to 512 for the tile.
        var result = _engine.RenderPreview(lbX, lbY, radius: 0, resolution: 1024, overlay: true, outputPath: null);
        return ReencodeAsJpeg(result.PngBytes, LbTilePixels, JpegQuality);
    }

    public string StoreLbTile(ushort lbKey, byte[] jpegBytes) {
        var hex = lbKey.ToString("X4");
        var path = $"lb/{hex}.jpg";
        _cache.Store($"lb/{hex}", path, jpegBytes);
        return path;
    }

    public TileEntry GetOrGenerateLbTile(uint lbX, uint lbY) {
        ushort lbKey = CommandEngine.LbKey(lbX, lbY);
        var hex = lbKey.ToString("X4");
        var key = $"lb/{hex}";
        var existing = _cache.Lookup(key);
        if (existing != null) {
            _cache.Touch(key);
            return existing;
        }
        var bytes = GenerateLbTile(lbX, lbY);
        StoreLbTile(lbKey, bytes);
        // Also clear the dirty flag for this LB now that it's regenerated.
        // (The dirty SET still tracks it for the dirty-tiles query — that's
        // explicitly cleared by mark-tiles-clean once the operator confirms.)
        return _cache.Lookup(key) ?? throw new InvalidOperationException("Tile vanished after store");
    }

    // ── Region tile ────────────────────────────────────────────

    public byte[] GenerateRegionTile(string regionName) {
        EnsureRegionBoxesLoaded();
        if (_regionBoxes == null || !_regionBoxes.TryGetValue(regionName, out var box))
            throw new ArgumentException($"Region '{regionName}' not found in gazetteer");
        // Add 2-LB padding so the region's edges aren't clipped. render-preview
        // caps radius at 16 (33×33 LBs); larger regions get rendered at the cap
        // and their off-canvas edges trim out — fine for atlas overview tiles.
        int radius = Math.Min(16, box.radius + 2);
        var result = _engine.RenderPreview(box.centerX, box.centerY, radius: radius,
            resolution: 2048, overlay: true, outputPath: null);
        return ReencodeAsJpeg(result.PngBytes, RegionTilePixels, JpegQuality);
    }

    public string StoreRegionTile(string regionName, byte[] jpegBytes) {
        var safe = SafeName(regionName);
        var path = $"region/{safe}.jpg";
        _cache.Store($"region/{safe}", path, jpegBytes);
        return path;
    }

    public TileEntry GetOrGenerateRegionTile(string regionName) {
        var safe = SafeName(regionName);
        var key = $"region/{safe}";
        var existing = _cache.Lookup(key);
        if (existing != null) {
            _cache.Touch(key);
            return existing;
        }
        var bytes = GenerateRegionTile(regionName);
        StoreRegionTile(regionName, bytes);
        return _cache.Lookup(key) ?? throw new InvalidOperationException("Region tile vanished after store");
    }

    // ── World tile ─────────────────────────────────────────────

    public byte[] GenerateWorldTile() {
        // render-preview caps radius at 16 (33×33 LBs), so we can't render the full
        // 255×255 world in one shot. Composite from per-region tiles instead: each
        // region tile is already a downsampled LB-cluster; we paint them onto a
        // 2048×2048 canvas at positions corresponding to their world-space centers.
        EnsureRegionBoxesLoaded();
        if (_regionBoxes == null || _regionBoxes.Count == 0)
            throw new InvalidOperationException("No regions available to composite world tile");

        const int worldLbSpan = 255;
        const float pxPerLb = (float)WorldTilePixels / worldLbSpan;

        var info = new SKImageInfo(WorldTilePixels, WorldTilePixels, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var canvas_ = new SKBitmap(info);
        using (var canvas = new SKCanvas(canvas_)) {
            canvas.Clear(SKColors.Black);
            foreach (var (regionName, box) in _regionBoxes) {
                byte[] regionPng;
                try { regionPng = GenerateRegionTile(regionName); }
                catch { continue; } // skip regions that fail to render
                using var srcImage = SKImage.FromEncodedData(regionPng);
                if (srcImage == null) continue;
                // Region tile covers (centerX±radius, centerY±radius) in LB space.
                int radius = Math.Min(16, box.radius + 2);
                float cxPx = (box.centerX + 0.5f) * pxPerLb;
                float cyPx = (box.centerY + 0.5f) * pxPerLb;
                float halfPx = (radius * 2 + 1) * pxPerLb / 2;
                var dest = new SKRect(cxPx - halfPx, cyPx - halfPx, cxPx + halfPx, cyPx + halfPx);
                canvas.DrawImage(srcImage, dest);
            }
        }
        using var image = SKImage.FromBitmap(canvas_);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, JpegQuality);
        return data.ToArray();
    }

    public TileEntry GetOrGenerateWorldTile() {
        var key = "world";
        var existing = _cache.Lookup(key);
        if (existing != null) {
            _cache.Touch(key);
            return existing;
        }
        var bytes = GenerateWorldTile();
        _cache.Store("world", "world.jpg", bytes);
        return _cache.Lookup("world") ?? throw new InvalidOperationException("World tile vanished after store");
    }

    // ── Bulk ───────────────────────────────────────────────────

    /// <summary>
    /// Regenerate every dirty LB tile. Returns count regenerated and total bytes.
    /// </summary>
    public (int regenerated, long bytesWritten, List<string> errors) RegenerateDirty() {
        int n = 0;
        long bytes = 0;
        var errors = new List<string>();
        foreach (var (lbKey, hex) in _cache.ListDirty()) {
            try {
                uint lbX = (uint)((lbKey >> 8) & 0xFF);
                uint lbY = (uint)(lbKey & 0xFF);
                var bytes_ = GenerateLbTile(lbX, lbY);
                StoreLbTile(lbKey, bytes_);
                n++;
                bytes += bytes_.Length;
            } catch (Exception ex) {
                errors.Add($"0x{hex}: {ex.Message}");
            }
        }
        _cache.ClearDirty();
        _cache.SaveManifest();
        return (n, bytes, errors);
    }

    /// <summary>Eagerly generate every populated LB tile (the full pyramid).
    /// Caller can supply a list of LBs to limit scope; if null, walks every
    /// landblock in the world the engine has data for.</summary>
    public (int generated, int skipped, long bytesWritten, List<string> errors)
            GenerateBulkLbTiles(IEnumerable<(uint x, uint y)> lbs) {
        int generated = 0, skipped = 0;
        long bytes = 0;
        var errors = new List<string>();
        foreach (var (x, y) in lbs) {
            try {
                ushort lbKey = CommandEngine.LbKey(x, y);
                var hex = lbKey.ToString("X4");
                var key = $"lb/{hex}";
                if (_cache.Lookup(key) != null) { skipped++; continue; }
                var pngBytes = GenerateLbTile(x, y);
                StoreLbTile(lbKey, pngBytes);
                generated++;
                bytes += pngBytes.Length;
            } catch (Exception ex) {
                errors.Add($"({x},{y}): {ex.Message}");
            }
        }
        _cache.SaveManifest();
        return (generated, skipped, bytes, errors);
    }

    // ── Region box derivation ──────────────────────────────────

    /// <summary>
    /// Loads region anchor points from the gazetteer (passed by CommandEngine)
    /// and computes per-region bounding boxes.
    /// </summary>
    public void SetRegionAnchors(Dictionary<string, List<(uint x, uint y)>> regionAnchors) {
        _regionBoxes = new();
        foreach (var (region, anchors) in regionAnchors) {
            if (anchors.Count == 0) continue;
            uint xMin = anchors.Min(a => a.x), xMax = anchors.Max(a => a.x);
            uint yMin = anchors.Min(a => a.y), yMax = anchors.Max(a => a.y);
            uint cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
            int radius = (int)Math.Max(xMax - xMin, yMax - yMin) / 2;
            _regionBoxes[region] = (cx, cy, radius, anchors);
        }
    }

    private void EnsureRegionBoxesLoaded() {
        // Caller should have called SetRegionAnchors during init; if not, this
        // throws on access.
        if (_regionBoxes == null)
            throw new InvalidOperationException("Region anchors not loaded — call SetRegionAnchors first");
    }

    public IReadOnlyDictionary<string, (uint centerX, uint centerY, int radius, List<(uint x, uint y)> anchors)> RegionBoxes
        => (IReadOnlyDictionary<string, (uint, uint, int, List<(uint, uint)>)>?)_regionBoxes
           ?? new Dictionary<string, (uint, uint, int, List<(uint, uint)>)>();

    // ── Image plumbing ─────────────────────────────────────────

    private static byte[] ReencodeAsJpeg(byte[] pngBytes, int targetSize, int quality) {
        using var inputImage = SKImage.FromEncodedData(pngBytes)
            ?? throw new InvalidOperationException("Failed to decode source PNG");
        using var srcBitmap = SKBitmap.FromImage(inputImage);
        // Resize using "Medium" filter — good speed/quality tradeoff for terrain
        // tiles. High would be a touch sharper but ~3× slower with no perceptible
        // gain at these sizes.
        var info = new SKImageInfo(targetSize, targetSize, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var resized = srcBitmap.Resize(info, SKFilterQuality.Medium)
            ?? throw new InvalidOperationException("Resize failed");
        using var image = SKImage.FromBitmap(resized);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, quality);
        return data.ToArray();
    }

    private static string SafeName(string s) {
        var clean = new System.Text.StringBuilder(s.Length);
        foreach (var c in s) clean.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
        return clean.ToString();
    }
}
