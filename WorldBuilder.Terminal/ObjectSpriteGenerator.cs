using System.Numerics;
using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using SkiaSharp;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Generates top-down PNG sprites for placed model ids, packs them into a
/// shared atlas, and writes a manifest describing each sprite's atlas region
/// and true world footprint.
///
/// Pixel ratio is uniform per object (largest world XY dim → spritePx), so
/// every model is rendered at the same world-units-per-pixel resolution.
/// Frontend reads the world bounds and scales accordingly when compositing.
/// </summary>
internal static class ObjectSpriteGenerator {

    // Why: matches RenderPreviewRenderer's hillshade convention so sprites
    // composited onto terrain tiles read as lit from the same direction.
    // Azimuth 135° (north-west), elevation 60°.
    private static readonly Vector3 SunDirection = ComputeSunDirection(azimuthDeg: 135f, elevationDeg: 60f);

    private const float ShadowOffsetPx = 4f;
    private const float ShadowAlpha = 0.40f;

    public static (int Rendered, int Failed, int AtlasWidth, int AtlasHeight) Run(
            IReadOnlyCollection<uint> modelIds, int spritePx, string spritesDir,
            string atlasPath, string manifestPath,
            IDatReaderWriter dats, Func<uint, OntologyEntry?> ontology) {
        Directory.CreateDirectory(spritesDir);
        var entries = new List<SpriteEntry>(modelIds.Count);

        int nullEmptyTris = 0, nullDegenerate = 0, nullNoVisible = 0, threwException = 0;
        string? firstError = null;
        foreach (var id in modelIds) {
            try {
                var (rendered, reason) = RenderOneWithReason(id, spritePx, dats, ontology);
                if (rendered == null) {
                    switch (reason) {
                        case NullReason.NoTriangles: nullEmptyTris++; break;
                        case NullReason.Degenerate: nullDegenerate++; break;
                        case NullReason.NoVisible: nullNoVisible++; break;
                    }
                    continue;
                }
                using (var data = rendered.Bitmap.Encode(SKEncodedImageFormat.Png, 100)) {
                    File.WriteAllBytes(Path.Combine(spritesDir, $"0x{id:X8}.png"), data.ToArray());
                }
                entries.Add(rendered);
            } catch (Exception ex) {
                threwException++;
                if (firstError == null) {
                    var stack = ex.StackTrace?.Split('\n').FirstOrDefault()?.Trim() ?? "";
                    firstError = $"0x{id:X8}: {ex.GetType().Name}: {ex.Message} @ {stack}";
                }
            }
        }
        if (entries.Count == 0 || nullEmptyTris + nullDegenerate + nullNoVisible + threwException > 0) {
            Console.Error.WriteLine($"[Sprites] rendered={entries.Count} " +
                $"noTris={nullEmptyTris} degenerate={nullDegenerate} " +
                $"noVisibleFace={nullNoVisible} threw={threwException}" +
                (firstError != null ? $" firstError={firstError}" : ""));
        }

        var (atlas, layout) = PackAtlas(entries);
        using (var data = atlas.Encode(SKEncodedImageFormat.Png, 100)) {
            File.WriteAllBytes(atlasPath, data.ToArray());
        }
        using (var sw = new StreamWriter(manifestPath, append: false)) {
            for (int i = 0; i < entries.Count; i++) {
                var e = entries[i];
                var rect = layout[i];
                sw.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {
                    modelId = $"0x{e.ModelId:X8}",
                    x = rect.X, y = rect.Y, w = rect.W, h = rect.H,
                    worldBounds = new[] {
                        Math.Round(e.WorldWidth, 4), Math.Round(e.WorldHeight, 4),
                    },
                }));
            }
        }
        int aw = atlas.Width, ah = atlas.Height;
        atlas.Dispose();
        foreach (var e in entries) e.Bitmap.Dispose();
        return (entries.Count, modelIds.Count - entries.Count, aw, ah);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Per-model render
    // ────────────────────────────────────────────────────────────────────

    private enum NullReason { NoTriangles, Degenerate, NoVisible }

    private static (SpriteEntry? Entry, NullReason Reason) RenderOneWithReason(
            uint modelId, int spritePx, IDatReaderWriter dats, Func<uint, OntologyEntry?> ontology) {
        var triangles = TriangulateModel(modelId, dats);
        if (triangles.Count == 0) return (null, NullReason.NoTriangles);

        // World XY bounds across all triangles.
        float minX = float.MaxValue, maxX = float.MinValue;
        float minY = float.MaxValue, maxY = float.MinValue;
        foreach (var tri in triangles) {
            for (int v = 0; v < 3; v++) {
                var p = tri.Pos[v];
                if (p.X < minX) minX = p.X;
                if (p.X > maxX) maxX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.Y > maxY) maxY = p.Y;
            }
        }
        float worldW = maxX - minX, worldH = maxY - minY;
        if (worldW <= 1e-3f || worldH <= 1e-3f) return (null, NullReason.Degenerate);

        float pxPerUnit = spritePx / Math.Max(worldW, worldH);
        int W = Math.Max(1, (int)MathF.Ceiling(worldW * pxPerUnit));
        int H = Math.Max(1, (int)MathF.Ceiling(worldH * pxPerUnit));

        // Top-facing triangles only (back-face cull). Sort by centroid Z so
        // higher (closer-to-viewer) triangles render last.
        var visible = new List<Tri>(triangles.Count);
        foreach (var tri in triangles) {
            if (tri.Normal.Z <= 0f) continue;
            visible.Add(tri);
        }
        if (visible.Count == 0) return (null, NullReason.NoVisible);
        visible.Sort((a, b) => a.CentroidZ.CompareTo(b.CentroidZ));

        // Per-surface texture cache, scoped to this model. Failure → null →
        // we render that surface's triangles as flat fill via category color.
        var fallbackFill = ResolveFallbackFill(ontology(modelId));
        var textures = new Dictionary<uint, SKBitmap?>();

        var info = new SKImageInfo(W, H, SKColorType.Rgba8888, SKAlphaType.Premul);
        var bmp = new SKBitmap(info);
        using (var canvas = new SKCanvas(bmp)) {
            canvas.Clear(SKColors.Transparent);
            DrawDropShadow(canvas, visible, minX, maxY, pxPerUnit, W, H);
            foreach (var tri in visible) {
                DrawTriangle(canvas, tri, minX, maxY, pxPerUnit,
                    dats, textures, fallbackFill);
            }
        }
        foreach (var t in textures.Values) t?.Dispose();

        var entry = new SpriteEntry {
            ModelId = modelId,
            Bitmap = bmp,
            WorldWidth = worldW,
            WorldHeight = worldH,
        };
        return (entry, NullReason.NoTriangles); // unused when entry != null
    }

    private static void DrawDropShadow(SKCanvas canvas, List<Tri> tris,
            float originX, float originYTop, float pxPerUnit, int W, int H) {
        // Why: a soft alpha-blurred silhouette under the sprite is what makes
        // it pop against the terrain. Render once, blur once, composite.
        using var silhouettePaint = new SKPaint {
            Style = SKPaintStyle.Fill,
            Color = new SKColor(0, 0, 0, (byte)(255f * ShadowAlpha)),
            IsAntialias = true,
            ImageFilter = SKImageFilter.CreateBlur(2f, 2f),
        };
        using var path = new SKPath { FillType = SKPathFillType.Winding };
        foreach (var tri in tris) {
            var p0 = WorldToPx(tri.Pos[0], originX, originYTop, pxPerUnit);
            var p1 = WorldToPx(tri.Pos[1], originX, originYTop, pxPerUnit);
            var p2 = WorldToPx(tri.Pos[2], originX, originYTop, pxPerUnit);
            path.MoveTo(p0.X + ShadowOffsetPx, p0.Y + ShadowOffsetPx);
            path.LineTo(p1.X + ShadowOffsetPx, p1.Y + ShadowOffsetPx);
            path.LineTo(p2.X + ShadowOffsetPx, p2.Y + ShadowOffsetPx);
            path.Close();
        }
        canvas.DrawPath(path, silhouettePaint);
    }

    private static void DrawTriangle(SKCanvas canvas, Tri tri,
            float originX, float originYTop, float pxPerUnit,
            IDatReaderWriter dats, Dictionary<uint, SKBitmap?> textures, SKColor fallback) {
        var p0 = WorldToPx(tri.Pos[0], originX, originYTop, pxPerUnit);
        var p1 = WorldToPx(tri.Pos[1], originX, originYTop, pxPerUnit);
        var p2 = WorldToPx(tri.Pos[2], originX, originYTop, pxPerUnit);

        // Per-vertex Lambert shade × sun direction. Floor 0.55 mirrors the
        // RenderPreviewRenderer hillshade convention.
        float dot = Math.Max(0f, Vector3.Dot(tri.Normal, SunDirection));
        float shade = 0.55f + 0.55f * dot;
        if (shade > 1f) shade = 1f;
        byte sb = (byte)(255f * shade);
        var shadeColor = new SKColor(sb, sb, sb, 255);
        var shadeColors = new[] { shadeColor, shadeColor, shadeColor };

        var positions = new[] { p0, p1, p2 };

        SKBitmap? tex = null;
        if (tri.SurfaceDid != 0) {
            if (!textures.TryGetValue(tri.SurfaceDid, out tex)) {
                tex = TryLoadSurface(dats, tri.SurfaceDid);
                textures[tri.SurfaceDid] = tex;
            }
        }

        using var paint = new SKPaint {
            IsAntialias = true,
            Style = SKPaintStyle.Fill,
        };
        if (tex != null) {
            // Map UV [0,1] to texel coords. SkiaSharp DrawVertices feeds the
            // texs straight into the shader; we pre-scale instead of using a
            // local matrix so the call site stays format-agnostic.
            var texs = new[] {
                new SKPoint(tri.Uv[0].X * tex.Width, tri.Uv[0].Y * tex.Height),
                new SKPoint(tri.Uv[1].X * tex.Width, tri.Uv[1].Y * tex.Height),
                new SKPoint(tri.Uv[2].X * tex.Width, tri.Uv[2].Y * tex.Height),
            };
            paint.Shader = SKShader.CreateBitmap(tex, SKShaderTileMode.Repeat, SKShaderTileMode.Repeat);
            using var verts = SKVertices.CreateCopy(SKVertexMode.Triangles, positions, texs, shadeColors);
            canvas.DrawVertices(verts, SKBlendMode.Modulate, paint);
        } else {
            paint.Color = ShadeColor(fallback, shade);
            using var path = new SKPath { FillType = SKPathFillType.Winding };
            path.MoveTo(p0); path.LineTo(p1); path.LineTo(p2); path.Close();
            canvas.DrawPath(path, paint);
        }
    }

    private static SKPoint WorldToPx(Vector3 p, float originX, float originYTop, float pxPerUnit) {
        // World +Y is north (up). Screen +Y is down. Flip Y around the top edge.
        float pxX = (p.X - originX) * pxPerUnit;
        float pxY = (originYTop - p.Y) * pxPerUnit;
        return new SKPoint(pxX, pxY);
    }

    private static SKColor ShadeColor(SKColor c, float shade) {
        float r = Math.Min(255f, c.Red * shade);
        float g = Math.Min(255f, c.Green * shade);
        float b = Math.Min(255f, c.Blue * shade);
        return new SKColor((byte)r, (byte)g, (byte)b, c.Alpha);
    }

    private static SKColor ResolveFallbackFill(OntologyEntry? entry) {
        // Reuse RenderPreviewRenderer's category palette via the public glyph
        // resolver path. Tiny indirection: we don't expose ResolveGlyph as
        // public, but the family-level fills are constants there. Match the
        // most common categories directly to avoid leaking that internal API.
        string cat = entry?.Category ?? "Unknown";
        return cat switch {
            "Structure" => new SKColor(0x6E, 0x57, 0x40),
            var s when s.StartsWith("Furniture") => new SKColor(0x8B, 0x6F, 0x4A),
            var s when s.StartsWith("Scenery_Water") => new SKColor(0x3E, 0x6A, 0x9F),
            var s when s.StartsWith("Scenery") => new SKColor(0x2D, 0x5A, 0x2D),
            var s when s.StartsWith("NPC") => new SKColor(0xE2, 0xC8, 0x4F),
            "Creature" => new SKColor(0xC0, 0x39, 0x2B),
            "Prop" => new SKColor(0xC2, 0xA3, 0x68),
            var s when s.StartsWith("Interactive") => new SKColor(0x6E, 0xC8, 0xE0),
            var s when s.StartsWith("Sign") => new SKColor(0xE0, 0x9A, 0x3F),
            _ => new SKColor(0x77, 0x77, 0x77),
        };
    }

    // ────────────────────────────────────────────────────────────────────
    //  Geometry: GfxObj / Setup → triangle list with UVs and normals
    // ────────────────────────────────────────────────────────────────────

    private struct Tri {
        public Vector3[] Pos;        // length 3
        public Vector2[] Uv;         // length 3, per-corner
        public Vector3 Normal;       // unit
        public float CentroidZ;      // for z-order
        public uint SurfaceDid;      // 0 if no surface
    }

    private static List<Tri> TriangulateModel(uint modelId, IDatReaderWriter dats) {
        var tris = new List<Tri>();
        uint kind = modelId >> 24;
        if (kind == 0x02) {
            if (!SafeTryGet<Setup>(dats, modelId, out var setup)) return tris;
            var placement = GetDefaultPlacementFrame(setup);
            for (int pi = 0; pi < setup.Parts.Count; pi++) {
                if (!SafeTryGet<GfxObj>(dats, setup.Parts[pi], out var gfx)) continue;
                Vector3 partOffset = Vector3.Zero;
                Quaternion partRot = Quaternion.Identity;
                if (placement?.Frames != null && pi < placement.Frames.Count) {
                    partOffset = placement.Frames[pi].Origin;
                    partRot = placement.Frames[pi].Orientation;
                }
                try { AppendGfxTris(tris, gfx, partOffset, partRot); }
                catch { /* skip malformed part, keep rest of Setup */ }
            }
        } else if (kind == 0x01) {
            if (!SafeTryGet<GfxObj>(dats, modelId, out var gfx)) return tris;
            try { AppendGfxTris(tris, gfx, Vector3.Zero, Quaternion.Identity); }
            catch { /* skip — leave tris empty so caller marks failure */ }
        }
        return tris;
    }

    // Why: DatReaderWriter's TryGet doesn't catch malformed-record IO errors
    // (ArgumentOutOfRangeException from DatBinReader on truncated data).
    // Sprite generation must degrade gracefully — one bad record cannot
    // abort an entire model batch.
    private static bool SafeTryGet<T>(IDatReaderWriter dats, uint id, out T value)
            where T : class, DatReaderWriter.Lib.IO.IDBObj, new() {
        try {
            return dats.TryGet<T>(id, out value!);
        } catch {
            value = null!;
            return false;
        }
    }

    private static AnimationFrame? GetDefaultPlacementFrame(Setup setup) {
        if (setup.PlacementFrames.TryGetValue(Placement.Resting, out var resting)) return resting;
        if (setup.PlacementFrames.TryGetValue(Placement.Default, out var def)) return def;
        foreach (var kv in setup.PlacementFrames) return kv.Value;
        return null;
    }

    private static void AppendGfxTris(List<Tri> tris, GfxObj gfx,
            Vector3 partOffset, Quaternion partRot) {
        if (gfx?.VertexArray?.Vertices == null || gfx.Polygons == null) return;
        foreach (var poly in gfx.Polygons.Values) {
            if (poly.VertexIds.Count < 3) continue;
            if (poly.Stippling == StipplingType.NoPos) continue;
            uint surfaceDid = 0;
            if (poly.PosSurface >= 0 && poly.PosSurface < gfx.Surfaces.Count)
                surfaceDid = gfx.Surfaces[poly.PosSurface];

            // Fan-triangulate.
            var ringPos = new List<Vector3>(poly.VertexIds.Count);
            var ringUv = new List<Vector2>(poly.VertexIds.Count);
            for (int i = 0; i < poly.VertexIds.Count; i++) {
                short raw = poly.VertexIds[i];
                if (raw < 0) { ringPos.Clear(); break; }
                if (!gfx.VertexArray.Vertices.TryGetValue((ushort)raw, out var vert)) {
                    ringPos.Clear(); break;
                }
                ushort uvIdx = 0;
                if (poly.PosUVIndices != null && i < poly.PosUVIndices.Count)
                    uvIdx = poly.PosUVIndices[i];
                if (uvIdx >= vert.UVs.Count) uvIdx = 0;
                var uv = vert.UVs.Count > 0
                    ? new Vector2(vert.UVs[uvIdx].U, vert.UVs[uvIdx].V)
                    : Vector2.Zero;
                var pos = Vector3.Transform(vert.Origin, partRot) + partOffset;
                ringPos.Add(pos);
                ringUv.Add(uv);
            }
            if (ringPos.Count < 3) continue;

            for (int i = 2; i < ringPos.Count; i++) {
                var a = ringPos[0]; var b = ringPos[i - 1]; var c = ringPos[i];
                var n = Vector3.Cross(b - a, c - a);
                float len = n.Length();
                if (len < 1e-6f) continue;
                n /= len;
                tris.Add(new Tri {
                    Pos = new[] { a, b, c },
                    Uv = new[] { ringUv[0], ringUv[i - 1], ringUv[i] },
                    Normal = n,
                    CentroidZ = (a.Z + b.Z + c.Z) / 3f,
                    SurfaceDid = surfaceDid,
                });
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────
    //  Texture loading: RenderSurface → SKBitmap (RGBA8). Covers the
    //  formats used by retail AC. DXT formats are skipped (caller falls
    //  back to category color).
    // ────────────────────────────────────────────────────────────────────

    private static SKBitmap? TryLoadSurface(IDatReaderWriter dats, uint surfaceDid) {
        if (!SafeTryGet<RenderSurface>(dats, surfaceDid, out var rs)) return null;
        if (rs.SourceData == null || rs.SourceData.Length == 0) return null;
        try {
            return rs.Format switch {
                PixelFormat.PFID_CUSTOM_RAW_JPEG => SKBitmap.Decode(rs.SourceData),
                PixelFormat.PFID_R8G8B8 => DecodeBgr(rs),
                PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8 => DecodeRgb(rs),
                PixelFormat.PFID_A8R8G8B8 => DecodeBgra(rs),
                PixelFormat.PFID_A8 or PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA => DecodeGreyscale(rs),
                PixelFormat.PFID_R5G6B5 => Decode565(rs),
                PixelFormat.PFID_A4R4G4B4 => Decode4444(rs),
                PixelFormat.PFID_INDEX16 => DecodePaletted16(rs, dats),
                PixelFormat.PFID_P8 => DecodePaletted8(rs, dats),
                _ => null,
            };
        } catch {
            return null;
        }
    }

    private static SKBitmap MakeBitmap(int w, int h, byte[] rgba) {
        var info = new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        var bmp = new SKBitmap(info);
        System.Runtime.InteropServices.Marshal.Copy(rgba, 0, bmp.GetPixels(), rgba.Length);
        return bmp;
    }

    private static SKBitmap DecodeBgr(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 3 + 2];
            dst[i * 4 + 1] = src[i * 3 + 1];
            dst[i * 4 + 2] = src[i * 3 + 0];
            dst[i * 4 + 3] = 255;
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap DecodeRgb(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 3 + 0];
            dst[i * 4 + 1] = src[i * 3 + 1];
            dst[i * 4 + 2] = src[i * 3 + 2];
            dst[i * 4 + 3] = 255;
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap DecodeBgra(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            dst[i * 4 + 0] = src[i * 4 + 2];
            dst[i * 4 + 1] = src[i * 4 + 1];
            dst[i * 4 + 2] = src[i * 4 + 0];
            dst[i * 4 + 3] = src[i * 4 + 3];
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap DecodeGreyscale(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            byte g = src[i];
            dst[i * 4 + 0] = g; dst[i * 4 + 1] = g; dst[i * 4 + 2] = g; dst[i * 4 + 3] = 255;
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap Decode565(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            ushort val = BitConverter.ToUInt16(src, i * 2);
            dst[i * 4 + 0] = (byte)(((val >> 11) & 0x1F) << 3);
            dst[i * 4 + 1] = (byte)(((val >> 5) & 0x3F) << 2);
            dst[i * 4 + 2] = (byte)((val & 0x1F) << 3);
            dst[i * 4 + 3] = 255;
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap Decode4444(RenderSurface rs) {
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            ushort val = BitConverter.ToUInt16(src, i * 2);
            dst[i * 4 + 0] = (byte)(((val >> 8) & 0xF) * 17);
            dst[i * 4 + 1] = (byte)(((val >> 4) & 0xF) * 17);
            dst[i * 4 + 2] = (byte)((val & 0xF) * 17);
            dst[i * 4 + 3] = (byte)(((val >> 12) & 0xF) * 17);
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap? DecodePaletted8(RenderSurface rs, IDatReaderWriter dats) {
        if (!SafeTryGet<Palette>(dats, rs.DefaultPaletteId, out var palette)) return null;
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            int palIndex = src[i];
            if (palIndex >= palette.Colors.Count) palIndex = 0;
            var c = palette.Colors[palIndex];
            dst[i * 4 + 0] = c.Red; dst[i * 4 + 1] = c.Green; dst[i * 4 + 2] = c.Blue; dst[i * 4 + 3] = c.Alpha;
        }
        return MakeBitmap(w, h, dst);
    }

    private static SKBitmap? DecodePaletted16(RenderSurface rs, IDatReaderWriter dats) {
        if (!SafeTryGet<Palette>(dats, rs.DefaultPaletteId, out var palette)) return null;
        int w = rs.Width, h = rs.Height;
        var src = rs.SourceData; var dst = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++) {
            int palIndex = BitConverter.ToInt16(src, i * 2);
            if (palIndex < 0 || palIndex >= palette.Colors.Count) palIndex = 0;
            var c = palette.Colors[palIndex];
            dst[i * 4 + 0] = c.Red; dst[i * 4 + 1] = c.Green; dst[i * 4 + 2] = c.Blue; dst[i * 4 + 3] = c.Alpha;
        }
        return MakeBitmap(w, h, dst);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Atlas packing (skyline, sorted by descending height)
    // ────────────────────────────────────────────────────────────────────

    private sealed class SpriteEntry {
        public uint ModelId;
        public required SKBitmap Bitmap;
        public float WorldWidth;
        public float WorldHeight;
    }

    private struct AtlasRect { public int X, Y, W, H; }

    private static (SKBitmap Atlas, AtlasRect[] Layout) PackAtlas(List<SpriteEntry> entries) {
        if (entries.Count == 0) {
            return (new SKBitmap(new SKImageInfo(1, 1, SKColorType.Rgba8888, SKAlphaType.Premul)),
                Array.Empty<AtlasRect>());
        }

        // Order by area desc with index preserved so the manifest aligns with entries.
        var indexed = entries.Select((e, i) => (i, e)).ToList();
        indexed.Sort((a, b) =>
            (b.e.Bitmap.Width * b.e.Bitmap.Height).CompareTo(a.e.Bitmap.Width * a.e.Bitmap.Height));

        // Choose atlas width as the next power of two ≥ sqrt(totalArea)*1.1.
        long totalArea = 0;
        int maxSpriteW = 0;
        foreach (var (_, e) in indexed) {
            totalArea += e.Bitmap.Width * e.Bitmap.Height;
            if (e.Bitmap.Width > maxSpriteW) maxSpriteW = e.Bitmap.Width;
        }
        int atlasW = Math.Max(maxSpriteW, NextPow2((int)(Math.Sqrt(totalArea) * 1.1)));

        // Skyline packing.
        var skyline = new int[atlasW];
        var layout = new AtlasRect[entries.Count];
        int atlasH = 0;
        foreach (var (origIdx, e) in indexed) {
            int w = e.Bitmap.Width, h = e.Bitmap.Height;
            int bestX = 0, bestY = int.MaxValue;
            for (int x = 0; x + w <= atlasW; x++) {
                int y = 0;
                for (int k = 0; k < w; k++) if (skyline[x + k] > y) y = skyline[x + k];
                if (y < bestY) { bestY = y; bestX = x; }
            }
            for (int k = 0; k < w; k++) skyline[bestX + k] = bestY + h;
            if (bestY + h > atlasH) atlasH = bestY + h;
            layout[origIdx] = new AtlasRect { X = bestX, Y = bestY, W = w, H = h };
        }
        atlasH = Math.Max(1, atlasH);

        var atlas = new SKBitmap(new SKImageInfo(atlasW, atlasH, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(atlas)) {
            canvas.Clear(SKColors.Transparent);
            for (int i = 0; i < entries.Count; i++) {
                var e = entries[i];
                var rect = layout[i];
                canvas.DrawBitmap(e.Bitmap, new SKPoint(rect.X, rect.Y));
            }
        }
        return (atlas, layout);
    }

    private static int NextPow2(int v) {
        int n = 64;
        while (n < v) n <<= 1;
        return n;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Sun direction helper
    // ────────────────────────────────────────────────────────────────────

    private static Vector3 ComputeSunDirection(float azimuthDeg, float elevationDeg) {
        // Azimuth measured clockwise from north (+Y). 135° → south-east-ish.
        // Up vector (light direction TOWARDS the sun) lifted by elevation.
        float az = azimuthDeg * MathF.PI / 180f;
        float el = elevationDeg * MathF.PI / 180f;
        float horiz = MathF.Cos(el);
        return Vector3.Normalize(new Vector3(
            x: horiz * MathF.Sin(az),
            y: horiz * MathF.Cos(az),
            z: MathF.Sin(el)));
    }
}
