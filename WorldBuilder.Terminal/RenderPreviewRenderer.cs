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
public static class RenderPreviewRenderer {

    /// <summary>
    /// One sprite-atlas region for an object: where the sprite lives in the
    /// shared atlas bitmap (atlasRect), and the sprite's true world bounds
    /// (worldWidth × worldHeight) so the renderer can scale it to its
    /// actual world footprint at the current zoom.
    /// </summary>
    public sealed record SpriteInfo(SKBitmap Atlas, int X, int Y, int W, int H, float WorldWidth, float WorldHeight);

    /// <summary>
    /// Server-spawn glyph: a position in absolute world coords plus a
    /// category string and the source weenie class id. <c>Wcid</c> is
    /// looked up via <see cref="Input.WcidToSetup"/> at render time and,
    /// when a sprite is present in the atlas for the resolved setupId,
    /// the renderer draws the sprite instead of the category glyph.
    /// Wcid==0 means "no resolution available, use glyph" — matches the
    /// pre-resolve behaviour for backward compatibility.
    /// </summary>
    public readonly record struct SpawnGlyph(float X, float Y, string Category, string Scale, int Wcid);

    /// <summary>
    /// Which compositional layers the renderer should produce. Floor-mode
    /// in the frontend hides Objects and Sprites while keeping Terrain
    /// visible, so they need to live in separate tile bitmaps.
    /// </summary>
    public enum LayerMode {
        Combined,    // current behavior: terrain + roads + objects all in one bitmap
        Terrain,     // terrain raster + roads only; no objects (transparent where no terrain)
        Objects,     // object glyphs/sprites only; transparent everywhere else
    }

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

        // ── Sprite mode (Phase 2 + onward) ─────────────────────────────
        // When true, replace per-object glyph dispatch with sprite lookups.
        // Each object draws as (worldBounds × pxPerWorldUnit) pixels at its
        // world position, scaled to its true footprint regardless of zoom.
        // Below 4 px per object world-largest-dim, falls back to glyph so
        // far-zoomed renders stay readable.
        public bool UseSprites = false;
        public Func<uint, SpriteInfo?>? Sprites;

        // Compositional layer to emit. Drives whether the terrain raster
        // pass and/or the object glyph pass run, and whether the canvas
        // clears to transparent (Objects mode) or to the dark background.
        public LayerMode Layer = LayerMode.Combined;

        // Optional spawn-gazetteer glyphs, keyed by (col, row) like Objects
        // so the lookup respects radius-windowed renders. Each entry's
        // (X, Y) is in absolute world units and its Category drives glyph
        // selection through the same palette as static objects. Spawns
        // are drawn alongside StaticObjects in Phase 3.
        public Dictionary<(int col, int row), List<SpawnGlyph>>? Spawns;

        /// <summary>
        /// Optional wcid → setupId resolver. When non-null, the spawn-glyph
        /// path tries to look up a sprite via <c>Sprites(WcidToSetup(wcid))</c>
        /// and only falls back to the category glyph if no sprite exists or
        /// the wcid doesn't resolve. Built once per render at the
        /// CommandEngine level from the ontology's WeenieClassId index.
        /// </summary>
        public Func<int, uint>? WcidToSetup;

        // Optional AC terrain texture loader. When non-null the per-pixel
        // raster pass samples real DAT tiles for each terrain type instead
        // of the procedural palette. Falls back to the palette per-type
        // when the loader has no entry for a given byte.
        public TerrainTextureLoader? TerrainTextures;

        // Tile period (world units per texture-repeat) used when sampling
        // the AC terrain tiles. AC's outdoor cell size is 24wu; the in-game
        // tiles repeat once per cell, so 24f matches the client's look.
        public float TerrainTileWu = 24f;
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

    // Object glyph colors per ontology category. Lookups are
    // case-insensitive; the resolver below also handles family prefix
    // matching (Furniture_*, Scenery_*, NPC*, Interactive_*, Sign_*).
    private static readonly Dictionary<string, SKColor> CategoryFill = new(StringComparer.OrdinalIgnoreCase) {
        ["Structure"]         = new SKColor(0x4A, 0x3A, 0x2A),
        ["Furniture"]         = new SKColor(0x8B, 0x6F, 0x4A),
        ["Furniture_Storage"] = new SKColor(0x8B, 0x6F, 0x4A),
        ["Furniture_Light"]   = new SKColor(0xE8, 0xC4, 0x6A),  // lamps stand out
        ["Furniture_Table"]   = new SKColor(0x8B, 0x6F, 0x4A),
        ["Scenery"]           = new SKColor(0x2D, 0x5A, 0x2D),
        ["Scenery_Water"]     = new SKColor(0x3E, 0x6A, 0x9F),  // water glyphs read as blue
        ["Prop"]              = new SKColor(0xC2, 0xA3, 0x68),
        ["Creature"]          = new SKColor(0xC0, 0x39, 0x2B),
        ["NPC"]               = new SKColor(0xE2, 0xC8, 0x4F),  // humanoid yellow, distinct from Creature red
        ["NPC_Archmage"]      = new SKColor(0xB6, 0x7F, 0xD8),  // a recognizable purple for casters
        ["Interactive_Portal"] = new SKColor(0x6E, 0xC8, 0xE0),
        ["Interactive_Switch"] = new SKColor(0x6E, 0xC8, 0xE0),
        ["Interactive_Door"]   = new SKColor(0x6E, 0xC8, 0xE0),
        ["Sign_Town"]         = new SKColor(0xE0, 0x9A, 0x3F),
    };
    // Family-level fallbacks for any new subcategory (Furniture_Foo,
    // NPC_Bar) that lands in the ontology before the renderer is updated.
    // Inheriting the family glyph keeps signal on the page rather than
    // silently dropping it to an X.
    private static readonly SKColor NpcFill         = new(0xE2, 0xC8, 0x4F);
    private static readonly SKColor InteractiveFill = new(0x6E, 0xC8, 0xE0);
    private static readonly SKColor SignFill        = new(0xE0, 0x9A, 0x3F);
    private static readonly SKColor WaterFill       = new(0x3E, 0x6A, 0x9F);
    private static readonly SKColor UnknownFill = new(0x77, 0x77, 0x77);
    private static readonly SKColor GlyphOutline = new(0x10, 0x10, 0x10, 0xC0);
    private static readonly SKColor CliffStroke  = new(0xE0, 0x35, 0x35, 0xD8);

    /// <summary>
    /// Resolve a category string to (shape kind, fill color). Prefix matching
    /// means that any future subcategory under a known family (Furniture_*,
    /// Scenery_*, NPC*, Interactive_*, Sign_*) inherits its family's glyph
    /// instead of falling through to the unknown-X — addresses the
    /// "regression-resistant" objective: degrade plausibly when the ontology
    /// gains a new category before the renderer is updated.
    /// </summary>
    private static (GlyphShape shape, SKColor fill) ResolveGlyph(string category) {
        if (string.IsNullOrEmpty(category)) return (GlyphShape.Unknown, UnknownFill);

        if (string.Equals(category, "Structure", StringComparison.OrdinalIgnoreCase))
            return (GlyphShape.Structure, CategoryFill["Structure"]);

        if (category.StartsWith("Furniture", StringComparison.OrdinalIgnoreCase)) {
            var fill = CategoryFill.TryGetValue(category, out var c) ? c : CategoryFill["Furniture"];
            return (GlyphShape.Furniture, fill);
        }
        if (category.StartsWith("Scenery", StringComparison.OrdinalIgnoreCase)) {
            var fill = CategoryFill.TryGetValue(category, out var c) ? c
                : (category.StartsWith("Scenery_Water", StringComparison.OrdinalIgnoreCase) ? WaterFill : CategoryFill["Scenery"]);
            return (GlyphShape.Scenery, fill);
        }
        if (category.StartsWith("NPC", StringComparison.OrdinalIgnoreCase)) {
            var fill = CategoryFill.TryGetValue(category, out var c) ? c : NpcFill;
            return (GlyphShape.Npc, fill);
        }
        if (string.Equals(category, "Creature", StringComparison.OrdinalIgnoreCase))
            return (GlyphShape.Creature, CategoryFill["Creature"]);
        if (category.StartsWith("Interactive", StringComparison.OrdinalIgnoreCase)) {
            var fill = CategoryFill.TryGetValue(category, out var c) ? c : InteractiveFill;
            return (GlyphShape.Interactive, fill);
        }
        if (category.StartsWith("Sign", StringComparison.OrdinalIgnoreCase)) {
            var fill = CategoryFill.TryGetValue(category, out var c) ? c : SignFill;
            return (GlyphShape.Sign, fill);
        }
        if (string.Equals(category, "Prop", StringComparison.OrdinalIgnoreCase))
            return (GlyphShape.Prop, CategoryFill["Prop"]);

        return (GlyphShape.Unknown, UnknownFill);
    }

    internal enum GlyphShape {
        Unknown,
        Structure,    // filled brown square — buildings
        Furniture,    // smaller filled square
        Scenery,      // upright filled triangle (tree-like)
        Creature,     // filled diamond, brick red
        Npc,          // filled diamond, yellow/violet — humanoid
        Prop,         // filled circle
        Interactive,  // hollow ring with a center dot — portals/switches/doors
        Sign,         // small upward triangle with stem — orientation marker
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helpers shared with TransactDiffEngine. The diff overlay reuses the
    //  same shape dispatch and per-scale sizing as the main render path so
    //  a red "removed" glyph is the same shape and size the live render
    //  would have drawn for that object — agents read shape as identity.
    //  Keeping these as the only entry points means we don't introduce a
    //  second glyph table that could drift from the primary one.
    // ─────────────────────────────────────────────────────────────────────

    internal static GlyphShape ResolveShapeForObject(OntologyEntry? entry) {
        string category = entry?.Category ?? "Unknown";
        if (entry?.Tags is { Length: > 0 } tags) {
            foreach (var t in tags) {
                if (string.Equals(t, "dat:building", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(t, "dat:building_inherited", StringComparison.OrdinalIgnoreCase)) {
                    category = "Structure";
                    break;
                }
            }
        }
        var (shape, _) = ResolveGlyph(category);
        return shape;
    }

    internal static float ResolveSizePxForObject(OntologyEntry? entry, int lbPx) {
        string scale = entry?.Scale ?? "Small";
        float scaleFactor = MathF.Sqrt(Math.Max(64, lbPx) / 256f);
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
        return sizePx;
    }

    internal static void DrawObjectGlyphInColor(SKCanvas canvas, float pxX, float pxY,
            float sizePx, GlyphShape shape, SKColor fill) {
        using var fillPaint = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Fill, Color = fill };
        using var outlinePaint = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = 1f, Color = GlyphOutline };
        DrawGlyph(canvas, pxX, pxY, sizePx, shape, fillPaint, outlinePaint);
    }

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

        // Layer split: Objects-only mode skips the per-pixel terrain raster
        // entirely and starts from a fully transparent canvas so the tile
        // composites cleanly over a separate terrain tile in the frontend.
        bool drawTerrain = input.Layer != LayerMode.Objects;
        bool drawObjects = input.Layer != LayerMode.Terrain;

        // Lambert hillshade with light from north-west, ~45Â° elevation.
        // World convention: +X east, +Y north. light_dir = normalize(âˆ’1, +1, +1).
        var lightDir = Vector3.Normalize(new Vector3(-1f, 1f, 1f));

        // World extent (terrain side). Used to convert pixel→world for AC
        // terrain texture sampling. Mirrors the object-phase math so the
        // tile period (24wu) repeats at the same density as the client.
        float terrWorldOriginX = (float)((long)input.CenterLbX - input.Radius) * 192f;
        float terrWorldOriginY = (float)((long)input.CenterLbY - input.Radius) * 192f;
        float terrWorldSpanX = gridSize * 192f;
        float terrWorldSpanY = gridSize * 192f;
        float tileWu = input.TerrainTileWu > 0.5f ? input.TerrainTileWu : 24f;
        bool useTerrainTextures = input.TerrainTextures != null;

        if (drawTerrain) {
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

                bool d00 = hasData[i00], d10 = hasData[i10], d01 = hasData[i01], d11 = hasData[i11];
                if (!d00 && !d10 && !d01 && !d11) {
                    pixelBuffer[outIdx + 0] = BackgroundColor.R;
                    pixelBuffer[outIdx + 1] = BackgroundColor.G;
                    pixelBuffer[outIdx + 2] = BackgroundColor.B;
                    pixelBuffer[outIdx + 3] = 0xFF;
                    continue;
                }

                // Bilinear weights, zeroed for no-data corners and renormalized
                // over the valid set. Without this, missing vertices contribute
                // their default values (types=0 → BarrenRock, heights=0) into
                // the blend, producing a brown/dark halo at every populated /
                // unpopulated LB seam (world-edge renders, partial regions).
                float w00 = d00 ? (1 - fu) * (1 - fv) : 0f;
                float w10 = d10 ? fu * (1 - fv) : 0f;
                float w01 = d01 ? (1 - fu) * fv : 0f;
                float w11 = d11 ? fu * fv : 0f;
                float wsum = w00 + w10 + w01 + w11;
                if (wsum < 1e-6f) {
                    // Pixel sits exactly on a corner whose vertex has no data
                    // but at least one diagonal does. Equal-weight the valid
                    // corners so we don't divide by zero or fall to background.
                    int validCount = (d00 ? 1 : 0) + (d10 ? 1 : 0) + (d01 ? 1 : 0) + (d11 ? 1 : 0);
                    float eq = 1f / validCount;
                    w00 = d00 ? eq : 0f;
                    w10 = d10 ? eq : 0f;
                    w01 = d01 ? eq : 0f;
                    w11 = d11 ? eq : 0f;
                } else {
                    float inv = 1f / wsum;
                    w00 *= inv; w10 *= inv; w01 *= inv; w11 *= inv;
                }

                // Bilinear-interp height with renormalized weights.
                float h = heights[i00] * w00 + heights[i10] * w10
                        + heights[i01] * w01 + heights[i11] * w11;

                // 4-corner sample. With AC terrain textures available, sample
                // each corner's tile at the world-position (mod tileWu) and
                // blend; without textures, fall back to the procedural
                // palette. The blend remains the same so the visual result
                // smoothly degrades when a particular tile fails to decode.
                float worldX = terrWorldOriginX + worldXFrac * terrWorldSpanX;
                float worldY = terrWorldOriginY + worldYFrac * terrWorldSpanY;
                (byte R, byte G, byte B) c00, c10, c01, c11;
                if (useTerrainTextures) {
                    c00 = SampleTerrainAt(input.TerrainTextures!, types[i00], worldX, worldY, tileWu);
                    c10 = SampleTerrainAt(input.TerrainTextures!, types[i10], worldX, worldY, tileWu);
                    c01 = SampleTerrainAt(input.TerrainTextures!, types[i01], worldX, worldY, tileWu);
                    c11 = SampleTerrainAt(input.TerrainTextures!, types[i11], worldX, worldY, tileWu);
                } else {
                    c00 = types[i00] < TerrainPalette.Length ? TerrainPalette[types[i00]] : BackgroundColor;
                    c10 = types[i10] < TerrainPalette.Length ? TerrainPalette[types[i10]] : BackgroundColor;
                    c01 = types[i01] < TerrainPalette.Length ? TerrainPalette[types[i01]] : BackgroundColor;
                    c11 = types[i11] < TerrainPalette.Length ? TerrainPalette[types[i11]] : BackgroundColor;
                }
                var tc = (
                    R: (byte)(c00.R * w00 + c10.R * w10 + c01.R * w01 + c11.R * w11),
                    G: (byte)(c00.G * w00 + c10.G * w10 + c01.G * w01 + c11.G * w11),
                    B: (byte)(c00.B * w00 + c10.B * w10 + c01.B * w01 + c11.B * w11)
                );

                // Slope from finite differences (1 cell = 24 world units).
                // Skip neighbors that lack data — sampling them treats the
                // missing vertex as height 0, producing a fake cliff at every
                // loaded / unloaded LB boundary that drives shade to floor.
                int iuL = (iu - 1 >= 0 && hasData[(iu - 1) + iv * VW]) ? iu - 1 : iu;
                int iuR = (iu + 1 < VW && hasData[(iu + 1) + iv * VW]) ? iu + 1 : iu;
                int ivD = (iv - 1 >= 0 && hasData[iu + (iv - 1) * VW]) ? iv - 1 : iv;
                int ivU = (iv + 1 < VH && hasData[iu + (iv + 1) * VW]) ? iv + 1 : iv;
                float dxDen = (iuR - iuL) * 24f;
                float dyDen = (ivU - ivD) * 24f;
                float dx = dxDen > 0f ? (heights[iuR + iv * VW] - heights[iuL + iv * VW]) / dxDen : 0f;
                float dy = dyDen > 0f ? (heights[iu  + ivU * VW] - heights[iu  + ivD * VW]) / dyDen : 0f;

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
        }   // end if (drawTerrain)

        using var canvas = new SKCanvas(bitmap);

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 2: roads â€” connect adjacent road=1 vertices. Terrain-only.
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        if (drawTerrain) {
        // When AC terrain textures are loaded, paint the road stroke with
        // the road-dirt tile (TerrainTextureType.RoadType = 32) as a
        // repeating shader instead of the flat skia-yellow line. Falls
        // back to the flat colour when the texture isn't available.
        SKShader? roadShader = null;
        SKBitmap? roadShaderBmp = null;
        if (input.TerrainTextures != null
            && input.TerrainTextures.TryGetTile(32, out var roadTile) && roadTile != null) {
            var rsInfo = new SKImageInfo(roadTile.Width, roadTile.Height,
                SKColorType.Rgba8888, SKAlphaType.Unpremul);
            roadShaderBmp = new SKBitmap(rsInfo);
            System.Runtime.InteropServices.Marshal.Copy(
                roadTile.Rgba, 0, roadShaderBmp.GetPixels(), roadTile.Rgba.Length);
            roadShader = SKShader.CreateBitmap(roadShaderBmp,
                SKShaderTileMode.Repeat, SKShaderTileMode.Repeat);
        }
        using var roadPaint = new SKPaint {
            Color = roadShader != null ? SKColors.White
                : new SKColor(RoadColor.R, RoadColor.G, RoadColor.B, 0xE6),
            Shader = roadShader,
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
        roadShader?.Dispose();
        roadShaderBmp?.Dispose();

        }   // end if (drawTerrain) — phase 2 roads

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 3: object glyphs (category â†’ shape, scale â†’ size). Objects-side.
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        if (drawObjects) {
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

        // Build a flat list of glyphs so we can z-order them deterministically.
        // Drawing in raw foreach order let later glyphs paint on top of earlier
        // ones; if scenery happened to follow a building in the document's
        // object list, the tree triangle covered the brown house square. The
        // priority key here pushes Structure last (= drawn on top) so buildings
        // are never visually occluded by adjacent scenery.
        float pxPerWorldUnit = input.LbPx / 192f;
        var glyphs = new List<(float pxX, float pxY, float sizePx, GlyphShape shape, SKColor fill, uint pairingRoot, uint objId, SpriteInfo? sprite, Quaternion orientation)>();
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

                // Defense-in-depth promotion: the ontology cache may classify
                // a building as Scenery / Prop / Unknown when the unified
                // enrichment hasn't run on this project (or didn't see this
                // ID). Tags carry an authoritative `dat:building` /
                // `dat:building_inherited` flag from the unified-ontology
                // analysis; trust it over the heuristic Category. This was
                // the failure mode that hid Holtburg's eleven Aluvian houses
                // — all flagged dat:building but cached as Scenery.
                if (entry?.Tags is { Length: > 0 } tags) {
                    foreach (var t in tags) {
                        if (string.Equals(t, "dat:building", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(t, "dat:building_inherited", StringComparison.OrdinalIgnoreCase)) {
                            category = "Structure";
                            break;
                        }
                    }
                }

                var (shape, fill) = ResolveGlyph(category);

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

                uint root = input.PairingsGroupKey != null ? input.PairingsGroupKey(obj.Id) : 0u;
                SpriteInfo? sprite = (input.UseSprites && input.Sprites != null) ? input.Sprites(obj.Id) : null;
                glyphs.Add((pxX, pxY, sizePx, shape, fill, root, obj.Id, sprite, obj.Orientation));
            }
        }

        // Spawn glyphs (NPCs/creatures/quest items/scenery from the spawn
        // gazetteer). When the wcid resolves to a setupId that's in the
        // sprite atlas, the dispatcher below picks up the SpriteInfo and
        // draws the textured sprite — otherwise it falls back to the
        // category glyph. Per-vertex screenshots from the user showed
        // many spawned objects (apple trees, totems, stones) being drawn
        // as squares/circles where they should be top-down sprites; this
        // hooks them into the same sprite path placed objects use.
        if (input.Spawns != null) {
            foreach (var kv in input.Spawns) {
                foreach (var sp in kv.Value) {
                    float wx = sp.X - worldOriginX;
                    float wy = sp.Y - worldOriginY;
                    if (wx < 0 || wy < 0 || wx > worldSpanX || wy > worldSpanY) continue;
                    float fx = wx / worldSpanX;
                    float fy = wy / worldSpanY;
                    float pxX = fx * W;
                    float pxY = (1f - fy) * H;
                    var (shape, fill) = ResolveGlyph(sp.Category);
                    float sizePx = sp.Scale switch {
                        "Massive" => 12f,
                        "Large"   =>  9f,
                        "Medium"  =>  6f,
                        "Small"   =>  4f,
                        "Tiny"    =>  2.5f,
                        _         =>  3f,
                    } * scaleFactor;
                    if (sizePx < 1.5f) sizePx = 1.5f;
                    if (sizePx > 18f)  sizePx = 18f;
                    SpriteInfo? sprite = null;
                    if (sp.Wcid > 0 && input.WcidToSetup != null
                            && input.UseSprites && input.Sprites != null) {
                        uint setupId = input.WcidToSetup(sp.Wcid);
                        if (setupId != 0) sprite = input.Sprites(setupId);
                    }
                    glyphs.Add((pxX, pxY, sizePx, shape, fill, 0u, 0u, sprite, Quaternion.Identity));
                }
            }
        }

        // Z-priority by shape family. Smaller key paints first (= underneath).
        // Structure goes on top so buildings never disappear under a tree;
        // NPCs and Creatures float above static placement so the LLM critic
        // can spot encounter groups against the scenery.
        static int ShapeZ(GlyphShape s) => s switch {
            GlyphShape.Scenery     => 0,
            GlyphShape.Prop        => 1,
            GlyphShape.Furniture   => 2,
            GlyphShape.Sign        => 2,
            GlyphShape.Interactive => 3,
            GlyphShape.Unknown     => 3,
            GlyphShape.Creature    => 4,
            GlyphShape.Npc         => 4,
            GlyphShape.Structure   => 5,
            _                      => 3,
        };
        glyphs.Sort((a, b) => ShapeZ(a.shape).CompareTo(ShapeZ(b.shape)));

        foreach (var g in glyphs) {
            // Sprite mode: if the object has a sprite registered AND it would
            // render at ≥ 4px on its largest world dim, blit the atlas region
            // scaled to true world bounds. Otherwise fall back to glyph so
            // far-zoomed renders stay readable.
            if (g.sprite != null) {
                float wPx = g.sprite.WorldWidth * pxPerWorldUnit;
                float hPx = g.sprite.WorldHeight * pxPerWorldUnit;
                if (MathF.Max(wPx, hPx) >= 4f) {
                    var dest = new SKRect(g.pxX - wPx * 0.5f, g.pxY - hPx * 0.5f,
                                          g.pxX + wPx * 0.5f, g.pxY + hPx * 0.5f);
                    var src = new SKRect(g.sprite.X, g.sprite.Y,
                                         g.sprite.X + g.sprite.W, g.sprite.Y + g.sprite.H);
                    float yawDeg = QuaternionYawDegrees(g.orientation);
                    canvas.Save();
                    canvas.RotateDegrees(-yawDeg, g.pxX, g.pxY);
                    canvas.DrawBitmap(g.sprite.Atlas, src, dest);
                    canvas.Restore();
                    if (g.pairingRoot != 0 && g.pairingRoot != g.objId) {
                        ringPaint.Color = HueRingColor(g.pairingRoot);
                        canvas.DrawCircle(g.pxX, g.pxY, MathF.Max(wPx, hPx) * 0.5f + 2.5f, ringPaint);
                    }
                    continue;
                }
            }
            fillPaint.Color = g.fill;
            DrawGlyph(canvas, g.pxX, g.pxY, g.sizePx, g.shape, fillPaint, outlinePaint);
            if (g.pairingRoot != 0 && g.pairingRoot != g.objId) {
                ringPaint.Color = HueRingColor(g.pairingRoot);
                canvas.DrawCircle(g.pxX, g.pxY, g.sizePx + 2.5f, ringPaint);
            }
        }
        output.RenderedObjectCount = glyphs.Count;
        }   // end if (drawObjects) — phase 3 glyphs

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        //  Phase 4: cliff overlay (only when overlay enabled, terrain layer).
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        if (input.Overlay && drawTerrain) {
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

    private static (byte R, byte G, byte B) SampleTerrainAt(TerrainTextureLoader textures,
            byte typeByte, float worldX, float worldY, float tileWu) {
        if (textures.TryGetTile(typeByte, out var tile) && tile != null) {
            // Tile UV in [0, 1) — wrap by world tile period; some terrain
            // types fall back to palette, so the lookup miss isn't fatal.
            float uw = worldX / tileWu; uw -= MathF.Floor(uw);
            float vw = worldY / tileWu; vw -= MathF.Floor(vw);
            int tx = Math.Clamp((int)(uw * tile.Width), 0, tile.Width - 1);
            int ty = Math.Clamp((int)((1f - vw) * tile.Height), 0, tile.Height - 1);
            int idx = (tx + ty * tile.Width) * 4;
            return (tile.Rgba[idx], tile.Rgba[idx + 1], tile.Rgba[idx + 2]);
        }
        if (typeByte < TerrainPalette.Length) return TerrainPalette[typeByte];
        return BackgroundColor;
    }

    private static SKPoint VertexToPixel(int vu, int vv, int VW, int VH, int W, int H) {
        float fx = vu / (float)(VW - 1);
        float fy = vv / (float)(VH - 1);
        return new SKPoint(fx * W, (1f - fy) * H);
    }

    private static void DrawGlyph(SKCanvas canvas, float cx, float cy, float size,
                                  GlyphShape shape, SKPaint fill, SKPaint outline) {
        switch (shape) {
            case GlyphShape.Structure:
                canvas.DrawRect(cx - size, cy - size, size * 2, size * 2, fill);
                canvas.DrawRect(cx - size, cy - size, size * 2, size * 2, outline);
                return;

            case GlyphShape.Furniture: {
                float s = size * 0.85f;
                canvas.DrawRect(cx - s, cy - s, s * 2, s * 2, fill);
                if (s >= 3f) canvas.DrawRect(cx - s, cy - s, s * 2, s * 2, outline);
                return;
            }

            case GlyphShape.Scenery: {
                using var path = new SKPath();
                path.MoveTo(cx, cy - size);
                path.LineTo(cx - size, cy + size * 0.7f);
                path.LineTo(cx + size, cy + size * 0.7f);
                path.Close();
                canvas.DrawPath(path, fill);
                if (size >= 3f) canvas.DrawPath(path, outline);
                return;
            }

            case GlyphShape.Creature:
            case GlyphShape.Npc: {
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

            case GlyphShape.Prop:
                canvas.DrawCircle(cx, cy, size * 0.85f, fill);
                if (size >= 3f) canvas.DrawCircle(cx, cy, size * 0.85f, outline);
                return;

            case GlyphShape.Interactive: {
                // Hollow ring with a filled centre dot — reads as a "thing
                // you can interact with" without competing visually with the
                // solid shapes used for static world objects.
                using var ringStroke = new SKPaint {
                    Style = SKPaintStyle.Stroke,
                    StrokeWidth = Math.Max(1f, size * 0.35f),
                    IsAntialias = true,
                    Color = fill.Color,
                };
                canvas.DrawCircle(cx, cy, size, ringStroke);
                canvas.DrawCircle(cx, cy, Math.Max(1f, size * 0.32f), fill);
                return;
            }

            case GlyphShape.Sign: {
                // Upward triangle with a short stem — orientation marker,
                // distinct from Scenery's symmetric tree triangle.
                using var path = new SKPath();
                path.MoveTo(cx,            cy - size);
                path.LineTo(cx - size * 0.75f, cy);
                path.LineTo(cx + size * 0.75f, cy);
                path.Close();
                canvas.DrawPath(path, fill);
                if (size >= 3f) canvas.DrawPath(path, outline);
                using var stem = new SKPaint {
                    Style = SKPaintStyle.Stroke,
                    StrokeWidth = Math.Max(1f, size * 0.25f),
                    IsAntialias = true,
                    Color = fill.Color,
                };
                canvas.DrawLine(cx, cy, cx, cy + size * 0.7f, stem);
                return;
            }

            case GlyphShape.Unknown:
            default:
                using (var paint = new SKPaint {
                    IsAntialias = true,
                    Style = SKPaintStyle.Stroke,
                    StrokeWidth = Math.Max(1f, size * 0.4f),
                    Color = UnknownFill,
                }) {
                    canvas.DrawLine(cx - size, cy - size, cx + size, cy + size, paint);
                    canvas.DrawLine(cx - size, cy + size, cx + size, cy - size, paint);
                }
                return;
        }
    }

    private static SKColor HueRingColor(uint key) {
        // Stable hue per pairing root. Saturation/value chosen to read on
        // both light and dark terrain.
        uint h = key * 2654435761u;
        float hue = (h % 360u);
        return SKColor.FromHsv(hue, 80f, 95f).WithAlpha(0xC8);
    }

    private static float QuaternionYawDegrees(Quaternion q) {
        // Yaw about +Z. AC's quaternion uses Z up.
        float siny_cosp = 2f * (q.W * q.Z + q.X * q.Y);
        float cosy_cosp = 1f - 2f * (q.Y * q.Y + q.Z * q.Z);
        return MathF.Atan2(siny_cosp, cosy_cosp) * 180f / MathF.PI;
    }
}
