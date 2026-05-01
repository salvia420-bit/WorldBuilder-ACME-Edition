using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DatReaderWriter.Enums;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;
using WorldBuilder.Shared.Lib.Texture;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  O1: RenderSurface texture import
    // ─────────────────────────────────────────────────────────────────

    public ImportRenderSurfaceResult ImportRenderSurface(string imagePath, uint renderSurfaceId, bool ui, string? name) {
        RequireProject();
        if (string.IsNullOrWhiteSpace(imagePath))
            throw new ArgumentException("imagePath is required.", nameof(imagePath));

        var project = _projectManager.CurrentProject!;
        var dats = project.DocumentManager.Dats;
        var resolvedName = string.IsNullOrWhiteSpace(name)
            ? Path.GetFileNameWithoutExtension(imagePath)
            : name!;

        if (ui) {
            var portalDoc = project.DocumentManager
                .GetOrCreateDocumentAsync<PortalDatDocument>(PortalDatDocument.DocumentId)
                .GetAwaiter().GetResult()
                ?? throw new InvalidOperationException("Could not load PortalDatDocument.");

            var ok = RenderSurfaceImporter.TryOverwriteUiRenderSurface(
                dats, portalDoc, imagePath, renderSurfaceId, out var error);
            return new ImportRenderSurfaceResult(ok, renderSurfaceId, resolvedName, Deferred: true,
                ui ? "ui-overwrite" : "store-import", error);
        }

        var ok2 = RenderSurfaceImporter.TryImportRenderSurfaceReplacement(
            dats, project.CustomTextures, imagePath, renderSurfaceId, resolvedName, out var error2);
        return new ImportRenderSurfaceResult(ok2, renderSurfaceId, resolvedName, Deferred: true,
            "store-import", error2);
    }

    // ─────────────────────────────────────────────────────────────────
    //  O2: Heightmap import (image → terrain height + type changes)
    // ─────────────────────────────────────────────────────────────────

    public ImportHeightmapResult ImportHeightmap(string imagePath,
        int startLbX, int startLbY, int lbCountX, int lbCountY, bool apply) {
        RequireProject();

        if (string.IsNullOrWhiteSpace(imagePath))
            throw new ArgumentException("imagePath is required.", nameof(imagePath));
        if (!File.Exists(imagePath))
            throw new FileNotFoundException($"Image not found: {imagePath}", imagePath);
        if (lbCountX <= 0 || lbCountY <= 0)
            throw new ArgumentException("lbCountX and lbCountY must be positive.");

        var doc = GetTerrainDoc();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        var (targetW, targetH) = HeightmapImportService.GetTargetDimensions(lbCountX, lbCountY);
        var grid = HeightmapImportService.LoadAndResampleRgb(imagePath, targetW, targetH);
        var avgColors = TerrainAverageColorBuilder.Build(dats);

        var changes = HeightmapImportService.BuildChanges(
            grid, startLbX, startLbY, lbCountX, lbCountY,
            doc.GetLandblockInternal, avgColors);

        var perLb = changes
            .OrderBy(kv => kv.Key)
            .Select(kv => new ImportHeightmapPerLb(
                $"0x{kv.Key:X4}", kv.Value.Count))
            .ToList();
        int totalVerts = changes.Values.Sum(v => v.Count);

        if (!apply) {
            return new ImportHeightmapResult(
                Applied: false,
                ImagePath: imagePath,
                StartLbX: startLbX, StartLbY: startLbY,
                LbCountX: lbCountX, LbCountY: lbCountY,
                LandblocksConsidered: lbCountX * lbCountY,
                LandblocksChanged: changes.Count,
                VerticesChanged: totalVerts,
                PerLandblock: perLb,
                ModifiedLandblocks: new HashSet<ushort>());
        }

        // Apply via TerrainDocument.ApplyBulkImport (same path HeightImportCommand uses).
        var allChanges = new Dictionary<ushort, Dictionary<byte, uint>>();
        foreach (var (lbId, changeList) in changes) {
            var terrainData = doc.GetLandblockInternal(lbId);
            if (terrainData == null) continue;

            var lbChanges = new Dictionary<byte, uint>();
            foreach (var c in changeList) {
                var current = terrainData[c.VertexIndex];
                if (current.Height == c.NewHeight && current.Type == c.NewType) continue;
                var entry = current with { Height = c.NewHeight, Type = c.NewType };
                lbChanges[(byte)c.VertexIndex] = entry.ToUInt();
            }
            if (lbChanges.Count > 0) allChanges[lbId] = lbChanges;
        }

        if (allChanges.Count > 0) doc.ApplyBulkImport(allChanges);

        return new ImportHeightmapResult(
            Applied: true,
            ImagePath: imagePath,
            StartLbX: startLbX, StartLbY: startLbY,
            LbCountX: lbCountX, LbCountY: lbCountY,
            LandblocksConsidered: lbCountX * lbCountY,
            LandblocksChanged: changes.Count,
            VerticesChanged: totalVerts,
            PerLandblock: perLb,
            ModifiedLandblocks: new HashSet<ushort>(allChanges.Keys));
    }
}
