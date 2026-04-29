using System.Numerics;
using SkiaSharp;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Geometry;

namespace WorldBuilder.Terminal;

/// <summary>
/// Per-floor interior renderer. Consumes cell footprints (from
/// <see cref="CellFootprintExtractor"/>) and a <see cref="DungeonDocument"/>,
/// partitions cells into floors via <see cref="LandblockDescriber.ClusterByCellZ"/>,
/// and emits a square PNG showing wall polygons, portal classification,
/// and any cell-resident or loose static objects on that floor.
///
/// Reuses (does not parallel-implement) the describer's Z-band partition,
/// the renderer's sprite-atlas lookup, and the LB-doc's static-object list.
/// </summary>
internal static class DungeonRenderer {

    public sealed class Input {
        public required ushort LbKey;
        public int? FloorIndex;             // null = render every floor on one canvas
        public int Resolution = 1024;
        public required IReadOnlyList<CellFootprintExtractor.CellFootprint> CellFootprints;
        public required DungeonDocument Dungeon;
        public LandblockDocument? Lb;
        public SpriteAtlasLoader? SpriteAtlas;
        public Func<uint, OntologyEntry?>? Ontology;

        // When true, force the rendered canvas to span the full LB-local
        // 0..192 wu square so the output composites correctly into a
        // Leaflet overlay anchored at the LB's footprint. Why: callers that
        // ship the PNG into a tile pyramid must align with the LB extent;
        // freeform CLI inspection can leave this false to get tight zoom.
        public bool UseLbExtent = false;
    }

    public sealed class Output {
        public byte[] PngBytes = Array.Empty<byte>();
        public int FloorCount;              // total floors discovered
        public int FloorIndexRendered;      // -1 means "all"
        public float FloorZMin;
        public float FloorZMax;
        public int CellsRendered;
    }

    private static readonly SKColor BackgroundColor = new(0x12, 0x12, 0x14);
    private static readonly SKColor InteriorWallStroke = new(0x40, 0x44, 0x4A, 0xC0);
    private static readonly SKColor ExteriorWallStroke = new(0x10, 0x10, 0x12, 0xFF);
    private static readonly SKColor SyntheticOutline = new(0xC0, 0x60, 0x60, 0xC0);
    private static readonly SKColor SameFloorPortalGap = new(0x18, 0x18, 0x1A, 0xFF);
    private static readonly SKColor CrossFloorPortalMarker = new(0xE6, 0xB0, 0x4F, 0xFF);
    private static readonly SKColor ExteriorPortalMarker = new(0x4F, 0xC8, 0x6E, 0xFF);
    private static readonly SKColor LabelColor = new(0xE0, 0xE0, 0xE0, 0xF0);

    public static Output Render(Input input) {
        var output = new Output();
        var bands = LandblockDescriber.ClusterByCellZ(input.Dungeon.Cells.Select(c => c.Origin.Z));
        output.FloorCount = bands.Count;
        if (bands.Count == 0) return EmptyPng(input.Resolution, output);

        // Order bands top-down: highest Z first → floor 0 is the TOP of the
        // dungeon when `FloorIndex` is provided. Why: matches how players
        // think about buildings (1st floor = ground / closest to surface).
        var orderedBands = bands.OrderByDescending(b => b.Min).ToList();
        var floorByCell = AssignCellsToFloors(input.Dungeon.Cells, orderedBands);

        var fpByNum = IndexFootprints(input.CellFootprints);

        int floorMin, floorMax;
        if (input.FloorIndex is int fi) {
            if (fi < 0 || fi >= orderedBands.Count) return EmptyPng(input.Resolution, output);
            floorMin = floorMax = fi;
            output.FloorIndexRendered = fi;
            output.FloorZMin = orderedBands[fi].Min;
            output.FloorZMax = orderedBands[fi].Max;
        } else {
            floorMin = 0;
            floorMax = orderedBands.Count - 1;
            output.FloorIndexRendered = -1;
            output.FloorZMin = orderedBands.Min(b => b.Min);
            output.FloorZMax = orderedBands.Max(b => b.Max);
        }

        // Compute world XY bounds across the cells we'll draw.
        var renderedCells = new List<(DungeonCellData cell, CellFootprintExtractor.CellFootprint fp, int floorIndex)>();
        foreach (var c in input.Dungeon.Cells) {
            if (!floorByCell.TryGetValue(c.CellNumber, out int idx)) continue;
            if (idx < floorMin || idx > floorMax) continue;
            if (!fpByNum.TryGetValue(c.CellNumber, out var fp)) continue;
            renderedCells.Add((c, fp, idx));
        }
        if (renderedCells.Count == 0) return EmptyPng(input.Resolution, output);

        float originX, originY, worldExtent;
        if (input.UseLbExtent) {
            // Anchor to the LB's full 0..192 wu local extent. AC dungeon
            // cells are landblock-local in XY (per memory), so this stays
            // tight around the LB while letting Leaflet overlay the PNG
            // at the LB's bounded latLng without stretching.
            originX = 0f;
            originY = 0f;
            worldExtent = 192f;
        } else {
            float minX = float.MaxValue, maxX = float.MinValue;
            float minY = float.MaxValue, maxY = float.MinValue;
            foreach (var (_, fp, _) in renderedCells) {
                foreach (var p in fp.Polygon) {
                    if (p.X < minX) minX = p.X; if (p.X > maxX) maxX = p.X;
                    if (p.Y < minY) minY = p.Y; if (p.Y > maxY) maxY = p.Y;
                }
            }
            // Square the world extent + add a small margin so walls don't graze the edge.
            worldExtent = MathF.Max(maxX - minX, maxY - minY);
            if (worldExtent <= 1e-3f) return EmptyPng(input.Resolution, output);
            float margin = worldExtent * 0.04f;
            originX = (minX + maxX) * 0.5f - worldExtent * 0.5f - margin;
            originY = (minY + maxY) * 0.5f - worldExtent * 0.5f - margin;
            worldExtent += 2 * margin;
        }

        int res = Math.Max(64, input.Resolution);
        float pxPerUnit = res / worldExtent;

        var info = new SKImageInfo(res, res, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bitmap = new SKBitmap(info);
        using (var canvas = new SKCanvas(bitmap)) {
            // Why: when the floor PNG is composited as a Leaflet image overlay
            // anchored to the LB extent, the area outside the dungeon must let
            // the underlying terrain tile show through. Standalone (CLI) renders
            // keep the opaque dark background for clean inspection.
            canvas.Clear(input.UseLbExtent ? SKColors.Transparent : BackgroundColor);
            DrawCellFills(canvas, renderedCells, originX, originY, pxPerUnit, res, orderedBands.Count);
            DrawWallsAndPortals(canvas, renderedCells, floorByCell, originX, originY, pxPerUnit, res);
            DrawObjects(canvas, renderedCells, input, floorByCell, orderedBands, originX, originY, pxPerUnit, res);
            DrawLabel(canvas, output, orderedBands.Count);
        }
        using var img = SKImage.FromBitmap(bitmap);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        output.PngBytes = data.ToArray();
        output.CellsRendered = renderedCells.Count;
        return output;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Cell partition + footprint indexing
    // ────────────────────────────────────────────────────────────────────

    private static Dictionary<ushort, int> AssignCellsToFloors(
            IList<DungeonCellData> cells, IList<LandblockDescriber.ZBand> orderedBands) {
        var result = new Dictionary<ushort, int>(cells.Count);
        foreach (var c in cells) {
            for (int i = 0; i < orderedBands.Count; i++) {
                var b = orderedBands[i];
                // Why: ZBand bounds are inclusive of the cluster's min/max, but
                // float comparisons need a tolerance to keep boundary cells
                // landing on the right side of a band split.
                if (c.Origin.Z >= b.Min - 0.01f && c.Origin.Z <= b.Max + 0.01f) {
                    result[c.CellNumber] = i;
                    break;
                }
            }
        }
        return result;
    }

    private static Dictionary<ushort, CellFootprintExtractor.CellFootprint> IndexFootprints(
            IReadOnlyList<CellFootprintExtractor.CellFootprint> fps) {
        var result = new Dictionary<ushort, CellFootprintExtractor.CellFootprint>(fps.Count);
        foreach (var fp in fps) {
            ushort cellNum = (ushort)(fp.CellId & 0xFFFF);
            result[cellNum] = fp;
        }
        return result;
    }

    // ────────────────────────────────────────────────────────────────────
    //  Drawing
    // ────────────────────────────────────────────────────────────────────

    private static void DrawCellFills(SKCanvas canvas,
            List<(DungeonCellData cell, CellFootprintExtractor.CellFootprint fp, int floorIndex)> renderedCells,
            float originX, float originY, float pxPerUnit, int res, int floorCount) {
        using var fill = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Fill };
        foreach (var (cell, fp, floorIdx) in renderedCells) {
            fill.Color = CellFillColor(cell.CellNumber, floorIdx, floorCount, fp.Synthetic);
            using var path = PolygonPath(fp.Polygon, originX, originY, pxPerUnit, res);
            canvas.DrawPath(path, fill);
        }
    }

    private static void DrawWallsAndPortals(SKCanvas canvas,
            List<(DungeonCellData cell, CellFootprintExtractor.CellFootprint fp, int floorIndex)> renderedCells,
            Dictionary<ushort, int> floorByCell,
            float originX, float originY, float pxPerUnit, int res) {

        // Build a quick set of cell numbers we're rendering, so portals to
        // off-floor cells render as cross-floor markers (not interior gaps).
        var onFloor = new HashSet<ushort>();
        foreach (var (cell, _, _) in renderedCells) onFloor.Add(cell.CellNumber);

        using var interiorStroke = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = MathF.Max(1.0f, res / 768f),
            Color = InteriorWallStroke,
        };
        using var exteriorStroke = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = MathF.Max(1.6f, res / 480f),
            Color = ExteriorWallStroke,
            StrokeCap = SKStrokeCap.Round,
        };
        using var syntheticStroke = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = MathF.Max(1.0f, res / 768f),
            Color = SyntheticOutline,
            PathEffect = SKPathEffect.CreateDash(new[] { 4f, 3f }, 0f),
        };

        // First pass: stroke the polygon walls. Synthetic-fallback cells get
        // a dashed red outline to flag that the geometry is approximate.
        foreach (var (_, fp, _) in renderedCells) {
            using var path = PolygonPath(fp.Polygon, originX, originY, pxPerUnit, res);
            canvas.DrawPath(path, fp.Synthetic ? syntheticStroke : exteriorStroke);
        }

        // Second pass: portal markers. Same-floor interior portals stamp a
        // dark "gap" over the wall span; cross-floor portals stamp an amber
        // marker; exterior portals stamp green. Drawing on top is enough —
        // it doesn't matter if a wall edge underlies the portal span.
        using var gapPaint = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = exteriorStroke.StrokeWidth + 1.5f,
            StrokeCap = SKStrokeCap.Butt,
            Color = SameFloorPortalGap,
        };
        using var crossFloorPaint = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = MathF.Max(2.5f, res / 320f),
            StrokeCap = SKStrokeCap.Round,
            Color = CrossFloorPortalMarker,
        };
        using var exteriorPaint = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = MathF.Max(2.5f, res / 320f),
            StrokeCap = SKStrokeCap.Round,
            Color = ExteriorPortalMarker,
        };

        foreach (var (cell, fp, _) in renderedCells) {
            foreach (var portal in fp.Portals) {
                var a = WorldToPx(portal.A, originX, originY, pxPerUnit, res);
                var b = WorldToPx(portal.B, originX, originY, pxPerUnit, res);
                bool toExterior = portal.ToCellId == 0 || portal.ToCellId == 0xFFFF;
                bool sameFloor = !toExterior && onFloor.Contains(portal.ToCellId);
                bool crossFloor = !toExterior && !sameFloor &&
                    floorByCell.ContainsKey(portal.ToCellId);
                if (sameFloor) {
                    canvas.DrawLine(a, b, gapPaint);
                } else if (crossFloor) {
                    canvas.DrawLine(a, b, crossFloorPaint);
                } else {
                    // Exterior or unresolved → entry/exit marker.
                    canvas.DrawLine(a, b, exteriorPaint);
                }
            }
        }

        // Final pass: thin interior strokes on top of everything to suggest
        // cell boundaries. (Stylized; not strictly necessary but reads well.)
        foreach (var (_, fp, _) in renderedCells) {
            if (fp.Synthetic) continue;
            using var path = PolygonPath(fp.Polygon, originX, originY, pxPerUnit, res);
            canvas.DrawPath(path, interiorStroke);
        }
    }

    private static void DrawObjects(SKCanvas canvas,
            List<(DungeonCellData cell, CellFootprintExtractor.CellFootprint fp, int floorIndex)> renderedCells,
            Input input, Dictionary<ushort, int> floorByCell,
            IList<LandblockDescriber.ZBand> orderedBands,
            float originX, float originY, float pxPerUnit, int res) {

        // 1. Cell-resident static objects (DungeonStabData on each cell).
        foreach (var (cell, _, _) in renderedCells) {
            foreach (var stab in cell.StaticObjects) {
                DrawObjectAt(canvas, stab.Id, stab.Origin.X, stab.Origin.Y, stab.Orientation,
                    input, originX, originY, pxPerUnit, res);
            }
        }

        // 2. LB-doc loose objects whose Z falls in any rendered floor's band
        // AND whose XY falls within at least one rendered cell footprint.
        if (input.Lb == null) return;
        var lbX = (input.LbKey >> 8) & 0xFF;
        var lbY = input.LbKey & 0xFF;
        float lbOriginX = lbX * 192f, lbOriginY = lbY * 192f;

        var renderedBandIndices = new HashSet<int>();
        foreach (var (_, _, idx) in renderedCells) renderedBandIndices.Add(idx);

        foreach (var obj in input.Lb.GetStaticObjects()) {
            if (obj.IsParticleEmitter) continue;
            // World → LB-local
            float lx = obj.Origin.X - lbOriginX;
            float ly = obj.Origin.Y - lbOriginY;
            float lz = obj.Origin.Z;

            int? matchingBand = null;
            for (int i = 0; i < orderedBands.Count; i++) {
                var b = orderedBands[i];
                if (lz >= b.Min - 1.0f && lz <= b.Max + 4.0f) { matchingBand = i; break; }
            }
            if (matchingBand == null || !renderedBandIndices.Contains(matchingBand.Value)) continue;

            bool insideAnyCell = false;
            foreach (var (_, fp, idx) in renderedCells) {
                if (idx != matchingBand.Value) continue;
                if (FootprintGeometry.PointInPolygon(new Vector2(lx, ly), fp.Polygon)) {
                    insideAnyCell = true; break;
                }
            }
            if (!insideAnyCell) continue;

            DrawObjectAt(canvas, obj.Id, lx, ly, obj.Orientation,
                input, originX, originY, pxPerUnit, res);
        }
    }

    private static void DrawObjectAt(SKCanvas canvas, uint modelId, float wx, float wy,
            Quaternion orientation, Input input,
            float originX, float originY, float pxPerUnit, int res) {
        var px = WorldToPx(new Vector2(wx, wy), originX, originY, pxPerUnit, res);

        if (input.SpriteAtlas != null && input.SpriteAtlas.TryLookup(modelId, out var rect)) {
            float wPx = rect.WorldWidth * pxPerUnit;
            float hPx = rect.WorldHeight * pxPerUnit;
            if (wPx < 4f || hPx < 4f) {
                DrawGlyphFallback(canvas, modelId, px, input.Ontology);
                return;
            }
            var dest = new SKRect(px.X - wPx * 0.5f, px.Y - hPx * 0.5f, px.X + wPx * 0.5f, px.Y + hPx * 0.5f);
            var src = new SKRect(rect.X, rect.Y, rect.X + rect.W, rect.Y + rect.H);
            // Why: rotate the sprite about its own center so doors / signs that
            // store an orientation in the LB doc don't all face the same way
            // in the floor plan.
            float yawDeg = QuaternionYawDegrees(orientation);
            canvas.Save();
            canvas.RotateDegrees(-yawDeg, px.X, px.Y);
            canvas.DrawBitmap(input.SpriteAtlas.Atlas, src, dest);
            canvas.Restore();
            return;
        }
        DrawGlyphFallback(canvas, modelId, px, input.Ontology);
    }

    private static void DrawGlyphFallback(SKCanvas canvas, uint modelId, SKPoint px,
            Func<uint, OntologyEntry?>? ontology) {
        var entry = ontology?.Invoke(modelId);
        var color = ResolveCategoryFill(entry?.Category ?? "Unknown");
        using var paint = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Fill, Color = color,
        };
        canvas.DrawCircle(px, 3.5f, paint);
        using var ring = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 0.8f,
            Color = new SKColor(0x10, 0x10, 0x10, 0xC0),
        };
        canvas.DrawCircle(px, 3.5f, ring);
    }

    private static SKColor ResolveCategoryFill(string category) => category switch {
        "Structure" => new SKColor(0x6E, 0x57, 0x40),
        var s when s.StartsWith("Furniture") => new SKColor(0x8B, 0x6F, 0x4A),
        var s when s.StartsWith("Scenery_Water") => new SKColor(0x3E, 0x6A, 0x9F),
        var s when s.StartsWith("Scenery") => new SKColor(0x2D, 0x5A, 0x2D),
        var s when s.StartsWith("NPC") => new SKColor(0xE2, 0xC8, 0x4F),
        "Creature" => new SKColor(0xC0, 0x39, 0x2B),
        "Prop" => new SKColor(0xC2, 0xA3, 0x68),
        var s when s.StartsWith("Interactive") => new SKColor(0x6E, 0xC8, 0xE0),
        var s when s.StartsWith("Sign") => new SKColor(0xE0, 0x9A, 0x3F),
        _ => new SKColor(0x90, 0x90, 0x90),
    };

    private static void DrawLabel(SKCanvas canvas, Output output, int totalFloors) {
        string text;
        if (output.FloorIndexRendered < 0) {
            text = $"All floors ({totalFloors}) — Z {output.FloorZMin:F1} … {output.FloorZMax:F1}";
        } else {
            text = $"Floor {output.FloorIndexRendered + 1}/{totalFloors} — Z {output.FloorZMin:F1} … {output.FloorZMax:F1}";
        }
        using var paint = new SKPaint {
            IsAntialias = true, Color = LabelColor, TextSize = 14f,
            Typeface = SKTypeface.Default,
        };
        using var bg = new SKPaint {
            IsAntialias = true, Style = SKPaintStyle.Fill,
            Color = new SKColor(0, 0, 0, 0xA0),
        };
        var bounds = new SKRect();
        paint.MeasureText(text, ref bounds);
        canvas.DrawRect(8, 8, bounds.Width + 12, bounds.Height + 8, bg);
        canvas.DrawText(text, 14, 8 + bounds.Height + 2, paint);
    }

    // ────────────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────────────

    private static SKColor CellFillColor(ushort cellNum, int floorIdx, int floorCount, bool synthetic) {
        // Why: each floor gets its own hue family so the all-floors view reads
        // as layered levels; per-cell saturation jitter (deterministic on
        // cellNum) makes adjacent cells visually distinguishable.
        if (synthetic) return new SKColor(0x60, 0x40, 0x40, 0x90);
        float floorHue = floorCount > 0 ? (floorIdx / (float)floorCount) * 360f : 30f;
        // Phase the hue so floor 0 starts at orange (~30°) — feels like ground level.
        floorHue = (floorHue + 30f) % 360f;
        uint h = cellNum * 2654435761u;
        float satJitter = 32f + (h % 18u);
        float valJitter = 60f + ((h >> 8) % 14u);
        return SKColor.FromHsv(floorHue, satJitter, valJitter, 0xE0);
    }

    private static SKPath PolygonPath(IReadOnlyList<Vector2> poly, float originX, float originY, float pxPerUnit, int res) {
        var path = new SKPath { FillType = SKPathFillType.Winding };
        if (poly.Count == 0) return path;
        path.MoveTo(WorldToPx(poly[0], originX, originY, pxPerUnit, res));
        for (int i = 1; i < poly.Count; i++) {
            path.LineTo(WorldToPx(poly[i], originX, originY, pxPerUnit, res));
        }
        path.Close();
        return path;
    }

    private static SKPoint WorldToPx(Vector2 p, float originX, float originY, float pxPerUnit, int res) {
        // Why: world +Y is north (up); canvas +Y is down. We translate the
        // world origin to the canvas origin and flip Y around the canvas
        // height so north reads as up in the rendered image.
        float xPx = (p.X - originX) * pxPerUnit;
        float yPx = res - (p.Y - originY) * pxPerUnit;
        return new SKPoint(xPx, yPx);
    }

    private static float QuaternionYawDegrees(Quaternion q) {
        // Yaw about +Z. AC's quaternion is (W, X, Y, Z) with Z up.
        float siny_cosp = 2f * (q.W * q.Z + q.X * q.Y);
        float cosy_cosp = 1f - 2f * (q.Y * q.Y + q.Z * q.Z);
        return MathF.Atan2(siny_cosp, cosy_cosp) * 180f / MathF.PI;
    }

    private static Output EmptyPng(int resolution, Output output) {
        int res = Math.Max(64, resolution);
        var info = new SKImageInfo(res, res, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bmp = new SKBitmap(info);
        using (var canvas = new SKCanvas(bmp)) canvas.Clear(BackgroundColor);
        using var img = SKImage.FromBitmap(bmp);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        output.PngBytes = data.ToArray();
        return output;
    }
}
