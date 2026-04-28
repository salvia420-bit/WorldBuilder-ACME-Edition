using System.Numerics;
using SkiaSharp;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Top-down PNG renderer for a region of landblocks. Pure function over
/// terrain grids + objects + ontology + pairings; produces base64-friendly bytes.
///
/// Coordinate convention: world +X is east (right), world +Y is north (up).
/// Pixel space follows screen +Y down, so the renderer flips Y when sampling.
/// Each landblock is 192Ã—192 world units = 8Ã—8 cells = 9Ã—9 vertices on a 24-unit grid.
/// </summary>
internal static class RenderPreviewRenderer {
    public sealed class Input {
        public uint CenterLbX;
        public uint CenterLbY;
        public int Radius;
        public int GridSize;          // 2*Radius + 1
        public int LbPx;              // pixels per landblock side
        public int FinalRes;          // LbPx * GridSize
        public bool Overlay;
        public required Dictionary<(int col, int row), TerrainEntry[]?> Terrain;
        public required Dictionary<(int col, int row), List<StaticObject>> Objects;
        public required float[] HeightTable;     // 256 entries, byte â†’ world Z
        public Func<uint, OntologyEntry?>? Ontology;
        public Func<uint, uint>? PairingsGroupKey;
        public float CliffThreshold = 12f;
    }

    public sealed class Output {
        public byte[] PngBytes = Array.Empty<byte>();
        public int CliffCount;
        public int RenderedObjectCount;
    }

    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    //  Terrain palette â€” one RGB per TerrainTextureType (0â€“32). RoadType=32 is
    //  applied separately via the per-vertex Road bit, not the terrainType byte.
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

    private static readonly (byte R, byte G, byte B)[] TerrainPalette = {
        ( 0x6B, 0x6B, 0x65 ),  //  0 BarrenRock
        ( 0x5E, 0x8D, 0x4A ),  //  1 Grassland
        ( 0xB8, 0xD8, 0xE8 ),  //  2 Ice
        ( 0x4A, 0x7D, 0x3A ),  //  3 LushGrass
        ( 0x5D, 0x6B, 0x3F ),  //  4 MarshSparseSwamp
        ( 0x5D, 0x46, 0x32 ),  //  5 MudRichDirt
        ( 0x2A, 0x2A, 0x2A ),  //  6 ObsidianPlain
        ( 0x8A, 0x6D, 0x4A ),  //  7 PackedDirt
        ( 0x7A, 0x62, 0x48 ),  //  8 PatchyDirt
        ( 0x6E, 0x89, 0x57 ),  //  9 PatchyGrassland
        ( 0xD8, 0xC2, 0x72 ),  // 10 SandYellow
        ( 0xB8, 0xB2, 0x98 ),  // 11 SandGrey
        ( 0xA0, 0x95, 0x76 ),  // 12 SandRockStrewn
        ( 0x7A, 0x68, 0x50 ),  // 13 SedimentaryRock
        ( 0x80, 0x7A, 0x6E ),  // 14 SemiBarrenRock
        ( 0xF0, 0xF0, 0xF0 ),  // 15 Snow
        ( 0x2D, 0x6F, 0x8C ),  // 16 WaterRunning
        ( 0x3A, 0x7A, 0x9C ),  // 17 WaterStandingFresh
        ( 0x40, 0x82, 0xA8 ),  // 18 WaterShallowSea
        ( 0x48, 0x82, 0xA8 ),  // 19 WaterShallowStillSea
        ( 0x1E, 0x4A, 0x6E ),  // 20 WaterDeepSea
        ( 0x3D, 0x5A, 0x3D ),  // 21 ForestFloor
        ( 0x2D, 0x6F, 0x8C ),  // 22 FauxWaterRunning
        ( 0x4D, 0x60, 0x48 ),  // 23 SeaSlime
        ( 0x82, 0x62, 0x45 ),  // 24 Argila
        ( 0x8A, 0x3B, 0x2A ),  // 25 Volcano1
        ( 0x73, 0x2E, 0x1F ),  // 26 Volcano2
        ( 0x9C, 0xC8, 0xD8 ),  // 27 BlueIce
        ( 0x5A, 0x70, 0x45 ),  // 28 Moss
        ( 0x48, 0x5A, 0x35 ),  // 29 DarkMoss
        ( 0x6D, 0x3A, 0x4A ),  // 30 Olthoi
        ( 0x5A, 0x4A, 0x40 ),  // 31 DesolateLands
        ( 0xA5, 0x90, 0x70 ),  // 32 RoadType (rarely set on the type byte itself)
    };

    private static readonly (byte R, byte G, byte B) BackgroundColor = ( 0x12, 0x12, 0x14 );
    private static readonly (byte R, byte G, byte B) RoadColor       = ( 0xC4, 0xA8, 0x78 );

    // Object glyph colors per ontology category.
    private static readonly Dictionary<string, SKColor> CategoryFill = new(StringComparer.OrdinalIgnoreCase) {
        ["Structure"]         = new SKColor(0x4A, 0x3A, 0x2A),
        ["Furniture"]         = new SKColor(0x8B, 0x6F, 0x4A),
        ["Furniture_Storage"] = new SKColor(0x8B, 0x6F, 0x4A),
        ["Furniture_Light"]   = new SKColor(0xE8, 0xC4, 0x6A),  // lamps stand out
        ["Scenery"]           = new SKColor(0x2D, 0x5A, 0x2D),
        ["Prop"]              = new SKColor(0xC2, 0xA3, 0x68),
        ["Creature"]          = new SKColor(0xC0, 0x39, 0x2B),
    };
    private static readonly SKColor UnknownFill = new(0x77, 0x77, 0x77);
    private static readonly SKColor GlyphOutline = new(0x10, 0x10, 0x10, 0xC0);
    private static readonly SKColor CliffStroke  = new(0xE0, 0x35, 0x35, 0xD8);

    public static Output Render(Input input) {
        var output = new Output();

        int W = input.FinalRes;
        int H = input.FinalRes;

        // Build a unified vertex grid spanning the whole region. Edges between
        // adjacent landblocks share a vertex line, so we tile each LB's 9Ã—9
        // grid with a 1-vertex overlap at the seams (overwrite is fine because
        // adjacent LBs store identical seam values).
        int gridSize = input.GridSize;
        int VW = gridSize * 8 + 1;        // virtual vertex grid width
        int VH = gridSize * 8 + 1;        // virtual vertex grid height
        var heights  = new float[VW * VH];
        var types    = new byte[VW * VH];
        var roads    = new byte[VW * VH];
        var hasData  = new bool[VW * VH];

        for (int row = 0; row < gridSize; row++) {
            for (int col = 0; col < gridSize; col++) {
                if (!input.Terrain.TryGetValue((col, row), out var lbData) || lbData == null)
                    continue;

                for (int gy = 0; gy < 9; gy++) {
                    for (int gx = 0; gx < 9; gx++) {
                        int vu = col * 8 + gx;
                        int vv = row * 8 + gy;
                        int idx = vu + vv * VW;
                        var e = lbData[gx * 9 + gy];
                        heights[idx] = e.Height < input.HeightTable.Length
                            ? input.HeightTable[e.Height]
                            : e.Height * 2f;
                        types[idx] = e.Type;
                        roads[idx] = e.Road;
                        hasData[idx] = true;
                    }
                }
            }
        }

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 1: per-pixel raster (terrain color + hillshade).
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        var info = new SKImageInfo(W, H, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bitmap = new SKBitmap(info);

        // Lambert hillshade with light from north-west, ~45Â° elevation.
        // World convention: +X east, +Y north. light_dir = normalize(âˆ’1, +1, +1).
        var lightDir = Vector3.Normalize(new Vector3(-1f, 1f, 1f));

        var pixelBuffer = new byte[W * H * 4];
        for (int py = 0; py < H; py++) {
            // Flip Y so that world +Y (north) is at the top of the image.
            float worldYFrac = (H - 1 - py) / (float)H;
            float vv = worldYFrac * (VH - 1);
            int iv = (int)vv;
            if (iv >= VH - 1) iv = VH - 2;
            if (iv < 0) iv = 0;
            float fv = vv - iv;

            for (int px = 0; px < W; px++) {
                float worldXFrac = px / (float)W;
                float vu = worldXFrac * (VW - 1);
                int iu = (int)vu;
                if (iu >= VW - 1) iu = VW - 2;
                if (iu < 0) iu = 0;
                float fu = vu - iu;

                int i00 = iu     + iv     * VW;
                int i10 = iu + 1 + iv     * VW;
                int i01 = iu     + (iv+1) * VW;
                int i11 = iu + 1 + (iv+1) * VW;

                int outIdx = (px + py * W) * 4;

                if (!hasData[i00] && !hasData[i10] && !hasData[i01] && !hasData[i11]) {
                    pixelBuffer[outIdx + 0] = BackgroundColor.R;
                    pixelBuffer[outIdx + 1] = BackgroundColor.G;
                    pixelBuffer[outIdx + 2] = BackgroundColor.B;
                    pixelBuffer[outIdx + 3] = 0xFF;
                    continue;
                }

                // Bilinear-interp height.
                float h00 = heights[i00], h10 = heights[i10], h01 = heights[i01], h11 = heights[i11];
                float h0 = h00 + (h10 - h00) * fu;
                float h1 = h01 + (h11 - h01) * fu;
                float h  = h0  + (h1  - h0 ) * fv;

                // Bilinear blend of the 4 corner terrain colors. AC's outdoor
                // terrain uses per-corner texture blending, so this is closer
                // to in-game appearance than nearest-neighbor.
                var c00 = types[i00] < TerrainPalette.Length ? TerrainPalette[types[i00]] : BackgroundColor;
                var c10 = types[i10] < TerrainPalette.Length ? TerrainPalette[types[i10]] : BackgroundColor;
                var c01 = types[i01] < TerrainPalette.Length ? TerrainPalette[types[i01]] : BackgroundColor;
                var c11 = types[i11] < TerrainPalette.Length ? TerrainPalette[types[i11]] : BackgroundColor;
                float w00 = (1 - fu) * (1 - fv);
                float w10 = fu * (1 - fv);
                float w01 = (1 - fu) * fv;
                float w11 = fu * fv;
                var tc = (
                    R: (byte)(c00.R * w00 + c10.R * w10 + c01.R * w01 + c11.R * w11),
                    G: (byte)(c00.G * w00 + c10.G * w10 + c01.G * w01 + c11.G * w11),
                    B: (byte)(c00.B * w00 + c10.B * w10 + c01.B * w01 + c11.B * w11)
                );

                // Slope from finite differences (1 cell = 24 world units).
                int iuL = Math.Max(0, iu - 1), iuR = Math.Min(VW - 1, iu + 1);
                int ivD = Math.Max(0, iv - 1), ivU = Math.Min(VH - 1, iv + 1);
                float dx = (heights[iuR + iv * VW] - heights[iuL + iv * VW]) / ((iuR - iuL) * 24f + 1e-6f);
                float dy = (heights[iu  + ivU * VW] - heights[iu  + ivD * VW]) / ((ivU - ivD) * 24f + 1e-6f);

                var n = Vector3.Normalize(new Vector3(-dx, -dy, 1f));
                float dot = Vector3.Dot(n, lightDir);
                if (dot < 0f) dot = 0f;
                float shade = 0.55f + 0.55f * dot;     // floor 0.55, peak ~1.10

                int r = (int)(tc.R * shade); if (r > 255) r = 255;
                int g = (int)(tc.G * shade); if (g > 255) g = 255;
                int b = (int)(tc.B * shade); if (b > 255) b = 255;

                pixelBuffer[outIdx + 0] = (byte)r;
                pixelBuffer[outIdx + 1] = (byte)g;
                pixelBuffer[outIdx + 2] = (byte)b;
                pixelBuffer[outIdx + 3] = 0xFF;
            }
        }
        System.Runtime.InteropServices.Marshal.Copy(pixelBuffer, 0, bitmap.GetPixels(), pixelBuffer.Length);

        using var canvas = new SKCanvas(bitmap);

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 2: roads â€” connect adjacent road=1 vertices.
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        using var roadPaint = new SKPaint {
            Color = new SKColor(RoadColor.R, RoadColor.G, RoadColor.B, 0xE6),
            StrokeWidth = Math.Max(1.5f, input.LbPx / 90f),
            IsAntialias = true,
            Style = SKPaintStyle.Stroke,
            StrokeCap = SKStrokeCap.Round,
        };

        // Emit each undirected edge exactly once by walking from every vertex
        // to its E, N, NE, and NW neighbors only. Cardinal-only emission (the
        // prior version) silently dropped any road whose road=1 vertices ran
        // along a diagonal — the LLM critic then saw an empty corridor where a
        // road should have been. Slight cost: at L-corners with three road=1
        // vertices the hypotenuse also renders, thickening the bend; this is
        // acceptable schematic noise in exchange for not dropping signal.
        // Direction offsets: (du, dv).
        ReadOnlySpan<(int du, int dv)> roadDirs =
            stackalloc (int, int)[] { (1, 0), (0, 1), (1, 1), (-1, 1) };

        for (int vv = 0; vv < VH; vv++) {
            for (int vu = 0; vu < VW; vu++) {
                int idx = vu + vv * VW;
                if (!hasData[idx] || roads[idx] == 0) continue;

                foreach (var (du, dv) in roadDirs) {
                    int nu = vu + du, nv = vv + dv;
                    if (nu < 0 || nu >= VW || nv < 0 || nv >= VH) continue;
                    int nIdx = nu + nv * VW;
                    if (!hasData[nIdx] || roads[nIdx] == 0) continue;
                    canvas.DrawLine(
                        VertexToPixel(vu, vv, VW, VH, W, H),
                        VertexToPixel(nu, nv, VW, VH, W, H),
                        roadPaint);
                }
            }
        }

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 3: object glyphs (category â†’ shape, scale â†’ size).
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        using var fillPaint    = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Fill };
        using var outlinePaint = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(0.5f, input.LbPx / 220f), Color = GlyphOutline };
        using var ringPaint    = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(0.7f, input.LbPx / 160f) };

        // Glyph base sizes (in pixels) at LbPx = 256, scaled gently by sqrt(LbPx/256).
        float scaleFactor = MathF.Sqrt(Math.Max(64, input.LbPx) / 256f);

        // World extent of the rendered region in world units.
        float worldOriginX = (float)((long)input.CenterLbX - input.Radius) * 192f;
        float worldOriginY = (float)((long)input.CenterLbY - input.Radius) * 192f;
        float worldSpanX   = gridSize * 192f;
        float worldSpanY   = gridSize * 192f;

        int rendered = 0;
        foreach (var kv in input.Objects) {
            foreach (var obj in kv.Value) {
                float wx = obj.Origin.X - worldOriginX;
                float wy = obj.Origin.Y - worldOriginY;
                if (wx < 0 || wy < 0 || wx > worldSpanX || wy > worldSpanY) continue;

                float fx = wx / worldSpanX;
                float fy = wy / worldSpanY;
                float pxX = fx * W;
                float pxY = (1f - fy) * H;     // flip Y for screen

                var entry = input.Ontology?.Invoke(obj.Id);
                string category = entry?.Category ?? "Unknown";
                string scale    = entry?.Scale    ?? "Small";
                fillPaint.Color = CategoryFill.TryGetValue(category, out var c) ? c : UnknownFill;

                float sizePx = scale switch {
                    "Massive" => 12f,
                    "Large"   =>  9f,
                    "Medium"  =>  6f,
                    "Small"   =>  4f,
                    "Tiny"    =>  2.5f,
                    _         =>  3f,
                } * scaleFactor;
                if (sizePx < 1.5f) sizePx = 1.5f;
                if (sizePx > 18f)  sizePx = 18f;

                DrawGlyph(canvas, pxX, pxY, sizePx, category, fillPaint, outlinePaint);

                if (input.PairingsGroupKey != null) {
                    uint root = input.PairingsGroupKey(obj.Id);
                    if (root != 0 && root != obj.Id) {
                        ringPaint.Color = HueRingColor(root);
                        canvas.DrawCircle(pxX, pxY, sizePx + 2.5f, ringPaint);
                    }
                }
                rendered++;
            }
        }
        output.RenderedObjectCount = rendered;

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 4: cliff overlay (only when overlay enabled).
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        if (input.Overlay) {
            using var cliffPaint = new SKPaint {
                Color = CliffStroke,
                IsAntialias = true,
                Style = SKPaintStyle.Stroke,
                StrokeWidth = Math.Max(1.2f, input.LbPx / 110f),
                StrokeCap = SKStrokeCap.Round,
                PathEffect = SKPathEffect.CreateDash(new[] {
                    Math.Max(2f, input.LbPx / 80f),
                    Math.Max(2f, input.LbPx / 120f) }, 0f),
            };

            // Same 4-direction emission as roads (E, N, NE, NW) so cliff
            // edges that run diagonally — escarpments, river-cut ridgelines,
            // tower-building footprints — aren't dropped. The L-corner
            // hypotenuse artifact applies here too but matters less for
            // cliffs since the dashed style already reads as schematic.
            ReadOnlySpan<(int du, int dv)> cliffDirs =
                stackalloc (int, int)[] { (1, 0), (0, 1), (1, 1), (-1, 1) };

            int cliffCount = 0;
            for (int vv = 0; vv < VH; vv++) {
                for (int vu = 0; vu < VW; vu++) {
                    int idx = vu + vv * VW;
                    if (!hasData[idx]) continue;
                    foreach (var (du, dv) in cliffDirs) {
                        int nu = vu + du, nv = vv + dv;
                        if (nu < 0 || nu >= VW || nv < 0 || nv >= VH) continue;
                        int nIdx = nu + nv * VW;
                        if (!hasData[nIdx]) continue;
                        if (Math.Abs(heights[nIdx] - heights[idx]) > input.CliffThreshold) {
                            canvas.DrawLine(
                                VertexToPixel(vu, vv, VW, VH, W, H),
                                VertexToPixel(nu, nv, VW, VH, W, H),
                                cliffPaint);
                            cliffCount++;
                        }
                    }
                }
            }
            output.CliffCount = cliffCount;

            // Subtle landblock grid lines on multi-LB renders so the eye can
            // align objects to LB boundaries.
            if (gridSize > 1) {
                using var gridPaint = new SKPaint {
                    Color = new SKColor(0xFF, 0xFF, 0xFF, 0x18),
                    IsAntialias = false,
                    Style = SKPaintStyle.Stroke,
                    StrokeWidth = 1f,
                };
                for (int i = 1; i < gridSize; i++) {
                    float x = i * input.LbPx;
                    canvas.DrawLine(x, 0, x, H, gridPaint);
                    float y = i * input.LbPx;
                    canvas.DrawLine(0, y, W, y, gridPaint);
                }
            }
        }

        // Encode.
        using var img = SKImage.FromBitmap(bitmap);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        output.PngBytes = data.ToArray();
        return output;
    }

    private static SKPoint VertexToPixel(int vu, int vv, int VW, int VH, int W, int H) {
        float fx = vu / (float)(VW - 1);
        float fy = vv / (float)(VH - 1);
        return new SKPoint(fx * W, (1f - fy) * H);
    }

    private static void DrawGlyph(SKCanvas canvas, float cx, float cy, float size,
                                  string category, SKPaint fill, SKPaint outline) {
        // Case-insensitive dispatch: the CategoryFill table uses
        // OrdinalIgnoreCase, so a non-canonical-cased category from the
        // ontology would pick up the right *color* and then fall through to
        // the unknown-X glyph here, silently dropping signal — the same
        // failure mode that masked misclassified buildings before the
        // ontology was unified. Mirror the comparer used for the fill.
        if (string.Equals(category, "Structure", StringComparison.OrdinalIgnoreCase)) {
            canvas.DrawRect(cx - size, cy - size, size * 2, size * 2, fill);
            canvas.DrawRect(cx - size, cy - size, size * 2, size * 2, outline);
            return;
        }
        if (string.Equals(category, "Furniture", StringComparison.OrdinalIgnoreCase)
            || string.Equals(category, "Furniture_Storage", StringComparison.OrdinalIgnoreCase)
            || string.Equals(category, "Furniture_Light", StringComparison.OrdinalIgnoreCase)) {
            float s = size * 0.85f;
            canvas.DrawRect(cx - s, cy - s, s * 2, s * 2, fill);
            if (s >= 3f) canvas.DrawRect(cx - s, cy - s, s * 2, s * 2, outline);
            return;
        }
        if (string.Equals(category, "Scenery", StringComparison.OrdinalIgnoreCase)) {
            using var path = new SKPath();
            path.MoveTo(cx, cy - size);
            path.LineTo(cx - size, cy + size * 0.7f);
            path.LineTo(cx + size, cy + size * 0.7f);
            path.Close();
            canvas.DrawPath(path, fill);
            if (size >= 3f) canvas.DrawPath(path, outline);
            return;
        }
        if (string.Equals(category, "Creature", StringComparison.OrdinalIgnoreCase)) {
            using var path = new SKPath();
            path.MoveTo(cx,        cy - size);
            path.LineTo(cx + size, cy);
            path.LineTo(cx,        cy + size);
            path.LineTo(cx - size, cy);
            path.Close();
            canvas.DrawPath(path, fill);
            if (size >= 3f) canvas.DrawPath(path, outline);
            return;
        }
        if (string.Equals(category, "Prop", StringComparison.OrdinalIgnoreCase)) {
            canvas.DrawCircle(cx, cy, size * 0.85f, fill);
            if (size >= 3f) canvas.DrawCircle(cx, cy, size * 0.85f, outline);
            return;
        }
        using (var paint = new SKPaint {
            IsAntialias = true,
            Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(1f, size * 0.4f),
            Color = UnknownFill,
        }) {
            canvas.DrawLine(cx - size, cy - size, cx + size, cy + size, paint);
            canvas.DrawLine(cx - size, cy + size, cx + size, cy - size, paint);
        }
    }

    private static SKColor HueRingColor(uint key) {
        // Stable hue per pairing root. Saturation/value chosen to read on
        // both light and dark terrain.
        uint h = key * 2654435761u;
        float hue = (h % 360u);
        return SKColor.FromHsv(hue, 80f, 95f).WithAlpha(0xC8);
    }
}
