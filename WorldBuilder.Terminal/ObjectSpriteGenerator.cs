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
            IDatReaderWriter dats, Func<uint, OntologyEntry?> ontology,
            int throttleMs = 0) {
        // Two-pass streaming flow.
        //
        // Pass 1 — render: triangulate, rasterize the per-model PNG, write
        // it to disk under <spritesDir>/<id>.png, record the metadata in a
        // small struct, and dispose the SKBitmap immediately. We never hold
        // more than the current sprite + the next sprite's working set in
        // memory at once. This is what enables a 256-px regen of ~5 000
        // setups on an 8 GB box — the prior implementation kept every
        // SKBitmap live until the atlas pack and OOM'd at ~7 GB RSS.
        //
        // Pass 2 — pack: compute the skyline layout from the recorded
        // (W, H) sizes alone (no bitmaps), allocate the atlas SKBitmap,
        // then stream each sprite back from disk one at a time, blit it,
        // and dispose. Peak memory in this pass is the atlas canvas plus
        // one decoded sprite — bounded by a fixed constant (the largest
        // single sprite) regardless of the catalog size.
        SurfaceDiag.Reset();
        Directory.CreateDirectory(spritesDir);
        var sprites = new List<SpriteMeta>(modelIds.Count);

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
                int w, h;
                try {
                    using var data = rendered.Bitmap.Encode(SKEncodedImageFormat.Png, 100);
                    File.WriteAllBytes(Path.Combine(spritesDir, $"0x{id:X8}.png"), data.ToArray());
                    w = rendered.Bitmap.Width;
                    h = rendered.Bitmap.Height;
                } finally {
                    rendered.Bitmap.Dispose();
                }
                sprites.Add(new SpriteMeta(id, w, h, rendered.WorldWidth, rendered.WorldHeight));
            } catch (Exception ex) {
                threwException++;
                if (firstError == null) {
                    var stack = ex.StackTrace?.Split('\n').FirstOrDefault()?.Trim() ?? "";
                    firstError = $"0x{id:X8}: {ex.GetType().Name}: {ex.Message} @ {stack}";
                }
            }
            // Yield to a concurrent ML run between sprites.
            if (throttleMs > 0) System.Threading.Thread.Sleep(throttleMs);
        }
        if (sprites.Count == 0 || nullEmptyTris + nullDegenerate + nullNoVisible + threwException > 0) {
            Console.Error.WriteLine($"[Sprites] rendered={sprites.Count} " +
                $"noTris={nullEmptyTris} degenerate={nullDegenerate} " +
                $"noVisibleFace={nullNoVisible} threw={threwException}" +
                (firstError != null ? $" firstError={firstError}" : ""));
        }
        Console.Error.Write(SurfaceDiag.Report());

        var (aw, ah, layout) = PackAtlasStreaming(sprites, spritesDir, atlasPath);
        using (var sw = new StreamWriter(manifestPath, append: false)) {
            for (int i = 0; i < sprites.Count; i++) {
                var m = sprites[i];
                var rect = layout[i];
                sw.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {
                    modelId = $"0x{m.ModelId:X8}",
                    x = rect.X, y = rect.Y, w = rect.W, h = rect.H,
                    worldBounds = new[] {
                        Math.Round(m.WorldWidth, 4), Math.Round(m.WorldHeight, 4),
                    },
                }));
            }
        }
        return (sprites.Count, modelIds.Count - sprites.Count, aw, ah);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Per-model render
    // ────────────────────────────────────────────────────────────────────

    private enum NullReason { NoTriangles, Degenerate, NoVisible }

    private static (SpriteEntry? Entry, NullReason Reason) RenderOneWithReason(
            uint modelId, int spritePx, IDatReaderWriter dats, Func<uint, OntologyEntry?> ontology) {
        var triangles = TriangulateModel(modelId, dats);
        if (triangles.Count == 0) return (null, NullReason.NoTriangles);

        // World XYZ bounds across all triangles. We need Z to detect models
        // that are mostly vertical (doors, signs, fences) where the
        // top-down projection of every face produces a smear of the front
        // face filling the sprite. Compute Z extent alongside XY for the
        // dominance check below.
        float minX = float.MaxValue, maxX = float.MinValue;
        float minY = float.MaxValue, maxY = float.MinValue;
        float minZ = float.MaxValue, maxZ = float.MinValue;
        foreach (var tri in triangles) {
            for (int v = 0; v < 3; v++) {
                var p = tri.Pos[v];
                if (p.X < minX) minX = p.X;
                if (p.X > maxX) maxX = p.X;
                if (p.Y < minY) minY = p.Y;
                if (p.Y > maxY) maxY = p.Y;
                if (p.Z < minZ) minZ = p.Z;
                if (p.Z > maxZ) maxZ = p.Z;
            }
        }
        float worldW = maxX - minX, worldH = maxY - minY;
        float worldZ = maxZ - minZ;

        // Billboard fallback. Models like portal swirls, signs, banners,
        // tapestries are stored as a single upright polygon with zero depth
        // along one axis (e.g. portal setup 0x020001B3 is a 2.82m × 0m × 2.82m
        // single-poly quad). The standard top-down projection produces an
        // empty bitmap because there's no XY area to fill. Without this
        // fallback, all 1,991 portal weenies in retail render as 4px glyphs.
        //
        // Approach (per project decision: "people have to be able to see it"):
        // when worldW or worldH is degenerate but the OTHER XY axis + Z give
        // a real billboard size, render the polygon's surface texture inside
        // a circular disk sized to the billboard's largest dimension. The
        // disk approximates "what would a top-down projection of this swirl
        // look like" — geometrically it's a vertical billboard, but the
        // top-down map needs a visible footprint at the placement coord.
        bool xDegenerate = worldW <= 1e-3f;
        bool yDegenerate = worldH <= 1e-3f;
        if (xDegenerate && yDegenerate) return (null, NullReason.Degenerate);
        if (xDegenerate || yDegenerate) {
            float discDiameter = MathF.Max(MathF.Max(worldW, worldH), worldZ);
            if (discDiameter < 0.05f) return (null, NullReason.Degenerate);
            var discBmp = RenderBillboardAsDisc(triangles, discDiameter, spritePx, dats, ontology(modelId));
            if (discBmp == null) return (null, NullReason.NoVisible);
            return (new SpriteEntry {
                ModelId = modelId, Bitmap = discBmp,
                WorldWidth = discDiameter, WorldHeight = discDiameter
            }, NullReason.NoTriangles); // reason unused on success
        }

        // Bbox shape classification. The legacy code skipped any model whose
        // smallest dim was ≤5% of its largest — kicking doors / fences /
        // signs / banners out of the atlas entirely, where they fell back
        // to 4px glyph dispatch (the "small dark circles" and tiny strip
        // clusters in the top-down render). We now keep them and route
        // through the top-facing-only filter so the top-down silhouette is
        // a thin strip, not a front-face smear.
        float bboxMax = MathF.Max(worldZ, MathF.Max(worldW, worldH));
        float bboxMin = MathF.Min(worldZ, MathF.Min(worldW, worldH));
        bool thinObject = bboxMax > 1e-3f && bboxMin < 0.05f * bboxMax;

        float pxPerUnit = spritePx / Math.Max(worldW, worldH);
        int W = Math.Max(1, (int)MathF.Ceiling(worldW * pxPerUnit));
        int H = Math.Max(1, (int)MathF.Ceiling(worldH * pxPerUnit));

        // Pick the visible triangle set. Three regimes:
        //
        // 1. **Top-faces only** (door / signpost / banner / tower / stair /
        //    fence / thin tapestry): either Z extent dominates the largest
        //    XY extent (towers, stairs) or the bbox is thin in *any* axis
        //    (doors, fences, signs). Drawing every face with no back-face
        //    culling renders the front face on top of every pixel — the
        //    sprite becomes "wood grain filling the frame". Filter to
        //    triangles with any upward-facing normal component
        //    (Normal.Z > 0) so we render only the actual top-down
        //    silhouette. We use > 0 rather than > 0.5 because tower
        //    cone roofs and stair slopes have normals that point up at
        //    angles steeper than 60° from vertical — a tighter threshold
        //    leaves them out and the rendered tower has no visible roof.
        //    Pure side-walls (Normal.Z == 0) still get filtered out.
        //    If that leaves nothing (paper-thin decal, every face sideways),
        //    fall through to regime 3.
        //
        // 2. **Normal** (building / barrel / stone / tree): Z extent is
        //    not dominant and bbox isn't thin. Render all faces,
        //    painter-sort by centroid Z so the highest faces (roofs,
        //    foliage) draw last.
        //
        // 3. **Sign / awning fallback**: thin or Z-dominant model with no
        //    top-facing triangles. Drawing all faces is the only way to
        //    get any visible pixels at all.
        float xyMax = MathF.Max(worldW, worldH);
        bool zDominant = worldZ > 1.5f * xyMax;
        List<Tri> visible;
        if (zDominant || thinObject) {
            var tops = new List<Tri>();
            foreach (var t in triangles) if (t.Normal.Z > 0f) tops.Add(t);
            visible = tops.Count > 0 ? tops : new List<Tri>(triangles);
        } else {
            visible = new List<Tri>(triangles);
        }
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

    /// <summary>
    /// Render a billboard model (single upright polygon, zero depth on one
    /// horizontal axis — portals, signs, tapestries, banners) as a circular
    /// disc carrying the polygon's surface texture. The disc represents the
    /// billboard's "footprint" in top-down view: width = the billboard's
    /// largest dimension. Used as a fallback when the standard top-down
    /// projection produces an empty bitmap.
    ///
    /// Returns null only when neither the texture nor a fallback color can
    /// be produced — caller treats that as NullReason.NoVisible.
    /// </summary>
    private static SKBitmap? RenderBillboardAsDisc(List<Tri> triangles, float discDiameter,
            int spritePx, IDatReaderWriter dats, OntologyEntry? entry) {
        // Find the first triangle that carries a surface DID. Most billboards
        // are 1-poly = 2 triangles sharing one surface; pick whichever is set.
        uint surfaceDid = 0;
        foreach (var t in triangles) {
            if (t.SurfaceDid != 0) { surfaceDid = t.SurfaceDid; break; }
        }

        SKBitmap? texture = surfaceDid != 0 ? TryLoadSurface(dats, surfaceDid) : null;

        // Pick a base disc colour. When a texture loaded, sample its
        // average colour over opaque pixels — that's a faithful single-
        // colour summary of the swirl / sign / banner art, regardless of
        // whether the texture turned out to be a 8×8 mipmap thumbnail
        // (no detail) or a real high-res asset. When no texture loaded,
        // fall back to the ontology category palette.
        SKColor baseColour = texture != null && texture.Width > 0 && texture.Height > 0
            ? SampleAverageOpaqueColour(texture, ResolveFallbackFill(entry))
            : ResolveFallbackFill(entry);

        var info = new SKImageInfo(spritePx, spritePx, SKColorType.Rgba8888, SKAlphaType.Premul);
        var bmp = new SKBitmap(info);
        try {
            using var canvas = new SKCanvas(bmp);
            canvas.Clear(SKColors.Transparent);
            float cx = spritePx * 0.5f, cy = spritePx * 0.5f;
            float r = (spritePx * 0.5f) - 1f;

            // Always paint the category colour as the base disc — guarantees
            // a visible footprint even when the texture turns out to be
            // a tiny mipmap thumbnail (some surfaces only ship an 8×8
            // placeholder; AC's renderer would have generated the real
            // visual procedurally) or otherwise has near-zero useful detail.
            using (var basePaint = new SKPaint {
                Color = baseColour, IsAntialias = true, Style = SKPaintStyle.Fill,
            }) {
                canvas.DrawCircle(cx, cy, r, basePaint);
            }

            // Then overlay the texture on top via a bitmap-shader. A real
            // detail texture (≥32×32) covers the base colour entirely; a
            // tiny placeholder lets the base colour remain visible. Either
            // way the disc reads as the right type at a glance.
            if (texture != null && texture.Width > 0 && texture.Height > 0) {
                float scaleX = (2f * r) / texture.Width;
                float scaleY = (2f * r) / texture.Height;
                var matrix = SKMatrix.CreateScaleTranslation(scaleX, scaleY,
                    cx - r, cy - r);
                using var shader = SKShader.CreateBitmap(texture,
                    SKShaderTileMode.Clamp, SKShaderTileMode.Clamp, matrix);
                using var texPaint = new SKPaint {
                    Shader = shader, IsAntialias = true, Style = SKPaintStyle.Fill,
                };
                canvas.DrawCircle(cx, cy, r, texPaint);
            }

            // Subtle outline reads against busy terrain; matches the
            // glyph-style outline weight the rest of the renderer uses.
            using var outline = new SKPaint {
                Color = new SKColor(0x00, 0x00, 0x00, 0x80),
                IsAntialias = true,
                Style = SKPaintStyle.Stroke,
                StrokeWidth = MathF.Max(1f, spritePx / 64f),
            };
            canvas.DrawCircle(cx, cy, r, outline);
        } catch {
            bmp.Dispose();
            return null;
        } finally {
            texture?.Dispose();
        }
        return bmp;
    }

    /// <summary>
    /// Average colour of the opaque (alpha &gt; 32) pixels in <paramref name="bmp"/>.
    /// Used by the billboard disc renderer to derive a single representative
    /// colour from a texture — works whether the texture is an 8×8 mipmap
    /// thumbnail (no useful pattern) or a full-detail asset. Returns
    /// <paramref name="ifNoOpaque"/> when no opaque pixel exists.
    /// </summary>
    private static SKColor SampleAverageOpaqueColour(SKBitmap bmp, SKColor ifNoOpaque) {
        long rs = 0, gs = 0, bs = 0, n = 0;
        // Iterate at most ~256 sample points to keep this O(1) for huge
        // textures. Stride based on side length so coverage is uniform.
        int stride = Math.Max(1, Math.Min(bmp.Width, bmp.Height) / 16);
        for (int y = 0; y < bmp.Height; y += stride) {
            for (int x = 0; x < bmp.Width; x += stride) {
                var c = bmp.GetPixel(x, y);
                if (c.Alpha <= 32) continue;
                rs += c.Red; gs += c.Green; bs += c.Blue; n++;
            }
        }
        if (n == 0) return ifNoOpaque;
        return new SKColor((byte)(rs / n), (byte)(gs / n), (byte)(bs / n));
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
        // RenderPreviewRenderer hillshade convention. Use abs(dot) so faces
        // whose normals point away from the sun (or downward) still get a
        // sensible shade — important now that we render every triangle.
        float dot = MathF.Abs(Vector3.Dot(tri.Normal, SunDirection));
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
        // WeenieType-aware overrides come first — the ontology's category
        // classifier sometimes labels billboard portal setups as "Creature"
        // (1-poly upright quad pattern), but the enrichment pass populates
        // weenieType from the first weenie that references the setup. For
        // portals + signs + housing-portals, that gives us a much better
        // colour than the misclassified category.
        switch (entry?.WeenieType) {
            case 7:  return new SKColor(0x6E, 0xC8, 0xE0);  // Portal — cyan
            case 60: return new SKColor(0xA0, 0x6E, 0xD4);  // HousePortal — purple
            case 36: return new SKColor(0xE0, 0x9A, 0x3F);  // Channel/sign — orange
        }
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

    // Diagnostic counters — dumped at end of Run() to identify why textures
    // fall through to flat fill. Atomic so multi-threaded callers stay safe.
    internal static class SurfaceDiag {
        public static long ok;
        public static long badKind_outer;       // surfaceDid kind != 0x08, 0x06
        public static long badRead_Surface;     // SafeTryGet<Surface> failed
        public static long badKind_texRef;      // Surface.OrigTextureId kind not 0x05/0x06
        public static long badRead_SurfaceTex;  // SafeTryGet<SurfaceTexture> failed
        public static long emptySurfaceTex;     // SurfaceTexture has no Textures[]
        public static long badRead_RenderSurf;  // SafeTryGet<RenderSurface> failed
        public static long emptySource;         // RenderSurface has no SourceData
        public static readonly System.Collections.Concurrent.ConcurrentDictionary<uint, long> badTexKinds = new();
        public static readonly System.Collections.Concurrent.ConcurrentDictionary<uint, long> badRenderSurfKinds = new();
        public static readonly System.Collections.Concurrent.ConcurrentDictionary<int, long> unsupportedFormats = new();
        public static long decoderThrew;

        public static void Reset() {
            ok = 0; badKind_outer = 0; badRead_Surface = 0; badKind_texRef = 0;
            badRead_SurfaceTex = 0; emptySurfaceTex = 0; badRead_RenderSurf = 0;
            emptySource = 0; decoderThrew = 0;
            badTexKinds.Clear(); badRenderSurfKinds.Clear(); unsupportedFormats.Clear();
        }
        public static string Report() {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"[SurfaceDiag] ok={ok}");
            sb.AppendLine($"  badKind_outer={badKind_outer} (surfaceDid kind not 0x08/0x06)");
            sb.AppendLine($"  badRead_Surface={badRead_Surface}");
            sb.AppendLine($"  badKind_texRef={badKind_texRef} (Surface.OrigTextureId kind not 0x05/0x06)");
            if (!badTexKinds.IsEmpty) {
                sb.AppendLine($"    breakdown by kind:");
                foreach (var kv in badTexKinds.OrderByDescending(k => k.Value))
                    sb.AppendLine($"      0x{kv.Key:X2}: {kv.Value}");
            }
            sb.AppendLine($"  badRead_SurfaceTex={badRead_SurfaceTex}");
            sb.AppendLine($"  emptySurfaceTex={emptySurfaceTex}");
            sb.AppendLine($"  badRead_RenderSurf={badRead_RenderSurf}");
            if (!badRenderSurfKinds.IsEmpty) {
                sb.AppendLine($"    breakdown by kind of failing DataId:");
                foreach (var kv in badRenderSurfKinds.OrderByDescending(k => k.Value))
                    sb.AppendLine($"      0x{kv.Key:X2}: {kv.Value}");
            }
            sb.AppendLine($"  emptySource={emptySource}");
            sb.AppendLine($"  decoderThrew={decoderThrew}");
            if (!unsupportedFormats.IsEmpty) {
                sb.AppendLine($"  unsupportedFormats:");
                foreach (var kv in unsupportedFormats.OrderByDescending(k => k.Value))
                    sb.AppendLine($"    PFID id={kv.Key}: {kv.Value}");
            }
            return sb.ToString();
        }
    }

    private static SKBitmap? TryLoadSurface(IDatReaderWriter dats, uint surfaceDid) {
        // Why: GfxObj.Surfaces[i] is almost always a Surface (0x08xxxxxx) —
        // the wrapper that holds material params and points at the texture.
        // Reading it as a RenderSurface (0x06) directly fails silently and
        // every textured building shows up as a flat fallback color. Walk the
        // real chain: Surface → OrigTextureId → SurfaceTexture → Textures[0]
        // → RenderSurface. Some surfaces shortcut to a RenderSurface (0x06)
        // and a few projects pre-resolve to one; handle both.
        uint renderSurfaceDid = surfaceDid;
        uint kind = surfaceDid >> 24;
        if (kind == 0x08) {
            if (!SafeTryGet<Surface>(dats, surfaceDid, out var surface)) {
                System.Threading.Interlocked.Increment(ref SurfaceDiag.badRead_Surface);
                return null;
            }
            uint texRef = surface.OrigTextureId.DataId;
            uint texKind = texRef >> 24;
            if (texKind == 0x05) {
                if (!SafeTryGet<SurfaceTexture>(dats, texRef, out var st)) {
                    System.Threading.Interlocked.Increment(ref SurfaceDiag.badRead_SurfaceTex);
                    return null;
                }
                if (st.Textures == null || st.Textures.Count == 0) {
                    System.Threading.Interlocked.Increment(ref SurfaceDiag.emptySurfaceTex);
                    return null;
                }
                // Why Textures.Last(): SurfaceTexture.Textures is a mipmap-style
                // array where Textures[0] is often a thumbnail/placeholder and
                // Textures[^1] is the main detail texture. Both ACViewer's
                // Mapper, the painter (LandSurfaceManager.LoadTextures), and
                // DatIconLoader.LoadSurfaceIcon use the last entry. Using [0]
                // here was the cause of ~75% of building roofs falling back to
                // flat color.
                renderSurfaceDid = st.Textures[st.Textures.Count - 1].DataId;
            } else if (texKind == 0x06) {
                renderSurfaceDid = texRef;
            } else {
                System.Threading.Interlocked.Increment(ref SurfaceDiag.badKind_texRef);
                SurfaceDiag.badTexKinds.AddOrUpdate(texKind, 1, (_, v) => v + 1);
                return null;
            }
        } else if (kind != 0x06) {
            System.Threading.Interlocked.Increment(ref SurfaceDiag.badKind_outer);
            return null;
        }
        if (!SafeTryGet<RenderSurface>(dats, renderSurfaceDid, out var rs)) {
            System.Threading.Interlocked.Increment(ref SurfaceDiag.badRead_RenderSurf);
            uint failedKind = renderSurfaceDid >> 24;
            SurfaceDiag.badRenderSurfKinds.AddOrUpdate(failedKind, 1, (_, v) => v + 1);
            return null;
        }
        if (rs.SourceData == null || rs.SourceData.Length == 0) {
            System.Threading.Interlocked.Increment(ref SurfaceDiag.emptySource);
            return null;
        }
        try {
            SKBitmap? result = rs.Format switch {
                PixelFormat.PFID_CUSTOM_RAW_JPEG => SKBitmap.Decode(rs.SourceData),
                PixelFormat.PFID_R8G8B8 => DecodeBgr(rs),
                PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8 => DecodeRgb(rs),
                PixelFormat.PFID_A8R8G8B8 => DecodeBgra(rs),
                PixelFormat.PFID_A8 or PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA => DecodeGreyscale(rs),
                PixelFormat.PFID_R5G6B5 => Decode565(rs),
                PixelFormat.PFID_A4R4G4B4 => Decode4444(rs),
                PixelFormat.PFID_INDEX16 => DecodePaletted16(rs, dats),
                PixelFormat.PFID_P8 => DecodePaletted8(rs, dats),
                PixelFormat.PFID_DXT1 => MakeBitmap(rs.Width, rs.Height, DecompressDxt1(rs.SourceData, rs.Width, rs.Height)),
                PixelFormat.PFID_DXT3 => MakeBitmap(rs.Width, rs.Height, DecompressDxt5(rs.SourceData, rs.Width, rs.Height, isDxt3: true)),
                PixelFormat.PFID_DXT5 => MakeBitmap(rs.Width, rs.Height, DecompressDxt5(rs.SourceData, rs.Width, rs.Height, isDxt3: false)),
                _ => null,
            };
            if (result != null) {
                System.Threading.Interlocked.Increment(ref SurfaceDiag.ok);
            } else {
                SurfaceDiag.unsupportedFormats.AddOrUpdate((int)rs.Format, 1, (_, v) => v + 1);
            }
            return result;
        } catch {
            System.Threading.Interlocked.Increment(ref SurfaceDiag.decoderThrew);
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
    //  DXT decoders. Ported from WorldBuilder/Lib/DatIconLoader.cs so this
    //  project doesn't take on a Chorizite/Avalonia dependency. AC building
    //  surfaces (and many other props) ship as DXT1/3/5; without these
    //  decoders TryLoadSurface returns null and the renderer falls back to
    //  category color — flat-shaded sprites for almost all buildings.
    // ────────────────────────────────────────────────────────────────────

    private static byte[] Color565ToRgba(ushort c) {
        int r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
        return new byte[] { (byte)(r * 255 / 31), (byte)(g * 255 / 63), (byte)(b * 255 / 31), 255 };
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
                uint lt = (uint)(data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24));
                offset += 8;
                var colors = new byte[4][];
                colors[0] = Color565ToRgba(c0);
                colors[1] = Color565ToRgba(c1);
                if (c0 > c1) {
                    colors[2] = new byte[] { (byte)((2 * colors[0][0] + colors[1][0] + 1) / 3), (byte)((2 * colors[0][1] + colors[1][1] + 1) / 3), (byte)((2 * colors[0][2] + colors[1][2] + 1) / 3), 255 };
                    colors[3] = new byte[] { (byte)((colors[0][0] + 2 * colors[1][0] + 1) / 3), (byte)((colors[0][1] + 2 * colors[1][1] + 1) / 3), (byte)((colors[0][2] + 2 * colors[1][2] + 1) / 3), 255 };
                } else {
                    colors[2] = new byte[] { (byte)((colors[0][0] + colors[1][0]) / 2), (byte)((colors[0][1] + colors[1][1]) / 2), (byte)((colors[0][2] + colors[1][2]) / 2), 255 };
                    colors[3] = new byte[] { 0, 0, 0, 0 };
                }
                for (int row = 0; row < 4; row++)
                    for (int col = 0; col < 4; col++) {
                        int px = bx * 4 + col, py = by * 4 + row;
                        if (px >= width || py >= height) continue;
                        int idx = (int)((lt >> (2 * (row * 4 + col))) & 0x03);
                        int di = (py * width + px) * 4;
                        rgba[di] = colors[idx][0]; rgba[di + 1] = colors[idx][1];
                        rgba[di + 2] = colors[idx][2]; rgba[di + 3] = colors[idx][3];
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
                        ushort ab = (ushort)(data[offset + i * 2] | (data[offset + i * 2 + 1] << 8));
                        for (int j = 0; j < 4; j++)
                            alphas[i * 4 + j] = (byte)(((ab >> (j * 4)) & 0xF) * 17);
                    }
                } else {
                    byte a0 = data[offset], a1 = data[offset + 1];
                    ulong ab = 0;
                    for (int i = 2; i < 8; i++) ab |= (ulong)data[offset + i] << ((i - 2) * 8);
                    for (int i = 0; i < 16; i++) {
                        int code = (int)((ab >> (3 * i)) & 0x07);
                        if (code == 0) alphas[i] = a0;
                        else if (code == 1) alphas[i] = a1;
                        else if (a0 > a1) alphas[i] = (byte)(((8 - code) * a0 + (code - 1) * a1) / 7);
                        else if (code == 6) alphas[i] = 0;
                        else if (code == 7) alphas[i] = 255;
                        else alphas[i] = (byte)(((6 - code) * a0 + (code - 1) * a1) / 5);
                    }
                }
                offset += 8;
                ushort c0 = (ushort)(data[offset] | (data[offset + 1] << 8));
                ushort c1 = (ushort)(data[offset + 2] | (data[offset + 3] << 8));
                uint lt = (uint)(data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24));
                offset += 8;
                var colors = new byte[4][];
                colors[0] = Color565ToRgba(c0);
                colors[1] = Color565ToRgba(c1);
                colors[2] = new byte[] { (byte)((2 * colors[0][0] + colors[1][0] + 1) / 3), (byte)((2 * colors[0][1] + colors[1][1] + 1) / 3), (byte)((2 * colors[0][2] + colors[1][2] + 1) / 3), 255 };
                colors[3] = new byte[] { (byte)((colors[0][0] + 2 * colors[1][0] + 1) / 3), (byte)((colors[0][1] + 2 * colors[1][1] + 1) / 3), (byte)((colors[0][2] + 2 * colors[1][2] + 1) / 3), 255 };
                for (int row = 0; row < 4; row++)
                    for (int col = 0; col < 4; col++) {
                        int px = bx * 4 + col, py = by * 4 + row;
                        if (px >= width || py >= height) continue;
                        int ci = (int)((lt >> (2 * (row * 4 + col))) & 0x03);
                        int di = (py * width + px) * 4;
                        rgba[di] = colors[ci][0]; rgba[di + 1] = colors[ci][1];
                        rgba[di + 2] = colors[ci][2]; rgba[di + 3] = alphas[row * 4 + col];
                    }
            }
        }
        return rgba;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Atlas packing (skyline, sorted by descending height)
    // ────────────────────────────────────────────────────────────────────

    // Per-sprite metadata held during the render pass. Replaces the old
    // SpriteEntry which kept the SKBitmap live; we now persist the bitmap
    // to disk as it's rendered and only carry the size + world bounds in
    // memory.
    private readonly record struct SpriteMeta(uint ModelId, int W, int H,
        float WorldWidth, float WorldHeight);

    // Kept for the SpriteEntry record returned by RenderOneWithReason —
    // a single sprite's working set, scoped to one iteration of the render
    // loop. Disposed immediately after the PNG is written to disk.
    private sealed class SpriteEntry {
        public uint ModelId;
        public required SKBitmap Bitmap;
        public float WorldWidth;
        public float WorldHeight;
    }

    private struct AtlasRect { public int X, Y, W, H; }

    /// <summary>
    /// Stream-pack the per-sprite PNGs in <paramref name="spritesDir"/> into
    /// a single atlas at <paramref name="atlasPath"/>. The render pass has
    /// already written each sprite as <c>0x{id:X8}.png</c> and recorded its
    /// (W, H, worldBounds) in <paramref name="sprites"/>. This method:
    ///
    ///   1. computes the skyline packing layout from the (W, H) sizes alone
    ///      — no bitmaps in memory yet;
    ///   2. allocates the atlas <see cref="SKBitmap"/> at the packed
    ///      dimensions;
    ///   3. iterates each sprite's manifest entry, decodes its PNG from
    ///      disk, blits it at the layout position, and disposes — peak
    ///      memory is the atlas + one sprite at a time;
    ///   4. encodes the atlas to PNG, writes it, returns dimensions.
    ///
    /// Peak memory is bounded by atlasArea*4 + maxSpriteArea*4, independent
    /// of the catalog size. The prior in-memory PackAtlas accumulated every
    /// sprite SKBitmap and OOM'd above ~5 000 entries on an 8 GB host.
    /// </summary>
    private static (int AtlasW, int AtlasH, AtlasRect[] Layout) PackAtlasStreaming(
            List<SpriteMeta> sprites, string spritesDir, string atlasPath) {
        if (sprites.Count == 0) {
            using var oneByOne = new SKBitmap(new SKImageInfo(1, 1, SKColorType.Rgba8888, SKAlphaType.Premul));
            using var data = oneByOne.Encode(SKEncodedImageFormat.Png, 100);
            File.WriteAllBytes(atlasPath, data.ToArray());
            return (1, 1, Array.Empty<AtlasRect>());
        }

        // Order by area desc; preserve the original index so the manifest
        // entries align with the sprite metadata list.
        var indexed = sprites.Select((m, i) => (i, m)).ToList();
        indexed.Sort((a, b) => (b.m.W * b.m.H).CompareTo(a.m.W * a.m.H));

        long totalArea = 0;
        int maxSpriteW = 0;
        foreach (var (_, m) in indexed) {
            totalArea += (long)m.W * m.H;
            if (m.W > maxSpriteW) maxSpriteW = m.W;
        }
        int atlasW = Math.Max(maxSpriteW, NextPow2((int)(Math.Sqrt(totalArea) * 1.1)));

        var skyline = new int[atlasW];
        var layout = new AtlasRect[sprites.Count];
        int atlasH = 0;
        foreach (var (origIdx, m) in indexed) {
            int w = m.W, h = m.H;
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

        // Blit pass — allocate atlas, decode each sprite from disk, blit,
        // dispose. The SKCanvas + atlas live for the whole pass; per-sprite
        // bitmaps are scoped to one iteration.
        using var atlas = new SKBitmap(new SKImageInfo(atlasW, atlasH, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(atlas)) {
            canvas.Clear(SKColors.Transparent);
            for (int i = 0; i < sprites.Count; i++) {
                var m = sprites[i];
                var rect = layout[i];
                var path = Path.Combine(spritesDir, $"0x{m.ModelId:X8}.png");
                using var sprite = SKBitmap.Decode(path);
                if (sprite == null) {
                    Console.Error.WriteLine($"[Sprites] Pack: failed to decode {path} (entry skipped from atlas)");
                    continue;
                }
                canvas.DrawBitmap(sprite, new SKPoint(rect.X, rect.Y));
            }
        }
        using (var data = atlas.Encode(SKEncodedImageFormat.Png, 100)) {
            File.WriteAllBytes(atlasPath, data.ToArray());
        }
        return (atlasW, atlasH, layout);
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
